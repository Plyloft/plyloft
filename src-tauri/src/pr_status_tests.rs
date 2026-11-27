//! SL-1 tests. The `sandbox_*` fixtures are real `gh pr view --json
//! <PR_VIEW_FIELDS>` answers captured on 2026-09-28 from a throwaway PR in the
//! private sandbox `test-owner/plyloft-ci-sandbox` (a push with FAIL_CI:
//! pending, then failing; a push without it: pending, then passing; then
//! closed). `cli_*` are real answers from public PRs of cli/cli (a merged one;
//! a closed one whose reviewer asked for changes), trimmed to three checks.
//! A conflict and an open changes-requested PR couldn't be made in the
//! sandbox without writing to its main branch, so those are derived here from
//! the real answers, changing only the fields named in each test.

use super::*;
use crate::kanban::{KanbanColumnId, LastRunStatus};

const PENDING: &str = include_str!("pr_status_fixtures/sandbox_pending.json");
const FAILING: &str = include_str!("pr_status_fixtures/sandbox_failing.json");
const PASSING: &str = include_str!("pr_status_fixtures/sandbox_passing.json");
const CLOSED: &str = include_str!("pr_status_fixtures/sandbox_closed.json");
const MERGED: &str = include_str!("pr_status_fixtures/cli_merged.json");
const CHANGES: &str = include_str!("pr_status_fixtures/cli_closed_changes_requested.json");
/// Real (sandbox PR #2, 2026-09-28): both runs of `test` cancelled, then the
/// pull_request run re-run green; the push run stays cancelled.
const CANCELLED: &str = include_str!("pr_status_fixtures/sandbox_cancelled.json");
const RERUN_GREEN: &str = include_str!("pr_status_fixtures/sandbox_cancelled_then_rerun_green.json");

const SANDBOX_URL: &str = "https://github.com/test-owner/plyloft-ci-sandbox/pull/1";

fn derived(json: &str, edit: impl FnOnce(&mut serde_json::Value)) -> String {
    let mut v: serde_json::Value = serde_json::from_str(json).unwrap();
    edit(&mut v);
    v.to_string()
}

fn shipped_card(url: &str) -> KanbanCard {
    let mut card = KanbanCard::new("c1".into(), "ws".into(), "Add sum".into(), None, KanbanColumnId::InProgress);
    card.last_run_status = Some(LastRunStatus::Success);
    card.pr_url = Some(url.to_string());
    card.review_status = Some(ReviewStatus::Merged);
    card.pr = pr_number_from_url(url).map(|n| PrStatus::opened(n, 100));
    card.worktree_path = Some("/ws/.atelier-worktrees/c1".into());
    card.branch_name = Some("atelier/card-c1-add-sum".into());
    card
}

// ── Parsing real answers ────────────────────────────────────────────────

#[test]
fn pending_checks_parse_as_pending() {
    let pr = parse_pr_view(PENDING).unwrap();
    assert_eq!(pr.number, 1);
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.checks, PrChecks::Pending);
    // The push and pull_request runs of test/test: one check's state, and
    // counted as GitHub's page lists them, two runs (1.171.0 B3, walk 6b).
    assert_eq!((pr.checks_total, pr.checks_passed, pr.checks_pending), (2, 0, 2));
    assert!(pr.failing_checks.is_empty());
    assert_eq!(pr.mergeable, PrMergeable::Mergeable);
    assert_eq!(pr.merge_state.as_deref(), Some("blocked"));
    assert_eq!(pr.review_decision, PrReviewDecision::None);
    assert_eq!(pr.head_sha.as_deref(), Some("788cb9c95d076fcb7960fa0ddd7c6679dd051b4c"));
    assert_eq!(pr.merged_at, None, "gh's zero time is no time");
}

#[test]
fn failing_checks_parse_with_their_name_once_and_a_link() {
    let pr = parse_pr_view(FAILING).unwrap();
    assert_eq!(pr.checks, PrChecks::Failing);
    // The push and the pull_request runs of test/test are one failing
    // check, and two runs on GitHub's page (walk 6b).
    assert_eq!(pr.checks_total, 2);
    assert_eq!(pr.failing_checks.len(), 1);
    assert_eq!(pr.failing_checks[0].workflow.as_deref(), Some("test"));
    assert_eq!(pr.failing_checks[0].name, "test");
    assert!(pr.failing_checks[0]
        .url
        .as_deref()
        .unwrap()
        .starts_with("https://github.com/test-owner/plyloft-ci-sandbox/actions/runs/"));
}

#[test]
fn passing_checks_parse_as_passing() {
    let pr = parse_pr_view(PASSING).unwrap();
    assert_eq!(pr.checks, PrChecks::Passing);
    assert_eq!((pr.checks_total, pr.checks_passed, pr.checks_pending), (2, 2, 0));
    assert_eq!(pr.merge_state.as_deref(), Some("clean"));
}

#[test]
fn closed_and_merged_parse_with_their_times() {
    let closed = parse_pr_view(CLOSED).unwrap();
    assert_eq!(closed.state, PrState::Closed);
    assert!(closed.closed_at.is_some());
    assert_eq!(closed.merge_commit, None);

    let merged = parse_pr_view(MERGED).unwrap();
    assert_eq!(merged.state, PrState::Merged);
    assert!(merged.merged_at.is_some());
    assert!(merged.merge_commit.as_deref().is_some_and(|s| s.len() == 40));
    assert_eq!(merged.mergeable, PrMergeable::Unknown);
    assert_eq!(merged.review_decision, PrReviewDecision::Approved);
}

#[test]
fn changes_requested_keeps_the_latest_request_and_its_text() {
    let pr = parse_pr_view(CHANGES).unwrap();
    assert_eq!(pr.review_decision, PrReviewDecision::ChangesRequested);
    let request = pr.changes_requested.unwrap();
    assert_eq!(request.author.as_deref(), Some("williammartin"));
    assert!(request.body.starts_with("Please no, I'm trying to iterate"), "{}", request.body);
    assert!(request.submitted_at.is_some());
}

#[test]
fn a_decision_without_a_changes_review_has_no_text_and_text_is_capped() {
    // Real: cli/cli answers CHANGES_REQUESTED with only COMMENTED reviews
    // in `latestReviews` when the request is older.
    let only_comments = derived(CHANGES, |v| {
        v["latestReviews"].as_array_mut().unwrap().retain(|r| r["state"] != "CHANGES_REQUESTED");
    });
    let pr = parse_pr_view(&only_comments).unwrap();
    assert_eq!(pr.review_decision, PrReviewDecision::ChangesRequested);
    assert_eq!(pr.changes_requested, None);

    let long = derived(CHANGES, |v| {
        for r in v["latestReviews"].as_array_mut().unwrap() {
            r["body"] = serde_json::Value::String("x".repeat(5000));
        }
    });
    assert_eq!(parse_pr_view(&long).unwrap().changes_requested.unwrap().body.len(), 2000);
}

/// M1: each check once, its newest run — as `gh pr checks` shows it.
#[test]
fn a_check_re_run_green_is_green() {
    let cancelled = parse_pr_view(CANCELLED).unwrap();
    assert_eq!(cancelled.checks, PrChecks::Failing, "cancelled counts as failed");
    // 1.171.0 B3 (walk 6b): counted as GitHub's page lists them — the push
    // and the pull_request run of test/test are two; the state is one check's.
    assert_eq!(cancelled.checks_total, 2, "push and pull_request runs of test/test: two runs");

    let green = parse_pr_view(RERUN_GREEN).unwrap();
    let raw: serde_json::Value = serde_json::from_str(RERUN_GREEN).unwrap();
    assert_eq!(raw["statusCheckRollup"].as_array().unwrap().len(), 2, "GitHub lists both runs");
    assert_eq!(green.checks, PrChecks::Passing);
    assert_eq!((green.checks_total, green.checks_passed, green.checks_pending), (2, 1, 0));
    assert!(green.failing_checks.is_empty());

    // An older run listed after the newer one doesn't win either.
    let reversed = derived(RERUN_GREEN, |v| {
        v["statusCheckRollup"].as_array_mut().unwrap().reverse();
    });
    assert_eq!(parse_pr_view(&reversed).unwrap().checks, PrChecks::Passing);
    // Commit statuses are keyed by context, newest first too.
    let statuses = derived(PASSING, |v| {
        let rollup = v["statusCheckRollup"].as_array_mut().unwrap();
        rollup.push(serde_json::json!({"__typename": "StatusContext", "context": "ci/x",
            "state": "FAILURE", "startedAt": "2026-09-28T10:00:00Z"}));
        rollup.push(serde_json::json!({"__typename": "StatusContext", "context": "ci/x",
            "state": "SUCCESS", "startedAt": "2026-09-28T11:00:00Z"}));
    });
    assert_eq!(parse_pr_view(&statuses).unwrap().checks, PrChecks::Passing);
}

