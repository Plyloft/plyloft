//! N16: new card worktrees go under `.plyloft-worktrees/`; the ones made
//! under the legacy `.atelier-worktrees/` stay there, and everything that
//! scans, sweeps or guards worktrees reads both roots.

use super::*;

const LEGACY: &str = ".atelier-worktrees";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository on `main` with one commit.
fn repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    git(ws, &["init", "-q", "-b", "main"]);
    git(ws, &["config", "user.email", "test@plyloft.test"]);
    git(ws, &["config", "user.name", "plyloft-test"]);
    git(ws, &["config", "core.autocrlf", "false"]);
    fs::write(ws.join("README.md"), "init\n").unwrap();
    git(ws, &["add", "README.md"]);
    git(ws, &["commit", "-q", "-m", "init"]);
    tmp
}

/// A card worktree as a build before N16 made it: under the legacy root, on
/// the legacy branch prefix, with the legacy line in `.gitignore`.
fn legacy_worktree(ws: &Path, card_id: &str) -> (PathBuf, String) {
    let path = ws.join(LEGACY).join(card_id);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let branch = make_branch_name(card_id, "T").replacen(BRANCH_PREFIX, "atelier/card-", 1);
    git(ws, &["worktree", "add", "-q", path.to_str().unwrap(), "-b", &branch, "main"]);
    let gi = ws.join(".gitignore");
    let mut existing = fs::read_to_string(&gi).unwrap_or_default();
    if !existing.contains(".atelier-worktrees/") {
        existing.push_str(".atelier-worktrees/\n");
        fs::write(&gi, existing).unwrap();
    }
    (path, branch)
}

