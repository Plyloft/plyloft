//! The shared workspace definition (GH #79, ADR 0003): `.atelier/workspace.json`
//! in the repository **is** the workspace.
//!
//! One tracked file carries what two people opening the same repo must agree
//! on — identity (`name`, `accentColor`), board (`board`, `githubOwnerRepo`)
//! and project config (`integrationBranch`, `versionFiles`, `installScript`,
//! `verifyPipeline`, `cachePaths`, `sharedBuildCache`). Tiles, open files,
//! editor state, personal Knowledge, CLI logins and each person's own model
//! choices are not in it; since 1.169.0 (A2) the models the team *suggests*
//! are (`models`, `team_models`), below everyone's own choice; since 1.173.0
//! (B1) the parts of the repository that ship on their own (`areas`,
//! `areas.rs`), absent for a repository with one product.
//!
//! **Read live, repo wins.** [`refresh_definition`] fetches the integration
//! branch and reads the file at its tip — never the user's checkout, which may
//! be on another branch or dirty. It runs at workspace open, on every board
//! Sync, before every Start build and every [`REFRESH_INTERVAL_SECS`] while a
//! workspace is warmed ([`RefreshMoment`]). A local value that differs from the
//! repo is replaced and reported as a [`FieldChange`] naming the author of the
//! commit that last touched the file; the frontend toasts it.
//!
//! **Cache.** `projects/<workspace_id>/workspace_definition.json` holds the
//! last good copy (atomic, Hard Rule #3). `projects/<ws>/config.json` stays the
//! store every ship/verify path reads, now as the cache of the definition's
//! project part, and `workspaces.json` keeps the identity and board fields.
//! An unparsable repo file keeps the cache and records [`Unreadable`] for the
//! Doctor; nothing is ever written back over the repo file from the cache.
//!
//! **Local edits.** An edit made in Ply applies to this Mac at once and is
//! kept as a *pending* field until the repo carries the same value. It is
//! queued for the write channel (`shared_config`, GH #80): a commit straight
//! onto the integration branch, never through the user's checkout, with a pull
//! request when the push is refused. [`publish_pending`] drains the queue on
//! every refresh (so every Sync and 10-minute read) and right after an edit.
//! A field the branch changed since this Mac's edit is held for the person's
//! choice (1.173.0, C3: [`resolve_conflict`]); while it waits, this Mac keeps
//! its own value and every refresh leaves it pending.
//!
//! **Legacy.** A repo with only `.atelier/workspace_default.json` is converted
//! field for field ([`from_legacy`]) into the cache; `workspace.json` wins when
//! both exist. A repo with neither is left alone: nothing changes.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::shared_config::{
    load_queue, save_queue, PrState, PublishOutcome, PublishQueue, PublishRequest, Publisher,
    PullRequest, QueuedField,
};
use crate::project_config::{
    ProjectConfig, ReviewChecklistClass, ProjectConfigStore, VerifyKind, VersionFileEntry, PROJECT_CONFIG_SCHEMA_VERSION,
};
use crate::workspace::{KanbanSyncMode, Workspace, WorkspaceDefault, WorkspaceStore};

/// The shared definition, relative to the repository root.
pub const DEFINITION_PATH: &str = ".atelier/workspace.json";
/// The pre-#79 form, still read when `workspace.json` is absent.
pub const LEGACY_PATH: &str = ".atelier/workspace_default.json";
/// Highest `schemaVersion` this build understands.
pub const DEFINITION_SCHEMA_VERSION: u32 = 1;
const CACHE_SCHEMA_VERSION: u32 = 1;
pub const CACHE_FILENAME: &str = "workspace_definition.json";
/// How often a warmed workspace re-reads its definition. The frontend owns the
/// timer (it knows which workspaces are warmed); the value lives here so the
/// two sides cannot disagree silently — `ipc.ts` mirrors it.
#[cfg_attr(not(test), allow(dead_code))]
pub const REFRESH_INTERVAL_SECS: u64 = 600;
/// Emitted after every refresh with the [`RefreshReport`] as payload.
pub const REFRESHED_EVENT: &str = "workspace-definition://refreshed";
/// Emitted with the workspace id after a local edit was recorded as pending.
pub const EDITED_EVENT: &str = "workspace-definition://edited";

/// The moments a definition is read. Every one goes through
/// [`refresh_definition`]; the moment is only carried for logs and the event.
/// `Publish` is the read right after a local edit, which drains the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefreshMoment {
    Open,
    Sync,
    StartBuild,
    Periodic,
    Publish,
    /// A person looking at a page (Settings › Project opening, Team's *Read it
    /// again*, the press that moves a board): reads and makes this Mac match.
    /// The read itself publishes nothing; what it finds can start the Board's
    /// existing automatic steps, as any read does.
    PageRead,
}

impl RefreshMoment {
    /// This moment reads the branch and nothing else: the shared-config queue,
    /// the library queue and the Next improvement directions wait for the next
    /// read that drains them. AGENTS.md: the shared channel commits after the
    /// person changed something, not because they opened a page.
    pub fn only_reads(self) -> bool {
        self == RefreshMoment::PageRead
    }
}

fn default_schema_version() -> u32 {
    DEFINITION_SCHEMA_VERSION
}

/// `.atelier/workspace.json`. Unknown keys are kept in `extra` so a file
/// written by a newer Ply loads here and survives a rewrite.
///
/// Project fields are optional as a group: a definition with none of them
/// ([`WorkspaceDefinition::has_project`] false) shares no project config, and
/// the Mac's own `config.json` is left alone. With any of them present, the
/// project part is authoritative and an absent field means its default
/// (`integrationBranch` = the repo's default branch, no install script, no
/// verify pipeline, no extra cache paths, shared build cache on).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDefinition {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub board: KanbanSyncMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_owner_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_files: Option<Vec<VersionFileEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_script: Option<String>,
    /// Try it (TRY_IT_SPEC §5.1, D19): the command that starts the app, part
    /// of the project part like `installScript`. Older definitions load
    /// without it; a value of the wrong type reads as unset.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub try_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_pipeline: Option<Vec<VerifyKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_build_cache: Option<bool>,
    /// ADR 0006 (third card): `Self-check before review`; absent = on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_check: Option<bool>,
    /// ADR 0006 (third card): the repository's own risk classes, after the
    /// core; absent = none. Older definitions load without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_checklist: Option<Vec<ReviewChecklistClass>>,
    /// SL-4: git-ignored files (paths or globs, from the repository root)
    /// copied from the main checkout into every new card worktree; absent =
    /// none. Older definitions load without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_copy: Option<Vec<String>>,
    /// SL-4: the command run in every new card worktree before its Builder
    /// starts; absent = none. Older definitions load without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_setup: Option<String>,
    /// Skills hub H9 (R9, §5.6): `library.plySkills` — this workspace's
    /// explicit on/off for the skills that come with Plyloft; absent = no
    /// choice (each follows the team, then this Mac). Older definitions load
    /// without it; keys of `library` this build doesn't know are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<DefinitionLibrary>,
    /// 1.169.0 (A2): the models and efforts the team suggests per role and
    /// vendor (`team_models`); absent = none. Older definitions load without
    /// it, an older Plyloft keeps it as an unknown key, and a value of the
    /// wrong type reads as no suggestion.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub models: Option<crate::team_models::TeamModels>,
    /// 1.173.0 (B1): the parts of the repository that ship on their own
    /// (`areas.rs`); absent or empty = one implicit area with the values
    /// above, and nothing is written. Older definitions load without it; an
    /// older Plyloft keeps it as an unknown key. A list that breaks the rules
    /// (`areas::check`) reads as `AreasField::Invalid` and never makes the
    /// file unreadable: the refresh holds this one field ([`hold_bad_areas`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub areas: Option<crate::areas::AreasField>,
    /// 1.173.0 (G1): how a release goes by default in a repository without
    /// areas (each area has its own, `AreaDef::release_kind`) — where
    /// Release… and Ship batch start (Settings › Shipping). Absent = not
    /// chosen. Older definitions load without it and an older Plyloft keeps
    /// it as an unknown key. Kept as written (like `Workspace.shipVia`), so
    /// a kind a later Plyloft adds survives a publish here; the readers take
    /// only the kinds they know. A value of the wrong type reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub release_kind: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Skills hub H9: the definition's `library` object.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionLibrary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ply_skills: Option<crate::ply_skill_switch::Choices>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl DefinitionLibrary {
    /// The Plyloft choices it holds (none when absent).
    pub fn choices(library: Option<&DefinitionLibrary>) -> crate::ply_skill_switch::Choices {
        library
            .and_then(|l| l.ply_skills.as_ref())
            .map(crate::ply_skill_switch::Choices::normalized)
            .unwrap_or_default()
    }
}

impl WorkspaceDefinition {
    /// The definition carries build settings. Try it: `tryCommand` is a
    /// project field (it travels with them) but does not make one on its own —
    /// a definition holding only `tryCommand` is not a project definition, so
    /// it never applies a project part of defaults over this Mac's config.
    pub fn has_project(&self) -> bool {
        self.integration_branch.is_some()
            || self.version_files.is_some()
            || self.install_script.is_some()
            || self.verify_pipeline.is_some()
            || self.cache_paths.is_some()
            || self.shared_build_cache.is_some()
    }

    /// Every field concrete, so two definitions compare field by field:
    /// the integration branch resolved, project defaults filled in, an empty
    /// verify pipeline read as none, GitHub Issues without a repo read as
    /// Local (the same degrade `WorkspaceStore::create` applies).
    pub(crate) fn normalized(&self, default_branch: &str) -> Self {
        let mut out = self.clone();
        if out.board == KanbanSyncMode::GitHubIssues && out.github_owner_repo.is_none() {
            out.board = KanbanSyncMode::Local;
        }
        // ADR 0006 (third card), GH #111 F22: the review settings are shared
        // on their own, with or without a project part; absent = on, none.
        out.self_check.get_or_insert(true);
        out.review_checklist.get_or_insert_with(Vec::new);
        // SL-4: shared on their own too; empty means none, as absent does.
        out.worktree_copy = out.worktree_copy.take().filter(|l| !l.is_empty());
        out.worktree_setup = out
            .worktree_setup
            .take()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        // Skills hub H9: compared by the Plyloft choices alone, always
        // present, so "no choices" equals an absent `library`. Its other keys
        // are kept in the file by `overlay`, never compared or written here.
        out.library = Some(DefinitionLibrary {
            ply_skills: Some(DefinitionLibrary::choices(self.library.as_ref())),
            extra: BTreeMap::new(),
        });
        // 1.169.0 (A2): compared as its rows; "no suggestion" is an absent
        // `models`, so clearing every one removes the key (Challenger 9).
        out.models = self.models.as_ref().map(|m| m.normalized()).filter(|m| !m.is_empty());
        // 1.173.0 (B1): no areas is an absent `areas`, so clearing them all
        // removes the key and a repository without them compares as before.
        out.areas = match &self.areas {
            Some(crate::areas::AreasField::Valid(list)) => {
                Some(crate::areas::normalized(list)).filter(|a| !a.is_empty()).map(Into::into)
            }
            other => other.clone(),
        };
        // Try it: an empty start command means none, as absent does.
        out.try_command = out
            .try_command
            .take()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        if out.has_project() {
            out.integration_branch = Some(
                out.integration_branch
                    .clone()
                    .unwrap_or_else(|| default_branch.to_string()),
            );
            out.version_files.get_or_insert_with(Vec::new);
            out.cache_paths.get_or_insert_with(Vec::new);
            out.shared_build_cache.get_or_insert(true);
            if out.verify_pipeline.as_ref().is_some_and(|p| p.is_empty()) {
                out.verify_pipeline = None;
            }
        }
        out
    }
}

/// The shared fields, their JSON keys and the words a toast uses for them.
/// 1.174.0 (DS2): the Settings rows' names (`ROW_LABELS`, repositoryPage.ts),
/// so a toast and the `chore(config)` line say what the page says. Labels
/// only: nothing parses them back into a key.
pub const FIELDS: &[(&str, &str)] = &[
    ("name", "Name"),
    ("accentColor", "Accent color"),
    ("board", "Board"),
    ("githubOwnerRepo", "GitHub repository"),
    ("integrationBranch", "Cards go to"),
    ("versionFiles", "Version files"),
    ("installScript", "After a release, run"),
    ("tryCommand", "Start command"),
    ("verifyPipeline", "Checks before shipping"),
    ("cachePaths", "Cache paths"),
    ("sharedBuildCache", "Shared build cache"),
    ("selfCheck", "The Builder checks its own work first"),
    ("reviewChecklist", "Review checklist"),
    ("worktreeCopy", "Files copied into card worktrees"),
    ("worktreeSetup", "Before the Builder starts, run"),
    ("library", "Plyloft skills in this workspace"),
    ("models", "Suggested models and effort"),
    ("areas", "Areas"),
    ("releaseKind", "Default release"),
];

pub(crate) const PROJECT_FIELDS: &[&str] = &[
    "integrationBranch",
    "versionFiles",
    "installScript",
    "tryCommand",
    "verifyPipeline",
    "cachePaths",
    "sharedBuildCache",
];

pub(crate) fn is_project_field(key: &str) -> bool {
    PROJECT_FIELDS.contains(&key)
}

pub(crate) fn field_label(key: &str) -> &'static str {
    FIELDS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, label)| *label)
        .unwrap_or("definition")
}

pub(crate) fn to_map(def: &WorkspaceDefinition) -> Map<String, Value> {
    match serde_json::to_value(def) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub(crate) fn field_value(map: &Map<String, Value>, key: &str) -> Value {
    map.get(key).cloned().unwrap_or(Value::Null)
}

/// Why a repo file could not be used. `line` is serde's 1-based line when
/// the JSON itself is broken; `None` for a file that parses but is not a
/// definition this build can take (a newer `schemaVersion`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    pub path: String,
    pub line: Option<usize>,
    pub message: String,
    #[serde(default)]
    pub commit: Option<String>,
}

impl Unreadable {
    /// The Doctor row's words: "unreadable (line N)".
    pub fn summary(&self) -> String {
        match self.line {
            Some(line) => format!("unreadable (line {line})"),
            None => "unreadable".to_string(),
        }
    }

    /// 1.175.0 (C6, SC-9): the file holds a value this build doesn't know —
    /// a kind of check, of version file or of board a later Plyloft added
    /// (serde's "unknown variant"), or a `schemaVersion` above this build's
    /// — rather than broken JSON. Nothing there is to be fixed by hand: this
    /// computer needs the update. Read from the message, so a cache written
    /// by 1.174.5 says it too.
    pub fn newer(&self) -> bool {
        self.message.contains(UNKNOWN_VARIANT) || self.message.contains(NEWER_SCHEMA)
    }

    /// "<path> on <branch> was written by a newer Plyloft, so this Mac can't
    /// read all of it (line N). Update Plyloft on this Mac" — `None` when
    /// the file is broken and the older words apply.
    fn newer_lead(&self, branch: &str) -> Option<String> {
        if !self.newer() {
            return None;
        }
        let line = self.line.map(|n| format!(" (line {n})")).unwrap_or_default();
        Some(format!(
            concat!(
                "{} on {} was written by a newer Plyloft, so ",
                crate::this_machine!(),
                " can't read all of it{}. Update Plyloft on ",
                crate::this_machine!()
            ),
            self.path, branch, line
        ))
    }

    /// Round 2: [`Self::newer_sentence`] with what this build couldn't read
    /// after it — serde's own message, which names the value — for the
    /// Doctor row's detail. A kind typed wrong reads as a newer Plyloft's
    /// (they can't be told apart); the value named here is how it is found.
    pub fn newer_detail(&self, branch: &str, has_copy: bool) -> Option<String> {
        self.newer_sentence(branch, has_copy)
            .map(|sentence| format!("{sentence} What it couldn't read: {}.", self.message.trim_end_matches('.')))
    }

    /// What a publish that can't go and the Doctor say of a file a newer
    /// Plyloft wrote (`None`: the file is broken, the older words apply).
    /// `has_copy`: this computer read the file before and runs on that copy.
    pub fn newer_sentence(&self, branch: &str, has_copy: bool) -> Option<String> {
        let until = if has_copy {
            "Until then it keeps using the last good copy and publishes nothing."
        } else {
            "Until then it keeps its own settings and publishes nothing."
        };
        self.newer_lead(branch).map(|lead| format!("{lead}. {until}"))
    }

    /// What *Share* says of a file a newer Plyloft wrote (`None` as above).
    pub fn newer_share_refusal(&self, branch: &str) -> Option<String> {
        self.newer_lead(branch).map(|lead| format!("{lead}; Plyloft won't share a second one."))
    }
}

/// serde's words for a value of an enum this build has no variant for.
const UNKNOWN_VARIANT: &str = "unknown variant";
/// [`parse_definition`]'s words for a `schemaVersion` above this build's.
const NEWER_SCHEMA: &str = "was written by a newer Plyloft";

/// Parse a `workspace.json`. Unknown keys load; a `schemaVersion` above
/// [`DEFINITION_SCHEMA_VERSION`] does not, since its fields may mean
/// something this build would get wrong.
pub fn parse_definition(bytes: &[u8]) -> Result<WorkspaceDefinition, Unreadable> {
    let def: WorkspaceDefinition = serde_json::from_slice(bytes).map_err(|e| Unreadable {
        path: DEFINITION_PATH.to_string(),
        line: Some(e.line().max(1)),
        message: e.to_string(),
        commit: None,
    })?;
    // ADR 0006 (third card), GH #111 F3/F9: a checklist over its limits
    // makes the file unusable like any bad value — the cache keeps the last
    // good copy and the reason shows — instead of being quoted in part.
    if let Some(classes) = &def.review_checklist {
        if let Err(reason) = crate::project_config::validate_review_checklist(classes) {
            return Err(Unreadable {
                path: DEFINITION_PATH.to_string(),
                line: None,
                message: format!("reviewChecklist: {reason}"),
                commit: None,
            });
        }
    }
    // 1.175.0 (A8, SEC-10): a name git itself refuses (`git check-ref-format
    // --branch`: `areas::valid_branch`, as an area's branch is checked) is a
    // bad value like the one above — the last good copy stays in use and the
    // reason shows — rather than a name handed on to every fetch, push and
    // merge. An empty one is "none named", as before.
    if let Some(branch) = def.integration_branch.as_deref().filter(|b| !b.is_empty()) {
        if !crate::areas::valid_branch(branch) {
            return Err(Unreadable {
                path: DEFINITION_PATH.to_string(),
                line: None,
                message: format!("integrationBranch: {branch:?} is not a branch name git accepts"),
                commit: None,
            });
        }
    }
    if def.schema_version > DEFINITION_SCHEMA_VERSION {
        return Err(Unreadable {
            path: DEFINITION_PATH.to_string(),
            line: None,
            message: format!(
                "schemaVersion {} was written by a newer Plyloft (this one reads up to {})",
                def.schema_version, DEFINITION_SCHEMA_VERSION
            ),
            commit: None,
        });
    }
    Ok(def)
}

fn parse_legacy(bytes: &[u8]) -> Result<WorkspaceDefault, Unreadable> {
    serde_json::from_slice(bytes).map_err(|e| Unreadable {
        path: LEGACY_PATH.to_string(),
        line: Some(e.line().max(1)),
        message: e.to_string(),
        commit: None,
    })
}

/// `workspace_default.json` → `workspace.json`, field for field. The legacy
/// file never carried project config; `project` (the Mac's `config.json`)
/// supplies it so the converted definition describes the whole workspace.
/// `layoutPreset` is per user and does not travel.
pub fn from_legacy(
    legacy: &WorkspaceDefault,
    project: Option<&ProjectConfig>,
) -> WorkspaceDefinition {
    let mut def = WorkspaceDefinition {
        schema_version: DEFINITION_SCHEMA_VERSION,
        name: legacy.name.clone(),
        accent_color: legacy.accent_color.clone(),
        board: legacy.kanban_sync_mode,
        github_owner_repo: legacy.github_owner_repo.clone(),
        integration_branch: None,
        version_files: None,
        install_script: None,
        try_command: None,
        verify_pipeline: None,
        cache_paths: None,
        shared_build_cache: None,
        self_check: None,
        review_checklist: None,
        worktree_copy: None,
        worktree_setup: None,
        library: None,
        models: None,
        areas: None,
        release_kind: None,
        extra: BTreeMap::new(),
    };
    if let Some(cfg) = project {
        set_project_part(&mut def, cfg);
    }
    def
}

fn set_project_part(def: &mut WorkspaceDefinition, cfg: &ProjectConfig) {
    def.integration_branch = Some(cfg.target_branch.clone());
    def.version_files = Some(cfg.version_files.clone());
    def.install_script = cfg.install_script.clone();
    def.try_command = cfg.try_command.clone();
    def.verify_pipeline = cfg.verify_pipeline.clone();
    def.cache_paths = Some(cfg.cache_paths.clone());
    def.shared_build_cache = Some(cfg.shared_build_cache);
}

fn copy_project_part(to: &mut WorkspaceDefinition, from: &WorkspaceDefinition) {
    to.integration_branch = from.integration_branch.clone();
    to.version_files = from.version_files.clone();
    to.install_script = from.install_script.clone();
    to.try_command = from.try_command.clone();
    to.verify_pipeline = from.verify_pipeline.clone();
    to.cache_paths = from.cache_paths.clone();
    to.shared_build_cache = from.shared_build_cache;
}

/// What this Mac currently runs with, as a definition.
pub fn local_definition(
    ws: &Workspace,
    project: Option<&ProjectConfig>,
    review: &crate::project_config::ReviewSettings,
    worktree: &crate::worktree_setup::WorktreeSettings,
    ply_skills: &crate::ply_skill_switch::Choices,
    team_models: &crate::team_models::TeamModels,
    areas: &[crate::areas::AreaDef],
    release_kind: Option<String>,
) -> WorkspaceDefinition {
    let mut def = WorkspaceDefinition {
        schema_version: DEFINITION_SCHEMA_VERSION,
        name: ws.name.clone(),
        accent_color: ws.accent_color.clone(),
        board: ws.kanban_sync_mode,
        github_owner_repo: ws.github_owner_repo.clone(),
        integration_branch: None,
        version_files: None,
        install_script: None,
        try_command: None,
        verify_pipeline: None,
        cache_paths: None,
        shared_build_cache: None,
        // ADR 0006 (third card): wherever this Mac keeps them — the project
        // config, or `review.json` without one (GH #111 F22/F34).
        self_check: Some(review.self_check),
        review_checklist: Some(review.review_checklist.clone()),
        // SL-4: `worktree_setup.json`, the store a refresh keeps in step.
        worktree_copy: worktree.worktree_copy.clone(),
        worktree_setup: worktree.worktree_setup.clone(),
        // Skills hub H9: `ply_skills.json`, the store a refresh keeps in step.
        library: Some(DefinitionLibrary {
            ply_skills: Some(ply_skills.normalized()),
            extra: BTreeMap::new(),
        }),
        // 1.169.0 (A2): `team_models.json`, the store a refresh keeps in step.
        models: Some(team_models.normalized()).filter(|m| !m.is_empty()),
        // 1.173.0 (B1): `areas.json`, the store a refresh keeps in step.
        areas: Some(crate::areas::normalized(areas)).filter(|a| !a.is_empty()).map(Into::into),
        // 1.173.0 (G1): `areas.json` too, beside the areas.
        release_kind,
        extra: BTreeMap::new(),
    };
    if let Some(cfg) = project {
        set_project_part(&mut def, cfg);
    }
    def
}

/// The shared fields whose values differ between two normalized definitions.
/// Project fields count only when `target` shares a project part.
fn differing_fields(
    current: &WorkspaceDefinition,
    target: &WorkspaceDefinition,
) -> Vec<&'static str> {
    let a = to_map(current);
    let b = to_map(target);
    FIELDS
        .iter()
        .map(|(key, _)| *key)
        .filter(|key| !is_project_field(key) || target.has_project())
        .filter(|key| field_value(&a, key) != field_value(&b, key))
        .collect()
}

/// What this Mac runs with: the repo's definition with the pending fields laid
/// over it, normalized again — pending project fields over a repo copy that no
/// longer shares a project part take the rest of the part from this Mac's
/// config (`local`), never from defaults, so no field (the integration branch
/// above all) comes out empty.
fn effective_definition(
    repo_norm: &WorkspaceDefinition,
    pending: &BTreeMap<String, Value>,
    local: &WorkspaceDefinition,
    default_branch: &str,
) -> WorkspaceDefinition {
    let mut effective = overlay(repo_norm, pending);
    if effective.has_project() && !repo_norm.has_project() && local.has_project() {
        let local_map = to_map(local);
        let mut filled = to_map(&effective);
        for key in PROJECT_FIELDS {
            if !pending.contains_key(*key) {
                match local_map.get(*key) {
                    Some(value) => filled.insert(key.to_string(), value.clone()),
                    None => filled.remove(*key),
                };
            }
        }
        if let Ok(def) = serde_json::from_value(Value::Object(filled)) {
            effective = def;
        }
    }
    effective.normalized(default_branch)
}

