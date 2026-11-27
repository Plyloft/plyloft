//! G7 tests: the try counter, the stops, the Inbox row and the migration.

use super::*;
use crate::kanban::KanbanColumnId;

const URL: &str = "https://github.com/test-owner/plyloft-ci-sandbox/pull/4";

fn failing(head: &str) -> PrStatus {
    PrStatus {
        number: 4,
        state: PrState::Open,
        checks: PrChecks::Failing,
        checks_total: 1,
        head_sha: Some(head.into()),
        checked_at: Some(10),
        ..Default::default()
    }
}

fn card_with(pr: PrStatus) -> KanbanCard {
    let mut card = KanbanCard::new("c1".into(), "ws".into(), "Add sum".into(), None, KanbanColumnId::InProgress);
    card.pr_url = Some(URL.into());
    card.review_status = Some(crate::kanban::ReviewStatus::Merged);
    card.pr = Some(pr);
    card
}

fn heads(card: &KanbanCard) -> Vec<String> {
    card.pr.as_ref().and_then(|p| p.auto_fix.as_ref()).map(|a| a.heads.clone()).unwrap_or_default()
}

fn stopped(card: &KanbanCard) -> Option<AutoFixStop> {
    card.pr.as_ref().and_then(|p| p.auto_fix.as_ref()).and_then(|a| a.stopped.clone())
}

fn new_head(card: &mut KanbanCard, head: &str) {
    let pr = card.pr.as_mut().unwrap();
    pr.head_sha = Some(head.into());
}

#[test]
fn off_by_default_and_the_card_switch_wins_over_the_workspace() {
    let mut pr = failing("h1");
    pr.failing_since = Some(100);
    let mut card = card_with(pr);
    assert!(!enabled(&card, None), "off by default");
    assert!(enabled(&card, Some(50)), "the workspace's default");
    card.pr_auto_fix = Some(false);
    assert!(!enabled(&card, Some(50)), "the card turned it off");
    card.pr_auto_fix = Some(true);
    assert!(enabled(&card, None), "the card turned it on");
}

/// G7 fixes (Minor 5): the workspace's default covers only failures first
/// seen after it was turned on; the card's own switch covers any.
#[test]
fn the_default_covers_only_failures_first_seen_after_it_was_turned_on() {
    let mut pr = failing("h1");
    pr.failing_since = Some(100);
    let mut card = card_with(pr);
    assert!(enabled(&card, Some(100)), "seen failing as it was turned on");
    assert!(!enabled(&card, Some(101)), "already failing when it was turned on");
    card.pr.as_mut().unwrap().failing_since = None;
    assert!(!enabled(&card, Some(0)));
    card.pr_auto_fix = Some(true);
    assert!(enabled(&card, Some(101)), "the card's own switch takes any failure");
    card.pr_auto_fix = None;
    card.pr.as_mut().unwrap().checks = PrChecks::Passing;
    assert!(enabled(&card, Some(101)), "passing: on for the next failure");

    // The time is kept while the same head still fails, and starts over on
    // a new head or a new failure after checks ran again.
    let mut prev = failing("h1");
    prev.failing_since = Some(100);
    let same = failing("h1");
    assert_eq!(crate::pr_status::failing_since(&prev, &same, 300), Some(100));
    prev.failing_since = None;
    assert_eq!(crate::pr_status::failing_since(&prev, &same, 300), None, "an old failure stays old");
    assert_eq!(crate::pr_status::failing_since(&prev, &failing("h2"), 300), Some(300), "a new head");
    let mut pending = failing("h1");
    pending.checks = PrChecks::Pending;
    assert_eq!(crate::pr_status::failing_since(&pending, &same, 400), Some(400), "failing again after a run");
    assert_eq!(crate::pr_status::failing_since(&same, &pending, 400), None);

    // Through a read of GitHub.
    let mut card = card_with(pending);
    crate::pr_status::apply_status(&mut card, failing("h1"), 500, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().failing_since, Some(500));
    crate::pr_status::apply_status(&mut card, failing("h1"), 600, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().failing_since, Some(500));
}

