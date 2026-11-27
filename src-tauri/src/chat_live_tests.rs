//! LIVE tests of the card chat, run **by hand only, with the owner's
//! approval**: they drive the installed `claude` (the member's Max login) and
//! `codex` (ChatGPT login) through `ChatRegistry`, with the real read-only
//! argv. Both are `#[ignore]` and do nothing unless `PLY_CHAT_LIVE=1`.
//!
//! ```text
//! cd src-tauri && PLY_CHAT_LIVE=1 CARGO_TARGET_DIR=$HOME/ply-build/n17-chat \
//!   cargo test --lib chat::live_tests -- --ignored --nocapture --test-threads=1
//! ```
//!
//! - Claude runs in a plain folder under the **Plyloft Test** profile's
//!   session root, `~/Library/Application Support/com.mbadv.ply.test/
//!   claude-sessions/chats-live/<run>/claude/`, trusted by inheritance. A
//!   trust question is never answered: the chat stops at it and the step
//!   fails.
//! - The chat's own records and attachments (a small PNG and a 3-page PDF
//!   these tests make) go to a temporary folder, not the test profile.
//! - Claude: at most 5 turns (ONE, TWO, the attachments, the interrupted
//!   count, the `!` message). Codex: 1 turn (a `localImage`).
//! - Every step prints PASS / FAIL / SKIP and writes it to
//!   `~/ply-build/chat-live/<run>.log`; every screen decision (the grid's
//!   rows, whether the composer read idle) goes to
//!   `~/ply-build/chat-live/<run>-screens.log`.

use super::*;
use std::io::Write as _;

const TURN_TIMEOUT: Duration = Duration::from_secs(180);

struct Report {
    log: PathBuf,
    failed: Vec<String>,
}

impl Report {
    fn line(&mut self, verdict: &str, step: &str, detail: &str) {
        let line = format!("{verdict:<4} {step}: {detail}");
        println!("{line}");
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let _ = writeln!(file, "{line}");
        }
        if verdict == "FAIL" {
            self.failed.push(step.to_string());
        }
    }

    fn check(&mut self, step: &str, ok: bool, detail: &str) -> bool {
        self.line(if ok { "PASS" } else { "FAIL" }, step, detail);
        ok
    }
}

fn enabled() -> bool {
    if std::env::var("PLY_CHAT_LIVE").ok().as_deref() == Some("1") {
        return true;
    }
    println!("skipped: set PLY_CHAT_LIVE=1 to run the live chat test (a real claude / codex, the owner's login)");
    false
}

fn run_id() -> String {
    format!("run-{}", now_ms())
}

fn live_dirs(run: &str) -> (PathBuf, PathBuf, PathBuf) {
    let home = crate::platform::home_dir().expect("home");
    let logs = home.join("ply-build").join("chat-live");
    std::fs::create_dir_all(&logs).unwrap();
    let profile = home.join("Library/Application Support/com.mbadv.ply.test");
    (profile.join("claude-sessions").join("chats-live"), logs.join(format!("{run}.log")), logs.join(format!("{run}-screens.log")))
}

