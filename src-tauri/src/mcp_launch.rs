//! Provider-neutral launch support for the bundled read-only Knowledge MCP.
//!
//! Phase 1B.1 owns sidecar discovery and compatibility validation. Provider
//! argv injection is added in the next increment so every managed launch goes
//! through one typed path.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

const SIDECAR_NAME: &str = if cfg!(windows) {
    "ply-mcp.exe"
} else {
    "ply-mcp"
};
const SIDECAR_PROTOCOL_VERSION: &str = "2";
// A cold macOS exec under a parallel workspace test run can exceed two
// seconds. This is only the maximum wait; successful probes return at once.
const SIDECAR_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
static VALIDATED_SIDECAR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn resolve_and_validate_sidecar() -> Result<PathBuf, String> {
    let host_executable =
        std::env::current_exe().map_err(|error| format!("resolve Plyloft executable: {error}"))?;
    let sidecar = sidecar_path_from_host(&host_executable)?;
    if VALIDATED_SIDECAR.get() == Some(&sidecar) {
        return Ok(sidecar);
    }
    validate_sidecar(&sidecar, SIDECAR_VERSION_TIMEOUT)?;
    let _ = VALIDATED_SIDECAR.set(sidecar.clone());
    Ok(sidecar)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    Claude,
    Codex,
}

// 1.176.0 R3: a tile's provider is its declared kind
// (`cli_fresh::tile_cli`), no longer its command matched against the cached
// path — a window and a backend holding different snapshots started a
// Claude tile as a plain shell.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KnowledgeMcpContext {
    provider: Provider,
    config_dir: PathBuf,
    workspace_id: String,
    project_cwd: PathBuf,
    /// v1.115.0 (team sharing rung 2): the team-repo clone whose
    /// `library/knowledge/` is the Team scope. Resolved from the machine's
    /// key rather than passed by each caller, so every session Ply launches —
    /// Builder, Challenger, tiles, probes — sees the same team library.
    /// `None` when there is no key, no team repo in it, or no clone yet.
    team_clone_dir: Option<PathBuf>,
    /// v1.116.0 (rung 3): the same clone's `library/claude/` and
    /// `library/codex/`. Read here rather than by each caller for the same
    /// reason the Knowledge directory is: every session Ply launches must see
    /// one team layer, resolved once.
    ///
    /// Skills hub H1: read from **session snapshots** of the clone's `HEAD`
    /// ([`crate::library_snapshot`]), never from its working tree, so a pull
    /// never changes what a running session reads and a pull racing this
    /// launch can never hand it a torn copy. Only the half this provider
    /// loads is built.
    team_skills: crate::team_skills::TeamSkillsLibrary,
    /// What this launch was given from the team library — its commit and
    /// skills — for "Skill updated after this session started" (R13).
    team_record: Option<crate::library_snapshot::LibraryRecord>,
    /// GH #106: the skills that ship inside the app, switched on on this Mac,
    /// built into the team library's layout ([`crate::ply_skills`]). Resolved
    /// here for the reason the two layers above are: every session Ply launches
    /// gets the same answer, read once, and the argv rules below have one place
    /// to add a plugin. Empty when the bundle is missing or every skill is off,
    /// and then it contributes nothing at all.
    ply_skills: crate::team_skills::TeamSkillsLibrary,
    /// Skills hub H10 (R6): **My library**, the member's own skills library,
    /// delivered like the team library — session snapshots of one commit
    /// ([`crate::library_snapshot`]), its script holds included — as the
    /// plugin `mine` (or `mine-<login>` beside a team plugin named `mine`).
    /// Empty when this Mac uses none.
    mine_skills: crate::team_skills::TeamSkillsLibrary,
    mine_record: Option<crate::library_snapshot::LibraryRecord>,
}

impl KnowledgeMcpContext {
    pub(crate) fn new<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        provider: Provider,
        workspace_id: impl Into<String>,
        project_cwd: impl AsRef<Path>,
    ) -> Result<Self, String> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("resolve Plyloft config directory: {error}"))?;
        let mut context = Self::from_paths(
            provider,
            config_dir,
            workspace_id,
            project_cwd,
            team_clone_dir(app),
        )?;
        // GH #106: read from the live settings store, so the next session Ply
        // launches picks a switch up and the ones already running are untouched
        // — nothing is restarted, because nothing is told.
        //
        // `try_state` for the same reason `team_clone_dir` uses it: a mock app in
        // a test manages no settings store, and a launch must not panic over it.
        let mac_off = app
            .try_state::<crate::settings::SettingsStore>()
            .map(|store| store.snapshot().library.ply_skills_off)
            .unwrap_or_default();
        if let Some(bundle) = crate::ply_skills::bundle_dir(app) {
            // Skills hub H9 (R9): the effective switch — this workspace's
            // choice, a fork in this checkout, the team default (only where
            // the team library reaches this session), then this Mac's.
            let switch = crate::ply_skill_switch::inputs(
                app.try_state::<crate::project_config::ProjectConfigStore>().as_deref(),
                &context.workspace_id,
                Some(&context.project_cwd),
                context.team_clone_dir.as_deref(),
                mac_off,
            );
            let off = switch.off(
                crate::ply_skills::read_bundle(&bundle)
                    .iter()
                    .map(|skill| skill.name.as_str())
                    .collect::<Vec<_>>(),
            );
            if !off.is_empty() {
                log::debug!("ply skills: this session goes without {}", off.join(", "));
            }
            // `stamp: true` — this is the launch, and the stamp is what keeps the
            // prune from removing a build a live session is reading (review 2).
            let delivery = crate::ply_skills::deliver(
                &context.config_dir.join(crate::ply_skills::BUILDS_DIR),
                &bundle,
                &off,
                true,
            );
            if let Some(problem) = &delivery.problem {
                log::warn!("ply skills: this session gets none ({problem})");
            }
            context.ply_skills = delivery.library;
        }
        // Skills hub H10 (R6): My library, when this Mac uses one. Not
        // plan-gated (§9).
        if let (Some(clone), Some(mine)) = (crate::my_library::delivered_clone(app), crate::my_library::setting(app)) {
            context = context.with_my_library(&clone, &mine.repo);
        }
        Ok(context)
    }

    /// Skills hub H10: My library's half for this provider, from snapshots
    /// of its `HEAD`; a library that can't be snapshotted costs this session
    /// My library's skills, never the launch (the team layer's rule).
    fn with_my_library(mut self, clone: &Path, repo: &str) -> Self {
        let half = match self.provider {
            Provider::Claude => crate::library_snapshot::Half::Claude,
            Provider::Codex => crate::library_snapshot::Half::Codex,
        };
        let clone = match canonical_directory("My library clone", clone) {
            Ok(clone) => clone,
            Err(error) => {
                log::debug!("my library: none for this session ({error})");
                return self;
            }
        };
        let delivered = match crate::library_snapshot::deliver(
            &self.config_dir,
            &clone,
            half,
            crate::library_snapshot::Options::native(),
        ) {
            Ok(delivered) => delivered,
            Err(error) => {
                log::warn!("my library: this session gets none ({error})");
                return self;
            }
        };
        // R6 edge: the team's plugin keeps its name; My library's is
        // delivered as `mine-<login>` beside it, from a renamed copy of its
        // snapshot.
        let team_plugins: Vec<String> = self
            .team_skills
            .claude_plugins
            .iter()
            .map(|(name, _)| name.clone())
            .chain(self.team_skills.codex.iter().flat_map(|m| m.plugins.iter().map(|p| p.name.clone())))
            .collect();
        let name = crate::my_library::delivered_name(&team_plugins, repo);
        let mut library = delivered.library;
        if name != crate::my_library::PLUGIN {
            library = rename_mine(library, &name);
        }
        for error in &library.errors {
            log::debug!("my library: {error}");
        }
        self.mine_skills = library;
        self.mine_record = delivered.record;
        self
    }

    fn from_paths(
        provider: Provider,
        config_dir: impl AsRef<Path>,
        workspace_id: impl Into<String>,
        project_cwd: impl AsRef<Path>,
        team_clone_dir: Option<PathBuf>,
    ) -> Result<Self, String> {
        let config_dir = canonical_directory("Plyloft config directory", config_dir.as_ref())?;
        let project_cwd = canonical_directory("project cwd", project_cwd.as_ref())?;
        let workspace_id = workspace_id.into();
        // A team clone that is missing or unreadable must never fail a
        // session launch: the Team layer is additive, so drop it and serve
        // the other three.
        let team_clone_dir = team_clone_dir.and_then(|dir| {
            canonical_directory("team clone", &dir)
                .map_err(|error| log::debug!("knowledge mcp: no team layer ({error})"))
                .ok()
        });

        // Reuse the shared reader's path-component validation so launch
        // context and the sidecar cannot drift on workspace identity rules.
        ply_memory::AcceptedKnowledgeReader::with_team(
            config_dir.clone(),
            Some(workspace_id.clone()),
            Some(project_cwd.clone()),
            team_clone_dir.clone(),
        )?;

        // Skills hub H1: from snapshots of one commit, built (or reused) now.
        // A library that cannot be snapshotted costs this session the team
        // skills, never the launch — the additive rule above.
        let half = match provider {
            Provider::Claude => crate::library_snapshot::Half::Claude,
            Provider::Codex => crate::library_snapshot::Half::Codex,
        };
        let (team_skills, team_record) = match team_clone_dir.as_deref() {
            None => (crate::team_skills::TeamSkillsLibrary::default(), None),
            Some(clone) => match crate::library_snapshot::deliver(
                &config_dir,
                clone,
                half,
                crate::library_snapshot::Options::native(),
            ) {
                Ok(delivered) => {
                    log::debug!("team skills: {} snapshot(s) built for this launch", delivered.built);
                    (delivered.library, delivered.record)
                }
                Err(error) => {
                    log::warn!("team skills: this session gets none ({error})");
                    (crate::team_skills::TeamSkillsLibrary::default(), None)
                }
            },
        };
        for error in &team_skills.errors {
            log::debug!("team skills: {error}");
        }

        Ok(Self {
            provider,
            config_dir,
            workspace_id,
            project_cwd,
            team_clone_dir,
            team_skills,
            team_record,
            // Filled by `new` from the app's resources and this Mac's settings.
            // `from_paths` takes neither, so the argv and overlay rules stay
            // testable without a Tauri app (rung 3's rule for the sidecar and
            // the Codex home).
            ply_skills: crate::team_skills::TeamSkillsLibrary::default(),
            mine_skills: crate::team_skills::TeamSkillsLibrary::default(),
            mine_record: None,
        })
    }

    /// GH #106: the built Ply-skills library this launch will deliver. Set apart
    /// from [`Self::from_paths`] so a test can give the argv rules a library
    /// without an app handle, a bundle or a settings store.
    #[cfg(all(test, unix))]
    fn with_ply_skills(mut self, ply_skills: crate::team_skills::TeamSkillsLibrary) -> Self {
        self.ply_skills = ply_skills;
        self
    }
}

