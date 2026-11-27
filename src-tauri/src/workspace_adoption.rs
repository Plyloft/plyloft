//! Adoption of the shared workspace definition (GH #81, ADR 0003): one
//! question, once, to whoever opens a GitHub repository without one.
//!
//! **The question.** A workspace whose repo has a GitHub `origin` and no
//! `.atelier/workspace.json` (nor the legacy `workspace_default.json`) shows a
//! banner on the board: "Share this workspace's setup with everyone who opens
//! the repo?" — **Share** or **Not on this Mac**. The refusal is remembered
//! per Mac and per repository in `settings.json` (`sharing.notOnThisMac`),
//! never in the repo, so the next person is asked too. A repo without a
//! GitHub remote is never asked: its definition stays local.
//!
//! **Share** seeds the definition from this Mac ([`seed_definition`]) — name,
//! colour and project config — plus what the integration branch shows: the
//! default branch unless the local config names another, and version files
//! when there are none configured. The seed is cached as
//! [`DefinitionSource::Seeded`] and its creation queued for the write channel
//! (`shared_config`, GH #80), whose creation commit also fixes a `.gitignore`
//! that hides `.atelier/` ([`fix_gitignore`]).
//!
//! **The board.** With a definition present, a repo with a GitHub remote runs
//! the board its definition names. A definition that says GitHub Issues
//! switches a Local board here ([`decide`]'s `SwitchBoard`, nothing to
//! publish) and the frontend migrates the local cards to issues; one that says
//! Local is never switched nor offered (R14, 1.169.1: the committed value
//! wins, and a switch here would be published over it) — only Settings ›
//! Board moves it, on a press that says it changes the board for everyone.
//! Where the
//! team licence gate refuses GitHub Issues, the board stays local on this Mac
//! (`Stores::github_board_allowed`) and the banner says why.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::platform::THIS_MACHINE;
use crate::project_config::{ProjectConfig, VersionFileEntry, VersionFileKind};
use crate::shared_config::{load_queue, save_queue, PublishQueue};
use crate::workspace::{KanbanSyncMode, Workspace};
use crate::workspace_definition::{
    load_cache, refresh_with, save_cache, DefinitionCache, DefinitionSource, RefreshMoment,
    RepoSource, Stores, WorkspaceDefinition, DEFINITION_PATH, DEFINITION_SCHEMA_VERSION,
    LEGACY_PATH,
};

/// The only file outside `.atelier/` the write channel touches, and only in
/// the commit that creates the definition.
pub const GITIGNORE_PATH: &str = ".gitignore";

/// The carve-out Ply's own repository uses: `.atelier/` contents stay
/// ignored (run artifacts, caches), the shared files are tracked.
pub const CARVE_OUT: [&str; 5] = [
    ".atelier/*",
    "!.atelier/workspace.json",
    "!.atelier/library/",
    "!.atelier/workspace_default.json",
    "!.atelier/shared-cargo-target",
];

/// A rule that ignores the `.atelier` directory itself: nothing inside it can
/// be re-included, so it is replaced by the carve-out.
fn ignores_whole_dir(rule: &str) -> bool {
    matches!(rule, ".atelier" | ".atelier/" | "/.atelier" | "/.atelier/")
}

/// A rule that ignores `.atelier`'s contents: the carve-out's exceptions go
/// after it.
fn ignores_contents(rule: &str) -> bool {
    matches!(rule, ".atelier/*" | "/.atelier/*")
}

/// A recursive rule: it ignores what's inside `.atelier/library/` even with
/// the directory excepted, so it becomes `.atelier/*`.
fn ignores_recursively(rule: &str) -> bool {
    matches!(rule, ".atelier/**" | "/.atelier/**")
}

/// `.gitignore` rewritten so `.atelier/workspace.json` is tracked, or `None`
/// when it needs no change. Three shapes: a rule ignoring `.atelier/` whole
/// is replaced by [`CARVE_OUT`]; a rule ignoring its contents keeps its place
/// and gets the missing exceptions right after it; no such rule (or no file)
/// already tracks the definition and is left alone. Everything else in the
/// file stays as written.
pub fn fix_gitignore(text: Option<&str>) -> Option<String> {
    let text = text?;
    let rule = |line: &str| line.trim().to_string();
    let mut out: Vec<String> = Vec::new();
    // Where the first whole-directory rule stood; every such rule goes.
    let mut first_whole: Option<usize> = None;
    for line in text.lines() {
        if ignores_whole_dir(&rule(line)) {
            first_whole.get_or_insert(out.len());
            continue;
        }
        if ignores_recursively(&rule(line)) {
            out.push(CARVE_OUT[0].to_string());
            continue;
        }
        out.push(line.to_string());
    }
    let has_contents_rule = out.iter().any(|l| ignores_contents(&rule(l)));
    match (first_whole, has_contents_rule) {
        (None, false) => return None,
        (Some(at), false) => out.insert(at, CARVE_OUT[0].to_string()),
        _ => {}
    }
    // The exceptions go after the last rule ignoring the contents: a rule
    // after an exception would ignore the path again.
    let anchor = out.iter().rposition(|l| ignores_contents(&rule(l)))?;
    let present: Vec<String> = out[anchor + 1..].iter().map(|l| rule(l)).collect();
    let missing: Vec<String> = CARVE_OUT[1..]
        .iter()
        .filter(|e| !present.iter().any(|p| p == *e))
        .map(|e| e.to_string())
        .collect();
    for (i, line) in missing.into_iter().enumerate() {
        out.insert(anchor + 1 + i, line);
    }
    let mut next = out.join("\n");
    if text.ends_with('\n') {
        next.push('\n');
    }
    (next != text).then_some(next)
}

/// Version files a project with none configured gets: the manifests at the
/// repository root on the integration branch.
const DETECTED_VERSION_FILES: [(&str, VersionFileKind); 3] = [
    ("package.json", VersionFileKind::PackageJson),
    ("Cargo.toml", VersionFileKind::CargoToml),
    ("pyproject.toml", VersionFileKind::PyProjectToml),
];

