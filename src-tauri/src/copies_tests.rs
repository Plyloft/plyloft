use super::*;
use crate::branch_cleanup::CleanupOutcome;
use std::fs;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .output()
        .expect("spawn git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.email", "test@atelier.test"]);
    git(dir, &["config", "user.name", "atelier-test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn commit_file(dir: &Path, name: &str) -> String {
    fs::write(dir.join(name), format!("{name}\n")).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-q", "-m", name]);
    git(dir, &["rev-parse", "HEAD"])
}

/// A bare `origin`, the workspace clone and a second clone that pushes.
/// Returns (tempdir, workspace, other, registry dir).
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let seed = tmp.path().join("seed");
    fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    identity(&seed);
    fs::write(seed.join(".gitignore"), ".env\n").unwrap();
    git(&seed, &["add", ".gitignore"]);
    git(&seed, &["commit", "-q", "-m", "first"]);
    commit_file(&seed, "README.md");
    let origin = tmp.path().join("origin.git");
    git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
    let ws = tmp.path().join("ws");
    let other = tmp.path().join("other");
    for dir in [&ws, &other] {
        git(tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), dir.to_str().unwrap()]);
        identity(dir);
    }
    let registry = tmp.path().join("config").join("projects").join("w1");
    (tmp, ws, other, registry)
}

fn none(_: &Path) -> usize {
    0
}

fn not_running(_: &str) -> bool {
    false
}

fn make(place: Place<'_>, name: &str) -> CopyEntry {
    create(place, name, "main", Some("claude"), 1_000, crate::worktrees::resolve_base).unwrap()
}

#[test]
fn a_copy_starts_from_githubs_tip_in_its_own_folder_and_branch() {
    let (_tmp, ws, other, registry) = fixture();
    let stale = git(&ws, &["rev-parse", "main"]);
    let pushed = commit_file(&other, "from-the-other-mac.txt");
    git(&other, &["push", "-q", "origin", "main"]);
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };

    let copy = make(place, "Inbox: empty state!");

    assert!(is_copy_id(&copy.id), "{}", copy.id);
    let short = &copy.id[COPY_DIR_PREFIX.len()..];
    assert_eq!(copy.branch, format!("plyloft/copy-{short}-inbox-empty-state"));
    assert!(is_copy_branch(&copy.branch));
    assert!(!crate::worktrees::is_card_branch(&copy.branch), "a copy branch is never a card branch");
    assert_eq!(PathBuf::from(&copy.path), ws.join(crate::worktrees::WORKTREES_DIR).join(&copy.id));
    assert_eq!(copy.name, "Inbox: empty state!");
    assert_eq!(copy.base_branch, "main");
    assert_eq!(copy.base_commit, pushed, "from the fetched origin/main, not the stale local main");
    assert_eq!(copy.base_source, Some(BaseSource::Origin));
    assert_eq!(copy.open.as_deref(), Some("claude"));
    assert_eq!(copy.state, CopyState::Active);
    assert_eq!(git(Path::new(&copy.path), &["rev-parse", "--abbrev-ref", "HEAD"]), copy.branch);
    assert_eq!(git(&ws, &["rev-parse", "main"]), stale, "making a copy never moves main");
    // The main checkout doesn't see the copy as untracked work.
    assert_eq!(git(&ws, &["status", "--porcelain"]), "");
    // Listed, atomically written.
    let file = load(&registry);
    assert_eq!(file.copies, vec![copy.clone()]);
    assert_eq!(file.schema_version, SCHEMA_VERSION);
    assert!(!registry.join(format!("{COPIES_FILE}{}", crate::atomic::TEMP_SUFFIX)).exists());
}

#[test]
fn without_an_origin_a_copy_starts_from_the_local_branch() {
    let (_tmp, ws, _other, registry) = fixture();
    git(&ws, &["remote", "remove", "origin"]);
    let local = git(&ws, &["rev-parse", "main"]);
    let copy = make(Place { registry_dir: &registry, workspace_cwd: &ws }, "offline try");
    assert_eq!(copy.base_commit, local);
    assert_eq!(copy.base_source, Some(BaseSource::LocalNoRemote));
}

#[test]
fn a_copy_needs_a_branch_to_start_from() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    assert!(create(place, "x", "  ", None, 1, crate::worktrees::resolve_base).is_err());
    assert!(create(place, "x", "no-such-branch", None, 1, crate::worktrees::resolve_base).is_err());
    assert!(load(&registry).copies.is_empty(), "nothing listed for a copy that wasn't made");
}

#[test]
fn a_name_is_one_line_and_an_empty_one_takes_the_id() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let blank = make(place, "  \n ");
    assert_eq!(blank.name, blank.id);
    assert!(blank.branch.ends_with("-copy"), "{}", blank.branch);
    assert_eq!(clean_name("a\n  b\tc", "x"), "a b c");
    assert_eq!(clean_name(&"n".repeat(200), "x").chars().count(), 80);
    assert_eq!(copy_branch_name("1a2b3c4d", "!!!"), "plyloft/copy-1a2b3c4d-copy");
    assert_eq!(
        copy_branch_name("1a2b3c4d", &"long name ".repeat(10)).len(),
        "plyloft/copy-1a2b3c4d-".len() + 32
    );
}

#[test]
fn ids_are_only_the_ones_plyloft_makes() {
    assert!(is_copy_id("copy-1a2b3c4d"));
    for bad in ["copy-", "copy-1A2B3C4D", "copy-1a2b3c4", "copy-1a2b3c4d5", "card-1a2b3c4d", "copy-../x", ".trash"] {
        assert!(!is_copy_id(bad), "{bad}");
    }
}

#[test]
fn the_list_counts_every_changed_file_and_the_terminals_open_in_it() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "three files");
    let dir = PathBuf::from(&copy.path);
    commit_file(&dir, "committed.txt");
    fs::write(dir.join("README.md"), "edited\n").unwrap();
    fs::write(dir.join("new file.txt"), "untracked\n").unwrap();
    fs::write(dir.join(".env"), "ignored\n").unwrap();

    let open_here = |p: &Path| usize::from(p == dir.as_path());
    let rows = list(place, &open_here, &not_running);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.changed.count, 3, "{:?}", row.changed);
    assert_eq!(row.changed.files, vec!["README.md", "committed.txt", "new file.txt"]);
    assert!(!row.changed.unreadable);
    assert_eq!(row.terminals, 1);
    assert!(row.present && !row.restorable);
    // The row's JSON is the entry's own fields plus what was seen.
    let json = serde_json::to_value(row).unwrap();
    assert_eq!(json["id"], copy.id.as_str());
    assert_eq!(json["baseBranch"], "main");
    assert_eq!(json["state"], "active");
    assert_eq!(json["changed"]["count"], 3);
}

#[test]
fn the_list_names_at_most_five_files_and_puts_the_newest_copy_first() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let older = create(place, "older", "main", None, 10, crate::worktrees::resolve_base).unwrap();
    let newer = create(place, "newer", "main", None, 20, crate::worktrees::resolve_base).unwrap();
    for i in 0..7 {
        fs::write(Path::new(&older.path).join(format!("f{i}.txt")), "x").unwrap();
    }
    let rows = list(place, &none, &not_running);
    assert_eq!(rows.iter().map(|r| r.copy.id.as_str()).collect::<Vec<_>>(), [newer.id.as_str(), older.id.as_str()]);
    assert_eq!(rows[1].changed.count, 7);
    assert_eq!(rows[1].changed.files.len(), FIRST_FILES);
    assert_eq!(rows[0].changed.count, 0);
}