/// 1.171.0 B3 (walk 6b): "checks 0 of 1" while GitHub's page listed two
/// "test" runs — one for the push, one for the pull request. The count is
/// the page's (one of two done); the state is still the newest run's.
#[test]
fn checks_are_counted_as_github_lists_their_runs() {
    let one_running = derived(RERUN_GREEN, |v| {
        for c in v["statusCheckRollup"].as_array_mut().unwrap() {
            if c["conclusion"] == "CANCELLED" {
                c["conclusion"] = "SUCCESS".into();
            } else {
                c["status"] = "IN_PROGRESS".into();
                c["conclusion"] = "".into();
            }
        }
    });
    for order in [false, true] {
        let json = derived(&one_running, |v| {
            if order {
                v["statusCheckRollup"].as_array_mut().unwrap().reverse();
            }
        });
        let pr = parse_pr_view(&json).unwrap();
        assert_eq!(pr.checks, PrChecks::Pending, "order reversed: {order}");
        assert_eq!((pr.checks_total, pr.checks_passed, pr.checks_pending), (2, 1, 1), "order reversed: {order}");
    }
    // A re-run attempt of the same run is still that run, once.
    let rerun = derived(FAILING, |v| {
        let rollup = v["statusCheckRollup"].as_array_mut().unwrap();
        rollup.truncate(1);
        let mut again = rollup[0].clone();
        again["conclusion"] = "SUCCESS".into();
        again["startedAt"] = "2099-01-01T00:00:00Z".into();
        rollup.push(again);
    });
    let pr = parse_pr_view(&rerun).unwrap();
    assert_eq!((pr.checks, pr.checks_total, pr.checks_passed), (PrChecks::Passing, 1, 1));
}

/// Round 2, minor 1: a real failure in one run is not hidden by a newer
/// green sibling in another run (derived from the real PR #2 answer: its
/// cancelled push run turned into a failure).
#[test]
fn a_failure_in_one_run_is_not_hidden_by_a_green_run_of_another() {
    let failed_push = derived(RERUN_GREEN, |v| {
        for c in v["statusCheckRollup"].as_array_mut().unwrap() {
            if c["conclusion"] == "CANCELLED" {
                c["conclusion"] = "FAILURE".into();
            }
        }
    });
    let raw: serde_json::Value = serde_json::from_str(&failed_push).unwrap();
    let runs: std::collections::HashSet<_> = raw["statusCheckRollup"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| run_id_of(c["detailsUrl"].as_str()))
        .collect();
    assert_eq!(runs.len(), 2, "two runs");
    for order in [false, true] {
        let json = derived(&failed_push, |v| {
            if order {
                v["statusCheckRollup"].as_array_mut().unwrap().reverse();
            }
        });
        let pr = parse_pr_view(&json).unwrap();
        assert_eq!(pr.checks, PrChecks::Failing, "order reversed: {order}");
        assert!(pr.failing_checks[0].url.as_deref().unwrap().contains("36480669638"), "the failed run's job");
    }
    // Cancelled (the real answer) still gives way.
    assert_eq!(parse_pr_view(RERUN_GREEN).unwrap().checks, PrChecks::Passing);
}

/// Round 2, minor 3: a re-run queued with no start yet is the newest attempt
/// of its run — pending, not the old finished failure.
#[test]
fn a_queued_re_run_without_a_start_is_pending_not_the_old_failure() {
    let rerun = derived(FAILING, |v| {
        let rollup = v["statusCheckRollup"].as_array_mut().unwrap();
        rollup.truncate(1);
        let mut queued = rollup[0].clone();
        queued["status"] = "QUEUED".into();
        queued["conclusion"] = "".into();
        queued["completedAt"] = "0001-01-01T00:00:00Z".into();
        queued.as_object_mut().unwrap().remove("startedAt");
        rollup.push(queued.clone());
        // Listed first or last, the queued attempt wins.
        let mut first = vec![queued];
        first.push(rollup[0].clone());
        v["statusCheckRollupReversed"] = serde_json::Value::Array(first);
    });
    let pr = parse_pr_view(&rerun).unwrap();
    assert_eq!(pr.checks, PrChecks::Pending);
    let reversed = derived(&rerun, |v| {
        v["statusCheckRollup"] = v["statusCheckRollupReversed"].take();
    });
    assert_eq!(parse_pr_view(&reversed).unwrap().checks, PrChecks::Pending);
}

/// m6: failing checks are keyed by (workflow, name), each with its job link.
#[test]
fn failing_checks_keep_their_workflow_and_each_jobs_link() {
    let two = derived(FAILING, |v| {
        let rollup = v["statusCheckRollup"].as_array_mut().unwrap();
        rollup[1]["workflowName"] = "lint".into();
    });
    let pr = parse_pr_view(&two).unwrap();
    assert_eq!(pr.failing_checks.len(), 2);
    let labels: Vec<String> = pr.failing_checks.iter().map(PrCheck::label).collect();
    assert!(labels.contains(&"test".to_string()) && labels.contains(&"lint / test".to_string()), "{labels:?}");
    let urls: std::collections::HashSet<_> = pr.failing_checks.iter().map(|c| c.url.clone()).collect();
    assert_eq!(urls.len(), 2, "each job's own page");
}

/// M2: without branch protection GitHub leaves `reviewDecision` empty; a
/// reviewer's latest review asking for changes still counts.
#[test]
fn changes_requested_without_a_review_decision_comes_from_the_reviews() {
    let open = derived(CHANGES, |v| {
        v["state"] = "OPEN".into();
        v["reviewDecision"] = "".into();
    });
    let pr = parse_pr_view(&open).unwrap();
    assert_eq!(pr.review_decision, PrReviewDecision::ChangesRequested);
    assert!(pr.changes_requested.unwrap().body.starts_with("Please no"));
    // Only comments: no request.
    let comments = derived(&open, |v| {
        v["latestReviews"].as_array_mut().unwrap().retain(|r| r["state"] != "CHANGES_REQUESTED");
    });
    assert_eq!(parse_pr_view(&comments).unwrap().review_decision, PrReviewDecision::None);
}

#[test]
fn a_conflict_parses_from_mergeable_conflicting() {
    let conflict = derived(PASSING, |v| {
        v["mergeable"] = "CONFLICTING".into();
        v["mergeStateStatus"] = "DIRTY".into();
    });
    let pr = parse_pr_view(&conflict).unwrap();
    assert_eq!(pr.mergeable, PrMergeable::Conflicting);
    assert_eq!(pr.merge_state.as_deref(), Some("dirty"));
}

#[test]
fn commit_statuses_count_beside_check_runs() {
    let with_status = derived(PASSING, |v| {
        v["statusCheckRollup"].as_array_mut().unwrap().push(serde_json::json!({
            "__typename": "StatusContext",
            "context": "ci/legacy",
            "state": "ERROR",
            "targetUrl": "https://ci.example/1",
        }));
    });
    let pr = parse_pr_view(&with_status).unwrap();
    assert_eq!(pr.checks, PrChecks::Failing);
    assert_eq!(pr.failing_checks[0].name, "ci/legacy");
    assert_eq!(pr.failing_checks[0].url.as_deref(), Some("https://ci.example/1"));
}

#[test]
fn no_checks_and_bad_answers() {
    let none = derived(PASSING, |v| v["statusCheckRollup"] = serde_json::json!([]));
    assert_eq!(parse_pr_view(&none).unwrap().checks, PrChecks::None);
    assert!(parse_pr_view("not json").is_err());
    assert!(parse_pr_view("{}").is_err(), "no number");
}

#[test]
fn pr_numbers_come_from_the_url() {
    assert_eq!(pr_number_from_url(SANDBOX_URL), Some(1));
    assert_eq!(pr_number_from_url("https://github.com/o/r/pull/29/"), Some(29));
    assert_eq!(pr_number_from_url("https://github.com/o/r/pull/29#issuecomment-1"), Some(29));
    assert_eq!(pr_number_from_url("https://github.com/o/r/issues/29"), None);
}

// ── Events ──────────────────────────────────────────────────────────────

