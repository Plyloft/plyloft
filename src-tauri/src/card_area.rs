//! 1.173.0 (B3): a card belongs to one area of its repository.
//!
//! A card's start, Ship, Bring in main's changes, Try it and its pull
//! request's base read the branch of the card's area
//! (`project_config::config_for(store, ws, card.area)`), never the
//! workspace's when the card names an area. What refuses:
//! - **Held**: the repository's areas break the rules and this Mac has no
//!   good copy — every card, with or without an area;
//! - **Unknown**: the card's area is no longer listed;
//! - **No area**: a card without one in a repository with two areas or
//!   more ("Which area is this?"). With a single area listed, a card
//!   without one belongs to it.
//!
//! Exempt from choosing (never from Held): a skill card (its change is the
//! repository's `.claude/skills/`, on the workspace's branch) and a pull
//! request review (its base is the pull request's).
//!
//! Reads that only measure (files changed, the worktree's state for a
//! delete, overlaps, the review's diff) use [`reading_branch`]: the area's
//! branch when the card's area resolves, else the workspace's — a reading
//! never refuses and never sends anything anywhere.
//!
//! Before Ship the card page asks about the files the card changed outside
//! its area ([`outside_files`], scene 4 of the areas mockup); *Leave those
//! out* ([`leave_out`]) puts them back as they are on the card's base in
//! one commit, and the card's checks run again before it can ship.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::areas::{AreaConfig, AreaDef, ResolvedArea};
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore};
use crate::project_config::{ProjectConfig, ProjectConfigStore};

/// A card without an area in a repository with two areas or more.
pub const NEEDS_AREA: &str =
    "Which area is this? Choose one on the card first; nothing was started or shipped.";

/// The card's area is no longer one of the repository's.
pub fn unknown_words(id: &str) -> String {
    format!("This card's area, {id}, isn't in the repository's areas any more. Choose an area.")
}

/// C1: the card's area label didn't reach its issue; Sync tries again.
pub const LABEL_NOT_SENT: &str = "Its area label hasn't reached GitHub yet.";

/// C1: the card's issue has an area label no listed area has.
pub fn unrecognised_label_words(label: &str) -> String {
    format!("Its issue is labeled {label}, which isn't one of this repository's areas. Which area is this?")
}

/// C1: the card's issue has several areas' labels and Plyloft couldn't
/// tell which is meant: "Its issue is labeled area:app and area:site."
pub fn several_labels_words(labels: &[String]) -> String {
    let named = match labels {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    };
    format!("Its issue is labeled {named}. Which area is this?")
}

/// What the card says about its issue's area labels when it has to ask
/// (C1): several areas' labels, or one no listed area has.
fn label_question(card: &KanbanCard, areas: &[ResolvedArea]) -> Option<String> {
    let seen = crate::github_sync::seen_area_labels(card);
    match seen.as_slice() {
        [] => None,
        [label] => (!areas.iter().any(|a| a.label.eq_ignore_ascii_case(label))).then(|| unrecognised_label_words(label)),
        several => Some(several_labels_words(several)),
    }
}

/// The repository's areas can't be used and this Mac has no good copy.
pub fn held_words(problem: &str) -> String {
    let problem = problem.trim().trim_end_matches('.');
    format!("This repository's areas can't be used: {problem}. Fix them in Settings › Project › Areas.")
}

/// Cards that never choose an area (see the module's words): a skill card
/// (`kind`, also while a swarm works on it), a pull request review, and a
/// skill card a Builder or a swarm started on — its start clears `kind`
/// and stamps `area` with [`crate::areas::IMPLICIT_AREA_ID`] ("default",
/// never a listed id): its copy was cut from the workspace's branch, so it
/// ships there (B3 Challenger 9).
pub fn exempt(card: &KanbanCard) -> bool {
    card.kind.is_some() || card.pr_review.is_some() || card.area.as_deref() == Some(crate::areas::IMPLICIT_AREA_ID)
}

/// The area a card made from `card` takes (a follow-up, an implementation
/// card): its area, but never the "default" stamp of a skill card that
/// started building — that card's exemption is its own, and a new card in
/// a repository with areas chooses (B3 Challenger round 2).
///
/// For C1 (Board filter, `area:` labels): read `"default"` as no area —
/// use [`inherited_area`] or [`exempt`], never `card.area` as it is.
pub fn inherited_area(card: &KanbanCard) -> Option<String> {
    card.area.clone().filter(|id| id != crate::areas::IMPLICIT_AREA_ID)
}

