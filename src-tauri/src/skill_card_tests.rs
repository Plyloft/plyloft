use super::*;
use std::path::Path;

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

fn repo() -> tempfile::TempDir {
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

#[cfg(unix)]
fn make_executable(dir: &Path, path: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.join(path), std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

const SKILL_PATH: &str = "library/claude/acme/skills/review-rules";

/// A team library with `review-rules` (a `SKILL.md` and a script).
fn library() -> (tempfile::TempDir, String) {
    let lib = repo();
    write(lib.path(), &format!("{SKILL_PATH}/SKILL.md"), "---\nname: review-rules\ndescription: Review.\n---\n\nRead the diff.\n");
    write(lib.path(), &format!("{SKILL_PATH}/scripts/check.sh"), "#!/bin/sh\necho ok\n");
    #[cfg(unix)]
    make_executable(lib.path(), &format!("{SKILL_PATH}/scripts/check.sh"));
    let commit = commit_all(lib.path(), "add review-rules");
    (lib, commit)
}

fn origin_of(source: &Source) -> LinkOrigin {
    LinkOrigin {
        kind: skill_links::KIND_TEAM.into(),
        source: "acme/team".into(),
        plugin: Some("acme".into()),
        name: "review-rules".into(),
        path: Some(source.path.clone()),
        version: LinkVersion {
            commit: source.commit.clone(),
            content_id: source.tree.clone(),
            extra: Default::default(),
        },
        extra: Default::default(),
    }
}

/// A workspace repository with one commit, and the card commit Install
/// would make on it.
fn installed(source: &Source) -> (tempfile::TempDir, String, String) {
    let ws = repo();
    write(ws.path(), "README.md", "app\n");
    let base = commit_all(ws.path(), "init");
    let link = link_for(None, &origin_of(source), source, Reach::BOTH);
    let changes = changes_for(ws.path(), &base, "", "review-rules", source, &link, Reach::BOTH);
    let head = commit_into_worktree(ws.path(), &base, &changes, &commit_message(SkillVerb::Install, "review-rules", &origin_of(source))).unwrap();
    (ws, base, head)
}

#[test]
fn the_source_is_read_from_git_objects_with_its_executable_bit() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    assert_eq!(source.tree, git(lib.path(), &["rev-parse", &format!("{commit}:{SKILL_PATH}")]).trim());
    let paths: Vec<&str> = source.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["SKILL.md", "scripts/check.sh"]);
    #[cfg(unix)]
    assert!(source.files[1].executable);
    // The working tree is never read: a change there is not the source.
    write(lib.path(), &format!("{SKILL_PATH}/SKILL.md"), "edited by hand\n");
    assert_eq!(read_source(lib.path(), &commit, SKILL_PATH).unwrap(), source);
    assert!(read_source(lib.path(), &commit, "library/claude/acme/skills/none").is_err());
}

#[cfg(unix)]
#[test]
fn a_skill_with_a_symbolic_link_is_not_copied() {
    let lib = repo();
    write(lib.path(), &format!("{SKILL_PATH}/SKILL.md"), "x\n");
    std::os::unix::fs::symlink("/etc/passwd", lib.path().join(format!("{SKILL_PATH}/leak"))).unwrap();
    let commit = commit_all(lib.path(), "link");
    let why = read_source(lib.path(), &commit, SKILL_PATH).unwrap_err();
    assert!(why.contains("symbolic link"), "{why}");
}

/// The card's one commit: both copies with the library's exact content id,
/// and the link record — and the checkout is never touched.
#[test]
fn the_card_commit_holds_both_copies_and_the_link_record() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, head) = installed(&source);
    let twins = twin_ids_at(ws.path(), &head, "", "review-rules");
    assert!(twins.same_ids(&TwinIds::both(&source.tree)), "same content id as the library: {twins:?}");
    let link = link_at(ws.path(), &head, "", "review-rules").unwrap();
    assert_eq!(link.origin.version.content_id, source.tree);
    assert_eq!(link.origin.path.as_deref(), Some(SKILL_PATH));
    assert!(link.base.same_ids(&TwinIds::both(&source.tree)));
    assert!(skill_only(ws.path(), &base, &head, "", "review-rules"));
    let changed = git(ws.path(), &["diff", "--name-only", &base, &head]);
    let mut changed: Vec<&str> = changed.lines().collect();
    changed.sort();
    assert_eq!(
        changed,
        [
            ".agents/skills/review-rules/SKILL.md",
            ".agents/skills/review-rules/scripts/check.sh",
            ".atelier/skill-links/review-rules.json",
            ".claude/skills/review-rules/SKILL.md",
            ".claude/skills/review-rules/scripts/check.sh",
        ]
    );
}