#[test]
fn a_running_setup_nothing_runs_reads_as_interrupted() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "setup");
    mark_setup_running(place, &copy.id, Some("npm ci"), 5).unwrap();
    let running = |_: &str| true;
    let rows = list(place, &none, &running);
    assert_eq!(rows[0].copy.setup.as_ref().unwrap().state, crate::worktree_setup::WorktreeSetupState::Running);
    let rows = list(place, &none, &not_running);
    let setup = rows[0].copy.setup.as_ref().unwrap();
    assert_eq!(setup.state, crate::worktree_setup::WorktreeSetupState::Failed);
    assert_eq!(setup.reason.as_deref(), Some(crate::worktree_setup::INTERRUPTED_REASON));
}

#[test]
fn the_setup_copies_the_ignored_files_into_the_copy_and_is_recorded() {
    let (_tmp, ws, _other, registry) = fixture();
    fs::write(ws.join(".env"), "SECRET=1\n").unwrap();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "with env");
    let settings = WorktreeSettings { worktree_copy: Some(vec![".env".into()]), ..Default::default() };
    let record = prepare(place, &copy, &settings, &std::env::var("PATH").unwrap_or_default(), Duration::from_secs(30))
        .unwrap()
        .expect("configured");
    assert_eq!(record.state, crate::worktree_setup::WorktreeSetupState::Done);
    assert_eq!(fs::read_to_string(Path::new(&copy.path).join(".env")).unwrap(), "SECRET=1\n");
    assert_eq!(load(&registry).copies[0].setup.as_ref(), Some(&record));
}

#[test]
fn throw_away_puts_the_copy_in_the_trash_and_undo_brings_it_back_whole() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "to the trash");
    let dir = PathBuf::from(&copy.path);
    let tip = commit_file(&dir, "work.txt");
    fs::write(dir.join("README.md"), "not committed yet\n").unwrap();

    let thrown = throw_away(place, &copy.id, &[], &none, false, 2_000).unwrap();
    assert_eq!(thrown.state, CopyState::Trashed);
    assert_eq!(thrown.trashed_at, Some(2_000));
    assert!(!dir.exists());
    let entry = PathBuf::from(thrown.trash_entry.clone().expect("a trash entry"));
    assert!(entry.is_dir());
    assert_eq!(entry.parent().unwrap().file_name().unwrap(), crate::worktrees::TRASH_DIR);
    let rec = thrown.branch_cleanup.clone().expect("the branch waits for the trash");
    assert_eq!(rec.reason, CleanupReason::Copy);
    assert_eq!((rec.branch.as_str(), rec.tip.as_str()), (copy.branch.as_str(), tip.as_str()));
    assert_eq!(rec.trash_entry.as_deref(), thrown.trash_entry.as_deref());
    assert_eq!(crate::worktrees::branch_tip(&ws, &copy.branch).as_deref(), Some(tip.as_str()), "the branch stays");

    let rows = list(place, &none, &not_running);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].restorable && !rows[0].present);
    assert!(throw_away(place, &copy.id, &[], &none, false, 2_001).unwrap_err().contains("already in the Trash"));

    let back = restore(place, &copy.id).unwrap();
    assert_eq!(back.state, CopyState::Active);
    assert_eq!(PathBuf::from(&back.path), dir);
    assert!(back.trash_entry.is_none() && back.trashed_at.is_none() && back.branch_cleanup.is_none());
    assert_eq!(fs::read_to_string(dir.join("README.md")).unwrap(), "not committed yet\n");
    assert_eq!(git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]), copy.branch);
    assert_eq!(git(&dir, &["status", "--porcelain"]), "M README.md");
    assert!(restore(place, &copy.id).unwrap_err().contains("isn't in the Trash"));
}

#[test]
fn throw_away_waits_for_open_terminals_and_a_running_setup() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "busy");
    let one = |_: &Path| 1;
    let err = throw_away(place, &copy.id, &[], &one, false, 2).unwrap_err();
    assert!(err.starts_with("A terminal is still open in this copy"), "{err}");
    let err = throw_away(place, &copy.id, &[], &none, true, 2).unwrap_err();
    assert!(err.contains("still being set up"), "{err}");
    assert!(Path::new(&copy.path).is_dir());
    assert_eq!(load(&registry).copies[0].state, CopyState::Active);
    assert!(throw_away(place, "copy-../../x", &[], &none, false, 2).is_err());
}

/// A thrown-away copy, its trash entry reaped and its week up.
fn expired(place: Place<'_>, name: &str) -> CopyEntry {
    let copy = make(place, name);
    commit_file(Path::new(&copy.path), "work.txt");
    let thrown = throw_away(place, &copy.id, &[], &none, false, 0).unwrap();
    fs::remove_dir_all(thrown.trash_entry.as_deref().unwrap()).unwrap();
    thrown
}

const WEEK_AND_A_DAY: i64 = crate::branch_cleanup::DUE_AFTER_MS + 86_400_000;

#[test]
fn the_sweep_deletes_an_expired_copys_branch_and_forgets_the_copy() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let thrown = expired(place, "gone");
    // Not yet due: nothing happens.
    assert!(!sweep(place, true, 1_000, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_some());

    assert!(sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_none(), "deleted at its recorded tip");
    assert!(load(&registry).copies.is_empty(), "nothing left of it to show");
    assert!(!sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
}

#[test]
fn the_sweep_keeps_the_branch_when_card_branches_are_kept_or_it_moved_on() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let kept = expired(place, "kept");
    // keepCardBranches on: the record waits, the copy is no longer listed.
    assert!(!sweep(place, false, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &kept.branch).is_some());
    assert_eq!(load(&registry).copies.len(), 1);
    assert!(list(place, &none, &not_running).is_empty());

    // A commit after it was thrown away keeps the branch for good.
    let moved = expired(place, "moved");
    let scratch = ws.join("scratch");
    git(&ws, &["worktree", "add", "-q", scratch.to_str().unwrap(), &moved.branch]);
    commit_file(&scratch, "later.txt");
    git(&ws, &["worktree", "remove", "--force", scratch.to_str().unwrap()]);
    assert!(sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &moved.branch).is_some());
    assert!(crate::worktrees::branch_tip(&ws, &kept.branch).is_none(), "switched on: the other one goes");
    let left = load(&registry).copies;
    assert!(left.is_empty(), "both settled: {left:?}");
}

#[test]
fn the_sweep_holds_a_branch_while_a_terminal_is_where_the_copy_was() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let thrown = expired(place, "held");
    let one = |_: &Path| 1;
    assert!(!sweep(place, true, WEEK_AND_A_DAY, &one).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_some());
    let rec = load(&registry).copies[0].branch_cleanup.clone().unwrap();
    assert!(rec.pending());
}