/// The start of a skill card stamps it as the workspace's (see [`exempt`]).
pub fn stamp_started_skill_card(card: &mut KanbanCard) {
    if card.area.is_none() {
        card.area = Some(crate::areas::IMPLICIT_AREA_ID.to_string());
    }
}

/// The card has a copy or a branch of its own: it was cut from a branch,
/// whatever its column (a card put back in Not started keeps its copy).
pub fn started(card: &KanbanCard) -> bool {
    card.worktree_path.is_some() || card.branch_name.is_some()
}

/// The branch a started card's copy was cut from (`origin/` taken off),
/// when it is recorded.
pub fn cut_from(card: &KanbanCard) -> Option<String> {
    if !started(card) {
        return None;
    }
    let name = card.worktree_base.as_ref()?.ref_name.trim();
    let name = name.strip_prefix("origin/").unwrap_or(name);
    (!name.is_empty()).then(|| name.to_string())
}

/// Whether `area` may be chosen for `card`: any area for a card with no
/// copy; for a started card, only an area whose cards go to the branch its
/// copy was cut from (or any, when that isn't recorded).
pub fn area_fits(card: &KanbanCard, area: &ResolvedArea) -> bool {
    cut_from(card).is_none_or(|base| area.branch == base)
}

/// Why `area` can't be chosen for a started card.
pub fn misfit_words(card: &KanbanCard, area: &ResolvedArea) -> String {
    let base = cut_from(card).unwrap_or_default();
    format!(
        "This card's copy started from {base}, and {} cards go to {}. Choose an area whose cards go to {base}.",
        area.name, area.branch
    )
}

/// One card's area, as its start and Ship read it.
#[derive(Debug, Clone, PartialEq)]
pub enum CardArea {
    /// No areas (or an exempt card): the workspace's config as it is.
    Workspace(ProjectConfig),
    /// The card's area: its branch and version files.
    Area { area: ResolvedArea, config: ProjectConfig },
    /// No area on a card in a repository with two areas or more.
    NeedsArea,
    /// The card's area is no longer listed.
    Unknown { id: String },
    /// The repository's areas can't be used here.
    Held { problem: String },
}

impl CardArea {
    /// The config to start or ship with; `None` when refused.
    pub fn config(&self) -> Option<&ProjectConfig> {
        match self {
            CardArea::Workspace(config) | CardArea::Area { config, .. } => Some(config),
            _ => None,
        }
    }

    /// Why the card can't start or ship, when it can't.
    pub fn refusal(&self) -> Option<String> {
        match self {
            CardArea::Workspace(_) | CardArea::Area { .. } => None,
            CardArea::NeedsArea => Some(NEEDS_AREA.to_string()),
            CardArea::Unknown { id } => Some(unknown_words(id)),
            CardArea::Held { problem } => Some(held_words(problem)),
        }
    }
}

/// [`CardArea`] from the pieces (pure): `held` is `areas::held`'s answer,
/// `areas` the list this Mac runs with.
pub fn resolve_with(config: &ProjectConfig, areas: &[AreaDef], held: Option<String>, card: &KanbanCard) -> CardArea {
    if let Some(problem) = held {
        return CardArea::Held { problem };
    }
    let id = if exempt(card) { None } else { card.area.as_deref().map(str::trim).filter(|id| !id.is_empty()) };
    // A single area listed: a card without one belongs to it.
    let only = (id.is_none() && !exempt(card) && areas.len() == 1).then(|| areas[0].id.trim().to_string());
    let id = id.map(str::to_string).or(only);
    if id.is_none() && !exempt(card) && areas.len() >= 2 {
        return CardArea::NeedsArea;
    }
    match crate::areas::resolve_config(config, areas, id.as_deref()) {
        AreaConfig::Implicit { config } => CardArea::Workspace(config),
        AreaConfig::Area { area, config } => CardArea::Area { area, config },
        AreaConfig::Unknown { id } => CardArea::Unknown { id },
        AreaConfig::Held { problem } => CardArea::Held { problem },
    }
}

