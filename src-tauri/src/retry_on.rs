//! 1.169.0 (A3): "Retry on…" — a finished or failed Builder or Challenger
//! round run again **once** on another model and effort, chosen there and
//! then. The card's own models (`KanbanCard::models`) never change for it.
//!
//! The choice travels as an explicit argument of the round's own start —
//! `builder_start`'s `retry` (a new session on the work already in the
//! card's copy, nothing reset; owner, 2026-10-23) and
//! `builder_review_retry` (the Challenger reviews the same snapshot again,
//! even after a verdict; the new verdict replaces the previous one, and both
//! rounds stay in History). Nothing is held anywhere else, so no other start
//! can pick it up. A retry is recorded on the card (`KanbanCard::
//! model_retries`) only once its session or review has actually started,
//! with the attempt it retried (its model and outcome); a Builder retry's
//! own outcome is filled in when its session ends. Never automatic.

use serde::Deserialize;

use crate::settings::{AgentRole, ModelChoice};

/// A retry's choice, as the menu sends it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RetryArg {
    pub model: Option<String>,
    pub reasoning: Option<String>,
}

impl RetryArg {
    pub fn choice(&self) -> ModelChoice {
        ModelChoice { model: crate::settings::cleaned(&self.model), reasoning: crate::settings::cleaned(&self.reasoning) }
    }
}

/// A Challenger retry as its job carries it: the vendor the menu showed, and
/// the choice. A review that runs on another vendor drops it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRetry {
    pub vendor: String,
    pub choice: ModelChoice,
}

/// Emitted when a Challenger retry's choice was dropped because the review
/// ran on another vendor than the menu's.
pub const EVENT_DROPPED: &str = "retry-on://dropped";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    pub workspace_id: String,
    pub card_id: String,
    /// The card's title, for the toast.
    pub title: String,
    /// The vendor that reviewed instead.
    pub vendor: String,
}

fn role_word(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Builder => "builder",
        AgentRole::Challenger => "challenger",
    }
}

/// How a Builder attempt ended, in a word, for History.
pub fn builder_outcome(b: &crate::kanban::BuilderState, last_run: Option<&crate::kanban::LastRunStatus>) -> String {
    use crate::kanban::LastRunStatus;
    if b.resume_failed {
        return "failed".into();
    }
    match last_run {
        Some(LastRunStatus::Failed) => "failed".into(),
        Some(LastRunStatus::Success) => "finished".into(),
        _ if b.session_lost => "ended".into(),
        _ => "stopped".into(),
    }
}

/// A review's outcome in a word: its verdict, or how it ended.
pub fn review_outcome(r: &crate::kanban::BuilderReview) -> String {
    match (r.status.as_str(), r.verdict.as_deref()) {
        ("done", Some(v)) => v.to_string(),
        (status, _) => status.to_string(),
    }
}

/// Record a retry that has started, bounded.
#[allow(clippy::too_many_arguments)]
pub fn record(
    card: &mut crate::kanban::KanbanCard,
    role: AgentRole,
    vendor: &str,
    from_started_at: Option<i64>,
    from_model: Option<String>,
    from_outcome: Option<String>,
    choice: &ModelChoice,
    at: i64,
) {
    card.model_retries.push(crate::kanban::ModelRetry {
        role: role_word(role).to_string(),
        vendor: vendor.to_string(),
        at,
        from_started_at,
        from_model,
        from_outcome,
        model: choice.label_for(vendor),
        outcome: None,
    });
    if card.model_retries.len() > crate::kanban::MODEL_RETRIES_MAX {
        let drop = card.model_retries.len() - crate::kanban::MODEL_RETRIES_MAX;
        card.model_retries.drain(0..drop);
    }
}

