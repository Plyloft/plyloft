//! 1.174.0 (DR1, D1(b)): what a release of one area carries — read before
//! the person presses anything. A release is everything on the branch the
//! area's cards go to (`cardsGo`, e.g. main) since the area's last tag
//! (`<prefix>vX.Y.Z`), counted in the area's folder, plus the cards ready
//! but not there yet that the person ticks (release.html states 1–4, 10).
//!
//! `release_scope(workspace_id, area_id)` reads one area; `release_scopes
//! (workspace_id)` reads every area of the workspace with one fetch (How
//! this goes live, DR5). Both are async (git and a fetch, B4's guard).
//!
//! - On a project whose `origin` is GitHub, GitHub's target is fetched
//!   (`git fetch`, and the areas' release tags, never forced): the release
//!   pull request is built from `origin/<target>`, so that is what is
//!   counted. Elsewhere this computer's target branch is. Fetches are
//!   shared per (repository, target) for [`FETCH_TTL`]: calls at the same
//!   time wait on the same fetch.
//! - `git log --first-parent <tag>..<target> -- <folder> [:!other areas]`
//!   (the whole target without a tag). The root area is the whole
//!   repository except the other areas' folders and `.atelier`; an area
//!   leaves out an area folder nested in its own. Without areas the folder
//!   is the workspace's (git's prefix; the whole repository at its root,
//!   less `.atelier`). On Windows the folders match whatever their case
//!   (`:(icase)`), and `\` reads as `/`.
//! - Each commit is tied to a card, in this order: a commit the card's
//!   `ship_history`/`commit_sha` or its pull request's merge commit names;
//!   the card's pull request number ("… (#382)" of a squash, "Merge pull
//!   request #382" of a merge); a `Card:` trailer. A rebase merge's earlier
//!   commits go with the card whose merge commit follows them when GitHub
//!   wrote them in the same second — only for a card whose pull request
//!   merges by rebase (or isn't known), and never over a commit with a pull
//!   request number of its own or another card's trailer. Anything else is
//!   an "other change" (its title, its pull request number if it has one,
//!   its author). Release commits (`chore(release): …`, merges of release
//!   pull requests) and Plyloft's shared-config commits (`chore(config): …`,
//!   merges of `atelier/config-…`, `Settings: … (#N)` squashes) that touch
//!   only the shared-config files (`shared_config::check_path`) are never a
//!   change; one that also touches anything else counts.
//! - `cardsTotal`/`otherTotal` count everything; `otherChanges` holds at
//!   most [`OTHER_CHANGES_MAX`] and `cards` at most [`CARDS_MAX`], the
//!   newest of each.
//! - This computer's target against GitHub's (`local_ahead`,
//!   `local_behind`, `diverged`), for "On this Mac only".
//! - The ready cards of the area (`ship::pending_ship_cards`' B4 groups).
//! - The version choices (owner, 2026-10-31): patch first, from the later of
//!   the version file (on GitHub when it releases through a pull request)
//!   and the last tag; the file's own version after it when it is ahead of
//!   the tag; minor, major. An area never released offers its file's
//!   version as it is, then 0.1.0; with no version file, 0.1.0 first. When
//!   the default's tag exists, the next free patch comes first.
//! - `refusal` (held areas, an area without its own version file, a
//!   workspace not set up, no target branch), `in_flight` (a release of the
//!   area already recorded on this computer), `count_problem` (git couldn't
//!   count), `partial` (a shallow clone: the counts may be short; Plyloft
//!   never deepens it).
//!
//! `Err` only for a workspace that isn't there, a folder that isn't in a
//! git repository or a worker that failed: raw text, which DR3/DR5 map to
//! their own words (never shown as it is).
//!
//! Known gap (for DR3): an area whose folder was renamed since its last tag
//! is counted in its new folder only; changes made in the old one since the
//! tag aren't counted (no record of the old path exists to follow).
//!
//! Nothing here writes to GitHub; nothing persisted.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::areas::AreaDef;
use crate::kanban::KanbanCard;
use crate::release_record::{PendingRelease, PrReleaseStep};
use crate::ship::ShipArea;

/// How long a fetch of GitHub's target is shared by the reads after it.
pub const FETCH_TTL: Duration = Duration::from_secs(30);

/// At most this many other changes are listed (the newest); `other_total`
/// counts them all.
pub const OTHER_CHANGES_MAX: usize = 100;

/// At most this many cards are listed (the newest); `cards_total` counts
/// them all.
pub const CARDS_MAX: usize = 100;

/// What one release of an area would carry (`releaseScope`).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseScope {
    pub workspace_id: String,
    /// The area's id and name; `None` without areas.
    pub area: Option<String>,
    pub name: Option<String>,
    /// Its tags' prefix: "" is `vX.Y.Z`.
    pub tag_prefix: String,
    /// Where its cards go ("main").
    pub target_branch: String,
    /// `origin` is GitHub: the release goes through a pull request, and the
    /// counts are of GitHub's target (just fetched).
    pub through_github: bool,
    /// The commit counted to (GitHub's target, or this computer's).
    pub head: Option<String>,
    /// GitHub couldn't be read just now: the counts are of what this
    /// computer last fetched. Words.
    pub fetch_problem: Option<String>,
    /// git couldn't count what changed. Words.
    pub count_problem: Option<String>,
    /// The project folder is a shallow clone: the counts may be short.
    pub partial: bool,
    /// The folder counted, from the repository root ("site"); "" for the
    /// root area (or a workspace at the root without areas).
    pub folder: Option<String>,
    /// The last release (`site-v3.0.1`), never an `-unverified` tag; `None`
    /// before the first.
    pub since_tag: Option<String>,
    /// When that tag's commit was made, Unix ms.
    pub since_at: Option<i64>,
    /// The newest cards on the target since then (at most [`CARDS_MAX`]),
    /// oldest first.
    pub cards: Vec<ScopeCard>,
    pub cards_total: usize,
    /// The newest other changes since then (at most
    /// [`OTHER_CHANGES_MAX`]), oldest first.
    pub other_changes: Vec<OtherChange>,
    pub other_total: usize,
    /// The area's cards ready to ship but not on the target yet.
    pub ready_card_ids: Vec<String>,
    /// This computer's target against GitHub's, in commits (`None`: not
    /// known — no GitHub, or no such branch here).
    pub local_ahead: Option<u32>,
    pub local_behind: Option<u32>,
    /// Both moved on: "On this Mac only" can't bring it up by itself.
    pub diverged: bool,
    /// The version the next one follows, and where it was read: a version
    /// file's path, `"tag"`, or `None` (0.0.0).
    pub current_version: String,
    pub version_source: Option<String>,
    /// What the version file says (at the counted target) and the last
    /// tag's version, each `None` when there is none.
    pub file_version: Option<String>,
    pub tag_version: Option<String>,
    /// `current_version` was read from GitHub's target.
    pub version_on_github: bool,
    /// The choices, the default first.
    pub versions: Vec<VersionChoice>,
    /// Why this area can't be released, in words.
    pub refusal: Option<String>,
    /// A release of this area already on its way.
    pub in_flight: Option<InFlightRelease>,
    /// A release or land of this workspace runs right now.
    pub busy: bool,
}

