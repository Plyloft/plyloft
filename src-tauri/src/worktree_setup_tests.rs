//! SL-4: the copy rules, the one-time question, the setup command and the
//! backward-compatible loads.

use super::*;
use std::fs;

fn git(dir: &Path, args: &[&str]) {
    let out = crate::platform::git_command()
        .args(["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = join_rel(root, rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A main checkout with tracked, ignored and untracked files, and a card
/// worktree made from it the way `ensure_for_card` makes one.
struct Repo {
    _dir: tempfile::TempDir,
    main: PathBuf,
    worktree: PathBuf,
}

fn repo() -> Repo {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("main");
    fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    // Git for Windows defaults to core.autocrlf=true, which would check the
    // tracked README out as CRLF in the worktree: pin the bytes git writes so
    // "left untouched" is compared exactly.
    git(&main, &["config", "core.autocrlf", "false"]);
    write(&main, ".gitignore", ".env\n.env.*\n!.env.example\nsecrets/\nnode_modules/\n.atelier-worktrees/\n");
    write(&main, "README.md", "tracked\n");
    write(&main, ".env.example", "KEY=\n");
    write(&main, "apps/web/package.json", "{}\n");
    git(&main, &["add", "-A"]);
    git(&main, &["commit", "-q", "-m", "init"]);
    // Ignored, untracked.
    write(&main, ".env", "SECRET=main\n");
    write(&main, ".env.local", "LOCAL=1\n");
    write(&main, "apps/web/.env", "WEB=1\n");
    write(&main, "secrets/key.pem", "PEM\n");
    write(&main, "secrets/nested/a.txt", "A\n");
    write(&main, "node_modules/x/index.js", "x\n");
    // Untracked, not ignored.
    write(&main, "notes.txt", "mine\n");
    let worktree = main.join(".atelier-worktrees").join("card1");
    fs::create_dir_all(worktree.parent().unwrap()).unwrap();
    git(&main, &["worktree", "add", "-q", worktree.to_str().unwrap(), "-b", "card1"]);
    Repo { _dir: dir, main, worktree }
}

fn entries(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn skipped_reason<'a>(report: &'a CopyReport, path: &str) -> &'a str {
    report
        .skipped
        .iter()
        .find(|s| s.path == path)
        .map(|s| s.reason.as_str())
        .unwrap_or_else(|| panic!("{path} not skipped: {report:?}"))
}

// ── Entries ───────────────────────────────────────────────────────────

#[test]
fn an_entry_is_a_relative_path_shared_with_every_platform() {
    assert_eq!(copy_entry_problem(".env"), None);
    assert_eq!(copy_entry_problem("apps/*/.env.local"), None);
    assert_eq!(copy_entry_problem("**/.env"), None);
    assert_eq!(copy_entry_problem("secrets/"), None);
    for bad in ["", "  ", "/etc/passwd", "C:/x", "\\\\server\\x", "a\\b", "../x", "a/../b", "./a", "a//b", ".git", ".git/config"] {
        assert!(copy_entry_problem(bad).is_some(), "{bad:?} accepted");
    }
    assert!(copy_entry_problem(&"a".repeat(MAX_ENTRY_CHARS + 1)).is_some());

    assert_eq!(
        normalize_copy(entries(&[" .env ", "secrets/", ".env", "secrets"])).unwrap(),
        Some(entries(&[".env", "secrets"])),
        "trimmed, trailing / dropped, duplicates collapsed in order"
    );
    assert_eq!(normalize_copy(Vec::new()).unwrap(), None, "empty means none");
    assert!(normalize_copy(entries(&["../x"])).unwrap_err().contains("../x"));
    let many: Vec<String> = (0..=MAX_COPY_ENTRIES).map(|i| format!("f{i}")).collect();
    assert!(normalize_copy(many).is_err());

    assert_eq!(normalize_setup(Some("  npm ci \n".into())).unwrap(), Some("npm ci".into()));
    assert_eq!(normalize_setup(Some("   ".into())).unwrap(), None);
    assert_eq!(normalize_setup(None).unwrap(), None);
    assert!(normalize_setup(Some("x".repeat(MAX_SETUP_CHARS + 1))).is_err());
}

// ── The copy ──────────────────────────────────────────────────────────

#[test]
fn ignored_files_are_copied_byte_for_byte() {
    let r = repo();
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&[".env", "apps/*/.env"]));
    assert_eq!(report.copied, entries(&[".env", "apps/web/.env"]), "{report:?}");
    assert!(report.skipped.is_empty() && report.unmatched.is_empty(), "{report:?}");
    assert_eq!(fs::read_to_string(r.worktree.join(".env")).unwrap(), "SECRET=main\n");
    assert_eq!(fs::read_to_string(r.worktree.join("apps/web/.env")).unwrap(), "WEB=1\n");
}