/// A 32 × 32 PNG: the left half red, the right half blue.
fn png() -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for byte in bytes {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    }
    let (w, h) = (32u32, 32u32);
    let mut raw = Vec::new();
    for _ in 0..h {
        raw.push(0);
        for x in 0..w {
            raw.extend_from_slice(if x < w / 2 { &[220, 30, 30] } else { &[30, 60, 220] });
        }
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).unwrap();
    let idat = encoder.finish().unwrap();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn wait_for(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + timeout;
    while Instant::now() < until {
        if ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn status(registry: &ChatRegistry, ws: &str, card: &str) -> (ChatStatus, Option<String>) {
    let slot = registry.slot(ws, card).unwrap();
    let slot = slot.lock();
    (slot.status, slot.reason.clone())
}

/// Ready, or Stopped (with why).
fn wait_turn(registry: &ChatRegistry, ws: &str, card: &str) -> Result<(), String> {
    let mut last = (ChatStatus::Working, None);
    let done = wait_for(TURN_TIMEOUT, || {
        last = status(registry, ws, card);
        matches!(last.0, ChatStatus::Ready | ChatStatus::Stopped)
    });
    match (done, last) {
        (true, (ChatStatus::Ready, _)) => Ok(()),
        (true, (_, reason)) => Err(format!("the chat stopped: {}", reason.unwrap_or_default())),
        (false, (state, _)) => Err(format!("no end of turn in {} s (still {state:?})", TURN_TIMEOUT.as_secs())),
    }
}

/// The assistant text after the user message `id`.
fn answer_after(registry: &ChatRegistry, ws: &str, card: &str, id: &str) -> String {
    let chat = registry.messages(ws, card, None, None).unwrap();
    let Some(at) = chat.messages.iter().position(|m| m.id == id) else { return String::new() };
    chat.messages[at + 1..]
        .iter()
        .filter(|m| m.role == "assistant")
        .map(|m| m.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

fn roles_after(registry: &ChatRegistry, ws: &str, card: &str, id: &str) -> Vec<String> {
    let chat = registry.messages(ws, card, None, None).unwrap();
    let Some(at) = chat.messages.iter().position(|m| m.id == id) else { return Vec::new() };
    chat.messages[at + 1..].iter().map(|m| m.role.clone()).collect()
}

/// A send, retried while Claude's composer isn't idle yet (up to 15 s).
fn send_when_idle(
    registry: &ChatRegistry,
    app: &tauri::App<tauri::test::MockRuntime>,
    pty: &crate::pty::PtyRegistry,
    ws: &str,
    card: &str,
    text: &str,
    attachments: &[String],
) -> Result<ChatMessage, String> {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        match registry.send(app.handle(), pty, ws, card, ChatContext::default(), text, attachments) {
            Err(error) if error.contains("isn't at its prompt") && Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(500));
            }
            other => return other,
        }
    }
}

fn gone(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    wait_for(Duration::from_secs(10), || unsafe { libc::kill(pid as i32, 0) } == -1)
}

#[test]
#[ignore]
fn live_claude_chat_through_the_registry() {
    if !enabled() {
        return;
    }
    crate::shell_env::init();
    let run = run_id();
    let (chat_root, log, screens) = live_dirs(&run);
    let mut report = Report { log: log.clone(), failed: Vec::new() };
    println!("log: {}\nscreens: {}", log.display(), screens.display());
    if !chat_root.parent().is_some_and(Path::is_dir) {
        report.line("FAIL", "setup", &format!("no Plyloft Test session root at {}", chat_root.parent().unwrap().display()));
        panic!("live test failed: {:?}", report.failed);
    }
    let records = tempfile::tempdir().unwrap();
    let registry = ChatRegistry::with(
        records.path().to_path_buf(),
        ChatLimits::default(),
        ChatOverrides { chat_root: Some(chat_root.clone()), screen_log: Some(screens.clone()), ..ChatOverrides::default() },
    );
    let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let pty = crate::pty::PtyRegistry::default();
    let (ws, card) = (run.as_str(), "claude");
    let folder = chat_root.join(ws).join(card);
    report.line("INFO", "folder", &folder.display().to_string());

    let opened = registry.open(ws, card, ChatVendor::Claude);
    report.check("0 open", opened.as_ref().is_ok_and(|s| s.status == ChatStatus::Idle), &format!("{:?}", opened.map(|s| s.status)));

    // 1: a new session, the first message as its prompt.
    let step = "1 first turn (prompt)";
    let one = registry.send(app.handle(), &pty, ws, card, ChatContext::default(), "Reply with exactly ONE.", &[]);
    let one_ok = match &one {
        Err(error) => report.check(step, false, error),
        Ok(message) => match wait_turn(&registry, ws, card) {
            Err(error) => report.check(step, false, &error),
            Ok(()) => {
                let answer = answer_after(&registry, ws, card, &message.id);
                report.check(step, answer.contains("ONE"), &format!("answer {answer:?}"))
            }
        },
    };

    if one_ok {
        // 2: a paste, once the composer reads idle on the grid.
        let step = "2 second turn (paste at the idle composer)";
        match send_when_idle(&registry, &app, &pty, ws, card, "Reply with exactly TWO.", &[]) {
            Err(error) => {
                report.check(step, false, &error);
            }
            Ok(message) => match wait_turn(&registry, ws, card) {
                Err(error) => {
                    report.check(step, false, &error);
                }
                Ok(()) => {
                    let answer = answer_after(&registry, ws, card, &message.id);
                    report.check(step, answer.contains("TWO"), &format!("answer {answer:?}"));
                }
            },
        }

        // 3: attachments — quoted paths, Read, --add-dir.
        let step = "3 attachments (PNG + 3-page PDF)";
        let pdf = crate::chat_extract::test_files::pdf(&["Page one names APPLE", "Page two names BANANA", "Page three names CHERRY"]);
        let ids: Result<Vec<String>, String> = [("square.png", png()), ("three pages.pdf", pdf)]
            .into_iter()
            .map(|(name, bytes)| registry.attachment_add(ws, card, name, &bytes).map(|a| a.id))
            .collect();
        match ids {
            Err(error) => {
                report.check(step, false, &format!("attach: {error}"));
            }
            Ok(ids) => match send_when_idle(
                &registry,
                &app,
                &pty,
                ws,
                card,
                "Describe the attached image in 5 words, then say which fruit page two of the PDF names.",
                &ids,
            ) {
                Err(error) => {
                    report.check(step, false, &error);
                }
                Ok(message) => match wait_turn(&registry, ws, card) {
                    Err(error) => {
                        report.check(step, false, &error);
                    }
                    Ok(()) => {
                        let answer = answer_after(&registry, ws, card, &message.id);
                        let banana = answer.to_lowercase().contains("banana");
                        report.check(step, !answer.trim().is_empty(), &format!("banana named: {banana}; answer {answer:?}"));
                    }
                },
            },
        }

        // 4: Stop (Esc) mid-turn: interrupted, then Ready.
        let step = "4 interrupt (Esc)";
        match send_when_idle(&registry, &app, &pty, ws, card, "Count from 1 to 300 slowly, one per line.", &[]) {
            Err(error) => {
                report.check(step, false, &error);
            }
            Ok(message) => {
                let started = Instant::now();
                let mut why = "an assistant entry";
                let open = wait_for(Duration::from_secs(60), || {
                    let turn_open = registry.slot(ws, card).unwrap().lock().turn_open;
                    let has_text = roles_after(&registry, ws, card, &message.id).iter().any(|r| r == "assistant");
                    if turn_open && !has_text && started.elapsed() >= Duration::from_secs(4) {
                        why = "4 s of an open turn";
                        return true;
                    }
                    turn_open && has_text
                });
                if !open {
                    let state = status(&registry, ws, card).0;
                    report.line("SKIP", step, &format!("the turn never showed as open (status {state:?}): it may have ended first"));
                } else {
                    let _ = registry.interrupt(ws, card);
                    let interrupted = wait_for(Duration::from_secs(30), || {
                        roles_after(&registry, ws, card, &message.id).iter().any(|r| r == "interrupted")
                    });
                    let ready = wait_turn(&registry, ws, card);
                    report.check(
                        step,
                        interrupted && ready.is_ok(),
                        &format!("Esc after {why}; interrupted entry: {interrupted}; then {ready:?}"),
                    );
                }
            }
        }

        // 5: a message starting with `!` never runs a shell command.
        let step = "5 ! message runs no command";
        let bang = folder.join("bang.txt");
        let _ = std::fs::remove_file(&bang);
        match send_when_idle(&registry, &app, &pty, ws, card, &format!("!echo pwned > \"{}\"", bang.display()), &[]) {
            Err(error) => {
                report.check(step, false, &error);
            }
            Ok(_) => {
                let ended = wait_turn(&registry, ws, card);
                let shell = registry.messages(ws, card, None, None).unwrap().messages.iter().any(|m| m.role == "shell");
                report.check(
                    step,
                    !bang.exists() && !shell,
                    &format!("bang.txt exists: {}; shell item: {shell}; turn {ended:?}", bang.exists()),
                );
            }
        }
    }

    // 6: close: no claude left.
    let step = "6 close, no process left";
    let pid = registry.claude_pid(ws, card);
    let _ = registry.close(ws, card);
    match pid {
        Some(pid) => {
            report.check(step, gone(pid), &format!("pid {pid}"));
        }
        None => report.line("SKIP", step, "no live session to close"),
    }
    registry.kill_all();
    pty.kill_all();
    let usage = registry.messages(ws, card, None, None).map(|s| s.usage).unwrap_or_default();
    report.line("INFO", "tokens", &format!("{usage:?}"));
    report.line("INFO", "result", if report.failed.is_empty() { "ALL PASS" } else { "SOME FAILED" });
    assert!(report.failed.is_empty(), "live test failed: {:?} (log {})", report.failed, log.display());
}

#[test]
#[ignore]
fn live_codex_chat_one_turn_with_a_local_image() {
    if !enabled() {
        return;
    }
    crate::shell_env::init();
    let run = run_id();
    let (chat_root, log, screens) = live_dirs(&run);
    let mut report = Report { log: log.clone(), failed: Vec::new() };
    println!("log: {}", log.display());
    let records = tempfile::tempdir().unwrap();
    let registry = ChatRegistry::with(
        records.path().to_path_buf(),
        ChatLimits::default(),
        ChatOverrides { chat_root: Some(chat_root), screen_log: Some(screens), ..ChatOverrides::default() },
    );
    let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let pty = crate::pty::PtyRegistry::default();
    let (ws, card) = (run.as_str(), "codex");
    let step = "codex one turn with localImage";
    let outcome = registry
        .open(ws, card, ChatVendor::Codex)
        .and_then(|_| registry.attachment_add(ws, card, "square.png", &png()))
        .and_then(|image| {
            registry.send(app.handle(), &pty, ws, card, ChatContext::default(), "Describe the attached image in 5 words.", &[image.id])
        });
    match outcome {
        Err(error) => {
            report.check(step, false, &error);
        }
        Ok(message) => match wait_turn(&registry, ws, card) {
            Err(error) => {
                report.check(step, false, &error);
            }
            Ok(()) => {
                let answer = answer_after(&registry, ws, card, &message.id);
                let usage = registry.messages(ws, card, None, None).map(|s| s.usage).unwrap_or_default();
                report.check(step, !answer.trim().is_empty(), &format!("answer {answer:?}; tokens {usage:?}"));
            }
        },
    }
    let _ = registry.close(ws, card);
    registry.kill_all();
    report.line("INFO", "result", if report.failed.is_empty() { "ALL PASS" } else { "SOME FAILED" });
    assert!(report.failed.is_empty(), "live test failed: {:?} (log {})", report.failed, log.display());
}