/// An Update replaces both copies whole: a file the new version dropped is
/// removed, and the link's unknown keys survive.
#[test]
fn an_update_removes_dropped_files_and_keeps_the_record_s_unknown_keys() {
    let (lib, commit) = library();
    let first = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, _, head) = installed(&first);
    std::fs::remove_file(lib.path().join(format!("{SKILL_PATH}/scripts/check.sh"))).unwrap();
    write(lib.path(), &format!("{SKILL_PATH}/SKILL.md"), "---\nname: review-rules\ndescription: Review v2.\n---\n");
    let second_commit = commit_all(lib.path(), "v2");
    let second = read_source(lib.path(), &second_commit, SKILL_PATH).unwrap();
    let mut previous = link_at(ws.path(), &head, "", "review-rules").unwrap();
    previous.extra.insert("renamedFrom".into(), serde_json::json!("x"));
    let link = link_for(Some(&previous), &origin_of(&second), &second, Reach::BOTH);
    assert!(link.extra.contains_key("renamedFrom"));
    let changes = changes_for(ws.path(), &head, "", "review-rules", &second, &link, Reach::BOTH);
    assert!(changes.iter().any(|c| c.path == ".claude/skills/review-rules/scripts/check.sh" && c.content.is_none()));
    assert!(changes.iter().any(|c| c.path == ".agents/skills/review-rules/scripts/check.sh" && c.content.is_none()));
    let next = commit_into_worktree(ws.path(), &head, &changes, "update").unwrap();
    assert!(twin_ids_at(ws.path(), &next, "", "review-rules").same_ids(&TwinIds::both(&second.tree)));
    assert!(!ws.path().join(".claude/skills/review-rules/scripts/check.sh").exists(), "the worktree followed");
}

#[test]
fn only_the_skill_s_own_paths_count_as_a_skill_change() {
    assert!(allowed_path(".claude/skills/x/SKILL.md", "", "x"));
    assert!(allowed_path(".agents/skills/x/a/b.md", "", "x"));
    assert!(allowed_path(".atelier/skill-links/x.json", "", "x"));
    assert!(allowed_path("sub/.claude/skills/x/SKILL.md", "sub/", "x"));
    assert!(!allowed_path(".claude/skills/x/SKILL.md", "sub/", "x"));
    assert!(!allowed_path(".claude/skills/x-other/SKILL.md", "", "x"));
    assert!(!allowed_path(".claude/skills/x", "", "x"));
    assert!(!allowed_path(".codex/skills/x/SKILL.md", "", "x"));
    assert!(!allowed_path(".atelier/workspace.json", "", "x"));
    assert!(!allowed_path(".atelier/skill-links/y.json", "", "x"));
    assert!(!allowed_path("README.md", "", "x"));
}

/// §4.2 / Tier 4 6d: a non-skill file in the card's commits takes Verify
/// back; so does a card branch the target was merged into.
#[test]
fn a_change_beyond_the_skill_is_not_skill_only() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, head) = installed(&source);
    write(ws.path(), "README.md", "edited by hand\n");
    let edited = commit_all(ws.path(), "hand edit");
    assert!(skill_only(ws.path(), &base, &head, "", "review-rules"));
    assert!(!skill_only(ws.path(), &base, &edited, "", "review-rules"));
    // A base that is not in the commit's history.
    git(ws.path(), &["checkout", "-q", "--orphan", "other"]);
    git(ws.path(), &["rm", "-rq", "--cached", "."]);
    write(ws.path(), "other.txt", "x\n");
    git(ws.path(), &["add", "other.txt"]);
    git(ws.path(), &["commit", "-q", "-m", "other root"]);
    let unrelated = git(ws.path(), &["rev-parse", "HEAD"]).trim().to_string();
    assert!(!skill_only(ws.path(), &unrelated, &head, "", "review-rules"));
    // Nothing changed is not "only the skill" either.
    assert!(!skill_only(ws.path(), &base, &base, "", "review-rules"));
}

fn card_of(source: &Source, here: TwinIds) -> SkillCard {
    SkillCard {
        verb: SkillVerb::Install,
        skill: "review-rules".into(),
        prefix: String::new(),
        origin: origin_of(source),
        here,
        content: TwinIds::both(&source.tree),
        links: Vec::new(), renamed_to: None, link_before: None, link_after: None, align_winner: None, local_link: false, from_words: None,
        extra: Default::default(),
    }
}