#[test]
fn globs_follow_git_rules_for_separators() {
    let r = repo();
    // `*` stays in one folder; `**` crosses them, the root included.
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&["*/.env"]));
    assert_eq!(report.unmatched, entries(&["*/.env"]), "{report:?}");
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&["**/.env"]));
    assert_eq!(report.copied, entries(&[".env", "apps/web/.env"]), "{report:?}");
    // `.env*` names the template too, which is tracked: left alone.
    let r = repo();
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&[".env*"]));
    assert_eq!(report.copied, entries(&[".env", ".env.local"]), "{report:?}");
    assert!(skipped_reason(&report, ".env.example").contains("not git-ignored"));
    // Never into Git's folder, a dependency folder only when named.
    assert!(!report.copied.iter().any(|p| p.contains("node_modules")));
}

#[test]
fn a_folder_copies_the_files_under_it() {
    let r = repo();
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&["secrets/"]));
    assert_eq!(report.copied, entries(&["secrets/key.pem", "secrets/nested/a.txt"]), "{report:?}");
    assert_eq!(fs::read_to_string(r.worktree.join("secrets/nested/a.txt")).unwrap(), "A\n");
}

#[test]
fn only_ignored_files_are_copied_and_nothing_is_overwritten() {
    let r = repo();
    // Someone's own file already in the worktree, and a tracked one.
    fs::write(r.worktree.join(".env"), "mine\n").unwrap();
    let report = copy_into_worktree(
        &r.main,
        &r.worktree,
        &entries(&[".env", "README.md", "notes.txt", ".env.local"]),
    );
    assert_eq!(report.copied, entries(&[".env.local"]), "{report:?}");
    assert!(skipped_reason(&report, ".env").contains("already in the worktree"));
    assert!(skipped_reason(&report, "README.md").contains("not git-ignored"), "tracked");
    assert!(skipped_reason(&report, "notes.txt").contains("not git-ignored"), "untracked");
    assert_eq!(fs::read_to_string(r.worktree.join(".env")).unwrap(), "mine\n", "kept");
    assert_eq!(fs::read_to_string(r.worktree.join("README.md")).unwrap(), "tracked\n");
    assert!(!r.worktree.join("notes.txt").exists());
}

#[test]
fn missing_sources_and_bad_entries_are_reported_not_fatal() {
    let r = repo();
    let report = copy_into_worktree(
        &r.main,
        &r.worktree,
        &entries(&["config/.env.production", "../outside", "/etc/hosts", ".env"]),
    );
    assert_eq!(report.copied, entries(&[".env"]));
    assert_eq!(report.unmatched, entries(&["config/.env.production"]));
    assert!(skipped_reason(&report, "../outside").contains("no . or .."));
    assert!(skipped_reason(&report, "/etc/hosts").contains("relative"));
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_never_copied_or_followed_out() {
    let r = repo();
    std::os::unix::fs::symlink(r.main.join(".env"), r.main.join(".env.link")).unwrap();
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&[".env.link", ".env.*"]));
    assert!(skipped_reason(&report, ".env.link").contains("symbolic link"));
    assert_eq!(report.copied, entries(&[".env.local"]), "{report:?}");
    assert!(fs::symlink_metadata(r.worktree.join(".env.link")).is_err());

    // A tracked link to a folder outside the worktree does not carry a
    // file out of it.
    let r = repo();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), r.worktree.join("secrets")).unwrap();
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&["secrets/key.pem"]));
    assert!(report.copied.is_empty(), "{report:?}");
    assert!(!outside.path().join("key.pem").exists());
}

