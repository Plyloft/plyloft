//! G7 (1.170.0): **Fix failing checks by itself** — follow the card's pull
//! request until its checks on GitHub pass.
//!
//! Owner, 2026-10-26: opt-in (a switch on the card, a default per workspace
//! in Settings, both off by default); only failed checks on GitHub — never a
//! reviewer's request for changes or a conflict, which stay a press (*Fix
//! with the Builder*); at most [`MAX_ATTEMPTS`] tries per pull request; it
//! never answers a prompt in the Builder's session and never starts when that
//! session is closed or busy — it says so instead. It never turns on
//! auto-merge and never merges: it fixes, checks and pushes (*Push update*,
//! the `card_ship` exception), nothing else.
//!
//! This changes the ship loop's rule "the fix is always a press" (SL-2) for
//! a card whose switch is on.
//!
//! The loop runs in the window (`src/lib/prAutoFix.ts` decides each step,
//! `src/store/prAutoFixStore.ts` drives it), because only the window reads
//! the Builder's terminal (idle, a question, a trust prompt). This module
//! keeps the record on the pull request ([`PrAutoFix`], persisted with the
//! card) and its two writes: [`begin`] counts a try for a failing head, once
//! per head, refusing a fourth; [`stop`] records why it stopped, which the
//! Inbox shows (`inbox.rs`, `pr_auto_fix_stopped`). The window decides when
//! to push, but Rust is the gate (1.174.0 B6, CH-3): the push it asks for
//! is `card_pr_push_update` with `auto`, refused unless
//! [`auto_push_refusal`] finds every G7 condition holds.

use serde::{Deserialize, Serialize};

use crate::kanban::KanbanCard;
use crate::pr_status::{PrChecks, PrMergeable, PrState, PrStatus};

/// Owner, 2026-10-26: at most three tries per pull request.
pub const MAX_ATTEMPTS: usize = 3;

/// Why the loop stopped (`AutoFixStop::reason`). Plain strings, so a reason
/// a later build adds loads here as an unknown one instead of failing the
/// board.
pub mod reason {
    /// Three tries and the checks still fail.
    pub const EXHAUSTED: &str = "exhausted";
    /// No Builder session open in Plyloft for the card.
    pub const SESSION_CLOSED: &str = "session_closed";
    /// The Builder was working on something else.
    pub const SESSION_BUSY: &str = "session_busy";
    /// The Builder's session asks something (a question, a permission or
    /// trust prompt, a usage limit): never answered by Plyloft.
    pub const QUESTION: &str = "question";
    /// What failed couldn't be read from GitHub.
    pub const GATHER_FAILED: &str = "gather_failed";
    /// The fix didn't reach the Builder's session.
    pub const NOT_DELIVERED: &str = "not_delivered";
    /// Finish and check found nothing changed.
    pub const NO_CHANGE: &str = "no_change";
    /// Finish and check didn't go through.
    pub const FINISH_FAILED: &str = "finish_failed";
    /// The card's checks failed on this computer.
    pub const VERIFY_FAILED: &str = "verify_failed";
    /// The Challenger asked for changes to the fix.
    pub const CHANGES_REQUESTED: &str = "changes_requested";
    /// Push update didn't push.
    pub const PUSH_REFUSED: &str = "push_refused";
    /// A step waited longer than its bound.
    pub const TIMED_OUT: &str = "timed_out";
    /// G7 fixes (M1): the Builder's session is live but its card isn't
    /// shown in this window, so Plyloft can't read its terminal. Not a stop:
    /// the loop waits and starts once the card is shown.
    pub const NOT_SHOWN: &str = "not_shown";
    /// The plan doesn't cover it (Team needed, or the Team plan is for
    /// another repository).
    pub const PLAN_REQUIRED: &str = "plan_required";
    /// The Team plan is signed in as another account.
    pub const TEAM_ACCOUNT_MISMATCH: &str = "team_account_mismatch";
    /// The plan couldn't be checked.
    pub const LICENCE: &str = "licence";
    /// The plan couldn't be checked: no connection.
    pub const NETWORK: &str = "network";
    /// The Challenger's review of the fix failed or didn't finish (not
    /// approved, not skipped by the person): nothing was pushed.
    pub const REVIEW_FAILED: &str = "review_failed";

    pub const ALL: [&str; 18] = [
        EXHAUSTED,
        SESSION_CLOSED,
        SESSION_BUSY,
        QUESTION,
        GATHER_FAILED,
        NOT_DELIVERED,
        NO_CHANGE,
        FINISH_FAILED,
        VERIFY_FAILED,
        CHANGES_REQUESTED,
        PUSH_REFUSED,
        TIMED_OUT,
        NOT_SHOWN,
        PLAN_REQUIRED,
        TEAM_ACCOUNT_MISMATCH,
        LICENCE,
        NETWORK,
        REVIEW_FAILED,
    ];
}