#[test]
fn never_on_a_card_that_reviews_a_pull_request() {
    let mut card = card_with(failing("h1"));
    card.pr_auto_fix = Some(true);
    card.pr_review = Some(serde_json::from_value(serde_json::json!({
        "url": URL, "number": 4, "repo": "o/r", "headRef": "feature", "baseRef": "main",
        "headSha": "h1", "state": "open"
    }))
    .unwrap());
    assert!(!enabled(&card, Some(0)));
    let on = enabled(&card, Some(0));
    assert!(matches!(begin(&mut card, "h1", on, 1), Begin::NotNow { .. }));
    assert!(heads(&card).is_empty());
}

#[test]
fn only_failed_checks_on_the_head_it_has_now() {
    let mut pr = failing("h1");
    assert_eq!(failing_head(&pr), Some("h1"));
    pr.mergeable = PrMergeable::Conflicting;
    assert_eq!(failing_head(&pr), None, "a conflict stays a press");
    pr.mergeable = PrMergeable::Mergeable;
    pr.awaiting_checks = true;
    assert_eq!(failing_head(&pr), None, "just pushed: the failure is the old head's");
    pr.awaiting_checks = false;
    pr.checks = PrChecks::Passing;
    assert_eq!(failing_head(&pr), None);
    pr.checks = PrChecks::Failing;
    pr.state = PrState::Merged;
    assert_eq!(failing_head(&pr), None);
    // A reviewer's request for changes alone is never the loop's.
    let mut review_only = failing("h1");
    review_only.checks = PrChecks::Passing;
    review_only.review_decision = crate::pr_status::PrReviewDecision::ChangesRequested;
    assert_eq!(failing_head(&review_only), None);
}

#[test]
fn one_try_per_head_and_three_at_most() {
    let mut card = card_with(failing("h1"));
    assert_eq!(begin(&mut card, "h1", true, 1), Begin::Started { attempt: 1 });
    assert_eq!(begin(&mut card, "h1", true, 2), Begin::AlreadyTried, "the same head again");
    new_head(&mut card, "h2");
    assert_eq!(begin(&mut card, "h2", true, 3), Begin::Started { attempt: 2 });
    new_head(&mut card, "h3");
    assert_eq!(begin(&mut card, "h3", true, 4), Begin::Started { attempt: 3 });
    new_head(&mut card, "h4");
    assert_eq!(begin(&mut card, "h4", true, 5), Begin::Exhausted);
    assert_eq!(heads(&card), vec!["h1", "h2", "h3"]);
    let stop = stopped(&card).unwrap();
    assert_eq!((stop.reason.as_str(), stop.head.as_str(), stop.at), (reason::EXHAUSTED, "h4", 5));
    // Said once: a later read of the same head keeps the first stop.
    assert_eq!(begin(&mut card, "h4", true, 9), Begin::Exhausted);
    assert_eq!(stopped(&card).unwrap().at, 5);
}

#[test]
fn a_head_that_moved_on_or_passing_checks_start_nothing() {
    let mut card = card_with(failing("h1"));
    assert!(matches!(begin(&mut card, "h0", true, 1), Begin::NotNow { .. }));
    assert!(matches!(begin(&mut card, "h1", false, 1), Begin::NotNow { .. }), "switch off");
    card.pr.as_mut().unwrap().checks = PrChecks::Passing;
    assert!(matches!(begin(&mut card, "h1", true, 1), Begin::NotNow { .. }));
    assert!(card.pr.as_ref().unwrap().auto_fix.is_none(), "nothing written");
}

#[test]
fn a_stop_is_kept_for_its_head_and_a_new_try_clears_it() {
    let mut card = card_with(failing("h1"));
    assert_eq!(begin(&mut card, "h1", true, 1), Begin::Started { attempt: 1 });
    assert!(stop(&mut card, "h1", reason::PUSH_REFUSED, Some("  Not pushed: moved on  ".into()), 2).unwrap());
    let s = stopped(&card).unwrap();
    assert_eq!((s.reason.as_str(), s.detail.as_deref()), (reason::PUSH_REFUSED, Some("Not pushed: moved on")));
    assert!(stopped_now(card.pr.as_ref().unwrap()).is_some());
    // A token in git's words never reaches the board.
    stop(&mut card, "h1", reason::PUSH_REFUSED, Some("remote: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA denied".into()), 2).unwrap();
    assert!(!stopped(&card).unwrap().detail.unwrap().contains("ghp_AAAA"));
    stop(&mut card, "h1", reason::PUSH_REFUSED, Some("  Not pushed: moved on  ".into()), 2).unwrap();
    // Unknown reasons are refused; a stop for a head GitHub no longer has is
    // not written.
    assert!(stop(&mut card, "h1", "made_up", None, 3).is_err());
    assert!(!stop(&mut card, "h0", reason::SESSION_BUSY, None, 3).unwrap());
    assert_eq!(stopped(&card).unwrap().reason, reason::PUSH_REFUSED);
    // A new head retires the row; a try on it clears the stop.
    new_head(&mut card, "h2");
    assert!(stopped_now(card.pr.as_ref().unwrap()).is_none());
    assert_eq!(begin(&mut card, "h2", true, 4), Begin::Started { attempt: 2 });
    assert_eq!(stopped(&card), None);
}

