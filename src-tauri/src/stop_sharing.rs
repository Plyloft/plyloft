//! 1.175.0 (C1, review SC-2): *Stop sharing*, and a removed shared setup
//! that stays removed.
//!
//! Before: nothing in Plyloft stopped sharing a project's setup, and a
//! `.atelier/workspace.json` taken off the integration branch by hand came
//! back with the next edit made on any computer — its publish re-created the
//! file from that computer's cached copy.
//!
//! Now a setup that was on the branch (`source == Repo`, with the commit it
//! was read at) and is gone from it is **removed**: the cached definition is
//! let go, so no edit queues and no publish runs (`record_local_edit` and
//! `publish_pending` both need one), and the values this computer has stay
//! in its stores as its own. Only *Share* and *Share it again* (both
//! `workspace_adoption::share`) create the file again.
//!
//! - [`file_gone`] — the refresh's read found neither file on a branch that
//!   answered. Writers get the Board's notice ([`Removed`] in the cache,
//!   `AdoptionAction::SetupRemoved`) and choose; a read-only member is told
//!   once and keeps the values; this computer's own removal pull request
//!   that merged is *Stop sharing* done.
//! - [`stop`] — the press. One commit on the integration branch that removes
//!   the file and touches no other path ([`remove_from_branch`]); a refused
//!   push goes to `atelier/config-stop-sharing-<ts>` (never forced:
//!   `shared_config::push_fallback`) as a pull request, and the setup stays
//!   shared until that merges ([`settle`]).
//! - [`keep_local`] — "Keep it on this Mac": the answer is recorded; nothing
//!   is written to GitHub.
//!
//! Saved state: `removed` and `sharing` in the definition cache,
//! `removalBranch` and `removalPullRequest` in the publish queue; all absent
//! in files 1.174.5 wrote, which read and behave as before.

use serde::{Deserialize, Serialize};

use crate::shared_config::{
    integration_lock, load_queue, names_used_up, pr_number, push_fallback, save_queue, with_replaces, FallbackError,
    FallbackPush, FetchFailure, Gh, GitPublisher, Plumbing, PrState, PublishQueue, Publisher, PullRequest, PushResult,
    TreeChange, DEVICE_TRAILER,
};
use crate::workspace_definition::{
    load_cache, save_cache, DefinitionCache, DefinitionSource, Deletion, RepoSource, Stores, DEFINITION_PATH,
};

/// The removal commit's subject, after `chore(config): `.
pub const STOP_SUBJECT: &str = "stop sharing the workspace setup";
/// The removal pull request's title.
pub const STOP_PR_TITLE: &str = "Settings: stop sharing the workspace setup";

/// The shared setup was on `branch` and is gone from it; the person hasn't
/// chosen yet. Kept in the cache until *Keep it on this Mac* or *Share it
/// again*, or until someone shares it again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub branch: String,
    /// The commit that took the file away, its author and when (seconds) —
    /// all absent when git can't say (a branch set back, a history rewritten).
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub at: Option<i64>,
    /// The shared fields this computer had changed and not published yet:
    /// they stay here as its own values, and the notice counts them.
    #[serde(default)]
    pub pending: Vec<String>,
    /// Round 2: this computer's pull requests of shared settings that were
    /// open when the setup went away. Plyloft no longer follows them; the
    /// row names them so the person can close them on GitHub.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub left_open: Vec<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SharingState {
    /// The setup was removed and this computer keeps its values as its own
    /// ("Keep it on this Mac", or a read-only member told once).
    KeptLocal,
    /// *Stop sharing* was pressed on this computer.
    StoppedHere,
}

/// How this project came to be not shared — so the Board doesn't ask "Share
/// this workspace's setup…?" again by itself and Settings says who stopped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sharing {
    pub state: SharingState,
    /// When it stopped (seconds): the removal's commit time when known,
    /// else when this computer learned or pressed.
    pub at: i64,
    /// Who stopped it; `None` for this computer's own press, or unknown.
    #[serde(default)]
    pub who: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// Round 2: as [`Removed::left_open`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub left_open: Vec<u64>,
    /// Round 3: *Stop sharing* was pressed here and its removal landed, seen
    /// by a read that couldn't ask GitHub — this computer's settings pull
    /// requests still to close, at the next [`settle`]. Empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to_close: Vec<PullRequest>,
    /// Round 5: the removal pull request those wait on — they are closed
    /// only once **it** reads merged (the file may have gone by a
    /// teammate's hand while it waited).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removal: Option<PullRequest>,
}

/// What a refresh says once, as a toast.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SharingNote {
    /// This computer's removal pull request merged: sharing stopped.
    /// `closed`: its settings pull requests Plyloft closed (round 3);
    /// `left_open`: those GitHub didn't let it close.
    #[serde(rename_all = "camelCase")]
    Stopped {
        branch: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        closed: Vec<u64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        left_open: Vec<u64>,
    },
    /// A read-only member: someone stopped sharing; the values stay.
    StoppedBy { who: Option<String> },
    /// The removal pull request was closed without merging.
    RemovalClosed { number: u64 },
    /// Owner, 2026-11-10: a teammate's *Share it again* landed on a
    /// computer that had the setup removed, stopped or kept here. `board`:
    /// the shared board, when it differs from this Mac's.
    #[serde(rename_all = "camelCase")]
    SharedAgain {
        who: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        board: Option<crate::workspace::KanbanSyncMode>,
    },
}

