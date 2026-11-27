//! OB-13 (ONBOARDING_SPEC §5 step 9, C10): what Setup's *Project settings*
//! step shows for a workspace, read-only.
//!
//! `project_config::detect_from_filesystem` (Settings › This repository ›
//! Build and release › Re-detect) takes the target branch from
//! `git rev-parse --abbrev-ref HEAD` and silently falls back to `main` on a
//! detached HEAD or a failed read. Setup must not (C10): here the branch is
//! the one chosen in step 8 when it exists, else the branch HEAD is on when
//! it has a commit, else `main` only when it exists — and otherwise the step
//! asks, with the local branches to choose from. Re-detect is left as it is:
//! it never writes the proposal's branch (Settings keeps the page's own
//! integration branch, and a first local config there takes origin's default
//! branch), so its fallback reaches no saved config.
//!
//! The rest of the scan (version files, install script, verify pipeline) is
//! `project_config::detect_with_branch`, shared with Re-detect. Saving goes
//! through the existing `project_config_set`; nothing here writes.

use crate::project_config::{self, ProjectConfig, ProjectConfigStore, VerifyKind};
use crate::project_setup::{self, Tools};
use serde::Serialize;
use std::path::Path;

/// What the step shows (spec §5 step 9 "Detected").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupConfigState {
    /// The workspace already has a config: done, facts shown, `Change`.
    Existing,
    /// Its shared definition carries the settings: read-only, done once the
    /// definition's config is on this Mac (`config` is null until then).
    Shared,
    /// Nothing saved yet; `config` is the proposal with its branch decided.
    Proposal,
    /// Neither the chosen branch, a branch HEAD is on with a commit, nor
    /// `main` exists: the step asks which branch (from `branches`).
    NeedsBranch,
    /// A Git project without a commit on any branch: step 8's to fix.
    NoCommit,
    /// Not a Git project: step 8's to fix.
    NotRepo,
}

/// Where a proposal's branch came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchFrom {
    /// The branch chosen in step 8 for a detached or unborn HEAD.
    Chosen,
    /// The branch the folder is on (it has a commit).
    Head,
    /// HEAD is on no branch with a commit, and `main` exists.
    Main,
}

/// Where the folder's HEAD is, for the ask's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HeadKind {
    /// On a branch that has a commit.
    Branch,
    /// On no branch (a commit checked out).
    Detached,
    /// On a branch with no commit yet (other branches may have some).
    Unborn,
    NotRepo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupConfigView {
    pub state: SetupConfigState,
    /// Existing / Shared: the saved config (Shared: null until the
    /// definition's refresh has written it). Proposal: the detected config
    /// with its branch. NeedsBranch: the detected config with an empty
    /// `targetBranch` for the step to fill. Otherwise null.
    pub config: Option<ProjectConfig>,
    /// Local branches with a commit, most recent first (the ask, and the
    /// Change form's select).
    pub branches: Vec<String>,
    /// The ask's first choice: `master`, else the most recent (never a
    /// silent pick — the step shows the question).
    pub suggested_branch: Option<String>,
    pub branch_from: Option<BranchFrom>,
    pub head: HeadKind,
    /// The branch HEAD is on (unborn included), when it is on one.
    pub head_branch: Option<String>,
    /// The check script the scan found — what the Change form's `Checks`
    /// switch turns on — even when the saved config has none.
    pub detected_verify: Option<Vec<VerifyKind>>,
    /// The version the config's version files say now (`1.4.2`).
    pub version: Option<String>,
    /// Shared definitions are shown, never changed, here.
    pub read_only: bool,
}

/// What git says about the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFacts {
    pub head: HeadKind,
    pub head_branch: Option<String>,
    /// Local branches with a commit, most recent first.
    pub branches: Vec<String>,
}