#[test]
fn turning_the_switch_on_again_clears_a_stop_but_not_running_out() {
    let mut card = card_with(failing("h1"));
    begin(&mut card, "h1", true, 1);
    stop(&mut card, "h1", reason::SESSION_CLOSED, None, 1).unwrap();
    set_switch(&mut card, false);
    assert_eq!(card.pr_auto_fix, Some(false));
    assert!(stopped(&card).is_some(), "off keeps the record of a try");
    set_switch(&mut card, true);
    assert_eq!(card.pr_auto_fix, Some(true));
    assert_eq!(stopped(&card), None, "on again: it may try this head");

    for h in ["h1", "h2", "h3"] {
        new_head(&mut card, h);
        begin(&mut card, h, true, 1);
    }
    new_head(&mut card, "h4");
    assert_eq!(begin(&mut card, "h4", true, 2), Begin::Exhausted);
    set_switch(&mut card, true);
    assert_eq!(stopped(&card).unwrap().reason, reason::EXHAUSTED, "three tries stay three");
}

/// G7 fixes (M1): a stop recorded before a try (no try counted for its
/// head) clears on its own: the next try replaces it, the Inbox shows it
/// only while that head still fails, and turning the switch off clears it.
#[test]
fn a_stop_before_a_try_clears_on_its_own() {
    let mut card = card_with(failing("h1"));
    stop(&mut card, "h1", reason::NOT_SHOWN, None, 1).unwrap();
    let record = card.pr.as_ref().unwrap().auto_fix.clone().unwrap();
    assert!(soft_stop(&record, record.stopped.as_ref().unwrap()));
    assert!(stopped_now(card.pr.as_ref().unwrap()).is_some());
    card.pr.as_mut().unwrap().checks = PrChecks::Pending;
    assert!(stopped_now(card.pr.as_ref().unwrap()).is_none(), "checks running again on the same head");
    card.pr.as_mut().unwrap().checks = PrChecks::Failing;
    assert_eq!(begin(&mut card, "h1", true, 2), Begin::Started { attempt: 1 }, "it doesn't use a try");
    assert_eq!(stopped(&card), None);

    let mut card = card_with(failing("h1"));
    stop(&mut card, "h1", reason::SESSION_BUSY, None, 1).unwrap();
    set_switch(&mut card, false);
    assert_eq!(stopped(&card), None, "off: the wait is over");
    for r in reason::ALL {
        let mut c = card_with(failing("h1"));
        assert!(stop(&mut c, "h1", r, None, 1).unwrap(), "{r}");
    }
}

#[test]
fn a_read_of_github_keeps_the_record() {
    let mut card = card_with(failing("h1"));
    begin(&mut card, "h1", true, 1);
    stop(&mut card, "h1", reason::VERIFY_FAILED, None, 2).unwrap();
    let mut next = failing("h1");
    next.checked_at = None;
    crate::pr_status::apply_status(&mut card, next, 50, "x").unwrap();
    assert_eq!(heads(&card), vec!["h1"]);
    assert_eq!(stopped(&card).unwrap().reason, reason::VERIFY_FAILED);
}

