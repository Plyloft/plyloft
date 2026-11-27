//! 1.176.3 phase 1 (REV-F1-round2.md, walk OFFSCREEN-WALK.md): a dev-only
//! capture of every live Builder session's screen, as the backend's grid
//! draws it (`builder_screens.rs`), with the verdict the not-yet-used
//! judgement (`builder_screen_judge.rs`) would give and why — the evidence
//! phase 2 needs before that judgement may decide anything.
//!
//! **Privacy.** A screen holds whatever the session shows: the person's
//! prompts, the CLI's answers, file contents, paths. So this exists only in a
//! test-bridge build (`lib.rs` compiles it only with the `test-bridge`
//! feature in a debug build, as `test_bridge.rs`), runs only under the test
//! identifiers (`com.mbadv.ply.test`, `.test2`), and writes only inside that
//! profile, under `<app config dir>/app-tester/screens/` — never under
//! `$PLY_TEST_ROOT`, never to the log (the log gets a count and a folder),
//! never anywhere a release can reach.
//!
//! Only reads: no PTY is written, resized, spawned or killed, and nothing is
//! ever typed into a session, live or ended.
//!
//! Two ways to ask, both answered by [`capture`]:
//! - the test bridge's `app.state` with `kind: "builderScreens"` (the label
//!   in `label`, or in `workspace`, the field the ply-test MCP passes on);
//! - a file drop: write `capture.request` into the screens folder (its text:
//!   `<label> [running|asking|idle|unknown]`); a watcher looks every second,
//!   takes it by renaming it away, captures, and writes the summary to
//!   `capture.done.json` (temp file, then rename). Nothing is taken while
//!   the walk's emergency stop (`<test root>/run/stop`) is there.

use crate::builder::BuilderRegistry;
use crate::builder_screen_judge::{judge, off_screen_state, render_frame_file, Verdict};
use crate::pty::PtyRegistry;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The file a walk drops to ask for a capture.
pub(crate) const REQUEST_FILE: &str = "capture.request";
/// What the last file-drop capture wrote (its summary, no screen text).
pub(crate) const DONE_FILE: &str = "capture.done.json";
/// Frames per session per capture, [`FRAME_GAP`] apart: enough to see
/// Codex's composer animate (it redraws every ~400 ms) and a timer tick.
const FRAMES: usize = 3;
const FRAME_GAP: Duration = Duration::from_millis(450);
const POLL: Duration = Duration::from_secs(1);
/// A request longer than this is not read (only its arrival counts).
const REQUEST_MAX: u64 = 512;
/// A request this young may still be being written: taken at the next look.
const REQUEST_SETTLE: Duration = Duration::from_millis(200);
/// Where a request is renamed to before it is read.
const TAKEN_FILE: &str = "capture.request.taken";

static STOP: AtomicBool = AtomicBool::new(false);

/// Where captures land: inside the test profile, whatever `$PLY_TEST_ROOT` says.
pub(crate) fn screens_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("app-tester").join("screens")
}

/// `<label> [verdict]` → (a file-safe label, the verdict the walk says the
/// screen is in, if it said one).
pub(crate) fn parse_request(text: &str) -> (String, Option<Verdict>) {
    let mut words = text.split_whitespace();
    let label = words.next().map(slug).filter(|l| !l.is_empty()).unwrap_or_else(|| "capture".into());
    (label, words.next().and_then(Verdict::parse))
}

/// The request file's text: UTF-8, or UTF-16 LE as PowerShell 5's `>` writes it.
pub(crate) fn request_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)).into_owned()
}

