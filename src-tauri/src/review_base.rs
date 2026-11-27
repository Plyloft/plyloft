//! The base a card's own changes are measured from, checked against the
//! real remote (review integrity, the follow-up to GH #191).
//!
//! [`crate::worktrees::card_diff_base`] picks the newest merge-base of the
//! card's head with its recorded base, `origin/<target>` and the local
//! `<target>`. The last two are refs in the repo the Builder writes to: a
//! Builder that moves local `<target>` (or this clone's
//! `refs/remotes/origin/<target>`) onto its own head makes that merge-base
//! its own head, and the reviewed diff empty.
//!
//! So a candidate other than the recorded base (Plyloft's own record, kept
//! outside the worktree) only counts when its merge-base is an ancestor of,
//! or equal to, the tip origin reports for `<target>` through
//! `git ls-remote` (bounded, never prompts or opens a sign-in window, as
//! the caller's GitHub account scope, killed on app exit like a fetch). The
//! tip itself is a candidate too. Only a network origin that is still the
//! one the card recorded at its start (GitHub `owner/name`, else the URL)
//! can vouch; a local path never ([`check_origin`]). When origin can't say
//! (no `origin`, a local path, repointed, unreachable, no such branch) only
//! the recorded base is used; a card without one (from before recorded
//! bases) keeps the local computation. Each such case carries a note the
//! review record keeps, as does an empty range (origin's target already
//! holds the head).
//!
//! This guards against opportunistic ref moves, not a determined adversary:
//! the Builder runs as the user, unsandboxed, and could still edit git
//! config (uploadpack, sshCommand, insteadOf) or Plyloft's own files.
//!
//! Two callers' needs:
//! - [`verified`]: the Challenger's range, the review diff, Ship batch's
//!   has-changes gate, each inside the workspace's account scope. Reuses an
//!   answer at most [`TIP_TTL`] old only when it named a tip for the same
//!   account; asks again before rejecting a candidate on a cached answer (a
//!   legitimate fetch may have moved past it); fetches a tip origin named
//!   that isn't here into `refs/ply/tip/<target>`, trusting the ls-remote
//!   sha, not that ref.
//! - [`informational`]: Outcome's count, the overlap checks, the Ship batch
//!   badge — hot UI paths, some on the main thread, that never go to the
//!   network. They use the last answer origin gave (any age: a past tip is
//!   still a real one) and refresh it in the background when it is old;
//!   with none yet, the recorded base. Either way their base is never newer
//!   than the verified one's tip allows, so they never show fewer files.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::git::capture as run_git;
use crate::worktrees::{is_ancestor, resolve_commit};

/// How long `git ls-remote origin` may take.
pub const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an answer from origin counts as current.
pub const TIP_TTL: Duration = Duration::from_secs(60);

/// What origin said about `refs/heads/<target>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteTip {
    Tip(String),
    NoBranch,
    Unreachable(String),
}

/// A card's diff base and, when it is not the plain verified one, why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffBase {
    pub commit: String,
    /// One line for the review record: the base was not verified, or a
    /// local ref was ahead of origin and not used.
    pub note: Option<String>,
}

struct Entry {
    tip: RemoteTip,
    /// When the ask that gave `tip` started: a slower, older ask finishing
    /// later never overwrites a newer answer.
    asked_at: Instant,
    fresh_until: Instant,
    /// The GitHub account the ask ran as ([`account_id`]), and that account
    /// handed to a background refresh, so it asks as the same one.
    account: String,
    handoff: crate::github_account::ScopeHandoff,
}

type Key = (String, String);

static TIPS: LazyLock<Mutex<HashMap<Key, Entry>>> = LazyLock::new(Default::default);
static REFRESHING: LazyLock<Mutex<HashSet<Key>>> = LazyLock::new(Default::default);

/// Per-key lock for [`fetch_tip`]: parallel reviews writing the same
/// `refs/ply/tip/<target>` would fail with "cannot lock ref".
static FETCHING: LazyLock<Mutex<HashMap<Key, std::sync::Arc<Mutex<()>>>>> = LazyLock::new(Default::default);

/// How long a failed ask is reused by the verified path, so a batch over
/// an unreachable origin doesn't pay the bound once per card.
pub const FAILURE_REUSE: Duration = Duration::from_secs(30);

/// Workspace checkout (canonical) → its configured GitHub `owner/repo`
/// (`Workspace::github_owner_repo`), kept by the workspace store: what a
/// card from before recorded origins is compared with.
static WORKSPACE_SLUGS: LazyLock<Mutex<HashMap<PathBuf, String>>> = LazyLock::new(Default::default);

thread_local! {
    /// Tests run against local bare origins, which production never trusts
    /// ([`check_origin`]). A test can turn the production rule back on.
    static ANY_ORIGIN: std::cell::Cell<bool> = const { std::cell::Cell::new(cfg!(test)) };
}

/// Whether a local-path origin is trusted on this thread — only in tests,
/// whose fixtures push to local bare origins (R10: Ship as a PR's origin
/// check follows the same rule).
pub(crate) fn local_origin_trusted() -> bool {
    ANY_ORIGIN.with(|any| any.get())
}

/// Runs `f` under the production rule on this thread: a local-path origin
/// is never trusted, as in the app.
#[cfg(test)]
pub(crate) fn with_production_origin<T>(f: impl FnOnce() -> T) -> T {
    let before = ANY_ORIGIN.with(|any| any.replace(false));
    let out = f();
    ANY_ORIGIN.with(|any| any.set(before));
    out
}

