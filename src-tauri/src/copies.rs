//! 1.173.0 A2: copies without a card — the engine.
//!
//! A *copy* is a writable checkout of the project that belongs to no card:
//! a terminal can work in it without touching the project folder or the
//! other terminals. It is made the way a card's worktree is
//! (`worktrees::ensure_worktree_from`, the body of `ensure_for_card`):
//!
//! - **Base:** always the fetched `origin/<target>` through
//!   `worktrees::resolve_base`, with its local fallback (no origin, offline).
//!   The target is a parameter: today the workspace's target branch, an
//!   area's branch from B1.
//! - **Id** `copy-<short8>`, **folder** `<ws>/.plyloft-worktrees/copy-<short8>/`,
//!   **branch** `plyloft/copy-<short8>-<slug32>` (the slug by
//!   `worktrees::slugify`, the rule card branches use). A copy branch is never
//!   a card branch (`worktrees::is_card_branch` is false for it).
//! - Then `worktree_setup::prepare_worktree` — `worktreeCopy` and the setup
//!   command, as for a card — on a thread of its own once the folder exists.
//!   A copy gets no port block: `worktree_ports` hands those out per card.
//!
//! **The registry** `projects/<ws>/copies.json` (atomic, `atomic::write_atomic_json`)
//! lists every copy: `{ id, name, branch, path, baseBranch, baseCommit,
//! createdAt, state: active|trashed, trashedAt?, trashEntry?, cardId?,
//! pr?: { number, url }, … }`. Loading is default-tolerant: no file is an
//! empty list, every field defaults, unknown fields and states are kept and
//! written back, an entry this build can't read is kept as it is and left
//! alone, and a file that isn't JSON is set aside (`copies.json.unreadable-<ms>`)
//! before the next write.
//!
//! **Throw away** (`throw_away`) moves the folder to the worktree Trash with
//! `worktrees::prune_worktree_at` — 7 days, the cards' own path — and records
//! the branch at its tip (`branch_cleanup::CleanupReason::Copy`). **Undo**
//! (`restore`) is `worktrees::restore_card_copy_from_trash`, the path an
//! archived card's copy comes back by. The branch is deleted by the trash
//! GC's pass (`branch_cleanup::sweep_for_app` → [`sweep_for_app`] →
//! `branch_cleanup::sweep_copy_record`) once the week is up and the entry is
//! gone, respecting `keepCardBranches`; the copy's registry entry goes with it.
//!
//! **Coordination:** a tile in a copy is an ordinary
//! shell/provider tile whose cwd is the copy; `coordination` keys its
//! worktree by `git rev-parse --show-toplevel`, which is the copy folder.
//!
//! A3 adds `copy_make_card` / `copy_open_pr`; the entry already carries
//! `cardId` and `pr` for them.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::branch_cleanup::{BranchCleanup, CleanupReason};
use crate::worktree_setup::{WorktreeSettings, WorktreeSetupRecord};
use crate::worktrees::{BaseSource, WorktreeBase};

/// The directory name of every copy: `copy-<short8>`.
pub const COPY_DIR_PREFIX: &str = "copy-";
/// Every copy's branch: `plyloft/copy-<short8>-<slug>`.
pub const COPY_BRANCH_PREFIX: &str = "plyloft/copy-";
/// `projects/<ws>/copies.json`.
pub const COPIES_FILE: &str = "copies.json";
/// Emitted with the workspace id whenever a copy is made, set up, thrown
/// away, restored or swept.
pub const COPIES_CHANGED_EVENT: &str = "copies://changed";
pub const SCHEMA_VERSION: u32 = 1;
/// Changed files named in a row; the rest are counted.
pub const FIRST_FILES: usize = 5;
const SHORT_LEN: usize = 8;
const SLUG_MAX_LEN: usize = 32;
const NAME_MAX_CHARS: usize = 80;

/// Serializes every read-modify-write of a registry file in this process.
/// Taken after `commands::CARD_START_LOCK` when both are held.
static COPIES_LOCK: Mutex<()> = Mutex::new(());

/// A branch Plyloft made for a copy without a card.
pub fn is_copy_branch(branch: &str) -> bool {
    branch.starts_with(COPY_BRANCH_PREFIX)
}

/// `copy-` followed by exactly the short id Plyloft makes (lowercase
/// letters and digits): the only directory names a copy's command acts on.
pub fn is_copy_id(id: &str) -> bool {
    id.strip_prefix(COPY_DIR_PREFIX).is_some_and(|short| {
        short.len() == SHORT_LEN && short.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// `plyloft/copy-<short>-<slug>`, the slug made from the copy's name by the
/// card branches' rule (`worktrees::slugify`, at most 32 characters); a name
/// with no letter or digit in it gives `copy`.
pub fn copy_branch_name(short: &str, name: &str) -> String {
    let slug = if name.chars().any(|c| c.is_ascii_alphanumeric()) {
        crate::worktrees::slugify(name, SLUG_MAX_LEN)
    } else {
        "copy".to_string()
    };
    format!("{COPY_BRANCH_PREFIX}{short}-{slug}")
}

fn new_short() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..SHORT_LEN].to_string()
}

/// The name as kept: one line, spaces collapsed, at most 80 characters;
/// empty gives `fallback`.
fn clean_name(name: &str, fallback: &str) -> String {
    let joined = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = joined.chars().take(NAME_MAX_CHARS).collect();
    if cut.is_empty() {
        fallback.to_string()
    } else {
        cut
    }
}

// ── The registry ─────────────────────────────────────────────────────

/// Where a copy is: `active` (its folder is there to work in) or `trashed`
/// (in the worktree Trash for 7 days). A state a later build writes is kept
/// as it is ([`CopyState::Other`]) and never acted on here.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CopyState {
    #[default]
    Active,
    Trashed,
    Other(String),
}

impl CopyState {
    fn as_str(&self) -> &str {
        match self {
            CopyState::Active => "active",
            CopyState::Trashed => "trashed",
            CopyState::Other(s) => s,
        }
    }
}

impl Serialize for CopyState {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CopyState {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.as_str() {
            "active" => CopyState::Active,
            "trashed" => CopyState::Trashed,
            _ => CopyState::Other(s),
        })
    }
}

/// The pull request A3's *Open a pull request* opened for the copy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPr {
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub url: String,
    /// A3: `open`, `merged` or `closed`, as GitHub last said
    /// ([`refresh_prs_for_app`]); absent reads as open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// A3: the commit the pull request was opened with (pushed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    /// A3: when it was opened (unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<i64>,
    /// A3: why the branch stayed on GitHub after the merge, when it did
    /// (`after_merge::BranchOutcome::kept_reason`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_kept: Option<String>,
}

impl CopyPr {
    /// Still open as far as this Mac knows: not read as merged or closed.
    pub fn is_open(&self) -> bool {
        !matches!(self.state.as_deref(), Some("merged") | Some("closed"))
    }
}

