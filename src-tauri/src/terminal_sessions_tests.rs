//! Terminals block P1: the sessions record. Tier 2 (a file without the
//! later fields loads; unknown keys survive; a newer file is never written
//! over; an unparseable one is left alone) and the rules around it.

use super::terminal_sessions::*;
use serde_json::json;

/// The live links are one process-wide map: the tests that use them run one
/// at a time.
fn serial() -> parking_lot::MutexGuard<'static, ()> {
    // Shared with Compare's tests, which link tiles too.
    serial_for_tests()
}

fn row(id: &str, started_at: i64) -> SessionRow {
    SessionRow {
        id: id.into(),
        pty_id: None,
        kind: SessionKind::Claude,
        cwd: "/p".into(),
        cli_session_id: None,
        started_at,
        ended_at: None,
        title: None,
        title_source: None,
        resumed_from: None,
        passed_name: None,
        open_at_quit: None,
        account: None,
        extra: Default::default(),
    }
}

#[test]
fn a_file_without_the_later_fields_loads_and_unknown_keys_survive() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_for(dir.path(), "ws");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // A v0 shape: no version, a row with only the required keys, plus keys a
    // newer Plyloft might add.
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "sessions": [{ "id": "r1", "kind": "codex", "cwd": "/p", "startedAt": 5, "futureKey": [1, 2] }],
            "futureTop": "x"
        }))
        .unwrap(),
    )
    .unwrap();
    let loaded = load(&path);
    assert!(loaded.writable);
    assert_eq!(loaded.file.version, VERSION);
    let r = &loaded.file.sessions[0];
    assert_eq!(r.kind, SessionKind::Codex);
    assert_eq!(r.ended_at, None);
    assert_eq!(r.title_source, None);
    assert_eq!(r.passed_name, None, "Reviewer round 2's field defaults");
    assert_eq!(r.open_at_quit, None, "QoL 1.168's field defaults");
    // Round trip keeps the unknown keys.
    let back = serde_json::to_value(&loaded.file).unwrap();
    assert_eq!(back["futureTop"], "x");
    assert_eq!(back["sessions"][0]["futureKey"], json!([1, 2]));
}

#[test]
fn a_newer_plyloft_s_file_is_not_written_over_and_an_unparseable_one_is_set_aside() {
    let _serial = serial();
    let dir = tempfile::tempdir().unwrap();
    let newer = path_for(dir.path(), "a");
    std::fs::create_dir_all(newer.parent().unwrap()).unwrap();
    std::fs::write(&newer, br#"{"version": 99, "sessions": []}"#).unwrap();
    assert!(!load(&newer).writable);
    assert!(record_start(dir.path(), "a", "pty-a", SessionKind::Claude, "/p", None).is_err());
    assert_eq!(std::fs::read_to_string(&newer).unwrap(), r#"{"version": 99, "sessions": []}"#);

    // Challenger round 1: one that doesn't parse is set aside at the next
    // write, and the record starts again (never stuck).
    let broken = path_for(dir.path(), "b");
    std::fs::create_dir_all(broken.parent().unwrap()).unwrap();
    std::fs::write(&broken, b"{ not json").unwrap();
    let loaded = load(&broken);
    assert!(loaded.unreadable && !loaded.writable);
    let id = record_start(dir.path(), "b", "pty-b", SessionKind::Claude, "/p", None).unwrap();
    assert_eq!(load(&broken).file.sessions.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [id]);
    let aside: Vec<Vec<u8>> = std::fs::read_dir(broken.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("terminal_sessions.json.unreadable-"))
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    assert_eq!(aside, [b"{ not json".to_vec()]);
    record_end("pty-b");
}

#[test]
fn rows_older_than_the_window_go_and_at_most_max_rows_stay() {
    let day = 24 * 60 * 60 * 1000;
    let now = 100 * day;
    let mut rows = vec![row("old", now - 29 * day), row("in", now - 27 * day)];
    prune(&mut rows, now, &Default::default());
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["in"]);
    // A tile still running keeps its row, however long it has run.
    let mut rows = vec![row("running", now - 40 * day), row("ended-long-ago", now - 40 * day)];
    rows[1].ended_at = Some(now - 39 * day);
    let live: std::collections::HashSet<String> = ["running".to_string(), "ended-long-ago".to_string()].into();
    prune(&mut rows, now, &live);
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["running"]);
    let mut many: Vec<SessionRow> = (0..MAX_ROWS + 3).map(|i| row(&i.to_string(), now - i as i64)).collect();
    prune(&mut many, now, &Default::default());
    assert_eq!(many.len(), MAX_ROWS);
    assert!(many.iter().all(|r| r.id.parse::<usize>().unwrap() < MAX_ROWS), "the newest are kept");
    // 1.174.0 E9 round 1: kept by last use — started long ago, ended (or
    // open at quit) within the window — not by start.
    let mut rows = vec![row("used", now - 40 * day), row("quit", now - 40 * day), row("stale", now - 40 * day)];
    rows[0].ended_at = Some(now - 2 * day);
    rows[1].open_at_quit = Some(now - day);
    rows[2].ended_at = Some(now - 35 * day);
    prune(&mut rows, now, &Default::default());
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["used", "quit"]);
    assert_eq!(last_used_at(&rows[0]), now - 2 * day);
}

#[test]
fn a_title_is_one_short_line_and_a_member_s_name_is_never_replaced() {
    assert_eq!(clean_title("  Fix   the\nlogin  "), Some("Fix the login".into()));
    assert_eq!(clean_title("   "), None);
    let long = "a".repeat(100);
    let cut = clean_title(&long).unwrap();
    assert_eq!(cut.chars().count(), TITLE_MAX);
    assert!(cut.ends_with('…'));

    let mut r = row("r", 1);
    assert!(set_title(&mut r, "first words", TitleSource::FirstMessage));
    assert!(set_title(&mut r, "Claude's title", TitleSource::Cli), "the CLI's title wins over the first message");
    assert!(!set_title(&mut r, "other first words", TitleSource::FirstMessage));
    assert!(set_title(&mut r, "My name", TitleSource::User));
    assert!(!set_title(&mut r, "Claude's new title", TitleSource::Cli), "never over the member's");
    assert_eq!(r.title.as_deref(), Some("My name"));
    assert!(set_title(&mut r, "Renamed again", TitleSource::User));
}

#[test]
fn a_claude_tile_gets_a_session_id_unless_its_args_name_a_conversation() {
    let (args, id) = claude_args_with_session(vec!["--settings".into(), "{}".into()]);
    let id = id.unwrap();
    assert_eq!(&args[2..], ["--session-id".to_string(), id.clone()]);
    assert!(uuid::Uuid::parse_str(&id).is_ok());

    let (args, id) = claude_args_with_session(vec!["--resume".into(), "abc".into()]);
    assert_eq!(args, ["--resume", "abc"]);
    assert_eq!(id.as_deref(), Some("abc"));
    let (_, id) = claude_args_with_session(vec!["--session-id=xyz".into()]);
    assert_eq!(id.as_deref(), Some("xyz"));
    let (args, id) = claude_args_with_session(vec!["--continue".into()]);
    assert_eq!(args, ["--continue"]);
    assert_eq!(id, None, "--continue picks a conversation Plyloft can't name at spawn");
}

