use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const WORKSPACES_FILE: &str = "workspaces.json";

/// v1.23.0 (Cycle G3): canonical list of right-tab IDs the frontend
/// knows how to render. Persisted `pinnedRightTabs` entries that don't
/// appear here are silently stripped on load — protects users whose
/// workspaces.json was written by an older Atelier (e.g. with `"run"`,
/// `"browser"`, or `"worktrees"` pinned) from a runtime crash when the
/// FE tries to render an unknown tab. Tier 2 test
/// `pre_v23_workspace_strips_removed_pinned_tabs` pins this invariant.
// v1.71.0 (UX revamp step 5b-1): `editor` / `kanban` / `dashboard` /
// `inbox` retired — folded into the center stage modes. Persisted
// pinned entries with those keys are dropped by the sanitizer below
// (same mechanism as the v1.23.0 11→8 trim).
// v1.72.0 (step 5b-2): `prompts` retired (the Knowledge panel + shared
// layer own its job) and `memory` RENAMED to `knowledge` — the
// sanitizer MAPS the old key so persisted pins survive the rename.
// v1.76.0 (STEP6 D7): `card` retired — the lifecycle owns the center
// stage; persisted `card` pins are dropped on load.
// v1.81.0 (Part 2 P2-3, Q1): `swarm` / `agents` / `project` retired —
// agent CRUD, swarm templates and project config moved to Settings ›
// This workspace; brainstorm-start to the Board toolbar; swarm run
// history to Activity. Knowledge anchors the panel; stale pins drop.
// GH #95 (ADR 0005): the right panel is retired and the frontend no longer
// reads the field. It is still decoded and sanitized so old files load, and
// never reset: see `retired_right_panel_pins_load_and_change_nothing`.
pub const KNOWN_RIGHT_TABS: &[&str] = &["knowledge"];

/// v1.23.0 (Cycle G3): drop any pinned-tab IDs not in `KNOWN_RIGHT_TABS`.
/// Returns the filtered list. Pure — caller decides whether to assign it
/// back. `None` passes through unchanged; an empty `Some(vec![])` after
/// filtering is preserved (FE renders just the `•••` overflow in that
/// case, which is fine).
fn sanitize_pinned_right_tabs(tabs: Option<Vec<String>>) -> Option<Vec<String>> {
    tabs.map(|v| {
        v.into_iter()
            // v1.72.0 (step 5b-2): `memory` → `knowledge` key rename —
            // mapped, not dropped, so persisted pins survive.
            .map(|t| {
                if t == "memory" {
                    "knowledge".to_string()
                } else {
                    t
                }
            })
            .filter(|t| KNOWN_RIGHT_TABS.iter().any(|k| *k == t.as_str()))
            .collect()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: i64,
    #[serde(rename = "openFiles", default)]
    pub open_files: Vec<String>,
    #[serde(rename = "activeFile", default)]
    pub active_file: Option<String>,
    /// v0.5.0: optional per-workspace accent color (hex e.g. "#7c3aed").
    /// Rendered as a colored dot in the sidebar. None → neutral grey.
    #[serde(rename = "accentColor", default)]
    pub accent_color: Option<String>,
    /// v1.4.0 (L2): optional tile-grid layout override. None / "auto"
    /// (current behavior) → grid auto-sizes from tile count. Other valid
    /// values map to fixed shapes: "single" (1×1), "split" (1×2),
    /// "quad" (2×2), "six" (2×3). Persisted per-workspace; the user
    /// picks via the AppToolbar dropdown.
    #[serde(rename = "layoutPreset", default)]
    pub layout_preset: Option<String>,
    /// v1.11.x (Phase C): per-workspace verify-pipeline config.
    /// `None` ⇒ defaults inferred from cwd manifest at run time
    /// (Cargo.toml ⇒ cargo-test; package.json with `test` script ⇒
    /// npm-test; presence of `scripts/ppvp.sh` ⇒ ppvp-sh). When set,
    /// overrides the inferred suite.
    #[serde(rename = "verifySuite", default)]
    pub verify_suite: Option<VerifySuite>,
    /// v1.14.0 (Chrome restructure): per-workspace right-tab pin order.
    /// `None` ⇒ frontend renders the default `[editor, kanban, card]`
    /// pinned set. When `Some`, the listed tabs are pinned (rendered as
    /// buttons) and the rest live behind the `•••` overflow. Empty vec
    /// is allowed — bar collapses to `•••` + transient slot for the
    /// active tab.
    #[serde(rename = "pinnedRightTabs", default)]
    pub pinned_right_tabs: Option<Vec<String>>,
    /// v1.43.0 (Sidebar identity): per-workspace icon. `None` ⇒ frontend
    /// derives a monogram from the workspace name. `Some(Monogram)` is
    /// the explicit "default" sentinel after a Reset. `Emoji`/`Image`
    /// are user-customized overrides. Image carries `mtime` (millis) so
    /// the FE can cache-bust `<img src>` after replace.
    #[serde(rename = "icon", default)]
    pub icon: Option<WorkspaceIcon>,
    /// v1.57.0 (Cycle 3 — GitHub Issues backing): `owner/repo` for the GitHub
    /// repo whose issues back this workspace's kanban when
    /// `kanban_sync_mode == GitHubIssues`. None for local-only workspaces.
    #[serde(rename = "githubOwnerRepo", default)]
    pub github_owner_repo: Option<String>,
    /// v1.57.0 (Cycle 3): whether the kanban board is local-only or mirrors
    /// GitHub issues. Defaults to `Local` (legacy + new local workspaces).
    #[serde(rename = "kanbanSyncMode", default)]
    pub kanban_sync_mode: KanbanSyncMode,
    /// Onboarding (ONBOARDING_SPEC §8.4): the GitHub login Ply uses for this
    /// workspace's GitHub calls when several accounts are signed in. `None` =
    /// gh's active account (every workspace before it). Personal, per Mac:
    /// never written into `.atelier/`. Left out of the file while unset.
    #[serde(
        rename = "githubAccount",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub github_account: Option<String>,
    /// SL-3 (ship loop): "Merge when checks pass" beside Ship as a PR — the
    /// choice is remembered here. On, a PR the card ships is set to merge on
    /// GitHub once its checks pass (`gh pr merge --squash --auto`). Personal
    /// to this Mac, like `github_account`; left out of the file while off.
    #[serde(
        rename = "mergeWhenChecksPass",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub merge_when_checks_pass: bool,
    /// 1.170.0 (G1): how this workspace's **Ship it** ships — `"github"`
    /// (a pull request that merges when its checks pass) or `"local"` (a
    /// land on this Mac only). `None` = the default: GitHub on a
    /// project whose `origin` can take a pull request, this Mac
    /// otherwise (`commands::resolve_ship_press`). Personal to this Mac like
    /// `merge_when_checks_pass`, never in `.atelier/`; left out of the file
    /// while unset. A string, not an enum: a value a later build writes reads
    /// as the default here instead of failing the whole file.
    #[serde(rename = "shipVia", default, skip_serializing_if = "Option::is_none")]
    pub ship_via: Option<String>,
    /// 1.170.0 (G1): the one-time "Ship it now puts the card on GitHub"
    /// notice was answered for this workspace. Off for every workspace from
    /// before it; left out of the file while off.
    #[serde(
        rename = "shipNoticeSeen",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub ship_notice_seen: bool,
    /// G7 (1.170.0): the workspace's default for "Fix failing checks by
    /// itself" — a card that never flipped its own switch follows it. Off by
    /// default (owner, 2026-10-26); personal to this Mac like
    /// `merge_when_checks_pass`; left out of the file while off.
    #[serde(
        rename = "fixFailingChecks",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub fix_failing_checks: bool,
    /// G7 fixes (Minor 5): when the default above was turned on (ms) — it
    /// covers only failures first seen after it. Absent while off, and on a
    /// file from before it (turned on then: every failure counts).
    #[serde(
        rename = "fixFailingChecksSince",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub fix_failing_checks_since: Option<i64>,
    /// 1.175.0 (F7, UX-7; owner I9): the card offered "Turn on" for "Fix
    /// failing checks by itself" in this project once — the person turned
    /// it on or said Not now — so the offer never comes back here. Personal
    /// to this Mac like the default above; left out of the file while false.
    #[serde(
        rename = "fixFailingChecksOffered",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub fix_failing_checks_offered: bool,
    /// CL-4: this workspace's own Builder and Challenger models (Claude and
    /// Codex, plus Codex reasoning), merged field by field over the app's
    /// `behavior.models` (`settings::resolve_model`). Personal to this Mac
    /// like `github_account` — never in `.atelier/` (ADR 0003). A field can
    /// also be forced to the CLI's own default (`cliDefault`, round 2). `None`
    /// = the app rows; left out of the file while unset.
    #[serde(rename = "models", default, skip_serializing_if = "Option::is_none")]
    pub models: Option<crate::settings::WorkspaceModels>,
    /// CL-9: how the Board's List view groups its rows — `"stage"` (To do →
    /// Shipped) or, absent, by attention (the columns). A viewer preference,
    /// personal to this Mac like `github_account`; left out of the file while
    /// it is the default. A string, not an enum: a value a later build adds
    /// reads as the default here instead of failing the whole file.
    #[serde(
        rename = "listGrouping",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub list_grouping: Option<String>,
    /// N18: "Delete card branches when their trash expires" turned off for
    /// this workspace (Settings › Board and worktrees). Off by default, so
    /// the cleanup is on; personal to this Mac like `github_account`; left
    /// out of the file while off.
    #[serde(
        rename = "keepCardBranches",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub keep_card_branches: bool,
    /// F1 (1.172.1): the person said *I don't work here* about the project
    /// folder — the Board's "Your project folder is from …" notice and its
    /// toast stop for this workspace; Code and terminals opened in the
    /// folder keep a quiet line. Off by default (every workspace before it);
    /// personal to this Mac like `keep_card_branches`; left out of the file
    /// while off.
    #[serde(
        rename = "dontWorkHere",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub dont_work_here: bool,
    /// N18: the answer to the one-time proposal to delete the branches of
    /// cards shipped before the cleanup existed (`branch_cleanup::scan_backlog`).
    /// `None` = not asked yet; left out of the file while unset.
    #[serde(
        rename = "branchBacklog",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub branch_backlog: Option<crate::branch_cleanup::BacklogAnswer>,
    /// Owner, 2026-10-20: whether the person chose this workspace's name. A
    /// shared `.atelier/workspace.json` fills in its Name only while this is
    /// not so, and never renames a workspace the person named, at the first
    /// read or at a teammate's later rename. `Some(true)`: added with a name
    /// other than its folder's, or renamed here. `Some(false)`: named after
    /// its folder (Open/Add's default) or by the shared definition itself.
    /// `None`: a workspace from before this field —
    /// `workspace_definition::keeps_own_name` reads it from the name. Left
    /// out of the file while unset.
    #[serde(rename = "nameChosen", default, skip_serializing_if = "Option::is_none")]
    pub name_chosen: Option<bool>,
    /// 1.170.0 (G3): the merge methods GitHub last said each repository of
    /// this workspace's pull requests allows, with the time it was read
    /// (`merge_method`), keyed `host/owner/repo` (G1–G3 Challenger 5; G3's
    /// single answer loads into it): Merge, Merge when checks pass and the
    /// ship's auto-merge use the one it allows. A cache — read again after a
    /// day, or when a merge is refused for its method. Personal to this Mac,
    /// never in `.atelier/`; left out of the file while empty.
    #[serde(rename = "mergeMethods", default, skip_serializing_if = "crate::merge_method::MergeMethodCache::is_empty")]
    pub merge_methods: crate::merge_method::MergeMethodCache,
    /// 1.173.0 (B2): the area this Mac's area picker starts at — an id of
    /// the repository's areas (`areas::AreaDef::id`). "Personal to this
    /// Mac": never in `.atelier/`. `None` = *All areas*; an id the
    /// repository no longer lists reads as *All areas* too, with no error.
    /// Left out of the file while unset.
    #[serde(rename = "defaultArea", default, skip_serializing_if = "Option::is_none")]
    pub default_area: Option<String>,
    /// 1.173.0 (B2): *Not now* on the Board's "This repository seems to hold
    /// two products" notice — it never comes back for this workspace on this
    /// Mac (Settings › Areas stays). Left out of the file while off.
    #[serde(
        rename = "areaNoticeDismissed",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub area_notice_dismissed: bool,
}

/// G1: the ways a workspace's Ship it can be set to ship (`Workspace::ship_via`).
pub const SHIP_VIA_VALUES: [&str; 2] = ["github", "local"];

/// The name Open/Add gives a folder by default: its last component.
pub fn folder_name(cwd: &str) -> Option<String> {
    Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// v1.43.0 (Sidebar identity): tagged variant for per-workspace icon.
/// Serializes as `{ "kind": "monogram" }`, `{ "kind": "emoji", "value": "🎨" }`,
/// or `{ "kind": "image", "path": "...", "mtime": 1700000000000 }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceIcon {
    Monogram,
    Emoji { value: String },
    Image { path: String, mtime: i64 },
}

/// v1.57.0 (Cycle 3 — GitHub Issues backing): how a workspace's kanban board
/// is sourced. `Local` (default) keeps the board entirely in this user's
/// app-data. `GitHubIssues` mirrors cards to issues in `github_owner_repo`
/// (claim via assignee, sync on focus / poll). Serializes as
/// `"local"` / `"githubIssues"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum KanbanSyncMode {
    #[default]
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "githubIssues")]
    GitHubIssues,
}

/// v1.61.0 (Phase 5 — onboarding): the shape of a repo's committed
/// `.atelier/workspace_default.json`. Read once by `import_default` to
/// pre-register a workspace for a freshly-cloned shared repo (the Day-1
/// `scripts/onboard.sh` flow). Only **shared-safe** fields live here — name,
/// accent, layout preset, kanban sync mode, owner/repo. Never identity or
/// per-user run state: the file is committed and reaches every teammate.
/// All fields except `name` are optional so a minimal `{ "name": "X" }` is
/// valid; `kanban_sync_mode` defaults to `Local`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDefault {
    pub name: String,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub layout_preset: Option<String>,
    #[serde(default)]
    pub kanban_sync_mode: KanbanSyncMode,
    #[serde(default)]
    pub github_owner_repo: Option<String>,
}

/// Read `<cwd>/.atelier/workspace_default.json` if present. `Ok(None)` when
/// the file does not exist; `Err` only for an unreadable or malformed file.
/// Shared by `import_default` (onboarding) and `create` (manual add).
pub fn read_workspace_default(cwd: &Path) -> Result<Option<WorkspaceDefault>, String> {
    let manifest = cwd.join(".atelier").join("workspace_default.json");
    if !manifest.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&manifest).map_err(|e| format!("read {manifest:?}: {e}"))?;
    let def: WorkspaceDefault =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse {manifest:?}: {e}"))?;
    Ok(Some(def))
}