#[test]
fn the_preflight_at_ship() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, head) = installed(&source);
    let card = card_of(&source, TwinIds::default());
    let same = Upstream::At(source.tree.clone());
    assert_eq!(preflight(ws.path(), &base, "", &card, &same, "main"), Preflight::Go);
    // Somebody shipped the same change: the target holds it, linked.
    assert_eq!(preflight(ws.path(), &head, "", &card, &same, "main"), Preflight::UpToDate);
    // The team changed it again.
    assert_eq!(preflight(ws.path(), &base, "", &card, &Upstream::At("other".into()), "main"), Preflight::RefreshNeeded);
    // An origin this Mac can't read never stops a ship.
    assert_eq!(preflight(ws.path(), &base, "", &card, &Upstream::Unavailable, "main"), Preflight::Go);
    // The target's copy changed since the card was made: never overridden.
    git(ws.path(), &["checkout", "-q", "-b", "teammate", &base]);
    write(ws.path(), ".claude/skills/review-rules/SKILL.md", "a teammate's own\n");
    let moved = commit_all(ws.path(), "teammate");
    match preflight(ws.path(), &moved, "", &card, &same, "main") {
        Preflight::HereMoved(why) => assert!(why.contains("pull request") && why.contains("main"), "{why}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_not_needed_entry_is_a_pass_on_exactly_that_tree() {
    let entry = not_needed_entry("tree1");
    assert!(entry.verify_run_id.starts_with(NOT_NEEDED_RUN_PREFIX));
    assert_eq!(entry.summary.as_deref(), Some(NOT_NEEDED_SUMMARY));
    let history = vec![entry];
    assert_eq!(crate::verify::verify_result_on("tree1", &history), Some(true));
    assert_eq!(crate::verify::verify_result_on("tree2", &history), None);
}

#[test]
fn the_card_s_words() {
    let origin = LinkOrigin { kind: skill_links::KIND_TEAM.into(), ..Default::default() };
    assert_eq!(card_title(SkillVerb::Install, "review-rules", &origin), "Skill: install review-rules from the team library");
    assert_eq!(card_title(SkillVerb::Update, "review-rules", &origin), "Skill: update review-rules from the team library");
    assert!(commit_message(SkillVerb::Install, "review-rules", &origin).starts_with("skill: install review-rules (the team library)"));
}

// ── The card kind on the board (Tier 2) ──────────────────────────────

const OLD_CARD: &str = r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"complete","worktreePath":"/wt","createdAt":0,"updatedAt":0}"#;

#[test]
fn a_board_card_without_a_kind_loads_as_an_ordinary_card() {
    let card: crate::kanban::KanbanCard = serde_json::from_str(OLD_CARD).unwrap();
    assert!(card.kind.is_none());
    let written = serde_json::to_string(&card).unwrap();
    assert!(!written.contains("\"kind\""), "an ordinary card writes no kind");
}

#[test]
fn a_kind_this_build_cannot_read_is_an_ordinary_card_not_a_broken_board() {
    for kind in [r#"{"type":"release","x":1}"#, r#"{"type":"skill","verb":"teleport"}"#, r#"7"#] {
        let json = OLD_CARD.replace("\"createdAt\"", &format!("\"kind\":{kind},\"createdAt\""));
        let card: crate::kanban::KanbanCard = serde_json::from_str(&json).unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert!(card.kind.is_none(), "{kind}");
    }
}

fn skill_kanban_card() -> crate::kanban::KanbanCard {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let mut card: crate::kanban::KanbanCard = serde_json::from_str(OLD_CARD).unwrap();
    card.kind = Some(crate::kanban::CardKind::Skill(card_of(&source, TwinIds::default())));
    card
}

#[test]
fn a_skill_card_round_trips_and_stops_being_one_once_work_starts_on_it() {
    let card = skill_kanban_card();
    let json = serde_json::to_string(&card).unwrap();
    assert!(json.contains("\"kind\":{\"type\":\"skill\""), "{json}");
    let back: crate::kanban::KanbanCard = serde_json::from_str(&json).unwrap();
    assert_eq!(back.kind, card.kind);
    assert_eq!(back.skill_card().map(|s| s.skill.as_str()), Some("review-rules"));
    let mut swarmed = back.clone();
    swarmed.linked_swarm_id = Some("s1".into());
    assert!(swarmed.skill_card().is_none(), "§14 Q29");
}