#[test]
fn a_copy_record_is_only_swept_for_a_copy_branch() {
    let (_tmp, ws, _other, _registry) = fixture();
    let tip = git(&ws, &["rev-parse", "main"]);
    let busy = || None;
    let skip = |rec: &BranchCleanup| {
        crate::branch_cleanup::sweep_copy_record(&ws, true, WEEK_AND_A_DAY, rec, false, &busy)
            == crate::branch_cleanup::Verdict::Skip
    };
    let mut rec = BranchCleanup::new("main", &tip, CleanupReason::Copy, 0, None);
    assert!(skip(&rec), "never the target");
    rec.branch = "plyloft/card-abc-x".into();
    assert!(skip(&rec), "never a card branch");
    rec.branch = "plyloft/copy-1a2b3c4d-x".into();
    rec.reason = CleanupReason::Shipped;
    assert!(skip(&rec), "only a copy's record");
    rec.reason = CleanupReason::Copy;
    rec.outcome = Some(CleanupOutcome::MovedOn);
    assert!(skip(&rec), "only a pending one");
}

// ── Schema migration: copies.json is new in 1.173.0 ──────────────────

#[test]
fn an_absent_registry_is_an_empty_list() {
    let tmp = tempfile::tempdir().unwrap();
    let file = load(tmp.path());
    assert!(file.copies.is_empty() && file.unread.is_empty());
    let (_t, ws, _o, _r) = fixture();
    assert!(list(Place { registry_dir: tmp.path(), workspace_cwd: &ws }, &none, &not_running).is_empty());
    assert!(!sweep(Place { registry_dir: tmp.path(), workspace_cwd: &ws }, true, 0, &none).unwrap());
    assert!(!registry_path(tmp.path()).exists(), "reading writes nothing");
}

#[test]
fn a_v1_registry_with_fields_and_states_this_build_doesnt_know_still_loads_and_keeps_them() {
    let tmp = tempfile::tempdir().unwrap();
    let v1 = r#"{
      "schemaVersion": 1,
      "laterTopLevel": {"x": 1},
      "copies": [
        {
          "id": "copy-1a2b3c4d", "name": "inbox", "branch": "plyloft/copy-1a2b3c4d-inbox",
          "path": "/w/.plyloft-worktrees/copy-1a2b3c4d", "baseBranch": "main", "baseCommit": "abc",
          "createdAt": 7, "state": "active", "cardId": "card-x", "pr": {"number": 12, "url": "https://github.com/o/r/pull/12"},
          "area": "site", "laterField": [1, 2]
        },
        { "id": "copy-5e6f7a8b", "name": "minimal" },
        { "id": "copy-9c0d1e2f", "baseSource": "fromTheFuture" },
        { "id": "copy-0a0b0c0d", "state": "madeIntoACard" },
        { "id": 42 }
      ]
    }"#;
    fs::write(registry_path(tmp.path()), v1).unwrap();
    let file = load(tmp.path());
    assert_eq!(file.copies.len(), 3, "{:?}", file.copies);
    let full = &file.copies[0];
    assert_eq!(full.name, "inbox");
    assert_eq!(full.card_id.as_deref(), Some("card-x"));
    assert_eq!(full.pr, Some(CopyPr { number: 12, url: "https://github.com/o/r/pull/12".into(), ..Default::default() }));
    assert_eq!(full.extra.get("area"), Some(&Value::from("site")));
    assert!(full.base_source.is_none() && full.trashed_at.is_none() && full.setup.is_none());
    let minimal = &file.copies[1];
    assert_eq!((minimal.state.clone(), minimal.created_at, minimal.branch.as_str()), (CopyState::Active, 0, ""));
    assert_eq!(file.copies[2].state, CopyState::Other("madeIntoACard".into()));
    assert_eq!(file.unread.len(), 2, "an entry this build can't read is kept as it is");

    // A write keeps everything it didn't change.
    update(tmp.path(), |f| {
        f.copies[1].name = "renamed".into();
        Ok(((), true))
    })
    .unwrap();
    let raw: Value = serde_json::from_slice(&fs::read(registry_path(tmp.path())).unwrap()).unwrap();
    assert_eq!(raw["laterTopLevel"]["x"], 1);
    let items = raw["copies"].as_array().unwrap();
    assert_eq!(items.len(), 5);
    assert_eq!(items[0]["laterField"], serde_json::json!([1, 2]));
    assert_eq!(items[0]["area"], "site");
    assert_eq!(items[1]["name"], "renamed");
    assert_eq!(items[2]["state"], "madeIntoACard");
    assert!(items.iter().any(|i| i["baseSource"] == "fromTheFuture"));
    assert!(items.iter().any(|i| i["id"] == 42));
    // A copy in a state this build doesn't know is never shown or acted on.
    let (_t, ws, _o, _r) = fixture();
    let place = Place { registry_dir: tmp.path(), workspace_cwd: &ws };
    assert!(list(place, &none, &not_running).iter().all(|r| r.copy.id != "copy-0a0b0c0d"));
    assert!(throw_away(place, "copy-0a0b0c0d", &[], &none, false, 1).is_err());
    assert!(restore(place, "copy-0a0b0c0d").is_err());
}

#[test]
fn a_registry_that_isnt_json_is_set_aside_before_the_next_write() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(registry_path(tmp.path()), "{ not json").unwrap();
    assert!(load(tmp.path()).copies.is_empty());
    update(tmp.path(), |f| {
        f.copies.push(CopyEntry { id: "copy-1a2b3c4d".into(), ..Default::default() });
        Ok(((), true))
    })
    .unwrap();
    assert_eq!(load(tmp.path()).copies.len(), 1);
    let aside: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("copies.json.unreadable-"))
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(fs::read_to_string(tmp.path().join(&aside[0])).unwrap(), "{ not json");
}

/// C17: reading alone sets an unreadable registry aside too, and the list
/// starts fresh; the next write never sees the old bytes.
#[test]
fn a_registry_that_isnt_json_is_set_aside_on_read() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(registry_path(tmp.path()), "{ not json").unwrap();
    assert!(load(tmp.path()).copies.is_empty(), "a fresh list");
    assert!(!registry_path(tmp.path()).exists(), "moved out of the way on read");
    let aside: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("copies.json.unreadable-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert_eq!(fs::read_to_string(tmp.path().join(&aside[0])).unwrap(), "{ not json");
    // Inside a write, a read leaves it to that write (no second lock).
    let inner = update(tmp.path(), |_| {
        fs::write(registry_path(tmp.path()), "{ again").unwrap();
        Ok((load(tmp.path()).copies.len(), false))
    })
    .unwrap();
    assert_eq!(inner, 0);
    assert_eq!(fs::read_to_string(registry_path(tmp.path())).unwrap(), "{ again", "left to the write");
}

/// C17: an unreadable registry that can't be set aside refuses the write
/// and is left as it is.
#[test]
#[cfg(unix)]
fn a_registry_that_cannot_be_set_aside_refuses_the_write() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("reg");
    fs::create_dir(&dir).unwrap();
    fs::write(registry_path(&dir), "{ not json").unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
    let wrote = update(&dir, |f| {
        f.copies.push(CopyEntry { id: "copy-1a2b3c4d".into(), ..Default::default() });
        Ok(((), true))
    });
    let read = load(&dir);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    let error = wrote.expect_err("no write over a file it couldn't move");
    assert!(error.contains("couldn't be set aside"), "{error}");
    assert!(read.copies.is_empty());
    assert_eq!(fs::read_to_string(registry_path(&dir)).unwrap(), "{ not json");
}