/// The card's area over the workspace's stores; `None` without a project
/// config (the callers' "not set up" path, as before areas).
pub fn resolve(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> Option<CardArea> {
    // Held first, through B1's one entry point (it is Held whatever the id).
    match crate::project_config::config_for(store, workspace_id, None)? {
        AreaConfig::Held { problem } => Some(CardArea::Held { problem }),
        other => {
            let config = other.config()?.clone();
            Some(resolve_with(&config, &crate::areas::for_workspace(store, workspace_id), None, card))
        }
    }
}

/// The config a card starts and ships with: `Ok(None)` without a project
/// config; refused on Held, Unknown and a missing area.
pub fn config_for_card(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> Result<Option<ProjectConfig>, String> {
    match resolve(store, workspace_id, card) {
        None => Ok(None),
        Some(area) => match area.refusal() {
            Some(why) => Err(why),
            None => {
                // 1.175.0 (C5 round 2): the branch this card starts from and
                // ships to is the shared setup's branch, gone from GitHub:
                // refused with the Board notice's words until it moves (a
                // copy cut from a stale ref would start, and only Ship fail).
                if let Some(config) = area.config() {
                    if let Some(why) = crate::move_shared_setup::branch_gone_refusal(store, workspace_id, &config.target_branch) {
                        return Err(why);
                    }
                }
                Ok(area.config().cloned())
            }
        },
    }
}

/// The branch a card starts from and ships to — `main` without a project
/// config, as `resolve_base_branch` — refused as [`config_for_card`].
pub fn branch_for_card(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> Result<String, String> {
    Ok(config_for_card(store, workspace_id, card)?
        .map(|c| c.target_branch)
        .unwrap_or_else(|| "main".to_string()))
}

/// The branch a reading measures a card against: its area's when that
/// resolves, else the workspace's (`main` without a config). Never refuses.
pub fn reading_branch(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> String {
    ReadingBranches::new(store, workspace_id).branch(card)
}

/// [`reading_branch`] for many cards of one workspace (1.174.0 B4, CH-1):
/// the config, the areas and the held answer are read once, and each area
/// is resolved once, instead of re-reading the stores for every card.
pub struct ReadingBranches {
    /// The workspace's branch (`main` without a config): a reading's answer
    /// when the card's area doesn't resolve, or the areas are held.
    fallback: String,
    /// The config and areas to resolve against; `None` without a config or
    /// while the areas are held (every card then reads the fallback).
    stores: Option<(ProjectConfig, Vec<AreaDef>)>,
    /// One answer per area key ([`exempt`], the card's area id).
    memo: std::collections::HashMap<(bool, Option<String>), String>,
}

impl ReadingBranches {
    pub fn new(store: &ProjectConfigStore, workspace_id: &str) -> Self {
        let fallback = store.get(workspace_id).map(|c| c.target_branch).unwrap_or_else(|| "main".to_string());
        // As `resolve`: Held first, through B1's one entry point.
        let stores = match crate::project_config::config_for(store, workspace_id, None) {
            None | Some(AreaConfig::Held { .. }) => None,
            Some(other) => other.config().cloned().map(|c| (c, crate::areas::for_workspace(store, workspace_id))),
        };
        Self { fallback, stores, memo: std::collections::HashMap::new() }
    }

    /// The branch a reading measures `card` against.
    pub fn branch(&mut self, card: &KanbanCard) -> String {
        let Some((config, areas)) = &self.stores else {
            return self.fallback.clone();
        };
        let key = (exempt(card), card.area.as_deref().map(str::trim).map(str::to_string));
        if let Some(hit) = self.memo.get(&key) {
            return hit.clone();
        }
        let branch = match resolve_with(config, areas, None, card) {
            CardArea::Area { config, .. } | CardArea::Workspace(config) => config.target_branch,
            _ => self.fallback.clone(),
        };
        self.memo.insert(key, branch.clone());
        branch
    }
}

// ── Files outside the area ─────────────────────────────────────────────

/// One file a card changed outside its area.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutsideFile {
    /// From the repository's root.
    pub path: String,
    /// A rename's old path; leaving the file out puts both back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// The area it belongs to (`None`: no area holds it).
    pub area: Option<String>,
    /// "whole repository", or the other area's name.
    pub belongs: String,
}

/// One change of the card: a path, and a rename's old path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub from: Option<String>,
}

/// The words for a file of the root area, or of none.
pub const WHOLE_REPOSITORY: &str = "whole repository";

/// The files of `paths` (root-relative) outside `card_area`'s folder or in
/// another area's. For the root area, only the files inside another
/// area's folder.
pub fn outside_files(areas: &[AreaDef], card_area: &str, paths: &[String]) -> Vec<OutsideFile> {
    let changes: Vec<Change> = paths.iter().map(|p| Change { path: p.clone(), from: None }).collect();
    outside_changes(areas, card_area, &changes)
}

/// [`outside_files`] over changes with renames: a rename is outside when
/// either side is; it is named by the side outside (its new path first).
pub fn outside_changes(areas: &[AreaDef], card_area: &str, changes: &[Change]) -> Vec<OutsideFile> {
    let resolved = crate::areas::resolve(areas, "");
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for change in changes {
        let path = crate::areas::normalize_path(&change.path);
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        let from = change.from.as_deref().map(crate::areas::normalize_path).filter(|f| !f.is_empty());
        let to_owner = crate::areas::area_of_path(areas, &path);
        let from_owner = from.as_deref().map(|f| crate::areas::area_of_path(areas, f));
        let owner = if to_owner.as_deref() != Some(card_area) {
            to_owner
        } else {
            match from_owner {
                Some(owner) if owner.as_deref() != Some(card_area) => owner,
                _ => continue,
            }
        };
        let area = owner.as_deref().and_then(|id| resolved.iter().find(|a| a.id == id));
        let belongs = match area {
            Some(a) if !a.root => a.name.clone(),
            _ => WHOLE_REPOSITORY.to_string(),
        };
        out.push(OutsideFile { path, from, area: owner, belongs });
    }
    out
}

/// The area the changed `paths` point to, when every one is in the same
/// area — the choice "Which area is this?" starts on.
pub fn suggested_area(areas: &[AreaDef], paths: &[String]) -> Option<String> {
    let mut owners = paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| crate::areas::area_of_path(areas, &crate::areas::normalize_path(p)));
    let first = owners.next()??;
    owners.all(|o| o.as_deref() == Some(first.as_str())).then_some(first)
}

/// "A", "A and B", "A, B and C".
fn list_words(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The sheet's sentence under the files: where they would go, and ahead
/// of whose work.
pub fn outside_hint(areas: &[ResolvedArea], card_area: &ResolvedArea, files: &[OutsideFile]) -> String {
    let mut ahead: Vec<&ResolvedArea> = Vec::new();
    for file in files {
        let Some(a) = file.area.as_deref().and_then(|id| areas.iter().find(|a| a.id == id)) else {
            continue;
        };
        if a.branch != card_area.branch && !ahead.iter().any(|known| known.id == a.id) {
            ahead.push(a);
        }
    }
    let to = &card_area.branch;
    match ahead.as_slice() {
        [] => format!("If they ship with this card, they reach {to} as part of {}'s change.", card_area.name),
        [one] => format!(
            "If they ship with this card, they reach {to} before the rest of {}'s work on {}.",
            one.name, one.branch
        ),
        many => {
            let names: Vec<String> = many.iter().map(|a| a.name.clone()).collect();
            format!("If they ship with this card, they reach {to} before the rest of the work of {}.", list_words(&names))
        }
    }
}

/// What the sheet before Ship shows.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutsideFiles {
    pub area: ResolvedArea,
    pub files: Vec<OutsideFile>,
    pub hint: String,
}

/// Every file the card changed since its base: committed on its branch,
/// staged, edited or new — renames as their two sides (`--no-renames`), so
/// putting one back restores the old path and drops the new.
pub fn changed_paths(worktree: &Path, base: &str) -> Result<Vec<String>, String> {
    let mut paths: BTreeSet<String> = BTreeSet::new();
    let out = crate::git::capture(worktree, &["diff", "--name-only", "--no-renames", "-z", base])?;
    paths.extend(out.split('\0').filter(|p| !p.is_empty()).map(str::to_string));
    let untracked = crate::git::capture(worktree, &["ls-files", "--others", "--exclude-standard", "--full-name", "-z"])?;
    paths.extend(untracked.split('\0').filter(|p| !p.is_empty()).map(str::to_string));
    Ok(paths.into_iter().collect())
}

/// Every change of the card since its base with renames paired (`-M`):
/// committed, staged or edited, and new files as added.
pub fn changed_entries(worktree: &Path, base: &str) -> Result<Vec<Change>, String> {
    let out = crate::git::capture(worktree, &["diff", "-M", "--name-status", "-z", base])?;
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = parts.next() {
        let renamed = status.starts_with('R') || status.starts_with('C');
        let Some(first) = parts.next() else { break };
        if renamed {
            let Some(second) = parts.next() else { break };
            let from = status.starts_with('R').then(|| first.to_string());
            changes.push(Change { path: second.to_string(), from });
        } else {
            changes.push(Change { path: first.to_string(), from: None });
        }
    }
    let untracked = crate::git::capture(worktree, &["ls-files", "--others", "--exclude-standard", "--full-name", "-z"])?;
    changes.extend(untracked.split('\0').filter(|p| !p.is_empty()).map(|p| Change { path: p.to_string(), from: None }));
    Ok(changes)
}

/// The commit the card's copy left its target at (recorded, else GitHub's
/// target, else the local one).
fn card_base(worktree: &Path, card: &KanbanCard, target: &str) -> Option<String> {
    crate::worktrees::card_diff_base(worktree, "HEAD", card.worktree_base.as_ref(), target)
}

fn toplevel(worktree: &Path) -> Result<PathBuf, String> {
    Ok(PathBuf::from(crate::git::capture(worktree, &["rev-parse", "--show-toplevel"])?.trim()))
}

// ── Leave those out ────────────────────────────────────────────────────

/// What *Leave those out* did.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeaveOut {
    /// The files put back as they are on the card's base.
    pub left_out: Vec<String>,
    /// The commit that leaves them out (`None`: nothing changed).
    pub sha: Option<String>,
    /// The card has a Builder: its Finish and check records the commit and
    /// runs the checks; else the checks run on the commit.
    pub builder: bool,
}