/// Tier 2 (H8): a skill card written before H8 (no `localLink`, no
/// `fromWords`) loads with neither and writes neither; a Copy card with a
/// link kept on this Mac round-trips; an older build reading the verb
/// `copy` gets an ordinary card (the lenient kind), never a broken board.
#[test]
fn a_copy_card_round_trips_and_an_h7_card_writes_no_copy_fields() {
    let card = skill_kanban_card();
    let json = serde_json::to_string(&card).unwrap();
    assert!(!json.contains("localLink") && !json.contains("fromWords"), "{json}");
    let h7 = json.replace("\"localLink\":false,", "");
    let back: crate::kanban::KanbanCard = serde_json::from_str(&h7).unwrap();
    let kind = back.skill_card().unwrap();
    assert!(!kind.local_link && kind.from_words.is_none());

    let mut copy = card.clone();
    if let Some(crate::kanban::CardKind::Skill(kind)) = copy.kind.as_mut() {
        kind.verb = SkillVerb::Copy;
        kind.local_link = true;
        kind.from_words = Some("astra".into());
    }
    let json = serde_json::to_string(&copy).unwrap();
    assert!(json.contains("\"verb\":\"copy\"") && json.contains("\"localLink\":true") && json.contains("\"fromWords\":\"astra\""), "{json}");
    let back: crate::kanban::KanbanCard = serde_json::from_str(&json).unwrap();
    assert_eq!(back.kind, copy.kind);
    // What an older build sees: a verb it can't read is an ordinary card.
    let unknown = json.replace("\"verb\":\"copy\"", "\"verb\":\"teleport\"");
    let older: crate::kanban::KanbanCard = serde_json::from_str(&unknown).unwrap();
    assert!(older.kind.is_none());
}

/// QoL 13.1 (schema): a carry card round-trips with the verb `carry`, an
/// older card reads unchanged, and a build before 13.1 reading `carry` gets
/// an ordinary card — never a broken board. A carry card is never behind.
#[test]
fn a_carry_card_round_trips_and_an_older_build_reads_it_as_ordinary() {
    let card = skill_kanban_card();
    let before = serde_json::to_string(&card).unwrap();
    assert!(!before.contains("carry"), "{before}");
    let mut carry = card.clone();
    if let Some(crate::kanban::CardKind::Skill(kind)) = carry.kind.as_mut() {
        kind.verb = SkillVerb::Carry;
        kind.origin = Default::default();
    }
    let json = serde_json::to_string(&carry).unwrap();
    assert!(json.contains("\"verb\":\"carry\""), "{json}");
    let back: crate::kanban::KanbanCard = serde_json::from_str(&json).unwrap();
    assert_eq!(back.kind, carry.kind);
    assert_eq!(SkillVerb::Carry.word(), "ship");
    let kind = back.skill_card().unwrap();
    assert!(!card_behind(kind, &crate::skill_links::Upstream::At("other".into())), "nothing to refresh");
    let older = json.replace("\"verb\":\"carry\"", "\"verb\":\"teleport\"");
    let older: crate::kanban::KanbanCard = serde_json::from_str(&older).unwrap();
    assert!(older.kind.is_none());
}

/// H8: a copy's card never asks to be refreshed (it ships the version it
/// copied), and its preflight with the link kept on this Mac reads its
/// copies alone.
#[test]
fn a_copy_card_is_never_behind_and_a_local_one_ships_without_a_record() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, _) = installed(&source);
    let mut card = card_of(&source, TwinIds::default());
    card.verb = SkillVerb::Copy;
    card.origin.kind = crate::skill_copy::KIND_WORKSPACE.into();
    assert!(!card_behind(&card, &Upstream::At("newer".into())));
    // The target holds the copies but no link record: up to date only for a local card.
    git(ws.path(), &["checkout", "-q", "-b", "copied", &base]);
    let claude_only = Reach { claude: true, codex: false };
    let link = link_for(None, &origin_of(&source), &source, claude_only);
    let mut changes = changes_for(ws.path(), &base, "", "review-rules", &source, &link, claude_only);
    changes.retain(|c| !c.path.starts_with(".atelier/"));
    let tip = commit_into_worktree(ws.path(), &base, &changes, "copy without a record").unwrap();
    card.content = claude_only.ids(&source.tree);
    assert_ne!(preflight(ws.path(), &tip, "", &card, &Upstream::Unavailable, "main"), Preflight::UpToDate);
    card.local_link = true;
    assert_eq!(preflight(ws.path(), &tip, "", &card, &Upstream::Unavailable, "main"), Preflight::UpToDate);
}

/// §14 Q29: a skill card in Complete holding its worktree is a skill card;
/// worked on by a swarm, it is an ordinary card.
#[test]
fn a_skill_card_worked_on_by_a_swarm_is_ordinary() {
    let card = skill_kanban_card();
    assert!(card.skill_card().is_some());
    let mut worked = card;
    worked.linked_swarm_id = Some("s1".into());
    assert!(worked.skill_card().is_none());
}

