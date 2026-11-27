//! Skills hub H5 (R12): which twin wins, what counts as the same, and the
//! align written on a branch.

use std::path::Path;

use super::*;
use crate::skill_links::TwinIds;
use crate::skill_reach::Side;

fn ids(claude: Option<&str>, codex: Option<&str>) -> TwinIds {
    TwinIds { claude: claude.map(str::to_string), codex: codex.map(str::to_string), extra: Default::default() }
}

#[test]
fn exactly_one_twin_changed_since_the_record_wins() {
    let record = ids(Some("a"), Some("a"));
    assert_eq!(judge(&ids(Some("b"), Some("a")), false, &[record.clone()]), Judgement::Follows(Side::Claude));
    assert_eq!(judge(&ids(Some("a"), Some("c")), false, &[record.clone()]), Judgement::Follows(Side::Codex));
    // Both changed: nobody wins by itself.
    assert_eq!(judge(&ids(Some("b"), Some("c")), false, &[record.clone()]), Judgement::Differ);
    // No record (legacy): Align asks.
    assert_eq!(judge(&ids(Some("b"), Some("c")), false, &[]), Judgement::Differ);
    // The same skill, or one copy: nothing to align.
    assert_eq!(judge(&ids(Some("b"), Some("c")), true, &[record.clone()]), Judgement::Aligned);
    assert_eq!(judge(&ids(Some("b"), None), false, &[record.clone()]), Judgement::One);
    assert_eq!(judge(&ids(None, Some("b")), false, &[record]), Judgement::One);
}

#[test]
fn records_agree_or_nobody_wins() {
    // The link's record is older than the last align this Mac saw: the
    // ledger names the twin that changed since.
    let link = ids(Some("x"), Some("x"));
    let ledger = ids(Some("y"), Some("y"));
    assert_eq!(judge(&ids(Some("y"), Some("z")), false, &[link.clone(), ledger.clone()]), Judgement::Follows(Side::Codex));
    // Two records naming different twins: nobody wins.
    let other = ids(Some("z"), Some("z"));
    assert_eq!(
        judge(&ids(Some("y"), Some("z")), false, &[ids(Some("y"), Some("y")), other]),
        Judgement::Differ
    );
    // A record missing a twin says nothing.
    assert_eq!(judge(&ids(Some("b"), Some("a")), false, &[ids(Some("a"), None)]), Judgement::Differ);
}

#[test]
fn a_link_records_only_when_it_has_both_twins() {
    let link = |base: TwinIds| crate::skill_links::SkillLink {
        schema_version: 1,
        origin: Default::default(),
        base,
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    };
    assert!(link_record(Some(&link(ids(Some("a"), None)))).is_none());
    assert!(link_record(Some(&link(ids(Some("a"), Some("a"))))).is_some());
    assert_eq!(records(None, Some(&ids(Some("l"), Some("l")))).len(), 1);
}

#[test]
fn the_words() {
    assert_eq!(follows_line(Side::Claude), "The Codex copy gets the Claude copy's changes when the next card ships");
    assert_eq!(follows_line(Side::Codex), "The Claude copy gets the Codex copy's changes when the next card ships");
    assert_eq!(aligned_note("x", Side::Claude), "Codex's copy of x updated to match Claude's.");
    assert_eq!(legacy_line("x"), ".codex/skills/x is an old copy from before Plyloft managed skills; Plyloft no longer updates it. Remove it in a card.");
    assert_eq!(serde_json::to_value(Judgement::Follows(Side::Codex)).unwrap(), serde_json::json!({"state": "follows", "winner": "codex"}));
    assert_eq!(serde_json::to_value(Judgement::Differ).unwrap(), serde_json::json!({"state": "differ"}));
    assert!(vendor_only(Side::Codex, "agents/openai.yaml"));
    assert!(!vendor_only(Side::Claude, "agents/openai.yaml"));
}

// ── git ──────────────────────────────────────────────────────────────

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