/// Skills hub H10 (R6 edge): My library's delivered half with its plugin
/// renamed `name` (a team plugin is called `mine`). A half that can't be
/// renamed is dropped for this session, with the reason logged.
fn rename_mine(library: crate::team_skills::TeamSkillsLibrary, name: &str) -> crate::team_skills::TeamSkillsLibrary {
    let mut claude = Vec::new();
    for (plugin, dir) in &library.claude_plugins {
        if plugin == crate::my_library::PLUGIN {
            match crate::my_library::renamed_snapshot(dir, false, name) {
                Ok(renamed) => claude.push((name.to_string(), renamed)),
                Err(error) => log::warn!("my library: the Claude half isn't delivered as {name} ({error})"),
            }
        } else {
            claude.push((plugin.clone(), dir.clone()));
        }
    }
    let codex = library.codex.as_ref().and_then(|market| {
        match crate::my_library::renamed_snapshot(&market.root, true, name) {
            Ok(renamed) => Some(renamed),
            Err(error) => {
                log::warn!("my library: the Codex half isn't delivered as {name} ({error})");
                None
            }
        }
    });
    let mut out = crate::team_skills::read_snapshot_library(claude, codex.as_deref());
    out.errors.extend(library.errors);
    out
}

/// The clone of the team this Mac is in (onboarding §11.1: the setting, else
/// the key's), if it is managed and cloned. `try_state` rather than `state`: a
/// mock app in a test manages neither store, and a launch context must not
/// panic over an absent team.
pub(crate) fn team_clone_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let slug = crate::commands::current_team_repo(app)?;
    let team = app.try_state::<crate::team::TeamStore>()?;
    let dir = team.clone_dir(&slug);
    // Skills hub H2: not a library the member switched off on this Mac (R16)
    // or one this Mac left with the team (R17), even if its clone stayed.
    if let Ok(config_dir) = crate::skills_hub::config_dir(app) {
        if !crate::skills_hub::delivers(&config_dir, &slug) {
            return None;
        }
    }
    dir.join(".git").exists().then_some(dir)
}

/// Everything one managed launch adds to the child process.
///
/// v1.116.0 (rung 3): argv is no longer enough. Claude takes its team skills
/// as `--plugin-dir` arguments, but Codex has no session-scoped flag at all —
/// it takes a whole `CODEX_HOME`. So a launch yields argv *and* environment,
/// and the overlay directory whose lifetime is the session's.
pub(crate) struct SessionInjection {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    /// Held for as long as the child runs; dropping it removes the overlay.
    pub(crate) codex_home: Option<crate::codex_home::CodexHomeOverlay>,
    /// Skills hub H1: what this session is given from each library, for
    /// [`crate::library_snapshot::register`] under its PTY id. Empty when it
    /// was given no library skill.
    pub(crate) library_records: Vec<crate::library_snapshot::LibraryRecord>,
}

/// Build the argv and environment for one managed launch.
///
/// Restriction arguments are never touched: the Challenger's and the probes'
/// read-only argv reaches the child exactly as its caller built it. Team
/// skills are additive — a `--plugin-dir` for Claude, an environment variable
/// for Codex — and a team layer that cannot be prepared is logged and dropped
/// rather than failing the launch, the same rule the Team Knowledge layer
/// follows.
///
/// GH #106: the skills that ship inside Ply travel the same two ways, and under
/// the same rule. There is one `CODEX_HOME`, so the team library and Ply's own
/// skills share one overlay; for Claude they are one more `--plugin-dir`. Both
/// are absent when every Ply skill is switched off, which is the whole of
/// "switched off is not delivered".
///
/// GH #156: the integration branch's project skills reach Codex the same way —
/// a third marketplace (`ply-project`, plugin `project`) in that one overlay —
/// as they reach Claude through the `project` `--plugin-dir`.
///
/// `session_cwd` is the directory the child actually starts in — a card's
/// worktree for a Builder, whose context names the workspace checkout. Skills
/// that depend on what a directory carries are chosen against it.
///
/// `interactive` (2026-09-30): the child is a TUI a tile shows — not a
/// collected `codex exec` run. An interactive Codex gets `--no-daemon`
/// ([`codex_no_daemon`]).
pub(crate) fn inject_session(
    args: Vec<String>,
    context: Option<&KnowledgeMcpContext>,
    session_cwd: Option<&Path>,
    interactive: bool,
) -> Result<SessionInjection, String> {
    let Some(context) = context else {
        return Ok(SessionInjection {
            args,
            env: Vec::new(),
            codex_home: None,
            library_records: Vec::new(),
        });
    };

    let sidecar = resolve_and_validate_sidecar()?;
    let mut injection = inject_with_sidecar_and_skills(
        args,
        context,
        &sidecar,
        &crate::codex_home::real_codex_home(),
        session_cwd,
    );
    let version = crate::shell_env::try_get().and_then(|env| env.codex_version.clone());
    if codex_no_daemon(context.provider, interactive, version.as_deref()) {
        injection.args.insert(0, CODEX_NO_DAEMON.to_string());
    }
    Ok(injection)
}

/// Codex's own flag for running a session in its own process, without the
/// shared background server (`codex app-server --managed-daemon`).
pub(crate) const CODEX_NO_DAEMON: &str = "--no-daemon";

/// The first Codex measured to have [`CODEX_NO_DAEMON`] (codex-cli 0.158.0).
const CODEX_NO_DAEMON_SINCE: (u64, u64, u64) = (0, 158, 0);

/// Whether an interactive Codex launch gets [`CODEX_NO_DAEMON`].
///
/// Codex 0.158+ runs a TUI session in a shared background server when it can,
/// starting one if none runs: plain `codex` under a fresh `CODEX_HOME` left a
/// detached `codex app-server --listen unix:// --managed-daemon` running after
/// the TUI was killed (measured, codex-cli 0.158.0). Plyloft's `-c` overrides
/// (the `ply` MCP server, the Builder's reasoning effort, the intake's
/// settings) keep every tile out of it — "embedded mode" — and Codex says so
/// on every tile: "⚠ 1 warning: Running without the shared background server:
/// command-line configuration overrides (-c, --enable, --disable, or --search)
/// requires embedded mode." (walked, codex-cli 0.159.2).
///
/// Moving the overrides into the overlay's `config.toml` would silence it the
/// wrong way: without them Codex would start (or join) that server — a
/// process that outlives the tile and Plyloft's exit cleanup (Hard Rule 4),
/// running under an overlay that is removed when the tile closes, and one
/// already running under the member's own home would not see the overlay's
/// skills or MCP server at all. A tile with no overlay needs its `-c` anyway.
/// So Plyloft asks for embedded mode by name: the same process shape as
/// before, and no warning (measured, 0.158.0: `-c
/// model_reasoning_effort=medium` shows "⚠ 1 warning"; with `--no-daemon`
/// none). It precedes any subcommand (`codex --no-daemon resume <id>`).
///
/// Only for a Codex whose version is known to have the flag: an older one
/// would refuse the unknown argument and the tile would not start. The
/// version is the one probed at startup (`shell_env`): a Codex updated while
/// Plyloft runs just keeps the warning until the next start; one *downgraded*
/// below 0.158 meanwhile would refuse the flag and the tile would exit with
/// Codex's usage error — restarting Plyloft re-probes. A re-probe on that
/// failure is not cheap here (the spawn itself succeeds; the refusal is the
/// child's exit), so it is documented rather than retried. Collected
/// runs (`codex exec`: reviews, probes) are left exactly as their callers
/// built them.
pub(crate) fn codex_no_daemon(provider: Provider, interactive: bool, version: Option<&str>) -> bool {
    if provider != Provider::Codex || !interactive {
        return false;
    }
    crate::codex_home::version_at_least(version, CODEX_NO_DAEMON_SINCE)
}