/// The workspace store's current workspaces: remember each one's GitHub
/// `owner/repo`, when it has one.
pub fn remember_workspaces<'a>(workspaces: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) {
    let mut map = HashMap::new();
    for (cwd, slug) in workspaces {
        if let Some(slug) = slug.map(str::trim).filter(|s| !s.is_empty()) {
            let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
            map.insert(cwd, slug.to_string());
        }
    }
    if let Ok(mut slugs) = WORKSPACE_SLUGS.lock() {
        *slugs = map;
    }
}

/// The configured GitHub slug of the workspace `repo` (a checkout or one
/// of its card worktrees) belongs to.
/// Empty when none is known (or git can't say where the checkout is).
fn workspace_slugs(repo: &Path) -> Vec<String> {
    let Ok(slugs) = WORKSPACE_SLUGS.lock() else { return Vec::new() };
    if slugs.is_empty() {
        return Vec::new();
    }
    let Ok(common) = run_git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]) else {
        return Vec::new();
    };
    let common = PathBuf::from(common.trim());
    let common = std::fs::canonicalize(&common).unwrap_or(common);
    match common.parent() {
        Some(checkout) => slugs_for_checkout(checkout, &slugs),
        None => Vec::new(),
    }
}

/// The configured slugs of every workspace inside the checkout rooted at
/// `checkout` — its root or a subfolder (a monorepo workspace).
fn slugs_for_checkout(checkout: &Path, slugs: &HashMap<PathBuf, String>) -> Vec<String> {
    let mut found: Vec<String> = slugs
        .iter()
        .filter(|(cwd, _)| path_within(cwd, checkout))
        .map(|(_, slug)| slug.clone())
        .collect();
    found.sort();
    found.dedup();
    found
}

/// `path` is `root` or below it, component by component; case-insensitive
/// on Windows.
fn path_within(path: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
        lower(path).starts_with(lower(root))
    } else {
        path.starts_with(root)
    }
}

/// `url` without user or password (`https://user:token@host/…` →
/// `https://host/…`): never stored on the card, never compared. An
/// scp-like `git@host:path` keeps its user (no secret there).
pub(crate) fn strip_userinfo(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    format!("{scheme}://{host}{path}")
}