/// C17: a newer Plyloft's registry is read as far as this build can and
/// never written over.
#[test]
fn a_newer_plyloft_s_registry_refuses_the_write_and_is_left_as_it_is() {
    let tmp = tempfile::tempdir().unwrap();
    let newer = format!(r#"{{"schemaVersion":{},"copies":[]}}"#, SCHEMA_VERSION + 1);
    fs::write(registry_path(tmp.path()), &newer).unwrap();
    assert!(load(tmp.path()).copies.is_empty());
    let error = update(tmp.path(), |f| {
        f.copies.push(CopyEntry { id: "copy-1a2b3c4d".into(), ..Default::default() });
        Ok(((), true))
    })
    .expect_err("refused");
    assert_eq!(error, crate::atomic::newer_refusal("The list of copies", SCHEMA_VERSION + 1, SCHEMA_VERSION));
    assert_eq!(fs::read_to_string(registry_path(tmp.path())).unwrap(), newer);
}

// ── The boundaries ───────────────────────────────────────────────────

/// The card's own worktree is still made exactly as before the shared body.
#[test]
fn a_card_start_is_unchanged_beside_copies() {
    let (_tmp, ws, _other, registry) = fixture();
    let copy = make(Place { registry_dir: &registry, workspace_cwd: &ws }, "beside");
    let card = crate::worktrees::ensure_for_card(&ws, "card-moxa1-1", "A card", "main").unwrap();
    assert!(card.created);
    assert_eq!(card.branch_name, crate::worktrees::make_branch_name("card-moxa1-1", "A card"));
    assert_eq!(card.worktree_path, ws.join(crate::worktrees::WORKTREES_DIR).join("card-moxa1-1"));
    let again = crate::worktrees::ensure_for_card(&ws, "card-moxa1-1", "A card", "main").unwrap();
    assert!(!again.created, "idempotent");
    assert_ne!(card.worktree_path, PathBuf::from(&copy.path));
}

// ── Challenger round 1 ───────────────────────────────────────────────

fn give_to_card(registry: &Path, id: &str) {
    update(registry, |f| {
        f.copies.iter_mut().find(|c| c.id == id).unwrap().card_id = Some("card-x".into());
        Ok(((), true))
    })
    .unwrap();
}

#[test]
fn a_copy_given_to_a_card_is_not_listed_and_cannot_be_thrown_away() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "carded");
    give_to_card(&registry, &copy.id);
    assert!(list(place, &none, &not_running).is_empty());
    assert_eq!(throw_away(place, &copy.id, &[], &none, false, 1).unwrap_err(), IS_A_CARD_REFUSAL);
    assert!(Path::new(&copy.path).is_dir(), "the card's folder stays");
    let save = |_: &WorktreeSettings| Ok(());
    let err = stage_setup_retry(place, "w1", &copy.id, None, WorktreeSettings::default(), &save).err().unwrap();
    assert_eq!(err, IS_A_CARD_REFUSAL);
}

#[test]
fn a_thrown_away_copy_given_to_a_card_is_not_restored_or_swept() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let thrown = expired(place, "carded later");
    give_to_card(&registry, &thrown.id);
    assert_eq!(restore(place, &thrown.id).unwrap_err(), IS_A_CARD_REFUSAL);
    assert!(!sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_some(), "the card's branch stays");
    let left = load(&registry).copies;
    assert_eq!(left.len(), 1, "the entry stays for the card");
    assert!(left[0].branch_cleanup.as_ref().unwrap().pending());
}

#[test]
fn an_approval_needed_copy_runs_its_setup_after_allow() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "needs approval");
    let command = "echo ran > setup-ran.txt";
    let unapproved = WorktreeSettings { worktree_setup: Some(command.into()), ..Default::default() };
    let path_env = std::env::var("PATH").unwrap_or_default();
    let first = prepare(place, &copy, &unapproved, &path_env, Duration::from_secs(30)).unwrap().unwrap();
    assert!(first.approval_needed, "{first:?}");
    assert!(!Path::new(&copy.path).join("setup-ran.txt").exists());

    // A different command than the repository's is not approved.
    let saved = std::cell::RefCell::new(None::<WorktreeSettings>);
    let save = |s: &WorktreeSettings| {
        *saved.borrow_mut() = Some(s.clone());
        Ok(())
    };
    let SetupRetry::Run { entry, settings, in_flight } =
        stage_setup_retry(place, "w1", &copy.id, Some("rm -rf /"), unapproved.clone(), &save).ok().unwrap()
    else {
        panic!("configured: it runs")
    };
    assert!(saved.borrow().is_none());
    assert!(!settings.setup_allowed());
    drop(in_flight);
    drop(entry);

    let SetupRetry::Run { entry, settings, in_flight } =
        stage_setup_retry(place, "w1", &copy.id, Some(command), unapproved, &save).ok().unwrap()
    else {
        panic!("configured: it runs")
    };
    assert_eq!(saved.borrow().as_ref().unwrap().approved_setup.as_deref(), Some(command), "approved on this Mac");
    assert_eq!(load(&registry).copies[0].setup.as_ref().unwrap().state, crate::worktree_setup::WorktreeSetupState::Running);
    // A second Retry while it runs is refused.
    let again = stage_setup_retry(place, "w1", &copy.id, None, settings.clone(), &save).err().unwrap();
    assert_eq!(again, crate::worktree_setup::SETUP_RUNNING_REFUSAL);
    let done = prepare(place, &entry, &settings, &path_env, Duration::from_secs(30)).unwrap().unwrap();
    drop(in_flight);
    assert_eq!(done.state, crate::worktree_setup::WorktreeSetupState::Done, "{done:?}");
    assert!(Path::new(&copy.path).join("setup-ran.txt").exists());
    assert_eq!(load(&registry).copies[0].setup.as_ref(), Some(&done));

    // Nothing configured any more: the record is cleared.
    let SetupRetry::Cleared(cleared) =
        stage_setup_retry(place, "w1", &copy.id, None, WorktreeSettings::default(), &save).ok().unwrap()
    else {
        panic!("nothing to run")
    };
    assert!(cleared.setup.is_none());
}