/// The whole of [`inject_session`] except the two things it reads from the
/// machine: the sidecar beside the host executable, and the member's Codex
/// home. Both are parameters here so the argv and overlay rules are testable
/// without either — and, in particular, without a test mutating the
/// process-global `CODEX_HOME` while the rest of the suite runs beside it.
fn inject_with_sidecar_and_skills(
    args: Vec<String>,
    context: &KnowledgeMcpContext,
    sidecar: &Path,
    real_codex_home: &Path,
    session_cwd: Option<&Path>,
) -> SessionInjection {
    let mut args = args;
    let mut env = Vec::new();
    let mut codex_home = None;
    let mut library_records = Vec::new();

    match context.provider {
        Provider::Claude => {
            // One `--plugin-dir` per accepted plugin, never the containing
            // folder: the folder form loads every child, which would defeat
            // the refusal of a plugin carrying hooks.
            //
            // Added *before* the sidecar injection, which must keep its
            // variadic `--mcp-config` group last (see `inject_with_sidecar`).
            for dir in &context.team_skills.claude_plugin_dirs {
                args.push("--plugin-dir".into());
                args.push(dir.to_string_lossy().into_owned());
            }
            if !context.team_skills.claude_plugin_dirs.is_empty() {
                library_records.extend(context.team_record.clone());
            }
            // Skills hub H10: My library, the same way (`mine:<skill>`).
            for dir in &context.mine_skills.claude_plugin_dirs {
                args.push("--plugin-dir".into());
                args.push(dir.to_string_lossy().into_owned());
            }
            if !context.mine_skills.claude_plugin_dirs.is_empty() {
                library_records.extend(context.mine_record.clone());
            }
            // GH #106: the `ply` plugin, holding the skills that ship inside the
            // app and are switched on on this Mac. Empty when the bundle is
            // missing or every one of them is off, and then there is no
            // `--plugin-dir` for it at all — "off" is not a plugin with nothing
            // in it, it is no plugin.
            for dir in &context.ply_skills.claude_plugin_dirs {
                args.push("--plugin-dir".into());
                args.push(dir.to_string_lossy().into_owned());
            }
            // GH #82: project skills on the integration branch that the
            // session's own directory (checkout or card worktree) doesn't
            // carry as the branch has them.
            //
            // GH #216 review 1: a read-only run (`--restricted`: the Reviewer,
            // the Challenger, the proposal pass, the probe) gets **every**
            // branch skill instead, and nothing from its own directory —
            // `--restricted` ignores that directory's `.claude/skills`, and it
            // is the card under review: the reviewer follows the rules already
            // on the branch, never ones a Builder added in the card.
            let workspace_dir = context.config_dir.join("projects").join(&context.workspace_id);
            let read_only = args.iter().any(|arg| arg == "--restricted");
            let project = if read_only {
                crate::shared_library_sync::review_plugin_dir(&workspace_dir)
            } else {
                crate::shared_library_sync::session_plugin_dir(
                    &workspace_dir,
                    session_cwd.unwrap_or(&context.project_cwd),
                )
            };
            if let Some(dir) = project {
                args.push("--plugin-dir".into());
                args.push(dir.to_string_lossy().into_owned());
            }
        }
        Provider::Codex => {
            // One overlay, both layers. Codex has no session-scoped flag, so the
            // team library and Ply's own skills cannot each have a `CODEX_HOME`
            // — the second would replace the first. An empty list builds nothing
            // (GH #106), which is how "off → not delivered" holds for Codex too.
            //
            // GH #156: the third layer is the integration branch's
            // `.agents/skills`, the Codex half of what Claude gets as the
            // `project` plugin above — chosen against the directory the session
            // starts in, built now and stamped. `None` when the mirror has no
            // Codex skill this session lacks, and then nothing changes.
            let workspace_dir = context.config_dir.join("projects").join(&context.workspace_id);
            let project = crate::branch_codex_skills::session_marketplace(
                &workspace_dir,
                session_cwd.unwrap_or(&context.project_cwd),
            );
            let marketplaces: Vec<&crate::team_skills::CodexMarketplace> = [
                context.team_skills.codex.as_ref(),
                // Skills hub H10: My library's own marketplace, `plyloft-mine`.
                context.mine_skills.codex.as_ref(),
                context.ply_skills.codex.as_ref(),
                project.as_ref(),
            ]
            .into_iter()
            .flatten()
            .collect();
            if !marketplaces.is_empty() {
                match crate::codex_home::build_all(
                    &crate::codex_home::overlays_root(&context.config_dir),
                    &crate::codex_home::recovered_root(&context.config_dir),
                    real_codex_home,
                    &marketplaces,
                ) {
                    Ok(overlay) => {
                        // One layer refused costs only that layer (GH #106
                        // review 1); the session still gets the others, and the
                        // reason is never swallowed.
                        for refused in overlay.refused() {
                            log::warn!(
                                "skills: the Codex overlay is without `{}` ({})",
                                refused.marketplace,
                                refused.reason
                            );
                        }
                        // The team's skills reached this session only if its
                        // marketplace was not the layer refused.
                        if let Some(team) = context.team_skills.codex.as_ref() {
                            if !overlay.refused().iter().any(|r| r.marketplace == team.name) {
                                library_records.extend(context.team_record.clone());
                            }
                        }
                        if let Some(mine) = context.mine_skills.codex.as_ref() {
                            if !overlay.refused().iter().any(|r| r.marketplace == mine.name) {
                                library_records.extend(context.mine_record.clone());
                            }
                        }
                        env.push((
                            "CODEX_HOME".to_string(),
                            overlay.path().to_string_lossy().into_owned(),
                        ));
                        codex_home = Some(overlay);
                    }
                    Err(error) => log::warn!("skills: no Codex overlay ({error})"),
                }
            }
        }
    }

    SessionInjection {
        args: inject_with_sidecar(args, context, sidecar),
        env,
        codex_home,
        library_records,
    }
}

fn inject_with_sidecar(
    args: Vec<String>,
    context: &KnowledgeMcpContext,
    sidecar: &Path,
) -> Vec<String> {
    let mut sidecar_args = vec![
        "--config-dir".to_string(),
        context.config_dir.to_string_lossy().into_owned(),
        "--workspace-id".to_string(),
        context.workspace_id.clone(),
        "--project-cwd".to_string(),
        context.project_cwd.to_string_lossy().into_owned(),
    ];
    if let Some(team_clone_dir) = context.team_clone_dir.as_deref() {
        sidecar_args.push("--team-clone-dir".to_string());
        sidecar_args.push(team_clone_dir.to_string_lossy().into_owned());
    }
    let sidecar_args = sidecar_args;

    match context.provider {
        Provider::Claude => {
            let inline_config = serde_json::json!({
                "mcpServers": {
                    "ply": {
                        "command": sidecar.to_string_lossy(),
                        "args": sidecar_args,
                    }
                }
            })
            .to_string();
            let mut injected = args;
            // Claude's --mcp-config consumes a variadic group. Keeping this
            // pair last prevents following provider arguments from being
            // interpreted as additional config inputs.
            injected.push("--mcp-config".into());
            injected.push(inline_config);
            injected
        }
        Provider::Codex => {
            // JSON strings/arrays are valid TOML values and preserve all
            // path characters without writing a config file.
            let command_value = serde_json::to_string(&sidecar.to_string_lossy())
                .expect("serializing a path string cannot fail");
            let args_value =
                serde_json::to_string(&sidecar_args).expect("serializing string args cannot fail");
            let mut injected = vec![
                "-c".into(),
                format!("mcp_servers.ply.command={command_value}"),
                "-c".into(),
                format!("mcp_servers.ply.args={args_value}"),
            ];
            // Codex global -c options must precede `exec` or the interactive
            // subcommand, so prepend without modifying the caller's argv.
            injected.extend(args);
            injected
        }
    }
}

fn canonical_directory(label: &str, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be absolute: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("{label} is missing: {}", path.display()));
    }
    crate::platform::canonicalize(path).map_err(|error| format!("canonicalize {label}: {error}"))
}

fn sidecar_path_from_host(host_executable: &Path) -> Result<PathBuf, String> {
    let directory = host_executable.parent().ok_or_else(|| {
        format!(
            "Plyloft executable has no parent: {}",
            host_executable.display()
        )
    })?;
    Ok(directory.join(SIDECAR_NAME))
}

