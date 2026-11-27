//! Skills hub H5 (`docs/plans/SKILLS_HUB.md` R12, §12 H5): the twins as the
//! Library shows them, and **Align** by card. A child module of `commands`,
//! like `skills_hub_decisions`, so it shares that module's helpers.
//!
//! - [`twin_rows`]: for every checkout skill both CLIs have a copy of, how
//!   the two stand ([`crate::skill_twins::Judgement`]) — the row says
//!   *Codex copy will follow the Claude copy at the next ship* or *Claude and
//!   Codex copies differ* — and whether the legacy `.codex/skills` copy
//!   disagrees. A reading that finds them aligned records the ids in this
//!   Mac's twin ledger (`skills_hub/state.json`), the record that later tells
//!   which twin changed.
//! - [`skills_hub_align`]: a skill card (`verb: align`) whose one commit,
//!   written with plumbing on the target branch's tip, replaces the losing
//!   twin with the winning one, file for file. The winner is the one the
//!   member chose, or — with no choice — the one R12 names (exactly one
//!   changed since the last aligned state); both changed asks.
//!
//! Every skill change to a repository goes through a card; `.codex/skills`
//! is never written.

use std::path::Path;

use tauri::Manager;

use super::*;
use crate::skill_card as sc;
use crate::skill_reach::Side;
use crate::skill_twins::{self as twins, Judgement};

/// One skill of the checkout whose twins need a word on its row.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinRow {
    pub skill: String,
    /// `{ "state": "follows", "winner": "claude" }`, `{ "state": "differ" }`.
    pub twins: Judgement,
    /// The row's sentence for that state.
    pub line: String,
    /// `.codex/skills/<skill>` disagrees with `.agents/skills/<skill>`.
    pub legacy: bool,
    /// The two copies the row reads are what the checkout's `HEAD` holds —
    /// what a card cut from the branch would find. Not committed: the
    /// difference is only in this checkout, and an Align card can't carry it.
    pub committed: bool,
}

/// The words a row says about twins that differ (R12).
pub const DIFFER_LINE: &str = "Claude and Codex copies differ";

/// Every checkout skill whose twins are not aligned (or whose legacy copy
/// disagrees), and the aligned ones recorded in this Mac's ledger.
pub(crate) fn twin_rows<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    links: &std::collections::BTreeMap<String, crate::skill_links::SkillLink>,
) -> Vec<TwinRow> {
    let config_dir = crate::skills_hub::config_dir(app).ok();
    let hub = config_dir.as_deref().map(crate::skills_hub_state::load).unwrap_or_default();
    let prefix = sc::workspace_prefix(cwd).ok();
    let mut rows = Vec::new();
    let mut aligned = Vec::new();
    for skill in crate::skill_migration::checkout_skill_names(cwd) {
        let here = sc::checkout_twin_ids(cwd, &skill);
        let judgement = twins::checkout_judgement(cwd, &skill, &here, links.get(&skill), hub.ledger(workspace_id, &skill));
        let legacy = twins::legacy_differs(cwd, &skill);
        if judgement == Judgement::Aligned {
            if let Some(entry) = twins::ledger_entry(&here) {
                aligned.push((skill.clone(), entry));
            }
        }
        let line = match judgement {
            Judgement::Follows(winner) => twins::follows_line(winner),
            Judgement::Differ => DIFFER_LINE.to_string(),
            Judgement::One | Judgement::Aligned if legacy => String::new(),
            Judgement::One | Judgement::Aligned => continue,
        };
        let committed = prefix
            .as_deref()
            .is_some_and(|prefix| sc::twin_ids_at(cwd, "HEAD", prefix, &skill).same_ids(&here));
        rows.push(TwinRow { skill, twins: judgement, line, legacy, committed });
    }
    if let (Some(config_dir), false) = (config_dir.as_deref(), aligned.is_empty()) {
        if let Err(error) = crate::skills_hub_state::record_aligned(config_dir, workspace_id, &aligned, chrono::Utc::now().timestamp_millis()) {
            log::warn!("skills hub: couldn't record the aligned copies ({error})");
        }
    }
    rows
}

/// What an Align made.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignMade {
    pub card: KanbanCard,
    /// The copy that won.
    pub winner: Side,
    /// The legacy `.codex/skills` copy disagrees, and stays as it is.
    pub legacy_note: Option<String>,
}

/// **Align** (R12, free on every plan, §9): a skill card that makes the
/// losing copy of `skill` exactly the winning one on the target branch.
/// `winner` (`"claude"` / `"codex"`) is the member's choice; without one the
/// copy R12 names wins, and twins that both changed are refused with the
/// question (the window then asks which wins).
#[tauri::command]
pub async fn skills_hub_align<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_id: String,
    skill: String,
    winner: Option<String>,
) -> Result<AlignMade, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AlignMade, String> {
        let skill = crate::project_skills::safe_name(&skill)?;
        let chosen = winner.as_deref().map(Side::parse).transpose()?;
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        skills_hub_decisions::decision_refusals(&app, &workspace_id, &cwd, &skill)?;
        let config_dir = crate::skills_hub::config_dir(&app)?;
        let ledger = crate::skills_hub_state::load(&config_dir).ledger(&workspace_id, &skill).cloned();
        let legacy_note = twins::legacy_differs(&cwd, &skill).then(|| twins::legacy_line(&skill));
        make_align_card(&app, &workspace_id, &cwd, &skill, chosen, ledger.as_ref()).map(|(card, winner)| AlignMade { card, winner, legacy_note })
    })
    .await
    .map_err(|error| format!("join align: {error}"))?
}