#[test]
fn the_start_point_says_github_and_when_the_branch_was_read() {
    let (_tmp, ws, _other, _registry) = fixture();
    let before = crate::kanban::now_ms() - 60_000;
    git(&ws, &["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    let local = start_point(&ws, "main");
    assert_eq!(local.target, "main");
    assert!(!local.from_github, "a local-path origin is not GitHub");
    assert!(local.read_at.is_some_and(|t| t >= before), "{local:?}");
    assert!(start_point(&ws, "no-such-branch").read_at.is_none());

    git(&ws, &["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
    assert!(start_point(&ws, "main").from_github);
    git(&ws, &["remote", "remove", "origin"]);
    let none_left = start_point(&ws, "main");
    assert!(!none_left.from_github && none_left.read_at.is_none(), "{none_left:?}");
    assert_eq!(serde_json::to_value(&local).unwrap()["fromGitHub"], false);
}

// 1.174.0 E2 (P20): what a copy leaves out, read before it is made — the
// project folder's changed files and, only when this clone's branch and
// origin's have diverged, the steps origin lacks. Strictly ahead, the copy
// starts from this clone's branch (`resolve_base`'s LocalAhead) and carries
// them (Challenger 1, E2-1).
#[test]
fn the_start_point_counts_what_stays_out_of_a_copy() {
    let (_tmp, ws, other, _registry) = fixture();
    git(&ws, &["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    // Clean, and level with origin.
    let clean = start_point(&ws, "main");
    assert_eq!((clean.project_changed, clean.local_ahead, clean.starts_local), (Some(0), Some(0), false), "{clean:?}");
    // Changed files: one tracked, two new at the top, two new in a new
    // folder (each counted: --untracked-files=all); a copy's folder doesn't count.
    let tracked: Vec<String> = git(&ws, &["ls-files"]).lines().map(str::to_string).collect();
    std::fs::write(ws.join(&tracked[0]), "changed\n").unwrap();
    std::fs::write(ws.join("new-one.txt"), "new\n").unwrap();
    std::fs::write(ws.join("new-two.txt"), "new\n").unwrap();
    std::fs::create_dir_all(ws.join("fresh")).unwrap();
    std::fs::write(ws.join("fresh/a.txt"), "a\n").unwrap();
    std::fs::write(ws.join("fresh/b.txt"), "b\n").unwrap();
    std::fs::create_dir_all(ws.join(".plyloft-worktrees/copy-0a0b0c0d")).unwrap();
    std::fs::write(ws.join(".plyloft-worktrees/copy-0a0b0c0d/x.txt"), "x\n").unwrap();
    assert_eq!(start_point(&ws, "main").project_changed, Some(5));
    // The "Same folder" popover asks without the folder's status.
    let quick = start_point_with(&ws, "main", false);
    assert_eq!((quick.project_changed, quick.local_ahead), (None, Some(0)));
    // Strictly ahead: the copy starts here and has the step, so nothing of
    // it is left out.
    git(&ws, &["add", "new-one.txt"]);
    git(&ws, &["commit", "-q", "-m", "ahead"]);
    let ahead = start_point(&ws, "main");
    assert_eq!((ahead.local_ahead, ahead.starts_local), (Some(0), true), "{ahead:?}");
    assert_eq!(ahead.project_changed, Some(4));
    let v = serde_json::to_value(&ahead).unwrap();
    assert_eq!((v["localAhead"].as_u64(), v["startsLocal"].as_bool()), (Some(0), Some(true)));
    // Diverged: GitHub got a step of its own, the copy starts from it, and
    // this clone's one step stays out.
    commit_file(&other, "from-the-other-mac.txt");
    git(&other, &["push", "-q", "origin", "main"]);
    git(&ws, &["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    let diverged = start_point(&ws, "main");
    assert_eq!((diverged.local_ahead, diverged.starts_local), (Some(1), false), "{diverged:?}");
    let v = serde_json::to_value(&diverged).unwrap();
    assert_eq!((v["projectChanged"].as_u64(), v["localAhead"].as_u64()), (Some(4), Some(1)));
    // Behind: origin's tip has everything; nothing left out.
    git(&ws, &["reset", "-q", "--hard", "origin/main"]);
    git(&ws, &["reset", "-q", "--hard", "HEAD~1"]);
    let behind = start_point(&ws, "main");
    assert_eq!((behind.local_ahead, behind.starts_local), (Some(0), false), "{behind:?}");
    // No origin: nothing to be ahead of; the changed files still count.
    git(&ws, &["remote", "remove", "origin"]);
    git(&ws, &["update-ref", "-d", "refs/remotes/origin/main"]);
    let alone = start_point(&ws, "main");
    assert_eq!((alone.local_ahead, alone.starts_local), (None, false));
    assert!(alone.project_changed.is_some());
    // Not a repository: nothing read, nothing said.
    let plain = tempfile::tempdir().unwrap();
    let none = start_point(plain.path(), "main");
    assert_eq!((none.project_changed, none.local_ahead, none.starts_local), (None, None, false));
}

#[test]
fn the_worktrees_delete_routes_a_listed_copy_through_throw_away() {
    let (_tmp, ws, _other, registry) = fixture();
    let copy = make(Place { registry_dir: &registry, workspace_cwd: &ws }, "listed");
    assert!(is_listed_copy(&registry, &copy.id));
    assert!(!is_listed_copy(&registry, "copy-0a0b0c0d"), "an unlisted copy folder is deleted as any other");
    assert!(!is_listed_copy(&registry, "card-1"));
    let commands = include_str!("commands.rs");
    let body = &commands[commands.find("pub async fn worktree_delete(").unwrap()..];
    let route = body.find("crate::copies::is_listed_copy(").expect("worktree_delete asks the copies");
    assert!(route < body.find("crate::copies::throw_away_for_app(").unwrap());
    assert!(route < body.find("delete_card_worktree_hooked(").unwrap(), "before the cards' delete");
}

#[test]
fn the_sweep_keeps_a_copy_branch_checked_out_elsewhere() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let thrown = expired(place, "checked out");
    git(&ws, &["checkout", "-q", &thrown.branch]);
    assert!(!sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_some());
    assert!(load(&registry).copies[0].branch_cleanup.as_ref().unwrap().pending(), "looked at again next pass");
    git(&ws, &["checkout", "-q", "main"]);
    assert!(sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_none());
}

#[cfg(unix)]
#[test]
fn a_throw_away_that_cannot_be_recorded_puts_the_copy_back() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "unrecorded");
    fs::write(Path::new(&copy.path).join("README.md"), "edit\n").unwrap();
    fs::set_permissions(&registry, fs::Permissions::from_mode(0o555)).unwrap();
    let err = throw_away(place, &copy.id, &[], &none, false, 1).unwrap_err();
    fs::set_permissions(&registry, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(err.contains("so it was put back"), "{err}");
    assert_eq!(fs::read_to_string(Path::new(&copy.path).join("README.md")).unwrap(), "edit\n");
    assert_eq!(git(Path::new(&copy.path), &["rev-parse", "--abbrev-ref", "HEAD"]), copy.branch);
    assert_eq!(load(&registry).copies[0].state, CopyState::Active);
}

// ── A3: Make it a card, Open a pull request, port blocks ─────────────

/// A `gh` that records its arguments and stdin and answers like
/// `gh pr create` (the URL on stdout).
#[cfg(unix)]
fn fake_gh(dir: &Path, url: &str) -> (PathBuf, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("gh");
    let args = dir.join("gh-args.txt");
    let stdin = dir.join("gh-stdin.txt");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\ncat > '{}'\necho '{url}'\n",
            args.display(),
            stdin.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    (script, args, stdin)
}

#[cfg(unix)]
#[test]
fn open_a_pull_request_commits_pushes_the_copys_own_branch_and_asks_for_the_target() {
    let _env = crate::shell_env::lock_for_test();
    crate::shell_env::init();
    let (tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "inbox-empty-state");
    let path = PathBuf::from(&copy.path);
    // One commit of its own and one change not committed yet.
    commit_file(&path, "InboxPanel.tsx");
    fs::write(path.join("inboxView.ts"), "x\n").unwrap();
    let (gh, args, stdin) = fake_gh(tmp.path(), "https://github.com/acme/app/pull/41");

    let done = open_pr_with(place, &copy.id, "Inbox: say what to do", gh.to_str().unwrap(), Some("acme/app"), false, 5_000)
        .unwrap();

    // Everything is committed, with the title, on the copy's own branch.
    assert_eq!(git(&path, &["status", "--porcelain"]), "");
    assert_eq!(git(&path, &["log", "-1", "--format=%s"]), "Inbox: say what to do");
    let tip = git(&path, &["rev-parse", "HEAD"]);
    // Pushed by an explicit refspec to the same name on origin.
    let origin = tmp.path().join("origin.git");
    assert_eq!(git(&origin, &["rev-parse", &format!("refs/heads/{}", copy.branch)]), tip);
    assert_eq!(git(&origin, &["rev-parse", "refs/heads/main"]), copy.base_commit, "main on origin never moves");
    // Ship's `gh pr create`: base = the copy's start, head = its branch, body on stdin.
    let said: Vec<String> = fs::read_to_string(&args).unwrap().lines().map(str::to_string).collect();
    let want: Vec<String> = [
        "pr", "create", "--base", "main", "--head", copy.branch.as_str(), "--title", "Inbox: say what to do",
        "--body-file", "-", "--repo", "acme/app",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(said, want);
    assert_eq!(fs::read_to_string(&stdin).unwrap(), COPY_PR_BODY);
    // Recorded on the copy, which stays listed.
    let pr = done.pr.clone().unwrap();
    assert_eq!((pr.number, pr.url.as_str(), pr.state.as_deref()), (41, "https://github.com/acme/app/pull/41", Some("open")));
    assert_eq!(pr.head_sha.as_deref(), Some(tip.as_str()));
    assert!(done.pr_open());
    assert_eq!(load(&registry).copies[0].pr, Some(pr));
    // A second press is refused while that one is open.
    let again = open_pr_with(place, &copy.id, "again", gh.to_str().unwrap(), None, false, 6_000).unwrap_err();
    assert!(again.contains("already has a pull request open (#41)"), "{again}");
}

#[cfg(unix)]
#[test]
fn the_push_is_never_forced_over_a_branch_that_moved_on_github() {
    let _env = crate::shell_env::lock_for_test();
    crate::shell_env::init();
    let (tmp, ws, other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "raced");
    commit_file(Path::new(&copy.path), "mine.txt");
    // Someone else's commit already sits on that branch name on origin.
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["switch", "-q", "-c", &copy.branch, "origin/main"]);
    let theirs = commit_file(&other, "theirs.txt");
    git(&other, &["push", "-q", "origin", &copy.branch]);
    let (gh, args, _stdin) = fake_gh(tmp.path(), "https://github.com/acme/app/pull/1");

    let err = open_pr_with(place, &copy.id, "t", gh.to_str().unwrap(), None, false, 1).unwrap_err();

    assert!(err.contains("couldn't push the branch"), "{err}");
    let origin = tmp.path().join("origin.git");
    assert_eq!(git(&origin, &["rev-parse", &format!("refs/heads/{}", copy.branch)]), theirs, "never overwritten");
    assert!(!args.exists(), "no pull request asked for after a refused push");
    assert!(load(&registry).copies[0].pr.is_none());
}

#[test]
fn a_copy_with_nothing_changed_or_off_its_branch_is_not_handed_on() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "empty");
    let err = commit_for_pr(place, &copy.id, "t", false).unwrap_err();
    assert!(err.contains("Nothing has changed in this copy yet"), "{err}");
    assert!(ready_to_hand_on(place, &copy.id, true).unwrap_err().contains("still being set up"));
    git(Path::new(&copy.path), &["switch", "-q", "-c", "elsewhere"]);
    let off = ready_to_hand_on(place, &copy.id, false).unwrap_err();
    assert_eq!(off, off_its_branch(&copy.branch));
    // TX8 (T44): it names the copy's own branch, and says how to get back.
    assert!(off.contains(&format!("ask its AI to switch back to {}, then try again.", copy.branch)), "{off}");
    assert!(copy.branch.starts_with("plyloft/copy-"), "{}", copy.branch);
    assert!(ready_to_hand_on(place, "copy-zzzzzzzz", false).is_err());
    // Words a person can read: no ids, no engine terms.
    for words in [off.as_str(), COPY_PR_BODY] {
        assert!(!words.contains("worktree") && !words.contains("HEAD"), "{words}");
    }
    // TX5 round 1 (T33b): the app's word for the checks, not the step's name.
    assert!(COPY_PR_BODY.ends_with("neither the Reviewer nor your checks looked at it."), "{COPY_PR_BODY}");
    assert!(!COPY_PR_BODY.contains("Verify"), "{COPY_PR_BODY}");
}

#[test]
fn give_to_card_takes_the_copy_off_the_list_and_hands_its_port_block_on() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "to a card");
    let used = std::collections::HashSet::new();
    let base = ensure_port_base(place, &copy.id, &used, &|_| true).unwrap().unwrap();
    assert!(held_port_bases(registry.parent().unwrap(), None).contains(&base));

    let given = super::give_to_card(place, &copy.id, "card-9").unwrap();

    assert_eq!(given.card_id.as_deref(), Some("card-9"));
    // Challenger 2: kept for the card to take; no copy holds it any more.
    assert_eq!(given.port_base, Some(base), "handed on to the card");
    assert!(list(place, &none, &not_running).is_empty(), "it left the Copies list");
    assert!(!held_port_bases(registry.parent().unwrap(), None).contains(&base));
    assert_eq!(super::give_to_card(place, &copy.id, "card-10").unwrap_err(), IS_A_CARD_REFUSAL);
    assert_eq!(ready_to_hand_on(place, &copy.id, false).unwrap_err(), IS_A_CARD_REFUSAL);
}

#[test]
fn a_copy_gets_a_port_block_no_card_and_no_other_copy_holds_and_gives_it_back_when_thrown_away() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let first = make(place, "one");
    let second = make(place, "two");
    let first_block = crate::worktree_ports::RANGE_START;
    // The first block is a card's: the copy takes the next one.
    let cards: std::collections::HashSet<u16> = [first_block].into();
    let a = ensure_port_base(place, &first.id, &cards, &|_| true).unwrap().unwrap();
    assert_ne!(a, first_block);
    assert!(crate::worktree_ports::is_block_base(a));
    // Asked again: the same block.
    assert_eq!(ensure_port_base(place, &first.id, &cards, &|_| true).unwrap(), Some(a));
    // Another copy never gets it.
    let b = ensure_port_base(place, &second.id, &cards, &|_| true).unwrap().unwrap();
    assert!(b != a && b != first_block);
    // A block a card took meanwhile is given up for a free one.
    let now: std::collections::HashSet<u16> = [first_block, a].into();
    let moved = ensure_port_base(place, &first.id, &now, &|_| true).unwrap().unwrap();
    assert!(moved != a && moved != b);
    // Another workspace's copies count; the skipped directory doesn't.
    let root = registry.parent().unwrap();
    assert_eq!(held_port_bases(root, None), [moved, b].into());
    assert!(held_port_bases(root, Some(&registry)).is_empty());
    // Thrown away: free again.
    throw_away(place, &second.id, &[], &none, false, 9).unwrap();
    assert_eq!(held_port_bases(root, None), [moved].into());
    assert_eq!(ensure_port_base(place, &second.id, &now, &|_| true).unwrap(), None, "a copy in the Trash gets none");
}

#[test]
fn the_sweep_keeps_the_branch_of_a_copy_whose_pull_request_is_open() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let thrown = expired(place, "with a pull request");
    let url = "https://github.com/acme/app/pull/7";
    record_pr(place, &thrown.id, url, "abc", 1).unwrap();

    assert!(!sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_some(), "kept while its pull request is open");
    assert_eq!(load(&registry).copies.len(), 1);

    // GitHub says it merged: the next pass takes the branch here.
    assert!(note_pr_state(place, &thrown.id, url, "merged", None).unwrap());
    assert!(!note_pr_state(place, &thrown.id, url, "merged", None).unwrap(), "no change, no write");
    assert!(sweep(place, true, WEEK_AND_A_DAY, &none).unwrap());
    assert!(crate::worktrees::branch_tip(&ws, &thrown.branch).is_none());
    assert!(load(&registry).copies.is_empty());
}