fn validate_sidecar(path: &Path, timeout: Duration) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "bundled Knowledge server is missing: {}",
            path.display()
        ));
    }

    let mut child = crate::platform::new_command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("start bundled Knowledge server {}: {error}", path.display()))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().map_err(|error| {
                    format!(
                        "read bundled Knowledge server version {}: {error}",
                        path.display()
                    )
                })?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!(
                        "bundled Knowledge server version check failed ({}): {}",
                        output.status,
                        stderr.trim()
                    ));
                }
                let stdout = String::from_utf8_lossy(&output.stdout);
                return validate_version_output(&stdout);
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "bundled Knowledge server version check timed out after {} ms",
                    timeout.as_millis()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "poll bundled Knowledge server version {}: {error}",
                    path.display()
                ));
            }
        }
    }
}

fn validate_version_output(output: &str) -> Result<(), String> {
    let fields: Vec<_> = output.split_whitespace().collect();
    if fields.len() == 4
        && fields[0] == "ply-mcp"
        && fields[2] == "protocol"
        && fields[3] == SIDECAR_PROTOCOL_VERSION
    {
        return Ok(());
    }

    Err(format!(
        "incompatible bundled Knowledge server; expected `ply-mcp <version> protocol {SIDECAR_PROTOCOL_VERSION}`, got `{}`",
        output.trim()
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn executable_script(contents: &str) -> (TempDir, PathBuf) {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("ply-mcp");
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        (directory, path)
    }

    /// Exec `path` once and wait for it to exit, with no deadline of any kind,
    /// so the probe under test is not that file's **first** exec.
    ///
    /// Why (GH #147, fourth of the #90/#98/#130/#145 family): macOS assesses a
    /// freshly written executable on its first exec, after `spawn` has already
    /// returned, and those assessments queue behind every other test's fresh
    /// stub — #90 measured ~280 ms alone and ~10.5 s with 40 at once. A probe
    /// bounded by `SIDECAR_VERSION_TIMEOUT` that is also the first exec is
    /// therefore a bet on machine load: 3 of 14 concurrent full suites lost that
    /// bet on 2026-09-22 while the same test passed alone in 0.91 s.
    ///
    /// Waiting for the exit is what makes it a pre-warm rather than a second
    /// race: by the time the probe spawns the same file again the assessment is
    /// done and cached, so the probe measures what the test is about. A loaded
    /// machine only makes this call slower, never the assertion red — and it
    /// borrows no clock, so there is nothing here to expire.
    ///
    /// Production code is untouched: `SIDECAR_VERSION_TIMEOUT` stays as shipped,
    /// because a real bundled sidecar is assessed once at install, not by Ply.
    fn prewarm(path: &Path) {
        let output = crate::platform::new_command(path)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .unwrap_or_else(|error| {
                panic!(
                    "test setup failure: pre-warm exec of {} failed: {error}",
                    path.display()
                )
            });
        assert!(
            output.status.success(),
            "test setup failure: pre-warm exec of {} exited {}: {}",
            path.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    #[test]
    fn sidecar_is_a_sibling_of_the_host_executable() {
        let host = Path::new("/Applications/Ply.app/Contents/MacOS/Ply");
        assert_eq!(
            sidecar_path_from_host(host).unwrap(),
            Path::new("/Applications/Ply.app/Contents/MacOS/ply-mcp")
        );
    }

    #[test]
    fn protocol_marker_is_strict() {
        assert!(validate_version_output("ply-mcp 0.1.0 protocol 2\n").is_ok());
        assert!(validate_version_output("ply-mcp 0.1.0 protocol 1\n").is_err());
        assert!(validate_version_output("ply-mcp 0.1.0\n").is_err());
        assert!(validate_version_output("other 0.1.0 protocol 2\n").is_err());
    }

    #[test]
    fn executable_protocol_probe_accepts_a_compatible_sidecar() {
        let (_directory, path) =
            executable_script("#!/bin/sh\nprintf 'ply-mcp 0.1.0 protocol 2\\n'\n");
        // The probe proves the version handshake is accepted, not that a brand
        // new file execs inside 10 s (GH #147). See `prewarm`.
        prewarm(&path);
        validate_sidecar(&path, SIDECAR_VERSION_TIMEOUT).unwrap();
    }

    /// Deliberately **not** pre-warmed: its stub never exits, so there is
    /// nothing to wait for, and a slow first exec can only leave the child
    /// running when the 20 ms deadline passes — which is exactly what this test
    /// asserts. Load cannot turn this one red, so it has not got #147's defect.
    #[test]
    fn executable_protocol_probe_times_out_and_kills_the_child() {
        let (_directory, path) = executable_script("#!/bin/sh\nwhile :; do :; done\n");
        let error = validate_sidecar(&path, Duration::from_millis(20)).unwrap_err();
        assert!(error.contains("timed out"), "{error}");
    }

    fn context(provider: Provider) -> (TempDir, KnowledgeMcpContext) {
        context_with_team(provider, None).0
    }

    /// A context whose team clone carries `plugins` Claude plugins.
    fn context_with_team(
        provider: Provider,
        plugins: Option<&[&str]>,
    ) -> ((TempDir, KnowledgeMcpContext), Vec<PathBuf>) {
        let directory = TempDir::new().unwrap();
        let config_dir = directory.path().join("config");
        let project_cwd = directory.path().join("project");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&project_cwd).unwrap();

        let mut expected = Vec::new();
        let team_clone = plugins.map(|names| {
            let clone = directory.path().join("team");
            for name in names {
                let plugin = crate::team_skills::claude_library_dir(&clone).join(name);
                fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
                fs::write(
                    plugin.join(".claude-plugin").join("plugin.json"),
                    format!(r#"{{"name":"{name}"}}"#),
                )
                .unwrap();
            }
            let clone = commit_team(clone);
            // Skills hub H1: a session gets each plugin's snapshot, named by
            // its tree id under the (canonical) config directory — never a
            // directory in the clone.
            let root = crate::library_snapshot::sessions_root(
                &crate::platform::canonicalize(&config_dir).unwrap(),
            )
            .join(crate::library_snapshot::library_key(&clone))
            .join("claude");
            for name in names {
                let tree = git_out(&clone, &["rev-parse", &format!("HEAD:library/claude/{name}")]);
                expected.push(root.join(&tree[..16]));
            }
            clone
        });
        expected.sort();

        let context = KnowledgeMcpContext::from_paths(
            provider,
            config_dir,
            "workspace-1",
            project_cwd,
            team_clone,
        )
        .unwrap();
        ((directory, context), expected)
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = crate::platform::git_command()
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Skills hub H1: a team library reaches a session from a commit, so a
    /// test clone is a repository with its files committed.
    fn commit_team(clone: PathBuf) -> PathBuf {
        fs::create_dir_all(&clone).unwrap();
        git_out(&clone, &["init", "-q", "-b", "main"]);
        git_out(&clone, &["add", "-A"]);
        git_out(&clone, &["commit", "-q", "--allow-empty", "-m", "library"]);
        clone
    }

    /// Skills hub H1 (§12 tests): every `KnowledgeMcpContext::new` caller gets
    /// snapshot paths, never a clone path — the one launch constructor reads
    /// the team library only through `library_snapshot::deliver`.
    #[test]
    fn the_launch_context_reads_the_team_library_only_through_snapshots() {
        let source = include_str!("mcp_launch.rs");
        let start = source.find("    fn from_paths(").unwrap();
        // Up to the doc comment of the next method (a string with no brace,
        // so the repository's brace-tracking checks read this file right).
        let end = source[start..].find("GH #106: the built Ply-skills library").unwrap() + start;
        let body = &source[start..end];
        assert!(body.contains("crate::library_snapshot::deliver("));
        assert!(!body.contains(&["read_", "library("].concat()), "no live read of the clone");
        let new_start = source.find("    pub(crate) fn new<R: tauri::Runtime>(").unwrap();
        let new_body = &source[new_start..start];
        assert!(new_body.contains("Self::from_paths("));

        let ((_directory, context), expected) =
            context_with_team(Provider::Claude, Some(&["ply-team"]));
        let sessions = crate::library_snapshot::sessions_root(&context.config_dir);
        assert!(!expected.is_empty());
        for dir in &context.team_skills.claude_plugin_dirs {
            assert!(dir.starts_with(&sessions), "{dir:?} is a snapshot");
            assert!(!dir.starts_with(context.team_clone_dir.as_ref().unwrap()));
        }
        assert!(context.team_record.is_some());
    }

    fn injected_args(args: Vec<String>, context: &KnowledgeMcpContext) -> Vec<String> {
        inject_with_sidecar_and_skills(
            args,
            context,
            Path::new("/Applications/Ply MCP"),
            Path::new("/nonexistent/codex-home"),
            None,
        )
        .args
    }

    /// The read-only Challenger and the capability probe hand their
    /// restriction argv to the same launch path as everything else. Team
    /// skills are additive, so every one of those arguments must reach the
    /// child untouched and in order — this is the argument that they do.
    #[test]
    fn team_skills_never_disturb_the_restriction_argv() {
        let ((_directory, context), _) =
            context_with_team(Provider::Claude, Some(&["ply-team", "second"]));
        let restriction: Vec<String> = crate::read_only_provider::read_only_argv(
            ply_collab::Provider::Claude,
            "review this",
            Path::new("/tmp/isolated"),
            &crate::settings::ModelChoice::default(),
        );

        let injected = injected_args(restriction.clone(), &context);

        // Every restriction argument survives, in its original order, at the
        // front of the argv.
        assert_eq!(&injected[..restriction.len()], &restriction[..]);
        // Nothing was removed or rewritten anywhere.
        for argument in &restriction {
            assert_eq!(
                injected.iter().filter(|a| *a == argument).count(),
                restriction.iter().filter(|a| *a == argument).count(),
                "restriction argument {argument} was duplicated or dropped"
            );
        }
    }

    /// One `--plugin-dir` per accepted plugin, and the variadic
    /// `--mcp-config` group still last.
    #[test]
    fn claude_gets_one_plugin_dir_per_plugin_before_the_mcp_config() {
        let ((_directory, context), expected) =
            context_with_team(Provider::Claude, Some(&["ply-team", "second"]));
        let injected = injected_args(vec!["-p".into()], &context);

        let dirs: Vec<PathBuf> = injected
            .windows(2)
            .filter(|pair| pair[0] == "--plugin-dir")
            .map(|pair| PathBuf::from(&pair[1]))
            .collect();
        assert_eq!(dirs, expected);

        // `--mcp-config` consumes a variadic group, so its pair stays last.
        assert_eq!(injected[injected.len() - 2], "--mcp-config");
        // And Claude takes its skills in argv, never through the environment.
        assert!(inject_with_sidecar_and_skills(
            vec!["-p".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
            Path::new("/nonexistent/codex-home"),
            None,
        )
        .env
        .is_empty());
    }

    /// GH #82: project skills on the integration branch the checkout lacks
    /// reach Claude as the `project` plugin, after the team's.
    #[test]
    fn claude_gets_the_shared_project_skills_plugin_when_there_is_one() {
        let ((_directory, context), mut expected) =
            context_with_team(Provider::Claude, Some(&["ply-team"]));
        let none = injected_args(vec!["-p".into()], &context);
        assert_eq!(none.iter().filter(|a| *a == "--plugin-dir").count(), 1);

        let workspace_dir = context.config_dir.join("projects").join("workspace-1");
        // A built mirror standing in for this session's checkout.
        let mirror = workspace_dir.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
        fs::create_dir_all(&mirror).unwrap();
        fs::write(
            mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST),
            serde_json::json!({
                "schemaVersion": 1,
                "cwd": context.project_cwd,
                "branch": "main",
            })
            .to_string(),
        )
        .unwrap();
        // A branch skill the session's directory doesn't have.
        let skill = mirror.join(".claude/skills/deploy");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "---\nname: deploy\ndescription: d\n---\n").unwrap();
        let plugin = crate::shared_library_sync::session_plugin_dir(&workspace_dir, &context.project_cwd)
            .expect("the plugin, built at launch");
        assert!(plugin.join("skills/deploy/SKILL.md").is_file());
        expected.push(plugin);
        let injected = injected_args(vec!["-p".into()], &context);
        let dirs: Vec<PathBuf> = injected
            .windows(2)
            .filter(|pair| pair[0] == "--plugin-dir")
            .map(|pair| PathBuf::from(&pair[1]))
            .collect();
        assert_eq!(dirs, expected);
        assert_eq!(injected[injected.len() - 2], "--mcp-config");
    }

    /// GH #82 review: a Builder's context names the workspace checkout, but
    /// Claude starts in the card's worktree. Skills are chosen against the
    /// directory the session starts in, for every launcher (the PTY passes it).
    #[test]
    fn project_skills_are_chosen_against_the_directory_the_session_starts_in() {
        let ((directory, context), _) = context_with_team(Provider::Claude, None);
        let workspace_dir = context.config_dir.join("projects").join("workspace-1");
        let mirror = workspace_dir.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
        let skill = "---\nname: deploy\ndescription: d\n---\nv2\n";
        fs::create_dir_all(mirror.join(".claude/skills/deploy")).unwrap();
        fs::write(mirror.join(".claude/skills/deploy/SKILL.md"), skill).unwrap();
        fs::write(
            mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST),
            serde_json::json!({ "schemaVersion": 1, "cwd": context.project_cwd, "branch": "main" })
                .to_string(),
        )
        .unwrap();
        // The checkout carries the branch's version; the card worktree doesn't.
        fs::create_dir_all(context.project_cwd.join(".claude/skills/deploy")).unwrap();
        fs::write(context.project_cwd.join(".claude/skills/deploy/SKILL.md"), skill).unwrap();
        let worktree = directory.path().join("card-worktree");
        fs::create_dir_all(&worktree).unwrap();

        let plugin_dirs = |session: Option<&Path>| -> usize {
            inject_with_sidecar_and_skills(
                vec!["-p".into()],
                &context,
                Path::new("/Applications/Ply MCP"),
                Path::new("/nonexistent/codex-home"),
                session,
            )
            .args
            .iter()
            .filter(|a| *a == "--plugin-dir")
            .count()
        };
        assert_eq!(plugin_dirs(None), 0, "the checkout has it");
        assert_eq!(plugin_dirs(Some(&context.project_cwd)), 0);
        assert_eq!(plugin_dirs(Some(&worktree)), 1, "the Builder's worktree doesn't");

        // Every PTY launch hands the injection the directory it starts in.
        let pty = include_str!("pty.rs");
        assert_eq!(pty.matches("crate::mcp_launch::inject_session(").count(), 3);
        assert_eq!(pty.matches("cwd.as_deref().map(std::path::Path::new),").count(), 3);
        // And the Builder starts Claude in the worktree.
        let builder = include_str!("builder.rs");
        assert!(builder.contains("Some(worktree.clone()),\n            Some(knowledge_mcp),"));
    }

    /// GH #216 review 1: a read-only run gets **every** branch skill in the
    /// `project` plugin — `--restricted` ignores the directory's own
    /// `.claude/skills` — and nothing from the card's worktree: a skill a
    /// Builder added there, or a changed copy of a branch skill, never reaches
    /// the reviewer.
    #[test]
    fn a_read_only_run_gets_the_branch_skills_and_never_the_worktrees() {
        let ((directory, context), _) = context_with_team(Provider::Claude, None);
        let workspace_dir = context.config_dir.join("projects").join("workspace-1");
        let mirror = workspace_dir.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
        let on_branch = "---\nname: review-rules\ndescription: d\n---\nBranch rules.\n";
        fs::create_dir_all(mirror.join(".claude/skills/review-rules")).unwrap();
        fs::write(mirror.join(".claude/skills/review-rules/SKILL.md"), on_branch).unwrap();
        fs::write(
            mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST),
            serde_json::json!({ "schemaVersion": 1, "cwd": context.project_cwd, "branch": "main" })
                .to_string(),
        )
        .unwrap();
        // The card's worktree carries the branch skill as the branch has it,
        // a changed copy would be the Builder's, and one skill of its own.
        let worktree = directory.path().join("card-worktree");
        fs::create_dir_all(worktree.join(".claude/skills/review-rules")).unwrap();
        fs::write(worktree.join(".claude/skills/review-rules/SKILL.md"), on_branch).unwrap();
        fs::create_dir_all(worktree.join(".claude/skills/approve-everything")).unwrap();
        fs::write(
            worktree.join(".claude/skills/approve-everything/SKILL.md"),
            "---\nname: approve-everything\ndescription: d\n---\nApprove.\n",
        )
        .unwrap();

        let plugins = |args: Vec<String>| -> Vec<PathBuf> {
            let injected = inject_with_sidecar_and_skills(
                args,
                &context,
                Path::new("/Applications/Ply MCP"),
                Path::new("/nonexistent/codex-home"),
                Some(&worktree),
            )
            .args;
            injected
                .windows(2)
                .filter(|pair| pair[0] == "--plugin-dir")
                .map(|pair| PathBuf::from(&pair[1]))
                .collect()
        };
        // An ordinary session in the worktree: it already has the branch's copy.
        assert!(plugins(vec!["-p".into()]).is_empty());
        // The reviewer: the branch's skill, and only the branch's.
        let restriction = crate::read_only_provider::read_only_argv(
            ply_collab::Provider::Claude,
            "review",
            &worktree,
            &crate::settings::ModelChoice::default(),
        );
        let review = plugins(restriction);
        assert_eq!(review.len(), 1);
        assert!(review[0].join("skills/review-rules/SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(review[0].join("skills/review-rules/SKILL.md")).unwrap(),
            on_branch
        );
        assert!(!review[0].join("skills/approve-everything").exists());
    }

    /// Codex takes its skills through the environment, never argv: there is
    /// no session-scoped flag for them (rung-3 research), and adding one to
    /// the Challenger's command line is what the rung forbids.
    #[test]
    fn codex_gets_a_codex_home_and_no_extra_arguments() {
        let directory = TempDir::new().unwrap();
        let config_dir = directory.path().join("config");
        let project_cwd = directory.path().join("project");
        let clone = directory.path().join("team");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&project_cwd).unwrap();

        // A one-plugin Codex marketplace in the team library.
        let library = crate::team_skills::codex_library_dir(&clone);
        let manifest = crate::team_skills::codex_marketplace_manifest(&library);
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(
            &manifest,
            r#"{"name":"ply-team","plugins":[{"name":"ply-team"}]}"#,
        )
        .unwrap();
        let plugin = library.join("plugins").join("ply-team");
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::write(
            plugin.join(".codex-plugin").join("plugin.json"),
            r#"{"name":"ply-team","version":"1.0.0"}"#,
        )
        .unwrap();

        // A stand-in for the member's ~/.codex, passed in rather than set in
        // the environment: `set_var` is process-global and the suite runs in
        // parallel.
        let home = directory.path().join("codex-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("auth.json"), "{}").unwrap();

        let context = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            config_dir,
            "workspace-1",
            project_cwd,
            Some(commit_team(clone)),
        )
        .unwrap();
        let baseline = inject_with_sidecar(
            vec!["--sandbox".into(), "read-only".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
        );
        let injection = inject_with_sidecar_and_skills(
            vec!["--sandbox".into(), "read-only".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
            &home,
            None,
        );

        // Argv is exactly what it would have been without team skills.
        assert_eq!(injection.args, baseline);
        let overlay = injection
            .codex_home
            .as_ref()
            .expect("an overlay was built")
            .path();
        assert_eq!(
            injection.env,
            vec![("CODEX_HOME".to_string(), overlay.to_string_lossy().into_owned())]
        );
        // The overlay lives under Ply's app support, not in the member's home.
        assert!(overlay.starts_with(&context.config_dir));
        assert!(overlay.join("config.toml").is_file());
    }

    /// A bundle of Ply's own skills, built into the library a launch delivers.
    fn ply_library(directory: &Path, names: &[&str]) -> crate::team_skills::TeamSkillsLibrary {
        let bundle = directory.join("ply-skills-bundle");
        for name in names {
            let skill = bundle.join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: d\n---\n\n# The {name} skill\n"),
            )
            .unwrap();
        }
        fs::create_dir_all(&bundle).unwrap();
        crate::ply_skills::deliver(&directory.join("ply-builds"), &bundle, &[], true).library
    }

    /// GH #106: the `ply` plugin reaches a Claude session as one more
    /// `--plugin-dir`, and **only** when at least one of the skills is switched
    /// on. Nothing else about the argv moves.
    #[test]
    fn claude_gets_the_ply_plugin_only_when_a_skill_is_switched_on() {
        let ((directory, context), mut expected) =
            context_with_team(Provider::Claude, Some(&["ply-team"]));

        // Every skill switched off — which is what `ply_skills::library` answers
        // with an empty library — is no plugin, not an empty one.
        let none = injected_args(vec!["-p".into()], &context);
        assert_eq!(none.iter().filter(|a| *a == "--plugin-dir").count(), 1);

        let library = ply_library(directory.path(), &["card-brief", "release-notes"]);
        assert_eq!(library.claude_plugin_dirs.len(), 1);
        expected.push(library.claude_plugin_dirs[0].clone());
        let context = context.with_ply_skills(library);

        let injected = injected_args(vec!["-p".into()], &context);
        let dirs: Vec<PathBuf> = injected
            .windows(2)
            .filter(|pair| pair[0] == "--plugin-dir")
            .map(|pair| PathBuf::from(&pair[1]))
            .collect();
        assert_eq!(dirs, expected, "the team's plugin, then Ply's own");
        // The plugin really holds the switched-on skills, so the session lists
        // them as `ply:card-brief` and `ply:release-notes`.
        for name in ["card-brief", "release-notes"] {
            assert!(dirs[1].join(format!("skills/{name}/SKILL.md")).is_file());
        }
        // `--mcp-config` consumes a variadic group, so its pair is still last…
        assert_eq!(injected[injected.len() - 2], "--mcp-config");
        // …and Claude takes its skills in argv, never through the environment.
        assert!(inject_with_sidecar_and_skills(
            vec!["-p".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
            Path::new("/nonexistent/codex-home"),
            None,
        )
        .env
        .is_empty());
    }

    /// GH #106: Codex takes one whole `CODEX_HOME`, so the team library and Ply's
    /// own skills go into **one** overlay — the second marketplace cannot have a
    /// home of its own without replacing the first.
    #[test]
    fn the_codex_overlay_carries_the_team_library_and_plys_own_skills() {
        let directory = TempDir::new().unwrap();
        let config_dir = directory.path().join("config");
        let project_cwd = directory.path().join("project");
        let clone = directory.path().join("team");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&project_cwd).unwrap();

        // A one-plugin Codex marketplace in the team library.
        let team_library = crate::team_skills::codex_library_dir(&clone);
        let manifest = crate::team_skills::codex_marketplace_manifest(&team_library);
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(&manifest, r#"{"name":"ply-team","plugins":[{"name":"ply-team"}]}"#).unwrap();
        let plugin = team_library.join("plugins").join("ply-team");
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::write(
            plugin.join(".codex-plugin").join("plugin.json"),
            r#"{"name":"ply-team","version":"1.0.0"}"#,
        )
        .unwrap();

        // A stand-in for the member's ~/.codex, passed in rather than set in the
        // environment: `set_var` is process-global and the suite runs in parallel.
        let home = directory.path().join("codex-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("auth.json"), "{}").unwrap();

        let context = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            config_dir,
            "workspace-1",
            project_cwd,
            Some(commit_team(clone)),
        )
        .unwrap()
        .with_ply_skills(ply_library(directory.path(), &["card-brief"]));

        let injection = inject_with_sidecar_and_skills(
            vec!["--sandbox".into(), "read-only".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
            &home,
            None,
        );
        let overlay = injection
            .codex_home
            .as_ref()
            .expect("an overlay was built")
            .path()
            .to_path_buf();
        assert_eq!(
            injection.env,
            vec![("CODEX_HOME".to_string(), overlay.to_string_lossy().into_owned())],
            "one CODEX_HOME, not two",
        );

        // Both marketplaces are registered and both plugins are installed.
        let config = fs::read_to_string(overlay.join("config.toml")).unwrap();
        let parsed: toml::Table = toml::from_str(&config).unwrap();
        let marketplaces = parsed["marketplaces"].as_table().unwrap();
        assert!(marketplaces.contains_key("ply-team"), "{config}");
        // `ply-app` is the marketplace; `ply` is the plugin inside it, which is
        // where the `ply:<name>` a session shows comes from (review 1).
        assert!(marketplaces.contains_key("ply-app"), "{config}");
        let plugins = parsed["plugins"].as_table().unwrap();
        assert_eq!(plugins["ply-team@ply-team"]["enabled"].as_bool(), Some(true));
        assert_eq!(plugins["ply@ply-app"]["enabled"].as_bool(), Some(true));
        let cache = overlay.join("plugins").join("cache");
        assert!(cache.join("ply-team/ply-team/1.0.0/.codex-plugin/plugin.json").is_file());
        assert!(cache.join("ply-app/ply/1.0.0/skills/card-brief/SKILL.md").is_file());
        // Nothing was refused: the ordinary case carries both layers whole.
        assert!(
            injection.codex_home.as_ref().unwrap().refused().is_empty(),
            "{:?}",
            injection.codex_home.as_ref().unwrap().refused(),
        );

        // The member's own home is untouched: auth is a symlink into it, and no
        // Ply file was written there.
        // (A hard link on Windows: `codex_home::LinkStyle::Windows`.)
        assert!(
            cfg!(windows) || fs::symlink_metadata(overlay.join("auth.json")).unwrap().file_type().is_symlink()
        );
        let mut left: Vec<String> = fs::read_dir(&home)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["auth.json", "logs", "sessions", "shell_snapshots"]);

        // And Ply's own skills alone are enough for an overlay: a Mac with no
        // team library still gets them.
        let alone = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            context.config_dir.clone(),
            "workspace-1",
            context.project_cwd.clone(),
            None,
        )
        .unwrap()
        .with_ply_skills(ply_library(directory.path(), &["card-brief"]));
        let injection = inject_with_sidecar_and_skills(
            vec!["--sandbox".into(), "read-only".into()],
            &alone,
            Path::new("/Applications/Ply MCP"),
            &home,
            None,
        );
        assert!(injection.codex_home.is_some());
        assert_eq!(injection.env.len(), 1);

        // Every skill switched off: no marketplace, so no overlay and no
        // environment at all — the session launches on the member's own home.
        let off = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            context.config_dir.clone(),
            "workspace-1",
            context.project_cwd.clone(),
            None,
        )
        .unwrap();
        let injection = inject_with_sidecar_and_skills(
            vec!["--sandbox".into(), "read-only".into()],
            &off,
            Path::new("/Applications/Ply MCP"),
            &home,
            None,
        );
        assert!(injection.codex_home.is_none());
        assert!(injection.env.is_empty());
    }

    /// GH #156: a Codex context with a team library, Ply's own skills and a
    /// mirror whose `.agents/skills` holds `codex`. Returns the context and a
    /// stand-in for the member's `~/.codex`.
    fn codex_context_with_branch(
        directory: &Path,
        codex: &[&str],
    ) -> (KnowledgeMcpContext, PathBuf) {
        let config_dir = directory.join("config");
        let project_cwd = directory.join("project");
        let clone = directory.join("team");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&project_cwd).unwrap();
        let team_library = crate::team_skills::codex_library_dir(&clone);
        let manifest = crate::team_skills::codex_marketplace_manifest(&team_library);
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(&manifest, r#"{"name":"ply-team","plugins":[{"name":"ply-team"}]}"#).unwrap();
        let plugin = team_library.join("plugins").join("ply-team");
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::write(
            plugin.join(".codex-plugin").join("plugin.json"),
            r#"{"name":"ply-team","version":"1.0.0"}"#,
        )
        .unwrap();
        let home = directory.join("codex-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("auth.json"), "{}").unwrap();

        let context = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            config_dir,
            "workspace-1",
            project_cwd,
            Some(commit_team(clone)),
        )
        .unwrap()
        .with_ply_skills(ply_library(directory, &["card-brief"]));

        let mirror = context
            .config_dir
            .join("projects")
            .join("workspace-1")
            .join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
        fs::create_dir_all(&mirror).unwrap();
        fs::write(
            mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST),
            serde_json::json!({ "schemaVersion": 2, "cwd": context.project_cwd, "branch": "staging" })
                .to_string(),
        )
        .unwrap();
        // A Claude copy on the branch is Claude's business, never Codex's.
        fs::create_dir_all(mirror.join(".claude/skills/claude-only")).unwrap();
        fs::write(
            mirror.join(".claude/skills/claude-only/SKILL.md"),
            "---\ndescription: c\n---\n",
        )
        .unwrap();
        for name in codex {
            let skill = mirror.join(".agents/skills").join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), format!("---\nname: {name}\ndescription: d\n---\n"))
                .unwrap();
        }
        (context, home)
    }

    fn codex_launch(context: &KnowledgeMcpContext, home: &Path) -> SessionInjection {
        inject_with_sidecar_and_skills(
            vec!["--sandbox".into(), "read-only".into()],
            context,
            Path::new("/Applications/Ply MCP"),
            home,
            None,
        )
    }

    fn overlay_marketplaces(injection: &SessionInjection) -> Vec<String> {
        let overlay = injection.codex_home.as_ref().expect("an overlay").path();
        let config = fs::read_to_string(overlay.join("config.toml")).unwrap();
        let parsed: toml::Table = toml::from_str(&config).unwrap();
        let mut names: Vec<String> =
            parsed["marketplaces"].as_table().unwrap().keys().cloned().collect();
        names.sort();
        names
    }

    /// GH #156: the branch's Codex copies are the overlay's third marketplace —
    /// `ply-project`, plugin `project` — beside the team's and Ply's own, in the
    /// same one `CODEX_HOME`, and the argv is exactly what it was.
    #[test]
    fn the_codex_overlay_carries_the_branchs_codex_skills_as_a_third_marketplace() {
        let directory = TempDir::new().unwrap();
        let (context, home) = codex_context_with_branch(directory.path(), &["deploy", "lint"]);
        let baseline = inject_with_sidecar(
            vec!["--sandbox".into(), "read-only".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
        );
        let injection = codex_launch(&context, &home);

        assert_eq!(injection.args, baseline, "argv untouched");
        let overlay = injection.codex_home.as_ref().unwrap().path().to_path_buf();
        assert_eq!(
            injection.env,
            vec![("CODEX_HOME".to_string(), overlay.to_string_lossy().into_owned())],
            "still one CODEX_HOME",
        );
        assert_eq!(overlay_marketplaces(&injection), vec!["ply-app", "ply-project", "ply-team"]);
        let config: toml::Table =
            toml::from_str(&fs::read_to_string(overlay.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["plugins"]["project@ply-project"]["enabled"].as_bool(), Some(true));
        let skills = overlay.join("plugins/cache/ply-project/project/1.0.0/skills");
        let mut delivered: Vec<String> = fs::read_dir(&skills)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        delivered.sort();
        assert_eq!(delivered, vec!["deploy", "lint"], "exactly the branch's Codex copies");
        assert!(injection.codex_home.as_ref().unwrap().refused().is_empty());
        // The session's own directory already carrying a copy as the branch has
        // it is not handed a second one.
        let local = context.project_cwd.join(".agents/skills/lint");
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("SKILL.md"), "---\nname: lint\ndescription: d\n---\n").unwrap();
        let again = codex_launch(&context, &home);
        let skills = again
            .codex_home
            .as_ref()
            .unwrap()
            .path()
            .join("plugins/cache/ply-project/project/1.0.0/skills");
        assert!(skills.join("deploy").is_dir());
        assert!(!skills.join("lint").exists());
    }

    /// GH #156: a mirror with no Codex skill adds nothing — the overlay is the
    /// two layers it was, argv and environment are what they were, and no build
    /// is made. With neither other layer there is no overlay at all.
    #[test]
    fn a_mirror_without_codex_skills_changes_nothing_about_a_codex_launch() {
        let directory = TempDir::new().unwrap();
        let (context, home) = codex_context_with_branch(directory.path(), &[]);
        let baseline = inject_with_sidecar(
            vec!["--sandbox".into(), "read-only".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
        );
        let injection = codex_launch(&context, &home);
        assert_eq!(injection.args, baseline);
        assert_eq!(injection.env.len(), 1);
        assert_eq!(overlay_marketplaces(&injection), vec!["ply-app", "ply-team"]);
        let builds = context
            .config_dir
            .join("projects/workspace-1")
            .join(crate::branch_codex_skills::BUILDS_DIR);
        assert!(!builds.exists(), "no build for an empty layer");

        // No team library, no Ply skills, no Codex copy on the branch: the
        // session launches on the member's own home.
        let bare = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            context.config_dir.clone(),
            "workspace-1",
            context.project_cwd.clone(),
            None,
        )
        .unwrap();
        let injection = codex_launch(&bare, &home);
        assert!(injection.codex_home.is_none());
        assert!(injection.env.is_empty());
        assert_eq!(
            injection.args,
            inject_with_sidecar(
                vec!["--sandbox".into(), "read-only".into()],
                &bare,
                Path::new("/Applications/Ply MCP"),
            ),
        );

        // …and the branch's Codex copies alone are enough for one.
        let skill = context
            .config_dir
            .join("projects/workspace-1")
            .join(ply_memory::SHARED_LIBRARY_MIRROR_DIR)
            .join(".agents/skills/deploy");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "---\ndescription: d\n---\n").unwrap();
        let injection = codex_launch(&bare, &home);
        assert_eq!(overlay_marketplaces(&injection), vec!["ply-project"]);
    }

    /// GH #156: a member with a `ply-project` of their own costs only this
    /// layer — the team library and Ply's own skills are still delivered, the
    /// member's entry is untouched, and the refusal is recorded.
    #[test]
    fn a_collision_on_ply_project_costs_only_the_branch_layer() {
        let directory = TempDir::new().unwrap();
        let (context, home) = codex_context_with_branch(directory.path(), &["deploy"]);
        fs::write(
            home.join("config.toml"),
            "[marketplaces.ply-project]\nsource_type = \"local\"\nsource = \"/mine\"\n",
        )
        .unwrap();
        let injection = codex_launch(&context, &home);
        let overlay = injection.codex_home.as_ref().expect("the other layers still arrive");
        assert_eq!(overlay_marketplaces(&injection), vec!["ply-app", "ply-project", "ply-team"]);
        let config: toml::Table =
            toml::from_str(&fs::read_to_string(overlay.path().join("config.toml")).unwrap())
                .unwrap();
        assert_eq!(config["marketplaces"]["ply-project"]["source"].as_str(), Some("/mine"));
        let plugins = config["plugins"].as_table().unwrap();
        assert!(!plugins.contains_key("project@ply-project"));
        assert_eq!(plugins["ply-team@ply-team"]["enabled"].as_bool(), Some(true));
        assert_eq!(plugins["ply@ply-app"]["enabled"].as_bool(), Some(true));
        assert!(!overlay.path().join("plugins/cache/ply-project").exists());
        let refused = overlay.refused();
        assert_eq!(refused.len(), 1, "{refused:?}");
        assert_eq!(refused[0].marketplace, "ply-project");
        // The member's own config is exactly what they wrote.
        assert_eq!(
            fs::read_to_string(home.join("config.toml")).unwrap(),
            "[marketplaces.ply-project]\nsource_type = \"local\"\nsource = \"/mine\"\n",
        );
    }

    /// A team clone with no skill library adds nothing at all.
    #[test]
    fn an_empty_team_library_adds_no_arguments() {
        let ((_directory, context), _) = context_with_team(Provider::Claude, Some(&[]));
        let injected = injected_args(vec!["-p".into()], &context);
        assert!(!injected.iter().any(|a| a == "--plugin-dir"));
    }

    /// 2026-09-30: an interactive Codex asks for embedded mode by name, so it
    /// neither starts Codex's shared background server nor warns about the
    /// `-c` overrides that keep it out; nothing else gets the flag.
    #[test]
    fn only_an_interactive_codex_that_knows_the_flag_gets_no_daemon() {
        assert!(codex_no_daemon(Provider::Codex, true, Some("0.158.0")));
        assert!(codex_no_daemon(Provider::Codex, true, Some("0.159.2")));
        assert!(codex_no_daemon(Provider::Codex, true, Some("1.0.0")));
        assert!(!codex_no_daemon(Provider::Codex, true, Some("0.157.0")), "an older Codex refuses it");
        assert!(!codex_no_daemon(Provider::Codex, true, None), "unknown version: leave argv alone");
        assert!(!codex_no_daemon(Provider::Codex, false, Some("0.159.2")), "codex exec runs untouched");
        assert!(!codex_no_daemon(Provider::Claude, true, Some("0.159.2")));
        // Only the spawn that collects output is non-interactive.
        let pty = include_str!("pty.rs");
        assert_eq!(pty.matches("            true,\n        )?;").count(), 2, "tiles and the Builder terminal");
        assert_eq!(pty.matches("            false,\n        )?;").count(), 1, "spawn_collect");
    }

    #[test]
    fn shell_args_are_unchanged_without_typed_context() {
        let args = vec!["-l".to_string()];
        let injection = inject_session(args.clone(), None, None, true).unwrap();
        assert_eq!(injection.args, args);
        assert!(injection.env.is_empty());
        assert!(injection.codex_home.is_none());
    }

    #[test]
    fn claude_injection_is_inline_additive_and_final() {
        let (_directory, context) = context(Provider::Claude);
        let original = vec!["-p".into(), "inspect".into(), "--verbose".into()];
        let injected = inject_with_sidecar(
            original.clone(),
            &context,
            Path::new("/Applications/Ply MCP"),
        );
        assert_eq!(&injected[..original.len()], original.as_slice());
        assert_eq!(injected[injected.len() - 2], "--mcp-config");

        let config: serde_json::Value = serde_json::from_str(injected.last().unwrap()).unwrap();
        let server = &config["mcpServers"]["ply"];
        assert_eq!(server["command"], "/Applications/Ply MCP");
        assert_eq!(server["args"][0], "--config-dir");
        assert_eq!(server["args"][2], "--workspace-id");
        assert_eq!(server["args"][3], "workspace-1");
        assert_eq!(server["args"][4], "--project-cwd");
        assert!(!injected.iter().any(|arg| arg == "--strict-mcp-config"));
    }

    #[test]
    fn codex_injection_precedes_subcommand_and_preserves_original_args() {
        let (_directory, context) = context(Provider::Codex);
        let original = vec!["exec".into(), "--json".into(), "inspect".into()];
        let injected = inject_with_sidecar(
            original.clone(),
            &context,
            Path::new("/Applications/Ply MCP"),
        );

        assert_eq!(injected[0], "-c");
        assert_eq!(injected[2], "-c");
        assert_eq!(&injected[4..], original.as_slice());
        let command_value = injected[1]
            .strip_prefix("mcp_servers.ply.command=")
            .unwrap();
        let command: String = serde_json::from_str(command_value).unwrap();
        assert_eq!(command, "/Applications/Ply MCP");
        let args_value = injected[3].strip_prefix("mcp_servers.ply.args=").unwrap();
        let sidecar_args: Vec<String> = serde_json::from_str(args_value).unwrap();
        assert_eq!(sidecar_args[0], "--config-dir");
        assert_eq!(sidecar_args[2], "--workspace-id");
        assert_eq!(sidecar_args[3], "workspace-1");
        assert_eq!(sidecar_args[4], "--project-cwd");
        assert!(!injected.iter().any(|arg| arg == "--ignore-user-config"));
    }

    #[test]
    fn context_rejects_traversal_and_non_absolute_paths() {
        let directory = TempDir::new().unwrap();
        let config_dir = directory.path().join("config");
        let project_cwd = directory.path().join("project");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&project_cwd).unwrap();

        let traversal = KnowledgeMcpContext::from_paths(
            Provider::Claude,
            &config_dir,
            "../other",
            &project_cwd,
            None,
        )
        .unwrap_err();
        assert!(traversal.contains("workspaceId"), "{traversal}");

        let relative = KnowledgeMcpContext::from_paths(
            Provider::Claude,
            Path::new("config"),
            "workspace-1",
            &project_cwd,
            None,
        )
        .unwrap_err();
        assert!(relative.contains("must be absolute"), "{relative}");
    }

    #[test]
    fn a_team_clone_adds_one_sidecar_argument_and_a_missing_one_adds_none() {
        let directory = TempDir::new().unwrap();
        let config_dir = directory.path().join("config");
        let project_cwd = directory.path().join("project");
        let team_clone = directory.path().join("team");
        for dir in [&config_dir, &project_cwd, &team_clone] {
            fs::create_dir_all(dir).unwrap();
        }
        let sidecar = Path::new("/tmp/ply-mcp");

        let with_team = KnowledgeMcpContext::from_paths(
            Provider::Claude,
            &config_dir,
            "workspace-1",
            &project_cwd,
            Some(team_clone.clone()),
        )
        .unwrap();
        let injected = inject_with_sidecar(Vec::new(), &with_team, sidecar);
        let config: serde_json::Value = serde_json::from_str(&injected[1]).unwrap();
        let args = config["mcpServers"]["ply"]["args"].as_array().unwrap();
        assert_eq!(args[6], "--team-clone-dir");
        assert_eq!(
            args[7].as_str().unwrap(),
            crate::platform::canonicalize(&team_clone).unwrap().to_string_lossy()
        );

        // A team clone that is not on this Mac is dropped, never fatal.
        let absent = KnowledgeMcpContext::from_paths(
            Provider::Claude,
            &config_dir,
            "workspace-1",
            &project_cwd,
            Some(directory.path().join("never-cloned")),
        )
        .unwrap();
        let injected = inject_with_sidecar(Vec::new(), &absent, sidecar);
        let config: serde_json::Value = serde_json::from_str(&injected[1]).unwrap();
        assert_eq!(
            config["mcpServers"]["ply"]["args"].as_array().unwrap().len(),
            6
        );
    }

    /// Skills hub H10 (R6): My library reaches a Claude session as one more
    /// `--plugin-dir` (the plugin `mine`, from a snapshot) and a Codex
    /// session as the `plyloft-mine` marketplace in the one overlay; both
    /// launches record it for "Skill updated after this session started".
    /// Beside a team plugin named `mine`, it is delivered as `mine-<login>`.
    fn my_library_clone(root: &Path) -> PathBuf {
        let clone = root.join("config").join(crate::my_library::CLONES_DIR).join("matteo__plyloft-skills");
        fs::create_dir_all(&clone).unwrap();
        crate::my_library::ensure_layout(&clone).unwrap();
        for path in crate::my_library::skill_paths("my-review") {
            let dir = clone.join(path);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), "---\nname: my-review\ndescription: Mine.\n---\nMine.\n").unwrap();
        }
        commit_team(clone)
    }

    #[test]
    fn my_library_reaches_claude_and_codex_sessions_as_mine() {
        let ((directory, context), team_dirs) = context_with_team(Provider::Claude, Some(&["ply-team"]));
        let clone = my_library_clone(directory.path());
        let context = context.with_my_library(&clone, "matteo/plyloft-skills");
        assert_eq!(context.mine_skills.claude_plugins[0].0, crate::my_library::PLUGIN);
        let injection = inject_with_sidecar_and_skills(
            vec!["-p".into()],
            &context,
            Path::new("/Applications/Ply MCP"),
            Path::new("/nonexistent/codex-home"),
            None,
        );
        let dirs: Vec<PathBuf> = injection
            .args
            .windows(2)
            .filter(|pair| pair[0] == "--plugin-dir")
            .map(|pair| PathBuf::from(&pair[1]))
            .collect();
        assert_eq!(dirs.len(), team_dirs.len() + 1);
        let mine = &context.mine_skills.claude_plugin_dirs[0];
        assert!(dirs.contains(mine));
        assert!(mine.starts_with(crate::library_snapshot::sessions_root(&context.config_dir)));
        assert!(!mine.starts_with(&clone), "a snapshot, never the clone");
        assert_eq!(injection.library_records.len(), 2, "the team's and My library's");
        assert_eq!(injection.args[injection.args.len() - 2], "--mcp-config");

        // Codex: one overlay, My library's marketplace in it.
        let codex = KnowledgeMcpContext::from_paths(
            Provider::Codex,
            directory.path().join("config"),
            "workspace-1",
            directory.path().join("project"),
            None,
        )
        .unwrap()
        .with_my_library(&clone, "matteo/plyloft-skills");
        let home = directory.path().join("codex-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("auth.json"), "{}").unwrap();
        let injection = codex_launch(&codex, &home);
        assert_eq!(overlay_marketplaces(&injection), vec![crate::my_library::MARKETPLACE.to_string()]);
        assert_eq!(injection.library_records.len(), 1);
    }

    #[test]
    fn beside_a_team_plugin_named_mine_my_library_is_mine_and_the_login() {
        let ((directory, context), _) = context_with_team(Provider::Claude, Some(&["mine"]));
        let clone = my_library_clone(directory.path());
        let context = context.with_my_library(&clone, "matteo/plyloft-skills");
        assert_eq!(context.team_skills.claude_plugins[0].0, "mine", "the team keeps its name");
        assert_eq!(context.mine_skills.claude_plugins[0].0, "mine-matteo");
        assert!(context.mine_skills.skills.iter().any(|s| s.name == "my-review" && s.plugin == "mine-matteo"));
    }
}