/// A card on the target since the last release.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScopeCard {
    pub card_id: String,
    pub title: String,
    pub pr_number: Option<u64>,
    /// When its last commit reached the target, Unix ms.
    pub at: i64,
    /// Its commits on the target, oldest first.
    pub commits: Vec<String>,
}

/// A change on the target that no card made.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtherChange {
    pub sha: String,
    pub title: String,
    pub pr_number: Option<u64>,
    pub author: String,
    /// Unix ms.
    pub at: i64,
    /// A merge's second parent, whose author is the pull request's.
    #[serde(skip)]
    pub(crate) second_parent: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VersionKind {
    /// Fixes and small changes.
    Patch,
    /// Something new.
    Minor,
    /// A change that breaks something people rely on.
    Major,
    /// What the version file says now (a first release, or a file ahead of
    /// the last tag).
    AsIs,
    /// 0.1.0, a first version that isn't final yet.
    First,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionChoice {
    pub kind: VersionKind,
    pub version: String,
    pub tag: String,
    /// The tag already exists here (GitHub's were just fetched), or (G2
    /// walk) a release of it is on its way on GitHub (`on_its_way`).
    pub taken: bool,
    /// G2 walk (Mac): GitHub already has this version's release branch
    /// (`plyloft/release-…`): a release of it is on its way there.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub on_its_way: bool,
}

/// The area's release this computer has recorded and not finished.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InFlightRelease {
    pub tag: String,
    pub version: String,
    pub pr_number: Option<u64>,
    pub pr_url: Option<String>,
    /// How far a release through a pull request got; `None` for one made
    /// on the target branch here.
    pub step: Option<PrReleaseStep>,
    pub problem: Option<String>,
}

/// One commit of the target, as `git log` printed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Commit {
    pub sha: String,
    /// Its parents' shas, the first parent first.
    pub parents: Vec<String>,
    pub author: String,
    pub subject: String,
    pub body: String,
    /// Committer's name and email, and time (s): a rebase merge's commits
    /// share them.
    pub committer: String,
    pub committed_at: i64,
}

// ── Folders ────────────────────────────────────────────────────────────

/// Plyloft's shared state, left out of the root's count (owner, 2026-10-31).
const SHARED_FOLDER: &str = ".atelier";

/// The pathspecs for a `git … --` run at the repository root: literal
/// paths, from the top, `icase` on Windows. `folders` is the folder and the
/// folders it leaves out (`areas::area_folders`, or the workspace's folder
/// without areas); the workspace's `.atelier` (`<prefix>/.atelier`) is left
/// out too wherever the folder holds it.
pub(crate) fn pathspecs(folders: &(String, Vec<String>), workspace_prefix: &str, icase: bool) -> Vec<String> {
    let (own, others) = folders;
    let magic = |extra: &str| {
        let mut words = vec!["top", "literal"];
        if icase {
            words.push("icase");
        }
        if !extra.is_empty() {
            words.push(extra);
        }
        format!(":({})", words.join(","))
    };
    let mut specs = vec![if own.is_empty() { ":/".to_string() } else { format!("{}{own}", magic("")) }];
    specs.extend(others.iter().map(|other| format!("{}{other}", magic("exclude"))));
    let shared = crate::areas::normalize_path(&format!("{workspace_prefix}/{SHARED_FOLDER}"));
    let key = |p: &str| if icase { p.to_lowercase() } else { p.to_string() };
    if crate::areas::path_in(&key(own), &key(&shared)) {
        specs.push(format!("{}{shared}", magic("exclude")));
    }
    specs
}

/// What a scope counts: the area's folders, or without areas the
/// workspace's folder (`workspace_prefix`, "" at the root).
pub(crate) fn scope_folders(
    areas: &[AreaDef],
    area_id: Option<&str>,
    workspace_prefix: &str,
    icase: bool,
) -> (String, Vec<String>) {
    crate::areas::area_folders(areas, area_id, icase)
        .unwrap_or_else(|| (crate::areas::normalize_path(workspace_prefix), Vec::new()))
}

// ── git ────────────────────────────────────────────────────────────────