#[test]
fn each_event_is_said_once() {
    let opened = PrStatus::opened(1, 0);
    let pending = parse_pr_view(PENDING).unwrap();
    let failing = parse_pr_view(FAILING).unwrap();
    assert_eq!(pr_events(&opened, &pending), vec![]);
    assert_eq!(pr_events(&pending, &failing), vec![PrEvent::ChecksFailed]);
    assert_eq!(pr_events(&failing, &failing), vec![], "same head, still failing");
    // A new push that fails again is a new failure.
    let failing_again = derived(FAILING, |v| v["headRefOid"] = "abc".into());
    assert_eq!(
        pr_events(&failing, &parse_pr_view(&failing_again).unwrap()),
        vec![PrEvent::ChecksFailed]
    );

    let open_changes = parse_pr_view(&derived(CHANGES, |v| v["state"] = "OPEN".into())).unwrap();
    assert_eq!(pr_events(&opened, &open_changes), vec![PrEvent::ChangesRequested]);
    assert_eq!(pr_events(&open_changes, &open_changes), vec![]);

    let conflict = parse_pr_view(&derived(PASSING, |v| v["mergeable"] = "CONFLICTING".into())).unwrap();
    assert_eq!(pr_events(&pending, &conflict), vec![PrEvent::Conflict]);
    assert_eq!(pr_events(&conflict, &conflict), vec![]);

    assert_eq!(pr_events(&pending, &parse_pr_view(CLOSED).unwrap()), vec![PrEvent::Closed]);
    let merged = parse_pr_view(MERGED).unwrap();
    assert_eq!(pr_events(&opened, &merged), vec![PrEvent::Merged]);
    assert_eq!(pr_events(&merged, &merged), vec![]);
}

/// 1.169.1 (R1, walk R3 step A4): a green, mergeable pull request with
/// nothing in the way is ready to merge — said once, when it becomes so.
#[test]
fn the_ready_to_merge_transition_is_said_once() {
    let mut card = shipped_card(SANDBOX_URL);
    let first = apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 1_000, "x").unwrap();
    assert!(first.events.is_empty(), "pending asks nothing");
    let ready = apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 2_000, "x").unwrap();
    assert_eq!(ready.events, vec![PrEvent::ReadyToMerge], "notified once it is ready");
    assert!(card_ready_to_merge(&card));
    let again = apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 3_000, "x").unwrap();
    assert!(again.events.is_empty(), "a second identical read doesn't notify again");
    assert_eq!(
        notification_words(&card, PrEvent::ReadyToMerge),
        ("Ready to merge on GitHub".to_string(), "Add sum #1 · checks passed".to_string())
    );
}

/// Challenger M2: GitHub saying `UNKNOWN` for a moment on the same head is
/// not a second "ready".
#[test]
fn ready_again_on_the_same_head_after_unknown_is_not_said_twice() {
    let mut card = shipped_card(SANDBOX_URL);
    let unknown = derived(PASSING, |v| v["mergeable"] = "UNKNOWN".into());
    let mut said = 0;
    for (at, json) in [(2_000, PASSING.to_string()), (3_000, unknown.clone()), (4_000, PASSING.to_string())] {
        let applied = apply_status(&mut card, parse_pr_view(&json).unwrap(), at, "x").unwrap();
        said += applied.events.iter().filter(|e| **e == PrEvent::ReadyToMerge).count();
    }
    assert_eq!(said, 1);
    // A new head that is ready again is said again.
    let new_head = derived(PASSING, |v| v["headRefOid"] = "f00".into());
    let applied = apply_status(&mut card, parse_pr_view(&new_head).unwrap(), 5_000, "x").unwrap();
    assert_eq!(applied.events, vec![PrEvent::ReadyToMerge]);
}

/// Challenger M2: a card written before 1.169.1 has no `readySaidHead`; it
/// loads unchanged, as never said.
#[test]
fn a_pull_request_written_before_ready_said_head_loads_without_it() {
    let old = r#"{"number":4,"state":"open","checks":"passing","checksTotal":1,"checksPassed":1,"checksPending":0,"failingChecks":[],"mergeable":"mergeable","reviewDecision":"none","headSha":"h","checkedAt":5,"awaitingChecks":false}"#;
    let pr: PrStatus = serde_json::from_str(old).unwrap();
    assert_eq!(pr.ready_said_head, None);
    assert_eq!((pr.number, pr.head_sha.as_deref(), pr.checked_at), (4, Some("h"), Some(5)));
    let back = serde_json::to_value(&pr).unwrap();
    assert_eq!(back["readySaidHead"], serde_json::Value::Null);
}

/// Owner decision B1: a pull request with no checks on GitHub is ready once
/// the wait after its opening is over; inside the wait it isn't.
#[test]
fn a_pull_request_without_checks_is_ready_once_the_wait_is_over() {
    use crate::inbox::InboxEventKind as K;
    let none = derived(PASSING, |v| v["statusCheckRollup"] = serde_json::json!([]));
    let mut card = shipped_card(SANDBOX_URL);
    // Opened at 100: inside AWAITING_FIRST_CHECKS_MS GitHub may not have started them.
    let early = apply_status(&mut card, parse_pr_view(&none).unwrap(), 1_000, "x").unwrap();
    assert!(card.pr.as_ref().unwrap().awaiting_checks);
    assert!(early.events.is_empty() && !card_ready_to_merge(&card));
    assert!(inbox(&card).is_empty());

    let later = 100 + AWAITING_FIRST_CHECKS_MS + 1;
    let ready = apply_status(&mut card, parse_pr_view(&none).unwrap(), later, "x").unwrap();
    assert_eq!(ready.events, vec![PrEvent::ReadyToMerge]);
    assert_eq!(
        notification_words(&card, PrEvent::ReadyToMerge).1,
        "Add sum #1 · no checks on GitHub"
    );
    let rows = inbox(&card);
    assert_eq!(kinds(&rows), vec![K::PrReadyToMerge]);
    assert_eq!(rows[0].detail.as_deref(), Some(READY_NO_CHECKS_DETAIL));
}

#[test]
fn ready_to_merge_needs_mergeable_a_clear_merge_state_no_review_and_auto_merge_off() {
    let read = |json: &str| {
        let mut pr = parse_pr_view(json).unwrap();
        pr.checked_at = Some(1);
        pr
    };
    let green = read(PASSING);
    assert!(green.ready_to_merge() && !green.waits_for_review());
    assert!(!parse_pr_view(PASSING).unwrap().ready_to_merge(), "never read: not ready");
    let with = |edit: fn(&mut serde_json::Value)| read(&derived(PASSING, edit));

    let review = with(|v| {
        v["reviewDecision"] = "REVIEW_REQUIRED".into();
        v["mergeStateStatus"] = "BLOCKED".into();
    });
    assert!(!review.ready_to_merge() && review.waits_for_review(), "BLOCKED doesn't gate the review wait");

    // M1: GitHub's merge state stands in the way.
    for state in ["BLOCKED", "BEHIND", "DRAFT", "DIRTY"] {
        let mut pr = green.clone();
        pr.merge_state = Some(state.to_ascii_lowercase());
        assert!(!pr.ready_to_merge(), "{state}");
    }
    assert!(!read(RERUN_GREEN).ready_to_merge(), "real: green rerun, merge state blocked");

    let auto = with(|v| v["autoMergeRequest"] = serde_json::json!({"enabledAt": "2026-09-29T10:58:16Z"}));
    assert!(!auto.ready_to_merge() && !auto.waits_for_review(), "GitHub merges it: nothing asked");

    let unknown = with(|v| v["mergeable"] = "UNKNOWN".into());
    assert!(!unknown.ready_to_merge(), "GitHub hasn't said it is mergeable");
    let conflict = with(|v| v["mergeable"] = "CONFLICTING".into());
    assert!(!conflict.ready_to_merge() && !conflict.waits_for_review());
    let changes = with(|v| v["reviewDecision"] = "CHANGES_REQUESTED".into());
    assert!(!changes.ready_to_merge() && !changes.waits_for_review());
    assert!(!read(PENDING).ready_to_merge());
    assert!(!read(FAILING).ready_to_merge());

    let mut awaiting = green.clone();
    awaiting.awaiting_checks = true;
    assert!(!awaiting.ready_to_merge(), "not the old head's checks right after a push");
}

#[test]
fn inbox_rows_for_a_green_pull_request() {
    use crate::inbox::{InboxEventKind as K, InboxGroup};
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 2_000, "x").unwrap();
    let rows = inbox(&card);
    assert_eq!(kinds(&rows), vec![K::PrReadyToMerge]);
    assert_eq!(rows[0].group, InboxGroup::NeedsYou);
    assert_eq!(rows[0].detail, None, "checks passed");
    assert_eq!(rows[0].url.as_deref(), Some(SANDBOX_URL));
    assert_eq!(rows[0].id, "pr-ready:c1:1:e0f5b6b3037acb2bb9a2eb1a48f0a73f0e6b2578");

    // Owner (m8): waiting for a required review is On hold — no row, no
    // notification.
    let review = derived(PASSING, |v| {
        v["reviewDecision"] = "REVIEW_REQUIRED".into();
        v["mergeStateStatus"] = "BLOCKED".into();
    });
    let applied = apply_status(&mut card, parse_pr_view(&review).unwrap(), 3_000, "x").unwrap();
    assert!(applied.events.is_empty());
    assert!(inbox(&card).is_empty());

    let auto = derived(PASSING, |v| v["autoMergeRequest"] = serde_json::json!({"enabledAt": "2026-09-29T10:58:16Z"}));
    apply_status(&mut card, parse_pr_view(&auto).unwrap(), 4_000, "x").unwrap();
    assert!(inbox(&card).is_empty(), "auto-merge on: GitHub merges it, nothing asked");
}

