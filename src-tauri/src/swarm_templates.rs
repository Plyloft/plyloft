//! v1.2.0: custom swarm templates + role library. Generalizes the v1.0/v1.1
//! hardcoded scout-build-review template into a data-driven `SwarmTemplate`
//! shape that the FSM (in `swarms.rs`) consumes.
//!
//! Layout:
//! - **Built-in templates** live in code (`builtin_templates()`) — synthesized
//!   in-memory on every `list()` call. Not persisted. Ensures fresh installs
//!   and v1.1→v1.2 upgrades require zero migration writes.
//! - **User-defined templates** persist to `<config_dir>/swarm_templates.json`
//!   (a single global file; not per-workspace). User-edited forks of a
//!   built-in get a fresh UUID and stand alongside builtins. Atomic writes
//!   (Hard Rule #3); schema-versioned for future migration.
//! - **Per-workspace role bindings** persist as one file per workspace at
//!   `<config_dir>/swarms/role_bindings/<workspace_id>.json` — a flat
//!   `role -> AgentConfig.id` map. Replaces the per-workspace
//!   `Swarm.role_bindings` map's role as the single source of truth for
//!   "which AgentConfig should fire when role X comes due in workspace W".
//!
//! T1 (the increment that adds this module) is purely additive: nothing in
//! `swarms.rs` calls into it yet. T3 generalizes the FSM to consume
//! `SwarmTemplate`. T5 wires bindings into `swarm_start`.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::shared_library::{read_library_file, LibraryScope};

const SWARM_TEMPLATES_FILE: &str = "swarm_templates.json";
const SWARM_TEMPLATES_SCHEMA_VERSION: u32 = 1;
const ROLE_BINDINGS_SUBDIR: &str = "swarms/role_bindings";
const ROLE_BINDINGS_SCHEMA_VERSION: u32 = 1;
pub const RETIRED_DEBATE_TEMPLATE_ID: &str = "claude-codex-debate";

/// Stable role identifier. Kebab-case. Matches `preset_id` on `AgentConfig`
/// for the 6 ships-with roles. User-defined roles (deferred to v1.3+) would
/// use a UUID here to avoid name collisions with the library.
pub type RoleId = String;

/// Stable template identifier. The 4 builtins use kebab-case names
/// (`"feature"`, `"refactor"`, `"ux-audit"`, `"bugfix"`); user templates
/// use UUIDs.
pub type TemplateId = String;

/// v1.38.0: declares whether a template produces code changes (`Code`) or
/// a text deliverable (`Recon` — ux-audit, design). The Outcome screen
/// branches on this: `Code` renders the diff/ship/verify surface; `Recon`
/// renders the artifact's `summary_md` markdown report as primary content.
///
/// Serde-default is `Code` so pre-v1.38 persisted user templates
/// deserialize as `Code` (matches their actual semantics — recon-shape
/// templates are not user-forkable today; only the builtins are recon).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutputKind {
    Code,
    Recon,
}

