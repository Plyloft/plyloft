use super::*;
use crate::skill_links::{LinkVersion, KIND_TEAM};

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

fn library() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(dir.path(), args);
    }
    dir
}

fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn commit(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

const CLAUDE: &str = "library/claude/acme/skills";
const CODEX: &str = "library/codex/plugins/acme/skills";
const LONG: &str = "Read the whole diff before approving.\nCheck the tests.\nCheck the names.\nCheck the docs.\nCheck the errors.\nCheck the logs.\nCheck the edges.\nCheck the types.\nCheck the rest.\n";

/// `old-lint` in both halves, and the link a copy of it records.
fn linked_library() -> (tempfile::TempDir, LinkOrigin) {
    let lib = library();
    for half in [CLAUDE, CODEX] {
        write(lib.path(), &format!("{half}/old-lint/SKILL.md"), LONG);
    }
    write(lib.path(), "library/claude/acme/skills/keep/SKILL.md", "keep\n");
    let at = commit(lib.path(), "add");
    let path = format!("{CLAUDE}/old-lint");
    let id = crate::library_snapshot::entry_tree(lib.path(), &at, &path).unwrap().unwrap();
    let origin = LinkOrigin {
        kind: KIND_TEAM.into(),
        source: "acme/team".into(),
        plugin: Some("acme".into()),
        name: "old-lint".into(),
        path: Some(path),
        version: LinkVersion { commit: at, content_id: id, extra: Default::default() },
        extra: Default::default(),
    };
    (lib, origin)
}

fn mv(dir: &Path, from: &str, to: &str) {
    git(dir, &["mv", from, to]);
}

#[test]
fn a_skill_still_there_reads_its_content_id() {
    let (lib, origin) = linked_library();
    assert_eq!(read(lib.path(), &origin, true), Upstream::At(origin.version.content_id.clone()));
    write(lib.path(), &format!("{CLAUDE}/old-lint/SKILL.md"), "changed\n");
    commit(lib.path(), "change");
    assert!(matches!(read(lib.path(), &origin, true), Upstream::At(id) if id != origin.version.content_id));
}

#[test]
fn a_deleted_skill_is_removed_only_from_a_trusted_read() {
    let (lib, origin) = linked_library();
    git(lib.path(), &["rm", "-rq", &format!("{CLAUDE}/old-lint"), &format!("{CODEX}/old-lint")]);
    commit(lib.path(), "remove");
    assert_eq!(read(lib.path(), &origin, true), Upstream::Missing);
    // Switched off, mid-rebase, diverged: never "removed".
    assert_eq!(read(lib.path(), &origin, false), Upstream::Unavailable);
}

#[test]
fn a_clone_behind_the_link_is_not_available_and_never_removed() {
    let (lib, mut origin) = linked_library();
    // The link was made on another Mac at a later commit this clone has…
    write(lib.path(), "README.md", "x\n");
    let later = commit(lib.path(), "later");
    git(lib.path(), &["reset", "-q", "--keep", "HEAD~1"]);
    origin.version.commit = later;
    // …but HEAD is behind it.
    assert_eq!(read(lib.path(), &origin, true), Upstream::Unavailable);
    // A link commit the clone never saw (history rewritten): content is
    // still read, absence never declared.
    origin.version.commit = "0123456789012345678901234567890123456789".into();
    assert_eq!(read(lib.path(), &origin, true), Upstream::At(origin.version.content_id.clone()));
    git(lib.path(), &["rm", "-rq", &format!("{CLAUDE}/old-lint"), &format!("{CODEX}/old-lint")]);
    commit(lib.path(), "remove");
    assert_eq!(read(lib.path(), &origin, true), Upstream::Unavailable);
}

#[test]
fn a_rename_of_both_halves_is_renamed_with_the_new_path() {
    let (lib, origin) = linked_library();
    mv(lib.path(), &format!("{CLAUDE}/old-lint"), &format!("{CLAUDE}/lint-rules"));
    mv(lib.path(), &format!("{CODEX}/old-lint"), &format!("{CODEX}/lint-rules"));
    commit(lib.path(), "rename");
    let Upstream::Renamed { name, path, id } = read(lib.path(), &origin, true) else {
        panic!("renamed");
    };
    assert_eq!(name, "lint-rules");
    assert_eq!(path, format!("{CLAUDE}/lint-rules"));
    assert_eq!(id, origin.version.content_id, "same content");
}

#[test]
fn a_rename_with_a_small_edit_is_found_by_git_at_ninety_percent() {
    let (lib, origin) = linked_library();
    for half in [CLAUDE, CODEX] {
        mv(lib.path(), &format!("{half}/old-lint"), &format!("{half}/lint-rules"));
        write(lib.path(), &format!("{half}/lint-rules/SKILL.md"), &LONG.replace("Check the rest.", "Check the rest!"));
    }
    commit(lib.path(), "rename and edit");
    assert!(matches!(read(lib.path(), &origin, true), Upstream::Renamed { name, id, .. } if name == "lint-rules" && id != origin.version.content_id));
}

#[test]
fn a_rename_of_one_half_only_is_a_removal() {
    let (lib, origin) = linked_library();
    mv(lib.path(), &format!("{CLAUDE}/old-lint"), &format!("{CLAUDE}/lint-rules"));
    git(lib.path(), &["rm", "-rq", &format!("{CODEX}/old-lint")]);
    commit(lib.path(), "rename one, remove the other");
    assert_eq!(read(lib.path(), &origin, true), Upstream::Missing);
}

#[test]
fn a_rewrite_under_a_new_name_is_not_a_rename() {
    let (lib, origin) = linked_library();
    git(lib.path(), &["rm", "-rq", &format!("{CLAUDE}/old-lint"), &format!("{CODEX}/old-lint")]);
    for half in [CLAUDE, CODEX] {
        write(lib.path(), &format!("{half}/lint-rules/SKILL.md"), "something else entirely\n");
    }
    commit(lib.path(), "replace");
    assert_eq!(read(lib.path(), &origin, true), Upstream::Missing);
}

#[test]
fn the_two_layouts_map_onto_each_other() {
    assert_eq!(other_half("library/claude/acme/skills/x").as_deref(), Some("library/codex/plugins/acme/skills/x"));
    assert_eq!(other_half("library/codex/plugins/acme/skills/x").as_deref(), Some("library/claude/acme/skills/x"));
    assert_eq!(other_half("elsewhere/x"), None);
}

/// H4 Windows walk: the Compare took 35 s — `caught_up` spawned git once per
/// library commit. It now reads every commit's tree in one batched
/// `cat-file`; a long history still finds the newest version the copy held
/// (and never the link's own).
#[test]
fn caught_up_reads_a_long_history_in_one_batch() {
    let (lib, origin) = linked_library();
    let path = origin.path.clone().unwrap();
    let mut held = String::new();
    for n in 0..60 {
        write(lib.path(), &format!("{path}/SKILL.md"), &format!("{LONG}version {n}\n"));
        let at = commit(lib.path(), &format!("v{n}"));
        if n == 41 {
            held = crate::library_snapshot::entry_tree(lib.path(), &at, &path).unwrap().unwrap();
        }
    }
    let ids: std::collections::BTreeSet<String> = [held.clone(), origin.version.content_id.clone(), "f".repeat(40)].into();
    let (_, id) = caught_up(lib.path(), &origin, &ids).expect("version 41");
    assert_eq!(id, held);
    let only_link: std::collections::BTreeSet<String> = [origin.version.content_id.clone()].into();
    assert_eq!(caught_up(lib.path(), &origin, &only_link), None);
    let trees = batch_trees(lib.path(), &[format!("HEAD:{path}"), "HEAD:no/such".into(), format!("HEAD:{path}/SKILL.md")]);
    assert!(trees[0].is_some() && trees[1].is_none() && trees[2].is_none(), "{trees:?}");
}

/// H4 Windows re-walk V3: a small one-file skill (team-rn, ~10 lines), its
/// marker changed in one commit, then `git mv team-rn team-rename` with the
/// `name:` and heading changed in the next. Judged over the whole span at
/// 90 % it read *Removed*; judged in the commit that took the old folder
/// away it is the rename, both halves agreeing.
#[test]
fn a_small_skill_renamed_after_a_text_change_is_renamed_not_removed() {
    let lib = library();
    let text = |name: &str, marker: &str| {
        format!(
            "---\nname: {name}\ndescription: Walk fixture for a rename.\n---\n\n# {name}\n\nKeep it short.\n\nWalk marker: {marker}\n"
        )
    };
    for half in [CLAUDE, CODEX] {
        write(lib.path(), &format!("{half}/team-rn/SKILL.md"), &text("team-rn", "ONYX-1"));
    }
    let at = commit(lib.path(), "add team-rn");
    let path = format!("{CLAUDE}/team-rn");
    let id = crate::library_snapshot::entry_tree(lib.path(), &at, &path).unwrap().unwrap();
    let origin = LinkOrigin {
        kind: KIND_TEAM.into(),
        source: "acme/team".into(),
        plugin: Some("acme".into()),
        name: "team-rn".into(),
        path: Some(path),
        version: LinkVersion { commit: at, content_id: id, extra: Default::default() },
        extra: Default::default(),
    };
    for half in [CLAUDE, CODEX] {
        write(lib.path(), &format!("{half}/team-rn/SKILL.md"), &text("team-rn", "ONYX-2"));
    }
    commit(lib.path(), "ONYX-2");
    for half in [CLAUDE, CODEX] {
        mv(lib.path(), &format!("{half}/team-rn"), &format!("{half}/team-rename"));
        write(lib.path(), &format!("{half}/team-rename/SKILL.md"), &text("team-rename", "ONYX-2"));
    }
    commit(lib.path(), "rename");
    match read(lib.path(), &origin, true) {
        Upstream::Renamed { name, path, .. } => {
            assert_eq!(name, "team-rename");
            assert_eq!(path, format!("{CLAUDE}/team-rename"));
        }
        other => panic!("renamed, not {other:?}"),
    }
    // One half renamed, the other deleted, is still a removal.
    let lib2 = library();
    for half in [CLAUDE, CODEX] {
        write(lib2.path(), &format!("{half}/team-rn/SKILL.md"), &text("team-rn", "ONYX-1"));
    }
    let at2 = commit(lib2.path(), "add");
    let id2 = crate::library_snapshot::entry_tree(lib2.path(), &at2, &format!("{CLAUDE}/team-rn")).unwrap().unwrap();
    let origin2 = LinkOrigin {
        version: LinkVersion { commit: at2, content_id: id2, extra: Default::default() },
        ..origin.clone()
    };
    mv(lib2.path(), &format!("{CLAUDE}/team-rn"), &format!("{CLAUDE}/team-rename"));
    write(lib2.path(), &format!("{CLAUDE}/team-rename/SKILL.md"), &text("team-rename", "ONYX-1"));
    git(lib2.path(), &["rm", "-rq", &format!("{CODEX}/team-rn")]);
    commit(lib2.path(), "rename one, delete the other");
    assert_eq!(read(lib2.path(), &origin2, true), Upstream::Missing);
}