/// Round 2: a card shipped another way gets no "Ready to merge"
/// notification, as it gets no Inbox row — one rule for both.
#[test]
fn a_shipped_card_is_not_said_ready() {
    let mut card = shipped_card(SANDBOX_URL);
    card.ship_status = ShipStatus::Shipped;
    let applied = apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 2_000, "x").unwrap();
    assert!(applied.events.is_empty());
    assert!(!card_ready_to_merge(&card));
    assert!(inbox(&card).iter().all(|e| e.kind != crate::inbox::InboxEventKind::PrReadyToMerge));
}

/// Challenger m1: Plyloft's own blockers — a build the pull request doesn't
/// hold yet, or the Challenger's request for changes on the latest snapshot
/// — mean no ready row and no notification.
#[test]
fn plyloft_side_blockers_hold_back_ready() {
    use crate::kanban::{BuildSnapshot, BuilderState};
    let with_builder = |sha: &str, changes: bool| {
        let mut card = shipped_card(SANDBOX_URL);
        let mut b: BuilderState = serde_json::from_value(serde_json::json!({
            "vendor": "claude", "bypass": false, "startedAt": 1, "snapshots": []
        }))
        .unwrap();
        b.snapshots.push(BuildSnapshot { n: 1, sha: sha.to_string(), at: 1 });
        if changes {
            b.review = Some(
                serde_json::from_value(serde_json::json!({
                    "snapshotN": 1, "provider": "codex", "degraded": false,
                    "status": "done", "verdict": "changes_requested", "at": 2
                }))
                .unwrap(),
            );
        }
        card.builder = Some(b);
        card
    };
    let head = "e0f5b6b3037acb2bb9a2eb1a48f0a73f0e6b2578";
    let mut unpushed = with_builder("abc123", false);
    let applied = apply_status(&mut unpushed, parse_pr_view(PASSING).unwrap(), 2_000, "x").unwrap();
    assert!(applied.events.is_empty() && inbox(&unpushed).is_empty(), "a fix waits for Push update");

    let mut challenged = with_builder(head, true);
    let applied = apply_status(&mut challenged, parse_pr_view(PASSING).unwrap(), 2_000, "x").unwrap();
    assert!(applied.events.is_empty() && inbox(&challenged).is_empty(), "the Reviewer asked for changes");

    let mut clear = with_builder(head, false);
    let applied = apply_status(&mut clear, parse_pr_view(PASSING).unwrap(), 2_000, "x").unwrap();
    assert_eq!(applied.events, vec![PrEvent::ReadyToMerge]);
}

// ── Transitions on the card ─────────────────────────────────────────────

#[test]
fn an_open_read_is_recorded_and_changes_only_what_github_said() {
    let mut card = shipped_card(SANDBOX_URL);
    let applied = apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 1_000, "1.0.0").unwrap();
    assert!(applied.changed && applied.events.is_empty());
    let pr = card.pr.clone().unwrap();
    assert_eq!(pr.checked_at, Some(1_000));
    assert_eq!(pr.opened_at, Some(100), "kept from the ship");
    assert_eq!(card.review_status, Some(ReviewStatus::Merged), "still in the PR");
    assert_eq!(card.ship_status, ShipStatus::Unshipped);

    // The same answer later: nothing changed but the time.
    let again = apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 2_000, "1.0.0").unwrap();
    assert!(!again.changed);
    assert_eq!(card.pr.as_ref().unwrap().checked_at, Some(2_000));
}

/// X5 (G1 walk): "the card's copy was kept" stands only while the card
/// still has that copy — recorded, and its folder there.
#[test]
fn why_the_copy_was_kept_goes_with_the_copy() {
    let copy = tempfile::tempdir().unwrap();
    let mut card = shipped_card("https://github.com/cli/cli/pull/14517");
    card.worktree_path = Some(copy.path().display().to_string());
    apply_status(&mut card, parse_pr_view(MERGED).unwrap(), 5_000, "x").unwrap();
    card.pr.as_mut().unwrap().cleanup_kept = Some(KEPT_FOR_SESSION.into());
    assert!(card_keeps_copy(&card));
    apply_status(&mut card, parse_pr_view(MERGED).unwrap(), 6_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().cleanup_kept.as_deref(), Some(KEPT_FOR_SESSION), "the copy is there: still true");
    // The folder went (git removed it), the card still naming it.
    let gone = copy.path().display().to_string();
    drop(copy);
    assert_eq!(card.worktree_path.as_deref(), Some(gone.as_str()));
    assert!(!card_keeps_copy(&card));
    apply_status(&mut card, parse_pr_view(MERGED).unwrap(), 7_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().cleanup_kept, None);
    // No copy recorded at all.
    card.pr.as_mut().unwrap().cleanup_kept = Some(KEPT_FOR_SESSION.into());
    card.worktree_path = None;
    apply_status(&mut card, parse_pr_view(MERGED).unwrap(), 8_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().cleanup_kept, None);
}

#[test]
fn merged_ships_the_card_once() {
    let mut card = shipped_card("https://github.com/cli/cli/pull/14517");
    let merged = parse_pr_view(MERGED).unwrap();
    assert_eq!(merged.number, 14517, "fixture's own number");
    let applied = apply_status(&mut card, merged.clone(), 5_000, "1.153.1").unwrap();
    assert_eq!(applied.events, vec![PrEvent::Merged]);
    assert_eq!(card.ship_status, ShipStatus::Shipped);
    assert_eq!(card.review_status, Some(ReviewStatus::Merged));
    assert_eq!(card.ship_history.len(), 1);
    let entry = &card.ship_history[0];
    assert_eq!(Some(entry.commit_sha.as_str()), merged.merge_commit.as_deref());
    assert_eq!(entry.shipped_version, "1.153.1");
    assert_eq!(entry.release_kind, ReleaseKind::Local);
    assert_eq!(Some(entry.shipped_at), merged.merged_at, "when GitHub merged it");
    assert_eq!(card.commit_sha, merged.merge_commit);
    // The worktree handle is the cleanup's to clear, after the prune.
    assert!(card.worktree_path.is_some());

    let again = apply_status(&mut card, merged, 6_000, "1.153.1").unwrap();
    assert!(again.events.is_empty());
    assert_eq!(card.ship_history.len(), 1, "one entry");
}

#[test]
fn closed_sends_the_card_back_to_review_and_reopened_brings_it_back() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 1_000, "x").unwrap();
    let applied = apply_status(&mut card, parse_pr_view(CLOSED).unwrap(), 2_000, "x").unwrap();
    assert_eq!(applied.events, vec![PrEvent::Closed]);
    assert_eq!(card.review_status, Some(ReviewStatus::Pending));
    assert_eq!(card.ship_status, ShipStatus::Unshipped);
    assert!(card.worktree_path.is_some() && card.branch_name.is_some(), "kept");
    assert_eq!(card.pr_url.as_deref(), Some(SANDBOX_URL));

    apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 3_000, "x").unwrap();
    assert_eq!(card.review_status, Some(ReviewStatus::Merged), "reopened");
}

#[test]
fn a_read_of_another_pr_than_the_card_records_is_refused() {
    let mut card = shipped_card("https://github.com/o/r/pull/7");
    let before = card.clone();
    let err = apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 1, "x").unwrap_err();
    assert!(err.contains("#7"), "{err}");
    assert_eq!(serde_json::to_value(&card).unwrap(), serde_json::to_value(&before).unwrap());

    card.pr_url = None;
    assert!(apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 1, "x").is_err());
}