#[test]
fn a_library_directory_as_git_names_it() {
    let clone = Path::new("/tmp/team");
    assert_eq!(
        repo_path_of(clone, &clone.join("library").join("claude").join("acme").join("skills").join("x")).as_deref(),
        Some("library/claude/acme/skills/x")
    );
    assert_eq!(repo_path_of(clone, Path::new("/elsewhere")), None);
}

// ── Challenger (H3a) ─────────────────────────────────────────────────

/// R2 edge: a team skill that reaches only Claude gets only its Claude
/// copy; the link records only that twin, and the commit is still
/// skill-only.
#[test]
fn a_claude_only_team_skill_writes_only_the_claude_copy() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let ws = repo();
    write(ws.path(), "README.md", "app\n");
    let base = commit_all(ws.path(), "init");
    let here = twin_ids_at(ws.path(), &base, "", "review-rules");
    let claude_only = Reach { claude: true, codex: false };
    let roots = roots_to_write(claude_only, &here);
    assert_eq!(roots, claude_only);
    let link = link_for(None, &origin_of(&source), &source, roots);
    assert_eq!(link.base.claude.as_deref(), Some(source.tree.as_str()));
    assert!(link.base.codex.is_none(), "an absent twin is not written (§5.1)");
    let changes = changes_for(ws.path(), &base, "", "review-rules", &source, &link, roots);
    assert!(changes.iter().all(|c| !c.path.starts_with(".agents/")));
    let head = commit_into_worktree(ws.path(), &base, &changes, "install").unwrap();
    let twins = twin_ids_at(ws.path(), &head, "", "review-rules");
    assert!(twins.same_ids(&roots.ids(&source.tree)), "{twins:?}");
    assert!(twins.codex.is_none());
    assert!(skill_only(ws.path(), &base, &head, "", "review-rules"));
    // Shipped elsewhere: the preflight knows it by the one twin.
    let card = SkillCard { content: roots.ids(&source.tree), ..card_of(&source, TwinIds::default()) };
    assert_eq!(preflight(ws.path(), &head, "", &card, &Upstream::At(source.tree.clone()), "main"), Preflight::UpToDate);
    let notes = card_notes(SkillVerb::Install, "review-rules", &card.origin, "acme/web", roots);
    assert!(notes.contains("into .claude/skills/review-rules, with") && notes.contains("in Claude, from"), "{notes}");
    assert!(!notes.contains(".agents/skills"), "{notes}");
}

/// R12: a twin the repository already holds is written too, so a card
/// never leaves the two copies at different versions; a reach of neither
/// writes both.
#[test]
fn a_twin_already_here_is_written_with_the_reached_one() {
    let codex_here = TwinIds { codex: Some("old".into()), ..Default::default() };
    assert_eq!(roots_to_write(Reach { claude: true, codex: false }, &codex_here), Reach::BOTH);
    assert_eq!(
        roots_to_write(Reach { claude: false, codex: true }, &TwinIds::default()),
        Reach { claude: false, codex: true }
    );
    assert_eq!(roots_to_write(Reach { claude: false, codex: false }, &TwinIds::default()), Reach::BOTH);
    assert_eq!(Reach { claude: false, codex: true }.words(), "Codex");
    assert_eq!(Reach::BOTH.words(), "Claude and Codex");
}

/// §13 C1: a symbolic link or a submodule added inside the skill's own
/// directory is not a change Plyloft writes, so it takes Verify back; so do
/// a rename out of the skill and a root `.gitattributes`.
#[cfg(unix)]
#[test]
fn a_symbolic_link_or_a_submodule_in_the_skill_is_not_skill_only() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, head) = installed(&source);
    std::os::unix::fs::symlink("../../../README.md", ws.path().join(".claude/skills/review-rules/readme")).unwrap();
    let linked = commit_all(ws.path(), "a link in the skill");
    assert!(skill_only(ws.path(), &base, &head, "", "review-rules"));
    assert!(!skill_only(ws.path(), &base, &linked, "", "review-rules"));
    // A gitlink (a submodule entry) under the skill directory.
    git(ws.path(), &["reset", "-q", "--hard", &head]);
    let gitlink = format!("160000,{head},.agents/skills/review-rules/vendored");
    git(ws.path(), &["update-index", "--add", "--cacheinfo", &gitlink]);
    git(ws.path(), &["commit", "-q", "-m", "a submodule in the skill"]);
    let sub = git(ws.path(), &["rev-parse", "HEAD"]).trim().to_string();
    assert!(!skill_only(ws.path(), &base, &sub, "", "review-rules"));
    // A rename out of the skill shows both paths (`--no-renames`).
    git(ws.path(), &["reset", "-q", "--hard", &head]);
    git(ws.path(), &["mv", ".claude/skills/review-rules/SKILL.md", "SKILL.md"]);
    git(ws.path(), &["commit", "-q", "-m", "moved out"]);
    let moved = git(ws.path(), &["rev-parse", "HEAD"]).trim().to_string();
    assert!(!skill_only(ws.path(), &base, &moved, "", "review-rules"));
    // A root `.gitattributes` is outside the skill.
    git(ws.path(), &["reset", "-q", "--hard", &head]);
    write(ws.path(), ".gitattributes", "* -text\n");
    let attrs = commit_all(ws.path(), "attributes");
    assert!(!skill_only(ws.path(), &base, &attrs, "", "review-rules"));
}