/// v1.11.x (Phase C): user-overridable verify pipeline for a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySuite {
    pub steps: Vec<VerifyStepKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum VerifyStepKind {
    CargoTest,
    NpmTest,
    PpvpSh,
    /// Phase C: sandboxed Atelier build via scripts/verify-build.sh.
    TauriBuild,
    /// Phase D: Claude-as-QA. Backend will spawn this once the role
    /// definition lands.
    ClaudeQa,
    /// Custom shell command. Use sparingly — prefer named steps so the
    /// frontend can render named progress.
    Shell {
        cmd: String,
        timeout_secs: u64,
    },
}

/// v1.11.x (Phase C): infer a sensible verify suite from a workspace's
/// cwd manifest. Caller invokes when `verify_suite == None`.
///
/// Detection order (additive — multiple steps may apply):
///   * `Cargo.toml` ⇒ `cargo-test`
///   * `package.json` with a `test` script ⇒ `npm-test`
///   * `scripts/ppvp.sh` ⇒ `ppvp-sh`
///   * `src-tauri/` AND `scripts/verify-build.sh` ⇒ `tauri-build`
pub fn infer_verify_suite(cwd: &Path) -> VerifySuite {
    let mut steps = Vec::new();
    if cwd.join("Cargo.toml").is_file() || cwd.join("src-tauri/Cargo.toml").is_file() {
        steps.push(VerifyStepKind::CargoTest);
    }
    if let Ok(bytes) = fs::read(cwd.join("package.json")) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let has_test = v
                .get("scripts")
                .and_then(|s| s.get("test"))
                .and_then(|t| t.as_str())
                .is_some();
            if has_test {
                steps.push(VerifyStepKind::NpmTest);
            }
        }
    }
    if cwd.join("scripts/ppvp.sh").is_file() {
        steps.push(VerifyStepKind::PpvpSh);
    }
    if cwd.join("src-tauri").is_dir() && cwd.join("scripts/verify-build.sh").is_file() {
        steps.push(VerifyStepKind::TauriBuild);
    }
    VerifySuite { steps }
}

/// v1.43.0 (Sidebar identity): sniff the leading bytes of an image to
/// decide an extension. Returns one of `"png"`, `"jpg"`, `"webp"`, or
/// `None` if the buffer doesn't look like one of those. Reject SVG
/// explicitly — never honor `<` or `<?xml` headers as a valid icon.
fn detect_image_ext(bytes: &[u8]) -> Option<&'static str> {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    // JPEG: FF D8 FF
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    // WebP: "RIFF" .... "WEBP"
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    // SVG / XML / anything else → reject.
    None
}

/// 1.175.0: the version `workspaces.json` is written with. A file from
/// before has no `version` and reads as 0; the fields are the same. One
/// with a higher number was written by a newer Plyloft and is refused
/// ([`WorkspaceStore::load`]), never read halfway and never written over.
pub(crate) const WORKSPACES_VERSION: u32 = 1;

/// What [`crate::atomic::newer_refusal`] calls `workspaces.json`.
const NEWER_LIST: &str = "The project list";

/// 1.175.0 (R3): what every save answers when `workspaces.json` has the
/// outline of a project list but holds a value this build can't read, and
/// says no version above this build's. Modelled on
/// [`crate::atomic::newer_refusal`], without the numbers it doesn't have.
pub const LIST_UNREADABLE_REFUSAL: &str =
    "The project list holds something this Plyloft can't read, so it was left as it is. Update Plyloft to change it.";

/// 1.175.0 (R3): what became of a `workspaces.json` this launch couldn't
/// use. Either way Plyloft starts, with no projects, and says so once
/// ([`WorkspaceStore::take_launch_notice`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListTrouble {
    /// Not a project list — bytes that aren't JSON, JSON without a
    /// `workspaces` array, or zero bytes while board files exist — renamed
    /// to this path. The list starts empty and is saved anew.
    SetAside(PathBuf),
    /// A project list this build mustn't write over: a newer Plyloft's, or
    /// one with a value this build can't read. Left untouched at `path`;
    /// every save of the store answers `why` and writes nothing.
    Refused { path: PathBuf, why: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspacesFile {
    /// [`WORKSPACES_VERSION`] once this build has saved the file.
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(rename = "activeWorkspaceId", default)]
    pub active_workspace_id: Option<String>,
}