/// A Builder retry's own outcome, once its session is over: the newest
/// Builder retry still without one, when it is this session's (started at
/// `started_at`).
pub fn settle_builder_retry(card: &mut crate::kanban::KanbanCard, started_at: i64) {
    let last_run = card.last_run_status.clone();
    let outcome = card.builder.as_ref().map(|b| builder_outcome(b, last_run.as_ref()));
    if let Some(r) = card
        .model_retries
        .iter_mut()
        .rev()
        .find(|r| r.role == "builder" && r.outcome.is_none() && r.at == started_at)
    {
        r.outcome = outcome;
    }
}

/// A Challenger retry's own outcome, once its review has settled: the
/// newest one still without one (one review runs per card at a time).
pub fn settle_review_retry(card: &mut crate::kanban::KanbanCard) {
    let outcome = card.builder.as_ref().and_then(|b| b.review.as_ref()).map(review_outcome);
    if let Some(r) = card.model_retries.iter_mut().rev().find(|r| r.role == "challenger" && r.outcome.is_none()) {
        r.outcome = outcome;
    }
}

/// Whether the round of `role` can be retried now (owner, 2026-10-23):
/// - the Builder: a session that ran — it started — and is over: closed,
///   ended on its own while the app ran (a crash, `/exit`, a kill), or a
///   resume that failed; with real work to retry on — a build snapshot, or
///   changes in the card's copy (`copy_has_changes`). Never a session lost
///   because Plyloft quit or restarted (`lost_on_restart`: Resume's), never a
///   record no session ran in, never while built by both;
/// - the Challenger: its latest review has settled (not running or
///   queued), and it reviewed the latest snapshot;
/// - never on an archived card, nor (for now) on a pull request's card.
///
/// The mirror of `retryOn.ts::retryOffered`, which can't see the copy's
/// changes and offers a started session without a snapshot; this refuses it
/// when the copy has none. Both are held to `src/lib/retryOn.fixtures.json`
/// (CH-4).
pub fn retryable(card: &crate::kanban::KanbanCard, role: AgentRole, copy_has_changes: bool) -> Result<(), String> {
    if card.archived {
        return Err("An archived card has no round to retry.".into());
    }
    if card.pr_review.is_some() {
        return Err("Retry on… isn't offered on a pull request's card.".into());
    }
    let Some(builder) = card.builder.as_ref() else {
        return Err("This card has no round to retry yet.".into());
    };
    match role {
        AgentRole::Builder => {
            if builder.pty_id.is_some() {
                return Err("The Builder is still working; retry once its session has ended.".into());
            }
            if builder.started_at <= 0 {
                return Err("The Builder hasn't worked on this card yet.".into());
            }
            if builder.lost_on_restart {
                return Err("This session was lost when Plyloft restarted; Resume picks it up where it was.".into());
            }
            if builder.snapshots.is_empty() && !copy_has_changes {
                return Err("The Builder left no work in the card's copy to retry on.".into());
            }
            if crate::build_both::is_undecided(card) {
                return Err("Retry on… isn't offered while the card is built by both.".into());
            }
            Ok(())
        }
        AgentRole::Challenger => {
            let Some(review) = builder.review.as_ref() else {
                return Err("The Reviewer hasn't reviewed this card yet.".into());
            };
            if matches!(review.status.as_str(), "running" | "queued") {
                return Err("The Reviewer is still reviewing; retry once it has finished.".into());
            }
            if builder.snapshots.last().is_some_and(|s| s.n > review.snapshot_n) {
                return Err("The latest work hasn't been reviewed yet; Finish and check reviews it first.".into());
            }
            Ok(())
        }
    }
}

/// A review that starts without a retry's choice (a plain review, or one
/// Plyloft restarted after a quit) ends any Challenger retry still open: it
/// was interrupted.
pub fn interrupt_open_review_retries(card: &mut crate::kanban::KanbanCard) {
    for r in card.model_retries.iter_mut().filter(|r| r.role == "challenger" && r.outcome.is_none()) {
        r.outcome = Some("interrupted".into());
    }
}

