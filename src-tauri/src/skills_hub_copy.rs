//! Skills hub H8 (`docs/plans/SKILLS_HUB.md` R5, §12 H8): **Copy to…** as
//! IPC commands, and the link reads every other command shares once a link
//! can come from a workspace or from this Mac. A child module of `commands`,
//! so it shares that module's helpers (workspace lookup, the gates, the
//! skill card's worktree).
//!
//! - `skills_hub_copy_targets` — the destination picker: every other
//!   workspace on this Mac, warm or cold, with what a copy there would do
//!   ([`crate::skill_copy::judge_target`]) and the words the sheet ends with.
//! - `skills_hub_copy_review` — H6b's scripts sheet for what the copy brings
//!   (every file new: a destination that already has the skill is linked or
//!   replaced by the same card, and the backend checks each one again).
//! - `skills_hub_copy_to` — one skill card per destination; a cold one is
//!   written in its board file and never warmed (no watcher, no PTY).
//!
//! The origin of a link is read through [`origin_clone`]: the team clone,
//! or the checkout of the origin workspace on this Mac (its repository's
//! top, read from git objects at `HEAD`). A link from this Mac's own skills
//! is read from the folder itself ([`this_mac_upstream`]).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use tauri::Manager;

use super::*;
use crate::skill_card as sc;
use crate::skill_copy::{self as copy, CardAt, LocalLink, Target};
use crate::skill_links::{self, LinkOrigin, SkillLink, TwinIds, Upstream};

// ── Reading a link's origin ─────────────────────────────────────────

/// The git repository a link's origin is read from on this Mac: the team
/// clone (H3a) or My library's (H10), or the origin workspace's checkout (H8). `None`: not
/// available here (another team, a workspace not on this Mac, this Mac's
/// own folders — which have no repository).
pub(crate) fn origin_clone<R: tauri::Runtime>(app: &tauri::AppHandle<R>, origin: &LinkOrigin) -> Option<PathBuf> {
    match origin.kind.as_str() {
        copy::KIND_WORKSPACE => workspace_origin(app, origin).map(|(_, _, root)| root),
        copy::KIND_THIS_MAC => None,
        _ => team_origin_clone(app, origin),
    }
}

/// The origin workspace of a `workspace` link on this Mac: `(id, name,
/// repository top)`. A link kept on this Mac names its workspace; a
/// committed one names a GitHub repository, found among this Mac's
/// workspaces by their `origin` remote. When several checkouts of that
/// repository are here (a clone and its worktree, say), one is chosen, the
/// same one for every reader (Mac walk: copies from astra read "Linked to
/// astra-2"):
/// 1. the workspace this Mac last copied that repository's skills from
///    (`skills_hub/state.json` `copyOrigins`, kept on this Mac only — never
///    in the committed record), while its `HEAD` has the link's commit;
/// 2. a checkout whose `HEAD` has the link's commit, on the workspace's
///    target branch, and the repository's own checkout (not a linked
///    worktree) — in that order of weight;
/// 3. the workspaces' list order.
pub(crate) fn workspace_origin<R: tauri::Runtime>(app: &tauri::AppHandle<R>, origin: &LinkOrigin) -> Option<(String, String, PathBuf)> {
    let store = app.state::<WorkspaceStore>();
    let listed = store.snapshot().workspaces;
    if let Some(id) = copy::origin_workspace_id(origin) {
        let workspace = listed.into_iter().find(|w| w.id == id)?;
        let root = crate::skills_index::repo_top(Path::new(&workspace.cwd))?;
        return Some((workspace.id, workspace.name, root));
    }
    if origin.source.is_empty() {
        return None;
    }
    let mut found: Vec<(String, String, PathBuf)> = listed
        .into_iter()
        .filter(|w| Path::new(&w.cwd).is_dir())
        .filter(|w| crate::skills_index::origin_repo(Path::new(&w.cwd)).is_some_and(|r| r.eq_ignore_ascii_case(&origin.source)))
        .filter_map(|w| crate::skills_index::repo_top(Path::new(&w.cwd)).map(|root| (w.id, w.name, root)))
        .collect();
    if found.len() < 2 {
        return found.pop();
    }
    let hint = crate::skills_hub_state::load(&store.config_dir).copy_origins.get(&origin.source.to_ascii_lowercase()).cloned();
    let commit = origin.version.commit.as_str();
    let project_config = app.try_state::<ProjectConfigStore>();
    let rank = |(id, _, root): &(String, String, PathBuf)| -> (bool, bool, bool, bool) {
        let has = commit.is_empty()
            || crate::library_snapshot::git(root, &["merge-base", "--is-ancestor", commit, "HEAD"]).is_ok();
        let on_target = project_config.as_ref().is_some_and(|config| on_branch(root, &resolve_base_branch(config, id)));
        let own_checkout = root.join(".git").is_dir();
        (has && hint.as_deref() == Some(id.as_str()), has, has && on_target, has && own_checkout)
    };
    let ranks: Vec<_> = found.iter().map(rank).collect();
    // The best rank, the first in list order among equals.
    let best = (0..found.len()).fold(0, |best, at| if ranks[at] > ranks[best] { at } else { best });
    Some(found.swap_remove(best))
}