/// `base` with the pending fields laid over it.
fn overlay(base: &WorkspaceDefinition, pending: &BTreeMap<String, Value>) -> WorkspaceDefinition {
    if pending.is_empty() {
        return base.clone();
    }
    let mut map = to_map(base);
    for (key, value) in pending {
        if value.is_null() {
            map.remove(key);
        } else if key == "library" && value.is_object() && map.get(key).is_some_and(Value::is_object) {
            // Skills hub H9: `library` is compared by the keys this build
            // knows (`normalized`); the ones it doesn't stay as the file has them.
            if let (Some(Value::Object(held)), Value::Object(new)) = (map.get_mut(key), value) {
                for (inner, inner_value) in new {
                    held.insert(inner.clone(), inner_value.clone());
                }
            }
        } else {
            map.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(Value::Object(map)).unwrap_or_else(|_| base.clone())
}

/// Where the cached definition came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DefinitionSource {
    #[default]
    Repo,
    /// Converted from `workspace_default.json`; not in the repo yet.
    Legacy,
    /// GH #81: seeded by Share from this Mac's config; its creation is
    /// queued for the integration branch and not there yet.
    Seeded,
}

/// Where local edits that are not in the repo yet stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PendingState {
    /// Queued for the write channel: not published yet (offline, or the
    /// publish has not run). Card 1's checkout states read as this.
    #[serde(alias = "writtenToCheckout", alias = "checkoutOutdated", alias = "stagedOutdated")]
    PendingSync,
    /// Every pending field waits in a pull request (the push was refused).
    WaitingForPr,
}

/// `projects/<workspace_id>/workspace_definition.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionCache {
    pub schema_version: u32,
    /// The last good copy read from the repo (or converted from legacy).
    #[serde(default)]
    pub definition: Option<WorkspaceDefinition>,
    #[serde(default)]
    pub source: DefinitionSource,
    /// The branch it was read from.
    #[serde(default)]
    pub branch: Option<String>,
    /// The last commit that touched the file, and its author.
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    /// When that commit was made (seconds). Absent in caches written before
    /// card #94, and whenever git could not say.
    #[serde(default)]
    pub changed_at: Option<i64>,
    #[serde(default)]
    pub refreshed_at: i64,
    /// Set while the repo's file cannot be used; the cache stays as it was.
    #[serde(default)]
    pub unreadable: Option<Unreadable>,
    /// Local edits not in the repo yet, as JSON field values keyed like the
    /// file (`null` = the field removed).
    #[serde(default)]
    pub pending: BTreeMap<String, Value>,
    #[serde(default)]
    pub pending_state: Option<PendingState>,
    /// GH #82: whether this Mac may write the shared definition.
    #[serde(default)]
    pub write_access: WriteAccess,
    /// 1.171.0 (X2): a definition GH #81's scan found on another branch,
    /// for that branch alone, and did not adopt — the board asks first.
    /// Absent in caches written before; only ever set without a definition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found_elsewhere: Option<FoundElsewhere>,
    /// 1.173.0 (B1 Challenger 1): shared fields the repository holds but
    /// this Mac can't use (today only `areas` that break the rules), keyed
    /// like the file. Every other field applies; this one is held. Absent
    /// in caches written before, and while nothing is wrong.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub field_problems: BTreeMap<String, FieldProblem>,
    /// 1.175.0 (C1, SC-2): the shared setup was on the branch and is gone
    /// from it, and the person hasn't chosen yet (`stop_sharing`). Only ever
    /// set without a definition. Absent in caches written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<crate::stop_sharing::Removed>,
    /// 1.175.0 (C1): this project's setup stopped being shared — pressed
    /// here, or kept after someone removed it. Cleared when it is shared
    /// again. Absent in caches written before, and while it is shared or
    /// never was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing: Option<crate::stop_sharing::Sharing>,
    /// 1.175.0 (C2, SC-1): the pull request that proposed moving the setup
    /// out of the older file was closed without merging. The conversion
    /// doesn't run by itself again (`workspace_adoption::may_convert_by_itself`);
    /// "Propose it again" clears it, and so does a read that finds the
    /// repository converted. Absent in caches written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversion_declined: Option<crate::workspace_adoption::ConversionDeclined>,
    /// 1.175.0 (C1 round 4): only the older file was found and git couldn't
    /// say whether the shared setup was removed (a shallow clone): it is
    /// read, nothing is converted by itself and nothing is said removed —
    /// Settings › Project › General keeps the press that proposes the move
    /// (round 5). Cleared by the next read git can answer. Absent in caches
    /// written before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub history_unread: bool,
    /// 1.175.0 (C5, SC-5): GitHub has no branch `branch` (the one the
    /// shared setup was read from) any more — renamed (`renamed_to`, as
    /// GitHub says) or deleted. Absent in caches written before, and while
    /// the branch is there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_gone: Option<BranchGone>,
}

/// C5: the shared setup's branch, gone from GitHub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchGone {
    pub branch: String,
    /// Its new name when GitHub renamed it; `None`: deleted, or GitHub
    /// couldn't say.
    #[serde(default)]
    pub renamed_to: Option<String>,
}

/// 1.173.0 (B1 Challenger 1): one held shared field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldProblem {
    /// Why it can't be used, for the Doctor and the Areas page.
    pub message: String,
    /// The repository's last good value, which this Mac keeps running with
    /// and compares edits against (`null`: none — a held field).
    #[serde(default)]
    pub kept: Value,
}

/// 1.173.0 (B1 Challenger 1): `repo_norm` with areas that break the rules
/// replaced by the last good ones, so nothing compares, applies or queues
/// the broken list — and `problems` saying so. The first time the list
/// breaks, `first_kept` gives the kept value: the refresh passes the areas
/// of the definition cached before this read (if they were good); readers
/// without an entry (B1 Challenger 2.4) pass this Mac's own copy
/// ([`areas_kept_here`]). Good areas clear the problem.
fn hold_bad_areas(
    repo_norm: &mut WorkspaceDefinition,
    problems: &mut BTreeMap<String, FieldProblem>,
    first_kept: impl FnOnce() -> Value,
) {
    let Some(message) = repo_norm.areas.as_ref().and_then(|a| a.problem()).map(str::to_string) else {
        problems.remove("areas");
        return;
    };
    let entry = problems
        .entry("areas".to_string())
        .or_insert_with(|| FieldProblem { message: message.clone(), kept: first_kept() });
    entry.message = message;
    repo_norm.areas = serde_json::from_value(entry.kept.clone()).ok().flatten();
}

/// The good areas of `previous` as a definition value (`null`: none, or
/// not good).
fn good_areas_of(previous: Option<&WorkspaceDefinition>, default_branch: &str) -> Value {
    previous
        .map(|d| d.normalized(default_branch))
        .filter(|d| d.areas.as_ref().is_none_or(|a| a.problem().is_none()))
        .map(|d| field_value(&to_map(&d), "areas"))
        .unwrap_or(Value::Null)
}

/// This Mac's copy of the areas as a definition value (`null`: none).
fn areas_kept_here(stores: &Stores<'_>, workspace_id: &str) -> Value {
    let list = crate::areas::load(stores.project_configs, workspace_id);
    if list.is_empty() { Value::Null } else { serde_json::to_value(list).unwrap_or(Value::Null) }
}

/// 1.171.0 (X2): a shared setup kept on a branch other than the one this
/// folder is on, which names that branch as its own (somebody's feature
/// branch, not the repository's integration branch). Adopting it would make
/// this folder's cards start from that branch, silently — so it is offered.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundElsewhere {
    /// Where the definition was found, and the branch it names.
    pub branch: String,
    /// Its Name.
    pub name: String,
    /// The branch this folder is on; `None` when it is on none (detached).
    #[serde(default)]
    pub here: Option<String>,
    /// The person's answer; `None` while the board still asks.
    #[serde(default)]
    pub answer: Option<ElsewhereAnswer>,
    /// 1.172.0 (B1): the other branches whose shared setups the scan found,
    /// each naming itself, after `branch` — the notice names them all and
    /// the person chooses which. Absent in caches written before (one).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub others: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ElsewhereAnswer {
    /// "Use the shared setup": the next refresh adopts it.
    Use,
    /// "Keep this folder's setup": not offered again for that branch.
    Keep,
}

/// GH #82: what this Mac knows about its write access to the repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WriteAccess {
    /// GitHub's `permissions.push` for the signed-in account, the last time
    /// it could say (`None`: never asked, not a GitHub repo, or no `gh`).
    #[serde(default)]
    pub can_push: Option<bool>,
    /// Milliseconds.
    #[serde(default)]
    pub checked_at: i64,
    /// The last publish was refused and no pull request could carry it.
    #[serde(default)]
    pub push_refused: Option<String>,
}

impl WriteAccess {
    /// Shared fields, Shared · Project Knowledge and project skills are
    /// read-only on this Mac.
    pub fn read_only(&self) -> bool {
        self.can_push == Some(false) || self.push_refused.is_some()
    }

    /// A fresh answer from GitHub. Only a grant — read access becoming write —
    /// clears an earlier refusal. A refusal while GitHub already said "push"
    /// (branch rules, other git credentials) stands until a publish gets
    /// through: an unchanged answer is no evidence it would now.
    pub fn record_permission(&mut self, can_push: bool) {
        let granted = can_push && self.can_push == Some(false);
        self.can_push = Some(can_push);
        self.checked_at = now_millis();
        if granted {
            self.push_refused = None;
        }
    }
}

/// Two-instance walk (C5): a refused push whose words say the account has
/// no write access (not a branch rule).
pub(crate) fn refused_for_access(error: &str) -> bool {
    let lower = error.to_lowercase();
    // Round 2 (review): git's and GitHub's own words, never a bare "403"
    // (a pull request number, a path).
    lower.contains("error: 403")
        || lower.contains("returned error: 403")
        || (lower.contains("permission to ") && lower.contains(" denied"))
        || lower.contains("write access to repository not granted")
}

/// The words for a change a read-only collaborator can't make.
pub fn read_only_error(what: &str) -> String {
    format!("{what} is set in the repository; ask for write access to change it.")
}

impl DefinitionCache {
    pub(crate) fn empty() -> Self {
        Self {
            schema_version: CACHE_SCHEMA_VERSION,
            definition: None,
            source: DefinitionSource::Repo,
            branch: None,
            commit: None,
            author: None,
            changed_at: None,
            refreshed_at: 0,
            unreadable: None,
            pending: BTreeMap::new(),
            pending_state: None,
            write_access: WriteAccess::default(),
            found_elsewhere: None,
            field_problems: BTreeMap::new(),
            removed: None,
            sharing: None,
            conversion_declined: None,
            history_unread: false,
            branch_gone: None,
        }
    }
}

/// Next to the workspace's `config.json`, so a removed workspace takes both.
pub fn cache_path(project_configs: &ProjectConfigStore, workspace_id: &str) -> PathBuf {
    project_configs
        .workspace_dir(workspace_id)
        .join(CACHE_FILENAME)
}

/// A missing or unparsable cache reads as none: the next refresh rebuilds it
/// from the repo.
///
/// 1.175.0 (A8, SC-10): one that doesn't parse held this computer's edits not
/// yet on the branch (`pending`), which the rebuild drops. It is kept aside
/// first (`workspace_definition.json.broken-<ms>`, never deleted — as the
/// publish queue beside it and `workspaces.json` are), so those values can
/// be read back by hand.
pub fn load_cache(
    project_configs: &ProjectConfigStore,
    workspace_id: &str,
) -> Option<DefinitionCache> {
    let path = cache_path(project_configs, workspace_id);
    let bytes = std::fs::read(&path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(cache) => Some(cache),
        Err(e) => {
            let mut aside = path.clone().into_os_string();
            aside.push(format!(".broken-{}", now_millis()));
            let aside = PathBuf::from(aside);
            match std::fs::rename(&path, &aside) {
                Ok(()) => log::warn!(
                    "workspace_definition: unreadable cache for {workspace_id} ({e}); kept aside as {}",
                    aside.display()
                ),
                // Round 3 (S4): a file something holds open (Windows) can't
                // be renamed — it is copied aside instead, once: it stays
                // where it is until the next save writes over it, and every
                // read until then comes back here.
                Err(held) => {
                    static COPIED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
                    let mut copied = COPIED.lock().unwrap_or_else(|p| p.into_inner());
                    if !copied.contains(&path) {
                        match std::fs::write(&aside, &bytes) {
                            Ok(()) => {
                                copied.push(path.clone());
                                log::warn!(
                                    "workspace_definition: unreadable cache for {workspace_id} ({e}); it couldn't be moved ({held}), so it was copied aside as {}",
                                    aside.display()
                                );
                            }
                            Err(copy) => log::warn!(
                                "workspace_definition: ignoring unreadable cache for {workspace_id} ({e}); it couldn't be kept aside: {held}; {copy}"
                            ),
                        }
                    }
                }
            }
            None
        }
    }
}

pub(crate) fn save_cache(
    project_configs: &ProjectConfigStore,
    workspace_id: &str,
    cache: &DefinitionCache,
) -> Result<(), String> {
    crate::atomic::write_atomic_json(&cache_path(project_configs, workspace_id), cache)
}

// ── The repository side ────────────────────────────────────────────────

/// A file as it is at a branch tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFile {
    pub bytes: Vec<u8>,
    pub commit: Option<String>,
    pub author: Option<String>,
    /// When that commit was made (seconds). Card #94's status line says how
    /// old the shared definition is, which the read time cannot tell.
    pub changed_at: Option<i64>,
}

/// 1.175.0 (C1 round 2, three answers since round 4): what a branch's
/// history says of a path that is not at its tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Deletion {
    /// It was never deleted there — or only before the commit the caller
    /// named (`since`): a setup stopped once and shared again.
    Never,
    /// It was deleted, by this commit, its author and when (seconds).
    Deleted(String, Option<String>, Option<i64>),
    /// Git can't say: a shallow clone doesn't hold the whole history, or git
    /// failed or took too long. Never read as "deleted": nothing local
    /// changes on it, and nothing is created on it either.
    CantSay,
}

/// Everything the definition needs from git, behind a trait so the refresh
/// logic is tested without a network. Reads only: the user's checkout is
/// never consulted or written (GH #80).
pub trait RepoSource {
    fn default_branch(&self) -> String;
    fn fetch(&self, branch: &str) -> Result<(), String>;
    /// `path` at the tip of `branch` (the fetched remote branch when there is
    /// one, the local branch otherwise). `None` when absent.
    fn read(&self, branch: &str, path: &str) -> Option<RepoFile>;
    /// 1.172.0 (B1): only the bytes of `path` at the tip of `branch` — the
    /// scan of origin's branches reads every one of them, so it skips the
    /// commit lookup [`Self::read`] makes.
    fn read_bytes(&self, branch: &str, path: &str) -> Option<Vec<u8>> {
        self.read(branch, path).map(|f| f.bytes)
    }
    /// The branch exists (fetched from origin, or locally).
    fn branch_exists(&self, branch: &str) -> bool;
    /// 1.175.0 (C1): whether `path` is at the tip of `branch` — `None` when
    /// git can't say, which is never read as "gone".
    fn carries(&self, branch: &str, path: &str) -> Option<bool> {
        Some(self.read_bytes(branch, path).is_some())
    }
    /// 1.175.0 (C1): the last commit on `branch` that touched `path` — the
    /// one that removed it, once it is gone — with its author and when
    /// (seconds). `None` when git can't say.
    fn last_touch(&self, _branch: &str, _path: &str) -> Option<(String, Option<String>, Option<i64>)> {
        None
    }
    /// 1.175.0 (C5): the name GitHub gives a branch now, when `branch` was
    /// renamed there (GitHub follows a renamed branch's old name). `None`:
    /// not renamed, deleted, or GitHub can't say. A read.
    fn renamed_to(&self, _branch: &str) -> Option<String> {
        None
    }
    /// teamfix round 2 (C3): whether one copy is older than another —
    /// `shared_config::copy_is_older` over this repository's git. Reads.
    fn ancestry(&self, _ancestor: &str, _descendant: &str) -> Option<bool> {
        None
    }
    fn moved_from(&self, _commit: &str) -> Option<String> {
        None
    }
    fn committed_at(&self, _commit: &str) -> Option<i64> {
        None
    }
    /// 1.175.0 (C1 round 2): whether the history of `branch` deleted `path`
    /// — asked where only the older file is found, or a copy read elsewhere
    /// names `branch`, so a removed setup isn't put back. `since`: a commit
    /// that wrote the setup after any earlier removal (the copy that names
    /// the branch) — a deletion that is its ancestor doesn't count.
    fn deletion(&self, _branch: &str, _path: &str, _since: Option<&str>) -> Deletion {
        Deletion::Never
    }
    /// GH #81: origin's branches carrying `path` at their fetched tip (all of
    /// them), most recently committed first — where a Mac with no cache and no config
    /// finds a definition kept on a branch other than the default.
    fn branches_with(&self, _path: &str) -> Vec<String> {
        Vec::new()
    }
    /// Bring origin's branch refs up to date before [`Self::branches_with`].
    fn fetch_branches(&self) -> Result<(), String> {
        Ok(())
    }
    /// 1.170.0 walk fix: the branch this folder is on, when it is on one —
    /// GH #81's scan looks there first, so two folders of one repository on
    /// two branches each take the definition of their own branch.
    fn current_branch(&self) -> Option<String> {
        None
    }
    /// 1.171.0 (X2): the folder's commit was built on `named` — it holds
    /// commits that are on origin's `named` and not on origin's default
    /// branch (a feature branch made from the team's `staging`). False when
    /// git can't say.
    fn built_on(&self, _named: &str) -> bool {
        false
    }
    /// Card #94: origin's branches, most recently committed first — what
    /// Settings offers as the integration branch. Empty when git can't say
    /// (no origin, offline with no refs), and the row then says so.
    fn branches(&self) -> Vec<String> {
        Vec::new()
    }
    /// 1.174.0 (Areas round 1): this computer's own branches, newest first —
    /// what an area's Cards go to offers with no `origin`, offline, or on a
    /// project kept on this Mac. No fetch.
    fn local_branches(&self) -> Vec<String> {
        Vec::new()
    }
    /// Card #94: the repository has an `origin` at all, so the row can tell
    /// "Ply couldn't read the branches" from "there are none to read".
    fn has_origin(&self) -> bool {
        false
    }
    /// GH #82: GitHub's `permissions.push` on origin's repository for this
    /// Mac's account. `None` when it can't say (offline, no `gh`, not GitHub).
    fn push_permission(&self) -> Option<bool> {
        None
    }
    /// GH #82: who last changed each shared field on `branch`, and when
    /// (seconds) — the read-only line in Settings › Project.
    fn field_provenance(
        &self,
        _branch: &str,
        _default_branch: &str,
    ) -> BTreeMap<String, FieldProvenance> {
        BTreeMap::new()
    }
}

/// GH #82: the last commit that changed one shared field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldProvenance {
    pub author: String,
    /// Seconds.
    pub changed_at: i64,
}


/// The real repository at a workspace's cwd.
pub struct GitRepo {
    pub cwd: PathBuf,
}

impl GitRepo {
    fn git(&self, args: &[&str]) -> Option<Vec<u8>> {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(&self.cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?;
        out.status.success().then_some(out.stdout)
    }

    fn git_with_stdin(&self, args: &[&str], input: &[u8]) -> Option<Vec<u8>> {
        use std::io::Write;
        let mut child = crate::platform::git_command()
            .args(args)
            .current_dir(&self.cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        let input = input.to_vec();
        // Written from its own thread: a large answer can fill stdout while
        // the queries are still going in.
        let writer = std::thread::spawn(move || stdin.write_all(&input));
        let out = child.wait_with_output().ok()?;
        let _ = writer.join();
        out.status.success().then_some(out.stdout)
    }

    fn git_text(&self, args: &[&str]) -> Option<String> {
        self.git(args)
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// Origin's branch names, most recently committed first, `HEAD` left out.
    fn origin_branches(&self) -> Vec<String> {
        let Some(refs) = self.git_text(&[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)",
            "refs/remotes/origin/",
        ]) else {
            return Vec::new();
        };
        refs.lines()
            .filter_map(|r| r.strip_prefix("refs/remotes/origin/"))
            .filter(|b| *b != "HEAD")
            .map(str::to_string)
            .collect()
    }

    fn ref_exists(&self, rev: &str) -> bool {
        self.git(&[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ])
        .is_some()
    }

    fn has_origin(&self) -> bool {
        self.git(&["remote", "get-url", "origin"]).is_some()
    }

    fn tip_ref(&self, branch: &str) -> Option<String> {
        let remote = format!("refs/remotes/origin/{branch}");
        if self.ref_exists(&remote) {
            return Some(remote);
        }
        let local = format!("refs/heads/{branch}");
        self.ref_exists(&local).then_some(local)
    }
}

/// The bound of [`GitRepo::deletion`]'s git calls.
const HISTORY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

type DeletionKey = (PathBuf, String, String, Option<String>);
/// What the histories said, per (repository, tip commit, path, since).
static DELETIONS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<DeletionKey, Deletion>>> =
    std::sync::LazyLock::new(Default::default);

impl RepoSource for GitRepo {
    fn branch_exists(&self, branch: &str) -> bool {
        self.tip_ref(branch).is_some()
    }

    fn ancestry(&self, ancestor: &str, descendant: &str) -> Option<bool> {
        crate::shared_config::Plumbing { cwd: self.cwd.clone() }.ancestry(ancestor, descendant)
    }

    fn moved_from(&self, commit: &str) -> Option<String> {
        crate::shared_config::Plumbing { cwd: self.cwd.clone() }.moved_from(commit)
    }

    fn committed_at(&self, commit: &str) -> Option<i64> {
        crate::shared_config::Plumbing { cwd: self.cwd.clone() }.committed_at(commit)
    }

    fn renamed_to(&self, branch: &str) -> Option<String> {
        // Unit tests never reach the real `gh` (as `push_permission`).
        if cfg!(test) {
            return None;
        }
        let git = crate::shared_config::Plumbing { cwd: self.cwd.clone() };
        let repo = git.github_repo()?;
        let gh = crate::shared_config::Gh::new(crate::doctor::require("gh").ok()?);
        gh.branch_name(&self.cwd, &repo, branch)
            .map_err(|e| log::info!("workspace_definition: what GitHub calls {branch} now is unknown: {e}"))
            .ok()
            .filter(|name| name != branch)
    }

    fn carries(&self, branch: &str, path: &str) -> Option<bool> {
        let tip = self.tip_ref(branch)?;
        // The tree's own listing: empty means the path isn't there, and a
        // git that failed gives no answer.
        let listed = self.git(&["ls-tree", "--name-only", "--full-tree", &tip, "--", path])?;
        Some(!String::from_utf8_lossy(&listed).trim().is_empty())
    }

    fn deletion(&self, branch: &str, path: &str, since: Option<&str>) -> Deletion {
        // Bounded, like the fetches: a history walk on a large repository
        // must not hold a refresh.
        let bounded = |args: &[&str]| -> Option<String> {
            let mut cmd = crate::platform::git_command();
            cmd.args(args).current_dir(&self.cwd).env("GIT_TERMINAL_PROMPT", "0");
            crate::worktrees::run_bounded(&mut cmd, "git history of the shared setup", HISTORY_TIMEOUT).ok()
        };
        let Some(tip) = self.tip_ref(branch).and_then(|tip| bounded(&["rev-parse", &tip])) else {
            return Deletion::CantSay;
        };
        // One answer per (repository, tip, path, since) for the process's
        // life: the history of a commit doesn't change. Only what git said.
        let key = (self.cwd.clone(), tip.clone(), path.to_string(), since.map(str::to_string));
        if let Some(known) = DELETIONS.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            return known.clone();
        }
        // A shallow clone doesn't hold the commit that deleted it.
        if bounded(&["rev-parse", "--is-shallow-repository"]).as_deref() != Some("false") {
            return Deletion::CantSay;
        }
        let pathspec = format!(":(top){path}");
        // `-m`: a deletion made only in a merge commit shows too.
        let Some(log) =
            bounded(&["log", "-1", "-m", "--diff-filter=D", "--format=%H%x00%an%x00%at", &tip, "--", &pathspec])
        else {
            return Deletion::CantSay;
        };
        let mut fields = log.lines().next().unwrap_or("").split('\0').map(str::trim);
        let answer = match fields.next().filter(|c| !c.is_empty()) {
            None => Deletion::Never,
            Some(commit) => {
                let deleted = Deletion::Deleted(
                    commit.to_string(),
                    fields.next().filter(|a| !a.is_empty()).map(str::to_string),
                    fields.next().and_then(|t| t.parse().ok()),
                );
                match since {
                    None => deleted,
                    // An older removal: the setup was written again after it.
                    Some(since) => match bounded(&["merge-base", commit, since]) {
                        Some(base) if base == commit => Deletion::Never,
                        Some(_) => deleted,
                        None => return Deletion::CantSay,
                    },
                }
            }
        };
        DELETIONS.lock().unwrap_or_else(|p| p.into_inner()).insert(key, answer.clone());
        answer
    }

    fn last_touch(&self, branch: &str, path: &str) -> Option<(String, Option<String>, Option<i64>)> {
        let tip = self.tip_ref(branch)?;
        let pathspec = format!(":(top){path}");
        let log = self.git_text(&["log", "-1", "--format=%H%x00%an%x00%at", &tip, "--", &pathspec])?;
        let mut fields = log.trim().split('\0').map(str::trim);
        let commit = fields.next().filter(|c| !c.is_empty())?.to_string();
        let author = fields.next().filter(|a| !a.is_empty()).map(str::to_string);
        let at = fields.next().and_then(|t| t.parse().ok());
        Some((commit, author, at))
    }

    fn push_permission(&self) -> Option<bool> {
        // Unit tests drive real git with GitHub-shaped origins: never reach
        // the real `gh api` (or the app's shell environment) from them.
        if cfg!(test) {
            return None;
        }
        let git = crate::shared_config::Plumbing {
            cwd: self.cwd.clone(),
        };
        let repo = git.github_repo()?;
        let gh = crate::shared_config::Gh::new(crate::doctor::require("gh").ok()?);
        gh.can_push(&self.cwd, &repo)
            .map_err(|e| log::info!("workspace_definition: push permission unknown: {e}"))
            .ok()
    }

    fn field_provenance(
        &self,
        branch: &str,
        default_branch: &str,
    ) -> BTreeMap<String, FieldProvenance> {
        let git = crate::shared_config::Plumbing {
            cwd: self.cwd.clone(),
        };
        let mut out = BTreeMap::new();
        let Some(tip) = self.tip_ref(branch) else {
            return out;
        };
        let values_at = |rev: &str| -> Map<String, Value> {
            git.read_at(rev, DEFINITION_PATH)
                .and_then(|bytes| parse_definition(&bytes).ok())
                .map(|def| to_map(&def.normalized(default_branch)))
                .unwrap_or_default()
        };
        for (sha, author, time) in git.history(&tip, DEFINITION_PATH) {
            let after = values_at(&sha);
            let before = values_at(&format!("{sha}^"));
            for (key, _) in FIELDS {
                if !out.contains_key(*key) && field_value(&after, key) != field_value(&before, key)
                {
                    out.insert(
                        key.to_string(),
                        FieldProvenance {
                            author: author.clone(),
                            changed_at: time,
                        },
                    );
                }
            }
            if out.len() == FIELDS.len() {
                break;
            }
        }
        out
    }

    fn default_branch(&self) -> String {
        if let Some(head) = self.git_text(&[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ]) {
            if let Some(branch) = head.strip_prefix("origin/") {
                return branch.to_string();
            }
        }
        for candidate in ["main", "master"] {
            if self.tip_ref(candidate).is_some() {
                return candidate.to_string();
            }
        }
        self.git_text(&["symbolic-ref", "--quiet", "--short", "HEAD"])
            .unwrap_or_else(|| "main".to_string())
    }

    fn fetch(&self, branch: &str) -> Result<(), String> {
        if !self.has_origin() {
            return Ok(());
        }
        crate::worktrees::fetch_origin_branch(&self.cwd, branch)
    }

    fn fetch_branches(&self) -> Result<(), String> {
        if !self.has_origin() {
            return Ok(());
        }
        crate::worktrees::fetch_origin_branches(&self.cwd)
    }

    fn current_branch(&self) -> Option<String> {
        self.git_text(&["symbolic-ref", "--quiet", "--short", "HEAD"])
    }

    fn built_on(&self, named: &str) -> bool {
        // Three local git calls, no fetch: the scan fetched origin's refs.
        let target = format!("refs/remotes/origin/{named}");
        let default = format!("refs/remotes/origin/{}", self.default_branch());
        if target == default || !self.ref_exists(&target) || !self.ref_exists(&default) {
            return false;
        }
        let Some(base) = self.git_text(&["merge-base", "HEAD", &target]) else {
            return false;
        };
        // Exit 1 (not an ancestor) is the only failure left: both refs and
        // the base exist.
        self.git(&["merge-base", "--is-ancestor", &base, &default]).is_none()
    }

    fn branches(&self) -> Vec<String> {
        self.origin_branches()
    }

    fn local_branches(&self) -> Vec<String> {
        let Some(refs) = self.git_text(&["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"])
        else {
            return Vec::new();
        };
        refs.lines().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string).collect()
    }