/// The cache and the queue of a project whose setup is no longer shared:
/// no definition, nothing pending, nothing queued. The stores keep their
/// values, and take the team's suggested models into this computer's blank
/// rows ([`keep_suggested_models`]). Returns this computer's settings pull
/// requests the queue was following: open on GitHub, and no longer followed.
fn forget(
    stores: &Stores<'_>,
    workspace_id: &str,
    cache: &mut DefinitionCache,
    queue: &mut PublishQueue,
) -> Vec<PullRequest> {
    keep_suggested_models(stores, workspace_id);
    // Never the removal's own pull request: it is not among the settings'.
    let removal = queue.removal_pull_request.as_ref().map(|pr| pr.number);
    let mut left_open: Vec<PullRequest> = queue
        .fields
        .values()
        .filter_map(|field| field.pull_request.as_ref())
        .chain(queue.create_pull_request.as_ref())
        .chain(queue.superseded_pull_requests.iter())
        .filter(|pr| Some(pr.number) != removal)
        .cloned()
        .collect();
    left_open.sort_by_key(|pr| pr.number);
    left_open.dedup_by_key(|pr| pr.number);
    cache.definition = None;
    cache.source = DefinitionSource::Repo;
    cache.commit = None;
    cache.author = None;
    cache.changed_at = None;
    cache.unreadable = None;
    cache.pending.clear();
    cache.pending_state = None;
    cache.field_problems.clear();
    cache.found_elsewhere = None;
    cache.removed = None;
    *queue = PublishQueue::default();
    left_open
}

fn numbers(prs: &[PullRequest]) -> Vec<u64> {
    prs.iter().map(|pr| pr.number).collect()
}

/// Round 3 (owner, 2026-11-09): the shared-setting pull requests this
/// computer opened and was following are closed once *Stop sharing*, pressed
/// here, has really taken the file off the branch — on the direct commit,
/// and when its removal pull request is seen merged; never while the
/// removal only waits (closed without merging, the setup stays shared and
/// so do they). The channel's own close (`Publisher::close_pull_request`:
/// bounded `gh`; one already merged or closed is left as it is). A close
/// GitHub refuses is not fatal: that pull request is named as left open.
/// Returns (closed, left open).
fn close_own(publisher: &dyn Publisher, prs: &[PullRequest]) -> (Vec<u64>, Vec<u64>) {
    use crate::shared_config::OwnClose;
    let mut closed = Vec::new();
    let mut left_open = Vec::new();
    for pr in prs {
        // Round 5: only while it is still that pull request — in origin's
        // repository now, from the recorded branch, open
        // (`Publisher::close_after_stop`).
        match publisher.close_after_stop(pr) {
            Ok(OwnClose::Closed) => closed.push(pr.number),
            // Settled by someone meanwhile: nothing to close, nothing to say.
            Ok(OwnClose::Settled) => {}
            Ok(OwnClose::NotOurs) => {
                log::warn!("stop_sharing: pull request #{} is not this computer's in origin's repository now; left as it is", pr.number);
                left_open.push(pr.number);
            }
            Err(e) => {
                log::warn!("stop_sharing: pull request #{} stays open: {e}", pr.number);
                left_open.push(pr.number);
            }
        }
    }
    (closed, left_open)
}

/// Round 2: "each computer keeps the values it has now" holds for the
/// models too. The team's suggestions (`team_models`) are read only while a
/// setup is shared, so at the moment it stops being shared each suggested
/// model or effort goes into this computer's own row for the project where
/// that row is blank and not set to the tool's own default — what the
/// Builder and the Reviewer run on doesn't change at the press.
fn keep_suggested_models(stores: &Stores<'_>, workspace_id: &str) {
    let team = crate::team_models::load(stores.project_configs, workspace_id).rows();
    if team == crate::settings::RoleModels::default() {
        return;
    }
    let mut own = stores.workspaces.models_for(workspace_id).unwrap_or_default();
    let before = own.clone();
    {
        let take = |key: &str, mine: &mut Option<String>, theirs: &Option<String>| {
            let blank = mine.as_deref().is_none_or(|m| m.trim().is_empty());
            if blank && !before.forces_cli_default(key) {
                *mine = theirs.clone();
            }
        };
        take("claude.builder", &mut own.rows.claude.builder, &team.claude.builder);
        take("claude.challenger", &mut own.rows.claude.challenger, &team.claude.challenger);
        take("claude.builderReasoning", &mut own.rows.claude.builder_reasoning, &team.claude.builder_reasoning);
        take("claude.challengerReasoning", &mut own.rows.claude.challenger_reasoning, &team.claude.challenger_reasoning);
        take("codex.builder", &mut own.rows.codex.builder, &team.codex.builder);
        take("codex.challenger", &mut own.rows.codex.challenger, &team.codex.challenger);
        take("codex.builderReasoning", &mut own.rows.codex.builder_reasoning, &team.codex.builder_reasoning);
        take("codex.challengerReasoning", &mut own.rows.codex.challenger_reasoning, &team.codex.challenger_reasoning);
    }
    if own != before {
        if let Err(e) = stores.workspaces.set_models(workspace_id, Some(own)) {
            log::warn!("stop_sharing: keeping the suggested models of {workspace_id}: {e}");
        }
    }
}

