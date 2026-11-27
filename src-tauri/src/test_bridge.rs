//! SL-0 app tester (`docs/app-tester/DESIGN.md`): the dev-only test bridge.
//!
//! Compiled only with `--features test-bridge` in a debug build on macOS or
//! Windows (`lib.rs` gates the module and refuses the feature without
//! `debug_assertions`), and it opens nothing unless the app runs under the
//! test identifier, `com.mbadv.ply.test`, so it can never serve the installed
//! Plyloft or the owner's live state.
//!
//! macOS: one Unix socket in `$PLY_TEST_ROOT/run/` (0700 dir, 0600 socket and
//! token). Windows: TCP on `127.0.0.1` only (an ephemeral port written to
//! `run/bridge.port`), never another interface; the Mac reaches it through
//! `ply-test-winhelper` run in the VM by `prlctl exec` (docs/app-tester/
//! DESIGN.md, "Windows"). Either way: a per-launch token, newline-delimited
//! JSON, one client at a time. `app.*` methods are answered
//! here, read-only except `app.quit` (the normal `ExitRequested` path);
//! `account.devLoadEntitlement` loads a dev-key plan into this test profile;
//! `ui.*` methods go to the JS agent in the webview (`src/testBridge/`) through
//! `eval`, and come back as a `test-bridge://reply` event.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};

pub const TEST_IDENTIFIER: &str = "com.mbadv.ply.test";
/// The second person of a two-member walk: the same build, its own profile,
/// page storage and keychain service (`scripts/app-tester/make-member-app.sh`).
pub const MEMBER_IDENTIFIER: &str = "com.mbadv.ply.test2";
const MEMBER_TITLE: &str = "Plyloft Test Member";
/// `member` starts this build as the second person.
const INSTANCE_VAR: &str = "PLY_TEST_INSTANCE";
const REPLY_EVENT: &str = "test-bridge://reply";
const READY_EVENT: &str = "test-bridge://ready";
#[cfg(unix)]
const SOCKET_NAME: &str = "bridge.sock";
/// Windows: the loopback port the bridge listens on.
#[cfg(windows)]
const PORT_NAME: &str = "bridge.port";
const TOKEN_NAME: &str = "bridge.token";
/// Added to a `ui.*` request's own `timeout_ms` before Rust gives up on the
/// page answering.
const UI_GRACE: Duration = Duration::from_secs(5);
const UI_DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// One client at a time: a client that sends nothing for this long is
/// dropped, so a vanished one (a killed MCP, a dead relay) cannot hold the
/// bridge. The MCP and the VM relay reconnect on their next call.
const CLIENT_IDLE: Duration = Duration::from_secs(15 * 60);
const LOG_TAIL_DEFAULT: usize = 200;
const LOG_TAIL_MAX: usize = 2_000;
/// Executables whose presence under the app is a real agent tile (or run);
/// compared without a `.exe` suffix.
const AGENT_EXECUTABLES: &[&str] = &["claude", "codex"];

struct Bridge {
    run_dir: PathBuf,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next_id: Mutex<u64>,
    js_ready: Mutex<bool>,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// The runtime root: `$PLY_TEST_ROOT`, else `app-tester/` in the test
/// profile (`~/Library/Application Support/com.mbadv.ply.test/`). Kept on the
/// profile's own disk on purpose: a first access to an external volume makes
/// macOS ask the app for permission, and nothing may wait on that prompt.
pub fn test_root(config_dir: &Path) -> PathBuf {
    match std::env::var_os("PLY_TEST_ROOT").filter(|v| !v.is_empty()) {
        Some(root) => PathBuf::from(root),
        None => config_dir.join("app-tester"),
    }
}

/// Why the bridge must not open under this identifier, if it must not.
pub fn refusal_for_identifier(identifier: &str) -> Option<String> {
    (identifier != TEST_IDENTIFIER && identifier != MEMBER_IDENTIFIER).then(|| {
        format!(
            "test bridge refused: identifier is {identifier:?}, not {TEST_IDENTIFIER:?} \
             or {MEMBER_IDENTIFIER:?} (build with src-tauri/tauri.test.conf.json)"
        )
    })
}

fn names_member(value: Option<&str>) -> bool {
    value == Some("member")
}

/// Whether this process is the second person of a two-member walk.
pub fn is_member_instance() -> bool {
    names_member(std::env::var(INSTANCE_VAR).ok().as_deref())
}

/// Moves everything Tauri resolves from the identifier (profile, logs, the
/// single-instance lock) to the member's, before the app is built. Only a
/// build already under the test identifier can move: the installed app has
/// no test bridge at all, and a dev build under the real identifier stays
/// where it is.
pub fn apply_instance<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    if !is_member_instance() || context.config().identifier != TEST_IDENTIFIER {
        return;
    }
    let config = context.config_mut();
    config.identifier = MEMBER_IDENTIFIER.to_string();
    for window in &mut config.app.windows {
        window.title = MEMBER_TITLE.to_string();
    }
}

