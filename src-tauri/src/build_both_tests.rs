//! SL-6 tests: keys and worktree keying of the variant, the comparison's
//! prompt and answer, when it runs, the pick and the stop, a restart, and
//! old boards.

use super::*;
use crate::kanban::{KanbanColumnId, KanbanStore};
use crate::worktree_setup::{WorktreeSetupRecord, WorktreeSetupState};

fn card(json_extra: &str) -> KanbanCard {
    serde_json::from_str(&format!(
        r#"{{"id":"card-moxa1234-1","workspaceId":"ws","title":"Add dark mode","columnId":"todo","createdAt":1,"updatedAt":1{json_extra}}}"#
    ))
    .unwrap()
}

fn git_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["commit", "--allow-empty", "-q", "-m", "init"],
    ] {
        crate::git::run(dir.path(), args).unwrap();
    }
    dir
}

/// A card built by both, with both lanes' worktrees under `root`.
fn both_card(root: &Path) -> KanbanCard {
    let a = root.join(".atelier-worktrees").join("card-moxa1234-1");
    let b = root.join(".atelier-worktrees").join("card-moxa1234-1-b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let mut c = card("");
    c.column_id = KanbanColumnId::InProgress;
    c.worktree_path = Some(a.to_string_lossy().into_owned());
    c.branch_name = Some("atelier/card-moxa1234-add-dark-mode".into());
    c.last_run_status = Some(LastRunStatus::Running);
    c.build_both = Some(new_record(
        &a.to_string_lossy(),
        "atelier/card-moxa1234-add-dark-mode",
        &b.to_string_lossy(),
        "atelier/card-moxa1234-add-dark-mode-b",
        true,
        10,
    ));
    c
}

fn lane_mut<'a>(c: &'a mut KanbanCard, lane: &str) -> &'a mut BuildLane {
    c.build_both.as_mut().unwrap().lane_mut(lane).unwrap()
}

fn finish(c: &mut KanbanCard, lane: &str, sha: &str) {
    let l = lane_mut(c, lane);
    l.started_at = Some(20);
    l.pty_id = Some(format!("pty-{lane}"));
    l.done = Some(LaneSnapshot { sha: sha.into(), at: 30 });
    l.verify = Some(LaneVerify { status: "passed".into(), sha: sha.into(), summary: Some("all 1 step(s) passed".into()), at: 40 });
}

// ── Keys ──────────────────────────────────────────────────────────────

#[test]
fn lane_keys_round_trip_and_a_plain_card_id_is_not_one() {
    assert_eq!(lane_key("card-x-1", LANE_A), "card-x-1#both-a");
    assert_eq!(parse_lane_key("card-x-1#both-a"), Some(("card-x-1", "a")));
    assert_eq!(parse_lane_key("card-x-1#both-b"), Some(("card-x-1", "b")));
    assert_eq!(parse_lane_key("card-x-1"), None);
    assert_eq!(parse_lane_key("card-x-1#both-c"), None);
    assert_eq!(parse_lane_key("#both-a"), None);
    assert_eq!(lane_vendor(LANE_A), "claude");
    assert_eq!(lane_vendor(LANE_B), "codex");
    assert_eq!(other_lane(LANE_A), LANE_B);
    assert_eq!(other_lane(LANE_B), LANE_A);
}

#[test]
fn the_variant_has_its_own_directory_and_branch() {
    let id = "card-moxa1234-1";
    assert_eq!(variant_dir(id), "card-moxa1234-1-b");
    let own = crate::worktrees::make_branch_name(id, "Add dark mode");
    // Why the branch is not made from the variant's id: the short id is the
    // same, so it would be the card's own branch.
    assert_eq!(crate::worktrees::make_branch_name(&variant_dir(id), "Add dark mode"), own);
    assert_eq!(variant_branch(&own), format!("{own}-b"));
    // SP-7: from the branch the card records, legacy prefix included.
    assert_eq!(variant_branch("atelier/card-moxa1234-add-dark-mode"), "atelier/card-moxa1234-add-dark-mode-b");
}

/// SP-7: a card started on a legacy `atelier/card-…` branch gets its variant
/// next to it, on the same prefix, not a `plyloft/card-…` name.
#[test]
fn the_variant_of_a_legacy_card_branch_keeps_its_prefix() {
    let repo = git_repo();
    let ws = repo.path();
    let id = "card-moxa1234-1";
    let own = crate::worktrees::ensure_for_card(ws, id, "Add dark mode", "main").unwrap();
    let legacy = own.branch_name.replacen(crate::worktrees::BRANCH_PREFIX, "atelier/card-", 1);
    crate::git::run(ws, &["branch", "-m", &own.branch_name, &legacy]).unwrap();
    let base = own.base.as_ref().unwrap().commit.clone();

    let b = crate::worktrees::ensure_variant_for_card(ws, id, &legacy, &base).unwrap();
    assert_eq!(b.branch_name, format!("{legacy}-b"));
    assert_eq!(crate::worktrees::checked_out_branch(&b.worktree_path), Some(format!("{legacy}-b")));
}

#[test]
fn card_worktree_dir_is_the_variant_only_for_the_variant_path() {
    let id = "card-moxa1234-1";
    let root = Path::new("/r");
    let variant = root.join(".atelier-worktrees").join("card-moxa1234-1-b");
    let own = root.join(".atelier-worktrees").join(id);
    let dir = |p: Option<&Path>| crate::worktrees::card_worktree_dir(id, p.and_then(|p| p.to_str()));
    assert_eq!(dir(Some(&variant)), "card-moxa1234-1-b");
    assert_eq!(dir(Some(&own)), id);
    assert_eq!(dir(None), id);
    // Only under `.atelier-worktrees/`, and only this card's variant.
    assert_eq!(dir(Some(&root.join("elsewhere").join("card-moxa1234-1-b"))), id);
    assert_eq!(dir(Some(&root.join(".atelier-worktrees").join("card-other-1-b"))), id);
}

#[test]
fn the_variant_worktree_starts_at_the_cards_base_and_never_adopts() {
    let repo = git_repo();
    let ws = repo.path();
    let id = "card-moxa1234-1";
    let own = crate::worktrees::ensure_for_card(ws, id, "Add dark mode", "main").unwrap();
    let base = own.base.as_ref().unwrap().commit.clone();
    // The main branch moves on; the variant still starts where the card did.
    crate::git::run(ws, &["commit", "--allow-empty", "-q", "-m", "later"]).unwrap();
    let b = crate::worktrees::ensure_variant_for_card(ws, id, &own.branch_name, &base).unwrap();
    assert!(b.created);
    assert_eq!(b.worktree_path, crate::worktrees::worktree_path_for_card(ws, "card-moxa1234-1-b"));
    assert_eq!(b.branch_name, format!("{}-b", own.branch_name));
    assert_eq!(crate::worktrees::head_sha(&b.worktree_path).unwrap(), base);
    assert_eq!(crate::worktrees::checked_out_branch(&own.worktree_path).as_deref(), Some(own.branch_name.as_str()));
    // A second time: refused, nothing overwritten.
    let again = crate::worktrees::ensure_variant_for_card(ws, id, &own.branch_name, &base).unwrap_err();
    assert!(again.contains("already exists"), "{again}");
    // Its prune goes by its own directory and keeps its branch.
    let moved = crate::worktrees::prune_for_card(ws, &variant_dir(id), &[]).unwrap();
    assert!(moved.is_some());
    assert!(!b.worktree_path.exists());
    assert!(own.worktree_path.is_dir(), "the card's own worktree stays");
    assert!(crate::git::capture(ws, &["rev-parse", "--verify", &b.branch_name]).is_ok(), "branch kept");
}

// ── Starting ──────────────────────────────────────────────────────────

#[test]
fn build_with_both_needs_both_vendors_and_a_card_not_yet_built() {
    let ready = |_: &str| None;
    assert_eq!(start_refusal(&card(""), ready), None);
    let no_codex = |v: &str| (v == "codex").then(|| "Codex isn't installed on this Mac.".to_string());
    let why = start_refusal(&card(""), no_codex).unwrap();
    assert!(why.starts_with("Build with both needs Claude and Codex."), "{why}");
    assert!(why.contains("Codex isn't installed"), "{why}");
    let mut started = card("");
    started.worktree_path = Some("/r/.atelier-worktrees/x".into());
    assert!(start_refusal(&started, ready).unwrap().contains("hasn't been built yet"));
    let mut moved = card("");
    moved.column_id = KanbanColumnId::InProgress;
    assert!(start_refusal(&moved, ready).is_some());
    let mut archived = card("");
    archived.archived = true;
    assert!(start_refusal(&archived, ready).is_some());
}