#[test]
fn a_tile_s_row_is_recorded_at_start_ended_at_exit_and_listed_newest_first() {
    let _serial = serial();
    reset_for_tests();
    let dir = tempfile::tempdir().unwrap();
    let a = record_start(dir.path(), "ws", "pty-1", SessionKind::Claude, "/p", Some("s-1".into())).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let b = record_start(dir.path(), "ws", "pty-2", SessionKind::Codex, "/p", None).unwrap();
    let listed = list(dir.path(), "ws");
    assert_eq!(listed.iter().map(|s| s.row.id.clone()).collect::<Vec<_>>(), [b.clone(), a.clone()]);
    assert!(listed.iter().all(|s| s.live));
    record_end("pty-1");
    let listed = list(dir.path(), "ws");
    let ended = listed.iter().find(|s| s.row.id == a).unwrap();
    assert!(!ended.live);
    assert!(ended.row.ended_at.is_some());
    assert_eq!(ended.row.pty_id, None);
    assert_eq!(ended.row.cli_session_id.as_deref(), Some("s-1"));
    // An unknown PTY (a shell, a card's Builder) changes nothing.
    record_end("pty-unknown");
    // The file is the whole record, written atomically (no temp left).
    let parent = path_for(dir.path(), "ws").parent().unwrap().to_path_buf();
    let names: Vec<String> = std::fs::read_dir(parent).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(names, [FILE_NAME.to_string()]);
    // Another workspace's file is its own.
    assert!(list(dir.path(), "other").is_empty());
    reset_for_tests();
}

// ── P2: titles from the CLI's own files ──────────────────────────────────

use crate::session_titles::{from_first_message, read_claude, read_codex};

fn write(path: &std::path::Path, lines: &[serde_json::Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    std::fs::write(path, text.join("\n") + "\n").unwrap();
}

#[test]
fn a_first_message_makes_a_short_title_without_fillers() {
    assert_eq!(from_first_message("can you fix the login that breaks on Safari? It started today."), Some("Fix the login that breaks on Safari".into()));
    assert_eq!(from_first_message("Puoi sistemare il login che si rompe su Safari?"), Some("Sistemare il login che si rompe su Safari".into()));
    assert_eq!(from_first_message("please   add\na footer"), Some("Add a footer".into()));
    assert_eq!(from_first_message("   "), None);
}

#[test]
fn claude_s_transcript_gives_its_own_title_over_the_first_message_and_a_rename_over_both() {
    let dir = tempfile::tempdir().unwrap();
    let t = dir.path().join("t.jsonl");
    write(&t, &[
        json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "<command-name>/init</command-name>"}}),
        json!({"type": "user", "message": {"role": "user", "content": "<command-name>/model</command-name>"}}),
        json!({"type": "user", "message": {"role": "user", "content": "add dark mode to the settings page"}}),
        json!({"type": "assistant", "message": {"role": "assistant", "content": "ok"}}),
    ]);
    let f = read_claude(&t);
    assert_eq!(f.first_message.as_deref(), Some("add dark mode to the settings page"));
    assert_eq!(f.best(), Some(("Add dark mode to the settings page".into(), TitleSource::FirstMessage)));
    write(&t, &[
        json!({"type": "user", "message": {"role": "user", "content": "add dark mode"}}),
        json!({"type": "ai-title", "sessionId": "s", "aiTitle": "Dark mode for settings"}),
        json!({"type": "ai-title", "sessionId": "s", "aiTitle": "Dark mode for settings"}),
    ]);
    assert_eq!(read_claude(&t).best(), Some(("Dark mode for settings".into(), TitleSource::Cli)));
    write(&t, &[
        json!({"type": "ai-title", "sessionId": "s", "aiTitle": "Dark mode"}),
        json!({"type": "custom-title", "sessionId": "s", "customTitle": "Theme work"}),
    ]);
    assert_eq!(read_claude(&t).best(), Some(("Theme work".into(), TitleSource::User)));
}

#[test]
fn a_huge_transcript_is_read_at_its_head_and_tail_only() {
    let dir = tempfile::tempdir().unwrap();
    let t = dir.path().join("big.jsonl");
    let mut text = json!({"type": "user", "message": {"role": "user", "content": "refactor the parser"}}).to_string() + "\n";
    let filler = json!({"type": "assistant", "message": {"role": "assistant", "content": "x".repeat(1000)}}).to_string() + "\n";
    for _ in 0..400 {
        text.push_str(&filler);
    }
    text.push_str(&(json!({"type": "ai-title", "sessionId": "s", "aiTitle": "Parser refactor"}).to_string() + "\n"));
    std::fs::write(&t, text).unwrap();
    assert!(std::fs::metadata(&t).unwrap().len() > 3 * crate::session_titles::SCAN_BYTES);
    let f = read_claude(&t);
    assert_eq!(f.first_message.as_deref(), Some("refactor the parser"));
    assert_eq!(f.cli.as_deref(), Some("Parser refactor"), "the latest title is in the tail");
}