/// A setup read from the branch before (`source == Repo`, with its commit).
fn was_on_the_branch(cache: &DefinitionCache) -> bool {
    cache.definition.is_some() && cache.source == DefinitionSource::Repo && cache.commit.is_some()
}

/// The older file (`workspace_default.json`) is not converted again by
/// itself where the setup was removed or sharing was stopped: that
/// conversion publishes `.atelier/workspace.json`.
pub(crate) fn ignores_older_file(cache: &DefinitionCache) -> bool {
    cache.removed.is_some() || cache.sharing.is_some() || was_on_the_branch(cache)
}

/// WALKFIX-1 (the Mac walk of 2026-11-10): the branches a project that has,
/// or had, a shared setup reads it from — the one its copy names and the one
/// it was read from, or, once it went away, the branch it was removed from,
/// stopped on, or that GitHub no longer has. `None` for a project that never
/// had a setup (no copy, nothing removed, stopped, kept or gone): the first
/// read keeps adopting the default branch's file, and GH #81's scan runs.
///
/// A read never takes, by itself, a file from another branch: after a stop
/// or a removal, the default branch often holds somebody else's copy (a
/// release merged into `main` naming `staging`, another project of the same
/// repository) and adopting it changed this project's name, colour, areas
/// and cards' branch in silence. Only *Share it again* and the person's
/// choice of a branch (*Choose where cards go*, *Move to …*, which publish
/// and record the branch in the cache) change where it reads.
pub(crate) fn own_branches(cache: Option<&DefinitionCache>, default_branch: &str) -> Option<Vec<String>> {
    let cache = cache?;
    let mut own: Vec<String> = Vec::new();
    let mut add = |b: Option<&str>| {
        if let Some(b) = b.filter(|b| !b.is_empty()) {
            if !own.iter().any(|o| o == b) {
                own.push(b.to_string());
            }
        }
    };
    if let Some(def) = cache.definition.as_ref() {
        add(Some(def.integration_branch.as_deref().unwrap_or(default_branch)));
    }
    add(cache.removed.as_ref().map(|r| r.branch.as_str()));
    add(cache.sharing.as_ref().and_then(|s| s.branch.as_deref()));
    add(cache.branch_gone.as_ref().map(|g| g.branch.as_str()));
    // Two-instance walk (C5): the same branch under the name GitHub gave it
    // when renamed — not another branch. A teammate's *Move to {new}* is read
    // there, and the gone state clears.
    add(cache.branch_gone.as_ref().and_then(|g| g.renamed_to.as_deref()));
    let had_one =
        cache.definition.is_some() || cache.removed.is_some() || cache.sharing.is_some() || cache.branch_gone.is_some();
    if !had_one {
        return None;
    }
    add(cache.branch.as_deref());
    Some(own)
}

/// Where a setup went away, and what git says of the commit that removed it.
pub(crate) struct Gone {
    pub branch: String,
    pub commit: Option<String>,
    pub author: Option<String>,
    pub at: Option<i64>,
}

impl Gone {
    fn deleted(branch: &str, commit: String, author: Option<String>, at: Option<i64>) -> Self {
        Gone { branch: branch.to_string(), commit: Some(commit), author, at }
    }
}

/// The removed state is already on record for `branch` (asked about, or
/// answered): a later read of the same fact changes nothing.
fn on_record(cache: Option<&DefinitionCache>, branch: &str) -> bool {
    cache.is_some_and(|c| {
        c.removed.as_ref().is_some_and(|r| r.branch == branch)
            || c.sharing.as_ref().is_some_and(|s| s.branch.as_deref() == Some(branch))
    })
}

/// *Share* or *Share it again* seeded the definition and its creation is
/// queued (`workspace_adoption::share`): the press that may create the file
/// again after a removal.
fn shared_on_a_press(cache: Option<&DefinitionCache>) -> bool {
    cache.is_some_and(|c| c.definition.is_some() && c.source == DefinitionSource::Seeded)
}

/// What a read of the older file means for the removed state.
pub(crate) enum OlderFile {
    /// Take it as before (a repository never converted).
    Take,
    /// Not taken, and nothing new to record.
    Leave,
    /// Round 4: git can't say whether the setup was removed (a shallow
    /// clone). Round 5: the older file is taken for reading — this computer
    /// runs on what the others have — and nothing is converted by itself
    /// (`history_unread`); converting stays on a press in Settings.
    Unread,
    /// Not taken: the setup was removed from this branch.
    Removed(Gone),
}