/// Coordinator decision (M3): a card shipped as a PR before SL-1 (no `pr`)
/// is never read and never changed — apply refuses it, the poller skips it,
/// `mark_card_pr_shipped` is its only way in (a new ship).
#[test]
fn a_card_shipped_before_sl1_is_left_exactly_as_it_is() {
    let mut card = shipped_card(SANDBOX_URL);
    card.pr = None;
    let before = serde_json::to_value(&card).unwrap();
    for answer in [PENDING, FAILING, CLOSED] {
        let err = apply_status(&mut card, parse_pr_view(answer).unwrap(), 9, "x").unwrap_err();
        assert_eq!(err, LEGACY_REFUSAL);
    }
    assert_eq!(serde_json::to_value(&card).unwrap(), before, "untouched");
    assert!(!poll_candidate(&card), "never polled");

    // Through the store, as `card_pr_refresh` writes: refused, nothing written.
    let tmp = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    store.save("ws", vec![card.clone()]).unwrap();
    let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json");
    let on_disk = std::fs::read(&path).unwrap();
    let refused = store.update_card_pr("ws", "c1", |c| {
        apply_status(c, parse_pr_view(CLOSED).unwrap(), 9, "x").map(|a| ((), pr_write(a.changed, None, 9)))
    });
    assert!(refused.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), on_disk, "board not rewritten");
    assert_eq!(serde_json::to_value(store.get_card("ws", "c1").unwrap()).unwrap(), before);
    // The Inbox says nothing new about it.
    assert!(inbox(&card).is_empty());
}

// ── Cadence ─────────────────────────────────────────────────────────────

#[test]
fn polling_is_every_minute_while_checks_run_and_every_ten_otherwise() {
    let mut pending = parse_pr_view(PENDING).unwrap();
    pending.checked_at = Some(0);
    let mut passing = parse_pr_view(PASSING).unwrap();
    passing.checked_at = Some(0);
    assert_eq!(poll_interval_ms(&pending, 0, 0), 60_000);
    assert_eq!(poll_interval_ms(&passing, 0, 0), 600_000);
    // Never read yet: soon.
    assert_eq!(poll_interval_ms(&PrStatus::opened(1, 0), 0, 0), 60_000);
    // Failed reads back off, capped at ten minutes, never sooner than normal.
    let backoff: Vec<i64> = (1..=7).map(|f| poll_interval_ms(&pending, f, 0)).collect();
    assert_eq!(backoff, vec![60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
    assert_eq!(poll_interval_ms(&passing, 1, 0), 600_000);

    assert!(poll_due(&PrStatus::opened(1, 0), None, 0, 0), "never read");
    assert!(!poll_due(&pending, Some(1_000), 0, 60_999));
    assert!(poll_due(&pending, Some(1_000), 0, 61_000));
    // After a relaunch the card's own read time stands in.
    assert!(!poll_due(&passing, None, 0, 599_999));
    assert!(poll_due(&passing, None, 0, 600_000));
}

/// m5: checks pending for over an hour (a check that never reports, an
/// EXPECTED status, a STALE run) are read at the settled cadence.
#[test]
fn pending_over_an_hour_is_read_every_ten_minutes() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 1_000, "x").unwrap();
    // The same head still pending later keeps its start.
    apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 50_000, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert_eq!(pr.pending_since, Some(1_000));
    assert_eq!(poll_interval_ms(&pr, 0, 1_000 + PENDING_CAP_MS - 1), 60_000);
    assert_eq!(poll_interval_ms(&pr, 0, 1_000 + PENDING_CAP_MS), 600_000);
    // A new push restarts the hour; a settled read clears it.
    let pushed = derived(PENDING, |v| v["headRefOid"] = "new".into());
    apply_status(&mut card, parse_pr_view(&pushed).unwrap(), 70_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().pending_since, Some(70_000));
    apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 80_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().pending_since, None);
}

#[test]
fn stale_and_expected_count_as_pending_never_passed() {
    let stale = derived(PASSING, |v| {
        for c in v["statusCheckRollup"].as_array_mut().unwrap() {
            c["conclusion"] = "STALE".into();
        }
    });
    assert_eq!(parse_pr_view(&stale).unwrap().checks, PrChecks::Pending);
    let expected = derived(PASSING, |v| {
        v["statusCheckRollup"].as_array_mut().unwrap().push(serde_json::json!({
            "__typename": "StatusContext", "context": "deploy", "state": "EXPECTED"
        }));
    });
    let pr = parse_pr_view(&expected).unwrap();
    // PASSING's two green runs (walk 6b: as GitHub's page counts them).
    assert_eq!((pr.checks, pr.checks_pending, pr.checks_passed), (PrChecks::Pending, 1, 2));
}

/// m1: a read that finds nothing new isn't written, unless the stored read
/// time is older than ten minutes.
#[test]
fn a_read_that_changed_nothing_is_written_at_most_every_ten_minutes() {
    assert_eq!(pr_write(true, Some(0), 1), PrWrite::Stamp);
    assert_eq!(pr_write(false, None, 1), PrWrite::Quiet);
    assert_eq!(pr_write(false, Some(0), CHECKED_AT_PERSIST_MS - 1), PrWrite::Skip);
    assert_eq!(pr_write(false, Some(0), CHECKED_AT_PERSIST_MS), PrWrite::Quiet);
}

#[test]
fn only_open_prs_of_live_cards_are_polled() {
    let card = shipped_card(SANDBOX_URL);
    assert!(poll_candidate(&card));
    let mut archived = card.clone();
    archived.archived = true;
    assert!(!poll_candidate(&archived));
    let mut legacy = card.clone();
    legacy.pr = None;
    assert!(!poll_candidate(&legacy), "shipped before SL-1: never read");
    for state in [PrState::Merged, PrState::Closed] {
        let mut done = card.clone();
        done.pr.as_mut().unwrap().state = state;
        assert!(!poll_candidate(&done));
    }
    let mut local = card;
    local.pr_url = None;
    assert!(!poll_candidate(&local));
}

// ── The store and the Inbox ─────────────────────────────────────────────

#[test]
fn a_read_moves_updated_at_only_when_github_said_something_new() {
    let tmp = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let mut card = shipped_card(SANDBOX_URL);
    card.updated_at = 5;
    store.save("ws", vec![card]).unwrap();

    let read = |json: &str, now: i64| {
        let next = parse_pr_view(json).unwrap();
        store
            .update_card_pr("ws", "c1", |c| {
                let stored = c.pr.as_ref().and_then(|p| p.checked_at);
                let a = apply_status(c, next, now, "x")?;
                let write = pr_write(a.changed, stored, now);
                Ok((write, write))
            })
            .unwrap()
    };
    let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json");
    let (card, write) = read(PENDING, 10);
    assert_eq!(write, PrWrite::Stamp);
    assert!(card.updated_at > 5);
    let stamped = card.updated_at;
    let on_disk = std::fs::read(&path).unwrap();

    // Same facts a minute later: shown with its time, not written.
    let (card, write) = read(PENDING, 60_010);
    assert_eq!(write, PrWrite::Skip);
    assert_eq!(card.pr.as_ref().unwrap().checked_at, Some(60_010), "the caller sees it");
    assert_eq!(std::fs::read(&path).unwrap(), on_disk, "the board isn't");
    assert_eq!(store.get_card("ws", "c1").unwrap().pr.unwrap().checked_at, Some(10));

    // Ten minutes after the stored read: the time is written, quietly.
    let (card, write) = read(PENDING, 10 + CHECKED_AT_PERSIST_MS);
    assert_eq!(write, PrWrite::Quiet);
    assert_eq!(card.updated_at, stamped, "same facts");
    let reloaded = crate::kanban::KanbanStore::new(tmp.path().to_path_buf())
        .unwrap()
        .get_card("ws", "c1")
        .unwrap();
    assert_eq!(reloaded.pr, card.pr, "persisted");

    // A refused read writes nothing.
    let other = derived(PASSING, |v| v["number"] = 2.into());
    let err = store.update_card_pr("ws", "c1", |c| {
        apply_status(c, parse_pr_view(&other).unwrap(), 30, "x").map(|_| ((), PrWrite::Stamp))
    });
    assert!(err.is_err());
    assert_eq!(store.get_card("ws", "c1").unwrap().pr, card.pr);
}

#[test]
fn mark_card_pr_shipped_starts_the_pr_open_and_keeps_a_relinked_one() {
    let tmp = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c1".into(), "ws".into(), "T".into(), None, KanbanColumnId::InProgress);
    store.save("ws", vec![card]).unwrap();
    store.mark_card_pr_shipped("ws", "c1", SANDBOX_URL, None).unwrap();
    let card = store.get_card("ws", "c1").unwrap();
    let pr = card.pr.clone().unwrap();
    assert_eq!((pr.number, pr.state, pr.checked_at), (1, PrState::Open, None));
    assert!(pr.opened_at.is_some());
    assert_eq!(card.review_status, Some(ReviewStatus::Merged));

    // Read once, then linked again (Ship on a branch whose PR exists).
    store
        .update_card_pr("ws", "c1", |c| {
            apply_status(c, parse_pr_view(FAILING).unwrap(), 50, "x").map(|_| ((), PrWrite::Stamp))
        })
        .unwrap();
    store.mark_card_pr_shipped("ws", "c1", SANDBOX_URL, None).unwrap();
    assert_eq!(store.get_card("ws", "c1").unwrap().pr.unwrap().checks, PrChecks::Failing);

    // A new PR starts over.
    store.mark_card_pr_shipped("ws", "c1", "https://github.com/o/r/pull/2", None).unwrap();
    let pr = store.get_card("ws", "c1").unwrap().pr.unwrap();
    assert_eq!((pr.number, pr.checks), (2, PrChecks::None));
}