    fn has_origin(&self) -> bool {
        GitRepo::has_origin(self)
    }

    fn branches_with(&self, path: &str) -> Vec<String> {
        // Every branch, newest first — no cap, or an integration branch older
        // than the cap's worth of other branches would read as unshared.
        let branches = self.origin_branches();
        let branches: Vec<&str> = branches.iter().map(String::as_str).collect();
        if branches.is_empty() {
            return Vec::new();
        }
        // One `cat-file --batch-check` for all of them.
        let queries: String = branches
            .iter()
            .map(|b| format!("refs/remotes/origin/{b}:{path}\n"))
            .collect();
        let Some(answers) = self.git_with_stdin(&["cat-file", "--batch-check"], queries.as_bytes())
        else {
            return Vec::new();
        };
        branches
            .iter()
            .zip(String::from_utf8_lossy(&answers).lines())
            .filter(|(_, answer)| !answer.ends_with(" missing"))
            .map(|(b, _)| b.to_string())
            .collect()
    }

    fn read_bytes(&self, branch: &str, path: &str) -> Option<Vec<u8>> {
        let tip = self.tip_ref(branch)?;
        self.git(&["show", &format!("{tip}:{path}")])
    }

    fn read(&self, branch: &str, path: &str) -> Option<RepoFile> {
        let tip = self.tip_ref(branch)?;
        let bytes = self.git(&["show", &format!("{tip}:{path}")])?;
        // `:(top)`: the path is from the repository root, like `show` above,
        // even when the workspace is a subdirectory.
        let pathspec = format!(":(top){path}");
        let log = self.git_text(&["log", "-1", "--format=%H%x00%an%x00%at", &tip, "--", &pathspec]);
        let fields: Vec<&str> = log.as_deref().map(|l| l.split('\0').collect()).unwrap_or_default();
        let at = |i: usize| fields.get(i).map(|f| f.trim()).filter(|f| !f.is_empty());
        Some(RepoFile {
            bytes,
            commit: at(0).map(str::to_string),
            author: at(1).map(str::to_string),
            changed_at: at(2).and_then(|t| t.parse().ok()),
        })
    }
}

// ── Refresh ────────────────────────────────────────────────────────────

/// One field a refresh replaced on this Mac.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub label: String,
    /// The new value as the definition writes it, for the toast's body.
    pub value: Value,
    /// 1.173.0 (B1): the value this Mac had, for `areas` only (the toast
    /// names the areas that changed); absent otherwise.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub previous: Value,
}

/// The outcome of one refresh, and the event payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReport {
    pub workspace_id: String,
    pub moment: RefreshMoment,
    /// False when the repo has no definition at all (and none was cached).
    pub has_definition: bool,
    pub source: Option<DefinitionSource>,
    pub branch: Option<String>,
    pub author: Option<String>,
    pub commit: Option<String>,
    pub changes: Vec<FieldChange>,
    pub unreadable: Option<Unreadable>,
    /// Not fatal: the last fetched tip was read instead.
    pub fetch_error: Option<String>,
    pub pending_fields: Vec<String>,
    /// The cache's pending state after the refresh — it can change with no
    /// field changing (a publish), and the Doctor row follows it.
    pub pending_state: Option<PendingState>,
    /// What draining the publish queue did first, when there was a queue.
    #[serde(default)]
    pub publish: Option<PublishReport>,
    /// GH #82: this Mac can't write the shared definition.
    #[serde(default)]
    pub read_only: bool,
    /// GH #82: Knowledge notes and project skills that changed on the
    /// integration branch since the last refresh.
    #[serde(default)]
    pub library: Option<crate::shared_library_sync::LibraryReport>,
    /// T6 (team walk): this Mac had no definition cached before this read,
    /// so its `changes` set the workspace up rather than follow somebody's
    /// edit — the toast says "Set up from…", naming nobody.
    #[serde(default)]
    pub first_read: bool,
    /// 1.175.0 (C1): sharing stopped, or its pull request was closed —
    /// said once, as a toast. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing: Option<crate::stop_sharing::SharingNote>,
    /// WALKFIX-3 (re-run, item 5): C5's state as this read left it, so a
    /// read that finds the branch gone (or back) reloads the Board's notice
    /// even when nothing else changed (`definitionReadKey`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_gone: Option<BranchGone>,
}

/// The stores a refresh reads and writes.
pub struct Stores<'a> {
    pub workspaces: &'a WorkspaceStore,
    pub project_configs: &'a ProjectConfigStore,
    /// GH #81: whether this Mac may run a GitHub Issues board (the team
    /// licence gate). When it may not, a definition whose board is GitHub
    /// Issues leaves a Local board alone, and the board a Local Mac runs is
    /// never recorded as an edit of the shared one.
    pub github_board_allowed: bool,
}

/// GH #81: the board fields are held on this Mac — the definition (or an
/// edit) asks for GitHub Issues where the licence gate refuses it, and this
/// Mac's board is Local. Neither applied nor published.
fn board_held(stores: &Stores<'_>, local: &WorkspaceDefinition, target: &WorkspaceDefinition) -> bool {
    !stores.github_board_allowed
        && target.board == KanbanSyncMode::GitHubIssues
        && local.board != KanbanSyncMode::GitHubIssues
}

const BOARD_FIELDS: &[&str] = &["board", "githubOwnerRepo"];

/// Owner, 2026-10-20: the shared definition's Name fills in a workspace's name
/// only while the person never chose one. Applied without asking like every
/// other field otherwise, a definition never renames a workspace whose name
/// is the person's own — not at the first read, not at a teammate's later
/// rename — and its status line doesn't list Name then.
///
/// How a chosen name is told from the default: [`Workspace::name_chosen`],
/// set when a workspace is added with a name other than its folder's (Open
/// and Add name it after the folder by default) and when it is renamed here.
/// A workspace from before that mark (`None`) counts as named by the person
/// when its name is neither its folder's nor the shared Name this Mac last
/// read (`last_read`), which every refresh used to apply.
pub(crate) fn keeps_own_name(ws: &Workspace, last_read: Option<&WorkspaceDefinition>) -> bool {
    match ws.name_chosen {
        Some(chosen) => chosen,
        None => {
            crate::workspace::folder_name(&ws.cwd).as_deref() != Some(ws.name.as_str())
                && last_read.is_none_or(|def| def.name != ws.name)
        }
    }
}