/// Called once from `setup`. Never fails the app: a bridge that cannot open
/// logs why and the app runs without it.
pub fn start(app: &AppHandle) {
    let identifier = app.config().identifier.clone();
    if let Some(refusal) = refusal_for_identifier(&identifier) {
        log::error!("{refusal}");
        return;
    }
    let config_dir = match app.path().app_config_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::error!("test bridge: no config dir: {error}");
            return;
        }
    };
    let run_dir = test_root(&config_dir).join("run");
    BRIDGE.get_or_init(|| Bridge {
        run_dir: run_dir.clone(),
        pending: Mutex::new(HashMap::new()),
        next_id: Mutex::new(0),
        js_ready: Mutex::new(false),
    });

    app.listen_any(REPLY_EVENT, |event| {
        let Ok(reply) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let Some(id) = reply.get("id").and_then(Value::as_u64) else {
            return;
        };
        if let Some(bridge) = BRIDGE.get() {
            if let Some(sender) = bridge.pending.lock().remove(&id) {
                let _ = sender.send(reply);
            }
        }
    });
    app.listen_any(READY_EVENT, |_| {
        if let Some(bridge) = BRIDGE.get() {
            *bridge.js_ready.lock() = true;
        }
    });

    // 1.176.3: the Builder screen capture's file-drop watcher (dev-only, this
    // test profile only; `builder_screens_capture.rs`).
    crate::builder_screens_capture::start_watch(app);

    // Everything that touches the disk runs off the main thread: setup must
    // never wait on the file system.
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("test-bridge".into()).spawn(move || {
        let listener = match transport::open(&run_dir) {
            Ok(listener) => listener,
            Err(error) => return log::error!("test bridge: {error}"),
        };
        let token = new_token();
        if let Err(error) = write_private(&run_dir.join(TOKEN_NAME), &token) {
            return log::error!("test bridge: write token: {error}");
        }
        // Windows: the port last, so a client that finds it finds the token.
        if let Err(error) = transport::publish(&run_dir, &listener) {
            return log::error!("test bridge: {error}");
        }
        log::info!("test bridge listening in {}", run_dir.display());
        transport::serve(listener, &token, &handle);
    });
    if let Err(error) = spawned {
        log::error!("test bridge: spawn: {error}");
    }
}

/// Called from `ExitRequested`: the socket and token do not outlive the app.
pub fn stop() {
    crate::builder_screens_capture::stop();
    if let Some(bridge) = BRIDGE.get() {
        #[cfg(unix)]
        let _ = std::fs::remove_file(bridge.run_dir.join(SOCKET_NAME));
        #[cfg(windows)]
        let _ = std::fs::remove_file(bridge.run_dir.join(PORT_NAME));
        let _ = std::fs::remove_file(bridge.run_dir.join(TOKEN_NAME));
    }
}

/// The listening side: a Unix socket on macOS, loopback TCP on Windows.
#[cfg(unix)]
mod transport {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub fn open(run_dir: &Path) -> Result<UnixListener, String> {
        std::fs::create_dir_all(run_dir).map_err(|e| format!("create {}: {e}", run_dir.display()))?;
        std::fs::set_permissions(run_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod {}: {e}", run_dir.display()))?;
        let socket = run_dir.join(SOCKET_NAME);
        if socket.exists() {
            // A live bridge answers a connect; a stale file from a crash does not.
            if UnixStream::connect(&socket).is_ok() {
                return Err(format!("another Plyloft Test already serves {}", socket.display()));
            }
            std::fs::remove_file(&socket).map_err(|e| format!("remove stale socket: {e}"))?;
        }
        let listener =
            UnixListener::bind(&socket).map_err(|e| format!("bind {}: {e}", socket.display()))?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod socket: {e}"))?;
        Ok(listener)
    }

    pub fn publish(_run_dir: &Path, _listener: &UnixListener) -> Result<(), String> {
        Ok(())
    }

    pub fn serve(listener: UnixListener, token: &str, app: &AppHandle) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            // One client at a time: the next connection waits for this one.
            let _ = stream.set_read_timeout(Some(CLIENT_IDLE));
            let Ok(writer) = stream.try_clone() else { continue };
            let _ = handle_client(stream, writer, token, app);
        }
    }
}