/// The vendor the Challenger is planned to review with, as `review_snapshot`
/// decides it before its eligibility check: a pull request's chosen
/// Challenger, else the other vendor of the Builder's, else (not installed)
/// the Builder's own. What the menu offers models for.
pub fn planned_challenger(card: &crate::kanban::KanbanCard, installed: impl Fn(&str) -> bool) -> String {
    let builder_vendor = crate::pr_review::challenger_of(card)
        .map(|ch| crate::builder::challenger_for(ch).to_string())
        .or_else(|| card.builder.as_ref().map(|b| b.vendor.clone()))
        .unwrap_or_else(|| "claude".into());
    let other = crate::builder::challenger_for(&builder_vendor);
    if installed(other) {
        other.to_string()
    } else {
        builder_vendor
    }
}

/// `builder_start`'s `retry`, checked: a retry is of a Builder round that
/// really ran and ended (owner D); its choice as a spawn takes it.
pub fn builder_retry_checked(
    app: &tauri::AppHandle,
    workspace_id: &str,
    card_id: &str,
    retry: Option<RetryArg>,
) -> Result<Option<ModelChoice>, String> {
    use tauri::Manager;
    let Some(retry) = retry else {
        return Ok(None);
    };
    let card = app.state::<crate::kanban::KanbanStore>().get_card(workspace_id, card_id)?;
    retryable(&card, AgentRole::Builder, copy_has_changes(&card))?;
    Ok(Some(retry.choice()))
}

/// The card's copy holds uncommitted changes (what a session that failed
/// before its first Finish and check leaves). Unknown reads as none.
pub fn copy_has_changes(card: &crate::kanban::KanbanCard) -> bool {
    card.worktree_path
        .as_deref()
        .map(std::path::Path::new)
        .filter(|p| p.is_dir())
        .is_some_and(|p| crate::worktrees::worktree_is_dirty(p).unwrap_or(false))
}

/// Owner (b): why a Challenger retry was cancelled — its vendor can't review
/// now, so the model chosen isn't available; the verdict stays.
pub fn vendor_unavailable_words(title: &str, wanted: &str, instead: &str) -> String {
    format!(
        "“{title}”: {} can't review right now ({} would), so the model you chose isn't available. The verdict stays as it was.",
        crate::builder::vendor_display(wanted),
        crate::builder::vendor_display(instead),
    )
}

/// What the menu needs: the vendor whose models it offers.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPlan {
    pub vendor: String,
}