/// The Name the repository's definition gives, with an edit of it still
/// pending laid over it.
fn shared_name(repo_norm: &WorkspaceDefinition, pending: &BTreeMap<String, Value>) -> String {
    match pending.get("name").and_then(Value::as_str) {
        Some(name) => name.to_string(),
        None => repo_norm.name.clone(),
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}


fn find_workspace(stores: &Stores<'_>, workspace_id: &str) -> Result<Workspace, String> {
    stores
        .workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

/// GH #81's scan order: `branches` (newest first) with the folder's own
/// branch `here`, when it is one of them, moved to the front.
fn own_branch_first(mut branches: Vec<String>, here: Option<&str>) -> Vec<String> {
    if let Some(at) = here.and_then(|h| branches.iter().position(|b| b == h)) {
        let own = branches.remove(at);
        branches.insert(0, own);
    }
    branches
}

/// 1.172.0 (B1): how many more branches than the first the notice about
/// shared setups elsewhere names — each is a button.
const MAX_ELSEWHERE_OTHERS: usize = 3;

/// What a read of the repo produced.
enum RepoRead {
    Definition(WorkspaceDefinition, RepoFile, String),
    Legacy(WorkspaceDefault, RepoFile, String),
    Unreadable(Unreadable),
    Missing,
}

fn read_repo(
    repo: &dyn RepoSource,
    branch: &str,
    fetch_error: &mut Option<String>,
    missing: &mut Vec<String>,
) -> RepoRead {
    if let Err(e) = repo.fetch(branch) {
        log::info!(
            "workspace_definition: fetch {branch} failed, reading the last fetched tip: {e}"
        );
        // 1.175.0 (C5, SC-5): origin answered and has no such branch — a
        // stale local ref may still show the old file, so this is the sign.
        if matches!(
            crate::shared_config::classify_fetch_error(branch, &e),
            crate::shared_config::FetchFailure::BranchMissing { .. }
        ) {
            missing.push(branch.to_string());
        }
        fetch_error.get_or_insert(e);
    }
    if let Some(file) = repo.read(branch, DEFINITION_PATH) {
        return match parse_definition(&file.bytes) {
            Ok(def) => RepoRead::Definition(def, file, branch.to_string()),
            Err(mut bad) => {
                bad.commit = file.commit;
                RepoRead::Unreadable(bad)
            }
        };
    }
    if let Some(file) = repo.read(branch, LEGACY_PATH) {
        return match parse_legacy(&file.bytes) {
            Ok(legacy) => RepoRead::Legacy(legacy, file, branch.to_string()),
            Err(mut bad) => {
                bad.commit = file.commit;
                RepoRead::Unreadable(bad)
            }
        };
    }
    RepoRead::Missing
}

/// Read the definition from the repo, keep the cache, and make this Mac's
/// stores match it. The single entry point for all four [`RefreshMoment`]s.
pub fn refresh_with(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    moment: RefreshMoment,
) -> Result<RefreshReport, String> {
    let ws = find_workspace(stores, workspace_id)?;
    let local_config = stores.project_configs.get(workspace_id);
    let cached = load_cache(stores.project_configs, workspace_id);
    // Round 3 (S4, SC-10): no cache was read — the first time, or one that
    // didn't parse and was kept aside.
    let no_cache = cached.is_none();
    // 1.173.0 (B1 Challenger 1): the last good areas, should the new read's break.
    let previous_def = cached.as_ref().and_then(|c| c.definition.clone());
    // Owner, 2026-10-20: read before this refresh replaces the cached copy.
    let own_name = keeps_own_name(&ws, cached.as_ref().and_then(|c| c.definition.as_ref()));
    let default_branch = repo.default_branch();
    let mut fetch_error = None;
    // C5: the branches origin said it doesn't have.
    let mut missing: Vec<String> = Vec::new();

    // Where to look, in order, until a branch has the file: the branch the
    // cached definition names; the branch that copy was actually read from
    // (a definition naming a branch without the file was kept from there,
    // and corrections land there); the default branch; and, before any
    // definition was cached, this Mac's configured target branch — a project
    // whose integration branch is not the default keeps its definition there.
    let cached_def = cached.as_ref().and_then(|c| c.definition.as_ref());
    // WALKFIX-1: a project that has or had a shared setup reads only its own
    // branches (`stop_sharing::own_branches`); `None` keeps the first read's
    // behaviour for a project that never had one.
    let own = crate::stop_sharing::own_branches(cached.as_ref(), &default_branch);
    let mut branches: Vec<String> = Vec::new();
    let candidates = [
        // Absent means the default branch, here as everywhere.
        cached_def.map(|d| {
            d.integration_branch
                .clone()
                .unwrap_or_else(|| default_branch.clone())
        }),
        cached_def.and(cached.as_ref().and_then(|c| c.branch.clone())),
        // Two-instance walk (C5): the cards' branch renamed on GitHub is read
        // under its new name (the same branch; `own_branches` has it too).
        cached
            .as_ref()
            .and_then(|c| c.branch_gone.as_ref())
            .and_then(|g| g.renamed_to.clone()),
        Some(default_branch.clone()),
        if cached_def.is_none() {
            local_config.as_ref().map(|c| c.target_branch.clone())
        } else {
            None
        },
    ];
    // WALKFIX-1: removed, stopped, kept here or gone without a copy left:
    // only its own branches, never the default branch or this Mac's target.
    let candidates: Vec<Option<String>> = match (&own, cached_def) {
        (Some(own), None) => own.iter().cloned().map(Some).collect(),
        _ => candidates.into_iter().collect(),
    };
    for branch in candidates.into_iter().flatten() {
        if !branch.is_empty() && !branches.contains(&branch) {
            branches.push(branch);
        }
    }
    let mut read = RepoRead::Missing;
    // WALKFIX-1: the branch the copy in use came from, before the hop below.
    let mut read_from: Option<String> = None;
    // Two-instance walk (C5): a branch GitHub no longer has may still show
    // its file from a stale local ref; kept only as the fallback, so the same
    // branch under its new name (read after it) wins when it has the file.
    let mut stale: Option<(RepoRead, String)> = None;
    for branch in &branches {
        let found = read_repo(repo, branch, &mut fetch_error, &mut missing);
        if matches!(found, RepoRead::Missing) {
            continue;
        }
        if missing.contains(branch) && own.is_some() {
            if stale.is_none() {
                stale = Some((found, branch.clone()));
            }
            continue;
        }
        // WALKFIX-1: another branch's file is taken only while a copy is in
        // use and it is that copy's (it names one of this project's branches).
        // Round 2 (review): never while one of this project's branches is
        // gone from GitHub (found missing now, or on record): a definition has
        // no id, and another project of the same repository naming that branch
        // would be adopted in silence. Only *Choose where cards go* and *Move
        // to …* (which publish and record the branch) change where it reads.
        // Two-instance walk (C3): the branch the copy in use names, read
        // before the one it was read from — an older copy there than the one
        // in use isn't the moved setup.
        if let (Some(cache), RepoRead::Definition(_, file, _)) = (cached.as_ref(), &found) {
            let in_use = RepoFile { bytes: Vec::new(), commit: cache.commit.clone(), author: None, changed_at: cache.changed_at };
            let older = older_copy(repo, file, &in_use) == Some(true);
            if older && cache.branch.as_deref() != Some(branch.as_str()) && cached_def.is_some() {
                log::info!("workspace_definition: {workspace_id}: the copy on {branch} is older than the one in use; not taken");
                continue;
            }
        }
        if let Some(own) = &own {
            let gone = own.iter().any(|o| missing.contains(o))
                || cached.as_ref().is_some_and(|c| c.branch_gone.is_some());
            let ours = own.contains(branch)
                || (cached_def.is_some()
                    && !gone
                    && matches!(&found, RepoRead::Definition(def, _, _)
                        if own.iter().any(|o| *o == def.integration_branch.clone().unwrap_or_else(|| default_branch.clone()))));
            if !ours {
                log::info!(
                    "workspace_definition: {workspace_id}: a setup on {branch} isn't this project's (it reads {own:?}); not adopted"
                );
                continue;
            }
        }
        read = found;
        read_from = Some(branch.clone());
        break;
    }
    if matches!(read, RepoRead::Missing) {
        if let Some((found, branch)) = stale {
            read = found;
            read_from = Some(branch);
        }
    }
    // GH #81: nothing on those branches and nothing cached — a Mac that has
    // never read this repo (no config naming its integration branch) looks
    // through origin's branches for a definition that names the branch it is
    // on, or whose named branch carries one. A copy on a feature branch alone
    // is not the repo's.
    // 1.171.0 (X2): what the scan found on another branch and left for the
    // person — `Some(None)` when it ran and found nothing to ask about.
    let mut elsewhere: Option<Option<FoundElsewhere>> = None;
    // WALKFIX-1: never for a project that had a setup (`own`).
    if matches!(read, RepoRead::Missing) && cached_def.is_none() && own.is_none() {
        // The refs as origin has them now (deleted branches pruned), not as
        // this clone last fetched. Offline, nothing is scanned: a stale ref
        // of a deleted branch must never be adopted.
        let mut unreadable: Option<Unreadable> = None;
        let asked = cached.as_ref().and_then(|c| c.found_elsewhere.clone());
        let scan = match repo.fetch_branches() {
            Ok(()) => true,
            Err(e) => {
                log::info!("workspace_definition: fetching origin's branches failed: {e}");
                fetch_error.get_or_insert(e);
                false
            }
        };
        // 1.170.0 walk fix: this folder's own branch first. Newest first
        // alone, two folders of one repository on two branches (each with
        // a definition naming itself) both took the newest branch's — its
        // name, its integration branch, its board.
        let here = repo.current_branch();
        let on_default = here.as_deref() == Some(default_branch.as_str());
        // Each candidate once, by the branch adopting it would follow
        // (`named`): a card branch carrying `staging`'s file is `staging`'s.
        let mut seen: Vec<String> = Vec::new();
        // (the branch to read it from, `named`, its Name) of each candidate
        // not adopted without a word, in scan order.
        let mut offers: Vec<(String, String, String)> = Vec::new();
        let mut adopt: Option<String> = None;
        let use_pending = asked
            .as_ref()
            .is_some_and(|a| a.answer == Some(ElsewhereAnswer::Use));
        for branch in own_branch_first(repo.branches_with(DEFINITION_PATH), here.as_deref())
            .into_iter()
            .filter(|_| scan)
        {
            if branches.contains(&branch) {
                continue;
            }
            // Bytes only: every branch carrying the file is read, so the
            // commit lookup waits for the one adopted (`read_repo` below).
            let Some(bytes) = repo.read_bytes(&branch, DEFINITION_PATH) else {
                continue;
            };
            let def = match parse_definition(&bytes) {
                Ok(def) => def,
                // Kept to report if no readable definition turns up: skipping
                // it silently would stall adoption (the file exists, so nobody
                // is asked) with no Doctor row saying why.
                Err(mut bad) => {
                    if unreadable.is_none() {
                        bad.commit = repo.read(&branch, DEFINITION_PATH).and_then(|f| f.commit);
                        unreadable = Some(bad);
                    }
                    continue;
                }
            };
            let named = def
                .integration_branch
                .clone()
                .unwrap_or_else(|| default_branch.clone());
            if seen.contains(&named) {
                continue;
            }
            let named_def = if named == branch {
                None
            } else {
                match repo.read_bytes(&named, DEFINITION_PATH) {
                    Some(bytes) => Some(parse_definition(&bytes).ok()),
                    None => continue,
                }
            };
            seen.push(named.clone());
            // 1.171.0 (X2): the branch adopting this would follow is `named`
            // (itself, or the hop below). Without a word when it is the
            // repository's — the default branch, the folder's own branch —
            // or the folder's branch was built on it (a teammate's feature
            // branch made from `staging`). Otherwise it is somebody else's
            // branch (walk 1.171 #1: walk-1170-rel, read directly or through
            // a card branch carrying its file) and adopting it would start
            // this folder's cards from there silently: the board asks.
            let own = named == default_branch
                || here.as_deref() == Some(named.as_str())
                // On the default branch nothing was built on another one
                // (`built_on` is false there): skip its git calls.
                || (!on_default && repo.built_on(&named));
            let chosen = asked
                .as_ref()
                .is_some_and(|a| a.branch == named && a.answer == Some(ElsewhereAnswer::Use));
            if own || chosen {
                adopt = Some(branch);
                break;
            }
            let name = named_def.flatten().map(|d| d.name).unwrap_or(def.name);
            offers.push((branch, named, name));
            // On the default branch nothing is adopted without a word once
            // there are two, and the notice names only so many: stop reading
            // (every refresh scans while no setup is in use) — unless a "Use
            // it" answer is still looking for its branch.
            if on_default && offers.len() > MAX_ELSEWHERE_OTHERS && !use_pending {
                break;
            }
        }
        // GH #81's team case: a fresh clone on the default branch takes the
        // integration branch's setup without a word — 1.172.0 (B1): only
        // when it is the one setup there is. With several (somebody's
        // feature branch naming itself beside `staging`), taking the newest
        // could start this folder's cards from the wrong one: it asks which.
        // An earlier "Keep this folder's setup" for that branch holds:
        // the others it was given with may have gone since (merged and
        // deleted), and the one left is not taken against the answer.
        let kept = |named: &str| {
            asked.as_ref().is_some_and(|a| {
                a.answer == Some(ElsewhereAnswer::Keep)
                    && (a.branch == named || a.others.iter().any(|o| o == named))
            })
        };
        if adopt.is_none() && on_default && offers.len() == 1 && !kept(&offers[0].1) {
            adopt = offers.pop().map(|(branch, _, _)| branch);
        }
        if let Some(branch) = adopt {
            read = read_repo(repo, &branch, &mut fetch_error, &mut missing);
        }
        let offer = offers.first().map(|(_, named, name)| {
            let others: Vec<String> = offers[1..]
                .iter()
                .map(|(_, other, _)| other.clone())
                .take(MAX_ELSEWHERE_OTHERS)
                .collect();
            // The answer holds for the branch it was given for; "Keep" for
            // every branch the notice named with it.
            let answer = asked
                .as_ref()
                .filter(|a| {
                    a.branch == *named
                        || (a.answer == Some(ElsewhereAnswer::Keep) && a.others.contains(named))
                })
                .and_then(|a| a.answer);
            FoundElsewhere {
                branch: named.clone(),
                name: name.clone(),
                here: here.clone(),
                answer,
                others,
            }
        });
        if scan {
            elsewhere = Some(offer.filter(|_| matches!(read, RepoRead::Missing)));
        }
        // Only the legacy file, on a branch other than the default (LYRA's
        // `workspace_default.json` on `staging`): the most recent carries it.
        if matches!(read, RepoRead::Missing) && scan {
            for branch in own_branch_first(repo.branches_with(LEGACY_PATH), here.as_deref()) {
                if branches.contains(&branch) {
                    continue;
                }
                match read_repo(repo, &branch, &mut fetch_error, &mut missing) {
                    found @ RepoRead::Legacy(..) => {
                        read = found;
                        break;
                    }
                    // Reported like an unreadable workspace.json, if nothing
                    // readable turns up.
                    RepoRead::Unreadable(bad) => {
                        unreadable.get_or_insert(bad);
                    }
                    _ => {}
                }
            }
        }
        if matches!(read, RepoRead::Missing) {
            if let Some(bad) = unreadable {
                read = RepoRead::Unreadable(bad);
            }
        }
    }
    // A repo copy whose integration branch (named, or the default when
    // absent) is not the branch it was read from is followed once. What that
    // branch holds wins — an unreadable file there included, so its error
    // shows instead of silently running the other branch's config; only a
    // branch without the file keeps the copy that named it.
    let named = match &read {
        RepoRead::Definition(def, _, branch) => Some(
            def.integration_branch
                .clone()
                .unwrap_or_else(|| default_branch.clone()),
        )
        .filter(|b| b != branch),
        _ => None,
    };
    if let Some(named) = named {
        let hop = read_repo(repo, &named, &mut fetch_error, &mut missing);
        // Two-instance walk (C3, owner 2026-11-10): a copy there older than
        // the one that points to it is the branch's old setup, not the moved
        // one — never taken as newer; the pointer's copy stays in use until
        // the current one is there.
        let older = match (&hop, &read) {
            (RepoRead::Definition(_, there, _), RepoRead::Definition(_, here, _)) => {
                older_copy(repo, there, here) == Some(true)
            }
            _ => false,
        };
        if !matches!(hop, RepoRead::Missing) && !older {
            read = hop;
        }
    }

    let mut report = RefreshReport {
        workspace_id: workspace_id.to_string(),
        moment,
        has_definition: false,
        source: None,
        branch: None,
        author: None,
        commit: None,
        changes: Vec::new(),
        unreadable: None,
        fetch_error,
        pending_fields: Vec::new(),
        pending_state: None,
        publish: None,
        read_only: false,
        library: None,
        first_read: cached_def.is_none(),
        sharing: None,
        branch_gone: None,
    };

    // 1.175.0 (C1, SC-2): where the setup was removed (or was on the branch
    // as `.atelier/workspace.json` and only the older file is left), the
    // older file is not converted again by itself — that conversion
    // publishes the file back.
    // Round 2: and on a computer that never read the setup (a fresh clone,
    // a project added again), the branch's history says whether it was
    // removed — then the older file is converted only on a press. The same
    // for a copy of the definition left on another branch than the one it
    // names, once that branch's history removed the file.
    let mut cached = cached;
    use crate::stop_sharing::{NamedBranch, OlderFile};
    let mut history_unread = false;
    let gone = match &read {
        RepoRead::Legacy(_, _, branch) => match crate::stop_sharing::older_file(repo, cached.as_ref(), branch) {
            OlderFile::Take => None,
            // Round 4: git can't say. Round 5: the older file is taken for
            // reading, as the others have it; nothing converts by itself.
            OlderFile::Unread => {
                history_unread = true;
                None
            }
            OlderFile::Leave => {
                read = RepoRead::Missing;
                None
            }
            OlderFile::Removed(gone) => Some(gone),
        },
        RepoRead::Definition(def, file, found_on) => {
            match crate::stop_sharing::named_branch(
                repo,
                cached.as_ref(),
                def.integration_branch.as_deref(),
                found_on,
                file.commit.as_deref(),
            ) {
                NamedBranch::Use => None,
                NamedBranch::Leave => {
                    read = RepoRead::Missing;
                    None
                }
                NamedBranch::Removed(gone) => Some(gone),
            }
        }
        _ => None,
    };
    if cached.as_ref().is_some_and(|c| c.history_unread) != history_unread {
        cached.get_or_insert_with(DefinitionCache::empty).history_unread = history_unread;
    }
    if let Some(gone) = gone {
        let mut cache = cached.take().unwrap_or_else(DefinitionCache::empty);
        report.sharing = crate::stop_sharing::let_go(
            stores,
            workspace_id,
            &mut cache,
            gone,
            crate::shared_config::now_millis() / 1000,
        );
        cached = Some(cache);
        read = RepoRead::Missing;
    }

    let mut cache = match (read, cached) {
        // 1.171.0 (X2): nothing adopted, but a setup found elsewhere is kept
        // for the board's question.
        (RepoRead::Missing, None) => match elsewhere.flatten() {
            Some(found) => {
                let mut cache = DefinitionCache::empty();
                cache.found_elsewhere = Some(found);
                cache
            }
            None => return Ok(report),
        },
        // The file went away (or the branch is unreachable): keep what was
        // cached, change nothing — except what a scan that ran found.
        (RepoRead::Missing, Some(mut cache)) => {
            if let Some(found) = elsewhere.filter(|_| cache.definition.is_none()) {
                cache.found_elsewhere = found;
            }
            // 1.175.0 (C1, SC-2): a setup that was on the branch and is
            // gone from it is removed — never created again from this copy.
            let said = crate::stop_sharing::file_gone(
                stores,
                repo,
                workspace_id,
                &mut cache,
                report.fetch_error.is_none(),
                crate::shared_config::now_millis() / 1000,
            );
            report.sharing = report.sharing.take().or(said);
            cache
        }
        (RepoRead::Unreadable(bad), cached) => {
            log::warn!(
                "workspace_definition: {} in {workspace_id} is {}: {}",
                bad.path,
                bad.summary(),
                bad.message
            );
            let mut cache = cached.unwrap_or_else(DefinitionCache::empty);
            cache.unreadable = Some(bad);
            cache
        }
        (RepoRead::Definition(def, file, branch), cached) => {
            let mut cache = cached.unwrap_or_else(DefinitionCache::empty);
            // Owner, 2026-11-10: what this computer had before it is shared
            // again — removed, stopped or kept here — and this Mac's board.
            let was_away = cache.removed.is_some() || cache.sharing.is_some();
            let board_now = (def.board != ws.kanban_sync_mode).then_some(def.board);
            let who = file.author.clone();
            cache.definition = Some(def);
            cache.found_elsewhere = None;
            cache.source = DefinitionSource::Repo;
            cache.branch = Some(branch);
            cache.commit = file.commit;
            cache.author = file.author;
            cache.changed_at = file.changed_at;
            cache.unreadable = None;
            // 1.175.0 (C1): someone shared it again — WALKFIX-1: only when
            // it is back on this project's own branch (a scan never runs
            // here, and another branch's file is never read by itself).
            let back_here = match (&own, &read_from) {
                (Some(own), Some(from)) => own.contains(from),
                _ => true,
            };
            if back_here {
                cache.removed = None;
                cache.sharing = None;
                // Owner, 2026-11-10: a teammate shared it again — said once,
                // as a toast with what changed (the board too, when it
                // differs from this Mac's). Never on the sharer's computer:
                // its Share cleared the state before this read.
                if was_away {
                    report.sharing = Some(crate::stop_sharing::SharingNote::SharedAgain { who, board: board_now });
                }
            }
            // C2: the repository was converted (here or by someone else).
            cache.conversion_declined = None;
            cache
        }
        (RepoRead::Legacy(legacy, file, branch), cached) => {
            let mut cache = cached.unwrap_or_else(DefinitionCache::empty);
            // The project part is converted from this Mac's config until it
            // has one, and kept from the cache after that, so a later local
            // edit is never mistaken for the repo's.
            let project_from = match (&cache.source, &cache.definition) {
                (DefinitionSource::Legacy, Some(prev)) if prev.has_project() => Some(prev.clone()),
                _ => None,
            };
            let mut def = from_legacy(&legacy, local_config.as_ref());
            // 1.173.0 (G1): a legacy file never carries a default release
            // kind; this Mac's own goes into the conversion rather than being
            // wiped by it.
            def.release_kind = crate::areas::load_release_kind(stores.project_configs, &ws.id);
            // 1.174.0 (C10, D6): nor areas; the ones kept on this Mac until
            // the setup was shared go into the conversion's commit.
            // Every later read of the legacy file keeps them from the cache
            // (a legacy file never carries areas), as the project part.
            let kept: Option<crate::areas::AreasField> = crate::areas::kept_here(stores.project_configs, &ws.id)
                .map(Into::into)
                .or_else(|| match (&cache.source, &cache.definition) {
                    (DefinitionSource::Legacy, Some(prev)) => prev.areas.clone(),
                    _ => None,
                });
            if kept.is_some() {
                def.areas = kept;
            }
            if let Some(prev) = project_from {
                copy_project_part(&mut def, &prev);
            }
            // Absent means the default branch; don't pin it in a conversion.
            if def.integration_branch.as_deref() == Some(default_branch.as_str()) {
                def.integration_branch = None;
            }
            // GH #81: a legacy file kept only on another branch, with no
            // config on this Mac to name it, belongs to that branch — the
            // conversion is published there, not onto the default branch.
            if !def.has_project() && branch != default_branch {
                def.integration_branch = Some(branch.clone());
            }
            cache.definition = Some(def);
            cache.found_elsewhere = None;
            cache.source = DefinitionSource::Legacy;
            cache.branch = Some(branch);
            cache.commit = file.commit;
            cache.author = file.author;
            cache.changed_at = file.changed_at;
            cache.unreadable = None;
            cache
        }
    };
    cache.schema_version = CACHE_SCHEMA_VERSION;
    // Round 3 (S4, SC-10): a cache rebuilt from nothing has no pending edit,
    // and the queue was then trimmed to match — this computer's edits not yet
    // on the branch went with the unreadable cache. They are in the publish
    // queue: taken back from it, they stay pending and are published.
    if no_cache && cache.pending.is_empty() {
        for (key, entry) in load_queue(stores.project_configs, workspace_id).fields {
            cache.pending.insert(key, entry.value);
        }
    }
    cache.refreshed_at = now_millis();
    // GH #82: read at every refresh, so a later grant unlocks the fields on
    // the next one; kept as it was when GitHub can't say.
    // 1.175.0 (C5, SC-5): the branch the shared setup was read from is gone
    // from GitHub (renamed or deleted) — not "the shared setup was removed"
    // (`stop_sharing::file_gone` asks only of a branch that is there). Said
    // until the setup moves; a rename's new name asked of GitHub once.
    // The branch it was read from, or the one its copy names (a read that
    // fell back to the default branch's copy of a setup that lived on a
    // branch now deleted).
    let named_gone = cache
        .definition
        .as_ref()
        .and_then(|d| d.normalized(&default_branch).integration_branch)
        .filter(|named| missing.contains(named));
    let gone_branch = cache.branch.clone().filter(|b| missing.contains(b)).or(named_gone);
    if let Some(branch) = gone_branch.or_else(|| cache.branch.clone()).filter(|_| cache.definition.is_some()) {
        if missing.contains(&branch) {
            let known = cache.branch_gone.as_ref().filter(|g| g.branch == branch).cloned();
            cache.branch_gone = Some(known.unwrap_or_else(|| BranchGone {
                renamed_to: repo.renamed_to(&branch).filter(|to| *to != branch),
                branch,
            }));
        } else if report.fetch_error.as_deref().is_none_or(|e| {
            // Two-instance walk (C5): the only failure was the old name GitHub
            // no longer has — the branch in use (its new name) answered.
            missing.iter().any(|m| {
                matches!(
                    crate::shared_config::classify_fetch_error(m, e),
                    crate::shared_config::FetchFailure::BranchMissing { .. }
                )
            })
        }) {
            cache.branch_gone = None;
        }
    }
    if cache.definition.is_some() {
        if let Some(can_push) = repo.push_permission() {
            cache.write_access.record_permission(can_push);
        }
    }

    report.has_definition = cache.definition.is_some();
    report.branch_gone = cache.branch_gone.clone();
    report.source = cache.definition.as_ref().map(|_| cache.source);
    report.branch = cache.branch.clone();
    report.author = cache.author.clone();
    report.commit = cache.commit.clone();
    report.unreadable = cache.unreadable.clone();
    report.read_only = cache.write_access.read_only();

    if let Some(repo_def) = cache.definition.clone() {
        // Owner, 2026-10-20: a workspace from before `nameChosen` keeps what
        // its first read decided (against the Name this Mac last applied),
        // so a rename of its own that later reaches the branch doesn't turn
        // it back into one that follows the shared Name.
        if ws.name_chosen.is_none() {
            stores.workspaces.set_name_chosen(&ws.id, Some(own_name))?;
        }
        let mut repo_norm = repo_def.normalized(&default_branch);
        // A pending edit the repo now carries is done.
        let repo_map = to_map(&repo_norm);
        cache
            .pending
            .retain(|key, value| field_value(&repo_map, key) != *value);
        // 1.173.0 (B1 Challenger 1): areas that break the rules are held,
        // after the line above so an edit of them made here stays pending.
        hold_bad_areas(&mut repo_norm, &mut cache.field_problems, || {
            good_areas_of(previous_def.as_ref(), &default_branch)
        });
        // 1.174.0 (C10, D6): the areas this Mac kept until the setup was
        // shared. The same list (Share's or the conversion's commit carried
        // it) becomes the repository's; another one is set aside here, for
        // the Board's sheet, and the repository's apply. Nothing is written
        // to the repository.
        let theirs: Option<Vec<crate::areas::AreaDef>> = if cache.field_problems.contains_key("areas") {
            None
        } else {
            Some(repo_norm.areas.as_ref().and_then(|a| a.valid()).map(<[_]>::to_vec).unwrap_or_default())
        };
        crate::areas::reconcile_shared(stores.project_configs, &ws.id, theirs.as_deref())?;
        let local = local_definition(&ws, local_config.as_ref(), &stores.project_configs.review(&ws.id), &crate::worktree_setup::load_settings(stores.project_configs, &ws.id), &crate::ply_skill_switch::load(stores.project_configs, &ws.id), &crate::team_models::load(stores.project_configs, &ws.id), &crate::areas::load(stores.project_configs, &ws.id), crate::areas::load_release_kind(stores.project_configs, &ws.id)).normalized(&default_branch);
        let effective = effective_definition(&repo_norm, &cache.pending, &local, &default_branch);
        let mut changed = differing_fields(&local, &effective);
        if board_held(stores, &local, &effective) {
            changed.retain(|key| !BOARD_FIELDS.contains(key));
        }
        // Owner, 2026-10-20: a name the person chose stays, and isn't listed.
        if own_name {
            changed.retain(|key| *key != "name");
        }
        // Try it: the start command this Mac kept without a config. A first
        // config from a repository that names none takes it over
        // (`apply_fields`) as this Mac's edit, queued for the branch. A
        // read-only Mac can't publish it, so the repository's "none" stands
        // now: the kept command and its approval go, and the change is said.
        let can_publish = !cache.write_access.read_only();
        let kept_try = local_config
            .is_none()
            .then(|| stores.project_configs.try_command(workspace_id))
            .flatten()
            .filter(|_| effective.has_project() && effective.try_command.is_none());
        let mut dropped_try = false;
        if let Some(command) = kept_try.as_deref().filter(|_| !can_publish) {
            stores.project_configs.set_try_command_stored(workspace_id, None)?;
            let mut worktree = crate::worktree_setup::load_settings(stores.project_configs, workspace_id);
            if worktree.approved_try.as_deref().map(str::trim) == Some(command.trim()) {
                worktree.approved_try = None;
                crate::worktree_setup::save_settings(stores.project_configs, workspace_id, &worktree)?;
            }
            dropped_try = true;
        }
        // 1.175.0 B2: checks or an install step that come from the branch
        // wait for this Mac's OK; what it ran until now stays allowed.
        crate::checks_consent::before_repository_apply(stores.project_configs, &ws.id, local_config.as_ref(), &changed, report.author.as_deref(), cache.changed_at, report.first_read, effective.has_project())?;
        apply_fields(stores, &ws, local_config.as_ref(), &effective, &changed)?;
        if let Some(command) = kept_try.filter(|_| can_publish) {
            if stores.project_configs.get(workspace_id).and_then(|c| c.try_command).as_deref() == Some(command.as_str()) {
                cache.pending.insert("tryCommand".to_string(), Value::String(command));
                let mut queue = load_queue(stores.project_configs, workspace_id);
                sync_queue(&cache, &mut queue, &default_branch);
                save_queue(stores.project_configs, workspace_id, &queue)?;
            }
        }
        if dropped_try && !changed.contains(&"tryCommand") {
            changed.push("tryCommand");
        }
        let effective_map = to_map(&effective);
        let local_map = to_map(&local);
        report.changes = changed
            .iter()
            .map(|key| FieldChange {
                field: key.to_string(),
                label: field_label(key).to_string(),
                value: field_value(&effective_map, key),
                // 1.173.0 (B1): the toast says which areas changed.
                previous: if *key == "areas" { field_value(&local_map, key) } else { Value::Null },
            })
            .collect();
    }
    // A queued field the repo now carries needs no publish. Its PR is left
    // as it is: the repo agrees with what the PR proposes for that field, and
    // the PR's state (merged, closed, open) is settled by the next drain
    // before anything it carries is republished.
    let mut queue = load_queue(stores.project_configs, workspace_id);
    if queue
        .fields
        .keys()
        .any(|key| !cache.pending.contains_key(key))
    {
        let dropped: Vec<PullRequest> = queue
            .fields
            .iter()
            .filter(|(key, _)| !cache.pending.contains_key(*key))
            .filter_map(|(_, entry)| entry.pull_request.clone())
            .collect();
        queue.fields.retain(|key, _| cache.pending.contains_key(key));
        // A PR whose every field reached the branch another way is still
        // open on GitHub: keep following it until a drain settles or
        // withdraws it.
        for pr in dropped {
            let still_carried = queue
                .fields
                .values()
                .any(|f| f.pull_request.as_ref().map(|p| p.number) == Some(pr.number));
            if !still_carried
                && !queue
                    .superseded_pull_requests
                    .iter()
                    .any(|p| p.number == pr.number)
            {
                queue.superseded_pull_requests.push(pr);
            }
        }
        save_queue(stores.project_configs, workspace_id, &queue)?;
    }
    cache.pending_state = pending_state_of(&cache, &queue);
    report.pending_fields = cache.pending.keys().cloned().collect();
    report.pending_state = cache.pending_state;
    save_cache(stores.project_configs, workspace_id, &cache)?;
    Ok(report)
}

/// Write `fields` of `target` into this Mac's stores.
fn apply_fields(
    stores: &Stores<'_>,
    ws: &Workspace,
    local_config: Option<&ProjectConfig>,
    target: &WorkspaceDefinition,
    fields: &[&str],
) -> Result<(), String> {
    if fields.is_empty() {
        return Ok(());
    }
    if fields.contains(&"name") {
        stores.workspaces.rename(&ws.id, target.name.clone())?;
    }
    if fields.contains(&"accentColor") {
        stores
            .workspaces
            .set_accent_color(&ws.id, target.accent_color.clone())?;
    }
    if fields.contains(&"board") || fields.contains(&"githubOwnerRepo") {
        // `normalized` already read GitHub Issues without a repo as Local.
        stores.workspaces.set_kanban_sync(
            &ws.id,
            target.board,
            target.github_owner_repo.clone(),
        )?;
    }
    if target.has_project() && fields.iter().any(|f| is_project_field(f)) {
        // A first config takes over the review settings kept without one.
        let review = stores.project_configs.review(&ws.id);
        let mut cfg = local_config.cloned().unwrap_or_else(|| ProjectConfig {
            schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
            target_branch: String::new(),
            version_files: Vec::new(),
            install_script: None,
            try_command: None,
            verify_pipeline: None,
            verify_script: None,
            cache_paths: Vec::new(),
            shared_build_cache: true,
            self_check: review.self_check,
            review_checklist: review.review_checklist,
            blocking_findings: review.blocking_findings,
            created_at: 0,
            updated_at: 0,
        });
        cfg.target_branch = target.integration_branch.clone().unwrap_or_default();
        cfg.version_files = target.version_files.clone().unwrap_or_default();
        cfg.install_script = target.install_script.clone();
        // Try it: a first config takes over the start command kept without
        // one (`try_command.json`) when the repository names none.
        cfg.try_command = target.try_command.clone().or_else(|| {
            local_config
                .is_none()
                .then(|| stores.project_configs.try_command(&ws.id))
                .flatten()
        });
        cfg.verify_pipeline = target.verify_pipeline.clone();
        cfg.verify_script = None;
        cfg.cache_paths = target.cache_paths.clone().unwrap_or_default();
        cfg.shared_build_cache = target.shared_build_cache.unwrap_or(true);
        stores.project_configs.set(&ws.id, cfg)?;
    }
    // ADR 0006 (third card): the review settings, wherever this Mac keeps
    // them (`parse_definition` refused a list over the limits).
    if fields.contains(&"selfCheck") || fields.contains(&"reviewChecklist") {
        let mut review = stores.project_configs.review(&ws.id);
        if fields.contains(&"selfCheck") {
            review.self_check = target.self_check.unwrap_or(true);
        }
        if fields.contains(&"reviewChecklist") {
            review.review_checklist = target.review_checklist.clone().unwrap_or_default();
        }
        stores.project_configs.set_review_settings(&ws.id, &review)?;
    }
    // SL-4: the worktree settings, kept beside this Mac's own answer to the
    // `.env` question (never shared).
    if fields.contains(&"worktreeCopy") || fields.contains(&"worktreeSetup") {
        let mut worktree = crate::worktree_setup::load_settings(stores.project_configs, &ws.id);
        if fields.contains(&"worktreeCopy") {
            worktree.worktree_copy = target.worktree_copy.clone();
        }
        if fields.contains(&"worktreeSetup") {
            worktree.worktree_setup = target.worktree_setup.clone();
        }
        crate::worktree_setup::save_settings(stores.project_configs, &ws.id, &worktree)?;
    }
    // 1.169.0 (A2): the team's suggested models, read at every spawn.
    if fields.contains(&"models") {
        crate::team_models::save(stores.project_configs, &ws.id, &target.models.clone().unwrap_or_default())?;
    }
    // 1.173.0 (B1): the areas, read by every card start and Ship.
    if fields.contains(&"areas") {
        // A held list (`hold_bad_areas`) never reaches here; one that did
        // would leave this Mac's last good copy as it is.
        match &target.areas {
            None => crate::areas::save(stores.project_configs, &ws.id, &[])?,
            Some(field) => {
                if let Some(list) = field.valid() {
                    crate::areas::save(stores.project_configs, &ws.id, list)?;
                }
            }
        }
    }
    // 1.173.0 (G1): the default release kind, where Release… starts.
    if fields.contains(&"releaseKind") {
        crate::areas::save_release_kind(stores.project_configs, &ws.id, target.release_kind.clone())?;
    }
    // Skills hub H9: the Plyloft choices, kept on this Mac for every launch.
    if fields.contains(&"library") {
        crate::ply_skill_switch::save(
            stores.project_configs,
            &ws.id,
            &DefinitionLibrary::choices(target.library.as_ref()),
        )?;
    }
    Ok(())
}

// ── Local edits ───────────────────────────────────────────────────────

/// What Settings › Project shows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionView {
    pub cache: DefinitionCache,
    /// The definition this Mac runs with: the repo's, with pending edits.
    pub effective: Option<WorkspaceDefinition>,
    pub default_branch: String,
    /// What waits for the write channel, per field: "Pending sync" or
    /// "Waiting for PR #N to merge".
    #[serde(default)]
    pub queue: PublishQueue,
    /// GH #82: the shared fields are read-only on this Mac.
    #[serde(default)]
    pub read_only: bool,
    /// GH #82: who set each field in the repo, for the read-only line. Only
    /// read when read-only.
    #[serde(default)]
    pub provenance: BTreeMap<String, FieldProvenance>,
    /// 1.173.0 (C3): shared settings both sides changed, waiting for the
    /// person's choice — only the difference.
    #[serde(default)]
    pub conflicts: Vec<crate::setting_conflict::SettingConflict>,
}

/// The file text a publish writes: `repo_def` as it is (unknown keys kept, an
/// unset integration branch left unset) with `fields` laid over it.
///
/// 1.175.0 (C6, SC-9): `written` is the file `repo_def` was read from (the
/// branch's own bytes; `None` when the publish creates it). What it holds
/// that this build's types don't know — a key inside one entry of
/// `versionFiles`, of `verifyPipeline`, of `reviewChecklist`, of
/// `library.plySkills` — is written back as it was wherever this publish
/// changes nothing ([`crate::definition_text`]). The types read the text
/// exactly as they read their own: when they wouldn't, their own is written.
pub(crate) fn file_text(
    repo_def: &WorkspaceDefinition,
    written: Option<&[u8]>,
    fields: &BTreeMap<String, Value>,
    default_branch: &str,
) -> String {
    let mut fields = fields.clone();
    if fields.get("integrationBranch").and_then(Value::as_str) == Some(default_branch)
        && repo_def.integration_branch.is_none()
    {
        fields.remove("integrationBranch");
    }
    let def = overlay(repo_def, &fields);
    let pretty = |def: &WorkspaceDefinition| {
        let mut text = serde_json::to_string_pretty(def).unwrap_or_else(|_| "{}".to_string());
        text.push('\n');
        text
    };
    let text = pretty(&def);
    let Some(bytes) = written else {
        return text;
    };
    // Round 2: when the kept text can't be used, say so — the keys this
    // build doesn't know are then not in what it writes.
    let not_kept = |why: &str| {
        log::warn!(
            "workspace_definition: writing this build's own text of {DEFINITION_PATH} — what a later Plyloft wrote inside its values is not kept in this publish ({why})"
        );
    };
    let Some(kept) = crate::definition_text::keeping(&text, &pretty(repo_def), bytes) else {
        not_kept("the file on the branch isn't JSON this build can lay its text over");
        return text;
    };
    match (parse_definition(kept.as_bytes()), parse_definition(text.as_bytes())) {
        (Ok(theirs), Ok(ours)) if theirs == ours => kept,
        (Err(bad), _) => {
            not_kept(&format!("the kept text doesn't read: {}", bad.message));
            text
        }
        _ => {
            not_kept("the kept text reads as another definition: a key it kept means something to this build under another name or place");
            text
        }
    }
}

/// Record whatever this Mac's stores now hold that the repo's definition does
/// not, after a local edit (Settings, rename, accent, board, project config),
/// and queue it for the write channel. No-op for a workspace without a
/// definition. Nothing is published here — [`publish_pending`] does that.
///
/// Project fields are recorded when the repo shares a project part, when an
/// earlier edit already added one, or when `share_project` (the definition
/// editor was handed one explicitly).
pub fn record_local_edit(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    share_project: bool,
) -> Result<Option<DefinitionView>, String> {
    record_local_edit_named(stores, repo, workspace_id, share_project, None)
}

/// [`record_local_edit`]. Owner, 2026-10-20: a workspace whose name is the
/// person's own ([`keeps_own_name`]) keeps it on this Mac only — its other
/// edits never publish it over the shared Name (a teammate may have renamed
/// it since) — unless `name_edit` is the Name this edit gives everyone: a
/// rename here, or the Repository page's Name. A read-only collaborator's
/// rename stays theirs, on this Mac.
pub(crate) fn record_local_edit_named(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    share_project: bool,
    name_edit: Option<String>,
) -> Result<Option<DefinitionView>, String> {
    let Some(mut cache) = load_cache(stores.project_configs, workspace_id) else {
        return Ok(None);
    };
    let Some(repo_def) = cache.definition.clone() else {
        return Ok(None);
    };
    let ws = find_workspace(stores, workspace_id)?;
    let default_branch = repo.default_branch();
    let mut repo_norm = repo_def.normalized(&default_branch);
    // 1.173.0 (B1 Challenger 1): a held list is compared as the kept one,
    // so only an edit of the areas made here is recorded.
    hold_bad_areas(&mut repo_norm, &mut cache.field_problems.clone(), || {
        areas_kept_here(stores, workspace_id)
    });
    let mut local = local_definition(&ws, stores.project_configs.get(workspace_id).as_ref(), &stores.project_configs.review(&ws.id), &crate::worktree_setup::load_settings(stores.project_configs, &ws.id), &crate::ply_skill_switch::load(stores.project_configs, &ws.id), &crate::team_models::load(stores.project_configs, &ws.id), &crate::areas::load(stores.project_configs, &ws.id), crate::areas::load_release_kind(stores.project_configs, &ws.id))
        .normalized(&default_branch);
    if keeps_own_name(&ws, Some(&repo_def)) {
        local.name = match name_edit.filter(|_| !cache.write_access.read_only()) {
            Some(name) => name,
            None => shared_name(&repo_norm, &cache.pending),
        };
    }
    let local_map = to_map(&local);
    let with_project = repo_norm.has_project()
        || share_project
        || cache.pending.keys().any(|key| is_project_field(key));
    let held = board_held(stores, &local, &repo_norm);
    let pending: BTreeMap<String, Value> = differing_fields(&repo_norm, &local)
        .into_iter()
        .filter(|key| !is_project_field(key) || with_project)
        .filter(|key| !held || !BOARD_FIELDS.contains(key))
        .map(|key| (key.to_string(), field_value(&local_map, key)))
        .collect();
    // GH #82: a read-only collaborator's edit of a shared field is put back
    // to what the repository (and anything already pending) says.
    if cache.write_access.read_only() {
        let edited: Vec<&str> = pending
            .iter()
            .filter(|(key, value)| cache.pending.get(*key) != Some(*value))
            .map(|(key, _)| key.as_str())
            .collect();
        if !edited.is_empty() {
            let restore =
                effective_definition(&repo_norm, &cache.pending, &local, &default_branch);
            let fields: Vec<&str> = FIELDS
                .iter()
                .map(|(key, _)| *key)
                .filter(|key| edited.contains(key))
                .collect();
            apply_fields(
                stores,
                &ws,
                stores.project_configs.get(workspace_id).as_ref(),
                &restore,
                &fields,
            )?;
            let labels: Vec<&str> = fields.iter().map(|key| field_label(key)).collect();
            // 1.174.0 (DS2): the rows' names say what happens ("Cards go
            // to"), so they are quoted rather than read as a noun.
            return Err(read_only_error(&format!("“{}”", labels.join("”, “"))));
        }
    }
    cache.pending = pending;
    let mut queue = load_queue(stores.project_configs, workspace_id);
    sync_queue(&cache, &mut queue, &default_branch);
    cache.pending_state = pending_state_of(&cache, &queue);
    // The queue first: a crash between the two leaves a queued value the next
    // drain re-derives from the cache, never a pending edit with no queue.
    save_queue(stores.project_configs, workspace_id, &queue)?;
    save_cache(stores.project_configs, workspace_id, &cache)?;
    Ok(Some(view(stores, workspace_id, cache, default_branch)))
}

/// The queue holds exactly the pending fields. A new entry remembers the
/// repository's value it replaces (`base`); a changed value keeps the base it
/// was first queued over, since the user never saw anything in between.
///
/// A pull request carries a group of fields as one commit. When any of them
/// changes value or is reverted, that PR no longer proposes what is queued:
/// it goes on the superseded list. The next drain settles it first — merged
/// or closed, the fields it still carries are done; open, they are
/// republished together with the edit onto its branch — and closes it once
/// the replacement is on the branch or nothing is left to propose.
fn sync_queue(cache: &DefinitionCache, queue: &mut PublishQueue, default_branch: &str) {
    let repo_map = cache
        .definition
        .as_ref()
        .map(|def| to_map(&def.normalized(default_branch)))
        .unwrap_or_default();
    let now = crate::shared_config::now_millis();
    let stale: BTreeMap<u64, PullRequest> = queue
        .fields
        .iter()
        .filter(|(key, entry)| cache.pending.get(*key) != Some(&entry.value))
        .filter_map(|(_, entry)| entry.pull_request.clone())
        .map(|pr| (pr.number, pr))
        .collect();
    // Only the fields that changed leave the PR here. The ones it still
    // carries keep their marker until a drain knows the PR's state: merged or
    // closed settles them (never republished over what came after), open
    // republishes them with the edit onto its branch.
    for (key, entry) in queue.fields.iter_mut() {
        if cache.pending.get(key) != Some(&entry.value) {
            entry.pull_request = None;
        }
    }
    // Round 3 (S4): the replacement takes a name of its own (the branch is
    // never forced, so the superseded one's name can't carry it, and seeding
    // the sequence with it grew `…-2-2-2`); the superseded pull request is
    // closed from this list once its replacement is out.
    for pr in stale.values() {
        if !queue
            .superseded_pull_requests
            .iter()
            .any(|p| p.number == pr.number)
        {
            queue.superseded_pull_requests.push(pr.clone());
        }
    }
    queue.fields.retain(|key, _| cache.pending.contains_key(key));
    // An edit while the file's creation waits in a PR: that PR creates the
    // file without it, and a second PR would create it too (an add/add
    // conflict). The creation is republished with the edit onto its branch.
    let edited_outside_a_pr = cache.pending.iter().any(|(key, value)| {
        queue
            .fields
            .get(key)
            .is_none_or(|entry| entry.value != *value || entry.pull_request.is_none())
    });
    if edited_outside_a_pr {
        if let Some(pr) = queue.create_pull_request.take() {
            queue.create_definition = true;
            if !queue
                .superseded_pull_requests
                .iter()
                .any(|p| p.number == pr.number)
            {
                queue.superseded_pull_requests.push(pr);
            }
        }
    }
    for (key, value) in &cache.pending {
        match queue.fields.get_mut(key) {
            Some(entry) if entry.value == *value => {}
            Some(entry) => {
                entry.value = value.clone();
                entry.queued_at = now;
                entry.attempts = 0;
                entry.last_error = None;
                // 1.173.0 (C3): a new value is a new question; the next
                // drain asks it again if the branch still differs.
                entry.conflict = None;
            }
            None => {
                queue.fields.insert(
                    key.clone(),
                    QueuedField {
                        value: value.clone(),
                        base: field_value(&repo_map, key),
                        base_commit: cache.commit.clone(),
                        queued_at: now,
                        attempts: 0,
                        last_error: None,
                        pull_request: None,
                        conflict: None,
                        use_mine: None,
                        proposed: Vec::new(),
                    },
                );
            }
        }
    }
}

/// Close superseded pull requests other than `keep` (the PR the replacement
/// went into). One that can't be closed now stays listed for the next drain.
fn withdraw_superseded(
    publisher: &dyn Publisher,
    queue: &mut PublishQueue,
    keep: Option<u64>,
    report: &mut PublishReport,
) {
    let listed = std::mem::take(&mut queue.superseded_pull_requests);
    for pr in listed {
        if Some(pr.number) == keep {
            continue;
        }
        // Fields still waiting on its state: not ours to close yet.
        if queue
            .fields
            .values()
            .any(|f| f.pull_request.as_ref().map(|p| p.number) == Some(pr.number))
        {
            queue.superseded_pull_requests.push(pr);
            continue;
        }
        match publisher.close_pull_request(&pr) {
            Ok(()) => {
                if !report.withdrawn_pull_requests.contains(&pr.number) {
                    report.withdrawn_pull_requests.push(pr.number);
                }
            }
            Err(e) => {
                log::warn!("workspace_definition: withdrawing PR #{} failed: {e}", pr.number);
                queue.superseded_pull_requests.push(pr);
            }
        }
    }
}

fn pending_state_of(cache: &DefinitionCache, queue: &PublishQueue) -> Option<PendingState> {
    if cache.pending.is_empty() {
        // Only the file's creation is outstanding.
        return if queue.create_pull_request.is_some() {
            Some(PendingState::WaitingForPr)
        } else if queue.create_definition {
            Some(PendingState::PendingSync)
        } else {
            None
        };
    }
    if queue.create_pull_request.is_none() && queue.create_definition {
        return Some(PendingState::PendingSync);
    }
    let all_in_prs = cache.pending.keys().all(|key| {
        queue
            .fields
            .get(key)
            .is_some_and(|field| field.pull_request.is_some())
    });
    Some(if all_in_prs {
        PendingState::WaitingForPr
    } else {
        PendingState::PendingSync
    })
}

/// What one drain of the publish queue did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishReport {
    pub branch: String,
    /// Fields the branch now carries.
    pub published: Vec<String>,
    /// The commit this drain pushed, when it pushed one.
    pub commit: Option<String>,
    /// Other authors' values it replaced.
    pub overrides: Vec<crate::shared_config::Override>,
    /// The pull request a refused push opened, and its fields.
    pub pull_request: Option<PullRequest>,
    pub pull_request_fields: Vec<String>,
    /// Pull requests closed without merging: their values were dropped and
    /// the repository's came back.
    pub closed_pull_requests: Vec<u64>,
    /// 1.175.0 (C4, SC-4): this computer's creation pull request wasn't
    /// needed any more — the setup was shared from another computer first.
    /// Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_first: Option<SharedFirst>,
    /// 1.175.0 (C4): the kind of the failure in `error`. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trouble: Option<crate::shared_config::PublishTrouble>,
    /// 1.175.0 (C2): which of those was the conversion of the older file —
    /// the toast says the setup stays there. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversion_declined: Option<u64>,
    /// Superseded pull requests Ply closed: what they proposed was reverted or
    /// replaced.
    pub withdrawn_pull_requests: Vec<u64>,
    pub error: Option<String>,
    /// The remote couldn't be reached; everything stays queued.
    pub offline: bool,
    /// 1.173.0 (C3): fields held because the branch's value changed since
    /// this Mac's edit — each waits for *Keep theirs* or *Use this Mac's*
    /// ([`DefinitionView::conflicts`]). Absent in older reports.
    #[serde(default)]
    pub conflicts: Vec<String>,
}