#[cfg(windows)]
mod transport {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};

    /// Loopback only, on purpose: the Mac reaches it through the VM's own
    /// helper (`prlctl exec`), so nothing listens on a network interface.
    pub fn open(run_dir: &Path) -> Result<TcpListener, String> {
        std::fs::create_dir_all(run_dir).map_err(|e| format!("create {}: {e}", run_dir.display()))?;
        let port_file = run_dir.join(PORT_NAME);
        if let Some(port) = std::fs::read_to_string(&port_file).ok().and_then(|p| p.trim().parse::<u16>().ok()) {
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                return Err(format!("another Plyloft Test may already serve {} (port {port})", port_file.display()));
            }
        }
        let _ = std::fs::remove_file(&port_file);
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| format!("bind 127.0.0.1: {e}"))
    }

    pub fn publish(run_dir: &Path, listener: &TcpListener) -> Result<(), String> {
        let addr = listener.local_addr().map_err(|e| format!("local addr: {e}"))?;
        if !addr.ip().is_loopback() {
            return Err(format!("refusing to serve on {addr}: loopback only"));
        }
        write_private(&run_dir.join(PORT_NAME), &addr.port().to_string())
            .map_err(|e| format!("write port: {e}"))
    }

    pub fn serve(listener: TcpListener, token: &str, app: &AppHandle) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            if !stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
                continue;
            }
            let _ = stream.set_nodelay(true);
            // One client at a time, as on the Mac; an idle one is dropped.
            let _ = stream.set_read_timeout(Some(CLIENT_IDLE));
            let Ok(writer) = stream.try_clone() else { continue };
            let _ = handle_client(stream, writer, token, app);
        }
    }
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Temp + rename. 0600 on macOS; on Windows the file inherits the profile
/// directory's ACL (the user's own `%APPDATA%`).
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
    }
    std::fs::rename(tmp, path)
}

fn handle_client(
    stream: impl Read,
    mut writer: impl Write,
    token: &str,
    app: &AppHandle,
) -> std::io::Result<()> {
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let (reply, authorized, quit) = handle_line(&line, token, app);
        writer.write_all(reply.to_string().as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        if !authorized {
            return Ok(());
        }
        if quit {
            // After the answer is out: the normal quit, children killed.
            app.exit(0);
            return Ok(());
        }
    }
    Ok(())
}

/// Returns the reply, whether the client stays connected, and whether the
/// app must quit once the reply is written.
fn handle_line(line: &str, token: &str, app: &AppHandle) -> (Value, bool, bool) {
    let request = match parse_request(line, token) {
        Ok(request) => request,
        Err((id, error, authorized)) => return (failure(id, error), authorized, false),
    };
    let result = match request.method.as_str() {
        "app.info" => Ok(app_info(app)),
        "app.state" => app_state(app, &request.params),
        "app.quit" => return (success(request.id, json!({"quitting": true})), true, true),
        // Skills hub H2 (§12 testability): the background pull's cadence in
        // seconds for a walk; 0 puts the real 10 minutes back. Dev builds only.
        "app.skillsHubInterval" => skills_hub_interval(&request.params),
        // UX P-F (UX P1 point 8): what the session-block scan reports for a
        // card's live Builder session, so a walk reads the card, Board and
        // Inbox words without a real usage limit. Dev builds only.
        "builder.injectBlock" => builder_inject_block(app, &request.params),
        // H1 (1.173.0): a freeze on purpose, for the watchdog's walk — the
        // page's script busy for `secs` (`what: "window"`), or the app's main
        // thread asleep (`what: "main"`). Returns at once. Dev builds only.
        "app.freeze" => app_freeze(app, &request.params),
        // 1.176.0 R5: one automatic Codex update attempt now, whatever the
        // day's spacing (the idle, channel and lock rules still apply), on
        // its own thread. Returns at once; its end is the
        // `codex-update://done` event, the log and `setup_last_runs.json`.
        // Dev builds only: no window code can start it.
        "codex.autoUpdate" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let result = crate::codex_auto_update::attempt(&app);
                log::info!("test bridge: codex auto-update attempt: {}", serde_json::to_string(&result).unwrap_or_default());
            });
            Ok(json!({ "started": true }))
        }
        // Team walks: a Team plan minted with the dev key for this profile's
        // device (`app_dev_team_plan`), through the debug-only command. Only
        // this test profile changes; no server is called.
        "account.devLoadEntitlement" => account_dev_load(app, &request.params),
        method if method.starts_with("ui.") => ui_call(app, method, request.params),
        other => Err(format!("unknown method {other:?}")),
    };
    let reply = match result {
        Ok(value) => success(request.id, value),
        Err(error) => failure(request.id, error),
    };
    (reply, true, false)
}

fn account_dev_load(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let token = params
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "token is required".to_string())?;
    let info = crate::commands::account_dev_load_entitlement(app.clone(), token.to_string())
        .map_err(|e| e.message)?;
    serde_json::to_value(info).map_err(|e| e.to_string())
}