/// Round 2: only the older file (`workspace_default.json`) is on `branch`.
/// Its conversion publishes `.atelier/workspace.json`, so before it may run
/// by itself: a computer that saw the removal leaves it
/// ([`ignores_older_file`]); any other asks the branch's history whether
/// that file was deleted there — a computer whose cache already holds the
/// older file too (round 4: it may have slept through a conversion and a
/// removal). Deleted: the removed state, with who and when from that
/// commit. Never: taken and converted as before. Git can't say (a shallow
/// clone): [`OlderFile::Unread`] — taken for reading, no conversion by
/// itself, no "removed", and no Share question (a Share would seed the file
/// from this computer's own settings over what the others have).
pub(crate) fn older_file(repo: &dyn RepoSource, cache: Option<&DefinitionCache>, branch: &str) -> OlderFile {
    if cache.is_some_and(ignores_older_file) {
        return OlderFile::Leave;
    }
    match repo.deletion(branch, DEFINITION_PATH, None) {
        Deletion::Never => OlderFile::Take,
        Deletion::CantSay => OlderFile::Unread,
        // *Share it again* was pressed: its creation is on its way.
        Deletion::Deleted(..) if shared_on_a_press(cache) => OlderFile::Leave,
        Deletion::Deleted(commit, author, at) => {
            log::info!("stop_sharing: {DEFINITION_PATH} was removed from {branch}; the older file is not converted by itself");
            OlderFile::Removed(Gone::deleted(branch, commit, author, at))
        }
    }
}

/// What a definition read from `found_on` means when it names another
/// branch as the integration branch.
pub(crate) enum NamedBranch {
    /// Use it (the named branch has the file, never had it, or git can't say).
    Use,
    /// The setup was removed from the branch it names and that is on record.
    Leave,
    /// The setup was removed from the branch it names.
    Removed(Gone),
}

/// Round 2: the definition was read from `found_on` (the default branch,
/// say) and names another branch as the integration branch — where an edit
/// would be published, creating the file there when it is missing (the move
/// to the named branch). When that branch answers, doesn't hold the file and
/// its history deleted it **after** `written` (the commit that last wrote
/// the copy read — round 4: a removal older than that was followed by a new
/// share), the setup was removed there: a copy left on another branch is not
/// the shared setup, and must not put it back. When git can't say, the copy
/// is used for reading as before; `publish_pending` creates nothing there.
pub(crate) fn named_branch(
    repo: &dyn RepoSource,
    cache: Option<&DefinitionCache>,
    named: Option<&str>,
    found_on: &str,
    written: Option<&str>,
) -> NamedBranch {
    let Some(named) = named.filter(|n| !n.is_empty() && *n != found_on) else {
        return NamedBranch::Use;
    };
    if !repo.branch_exists(named) || repo.carries(named, DEFINITION_PATH) != Some(false) {
        return NamedBranch::Use;
    }
    match repo.deletion(named, DEFINITION_PATH, written) {
        Deletion::Never | Deletion::CantSay => NamedBranch::Use,
        Deletion::Deleted(..) if on_record(cache, named) || shared_on_a_press(cache) => NamedBranch::Leave,
        Deletion::Deleted(commit, author, at) => NamedBranch::Removed(Gone::deleted(named, commit, author, at)),
    }
}

/// The refresh found neither file. `fetched`: every branch it asked
/// answered. The setup is removed when it was on the cache's branch, that
/// branch answers and git says the file isn't at its tip — never on a
/// branch that is unreachable or gone, and never when git can't say.
pub(crate) fn file_gone(
    stores: &Stores<'_>,
    repo: &dyn RepoSource,
    workspace_id: &str,
    cache: &mut DefinitionCache,
    fetched: bool,
    now_secs: i64,
) -> Option<SharingNote> {
    if !was_on_the_branch(cache) {
        return None;
    }
    let branch = cache.branch.clone()?;
    if !fetched && repo.fetch(&branch).is_err() {
        return None;
    }
    if !repo.branch_exists(&branch) || repo.carries(&branch, DEFINITION_PATH) != Some(false) {
        return None;
    }
    let (commit, author, at) = repo
        .last_touch(&branch, DEFINITION_PATH)
        .filter(|(commit, _, _)| Some(commit) != cache.commit.as_ref())
        .map(|(commit, author, at)| (Some(commit), author, at))
        .unwrap_or((None, None, None));
    let_go(stores, workspace_id, cache, Gone { branch, commit, author, at }, now_secs)
}