/// `https://github.com/o/r/pull/12` → 12.
pub fn pr_number_of(url: &str) -> u64 {
    url.trim()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// One copy in `copies.json`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEntry {
    #[serde(default)]
    pub id: String,
    /// The person's name for it ("inbox-empty-state").
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub branch: String,
    /// The copy's folder, absolute.
    #[serde(default)]
    pub path: String,
    /// The branch it started from (the target, or an area's from B1).
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub base_commit: String,
    /// Where the base came from: `origin` (GitHub's tip), or this computer's
    /// branch (`localOffline`, `localNoRemote`, `localAhead`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_source: Option<BaseSource>,
    /// Why the base isn't GitHub's plain tip, when there is a reason to say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_note: Option<String>,
    /// Unix ms.
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub state: CopyState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<i64>,
    /// The worktree Trash entry its folder went to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trash_entry: Option<String>,
    /// A3: the card *Make it a card* gave the copy to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    /// A3: the pull request *Open a pull request* opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<CopyPr>,
    /// What the sheet chose to open in it: `claude`, `codex` or `shell`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<String>,
    /// What `worktreeCopy` and the setup command did (as on a card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<WorktreeSetupRecord>,
    /// The branch waiting for the trash to expire (reason `copy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_cleanup: Option<BranchCleanup>,
    /// A3: the copy's port block (`worktree_ports`), handed out the first
    /// time something runs in it ([`port_base_for_cwd`]) and given back when
    /// it is thrown away or becomes a card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_base: Option<u16>,
    /// Fields a later build writes, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The whole file. `unread` holds entries this build couldn't read; they
/// are written back as they were.
#[derive(Debug, Clone, Default)]
pub struct CopiesFile {
    pub schema_version: u32,
    pub copies: Vec<CopyEntry>,
    pub unread: Vec<Value>,
    pub extra: Map<String, Value>,
}

pub fn registry_path(registry_dir: &Path) -> PathBuf {
    registry_dir.join(COPIES_FILE)
}

/// Parse a registry file's bytes. `Err` only for bytes that aren't a JSON
/// object.
pub fn parse(bytes: &[u8]) -> Result<CopiesFile, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let Value::Object(mut obj) = value else {
        return Err("copies.json is not an object".to_string());
    };
    let schema_version = obj
        .remove("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(SCHEMA_VERSION as u64) as u32;
    let mut file = CopiesFile { schema_version, ..Default::default() };
    if let Some(Value::Array(items)) = obj.remove("copies") {
        for item in items {
            match serde_json::from_value::<CopyEntry>(item.clone()) {
                Ok(entry) if is_copy_id(&entry.id) => file.copies.push(entry),
                _ => file.unread.push(item),
            }
        }
    }
    file.extra = obj;
    Ok(file)
}

fn to_value(file: &CopiesFile) -> Result<Value, String> {
    let mut obj = file.extra.clone();
    obj.insert("schemaVersion".into(), Value::from(file.schema_version.max(SCHEMA_VERSION)));
    let mut items = Vec::with_capacity(file.copies.len() + file.unread.len());
    for entry in &file.copies {
        items.push(serde_json::to_value(entry).map_err(|e| format!("encode copy: {e}"))?);
    }
    items.extend(file.unread.iter().cloned());
    obj.insert("copies".into(), Value::Array(items));
    Ok(Value::Object(obj))
}

/// The registry as it is: an absent or unreadable file is an empty list.
/// C17: an unreadable one is also set aside (`copies.json.unreadable-<ms>`,
/// [`crate::atomic::load_or_set_aside_with`]), as [`update`] would, under
/// [`COPIES_LOCK`] so it never moves a file a writer just put there. Called
/// from inside an [`update`]'s `change` (this thread holds the lock), it
/// reads as empty: that update has read the file itself.
pub fn load(registry_dir: &Path) -> CopiesFile {
    let path = registry_path(registry_dir);
    match std::fs::read(&path) {
        Ok(bytes) => match parse(&bytes) {
            Ok(file) => file,
            Err(e) if IN_UPDATE.with(std::cell::Cell::get) => {
                log::warn!("copies: {} unreadable: {e}", path.display());
                CopiesFile::default()
            }
            Err(_) => {
                let _serial = COPIES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
                read_or_set_aside(&path).unwrap_or_else(|error| {
                    log::warn!("copies: {error}");
                    CopiesFile::default()
                })
            }
        },
        Err(_) => CopiesFile::default(),
    }
}

thread_local! {
    /// This thread holds [`COPIES_LOCK`] in [`update`].
    static IN_UPDATE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Marks this thread as inside [`update`] until dropped.
struct InUpdate;

impl InUpdate {
    fn enter() -> Self {
        IN_UPDATE.with(|c| c.set(true));
        InUpdate
    }
}

impl Drop for InUpdate {
    fn drop(&mut self) {
        IN_UPDATE.with(|c| c.set(false));
    }
}

/// C17: what [`crate::atomic::newer_refusal`] calls the registry.
const NEWER_COPIES: &str = "The list of copies";

/// C17 (round 1): refused before an action on a copy starts — not only when
/// its record is written ([`update`]), when the copy would already be made,
/// thrown away or sent — while the registry is a newer Plyloft's.
pub fn refuse_if_newer(registry_dir: &Path) -> Result<(), String> {
    crate::atomic::refuse_newer_on_disk(&registry_path(registry_dir), "schemaVersion", SCHEMA_VERSION, NEWER_COPIES)
}

/// Under [`COPIES_LOCK`]: the registry, an unreadable one set aside first.
fn read_or_set_aside(path: &Path) -> Result<CopiesFile, String> {
    Ok(crate::atomic::load_or_set_aside_with(path, parse)?.found().unwrap_or_default())
}

/// Read, change and (when `change` says so) write the registry atomically,
/// under [`COPIES_LOCK`]. A file that isn't JSON is moved aside first, so
/// what was in it is never written over.
pub fn update<T>(
    registry_dir: &Path,
    change: impl FnOnce(&mut CopiesFile) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let _serial = COPIES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = registry_path(registry_dir);
    let _inside = InUpdate::enter();
    let mut file = read_or_set_aside(&path)?;
    let (out, write) = change(&mut file)?;
    if write {
        // C17: a newer Plyloft's registry is never written over.
        if file.schema_version > SCHEMA_VERSION {
            return Err(crate::atomic::newer_refusal(NEWER_COPIES, file.schema_version, SCHEMA_VERSION));
        }
        crate::atomic::write_atomic_json(&path, &to_value(&file)?)?;
    }
    Ok(out)
}

/// Refused for a copy *Make it a card* gave to a card (A3): from then on it
/// is the card's worktree, and only the card acts on it.
pub const IS_A_CARD_REFUSAL: &str = "This copy is a card now; work on it from the card.";

impl CopyEntry {
    /// A3 gave this copy to a card: the copies' list, throw-away, restore,
    /// setup and sweep leave it to the card.
    pub fn is_a_card(&self) -> bool {
        self.card_id.as_deref().is_some_and(|c| !c.trim().is_empty())
    }

    /// A3: its pull request is still open, as far as this Mac knows.
    pub fn pr_open(&self) -> bool {
        self.pr.as_ref().is_some_and(CopyPr::is_open)
    }
}

/// Challenger 4: a copy whose `cardId` names no card on the board — Plyloft
/// stopped between handing it over and making the card, or the card was
/// deleted — is no card's: its `cardId` is cleared, so it is listed again and
/// can be thrown away. `card_exists` asks the board. Run only under
/// `commands::CARD_START_LOCK`, which *Make it a card* holds from the hand-over
/// to the card, so a card being made is never taken for a missing one.
/// Returns whether any was released.
pub fn release_stranded(registry_dir: &Path, card_exists: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    let stranded = load(registry_dir)
        .copies
        .iter()
        .any(|c| c.card_id.as_deref().is_some_and(|id| !id.trim().is_empty() && !card_exists(id)));
    if !stranded {
        return Ok(false);
    }
    update(registry_dir, |file| {
        let mut released = false;
        for c in file.copies.iter_mut() {
            if c.card_id.as_deref().is_some_and(|id| !id.trim().is_empty() && !card_exists(id)) {
                log::info!("copies: {} names a card that isn't on the board; it is a copy again", c.id);
                c.card_id = None;
                released = true;
            }
        }
        Ok((released, released))
    })
}

/// 1.174.0 C4 (G3a walk): the card a copy was given to is deleted. The
/// delete acted on the copy's folder as on any card's own
/// (`worktrees::card_worktree_dir`): when the folder is still there (kept,
/// as the delete sheet chose or because its work exists nowhere else) the
/// copy is a copy again and Copies lists it, to throw away or make a card
/// again; when the delete took it, the copy is forgotten. Returns whether
/// the registry changed.
pub fn after_card_deleted(registry_dir: &Path, card_id: &str) -> Result<bool, String> {
    if !load(registry_dir).copies.iter().any(|c| c.card_id.as_deref() == Some(card_id)) {
        return Ok(false);
    }
    update(registry_dir, |file| {
        let mut changed = false;
        file.copies.retain_mut(|c| {
            if c.card_id.as_deref() != Some(card_id) {
                return true;
            }
            changed = true;
            if Path::new(&c.path).is_dir() {
                c.card_id = None;
                true
            } else {
                false
            }
        });
        Ok((changed, changed))
    })
}

/// Challenger 6: the copies being sent to GitHub now (*Open a pull
/// request*), by `(workspace, copy)`: Make it a card and Throw away wait.
static PR_IN_FLIGHT: Mutex<std::collections::BTreeSet<(String, String)>> = Mutex::new(std::collections::BTreeSet::new());

/// Said while a copy is being sent to GitHub.
pub const SENDING_REFUSAL: &str = "This copy is being sent to GitHub. Try again once that has finished.";

/// Held while a copy is being sent; dropping it ends the send.
pub struct Sending((String, String));

impl Drop for Sending {
    fn drop(&mut self) {
        PR_IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// Start sending copy `id`; `None` while another press sends it.
pub fn begin_sending(workspace_id: &str, id: &str) -> Option<Sending> {
    let key = (workspace_id.to_string(), id.to_string());
    PR_IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone()).then(|| Sending(key))
}

/// `Err(SENDING_REFUSAL)` while copy `id` is being sent to GitHub.
pub fn refuse_while_sending(workspace_id: &str, id: &str) -> Result<(), String> {
    let key = (workspace_id.to_string(), id.to_string());
    if PR_IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).contains(&key) {
        return Err(SENDING_REFUSAL.to_string());
    }
    Ok(())
}

fn find_mut<'a>(file: &'a mut CopiesFile, id: &str) -> Result<&'a mut CopyEntry, String> {
    file.copies
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| "That copy is no longer listed.".to_string())
}

// ── The engine (no app state, for tests) ─────────────────────────────

/// Where a workspace's copies are: its registry directory
/// (`projects/<ws>/`) and its checkout.
#[derive(Debug, Clone, Copy)]
pub struct Place<'a> {
    pub registry_dir: &'a Path,
    pub workspace_cwd: &'a Path,
}