/// Letters, digits, `.`, `_` and `-`; anything else `-`; at most 60.
pub(crate) fn slug(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' })
        .take(60)
        .collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Captures every live Builder session (on screen or not) [`FRAMES`] times
/// into a new folder under [`screens_dir`]: one frame file per session per
/// frame, in the fixtures' format. Returns the folder and, per frame, the
/// verdict — never the rows.
pub(crate) fn capture(app: &AppHandle, label: &str, expect: Option<Verdict>) -> Result<Value, String> {
    if let Some(refusal) = crate::test_bridge::refusal_for_identifier(&app.config().identifier) {
        return Err(refusal);
    }
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f").to_string();
    let dir = screens_dir(&config_dir).join(format!("{stamp}-{label}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let registry = app.state::<BuilderRegistry>();
    let pty = app.state::<PtyRegistry>();
    let version = app.package_info().version.to_string();
    let mut frames = Vec::new();
    for n in 1..=FRAMES {
        if n > 1 {
            std::thread::sleep(FRAME_GAP);
        }
        let sources = registry.screen_sources(&HashSet::new());
        registry.screens.keep_only(&sources.iter().map(|s| s.pty_id.as_str()).collect());
        let now = now_ms();
        for src in &sources {
            let exited = pty.exited(&src.pty_id);
            let frame = registry.screens.frame(src, pty.size(&src.pty_id), now);
            let judged = judge(&src.vendor, &frame.rows);
            let (state, why) = off_screen_state(judged.verdict, exited, frame.content_changed_at, (src.last_output_at > 0).then_some(src.last_output_at), crate::builder_screen_judge::turn_done_above_composer(&src.vendor, &frame.rows), now);
            let ago = |at: Option<i64>| at.map_or("never".to_string(), |at| (now - at).to_string());
            let header: Vec<(&str, String)> = vec![
                ("expect", expect.map_or("?".into(), |v| v.as_str().into())),
                ("judged", judged.verdict.as_str().into()),
                ("reasons", judged.reasons.join(" | ")),
                ("off-screen", format!("{} ({why})", state.as_str())),
                ("vendor", src.vendor.clone()),
                ("key", src.key.clone()),
                ("label", label.into()),
                ("platform", std::env::consts::OS.into()),
                ("app-version", version.clone()),
                ("captured-at", chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                ("frame", format!("{n} of {FRAMES}, {} ms apart", FRAME_GAP.as_millis())),
                ("size", format!("{} rows x {} cols", frame.size.0, frame.size.1)),
                ("cursor", format!("row {}, col {}, {}", frame.cursor.0, frame.cursor.1, if frame.cursor_hidden { "hidden" } else { "shown" })),
                ("alternate-screen", frame.alternate_screen.to_string()),
                ("exited", exited.to_string()),
                ("last-output-ago-ms", ago((src.last_output_at > 0).then_some(src.last_output_at))),
                ("content-changed-ago-ms", ago(frame.content_changed_at)),
                ("source", "capture (phase 1: the judgement decides nothing yet)".into()),
            ];
            let name = format!("{}-{}-f{n}.txt", slug(&src.vendor), slug(&src.key));
            let path = dir.join(&name);
            std::fs::write(&path, render_frame_file(&header, &frame.rows)).map_err(|e| format!("write {}: {e}", path.display()))?;
            frames.push(json!({
                "key": src.key, "vendor": src.vendor, "frame": n, "judged": judged.verdict.as_str(),
                "offScreen": state.as_str(), "exited": exited, "file": name,
            }));
        }
    }
    log::info!("screen capture {label}: {} frame files in {}", frames.len(), dir.display());
    Ok(json!({ "dir": dir, "frames": frames, "note": if frames.is_empty() { "no live Builder session" } else { "" } }))
}

/// Starts the file-drop watcher (called from `test_bridge::start`, after the
/// identifier check). It ends with [`stop`] or the app.
pub(crate) fn start_watch(app: &AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else { return };
    let dir = screens_dir(&config_dir);
    let stop_file = crate::test_bridge::test_root(&config_dir).join("run").join("stop");
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("screen-capture".into()).spawn(move || {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return log::error!("screen capture: create {}: {e}", dir.display());
        }
        while !STOP.load(Ordering::SeqCst) {
            std::thread::sleep(POLL);
            // The walk's emergency stop (`run/stop`, docs/app-tester/DESIGN.md)
            // holds the file drop too: nothing is captured while it is there.
            if stop_file.exists() {
                continue;
            }
            let Some(text) = take_request(&dir) else { continue };
            let (label, expect) = parse_request(&text);
            let summary = capture(&app, &label, expect).unwrap_or_else(|e| json!({ "error": e }));
            if let Err(e) = write_replacing(&dir.join(DONE_FILE), &serde_json::to_vec_pretty(&summary).unwrap_or_default()) {
                log::warn!("screen capture: {e}");
            }
        }
    });
    if let Err(e) = spawned {
        log::error!("screen capture: spawn: {e}");
    }
}

/// Review p1 MF3: takes a request whole, or not at all. A request younger
/// than [`REQUEST_SETTLE`] may still be being written and waits; it is then
/// renamed away before it is read, and only a request that could be renamed
/// is answered — so a file another process holds open (Windows: the writer,
/// Defender, the indexer) is never answered once a second.
pub(crate) fn take_request(dir: &Path) -> Option<String> {
    let request = dir.join(REQUEST_FILE);
    let modified = std::fs::metadata(&request).ok()?.modified().ok()?;
    if modified.elapsed().map_or(true, |age| age < REQUEST_SETTLE) {
        return None;
    }
    let taken = dir.join(TAKEN_FILE);
    std::fs::rename(&request, &taken).ok()?;
    let text = match std::fs::metadata(&taken) {
        Ok(meta) if meta.len() <= REQUEST_MAX => std::fs::read(&taken).map(|b| request_text(&b)).unwrap_or_default(),
        _ => String::new(),
    };
    let _ = std::fs::remove_file(&taken);
    Some(text)
}

/// Writes `path` whole: a temp file next to it, then a rename over it, so a
/// reader never sees half of it.
pub(crate) fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Called from `test_bridge::stop` at `ExitRequested`.
pub(crate) fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_names_a_label_and_maybe_the_truth() {
        assert_eq!(parse_request("codex-idle idle\r\n"), ("codex-idle".into(), Some(Verdict::Idle)));
        assert_eq!(parse_request("claude mid turn"), ("claude".into(), None));
        assert_eq!(parse_request(""), ("capture".into(), None));
        assert_eq!(parse_request("../../etc running"), ("..-..-etc".into(), Some(Verdict::Running)));
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("w1 asking\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        assert_eq!(parse_request(&request_text(&utf16)), ("w1".into(), Some(Verdict::Asking)));
        assert_eq!(request_text(b"\xEF\xBB\xBFx"), "x");
    }

    #[test]
    fn a_request_is_taken_whole_once_and_the_summary_replaced_whole() {
        let dir = std::env::temp_dir().join(format!("ply-capture-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(take_request(&dir), None, "no request");
        std::fs::write(dir.join(REQUEST_FILE), "w1 idle").unwrap();
        // Too young: it may still be being written.
        assert_eq!(take_request(&dir), None);
        std::thread::sleep(REQUEST_SETTLE + Duration::from_millis(50));
        assert_eq!(take_request(&dir).as_deref(), Some("w1 idle"));
        assert!(!dir.join(REQUEST_FILE).exists() && !dir.join(TAKEN_FILE).exists());
        assert_eq!(take_request(&dir), None, "answered once");
        write_replacing(&dir.join(DONE_FILE), b"{}").unwrap();
        write_replacing(&dir.join(DONE_FILE), b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(DONE_FILE)).unwrap(), "{\"a\":1}");
        assert!(!dir.join("capture.done.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn captures_stay_inside_the_profile() {
        let dir = screens_dir(Path::new("/p/com.mbadv.ply.test"));
        assert_eq!(dir, Path::new("/p/com.mbadv.ply.test/app-tester/screens"));
        assert!(!slug("a/b\\c").contains(['/', '\\']));
    }
}