#[test]
fn codex_s_first_message_is_the_one_after_its_own_context_and_a_rename_wins() {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path().join("rollout.jsonl");
    write(&r, &[
        json!({"type": "session_meta", "payload": {"id": "c1", "cwd": "/p", "source": "cli"}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>…</environment_context>"}]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "write tests for the cache"}]}}),
    ]);
    assert_eq!(read_codex(&r, None, "c1").best(), Some(("Write tests for the cache".into(), TitleSource::FirstMessage)));
    // P2 walk: Codex 0.163's own preamble (~75 KB) comes before the member's
    // message, past the 64 KB a Claude transcript's head is.
    let long = dir.path().join("long.jsonl");
    let preamble = "x".repeat(40 * 1024);
    write(&long, &[
        json!({"type": "session_meta", "payload": {"id": "c2", "cwd": "/p", "source": "cli", "base_instructions": preamble}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": preamble}]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "say hi"}]}}),
    ]);
    assert!(std::fs::metadata(&long).unwrap().len() > crate::session_titles::SCAN_BYTES);
    assert_eq!(read_codex(&long, None, "c2").best(), Some(("Say hi".into(), TitleSource::FirstMessage)));
    let index = dir.path().join("session_index.jsonl");
    write(&index, &[json!({"id": "other", "thread_name": "x"}), json!({"id": "c1", "thread_name": "Cache tests"})]);
    assert_eq!(read_codex(&r, Some(&index), "c1").best(), Some(("Cache tests".into(), TitleSource::User)));
}

#[test]
fn a_live_claude_tile_takes_its_title_and_follows_a_clear_to_the_new_conversation() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    let row = record_start(config.path(), "ws", "pty-c", SessionKind::Claude, "/p", Some("s-old".into())).unwrap();
    write(&claude.path().join("projects/-p/s-old.jsonl"), &[json!({"type": "user", "message": {"role": "user", "content": "fix the footer"}})]);
    let v = refresh_title("pty-c", Some(4242), &homes).unwrap();
    assert_eq!((v.row_id.clone(), v.title.as_deref()), (row.clone(), Some("Fix the footer")));
    // /clear: Claude's per-process file names another conversation.
    write(&claude.path().join("sessions/4242.json"), &[json!({"pid": 4242, "sessionId": "s-new"})]);
    write(&claude.path().join("projects/-p/s-new.jsonl"), &[json!({"type": "ai-title", "sessionId": "s-new", "aiTitle": "Header spacing"})]);
    let v = refresh_title("pty-c", Some(4242), &homes).unwrap();
    assert_ne!(v.row_id, row, "a new row for the new conversation");
    // Challenger round 2: its own title or first words are not a name of its
    // own — the member's name is passed on to it.
    assert!(v.followed && !v.conversation_named);
    assert_eq!(v.title.as_deref(), Some("Header spacing"));
    let rows = list(config.path(), "ws");
    let old = rows.iter().find(|r| r.row.id == row).unwrap();
    assert!(old.row.ended_at.is_some() && !old.live, "the old conversation ends, kept for Resume");
    assert_eq!(old.row.title.as_deref(), Some("Fix the footer"));
    // The member's own name: kept over the CLI's.
    rename("pty-c", "My header work").unwrap();
    name_passed("pty-c", "My header work").unwrap();
    let v = refresh_title("pty-c", Some(4242), &homes).unwrap();
    assert_eq!((v.title.as_deref(), v.title_source), (Some("My header work"), Some(TitleSource::User)));
    // Another /clear, into a conversation that already holds the name
    // Plyloft passed: still not a name of its own.
    write(&claude.path().join("sessions/4242.json"), &[json!({"pid": 4242, "sessionId": "s-third"})]);
    write(&claude.path().join("projects/-p/s-third.jsonl"), &[
        json!({"type": "user", "message": {"role": "user", "content": "go on"}}),
        json!({"type": "custom-title", "sessionId": "s-third", "customTitle": "My header work"}),
    ]);
    let v = refresh_title("pty-c", Some(4242), &homes).unwrap();
    assert!(v.followed && !v.conversation_named);
    // /resume inside Claude into a conversation with its own name: named, left alone.
    write(&claude.path().join("sessions/4242.json"), &[json!({"pid": 4242, "sessionId": "s-named"})]);
    write(&claude.path().join("projects/-p/s-named.jsonl"), &[json!({"type": "custom-title", "sessionId": "s-named", "customTitle": "Release notes"})]);
    let v = refresh_title("pty-c", Some(4242), &homes).unwrap();
    assert!(v.followed && v.conversation_named);
    reset_for_tests();
}

fn codex_turn(home: &std::path::Path, id: &str, cwd: &str, started_ms: i64, text: &str) {
    let ts = chrono::DateTime::from_timestamp_millis(started_ms).unwrap().to_rfc3339();
    write(&home.join(format!("sessions/2026/10/21/rollout-x-{id}.jsonl")), &[
        json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "source": "cli", "timestamp": ts}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context/>"}]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}),
    ]);
}

fn started_of(config: &std::path::Path, row: &str) -> i64 {
    list(config, "ws").into_iter().find(|s| s.row.id == row).unwrap().row.started_at
}

#[test]
fn a_codex_tile_takes_a_session_only_when_no_other_tile_could_own_it() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let a = record_start(config.path(), "ws", "pty-1", SessionKind::Codex, &cwd, None).unwrap();
    // A `codex` the member ran elsewhere in this folder before the tile: never its.
    codex_turn(codex.path(), "outside", &cwd, started_of(config.path(), &a) - 5_000, "outside work");
    assert_eq!(refresh_title("pty-1", None, &homes).unwrap().title, None);
    std::thread::sleep(std::time::Duration::from_millis(5));
    let b = record_start(config.path(), "ws", "pty-2", SessionKind::Codex, &cwd, None).unwrap();
    let (ta, tb) = (started_of(config.path(), &a), started_of(config.path(), &b));
    // The later tile speaks first: its session could be either tile's, so
    // neither takes it.
    codex_turn(codex.path(), "b-first", &cwd, tb + 1_000, "second tile's work");
    assert_eq!(refresh_title("pty-1", None, &homes).unwrap().title, None, "never the other tile's");
    assert_eq!(refresh_title("pty-2", None, &homes).unwrap().title, None, "an earlier tile could own it");
    // A session started between the two tiles' starts is only the first's.
    codex_turn(codex.path(), "a-own", &cwd, ta + (tb - ta) / 2, "first tile's work");
    assert!(tb > ta + 1);
    let one = refresh_title("pty-1", None, &homes).unwrap();
    assert_eq!((one.title.as_deref(), one.cli_session_id.as_deref()), (Some("First tile's work"), Some("a-own")));
    // Now the second is the only one waiting: what is left after its start is its.
    let two = refresh_title("pty-2", None, &homes).unwrap();
    assert_eq!((two.title.as_deref(), two.cli_session_id.as_deref()), (Some("Second tile's work"), Some("b-first")));
    reset_for_tests();
}

#[test]
fn a_claude_tile_started_without_an_id_takes_the_one_it_is_in() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    // `claude --continue`: no id at spawn.
    let row = record_start(config.path(), "ws", "pty-c", SessionKind::Claude, "/p", None).unwrap();
    write(&claude.path().join("sessions/77.json"), &[json!({"pid": 77, "sessionId": "s-cont"})]);
    write(&claude.path().join("projects/-p/s-cont.jsonl"), &[json!({"type": "ai-title", "sessionId": "s-cont", "aiTitle": "Earlier work"})]);
    let v = refresh_title("pty-c", Some(77), &homes).unwrap();
    assert_eq!(v.row_id, row, "the same row, now with its conversation");
    assert!(!v.followed);
    assert_eq!((v.cli_session_id.as_deref(), v.title.as_deref()), (Some("s-cont"), Some("Earlier work")));
    reset_for_tests();
}

#[test]
fn use_the_automatic_name_drops_the_member_s_name_and_the_conversation_s_title_returns() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    record_start(config.path(), "ws", "pty-n", SessionKind::Claude, "/p", Some("s-n".into())).unwrap();
    write(&claude.path().join("projects/-p/s-n.jsonl"), &[json!({"type": "ai-title", "sessionId": "s-n", "aiTitle": "Parser fix"})]);
    rename("pty-n", "My name").unwrap();
    assert_eq!(list(config.path(), "ws")[0].row.passed_name, None, "not typed into the CLI yet");
    name_passed("pty-n", "My name").unwrap();
    assert_eq!(list(config.path(), "ws")[0].row.passed_name.as_deref(), Some("My name"));
    // Plyloft typed `/rename My name`: Claude keeps it as its own custom title.
    write(&claude.path().join("projects/-p/s-n.jsonl"), &[
        json!({"type": "ai-title", "sessionId": "s-n", "aiTitle": "Parser fix"}),
        json!({"type": "custom-title", "sessionId": "s-n", "customTitle": "My name"}),
    ]);
    assert_eq!(refresh_title("pty-n", None, &homes).unwrap().title.as_deref(), Some("My name"));
    let v = use_automatic_name("pty-n").unwrap().unwrap();
    assert_eq!((v.title, v.title_source), (None, None));
    // The name Plyloft passed is not the conversation's own: it stays gone.
    let v = refresh_title("pty-n", None, &homes).unwrap();
    assert_eq!((v.title.as_deref(), v.title_source), (Some("Parser fix"), Some(TitleSource::Cli)));
    assert!(!v.conversation_named);
    // A name given inside Claude afterwards is the member's again.
    write(&claude.path().join("projects/-p/s-n.jsonl"), &[
        json!({"type": "custom-title", "sessionId": "s-n", "customTitle": "My name"}),
        json!({"type": "custom-title", "sessionId": "s-n", "customTitle": "Typed in Claude"}),
    ]);
    let v = refresh_title("pty-n", None, &homes).unwrap();
    assert_eq!((v.title.as_deref(), v.title_source), (Some("Typed in Claude"), Some(TitleSource::User)));
    reset_for_tests();
}

// ── P4: Resume… lists the project's conversations ────────────────────────

fn claude_line(cwd: &str, text: &str) -> serde_json::Value {
    json!({"type": "user", "cwd": cwd, "sessionId": "s", "message": {"role": "user", "content": text}})
}

fn codex_rollout(home: &std::path::Path, id: &str, cwd: &str, source: &str, text: &str) {
    let now = chrono::Utc::now();
    let (ts, day) = (now.to_rfc3339(), now.format("%Y/%m/%d"));
    let stamp = now.format("%Y-%m-%dT%H-%M-%S");
    write(&home.join(format!("sessions/{day}/rollout-{stamp}-{id}.jsonl")), &[
        json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "source": source, "timestamp": ts}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context/>"}]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}),
    ]);
}

#[test]
fn claude_s_folder_key_turns_every_other_character_into_a_dash() {
    assert_eq!(claude_project_key("/Users/x/code/atelier/.atelier-worktrees/card-1"), "-Users-x-code-atelier--atelier-worktrees-card-1");
    assert_eq!(claude_project_key(r"C:\Users\me\app"), "C--Users-me-app");
}