/// Read the folder's HEAD and local branches. `Err` only when git itself
/// couldn't be run or didn't answer in time.
pub fn read_repo(tools: &Tools, cwd: &Path) -> Result<RepoFacts, String> {
    let inside = project_setup::git_read(tools, cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if inside.as_deref() != Some("true") {
        return Ok(RepoFacts { head: HeadKind::NotRepo, head_branch: None, branches: Vec::new() });
    }
    let branches = project_setup::local_branches(tools, cwd);
    let head_branch = project_setup::head_branch(tools, cwd);
    let has_commit = project_setup::head_commit(tools, cwd).is_some();
    let head = match (&head_branch, has_commit) {
        (Some(_), true) => HeadKind::Branch,
        (Some(_), false) => HeadKind::Unborn,
        (None, true) => HeadKind::Detached,
        // No symbolic HEAD and no commit: git couldn't say; treat as detached
        // so the step asks rather than guesses.
        (None, false) => HeadKind::Detached,
    };
    Ok(RepoFacts { head, head_branch, branches })
}

/// Pure (C10): the branch cards start from, or `None` when the step must
/// ask. The chosen branch first (only when it exists with a commit), then
/// the branch HEAD is on when it has a commit, then `main` when it exists.
/// Never `main` by default.
pub fn choose_branch(facts: &RepoFacts, chosen: Option<&str>) -> Option<(String, BranchFrom)> {
    let has = |b: &str| facts.branches.iter().any(|x| x == b);
    if let Some(c) = chosen.map(str::trim).filter(|c| !c.is_empty()) {
        if has(c) {
            return Some((c.to_string(), BranchFrom::Chosen));
        }
    }
    if facts.head == HeadKind::Branch {
        if let Some(b) = facts.head_branch.as_deref().filter(|b| has(b)) {
            return Some((b.to_string(), BranchFrom::Head));
        }
    }
    if has("main") {
        return Some(("main".to_string(), BranchFrom::Main));
    }
    None
}

/// Pure: the ask's first choice once `main` is known missing — `master`,
/// else the most recent branch.
pub fn suggest_asked_branch(branches: &[String]) -> Option<String> {
    project_setup::suggest_branch(branches)
}

/// Whether the workspace's settings come from a shared definition carrying
/// a project part: the cached definition when a refresh has read it, else
/// the file in the folder (before the first refresh lands).
pub fn shared_definition_has_project(store: &ProjectConfigStore, workspace_id: &str, cwd: &Path) -> bool {
    if let Some(cache) = crate::workspace_definition::load_cache(store, workspace_id) {
        if let Some(def) = cache.definition {
            return def.has_project();
        }
    }
    std::fs::read(cwd.join(crate::workspace_definition::DEFINITION_PATH))
        .ok()
        .and_then(|bytes| crate::workspace_definition::parse_definition(&bytes).ok())
        .is_some_and(|d| d.has_project())
}

/// Step 9's reading of a workspace (nothing is written).
pub fn detect_for_setup(
    cwd: &Path,
    chosen: Option<&str>,
    tools: &Tools,
    existing: Option<ProjectConfig>,
    shared: bool,
) -> Result<SetupConfigView, String> {
    // A saved or shared config is shown whatever git says; git is read for
    // the Change form's branches, and a failure there just leaves it empty.
    let repo = if existing.is_some() || shared {
        read_repo(tools, cwd).unwrap_or(RepoFacts {
            head: HeadKind::NotRepo,
            head_branch: None,
            branches: Vec::new(),
        })
    } else {
        read_repo(tools, cwd)?
    };
    let detected_verify = project_config::detect_verify_pipeline(cwd);
    let mut view = SetupConfigView {
        state: SetupConfigState::NotRepo,
        config: None,
        branches: repo.branches.clone(),
        suggested_branch: None,
        branch_from: None,
        head: repo.head,
        head_branch: repo.head_branch.clone(),
        detected_verify,
        version: None,
        read_only: false,
    };
    if shared || existing.is_some() {
        view.state = if shared { SetupConfigState::Shared } else { SetupConfigState::Existing };
        view.read_only = shared;
        view.version = existing
            .as_ref()
            .and_then(|c| crate::ship::read_project_version(cwd, c));
        view.config = existing;
        return Ok(view);
    }
    if repo.head == HeadKind::NotRepo {
        return Ok(view);
    }
    if repo.branches.is_empty() {
        view.state = SetupConfigState::NoCommit;
        return Ok(view);
    }
    match choose_branch(&repo, chosen) {
        Some((branch, from)) => {
            let proposal = project_config::detect_with_branch(cwd, branch, "chosen in Setup");
            view.state = SetupConfigState::Proposal;
            view.branch_from = Some(from);
            view.version = crate::ship::read_project_version(cwd, &proposal.config);
            view.config = Some(proposal.config);
        }
        None => {
            let proposal = project_config::detect_with_branch(cwd, String::new(), "to be asked");
            view.state = SetupConfigState::NeedsBranch;
            view.suggested_branch = suggest_asked_branch(&repo.branches);
            view.version = crate::ship::read_project_version(cwd, &proposal.config);
            view.config = Some(proposal.config);
        }
    }
    Ok(view)
}

/// Step 9: read how Plyloft would build the workspace. `chosen_branch` is
/// the branch step 8 kept for a detached or unborn HEAD
/// (`firstProjectStore.targetBranch`).
#[tauri::command]
pub async fn project_detect_for_setup(
    app: tauri::AppHandle,
    workspace_id: String,
    chosen_branch: Option<String>,
) -> Result<SetupConfigView, String> {
    use tauri::Manager;
    project_setup::blocking(move || {
        let cwd = app
            .state::<crate::workspace::WorkspaceStore>()
            .snapshot()
            .workspaces
            .into_iter()
            .find(|w| w.id == workspace_id)
            .map(|w| std::path::PathBuf::from(w.cwd))
            .ok_or_else(|| "That project isn't in Plyloft any more.".to_string())?;
        let store = app.state::<ProjectConfigStore>();
        let shared = shared_definition_has_project(&store, &workspace_id, &cwd);
        let existing = store.get(&workspace_id);
        // A saved or shared config is shown even when git can't run; git is
        // required only to propose one.
        if existing.is_none() && !shared {
            project_setup::require_git()?;
        }
        detect_for_setup(&cwd, chosen_branch.as_deref(), &Tools::production(), existing, shared)
    })
    .await
}

/// n16: what a start's automatic set-up checks its branch against, read
/// from local refs only — never a fetch, so an offline or slow first start
/// isn't held up. `default_branch` is origin's own default
/// (`refs/remotes/origin/HEAD`) and nothing else: a repository pushed
/// rather than cloned may have no such ref, and guessing (`main`, then
/// HEAD's branch) could call a feature branch the default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrigin {
    pub has_origin: bool,
    pub default_branch: Option<String>,
    /// N18: origin's `owner/repo` when it is on GitHub (the Worktrees page's
    /// link to "Automatically delete head branches" for a local board).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_repo: Option<String>,
}