fn git_out(repo: &Path, args: &[&str]) -> Option<String> {
    let out = crate::platform::git_command().args(args).current_dir(repo).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

fn resolve(repo: &Path, rev: &str) -> Option<String> {
    git_out(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

/// `git log --first-parent` of `since..rev` (all of `rev` without one),
/// newest first.
pub(crate) fn first_parent_log(repo: &Path, since: Option<&str>, rev: &str, specs: &[String]) -> Result<Vec<Commit>, String> {
    let range = match since {
        Some(tag) => format!("refs/tags/{tag}..{rev}"),
        None => rev.to_string(),
    };
    let format = "--format=%H%x1f%P%x1f%an%x1f%cn <%ce>%x1f%ct%x1f%s%x1f%b%x1e";
    let mut args: Vec<&str> = vec!["log", "--first-parent", "--no-color", format, &range, "--"];
    args.extend(specs.iter().map(String::as_str));
    let out = crate::platform::git_command()
        .args(&args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git log: {e}"))?;
    if !out.status.success() {
        return Err(format!("git log: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(parse_log(&String::from_utf8_lossy(&out.stdout)))
}

pub(crate) fn parse_log(text: &str) -> Vec<Commit> {
    text.split(RECORD)
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            let mut f = record.splitn(7, FIELD);
            let sha = f.next()?.trim().to_string();
            if sha.is_empty() {
                return None;
            }
            let parents = f.next()?.split_whitespace().map(str::to_string).collect();
            let author = f.next()?.to_string();
            let committer = f.next()?.to_string();
            let committed_at = f.next()?.trim().parse().unwrap_or(0);
            let subject = f.next()?.to_string();
            let body = f.next().unwrap_or("").trim().to_string();
            Some(Commit { sha, parents, author, subject, body, committer, committed_at })
        })
        .collect()
}

/// The authors of `shas`, in one `git log --no-walk=unsorted --stdin`.
fn authors_of(repo: &Path, shas: &[String]) -> HashMap<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    if shas.is_empty() {
        return HashMap::new();
    }
    let child = crate::platform::git_command()
        .args(["log", "--no-walk=unsorted", "--stdin", "--format=%H%x1f%an"])
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return HashMap::new() };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n", shas.join("\n")).as_bytes());
    }
    let Ok(out) = child.wait_with_output() else { return HashMap::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once(FIELD))
        .map(|(sha, name)| (sha.trim().to_string(), name.trim().to_string()))
        .filter(|(_, name)| !name.is_empty())
        .collect()
}

/// The files a commit changed against its first parent.
fn files_of(repo: &Path, c: &Commit) -> Option<Vec<String>> {
    let parent = c.parents.first()?;
    let out = git_out(repo, &["diff-tree", "-r", "--name-only", "--no-renames", "-z", parent, &c.sha])?;
    Some(out.split('\0').filter(|f| !f.is_empty()).map(str::to_string).collect())
}

/// `(ahead, behind)` of `local` against `remote`, in commits.
fn ahead_behind(repo: &Path, local: &str, remote: &str) -> Option<(u32, u32)> {
    let out = git_out(repo, &["rev-list", "--left-right", "--count", &format!("{local}...{remote}")])?;
    let mut it = out.split_whitespace().map(|n| n.parse::<u32>().ok());
    Some((it.next()??, it.next()??))
}

fn tag_exists(repo: &Path, tag: &str) -> bool {
    resolve(repo, &format!("refs/tags/{tag}")).is_some()
}

fn is_shallow(repo: &Path) -> bool {
    git_out(repo, &["rev-parse", "--is-shallow-repository"]).is_some_and(|s| s.trim() == "true")
}

// ── Shared fetches ─────────────────────────────────────────────────────

type FetchSlot = Arc<Mutex<Option<(Instant, Result<(), String>)>>>;

static FETCHES: Mutex<Option<HashMap<String, FetchSlot>>> = Mutex::new(None);

/// A failed fetch is shared this long at most: GitHub may be back soon.
pub const FAILED_FETCH_TTL: Duration = Duration::from_secs(5);

/// A fetch's answer is still good after `elapsed`: `ttl`, or at most
/// [`FAILED_FETCH_TTL`] for a failure.
pub(crate) fn still_fresh(elapsed: Duration, ok: bool, ttl: Duration) -> bool {
    elapsed < if ok { ttl } else { ttl.min(FAILED_FETCH_TTL) }
}

/// `fetch` once per `key` within `ttl` ([`still_fresh`]): a call while
/// another runs waits on it and takes its answer; a call within `ttl` after
/// it takes the answer too. `ttl` zero always fetches (the tests' default).
pub(crate) fn shared_fetch(key: &str, ttl: Duration, fetch: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let slot = {
        let mut map = FETCHES.lock().unwrap_or_else(|p| p.into_inner());
        map.get_or_insert_with(HashMap::new).entry(key.to_string()).or_default().clone()
    };
    let mut last = slot.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, answer)) = last.as_ref() {
        if still_fresh(at.elapsed(), answer.is_ok(), ttl) {
            return answer.clone();
        }
    }
    let answer = fetch();
    *last = Some((Instant::now(), answer.clone()));
    answer
}

type BranchesSlot = Arc<Mutex<Option<(Instant, Result<std::collections::HashSet<String>, String>)>>>;

static RELEASE_BRANCHES: Mutex<Option<HashMap<String, BranchesSlot>>> = Mutex::new(None);

/// G2 walk (Mac) round 1: the release branches GitHub has
/// (`plyloft/release-*`), one `git ls-remote` per repository within `ttl`
/// ([`still_fresh`], key `ls-remote:<repo>`) — shared by every area of a
/// `release_scopes` read. None asked (empty) when `ask` is false: not a
/// GitHub project, or its target couldn't be fetched.
/// Windows G2 walk: forget the repository's listed release branches
/// (`announce_record` calls it on any change of a release record: a press,
/// a stop, a dismiss), so the next scope asks GitHub again.
pub(crate) fn forget_release_branches(repo: &Path) {
    if let Some(map) = RELEASE_BRANCHES.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        map.remove(&format!("ls-remote:{}", repo.display()));
    }
}

pub(crate) fn release_branches_on_github(
    repo: &Path,
    ask: bool,
    ttl: Duration,
    list: impl FnOnce() -> Result<std::collections::HashSet<String>, String>,
) -> std::collections::HashSet<String> {
    if !ask {
        return Default::default();
    }
    let key = format!("ls-remote:{}", repo.display());
    let slot = {
        let mut map = RELEASE_BRANCHES.lock().unwrap_or_else(|p| p.into_inner());
        map.get_or_insert_with(HashMap::new).entry(key).or_default().clone()
    };
    let mut last = slot.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, answer)) = last.as_ref() {
        if still_fresh(at.elapsed(), answer.is_ok(), ttl) {
            return answer.clone().unwrap_or_default();
        }
    }
    let answer = list();
    *last = Some((Instant::now(), answer.clone()));
    answer.unwrap_or_default()
}

/// A target GitHub couldn't be read for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fetched {
    /// GitHub has no such branch: the no-target refusal, no fetch problem.
    Missing,
    /// Anything else (offline, sign-in): the fetch problem's words.
    Problem(String),
}