/// Make a copy of the project from `target` and list it. The worktree is
/// made by the cards' own body (`worktrees::ensure_worktree_from`) from the
/// commit `resolve` picks (`worktrees::resolve_base` in the app). A copy
/// whose registry write fails is taken away again, so no copy exists that
/// the list doesn't show. The setup is the caller's ([`prepare`]).
pub fn create(
    place: Place<'_>,
    name: &str,
    target: &str,
    open: Option<&str>,
    now: i64,
    resolve: fn(&Path, &str) -> Result<WorktreeBase, String>,
) -> Result<CopyEntry, String> {
    refuse_if_newer(place.registry_dir)?;
    let target = target.trim();
    if target.is_empty() {
        return Err("Plyloft doesn't know which branch to start the copy from.".to_string());
    }
    let cwd = place.workspace_cwd;
    // A fresh short id whose folder is free under every worktree root.
    let short = (0..8)
        .map(|_| new_short())
        .find(|short| {
            let dir = format!("{COPY_DIR_PREFIX}{short}");
            std::fs::symlink_metadata(crate::worktrees::worktree_path_for_card(cwd, &dir)).is_err()
        })
        .ok_or("Couldn't find a free name for the copy's folder.")?;
    let id = format!("{COPY_DIR_PREFIX}{short}");
    // The branch from the name as typed: an empty one gives `…-copy`.
    let branch = copy_branch_name(&short, name);
    let name = clean_name(name, &id);
    let made = crate::worktrees::ensure_worktree_from(cwd, &id, &branch, &[], &[], target, resolve)?;
    let base = made.base.clone().filter(|_| made.created).ok_or_else(|| {
        format!("{} was already there; nothing was made", made.worktree_path.display())
    })?;
    let entry = CopyEntry {
        id: id.clone(),
        name,
        branch: made.branch_name.clone(),
        path: made.worktree_path.to_string_lossy().into_owned(),
        base_branch: target.to_string(),
        base_commit: base.commit.clone(),
        base_source: Some(base.source),
        base_note: base.note.clone(),
        created_at: now,
        open: open.map(str::trim).filter(|o| !o.is_empty()).map(str::to_string),
        ..Default::default()
    };
    let listed = update(place.registry_dir, |file| {
        file.copies.push(entry.clone());
        Ok(((), true))
    });
    if let Err(e) = listed {
        take_back(cwd, &made.worktree_path, &made.branch_name);
        return Err(format!("Couldn't list the copy, so it was taken away again: {e}"));
    }
    Ok(entry)
}

/// Undo a copy just made: its worktree and its branch (which holds nothing
/// but the base commit).
fn take_back(cwd: &Path, path: &Path, branch: &str) {
    if let Some(p) = path.to_str() {
        let _ = crate::git::capture(cwd, &["worktree", "remove", "--force", p]);
    }
    let _ = crate::git::capture(cwd, &["worktree", "prune"]);
    let _ = crate::git::capture(cwd, &["branch", "-D", branch]);
}

/// Mark a copy's setup as running before it runs (the list says so).
pub fn mark_setup_running(place: Place<'_>, id: &str, command: Option<&str>, at: i64) -> Result<(), String> {
    update(place.registry_dir, |file| {
        find_mut(file, id)?.setup = Some(WorktreeSetupRecord::running(command, at));
        Ok(((), true))
    })
}

/// `worktreeCopy` and the setup command in the copy
/// (`worktree_setup::prepare_worktree`), then the outcome on its entry —
/// only while the copy is still active at the same folder. Blocking.
pub fn prepare(
    place: Place<'_>,
    entry: &CopyEntry,
    settings: &WorktreeSettings,
    path_env: &str,
    timeout: Duration,
) -> Result<Option<WorktreeSetupRecord>, String> {
    let record = crate::worktree_setup::prepare_worktree(
        &crate::worktree_setup::repo_root(place.workspace_cwd),
        Path::new(&entry.path),
        settings,
        path_env,
        &[],
        timeout,
    );
    if let Some(r) = record.as_ref() {
        // Names and counts only: never a file's contents, never the output.
        log::info!(
            "copies: setup of {}: {:?}, {} copied, {} skipped, {} matched nothing",
            entry.id,
            r.state,
            r.copied.len(),
            r.skipped.len(),
            r.unmatched.len()
        );
    }
    update(place.registry_dir, |file| {
        let Some(current) = file.copies.iter_mut().find(|c| c.id == entry.id) else {
            return Ok(((), false));
        };
        if current.state != CopyState::Active || current.path != entry.path {
            return Ok(((), false));
        }
        current.setup = record.clone();
        Ok(((), true))
    })?;
    Ok(record)
}

/// What a copy holds that its base doesn't.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFiles {
    /// Files changed, added (untracked included) or removed since the base,
    /// committed or not.
    pub count: usize,
    /// The first [`FIRST_FILES`] of them, repository-relative, sorted.
    pub files: Vec<String>,
    /// Git couldn't be read: the count is unknown.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
}

/// The files the copy at `path` changed since `base` (its own commits and
/// what isn't committed yet, untracked files included, ignored files not),
/// through `platform::git_command`.
pub fn changed_files(path: &Path, base: &str) -> ChangedFiles {
    let base = if base.trim().is_empty() { "HEAD" } else { base.trim() };
    let split = |out: String| -> Vec<String> {
        out.split('\0').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
    };
    let config = ["-c", "core.quotepath=false"];
    let diff = crate::git::capture_configured(path, &config, &["diff", "--name-only", "--no-renames", "-z", base, "--"]);
    let untracked = crate::git::capture_configured(path, &config, &["ls-files", "--others", "--exclude-standard", "-z"]);
    let (Ok(diff), Ok(untracked)) = (diff, untracked) else {
        return ChangedFiles { unreadable: true, ..Default::default() };
    };
    let mut all: Vec<String> = split(diff);
    all.extend(split(untracked));
    all.sort();
    all.dedup();
    ChangedFiles {
        count: all.len(),
        files: all.into_iter().take(FIRST_FILES).collect(),
        unreadable: false,
    }
}

/// One row of the list: the entry plus what can be seen of it now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyView {
    #[serde(flatten)]
    pub copy: CopyEntry,
    /// Empty for a copy in the Trash.
    pub changed: ChangedFiles,
    /// Live terminals (shell, Claude or Codex tiles) whose folder is in it.
    pub terminals: usize,
    /// The folder is there.
    pub present: bool,
    /// A copy in the Trash that can still come back (its entry and branch
    /// are there).
    pub restorable: bool,
    /// A3: commits on the copy's branch since its base that exist nowhere
    /// else (on no remote) — what *Throw away* asks about.
    pub saved: usize,
}

/// The commits of `path`'s checkout since `base` that no remote has.
pub fn saved_commits(path: &Path, base: &str) -> usize {
    if base.trim().is_empty() {
        return 0;
    }
    crate::git::capture(path, &["rev-list", "--count", &format!("{}..HEAD", base.trim()), "--not", "--remotes"])
        .ok()
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or(0)
}