/// Drain the workspace's publish queue through `publisher`: settle waiting
/// pull requests, then publish every other queued field (and a queued
/// creation of the file) in one commit. The cache follows what the branch now
/// holds; whatever didn't make it stays queued with its error. `None` when
/// there was nothing to publish.
/// C5 round 2: a close that failed for a reason that passes — the network,
/// a timeout, GitHub's own trouble (HTTP 5xx), a rate limit — is "no
/// answer": tried again, nothing said. Only GitHub's refusal (`HTTP 401`,
/// `HTTP 403`, `error: 403`, a GraphQL "not accessible") is a refusal.
pub(crate) fn close_got_no_answer(error: &str) -> bool {
    let lower = error.to_lowercase();
    let refused = ["http 401", "http 403", "error: 403", "error: 401", "(http 403)", "(http 401)", "resource not accessible", "must have admin rights", "permission"]
        .iter()
        .any(|w| lower.contains(w))
        && !lower.contains("rate limit");
    if refused {
        return false;
    }
    let passing = lower.contains("rate limit")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("deadline exceeded")
        || ["http 500", "http 502", "http 503", "http 504", "(http 5", "error: 50"].iter().any(|w| lower.contains(w))
        || crate::shared_config::classify_trouble(error, true) == crate::shared_config::PublishTrouble::Network;
    passing
}

/// 1.175.0 (C4, SC-4): what became of this computer's creation pull request
/// once the setup arrived from another computer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFirst {
    pub number: u64,
    pub url: String,
    /// Who shared it (the file's last commit), when git can say.
    pub who: Option<String>,
    pub outcome: SharedFirstOutcome,
}

/// C4 round 2: what became of it. Each is said once; a close nobody
/// answered (offline, a timeout) is tried again at the next drain, silently.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SharedFirstOutcome {
    /// Plyloft closed it.
    #[default]
    Closed,
    /// GitHub refused the close: it is left open, no longer followed, and
    /// named (close it there).
    Refused,
    /// It isn't this computer's in origin's repository now (the repository
    /// changed, or the head branch is another): left as it is, no longer
    /// followed — never closed or opened here as if it were ours.
    NotOurs,
}

/// teamfix round 2 (C3): `there` (a copy on another branch) is older than
/// `here` (the copy in use or pointing to it) — by the move trailer, then
/// ancestry, then committer time; `None` when nothing can say.
fn older_copy(repo: &dyn RepoSource, there: &RepoFile, here: &RepoFile) -> Option<bool> {
    let (Some(a), Some(b)) = (there.commit.as_deref(), here.commit.as_deref()) else {
        return None;
    };
    crate::shared_config::copy_is_older(
        a,
        b,
        &|x, y| repo.ancestry(x, y),
        &|c| repo.moved_from(c),
        &|c| repo.committed_at(c),
    )
}

/// C3 (owner, 2026-11-10; teamfix round 2): after a published change of
/// "Cards go to", the whole current definition goes onto the branch it
/// names now (one commit, `replace_whole`, the [`MOVED_FROM_TRAILER`] naming
/// the copy moved), replacing only a copy there **older** than this one
/// (`older_copy`, checked again by the channel). Never a pull request. A
/// copy there that isn't older (newer, or nothing can say) is not replaced:
/// the fields that differ are queued so the next publish asks the C3
/// question about them. A move that doesn't land is left to the person's
/// next publish: the fields that differ are queued (against what the branch
/// has, so they go without a question) and the bar says why.
///
/// [`MOVED_FROM_TRAILER`]: crate::shared_config::MOVED_FROM_TRAILER
fn move_with_current_values(
    publisher: &dyn Publisher,
    repo: &dyn RepoSource,
    cache: &mut DefinitionCache,
    queue: &mut PublishQueue,
    from: &str,
    default_branch: &str,
    now_secs: i64,
) {
    let Some(current) = cache.definition.clone() else { return };
    let to = current
        .normalized(default_branch)
        .integration_branch
        .unwrap_or_else(|| default_branch.to_string());
    if to == from || cache.branch_gone.is_some() || !repo.branch_exists(&to) {
        return;
    }
    let source = RepoFile { bytes: Vec::new(), commit: cache.commit.clone(), author: None, changed_at: cache.changed_at };
    let there = repo.read(&to, DEFINITION_PATH);
    let theirs = there.as_ref().and_then(|f| parse_definition(&f.bytes).ok());
    // Nothing there: created only where that branch's history never removed
    // it (C1's rule — a removed setup is never put back by itself).
    if there.is_none() && repo.deletion(&to, DEFINITION_PATH, cache.commit.as_deref()) != Deletion::Never {
        log::info!("workspace_definition: {to}'s history removed the shared setup; not moved there by itself");
        return;
    }
    if let Some(file) = &there {
        if older_copy(repo, file, &source) != Some(true) {
            log::info!("workspace_definition: {to} holds a copy that isn't older; not replaced — the differing fields are asked about");
            queue_differences(cache, queue, &current, theirs.as_ref(), default_branch, true);
            return;
        }
    }
    let none = BTreeMap::new();
    match publisher.publish(&PublishRequest {
        branch: &to,
        default_branch,
        fields: &none,
        create_from: Some(&current),
        now_secs,
        pull_request_branch: "",
        project_fill: None,
        device: None,
        replaces: &[],
        replace_whole: true,
        moved_from: cache.commit.as_deref(),
        no_pull_request: true,
    }) {
        PublishOutcome::Published { commit, definition, pushed: true, .. } => {
            cache.definition = Some(definition);
            cache.branch = Some(to);
            cache.commit = Some(commit);
            cache.changed_at = Some(now_secs);
        }
        PublishOutcome::Failed(e) if e.contains(crate::shared_config::NEWER_COPY_MARKER) => {
            queue_differences(cache, queue, &current, theirs.as_ref(), default_branch, true);
        }
        other => {
            log::warn!("workspace_definition: moving the shared setup to {to} didn't land: {other:?}");
            let words = match other {
                PublishOutcome::Failed(e) | PublishOutcome::Unreachable(e) => e,
                _ => format!("{to} didn't take the shared setup"),
            };
            queue_differences(cache, queue, &current, theirs.as_ref(), default_branch, false);
            queue.last_error = Some(words);
        }
    }
}

/// teamfix round 2: the fields where this computer's `current` setup and the
/// copy on the new branch differ, queued for the next publish there — `ask`:
/// measured against this computer's value, so the C3 question comes;
/// otherwise against the branch's, so they go without one.
fn queue_differences(
    cache: &mut DefinitionCache,
    queue: &mut PublishQueue,
    current: &WorkspaceDefinition,
    theirs: Option<&WorkspaceDefinition>,
    default_branch: &str,
    ask: bool,
) {
    let mine = to_map(&current.normalized(default_branch));
    let theirs = theirs.map(|t| to_map(&t.normalized(default_branch))).unwrap_or_default();
    let now = crate::shared_config::now_millis();
    for (key, value) in &mine {
        if key == "integrationBranch" {
            continue;
        }
        let there = field_value(&theirs, key);
        if there == *value {
            continue;
        }
        cache.pending.insert(key.clone(), value.clone());
        queue.fields.insert(
            key.clone(),
            QueuedField {
                value: value.clone(),
                base: if ask { value.clone() } else { there },
                base_commit: cache.commit.clone(),
                queued_at: now,
                attempts: 0,
                last_error: None,
                pull_request: None,
                conflict: None,
                use_mine: None,
                proposed: Vec::new(),
            },
        );
    }
}

/// What GitHub says now of the pull requests the queue waits on — the
/// fields', the creation's (Share, a conversion) and the superseded ones —
/// and what that settles here. Reads GitHub only (`gh pr view`), writes
/// nothing there. Returns the superseded pull request GitHub couldn't say
/// (nothing may publish until it can) and the creation's state. Windows
/// walk: a page read runs it too (`page_read`), so "closed without merging"
/// isn't left for the next ten-minute read.
fn settle_waiting(
    publisher: &dyn Publisher,
    queue: &mut PublishQueue,
    cache: &mut DefinitionCache,
    report: &mut PublishReport,
    page: bool,
) -> (Option<u64>, Option<PrState>) {
    // winfix follow-up: a page read holds the workspace lock while it asks —
    // at most PAGE_READ_PR_ASKS, and none after one that got no answer
    // (offline: each is bounded at a minute). The drain asks of every one.
    let mut asked = 0usize;
    // Pull requests: merged, the branch has the value (the refresh that
    // follows reads it); closed, the value is dropped and the repo's is back.
    // A superseded one that is still open hands the fields it carries back to
    // be republished with the edit; one whose state is unknown keeps them.
    let waiting: BTreeMap<u64, PullRequest> = queue
        .fields
        .values()
        .filter_map(|field| field.pull_request.clone())
        .chain(queue.create_pull_request.clone())
        .chain(queue.superseded_pull_requests.iter().cloned())
        .map(|pr| (pr.number, pr))
        .collect();
    // A superseded PR whose state GitHub can't tell now might merge later over
    // whatever this drain publishes: publish nothing until it can.
    let mut unsettled: Option<u64> = None;
    // C4: what GitHub said of the creation pull request in this drain.
    let mut creation_state: Option<PrState> = None;
    for pr in waiting.values() {
        if page && asked >= PAGE_READ_PR_ASKS {
            break;
        }
        asked += 1;
        let state = publisher.pull_request_state(pr);
        if page && state.is_none() {
            break;
        }
        if queue.create_pull_request.as_ref().map(|p| p.number) == Some(pr.number) {
            creation_state = state;
            // Two-instance walk (C4): what GitHub said of it, kept for the
            // page; an unanswered ask keeps what was known.
            match state {
                Some(PrState::Open) => queue.creation_open = Some(pr.number),
                Some(_) => queue.creation_open = None,
                None => {}
            }
        }
        let superseded = queue
            .superseded_pull_requests
            .iter()
            .any(|p| p.number == pr.number);
        if state.is_none() && superseded {
            unsettled.get_or_insert(pr.number);
        }
        if state == Some(PrState::Open) && superseded {
            for field in queue.fields.values_mut() {
                if field.pull_request.as_ref().map(|p| p.number) == Some(pr.number) {
                    field.pull_request = None;
                }
            }
        }
        if !matches!(state, Some(PrState::Merged) | Some(PrState::Closed)) {
            continue;
        }
        if superseded {
            // Nothing to withdraw: it is settled.
            queue.superseded_pull_requests.retain(|p| p.number != pr.number);
        }
        let settled: Vec<String> = queue
            .fields
            .iter()
            .filter(|(_, f)| f.pull_request.as_ref().map(|p| p.number) == Some(pr.number))
            .map(|(key, _)| key.clone())
            .collect();
        for key in settled {
            queue.fields.remove(&key);
            cache.pending.remove(&key);
        }
        if queue.create_pull_request.as_ref().map(|p| p.number) == Some(pr.number) {
            queue.create_pull_request = None;
            queue.creation_open = None;
            queue.create_definition = false;
            // 1.175.0 (C2, SC-1): the conversion of the older file, closed
            // without merging, is not proposed again by itself — the next
            // launch used to open another pull request.
            if state == Some(PrState::Closed) && cache.source == DefinitionSource::Legacy {
                cache.conversion_declined = Some(crate::workspace_adoption::ConversionDeclined {
                    pull_request: pr.number,
                    who: None,
                    at: crate::shared_config::now_millis() / 1000,
                    seen: false,
                });
                report.conversion_declined = Some(pr.number);
            }
        }
        if state == Some(PrState::Closed) {
            report.closed_pull_requests.push(pr.number);
            // C3 round 2: closed unmerged, the value it carried never
            // reached the branch from here.
            for field in queue.fields.values_mut() {
                field.proposed.retain(|p| p.pull_request != pr.number);
            }
        }
    }

    (unsettled, creation_state)
}

