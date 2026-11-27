//! 1.173.0 (E1): Next improvement's **direction**, kept in the repository.
//!
//! **The file.** `.atelier/next-improvement/<area>.json`, one per area
//! (`<area>` is the area's id, or [`areas::IMPLICIT_AREA_ID`] `default` for a
//! repository without areas): `{schemaVersion, audience, better, avoid,
//! lookAt, approaches, proposer?, rejected: [{title, reason, at, by?,
//! device?}]}`. Every field is `serde(default)` and unknown keys are kept
//! (`extra`), here and in each rejected entry, so a file a newer Plyloft
//! wrote survives a rewrite by this one. `approaches` keeps values this build
//! doesn't know for the same reason; the editor offers [`APPROACHES`].
//!
//! **Read from the branch.** A shared workspace's direction is the file at
//! the fetched tip of the integration branch (`origin/<branch>`, the branch
//! the shared definition lives on), never the checkout, with this Mac's
//! queued change laid over it. A read-only Mac (`WriteAccess::read_only`)
//! reads it and can't save, with the reason.
//!
//! **Kept on this computer (E6, owner 2026-10-30).** A workspace that shares
//! no setup (solo, or not shared yet) keeps its direction in Plyloft's own
//! data: `projects/<ws>/next_improvement/direction/<area>.json`, the same
//! schema, written atomically, never in the repository and never through git.
//! One resolver, [`place`], decides between the two; the presses
//! ([`record`]), the view, the draft and the round ([`direction_for`]) all go
//! through it. When the setup becomes shared, every refresh's [`drain`]
//! moves the local file into the queue ([`adopt_local`], then removes it);
//! the publish takes it only while the branch has no direction for that area
//! — one already there wins, the local one is dropped, and the view says so
//! once (`notice`, cleared by [`ni_direction_notice_seen`]).
//!
//! **Written only on a press** (a shared workspace). *Save*, *Don't propose this…* and *Remove*
//! queue the whole file in `projects/<ws>/next_improvement_queue.json`
//! (atomic) and publish it at once through the shared-config channel's
//! plumbing (`shared_config::Plumbing`: a commit onto the fetched tip,
//! `check_path` — the file is under `.atelier/` — then `git push origin
//! <sha>:<branch>`, under `integration_lock`). The checkout is never touched.
//! Message `chore(config): next improvement direction — <area>` (a single
//! *Don't propose this…* says `chore(config): next improvement — set aside
//! “<title>” (<area>)`, a single *Remove* `… — “<title>” can be proposed
//! again (<area>)`), the lines of what changed after it, and the `Plyloft-Device` trailer. A queued
//! change is retried by every definition refresh ([`drain`]).
//!
//! **Asked, never overwritten silently (C3's rule, C3's question).** Each
//! queued change keeps the direction it was made against (`base`). At
//! publish the tip's file is merged field by field: a field only this Mac
//! changed goes in, a field only the branch changed is kept, and a field
//! both changed to different values is held as a [`FieldConflict`] — every
//! other field still goes. The question is C3's own: a `SettingConflict`
//! "Next improvement · <field> (<area>)" with the field id
//! `ni-<area>-<field>` in `workspace_definition_get`'s `conflicts`, the
//! `SettingConflictHost` sheet and the Inbox's `shared_setting_conflict` row;
//! the answer (`workspace_definition_resolve_conflict`, with the question as
//! shown) puts this Mac's over
//! exactly the value shown, or keeps theirs ([`resolve`]). The rejected list
//! never conflicts: entries added on either side are kept, an entry is
//! removed only when this Mac removed it, and setting ideas aside goes on
//! while a question waits.
//!
//! **Refused.** A non-fast-forward is retried once from a fresh fetch. A
//! refusal pushes `atelier/config-next-improvement-<area>-<ts>` (the next
//! `-2`, `-3`… name when taken; never forced) and opens a pull request
//! `Settings: Next improvement direction — <area>`. A press while it is open
//! adds a commit on top of its branch's tip (a fast-forward); a merge
//! settles it, a close forgets it. No GitHub CLI: the refusal is recorded as
//! this Mac's write access (`push_refused`), so the direction reads as
//! read-only, and a read-only Mac publishes nothing.
//!
//! **Reading needs no lock**: `ni_direction_get` and the view after a press
//! read atomic files and git without writing.
//!
//! **The draft** ([`draft`]) is a pure function over README.md and
//! package.json (a file over [`DRAFT_INPUT_MAX`] is not read), plus "Where
//! to look at it" from the area's `lookAt`, the Railway service of this
//! repository (D1's Railway reading only, cached), package.json's `homepage`
//! or the README. "What better means" is never drafted. It is shown, never
//! written, until the person saves.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::areas::{self, IMPLICIT_AREA_ID};
use crate::project_config::ProjectConfigStore;
use crate::setting_conflict::SettingConflict;
use crate::shared_config::{
    integration_lock, pr_number, FetchFailure, FileChange, Gh, Plumbing, PrState, PullRequest,
    PushResult, DEVICE_TRAILER, REFUSED_MARKER,
};

/// The directory every direction lives in, from the repository root.
pub const DIRECTION_DIR: &str = ".atelier/next-improvement";
pub const DIRECTION_SCHEMA_VERSION: u32 = 1;
pub const QUEUE_FILENAME: &str = "next_improvement_queue.json";
const QUEUE_SCHEMA_VERSION: u32 = 1;
/// The approaches the editor offers, in its order (E5 and E2 read it).
#[allow(dead_code)]
pub const APPROACHES: [&str; 4] = ["polish", "simplify", "grow", "fix"];
/// Who may propose.
pub const PROPOSERS: [&str; 2] = ["claude", "codex"];
/// The longest answer kept for each of the three text fields.
pub const TEXT_MAX: usize = 1000;
pub const TITLE_MAX: usize = 200;
pub const REASON_MAX: usize = 300;
/// The most rejected ideas one area keeps.
pub const REJECTED_MAX: usize = 500;
/// At most this much of each file is read for the draft.
pub const DRAFT_INPUT_MAX: usize = 64 * 1024;
/// Emitted with `{workspaceId, area}` after the direction changed here.
pub const DIRECTION_EVENT: &str = "ni://direction";
/// The draft's "What you don't want", the rules every proposal keeps anyway.
pub const DEFAULT_AVOID: &str = "Pop-ups, countdowns, fake scarcity. Claims we can't prove.";
/// The draft's approach.
const DEFAULT_APPROACH: &str = "polish";
/// The last lines of what changed kept for the commit message.
const LINES_MAX: usize = 20;

fn default_schema() -> u32 {
    DIRECTION_SCHEMA_VERSION
}

/// `.atelier/next-improvement/<area>.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Direction {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    /// For whom.
    #[serde(default)]
    pub audience: String,
    /// What "better" means here.
    #[serde(default)]
    pub better: String,
    /// What you don't want.
    #[serde(default)]
    pub avoid: String,
    /// Where to look at it: a web address, "" for none (the proposer then
    /// reads only the code and the web, and says so).
    #[serde(default)]
    pub look_at: String,
    /// One or more of [`APPROACHES`]; unknown values are kept.
    #[serde(default)]
    pub approaches: Vec<String>,
    /// `claude` or `codex`; absent = whichever is installed (E2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposer: Option<String>,
    /// Not to propose again.
    #[serde(default)]
    pub rejected: Vec<Rejected>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for Direction {
    fn default() -> Self {
        Direction {
            schema_version: DIRECTION_SCHEMA_VERSION,
            audience: String::new(),
            better: String::new(),
            avoid: String::new(),
            look_at: String::new(),
            approaches: Vec::new(),
            proposer: None,
            rejected: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

impl Direction {
    /// Nothing written in it yet (the rejected list aside). For E2/E3.
    pub fn is_blank(&self) -> bool {
        self.audience.trim().is_empty()
            && self.better.trim().is_empty()
            && self.avoid.trim().is_empty()
            && self.look_at.trim().is_empty()
            && self.approaches.is_empty()
    }
}

/// An idea the person said not to propose again, and why.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub reason: String,
    /// Milliseconds.
    #[serde(default)]
    pub at: i64,
    /// Who said so (the commit identity's name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// The computer it was said on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// The repository path of one area's direction.
pub fn direction_path(area: &str) -> String {
    format!("{DIRECTION_DIR}/{area}.json")
}

/// The file's bytes as Plyloft writes them.
pub fn direction_bytes(direction: &Direction) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(direction).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text.into_bytes()
}

/// A file that isn't a direction is never written over: the reason, to fix it
/// in the repository first.
pub fn parse_direction(bytes: &[u8]) -> Result<Direction, String> {
    serde_json::from_slice::<Direction>(bytes).map_err(|e| format!("isn't a direction Plyloft can read ({e})"))
}

/// One line, trimmed, at most `max` characters.
fn one_line(text: &str, max: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(max).collect()
}

fn clipped(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// What *Save* writes: trimmed and capped, approaches without repeats, a
/// proposer Plyloft knows, a web address or nothing. The rejected list is
/// kept as given (its own presses change it).
pub fn normalized_for_save(mut d: Direction) -> Result<Direction, String> {
    d.schema_version = d.schema_version.max(DIRECTION_SCHEMA_VERSION);
    d.audience = clipped(&d.audience, TEXT_MAX);
    d.better = clipped(&d.better, TEXT_MAX);
    d.avoid = clipped(&d.avoid, TEXT_MAX);
    d.look_at = d.look_at.trim().to_string();
    if !d.look_at.is_empty() && !areas::valid_web_address(&d.look_at) {
        return Err(format!(
            "Where to look at it must be a web address (https://…), not “{}”.",
            d.look_at
        ));
    }
    let mut seen = Vec::new();
    for a in d.approaches.iter().map(|a| a.trim().to_ascii_lowercase()) {
        if !a.is_empty() && !seen.contains(&a) {
            seen.push(a);
        }
    }
    if seen.is_empty() {
        seen.push(DEFAULT_APPROACH.to_string());
    }
    d.approaches = seen;
    d.proposer = d.proposer.map(|p| p.trim().to_ascii_lowercase()).filter(|p| !p.is_empty());
    if let Some(p) = &d.proposer {
        if !PROPOSERS.contains(&p.as_str()) {
            return Err(format!("Plyloft can't ask “{p}” to propose: choose Claude or Codex."));
        }
    }
    if d.rejected.len() > REJECTED_MAX {
        return Err(format!(
            "An area keeps at most {REJECTED_MAX} ideas not to propose again; remove some first."
        ));
    }
    Ok(d)
}

// ── Merging (C3's rule, per field) ─────────────────────────────────────

/// The keys merged as a whole rejected list rather than a value.
const LIST_KEY: &str = "rejected";
const SCHEMA_KEY: &str = "schemaVersion";

fn to_map(d: &Direction) -> Map<String, Value> {
    match serde_json::to_value(d) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn from_map(map: Map<String, Value>) -> Direction {
    serde_json::from_value(Value::Object(map)).unwrap_or_default()
}

fn get(map: &Map<String, Value>, key: &str) -> Value {
    map.get(key).cloned().unwrap_or(Value::Null)
}

fn set(map: &mut Map<String, Value>, key: &str, value: Value) {
    if value.is_null() {
        map.remove(key);
    } else {
        map.insert(key.to_string(), value);
    }
}

fn list(map: &Map<String, Value>) -> Vec<Value> {
    match map.get(LIST_KEY) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// The result of laying this Mac's change over the branch's file.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    /// What goes on the branch: theirs where a field conflicts.
    pub value: Direction,
    /// The same with this Mac's value in every conflicting field: what this
    /// Mac shows while the question waits.
    pub shown: Direction,
    /// The fields both sides changed to different values, keyed like the file.
    pub conflicts: Vec<String>,
}

/// Three-way, per field: `base` is the direction the change was made
/// against (`None`: there was none), `theirs` the branch's now.
pub fn merge(base: Option<&Direction>, theirs: Option<&Direction>, mine: &Direction) -> Merged {
    let base = base.map(to_map).unwrap_or_default();
    let theirs = theirs.map(to_map).unwrap_or_default();
    let mine = to_map(mine);
    let mut value = theirs.clone();
    let mut shown = theirs.clone();
    let mut conflicts = Vec::new();
    let mut keys: Vec<&String> = base.keys().chain(theirs.keys()).chain(mine.keys()).collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        if key == LIST_KEY || key == SCHEMA_KEY {
            continue;
        }
        let (b, t, m) = (get(&base, key), get(&theirs, key), get(&mine, key));
        if m == b || m == t {
            continue; // only theirs changed it, or both agree
        }
        if t == b {
            set(&mut value, key, m.clone());
            set(&mut shown, key, m);
        } else {
            conflicts.push(key.clone());
            set(&mut shown, key, m);
        }
    }
    // The list: theirs, less what this Mac removed, plus what it added.
    let (b, t, m) = (list(&base), list(&theirs), list(&mine));
    let mut merged: Vec<Value> = t.into_iter().filter(|e| !(b.contains(e) && !m.contains(e))).collect();
    for entry in m {
        if !b.contains(&entry) && !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    let schema = [get(&theirs, SCHEMA_KEY), get(&mine, SCHEMA_KEY)]
        .iter()
        .filter_map(Value::as_u64)
        .max()
        .unwrap_or(DIRECTION_SCHEMA_VERSION as u64);
    for map in [&mut value, &mut shown] {
        map.insert(LIST_KEY.to_string(), Value::Array(merged.clone()));
        map.insert(SCHEMA_KEY.to_string(), Value::from(schema));
    }
    Merged { value: from_map(value), shown: from_map(shown), conflicts }
}

// ── The queue (this Mac) ──────────────────────────────────────────────

/// One field of the direction someone else changed too, waiting for the
/// person's choice. Shown through C3's question (`setting_conflict`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldConflict {
    /// The branch's value of the field, as the file writes it.
    #[serde(default)]
    pub theirs: Value,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    /// The author is the person publishing from here.
    #[serde(default)]
    pub same_person: bool,
    /// It came from this very computer (another folder of the repository).
    #[serde(default)]
    pub this_computer: bool,
    /// Seconds.
    #[serde(default)]
    pub changed_at: Option<i64>,
}

/// One area's change not on the branch yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedDirection {
    /// The whole direction as this Mac wants it.
    pub value: Direction,
    /// The branch's direction when the change was made (`None`: none).
    #[serde(default)]
    pub base: Option<Direction>,
    /// What changed, for the commit message.
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub queued_at: i64,
    #[serde(default)]
    pub attempts: u32,
    /// The last failure, as git or GitHub said it (Details only).
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_offline: bool,
    /// Set while the change waits in a pull request.
    #[serde(default)]
    pub pull_request: Option<PullRequest>,
    /// What that pull request proposes now.
    #[serde(default)]
    pub pull_request_value: Option<Direction>,
    /// A press since: the next drain adds a commit to the pull request.
    #[serde(default)]
    pub pull_request_behind: bool,
    /// Fields both sides changed, keyed like the file. Every other field
    /// publishes meanwhile.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub conflicts: BTreeMap<String, FieldConflict>,
    /// E6: the direction this computer kept while the setup wasn't shared,
    /// moved here by [`adopt_local`]. It goes to the branch only while the
    /// branch has none for the area; one already there wins.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub moved: bool,
    /// A5R-02/07: the branch a pull request was being opened from, saved
    /// before the create and kept while it couldn't be opened. Such a change
    /// waits for the person's next press ([`waits_for_press`]), which looks
    /// for a pull request from this branch first, so none is opened twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_branch: Option<String>,
    /// Round 2: words for the person from this drain (never written).
    #[serde(skip)]
    pub said: Option<String>,
}

impl QueuedDirection {
    fn new(value: Direction, base: Option<Direction>, lines: Vec<String>) -> Self {
        QueuedDirection {
            value,
            base,
            lines,
            queued_at: crate::shared_config::now_millis(),
            attempts: 0,
            last_error: None,
            last_offline: false,
            pull_request: None,
            pull_request_value: None,
            pull_request_behind: false,
            conflicts: BTreeMap::new(),
            moved: false,
            pull_request_branch: None,
            said: None,
        }
    }
}

/// How 1.176.2 and earlier worded a pull request that couldn't be opened:
/// with [`REFUSED_MARKER`], which made this computer read-only for good.
fn opened_no_pull_request_before(error: &str) -> bool {
    error.contains(&format!("{REFUSED_MARKER}; opening the pull request failed: "))
}

/// A5R-02 (owner, 2026-11-23): a change whose pull request couldn't be
/// opened is tried again only on the person's own press — never by a read,
/// never on a timer.
pub(crate) fn waits_for_press(q: &QueuedDirection) -> bool {
    q.pull_request.is_none()
        && (q.pull_request_branch.is_some() || q.last_error.as_deref().is_some_and(opened_no_pull_request_before))
}

/// `projects/<ws>/next_improvement_queue.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectionQueue {
    #[serde(default = "queue_schema")]
    pub schema_version: u32,
    #[serde(default)]
    pub areas: BTreeMap<String, QueuedDirection>,
    /// E6: the areas whose direction kept on this computer was dropped
    /// because the repository already had one: said once, then cleared
    /// ([`notice_seen`]).
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub kept_repository: std::collections::BTreeSet<String>,
}

impl DirectionQueue {
    fn is_empty(&self) -> bool {
        self.areas.is_empty() && self.kept_repository.is_empty()
    }
}

fn queue_schema() -> u32 {
    QUEUE_SCHEMA_VERSION
}

impl Default for DirectionQueue {
    fn default() -> Self {
        DirectionQueue {
            schema_version: QUEUE_SCHEMA_VERSION,
            areas: BTreeMap::new(),
            kept_repository: Default::default(),
        }
    }
}

pub fn queue_path(store: &ProjectConfigStore, workspace_id: &str) -> PathBuf {
    store.workspace_dir(workspace_id).join(QUEUE_FILENAME)
}

/// C17: read-only, for the definition view and the Inbox
/// ([`setting_conflicts_in`]): an unreadable queue reads as none here and is
/// left for [`load_queue`] to set aside, so a view never moves a file.
fn read_queue_file(path: &Path) -> Option<DirectionQueue> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Missing reads as empty; an unreadable file is set aside, never dropped
/// (`next_improvement_queue.json.unreadable-<ms>`, C17, through
/// [`crate::atomic::load_or_set_aside`]). One that can't be set aside reads
/// as empty too, logged, and [`save_queue`] then refuses to write over it.
/// A newer Plyloft's queue that doesn't parse here is left as it is and
/// reads as empty; [`save_queue`] refuses it.
pub fn load_queue(store: &ProjectConfigStore, workspace_id: &str) -> DirectionQueue {
    let parse = |bytes: &[u8]| serde_json::from_slice::<DirectionQueue>(bytes).map_err(|e| e.to_string());
    crate::atomic::load_or_set_aside_versioned(&queue_path(store, workspace_id), ("schemaVersion", QUEUE_SCHEMA_VERSION), parse)
        .unwrap_or_else(|error| {
            log::error!("next_improvement: queue for {workspace_id}: {error}");
            crate::atomic::Loaded::Missing
        })
        .found()
        .map(|mut queue: DirectionQueue| {
            // Round 2 (MF1): an entry 1.176.2 left after a create that
            // failed says so by its error only; as read, it waits for a
            // press by its (unknown, empty) branch, whatever clears the
            // error later.
            for q in queue.areas.values_mut() {
                if q.pull_request.is_none()
                    && q.pull_request_branch.is_none()
                    && q.last_error.as_deref().is_some_and(opened_no_pull_request_before)
                {
                    q.pull_request_branch = Some(String::new());
                }
            }
            queue
        })
        .unwrap_or_default()
}

/// Atomic; an empty queue removes the file. C17: a file there that doesn't
/// parse is set aside first, and one that can't be, or one a newer Plyloft
/// wrote, is never written over or removed.
pub fn save_queue(store: &ProjectConfigStore, workspace_id: &str, queue: &DirectionQueue) -> Result<(), String> {
    let path = queue_path(store, workspace_id);
    // C17: a newer Plyloft's queue first (its fields this build doesn't know
    // would be lost), so it is never set aside either.
    crate::atomic::refuse_newer_on_disk(&path, "schemaVersion", QUEUE_SCHEMA_VERSION, "The Next improvement queue")?;
    crate::atomic::load_or_set_aside::<DirectionQueue>(&path)?;
    if queue.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("remove {path:?}: {e}")),
            _ => Ok(()),
        };
    }
    crate::atomic::write_atomic_json(&path, queue)
}