// ── The one-time question ─────────────────────────────────────────────

#[test]
fn the_question_lists_the_ignored_env_files_only() {
    let r = repo();
    assert_eq!(
        env_candidates(&r.main),
        entries(&[".env", ".env.local", "apps/web/.env"]),
        "not the tracked template, not what sits in an ignored folder"
    );
    assert!(is_env_file(".env") && is_env_file("a/.env.production"));
    assert!(!is_env_file(".env.example") && !is_env_file("env") && !is_env_file(".envrc"));
    assert_eq!(repo_root(&r.main.join("apps/web")), crate::platform::canonicalize(&r.main).unwrap());
}

#[test]
fn the_question_is_asked_once_and_the_answer_is_kept() {
    let found = entries(&[".env", "apps/web/.env"]);
    let mut settings = WorktreeSettings::default();
    assert_eq!(env_proposal(&settings, found.clone()), found, "nothing configured, never asked");
    assert!(env_proposal(&settings, Vec::new()).is_empty(), "nothing to copy, nothing asked");

    // No: remembered, not asked again, nothing configured.
    answer_env_proposal(&mut settings, EnvProposalAnswer::DontCopy, &found).unwrap();
    assert_eq!(settings.env_proposal, Some(EnvProposalAnswer::DontCopy));
    assert!(!settings.configured());
    assert!(env_proposal(&settings, found.clone()).is_empty());

    // Yes: into `worktreeCopy`, after what is there.
    let mut settings = WorktreeSettings { worktree_setup: None, ..Default::default() };
    answer_env_proposal(&mut settings, EnvProposalAnswer::Copy, &found).unwrap();
    assert_eq!(settings.worktree_copy, Some(found.clone()));
    assert!(env_proposal(&settings, found.clone()).is_empty());

    // A repository that already lists what worktrees get is not asked about.
    let listed = WorktreeSettings { worktree_copy: Some(entries(&["secrets/"])), ..Default::default() };
    assert!(env_proposal(&listed, found.clone()).is_empty());

    // F2: a setup command copies nothing, so it doesn't answer the question.
    let setup_only = WorktreeSettings { worktree_setup: Some("npm ci".into()), ..Default::default() };
    assert_eq!(env_proposal(&setup_only, found.clone()), found);
    let answered = WorktreeSettings { env_proposal: Some(EnvProposalAnswer::DontCopy), ..setup_only };
    assert!(env_proposal(&answered, found).is_empty());
}

#[test]
fn settings_round_trip_atomically_and_old_files_load() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    // Tier 2: no file, an empty object, a file with keys from a newer Plyloft.
    assert_eq!(load_settings(&store, "ws"), WorktreeSettings::default());
    let path = settings_path(&store, "ws");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "{}").unwrap();
    assert_eq!(load_settings(&store, "ws"), WorktreeSettings::default());
    fs::write(&path, r#"{"worktreeSetup":"npm ci","later":true}"#).unwrap();
    assert_eq!(load_settings(&store, "ws").setup_command(), Some("npm ci"));
    fs::write(&path, "not json").unwrap();
    assert_eq!(load_settings(&store, "ws"), WorktreeSettings::default(), "unreadable reads as none");

    let settings = WorktreeSettings {
        worktree_copy: Some(entries(&[".env"])),
        worktree_setup: Some("  ".into()),
        env_proposal: Some(EnvProposalAnswer::Copy),
        approved_setup: None,
        approved_try: None,
        ..Default::default()
    };
    save_settings(&store, "ws", &settings).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("worktreeSetup"), "an empty command is stored as none: {text}");
    let back = load_settings(&store, "ws");
    assert_eq!(back.worktree_copy, Some(entries(&[".env"])));
    assert_eq!(back.env_proposal, Some(EnvProposalAnswer::Copy));
    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "no temp file left behind");
}

// ── The setup command ─────────────────────────────────────────────────

/// Settings whose command this Mac typed (and so agreed to run).
fn own(mut settings: WorktreeSettings) -> WorktreeSettings {
    settings.approved_setup = settings.worktree_setup.clone();
    settings
}