/// H8 (Mac walk): remember on this Mac which workspace a committed copy of
/// `repo`'s skill came from, so its rows name that checkout (see
/// [`workspace_origin`]).
pub(crate) fn remember_copy_origin(config_dir: &Path, repo: &str, workspace_id: &str) {
    let repo = repo.to_ascii_lowercase();
    if crate::skills_hub_state::load(config_dir).copy_origins.get(&repo).map(String::as_str) == Some(workspace_id) {
        return;
    }
    let written = crate::skills_hub_state::update(config_dir, chrono::Utc::now().timestamp_millis(), |state| {
        state.copy_origins.insert(repo, workspace_id.to_string());
    });
    if let Err(error) = written {
        log::warn!("skills hub: couldn't remember where a copy came from ({error})");
    }
}

/// H8 Challenger: *Removed* and *Renamed* are claims about the origin
/// workspace's own line of work, so for a `workspace` origin they are made
/// only while its checkout is on the workspace's target branch. A checkout
/// switched to another branch (or a detached `HEAD`) that lacks the skill
/// reads *not available* meanwhile, never a removal to act on. A team
/// origin is the library clone, judged by [`super::skills_hub_decisions::removal_trusted`] alone.
pub(crate) fn origin_on_its_branch<R: tauri::Runtime>(app: &tauri::AppHandle<R>, origin: &LinkOrigin, checkout: &Path) -> bool {
    if origin.kind != copy::KIND_WORKSPACE {
        return true;
    }
    let Some((id, _, _)) = workspace_origin(app, origin) else {
        return false;
    };
    let Some(project_config) = app.try_state::<ProjectConfigStore>() else {
        return false;
    };
    let target = resolve_base_branch(&project_config, &id);
    on_branch(checkout, &target)
}

/// The checkout's `HEAD` is the branch `branch` (not detached).
pub(crate) fn on_branch(checkout: &Path, branch: &str) -> bool {
    crate::library_snapshot::git(checkout, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|out| String::from_utf8_lossy(&out).trim() == branch)
        .unwrap_or(false)
}

/// What this Mac's own folder says now about a `this-mac` link: its content
/// id, or not available (the folder is gone or can't be read — never
/// *Removed*: nothing pulled it away).
pub(crate) fn this_mac_upstream(origin: &LinkOrigin) -> Upstream {
    this_mac_upstream_in(&crate::personal_skills::home_dir(), origin)
}

/// [`this_mac_upstream`] under `home`.
pub(crate) fn this_mac_upstream_in(home: &Path, origin: &LinkOrigin) -> Upstream {
    let Some(dir) = this_mac_dir(home, origin) else {
        return Upstream::Unavailable;
    };
    match copy::dir_id(&dir) {
        Some(id) => Upstream::At(id),
        None => Upstream::Unavailable,
    }
}

/// The folder a `this-mac` link names under `home`. A link written before
/// the Mac re-walk fix holds the path it was staged at (`<n>`, no root):
/// that one is found by its name in the personal roots.
fn this_mac_dir(home: &Path, origin: &LinkOrigin) -> Option<PathBuf> {
    let path = origin.path.as_deref()?;
    if copy::THIS_MAC_ROOTS.iter().any(|root| path.starts_with(&format!("{root}/"))) {
        return Some(path.split('/').fold(home.to_path_buf(), |at, part| at.join(part)));
    }
    copy::this_mac_skill(home, &origin.name).map(|(dir, _, _)| dir)
}

/// How a row names a link's origin on this Mac: the origin workspace's name
/// when it is here, its repository otherwise; "your own skills" for this
/// Mac's folders; the team library's words as before.
pub(crate) fn origin_words_here<R: tauri::Runtime>(app: &tauri::AppHandle<R>, origin: &LinkOrigin) -> String {
    match origin.kind.as_str() {
        copy::KIND_WORKSPACE => workspace_origin(app, origin).map(|(_, name, _)| name).unwrap_or_else(|| {
            // Not on this Mac now: its repository, or the name a local link
            // kept when it was made.
            let kept = origin.extra.get(copy::ORIGIN_WORKSPACE_NAME).and_then(|v| v.as_str()).filter(|n| !n.is_empty());
            match kept {
                _ if !origin.source.is_empty() => origin.source.clone(),
                Some(name) => name.to_string(),
                None => "a workspace".to_string(),
            }
        }),
        copy::KIND_THIS_MAC => "your own skills".to_string(),
        _ => skill_links::origin_words(origin),
    }
}

// ── The links of a workspace: committed, and kept on this Mac ───────

/// A workspace's links, as every reader takes them.
pub(crate) struct LinksHere {
    pub links: BTreeMap<String, SkillLink>,
    /// The skills whose link is kept on this Mac only.
    pub local: BTreeSet<String>,
    pub unreadable: Vec<(String, String)>,
}

/// Where the card `id` of `cards` is, for [`copy::settle`].
fn card_at(cards: &[KanbanCard], id: Option<&str>) -> CardAt {
    let Some(card) = id.and_then(|id| cards.iter().find(|c| c.id == id)) else {
        return CardAt::Gone;
    };
    if crate::kanban::card_shipped_or_pr_open(card) {
        CardAt::Landed
    } else if card.archived {
        CardAt::Gone
    } else {
        CardAt::OnItsWay
    }
}