// ── Where it is published ─────────────────────────────────────────────

/// What a workspace's direction rests on: its shared definition's branch
/// and this Mac's write access.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub branch: String,
    pub read_only: bool,
}

/// `None`: the workspace shares no definition.
pub fn target(store: &ProjectConfigStore, workspace_id: &str) -> Option<Target> {
    let cache = crate::workspace_definition::load_cache(store, workspace_id).filter(|c| c.definition.is_some())?;
    let branch = cache
        .branch
        .clone()
        .or_else(|| cache.definition.as_ref().and_then(|d| d.integration_branch.clone()))
        .filter(|b| !b.trim().is_empty())?;
    Some(Target { branch, read_only: cache.write_access.read_only() })
}

/// E6: where a workspace's direction is kept. The one place that decides.
#[derive(Debug, Clone, PartialEq)]
pub enum Place {
    /// The shared setup's branch, through the shared-config channel.
    Repository(Target),
    /// Plyloft's own data on this computer ([`local_path`]).
    ThisComputer,
}

/// [`Place::Repository`] while the workspace shares a definition, else
/// [`Place::ThisComputer`].
pub fn place(store: &ProjectConfigStore, workspace_id: &str) -> Place {
    target(store, workspace_id).map_or(Place::ThisComputer, Place::Repository)
}

// ── Kept on this computer (E6) ────────────────────────────────────────

/// Under the workspace's folder of this computer's data.
pub const LOCAL_DIR: &str = "next_improvement/direction";

fn local_dir(store: &ProjectConfigStore, workspace_id: &str) -> Result<PathBuf, String> {
    let ws = crate::chat_store::safe_component(workspace_id, "workspace")?;
    Ok(store.root().join(ws).join(LOCAL_DIR))
}

/// `projects/<ws>/next_improvement/direction/<area>.json`.
pub fn local_path(store: &ProjectConfigStore, workspace_id: &str, area: &str) -> Result<PathBuf, String> {
    let area = crate::chat_store::safe_component(area, "area")?;
    Ok(local_dir(store, workspace_id)?.join(format!("{area}.json")))
}

/// The direction kept here for `area`: `None` when there is none (the
/// migration's case: no file is no direction). A file Plyloft can't read is
/// set aside (`<area>.json.unreadable-<ms>`, C17, through
/// [`crate::atomic::load_or_set_aside_with`]), never dropped, and reads as
/// none; one that can't be set aside is logged and reads as none.
pub fn load_local(store: &ProjectConfigStore, workspace_id: &str, area: &str) -> Option<Direction> {
    let path = local_path(store, workspace_id, area).ok()?;
    // A newer Plyloft's direction that doesn't parse here is left as it is.
    crate::atomic::load_or_set_aside_versioned(&path, ("schemaVersion", DIRECTION_SCHEMA_VERSION), parse_direction)
        .unwrap_or_else(|error| {
            log::error!("next_improvement: the direction kept here for {workspace_id}/{area}: {error}");
            crate::atomic::Loaded::Missing
        })
        .found()
}

/// Atomic (hard rule 3). C17, as [`save_queue`]: a newer Plyloft's file is
/// refused and left as it is; an unreadable one is set aside first.
pub fn save_local(store: &ProjectConfigStore, workspace_id: &str, area: &str, direction: &Direction) -> Result<(), String> {
    let path = local_path(store, workspace_id, area)?;
    crate::atomic::refuse_newer_on_disk(&path, "schemaVersion", DIRECTION_SCHEMA_VERSION, "The direction kept on this computer")?;
    crate::atomic::load_or_set_aside_with(&path, parse_direction)?;
    crate::atomic::write_atomic_json(&path, direction)
}

fn remove_local(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("remove {path:?}: {e}")),
        _ => Ok(()),
    }
}

/// The areas with a direction kept here, by file name.
pub fn local_areas(store: &ProjectConfigStore, workspace_id: &str) -> Vec<String> {
    let Ok(dir) = local_dir(store, workspace_id) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut areas: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .collect();
    areas.sort();
    areas
}

/// The line, in the commit, of a direction that moved from this computer.
pub fn moved_line() -> String {
    format!("Direction kept on {} until the setup was shared", crate::this_machine!())
}

/// Said once when the repository's direction was kept over this computer's.
pub fn kept_repository_words() -> String {
    format!(
        "The repository already had a direction, so Plyloft uses it. The one kept on {} wasn't moved.",
        crate::this_machine!()
    )
}

/// A shared direction this read-only computer still shows from its own data.
pub fn kept_until_writable_words() -> String {
    format!("Kept on {} until this computer can save to the repository.", crate::this_machine!())
}

/// A direction kept here for an area the repository doesn't have. The one
/// written before the project had areas (`default`) is never named by its
/// file (1.174.0, C11, mockup next-improvement.html §5c).
pub fn orphan_words(file: &str) -> String {
    if file == IMPLICIT_AREA_ID {
        return format!(
            "The direction you wrote before areas is kept on {}. Use it for an area from that area's Next improvement.",
            crate::this_machine!()
        );
    }
    format!(
        "A direction kept on {} for “{file}” matches no area of this repository, so it stays on {}.",
        crate::this_machine!(),
        crate::this_machine!()
    )
}

/// The area a local file belongs to now: its own name when the repository
/// accepts it (`resolve_area`), or `default` mapped to the only area when
/// exactly one exists. `None`: an orphan, left where it is.
fn local_area_for(defined: &[areas::AreaDef], file: &str) -> Option<String> {
    if let Ok((key, _)) = resolve_area(defined, Some(file), None) {
        return Some(key);
    }
    match defined {
        [only] if file == IMPLICIT_AREA_ID => Some(only.id.clone()),
        _ => None,
    }
}

/// The local file kept for area `key`, by file name: `key` itself, else
/// `default` when `key` is the only area.
fn local_file_for(store: &ProjectConfigStore, workspace_id: &str, key: &str) -> Option<String> {
    let defined = areas::load(store, workspace_id);
    local_areas(store, workspace_id)
        .into_iter()
        .filter(|f| local_area_for(&defined, f).as_deref() == Some(key))
        .min_by_key(|f| f.as_str() != key) // its own name first
}

/// C11 round 3: kept on this computer, the file an area reads — its own,
/// else `default` while it is the only area (as [`local_file_for`] maps it
/// for the shared case).
fn local_read_for(store: &ProjectConfigStore, workspace_id: &str, key: &str) -> String {
    local_file_for(store, workspace_id, key).unwrap_or_else(|| key.to_string())
}

/// The files kept here that match no area: left in place, and said.
pub fn orphan_local_files(store: &ProjectConfigStore, workspace_id: &str) -> Vec<String> {
    let defined = areas::load(store, workspace_id);
    local_areas(store, workspace_id).into_iter().filter(|f| local_area_for(&defined, f).is_none()).collect()
}

/// A moved entry made from what is kept here (no base).
fn moved_entry(direction: Direction) -> QueuedDirection {
    let mut entry = QueuedDirection::new(direction, None, vec![moved_line()]);
    entry.moved = true;
    entry
}

/// On a shared workspace, the change this computer would publish for `key`:
/// the queued one, else the direction still kept here (not moved yet: a
/// read-only Mac, or before the next refresh) as a moved entry, so it stays
/// visible and usable until the branch has its own.
pub fn pending_for(store: &ProjectConfigStore, workspace_id: &str, queue: &DirectionQueue, key: &str) -> Option<QueuedDirection> {
    if let Some(q) = queue.areas.get(key) {
        return Some(q.clone());
    }
    let file = local_file_for(store, workspace_id, key)?;
    load_local(store, workspace_id, &file).map(moved_entry)
}

/// A moved entry gives way to the branch's direction when the branch has
/// one that is different (the same one is simply published).
fn yields(q: &QueuedDirection, theirs: Option<&Direction>) -> bool {
    q.moved && theirs.is_some_and(|t| *t != q.value)
}