fn test_path() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
}

#[test]
fn nothing_configured_records_nothing() {
    let r = repo();
    assert_eq!(
        prepare_worktree(&r.main, &r.worktree, &WorktreeSettings::default(), &test_path(), &[], Duration::from_secs(5)),
        None
    );
}

#[cfg(unix)]
#[test]
fn a_passing_setup_runs_in_the_worktree_after_the_copy() {
    let r = repo();
    let settings = own(WorktreeSettings {
        worktree_copy: Some(entries(&[".env"])),
        // The copied file is there when the command runs.
        worktree_setup: Some("test -f .env && echo prepared > prepared.txt && echo done".into()),
        ..Default::default()
    });
    let record = prepare_worktree(&r.main, &r.worktree, &settings, &test_path(), &[], Duration::from_secs(20)).unwrap();
    assert_eq!(record.state, WorktreeSetupState::Done, "{record:?}");
    assert!(!record.blocks_start());
    assert_eq!(record.copied, entries(&[".env"]));
    assert_eq!(record.exit_code, Some(0));
    assert!(record.log.contains("done"));
    assert_eq!(record.reason, None);
    assert!(r.worktree.join("prepared.txt").exists());
    assert!(!r.main.join("prepared.txt").exists(), "never in the main checkout");
}

#[test]
fn the_setup_command_gets_the_worktree_port_block() {
    let r = repo();
    let settings = own(WorktreeSettings {
        worktree_setup: Some("echo \"ports $PLYLOFT_PORT_BASE $PLYLOFT_PORT_COUNT\"".into()),
        ..Default::default()
    });
    let ports = crate::worktree_ports::port_env(41020);
    let record = prepare_worktree(&r.main, &r.worktree, &settings, &test_path(), &ports, Duration::from_secs(20)).unwrap();
    assert_eq!(record.state, WorktreeSetupState::Done, "{record:?}");
    assert!(record.log.contains("ports 41020 10"), "{}", record.log);
}

#[cfg(unix)]
#[test]
fn a_failing_setup_blocks_the_start_with_its_log() {
    let r = repo();
    let settings = own(WorktreeSettings {
        worktree_setup: Some("echo installing; echo 'npm ERR! boom' >&2; exit 3".into()),
        ..Default::default()
    });
    let record = prepare_worktree(&r.main, &r.worktree, &settings, &test_path(), &[], Duration::from_secs(20)).unwrap();
    assert_eq!(record.state, WorktreeSetupState::Failed);
    assert!(record.blocks_start());
    assert_eq!(record.exit_code, Some(3));
    assert!(record.reason.as_deref().unwrap().contains("exit code 3"));
    assert!(record.log.contains("installing") && record.log.contains("npm ERR! boom"), "{}", record.log);
    assert_eq!(record.command.as_deref(), Some(settings.worktree_setup.as_deref().unwrap()));
}

#[cfg(unix)]
#[test]
fn a_setup_over_its_time_is_stopped_with_what_it_printed() {
    let r = repo();
    let settings = own(WorktreeSettings {
        worktree_setup: Some("echo started; (sleep 30; touch late.txt) & sleep 30".into()),
        ..Default::default()
    });
    let started = std::time::Instant::now();
    let record = prepare_worktree(&r.main, &r.worktree, &settings, &test_path(), &[], Duration::from_secs(1)).unwrap();
    assert!(started.elapsed() < Duration::from_secs(10), "bounded");
    assert_eq!(record.state, WorktreeSetupState::Failed);
    assert!(record.timed_out);
    assert_eq!(record.exit_code, None);
    assert!(record.reason.as_deref().unwrap().contains("stopped after 1 second."), "{:?}", record.reason);
    assert!(record.log.contains("started"), "{}", record.log);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!r.worktree.join("late.txt").exists(), "its background child went with it");
}