/// Let go of a setup that is `gone`: the definition leaves the cache and the
/// queue is emptied ([`forget`]); the stores keep their values. This
/// computer's own removal that merged is *Stop sharing* done; a read-only
/// member is told once and keeps the values; a writer gets the notice
/// ([`Removed`] in the cache) and chooses.
pub(crate) fn let_go(
    stores: &Stores<'_>,
    workspace_id: &str,
    cache: &mut DefinitionCache,
    gone: Gone,
    now_secs: i64,
) -> Option<SharingNote> {
    let Gone { branch, commit, author, at } = gone;
    let pending: Vec<String> = cache.pending.keys().cloned().collect();
    let read_only = cache.write_access.read_only();
    let mut queue = load_queue(stores.project_configs, workspace_id);
    let removal = queue.removal_pull_request.clone();
    let own = removal.is_some();
    let own_open = forget(stores, workspace_id, cache, &mut queue);
    let left_open = numbers(&own_open);
    if let Err(e) = save_queue(stores.project_configs, workspace_id, &queue) {
        log::warn!("stop_sharing: clearing the queue of {workspace_id}: {e}");
    }
    log::info!("stop_sharing: {DEFINITION_PATH} is gone from {branch} for {workspace_id}");
    cache.branch = Some(branch.clone());
    if own {
        cache.sharing = Some(Sharing {
            state: SharingState::StoppedHere,
            at: at.unwrap_or(now_secs),
            who: None,
            branch: Some(branch.clone()),
            left_open: Vec::new(),
            // Round 3: this read can't ask GitHub. They are closed, and
            // "Stopped sharing" said with them, by `close_deferred` — once
            // the removal's own pull request reads merged (round 5).
            to_close: own_open.clone(),
            removal: removal.filter(|_| !own_open.is_empty()),
        });
        return own_open.is_empty().then(|| SharingNote::Stopped { branch, closed: Vec::new(), left_open: Vec::new() });
    }
    if read_only {
        cache.sharing = Some(Sharing {
            state: SharingState::KeptLocal,
            at: at.unwrap_or(now_secs),
            who: author.clone(),
            branch: Some(branch),
            left_open,
            to_close: Vec::new(),
            removal: None,
        });
        return Some(SharingNote::StoppedBy { who: author });
    }
    cache.removed = Some(Removed { branch, commit, author, at, pending, left_open });
    None
}

/// "Keep it on this Mac": the removed setup's values are this computer's
/// own from now on. Nothing is written to GitHub.
pub fn keep_local(stores: &Stores<'_>, workspace_id: &str, now_secs: i64) -> Result<(), String> {
    keep_removed(stores, workspace_id, now_secs, false).map(|_| ())
}

/// Round 2: the removed setup of a member GitHub says can't push — nothing
/// to choose (they can't share it again), so it is kept here as for a
/// read-only member at detection, and said once. `None` when nothing was
/// removed (another read got there first).
pub fn keep_for_reader(stores: &Stores<'_>, workspace_id: &str, now_secs: i64) -> Option<SharingNote> {
    keep_removed(stores, workspace_id, now_secs, true).ok().map(|who| SharingNote::StoppedBy { who })
}

fn keep_removed(
    stores: &Stores<'_>,
    workspace_id: &str,
    now_secs: i64,
    reader: bool,
) -> Result<Option<String>, String> {
    let nothing = || "This project has no removed shared setup to keep.".to_string();
    let mut cache = load_cache(stores.project_configs, workspace_id).ok_or_else(nothing)?;
    let removed = cache.removed.take().ok_or_else(nothing)?;
    if reader {
        cache.write_access.record_permission(false);
    }
    let who = removed.author.clone();
    cache.sharing = Some(Sharing {
        state: SharingState::KeptLocal,
        at: removed.at.unwrap_or(now_secs),
        who: removed.author,
        branch: Some(removed.branch),
        left_open: removed.left_open,
        to_close: Vec::new(),
        removal: None,
    });
    save_cache(stores.project_configs, workspace_id, &cache)?;
    Ok(who)
}

// ── The removal ───────────────────────────────────────────────────────

pub struct RemovalRequest<'a> {
    pub branch: &'a str,
    /// This computer's name for the commit's trailer; `None` writes none.
    pub device: Option<&'a str>,
    /// The fallback branch, fixed before the first attempt.
    pub pull_request_branch: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemovalOutcome {
    Removed { commit: String },
    /// The file isn't on the branch (someone removed it meanwhile).
    AlreadyGone,
    PullRequest(PullRequest),
    Unreachable(String),
    Failed(String),
}