/// GitHub's `targets` and the `prefixes`' tags, shared as [`shared_fetch`]
/// says. What went wrong, per target that couldn't be fetched
/// (`shared_config::classify_fetch_error`).
pub(crate) fn fetch_github(repo: &Path, targets: &[String], prefixes: &[String], ttl: Duration) -> HashMap<String, Fetched> {
    let mut problems = HashMap::new();
    for target in targets {
        let key = format!("branch\0{}\0{target}", repo.display());
        if let Err(e) = shared_fetch(&key, ttl, || crate::worktrees::fetch_origin_branch(repo, target)) {
            log::info!("release_scope: fetch of {target} failed: {e}");
            let failure = match crate::shared_config::classify_fetch_error(target, &e) {
                crate::shared_config::FetchFailure::BranchMissing { .. } => Fetched::Missing,
                _ => Fetched::Problem(fetch_problem_words(target)),
            };
            problems.insert(target.clone(), failure);
        }
    }
    if problems.len() < targets.len() {
        let mut sorted = prefixes.to_vec();
        sorted.sort();
        sorted.dedup();
        let key = format!("tags\0{}\0{}", repo.display(), sorted.join("\0"));
        if let Err(e) = shared_fetch(&key, ttl, || crate::worktrees::fetch_origin_release_tags(repo, &sorted)) {
            log::info!("release_scope: some release tags weren't fetched: {e}");
        }
    }
    problems
}

// ── Commits to cards ───────────────────────────────────────────────────

/// "… (#382)" at the end of a squash merge's subject.
pub(crate) fn squash_number(subject: &str) -> Option<u64> {
    let inner = subject.trim_end().strip_suffix(')')?;
    let start = inner.rfind("(#")?;
    inner[start + 2..].parse().ok()
}

/// "Merge pull request #382 from owner/branch": the number and the branch.
pub(crate) fn merge_pr(subject: &str) -> Option<(u64, String)> {
    let rest = subject.strip_prefix("Merge pull request #")?;
    let (number, from) = rest.split_once(' ')?;
    let branch = from.strip_prefix("from ").unwrap_or("").trim().to_string();
    Some((number.parse().ok()?, branch))
}

/// The branch of a merge's "owner/branch", without the owner.
fn merged_branch(subject: &str) -> Option<String> {
    let (_, from) = merge_pr(subject)?;
    Some(from.split_once('/').map(|(_, b)| b.to_string()).unwrap_or(from))
}

/// A release's own commit, or the merge of a release pull request.
pub(crate) fn is_release_commit(c: &Commit) -> bool {
    c.subject.starts_with("chore(release): ")
        || merged_branch(&c.subject).is_some_and(|b| b.starts_with(crate::ship::release_pr::BRANCH_PREFIX))
}

/// Shaped like the shared-config channel's commits (`shared_config.rs`):
/// `chore(config): …`, the merge of an `atelier/config-…` branch, or a
/// `Settings: … (#N)` squash of its pull request.
pub(crate) fn is_config_shaped(c: &Commit) -> bool {
    c.subject.starts_with("chore(config): ")
        || merged_branch(&c.subject).is_some_and(|b| b.starts_with("atelier/config-"))
        || (c.subject.starts_with("Settings: ") && squash_number(&c.subject).is_some())
}

/// A shared-config commit that touches only the shared-config files: never
/// a change of a release. `files`: what it changed, from the repository
/// root (`None`: unknown, kept); the channel's paths are from the
/// workspace's folder (`workspace_prefix`), so a file outside it is never
/// a config file.
pub(crate) fn is_config_only(c: &Commit, files: Option<&[String]>, workspace_prefix: &str) -> bool {
    let prefix = crate::areas::normalize_path(workspace_prefix);
    let in_workspace = |p: &str| -> Option<String> {
        if prefix.is_empty() {
            return Some(p.to_string());
        }
        p.strip_prefix(&format!("{prefix}/")).map(str::to_string)
    };
    is_config_shaped(c)
        && files.is_some_and(|f| {
            !f.is_empty()
                && f.iter().all(|p| in_workspace(p).is_some_and(|rel| crate::shared_config::check_path(&rel).is_ok()))
        })
}

fn trailer_cards(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|l| l.trim().strip_prefix("Card: "))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

fn pr_number_of(card: &KanbanCard) -> Option<u64> {
    if card.pr_review.is_some() {
        return None; // someone else's pull request, reviewed on a card
    }
    card.pr.as_ref().map(|p| p.number).filter(|n| *n > 0).or_else(|| {
        let url = card.pr_url.as_deref()?;
        let tail = url.trim_end_matches('/').rsplit_once("/pull/")?.1;
        tail.split(['/', '#', '?']).next()?.parse().ok()
    })
}