#[test]
fn the_inbox_row_follows_the_stop() {
    use crate::inbox::{InboxEventKind as K, InboxGroup};
    let mut card = card_with(failing("h1"));
    let rows = |card: &KanbanCard| crate::inbox::derive_card_events("Sandbox", std::slice::from_ref(card), 0);
    assert!(!rows(&card).iter().any(|e| e.kind == K::PrAutoFixStopped));
    stop(&mut card, "h1", reason::SESSION_CLOSED, None, 7).unwrap();
    let row = rows(&card).into_iter().find(|e| e.kind == K::PrAutoFixStopped).expect("a row");
    // 1.173.0 (F1): a Needs you row (Failed folded in); its reason tells
    // the Inbox it is a failure (`inboxView.ts::isFailureRow`).
    assert_eq!(row.group, InboxGroup::NeedsYou);
    assert_eq!(row.detail.as_deref(), Some(reason::SESSION_CLOSED));
    assert_eq!(row.id, "pr-autofix:c1:4:h1:session_closed");
    assert_eq!(row.at, Some(7));
    assert_eq!(row.url.as_deref(), Some(URL));
    // A new head (the person pushed) retires it.
    new_head(&mut card, "h2");
    assert!(!rows(&card).iter().any(|e| e.kind == K::PrAutoFixStopped));
    // G7 fixes (M1): a live Builder whose card isn't shown is a wait for
    // the person, not a failure.
    stop(&mut card, "h2", reason::NOT_SHOWN, None, 8).unwrap();
    let row = rows(&card).into_iter().find(|e| e.kind == K::PrAutoFixStopped).expect("a row");
    assert_eq!(row.group, InboxGroup::NeedsYou);
    assert_eq!(row.detail.as_deref(), Some(reason::NOT_SHOWN));
}

/// Migration: a card and a pull request written before G7 load unchanged —
/// no switch (the workspace's default), no record — and save without the
/// keys; a record round-trips; an unknown later reason still loads.
#[test]
fn a_card_from_before_g7_loads_unchanged() {
    let old = r#"{"id":"c1","workspaceId":"w","title":"t","columnId":"in_progress","createdAt":1,"updatedAt":5,
        "prUrl":"https://github.com/o/r/pull/4","reviewStatus":"merged",
        "pr":{"number":4,"state":"open","checks":"failing","headSha":"h","checkedAt":5}}"#;
    let card: KanbanCard = serde_json::from_str(old).unwrap();
    assert_eq!(card.pr_auto_fix, None);
    assert_eq!(card.pr.as_ref().unwrap().auto_fix, None);
    assert_eq!(card.updated_at, 5);
    let back = serde_json::to_value(&card).unwrap();
    assert!(back.get("prAutoFix").is_none(), "{back}");
    assert!(back["pr"].get("autoFix").is_none(), "{back}");
    assert!(back["pr"].get("failingSince").is_none(), "{back}");
    assert_eq!(card.pr.as_ref().unwrap().failing_since, None, "an old failure: no time kept");

    let mut card = card;
    set_switch(&mut card, true);
    begin(&mut card, "h", true, 9);
    stop(&mut card, "h", reason::QUESTION, None, 10).unwrap();
    let json = serde_json::to_value(&card).unwrap();
    assert_eq!(json["prAutoFix"], true);
    assert_eq!(json["pr"]["autoFix"]["heads"], serde_json::json!(["h"]));
    assert_eq!(json["pr"]["autoFix"]["stopped"]["reason"], "question");
    let again: KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(again.pr_auto_fix, Some(true));
    assert_eq!(again.pr.unwrap().auto_fix, card.pr.unwrap().auto_fix);

    let later: PrAutoFix =
        serde_json::from_str(r#"{"heads":["a"],"stopped":{"reason":"from_a_later_build","head":"a","at":1},"more":1}"#)
            .unwrap();
    assert_eq!(later.stopped.unwrap().reason, "from_a_later_build");
}

/// G7 fixes: every reason this build records has its own words in the
/// window (`prAutoFix.ts::autoFixStoppedWords`) and its type there.
#[test]
fn the_window_words_every_reason() {
    let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/prAutoFix.ts")).unwrap();
    let ipc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc.ts")).unwrap();
    for r in reason::ALL {
        assert!(ts.contains(&format!("case \"{r}\":")), "{r} has no words in prAutoFix.ts");
        assert!(ipc.contains(&format!("| \"{r}\"")), "{r} is not in PrAutoFixStopReason");
    }
}