pub fn publish_pending(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    publisher: &dyn Publisher,
    workspace_id: &str,
) -> Result<Option<PublishReport>, String> {
    publish_pending_at(stores, repo, publisher, workspace_id, false)
}

/// [`publish_pending`]; `pressed`: the person pressed Sync or Publish — a
/// push refused for access is tried once more then (teamfix round 2: where
/// GitHub can't say whether this account may push, nothing else would).
pub fn publish_pending_at(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    publisher: &dyn Publisher,
    workspace_id: &str,
    pressed: bool,
) -> Result<Option<PublishReport>, String> {
    let Some(mut cache) = load_cache(stores.project_configs, workspace_id) else {
        return Ok(None);
    };
    let Some(def) = cache.definition.clone() else {
        return Ok(None);
    };
    let default_branch = repo.default_branch();
    let mut queue = load_queue(stores.project_configs, workspace_id);
    // A cache from before the queue existed (card 1) enqueues its pending
    // fields here.
    sync_queue(&cache, &mut queue, &default_branch);
    if queue.is_empty() {
        save_queue(stores.project_configs, workspace_id, &queue)?;
        return Ok(None);
    }
    // 1.175.0 (C5, SC-8): GitHub says this account can't push here. Nothing
    // is tried until the access is back (a later read records it); the page
    // offers "Use the team's values…" meanwhile.
    // Two-instance walk (C5): and when a push was refused for access (HTTP
    // 403, "Permission … denied") while GitHub hasn't said this account may
    // push: no retry at every Sync. A grant, or GitHub saying "push", lets it
    // try again (`WriteAccess::record_permission`).
    let refused_access = cache.write_access.push_refused.as_deref().is_some_and(refused_for_access)
        && cache.write_access.can_push != Some(true)
        && !pressed;
    if cache.write_access.can_push == Some(false) || refused_access {
        save_queue(stores.project_configs, workspace_id, &queue)?;
        return Ok(None);
    }
    let branch = publish_branch(&cache, &def, repo, &default_branch);
    // C5 (SC-5): the shared setup's branch is gone from GitHub and nobody
    // chose where it goes now: nothing is published anywhere else by
    // itself (a copy left on the default branch is not the shared setup).
    if let Some(gone) = cache.branch_gone.clone() {
        if cache.pending.get("integrationBranch").and_then(Value::as_str) != Some(branch.as_str()) {
            let e = crate::shared_config::FetchFailure::branch_missing_words(&gone.branch);
            queue.last_error = Some(e.clone());
            queue.last_offline = false;
            queue.last_error_kind = Some(crate::shared_config::PublishTrouble::Other);
            cache.pending_state = pending_state_of(&cache, &queue);
            save_queue(stores.project_configs, workspace_id, &queue)?;
            save_cache(stores.project_configs, workspace_id, &cache)?;
            return Ok(Some(PublishReport { branch: gone.branch, error: Some(e), ..Default::default() }));
        }
    }
    let mut report = PublishReport {
        branch: branch.clone(),
        ..Default::default()
    };

    // Pull requests: what GitHub says of each, settled here (`settle_waiting`).
    let (unsettled, creation_state) = settle_waiting(publisher, &mut queue, &mut cache, &mut report, false);

    // 1.175.0 (C4, SC-4; owner C4-a): this computer's creation pull request
    // is still open, and the setup is on the branch from someone else's
    // commit (read from the branch, its own merged one settled above). It
    // isn't needed: closed — only while it is still this computer's own in
    // origin's repository — and said. A close GitHub refuses keeps it, and
    // the next drain tries again; one that isn't ours is left and named.
    // Only once GitHub said it is open: one whose state is unknown may be
    // the very pull request that put the file there.
    if let Some(pr) = queue.create_pull_request.clone() {
        if creation_state == Some(PrState::Open) && cache.source == DefinitionSource::Repo && cache.commit.is_some() {
            use crate::shared_config::OwnClose;
            let outcome = match publisher.close_own_saying(&pr, crate::shared_config::SHARED_FIRST_COMMENT) {
                Ok(OwnClose::Closed) => Some(SharedFirstOutcome::Closed),
                // Merged or closed between the two questions: settled, unsaid.
                Ok(OwnClose::Settled) => {
                    queue.create_pull_request = None;
                    queue.creation_open = None;
                    queue.create_definition = false;
                    None
                }
                Ok(OwnClose::NotOurs) => Some(SharedFirstOutcome::NotOurs),
                // C4 round 2: nobody answered — try again at the next drain,
                // and say nothing meanwhile.
                Err(e) if close_got_no_answer(&e) => {
                    log::info!("workspace_definition: closing pull request #{} got no answer; tried again later: {e}", pr.number);
                    None
                }
                Err(e) => {
                    log::warn!("workspace_definition: GitHub didn't close pull request #{}: {e}", pr.number);
                    Some(SharedFirstOutcome::Refused)
                }
            };
            if let Some(outcome) = outcome {
                queue.create_pull_request = None;
                queue.creation_open = None;
                queue.create_definition = false;
                // Its branch name is for that creation; a later change gets its own.
                queue.pull_request_branch = None;
                let first = SharedFirst { number: pr.number, url: pr.url.clone(), who: cache.author.clone(), outcome };
                // Named on the page until a later publish lands.
                queue.shared_first_left = (outcome != SharedFirstOutcome::Closed).then(|| first.clone());
                report.shared_first = Some(first);
            }
        }
    }

    let to_publish: BTreeMap<String, QueuedField> = queue
        .fields
        .iter()
        .filter(|(_, field)| field.pull_request.is_none())
        .map(|(key, field)| (key.clone(), field.clone()))
        .collect();
    // A creation already waiting in a pull request is not published again.
    let create = queue.create_definition && queue.create_pull_request.is_none();
    if let (Some(number), true) = (unsettled, !to_publish.is_empty() || create) {
        let e = format!("waiting to learn whether pull request #{number} merged before publishing again");
        queue.last_error = Some(e.clone());
        queue.last_offline = false;
        report.error = Some(e);
        cache.pending_state = pending_state_of(&cache, &queue);
        save_queue(stores.project_configs, workspace_id, &queue)?;
        save_cache(stores.project_configs, workspace_id, &cache)?;
        return Ok(Some(report));
    }
    if to_publish.is_empty() && !create {
        // Everything a superseded PR proposed was reverted: withdraw it.
        withdraw_superseded(publisher, &mut queue, None, &mut report);
        // An attempt whose answer was lost may have opened a PR from the
        // saved branch that nothing tracks: find it and withdraw it too.
        if queue.superseded_pull_requests.is_empty() {
            if let Some(branch) = queue.pull_request_branch.clone() {
                match publisher.withdraw_branch(&branch) {
                    Ok(closed) => {
                        for number in closed {
                            if !report.withdrawn_pull_requests.contains(&number) {
                                report.withdrawn_pull_requests.push(number);
                            }
                        }
                        queue.pull_request_branch = None;
                    }
                    Err(e) => {
                        log::warn!("workspace_definition: withdrawing PRs from {branch} failed: {e}");
                        queue.last_error = Some(e);
                        queue.last_offline = false;
                    }
                }
            }
        }
    }
    if !to_publish.is_empty() || create {
        // The fallback branch is chosen once and saved before the attempt, so
        // a PR an interrupted attempt opened is found again, not duplicated.
        let now_secs = crate::shared_config::now_millis() / 1000;
        // 1.173.0 (C3): chosen just now, so no earlier attempt can have
        // opened a pull request from it.
        let fresh_branch = queue.pull_request_branch.is_none();
        let pull_request_branch = queue
            .pull_request_branch
            .get_or_insert_with(|| {
                let slug = to_publish
                    .keys()
                    .next()
                    .map(|key| crate::shared_config::kebab(key))
                    .unwrap_or_else(|| "definition".to_string());
                // Unique per queued change, so two Macs publishing in the
                // same second never share (and overwrite) a fallback branch.
                let id = uuid::Uuid::new_v4().simple().to_string();
                format!("atelier/config-{slug}-{now_secs}-{}", &id[..8])
            })
            .clone();
        save_queue(stores.project_configs, workspace_id, &queue)?;
        // What this Mac runs with, the same effective definition a refresh
        // applies: its project part fills in a project edit's section.
        let project_fill = find_workspace(stores, workspace_id).ok().map(|ws| {
            let local = local_definition(&ws, stores.project_configs.get(workspace_id).as_ref(), &stores.project_configs.review(&ws.id), &crate::worktree_setup::load_settings(stores.project_configs, &ws.id), &crate::ply_skill_switch::load(stores.project_configs, &ws.id), &crate::team_models::load(stores.project_configs, &ws.id), &crate::areas::load(stores.project_configs, &ws.id), crate::areas::load_release_kind(stores.project_configs, &ws.id))
                .normalized(&default_branch);
            effective_definition(
                &def.normalized(&default_branch),
                &cache.pending,
                &local,
                &default_branch,
            )
        });
        // 1.175.0 (C1 round 2, SC-2): the file is created only when the
        // queue asks for a creation (Share, a conversion), or when the
        // publish goes to a branch other than the one the file was read
        // from (the move to the named integration branch). An edit never
        // creates it: the publish's own fetch may see a removal no refresh
        // saw yet, and this computer's cached copy must not go back onto
        // the branch. It fails with "has no … to change" and the next
        // refresh marks the setup removed.
        // Nor does the move create it on a branch whose history removed it.
        let may_create = queue.create_definition
            || (cache.branch.as_deref() != Some(branch.as_str())
                && repo.deletion(&branch, DEFINITION_PATH, cache.commit.as_deref()) == Deletion::Never);
        let outcome = match &cache.unreadable {
            Some(bad) => {
                // Round 2: the value serde named goes to the log with it.
                log::warn!("workspace_definition: not publishing over {} on {branch}: {}", bad.path, bad.message);
                PublishOutcome::Failed(bad.newer_sentence(&branch, true).unwrap_or_else(|| {
                    format!("{} on {branch} is {}; fix it there first", bad.path, bad.summary())
                }))
            }
            None => publisher.publish(&PublishRequest {
                branch: &branch,
                default_branch: &default_branch,
                fields: &to_publish,
                create_from: may_create.then_some(&def),
                now_secs,
                pull_request_branch: &pull_request_branch,
                project_fill: project_fill.as_ref(),
                device: None,
                replaces: &queue.superseded_pull_requests,
                replace_whole: false,
                moved_from: None,
                no_pull_request: false,
            }),
        };
        match outcome {
            PublishOutcome::Published {
                commit,
                definition,
                author,
                overrides,
                pushed,
                conflicts,
                ..
            } => {
                hold_conflicts(&mut queue, &to_publish, &conflicts, &mut report);
                // Nothing went out and the fallback branch is new: there is
                // no pull request to look for (a drain where every field
                // waits for a choice).
                if fresh_branch && !pushed {
                    queue.pull_request_branch = None;
                }
                let map = to_map(&definition.normalized(&default_branch));
                for (key, field) in &to_publish {
                    if field_value(&map, key) == field.value {
                        queue.fields.remove(key);
                        cache.pending.remove(key);
                        report.published.push(key.clone());
                    }
                }
                queue.create_definition = false;
                queue.last_error = None;
                // C4 round 2: a publish landed; what was left open is said no more.
                queue.shared_first_left = None;
                queue.last_offline = false;
                // The replacement is on the branch itself. An earlier attempt
                // on the saved fallback branch may have opened a PR whose
                // answer was lost: withdraw it before forgetting the branch.
                if let Some(saved) = queue.pull_request_branch.take() {
                    match publisher.withdraw_branch(&saved) {
                        Ok(closed) => {
                            for number in closed {
                                if !report.withdrawn_pull_requests.contains(&number) {
                                    report.withdrawn_pull_requests.push(number);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("workspace_definition: withdrawing PRs from {saved} failed: {e}");
                            queue.pull_request_branch = Some(saved);
                        }
                    }
                }
                withdraw_superseded(publisher, &mut queue, None, &mut report);
                cache.definition = Some(definition);
                cache.source = DefinitionSource::Repo;
                cache.branch = Some(branch.clone());
                cache.commit = Some(commit.clone());
                if author.is_some() {
                    cache.author = author;
                }
                // Ply just wrote it, so the shared definition is as new as now.
                cache.changed_at = Some(now_secs);
                cache.unreadable = None;
                if pushed {
                    report.commit = Some(commit);
                    cache.write_access.push_refused = None;
                }
                report.overrides = overrides;
                // Two-instance walk (C3, owner 2026-11-10): "Cards go to"
                // changed and landed here: the setup follows to that branch
                // carrying the current values, replacing whatever older copy
                // it holds, in one commit. Whoever reads this branch's
                // pointer finds the current setup there (`refresh_with`
                // never takes an older copy as newer).
                if pushed && report.published.iter().any(|k| k == "integrationBranch") {
                    move_with_current_values(publisher, repo, &mut cache, &mut queue, &branch, &default_branch, now_secs);
                }
            }
            PublishOutcome::PullRequest {
                pull_request,
                fields,
                conflicts,
            } => {
                hold_conflicts(&mut queue, &to_publish, &conflicts, &mut report);
                for key in &fields {
                    if let Some(field) = queue.fields.get_mut(key) {
                        // C3 Challenger 2: once merged, this value on the
                        // branch is this Mac's, even after a later edit.
                        let carried = crate::shared_config::Proposed {
                            value: field.value.clone(),
                            pull_request: pull_request.number,
                        };
                        if !field.proposed.contains(&carried) {
                            field.proposed.push(carried);
                        }
                        field.pull_request = Some(pull_request.clone());
                        field.attempts += 1;
                        field.last_error = None;
                    }
                }
                if queue.create_definition {
                    // Tracked until it settles, whether or not fields rode along.
                    queue.create_pull_request = Some(pull_request.clone());
                    queue.creation_open = None;
                }
                queue.create_definition = false;
                queue.last_error = None;
                queue.last_offline = false;
                queue.pull_request_branch = None;
                withdraw_superseded(publisher, &mut queue, Some(pull_request.number), &mut report);
                report.pull_request = Some(pull_request);
                report.pull_request_fields = fields;
            }
            outcome @ (PublishOutcome::Unreachable(_) | PublishOutcome::Failed(_)) => {
                let (e, unreachable) = match outcome {
                    PublishOutcome::Unreachable(e) => (e, true),
                    PublishOutcome::Failed(e) => (e, false),
                    _ => unreachable!(),
                };
                // 1.175.0 (C4, SC-7): a sign-in git or `gh` couldn't get is
                // no network trouble — "you're offline" only for that.
                let trouble = crate::shared_config::classify_trouble(&e, unreachable);
                let offline = trouble == crate::shared_config::PublishTrouble::Network;
                report.offline = offline;
                report.trouble = Some(trouble);
                if !offline && e.contains(crate::shared_config::REFUSED_MARKER) {
                    cache.write_access.push_refused = Some(e.clone());
                }
                // Round 3 (S4): every name of the sequence is taken — the
                // next Sync starts a new one, as the words say.
                if !offline && e.contains(crate::shared_config::NAMES_USED_UP_MARKER) {
                    queue.pull_request_branch = None;
                }
                for key in to_publish.keys() {
                    if let Some(field) = queue.fields.get_mut(key) {
                        field.attempts += 1;
                        field.last_error = Some(e.clone());
                    }
                }
                queue.last_error = Some(e.clone());
                queue.last_offline = offline;
                report.error = Some(e);
            }
        }
    }
    // C4: the kind goes with the words, whichever path set them.
    queue.last_error_kind = queue
        .last_error
        .as_deref()
        .map(|e| crate::shared_config::classify_trouble(e, queue.last_offline));
    cache.pending_state = pending_state_of(&cache, &queue);
    save_queue(stores.project_configs, workspace_id, &queue)?;
    save_cache(stores.project_configs, workspace_id, &cache)?;
    Ok(Some(report))
}

/// 1.173.0 (C3): the person's answer to a shared setting both sides changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// *Keep theirs*: this Mac's edit is dropped; the repository's value
    /// applies at the refresh that follows.
    Theirs,
    /// *Use this Mac's*: published over exactly the value the question
    /// showed, the override named in the commit.
    Mine,
}

/// 1.173.0 (C3 Challenger 1): the question the person answered, as shown —
/// an answer to an older question records nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownConflict {
    #[serde(default)]
    pub theirs: Value,
    #[serde(default)]
    pub changed_at: Option<i64>,
}

/// 1.173.0 (C3): record `choice` for `field`, answered to `shown`. `false`
/// when there is no such question any more — answered elsewhere, the two
/// sides came to agree, or the other side changed the value again since it
/// was shown (the caller shows the new question): nothing changes. The
/// caller refreshes, which publishes *Use this Mac's* and applies *Keep
/// theirs*.
///
/// *Keep theirs* of a field merged key by key (`models`) keeps this Mac's
/// changes to the keys the other side left alone: only the clashing keys
/// take theirs, and the rest is published as this Mac's edit.
pub fn resolve_conflict(
    stores: &Stores<'_>,
    workspace_id: &str,
    field: &str,
    choice: ConflictChoice,
    shown: &ShownConflict,
) -> Result<bool, String> {
    let mut queue = load_queue(stores.project_configs, workspace_id);
    let Some(entry) = queue.fields.get(field).cloned() else {
        return Ok(false);
    };
    let Some(conflict) = entry.conflict.clone() else {
        return Ok(false);
    };
    if conflict.theirs != shown.theirs || conflict.changed_at != shown.changed_at {
        return Ok(false);
    }
    match choice {
        ConflictChoice::Mine => {
            if let Some(entry) = queue.fields.get_mut(field) {
                entry.conflict = None;
                entry.use_mine = Some(crate::shared_config::UseMine { over: conflict.theirs });
                entry.attempts = 0;
                entry.last_error = None;
            }
            save_queue(stores.project_configs, workspace_id, &queue)?;
        }
        ConflictChoice::Theirs => {
            let mut cache = load_cache(stores.project_configs, workspace_id)
                .ok_or_else(|| "this workspace has no shared definition".to_string())?;
            let kept = (field == "models").then(|| {
                crate::shared_config::merge_models_keeping_theirs(
                    &entry.base_against(&conflict.theirs),
                    &conflict.theirs,
                    &entry.value,
                )
            });
            match kept.filter(|kept| *kept != conflict.theirs) {
                // This Mac's other suggestions stay, now over theirs.
                Some(kept) => {
                    cache.pending.insert(field.to_string(), kept.clone());
                    if let Some(entry) = queue.fields.get_mut(field) {
                        entry.value = kept;
                        entry.base = conflict.theirs.clone();
                        entry.base_commit = conflict.tip.clone();
                        entry.conflict = None;
                        entry.use_mine = None;
                        entry.proposed.clear();
                        entry.attempts = 0;
                        entry.last_error = None;
                    }
                }
                None => {
                    queue.fields.remove(field);
                    cache.pending.remove(field);
                }
            }
            // The value the question showed is the repository's: the cache
            // carries it, so this Mac applies it even before the next read
            // reaches the branch (offline), and an edit in between compares
            // against it — never against the value it replaced.
            if let Some(def) = cache.definition.clone() {
                let mut one = BTreeMap::new();
                one.insert(field.to_string(), conflict.theirs);
                cache.definition = Some(overlay(&def, &one));
            }
            cache.pending_state = pending_state_of(&cache, &queue);
            save_queue(stores.project_configs, workspace_id, &queue)?;
            save_cache(stores.project_configs, workspace_id, &cache)?;
        }
    }
    Ok(true)
}

/// 1.173.0 (C3): [`resolve_conflict`] under the workspace lock, then the
/// refresh that publishes or applies it (on its own thread). Emits
/// [`EDITED_EVENT`] so the pages read the view again.
pub fn app_resolve_conflict<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    field: &str,
    choice: ConflictChoice,
    shown: &ShownConflict,
) -> Result<bool, String> {
    use tauri::Emitter;
    // 1.173.0 (E1): a Next improvement direction field (`ni-<area>-<field>`).
    if crate::next_improvement::parse_conflict_field(field).is_some() {
        let answered =
            crate::next_improvement::app_resolve(app, workspace_id, field, choice == ConflictChoice::Mine, shown)?;
        let _ = app.emit(EDITED_EVENT, workspace_id);
        return Ok(answered);
    }
    let answered = with_workspace_lock(app, workspace_id, |stores, _| {
        resolve_conflict(stores, workspace_id, field, choice, shown)
    })?;
    let _ = app.emit(EDITED_EVENT, workspace_id);
    spawn_publish(app, workspace_id);
    Ok(answered)
}

/// 1.173.0 (C3): record on each published-or-held field whether it now waits
/// for the person's choice, and list the ones that do.
fn hold_conflicts(
    queue: &mut PublishQueue,
    to_publish: &BTreeMap<String, QueuedField>,
    conflicts: &BTreeMap<String, crate::shared_config::FieldConflict>,
    report: &mut PublishReport,
) {
    for key in to_publish.keys() {
        if let Some(field) = queue.fields.get_mut(key) {
            field.conflict = conflicts.get(key).cloned();
        }
    }
    report.conflicts = conflicts.keys().cloned().collect();
}

/// Where the definition belongs: the integration branch it names (absent =
/// the default branch) — even when the copy was read from elsewhere because
/// that branch has no file yet; the publish then creates it there. Only a
/// named branch that doesn't exist falls back to where the copy was read.
/// GH #82: shared Knowledge and project skills use the same branch.
pub fn publish_branch(
    cache: &DefinitionCache,
    def: &WorkspaceDefinition,
    repo: &dyn RepoSource,
    default_branch: &str,
) -> String {
    let read_from = cache
        .branch
        .clone()
        .unwrap_or_else(|| default_branch.to_string());
    let named = def
        .normalized(default_branch)
        .integration_branch
        .unwrap_or_else(|| default_branch.to_string());
    // 1.175.0 (C5, SC-5): the branch it was read from is gone from GitHub,
    // and this computer chose where cards go now (a pending
    // `integrationBranch` on a branch that is there): the setup goes there
    // with that choice — "Choose where cards go", "Move to {new}". Before,
    // every publish went to the missing branch, the choice included.
    if cache.branch_gone.is_some() {
        if let Some(chosen) = cache
            .pending
            .get("integrationBranch")
            .and_then(Value::as_str)
            .filter(|b| {
                !b.is_empty()
                    && Some(*b) != cache.branch_gone.as_ref().map(|g| g.branch.as_str())
                    && repo.branch_exists(b)
            })
        {
            return chosen.to_string();
        }
    }
    if named != read_from && repo.branch_exists(&named) {
        named
    } else {
        read_from
    }
}

/// GH #82: a workspace whose Knowledge and project skills are shared — it has
/// a definition that is (or is being put) in the repository — with the
/// branch they live on and the paths of its library on this Mac.
pub fn library_target(
    stores: &Stores<'_>,
    repo: &GitRepo,
    workspace_id: &str,
) -> Option<(DefinitionCache, String, crate::shared_library_sync::Paths)> {
    let cache = load_cache(stores.project_configs, workspace_id)?;
    let def = cache.definition.clone()?;
    if cache.source == DefinitionSource::Legacy {
        return None;
    }
    let branch = publish_branch(&cache, &def, repo, &repo.default_branch());
    let paths = crate::shared_library_sync::Paths {
        workspace_dir: stores.project_configs.workspace_dir(workspace_id),
        cwd: repo.cwd.clone(),
    };
    Some((cache, branch, paths))
}

/// GH #82: drain the library queue and rebuild the mirror, under the
/// workspace lock. A refusal with no pull request makes this Mac read-only.
fn sync_library(
    stores: &Stores<'_>,
    repo: &GitRepo,
    workspace_id: &str,
) -> Option<crate::shared_library_sync::LibraryReport> {
    let (mut cache, branch, paths) = library_target(stores, repo, workspace_id)?;
    let git = crate::shared_config::Plumbing {
        cwd: repo.cwd.clone(),
    };
    let gh = crate::doctor::require("gh")
        .ok()
        .map(crate::shared_config::Gh::new);
    let publisher = crate::shared_library_sync::GitLibraryPublisher {
        git: &git,
        gh: gh.as_ref(),
    };
    match crate::shared_library_sync::sync(&git, &publisher, &paths, &branch) {
        Ok(report) => {
            let before = cache.write_access.clone();
            if let Some(refused) = &report.refused {
                cache.write_access.push_refused = Some(refused.clone());
            } else if !report.published.is_empty() {
                cache.write_access.push_refused = None;
            }
            if cache.write_access != before {
                if let Err(e) = save_cache(stores.project_configs, workspace_id, &cache) {
                    log::warn!("workspace_definition: saving write access failed: {e}");
                }
            }
            Some(report)
        }
        Err(e) => {
            log::warn!("workspace_definition: shared library sync of {workspace_id} failed: {e}");
            None
        }
    }
}