/// `card_retry_plan`: the vendor the Challenger's retry will review with.
#[tauri::command]
pub fn card_retry_plan(
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<RetryPlan, String> {
    let card = kanban.get_card(&workspace_id, &card_id)?;
    let env = crate::shell_env::try_get();
    let vendor = planned_challenger(&card, |v| {
        env.as_deref().is_none_or(|env| crate::builder::vendor_installed(env, v))
    });
    Ok(RetryPlan { vendor })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(m: &str, e: &str) -> ModelChoice {
        ModelChoice { model: Some(m.into()), reasoning: Some(e.into()) }
    }

    fn card(json: serde_json::Value) -> crate::kanban::KanbanCard {
        let mut base = serde_json::json!({
            "id": "c1", "workspaceId": "ws", "title": "t", "columnId": "in_progress", "createdAt": 1, "updatedAt": 1
        });
        base.as_object_mut().unwrap().extend(json.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn a_retry_is_offered_after_a_session_that_ran_and_is_over() {
        let built = serde_json::json!({ "vendor": "codex", "startedAt": 10, "snapshots": [{ "n": 1, "sha": "a", "at": 11 }],
                                        "model": "gpt-6-astra high", "ptyId": null });
        let mut c = card(serde_json::json!({ "builder": built.clone() }));
        assert!(retryable(&c, AgentRole::Builder, false).is_ok(), "closed after work");
        c.builder.as_mut().unwrap().pty_id = Some("p".into());
        assert!(retryable(&c, AgentRole::Builder, false).is_err(), "still working");
        c.builder.as_mut().unwrap().pty_id = None;
        c.builder.as_mut().unwrap().session_lost = true;
        assert!(retryable(&c, AgentRole::Builder, false).is_ok(), "ended on its own while the app ran (owner a)");
        c.builder.as_mut().unwrap().lost_on_restart = true;
        assert!(
            retryable(&c, AgentRole::Builder, false).unwrap_err().contains("Resume"),
            "lost when Plyloft restarted: Resume's"
        );
        let never = card(serde_json::json!({ "builder": { "vendor": "codex", "startedAt": 0, "snapshots": [] } }));
        assert!(retryable(&never, AgentRole::Builder, true).is_err(), "no session ever ran");
        let failed_early = card(serde_json::json!({ "builder": { "vendor": "codex", "startedAt": 10, "snapshots": [], "sessionLost": true } }));
        assert!(retryable(&failed_early, AgentRole::Builder, false).is_err(), "no work left");
        assert!(retryable(&failed_early, AgentRole::Builder, true).is_ok(), "failed before Finish and check, with changes in the copy");
        let pr = card(serde_json::json!({ "builder": built.clone(), "prReview": { "number": 7 } }));
        if pr.pr_review.is_some() {
            assert!(retryable(&pr, AgentRole::Builder, false).is_err(), "not on a pull request's card (owner c)");
        }
        let mut archived = card(serde_json::json!({ "builder": built, "archived": true }));
        assert!(retryable(&archived, AgentRole::Builder, false).is_err());
        archived.archived = false;
        assert!(retryable(&archived, AgentRole::Challenger, false).is_err(), "no review yet");
        for (status, ok) in [("running", false), ("queued", false), ("done", true), ("failed", true), ("skipped", true)] {
            archived.builder.as_mut().unwrap().review =
                Some(crate::kanban::BuilderReview { status: status.into(), snapshot_n: 1, ..Default::default() });
            assert_eq!(retryable(&archived, AgentRole::Challenger, false).is_ok(), ok, "{status}");
        }
        // A newer snapshot than the one reviewed: its own sentence.
        archived.builder.as_mut().unwrap().snapshots.push(crate::kanban::BuildSnapshot { n: 2, sha: "b".into(), at: 12 });
        assert!(retryable(&archived, AgentRole::Challenger, false).unwrap_err().contains("latest work"));
    }

    /// The launch cleanup marks a session lost on restart and settles a retry
    /// whose session ended with the app.
    #[test]
    fn a_retry_s_session_lost_on_restart_is_settled_and_marked() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{"version":{},"cards":[{{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":1,"updatedAt":1,
               "builder":{{"vendor":"codex","startedAt":20,"snapshots":[],"ptyId":"p1"}},
               "modelRetries":[{{"role":"builder","vendor":"codex","at":20,"model":"gpt-6-luna high"}}]}}]}}"#,
            crate::kanban::KANBAN_SCHEMA_VERSION
        );
        std::fs::write(&path, json).unwrap();
        let store = crate::kanban::KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let c = store.load("ws").unwrap().remove(0);
        let b = c.builder.as_ref().unwrap();
        assert!(b.lost_on_restart && b.session_lost && b.pty_id.is_none());
        assert_eq!(c.model_retries[0].outcome.as_deref(), Some("ended"));
        assert!(retryable(&c, AgentRole::Builder, true).is_err(), "Resume's case");
    }

    #[test]
    fn a_review_started_without_the_retry_s_choice_interrupts_it() {
        let mut c = card(serde_json::json!({ "builder": { "vendor": "codex", "startedAt": 10, "snapshots": [] } }));
        record(&mut c, AgentRole::Challenger, "codex", None, None, Some("approve".into()), &choice("gpt-6-luna", "high"), 5);
        record(&mut c, AgentRole::Builder, "codex", None, None, None, &choice("gpt-6-luna", "high"), 6);
        interrupt_open_review_retries(&mut c);
        assert_eq!(c.model_retries[0].outcome.as_deref(), Some("interrupted"));
        assert_eq!(c.model_retries[1].outcome, None, "the Builder's isn't touched");
    }

    #[test]
    fn a_retry_record_is_bounded_and_its_outcome_settles_with_its_session() {
        let mut c = card(serde_json::json!({ "builder": { "vendor": "codex", "startedAt": 10, "snapshots": [] } }));
        for i in 0..25 {
            record(
                &mut c,
                AgentRole::Builder,
                "codex",
                Some(1),
                Some("gpt-6-astra high".into()),
                Some("finished".into()),
                &choice("gpt-6-luna", "xhigh"),
                i,
            );
        }
        assert_eq!(c.model_retries.len(), crate::kanban::MODEL_RETRIES_MAX);
        let last = c.model_retries.last().unwrap().clone();
        assert_eq!(
            (last.model.as_deref(), last.from_model.as_deref(), last.outcome.as_deref()),
            (Some("gpt-6-luna xhigh"), Some("gpt-6-astra high"), None)
        );
        c.last_run_status = Some(crate::kanban::LastRunStatus::Success);
        settle_builder_retry(&mut c, 24);
        assert_eq!(c.model_retries.last().unwrap().outcome.as_deref(), Some("finished"));
        assert!(c.models.is_none(), "the card's own models are untouched");
        let old = card(serde_json::json!({}));
        assert!(old.model_retries.is_empty());
        assert!(serde_json::to_value(&old).unwrap().get("modelRetries").is_none());
    }

    /// Tier 2: a round recorded before A3 loads without its model and is
    /// written back without the key; one with a model round-trips.
    #[test]
    fn a_review_round_before_a3_loads_without_its_model() {
        let old: crate::kanban::ReviewRound = serde_json::from_str(
            r#"{"round":1,"ledgerRound":1,"verdict":"approve","new":0,"closed":0,"stillOpen":0,"at":5,"provider":"codex","reviewId":"r1","snapshotN":1}"#,
        )
        .unwrap();
        assert_eq!(old.model, None);
        assert!(serde_json::to_value(&old).unwrap().get("model").is_none());
        let with = crate::kanban::ReviewRound { model: Some("gpt-6-luna high".into()), ..old };
        let back: crate::kanban::ReviewRound = serde_json::from_value(serde_json::to_value(&with).unwrap()).unwrap();
        assert_eq!(back.model.as_deref(), Some("gpt-6-luna high"));
    }

    #[test]
    fn the_planned_challenger_is_the_review_s_own_rule() {
        let c = card(serde_json::json!({ "builder": { "vendor": "claude", "startedAt": 1, "snapshots": [] } }));
        assert_eq!(planned_challenger(&c, |_| true), "codex");
        assert_eq!(planned_challenger(&c, |_| false), "claude", "the other isn't installed: one AI");
    }

    /// CH-4 (1.174.0): held to the same fixtures as `retryOn.ts::
    /// retryOffered` (`src/lib/retryOn.fixtures.json`). The copy has changes
    /// when the card has a worktreePath, unless the case's `rust` says.
    #[test]
    fn retryable_matches_the_shared_fixtures() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RustSide {
            copy_has_changes: bool,
            retryable: bool,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            card: serde_json::Value,
            role: String,
            offered: bool,
            rust: Option<RustSide>,
        }
        #[derive(serde::Deserialize)]
        struct Fixtures {
            cases: Vec<Case>,
        }
        let fixtures: Fixtures = serde_json::from_str(include_str!("../../src/lib/retryOn.fixtures.json")).unwrap();
        assert!(fixtures.cases.len() >= 15);
        for c in fixtures.cases {
            let role = match c.role.as_str() {
                "builder" => AgentRole::Builder,
                "challenger" => AgentRole::Challenger,
                other => panic!("{}: role {other}", c.name),
            };
            let card = card(c.card);
            let (changes, want) = match &c.rust {
                Some(r) => (r.copy_has_changes, r.retryable),
                None => (card.worktree_path.is_some(), c.offered),
            };
            assert_eq!(retryable(&card, role, changes).is_ok(), want, "{}", c.name);
        }
    }
}