/// Which card each commit is, by the rules of the module header; `None`
/// for an other change. `commits` newest first, as git prints them.
pub(crate) fn attribute(commits: &[Commit], cards: &[KanbanCard]) -> Vec<Option<String>> {
    use crate::merge_method::MergeMethod;
    let mut by_sha: HashMap<&str, &str> = HashMap::new();
    // The card, and whether its merge may be a rebase.
    let mut by_merge: HashMap<&str, (&str, bool)> = HashMap::new();
    let mut by_pr: HashMap<u64, &str> = HashMap::new();
    for card in cards {
        for entry in &card.ship_history {
            by_sha.insert(entry.commit_sha.as_str(), card.id.as_str());
        }
        if let Some(sha) = card.commit_sha.as_deref() {
            by_sha.insert(sha, card.id.as_str());
        }
        if card.pr_review.is_none() {
            if let Some(pr) = card.pr.as_ref() {
                if let Some(sha) = pr.merge_commit.as_deref() {
                    let rebase = matches!(pr.merge_method, None | Some(MergeMethod::Rebase));
                    by_merge.insert(sha, (card.id.as_str(), rebase));
                }
            }
        }
        if let Some(n) = pr_number_of(card) {
            by_pr.insert(n, card.id.as_str());
        }
    }
    let known = |id: &str| cards.iter().any(|c| c.id == id);
    let mut out: Vec<Option<String>> = commits
        .iter()
        .map(|c| {
            if let Some(id) = by_sha.get(c.sha.as_str()).copied().or_else(|| by_merge.get(c.sha.as_str()).map(|m| m.0)) {
                return Some(id.to_string());
            }
            let number = merge_pr(&c.subject).map(|(n, _)| n).or_else(|| squash_number(&c.subject));
            if let Some(id) = number.and_then(|n| by_pr.get(&n)) {
                return Some(id.to_string());
            }
            trailer_cards(&c.body).into_iter().find(|id| known(id))
        })
        .collect();
    // A rebase merge: the commits GitHub wrote before the card's merge
    // commit, in the same second, are that card's too — never one with a
    // pull request of its own or another card's trailer.
    for i in 0..commits.len() {
        let Some(id) = out[i].clone() else { continue };
        let merge = &commits[i];
        let rebase = by_merge.get(merge.sha.as_str()).is_some_and(|m| m.1);
        if merge.parents.len() != 1 || !rebase {
            continue;
        }
        let mut j = i + 1;
        while j < commits.len() {
            let c = &commits[j];
            let fits = out[j].is_none()
                && c.parents.len() == 1
                && c.committer == merge.committer
                && c.committed_at == merge.committed_at
                && squash_number(&c.subject).is_none()
                && merge_pr(&c.subject).is_none()
                && !trailer_cards(&c.body).iter().any(|other| *other != id && known(other));
            if !fits {
                break;
            }
            out[j] = Some(id.clone());
            j += 1;
        }
    }
    out
}

/// The commits as cards and other changes, oldest first (every other
/// change; `read` keeps the newest). A merge's author is filled in later
/// from its second parent.
pub(crate) fn split(commits: &[Commit], cards: &[KanbanCard]) -> (Vec<ScopeCard>, Vec<OtherChange>) {
    let owners = attribute(commits, cards);
    let mut scoped: Vec<ScopeCard> = Vec::new();
    let mut others: Vec<OtherChange> = Vec::new();
    for (c, owner) in commits.iter().zip(owners).rev() {
        if is_release_commit(c) {
            continue;
        }
        let at = c.committed_at * 1000;
        match owner {
            Some(id) => match scoped.iter_mut().find(|s| s.card_id == id) {
                Some(card) => {
                    card.commits.push(c.sha.clone());
                    card.at = card.at.max(at);
                }
                None => {
                    let card = cards.iter().find(|k| k.id == id);
                    scoped.push(ScopeCard {
                        title: card.map(|k| k.title.clone()).unwrap_or_default(),
                        pr_number: card.and_then(pr_number_of),
                        card_id: id,
                        at,
                        commits: vec![c.sha.clone()],
                    });
                }
            },
            None => {
                let merged = merge_pr(&c.subject);
                let title = match &merged {
                    // A merge's subject names the branch; its body's first
                    // line is the pull request's title.
                    Some(_) => c.body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(&c.subject).to_string(),
                    None => c.subject.clone(),
                };
                others.push(OtherChange {
                    sha: c.sha.clone(),
                    title,
                    second_parent: merged.as_ref().and_then(|_| c.parents.get(1).cloned()),
                    pr_number: merged.map(|(n, _)| n).or_else(|| squash_number(&c.subject)),
                    author: c.author.clone(),
                    at,
                });
            }
        }
    }
    (scoped, others)
}

// ── Versions ───────────────────────────────────────────────────────────

fn parts(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.split('-').next().unwrap_or(v);
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let parsed = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(parsed)
}

fn semver((a, b, c): (u64, u64, u64)) -> String {
    format!("{a}.{b}.{c}")
}

/// The choices of the next version, the default first. `file`: what the
/// version file says; `tag`: the last tag's version (`None`: never
/// released). See the module header for the rules.
pub(crate) fn version_choices(
    file: Option<&str>,
    tag: Option<&str>,
    prefix: &str,
    taken: impl Fn(&str) -> bool,
) -> Vec<VersionChoice> {
    let choice = |kind: VersionKind, v: (u64, u64, u64)| {
        let version = semver(v);
        let tag = crate::areas::tag_for(prefix, &version);
        VersionChoice { kind, taken: taken(&tag), version, tag, on_its_way: false }
    };
    let file = file.and_then(parts).filter(|v| *v != (0, 0, 0));
    let tag = tag.and_then(parts);
    let mut out = match tag {
        None => match file {
            // G2 walk (Mac): never a first version before the file's own —
            // it would be refused as not new; the next ones instead.
            Some(f) if f > (0, 1, 0) => vec![
                choice(VersionKind::AsIs, f),
                choice(VersionKind::Patch, (f.0, f.1, f.2 + 1)),
                choice(VersionKind::Minor, (f.0, f.1 + 1, 0)),
                choice(VersionKind::Major, (f.0 + 1, 0, 0)),
            ],
            Some(f) => vec![choice(VersionKind::AsIs, f)],
            None => vec![
                choice(VersionKind::First, (0, 1, 0)),
                choice(VersionKind::Patch, (0, 0, 1)),
                choice(VersionKind::Major, (1, 0, 0)),
            ],
        },
        Some(t) => {
            let base = file.filter(|f| *f > t).unwrap_or(t);
            let mut out = vec![choice(VersionKind::Patch, (base.0, base.1, base.2 + 1))];
            if let Some(f) = file.filter(|f| *f > t) {
                let as_is = choice(VersionKind::AsIs, f);
                if !as_is.taken {
                    out.push(as_is);
                }
            }
            out.push(choice(VersionKind::Minor, (base.0, base.1 + 1, 0)));
            out.push(choice(VersionKind::Major, (base.0 + 1, 0, 0)));
            out
        }
    };
    // The default's tag exists: the next free patch after it comes first.
    // L walk (Mac): every taken patch it skipped is listed after the taken
    // default, each with its reason, so a jump (v1.0.1 to v1.0.3) says why.
    if out.first().is_some_and(|c| c.taken) {
        if let Some(mut v) = parts(&out[0].version) {
            let mut skipped = Vec::new();
            for _ in 0..1000 {
                v.2 += 1;
                let next = choice(VersionKind::Patch, v);
                if !next.taken {
                    out.insert(0, next);
                    let at = 2.min(out.len());
                    out.splice(at..at, skipped);
                    break;
                }
                skipped.push(next);
            }
        }
    }
    let mut seen = Vec::new();
    out.retain(|c| {
        let new = !seen.contains(&c.version);
        seen.push(c.version.clone());
        new
    });
    out
}