fn backdate(dir: &Path) {
    let when = SystemTime::now() - Duration::from_secs(TRASH_TTL_SECS + 60);
    crate::platform::set_modified(dir, when).unwrap();
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn a_new_card_worktree_is_made_under_the_new_root() {
    let tmp = repo();
    let ws = tmp.path();
    let r = ensure_for_card(ws, "card1", "T", "main").unwrap();
    assert!(r.created);
    assert_eq!(r.worktree_path, ws.join(".plyloft-worktrees").join("card1"));
    assert!(r.worktree_path.is_dir());
    assert_eq!(
        fs::read_to_string(ws.join(".plyloft-worktrees/.gitignore")).unwrap(),
        ROOT_IGNORE_CONTENTS
    );
    assert!(!ws.join(".gitignore").exists(), "the user's .gitignore is never written");
    assert_eq!(git(ws, &["status", "--porcelain", "--untracked-files=all"]), "", "the main checkout stays clean");
    assert!(!ws.join(LEGACY).exists());
}

#[test]
fn a_legacy_worktree_keeps_working_where_it_was_made() {
    let tmp = repo();
    let ws = tmp.path();
    let (path, branch) = legacy_worktree(ws, "card1");
    let stored = path.to_string_lossy().into_owned();

    // Found where it is, by its id or by the card's record.
    assert_eq!(worktree_path_for_card(ws, "card1"), path);
    assert_eq!(card_worktree_path(ws, "card1", Some(&stored)), path);
    assert_eq!(card_worktree_dir("card1", Some(&stored)), "card1");

    // A start or resume adopts it, never makes a second one.
    let r = ensure_for_card(ws, "card1", "T", "main").unwrap();
    assert!(!r.created);
    assert_eq!(r.worktree_path, path);
    assert_eq!(r.branch_name, branch);
    assert!(!ws.join(".plyloft-worktrees").join("card1").exists());

    // Its Verify shares the one target under the new root.
    let env = shared_build_env(ws, &path, true);
    let expected = resolved_path(&shared_target_dir(ws)).to_string_lossy().into_owned();
    assert_eq!(env, vec![("CARGO_TARGET_DIR".to_string(), expected)]);
    assert!(shared_target_dir(ws).starts_with(ws.join(".plyloft-worktrees")));

    // A prune stages it in its own root's trash.
    let staged = prune_for_card(ws, "card1", &[]).unwrap().unwrap();
    assert_eq!(staged.parent().unwrap(), ws.join(LEGACY).join(TRASH_DIR));
    assert!(!path.exists());
    assert!(!ws.join(".plyloft-worktrees").join("card1").exists(), "no card folder under the new root");
}

#[test]
fn a_gone_legacy_checkout_comes_back_at_the_path_the_card_records() {
    let tmp = repo();
    let ws = tmp.path();
    let (path, branch) = legacy_worktree(ws, "card1");
    fs::remove_dir_all(&path).unwrap();
    let stored = path.to_string_lossy().into_owned();
    let r = reattach_card_branch(ws, "card1", Some(&stored), Some(&branch)).unwrap();
    assert_eq!(r.worktree_path, path, "the session history is keyed on this path");
    assert!(path.join("README.md").is_file());
    // Without a record under a root, a new checkout goes under the new root.
    assert_eq!(card_worktree_path(ws, "card2", None), ws.join(".plyloft-worktrees").join("card2"));
    assert_eq!(
        card_worktree_path(ws, "card2", Some("/elsewhere/card2")),
        ws.join(".plyloft-worktrees").join("card2")
    );
}

#[test]
fn the_codex_build_of_a_legacy_card_is_recognised_under_either_root() {
    let ws = Path::new("/ws");
    let variant = crate::build_both::variant_dir("card1");
    for root in [".plyloft-worktrees", LEGACY] {
        let stored = ws.join(root).join(&variant);
        assert_eq!(card_worktree_dir("card1", stored.to_str()), variant, "{root}");
    }
    let elsewhere = ws.join("other").join(&variant);
    assert_eq!(card_worktree_dir("card1", elsewhere.to_str()), "card1");
}

#[test]
fn the_list_reads_both_roots() {
    let tmp = repo();
    let ws = tmp.path();
    let (legacy, _) = legacy_worktree(ws, "card-old");
    let fresh = ensure_for_card(ws, "card-new", "T", "main").unwrap().worktree_path;
    fs::create_dir_all(ws.join(LEGACY).join(TRASH_DIR).join("gone-1")).unwrap();
    fs::create_dir_all(ws.join(LEGACY).join(SHARED_TARGET_DIR)).unwrap();
    let listed: Vec<(String, String)> = list_for_workspace(ws)
        .into_iter()
        .map(|w| (w.dir_name, w.worktree_path))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("card-new".to_string(), fresh.to_string_lossy().into_owned()),
            ("card-old".to_string(), legacy.to_string_lossy().into_owned()),
        ]
    );
}

#[test]
fn the_sweep_reaps_both_trashes_and_lists_kept_entries_from_both() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    let new_trash = ws.join(".plyloft-worktrees").join(TRASH_DIR);
    let old_trash = ws.join(LEGACY).join(TRASH_DIR);
    for t in [&new_trash, &old_trash] {
        let expired = t.join("expired-1");
        fs::create_dir_all(&expired).unwrap();
        fs::write(expired.join("f"), "x").unwrap();
        backdate(&expired);
    }
    let kept_new = new_trash.join("keepnew-5");
    let kept_old = old_trash.join("keepold-3");
    for k in [&kept_new, &kept_old] {
        fs::create_dir_all(k).unwrap();
        fs::write(kept_marker(k), b"").unwrap();
    }

    let gc = gc_trash(ws, &[]);
    assert_eq!(gc.expired, 2);
    assert!(!new_trash.join("expired-1").exists());
    assert!(!old_trash.join("expired-1").exists());

    let kept: Vec<String> = list_kept_trash(ws).into_iter().map(|k| k.dir_name).collect();
    assert_eq!(kept, ["keepold-3", "keepnew-5"], "oldest first, across roots");
    delete_kept_trash(ws, "keepold-3").unwrap();
    assert!(!kept_old.exists());
    assert!(!kept_marker(&kept_old).exists());
    assert!(delete_kept_trash(ws, "keepold-3").is_err());
    assert!(delete_kept_trash(ws, "..\\keepnew-5").is_err());
    delete_kept_trash(ws, "keepnew-5").unwrap();

    // Nothing live left in the legacy root: the next sweep retires it.
    gc_trash(ws, &[]);
    assert!(!ws.join(LEGACY).exists());
    assert!(ws.join(".plyloft-worktrees").exists(), "the current root is never retired");
}