/// CH-4 (1.174.0): the TS state machine counts the same tries
/// (`src/lib/prAutoFix.ts::AUTO_FIX_MAX_ATTEMPTS`).
#[test]
fn the_ts_side_counts_the_same_tries() {
    let ts = include_str!("../../src/lib/prAutoFix.ts");
    assert!(ts.contains(&format!("export const AUTO_FIX_MAX_ATTEMPTS = {MAX_ATTEMPTS};")), "AUTO_FIX_MAX_ATTEMPTS = {MAX_ATTEMPTS}");
}

// ── 1.174.0 B6 (CH-3): the automatic push is decided here ─────────────

/// A card whose try for `h1` began at 100, with snapshot 2 finished at 200
/// and the Challenger's approval of it: everything G7 asks for.
fn ready_to_push() -> KanbanCard {
    let mut card = card_with(failing("h1"));
    card.pr_auto_fix = Some(true);
    assert_eq!(begin(&mut card, "h1", true, 100), Begin::Started { attempt: 1 });
    card.builder = Some(
        serde_json::from_value(serde_json::json!({
            "vendor": "claude",
            "challengedAt": 0,
            "brief": "",
            "snapshots": [{ "n": 1, "sha": "s1", "at": 50 }, { "n": 2, "sha": "s2", "at": 200 }],
            "review": { "snapshotN": 2, "provider": "codex", "status": "done", "verdict": "approve", "at": 210 }
        }))
        .unwrap(),
    );
    card
}

fn refusal(card: &KanbanCard) -> String {
    auto_push_refusal(card, None).expect("refused")
}

#[test]
fn the_automatic_push_goes_only_when_every_g7_condition_holds() {
    let card = ready_to_push();
    assert_eq!(auto_push_refusal(&card, None), None);
    // The person skipped the review of the fix: that counts as approved.
    let mut skipped = ready_to_push();
    let review = skipped.builder.as_mut().unwrap().review.as_mut().unwrap();
    review.status = "skipped".into();
    review.verdict = None;
    assert_eq!(auto_push_refusal(&skipped, None), None);
    // The workspace's default covers it as the loop's start does.
    let mut by_default = ready_to_push();
    by_default.pr_auto_fix = None;
    by_default.pr.as_mut().unwrap().failing_since = Some(5);
    assert_eq!(auto_push_refusal(&by_default, Some(0)), None);
    assert!(auto_push_refusal(&by_default, Some(6)).unwrap().contains("is off"), "a failure from before the default");
    assert!(refusal(&by_default).contains("is off"));
}

#[test]
fn never_on_a_card_that_reviews_a_pull_request_nor_with_the_switch_off() {
    let mut card = ready_to_push();
    card.pr_review = Some(
        serde_json::from_value(serde_json::json!({
            "url": URL, "number": 4, "repo": "o/r", "headRef": "feature", "baseRef": "main",
            "headSha": "h1", "state": "open"
        }))
        .unwrap(),
    );
    let why = refusal(&card);
    assert!(why.starts_with(AUTO_PUSH_REFUSED) && why.contains("reviews a pull request"), "{why}");
    let mut off = ready_to_push();
    off.pr_auto_fix = Some(false);
    assert!(refusal(&off).contains("Fix failing checks by itself is off"));
}

#[test]
fn only_for_the_failing_head_a_try_was_begun_for() {
    let mut none = ready_to_push();
    none.pr = None;
    assert!(refusal(&none).contains("no pull request"));
    // Checks passing now, or on another head than the try's.
    let mut passing = ready_to_push();
    passing.pr.as_mut().unwrap().checks = PrChecks::Passing;
    assert!(refusal(&passing).contains("aren't failing"));
    let mut moved = ready_to_push();
    new_head(&mut moved, "h2");
    assert!(refusal(&moved).contains("commit the pull request has now"), "{}", refusal(&moved));
    // A head nobody began a try for.
    let mut untried = ready_to_push();
    untried.pr.as_mut().unwrap().auto_fix = None;
    assert!(refusal(&untried).contains("no try was started"));
}

#[test]
fn not_past_three_tries_nor_after_the_try_stopped() {
    let mut card = ready_to_push();
    card.pr.as_mut().unwrap().auto_fix.as_mut().unwrap().heads = vec!["a".into(), "b".into(), "c".into(), "h1".into()];
    assert!(refusal(&card).contains("three times"));
    let mut stopped_card = ready_to_push();
    stop(&mut stopped_card, "h1", reason::TIMED_OUT, None, 300).unwrap();
    assert!(refusal(&stopped_card).contains("stopped"));
}