/// The record on the pull request (`PrStatus::auto_fix`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrAutoFix {
    /// The heads a try started for, oldest first — one try per head, at
    /// most [`MAX_ATTEMPTS`].
    #[serde(default)]
    pub heads: Vec<String>,
    /// Where it stopped, for the head it stopped on. Cleared by a new try,
    /// and (unless the tries ran out) when the person turns the switch on
    /// again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<AutoFixStop>,
    /// 1.174.0 B6 (CH-3): when the latest try began. The automatic push
    /// sends only a fix finished after it ([`auto_push_refusal`]). Absent
    /// on records from before 1.174.0: a try begun then is not pushed by
    /// itself (its next try records the time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoFixStop {
    /// One of [`reason::ALL`].
    pub reason: String,
    /// The pull request's head it stopped on.
    pub head: String,
    pub at: i64,
    /// Plyloft's or git's own words, when there are some (a push refusal).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The card follows its pull request: its own switch, else the workspace's
/// default. Never a card that reviews someone's pull request (Challenger on
/// a pull request): its fixes stay a press.
///
/// `default_since` is when the workspace's default was turned on (`None`:
/// off). G7 fixes (Minor 5): the default covers only failures first seen
/// after it — checks already failing when it was turned on, or failing
/// since before Plyloft kept the time (`PrStatus::failing_since` absent),
/// are the card's own switch's to take on.
pub fn enabled(card: &KanbanCard, default_since: Option<i64>) -> bool {
    if card.pr_review.is_some() {
        return false;
    }
    if let Some(on) = card.pr_auto_fix {
        return on;
    }
    let Some(since) = default_since else {
        return false;
    };
    match card.pr.as_ref() {
        Some(pr) if pr.checks == PrChecks::Failing => pr.failing_since.is_some_and(|at| at >= since),
        _ => true,
    }
}

/// A stop recorded before a try was counted for its head (the session
/// closed, busy, asking, not shown): it clears on its
/// own once the condition clears — the next try's [`begin`] replaces it.
/// Never the tries running out (recorded for a head not tried either).
pub fn soft_stop(record: &PrAutoFix, stop: &AutoFixStop) -> bool {
    stop.reason != reason::EXHAUSTED && !record.heads.iter().any(|h| h == &stop.head)
}

/// The head with failed checks for the loop to fix: the pull request is
/// open, read, its checks on GitHub failed on the head it has now (not a
/// failure still shown for the head before a push), and no conflict — a
/// conflict stays a press.
pub fn failing_head(pr: &PrStatus) -> Option<&str> {
    if pr.state != PrState::Open || pr.checks != PrChecks::Failing || pr.mergeable == PrMergeable::Conflicting {
        return None;
    }
    if pr.awaiting_checks || pr.checked_at.is_none() {
        return None;
    }
    pr.head_sha.as_deref().filter(|h| !h.is_empty())
}

/// What [`begin`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Begin {
    /// Counted: try `attempt` of [`MAX_ATTEMPTS`].
    Started { attempt: u32 },
    /// This head was tried already (one try per head): nothing written.
    AlreadyTried,
    /// No tries left: recorded as stopped ([`reason::EXHAUSTED`]).
    Exhausted,
    /// Not for the loop now — its switch is off, or the pull request isn't
    /// failing at `head` any more. Nothing written.
    NotNow { why: String },
}

/// Count a try for `head`, the pull request's failing head.
pub fn begin(card: &mut KanbanCard, head: &str, enabled: bool, now: i64) -> Begin {
    if !enabled {
        return Begin::NotNow { why: "Fix failing checks by itself is off for this card".into() };
    }
    let Some(pr) = card.pr.as_mut() else {
        return Begin::NotNow { why: "this card has no pull request".into() };
    };
    if failing_head(pr) != Some(head) {
        return Begin::NotNow { why: "the pull request's checks aren't failing on that commit any more".into() };
    }
    let record = pr.auto_fix.get_or_insert_with(PrAutoFix::default);
    if record.heads.iter().any(|h| h == head) {
        return Begin::AlreadyTried;
    }
    if record.heads.len() >= MAX_ATTEMPTS {
        let said = record
            .stopped
            .as_ref()
            .is_some_and(|s| s.reason == reason::EXHAUSTED && s.head == head);
        if !said {
            record.stopped = Some(AutoFixStop { reason: reason::EXHAUSTED.into(), head: head.into(), at: now, detail: None });
        }
        return Begin::Exhausted;
    }
    record.heads.push(head.to_string());
    record.stopped = None;
    record.started_at = Some(now);
    Begin::Started { attempt: record.heads.len() as u32 }
}

/// Words before every refusal of the automatic push.
pub const AUTO_PUSH_REFUSED: &str = "Not pushed by itself";