#[test]
fn the_reveal_guard_takes_either_root_and_nothing_else() {
    let ws = Path::new("/Users/me/code/app");
    assert!(is_under_worktree_root(ws, &ws.join(".plyloft-worktrees/card1")));
    assert!(is_under_worktree_root(ws, &ws.join(".atelier-worktrees/card1")));
    assert!(is_under_worktree_root(ws, &ws.join(".atelier-worktrees/.trash/card1-17")));
    for bad in [
        ws.join(".plyloft-worktrees"),
        ws.join(".atelier-worktrees"),
        ws.join(".plyloft-worktrees/../secret"),
        ws.join(".atelier-worktrees/card1/../../secret"),
        ws.join(".plyloft-worktrees-evil/card1"),
        ws.join("src/main.rs"),
        ws.to_path_buf(),
        PathBuf::from("/Users/me/code/other/.plyloft-worktrees/card1"),
        PathBuf::from("/etc/passwd"),
    ] {
        assert!(!is_under_worktree_root(ws, &bad), "{}", bad.display());
    }
}

#[cfg(windows)]
#[test]
fn the_reveal_guard_reads_windows_separators() {
    let ws = Path::new(r"C:\Users\me\code\app");
    assert!(is_under_worktree_root(ws, Path::new(r"C:\Users\me\code\app\.plyloft-worktrees\card1")));
    assert!(is_under_worktree_root(ws, Path::new(r"C:\Users\me\code\app\.atelier-worktrees\card1")));
    assert!(!is_under_worktree_root(ws, Path::new(r"C:\Users\me\code\app\.plyloft-worktrees\..\x")));
}

#[test]
fn the_new_root_ignores_itself_and_never_dirties_the_users_gitignore() {
    let tmp = repo();
    let ws = tmp.path();
    // A repository a build before N16 worked in: `.atelier-worktrees/`
    // ignored by a committed line, a card worktree still there.
    legacy_worktree(ws, "card-old");
    git(ws, &["add", ".gitignore"]);
    git(ws, &["commit", "-q", "-m", "ignore worktrees"]);
    let before = fs::read_to_string(ws.join(".gitignore")).unwrap();

    let r = ensure_for_card(ws, "card-new", "T", "main").unwrap();
    assert!(r.worktree_path.starts_with(ws.join(".plyloft-worktrees")));
    fs::write(r.worktree_path.join("work.txt"), "the card's").unwrap();
    assert_eq!(fs::read_to_string(ws.join(".gitignore")).unwrap(), before);
    assert_eq!(
        git(ws, &["status", "--porcelain", "--untracked-files=all"]),
        "",
        "nothing under either root shows in the main checkout"
    );
    // The card's own checkout still sees its own work: a parent folder's
    // ignore file is not read there.
    assert_eq!(git(&r.worktree_path, &["status", "--porcelain"]), "?? work.txt");

    // Idempotent, and a file already there is the user's to keep.
    let own = ws.join(".plyloft-worktrees/.gitignore");
    fs::write(&own, "*\n# edited\n").unwrap();
    ensure_gitignore(ws);
    assert_eq!(fs::read_to_string(&own).unwrap(), "*\n# edited\n");
}

#[test]
fn a_shared_target_made_first_under_the_new_root_is_ignored_too() {
    let tmp = repo();
    let ws = tmp.path();
    let (legacy, _) = legacy_worktree(ws, "card-old");
    git(ws, &["add", ".gitignore"]);
    git(ws, &["commit", "-q", "-m", "ignore worktrees"]);
    let env = shared_build_env(ws, &legacy, true);
    fs::create_dir_all(&env[0].1).unwrap();
    fs::write(Path::new(&env[0].1).join("CACHEDIR.TAG"), "x").unwrap();
    assert_eq!(git(ws, &["status", "--porcelain", "--untracked-files=all"]), "");
}