/// Refused while the card's Builder is in a turn: it could change the files.
pub const LEAVE_OUT_BUILDER_WORKING: &str =
    "The card's Builder is working; nothing was changed. Leave those files out once its turn is over.";

/// Refused when the card's copy has edits since its last Finish and check.
pub const LEAVE_OUT_UNSAVED: &str =
    "The card's copy has changes since the last Finish and check. Press Finish and check first, then leave those files out.";

/// *Leave those out*: `paths` (root-relative) put back in the card's copy as
/// they are at `base` — a file the card added is removed — and committed as
/// `chore: leave out files outside <Area>`. Only paths the card changed
/// are touched; anything else asked for is ignored.
pub fn leave_out(worktree: &Path, base: &str, area_name: &str, paths: &[String]) -> Result<(Vec<String>, Option<String>), String> {
    let top = toplevel(worktree)?;
    let changed: BTreeSet<String> = changed_paths(&top, base)?.into_iter().collect();
    let renames = changed_entries(&top, base)?;
    let mut asked: BTreeSet<String> = paths.iter().map(|p| crate::areas::normalize_path(p)).collect();
    // A rename goes back whole: its new path and its old one.
    for change in &renames {
        if let Some(from) = &change.from {
            if asked.contains(&change.path) || asked.contains(from) {
                asked.insert(change.path.clone());
                asked.insert(from.clone());
            }
        }
    }
    let wanted: Vec<String> = asked.into_iter().filter(|p| changed.contains(p)).collect();
    if wanted.is_empty() {
        return Ok((Vec::new(), None));
    }
    for path in &wanted {
        let spec = format!(":(top,literal){path}");
        let at_base = crate::git::capture(&top, &["cat-file", "-e", &format!("{base}:{path}")]).is_ok();
        if at_base {
            crate::git::run(&top, &["checkout", base, "--", &spec])?;
        } else {
            // A file HEAD has stays in the index, so the commit below
            // records it removed; one only staged leaves the index here.
            let in_head = crate::git::capture(&top, &["cat-file", "-e", &format!("HEAD:{path}")]).is_ok();
            if !in_head {
                crate::git::run(&top, &["rm", "-q", "-r", "-f", "--cached", "--ignore-unmatch", "--", &spec])?;
            }
            let file = top.join(path);
            if file.is_dir() {
                let _ = std::fs::remove_dir_all(&file);
            } else if file.exists() {
                std::fs::remove_file(&file).map_err(|e| format!("couldn't remove {path}: {e}"))?;
            }
        }
    }
    // Only those paths are committed: what else is staged in the copy stays
    // as it was (B3 Challenger 5). A path that differs from HEAD no more
    // (an uncommitted edit put back) has nothing to commit.
    let specs: Vec<String> = wanted.iter().map(|p| format!(":(top,literal){p}")).collect();
    let mut diff: Vec<&str> = vec!["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"];
    diff.extend(specs.iter().map(String::as_str));
    // Literal pathspecs: a name like `a[1].txt` is that file, never a
    // pattern that would also commit `a1.txt` (round 2).
    let differ: Vec<String> = crate::git::capture(&top, &diff)?
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(|p| format!(":(literal){p}"))
        .collect();
    if differ.is_empty() {
        return Ok((wanted, None));
    }
    let subject = crate::commit_message::leave_out_subject(area_name);
    // Paths from the copy's top, as the index names them (a deleted one is
    // recorded as deleted).
    let mut args: Vec<&str> = vec!["-m", &subject, "--only", "--"];
    args.extend(differ.iter().map(String::as_str));
    crate::git::commit(&top, &args).map_err(|f| f.text())?;
    Ok((wanted, Some(crate::worktrees::head_sha(&top)?)))
}