/// Every copy worth showing: active ones, and thrown-away ones that can
/// still come back — active first, newest first. `terminals_in` counts the
/// live tiles in a folder (`PtyRegistry::shell_tiles_in`); `setup_running`
/// says whether a copy's setup is running in this process.
pub fn list(
    place: Place<'_>,
    terminals_in: &dyn Fn(&Path) -> usize,
    setup_running: &dyn Fn(&str) -> bool,
) -> Vec<CopyView> {
    let file = load(place.registry_dir);
    let mut out: Vec<CopyView> = file
        .copies
        .into_iter()
        .filter(|copy| !copy.is_a_card())
        .filter_map(|mut copy| {
            let path = PathBuf::from(&copy.path);
            match copy.state {
                CopyState::Active => {
                    // A `running` setup nothing runs (Plyloft quit during it)
                    // reads as interrupted, as on a card.
                    if copy.setup.as_ref().is_some_and(|r| r.state == crate::worktree_setup::WorktreeSetupState::Running)
                        && !setup_running(&copy.id)
                    {
                        if let Some(r) = copy.setup.as_mut() {
                            r.state = crate::worktree_setup::WorktreeSetupState::Failed;
                            r.reason = Some(crate::worktree_setup::INTERRUPTED_REASON.to_string());
                        }
                    }
                    let present = path.is_dir();
                    let changed = if present {
                        changed_files(&path, &copy.base_commit)
                    } else {
                        ChangedFiles { unreadable: true, ..Default::default() }
                    };
                    let terminals = if present { terminals_in(&path) } else { 0 };
                    let saved = if present { saved_commits(&path, &copy.base_commit) } else { 0 };
                    Some(CopyView { copy, changed, terminals, present, restorable: false, saved })
                }
                CopyState::Trashed => {
                    let restorable = copy.trash_entry.as_deref().is_some_and(|e| Path::new(e).is_dir())
                        && crate::worktrees::branch_tip(place.workspace_cwd, &copy.branch).is_some();
                    restorable.then(|| CopyView {
                        copy,
                        changed: ChangedFiles::default(),
                        terminals: 0,
                        present: false,
                        restorable: true,
                        saved: 0,
                    })
                }
                CopyState::Other(_) => None,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        let rank = |v: &CopyView| matches!(v.copy.state, CopyState::Trashed) as u8;
        rank(a).cmp(&rank(b)).then(b.copy.created_at.cmp(&a.copy.created_at))
    });
    out
}

/// Throw a copy away: its folder goes to the worktree Trash for 7 days
/// (`worktrees::prune_worktree_at`, which strips its build caches first)
/// and its branch is recorded at its tip for the trash GC's sweep
/// ([`CleanupReason::Copy`]). Refused while a terminal is open in it or its
/// setup is running.
pub fn throw_away(
    place: Place<'_>,
    id: &str,
    cache_paths: &[String],
    terminals_in: &dyn Fn(&Path) -> usize,
    setup_running: bool,
    now: i64,
) -> Result<CopyEntry, String> {
    if !is_copy_id(id) {
        return Err(format!("not a copy: {id:?}"));
    }
    refuse_if_newer(place.registry_dir)?;
    let cwd = place.workspace_cwd;
    let copy = load(place.registry_dir)
        .copies
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("That copy is no longer listed.")?;
    if copy.is_a_card() {
        return Err(IS_A_CARD_REFUSAL.to_string());
    }
    match copy.state {
        CopyState::Active => {}
        CopyState::Trashed => return Err("That copy is already in the Trash.".to_string()),
        CopyState::Other(_) => return Err("This version of Plyloft can't throw that copy away.".to_string()),
    }
    if setup_running {
        return Err("The copy is still being set up. Throw it away once that has finished.".to_string());
    }
    // Only the copy's own folder, wherever its record says it is.
    let path = crate::worktrees::recorded_worktree_path(cwd, id, Some(copy.path.as_str()));
    if crate::worktrees::card_worktree_location(cwd, &path)? != id {
        return Err(format!("{} is not this copy's folder", path.display()));
    }
    let open = if path.is_dir() { terminals_in(&path) } else { 0 };
    if open > 0 {
        let what = if open == 1 { "A terminal is" } else { "Terminals are" };
        return Err(format!("{what} still open in this copy. Close {}, then throw the copy away.", if open == 1 { "it" } else { "them" }));
    }
    let tip = crate::worktrees::branch_tip(cwd, &copy.branch);
    let entry = crate::worktrees::prune_worktree_at(cwd, &path, cache_paths)?;
    let recorded = update(place.registry_dir, |file| {
        let c = find_mut(file, id)?;
        c.state = CopyState::Trashed;
        c.trashed_at = Some(now);
        // A3: its port block is free again.
        c.port_base = None;
        c.trash_entry = entry.as_ref().map(|p| p.to_string_lossy().into_owned());
        c.branch_cleanup = tip
            .as_deref()
            .filter(|_| is_copy_branch(&c.branch))
            .map(|tip| BranchCleanup::new(&c.branch, tip, CleanupReason::Copy, now, entry.as_deref()));
        Ok((c.clone(), true))
    });
    let e = match recorded {
        Ok(thrown) => return Ok(thrown),
        Err(e) => e,
    };
    // The list would still show it active with its folder gone: the copy
    // goes back where it was, or the error says where it is.
    let Some(trashed) = entry else {
        return Err(format!("Couldn't record that the copy was thrown away: {e}"));
    };
    match crate::worktrees::restore_card_copy_from_trash(cwd, id, &trashed, &copy.branch) {
        Ok(_) => Err(format!("Couldn't record that the copy was thrown away ({e}), so it was put back.")),
        Err(back) => Err(format!(
            "Couldn't record that the copy was thrown away ({e}), nor put it back ({back}). Its folder is in the \
             Trash at {}.",
            trashed.display()
        )),
    }
}

/// Bring a thrown-away copy back from the Trash, whole — its edits not yet
/// committed included — through the path an archived card's copy comes back
/// by (`worktrees::restore_card_copy_from_trash`). Its branch's cleanup is
/// cancelled.
pub fn restore(place: Place<'_>, id: &str) -> Result<CopyEntry, String> {
    if !is_copy_id(id) {
        return Err(format!("not a copy: {id:?}"));
    }
    refuse_if_newer(place.registry_dir)?;
    let copy = load(place.registry_dir)
        .copies
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("That copy is no longer listed.")?;
    if copy.is_a_card() {
        return Err(IS_A_CARD_REFUSAL.to_string());
    }
    if copy.state != CopyState::Trashed {
        return Err("That copy isn't in the Trash.".to_string());
    }
    let entry = copy
        .trash_entry
        .as_deref()
        .map(PathBuf::from)
        .ok_or("That copy's folder is no longer in the Trash.")?;
    let dest = crate::worktrees::restore_card_copy_from_trash(place.workspace_cwd, id, &entry, &copy.branch)?;
    update(place.registry_dir, |file| {
        let c = find_mut(file, id)?;
        c.state = CopyState::Active;
        c.path = dest.to_string_lossy().into_owned();
        c.trashed_at = None;
        c.trash_entry = None;
        c.branch_cleanup = None;
        Ok((c.clone(), true))
    })
}

/// The trash GC's pass over the copies (run right after `gc_trash`): each
/// thrown-away copy's branch by `branch_cleanup::sweep_copy_record`, then
/// the entries that are done with — in the Trash no more (reaped) and no
/// branch waiting. `enabled` is "Delete card branches when their trash
/// expires". Returns whether the registry changed.
pub fn sweep(place: Place<'_>, enabled: bool, now: i64, terminals_in: &dyn Fn(&Path) -> usize) -> Result<bool, String> {
    if !registry_path(place.registry_dir).exists() {
        return Ok(false);
    }
    update(place.registry_dir, |file| {
        let mut changed = false;
        for copy in file.copies.iter_mut().filter(|c| c.state == CopyState::Trashed && !c.is_a_card()) {
            let pr_open = copy.pr_open();
            let Some(rec) = copy.branch_cleanup.as_mut().filter(|r| r.pending()) else {
                continue;
            };
            let folder = PathBuf::from(&copy.path);
            let busy = || {
                (terminals_in(&folder) > 0).then(|| "a terminal is open where the copy was".to_string())
            };
            let verdict = crate::branch_cleanup::sweep_copy_record(place.workspace_cwd, enabled, now, rec, pr_open, &busy);
            if let crate::branch_cleanup::Verdict::Held(why) | crate::branch_cleanup::Verdict::Failed(why) = &verdict {
                log::info!("copies: kept {} this pass: {why}", rec.branch);
            }
            if verdict == crate::branch_cleanup::Verdict::Deleted {
                log::info!("copies: deleted {} (was {})", rec.branch, rec.tip);
            }
            changed |= crate::branch_cleanup::settle(rec, &verdict, now);
        }
        let before = file.copies.len();
        file.copies.retain(|c| {
            let done = c.state == CopyState::Trashed
                && !c.is_a_card()
                && c.trash_entry.as_deref().is_none_or(|e| std::fs::symlink_metadata(e).is_err())
                && c.branch_cleanup.as_ref().is_none_or(|r| !r.pending());
            !done
        });
        changed |= file.copies.len() != before;
        Ok((changed, changed))
    })
}

// ── A3: Make it a card, Open a pull request ──────────────────────────

/// Said when the copy's checkout is no longer on the branch Plyloft made
/// for it (something in its terminal moved it). 1.174.0 (TX8, T44): it
/// names that branch, and how to get back to it without git.
pub fn off_its_branch(branch: &str) -> String {
    format!(
        "Something in the copy's terminal moved it off its own branch, so Plyloft can't hand it on. In the copy's terminal, ask its AI to switch back to {branch}, then try again."
    )
}

/// The copy `id`, when it can be handed on — to a card (*Make it a card*)
/// or to a pull request: listed, active, no card's yet, its folder there,
/// its setup not running, and its checkout still on its own branch.
pub fn ready_to_hand_on(place: Place<'_>, id: &str, setup_running: bool) -> Result<CopyEntry, String> {
    if !is_copy_id(id) {
        return Err("That isn't one of this project's copies.".to_string());
    }
    // Before *Open a pull request* commits or *Make it a card* starts.
    refuse_if_newer(place.registry_dir)?;
    let copy = load(place.registry_dir)
        .copies
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("That copy is no longer listed.")?;
    if copy.is_a_card() {
        return Err(IS_A_CARD_REFUSAL.to_string());
    }
    match copy.state {
        CopyState::Active => {}
        CopyState::Trashed => return Err("That copy is in the Trash. Bring it back first.".to_string()),
        CopyState::Other(_) => return Err("This version of Plyloft can't use that copy.".to_string()),
    }
    let path = Path::new(&copy.path);
    if !path.is_dir() {
        return Err("That copy's folder is gone.".to_string());
    }
    if setup_running {
        return Err("The copy is still being set up. Try again once that has finished.".to_string());
    }
    let head = crate::git::capture(path, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(|_| off_its_branch(&copy.branch))?;
    if head.trim() != copy.branch {
        return Err(off_its_branch(&copy.branch));
    }
    Ok(copy)
}

/// *Make it a card*: the copy is `card_id`'s from now on — it leaves the
/// list, and only the card acts on it. Its port block stays on the entry
/// for the card to take (`make_card_from_copy`).
pub fn give_to_card(place: Place<'_>, id: &str, card_id: &str) -> Result<CopyEntry, String> {
    refuse_if_newer(place.registry_dir)?;
    update(place.registry_dir, |file| {
        let c = find_mut(file, id)?;
        if c.is_a_card() {
            return Err(IS_A_CARD_REFUSAL.to_string());
        }
        // Challenger 2: its port block goes with it to the card
        // (`make_card_from_copy` records it there); a card's copy holds none
        // itself (`held_port_bases` skips it), so it is never counted twice.
        c.card_id = Some(card_id.to_string());
        Ok((c.clone(), true))
    })
}

/// The pull request body of a copy (Plyloft's lines; Ship's template rule
/// adds the repository's template above them under "From Plyloft").
// G2 (1.173.0): it names the Reviewer (once the Challenger), as copyWords.ts
// COPIES_STATUS and PR_SHEET_REACH_TAIL do. It goes to GitHub.
pub const COPY_PR_BODY: &str = "Opened from a copy in Plyloft, without a card. Nobody has reviewed it in Plyloft: \
                                neither the Reviewer nor your checks looked at it.";

/// The lead of every refusal to commit a copy's changes (`copyWords.ts`'s
/// `plainCopyError` reads it).
pub const SAVE_FAILED: &str = "Couldn't save the copy's changes:";
/// The bound of `git add -A` and the index's reset in a copy.
const SAVE_TIMEOUT: Duration = Duration::from_secs(60);

/// The copy's changes not yet committed, committed on its branch with
/// `message` (`git add -A`, then `git commit` as the person; `worktreeCopy`
/// files are git-ignored and stay out). `Ok(false)` with nothing to save.
/// Challenger 1 (R8, Hard rule 4): bounded, no stdin, killed on app exit —
/// the add as the library rebase's local git, the commit as every commit
/// Plyloft makes (`git::commit`, the person's hooks told apart). A refusal
/// puts the index back as it was.
pub fn save_changes(path: &Path, message: &str) -> Result<bool, String> {
    let status = crate::git::capture(path, &["status", "--porcelain"]).map_err(|e| format!("Couldn't read the copy: {e}"))?;
    if status.trim().is_empty() {
        return Ok(false);
    }
    let put_back = || {
        let _ = crate::git::capture_configured_bounded(path, &[], &["reset", "-q"], SAVE_TIMEOUT);
    };
    if let Err(e) = crate::git::capture_configured_bounded(path, &[], &["add", "-A"], SAVE_TIMEOUT) {
        put_back();
        return Err(format!("{SAVE_FAILED} {e}"));
    }
    if let Err(failure) = crate::git::commit(path, &["-q", "-m", message]) {
        put_back();
        return Err(format!("{SAVE_FAILED} {}", failure.text()));
    }
    Ok(true)
}

/// The lead of the commit *Make it a card* saves the copy's work in.
const WORK_FROM_COPY_LEAD: &str = "chore: work from the copy ";

/// The commit *Make it a card* saves the copy's work in (walk fix c).
pub fn work_from_copy_message(name: &str) -> String {
    format!("{WORK_FROM_COPY_LEAD}{}", clean_name(name, "copy"))
}

/// The bound of reading a copy's last commit: a local `git log`, nothing
/// more; one that runs this long is stuck, and the copy's name will do.
const SUBJECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The longest title a copy's commit gives a card (as `next_improvement`'s).
pub const SUBJECT_TITLE_MAX: usize = 200;

/// 1.174.0 C4 (P17): the subject of the copy's own newest commit since
/// `base` — what the card made from it is called, on one line and at most
/// [`SUBJECT_TITLE_MAX`] characters. Its own line of work only
/// (`--first-parent`: a `git merge main` or `git pull` in the copy never
/// lends it main's commits), not merges, and not the commit *Make it a card*
/// saved the work in ([`work_from_copy_message`]).
/// `None` with no base, no such commit, or git not answering in
/// [`SUBJECT_TIMEOUT`] (through `platform::git_command`, no stdin, killed on
/// app exit): the caller names the card after the copy.
pub fn last_commit_subject(path: &Path, base: &str) -> Option<String> {
    let base = base.trim();
    if base.is_empty() {
        return None;
    }
    let range = format!("{base}..HEAD");
    let config = ["-c", "core.quotepath=false", "-c", "i18n.logOutputEncoding=UTF-8"];
    let args = ["log", "--first-parent", "--no-merges", "--format=%s", "-n", "20", range.as_str(), "--"];
    let out = crate::git::capture_configured_bounded(path, &config, &args, SUBJECT_TIMEOUT).ok()?;
    out.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|line| !line.is_empty() && !line.starts_with(WORK_FROM_COPY_LEAD))
        .map(|line| line.chars().take(SUBJECT_TITLE_MAX).collect::<String>().trim_end().to_string())
}