/// The definition Share publishes: this Mac's workspace (name, colour) and
/// project config, with GitHub Issues as the board of `github_repo` — or of
/// the issue repository this Mac's GitHub Issues board already uses. The
/// integration branch is absent (= the default branch) unless the local
/// config names another; version files come from the local config, else from
/// the manifests the integration branch carries. The review settings come
/// from `ProjectConfigStore::review`: the config's when there is one, else
/// `review.json` (a workspace with no config keeps them there, GH #111).
pub fn seed_definition(
    ws: &Workspace,
    local: Option<&ProjectConfig>,
    review: &crate::project_config::ReviewSettings,
    github_repo: &str,
    repo: &dyn RepoSource,
) -> WorkspaceDefinition {
    let default_branch = repo.default_branch();
    let integration_branch = local
        .map(|c| c.target_branch.trim().to_string())
        .filter(|b| !b.is_empty() && *b != default_branch);
    let branch = integration_branch
        .clone()
        .unwrap_or_else(|| default_branch.clone());
    let version_files = local
        .map(|c| c.version_files.clone())
        .filter(|files| !files.is_empty())
        .unwrap_or_else(|| {
            DETECTED_VERSION_FILES
                .iter()
                .filter(|(path, _)| repo.read(&branch, path).is_some())
                .map(|(path, kind)| VersionFileEntry {
                    path: path.to_string(),
                    kind: *kind,
                    variable_name: None,
                })
                .collect()
        });
    WorkspaceDefinition {
        schema_version: DEFINITION_SCHEMA_VERSION,
        name: ws.name.clone(),
        accent_color: ws.accent_color.clone(),
        board: KanbanSyncMode::GitHubIssues,
        // A board already on GitHub Issues keeps its issue repository: its
        // cards carry issue numbers from there, not from origin.
        github_owner_repo: Some(
            ws.github_owner_repo
                .clone()
                .filter(|r| {
                    ws.kanban_sync_mode == KanbanSyncMode::GitHubIssues && !r.trim().is_empty()
                })
                .unwrap_or_else(|| github_repo.to_string()),
        ),
        integration_branch,
        version_files: Some(version_files),
        install_script: local.and_then(|c| c.install_script.clone()),
        try_command: local.and_then(|c| c.try_command.clone()),
        verify_pipeline: local
            .and_then(|c| c.verify_pipeline.clone())
            .filter(|p| !p.is_empty()),
        cache_paths: Some(local.map(|c| c.cache_paths.clone()).unwrap_or_default()),
        shared_build_cache: Some(local.is_none_or(|c| c.shared_build_cache)),
        self_check: Some(review.self_check),
        review_checklist: Some(review.review_checklist.clone()),
        worktree_copy: None,
        worktree_setup: None,
        library: None,
        models: None,
        areas: None,
        release_kind: None,
        extra: BTreeMap::new(),
    }
}

// ── The decision ──────────────────────────────────────────────────────

/// What the board's banner does for a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AdoptionAction {
    /// Nothing to ask or do.
    None,
    /// "Share this workspace's setup with everyone who opens the repo?"
    Ask,
    /// A converted `workspace_default.json` not published yet: publish it,
    /// without a question.
    ConvertLegacy,
    /// The definition's board is GitHub Issues and this Mac's is still Local
    /// (held for a licence, or a clone behind): switch it — nothing to
    /// publish, the repository agrees — and turn this Mac's local cards into
    /// issues. Never for a definition that says Local (R14).
    #[serde(rename_all = "camelCase")]
    SwitchBoard { local_cards: usize },
    /// The board is GitHub Issues on this Mac and cards made while it was
    /// local have no issue yet: turn them into issues.
    #[serde(rename_all = "camelCase")]
    MigrateCards { local_cards: usize },
    /// The definition asks for GitHub Issues and the licence gate refuses it
    /// here: the board stays local.
    #[serde(rename_all = "camelCase")]
    BoardHeld { reason: String },
    /// OB-8 (owner decision "ask first"): a switch or a migration would run,
    /// but only because teams are free during the beta — no key unlocked it.
    /// Nothing changes until the one-press offer is taken. Never for a
    /// definition that says Local (R14).
    ///
    /// `cards_only`: the board is already GitHub Issues on this Mac and only
    /// its local cards would move (a migration, not a switch).
    #[serde(rename_all = "camelCase")]
    OfferBoard { local_cards: usize, cards_only: bool },
    /// OB-8 review 2: the offer was answered "Keep it on this Mac". Not asked
    /// again on the board; Settings › Board says so and keeps the one press
    /// that moves it after all.
    #[serde(rename_all = "camelCase")]
    BoardKeptLocal { local_cards: usize, cards_only: bool },
    /// 1.171.0 (X2): a shared setup on another branch, for that branch alone,
    /// was not adopted — this folder is set up on its own. "Use the shared
    /// setup" or "Keep this folder's setup", asked once.
    ///
    /// 1.172.0 (B1): `others`, the further branches with a shared setup each
    /// naming itself (a fresh clone on the default branch that found more
    /// than one) — the person chooses which, or none.
    #[serde(rename_all = "camelCase")]
    SetupElsewhere {
        here: Option<String>,
        branch: String,
        name: String,
        #[serde(default)]
        others: Vec<String>,
    },
    /// 1.172.0 (B1): solo mode, and the repository's shared setup puts the
    /// board on GitHub Issues — it stays local here, and the board and
    /// Settings › Board say why, with the way to work with a team.
    SoloBoardLocal,
    /// 1.175.0 (C1, SC-2): the shared setup was on `branch` and is gone
    /// from it. "Keep it on this Mac" or "Share it again…": until one is
    /// chosen Plyloft writes nothing to GitHub for this project. `who` and
    /// `at` (seconds) are the removal's commit, when git can say; `pending`
    /// counts this computer's changes that were not published yet and stay.
    #[serde(rename_all = "camelCase")]
    SetupRemoved {
        branch: String,
        who: Option<String>,
        at: Option<i64>,
        pending: usize,
    },
    /// 1.175.0 (C2, SC-1): the pull request that proposed moving the setup
    /// out of its older file was closed without merging. Said once on the
    /// Board ("The shared setup stays in its older file", *Propose it
    /// again*); Settings › Project › General keeps it.
    #[serde(rename_all = "camelCase")]
    ConversionDeclined { pull_request: u64, who: Option<String> },
    /// 1.175.0 (C5, SC-5): the branch cards go to — where the shared setup
    /// lives — is gone from GitHub: renamed (`renamed_to`: "Move to {new}")
    /// or deleted ("Choose where cards go"). A member who can't write is
    /// told whom to ask (`author`), with no button.
    #[serde(rename_all = "camelCase")]
    BranchGone {
        branch: String,
        renamed_to: Option<String>,
        read_only: bool,
        author: Option<String>,
    },
}

/// 1.175.0 (C2): the declined conversion, kept in the definition cache.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionDeclined {
    pub pull_request: u64,
    /// Who closed it, when GitHub was asked (today it isn't: `None`).
    #[serde(default)]
    pub who: Option<String>,
    /// When this computer learned it (seconds).
    #[serde(default)]
    pub at: i64,
    /// The Board's notice was on screen: not shown again (owner, C2-a).
    #[serde(default)]
    pub seen: bool,
}