#[test]
fn resume_lists_the_project_s_claude_and_codex_conversations_and_nothing_else() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let folder = crate::platform::canonicalize(project.path()).unwrap();
    let cwd = folder.to_string_lossy().to_string();
    let worktree = folder.join(".atelier-worktrees").join("card-1");
    std::fs::create_dir_all(&worktree).unwrap();
    let wt = worktree.to_string_lossy().to_string();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: Some(codex.path().to_path_buf()) };
    let dir = claude.path().join("projects").join(claude_project_key(&cwd));

    // Claude: one with its own title, one named by its first words, one empty
    // (only a command), a card's intake, and one from a folder sharing the key.
    write(&dir.join("c-titled.jsonl"), &[
        claude_line(&cwd, "add dark mode"),
        json!({"type": "ai-title", "sessionId": "c-titled", "aiTitle": "Dark mode"}),
    ]);
    write(&dir.join("c-words.jsonl"), &[claude_line(&cwd, "can you fix the footer?")]);
    write(&dir.join("c-empty.jsonl"), &[claude_line(&cwd, "<command-name>/clear</command-name>")]);
    write(&dir.join("c-intake.jsonl"), &[claude_line(&cwd, "Card title: Archive action\n\nNotes: …")]);
    write(&dir.join("c-elsewhere.jsonl"), &[claude_line("/somewhere/else", "not this project")]);
    // A card's Builder ran in its own folder: another key.
    write(&claude.path().join("projects").join(claude_project_key(&wt)).join("c-builder.jsonl"), &[claude_line(&wt, "build the card")]);
    // Too old: outside the window.
    let old = dir.join("c-old.jsonl");
    write(&old, &[claude_line(&cwd, "an old one")]);
    let month_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 24 * 3600);
    std::fs::File::options().write(true).open(&old).unwrap().set_modified(month_ago).unwrap();

    // Codex: the project's, an `exec` run there, another folder's, a card's.
    codex_rollout(codex.path(), "x-mine", &cwd, "cli", "write tests for the cache");
    codex_rollout(codex.path(), "x-exec", &cwd, "exec", "a headless review");
    codex_rollout(codex.path(), "x-other", "/somewhere/else", "cli", "elsewhere");
    codex_rollout(codex.path(), "x-card", &wt, "cli", "a card's Codex");

    let listed = conversations(config.path(), "ws", &folder, &homes);
    let mut ids: Vec<(SessionKind, String, Option<String>)> =
        listed.iter().map(|c| (c.kind, c.cli_session_id.clone(), c.title.clone())).collect();
    ids.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(
        ids,
        [
            (SessionKind::Claude, "c-titled".to_string(), Some("Dark mode".to_string())),
            (SessionKind::Claude, "c-words".to_string(), Some("Fix the footer".to_string())),
            (SessionKind::Codex, "x-mine".to_string(), Some("Write tests for the cache".to_string())),
        ]
    );
    assert!(listed.iter().all(|c| !c.live && c.updated_at > 0));
    assert!(listed.windows(2).all(|w| w[0].updated_at >= w[1].updated_at), "newest first");

    // A tile of this workspace runs one now, under the name the member gave
    // it: Resume… names it so, and says it is open.
    record_start(config.path(), "ws", "pty-live", SessionKind::Claude, &cwd, Some("c-words".into())).unwrap();
    rename("pty-live", "Footer work").unwrap();
    let listed = conversations(config.path(), "ws", &folder, &homes);
    let words = listed.iter().find(|c| c.cli_session_id == "c-words").unwrap();
    assert!(words.live);
    assert_eq!(words.live_pty_id.as_deref(), Some("pty-live"));
    assert_eq!((words.title.as_deref(), words.title_source), (Some("Footer work"), Some(TitleSource::User)));
    record_end("pty-live");
    let listed = conversations(config.path(), "ws", &folder, &homes);
    let words = listed.iter().find(|c| c.cli_session_id == "c-words").unwrap();
    assert!(!words.live, "ended: Resume opens it again");
    assert_eq!(words.title.as_deref(), Some("Footer work"), "still named as its tile was");
    reset_for_tests();
}

// 1.174.0 walk G3b: a conversation from one of the project's copies is the
// project's too, and says the copy's folder it resumes in — the copy on disk
// and one thrown away since (the record has it); a card's folder stays out.
#[test]
fn resume_lists_the_copies_conversations_with_their_folder() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let folder = crate::platform::canonicalize(project.path()).unwrap();
    let cwd = folder.to_string_lossy().to_string();
    let copy = folder.join(".plyloft-worktrees").join("copy-0a0b0c0d");
    std::fs::create_dir_all(&copy).unwrap();
    let copy_s = copy.to_string_lossy().to_string();
    let gone = folder.join(".plyloft-worktrees").join("copy-9z8y7x6w");
    let gone_s = gone.to_string_lossy().to_string();
    let card = folder.join(".plyloft-worktrees").join("card-1");
    std::fs::create_dir_all(&card).unwrap();
    let card_s = card.to_string_lossy().to_string();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: Some(codex.path().to_path_buf()) };
    let projects = claude.path().join("projects");
    write(&projects.join(claude_project_key(&cwd)).join("c-here.jsonl"), &[claude_line(&cwd, "fix the header")]);
    write(&projects.join(claude_project_key(&copy_s)).join("c-copy.jsonl"), &[claude_line(&copy_s, "try the new parser")]);
    write(&projects.join(claude_project_key(&gone_s)).join("c-gone.jsonl"), &[claude_line(&gone_s, "an old experiment")]);
    write(&projects.join(claude_project_key(&card_s)).join("c-card.jsonl"), &[claude_line(&card_s, "build the card")]);
    codex_rollout(codex.path(), "x-copy", &copy_s, "cli", "write the copy's tests");
    // The thrown-away copy is known from the record only.
    record_start(config.path(), "ws", "pty-gone", SessionKind::Claude, &gone_s, Some("c-gone".into())).unwrap();
    record_end("pty-gone");

    let listed = conversations(config.path(), "ws", &folder, &homes);
    let mut got: Vec<(String, Option<String>)> = listed.iter().map(|c| (c.cli_session_id.clone(), c.cwd.clone())).collect();
    got.sort();
    assert_eq!(
        got,
        [
            ("c-copy".to_string(), Some(copy_s.clone())),
            ("c-gone".to_string(), Some(gone_s.clone())),
            ("c-here".to_string(), None),
            ("x-copy".to_string(), Some(copy_s.clone())),
        ]
    );
    let v = serde_json::to_value(listed.iter().find(|c| c.cli_session_id == "c-here").unwrap()).unwrap();
    assert!(v.get("cwd").is_none(), "the project folder's own: no folder said");
    reset_for_tests();
}

// G3b review (1a): the read budget is shared and spent newest first across
// every folder — a project folder full of older transcripts never crowds a
// copy's newer conversation out.
#[test]
fn a_copy_s_newer_conversation_is_read_before_the_project_folder_s_older_ones() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let folder = crate::platform::canonicalize(project.path()).unwrap();
    let cwd = folder.to_string_lossy().to_string();
    let copy = folder.join(".plyloft-worktrees").join("copy-0a0b0c0d");
    std::fs::create_dir_all(&copy).unwrap();
    let copy_s = copy.to_string_lossy().to_string();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    let projects = claude.path().join("projects");
    let here = projects.join(claude_project_key(&cwd));
    // More than the whole budget, none listable (only a command), all an
    // hour old.
    let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for i in 0..(CONVERSATIONS_READ_MAX + 5) {
        let path = here.join(format!("c-old-{i}.jsonl"));
        write(&path, &[claude_line(&cwd, "<command-name>/clear</command-name>")]);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(hour_ago).unwrap();
    }
    write(&projects.join(claude_project_key(&copy_s)).join("c-copy.jsonl"), &[claude_line(&copy_s, "try the new parser")]);
    let listed = conversations(config.path(), "ws", &folder, &homes);
    let ids: Vec<(&str, Option<&str>)> = listed.iter().map(|c| (c.cli_session_id.as_str(), c.cwd.as_deref())).collect();
    assert_eq!(ids, [("c-copy", Some(copy_s.as_str()))]);
    reset_for_tests();
}

