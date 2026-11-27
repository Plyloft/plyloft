//! 1.175.0 (C5, review SC-5 / SC-8): the shared setup's branch went away,
//! and a member who can't write has changes waiting.
//!
//! - [`move_to_renamed`] — "Move to {new}": GitHub renamed the branch the
//!   shared setup was read from. This computer's edit of "Cards go to" to the
//!   new name is recorded and published; `publish_branch` sends it to that
//!   branch since the old one is gone. The write is the existing commit of
//!   `.atelier/workspace.json` onto the integration branch — only which
//!   branch changes. A deleted branch is not moved here: the person chooses
//!   where cards go in Settings › Shipping, and the same rule carries it.
//! - [`use_team_values`] — "Use the team's values…": a member GitHub says
//!   can't push here drops this computer's changes that wait to be published
//!   (the queue and `pending` are emptied) and the next read applies the
//!   repository's values. No pull request is closed or touched: this
//!   computer's open settings pull requests are named, as at a removal.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_config::{load_queue, save_queue, PublishQueue};
use crate::workspace_definition::{
    field_label, load_cache, save_cache, save_changes, RefreshMoment, RepoSource, Stores,
};

/// "Move to {new}". Only to the name GitHub gave the gone branch (a press
/// on the notice that names it); anything else is refused.
pub fn move_to_renamed(stores: &Stores<'_>, repo: &dyn RepoSource, workspace_id: &str, to: &str) -> Result<(), String> {
    let cache = load_cache(stores.project_configs, workspace_id)
        .filter(|c| c.definition.is_some())
        .ok_or_else(|| "This project has no shared setup to move.".to_string())?;
    let gone = cache.branch_gone.clone().ok_or_else(|| "The shared setup's branch is still on GitHub.".to_string())?;
    if gone.renamed_to.as_deref() != Some(to) {
        return Err(format!("{} wasn't renamed to {to} on GitHub.", gone.branch));
    }
    if cache.write_access.read_only() {
        return Err("Moving it needs write access to the repository.".to_string());
    }
    if !repo.branch_exists(to) && repo.fetch(to).is_err() {
        return Err(format!("{to} isn't on GitHub yet."));
    }
    let mut base = Map::new();
    base.insert("integrationBranch".into(), Value::from(gone.branch.clone()));
    let mut draft = Map::new();
    draft.insert("integrationBranch".into(), Value::from(to));
    save_changes(stores, repo, workspace_id, base, draft).map(|_| ())
}

/// What "Use the team's values" did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamValuesUsed {
    /// The labels of the changes dropped from this computer.
    pub dropped: Vec<String>,
    /// This computer's settings pull requests still open on GitHub, which
    /// Plyloft no longer follows (named, never closed here).
    pub left_open: Vec<u64>,
}

/// "Use the team's values": only for a member GitHub says can't push here
/// (`can_push == Some(false)`), with changes waiting. Empties the queue and
/// `pending`; the caller's read then applies the repository's values.
pub fn use_team_values(stores: &Stores<'_>, workspace_id: &str) -> Result<TeamValuesUsed, String> {
    let mut cache = load_cache(stores.project_configs, workspace_id)
        .filter(|c| c.definition.is_some())
        .ok_or_else(|| "This project has no shared setup.".to_string())?;
    if cache.write_access.can_push != Some(false) {
        return Err(concat!(crate::this_machine!(cap), " can publish its changes: nothing to give up.").to_string());
    }
    let queue = load_queue(stores.project_configs, workspace_id);
    let mut keys: Vec<String> = cache.pending.keys().cloned().collect();
    for key in queue.fields.keys() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    if keys.is_empty() && queue.is_empty() {
        return Err(concat!(crate::this_machine!(cap), " has no changes waiting.").to_string());
    }
    let mut left_open: Vec<u64> = queue
        .fields
        .values()
        .filter_map(|f| f.pull_request.as_ref())
        .chain(queue.create_pull_request.as_ref())
        .chain(queue.superseded_pull_requests.iter())
        .map(|pr| pr.number)
        .collect();
    left_open.sort_unstable();
    left_open.dedup();
    // The removal's own pull request (Stop sharing) is kept, as is the rest
    // of what Stop sharing waits on: only the settings' changes go.
    let kept = PublishQueue {
        removal_branch: queue.removal_branch.clone(),
        removal_pull_request: queue.removal_pull_request.clone(),
        ..PublishQueue::default()
    };
    save_queue(stores.project_configs, workspace_id, &kept)?;
    cache.pending.clear();
    cache.pending_state = None;
    save_cache(stores.project_configs, workspace_id, &cache)?;
    let dropped = keys.iter().map(|k| field_label(k).to_string()).collect();
    log::info!("move_shared_setup: {workspace_id} uses the team's values; dropped {keys:?}");
    Ok(TeamValuesUsed { dropped, left_open })
}

// ── C5 round 2: no card starts from a branch that is gone ─────────────

/// The words that refuse a start (and a Ship) on `branch` while the shared
/// setup's branch is gone from GitHub: the Board notice's own. `None` when
/// `branch` isn't the gone one. Read from the cache only.
pub fn branch_gone_refusal(
    store: &crate::project_config::ProjectConfigStore,
    workspace_id: &str,
    branch: &str,
) -> Option<String> {
    let cache = load_cache(store, workspace_id)?;
    let gone = cache.branch_gone.as_ref().filter(|g| g.branch == branch && cache.definition.is_some())?;
    Some(gone_words(&gone.branch, gone.renamed_to.as_deref()))
}

/// The notice's title and body, as one sentence pair.
pub fn gone_words(branch: &str, renamed_to: Option<&str>) -> String {
    match renamed_to {
        Some(to) => format!(
            "{branch} is called {to} on GitHub now. Cards went to {branch}, and the shared setup still names it. Move both to {to} first, from the Board."
        ),
        None => format!(
            "{branch} isn't on GitHub any more. Cards went there, and the shared setup lived there. Choose where cards go now; Plyloft moves the shared setup to that branch. Until then no card can start."
        ),
    }
}

// ── Commands ──────────────────────────────────────────────────────────

/// `workspace_move_shared_setup(workspaceId, to)`: "Move to {new}". Records
/// the move, then publishes it (git and `gh`): off the main thread.
#[tauri::command(async)]
pub fn workspace_move_shared_setup(app: tauri::AppHandle, workspace_id: String, to: String) -> Result<(), String> {
    use tauri::Emitter;
    let _github = crate::github_account::enter_for_app(&app, &workspace_id);
    crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, repo| {
        move_to_renamed(stores, repo, &workspace_id, &to)
    })?;
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, &workspace_id);
    crate::workspace_definition::refresh_before(&app, &workspace_id, RefreshMoment::Publish);
    Ok(())
}

/// `workspace_use_team_values(workspaceId)`: "Use the team's values". Writes
/// this computer's cache and queue, then reads the branch: nothing goes to
/// GitHub.
#[tauri::command(async)]
pub fn workspace_use_team_values(app: tauri::AppHandle, workspace_id: String) -> Result<TeamValuesUsed, String> {
    use tauri::Emitter;
    let used = crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, repo| {
        let used = use_team_values(stores, &workspace_id)?;
        crate::workspace_definition::refresh_with(stores, repo, &workspace_id, RefreshMoment::Sync)?;
        Ok(used)
    })?;
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, &workspace_id);
    Ok(used)
}