fn commit(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

const MD: &str = "---\nname: x\ndescription: X.\n---\nBody.\n";

fn twins(dir: &Path, claude: &str, codex: &str) {
    write(dir, ".claude/skills/x/SKILL.md", claude);
    write(dir, ".agents/skills/x/SKILL.md", codex);
}

#[test]
fn a_codex_only_file_is_no_difference_and_is_never_copied_or_removed() {
    let r = repo();
    twins(r.path(), MD, MD);
    write(r.path(), ".agents/skills/x/agents/openai.yaml", "interface: {}\n");
    let head = commit(r.path(), "twins");
    assert!(same_at(r.path(), &head, "", "x"), "agents/openai.yaml is Codex's own");
    // Claude's copy changes and wins: Codex keeps its own file.
    write(r.path(), ".claude/skills/x/SKILL.md", "---\nname: x\ndescription: X.\n---\nNew.\n");
    let head = commit(r.path(), "claude edit");
    assert!(!same_at(r.path(), &head, "", "x"));
    let changes = align_changes(r.path(), &head, "", "x", Side::Claude).unwrap();
    let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, [".agents/skills/x/SKILL.md"]);
    // The other way: Claude never gets Codex's file.
    let changes = align_changes(r.path(), &head, "", "x", Side::Codex).unwrap();
    assert!(changes.iter().all(|c| !c.path.contains("openai.yaml")), "{:?}", changes.iter().map(|c| &c.path).collect::<Vec<_>>());
}

#[cfg(unix)]
#[test]
fn an_executable_bit_alone_is_a_difference_and_is_carried() {
    use std::os::unix::fs::PermissionsExt;
    let r = repo();
    twins(r.path(), MD, MD);
    write(r.path(), ".claude/skills/x/run.sh", "echo\n");
    write(r.path(), ".agents/skills/x/run.sh", "echo\n");
    let script = r.path().join(".claude/skills/x/run.sh");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let head = commit(r.path(), "bits");
    assert!(!same_at(r.path(), &head, "", "x"), "the mode is part of the content");
    let changes = align_changes(r.path(), &head, "", "x", Side::Claude).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, ".agents/skills/x/run.sh");
    assert_eq!(changes[0].content.as_ref().map(|(_, exec)| *exec), Some(true));
}

#[test]
fn a_file_the_winner_lacks_is_removed_from_the_loser() {
    let r = repo();
    twins(r.path(), MD, MD);
    write(r.path(), ".agents/skills/x/notes.md", "old\n");
    let head = commit(r.path(), "extra");
    let changes = align_changes(r.path(), &head, "", "x", Side::Claude).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, ".agents/skills/x/notes.md");
    assert!(changes[0].content.is_none());
}

#[test]
fn the_card_branch_aligns_the_one_twin_that_changed_and_names_the_rest() {
    let r = repo();
    twins(r.path(), MD, MD);
    write(r.path(), ".claude/skills/y/SKILL.md", MD);
    write(r.path(), ".agents/skills/y/SKILL.md", MD);
    write(r.path(), ".codex/skills/x/SKILL.md", "legacy\n");
    let base = commit(r.path(), "base");
    // x: only Codex's copy edited; y: both edited apart.
    write(r.path(), ".agents/skills/x/SKILL.md", "---\nname: x\ndescription: X.\n---\nCodex edit.\n");
    write(r.path(), ".claude/skills/y/SKILL.md", "one\n");
    write(r.path(), ".agents/skills/y/SKILL.md", "two\n");
    commit(r.path(), "builder");
    let done = align_card_branch(r.path(), &base, &[], &[], "").unwrap();
    assert_eq!(done.aligned, vec![Aligned { skill: "x".into(), winner: Side::Codex }]);
    assert_eq!(done.differ, vec!["y".to_string()]);
    let commit = done.commit.expect("one commit");
    assert_eq!(git(r.path(), &["rev-parse", "HEAD"]).trim(), commit, "the worktree moved to it");
    let changed = git(r.path(), &["diff", "--name-only", "HEAD~1", "HEAD"]);
    assert_eq!(changed.trim(), ".claude/skills/x/SKILL.md", "only the losing copy is written; never .codex/skills");
    assert_eq!(std::fs::read_to_string(r.path().join(".codex/skills/x/SKILL.md")).unwrap(), "legacy\n");
    // Nothing more to do on a second run.
    let again = align_card_branch(r.path(), &base, &[], &[], "").unwrap();
    assert!(again.aligned.is_empty() && again.commit.is_none());
}