/// 1.175.0 (C1): what Settings › Project › General's "Shared setup" row says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SharedSetup {
    /// `.atelier/workspace.json` is on `branch`: *Stop sharing…*. `author`
    /// last changed it (whom a read-only member asks); `pending` are this
    /// computer's changes not published yet; `pull_request` is the removal
    /// that waits, when the branch refused the push.
    #[serde(rename_all = "camelCase")]
    Shared {
        branch: String,
        read_only: bool,
        author: Option<String>,
        pending: Vec<String>,
        pull_request: Option<SetupPullRequest>,
        /// WALKFIX-1 (walk): the file on the branch can't be used now — the
        /// row says so (C6's words for a newer Plyloft's file) instead of
        /// "shared". Absent while it reads.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unreadable: Option<crate::workspace_definition::Unreadable>,
    },
    /// Removed from `branch`, not chosen yet: the notice's two buttons.
    #[serde(rename_all = "camelCase")]
    Removed {
        branch: String,
        who: Option<String>,
        at: Option<i64>,
        read_only: bool,
        /// Round 2: this computer's settings pull requests still open.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        left_open: Vec<u64>,
    },
    /// Kept on this computer: *Share it again…*. `who` stopped it (`None`
    /// with `here`: this computer's own press).
    #[serde(rename_all = "camelCase")]
    NotShared {
        who: Option<String>,
        at: i64,
        here: bool,
        read_only: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        left_open: Vec<u64>,
    },
    /// WALKFIX-3 (re-run, item 3): *Share* (or *Share it again*) waits in
    /// a pull request because the branch refused the push: not shared yet,
    /// one button that opens it.
    #[serde(rename_all = "camelCase")]
    Waiting {
        branch: String,
        pull_request: SetupPullRequest,
        read_only: bool,
    },
    /// C2: the setup is in the older file and its conversion was declined:
    /// the notice's sentence and *Propose it again*, for as long as it is.
    #[serde(rename_all = "camelCase")]
    Declined {
        pull_request: u64,
        who: Option<String>,
        read_only: bool,
    },
    /// Round 5: the setup is read from the older file and git can't say
    /// whether the shared setup was removed (a shallow clone), so nothing
    /// converts by itself: the press that proposes the move.
    #[serde(rename_all = "camelCase")]
    OlderFile { read_only: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPullRequest {
    pub number: u64,
    pub url: String,
}

/// May the older file (`workspace_default.json`) be converted and published
/// as `.atelier/workspace.json` without a press? The one answer
/// [`decide`] gives `ConvertLegacy` from. Yes only for a definition read
/// from the older file, that reads, with no creation queued or waiting —
/// and never where the shared setup was removed or sharing was stopped
/// (1.175.0 C1, SC-2: the refresh doesn't take the older file into the cache
/// there at all — `stop_sharing::ignores_older_file`,
/// `older_file_after_a_removal` — and this says it again, so the guarantee
/// doesn't rest on that alone).
pub fn may_convert_by_itself(cache: &DefinitionCache, creating: bool) -> bool {
    cache.definition.is_some()
        && cache.source == DefinitionSource::Legacy
        && !creating
        && cache.unreadable.is_none()
        && cache.removed.is_none()
        && cache.sharing.is_none()
        // 1.175.0 (C2, SC-1): nor after the conversion's pull request was
        // closed without merging — only *Propose it again* does.
        && cache.conversion_declined.is_none()
        // C1 round 4: nor while git can't say whether the setup was removed.
        && !cache.history_unread
}

/// C2: "Propose it again" — the declined conversion is forgotten; the
/// caller then publishes it as the automatic conversion would have.
pub fn propose_again(stores: &Stores<'_>, workspace_id: &str) -> Result<(), String> {
    let mut cache = load_cache(stores.project_configs, workspace_id)
        .ok_or_else(|| "This project has no conversion to propose.".to_string())?;
    // Round 5: also the press for an older file read where git can't say
    // whether the setup was removed — nothing to forget there.
    let unread = cache.definition.is_some() && cache.source == DefinitionSource::Legacy && cache.history_unread;
    if cache.conversion_declined.take().is_none() {
        return if unread { Ok(()) } else { Err("This project has no conversion to propose.".to_string()) };
    }
    save_cache(stores.project_configs, workspace_id, &cache)
}

/// C2: the Board's notice was on screen — it isn't shown again; the row in
/// Settings stays.
pub fn conversion_notice_seen(stores: &Stores<'_>, workspace_id: &str) -> Result<(), String> {
    let Some(mut cache) = load_cache(stores.project_configs, workspace_id) else {
        return Ok(());
    };
    match cache.conversion_declined.as_mut() {
        Some(declined) if !declined.seen => declined.seen = true,
        _ => return Ok(()),
    }
    save_cache(stores.project_configs, workspace_id, &cache)
}

/// `workspace_propose_conversion_again(workspaceId)`: the press. Runs git
/// and `gh` (the publish): off the main thread.
#[tauri::command(async)]
pub fn workspace_propose_conversion_again(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<crate::workspace_definition::DefinitionView, String> {
    crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, _| {
        propose_again(stores, &workspace_id)
    })?;
    crate::workspace_definition::app_publish_definition(&app, &workspace_id)
}

/// `workspace_conversion_notice_seen(workspaceId)`: this computer's cache only.
#[tauri::command(async)]
pub fn workspace_conversion_notice_seen(app: tauri::AppHandle, workspace_id: String) -> Result<(), String> {
    crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, _| {
        conversion_notice_seen(stores, &workspace_id)
    })
}

/// The "Shared setup" row's state, from the cache and the queue alone.
pub fn shared_setup(cache: Option<&DefinitionCache>, queue: &PublishQueue) -> Option<SharedSetup> {
    use crate::stop_sharing::SharingState;
    let cache = cache?;
    let read_only = cache.write_access.read_only();
    if cache.definition.is_some() {
        if let (DefinitionSource::Legacy, Some(declined)) = (cache.source, &cache.conversion_declined) {
            return Some(SharedSetup::Declined {
                pull_request: declined.pull_request,
                who: declined.who.clone(),
                read_only,
            });
        }
        if cache.source == DefinitionSource::Legacy && cache.history_unread {
            return Some(SharedSetup::OlderFile { read_only });
        }
        if cache.source == DefinitionSource::Seeded {
            // WALKFIX-3: the creation waiting in its pull request is said,
            // not hidden (the row used to vanish until it merged).
            return queue.create_pull_request.as_ref().map(|pr| SharedSetup::Waiting {
                branch: cache.branch.clone().unwrap_or_default(),
                pull_request: SetupPullRequest { number: pr.number, url: pr.url.clone() },
                read_only,
            });
        }
        if cache.source != DefinitionSource::Repo {
            return None;
        }
        return Some(SharedSetup::Shared {
            branch: cache.branch.clone()?,
            read_only,
            author: cache.author.clone(),
            pending: cache.pending.keys().cloned().collect(),
            pull_request: queue
                .removal_pull_request
                .as_ref()
                .map(|pr| SetupPullRequest { number: pr.number, url: pr.url.clone() }),
            unreadable: cache.unreadable.clone(),
        });
    }
    if let Some(removed) = &cache.removed {
        return Some(SharedSetup::Removed {
            branch: removed.branch.clone(),
            who: removed.author.clone(),
            at: removed.at,
            read_only,
            left_open: removed.left_open.clone(),
        });
    }
    cache.sharing.as_ref().map(|sharing| SharedSetup::NotShared {
        who: sharing.who.clone(),
        at: sharing.at,
        here: sharing.state == SharingState::StoppedHere,
        read_only,
        left_open: sharing.left_open.clone(),
    })
}