fn origin_url(repo: &Path) -> Option<String> {
    run_git(repo, &["remote", "get-url", "origin"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// What kind of origin a URL (as `git remote get-url` gives it, insteadOf
/// applied) is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OriginKind {
    /// github.com HTTPS or SSH: its `owner/name`.
    GitHub(String),
    /// Any other network remote (GitLab, Bitbucket, self-hosted).
    Other(String),
    /// A local path or `file://`: the Builder can write there, never trusted.
    Local,
}

pub(crate) fn is_local_url(url: &str) -> bool {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("file:") {
        return true;
    }
    if url.contains("://") {
        return false;
    }
    let bytes = url.as_bytes();
    // `C:\…` / `C:/…`, `\\server\…`, `/…`, `./…`, `~/…`.
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    if url.starts_with(['/', '\\', '.', '~']) {
        return true;
    }
    // scp-like `host:path` has a colon before any slash; anything else is a path.
    match (url.find(':'), url.find('/')) {
        (Some(colon), Some(slash)) => slash < colon,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

fn classify(url: &str) -> OriginKind {
    if let Some(slug) = crate::team::origin_slug(url) {
        return OriginKind::GitHub(slug);
    }
    if is_local_url(url) && !ANY_ORIGIN.with(|any| any.get()) {
        return OriginKind::Local;
    }
    OriginKind::Other(strip_userinfo(url))
}

/// What a new card records about origin with its base (`WorktreeBase`):
/// the GitHub `owner/name`, else the URL of any other network remote; a
/// local path records nothing (it is never trusted).
pub fn origin_record_of(repo: &Path) -> (Option<String>, Option<String>) {
    match origin_url(repo).map(|url| classify(&url)) {
        Some(OriginKind::GitHub(slug)) => (Some(slug), None),
        Some(OriginKind::Other(url)) if !is_local_url(&url) => (None, Some(url)),
        _ => (None, None),
    }
}

/// `Ok` when origin may vouch for a tip: a network remote that is still
/// the one the card started with. `Err` says why not. `known_slugs`: the
/// configured GitHub repos of the workspaces in this checkout, for a card
/// that recorded nothing.
fn check_origin(
    url: &str,
    recorded: &Recorded<'_>,
    known_slugs: impl FnOnce() -> Vec<String>,
) -> Result<(), String> {
    let changed = |was: &str, now: &str| format!("origin changed since the card started, from {was} to {now}");
    match classify(url) {
        OriginKind::Local => Err("origin is a local path".into()),
        OriginKind::GitHub(slug) => {
            if let Some(was) = recorded.origin {
                return if was.eq_ignore_ascii_case(&slug) { Ok(()) } else { Err(changed(was, &slug)) };
            }
            if let Some(was) = recorded.origin_url {
                return Err(changed(was, &slug));
            }
            let known = known_slugs();
            if known.is_empty() || known.iter().any(|k| k.eq_ignore_ascii_case(&slug)) {
                Ok(())
            } else {
                Err(format!(
                    "origin is {slug}, not this workspace's GitHub repository {}",
                    known.join(" / ")
                ))
            }
        }
        OriginKind::Other(now) => {
            if let Some(was) = recorded.origin_url {
                let was = strip_userinfo(was);
                return if was == now { Ok(()) } else { Err(changed(&was, &now)) };
            }
            if let Some(was) = recorded.origin {
                return Err(changed(was, &now));
            }
            // Test fixtures' bare origins, recorded by nobody.
            if ANY_ORIGIN.with(|any| any.get()) {
                return Ok(());
            }
            Err("origin is not on GitHub and this card recorded no origin URL to compare".into())
        }
    }
}

/// Who this thread's GitHub calls act as: "" for gh's active account.
fn account_id() -> String {
    match crate::github_account::scoped_login() {
        None => String::new(),
        Some(Ok(login)) => login,
        Some(Err(_)) => "!unusable".into(),
    }
}

/// Never a prompt or a sign-in window (GCM on Windows), as the setup probe.
const NO_PROMPT_CONFIG: [&str; 2] = ["-c", "credential.interactive=never"];
const NO_PROMPT_ENV: [(&str, &str); 4] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("LC_ALL", "C"),
    ("LANGUAGE", "C"),
];

/// `git ls-remote origin refs/heads/<target>`, bounded, never prompting.
fn ls_remote(repo: &Path, target: &str) -> RemoteTip {
    let wanted = format!("refs/heads/{target}");
    let mut cmd = crate::platform::git_command();
    if let Err(words) = crate::github_account::apply_to_network_git(&mut cmd, repo) {
        return RemoteTip::Unreachable(words);
    }
    cmd.args(NO_PROMPT_CONFIG).args(["ls-remote", "origin", &wanted]).current_dir(repo);
    for (key, value) in NO_PROMPT_ENV {
        cmd.env(key, value);
    }
    match crate::worktrees::run_bounded(&mut cmd, "git ls-remote origin", LS_REMOTE_TIMEOUT) {
        Ok(out) => out
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .find(|(_, name)| name.trim() == wanted)
            .map(|(sha, _)| RemoteTip::Tip(sha.trim().to_string()))
            .unwrap_or(RemoteTip::NoBranch),
        Err(e) => RemoteTip::Unreachable(e),
    }
}

/// The verified path's fetch of a tip origin named that isn't here, into a
/// ref only Plyloft uses (never `refs/remotes`, never the local branch).
/// Trust still comes from the ls-remote answer, not from this ref.
fn fetch_tip(repo: &Path, key: &Key) {
    let lock = FETCHING
        .lock()
        .map(|mut locks| locks.entry(key.clone()).or_default().clone())
        .unwrap_or_default();
    let _one_at_a_time = lock.lock();
    let target = key.1.as_str();
    let refspec = format!("+refs/heads/{target}:refs/ply/tip/{target}");
    let mut args: Vec<&str> = NO_PROMPT_CONFIG.to_vec();
    // `--refmap=`: no opportunistic update of `refs/remotes/origin/*`.
    args.extend(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", &refspec]);
    if let Err(e) = crate::worktrees::run_bounded_network_git(repo, &args, LS_REMOTE_TIMEOUT, &NO_PROMPT_ENV) {
        log::info!("review base: {e}");
    }
}

/// Ask origin now (as this thread's account) and remember the answer.
fn ask(repo: &Path, key: &Key) -> RemoteTip {
    let asked_at = Instant::now();
    let account = account_id();
    let handoff = crate::github_account::handoff();
    let tip = ls_remote(repo, &key.1);
    if let Ok(mut tips) = TIPS.lock() {
        if tips.get(key).is_none_or(|e| e.asked_at <= asked_at) {
            tips.insert(
                key.clone(),
                Entry {
                    tip: tip.clone(),
                    asked_at,
                    fresh_until: Instant::now() + TIP_TTL,
                    account,
                    handoff,
                },
            );
        }
    }
    tip
}

/// A remembered answer.
struct Cached {
    tip: RemoteTip,
    /// Still current (within [`TIP_TTL`], no fetch since).
    fresh: bool,
    account: String,
    asked_at: Instant,
}

fn cached(key: &Key) -> Option<Cached> {
    let tips = TIPS.lock().ok()?;
    tips.get(key).map(|e| Cached {
        tip: e.tip.clone(),
        fresh: Instant::now() < e.fresh_until,
        account: e.account.clone(),
        asked_at: e.asked_at,
    })
}

/// The verified path may reuse this answer instead of asking: a tip for
/// the same account while current, or a failure for it within
/// [`FAILURE_REUSE`].
fn reusable(c: &Cached) -> bool {
    if c.account != account_id() {
        return false;
    }
    match c.tip {
        RemoteTip::Tip(_) => c.fresh,
        RemoteTip::Unreachable(_) => c.fresh && c.asked_at.elapsed() < FAILURE_REUSE,
        _ => false,
    }
}

/// One background ask per key at a time; the informational paths never
/// wait. It asks as the account the remembered answer came from (else as
/// this thread's).
fn refresh_in_background(repo: &Path, key: Key) {
    if crate::worktrees::exit_registry().is_shutting_down() {
        return;
    }
    let started = REFRESHING.lock().map(|mut busy| busy.insert(key.clone())).unwrap_or(false);
    if !started {
        return;
    }
    let handoff = TIPS
        .lock()
        .ok()
        .and_then(|tips| tips.get(&key).map(|e| e.handoff.clone()))
        .unwrap_or_else(crate::github_account::handoff);
    let repo: PathBuf = repo.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("ply-remote-tip".into())
        .spawn({
            let key = key.clone();
            move || {
                let _github = handoff.enter();
                ask(&repo, &key);
                if let Ok(mut busy) = REFRESHING.lock() {
                    busy.remove(&key);
                }
            }
        });
    if spawned.is_err() {
        if let Ok(mut busy) = REFRESHING.lock() {
            busy.remove(&key);
        }
    }
}

/// A fetch of `target` from origin just moved this clone's remote-tracking
/// ref: the remembered tip is no longer current (kept as a fallback).
pub fn invalidate(repo: &Path, target: Option<&str>) {
    let Some(url) = origin_url(repo) else { return };
    if let Ok(mut tips) = TIPS.lock() {
        let now = Instant::now();
        for ((u, t), entry) in tips.iter_mut() {
            if *u == url && target.is_none_or(|target| target == t) {
                entry.fresh_until = now;
            }
        }
    }
}

/// How a lookup may reach origin.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Ask origin unless a current answer for this account names a tip;
    /// ask again before rejecting on a remembered one; fetch a named tip
    /// that isn't here.
    Network,
    /// Never wait on the network: last answer, refreshed in the background.
    CacheOnly,
}

/// What Plyloft recorded when the card started: its base commit, and
/// origin then — the GitHub `owner/name`, or another remote's URL (`None`
/// on older cards).
#[derive(Clone, Copy, Default)]
pub struct Recorded<'a> {
    pub commit: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub origin_url: Option<&'a str>,
    /// UX P1 point 7 (P-E): the target commit Plyloft merged into the card
    /// to resolve a ship conflict (`WorktreeBase::merged_target`) — trusted
    /// like `commit`, since Plyloft wrote it.
    pub merged: Option<&'a str>,
}

impl<'a> Recorded<'a> {
    pub fn of(base: Option<&'a crate::worktrees::WorktreeBase>) -> Self {
        Self {
            commit: base.map(|b| b.commit.as_str()),
            origin: base.and_then(|b| b.origin_slug.as_deref()),
            origin_url: base.and_then(|b| b.origin_url.as_deref()),
            merged: base.and_then(|b| b.merged_target.as_deref()),
        }
    }
}

/// A bare recorded commit (tests, callers without the card's base).
impl<'a> From<Option<&'a str>> for Recorded<'a> {
    fn from(commit: Option<&'a str>) -> Self {
        Self { commit, ..Self::default() }
    }
}

impl<'a> From<Option<&'a crate::worktrees::WorktreeBase>> for Recorded<'a> {
    fn from(base: Option<&'a crate::worktrees::WorktreeBase>) -> Self {
        Self::of(base)
    }
}