/// GH #82: emitted with the workspace id when a shared note or project skill
/// was queued (and applied to the mirror).
pub const LIBRARY_EDITED_EVENT: &str = "workspace-definition://library-edited";

/// GH #82: what the Knowledge panel and the project skills panel need to know
/// about a workspace's shared library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    /// Notes and skills go through the channel (the workspace has a shared
    /// definition in the repository).
    pub shared: bool,
    pub branch: Option<String>,
    pub read_only: bool,
    /// origin's GitHub repository, for the "needs write access" line.
    pub repository: Option<String>,
    /// Queued item keys (`knowledge/<slug>`, `skill/<name>`) and the pull
    /// request each waits in, if any.
    pub pending: Vec<crate::shared_library_sync::PendingItem>,
    /// Skills on the branch (the mirror).
    pub branch_skills: Vec<String>,
    /// GH #96: the same skills with their descriptions and their directory in
    /// the mirror — a Library row shows the first sentence of the description,
    /// and a skill that lives only on the branch has one nowhere else.
    /// `branch_skills` stays the list every older caller asks "is this name on
    /// the branch?" of.
    #[serde(default)]
    pub branch_skill_rows: Vec<crate::shared_library_sync::MirrorSkill>,
    /// What the branch carries that isn't loaded, and why (a symlink).
    #[serde(default)]
    pub skipped: Vec<String>,
    /// Branch skills Claude sessions in the checkout get through Ply: the
    /// checkout has no Claude copy, or a different one.
    #[serde(default)]
    pub supplied_to_checkout: Vec<String>,
    /// Walk F4: branch skills whose checkout copies are exactly the branch's,
    /// so `Update on <branch>` has nothing to carry and is not offered.
    #[serde(default)]
    pub current_in_checkout: Vec<String>,
    /// Group B §2 walks: skills whose checkout copy for one CLI is behind the
    /// branch because an Update let it follow the edited one — not a
    /// divergence; the row says a pull brings it.
    #[serde(default)]
    pub checkout_behind: Vec<crate::shared_library_sync::CheckoutBehind>,
    /// GH #156: whether Codex sessions on this Mac get the branch's Codex
    /// copies, through the `ply-project` marketplace in the `CODEX_HOME`
    /// overlay — what lights the Codex chip of a skill whose Codex copy is only
    /// on the branch. Asked without building anything
    /// ([`crate::branch_codex_skills::delivery`]).
    #[serde(default)]
    pub branch_codex: crate::branch_codex_skills::Delivery,
}

pub fn app_library_state<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<LibraryState, String> {
    with_app_stores(
        app,
        |stores, repo| {
            let Some((cache, branch, paths)) = library_target(stores, repo, workspace_id) else {
                return Ok(LibraryState::default());
            };
            Ok(LibraryState {
                shared: true,
                branch: Some(branch),
                read_only: cache.write_access.read_only(),
                repository: crate::shared_config::Plumbing {
                    cwd: repo.cwd.clone(),
                }
                .github_repo(),
                pending: crate::shared_library_sync::pending_items(&paths),
                branch_skills: crate::shared_library_sync::mirror_skills(&paths),
                branch_skill_rows: crate::shared_library_sync::mirror_skill_rows(&paths),
                skipped: crate::shared_library_sync::load_manifest(&paths)
                    .map(|m| m.skipped)
                    .unwrap_or_default(),
                supplied_to_checkout: crate::shared_library_sync::skills_supplied_to(
                    &paths, &repo.cwd,
                ),
                current_in_checkout: crate::shared_library_sync::skills_current_in(
                    &paths, &repo.cwd,
                ),
                checkout_behind: crate::shared_library_sync::checkout_copies_behind(
                    &paths, &repo.cwd,
                ),
                branch_codex: crate::branch_codex_skills::delivery(
                    &crate::codex_home::real_codex_home(),
                ),
            })
        },
        workspace_id,
    )
}

/// SP-5 walk: the pinned mirror build of a **shared** workspace and an id for
/// it (the build's own directory), read **without** the workspace lock — an
/// advisory read for the proposal block's hint, which must never wait behind
/// a fetch, push or drain. `None` when the workspace isn't shared or no build
/// exists yet (nothing is built here).
pub fn app_library_mirror<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Option<PathBuf> {
    with_app_stores(
        app,
        |stores, repo| {
            let Some((_, _, paths)) = library_target(stores, repo, workspace_id) else {
                return Ok(None);
            };
            if crate::shared_library_sync::load_manifest(&paths).is_none() {
                return Ok(None);
            }
            let mirror = paths.mirror();
            Ok(Some(ply_memory::resolve_mirror(&mirror).unwrap_or(mirror)))
        },
        workspace_id,
    )
    .ok()
    .flatten()
}

/// GH #101 (BOARDS.md §5): where the Instructions page reads the two root
/// instruction files, and what "never override" is judged against.
#[derive(Debug, Clone)]
pub struct InstructionSource {
    /// The workspace has a shared definition, so the files travel on the channel.
    pub shared: bool,
    pub branch: Option<String>,
    pub read_only: bool,
    pub repository: Option<String>,
    /// The member's checkout — what `Open in Code` may open, and the only place
    /// an **unshared** workspace's step writes.
    pub cwd: PathBuf,
    /// The directory the page's state comes from: the pinned mirror build when
    /// the workspace is shared, the checkout otherwise. A shared workspace's
    /// page is about what the integration branch carries, because that is where
    /// the step publishes and where every other Mac reads it from.
    pub root: PathBuf,
    /// Each instruction file's blob id on the branch as of the current mirror
    /// build (`None`: absent; an empty map when the workspace is not shared).
    pub bases: BTreeMap<String, Option<String>>,
    /// What the branch carries that the mirror left out, and why (a symlink).
    /// An instruction file in here is one Ply must not touch, so the page says
    /// so and offers no step — the mirror has no copy of it, and without this
    /// the doctor would read it as **absent** and offer to create one over it.
    pub skipped: Vec<String>,
    /// GH #161: the instruction files this build carries only because a **queued**
    /// change laid them over it. The branch has not got them, so the page's rows
    /// must not read the mirror as the branch (empty when nothing is queued, and
    /// for an unshared workspace).
    pub queued: Vec<String>,
}

/// Read [`InstructionSource`] for one workspace.
///
/// A shared workspace whose mirror has never been built gets one built here, the
/// way [`app_library_change`] does, so the page's first open is about the branch
/// rather than about nothing.
pub fn app_instruction_source<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<InstructionSource, String> {
    let lock = workspace_lock(workspace_id);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    with_app_stores(
        app,
        |stores, repo| {
            let git = crate::shared_config::Plumbing {
                cwd: repo.cwd.clone(),
            };
            let Some((cache, branch, paths)) = library_target(stores, repo, workspace_id) else {
                return Ok(InstructionSource {
                    shared: false,
                    branch: None,
                    read_only: false,
                    repository: git.github_repo(),
                    cwd: repo.cwd.clone(),
                    root: repo.cwd.clone(),
                    bases: BTreeMap::new(),
                    skipped: Vec::new(),
                    queued: Vec::new(),
                });
            };
            let manifest = match crate::shared_library_sync::load_manifest(&paths) {
                Some(manifest) => manifest,
                None => {
                    let queue = crate::shared_library_sync::load_queue(&paths);
                    crate::shared_library_sync::build_mirror(&git, &paths, &branch, &queue)?
                }
            };
            // The build the link points at, pinned: the same directory every
            // other reader of the mirror resolves, so the page cannot be reading
            // a build that is being replaced under it.
            let mirror = paths.mirror();
            let root = ply_memory::resolve_mirror(&mirror).unwrap_or(mirror);
            Ok(InstructionSource {
                shared: true,
                branch: Some(branch),
                read_only: cache.write_access.read_only(),
                repository: git.github_repo(),
                cwd: repo.cwd.clone(),
                root,
                bases: crate::instruction_files::bases_from(&manifest.items),
                skipped: manifest.skipped.clone(),
                // Read under the same lock as the build it describes, so the rows
                // cannot be told about a queue a later drain has already emptied.
                queued: crate::shared_library_sync::queued_instruction_files(
                    &crate::shared_library_sync::load_queue(&paths),
                ),
            })
        },
        workspace_id,
    )
}

/// The words for a Shared · Project write a read-only collaborator can't make.
pub fn library_read_only_error(repository: Option<&str>) -> String {
    format!(
        "Shared · Project needs write access to {}. Ask for it, or keep this personal.",
        repository.unwrap_or("this repository")
    )
}

/// GH #82: queue one shared note or project skill change for the channel.
/// `make` gets the mirror root (the repository layout, as the branch has it
/// with this Mac's queued changes), read under the workspace lock, and returns
/// the change — or none, when what it finds there says not to make one.
/// `Ok(None)` when the workspace isn't shared: the caller keeps its checkout
/// behaviour.
pub fn app_library_change<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    make: impl FnOnce(
        &Path,
    ) -> Result<(Option<crate::shared_library_sync::LibraryChange>, T), String>,
) -> Result<Option<T>, String> {
    Ok(library_change(app, workspace_id, make, Publish::Background)?.map(|(out, _)| out))
}

/// 1.169.0 (C4): [`app_library_change`], published only after `delay` — the
/// time a removal can be taken back (`withdraw_library_removal`).
pub fn app_library_change_after<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    delay: std::time::Duration,
    make: impl FnOnce(
        &Path,
    ) -> Result<(Option<crate::shared_library_sync::LibraryChange>, T), String>,
) -> Result<Option<T>, String> {
    Ok(library_change(app, workspace_id, make, Publish::After(delay))?.map(|(out, _)| out))
}

/// When a queued library change is published.
#[derive(Clone, Copy)]
enum Publish {
    /// On a thread of its own, at once.
    Background,
    /// Here, the caller getting the report.
    Now,
    /// On a thread of its own, after this long.
    After(std::time::Duration),
}

/// 1.169.0 (C4): take back a queued removal of a library item while it waits
/// (`shared_library_sync::withdraw_queued_removal`), under the workspace's
/// lock, so a publish never runs halfway through it; the mirror is rebuilt.
/// What it found ([`crate::shared_library_sync::RemovalWithdrawal`]), or
/// `None`: this project has no shared library here (any more).
pub fn withdraw_library_removal<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    kind: crate::shared_library_sync::ItemKind,
    name: &str,
) -> Result<Option<crate::shared_library_sync::RemovalWithdrawal>, String> {
    use crate::shared_library_sync::RemovalWithdrawal as W;
    use tauri::Emitter;
    let withdrawn = {
        let lock = workspace_lock(workspace_id);
        let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
        with_app_stores(
            app,
            |stores, repo| {
                let Some((_cache, branch, paths)) = library_target(stores, repo, workspace_id) else {
                    return Ok(None);
                };
                let git = crate::shared_config::Plumbing { cwd: repo.cwd.clone() };
                let mut queue = crate::shared_library_sync::load_queue(&paths);
                let found = crate::shared_library_sync::withdraw_queued_removal(&mut queue, kind, name)?;
                if matches!(found, W::NotQueued | W::Replaced) {
                    return Ok(Some(found));
                }
                crate::shared_library_sync::save_queue(&paths, &queue)?;
                crate::shared_library_sync::build_mirror(&git, &paths, &branch, &queue)?;
                Ok(Some(found))
            },
            workspace_id,
        )?
    };
    if matches!(withdrawn, Some(W::Withdrawn | W::Restored)) {
        let _ = app.emit(LIBRARY_EDITED_EVENT, workspace_id);
    }
    Ok(withdrawn)
}

/// [`app_library_change`], with the publish run here rather than on a thread
/// of its own: the caller gets the drain's report, so it can say whether the
/// change went to the branch or waits (offline, a retry). `None` beside the
/// output when nothing was queued, or the drain itself failed (logged).
pub fn app_library_change_now<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    make: impl FnOnce(
        &Path,
    ) -> Result<(Option<crate::shared_library_sync::LibraryChange>, T), String>,
) -> Result<Option<(T, Option<RefreshReport>)>, String> {
    library_change(app, workspace_id, make, Publish::Now)
}

fn library_change<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    make: impl FnOnce(
        &Path,
    ) -> Result<(Option<crate::shared_library_sync::LibraryChange>, T), String>,
    publish: Publish,
) -> Result<Option<(T, Option<RefreshReport>)>, String> {
    use tauri::Emitter;
    let publish_now = matches!(publish, Publish::Now);
    let started = std::time::Instant::now();
    let queued = {
        let lock = workspace_lock(workspace_id);
        // Publish-sheet walk (Challenger): a press that publishes now waits
        // for the workspace lock only so long. A Sync that holds it over a
        // slow fetch or push would otherwise leave the press with no answer
        // at all; this one says why, and nothing was queued.
        let _serial = if publish_now {
            lock_within(&lock, PUBLISH_LOCK_WAIT).ok_or_else(|| PUBLISH_BUSY_WORDS.to_string())?
        } else {
            lock.lock().unwrap_or_else(|p| p.into_inner())
        };
        let waited = started.elapsed();
        if waited >= std::time::Duration::from_secs(1) {
            log::info!("workspace_definition: library change for {workspace_id} waited {} ms for the workspace lock", waited.as_millis());
        }
        with_app_stores(
            app,
            |stores, repo| {
                let Some((cache, branch, paths)) = library_target(stores, repo, workspace_id)
                else {
                    return Ok(None);
                };
                let git = crate::shared_config::Plumbing {
                    cwd: repo.cwd.clone(),
                };
                if cache.write_access.read_only() {
                    return Err(library_read_only_error(git.github_repo().as_deref()));
                }
                if crate::shared_library_sync::load_manifest(&paths).is_none() {
                    let queue = crate::shared_library_sync::load_queue(&paths);
                    crate::shared_library_sync::build_mirror(&git, &paths, &branch, &queue)?;
                }
                let (change, out) = make(&paths.mirror())?;
                let Some(change) = change else {
                    return Ok(Some((false, out)));
                };
                crate::shared_library_sync::enqueue(&git, &paths, &branch, change)?;
                Ok(Some((true, out)))
            },
            workspace_id,
        )?
    };
    Ok(queued.map(|(changed, out)| {
        if !changed {
            return (out, None);
        }
        let _ = app.emit(LIBRARY_EDITED_EVENT, workspace_id);
        match publish {
            Publish::Background => {
                spawn_publish(app, workspace_id);
                return (out, None);
            }
            Publish::After(delay) => {
                spawn_publish_after(app, workspace_id, delay);
                return (out, None);
            }
            Publish::Now => {}
        }
        // The workspace lock above is released: the drain takes it again,
        // as the spawned publish would.
        let pushing = std::time::Instant::now();
        let refreshed = refresh_definition(app, workspace_id, RefreshMoment::Publish);
        log::info!(
            "workspace_definition: publish of {workspace_id} ran in {} ms ({} ms in all)",
            pushing.elapsed().as_millis(),
            started.elapsed().as_millis()
        );
        match refreshed {
            Ok(report) => (out, Some(report)),
            Err(e) => {
                log::warn!("workspace_definition: publish of {workspace_id} failed: {e}");
                (out, None)
            }
        }
    }))
}

/// Settings › Project's editor: apply `definition` to this Mac, then record
/// the difference from the repo as pending.
pub fn save(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    definition: WorkspaceDefinition,
) -> Result<DefinitionView, String> {
    save_with(stores, repo, workspace_id, definition, false)
}

/// [`save`]. SL-4: `approve_setup` — the person typed the setup command in
/// its own row — also makes it one this Mac agrees to run. A save of any
/// other field never approves a command it happens to carry.
pub fn save_with(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    definition: WorkspaceDefinition,
    approve_setup: bool,
) -> Result<DefinitionView, String> {
    let Some(cache) = load_cache(stores.project_configs, workspace_id).filter(|c| c.definition.is_some())
    else {
        return Err("This workspace has no shared definition yet.".to_string());
    };
    if cache.write_access.read_only() {
        return Err(read_only_error("The shared workspace definition"));
    }
    let ws = find_workspace(stores, workspace_id)?;
    let local_config = stores.project_configs.get(workspace_id);
    let default_branch = repo.default_branch();
    let target = definition.normalized(&default_branch);
    let local = local_definition(&ws, local_config.as_ref(), &stores.project_configs.review(&ws.id), &crate::worktree_setup::load_settings(stores.project_configs, &ws.id), &crate::ply_skill_switch::load(stores.project_configs, &ws.id), &crate::team_models::load(stores.project_configs, &ws.id), &crate::areas::load(stores.project_configs, &ws.id), crate::areas::load_release_kind(stores.project_configs, &ws.id)).normalized(&default_branch);
    let mut changed = differing_fields(&local, &target);
    if board_held(stores, &local, &target) {
        changed.retain(|key| !BOARD_FIELDS.contains(key));
    }
    // Owner, 2026-10-20: on a workspace named by the person, the page's Name
    // is everyone's — published when it was edited, never applied here.
    let name_edit = match &cache.definition {
        Some(repo_def) if keeps_own_name(&ws, Some(repo_def)) => {
            changed.retain(|key| *key != "name");
            let shared = shared_name(&repo_def.normalized(&default_branch), &cache.pending);
            (target.name != shared).then(|| target.name.clone())
        }
        _ => None,
    };
    apply_fields(stores, &ws, local_config.as_ref(), &target, &changed)?;
    // SL-4: a setup command typed in its row here is one this Mac agrees to run.
    if approve_setup && changed.contains(&"worktreeSetup") {
        let mut worktree = crate::worktree_setup::load_settings(stores.project_configs, &ws.id);
        worktree.approved_setup = target.worktree_setup.clone();
        crate::worktree_setup::save_settings(stores.project_configs, &ws.id, &worktree)?;
    }
    record_local_edit_named(stores, repo, workspace_id, definition.has_project(), name_edit)?
        .ok_or_else(|| "This workspace has no shared definition yet.".to_string())
}

/// The editor's Save, merged under the workspace lock: only the fields the
/// user changed from `base` (the definition when the editor opened) are taken
/// from `draft`; everything else is the definition as it is now, so a refresh
/// that landed meanwhile is not submitted back as a local edit. A key the
/// user removed is removed.
pub fn save_changes(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    base: Map<String, Value>,
    draft: Map<String, Value>,
) -> Result<DefinitionView, String> {
    save_changes_with(stores, repo, workspace_id, base, draft, false)
}

/// [`save_changes`], with [`save_with`]'s `approve_setup`.
pub fn save_changes_with(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    base: Map<String, Value>,
    draft: Map<String, Value>,
    approve_setup: bool,
) -> Result<DefinitionView, String> {
    let latest = get_view(stores, repo, workspace_id)
        .and_then(|v| v.effective)
        .ok_or_else(|| "This workspace has no shared definition yet.".to_string())?;
    let merged = merge_changes(&base, &draft, to_map(&latest));
    let definition: WorkspaceDefinition = serde_json::from_value(Value::Object(merged))
        .map_err(|e| format!("Not a valid workspace definition: {e}"))?;
    refuse_unrecordable(&latest, &definition)?;
    // The JSON editor is held to the checklist's limits like the list editor.
    if let Some(classes) = &definition.review_checklist {
        if definition.review_checklist != latest.review_checklist {
            crate::project_config::validate_review_checklist(classes)?;
        }
    }
    // 1.173.0 (B1): and the areas to their rules, before anything applies.
    if let Some(problem) = definition.areas.as_ref().and_then(|a| a.problem()) {
        if definition.areas != latest.areas {
            return Err(problem.to_string());
        }
    }
    // 1.175.0 B2: checks or an install step the person changed on this page
    // are ones this Mac agrees to run.
    let (verify, install) = crate::checks_consent::edited_fields(&base, &draft);
    let view = save_with(stores, repo, workspace_id, definition, approve_setup)?;
    crate::checks_consent::approve_own(stores.project_configs, workspace_id, verify, install);
    keep_edit_bases(stores, repo, workspace_id, &base, &draft)?;
    // C3 round 2: the view the page reads back shows the bases just kept.
    Ok(get_view(stores, repo, workspace_id).unwrap_or(view))
}

/// 1.175.0 (C3, SC-3): the page's `base` says, per changed field, the value
/// the person changed *from* (the one in use at the first edit). A queued
/// field takes that as its base when the repository holds another value
/// now: the publish then asks which to keep (`shared_config::prepare`,
/// 1.173.0's question) instead of writing this value over a teammate's with
/// no word. Compared and kept in the definition's own normalized form, so a
/// value that only reads differently is no difference.
fn keep_edit_bases(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    base: &Map<String, Value>,
    draft: &Map<String, Value>,
) -> Result<(), String> {
    let Some(def) = load_cache(stores.project_configs, workspace_id).and_then(|c| c.definition) else {
        return Ok(());
    };
    let default_branch = repo.default_branch();
    let repo_map = to_map(&def.normalized(&default_branch));
    let mut queue = load_queue(stores.project_configs, workspace_id);
    let mut changed = false;
    for key in base.keys().chain(draft.keys()) {
        if base.get(key) == draft.get(key) || !FIELDS.iter().any(|(k, _)| k == key) {
            continue;
        }
        let was = base.get(key).cloned().unwrap_or(Value::Null);
        let was = field_value(
            &to_map(&overlay(&def, &BTreeMap::from([(key.clone(), was)])).normalized(&default_branch)),
            key,
        );
        if was == field_value(&repo_map, key) {
            continue;
        }
        if let Some(entry) = queue.fields.get_mut(key) {
            if entry.pull_request.is_none() && entry.base != was {
                entry.base = was;
                entry.conflict = None;
                changed = true;
            }
        }
    }
    if changed {
        save_queue(stores.project_configs, workspace_id, &queue)?;
    }
    Ok(())
}

/// Edits a pending field can't carry are refused rather than dropped: Ply
/// keeps shared edits as per-field values of the fields it knows, and this
/// Mac's project config can't represent "the repository shares none".
fn refuse_unrecordable(
    latest: &WorkspaceDefinition,
    edited: &WorkspaceDefinition,
) -> Result<(), String> {
    let mut keys: Vec<&str> = latest
        .extra
        .keys()
        .chain(edited.extra.keys())
        .filter(|key| latest.extra.get(*key) != edited.extra.get(*key))
        .map(String::as_str)
        .collect();
    if latest.schema_version != edited.schema_version {
        keys.push("schemaVersion");
    }
    keys.sort_unstable();
    keys.dedup();
    if !keys.is_empty() {
        return Err(format!(
            "Plyloft can't change {} here; edit {DEFINITION_PATH} in the repository for that.",
            keys.join(", ")
        ));
    }
    if latest.has_project() && !edited.has_project() {
        return Err(format!(
            "Removing the whole project config from the shared definition isn't supported here; change its fields instead, or edit {DEFINITION_PATH} in the repository."
        ));
    }
    Ok(())
}

fn merge_changes(
    base: &Map<String, Value>,
    draft: &Map<String, Value>,
    mut latest: Map<String, Value>,
) -> Map<String, Value> {
    for key in base.keys().chain(draft.keys()) {
        if base.get(key) == draft.get(key) {
            continue;
        }
        match draft.get(key) {
            Some(value) => {
                latest.insert(key.clone(), value.clone());
            }
            None => {
                latest.remove(key);
            }
        }
    }
    latest
}

pub fn get_view(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
) -> Option<DefinitionView> {
    let cache = load_cache(stores.project_configs, workspace_id)?;
    let default_branch = repo.default_branch();
    let read_only = cache.write_access.read_only();
    let provenance = match (&cache.branch, read_only) {
        (Some(branch), true) => repo.field_provenance(branch, &default_branch),
        _ => BTreeMap::new(),
    };
    let mut out = view(stores, workspace_id, cache, default_branch);
    out.provenance = provenance;
    Some(out)
}