/// The board banner's input and the Kanban backing setting's visibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionStatus {
    /// `owner/name` of the GitHub `origin`; `None` for a repo without one.
    pub github_repo: Option<String>,
    /// The repo has a shared definition (or Share queued one).
    pub has_definition: bool,
    /// The issue repository a board switch and a migration use: the
    /// definition's `githubOwnerRepo`, else `github_repo` (origin).
    #[serde(default)]
    pub board_repo: Option<String>,
    /// R14 (1.169.1): the board the repository's definition names (repo plus
    /// pending), for a GitHub repo with one. Settings › Board says "This
    /// repository's board is Local." from it and keeps the press that moves
    /// it, since the banner offers nothing then. `None` for a Local board
    /// this account can't push to (`app_status`), as for every other move.
    #[serde(default)]
    pub repo_board: Option<KanbanSyncMode>,
    pub action: AdoptionAction,
    /// 1.171.0 (X2): "Keep this folder's setup" was answered for the
    /// shared setup of this branch — Settings › General keeps the press that
    /// uses it after all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_own_setup: Option<String>,
    /// 1.172.0 (B1): the other branches that answer named with it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kept_own_setup_others: Vec<String>,
    /// 1.175.0 (C1): the "Shared setup" row of Settings › Project ›
    /// General — shared (with *Stop sharing…*), removed, or kept here.
    /// Absent for a project that never shared its setup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_setup: Option<SharedSetup>,
    /// Round 2: this read learned that the member can't push and kept the
    /// removed setup here — said once, as a toast. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing_note: Option<crate::stop_sharing::SharingNote>,
}

/// Everything [`decide`] reads, gathered by the app glue.
#[derive(Debug, Clone)]
pub struct AdoptionFacts {
    pub github_repo: Option<String>,
    /// The integration branch carries `workspace.json` or the legacy file,
    /// whether or not a refresh cached it yet.
    pub repo_has_file: bool,
    /// 1.172.0 (B1): the branches a refresh reads first (the default and
    /// the configured target) carry it — the folder runs with it once that
    /// refresh ran. A file only on other branches is the scan's to adopt or
    /// offer, so it alone never says "this repository sets its board"
    /// (Windows walk: Board said so while General said nothing is shared).
    pub repo_has_own_file: bool,
    pub cache: Option<DefinitionCache>,
    pub queue: PublishQueue,
    /// "Not on this Mac" was chosen for this repository.
    pub declined: bool,
    /// The board this Mac runs with per the definition (repo plus pending).
    pub effective_board: Option<KanbanSyncMode>,
    /// The definition's issue repository (`githubOwnerRepo`), when it names
    /// one — it may differ from origin.
    pub effective_repo: Option<String>,
    /// This Mac's board, as the workspace store has it.
    pub local_board: KanbanSyncMode,
    pub github_board_allowed: bool,
    /// Non-archived cards without an issue that no Sync retries (not
    /// `sync_pending`).
    pub local_cards: usize,
    /// OB-8: the board is unlocked only by the free beta and this Mac has not
    /// been told to move this repository's board — ask before a switch or a
    /// migration.
    pub ask_before_board: bool,
    /// OB-8: the offer was answered "Keep it on this Mac": not offered again.
    pub board_kept_local: bool,
    /// T1 (team walk): the repository is a workspace of the team this Mac is
    /// in. Joining the team was the consent: its board runs as the team's
    /// does, without the beta's one-press offer.
    pub in_team_manifest: bool,
}

pub const LICENCE_REASON: &str = concat!(
    "The board stays local on ",
    crate::this_machine!(),
    ": GitHub Issues boards need a Plyloft Team licence (Settings › Setup and account › Plan)."
);

pub fn decide(facts: &AdoptionFacts) -> AdoptionStatus {
    let cached = facts.cache.as_ref().and_then(|c| c.definition.as_ref());
    let has_definition = cached.is_some() || facts.repo_has_own_file;
    let elsewhere = facts
        .cache
        .as_ref()
        .filter(|c| c.definition.is_none())
        .and_then(|c| c.found_elsewhere.as_ref())
        .filter(|found| found.answer.is_none());
    let kept = facts
        .cache
        .as_ref()
        .filter(|c| c.definition.is_none())
        .and_then(|c| c.found_elsewhere.as_ref())
        .filter(|found| found.answer == Some(crate::workspace_definition::ElsewhereAnswer::Keep));
    let kept_own_setup = kept.map(|found| found.branch.clone());
    let kept_own_setup_others = kept.map(|found| found.others.clone()).unwrap_or_default();
    let action = match (&facts.github_repo, cached) {
        _ if elsewhere.is_some() => {
            let found = elsewhere.expect("checked");
            AdoptionAction::SetupElsewhere {
                here: found.here.clone(),
                branch: found.branch.clone(),
                name: found.name.clone(),
                others: found.others.clone(),
            }
        }
        // No GitHub remote: the definition stays local, nobody is asked.
        (None, _) => AdoptionAction::None,
        // 1.175.0 (C1, SC-2): the shared setup was removed — the person
        // chooses; and once they kept it here (or stopped sharing here), the
        // Share question doesn't come back by itself.
        (Some(_), None) if facts.cache.as_ref().is_some_and(|c| c.removed.is_some()) => {
            let removed = facts.cache.as_ref().and_then(|c| c.removed.as_ref()).expect("checked");
            AdoptionAction::SetupRemoved {
                branch: removed.branch.clone(),
                who: removed.author.clone(),
                at: removed.at,
                pending: removed.pending.len(),
            }
        }
        (Some(_), None) if facts.cache.as_ref().is_some_and(|c| c.sharing.is_some()) => AdoptionAction::None,
        (Some(_), None) if facts.repo_has_file => AdoptionAction::None,
        (Some(_), None) if facts.declined => AdoptionAction::None,
        (Some(_), None) => AdoptionAction::Ask,
        (Some(_), Some(_)) => {
            let cache = facts.cache.as_ref().expect("cached definition");
            let creating =
                facts.queue.create_definition || facts.queue.create_pull_request.is_some();
            let board = facts.effective_board.unwrap_or(KanbanSyncMode::Local);
            if let Some(gone) = cache.branch_gone.as_ref() {
                // C5: before anything else — no card can start until it moves.
                AdoptionAction::BranchGone {
                    branch: gone.branch.clone(),
                    renamed_to: gone.renamed_to.clone(),
                    read_only: cache.write_access.read_only(),
                    author: cache.author.clone(),
                }
            } else if let Some(declined) = cache
                .conversion_declined
                .as_ref()
                .filter(|d| !d.seen && cache.source == DefinitionSource::Legacy && !creating)
            {
                // C2: said once; the row in Settings stays after that.
                AdoptionAction::ConversionDeclined { pull_request: declined.pull_request, who: declined.who.clone() }
            } else if may_convert_by_itself(cache, creating) {
                AdoptionAction::ConvertLegacy
            } else if board != KanbanSyncMode::GitHubIssues {
                // R14 (1.169.1): the repository's committed board wins. A
                // definition that says Local is never switched on its own nor
                // offered, on any plan — a switch here is this Mac's edit and
                // would be published over the repository's choice (walk R2: a
                // board moved for the same repository before switched a new
                // workspace and committed "Board — local → githubIssues").
                // Only Settings › Board moves it, on a press
                // (`AdoptionStatus::repo_board`). An earlier "Keep it on this
                // Mac" stays said there.
                if facts.board_kept_local && facts.github_board_allowed {
                    AdoptionAction::BoardKeptLocal {
                        local_cards: facts.local_cards,
                        cards_only: false,
                    }
                } else {
                    AdoptionAction::None
                }
            } else if facts.local_board != KanbanSyncMode::GitHubIssues
                && !facts.github_board_allowed
            {
                AdoptionAction::BoardHeld {
                    reason: LICENCE_REASON.to_string(),
                }
            } else if facts.local_board != KanbanSyncMode::GitHubIssues {
                // The definition is GitHub Issues and this Mac may run it, but
                // its board is still Local — it was held until a licence
                // arrived. Switch it now (nothing to publish: the repo agrees).
                AdoptionAction::SwitchBoard {
                    local_cards: facts.local_cards,
                }
            } else if facts.local_board == KanbanSyncMode::GitHubIssues
                && facts.github_board_allowed
                && facts.local_cards > 0
            {
                // The board became GitHub Issues without this Mac switching
                // it (another Mac shared or switched it, a refresh applied
                // it): this Mac's local cards still become issues.
                AdoptionAction::MigrateCards {
                    local_cards: facts.local_cards,
                }
            } else {
                AdoptionAction::None
            }
        }
    };
    // OB-8: ask first. A switch or a migration unlocked only by the free
    // beta becomes a one-press offer (or nothing, once declined).
    // T1: a team workspace's board runs as the team's — unless this Mac
    // answered "Keep it on this Mac", which stays its answer.
    let ask = facts.ask_before_board && !(facts.in_team_manifest && !facts.board_kept_local);
    let action = match action {
        AdoptionAction::SwitchBoard { local_cards } if ask => {
            offer(local_cards, false, facts.board_kept_local)
        }
        AdoptionAction::MigrateCards { local_cards } if ask => {
            offer(local_cards, true, facts.board_kept_local)
        }
        other => other,
    };
    AdoptionStatus {
        github_repo: facts.github_repo.clone(),
        has_definition,
        board_repo: facts.github_repo.as_ref().and(
            facts
                .effective_repo
                .clone()
                .or_else(|| facts.github_repo.clone()),
        ),
        repo_board: match (&facts.github_repo, cached) {
            (Some(_), Some(definition)) => Some(facts.effective_board.unwrap_or(definition.board)),
            _ => None,
        },
        action,
        kept_own_setup,
        kept_own_setup_others,
        shared_setup: facts
            .github_repo
            .as_ref()
            .and_then(|_| shared_setup(facts.cache.as_ref(), &facts.queue)),
        sharing_note: None,
    }
}