// ── IPC ────────────────────────────────────────────────────────────────

/// The card page's reading of a card's area.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardAreaState {
    /// `none` (fewer than two areas, or an exempt card: nothing to show),
    /// `area`, `needsArea`, `unknown` or `held`.
    pub kind: String,
    /// The repository's areas, with their defaults.
    pub areas: Vec<ResolvedArea>,
    /// The card's area, on `area`.
    pub area: Option<ResolvedArea>,
    /// C1: "Its area label hasn't reached GitHub yet." on `area`, while
    /// a push of its issue's area label failed in this session.
    pub label_line: Option<String>,
    /// What the card says on `needsArea`, `unknown` and `held`.
    pub sentence: Option<String>,
    /// The area the card's changed files point to, when all are in one.
    pub suggested: Option<String>,
    /// The area can be chosen or changed now.
    pub editable: bool,
    /// The ids that may be chosen: every area for a card with no copy; for
    /// a started card, the areas whose cards go to the branch its copy was
    /// cut from (B3 Challenger 3). The others are shown, not choosable.
    pub fits: Vec<String>,
}

/// Whether the card's area can be set now: while it is Not started, or
/// when it has none (or an unlisted one) to choose — never under Held.
pub fn can_set(card: &KanbanCard, area: &CardArea) -> bool {
    match area {
        CardArea::Held { .. } | CardArea::Workspace(_) => false,
        CardArea::NeedsArea | CardArea::Unknown { .. } => true,
        // A card put back in Not started keeps its copy: it has started.
        CardArea::Area { .. } => card.column_id == KanbanColumnId::Todo && !card.archived && !started(card),
    }
}