#[test]
fn a_lane_held_by_its_setup_does_not_start_and_the_other_does() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    assert_eq!(startable_lanes(&c), vec!["a".to_string(), "b".to_string()]);
    let mut failed = WorktreeSetupRecord::running(Some("npm ci"), 5);
    failed.state = WorktreeSetupState::Failed;
    lane_mut(&mut c, LANE_B).worktree_setup = Some(failed.clone());
    assert_eq!(startable_lanes(&c), vec!["a".to_string()]);
    // Lane a's setup is the card's own.
    c.worktree_setup = Some(failed.clone());
    assert!(startable_lanes(&c).is_empty());
    failed.state = WorktreeSetupState::Skipped;
    lane_mut(&mut c, LANE_B).worktree_setup = Some(failed);
    assert_eq!(startable_lanes(&c), vec!["b".to_string()]);
    // Started (or stopped) lanes are not started again.
    lane_mut(&mut c, LANE_B).started_at = Some(1);
    assert!(startable_lanes(&c).is_empty());
}

#[test]
fn the_lane_preamble_says_the_card_is_built_twice_before_the_task() {
    let p = lane_preamble("Add dark mode");
    let note = p.find("built twice").expect("note");
    let task = p.find("Task:\n").expect("task");
    assert!(note < task, "{p}");
    assert!(p.ends_with("Task:\n"), "the brief follows: {p:?}");
    assert!(p.contains("do NOT push"), "the Builder's rules stay");
}

// ── Comparing ─────────────────────────────────────────────────────────

#[test]
fn the_comparison_waits_for_both_builds_and_their_checks() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    let none = |_: &str| false;
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Wait);
    finish(&mut c, LANE_A, "aaa");
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Wait);
    finish(&mut c, LANE_B, "bbb");
    // A Verify still running holds it.
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), |l| l == "b"), CompareStep::Wait);
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Run);
    // Once compared, the same snapshots are not compared again…
    c.build_both.as_mut().unwrap().compare = Some(BuildCompare {
        status: "done".into(),
        sha_a: Some("aaa".into()),
        sha_b: Some("bbb".into()),
        ..Default::default()
    });
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Nothing);
    // …a failed pass neither (Compare again is the owner's)…
    c.build_both.as_mut().unwrap().compare.as_mut().unwrap().status = "failed".into();
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Nothing);
    // …but a new Build done in one lane is.
    finish(&mut c, LANE_B, "bbb2");
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Run);
    // Nothing while one runs, and nothing after the pick.
    c.build_both.as_mut().unwrap().compare.as_mut().unwrap().status = "running".into();
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Nothing);
    c.build_both.as_mut().unwrap().compare = None;
    c.build_both.as_mut().unwrap().outcome = Some(BuildBothOutcome { kind: "picked".into(), ..Default::default() });
    assert_eq!(compare_step(c.build_both.as_ref().unwrap(), none), CompareStep::Nothing);
}

/// Round 3: a build whose checks wait for the OK holds the comparison, and
/// its card is one of those whose builds' checks start again when the
/// checks need no OK any more — else it would wait for ever.
#[test]
fn a_card_with_a_waiting_build_is_found_and_only_while_it_is_undecided() {
    let tmp = tempfile::tempdir().unwrap();
    let mut waits = both_card(tmp.path());
    finish(&mut waits, LANE_A, "aaa");
    finish(&mut waits, LANE_B, "bbb");
    lane_mut(&mut waits, LANE_B).verify =
        Some(LaneVerify { status: LANE_WAITS.into(), sha: "bbb".into(), summary: Some("The checks need your OK".into()), at: 41 });
    assert_eq!(compare_step(waits.build_both.as_ref().unwrap(), |_| false), CompareStep::Wait);
    let mut settled = both_card(tmp.path());
    settled.id = "card-settled".into();
    finish(&mut settled, LANE_A, "aaa");
    finish(&mut settled, LANE_B, "bbb");
    let plain = card("");
    let mut archived = waits.clone();
    archived.id = "card-archived".into();
    archived.archived = true;
    let mut picked = waits.clone();
    picked.id = "card-picked".into();
    picked.build_both.as_mut().unwrap().outcome = Some(BuildBothOutcome { kind: "picked".into(), ..Default::default() });
    let cards = [settled, plain, waits.clone(), archived, picked];
    assert_eq!(cards_with_waiting_lanes(&cards), vec![waits.id.clone()]);
    // Started again, the build is "running": found no more, and the comparison
    // waits on the run itself.
    lane_mut(&mut waits, LANE_B).verify = Some(LaneVerify { status: "running".into(), sha: "bbb".into(), ..Default::default() });
    assert!(cards_with_waiting_lanes(&[waits]).is_empty());
    // The view that takes the stale mark off is where they start again.
    let consent = include_str!("checks_consent.rs");
    let (_, view) = consent.split_once("pub fn checks_consent_view(").unwrap();
    let view = view.split_once("\n}\n").unwrap().0;
    let released = view.find("release_stale_holds(&kanban, &workspace_id)").expect("the mark comes off");
    let found = view.find("crate::build_both::cards_with_waiting_lanes(&cards)").expect("the waiting builds are found");
    let restarted = view.find("crate::build_both::restart_waiting_lanes(&app, &workspace_id, id)").expect("and started again");
    assert!(view.find("if !view.checks.needs_ok {").unwrap() < released && released < found && found < restarted);
}