/// 1.171.0 (X2): the status solo mode reads — only the question about a
/// shared setup found on another branch (and the kept answer's way back),
/// from the cache alone: no sharing question, board move or GitHub call.
pub fn solo_status(github_repo: Option<String>, cache: Option<&DefinitionCache>) -> AdoptionStatus {
    let facts = AdoptionFacts {
        github_repo,
        repo_has_file: false,
        repo_has_own_file: false,
        cache: cache.cloned(),
        queue: PublishQueue::default(),
        declined: true,
        effective_board: None,
        effective_repo: None,
        local_board: KanbanSyncMode::Local,
        github_board_allowed: false,
        local_cards: 0,
        ask_before_board: false,
        board_kept_local: false,
        in_team_manifest: false,
    };
    let mut status = decide(&facts);
    if !matches!(status.action, AdoptionAction::SetupElsewhere { .. }) {
        status.action = AdoptionAction::None;
    }
    status.repo_board = None;
    // 1.175.0 (C1): sharing is not solo mode's subject.
    status.shared_setup = None;
    // 1.172.0 (B1): the setup in use puts the board on GitHub Issues, and
    // solo mode keeps it local — said, rather than nothing (§12 walk note:
    // after "Use the shared setup" the board stayed local and nothing said why). A board
    // already on GitHub Issues makes the Mac team, so solo is always local.
    let issues = cache
        .and_then(|c| c.definition.as_ref())
        .is_some_and(|d| pending_board(cache).unwrap_or(d.board) == KanbanSyncMode::GitHubIssues);
    if issues && status.github_repo.is_some() && matches!(status.action, AdoptionAction::None) {
        status.has_definition = true;
        status.repo_board = Some(KanbanSyncMode::GitHubIssues);
        status.action = AdoptionAction::SoloBoardLocal;
    }
    status
}