/// Verified base for the Challenger's range, the review diff and Ship's
/// gate. Call it inside the workspace's GitHub account scope.
pub fn verified<'a>(repo: &Path, head: &str, recorded: impl Into<Recorded<'a>>, target: &str) -> Option<DiffBase> {
    compute(repo, head, recorded.into(), target, Mode::Network)
}

/// Base for counts on hot UI paths: never touches the network, never newer
/// than what [`verified`] would accept.
pub fn informational<'a>(repo: &Path, head: &str, recorded: impl Into<Recorded<'a>>, target: &str) -> Option<DiffBase> {
    compute(repo, head, recorded.into(), target, Mode::CacheOnly)
}

fn compute(repo: &Path, head: &str, recorded: Recorded<'_>, target: &str, mode: Mode) -> Option<DiffBase> {
    let recorded_base = recorded.commit;
    let merged = recorded.merged;
    let Some(url) = origin_url(repo) else {
        return from_unverified(repo, head, recorded_base, merged, target, "there is no origin remote");
    };
    // Only a network origin that is still the one the card started with
    // can vouch for a tip.
    if let Err(why) = check_origin(&url, &recorded, || workspace_slugs(repo)) {
        return from_unverified(repo, head, recorded_base, merged, target, &why);
    }
    let key: Key = (url, target.to_string());
    // `remembered`: the answer came from the cache, not from asking now.
    let (tip, remembered) = match (cached(&key), mode) {
        (Some(c), Mode::Network) if reusable(&c) => (Some(c.tip), true),
        (_, Mode::Network) => (Some(ask(repo, &key)), false),
        (Some(Cached { tip, fresh: true, .. }), Mode::CacheOnly) => (Some(tip), true),
        (Some(Cached { tip, fresh: false, .. }), Mode::CacheOnly) => {
            refresh_in_background(repo, key.clone());
            (Some(tip), true)
        }
        (None, Mode::CacheOnly) => {
            refresh_in_background(repo, key.clone());
            (None, true)
        }
    };
    let mut tip = tip;
    let mut out = against_tip(repo, head, recorded_base, merged, target, tip.as_ref());
    if mode == Mode::Network {
        // A rejection on a remembered answer may be a legitimate fetch past
        // it: ask again.
        if remembered && out.rejected {
            tip = Some(ask(repo, &key));
            out = against_tip(repo, head, recorded_base, merged, target, tip.as_ref());
        }
        // Origin named a tip this clone hasn't fetched: fetch it, trusting
        // the sha origin gave, not the fetched ref.
        if out.tip_missing {
            fetch_tip(repo, &key);
            out = against_tip(repo, head, recorded_base, merged, target, tip.as_ref());
        }
    } else if out.rejected || out.tip_missing {
        refresh_in_background(repo, key);
    }
    out.base
}

struct Outcome {
    base: Option<DiffBase>,
    /// A ref-candidate was rejected against the answer used.
    rejected: bool,
    /// Origin named a tip this clone doesn't have.
    tip_missing: bool,
}