fn inbox(card: &KanbanCard) -> Vec<crate::inbox::InboxEvent> {
    crate::inbox::derive_card_events("Sandbox", std::slice::from_ref(card), 0)
}

fn kinds(events: &[crate::inbox::InboxEvent]) -> Vec<crate::inbox::InboxEventKind> {
    events.iter().map(|e| e.kind).collect()
}

#[test]
fn inbox_rows_follow_the_open_pr() {
    use crate::inbox::{InboxEventKind as K, InboxGroup};
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 1, "x").unwrap();
    assert!(inbox(&card).is_empty(), "pending asks nothing");

    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 2, "x").unwrap();
    let rows = inbox(&card);
    assert_eq!(kinds(&rows), vec![K::PrChecksFailed]);
    // 1.173.0 (F1): Failed folded into Needs you.
    assert_eq!(rows[0].group, InboxGroup::NeedsYou);
    assert_eq!(rows[0].detail.as_deref(), Some("test"));
    assert_eq!(rows[0].url.as_deref(), Some(SANDBOX_URL));
    assert_eq!(
        rows[0].id,
        "pr-checks:c1:1:788cb9c95d076fcb7960fa0ddd7c6679dd051b4c",
        "keyed by the head: a new failing push is a new row"
    );

    let open_changes = derived(CHANGES, |v| {
        v["state"] = "OPEN".into();
        v["number"] = 1.into();
        v["mergeable"] = "CONFLICTING".into();
    });
    apply_status(&mut card, parse_pr_view(&open_changes).unwrap(), 3, "x").unwrap();
    let rows = inbox(&card);
    assert_eq!(kinds(&rows), vec![K::PrChangesRequested, K::PrConflict]);
    assert_eq!(rows[0].group, InboxGroup::NeedsYou);
    assert!(rows[0].detail.as_deref().unwrap().starts_with("Please no"), "the review text");
    assert_eq!(rows[1].group, InboxGroup::NeedsYou);
}

#[test]
fn inbox_says_closed_instead_of_review_it_and_merged_as_the_ship() {
    use crate::inbox::{InboxEventKind as K, InboxGroup};
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(CLOSED).unwrap(), 1, "x").unwrap();
    let rows = inbox(&card);
    assert_eq!(kinds(&rows), vec![K::PrClosed], "not also the plain review row");
    assert_eq!(rows[0].group, InboxGroup::NeedsYou);
    assert_eq!(rows[0].detail.as_deref(), Some("#1"));

    let mut merged = shipped_card("https://github.com/cli/cli/pull/14517");
    apply_status(&mut merged, parse_pr_view(MERGED).unwrap(), 1, "1.0.0").unwrap();
    let rows = inbox(&merged);
    assert_eq!(kinds(&rows), vec![K::PrMerged]);
    assert_eq!(rows[0].group, InboxGroup::Shipped);
    assert_eq!(rows[0].detail.as_deref(), Some("#14517"));
    assert_eq!(rows[0].id, format!("ship:c1:{}", merged.ship_history[0].commit_sha), "the ship's id");

    // A card shipped before SL-1 keeps its rows exactly.
    let mut legacy = shipped_card(SANDBOX_URL);
    legacy.pr = None;
    assert!(inbox(&legacy).is_empty());
}

#[test]
fn notification_words_name_the_card_and_the_facts() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 1, "x").unwrap();
    assert_eq!(
        notification_words(&card, PrEvent::ChecksFailed),
        ("Checks failed on GitHub".to_string(), "Add sum #1 · test".to_string())
    );
    assert_eq!(notification_words(&card, PrEvent::Closed).0, "Pull request closed without merging");
}

// ── v1.154.1 walk fixes ─────────────────────────────────────────────────

/// F11: a card whose v1.154.0 review loop erased its open pull request
/// (`review_status` none) gets it back on the next read; its Inbox rows
/// follow the PR's own state, even while the Challenger asks for changes.
#[test]
fn an_open_pr_erased_by_the_review_loop_comes_back_on_the_next_read() {
    use crate::inbox::InboxEventKind as K;
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 1, "x").unwrap();
    assert!(card_pr_open(&card));

    // The Challenger asked for changes on the fix: the PR's row stays.
    card.review_status = Some(ReviewStatus::ChangesRequested);
    assert!(kinds(&inbox(&card)).contains(&K::PrChecksFailed));
    assert_eq!(cleared_review_status(&card), Some(ReviewStatus::Merged));

    // What v1.154.0 left: no review status, the PR still open.
    card.review_status = None;
    apply_status(&mut card, parse_pr_view(PASSING).unwrap(), 2, "x").unwrap();
    assert_eq!(card.review_status, Some(ReviewStatus::Merged));

    // A closed PR, a landed card and a card shipped before SL-1 are not open.
    let mut closed = shipped_card(SANDBOX_URL);
    apply_status(&mut closed, parse_pr_view(CLOSED).unwrap(), 1, "x").unwrap();
    assert!(!card_pr_open(&closed));
    assert_eq!(cleared_review_status(&closed), None);
    let mut landed = card.clone();
    landed.ship_status = ShipStatus::Shipped;
    assert!(!card_pr_open(&landed));
    let mut legacy = shipped_card(SANDBOX_URL);
    legacy.pr = None;
    assert!(!card_pr_open(&legacy));
    assert_eq!(cleared_review_status(&legacy), None);
}