/// What [`commit_for_pr`] made ready.
#[derive(Debug, Clone)]
pub struct PrReady {
    pub entry: CopyEntry,
    /// The commit to push (the copy's tip once its changes are committed).
    pub publish: String,
    /// Its changes weren't all committed and now are.
    pub committed: bool,
}

/// *Open a pull request*, first half: the copy's changes not yet committed
/// are committed on its branch (`git add -A`, then `git commit` with
/// `title`, as the person; `worktreeCopy` files are git-ignored and stay
/// out); refused when the copy already has an open pull request or holds
/// nothing its base doesn't.
pub fn commit_for_pr(place: Place<'_>, id: &str, title: &str, setup_running: bool) -> Result<PrReady, String> {
    let entry = ready_to_hand_on(place, id, setup_running)?;
    if let Some(pr) = entry.pr.as_ref().filter(|p| p.is_open()) {
        return Err(format!("This copy already has a pull request open (#{}).", pr.number));
    }
    let path = PathBuf::from(&entry.path);
    let committed = save_changes(&path, &clean_name(title, &entry.name))?;
    let publish = crate::git::capture(&path, &["rev-parse", "HEAD"]).map_err(|e| format!("Couldn't read the copy: {e}"))?;
    let publish = publish.trim().to_string();
    let base = if entry.base_commit.trim().is_empty() { entry.base_branch.clone() } else { entry.base_commit.clone() };
    let ahead = crate::git::capture(&path, &["rev-list", "--count", &format!("{base}..{publish}")])
        .ok()
        .and_then(|n| n.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if ahead == 0 {
        return Err("Nothing has changed in this copy yet, so there is nothing to send.".to_string());
    }
    Ok(PrReady { entry, publish, committed })
}

/// Record the pull request on the copy (open, at `head`).
pub fn record_pr(place: Place<'_>, id: &str, url: &str, head: &str, now: i64) -> Result<CopyEntry, String> {
    update(place.registry_dir, |file| {
        let c = find_mut(file, id)?;
        c.pr = Some(CopyPr {
            number: pr_number_of(url),
            url: url.trim().to_string(),
            state: Some("open".to_string()),
            head_sha: Some(head.to_string()),
            opened_at: Some(now),
            branch_kept: None,
        });
        Ok((c.clone(), true))
    })
}

/// *Open a pull request*, whole, with `gh` given (the app's, or a test's):
/// [`commit_for_pr`]; then Ship's own push — exactly that commit to
/// `refs/heads/<the copy's branch>`, never forced
/// (`commands::push_branch_for_pr`) — and Ship's own `gh pr create --base
/// <the copy's base branch>` (`commands::open_branch_pr`) with Ship's body
/// rule (`commands::pr_body_with_template`); then the pull request on the
/// entry. The caller checked origin, gh and the sign-in first.
pub fn open_pr_with(
    place: Place<'_>,
    id: &str,
    title: &str,
    gh: &str,
    origin_repo: Option<&str>,
    setup_running: bool,
    now: i64,
) -> Result<CopyEntry, String> {
    let ready = commit_for_pr(place, id, title, setup_running)?;
    let path = PathBuf::from(&ready.entry.path);
    let branch = ready.entry.branch.clone();
    crate::commands::push_branch_for_pr(
        &path,
        &ready.publish,
        &branch,
        "no pull request was opened. Press Open the pull request again to send the same change.",
    )?;
    let title = clean_name(title, &ready.entry.name);
    let body = crate::commands::pr_body_with_template(
        crate::commands::pr_template_at(&path, &ready.publish).as_deref(),
        COPY_PR_BODY,
    );
    let url = match crate::commands::open_branch_pr(gh, &path, &ready.entry.base_branch, &branch, &title, &body, origin_repo)? {
        crate::commands::PrOpened::New(url) | crate::commands::PrOpened::Existing(url) => url,
    };
    record_pr(place, id, &url, &ready.publish, now)
}

/// What `gh pr view --json state,headRefName,isCrossRepository,headRefOid`
/// said of a copy's pull request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrRead {
    /// `open`, `merged` or `closed`.
    pub state: String,
    pub head_ref: Option<String>,
    pub cross_repository: Option<bool>,
    pub head_oid: Option<String>,
}

/// gh's JSON, read; `None` when it isn't the answer asked for.
pub fn read_pr_view(stdout: &str) -> Option<PrRead> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    let state = v.get("state")?.as_str()?.to_ascii_lowercase();
    if !matches!(state.as_str(), "open" | "merged" | "closed") {
        return None;
    }
    Some(PrRead {
        state,
        head_ref: v.get("headRefName").and_then(Value::as_str).map(str::to_string),
        cross_repository: v.get("isCrossRepository").and_then(Value::as_bool),
        head_oid: v.get("headRefOid").and_then(Value::as_str).map(str::to_string),
    })
}

/// After a copy's own pull request merged: its branch on GitHub goes as a
/// card's does (`after_merge::delete_merged_branch`, which accepts a copy
/// branch: only while GitHub still has it at the merged head, never the
/// target or the default branch, never while another open pull request
/// uses it), then the stale `origin/<branch>` ref here. Returns why it
/// stayed, if it did.
pub fn after_pr_merged(
    remote: &dyn crate::after_merge::Remote,
    cwd: &Path,
    copy: &CopyEntry,
    read: &PrRead,
) -> Option<String> {
    let pr = copy.pr.as_ref()?;
    let head = read.head_oid.clone().or_else(|| pr.head_sha.clone()).unwrap_or_default();
    let outcome = crate::after_merge::delete_merged_branch(
        remote,
        &pr.url,
        &copy.branch,
        crate::after_merge::PrHead { name: read.head_ref.as_deref(), cross_repository: read.cross_repository },
        &head,
        &copy.base_branch,
    );
    if matches!(outcome, crate::after_merge::BranchOutcome::Deleted | crate::after_merge::BranchOutcome::AlreadyGone) {
        crate::after_merge::prune_tracking_ref(cwd, &copy.branch);
    }
    outcome.kept_reason()
}