/// The links of the workspace `workspace_id` (checkout `cwd`): its committed
/// records, and the links kept on this Mac for it — each settled against
/// the checkout's copies and its card ([`copy::settle`]), what changed
/// written back. A committed record wins over a local one of the same skill.
pub(crate) fn links_here(config_dir: Option<&Path>, kanban: Option<&KanbanStore>, workspace_id: &str, cwd: &Path) -> LinksHere {
    let (mut links, unreadable) = skill_links::read_checkout(cwd);
    let mut local = BTreeSet::new();
    let Some(config_dir) = config_dir else {
        return LinksHere { links, local, unreadable };
    };
    let stored = crate::skills_hub_state::load(config_dir).local_links.remove(workspace_id).unwrap_or_default();
    if stored.is_empty() {
        return LinksHere { links, local, unreadable };
    }
    let cards = kanban.and_then(|k| k.load(workspace_id).ok()).unwrap_or_default();
    // Each settled entry with the one it was settled from: written back only
    // while the store still holds that one (an Update's `next` recorded
    // meanwhile, by a card made on another thread, is never lost).
    let mut settled: BTreeMap<String, (LocalLink, Option<LocalLink>)> = BTreeMap::new();
    for (skill, entry) in &stored {
        if links.contains_key(skill) || unreadable.iter().any(|(name, _)| name == skill) {
            continue;
        }
        let here = sc::checkout_twin_ids(cwd, skill);
        let (kept, shown) = copy::settle(entry, &here, &|id| card_at(&cards, id));
        if !copy::same_entry(kept.as_ref(), Some(entry)) {
            settled.insert(skill.clone(), (entry.clone(), kept));
        }
        if let Some(link) = shown {
            links.insert(skill.clone(), link);
            local.insert(skill.clone());
        }
    }
    if !settled.is_empty() {
        let written = crate::skills_hub_state::update(config_dir, chrono::Utc::now().timestamp_millis(), |state| {
            let entries = state.local_links.entry(workspace_id.to_string()).or_default();
            for (skill, (was, kept)) in settled {
                if entries.get(&skill) != Some(&was) {
                    continue;
                }
                match kept {
                    Some(entry) => {
                        entries.insert(skill, entry);
                    }
                    None => {
                        entries.remove(&skill);
                    }
                }
            }
            if entries.is_empty() {
                state.local_links.remove(workspace_id);
            }
        });
        if let Err(error) = written {
            log::warn!("skills hub: couldn't settle the links kept on this machine ({error})");
        }
    }
    LinksHere { links, local, unreadable }
}

/// [`links_here`] for the workspace `workspace_id` of the app.
pub(crate) fn app_links_here<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path) -> LinksHere {
    let config_dir = app.try_state::<WorkspaceStore>().map(|store| store.config_dir.clone());
    let kanban = app.try_state::<KanbanStore>();
    links_here(config_dir.as_deref(), kanban.as_deref(), workspace_id, cwd)
}

// ── Where a copy comes from ─────────────────────────────────────────

/// What Copy to… copies, as the page names it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum CopyFrom {
    /// A repository skill of the workspace `workspace_id`.
    Workspace { workspace_id: String, skill: String },
    /// A team library skill (a copy is the team's Install).
    Team { plugin: String, skill: String },
    /// This Mac's own skill.
    ThisMac { skill: String },
}

impl CopyFrom {
    fn skill(&self) -> &str {
        match self {
            CopyFrom::Workspace { skill, .. } | CopyFrom::Team { skill, .. } | CopyFrom::ThisMac { skill } => skill,
        }
    }
}

/// The skill a copy writes, read once.
pub(crate) struct CopySource {
    pub origin: LinkOrigin,
    pub source: sc::Source,
    pub reach: sc::Reach,
    /// Where the source's git objects are.
    pub repo: PathBuf,
    /// "astra", "your own skills", "the team library".
    pub words: String,
    /// The link can't be committed: kept on this Mac only.
    pub local: bool,
    /// The origin's repository, `owner/name`, lower case.
    pub repo_name: Option<String>,
    pub common_dir: Option<PathBuf>,
    /// The origin workspace (none for this Mac's own skills or the team).
    pub workspace_id: Option<String>,
    /// The origin's checkout differs from what is committed: the copy takes
    /// the committed version.
    pub uncommitted: bool,
}

// ── Words for a read that failed ────────────────────────────────────

/// A git read that ran out of time (`run_bounded_output`'s `TimedOut`).
fn timed_out(error: &str) -> bool {
    error.contains("TimedOut")
}

/// An error that is git's own text, not one of Plyloft's sentences.
fn raw_git(error: &str) -> bool {
    error.starts_with("git ") || error.contains(" failed: ") || timed_out(error)
}

/// H8 (Windows walk): what a member reads when a git read of `place`'s
/// repository failed — a timeout said plainly, never "isn't a git
/// repository" (that is said only when there is no `.git` at all) and never
/// git's own text, which goes to the log.
pub(crate) fn read_failure(place: &str, error: &str) -> String {
    log::warn!("skills hub: reading {place}'s repository failed ({error})");
    if timed_out(error) {
        format!("Plyloft couldn't read {place}'s committed copy in time. Try again.")
    } else {
        format!("Plyloft couldn't read {place}'s committed copy. Try again.")
    }
}

/// A refusal as it reaches the member: Plyloft's own sentences as they are,
/// git's text (a timeout, a failed step) in plain words.
pub(crate) fn plain(place: &str, error: String) -> String {
    if raw_git(&error) {
        read_failure(place, &error)
    } else {
        error
    }
}