/// The channel's removal, behind a trait so [`stop`] is tested without a
/// remote.
pub trait Remover {
    fn remove(&self, request: &RemovalRequest<'_>) -> RemovalOutcome;
}

impl Remover for GitPublisher {
    fn remove(&self, request: &RemovalRequest<'_>) -> RemovalOutcome {
        let request = RemovalRequest { device: request.device.or(self.device.as_deref()), ..*request };
        remove_from_branch(&self.git, self.gh.as_ref(), &request, &mut |_| {})
    }
}

fn removal_message(device: Option<&str>) -> String {
    let mut message =
        crate::commit_message::config_message(&[crate::commit_message::config_line(STOP_SUBJECT)]);
    if let Some(device) = device.map(str::trim).filter(|d| !d.is_empty()) {
        message.push_str(&format!("\n{DEVICE_TRAILER}: {}\n", device.replace('\n', " ")));
    }
    message
}

/// One commit on top of origin's `branch` that removes
/// `.atelier/workspace.json` and touches no other path, pushed as
/// `<sha>:<branch>` (never forced); retried once on a branch that moved; a
/// refusal opens a pull request from the fallback branch. Under the
/// integration lock, like every publish. `before_push` runs before each
/// push attempt (tests race it).
pub fn remove_from_branch(
    git: &Plumbing,
    gh: Option<&Gh>,
    req: &RemovalRequest<'_>,
    before_push: &mut dyn FnMut(u32),
) -> RemovalOutcome {
    let lock = integration_lock(&git.cwd, req.branch);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    let message = removal_message(req.device);
    for attempt in 1..=2 {
        match git.fetch(req.branch) {
            Ok(()) => {}
            Err(failed @ (FetchFailure::BranchMissing { .. } | FetchFailure::SignIn(_))) => {
                return RemovalOutcome::Failed(failed.to_string())
            }
            Err(FetchFailure::Unreachable(e)) => return RemovalOutcome::Unreachable(e),
        }
        let Some(tip) = git.tip(req.branch) else {
            return RemovalOutcome::Failed(format!("origin has no branch {} to remove it from", req.branch));
        };
        if git.read_at(&tip, DEFINITION_PATH).is_none() {
            return RemovalOutcome::AlreadyGone;
        }
        let removal = [TreeChange { path: DEFINITION_PATH.to_string(), content: None }];
        let sha = match git.commit_tree_changes(&tip, &removal, &message) {
            Ok(sha) => sha,
            Err(e) => return RemovalOutcome::Failed(e),
        };
        before_push(attempt);
        match git.push(&sha, req.branch) {
            PushResult::Pushed => {
                log::info!("stop_sharing: removed {DEFINITION_PATH} from {} as {sha}", req.branch);
                return RemovalOutcome::Removed { commit: sha };
            }
            PushResult::NonFastForward(e) if attempt == 1 => {
                log::info!("stop_sharing: {} moved on, retrying once: {e}", req.branch);
            }
            PushResult::NonFastForward(e) | PushResult::Refused(e) => {
                log::warn!("stop_sharing: push to {} refused, opening a pull request: {e}", req.branch);
                return removal_pull_request(git, gh, req, &sha, &message, &e);
            }
            PushResult::Unreachable(e) => return RemovalOutcome::Unreachable(e),
        }
    }
    unreachable!("the second attempt always returns")
}

fn removal_pull_request(
    git: &Plumbing,
    gh: Option<&Gh>,
    req: &RemovalRequest<'_>,
    sha: &str,
    message: &str,
    refused: &str,
) -> RemovalOutcome {
    let Some(gh) = gh else {
        return RemovalOutcome::Failed(format!(
            "{} refused the push ({refused}) and the GitHub CLI isn't available to open a pull request instead",
            req.branch
        ));
    };
    let Some(repo) = git.github_repo() else {
        return RemovalOutcome::Failed(format!(
            "{} refused the push ({refused}) and origin isn't a GitHub repository Plyloft can open a pull request on",
            req.branch
        ));
    };
    let body = format!(
        "{message}\nPlyloft couldn't push this to `{}` directly ({}), so it waits here. Only `{DEFINITION_PATH}` is removed, and the setup stays shared until this merges.",
        req.branch,
        refused.lines().last().unwrap_or(refused).trim(),
    );
    let FallbackPush { branch, reuse, replaced, head } =
        match push_fallback(git, gh, &repo, req.branch, req.pull_request_branch, sha) {
            Ok(pushed) => pushed,
            Err(FallbackError::Unreachable(e)) => return RemovalOutcome::Unreachable(e),
            Err(FallbackError::Refused(e)) => {
                return RemovalOutcome::Failed(format!(
                    "{} refused the push and the pull request branch too: {e}",
                    req.branch
                ))
            }
            Err(FallbackError::Exhausted) => return RemovalOutcome::Failed(names_used_up(req.pull_request_branch)),
        };
    let body = with_replaces(git, body, &replaced, reuse.as_deref().and_then(pr_number));
    let url = match reuse {
        Some(url) => {
            if let Some(number) = pr_number(&url) {
                if let Err(e) = gh.pr_edit(&git.cwd, &repo, number, STOP_PR_TITLE, &body) {
                    log::info!("stop_sharing: PR #{number} carries the new commit; its description stays: {e}");
                }
            }
            url
        }
        None => match gh.pr_create(&git.cwd, &repo, req.branch, &branch, STOP_PR_TITLE, &body) {
            Ok(url) => url,
            Err(e) => return RemovalOutcome::Failed(format!("opening the pull request failed: {e}")),
        },
    };
    match pr_number(&url) {
        Some(number) => RemovalOutcome::PullRequest(PullRequest { number, url, branch, head: Some(head) }),
        None => RemovalOutcome::Failed(format!("gh printed no pull request URL: {url}")),
    }
}

/// What *Stop sharing* did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StopOutcome {
    /// The file is off the branch; this computer keeps its values.
    /// `closed`: this computer's settings pull requests Plyloft closed
    /// (round 3); `left_open`: those GitHub didn't let it close.
    #[serde(rename_all = "camelCase")]
    Stopped {
        branch: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        closed: Vec<u64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        left_open: Vec<u64>,
    },
    /// The branch refused the push: the removal waits in a pull request and
    /// the setup stays shared until it merges.
    #[serde(rename_all = "camelCase")]
    PullRequest { branch: String, number: u64, url: String },
}