/// Write what GitHub said of copy `id`'s pull request at `url`. `false`
/// when nothing changed (or the copy has another pull request now).
pub fn note_pr_state(place: Place<'_>, id: &str, url: &str, state: &str, branch_kept: Option<String>) -> Result<bool, String> {
    update(place.registry_dir, |file| {
        let Some(c) = file.copies.iter_mut().find(|c| c.id == id) else { return Ok((false, false)) };
        let Some(pr) = c.pr.as_mut().filter(|p| p.url == url) else { return Ok((false, false)) };
        let changed = pr.state.as_deref() != Some(state) || pr.branch_kept != branch_kept;
        pr.state = Some(state.to_string());
        pr.branch_kept = branch_kept;
        Ok((changed, changed))
    })
}

// ── A3: a copy's port block ──────────────────────────────────────────

/// Every port block a copy holds, in every workspace's `copies.json` under
/// `projects_root` but `skip` (a registry directory) — so a card's block
/// is never one a copy holds (`worktree_ports::held_by_others`), nor two
/// copies'. A copy a card owns holds none (its card does).
pub fn held_port_bases(projects_root: &Path, skip: Option<&Path>) -> std::collections::HashSet<u16> {
    let mut out = std::collections::HashSet::new();
    let Ok(dirs) = std::fs::read_dir(projects_root) else { return out };
    for dir in dirs.flatten() {
        let path = dir.path();
        if skip.is_some_and(|s| crate::worktree_ports::same_dir(s, &path)) || !registry_path(&path).is_file() {
            continue;
        }
        for c in load(&path).copies {
            if c.state == CopyState::Active && !c.is_a_card() {
                out.extend(c.port_base.filter(|b| crate::worktree_ports::is_block_base(*b)));
            }
        }
    }
    out
}

/// Copy `id`'s port block, handing one out when it has none (or another
/// holds the same): never one in `used` (cards', other workspaces'
/// copies'), nor another copy's here. `None` for a copy that isn't active,
/// is a card's, or when every block is in use. Called under
/// `worktree_ports::PICK_LOCK`.
pub fn ensure_port_base(
    place: Place<'_>,
    id: &str,
    used: &std::collections::HashSet<u16>,
    probe: &dyn Fn(u16) -> bool,
) -> Result<Option<u16>, String> {
    update(place.registry_dir, |file| {
        let mut taken: std::collections::HashSet<u16> = used.clone();
        for c in file.copies.iter().filter(|c| c.id != id && c.state == CopyState::Active && !c.is_a_card()) {
            taken.extend(c.port_base);
        }
        let Some(c) = file.copies.iter_mut().find(|c| c.id == id) else { return Ok((None, false)) };
        if c.state != CopyState::Active || c.is_a_card() {
            return Ok((None, false));
        }
        if let Some(base) = c.port_base.filter(|b| crate::worktree_ports::is_block_base(*b) && !taken.contains(b)) {
            return Ok((Some(base), false));
        }
        let picked = crate::worktree_ports::pick_block(&taken, None, probe);
        let wrote = picked.is_some() && picked != c.port_base;
        if picked.is_some() {
            c.port_base = picked;
        }
        Ok((picked, wrote))
    })
}

// ── The app's side ───────────────────────────────────────────────────

pub(crate) fn emit_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) {
    use tauri::Emitter;
    let _ = app.emit(COPIES_CHANGED_EVENT, workspace_id.to_string());
}

fn workspace_cwd<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd))
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

fn registry_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<PathBuf> {
    use tauri::Manager;
    app.try_state::<crate::project_config::ProjectConfigStore>()
        .map(|store| store.workspace_dir(workspace_id))
}

/// [`release_stranded`] against a board as it was read: a board that
/// couldn't be read (`Err`) releases nothing — never "every card missing".
/// 1.175.0 (R2): the caller hands it `KanbanStore::load_whole`, which is an
/// error for the whole session once the board file was set aside or opened
/// from its last saved copy: the card a copy names may be in the save that
/// was lost.
pub fn release_stranded_on(dir: &Path, board: Result<Vec<crate::kanban::KanbanCard>, String>) -> Result<bool, String> {
    let Ok(cards) = board else { return Ok(false) };
    release_stranded(dir, &|id: &str| cards.iter().any(|c| c.id == id))
}

/// `CARD_START_LOCK` when no card start holds it — poisoned taken as
/// everywhere else (`into_inner`); `None` while it is held.
pub(crate) fn try_card_start_lock() -> Option<std::sync::MutexGuard<'static, ()>> {
    match crate::commands::CARD_START_LOCK.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

/// [`release_stranded_on`] with the workspace's board. The caller holds
/// `CARD_START_LOCK`.
pub(crate) fn release_stranded_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, dir: &Path) {
    use tauri::Manager;
    let Some(kanban) = app.try_state::<crate::kanban::KanbanStore>() else { return };
    match release_stranded_on(dir, kanban.load_whole(workspace_id)) {
        Ok(true) => emit_changed(app, workspace_id),
        Ok(false) => {}
        Err(e) => log::warn!("copies: {workspace_id}: couldn't release a stranded copy: {e}"),
    }
}

fn terminals_in<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> impl Fn(&Path) -> usize + '_ {
    use tauri::Manager;
    move |dir: &Path| {
        app.try_state::<crate::pty::PtyRegistry>()
            .map(|pty| pty.shell_tiles_in(dir))
            .unwrap_or(0)
    }
}

/// `ensure_copy(ws, name, open)`: make the copy from the workspace's
/// target branch — or `target` when given (B1's areas) — list it, and start
/// its setup on a thread of its own. Returns as soon as the folder exists;
/// the entry's `setup` is `running` until [`COPIES_CHANGED_EVENT`] says it
/// finished. Never asks the Free plan's card limit.
pub fn ensure_copy<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    name: &str,
    open: Option<&str>,
    target: Option<&str>,
) -> Result<CopyView, String> {
    use tauri::Manager;
    let cwd = workspace_cwd(app, workspace_id)?;
    let configs = app.state::<crate::project_config::ProjectConfigStore>();
    let target = match target.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => match configs.get(workspace_id) {
            Some(cfg) => cfg.target_branch,
            None => {
                let workspaces = app.state::<crate::workspace::WorkspaceStore>();
                let name = workspaces
                    .snapshot()
                    .workspaces
                    .into_iter()
                    .find(|w| w.id == workspace_id)
                    .map(|w| w.name)
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| "This workspace".to_string());
                return Err(crate::project_config::not_set_up(
                    &name,
                    crate::project_config::shared_read_only(&configs, workspace_id),
                    crate::project_config::setup_unfinished(&configs, &workspaces),
                    "No copy was made.",
                    "open the copy again",
                ));
            }
        },
    };
    // 1.175.0 (C5 round 2): not from the shared setup's branch while it is
    // gone from GitHub (the same words as a card's start).
    if let Some(why) = crate::move_shared_setup::branch_gone_refusal(&configs, workspace_id, &target) {
        return Err(why);
    }
    let dir = configs.workspace_dir(workspace_id);
    let place = Place { registry_dir: &dir, workspace_cwd: &cwd };
    let settings = crate::worktree_setup::load_settings(&configs, workspace_id);
    let (entry, in_flight) = {
        // As every card start: `git worktree add` and the fetch before it
        // are serialized with card starts, prunes and the trash GC.
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let now = crate::kanban::now_ms();
        let mut entry = create(place, name, &target, open, now, crate::worktrees::resolve_base)?;
        let in_flight = settings
            .configured()
            .then(|| crate::worktree_setup::begin(workspace_id, &entry.id))
            .flatten();
        if in_flight.is_some() {
            let at = crate::worktree_setup::now_millis();
            // The copy exists: a record that couldn't be written doesn't undo
            // it, and the setup's own result is written when it ends.
            if let Err(e) = mark_setup_running(place, &entry.id, settings.setup_command(), at) {
                log::warn!("copies: {workspace_id}: couldn't mark {}'s setup running: {e}", entry.id);
            }
            entry.setup = Some(WorktreeSetupRecord::running(settings.setup_command(), at));
        }
        (entry, in_flight)
    };
    log::info!("copies: {workspace_id}: made {} on {} from {}", entry.id, entry.branch, entry.base_branch);
    emit_changed(app, workspace_id);
    if let Some(in_flight) = in_flight {
        spawn_setup(app, workspace_id, dir, cwd, settings, entry.clone(), in_flight);
    }
    let present = Path::new(&entry.path).is_dir();
    Ok(CopyView { copy: entry, changed: ChangedFiles::default(), terminals: 0, present, restorable: false, saved: 0 })
}

/// Run a staged setup on a thread of its own (`prepare`), holding its
/// in-flight claim until the outcome is written, then tell the window.
fn spawn_setup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    dir: PathBuf,
    cwd: PathBuf,
    settings: WorktreeSettings,
    entry: CopyEntry,
    in_flight: crate::worktree_setup::InFlight,
) {
    let app = app.clone();
    let ws = workspace_id.to_string();
    let spawned = std::thread::Builder::new().name("ply-copy-setup".into()).spawn(move || {
        // Hard Rule #2: the cached PATH, as every spawn.
        let path_env = crate::shell_env::try_get()
            .map(|env| env.path.clone())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        let place = Place { registry_dir: &dir, workspace_cwd: &cwd };
        let timeout = Duration::from_secs(crate::worktree_setup::SETUP_TIMEOUT_SECS);
        if let Err(e) = prepare(place, &entry, &settings, &path_env, timeout) {
            log::warn!("copies: {ws}: setup of {}: {e}", entry.id);
        }
        drop(in_flight);
        emit_changed(&app, &ws);
    });
    if let Err(e) = spawned {
        // The claim went with the closure: the record reads as interrupted.
        log::warn!("copies: setup thread failed to start: {e}");
    }
}