fn against_tip(
    repo: &Path,
    head: &str,
    recorded_base: Option<&str>,
    merged: Option<&str>,
    target: &str,
    tip: Option<&RemoteTip>,
) -> Outcome {
    let unverified = |why: String| Outcome {
        base: from_unverified(repo, head, recorded_base, merged, target, &why),
        rejected: false,
        tip_missing: false,
    };
    let sha = match tip {
        None => return unverified("origin has not been asked yet".into()),
        Some(RemoteTip::NoBranch) => return unverified(format!("origin has no {target} branch")),
        Some(RemoteTip::Unreachable(_)) => return unverified("origin could not be reached".into()),
        Some(RemoteTip::Tip(sha)) => sha,
    };
    let Some(tip) = resolve_commit(repo, sha) else {
        let mut out = unverified(format!("origin's {target} tip is not fetched here"));
        out.tip_missing = true;
        return out;
    };

    let recorded = recorded_base
        .filter(|b| !b.is_empty())
        .and_then(|b| resolve_commit(repo, b));
    let remote_ref = format!("refs/remotes/origin/{target}");
    let local_ref = format!("refs/heads/{target}");
    // (revision, trusted, words for a rejection)
    let merged = merged
        .filter(|b| !b.is_empty())
        .and_then(|b| resolve_commit(repo, b));
    // P-E: the target commit Plyloft merged into the card itself, ahead of
    // the recorded base while the card's history holds it ([`merged_first`]).
    let (first, second) = if merged_first(repo, merged.as_deref(), head) {
        (merged, recorded.clone())
    } else {
        (recorded.clone(), merged)
    };
    let candidates: [(Option<String>, bool, String); 5] = [
        (first, true, String::new()),
        (second, true, String::new()),
        (Some(tip.clone()), true, String::new()),
        (
            resolve_commit(repo, &remote_ref),
            false,
            format!("This clone's origin/{target} pointed past origin's real {target}"),
        ),
        (
            resolve_commit(repo, &local_ref),
            false,
            format!("Local {target} was ahead of origin"),
        ),
    ];
    let mut best: Option<String> = None;
    let mut rejected: Vec<(String, String)> = Vec::new();
    for (rev, trusted, words) in candidates {
        let Some(rev) = rev else { continue };
        let Some(fork) = merge_base(repo, &rev, head) else { continue };
        if !trusted && !is_ancestor(repo, &fork, &tip) {
            rejected.push((fork, words));
            continue;
        }
        best = pick(repo, best, fork);
    }
    let Some(best) = best else {
        return Outcome { base: None, rejected: !rejected.is_empty(), tip_missing: false };
    };
    // Only a rejection that would have moved the base says so.
    let moved: Vec<&String> = rejected
        .iter()
        .filter(|(fork, _)| *fork != best && !is_ancestor(repo, fork, &best))
        .map(|(_, words)| words)
        .collect();
    let mut notes: Vec<String> = Vec::new();
    if let Some(words) = moved.first() {
        let from = if recorded.as_deref().and_then(|r| merge_base(repo, r, head)).as_deref() == Some(best.as_str()) {
            "the recorded base".to_string()
        } else {
            format!("where the card meets origin's {target}")
        };
        notes.push(format!("{words}; reviewed from {from}."));
    }
    // Origin's real target already holds the head (pushed there, say):
    // the range is empty, and the review says so instead of approving it.
    let recorded_fork = recorded.as_deref().and_then(|r| merge_base(repo, r, head));
    if resolve_commit(repo, head).as_deref() == Some(best.as_str())
        && is_ancestor(repo, &best, &tip)
        && recorded_fork.as_deref() != Some(best.as_str())
    {
        notes.push(format!("{ALREADY_IN} {target}."));
    }
    Outcome {
        rejected: !moved.is_empty(),
        tip_missing: false,
        base: Some(DiffBase {
            commit: best,
            note: (!notes.is_empty()).then(|| notes.join(" ")),
        }),
    }
}

/// The start of the note for an empty range (origin's target holds the head).
pub const ALREADY_IN: &str = "This card's commits are already in origin's";

/// Origin couldn't vouch for a candidate: Plyloft's own record, else (a
/// card from before recorded bases) the local computation, said as such.
fn from_unverified(
    repo: &Path,
    head: &str,
    recorded_base: Option<&str>,
    merged: Option<&str>,
    target: &str,
    why: &str,
) -> Option<DiffBase> {
    let fork = |rev: Option<&str>| {
        rev.filter(|b| !b.is_empty())
            .and_then(|b| resolve_commit(repo, b))
            .and_then(|b| merge_base(repo, &b, head))
    };
    // P-E: the newer of the recorded base and the target commit Plyloft
    // merged into the card, both Plyloft's own records; the merged one when
    // neither is newer and the card's history holds it ([`merged_first`]).
    let merged_in = merged_first(
        repo,
        merged.filter(|b| !b.is_empty()).and_then(|b| resolve_commit(repo, b)).as_deref(),
        head,
    );
    let recorded = match (fork(recorded_base), fork(merged)) {
        (Some(r), Some(m)) if merged_in => pick(repo, Some(m), r),
        (Some(r), Some(m)) => pick(repo, Some(r), m),
        (r, m) => r.or(m),
    };
    if let Some(commit) = recorded {
        return Some(DiffBase {
            commit,
            note: Some(format!("Review base: the recorded base ({why}).")),
        });
    }
    crate::worktrees::card_diff_base_local(repo, head, None, target).map(|commit| DiffBase {
        commit,
        note: Some(format!(
            "Review base: not checked against origin ({why}) and this card has no recorded base."
        )),
    })
}

/// P-E (Windows walk): the target commit Plyloft merged into the card
/// (`merged`) outranks the recorded base while the card's history holds it.
/// The two can be incomparable: the card started from origin's tip while
/// the local target it met had diverged from origin (its own commit ahead,
/// origin's behind), so neither fork is newer and [`pick`] kept the
/// recorded one — the target's own change read as the card's. Measured
/// from the merged commit, the range is what landing the card on that
/// target changes. A merged commit the card's history doesn't hold (the
/// merge was undone) keeps the old order; a strictly newer fork wins
/// either way.
fn merged_first(repo: &Path, merged: Option<&str>, head: &str) -> bool {
    merged.is_some_and(|m| is_ancestor(repo, m, head))
}