/// The setup is shared now: each direction kept on this computer goes into
/// the queue (marked `moved`, against no base) under the area it belongs to
/// ([`local_area_for`]), and its file is removed — the queue written first.
/// An area that already has a queued change takes the local direction when
/// they differ (shared, unshared, shared again: the local one is the latest);
/// a blank one just goes. A file that matches no area stays. Called under
/// the workspace's definition lock, only where this computer can publish.
/// The areas that moved.
pub fn adopt_local(store: &ProjectConfigStore, workspace_id: &str) -> Vec<String> {
    let local = local_areas(store, workspace_id);
    if local.is_empty() {
        return Vec::new();
    }
    let defined = areas::load(store, workspace_id);
    let mut queue = load_queue(store, workspace_id);
    let mut moved = Vec::new();
    let mut done = Vec::new();
    for file in local {
        let Some(area) = local_area_for(&defined, &file) else {
            // Every refresh sees it again: debug, not a warning each time.
            log::debug!("next_improvement: the direction kept here as {file} matches no area of {workspace_id}; it stays");
            continue;
        };
        let Ok(path) = local_path(store, workspace_id, &file) else { continue };
        let Some(direction) = load_local(store, workspace_id, &file) else { continue };
        let blank = direction.is_blank() && direction.rejected.is_empty();
        match queue.areas.get_mut(&area) {
            _ if blank => {}
            Some(q) if q.value == direction => {}
            Some(q) => {
                // Kept here after the queued change: the latest press wins.
                // Only the value changes: the entry's own base, `moved` and
                // pull request stay, so it still merges against what it was
                // made on, and an open pull request takes the update.
                q.value = direction;
                q.conflicts.clear();
                q.lines.push(moved_line());
                q.attempts = 0;
                // Round 2 (MF1): a change waiting for a press keeps saying so.
                if !waits_for_press(q) {
                    q.last_error = None;
                    q.last_offline = false;
                }
                q.pull_request_behind = q.pull_request.is_some();
                moved.push(area.clone());
            }
            None => {
                queue.areas.insert(area.clone(), moved_entry(direction));
                moved.push(area.clone());
            }
        }
        done.push(path);
    }
    if !moved.is_empty() {
        if let Err(e) = save_queue(store, workspace_id, &queue) {
            log::warn!("next_improvement: moving the directions kept here for {workspace_id} failed: {e}");
            return Vec::new(); // the files stay; the next refresh tries again
        }
    }
    for path in done {
        if let Err(e) = remove_local(&path) {
            log::warn!("next_improvement: {e}");
        }
    }
    moved.dedup();
    moved
}

/// A moved entry against the branch's file: `None` once the branch has a
/// different one — the repository's wins, and the queue remembers to say so
/// once — or the same one (settled, nothing to say).
fn unless_repository_has_one(
    queue: &mut DirectionQueue,
    area: &str,
    entry: Option<QueuedDirection>,
    theirs: Option<&Direction>,
) -> Option<QueuedDirection> {
    match entry {
        Some(q) if yields(&q, theirs) => {
            queue.kept_repository.insert(area.to_string());
            None
        }
        Some(q) if q.moved && theirs == Some(&q.value) => None,
        other => other,
    }
}

/// The notice for `area` was shown: cleared. `true` when there was one.
pub fn notice_seen(store: &ProjectConfigStore, workspace_id: &str, area: &str) -> Result<bool, String> {
    let said = said_notices().lock().unwrap_or_else(|p| p.into_inner()).remove(&notice_key(store, workspace_id, area)).is_some();
    let mut queue = load_queue(store, workspace_id);
    if !queue.kept_repository.remove(area) {
        return Ok(said);
    }
    save_queue(store, workspace_id, &queue)?;
    Ok(true)
}

// ── The direction written before the areas (1.174.0, C11, P15) ────────

/// The commit line of an area that took the direction written before the
/// project had areas.
pub const FROM_BEFORE_AREAS_LINE: &str = "Direction written before the areas";

/// *Use it for…* found nothing to copy (another press got there first).
pub const NO_PROJECT_DIRECTION_WORDS: &str = "The direction you wrote before areas isn't there any more.";

/// What the sheet at the first save of two or more areas reads (mockup
/// next-improvement.html §5): the direction written for the whole project
/// before it had areas, and the areas still without one of their own.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeforeAreas {
    pub direction: Direction,
    /// By id, in the list's order.
    pub areas: Vec<String>,
}

/// The direction written for the whole project (`default`) while it had no
/// areas: kept on this computer, or — shared — the branch's (with this
/// Mac's queued change), else one still kept here. `None` while the project
/// has fewer than two areas (none: it is simply the direction; one: the
/// only area is the whole project's), or when none was written.
pub fn project_direction(store: &ProjectConfigStore, git: &Plumbing, workspace_id: &str) -> Option<Direction> {
    if areas::load(store, workspace_id).len() < 2 {
        return None;
    }
    let found = match place(store, workspace_id) {
        Place::ThisComputer => load_local(store, workspace_id, IMPLICIT_AREA_ID),
        Place::Repository(t) => {
            let theirs = read_branch(git, &t.branch, IMPLICIT_AREA_ID).ok().flatten();
            let queue = load_queue(store, workspace_id);
            effective(theirs.as_ref(), queue.areas.get(IMPLICIT_AREA_ID))
                .or_else(|| load_local(store, workspace_id, IMPLICIT_AREA_ID))
        }
    };
    found.filter(|d| !(d.is_blank() && d.rejected.is_empty()))
}

/// `key` has a direction of its own: kept here; or, shared, queued, still
/// kept here to move, or on the branch — a file there Plyloft can't read
/// counts too, so nothing is ever written over it.
fn has_own(store: &ProjectConfigStore, git: &Plumbing, workspace_id: &str, at: &Place, queue: &DirectionQueue, key: &str) -> bool {
    match at {
        Place::ThisComputer => load_local(store, workspace_id, key).is_some(),
        Place::Repository(t) => {
            queue.areas.contains_key(key)
                || local_areas(store, workspace_id).iter().any(|f| f == key)
                || !matches!(read_branch(git, &t.branch, key), Ok(None))
        }
    }
}

/// For removing `default` only: `key` has a direction of its own that can
/// be read — a branch file Plyloft can't read is no copy of it.
fn has_readable_own(store: &ProjectConfigStore, git: &Plumbing, workspace_id: &str, at: &Place, queue: &DirectionQueue, key: &str) -> bool {
    match at {
        Place::ThisComputer => load_local(store, workspace_id, key).is_some(),
        Place::Repository(t) => {
            queue.areas.contains_key(key)
                || local_areas(store, workspace_id).iter().any(|f| f == key)
                || matches!(read_branch(git, &t.branch, key), Ok(Some(_)))
        }
    }
}

/// The sheet's question, while it has one to ask: a direction written
/// before the areas, and at least one area without its own. Reads only.
pub fn before_areas(store: &ProjectConfigStore, git: &Plumbing, workspace_id: &str) -> Option<BeforeAreas> {
    if areas::held(store, workspace_id).is_some() {
        return None;
    }
    let direction = project_direction(store, git, workspace_id)?;
    let at = place(store, workspace_id);
    let queue = load_queue(store, workspace_id);
    let areas: Vec<String> = areas::load(store, workspace_id)
        .into_iter()
        .map(|a| a.id)
        .filter(|id| !has_own(store, git, workspace_id, &at, &queue, id))
        .collect();
    (!areas.is_empty()).then_some(BeforeAreas { direction, areas })
}

/// *Use it for both* (the sheet) and *Use it for Site* (the area's first
/// time): each area in `wanted` without a direction of its own gets a copy
/// of the one written before the areas, its "Not to propose again" list
/// included — kept on this computer (atomic), or queued for the shared
/// setup's branch like a *Save* (published by the caller's drain). `fields`:
/// the answers as checked in the editor (*Check the direction first…*),
/// over the project's; the list still comes from the project's. An area
/// that has its own already is left as it is. The `default` file kept here
/// goes once every area has its own (a branch's file is never removed).
/// The areas that took it.
pub fn adopt_project(
    store: &ProjectConfigStore,
    git: &Plumbing,
    workspace_id: &str,
    wanted: &[String],
    fields: Option<Direction>,
) -> Result<Vec<String>, String> {
    if let Some(problem) = areas::held(store, workspace_id) {
        return Err(problem);
    }
    let defined = areas::load(store, workspace_id);
    for id in wanted {
        if !defined.iter().any(|a| &a.id == id) {
            return Err(format!("This repository has no area “{id}”."));
        }
    }
    let project = project_direction(store, git, workspace_id).ok_or_else(|| NO_PROJECT_DIRECTION_WORDS.to_string())?;
    let value = match fields {
        None => project.clone(),
        Some(d) => {
            let mut next = Direction { rejected: project.rejected.clone(), ..normalized_for_save(d)? };
            for (k, v) in &project.extra {
                next.extra.entry(k.clone()).or_insert_with(|| v.clone());
            }
            next
        }
    };
    let at = place(store, workspace_id);
    if let Place::Repository(t) = &at {
        if t.read_only {
            let name = wanted.first().and_then(|id| defined.iter().find(|a| &a.id == id)).map(|a| a.name.clone()).unwrap_or_default();
            return Err(read_only_words(&name));
        }
    }
    let mut queue = load_queue(store, workspace_id);
    let mut took: Vec<String> = Vec::new();
    for id in wanted {
        if took.contains(id) || has_own(store, git, workspace_id, &at, &queue, id) {
            continue;
        }
        match &at {
            Place::ThisComputer => save_local(store, workspace_id, id, &value)?,
            Place::Repository(_) => {
                queue.areas.insert(id.clone(), QueuedDirection::new(value.clone(), None, vec![FROM_BEFORE_AREAS_LINE.to_string()]));
            }
        }
        took.push(id.clone());
    }
    if matches!(at, Place::Repository(_)) && !took.is_empty() {
        save_queue(store, workspace_id, &queue)?;
    }
    if defined.iter().all(|a| took.contains(&a.id) || has_readable_own(store, git, workspace_id, &at, &queue, &a.id)) {
        if let Ok(path) = local_path(store, workspace_id, IMPLICIT_AREA_ID) {
            if let Err(e) = remove_local(&path) {
                log::warn!("next_improvement: {e}");
            }
        }
    }
    Ok(took)
}

/// The words when no area was named and Plyloft can't tell which.
pub const WHICH_AREA_WORDS: &str = "Which area is this for?";

/// The area a call is about, `(file name, name)`. Held areas refuse with
/// their problem; see [`resolve_area`] for the rest.
pub fn area_key(
    store: &ProjectConfigStore,
    workspace_id: &str,
    area: Option<&str>,
    default_area: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(problem) = areas::held(store, workspace_id) {
        return Err(problem);
    }
    resolve_area(&areas::load(store, workspace_id), area, default_area)
}

/// Without areas: the implicit area (`default`). With them: the area named;
/// none named, the workspace's default area while it is listed, else the
/// only area, else [`WHICH_AREA_WORDS`]. Never the implicit area when the
/// repository has areas. The implicit area's name is "".
pub fn resolve_area(
    defined: &[areas::AreaDef],
    area: Option<&str>,
    default_area: Option<&str>,
) -> Result<(String, String), String> {
    let wanted = area.map(str::trim).filter(|a| !a.is_empty());
    let found = |id: &str| defined.iter().find(|a| a.id == id).map(|a| (a.id.clone(), a.name.clone()));
    if defined.is_empty() {
        return match wanted {
            None => Ok((IMPLICIT_AREA_ID.to_string(), String::new())),
            Some(id) if id == IMPLICIT_AREA_ID => Ok((IMPLICIT_AREA_ID.to_string(), String::new())),
            Some(id) => Err(format!("This repository has no area “{id}”.")),
        };
    }
    if let Some(id) = wanted {
        return found(id).ok_or_else(|| format!("This repository has no area “{id}”."));
    }
    if let Some(known) = default_area.and_then(found) {
        return Ok(known);
    }
    match defined {
        [only] => Ok((only.id.clone(), only.name.clone())),
        _ => Err(WHICH_AREA_WORDS.to_string()),
    }
}

fn subject_of(name: &str) -> String {
    if name.is_empty() {
        "this project".to_string()
    } else {
        name.to_string()
    }
}

/// The words for a Mac that can read the direction and not change it.
pub fn read_only_words(name: &str) -> String {
    crate::workspace_definition::read_only_error(&format!("The direction for {}", subject_of(name)))
}

pub const OFFLINE_WORDS: &str = "Plyloft couldn't reach the repository. It tries again at the next Sync.";
pub const FAILED_WORDS: &str =
    "The direction couldn't be saved in the repository yet. Plyloft tries again at the next Sync.";
pub const PULL_REQUEST_WORDS: &str = "Waiting in a pull request until it merges.";
/// A5R-02: the pull request couldn't be opened; it waits for the person's
/// next change of the direction, never for a read.
pub const PULL_REQUEST_FAILED_WORDS: &str =
    "The pull request for this direction couldn't be opened. Plyloft tries again the next time you save it.";
pub const CONFLICT_WORDS: &str = "Someone else changed the same answer: choose which one the repository keeps.";

/// Round 2 (SF3): waiting for a press with no error — a quit while the
/// pull request was being opened.
pub const PULL_REQUEST_UNFINISHED_WORDS: &str =
    "Plyloft may not have finished opening the pull request for this direction. Save it to check.";
/// 1.176.4 (owner 2026-11-23): `words`, then the branch a try left on
/// GitHub, when one is recorded. Whether a pull request came of it is not
/// said: a create whose answer was lost may have opened one (review M2).
fn with_branch_left(words: &str, branch: Option<&str>) -> String {
    match branch {
        Some(branch) => format!("{words} The branch {branch} is on GitHub."),
        None => words.to_string(),
    }
}

/// Round 2 (SF1): the pull request whose answer was lost was closed on
/// GitHub; the change went with it, as a tracked one's does.
pub const CLOSED_ON_GITHUB_WORDS: &str =
    "The pull request for this direction was closed on GitHub without being merged, so this change wasn't kept.";

/// Round 2 (SF2): a pull request from the recorded branch aimed at another
/// branch is left as it is, and named.
pub fn left_open_words(url: &str, base: &str) -> String {
    let number = pr_number(url).map(|n| format!("#{n}")).unwrap_or_else(|| url.to_string());
    format!("Pull request {number} for this direction is still open on GitHub, aimed at {base}. Plyloft left it as it is.")
}

/// Round 2 (SF3): the pull requests being opened right now (this run of
/// the app), so a view read meanwhile says nothing yet.
pub(crate) struct Creating(String);

fn creating_set() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    SET.get_or_init(Default::default)
}

impl Creating {
    fn key(q: &QueuedDirection) -> String {
        format!("{}@{}", q.pull_request_branch.as_deref().unwrap_or_default(), q.queued_at)
    }
    pub(crate) fn start(q: &QueuedDirection) -> Self {
        let key = Self::key(q);
        creating_set().lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone());
        Creating(key)
    }
    fn running(q: &QueuedDirection) -> bool {
        creating_set().lock().unwrap_or_else(|p| p.into_inner()).contains(&Self::key(q))
    }
}