fn skills_hub_interval(params: &Value) -> Result<Value, String> {
    let secs = params
        .get("secs")
        .and_then(Value::as_u64)
        .ok_or_else(|| "secs (a whole number of seconds) is required".to_string())?;
    if secs != 0 && !(5..=3600).contains(&secs) {
        return Err("secs must be 0 (the real cadence) or between 5 and 3600".into());
    }
    crate::skills_hub::set_interval_override(secs);
    Ok(json!({"intervalSecs": crate::skills_hub::interval().as_secs()}))
}

/// `{what: "window" | "main", secs}` (1–150): starts the freeze and returns.
/// "window" runs a busy loop in the page, as a stuck WebKit content process
/// would look (no heartbeat); "main" blocks the app's main thread, so the
/// watchdog's posted no-op waits too.
fn app_freeze(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let secs = params
        .get("secs")
        .and_then(Value::as_u64)
        .filter(|s| (1..=150).contains(s))
        .ok_or_else(|| "secs (1 to 150) is required".to_string())?;
    match params.get("what").and_then(Value::as_str) {
        Some("window") => {
            let window = app.get_webview_window("main").ok_or("no main window")?;
            let script = format!(
                "setTimeout(() => {{ const end = Date.now() + {}; while (Date.now() < end) {{}} }}, 0)",
                secs * 1000
            );
            window.eval(&script).map_err(|e| format!("eval: {e}"))?;
        }
        Some("main") => {
            app.run_on_main_thread(move || std::thread::sleep(Duration::from_secs(secs)))
                .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("what must be \"window\" or \"main\", not {other:?}")),
    }
    log::info!("test bridge: freezing the {} for {secs} s", params["what"].as_str().unwrap_or(""));
    Ok(json!({"what": params["what"], "secs": secs}))
}

/// `{card, lane?, kind: "usageLimit" | "bypass" | "trust" | "none", resetsAt?}`:
/// sets (or with `none` clears) the block `builder_session_blocks` reports
/// for the card's live session (or build `a`/`b` of Build with both). It
/// sets the detector's result, not the PTY's bytes; Plyloft still never
/// answers the session. Lasts until cleared or the app quits.
fn builder_inject_block(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let card = params
        .get("card")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| "card (the card id) is required".to_string())?;
    let key = match params.get("lane").and_then(Value::as_str) {
        Some(lane @ ("a" | "b")) => crate::build_both::lane_key(card, lane),
        Some(other) => return Err(format!("lane must be \"a\" or \"b\", not {other:?}")),
        None => card.to_string(),
    };
    let block = inject_block_of(params)?;
    if block.is_some() && app.state::<crate::builder::BuilderRegistry>().get_pty(&key).is_none() {
        return Err(format!("{key} has no live Builder session to block"));
    }
    crate::builder::inject_block(&key, block.clone());
    Ok(json!({"key": key, "kind": block.as_ref().map(|b| b.0), "resetsAt": block.and_then(|b| b.1)}))
}

/// The block `builder.injectBlock` asks for; `None` for `kind: "none"`.
pub(crate) fn inject_block_of(
    params: &Value,
) -> Result<Option<(crate::builder::SessionBlockKind, Option<String>)>, String> {
    use crate::builder::SessionBlockKind;
    let kind = match params.get("kind").and_then(Value::as_str) {
        Some("usageLimit") => SessionBlockKind::UsageLimit,
        Some("bypass") => SessionBlockKind::Bypass,
        Some("trust") => SessionBlockKind::Trust,
        Some("none") => return Ok(None),
        _ => return Err("kind must be usageLimit, bypass, trust or none".into()),
    };
    let resets_at = params
        .get("resetsAt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty() && kind == SessionBlockKind::UsageLimit)
        .map(str::to_string);
    Ok(Some((kind, resets_at)))
}

#[derive(Debug)]
pub(crate) struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

/// Parses one request line. A wrong or missing token is refused and ends the
/// connection (`authorized == false`); a malformed line is only an error.
pub(crate) fn parse_request(line: &str, token: &str) -> Result<Request, (Value, String, bool)> {
    let value: Value =
        serde_json::from_str(line).map_err(|e| (Value::Null, format!("invalid JSON: {e}"), true))?;
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    if value.get("token").and_then(Value::as_str) != Some(token) {
        return Err((id, "invalid token".into(), false));
    }
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| (id.clone(), "missing method".to_string(), true))?
        .to_string();
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
    Ok(Request { id, method, params })
}

fn success(id: Value, result: Value) -> Value {
    json!({"id": id, "ok": true, "result": result})
}

fn failure(id: Value, error: impl Into<String>) -> Value {
    json!({"id": id, "ok": false, "error": error.into()})
}