#[test]
fn a_resumed_conversation_continues_its_row_with_its_name_and_its_args_are_interactive() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let first = record_start(config.path(), "ws", "pty-1", SessionKind::Claude, "/p", Some("s-1".into())).unwrap();
    rename("pty-1", "Login fix").unwrap();
    record_end("pty-1");

    // Claude: `--resume <id>` (after the theme's --settings) is the id, and no
    // second --session-id is added.
    let (args, id) = claude_args_with_session(vec!["--settings".into(), "{}".into(), "--resume".into(), "s-1".into()]);
    assert_eq!(args, ["--settings", "{}", "--resume", "s-1"]);
    assert_eq!(id.as_deref(), Some("s-1"));
    assert!(crate::pty::refuse_print_mode("/usr/local/bin/claude", &args).is_ok(), "an interactive resume, never -p");
    let again = record_start(config.path(), "ws", "pty-2", SessionKind::Claude, "/p", id).unwrap();
    let rows = list(config.path(), "ws");
    let row = &rows.iter().find(|r| r.row.id == again).unwrap().row;
    assert_eq!(row.resumed_from.as_deref(), Some(first.as_str()));
    assert_eq!((row.title.as_deref(), row.title_source), (Some("Login fix"), Some(TitleSource::User)));

    // Codex: `codex [--no-daemon] resume <id>`.
    let args: Vec<String> = vec!["--no-daemon".into(), "resume".into(), "x-1".into()];
    assert_eq!(codex_resumed_session(&args).as_deref(), Some("x-1"));
    assert_eq!(codex_resumed_session(&[]), None);
    assert!(crate::pty::refuse_print_mode("codex", &args).is_ok());
    // A conversation the record never had: no row to continue.
    let fresh = record_start(config.path(), "ws", "pty-3", SessionKind::Codex, "/p", Some("x-1".into())).unwrap();
    let rows = list(config.path(), "ws");
    assert_eq!(rows.iter().find(|r| r.row.id == fresh).unwrap().row.resumed_from, None);
    reset_for_tests();
}

// ── P5: History › Sessions ───────────────────────────────────────────────

#[test]
fn history_says_which_sessions_can_still_be_resumed_in_one_look_at_every_workspace() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let cwd = crate::platform::canonicalize(project.path()).unwrap().to_string_lossy().to_string();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: Some(codex.path().to_path_buf()) };
    let key = claude_project_key(&cwd);
    write(&claude.path().join(format!("projects/{key}/s-here.jsonl")), &[claude_line(&cwd, "kept")]);
    // Under another folder's key: `claude --resume` from this folder can't find it.
    write(&claude.path().join("projects/-elsewhere/s-elsewhere.jsonl"), &[claude_line("/elsewhere", "kept")]);
    codex_rollout(codex.path(), "x-here", &cwd, "cli", "kept");
    for (pty, kind, id, dir) in [
        ("p1", SessionKind::Claude, Some("s-here"), cwd.as_str()),
        ("p2", SessionKind::Claude, Some("s-gone"), cwd.as_str()),
        ("p3", SessionKind::Codex, Some("x-here"), cwd.as_str()),
        ("p4", SessionKind::Codex, None, cwd.as_str()),
        ("p5", SessionKind::Claude, Some("s-elsewhere"), cwd.as_str()),
        ("p6", SessionKind::Claude, Some("s-here"), "/no/such/folder"),
    ] {
        record_start(config.path(), "ws", pty, kind, dir, id.map(str::to_string)).unwrap();
    }
    record_start(config.path(), "ws2", "q1", SessionKind::Codex, &cwd, Some("x-here".into())).unwrap();
    record_end("p1");
    let all = history_all(config.path(), &["ws".to_string(), "ws2".to_string(), "missing".to_string()], &homes);
    assert!(all.unreadable.is_empty());
    let rows = &all.sessions;
    assert_eq!(rows.len(), 7);
    assert!(rows.windows(2).all(|w| w[0].session.row.started_at >= w[1].session.row.started_at), "newest first");
    let by = |pty: &str| {
        rows.iter()
            .find(|r| r.session.row.pty_id.as_deref() == Some(pty) || (pty == "p1" && r.session.row.pty_id.is_none()))
            .unwrap()
    };
    assert!(by("p1").resumable && !by("p1").session.live);
    assert_eq!(by("p2").gone, Some(Gone::Conversation));
    assert!(by("p3").resumable);
    assert!(!by("p4").resumable && by("p4").gone.is_none(), "no conversation yet");
    assert_eq!(by("p5").gone, Some(Gone::Conversation), "only where the CLI would look");
    assert_eq!(by("p6").gone, Some(Gone::Folder));
    assert_eq!(by("q1").workspace_id, "ws2");
    // 1.174.0 E9 round 1: the found transcript's last write, one stat; none
    // when it is gone or there is no conversation yet.
    assert!(by("p1").last_write_at.is_some());
    assert!(by("p3").last_write_at.is_some());
    assert_eq!(by("p2").last_write_at, None);
    assert_eq!(by("p4").last_write_at, None);
    assert_eq!(by("p6").last_write_at, None);
    // No title stored (recorded before one was found): the CLI's, as Resume… shows it.
    assert_eq!(by("p3").session.row.title.as_deref(), Some("Kept"));
    assert_eq!(by("p2").session.row.title, None, "its file is gone: nothing to read");
    // The serialized row is flat: the record's fields, its workspace, live and resumable.
    let v = serde_json::to_value(&rows[0]).unwrap();
    assert!(["startedAt", "live", "resumable", "workspaceId"].iter().all(|k| v.get(*k).is_some()));
    reset_for_tests();
}

#[test]
fn resume_shows_a_tile_that_runs_it_and_refuses_a_gone_folder_a_gone_file_or_one_open_elsewhere() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let folder = crate::platform::canonicalize(project.path()).unwrap();
    let cwd = folder.to_string_lossy().to_string();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    let key = claude_project_key(&cwd);
    for id in ["s-ok", "s-tile", "s-open"] {
        write(&claude.path().join(format!("projects/{key}/{id}.jsonl")), &[claude_line(&cwd, "x")]);
    }
    let check = |id: &str, dir: &std::path::Path| resume_check(&homes, SessionKind::Claude, id, dir, None);
    assert_eq!(check("s-ok", &folder), ResumeCheck::Ready);
    assert_eq!(check("s-missing", &folder), ResumeCheck::ConversationGone);
    assert_eq!(check("s-ok", std::path::Path::new("/no/such/folder")), ResumeCheck::FolderGone);
    // A tile of another workspace runs it: that one is shown.
    record_start(config.path(), "other-ws", "pty-o", SessionKind::Claude, &cwd, Some("s-tile".into())).unwrap();
    assert_eq!(check("s-tile", &folder), ResumeCheck::InTile { workspace_id: "other-ws".into(), pty_id: "pty-o".into() });
    // A Claude outside Plyloft is in it (this test's own pid: alive).
    let me = std::process::id();
    // In another folder: not this conversation's process (a stale file).
    write(&claude.path().join(format!("sessions/{me}.json")), &[json!({"pid": me, "sessionId": "s-open", "cwd": "/elsewhere"})]);
    assert_eq!(check("s-open", &folder), ResumeCheck::Ready);
    write(&claude.path().join(format!("sessions/{me}.json")), &[json!({"pid": me, "sessionId": "s-open", "cwd": cwd})]);
    assert_eq!(check("s-open", &folder), ResumeCheck::Elsewhere);
    // A missing folder or file outranks it: "Open it anyway" is never offered there.
    write(&claude.path().join("sessions/1.json"), &[json!({"pid": me, "sessionId": "s-nofile", "cwd": cwd})]);
    assert_eq!(check("s-nofile", &folder), ResumeCheck::ConversationGone);
    assert_eq!(check("s-open", std::path::Path::new("/no/such/folder")), ResumeCheck::FolderGone);
    // One whose process has gone doesn't count.
    write(&claude.path().join(format!("sessions/{me}.json")), &[json!({"pid": 4_000_000_000u32, "sessionId": "s-open", "cwd": cwd})]);
    assert_eq!(check("s-open", &folder), ResumeCheck::Ready);
    reset_for_tests();
}

// ── QoL 1.168 (block 4, D11): Reopen the sessions open at quit ──────────