/// A card kind edited by hand on the board can't widen what counts as
/// "only the skill".
#[test]
fn a_hand_edited_skill_name_or_prefix_is_never_skill_only() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, head) = installed(&source);
    for (prefix, skill) in [
        ("", ".."),
        ("", "review-rules/.."),
        ("", ""),
        ("../", "review-rules"),
        ("sub", "review-rules"),
        ("./", "review-rules"),
    ] {
        assert!(!skill_only(ws.path(), &base, &head, prefix, skill), "{prefix:?} {skill:?}");
    }
}

/// The local target a local merge lands on counts too: a change there that
/// origin lacks is never overridden, and the change already landed there is
/// *Already up to date*.
#[test]
fn the_preflight_reads_the_local_target_too() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, base, head) = installed(&source);
    let card = card_of(&source, TwinIds::default());
    let same = Upstream::At(source.tree.clone());
    git(ws.path(), &["checkout", "-q", "-b", "local", &base]);
    write(ws.path(), ".claude/skills/review-rules/SKILL.md", "mine, not pushed\n");
    let local = commit_all(ws.path(), "local edit");
    assert!(matches!(preflight_at(ws.path(), &[&base, &local], "", &card, &same, "main"), Preflight::HereMoved(_)));
    assert_eq!(preflight_at(ws.path(), &[&base], "", &card, &same, "main"), Preflight::Go);
    assert_eq!(preflight_at(ws.path(), &[&base, &head], "", &card, &same, "main"), Preflight::UpToDate);
}

/// §14 Q29: every trace of work makes it an ordinary card, and a Builder
/// field cleared later (Build with both stopped) never turns it back.
#[test]
fn any_trace_of_work_makes_a_skill_card_ordinary_for_good() {
    let card = skill_kanban_card();
    assert!(card.skill_card().is_some());
    let mut run = card.clone();
    run.linked_run_id = Some("r1".into());
    assert!(run.skill_card().is_none());
    let mut ran = card.clone();
    ran.run_history.push(crate::kanban::RunHistoryEntry {
        run_id: "r1".into(),
        status: crate::agents::AgentStatus::Done,
        ended_at: 1,
        files_changed_count: 1,
        top_paths: Vec::new(),
        swarm_id: None,
        swarm_template_id: None,
        swarm_collisions: 0,
        agent_config_id: None,
        legs: 1,
    });
    assert!(ran.skill_card().is_none(), "the run ended; its record stays");
    let mut both = card.clone();
    both.build_both = Some(Default::default());
    assert!(both.skill_card().is_none(), "a stopped Build with both clears builder, not build_both");
}

// ── Skills hub H4: decision cards ───────────────────────────────────────

/// A decision card's record after Plyloft committed `verb` on `head`.
fn decided(ws: &Path, head: &str, verb: SkillVerb, to: Option<&str>) -> (SkillCard, String) {
    let at_base = link_at(ws, head, "", "review-rules").unwrap();
    let next = match verb {
        SkillVerb::KeepMine => Some(skill_links::kept_mine(&at_base, "c2", "u2")),
        SkillVerb::Rename | SkillVerb::Relink => {
            Some(skill_links::relinked(&at_base, "lint-rules", "library/claude/acme/skills/lint-rules"))
        }
        _ => None,
    };
    let changes = decision_changes(ws, head, "", "review-rules", verb, next.as_ref(), to, None).unwrap();
    let sha = commit_into_worktree(ws, head, &changes, "decide").unwrap();
    let here = twin_ids_at(ws, head, "", "review-rules");
    let content = match (verb, to) {
        (_, Some(to)) => twin_ids_at(ws, &sha, "", to),
        (SkillVerb::Remove, _) => TwinIds::default(),
        _ => here.clone(),
    };
    let card = SkillCard {
        verb,
        skill: "review-rules".into(),
        prefix: String::new(),
        origin: next.as_ref().map(|l| l.origin.clone()).unwrap_or(at_base.origin.clone()),
        here,
        content,
        links: Vec::new(),
        renamed_to: to.map(str::to_string),
        link_before: blob_at(ws, head, &link_repo_path("", "review-rules")),
        link_after: next.as_ref().and(blob_at(ws, &sha, &link_repo_path("", to.unwrap_or("review-rules")))),
        align_winner: None, local_link: false, from_words: None,
        extra: Default::default(),
    };
    (card, sha)
}