/// A board edit still pending in `cache`, laid over the definition's.
fn pending_board(cache: Option<&DefinitionCache>) -> Option<KanbanSyncMode> {
    cache
        .and_then(|c| c.pending.get("board"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

pub fn app_solo_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<AdoptionStatus, String> {
    use tauri::Manager;
    let ws = workspace_of(app, workspace_id)?;
    let cwd = std::path::PathBuf::from(&ws.cwd);
    let github_repo = cwd.is_dir().then(|| github_repo_at(&cwd)).flatten();
    let configs = app.state::<crate::project_config::ProjectConfigStore>();
    Ok(solo_status(github_repo, load_cache(&configs, workspace_id).as_ref()))
}

/// OB-8: the offer, or — once answered "Keep it on this Mac" — the kept state.
fn offer(local_cards: usize, cards_only: bool, kept_local: bool) -> AdoptionAction {
    if kept_local {
        AdoptionAction::BoardKeptLocal {
            local_cards,
            cards_only,
        }
    } else {
        AdoptionAction::OfferBoard {
            local_cards,
            cards_only,
        }
    }
}

/// The repo carries a definition on the branches a first refresh looks at
/// (no fetch: the open refresh already fetched).
pub fn repo_has_file(repo: &dyn RepoSource, local: Option<&ProjectConfig>) -> bool {
    repo_has_own_file(repo, local)
        || !repo.branches_with(DEFINITION_PATH).is_empty()
        || !repo.branches_with(LEGACY_PATH).is_empty()
}

/// 1.172.0 (B1): [`repo_has_file`] on the default and the configured target
/// branch alone — the ones a refresh reads before any scan.
pub fn repo_has_own_file(repo: &dyn RepoSource, local: Option<&ProjectConfig>) -> bool {
    let mut branches = vec![repo.default_branch()];
    if let Some(target) = local.map(|c| c.target_branch.clone()) {
        if !target.is_empty() && !branches.contains(&target) {
            branches.push(target);
        }
    }
    branches.iter().any(|branch| {
        repo.read(branch, DEFINITION_PATH).is_some() || repo.read(branch, LEGACY_PATH).is_some()
    })
}

/// A repository's key in `sharing.notOnThisMac`.
pub fn repo_key(github_repo: &str) -> String {
    github_repo.trim().to_ascii_lowercase()
}

/// Whether `declined` holds `github_repo`.
pub fn is_declined(declined: &[String], github_repo: &str) -> bool {
    let key = repo_key(github_repo);
    declined.iter().any(|r| repo_key(r) == key)
}

/// OB-8: whether this Mac was told to move `github_repo`'s board to GitHub
/// Issues, and whether it was told to keep it here.
pub fn board_choice(
    sharing: &crate::settings::SharingSettings,
    github_repo: &str,
) -> (bool, bool) {
    let key = repo_key(github_repo);
    (
        sharing.github_board_moved.iter().any(|r| repo_key(r) == key),
        sharing.github_board_kept_local.iter().any(|r| repo_key(r) == key),
    )
}

/// OB-8: may a refresh or a board switch run GitHub Issues for the repository
/// at `cwd` on its own? The licence gate, and — when only the free beta opens
/// it — this Mac's "Move to GitHub Issues" for that repository. Until then the
/// board is held exactly as the licence gate holds it.
pub fn github_board_runs_here<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cwd: &std::path::Path,
) -> bool {
    use tauri::Manager;
    let Some(license) = app.try_state::<crate::license::LicenseStore>() else {
        return true;
    };
    if !license.team_allowed() {
        return false;
    }
    if !license.unlocked_only_by_beta() {
        return true;
    }
    let Some(slug) = github_repo_at(cwd) else {
        return true;
    };
    let (moved, kept_local) = app
        .try_state::<crate::settings::SettingsStore>()
        .map(|s| board_choice(&s.snapshot().sharing, &slug))
        .unwrap_or((false, false));
    // T1 (team walk): a workspace of the team this Mac is in — joining the
    // team was the consent, for as long as the manifest lists it (nothing is
    // recorded: a repository the team drops is offered again). A "Keep it on
    // this Mac" stays this Mac's answer.
    moved || (!kept_local && app_team_lists(app, &slug))
}

/// T1: whether `manifest` lists `github_repo` among the team's workspaces.
pub fn team_lists_workspace(
    manifest: Option<&crate::team::TeamManifest>,
    github_repo: &str,
) -> bool {
    let key = repo_key(github_repo);
    manifest.is_some_and(|m| m.workspaces.iter().any(|w| repo_key(&w.repo) == key))
}

/// T1: [`team_lists_workspace`] for the team this Mac is in, read from its
/// local clone (offline: no GitHub call).
pub fn app_team_lists<R: tauri::Runtime>(app: &tauri::AppHandle<R>, github_repo: &str) -> bool {
    use tauri::Manager;
    let (Some(settings), Some(team)) = (
        app.try_state::<crate::settings::SettingsStore>(),
        app.try_state::<crate::team::TeamStore>(),
    ) else {
        return false;
    };
    let Some(slug) = crate::team::current_team_repo(&settings.snapshot().team) else {
        return false;
    };
    let manifest = crate::team::read_manifest(&team.clone_dir(&slug)).ok().flatten();
    team_lists_workspace(manifest.as_ref(), github_repo)
}

/// OB-8: record this Mac's answer to the board offer for the workspace's
/// repository, and tell every window.
pub fn app_board_choice<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    moved: bool,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let ws = workspace_of(app, workspace_id)?;
    let slug = github_repo_at(std::path::Path::new(&ws.cwd))
        .ok_or_else(|| "This repository has no GitHub remote.".to_string())?;
    let saved = app
        .try_state::<crate::settings::SettingsStore>()
        .ok_or_else(|| "settings are not ready".to_string())?
        .set_board_choice(&repo_key(&slug), moved)?;
    let _ = app.emit("settings://changed", saved);
    Ok(())
}

// ── Share ─────────────────────────────────────────────────────────────

/// What Share did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutcome {
    /// Someone shared the repo meanwhile: its definition was read instead and
    /// nothing was seeded.
    pub already_shared: bool,
    /// The board this Mac runs with now.
    pub board: KanbanSyncMode,
    /// Non-archived cards without an issue, to migrate when the board is
    /// GitHub Issues.
    pub local_cards: usize,
    /// Why the board stayed local, when it did.
    pub board_held: Option<String>,
    /// 1.174.0 (C10, D6): someone shared the repository meanwhile without
    /// areas, and the areas kept on this Mac went to it as this Share's
    /// edit (it said "Also shares the areas kept on this Mac").
    #[serde(default)]
    pub areas_shared: bool,
}

/// Share, under the workspace lock: read the repo once more (someone may have
/// shared it meanwhile — then that definition wins and nothing is seeded),
/// seed the definition from this Mac, cache it as [`DefinitionSource::Seeded`]
/// and queue its creation. The caller publishes it (a refresh drains the
/// queue) and applies the board. `local_cards` counts the cards to migrate.
pub fn share(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    github_repo: &str,
    local_cards: usize,
) -> Result<ShareOutcome, String> {
    // Nothing found only counts when origin was asked: offline, a definition
    // on a branch this clone hasn't fetched is invisible, and a seed queued
    // now would later publish a second one (a cached seed also stops the
    // branch scan that would have found it). A branch the local config names
    // but origin lacks is not a reason to refuse — only reaching origin is.
    if let Err(e) = repo.fetch_branches() {
        return Err(format!(
            "Plyloft couldn't reach origin to check whether this repository is already shared ({}). Try Share again when it's reachable.",
            e.lines().last().unwrap_or(&e).trim()
        ));
    }
    let report = refresh_with(stores, repo, workspace_id, RefreshMoment::Open)?;
    let ws = stores
        .workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;
    let held = |board: KanbanSyncMode| {
        (board != KanbanSyncMode::GitHubIssues && !stores.github_board_allowed)
            .then(|| LICENCE_REASON.to_string())
    };
    if report.has_definition {
        // 1.174.0 (C10, D6): the refresh set this Mac's areas aside. A
        // repository shared without areas takes them, as this press's edit;
        // one with areas of its own asks on the Board (nothing is written).
        let repo_has_none = load_cache(stores.project_configs, workspace_id)
            .filter(|c| !c.write_access.read_only())
            .and_then(|c| c.definition)
            .is_some_and(|d| d.areas.as_ref().is_none_or(|a| a.valid().is_some_and(<[_]>::is_empty)));
        let areas_shared = repo_has_none
            && crate::areas::set_aside(stores.project_configs, workspace_id).is_some()
            && crate::workspace_definition::answer_set_aside(stores, repo, workspace_id, true).unwrap_or_else(|e| {
                // The sheet asks instead: the list stays set aside here.
                log::warn!("workspace_adoption: sharing the areas kept here for {workspace_id}: {e}");
                false
            });
        let board = ws.kanban_sync_mode;
        return Ok(ShareOutcome {
            already_shared: true,
            board,
            local_cards,
            board_held: held(board),
            areas_shared,
        });
    }
    // A definition exists but can't be read: it is the repo's, broken — not
    // an absence to seed over. Its diagnostic stays cached for the Doctor.
    if let Some(bad) = &report.unreadable {
        let branch = load_cache(stores.project_configs, workspace_id)
            .and_then(|c| c.branch)
            .unwrap_or_else(|| "a branch".to_string());
        // 1.175.0 (C6, SC-9): a file a later Plyloft wrote isn't to be
        // fixed there.
        if let Some(said) = bad.newer_share_refusal(&branch) {
            return Err(said);
        }
        return Err(format!(
            "This repository already has {} on {}, but it is {} ({}). Fix it there; Plyloft won't share a second one.",
            bad.path,
            branch,
            bad.summary(),
            bad.message
        ));
    }
    let local = stores.project_configs.get(workspace_id);
    let review = stores.project_configs.review(workspace_id);
    let mut seed = seed_definition(&ws, local.as_ref(), &review, github_repo, repo);
    // WALKFIX-3 (re-run, item 1): *Share it again* — this project stopped
    // sharing, or its setup was removed and is kept here — shares "this
    // Mac's name, colour and project settings" as its sheet says, the
    // board included: never switched by itself. The first Share keeps
    // putting the board on GitHub Issues, which its question says ("…and
    // the board becomes GitHub Issues: your cards become issues"; ADR 0003,
    // GH #81).
    let sharing_again = load_cache(stores.project_configs, workspace_id)
        .is_some_and(|c| c.sharing.is_some() || c.removed.is_some());
    if sharing_again {
        seed.board = ws.kanban_sync_mode;
        if ws.kanban_sync_mode != KanbanSyncMode::GitHubIssues {
            seed.github_owner_repo = None;
        }
    }
    // Try it: the start command travels too — the config's, or the one this
    // Mac kept while it had no config (`try_command.json`).
    seed.try_command = stores.project_configs.try_command(workspace_id);
    // SL-4: what this Mac's card worktrees get travels with the share.
    let worktree = crate::worktree_setup::load_settings(stores.project_configs, workspace_id);
    seed.worktree_copy = worktree.worktree_copy.filter(|l| !l.is_empty());
    seed.worktree_setup = worktree.worktree_setup.filter(|c| !c.trim().is_empty());
    // 1.173.0 (G1): and this Mac's own default release kind, so sharing the
    // settings never wipes it (`release_kind_set` kept it in `areas.json`).
    seed.release_kind = crate::areas::load_release_kind(stores.project_configs, workspace_id);
    // 1.174.0 (C10, D6): and the areas kept on this Mac until now — they go
    // in the same commit of .atelier/workspace.json ("Also shares the areas
    // kept on this Mac").
    if let Some(kept) = crate::areas::kept_here(stores.project_configs, workspace_id) {
        seed.areas = Some(kept.into());
    }
    // Skills hub H9: so do this workspace's Plyloft choices, when it has any.
    let ply_skills = crate::ply_skill_switch::load(stores.project_configs, workspace_id);
    if !ply_skills.is_empty() {
        seed.library = Some(crate::workspace_definition::DefinitionLibrary {
            ply_skills: Some(ply_skills),
            extra: Default::default(),
        });
    }
    let branch = seed
        .integration_branch
        .clone()
        .unwrap_or_else(|| repo.default_branch());
    let mut cache =
        load_cache(stores.project_configs, workspace_id).unwrap_or_else(DefinitionCache::empty);
    cache.definition = Some(seed);
    cache.found_elsewhere = None;
    // 1.175.0 (C1): Share and "Share it again" are the two ways a removed
    // setup is created again.
    cache.removed = None;
    cache.sharing = None;
    cache.source = DefinitionSource::Seeded;
    cache.branch = Some(branch);
    cache.commit = None;
    cache.author = None;
    cache.unreadable = None;
    cache.pending.clear();
    let mut queue = load_queue(stores.project_configs, workspace_id);
    queue.create_definition = true;
    save_queue(stores.project_configs, workspace_id, &queue)?;
    save_cache(stores.project_configs, workspace_id, &cache)?;
    // Apply to this Mac: everything but the board already is this Mac's; the
    // board follows unless the licence gate holds it.
    refresh_with(stores, repo, workspace_id, RefreshMoment::Publish)?;
    let board = stores
        .workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.kanban_sync_mode)
        .unwrap_or(KanbanSyncMode::Local);
    Ok(ShareOutcome {
        already_shared: false,
        board,
        local_cards,
        board_held: held(board),
        areas_shared: false,
    })
}

