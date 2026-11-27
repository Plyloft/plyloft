//! 1.173.0 (D1): where a project goes live, read only.
//!
//! Two sources, each optional and never an error when absent:
//!
//!  - **Railway.** When the `railway` program is on the cached PATH
//!    (`shell_env`, Hard rule 2) and the workspace folder (or a folder above
//!    it) is linked in `~/.railway/config.json`, `railway status --json` is
//!    run through `platform::new_command`, bounded to six seconds like
//!    `gh auth status`, in its own process group and registered for exit
//!    cleanup (`worktrees::run_bounded_output_capped`, Hard rule 4). Its
//!    environments → services give each service's repository, branch,
//!    root directory, watch paths and addresses. A folder that isn't linked
//!    is known from the config file alone: nothing runs. The answer is kept
//!    ten minutes per workspace; `refresh` reads again.
//!  - **GitHub checks.** `.github/workflows/*.yml|yaml` in the workspace
//!    folder: `on.push` / `on.pull_request` branches and paths filters, and
//!    the job names (`serde_yaml_ng`, already a dependency).
//!
//! Nothing here writes to Railway or GitHub. [`what_redeploys`] is the pure
//! answer to "what changes online when this card's pull request merges",
//! which the Ship step (D2) shows; it never blocks a Ship.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::kanban::KanbanStore;
use crate::project_config::ProjectConfigStore;
use crate::workspace::WorkspaceStore;

/// `railway status --json`'s bound, the same as `gh auth status`'s.
pub const RAILWAY_TIMEOUT: Duration = Duration::from_secs(6);
/// How long a Railway reading is reused before it is read again.
pub const CACHE_FOR: Duration = Duration::from_secs(10 * 60);
/// At most this much of `railway status --json` is read (a large project's
/// answer is tens of kilobytes).
const RAILWAY_MAX_STDOUT: usize = 8 * 1024 * 1024;
/// At most this many workflow files, and this large each, are read.
const MAX_WORKFLOWS: usize = 64;
const MAX_WORKFLOW_BYTES: u64 = 512 * 1024;

// ── Shapes ─────────────────────────────────────────────────────────────

/// What Railway said, or why there is nothing.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RailwayState {
    /// Read: `project` and `services` are filled.
    Ok,
    /// No `railway` program on the PATH.
    NoCli,
    /// The folder isn't linked to a Railway project.
    NotLinked,
    /// The link Railway would use is on a folder above this repository: it
    /// belongs to another project, so nothing ran.
    OtherProject,
    /// Railway refused: nobody signed in, or the sign-in expired.
    SignedOut,
    /// It ran past its bound and was stopped.
    TimedOut,
    /// Any other failure; `message` says what.
    Failed,
}

/// One service of one environment, as Railway builds it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RailwayService {
    pub environment: String,
    pub name: String,
    /// `owner/name` on GitHub; `None` for a service built from an image.
    pub repo: Option<String>,
    /// The branch it deploys from (its latest deployment's).
    pub branch: Option<String>,
    /// From the repository's root, without leading or trailing `/`; `None`
    /// when it builds from the whole repository.
    pub root_directory: Option<String>,
    /// Gitignore-style, from the repository's root. Empty: every change
    /// rebuilds it.
    pub watch_patterns: Vec<String>,
    /// Custom addresses first, then Railway's own.
    pub domains: Vec<String>,
    /// Its cron schedule, for a scheduled service.
    pub cron: Option<String>,
    /// Its latest deployment's state as Railway names it (`SUCCESS`,
    /// `FAILED`, `BUILDING`, `DEPLOYING`, `CRASHED`, `REMOVED`, `SLEEPING`…),
    /// upper-cased; `None` when Railway gave none. Read only, for the page's
    /// "Right now" line.
    pub deploy_status: Option<String>,
    /// It builds from this workspace's repository (`origin`); set by
    /// [`map_for`]. A service of another repository is never rebuilt by a
    /// merge here.
    pub this_repository: bool,
}

/// What Railway gave, or why not.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RailwayRead {
    pub state: RailwayState,
    /// The linked project's name (from the answer, else from the link).
    pub project: Option<String>,
    pub services: Vec<RailwayService>,
    /// What went wrong, for `Failed` (its first line).
    pub message: Option<String>,
    /// When Railway was read (epoch ms); `None` when nothing ran.
    pub read_at: Option<i64>,
}

impl RailwayRead {
    fn nothing(state: RailwayState) -> Self {
        RailwayRead { state, project: None, services: Vec::new(), message: None, read_at: None }
    }
}

/// One event's filters (`on.push`, `on.pull_request`). `None`: no filter.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub branches: Option<Vec<String>>,
    pub branches_ignore: Option<Vec<String>>,
    pub paths: Option<Vec<String>>,
    pub paths_ignore: Option<Vec<String>>,
}

/// One workflow file.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    /// `ci.yml`.
    pub file: String,
    /// Its `name:`, else the file's name without the extension.
    pub name: String,
    pub push: Option<Trigger>,
    pub pull_request: Option<Trigger>,
    /// `pull_request_target` runs on a pull request too.
    pub pull_request_target: Option<Trigger>,
    /// Each job's `name:` (when it is plain text), else its id.
    pub jobs: Vec<String>,
}

/// Where the workspace goes live (`deploy_map_get`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployMap {
    /// The workspace's `origin` on GitHub (`owner/name`), when it is one.
    pub repo: Option<String>,
    pub railway: RailwayRead,
    pub workflows: Vec<Workflow>,
    /// The repository has Railway's own config (`railway.json` or
    /// `railway.toml`, at its root or one folder down): a sign it uses
    /// Railway, so a Railway that can't be read is said (1.173.0 Windows
    /// walk). A Dockerfile alone is no sign: many projects without Railway
    /// have one.
    pub railway_files: bool,
}