impl Drop for Creating {
    fn drop(&mut self) {
        creating_set().lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// Round 2 (SF1, SF2): a notice for one area, said once by the view
/// ([`notice_seen`]). Kept in memory only: it follows the press that
/// found it.
fn said_notices() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();
    MAP.get_or_init(Default::default)
}

fn notice_key(store: &ProjectConfigStore, workspace_id: &str, area: &str) -> String {
    format!("{}::{area}", queue_path(store, workspace_id).display())
}

fn said_notice(store: &ProjectConfigStore, workspace_id: &str, area: &str) -> Option<String> {
    said_notices().lock().unwrap_or_else(|p| p.into_inner()).get(&notice_key(store, workspace_id, area)).cloned()
}

/// The repository wouldn't take the change from here, and no pull request
/// could carry it.
pub fn refused_words() -> String {
    format!(
        "The repository didn't accept the change from {}, so the direction can only be read here.",
        crate::this_machine!()
    )
}

/// The branch's file isn't a direction Plyloft can read.
pub fn unreadable_words(name: &str) -> String {
    format!("The direction for {} in the repository can't be read. Fix the file there first.", subject_of(name))
}

// ── Reading ────────────────────────────────────────────────────────────

/// The branch's file at the fetched tip: `Ok(None)` when it has none (or
/// the branch isn't fetched), `Err` (git's words) when it can't be read.
pub fn read_branch(git: &Plumbing, branch: &str, area: &str) -> Result<Option<Direction>, String> {
    let Some(tip) = git.tip(branch) else {
        return Ok(None);
    };
    match git.read_at(&tip, &direction_path(area)) {
        None => Ok(None),
        Some(bytes) => parse_direction(&bytes)
            .map(Some)
            .map_err(|e| format!("{} on {branch} {e}", direction_path(area))),
    }
}

/// What the direction is now on this Mac: the branch's, with this Mac's
/// queued change over it (its own value in a field waiting for a choice).
pub fn effective(theirs: Option<&Direction>, queued: Option<&QueuedDirection>) -> Option<Direction> {
    match queued {
        // E6: one moved from this computer yields to the branch's.
        Some(q) if q.moved && theirs.is_some() => theirs.cloned(), // the branch's file is shown (equal or not)
        Some(q) => Some(merge(q.base.as_ref(), theirs, &q.value).shown),
        None => theirs.cloned(),
    }
}

/// E2's read: the direction a round proposes in, and the area's file name.
/// `None` when the workspace has no direction for it yet. Kept on this
/// computer while the setup isn't shared ([`place`]).
pub fn direction_for(
    store: &ProjectConfigStore,
    cwd: &Path,
    workspace_id: &str,
    area: Option<&str>,
    default_area: Option<&str>,
) -> Result<(String, Option<Direction>), String> {
    let (key, _) = area_key(store, workspace_id, area, default_area)?;
    let t = match place(store, workspace_id) {
        Place::ThisComputer => {
            let file = local_read_for(store, workspace_id, &key);
            return Ok((key.clone(), load_local(store, workspace_id, &file)));
        }
        Place::Repository(t) => t,
    };
    let theirs = read_branch(&Plumbing { cwd: cwd.to_path_buf() }, &t.branch, &key)?;
    let queue = load_queue(store, workspace_id);
    let pending = pending_for(store, workspace_id, &queue, &key);
    Ok((key.clone(), effective(theirs.as_ref(), pending.as_ref())))
}

/// Where this Mac's change stands.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PendingState {
    /// Queued; the next refresh publishes it.
    Waiting,
    /// The last try couldn't reach the repository.
    Offline,
    /// Waiting in a pull request.
    PullRequest,
    /// A field both sides changed waits for the person's choice.
    Conflict,
    /// Something to fix first (`message`; git's words in `technical`).
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub state: PendingState,
    /// In the app's words.
    pub message: Option<String>,
    /// What git or GitHub said: Details and Copy details only.
    pub technical: Option<String>,
    pub pull_request: Option<PullRequest>,
    /// The questions waiting, as C3's sheet and Inbox row show them.
    pub conflicts: Vec<SettingConflict>,
}

fn pending_of(q: &QueuedDirection, area: &str, area_name: &str) -> Pending {
    let conflicts = conflicts_of_entry(area, area_name, q);
    let (state, message) = if !conflicts.is_empty() {
        (PendingState::Conflict, Some(CONFLICT_WORDS.to_string()))
    } else if q.pull_request.is_some() && q.last_error.is_none() {
        (PendingState::PullRequest, Some(PULL_REQUEST_WORDS.to_string()))
    } else if waits_for_press(q)
        && !q.last_error.as_deref().is_some_and(|e| e.contains(REFUSED_MARKER) && !opened_no_pull_request_before(e))
    {
        // Round 2 (SF3, SF4): a refusal saving again can't help is said as
        // one below; a quit during the create is said too, not left silent.
        // 1.176.4 (owner 2026-11-23): the branch the try left on GitHub is
        // named (never deleted); 1.176.2's empty marker names none.
        let left = q.pull_request_branch.as_deref().filter(|b| !b.is_empty());
        match &q.last_error {
            _ if Creating::running(q) => (PendingState::Waiting, None),
            Some(_) => (PendingState::Failed, Some(with_branch_left(PULL_REQUEST_FAILED_WORDS, left))),
            None => (PendingState::Failed, Some(with_branch_left(PULL_REQUEST_UNFINISHED_WORDS, left))),
        }
    } else if q.last_offline {
        (PendingState::Offline, Some(OFFLINE_WORDS.to_string()))
    } else if let Some(e) = &q.last_error {
        let words = if e.contains(REFUSED_MARKER) { refused_words() } else { FAILED_WORDS.to_string() };
        (PendingState::Failed, Some(words))
    } else {
        (PendingState::Waiting, None)
    };
    Pending {
        state,
        message,
        technical: q.last_error.clone(),
        pull_request: q.pull_request.clone(),
        conflicts,
    }
}

// ── The question (C3's sheet and Inbox row) ───────────────────────────

/// A direction field's id in C3's question: `ni-<area>-<field>`.
pub fn conflict_field(area: &str, field: &str) -> String {
    format!("{CONFLICT_PREFIX}{area}-{field}")
}

pub const CONFLICT_PREFIX: &str = "ni-";

/// `(area, field)` of a question's id, read at its last dash: enough to
/// tell a direction question by its prefix. [`resolve`] matches the queue's
/// real areas and keys, so a dashed id or key is answered too.
pub fn parse_conflict_field(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix(CONFLICT_PREFIX)?.rsplit_once('-')
}

/// A field's name, as the direction editor labels it.
pub fn field_words(key: &str) -> &str {
    match key {
        "audience" => "For whom",
        "better" => "What “better” means here",
        "avoid" => "What you don't want",
        "lookAt" => "Where to look at it",
        "approaches" => "Approach",
        "proposer" => "Proposes",
        other => other,
    }
}

/// An approach as the editor names it: `polish` → "Polish".
pub fn approach_words(id: &str) -> String {
    match id {
        "polish" => "Polish".to_string(),
        "simplify" => "Simplify".to_string(),
        "grow" => "Grow".to_string(),
        "fix" => "Fix".to_string(),
        other => other.to_string(),
    }
}

/// A field's value as the question shows it: approaches by their names.
fn in_words(key: &str, value: &Value) -> Value {
    match (key, value) {
        ("approaches", Value::Array(items)) => Value::Array(
            items.iter().map(|i| i.as_str().map_or_else(|| i.clone(), |id| Value::from(approach_words(id)))).collect(),
        ),
        _ => value.clone(),
    }
}

fn conflicts_of_entry(area: &str, area_name: &str, q: &QueuedDirection) -> Vec<SettingConflict> {
    let mine = to_map(&q.value);
    q.conflicts
        .iter()
        .map(|(key, c)| {
            let label = if area_name.is_empty() {
                format!("Next improvement · {}", field_words(key))
            } else {
                format!("Next improvement · {} ({area_name})", field_words(key))
            };
            SettingConflict {
                field: conflict_field(area, key),
                label,
                author: c.author.clone(),
                device: c.device.clone(),
                same_person: c.same_person,
                changed_at: c.changed_at,
                this_computer: c.this_computer,
                theirs: c.theirs.clone(),
                difference: crate::setting_conflict::difference(key, &in_words(key, &c.theirs), &in_words(key, &get(&mine, key))),
            }
        })
        .collect()
}

/// Every direction question in a workspace's folder of this Mac's data
/// (`projects/<ws>/`): its queue, its areas' names from `areas.json`. For
/// the definition view (`workspace_definition_get`) and the Inbox.
pub fn setting_conflicts_in(workspace_dir: &Path) -> Vec<SettingConflict> {
    let Some(queue) = read_queue_file(&workspace_dir.join(QUEUE_FILENAME)) else {
        return Vec::new();
    };
    // C17: read-only, so not `areas::load` (which sets an unreadable file
    // aside): names only, and an unreadable file shows the ids.
    let names: Vec<(String, String)> = std::fs::read(workspace_dir.join("areas.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("areas").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|a| {
            let id = a.get("id")?.as_str()?.to_string();
            let name = a.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(&id).to_string();
            Some((id, name))
        })
        .collect();
    queue
        .areas
        .iter()
        .flat_map(|(area, q)| {
            let name = names.iter().find(|(id, _)| id == area).map(|(_, n)| n.clone()).unwrap_or_default();
            conflicts_of_entry(area, &name, q)
        })
        .collect()
}

/// Where the draft's "Where to look at it" came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LookAtSource {
    /// Settings › Areas.
    Area,
    /// "Found in Railway".
    Railway,
    /// "From package.json".
    PackageJson,
    /// "From your README".
    Readme,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookAtHint {
    pub url: String,
    pub source: LookAtSource,
}

/// The files the draft read.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DraftSource {
    Readme,
    PackageJson,
}

/// 1.174.0 (C9, P14): "For whom" as the project's own words say it,
/// offered beside the empty field (*Use it*), never filled in.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudienceHint {
    pub text: String,
    pub source: DraftSource,
}

/// A direction Plyloft drafted, to correct rather than write. Never saved
/// until the person saves it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectionDraft {
    pub direction: Direction,
    /// What it read to help, in the order used ("Plyloft read your README").
    pub from: Vec<DraftSource>,
    pub look_at: Option<LookAtHint>,
    /// C9: "For whom" stays empty; the README's first sentence (else
    /// package.json's description) is a suggestion.
    pub audience: Option<AudienceHint>,
}

/// `ni_direction_get`'s answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectionView {
    /// The area's file name: its id, or `default`.
    pub area: String,
    /// Its name; "" for the implicit area.
    pub area_name: String,
    /// `.atelier/next-improvement/<area>.json`.
    pub path: String,
    /// The workspace shares a setup: the direction is the repository's.
    /// Without one (E6) it is kept on this computer only, and can be saved.
    pub shared: bool,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
    /// E6, said once: the repository's direction was kept over the one this
    /// computer kept before the share ([`ni_direction_notice_seen`]).
    pub notice: Option<String>,
    /// E6, on a shared workspace: why a direction is still kept on this
    /// computer — a read-only Mac shows its own until it can save
    /// ([`kept_until_writable_words`]), or a file matches no area
    /// ([`orphan_words`]).
    pub kept_here: Option<String>,
    /// A direction exists (on the branch, or queued here).
    pub exists: bool,
    /// The direction as this Mac sees it; empty when none.
    pub direction: Direction,
    /// Only while none exists.
    pub draft: Option<DirectionDraft>,
    /// The suggested "Where to look at it": only while there is no
    /// direction or its address is empty.
    pub look_at_hint: Option<LookAtHint>,
    /// 1.174.0 (C9, NIW-1): on a shared setup, the branch a save goes to
    /// (the cards' branch), said beside Save before the press.
    pub saves_to: Option<String>,
    /// C9 round 1 (owner): GitHub says that branch takes changes through a
    /// pull request (a ruleset or branch protection requiring one), read
    /// before the first save. False when unknown.
    pub saves_via_pull_request: bool,
    /// This Mac's change not on the branch yet.
    pub pending: Option<Pending>,
    /// The branch's file can't be read ([`unreadable_words`]); nothing is
    /// saved over it.
    pub problem: Option<String>,
    /// What git said about it: Details only.
    pub problem_technical: Option<String>,
    /// 1.174.0 (C11, P15): the direction written before the project had
    /// areas, while this area has none of its own ([`project_direction`]):
    /// the area's first time offers *Use it for <area>*.
    pub before_areas: Option<Direction>,
}

// ── The draft ──────────────────────────────────────────────────────────

/// What [`draft`] reads, each already capped by the caller or here.
#[derive(Debug, Clone, Default)]
pub struct DraftInputs<'a> {
    pub readme: Option<&'a str>,
    pub package_json: Option<&'a str>,
    /// The area's own `lookAt` (Settings › Areas).
    pub area_look_at: Option<&'a str>,
    /// The address of the Railway service that builds this area.
    pub railway: Option<&'a str>,
}