#[test]
fn sweep_copy_record_holds_for_an_open_pull_request_only_once_due() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let thrown = expired(place, "held");
    let rec = thrown.branch_cleanup.clone().unwrap();
    let busy = || None;
    use crate::branch_cleanup::{sweep_copy_record, Verdict};
    assert_eq!(sweep_copy_record(&ws, true, 1_000, &rec, true, &busy), Verdict::NotDue);
    assert_eq!(
        sweep_copy_record(&ws, true, WEEK_AND_A_DAY, &rec, true, &busy),
        Verdict::Held("its pull request is still open".into())
    );
    assert_eq!(sweep_copy_record(&ws, false, WEEK_AND_A_DAY, &rec, true, &busy), Verdict::Skip);
}

/// The after-merge remote for a copy's own pull request.
struct Remote {
    deletes: std::cell::RefCell<Vec<String>>,
}

impl crate::after_merge::Remote for Remote {
    fn origin_slug(&self) -> Option<String> {
        Some("acme/app".into())
    }
    fn origin_refs(&self, branch: &str) -> Result<crate::after_merge::OriginRefs, String> {
        let _ = branch;
        Ok(crate::after_merge::OriginRefs { default_branch: Some("main".into()), branch_tip: Some("f00d".into()) })
    }
    fn delete_branch(&self, _slug: &str, branch: &str) -> Result<crate::after_merge::DeleteAnswer, String> {
        self.deletes.borrow_mut().push(branch.to_string());
        Ok(crate::after_merge::DeleteAnswer::Deleted)
    }
    fn open_prs_use(&self, _slug: &str, _branch: &str) -> Result<bool, String> {
        Ok(false)
    }
}