fn app_info(app: &AppHandle) -> Value {
    let window = app.get_webview_window("main").map(|window| {
        let scale = window.scale_factor().unwrap_or(1.0);
        let inner_position = window.inner_position().ok();
        let inner_size = window.inner_size().ok();
        let outer_position = window.outer_position().ok();
        let outer_size = window.outer_size().ok();
        let logical = |x: i32| f64::from(x) / scale;
        let logical_u = |x: u32| f64::from(x) / scale;
        json!({
            "scale": scale,
            "visible": window.is_visible().unwrap_or(false),
            "focused": window.is_focused().unwrap_or(false),
            "minimized": window.is_minimized().unwrap_or(false),
            "title": window.title().unwrap_or_default(),
            // Screen points, top-left origin: where the webview's (0, 0) is.
            "content": inner_position.zip(inner_size).map(|(p, s)| json!({
                "x": logical(p.x), "y": logical(p.y),
                "width": logical_u(s.width), "height": logical_u(s.height),
            })),
            "frame": outer_position.zip(outer_size).map(|(p, s)| json!({
                "x": logical(p.x), "y": logical(p.y),
                "width": logical_u(s.width), "height": logical_u(s.height),
            })),
        })
    });
    let js_ready = BRIDGE.get().map(|b| *b.js_ready.lock()).unwrap_or(false);
    json!({
        "pid": std::process::id(),
        "identifier": app.config().identifier,
        "version": app.package_info().version.to_string(),
        "jsAgentReady": js_ready,
        "window": window,
        // Launch A2: whether this run passes the Plyloft Sign-in screen
        // (`PLYLOFT_DEV_SKIP_SIGNIN=1`), so app_launch can tell a mismatch.
        "signInSkipped": crate::account::dev_skip_sign_in(),
        // Team walks: whose `gh` this run was started with, so the tester
        // can refuse a running instance that isn't pinned to its person.
        "ghConfigDir": std::env::var("GH_CONFIG_DIR").ok(),
    })
}