#[test]
fn a_legacy_root_is_retired_only_when_nothing_live_is_left() {
    let tmp = repo();
    let ws = tmp.path();
    let root = ws.join(LEGACY);
    let (path, _) = legacy_worktree(ws, "card1");
    let cache = root.join(SHARED_TARGET_DIR).join("debug");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("lib.rlib"), vec![0u8; 4096]).unwrap();

    // A worktree in it: nothing goes, not even the orphan cache.
    assert_eq!(retire_legacy_roots(ws), 0);
    assert_eq!(names(&root), [SHARED_TARGET_DIR, "card1"]);

    // A staged checkout in its trash still counts.
    let staged = prune_for_card(ws, "card1", &[]).unwrap().unwrap();
    assert!(!path.exists());
    assert_eq!(retire_legacy_roots(ws), 0);
    assert!(root.join(SHARED_TARGET_DIR).exists());

    // Something the app did not make leaves the whole root alone.
    fs::remove_dir_all(&staged).unwrap();
    let _ = fs::remove_file(trash_index_path(&staged));
    let notes = root.join("notes.txt");
    fs::write(&notes, "mine").unwrap();
    assert_eq!(retire_legacy_roots(ws), 0);
    assert!(root.join(SHARED_TARGET_DIR).exists());
    assert!(notes.exists());

    // Only the app's own (and the OS's litter, any case) left: the root
    // goes, cache, own ignore file and all.
    fs::remove_file(&notes).unwrap();
    fs::write(root.join(".DS_Store"), "").unwrap();
    fs::write(root.join("Thumbs.db"), "").unwrap();
    fs::write(root.join("Desktop.ini"), "").unwrap();
    fs::write(root.join(".gitignore"), ROOT_IGNORE_CONTENTS).unwrap();
    fs::write(root.join(TRASH_DIR).join(".DS_Store"), "").unwrap();
    fs::write(root.join(TRASH_DIR).join("thumbs.db"), "").unwrap();
    fs::create_dir_all(root.join(format!("{SHARED_TARGET_DIR}.clearing-12"))).unwrap();
    assert!(retire_legacy_roots(ws) >= 4096);
    assert!(!root.exists());
    // The user's ignore line stays; a second pass is a no-op.
    assert!(fs::read_to_string(ws.join(".gitignore")).unwrap().contains(".atelier-worktrees/"));
    assert_eq!(retire_legacy_roots(ws), 0);
}

#[cfg(unix)]
#[test]
fn a_link_in_place_of_the_legacy_root_is_left_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    let elsewhere = ws.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, ws.join(LEGACY)).unwrap();
    retire_legacy_roots(ws);
    assert!(fs::symlink_metadata(ws.join(LEGACY)).is_ok());
    assert!(elsewhere.exists());
}

#[test]
fn a_clear_deletes_only_the_current_roots_moved_aside_targets() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    for root in [".plyloft-worktrees", LEGACY] {
        let aside = ws.join(root).join(format!("{SHARED_TARGET_DIR}.clearing-1"));
        fs::create_dir_all(&aside).unwrap();
        fs::write(aside.join("x"), vec![0u8; 10]).unwrap();
    }
    assert!(delete_cleared_targets(ws).unwrap() >= 10);
    assert_eq!(names(&ws.join(".plyloft-worktrees")), Vec::<String>::new());
    // The legacy one is the sweep's (`drop_legacy_shared_targets`).
    assert_eq!(names(&ws.join(LEGACY)), [format!("{SHARED_TARGET_DIR}.clearing-1")]);
}