/// The version the next release follows: the later of the version file
/// (at `rev`) and the area's last tag; with where it was read, and the
/// file's own version and path.
fn current_version(
    repo: &Path,
    config: &crate::project_config::ProjectConfig,
    rev: &str,
    last_tag_version: Option<&str>,
) -> (String, Option<String>, Option<String>) {
    let file = crate::ship::project_version_at(repo, config, rev);
    let file_version = file.as_ref().map(|(v, _)| v.clone());
    let (version, source) = match (file, last_tag_version) {
        (Some((v, _)), Some(tag)) if crate::ship::version_is_after(tag, &v) == Some(true) => {
            (tag.to_string(), Some("tag".to_string()))
        }
        (Some((v, path)), _) => (v, Some(path)),
        (None, Some(tag)) => (tag.to_string(), Some("tag".to_string())),
        (None, None) => ("0.0.0".to_string(), None),
    };
    (version, source, file_version)
}

// ── The read ───────────────────────────────────────────────────────────

/// Where and what a scope is read for (the commands gather it from the
/// stores; the tests from fixtures).
pub(crate) struct ScopePlace<'a> {
    pub workspace_id: &'a str,
    pub repo_root: &'a Path,
    pub area: &'a ShipArea,
    pub areas: &'a [AreaDef],
    /// The workspace's folder in the repository (git's prefix, "" at the
    /// root): what an implicit area counts.
    pub workspace_prefix: &'a str,
    /// `origin` is GitHub.
    pub github: bool,
    /// Folders match whatever their case (Windows).
    pub icase: bool,
    /// `Some(ttl)`: fetch GitHub here (shared within `ttl`). `None`: the
    /// caller fetched already, and `prefetch_problem` is what went wrong.
    pub fetch_ttl: Option<Duration>,
    pub prefetch_problem: Option<Fetched>,
}

/// Plyloft couldn't fetch GitHub's target (owner-approved words).
pub(crate) fn fetch_problem_words(target: &str) -> String {
    format!(
        "Plyloft couldn't read {target} on GitHub just now, so this is what {} saw of it last.",
        crate::this_machine!()
    )
}

/// The target branch isn't there to count (owner-approved words).
pub(crate) fn no_target_words(target: &str, github: bool) -> String {
    if github {
        format!("GitHub has no branch {target}, where these cards go. Nothing can be released from it yet.")
    } else {
        format!("This project has no branch {target}, where these cards go. Nothing can be released from it yet.")
    }
}

/// git couldn't count (owner-approved words): since the last tag, or
/// before a first release on the target branch.
pub(crate) fn count_problem_words(since_tag: Option<&str>, target: &str) -> String {
    match since_tag {
        Some(tag) => format!("Plyloft couldn't read what changed since {tag}. Try again in a moment."),
        None => format!("Plyloft couldn't read what changed on {target}. Try again in a moment."),
    }
}