impl Default for OutputKind {
    fn default() -> Self {
        OutputKind::Code
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoleStep {
    /// Which role library entry this step represents.
    pub role: RoleId,
    /// True for reviewer-class steps that emit an artifact JSON the FSM
    /// reads to decide approve / reject. False for steps whose output is
    /// the diff itself (builder, refactorer).
    #[serde(default)]
    pub expects_artifact: bool,
    /// On a reject verdict from this step's artifact, jump to this step
    /// index (subject to `max_iterations`). `None` means "this step is
    /// terminal — reject is treated as Failed."
    #[serde(default)]
    pub on_reject_jump_to: Option<usize>,
    /// v1.21.0 (Phase 3): which provider runs this step. `None` (omitted in
    /// JSON) means claude — the v1.x default. `Some("codex")` dispatches
    /// the step via `codex exec --json`. Loader-level validation is
    /// deliberately absent (forward-compat for new providers); dispatch
    /// resolves the string via `parse_provider` and rejects unknowns with
    /// a clear error there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmTemplate {
    #[serde(default = "default_template_schema")]
    pub schema_version: u32,
    pub id: TemplateId,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub steps: Vec<RoleStep>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    #[serde(default = "default_max_wall_seconds")]
    pub max_wall_seconds: u64,
    /// True for the 4 ships-with templates. User forks set this to false.
    /// The Templates editor uses this to disable "Delete" on builtins (the
    /// editor offers "Fork" instead).
    #[serde(default)]
    pub builtin: bool,
    /// v1.3.0: when true, this template runs in coordinator mode — a
    /// meta-role reads the mailbox + emits a structured dispatch artifact
    /// each tick, fanning out concurrent role-instances. `steps` becomes
    /// the role pool the coordinator can pick from (rather than an ordered
    /// chain). When false (the v1.0/v1.1/v1.2 default), the FSM runs
    /// `steps` sequentially. v1.2 templates load with this defaulted to
    /// false; existing behavior is preserved exactly.
    #[serde(default)]
    pub coordinator: bool,
    /// v1.38.0: text-deliverable vs. code-deliverable. Drives the Outcome
    /// screen branch and (in v1.39.0) the fork-to-implementation gate.
    /// Defaults to `Code` for back-compat with pre-v1.38 persisted user
    /// templates.
    #[serde(default)]
    pub output_kind: OutputKind,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// v1.49.0 (Team Mode Phase 0): provenance. Builtins are stamped
    /// `Some("atelier")`. User-defined templates carry the cached
    /// `settings.identity.user_email` of the creator (stable across
    /// edits) and the most recent editor. `None` on legacy rows.
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub last_edited_by: Option<String>,
    /// v1.51.0 (Team Mode Phase 2.2): runtime-only scope tag — same
    /// pattern as `Prompt.scope` (v1.50.0). Set by `list_all_with_shared`
    /// based on which layer produced the entry. Builtins synthesized
    /// in `builtin_templates()` are tagged `Personal` (they ship with
    /// every install, not from a repo overlay). Never serialized; the
    /// FE renders this as a "Shared (.atelier)" chip on the editor's
    /// template list.
    #[serde(default = "default_template_scope", skip_serializing)]
    pub scope: LibraryScope,
}

fn default_template_scope() -> LibraryScope {
    LibraryScope::Personal
}

fn default_template_schema() -> u32 {
    SWARM_TEMPLATES_SCHEMA_VERSION
}
fn default_max_iterations() -> u32 {
    3
}
fn default_max_wall_seconds() -> u64 {
    1800
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmTemplatesFile {
    #[serde(default = "default_template_schema")]
    pub version: u32,
    /// User-defined templates only. Builtins are synthesized in-memory at
    /// `list()` time and never written here. A user-forked builtin lives
    /// here with a fresh UUID and `builtin: false`.
    #[serde(default)]
    pub templates: Vec<SwarmTemplate>,
}

impl Default for SwarmTemplatesFile {
    fn default() -> Self {
        Self {
            version: SWARM_TEMPLATES_SCHEMA_VERSION,
            templates: Vec::new(),
        }
    }
}

/// The 4 ships-with templates. Synthesized in-memory; never persisted.
pub fn builtin_templates() -> Vec<SwarmTemplate> {
    vec![
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "feature".to_string(),
            label: "Feature".to_string(),
            description: "Plan, build, review. Reviewer reject → builder. Default workflow for new functionality.".to_string(),
            steps: vec![
                RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
                RoleStep { role: "builder".into(), expects_artifact: false, on_reject_jump_to: None, provider: None },
                RoleStep { role: "reviewer".into(), expects_artifact: true, on_reject_jump_to: Some(1), provider: None },
            ],
            max_iterations: 3,
            max_wall_seconds: 3600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "refactor".to_string(),
            label: "Refactor".to_string(),
            description: "Plan, refactor, review. Reviewer reject → refactorer. For improving code without changing behavior.".to_string(),
            steps: vec![
                RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
                RoleStep { role: "refactorer".into(), expects_artifact: false, on_reject_jump_to: None, provider: None },
                RoleStep { role: "reviewer".into(), expects_artifact: true, on_reject_jump_to: Some(1), provider: None },
            ],
            max_iterations: 3,
            max_wall_seconds: 3600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "ux-audit".to_string(),
            label: "UX audit".to_string(),
            // v1.5.11: simplified to a single-role template. The ux-reviewer
            // navigates the codebase, produces the audit artifact (verdict +
            // ux_issues + ux_strengths). Both approve and reject verdicts
            // terminate Done — the audit IS the deliverable, not a quality
            // gate. The prior shape ([scout, builder, ux-reviewer] with reject
            // looping back to builder) was the wrong architecture for an
            // audit goal: it ran a meaningless builder step and looped 3x to
            // MaxIter on UI that didn't change between iterations (Run #17,
            // $4.86 wasted). A future ux-improve template can re-introduce
            // the build-and-review chain when needed.
            description: "Single-role UX audit. The ux-reviewer reads the goal, navigates the codebase, and produces a critique artifact (verdict + ux_issues + ux_strengths). The audit IS the deliverable — verdict is informational, not a gate.".to_string(),
            steps: vec![
                RoleStep { role: "ux-reviewer".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
            ],
            max_iterations: 1,
            max_wall_seconds: 600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Recon,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "bugfix".to_string(),
            label: "Bugfix".to_string(),
            description: "Plan, build, review. Same chain as Feature but capped at 2 iterations — bugs that survive 2 reviewer passes warrant a human eye.".to_string(),
            steps: vec![
                RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
                RoleStep { role: "builder".into(), expects_artifact: false, on_reject_jump_to: None, provider: None },
                RoleStep { role: "reviewer".into(), expects_artifact: true, on_reject_jump_to: Some(1), provider: None },
            ],
            max_iterations: 2,
            max_wall_seconds: 3600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "coordinator-feature".to_string(),
            label: "Coordinator (feature)".to_string(),
            description: "Coordinator-mode parallel feature dev. The Coordinator role decides each tick which roles to dispatch in parallel from the pool [scout, architect, builder, reviewer]. For small tasks it acts like sequential; for tasks that touch multiple subsystems it fans out builders with disjoint owner_globs. Up to 5 concurrent legs per tick, max 5 ticks. Requires Max-plan parallel-session capacity.".to_string(),
            steps: vec![
                RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
                RoleStep { role: "architect".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
                RoleStep { role: "builder".into(), expects_artifact: false, on_reject_jump_to: None, provider: None },
                RoleStep { role: "reviewer".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
            ],
            max_iterations: 5,
            max_wall_seconds: 3600,
            builtin: true,
            coordinator: true,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "claude-codex-debate".to_string(),
            label: "Debate (Claude ↔ Codex)".to_string(),
            description: "Two-LLM debate. Claude's Architect plans, Codex's Critic challenges, Architect revises, Critic re-evaluates. Use when a single LLM's plan deserves an adversarial second opinion before you act on it.".to_string(),
            steps: vec![
                RoleStep { role: "architect".into(), expects_artifact: true,  on_reject_jump_to: None,    provider: None },
                RoleStep { role: "critic".into(),    expects_artifact: true,  on_reject_jump_to: None,    provider: Some("codex".into()) },
                RoleStep { role: "architect".into(), expects_artifact: true,  on_reject_jump_to: None,    provider: None },
                RoleStep { role: "critic".into(),    expects_artifact: true,  on_reject_jump_to: Some(2), provider: Some("codex".into()) },
            ],
            max_iterations: 2,
            max_wall_seconds: 3600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "review-followup".to_string(),
            label: "Review follow-up".to_string(),
            // v1.31.0 (Cycle 1 — Review surface): the lightweight follow-up
            // dispatched when a reviewer rejects hunks on a card whose
            // original swarm ran a *sequential* template. A single builder
            // step, no reviewer gate — it applies the reviewer's feedback
            // in the card's existing worktree and terminates Done. A
            // coordinator-mode card reuses its own template instead (the
            // adaptive choice lives in `commands::card_review_request_changes`).
            description: "Single builder step that applies reviewer feedback in an existing card worktree. Dispatched by the review surface for reject-with-feedback on sequential-template cards.".to_string(),
            steps: vec![
                RoleStep { role: "builder".into(), expects_artifact: false, on_reject_jump_to: None, provider: None },
            ],
            max_iterations: 1,
            max_wall_seconds: 3600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "design".to_string(),
            label: "Design".to_string(),
            // v1.5.12: single-role design template, mirror of ux-audit's
            // v1.5.11 shape. Architect navigates the codebase and produces
            // a design artifact (decision + rationale + affected_components
            // + open_questions); the design IS the deliverable. Calibration
            // Run #20 (cal-v121-a1) demonstrated coordinator-feature was
            // wrong for design-only goals — the coordinator can't
            // recognize "design complete" without a reviewer-approve
            // signal, and looped 5 architects to MaxIter ($6.42, 24m). A
            // single-role architect template avoids the issue entirely.
            description: "Single-role architecture decision. The architect reads the codebase and produces a design artifact (decision + rationale + affected_components + open_questions). Use for design-only goals — no implementation.".to_string(),
            steps: vec![
                RoleStep { role: "architect".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
            ],
            max_iterations: 1,
            max_wall_seconds: 600,
            builtin: true,
            coordinator: false,
            output_kind: OutputKind::Recon,
            created_at: 0,
            updated_at: 0,
            author: Some("atelier".into()),
            last_edited_by: Some("atelier".into()),
            scope: LibraryScope::Personal,
        },
    ]
}

/// Phase 5A: templates offered for a new run. The old Claude ↔ Codex debate
/// remains in `builtin_templates()` so historical state can still resolve
/// its label, roles, and original Code output kind.
pub fn startable_builtin_templates() -> Vec<SwarmTemplate> {
    builtin_templates()
        .into_iter()
        .filter(|template| !is_retired_template_id(&template.id))
        .collect()
}

pub fn is_retired_template_id(id: &str) -> bool {
    id == RETIRED_DEBATE_TEMPLATE_ID
}

pub fn ensure_startable_template_id(id: &str) -> Result<(), String> {
    if is_retired_template_id(id) {
        return Err(
            "The legacy Claude ↔ Codex debate is retired for new starts. \
             Use Discuss for independent analysis, cross-review, and bounded synthesis."
                .into(),
        );
    }
    Ok(())
}

// GH #171: `is_builtin_template_id` gated the Templates editor's Delete vs.
// Fork; it went with the editor (Settings › Swarm templates).

pub struct SwarmTemplatesStore {
    path: PathBuf,
    cache: Mutex<Vec<SwarmTemplate>>,
    loaded: Mutex<bool>,
}

impl SwarmTemplatesStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|e| format!("create config dir: {e}"))?;
        Ok(Self {
            path: config_dir.join(SWARM_TEMPLATES_FILE),
            cache: Mutex::new(Vec::new()),
            loaded: Mutex::new(false),
        })
    }

    /// Returns user-defined templates only (excluding builtins). For the
    /// Templates editor's "Your templates" list.
    pub fn list_user_defined(&self) -> Result<Vec<SwarmTemplate>, String> {
        if *self.loaded.lock() {
            return Ok(self.cache.lock().clone());
        }
        let templates = if self.path.exists() {
            let bytes = fs::read(&self.path).map_err(|e| format!("read templates: {e}"))?;
            if bytes.is_empty() {
                Vec::new()
            } else {
                let parsed: SwarmTemplatesFile = match serde_json::from_slice(&bytes) {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("swarm_templates: parse failed ({e}); returning empty");
                        return Ok(Vec::new());
                    }
                };
                if parsed.version != SWARM_TEMPLATES_SCHEMA_VERSION {
                    log::warn!(
                        "swarm_templates: file has version {} (expected {}); ignoring",
                        parsed.version,
                        SWARM_TEMPLATES_SCHEMA_VERSION
                    );
                    return Ok(Vec::new());
                }
                parsed.templates
            }
        } else {
            Vec::new()
        };
        *self.cache.lock() = templates.clone();
        *self.loaded.lock() = true;
        Ok(templates)
    }

    /// Returns builtins ++ user-defined templates. The list the run-time
    /// picker (SwarmStartModal) and the orchestrator use. If a user fork
    /// happened to share a builtin ID (shouldn't — forks get fresh UUIDs),
    /// the user version wins by appearing later.
    pub fn list_all(&self) -> Result<Vec<SwarmTemplate>, String> {
        let mut out = builtin_templates();
        out.extend(self.list_user_defined()?);
        Ok(out)
    }

    /// New-start catalog. Historical lookup deliberately continues to use
    /// `list_all()` / `get()` so old runs are not rewritten or orphaned.
    pub fn list_startable(&self) -> Result<Vec<SwarmTemplate>, String> {
        let mut out = startable_builtin_templates();
        out.extend(
            self.list_user_defined()?
                .into_iter()
                .filter(|template| !is_retired_template_id(&template.id)),
        );
        Ok(out)
    }

    /// v1.51.0 (Team Mode Phase 2.2): return builtins + personal user
    /// templates + (optionally) shared templates loaded from
    /// `<project_cwd>/.atelier/library/swarm_templates.json`. Same merge
    /// policy as `PromptsStore::list_all_with_shared`: shared wins on
    /// id collision; malformed shared files degrade with a warn log.
    /// Builtins are tagged `Personal` (they ship in-binary, not in any
    /// repo overlay).
    pub fn list_all_with_shared(
        &self,
        project_cwd: Option<&Path>,
    ) -> Result<Vec<SwarmTemplate>, String> {
        let mut out = builtin_templates();
        let mut personal = self.list_user_defined()?;
        for t in personal.iter_mut() {
            t.scope = LibraryScope::Personal;
        }
        let shared: Option<SwarmTemplatesFile> =
            match read_library_file(project_cwd, SWARM_TEMPLATES_FILE) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!(
                        "swarm_templates: shared library read failed ({e}); using personal only"
                    );
                    None
                }
            };
        let shared = match shared {
            Some(s) if s.version == SWARM_TEMPLATES_SCHEMA_VERSION => Some(s),
            Some(s) => {
                log::warn!(
                    "swarm_templates: shared library has version {} (expected {}); using personal only",
                    s.version,
                    SWARM_TEMPLATES_SCHEMA_VERSION
                );
                None
            }
            None => None,
        };
        if let Some(shared) = shared {
            let shared_ids: std::collections::HashSet<&str> =
                shared.templates.iter().map(|t| t.id.as_str()).collect();
            personal.retain(|t| !shared_ids.contains(t.id.as_str()));
            out.extend(personal);
            for mut s in shared.templates {
                s.scope = LibraryScope::Shared;
                out.push(s);
            }
        } else {
            out.extend(personal);
        }
        Ok(out)
    }