/// F1 (walk of v1.154.0): Plyloft › Quit left an allowed setup running
/// (`sleep 600 && echo …`, bash and its sleep, reparented to launchd). The
/// setup runs in the verify steps' registry; quitting it — what the exit
/// cleanup's `verify::kill_active_steps` does — kills the whole group.
#[cfg(unix)]
#[test]
fn quitting_kills_a_running_setup_with_its_whole_group() {
    let r = repo();
    let settings = own(WorktreeSettings {
        worktree_setup: Some("echo $$ > setup.pgid; sleep 600 && echo teammate-setup".into()),
        ..Default::default()
    });
    let groups = crate::worktrees::FetchRegistry::refusing_with("quitting");
    let started = std::time::Instant::now();
    std::thread::scope(|scope| {
        let run = scope.spawn(|| {
            prepare_worktree_in(&groups, &r.main, &r.worktree, &settings, &test_path(), &[], Duration::from_secs(900), None)
        });
        let pgid_file = r.worktree.join("setup.pgid");
        let pgid: i32 = loop {
            if let Some(pgid) = fs::read_to_string(&pgid_file).ok().and_then(|s| s.trim().parse().ok()) {
                break pgid;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "the setup started");
            std::thread::sleep(Duration::from_millis(20));
        };
        // Give bash the moment to start its sleep.
        std::thread::sleep(Duration::from_millis(200));
        // SAFETY: signal 0 only probes the group.
        assert_eq!(unsafe { libc::kill(-pgid, 0) }, 0, "the setup's group is running");

        assert_eq!(groups.shutdown(), 1, "the exit cleanup finds the setup");
        let record = run.join().unwrap().unwrap();
        assert!(started.elapsed() < Duration::from_secs(20), "the setup didn't run its 600 seconds");
        assert_eq!(record.state, WorktreeSetupState::Failed);
        assert!(!record.log.contains("teammate-setup"), "{}", record.log);
        // v1.154.1 (K2): the card says Plyloft quit, not "failed (exit code -1)".
        assert_eq!(record.reason.as_deref(), Some(INTERRUPTED_REASON));
        assert_eq!(record.exit_code, None);

        let gone = std::time::Instant::now();
        // SAFETY: as above.
        while unsafe { libc::kill(-pgid, 0) } == 0 {
            assert!(gone.elapsed() < Duration::from_secs(5), "bash and its sleep outlived the quit");
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    // Once quitting, no new setup starts.
    let refused = prepare_worktree_in(&groups, &r.main, &r.worktree, &settings, &test_path(), &[], Duration::from_secs(5), None).unwrap();
    assert_eq!(refused.state, WorktreeSetupState::Failed);
    // v1.154.1 (K2): a setup refused because the quit had begun didn't
    // finish because of the quit, and says so.
    assert_eq!(refused.reason.as_deref(), Some(INTERRUPTED_REASON));
}

#[test]
fn the_log_keeps_the_end_on_a_character_boundary() {
    let long = format!("{}é-end", "x".repeat(LOG_TAIL_BYTES));
    let kept = tail(&long, LOG_TAIL_BYTES);
    assert!(kept.len() <= LOG_TAIL_BYTES && kept.ends_with("é-end"));
    assert_eq!(tail("short", LOG_TAIL_BYTES), "short");
    assert_eq!(duration_words(1), "1 second");
    assert_eq!(duration_words(40), "40 seconds");
    assert_eq!(duration_words(SETUP_TIMEOUT_SECS), "15 minutes");
    assert_eq!(duration_words(61), "2 minutes");
}

// ── The record on the card ────────────────────────────────────────────

#[test]
fn a_card_from_before_the_setup_record_loads_without_one() {
    // Tier 2: a board card written before SL-4.
    let old = r#"{
        "id": "c1", "workspaceId": "ws", "title": "old", "columnId": "in_progress",
        "worktreePath": "/r/.atelier-worktrees/c1", "createdAt": 1, "updatedAt": 2
    }"#;
    let card: crate::kanban::KanbanCard = serde_json::from_str(old).unwrap();
    assert_eq!(card.worktree_setup, None);
    let out = serde_json::to_value(&card).unwrap();
    assert!(out.get("worktreeSetup").is_none(), "not written when absent: {out}");

    // A record round-trips under its camelCase keys, and a minimal one loads.
    let minimal = r#"{ "state": "failed", "at": 5 }"#;
    let record: WorktreeSetupRecord = serde_json::from_str(minimal).unwrap();
    assert!(record.blocks_start() && record.log.is_empty() && record.copied.is_empty());
    let skipped: WorktreeSetupRecord = serde_json::from_str(r#"{ "state": "skipped", "at": 5 }"#).unwrap();
    assert!(!skipped.blocks_start());
    let full = WorktreeSetupRecord {
        state: WorktreeSetupState::Done,
        copied: entries(&[".env"]),
        skipped: vec![CopySkip { path: "a".into(), reason: "b".into() }],
        unmatched: entries(&["c"]),
        command: Some("npm ci".into()),
        exit_code: Some(0),
        timed_out: false,
        reason: None,
        approval_needed: false,
        log: "ok".into(),
        elapsed_ms: 12,
        at: 7,
    };
    let json = serde_json::to_value(&full).unwrap();
    assert_eq!(json["exitCode"], 0);
    assert_eq!(json["elapsedMs"], 12);
    assert_eq!(serde_json::from_value::<WorktreeSetupRecord>(json).unwrap(), full);
}

#[test]
fn a_set_record_persists_without_touching_updated_at() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = crate::kanban::KanbanCard::new(
        "c1".into(),
        "ws".into(),
        "Card".into(),
        None,
        crate::kanban::KanbanColumnId::Todo,
    );
    let updated_at = card.updated_at;
    store.save("ws", vec![card]).unwrap();
    let record: WorktreeSetupRecord = serde_json::from_str(r#"{ "state": "failed", "at": 5, "log": "boom" }"#).unwrap();
    let out = store.set_worktree_setup("ws", "c1", Some(record.clone())).unwrap();
    assert_eq!(out.worktree_setup, Some(record.clone()));
    assert_eq!(out.updated_at, updated_at);
    let reopened = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    assert_eq!(reopened.load("ws").unwrap()[0].worktree_setup, Some(record));
    assert!(reopened.set_worktree_setup("ws", "nope", None).is_err());
    assert_eq!(reopened.set_worktree_setup("ws", "c1", None).unwrap().worktree_setup, None);
}

// ── SL-4 review round 1 ───────────────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_command_this_mac_never_allowed_does_not_run() {
    let r = repo();
    // A teammate's command, never seen here.
    let theirs = WorktreeSettings { worktree_setup: Some("touch ran.txt".into()), ..Default::default() };
    assert!(!theirs.setup_allowed());
    let record = prepare_worktree(&r.main, &r.worktree, &theirs, &test_path(), &[], Duration::from_secs(20)).unwrap();
    assert_eq!(record.state, WorktreeSetupState::Failed);
    assert!(record.approval_needed && record.blocks_start());
    assert!(record.reason.as_deref().unwrap().contains("hasn't run on this Mac before: touch ran.txt"));
    assert!(!r.worktree.join("ran.txt").exists(), "not run");

    // This Mac allowed an earlier command; the repository changed it.
    let changed = WorktreeSettings { approved_setup: Some("npm ci".into()), ..theirs.clone() };
    let record = prepare_worktree(&r.main, &r.worktree, &changed, &test_path(), &[], Duration::from_secs(20)).unwrap();
    assert!(record.approval_needed);
    assert!(record.reason.as_deref().unwrap().starts_with("The repository's setup command changed: touch ran.txt"));
    assert!(!r.worktree.join("ran.txt").exists());

    // Allowed (typed here, or "Allow and run"): it runs.
    let record = prepare_worktree(&r.main, &r.worktree, &own(theirs), &test_path(), &[], Duration::from_secs(20)).unwrap();
    assert_eq!(record.state, WorktreeSetupState::Done, "{record:?}");
    assert!(!record.approval_needed);
    assert!(r.worktree.join("ran.txt").exists());
}

#[test]
fn an_allowed_command_is_kept_atomically_and_is_personal() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    let settings = own(WorktreeSettings { worktree_setup: Some(" npm ci ".into()), ..Default::default() });
    save_settings(&store, "ws", &settings).unwrap();
    let back = load_settings(&store, "ws");
    assert_eq!(back.approved_setup.as_deref(), Some("npm ci"));
    assert!(back.setup_allowed());
    let text = fs::read_to_string(settings_path(&store, "ws")).unwrap();
    assert!(text.contains("approvedSetup"), "{text}");
    // Tier 2: a file from before the field — nothing allowed yet.
    fs::write(settings_path(&store, "ws"), r#"{"worktreeSetup":"npm ci"}"#).unwrap();
    assert!(!load_settings(&store, "ws").setup_allowed());
    assert!(WorktreeSettings::default().setup_allowed(), "no command, nothing to allow");
}

#[test]
fn a_setup_left_running_by_a_plyloft_that_quit_is_failed() {
    let mut record = Some(WorktreeSetupRecord::running(Some("npm ci"), 5));
    assert!(record.as_ref().unwrap().blocks_start(), "running holds the Builder back");
    // Running in this process: left alone.
    let guard = begin("ws", "live").expect("claimed");
    assert!(begin("ws", "live").is_none(), "one setup per card");
    assert!(!settle_interrupted(&mut record, "ws", "live"));
    drop(guard);
    assert!(!is_in_flight("ws", "live"));
    // Nothing running it: failed, so Retry and Start anyway show.
    assert!(settle_interrupted(&mut record, "ws", "live"));
    let settled = record.unwrap();
    assert_eq!(settled.state, WorktreeSetupState::Failed);
    assert_eq!(settled.reason.as_deref(), Some(INTERRUPTED_REASON));

    // On load, from disk.
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let mut card = crate::kanban::KanbanCard::new("c1".into(), "ws".into(), "Card".into(), None, crate::kanban::KanbanColumnId::InProgress);
    card.worktree_setup = Some(WorktreeSetupRecord::running(None, 7));
    store.save("ws", vec![card]).unwrap();
    let reopened = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let loaded = reopened.load("ws").unwrap()[0].worktree_setup.clone().unwrap();
    assert_eq!(loaded.state, WorktreeSetupState::Failed);
    assert_eq!(loaded.reason.as_deref(), Some(INTERRUPTED_REASON));
}

#[test]
fn a_file_the_cards_branch_does_not_ignore_is_not_copied() {
    let r = repo();
    // The card's branch ignores `.env` but not `.env.local`.
    fs::write(r.worktree.join(".gitignore"), ".env\n").unwrap();
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&[".env", ".env.local"]));
    assert_eq!(report.copied, entries(&[".env"]), "{report:?}");
    assert!(skipped_reason(&report, ".env.local").contains("could be committed"));
    assert!(!r.worktree.join(".env.local").exists());
}