#[test]
fn the_old_build_cache_goes_at_once_even_beside_live_worktrees() {
    let tmp = repo();
    let ws = tmp.path();
    let root = ws.join(LEGACY);
    let (path, _) = legacy_worktree(ws, "card1");
    let staged = root.join(TRASH_DIR).join("card0-1");
    fs::create_dir_all(&staged).unwrap();
    fs::write(staged.join("work.txt"), "kept").unwrap();
    for dir in [SHARED_TARGET_DIR.to_string(), format!("{SHARED_TARGET_DIR}.clearing-5")] {
        let lib = root.join(dir).join("debug/lib.rlib");
        fs::create_dir_all(lib.parent().unwrap()).unwrap();
        fs::write(&lib, vec![0u8; 4096]).unwrap();
    }

    assert!(drop_legacy_shared_targets(ws) >= 8192);
    assert_eq!(names(&root), [TRASH_DIR, "card1"], "only the caches went");
    assert!(path.join("README.md").is_file());
    assert!(staged.join("work.txt").is_file());
    assert_eq!(drop_legacy_shared_targets(ws), 0, "a second pass is a no-op");
    // The current root's target is never this sweep's.
    let current = shared_target_dir(ws).join("debug");
    fs::create_dir_all(&current).unwrap();
    drop_legacy_shared_targets(ws);
    assert!(current.exists());
}

#[cfg(unix)]
#[test]
fn a_linked_old_build_cache_is_never_followed() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    let elsewhere = ws.join("elsewhere");
    fs::create_dir_all(elsewhere.join("debug")).unwrap();
    fs::create_dir_all(ws.join(LEGACY)).unwrap();
    std::os::unix::fs::symlink(&elsewhere, ws.join(LEGACY).join(SHARED_TARGET_DIR)).unwrap();
    std::os::unix::fs::symlink(&elsewhere, ws.join(LEGACY).join(format!("{SHARED_TARGET_DIR}.clearing-1"))).unwrap();
    assert_eq!(drop_legacy_shared_targets(ws), 0);
    assert!(elsewhere.join("debug").is_dir());
    assert!(fs::symlink_metadata(ws.join(LEGACY).join(SHARED_TARGET_DIR)).is_ok());
}

#[test]
fn the_sweep_drops_the_old_build_cache_and_counts_it() {
    let tmp = repo();
    let ws = tmp.path();
    legacy_worktree(ws, "card1");
    let lib = ws.join(LEGACY).join(SHARED_TARGET_DIR).join("debug/lib.rlib");
    fs::create_dir_all(lib.parent().unwrap()).unwrap();
    fs::write(&lib, vec![0u8; 4096]).unwrap();
    let gc = gc_trash(ws, &[]);
    assert!(gc.freed_bytes >= 4096);
    assert!(!ws.join(LEGACY).join(SHARED_TARGET_DIR).exists());
    assert!(ws.join(LEGACY).join("card1").is_dir());
}

#[test]
fn a_live_legacy_root_ignores_itself_once_the_users_line_is_gone() {
    let tmp = repo();
    let ws = tmp.path();
    let (path, branch) = legacy_worktree(ws, "card1");
    // The user discarded the line older builds appended.
    fs::remove_file(ws.join(".gitignore")).unwrap();
    assert!(git(ws, &["status", "--porcelain"]).contains(".atelier-worktrees/"));

    gc_trash(ws, &[]);
    assert_eq!(fs::read_to_string(ws.join(LEGACY).join(".gitignore")).unwrap(), ROOT_IGNORE_CONTENTS);
    assert_eq!(git(ws, &["status", "--porcelain", "--untracked-files=all"]), "");
    assert!(!ws.join(".gitignore").exists(), "the user's file is never written");

    // A checkout made again in the legacy root writes it too.
    fs::remove_file(ws.join(LEGACY).join(".gitignore")).unwrap();
    fs::remove_dir_all(&path).unwrap();
    let stored = path.to_string_lossy().into_owned();
    reattach_card_branch(ws, "card1", Some(&stored), Some(&branch)).unwrap();
    assert_eq!(git(ws, &["status", "--porcelain", "--untracked-files=all"]), "");

    // Once nothing live is left, the own ignore file does not keep the root.
    prune_for_card(ws, "card1", &[]).unwrap();
    for e in fs::read_dir(ws.join(LEGACY).join(TRASH_DIR)).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() { fs::remove_dir_all(&p).unwrap() } else { fs::remove_file(&p).unwrap() }
    }
    gc_trash(ws, &[]);
    assert!(!ws.join(LEGACY).exists());
}

