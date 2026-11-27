use super::*;

fn seen(path: &str, version: &str) -> ToolSeen {
    ToolSeen { path: path.into(), version: version.into() }
}

const CLAUDE: &str = "/Users/me/.local/bin/claude";

#[test]
fn the_first_look_remembers_and_says_nothing() {
    assert_eq!(
        decide(None, Some(CLAUDE), Some("2.1.322"), false, false),
        Verdict::Remember(seen(CLAUDE, "2.1.322"))
    );
}

#[test]
fn the_same_tool_says_nothing_and_writes_nothing() {
    let was = seen(CLAUDE, "2.1.322");
    assert_eq!(decide(Some(&was), Some(CLAUDE), Some("2.1.322"), false, false), Verdict::Keep);
    // Windows compares paths without case.
    let win = seen("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", "0.166.0");
    assert_eq!(
        decide(Some(&win), Some("c:\\users\\me\\appdata\\roaming\\npm\\codex.cmd"), Some("0.166.0"), false, true),
        Verdict::Keep
    );
}

#[test]
fn a_new_version_is_told_once() {
    let was = seen(CLAUDE, "2.1.322");
    let Verdict::Tell(change, now) = decide(Some(&was), Some(CLAUDE), Some("2.1.330"), false, false) else {
        panic!("a new version is told");
    };
    assert_eq!(change.version, Some(("2.1.322".into(), "2.1.330".into())));
    assert_eq!(change.folder, None);
    // Remembered: the next look at the same tool says nothing.
    assert_eq!(decide(Some(&now), Some(CLAUDE), Some("2.1.330"), false, false), Verdict::Keep);
}

#[test]
fn a_new_folder_is_told_with_or_without_a_new_version() {
    let was = seen("/opt/homebrew/bin/codex", "0.166.0");
    let Verdict::Tell(change, _) = decide(Some(&was), Some("/Users/me/.local/bin/codex"), Some("0.166.0"), false, false)
    else {
        panic!("a new folder is told");
    };
    assert_eq!(change.version, None);
    assert_eq!(change.folder, Some(("/opt/homebrew/bin".into(), "/Users/me/.local/bin".into())));
    let Verdict::Tell(both, _) = decide(Some(&was), Some("/Users/me/.local/bin/codex"), Some("0.171.0"), false, false)
    else {
        panic!("both are told");
    };
    assert!(both.version.is_some() && both.folder.is_some());
}

#[test]
fn a_new_name_in_the_same_folder_is_remembered_quietly() {
    let was = seen("C:\\npm\\codex.cmd", "0.166.0");
    assert_eq!(
        decide(Some(&was), Some("C:\\npm\\codex.exe"), Some("0.166.0"), false, true),
        Verdict::Remember(seen("C:\\npm\\codex.exe", "0.166.0"))
    );
}

#[test]
fn plyloft_s_own_change_is_remembered_quietly() {
    let was = seen(CLAUDE, "2.1.322");
    assert_eq!(
        decide(Some(&was), Some(CLAUDE), Some("2.1.330"), true, false),
        Verdict::Remember(seen(CLAUDE, "2.1.330"))
    );
}

#[test]
fn an_unreadable_version_or_a_missing_tool_says_nothing_and_keeps_the_record() {
    let was = seen(CLAUDE, "2.1.322");
    assert_eq!(decide(Some(&was), Some(CLAUDE), None, false, false), Verdict::Keep);
    assert_eq!(decide(Some(&was), Some("/elsewhere/claude"), None, false, false), Verdict::Keep);
    assert_eq!(decide(Some(&was), None, None, false, false), Verdict::Keep);
    assert_eq!(decide(None, Some(CLAUDE), None, false, false), Verdict::Keep);
}

#[test]
fn the_home_reads_as_a_tilde() {
    assert_eq!(tilde("/Users/me/.local/bin", Some("/Users/me"), false), "~/.local/bin");
    assert_eq!(tilde("/Users/me", Some("/Users/me/"), false), "~");
    assert_eq!(tilde("/Users/meg/bin", Some("/Users/me"), false), "/Users/meg/bin");
    assert_eq!(tilde("/opt/homebrew/bin", Some("/Users/me"), false), "/opt/homebrew/bin");
    assert_eq!(tilde("/opt/homebrew/bin", None, false), "/opt/homebrew/bin");
    assert_eq!(
        tilde("c:\\users\\me\\AppData\\Roaming\\npm", Some("C:\\Users\\me"), true),
        "~\\AppData\\Roaming\\npm"
    );
}

#[test]
fn a_notice_carries_what_changed_with_the_home_as_a_tilde() {
    let change = Change {
        version: Some(("0.166.0".into(), "0.171.0".into())),
        folder: Some(("/opt/homebrew/bin".into(), "/Users/me/.local/bin".into())),
    };
    let notice = notice_for(Cli::Codex, &change, Some("/Users/me"), false);
    assert_eq!(
        serde_json::to_value(&notice).unwrap(),
        serde_json::json!({
            "kind": "changed", "tool": "codex", "versionWas": "0.166.0", "versionNow": "0.171.0",
            "folderWas": "/opt/homebrew/bin", "folderNow": "~/.local/bin"
        })
    );
    let checking = Notice::Checking { tool: "claude", version: "2.1.330".into() };
    assert_eq!(
        serde_json::to_value(&checking).unwrap(),
        serde_json::json!({ "kind": "checking", "tool": "claude", "version": "2.1.330" })
    );
}