#[test]
fn after_its_pull_request_merged_a_copys_branch_on_github_goes_like_a_cards() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "merged");
    let url = "https://github.com/acme/app/pull/7";
    let copy = record_pr(place, &copy.id, url, "f00d", 1).unwrap();
    let read = read_pr_view(&format!(
        r#"{{"state":"MERGED","headRefName":"{}","isCrossRepository":false,"headRefOid":"f00d"}}"#,
        copy.branch
    ))
    .unwrap();
    assert_eq!(read.state, "merged");
    let remote = Remote { deletes: Default::default() };
    assert_eq!(after_pr_merged(&remote, &ws, &copy, &read), None);
    assert_eq!(*remote.deletes.borrow(), vec![copy.branch.clone()]);

    // From another repository's head, or another branch: kept, untouched.
    let remote = Remote { deletes: Default::default() };
    let fork = PrRead { cross_repository: Some(true), ..read.clone() };
    assert!(after_pr_merged(&remote, &ws, &copy, &fork).is_some());
    assert!(remote.deletes.borrow().is_empty());
    // Never a branch that isn't Plyloft's.
    let mut plain = copy.clone();
    plain.branch = "feature/x".into();
    let other = PrRead { head_ref: Some("feature/x".into()), ..read };
    assert!(after_pr_merged(&remote, &ws, &plain, &other).unwrap().contains("isn't a branch Plyloft made"));
    assert!(remote.deletes.borrow().is_empty());
}

#[test]
fn gh_answers_and_pull_request_urls_are_read() {
    assert_eq!(read_pr_view(r#"{"state":"OPEN"}"#).unwrap().state, "open");
    assert_eq!(read_pr_view(r#"{"state":"CLOSED","headRefName":"b"}"#).unwrap().head_ref.as_deref(), Some("b"));
    assert!(read_pr_view(r#"{"state":"DRAFTY"}"#).is_none());
    assert!(read_pr_view("not json").is_none());
    assert_eq!(pr_number_of("https://github.com/o/r/pull/123"), 123);
    assert_eq!(pr_number_of("https://github.com/o/r/pull/9/"), 9);
    assert_eq!(pr_number_of("nonsense"), 0);
}

/// Schema migration (the v1.11.x template): an A2 entry — a pull request
/// with only its number and url, no port block — reads with the new fields
/// defaulted (open, no block) and is written back without inventing them.
#[test]
fn an_a2_entry_reads_with_the_a3_fields_defaulted() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = tmp.path().join("w1");
    fs::create_dir_all(&registry).unwrap();
    let a2 = serde_json::json!({
        "schemaVersion": 1,
        "copies": [{
            "id": "copy-1a2b3c4d", "name": "inbox", "branch": "plyloft/copy-1a2b3c4d-inbox",
            "path": "/tmp/x", "baseBranch": "main", "baseCommit": "abc", "createdAt": 1,
            "state": "active", "pr": { "number": 4, "url": "https://github.com/o/r/pull/4" }
        }]
    });
    fs::write(registry_path(&registry), serde_json::to_vec(&a2).unwrap()).unwrap();
    let file = load(&registry);
    let entry = &file.copies[0];
    assert_eq!(entry.port_base, None);
    let pr = entry.pr.as_ref().unwrap();
    assert_eq!((pr.number, pr.state.as_deref(), pr.head_sha.as_deref()), (4, None, None));
    assert!(entry.pr_open(), "a pull request with no state read yet is open");
    update(&registry, |_| Ok(((), true))).unwrap();
    let back: Value = serde_json::from_slice(&fs::read(registry_path(&registry)).unwrap()).unwrap();
    let back = &back["copies"][0];
    assert!(back.get("portBase").is_none());
    assert_eq!(back["pr"], serde_json::json!({ "number": 4, "url": "https://github.com/o/r/pull/4" }));
}

#[test]
fn the_list_counts_the_saved_changes_that_exist_nowhere_else() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "saved");
    let path = PathBuf::from(&copy.path);
    assert_eq!(list(place, &none, &not_running)[0].saved, 0);
    commit_file(&path, "a.txt");
    commit_file(&path, "b.txt");
    assert_eq!(list(place, &none, &not_running)[0].saved, 2);
    // Sent to GitHub: they exist there too.
    git(&path, &["push", "-q", "origin", &format!("HEAD:refs/heads/{}", copy.branch)]);
    assert_eq!(list(place, &none, &not_running)[0].saved, 0);
}

// ── A3 Challenger round 1 ────────────────────────────────────────────

#[cfg(unix)]
#[test]
fn a_hook_that_refuses_the_commit_leaves_the_copy_as_it_was() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "hooked");
    let path = PathBuf::from(&copy.path);
    fs::write(path.join("work.txt"), "x\n").unwrap();
    let hooks = PathBuf::from(git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])).join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    fs::write(&hook, "#!/bin/sh\necho 'lint failed: work.txt' >&2\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let head = git(&path, &["rev-parse", "HEAD"]);

    let err = commit_for_pr(place, &copy.id, "t", false).unwrap_err();

    assert!(err.starts_with(SAVE_FAILED), "{err}");
    assert!(err.contains("lint failed: work.txt"), "the hook's own words, behind Details: {err}");
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), head, "nothing committed");
    assert_eq!(git(&path, &["diff", "--cached", "--name-only"]), "", "the index is put back");
    assert_eq!(fs::read_to_string(path.join("work.txt")).unwrap(), "x\n", "the change is still there");
}