fn merge_base(repo: &Path, a: &str, b: &str) -> Option<String> {
    run_git(repo, &["merge-base", a, b])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The newer of two merge-bases; incomparable ones keep the earlier pick
/// (higher-priority candidate), as `card_diff_base_local` does.
fn pick(repo: &Path, best: Option<String>, fork: String) -> Option<String> {
    match best {
        Some(b) if b == fork || !is_ancestor(repo, &b, &fork) => Some(b),
        _ => Some(fork),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) -> String {
        crate::git::capture(dir, args)
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
            .trim()
            .to_string()
    }

    fn identity(dir: &Path) {
        for (k, v) in [("user.email", "t@t"), ("user.name", "t"), ("commit.gpgsign", "false")] {
            git(dir, &["config", k, v]);
        }
    }

    fn commit(dir: &Path, name: &str) -> String {
        fs::write(dir.join(name), format!("{name}\n")).unwrap();
        git(dir, &["add", name]);
        git(dir, &["commit", "-q", "-m", name]);
        git(dir, &["rev-parse", "HEAD"])
    }

    /// A bare origin, this clone `ws`, another clone `other`, and a card
    /// branch `card` in a worktree started from origin/main with one file.
    struct Fixture {
        _tmp: tempfile::TempDir,
        ws: PathBuf,
        other: PathBuf,
        wt: PathBuf,
        base: String,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let seed = root.join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        commit(&seed, "seed.txt");
        let origin = root.join("origin.git");
        let s = |p: &Path| p.to_str().unwrap().to_string();
        git(root, &["clone", "-q", "--bare", &s(&seed), &s(&origin)]);
        let (ws, other) = (root.join("ws"), root.join("other"));
        for dir in [&ws, &other] {
            git(root, &["clone", "-q", "-c", "core.autocrlf=false", &s(&origin), &s(dir)]);
            identity(dir);
        }
        let wt = root.join("wt");
        git(&ws, &["worktree", "add", "-q", "-b", "card", &s(&wt), "origin/main"]);
        let base = git(&ws, &["rev-parse", "origin/main"]);
        commit(&wt, "card.txt");
        Fixture { _tmp: tmp, ws, other, wt, base }
    }

    fn files(f: &Fixture, base: &str) -> Vec<String> {
        git(&f.wt, &["diff", "--name-only", &format!("{base}...card")])
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// (1) Upstream merged into the card: the base advances (GH #191).
    #[test]
    fn upstream_merged_into_the_card_advances_the_base() {
        let f = fixture();
        commit(&f.other, "up-1.txt");
        commit(&f.other, "up-2.txt");
        git(&f.other, &["push", "-q", "origin", "main"]);
        crate::worktrees::fetch_origin_branch(&f.ws, "main").unwrap();
        git(&f.wt, &["merge", "-q", "--no-edit", "origin/main"]);
        let upstream = git(&f.ws, &["rev-parse", "origin/main"]);

        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got, DiffBase { commit: upstream.clone(), note: None });
        assert_eq!(files(&f, &got.commit), ["card.txt"]);
        // The informational path follows the answer origin just gave.
        let info = informational(&f.wt, "HEAD", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(info.commit, upstream);
    }

    /// (2) The Builder fast-forwards local main to its own head: not used,
    /// the diff keeps the card's file, and the record says why.
    #[test]
    fn local_target_moved_onto_the_card_head_is_rejected() {
        let f = fixture();
        let head = git(&f.wt, &["rev-parse", "HEAD"]);
        git(&f.wt, &["update-ref", "refs/heads/main", &head]);
        let before = crate::worktrees::card_diff_base_local(&f.ws, "card", Some(f.base.as_str()), "main");
        assert_eq!(before.as_deref(), Some(head.as_str()), "the local pick is the head: empty diff");

        for rec in [Some(f.base.as_str()), None] {
            let got = verified(&f.ws, "card", rec, "main").unwrap();
            assert_eq!(got.commit, f.base);
            assert_eq!(files(&f, &got.commit), ["card.txt"]);
            let note = got.note.unwrap();
            assert!(note.starts_with("Local main was ahead of origin; reviewed from"), "{note}");
            let info = informational(&f.wt, "HEAD", rec, "main").unwrap();
            assert_eq!(info.commit, f.base, "informational never shows fewer files");
        }
    }

    /// (3) The Builder rewrites this clone's origin/main: ls-remote says
    /// otherwise, so it is rejected.
    #[test]
    fn rewritten_remote_tracking_ref_is_rejected() {
        let f = fixture();
        let head = git(&f.wt, &["rev-parse", "HEAD"]);
        git(&f.wt, &["update-ref", "refs/remotes/origin/main", &head]);
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got.commit, f.base);
        assert_eq!(files(&f, &got.commit), ["card.txt"]);
        assert!(got.note.unwrap().starts_with("This clone's origin/main pointed past origin's real main"));
        // A legitimate push to origin of the card is then real, and accepted.
        git(&f.wt, &["push", "-q", "origin", "card:main"]);
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        // ...but the range is then empty, and the note says why.
        assert_eq!(got.commit, head);
        assert_eq!(got.note.as_deref(), Some("This card's commits are already in origin's main."));
    }

    /// (4) No origin remote: the recorded base, said so.
    #[test]
    fn no_remote_uses_the_recorded_base() {
        let f = fixture();
        git(&f.ws, &["remote", "remove", "origin"]);
        let head = git(&f.wt, &["rev-parse", "HEAD"]);
        git(&f.wt, &["update-ref", "refs/heads/main", &head]);
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got.commit, f.base);
        assert_eq!(got.note.as_deref(), Some("Review base: the recorded base (there is no origin remote)."));
        // No recorded base either (an old card): the local computation, said so.
        let old = verified(&f.ws, "card", None::<&str>, "main").unwrap();
        assert_eq!(old.commit, head);
        assert!(old.note.unwrap().contains("this card has no recorded base"));
    }

    /// (5) ls-remote fails: the recorded base, said so; the failure is
    /// remembered, so the hot paths don't retry it on every poll.
    #[test]
    fn unreachable_origin_uses_the_recorded_base() {
        let f = fixture();
        let gone = f.ws.parent().unwrap().join("missing.git");
        git(&f.ws, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
        let head = git(&f.wt, &["rev-parse", "HEAD"]);
        git(&f.wt, &["update-ref", "refs/heads/main", &head]);
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got.commit, f.base);
        assert_eq!(got.note.as_deref(), Some("Review base: the recorded base (origin could not be reached)."));
        assert_eq!(informational(&f.wt, "HEAD", Some(f.base.as_str()), "main").unwrap().commit, f.base);
        let url = origin_url(&f.ws).unwrap();
        let c = cached(&(url, "main".into())).unwrap();
        assert!(matches!(c.tip, RemoteTip::Unreachable(_)) && c.fresh);
        assert!(reusable(&c), "a fresh failure is reused for a short while");
    }

    /// Informational with nothing asked yet uses the recorded base, and the
    /// background ask then lets it advance.
    #[test]
    fn informational_without_an_answer_uses_the_recorded_base() {
        let f = fixture();
        commit(&f.other, "up.txt");
        git(&f.other, &["push", "-q", "origin", "main"]);
        git(&f.ws, &["fetch", "-q", "origin"]);
        git(&f.wt, &["merge", "-q", "--no-edit", "origin/main"]);
        let upstream = git(&f.ws, &["rev-parse", "origin/main"]);
        let first = informational(&f.wt, "HEAD", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(first.commit, f.base);
        assert!(first.note.unwrap().contains("origin has not been asked yet"));
        let url = origin_url(&f.ws).unwrap();
        let key = (url, "main".to_string());
        let deadline = Instant::now() + Duration::from_secs(20);
        while cached(&key).is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(informational(&f.wt, "HEAD", Some(f.base.as_str()), "main").unwrap().commit, upstream);
    }

    /// P2-1: upstream merged into the card, then a later push this clone
    /// never fetched: the verified path fetches the tip origin named (into
    /// `refs/ply/tip/main` only) and the base still advances.
    #[test]
    fn an_unfetched_remote_tip_is_fetched_and_the_base_advances() {
        let f = fixture();
        commit(&f.other, "up-1.txt");
        git(&f.other, &["push", "-q", "origin", "main"]);
        git(&f.ws, &["fetch", "-q", "origin"]);
        git(&f.wt, &["merge", "-q", "--no-edit", "origin/main"]);
        let merged_up = git(&f.ws, &["rev-parse", "origin/main"]);
        let later = commit(&f.other, "up-2.txt");
        git(&f.other, &["push", "-q", "origin", "main"]);
        assert!(resolve_commit(&f.ws, &later).is_none(), "not fetched here");

        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got, DiffBase { commit: merged_up.clone(), note: None });
        assert_eq!(files(&f, &got.commit), ["card.txt"]);
        assert_eq!(git(&f.ws, &["rev-parse", "refs/ply/tip/main"]), later);
        assert_eq!(git(&f.ws, &["rev-parse", "origin/main"]), merged_up, "remote-tracking ref untouched");
    }

    /// A remembered failure is reused for [`FAILURE_REUSE`] (a batch over
    /// an unreachable origin pays the bound once), then asked again.
    #[test]
    fn a_remembered_failure_is_reused_briefly_then_asked_again() {
        let f = fixture();
        let origin = f.ws.parent().unwrap().join("origin.git");
        let away = f.ws.parent().unwrap().join("origin-away.git");
        fs::rename(&origin, &away).unwrap();
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert!(got.note.unwrap().contains("origin could not be reached"));
        fs::rename(&away, &origin).unwrap();
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert!(got.note.unwrap().contains("origin could not be reached"), "reused");
        let key = (origin_url(&f.ws).unwrap(), "main".to_string());
        if let Some(e) = TIPS.lock().unwrap().get_mut(&key) {
            e.asked_at = Instant::now().checked_sub(FAILURE_REUSE + Duration::from_secs(1)).unwrap();
        }
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got, DiffBase { commit: f.base.clone(), note: None });
    }

    /// P3-1: a card with no commits of its own (head at its recorded base)
    /// gets no "already in origin" note.
    #[test]
    fn a_card_without_commits_is_not_already_in_origin() {
        let f = fixture();
        let got = verified(&f.ws, "origin/main", Some(f.base.as_str()), "main").unwrap();
        assert_eq!(got, DiffBase { commit: f.base.clone(), note: None });
    }

    /// Only a network origin, and the one the card started with, can vouch
    /// for a tip: GitHub pinned by `owner/name` (any case), another host by
    /// its URL, a local path never; a card that recorded nothing is compared
    /// with the workspace's configured GitHub repo.
    #[test]
    fn origin_must_be_a_network_remote_and_unchanged() {
        let none = Vec::<String>::new;
        let rec = |origin: Option<&'static str>, origin_url: Option<&'static str>| Recorded {
            commit: None,
            origin,
            origin_url,
            merged: None,
        };
        ANY_ORIGIN.with(|any| any.set(false));
        let gh = "https://github.com/Acme/App.git";
        assert_eq!(check_origin(gh, &rec(Some("acme/app"), None), none), Ok(()));
        assert!(check_origin(gh, &rec(Some("fork/app"), None), none).unwrap_err().contains("origin changed"));
        assert!(check_origin(gh, &rec(None, Some("https://gitlab.com/a/b.git")), none).is_err());
        // A legacy card: the workspace's configured repo decides.
        assert_eq!(check_origin(gh, &rec(None, None), none), Ok(()));
        assert_eq!(check_origin(gh, &rec(None, None), || vec!["acme/app".into()]), Ok(()));
        assert!(check_origin(gh, &rec(None, None), || vec!["acme/other".into()])
            .unwrap_err()
            .contains("not this workspace's GitHub repository acme/other"));
        // Another host: verified while the URL is the recorded one.
        let gl = "git@gitlab.com:acme/app.git";
        assert_eq!(check_origin(gl, &rec(None, Some(gl)), none), Ok(()));
        assert!(check_origin(gl, &rec(None, Some("git@gitlab.com:fork/app.git")), none).is_err());
        assert!(check_origin(gl, &rec(None, None), none).unwrap_err().contains("recorded no origin URL"));
        assert!(check_origin(gl, &rec(Some("acme/app"), None), none).is_err());
        // Never a local path.
        for local in ["/tmp/origin.git", "file:///tmp/o.git", "C:\\repos\\o.git", "../o.git", "o.git"] {
            assert_eq!(check_origin(local, &rec(None, Some(local)), none), Err("origin is a local path".into()), "{local}");
        }
        assert_eq!(classify("https://gitlab.example.com/a/b.git"), OriginKind::Other("https://gitlab.example.com/a/b.git".into()));
        assert_eq!(classify("git@github.com:acme/app.git"), OriginKind::GitHub("acme/app".into()));
        // Credentials in an HTTPS URL are never stored nor compared.
        let token = "https://ci-bot:glpat-SECRET@gitlab.com/acme/app.git";
        assert_eq!(strip_userinfo(token), "https://gitlab.com/acme/app.git");
        assert_eq!(strip_userinfo("https://user@host.example/a.git?x=1"), "https://host.example/a.git?x=1");
        assert_eq!(strip_userinfo("git@gitlab.com:acme/app.git"), "git@gitlab.com:acme/app.git");
        assert_eq!(check_origin(token, &rec(None, Some("https://gitlab.com/acme/app.git")), none), Ok(()));
        assert_eq!(check_origin("https://gitlab.com/acme/app.git", &rec(None, Some(token)), none), Ok(()));
        // A monorepo: the workspace is a subfolder of the checkout.
        let slugs: HashMap<PathBuf, String> = [
            (PathBuf::from("/code/mono/apps/web"), "acme/mono".to_string()),
            (PathBuf::from("/code/other"), "acme/other".to_string()),
            (PathBuf::from("/code/mono-two"), "acme/two".to_string()),
        ]
        .into_iter()
        .collect();
        assert_eq!(slugs_for_checkout(Path::new("/code/mono"), &slugs), ["acme/mono"]);
        assert_eq!(slugs_for_checkout(Path::new("/code/other"), &slugs), ["acme/other"]);
        assert!(slugs_for_checkout(Path::new("/code/none"), &slugs).is_empty());
        ANY_ORIGIN.with(|any| any.set(true));

        // What a new card records (no network: only the URL is read).
        let f = fixture();
        let repo = |name: &str, url: &str| {
            let dir = f.ws.parent().unwrap().join(name);
            fs::create_dir(&dir).unwrap();
            git(&dir, &["init", "-q"]);
            git(&dir, &["remote", "add", "origin", url]);
            dir
        };
        assert_eq!(origin_record_of(&repo("gh", gh)), (Some("Acme/App".into()), None));
        assert_eq!(origin_record_of(&repo("gl", gl)), (None, Some(gl.to_string())));
        assert_eq!(
            origin_record_of(&repo("gl-token", "https://ci-bot:glpat-SECRET@gitlab.com/acme/app.git")),
            (None, Some("https://gitlab.com/acme/app.git".to_string())),
            "credentials never reach the card"
        );
        assert_eq!(origin_record_of(&f.ws), (None, None), "a local-path origin records nothing");
        // A card's base from before the fields loads without them and
        // re-saves without them.
        let legacy = r#"{"commit":"abc","refName":"origin/main","source":"origin"}"#;
        let base: crate::worktrees::WorktreeBase = serde_json::from_str(legacy).unwrap();
        assert_eq!((base.origin_slug.as_deref(), base.origin_url.as_deref()), (None, None));
        let json = serde_json::to_string(&base).unwrap();
        assert!(!json.contains("originSlug") && !json.contains("originUrl"), "{json}");

        // End to end: repointed since the card started → the recorded base.
        let head = git(&f.wt, &["rev-parse", "HEAD"]);
        git(&f.wt, &["update-ref", "refs/heads/main", &head]);
        let moved = Recorded { commit: Some(f.base.as_str()), origin: Some("acme/app"), origin_url: None, merged: None };
        let got = verified(&f.ws, "card", moved, "main").unwrap();
        assert_eq!(got.commit, f.base);
        assert!(got.note.unwrap().contains("origin changed since the card started, from acme/app"));
        // Production rule: the fixture's local-path origin is never trusted.
        ANY_ORIGIN.with(|any| any.set(false));
        let got = verified(&f.ws, "card", Some(f.base.as_str()), "main").unwrap();
        ANY_ORIGIN.with(|any| any.set(true));
        assert_eq!(got.commit, f.base);
        assert_eq!(got.note.as_deref(), Some("Review base: the recorded base (origin is a local path)."));
    }
}