/// `skill` of the workspace `workspace_id`, as committed at its `HEAD`.
fn workspace_source<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, skill: &str) -> Result<CopySource, String> {
    let (name, cwd) = workspace_checkout(app, workspace_id)?;
    if !cwd.is_dir() {
        return Err(format!("{name}'s folder isn't on {THIS_MACHINE} now, so there is nothing to copy from."));
    }
    // "Isn't a git repository" only when there is no `.git` at all; a read
    // that failed (a timeout under load) says so instead (Windows walk).
    let root = crate::skills_index::repo_top(&cwd)
        .ok_or_else(|| format!("{name} isn't a git repository, so Plyloft can't copy a committed version of {skill} from it."))?;
    let prefix = sc::workspace_prefix(&cwd).map_err(|error| read_failure(&name, &error))?;
    let head = crate::library_snapshot::head_commit(&root).map_err(|error| {
        if raw_git(&error) && timed_out(&error) {
            read_failure(&name, &error)
        } else {
            format!("{name} has no commit yet, so there is no committed {skill} to copy.")
        }
    })?;
    let claude = format!("{prefix}{}/{skill}", skill_links::CLAUDE_ROOT);
    let codex = format!("{prefix}{}/{skill}", skill_links::CODEX_ROOT);
    let at = |path: &str| crate::library_snapshot::entry_tree(&root, &head, path).map_err(|error| read_failure(&name, &error));
    let committed = TwinIds { claude: at(&claude)?, codex: at(&codex)?, extra: Default::default() };
    let path = if committed.claude.is_some() {
        claude
    } else if committed.codex.is_some() {
        codex
    } else {
        return Err(format!("{skill} isn't committed in {name} yet. Commit it there first, then copy it."));
    };
    let source = sc::read_source(&root, &head, &path).map_err(|error| plain(&name, error))?;
    let reach = sc::Reach { claude: committed.claude.is_some(), codex: committed.codex.is_some() };
    let uncommitted = !sc::checkout_twin_ids(&cwd, skill).same_ids(&committed);
    let github = crate::shared_config::Plumbing { cwd: cwd.clone() }.github_repo().map(|r| r.to_ascii_lowercase());
    let mut extra = serde_json::Map::new();
    if github.is_none() {
        extra.insert(copy::ORIGIN_WORKSPACE_ID.into(), serde_json::Value::String(workspace_id.to_string()));
        extra.insert(copy::ORIGIN_WORKSPACE_NAME.into(), serde_json::Value::String(name.clone()));
    }
    let origin = LinkOrigin {
        kind: copy::KIND_WORKSPACE.into(),
        source: github.clone().unwrap_or_default(),
        plugin: None,
        name: skill.to_string(),
        path: Some(path),
        version: skill_links::LinkVersion { commit: head, content_id: source.tree.clone(), extra: Default::default() },
        extra,
    };
    Ok(CopySource {
        origin,
        reach,
        repo: root.clone(),
        words: name,
        local: github.is_none(),
        repo_name: crate::skills_index::origin_repo(&cwd).or(github),
        common_dir: crate::skills_index::git_dir(&cwd).map(|d| d.canonicalize().unwrap_or(d)),
        workspace_id: Some(workspace_id.to_string()),
        uncommitted,
        source,
    })
}

/// `skill` of this Mac's own folders, staged in Plyloft's own repository.
fn this_mac_source<R: tauri::Runtime>(app: &tauri::AppHandle<R>, skill: &str) -> Result<CopySource, String> {
    let home = crate::personal_skills::home_dir();
    let (dir, path, reach) = copy::this_mac_skill(&home, skill)
        .ok_or_else(|| format!("{skill} isn't in your own skills folders on {THIS_MACHINE}."))?;
    let stage = copy::stage_repo(&app.state::<WorkspaceStore>().config_dir.clone());
    let (commit, staged) = copy::stage_dir(&stage, skill, &dir).map_err(|error| plain("your own skills", error))?;
    let source = sc::read_source(&stage, &commit, &staged).map_err(|error| plain("your own skills", error))?;
    let origin = LinkOrigin {
        kind: copy::KIND_THIS_MAC.into(),
        source: String::new(),
        plugin: None,
        name: skill.to_string(),
        path: Some(path),
        version: skill_links::LinkVersion { commit: String::new(), content_id: source.tree.clone(), extra: Default::default() },
        extra: Default::default(),
    };
    Ok(CopySource {
        origin,
        reach,
        repo: stage,
        words: "your own skills".into(),
        local: true,
        repo_name: None,
        common_dir: None,
        workspace_id: None,
        uncommitted: false,
        source,
    })
}

/// The team library's `plugin:skill`, as Install reads it (from the clone
/// this Mac has; Install pulls first).
fn team_source<R: tauri::Runtime>(app: &tauri::AppHandle<R>, plugin: &str, skill: &str) -> Result<CopySource, String> {
    let slug = current_team_repo(app).ok_or_else(no_team_message)?;
    let clone = app.state::<crate::team::TeamStore>().clone_dir(&slug);
    if !clone.join(".git").exists() {
        return Err(format!("The team library is not on {THIS_MACHINE} yet."));
    }
    let (entry, path) = team_source_path(&clone, plugin, skill)?;
    let commit = crate::library_snapshot::head_commit(&clone)?;
    let source = sc::read_source(&clone, &commit, &path)?;
    let origin = LinkOrigin {
        kind: skill_links::KIND_TEAM.into(),
        source: slug.clone(),
        plugin: Some(plugin.to_string()),
        name: skill.to_string(),
        path: Some(path),
        version: skill_links::LinkVersion { commit, content_id: source.tree.clone(), extra: Default::default() },
        extra: Default::default(),
    };
    Ok(CopySource {
        origin,
        reach: sc::Reach { claude: entry.claude, codex: entry.codex },
        repo: clone,
        words: "the team library".into(),
        local: false,
        repo_name: None,
        common_dir: None,
        workspace_id: None,
        uncommitted: false,
        source,
    })
}