// ── App glue ──────────────────────────────────────────────────────────

/// `owner/name` of a github.com `origin`. Another host (GitLab, an
/// Enterprise server) has no GitHub Issues board to adopt.
pub(crate) fn github_repo_at(cwd: &std::path::Path) -> Option<String> {
    crate::shared_config::Plumbing {
        cwd: cwd.to_path_buf(),
    }
    .github_repo()
    .filter(|slug| slug.matches('/').count() == 1)
}

fn local_card_count<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> usize {
    use tauri::Manager;
    app.try_state::<crate::kanban::KanbanStore>()
        .and_then(|store| store.load(workspace_id).ok())
        .map(|cards| {
            cards
                .iter()
                .filter(|c| c.gh_issue_number.is_none() && !c.archived && !c.sync_pending && c.pr_review.is_none())
                .count()
        })
        .unwrap_or(0)
}

fn workspace_of<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<Workspace, String> {
    use tauri::Manager;
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

/// The banner's status. Blocking (git reads, and `gh` when a conversion
/// without a question needs to know this account can push): call from a
/// worker. A switch or conversion is offered only where GitHub doesn't say
/// this account can't push — that is the owner's Mac, not a reader's.
pub fn app_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<AdoptionStatus, String> {
    use tauri::Manager;
    let ws = workspace_of(app, workspace_id)?;
    // OB-7b: the access check (and the definition's fetch) as the
    // workspace's GitHub account.
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let cwd = std::path::PathBuf::from(&ws.cwd);
    let github_repo = cwd.is_dir().then(|| github_repo_at(&cwd)).flatten();
    let configs = app.state::<crate::project_config::ProjectConfigStore>();
    let local = configs.get(workspace_id);
    let repo = crate::workspace_definition::GitRepo { cwd: cwd.clone() };
    let github_board_allowed = app
        .try_state::<crate::license::LicenseStore>()
        .is_none_or(|license| license.team_allowed());
    let declined = github_repo.as_deref().is_some_and(|slug| {
        app.try_state::<crate::settings::SettingsStore>()
            .is_some_and(|s| is_declined(&s.snapshot().sharing.not_on_this_mac, slug))
    });
    let only_by_beta = app
        .try_state::<crate::license::LicenseStore>()
        .is_some_and(|license| license.unlocked_only_by_beta());
    let (board_moved, board_kept_local) = github_repo
        .as_deref()
        .and_then(|slug| {
            app.try_state::<crate::settings::SettingsStore>()
                .map(|s| board_choice(&s.snapshot().sharing, slug))
        })
        .unwrap_or((false, false));
    let status_repo_in_team = github_repo
        .as_deref()
        .is_some_and(|slug| app_team_lists(app, slug));
    let view = crate::workspace_definition::app_view(app, workspace_id)?;
    let facts = AdoptionFacts {
        repo_has_file: github_repo.is_some() && repo_has_file(&repo, local.as_ref()),
        repo_has_own_file: github_repo.is_some() && repo_has_own_file(&repo, local.as_ref()),
        github_repo,
        cache: load_cache(&configs, workspace_id),
        queue: load_queue(&configs, workspace_id),
        declined,
        effective_board: view
            .as_ref()
            .and_then(|v| v.effective.as_ref())
            .map(|d| d.board),
        effective_repo: view
            .as_ref()
            .and_then(|v| v.effective.as_ref())
            .and_then(|d| d.github_owner_repo.clone()),
        local_board: ws.kanban_sync_mode,
        github_board_allowed,
        local_cards: local_card_count(app, workspace_id),
        ask_before_board: only_by_beta && !board_moved,
        board_kept_local,
        in_team_manifest: status_repo_in_team,
    };
    let mut status = decide(&facts);
    // R14: Settings › Board's move of a repository's Local board is a move too.
    let movable_local_board = status.repo_board == Some(KanbanSyncMode::Local)
        && status.action == AdoptionAction::None
        && github_board_allowed;
    if movable_local_board
        || matches!(
            status.action,
            AdoptionAction::ConvertLegacy
                | AdoptionAction::SwitchBoard { .. }
                | AdoptionAction::MigrateCards { .. }
                // OB-8 review 2: a reader without push is not offered a move.
                | AdoptionAction::OfferBoard { .. }
                | AdoptionAction::BoardKeptLocal { .. }
                // 1.175.0 (C1): nor the choice to share it again.
                | AdoptionAction::SetupRemoved { .. }
                // C2: nor to propose the conversion again.
                | AdoptionAction::ConversionDeclined { .. }
        )
    {
        let slug = status.github_repo.clone().unwrap_or_default();
        if let Ok(access) = crate::github::repo_access(&slug) {
            if access.push == Some(false) {
                // 1.175.0 (C1 round 2): write access wasn't known when the
                // removal was found. A member who can't push has nothing to
                // choose: the setup is kept here, and said once.
                if matches!(status.action, AdoptionAction::SetupRemoved { .. }) {
                    let said = crate::workspace_definition::with_workspace_lock(app, workspace_id, |stores, _| {
                        Ok(crate::stop_sharing::keep_for_reader(
                            stores,
                            workspace_id,
                            crate::shared_config::now_millis() / 1000,
                        ))
                    })
                    .ok()
                    .flatten();
                    let cache = load_cache(&configs, workspace_id);
                    status.shared_setup = shared_setup(cache.as_ref(), &load_queue(&configs, workspace_id));
                    status.sharing_note = said;
                }
                if let Some(SharedSetup::Declined { read_only, .. }) = status.shared_setup.as_mut() {
                    *read_only = true;
                }
                status.action = AdoptionAction::None;
                if status.repo_board == Some(KanbanSyncMode::Local) {
                    status.repo_board = None;
                }
            }
        }
    }
    Ok(status)
}

/// 1.171.0 (X2): the answer to "A shared setup on GitHub is for another
/// branch" — recorded in the cache; `use_it` then refreshes, which adopts it.
pub fn answer_elsewhere(
    project_configs: &crate::project_config::ProjectConfigStore,
    workspace_id: &str,
    use_it: bool,
    branch: Option<&str>,
) -> Result<(), String> {
    let mut cache = load_cache(project_configs, workspace_id)
        .filter(|c| c.definition.is_none())
        .ok_or_else(|| "There is no shared setup to choose for this folder.".to_string())?;
    let found = cache
        .found_elsewhere
        .as_mut()
        .ok_or_else(|| "There is no shared setup to choose for this folder.".to_string())?;
    // 1.172.0 (B1): "Use the one for X" for one of the others named — it
    // becomes the setup asked about, the first one joins the others.
    if let Some(chosen) = branch.filter(|b| use_it && *b != found.branch) {
        let at = found
            .others
            .iter()
            .position(|o| o == chosen)
            .ok_or_else(|| format!("No shared setup on {chosen} was found for this folder."))?;
        let first = std::mem::replace(&mut found.branch, found.others.remove(at));
        found.others.insert(0, first);
        // Its Name was not read with the others; the refresh reads it.
        found.name = String::new();
    }
    found.answer = Some(if use_it {
        crate::workspace_definition::ElsewhereAnswer::Use
    } else {
        crate::workspace_definition::ElsewhereAnswer::Keep
    });
    crate::workspace_definition::save_cache(project_configs, workspace_id, &cache)
}

pub const USE_IT_LATER: &str =
    "Couldn't reach GitHub to read that setup; Plyloft uses it on the next refresh.";

pub fn app_answer_elsewhere<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    use_it: bool,
    branch: Option<&str>,
) -> Result<(), String> {
    use tauri::Emitter;
    crate::workspace_definition::with_workspace_lock(app, workspace_id, |stores, _| {
        answer_elsewhere(stores.project_configs, workspace_id, use_it, branch)
    })?;
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, workspace_id);
    if use_it {
        let report =
            crate::workspace_definition::refresh_definition(app, workspace_id, RefreshMoment::Open)?;
        // Offline (or the branch went): the answer stays, and the next
        // refresh adopts it — the toast says so rather than nothing.
        if !report.has_definition {
            return Err(USE_IT_LATER.to_string());
        }
    }
    Ok(())
}