/// What [`stage_setup_retry`] decided.
pub enum SetupRetry {
    /// The workspace sets nothing up any more: the record was cleared.
    Cleared(CopyEntry),
    /// Marked `running`; run it with [`prepare`] while holding `in_flight`.
    Run {
        entry: CopyEntry,
        settings: WorktreeSettings,
        in_flight: crate::worktree_setup::InFlight,
    },
}

/// Retry a copy's setup, as a card's Retry does
/// (`commands::card_worktree_setup_retry`): `allow` is "Allow and run" — the
/// command the row showed, approved on this Mac first (`save`), only while it
/// is still the repository's command. Refused for a copy that isn't active,
/// whose folder is gone, that a card owns, or whose setup is running.
pub fn stage_setup_retry(
    place: Place<'_>,
    workspace_id: &str,
    id: &str,
    allow: Option<&str>,
    mut settings: WorktreeSettings,
    save: &dyn Fn(&WorktreeSettings) -> Result<(), String>,
) -> Result<SetupRetry, String> {
    if !is_copy_id(id) {
        return Err(format!("not a copy: {id:?}"));
    }
    let copy = load(place.registry_dir)
        .copies
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("That copy is no longer listed.")?;
    if copy.is_a_card() {
        return Err(IS_A_CARD_REFUSAL.to_string());
    }
    if copy.state != CopyState::Active || !Path::new(&copy.path).is_dir() {
        return Err("That copy's folder isn't there to set up.".to_string());
    }
    if crate::worktree_setup::is_in_flight(workspace_id, id) {
        return Err(crate::worktree_setup::SETUP_RUNNING_REFUSAL.to_string());
    }
    if let Some(command) = allow.map(str::trim) {
        if settings.setup_command() == Some(command) {
            settings.approved_setup = Some(command.to_string());
            save(&settings)?;
        }
    }
    if !settings.configured() {
        let cleared = update(place.registry_dir, |file| {
            let c = find_mut(file, id)?;
            c.setup = None;
            Ok((c.clone(), true))
        })?;
        return Ok(SetupRetry::Cleared(cleared));
    }
    let in_flight = crate::worktree_setup::begin(workspace_id, id)
        .ok_or_else(|| crate::worktree_setup::SETUP_RUNNING_REFUSAL.to_string())?;
    let at = crate::worktree_setup::now_millis();
    mark_setup_running(place, id, settings.setup_command(), at)?;
    let mut entry = copy;
    entry.setup = Some(WorktreeSetupRecord::running(settings.setup_command(), at));
    Ok(SetupRetry::Run { entry, settings, in_flight })
}

/// `copy_setup_retry(ws, id, allow)`: stage under `CARD_START_LOCK`, run on
/// the setup thread, `copies://changed` at each end. Returns the entry as
/// staged (`setup.state` running, or cleared).
pub fn retry_setup_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    id: &str,
    allow: Option<&str>,
) -> Result<CopyEntry, String> {
    use tauri::Manager;
    let cwd = workspace_cwd(app, workspace_id)?;
    let configs = app.state::<crate::project_config::ProjectConfigStore>();
    let dir = configs.workspace_dir(workspace_id);
    let staged = {
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        release_stranded_for_app(app, workspace_id, &dir);
        let settings = crate::worktree_setup::load_settings(&configs, workspace_id);
        let save = |s: &WorktreeSettings| crate::worktree_setup::save_settings(&configs, workspace_id, s);
        stage_setup_retry(Place { registry_dir: &dir, workspace_cwd: &cwd }, workspace_id, id, allow, settings, &save)?
    };
    emit_changed(app, workspace_id);
    Ok(match staged {
        SetupRetry::Cleared(entry) => entry,
        SetupRetry::Run { entry, settings, in_flight } => {
            spawn_setup(app, workspace_id, dir, cwd, settings, entry.clone(), in_flight);
            entry
        }
    })
}

/// Where a new copy would start from, read without fetching: the branch,
/// whether origin is on GitHub, and when this clone last read that branch
/// from origin (unix ms) — for the sheet's "main on GitHub · read 2 min ago".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPoint {
    pub target: String,
    #[serde(rename = "fromGitHub")]
    pub from_github: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<i64>,
    /// 1.174.0 E2 (P20): files changed in the project folder (`git status
    /// --porcelain`, untracked included, ignored ones and the copies'
    /// folders left out) — none of them is in a copy. `None` when it
    /// can't be read: the sheet then says nothing, never a made-up number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_changed: Option<u32>,
    /// Steps saved on this computer's `target` that origin's `target` doesn't
    /// have (no fetch: as far as this clone knows), counted only when the two
    /// have diverged — then the copy starts from origin's and leaves them
    /// out. `Some(0)` when they haven't; `None` without both refs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_ahead: Option<u32>,
    /// 1.174.0 E2 (Challenger 1, E2-1): this computer's `target` is strictly
    /// ahead of origin's, so the copy starts from it (`BaseSource::LocalAhead`
    /// in `worktrees::resolve_base`) and carries those steps: the sheet says
    /// "main on this Mac". Response-only.
    #[serde(default)]
    pub starts_local: bool,
    /// 1.174.0 walk G3b: whether Claude already trusts the project folder
    /// (`claude_session::folder_trusted`): a copy nested in it then isn't
    /// asked about (measured, Claude Code 2.1.311: trust is kept on the
    /// repository's root). `None` when Claude's state can't be read, or for
    /// the popover's read. Response-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_trusted: Option<bool>,
    /// WALKFIX-3 (re-run, item 5): `target` is the shared setup's branch and
    /// GitHub no longer has it — C5's sentence, which the sheet says instead
    /// of "Starts from … on GitHub" (the copy would be refused). Response-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gone: Option<String>,
}