fn copy_source<R: tauri::Runtime>(app: &tauri::AppHandle<R>, from: &CopyFrom) -> Result<CopySource, String> {
    let skill = crate::project_skills::safe_name(from.skill())?;
    match from {
        CopyFrom::Workspace { workspace_id, .. } => workspace_source(app, workspace_id, &skill),
        CopyFrom::Team { plugin, .. } => team_source(app, plugin, &skill),
        CopyFrom::ThisMac { .. } => this_mac_source(app, &skill),
    }
}

// ── The picker ──────────────────────────────────────────────────────

/// One workspace in the picker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTarget {
    pub workspace_id: String,
    pub name: String,
    /// `owner/name`, when it has a GitHub repository.
    pub repo: Option<String>,
    pub target: Target,
}

/// What the picker shows.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTargets {
    pub skill: String,
    /// "astra", "your own skills", "the team library".
    pub from_words: String,
    pub claude: bool,
    pub codex: bool,
    /// The title each card gets.
    pub card_title: String,
    /// Why the link is kept on this Mac only, when it is.
    pub local_reason: Option<String>,
    /// The origin's checkout has changes that aren't committed.
    pub uncommitted_note: Option<String>,
    pub targets: Vec<CopyTarget>,
}

fn card_title_of(from: &CopySource, skill: &str) -> String {
    if from.origin.kind == skill_links::KIND_TEAM {
        sc::card_title(sc::SkillVerb::Install, skill, &from.origin)
    } else {
        copy::copy_title(skill, &from.words)
    }
}

/// Every other workspace of this Mac, judged for this copy.
fn targets_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>, from: &CopySource) -> Vec<CopyTarget> {
    let skill = from.origin.name.clone();
    let kanban = app.state::<KanbanStore>();
    let origin = OriginOf(from);
    app.state::<WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .filter(|w| Some(&w.id) != from.workspace_id.as_ref())
        .map(|w| {
            let cwd = PathBuf::from(&w.cwd);
            let target = judge_one(app, &kanban, &w.id, &w.name, &cwd, &skill, &origin);
            CopyTarget {
                workspace_id: w.id.clone(),
                name: w.name.clone(),
                repo: crate::skills_index::origin_repo(&cwd),
                target,
            }
        })
        .collect()
}

struct OriginOf<'a>(&'a CopySource);

/// One destination, from what is on disk now ([`copy::judge_target`]).
fn judge_one<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kanban: &KanbanStore,
    workspace_id: &str,
    name: &str,
    cwd: &Path,
    skill: &str,
    from: &OriginOf,
) -> Target {
    let from = from.0;
    let folder_missing = !cwd.is_dir();
    let is_git = !folder_missing && crate::skills_index::repo_top(cwd).is_some();
    // A repository whose read failed (a timeout under load) is not "not a
    // git repository" (Windows walk).
    if is_git {
        if let Err(error) = sc::workspace_prefix(cwd) {
            return Target::Refused { why: read_failure(name, &error) };
        }
    }
    let (links, unreadable, here) = if is_git {
        let read = app_links_here(app, workspace_id, cwd);
        (read.links, read.unreadable, sc::checkout_twin_ids(cwd, skill))
    } else {
        (BTreeMap::new(), Vec::new(), TwinIds::default())
    };
    let on_its_way = if is_git { open_skill_card(kanban, workspace_id, skill).ok().flatten().map(|c| c.title) } else { None };
    let repo = if is_git { crate::skills_index::origin_repo(cwd) } else { None };
    let common = if is_git { crate::skills_index::git_dir(cwd).map(|d| d.canonicalize().unwrap_or(d)) } else { None };
    let to = copy::TargetFacts {
        name,
        folder_missing,
        is_git,
        repo: repo.as_deref(),
        common_dir: common.as_deref(),
        link: links.get(skill),
        unreadable: unreadable.iter().any(|(n, _)| n == skill),
        on_its_way,
        here: &here,
    };
    let origin = copy::OriginFacts {
        words: &from.words,
        repo: from.repo_name.as_deref(),
        common_dir: from.common_dir.as_deref(),
        origin: &from.origin,
        content_id: &from.source.tree,
    };
    match copy::judge_target(&to, &origin, &|o| origin_words_here(app, o)) {
        // A card would commit nothing (its link is no file): linked here.
        Target::SameContent if from.local && here.same_ids(&sc::roots_to_write(from.reach, &here).ids(&from.source.tree)) => {
            Target::LinkHere
        }
        judged => judged,
    }
}

/// H8 Challenger: a destination that already holds exactly what the copy
/// would write, for a link kept on this Mac only — linked at once (no card
/// could carry a commit with nothing in it).
fn link_here_locally(config_dir: &Path, workspace_id: &str, cwd: &Path, skill: &str, from: &CopySource) -> Result<(), String> {
    let here = sc::checkout_twin_ids(cwd, skill);
    let roots = sc::roots_to_write(from.reach, &here);
    let link = sc::link_for(None, &from.origin, &from.source, roots);
    let mut entry = LocalLink::pending_from(&link, "");
    entry.pending = false;
    entry.card_id = None;
    // The same form as every link's `linkedAt` (a date, `skill_links::today`).
    entry.linked_at = Some(skill_links::today());
    crate::skills_hub_state::update(config_dir, chrono::Utc::now().timestamp_millis(), |state| {
        state.local_links.entry(workspace_id.to_string()).or_default().insert(skill.to_string(), entry);
    })?;
    if let Err(error) = crate::skill_bases::store(config_dir, &from.source.tree, &from.source.files) {
        log::warn!("skills hub: couldn't keep the base of {skill} ({error})");
    }
    Ok(())
}