/// §4.2 / §12 H4: every decision card's own commit passes Ship's tree gate
/// (no Verify); a hand edit on it does not; and its preflight finds a
/// shipped one *Already up to date*.
#[test]
fn decision_cards_pass_the_gate_only_with_their_own_change() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    for (verb, to) in [
        (SkillVerb::KeepMine, None),
        (SkillVerb::Detach, None),
        (SkillVerb::Remove, None),
        (SkillVerb::Rename, Some("lint-rules")),
        (SkillVerb::Relink, None),
    ] {
        let (ws, _, head) = installed(&source);
        let (card, sha) = decided(ws.path(), &head, verb, to);
        assert!(card.verb.is_decision());
        assert!(card_only(ws.path(), &head, &sha, &card), "{verb:?}: its own change");
        assert_eq!(preflight(ws.path(), &head, "", &card, &Upstream::Unavailable, "main"), Preflight::Go, "{verb:?}");
        assert_eq!(preflight(ws.path(), &sha, "", &card, &Upstream::At("moved".into()), "main"), Preflight::UpToDate, "{verb:?}");
        assert!(!card_behind(&card, &Upstream::At("moved".into())), "{verb:?}: never a refresh");
        write(ws.path(), "README.md", "a hand edit\n");
        let edited = commit_all(ws.path(), "hand edit");
        assert!(!card_only(ws.path(), &head, &edited, &card), "{verb:?}: a hand edit needs Verify");
    }
}

/// A decision card never overrides: the copies or the link record changed
/// on the target since it was made → a pull request with the reason.
#[test]
fn a_decision_card_whose_target_moved_ships_as_a_pull_request() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, _, head) = installed(&source);
    let (card, _) = decided(ws.path(), &head, SkillVerb::KeepMine, None);
    git(ws.path(), &["checkout", "-q", "-b", "teammate", &head]);
    write(ws.path(), ".atelier/skill-links/review-rules.json", "{\"origin\":{\"kind\":\"team\"}}\n");
    let moved = commit_all(ws.path(), "a teammate's link");
    assert!(matches!(preflight(ws.path(), &moved, "", &card, &Upstream::Unavailable, "main"), Preflight::HereMoved(_)));
    git(ws.path(), &["checkout", "-q", "-b", "teammate2", &head]);
    write(ws.path(), ".claude/skills/review-rules/SKILL.md", "a teammate's edit\n");
    let edited = commit_all(ws.path(), "a teammate's edit");
    assert!(matches!(preflight(ws.path(), &edited, "", &card, &Upstream::Unavailable, "main"), Preflight::HereMoved(_)));
}

/// Rename here moves every file as it is (executable bits too) and the
/// record to the new name; a name already taken here is refused.
#[test]
fn rename_here_moves_the_copies_and_the_record() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, _, head) = installed(&source);
    let (card, sha) = decided(ws.path(), &head, SkillVerb::Rename, Some("lint-rules"));
    assert!(twin_ids_at(ws.path(), &sha, "", "lint-rules").same_ids(&TwinIds::both(&source.tree)), "same content");
    assert!(twin_ids_at(ws.path(), &sha, "", "review-rules").same_ids(&TwinIds::default()));
    assert!(link_at(ws.path(), &sha, "", "review-rules").is_none());
    assert_eq!(link_at(ws.path(), &sha, "", "lint-rules").unwrap().origin.name, "lint-rules");
    assert_eq!(card.skills(), ["review-rules", "lint-rules"]);
    let at = link_at(ws.path(), &sha, "", "lint-rules").unwrap();
    let why = decision_changes(ws.path(), &sha, "", "lint-rules", SkillVerb::Rename, Some(&at), Some("lint-rules"), None).unwrap_err();
    assert!(why.contains("already"), "{why}");
}