#[test]
fn a_retry_counts_what_the_first_copy_put_there_as_copied() {
    let r = repo();
    assert_eq!(copy_into_worktree(&r.main, &r.worktree, &entries(&[".env"])).copied, entries(&[".env"]));
    let again = copy_into_worktree(&r.main, &r.worktree, &entries(&[".env", ".env.local"]));
    assert_eq!(again.copied, entries(&[".env", ".env.local"]), "{again:?}");
    assert!(again.skipped.is_empty());
    // A different file there is still never overwritten.
    fs::write(r.worktree.join(".env"), "mine\n").unwrap();
    let third = copy_into_worktree(&r.main, &r.worktree, &entries(&[".env"]));
    assert!(skipped_reason(&third, ".env").contains("already in the worktree"));
    assert_eq!(fs::read_to_string(r.worktree.join(".env")).unwrap(), "mine\n");
}

#[test]
fn an_entry_over_the_walk_limit_copies_nothing() {
    let r = repo();
    let big = r.main.join("secrets/big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..=WALK_LIMIT {
        fs::write(big.join(format!("f{i}")), "").unwrap();
    }
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&["secrets"]));
    assert!(report.copied.is_empty(), "nothing of a half-walked folder: {} copied", report.copied.len());
    assert!(skipped_reason(&report, "secrets").contains("nothing of it was copied"));
    let report = copy_into_worktree(&r.main, &r.worktree, &entries(&["secrets/**/*"]));
    assert!(report.copied.is_empty());
    assert!(skipped_reason(&report, "secrets/**/*").contains("nothing was copied"));
}