/// **Copy to…**, the picker (R5): every other workspace on this Mac, warm
/// or cold, with what a copy there would do. Read-only; free on every plan.
#[tauri::command]
pub async fn skills_hub_copy_targets<R: tauri::Runtime>(app: tauri::AppHandle<R>, from: CopyFrom) -> Result<CopyTargets, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CopyTargets, String> {
        let source = copy_source(&app, &from)?;
        let skill = source.origin.name.clone();
        Ok(CopyTargets {
            card_title: card_title_of(&source, &skill),
            from_words: source.words.clone(),
            claude: source.reach.claude || !source.reach.codex,
            codex: source.reach.codex || !source.reach.claude,
            local_reason: source.local.then(|| copy::local_reason(&source.origin.kind, &source.words)),
            uncommitted_note: source.uncommitted.then(|| {
                format!("{}'s copy has changes that aren't committed; the copy takes the committed version.", source.words)
            }),
            targets: targets_for(&app, &source),
            skill,
        })
    })
    .await
    .map_err(|error| format!("join copy targets: {error}"))?
}

/// H6b's sheet for a copy: every file it would write, scripts first, when it
/// brings a script or a file that is not text. `None`: nothing to ask.
#[tauri::command]
pub async fn skills_hub_copy_review<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    from: CopyFrom,
) -> Result<Option<crate::skill_scripts::ScriptsReview>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<crate::skill_scripts::ScriptsReview>, String> {
        let source = copy_source(&app, &from)?;
        let config_dir = app.state::<WorkspaceStore>().config_dir.clone();
        let state = crate::skills_hub_state::load(&config_dir);
        let plugin = source.origin.plugin.clone().unwrap_or_default();
        let review = crate::skill_scripts::repo::repo_review_at(
            &source.repo,
            &source.source.commit,
            &plugin,
            &source.origin.name,
            &source.source.path,
            &[],
            &state,
        )?;
        Ok(review)
    })
    .await
    .map_err(|error| format!("join copy review: {error}"))?
}

/// One card Copy to… made.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedCard {
    pub workspace_id: String,
    pub name: String,
    pub card: KanbanCard,
}

/// One destination Copy to… made no card in, and why.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyRefused {
    pub workspace_id: String,
    pub name: String,
    pub why: String,
}

/// One destination linked at once, with no card (a link kept on this Mac
/// to copies it already holds).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyLinked {
    pub workspace_id: String,
    pub name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyMade {
    pub cards: Vec<CopiedCard>,
    pub refused: Vec<CopyRefused>,
    /// H8 Challenger: linked on this Mac at once, no card needed.
    pub linked: Vec<CopyLinked>,
}

/// **Copy to…** (R5): one skill card per workspace in `workspace_ids` that
/// writes a linked copy (`replace`: the workspaces whose different copy of
/// the same name the member chose to replace). Open on every plan. A copy
/// that brings a script or a file that is not text needs the sheet's OK
/// (`scripts_ok`) first, checked against what is read now.
#[tauri::command]
pub async fn skills_hub_copy_to<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    from: CopyFrom,
    workspace_ids: Vec<String>,
    replace: Option<Vec<String>>,
    scripts_ok: Option<Vec<String>>,
) -> Result<CopyMade, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CopyMade, String> {
        let replace = replace.unwrap_or_default();
        if workspace_ids.is_empty() {
            return Err("Pick a workspace to copy it to.".into());
        }
        if let CopyFrom::Team { plugin, skill } = &from {
            return Ok(copy_team(&app, plugin, skill, &workspace_ids, &replace, scripts_ok.as_deref()));
        }
        let source = copy_source(&app, &from)?;
        let skill = source.origin.name.clone();
        // R15 (H6b): never a script the member hasn't seen on the sheet.
        let confirmed = match crate::skill_scripts::repo::repo_answer_at(
            &source.repo,
            &source.source.commit,
            &source.source.path,
            &skill,
            &[],
            scripts_ok.as_deref(),
            &source.words,
        )? {
            crate::skill_scripts::repo::RepoAnswer::Refused(why) => return Err(why),
            crate::skill_scripts::repo::RepoAnswer::Confirmed { .. } => true,
            crate::skill_scripts::repo::RepoAnswer::Clear => false,
        };
        let kanban = app.state::<KanbanStore>();
        let workspaces = app.state::<WorkspaceStore>();
        let listed = workspaces.snapshot().workspaces;
        let origin = OriginOf(&source);
        let mut made = CopyMade { cards: Vec::new(), refused: Vec::new(), linked: Vec::new() };
        let mut seen = BTreeSet::new();
        for id in workspace_ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(w) = listed.iter().find(|w| w.id == id) else {
                made.refused.push(CopyRefused { workspace_id: id, name: "a workspace".into(), why: "It isn't one of Plyloft's workspaces any more.".into() });
                continue;
            };
            let cwd = PathBuf::from(&w.cwd);
            let refuse = |why: String| CopyRefused { workspace_id: w.id.clone(), name: w.name.clone(), why };
            if Some(&w.id) == source.workspace_id.as_ref() {
                made.refused.push(refuse(format!("{skill} comes from {} already.", w.name)));
                continue;
            }
            match judge_one(&app, &kanban, &w.id, &w.name, &cwd, &skill, &origin) {
                Target::Refused { why } => {
                    made.refused.push(refuse(why));
                    continue;
                }
                Target::Replace if !replace.contains(&w.id) => {
                    made.refused.push(refuse(format!(
                        "{} has a different {skill}, and its card would replace it. Choose to replace it first.",
                        w.name
                    )));
                    continue;
                }
                Target::LinkHere => {
                    match link_here_locally(&workspaces.config_dir, &w.id, &cwd, &skill, &source) {
                        Ok(()) => made.linked.push(CopyLinked { workspace_id: w.id.clone(), name: w.name.clone() }),
                        Err(why) => made.refused.push(refuse(why)),
                    }
                    continue;
                }
                _ => {}
            }
            match copy_card(&app, &w.id, &cwd, &skill, &source, confirmed) {
                Ok(card) => made.cards.push(CopiedCard { workspace_id: w.id.clone(), name: w.name.clone(), card }),
                Err(why) => made.refused.push(refuse(plain(&w.name, why))),
            }
        }
        if made.cards.is_empty() && made.linked.is_empty() && made.refused.len() == 1 {
            return Err(made.refused.remove(0).why);
        }
        Ok(made)
    })
    .await
    .map_err(|error| format!("join copy to: {error}"))?
}