#[test]
fn one_failed_build_is_decided_without_a_pass() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    finish(&mut c, LANE_A, "aaa");
    lane_mut(&mut c, LANE_B).failed = Some("You stopped it before it finished".into());
    match compare_step(c.build_both.as_ref().unwrap(), |_| false) {
        CompareStep::Decide { recommended, reason } => {
            assert_eq!(recommended.as_deref(), Some("a"));
            assert_eq!(reason, "Only Claude's build has a result; Codex's ended without one: You stopped it before it finished.");
        }
        other => panic!("{other:?}"),
    }
    lane_mut(&mut c, LANE_A).done = None;
    lane_mut(&mut c, LANE_A).failed = Some("Its Builder couldn't start: x".into());
    match compare_step(c.build_both.as_ref().unwrap(), |_| false) {
        CompareStep::Decide { recommended, reason } => {
            assert_eq!(recommended, None);
            assert!(reason.starts_with("Neither build has a result."), "{reason}");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_prompt_names_both_builds_unnamed_and_their_diffs_are_files() {
    let root = tempfile::tempdir().unwrap();
    let passed = verify_words(Some(&LaneVerify { status: "passed".into(), summary: Some("all 2 step(s) passed".into()), ..Default::default() }));
    let failed = verify_words(Some(&LaneVerify { status: "failed".into(), summary: Some("script:test failed: 1 failing".into()), ..Default::default() }));
    let a = write_lane_files(root.path(), "a", "aaa111", " src/a.ts | 2 +-", "+const dark = true;", false, passed).unwrap();
    let b = write_lane_files(root.path(), "b", "bbb222", " src/b.ts | 9 +++", "+export const theme = 'dark';", true, failed).unwrap();
    assert_eq!(std::fs::read_to_string(root.path().join(&a.diff_file)).unwrap(), "+const dark = true;");
    assert_eq!(std::fs::read_to_string(root.path().join(&b.stat_file)).unwrap(), " src/b.ts | 9 +++");
    assert!(a.diff_file.starts_with(".plyloft-compare/"));
    let p = compare_prompt("Add dark mode to the settings page.", "base000", &a, &b);
    for needle in [
        "Add dark mode to the settings page.",
        "## Build A",
        "## Build B",
        "Commit: aaa111",
        "Commit: bbb222",
        "`.plyloft-compare/build-a.diff`",
        "`.plyloft-compare/build-b.stat`",
        "common base (base000)",
        "git diff base000 <commit>",
        "passed (all 2 step(s) passed).",
        "FAILED — script:test failed: 1 failing.",
        "cut at 4 MiB",
        "RECOMMENDATION: A",
        "read-only",
    ] {
        assert!(p.contains(needle), "missing {needle:?}");
    }
    assert!(!p.contains("+const dark = true;"), "no diff in the prompt");
    assert_eq!(p.matches("cut at 4 MiB").count(), 1, "only B was cut");
    assert!(!p.contains("Claude") && !p.contains("Codex"), "the vendors are not named");
    assert!(p.find("## Build A").unwrap() < p.find("## Build B").unwrap());
}

/// Windows caps a command line at 32,767 characters, and the prompt is one
/// argument of the reviewer's: with the largest brief the card can give
/// (capped at 16 KiB) and long check lines, it stays well under.
#[test]
fn the_prompt_fits_a_windows_command_line_whatever_the_diff() {
    let root = tempfile::tempdir().unwrap();
    let huge = "+x\n".repeat(2_000_000);
    let long_check = verify_words(Some(&LaneVerify { status: "failed".into(), summary: Some("y".repeat(300)), ..Default::default() }));
    let a = write_lane_files(root.path(), "a", &"a".repeat(40), &"s".repeat(10_000), &huge, true, long_check.clone()).unwrap();
    let b = write_lane_files(root.path(), "b", &"b".repeat(40), &"s".repeat(10_000), &huge, true, long_check).unwrap();
    let brief = crate::review_passes::capped_brief(&"brief line\n".repeat(20_000));
    let p = compare_prompt(&brief, &"c".repeat(40), &a, &b);
    assert!(p.chars().count() < 24_000, "{} characters", p.chars().count());
}

#[test]
fn the_verdict_is_read_in_its_shape_and_its_variants() {
    let plain = "Both work.\n\nRECOMMENDATION: B\nREASONS:\n- B has tests for the toggle\n- A misses the persisted setting\n";
    assert_eq!(
        parse_compare(plain),
        Some(CompareAnswer {
            recommended: Some("b".into()),
            reasons: vec!["B has tests for the toggle".into(), "A misses the persisted setting".into()],
            lanes: vec![],
        })
    );
    let markdown = "**Recommendation:** Build A\n\n**Reasons:**\n1. Smaller change\n2) Checks passed\n* reuses the theme hook\n";
    let parsed = parse_compare(markdown).unwrap();
    assert_eq!(parsed.recommended.as_deref(), Some("a"));
    assert_eq!(parsed.reasons, vec!["Smaller change", "Checks passed", "reuses the theme hook"]);
    let neither = parse_compare("RECOMMENDATION: NEITHER\nREASONS:\n- both break the build").unwrap();
    assert_eq!(neither.recommended, None);
    assert_eq!(neither.reasons, vec!["both break the build"]);
    // The last recommendation wins (a draft line quoted earlier).
    let twice = parse_compare("I first thought RECOMMENDATION: A\nRECOMMENDATION: B\nREASONS:\n- x").unwrap();
    assert_eq!(twice.recommended.as_deref(), Some("b"));
    // A line after the reasons ends them; a word that isn't A/B/NEITHER is no pick.
    let tail = parse_compare("RECOMMENDATION: A\nREASONS:\n- one\nThat is all.\n- not a reason").unwrap();
    assert_eq!(tail.reasons, vec!["one"]);
    assert_eq!(parse_compare("RECOMMENDATION: maybe\n- x"), None);
    assert_eq!(parse_compare("A is better."), None);
    let many: String = (0..20).map(|i| format!("- reason {i}\n")).collect();
    assert_eq!(parse_compare(&format!("RECOMMENDATION: A\nREASONS:\n{many}")).unwrap().reasons.len(), 8);
}

#[test]
fn an_unreadable_answer_is_a_failed_comparison_with_its_text_kept() {
    let c = compare_from_answer("I can't decide.", "codex", Some("a1".into()), Some("b1".into()), 1, 2);
    assert_eq!(c.status, "failed");
    assert_eq!(c.excerpt.as_deref(), Some("I can't decide."));
    assert!(c.error.unwrap().contains("no recommendation"));
    assert_eq!((c.sha_a.as_deref(), c.sha_b.as_deref()), (Some("a1"), Some("b1")));
    let ok = compare_from_answer("RECOMMENDATION: A\nREASONS:\n- x", "claude", None, None, 1, 2);
    assert_eq!(ok.status, "done");
    assert_eq!(ok.provider.as_deref(), Some("claude"));
    assert_eq!(ok.recommended.as_deref(), Some("a"));
}

#[test]
fn a_lane_verify_is_read_from_the_registrys_last_status() {
    use crate::kanban::VerifyStepResult;
    use crate::verify::VerifyStateOut as S;
    let step = |kind: &str, passed: bool, reason: Option<&str>| VerifyStepResult {
        kind: kind.into(),
        passed,
        elapsed_ms: 1,
        reason: reason.map(str::to_string),
    };
    assert_eq!(lane_verify_from_status(&S::Queued { position: 1 }, &[], "s", 1), None);
    let passed = lane_verify_from_status(&S::Passed, &[step("script:t", true, None)], "s", 1).unwrap();
    assert_eq!((passed.status.as_str(), passed.summary.as_deref()), ("passed", Some("all 1 step(s) passed")));
    let none = lane_verify_from_status(&S::Passed, &[], "s", 1).unwrap();
    assert_eq!(none.summary.as_deref(), Some("no checks are set up"));
    let failed = lane_verify_from_status(
        &S::Failed { reason: "whole output".into() },
        &[step("script:t", false, Some("line 1\nerror: 2 tests failed\n\n"))],
        "s",
        1,
    )
    .unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.summary.as_deref(), Some("script:t failed: error: 2 tests failed"));
    assert_eq!(lane_verify_from_status(&S::CapacityStall { detail: "cap".into() }, &[], "s", 1).unwrap().status, "stalled");
    assert_eq!(lane_verify_from_status(&S::TimedOut { step: "x".into() }, &[], "s", 1).unwrap().status, "failed");
}

// ── Picking and stopping ──────────────────────────────────────────────

#[test]
fn a_pick_needs_both_builds_settled_and_a_result_to_pick() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    assert!(pick_refusal(&card(""), "a").unwrap().contains("isn't being built by both"));
    finish(&mut c, LANE_A, "aaa");
    assert!(pick_refusal(&c, "a").unwrap().contains("Both builds must be done"));
    lane_mut(&mut c, LANE_B).failed = Some("stopped".into());
    assert_eq!(pick_refusal(&c, "a"), None);
    assert!(pick_refusal(&c, "b").unwrap().contains("Codex's build has no result"));
    assert!(pick_refusal(&c, "c").is_some());
    c.build_both.as_mut().unwrap().compare = Some(BuildCompare { status: "running".into(), ..Default::default() });
    assert!(pick_refusal(&c, "a").unwrap().contains("still comparing"));
    c.build_both.as_mut().unwrap().compare = None;
    c.build_both.as_mut().unwrap().outcome = Some(BuildBothOutcome { kind: "picked".into(), ..Default::default() });
    assert!(pick_refusal(&c, "a").unwrap().contains("already picked"));
}

#[test]
fn picking_codex_makes_its_worktree_branch_setup_and_session_the_cards() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    finish(&mut c, LANE_A, "aaa");
    finish(&mut c, LANE_B, "bbb");
    let setup = WorktreeSetupRecord { state: WorktreeSetupState::Done, ..WorktreeSetupRecord::running(Some("npm ci"), 3) };
    lane_mut(&mut c, LANE_B).worktree_setup = Some(setup.clone());
    lane_mut(&mut c, LANE_B).model = Some("gpt-6".into());
    c.build_both.as_mut().unwrap().compare = Some(BuildCompare {
        status: "done".into(),
        recommended: Some("b".into()),
        ..Default::default()
    });
    assert_eq!(pick_refusal(&c, "b"), None);
    let b_path = c.build_both.as_ref().unwrap().lane("b").unwrap().worktree_path.clone();
    let archived = archived_lane(
        c.build_both.as_ref().unwrap().lane("a").unwrap(),
        Ok(Some(PathBuf::from("/r/.atelier-worktrees/.trash/card-moxa1234-1-9"))),
    );
    apply_pick(&mut c, "b", Some("me@x"), 99, archived).unwrap();
    assert_eq!(c.worktree_path.as_deref(), Some(b_path.as_str()));
    assert_eq!(c.branch_name.as_deref(), Some("atelier/card-moxa1234-add-dark-mode-b"));
    assert_eq!(c.worktree_setup, Some(setup));
    assert_eq!(
        crate::worktrees::card_worktree_dir(&c.id, c.worktree_path.as_deref()),
        "card-moxa1234-1-b",
        "every prune now acts on the variant"
    );
    let b = c.builder.as_ref().unwrap();
    assert_eq!((b.vendor.as_str(), b.pty_id.as_deref(), b.session_lost), ("codex", Some("pty-b"), false));
    assert!(b.snapshots.is_empty(), "its first Build done is the normal loop's");
    assert!(b.bypass);
    assert_eq!(b.model.as_deref(), Some("gpt-6"));
    assert_eq!(c.last_run_status, Some(LastRunStatus::Running));
    let bb = c.build_both.as_ref().unwrap();
    assert!(!bb.undecided());
    assert!(!is_undecided(&c));
    let outcome = bb.outcome.as_ref().unwrap();
    assert_eq!((outcome.kind.as_str(), outcome.lane.as_deref(), outcome.vendor.as_deref()), ("picked", Some("b"), Some("codex")));
    assert_eq!(outcome.followed_recommendation, Some(true));
    assert_eq!(outcome.by.as_deref(), Some("me@x"));
    assert_eq!(outcome.archived.len(), 1);
    assert_eq!(outcome.archived[0].vendor, "claude");
    assert_eq!(outcome.archived[0].branch_name, "atelier/card-moxa1234-add-dark-mode");
    assert!(outcome.archived[0].trash_path.as_deref().unwrap().contains(".trash"));
    assert_eq!(bb.lane("a").unwrap().pty_id, None, "the set-aside session is not the card's");
    assert!(pick_refusal(&c, "a").is_some(), "one pick only");
}