/// "Not on this Mac": remember the repository in settings.
pub fn app_decline<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let ws = workspace_of(app, workspace_id)?;
    let slug = github_repo_at(std::path::Path::new(&ws.cwd))
        .ok_or_else(|| "This repository has no GitHub remote.".to_string())?;
    let saved = app.state::<crate::settings::SettingsStore>().update(|s| {
        if !is_declined(&s.sharing.not_on_this_mac, &slug) {
            s.sharing.not_on_this_mac.push(repo_key(&slug));
        }
    })?;
    let _ = app.emit("settings://changed", saved);
    Ok(())
}

/// Share: seed and queue under the workspace lock, apply the board (labels
/// first, when this Mac may run GitHub Issues), then publish through the
/// channel. Blocking.
pub fn app_share<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<ShareOutcome, String> {
    use tauri::Emitter;
    let ws = workspace_of(app, workspace_id)?;
    // OB-7b: the labels, the publish's push and PR as the workspace's
    // GitHub account.
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let slug = github_repo_at(std::path::Path::new(&ws.cwd)).ok_or_else(|| {
        format!("This repository has no GitHub remote; its setup stays on {THIS_MACHINE}.")
    })?;
    let local_cards = local_card_count(app, workspace_id);
    let allowed = {
        use tauri::Manager;
        app.try_state::<crate::license::LicenseStore>()
            .is_none_or(|license| license.team_allowed())
    };
    // OB-8: Share says the board becomes GitHub Issues — pressing it is the
    // answer the free beta's offer would have asked for. It is recorded only
    // once the share succeeded; the share's own switch runs with it meanwhile.
    let share_is_consent = allowed && {
        use tauri::Manager;
        app.try_state::<crate::license::LicenseStore>()
            .is_some_and(|license| license.unlocked_only_by_beta())
    };
    if allowed {
        // The status labels exist before any card moves on the board.
        if let Err(e) = crate::github::ensure_labels(&slug, &crate::github::STATUS_LABELS) {
            log::warn!("workspace_adoption: status labels for {slug}: {e}");
        }
    }
    let outcome =
        crate::workspace_definition::with_workspace_lock(app, workspace_id, |stores, repo| {
            let consented = Stores {
                workspaces: stores.workspaces,
                project_configs: stores.project_configs,
                github_board_allowed: stores.github_board_allowed || share_is_consent,
            };
            share(&consented, repo, workspace_id, &slug, local_cards)
        })?;
    if share_is_consent {
        // Advisory like the Board path: the share itself has happened.
        if let Err(e) = app_board_choice(app, workspace_id, true) {
            log::warn!("workspace_adoption: board choice after Share for {workspace_id}: {e}");
        }
    }
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, workspace_id);
    if !outcome.already_shared || outcome.areas_shared {
        crate::workspace_definition::refresh_before(app, workspace_id, RefreshMoment::Publish);
    }
    Ok(outcome)
}

#[cfg(test)]
#[path = "workspace_adoption_tests.rs"]
mod tests;