#[test]
fn a_copy_whose_card_is_not_on_the_board_is_a_copy_again() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let kept = make(place, "kept");
    let stranded = make(place, "stranded");
    super::give_to_card(place, &kept.id, "card-on-board").unwrap();
    super::give_to_card(place, &stranded.id, "card-gone").unwrap();
    assert!(list(place, &none, &not_running).is_empty());

    let on_board = |id: &str| id == "card-on-board";
    assert!(release_stranded(&registry, &on_board).unwrap());
    assert!(!release_stranded(&registry, &on_board).unwrap(), "nothing left to release");

    let listed = list(place, &none, &not_running);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].copy.id, stranded.id, "listed again");
    assert!(throw_away(place, &stranded.id, &[], &none, false, 5).is_ok(), "and can be thrown away");
    assert_eq!(throw_away(place, &kept.id, &[], &none, false, 5).unwrap_err(), IS_A_CARD_REFUSAL);
}

#[test]
fn a_copy_being_sent_to_github_is_refused_to_the_other_ends() {
    let ws_id = "w-sending";
    assert!(refuse_while_sending(ws_id, "copy-aaaaaaaa").is_ok());
    let sending = begin_sending(ws_id, "copy-aaaaaaaa").unwrap();
    assert!(begin_sending(ws_id, "copy-aaaaaaaa").is_none(), "a second press waits");
    assert_eq!(refuse_while_sending(ws_id, "copy-aaaaaaaa").unwrap_err(), SENDING_REFUSAL);
    assert!(refuse_while_sending(ws_id, "copy-bbbbbbbb").is_ok(), "only that copy");
    drop(sending);
    assert!(refuse_while_sending(ws_id, "copy-aaaaaaaa").is_ok());
}

#[test]
fn throw_away_for_app_and_make_card_ask_whether_the_copy_is_being_sent() {
    let source = include_str!("copies.rs");
    let (_, throw) = source.split_once("pub fn throw_away_for_app").unwrap();
    assert!(throw[..800].contains("refuse_while_sending(workspace_id, id)?"));
    let commands = include_str!("commands.rs");
    let (_, make) = commands.split_once("pub(crate) fn make_card_from_copy").unwrap();
    assert!(make[..2500].contains("crate::copies::refuse_while_sending(workspace_id, copy_id)?"));
}

/// A3 Challenger round 2: a board that couldn't be read releases nothing.
#[test]
fn a_board_that_cannot_be_read_releases_no_copy() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "owned");
    super::give_to_card(place, &copy.id, "card-1").unwrap();
    assert!(!release_stranded_on(&registry, Err("read kanban/w1.json: I/O error".into())).unwrap());
    assert_eq!(load(&registry).copies[0].card_id.as_deref(), Some("card-1"), "still the card's");
    // Read, with no such card: released.
    assert!(release_stranded_on(&registry, Ok(Vec::new())).unwrap());
    assert_eq!(load(&registry).copies[0].card_id, None);
}

/// R2: a board set aside, or opened from its last saved copy, reads without
/// an error — as an empty board, or one save behind — and the card a copy
/// was given to may be in what was lost. For the rest of that session
/// nothing is released; a board that is whole releases as before. The
/// callers hand `load_whole` in (`release_stranded_for_app`, Make it a card).
#[test]
fn a_board_set_aside_or_restored_this_session_releases_no_copy() {
    use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, KANBAN_SUBDIR};
    let card = |id: &str| KanbanCard::new(id.into(), "w1".into(), id.into(), None, KanbanColumnId::Todo);
    for unreadable in [&b""[..], &b"{cut"[..]] {
        for with_backup in [true, false] {
            let (_tmp, ws, _other, registry) = fixture();
            let place = Place { registry_dir: &registry, workspace_cwd: &ws };
            let copy = make(place, "owned");
            super::give_to_card(place, &copy.id, "card-lost").unwrap();
            let config = tempfile::tempdir().unwrap();
            let boards = config.path().join(KANBAN_SUBDIR);
            if with_backup {
                // Two saves, so the backup holds a card; the card the copy
                // names was made in the save that was lost.
                let before = KanbanStore::new(config.path().to_path_buf()).unwrap();
                before.create_card("w1", card("a")).unwrap();
                before.create_card("w1", card("b")).unwrap();
            } else if unreadable.is_empty() {
                continue; // An empty file with no backup is an empty board, and whole.
            }
            std::fs::create_dir_all(&boards).unwrap();
            std::fs::write(boards.join("w1.json"), unreadable).unwrap();

            let store = KanbanStore::new(config.path().to_path_buf()).unwrap();
            assert_eq!(store.load("w1").unwrap().len(), usize::from(with_backup), "the board reads without an error");
            assert!(!release_stranded_on(&registry, store.load_whole("w1")).unwrap());
            assert_eq!(load(&registry).copies[0].card_id.as_deref(), Some("card-lost"), "still the card's");

            // The next session's board is whole: the copy is a copy again.
            let next = KanbanStore::new(config.path().to_path_buf()).unwrap();
            assert!(release_stranded_on(&registry, next.load_whole("w1")).unwrap());
            assert_eq!(load(&registry).copies[0].card_id, None);
        }
    }
    let copies = include_str!("copies.rs");
    assert!(copies.contains("release_stranded_on(dir, kanban.load_whole(workspace_id))"));
    assert!(include_str!("commands.rs").contains("release_stranded_on(&dir, store.load_whole(workspace_id))?"));
}

/// C17 (round 1): a newer Plyloft's registry refuses each action on a copy
/// before it starts: no copy made, none thrown away, restored, handed on or
/// given to a card, and the file is byte-identical.
#[test]
fn a_newer_plyloft_s_registry_refuses_every_action_before_it_starts() {
    let (_tmp, ws, _other, registry) = fixture();
    let place = Place { registry_dir: &registry, workspace_cwd: &ws };
    let copy = make(place, "kept");
    let mut raw: Value = serde_json::from_slice(&fs::read(registry_path(&registry)).unwrap()).unwrap();
    raw["schemaVersion"] = Value::from(SCHEMA_VERSION + 1);
    let newer = serde_json::to_string(&raw).unwrap();
    fs::write(registry_path(&registry), &newer).unwrap();
    let refusal = crate::atomic::newer_refusal("The list of copies", SCHEMA_VERSION + 1, SCHEMA_VERSION);
    let before = fs::read_dir(ws.join(crate::worktrees::WORKTREES_DIR)).unwrap().count();
    let made = create(place, "new", "main", Some("claude"), 2_000, crate::worktrees::resolve_base);
    assert_eq!(made.unwrap_err(), refusal);
    assert_eq!(fs::read_dir(ws.join(crate::worktrees::WORKTREES_DIR)).unwrap().count(), before, "no copy made");
    assert_eq!(throw_away(place, &copy.id, &[], &|_| 0, false, 2_000).unwrap_err(), refusal);
    assert!(Path::new(&copy.path).exists(), "not thrown away");
    assert_eq!(restore(place, &copy.id).unwrap_err(), refusal);
    assert_eq!(ready_to_hand_on(place, &copy.id, false).unwrap_err(), refusal);
    assert_eq!(commit_for_pr(place, &copy.id, "t", false).unwrap_err(), refusal);
    assert_eq!(super::give_to_card(place, &copy.id, "card-1").unwrap_err(), refusal);
    assert_eq!(fs::read_to_string(registry_path(&registry)).unwrap(), newer);
}