#[test]
fn a_twin_the_card_never_touched_is_left_alone() {
    let r = repo();
    twins(r.path(), MD, "---\nname: x\ndescription: X.\n---\nApart already.\n");
    let base = commit(r.path(), "base apart");
    write(r.path(), "README.md", "unrelated\n");
    commit(r.path(), "builder");
    let done = align_card_branch(r.path(), &base, &[], &[], "").unwrap();
    assert!(done.aligned.is_empty() && done.differ.is_empty() && done.commit.is_none());
}

#[test]
fn a_linked_copy_is_judged_from_its_link_record_on_the_branch() {
    let r = repo();
    twins(r.path(), MD, "---\nname: x\ndescription: X.\n---\nCodex.\n");
    let base = commit(r.path(), "apart, no record");
    // No record: nobody wins.
    let here = crate::skill_card::twin_ids_at(r.path(), &base, "", "x");
    assert_eq!(judge(&here, false, &records_at(r.path(), &base, "", "x")), Judgement::Differ);
    // A link record whose base is Claude's tree: Codex changed alone.
    let claude = here.claude.clone().unwrap();
    write(
        r.path(),
        ".atelier/skill-links/x.json",
        &format!(r#"{{"schemaVersion":1,"origin":{{"kind":"team"}},"base":{{"claude":"{claude}","codex":"{claude}"}}}}"#),
    );
    let linked = commit(r.path(), "link");
    assert_eq!(judge(&here, false, &records_at(r.path(), &linked, "", "x")), Judgement::Follows(Side::Codex));
}

#[test]
fn a_checkout_with_crlf_in_both_copies_reads_them_the_same() {
    let r = repo();
    twins(r.path(), "---\r\nname: x\r\ndescription: X.\r\n---\r\nBody.\r\n", "---\nname: x\ndescription: X.\n---\nBody.\n");
    let here = ids(Some("one"), Some("two"));
    assert!(checkout_same(r.path(), "x", &here), "line endings are no difference");
    write(r.path(), ".agents/skills/x/SKILL.md", "---\nname: x\ndescription: X.\n---\nOther.\n");
    assert!(!checkout_same(r.path(), "x", &here));
}

#[test]
fn the_legacy_root_disagreeing_is_said_and_never_aligned() {
    let r = repo();
    twins(r.path(), MD, MD);
    assert!(!legacy_differs(r.path(), "x"));
    write(r.path(), ".codex/skills/x/SKILL.md", MD);
    assert!(!legacy_differs(r.path(), "x"), "the same copy is fine");
    write(r.path(), ".codex/skills/x/SKILL.md", "---\nname: x\ndescription: Old.\n---\n");
    assert!(legacy_differs(r.path(), "x"));
}

// ── The Align card's gate and preflight ─────────────────────────────

fn align_card(here: TwinIds, content: TwinIds, winner: Side) -> crate::skill_card::SkillCard {
    crate::skill_card::SkillCard {
        verb: crate::skill_card::SkillVerb::Align,
        skill: "x".into(),
        prefix: String::new(),
        origin: Default::default(),
        here,
        content,
        links: Vec::new(),
        renamed_to: None,
        link_before: None,
        link_after: None,
        align_winner: Some(winner), local_link: false, from_words: None,
        extra: Default::default(),
    }
}

#[test]
fn an_align_card_ships_without_verify_only_while_it_writes_the_losing_copy_alone() {
    let r = repo();
    twins(r.path(), "---\nname: x\ndescription: X.\n---\nClaude.\n", MD);
    let base = commit(r.path(), "apart");
    let changes = align_changes(r.path(), &base, "", "x", Side::Claude).unwrap();
    let git_plumbing = crate::shared_config::Plumbing { cwd: r.path().to_path_buf() };
    let head = git_plumbing.commit_tree_changes(&base, &changes, "align").unwrap();
    let here = crate::skill_card::twin_ids_at(r.path(), &base, "", "x");
    let content = crate::skill_card::twin_ids_at(r.path(), &head, "", "x");
    let card = align_card(here.clone(), content.clone(), Side::Claude);
    assert!(crate::skill_card::card_only(r.path(), &base, &head, &card));
    // The card names the other winner: Claude's copy changed, so no.
    assert!(!crate::skill_card::card_only(r.path(), &base, &head, &align_card(here.clone(), content.clone(), Side::Codex)));
    // A hand edit elsewhere goes through Verify.
    git(r.path(), &["checkout", "-q", &head]);
    write(r.path(), "README.md", "hand edit\n");
    let edited = commit(r.path(), "edit");
    assert!(!crate::skill_card::card_only(r.path(), &base, &edited, &card));
    // Preflight: the target as the card found it → go; already aligned →
    // up to date; moved → a pull request.
    let preflight = |tip: &str| crate::skill_card::preflight(r.path(), tip, "", &card, &crate::skill_links::Upstream::Unavailable, "main");
    assert_eq!(preflight(&base), crate::skill_card::Preflight::Go);
    assert_eq!(preflight(&head), crate::skill_card::Preflight::UpToDate);
    git(r.path(), &["checkout", "-q", &base]);
    write(r.path(), ".agents/skills/x/SKILL.md", "teammate\n");
    let moved = commit(r.path(), "teammate");
    assert!(matches!(preflight(&moved), crate::skill_card::Preflight::HereMoved(_)));
    // Never a stale card to refresh.
    assert!(!crate::skill_card::card_behind(&card, &crate::skill_links::Upstream::At("anything".into())));
}

#[test]
fn an_h4_card_kind_reads_without_an_align_winner_and_writes_none() {
    // Tier 2 schema migration (H5): a skill card written before H5.
    let kind: crate::skill_card::SkillCard = serde_json::from_value(serde_json::json!({
        "verb": "keepMine", "skill": "x", "origin": {"kind": "team"}, "here": {}, "content": {}
    }))
    .unwrap();
    assert!(kind.align_winner.is_none());
    assert!(!serde_json::to_string(&kind).unwrap().contains("alignWinner"));
    let align: crate::skill_card::SkillCard = serde_json::from_value(serde_json::json!({
        "verb": "align", "skill": "x", "origin": {}, "alignWinner": "codex"
    }))
    .unwrap();
    assert_eq!(align.align_winner, Some(Side::Codex));
    assert_eq!(crate::skill_card::align_title("x", Side::Codex), "Skill: align x (Claude's copy follows Codex's)");
}

#[test]
fn a_board_card_from_before_h5_loads_with_no_twins_aligned() {
    // Tier 2 schema migration (H5): `twinsAligned` absent loads empty and
    // is not written while empty.
    let card: crate::kanban::KanbanCard = serde_json::from_str(
        r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"todo","createdAt":0,"updatedAt":0}"#,
    )
    .unwrap();
    assert!(card.twins_aligned.is_empty());
    assert!(!serde_json::to_string(&card).unwrap().contains("twinsAligned"));
    // Challenger: the same for `twinsApart`.
    assert!(card.twins_apart.is_empty());
    assert!(!serde_json::to_string(&card).unwrap().contains("twinsApart"));
    let apart: crate::kanban::KanbanCard = serde_json::from_str(
        r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"todo","createdAt":0,"updatedAt":0,"twinsApart":["x"]}"#,
    )
    .unwrap();
    assert_eq!(apart.twins_apart, vec!["x".to_string()]);
    assert!(serde_json::to_string(&apart).unwrap().contains(r#""twinsApart":["x"]"#));
    let card: crate::kanban::KanbanCard = serde_json::from_str(
        r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"todo","createdAt":0,"updatedAt":0,"twinsAligned":[{"skill":"x","winner":"claude"}]}"#,
    )
    .unwrap();
    assert_eq!(card.twins_aligned, vec![Aligned { skill: "x".into(), winner: Side::Claude }]);
}