/// E2: [`StartPoint::project_changed`].
fn project_changed(repo: &Path) -> Option<u32> {
    // Challenger 1 (E2-2): as `project_setup`'s read — no optional locks, so
    // it never races the person's own git; every untracked file counted.
    let out = crate::git::capture(
        repo,
        &["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    )
    .ok()?;
    let n = out
        .lines()
        .filter(|l| l.len() > 3)
        .filter(|l| {
            let path = l[3..].trim_matches('"');
            !(path.starts_with(".plyloft-worktrees/") || path.starts_with(".atelier-worktrees/"))
        })
        .count();
    u32::try_from(n).ok()
}

/// E2: [`StartPoint::local_ahead`] and [`StartPoint::starts_local`], read as
/// `worktrees::resolve_base` decides (Challenger 1, E2-1): level or behind →
/// origin's, nothing left out; strictly ahead → this computer's, nothing
/// left out; diverged → origin's, the local-only steps left out.
fn local_relation(repo: &Path, target: &str) -> (Option<u32>, bool) {
    if target.is_empty() {
        return (None, false);
    }
    let Some(local) = crate::worktrees::resolve_commit(repo, &format!("refs/heads/{target}")) else {
        return (None, false);
    };
    let Some(remote) = crate::worktrees::resolve_commit(repo, &format!("refs/remotes/origin/{target}")) else {
        return (None, false);
    };
    if local == remote || crate::worktrees::is_ancestor(repo, &local, &remote) {
        return (Some(0), false);
    }
    if crate::worktrees::is_ancestor(repo, &remote, &local) {
        return (Some(0), true);
    }
    let count = crate::git::capture(repo, &["rev-list", "--count", &format!("{remote}..{local}")])
        .ok()
        .and_then(|out| out.trim().parse::<u32>().ok());
    (count, false)
}

/// [`StartPoint`] for `target` in `workspace_cwd`. `readAt`: the newest of
/// `FETCH_HEAD` (when its last fetch named `target`), the last entry of
/// `refs/remotes/origin/<target>`'s reflog and that ref's own file — none
/// when this clone never read the branch from origin. Read-only.
#[cfg_attr(not(test), allow(dead_code))]
pub fn start_point(workspace_cwd: &Path, target: &str) -> StartPoint {
    start_point_with(workspace_cwd, target, true)
}

/// [`start_point`]; `count_changed` false leaves `project_changed` unread
/// (`None`) — the "Same folder" popover doesn't need the folder's `git
/// status` (round 2).
pub fn start_point_with(workspace_cwd: &Path, target: &str, count_changed: bool) -> StartPoint {
    let target = target.trim().to_string();
    let from_github = crate::review_base::origin_record_of(workspace_cwd).0.is_some();
    let read_at = (!target.is_empty())
        .then(|| origin_read_at(workspace_cwd, &target))
        .flatten();
    let project_changed = if count_changed { project_changed(workspace_cwd) } else { None };
    let (local_ahead, starts_local) = local_relation(workspace_cwd, &target);
    StartPoint { target, from_github, read_at, project_changed, local_ahead, starts_local, claude_trusted: None, gone: None }
}

fn origin_read_at(repo: &Path, target: &str) -> Option<i64> {
    let remote_ref = format!("refs/remotes/origin/{target}");
    crate::worktrees::resolve_commit(repo, &remote_ref)?;
    let common = crate::git::capture(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok()?;
    let common = PathBuf::from(common.trim());
    let mtime_ms = |p: &Path| -> Option<i64> {
        let modified = std::fs::metadata(p).ok()?.modified().ok()?;
        Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
    };
    let mut times: Vec<i64> = Vec::new();
    let fetch_head = common.join("FETCH_HEAD");
    if std::fs::read_to_string(&fetch_head).is_ok_and(|t| t.contains(&format!("branch '{target}' of "))) {
        times.extend(mtime_ms(&fetch_head));
    }
    let reflog = common.join("logs").join(&remote_ref);
    if let Some(last) = std::fs::read_to_string(&reflog).ok().and_then(|t| t.lines().last().map(str::to_string)) {
        // `<old> <new> <name> <email> <unix seconds> <tz>\t<message>`
        let head = last.split('\t').next().unwrap_or("");
        let mut words = head.split_whitespace().rev();
        let _tz = words.next();
        if let Some(secs) = words.next().and_then(|w| w.parse::<i64>().ok()) {
            times.push(secs * 1000);
        }
    }
    times.extend(mtime_ms(&common.join(&remote_ref)));
    times.into_iter().max()
}

/// `copy_start_point(ws, target?)`: the workspace's target unless `target`
/// is given (B1's areas). `None` target when the workspace isn't set up.
pub fn start_point_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    target: Option<&str>,
    count_changed: bool,
) -> Result<StartPoint, String> {
    use tauri::Manager;
    let cwd = workspace_cwd(app, workspace_id)?;
    let target = match target.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => app
            .state::<crate::project_config::ProjectConfigStore>()
            .get(workspace_id)
            .map(|c| c.target_branch)
            .unwrap_or_default(),
    };
    let mut point = start_point_with(&cwd, &target, count_changed);
    let configs = app.state::<crate::project_config::ProjectConfigStore>();
    point.gone = crate::move_shared_setup::branch_gone_refusal(&configs, workspace_id, &target);
    if count_changed {
        point.claude_trusted = crate::claude_session::folder_trusted(&cwd);
    }
    Ok(point)
}

/// `worktree_delete` on a folder that is a listed copy goes through
/// [`throw_away`] (its refusals, its record) instead of the cards' delete;
/// an unlisted `copy-…` folder is deleted as any other.
pub fn is_listed_copy(registry_dir: &Path, dir_name: &str) -> bool {
    is_copy_id(dir_name) && load(registry_dir).copies.iter().any(|c| c.id == dir_name)
}

/// `list_copies(ws)`.
pub fn list_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<Vec<CopyView>, String> {
    let cwd = workspace_cwd(app, workspace_id)?;
    let Some(dir) = registry_dir(app, workspace_id) else { return Ok(Vec::new()) };
    // Challenger 4: only when no card start (Make it a card) is under way.
    if let Some(_start) = try_card_start_lock() {
        release_stranded_for_app(app, workspace_id, &dir);
    }
    let terminals = terminals_in(app);
    let running = |id: &str| crate::worktree_setup::is_in_flight(workspace_id, id);
    Ok(list(Place { registry_dir: &dir, workspace_cwd: &cwd }, &terminals, &running))
}

/// `throw_away(ws, id)`.
pub fn throw_away_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    id: &str,
) -> Result<CopyEntry, String> {
    use tauri::Manager;
    let cwd = workspace_cwd(app, workspace_id)?;
    let dir = registry_dir(app, workspace_id).ok_or("the project settings aren't loaded")?;
    let cache_paths = app.state::<crate::project_config::ProjectConfigStore>().cache_paths(workspace_id);
    let terminals = terminals_in(app);
    refuse_while_sending(workspace_id, id)?;
    let out = {
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        release_stranded_for_app(app, workspace_id, &dir);
        throw_away(
            Place { registry_dir: &dir, workspace_cwd: &cwd },
            id,
            &cache_paths,
            &terminals,
            crate::worktree_setup::is_in_flight(workspace_id, id),
            crate::kanban::now_ms(),
        )?
    };
    emit_changed(app, workspace_id);
    Ok(out)
}

/// The Undo of [`throw_away_for_app`].
pub fn restore_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    id: &str,
) -> Result<CopyEntry, String> {
    let cwd = workspace_cwd(app, workspace_id)?;
    let dir = registry_dir(app, workspace_id).ok_or("the project settings aren't loaded")?;
    let out = {
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        release_stranded_for_app(app, workspace_id, &dir);
        restore(Place { registry_dir: &dir, workspace_cwd: &cwd }, id)?
    };
    emit_changed(app, workspace_id);
    Ok(out)
}

/// Called by `branch_cleanup::sweep_for_app` right after `gc_trash`, under
/// `CARD_START_LOCK` of its own (taken here, never nested). A3: first, with
/// no lock held, what GitHub says of the copies' open pull requests
/// ([`refresh_prs_for_app`]).
pub fn sweep_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    enabled: bool,
    now: i64,
) {
    let Some(dir) = registry_dir(app, workspace_id) else { return };
    if !registry_path(&dir).exists() {
        return;
    }
    refresh_prs_for_app(app, workspace_id, cwd, &dir);
    let terminals = terminals_in(app);
    let swept = {
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        sweep(Place { registry_dir: &dir, workspace_cwd: cwd }, enabled, now, &terminals)
    };
    match swept {
        Ok(true) => emit_changed(app, workspace_id),
        Ok(false) => {}
        Err(e) => log::warn!("copies: {workspace_id}: sweep: {e}"),
    }
}

/// A3: read each open pull request a copy opened (`gh pr view`, bounded,
/// as the workspace's GitHub account); one that merged has its branch
/// deleted on GitHub as a card's ([`after_pr_merged`]); merged or closed,
/// the entry says so, and the sweep may then take the branch here. Nothing
/// is read for a copy with no pull request, or a card's. A `gh` that can't
/// answer leaves the pull request open (its branch is kept).
pub fn refresh_prs_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path, dir: &Path) {
    let open: Vec<CopyEntry> = load(dir).copies.into_iter().filter(|c| !c.is_a_card() && c.pr_open()).collect();
    if open.is_empty() {
        return;
    }
    let Ok(gh) = crate::doctor::require("gh") else { return };
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let place = Place { registry_dir: dir, workspace_cwd: cwd };
    let mut changed = false;
    for copy in open {
        let Some(pr) = copy.pr.as_ref() else { continue };
        let out = crate::github::gh_output(
            &gh,
            Some(cwd),
            &["pr", "view", &pr.url, "--json", "state,headRefName,isCrossRepository,headRefOid"],
            crate::github::GH_API_TIMEOUT,
        );
        let Some(read) = out
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| read_pr_view(&String::from_utf8_lossy(&o.stdout)))
        else {
            continue;
        };
        let kept = match read.state.as_str() {
            "merged" => after_pr_merged(&crate::after_merge::RealRemote { cwd }, cwd, &copy, &read),
            _ => None,
        };
        match note_pr_state(place, &copy.id, &pr.url, &read.state, kept) {
            Ok(c) => changed |= c,
            Err(e) => log::warn!("copies: {workspace_id}: pull request of {}: {e}", copy.id),
        }
    }
    if changed {
        emit_changed(app, workspace_id);
    }
}

/// Challenger 7: [`refresh_prs_for_app`] for the Copies view as it opens,
/// so a pull request merged on GitHub reads so without waiting for the sweep.
pub fn refresh_prs_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<(), String> {
    let cwd = workspace_cwd(app, workspace_id)?;
    let Some(dir) = registry_dir(app, workspace_id) else { return Ok(()) };
    refresh_prs_for_app(app, workspace_id, &cwd, &dir);
    Ok(())
}

/// `worktree_ports`' resolver for copies: `cwd` in a copy's folder → its
/// block, handed out the first time (the cards' own resolver knows only
/// folders named after a card). A copy a card owns answers with that
/// card's block.
pub fn port_base_for_cwd<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cwd: &Path) -> Option<u16> {
    use tauri::Manager;
    let (worktree, dir_name) = crate::worktree_ports::worktree_of(cwd)?;
    if !is_copy_id(&dir_name) {
        return None;
    }
    let ws_cwd = worktree.parent()?.parent()?;
    let workspace = app
        .try_state::<crate::workspace::WorkspaceStore>()?
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| crate::worktree_ports::same_dir(Path::new(&w.cwd), ws_cwd))?;
    let configs = app.try_state::<crate::project_config::ProjectConfigStore>()?;
    let dir = configs.workspace_dir(&workspace.id);
    let entry = load(&dir).copies.into_iter().find(|c| c.id == dir_name)?;
    let kanban = app.try_state::<crate::kanban::KanbanStore>()?;
    if let Some(card_id) = entry.card_id.as_deref().filter(|c| !c.trim().is_empty()) {
        return kanban.ensure_port_base(&workspace.id, card_id, None).ok().flatten();
    }
    let _pick = crate::worktree_ports::PICK_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut used = kanban.port_bases_in_use();
    used.extend(held_port_bases(configs.root(), Some(&dir)));
    let place = Place { registry_dir: &dir, workspace_cwd: ws_cwd };
    match ensure_port_base(place, &entry.id, &used, &crate::worktree_ports::block_is_free) {
        Ok(base) => base,
        Err(e) => {
            log::warn!("copies: port block of {}: {e}", entry.id);
            None
        }
    }
}

#[cfg(test)]
#[path = "copies_tests.rs"]
mod tests;