/// The scope of `place.area`. `cards`: the workspace's Board; `ready`: the
/// area's cards a batch could ship; `record`: this workspace's recorded
/// release.
pub(crate) fn read(
    place: &ScopePlace<'_>,
    cards: &[KanbanCard],
    ready: Vec<String>,
    record: Option<PendingRelease>,
    busy: bool,
) -> ReleaseScope {
    let area = place.area;
    let target = area.config.target_branch.clone();
    let repo = place.repo_root;
    let mut scope = ReleaseScope {
        workspace_id: place.workspace_id.to_string(),
        area: area.id.clone(),
        name: area.name.clone(),
        tag_prefix: area.prefix.clone(),
        target_branch: target.clone(),
        through_github: place.github,
        ready_card_ids: ready,
        busy,
        partial: is_shallow(repo),
        ..ReleaseScope::default()
    };
    // The area's own recorded release (one per workspace).
    scope.in_flight = record
        .filter(|r| crate::ship::tag_version(&area.prefix, &r.tag).is_some())
        .filter(|r| {
            crate::ship::area_of_tag(place.areas, &target, &r.tag)
                .ok()
                .flatten()
                .is_none_or(|id| Some(id) == area.id)
        })
        .map(|r| InFlightRelease {
            pr_number: r.pr.as_ref().and_then(|p| p.number),
            pr_url: r.pr.as_ref().and_then(|p| p.url.clone()),
            step: r.pr.as_ref().map(|p| p.step),
            problem: r.pr.as_ref().and_then(|p| p.problem.clone()),
            tag: r.tag,
            version: r.version,
        });

    if place.github {
        let fetched = match place.fetch_ttl {
            Some(ttl) => {
                fetch_github(repo, std::slice::from_ref(&target), std::slice::from_ref(&area.prefix), ttl).remove(&target)
            }
            None => place.prefetch_problem.clone(),
        };
        match fetched {
            Some(Fetched::Missing) => {
                scope.refusal = Some(no_target_words(&target, true));
                return scope;
            }
            Some(Fetched::Problem(words)) => scope.fetch_problem = Some(words),
            None => {}
        }
    }
    let local_ref = format!("refs/heads/{target}");
    let remote_ref = format!("refs/remotes/origin/{target}");
    let rev = if place.github { remote_ref.clone() } else { local_ref.clone() };
    let Some(head) = resolve(repo, &rev) else {
        scope.refusal = Some(no_target_words(&target, place.github));
        return scope;
    };
    scope.head = Some(head);

    if resolve(repo, &remote_ref).is_some() && resolve(repo, &local_ref).is_some() {
        if let Some((ahead, behind)) = ahead_behind(repo, &local_ref, &remote_ref) {
            scope.local_ahead = Some(ahead);
            scope.local_behind = Some(behind);
            scope.diverged = ahead > 0 && behind > 0;
        }
    }

    let last = crate::ship::latest_release_version(repo, &area.prefix);
    scope.since_tag = last.as_deref().map(|v| crate::areas::tag_for(&area.prefix, v));
    scope.since_at = scope.since_tag.as_deref().and_then(|tag| {
        git_out(repo, &["log", "-1", "--format=%ct", &format!("refs/tags/{tag}")])
            .and_then(|s| s.trim().parse::<i64>().ok())
            .map(|s| s * 1000)
    });

    let folders = scope_folders(place.areas, area.id.as_deref(), place.workspace_prefix, place.icase);
    scope.folder = Some(folders.0.clone());
    let specs = pathspecs(&folders, place.workspace_prefix, place.icase);
    match first_parent_log(repo, scope.since_tag.as_deref(), &rev, &specs) {
        Ok(commits) => {
            let commits: Vec<Commit> = commits
                .into_iter()
                .filter(|c| !is_config_shaped(c) || !is_config_only(c, files_of(repo, c).as_deref(), place.workspace_prefix))
                .collect();
            let (scoped, mut others) = split(&commits, cards);
            let mut scoped = scoped;
            scope.cards_total = scoped.len();
            if scoped.len() > CARDS_MAX {
                scoped.drain(..scoped.len() - CARDS_MAX);
            }
            scope.other_total = others.len();
            if others.len() > OTHER_CHANGES_MAX {
                others.drain(..others.len() - OTHER_CHANGES_MAX);
            }
            let parents: Vec<String> = others.iter().filter_map(|o| o.second_parent.clone()).collect();
            let authors = authors_of(repo, &parents);
            for o in &mut others {
                if let Some(name) = o.second_parent.as_ref().and_then(|p| authors.get(p)) {
                    o.author = name.clone();
                }
            }
            scope.cards = scoped;
            scope.other_changes = others;
        }
        Err(e) => {
            log::warn!("release_scope: {e}");
            scope.count_problem = Some(count_problem_words(scope.since_tag.as_deref(), &target));
        }
    }

    let (version, source, file_version) = current_version(repo, &area.config, &rev, last.as_deref());
    scope.version_on_github = place.github && source.as_deref().is_some_and(|s| s != "tag");
    // G2 walk (Mac): a version whose release branch GitHub has already (a
    // release of it on its way, its pull request open) is taken too. Read
    // once per repository within the fetch's TTL (shared by every area), and
    // not at all when GitHub's target couldn't be fetched.
    let on_github = release_branches_on_github(
        repo,
        place.github && scope.fetch_problem.is_none(),
        place.fetch_ttl.unwrap_or(FETCH_TTL),
        || {
            crate::ship::release_pr::remote_refs(repo, &["refs/heads/plyloft/release-*"])
                .map(|m| m.into_keys().collect())
        },
    );
    let branch_there = |version: &str| {
        on_github.contains(&format!("refs/heads/{}", crate::ship::release_pr::branch_for(&area.prefix, version)))
    };
    let mut versions = version_choices(file_version.as_deref(), last.as_deref(), &area.prefix, |tag| {
        tag_exists(repo, tag)
            || crate::ship::tag_version(&area.prefix, tag).is_some_and(|v| branch_there(v))
    });
    for v in &mut versions {
        v.on_its_way = branch_there(&v.version) && !tag_exists(repo, &v.tag);
    }
    scope.versions = versions;
    scope.current_version = version;
    scope.version_source = source;
    scope.file_version = file_version;
    scope.tag_version = last;
    scope
}

/// A scope that can't be read further: `refusal` says why.
fn refused(workspace_id: &str, area: Option<String>, refusal: String) -> ReleaseScope {
    ReleaseScope { workspace_id: workspace_id.to_string(), area, refusal: Some(refusal), ..ReleaseScope::default() }
}

/// [`refused`] for an area of the list: its name, tag prefix and branch as
/// `areas::resolve` gives them (its defaults filled in), so the sheet can
/// name it.
pub(crate) fn refused_area(
    workspace_id: &str,
    areas: &[AreaDef],
    workspace_branch: &str,
    id: Option<String>,
    refusal: String,
) -> ReleaseScope {
    let mut scope = refused(workspace_id, id.clone(), refusal);
    let wanted = id.as_deref().map(str::trim);
    if let Some(area) = crate::areas::resolve(areas, workspace_branch).into_iter().find(|a| Some(a.id.as_str()) == wanted) {
        scope.name = Some(area.name);
        scope.tag_prefix = area.tag_prefix;
        scope.target_branch = area.branch;
    }
    scope
}

/// Never an empty refusal: the not-set-up words, or this sentence.
const NOT_READY_WORDS: &str = "This project isn't set up for releases yet.";

fn refusal_words(words: String) -> String {
    if words.trim().is_empty() { NOT_READY_WORDS.to_string() } else { words }
}

/// What every read of one workspace shares (read from the stores once).
struct Workspace {
    repo_root: std::path::PathBuf,
    prefix: String,
    areas: Vec<AreaDef>,
    cards: Vec<KanbanCard>,
    pending: Vec<crate::ship::PendingShipCards>,
    record: Option<PendingRelease>,
    busy: bool,
    github: bool,
    /// The workspace's integration branch (an area without its own sends
    /// its cards there).
    branch: String,
}

/// The workspace's shared reads, or the refusal for all of it.
fn workspace_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<Result<Workspace, String>, String> {
    use tauri::Manager;
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let project_config = app.state::<crate::project_config::ProjectConfigStore>();
    let kanban = app.state::<crate::kanban::KanbanStore>();
    if let Err(words) = crate::ship::load_project_config_for(workspace_id, &workspaces, &project_config) {
        return Ok(Err(refusal_words(words)));
    }
    let cwd = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.cwd)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_root = crate::ship::resolve_workspace_repo_root(&cwd)?;
    Ok(Ok(Workspace {
        branch: project_config.get(workspace_id).map(|c| c.target_branch).unwrap_or_default(),
        github: crate::ship::github_origin(&repo_root).is_some(),
        prefix: crate::areas::workspace_prefix(&cwd),
        repo_root,
        areas: crate::areas::for_workspace(&project_config, workspace_id),
        cards: kanban.load(workspace_id).unwrap_or_default(),
        pending: crate::ship::pending_ship_cards(&kanban, &[workspace_id.to_string()], &project_config),
        record: crate::ship::live_record(&project_config.workspace_dir(workspace_id), &kanban, workspace_id)
            .ok()
            .flatten(),
        busy: app.state::<crate::ship::ShipRegistry>().is_held_for(workspace_id),
    }))
}