/// Challenger: a later round that changes one copy back is judged from the
/// earlier round's aligned snapshot, not from the card's base. From the
/// base, the *other* copy looks like the one that changed, and the align
/// would undo the Builder's revert.
#[test]
fn a_later_round_that_reverts_one_copy_is_judged_from_the_earlier_align() {
    let r = repo();
    twins(r.path(), MD, MD);
    let base = commit(r.path(), "base");
    let new = "---\nname: x\ndescription: X.\n---\nNew.\n";
    write(r.path(), ".claude/skills/x/SKILL.md", new);
    commit(r.path(), "round 1");
    let snapshot_1 = align_card_branch(r.path(), &base, &[], &[], "").unwrap().commit.expect("round 1 aligns Codex's copy");
    assert_eq!(std::fs::read_to_string(r.path().join(".agents/skills/x/SKILL.md")).unwrap(), new);
    // What the card records of round 1: Claude's copy won.
    let claude_won = [Aligned { skill: "x".into(), winner: Side::Claude }];
    // Round 2 (the H5 Builder walk's card #76): the Builder changes Claude's
    // copy back to the base.
    write(r.path(), ".claude/skills/x/SKILL.md", MD);
    commit(r.path(), "round 2");
    let second = align_card_branch(r.path(), &base, std::slice::from_ref(&snapshot_1), &claude_won, "").unwrap();
    assert_eq!(second.aligned, vec![Aligned { skill: "x".into(), winner: Side::Claude }]);
    assert_eq!(std::fs::read_to_string(r.path().join(".claude/skills/x/SKILL.md")).unwrap(), MD, "the revert is kept");
    assert_eq!(std::fs::read_to_string(r.path().join(".agents/skills/x/SKILL.md")).unwrap(), MD, "Codex's copy follows it");
    let snapshot_2 = second.commit.expect("round 2 aligns");
    // Round 3: both copies edited apart — nobody wins.
    write(r.path(), ".claude/skills/x/SKILL.md", "mine\n");
    write(r.path(), ".agents/skills/x/SKILL.md", "theirs\n");
    let snapshot_3 = commit(r.path(), "round 3");
    let third = align_card_branch(r.path(), &base, &[snapshot_2.clone(), snapshot_1.clone()], &claude_won, "").unwrap();
    assert_eq!(third.differ, vec!["x".to_string()]);
    // Round 4: the Builder puts Claude's copy back as round 2 left it. From
    // round 2's aligned state Codex's copy changed alone — but this round
    // changed Claude's and not Codex's, so copying Codex's over would undo
    // the round's own edit: Align asks instead.
    write(r.path(), ".claude/skills/x/SKILL.md", MD);
    commit(r.path(), "round 4");
    let fourth = align_card_branch(r.path(), &base, &[snapshot_3, snapshot_2, snapshot_1], &claude_won, "").unwrap();
    assert!(fourth.aligned.is_empty() && fourth.commit.is_none());
    assert_eq!(fourth.differ, vec!["x".to_string()]);
    assert_eq!(std::fs::read_to_string(r.path().join(".claude/skills/x/SKILL.md")).unwrap(), MD, "the round's edit stays");
}