/// A card that is over (Done, archived, shipped) and never had an area
/// says nothing about areas (UX: show only where it applies).
fn over_without_area(card: &KanbanCard) -> bool {
    card.area.is_none()
        && (card.column_id == KanbanColumnId::Complete
            || card.archived
            || card.ship_status == crate::kanban::ShipStatus::Shipped)
}

fn worktree_of(card: &KanbanCard) -> Option<PathBuf> {
    card.worktree_path.as_deref().map(PathBuf::from).filter(|p| p.is_dir())
}

/// The config a card's area is read against — the area line and choosing
/// an area, never Start or Ship (they keep `resolve`'s "not set up").
/// 1.174.0 (C10 walk, step 13): a project not set up yet (no build
/// settings) can still have areas — kept on this Mac, or the repository's —
/// and its cards say and choose theirs: a skeleton config with no branch
/// ("cards go to the project's branch"). `None` without either.
/// The `bool` says it is that skeleton: no branch to check a copy against.
pub fn area_config(config: Option<&ProjectConfig>, areas: &[AreaDef], held: bool) -> Option<(ProjectConfig, bool)> {
    match config {
        Some(config) => Some((config.clone(), false)),
        None if areas.len() >= 2 || held => {
            Some((crate::project_config::template_config_skeleton("", Vec::new(), None, None), true))
        }
        None => None,
    }
}

/// [`CardAreaState`] (pure but for the changed files `paths`).
pub fn state_of(config: Option<&ProjectConfig>, areas: &[AreaDef], held: Option<String>, card: &KanbanCard, paths: impl FnOnce() -> Vec<String>) -> CardAreaState {
    let Some((config, unset)) = area_config(config, areas, held.is_some()) else {
        return CardAreaState { kind: "none".into(), ..Default::default() };
    };
    let config = &config;
    let resolved = crate::areas::resolve(areas, &config.target_branch);
    let area = resolve_with(config, areas, held, card);
    if over_without_area(card) && !matches!(area, CardArea::Held { .. }) {
        return CardAreaState { kind: "none".into(), ..Default::default() };
    }
    let editable = can_set(card, &area);
    // Not set up: no branch to hold a copy against, so every area fits.
    let fits = resolved.iter().filter(|a| unset || area_fits(card, a)).map(|a| a.id.clone()).collect();
    let mut state = CardAreaState { areas: resolved, editable, fits, ..Default::default() };
    match &area {
        CardArea::Held { .. } => {
            state.kind = "held".into();
            state.sentence = area.refusal();
        }
        CardArea::Workspace(_) => state.kind = "none".into(),
        // One area: nothing to choose, nothing shown (UX: areas show with 2+).
        CardArea::Area { .. } if areas.len() < 2 => state.kind = "none".into(),
        CardArea::Area { area, .. } => {
            state.kind = "area".into();
            state.area = Some(area.clone());
            // Only while it is still due (Challenger round 2).
            let due = || {
                crate::github_sync::area_label_to_push(card, &crate::github_sync::AreaLabels::new(state.areas.clone())).is_some()
            };
            if card.gh_issue_number.is_some() && crate::github_sync::area_label_failed(&card.workspace_id, &card.id) && due() {
                state.label_line = Some(LABEL_NOT_SENT.to_string());
            }
        }
        CardArea::NeedsArea | CardArea::Unknown { .. } => {
            state.kind = if matches!(area, CardArea::NeedsArea) { "needsArea" } else { "unknown" }.into();
            state.sentence = Some(match &area {
                CardArea::Unknown { id } => unknown_words(id),
                _ => label_question(card, &state.areas).unwrap_or_else(|| "Which area is this?".to_string()),
            });
            state.suggested = suggested_area(areas, &paths());
            if state.fits.is_empty() {
                let base = cut_from(card).unwrap_or_default();
                state.sentence = Some(format!(
                    "This card's copy started from {base}, and no area's cards go there. Delete it and make the card again in its area."
                ));
            }
        }
    }
    state
}