#[test]
fn picking_claude_keeps_the_cards_own_worktree_and_a_lost_session_reads_lost() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    finish(&mut c, LANE_A, "aaa");
    finish(&mut c, LANE_B, "bbb");
    lane_mut(&mut c, LANE_A).pty_id = None;
    lane_mut(&mut c, LANE_A).session_lost = true;
    let before = c.worktree_path.clone();
    // CL-5 round 2 (F3): rounds the card kept survive the pick.
    let mut kept: crate::kanban::BuilderState = serde_json::from_str(r#"{"vendor":"claude"}"#).unwrap();
    kept.review_rounds = vec![crate::kanban::ReviewRound { round: 1, ledger_round: 1, review_id: "r1".into(), ..Default::default() }];
    c.builder = Some(kept);
    let archived = archived_lane(c.build_both.as_ref().unwrap().lane("b").unwrap(), Err("busy".into()));
    apply_pick(&mut c, "a", None, 99, archived).unwrap();
    assert_eq!(c.builder.as_ref().unwrap().review_rounds.len(), 1, "the card's rounds are kept");
    assert_eq!(c.worktree_path, before);
    assert_eq!(c.branch_name.as_deref(), Some("atelier/card-moxa1234-add-dark-mode"));
    let b = c.builder.as_ref().unwrap();
    assert_eq!((b.vendor.as_str(), b.pty_id.as_deref(), b.session_lost), ("claude", None, true), "Resume");
    let outcome = c.build_both.as_ref().unwrap().outcome.as_ref().unwrap();
    assert_eq!(outcome.followed_recommendation, None, "no recommendation was made");
    assert!(outcome.archived[0].problem.as_deref().unwrap().contains("busy"));
    assert_eq!(crate::worktrees::card_worktree_dir(&c.id, c.worktree_path.as_deref()), c.id);
}

#[test]
fn stopping_keeps_claudes_worktree_with_no_builder() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    finish(&mut c, LANE_A, "aaa");
    c.build_both.as_mut().unwrap().compare = Some(BuildCompare { status: "running".into(), ..Default::default() });
    let before = c.worktree_path.clone();
    let archived = archived_lane(c.build_both.as_ref().unwrap().lane("b").unwrap(), Ok(None));
    apply_stop(&mut c, Some("me"), 7, archived).unwrap();
    assert_eq!(c.worktree_path, before);
    assert!(c.builder.is_none());
    assert_eq!(c.last_run_status, None);
    let bb = c.build_both.as_ref().unwrap();
    assert_eq!(bb.outcome.as_ref().unwrap().kind, "stopped");
    assert_eq!(bb.compare.as_ref().unwrap().status, "failed");
    assert!(bb.lanes.iter().all(|l| l.pty_id.is_none()));
    assert!(!is_undecided(&c));
    assert!(apply_stop(&mut c, None, 8, ArchivedLane::default()).is_err(), "once");
}

// ── A restart, and old boards ─────────────────────────────────────────

#[test]
fn after_a_restart_live_lanes_read_lost_and_running_work_failed() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    finish(&mut c, LANE_A, "aaa");
    lane_mut(&mut c, LANE_A).verify.as_mut().unwrap().status = "running".into();
    lane_mut(&mut c, LANE_B).worktree_setup = Some(WorktreeSetupRecord::running(Some("npm ci"), 1));
    c.build_both.as_mut().unwrap().compare = Some(BuildCompare { status: "running".into(), ..Default::default() });
    let bb = c.build_both.as_mut().unwrap();
    assert!(settle_on_load(bb, "ws-restart", "card-moxa1234-1"));
    let a = bb.lane("a").unwrap();
    assert_eq!((a.pty_id.as_deref(), a.session_lost), (None, true));
    assert_eq!(a.verify.as_ref().unwrap().status, "interrupted");
    let b = bb.lane("b").unwrap();
    assert_eq!(b.worktree_setup.as_ref().unwrap().state, WorktreeSetupState::Failed);
    assert_eq!(b.session_lost, false, "a lane never started is not lost");
    assert_eq!(bb.compare.as_ref().unwrap().status, "failed");
    assert!(!settle_on_load(bb, "ws-restart", "card-moxa1234-1"), "nothing left to settle");
}

#[test]
fn a_board_from_before_build_with_both_loads_and_saves_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws-pre-sl6.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let json = format!(
        r#"{{
        "version": {},
        "cards": [{{
            "id": "c1",
            "workspaceId": "ws-pre-sl6",
            "title": "built by one Builder before SL-6",
            "columnId": "in_progress",
            "worktreePath": "/r/.atelier-worktrees/c1",
            "branchName": "atelier/card-c1-x",
            "createdAt": 1,
            "updatedAt": 5
        }}]
    }}"#,
        crate::kanban::KANBAN_SCHEMA_VERSION
    );
    std::fs::write(&path, json.as_bytes()).unwrap();
    let cards = store.load("ws-pre-sl6").unwrap();
    assert_eq!(cards[0].build_both, None);
    assert!(!is_undecided(&cards[0]));
    assert_eq!(crate::worktrees::card_worktree_dir("c1", cards[0].worktree_path.as_deref()), "c1");
    assert_eq!(std::fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
    store.save("ws-pre-sl6", cards).unwrap();
    let on_disk = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
    assert!(!on_disk.contains("buildBoth"), "{on_disk}");
}

#[test]
fn a_card_built_by_both_round_trips_and_a_sparse_record_loads() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    finish(&mut c, LANE_A, "aaa");
    let json = serde_json::to_string(&c).unwrap();
    assert!(json.contains("\"buildBoth\""), "{json}");
    assert!(json.contains("\"worktreePath\""));
    let back: KanbanCard = serde_json::from_str(&json).unwrap();
    assert_eq!(back.build_both, c.build_both);
    // Written by a later Plyloft with fields this one doesn't know, or with
    // most fields missing: loads with the defaults.
    let sparse = card(r#","buildBoth":{"lanes":[{"lane":"b","someLaterField":1}],"compare":{"status":"done"}}"#);
    let bb = sparse.build_both.unwrap();
    assert!(bb.undecided());
    let b = bb.lane("b").unwrap();
    assert_eq!((b.vendor.as_str(), b.started_at, b.done.as_ref()), ("", None, None));
    assert_eq!(bb.compare.unwrap().reasons, Vec::<String>::new());
}