/// v1.154.1 (K2): only a setup the quit ended reads as interrupted; one
/// that exited non-zero on its own (even while quitting) or timed out
/// keeps its own reason.
#[test]
fn only_a_setup_the_quit_ended_reads_as_interrupted() {
    assert!(ended_by_quit(true, false, false, Some(-1)), "killed: exit code -1");
    assert!(ended_by_quit(true, false, false, None), "killed by a signal");
    assert!(ended_by_quit(true, false, true, None), "refused: the quit had begun");
    assert!(!ended_by_quit(true, false, false, Some(3)), "a genuine failure while quitting");
    assert!(!ended_by_quit(true, true, false, None), "timed out");
    assert!(!ended_by_quit(false, false, false, Some(-1)), "not quitting");
}

// ── Try it: this Mac's approval of the start command (TRY_IT_SPEC §5.2) ─

#[test]
fn try_allowed_is_an_exact_trimmed_match() {
    assert!(try_allowed(None, None), "nothing to run, nothing to allow");
    assert!(try_allowed(Some("  "), None));
    assert!(!try_allowed(Some("npm run dev"), None));
    assert!(try_allowed(Some("npm run dev"), Some("npm run dev")));
    assert!(try_allowed(Some(" npm run dev "), Some("npm run dev  ")));
    assert!(!try_allowed(Some("npm run dev"), Some("npm run dev --host")));
    assert!(!try_allowed(Some("npm run dev"), Some("NPM RUN DEV")));
    let settings = WorktreeSettings { approved_try: Some("npm start".into()), ..Default::default() };
    assert!(settings.try_allowed(Some("npm start")));
    assert!(!settings.try_allowed(Some("npm run dev")), "a changed shared command asks again");
    // The setup's approval never stands in for the start command's.
    let setup_only = WorktreeSettings { approved_setup: Some("npm run dev".into()), ..Default::default() };
    assert!(!setup_only.try_allowed(Some("npm run dev")));
}