/// *Stop sharing* pressed here has taken the file off the branch: let go
/// of the setup, close this computer's own settings pull requests
/// ([`close_own`]) and record the answer. Returns (closed, left open).
fn stopped_here(
    stores: &Stores<'_>,
    publisher: &dyn Publisher,
    workspace_id: &str,
    cache: &mut DefinitionCache,
    queue: &mut PublishQueue,
    branch: &str,
    now_secs: i64,
) -> (Vec<u64>, Vec<u64>) {
    let own_open = forget(stores, workspace_id, cache, queue);
    let (closed, left_open) = close_own(publisher, &own_open);
    cache.sharing = Some(Sharing {
        state: SharingState::StoppedHere,
        at: now_secs,
        who: None,
        branch: Some(branch.to_string()),
        left_open: left_open.clone(),
        to_close: Vec::new(),
        removal: None,
    });
    (closed, left_open)
}

/// *Stop sharing*, on the person's press: remove the file from the branch
/// it was read from. Edits not published yet stay on this computer as its
/// own values; nothing else is written anywhere.
pub fn stop(
    stores: &Stores<'_>,
    remover: &dyn Remover,
    publisher: &dyn Publisher,
    workspace_id: &str,
    now_secs: i64,
) -> Result<StopOutcome, String> {
    let not_shared = || "This project's setup isn't shared, so there is nothing to stop.".to_string();
    let mut cache = load_cache(stores.project_configs, workspace_id).ok_or_else(not_shared)?;
    if cache.definition.is_none() || cache.source != DefinitionSource::Repo {
        return Err(not_shared());
    }
    if cache.write_access.read_only() {
        return Err("Stopping needs write access to the repository.".to_string());
    }
    let branch = cache.branch.clone().ok_or_else(not_shared)?;
    let mut queue = load_queue(stores.project_configs, workspace_id);
    // A removal already waiting in a pull request is not proposed twice.
    if let Some(pr) = queue.removal_pull_request.clone() {
        match publisher.pull_request_state(&pr) {
            Some(PrState::Open) | None => {
                return Ok(StopOutcome::PullRequest { branch, number: pr.number, url: pr.url });
            }
            Some(PrState::Merged) | Some(PrState::Closed) => {
                queue.removal_pull_request = None;
                queue.removal_branch = None;
            }
        }
    }
    // The fallback's name is fixed before the first attempt, so a retry
    // after a lost answer walks the same names.
    let saved = queue
        .removal_branch
        .get_or_insert_with(|| format!("atelier/config-stop-sharing-{now_secs}"))
        .clone();
    save_queue(stores.project_configs, workspace_id, &queue)?;
    let outcome = remover.remove(&RemovalRequest { branch: &branch, device: None, pull_request_branch: &saved });
    match outcome {
        RemovalOutcome::Removed { .. } | RemovalOutcome::AlreadyGone => {
            let (closed, left_open) =
                stopped_here(stores, publisher, workspace_id, &mut cache, &mut queue, &branch, now_secs);
            save_queue(stores.project_configs, workspace_id, &queue)?;
            save_cache(stores.project_configs, workspace_id, &cache)?;
            Ok(StopOutcome::Stopped { branch, closed, left_open })
        }
        RemovalOutcome::PullRequest(pr) => {
            let (number, url) = (pr.number, pr.url.clone());
            queue.removal_pull_request = Some(pr);
            save_queue(stores.project_configs, workspace_id, &queue)?;
            Ok(StopOutcome::PullRequest { branch, number, url })
        }
        RemovalOutcome::Unreachable(e) => Err(format!(
            "Plyloft couldn't reach GitHub ({}).",
            e.lines().last().unwrap_or(&e).trim()
        )),
        RemovalOutcome::Failed(e) => {
            // Round 2: every name of the fallback's sequence holds other
            // commits — the next press starts a fresh one, as the two other
            // channels do.
            if e.contains(crate::shared_config::NAMES_USED_UP_MARKER) {
                queue.removal_branch = None;
                save_queue(stores.project_configs, workspace_id, &queue)?;
            }
            Err(e)
        }
    }
}