fn view(
    stores: &Stores<'_>,
    workspace_id: &str,
    cache: DefinitionCache,
    default_branch: String,
) -> DefinitionView {
    // The same effective definition a refresh applies.
    let local = find_workspace(stores, workspace_id).ok().map(|ws| {
        local_definition(&ws, stores.project_configs.get(workspace_id).as_ref(), &stores.project_configs.review(&ws.id), &crate::worktree_setup::load_settings(stores.project_configs, &ws.id), &crate::ply_skill_switch::load(stores.project_configs, &ws.id), &crate::team_models::load(stores.project_configs, &ws.id), &crate::areas::load(stores.project_configs, &ws.id), crate::areas::load_release_kind(stores.project_configs, &ws.id))
            .normalized(&default_branch)
    });
    let effective = cache.definition.as_ref().map(|def| {
        let mut repo_norm = def.normalized(&default_branch);
        hold_bad_areas(&mut repo_norm, &mut cache.field_problems.clone(), || {
            areas_kept_here(stores, workspace_id)
        });
        match &local {
            Some(local) => effective_definition(&repo_norm, &cache.pending, local, &default_branch),
            None => overlay(&repo_norm, &cache.pending).normalized(&default_branch),
        }
    });
    let queue = load_queue(stores.project_configs, workspace_id);
    DefinitionView {
        // 1.173.0 (E1): Next improvement's direction asks the same way.
        conflicts: crate::setting_conflict::conflicts_of(&queue)
            .into_iter()
            .chain(crate::next_improvement::setting_conflicts_in(
                &stores.project_configs.workspace_dir(workspace_id),
            ))
            .collect(),
        read_only: cache.write_access.read_only(),
        cache,
        effective,
        default_branch,
        queue,
        provenance: BTreeMap::new(),
    }
}

/// Read `<cwd>/.atelier/workspace.json` from the checkout, else the legacy
/// file converted. Import only (`workspace.rs`), where nothing else exists
/// yet; everything after that reads the integration branch.
pub fn read_checkout_identity(cwd: &Path) -> Result<Option<WorkspaceDefault>, String> {
    let path = cwd.join(DEFINITION_PATH);
    if path.is_file() {
        let bytes = std::fs::read(&path).map_err(|e| format!("read {path:?}: {e}"))?;
        let def = parse_definition(&bytes)
            .map_err(|bad| format!("parse {path:?}: {} — {}", bad.summary(), bad.message))?;
        return Ok(Some(WorkspaceDefault {
            name: def.name,
            accent_color: def.accent_color,
            layout_preset: None,
            kanban_sync_mode: def.board,
            github_owner_repo: def.github_owner_repo,
        }));
    }
    crate::workspace::read_workspace_default(cwd)
}

// ── App glue ──────────────────────────────────────────────────────────

/// Reads and edits of one workspace's definition run one at a time (a Sync
/// can overlap the periodic read). Per workspace, so one slow fetch never
/// holds up another workspace's Start build.
static WORKSPACE_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

/// How long a publish-now press waits for the workspace lock
/// ([`library_change`]) before it says a Sync is running.
const PUBLISH_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) const PUBLISH_BUSY_WORDS: &str =
    "A Sync of this workspace is still running, so nothing was published. Try again in a moment.";

/// `lock`, taken within `wait`, or `None`. A poisoned lock is taken as it is,
/// as every other holder of the workspace lock does.
fn lock_within(
    lock: &std::sync::Mutex<()>,
    wait: std::time::Duration,
) -> Option<std::sync::MutexGuard<'_, ()>> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        match lock.try_lock() {
            Ok(guard) => return Some(guard),
            Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn workspace_lock(workspace_id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    WORKSPACE_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(workspace_id.to_string())
        .or_default()
        .clone()
}

fn with_app_stores<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    f: impl FnOnce(&Stores<'_>, &GitRepo) -> Result<T, String>,
    workspace_id: &str,
) -> Result<T, String> {
    use tauri::Manager;
    let (Some(workspaces), Some(project_configs)) = (
        app.try_state::<WorkspaceStore>(),
        app.try_state::<ProjectConfigStore>(),
    ) else {
        return Err("workspace stores are not ready".to_string());
    };
    let cwd = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd))
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;
    let stores = Stores {
        workspaces: &workspaces,
        project_configs: &project_configs,
        // OB-8: the licence gate, and — while only the free beta opens it —
        // this Mac's "Move to GitHub Issues" for the repository.
        github_board_allowed: crate::workspace_adoption::github_board_runs_here(app, &cwd),
    };
    // OB-7b: every refresh, publish and library sync of the shared
    // definition (fetch, ls-remote, push, `gh`) runs as the workspace's
    // GitHub account.
    let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
    f(&stores, &GitRepo { cwd })
}

/// Run `f` over the app's stores under the workspace's definition lock — the
/// lock every refresh, edit and publish of the workspace takes (GH #81 Share).
pub fn with_workspace_lock<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    f: impl FnOnce(&Stores<'_>, &GitRepo) -> Result<T, String>,
) -> Result<T, String> {
    let lock = workspace_lock(workspace_id);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    with_app_stores(app, f, workspace_id)
}

/// One refresh with the queue drained: read the branch first, so a publish
/// goes to the integration branch the definition names *now* (pending edits
/// survive that read); drain the queue there; then read again, so the report
/// and the cache say what the branch holds after the publish.
pub fn refresh_and_publish(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    publisher: &dyn Publisher,
    workspace_id: &str,
    moment: RefreshMoment,
) -> Result<RefreshReport, String> {
    // 1.175.0 (C1): a removal waiting in a pull request — merged, sharing
    // stopped here; closed, the setup stays shared.
    let settled =
        crate::stop_sharing::settle(stores, publisher, workspace_id, crate::shared_config::now_millis() / 1000);
    let mut report = refresh_with(stores, repo, workspace_id, moment)?;
    // Round 5: this computer's settings pull requests that wait on the
    // removal are closed after the read — only if it still found the setup
    // not shared.
    let said = settled
        .or(report.sharing.take())
        .or_else(|| crate::stop_sharing::close_deferred(stores, publisher, workspace_id));
    report.sharing = said.clone();
    let queued = !load_queue(stores.project_configs, workspace_id).is_empty()
        || load_cache(stores.project_configs, workspace_id).is_some_and(|c| !c.pending.is_empty());
    if !queued {
        return Ok(report);
    }
    let publish = publish_pending_at(stores, repo, publisher, workspace_id, matches!(moment, RefreshMoment::Sync | RefreshMoment::Publish)).unwrap_or_else(|e| {
        log::warn!("workspace_definition: publishing {workspace_id} failed: {e}");
        None
    });
    if publish.is_some() {
        let after = refresh_with(stores, repo, workspace_id, moment)?;
        let mut changes = report.changes;
        for change in after.changes.iter().cloned() {
            changes.retain(|c| c.field != change.field);
            changes.push(change);
        }
        report = RefreshReport { changes, ..after };
        report.sharing = said.or(report.sharing.take());
    }
    report.publish = publish;
    Ok(report)
}

/// WALKFIX-1 (walk): a page read settles what GitHub already says of the
/// removal's pull request (one `gh pr view`, a read), so the merged/closed
/// toast doesn't wait for the ten-minute read. It writes nothing to GitHub:
/// this computer's settings pull requests that wait on it are closed by the
/// next read that isn't a page's (`close_deferred`), as before.
fn page_read(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    publisher: &dyn Publisher,
    workspace_id: &str,
    moment: RefreshMoment,
) -> Result<RefreshReport, String> {
    let settled = crate::stop_sharing::settle(stores, publisher, workspace_id, crate::shared_config::now_millis() / 1000);
    // Windows walk: the pull requests the queue waits on too — a Share's
    // or a conversion's closed without merging, a field's merged — read
    // (`gh pr view`) and settled here; nothing is written to GitHub, and
    // nothing is published (the queue's drains do that, as before).
    let prs = settle_waiting_here(stores, publisher, workspace_id);
    let mut report = refresh_with(stores, repo, workspace_id, moment)?;
    report.sharing = settled.or(report.sharing.take());
    if report.publish.is_none() {
        report.publish = prs;
    }
    Ok(report)
}

/// How many pull requests a page read asks GitHub about, at most.
const PAGE_READ_PR_ASKS: usize = 5;

/// [`settle_waiting`] for a page read: `Some` when it settled a pull request
/// the toasts should say (closed without merging, a declined conversion).
fn settle_waiting_here(stores: &Stores<'_>, publisher: &dyn Publisher, workspace_id: &str) -> Option<PublishReport> {
    let mut queue = load_queue(stores.project_configs, workspace_id);
    let waits = queue.create_pull_request.is_some()
        || !queue.superseded_pull_requests.is_empty()
        || queue.fields.values().any(|f| f.pull_request.is_some());
    if !waits {
        return None;
    }
    let mut cache = load_cache(stores.project_configs, workspace_id)?;
    let mut report = PublishReport { branch: cache.branch.clone().unwrap_or_default(), ..Default::default() };
    settle_waiting(publisher, &mut queue, &mut cache, &mut report, true);
    cache.pending_state = pending_state_of(&cache, &queue);
    if let Err(e) = save_queue(stores.project_configs, workspace_id, &queue).and_then(|_| save_cache(stores.project_configs, workspace_id, &cache)) {
        log::warn!("workspace_definition: settling {workspace_id}'s pull requests at a page read: {e}");
        return None;
    }
    (!report.closed_pull_requests.is_empty() || report.conversion_declined.is_some()).then_some(report)
}

/// [`refresh_and_publish`], or only the read for a moment that [only reads](RefreshMoment::only_reads).
pub fn read_at_moment(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    publisher: &dyn Publisher,
    workspace_id: &str,
    moment: RefreshMoment,
) -> Result<RefreshReport, String> {
    if moment.only_reads() {
        return page_read(stores, repo, publisher, workspace_id, moment);
    }
    refresh_and_publish(stores, repo, publisher, workspace_id, moment)
}

pub(crate) fn publisher_for(repo: &GitRepo) -> crate::shared_config::GitPublisher {
    crate::shared_config::GitPublisher {
        git: crate::shared_config::Plumbing {
            cwd: repo.cwd.clone(),
        },
        gh: crate::doctor::require("gh")
            .ok()
            .map(crate::shared_config::Gh::new),
        // 1.173.0 (C3): the other computer names this one.
        device: crate::account::shared_device_name(),
    }
}

/// Blocking (it fetches, and may push): call from a worker. Drains the publish
/// queue first — so every Sync, 10-minute read and post-edit read retries it —
/// then reads the branch. A moment that [only reads](RefreshMoment::only_reads)
/// pushes nothing. Emits [`REFRESHED_EVENT`].
pub fn refresh_definition<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    moment: RefreshMoment,
) -> Result<RefreshReport, String> {
    use tauri::Emitter;
    let lock = workspace_lock(workspace_id);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut directions_changed = Vec::new();
    let report = with_app_stores(
        app,
        |stores, repo| {
            if !repo.cwd.is_dir() {
                return Err(format!("{} is missing", repo.cwd.display()));
            }
            let mut report =
                read_at_moment(stores, repo, &publisher_for(repo), workspace_id, moment)?;
            if report.has_definition {
                if !moment.only_reads() {
                    report.library = sync_library(stores, repo, workspace_id);
                    // 1.173.0 (E1): a Next improvement direction waiting here.
                    directions_changed = crate::next_improvement::drain(stores.project_configs, &repo.cwd, workspace_id);
                }
                report.read_only = load_cache(stores.project_configs, workspace_id)
                    .is_some_and(|c| c.write_access.read_only());
            }
            Ok(report)
        },
        workspace_id,
    )?;
    // GH #82: promoted personal notes now on the branch leave the personal
    // layer — only if unedited since the share.
    use tauri::Manager;
    if let (Some(library), Some(memory)) = (
        report.library.as_ref(),
        app.try_state::<crate::memory::MemoryStore>(),
    ) {
        settle_promotions(&memory, &library.promoted);
    }
    crate::next_improvement::emit_changed(app, workspace_id, &directions_changed);
    let _ = app.emit(REFRESHED_EVENT, &report);
    Ok(report)
}

/// Remove each promoted personal note that is still as it was when shared.
pub fn settle_promotions(
    memory: &crate::memory::MemoryStore,
    promoted: &[crate::shared_library_sync::PersonalSource],
) {
    use crate::memory::MemoryScope;
    for source in promoted {
        let scope = if source.workspace_id.is_some() {
            MemoryScope::Workspace
        } else {
            MemoryScope::Global
        };
        match memory.delete_if_unchanged(
            scope,
            source.workspace_id.as_deref(),
            &source.id,
            &source.updated_at,
        ) {
            Ok(true) => {}
            Ok(false) => log::info!(
                "workspace_definition: promoted note {} was edited since, or is gone; kept",
                source.id
            ),
            Err(e) => log::warn!("workspace_definition: removing promoted note {}: {e}", source.id),
        }
    }
}

/// The refresh a Sync or Start build runs first. A failure is logged and never
/// blocks the action: the cached definition is still the last good one.
pub fn refresh_before<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    moment: RefreshMoment,
) {
    if let Err(e) = refresh_definition(app, workspace_id, moment) {
        log::warn!("workspace_definition: {moment:?} refresh of {workspace_id} failed: {e}");
    }
}

/// Publish a queued edit now, on its own thread: the edit's IPC returns at
/// once and the value is already applied locally. Waits for the workspace
/// lock like any refresh, so publishes stay serialized.
pub(crate) fn spawn_publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) {
    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    std::thread::spawn(move || refresh_before(&app, &workspace_id, RefreshMoment::Publish));
}

/// [`spawn_publish`] after `delay` (1.169.0, C4: a removal's Undo window).
/// A drain in between leaves the removal queued until its `not_before`
/// (Challenger); a withdrawn change is no longer in the queue to publish.
fn spawn_publish_after<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, delay: std::time::Duration) {
    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    std::thread::spawn(move || {
        // A little past the change's `not_before`, so this drain finds it due.
        std::thread::sleep(delay + std::time::Duration::from_millis(250));
        refresh_before(&app, &workspace_id, RefreshMoment::Publish);
    });
}

/// A local setter of a shared field (rename, accent, board, project config):
/// run `edit` and record it as pending under the workspace's lock, so a
/// refresh can never read the new value, put the repo's back, and leave the
/// edit unrecorded; then publish it through the write channel. Blocking — the
/// lock waits out an in-flight fetch — so call it from a worker. Emits
/// [`EDITED_EVENT`]. Recording is best effort; the edit's own result is
/// returned.
pub fn edit_shared<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    edit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    edit_shared_named(app, workspace_id, None, edit)
}

/// [`edit_shared`] for an edit that gives everyone `name_edit` as the Name —
/// the workspace rename ([`record_local_edit_named`]).
pub fn edit_shared_named<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    name_edit: Option<String>,
    edit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use tauri::Emitter;
    let lock = workspace_lock(workspace_id);
    let serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    // 1.175.0 B2: checks or an install step this edit changes are this Mac's own.
    let ran_before = crate::checks_consent::in_use_of(app, workspace_id);
    let out = edit()?;
    let recorded = with_app_stores(
        app,
        |stores, repo| record_local_edit_named(stores, repo, workspace_id, false, name_edit),
        workspace_id,
    );
    crate::checks_consent::approve_own_after(app, workspace_id, ran_before.as_ref(), recorded.as_ref().err());
    drop(serial);
    match recorded {
        Ok(Some(view)) => {
            let _ = app.emit(EDITED_EVENT, workspace_id);
            if !view.queue.is_empty() {
                spawn_publish(app, workspace_id);
            }
        }
        Ok(None) => {}
        // GH #82: put back, so the caller must say so.
        Err(e) if e.contains("ask for write access") => {
            let _ = app.emit(EDITED_EVENT, workspace_id);
            return Err(e);
        }
        Err(e) => {
            log::warn!("workspace_definition: recording a local edit of {workspace_id} failed: {e}")
        }
    }
    Ok(out)
}

pub fn app_view<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<Option<DefinitionView>, String> {
    with_app_stores(
        app,
        |stores, repo| Ok(get_view(stores, repo, workspace_id)),
        workspace_id,
    )
}

/// Card #94: what Settings offers for `Integration branch`, and the branch a
/// workspace falls back to when nothing else names one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchChoices {
    /// Origin's branches, newest first. Only what was really read: a list
    /// padded with the default branch would make a failed read look like a
    /// successful one, and the row could never say it can't choose
    /// (card #94 review, F7).
    pub branches: Vec<String>,
    /// The repository's default branch, as git reports it. A workspace with
    /// neither a shared definition nor a config on this Mac takes its target
    /// branch from here rather than guessing.
    pub default_branch: String,
    /// Why the branches could not be read from origin: offline, no
    /// credentials, a refused fetch. `None` when the read went through —
    /// which for a repository without an origin still means no branches.
    pub error: Option<String>,
    /// The repository has an `origin` to read branches from at all.
    pub has_origin: bool,
    /// 1.174.0 (Areas round 1): this computer's own branches (no fetch);
    /// empty when git can't say.
    #[serde(default)]
    pub local_branches: Vec<String>,
    /// Windows walk (C4): what kind of failure `error` is
    /// (`shared_config::classify_trouble`), so "Cards go to" says a sign-in
    /// trouble as itself and "offline" only for the network. `None` with no
    /// error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trouble: Option<crate::shared_config::PublishTrouble>,
    /// F3 walk: the host of an `origin` that isn't on GitHub ("gitlab.com"),
    /// so the row never says GitHub for it. `None` for GitHub, no origin, a
    /// local path, or an address Plyloft can't read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_host: Option<String>,
}

/// F3 walk: [`BranchChoices::origin_host`] of the repository at `cwd`
/// (`git remote get-url origin`, local).
pub fn origin_host_elsewhere(cwd: &std::path::Path) -> Option<String> {
    match crate::commands::pr_origin(cwd) {
        // A local path ("this computer") keeps the generic sentence.
        crate::commands::PrOrigin::Elsewhere(host) if host != "this computer" => Some(host),
        _ => None,
    }
}

pub fn branch_choices(repo: &dyn RepoSource, in_use: Option<&str>) -> BranchChoices {
    let error = repo.fetch_branches().err();
    let default_branch = repo.default_branch();
    fn push(branches: &mut Vec<String>, b: &str) {
        if !b.is_empty() && !branches.iter().any(|k| k == b) {
            branches.push(b.to_string());
        }
    }
    let mut branches: Vec<String> = Vec::new();
    for b in repo.branches() {
        push(&mut branches, &b);
    }
    // The branch in use is always offerable when the read went through:
    // the row must never show a value its own select cannot hold.
    if error.is_none() && !branches.is_empty() {
        push(&mut branches, &default_branch);
        if let Some(b) = in_use {
            push(&mut branches, b);
        }
    }
    BranchChoices {
        has_origin: repo.has_origin(),
        branches,
        default_branch,
        trouble: error.as_deref().map(|e| crate::shared_config::classify_trouble(e, true)),
        error,
        local_branches: repo.local_branches(),
        origin_host: None,
    }
}

pub fn app_branches<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<BranchChoices, String> {
    with_app_stores(
        app,
        |stores, repo| {
            let in_use = get_view(stores, repo, workspace_id)
                .and_then(|v| v.effective)
                .and_then(|d| d.integration_branch);
            let mut choices = branch_choices(repo, in_use.as_deref());
            choices.origin_host = origin_host_elsewhere(&repo.cwd);
            Ok(choices)
        },
        workspace_id,
    )
}

pub fn app_save<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    base: Map<String, Value>,
    draft: Map<String, Value>,
    approve_setup: bool,
) -> Result<DefinitionView, String> {
    use tauri::Emitter;
    let view = {
        let lock = workspace_lock(workspace_id);
        let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
        with_app_stores(
            app,
            |stores, repo| save_changes_with(stores, repo, workspace_id, base, draft, approve_setup),
            workspace_id,
        )?
    };
    let _ = app.emit(EDITED_EVENT, workspace_id);
    if !view.queue.is_empty() {
        spawn_publish(app, workspace_id);
    }
    Ok(view)
}

/// 1.174.0 (C10, D6): the Board's sheet about this Mac's set-aside areas.
/// "Use the repository's" (`publish_mine` false) writes nothing to the
/// repository: the sheet asks no more, and the list stays in its own file
/// here. "Publish mine" is an edit of the shared `areas` field, made by the
/// press like Settings › Areas' Publish, through the same save and channel.
/// True when an edit was recorded.
pub fn answer_set_aside(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    publish_mine: bool,
) -> Result<bool, String> {
    let Some(aside) = crate::areas::set_aside(stores.project_configs, workspace_id) else {
        return Ok(false);
    };
    if publish_mine {
        let mut draft = Map::new();
        draft.insert(
            "areas".to_string(),
            serde_json::to_value(&aside.areas).map_err(|e| format!("encode the areas: {e}"))?,
        );
        save_changes(stores, repo, workspace_id, Map::new(), draft)?;
    }
    crate::areas::clear_set_aside(stores.project_configs, workspace_id)?;
    Ok(publish_mine)
}

pub fn app_answer_set_aside<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    publish_mine: bool,
) -> Result<(), String> {
    use tauri::Emitter;
    let published = with_workspace_lock(app, workspace_id, |stores, repo| {
        answer_set_aside(stores, repo, workspace_id, publish_mine)
    })?;
    let _ = app.emit(EDITED_EVENT, workspace_id);
    if published {
        spawn_publish(app, workspace_id);
    }
    Ok(())
}

/// 1.174.0 (C10, D6): Settings › Areas' Save where nothing is shared, under
/// the workspace's lock so it can't land beside a Share.
pub fn app_areas_save_local<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    areas: &[crate::areas::AreaDef],
) -> Result<(), String> {
    use tauri::Emitter;
    with_workspace_lock(app, workspace_id, |stores, _| {
        crate::areas::save_local(stores.project_configs, workspace_id, areas)
    })?;
    let _ = app.emit(EDITED_EVENT, workspace_id);
    Ok(())
}

/// GH #160: the URL of a pull request one of the **library** queue's changes is
/// waiting in — a shared note, a project skill, or the instructions.
///
/// The row that says `Waiting in pull request #375` offers `Open pull request`,
/// and so does the toast that announces the outcome; both of them asked the
/// definition queue, which knows nothing about a library change, and got
/// `No pull request #375 is waiting for this workspace.` The two queues are
/// searched in turn, and nothing but a URL a queue is really waiting on is ever
/// opened.
pub fn waiting_library_pull_request_url(
    queue: &crate::shared_library_sync::LibraryQueue,
    number: u64,
) -> Option<String> {
    queue
        .changes
        .iter()
        .filter_map(|change| change.pull_request.as_ref())
        .find(|pr| pr.number == number)
        .map(|pr| pr.url.clone())
        .filter(|url| url.starts_with("https://"))
}

/// GH #160: the library queue of one workspace, for the lookup above. `None`
/// when the workspace shares nothing.
pub fn app_library_queue<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Option<crate::shared_library_sync::LibraryQueue> {
    with_app_stores(
        app,
        |stores, repo| {
            Ok(library_target(stores, repo, workspace_id)
                .map(|(_, _, paths)| crate::shared_library_sync::load_queue(&paths)))
        },
        workspace_id,
    )
    .ok()
    .flatten()
}

/// The URL of a pull request the queue is waiting on — the only URLs
/// Settings may ask Ply to open for the definition.
pub fn waiting_pull_request_url(queue: &PublishQueue, number: u64) -> Option<String> {
    queue
        .fields
        .values()
        .filter_map(|f| f.pull_request.as_ref())
        .chain(queue.create_pull_request.as_ref())
        .find(|pr| pr.number == number)
        .map(|pr| pr.url.clone())
        .filter(|url| url.starts_with("https://"))
}

/// Queue the whole definition for the branch — a converted
/// `workspace_default.json` has no `workspace.json` there yet.
pub fn queue_definition(stores: &Stores<'_>, workspace_id: &str) -> Result<(), String> {
    let cache = load_cache(stores.project_configs, workspace_id)
        .filter(|c| c.definition.is_some())
        .ok_or_else(|| "This workspace has no shared definition yet.".to_string())?;
    if let Some(bad) = &cache.unreadable {
        let branch = cache.branch.as_deref().unwrap_or("the integration branch");
        return Err(bad.newer_sentence(branch, true).unwrap_or_else(|| {
            format!("{} in the repository is {}; fix it there first", bad.path, bad.summary())
        }));
    }
    let mut queue = load_queue(stores.project_configs, workspace_id);
    if queue.create_pull_request.is_some() {
        // Already waiting in a pull request: don't open another.
        return Ok(());
    }
    queue.create_definition = true;
    save_queue(stores.project_configs, workspace_id, &queue)
}

/// Settings › Project's "Publish .atelier/workspace.json": queue the
/// definition and publish it now. The returned view says whether it reached
/// the branch, waits in a pull request, or is pending sync.
pub fn app_publish_definition<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Result<DefinitionView, String> {
    use tauri::Emitter;
    {
        let lock = workspace_lock(workspace_id);
        let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
        with_app_stores(
            app,
            |stores, _| queue_definition(stores, workspace_id),
            workspace_id,
        )?;
    }
    let _ = app.emit(EDITED_EVENT, workspace_id);
    refresh_definition(app, workspace_id, RefreshMoment::Publish)?;
    app_view(app, workspace_id)?
        .ok_or_else(|| "This workspace has no shared definition yet.".to_string())
}

#[cfg(test)]
#[path = "workspace_definition_tests.rs"]
mod tests;