/// F12: with "Merge when checks pass" on, the PR is read every minute after
/// its checks passed too — the card reaches Done about a minute after GitHub
/// merged it — capped at an hour like pending checks; not while a failed
/// check or a conflict stops GitHub from merging.
#[test]
fn auto_merge_is_read_every_minute_until_it_merges() {
    let auto = derived(PASSING, |v| {
        v["autoMergeRequest"] = serde_json::json!({"enabledAt": "2026-09-29T10:58:16Z", "mergeMethod": "SQUASH"});
    });
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(&auto).unwrap(), 1_000, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert!(pr.auto_merge && watched_closely(&pr));
    assert_eq!(pr.pending_since, Some(1_000));
    assert_eq!(poll_interval_ms(&pr, 0, 1_000 + 59_000), 60_000);
    // The same head keeps its start; an hour on, every ten minutes.
    apply_status(&mut card, parse_pr_view(&auto).unwrap(), 50_000, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert_eq!(pr.pending_since, Some(1_000));
    assert_eq!(poll_interval_ms(&pr, 0, 1_000 + PENDING_CAP_MS), 600_000);

    // Failing checks or a conflict: GitHub won't merge it — settled cadence.
    let failing = derived(FAILING, |v| {
        v["autoMergeRequest"] = serde_json::json!({"enabledAt": "2026-09-29T10:58:16Z"});
    });
    let mut pr = parse_pr_view(&failing).unwrap();
    pr.checked_at = Some(0);
    assert!(pr.auto_merge && !watched_closely(&pr));
    assert_eq!(poll_interval_ms(&pr, 0, 0), 600_000);
    let conflict = derived(&auto, |v| v["mergeable"] = "CONFLICTING".into());
    let mut pr = parse_pr_view(&conflict).unwrap();
    pr.checked_at = Some(0);
    assert!(!watched_closely(&pr));

    // Without auto-merge, passed checks stay at ten minutes (as before).
    let mut pr = parse_pr_view(PASSING).unwrap();
    pr.checked_at = Some(0);
    assert_eq!(poll_interval_ms(&pr, 0, 0), 600_000);
}

/// M4: checks that pass while auto-merge is on restart the fast hour; a
/// request for changes stops GitHub merging it, so it isn't watched closely.
#[test]
fn passing_checks_restart_the_auto_merge_hour_and_changes_requested_is_settled() {
    let auto = |json: &str| {
        derived(json, |v| {
            v["autoMergeRequest"] = serde_json::json!({"enabledAt": "2026-09-29T10:58:16Z"});
        })
    };
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(&auto(PENDING)).unwrap(), 1_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().pending_since, Some(1_000));
    // The same head, now passed.
    let passing_same_head = derived(&auto(PASSING), |v| {
        v["headRefOid"] = "788cb9c95d076fcb7960fa0ddd7c6679dd051b4c".into();
    });
    apply_status(&mut card, parse_pr_view(&passing_same_head).unwrap(), 50 * 60_000, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert_eq!(pr.pending_since, Some(50 * 60_000), "restarted when checks passed");
    assert_eq!(poll_interval_ms(&pr, 0, 50 * 60_000 + 30 * 60_000), 60_000);

    let changes = derived(&auto(PASSING), |v| v["reviewDecision"] = "CHANGES_REQUESTED".into());
    let pr = parse_pr_view(&changes).unwrap();
    assert!(pr.auto_merge && !watched_closely(&pr));
}

// ── v1.154.1 (walk I1): the checks of a push, before GitHub shows them ──

/// Re-walk R2 (PR #15, 2026-09-29): checks failed, Push update sent
/// 6824e1d, and the read right after it found the new head with no checks
/// at all (GitHub hadn't registered the run). v1.154.1 settled at 10 min
/// and offered Merge; the card sat on "None" while both checks passed.
#[test]
fn no_checks_right_after_a_push_is_awaited_every_minute_not_settled() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 1_000, "x").unwrap();
    assert!(card.pr.as_ref().unwrap().checks_seen);
    assert!(!card.pr.as_ref().unwrap().awaiting_checks);

    let pushed = "6824e1d0000000000000000000000000000000aa";
    let at = 10 * 60_000;
    card.pr.as_mut().unwrap().mark_pushed(pushed, at);
    assert!(card.pr.as_ref().unwrap().awaiting_checks, "awaited from the push on");

    // The read right after the push: the new head, no checks yet.
    let none_on_new_head = derived(PASSING, |v| {
        v["statusCheckRollup"] = serde_json::json!([]);
        v["headRefOid"] = pushed.into();
    });
    let now = at + 2_000;
    let applied = apply_status(&mut card, parse_pr_view(&none_on_new_head).unwrap(), now, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert_eq!(pr.checks, PrChecks::None);
    assert!(pr.awaiting_checks, "none right after a push is 'not started yet'");
    assert!(applied.events.is_empty());
    assert_eq!(poll_interval_ms(&pr, 0, now), POLL_PENDING_MS, "read every minute, not ten");
    assert_eq!(
        crate::pr_merge::merge_refusal(&pr).as_deref(),
        Some(crate::pr_merge::AWAITING_CHECKS_WORDS),
        "no Merge before GitHub has the checks"
    );
    assert_eq!(pr.pushed_head.as_deref(), Some(pushed), "kept across reads");

    // GitHub starts them: pending, the wait is over, still every minute.
    let pending_on_new_head = derived(PENDING, |v| v["headRefOid"] = pushed.into());
    let applied = apply_status(&mut card, parse_pr_view(&pending_on_new_head).unwrap(), now + 60_000, "x").unwrap();
    assert!(applied.changed);
    let pr = card.pr.clone().unwrap();
    assert!(!pr.awaiting_checks);
    assert_eq!(pr.checks, PrChecks::Pending);
    assert_eq!(poll_interval_ms(&pr, 0, now + 60_000), POLL_PENDING_MS);
}

#[test]
fn a_read_still_on_the_old_head_after_a_push_is_awaited_too() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 1_000, "x").unwrap();
    let old_head = card.pr.as_ref().unwrap().head_sha.clone().unwrap();
    card.pr.as_mut().unwrap().mark_pushed("6824e1d", 5_000);
    // GitHub still shows the old head and its failed check.
    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 6_000, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert_eq!(pr.head_sha.as_deref(), Some(old_head.as_str()));
    assert!(pr.awaiting_checks, "the failure is the old head's");
    // A short sha is the same commit as its full one.
    let caught_up = derived(PENDING, |v| v["headRefOid"] = "6824e1d0000000000000000000000000000000aa".into());
    apply_status(&mut card, parse_pr_view(&caught_up).unwrap(), 7_000, "x").unwrap();
    assert!(!card.pr.as_ref().unwrap().awaiting_checks);
}

#[test]
fn the_wait_for_checks_is_bounded() {
    let none = derived(PASSING, |v| v["statusCheckRollup"] = serde_json::json!([]));
    // A pull request that showed checks before: ten minutes after the push.
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(FAILING).unwrap(), 1_000, "x").unwrap();
    card.pr.as_mut().unwrap().mark_pushed("", 2_000);
    apply_status(&mut card, parse_pr_view(&none).unwrap(), 2_000 + AWAITING_CHECKS_MS - 1, "x").unwrap();
    assert!(card.pr.as_ref().unwrap().awaiting_checks);
    let applied = apply_status(&mut card, parse_pr_view(&none).unwrap(), 2_000 + AWAITING_CHECKS_MS, "x").unwrap();
    let pr = card.pr.clone().unwrap();
    assert!(!pr.awaiting_checks, "then 'none' is none");
    assert!(applied.changed, "the end of the wait is written, so the card page follows");
    assert_eq!(poll_interval_ms(&pr, 0, 2_000 + AWAITING_CHECKS_MS), POLL_SETTLED_MS);
    assert_eq!(crate::pr_merge::merge_refusal(&pr), None);

    // Just opened, never a check seen (a repository without CI): three
    // minutes from the opening.
    let mut fresh = shipped_card(SANDBOX_URL);
    assert!(fresh.pr.as_ref().unwrap().awaiting_checks, "opened: awaited");
    apply_status(&mut fresh, parse_pr_view(&none).unwrap(), 100 + AWAITING_FIRST_CHECKS_MS - 1, "x").unwrap();
    assert!(fresh.pr.as_ref().unwrap().awaiting_checks);
    apply_status(&mut fresh, parse_pr_view(&none).unwrap(), 100 + AWAITING_FIRST_CHECKS_MS, "x").unwrap();
    assert!(!fresh.pr.as_ref().unwrap().awaiting_checks);

    // Merged or closed is never awaited.
    let mut merged = shipped_card(SANDBOX_URL);
    merged.pr.as_mut().unwrap().mark_pushed("abc", 100);
    let m = derived(MERGED, |v| v["number"] = 1.into());
    apply_status(&mut merged, parse_pr_view(&m).unwrap(), 200, "x").unwrap();
    assert!(!merged.pr.as_ref().unwrap().awaiting_checks);
}

#[test]
fn a_card_written_before_the_wait_loads_without_it() {
    // v1.154.1's `pr`, without the new fields.
    let json = r#"{"number":15,"state":"open","checks":"none","checksTotal":0,"checkedAt":1790687520274,"openedAt":1}"#;
    let pr: PrStatus = serde_json::from_str(json).unwrap();
    assert_eq!((pr.pushed_at, pr.pushed_head.clone(), pr.checks_seen, pr.awaiting_checks), (None, None, false, false));
    assert!(!awaiting_checks(&pr, 1790687520274));
}

#[test]
fn a_ship_that_relinks_its_open_pr_awaits_its_checks_again() {
    let tmp = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c1".into(), "ws".into(), "T".into(), None, KanbanColumnId::InProgress);
    store.save("ws", vec![card]).unwrap();
    store.mark_card_pr_shipped("ws", "c1", SANDBOX_URL, None).unwrap();
    store
        .update_card_pr("ws", "c1", |c| {
            apply_status(c, parse_pr_view(PASSING).unwrap(), i64::MAX / 2, "x").map(|_| ((), PrWrite::Stamp))
        })
        .unwrap();
    assert!(!store.get_card("ws", "c1").unwrap().pr.unwrap().awaiting_checks);
    let pushed = "6824e1d0000000000000000000000000000000aa";
    store.mark_card_pr_shipped("ws", "c1", SANDBOX_URL, Some(pushed)).unwrap();
    let pr = store.get_card("ws", "c1").unwrap().pr.unwrap();
    assert!(pr.awaiting_checks && pr.pushed_at.is_some());
    assert_eq!(pr.pushed_head.as_deref(), Some(pushed));
    // GitHub still shows the old head and its passed checks: still awaited,
    // not "passed" for the commit just pushed (Challenger, I1).
    let at = pr.pushed_at.unwrap();
    let (card, ()) = store
        .update_card_pr("ws", "c1", |c| {
            apply_status(c, parse_pr_view(PASSING).unwrap(), at + 5_000, "x").map(|_| ((), PrWrite::Stamp))
        })
        .unwrap();
    assert!(card.pr.unwrap().awaiting_checks);
    // A new pull request records the head its ship pushed.
    store.mark_card_pr_shipped("ws", "c1", "https://github.com/o/r/pull/2", Some(pushed)).unwrap();
    assert_eq!(store.get_card("ws", "c1").unwrap().pr.unwrap().pushed_head.as_deref(), Some(pushed));
}