/// The release of `area_id`, or the words that refuse it.
fn ship_area_or_words<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    area_id: Option<&str>,
) -> Result<ShipArea, String> {
    use tauri::Manager;
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let project_config = app.state::<crate::project_config::ProjectConfigStore>();
    match crate::ship::ship_area_for_id(&project_config, workspace_id, area_id) {
        Ok(Some(area)) => Ok(area),
        Ok(None) => Err(refusal_words(
            crate::ship::load_project_config_for(workspace_id, &workspaces, &project_config).err().unwrap_or_default(),
        )),
        Err(refusal) => Err(refusal_words(refusal)),
    }
}

fn read_in(ws: &Workspace, workspace_id: &str, area: &ShipArea, fetch_ttl: Option<Duration>, prefetch_problem: Option<Fetched>) -> ReleaseScope {
    let place = ScopePlace {
        workspace_id,
        repo_root: &ws.repo_root,
        area,
        areas: &ws.areas,
        workspace_prefix: &ws.prefix,
        github: ws.github,
        icase: cfg!(windows),
        fetch_ttl,
        prefetch_problem,
    };
    read(&place, &ws.cards, ready_of_area(&ws.pending, area), ws.record.clone(), ws.busy)
}

/// The scope of `area_id` in `workspace_id`, from the app's stores. `None`
/// is the workspace's (the first area's in a repository with areas).
pub(crate) fn scope_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    area_id: Option<&str>,
) -> Result<ReleaseScope, String> {
    let asked = area_id.map(str::to_string);
    // X1: GitHub's target and tags are fetched as the workspace's GitHub
    // account (OB-7b), as the release itself (`ship::release_cards`).
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let ws = match workspace_of(app, workspace_id)? {
        Ok(ws) => ws,
        Err(words) => return Ok(refused(workspace_id, asked, words)),
    };
    match ship_area_or_words(app, workspace_id, area_id) {
        Ok(area) => Ok(read_in(&ws, workspace_id, &area, Some(FETCH_TTL), None)),
        Err(words) => Ok(refused_area(workspace_id, &ws.areas, &ws.branch, asked, words)),
    }
}

/// Every area's scope, in the repository's order (one, the workspace's,
/// without areas): GitHub fetched once for every target and tag prefix,
/// the Board and the ready cards read once.
pub(crate) fn scopes_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<Vec<ReleaseScope>, String> {
    // X1: the one fetch runs as the workspace's GitHub account (OB-7b).
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let ws = match workspace_of(app, workspace_id)? {
        Ok(ws) => ws,
        Err(words) => return Ok(vec![refused(workspace_id, None, words)]),
    };
    let ids: Vec<Option<String>> =
        if ws.areas.is_empty() { vec![None] } else { ws.areas.iter().map(|a| Some(a.id.trim().to_string())).collect() };
    let releases: Vec<(Option<String>, Result<ShipArea, String>)> =
        ids.into_iter().map(|id| { let area = ship_area_or_words(app, workspace_id, id.as_deref()); (id, area) }).collect();
    Ok(scopes_in(&ws, workspace_id, releases, FETCH_TTL))
}

/// [`scopes_for_app`] once the workspace and each area's release are read.
fn scopes_in(
    ws: &Workspace,
    workspace_id: &str,
    releases: Vec<(Option<String>, Result<ShipArea, String>)>,
    ttl: Duration,
) -> Vec<ReleaseScope> {
    let mut problems = HashMap::new();
    if ws.github {
        let mut targets: Vec<String> = Vec::new();
        let mut prefixes: Vec<String> = Vec::new();
        for area in releases.iter().filter_map(|(_, a)| a.as_ref().ok()) {
            if !targets.contains(&area.config.target_branch) {
                targets.push(area.config.target_branch.clone());
            }
            prefixes.push(area.prefix.clone());
        }
        problems = fetch_github(&ws.repo_root, &targets, &prefixes, ttl);
    }
    releases
        .into_iter()
        .map(|(id, area)| match area {
            Ok(area) => {
                let problem = problems.get(&area.config.target_branch).cloned();
                read_in(ws, workspace_id, &area, None, problem)
            }
            Err(words) => refused_area(workspace_id, &ws.areas, &ws.branch, id, words),
        })
        .collect()
}

/// The ready cards of `area` in the batch list: without areas the
/// workspace's, else its own group's (never a refused group's).
pub(crate) fn ready_of_area(pending: &[crate::ship::PendingShipCards], area: &ShipArea) -> Vec<String> {
    let Some(ws) = pending.first() else {
        return Vec::new();
    };
    if ws.areas.is_empty() {
        return if area.id.is_none() { ws.card_ids.clone() } else { Vec::new() };
    }
    ws.areas
        .iter()
        .filter(|g| g.refusal.is_none() && g.area == area.id)
        .flat_map(|g| g.card_ids.clone())
        .collect()
}

/// What a release of the area would carry (`releaseScope`). On a worker:
/// it fetches GitHub's target and runs git.
#[tauri::command]
pub async fn release_scope(
    app: tauri::AppHandle,
    workspace_id: String,
    area_id: Option<String>,
) -> Result<ReleaseScope, String> {
    tauri::async_runtime::spawn_blocking(move || scope_for_app(&app, &workspace_id, area_id.as_deref()))
        .await
        .map_err(|e| format!("release scope worker failed: {e}"))?
        .map_err(crate::path_gone::mark_workspace_error)
}

/// Every area's scope (`releaseScopes`), with one fetch. On a worker.
#[tauri::command]
pub async fn release_scopes(app: tauri::AppHandle, workspace_id: String) -> Result<Vec<ReleaseScope>, String> {
    tauri::async_runtime::spawn_blocking(move || scopes_for_app(&app, &workspace_id))
        .await
        .map_err(|e| format!("release scopes worker failed: {e}"))?
        .map_err(crate::path_gone::mark_workspace_error)
}

#[cfg(test)]
#[path = "release_scope_tests.rs"]
mod tests;