    /// Shared-aware new-start catalog. The reserved retired ID is filtered
    /// regardless of whether it came from a builtin, personal file, or shared
    /// overlay, preventing a collision from reviving the old runtime.
    pub fn list_startable_with_shared(
        &self,
        project_cwd: Option<&Path>,
    ) -> Result<Vec<SwarmTemplate>, String> {
        Ok(self
            .list_all_with_shared(project_cwd)?
            .into_iter()
            .filter(|template| !is_retired_template_id(&template.id))
            .collect())
    }

    /// Look up a template by ID. Builtins resolve from in-memory; user
    /// templates from cache. Returns None if neither matches.
    pub fn get(&self, id: &str) -> Result<Option<SwarmTemplate>, String> {
        if let Some(b) = builtin_templates().into_iter().find(|t| t.id == id) {
            return Ok(Some(b));
        }
        Ok(self.list_user_defined()?.into_iter().find(|t| t.id == id))
    }

    /// GH #171: test-only. Settings › Swarm templates was the one writer of
    /// the personal file; it is retired, so production never writes it again
    /// (the file on disk is still read). The tests keep this writer to lay
    /// down files in the shape the retired editor wrote.
    #[cfg(test)]
    fn save_all(&self, templates: Vec<SwarmTemplate>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        let file = SwarmTemplatesFile {
            version: SWARM_TEMPLATES_SCHEMA_VERSION,
            templates: templates.clone(),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| format!("encode: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &self.path).map_err(|e| format!("rename: {e}"))?;
        *self.cache.lock() = templates;
        *self.loaded.lock() = true;
        Ok(())
    }

    /// Create a new user-defined template. Caller must NOT pass a builtin
    /// ID — those are reserved. ID + timestamps are filled in.
    ///
    /// GH #171: test-only, like `save_all`: a fixture writer in the shape the
    /// retired editor wrote. `update`, `delete`, `fork`, `promote_to_shared`
    /// and `demote_to_personal` went with the editor.
    #[cfg(test)]
    pub fn create(
        &self,
        mut template: SwarmTemplate,
        author_email: Option<String>,
    ) -> Result<SwarmTemplate, String> {
        let now = chrono::Utc::now().timestamp_millis();
        template.id = uuid::Uuid::new_v4().to_string();
        template.created_at = now;
        template.updated_at = now;
        template.builtin = false;
        // v1.49.0 (Team Mode Phase 0): provenance stamps. Builtins keep
        // `Some("atelier")`; user-defined templates carry the caller's
        // cached identity (or None if unconfigured).
        template.author = author_email.clone();
        template.last_edited_by = author_email;
        let mut templates = self.list_user_defined()?;
        templates.push(template.clone());
        self.save_all(templates)?;
        Ok(template)
    }

}

// ── v1.53.0 (Team Mode Phase 2.4): role-binding preflight ─────

/// A single role that's referenced by a swarm template but not yet
/// bound to an agent on the current user's machine. Optionally
/// carries a suggested AgentConfig id sourced from
/// `<project_cwd>/.atelier/agents/` (the team-shared agents directory
/// — also a v0.8.0+ pattern that v1.49.0 normalized provenance on).
/// The FE renders this as a row in the "This template needs you to
/// bind these roles" modal, with the suggestion preselected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnboundRole {
    pub role: RoleId,
    /// Suggested agent id from `.atelier/agents/` whose tags or
    /// preset_id matches the role. `None` if no obvious candidate.
    pub suggested_agent_id: Option<String>,
    /// Display name of the suggested agent (so the modal can render
    /// it without a second IPC round-trip). `None` paired with
    /// `suggested_agent_id` Some only if the AgentConfig lookup
    /// failed mid-resolve — defensive.
    pub suggested_agent_name: Option<String>,
}

/// v1.53.0: walk a template's `steps[].role` list, compute which
/// roles are NOT currently bound for `workspace_id` in
/// `RoleBindingsStore`, and (if `project_cwd` is supplied) suggest a
/// shared agent from `.atelier/agents/` whose `preset_id` or `tags`
/// match the role name.
///
/// Returns empty when every role is bound — the FE then dispatches
/// without showing the modal.
pub fn unbound_roles_for_template(
    template: &SwarmTemplate,
    workspace_id: &str,
    bindings_store: &RoleBindingsStore,
    agent_registry: &crate::agents::AgentRegistry,
    project_cwd: Option<&Path>,
) -> Result<Vec<UnboundRole>, String> {
    let bindings = bindings_store.get(workspace_id)?;
    // De-dupe role names — the same role can appear multiple times
    // in a coordinator-mode template's `steps` pool.
    let mut roles: Vec<&str> = template
        .steps
        .iter()
        .map(|s| s.role.as_str())
        .collect();
    roles.sort();
    roles.dedup();
    // Load .atelier/agents/ once for suggestion lookup. Failure
    // degrades to "no suggestion" — not an error.
    let project_agents: Vec<crate::agents::AgentConfig> = match project_cwd {
        Some(cwd) => agent_registry
            .list_agents(workspace_id, cwd)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| matches!(a.scope, crate::agents::AgentScope::Project))
            .collect(),
        None => Vec::new(),
    };
    let mut out = Vec::new();
    for role in roles {
        if bindings.contains_key(role) {
            continue;
        }
        // v1.84.0: roles with a builtin preset seed can never fail
        // dispatch — `swarm_start`'s binding resolution auto-seeds an
        // AgentConfig for them and persists the binding (see swarms.rs).
        // Reporting them here dead-ended fresh workspaces: every card
        // dispatch was blocked on scout/builder/reviewer with a "bind
        // these roles" toast even though no binding was needed. The
        // preflight exists for CUSTOM roles (typically from a
        // teammate-shared template) that would error mid-stream.
        if crate::swarms::role_preset_seed(role, workspace_id).is_some() {
            continue;
        }
        // Suggestion lookup: preset_id exact match wins, else first
        // agent tagged with the role name.
        let suggestion = project_agents
            .iter()
            .find(|a| a.preset_id.as_deref() == Some(role))
            .or_else(|| {
                project_agents
                    .iter()
                    .find(|a| a.tags.iter().any(|t| t == role))
            });
        out.push(UnboundRole {
            role: role.to_string(),
            suggested_agent_id: suggestion.map(|a| a.id.clone()),
            suggested_agent_name: suggestion.map(|a| a.name.clone()),
        });
    }
    Ok(out)
}