/// `text` cut to [`DRAFT_INPUT_MAX`] bytes on a character boundary.
pub fn capped(text: &str) -> &str {
    if text.len() <= DRAFT_INPUT_MAX {
        return text;
    }
    let mut end = DRAFT_INPUT_MAX;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Markdown inline syntax taken out: links keep their text, images and
/// HTML go, emphasis and code marks go.
fn plain(line: &str) -> String {
    // Images first, so a linked badge `[![alt](img)](url)` goes whole.
    let mut line = line.to_string();
    while let Some(start) = line.find("![") {
        let Some(end) = line[start..].find(')') else { break };
        line.replace_range(start..start + end + 1, "");
    }
    let mut out = String::new();
    let mut rest = line.as_str();
    while let Some(i) = rest.find(['[', '<', '!', '*', '_', '`']) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if tail.starts_with("![") {
            // An image: dropped with its address.
            rest = match tail.find(')') {
                Some(end) => &tail[end + 1..],
                None => "",
            };
        } else if tail.starts_with('[') {
            match (tail.find("]("), tail.find(')')) {
                (Some(close), Some(end)) if close < end => {
                    out.push_str(&tail[1..close]);
                    rest = &tail[end + 1..];
                }
                _ => {
                    out.push('[');
                    rest = &tail[1..];
                }
            }
        } else if tail.starts_with('<') {
            rest = match tail.find('>') {
                Some(end) => &tail[end + 1..],
                None => "",
            };
        } else if tail.starts_with('!') {
            out.push('!');
            rest = &tail[1..];
        } else {
            rest = &tail[1..]; // * _ `
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first paragraph of prose: after front matter, headings, badges,
/// images, HTML, code blocks, tables and lists.
pub fn first_paragraph(markdown: &str) -> Option<String> {
    let mut lines = capped(markdown).lines().peekable();
    if lines.peek().map(|l| l.trim()) == Some("---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
        }
    }
    let mut fenced = false;
    let mut paragraph: Vec<String> = Vec::new();
    for raw in lines {
        let line = raw.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if fenced {
            continue;
        }
        let structural = line.is_empty()
            || line.starts_with('#')
            || line.starts_with('|')
            || line.starts_with("- ")
            || line.starts_with("* ")
            || line.starts_with("@")
            || line.starts_with("<!--")
            || line.chars().all(|c| matches!(c, '-' | '=' | '*' | '_'));
        if structural {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        let text = plain(line.trim_start_matches('>').trim());
        if text.chars().filter(|c| c.is_alphabetic()).count() < 3 {
            if !paragraph.is_empty() {
                break;
            }
            continue; // a line of badges or HTML only
        }
        paragraph.push(text);
    }
    let joined = paragraph.join(" ");
    (!joined.is_empty()).then_some(joined)
}

/// Its first sentence, at most `max` characters (cut at a word, with "…").
pub fn first_sentence(text: &str, max: usize) -> String {
    let mut end = None;
    for (i, c) in text.char_indices() {
        if matches!(c, '.' | '!' | '?') {
            let next = text[i + c.len_utf8()..].chars().next();
            if next.is_none_or(char::is_whitespace) {
                end = Some(i + c.len_utf8());
                break;
            }
        }
    }
    let sentence = end.map_or(text, |e| &text[..e]).trim();
    if sentence.chars().count() <= max {
        return sentence.to_string();
    }
    let cut: String = sentence.chars().take(max).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches([',', ';', ':', ' ']))
}

/// The addresses a README links that are the product's own, not a badge, a
/// code host or a package registry.
const NOT_THE_PRODUCT: [&str; 12] = [
    "shields.io",
    "badge",
    "githubusercontent.com",
    "npmjs.com",
    "npmjs.org",
    "crates.io",
    "pypi.org",
    "localhost",
    "127.0.0.1",
    "example.com",
    "codecov.io",
    "circleci.com",
];

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#', ':']).next().unwrap_or("").to_ascii_lowercase()
}

fn product_address(url: &str) -> bool {
    let host = host_of(url);
    areas::valid_web_address(url)
        && host.contains('.')
        && !crate::area_discovery::is_code_host(url)
        && !NOT_THE_PRODUCT.iter().any(|n| host.contains(n) || url.contains("/badge"))
        && !api_address(url)
}

/// C9 (NIW-2): an API's address is not a page to look at — an `api.` host
/// or a versioned path (`/v1`, `/v2/…`).
fn api_address(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let path = rest.split_once('/').map_or("", |(_, p)| p);
    // C9 round 1: the path only, up to its query or fragment.
    let path = path.split(['?', '#']).next().unwrap_or("");
    let version = |seg: &str| {
        let seg = seg.to_ascii_lowercase();
        seg.len() > 1 && seg.starts_with('v') && seg[1..].chars().all(|c| c.is_ascii_digit())
    };
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // A version is an API's only first (`/v1/…`) or after `api` (`/api/v2`).
    host_of(url).starts_with("api.")
        || segments.first().is_some_and(|s| version(s))
        || segments.windows(2).any(|w| w[0].eq_ignore_ascii_case("api") && version(w[1]))
}

/// The README's address of the product: a link on a line that names it
/// (website, live, demo, homepage), else the first product address.
pub fn readme_address(markdown: &str) -> Option<String> {
    let mut first = None;
    for line in capped(markdown).lines() {
        let lower = line.to_ascii_lowercase();
        // The word that names the site, and the first address after it.
        let named = ["website", "live", "demo", "homepage", "site:", "visit"]
            .iter()
            .filter_map(|w| lower.find(w))
            .min();
        let mut rest = line;
        let mut offset = 0;
        while let Some(i) = rest.find("http") {
            let at = offset + i;
            let tail = &rest[i..];
            let end = tail
                .find(|c: char| c.is_whitespace() || matches!(c, ')' | '>' | '"' | '\'' | ']' | '<' | '`'))
                .unwrap_or(tail.len());
            // C9 round 1: `*` and `_` end an address only as markdown around
            // it (`**https://…**`); inside one (`getting_started`) they stay.
            let url = tail[..end].trim_end_matches(['.', ',', ';', '!', '*', '_']);
            if product_address(url) {
                if named.is_some_and(|n| n < at) {
                    return Some(url.to_string());
                }
                first.get_or_insert_with(|| url.to_string());
            }
            offset = at + end.max(4);
            rest = &tail[end.max(4)..];
        }
    }
    first
}

/// Drafted from the project's own words: "What you don't want" the rules
/// every proposal keeps, one approach (Polish), and "Where to look at it"
/// from Settings › Areas, Railway or package.json's homepage, in that order.
/// 1.174.0 (C9, P14, NIW-2): "For whom" stays empty, the README's first
/// sentence (else package.json's description) offered as a suggestion; an
/// address only the README gives is a suggestion too, never filled in. Pure.
pub fn draft(inputs: &DraftInputs<'_>) -> DirectionDraft {
    let package: Option<Value> = inputs
        .package_json
        .filter(|t| t.len() <= DRAFT_INPUT_MAX)
        .and_then(|t| serde_json::from_str(t).ok());
    let package_field = |key: &str| {
        package
            .as_ref()
            .and_then(|p| p.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let mut from = Vec::new();
    let mut direction = Direction { avoid: DEFAULT_AVOID.to_string(), approaches: vec![DEFAULT_APPROACH.to_string()], ..Direction::default() };
    let audience = if let Some(p) = inputs.readme.and_then(first_paragraph) {
        from.push(DraftSource::Readme);
        Some(AudienceHint { text: first_sentence(&p, 240), source: DraftSource::Readme })
    } else if let Some(d) = package_field("description") {
        from.push(DraftSource::PackageJson);
        Some(AudienceHint { text: first_sentence(&one_line(&d, TEXT_MAX), 240), source: DraftSource::PackageJson })
    } else {
        None
    };
    let homepage = package_field("homepage").filter(|u| product_address(u));
    let look_at = [
        (inputs.area_look_at.map(str::to_string), LookAtSource::Area),
        (inputs.railway.map(str::to_string), LookAtSource::Railway),
        (homepage, LookAtSource::PackageJson),
        (inputs.readme.and_then(readme_address), LookAtSource::Readme),
    ]
    .into_iter()
    .find_map(|(url, source)| {
        url.map(|u| u.trim().to_string())
            .filter(|u| areas::valid_web_address(u))
            .map(|url| LookAtHint { url, source })
    });
    if let Some(hint) = &look_at {
        // A README's address is only suggested (NIW-2).
        if hint.source != LookAtSource::Readme {
            direction.look_at = hint.url.clone();
        }
        let file = match hint.source {
            LookAtSource::PackageJson => Some(DraftSource::PackageJson),
            LookAtSource::Readme => Some(DraftSource::Readme),
            _ => None,
        };
        if let Some(file) = file.filter(|f| !from.contains(f)) {
            from.push(file);
        }
    }
    DirectionDraft { direction, from, look_at, audience }
}

/// The address of the Railway service that builds `area_path` of this
/// repository: production first, a service rooted at the area's folder (or
/// at the root for the root area) first. `https://` added when bare.
pub fn railway_address(services: &[crate::deploy_map::RailwayService], area_path: &str) -> Option<String> {
    let area_path = area_path.trim_matches('/');
    let mut candidates: Vec<&crate::deploy_map::RailwayService> =
        services.iter().filter(|s| s.this_repository && !s.domains.is_empty()).collect();
    let fits = |s: &crate::deploy_map::RailwayService| match (s.root_directory.as_deref(), area_path) {
        (None, "") => 2,
        (Some(root), path) if !path.is_empty() && (root == path || areas::path_in(path, root)) => 2,
        (None, _) => 1,
        _ => 0,
    };
    candidates.retain(|s| fits(s) > 0);
    candidates.sort_by_key(|s| (std::cmp::Reverse(fits(s)), s.environment != "production"));
    let domain = candidates.first()?.domains.first()?.trim().to_string();
    Some(if domain.contains("://") { domain } else { format!("https://{domain}") })
}

// ── Publishing ─────────────────────────────────────────────────────────

/// What one publish of one area came to.
#[derive(Debug, Clone, PartialEq)]
pub enum AreaOutcome {
    /// The branch carries it (pushed, or already there). With conflicts,
    /// every other field went and the entry waits for the choice.
    Published { pushed: bool, conflicts: Vec<String> },
    /// Opened, or brought up to this Mac's latest press.
    PullRequest(PullRequest),
    /// Still waiting in an open pull request.
    StillWaiting,
    /// The pull request was closed without merging: the change is forgotten.
    Withdrawn,
    /// E6: a direction moved from this computer met one already on the
    /// branch: the branch's is kept, this one dropped, and that said once.
    KeptRepository,
    Unreachable(String),
    Failed(String),
}

/// The pull requests a refused publish opens, behind a trait so their
/// lifecycle is tested without GitHub.
pub trait PullRequests: Send + Sync {
    /// `None` when GitHub can't say (offline): keep waiting.
    fn state(&self, git: &Plumbing, number: u64) -> Option<PrState>;
    /// Its URL.
    fn create(&self, git: &Plumbing, base: &str, head: &str, title: &str, body: &str) -> Result<String, String>;
    /// A5R-07: the pull request from this repository's own `head` branch:
    /// its state, URL and base branch (`Ok(None)`: none). A read; `Err` when
    /// GitHub can't say.
    fn for_branch(&self, git: &Plumbing, head: &str) -> Result<Option<(PrState, String, Option<String>)>, String>;
}

/// The real ones: `gh --repo <origin's repository>`.
pub struct GhPullRequests(pub Gh);

impl PullRequests for GhPullRequests {
    fn state(&self, git: &Plumbing, number: u64) -> Option<PrState> {
        let repo = git.github_repo()?;
        self.0.pr_state(&git.cwd, &repo, number).ok()
    }

    fn create(&self, git: &Plumbing, base: &str, head: &str, title: &str, body: &str) -> Result<String, String> {
        let repo = git
            .github_repo()
            .ok_or_else(|| format!("{REFUSED_MARKER}, and origin isn't a GitHub repository Plyloft can open a pull request on"))?;
        self.0.pr_create(&git.cwd, &repo, base, head, title, body)
    }

    fn for_branch(&self, git: &Plumbing, head: &str) -> Result<Option<(PrState, String, Option<String>)>, String> {
        // Round 2 (SF4): origin isn't on GitHub (any more): there is no pull
        // request there to find, and the change goes the usual way.
        let Some(repo) = git.github_repo() else {
            return Ok(None);
        };
        Ok(self.0.pr_for_branch(&git.cwd, &repo, head)?.map(|found| (found.state, found.url, found.base)))
    }
}

/// The commit line *Don't propose this…* adds: `Not to propose again: “<title>” — <reason>`.
const REJECT_LINE: &str = "Not to propose again: “";
/// The commit line *Remove* adds: `Can be proposed again: “<title>”`.
const UNREJECT_LINE: &str = "Can be proposed again: “";

/// The subject's text: a single *Don't propose this…* or *Remove* says
/// itself (1.173.0 walk: it read like a direction save), anything else —
/// a *Save*, or several presses published together — is the direction.
fn commit_subject(area: &str, lines: &[String]) -> String {
    if let [only] = lines {
        if let Some((title, _)) = only.strip_prefix(REJECT_LINE).and_then(|rest| rest.split_once("” — ")) {
            return quoted_subject("Next improvement — set aside “", title, &format!("” ({area})"));
        }
        if let Some(title) = only.strip_prefix(UNREJECT_LINE).and_then(|rest| rest.strip_suffix('”')) {
            return quoted_subject("Next improvement — “", title, &format!("” can be proposed again ({area})"));
        }
    }
    format!("Next improvement direction — {area}")
}

/// `before` + `title` + `after`, with only the title shortened ("…" inside
/// the quotes) so the whole `chore(config): …` subject fits
/// [`crate::commit_message::MAX_HEADER`] (1.173.0 re-walk: the cut used to
/// take the closing quote and the area). The full title stays in the body.
fn quoted_subject(before: &str, title: &str, after: &str) -> String {
    let fixed = crate::commit_message::config_line(&format!("{before}{after}")).chars().count();
    let room = crate::commit_message::MAX_HEADER.saturating_sub(fixed);
    let title = if title.chars().count() <= room {
        title.to_string()
    } else {
        let cut: String = title.chars().take(room.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    };
    format!("{before}{title}{after}")
}

/// `chore(config): next improvement direction — <area>` (or a set-aside's
/// own subject, [`commit_subject`]), then the lines.
pub fn commit_message(area: &str, lines: &[String], device: Option<&str>) -> String {
    let subject = crate::commit_message::config_line(&commit_subject(area, lines));
    let mut message = crate::commit_message::config_message(&[subject]);
    if !lines.is_empty() {
        message.push('\n');
        message.push_str(&lines.join("\n"));
        message.push('\n');
    }
    if let Some(device) = device.map(str::trim).filter(|d| !d.is_empty()) {
        message.push_str(&format!("\n{DEVICE_TRAILER}: {}\n", device.replace('\n', " ")));
    }
    message
}

fn commit_body(git: &Plumbing, sha: &str) -> Option<String> {
    let out = crate::platform::git_command()
        .args(["log", "-1", "--format=%B", sha])
        .current_dir(&git.cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The questions after a merge: one per conflicting field. A question whose
/// value is still the one shown keeps its author and time (this Mac's own
/// commit of the other fields doesn't make it this Mac's); a new value asks
/// again, named after the commit that last touched the file.
fn update_conflicts(
    git: &Plumbing,
    tip: &str,
    area: &str,
    keys: &[String],
    theirs: Option<&Direction>,
    entry: &mut QueuedDirection,
    device: Option<&str>,
) {
    let theirs = theirs.map(to_map).unwrap_or_default();
    let mut found: Option<Option<(String, String, i64)>> = None;
    let mut next = BTreeMap::new();
    for key in keys {
        let value = get(&theirs, key);
        if let Some(kept) = entry.conflicts.get(key).filter(|c| c.theirs == value) {
            next.insert(key.clone(), kept.clone());
            continue;
        }
        let last = found.get_or_insert_with(|| git.history(tip, &direction_path(area)).into_iter().next()).clone();
        let their_device = last
            .as_ref()
            .and_then(|(sha, _, _)| commit_body(git, sha))
            .and_then(|body| crate::shared_config::device_in_message(&body));
        let author = last.as_ref().map(|(_, a, _)| a.clone());
        // C3's comparison: any of this Mac's names, case aside; devices trimmed.
        let same_person = author
            .as_deref()
            .is_some_and(|a| crate::shared_config::my_names(git).iter().any(|n| n.eq_ignore_ascii_case(a)));
        let this_computer = same_person
            && their_device.as_deref().zip(device).is_some_and(|(theirs, mine)| theirs.trim() == mine.trim());
        next.insert(
            key.clone(),
            FieldConflict {
                theirs: value,
                this_computer,
                device: their_device,
                author,
                same_person,
                changed_at: last.map(|(_, _, t)| t),
            },
        );
    }
    entry.conflicts = next;
}

fn read_direction_at(git: &Plumbing, rev: &str, path: &str, branch: &str) -> Result<Option<Direction>, AreaOutcome> {
    match git.read_at(rev, path).map(|b| parse_direction(&b)) {
        None => Ok(None),
        Some(Ok(d)) => Ok(Some(d)),
        Some(Err(e)) => Err(AreaOutcome::Failed(format!("{path} on {branch} {e}"))),
    }
}

/// Publish one area's queued change. Takes `integration_lock`; the entry is
/// updated in place (base, questions, pull request), and the caller drops it
/// when the outcome says it is settled.
pub fn publish_area(
    git: &Plumbing,
    prs: Option<&dyn PullRequests>,
    branch: &str,
    area: &str,
    area_name: &str,
    entry: &mut QueuedDirection,
    device: Option<&str>,
    remember: &dyn Fn(&QueuedDirection) -> Result<(), String>,
) -> AreaOutcome {
    let lock = integration_lock(&git.cwd, branch);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    let label = if area_name.is_empty() { area } else { area_name };
    // A5R-07: a pull request was being opened from this branch and its
    // answer never came. It counts only when GitHub has it from that very
    // branch of origin's repository onto this branch (one aimed elsewhere is
    // left alone). Open: the change goes on top of it. Merged: its value is
    // the base now. Closed: withdrawn, as a tracked one is. None: a new one
    // is opened as usual; the branch stays recorded until it is, so the
    // retry stays the person's. Without the GitHub CLI nothing can be
    // looked for: the change goes the usual way (and settles when it is
    // back to what the branch has).
    if let (None, Some(head), Some(prs)) = (&entry.pull_request, entry.pull_request_branch.clone(), prs) {
        if !head.is_empty() {
            match prs.for_branch(git, &head) {
                Err(e) => {
                    return AreaOutcome::Failed(format!(
                        "Plyloft couldn't tell whether the pull request from {head} is open: {e}"
                    ));
                }
                Ok(Some((state, url, base))) if base.as_deref().is_none_or(|b| b == branch) => match state {
                    PrState::Open => {
                        let Some(number) = pr_number(&url) else {
                            return AreaOutcome::Failed(format!("gh printed no pull request URL: {url}"));
                        };
                        let pr = PullRequest { number, url, branch: head, head: None };
                        entry.pull_request = Some(pr.clone());
                        entry.pull_request_branch = None;
                        entry.pull_request_behind = true;
                        entry.moved = false;
                        return update_pull_request(git, &pr, area, label, entry, device);
                    }
                    PrState::Merged => {
                        entry.base = entry.pull_request_value.take().or(entry.base.take());
                        entry.moved = false;
                    }
                    PrState::Closed => {
                        entry.said = Some(CLOSED_ON_GITHUB_WORDS.to_string());
                        return AreaOutcome::Withdrawn;
                    }
                },
                Ok(Some((PrState::Open, url, Some(base)))) => {
                    log::info!("next_improvement: {url} from {head} is aimed at {base}, not {branch}: left as it is");
                    entry.said = Some(left_open_words(&url, &base));
                }
                Ok(_) => {}
            }
        }
    }
    if let Some(pr) = entry.pull_request.clone() {
        match prs.and_then(|p| p.state(git, pr.number)) {
            Some(PrState::Merged) => {
                // Its value is on the branch now, and counts as this Mac's.
                entry.base = entry.pull_request_value.take().or(entry.base.take());
                entry.pull_request = None;
                // On the branch through its own pull request: never a rival.
                entry.moved = false;
                if !entry.pull_request_behind {
                    entry.lines.clear();
                }
                entry.pull_request_behind = false;
            }
            Some(PrState::Closed) => return AreaOutcome::Withdrawn,
            Some(PrState::Open) if entry.pull_request_behind => {
                return update_pull_request(git, &pr, area, label, entry, device);
            }
            Some(PrState::Open) | None => return AreaOutcome::StillWaiting,
        }
    }
    let path = direction_path(area);
    for attempt in 1..=2 {
        match git.fetch(branch) {
            Ok(()) => {}
            Err(FetchFailure::Unreachable(e)) => return AreaOutcome::Unreachable(e),
            Err(failed) => return AreaOutcome::Failed(failed.to_string()),
        }
        let Some(tip) = git.tip(branch) else {
            return AreaOutcome::Failed(format!("origin has no branch {branch} to publish to"));
        };
        let theirs = match read_direction_at(git, &tip, &path, branch) {
            Ok(d) => d,
            Err(outcome) => return outcome,
        };
        if yields(entry, theirs.as_ref()) {
            return AreaOutcome::KeptRepository;
        }
        let merged = merge(entry.base.as_ref(), theirs.as_ref(), &entry.value);
        update_conflicts(git, &tip, area, &merged.conflicts, theirs.as_ref(), entry, device);
        if theirs.as_ref() == Some(&merged.value) || (theirs.is_none() && merged.value == Direction::default()) {
            return AreaOutcome::Published { pushed: false, conflicts: merged.conflicts };
        }
        let message = commit_message(label, &entry.lines, device);
        let changes = [FileChange { path: path.clone(), bytes: direction_bytes(&merged.value) }];
        let sha = match git.commit_files(&tip, &changes, &message) {
            Ok(sha) => sha,
            Err(e) => return AreaOutcome::Failed(e),
        };
        match git.push(&sha, branch) {
            PushResult::Pushed => {
                log::info!("next_improvement: published the direction for {area} to {branch} as {sha}");
                entry.lines.clear();
                return AreaOutcome::Published { pushed: true, conflicts: merged.conflicts };
            }
            PushResult::NonFastForward(e) if attempt == 1 => {
                log::info!("next_improvement: {branch} moved on, retrying once: {e}");
            }
            PushResult::NonFastForward(e) | PushResult::Refused(e) => {
                return open_pull_request(git, prs, branch, area, label, &sha, &message, &e, merged.value, entry, remember);
            }
            PushResult::Unreachable(e) => return AreaOutcome::Unreachable(e),
        }
    }
    unreachable!("the second attempt always returns")
}

/// A press while the pull request waits: one more commit on its branch, on
/// top of its tip — a fast-forward, never forced.
fn update_pull_request(
    git: &Plumbing,
    pr: &PullRequest,
    area: &str,
    label: &str,
    entry: &mut QueuedDirection,
    device: Option<&str>,
) -> AreaOutcome {
    match git.fetch(&pr.branch) {
        Ok(()) => {}
        Err(FetchFailure::Unreachable(e)) => return AreaOutcome::Unreachable(e),
        Err(failed) => return AreaOutcome::Failed(failed.to_string()),
    }
    let Some(tip) = git.tip(&pr.branch) else {
        return AreaOutcome::Failed(format!("origin has no branch {} any more", pr.branch));
    };
    let path = direction_path(area);
    let theirs = match read_direction_at(git, &tip, &path, &pr.branch) {
        Ok(d) => d,
        Err(outcome) => return outcome,
    };
    // A5R-07: a pull request found by its branch proposes what its branch has.
    let proposed = entry.pull_request_value.as_ref().or(theirs.as_ref());
    let value = merge(proposed, theirs.as_ref(), &entry.value).value;
    if theirs.as_ref() == Some(&value) {
        entry.pull_request_behind = false;
        return AreaOutcome::StillWaiting;
    }
    let message = commit_message(label, &entry.lines, device);
    let sha = match git.commit_files(&tip, &[FileChange { path, bytes: direction_bytes(&value) }], &message) {
        Ok(sha) => sha,
        Err(e) => return AreaOutcome::Failed(e),
    };
    match git.push(&sha, &pr.branch) {
        PushResult::Pushed => {
            entry.pull_request_value = Some(value);
            entry.pull_request_behind = false;
            AreaOutcome::PullRequest(pr.clone())
        }
        PushResult::Unreachable(e) => AreaOutcome::Unreachable(e),
        // Review S8: somebody added to it meanwhile — a race, no refusal.
        PushResult::NonFastForward(e) => {
            AreaOutcome::Failed(format!("the pull request's branch {} moved on meanwhile: {e}", pr.branch))
        }
        PushResult::Refused(e) => {
            AreaOutcome::Failed(format!("the pull request's branch {} {REFUSED_MARKER}: {e}", pr.branch))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn open_pull_request(
    git: &Plumbing,
    prs: Option<&dyn PullRequests>,
    branch: &str,
    area: &str,
    label: &str,
    sha: &str,
    message: &str,
    refused: &str,
    value: Direction,
    entry: &mut QueuedDirection,
    remember: &dyn Fn(&QueuedDirection) -> Result<(), String>,
) -> AreaOutcome {
    let why = refused.lines().last().unwrap_or(refused).trim().to_string();
    let Some(prs) = prs else {
        return AreaOutcome::Failed(format!(
            "{branch} {REFUSED_MARKER} ({why}) and the GitHub CLI isn't available to open a pull request instead"
        ));
    };
    let first = format!(
        "atelier/config-next-improvement-{}-{}",
        crate::shared_config::kebab(area),
        crate::shared_config::now_millis() / 1000
    );
    let mut head = None;
    let mut last = String::new();
    for candidate in crate::shared_config::fallback_branches(&first) {
        match git.push(sha, &candidate) {
            PushResult::Pushed => {
                head = Some(candidate);
                break;
            }
            PushResult::Unreachable(e) => return AreaOutcome::Unreachable(e),
            PushResult::NonFastForward(e) | PushResult::Refused(e) => last = e,
        }
    }
    let Some(head) = head else {
        return AreaOutcome::Failed(format!("{branch} {REFUSED_MARKER}, and the pull request branch too: {last}"));
    };
    let title = format!("Settings: Next improvement direction — {}", subject_of(label_name(area, label)));
    let body = format!(
        "{message}\nPlyloft couldn't push this to `{branch}` directly ({why}), so it waits here. Only `{}` changes.",
        direction_path(area)
    );
    // A5R-07: kept on disk before the create, so a lost answer (a timeout,
    // a quit) is looked for at the next press instead of opened again.
    entry.pull_request_branch = Some(head.clone());
    entry.pull_request_value = Some(value.clone());
    if let Err(e) = remember(entry) {
        // Not on disk, a lost answer couldn't be found again: no create.
        return AreaOutcome::Failed(format!("Plyloft couldn't keep the pull request's branch {head} before opening it: {e}"));
    }
    let creating = Creating::start(entry);
    let created = prs.create(git, branch, &head, &title, &body);
    drop(creating);
    let url = match created {
        Ok(url) => url,
        // A5R-02: no `REFUSED_MARKER` — as the other channels word it, this
        // is no refusal, and this computer stays able to change the setup.
        Err(e) => {
            return AreaOutcome::Failed(format!(
                "{branch} takes no direct push, and the pull request from {head} couldn't be opened: {e}"
            ))
        }
    };
    let Some(number) = pr_number(&url) else {
        return AreaOutcome::Failed(format!("gh printed no pull request URL: {url}"));
    };
    // Its branch takes more commits on top later (`update_pull_request`), so
    // no head is recorded: nothing here compares with one.
    let pr = PullRequest { number, url, branch: head, head: None };
    entry.pull_request = Some(pr.clone());
    entry.pull_request_branch = None;
    entry.pull_request_value = Some(value);
    entry.pull_request_behind = false;
    entry.lines.clear();
    // Proposed now: once merged it is the branch's own, not a rival to it.
    entry.moved = false;
    AreaOutcome::PullRequest(pr)
}

/// The implicit area's label is its file name; say "this project" instead.
fn label_name<'a>(area: &str, label: &'a str) -> &'a str {
    if label == area && area == IMPLICIT_AREA_ID {
        ""
    } else {
        label
    }
}

/// Apply an outcome to the queue: settled entries leave it. `true` when the
/// remote refused and no pull request could carry the change.
fn settle(queue: &mut DirectionQueue, area: &str, mut entry: QueuedDirection, outcome: &AreaOutcome) -> bool {
    match outcome {
        AreaOutcome::Published { conflicts, .. } if conflicts.is_empty() && !entry.pull_request_behind => {
            queue.areas.remove(area);
        }
        AreaOutcome::Withdrawn => {
            queue.areas.remove(area);
        }
        AreaOutcome::KeptRepository => {
            queue.areas.remove(area);
            queue.kept_repository.insert(area.to_string());
        }
        AreaOutcome::Published { .. } | AreaOutcome::PullRequest(_) | AreaOutcome::StillWaiting => {
            // Round 3: a change waiting for a press stays so until it leaves
            // the queue or its pull request is opened or adopted — a press
            // that settled with questions left pushed nothing.
            if !waits_for_press(&entry) {
                entry.last_error = None;
                entry.last_offline = false;
            }
            // Only a try that wrote something counts: a question waiting
            // through refreshes is not a retry.
            if matches!(outcome, AreaOutcome::Published { pushed: true, .. } | AreaOutcome::PullRequest(_)) {
                entry.attempts += 1;
            }
            queue.areas.insert(area.to_string(), entry);
        }
        AreaOutcome::Unreachable(e) | AreaOutcome::Failed(e) => {
            entry.attempts += 1;
            entry.last_offline = matches!(outcome, AreaOutcome::Unreachable(_));
            entry.last_error = Some(e.clone());
            let refused = !entry.last_offline && e.contains(REFUSED_MARKER);
            queue.areas.insert(area.to_string(), entry);
            return refused;
        }
    }
    false
}

/// A5R-02: a computer that 1.176.2 or earlier made read-only only because a
/// pull request couldn't be opened — the refusal it recorded is word for
/// word that queued change's error — can change the setup again. Nothing is
/// written to GitHub; the change waits for the person's press.
fn writable_again(store: &ProjectConfigStore, workspace_id: &str) {
    let Some(mut cache) = crate::workspace_definition::load_cache(store, workspace_id) else {
        return;
    };
    let Some(refused) = cache.write_access.push_refused.clone() else {
        return;
    };
    if cache.write_access.can_push == Some(false) || !opened_no_pull_request_before(&refused) {
        return;
    }
    let queue = load_queue(store, workspace_id);
    if !queue.areas.values().any(|q| q.pull_request.is_none() && q.last_error.as_deref() == Some(refused.as_str())) {
        return;
    }
    cache.write_access.push_refused = None;
    match crate::workspace_definition::save_cache(store, workspace_id, &cache) {
        Ok(()) => log::info!("next_improvement: {workspace_id} can change the shared setup again (a pull request that couldn't be opened is no refusal)"),
        Err(e) => log::warn!("next_improvement: saving write access failed: {e}"),
    }
}

fn record_write_access(store: &ProjectConfigStore, workspace_id: &str, refused: Option<String>, pushed: bool) {
    let Some(mut cache) = crate::workspace_definition::load_cache(store, workspace_id) else {
        return;
    };
    let before = cache.write_access.clone();
    if let Some(refused) = refused {
        cache.write_access.push_refused = Some(refused);
    } else if pushed {
        cache.write_access.push_refused = None;
    }
    if cache.write_access != before {
        if let Err(e) = crate::workspace_definition::save_cache(store, workspace_id, &cache) {
            log::warn!("next_improvement: saving write access failed: {e}");
        }
    }
}

/// The real channel's pieces for a workspace folder.
pub struct Channel {
    pub git: Plumbing,
    pub prs: Option<Box<dyn PullRequests>>,
    pub device: Option<String>,
}

impl Channel {
    pub fn for_folder(cwd: &Path) -> Self {
        let gh = if cfg!(test) { None } else { crate::doctor::require("gh").ok() };
        Channel {
            git: Plumbing { cwd: cwd.to_path_buf() },
            prs: gh.map(|path| Box::new(GhPullRequests(Gh::new(path))) as Box<dyn PullRequests>),
            device: crate::account::shared_device_name(),
        }
    }
}

/// Publish every queued area (only `only` when given); the areas whose
/// state changed, for `ni://direction`. Nothing runs on a read-only Mac.
/// Called under the workspace's definition lock: by each refresh, and right
/// after a press.
pub fn drain_with(store: &ProjectConfigStore, channel: &Channel, workspace_id: &str, only: Option<&str>) -> Vec<String> {
    writable_again(store, workspace_id);
    let Some(t) = target(store, workspace_id).filter(|t| !t.read_only) else {
        return Vec::new(); // unshared since, or read-only: kept
    };
    // E6: what this computer kept while the setup wasn't shared goes first.
    let mut moved = adopt_local(store, workspace_id);
    let mut queue = load_queue(store, workspace_id);
    if queue.areas.is_empty() {
        return moved;
    }
    let defined = areas::load(store, workspace_id);
    // A5R-02: a read (no `only`) leaves a change that waits for a press.
    let keys: Vec<String> = queue
        .areas
        .iter()
        .filter(|(k, q)| match only {
            Some(o) => o == k.as_str(),
            None => !waits_for_press(q),
        })
        .map(|(k, _)| k.clone())
        .collect();
    let mut refused = None;
    let mut pushed = false;
    let mut changed = Vec::new();
    for key in keys {
        let Some(mut entry) = queue.areas.remove(&key) else { continue };
        let before = entry.clone();
        let name = defined.iter().find(|a| a.id == key).map(|a| a.name.clone()).unwrap_or_default();
        let remember = |e: &QueuedDirection| {
            let mut kept = queue.clone();
            kept.areas.insert(key.clone(), e.clone());
            save_queue(store, workspace_id, &kept)
        };
        let outcome = publish_area(
            &channel.git,
            channel.prs.as_deref(),
            &t.branch,
            &key,
            &name,
            &mut entry,
            channel.device.as_deref(),
            &remember,
        );
        if let Some(words) = entry.said.take() {
            said_notices().lock().unwrap_or_else(|p| p.into_inner()).insert(notice_key(store, workspace_id, &key), words);
            changed.push(key.clone());
        }
        pushed |= matches!(outcome, AreaOutcome::Published { pushed: true, .. });
        let message = match &outcome {
            AreaOutcome::Failed(e) => Some(e.clone()),
            _ => None,
        };
        if settle(&mut queue, &key, entry, &outcome) {
            refused = message;
        }
        let same = |q: &QueuedDirection| QueuedDirection { attempts: 0, ..q.clone() } == QueuedDirection { attempts: 0, ..before.clone() };
        if !queue.areas.get(&key).is_some_and(same) && !changed.contains(&key) {
            changed.push(key);
        }
    }
    if let Err(e) = save_queue(store, workspace_id, &queue) {
        log::warn!("next_improvement: saving the queue for {workspace_id} failed: {e}");
    }
    record_write_access(store, workspace_id, refused, pushed);
    for area in moved.drain(..) {
        if !changed.contains(&area) {
            changed.push(area);
        }
    }
    changed
}

/// [`drain_with`] over the workspace folder's real channel: what every
/// definition refresh runs. The areas whose state changed.
pub fn drain(store: &ProjectConfigStore, cwd: &Path, workspace_id: &str) -> Vec<String> {
    if load_queue(store, workspace_id).areas.is_empty() && local_areas(store, workspace_id).is_empty() {
        return Vec::new();
    }
    drain_with(store, &Channel::for_folder(cwd), workspace_id, None)
}

// ── The presses ────────────────────────────────────────────────────────

/// One change the person made.
#[derive(Debug, Clone, PartialEq)]
pub enum Edit {
    /// *Save*: the whole direction as the editor holds it (its rejected list
    /// is ignored: only its own presses change that).
    Save(Direction),
    /// *Don't propose this…*.
    Reject { title: String, reason: String, by: Option<String>, device: Option<String>, at: i64 },
    /// *Remove* on the list "Not to propose again": the row's position in
    /// the list the view showed, with its title and time, so a list that
    /// moved since never removes another row.
    Unreject { index: usize, title: String, at: i64 },
}

pub const GONE_WORDS: &str = "That idea isn't on the list any more.";

/// `edit` over `current`: the direction after it, and the line it adds to
/// the commit message (`None`: a *Save* that changed nothing).
fn apply(current: &Direction, edit: Edit, name: &str) -> Result<(Direction, Option<String>), String> {
    let mut next = current.clone();
    let line = match edit {
        Edit::Save(d) => {
            let d = normalized_for_save(d)?;
            next = Direction { rejected: current.rejected.clone(), ..d };
            // Keys this build doesn't know stay as the file had them.
            for (k, v) in &current.extra {
                next.extra.entry(k.clone()).or_insert_with(|| v.clone());
            }
            (next != *current).then(|| "Direction saved".to_string())
        }
        Edit::Reject { title, reason, by, device, at } => {
            let title = one_line(&title, TITLE_MAX);
            let reason = one_line(&reason, REASON_MAX);
            if title.is_empty() {
                return Err("Say which idea not to propose again.".to_string());
            }
            if reason.is_empty() {
                return Err("Say why, in one line.".to_string());
            }
            if next.rejected.len() >= REJECTED_MAX {
                return Err(format!(
                    "{} keeps at most {REJECTED_MAX} ideas not to propose again; remove some first.",
                    if name.is_empty() { "This project".to_string() } else { name.to_string() }
                ));
            }
            let line = format!("{REJECT_LINE}{title}” — {reason}");
            next.rejected.push(Rejected { title, reason, at, by, device, extra: BTreeMap::new() });
            Some(line)
        }
        Edit::Unreject { index, title, at } => {
            if !next.rejected.get(index).is_some_and(|r| r.title == title && r.at == at) {
                return Err(GONE_WORDS.to_string());
            }
            let gone = next.rejected.remove(index);
            Some(format!("{UNREJECT_LINE}{}”", gone.title))
        }
    };
    Ok((next, line))
}

/// Record `edit` for `area` where [`place`] says the direction is kept: in
/// this computer's own data while the setup isn't shared (written at once,
/// atomically; no git), else queued against the branch's current file.
/// Refuses on a read-only Mac and over an unreadable file. While a field
/// waits for a choice, *Save* waits too; the rejected list never does.
pub fn record(
    store: &ProjectConfigStore,
    git: &Plumbing,
    workspace_id: &str,
    area: Option<&str>,
    default_area: Option<&str>,
    edit: Edit,
) -> Result<String, String> {
    let (key, name) = area_key(store, workspace_id, area, default_area)?;
    let t = match place(store, workspace_id) {
        Place::ThisComputer => {
            // The only area still reading `default` (C11 round 3): a press
            // writes `<area>.json`, and the old file goes once it is there.
            // C17: a newer Plyloft's old file is refused, not read as none
            // and removed; it goes only when it was read.
            let file = local_read_for(store, workspace_id, &key);
            if file != key {
                crate::atomic::refuse_newer_on_disk(
                    &local_path(store, workspace_id, &file)?,
                    "schemaVersion",
                    DIRECTION_SCHEMA_VERSION,
                    "The direction kept on this computer",
                )?;
            }
            let loaded = load_local(store, workspace_id, &file);
            let current = loaded.clone().unwrap_or_default();
            let (next, _) = apply(&current, edit, &name)?;
            if next != current || file != key {
                save_local(store, workspace_id, &key, &next)?;
            }
            if file != key && loaded.is_some() {
                if let Err(e) = remove_local(&local_path(store, workspace_id, &file)?) {
                    log::warn!("next_improvement: {e}");
                }
            }
            return Ok(key);
        }
        Place::Repository(t) => t,
    };
    if t.read_only {
        return Err(read_only_words(&name));
    }
    let theirs = read_branch(git, &t.branch, &key).map_err(|e| {
        log::info!("next_improvement: {e}");
        unreadable_words(&name)
    })?;
    // E6: a direction still kept here since before the share goes first.
    adopt_local(store, workspace_id);
    let mut queue = load_queue(store, workspace_id);
    let removed = queue.areas.remove(&key);
    let queued = unless_repository_has_one(&mut queue, &key, removed, theirs.as_ref());
    let waiting = queued.as_ref().is_some_and(|q| !q.conflicts.is_empty());
    if waiting && matches!(edit, Edit::Save(_)) {
        return Err(format!(
            "Someone else changed the direction for {} too: choose which answer to keep first.",
            subject_of(&name)
        ));
    }
    // The entry this press builds on. Re-based onto the branch's file when
    // nothing waits, so an entry another Mac added is this change's to keep
    // or remove; otherwise kept against its base, its pull request and its
    // questions.
    let mut entry = match queued {
        None => QueuedDirection::new(theirs.clone().unwrap_or_default(), theirs.clone(), Vec::new()),
        Some(mut q) if q.pull_request.is_some() => {
            q.pull_request_behind = true;
            q
        }
        Some(mut q) if waiting => {
            q.value = merge(q.base.as_ref(), theirs.as_ref(), &q.value).shown;
            q
        }
        Some(q) => {
            let value = merge(q.base.as_ref(), theirs.as_ref(), &q.value).value;
            QueuedDirection { value, base: theirs.clone(), ..q }
        }
    };
    let (next, line) = apply(&entry.value, edit, &name)?;
    entry.lines.extend(line);
    // A press after the share is this computer's own change: it merges with
    // the branch (and asks C3's question) like any other, never dropped.
    entry.moved = false;
    if entry.lines.len() > LINES_MAX {
        let extra = entry.lines.len() - LINES_MAX;
        entry.lines.drain(..extra);
    }
    let plain = entry.pull_request.is_none() && entry.pull_request_branch.is_none() && entry.conflicts.is_empty();
    if plain && entry.base.is_some() && Some(&next) == entry.base.as_ref() {
        // Back to what the branch has: nothing to publish.
        save_queue(store, workspace_id, &queue)?;
        return Ok(key);
    }
    entry.value = next;
    entry.attempts = 0;
    entry.last_error = None;
    entry.last_offline = false;
    queue.areas.insert(key.clone(), entry);
    save_queue(store, workspace_id, &queue)?;
    Ok(key)
}

/// The question as it was shown (C3's `ShownConflict`): an answer to an
/// older question records nothing.
pub use crate::workspace_definition::ShownConflict;

/// The person's answer to one direction question (`ni-<area>-<field>`):
/// `keep_mine` publishes this Mac's value over exactly the one shown;
/// otherwise the branch's is kept and this Mac's change to that field is
/// dropped. `Ok(None)` when there is no such question any more, or it
/// changed since it was shown: nothing changes. `Ok(Some(area))` otherwise.
pub fn resolve(
    store: &ProjectConfigStore,
    workspace_id: &str,
    field_id: &str,
    keep_mine: bool,
    shown: &ShownConflict,
) -> Result<Option<String>, String> {
    let mut queue = load_queue(store, workspace_id);
    // Matched against the queue's own areas and questions, so an area id or
    // a field key with a dash is answered too.
    let Some((area, field)) = queue.areas.iter().find_map(|(area, entry)| {
        entry.conflicts.keys().find(|key| conflict_field(area, key) == field_id).map(|key| (area.clone(), key.clone()))
    }) else {
        return Ok(None);
    };
    let field = field.as_str();
    let Some(entry) = queue.areas.get_mut(&area) else {
        return Ok(None);
    };
    let Some(conflict) = entry.conflicts.get(field).cloned() else {
        return Ok(None);
    };
    if conflict.theirs != shown.theirs || conflict.changed_at != shown.changed_at {
        return Ok(None);
    }
    entry.conflicts.remove(field);
    let mut base = entry.base.as_ref().map(to_map).unwrap_or_default();
    set(&mut base, field, conflict.theirs.clone());
    entry.base = Some(from_map(base));
    if keep_mine {
        entry.lines.push(format!(
            "{} — over {}'s answer",
            field_words(field),
            conflict.author.clone().unwrap_or_else(|| "someone else".to_string())
        ));
    } else {
        let mut mine = to_map(&entry.value);
        set(&mut mine, field, conflict.theirs);
        entry.value = from_map(mine);
    }
    entry.attempts = 0;
    entry.last_error = None;
    save_queue(store, workspace_id, &queue)?;
    Ok(Some(area))
}

/// The view of one area. Reads only (atomic files, git without writing):
/// no lock. `railway` is asked only while there is no direction or its
/// address is empty.
pub fn view(
    store: &ProjectConfigStore,
    git: &Plumbing,
    workspace_id: &str,
    area: Option<&str>,
    default_area: Option<&str>,
    railway: &dyn Fn() -> Vec<crate::deploy_map::RailwayService>,
) -> Result<DirectionView, String> {
    let (key, name) = area_key(store, workspace_id, area, default_area)?;
    let defined = areas::load(store, workspace_id);
    let area_def = defined.iter().find(|a| a.id == key);
    let area_path = area_def.map(|a| areas::normalize_path(&a.path)).unwrap_or_default();
    let target = match place(store, workspace_id) {
        Place::Repository(t) => Some(t),
        Place::ThisComputer => None,
    };
    let queue = load_queue(store, workspace_id);
    let queued = queue.areas.get(&key).filter(|_| target.is_some());
    let (theirs, problem) = match &target {
        Some(t) => match read_branch(git, &t.branch, &key) {
            Ok(d) => (d, None),
            Err(e) => (None, Some(e)),
        },
        // E6: kept on this computer.
        None => (load_local(store, workspace_id, &local_read_for(store, workspace_id, &key)), None),
    };
    // E6: on a shared workspace, a direction still kept here counts as this
    // computer's change until it moves (or the branch has its own).
    let kept = match (&target, queued) {
        (Some(_), None) => pending_for(store, workspace_id, &queue, &key),
        _ => None,
    };
    // Shown from here only while the branch has none (else the branch's is it).
    let shown_from_here = kept.is_some() && theirs.is_none();
    let direction = if target.is_some() { effective(theirs.as_ref(), queued.or(kept.as_ref())) } else { theirs };
    let exists = direction.is_some();
    let wants_hint = !exists || direction.as_ref().is_some_and(|d| d.look_at.trim().is_empty());
    let drafted = wants_hint.then(|| {
        // The draft's files: the branch's when there is one, else the folder's.
        let rev = target.as_ref().and_then(|t| git.tip(&t.branch));
        let top = if rev.is_none() { git_top(git) } else { None };
        let read = |path: &str| -> Option<String> {
            let bytes = match (&rev, &top) {
                (Some(tip), _) => read_blob_capped(git, tip, path),
                (None, Some(top)) => read_capped(&top.join(path)),
                (None, None) => None,
            }?;
            Some(capped(&String::from_utf8_lossy(&bytes)).to_string())
        };
        let in_area = |file: &str| -> Option<String> {
            if area_path.is_empty() {
                read(file)
            } else {
                read(&format!("{area_path}/{file}")).or_else(|| read(file))
            }
        };
        let readme = in_area("README.md");
        let package = in_area("package.json");
        let railway_url = railway_address(&railway(), &area_path);
        draft(&DraftInputs {
            readme: readme.as_deref(),
            package_json: package.as_deref(),
            area_look_at: area_def.and_then(|a| a.look_at.as_deref()),
            railway: railway_url.as_deref(),
        })
    });
    let read_only = target.as_ref().is_some_and(|t| t.read_only);
    // C11: only for an area of a list, with nothing of its own yet.
    let before_areas = (!exists && problem.is_none() && !defined.is_empty())
        .then(|| project_direction(store, git, workspace_id))
        .flatten();
    Ok(DirectionView {
        area: key.clone(),
        area_name: name.clone(),
        path: direction_path(&key),
        shared: target.is_some(),
        read_only,
        read_only_reason: read_only.then(|| read_only_words(&name)),
        // Round 3: both, when one press found both; `notice_seen` forgets both.
        notice: match (
            (target.is_some() && queue.kept_repository.contains(&key)).then(kept_repository_words),
            said_notice(store, workspace_id, &key),
        ) {
            (Some(kept), Some(said)) => Some(format!("{kept} {said}")),
            (kept, said) => kept.or(said),
        },
        kept_here: match &target {
            Some(t) if t.read_only && shown_from_here => Some(kept_until_writable_words()),
            // Said on one view only: the implicit area's, or the area a call
            // naming none goes to (where `default` would have gone).
            Some(_) if key == IMPLICIT_AREA_ID
                || resolve_area(&defined, None, default_area).is_ok_and(|(k, _)| k == key) =>
            {
                orphan_local_files(store, workspace_id).first().map(|f| orphan_words(f))
            }
            Some(_) => None,
            None => None,
        },
        exists,
        direction: direction.unwrap_or_default(),
        look_at_hint: drafted.as_ref().and_then(|d| d.look_at.clone()),
        saves_to: target.as_ref().filter(|t| !t.read_only).map(|t| t.branch.clone()),
        saves_via_pull_request: false,
        draft: drafted.filter(|_| !exists),
        pending: queued.map(|q| pending_of(q, &key, &name)),
        problem: problem.as_ref().map(|_| unreadable_words(&name)),
        problem_technical: problem,
        before_areas,
    })
}

fn git_top(git: &Plumbing) -> Option<PathBuf> {
    let out = crate::platform::git_command()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&git.cwd)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if out.status.success() {
        Some(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
    } else {
        Some(git.cwd.clone())
    }
}

/// A blob at `rev`, only when it is at most [`DRAFT_INPUT_MAX`] bytes
/// (`git cat-file -s` first: a huge file is never read).
fn read_blob_capped(git: &Plumbing, rev: &str, path: &str) -> Option<Vec<u8>> {
    let out = crate::platform::git_command()
        .args(["cat-file", "-s", &format!("{rev}:{path}")])
        .current_dir(&git.cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let size: usize = String::from_utf8_lossy(&out.stdout).trim().parse().ok().filter(|_| out.status.success())?;
    (size <= DRAFT_INPUT_MAX).then(|| git.read_at(rev, path)).flatten()
}

/// A file of the folder, only when it is at most [`DRAFT_INPUT_MAX`] bytes.
fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > DRAFT_INPUT_MAX as u64 {
        return None;
    }
    std::fs::read(path).ok()
}

// ── IPC ────────────────────────────────────────────────────────────────

/// The workspace's folder and its default area (B2), from the store.
fn workspace_of(app: &tauri::AppHandle, workspace_id: &str) -> Result<(PathBuf, Option<String>), String> {
    use tauri::Manager;
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| (PathBuf::from(w.cwd), w.default_area))
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

fn view_for(app: &tauri::AppHandle, workspace_id: &str, area: Option<&str>) -> Result<DirectionView, String> {
    use tauri::Manager;
    let (cwd, default_area) = workspace_of(app, workspace_id)?;
    let store = app.state::<ProjectConfigStore>();
    let git = Plumbing { cwd: cwd.clone() };
    let mut v = view(&store, &git, workspace_id, area, default_area.as_deref(), &|| {
        crate::deploy_map::railway_services(workspace_id, &cwd)
    })?;
    // C9 round 1 (owner): said beside Save before the first one.
    v.saves_via_pull_request = v.saves_to.as_deref().is_some_and(|branch| needs_pull_request(&cwd, branch));
    Ok(v)
}

// ── Does the branch take a pull request? (C9 round 1, reads only) ──────

/// `gh api repos/{o}/{r}/rules/branches/{b}` (readable with read access):
/// a ruleset on the branch requires a pull request. None when it isn't
/// that answer.
pub fn rules_require_pull_request(json: &str) -> Option<bool> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    Some(v.as_array()?.iter().any(|rule| rule.get("type").and_then(Value::as_str) == Some("pull_request")))
}

/// `gh api repos/{o}/{r}/branches/{b}/protection` (only an administrator
/// may read it): the classic protection requires pull request reviews.
pub fn protection_requires_pull_request(json: &str) -> bool {
    serde_json::from_str::<Value>(json.trim())
        .ok()
        .and_then(|v| v.get("required_pull_request_reviews").map(|x| !x.is_null()))
        .unwrap_or(false)
}

/// The two reads, cached for a few minutes per repository and branch:
/// `true` only when GitHub said so. Nothing is written.
fn needs_pull_request(cwd: &Path, branch: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<HashMap<(String, String), (bool, Instant)>>> = OnceLock::new();
    const FOR: Duration = Duration::from_secs(10 * 60);
    let Some(url) = crate::platform::git_command()
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    else {
        return false;
    };
    // `owner/name` on github.com only; another host isn't asked.
    let Some(repo) = crate::shared_config::github_repo_of(&url).filter(|r| r.matches('/').count() == 1) else {
        return false;
    };
    let key = (repo.clone(), branch.to_string());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((said, at)) = cache.lock().ok().and_then(|c| c.get(&key).copied()) {
        if at.elapsed() < FOR {
            return said;
        }
    }
    let said = crate::github::branch_rules(&repo, branch).ok().and_then(|j| rules_require_pull_request(&j)) == Some(true)
        || crate::github::branch_protection(&repo, branch).is_ok_and(|j| protection_requires_pull_request(&j));
    if let Ok(mut c) = cache.lock() {
        c.insert(key, (said, Instant::now()));
    }
    said
}

/// `ni://direction` for each area that changed.
pub fn emit_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, areas: &[String]) {
    use tauri::Emitter;
    for area in areas {
        let _ = app.emit(DIRECTION_EVENT, serde_json::json!({ "workspaceId": workspace_id, "area": area }));
    }
}

/// `ni_direction_get`: one area's direction (`area` absent: see
/// [`resolve_area`]), a draft while there is none, and whether it can be
/// saved. Off the main thread, without the workspace lock (reads only); it
/// may ask Railway once (D1's cache) when an address is missing.
#[tauri::command(async)]
pub fn ni_direction_get(app: tauri::AppHandle, workspace_id: String, area: Option<String>) -> Result<DirectionView, String> {
    view_for(&app, &workspace_id, area.as_deref())
}

/// Record and publish under the workspace lock; read the view after it.
fn press(
    app: &tauri::AppHandle,
    workspace_id: &str,
    area: Option<&str>,
    edit: impl FnOnce(&Plumbing) -> Edit,
) -> Result<DirectionView, String> {
    let (_, default_area) = workspace_of(app, workspace_id)?;
    let (key, changed) = crate::workspace_definition::with_workspace_lock(app, workspace_id, |stores, repo| {
        let channel = Channel::for_folder(&repo.cwd);
        let key = record(stores.project_configs, &channel.git, workspace_id, area, default_area.as_deref(), edit(&channel.git))?;
        let mut changed = drain_with(stores.project_configs, &channel, workspace_id, Some(&key));
        if !changed.contains(&key) {
            changed.push(key.clone());
        }
        Ok((key, changed))
    })?;
    emit_changed(app, workspace_id, &changed);
    view_for(app, workspace_id, Some(&key))
}

/// `ni_direction_save`: *Save* (and *Save and prepare proposals*, which then
/// starts a round). Published at once; offline it waits for the next refresh.
#[tauri::command(async)]
pub fn ni_direction_save(app: tauri::AppHandle, workspace_id: String, area: Option<String>, direction: Direction) -> Result<DirectionView, String> {
    press(&app, &workspace_id, area.as_deref(), |_| Edit::Save(direction))
}

/// `ni_reject`: *Don't propose this…* — the idea's title and one line of why.
#[tauri::command(async)]
pub fn ni_reject(app: tauri::AppHandle, workspace_id: String, area: Option<String>, idea: String, reason: String) -> Result<DirectionView, String> {
    press(&app, &workspace_id, area.as_deref(), |git| Edit::Reject {
        title: idea,
        reason,
        by: git.user_name(),
        device: crate::account::shared_device_name(),
        at: crate::shared_config::now_millis(),
    })
}

/// `ni_unreject`: *Remove* on "Not to propose again" — the row's position in
/// the view's `direction.rejected`, its `title` and its `at`.
#[tauri::command(async)]
pub fn ni_unreject(
    app: tauri::AppHandle,
    workspace_id: String,
    area: Option<String>,
    index: usize,
    title: String,
    at: i64,
) -> Result<DirectionView, String> {
    press(&app, &workspace_id, area.as_deref(), |_| Edit::Unreject { index, title, at })
}

/// `ni_direction_notice_seen(workspaceId, area)`: E6's notice was shown;
/// it isn't said again. `area` is the view's own `area`.
#[tauri::command(async)]
pub fn ni_direction_notice_seen(app: tauri::AppHandle, workspace_id: String, area: String) -> Result<(), String> {
    crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, _| {
        notice_seen(stores.project_configs, &workspace_id, &area).map(|_| ())
    })
}

/// `ni_direction_project(workspaceId)`: C11's sheet question — the
/// direction written before the areas and the areas without their own, or
/// `null`. Reads only: no lock.
#[tauri::command(async)]
pub fn ni_direction_project(app: tauri::AppHandle, workspace_id: String) -> Result<Option<BeforeAreas>, String> {
    use tauri::Manager;
    let (cwd, _) = workspace_of(&app, &workspace_id)?;
    let store = app.state::<ProjectConfigStore>();
    Ok(before_areas(&store, &Plumbing { cwd }, &workspace_id))
}

/// `ni_direction_adopt_project(workspaceId, areas, direction?)`: C11's *Use
/// it for both* / *Use it for <area>* ([`adopt_project`]), under the
/// workspace lock; a shared setup publishes at once, as a *Save* does. The
/// areas that took it.
#[tauri::command(async)]
pub fn ni_direction_adopt_project(
    app: tauri::AppHandle,
    workspace_id: String,
    areas: Vec<String>,
    direction: Option<Direction>,
) -> Result<Vec<String>, String> {
    let (took, changed) = crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, repo| {
        let channel = Channel::for_folder(&repo.cwd);
        let took = adopt_project(stores.project_configs, &channel.git, &workspace_id, &areas, direction)?;
        // Each area it went to, and only those (review): another area's
        // queued change waits for its own press or the next refresh.
        let mut changed: Vec<String> = Vec::new();
        for area in &took {
            for c in drain_with(stores.project_configs, &channel, &workspace_id, Some(area)) {
                if !changed.contains(&c) {
                    changed.push(c);
                }
            }
            if !changed.contains(area) {
                changed.push(area.clone());
            }
        }
        Ok((took, changed))
    })?;
    emit_changed(&app, &workspace_id, &changed);
    Ok(took)
}

/// The answer to a direction question, from C3's sheet
/// (`workspace_definition_resolve_conflict` with an `ni-` field): recorded
/// and published under the lock.
/// `false` when the question changed or went since it was shown.
pub fn app_resolve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    field_id: &str,
    keep_mine: bool,
    shown: &ShownConflict,
) -> Result<bool, String> {
    let answered = crate::workspace_definition::with_workspace_lock(app, workspace_id, |stores, repo| {
        let Some(area) = resolve(stores.project_configs, workspace_id, field_id, keep_mine, shown)? else {
            return Ok(None);
        };
        let mut changed = drain_with(stores.project_configs, &Channel::for_folder(&repo.cwd), workspace_id, Some(&area));
        if !changed.contains(&area) {
            changed.push(area);
        }
        Ok(Some(changed))
    })?;
    match answered {
        Some(changed) => {
            emit_changed(app, workspace_id, &changed);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// E2: the round (proposer, second opinion, phases).
#[path = "next_improvement_round.rs"]
pub(crate) mod round;

#[cfg(test)]
#[path = "next_improvement_tests.rs"]
mod tests;