#[test]
fn a_restart_during_both_builds_is_settled_on_load_and_written_once() {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut c = both_card(root.path());
    c.workspace_id = "ws-live".into();
    finish(&mut c, LANE_A, "aaa");
    store.save("ws-live", vec![c]).unwrap();
    // A second store is a second launch: it reads the file from disk.
    let relaunched = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let cards = relaunched.load("ws-live").unwrap();
    let a = cards[0].build_both.as_ref().unwrap().lane("a").unwrap().clone();
    assert_eq!((a.pty_id, a.session_lost), (None, true));
    let on_disk = std::fs::read_to_string(tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws-live.json")).unwrap();
    assert!(!on_disk.contains("pty-a"), "settled on disk too");
}

// ── Review round 1 ────────────────────────────────────────────────────

/// A repo with the card's worktree and the Codex worktree, each with a
/// committed change, and the card on the board built by both, both done.
fn picked_fixture() -> (tempfile::TempDir, tempfile::TempDir, KanbanStore, KanbanCard) {
    let repo = git_repo();
    let ws = repo.path();
    let id = "card-moxa1234-1";
    let a = crate::worktrees::ensure_for_card(ws, id, "Add dark mode", "main").unwrap();
    let base = a.base.as_ref().unwrap().commit.clone();
    let b = crate::worktrees::ensure_variant_for_card(ws, id, &a.branch_name, &base).unwrap();
    for (wt, file) in [(&a.worktree_path, "claude.txt"), (&b.worktree_path, "codex.txt")] {
        std::fs::write(wt.join(file), "x").unwrap();
        crate::worktrees::commit_pending_in_worktree(wt, "build").unwrap();
    }
    // Claude left something uncommitted after its Build done.
    std::fs::write(a.worktree_path.join("late.txt"), "late").unwrap();
    let config = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(config.path().to_path_buf()).unwrap();
    let mut c = card("");
    c.column_id = KanbanColumnId::InProgress;
    c.worktree_path = Some(a.worktree_path.to_string_lossy().into_owned());
    c.branch_name = Some(a.branch_name.clone());
    c.worktree_base = a.base.clone();
    c.last_run_status = Some(LastRunStatus::Running);
    let mut bb = new_record(
        &a.worktree_path.to_string_lossy(),
        &a.branch_name,
        &b.worktree_path.to_string_lossy(),
        &b.branch_name,
        false,
        10,
    );
    for (lane, wt) in [(LANE_A, &a.worktree_path), (LANE_B, &b.worktree_path)] {
        let l = bb.lane_mut(lane).unwrap();
        l.started_at = Some(11);
        l.pty_id = Some(format!("pty-{lane}"));
        l.done = Some(LaneSnapshot { sha: crate::worktrees::head_sha(wt).unwrap(), at: 12 });
        l.verify = Some(LaneVerify { status: "passed".into(), ..Default::default() });
    }
    bb.compare = Some(BuildCompare { status: "done".into(), recommended: Some("b".into()), ..Default::default() });
    c.build_both = Some(bb);
    store.save("ws", vec![c.clone()]).unwrap();
    (repo, config, store, c)
}

#[test]
fn a_pick_end_to_end_rekeys_the_session_and_sets_the_other_aside_on_its_kept_branch() {
    let (repo, _config, store, c) = picked_fixture();
    let ws = repo.path();
    let registry = crate::builder::BuilderRegistry::default();
    let pty = crate::pty::PtyRegistry::default();
    registry.insert_for_test(&lane_key(&c.id, LANE_A), "pty-a", "claude");
    registry.insert_for_test(&lane_key(&c.id, LANE_B), "pty-b", "codex");
    let a_path = PathBuf::from(c.worktree_path.clone().unwrap());
    let a_branch = c.branch_name.clone().unwrap();

    let picked = pick_locked(&store, &registry, &pty, &|_| false, ws, &[], "ws", &c.id, LANE_B, Some("me")).unwrap();

    // The session is the card's now, and no lane holds one.
    assert_eq!(registry.get_pty(&c.id).as_deref(), Some("pty-b"));
    assert_eq!(registry.get_pty(&lane_key(&c.id, LANE_A)), None);
    assert_eq!(registry.get_pty(&lane_key(&c.id, LANE_B)), None);
    let b = picked.builder.as_ref().unwrap();
    assert_eq!((b.vendor.as_str(), b.pty_id.as_deref(), b.session_lost), ("codex", Some("pty-b"), false));
    assert!(picked.build_both.as_ref().unwrap().lanes.iter().all(|l| l.pty_id.is_none()), "one record only");
    // Claude's build: in the trash, its late file committed on its kept branch.
    assert!(!a_path.exists());
    let archived = &picked.build_both.as_ref().unwrap().outcome.as_ref().unwrap().archived[0];
    assert!(archived.trash_path.as_deref().unwrap().contains(".trash"), "{archived:?}");
    assert_eq!(archived.problem, None);
    assert_eq!(crate::git::capture(ws, &["show", &format!("{a_branch}:late.txt")]).unwrap(), "late");
    // The card continues on the variant: everything acts on `<id>-b`, and
    // no leftover sweep ever takes it.
    let dir = crate::worktrees::card_worktree_dir(&c.id, picked.worktree_path.as_deref());
    assert_eq!(dir, variant_dir(&c.id));
    assert_eq!(prune_leftover_variant(ws, &picked, &[]), None);
    assert!(Path::new(picked.worktree_path.as_deref().unwrap()).is_dir());
    assert_eq!(store.get_card("ws", &c.id).unwrap().worktree_path, picked.worktree_path, "on disk too");
    // Its land / archive / delete prune takes the variant, branch kept.
    let branch = picked.branch_name.clone().unwrap();
    assert!(crate::worktrees::prune_for_card(ws, &dir, &[]).unwrap().is_some());
    assert!(!Path::new(picked.worktree_path.as_deref().unwrap()).exists());
    assert!(crate::git::capture(ws, &["rev-parse", "--verify", &branch]).is_ok());
}

#[test]
fn a_pick_refused_changes_nothing() {
    let (repo, _config, store, c) = picked_fixture();
    let registry = crate::builder::BuilderRegistry::default();
    let pty = crate::pty::PtyRegistry::default();
    let a_key = lane_key(&c.id, LANE_A);
    let err = pick_locked(&store, &registry, &pty, &|k| k == a_key, repo.path(), &[], "ws", &c.id, LANE_B, None).unwrap_err();
    assert!(err.contains("Claude's checks are still running"), "{err}");
    let after = store.get_card("ws", &c.id).unwrap();
    assert!(is_undecided(&after));
    assert!(Path::new(after.worktree_path.as_deref().unwrap()).is_dir());
    // A comparison under way (a Compare again that raced it) refuses in the
    // card write itself.
    let mut comparing = after.clone();
    comparing.build_both.as_mut().unwrap().compare.as_mut().unwrap().status = "running".into();
    assert!(apply_pick(&mut comparing, LANE_B, None, 1, ArchivedLane::default()).unwrap_err().contains("still comparing"));
}

#[test]
fn a_rekey_that_cannot_happen_ends_the_session_and_offers_resume() {
    let (repo, _config, store, c) = picked_fixture();
    let registry = crate::builder::BuilderRegistry::default();
    let pty = crate::pty::PtyRegistry::default();
    registry.insert_for_test(&lane_key(&c.id, LANE_B), "pty-b", "codex");
    registry.insert_for_test(&c.id, "pty-card", "claude");
    let picked = pick_locked(&store, &registry, &pty, &|_| false, repo.path(), &[], "ws", &c.id, LANE_B, None).unwrap();
    assert_eq!(registry.get_pty(&lane_key(&c.id, LANE_B)), None, "not left with no card");
    let b = picked.builder.unwrap();
    assert_eq!((b.pty_id, b.session_lost), (None, true));
}

#[test]
fn the_worktrees_page_never_deletes_a_build_still_built_by_both_or_a_live_session() {
    let tmp = tempfile::tempdir().unwrap();
    let c = both_card(tmp.path());
    let cards = vec![c.clone()];
    let none = |_: &str| false;
    let why = worktree_delete_refusal(&cards, "card-moxa1234-1-b", none).unwrap();
    assert!(why.contains("Codex's build of “Add dark mode”"), "{why}");
    assert!(worktree_delete_refusal(&cards, "card-moxa1234-1", none).unwrap().contains("Claude's build"));
    assert_eq!(worktree_delete_refusal(&cards, "card-other", none), None);
    // Decided: the card's own checkout, refused only while its Builder works in it.
    let mut picked = c;
    picked.build_both.as_mut().unwrap().outcome = Some(BuildBothOutcome { kind: "picked".into(), ..Default::default() });
    let cards = vec![picked];
    assert_eq!(worktree_delete_refusal(&cards, "card-moxa1234-1", none), None);
    let live = |k: &str| k == "card-moxa1234-1";
    assert!(worktree_delete_refusal(&cards, "card-moxa1234-1", live).unwrap().contains("Close its session first"));
}

#[test]
fn checks_that_never_finished_run_again_on_the_same_snapshot() {
    let v = |status: &str, sha: &str, summary: Option<&str>| LaneVerify {
        status: status.into(),
        sha: sha.into(),
        summary: summary.map(str::to_string),
        at: 1,
    };
    assert!(checks_need_rerun(None, "s", false));
    assert!(checks_need_rerun(Some(&v("interrupted", "s", None)), "s", false));
    assert!(checks_need_rerun(Some(&v("stalled", "s", None)), "s", false));
    assert!(checks_need_rerun(Some(&v("running", "s", None)), "s", false), "a running no job answers");
    assert!(checks_need_rerun(Some(&v("failed", "s", Some("the checks couldn't start: x"))), "s", false));
    assert!(checks_need_rerun(Some(&v("passed", "old", None)), "s", false), "another snapshot's");
    assert!(!checks_need_rerun(Some(&v("passed", "s", None)), "s", false));
    assert!(!checks_need_rerun(Some(&v("failed", "s", Some("script:t failed"))), "s", false));
    assert!(!checks_need_rerun(None, "s", true), "never beside a running one");
}

#[test]
fn nothing_else_runs_or_ships_on_a_card_still_built_by_both() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    // Ship's and land's shared check.
    assert_eq!(crate::builder::require_builder_worktree(&c).unwrap_err(), UNDECIDED_REFUSAL);
    // A card with a swarm or an agent isn't offered it.
    let mut runner = card("");
    runner.swarm_template_id = Some("feature".into());
    // G4: a template that never ran a swarm can't start one, so it is no runner.
    assert_eq!(start_refusal(&runner, |_| None), None);
    runner.linked_swarm_id = Some("swarm-1".into());
    assert!(start_refusal(&runner, |_| None).unwrap().contains("swarm or an agent"));
    // No runner can be attached while undecided; the brief can still change.
    let config = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(config.path().to_path_buf()).unwrap();
    store.save("ws", vec![c.clone()]).unwrap();
    let patch = crate::kanban::CardPatch { swarm_template_id: Some(Some("feature".into())), ..Default::default() };
    assert_eq!(store.patch_card("ws", &c.id, patch, None).unwrap_err(), UNDECIDED_REFUSAL);
    let notes = crate::kanban::CardPatch { notes: Some(Some("more".into())), ..Default::default() };
    assert!(store.patch_card("ws", &c.id, notes, None).is_ok());
    // Decided: the normal rules again.
    c.build_both.as_mut().unwrap().outcome = Some(BuildBothOutcome { kind: "stopped".into(), ..Default::default() });
    assert!(crate::builder::require_builder_worktree(&c).is_ok());
}