fn card_paths(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> Vec<String> {
    let Some(wt) = worktree_of(card) else { return Vec::new() };
    let target = store.get(workspace_id).map(|c| c.target_branch).unwrap_or_else(|| "main".to_string());
    card_base(&wt, card, &target)
        .and_then(|base| changed_paths(&wt, &base).ok())
        .unwrap_or_default()
}

/// The card page's area line (`cardAreaState`). Off the main thread: it may
/// read the card's changed files.
#[tauri::command(async)]
pub fn card_area_state(app: tauri::AppHandle, workspace_id: String, card_id: String) -> Result<CardAreaState, String> {
    let store = app.state::<ProjectConfigStore>();
    let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
    Ok(state_for(&store, &workspace_id, &card))
}

pub fn state_for(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> CardAreaState {
    let config = store.get(workspace_id);
    let areas = crate::areas::for_workspace(store, workspace_id);
    let held = crate::areas::held(store, workspace_id);
    state_of(config.as_ref(), &areas, held, card, || card_paths(store, workspace_id, card))
}

/// Set a card's area (`area` is a listed id). Refused under Held, for an
/// unlisted id, and once the card started with an area it has.
pub fn set_area(store: &ProjectConfigStore, kanban: &KanbanStore, workspace_id: &str, card_id: &str, area: &str) -> Result<KanbanCard, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    let areas = crate::areas::for_workspace(store, workspace_id);
    let held = crate::areas::held(store, workspace_id);
    if let Some(problem) = &held {
        return Err(held_words(problem));
    }
    // The area line's own read (`area_config`): a project not set up yet
    // chooses among its areas too; Start still says it isn't set up.
    let config = store.get(workspace_id);
    let (config, unset) =
        area_config(config.as_ref(), &areas, false).ok_or_else(|| "This project isn't set up yet.".to_string())?;
    let resolved = resolve_with(&config, &areas, None, &card);
    if let CardArea::Held { problem } = &resolved {
        return Err(held_words(problem));
    }
    let id = area.trim();
    if !areas.iter().any(|a| a.id.trim() == id) {
        return Err(unknown_words(id));
    }
    if card.area.as_deref() == Some(id) {
        return Ok(card);
    }
    if !can_set(&card, &resolved) {
        return Err("This card has started in its area, so its area stays as it is.".into());
    }
    // A started card's copy was cut from one branch: only an area whose
    // cards go there (B3 Challenger 3).
    let workspace_branch = config.target_branch.clone();
    if let Some(chosen) = crate::areas::resolve(&areas, &workspace_branch).into_iter().find(|a| a.id == id) {
        // Not set up: no branch to hold a copy against (as the line's fits).
        if !unset && !area_fits(&card, &chosen) {
            return Err(misfit_words(&card, &chosen));
        }
    }
    kanban.with_card(workspace_id, card_id, |c| {
        c.area = Some(id.to_string());
        Ok(())
    })?;
    kanban.get_card(workspace_id, card_id)
}

/// `kanbanCardSetArea`: choose or change a card's area. On a GitHub Issues
/// board its issue's area label follows (C1): the new one on, the old off.
#[tauri::command]
pub fn kanban_card_set_area(app: tauri::AppHandle, workspace_id: String, card_id: String, area: String) -> Result<KanbanCard, String> {
    // A card of a GitHub Issues board is the team's: the Team gate first,
    // as every card write there (its issue's label changes too).
    crate::commands::team_gate_github_card_write(
        &app.state::<crate::workspace::WorkspaceStore>(),
        &app.state::<crate::license::LicenseStore>(),
        &workspace_id,
        true,
    )?;
    let card = set_area(&app.state::<ProjectConfigStore>(), &app.state::<KanbanStore>(), &workspace_id, &card_id, &area)?;
    crate::kanban::emit_kanban_changed(&app, &workspace_id);
    crate::commands::gh_push_area_label_soon(&app, &workspace_id, &card_id);
    Ok(card)
}

/// The area a new card is made in: `requested` when listed, `None` without
/// one (and in a repository without areas). An unlisted id is refused.
pub fn area_for_new_card(store: &ProjectConfigStore, workspace_id: &str, requested: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let areas = crate::areas::for_workspace(store, workspace_id);
    if areas.iter().any(|a| a.id.trim() == id) {
        Ok(Some(id.to_string()))
    } else {
        Err(unknown_words(id))
    }
}

/// The sheet before Ship (`cardOutsideFiles`): `None` when the card has no
/// area to be outside of (no areas, one area, exempt, refused — Ship says
/// why) or no copy; else its files outside the area (maybe none).
pub fn outside_for(store: &ProjectConfigStore, workspace_id: &str, card: &KanbanCard) -> Option<OutsideFiles> {
    let areas = crate::areas::for_workspace(store, workspace_id);
    // Two builds and no pick yet: nothing to ship, nothing to ask (Ship
    // refuses it in its own words).
    if areas.len() < 2 || crate::build_both::is_undecided(card) {
        return None;
    }
    let CardArea::Area { area, config } = resolve(store, workspace_id, card)? else {
        return None;
    };
    let wt = worktree_of(card)?;
    let base = card_base(&wt, card, &config.target_branch)?;
    let changes = changed_entries(&wt, &base).ok()?;
    let files = outside_changes(&areas, &area.id, &changes);
    let resolved = crate::areas::resolve(&areas, &store.get(workspace_id)?.target_branch);
    let hint = outside_hint(&resolved, &area, &files);
    Some(OutsideFiles { area, files, hint })
}

#[tauri::command(async)]
pub fn card_outside_files(app: tauri::AppHandle, workspace_id: String, card_id: String) -> Result<Option<OutsideFiles>, String> {
    let card = app.state::<KanbanStore>().get_card(&workspace_id, &card_id)?;
    Ok(outside_for(&app.state::<ProjectConfigStore>(), &workspace_id, &card))
}

/// *Leave those out* on a card: refused under its Builder's turn and with
/// edits since its last Finish and check (a Builder card); the card's
/// checks are then the page's to run (`LeaveOut::builder`).
pub fn leave_out_card(
    store: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    paths: &[String],
    session_live: bool,
) -> Result<LeaveOut, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    if crate::build_both::is_undecided(&card) {
        return Err(crate::build_both::UNDECIDED_REFUSAL.into());
    }
    let resolved = resolve(store, workspace_id, &card).ok_or_else(|| "This project isn't set up yet.".to_string())?;
    if let Some(why) = resolved.refusal() {
        return Err(why);
    }
    let CardArea::Area { area, config } = resolved else {
        return Err("This card's repository has no areas; nothing was changed.".into());
    };
    let wt = worktree_of(&card).ok_or_else(|| "This card has no copy of the repository.".to_string())?;
    if card.last_run_status == Some(crate::kanban::LastRunStatus::Running) && session_live {
        return Err(LEAVE_OUT_BUILDER_WORKING.into());
    }
    if crate::ship_conflict::merge_pending(&wt).is_some() {
        return Err(crate::builder::MERGE_PENDING.into());
    }
    let builder = card.builder.is_some();
    if builder && crate::worktrees::worktree_is_dirty(&wt)? {
        return Err(LEAVE_OUT_UNSAVED.into());
    }
    let base = card_base(&wt, &card, &config.target_branch)
        .ok_or_else(|| format!("Plyloft couldn't find where this card's branch left {}.", config.target_branch))?;
    // Ship reads a pass on the commit it publishes only (`ship_decision`):
    // the new commit ships once its own checks pass.
    let (left_out, sha) = leave_out(&wt, &base, &area.name, paths)?;
    Ok(LeaveOut { left_out, sha, builder })
}

/// `cardLeaveOutFiles`: never beside a Ship of this workspace.
#[tauri::command]
pub async fn card_leave_out_files(app: tauri::AppHandle, workspace_id: String, card_id: String, paths: Vec<String>) -> Result<LeaveOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ship = crate::commands::hold_ship_lock(&app, &workspace_id)?;
        let live = app.state::<crate::builder::BuilderRegistry>().get_pty(&card_id).is_some();
        let out = leave_out_card(
            &app.state::<ProjectConfigStore>(),
            &app.state::<KanbanStore>(),
            &workspace_id,
            &card_id,
            &paths,
            live,
        );
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        out
    })
    .await
    .map_err(|e| format!("leave out worker failed: {e}"))?
}

#[cfg(test)]
#[path = "card_area_tests.rs"]
mod tests;