#[test]
fn the_sweep_restores_or_repairs_the_current_roots_ignore_file() {
    let tmp = repo();
    let ws = tmp.path();
    ensure_for_card(ws, "card1", "T", "main").unwrap();
    let own = ws.join(".plyloft-worktrees/.gitignore");
    let clean = || git(ws, &["status", "--porcelain", "--untracked-files=all"]);

    fs::remove_file(&own).unwrap();
    assert_ne!(clean(), "");
    gc_trash(ws, &[]);
    assert_eq!(fs::read_to_string(&own).unwrap(), ROOT_IGNORE_CONTENTS);
    assert_eq!(clean(), "");

    for broken in ["", "# nothing\n", "*\n!card1\n"] {
        fs::write(&own, broken).unwrap();
        gc_trash(ws, &[]);
        assert_eq!(fs::read_to_string(&own).unwrap(), ROOT_IGNORE_CONTENTS, "{broken:?}");
    }
    // A user's file that still ignores everything is theirs to keep.
    fs::write(&own, "/*\n# mine\n").unwrap();
    gc_trash(ws, &[]);
    assert_eq!(fs::read_to_string(&own).unwrap(), "/*\n# mine\n");
    // A directory in its place is left alone.
    fs::remove_file(&own).unwrap();
    fs::create_dir_all(own.join("x")).unwrap();
    gc_trash(ws, &[]);
    assert!(own.join("x").is_dir());
}

#[test]
fn a_stray_folder_under_the_new_root_never_stands_in_for_a_legacy_card() {
    let tmp = repo();
    let ws = tmp.path();
    let (legacy, branch) = legacy_worktree(ws, "card1");
    let stored = legacy.to_string_lossy().into_owned();
    let stray = ws.join(".plyloft-worktrees").join("card1");
    fs::create_dir_all(&stray).unwrap();
    fs::write(stray.join("note.txt"), "not the card's").unwrap();

    assert_eq!(worktree_path_for_card(ws, "card1"), stray, "by name alone, the stray wins");
    let own = card_worktree_path(ws, "card1", Some(&stored));
    assert_eq!(own, legacy);

    let staged = prune_worktree_at(ws, &own, &[]).unwrap().unwrap();
    assert_eq!(staged.parent().unwrap(), ws.join(LEGACY).join(TRASH_DIR));
    assert!(stray.join("note.txt").is_file(), "the stray is untouched");
    assert!(branch_exists(ws, &branch));

    // Anything not directly in a root is refused.
    for bad in [ws.join("src"), ws.join(".plyloft-worktrees"), ws.join(".plyloft-worktrees/.trash"), stray.join("note.txt")] {
        assert!(prune_worktree_at(ws, &bad, &[]).is_err(), "{}", bad.display());
    }
}

#[test]
fn a_lane_record_names_its_folder_under_either_root() {
    let ws = Path::new("/ws");
    let legacy = ws.join(LEGACY).join("card1-b");
    assert_eq!(recorded_worktree_path(ws, "card1-b", legacy.to_str()), legacy);
    // A record elsewhere, or none, falls back to the lookup by name.
    for recorded in [Some("/elsewhere/card1-b"), Some(""), None] {
        assert_eq!(
            recorded_worktree_path(ws, "card1-b", recorded),
            ws.join(".plyloft-worktrees").join("card1-b"),
            "{recorded:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_link_in_a_worktrees_place_is_never_pruned_or_followed() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    let target = ws.join("elsewhere");
    fs::create_dir_all(target.join("node_modules/pkg")).unwrap();
    fs::write(target.join("work.txt"), "mine").unwrap();
    let link = ws.join(".plyloft-worktrees").join("card1");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    assert!(card_worktree_location(ws, &link).is_err());
    assert!(prune_worktree_at(ws, &link, &["node_modules".to_string()]).is_err());
    assert!(prune_for_card(ws, "card1", &["node_modules".to_string()]).is_err());
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert!(target.join("node_modules/pkg").is_dir());
    assert!(target.join("work.txt").is_file());
}