fn app_state(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let kind = params.get("kind").and_then(Value::as_str).unwrap_or("");
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    match kind {
        "profile" => Ok(json!({
            "configDir": config_dir,
            "logDir": app.path().app_log_dir().ok(),
            "testRoot": test_root(&config_dir),
        })),
        "workspaces" => read_json(&config_dir.join("workspaces.json")),
        "board" => {
            let workspace = params
                .get("workspace")
                .and_then(Value::as_str)
                .ok_or("board needs params.workspace (a workspace id)")?;
            let store = app
                .try_state::<crate::kanban::KanbanStore>()
                .ok_or("the board store is not loaded yet")?;
            let cards = store.load(workspace)?;
            serde_json::to_value(cards).map_err(|e| e.to_string())
        }
        "processes" => {
            let (tree, not_children) = process_tree(std::process::id())?;
            let agents: Vec<&Value> = tree
                .iter()
                .filter(|p| p["agent"].as_bool() == Some(true))
                .collect();
            let mut out = json!({"processes": tree, "agentCount": agents.len()});
            if !not_children.is_empty() {
                out["notChildren"] = Value::Array(not_children);
            }
            Ok(out)
        }
        "log" => {
            let lines = params
                .get("lines")
                .and_then(Value::as_u64)
                .map(|n| (n as usize).min(LOG_TAIL_MAX))
                .unwrap_or(LOG_TAIL_DEFAULT);
            let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
            log_tail(&log_dir, lines)
        }
        // Never the entitlement itself: the device a dev plan is minted for,
        // and what the app makes of the plan it holds.
        "account" => {
            let store = app
                .try_state::<crate::account::AccountStore>()
                .ok_or("the account store is not loaded yet")?;
            // `devPlanHasNoSeats`: the team walk's way-back gate asks the running
            // build, so a build without that code reads as no.
            let now = chrono::Utc::now().timestamp_millis();
            Ok(json!({"deviceId": store.device_id(), "info": store.info(), "devPlanHasNoSeats": store.dev_plan_has_no_seats_at(now)}))
        }
        // 1.176.3: capture every live Builder session's screen into this
        // test profile (`builder_screens_capture.rs`); the answer names the
        // folder and each frame's verdict, never the screen's text. The
        // label (and the truth, "<label> idle") in `label`, or in `workspace`,
        // the field the ply-test MCP passes on.
        "builderScreens" => {
            let text = params
                .get("label")
                .or_else(|| params.get("workspace"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let (label, expect) = crate::builder_screens_capture::parse_request(text);
            crate::builder_screens_capture::capture(app, &label, expect)
        }
        other => Err(format!(
            "unknown state kind {other:?} (profile, workspaces, board, processes, log, account, builderScreens)"
        )),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn log_tail(log_dir: &Path, lines: usize) -> Result<Value, String> {
    let newest = std::fs::read_dir(log_dir)
        .map_err(|e| format!("{}: {e}", log_dir.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
        .max_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
    let Some(newest) = newest else {
        return Ok(json!({"file": Value::Null, "lines": []}));
    };
    let text = std::fs::read_to_string(newest.path()).map_err(|e| e.to_string())?;
    Ok(json!({"file": newest.path(), "lines": tail_lines(&text, lines)}))
}

pub(crate) fn tail_lines(text: &str, count: usize) -> Vec<&str> {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(count)..].to_vec()
}

/// Every descendant of `root`, from one `ps` listing. `agent` marks a
/// claude/codex executable: the walk audit counts those.
#[cfg(unix)]
fn process_tree(root: u32) -> Result<(Vec<Value>, Vec<Value>), String> {
    // The command lines first: an agent that ended before the listing below
    // simply isn't listed. One that started between the two is looked up
    // alone. The walk audit treats a line it can't read as an agent.
    let lines = ps_lines(&["-A", "-ww", "-o", "pid=,args="]);
    let child = crate::platform::new_command("/bin/ps")
        .args(["-A", "-o", "pid=,ppid=,comm="])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("ps: {e}"))?;
    // The listing's own `ps` is our child too; it is not part of the app.
    let ps_pid = child.id();
    let output = child.wait_with_output().map_err(|e| format!("ps: {e}"))?;
    let listing = String::from_utf8_lossy(&output.stdout);
    let tree = descendants(&listing, root)
        .into_iter()
        .filter(|(pid, _, _)| *pid != ps_pid)
        .map(|(pid, ppid, command)| {
            let agent = is_agent(&command);
            let mut row = json!({"pid": pid, "ppid": ppid, "command": command, "agent": agent});
            if agent {
                let args = lines.get(&pid).cloned().or_else(|| {
                    ps_lines(&["-ww", "-o", "pid=,args=", "-p", &pid.to_string()]).remove(&pid)
                });
                row["args"] = json!(args);
            }
            row
        })
        .collect();
    // A Unix parent pid follows the process: no link is refused.
    Ok((tree, Vec::new()))
}

/// `ps … -o pid=,args=` as pid → command line; empty when it can't run.
#[cfg(unix)]
fn ps_lines(args: &[&str]) -> HashMap<u32, String> {
    let output = crate::platform::new_command("/bin/ps").args(args).output();
    output.map(|o| parse_args_listing(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
}

pub(crate) fn parse_args_listing(listing: &str) -> HashMap<u32, String> {
    listing
        .lines()
        .filter_map(|line| {
            let (pid, args) = line.trim_start().split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, args.trim().to_string()))
        })
        .collect()
}

/// Windows: every descendant of `root`, from one ToolHelp snapshot (the
/// executable's file name as its command).
#[cfg(windows)]
fn process_tree(root: u32) -> Result<(Vec<Value>, Vec<Value>), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut listing = String::new();
    // SAFETY: a snapshot handle, closed below; an entry with its size set.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return Err("process snapshot failed".into());
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            listing.push_str(&format!("{} {} {}\n", entry.th32ProcessID, entry.th32ParentProcessID, name));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    let (found, refused) = descendants_and_refused(&listing, root, |child, parent| parent_is_real(created(child), created(parent)));
    let tree = found
        .into_iter()
        .map(|(pid, ppid, command)| {
            json!({"pid": pid, "ppid": ppid, "command": command, "agent": is_agent(&command)})
        })
        .collect();
    let not_children = refused.into_iter().map(|(pid, ppid, command)| json!({"pid": pid, "ppid": ppid, "command": command})).collect();
    Ok((tree, not_children))
}

/// When `pid` started (FILETIME ticks), if it can be read.
#[cfg(windows)]
fn created(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: a process handle, closed below; four FILETIMEs for it to fill.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut times = [FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
        let [creation, exit, kernel, user] = &mut times;
        let ok = GetProcessTimes(handle, creation, exit, kernel, user) != 0;
        CloseHandle(handle);
        ok.then(|| (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime))
    }
}

/// Windows keeps a process's parent pid for life, and reuses pids: a listed
/// parent that started after its child is a stranger with the old number (the
/// installed Plyloft read as a child of this app's WebView2, walk of 2026-11-03).
/// Creation times, in any one unit; unknown keeps the link, so a real child is
/// never lost to a failed read.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parent_is_real(child_created: Option<u64>, parent_created: Option<u64>) -> bool {
    !matches!((child_created, parent_created), (Some(child), Some(parent)) if child < parent)
}

/// Parses `ps -o pid=,ppid=,comm=` and returns the descendants of `root`.
pub(crate) fn descendants(listing: &str, root: u32) -> Vec<(u32, u32, String)> {
    descendants_where(listing, root, |_, _| true)
}

/// [`descendants`], following only the links `real(child, parent)` accepts.
pub(crate) fn descendants_where(
    listing: &str,
    root: u32,
    real: impl Fn(u32, u32) -> bool,
) -> Vec<(u32, u32, String)> {
    descendants_and_refused(listing, root, real).0
}

/// [`descendants_where`], and the links `real` refused: a clock stepped back
/// looks the same as a reused pid, so `app_quit` lists them and a real orphan
/// isn't hidden silently.
#[allow(clippy::type_complexity)]
pub(crate) fn descendants_and_refused(
    listing: &str,
    root: u32,
    real: impl Fn(u32, u32) -> bool,
) -> (Vec<(u32, u32, String)>, Vec<(u32, u32, String)>) {
    let rows: Vec<(u32, u32, String)> = listing
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let command = parts.collect::<Vec<_>>().join(" ");
            Some((pid, ppid, command))
        })
        .collect();
    let mut found = Vec::new();
    let mut refused = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for row in rows.iter().filter(|row| row.1 == parent) {
            if row.0 != root && !found.iter().any(|f: &(u32, u32, String)| f.0 == row.0) {
                if real(row.0, parent) {
                    frontier.push(row.0);
                    found.push(row.clone());
                } else {
                    refused.push(row.clone());
                }
            }
        }
    }
    (found, refused)
}