impl DeployMap {
    /// Something to show: a Railway service or a GitHub check.
    pub fn has_anything(&self) -> bool {
        !self.railway.services.is_empty() || !self.workflows.is_empty()
    }
}

/// Why a service rebuilds when the pull request merges.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RebuildReason {
    /// Its watch paths match a changed file: it updates.
    Watched,
    /// No watch paths, and a changed file is its own (inside its root
    /// directory; for a service of the whole repository, outside every other
    /// service's root): it updates.
    InRoot,
    /// No watch paths, and none of the changed files is its own: it
    /// rebuilds ("restarts too") only because it rebuilds on any change.
    AnyChange,
}

/// One service that rebuilds.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Redeploy {
    pub service: RailwayService,
    pub reason: RebuildReason,
    /// No watch paths: any change in the repository rebuilds it.
    pub rebuilds_on_any_change: bool,
    /// Its addresses (custom first), as on `service`.
    pub domains: Vec<String>,
}

/// One workflow that runs on the pull request.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub file: String,
    pub name: String,
    pub jobs: Vec<String>,
}

/// What a merge to `target_branch` with `changed_paths` changes online.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WhatRedeploys {
    pub target_branch: String,
    /// Updates first (`Watched`, `InRoot`), then `AnyChange`; Railway's
    /// order within each.
    pub services: Vec<Redeploy>,
    /// The workflows that run on a pull request to `target_branch`.
    pub checks: Vec<CheckRun>,
    /// The Railway project, and when it was read (epoch ms).
    pub project: Option<String>,
    pub railway_read_at: Option<i64>,
    /// How many files the card changed.
    pub changed: usize,
}

impl WhatRedeploys {
    pub fn has_anything(&self) -> bool {
        !self.services.is_empty() || !self.checks.is_empty()
    }
}

// ── Railway: parsing ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct Edges<T> {
    #[serde(default = "Vec::new")]
    edges: Vec<Edge<T>>,
}