/// The schema-migration test for the new `cli-seen.json` (PATTERNS: a new
/// persisted record reads a file from before a field, and one with keys this
/// build doesn't know; an unreadable one is set aside and reads as none).
#[test]
fn the_record_reads_older_newer_and_broken_files() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(load(dir.path()), SeenRecord::default());

    // Only Claude, no schemaVersion, a tool entry without its version.
    std::fs::write(dir.path().join(FILE), r#"{"claude":{"path":"/a/claude"}}"#).unwrap();
    let old = load(dir.path());
    assert_eq!(old.schema_version, 1);
    assert_eq!(old.claude, Some(ToolSeen { path: "/a/claude".into(), version: String::new() }));
    assert_eq!(old.codex, None);

    // Keys a later build may add are read past.
    std::fs::write(
        dir.path().join(FILE),
        r#"{"schemaVersion":1,"codex":{"path":"/b/codex","version":"0.171.0","channel":"npm"},"gh":{}}"#,
    )
    .unwrap();
    assert_eq!(load(dir.path()).codex, Some(seen("/b/codex", "0.171.0")));

    // Written as it is read.
    let record = SeenRecord { schema_version: 1, claude: Some(seen(CLAUDE, "2.1.330")), codex: None };
    crate::atomic::write_atomic_json(&dir.path().join(FILE), &record).unwrap();
    assert_eq!(load(dir.path()), record);

    // Not JSON: set aside beside itself, read as no record (a first look).
    std::fs::write(dir.path().join(FILE), "{not json").unwrap();
    assert_eq!(load(dir.path()), SeenRecord::default());
    assert!(!dir.path().join(FILE).exists());
    let aside = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().starts_with("cli-seen.json.unreadable-"));
    assert!(aside, "the unreadable file is kept beside");
}

// ── The session's state (`Core`), as the global wrappers drive it ──────

fn env(claude: Option<(&str, Option<&str>)>, codex: Option<(&str, Option<&str>)>) -> ShellEnv {
    ShellEnv {
        claude_path: claude.map(|c| c.0.to_string()),
        claude_version: claude.and_then(|c| c.1.map(str::to_string)),
        claude_version_unknown: claude.is_some_and(|c| c.1.is_none()),
        codex_path: codex.map(|c| c.0.to_string()),
        codex_version: codex.and_then(|c| c.1.map(str::to_string)),
        codex_version_unknown: codex.is_some_and(|c| c.1.is_none()),
        ..ShellEnv::default()
    }
}

const CODEX: &str = "/Users/me/.local/bin/codex";

fn ok(_: &SeenRecord) -> Result<(), String> {
    Ok(())
}

fn record(claude: &str, codex: &str) -> SeenRecord {
    SeenRecord { schema_version: 1, claude: Some(seen(CLAUDE, claude)), codex: Some(seen(CODEX, codex)) }
}

fn look(core: &mut Core, e: &ShellEnv, now: Instant) -> bool {
    core.observe_with(e, now, Some("/Users/me"), false, ok)
}

#[test]
fn a_change_is_queued_once_and_taken_once() {
    let mut core = Core::new(record("2.1.322", "0.166.0"));
    let now = Instant::now();
    let e = env(Some((CLAUDE, Some("2.1.330"))), Some((CODEX, Some("0.166.0"))));
    assert!(look(&mut core, &e, now));
    let taken = core.take();
    assert_eq!(taken.len(), 1);
    assert!(matches!(&taken[0], Notice::Changed { tool: "claude", version_now: Some(v), .. } if v == "2.1.330"));
    assert!(core.take().is_empty(), "taken once");
    assert!(!look(&mut core, &e, now), "the same look again says nothing");
    assert!(core.take().is_empty());
}

#[test]
fn an_own_change_is_quiet_only_for_its_tool_and_only_until_its_look_ends() {
    let mut core = Core::new(record("2.1.322", "0.166.0"));
    let now = Instant::now();
    core.mark_own(&[Cli::Codex], now);
    let both = env(Some((CLAUDE, Some("2.1.330"))), Some((CODEX, Some("0.171.0"))));
    assert!(look(&mut core, &both, now), "Claude, not marked, is told");
    let taken = core.take();
    assert_eq!(taken.len(), 1);
    assert!(matches!(&taken[0], Notice::Changed { tool: "claude", .. }));
    assert_eq!(core.record.codex, Some(seen(CODEX, "0.171.0")), "Codex remembered quietly");

    // A run that changed nothing: its look ends, the mark goes with it.
    core.mark_own(&[Cli::Codex], now);
    assert!(!look(&mut core, &both, now));
    core.end_own(&[Cli::Codex]);
    let later = env(Some((CLAUDE, Some("2.1.330"))), Some((CODEX, Some("0.172.0"))));
    assert!(look(&mut core, &later, now), "a change after the run's look is told");
    assert!(matches!(&core.take()[0], Notice::Changed { tool: "codex", .. }));
}