#[test]
fn a_quit_marks_the_running_tiles_and_the_next_launch_offers_them_once() {
    let _serial = serial();
    reset_for_tests();
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path();
    // Nothing recorded at a quit yet (a 1.167 profile): no offer.
    let a = record_start(cfg, "ws", "pty-a", SessionKind::Claude, "/p", Some("conv-a".into())).unwrap();
    assert!(reopen_offer(cfg, "ws").is_empty());
    // A Codex tile before its first turn has no conversation to resume.
    let _b = record_start(cfg, "ws", "pty-b", SessionKind::Codex, "/p", None).unwrap();
    let c = record_start(cfg, "ws", "pty-c", SessionKind::Codex, "/p", Some("conv-c".into())).unwrap();
    // One that ended before the quit is not offered.
    let d = record_start(cfg, "ws", "pty-d", SessionKind::Claude, "/p", Some("conv-d".into())).unwrap();
    record_end("pty-d");

    assert_eq!(mark_quit(cfg), 2);
    let quit = last_quit(cfg).expect("the quit's time");
    // The exits that follow the kill write nothing more.
    let before = std::fs::read(path_for(cfg, "ws")).unwrap();
    record_end("pty-a");
    record_end("pty-c");
    assert_eq!(std::fs::read(path_for(cfg, "ws")).unwrap(), before);

    let rows = load(&path_for(cfg, "ws")).file.sessions;
    let by = |id: &str| rows.iter().find(|r| r.id == id).unwrap().clone();
    assert_eq!(by(&a).open_at_quit, Some(quit));
    assert_eq!(by(&a).ended_at, Some(quit), "it ended at the quit");
    assert_eq!(by(&a).pty_id, None);
    assert_eq!(by(&c).open_at_quit, Some(quit));
    assert_eq!(by(&d).open_at_quit, None);

    // The next launch: offered in the order they were opened.
    reset_for_tests();
    let offer = reopen_offer(cfg, "ws");
    assert_eq!(offer.iter().map(|s| s.row.id.clone()).collect::<Vec<_>>(), vec![a.clone(), c.clone()]);
    assert!(reopen_offer(cfg, "other").is_empty());

    // One resumed by hand is no longer offered.
    record_start(cfg, "ws", "pty-a2", SessionKind::Claude, "/p", Some("conv-a".into())).unwrap();
    let offer = reopen_offer(cfg, "ws");
    assert_eq!(offer.iter().map(|s| s.row.id.clone()).collect::<Vec<_>>(), vec![c.clone()]);

    // Put away: never offered again.
    assert!(reopen_dismiss(cfg, "ws").unwrap());
    assert!(reopen_offer(cfg, "ws").is_empty());
    assert!(!reopen_dismiss(cfg, "ws").unwrap(), "nothing left to clear");
    reset_for_tests();
}

// 1.174.0 walk G3 Windows: a Claude tile nobody wrote in leaves no
// transcript — Reopen would open nothing — so it isn't offered; nor is one
// whose transcript holds no message the member typed. None left: no offer.
#[test]
fn reopen_offers_only_sessions_with_a_conversation_to_resume() {
    let _serial = serial();
    reset_for_tests();
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path();
    let claude = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let folder = crate::platform::canonicalize(project.path()).unwrap();
    let cwd = folder.to_string_lossy().to_string();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: Some(codex.path().to_path_buf()) };
    let key = claude.path().join("projects").join(claude_project_key(&cwd));
    write(&key.join("c-said.jsonl"), &[claude_line(&cwd, "fix the footer")]);
    write(&key.join("c-blank.jsonl"), &[claude_line(&cwd, "<command-name>/clear</command-name>")]);
    codex_rollout(codex.path(), "x-said", &cwd, "cli", "write the tests");
    let said = record_start(cfg, "ws", "pty-1", SessionKind::Claude, &cwd, Some("c-said".into())).unwrap();
    record_start(cfg, "ws", "pty-2", SessionKind::Claude, &cwd, Some("c-never".into())).unwrap();
    record_start(cfg, "ws", "pty-3", SessionKind::Claude, &cwd, Some("c-blank".into())).unwrap();
    let codex_said = record_start(cfg, "ws", "pty-4", SessionKind::Codex, &cwd, Some("x-said".into())).unwrap();
    assert_eq!(mark_quit(cfg), 4);
    reset_for_tests();
    assert_eq!(reopen_offer(cfg, "ws").len(), 4, "the record keeps all four");
    let offer = reopen_offer_resumable(cfg, "ws", &homes);
    assert_eq!(offer.iter().map(|s| s.row.id.clone()).collect::<Vec<_>>(), vec![said, codex_said]);

    // Only tiles nobody wrote in: nothing to offer, so no row.
    let empty = tempfile::tempdir().unwrap();
    record_start(empty.path(), "w2", "pty-5", SessionKind::Claude, &cwd, Some("c-never-2".into())).unwrap();
    mark_quit(empty.path());
    reset_for_tests();
    assert!(reopen_offer_resumable(empty.path(), "w2", &homes).is_empty());
    reset_for_tests();
}

#[test]
fn only_the_last_quit_is_offered() {
    let _serial = serial();
    reset_for_tests();
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path();
    record_start(cfg, "a", "pty-1", SessionKind::Claude, "/p", Some("one".into())).unwrap();
    mark_quit(cfg);
    reset_for_tests();
    assert_eq!(reopen_offer(cfg, "a").len(), 1);
    // A later launch quits with nothing open in "a": what was open at the
    // earlier quit is not offered as if it were the last one.
    std::thread::sleep(std::time::Duration::from_millis(2));
    record_start(cfg, "b", "pty-2", SessionKind::Codex, "/q", Some("two".into())).unwrap();
    mark_quit(cfg);
    reset_for_tests();
    assert!(reopen_offer(cfg, "a").is_empty());
    assert_eq!(reopen_offer(cfg, "b").len(), 1);
    // An unreadable stamp is no quit at all.
    std::fs::write(cfg.join(LAST_QUIT_FILE), b"{ nope").unwrap();
    assert!(reopen_offer(cfg, "b").is_empty());
}

#[test]
fn a_file_with_the_quit_mark_round_trips_and_an_older_shape_loads() {
    // Written by this build, read back (and an older Plyloft keeps the key
    // as an unknown one: `extra`).
    let mut r = row("r1", 5);
    r.open_at_quit = Some(9);
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["openAtQuit"], 9);
    let back: SessionRow = serde_json::from_value(v).unwrap();
    assert_eq!(back.open_at_quit, Some(9));
    assert!(serde_json::to_value(row("r2", 5)).unwrap().get("openAtQuit").is_none(), "absent when unset");
    // The quit stamp: missing is none; unknown keys load.
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(last_quit(dir.path()), None);
    std::fs::write(dir.path().join(LAST_QUIT_FILE), br#"{"quitAt": 42, "later": true}"#).unwrap();
    assert_eq!(last_quit(dir.path()), Some(42));
}

#[test]
fn the_quit_s_last_look_claims_a_codex_session_and_never_waits_past_its_budget() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let a = record_start(config.path(), "ws", "pty-q1", SessionKind::Codex, &cwd, None).unwrap();
    // Its first turn landed after the last poll: only the quit's look sees it.
    codex_turn(codex.path(), "late", &cwd, started_of(config.path(), &a) + 1_000, "late work");
    assert_eq!(mark_quit_looking(config.path(), homes, Default::default(), QUIT_LOOK_BUDGET), 1);
    let rows = load(&path_for(config.path(), "ws")).file.sessions;
    let r = rows.iter().find(|r| r.id == a).unwrap();
    assert_eq!(r.cli_session_id.as_deref(), Some("late"));
    assert!(r.open_at_quit.is_some());
    reset_for_tests();

    // A look that hangs: the quit goes on after the budget, the rows marked.
    let config = tempfile::tempdir().unwrap();
    record_start(config.path(), "ws", "pty-q2", SessionKind::Claude, "/p", Some("c".into())).unwrap();
    let started = std::time::Instant::now();
    let marked = mark_quit_after(
        config.path(),
        || std::thread::sleep(std::time::Duration::from_secs(3)),
        std::time::Duration::from_millis(100),
    );
    assert_eq!(marked, 1);
    assert!(started.elapsed() < std::time::Duration::from_secs(1), "{:?}", started.elapsed());
    reset_for_tests();
}

