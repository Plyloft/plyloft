//! ply-test-mcp — SL-0 app tester (docs/app-tester/DESIGN.md).
//!
//! A stdio MCP server, declared only inside the `app-tester` agent's own
//! frontmatter. It drives "Plyloft Test" (a debug build with the test bridge,
//! on its own profile) through the bridge socket, and uses PlyTestHelper for
//! what needs macOS permissions: trusted input on the Plyloft Test window,
//! window screenshots, native dialogs and menus. With `target: windows` it
//! drives Plyloft Test in the Parallels Windows VM instead, through
//! ply-test-winhelper (`vm.rs`). On the Mac, `instance: member` drives a second
//! person in "Plyloft Test Member" beside the owner, for team walks. Dev
//! tooling; never bundled.

pub mod dev_plan;
pub mod readers;
pub mod server;
pub mod sock;
pub mod vm;
pub mod walk;

use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub const SERVER_NAME: &str = "ply-test";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

pub fn serve<R: BufRead, W: Write>(mut input: R, mut output: W, server: &mut server::Server) -> Result<(), String> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line).map_err(|e| format!("read stdin: {e}"))? == 0 {
            return Ok(());
        }
        if let Some(response) = handle_line(server, line.trim_end_matches(['\r', '\n'])) {
            writeln!(output, "{response}").map_err(|e| format!("write stdout: {e}"))?;
            output.flush().map_err(|e| format!("flush stdout: {e}"))?;
        }
    }
}

pub fn handle_line(server: &mut server::Server, line: &str) -> Option<String> {
    if line.trim().is_empty() {
        return None;
    }
    let request: Value = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return Some(error(Value::Null, -32700, format!("parse error: {e}")).to_string()),
    };
    let id = request.get("id").filter(|id| !id.is_null()).cloned()?;
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let response = match method {
        "initialize" => {
            let version = request["params"]["protocolVersion"].as_str().unwrap_or(DEFAULT_PROTOCOL_VERSION);
            success(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => success(id, json!({})),
        "tools/list" => success(id, tools_list()),
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or("");
            let args = request["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
            match server.call_tool(name, &args) {
                Ok(content) => success(id, json!({"content": content, "isError": false})),
                Err(message) => success(id, json!({"content": [{"type": "text", "text": message}], "isError": true})),
            }
        }
        other => error(id, -32601, format!("unsupported method: {other}")),
    };
    Some(response.to_string())
}

fn success(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: Value, code: i64, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

const INSTRUCTIONS: &str = "Drives Plyloft Test (a dev build on its own profile) for Tier 4 walks. \
Start with walk_start (target mac or windows), record every step with walk_step, end with walk_finish. \
Find controls with ui_snapshot, act by ref or by name, and prove each verdict with evidence. \
Team walks: walk_start with team true; instance member on the app, ui and native tools acts as the second person, and once the member is up every ui and native call must name its instance.";

fn query_props() -> Value {
    json!({
        "ref": {"type": "string", "description": "A ref from ui_snapshot, e.g. e31"},
        "name": {"type": "string", "description": "Accessible name: exact, then case-insensitive, then substring"},
        "role": {"type": "string", "description": "Narrows a name match: button, link, textbox, checkbox, tab, terminal…"},
        "index": {"type": "integer", "description": "Which of several name matches (0-based)"}
    })
}

fn with_query(extra: Value) -> Value {
    let mut props = query_props();
    if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    props
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str], read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required},
        "annotations": {"readOnlyHint": read_only, "destructiveHint": false, "openWorldHint": false},
    })
}