#[test]
fn a_mark_never_ended_stops_counting_after_its_window() {
    let mut core = Core::new(record("2.1.322", "0.166.0"));
    let start = Instant::now();
    core.mark_own(&[Cli::Codex], start);
    let e = env(Some((CLAUDE, Some("2.1.322"))), Some((CODEX, Some("0.171.0"))));
    assert!(look(&mut core, &e, start + OWN_CHANGE_WINDOW), "an expired mark is no mark");
    assert_eq!(core.own, [None, None]);
}

#[test]
fn the_persons_program_folders_change_is_quiet() {
    // `settings_set` holds an OwnChange for both tools around its re-probe.
    let mut core = Core::new(record("2.1.322", "0.166.0"));
    let now = Instant::now();
    core.mark_own(&[Cli::Claude, Cli::Codex], now);
    let moved = env(Some(("/opt/override/claude", Some("2.1.322"))), Some(("/opt/override/codex", Some("0.166.0"))));
    assert!(!look(&mut core, &moved, now));
    core.end_own(&[Cli::Claude, Cli::Codex]);
    assert!(core.take().is_empty());
    assert_eq!(core.record.codex, Some(seen("/opt/override/codex", "0.166.0")));
}

#[test]
fn an_unknown_version_that_reads_the_same_later_says_nothing() {
    let mut core = Core::new(record("2.1.322", "0.166.0"));
    let now = Instant::now();
    let slow = env(Some((CLAUDE, None)), Some((CODEX, None)));
    let written = std::cell::Cell::new(0);
    assert!(!core.observe_with(&slow, now, None, false, |_| {
        written.set(written.get() + 1);
        Ok(())
    }));
    assert_eq!(written.get(), 0, "nothing to write");
    let same = env(Some((CLAUDE, Some("2.1.322"))), Some((CODEX, Some("0.166.0"))));
    assert!(!look(&mut core, &same, now));
    assert!(core.take().is_empty());
}

#[test]
fn a_record_that_cant_be_written_still_holds_for_the_session() {
    let mut core = Core::new(record("2.1.322", "0.166.0"));
    let now = Instant::now();
    let fail = |_: &SeenRecord| Err::<(), String>("read-only".into());
    let new = env(Some((CLAUDE, Some("2.1.330"))), Some((CODEX, Some("0.166.0"))));
    assert!(core.observe_with(&new, now, None, false, fail));
    assert!(core.write_failed);
    assert_eq!(core.take().len(), 1);
    // Back and forth between the two copies: the notice already told this
    // session isn't queued again.
    let old = env(Some((CLAUDE, Some("2.1.322"))), Some((CODEX, Some("0.166.0"))));
    assert!(core.observe_with(&old, now, None, false, fail));
    assert!(!core.observe_with(&new, now, None, false, fail), "told before: not again");
    assert_eq!(core.take().len(), 1, "only the way back was new");
}

#[test]
fn a_re_check_is_told_once_per_tool_and_version() {
    let mut core = Core::default();
    assert!(core.probe_starting_with(Provider::Codex, "0.171.0"));
    assert!(!core.probe_starting_with(Provider::Codex, "0.171.0"), "given back and claimed again: not again");
    assert!(core.probe_starting_with(Provider::Claude, "0.171.0"));
    assert!(core.probe_starting_with(Provider::Codex, "0.172.0"));
    assert!(!core.probe_starting_with(Provider::Codex, ""));
    let taken = core.take();
    assert_eq!(taken.len(), 3);
    assert_eq!(taken[0], Notice::Checking { tool: "codex", version: "0.171.0".into() });
    assert!(core.take().is_empty());
}

/// 1.176.1 walk (steps 9 and 15): Program folders that find no tool, then
/// put back by Settings (both tools marked) or by Repair (only the repaired
/// tool marked), each tool back at the same place: nothing is announced,
/// and a tool vanishing is never told as a change.
#[test]
fn the_walks_program_folders_sequence_announces_nothing() {
    let now = Instant::now();
    let whole = env(Some((CLAUDE, Some("2.1.330"))), Some((CODEX, Some("0.171.0"))));
    let nothing = env(None, None);
    for marked in [&[Cli::Claude, Cli::Codex][..], &[Cli::Claude][..], &[][..]] {
        let mut core = Core::new(record("2.1.330", "0.171.0"));
        let before = core.record.clone();
        assert!(!look(&mut core, &whole, now));
        assert!(!look(&mut core, &nothing, now), "a vanished tool is not a change");
        assert_eq!(core.record, before, "what was seen is kept while the tools are gone");
        core.mark_own(marked, now);
        assert!(!look(&mut core, &whole, now), "back at the same place ({marked:?})");
        core.end_own(marked);
        assert!(core.take().is_empty(), "{marked:?}");
        assert_eq!(core.record, before);
    }
}