pub(crate) fn is_agent(command: &str) -> bool {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    AGENT_EXECUTABLES.contains(&stem)
}

fn ui_call(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let bridge = BRIDGE.get().ok_or("test bridge not started")?;
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let timeout_ms = params
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(UI_DEFAULT_TIMEOUT_MS);
    let id = {
        let mut next = bridge.next_id.lock();
        *next += 1;
        *next
    };
    let (sender, receiver) = mpsc::channel();
    bridge.pending.lock().insert(id, sender);
    let request = json!({"id": id, "method": method, "params": params});
    let script = format!(
        "window.__plyTestBridge && window.__plyTestBridge.handle({})",
        serde_json::to_string(&request).map_err(|e| e.to_string())?
    );
    if let Err(error) = window.eval(&script) {
        bridge.pending.lock().remove(&id);
        return Err(format!("eval: {error}"));
    }
    let wait = Duration::from_millis(timeout_ms) + UI_GRACE;
    let reply = receiver.recv_timeout(wait).map_err(|_| {
        bridge.pending.lock().remove(&id);
        if *bridge.js_ready.lock() {
            format!("the page did not answer {method} within {}s", wait.as_secs())
        } else {
            "the JS agent is not loaded: was the frontend built with PLY_TEST_BRIDGE=1?".to_string()
        }
    })?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the page answered without a result")
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_test_identifier_opens_the_bridge() {
        assert!(refusal_for_identifier(TEST_IDENTIFIER).is_none());
        assert!(refusal_for_identifier(MEMBER_IDENTIFIER).is_none());
        let refusal = refusal_for_identifier("com.mbadv.ply").unwrap();
        assert!(refusal.contains("com.mbadv.ply.test"));
        assert!(refusal_for_identifier("com.mbadv.ply.testx").is_some());
    }

    #[test]
    fn only_the_word_member_names_the_second_person() {
        assert!(names_member(Some("member")));
        assert!(!names_member(None));
        assert!(!names_member(Some("")));
        assert!(!names_member(Some("owner")));
    }

    /// Team walks give each instance its own clone root by writing this one
    /// key into a profile that may have no settings yet (`ply-test-mcp`): it
    /// must load, and win over `~/code` and `~/Projects`.
    #[test]
    fn a_settings_file_with_only_the_clone_root_loads_and_names_it() {
        let settings: crate::settings::Settings =
            serde_json::from_str(r#"{"schemaVersion":1,"team":{"cloneRoot":"/p/team-clones"}}"#).unwrap();
        let setting = crate::team::clone_root_setting(&settings.team, &settings.projects);
        assert_eq!(setting, Some("/p/team-clones"));
        assert_eq!(crate::team::effective_clone_root(setting, None), PathBuf::from("/p/team-clones"));
    }

    #[test]
    fn a_wrong_token_is_refused_and_drops_the_client() {
        let line = r#"{"id":1,"token":"nope","method":"app.info"}"#;
        let (id, error, authorized) = parse_request(line, "secret").unwrap_err();
        assert_eq!(id, json!(1));
        assert_eq!(error, "invalid token");
        assert!(!authorized);
        let missing = r#"{"id":2,"method":"app.info"}"#;
        assert!(!parse_request(missing, "secret").unwrap_err().2);
    }

    /// UX P-F: `builder.injectBlock`'s kinds; a reset time only on a limit.
    #[test]
    fn an_injected_block_names_its_kind() {
        use crate::builder::SessionBlockKind;
        assert_eq!(
            inject_block_of(&json!({"kind": "usageLimit", "resetsAt": " 3pm "})).unwrap(),
            Some((SessionBlockKind::UsageLimit, Some("3pm".into())))
        );
        assert_eq!(inject_block_of(&json!({"kind": "usageLimit"})).unwrap(), Some((SessionBlockKind::UsageLimit, None)));
        assert_eq!(inject_block_of(&json!({"kind": "bypass", "resetsAt": "3pm"})).unwrap(), Some((SessionBlockKind::Bypass, None)));
        assert_eq!(inject_block_of(&json!({"kind": "none"})).unwrap(), None);
        assert!(inject_block_of(&json!({"kind": "limit"})).is_err());
        assert!(inject_block_of(&json!({})).is_err());
    }

    #[test]
    fn a_good_request_parses_with_default_params() {
        let line = r#"{"id":"a","token":"secret","method":"ui.snapshot"}"#;
        let request = parse_request(line, "secret").unwrap();
        assert_eq!(request.id, json!("a"));
        assert_eq!(request.method, "ui.snapshot");
        assert_eq!(request.params, json!({}));
        let malformed = parse_request("{", "secret").unwrap_err();
        assert!(malformed.2, "malformed JSON keeps the client");
    }

    #[test]
    fn descendants_walk_the_whole_subtree_only() {
        let listing = "\
  100     1 /Applications/Plyloft Test.app/Contents/MacOS/atelier
  200   100 /bin/zsh
  300   200 /Users/me/.local/bin/claude
  301   300 /usr/bin/git
  400     1 /Users/me/.local/bin/claude
  500   100 codex
";
        let found = descendants(listing, 100);
        let pids: Vec<u32> = found.iter().map(|f| f.0).collect();
        assert_eq!(pids.len(), 4);
        for pid in [200, 300, 301, 500] {
            assert!(pids.contains(&pid), "{pid} is under the app");
        }
        assert!(!pids.contains(&400), "an unrelated claude is not ours");
        let agents: Vec<u32> = found.iter().filter(|f| is_agent(&f.2)).map(|f| f.0).collect();
        assert_eq!(agents.len(), 2);
    }

    #[test]
    fn a_stranger_with_a_reused_parent_pid_stays_out_with_its_children() {
        // The walk of 2026-11-03: 5672, the installed Plyloft, started the day
        // before 4496 got its number.
        let created = |pid: u32| match pid {
            5452 => Some(100),
            4496 => Some(110),
            77 => Some(120),
            5672 => Some(5),
            11544 => Some(6),
            _ => None,
        };
        let listing = "4496 5452 msedgewebview2.exe\n5672 4496 atelier.exe\n11544 5672 msedgewebview2.exe\n77 5452 claude.exe\n78 77 node.exe\n";
        let found = descendants_where(listing, 5452, |child, parent| parent_is_real(created(child), created(parent)));
        let mut pids: Vec<u32> = found.iter().map(|f| f.0).collect();
        pids.sort_unstable();
        assert_eq!(pids, vec![77, 78, 4496], "real children, one with no readable time");
        // The stranger is left out of the tree and still named, so a clock
        // stepped back can't hide a real orphan silently.
        let (_, refused) = descendants_and_refused(listing, 5452, |child, parent| parent_is_real(created(child), created(parent)));
        assert_eq!(refused, vec![(5672, 4496, "atelier.exe".to_string())]);
        assert!(parent_is_real(Some(100), Some(100)), "the same tick isn't proof");
        assert!(parent_is_real(None, Some(1)) && parent_is_real(Some(1), None));
    }

    #[test]
    fn command_lines_are_read_by_pid_with_their_spaces() {
        let lines = parse_args_listing(
            "  300 /Users/me/.local/bin/claude auth status --json\n12 /a b/codex  login status\nnot a row\n",
        );
        assert_eq!(lines[&300], "/Users/me/.local/bin/claude auth status --json");
        assert_eq!(lines[&12], "/a b/codex  login status");
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn agent_names_match_the_executable_only() {
        assert!(is_agent("/Users/me/.local/bin/claude"));
        assert!(is_agent("codex"));
        assert!(!is_agent("/opt/claude-tools/bin/zsh"));
        assert!(!is_agent("claudette"));
        assert!(is_agent("claude.exe"));
        assert!(is_agent(r"C:\Users\me\.local\bin\Claude.EXE"));
        assert!(!is_agent("claude.exe.bak"));
    }

    #[test]
    fn tail_keeps_the_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\n", 2), vec!["b", "c"]);
        assert_eq!(tail_lines("a\n", 5), vec!["a"]);
    }
}