/// Pure over the repository's local refs (see [`LocalOrigin`]).
pub fn local_origin(cwd: &Path) -> LocalOrigin {
    let git = |args: &[&str]| crate::git::capture(cwd, args).ok();
    let url = git(&["remote", "get-url", "origin"]);
    let has_origin = url.is_some();
    let github_repo = url.as_deref().and_then(|u| crate::team::origin_slug(u.trim()));
    let default_branch = if has_origin {
        git(&["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
            .and_then(|h| h.trim().strip_prefix("origin/").map(str::to_string))
            .filter(|b| !b.is_empty())
    } else {
        None
    };
    LocalOrigin { has_origin, default_branch, github_repo }
}

/// n16: [`local_origin`] for a workspace.
#[tauri::command]
pub async fn project_local_origin(app: tauri::AppHandle, workspace_id: String) -> Result<LocalOrigin, String> {
    use tauri::Manager;
    project_setup::blocking(move || {
        let cwd = app
            .state::<crate::workspace::WorkspaceStore>()
            .snapshot()
            .workspaces
            .into_iter()
            .find(|w| w.id == workspace_id)
            .map(|w| std::path::PathBuf::from(w.cwd))
            .ok_or_else(|| "That project isn't in Plyloft any more.".to_string())?;
        Ok(local_origin(&cwd))
    })
    .await
}

#[cfg(test)]
#[path = "project_setup_config_tests.rs"]
mod tests;