/// A team skill copied: the team's Install, into each workspace picked.
fn copy_team<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin: &str,
    skill: &str,
    workspace_ids: &[String],
    replace: &[String],
    scripts_ok: Option<&[String]>,
) -> CopyMade {
    let listed = app.state::<WorkspaceStore>().snapshot().workspaces;
    let mut made = CopyMade { cards: Vec::new(), refused: Vec::new(), linked: Vec::new() };
    for id in workspace_ids {
        let Some(w) = listed.iter().find(|w| &w.id == id) else {
            continue;
        };
        let name = w.name.clone();
        // As for any copy: no card can carry it into a plain folder, and a
        // copy never writes one behind the member's back.
        if sc::workspace_prefix(Path::new(&w.cwd)).is_err() {
            made.refused.push(CopyRefused {
                workspace_id: id.clone(),
                why: format!("{name} isn't a git repository, so there is no card to carry the copy."),
                name,
            });
            continue;
        }
        match install_blocking(app, id, plugin, skill, replace.contains(id), scripts_ok, false) {
            Ok(SkillInstalled::Card { card }) => made.cards.push(CopiedCard { workspace_id: id.clone(), name, card }),
            Ok(SkillInstalled::Written { .. }) => {}
            Err(error) => {
                let why = plain(&name, error.to_string());
                made.refused.push(CopyRefused { workspace_id: id.clone(), name, why })
            }
        }
    }
    made
}

/// The card of one copy into `workspace_id`.
fn copy_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    skill: &str,
    from: &CopySource,
    confirmed: bool,
) -> Result<KanbanCard, String> {
    let workspaces = app.state::<WorkspaceStore>();
    team_gate_github_card_write(&workspaces, &app.state::<crate::license::LicenseStore>(), workspace_id, true)?;
    let kanban = app.state::<KanbanStore>();
    skill_card_refusals(&kanban, workspace_id, cwd, skill, &from.source.tree)?;
    let words = from.words.clone();
    let local = from.local;
    let notes = move |roots: sc::Reach, repo_words: &str| {
        copy::card_notes("copy", skill, &words, local, repo_words, roots.words(), &roots.roots())
    };
    let card_from = CardFrom {
        origin: from.origin.clone(),
        source: &from.source,
        reach: from.reach,
        confirmed,
        scripts_repo: &from.repo,
        place: from.words.clone(),
        title: copy::copy_title(skill, &from.words),
        notes: &notes,
        local: from.local,
        from_words: Some(from.words.clone()),
    };
    let card = make_skill_card(app, workspace_id, cwd, sc::SkillVerb::Copy, skill, &card_from, None)?;
    if let (false, copy::KIND_WORKSPACE, Some(origin_id)) = (from.local, from.origin.kind.as_str(), from.workspace_id.as_deref()) {
        remember_copy_origin(&workspaces.config_dir, &from.origin.source, origin_id);
    }
    // Skills hub H4 (§5.4): the version this card links the copy at.
    if let Err(error) = crate::skill_bases::store(&workspaces.config_dir, &from.source.tree, &from.source.files) {
        log::warn!("skills hub: couldn't keep the base of {skill} ({error})");
    }
    Ok(card)
}

// ── Update of a copy ────────────────────────────────────────────────

/// `(is it Claude's, the other twin's path)` of a workspace skill path
/// `<prefix>.claude/skills/<n>` or `<prefix>.agents/skills/<n>`.
pub(crate) fn other_twin(path: &str) -> Option<(bool, String)> {
    let claude = format!("{}/", skill_links::CLAUDE_ROOT);
    let codex = format!("{}/", skill_links::CODEX_ROOT);
    if let Some(at) = path.rfind(&claude) {
        return Some((true, format!("{}{codex}{}", &path[..at], &path[at + claude.len()..])));
    }
    let at = path.rfind(&codex)?;
    Some((false, format!("{}{claude}{}", &path[..at], &path[at + codex.len()..])))
}