/// H4 Mac walk: Rename here takes the library's own `name:` line into
/// both copies' `SKILL.md` (it shipped `name: "team-style"` inside
/// team-tone), every other file and line as it is.
#[test]
fn rename_here_brings_the_new_name_into_skill_md() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let (ws, _, head) = installed(&source);
    let link = link_at(ws.path(), &head, "", "review-rules").unwrap();
    let renamed = skill_links::relinked(&link, "lint-rules", "library/claude/acme/skills/lint-rules");
    let theirs = b"---\nname: \"lint-rules\"\ndescription: Review.\n---\n\nRead the diff.\n";
    let text = RenameText::from_library("review-rules", "lint-rules", Some(theirs));
    let changes =
        decision_changes(ws.path(), &head, "", "review-rules", SkillVerb::Rename, Some(&renamed), Some("lint-rules"), Some(&text)).unwrap();
    let written = |path: &str| {
        changes
            .iter()
            .find(|c| c.path == path)
            .and_then(|c| c.content.as_ref())
            .map(|(bytes, exec)| (String::from_utf8(bytes.clone()).unwrap(), *exec))
    };
    for root in [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT] {
        let Some((md, _)) = written(&format!("{root}/lint-rules/SKILL.md")) else { continue };
        assert_eq!(md, String::from_utf8(theirs.to_vec()).unwrap(), "{root}");
    }
    assert!(written(&format!("{}/lint-rules/SKILL.md", skill_links::CLAUDE_ROOT)).is_some());
    let (script, exec) = written(&format!("{}/lint-rules/scripts/check.sh", skill_links::CLAUDE_ROOT)).unwrap();
    assert_eq!(script, "#!/bin/sh\necho ok\n");
    assert!(exec || cfg!(not(unix)));
    // A library that only moved the folder changes nothing inside.
    let moved_only = RenameText::from_library("review-rules", "lint-rules", Some(b"---\nname: review-rules\n---\n"));
    let md = b"---\nname: review-rules\n---\n\n# review-rules\n";
    assert_eq!(moved_only.apply(md), md.to_vec());
}

#[test]
fn decision_card_titles_say_what_happens() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let origin = origin_of(&source);
    assert_eq!(card_title(SkillVerb::Remove, "old-lint", &origin), "Skill: remove old-lint (removed from the team library)");
    assert_eq!(card_title(SkillVerb::Detach, "old-lint", &origin), "Skill: unlink old-lint (removed from the team library)");
    let renamed = LinkOrigin { name: "lint-rules".into(), ..origin.clone() };
    assert_eq!(card_title(SkillVerb::Rename, "old-lint", &renamed), "Skill: rename old-lint to lint-rules (renamed in the team library)");
    assert!(decision_notes(SkillVerb::Remove, "old-lint", &origin, "acme/web").contains("from their next session"));
    // H4 Windows walk: Remove names the copies the skill has here.
    let claude_only = TwinIds { claude: Some("a".repeat(40)), codex: None, extra: Default::default() };
    let notes = remove_notes("old-lint", &origin, "acme/web", &claude_only);
    assert!(notes.contains("It deletes .claude/skills/old-lint and .atelier/skill-links/old-lint.json."), "{notes}");
    assert!(!notes.contains(".agents"), "{notes}");
}

/// Tier 2: an H3 board's skill card (no `renamedTo`, `linkBefore`,
/// `linkAfter`) loads unchanged; a decision verb this build doesn't know
/// leaves the card ordinary (the lenient kind reader).
#[test]
fn an_h3_skill_card_loads_and_writes_without_the_h4_fields() {
    let (lib, commit) = library();
    let source = read_source(lib.path(), &commit, SKILL_PATH).unwrap();
    let card = card_of(&source, TwinIds::default());
    let json = serde_json::to_value(&card).unwrap();
    for key in ["renamedTo", "linkBefore", "linkAfter"] {
        assert!(json.get(key).is_none(), "{key} not written when absent");
    }
    let back: SkillCard = serde_json::from_value(json).unwrap();
    assert_eq!(back, card);
    let keep: SkillCard = serde_json::from_value(serde_json::json!({
        "verb": "keepMine", "skill": "x", "origin": {}, "linkBefore": "b1", "linkAfter": "b2"
    }))
    .unwrap();
    assert_eq!((keep.verb, keep.link_after.as_deref()), (SkillVerb::KeepMine, Some("b2")));
    assert!(serde_json::from_value::<SkillCard>(serde_json::json!({ "verb": "later", "skill": "x", "origin": {} })).is_err());
}