/// The refusal when nobody wins by the rule: the window asks.
pub const CHOOSE_WORDS: &str = "changed in both Claude's and Codex's copies, so Plyloft can't tell which one wins. Choose the copy that wins.";

/// Why an Align on `target`'s tip can't be made, or the winner it uses.
pub(crate) fn align_winner(
    repo: &Path,
    tip: &str,
    prefix: &str,
    skill: &str,
    target: &str,
    chosen: Option<Side>,
    ledger: Option<&crate::skill_links::TwinIds>,
) -> Result<Side, String> {
    let here = sc::twin_ids_at(repo, tip, prefix, skill);
    if here.claude.is_none() || here.codex.is_none() {
        return Err(format!(
            "{target} has only one copy of {skill}, so there is nothing to align. Make it available to both instead."
        ));
    }
    if twins::same_at(repo, tip, prefix, skill) {
        return Err(format!(
            "Claude's and Codex's copies of {skill} are the same on {target}; the difference is only in this \
             checkout. Ship or commit the change that made it first."
        ));
    }
    if let Some(chosen) = chosen {
        return Ok(chosen);
    }
    let mut records = twins::records_at(repo, tip, prefix, skill);
    records.extend(ledger.cloned());
    match twins::judge(&here, false, &records) {
        Judgement::Follows(winner) => Ok(winner),
        _ => Err(format!("{skill} {CHOOSE_WORDS}")),
    }
}

fn make_align_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    skill: &str,
    chosen: Option<Side>,
    ledger: Option<&crate::skill_links::TwinIds>,
) -> Result<(KanbanCard, Side), String> {
    let workspaces = app.state::<WorkspaceStore>();
    let project_config = app.state::<ProjectConfigStore>();
    let card_id = uuid::Uuid::new_v4().to_string();
    let target = resolve_base_branch(&project_config, workspace_id);
    let prefix = sc::workspace_prefix(cwd)?;
    let ensured = {
        let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
        crate::worktrees::ensure_for_skill_card(cwd, &card_id, &format!("Skill: align {skill}"), &target)?
    };
    let wt = ensured.worktree_path.clone();
    let branch = ensured.branch_name.clone();
    let Some(base) = ensured.base.clone() else {
        return Err("a worktree for this card already exists".into());
    };
    let written = (|| -> Result<(Side, crate::skill_links::TwinIds, crate::skill_links::TwinIds, String), String> {
        let winner = align_winner(&wt, &base.commit, &prefix, skill, &target, chosen, ledger)?;
        let changes = twins::align_changes(&wt, &base.commit, &prefix, skill, winner)?;
        let message = twins::commit_message(&[twins::Aligned { skill: skill.to_string(), winner }]);
        let sha = sc::commit_into_worktree(&wt, &base.commit, &changes, &message)?;
        let here = sc::twin_ids_at(&wt, &base.commit, &prefix, skill);
        let content = sc::twin_ids_at(&wt, &sha, &prefix, skill);
        Ok((winner, here, content, crate::worktrees::commit_tree_sha(&wt, &sha)?))
    })();
    let (winner, here, content, tree) = match written {
        Ok(done) => done,
        Err(why) => {
            sc::discard_worktree(cwd, &wt, &branch);
            return Err(why);
        }
    };
    // The link's origin when the copy is linked (the card names it nowhere
    // in its words; Ship's preflight never asks it), none otherwise.
    let origin = sc::link_at(&wt, &base.commit, &prefix, skill).map(|link| link.origin).unwrap_or_default();
    let kind = sc::SkillCard {
        verb: sc::SkillVerb::Align,
        skill: skill.to_string(),
        prefix,
        origin,
        here,
        content,
        links: Vec::new(),
        renamed_to: None,
        link_before: None,
        link_after: None,
        align_winner: Some(winner), local_link: false, from_words: None,
        extra: Default::default(),
    };
    let repo_words = skills_hub_decisions::repo_words_of(cwd);
    let card = skills_hub_decisions::file_skill_card(
        app,
        workspace_id,
        cwd,
        card_id,
        &ensured,
        base,
        &tree,
        sc::align_title(skill, winner),
        sc::align_notes(skill, winner, &repo_words),
        kind,
    )?;
    Ok((card, winner))
}

// Its IPC tests are with the other skill card commands' in
// `skill_card_ipc_tests.rs` (one mock app, one fixture).