/// The removal pull request, asked about before a refresh: merged, sharing
/// stopped here; closed without merging, the setup stays shared and nothing
/// is proposed again by itself. `None` while it is open or GitHub can't say.
pub fn settle(
    stores: &Stores<'_>,
    publisher: &dyn Publisher,
    workspace_id: &str,
    now_secs: i64,
) -> Option<SharingNote> {
    let mut queue = load_queue(stores.project_configs, workspace_id);
    let pr = queue.removal_pull_request.clone()?;
    let state = publisher.pull_request_state(&pr)?;
    let note = match state {
        PrState::Open => return None,
        PrState::Closed => {
            queue.removal_pull_request = None;
            queue.removal_branch = None;
            SharingNote::RemovalClosed { number: pr.number }
        }
        PrState::Merged => {
            let mut cache = load_cache(stores.project_configs, workspace_id)?;
            let branch = cache.branch.clone().unwrap_or_default();
            // Round 5: nothing is closed before the read that follows — it
            // may find the setup shared again. `close_deferred` closes after
            // it, and says "Stopped sharing" then.
            let own_open = forget(stores, workspace_id, &mut cache, &mut queue);
            let waits = !own_open.is_empty();
            cache.sharing = Some(Sharing {
                state: SharingState::StoppedHere,
                at: now_secs,
                who: None,
                branch: Some(branch.clone()),
                left_open: Vec::new(),
                to_close: own_open,
                removal: waits.then(|| pr.clone()),
            });
            if let Err(e) = save_cache(stores.project_configs, workspace_id, &cache) {
                log::warn!("stop_sharing: recording the merged removal for {workspace_id}: {e}");
                return None;
            }
            if waits {
                if let Err(e) = save_queue(stores.project_configs, workspace_id, &queue) {
                    log::warn!("stop_sharing: settling pull request #{} for {workspace_id}: {e}", pr.number);
                }
                return None;
            }
            SharingNote::Stopped { branch, closed: Vec::new(), left_open: Vec::new() }
        }
    };
    if let Err(e) = save_queue(stores.project_configs, workspace_id, &queue) {
        log::warn!("stop_sharing: settling pull request #{} for {workspace_id}: {e}", pr.number);
    }
    Some(note)
}

/// Round 5: this computer's settings pull requests that wait to be closed
/// (`Sharing.to_close`), dealt with **after** a read that may write: only
/// if the setup is still not shared, and only once the removal's own pull
/// request reads merged — then they are closed and "Stopped sharing" is
/// said with them. Closed without merging (the file went by someone's hand
/// while it waited): nothing is closed, they are named. Open, or GitHub
/// can't say: they keep waiting.
pub fn close_deferred(stores: &Stores<'_>, publisher: &dyn Publisher, workspace_id: &str) -> Option<SharingNote> {
    let mut cache = load_cache(stores.project_configs, workspace_id)?;
    if cache.definition.is_some() {
        return None;
    }
    let sharing = cache.sharing.as_mut().filter(|s| !s.to_close.is_empty())?;
    let merged = match sharing.removal.as_ref().map(|pr| publisher.pull_request_state(pr)) {
        Some(Some(PrState::Merged)) => true,
        Some(Some(PrState::Closed)) | None => false,
        Some(Some(PrState::Open)) | Some(None) => return None,
    };
    let waiting = std::mem::take(&mut sharing.to_close);
    sharing.removal = None;
    let (closed, left_open) = if merged { close_own(publisher, &waiting) } else { (Vec::new(), numbers(&waiting)) };
    sharing.left_open = left_open.clone();
    let branch = sharing.branch.clone().unwrap_or_default();
    if let Err(e) = save_cache(stores.project_configs, workspace_id, &cache) {
        log::warn!("stop_sharing: recording the closed pull requests of {workspace_id}: {e}");
    }
    Some(SharingNote::Stopped { branch, closed, left_open })
}

// ── Commands ──────────────────────────────────────────────────────────

fn now_secs() -> i64 {
    crate::shared_config::now_millis() / 1000
}

/// `workspace_stop_sharing(workspaceId)`: the *Stop sharing* sheet's
/// confirm. Runs git and `gh`: off the main thread.
#[tauri::command(async)]
pub fn workspace_stop_sharing(app: tauri::AppHandle, workspace_id: String) -> Result<StopOutcome, String> {
    use tauri::Emitter;
    // The push and the pull request as the workspace's GitHub account.
    let _github = crate::github_account::enter_for_app(&app, &workspace_id);
    let outcome = crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, repo| {
        let channel = crate::workspace_definition::publisher_for(repo);
        stop(stores, &channel, &channel, &workspace_id, now_secs())
    })?;
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, &workspace_id);
    Ok(outcome)
}

/// `workspace_keep_setup_local(workspaceId)`: "Keep it on this Mac" on the
/// removed-setup notice. Writes this computer's cache only.
#[tauri::command(async)]
pub fn workspace_keep_setup_local(app: tauri::AppHandle, workspace_id: String) -> Result<(), String> {
    use tauri::Emitter;
    crate::workspace_definition::with_workspace_lock(&app, &workspace_id, |stores, _| {
        keep_local(stores, &workspace_id, now_secs())
    })?;
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, &workspace_id);
    Ok(())
}