/// 1.174.0 B6 (CH-3): why the automatic push (`card_pr_push_update` with
/// `auto`) must not send this card's fix, or `None` when every G7 condition
/// holds (AGENTS.md, Product boundaries): the card's switch is on and it
/// doesn't review a pull request; its pull request's checks fail on the head
/// it has now and a try was begun for exactly that head, within
/// [`MAX_ATTEMPTS`] and not stopped; the fix is the card's latest snapshot,
/// finished after that try began; and the Challenger approved that snapshot,
/// or the person skipped its review. Verify passing on the commit pushed is
/// the push's own gate (Ship's verified-commit rule), which an automatic
/// push never starts; the branch and never forcing are the push's too.
pub fn auto_push_refusal(card: &KanbanCard, default_since: Option<i64>) -> Option<String> {
    let refuse = |why: &str| Some(format!("{AUTO_PUSH_REFUSED}: {why}."));
    if card.pr_review.is_some() {
        return refuse("a card that reviews a pull request is never fixed by itself");
    }
    if !enabled(card, default_since) {
        return refuse("Fix failing checks by itself is off for this card");
    }
    let Some(pr) = card.pr.as_ref() else {
        return refuse("this card has no pull request");
    };
    let Some(head) = failing_head(pr) else {
        return refuse("the pull request's checks aren't failing on the commit it has now");
    };
    let Some(record) = pr.auto_fix.as_ref() else {
        return refuse("no try was started for this pull request");
    };
    if record.heads.last().map(String::as_str) != Some(head) {
        return refuse("no try was started for the commit the pull request has now");
    }
    if record.heads.len() > MAX_ATTEMPTS {
        return refuse("it already tried three times");
    }
    if record.stopped.as_ref().is_some_and(|s| s.head == head) {
        return refuse("this try has stopped");
    }
    let Some(started_at) = record.started_at else {
        return refuse("this try began in an earlier version of Plyloft");
    };
    let builder = card.builder.as_ref();
    let Some(snapshot) = builder.and_then(|b| b.snapshots.last()) else {
        return refuse("the Builder hasn't finished a fix");
    };
    if snapshot.at < started_at {
        return refuse("the Builder hasn't finished a fix since this try started");
    }
    let approved = builder.and_then(|b| b.review.as_ref()).is_some_and(|r| {
        r.snapshot_n == snapshot.n
            && ((r.status == "done" && r.verdict.as_deref() == Some("approve")) || r.status == "skipped")
    });
    if !approved {
        return refuse("the Reviewer hasn't approved this fix, and its review wasn't skipped");
    }
    None
}

/// Record that the loop stopped on `head`. Refused for a reason this build
/// doesn't know; nothing written when the card's pull request has moved on
/// from `head` (the stop is about a commit it no longer shows). Returns
/// whether it wrote.
pub fn stop(card: &mut KanbanCard, head: &str, why: &str, detail: Option<String>, now: i64) -> Result<bool, String> {
    if !reason::ALL.contains(&why) {
        return Err(format!("unknown reason {why:?}"));
    }
    let Some(pr) = card.pr.as_mut() else {
        return Err("this card has no pull request".into());
    };
    if pr.head_sha.as_deref() != Some(head) {
        return Ok(false);
    }
    // git's or GitHub's words go on the board: tokens masked, kept short.
    let detail = detail
        .map(|d| crate::pr_fix::mask_tokens(d.trim()).chars().take(600).collect::<String>())
        .filter(|d| !d.is_empty());
    let record = pr.auto_fix.get_or_insert_with(PrAutoFix::default);
    record.stopped = Some(AutoFixStop { reason: why.into(), head: head.into(), at: now, detail });
    Ok(true)
}

/// The person turned the card's switch: on again clears a stop it can try
/// past (not the tries running out); off clears a stop recorded before a
/// try (it was about a loop that no longer runs).
pub fn set_switch(card: &mut KanbanCard, on: bool) {
    card.pr_auto_fix = Some(on);
    if let Some(record) = card.pr.as_mut().and_then(|p| p.auto_fix.as_mut()) {
        let clear = record.stopped.as_ref().is_some_and(|s| {
            if on {
                s.reason != reason::EXHAUSTED
            } else {
                soft_stop(record, s)
            }
        });
        if clear {
            record.stopped = None;
        }
    }
}

/// The stop the Inbox shows: the pull request is open and still at the head
/// it stopped on (a new head — the person's push, a fix — retires it). A
/// stop from before a try ([`soft_stop`]) shows only while that head's
/// checks still fail.
pub fn stopped_now(pr: &PrStatus) -> Option<&AutoFixStop> {
    if pr.state != PrState::Open {
        return None;
    }
    let record = pr.auto_fix.as_ref()?;
    let stop = record.stopped.as_ref()?;
    if pr.head_sha.as_deref() != Some(stop.head.as_str()) {
        return None;
    }
    if soft_stop(record, stop) && failing_head(pr) != Some(stop.head.as_str()) {
        return None;
    }
    Some(stop)
}

#[cfg(test)]
#[path = "pr_auto_fix_tests.rs"]
mod tests;