/// `worktree_setup.json` as v1.166 writes it (`write_atomic_json`, pretty).
const PRE_TRY_IT_WORKTREE: &str = r#"{
  "worktreeCopy": [
    ".env"
  ],
  "worktreeSetup": "npm ci",
  "envProposal": "copy",
  "approvedSetup": "npm ci"
}"#;

/// Tier 2: a pre-Try-it file loads with nothing approved for Try it; an
/// untouched save writes it back byte for byte; the new field round-trips;
/// a value of the wrong type reads as unset and keeps the rest of the file.
#[test]
fn pre_try_it_worktree_settings_load_without_an_approved_start_command() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    let path = settings_path(&store, "ws");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, PRE_TRY_IT_WORKTREE).unwrap();
    let loaded = load_settings(&store, "ws");
    assert_eq!(loaded.approved_try, None);
    assert_eq!(loaded.approved_setup.as_deref(), Some("npm ci"));
    assert!(!loaded.try_allowed(Some("npm run dev")));
    save_settings(&store, "ws", &loaded).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert_eq!(text, PRE_TRY_IT_WORKTREE, "an untouched file is written as it was");

    let mut with = loaded.clone();
    with.approved_try = Some(" npm run dev ".into());
    save_settings(&store, "ws", &with).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"approvedTry\": \"npm run dev\""), "{text}");
    let back = load_settings(&store, "ws");
    assert_eq!(back.approved_try.as_deref(), Some("npm run dev"));
    assert!(back.try_allowed(Some("npm run dev")));

    for bad in ["5", "false", "[\"npm run dev\"]", "{}"] {
        let text = PRE_TRY_IT_WORKTREE.replace(
            "\"approvedSetup\": \"npm ci\"",
            &format!("\"approvedSetup\": \"npm ci\",\n  \"approvedTry\": {bad}"),
        );
        fs::write(&path, text).unwrap();
        let odd = load_settings(&store, "ws");
        assert_eq!(odd.approved_try, None, "{bad}");
        assert_eq!(odd, loaded, "{bad}: the rest of the file is kept");
    }
}