/// v1.154.1 round 2 (walk J1): `resumeFailed` is new on a build; a build
/// written before it loads as false, and it round-trips.
#[test]
fn a_build_written_before_resume_failed_loads_without_it() {
    let legacy = card(r#","buildBoth":{"startedAt":5,"lanes":[{"lane":"b","vendor":"codex","worktreePath":"/w/card-b","sessionLost":true,"startedAt":6}]}"#);
    let b = legacy.build_both.as_ref().unwrap().lane("b").unwrap().clone();
    assert!(b.session_lost && !b.resume_failed);
    let mut c = legacy.clone();
    c.build_both.as_mut().unwrap().lane_mut("b").unwrap().resume_failed = true;
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(json["buildBoth"]["lanes"][0]["resumeFailed"], true);
    let back: KanbanCard = serde_json::from_value(json).unwrap();
    assert!(back.build_both.unwrap().lane("b").unwrap().resume_failed);
}

/// v1.154.1 round 3 (walk RW-B): a build with no checks set up is not
/// "passed" in the comparison's prompt, so the Challenger can't say it is.
#[test]
fn no_checks_set_up_is_not_passed_in_the_prompt() {
    let none = verify_words(Some(&LaneVerify {
        status: "passed".into(),
        summary: Some(NO_CHECKS_SUMMARY.into()),
        ..Default::default()
    }));
    assert!(none.contains("no checks are set up") && !none.contains("passed ("), "{none}");
    let root = tempfile::tempdir().unwrap();
    let a = write_lane_files(root.path(), "a", "aaa111", " a | 1 +", "+a", false, none.clone()).unwrap();
    let b = write_lane_files(root.path(), "b", "bbb222", " b | 1 +", "+b", false, none).unwrap();
    let p = compare_prompt("Brief.", "base000", &a, &b);
    assert!(p.contains("Checks (the project's own verify pipeline): none — no checks are set up"), "{p}");
    assert!(!p.contains("pipeline): passed"), "{p}");
}

// ── CL-8: the model of each build, each build's verdict, its diff ────

/// A build written before CL-8 has no chosen model and a comparison no
/// per-build verdicts: both load with the defaults and save as they were.
#[test]
fn a_build_and_a_comparison_from_before_cl8_load_and_save_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws-pre-cl8.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let json = format!(
        r#"{{
        "version": {},
        "cards": [{{
            "id": "c1",
            "workspaceId": "ws-pre-cl8",
            "title": "built by both before CL-8",
            "columnId": "in_progress",
            "createdAt": 1,
            "updatedAt": 5,
            "buildBoth": {{
                "startedAt": 2,
                "lanes": [
                    {{"lane": "a", "vendor": "claude", "worktreePath": "/r/a", "branchName": "x", "bypass": false, "model": "opus", "sessionLost": false, "resumeFailed": false, "startedAt": 3, "done": {{"sha": "aaa", "at": 4}}}},
                    {{"lane": "b", "vendor": "codex", "worktreePath": "/r/b", "branchName": "x-b", "bypass": false, "sessionLost": false, "resumeFailed": false, "startedAt": 3, "done": {{"sha": "bbb", "at": 4}}}}
                ],
                "compare": {{"status": "done", "provider": "codex", "recommended": "a", "reasons": ["A is smaller"], "startedAt": 5, "at": 6}},
                "outcome": {{"kind": "picked", "lane": "a", "vendor": "claude", "at": 7, "archived": []}}
            }}
        }}]
    }}"#,
        crate::kanban::KANBAN_SCHEMA_VERSION
    );
    std::fs::write(&path, json.as_bytes()).unwrap();
    let cards = store.load("ws-pre-cl8").unwrap();
    let bb = cards[0].build_both.clone().unwrap();
    assert!(bb.lanes.iter().all(|l| l.chosen_model.is_none()));
    assert_eq!(bb.lane("a").unwrap().model.as_deref(), Some("opus"));
    let compare = bb.compare.clone().unwrap();
    assert!(compare.lanes.is_empty());
    assert_eq!(compare.reasons, vec!["A is smaller"]);
    assert_eq!(std::fs::read(&path).unwrap(), json.as_bytes(), "not rewritten on load");
    store.save("ws-pre-cl8", cards).unwrap();
    let on_disk = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
    assert!(!on_disk.contains("chosenModel"), "{on_disk}");
    let saved: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
    let compare = &saved["cards"][0]["buildBoth"]["compare"];
    assert!(compare.get("lanes").is_none(), "{compare}");
    assert_eq!(compare["reasons"][0], "A is smaller");
}