impl<T> Default for Edges<T> {
    fn default() -> Self {
        Edges { edges: Vec::new() }
    }
}
#[derive(Deserialize)]
struct Edge<T> {
    node: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusJson {
    name: Option<String>,
    #[serde(default)]
    environments: Edges<EnvJson>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvJson {
    #[serde(default)]
    name: String,
    #[serde(default)]
    service_instances: Edges<InstanceJson>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceJson {
    #[serde(default)]
    service_name: String,
    latest_deployment: Option<DeploymentJson>,
    #[serde(default)]
    active_deployments: Vec<DeploymentJson>,
    source: Option<SourceJson>,
    domains: Option<DomainsJson>,
    cron_schedule: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentJson {
    meta: Option<MetaJson>,
    status: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaJson {
    branch: Option<String>,
    repo: Option<String>,
    root_directory: Option<String>,
    service_manifest: Option<ManifestJson>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestJson {
    build: Option<BuildJson>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildJson {
    watch_patterns: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceJson {
    repo: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DomainsJson {
    #[serde(default)]
    service_domains: Vec<DomainJson>,
    #[serde(default)]
    custom_domains: Vec<DomainJson>,
}
#[derive(Deserialize)]
struct DomainJson {
    domain: Option<String>,
}

/// `rootDirectory` as a root-relative folder: `"/site/"`, `"./site"` →
/// `"site"`; `"/"`, `""` → `None`.
pub fn normalize_root(root: Option<&str>) -> Option<String> {
    let root = root?.trim().replace('\\', "/");
    let root = root.trim_start_matches("./").trim_matches('/');
    (!root.is_empty() && root != ".").then(|| root.to_string())
}

fn present(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The project's name and services from `railway status --json`.
pub fn parse_railway_status(json: &str) -> Result<(Option<String>, Vec<RailwayService>), String> {
    let status: StatusJson = serde_json::from_str(json).map_err(|e| format!("Railway's answer can't be read: {e}"))?;
    let mut services = Vec::new();
    for env in status.environments.edges {
        let env = env.node;
        for instance in env.service_instances.edges {
            let i = instance.node;
            // The state is the latest deployment's: a failed latest deploy
            // is what the person needs to hear, even while an older one
            // still serves.
            let deploy_status = i
                .latest_deployment
                .as_ref()
                .and_then(|d| present(d.status.clone()))
                .map(|s| s.to_ascii_uppercase());
            // The answer has no branch of its own per service: the first
            // deployment that names one (the latest, then the active ones)
            // says where it builds from, with that deployment's root and
            // watch paths; without any, the first deployment's.
            let metas: Vec<MetaJson> = i
                .latest_deployment
                .into_iter()
                .chain(i.active_deployments)
                .filter_map(|d| d.meta)
                .collect();
            let pick = metas
                .iter()
                .position(|m| m.branch.as_deref().is_some_and(|b| !b.trim().is_empty()))
                .unwrap_or(0);
            let meta = metas.into_iter().nth(pick);
            let (branch, meta_repo, root, watch) = match meta {
                Some(m) => (
                    present(m.branch),
                    present(m.repo),
                    m.root_directory,
                    m.service_manifest.and_then(|s| s.build).and_then(|b| b.watch_patterns).unwrap_or_default(),
                ),
                None => (None, None, None, Vec::new()),
            };
            // The service's source decides: a source without a repository
            // (an image) is never rebuilt by a merge, whatever an old
            // deployment says. Only without a source is a deployment's
            // repository taken.
            let repo = match i.source {
                Some(source) => present(source.repo),
                None => meta_repo,
            };
            let domains = i
                .domains
                .map(|d| {
                    d.custom_domains
                        .into_iter()
                        .chain(d.service_domains)
                        .filter_map(|d| present(d.domain))
                        .collect()
                })
                .unwrap_or_default();
            services.push(RailwayService {
                environment: env.name.clone(),
                name: i.service_name,
                repo,
                branch,
                root_directory: normalize_root(root.as_deref()),
                watch_patterns: watch.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect(),
                domains,
                cron: present(i.cron_schedule),
                deploy_status,
                this_repository: false,
            });
        }
    }
    Ok((present(status.name), services))
}

/// What a failed `railway status` means, from its words.
pub fn classify_failure(text: &str) -> RailwayState {
    let lower = text.to_ascii_lowercase();
    if lower.contains("no linked project") || lower.contains("not linked") {
        RailwayState::NotLinked
    } else if lower.contains("unauthorized")
        || lower.contains("railway login")
        || lower.contains("not logged in")
        || lower.contains("login required")
    {
        RailwayState::SignedOut
    } else {
        RailwayState::Failed
    }
}

// ── Railway: the link ──────────────────────────────────────────────────

/// The link `~/.railway/config.json` holds for a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailwayLink {
    /// The linked project's name, when the file says it.
    pub project: Option<String>,
    /// Whether the file holds a sign-in (a token is present; it is never
    /// read further).
    pub signed_in: bool,
    /// The folder the link is on (the folder itself or one above it).
    pub linked_at: String,
}

#[derive(Deserialize)]
struct ConfigJson {
    #[serde(default)]
    projects: HashMap<String, ConfigProject>,
    user: Option<ConfigUser>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigProject {
    project_path: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigUser {
    token: Option<serde_json::Value>,
    access_token: Option<serde_json::Value>,
}

/// A folder as text: `/` separators, no trailing `/`, lowercased where the
/// file system ignores case (Windows).
fn folder_key(s: &str, ignore_case: bool) -> String {
    let s = s.replace('\\', "/");
    let s = if s.len() > 1 { s.trim_end_matches('/').to_string() } else { s };
    if ignore_case { s.to_lowercase() } else { s }
}

/// `folder` and every folder above it, deepest first, as text.
fn folder_chain(folder: &str, ignore_case: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = folder_key(folder, ignore_case);
    while !cur.is_empty() {
        out.push(cur.clone());
        match cur.rfind('/') {
            Some(0) if cur.len() > 1 => cur = "/".to_string(),
            Some(i) if i > 0 => cur.truncate(i),
            _ => break,
        }
    }
    out
}

fn depth(key: &str) -> usize {
    key.split('/').filter(|s| !s.is_empty()).count()
}

/// Whether `inner` is strictly inside `outer` (both as text).
fn strictly_inside(inner: &str, outer: &str, ignore_case: bool) -> bool {
    let (inner, outer) = (folder_key(inner, ignore_case), folder_key(outer, ignore_case));
    inner != outer && inner.starts_with(&format!("{}/", outer.trim_end_matches('/')))
}

/// Whether folder names are compared without case: Windows, and the Mac,
/// whose default volume (APFS) ignores case — a link written as
/// `/Users/me/Repo` is the folder `/Users/me/repo` there (D1 Challenger).
/// A case-sensitive Mac volume is rare; there a link of another case would
/// read as this folder's, and Railway's own lookup still decides the reading.
pub const FOLDERS_IGNORE_CASE: bool = cfg!(any(windows, target_os = "macos"));

/// The link for `folder` or a folder above it, the way the Railway program
/// finds it: the deepest linked folder, over the folder as given and as the
/// file system resolves it. `None` from a file that can't be read as
/// Railway's: the program is then asked.
pub fn link_for(config: &str, folder: &Path) -> Option<Option<RailwayLink>> {
    let mut folders = vec![folder.to_string_lossy().into_owned()];
    if let Ok(real) = crate::platform::canonicalize(folder) {
        folders.push(real.to_string_lossy().into_owned());
    }
    link_for_in(config, &folders, FOLDERS_IGNORE_CASE)
}

/// [`link_for`] over folders as text (pure; `ignore_case` as on Windows).
pub fn link_for_in(config: &str, folders: &[String], ignore_case: bool) -> Option<Option<RailwayLink>> {
    let config: ConfigJson = serde_json::from_str(config).ok()?;
    let signed_in = config.user.as_ref().is_some_and(|u| {
        let set = |v: &Option<serde_json::Value>| v.as_ref().and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty());
        set(&u.token) || set(&u.access_token)
    });
    let mut candidates: Vec<String> = folders.iter().flat_map(|f| folder_chain(f, ignore_case)).collect();
    candidates.sort_by_key(|c| std::cmp::Reverse(depth(c)));
    for dir in candidates {
        let found = config.projects.iter().find(|(key, p)| {
            folder_key(key, ignore_case) == dir
                || p.project_path.as_deref().is_some_and(|pp| folder_key(pp, ignore_case) == dir)
        });
        if let Some((key, p)) = found {
            return Some(Some(RailwayLink {
                project: present(p.name.clone()),
                signed_in,
                linked_at: p.project_path.clone().filter(|pp| !pp.is_empty()).unwrap_or_else(|| key.clone()),
            }));
        }
    }
    Some(None)
}

/// Whether the link is on a folder above the repository's top level `top`
/// (so it is another project's), as given or as resolved.
pub fn link_above(link: &RailwayLink, top: &str, ignore_case: bool) -> bool {
    let mut linked = vec![link.linked_at.clone()];
    if let Ok(real) = crate::platform::canonicalize(&link.linked_at) {
        linked.push(real.to_string_lossy().into_owned());
    }
    let mut tops = vec![top.to_string()];
    if let Ok(real) = crate::platform::canonicalize(top) {
        tops.push(real.to_string_lossy().into_owned());
    }
    let inside = |t: &String, l: &String| strictly_inside(t, l, ignore_case);
    let same = |t: &String, l: &String| folder_key(t, ignore_case) == folder_key(l, ignore_case);
    // Above in some spelling, and the same folder in none.
    tops.iter().any(|t| linked.iter().any(|l| inside(t, l)))
        && !tops.iter().any(|t| linked.iter().any(|l| same(t, l) || inside(l, t)))
}

/// `~/.railway/config.json`.
pub fn railway_config_path() -> Option<PathBuf> {
    crate::platform::home_dir().map(|home| home.join(".railway").join("config.json"))
}

// ── Railway: reading ───────────────────────────────────────────────────

/// What [`read_railway`] needs, so tests can point it anywhere.
pub struct RailwayInputs<'a> {
    /// The program, as found on the cached PATH; `None`: not installed.
    pub program: Option<&'a str>,
    pub path_env: &'a str,
    pub folder: &'a Path,
    /// Railway's config file's text; `None` when it isn't there.
    pub config: Option<&'a str>,
    /// The repository's top level (`git rev-parse --show-toplevel`), when
    /// the folder is in one: a link above it is another project's.
    pub repo_top: Option<&'a str>,
    pub timeout: Duration,
}

/// Railway's view of `folder`. Never an error: every failure is a state.
pub fn read_railway(inputs: &RailwayInputs) -> RailwayRead {
    let Some(program) = inputs.program else { return RailwayRead::nothing(RailwayState::NoCli) };
    let link = match inputs.config.map(|c| link_for(c, inputs.folder)) {
        // No config file at all: nothing was ever linked on this computer.
        None => return RailwayRead::nothing(RailwayState::NotLinked),
        Some(Some(None)) => return RailwayRead::nothing(RailwayState::NotLinked),
        Some(Some(Some(link))) => {
            if inputs.repo_top.is_some_and(|top| link_above(&link, top, FOLDERS_IGNORE_CASE)) {
                return RailwayRead { project: link.project, ..RailwayRead::nothing(RailwayState::OtherProject) };
            }
            Some(link)
        }
        // A file Plyloft can't read: let the program say.
        Some(None) => None,
    };
    let mut cmd = crate::platform::new_command(program);
    cmd.args(["status", "--json"])
        .current_dir(inputs.folder)
        .env("PATH", inputs.path_env)
        // No colour in the answer; stdin is closed, so nothing can prompt.
        .env("NO_COLOR", "1");
    let now = chrono::Utc::now().timestamp_millis();
    let link_project = link.as_ref().and_then(|l| l.project.clone());
    let out = match crate::worktrees::run_bounded_output_capped(&mut cmd, inputs.timeout, RAILWAY_MAX_STDOUT) {
        Ok(out) => out,
        Err(crate::worktrees::BoundedFailure::TimedOut) => {
            return RailwayRead { project: link_project, read_at: Some(now), ..RailwayRead::nothing(RailwayState::TimedOut) }
        }
        Err(failure) => {
            return RailwayRead {
                project: link_project,
                message: Some(match failure {
                    crate::worktrees::BoundedFailure::Spawn(e) => format!("couldn't start Railway: {e}"),
                    crate::worktrees::BoundedFailure::Quitting => "Plyloft was quitting".to_string(),
                    crate::worktrees::BoundedFailure::Truncated => "Railway's answer was cut short".to_string(),
                    crate::worktrees::BoundedFailure::TimedOut => "Railway didn't answer in time".to_string(),
                }),
                read_at: Some(now),
                ..RailwayRead::nothing(RailwayState::Failed)
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    if out.status.success() {
        match parse_railway_status(&stdout) {
            Ok((project, services)) => RailwayRead {
                state: RailwayState::Ok,
                project: project.or(link_project),
                services,
                message: None,
                read_at: Some(now),
            },
            Err(e) => RailwayRead {
                project: link_project,
                message: Some(e),
                read_at: Some(now),
                ..RailwayRead::nothing(RailwayState::Failed)
            },
        }
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let text = format!("{stderr}\n{stdout}");
        let state = classify_failure(&text);
        let message = (state == RailwayState::Failed)
            .then(|| text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no answer").to_string());
        RailwayRead { state, project: link_project, services: Vec::new(), message, read_at: Some(now) }
    }
}

// ── GitHub checks ──────────────────────────────────────────────────────

fn strings(value: Option<&serde_yaml_ng::Value>) -> Option<Vec<String>> {
    use serde_yaml_ng::Value;
    match value? {
        Value::String(s) => Some(vec![s.clone()]),
        Value::Sequence(items) => Some(
            items
                .iter()
                .filter_map(|v| match v {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

fn trigger(value: &serde_yaml_ng::Value) -> Trigger {
    let get = |key: &str| strings(value.get(key));
    Trigger {
        branches: get("branches"),
        branches_ignore: get("branches-ignore"),
        paths: get("paths"),
        paths_ignore: get("paths-ignore"),
    }
}

/// One workflow file's events and jobs; `None` when it isn't a workflow.
pub fn parse_workflow(file: &str, text: &str) -> Option<Workflow> {
    use serde_yaml_ng::Value;
    let doc: Value = serde_yaml_ng::from_str(text).ok()?;
    let map = doc.as_mapping()?;
    // `on:` — a YAML 1.1 reader would make the key `true`.
    let on = map.get(Value::from("on")).or_else(|| map.get(Value::Bool(true)))?;
    let event = |name: &str| -> Option<Trigger> {
        match on {
            Value::String(s) => (s == name).then(Trigger::default),
            Value::Sequence(items) => items.iter().any(|v| v.as_str() == Some(name)).then(Trigger::default),
            Value::Mapping(m) => m.get(Value::from(name)).map(|v| if v.is_mapping() { trigger(v) } else { Trigger::default() }),
            _ => None,
        }
    };
    let stem = file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file).to_string();
    let name = map
        .get(Value::from("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty() && !n.contains("${{"))
        .map(str::to_string)
        .unwrap_or(stem);
    let jobs = map
        .get(Value::from("jobs"))
        .and_then(Value::as_mapping)
        .map(|jobs| {
            jobs.iter()
                .filter_map(|(id, job)| {
                    let id = id.as_str()?;
                    let named = job
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|n| !n.is_empty() && !n.contains("${{"));
                    Some(named.unwrap_or(id).to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Workflow {
        file: file.to_string(),
        name,
        push: event("push"),
        pull_request: event("pull_request"),
        pull_request_target: event("pull_request_target"),
        jobs,
    })
}

/// Every workflow in `root/.github/workflows`, by file name.
pub fn read_workflows(root: &Path) -> Vec<Workflow> {
    let Ok(entries) = std::fs::read_dir(root.join(".github").join("workflows")) else { return Vec::new() };
    let mut files: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            (lower.ends_with(".yml") || lower.ends_with(".yaml")).then(|| (name, e.path()))
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .take(MAX_WORKFLOWS)
        .filter(|(_, path)| std::fs::metadata(path).map(|m| m.len() <= MAX_WORKFLOW_BYTES).unwrap_or(false))
        .filter_map(|(name, path)| parse_workflow(&name, &std::fs::read_to_string(path).ok()?))
        .collect()
}

// ── Patterns ───────────────────────────────────────────────────────────

/// Whether Railway's watch paths (gitignore-style, from the repository's
/// root; `!` excludes, the last match wins) take `path`. An empty list
/// takes everything.
pub fn watch_matches(patterns: &[String], path: &str) -> bool {
    if patterns.is_empty() {
        return true;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new("");
    for p in patterns {
        let _ = builder.add_line(None, p);
    }
    let Ok(matcher) = builder.build() else { return false };
    let path = path.trim_start_matches('/');
    matcher.matched_path_or_any_parents(Path::new(path), false).is_ignore()
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Lit(char),
    /// A character (or class) made optional by a following `?`.
    Opt(Box<Tok>),
    /// One or more of a character (or class) (`+`).
    Plus(Box<Tok>),
    /// `*`: anything but `/`.
    Star,
    /// `**`: anything.
    Stars,
    /// `**/`: nothing, or anything ending in `/`.
    StarsSlash,
    Class(Vec<(char, char)>),
}

fn tokens(pattern: &str) -> Vec<Tok> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out: Vec<Tok> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' if chars.get(i + 1) == Some(&'*') => {
                if chars.get(i + 2) == Some(&'/') {
                    out.push(Tok::StarsSlash);
                    i += 3;
                } else {
                    out.push(Tok::Stars);
                    i += 2;
                }
                continue;
            }
            '*' => out.push(Tok::Star),
            '?' | '+' => {
                // GitHub: `?` makes the character before it optional, `+`
                // repeats it.
                match out.pop() {
                    Some(prev @ (Tok::Lit(_) | Tok::Class(_))) => {
                        let prev = Box::new(prev);
                        out.push(if c == '?' { Tok::Opt(prev) } else { Tok::Plus(prev) })
                    }
                    Some(other) => {
                        out.push(other);
                        out.push(Tok::Lit(c));
                    }
                    None => out.push(Tok::Lit(c)),
                }
            }
            '[' => {
                if let Some(end) = chars[i + 1..].iter().position(|&ch| ch == ']') {
                    let body = &chars[i + 1..i + 1 + end];
                    let mut ranges = Vec::new();
                    let mut k = 0;
                    while k < body.len() {
                        if k + 2 < body.len() && body[k + 1] == '-' {
                            ranges.push((body[k], body[k + 2]));
                            k += 3;
                        } else {
                            ranges.push((body[k], body[k]));
                            k += 1;
                        }
                    }
                    out.push(Tok::Class(ranges));
                    i += end + 2;
                    continue;
                }
                out.push(Tok::Lit(c));
            }
            '\\' if i + 1 < chars.len() => {
                out.push(Tok::Lit(chars[i + 1]));
                i += 2;
                continue;
            }
            _ => out.push(Tok::Lit(c)),
        }
        i += 1;
    }
    out
}

/// Whether a one-character token (a literal or a class) takes `ch`.
fn one_char(tok: &Tok, ch: char) -> bool {
    match tok {
        Tok::Lit(c) => *c == ch,
        Tok::Class(ranges) => ch != '/' && ranges.iter().any(|(a, b)| *a <= ch && ch <= *b),
        _ => false,
    }
}

fn glob_at(toks: &[Tok], s: &[char]) -> bool {
    let Some((tok, rest)) = toks.split_first() else { return s.is_empty() };
    match tok {
        Tok::Lit(_) | Tok::Class(_) => s.first().is_some_and(|ch| one_char(tok, *ch)) && glob_at(rest, &s[1..]),
        Tok::Opt(inner) => (s.first().is_some_and(|ch| one_char(inner, *ch)) && glob_at(rest, &s[1..])) || glob_at(rest, s),
        Tok::Plus(inner) => {
            let run = s.iter().take_while(|ch| one_char(inner, **ch)).count();
            (1..=run).any(|n| glob_at(rest, &s[n..]))
        }
        Tok::Star => {
            let run = s.iter().take_while(|ch| **ch != '/').count();
            (0..=run).any(|n| glob_at(rest, &s[n..]))
        }
        Tok::Stars => (0..=s.len()).any(|n| glob_at(rest, &s[n..])),
        Tok::StarsSlash => {
            glob_at(rest, s) || (0..s.len()).any(|n| s[n] == '/' && glob_at(rest, &s[n + 1..]))
        }
    }
}

/// GitHub's filter pattern (`*` stops at `/`, `**` doesn't, `x?` and `x+`
/// on the character before, `[a-z]`).
pub fn github_glob(pattern: &str, text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    glob_at(&tokens(pattern), &chars)
}

/// A filter list as GitHub reads it: patterns in order, a `!` one takes back
/// what earlier ones matched; the last that matches decides.
pub fn github_filter(patterns: &[String], text: &str) -> bool {
    let mut matched = false;
    for p in patterns {
        match p.strip_prefix('!') {
            Some(neg) => {
                if matched && github_glob(neg, text) {
                    matched = false;
                }
            }
            None => {
                if !matched && github_glob(p, text) {
                    matched = true;
                }
            }
        }
    }
    matched
}

/// Whether an event with `trigger` fires for `branch` and `changed_paths`.
pub fn trigger_fires(trigger: &Trigger, branch: &str, changed_paths: &[String]) -> bool {
    if let Some(branches) = &trigger.branches {
        if !github_filter(branches, branch) {
            return false;
        }
    }
    if let Some(ignored) = &trigger.branches_ignore {
        if github_filter(ignored, branch) {
            return false;
        }
    }
    if let Some(paths) = &trigger.paths {
        if !changed_paths.iter().any(|p| github_filter(paths, p)) {
            return false;
        }
    }
    if let Some(ignored) = &trigger.paths_ignore {
        // Skipped only when every changed file is ignored.
        if !changed_paths.is_empty() && changed_paths.iter().all(|p| github_filter(ignored, p)) {
            return false;
        }
    }
    true
}

// ── What a merge changes ───────────────────────────────────────────────

fn in_root(root: &str, path: &str) -> bool {
    let path = path.trim_start_matches('/');
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

fn same_repo(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches(".git").eq_ignore_ascii_case(b.trim().trim_end_matches(".git"))
}

/// The services that rebuild, and the checks that run, when a pull request
/// to `target_branch` changing `changed_paths` (root-relative) merges. Pure.
///
/// A service rebuilds when it builds from the same repository and branch and
/// either its watch paths match a changed file, or it has none (Railway then
/// rebuilds it on any change, whatever its root directory).
pub fn what_redeploys(map: &DeployMap, target_branch: &str, changed_paths: &[String]) -> WhatRedeploys {
    let target = target_branch.trim();
    let candidates: Vec<&RailwayService> = map
        .railway
        .services
        .iter()
        .filter(|s| match (&map.repo, &s.repo) {
            (Some(ours), Some(theirs)) => same_repo(ours, theirs),
            _ => false,
        })
        .filter(|s| s.branch.as_deref().is_some_and(|b| b.trim() == target))
        .collect();
    let mut updates = Vec::new();
    let mut too = Vec::new();
    if !changed_paths.is_empty() {
        for s in &candidates {
            let any = s.watch_patterns.is_empty();
            let reason = if !any {
                if changed_paths.iter().any(|p| watch_matches(&s.watch_patterns, p)) {
                    RebuildReason::Watched
                } else {
                    continue;
                }
            } else {
                let own = match &s.root_directory {
                    Some(root) => changed_paths.iter().any(|p| in_root(root, p)),
                    // The whole repository: its own are the files no other
                    // rebuilding service's root holds.
                    None => changed_paths.iter().any(|p| {
                        !candidates.iter().any(|o| {
                            !std::ptr::eq(*o, *s) && o.root_directory.as_deref().is_some_and(|r| in_root(r, p))
                        })
                    }),
                };
                if own { RebuildReason::InRoot } else { RebuildReason::AnyChange }
            };
            let redeploy = Redeploy {
                service: (*s).clone(),
                reason,
                rebuilds_on_any_change: any,
                domains: s.domains.clone(),
            };
            if reason == RebuildReason::AnyChange {
                too.push(redeploy);
            } else {
                updates.push(redeploy);
            }
        }
    }
    updates.extend(too);
    let checks = map
        .workflows
        .iter()
        .filter(|w| {
            [&w.pull_request, &w.pull_request_target]
                .into_iter()
                .flatten()
                .any(|t| trigger_fires(t, target, changed_paths))
        })
        .map(|w| CheckRun { file: w.file.clone(), name: w.name.clone(), jobs: w.jobs.clone() })
        .collect();
    WhatRedeploys {
        target_branch: target.to_string(),
        services: updates,
        checks,
        project: map.railway.project.clone(),
        railway_read_at: map.railway.read_at,
        changed: changed_paths.len(),
    }
}

// ── Reading a workspace, with the cache ────────────────────────────────

struct Cached {
    at: Instant,
    railway: RailwayRead,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One reading of Railway at a time per workspace: a second asker waits
/// and takes the first one's answer.
fn reading_lock(workspace_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut held = locks.lock().unwrap_or_else(|p| p.into_inner());
    held.entry(workspace_id.to_string()).or_default().clone()
}

fn cached_railway(workspace_id: &str, max_age: Option<Duration>) -> Option<RailwayRead> {
    let held = cache().lock().unwrap_or_else(|p| p.into_inner());
    let entry = held.get(workspace_id)?;
    max_age.is_none_or(|age| entry.at.elapsed() < age).then(|| entry.railway.clone())
}

/// Railway for `folder` as this computer runs it (the cached PATH, the
/// user's config file).
fn read_railway_here(folder: &Path) -> RailwayRead {
    let env = crate::shell_env::get();
    let program = crate::shell_env::find_in_path(&env.path, "railway");
    let config = railway_config_path().and_then(|p| std::fs::read_to_string(p).ok());
    let top = repo_top(folder);
    read_railway(&RailwayInputs {
        program: program.as_deref(),
        path_env: &env.path,
        folder,
        config: config.as_deref(),
        repo_top: top.as_deref(),
        timeout: RAILWAY_TIMEOUT,
    })
}

fn railway_for(workspace_id: &str, folder: &Path, refresh: bool) -> RailwayRead {
    if !refresh {
        if let Some(read) = cached_railway(workspace_id, Some(CACHE_FOR)) {
            return read;
        }
    }
    let lock = reading_lock(workspace_id);
    let _reading = lock.lock().unwrap_or_else(|p| p.into_inner());
    // Somebody else read it while this one waited.
    if let Some(read) = cached_railway(workspace_id, Some(CACHE_FOR)) {
        if !refresh || read.read_at.is_some_and(|at| chrono::Utc::now().timestamp_millis() - at < 2_000) {
            return read;
        }
    }
    let read = read_railway_here(folder);
    cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(workspace_id.to_string(), Cached { at: Instant::now(), railway: read.clone() });
    read
}

fn origin_repo(folder: &Path) -> Option<String> {
    let url = crate::git::capture_configured_bounded(folder, &[], &["remote", "get-url", "origin"], Duration::from_secs(5)).ok()?;
    crate::team::origin_slug(url.trim())
}

fn repo_top(folder: &Path) -> Option<String> {
    let top = crate::git::capture_configured_bounded(folder, &[], &["rev-parse", "--show-toplevel"], Duration::from_secs(5)).ok()?;
    let top = top.trim();
    (!top.is_empty()).then(|| top.to_string())
}

/// Marks the services that build from `repo` (this workspace's `origin`).
pub fn mark_this_repository(read: &mut RailwayRead, repo: Option<&str>) {
    for s in &mut read.services {
        s.this_repository = matches!((repo, s.repo.as_deref()), (Some(ours), Some(theirs)) if same_repo(ours, theirs));
    }
}

/// 1.173.0 (E1): Railway's services only (the cached reading), each marked
/// as built from this repository or not — no workflow is read. For Next
/// improvement's "Where to look at it".
pub fn railway_services(workspace_id: &str, folder: &Path) -> Vec<RailwayService> {
    let mut railway = railway_for(workspace_id, folder, false);
    mark_this_repository(&mut railway, origin_repo(folder).as_deref());
    railway.services
}

/// The workspace's map: Railway (cached), its GitHub checks and its origin.
pub fn map_for(workspace_id: &str, folder: &Path, refresh: bool) -> DeployMap {
    let repo = origin_repo(folder);
    let mut railway = railway_for(workspace_id, folder, refresh);
    mark_this_repository(&mut railway, repo.as_deref());
    DeployMap { repo, railway, workflows: read_workflows(folder), railway_files: has_railway_files(folder) }
}

/// Railway's config files, by name.
const RAILWAY_FILES: [&str; 2] = ["railway.json", "railway.toml"];

/// Whether `folder` or one of its folders (not `.git`, `node_modules` or
/// other hidden ones) holds Railway's config file.
pub fn has_railway_files(folder: &Path) -> bool {
    let here = |dir: &Path| RAILWAY_FILES.iter().any(|f| dir.join(f).is_file());
    if here(folder) {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(folder) else { return false };
    entries.filter_map(Result::ok).any(|e| {
        let name = e.file_name();
        let name = name.to_string_lossy();
        !name.starts_with('.') && name != "node_modules" && e.file_type().is_ok_and(|t| t.is_dir()) && here(&e.path())
    })
}

fn workspace_folder(app: &tauri::AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    app.state::<WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd))
        .filter(|p| p.is_dir())
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

/// `deploy_map_get`: where the workspace goes live. Off the main thread;
/// `refresh` reads Railway again (*Read again*).
#[tauri::command(async)]
pub fn deploy_map_get(app: tauri::AppHandle, workspace_id: String, refresh: Option<bool>) -> Result<DeployMap, String> {
    let folder = workspace_folder(&app, &workspace_id)?;
    Ok(map_for(&workspace_id, &folder, refresh == Some(true)))
}

/// `deploy_what_changes`: what the card's pull request changes online when
/// it merges, against its area's branch and its changed files. `None` when
/// there is nothing to measure (no copy, nothing changed, or the card can't
/// ship yet — Ship says why itself) or nothing changes online that Plyloft
/// can see: the Ship step then shows nothing.
#[tauri::command(async)]
pub fn deploy_what_changes(app: tauri::AppHandle, workspace_id: String, card_id: String) -> Result<Option<WhatRedeploys>, String> {
    let folder = workspace_folder(&app, &workspace_id)?;
    let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
    let Ok(target) = crate::card_area::branch_for_card(&app.state::<ProjectConfigStore>(), &workspace_id, &card) else {
        return Ok(None);
    };
    let Some(worktree) = card.worktree_path.as_deref().map(PathBuf::from).filter(|p| p.is_dir()) else {
        return Ok(None);
    };
    let Some(base) = crate::worktrees::card_diff_base(&worktree, "HEAD", card.worktree_base.as_ref(), &target) else {
        return Ok(None);
    };
    let paths = crate::card_area::changed_paths(&worktree, &base).unwrap_or_default();
    if paths.is_empty() {
        return Ok(None);
    }
    let mut map = map_for(&workspace_id, &folder, false);
    // The checks the pull request runs are the ones in the card's copy.
    map.workflows = read_workflows(&worktree);
    if !map.has_anything() {
        return Ok(None);
    }
    let what = what_redeploys(&map, &target, &paths);
    Ok(what.has_anything().then_some(what))
}

// ── Doctor ─────────────────────────────────────────────────────────────

/// The Doctor's optional Railway row. Never an error.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RailwayDoctorStatus {
    pub workspace: String,
    /// `ok`, `notLinked`, `signedOut`, `unknown` (it couldn't be read).
    pub state: &'static str,
    /// "signed in · project acme-project", "not linked here".
    pub summary: String,
    /// Plain words; `railway login` is in backticks, drawn as code.
    pub detail: String,
    /// Railway's own words when it failed, for *Copy details* only.
    pub technical: Option<String>,
}

const READ_ONLY: &str = "Plyloft only reads it, to say before Ship which addresses change; it never changes anything on Railway.";
const SIGN_IN: &str = "Railway asks for a sign-in. Run `railway login` in a terminal, then Check again.";

/// Whether a reading is a settled answer (worth keeping ten minutes even
/// for a read that asks).
fn settled(state: RailwayState) -> bool {
    matches!(state, RailwayState::Ok | RailwayState::NotLinked | RailwayState::OtherProject)
}

/// The row from what is known: a reading, else the link alone. Pure.
pub fn doctor_status(workspace: &str, read: Option<&RailwayRead>, link: Option<Option<&RailwayLink>>) -> Option<RailwayDoctorStatus> {
    let row = |state, summary: String, detail: String| RailwayDoctorStatus {
        workspace: workspace.to_string(),
        state,
        summary,
        detail,
        technical: None,
    };
    let not_linked = || {
        row(
            "notLinked",
            "not linked here".to_string(),
            format!("{workspace} isn't linked to a Railway project. That's fine: Ship works the same."),
        )
    };
    if let Some(read) = read {
        return match read.state {
            RailwayState::NoCli => None,
            RailwayState::Ok => {
                // The project is named only when it builds this repository.
                let ours = read.services.iter().any(|s| s.this_repository);
                Some(match (&read.project, ours) {
                    (Some(project), true) => row(
                        "ok",
                        format!("signed in · project {project}"),
                        format!("{workspace} goes online through Railway. {READ_ONLY}"),
                    ),
                    _ => row(
                        "ok",
                        "signed in".to_string(),
                        format!("The Railway project linked here builds nothing from {workspace}'s repository. Ship works the same."),
                    ),
                })
            }
            RailwayState::NotLinked => Some(not_linked()),
            RailwayState::OtherProject => Some(row(
                "notLinked",
                "not linked here".to_string(),
                format!(
                    "The Railway link Plyloft sees is on a folder above {workspace}, so it belongs to another project. That's fine: Ship works the same."
                ),
            )),
            RailwayState::SignedOut => Some(row("signedOut", "signed out".to_string(), SIGN_IN.to_string())),
            RailwayState::TimedOut | RailwayState::Failed => Some(RailwayDoctorStatus {
                technical: read.message.clone(),
                ..row("unknown", "couldn't be read".to_string(), format!("Railway didn't answer for {workspace}. Ship works the same."))
            }),
        };
    }
    match link? {
        None => Some(not_linked()),
        // From the link alone Plyloft can't tell which repository the
        // project builds, so it isn't named.
        Some(link) if link.signed_in => Some(row(
            "ok",
            "signed in".to_string(),
            format!("{workspace} is linked to a Railway project. {READ_ONLY}"),
        )),
        Some(_) => Some(row("signedOut", "signed out".to_string(), SIGN_IN.to_string())),
    }
}

/// Which reading the Doctor shows. A read that asks (Diagnostics) reads
/// again unless a settled answer is under ten minutes old; any other read
/// takes only a reading under ten minutes old, and drops a "signed out"
/// once the link file holds a sign-in again (so *Check again* after
/// `railway login` shows it). Pure: `Ask` means read Railway now.
#[derive(Debug, PartialEq, Eq)]
pub enum DoctorPick {
    Use(RailwayRead),
    Ask,
    LinkOnly,
}

pub fn doctor_pick(cached: Option<(Duration, RailwayRead)>, asks: bool, link_signed_in: bool) -> DoctorPick {
    match cached {
        Some((age, read)) if age < CACHE_FOR && (!asks || settled(read.state)) => {
            if !asks && read.state == RailwayState::SignedOut && link_signed_in {
                DoctorPick::LinkOnly
            } else {
                DoctorPick::Use(read)
            }
        }
        _ if asks => DoctorPick::Ask,
        _ => DoctorPick::LinkOnly,
    }
}

fn cached_entry(workspace_id: &str) -> Option<(Duration, RailwayRead)> {
    let held = cache().lock().unwrap_or_else(|p| p.into_inner());
    held.get(workspace_id).map(|e| (e.at.elapsed(), e.railway.clone()))
}

/// The row for the open workspace, for `dependency_doctor`: `None` without
/// the Railway program.
pub fn doctor_row(workspace_id: &str, workspace: &str, folder: &Path, asks: bool) -> Option<RailwayDoctorStatus> {
    let env = crate::shell_env::get();
    crate::shell_env::find_in_path(&env.path, "railway")?;
    let config = railway_config_path().and_then(|p| std::fs::read_to_string(p).ok());
    let link = match config.as_deref() {
        None => Some(None),
        Some(text) => link_for(text, folder),
    };
    let link_signed_in = matches!(&link, Some(Some(l)) if l.signed_in);
    let mut read = match doctor_pick(cached_entry(workspace_id), asks, link_signed_in) {
        DoctorPick::Use(read) => Some(read),
        DoctorPick::Ask => Some(railway_for(workspace_id, folder, true)),
        DoctorPick::LinkOnly => None,
    };
    if let Some(read) = read.as_mut() {
        mark_this_repository(read, origin_repo(folder).as_deref());
    }
    // A link above the repository is another project's, as the reading says.
    let link = match (&link, repo_top(folder)) {
        (Some(Some(l)), Some(top)) if link_above(l, &top, FOLDERS_IGNORE_CASE) => Some(None),
        _ => link,
    };
    doctor_status(workspace, read.as_ref(), link.as_ref().map(Option::as_ref))
}

#[cfg(test)]
#[path = "deploy_map_tests.rs"]
mod tests;