/// What a copy's origin holds now, read for an Update: its committed
/// version (a workspace) or its folder now (this Mac).
pub(crate) fn update_source<R: tauri::Runtime>(app: &tauri::AppHandle<R>, link: &SkillLink, skill: &str) -> Result<CopySource, String> {
    let words = origin_words_here(app, &link.origin);
    let unavailable = || format!("{skill} is linked to {words}, which isn't available on {THIS_MACHINE}.");
    match link.origin.kind.as_str() {
        copy::KIND_THIS_MAC => {
            let mut source = this_mac_source(app, &link.origin.name).map_err(|_| unavailable())?;
            // The folder it was copied from, whatever its name (a path
            // without a personal root is one written before the re-walk fix).
            let rooted = link.origin.path.clone().filter(|p| copy::THIS_MAC_ROOTS.iter().any(|root| p.starts_with(&format!("{root}/"))));
            source.origin.path = rooted.or(source.origin.path);
            Ok(source)
        }
        _ => {
            let (id, name, root) = workspace_origin(app, &link.origin).ok_or_else(unavailable)?;
            let path = link.origin.path.clone().ok_or_else(unavailable)?;
            let head = crate::library_snapshot::head_commit(&root)?;
            let source = sc::read_source(&root, &head, &path)
                .map_err(|_| format!("{name} doesn't have {} committed any more.", link.origin.name))?;
            let at = |p: &str| crate::library_snapshot::entry_tree(&root, &head, p).ok().flatten().is_some();
            let (claude, codex) = match other_twin(&path) {
                Some((true, other)) => (true, at(&other)),
                Some((false, other)) => (at(&other), true),
                None => (true, true),
            };
            let mut origin = link.origin.clone();
            origin.version = skill_links::LinkVersion { commit: head, content_id: source.tree.clone(), extra: Default::default() };
            Ok(CopySource {
                origin,
                reach: sc::Reach { claude, codex },
                repo: root,
                words: name,
                local: copy::origin_workspace_id(&link.origin).is_some(),
                repo_name: None,
                common_dir: None,
                workspace_id: Some(id),
                uncommitted: false,
                source,
            })
        }
    }
}

/// **Update** of a copy from a workspace or this Mac (R5 AC 2): the same
/// rules as the team's (`commands::skills_hub_update`) — never over an edit
/// here unless the member chose *Take upstream* — as a skill card whose link
/// advances when it ships (kept on this Mac for a local one).
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_copy<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    skill: &str,
    link: &SkillLink,
    take_upstream: bool,
    local: bool,
    scripts_ok: Option<&[String]>,
) -> Result<KanbanCard, String> {
    let here = sc::checkout_twin_ids(cwd, skill);
    let from = update_source(app, link, skill)?;
    // As the row reads it: from the version the copy caught up with.
    let origin_repo = (link.origin.kind == copy::KIND_WORKSPACE).then_some(from.repo.as_path());
    let link = super::skills_hub_decisions::effective_link(origin_repo, link, &here, Some((cwd, skill)));
    let modified = skill_links::modified_here(&link, &here);
    if modified && !take_upstream {
        return Err(format!(
            "{skill} was changed in this repository since it was linked, so an update would \
             overwrite that change. Compare shows what differs."
        ));
    }
    let here_is_it = [&here.claude, &here.codex].into_iter().flatten().all(|id| *id == from.source.tree);
    if (!modified && from.source.tree == link.origin.version.content_id) || (modified && here_is_it) {
        return Err(format!("{skill} is already the version {} has.", from.words));
    }
    let target = resolve_base_branch(&app.state::<ProjectConfigStore>(), workspace_id);
    let copies = checkout_copies(cwd, &target, skill);
    let confirmed = match crate::skill_scripts::repo::repo_answer_at(
        &from.repo,
        &from.source.commit,
        &from.source.path,
        skill,
        &copies,
        scripts_ok,
        &from.words,
    )? {
        crate::skill_scripts::repo::RepoAnswer::Refused(why) => return Err(why),
        crate::skill_scripts::repo::RepoAnswer::Confirmed { .. } => true,
        crate::skill_scripts::repo::RepoAnswer::Clear => false,
    };
    let kanban = app.state::<KanbanStore>();
    skill_card_refusals(&kanban, workspace_id, cwd, skill, &from.source.tree)?;
    let words = from.words.clone();
    let notes = move |roots: sc::Reach, repo_words: &str| {
        copy::card_notes("update", skill, &words, local, repo_words, roots.words(), &roots.roots())
    };
    let card_from = CardFrom {
        origin: from.origin.clone(),
        source: &from.source,
        reach: from.reach,
        confirmed,
        scripts_repo: &from.repo,
        place: from.words.clone(),
        title: copy::update_title(skill, &from.words),
        notes: &notes,
        local,
        from_words: Some(from.words.clone()),
    };
    let card = make_skill_card(app, workspace_id, cwd, sc::SkillVerb::Update, skill, &card_from, Some(&link))?;
    let workspaces = app.state::<WorkspaceStore>();
    if let Err(error) = crate::skill_bases::store(&workspaces.config_dir, &from.source.tree, &from.source.files) {
        log::warn!("skills hub: couldn't keep the base of {skill} ({error})");
    }
    Ok(card)
}

/// H6b's sheet for an Update of a copy: what it would write against the
/// copies here.
pub(crate) fn update_review<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    skill: &str,
    link: &SkillLink,
) -> Result<Option<crate::skill_scripts::ScriptsReview>, String> {
    let from = update_source(app, link, skill)?;
    let target = resolve_base_branch(&app.state::<ProjectConfigStore>(), workspace_id);
    let copies = checkout_copies(cwd, &target, skill);
    let config_dir = app.state::<WorkspaceStore>().config_dir.clone();
    let state = crate::skills_hub_state::load(&config_dir);
    crate::skill_scripts::repo::repo_review_at(&from.repo, &from.source.commit, "", skill, &from.source.path, &copies, &state)
}

/// The files of a copy's origin now, for a Compare: a workspace's committed
/// version, or this Mac's folder.
pub(crate) fn origin_files_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, link: &SkillLink, skill: &str) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let from = update_source(app, link, skill)?;
    Ok(from.source.files.iter().map(|f| (f.path.clone(), f.bytes.clone())).collect())
}