pub fn tools_list() -> Value {
    let mode = json!({"type": "string", "enum": ["auto", "dom", "trusted"],
        "description": "auto (default): DOM events for plain controls, real OS events for terminals, right/double clicks. trusted: real mouse/keys on the Plyloft Test window."});
    let target = json!({"type": "string", "enum": ["mac", "windows"],
        "description": "mac (default): Plyloft Test on this Mac. windows: Plyloft Test in the Parallels Windows VM."});
    let instance = json!({"type": "string", "enum": ["owner", "member"],
        "description": "Who acts, on the Mac: owner (Plyloft Test) or member (the second person, Plyloft Test Member). Default owner; required on ui_* and native_* while the member is running or has acted in the walk."});
    let mut tools = json!({"tools": [
        tool("walk_start", "Begin a walk: creates its report dir (with sandbox/ for throwaway repos and shots/). allow_agent_tiles must be true only if the owner said yes for this walk.",
            json!({"guide": {"type": "string", "description": "Where the guide comes from (STATUS entry, PPVP section, card)"},
                   "title": {"type": "string"},
                   "allow_agent_tiles": {"type": "boolean"},
                   "team": {"type": "boolean", "description": "A team walk (Mac only): the member may start, and each app_launch pins its instance to its person (gh, git, its own clone root) and refuses a wrong identity."},
                   "target": target.clone()}), &["guide", "allow_agent_tiles"], false),
        tool("walk_step", "Record one step with its verdict: passato | fallito | passato (solo visivo) | non verificabile. Evidence is required: quote the snapshot lines, state, terminal text or repo/GitHub output that proves it.",
            json!({"n": {"type": "integer"}, "action": {"type": "string"}, "expected": {"type": "string"},
                   "verdict": {"type": "string", "enum": walk::VERDICTS}, "evidence": {"type": "string"},
                   "note": {"type": "string"}, "screenshots": {"type": "array", "items": {"type": "string"}},
                   "instance": {"type": "string", "enum": ["owner", "member", "both"],
                                "description": "Who acted in this step; default: the instances the tools acted through since the last step."}}),
            &["action", "expected", "verdict", "evidence"], false),
        tool("walk_finish", "End the walk and write report.md/report.json. The walk is invalid if a claude/codex process started without allow_agent_tiles; the app's own read-only status checks (claude auth status --json, codex login status, --version, exactly) are listed, not counted.",
            json!({"summary": {"type": "string"}}), &[], false),
        tool("app_launch", "Start Plyloft Test (or report it is already running) and wait until its page is ready. target only outside a walk (a walk fixes it). It starts past the Plyloft Sign-in screen (PLYLOFT_DEV_SKIP_SIGNIN=1) unless sign_in is true — only for a walk about signing in to Plyloft.",
            json!({"target": target.clone(), "sign_in": {"type": "boolean"}}), &[], false),
        tool("app_quit", "Quit Plyloft Test and check that no child process outlived it. via: bridge (default), cmd+q (a real Cmd-Q; Ctrl+Shift+Q on Windows), menu (the app menu's Quit; Mac only). seconds = until the app exited, cleanupSeconds = with the wait for its children. On Windows, msedgewebview2.exe children get 30 s from the app's exit (others 10 s) and are listed in webviewLingering with lingeredSeconds; they are orphans only if still running after the grace. The installed Plyloft and its descendants are never orphans (installedLeftOut lists them when a stale parent pid put them in the tree; installedUnread says why they could not be told apart). On Windows, notChildren lists the links refused because the listed parent started after its child, with stillRunning: normally a stranger with a reused pid, but a clock stepped back looks the same, so read it before calling a quit clean.",
            json!({"via": {"type": "string", "enum": ["bridge", "cmd+q", "menu"]}}), &[], false),
        tool("app_dev_team_plan", "During a walk: give this instance a Team plan on test-owner/plyloft-test-team, with the dev key. On the Mac, role and login are the instance's. With target windows the VM's one test profile plays either: role is required, login defaults to that role's test account (test-owner, test-user), another login needs its sub; the key stays on the Mac and only the token reaches the VM. Lasts 30 days on that profile; reaches no server. Dev builds only; needs a run past the Sign-in screen.",
            json!({"role": {"type": "string", "enum": ["owner", "member"], "description": "target windows only"},
                   "login": {"type": "string", "description": "target windows only"},
                   "sub": {"type": "string", "description": "target windows only: the account's number, for a login other than the two test accounts"}}), &[], false),
        tool("app_status", "Is Plyloft Test running: pid, window frame, focus, page ready, and on which target.", json!({"target": target}), &[], true),
        tool("app_skills_hub_interval", "Skills hub walks: run the team library's background pull every secs seconds (5-3600) instead of 10 minutes; 0 puts the real cadence back. Dev builds only; lasts until the app quits.",
            json!({"secs": {"type": "integer"}}), &["secs"], false),
        tool("app_freeze", "H1 watchdog walks: freeze on purpose and return at once. what: window (the page's script busy for secs, like a stuck WebKit content process: the heartbeat stops) | main (the app's main thread asleep for secs). secs 1-150. Then read the log (app_state kind log) for the watchdog's lines. Dev builds only.",
            json!({"what": {"type": "string", "enum": ["window", "main"]}, "secs": {"type": "integer"}}), &["what", "secs"], false),
        tool("builder_inject_block", "UX P-F walks: make the session-block scan report a block for a card's live Builder session (lane a/b for Build with both), so the card, Board and Inbox words can be read without a real usage limit. kind: usageLimit | bypass | trust | none (clears). resetsAt only with usageLimit (as Claude would write it, e.g. 3pm). It sets the detector's result, not the terminal's bytes: say the limit was simulated. Dev builds only; lasts until cleared or the app quits.",
            json!({"card": {"type": "string"}, "lane": {"type": "string", "enum": ["a", "b"]},
                   "kind": {"type": "string", "enum": ["usageLimit", "bypass", "trust", "none"]},
                   "resetsAt": {"type": "string"}}), &["card", "kind"], false),
        tool("app_state", "Read-only app state. kind: profile | workspaces | board (needs workspace id) | processes (the app's children; agent=true marks claude/codex) | log (tail) | account (device id, login, plan, team) | builderScreens (1.176.3: writes every live Builder session's screen, 3 frames, into the test profile's app-tester/screens/; workspace = \"<label> [running|asking|idle|unknown]\"; answers the folder and each frame's verdict, never the text).",
            json!({"kind": {"type": "string", "enum": ["profile", "workspaces", "board", "processes", "log", "account", "builderScreens"]},
                   "workspace": {"type": "string"}, "lines": {"type": "integer"}}), &["kind"], true),
        tool("ui_snapshot", "The controls tree of the window: role \"name\" [ref] (states). Hidden elements (and inactive workspaces) are left out. Terminals show their last lines.",
            json!({"scope": {"type": "string", "description": "A ref to limit the tree to"},
                   "filter": {"type": "string", "description": "Keep only lines containing this text"},
                   "max_depth": {"type": "integer"}}), &[], true),
        tool("ui_click", "Click a control by ref or name. A trusted click is checked: it fails if the page did not receive it on that control.",
            with_query(json!({"mode": mode, "button": {"type": "string", "enum": ["left", "right"]},
                              "count": {"type": "integer"}, "modifiers": {"type": "array", "items": {"type": "string"}}})), &[], false),
        tool("ui_type", "Type into a field or a terminal. replace (default true) replaces a field's text; submit presses Enter after.",
            with_query(json!({"text": {"type": "string"}, "submit": {"type": "boolean"}, "replace": {"type": "boolean"}, "mode": mode})), &["text"], false),
        tool("ui_key", "Press a key chord in Plyloft Test (real keys by default): cmd+k, escape, enter, cmd+shift+p, cmd+q… Aimed at a terminal (name or ref), named keys go in as its input: up, down, enter, escape, tab, ctrl+c.",
            json!({"keys": {"type": "string"}, "mode": {"type": "string", "enum": ["trusted", "dom"]},
                   "ref": {"type": "string"}, "name": {"type": "string"}, "role": {"type": "string"}}), &["keys"], false),
        tool("ui_drag", "Drag one control onto another with the real mouse (HTML5 drag, e.g. a card between board columns).",
            json!({"from": {"type": "object", "properties": query_props()}, "to": {"type": "object", "properties": query_props()},
                   "to_position": {"type": "string", "enum": ["top", "center", "bottom"],
                                   "description": "Where on the target to drop (lists order a drop by its height); default center"},
                   "steps": {"type": "integer"}}), &["from", "to"], false),
        tool("ui_scroll", "Scroll with the real wheel over a control (a list, a terminal, a panel): lines > 0 scrolls down, < 0 up.",
            with_query(json!({"lines": {"type": "integer"}})), &[], false),
        tool("ui_wait_for", "Wait until text or a control appears (or, with gone, disappears).",
            with_query(json!({"text": {"type": "string"}, "gone": {"type": "boolean"}, "timeout_ms": {"type": "integer"}})), &[], true),
        tool("ui_terminal", "The last lines of a terminal tile (by tile name or ref).",
            with_query(json!({"lines": {"type": "integer"}})), &[], true),
        tool("ui_screenshot", "Capture the Plyloft Test window (and any sheet or dialog on it). Saved in the walk's shots/; returned as an image.",
            json!({"name": {"type": "string"}}), &[], true),
        tool("native_snapshot", "The macOS accessibility tree of Plyloft Test's native parts: sheets, alerts, the Open panel; with menus=true, the menu bar. Web content is not included (use ui_snapshot).",
            json!({"menus": {"type": "boolean"}, "max_depth": {"type": "integer"}}), &[], true),
        tool("native_press", "Press a native control by its ax id from native_snapshot.", json!({"ax": {"type": "integer"}}), &["ax"], false),
        tool("native_menu", "Choose a menu item by its path of titles, e.g. [\"Plyloft Test\", \"Settings…\"].",
            json!({"path": {"type": "array", "items": {"type": "string"}}}), &["path"], false),
        tool("gh_read", "Read-only GitHub queries: pull requests, runs, branches, issues (issue_list; issue_list_open, the open ones with their authors; issue_view with assignees, labels and comments) sandbox_definition (.atelier/workspace.json), sandbox_collaborators and sandbox_invitations on test-owner/plyloft-ci-sandbox; team_manifest (team.json), team_collaborators and team_invitations of test-owner/plyloft-test-team; team_no_such_user, one fixed login a team walk needs GitHub not to know (its 404 is the answer).",
            json!({"query": {"type": "string", "enum": ["pr_list", "pr_view", "pr_checks", "pr_comments", "pr_reviews", "runs", "branches", "issue_list", "issue_list_open", "issue_view", "sandbox_definition", "sandbox_collaborators", "sandbox_invitations", "team_manifest", "team_collaborators", "team_invitations", "team_no_such_user"]},
                   "number": {"type": "integer"}}), &["query"], true),
        tool("gh_accept_invitation", "Team walks only, during a walk: the member accepts its pending invitation to one fixed repository (sandbox = plyloft-ci-sandbox, team = plyloft-test-team). The only write to GitHub outside the app. Says accepted false when nothing is pending.",
            json!({"repo": {"type": "string", "enum": ["sandbox", "team"]}}), &["repo"], false),
        tool("repo_read", "Read-only git view of a throwaway repo under the walks directory (e.g. the walk's sandbox/).",
            json!({"path": {"type": "string", "description": "Repo dir, absolute or relative to the walks directory"},
                   "op": {"type": "string", "enum": ["status", "status_ignored", "log", "log_all", "branches", "remotes", "diff_stat", "stash", "worktrees", "file"]},
                   "file": {"type": "string"}, "n": {"type": "integer"}}), &["path", "op"], true),
        tool("permissions", "Mac: which macOS permissions PlyTestHelper holds. Windows: the VM helper's state (emergency chord armed, stopped).", json!({}), &[], true),
        tool("win_read", "Windows target only, read-only fixed queries in the VM: processes (Plyloft Test's process tree, and every claude/codex/ply-mcp with whether its parent runs: the orphan check), log (tail of the app log), profile_list / profile_file (the test profile's files; path relative, base roaming|local), uninstall (Plyloft/Ply uninstall entries in the registry), run_keys (HKCU Run).",
            json!({"query": {"type": "string", "enum": ["processes", "log", "profile_list", "profile_file", "uninstall", "run_keys"]},
                   "path": {"type": "string"}, "base": {"type": "string", "enum": ["roaming", "local"]},
                   "lines": {"type": "integer"}}), &["query"], true),
    ]});
    for tool in tools["tools"].as_array_mut().into_iter().flatten() {
        if server::targets_instance(tool["name"].as_str().unwrap_or("")) {
            tool["inputSchema"]["properties"]["instance"] = instance.clone();
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use server::{Config, Server};

    fn server(dir: &std::path::Path) -> Server {
        server_on(dir, server::Target::Mac, "/nonexistent/prlctl")
    }

    fn server_on(dir: &std::path::Path, target: server::Target, prlctl: &str) -> Server {
        Server::new(Config {
            root: dir.join("root"),
            member_root: dir.join("member-root"),
            member_env: dir.join("member-env"),
            owner_env: dir.join("owner-env"),
            support: dir.join("support"),
            gh: "gh".into(),
            walks: dir.join("walks"),
            app: dir.join("missing.app"),
            helper: dir.join("missing-helper.app"),
            target,
            vm: vm::VmConfig {
                name: "none".into(),
                prlctl: prlctl.into(),
                helper: vm::DEFAULT_HELPER.into(),
                app: vm::DEFAULT_APP.into(),
                root: String::new(),
            },
            dev_key: None,
        })
    }

    fn call(server: &mut Server, value: Value) -> Value {
        serde_json::from_str(&handle_line(server, &value.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn a_running_app_started_the_other_way_is_refused() {
        let skipped = json!({"signInSkipped": true});
        let shown = json!({"signInSkipped": false});
        assert!(server::running_sign_in_matches(&skipped, false).is_ok());
        assert!(server::running_sign_in_matches(&shown, true).is_ok());
        let err = server::running_sign_in_matches(&skipped, true).unwrap_err();
        assert!(err.contains("app_quit") && err.contains("sign_in: true"), "{err}");
        assert!(server::running_sign_in_matches(&shown, false).is_err());
        assert!(server::running_sign_in_matches(&json!({}), true).is_ok(), "an older build is reused");
    }

    #[test]
    fn walks_start_past_sign_in_unless_the_walk_is_about_it() {
        let none = |_: &str| None;
        assert_eq!(server::launch_env(false, none), vec![("PLYLOFT_DEV_SKIP_SIGNIN".to_string(), "1".to_string())]);
        assert!(server::launch_env(true, none).is_empty());
        let staging = |n: &str| match n {
            "PLYLOFT_API_URL" => Some("https://staging.example/v1".to_string()),
            "PLYLOFT_GITHUB_CLIENT_ID" => Some("  ".to_string()),
            "PLYLOFT_ENTITLEMENT_PUBKEY" => Some("ab12".to_string()),
            _ => Some("never".to_string()),
        };
        assert_eq!(
            server::launch_env(true, staging),
            vec![
                ("PLYLOFT_API_URL".to_string(), "https://staging.example/v1".to_string()),
                ("PLYLOFT_ENTITLEMENT_PUBKEY".to_string(), "ab12".to_string()),
            ],
            "only the named variables, and never an empty one"
        );
    }

    #[test]
    fn initialize_and_list() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = server(dir.path());
        let init = call(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "x"}}));
        assert_eq!(init["result"]["protocolVersion"], "x");
        assert_eq!(init["result"]["serverInfo"]["name"], "ply-test");
        let list = call(&mut s, json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}));
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        for expected in ["walk_start", "ui_snapshot", "ui_click", "ui_screenshot", "gh_read", "app_state", "win_read"] {
            assert!(names.contains(&expected), "{expected}");
        }
        assert!(!names.iter().any(|n| n.contains("reset") || n.contains("shell") || n.contains("exec")));
        assert!(handle_line(&mut s, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
    }

    #[test]
    fn tools_explain_a_stopped_or_absent_app() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = server(dir.path());
        let snap = call(&mut s, json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "ui_snapshot"}}));
        assert_eq!(snap["result"]["isError"], true);
        assert!(snap["result"]["content"][0]["text"].as_str().unwrap().contains("not running"));
        std::fs::create_dir_all(dir.path().join("root/run")).unwrap();
        std::fs::write(dir.path().join("root/run/stop"), "x").unwrap();
        let stopped = call(&mut s, json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "ui_click", "arguments": {"name": "Ship"}}}));
        assert!(stopped["result"]["content"][0]["text"].as_str().unwrap().contains("stopped by the owner"));
        let real_quit = call(&mut s, json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "app_quit", "arguments": {"via": "cmd+q"}}}));
        assert!(real_quit["result"]["content"][0]["text"].as_str().unwrap().contains("stopped by the owner"));
        let bridge_quit = call(&mut s, json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "app_quit"}}));
        assert!(bridge_quit["result"]["content"][0]["text"].as_str().unwrap().contains("not running"), "a bridge quit is allowed after a stop");
    }

    #[test]
    fn the_windows_target_needs_the_vm_and_is_fixed_by_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = server(dir.path());
        let tool = |s: &mut Server, name: &str, args: Value| {
            call(s, json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}}))
        };
        let read = tool(&mut s, "win_read", json!({"query": "processes"}));
        assert!(read["result"]["content"][0]["text"].as_str().unwrap().contains("target windows"));
        let bad = tool(&mut s, "app_status", json!({"target": "linux"}));
        assert_eq!(bad["result"]["isError"], true);
        let status = tool(&mut s, "app_status", json!({"target": "windows"}));
        let text = status["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"target\": \"windows\"") && text.contains("\"running\": false"), "{text}");
        let start = tool(&mut s, "walk_start", json!({"guide": "g", "allow_agent_tiles": false, "target": "windows"}));
        assert!(start["result"]["content"][0]["text"].as_str().unwrap().contains("not reachable"));
        let mac = tool(&mut s, "walk_start", json!({"guide": "g", "allow_agent_tiles": false, "target": "mac"}));
        assert_eq!(mac["result"]["isError"], false);
        let switch = tool(&mut s, "app_launch", json!({"target": "windows"}));
        assert!(switch["result"]["content"][0]["text"].as_str().unwrap().contains("finish it first"));
    }

    /// A fake bridge or helper on the real socket path: answers each call
    /// with `reply` and records it.
    fn fake(run: &std::path::Path, name: &str, reply: fn(&str, &Value) -> Value) -> std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>> {
        use std::io::{BufRead, BufReader, Write};
        std::fs::create_dir_all(run).unwrap();
        std::fs::write(run.join(format!("{name}.token")), "t").unwrap();
        let listener = std::os::unix::net::UnixListener::bind(run.join(format!("{name}.sock"))).unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let mut writer = stream.try_clone().unwrap();
                for line in BufReader::new(stream).lines() {
                    let Ok(line) = line else { break };
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let method = request["method"].as_str().unwrap().to_string();
                    let result = reply(&method, &request["params"]);
                    seen.lock().unwrap().push((method, request["params"].clone()));
                    let answer = match result.get("__error") {
                        Some(why) => json!({"id": request["id"], "ok": false, "error": why}),
                        None => json!({"id": request["id"], "ok": true, "result": result}),
                    };
                    writeln!(writer, "{answer}").unwrap();
                }
            }
        });
        calls
    }

    const OWNER_PID: i64 = 111_111;
    const MEMBER_PID: i64 = 222_222;

    fn app_reply(pid: i64, identifier: &str, agents: Value, method: &str) -> Value {
        match method {
            "app.info" => json!({"pid": pid, "identifier": identifier, "jsAgentReady": true, "signInSkipped": true}),
            "app.state" => json!({"processes": agents}),
            "ui.snapshot" => json!({"tree": format!("- button \"{identifier}\" [ref=e1]")}),
            _ => json!({}),
        }
    }

    fn owner_app(method: &str, _: &Value) -> Value {
        app_reply(OWNER_PID, "com.mbadv.ply.test", json!([]), method)
    }

    fn member_app(method: &str, _: &Value) -> Value {
        app_reply(MEMBER_PID, "com.mbadv.ply.test2", json!([{"pid": 9001, "command": "codex", "agent": true}]), method)
    }

    fn call_text(s: &mut Server, name: &str, args: Value) -> (bool, String) {
        let out = call(s, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}));
        (out["result"]["isError"] == true, out["result"]["content"][0]["text"].as_str().unwrap_or("").to_string())
    }

    /// Unix socket paths are short: a temp dir under /tmp, not $TMPDIR.
    fn short_dir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("pt").tempdir_in("/tmp").unwrap()
    }

    #[test]
    fn every_tool_on_an_app_takes_an_instance_and_the_others_do_not() {
        let list = tools_list();
        for tool in list["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            let has = tool["inputSchema"]["properties"].get("instance").is_some();
            let expected = name.starts_with("ui_") || name.starts_with("native_") || name.starts_with("app_") || name == "builder_inject_block" || name == "walk_step";
            assert_eq!(has, expected, "{name}");
        }
    }

    #[test]
    fn each_call_reaches_its_own_instance_and_a_plain_call_the_owner() {
        let dir = short_dir();
        let mut s = server(dir.path());
        let owner = fake(&dir.path().join("root/run"), "bridge", owner_app);
        let member = fake(&dir.path().join("member-root/run"), "bridge", member_app);
        let (bad, why) = call_text(&mut s, "ui_snapshot", json!({}));
        assert!(bad && why.contains("needs instance"), "the member is up: {why}");
        let (_, plain_state) = call_text(&mut s, "app_state", json!({"kind": "processes"}));
        assert!(!plain_state.contains("codex"), "app_* still defaults to the owner: {plain_state}");
        let (_, as_member) = call_text(&mut s, "ui_snapshot", json!({"instance": "member"}));
        assert!(as_member.contains("com.mbadv.ply.test2"), "{as_member}");
        let (_, explicit) = call_text(&mut s, "ui_snapshot", json!({"instance": "owner"}));
        assert!(explicit.contains("com.mbadv.ply.test\""), "{explicit}");
        let snaps = |c: &std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>| c.lock().unwrap().iter().filter(|(m, _)| m == "ui.snapshot").count();
        assert_eq!((snaps(&owner), snaps(&member)), (1, 1));
        let (bad, why) = call_text(&mut s, "ui_snapshot", json!({"instance": "guest"}));
        assert!(bad && why.contains("owner or member"), "{why}");
        let (_, status) = call_text(&mut s, "app_status", json!({"instance": "member"}));
        assert!(status.contains("\"instance\": \"member\"") && status.contains("222222"), "{status}");
        let (_, plain_status) = call_text(&mut s, "app_status", json!({}));
        assert!(!plain_status.contains("instance") && plain_status.contains("111111"), "{plain_status}");
    }

    #[test]
    fn native_tools_and_keys_aim_at_the_instances_own_pid_through_one_helper() {
        let dir = short_dir();
        let mut s = server(dir.path());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        fake(&dir.path().join("member-root/run"), "bridge", member_app);
        let helper = fake(&dir.path().join("root/run"), "helper", |_, _| json!({"tree": "t"}));
        for (name, args) in [
            ("native_snapshot", json!({"instance": "member"})),
            ("ui_key", json!({"keys": "escape", "instance": "member"})),
            ("native_snapshot", json!({"instance": "owner"})),
        ] {
            let (bad, why) = call_text(&mut s, name, args);
            assert!(!bad, "{why}");
        }
        let calls = helper.lock().unwrap();
        let pids: Vec<i64> = calls.iter().filter(|(m, _)| m != "ping").map(|(_, p)| p["pid"].as_i64().unwrap()).collect();
        assert_eq!(pids, vec![MEMBER_PID, MEMBER_PID, OWNER_PID]);
    }

    #[test]
    fn a_members_screenshot_keeps_its_own_name_beside_the_owners() {
        fn helper(method: &str, params: &Value) -> Value {
            if method != "screenshot" {
                return json!({});
            }
            let dir = std::path::PathBuf::from(params["dir"].as_str().unwrap());
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("{}.png", params["name"].as_str().unwrap()));
            std::fs::write(&path, "png").unwrap();
            json!({"files": [{"path": path}]})
        }
        let dir = short_dir();
        let mut s = server(dir.path());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        fake(&dir.path().join("member-root/run"), "bridge", member_app);
        let calls = fake(&dir.path().join("root/run"), "helper", helper);
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": true}));
        let (_, owner) = call_text(&mut s, "ui_screenshot", json!({"name": "board", "instance": "owner"}));
        let (_, member) = call_text(&mut s, "ui_screenshot", json!({"name": "board", "instance": "member"}));
        assert!(owner.ends_with("/board.png"), "{owner}");
        assert!(member.ends_with("/member-board.png"), "{member}");
        let pids: Vec<i64> = calls.lock().unwrap().iter().filter(|(m, _)| m == "screenshot").map(|(_, p)| p["pid"].as_i64().unwrap()).collect();
        assert_eq!(pids, vec![OWNER_PID, MEMBER_PID]);
    }

    #[test]
    fn the_member_has_no_place_on_windows() {
        let dir = short_dir();
        let mut s = server(dir.path());
        let (bad, why) = call_text(&mut s, "app_status", json!({"instance": "member", "target": "windows"}));
        assert!(bad && why.contains("only on the Mac"), "{why}");
        let (_, plain) = call_text(&mut s, "app_status", json!({"target": "windows"}));
        assert!(plain.contains("\"target\": \"windows\"") && !plain.contains("instance"), "{plain}");
        let (bad, why) = call_text(&mut s, "ui_snapshot", json!({"instance": "member"}));
        assert!(bad && why.contains("only on the Mac"), "the target stays windows: {why}");
    }

    #[test]
    fn the_audit_covers_the_member_and_the_report_names_it() {
        let dir = short_dir();
        let mut s = server(dir.path());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        fake(&dir.path().join("member-root/run"), "bridge", member_app);
        call_text(&mut s, "ui_click", json!({"instance": "member", "name": "x", "mode": "dom"}));
        call_text(&mut s, "walk_step", json!({"action": "a", "expected": "b", "verdict": "passato", "evidence": "c"}));
        let (_, done) = call_text(&mut s, "walk_finish", json!({}));
        assert!(done.contains("\"outcome\": \"invalid\""), "the member's codex counts: {done}");
        assert!(done.contains("stillRunning"), "{done}");
        let report = dir.path().join("walks").read_dir().unwrap().next().unwrap().unwrap().path().join("report.json");
        let report: Value = serde_json::from_str(&std::fs::read_to_string(report).unwrap()).unwrap();
        assert_eq!(report["violations"][0]["instance"], "member");
        assert_eq!(report["steps"][0]["instance"], "member");
    }

    #[test]
    fn the_orphan_check_of_a_member_quit_looks_at_its_own_children() {
        fn child_app(method: &str, _: &Value) -> Value {
            let survivor = std::fs::read_to_string(std::env::var("PLY_TEST_FAKE_CHILD").unwrap()).unwrap();
            let survivor: i64 = survivor.trim().parse().unwrap();
            match method {
                // A pid no process has: the app itself is gone at once.
                "app.info" => json!({"pid": 99_999_991, "identifier": "com.mbadv.ply.test2"}),
                "app.state" => json!({"processes": [{"pid": survivor, "command": "gh"}]}),
                _ => json!({}),
            }
        }
        let dir = short_dir();
        let mut s = server(dir.path());
        let mut sleeper = std::process::Command::new("/bin/sleep").arg("20").spawn().unwrap();
        let pid_file = dir.path().join("child");
        std::fs::write(&pid_file, sleeper.id().to_string()).unwrap();
        std::env::set_var("PLY_TEST_FAKE_CHILD", &pid_file);
        fake(&dir.path().join("member-root/run"), "bridge", child_app);
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": true}));
        let (bad, quit) = call_text(&mut s, "app_quit", json!({"instance": "member"}));
        sleeper.kill().unwrap();
        let _ = sleeper.wait();
        assert!(!bad, "{quit}");
        assert!(quit.contains("\"orphans\": [") && quit.contains("\"command\": \"gh\"") && quit.contains("\"instance\": \"member\""), "{quit}");
        call_text(&mut s, "walk_step", json!({"action": "a", "expected": "b", "verdict": "passato", "evidence": "c"}));
        let (_, done) = call_text(&mut s, "walk_finish", json!({}));
        assert!(done.contains("\"outcome\": \"fallito\""), "{done}");
    }

    #[test]
    fn the_member_bundle_comes_from_the_owners_path_and_must_exist_and_be_current() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = dir.path().join("bundle");
        let owner = bundles.join("Plyloft Test.app");
        std::fs::create_dir_all(owner.join("Contents/MacOS")).unwrap();
        std::fs::write(owner.join("Contents/MacOS/atelier"), "o").unwrap();
        let mut s = server(dir.path());
        s.config.app = owner.clone();
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("team: true"), "only in a team walk: {why}");
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false, "team": true}));
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("make-member-app.sh") && why.contains("Plyloft Test Member.app"), "{why}");
        let member = bundles.join("Plyloft Test Member.app");
        std::fs::create_dir_all(member.join("Contents/MacOS")).unwrap();
        let binary = member.join("Contents/MacOS/atelier");
        std::fs::write(&binary, "m").unwrap();
        assert_eq!(s.config.member_app().unwrap(), member);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&binary).unwrap().set_modified(old).unwrap();
        let stale = s.config.member_app().unwrap_err();
        assert!(stale.contains("older") && stale.contains("make-member-app.sh"), "{stale}");
        // Before a running copy would be reused.
        fake_at(&s, "member");
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("older"), "{why}");
    }

    #[test]
    fn the_member_starts_with_its_own_identity_and_a_run_dir_apart() {
        let dir = tempfile::tempdir().unwrap();
        let s = server(dir.path());
        let missing = s.config.member_launch_env().unwrap_err();
        assert!(missing.contains("environment is missing"), "{missing}");
        std::fs::create_dir_all(dir.path().join("member-env/gh")).unwrap();
        std::fs::write(dir.path().join("member-env/gitconfig"), "").unwrap();
        let env = s.config.member_launch_env().unwrap();
        let get = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("PLY_TEST_INSTANCE"), "member");
        assert_eq!(get("PLY_TEST_ROOT"), dir.path().join("member-root").display().to_string());
        assert_eq!(get("GH_CONFIG_DIR"), dir.path().join("member-env/gh").display().to_string());
        assert_eq!(get("GIT_CONFIG_GLOBAL"), dir.path().join("member-env/gitconfig").display().to_string());
        let home = std::path::Path::new("/h");
        assert_eq!(server::member_root_for(None, home), home.join("Library/Application Support/com.mbadv.ply.test2/app-tester"));
        assert_eq!(server::member_root_for(Some(std::path::Path::new("/r")), home), std::path::Path::new("/r/member"));
    }

    #[test]
    fn a_bridge_served_by_the_other_instance_is_refused() {
        use server::{instance_identity_matches as check, Instance};
        assert!(check(Instance::Member, &json!({"identifier": "com.mbadv.ply.test2"})).is_ok());
        assert!(check(Instance::Owner, &json!({"identifier": "com.mbadv.ply.test"})).is_ok());
        assert!(check(Instance::Member, &json!({"identifier": "com.mbadv.ply.test"})).is_err());
        assert!(check(Instance::Owner, &json!({"identifier": "com.mbadv.ply.test2"})).is_err());
    }

    #[test]
    fn accepting_an_invitation_is_only_for_a_walk_and_only_two_repos() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = server(dir.path());
        let (bad, why) = call_text(&mut s, "gh_accept_invitation", json!({"repo": "team"}));
        assert!(bad && why.contains("walk_start"), "{why}");
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        let (bad, why) = call_text(&mut s, "gh_accept_invitation", json!({"repo": "test-owner/other"}));
        assert!(bad && why.contains("sandbox or team"), "{why}");
    }

    #[test]
    fn the_dev_plan_needs_a_run_past_sign_in_and_stays_out_of_the_answers() {
        fn shown(method: &str, _: &Value) -> Value {
            match method {
                "app.info" => json!({"pid": 1, "identifier": "com.mbadv.ply.test", "signInSkipped": false}),
                _ => json!({}),
            }
        }
        let dir = short_dir();
        let mut s = server(dir.path());
        let owner = fake(&dir.path().join("root/run"), "bridge", shown);
        let (bad, why) = call_text(&mut s, "app_dev_team_plan", json!({}));
        assert!(bad && why.contains("walk_start"), "only during a walk: {why}");
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        let (bad, why) = call_text(&mut s, "app_dev_team_plan", json!({}));
        assert!(bad && why.contains("past the Sign-in"), "{why}");
        assert!(!owner.lock().unwrap().iter().any(|(m, _)| m == "account.devLoadEntitlement"));
    }

    /// A member bridge for a test whose bundle check comes first.
    fn fake_at(s: &Server, who: &str) {
        assert_eq!(who, "member");
        fake(&s.config.member_root.join("run"), "bridge", member_app);
    }

    /// A `gh` that answers `api user` with the login in `$GH_CONFIG_DIR/login`
    /// (or `default-login` beside the script with no config) and logs the rest.
    fn fake_gh(dir: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("gh");
        let script = format!(
            "#!/bin/sh\necho \"${{GH_CONFIG_DIR:-default}}|$*\" >> \"{d}/gh.log\"\ncase \"$*\" in\n  'api user --jq .login') if [ -n \"$GH_CONFIG_DIR\" ]; then cat \"$GH_CONFIG_DIR/login\"; else cat \"{d}/default-login\"; fi ;;\n  'api user/repository_invitations?per_page=100') cat \"{d}/invitations\" ;;\n  *) : ;;\nesac\n",
            d = dir.display()
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    fn make_env(env: &std::path::Path, login: &str) {
        std::fs::create_dir_all(env.join("gh")).unwrap();
        std::fs::write(env.join("gitconfig"), "").unwrap();
        std::fs::write(env.join("gh/login"), login).unwrap();
    }

    /// A team walk's server with the member's copy in place. Nothing here
    /// reaches `open`: each test is refused first or reuses a fake bridge.
    fn team_server(dir: &std::path::Path) -> Server {
        let mut s = server(dir);
        let bundles = dir.join("b");
        std::fs::create_dir_all(bundles.join("Plyloft Test Member.app")).unwrap();
        s.config.app = bundles.join("Plyloft Test.app");
        s.config.gh = fake_gh(dir);
        std::fs::write(dir.join("default-login"), "test-owner").unwrap();
        make_env(&dir.join("member-env"), "test-user");
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false, "team": true}));
        s
    }

    #[test]
    fn a_team_launch_refuses_a_gh_that_answers_as_someone_else() {
        let dir = short_dir();
        let mut s = team_server(dir.path());
        std::fs::write(dir.path().join("member-env/gh/login"), "test-owner").unwrap();
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("answers as") && why.contains("test-user"), "{why}");
        make_env(&dir.path().join("owner-env"), "test-user");
        let (bad, why) = call_text(&mut s, "app_launch", json!({}));
        assert!(bad && why.contains("answers as") && why.contains("owner-env"), "{why}");
    }

    #[test]
    fn a_team_launch_refuses_a_profile_that_names_another_login() {
        let dir = short_dir();
        let mut s = team_server(dir.path());
        let profile = s.config.profile(server::Instance::Member);
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("workspaces.json"), r#"{"workspaces":[{"name":"w","githubAccount":"test-owner"}]}"#).unwrap();
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("githubAccount test-owner"), "{why}");
        std::fs::write(profile.join("workspaces.json"), r#"{"workspaces":[{"name":"w","githubAccount":"test-user"}]}"#).unwrap();
        std::fs::write(profile.join("settings.json"), r#"{"team":{"account":"test-owner"}}"#).unwrap();
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("team.account test-owner"), "{why}");
        std::fs::write(profile.join("settings.json"), r#"{"team":{"account":"test-user"}}"#).unwrap();
        assert!(server::profile_names_only(&profile, "test-user").is_ok());
    }

    #[test]
    fn a_running_instance_is_reused_in_a_team_walk_only_if_pinned_with_its_own_clone_root() {
        fn pinned(method: &str, _: &Value) -> Value {
            match method {
                "app.info" => json!({
                    "pid": MEMBER_PID, "identifier": "com.mbadv.ply.test2", "jsAgentReady": true, "signInSkipped": true,
                    "ghConfigDir": std::env::var("PLY_TEST_FAKE_GH_DIR").unwrap(),
                }),
                _ => json!({"processes": []}),
            }
        }
        let dir = short_dir();
        let mut s = team_server(dir.path());
        fake(&s.config.member_root.join("run"), "bridge", member_app);
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("not started with"), "no pin in its info: {why}");
        let other = short_dir();
        let mut s2 = team_server(other.path());
        std::env::set_var("PLY_TEST_FAKE_GH_DIR", s2.config.member_env.join("gh"));
        fake(&s2.config.member_root.join("run"), "bridge", pinned);
        let (bad, why) = call_text(&mut s2, "app_launch", json!({"instance": "member"}));
        assert!(bad && why.contains("no clone root"), "{why}");
        let profile = s2.config.profile(server::Instance::Member);
        server::write_own_clone_root(&profile).unwrap();
        let (bad, out) = call_text(&mut s2, "app_launch", json!({"instance": "member"}));
        assert!(!bad && out.contains("alreadyRunning"), "{out}");
    }

    #[test]
    fn the_clone_root_is_written_once_in_the_profile_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("com.mbadv.ply.test2");
        assert!(!server::clone_root_is_own(&profile).unwrap());
        server::write_own_clone_root(&profile).unwrap();
        assert!(server::clone_root_is_own(&profile).unwrap());
        let file = profile.join("settings.json");
        let fresh: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(fresh["schemaVersion"], 1);
        assert_eq!(fresh["team"]["cloneRoot"], profile.join("team-clones").display().to_string());
        std::fs::write(&file, r#"{"schemaVersion":1,"appearance":{"x":1},"team":{"workMode":"team"}}"#).unwrap();
        server::write_own_clone_root(&profile).unwrap();
        let kept: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(kept["appearance"]["x"], 1);
        assert_eq!(kept["team"]["workMode"], "team");
        assert!(std::fs::read_dir(&profile).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        std::fs::write(&file, r#"{"team":{"cloneRoot":"/Users/x/code"}}"#).unwrap();
        assert!(server::clone_root_is_own(&profile).unwrap_err().contains("/Users/x/code"));
    }

    #[test]
    fn every_launch_sets_the_profiles_own_clone_root_and_only_a_team_walk_refuses_another() {
        for team in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let profile = dir.path().join("com.mbadv.ply.test");
            // A fresh profile, and one with settings but no root: its own.
            server::ensure_own_clone_root(&profile, team).unwrap();
            assert!(server::clone_root_is_own(&profile).unwrap());
            let file = profile.join("settings.json");
            std::fs::write(&file, r#"{"schemaVersion":1,"team":{"workMode":"team"}}"#).unwrap();
            server::ensure_own_clone_root(&profile, team).unwrap();
            assert!(server::clone_root_is_own(&profile).unwrap());
            let foreign = r#"{"team":{"cloneRoot":"/Users/x/code"}}"#;
            std::fs::write(&file, foreign).unwrap();
            let answer = server::ensure_own_clone_root(&profile, team);
            assert_eq!(answer.is_err(), team, "{answer:?}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), foreign, "a foreign value is never overwritten");
        }
    }

    #[test]
    fn the_owner_is_pinned_only_in_a_team_walk_and_only_if_its_env_exists() {
        let dir = short_dir();
        let mut s = team_server(dir.path());
        assert!(s.config.owner_team_env().is_empty());
        assert!(s.config.owner_gh().is_none());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        server::write_own_clone_root(&s.config.profile(server::Instance::Owner)).unwrap();
        let (bad, out) = call_text(&mut s, "app_launch", json!({}));
        assert!(bad && out.contains("make-instance-env"), "an unpinned owner is refused: {out}");
        make_env(&dir.path().join("owner-env"), "test-owner");
        let env = s.config.owner_team_env();
        assert_eq!(env[0], ("GH_CONFIG_DIR".to_string(), dir.path().join("owner-env/gh").display().to_string()));
        assert_eq!(env[1].0, "GIT_CONFIG_GLOBAL");
        let (bad, why) = call_text(&mut s, "app_launch", json!({}));
        assert!(bad && why.contains("not started with"), "a running owner isn't pinned now: {why}");
        // A walk that isn't a team's asks gh nothing and needs no pin.
        let log = dir.path().join("gh.log");
        call_text(&mut s, "walk_finish", json!({}));
        std::fs::remove_file(&log).unwrap();
        call_text(&mut s, "walk_start", json!({"guide": "plain", "allow_agent_tiles": false}));
        let (bad, out) = call_text(&mut s, "app_launch", json!({}));
        assert!(!bad && out.contains("alreadyRunning") && !out.contains("warning"), "{out}");
        assert!(!log.exists());
    }

    #[test]
    fn the_member_may_not_sign_in_and_a_team_walk_stays_on_the_mac() {
        let dir = short_dir();
        let mut s = team_server(dir.path());
        let (bad, why) = call_text(&mut s, "app_launch", json!({"instance": "member", "sign_in": true}));
        assert!(bad && why.contains("sign_in is not for the member"), "{why}");
        call_text(&mut s, "walk_finish", json!({}));
        let (bad, why) = call_text(&mut s, "walk_start", json!({"guide": "t", "allow_agent_tiles": false, "team": true, "target": "windows"}));
        assert!(bad && why.contains("only on the Mac"), "{why}");
    }

    #[test]
    fn instance_is_required_once_the_member_acted_even_after_it_quit() {
        let dir = short_dir();
        let mut s = server(dir.path());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        call_text(&mut s, "walk_start", json!({"guide": "plain", "allow_agent_tiles": false}));
        let (bad, why) = call_text(&mut s, "ui_snapshot", json!({}));
        assert!(!bad, "an owner-only walk names nobody: {why}");
        let (bad, why) = call_text(&mut s, "app_status", json!({"instance": "member"}));
        assert!(!bad, "{why}");
        let (bad, _) = call_text(&mut s, "ui_snapshot", json!({}));
        assert!(!bad, "a status of a closed member isn't taking part");
        fake(&dir.path().join("member-root/run"), "bridge", member_app);
        call_text(&mut s, "ui_snapshot", json!({"instance": "member"}));
        std::fs::remove_file(dir.path().join("member-root/run/bridge.sock")).unwrap();
        let (bad, why) = call_text(&mut s, "native_snapshot", json!({}));
        assert!(bad && why.contains("needs instance"), "{why}");
        let (bad, why) = call_text(&mut s, "ui_snapshot", json!({"instance": "owner"}));
        assert!(!bad, "{why}");
    }

    #[test]
    fn the_audit_lists_a_members_status_check_and_redacts_what_the_agent_reads() {
        fn probing(method: &str, _: &Value) -> Value {
            let line = "/x/codex login status";
            let secret = "/x/claude -p --token abc";
            match method {
                "app.info" => json!({"pid": MEMBER_PID, "identifier": "com.mbadv.ply.test2"}),
                "app.state" => json!({"processes": [
                    {"pid": 7001, "command": "/x/codex", "agent": true, "args": line},
                    {"pid": 7002, "command": "/x/gh", "agent": false},
                    {"pid": 7003, "command": "/x/claude", "agent": false, "args": secret},
                ]}),
                _ => json!({}),
            }
        }
        let dir = short_dir();
        let mut s = server(dir.path());
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        fake(&dir.path().join("member-root/run"), "bridge", probing);
        let (_, state) = call_text(&mut s, "app_state", json!({"instance": "member", "kind": "processes"}));
        assert!(state.contains("--token [redacted]") && !state.contains("abc"), "{state}");
        call_text(&mut s, "ui_snapshot", json!({"instance": "member"}));
        call_text(&mut s, "app_quit", json!({"instance": "member"}));
        call_text(&mut s, "walk_step", json!({"action": "a", "expected": "b", "verdict": "passato", "evidence": "c"}));
        let (_, done) = call_text(&mut s, "walk_finish", json!({}));
        assert!(done.contains("statusProbes") && done.contains("/x/codex login status"), "{done}");
        assert!(!done.contains("\"outcome\": \"invalid\""), "{done}");
    }

    /// An app whose only agent is a real tile, and whose ui.check never says yes.
    fn tile_app(method: &str, _: &Value) -> Value {
        match method {
            "app.info" => json!({"pid": 99_999_992, "identifier": "com.mbadv.ply.test2"}),
            "app.state" => json!({"processes": [{"pid": 7100, "command": "/x/claude", "agent": true, "args": "/x/claude"}]}),
            _ => json!({"met": false}),
        }
    }

    fn outcome_of(s: &mut Server) -> String {
        call_text(s, "walk_step", json!({"action": "a", "expected": "b", "verdict": "passato", "evidence": "c"}));
        call_text(s, "walk_finish", json!({})).1
    }

    /// A `prlctl` that answers like the helper in the VM, by what each line
    /// contains (`case` patterns, first match wins), and keeps its argv and
    /// everything it was sent in `vm.log`.
    fn fake_prlctl(dir: &std::path::Path, answers: &[(&str, &str)]) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("prlctl");
        let cases: String = answers
            .iter()
            .map(|(pattern, result)| format!("    *'{pattern}'*) echo \"{{\\\"id\\\":$id,{result}}}\" ;;\n"))
            .collect();
        let script = format!(
            "#!/bin/sh\necho \"argv: $*\" >> '{log}'\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> '{log}'\n  id=$(printf '%s' \"$line\" | sed 's/^{{\"id\":\\([0-9]*\\).*/\\1/')\n  case \"$line\" in\n{cases}    *) echo \"{{\\\"id\\\":$id,\\\"ok\\\":true,\\\"result\\\":{{}}}}\" ;;\n  esac\ndone\n",
            log = dir.join("vm.log").display(),
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    /// `"ok":true,"result":…` for a shell double-quoted `echo`.
    fn ok(result: Value) -> String {
        format!("\\\"ok\\\":true,\\\"result\\\":{}", result.to_string().replace('"', "\\\""))
    }

    /// A step of the walk of 2026-11-03: what the bridge lists, with the
    /// installed Plyloft (5672) under a WebView2 of the test app (4496).
    fn windows_tree(extra: Vec<Value>) -> Value {
        let mut rows = vec![
            json!({"pid": 4496, "ppid": 5452, "command": "msedgewebview2.exe", "agent": false}),
            json!({"pid": 5672, "ppid": 4496, "command": "atelier.exe", "agent": false}),
            json!({"pid": 11544, "ppid": 5672, "command": "msedgewebview2.exe", "agent": false}),
            json!({"pid": 2192, "ppid": 11544, "command": "msedgewebview2.exe", "agent": false}),
        ];
        rows.extend(extra);
        json!({"processes": rows, "agentCount": 0})
    }

    fn quit_on_windows(dir: &std::path::Path, tree: Value, read: &str, alive: Value) -> Value {
        let info = ok(json!({"pid": 5452, "identifier": "com.mbadv.ply.test", "jsAgentReady": true, "signInSkipped": true}));
        let prlctl = fake_prlctl(
            dir,
            &[
                (r#""method":"ping""#, &ok(json!({"pong": true}))),
                (r#""method":"app.info""#, &info),
                (r#""method":"app.state""#, &ok(tree)),
                (r#""query":"processes""#, read),
                (r#""method":"process.alive""#, &ok(json!({"alive": alive}))),
            ],
        );
        let mut s = server_on(dir, server::Target::Windows, &prlctl);
        let (bad, text) = call_text(&mut s, "app_quit", json!({}));
        assert!(!bad, "{text}");
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn a_windows_quit_leaves_the_installed_plyloft_out_and_still_fails_on_a_real_orphan() {
        let dir = short_dir();
        let orphan = json!({"pid": 77, "ppid": 5452, "command": "claude.exe", "agent": true});
        // The installed app and its WebView2s run on; so does the test app's claude.
        let out = quit_on_windows(
            dir.path(),
            windows_tree(vec![orphan]),
            &ok(json!({"installedPlyloftPids": [5672], "plyloftTest": [], "agentProcesses": []})),
            json!([5672, 11544, 2192, 77]),
        );
        assert_eq!(out["orphans"], json!([{"pid": 77, "command": "claude.exe"}]), "{out}");
        assert_eq!(out["childrenBefore"], 2, "{out}");
        let left: Vec<i64> = out["installedLeftOut"].as_array().unwrap().iter().map(|r| r["pid"].as_i64().unwrap()).collect();
        assert_eq!(left.len(), 3, "{out}");
        for pid in [5672, 11544, 2192] {
            assert!(left.contains(&pid), "{out}");
        }
        assert!(out.get("installedUnread").is_none(), "{out}");
    }

    /// A clock stepped back reads as a reused pid: the link is refused, and the
    /// process is still named, from the bridge and the helper alike.
    #[test]
    fn a_windows_quit_lists_the_links_it_refused_and_whether_they_still_run() {
        let dir = short_dir();
        let mut tree = windows_tree(Vec::new());
        tree["notChildren"] = json!([{"pid": 88, "ppid": 5452, "command": "claude.exe"}]);
        let out = quit_on_windows(
            dir.path(),
            tree,
            &ok(json!({"installedPlyloftPids": [], "agentProcesses": [], "plyloftTest": [
                {"pid": 5452, "notChildren": [
                    {"pid": 88, "ppid": 5452, "exe": "claude.exe", "command": "claude.exe"},
                    {"pid": 99, "ppid": 4496, "command": "gh.exe"}
                ]}
            ]})),
            json!([88]),
        );
        assert_eq!(
            out["notChildren"],
            json!([
                {"pid": 88, "ppid": 5452, "command": "claude.exe", "stillRunning": true},
                {"pid": 99, "ppid": 4496, "command": "gh.exe", "stillRunning": false}
            ]),
            "{out}"
        );
    }

    #[test]
    fn a_windows_quit_that_cant_read_the_installed_pids_leaves_nothing_out_and_says_so() {
        let dir = short_dir();
        let refused = r#"\"ok\":false,\"error\":\"no read\""#;
        let out = quit_on_windows(dir.path(), windows_tree(Vec::new()), refused, json!([]));
        assert_eq!(out["childrenBefore"], 4, "{out}");
        assert_eq!(out["installedUnread"], "no read", "{out}");
        assert_eq!(out["installedLeftOut"], json!([]), "{out}");
        assert_eq!(out["notChildren"], json!([]), "{out}");
    }

    #[test]
    fn a_mac_quit_has_no_installed_fields() {
        let dir = short_dir();
        let mut s = server(dir.path());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        let (bad, text) = call_text(&mut s, "app_quit", json!({}));
        assert!(!bad, "{text}");
        assert!(!text.contains("installedLeftOut") && !text.contains("installedUnread") && !text.contains("notChildren"), "{text}");
    }

    const VM_DEVICE: &str = "0123456789abcdef0123456789abcdef";

    /// A throwaway dev key, in `dir`.
    fn dev_key(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("key.pem");
        let script = "const {generateKeyPairSync:g}=require('crypto');\
            require('fs').writeFileSync(process.argv[1],g('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))";
        assert!(std::process::Command::new("node").args(["-e", script]).arg(&path).status().unwrap().success());
        path
    }

    /// A walk on the VM, whose Plyloft Test answers `info` and `load`.
    fn vm_walk(dir: &std::path::Path, info: Value, load: &str) -> Server {
        let device = ok(json!({"deviceId": VM_DEVICE}));
        let prlctl = fake_prlctl(
            dir,
            &[
                (r#""method":"ping""#, &ok(json!({"pong": true}))),
                (r#""method":"app.info""#, &ok(info)),
                (r#""kind":"account""#, &device),
                (r#""method":"account.devLoadEntitlement""#, load),
            ],
        );
        let mut s = server_on(dir, server::Target::Windows, &prlctl);
        s.config.dev_key = Some(dev_key(dir));
        let (bad, why) = call_text(&mut s, "walk_start", json!({"guide": "g", "allow_agent_tiles": false, "target": "windows"}));
        assert!(!bad, "{why}");
        s
    }

    fn test_app_info() -> Value {
        json!({"pid": 5452, "identifier": "com.mbadv.ply.test", "jsAgentReady": true, "signInSkipped": true})
    }

    fn plan_loaded() -> String {
        ok(json!({"login": "test-user", "plan": "team", "teamRepo": readers::TEAM_REPO, "teamRole": "member", "exp": 5}))
    }

    fn vm_log(dir: &std::path::Path) -> String {
        std::fs::read_to_string(dir.join("vm.log")).unwrap_or_default()
    }

    fn sent_payload(log: &str) -> Value {
        use base64::Engine;
        let line = log.lines().find(|l| l.contains("account.devLoadEntitlement")).expect("the load reached the VM");
        let request: Value = serde_json::from_str(line).unwrap();
        assert_eq!(request["method"], "bridge", "through the relay to the test profile: {line}");
        let token = request["params"]["params"]["token"].as_str().unwrap();
        let body = token.strip_prefix("PLY2-").unwrap().split('.').next().unwrap();
        serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).unwrap()).unwrap()
    }

    #[test]
    fn a_windows_dev_plan_says_who_it_names_and_only_the_token_reaches_the_vm() {
        let dir = short_dir();
        let mut s = vm_walk(dir.path(), test_app_info(), &plan_loaded());
        let (bad, text) = call_text(&mut s, "app_dev_team_plan", json!({"role": "member"}));
        assert!(!bad, "{text}");
        let out: Value = serde_json::from_str(&text).unwrap();
        assert_eq!((&out["plan"], &out["teamRole"], &out["target"]), (&json!("team"), &json!("member"), &json!("windows")), "{out}");
        assert!(out.get("instance").is_none(), "the VM has no second instance: {out}");
        assert!(!text.contains("PLY2-"), "{text}");
        let log = vm_log(dir.path());
        let payload = sent_payload(&log);
        assert_eq!(payload["teamRole"], "member");
        assert_eq!(payload["login"], readers::MEMBER_LOGIN);
        assert_eq!(payload["sub"], "1000002");
        assert_eq!(payload["deviceId"], VM_DEVICE, "minted for the VM's own device");
        assert_eq!(payload["teamRepo"], readers::TEAM_REPO);
        // The key's bytes and path never travel, and the token isn't on prlctl's command line.
        let key = std::fs::read_to_string(dir.path().join("key.pem")).unwrap();
        let body: String = key.lines().filter(|l| !l.starts_with("-----")).collect();
        assert!(!log.contains(&body) && !log.contains("PRIVATE KEY") && !log.contains("key.pem"), "{log}");
        assert!(log.lines().filter(|l| l.starts_with("argv:")).all(|l| !l.contains("PLY2-")), "{log}");
    }

    #[test]
    fn a_windows_dev_plan_can_name_the_owner_or_a_third_login() {
        let dir = short_dir();
        let mut s = vm_walk(dir.path(), test_app_info(), &plan_loaded());
        let (bad, why) = call_text(&mut s, "app_dev_team_plan", json!({"role": "owner"}));
        assert!(!bad, "{why}");
        let payload = sent_payload(&vm_log(dir.path()));
        assert_eq!((&payload["teamRole"], &payload["login"], &payload["sub"]), (&json!("owner"), &json!("test-owner"), &json!("1000001")));

        let dir = short_dir();
        let mut s = vm_walk(dir.path(), test_app_info(), &plan_loaded());
        let (bad, why) = call_text(&mut s, "app_dev_team_plan", json!({"role": "member", "login": "someone-else", "sub": "42"}));
        assert!(!bad, "{why}");
        let payload = sent_payload(&vm_log(dir.path()));
        assert_eq!((&payload["teamRole"], &payload["login"], &payload["sub"]), (&json!("member"), &json!("someone-else"), &json!("42")));
    }

    #[test]
    fn a_windows_dev_plan_refuses_before_anything_is_minted() {
        for (args, words) in [
            (json!({}), "needs role"),
            (json!({"role": "admin"}), "owner or member"),
            (json!({"role": "member", "login": "someone-else"}), "say its sub"),
            (json!({"role": "member", "login": "a b"}), "not a GitHub login"),
            (json!({"role": "member", "login": "someone-else", "sub": "x"}), "account's number"),
            (json!({"role": "member", "instance": "member"}), "only on the Mac"),
        ] {
            let dir = short_dir();
            let mut s = vm_walk(dir.path(), test_app_info(), &plan_loaded());
            let (bad, why) = call_text(&mut s, "app_dev_team_plan", args.clone());
            assert!(bad && why.contains(words), "{args}: {why}");
            assert!(!vm_log(dir.path()).contains("account.devLoadEntitlement"), "{args}");
        }
    }

    #[test]
    fn a_windows_dev_plan_goes_only_to_the_test_profile_past_sign_in() {
        for (info, words) in [
            (json!({"pid": 5672, "identifier": "com.mbadv.ply", "signInSkipped": true}), "served by com.mbadv.ply"),
            (json!({"pid": 5672, "signInSkipped": true}), "doesn't say"),
            (json!({"pid": 5452, "identifier": "com.mbadv.ply.test", "signInSkipped": false}), "past the Sign-in"),
        ] {
            let dir = short_dir();
            let mut s = vm_walk(dir.path(), info.clone(), &plan_loaded());
            let (bad, why) = call_text(&mut s, "app_dev_team_plan", json!({"role": "member"}));
            assert!(bad && why.contains(words), "{info}: {why}");
            assert!(!vm_log(dir.path()).contains("account.devLoadEntitlement"), "{info}");
        }
    }

    #[test]
    fn a_vm_build_that_doesnt_trust_the_dev_key_says_how_and_shows_no_token() {
        let dir = short_dir();
        let refused = r#"\"ok\":false,\"error\":\"This token can't be used here\""#;
        let mut s = vm_walk(dir.path(), test_app_info(), refused);
        let (bad, why) = call_text(&mut s, "app_dev_team_plan", json!({"role": "member"}));
        assert!(bad && why.contains("PLYLOFT_ENTITLEMENT_PUBKEY"), "{why}");
        assert!(!why.contains("PLY2-"), "{why}");
    }

    #[test]
    fn on_the_mac_the_instance_says_who_a_dev_plan_names() {
        let dir = short_dir();
        let mut s = server(dir.path());
        fake(&dir.path().join("root/run"), "bridge", owner_app);
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        for args in [json!({"role": "member"}), json!({"login": "someone"}), json!({"sub": "1"})] {
            let (bad, why) = call_text(&mut s, "app_dev_team_plan", args);
            assert!(bad && why.contains("target windows"), "{why}");
        }
        assert_eq!(
            server::plan_identity(server::Target::Mac, server::Instance::Member, &json!({})).unwrap(),
            ("member", readers::MEMBER_LOGIN.to_string(), "1000002".to_string())
        );
    }

    #[test]
    fn app_quit_audits_the_tree_it_reads() {
        let dir = short_dir();
        let mut s = server(dir.path());
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        fake(&dir.path().join("member-root/run"), "bridge", tile_app);
        let (bad, why) = call_text(&mut s, "app_quit", json!({"instance": "member"}));
        assert!(!bad, "{why}");
        let done = outcome_of(&mut s);
        assert!(done.contains("\"outcome\": \"invalid\""), "{done}");
    }

    #[test]
    fn a_long_wait_samples_while_it_waits() {
        let dir = short_dir();
        let mut s = server(dir.path());
        s.audit_every = std::time::Duration::from_millis(20);
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        let member = fake(&dir.path().join("member-root/run"), "bridge", tile_app);
        let (bad, _) = call_text(&mut s, "ui_wait_for", json!({"instance": "member", "text": "x", "timeout_ms": 300}));
        assert!(bad, "it timed out");
        let looks = member.lock().unwrap().iter().filter(|(m, _)| m == "app.state").count();
        assert!(looks >= 2, "{looks} looks: during the wait, not only after it");
        assert!(outcome_of(&mut s).contains("\"outcome\": \"invalid\""));
    }

    #[test]
    fn a_look_with_no_answer_is_recorded_and_a_closed_app_is_not_one() {
        fn mute(method: &str, _: &Value) -> Value {
            match method {
                "app.state" => json!({"__error": "the page did not answer"}),
                _ => json!({"tree": ""}),
            }
        }
        let dir = short_dir();
        let mut s = server(dir.path());
        call_text(&mut s, "walk_start", json!({"guide": "team", "allow_agent_tiles": false}));
        fake(&dir.path().join("member-root/run"), "bridge", mute);
        let (bad, why) = call_text(&mut s, "ui_snapshot", json!({"instance": "member"}));
        assert!(!bad, "{why}");
        let done = outcome_of(&mut s);
        assert!(done.contains("auditFailedSamples") && done.contains("the page did not answer"), "{done}");
        assert!(!done.contains("\"instance\": \"owner\""), "the owner's app is closed: {done}");
    }

    #[test]
    fn the_read_only_list_matches_the_tools_own_hints() {
        for tool in tools_list()["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            if server::targets_instance(name) {
                assert_eq!(server::is_read_only(name), tool["annotations"]["readOnlyHint"] == true, "{name}");
            }
        }
    }

    #[test]
    fn the_action_log_says_whether_an_invitation_was_accepted() {
        let dir = short_dir();
        let mut s = team_server(dir.path());
        let repo = readers::TEAM_REPO;
        std::fs::write(dir.path().join("invitations"), "[]").unwrap();
        call_text(&mut s, "gh_accept_invitation", json!({"repo": "team"}));
        std::fs::write(dir.path().join("invitations"), format!(r#"[{{"id":42,"repository":{{"full_name":"{repo}"}}}}]"#)).unwrap();
        call_text(&mut s, "gh_accept_invitation", json!({"repo": "team"}));
        let walks = dir.path().join("walks").read_dir().unwrap().next().unwrap().unwrap().path();
        let log = std::fs::read_to_string(walks.join("actions.jsonl")).unwrap();
        let lines: Vec<Value> = log.lines().map(|l| serde_json::from_str(l).unwrap()).filter(|l: &Value| l["tool"] == "gh_accept_invitation").collect();
        assert_eq!(lines[0]["detail"]["accepted"], false);
        assert_eq!(lines[1]["detail"]["accepted"], true);
        assert_eq!(lines[1]["detail"]["invitation"], 42);
    }

    #[test]
    fn a_walk_runs_start_to_report_without_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = server(dir.path());
        let tool = |s: &mut Server, name: &str, args: Value| {
            call(s, json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": name, "arguments": args}}))
        };
        let missing = tool(&mut s, "walk_start", json!({"guide": "PPVP x"}));
        assert_eq!(missing["result"]["isError"], true, "allow_agent_tiles is required");
        std::fs::create_dir_all(dir.path().join("root/run")).unwrap();
        std::fs::write(dir.path().join("root/run/stop"), "x").unwrap();
        let started = tool(&mut s, "walk_start", json!({"guide": "PPVP x", "allow_agent_tiles": false}));
        assert_eq!(started["result"]["isError"], false);
        assert!(!dir.path().join("root/run/stop").exists(), "a new walk clears the stop");
        let step = tool(&mut s, "walk_step", json!({"action": "open", "expected": "shown", "verdict": "non verificabile", "evidence": "app not running"}));
        assert_eq!(step["result"]["isError"], false);
        let done = tool(&mut s, "walk_finish", json!({"summary": "s"}));
        let text = done["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("report.md"));
    }
}