/// v1.154.1 round 3 (Challenger): the review panel's local land is refused
/// while the card's pull request is open, and allowed otherwise.
#[test]
fn a_local_land_is_refused_while_the_pull_request_is_open() {
    let card = shipped_card(SANDBOX_URL);
    let words = review_merge_refusal(&card).expect("open PR refuses");
    assert!(words.contains("pull request #1") && words.contains("nothing was changed"), "{words}");

    let mut merged = shipped_card(SANDBOX_URL);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    assert_eq!(review_merge_refusal(&merged), None);
    let mut closed = shipped_card(SANDBOX_URL);
    closed.pr.as_mut().unwrap().state = PrState::Closed;
    assert_eq!(review_merge_refusal(&closed), None);
    let mut never = shipped_card(SANDBOX_URL);
    never.pr = None;
    never.pr_url = None;
    assert_eq!(review_merge_refusal(&never), None);
}

/// 1.171.0 (D8): a merged card says its pull request's title shipped, so
/// the title is read from GitHub; a card read before has none and loads.
#[test]
fn the_pull_requests_title_is_read_and_old_cards_load_without_it() {
    let fields = super::PR_VIEW_FIELDS;
    assert!(fields.split(',').any(|f| f == "title"));
    assert!(super::PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE.split(',').any(|f| f == "title"));
    let pr = super::parse_pr_view(r#"{"number":122,"state":"MERGED","title":"  Add a notes page "}"#).unwrap();
    assert_eq!(pr.title.as_deref(), Some("Add a notes page"));
    let untitled = super::parse_pr_view(r#"{"number":122,"state":"MERGED"}"#).unwrap();
    assert_eq!(untitled.title, None);
    // Schema migration: a card written by 1.170 has no title, and writes none.
    let old = serde_json::json!({ "number": 122, "state": "merged", "headSha": "abc" });
    let pr: super::PrStatus = serde_json::from_value(old).unwrap();
    assert_eq!(pr.title, None);
    assert!(serde_json::to_value(&pr).unwrap().get("title").is_none());
}

// ── 1.171.0 (B1): a read the GitHub sign-in refused ─────────────────────

#[test]
fn a_read_refused_for_the_sign_in_needs_one() {
    for said in [
        "couldn't read the pull request on GitHub: To get started with GitHub CLI, please run:  gh auth login",
        "couldn't read the pull request on GitHub: HTTP 401: Bad credentials (https://api.github.com/graphql)",
        "couldn't read the pull request on GitHub: You are not logged into any GitHub hosts.",
        "Your team uses the GitHub account ana, which isn't signed in on this Mac.",
    ] {
        assert!(read_needs_sign_in(said), "{said}");
    }
    for said in [
        "couldn't read the pull request on GitHub: error connecting to api.github.com",
        "couldn't read the pull request on GitHub: HTTP 404: Not Found",
        "gh timed out",
    ] {
        assert!(!read_needs_sign_in(said), "{said}");
    }
}

#[test]
fn sign_in_needed_is_absent_on_older_records_and_written_only_when_true() {
    // A record from before 1.171.0 has no such field: false.
    let mut old = serde_json::to_value(PrStatus::opened(5, 100)).unwrap();
    old.as_object_mut().unwrap().remove("signInNeeded");
    let read: PrStatus = serde_json::from_value(old).unwrap();
    assert!(!read.sign_in_needed);
    assert!(serde_json::to_value(&read).unwrap().get("signInNeeded").is_none());
    let needed = PrStatus { sign_in_needed: true, ..read };
    let v = serde_json::to_value(&needed).unwrap();
    assert_eq!(v["signInNeeded"], true);
    assert!(serde_json::from_value::<PrStatus>(v).unwrap().sign_in_needed);
}

#[test]
fn a_read_that_reaches_github_clears_the_sign_in_and_is_written() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 1_000, "x").unwrap();
    card.pr.as_mut().unwrap().sign_in_needed = true;
    let applied = apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 2_000, "x").unwrap();
    assert!(!card.pr.as_ref().unwrap().sign_in_needed);
    assert!(applied.changed, "the card stops asking to sign in: a write");
}

/// 1.172.0 B2: the quit note's card count — an open pull request waiting for
/// Plyloft's own merge (GitHub's auto-merge off), never an archived card, a
/// merged one or one GitHub merges by itself.
#[test]
fn plyloft_merges_pending_counts_only_plyloft_s_own_merge_of_an_open_pr() {
    let mut card = shipped_card(SANDBOX_URL);
    apply_status(&mut card, parse_pr_view(PENDING).unwrap(), 1_000, "x").unwrap();
    assert!(!plyloft_merges_pending(&card), "nobody asked Plyloft to merge it");
    card.pr.as_mut().unwrap().plyloft_auto_merge = true;
    assert!(plyloft_merges_pending(&card));
    let mut by_github = card.clone();
    by_github.pr.as_mut().unwrap().auto_merge = true;
    assert!(!plyloft_merges_pending(&by_github), "GitHub merges it");
    let mut archived = card.clone();
    archived.archived = true;
    assert!(!plyloft_merges_pending(&archived));
    let mut shipped = card.clone();
    shipped.ship_status = ShipStatus::Shipped;
    assert!(!plyloft_merges_pending(&shipped));
    let mut merged = card.clone();
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    assert!(!plyloft_merges_pending(&merged));
}

/// 1.172.0 B2: after a sign-in, only the open pull requests whose last read
/// asked for it are read again at once; forgetting their failed reads lets
/// the poller's own next look through as well.
#[test]
fn after_a_sign_in_the_cards_that_asked_for_it_are_read_again() {
    let mut asked = shipped_card(SANDBOX_URL);
    apply_status(&mut asked, parse_pr_view(PENDING).unwrap(), 1_000, "x").unwrap();
    let fine = KanbanCard { id: "c2".into(), ..asked.clone() };
    asked.pr.as_mut().unwrap().sign_in_needed = true;
    let mut archived = KanbanCard { id: "c3".into(), ..asked.clone() };
    archived.archived = true;
    let mut merged = KanbanCard { id: "c4".into(), ..asked.clone() };
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    assert_eq!(signed_out_reads(&[asked.clone(), fine, archived, merged]), vec!["c1".to_string()]);

    let key = "ws-b2-sign-in/c1";
    attempts().lock().unwrap().insert(key.into(), Attempt { at: 5_000, failures: 6 });
    let pr = asked.pr.clone().unwrap();
    let held = attempts().lock().unwrap().get(key).copied().unwrap();
    assert!(!poll_due(&pr, Some(held.at), held.failures, 6_000), "held back by the backoff");
    forget_failures(key);
    assert!(attempts().lock().unwrap().get(key).is_none());
}

/// 1.172.0 B2 (Challenger): every call started a thread of its own; only one
/// runs at a time now — a second call while it runs starts none, and the
/// next after it ends starts again.
#[test]
fn only_one_read_after_a_sign_in_runs_at_a_time() {
    let first = claim_reading_again().expect("nothing runs yet");
    assert!(claim_reading_again().is_none(), "a second while the first runs");
    let moved = std::thread::spawn(move || {
        let _held = first;
        assert!(claim_reading_again().is_none());
    });
    moved.join().unwrap();
    let again = claim_reading_again().expect("free once the thread ended");
    drop(again);
    assert!(claim_reading_again().is_some());
}

/// 1.174.0 C4: a terminal open in the card's folder (a card made from a
/// copy keeps the copy's terminals) keeps its worktree after the merge, as
/// its Builder session does; the cleanup asks `card_folder_terminals`, the
/// terminal part of the delete's `card_worktree_busy`.
#[test]
fn a_terminal_open_in_the_copy_keeps_it_after_the_merge() {
    assert_eq!(after_merge_busy(true, 1, true).as_deref(), Some(KEPT_FOR_SESSION));
    assert_eq!(after_merge_busy(false, 1, true).as_deref(), Some(KEPT_FOR_TERMINAL));
    assert_eq!(after_merge_busy(false, 2, false).as_deref(), Some(KEPT_FOR_TERMINAL));
    assert_eq!(after_merge_busy(false, 0, true).as_deref(), Some("a run is in progress"));
    assert_eq!(after_merge_busy(false, 0, false), None);
    let source = include_str!("pr_status.rs");
    let (_, body) = source.split_once("pub(crate) fn clean_up_card_worktree<").unwrap();
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("crate::commands::card_folder_terminals(app, card)"), "the cleanup counts the folder's terminals");
    let commands = include_str!("commands.rs");
    let (_, busy) = commands.split_once("pub(crate) fn card_worktree_busy<").unwrap();
    assert!(busy[..busy.find("\n}\n").unwrap()].contains("card_folder_terminals(app, card)"), "the same count as the delete's");
}