/// Challenger (H5 Builder walk, card #75): round 1's Builder edits Claude's
/// copy and Plyloft aligns Codex's to it; round 2's Builder (asked by the
/// Challenger) puts Codex's copy back to the base, undoing Plyloft's align.
/// Codex's copy now looks like the one that changed since round 1, but
/// aligning to it would write over the Builder's own edit and empty the
/// card. The copies stay apart, the edit stays, and Align asks.
#[test]
fn a_round_that_undoes_plyloft_s_align_never_loses_the_builder_s_edit() {
    let r = repo();
    twins(r.path(), MD, MD);
    let base = commit(r.path(), "base");
    let edited = "---\nname: x\ndescription: X.\n---\nBody.\nBuilder line (H5 walk).\n";
    write(r.path(), ".claude/skills/x/SKILL.md", edited);
    commit(r.path(), "round 1");
    let first = align_card_branch(r.path(), &base, &[], &[], "").unwrap();
    assert_eq!(first.aligned, vec![Aligned { skill: "x".into(), winner: Side::Claude }]);
    let snapshot_1 = first.commit.unwrap();
    // Round 2: Codex's copy restored to the base.
    write(r.path(), ".agents/skills/x/SKILL.md", MD);
    commit(r.path(), "round 2");
    let second = align_card_branch(r.path(), &base, std::slice::from_ref(&snapshot_1), &first.aligned, "").unwrap();
    assert!(second.aligned.is_empty() && second.commit.is_none(), "no align either way");
    assert_eq!(second.differ, vec!["x".to_string()]);
    assert_eq!(std::fs::read_to_string(r.path().join(".claude/skills/x/SKILL.md")).unwrap(), edited, "the Builder's edit stays");
    assert_eq!(std::fs::read_to_string(r.path().join(".agents/skills/x/SKILL.md")).unwrap(), MD);
    // A third round that changes nothing about the skill settles the same way.
    write(r.path(), "README.md", "unrelated\n");
    let snapshot_2 = commit(r.path(), "round 3");
    let third = align_card_branch(r.path(), &base, &[snapshot_2, snapshot_1], &[], "").unwrap();
    assert!(third.commit.is_none());
    assert_eq!(std::fs::read_to_string(r.path().join(".claude/skills/x/SKILL.md")).unwrap(), edited);
}