// ── Per-workspace role bindings ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoleBindingsFile {
    #[serde(default = "default_bindings_schema")]
    pub schema_version: u32,
    pub workspace_id: String,
    /// role_id -> AgentConfig.id. Empty when no roles have been bound yet
    /// for this workspace; the orchestrator will auto-seed via the role
    /// preset on first encounter (T5).
    #[serde(default)]
    pub bindings: HashMap<RoleId, String>,
}

fn default_bindings_schema() -> u32 {
    ROLE_BINDINGS_SCHEMA_VERSION
}

pub struct RoleBindingsStore {
    bindings_dir: PathBuf,
    cache: Mutex<HashMap<String, HashMap<RoleId, String>>>,
    loaded_workspaces: Mutex<std::collections::HashSet<String>>,
}

impl RoleBindingsStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let bindings_dir = config_dir.join(ROLE_BINDINGS_SUBDIR);
        fs::create_dir_all(&bindings_dir).map_err(|e| format!("create bindings dir: {e}"))?;
        Ok(Self {
            bindings_dir,
            cache: Mutex::new(HashMap::new()),
            loaded_workspaces: Mutex::new(std::collections::HashSet::new()),
        })
    }

    fn workspace_path(&self, workspace_id: &str) -> PathBuf {
        // Sanitize: workspace IDs are UUIDs, but be defensive about any
        // exotic characters since they become a filesystem path.
        let safe: String = workspace_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        self.bindings_dir.join(format!("{safe}.json"))
    }

    fn load_workspace(&self, workspace_id: &str) -> Result<HashMap<RoleId, String>, String> {
        let path = self.workspace_path(workspace_id);
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let bytes = fs::read(&path).map_err(|e| format!("read bindings: {e}"))?;
        if bytes.is_empty() {
            return Ok(HashMap::new());
        }
        let parsed: WorkspaceRoleBindingsFile = match serde_json::from_slice(&bytes) {
            Ok(p) => p,
            Err(e) => {
                log::error!(
                    "role_bindings: parse failed for {} ({e}); returning empty",
                    workspace_id
                );
                return Ok(HashMap::new());
            }
        };
        if parsed.schema_version != ROLE_BINDINGS_SCHEMA_VERSION {
            log::warn!(
                "role_bindings: file for {} has version {} (expected {}); ignoring",
                workspace_id,
                parsed.schema_version,
                ROLE_BINDINGS_SCHEMA_VERSION
            );
            return Ok(HashMap::new());
        }
        Ok(parsed.bindings)
    }

    fn ensure_loaded(&self, workspace_id: &str) -> Result<(), String> {
        if self.loaded_workspaces.lock().contains(workspace_id) {
            return Ok(());
        }
        let bindings = self.load_workspace(workspace_id)?;
        self.cache
            .lock()
            .insert(workspace_id.to_string(), bindings);
        self.loaded_workspaces
            .lock()
            .insert(workspace_id.to_string());
        Ok(())
    }

    pub fn get(&self, workspace_id: &str) -> Result<HashMap<RoleId, String>, String> {
        self.ensure_loaded(workspace_id)?;
        Ok(self
            .cache
            .lock()
            .get(workspace_id)
            .cloned()
            .unwrap_or_default())
    }

    pub fn get_binding(&self, workspace_id: &str, role: &str) -> Result<Option<String>, String> {
        Ok(self.get(workspace_id)?.get(role).cloned())
    }

    fn save_workspace(
        &self,
        workspace_id: &str,
        bindings: HashMap<RoleId, String>,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        let file = WorkspaceRoleBindingsFile {
            schema_version: ROLE_BINDINGS_SCHEMA_VERSION,
            workspace_id: workspace_id.to_string(),
            bindings: bindings.clone(),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| format!("encode: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        self.cache
            .lock()
            .insert(workspace_id.to_string(), bindings);
        self.loaded_workspaces
            .lock()
            .insert(workspace_id.to_string());
        Ok(())
    }

    /// Set a single role → agent_id binding for a workspace. Idempotent.
    pub fn set_binding(
        &self,
        workspace_id: &str,
        role: &str,
        agent_id: &str,
    ) -> Result<(), String> {
        let mut bindings = self.get(workspace_id)?;
        bindings.insert(role.to_string(), agent_id.to_string());
        self.save_workspace(workspace_id, bindings)
    }

    // GH #171: `replace` and `remove_binding` were Settings › Role bindings'
    // own writes and went with it. `set_binding` stays: a swarm seeds its
    // bindings on its first run.
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // ── Builtins ───────────────────────────────────────

    #[test]
    fn builtin_templates_returns_eight_entries_with_expected_ids() {
        // v1.31.0: 4 sequential builtins + 1 coordinator-mode builtin +
        // 1 single-role design builtin + the claude-codex-debate
        // cross-provider template + the review-followup builtin.
        let builtins = builtin_templates();
        assert_eq!(builtins.len(), 8);
        let ids: Vec<&str> = builtins.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"feature"));
        assert!(ids.contains(&"refactor"));
        assert!(ids.contains(&"ux-audit"));
        assert!(ids.contains(&"bugfix"));
        assert!(ids.contains(&"coordinator-feature"));
        assert!(ids.contains(&"design"));
        assert!(ids.contains(&"claude-codex-debate"));
        assert!(ids.contains(&"review-followup"));
        assert!(builtins.iter().all(|t| t.builtin));
    }

    #[test]
    fn retired_debate_is_historical_but_not_startable() {
        let builtins = builtin_templates();
        let historical = builtins
            .iter()
            .find(|template| template.id == RETIRED_DEBATE_TEMPLATE_ID)
            .expect("retired debate remains historically resolvable");
        assert_eq!(historical.output_kind, OutputKind::Code);

        let startable = startable_builtin_templates();
        assert_eq!(startable.len(), builtins.len() - 1);
        assert!(!startable
            .iter()
            .any(|template| template.id == RETIRED_DEBATE_TEMPLATE_ID));
        assert!(ensure_startable_template_id(RETIRED_DEBATE_TEMPLATE_ID).is_err());
        assert!(ensure_startable_template_id("feature").is_ok());
    }

    #[test]
    fn builtin_review_followup_is_single_builder_step() {
        // v1.31.0 (Cycle 1): the reject-with-feedback follow-up template.
        // One builder step, no reviewer gate, non-coordinator — it applies
        // feedback in the card worktree and terminates Done.
        let rf = builtin_templates()
            .into_iter()
            .find(|t| t.id == "review-followup")
            .expect("review-followup exists");
        assert!(rf.builtin);
        assert!(!rf.coordinator);
        assert_eq!(rf.steps.len(), 1);
        assert_eq!(rf.steps[0].role, "builder");
        assert!(!rf.steps[0].expects_artifact);
        assert_eq!(rf.max_iterations, 1);
    }

    #[test]
    fn builtin_feature_template_matches_v1_0_chain() {
        // Back-compat invariant: the "feature" template must produce the
        // same scout → builder → reviewer chain as v1.0/v1.1's hardcoded
        // FSM. T4 redirects "scout-build-review" → "feature" at load.
        let feature = builtin_templates()
            .into_iter()
            .find(|t| t.id == "feature")
            .expect("feature exists");
        assert_eq!(feature.steps.len(), 3);
        assert_eq!(feature.steps[0].role, "scout");
        assert_eq!(feature.steps[1].role, "builder");
        assert_eq!(feature.steps[2].role, "reviewer");
        // Reviewer reject loops back to builder (index 1).
        assert_eq!(feature.steps[2].on_reject_jump_to, Some(1));
        assert_eq!(feature.max_iterations, 3);
        assert_eq!(feature.max_wall_seconds, 3600);
    }

    #[test]
    fn builtin_bugfix_caps_iterations_at_two() {
        let bugfix = builtin_templates()
            .into_iter()
            .find(|t| t.id == "bugfix")
            .unwrap();
        assert_eq!(bugfix.max_iterations, 2);
    }

    #[test]
    fn builtin_refactor_uses_refactorer_role() {
        let r = builtin_templates()
            .into_iter()
            .find(|t| t.id == "refactor")
            .unwrap();
        assert_eq!(r.steps[1].role, "refactorer");
        assert_eq!(r.steps[2].on_reject_jump_to, Some(1));
    }

    #[test]
    fn builtin_ux_audit_is_single_role_audit() {
        // v1.5.11: ux-audit collapsed from [scout, builder, ux-reviewer] to
        // a single ux-reviewer step. The audit IS the deliverable — both
        // verdicts terminate Done. Calibration Run #17 demonstrated the
        // prior 3-step chain was architecturally wrong for audit goals
        // (looped to MaxIter on UI that didn't change between iterations).
        let u = builtin_templates()
            .into_iter()
            .find(|t| t.id == "ux-audit")
            .unwrap();
        assert_eq!(u.steps.len(), 1, "ux-audit must be single-role");
        assert_eq!(u.steps[0].role, "ux-reviewer");
        assert!(u.steps[0].expects_artifact);
        // No loopback target — the FSM ignores ux-reviewer's verdict in
        // this single-step template, so both approve and reject terminate
        // Done with the audit artifact intact.
        assert_eq!(u.steps[0].on_reject_jump_to, None);
        assert_eq!(u.max_iterations, 1);
    }

    #[test]
    fn builtin_design_is_single_role_architect() {
        // v1.5.12: design template mirrors ux-audit's v1.5.11 single-role
        // shape. The architect IS the deliverable; FSM ignores any verdict
        // and terminates Done. Calibration Run #20 demonstrated
        // coordinator-feature couldn't recognize design-task completion
        // (5 ticks → MaxIter, $6.42 burned).
        let d = builtin_templates()
            .into_iter()
            .find(|t| t.id == "design")
            .unwrap();
        assert_eq!(d.steps.len(), 1, "design must be single-role");
        assert_eq!(d.steps[0].role, "architect");
        assert!(d.steps[0].expects_artifact);
        assert_eq!(d.steps[0].on_reject_jump_to, None);
        assert_eq!(d.max_iterations, 1);
        assert!(!d.coordinator);
    }

    #[test]
    fn output_kind_marks_ux_audit_and_design_as_recon_only() {
        // v1.38.0: ux-audit and design are the two recon-style builtins.
        // Every other builtin produces code changes (or planning prose
        // that's the input to a code chain, like coordinator-feature) and
        // is `Code`. Asserted explicitly so a future builtin doesn't
        // silently inherit `Recon` via copy-paste.
        let builtins = builtin_templates();
        for t in &builtins {
            let expected = match t.id.as_str() {
                "ux-audit" | "design" => OutputKind::Recon,
                _ => OutputKind::Code,
            };
            assert_eq!(
                t.output_kind, expected,
                "template {} has wrong output_kind",
                t.id
            );
        }
    }

    #[test]
    fn output_kind_defaults_to_code_for_legacy_persisted_templates() {
        // v1.38.0 migration: pre-v1.38 persisted user templates have no
        // `output_kind` field in their JSON. Serde's #[serde(default)]
        // must make them deserialize as `Code` (the only sane default —
        // recon-shape user templates don't exist yet).
        let legacy_json = r#"{
            "schemaVersion": 1,
            "id": "user-template-uuid",
            "label": "Legacy",
            "description": "",
            "steps": [
                { "role": "scout", "expectsArtifact": true }
            ],
            "maxIterations": 3,
            "maxWallSeconds": 3600,
            "builtin": false,
            "coordinator": false,
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let t: SwarmTemplate = serde_json::from_str(legacy_json)
            .expect("legacy template JSON deserializes");
        assert_eq!(t.output_kind, OutputKind::Code);
    }

    #[test]
    fn builtin_coordinator_feature_has_coordinator_flag_and_role_pool() {
        // v1.5.1: the only built-in coordinator-mode template. Pool covers
        // scout, architect, builder, reviewer — gives the coordinator
        // enough role variety to handle design-heavy + parallel-build
        // tasks. Iteration cap higher than sequential builtins (5 vs 3)
        // because each tick can do real work in parallel; bouncing
        // between coordinator + tick is cheaper than reject-loops in
        // sequential mode.
        let cf = builtin_templates()
            .into_iter()
            .find(|t| t.id == "coordinator-feature")
            .expect("coordinator-feature exists");
        assert!(cf.coordinator, "coordinator flag must be set");
        assert!(cf.builtin);
        assert_eq!(cf.max_iterations, 5);
        assert_eq!(cf.max_wall_seconds, 3600);
        let roles: Vec<&str> = cf.steps.iter().map(|s| s.role.as_str()).collect();
        assert!(roles.contains(&"scout"));
        assert!(roles.contains(&"architect"));
        assert!(roles.contains(&"builder"));
        assert!(roles.contains(&"reviewer"));
        // No on_reject_jump_to — coordinator templates don't use the
        // reject-loopback mechanism (the coordinator decides via tick
        // artifacts, not verdict gates).
        assert!(cf.steps.iter().all(|s| s.on_reject_jump_to.is_none()));
    }

    #[test]
    fn builtin_debate_alternates_claude_and_codex_providers() {
        // v1.22.0: the only built-in cross-provider template. Steps must
        // alternate (claude, codex, claude, codex); final critic loops
        // back to step 2 (architect-revise) on reject; max_iterations is
        // 2 so a single reject-loop attempt is allowed before MaxIter.
        let t = builtin_templates()
            .into_iter()
            .find(|t| t.id == "claude-codex-debate")
            .expect("debate template exists");
        assert!(t.builtin);
        assert!(!t.coordinator);
        assert_eq!(t.steps.len(), 4);
        let providers: Vec<_> = t.steps.iter().map(|s| s.provider.clone()).collect();
        assert_eq!(
            providers,
            vec![None, Some("codex".into()), None, Some("codex".into())]
        );
        let roles: Vec<_> = t.steps.iter().map(|s| s.role.as_str()).collect();
        assert_eq!(roles, vec!["architect", "critic", "architect", "critic"]);
        assert_eq!(t.steps[3].on_reject_jump_to, Some(2));
        assert!(t.steps.iter().all(|s| s.expects_artifact));
        assert_eq!(t.max_iterations, 2);
        assert_eq!(t.max_wall_seconds, 3600);
    }

    // ── SwarmTemplatesStore round-trip ─────────────────

    fn fresh_store() -> (tempfile::TempDir, SwarmTemplatesStore) {
        let tmp = tempdir().unwrap();
        let store = SwarmTemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        (tmp, store)
    }

    fn sample_template(label: &str) -> SwarmTemplate {
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: String::new(),
            label: label.into(),
            description: String::new(),
            steps: vec![
                RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None, provider: None },
                RoleStep { role: "builder".into(), expects_artifact: false, on_reject_jump_to: None, provider: None },
                RoleStep { role: "reviewer".into(), expects_artifact: true, on_reject_jump_to: Some(1), provider: None },
            ],
            max_iterations: 3,
            max_wall_seconds: 3600,
            builtin: false,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
            scope: LibraryScope::Personal,
        }
    }

    #[test]
    fn list_user_defined_returns_empty_on_fresh_install() {
        let (_tmp, store) = fresh_store();
        assert!(store.list_user_defined().unwrap().is_empty());
    }

    #[test]
    fn list_all_includes_eight_builtins_on_fresh_install() {
        let (_tmp, store) = fresh_store();
        let all = store.list_all().unwrap();
        assert_eq!(all.len(), 8);
        assert!(all.iter().all(|t| t.builtin));
    }

    #[test]
    fn startable_catalog_excludes_retired_debate_but_get_keeps_it() {
        let (_tmp, store) = fresh_store();
        let startable = store.list_startable().unwrap();
        assert_eq!(startable.len(), 7);
        assert!(!startable
            .iter()
            .any(|template| template.id == RETIRED_DEBATE_TEMPLATE_ID));
        assert!(store
            .get(RETIRED_DEBATE_TEMPLATE_ID)
            .unwrap()
            .is_some());
    }

    #[test]
    fn shared_collision_cannot_revive_retired_debate() {
        let (tmp, store) = fresh_store();
        let shared_path = tmp
            .path()
            .join(".atelier/library")
            .join(SWARM_TEMPLATES_FILE);
        std::fs::create_dir_all(shared_path.parent().unwrap()).unwrap();
        std::fs::write(
            &shared_path,
            r#"{
                "version": 1,
                "templates": [{
                    "id": "claude-codex-debate",
                    "label": "Attempted revival",
                    "description": "",
                    "steps": [{"role":"critic"}],
                    "maxIterations": 3,
                    "maxWallSeconds": 1800,
                    "builtin": false,
                    "coordinator": false,
                    "outputKind": "recon",
                    "createdAt": 0,
                    "updatedAt": 0
                }]
            }"#,
        )
        .unwrap();
        let startable = store
            .list_startable_with_shared(Some(tmp.path()))
            .unwrap();
        assert!(!startable
            .iter()
            .any(|template| template.id == RETIRED_DEBATE_TEMPLATE_ID));
        let historical = store.list_all_with_shared(Some(tmp.path())).unwrap();
        assert!(historical
            .iter()
            .any(|template| template.id == RETIRED_DEBATE_TEMPLATE_ID));
    }

    #[test]
    fn create_then_list_round_trips_and_persists() {
        let (tmp, store) = fresh_store();
        let t = store.create(sample_template("My feature"), None).unwrap();
        assert!(!t.id.is_empty());
        assert!(!t.builtin);
        // Reload via fresh store on the same dir.
        let s2 = SwarmTemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let user = s2.list_user_defined().unwrap();
        assert_eq!(user.len(), 1);
        assert_eq!(user[0].label, "My feature");
        let all = s2.list_all().unwrap();
        assert_eq!(all.len(), 9); // 8 builtins + 1 user
    }

    #[test]
    fn get_resolves_builtin_and_user_templates() {
        let (_tmp, store) = fresh_store();
        let user = store.create(sample_template("Mine"), None).unwrap();
        let builtin = store.get("feature").unwrap().expect("feature");
        assert_eq!(builtin.id, "feature");
        assert!(builtin.builtin);
        let mine = store.get(&user.id).unwrap().expect("user");
        assert_eq!(mine.label, "Mine");
        assert!(store.get("does-not-exist").unwrap().is_none());
    }

    /// v1.49.0 Tier 2 (Team Mode Phase 0): a pre-team-mode user
    /// swarm_templates.json loads cleanly with `author` / `lastEditedBy`
    /// defaulting to `None`. Builtins synthesized in-memory carry
    /// `Some("atelier")` for both fields so the UI can render their
    /// authorship explicitly.
    #[test]
    fn legacy_swarm_templates_load_with_provenance_none_and_builtins_stamped() {
        let (tmp, _store) = fresh_store();
        let path = tmp.path().join(SWARM_TEMPLATES_FILE);
        let json = br#"{
            "version": 1,
            "templates": [{
                "id": "abc-123",
                "label": "Mine",
                "steps": [{ "role": "scout" }]
            }]
        }"#;
        std::fs::write(&path, json).unwrap();
        let store = SwarmTemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let user = store.list_user_defined().unwrap();
        assert_eq!(user.len(), 1);
        assert_eq!(user[0].author, None);
        assert_eq!(user[0].last_edited_by, None);
        let feature = store.get("feature").unwrap().expect("feature");
        assert_eq!(feature.author.as_deref(), Some("atelier"));
        assert_eq!(feature.last_edited_by.as_deref(), Some("atelier"));
    }

    /// v1.51.0 (Team Mode Phase 2.2): `list_all_with_shared(None)`
    /// returns builtins + personal user templates, all tagged Personal.
    #[test]
    fn list_all_with_shared_none_returns_builtins_plus_personal() {
        let (_tmp, store) = fresh_store();
        store.create(sample_template("mine"), None).unwrap();
        let loaded = store.list_all_with_shared(None).unwrap();
        assert_eq!(loaded.len(), 9); // 8 builtins + 1 user
        assert!(loaded.iter().all(|t| t.scope == LibraryScope::Personal));
    }

    /// v1.51.0: shared swarm templates from
    /// `<cwd>/.atelier/library/swarm_templates.json` merge in tagged
    /// Shared. Builtins remain tagged Personal (they ship in-binary,
    /// not in any repo overlay). User entries colliding by id with a
    /// shared one are dropped in favor of the shared entry.
    #[test]
    fn list_all_with_shared_merges_repo_library() {
        let (tmp, store) = fresh_store();
        // Reuse the temp dir as the "project" so we don't need a
        // second tempdir. Write a shared library file alongside.
        let shared_path = tmp.path().join(".atelier/library").join(SWARM_TEMPLATES_FILE);
        std::fs::create_dir_all(shared_path.parent().unwrap()).unwrap();
        let colliding = store.create(sample_template("personal"), None).unwrap();
        let shared_json = format!(
            r#"{{
                "version": 1,
                "templates": [
                    {{
                        "id": "shared-only-uuid",
                        "label": "Shared Only",
                        "description": "",
                        "steps": [{{"role":"scout"}}],
                        "maxIterations": 3,
                        "maxWallSeconds": 1800,
                        "builtin": false,
                        "coordinator": false,
                        "outputKind": "code",
                        "createdAt": 1700000000000,
                        "updatedAt": 1700000000000
                    }},
                    {{
                        "id": "{}",
                        "label": "Override Personal",
                        "description": "",
                        "steps": [{{"role":"builder"}}],
                        "maxIterations": 3,
                        "maxWallSeconds": 1800,
                        "builtin": false,
                        "coordinator": false,
                        "outputKind": "code",
                        "createdAt": 1700000000000,
                        "updatedAt": 1700000000000
                    }}
                ]
            }}"#,
            colliding.id
        );
        std::fs::write(&shared_path, shared_json).unwrap();
        let loaded = store
            .list_all_with_shared(Some(tmp.path()))
            .unwrap();
        // 8 builtins (Personal) + 0 remaining personal user (collided)
        // + 1 shared-only + 1 shared override = 10
        assert_eq!(loaded.len(), 10);
        let shared_only = loaded
            .iter()
            .find(|t| t.id == "shared-only-uuid")
            .expect("shared-only present");
        assert_eq!(shared_only.scope, LibraryScope::Shared);
        let override_entry = loaded
            .iter()
            .find(|t| t.id == colliding.id)
            .expect("override present");
        assert_eq!(override_entry.scope, LibraryScope::Shared);
        assert_eq!(override_entry.label, "Override Personal");
        // Builtins stay Personal.
        let feature = loaded
            .iter()
            .find(|t| t.id == "feature")
            .expect("feature builtin present");
        assert_eq!(feature.scope, LibraryScope::Personal);
        assert!(feature.builtin);
    }

    /// Tier 2 schema-migration test: a v1.2-shaped swarm_templates.json
    /// loads cleanly on a fresh start; missing optional fields default.
    #[test]
    fn schema_migration_loads_minimal_user_template() {
        let (tmp, _store) = fresh_store();
        let path = tmp.path().join(SWARM_TEMPLATES_FILE);
        let json = br#"{
            "version": 1,
            "templates": [{
                "id": "abc-123",
                "label": "Minimal",
                "steps": [
                    { "role": "scout" },
                    { "role": "builder" }
                ]
            }]
        }"#;
        std::fs::write(&path, json).unwrap();
        let store = SwarmTemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let user = store.list_user_defined().unwrap();
        assert_eq!(user.len(), 1);
        assert_eq!(user[0].id, "abc-123");
        assert_eq!(user[0].max_iterations, 3); // default
        assert_eq!(user[0].max_wall_seconds, 1800); // default
        assert!(!user[0].builtin); // default
        assert!(!user[0].steps[0].expects_artifact); // default
        assert!(user[0].steps[0].on_reject_jump_to.is_none()); // default
    }

    /// Tier 2 (v1.21.0 Phase 3): a pre-Phase-3 `RoleStep` without `provider`
    /// loads cleanly with `provider = None` (i.e. claude — the v1.x default).
    /// Loader-level validation of `provider` is deliberately absent; unknown
    /// strings flow through and get rejected at dispatch time by
    /// `parse_provider`.
    #[test]
    fn role_step_loads_without_provider() {
        let (tmp, _store) = fresh_store();
        let path = tmp.path().join(SWARM_TEMPLATES_FILE);
        let json = br#"{
            "version": 1,
            "templates": [{
                "id": "legacy",
                "label": "Legacy",
                "steps": [
                    { "role": "scout" },
                    { "role": "builder", "expectsArtifact": false }
                ]
            }]
        }"#;
        std::fs::write(&path, json).unwrap();
        let store = SwarmTemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let user = store.list_user_defined().unwrap();
        assert_eq!(user.len(), 1);
        assert!(user[0].steps[0].provider.is_none());
        assert!(user[0].steps[1].provider.is_none());
    }

    /// Tier 2: a future-version file is ignored gracefully (returns empty
    /// rather than corrupting cache). Pairs with the same posture in
    /// `templates.rs`.
    #[test]
    fn schema_migration_ignores_unknown_version() {
        let (tmp, _store) = fresh_store();
        let path = tmp.path().join(SWARM_TEMPLATES_FILE);
        let json = br#"{
            "version": 999,
            "templates": [{ "id": "x", "label": "x", "steps": [] }]
        }"#;
        std::fs::write(&path, json).unwrap();
        let store = SwarmTemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store.list_user_defined().unwrap().is_empty());
    }

    // ── v1.53.0 unbound role preflight ──────────────────

    #[test]
    fn unbound_roles_returns_empty_when_all_bound() {
        let cfg_dir = tempfile::tempdir().unwrap();
        let bindings_store =
            RoleBindingsStore::new(cfg_dir.path().to_path_buf()).unwrap();
        let agent_registry =
            crate::agents::AgentRegistry::new(cfg_dir.path()).unwrap();
        // Pre-bind every role in `feature` (scout/builder/reviewer).
        for (role, agent) in [
            ("scout", "agent-scout"),
            ("builder", "agent-builder"),
            ("reviewer", "agent-reviewer"),
        ] {
            bindings_store.set_binding("ws-1", role, agent).unwrap();
        }
        let template = builtin_templates()
            .into_iter()
            .find(|t| t.id == "feature")
            .unwrap();
        let out = unbound_roles_for_template(
            &template,
            "ws-1",
            &bindings_store,
            &agent_registry,
            None,
        )
        .unwrap();
        assert!(out.is_empty());
    }

    /// v1.84.0: test helper — a custom (non-builtin) template whose
    /// steps reference the given roles. Mirrors a teammate-shared
    /// template that names roles with no builtin preset seed.
    fn custom_template_with_roles(roles: &[&str]) -> SwarmTemplate {
        SwarmTemplate {
            schema_version: SWARM_TEMPLATES_SCHEMA_VERSION,
            id: "custom-tpl".to_string(),
            label: "Custom".to_string(),
            description: String::new(),
            steps: roles
                .iter()
                .map(|r| RoleStep {
                    role: (*r).into(),
                    expects_artifact: false,
                    on_reject_jump_to: None,
                    provider: None,
                })
                .collect(),
            max_iterations: 3,
            max_wall_seconds: 3600,
            builtin: false,
            coordinator: false,
            output_kind: OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
            scope: LibraryScope::Personal,
        }
    }

    #[test]
    fn unbound_roles_returns_custom_missing_roles_only() {
        let cfg_dir = tempfile::tempdir().unwrap();
        let bindings_store =
            RoleBindingsStore::new(cfg_dir.path().to_path_buf()).unwrap();
        let agent_registry =
            crate::agents::AgentRegistry::new(cfg_dir.path()).unwrap();
        // `dbexpert` bound — `qa-lead` missing; `scout` has a preset
        // seed so it must NOT be reported even though it's unbound.
        bindings_store.set_binding("ws-1", "dbexpert", "agent-db").unwrap();
        let template =
            custom_template_with_roles(&["scout", "dbexpert", "qa-lead"]);
        let out = unbound_roles_for_template(
            &template,
            "ws-1",
            &bindings_store,
            &agent_registry,
            None,
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "qa-lead");
        // No project_cwd → no suggestions.
        assert!(out.iter().all(|u| u.suggested_agent_id.is_none()));
    }

    /// v1.84.0: preset-seedable roles auto-seed at swarm_start — the
    /// preflight must not block a fresh workspace (zero bindings) from
    /// dispatching a builtin template.
    #[test]
    fn unbound_roles_skips_preset_seedable_roles_on_fresh_workspace() {
        let cfg_dir = tempfile::tempdir().unwrap();
        let bindings_store =
            RoleBindingsStore::new(cfg_dir.path().to_path_buf()).unwrap();
        let agent_registry =
            crate::agents::AgentRegistry::new(cfg_dir.path()).unwrap();
        for template in builtin_templates() {
            let out = unbound_roles_for_template(
                &template,
                "ws-fresh",
                &bindings_store,
                &agent_registry,
                None,
            )
            .unwrap();
            assert!(
                out.is_empty(),
                "builtin template '{}' reported unbound roles on a fresh \
                 workspace: {:?}",
                template.id,
                out.iter().map(|u| u.role.clone()).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn unbound_roles_suggests_from_dot_atelier_agents() {
        use crate::agents::{AgentConfig, AgentScope, RuntimeMode};
        let cfg_dir = tempfile::tempdir().unwrap();
        let proj_cwd = tempfile::tempdir().unwrap();
        let bindings_store =
            RoleBindingsStore::new(cfg_dir.path().to_path_buf()).unwrap();
        let agent_registry =
            crate::agents::AgentRegistry::new(cfg_dir.path()).unwrap();
        // Seed a project-scope agent tagged with the CUSTOM role
        // "dbexpert" inside `.atelier/agents/`. (v1.84.0: was "builder",
        // but preset-seedable roles are no longer reported unbound —
        // the suggestion path only matters for custom roles.)
        let builder_agent = AgentConfig {
            schema_version: 1,
            id: String::new(),
            scope: AgentScope::Project,
            workspace_id: None,
            name: "team-builder".into(),
            description: String::new(),
            system_prompt: "build".into(),
            runtime_mode: RuntimeMode::Oneshot,
            prompt_template: String::new(),
            allowed_tools: Vec::new(),
            schedule: None,
            triggers: Vec::new(),
            tags: vec!["dbexpert".into()],
            notify_on_done: false,
            preset_id: Some("dbexpert".into()),
            previous_version: None,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
        };
        let saved = agent_registry
            .create_agent(builder_agent, Some(proj_cwd.path()), None)
            .unwrap();
        let template = custom_template_with_roles(&["dbexpert", "qa-lead"]);
        let out = unbound_roles_for_template(
            &template,
            "ws-1",
            &bindings_store,
            &agent_registry,
            Some(proj_cwd.path()),
        )
        .unwrap();
        // Both custom roles unbound; suggestion exists for `dbexpert`
        // (the one we seeded), but not for `qa-lead`.
        let db_row = out
            .iter()
            .find(|u| u.role == "dbexpert")
            .expect("dbexpert unbound row present");
        assert_eq!(db_row.suggested_agent_id.as_deref(), Some(saved.id.as_str()));
        assert_eq!(
            db_row.suggested_agent_name.as_deref(),
            Some("team-builder")
        );
        let qa_row = out
            .iter()
            .find(|u| u.role == "qa-lead")
            .expect("qa-lead unbound row present");
        assert!(qa_row.suggested_agent_id.is_none());
    }

    // ── RoleBindingsStore round-trip ───────────────────

    fn fresh_bindings_store() -> (tempfile::TempDir, RoleBindingsStore) {
        let tmp = tempdir().unwrap();
        let store = RoleBindingsStore::new(tmp.path().to_path_buf()).unwrap();
        (tmp, store)
    }

    #[test]
    fn role_bindings_get_returns_empty_on_fresh_workspace() {
        let (_tmp, store) = fresh_bindings_store();
        let bindings = store.get("ws-fresh").unwrap();
        assert!(bindings.is_empty());
    }

    #[test]
    fn role_bindings_set_then_get_round_trips() {
        let (tmp, store) = fresh_bindings_store();
        store.set_binding("ws-1", "scout", "agent-S").unwrap();
        store.set_binding("ws-1", "builder", "agent-B").unwrap();
        // Reload via fresh store.
        let s2 = RoleBindingsStore::new(tmp.path().to_path_buf()).unwrap();
        let bindings = s2.get("ws-1").unwrap();
        assert_eq!(bindings.get("scout"), Some(&"agent-S".to_string()));
        assert_eq!(bindings.get("builder"), Some(&"agent-B".to_string()));
        assert_eq!(bindings.len(), 2);
    }

    #[test]
    fn role_bindings_isolated_per_workspace() {
        let (_tmp, store) = fresh_bindings_store();
        store.set_binding("ws-A", "scout", "agent-A-S").unwrap();
        store.set_binding("ws-B", "scout", "agent-B-S").unwrap();
        assert_eq!(
            store.get_binding("ws-A", "scout").unwrap(),
            Some("agent-A-S".to_string())
        );
        assert_eq!(
            store.get_binding("ws-B", "scout").unwrap(),
            Some("agent-B-S".to_string())
        );
    }

    #[test]
    fn role_bindings_workspace_id_with_exotic_chars_sanitized() {
        // Defensive: workspace IDs are UUIDs in production, but the path
        // builder strips non-alphanumeric/hyphen/underscore to keep the
        // filesystem layout predictable.
        let (_tmp, store) = fresh_bindings_store();
        store
            .set_binding("ws/with/slashes", "scout", "agent-X")
            .unwrap();
        let bindings = store.get("ws/with/slashes").unwrap();
        // The sanitization is per-call, so the same input yields the same
        // sanitized key on read.
        assert_eq!(bindings.get("scout"), Some(&"agent-X".to_string()));
    }
}