#[test]
fn the_models_chosen_at_start_are_kept_on_each_build_and_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    let models: BuildBothModels = serde_json::from_str(
        r#"{"claude":{"model":"  opus ","reasoning":"high"},"codex":{"model":"gpt-5.5","reasoning":" low "}}"#,
    )
    .unwrap();
    choose_models(c.build_both.as_mut().unwrap(), &models);
    let bb = c.build_both.as_ref().unwrap();
    // Trimmed; 1.169.0 (A1): Claude's effort is kept (`--effort`).
    assert_eq!(
        bb.lane(LANE_A).unwrap().chosen_model,
        Some(LaneModel { model: Some("opus".into()), reasoning: Some("high".into()) })
    );
    assert_eq!(
        bb.lane(LANE_B).unwrap().chosen_model,
        Some(LaneModel { model: Some("gpt-5.5".into()), reasoning: Some("low".into()) })
    );
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(json["buildBoth"]["lanes"][1]["chosenModel"]["model"], "gpt-5.5");
    let back: KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(back.build_both, c.build_both);
    // Blank fields are the CLI's default: chosen, with nothing to pass.
    let mut d = both_card(tmp.path());
    choose_models(d.build_both.as_mut().unwrap(), &serde_json::from_str(r#"{"claude":{"model":" "}}"#).unwrap());
    let a = d.build_both.as_ref().unwrap().lane(LANE_A).unwrap().clone();
    assert_eq!(a.chosen_model, Some(LaneModel::default()));
    assert!(lane_model(&a, || panic!("a chosen model never reads the row")).is_empty());
    let json = serde_json::to_string(&d).unwrap();
    assert!(json.contains(r#""chosenModel":{}"#), "{json}");
}

/// The chosen model is what the build's spawn passes — new, Resume and
/// Start fresh alike; a build from before CL-8 reads the Builder row.
#[test]
fn a_builds_chosen_model_is_used_on_spawn_and_resume() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    choose_models(
        c.build_both.as_mut().unwrap(),
        &serde_json::from_str(r#"{"claude":{"model":"sonnet"},"codex":{"model":"gpt-6-astra","reasoning":"high"}}"#).unwrap(),
    );
    let row = || crate::settings::ModelChoice { model: Some("row-model".into()), reasoning: None };
    let a = c.build_both.as_ref().unwrap().lane(LANE_A).unwrap().clone();
    let b = c.build_both.as_ref().unwrap().lane(LANE_B).unwrap().clone();
    let ma = lane_model(&a, row);
    let mb = lane_model(&b, row);
    assert_eq!(ma.label().as_deref(), Some("sonnet"));
    assert_eq!(mb.label().as_deref(), Some("gpt-6-astra high"));
    let fresh = crate::builder::builder_args("claude", false, false, None, Some("brief"), None, &ma).unwrap();
    let resumed = crate::builder::builder_args("claude", false, true, None, None, None, &ma).unwrap();
    for args in [&fresh, &resumed] {
        let at = args.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(args[at + 1], "sonnet");
        assert!(!args.iter().any(|a| a == "row-model"));
    }
    assert!(resumed.iter().any(|a| a == "--continue"));
    let codex_resumed = crate::builder::builder_args("codex", false, true, Some("sess-1"), None, None, &mb).unwrap();
    let at = codex_resumed.iter().position(|a| a == "-m").expect("-m");
    assert_eq!(codex_resumed[at + 1], "gpt-6-astra");
    assert!(codex_resumed.iter().any(|a| a.contains("high")), "{codex_resumed:?}");
    // Before CL-8: no choice on the lane, the row decides at each spawn.
    let old = both_card(tmp.path()).build_both.unwrap().lane(LANE_A).unwrap().clone();
    assert_eq!(lane_model(&old, row).model.as_deref(), Some("row-model"));
}

#[test]
fn the_prompt_asks_for_each_builds_summary_and_findings_and_still_names_no_vendor() {
    let root = tempfile::tempdir().unwrap();
    let a = write_lane_files(root.path(), "a", "aaa111", " a | 1 +", "+a", false, "passed.".into()).unwrap();
    let b = write_lane_files(root.path(), "b", "bbb222", " b | 1 +", "+b", false, "passed.".into()).unwrap();
    let p = compare_prompt("Brief.", "base000", &a, &b);
    for needle in ["SUMMARY A:", "FINDINGS A:", "SUMMARY B:", "FINDINGS B:", "`- none`", "REASONS:"] {
        assert!(p.contains(needle), "missing {needle:?}");
    }
    assert!(p.find("REASONS:").unwrap() < p.find("SUMMARY A:").unwrap());
    assert!(!p.contains("Claude") && !p.contains("Codex"), "the vendors are not named");
}

#[test]
fn each_builds_summary_and_findings_are_read_and_missing_sections_are_tolerated() {
    let full = "Thoughts.\n\nRECOMMENDATION: B\nREASONS:\n- B persists the choice\n- A misses the system theme\n\n\
SUMMARY A: Adds a toggle; the choice is lost on restart.\nFINDINGS A:\n- settings.ts never saves the theme\n- no test for the toggle\n\
SUMMARY B: Adds a toggle and saves it.\nFINDINGS B:\n- none\n";
    let parsed = parse_compare(full).unwrap();
    assert_eq!(parsed.recommended.as_deref(), Some("b"));
    assert_eq!(parsed.reasons, vec!["B persists the choice", "A misses the system theme"], "the reasons stop at the summaries");
    assert_eq!(
        parsed.lanes,
        vec![
            LaneVerdict {
                lane: "a".into(),
                summary: Some("Adds a toggle; the choice is lost on restart.".into()),
                findings: Some(vec!["settings.ts never saves the theme".into(), "no test for the toggle".into()]),
            },
            LaneVerdict { lane: "b".into(), summary: Some("Adds a toggle and saves it.".into()), findings: Some(vec![]) },
        ]
    );
    // Without the new sections: as before, no per-build verdicts.
    let old = parse_compare("RECOMMENDATION: A\nREASONS:\n- smaller").unwrap();
    assert_eq!((old.reasons.clone(), old.lanes.clone()), (vec!["smaller".to_string()], vec![]));
    // Markdown, "Build", a summary on the next line, sections before the
    // recommendation, a build with only one of the two.
    let loose = "**Summary for Build B:**\nIt rewrites the theme hook.\n\nmore text\n**Findings B:** None.\n\n\
**Recommendation:** Build A\n**Reasons:**\n1. Smaller\n## Findings A\n- not a head (no colon)\n";
    let parsed = parse_compare(loose).unwrap();
    assert_eq!(parsed.recommended.as_deref(), Some("a"));
    assert_eq!(parsed.reasons, vec!["Smaller"]);
    assert_eq!(
        parsed.lanes,
        vec![LaneVerdict { lane: "b".into(), summary: Some("It rewrites the theme hook.".into()), findings: Some(vec![]) }]
    );
    // Malformed: an unknown build, an empty summary, findings with no
    // items — nothing is invented, the recommendation still reads.
    let bad = "RECOMMENDATION: A\nREASONS:\n- x\nSUMMARY C: what?\nSUMMARY A:\n\nFINDINGS B:\n";
    let parsed = parse_compare(bad).unwrap();
    assert_eq!(parsed.reasons, vec!["x"]);
    assert_eq!(parsed.lanes, vec![LaneVerdict { lane: "b".into(), summary: None, findings: Some(vec![]) }]);
    // The last section of a build wins; findings are capped.
    let many: String = (0..20).map(|i| format!("- finding {i}\n")).collect();
    let twice = parse_compare(&format!("SUMMARY A: draft\nRECOMMENDATION: A\nREASONS:\n- x\nSUMMARY A: final\nFINDINGS A:\n{many}")).unwrap();
    assert_eq!(twice.lanes[0].summary.as_deref(), Some("final"));
    assert_eq!(twice.lanes[0].findings.as_ref().unwrap().len(), 8);
    // No recommendation: still a failed read, whatever else is there.
    assert_eq!(parse_compare("SUMMARY A: fine\nFINDINGS A:\n- none"), None);
}

#[test]
fn the_comparison_keeps_each_builds_verdict() {
    let c = compare_from_answer(
        "RECOMMENDATION: A\nREASONS:\n- x\nSUMMARY A: good\nFINDINGS A:\n- none\nSUMMARY B: weaker\nFINDINGS B:\n- breaks the build",
        "codex",
        Some("a1".into()),
        Some("b1".into()),
        1,
        2,
    );
    assert_eq!(c.status, "done");
    assert_eq!(c.lanes.len(), 2);
    assert_eq!(c.lanes[1].findings.as_deref(), Some(&["breaks the build".to_string()][..]));
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(json["lanes"][0]["summary"], "good");
    assert_eq!(json["lanes"][0]["findings"], serde_json::json!([]));
    let back: BuildCompare = serde_json::from_value(json).unwrap();
    assert_eq!(back, c);
}

/// The lane diff reads a build's commits from the card's base, in the
/// workspace repository, keyed to its Build done.
#[test]
fn a_builds_diff_is_read_from_the_cards_base_to_its_build_done() {
    let repo = git_repo();
    let r = repo.path();
    let git = |args: &[&str]| crate::git::capture(r, args).unwrap().trim().to_string();
    std::fs::write(r.join("keep.txt"), "one\ntwo\nthree\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "base"]);
    let base = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "-q", "-b", "lane-a"]);
    std::fs::write(r.join("keep.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    std::fs::write(r.join("new.ts"), "export const x = 1;\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "a"]);
    let sha_a = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "-q", "main"]);
    // Main moves on after the base: it is not in the build's diff.
    std::fs::write(r.join("later.txt"), "x\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "later"]);

    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    // No Build done yet: nothing to read.
    assert!(lane_diff_of(&c, r, LANE_A).unwrap_err().contains("no Finish and check"));
    finish(&mut c, LANE_A, &sha_a);
    c.worktree_base = Some(crate::worktrees::WorktreeBase { commit: base.clone(), ref_name: "main".into(), source: crate::worktrees::BaseSource::Origin, note: None, origin_slug: None, origin_url: None, merged_target: None });
    let d = lane_diff_of(&c, r, LANE_A).unwrap();
    assert_eq!((d.lane.as_str(), d.sha.as_str(), d.base.as_str()), ("a", sha_a.as_str(), base.as_str()));
    let paths: Vec<&str> = d.files.iter().map(|f| f.file.path.as_str()).collect();
    assert_eq!(paths, vec!["keep.txt", "new.ts"]);
    assert_eq!((d.files[0].added, d.files[0].removed), (2, 1));
    assert_eq!((d.files[1].added, d.files[1].removed), (1, 0));
    assert_eq!((d.added, d.removed), (3, 1));
    let json = serde_json::to_value(&d).unwrap();
    assert_eq!(json["files"][1]["path"], "new.ts");
    assert_eq!(json["files"][1]["kind"], "added");
    assert_eq!(json["files"][0]["added"], 2);
    assert!(lane_diff_of(&c, r, "z").is_err());
    // An older card with no recorded base and one build done can't say.
    c.worktree_base = None;
    assert!(lane_diff_of(&c, r, LANE_A).unwrap_err().contains("no recorded base"));
}

// ── CL-8 round 2 ─────────────────────────────────────────────────────

/// The picked build's chosen model stays the card's: the Builder's Resume
/// and Start fresh run on it, not on the workspace's row.
#[test]
fn the_picked_builds_chosen_model_is_the_cards_builders_after_the_pick() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    choose_models(
        c.build_both.as_mut().unwrap(),
        &serde_json::from_str(r#"{"claude":{"model":"sonnet"},"codex":{"model":"gpt-6-astra","reasoning":"high"}}"#).unwrap(),
    );
    finish(&mut c, LANE_A, "aaa");
    finish(&mut c, LANE_B, "bbb");
    let archived = ArchivedLane { lane: "a".into(), vendor: "claude".into(), branch_name: "x".into(), ..Default::default() };
    apply_pick(&mut c, LANE_B, None, 50, archived).unwrap();
    let b = c.builder.clone().unwrap();
    assert_eq!(b.chosen_model, Some(LaneModel { model: Some("gpt-6-astra".into()), reasoning: Some("high".into()) }));
    let row = || crate::settings::ModelChoice { model: Some("row-model".into()), reasoning: None };
    let model = crate::builder::builder_model(b.chosen_model.as_ref(), &b.vendor, row);
    let resumed = crate::builder::builder_args("codex", false, true, Some("sess"), None, None, &model).unwrap();
    let at = resumed.iter().position(|a| a == "-m").unwrap();
    assert_eq!(resumed[at + 1], "gpt-6-astra");
    assert!(!resumed.iter().any(|a| a == "row-model"));
    // Round-trips on the card; a card with no choice reads the row.
    let back: KanbanCard = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
    assert_eq!(back.builder.unwrap().chosen_model, b.chosen_model);
    assert_eq!(crate::builder::builder_model(None, "codex", row).model.as_deref(), Some("row-model"));
}

/// A Builder written before CL-8 round 2 has no chosen model and saves
/// without one.
#[test]
fn a_builder_from_before_the_chosen_model_loads_and_saves_without_it() {
    let old = card(r#","builder":{"vendor":"codex","bypass":false,"model":"gpt-5.5","startedAt":3,"snapshots":[]}"#);
    let b = old.builder.as_ref().unwrap();
    assert_eq!(b.chosen_model, None);
    let json = serde_json::to_string(&old).unwrap();
    assert!(!json.contains("chosenModel"), "{json}");
}

/// The final answer's sections win over a draft earlier in the text.
#[test]
fn the_sections_after_the_last_recommendation_win() {
    let answer = "Draft:\nSUMMARY A: draft a\nFINDINGS B:\n- draft finding\n\nRECOMMENDATION: A\nREASONS:\n- x\nSUMMARY A: final a\n";
    let parsed = parse_compare(answer).unwrap();
    assert_eq!(parsed.lanes, vec![LaneVerdict { lane: "a".into(), summary: Some("final a".into()), findings: None }]);
}

/// A diff past the cap keeps every file and its counts; the lines stop.
#[test]
fn a_long_lane_diff_is_cut_and_says_so() {
    let hunk = |body: &str| crate::git::DiffHunk {
        header: "@@ -1 +1 @@".into(),
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 1,
        body: body.into(),
    };
    let file = |path: &str, body: &str| crate::git::FileDiff {
        path: path.into(),
        old_path: None,
        kind: crate::git::DiffChangeKind::Modified,
        hunks: vec![hunk(body)],
    };
    let files = vec![file("a", &"+x\n".repeat(10)), file("b", &"+y\n".repeat(10)), file("c", "+z\n")];
    // Room for "a" (41 bytes) and "c" (14), not "b" (41) as well.
    let (kept, cuts) = cap_hunks(files.clone(), 60);
    assert_eq!(cuts, vec![false, true, false], "only the file that passes the budget is cut");
    assert_eq!(kept.len(), 3);
    assert_eq!(kept[0].hunks.len(), 1);
    assert!(kept[1].hunks.is_empty());
    assert_eq!(kept[2].hunks.len(), 1, "a later small file keeps its lines");
    let (all, cuts) = cap_hunks(files, 10_000);
    assert!(cuts.iter().all(|c| !c) && all.iter().all(|f| f.hunks.len() == 1));
    // On the wire: a cut file says so, the others carry no flag.
    let one = LaneDiffFile { file: kept[1].clone(), added: 10, removed: 0, cut: true };
    assert_eq!(serde_json::to_value(&one).unwrap()["cut"], true);
    let other = LaneDiffFile { file: kept[0].clone(), added: 10, removed: 0, cut: false };
    assert!(serde_json::to_value(&other).unwrap().get("cut").is_none());
}

/// Round 3: Start fresh with the other vendor than the picked build drops
/// the chosen model and reads the workspace's row; the same vendor keeps it.
#[test]
fn start_fresh_with_the_other_vendor_drops_the_chosen_model() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    choose_models(
        c.build_both.as_mut().unwrap(),
        &serde_json::from_str(r#"{"claude":{"model":"sonnet"},"codex":{"model":"gpt-6-astra"}}"#).unwrap(),
    );
    finish(&mut c, LANE_A, "aaa");
    finish(&mut c, LANE_B, "bbb");
    let archived = ArchivedLane { lane: "a".into(), vendor: "claude".into(), branch_name: "x".into(), ..Default::default() };
    apply_pick(&mut c, LANE_B, None, 50, archived).unwrap();
    let row = || crate::settings::ModelChoice { model: Some("row-model".into()), reasoning: None };
    let other = crate::builder::chosen_model_for(c.builder.as_ref(), "claude");
    assert_eq!(other, None);
    assert_eq!(crate::builder::builder_model(other.as_ref(), "claude", row).model.as_deref(), Some("row-model"));
    let same = crate::builder::chosen_model_for(c.builder.as_ref(), "codex");
    assert_eq!(crate::builder::builder_model(same.as_ref(), "codex", row).model.as_deref(), Some("gpt-6-astra"));
    assert_eq!(crate::builder::chosen_model_for(None, "codex"), None);
}

/// N16: a legacy card's Codex build is set aside from the folder its lane
/// records, never a stray `.plyloft-worktrees/<id>-b` of the same name.
#[test]
fn a_legacy_codex_build_is_set_aside_from_its_recorded_folder() {
    let repo = git_repo();
    let ws = repo.path();
    let c = both_card(ws);
    let legacy_b = ws.join(".atelier-worktrees").join(variant_dir(&c.id));
    let stray = ws.join(".plyloft-worktrees").join(variant_dir(&c.id));
    std::fs::create_dir_all(&stray).unwrap();
    std::fs::write(stray.join("note.txt"), "not the lane's").unwrap();
    assert_eq!(crate::worktrees::worktree_path_for_card(ws, &variant_dir(&c.id)), stray, "by name, the stray wins");

    let staged = prune_leftover_variant(ws, &c, &[]).expect("set aside");
    assert_eq!(staged.parent().unwrap(), ws.join(".atelier-worktrees").join(".trash"));
    assert!(!legacy_b.exists());
    assert!(stray.join("note.txt").is_file(), "the stray is untouched");
}

// ── 1.171.0 (D1, Challenger 1): the card's permissions choice ─────────

#[test]
fn both_builds_run_in_the_cards_choice_and_the_pick_keeps_it() {
    use crate::settings::BuilderPermissions;
    let tmp = tempfile::tempdir().unwrap();
    let mut c = both_card(tmp.path());
    // "Asks before every change": no bypass on either build.
    set_permissions(c.build_both.as_mut().unwrap(), BuilderPermissions::Asks);
    for lane in &c.build_both.as_ref().unwrap().lanes {
        assert_eq!(lane.permissions, Some(BuilderPermissions::Asks));
        assert!(!lane.bypass, "{}", lane.lane);
        let args = crate::builder::builder_args_in_mode(
            &lane.vendor,
            lane.bypass,
            lane.permissions.map(BuilderPermissions::mode_str),
            false,
            None,
            Some("go"),
            None,
            &crate::settings::ModelChoice::default(),
        )
        .unwrap();
        let want: &[&str] = if lane.vendor == "codex" {
            &["--sandbox", "read-only", "-a", "on-request", "go"]
        } else {
            &["go"]
        };
        assert_eq!(args, want);
    }
    set_permissions(c.build_both.as_mut().unwrap(), BuilderPermissions::NeverAsks);
    assert!(c.build_both.as_ref().unwrap().lanes.iter().all(|l| l.bypass));
    set_permissions(c.build_both.as_mut().unwrap(), BuilderPermissions::EditsCopy);
    finish(&mut c, LANE_A, "aaa");
    finish(&mut c, LANE_B, "bbb");
    let archived = archived_lane(c.build_both.as_ref().unwrap().lane("a").unwrap(), Ok(None));
    apply_pick(&mut c, "b", None, 99, archived).unwrap();
    let b = c.builder.as_ref().unwrap();
    assert_eq!(b.permissions, Some(BuilderPermissions::EditsCopy), "Resume keeps the build's choice");
    assert!(!b.bypass);
}

/// Tier 2: a build from before D1 loads with no choice (its `bypass`
/// decides, as before) and saves without the key; a saved choice
/// round-trips; a newer value reads as none.
#[test]
fn a_build_from_before_permissions_loads_unchanged() {
    use crate::settings::BuilderPermissions;
    let old = card(
        r#","buildBoth":{"startedAt":1,"lanes":[{"lane":"a","vendor":"claude","worktreePath":"/w/a","branchName":"x","bypass":true}]}"#,
    );
    let lane = &old.build_both.as_ref().unwrap().lanes[0];
    assert_eq!(lane.permissions, None);
    assert!(lane.bypass);
    let out = serde_json::to_value(&old).unwrap();
    assert!(out["buildBoth"]["lanes"][0].get("permissions").is_none(), "{out}");
    let mut saved = old.clone();
    saved.build_both.as_mut().unwrap().lanes[0].permissions = Some(BuilderPermissions::Asks);
    let back: KanbanCard = serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
    assert_eq!(back.build_both.unwrap().lanes[0].permissions, Some(BuilderPermissions::Asks));
    let newer = card(
        r#","buildBoth":{"startedAt":1,"lanes":[{"lane":"a","vendor":"claude","worktreePath":"/w/a","branchName":"x","bypass":false,"permissions":"askLater"}]}"#,
    );
    assert_eq!(newer.build_both.unwrap().lanes[0].permissions, None);
}