#[test]
fn only_a_fix_finished_since_the_try_began_and_approved() {
    // No time kept (a try begun before 1.174.0): not pushed by itself.
    let mut old = ready_to_push();
    old.pr.as_mut().unwrap().auto_fix.as_mut().unwrap().started_at = None;
    assert!(refusal(&old).contains("began in an earlier version of Plyloft"));
    let mut no_fix = ready_to_push();
    no_fix.builder = None;
    assert!(refusal(&no_fix).contains("hasn't finished a fix"));
    let mut stale = ready_to_push();
    stale.builder.as_mut().unwrap().snapshots.pop();
    assert!(refusal(&stale).contains("since this try started"));
    for (status, verdict) in [("done", Some("changes_requested")), ("done", Some("incomplete")), ("running", None), ("failed", None)] {
        let mut card = ready_to_push();
        let review = card.builder.as_mut().unwrap().review.as_mut().unwrap();
        review.status = status.into();
        review.verdict = verdict.map(str::to_string);
        assert!(refusal(&card).contains("hasn't approved"), "{status} {verdict:?}");
    }
    // An approval of an earlier snapshot doesn't count.
    let mut earlier = ready_to_push();
    earlier.builder.as_mut().unwrap().review.as_mut().unwrap().snapshot_n = 1;
    assert!(refusal(&earlier).contains("hasn't approved"));
    let mut unreviewed = ready_to_push();
    unreviewed.builder.as_mut().unwrap().review = None;
    assert!(refusal(&unreviewed).contains("hasn't approved"));
}

/// The command sends an automatic push through `push_update_auto`, with
/// the verified commit read by `ship_decision` (never `ship_tree_gate`,
/// which may enqueue Verify); the person's press stays `push_update`.
#[test]
fn the_command_gates_the_automatic_push_before_it_pushes() {
    // 1.174.0 X1: the command moved to `card_pr_commands.rs`.
    let commands = include_str!("card_pr_commands.rs");
    let body = &commands[commands.find("fn card_pr_push_update_blocking(").unwrap()..];
    let body = &body[..body.find("\nfn ").unwrap_or(body.len())];
    let auto = body.find("crate::pr_fix::push_update_auto(&env, card, default_since,").expect("the G7 gate");
    let tail = &body[auto..];
    assert!(tail[..400].contains("ship_decision(c, &wt, in_flight)"), "{}", &tail[..400]);
    assert!(body.contains("crate::pr_fix::push_update(&env, card)?"), "the press");
    assert!(commands.contains("pub async fn card_pr_push_update(\n    app: tauri::AppHandle,\n    workspace_id: String,\n    card_id: String,\n    auto: Option<bool>,"));
}

/// 1.174.0 B6: a record from before `startedAt` loads with `None`, keeps its
/// heads and stop, and saves without the key; a new try writes it.
#[test]
fn pre_v1174_auto_fix_record_loads_without_started_at() {
    let old = r#"{"id":"c1","workspaceId":"w","title":"t","columnId":"in_progress","createdAt":1,"updatedAt":5,
        "prUrl":"https://github.com/o/r/pull/4","reviewStatus":"merged","prAutoFix":true,
        "pr":{"number":4,"state":"open","checks":"failing","headSha":"h2","checkedAt":5,
              "autoFix":{"heads":["h1"],"stopped":{"reason":"question","head":"h1","at":3}}}}"#;
    let mut card: KanbanCard = serde_json::from_str(old).unwrap();
    let record = card.pr.as_ref().unwrap().auto_fix.clone().unwrap();
    assert_eq!(record.heads, vec!["h1"]);
    assert_eq!(record.stopped.as_ref().unwrap().reason, "question");
    assert_eq!(record.started_at, None);
    let back = serde_json::to_value(&card).unwrap();
    assert!(back["pr"]["autoFix"].get("startedAt").is_none(), "{back}");
    assert_eq!(begin(&mut card, "h2", true, 77), Begin::Started { attempt: 2 });
    let json = serde_json::to_value(&card).unwrap();
    assert_eq!(json["pr"]["autoFix"]["startedAt"], 77);
    let again: KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(again.pr.unwrap().auto_fix.unwrap().started_at, Some(77));
}