/// Challenger (H5 Mac walk): with no link record and no ledger entry, the
/// committed history is the record — the newest commit that touched either
/// copy and left the two the same.
#[test]
fn with_no_record_the_history_names_the_copy_that_changed_alone() {
    let r = repo();
    twins(r.path(), MD, MD);
    write(r.path(), ".agents/skills/x/run.sh", "echo hi\n");
    write(r.path(), ".claude/skills/x/run.sh", "echo hi\n");
    commit(r.path(), "both the same");
    write(r.path(), "README.md", "unrelated\n");
    commit(r.path(), "unrelated");
    write(r.path(), ".agents/skills/x/SKILL.md", "---\nname: x\ndescription: X.\n---\nBody.\nEdited only in the Codex copy.\n");
    let head = commit(r.path(), "codex only");
    let here = crate::skill_card::checkout_twin_ids(r.path(), "x");
    assert_eq!(checkout_judgement(r.path(), "x", &here, None, None), Judgement::Follows(Side::Codex));
    // The same record on a branch: the Align card's winner, with no question.
    assert_eq!(judge(&crate::skill_card::twin_ids_at(r.path(), &head, "", "x"), false, &records_at(r.path(), &head, "", "x")), Judgement::Follows(Side::Codex));
    // Claude's copy then changes too: both changed since — Align asks.
    write(r.path(), ".claude/skills/x/SKILL.md", "---\nname: x\ndescription: X.\n---\nClaude.\n");
    commit(r.path(), "claude too");
    let here = crate::skill_card::checkout_twin_ids(r.path(), "x");
    assert_eq!(checkout_judgement(r.path(), "x", &here, None, None), Judgement::Differ);
}

/// Challenger (Windows parity): where the working tree keeps no executable
/// bit (`core.fileMode` false, always on Windows), two copies git records
/// apart only by that bit still read apart in the checkout — the bit is
/// the one `HEAD` records, as on a Mac.
#[cfg(unix)]
#[test]
fn a_checkout_without_an_executable_bit_reads_it_from_head() {
    use std::os::unix::fs::PermissionsExt;
    let r = repo();
    twins(r.path(), MD, MD);
    write(r.path(), ".claude/skills/x/run.sh", "echo hi\n");
    write(r.path(), ".agents/skills/x/run.sh", "echo hi\n");
    git(r.path(), &["add", "-A"]);
    git(r.path(), &["update-index", "--chmod=+x", ".claude/skills/x/run.sh"]);
    git(r.path(), &["commit", "-q", "-m", "apart by the bit"]);
    git(r.path(), &["config", "core.fileMode", "false"]);
    for path in [".claude/skills/x/run.sh", ".agents/skills/x/run.sh"] {
        std::fs::set_permissions(r.path().join(path), std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    let here = ids(Some("one"), Some("two"));
    assert!(!checkout_same(r.path(), "x", &here), "the bit HEAD records is a difference");
    git(r.path(), &["update-index", "--chmod=+x", ".agents/skills/x/run.sh"]);
    git(r.path(), &["commit", "-q", "-m", "both executable"]);
    assert!(checkout_same(r.path(), "x", &here));
}