// ── 1.179.0: a Codex tile whose sister tile in the same folder closed ────

/// Where [`codex_turn`] writes a session's rollout.
fn codex_file(home: &std::path::Path, id: &str) -> std::path::PathBuf {
    home.join(format!("sessions/2026/10/21/rollout-x-{id}.jsonl"))
}

fn set_mtime_ms(path: &std::path::Path, ms: i64) {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
}

fn mtime_of(path: &std::path::Path) -> i64 {
    let at = std::fs::metadata(path).unwrap().modified().unwrap();
    at.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn ended_of(config: &std::path::Path, row: &str) -> i64 {
    load(&path_for(config, "ws")).file.sessions.into_iter().find(|r| r.id == row).unwrap().ended_at.unwrap()
}

/// How a rollout's mtime behaves as Codex appends to it.
#[derive(Clone, Copy, Debug)]
enum Mtimes {
    /// It follows each write (macOS).
    Advance,
    /// It stays at the file's creation (measured on Windows).
    StayAtCreation,
}

/// Codex appends a line dated `at` to session `id`'s rollout, the file's
/// mtime moving as `mtimes` says.
fn codex_append(home: &std::path::Path, id: &str, at: i64, mtimes: Mtimes) {
    use std::io::Write;
    let path = codex_file(home, id);
    let created = mtime_of(&path);
    let ts = chrono::DateTime::from_timestamp_millis(at).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let line = json!({"timestamp": ts, "type": "event_msg", "payload": {"type": "agent_message", "message": "An answer."}});
    let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(f, "{line}").unwrap();
    drop(f);
    match mtimes {
        Mtimes::Advance => set_mtime_ms(&path, at),
        Mtimes::StayAtCreation => set_mtime_ms(&path, created),
    }
}

/// A claimed its session, B opened later in the same folder and claimed
/// its own, then B closed.
struct SisterClosed {
    _config: tempfile::TempDir,
    codex: tempfile::TempDir,
    _folder: tempfile::TempDir,
    homes: CliHomes,
    cwd: String,
    a_started: i64,
    b_started: i64,
    b_ended: i64,
}

fn a_sister_tile_opens_claims_and_closes(mtimes: Mtimes) -> SisterClosed {
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let a = record_start(config.path(), "ws", "pty-a", SessionKind::Codex, &cwd, None).unwrap();
    let a_started = started_of(config.path(), &a);
    codex_turn(codex.path(), "a-own", &cwd, a_started + 1_000, "first tile's work");
    codex_append(codex.path(), "a-own", a_started + 1, mtimes);
    let got = live_conversation("pty-a", None, &homes).unwrap();
    assert_eq!(got.id.as_deref(), Some("a-own"));
    assert_eq!(got.file.as_deref(), Some(codex_file(codex.path(), "a-own").as_path()));
    assert!(!got.newer_elsewhere);
    std::thread::sleep(std::time::Duration::from_millis(5));
    let b = record_start(config.path(), "ws", "pty-b", SessionKind::Codex, &cwd, None).unwrap();
    let b_started = started_of(config.path(), &b);
    codex_turn(codex.path(), "b-own", &cwd, b_started + 1_000, "second tile's work");
    let got = live_conversation("pty-b", None, &homes).unwrap();
    assert_eq!(got.id.as_deref(), Some("b-own"), "the later tile claims its own");
    assert!(!got.newer_elsewhere, "the first tile's is held by a running tile");
    let got = live_conversation("pty-a", None, &homes).unwrap();
    assert_eq!(got.id.as_deref(), Some("a-own"));
    assert!(!got.newer_elsewhere, "the second tile's is held by a running tile");
    std::thread::sleep(std::time::Duration::from_millis(5));
    record_end("pty-b");
    let b_ended = ended_of(config.path(), &b);
    // B's last line, written just before it closed (and after A's last).
    codex_append(codex.path(), "b-own", b_ended - 1, mtimes);
    SisterClosed { _config: config, codex, _folder: folder, homes, cwd, a_started, b_started, b_ended }
}

#[test]
fn a_codex_tile_keeps_its_session_after_a_later_tile_in_its_folder_closed() {
    let _serial = serial();
    for mtimes in [Mtimes::Advance, Mtimes::StayAtCreation] {
        reset_for_tests();
        let s = a_sister_tile_opens_claims_and_closes(mtimes);
        let own = codex_file(s.codex.path(), "a-own");
        // B wrote after A's last line: until A's next turn, B's could still
        // be the one A is in (it is no running tile's).
        assert!(live_conversation("pty-a", None, &s.homes).unwrap().newer_elsewhere, "{mtimes:?}");
        // A's next turn: A is still known, on its own rollout.
        codex_append(s.codex.path(), "a-own", s.b_ended + 1_000, mtimes);
        let got = live_conversation("pty-a", None, &s.homes).unwrap();
        assert_eq!(got.id.as_deref(), Some("a-own"), "{mtimes:?}");
        assert_eq!(got.file.as_deref(), Some(own.as_path()), "{mtimes:?}");
        assert!(!got.newer_elsewhere, "{mtimes:?}: the closed tile's session is not A's");
        // A line in B's rollout dated after B closed (A resumed it): not A's for sure.
        codex_append(s.codex.path(), "b-own", s.b_ended + 2_000, mtimes);
        assert!(live_conversation("pty-a", None, &s.homes).unwrap().newer_elsewhere, "{mtimes:?}");
        reset_for_tests();
    }
}

#[test]
fn a_closed_tile_s_rollout_whose_last_line_has_no_time_still_counts() {
    let _serial = serial();
    reset_for_tests();
    let s = a_sister_tile_opens_claims_and_closes(Mtimes::StayAtCreation);
    codex_append(s.codex.path(), "a-own", s.b_ended + 1_000, Mtimes::StayAtCreation);
    assert!(!live_conversation("pty-a", None, &s.homes).unwrap().newer_elsewhere);
    // A last line without a time: when B's rollout was last written is unknown.
    let b_file = codex_file(s.codex.path(), "b-own");
    let created = mtime_of(&b_file);
    let mut text = std::fs::read_to_string(&b_file).unwrap();
    text.push_str("{\"type\":\"event_msg\",\"payload\":{}}\n");
    std::fs::write(&b_file, text).unwrap();
    set_mtime_ms(&b_file, created);
    assert!(live_conversation("pty-a", None, &s.homes).unwrap().newer_elsewhere);
    reset_for_tests();
}

#[test]
fn two_codex_tiles_opened_together_in_one_folder_stay_unclaimed_and_ambiguous() {
    let _serial = serial();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    record_start(config.path(), "ws", "pty-x", SessionKind::Codex, &cwd, None).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let y = record_start(config.path(), "ws", "pty-y", SessionKind::Codex, &cwd, None).unwrap();
    let ty = started_of(config.path(), &y);
    // Both sessions began after both tiles: either could be either tile's.
    codex_turn(codex.path(), "one", &cwd, ty + 1_000, "one tile's work");
    codex_turn(codex.path(), "two", &cwd, ty + 2_000, "other tile's work");
    for pty in ["pty-x", "pty-y", "pty-x"] {
        let got = live_conversation(pty, None, &homes).unwrap();
        assert_eq!(got.id, None, "{pty} claims nothing");
        assert!(got.newer_elsewhere, "{pty} can't tell");
    }
    reset_for_tests();
}

#[test]
fn a_codex_tile_whose_own_codex_started_a_newer_session_is_ambiguous() {
    let _serial = serial();
    for mtimes in [Mtimes::Advance, Mtimes::StayAtCreation] {
        reset_for_tests();
        let config = tempfile::tempdir().unwrap();
        let codex = tempfile::tempdir().unwrap();
        let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
        let folder = tempfile::tempdir().unwrap();
        let cwd = folder.path().to_string_lossy().to_string();
        let a = record_start(config.path(), "ws", "pty-n", SessionKind::Codex, &cwd, None).unwrap();
        let ta = started_of(config.path(), &a);
        codex_turn(codex.path(), "a-own", &cwd, ta + 1_000, "first work");
        codex_append(codex.path(), "a-own", ta + 1_000, mtimes);
        assert_eq!(live_conversation("pty-n", None, &homes).unwrap().id.as_deref(), Some("a-own"));
        // `/new` in the tile: a later session in the folder no tile ever claimed.
        codex_turn(codex.path(), "a-new", &cwd, ta + 5_000, "fresh work");
        codex_append(codex.path(), "a-new", ta + 6_000, mtimes);
        let got = live_conversation("pty-n", None, &homes).unwrap();
        assert_eq!(got.id.as_deref(), Some("a-own"), "{mtimes:?}: the record doesn't follow it");
        assert!(got.newer_elsewhere, "{mtimes:?}: so the old one is not offered for sure");
        reset_for_tests();
    }
}

#[test]
fn after_a_sister_tile_closed_a_session_no_tile_claimed_still_makes_a_codex_tile_ambiguous() {
    let _serial = serial();
    for mtimes in [Mtimes::Advance, Mtimes::StayAtCreation] {
        reset_for_tests();
        let s = a_sister_tile_opens_claims_and_closes(mtimes);
        codex_append(s.codex.path(), "a-own", s.b_ended + 1_000, mtimes);
        assert!(!live_conversation("pty-a", None, &s.homes).unwrap().newer_elsewhere, "{mtimes:?}");
        // A third session in the folder, never claimed: it may be A's own `/new`.
        codex_turn(s.codex.path(), "third", &s.cwd, s.b_started + 5_000, "unknown work");
        codex_append(s.codex.path(), "third", s.b_ended + 500, mtimes);
        let got = live_conversation("pty-a", None, &s.homes).unwrap();
        assert_eq!(got.id.as_deref(), Some("a-own"), "{mtimes:?}");
        assert!(got.newer_elsewhere, "{mtimes:?}: only a closed tile's own session is set aside");
        assert!(s.a_started < s.b_started);
        reset_for_tests();
    }
}

// ── 1.179.0 (C2): Claude accounts ───────────────────────────────────────

/// Schema migration (PPVP Tier 2): a row written before Claude accounts
/// reads as Main and writes back without the key; a row on an account keeps
/// it through a write and a read.
#[test]
fn a_row_before_claude_accounts_reads_as_main_and_an_account_round_trips() {
    let old: SessionRow =
        serde_json::from_value(json!({ "id": "r1", "kind": "claude", "cwd": "/p", "startedAt": 5 })).unwrap();
    assert_eq!(old.account, None, "Main");
    assert!(serde_json::to_value(&old).unwrap().get("account").is_none(), "left out while Main");
    let mut r = row("r2", 6);
    r.account = Some("a1b2c3d4".into());
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["account"], "a1b2c3d4");
    let back: SessionRow = serde_json::from_value(v).unwrap();
    assert_eq!(back.account.as_deref(), Some("a1b2c3d4"));
}