pub struct WorkspaceStore {
    pub config_dir: PathBuf,
    state: Mutex<WorkspacesFile>,
    /// Held for a whole write of `workspaces.json` (see `save_atomic`).
    save_lock: Mutex<()>,
    /// What became of this launch's `workspaces.json` when it couldn't be
    /// used ([`Self::set_aside`], [`Self::refused`]).
    trouble: Option<ListTrouble>,
    /// [`Self::take_launch_notice`] handed `trouble` out.
    noticed: std::sync::atomic::AtomicBool,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Review integrity: each workspace's configured GitHub repo, which a card
/// from before recorded origins is compared with (`review_base`).
fn remember_review_slugs(file: &WorkspacesFile) {
    crate::review_base::remember_workspaces(
        file.workspaces
            .iter()
            .map(|ws| (ws.cwd.as_str(), ws.github_owner_repo.as_deref())),
    );
}

impl WorkspaceStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|e| format!("create_dir_all: {e}"))?;
        let (state, trouble) = Self::load(&config_dir.join(WORKSPACES_FILE))?;
        remember_review_slugs(&state);
        Ok(Self {
            config_dir,
            state: Mutex::new(state),
            save_lock: Mutex::new(()),
            trouble,
            noticed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// OP-3: the file this store set aside when it opened
    /// (`workspaces.json.broken-<ms>`), if it did. The list is then empty
    /// because it couldn't be read, not because there are no projects: the
    /// launch sweeps prune nothing on it (`launch_inventory`), and a notice
    /// names the file.
    pub fn set_aside(&self) -> Option<&Path> {
        match &self.trouble {
            Some(ListTrouble::SetAside(aside)) => Some(aside),
            _ => None,
        }
    }

    /// R3: why this launch's `workspaces.json` was refused and left as it
    /// is, if it was. The list is empty and stays so: every save answers
    /// this ([`Self::save_atomic`]) and the launch sweeps prune nothing.
    pub fn refused(&self) -> Option<&str> {
        match &self.trouble {
            Some(ListTrouble::Refused { why, .. }) => Some(why),
            _ => None,
        }
    }

    /// R3: what became of this launch's `workspaces.json`, without taking
    /// the notice (the reveal action).
    pub fn trouble(&self) -> Option<&ListTrouble> {
        self.trouble.as_ref()
    }

    /// R3: the launch notice — the list was set aside, or refused — the
    /// first time it is asked this launch; `None` after that, and when the
    /// list was read.
    pub fn take_launch_notice(&self) -> Option<ListTrouble> {
        let trouble = self.trouble.clone()?;
        (!self.noticed.swap(true, std::sync::atomic::Ordering::SeqCst)).then_some(trouble)
    }

    /// 1.175.0 (OP-3): a `workspaces.json` that doesn't parse used to be an
    /// error here, which `setup` passes on, so Plyloft didn't start at all.
    /// R3 (owner, 2026-11-09): none of these stops the launch any more; the
    /// second value says what happened, for the notice and the sweeps.
    ///
    /// - **Missing, `{}`, or zero bytes with no board on disk**: no
    ///   projects, a fresh profile, nothing said.
    /// - **Missing, with boards on disk and a `workspaces.json.broken-<ms>`
    ///   beside it** (round 4, T6): an earlier launch set the list aside and
    ///   nothing was saved since. Nothing is moved; the newest such file is
    ///   named again, so the notice can't be missed for good.
    /// - **Not JSON, or not an object with a `workspaces` array** (a cut-off
    ///   write, stray bytes), **or zero bytes while board files exist** (a
    ///   save that never reached the disk: there were projects): set aside
    ///   ([`Self::set_broken_aside`]) and the list starts empty. The project
    ///   folders and the board files are not touched by this, and
    ///   `launch_inventory` keeps the launch sweeps from pruning the swarms,
    ///   snapshots and discussions the boards of the lost list still name.
    /// - **A higher `version` than [`WORKSPACES_VERSION`]**: a newer
    ///   Plyloft's. Refused in [`crate::atomic::newer_refusal`]'s words and
    ///   left as it is, as a newer board is — also when this build could
    ///   parse it, since it would save it back without what it can't see.
    /// - **A project list by its outline that this build can't read** (a
    ///   value it doesn't know, as a later version's would be): refused in
    ///   [`LIST_UNREADABLE_REFUSAL`]'s words and left as it is. Nothing here
    ///   can tell a newer Plyloft's file without a version from a damaged
    ///   one, and setting a good list aside costs more than refusing it.
    ///
    /// A refused list reads as no projects, and no save ever writes over it
    /// ([`Self::save_atomic`]). The only error left is a file that can't be
    /// read at all, or one that should be set aside and can't be: starting
    /// empty there would let the next save write over the only copy.
    ///
    /// Limit (Reviewer): builds up to 1.174.5 ignore `version` and write the
    /// file back without it, so a newer Plyloft's list opened by one of them
    /// loses what that build doesn't know, with nothing said.
    ///
    /// Not `atomic::load_or_set_aside`: this follows `settings.json`, its
    /// neighbour in the same folder (`.broken-<ts>`).
    fn load(path: &Path) -> Result<(WorkspacesFile, Option<ListTrouble>), String> {
        Self::load_with(path, crate::platform::rename)
    }

    fn load_with(
        path: &Path,
        rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<(WorkspacesFile, Option<ListTrouble>), String> {
        let has_boards = || {
            let boards = path.parent().map(crate::kanban::boards_dir);
            boards.is_some_and(|dir| crate::launch_inventory::has_board_file(&dir))
        };
        if !path.exists() {
            // Round 4 (T6): the list was set aside at an earlier launch and
            // nothing was saved since — Plyloft quit before the notice was
            // seen. No list file would read as a fresh profile with nothing
            // said, while the boards and the set-aside file sit there. Said
            // again, at every launch until a list is saved.
            if let Some(aside) = Self::newest_broken_aside(path).filter(|_| has_boards()) {
                log::warn!(
                    "workspaces: no project list, but boards and {}: an earlier launch set the list aside and nothing was saved since",
                    aside.display()
                );
                return Ok((WorkspacesFile::default(), Some(ListTrouble::SetAside(aside))));
            }
            return Ok((WorkspacesFile::default(), None));
        }
        let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
        let set_aside = |why: &str, rename| {
            let aside = Self::set_broken_aside(path, why, rename)?;
            Ok((WorkspacesFile::default(), Some(ListTrouble::SetAside(aside))))
        };
        if bytes.is_empty() {
            if has_boards() {
                return set_aside("the file is empty, and there are boards", rename);
            }
            return Ok((WorkspacesFile::default(), None));
        }
        let refused = |why: String| {
            log::error!("workspaces: {}: {why}", path.display());
            Ok((WorkspacesFile::default(), Some(ListTrouble::Refused { path: path.to_path_buf(), why })))
        };
        let outline = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
        let newer = outline
            .as_ref()
            .and_then(|json| json.get("version")?.as_u64())
            .filter(|found| *found > u64::from(WORKSPACES_VERSION));
        if let Some(found) = newer {
            return refused(crate::atomic::newer_refusal(NEWER_LIST, u32::try_from(found).unwrap_or(u32::MAX), WORKSPACES_VERSION));
        }
        let mut file: WorkspacesFile = match serde_json::from_slice(&bytes) {
            Ok(file) => file,
            Err(e) => {
                let is_a_list = outline.as_ref().is_some_and(|json| json.get("workspaces").is_some_and(|w| w.is_array()));
                if is_a_list {
                    log::error!("workspaces: {} is a project list this Plyloft can't read ({e})", path.display());
                    return refused(LIST_UNREADABLE_REFUSAL.to_string());
                }
                return set_aside(&e.to_string(), rename);
            }
        };
        // v1.23.0 (Cycle G3): strip pinned-tab IDs no longer in the
        // canonical set. Forward-compat for the right-tab trim — a
        // workspace pinned to `["editor","run","browser"]` on v1.22.0
        // loads here as `["editor"]` on v1.23.0+ without crashing the
        // FE's tab renderer.
        for ws in &mut file.workspaces {
            ws.pinned_right_tabs = sanitize_pinned_right_tabs(ws.pinned_right_tabs.take());
        }
        Ok((file, None))
    }

    /// T6: the newest `workspaces.json.broken-<ms>` beside `path`, by the
    /// time in its name (one whose time can't be read is older than any that
    /// can).
    fn newest_broken_aside(path: &Path) -> Option<PathBuf> {
        let prefix = format!("{}.broken-", path.file_name()?.to_str()?);
        fs::read_dir(path.parent()?)
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let at = name.to_str()?.strip_prefix(&prefix)?.parse::<i64>().unwrap_or(i64::MIN);
                Some((at, entry.path()))
            })
            .max()
            .map(|(_, aside)| aside)
    }

    /// OP-3: renames a `workspaces.json` that doesn't parse (`why`) to
    /// `workspaces.json.broken-<ms>` beside itself and says where it went.
    /// A rename that fails is the load's error, as a parse error was before:
    /// starting empty would let the next save write over the only copy.
    fn set_broken_aside(
        path: &Path,
        why: &str,
        rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<PathBuf, String> {
        let mut aside = path.as_os_str().to_owned();
        aside.push(format!(".broken-{}", now_millis()));
        let aside = PathBuf::from(aside);
        match rename(path, &aside) {
            Ok(()) => {
                log::error!(
                    "workspaces: {} doesn't parse ({why}); kept as {} and the project list starts empty",
                    path.display(),
                    aside.display()
                );
                Ok(aside)
            }
            Err(e) => {
                log::error!("workspaces: {} doesn't parse ({why}) and couldn't be set aside ({e}); left as it is", path.display());
                Err(format!("parse: {why}; and the file couldn't be set aside: {e}"))
            }
        }
    }

    /// Persist the store. Serialized by `save_lock`, and it writes the state
    /// as it is when the write starts — not a snapshot a caller took earlier —
    /// so overlapping saves (GH #79: definition refreshes of several warmed
    /// workspaces at once) never share the tempfile mid-write and never leave
    /// an older snapshot on disk last. Call without `state` locked.
    ///
    /// 1.175.0 (OP-2): through `atomic::write_atomic_json`, which flushes the
    /// temp file to the disk before the rename — a crash can't leave the
    /// project list at zero bytes, which reads as no projects.
    ///
    /// 1.175.0 (R3): a list that was refused at launch is never written.
    /// Every save answers the refusal instead ("…Update Plyloft to change
    /// it.", what a write to a newer board answers), and what the caller
    /// had put in memory for it is taken back: nothing was read, so the
    /// list stays empty rather than showing a project that isn't saved.
    fn save_atomic(&self) -> Result<(), String> {
        let _serial = self.save_lock.lock();
        if let Some(why) = self.refused() {
            *self.state.lock() = WorkspacesFile::default();
            return Err(why.to_string());
        }
        let mut file = self.state.lock().clone();
        file.version = WORKSPACES_VERSION;
        remember_review_slugs(&file);
        crate::atomic::write_atomic_json(&self.config_dir.join(WORKSPACES_FILE), &file)
    }

    pub fn snapshot(&self) -> WorkspacesFile {
        self.state.lock().clone()
    }

    pub fn create(&self, name: String, cwd: String) -> Result<Workspace, String> {
        // Owner, 2026-10-20: a name other than the folder's is one the
        // person chose; the folder's own is Open/Add's default (and so is an
        // empty one, which nobody typed).
        let chosen = !name.trim().is_empty() && folder_name(&cwd).as_deref() != Some(name.trim());
        self.create_marked(name, cwd, chosen)
    }

    /// [`Self::create`] under a name nobody on this Mac chose — the team
    /// manifest's display name for a workspace added from Settings › Team —
    /// which the shared definition's Name fills in like a folder's.
    pub fn create_named_by_team(&self, name: String, cwd: String) -> Result<Workspace, String> {
        self.create_marked(name, cwd, false)
    }

    fn create_marked(&self, name: String, cwd: String, name_chosen: bool) -> Result<Workspace, String> {
        let now = now_millis();
        // v1.113.0: a manually added folder honours the repo's committed
        // `.atelier/workspace_default.json` too. Before, only the
        // `onboard.sh` import path read it, so the owner's second Mac got a
        // LOCAL board on a repo that declares GitHub Issues backing. The
        // user's chosen name wins; only shared-safe fields are taken. A
        // malformed manifest is logged and ignored — it must not block
        // adding the project.
        // GH #79: `.atelier/workspace.json` first, the legacy file otherwise.
        let def = match crate::workspace_definition::read_checkout_identity(Path::new(&cwd)) {
            Ok(def) => def,
            Err(e) => {
                eprintln!("[workspace] ignoring the shared workspace definition: {e}");
                None
            }
        };
        let (accent_color, layout_preset, github_owner_repo, kanban_sync_mode) = match def {
            Some(def) => (
                def.accent_color,
                def.layout_preset,
                def.github_owner_repo,
                def.kanban_sync_mode,
            ),
            None => (None, None, None, KanbanSyncMode::Local),
        };
        // GitHub Issues backing without a repo is meaningless (see the
        // setter below) — degrade to Local rather than persist a half-unit.
        let (github_owner_repo, kanban_sync_mode) =
            if kanban_sync_mode == KanbanSyncMode::GitHubIssues && github_owner_repo.is_none() {
                (None, KanbanSyncMode::Local)
            } else {
                (github_owner_repo, kanban_sync_mode)
            };
        let name_chosen = Some(name_chosen);
        let ws = Workspace {
            id: Uuid::new_v4().to_string(),
            name,
            cwd,
            created_at: now,
            last_opened_at: now,
            open_files: Vec::new(),
            active_file: None,
            accent_color,
            layout_preset,
            verify_suite: None,
            pinned_right_tabs: None,
            icon: None,
            github_owner_repo,
            kanban_sync_mode,
            github_account: None,
            merge_when_checks_pass: false,
            ship_via: None,
            // G1 Challenger (2): a workspace made after the update
            // never had the old Ship it, so it has no notice to see.
            ship_notice_seen: true,
            fix_failing_checks: false,
            fix_failing_checks_since: None,
            fix_failing_checks_offered: false,
            models: None,
            list_grouping: None,
            keep_card_branches: false,
            dont_work_here: false,
            branch_backlog: None,
            name_chosen,
            merge_methods: Default::default(),
            default_area: None,
            area_notice_dismissed: false,
        };
        {
            let mut state = self.state.lock();
            state.workspaces.push(ws.clone());
            if state.active_workspace_id.is_none() {
                state.active_workspace_id = Some(ws.id.clone());
            }
        }
        self.save_atomic()?;
        Ok(ws)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        // v1.43.0: capture the icon path before mutating state so we can
        // best-effort clean up the icon file on disk after the store is
        // saved. Don't error the whole delete if the unlink fails — log.
        let icon_path_to_remove: Option<PathBuf> = {
            let state = self.state.lock();
            state
                .workspaces
                .iter()
                .find(|w| w.id == id)
                .and_then(|w| match &w.icon {
                    Some(WorkspaceIcon::Image { path, .. }) => Some(PathBuf::from(path)),
                    _ => None,
                })
        };
        {
            let mut state = self.state.lock();
            state.workspaces.retain(|w| w.id != id);
            if state.active_workspace_id.as_deref() == Some(id) {
                state.active_workspace_id = state.workspaces.first().map(|w| w.id.clone());
            }
        }
        self.save_atomic()?;
        if let Some(p) = icon_path_to_remove {
            if let Err(e) = fs::remove_file(&p) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("workspace::delete: failed to remove icon file {p:?}: {e}");
                }
            }
        }
        Ok(())
    }

    pub fn set_active(&self, id: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            if !state.workspaces.iter().any(|w| w.id == id) {
                return Err("workspace not found".into());
            }
            state.active_workspace_id = Some(id.to_string());
            if let Some(ws) = state.workspaces.iter_mut().find(|w| w.id == id) {
                ws.last_opened_at = now_millis();
            }
        }
        self.save_atomic()?;
        Ok(())
    }

    /// v1.4.0 (L1): CLI activation entry. Given an absolute path, either
    /// focus the existing workspace whose `cwd` matches, or create a new
    /// one named after the directory basename. Returns the resulting
    /// workspace (always also flips the active id to it).
    ///
    /// `cwd` must be a directory. Path normalization (canonicalization)
    /// is the caller's job — typically the CLI shim does `cd "$1" && pwd`
    /// before passing the result. Compares paths as strings; symlink
    /// pairs would resolve to different workspaces.
    pub fn open_or_create_at_path(&self, cwd: &str) -> Result<Workspace, String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("not a directory: {cwd}"));
        }
        // Try to match an existing workspace by cwd.
        let existing_id = {
            let state = self.state.lock();
            state
                .workspaces
                .iter()
                .find(|w| w.cwd == cwd)
                .map(|w| w.id.clone())
        };
        if let Some(id) = existing_id {
            self.set_active(&id)?;
            let state = self.state.lock();
            let ws = state
                .workspaces
                .iter()
                .find(|w| w.id == id)
                .cloned()
                .ok_or_else(|| "workspace vanished post-activate".to_string())?;
            return Ok(ws);
        }
        // Create a new one named after the basename.
        let name = folder_name(cwd).unwrap_or_else(|| cwd.to_string());
        let ws = self.create(name, cwd.to_string())?;
        self.set_active(&ws.id)?;
        Ok(ws)
    }

    /// v1.61.0 (Phase 5 — onboarding): pre-register a workspace for a cloned
    /// shared repo from its committed `.atelier/workspace.json` (GH #79), or
    /// the legacy `.atelier/workspace_default.json`.
    ///
    /// Idempotent by **canonical** cwd: if a workspace already points at this
    /// repo path, returns `Ok(None)` without touching the store. Returns
    /// `Ok(None)` too when the repo has no `workspace_default.json` (most
    /// repos won't). Only a malformed/unreadable file yields `Err` — the
    /// caller (`import_pending`) logs and skips it.
    ///
    /// The stored `cwd` is the canonical path (`fs::canonicalize`) so that the
    /// idempotency check survives symlinks / trailing slashes; the onboarding
    /// script writes canonical paths into the queue too (`cd … && pwd -P`).
    pub fn import_default(&self, repo_path: &Path) -> Result<Option<Workspace>, String> {
        // Canonicalize so the stored cwd and the idempotency check agree. The
        // repo was just cloned, so it exists; fall back to the raw path only
        // if canonicalization somehow fails.
        let cwd_path = crate::platform::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());
        // GH #79: `.atelier/workspace.json` wins over `workspace_default.json`.
        // Only identity and board are taken here; the project part arrives
        // with the first definition refresh, from the integration branch.
        let Some(def) = crate::workspace_definition::read_checkout_identity(&cwd_path)? else {
            return Ok(None);
        };
        let cwd = cwd_path.to_string_lossy().to_string();

        let now = now_millis();
        let ws = {
            let mut state = self.state.lock();
            if state.workspaces.iter().any(|w| w.cwd == cwd) {
                return Ok(None); // already registered — idempotent
            }
            let ws = Workspace {
                id: Uuid::new_v4().to_string(),
                name: def.name,
                cwd,
                created_at: now,
                last_opened_at: now,
                open_files: Vec::new(),
                active_file: None,
                accent_color: def.accent_color,
                layout_preset: def.layout_preset,
                verify_suite: None,
                pinned_right_tabs: None,
                icon: None,
                github_owner_repo: def.github_owner_repo,
                kanban_sync_mode: def.kanban_sync_mode,
                github_account: None,
                merge_when_checks_pass: false,
                ship_via: None,
                // G1 Challenger (2): a workspace made after the update
                // never had the old Ship it, so it has no notice to see.
                ship_notice_seen: true,
                fix_failing_checks: false,
                fix_failing_checks_since: None,
            fix_failing_checks_offered: false,
                models: None,
                list_grouping: None,
            keep_card_branches: false,
            dont_work_here: false,
            branch_backlog: None,
            // Named by the shared definition, so it follows it.
            name_chosen: Some(false),
            merge_methods: Default::default(),
            default_area: None,
            area_notice_dismissed: false,
            };
            state.workspaces.push(ws.clone());
            if state.active_workspace_id.is_none() {
                state.active_workspace_id = Some(ws.id.clone());
            }
            ws
        };
        // `save_atomic` writes the state as it is by then, so a concurrent
        // import can't race a stale snapshot back over disk.
        self.save_atomic()?;
        Ok(Some(ws))
    }

    /// v1.61.0 (Phase 5 — onboarding): drain a `pending_imports.json` queue
    /// (a JSON array of absolute repo paths written by `scripts/onboard.sh`).
    /// Imports each repo's `workspace_default.json`, **continuing past a bad
    /// entry** (logs and skips — one malformed repo must not strand the rest).
    /// Returns the count of workspaces actually created. Removes the queue
    /// file afterward (best-effort). Missing queue ⇒ `Ok(0)`.
    pub fn import_pending(&self, queue_path: &Path) -> Result<usize, String> {
        if !queue_path.is_file() {
            return Ok(0);
        }
        // R3: a refused list takes no project, so the queue waits for a
        // launch that can save one instead of being used up here.
        if self.refused().is_some() {
            return Ok(0);
        }
        let bytes = fs::read(queue_path).map_err(|e| format!("read queue: {e}"))?;
        let repos: Vec<String> =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse queue: {e}"))?;
        let mut created = 0usize;
        for repo in &repos {
            match self.import_default(Path::new(repo)) {
                Ok(Some(_)) => created += 1,
                Ok(None) => {}
                Err(e) => eprintln!("workspace::import_pending: skipping {repo}: {e}"),
            }
        }
        if let Err(e) = fs::remove_file(queue_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("workspace::import_pending: failed to remove queue {queue_path:?}: {e}");
            }
        }
        Ok(created)
    }

    pub fn rename(&self, id: &str, name: String) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.name = name;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// Owner, 2026-10-20: the person renames the workspace — the name is
    /// theirs from now on, so the shared definition never renames it again.
    /// (`rename` is also how the shared definition's Name is applied, and
    /// leaves the mark as it is.)
    pub fn rename_by_user(&self, id: &str, name: String) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.name = name;
            ws.name_chosen = Some(true);
        }
        self.save_atomic()?;
        Ok(())
    }

    /// Set the "person chose this name" mark: a fixture's, or the one a
    /// workspace from before the field is first read with
    /// (`workspace_definition::refresh_with`), so it no longer depends on
    /// which Name the cache holds next.
    pub(crate) fn set_name_chosen(&self, id: &str, chosen: Option<bool>) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let Some(ws) = state.workspaces.iter_mut().find(|w| w.id == id) else {
                return Err("workspace not found".to_string());
            };
            if ws.name_chosen == chosen {
                return Ok(());
            }
            ws.name_chosen = chosen;
        }
        self.save_atomic()
    }

    pub fn cwd_exists(&self, id: &str) -> Result<bool, String> {
        let state = self.state.lock();
        let ws = state
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .ok_or_else(|| "workspace not found".to_string())?;
        Ok(Path::new(&ws.cwd).is_dir())
    }

    pub fn set_accent_color(&self, id: &str, color: Option<String>) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.accent_color = color;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// Onboarding OB-11 (§8.4): the GitHub account Ply uses for this
    /// workspace, when several are signed in. `None` (or blank) = gh's active
    /// one. A login must be a GitHub login's shape.
    pub fn set_github_account(&self, id: &str, login: Option<String>) -> Result<(), String> {
        let login = login.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        if let Some(l) = &login {
            if !crate::team_admin::is_valid_login(l) {
                return Err("That isn't a GitHub account name.".into());
            }
        }
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.github_account = login;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// SL-3: remember the workspace's "Merge when checks pass" (atomic write).
    pub fn set_merge_when_checks_pass(&self, id: &str, on: bool) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.merge_when_checks_pass = on;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// G1: remember how the workspace's Ship it ships — `"github"`,
    /// `"local"`, or `None` for the default (atomic write).
    pub fn set_ship_via(&self, id: &str, via: Option<&str>) -> Result<(), String> {
        if let Some(v) = via {
            if !SHIP_VIA_VALUES.contains(&v) {
                return Err(format!("Ship it can't ship by “{v}”."));
            }
        }
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.ship_via = via.map(str::to_string);
        }
        self.save_atomic()?;
        Ok(())
    }

    /// G3: keep what GitHub said of a repository's merge methods, under that
    /// repository (atomic write). Nothing is written when it is what the file holds.
    pub fn set_merge_methods(
        &self,
        id: &str,
        methods: crate::merge_method::RepoMergeMethods,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if ws.merge_methods.get(&methods.repo) == Some(&methods) {
                return Ok(());
            }
            ws.merge_methods.insert(methods);
        }
        self.save_atomic()?;
        Ok(())
    }

    /// G1: the one-time Ship it notice was answered here (atomic write).
    pub fn mark_ship_notice_seen(&self, id: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if ws.ship_notice_seen {
                return Ok(());
            }
            ws.ship_notice_seen = true;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// G7: the workspace's default for "Fix failing checks by itself"
    /// (atomic write), and since when it is on (Minor 5: kept when it was on
    /// already, gone when off). Returns that time.
    pub fn set_fix_failing_checks(&self, id: &str, on: bool, now: i64) -> Result<Option<i64>, String> {
        let since = {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.fix_failing_checks_since = match (on, ws.fix_failing_checks) {
                (false, _) => None,
                (true, true) => ws.fix_failing_checks_since,
                (true, false) => Some(now),
            };
            ws.fix_failing_checks = on;
            ws.fix_failing_checks_since
        };
        self.save_atomic()?;
        Ok(since)
    }

    /// 1.175.0 (F7): the offer was answered (Turn on, or Not now) — it never
    /// comes back in this project. Atomic write.
    pub fn set_fix_failing_checks_offered(&self, id: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if ws.fix_failing_checks_offered {
                return Ok(());
            }
            ws.fix_failing_checks_offered = true;
        }
        self.save_atomic()
    }

    /// G7 fixes (Minor 5): the workspace's default as `pr_auto_fix::enabled`
    /// takes it — since when it is on, `None` while off. On in a file from
    /// before the time was kept: every failure counts.
    pub fn fix_failing_checks_since(&self, id: &str) -> Option<i64> {
        let state = self.state.lock();
        let ws = state.workspaces.iter().find(|w| w.id == id)?;
        ws.fix_failing_checks.then(|| ws.fix_failing_checks_since.unwrap_or(0))
    }

    /// N18: turn the workspace's card-branch cleanup off (`keep` true) or
    /// back on (atomic write).
    pub fn set_keep_card_branches(&self, id: &str, keep: bool) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.keep_card_branches = keep;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// F1 (1.172.1): *I don't work here* on (`on`) or off (atomic write).
    pub fn set_dont_work_here(&self, id: &str, on: bool) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.dont_work_here = on;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// 1.173.0 (B2): *Make <area> this Mac's default* (`Some(id)`), or back
    /// to *All areas* (`None`; atomic write). The id is not checked against
    /// the repository's areas: the list can change on another Mac, and an id
    /// it no longer has reads as *All areas* where the picker draws it.
    pub fn set_default_area(&self, id: &str, area: Option<String>) -> Result<(), String> {
        let area = area.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
        if let Some(a) = &area {
            if a.len() > crate::areas::ID_MAX || a.contains(['\0', '\n', '\r']) {
                return Err("That isn't an area's name.".to_string());
            }
        }
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.default_area = area;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// 1.173.0 (B2): *Not now* on the two-products notice (atomic write).
    pub fn dismiss_area_notice(&self, id: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.area_notice_dismissed = true;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// N18: remember the answer to the backlog proposal (atomic write).
    pub fn set_branch_backlog(
        &self,
        id: &str,
        answer: crate::branch_cleanup::BacklogAnswer,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.branch_backlog = Some(answer);
        }
        self.save_atomic()?;
        Ok(())
    }

    /// CL-9: remember how the List view groups (atomic write). `"stage"` is
    /// kept; `"attention"`, the default, takes the key out of the file.
    pub fn set_list_grouping(&self, id: &str, grouping: &str) -> Result<(), String> {
        let value = match grouping {
            "stage" => Some("stage".to_string()),
            "attention" => None,
            other => return Err(format!("unknown list grouping: {other}")),
        };
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.list_grouping = value;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// CL-4: this workspace's own model rows (atomic write). Blank fields
    /// are dropped; nothing left clears the override (`models` leaves the
    /// file and every row reads the app default again).
    pub fn set_models(
        &self,
        id: &str,
        models: Option<crate::settings::WorkspaceModels>,
    ) -> Result<(), String> {
        let models = models.and_then(|m| m.normalized());
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.models = models;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// CL-4: the workspace's own model rows, if it has any.
    pub fn models_for(&self, id: &str) -> Option<crate::settings::WorkspaceModels> {
        self.state
            .lock()
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .and_then(|w| w.models.clone())
    }

    /// v1.57.0 (Cycle 3 — increment 3c): set a workspace's kanban sync mode +
    /// backing repo together (they're a unit — `GitHubIssues` is meaningless
    /// without a repo). Atomic write, like every other workspace mutation.
    pub fn set_kanban_sync(
        &self,
        id: &str,
        mode: KanbanSyncMode,
        repo: Option<String>,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.kanban_sync_mode = mode;
            ws.github_owner_repo = repo;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// v1.4.0 (L2): set the per-workspace tile-grid layout preset.
    /// Accepts `None` / `Some("auto")` / `Some("single")` / `Some("split")`
    /// / `Some("quad")` / `Some("six")`. Unknown strings are accepted at
    /// the storage layer (frontend gates the dropdown options); the
    /// `gridLayoutForPreset` helper in TileGrid.tsx falls back to `auto`
    /// for any unrecognized value.
    pub fn set_layout_preset(
        &self,
        id: &str,
        preset: Option<String>,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.layout_preset = preset;
        }
        self.save_atomic()?;
        Ok(())
    }

    /// v1.43.0 (Sidebar identity): set a non-image icon for the workspace.
    /// `None` clears the icon (FE reverts to monogram derived from the
    /// name). `Some(Monogram)` is the explicit "back to default" sentinel
    /// after a Reset. `Some(Emoji {..})` is the user override. This path
    /// does NOT accept `Image {..}` — image uploads must go through
    /// `set_icon_image` which copies the file + validates magic bytes.
    pub fn set_icon(
        &self,
        id: &str,
        icon: Option<WorkspaceIcon>,
    ) -> Result<(), String> {
        if matches!(icon, Some(WorkspaceIcon::Image { .. })) {
            return Err("set_icon does not accept Image; use set_icon_image".into());
        }
        // Capture the prior image-icon path (if any) so we can remove the
        // file when the user replaces it with monogram/emoji. Mirror the
        // cleanup pattern in `delete`.
        let prior_image_path: Option<PathBuf> = {
            let state = self.state.lock();
            state
                .workspaces
                .iter()
                .find(|w| w.id == id)
                .and_then(|w| match &w.icon {
                    Some(WorkspaceIcon::Image { path, .. }) => Some(PathBuf::from(path)),
                    _ => None,
                })
        };
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.icon = icon;
        }
        self.save_atomic()?;
        if let Some(p) = prior_image_path {
            if let Err(e) = fs::remove_file(&p) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("workspace::set_icon: failed to remove prior icon file {p:?}: {e}");
                }
            }
        }
        Ok(())
    }

    /// v1.43.0 (Sidebar identity): copy an external image file into the
    /// app config dir's `icons/<workspaceId>.<ext>` slot, then set the
    /// workspace's icon to `Image { path, mtime }`. Validation:
    ///   * Magic-byte sniff — PNG, JPEG, WebP only. SVG explicitly
    ///     rejected (can carry inline scripts; loaded via `file://` in
    ///     WebView it's a real foot-gun). Anything else rejected.
    ///   * 2 MB size cap.
    /// Returns the canonical path of the copied file (suitable for the
    /// FE to use as a `file://` source). Atomic write per Hard Rule #3:
    /// bytes go to `<dest>.tmp` first, then renamed.
    pub fn set_icon_image(&self, id: &str, src_path: &Path) -> Result<String, String> {
        // Read + validate magic bytes.
        let bytes = fs::read(src_path).map_err(|e| format!("read icon source: {e}"))?;
        const MAX_BYTES: usize = 2 * 1024 * 1024;
        if bytes.len() > MAX_BYTES {
            return Err(format!(
                "icon image too large: {} bytes (max {})",
                bytes.len(),
                MAX_BYTES
            ));
        }
        let ext = detect_image_ext(&bytes)
            .ok_or_else(|| "icon image must be PNG, JPEG, or WebP".to_string())?;
        // Confirm workspace exists, then resolve prior-image cleanup path
        // and the new dest path.
        let prior_image_path: Option<PathBuf> = {
            let state = self.state.lock();
            let ws = state
                .workspaces
                .iter()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            match &ws.icon {
                Some(WorkspaceIcon::Image { path, .. }) => Some(PathBuf::from(path)),
                _ => None,
            }
        };
        let icons_dir = self.config_dir.join("icons");
        fs::create_dir_all(&icons_dir).map_err(|e| format!("create icons dir: {e}"))?;
        let dest = icons_dir.join(format!("{id}.{ext}"));
        let tmp = icons_dir.join(format!("{id}.tmp"));
        fs::write(&tmp, &bytes).map_err(|e| format!("write tmp icon: {e}"))?;
        crate::platform::rename(&tmp, &dest).map_err(|e| format!("rename icon: {e}"))?;
        let mtime_ms = fs::metadata(&dest)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(now_millis);
        let dest_str = dest.to_string_lossy().to_string();
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.icon = Some(WorkspaceIcon::Image {
                path: dest_str.clone(),
                mtime: mtime_ms,
            });
        }
        self.save_atomic()?;
        // If the prior icon was a DIFFERENT path (different ext), remove
        // the orphan file. Same-path case is fine — `rename` already
        // replaced the bytes in place.
        if let Some(p) = prior_image_path {
            if p != dest {
                if let Err(e) = fs::remove_file(&p) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "workspace::set_icon_image: failed to remove prior icon {p:?}: {e}"
                        );
                    }
                }
            }
        }
        Ok(dest_str)
    }

    pub fn set_files(
        &self,
        id: &str,
        open_files: Vec<String>,
        active_file: Option<String>,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let ws = state
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            ws.open_files = open_files;
            ws.active_file = active_file;
        }
        self.save_atomic()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broken_files(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("workspaces.json.broken-"))
            .collect()
    }

    /// OP-3: a `workspaces.json` that doesn't parse stopped the launch. The
    /// store now opens empty, the file is kept beside itself byte for byte,
    /// and the next save doesn't touch it.
    #[test]
    fn a_corrupt_workspaces_file_is_set_aside_and_the_store_opens_empty() {
        let project = tempfile::tempdir().unwrap();
        for corrupt in [&br#"{"workspaces":[{"id":"w1","na"#[..], &b"\x00\x00\x00"[..], &br#"{"workspaces":"none"}"#[..]] {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join(WORKSPACES_FILE), corrupt).unwrap();
            let store = WorkspaceStore::new(tmp.path().to_path_buf()).expect("the launch goes on");
            assert!(store.snapshot().workspaces.is_empty());
            assert!(!tmp.path().join(WORKSPACES_FILE).exists(), "moved, not left to be written over");
            let kept = broken_files(tmp.path());
            assert_eq!(kept.len(), 1, "{kept:?}");
            assert_eq!(store.set_aside(), Some(kept[0].as_path()), "the store says where it went");
            assert_eq!(fs::read(&kept[0]).unwrap(), corrupt, "the original bytes");
            // R3: said once this launch.
            assert_eq!(store.take_launch_notice(), Some(ListTrouble::SetAside(kept[0].clone())));
            assert_eq!(store.take_launch_notice(), None, "exactly once");

            store.create("again".into(), project.path().to_string_lossy().to_string()).unwrap();
            assert_eq!(fs::read(&kept[0]).unwrap(), corrupt, "a save never touches it");
            let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
            assert_eq!(again.snapshot().workspaces.len(), 1);
            assert_eq!(again.set_aside(), None, "only the launch that set it aside says so");
            assert_eq!(again.take_launch_notice(), None);
            assert_eq!(broken_files(tmp.path()).len(), 1, "nothing new set aside");
        }
    }

    /// R3: every save of a refused list answers `refusal`, writes nothing,
    /// and leaves no project in memory; the file stays byte for byte, with
    /// nothing beside it.
    fn assert_refused(config: &Path, store: &WorkspaceStore, bytes: &[u8], refusal: &str) {
        let path = config.join(WORKSPACES_FILE);
        assert_eq!(store.refused(), Some(refusal));
        assert_eq!(store.set_aside(), None, "refused, not set aside");
        assert!(store.snapshot().workspaces.is_empty(), "the app shows no projects");
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().to_string_lossy().to_string();
        assert_eq!(store.create("again".into(), cwd.clone()).expect_err("adding a project is refused"), refusal);
        assert_eq!(store.open_or_create_at_path(&cwd).err().as_deref(), Some(refusal));
        assert_eq!(store.save_atomic().expect_err("every save"), refusal);
        // The onboarding queue is not used up by a list that takes nothing.
        let queue = project.path().join("pending_imports.json");
        fs::write(&queue, serde_json::to_vec(&[&cwd]).unwrap()).unwrap();
        assert_eq!(store.import_pending(&queue), Ok(0));
        assert!(queue.exists(), "the queue waits");
        let snap = store.snapshot();
        assert!(snap.workspaces.is_empty() && snap.active_workspace_id.is_none(), "nothing unsaved is shown");
        assert_eq!(fs::read(&path).unwrap(), bytes, "byte-identical");
        assert_eq!(fs::read_dir(config).unwrap().count(), 1, "nothing beside it");
        // Said once this launch, with the file and the reason.
        let said = ListTrouble::Refused { path: path.clone(), why: refusal.to_string() };
        assert_eq!(store.trouble(), Some(&said));
        assert_eq!(store.take_launch_notice(), Some(said));
        assert_eq!(store.take_launch_notice(), None, "exactly once");
        // The next launch refuses again, and says so again.
        let again = WorkspaceStore::new(config.to_path_buf()).expect("the launch goes on");
        assert_eq!(again.refused(), Some(refusal));
        assert!(again.take_launch_notice().is_some());
    }

    /// R3 (owner, 2026-11-09): a file with the outline of a project list
    /// that this build can't read — a value from a later version, here —
    /// stopped the launch. Plyloft now starts with no projects: the file is
    /// neither thrown aside as broken nor written over, and every save says
    /// to update Plyloft.
    #[test]
    fn a_project_list_this_build_cannot_read_starts_empty_and_is_never_written() {
        let tmp = tempfile::tempdir().unwrap();
        let later = br#"{"workspaces":[{"id":"w1","name":"One","cwd":"/x","createdAt":1,"lastOpenedAt":2,"kanbanSyncMode":"future"}]}"#;
        fs::write(tmp.path().join(WORKSPACES_FILE), later).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).expect("the launch goes on");
        assert_refused(tmp.path(), &store, later, LIST_UNREADABLE_REFUSAL);
        assert!(broken_files(tmp.path()).is_empty(), "never set aside");
        assert!(LIST_UNREADABLE_REFUSAL.ends_with("so it was left as it is. Update Plyloft to change it."), "the board's words");
    }

    /// R3: a higher `version` is a newer Plyloft's file. Plyloft starts with
    /// no projects and refuses every save in the words a newer board is
    /// refused with — also when this build could parse the file.
    #[test]
    fn a_newer_plyloft_s_project_list_starts_empty_and_is_never_written() {
        let next = WORKSPACES_VERSION + 1;
        let refusal = crate::atomic::newer_refusal("The project list", next, WORKSPACES_VERSION);
        let parses = format!(r#"{{"version":{next},"workspaces":[{{"id":"w1","name":"One","cwd":"/x","createdAt":1,"lastOpenedAt":2}}],"later":true}}"#);
        let strict = format!(r#"{{"version":{next},"workspaces":[{{"id":"w1","shape":"changed"}}]}}"#);
        for newer in [parses, strict] {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join(WORKSPACES_FILE), &newer).unwrap();
            let store = WorkspaceStore::new(tmp.path().to_path_buf()).expect("the launch goes on");
            assert_refused(tmp.path(), &store, newer.as_bytes(), &refusal);
        }
    }

    /// R3: no file, `{}`, or zero bytes with no board on disk is a fresh
    /// profile: no projects, nothing said, nothing moved, and a save works.
    #[test]
    fn a_missing_or_empty_list_with_no_boards_is_a_fresh_profile() {
        for found in [None, Some(&b""[..]), Some(&b"{}"[..])] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join(WORKSPACES_FILE);
            if let Some(bytes) = found {
                fs::write(&path, bytes).unwrap();
            }
            // An empty boards folder is no board.
            fs::create_dir_all(tmp.path().join(crate::kanban::KANBAN_SUBDIR)).unwrap();
            let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
            assert!(store.snapshot().workspaces.is_empty(), "{found:?}");
            assert_eq!((store.trouble(), store.take_launch_notice()), (None, None), "{found:?}: nothing to say");
            assert_eq!(fs::read(&path).ok().as_deref(), found, "{found:?}: left as found");
            assert!(broken_files(tmp.path()).is_empty(), "{found:?}");
            let project = tempfile::tempdir().unwrap();
            store.create("one".into(), project.path().to_string_lossy().to_string()).expect("a save works");
        }
    }

    /// T6: the list is set aside; Plyloft quits before the toast is seen
    /// and before any save. The next launch finds no list file — which read
    /// as a fresh profile with nothing said, while the boards and the
    /// set-aside file sat there. It is said again, naming the newest such
    /// file, at every launch until a list is saved. Nothing is moved.
    #[test]
    fn a_list_set_aside_and_never_saved_since_is_said_at_every_launch() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(WORKSPACES_FILE);
        let boards = tmp.path().join(crate::kanban::KANBAN_SUBDIR);
        fs::create_dir_all(&boards).unwrap();
        fs::write(boards.join("w1.json"), br#"{"version":8,"cards":[]}"#).unwrap();
        fs::write(&path, b"{cut").unwrap();
        let first = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let aside = first.set_aside().unwrap().to_path_buf();
        drop(first); // The quit: the notice was never asked for, nothing was saved.

        // An older and an unreadable-time file beside it: the newest is named.
        fs::write(tmp.path().join("workspaces.json.broken-17"), b"older").unwrap();
        fs::write(tmp.path().join("workspaces.json.broken-old"), b"no time").unwrap();
        let before: Vec<(String, Vec<u8>)> = {
            let mut files: Vec<_> = fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .filter(|e| e.path().is_file())
                .map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read(e.path()).unwrap()))
                .collect();
            files.sort();
            files
        };
        for _launch in 0..2 {
            let store = WorkspaceStore::new(tmp.path().to_path_buf()).expect("the launch goes on");
            assert!(store.snapshot().workspaces.is_empty());
            assert_eq!(store.set_aside(), Some(aside.as_path()));
            assert_eq!(store.take_launch_notice(), Some(ListTrouble::SetAside(aside.clone())));
            assert_eq!(store.take_launch_notice(), None, "once per launch");
            assert!(!path.exists(), "nothing is written by saying it");
        }
        let after: Vec<String> = {
            let mut names: Vec<_> = fs::read_dir(tmp.path()).unwrap().flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        };
        assert_eq!(after, before.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(), "nothing moved");
        for (name, bytes) in &before {
            assert_eq!(&fs::read(tmp.path().join(name)).unwrap(), bytes, "{name}");
        }

        // Until a list is saved.
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let project = tempfile::tempdir().unwrap();
        store.create("again".into(), project.path().to_string_lossy().to_string()).unwrap();
        let saved = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!((saved.trouble(), saved.take_launch_notice()), (None, None));

        // With no board on disk, or no set-aside file, a missing list is a fresh profile.
        let no_boards = tempfile::tempdir().unwrap();
        fs::write(no_boards.path().join("workspaces.json.broken-17"), b"x").unwrap();
        assert_eq!(WorkspaceStore::new(no_boards.path().to_path_buf()).unwrap().trouble(), None);
        let no_aside = tempfile::tempdir().unwrap();
        let boards = no_aside.path().join(crate::kanban::KANBAN_SUBDIR);
        fs::create_dir_all(&boards).unwrap();
        fs::write(boards.join("w1.json"), br#"{"version":8,"cards":[]}"#).unwrap();
        assert_eq!(WorkspaceStore::new(no_aside.path().to_path_buf()).unwrap().trouble(), None);
    }

    /// R3: zero bytes where the list was, while board files exist, is not
    /// "no projects" — a save never reached the disk. It is set aside like a
    /// file that doesn't parse, and said once. A set-aside that fails still
    /// fails the load, so no save writes over the file.
    #[test]
    fn an_empty_list_beside_boards_is_set_aside_and_said() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(WORKSPACES_FILE);
        let boards = tmp.path().join(crate::kanban::KANBAN_SUBDIR);
        fs::create_dir_all(&boards).unwrap();
        fs::write(boards.join("w1.json"), br#"{"version":8,"cards":[]}"#).unwrap();
        fs::write(&path, b"").unwrap();

        let denied = |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"));
        let error = WorkspaceStore::load_with(&path, denied).expect_err("the load fails");
        assert!(error.contains("couldn't be set aside"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"", "left as it is");

        let store = WorkspaceStore::new(tmp.path().to_path_buf()).expect("the launch goes on");
        assert!(store.snapshot().workspaces.is_empty());
        let kept = broken_files(tmp.path());
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(fs::read(&kept[0]).unwrap(), b"", "as found");
        assert!(!path.exists());
        assert_eq!(store.set_aside(), Some(kept[0].as_path()));
        assert_eq!(store.refused(), None);
        assert_eq!(store.take_launch_notice(), Some(ListTrouble::SetAside(kept[0].clone())));
        assert_eq!(store.take_launch_notice(), None, "exactly once");
        assert_eq!(fs::read(boards.join("w1.json")).unwrap(), br#"{"version":8,"cards":[]}"#, "the boards are not touched");
    }

    /// PPVP Tier 2 (the v1.11.x template): a `workspaces.json` from before
    /// 1.175.0 has no `version`. It loads with every field it had, and the
    /// first save writes the version beside them.
    #[test]
    fn pre_v1175_workspaces_file_loads_without_version_and_saves_with_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(WORKSPACES_FILE);
        let legacy = r##"{
            "workspaces": [{
                "id": "w1", "name": "One", "cwd": "/x", "createdAt": 1, "lastOpenedAt": 2,
                "openFiles": ["a.rs"], "activeFile": "a.rs", "accentColor": "#7c3aed",
                "kanbanSyncMode": "githubIssues", "githubOwnerRepo": "owner/repo"
            }],
            "activeWorkspaceId": "w1"
        }"##;
        fs::write(&path, legacy).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.version, 0, "no version: from before 1.175.0");
        let ws = &snap.workspaces[0];
        assert_eq!((ws.id.as_str(), ws.name.as_str(), ws.cwd.as_str()), ("w1", "One", "/x"));
        assert_eq!(ws.open_files, ["a.rs"]);
        assert_eq!(ws.accent_color.as_deref(), Some("#7c3aed"));
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::GitHubIssues);
        assert_eq!(ws.github_owner_repo.as_deref(), Some("owner/repo"));
        assert_eq!(snap.active_workspace_id.as_deref(), Some("w1"));
        assert_eq!(store.set_aside(), None);

        store.save_atomic().unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], WORKSPACES_VERSION);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(again.version, WORKSPACES_VERSION);
        assert_eq!(again.workspaces[0].github_owner_repo.as_deref(), Some("owner/repo"));
        assert_eq!(again.workspaces[0].open_files, ["a.rs"]);
    }

    /// OP-3: a valid file is read as it is and never moved; an empty one is
    /// an empty list, as before.
    #[test]
    fn a_valid_or_an_empty_workspaces_file_is_never_set_aside() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(WORKSPACES_FILE);
        let valid = br#"{"workspaces":[{"id":"w1","name":"One","cwd":"/x","createdAt":1,"lastOpenedAt":2}],"activeWorkspaceId":"w1"}"#;
        fs::write(&path, valid).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        assert_eq!(snap.workspaces[0].name, "One");
        assert_eq!(snap.active_workspace_id.as_deref(), Some("w1"));
        assert_eq!(fs::read(&path).unwrap(), valid, "byte-identical");

        fs::write(&path, b"").unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store.snapshot().workspaces.is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"", "left where it is");
        assert!(broken_files(tmp.path()).is_empty());
    }

    /// OP-3: a corrupt file that can't be moved still fails the load, so no
    /// save writes an empty list over the only copy.
    #[test]
    fn a_corrupt_workspaces_file_that_cannot_be_set_aside_fails_the_load() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(WORKSPACES_FILE);
        fs::write(&path, b"{broken").unwrap();
        let denied = |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"));
        let error = WorkspaceStore::set_broken_aside(&path, "expected value", denied).expect_err("reported");
        assert!(error.contains("couldn't be set aside") && error.contains("denied"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"{broken", "left as it is");
    }

    /// OP-2: a save goes through the atomic writer and leaves no temp file.
    #[test]
    fn a_save_leaves_only_the_workspaces_file() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        store.create("one".into(), project.path().to_string_lossy().to_string()).unwrap();
        let names: Vec<String> =
            fs::read_dir(tmp.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec![WORKSPACES_FILE.to_string()]);
    }

    /// PPVP Tier 2: a v0.4.0 workspaces.json (no `accentColor` field) must
    /// load cleanly and default the new field to `None`. v1.4.0 (L2)
    /// extends the assertion to cover `layoutPreset`.
    #[test]
    fn loads_v0_4_0_workspace_json_without_accent_color() {
        let v0_4_0_json = br#"{
            "workspaces": [{
                "id": "ws-1",
                "name": "demo",
                "cwd": "/tmp/demo",
                "createdAt": 1700000000000,
                "lastOpenedAt": 1700000000000,
                "openFiles": [],
                "activeFile": null
            }],
            "activeWorkspaceId": "ws-1"
        }"#;
        let parsed: WorkspacesFile = serde_json::from_slice(v0_4_0_json).expect("parse");
        assert_eq!(parsed.workspaces.len(), 1);
        assert_eq!(parsed.workspaces[0].id, "ws-1");
        assert_eq!(parsed.workspaces[0].accent_color, None);
        // L2: legacy file with no layoutPreset defaults to None.
        assert_eq!(parsed.workspaces[0].layout_preset, None);
        // Owner, 2026-10-20: no `nameChosen` reads as unset (decided from
        // the name, `workspace_definition::keeps_own_name`).
        assert_eq!(parsed.workspaces[0].name_chosen, None);
    }

    #[test]
    fn a_workspace_added_with_its_folder_s_name_is_not_named_by_the_person() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().join("config")).unwrap();
        let cwd = dir.path().join("web");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.to_string_lossy().into_owned();
        assert_eq!(store.create("web".into(), cwd.clone()).unwrap().name_chosen, Some(false));
        let named = store.create("Acme web".into(), cwd.clone()).unwrap();
        assert_eq!(named.name_chosen, Some(true));
        store.rename(&named.id, "web".into()).unwrap();
        assert_eq!(store.snapshot().workspaces[1].name_chosen, Some(true), "rename keeps the mark");
        let other = dir.path().join("api");
        std::fs::create_dir_all(&other).unwrap();
        let opened = store.open_or_create_at_path(&other.to_string_lossy()).unwrap();
        assert_eq!(opened.name_chosen, Some(false));
        // An empty name was typed by nobody; the team's name isn't this person's.
        assert_eq!(store.create(String::new(), cwd.clone()).unwrap().name_chosen, Some(false));
        assert_eq!(store.create_named_by_team("Team web".into(), cwd.clone()).unwrap().name_chosen, Some(false));
        store.rename_by_user(&opened.id, "API".into()).unwrap();
        let reloaded = WorkspaceStore::new(dir.path().join("config")).unwrap();
        let ws = reloaded.snapshot().workspaces.into_iter().find(|w| w.id == opened.id).unwrap();
        assert_eq!((ws.name.as_str(), ws.name_chosen), ("API", Some(true)));
    }

    #[test]
    fn round_trips_accent_color() {
        let mut ws = Workspace {
            id: "ws-2".into(),
            name: "demo".into(),
            cwd: "/tmp/demo".into(),
            created_at: 0,
            last_opened_at: 0,
            open_files: vec![],
            active_file: None,
            accent_color: Some("#7c3aed".into()),
            layout_preset: None,
            verify_suite: None,
            pinned_right_tabs: None,
            icon: None,
            github_owner_repo: None,
            kanban_sync_mode: KanbanSyncMode::Local,
            github_account: None,
            merge_when_checks_pass: false,
            ship_via: None,
            ship_notice_seen: false,
            fix_failing_checks: false,
            fix_failing_checks_since: None,
            fix_failing_checks_offered: false,
            models: None,
            list_grouping: None,
            keep_card_branches: false,
            dont_work_here: false,
            branch_backlog: None,
            name_chosen: None,
            merge_methods: Default::default(),
            default_area: None,
            area_notice_dismissed: false,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains("\"accentColor\":\"#7c3aed\""));
        ws.accent_color = None;
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains("\"accentColor\":null"));
    }

    #[test]
    fn legacy_workspace_loads_with_sync_mode_defaults() {
        // Tier 2 schema-migration (v1.57.0, Cycle 3): a workspace JSON
        // without githubOwnerRepo / kanbanSyncMode loads with both defaulted
        // (None / Local), not an error.
        let json = r#"{
            "id": "w1",
            "name": "legacy",
            "cwd": "/tmp/legacy",
            "createdAt": 1,
            "lastOpenedAt": 1
        }"#;
        let ws: Workspace = serde_json::from_str(json).unwrap();
        assert_eq!(ws.github_owner_repo, None);
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::Local);
    }

    #[test]
    fn round_trips_kanban_sync_mode() {
        let json = r#"{
            "id": "w1",
            "name": "gh",
            "cwd": "/tmp/gh",
            "createdAt": 1,
            "lastOpenedAt": 1,
            "githubOwnerRepo": "MatteoB-adv/atelier",
            "kanbanSyncMode": "githubIssues"
        }"#;
        let ws: Workspace = serde_json::from_str(json).unwrap();
        assert_eq!(ws.github_owner_repo.as_deref(), Some("MatteoB-adv/atelier"));
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::GitHubIssues);
        let out = serde_json::to_string(&ws).unwrap();
        assert!(out.contains("\"kanbanSyncMode\":\"githubIssues\""));
        assert!(out.contains("\"githubOwnerRepo\":\"MatteoB-adv/atelier\""));
    }

    // ── L1 (v1.4.0): CLI activation ────────────────────

    #[test]
    fn create_applies_the_committed_workspace_default_shared_fields() {
        // 2026-09-10: `+` on a freshly cloned repo that commits
        // `.atelier/workspace_default.json` (githubIssues + owner/repo)
        // produced a LOCAL, empty board. Manual add must honour the manifest
        // exactly like the onboarding import — name excepted.
        let tmp = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join(".atelier")).unwrap();
        std::fs::write(
            project.path().join(".atelier/workspace_default.json"),
            r##"{"name":"Ply","accentColor":"#7c3aed","kanbanSyncMode":"githubIssues","githubOwnerRepo":"owner/repo"}"##,
        )
        .unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store
            .create("atelier".into(), project.path().to_string_lossy().to_string())
            .unwrap();
        assert_eq!(ws.name, "atelier", "the user's name wins over the manifest's");
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::GitHubIssues);
        assert_eq!(ws.github_owner_repo.as_deref(), Some("owner/repo"));
        assert_eq!(ws.accent_color.as_deref(), Some("#7c3aed"));
        // Persisted, not just returned.
        let reloaded = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = reloaded.snapshot();
        assert_eq!(snap.workspaces[0].kanban_sync_mode, KanbanSyncMode::GitHubIssues);
    }

    #[test]
    fn create_without_a_manifest_or_with_a_broken_one_stays_local() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store
            .create("plain".into(), plain.path().to_string_lossy().to_string())
            .unwrap();
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::Local);
        assert!(ws.github_owner_repo.is_none());

        // Malformed manifest: logged and ignored, never a failed add.
        let broken = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(broken.path().join(".atelier")).unwrap();
        std::fs::write(broken.path().join(".atelier/workspace_default.json"), "{ not json").unwrap();
        let ws = store
            .create("broken".into(), broken.path().to_string_lossy().to_string())
            .unwrap();
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::Local);

        // githubIssues declared without a repo degrades to Local.
        let half = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(half.path().join(".atelier")).unwrap();
        std::fs::write(
            half.path().join(".atelier/workspace_default.json"),
            r#"{"name":"X","kanbanSyncMode":"githubIssues"}"#,
        )
        .unwrap();
        let ws = store
            .create("half".into(), half.path().to_string_lossy().to_string())
            .unwrap();
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::Local);
    }

    #[test]
    fn l1_open_or_create_focuses_existing_workspace_when_cwd_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let work_dir = tempfile::tempdir().unwrap();
        let cwd = work_dir.path().to_string_lossy().to_string();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws_first = store.create("demo".into(), cwd.clone()).unwrap();

        // Re-invoke with the same cwd → focus the existing workspace.
        let ws_focused = store.open_or_create_at_path(&cwd).unwrap();
        assert_eq!(ws_focused.id, ws_first.id);
        let snap = store.snapshot();
        // No new workspace was created.
        assert_eq!(snap.workspaces.len(), 1);
        // Active id flipped to the focused workspace.
        assert_eq!(snap.active_workspace_id.as_deref(), Some(ws_first.id.as_str()));
    }

    #[test]
    fn l1_open_or_create_creates_new_workspace_named_after_basename() {
        let tmp = tempfile::tempdir().unwrap();
        let work_root = tempfile::tempdir().unwrap();
        let project = work_root.path().join("my-project");
        std::fs::create_dir_all(&project).unwrap();
        let cwd = project.to_string_lossy().to_string();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();

        let ws = store.open_or_create_at_path(&cwd).unwrap();
        assert_eq!(ws.name, "my-project");
        assert_eq!(ws.cwd, cwd);
        let snap = store.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        assert_eq!(snap.active_workspace_id.as_deref(), Some(ws.id.as_str()));
    }

    #[test]
    fn l1_open_or_create_rejects_non_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let err = store
            .open_or_create_at_path("/path/that/definitely/does/not/exist/9zx")
            .unwrap_err();
        assert!(err.contains("not a directory"), "got: {err}");
    }

    // ── L2 (v1.4.0): tile-grid layout presets ──────────

    #[test]
    fn l2_set_layout_preset_persists_per_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store
            .create("demo".into(), work.path().to_string_lossy().into())
            .unwrap();
        // Default is None.
        assert_eq!(ws.layout_preset, None);
        store
            .set_layout_preset(&ws.id, Some("quad".into()))
            .unwrap();
        // Round-trip via fresh store on the same dir.
        let s2 = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let reloaded = s2
            .snapshot()
            .workspaces
            .into_iter()
            .find(|w| w.id == ws.id)
            .unwrap();
        assert_eq!(reloaded.layout_preset.as_deref(), Some("quad"));
        // Clearing back to None works.
        s2.set_layout_preset(&ws.id, None).unwrap();
        let s3 = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let reloaded = s3
            .snapshot()
            .workspaces
            .into_iter()
            .find(|w| w.id == ws.id)
            .unwrap();
        assert_eq!(reloaded.layout_preset, None);
    }

    /// Tier 2 schema-migration test for v1.11.x (Phase C): a workspaces.json
    /// written before `verifySuite` was introduced must round-trip cleanly
    /// with the field defaulting to None.
    #[test]
    fn pre_v11_workspace_loads_without_verify_suite() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br#"{
            "workspaces": [{
                "id": "ws-pre",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 1,
                "accentColor": null
            }],
            "activeWorkspaceId": "ws-pre"
        }"#;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        assert!(snap.workspaces[0].verify_suite.is_none());
    }

    /// v1.14.0 (Chrome restructure) Tier 2 schema-migration test: a
    /// workspaces.json written before `pinnedRightTabs` was introduced
    /// must round-trip cleanly with the new field defaulting to None.
    /// Important: this fixture intentionally INCLUDES `verifySuite`
    /// (the v1.11.x field) so we cover the realistic mid-history case
    /// — only the v1.14.0 field is missing.
    #[test]
    fn pre_v14_workspace_loads_without_pinned_right_tabs() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br#"{
            "workspaces": [{
                "id": "ws-pre14",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 1,
                "openFiles": [],
                "activeFile": null,
                "accentColor": null,
                "layoutPreset": "quad",
                "verifySuite": {"steps":[{"kind":"cargo_test"}]}
            }],
            "activeWorkspaceId": "ws-pre14"
        }"#;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        // The new field defaults to None.
        assert!(snap.workspaces[0].pinned_right_tabs.is_none());
        // Pre-existing fields still survive the migration.
        assert_eq!(snap.workspaces[0].layout_preset.as_deref(), Some("quad"));
        assert!(snap.workspaces[0].verify_suite.is_some());
    }

    /// Onboarding §8.4 Tier 2: a v1.152.1 workspaces.json (no
    /// `githubAccount`) loads with `None` — gh's active account, as before —
    /// and every existing field survives. The key stays out of the file while
    /// unset, so an untouched workspace writes exactly the keys it had; a set
    /// account round-trips through the store.
    #[test]
    fn pre_v153_workspace_loads_without_github_account() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre153",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": ["README.md"],
                "activeFile": "README.md",
                "accentColor": "#7c3aed",
                "layoutPreset": "quad",
                "pinnedRightTabs": ["kanban"],
                "githubOwnerRepo": "owner/repo",
                "kanbanSyncMode": "githubIssues"
            }],
            "activeWorkspaceId": "ws-pre153"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert_eq!(ws.github_account, None);
        assert_eq!(ws.github_owner_repo.as_deref(), Some("owner/repo"));
        assert_eq!(ws.kanban_sync_mode, KanbanSyncMode::GitHubIssues);
        assert_eq!(ws.layout_preset.as_deref(), Some("quad"));
        assert_eq!(ws.active_file.as_deref(), Some("README.md"));

        // Untouched: the key is not written.
        let encoded = serde_json::to_value(&ws).unwrap();
        assert!(encoded.get("githubAccount").is_none(), "{encoded}");

        // Set: it round-trips under its camelCase name.
        let mut set = ws.clone();
        set.github_account = Some("octocat-work".into());
        let encoded = serde_json::to_value(&set).unwrap();
        assert_eq!(encoded["githubAccount"], "octocat-work");
        let decoded: Workspace = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.github_account.as_deref(), Some("octocat-work"));
    }

    /// SL-3 Tier 2: a workspaces.json from before "Merge when checks pass"
    /// loads with it off and writes no key for it; turned on, it is saved
    /// atomically and remembered by a fresh store; off again, the key goes.
    #[test]
    fn merge_when_checks_pass_is_off_for_an_old_file_and_remembered() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-sl3",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": [],
                "activeFile": null,
                "githubAccount": "octocat-work"
            }],
            "activeWorkspaceId": "ws-pre-sl3"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert!(!ws.merge_when_checks_pass);
        assert_eq!(ws.github_account.as_deref(), Some("octocat-work"));
        assert!(serde_json::to_value(&ws).unwrap().get("mergeWhenChecksPass").is_none());

        store.set_merge_when_checks_pass("ws-pre-sl3", true).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["mergeWhenChecksPass"], true);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = again.snapshot().workspaces[0].clone();
        assert!(ws.merge_when_checks_pass);
        assert_eq!(ws.github_account.as_deref(), Some("octocat-work"));

        again.set_merge_when_checks_pass("ws-pre-sl3", false).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("mergeWhenChecksPass").is_none());
        assert!(again.set_merge_when_checks_pass("nope", true).is_err());
    }

    /// G1 Tier 2: a workspaces.json from before "How Ship it ships" and its
    /// one-time notice loads with the default (`None`: GitHub where a pull
    /// request can be opened) and the notice not seen, keeps every other
    /// field, and writes neither key. Set, both are saved atomically and
    /// remembered by a fresh store; back to the default, the key goes. An
    /// unknown value a later build wrote reads as written (the default).
    #[test]
    fn ship_via_and_its_notice_are_unset_for_an_old_file_and_remembered() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-g1",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": [],
                "activeFile": null,
                "githubAccount": "octocat-work",
                "mergeWhenChecksPass": true,
                "keepCardBranches": true
            }],
            "activeWorkspaceId": "ws-pre-g1"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert_eq!(ws.ship_via, None);
        assert!(!ws.ship_notice_seen);
        assert!(ws.merge_when_checks_pass);
        assert!(ws.keep_card_branches);
        assert_eq!(ws.github_account.as_deref(), Some("octocat-work"));
        let value = serde_json::to_value(&ws).unwrap();
        assert!(value.get("shipVia").is_none());
        assert!(value.get("shipNoticeSeen").is_none());

        store.set_ship_via("ws-pre-g1", Some("local")).unwrap();
        store.mark_ship_notice_seen("ws-pre-g1").unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["shipVia"], "local");
        assert_eq!(on_disk["workspaces"][0]["shipNoticeSeen"], true);
        assert_eq!(on_disk["workspaces"][0]["mergeWhenChecksPass"], true);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = again.snapshot().workspaces[0].clone();
        assert_eq!(ws.ship_via.as_deref(), Some("local"));
        assert!(ws.ship_notice_seen);
        assert_eq!(ws.github_account.as_deref(), Some("octocat-work"));

        again.set_ship_via("ws-pre-g1", None).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("shipVia").is_none());
        assert!(again.set_ship_via("ws-pre-g1", Some("ftp")).is_err());
        assert!(again.set_ship_via("nope", Some("github")).is_err());
        assert!(again.mark_ship_notice_seen("nope").is_err());

        // A later build's value is read, not refused.
        let later = br##"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1,"shipVia":"somewhere-new"}]}"##;
        let tmp2 = tempfile::tempdir().unwrap();
        fs::write(tmp2.path().join("workspaces.json"), later).unwrap();
        let store = WorkspaceStore::new(tmp2.path().to_path_buf()).unwrap();
        assert_eq!(store.snapshot().workspaces[0].ship_via.as_deref(), Some("somewhere-new"));
    }

    /// G1 Challenger (2): a workspace added after the update (Open/Add, or
    /// a shared repository's definition) never shows the one-time Ship it
    /// notice — it never had the old Ship it — and that is saved.
    #[test]
    fn a_workspace_made_after_the_update_has_no_ship_notice_to_see() {
        let cfg = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(cfg.path().to_path_buf()).unwrap();
        let folder = tempfile::tempdir().unwrap();
        let added = store.create("new".into(), folder.path().to_string_lossy().into_owned()).unwrap();
        assert!(added.ship_notice_seen);
        let shared = tempfile::tempdir().unwrap();
        fs::create_dir_all(shared.path().join(".atelier")).unwrap();
        fs::write(shared.path().join(".atelier/workspace_default.json"), br#"{"name":"Shared"}"#).unwrap();
        let imported = store.import_default(shared.path()).unwrap().unwrap();
        assert!(imported.ship_notice_seen);
        let again = WorkspaceStore::new(cfg.path().to_path_buf()).unwrap();
        assert!(again.snapshot().workspaces.iter().all(|w| w.ship_notice_seen));
    }

    /// G7 Tier 2: a workspaces.json from before "Fix failing checks by
    /// itself" loads with it off and writes no key for it; turned on, it is
    /// saved atomically and remembered by a fresh store; off again, the key
    /// goes. Every other field is kept.
    #[test]
    fn fix_failing_checks_is_off_for_an_old_file_and_remembered() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-g7",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": [],
                "activeFile": null,
                "mergeWhenChecksPass": true
            }],
            "activeWorkspaceId": "ws-pre-g7"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert!(!ws.fix_failing_checks);
        assert!(ws.merge_when_checks_pass);
        assert!(serde_json::to_value(&ws).unwrap().get("fixFailingChecks").is_none());

        store.set_fix_failing_checks("ws-pre-g7", true, 7).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["fixFailingChecks"], true);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = again.snapshot().workspaces[0].clone();
        assert!(ws.fix_failing_checks && ws.merge_when_checks_pass);

        again.set_fix_failing_checks("ws-pre-g7", false, 8).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("fixFailingChecks").is_none());
        assert!(again.set_fix_failing_checks("nope", true, 9).is_err());
    }

    /// 1.175.0 F7, Tier 2 schema migration: a workspaces.json from 1.174.5 has
    /// no `fixFailingChecksOffered`; it loads not offered yet, keeps the
    /// rest, is written back without the key; once answered it is kept.
    #[test]
    fn the_turn_on_offer_is_not_answered_in_an_old_file_and_remembered() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-1745",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": [],
                "activeFile": null,
                "fixFailingChecks": true,
                "fixFailingChecksSince": 5
            }],
            "activeWorkspaceId": "ws-1745"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert!(!ws.fix_failing_checks_offered);
        assert_eq!((ws.fix_failing_checks, ws.fix_failing_checks_since), (true, Some(5)));
        assert!(serde_json::to_value(&ws).unwrap().get("fixFailingChecksOffered").is_none());
        store.set_fix_failing_checks_offered("ws-1745").unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["fixFailingChecksOffered"], true);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(again.snapshot().workspaces[0].fix_failing_checks_offered);
        assert!(again.set_fix_failing_checks_offered("nope").is_err());
    }

    /// G7 fixes (Minor 5) Tier 2: since when the default is on. A file
    /// from before it (on, no time) loads unchanged and counts every
    /// failure (since 0); writing it back adds no key. Turned on, the time is
    /// saved atomically and survives a fresh store; turned on again it keeps
    /// the first time; off, both keys go.
    #[test]
    fn fix_failing_checks_since_is_kept_and_old_files_load() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [
              { "id": "on-before", "name": "a", "cwd": "/tmp/a", "createdAt": 1, "lastOpenedAt": 2,
                "openFiles": [], "activeFile": null, "fixFailingChecks": true },
              { "id": "off", "name": "b", "cwd": "/tmp/b", "createdAt": 1, "lastOpenedAt": 2,
                "openFiles": [], "activeFile": null }
            ],
            "activeWorkspaceId": "off"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.workspaces[0].fix_failing_checks_since, None);
        assert!(serde_json::to_value(&snap.workspaces[0]).unwrap().get("fixFailingChecksSince").is_none());
        assert_eq!(store.fix_failing_checks_since("on-before"), Some(0), "on before the time was kept");
        assert_eq!(store.fix_failing_checks_since("off"), None);
        assert_eq!(store.fix_failing_checks_since("nope"), None);

        assert_eq!(store.set_fix_failing_checks("off", true, 500).unwrap(), Some(500));
        assert_eq!(store.set_fix_failing_checks("off", true, 900).unwrap(), Some(500), "on again keeps the first time");
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][1]["fixFailingChecksSince"], 500);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(again.fix_failing_checks_since("off"), Some(500));

        assert_eq!(again.set_fix_failing_checks("off", false, 950).unwrap(), None);
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][1].get("fixFailingChecks").is_none());
        assert!(on_disk["workspaces"][1].get("fixFailingChecksSince").is_none());
    }

    /// CL-4 Tier 2: a workspaces.json from before per-workspace models
    /// loads with `models: None` (the app rows) and keeps every other field;
    /// saving it writes no `models` key. Set, the rows are saved atomically
    /// under camelCase names and remembered by a fresh store; cleared (or
    /// all blank), the key leaves the file again.
    #[test]
    fn pre_cl4_workspace_loads_without_models_and_remembers_them() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-cl4",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": [],
                "activeFile": null,
                "githubAccount": "octocat-work",
                "mergeWhenChecksPass": true
            }],
            "activeWorkspaceId": "ws-pre-cl4"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert_eq!(ws.models, None);
        assert_eq!(store.models_for("ws-pre-cl4"), None);
        assert!(ws.merge_when_checks_pass);
        assert_eq!(ws.github_account.as_deref(), Some("octocat-work"));

        // A save for another reason does not add the key.
        store.set_merge_when_checks_pass("ws-pre-cl4", true).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("models").is_none(), "{on_disk}");

        // Set: trimmed, blanks dropped, camelCase on disk, remembered.
        let mut rows = crate::settings::WorkspaceModels::default();
        rows.rows.claude.builder = Some(" opus ".into());
        rows.rows.claude.challenger = Some("  ".into());
        rows.rows.codex.challenger_reasoning = Some("low".into());
        // Round 2: Codex Builder forced to the CLI default, though a value
        // was typed too — forced wins, and the value is dropped.
        rows.rows.codex.builder = Some("gpt-7".into());
        rows.cli_default = vec!["codex.builder".into(), "codex.builder".into()];
        store.set_models("ws-pre-cl4", Some(rows)).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let models = &on_disk["workspaces"][0]["models"];
        assert_eq!(models["claude"]["builder"], "opus");
        assert!(models["claude"]["challenger"].is_null());
        assert_eq!(models["codex"]["challengerReasoning"], "low");
        assert!(models["codex"]["builder"].is_null());
        assert_eq!(models["cliDefault"], serde_json::json!(["codex.builder"]));
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let kept = again.models_for("ws-pre-cl4").unwrap();
        assert_eq!(kept.rows.claude.builder.as_deref(), Some("opus"));
        assert_eq!(kept.rows.claude.challenger, None);
        assert_eq!(kept.rows.codex.challenger_reasoning.as_deref(), Some("low"));
        assert!(kept.forces_cli_default("codex.builder"));
        assert!(!kept.forces_cli_default("claude.builder"));
        assert_eq!(again.snapshot().workspaces[0].github_account.as_deref(), Some("octocat-work"));

        // All blank clears it; None clears it; an unknown id is refused.
        let mut blank = crate::settings::WorkspaceModels::default();
        blank.rows.codex.builder = Some(" ".into());
        again.set_models("ws-pre-cl4", Some(blank)).unwrap();
        assert_eq!(again.models_for("ws-pre-cl4"), None);
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("models").is_none());
        again.set_models("ws-pre-cl4", None).unwrap();
        assert!(again.set_models("nope", None).is_err());
    }

    /// CL-9 Tier 2: a workspaces.json from before the List's grouping loads
    /// with none (by attention) and keeps every other field; a save for
    /// another reason writes no key. "By stage" is saved atomically and
    /// remembered by a fresh store, per workspace; back to attention, the
    /// key leaves the file. A value from a newer build loads (read as the
    /// default by the app) instead of failing the file; an unknown value or
    /// workspace is refused.
    #[test]
    fn pre_cl9_workspace_loads_without_list_grouping_and_remembers_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-cl9",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": [],
                "activeFile": null,
                "githubAccount": "octocat-work",
                "mergeWhenChecksPass": true,
                "models": { "claude": { "builder": "opus" } }
            }, {
                "id": "ws-other",
                "name": "other",
                "cwd": "/tmp/other",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "listGrouping": "byPhaseFromLater"
            }],
            "activeWorkspaceId": "ws-pre-cl9"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        let ws = snap.workspaces[0].clone();
        assert_eq!(ws.list_grouping, None);
        assert!(ws.merge_when_checks_pass);
        assert_eq!(ws.github_account.as_deref(), Some("octocat-work"));
        assert!(ws.models.is_some());
        assert_eq!(snap.workspaces[1].list_grouping.as_deref(), Some("byPhaseFromLater"));

        // A save for another reason does not add the key.
        store.set_merge_when_checks_pass("ws-pre-cl9", true).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("listGrouping").is_none(), "{on_disk}");

        // By stage: on disk under its camelCase name, for this workspace only.
        store.set_list_grouping("ws-pre-cl9", "stage").unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["listGrouping"], "stage");
        assert_eq!(on_disk["workspaces"][1]["listGrouping"], "byPhaseFromLater");
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = again.snapshot().workspaces[0].clone();
        assert_eq!(ws.list_grouping.as_deref(), Some("stage"));
        assert!(ws.merge_when_checks_pass);
        assert!(ws.models.is_some());

        // Back to attention: the key goes. Unknown values and ids are refused.
        again.set_list_grouping("ws-pre-cl9", "attention").unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("listGrouping").is_none());
        assert!(again.set_list_grouping("ws-pre-cl9", "phase").is_err());
        assert!(again.set_list_grouping("nope", "stage").is_err());
    }

    /// F1 (1.172.1): a workspace file from before *I don't work here* loads
    /// with it off; the key is written only while on, round-trips, and leaves
    /// the file when turned off again. Other fields are kept.
    #[test]
    fn pre_f1_workspace_loads_with_dont_work_here_off_and_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-f1",
                "name": "lyra",
                "cwd": "/tmp/lyra",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "githubOwnerRepo": "o/lyra",
                "kanbanSyncMode": "githubIssues",
                "keepCardBranches": true
            }],
            "activeWorkspaceId": "ws-pre-f1"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert!(!ws.dont_work_here, "an old workspace hears about its folder");
        assert!(ws.keep_card_branches);
        assert_eq!(ws.github_owner_repo.as_deref(), Some("o/lyra"));

        // A save for another reason doesn't add the key.
        store.set_keep_card_branches("ws-pre-f1", false).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("dontWorkHere").is_none(), "{on_disk}");

        store.set_dont_work_here("ws-pre-f1", true).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["dontWorkHere"], true);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(again.snapshot().workspaces[0].dont_work_here);

        again.set_dont_work_here("ws-pre-f1", false).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("dontWorkHere").is_none());
        assert!(again.set_dont_work_here("nope", true).is_err());
    }

    /// 1.173.0 (B2): a workspace file from before areas loads with no
    /// default area and the two-products notice not answered; neither key is
    /// written until set, both round-trip, and the default leaves the file
    /// when it goes back to *All areas*. Other fields are kept.
    #[test]
    fn pre_b2_workspace_loads_without_default_area_and_remembers_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-b2",
                "name": "lyra",
                "cwd": "/tmp/lyra",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "githubOwnerRepo": "o/lyra",
                "kanbanSyncMode": "githubIssues",
                "dontWorkHere": true
            }],
            "activeWorkspaceId": "ws-pre-b2"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces[0].clone();
        assert_eq!(ws.default_area, None, "an old workspace starts at All areas");
        assert!(!ws.area_notice_dismissed);
        assert!(ws.dont_work_here);
        assert_eq!(ws.github_owner_repo.as_deref(), Some("o/lyra"));

        // A save for another reason adds neither key.
        store.set_keep_card_branches("ws-pre-b2", true).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("defaultArea").is_none(), "{on_disk}");
        assert!(on_disk["workspaces"][0].get("areaNoticeDismissed").is_none(), "{on_disk}");

        store.set_default_area("ws-pre-b2", Some(" site ".into())).unwrap();
        store.dismiss_area_notice("ws-pre-b2").unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["defaultArea"], "site");
        assert_eq!(on_disk["workspaces"][0]["areaNoticeDismissed"], true);
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = again.snapshot().workspaces[0].clone();
        assert_eq!(ws.default_area.as_deref(), Some("site"));
        assert!(ws.area_notice_dismissed && ws.dont_work_here && ws.keep_card_branches);

        // Back to All areas: the key leaves the file (an empty id is none).
        again.set_default_area("ws-pre-b2", Some("  ".into())).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("defaultArea").is_none(), "{on_disk}");
        assert_eq!(on_disk["workspaces"][0]["areaNoticeDismissed"], true);
        assert!(again.set_default_area("nope", Some("site".into())).is_err());
        assert!(again.set_default_area("ws-pre-b2", Some("x".repeat(crate::areas::ID_MAX + 1))).is_err());
        assert!(again.dismiss_area_notice("nope").is_err());
    }

    /// N18: a workspace file from before the branch cleanup loads with the
    /// cleanup on and no backlog answer; neither key is written until set,
    /// both round-trip, and an answer a later build writes still reads.
    #[test]
    fn pre_n18_workspace_loads_with_branch_cleanup_on_and_remembers_its_answers() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre-n18",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "mergeWhenChecksPass": true,
                "listGrouping": "stage"
            }, {
                "id": "ws-later",
                "name": "later",
                "cwd": "/tmp/later",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "branchBacklog": { "answer": "somethingNewer", "at": 5 }
            }],
            "activeWorkspaceId": "ws-pre-n18"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        let ws = snap.workspaces[0].clone();
        assert!(!ws.keep_card_branches, "the cleanup is on for an old workspace");
        assert_eq!(ws.branch_backlog, None);
        assert!(ws.merge_when_checks_pass);
        assert_eq!(ws.list_grouping.as_deref(), Some("stage"));
        let later = snap.workspaces[1].branch_backlog.clone().unwrap();
        assert_eq!(later.answer, "somethingNewer");
        assert!(!crate::branch_cleanup::backlog_open(Some(&later), i64::MAX));

        // A save for another reason adds neither key.
        store.set_merge_when_checks_pass("ws-pre-n18", true).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("keepCardBranches").is_none(), "{on_disk}");
        assert!(on_disk["workspaces"][0].get("branchBacklog").is_none(), "{on_disk}");

        store.set_keep_card_branches("ws-pre-n18", true).unwrap();
        store
            .set_branch_backlog(
                "ws-pre-n18",
                crate::branch_cleanup::BacklogAnswer { answer: "never".into(), at: 7 },
            )
            .unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["workspaces"][0]["keepCardBranches"], true);
        assert_eq!(on_disk["workspaces"][0]["branchBacklog"]["answer"], "never");
        let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = again.snapshot().workspaces[0].clone();
        assert!(ws.keep_card_branches);
        assert_eq!(ws.branch_backlog.as_ref().map(|a| a.answer.as_str()), Some("never"));

        // On again: the key leaves the file.
        again.set_keep_card_branches("ws-pre-n18", false).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk["workspaces"][0].get("keepCardBranches").is_none());
        assert!(again.set_keep_card_branches("nope", true).is_err());
    }

    /// CL-4 round 2: `cliDefault` alone is a whole override (no rows), an
    /// unknown name from a newer build is kept and ignored, and a `models`
    /// block written before round 2 (rows only) reads with nothing forced.
    #[test]
    fn workspace_models_cli_default_round_trips_and_old_blocks_read_unforced() {
        let only: crate::settings::WorkspaceModels =
            serde_json::from_str(r#"{"cliDefault":["claude.challenger","codex.someday"]}"#).unwrap();
        assert!(only.forces_cli_default("claude.challenger"));
        assert_eq!(only.rows, crate::settings::RoleModels::default());
        let kept = only.normalized().unwrap();
        assert_eq!(kept.cli_default, vec!["claude.challenger".to_string(), "codex.someday".to_string()]);
        let back = serde_json::to_value(&kept).unwrap();
        assert_eq!(back["cliDefault"][0], "claude.challenger");

        let rows_only: crate::settings::WorkspaceModels =
            serde_json::from_str(r#"{"claude":{"builder":"opus"},"codex":{}}"#).unwrap();
        assert!(rows_only.cli_default.is_empty());
        assert_eq!(rows_only.rows.claude.builder.as_deref(), Some("opus"));
        let back = serde_json::to_value(&rows_only).unwrap();
        assert!(back.get("cliDefault").is_none(), "{back}");
    }

    /// v1.23.0 (Cycle G3): a pre-trim workspace pinned to "editor",
    /// "run", "browser", and "worktrees" loads with the removed tab IDs
    /// stripped, leaving only "editor" in the pinned list. Crash
    /// protection for the FE tab renderer, which only knows the
    /// post-trim ID set.
    #[test]
    fn pre_v23_workspace_strips_removed_pinned_tabs() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br#"{
            "workspaces": [{
                "id": "ws-pre23",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 1,
                "openFiles": [],
                "activeFile": null,
                "accentColor": null,
                "layoutPreset": null,
                "verifySuite": null,
                "pinnedRightTabs": ["editor", "run", "browser", "worktrees", "kanban"]
            }],
            "activeWorkspaceId": "ws-pre23"
        }"#;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        // Removed IDs stripped. v1.71.0 (step 5b-1): `editor` and
        // `kanban` joined the retired set (folded into the Code/Board
        // center modes), so the legacy list now strips to empty.
        assert_eq!(
            snap.workspaces[0].pinned_right_tabs.as_deref(),
            Some(&[] as &[String]),
        );
    }

    /// v1.72.0 (step 5b-2): the `memory` → `knowledge` key rename is a
    /// MAP in the sanitizer, not a drop — persisted pins survive.
    #[test]
    fn pinned_memory_key_maps_to_knowledge_on_load() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br#"{
            "workspaces": [{
                "id": "ws-x",
                "name": "x",
                "cwd": "/tmp/x",
                "createdAt": 1,
                "lastOpenedAt": 1,
                "openFiles": [],
                "activeFile": null,
                "pinnedRightTabs": ["card", "memory", "prompts"]
            }],
            "activeWorkspaceId": "ws-x"
        }"#;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        // memory → knowledge (mapped); prompts dropped (retired);
        // card dropped (retired v1.76.0 — STEP6 D7).
        assert_eq!(
            snap.workspaces[0].pinned_right_tabs.as_deref(),
            Some(["knowledge".to_string()].as_slice()),
        );
    }

    /// v1.81.0 (Part 2 P2-3, Q1): swarm/agents/project retired — stale
    /// persisted pins drop on load; knowledge (the panel anchor) survives.
    #[test]
    fn pinned_swarm_agents_project_drop_on_load_v181() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br#"{
            "workspaces": [{
                "id": "ws-y",
                "name": "y",
                "cwd": "/tmp/y",
                "createdAt": 1,
                "lastOpenedAt": 1,
                "openFiles": [],
                "activeFile": null,
                "pinnedRightTabs": ["swarm", "agents", "project", "knowledge"]
            }],
            "activeWorkspaceId": "ws-y"
        }"#;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(
            snap.workspaces[0].pinned_right_tabs.as_deref(),
            Some(["knowledge".to_string()].as_slice()),
        );
    }

    /// GH #95 (ADR 0005): the right panel is retired. A workspaces.json
    /// written while it existed still loads — every other field intact, the
    /// pins decoded as before — and a later save keeps them, so retiring the
    /// panel resets no persisted state.
    #[test]
    fn retired_right_panel_pins_load_and_change_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-95",
                "name": "pinned",
                "cwd": "/tmp/pinned",
                "createdAt": 1,
                "lastOpenedAt": 2,
                "openFiles": ["/tmp/pinned/a.ts"],
                "activeFile": "/tmp/pinned/a.ts",
                "accentColor": "#7c3aed",
                "layoutPreset": "split",
                "pinnedRightTabs": ["knowledge", "swarm"]
            }],
            "activeWorkspaceId": "ws-95"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store.snapshot().workspaces.into_iter().next().unwrap();
        assert_eq!(ws.name, "pinned");
        assert_eq!(ws.open_files, vec!["/tmp/pinned/a.ts".to_string()]);
        assert_eq!(ws.active_file.as_deref(), Some("/tmp/pinned/a.ts"));
        assert_eq!(ws.accent_color.as_deref(), Some("#7c3aed"));
        assert_eq!(
            ws.pinned_right_tabs.as_deref(),
            Some(["knowledge".to_string()].as_slice()),
        );
        // An unrelated write persists the whole file; the pins survive it.
        store.rename("ws-95", "renamed".into()).unwrap();
        let reloaded = WorkspaceStore::new(tmp.path().to_path_buf())
            .unwrap()
            .snapshot()
            .workspaces
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(reloaded.name, "renamed");
        assert_eq!(reloaded.accent_color.as_deref(), Some("#7c3aed"));
        assert_eq!(reloaded.open_files, ws.open_files);
        assert_eq!(
            reloaded.pinned_right_tabs.as_deref(),
            Some(["knowledge".to_string()].as_slice()),
        );
    }

    /// v1.43.0 (Sidebar identity) Tier 2 schema-migration test: a
    /// workspaces.json written before `icon` was introduced must round-trip
    /// cleanly with the field defaulting to None. Tests the realistic
    /// mid-history fixture with prior-field state already present.
    #[test]
    fn pre_v43_workspace_loads_without_icon() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("workspaces.json");
        let json = br##"{
            "workspaces": [{
                "id": "ws-pre43",
                "name": "legacy",
                "cwd": "/tmp/legacy",
                "createdAt": 1,
                "lastOpenedAt": 1,
                "openFiles": [],
                "activeFile": null,
                "accentColor": "#7c3aed",
                "layoutPreset": null,
                "verifySuite": null,
                "pinnedRightTabs": null
            }],
            "activeWorkspaceId": "ws-pre43"
        }"##;
        fs::write(&path, json).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        assert!(snap.workspaces[0].icon.is_none());
        assert_eq!(snap.workspaces[0].accent_color.as_deref(), Some("#7c3aed"));
    }

    /// v1.43.0: all three WorkspaceIcon variants round-trip via serde
    /// with the tagged-enum format.
    #[test]
    fn workspace_icon_variants_round_trip() {
        let monogram = WorkspaceIcon::Monogram;
        let s = serde_json::to_string(&monogram).unwrap();
        assert_eq!(s, r#"{"kind":"monogram"}"#);
        let back: WorkspaceIcon = serde_json::from_str(&s).unwrap();
        assert_eq!(back, monogram);

        let emoji = WorkspaceIcon::Emoji { value: "🎨".into() };
        let s = serde_json::to_string(&emoji).unwrap();
        assert!(s.contains(r#""kind":"emoji""#));
        assert!(s.contains(r#""value":"🎨""#));
        let back: WorkspaceIcon = serde_json::from_str(&s).unwrap();
        assert_eq!(back, emoji);

        let image = WorkspaceIcon::Image {
            path: "/tmp/x.png".into(),
            mtime: 1700000000000,
        };
        let s = serde_json::to_string(&image).unwrap();
        let back: WorkspaceIcon = serde_json::from_str(&s).unwrap();
        assert_eq!(back, image);
    }

    /// v1.43.0: magic-byte sniffer accepts PNG/JPEG/WebP and rejects
    /// SVG + everything else.
    #[test]
    fn detect_image_ext_accepts_supported_and_rejects_svg() {
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0];
        assert_eq!(detect_image_ext(&png), Some("png"));
        let jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0];
        assert_eq!(detect_image_ext(&jpg), Some("jpg"));
        let webp = b"RIFF\x00\x00\x00\x00WEBPextra";
        assert_eq!(detect_image_ext(webp), Some("webp"));
        // SVG / XML / garbage all rejected.
        assert_eq!(detect_image_ext(b"<svg xmlns=\"...\"></svg>"), None);
        assert_eq!(detect_image_ext(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(detect_image_ext(b"GIF89a..."), None);
        assert_eq!(detect_image_ext(b"\x00\x00\x00\x00"), None);
    }

    /// v1.43.0: set_icon persists Monogram + Emoji variants; rejects
    /// Image. Round-trip via fresh store on the same dir.
    #[test]
    fn set_icon_persists_monogram_and_emoji() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store
            .create("demo".into(), work.path().to_string_lossy().into())
            .unwrap();
        store
            .set_icon(&ws.id, Some(WorkspaceIcon::Emoji { value: "🎨".into() }))
            .unwrap();
        let s2 = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let reloaded = s2.snapshot().workspaces.into_iter().find(|w| w.id == ws.id).unwrap();
        assert_eq!(reloaded.icon, Some(WorkspaceIcon::Emoji { value: "🎨".into() }));
        // Reject Image via set_icon.
        let err = s2
            .set_icon(
                &ws.id,
                Some(WorkspaceIcon::Image {
                    path: "/x.png".into(),
                    mtime: 0,
                }),
            )
            .unwrap_err();
        assert!(err.contains("Image"), "got: {err}");
        // Clear back to None.
        s2.set_icon(&ws.id, None).unwrap();
        let s3 = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let reloaded = s3.snapshot().workspaces.into_iter().find(|w| w.id == ws.id).unwrap();
        assert!(reloaded.icon.is_none());
    }

    /// v1.43.0: set_icon_image copies a real PNG into the icons dir,
    /// rejects an SVG file, and removes the file on workspace delete.
    #[test]
    fn set_icon_image_copies_png_and_cleanup_on_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
        let ws = store
            .create("demo".into(), work.path().to_string_lossy().into())
            .unwrap();

        // Write a fake PNG to a source path.
        let src_png = work.path().join("logo.png");
        let png_bytes: Vec<u8> = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        ]
        .iter()
        .copied()
        .chain(std::iter::repeat(0u8).take(64))
        .collect();
        fs::write(&src_png, &png_bytes).unwrap();
        let dest = store.set_icon_image(&ws.id, &src_png).unwrap();
        assert!(dest.ends_with(&format!("{}.png", ws.id)));
        assert!(Path::new(&dest).exists());

        // SVG rejected.
        let src_svg = work.path().join("logo.svg");
        fs::write(&src_svg, b"<svg></svg>").unwrap();
        let err = store.set_icon_image(&ws.id, &src_svg).unwrap_err();
        assert!(err.to_lowercase().contains("png"), "got: {err}");

        // Delete the workspace → icon file removed.
        store.delete(&ws.id).unwrap();
        assert!(!Path::new(&dest).exists());
    }

    #[test]
    fn infer_verify_suite_picks_cargo_when_cargo_toml_present() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"").unwrap();
        let suite = infer_verify_suite(tmp.path());
        assert!(suite.steps.iter().any(|s| matches!(s, VerifyStepKind::CargoTest)));
    }

    #[test]
    fn infer_verify_suite_picks_npm_test_when_package_json_has_test_script() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("package.json"),
            r#"{"name":"x","version":"0.0.0","scripts":{"test":"jest"}}"#,
        )
        .unwrap();
        let suite = infer_verify_suite(tmp.path());
        assert!(suite.steps.iter().any(|s| matches!(s, VerifyStepKind::NpmTest)));
    }

    #[test]
    fn infer_verify_suite_skips_npm_test_without_test_script() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("package.json"),
            r#"{"name":"x","version":"0.0.0","scripts":{"build":"vite build"}}"#,
        )
        .unwrap();
        let suite = infer_verify_suite(tmp.path());
        assert!(!suite.steps.iter().any(|s| matches!(s, VerifyStepKind::NpmTest)));
    }

    #[test]
    fn infer_verify_suite_picks_atelier_full_pipeline_when_repo_root() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("src-tauri")).unwrap();
        fs::create_dir_all(tmp.path().join("scripts")).unwrap();
        fs::write(tmp.path().join("src-tauri/Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"").unwrap();
        fs::write(
            tmp.path().join("package.json"),
            r#"{"name":"atelier","version":"0.0.0","scripts":{"test":"vitest"}}"#,
        )
        .unwrap();
        fs::write(tmp.path().join("scripts/ppvp.sh"), "#!/usr/bin/env bash\necho ok").unwrap();
        fs::write(tmp.path().join("scripts/verify-build.sh"), "#!/usr/bin/env bash\necho ok").unwrap();
        let suite = infer_verify_suite(tmp.path());
        let kinds: Vec<&str> = suite
            .steps
            .iter()
            .map(|s| match s {
                VerifyStepKind::CargoTest => "cargo",
                VerifyStepKind::NpmTest => "npm",
                VerifyStepKind::PpvpSh => "ppvp",
                VerifyStepKind::TauriBuild => "tauri",
                VerifyStepKind::ClaudeQa => "qa",
                VerifyStepKind::Shell { .. } => "shell",
            })
            .collect();
        assert_eq!(kinds, vec!["cargo", "npm", "ppvp", "tauri"]);
    }

    // ---- v1.61.0 (Phase 5 — onboarding) -----------------------------------

    /// A minimal `{ "name": "X" }` parses (all other fields optional) and a
    /// full manifest round-trips its shared-safe fields.
    #[test]
    fn workspace_default_parses_minimal_and_full() {
        let min: WorkspaceDefault = serde_json::from_slice(br#"{"name":"Min"}"#).expect("minimal");
        assert_eq!(min.name, "Min");
        assert_eq!(min.accent_color, None);
        assert_eq!(min.kanban_sync_mode, KanbanSyncMode::Local);

        let full: WorkspaceDefault = serde_json::from_slice(
            br##"{"name":"Ply","accentColor":"#7c3aed","layoutPreset":"quad",
                 "kanbanSyncMode":"githubIssues","githubOwnerRepo":"MatteoB-adv/atelier"}"##,
        )
        .expect("full");
        assert_eq!(full.accent_color.as_deref(), Some("#7c3aed"));
        assert_eq!(full.layout_preset.as_deref(), Some("quad"));
        assert_eq!(full.kanban_sync_mode, KanbanSyncMode::GitHubIssues);
        assert_eq!(full.github_owner_repo.as_deref(), Some("MatteoB-adv/atelier"));
    }

    /// `import_default` registers a workspace from a repo's manifest, and a
    /// second call is a no-op (idempotent by canonical cwd).
    #[test]
    fn imports_workspace_default_and_is_idempotent() {
        let cfg = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(cfg.path().to_path_buf()).unwrap();

        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join(".atelier")).unwrap();
        fs::write(
            repo.path().join(".atelier/workspace_default.json"),
            br##"{"name":"Ply","accentColor":"#7c3aed",
                 "kanbanSyncMode":"githubIssues","githubOwnerRepo":"MatteoB-adv/atelier"}"##,
        )
        .unwrap();

        let created = store.import_default(repo.path()).expect("import").expect("some");
        assert_eq!(created.name, "Ply");
        assert_eq!(created.kanban_sync_mode, KanbanSyncMode::GitHubIssues);
        assert_eq!(created.github_owner_repo.as_deref(), Some("MatteoB-adv/atelier"));
        // cwd is stored canonical (tempdirs on macOS live under a symlink).
        assert_eq!(created.cwd, crate::platform::canonicalize(repo.path()).unwrap().to_string_lossy());

        // Second import: already registered → None, store still has one ws.
        assert!(store.import_default(repo.path()).expect("import2").is_none());
        assert_eq!(store.snapshot().workspaces.len(), 1);
    }

    /// A repo with no manifest yields `Ok(None)`, never an error.
    #[test]
    fn import_default_none_when_no_manifest() {
        let cfg = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(cfg.path().to_path_buf()).unwrap();
        let repo = tempfile::tempdir().unwrap();
        assert!(store.import_default(repo.path()).expect("import").is_none());
    }

    /// `import_pending` imports the good repos, skips a malformed one, returns
    /// the created count, and deletes the queue file.
    #[test]
    fn import_pending_skips_malformed_and_counts() {
        let cfg = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(cfg.path().to_path_buf()).unwrap();

        let good = tempfile::tempdir().unwrap();
        fs::create_dir_all(good.path().join(".atelier")).unwrap();
        fs::write(
            good.path().join(".atelier/workspace_default.json"),
            br#"{"name":"Good"}"#,
        )
        .unwrap();

        let bad = tempfile::tempdir().unwrap();
        fs::create_dir_all(bad.path().join(".atelier")).unwrap();
        fs::write(bad.path().join(".atelier/workspace_default.json"), b"{not json").unwrap();

        let no_manifest = tempfile::tempdir().unwrap();

        let queue = cfg.path().join("pending_imports.json");
        let list = serde_json::to_vec(&vec![
            good.path().to_string_lossy().to_string(),
            bad.path().to_string_lossy().to_string(),
            no_manifest.path().to_string_lossy().to_string(),
        ])
        .unwrap();
        fs::write(&queue, list).unwrap();

        let created = store.import_pending(&queue).expect("drain");
        assert_eq!(created, 1); // only `good`; bad skipped, no_manifest is None
        assert_eq!(store.snapshot().workspaces.len(), 1);
        assert!(!queue.exists(), "queue file removed after drain");

        // Re-draining a missing queue is a clean no-op.
        assert_eq!(store.import_pending(&queue).expect("redrain"), 0);
    }
}