/// A test project with Main's folder and one account's, `a1b2c3d4`, under
/// a temporary app config folder (`ai_accounts::test_root`, this thread).
struct TwoAccounts {
    config: tempfile::TempDir,
    _main: tempfile::TempDir,
    _project: tempfile::TempDir,
    homes: CliHomes,
    folder: std::path::PathBuf,
    cwd: String,
    account_dir: std::path::PathBuf,
}

const ACCOUNT: &str = "a1b2c3d4";

fn two_accounts() -> TwoAccounts {
    let config = tempfile::tempdir().unwrap();
    let main = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let folder = crate::platform::canonicalize(project.path()).unwrap();
    let cwd = folder.to_string_lossy().to_string();
    crate::ai_accounts::test_root::set(Some(config.path().to_path_buf()));
    let account_dir = config.path().join("ai-accounts").join("claude").join(ACCOUNT);
    std::fs::create_dir_all(&account_dir).unwrap();
    let homes = CliHomes { claude: Some(main.path().to_path_buf()), codex: None };
    TwoAccounts { config, _main: main, _project: project, homes, folder, cwd, account_dir }
}

/// A conversation kept in an account's folder is found for a row recorded
/// on that account, and not for a row recorded on Main: Resume…'s check,
/// History and the project's list all look where the row's account keeps
/// it, and the list says which account that is.
#[test]
fn a_conversation_in_an_accounts_folder_is_found_for_its_row_and_not_for_main() {
    let _serial = serial();
    reset_for_tests();
    let t = two_accounts();
    let key = claude_project_key(&t.cwd);
    write(&t.account_dir.join(format!("projects/{key}/s-acc.jsonl")), &[claude_line(&t.cwd, "tidy the footer")]);
    let on = |account: Option<&str>| resume_check(&t.homes, SessionKind::Claude, "s-acc", &t.folder, account);
    assert_eq!(on(Some(ACCOUNT)), ResumeCheck::Ready);
    assert_eq!(on(None), ResumeCheck::ConversationGone, "Main's folder never holds it");

    record_start_on(t.config.path(), "ws", "pty-acc", SessionKind::Claude, &t.cwd, Some("s-acc".into()), Some(ACCOUNT.into()))
        .unwrap();
    record_start(t.config.path(), "ws", "pty-main", SessionKind::Claude, &t.cwd, Some("s-acc".into())).unwrap();
    reset_for_tests();
    let history = history_all(t.config.path(), &["ws".to_string()], &t.homes);
    let of = |account: Option<&str>| {
        history.sessions.iter().find(|s| s.session.row.account.as_deref() == account).expect("its row")
    };
    assert!(of(Some(ACCOUNT)).resumable && of(Some(ACCOUNT)).gone.is_none());
    assert_eq!(of(None).gone, Some(Gone::Conversation));

    let listed = conversations(t.config.path(), "ws", &t.folder, &t.homes);
    let found = listed.iter().find(|c| c.cli_session_id == "s-acc").expect("listed from the account's folder");
    assert_eq!(found.account.as_deref(), Some(ACCOUNT));
    crate::ai_accounts::test_root::set(None);
    reset_for_tests();
}

/// A row whose account was removed (its folder with it) is not resumed on
/// another account: Resume…'s check and History say so, in the words
/// `ai_accounts::ACCOUNT_REMOVED` gives the window.
#[test]
fn a_row_whose_account_was_removed_is_not_resumable() {
    let _serial = serial();
    reset_for_tests();
    let t = two_accounts();
    let key = claude_project_key(&t.cwd);
    // The same conversation id in Main's folder must not stand in for it.
    write(&t.homes.claude.clone().unwrap().join(format!("projects/{key}/s-gone.jsonl")), &[claude_line(&t.cwd, "x")]);
    record_start_on(t.config.path(), "ws", "pty-gone", SessionKind::Claude, &t.cwd, Some("s-gone".into()), Some(ACCOUNT.into()))
        .unwrap();
    reset_for_tests();
    std::fs::remove_dir_all(&t.account_dir).unwrap();
    assert_eq!(
        resume_check(&t.homes, SessionKind::Claude, "s-gone", &t.folder, Some(ACCOUNT)),
        ResumeCheck::AccountRemoved
    );
    let history = history_all(t.config.path(), &["ws".to_string()], &t.homes);
    let row = &history.sessions[0];
    assert_eq!((row.resumable, row.gone), (false, Some(Gone::Account)));
    assert_eq!(serde_json::to_value(row).unwrap()["gone"], "account");
    assert_eq!(
        serde_json::to_value(ResumeCheck::AccountRemoved).unwrap(),
        json!({ "kind": "accountRemoved" })
    );
    assert_eq!(crate::ai_accounts::ACCOUNT_REMOVED, "Its account was removed from Plyloft.");
    crate::ai_accounts::test_root::set(None);
    reset_for_tests();
}
