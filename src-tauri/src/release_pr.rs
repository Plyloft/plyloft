//! G8 (1.170.0): a release through a pull request — Ship now / Release… and
//! Ship batch on a project whose `origin` is GitHub, for the two kinds that
//! push ("Tag and push", "Publish a GitHub release").
//!
//! 1. **Build** (`build`, on this computer, nothing pushed). GitHub's target
//!    is fetched and a branch `plyloft/release-vX.Y.Z` (1.173.0: an area's
//!    `plyloft/release-site-vX.Y.Z`, tagged `site-vX.Y.Z`) is made from
//!    `origin/<target>` in a release copy of its own (a git worktree in a
//!    temporary folder — the project folder is never touched, so it may be
//!    on any branch and hold changes of the person's). Each card's verified
//!    snapshot goes in as one commit (`feat: <title>`, `Closes #N` for an
//!    issue card), then the version commit (`chore(release): vX.Y.Z`). A
//!    card that conflicts stops the release as R6's does: recorded on that
//!    card (`ConflictBlocked`, against GitHub's target) unless it conflicts
//!    with an earlier card of the batch ("ship them separately", R7). Then
//!    the project's Verify scripts run on the combined tree
//!    (`verify::run_script_checks_in`). A stop anywhere here takes the
//!    record and the local branch back: nothing was released.
//! 2. **Push** the release branch — never forced (a branch of that name on
//!    GitHub with other commits stops the release; Plyloft never overwrites
//!    it).
//! 3. **Open the pull request** to the target (`Closes #N` lines in its body
//!    too: a squash merge keeps only the pull request's words).
//! 4. **Merge when checks pass**: `gh pr merge --auto --match-head-commit`
//!    with the repository's merge method ([`merge_methods`]); where the repository
//!    doesn't allow auto-merge, Plyloft merges it itself once its checks on
//!    GitHub passed, with the same `--match-head-commit`. Never `--admin`:
//!    a protected target works because GitHub merges the pull request under
//!    its own rules.
//! 5. **Tag the merge commit** and push the tag (the Release exception).
//! 6. For "Publish a GitHub release" only, `gh release create vX.Y.Z
//!    --notes-file -` with notes from the cards (the ply:release-notes
//!    shape). Then the cards are marked shipped at the merge commit, their
//!    copies put away, the local release branch deleted and this computer's
//!    target brought up to date when it can be safely.
//!
//! Every step is recorded (`release_record::ReleasePr`, atomically) as soon
//! as it is reached, so a quit or a crash resumes from the last one — the
//! poller (`poll`, every minute) or the next press — and no step is done
//! twice in a way that matters: a push of what GitHub has is a no-op, a pull
//! request is looked up before one is opened, a tag is made only on the
//! merge commit, a GitHub release that exists counts as made.
//!
//! When GitHub's target moves on and the pull request is behind it or
//! conflicts with it, nothing happens by itself: **Update the release**
//! ([`update`]) merges the target into the release branch on the person's
//! press, checks it again and pushes it (a fast-forward, never forced).
//!
//! Mac and Windows alike: git through `platform::git_command`, `gh` through
//! `github::gh_output*` (the workspace's GitHub account), the checks through
//! Verify's runner (Git Bash on Windows), a temporary folder from
//! `tempfile`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{
    announce_record, commit_card_edits, git_capture, git_run, mark_released, merges_alone, now_millis,
    require_version_files_tracked, resolve_commit, squash_stop, stop_error, tracked_release_paths,
    worktree_gone_message, write_versions_per_config, ShipResult,
};
use crate::kanban::{KanbanCard, KanbanStore, ReleaseKind};
use crate::merge_method::MergeMethod;
use crate::pr_merge::{GhAnswer, MergeAnswer};
use crate::pr_status::{PrChecks, PrMergeable, PrReviewDecision, PrState, PrStatus};
use crate::project_config::ProjectConfig;
use crate::release_record::{PendingRelease, PrReleaseStep, RecordStage, ReleasePr};
use crate::worktrees::ShipError;

/// `plyloft/release-` + the release's tag. 1.173.0 (B4): an area's release
/// is `plyloft/release-site-v1.0.1`; without areas `plyloft/release-v1.0.1`,
/// as before.
pub const BRANCH_PREFIX: &str = "plyloft/release-";

/// The release branch of `areas::tag_for(tag_prefix, version)`.
pub fn branch_for(tag_prefix: &str, version: &str) -> String {
    format!("{BRANCH_PREFIX}{}", crate::areas::tag_for(tag_prefix, version))
}

/// The tag prefix a recorded release was made with: its tag without
/// `v<version>` ("" for `vX.Y.Z`, and for a tag that doesn't end so).
pub(crate) fn prefix_of(record: &PendingRelease) -> &str {
    record.tag.strip_suffix(&format!("v{}", record.version)).unwrap_or("")
}

/// One of Plyloft's own release branches (`plyloft/release-<prefix>vX.Y.Z`):
/// the only kind [`discard_local`] ever deletes.
pub(crate) fn is_release_branch(branch: &str) -> bool {
    branch.strip_prefix(BRANCH_PREFIX).is_some_and(|tag| {
        tag.match_indices('v').any(|(at, _)| super::tag_version(&tag[..at], tag).is_some())
    })
}

/// The release pull request's merge methods — the ONE place that picks
/// them: G3's (`merge_method::methods_for_pr`), the repository's allowed
/// methods in Plyloft's order (squash, else a merge commit, else rebase),
/// cached in `workspaces.json` like a card's; `reread` reads GitHub again
/// (a merge refused for its method, `pr_merge::ask_with_method`). All three
/// when nothing is known. `TEST_MERGE_METHODS` is the hook its tests keep.
pub(crate) fn merge_methods<R: tauri::Runtime>(
    place: &Place<R>,
    github: &dyn ReleaseGitHub,
    url: &str,
    reread: bool,
) -> Vec<MergeMethod> {
    #[cfg(test)]
    if let Some(methods) = TEST_MERGE_METHODS.with(|m| m.borrow().clone()) {
        return methods;
    }
    use tauri::Manager;
    match place.app.try_state::<crate::workspace::WorkspaceStore>() {
        Some(workspaces) => {
            crate::merge_method::methods_for_pr(&workspaces, place.workspace_id, url, reread, |args| github.api(args))
        }
        None => crate::merge_method::ALL_METHODS.to_vec(),
    }
}

#[cfg(test)]
thread_local! {
    /// Tests: the methods G3 would read for the repository, in order.
    pub(crate) static TEST_MERGE_METHODS: std::cell::RefCell<Option<Vec<MergeMethod>>> = const { std::cell::RefCell::new(None) };
}

/// Ask GitHub to merge the release pull request with the repository's
/// method ([`merge_methods`]); refused for its method, read the repository
/// again and try each other method it allows (`pr_merge::ask_with_method`,
/// as a card's Merge does). `--match-head-commit` always.
fn merge_with_method<R: tauri::Runtime>(
    place: &Place<R>,
    github: &dyn ReleaseGitHub,
    url: &str,
    head: &str,
    auto: bool,
) -> Result<GhAnswer, String> {
    let methods_of = |reread: bool| merge_methods(place, github, url, reread);
    crate::pr_merge::ask_with_method(&methods_of, &|method| github.merge(url, head, auto, method)).map(|(answer, _)| answer)
}

/// `gh pr merge <url> <method> [--auto] --match-head-commit <head>`.
pub(crate) fn merge_args<'a>(url: &'a str, head: &'a str, auto: bool, method: MergeMethod) -> Vec<&'a str> {
    let mut args = vec!["pr", "merge", url, method.flag()];
    if auto {
        args.push("--auto");
    }
    args.extend(["--match-head-commit", head]);
    args
}

/// How long after the pull request was opened a repository that reports no
/// checks is taken to have none (Plyloft's own merge, when auto-merge isn't
/// allowed): GitHub may not have registered them yet.
pub const NO_CHECKS_WAIT_MS: i64 = crate::pr_status::AWAITING_FIRST_CHECKS_MS;

/// 1.170.0 walk fix: the release pull request's target requires no checks
/// (or Plyloft couldn't tell), so GitHub isn't asked to merge it by itself.
pub const PLYLOFT_MERGES_RELEASE: &str = "Plyloft merges the release pull request once its checks on GitHub \
pass (while Plyloft is open on this computer).";

/// How often the poller reads a release's pull request.
pub const POLL_EVERY_MS: i64 = 60_000;

/// 1.171.0 F3 (K5): how often while GitHub is about to merge it — its
/// checks running, the merge asked for, or merged with the tag still to
/// make. Every poller tick: "Merging the release" lagged up to a minute
/// after GitHub merged it.
pub const POLL_MERGING_MS: i64 = crate::pr_status::POLL_TICK_SECS as i64 * 1000;

/// 1.171.0 F3: when the poller reads `record`'s pull request again after a
/// round that only waited. Every tick only on a positive list: in Merging
/// while its last read found GitHub on its way to merging it (checks
/// running, auto-merge on — `merge_on_its_way`), or in Merging or Merged with
/// nothing to wait for yet. Any other wait keeps the minute — a refusal, a
/// failed read, a review, a conflict — so no `gh pr merge` runs every tick.
pub(crate) fn poll_every_ms(record: &PendingRelease) -> i64 {
    let Some(pr) = record.pr.as_ref() else { return POLL_EVERY_MS };
    let merging = pr.step == PrReleaseStep::Merging;
    let fresh = matches!(pr.step, PrReleaseStep::Merging | PrReleaseStep::Merged) && pr.waiting.is_none();
    if !pr.outdated && pr.problem.is_none() && ((merging && pr.merge_on_its_way) || fresh) {
        POLL_MERGING_MS
    } else {
        POLL_EVERY_MS
    }
}

/// What a stop before the push says besides its own words.
pub(crate) const NOTHING_PUSHED: &str =
    "Nothing was pushed, and your project folder wasn't touched.";

/// The GitHub repository a release of `kind` from `repo_root` goes through,
/// when it does: a kind that pushes, and an `origin` on GitHub.
pub(crate) fn route(repo_root: &Path, kind: ReleaseKind) -> Option<String> {
    if !super::pushes(kind) {
        return None;
    }
    super::github_origin(repo_root)
}

// ── GitHub ──────────────────────────────────────────────────────────────

/// A pull request `gh pr list --head` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundPr {
    pub number: u64,
    pub url: String,
    pub state: PrState,
    pub head: Option<String>,
    pub merge_commit: Option<String>,
}

/// The GitHub half, behind a seam for the tests. Every call runs as the
/// workspace's GitHub account (the caller's scope) and is bounded.
pub trait ReleaseGitHub {
    /// The pull requests whose head is `branch`, in any state, newest first.
    fn find_prs(&self, branch: &str) -> Result<Vec<FoundPr>, String>;
    /// `gh pr create`; its URL, or gh's answer when it refused.
    fn create_pr(&self, base: &str, branch: &str, title: &str, body: &str) -> Result<Result<String, String>, String>;
    fn view_pr(&self, url: &str) -> Result<PrStatus, String>;
    /// `gh pr merge <url> <method> [--auto] --match-head-commit <head>`.
    fn merge(&self, url: &str, head: &str, auto: bool, method: MergeMethod) -> Result<GhAnswer, String>;
    /// `gh api …` (G3: the repository's merge methods).
    fn api(&self, args: &[&str]) -> Result<GhAnswer, String>;
    /// `gh release create <tag> --verify-tag --notes-file -`.
    fn create_release(&self, tag: &str, notes: &str) -> Result<GhAnswer, String>;
    /// `gh pr merge <url> --disable-auto` (Dismiss: GitHub doesn't merge it
    /// by itself afterwards).
    fn disable_auto(&self, url: &str) -> Result<GhAnswer, String>;
    /// 1.170.0 walk fix: whether `base` requires status checks
    /// (`pr_merge::checks_required`); None when Plyloft couldn't tell.
    fn checks_required(&self, url: &str, base: &str) -> Option<bool>;
}

/// `gh` as it runs.
pub struct RealGitHub {
    pub gh: String,
    pub cwd: PathBuf,
    pub slug: String,
}

impl RealGitHub {
    fn run(&self, args: &[&str]) -> Result<GhAnswer, String> {
        crate::github::gh_output(&self.gh, Some(&self.cwd), args, crate::shared_config::GH_TIMEOUT)
            .map(|out| GhAnswer::from_output(&out))
    }

    fn run_fed(&self, args: &[&str], input: &str) -> Result<GhAnswer, String> {
        crate::github::gh_output_with_stdin(&self.gh, Some(&self.cwd), args, crate::shared_config::GH_TIMEOUT, input)
            .map(|out| GhAnswer::from_output(&out))
    }
}

impl ReleaseGitHub for RealGitHub {
    fn find_prs(&self, branch: &str) -> Result<Vec<FoundPr>, String> {
        let answer = self.run(&[
            "pr", "list", "--repo", &self.slug, "--head", branch, "--state", "all", "--json",
            "number,url,state,headRefOid,mergeCommit", "--limit", "10",
        ])?;
        if !answer.ok {
            return Err(answer.stderr);
        }
        parse_pr_list(&answer.stdout)
    }

    fn create_pr(&self, base: &str, branch: &str, title: &str, body: &str) -> Result<Result<String, String>, String> {
        let answer = self.run_fed(
            &[
                "pr", "create", "--repo", &self.slug, "--base", base, "--head", branch, "--title", title,
                "--body-file", "-",
            ],
            body,
        )?;
        Ok(if answer.ok {
            Ok(answer.stdout.lines().last().unwrap_or_default().trim().to_string())
        } else {
            Err(if answer.stderr.is_empty() { answer.stdout } else { answer.stderr })
        })
    }

    fn view_pr(&self, url: &str) -> Result<PrStatus, String> {
        use crate::pr_status::{gh_lacks_auto_merge_field, parse_pr_view, PR_VIEW_FIELDS, PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE};
        let mut answer = self.run(&["pr", "view", url, "--json", PR_VIEW_FIELDS])?;
        if !answer.ok && gh_lacks_auto_merge_field(&answer.stderr) {
            answer = self.run(&["pr", "view", url, "--json", PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE])?;
        }
        if !answer.ok {
            return Err(answer.stderr);
        }
        parse_pr_view(&answer.stdout)
    }

    fn merge(&self, url: &str, head: &str, auto: bool, method: MergeMethod) -> Result<GhAnswer, String> {
        self.run(&merge_args(url, head, auto, method))
    }

    fn api(&self, args: &[&str]) -> Result<GhAnswer, String> {
        self.run(args)
    }

    fn create_release(&self, tag: &str, notes: &str) -> Result<GhAnswer, String> {
        self.run_fed(
            &["release", "create", tag, "--repo", &self.slug, "--title", tag, "--verify-tag", "--notes-file", "-"],
            notes,
        )
    }

    fn disable_auto(&self, url: &str) -> Result<GhAnswer, String> {
        self.run(&["pr", "merge", url, "--disable-auto"])
    }

    fn checks_required(&self, url: &str, base: &str) -> Option<bool> {
        crate::pr_merge::checks_required(url, Some(base), &|args| self.run(args))
    }
}

/// `gh pr list --json number,url,state,headRefOid,mergeCommit`, newest first.
pub fn parse_pr_list(json: &str) -> Result<Vec<FoundPr>, String> {
    let list: Vec<serde_json::Value> =
        serde_json::from_str(json.trim()).map_err(|e| format!("couldn't read GitHub's list of pull requests: {e}"))?;
    let mut found: Vec<FoundPr> = list
        .iter()
        .filter_map(|v| {
            let number = v["number"].as_u64()?;
            let state = match v["state"].as_str().unwrap_or("").to_ascii_uppercase().as_str() {
                "MERGED" => PrState::Merged,
                "CLOSED" => PrState::Closed,
                _ => PrState::Open,
            };
            Some(FoundPr {
                number,
                url: v["url"].as_str().unwrap_or_default().to_string(),
                state,
                head: v["headRefOid"].as_str().map(str::to_string).filter(|s| !s.is_empty()),
                merge_commit: v["mergeCommit"]["oid"].as_str().map(str::to_string).filter(|s| !s.is_empty()),
            })
        })
        .collect();
    found.sort_by(|a, b| b.number.cmp(&a.number));
    Ok(found)
}

/// G8 fixes (Challenger major 1): which of the branch's pull requests is
/// this release's — open or merged at exactly the head Plyloft pushed. One
/// open at another head (a commit someone else pushed) is never taken for
/// it: it is the person's to settle (`Other`). A closed one is history, and
/// (G2 walk, Mac) so is one merged at another head — an earlier release of
/// the same branch name, its branch reused: this release opens its own
/// (`None`), and that old merge is never tagged.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Ours {
    Found(FoundPr),
    None,
    Other(FoundPr),
}

pub(crate) fn ours(found: Vec<FoundPr>, head: &str) -> Ours {
    let live = |f: &FoundPr| matches!(f.state, PrState::Open | PrState::Merged);
    if let Some(mine) = found.iter().find(|f| live(f) && f.head.as_deref() == Some(head)) {
        return Ours::Found(mine.clone());
    }
    // G2 walk (Mac): a merged pull request of the same branch name at
    // another head is an earlier one's history (its branch reused once it
    // was deleted; the tag isn't on GitHub, or the release would have been
    // refused) — this release opens its own. Only an open one stands in
    // its way.
    match found.into_iter().find(|f| f.state == PrState::Open) {
        Some(other) => Ours::Other(other),
        None => Ours::None,
    }
}

/// What GitHub said to a merge, in a shape the steps read.
fn auto_merge_refused(said: &str) -> bool {
    let lower = said.to_ascii_lowercase();
    (lower.contains("auto-merge") || lower.contains("auto merge") || lower.contains("automerge"))
        && (lower.contains("not allowed") || lower.contains("disabled") || lower.contains("not enabled"))
}

// ── Where a release happens ─────────────────────────────────────────────

/// The workspace a release step runs for.
pub(crate) struct Place<'a, R: tauri::Runtime> {
    pub app: &'a tauri::AppHandle<R>,
    pub workspace_id: &'a str,
    /// The workspace folder (its integration lock and fast-forward).
    pub ws_cwd: &'a Path,
    /// The repository's top level (git runs here; its objects hold the
    /// release branch).
    pub repo_root: &'a Path,
    pub ws_dir: &'a Path,
    pub config: &'a ProjectConfig,
    pub kanban: &'a KanbanStore,
}

impl<R: tauri::Runtime> Place<'_, R> {
    fn target(&self) -> &str {
        &self.config.target_branch
    }

    /// Write the record (atomic) and say so. 1.174.0 (DR2): while Stop was
    /// asked of this press, the record says so (`stop_requested`) — never
    /// once it is merged, when it can't be taken back.
    pub(crate) fn save(&self, record: &PendingRelease) -> Result<(), ShipError> {
        let asked;
        let record = if !record.stop_requested
            && super::stop_requested_now(self.workspace_id)
            && record.pr.as_ref().is_none_or(|p| p.step < PrReleaseStep::Merged)
        {
            asked = PendingRelease { stop_requested: true, ..record.clone() };
            &asked
        } else {
            record
        };
        // Tests: the write itself fails (a full disk) right after the step's
        // effect on GitHub happened — nothing of it is recorded.
        #[cfg(test)]
        if TEST_SAVE_FAILS.with(|c| c.get()).is_some_and(|f| f.matches(record)) {
            TEST_SAVE_FAILS.with(|c| c.set(None));
            return Err(format!("Plyloft couldn't record how far {} got (test: the disk is full).", record.tag).into());
        }
        crate::release_record::save(self.ws_dir, record).map_err(|e| {
            ShipError::from(format!("Plyloft couldn't record how far {} got ({e}).", record.tag))
        })?;
        announce_record(self.app, self.workspace_id);
        // Tests: Plyloft "dies" right after this step was recorded.
        #[cfg(test)]
        if let Some(step) = TEST_CRASH_AFTER.with(|c| c.get()) {
            if record.pr.as_ref().map(|p| p.step) == Some(step) {
                TEST_CRASH_AFTER.with(|c| c.set(None));
                TEST_CRASHED.with(|c| c.set(true));
                return Err("Plyloft stopped here (test)".to_string().into());
            }
        }
        Ok(())
    }
}

/// Tests: which write of the record fails ([`Place::save`]).
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) enum SaveFails {
    /// The first write that records this step.
    At(PrReleaseStep),
    /// The first write that records the GitHub release as made.
    ReleaseCreated,
}

#[cfg(test)]
impl SaveFails {
    fn matches(self, record: &PendingRelease) -> bool {
        let Some(pr) = record.pr.as_ref() else { return false };
        match self {
            SaveFails::At(step) => pr.step == step,
            SaveFails::ReleaseCreated => pr.release_created,
        }
    }
}

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_SAVE_FAILS: std::cell::Cell<Option<SaveFails>> = const { std::cell::Cell::new(None) };
    /// Tests: the step whose record is the last thing written before
    /// Plyloft "dies" (nothing after it runs, no clean-up either).
    pub(crate) static TEST_CRASH_AFTER: std::cell::Cell<Option<PrReleaseStep>> = const { std::cell::Cell::new(None) };
    pub(crate) static TEST_CRASHED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Tests: whether the copy's key was already reserved when its
    /// `git worktree add` started (set by [`ReleaseTree::add`]).
    pub(crate) static TEST_RESERVED_AT_ADD: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Tests: a "crash" leaves everything as it was, clean-ups included.
fn crashed() -> bool {
    #[cfg(test)]
    {
        TEST_CRASHED.with(|c| c.get())
    }
    #[cfg(not(test))]
    {
        false
    }
}

fn pr_of(record: &mut PendingRelease) -> &mut ReleasePr {
    let branch = branch_for(prefix_of(record), &record.version);
    record.pr.get_or_insert_with(|| ReleasePr::new(branch, String::new()))
}

// ── 1. Build ────────────────────────────────────────────────────────────

/// What the press asks to release.
pub(crate) struct Build<'a> {
    /// In the order they go in.
    pub cards: Vec<&'a KanbanCard>,
    pub version: String,
    /// 1.173.0 (B4): the area's tag prefix ("" is `vX.Y.Z`): the tag
    /// `areas::tag_for(prefix, version)`, the branch [`branch_for`].
    pub tag_prefix: String,
    pub kind: ReleaseKind,
    pub skip_verify: bool,
    /// The repository's worktree setup (`.env` copies, a setup command),
    /// run in the release copy before its checks, as in a card's.
    pub setup: crate::worktree_setup::WorktreeSettings,
    /// 1.174.0 (DR2): what else it carries (the cards already on the target,
    /// since which tag, how many other changes), recorded on it.
    pub facts: super::ReleaseFacts,
    /// 1.174.0 (DR2): *Stop the release*'s flag for this press — checked
    /// between the steps, and it kills the checks' process tree.
    pub stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl Build<'_> {
    fn stopped(&self) -> bool {
        self.stop.as_ref().is_some_and(|f| f.load(std::sync::atomic::Ordering::SeqCst))
    }
}

/// What a release copy's temporary folder is called (`<tmp>/plyloft-release-…/release`).
const TREE_PREFIX: &str = "plyloft-release-";

/// The release copy: a worktree in a temporary folder, on a detached HEAD
/// at the commit it starts from — the release branch is never checked out
/// in it (G8 fixes, m3), so nothing holds the branch: it is moved with
/// `git branch` / `git update-ref` once the release is made. Removed with
/// its folder whatever happens.
struct ReleaseTree {
    repo_root: PathBuf,
    path: PathBuf,
    /// Its entry in [`live_trees`], as reserved before the add.
    key: PathBuf,
    _dir: tempfile::TempDir,
}

impl ReleaseTree {
    /// `git worktree add --detach <path> <start>`.
    fn add(repo_root: &Path, start: &str) -> Result<Self, String> {
        let dir = tempfile::Builder::new()
            .prefix(TREE_PREFIX)
            .tempdir()
            .map_err(|e| format!("Plyloft couldn't make a folder for the release: {e}"))?;
        let path = dir.path().join("release");
        let path_str = path.to_string_lossy().into_owned();
        // Reserved before the add: git lists the copy (`locked
        // initializing`) while it is still checking it out, and another
        // release's clean-up must not take it for a leftover then. The
        // folder exists, so it canonicalizes; "release" doesn't yet.
        let key = reserve_live(dir.path());
        #[cfg(test)]
        TEST_RESERVED_AT_ADD.with(|c| c.set(Some(live_trees().lock().unwrap_or_else(|p| p.into_inner()).contains(&key))));
        if let Err(e) = git_run(repo_root, &["worktree", "add", "--quiet", "--detach", &path_str, start]) {
            release_live(&key);
            return Err(e);
        }
        Ok(Self { repo_root: repo_root.to_path_buf(), path, key, _dir: dir })
    }
}

impl Drop for ReleaseTree {
    fn drop(&mut self) {
        // No longer in use, crash or not: a "crash" in tests leaves the copy
        // as a real one would, for the next build to remove.
        release_live(&self.key);
        if crashed() {
            // Left behind as a real crash leaves it (its temporary folder
            // goes; git's record of the worktree stays until a prune).
            return;
        }
        remove_tree(&self.repo_root, &self.path.to_string_lossy());
    }
}

/// 1.176.2 (A5R-03): the release copies in use in this run of Plyloft. A
/// copy is detached, so its branch can't tell whose it is: another
/// workspace's release of the same repository (another target) may be
/// running its checks in one. [`discard_tree_of`] leaves these alone; a copy
/// left by a quit or a crash is in no run's set and is still removed.
fn live_trees() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> = std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}

/// As git prints it (`worktree list` resolves links, e.g. macOS `/var`).
fn live_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Marks the copy `<dir>/release` in use, before it exists; its key.
fn reserve_live(dir: &Path) -> PathBuf {
    let key = live_key(dir).join("release");
    live_trees().lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone());
    key
}

fn release_live(key: &Path) {
    live_trees().lock().unwrap_or_else(|p| p.into_inner()).remove(key);
}

/// `git worktree remove --force`, tried once more after a moment when it
/// fails (on Windows a process that just ended may still hold a file in
/// it); then the folder itself, and git's record pruned.
fn remove_tree(repo_root: &Path, path: &str) {
    if let Err(first) = git_run(repo_root, &["worktree", "remove", "--force", path]) {
        std::thread::sleep(std::time::Duration::from_millis(REMOVE_RETRY_MS));
        if let Err(e) = git_run(repo_root, &["worktree", "remove", "--force", path]) {
            log::warn!("release_pr: couldn't remove the release copy {path}: {first}; again: {e}");
            let _ = std::fs::remove_dir_all(path);
        }
    }
    let _ = git_run(repo_root, &["worktree", "prune"]);
}

/// How long a failed removal of the release copy waits before its retry.
const REMOVE_RETRY_MS: u64 = 500;

/// G8 fixes (m6): the releases being built in this run of Plyloft, by
/// repository and release branch. A record at "Building" that isn't here is
/// one a quit or a crash stopped: it says so, and Continue makes it again.
fn building() -> &'static std::sync::Mutex<std::collections::HashSet<(PathBuf, String)>> {
    static BUILDING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<(PathBuf, String)>>> =
        std::sync::OnceLock::new();
    BUILDING.get_or_init(Default::default)
}

fn building_key(repo_root: &Path, branch: &str) -> (PathBuf, String) {
    (std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_path_buf()), branch.to_string())
}

/// A release of `branch` is being built now, in this run of Plyloft.
pub(crate) fn building_now(repo_root: &Path, branch: &str) -> bool {
    building().lock().unwrap_or_else(|p| p.into_inner()).contains(&building_key(repo_root, branch))
}

/// Held while [`build`] runs.
struct BuildingMark((PathBuf, String));

impl BuildingMark {
    fn new(repo_root: &Path, branch: &str) -> Self {
        let key = building_key(repo_root, branch);
        building().lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone());
        Self(key)
    }
}

impl Drop for BuildingMark {
    fn drop(&mut self) {
        building().lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// What a release recorded at "Building" says when no build of it runs.
pub(crate) fn stopped_building_words(tag: &str) -> String {
    format!(
        "Plyloft stopped while it was making {tag} (it was quit or closed). Nothing of it is on GitHub. \
         Continue {tag} makes it again from the start."
    )
}

/// The local release branch and any copy of it left by an earlier stop:
/// removed. Only Plyloft's own `plyloft/release-<prefix>v…` branch is ever
/// named ([`is_release_branch`]).
pub(crate) fn discard_local(repo_root: &Path, branch: &str) {
    if !is_release_branch(branch) {
        return;
    }
    discard_tree_of(repo_root, branch);
    let _ = git_run(repo_root, &["worktree", "prune"]);
    if resolve_commit(repo_root, &format!("refs/heads/{branch}")).is_some() {
        if let Err(e) = git_run(repo_root, &["branch", "-D", branch]) {
            log::warn!("release_pr: couldn't delete the local {branch}: {e}");
        }
    }
}

/// Taken back if the build stops: the record and the local branch go —
/// nothing was released.
struct Unbuilt<'a> {
    ws_dir: &'a Path,
    repo_root: &'a Path,
    branch: String,
    armed: bool,
}

impl Drop for Unbuilt<'_> {
    fn drop(&mut self) {
        if !self.armed || crashed() {
            return;
        }
        discard_local(self.repo_root, &self.branch);
        if let Err(e) = crate::release_record::clear(self.ws_dir) {
            log::warn!("release_pr: couldn't take back the record of a release that wasn't made: {e}");
        }
    }
}

/// `git ls-remote origin <refs…>`: each ref GitHub has, with its commit.
pub(crate) fn remote_refs(repo_root: &Path, refs: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut cmd = crate::platform::git_command();
    crate::github_account::apply_to_network_git(&mut cmd, repo_root)?;
    cmd.args(["-c", "credential.interactive=never", "ls-remote", "origin"])
        .args(refs)
        .current_dir(repo_root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C");
    let out = crate::worktrees::run_bounded(&mut cmd, "git ls-remote origin", super::UNDO_LS_REMOTE_TIMEOUT)?;
    let (mut found, mut peeled) = (HashMap::new(), HashMap::new());
    for (sha, name) in out.lines().filter_map(|l| l.split_once('\t')) {
        let (sha, name) = (sha.trim().to_string(), name.trim());
        // An annotated tag's peeled line (`^{}`) names its commit.
        match name.strip_suffix("^{}") {
            Some(tag) => peeled.insert(tag.to_string(), sha),
            None => found.insert(name.to_string(), sha),
        };
    }
    found.extend(peeled);
    Ok(found)
}

/// The paths a commit changed (`/`-separated).
fn changed_paths(repo: &Path, from: &str, to: &str) -> Vec<String> {
    git_capture(repo, &["diff", "--name-only", "-z", from, to])
        .map(|out| out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn staged_anything(repo: &Path) -> Result<bool, String> {
    let staged = crate::platform::git_command()
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo)
        .status()
        .map_err(|e| format!("spawn git diff --cached: {e}"))?;
    match staged.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err("git diff --cached failed while making the release".to_string()),
    }
}

fn head_of(repo: &Path) -> Result<String, String> {
    Ok(git_capture(repo, &["rev-parse", "--verify", "HEAD"])?.trim().to_string())
}

/// Commit what is staged in the release copy (R8: bounded, a hook's refusal
/// in its own words).
fn commit_in(tree: &Path, args: &[String]) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    crate::git::commit(tree, &refs).map_err(|failure| failure.text())
}

/// Build the release branch and record it at `Built`. `start` is
/// `CARD_START_LOCK`, held while the cards' copies are read and released
/// before the checks run. Nothing is pushed.
pub(crate) fn build<R: tauri::Runtime>(
    place: &Place<R>,
    b: &Build,
    start: std::sync::MutexGuard<'static, ()>,
) -> Result<PendingRelease, ShipError> {
    let target = place.target().to_string();
    let tag = crate::areas::tag_for(&b.tag_prefix, &b.version);
    let branch = branch_for(&b.tag_prefix, &b.version);
    let repo_root = place.repo_root;
    let _building = BuildingMark::new(repo_root, &branch);

    // GitHub's target, as it is now.
    crate::worktrees::fetch_origin_branch(repo_root, &target).map_err(|e| {
        format!("Plyloft couldn't read {target} on GitHub to build the release ({e}). {NOTHING_PUSHED}")
    })?;
    let base = resolve_commit(repo_root, &format!("refs/remotes/origin/{target}")).ok_or_else(|| {
        format!("GitHub has no branch {target} to release onto. {NOTHING_PUSHED}")
    })?;
    // G8 fixes (major 2): a version after the one GitHub's target is at —
    // the release is built from it, whatever this computer's folder says.
    // Walk fix (DR3 early walk): an area's first release may tag the
    // version as it is now ("What site/package.json says now", release.html
    // state 3) — the same version, no earlier tag of the area.
    let first_as_is = super::first_release_as_is(repo_root, &b.tag_prefix, place.config, &base, &b.version);
    if let Some((at, file)) = super::project_version_at(repo_root, place.config, &base).filter(|_| !first_as_is) {
        if super::version_is_after(&b.version, &at) == Some(false) {
            let at = crate::areas::tag_for(&b.tag_prefix, &at);
            return Err(format!(
                "{target} on GitHub is at {at} already ({file}), so {tag} wouldn't be a new version. \
                 Pick a version after {at}. {NOTHING_PUSHED}"
            )
            .into());
        }
    }
    // Nothing of this version on GitHub already: never overwritten.
    let (branch_ref, tag_ref) = (format!("refs/heads/{branch}"), format!("refs/tags/{tag}"));
    let there = remote_refs(repo_root, &[&branch_ref, &tag_ref])
        .map_err(|e| format!("Plyloft couldn't check GitHub before the release ({e}). {NOTHING_PUSHED}"))?;
    if there.contains_key(&tag_ref) {
        return Err(format!("{tag} is on GitHub already; pick a different version. {NOTHING_PUSHED}").into());
    }
    if there.contains_key(&branch_ref) {
        return Err(format!(
            "A branch {branch} is on GitHub already — a release of {tag} started elsewhere, or one \
             left over. Plyloft never overwrites it: pick a different version, or delete that \
             branch on GitHub. {NOTHING_PUSHED}"
        )
        .into());
    }

    // Recorded before anything is made; taken back if the build stops.
    let mut record = PendingRelease {
        version: b.version.clone(),
        tag: tag.clone(),
        commit_sha: String::new(),
        branch: target.clone(),
        card_ids: b.cards.iter().map(|c| c.id.clone()).collect(),
        card_revs: Default::default(),
        release_kind: b.kind,
        skip_verify: b.skip_verify,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: now_millis(),
        // Never `Tagged` until it is done: an older Plyloft offers only Dismiss.
        stage: RecordStage::Committing,
        start_commit: None,
        protected: false,
        tag_pushed: false,
        pr: Some(ReleasePr::new(branch.clone(), base.clone())),
        merged_card_ids: Vec::new(),
        since_tag: None,
        other_changes: 0,
        stop_requested: false,
    };
    b.facts.stamp(&mut record);
    place.save(&record)?;
    let mut unbuilt = Unbuilt { ws_dir: place.ws_dir, repo_root, branch: branch.clone(), armed: true };
    // 1.174.0 (DR2): Stop between the steps — recorded (a quit before the
    // take-back below leaves a record that says to withdraw it), then the
    // record and the local branch go with `unbuilt`. Nothing was pushed.
    let stop_here = |record: &mut PendingRelease| -> ShipError {
        record.stop_requested = true;
        if let Err(e) = place.save(record) {
            log::warn!("release_pr: couldn't record the stop of {}: {e}", record.tag);
        }
        ShipError::stopped(&record.tag, &record.version, true)
    };
    if b.stopped() {
        return Err(stop_here(&mut record));
    }
    // An earlier stop's leftovers (a crash mid-build) go first.
    discard_local(repo_root, &branch);
    let tree = ReleaseTree::add(repo_root, &base)
        .map_err(|e| format!("Plyloft couldn't make the release copy: {e} {NOTHING_PUSHED}"))?;
    let wt = tree.path.clone();

    // One commit per card, each onto the ones before it.
    let mut steps: Vec<(String, Vec<String>)> = Vec::new();
    let mut titles = Vec::new();
    for card in &b.cards {
        if b.stopped() {
            return Err(stop_here(&mut record));
        }
        titles.push(card.title.clone());
        let (Some(copy), Some(card_branch)) = (card.worktree_path.as_deref(), card.branch_name.as_deref()) else {
            return Err(no_copy_words(&card.title).into());
        };
        let copy = Path::new(copy);
        if !copy.exists() {
            return Err(worktree_gone_message(&card.title, &copy.to_string_lossy()).into());
        }
        // A Builder card ships only its build snapshot (verified, unless the
        // release skips the checks); another card's edits are committed on
        // its branch first, as Ship always did.
        if card.builder.is_some() {
            if b.skip_verify {
                crate::builder::require_at_last_snapshot(card, copy)?;
            } else {
                use tauri::Manager;
                let in_flight = place
                    .app
                    .try_state::<crate::verify::VerifyRegistry>()
                    .is_some_and(|v| v.is_inflight(place.workspace_id, &card.id));
                crate::builder::require_verified_snapshot(card, copy, in_flight)?;
            }
        } else {
            commit_card_edits(copy, &crate::commit_message::wip_subject(&card.title), &card.title)?;
        }
        let publish = crate::builder::publish_rev(card, card_branch);
        if let Some(rev) = resolve_commit(repo_root, &publish) {
            record.card_revs.insert(card.id.clone(), rev);
        }
        // Already on GitHub's target (landed before): nothing to add.
        if crate::worktrees::branch_is_merged_into(&wt, &publish, "HEAD").unwrap_or(false) {
            continue;
        }
        let own_base = crate::commands::own_skill_base(card);
        if let Err(e) = crate::worktrees::squash_merge_into_workspace(&wt, &publish, own_base) {
            let stop = squash_stop(&wt, card, card_branch, &target, e).between_cards(&steps, || {
                merges_alone(&wt, &base, &publish, crate::worktrees::own_base_used(&wt, own_base, &publish))
            });
            return Err(stop_error(place.app, place.kanban, place.workspace_id, &target, &base, NOTHING_PUSHED, stop));
        }
        if !staged_anything(&wt)? {
            continue;
        }
        let before = head_of(&wt)?;
        let mut args: Vec<String> =
            vec!["-m".into(), crate::commit_message::land_subject(&card.title, &card.id)];
        if let Some(n) = card.gh_issue_number {
            args.extend(["-m".into(), format!("Closes #{n}")]);
        }
        args.extend(["--trailer".into(), format!("Card: {}", card.id)]);
        commit_in(&wt, &args).map_err(|e| format!("{e} {NOTHING_PUSHED}"))?;
        let after = head_of(&wt)?;
        steps.push((card.title.clone(), changed_paths(&wt, &before, &after)));
    }
    // The cards' copies are read; card starts and Trash may go on.
    drop(start);
    let cards_tree = git_capture(&wt, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();

    if b.stopped() {
        return Err(stop_here(&mut record));
    }
    // The version commit.
    require_version_files_tracked(&wt, place.config)?;
    write_versions_per_config(&wt, place.config, &b.version)?;
    let paths = tracked_release_paths(&wt, place.config)?;
    if !paths.is_empty() {
        let mut args = vec!["add".to_string(), "-u".to_string(), "--".to_string()];
        args.extend(paths.iter().map(|p| format!(":(literal){p}")));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git_run(&wt, &args)?;
    }
    if staged_anything(&wt)? || first_as_is {
        let mut args: Vec<String> = vec!["-m".into(), crate::commit_message::release_tag_subject(&tag)];
        // The version as it is now: the version commit changes no file.
        if first_as_is && !staged_anything(&wt)? {
            args.push("--allow-empty".into());
        }
        // 1.174.0 (DR2): a release with no card of its own has no titles.
        if !titles.is_empty() {
            args.extend(["-m".into(), crate::commit_message::release_body(&titles)]);
        }
        for card in &b.cards {
            args.extend(["--trailer".into(), format!("Card: {}", card.id)]);
        }
        if b.skip_verify {
            args.extend(["--trailer".into(), "Verify: skipped".into()]);
        }
        commit_in(&wt, &args).map_err(|e| format!("{e} {NOTHING_PUSHED}"))?;
    } else if steps.is_empty() && b.cards.is_empty() {
        // 1.174.0 (DR2): nothing of its own and no version file to change.
        return Err(format!("Nothing to release for {tag}: no version file changed. {NOTHING_PUSHED}").into());
    } else if steps.is_empty() {
        return Err(format!(
            "Nothing to release for {tag}: every card is on GitHub's {target} already and no version \
             file changed. {NOTHING_PUSHED}"
        )
        .into());
    }

    // The checks, on the cards together with GitHub's target.
    let checks = run_checks(place, b, &wt, &cards_tree)?;
    if checks.stopped || b.stopped() {
        return Err(stop_here(&mut record));
    }
    if let Some((step, why)) = &checks.failed {
        let on = match b.cards.len() {
            0 => format!("{target} on GitHub"),
            1 => format!("the card together with {target} on GitHub"),
            _ => format!("the cards together with {target} on GitHub"),
        };
        return Err(format!(
            "The checks failed on the release — {on}: {step}: {} {NOTHING_PUSHED}",
            why.trim()
        )
        .into());
    }

    let head = head_of(&wt)?;
    // The release branch, made only now (never checked out anywhere).
    git_run(repo_root, &["branch", &branch, &head])?;
    record.commit_sha = head.clone();
    let pr = pr_of(&mut record);
    pr.head = Some(head);
    pr.step = PrReleaseStep::Built;
    pr.checks_run = checks.ran;
    pr.checks_not_run = checks.not_run;
    place.save(&record)?;
    unbuilt.armed = false;
    drop(tree);
    Ok(record)
}

/// A card with no copy of its own can't go into a release branch.
pub(crate) fn no_copy_words(title: &str) -> String {
    format!(
        "“{title}” has no copy of its own, so it can't go into a release pull request: its change \
         is only in your project folder. Release it with “On {} only”, or start the card again. \
         {NOTHING_PUSHED}",
        crate::platform::THIS_MACHINE
    )
}

/// A release through a pull request recorded before it was built (a quit
/// or a crash mid-build): nothing of it is on GitHub, and it is made again
/// from the start on the next press.
pub(crate) fn unbuilt(record: &PendingRelease) -> bool {
    record.pr.as_ref().is_some_and(|p| p.step == PrReleaseStep::Building && p.head.is_none())
}

/// [`unbuilt`]'s record and leftovers taken back before it is made again.
pub(crate) fn discard_unbuilt(repo_root: &Path, ws_dir: &Path, record: &PendingRelease) -> Result<(), String> {
    if let Some(pr) = &record.pr {
        discard_local(repo_root, &pr.branch);
    }
    crate::release_record::clear(ws_dir)
}

/// The project's checks on the release copy — not when the release skips
/// them, nor when the one card's own Verify already passed on exactly this
/// content (GitHub's target hadn't moved).
fn run_checks<R: tauri::Runtime>(
    place: &Place<R>,
    b: &Build,
    wt: &Path,
    cards_tree: &str,
) -> Result<crate::verify::TreeChecks, ShipError> {
    let pipeline = place.config.verify_pipeline.clone().unwrap_or_default();
    if b.skip_verify || pipeline.is_empty() {
        return Ok(Default::default());
    }
    if let [card] = b.cards.as_slice() {
        if crate::verify::verify_result_on(cards_tree, &card.verify_history) == Some(true) {
            return Ok(crate::verify::TreeChecks {
                ran: vec![format!("Verify of “{}” (the same content)", card.title)],
                ..Default::default()
            });
        }
    }
    if let Some(refusal) = checks_refusal(place) {
        return Err(refusal.into());
    }
    let path = crate::shell_env::get().path.clone();
    let main_root = crate::worktree_setup::repo_root(place.ws_cwd);
    // 1.174.0 (DR2 round 1): Stop reaches the setup command too.
    if let Some(setup) = crate::worktree_setup::prepare_worktree_until(
        &main_root,
        wt,
        &b.setup,
        &path,
        &[],
        std::time::Duration::from_secs(crate::worktree_setup::SETUP_TIMEOUT_SECS),
        b.stop.as_deref(),
    ) {
        if b.stopped() {
            return Ok(crate::verify::TreeChecks { stopped: true, ..Default::default() });
        }
        if setup.state == crate::worktree_setup::WorktreeSetupState::Failed {
            return Err(format!(
                "The release's checks couldn't start: {} {NOTHING_PUSHED}",
                setup.reason.unwrap_or_else(|| "its setup failed.".into())
            )
            .into());
        }
    }
    if b.stopped() {
        return Ok(crate::verify::TreeChecks { stopped: true, ..Default::default() });
    }
    Ok(crate::verify::run_script_checks_in(&pipeline, wt, &[], b.stop.as_deref()))
}

// ── 2–6. Advance ────────────────────────────────────────────────────────

/// Where a release stands after [`advance`].
#[derive(Debug)]
pub(crate) enum Advanced {
    /// Waiting on GitHub (or on the person, when `problem` is set).
    Waiting(PendingRelease),
    /// Merged, tagged and marked: the record is gone.
    Done {
        record: PendingRelease,
        kept: Vec<String>,
        /// This computer's target was brought up to GitHub's.
        brought: bool,
    },
}

/// Take the release as far as it goes now, recording each step. A failure
/// that may pass (offline, GitHub slow) is kept as `waiting` and the step
/// tried again on the next round; one only the person can settle is kept
/// as `problem`.
pub(crate) fn advance<R: tauri::Runtime>(
    place: &Place<R>,
    mut record: PendingRelease,
    github: &dyn ReleaseGitHub,
    now: i64,
    steps: usize,
) -> Result<Advanced, ShipError> {
    let target = place.target().to_string();
    // Each round moves one step or stops; at most `steps` rounds.
    for _ in 0..steps {
        // 1.174.0 (DR2): Stop asked of this press — no further step; the
        // press gives it up from here (`settle_stop`).
        if super::stop_requested_now(place.workspace_id) {
            return Ok(Advanced::Waiting(record));
        }
        let pr = pr_of(&mut record).clone();
        if pr.problem.is_some() {
            return Ok(Advanced::Waiting(record));
        }
        let Some(head) = pr.head.clone() else {
            // Building, never finished: only a new press makes it again.
            return Ok(Advanced::Waiting(record));
        };
        match pr.step {
            PrReleaseStep::Building => {
                pr_of(&mut record).step = PrReleaseStep::Built;
            }
            PrReleaseStep::Built => {
                let refspec = format!("{head}:refs/heads/{}", pr.branch);
                match crate::worktrees::release_push(place.repo_root, &refspec, super::ship_push_timeout()) {
                    Ok(()) => {
                        let p = pr_of(&mut record);
                        p.step = PrReleaseStep::Pushed;
                        p.waiting = None;
                        p.checks_failed = false;
                    }
                    Err(crate::worktrees::ReleasePushFailure::Failed(msg)) if super::not_a_fast_forward(&msg) => {
                        pr_of(&mut record).problem = Some(format!(
                            "A branch {} is on GitHub already with commits Plyloft didn't make, so the \
                             release wasn't pushed (Plyloft never overwrites a branch). Dismiss it, then \
                             release again with another version.",
                            pr.branch
                        ));
                        pr_of(&mut record).waiting = None;
                        pr_of(&mut record).checks_failed = false;
                        record.output = Some(msg);
                        place.save(&record)?;
                        return Ok(Advanced::Waiting(record));
                    }
                    Err(failure) => {
                        let said = match failure {
                            crate::worktrees::ReleasePushFailure::Failed(msg) => msg,
                            crate::worktrees::ReleasePushFailure::TimedOut => format!(
                                "the push didn't finish within {}",
                                super::describe_bound(super::ship_push_timeout())
                            ),
                        };
                        pr_of(&mut record).waiting = Some(format!(
                            "The release is made on this computer, but Plyloft couldn't push it to GitHub \
                             yet ({}); it tries again in a minute.",
                            said.trim()
                        ));
                        record.output = Some(said);
                        place.save(&record)?;
                        return Ok(Advanced::Waiting(record));
                    }
                }
            }
            PrReleaseStep::Pushed => {
                let found = match github.find_prs(&pr.branch) {
                    Ok(found) => found,
                    Err(e) => return wait(place, record, format!("Plyloft couldn't ask GitHub about the release pull request ({}); it tries again in a minute.", e.trim())),
                };
                match ours(found, &head) {
                    Ours::Other(other) => {
                        let what = if other.state == PrState::Merged {
                            format!(
                                "was merged on GitHub at a commit this release didn't make — an earlier \
                                 release of {}, most likely",
                                record.tag
                            )
                        } else {
                            "is open on GitHub with a commit Plyloft didn't make".to_string()
                        };
                        pr_of(&mut record).problem = Some(format!(
                            "Pull request #{} of {} {what}, so Plyloft didn't take it for this release and \
                             tagged nothing. Dismiss it, then release again with another version.",
                            other.number, pr.branch
                        ));
                        pr_of(&mut record).waiting = None;
                        pr_of(&mut record).checks_failed = false;
                        place.save(&record)?;
                        return Ok(Advanced::Waiting(record));
                    }
                    Ours::Found(f) if f.state == PrState::Merged => {
                        let p = pr_of(&mut record);
                        p.number = Some(f.number);
                        p.url = Some(f.url);
                        p.step = if f.merge_commit.is_some() { PrReleaseStep::Merged } else { PrReleaseStep::Merging };
                        p.merge_commit = f.merge_commit;
                    }
                    Ours::Found(f) => {
                        let p = pr_of(&mut record);
                        p.number = Some(f.number);
                        p.url = Some(f.url);
                        p.step = PrReleaseStep::Open;
                        p.opened_at.get_or_insert(now);
                    }
                    Ours::None => {
                        let cards = place.kanban.load(place.workspace_id).unwrap_or_default();
                        let title = crate::commit_message::release_tag_subject(&record.tag);
                        let body = pr_body(&record, &pr, &cards);
                        match github.create_pr(&target, &pr.branch, &title, &body) {
                            Ok(Ok(url)) => {
                                let p = pr_of(&mut record);
                                p.number = crate::pr_status::pr_number_from_url(&url);
                                p.url = Some(url);
                                p.step = PrReleaseStep::Open;
                                p.opened_at = Some(now);
                                p.waiting = None;
                                p.checks_failed = false;
                            }
                            // Opened a moment ago (a crash before it was recorded): found next round.
                            Ok(Err(said)) if said.to_ascii_lowercase().contains("already exists") => {}
                            Ok(Err(said)) => {
                                return wait(place, record, format!(
                                    "The release branch is on GitHub, but GitHub didn't open its pull \
                                     request: {}. Plyloft tries again in a minute.",
                                    said.trim()
                                ))
                            }
                            Err(e) => return wait(place, record, format!("Plyloft couldn't open the release pull request yet ({}); it tries again in a minute.", e.trim())),
                        }
                    }
                }
            }
            PrReleaseStep::Open => {
                let url = pr.url.clone().unwrap_or_default();
                // 1.170.0 walk fix: GitHub's auto-merge waits only for the
                // checks the target requires; on a target that requires
                // none (or when Plyloft can't tell) it would merge at once,
                // before any check ran. Then Plyloft merges it itself once
                // its checks on GitHub passed (`merging`, MergeNow).
                if github.checks_required(&url, &target) != Some(true) {
                    let p = pr_of(&mut record);
                    p.step = PrReleaseStep::Merging;
                    p.plyloft_merges = true;
                    p.waiting = Some(PLYLOFT_MERGES_RELEASE.to_string());
                    place.save(&record)?;
                    continue;
                }
                match merge_with_method(place, github, &url, &head, true) {
                    Ok(answer) => {
                        let p = pr_of(&mut record);
                        p.step = PrReleaseStep::Merging;
                        let read = crate::pr_merge::read_merge_answer(&answer);
                        // 1.172.0 B2: auto-merge not turned on — Plyloft
                        // merges it itself once its checks pass (`merging`).
                        p.plyloft_merges = matches!(read, MergeAnswer::Refused(_));
                        p.waiting = match read {
                            MergeAnswer::Refused(said) if auto_merge_refused(&said) => Some(
                                "GitHub's auto-merge is off for this repository, so Plyloft merges the \
                                 release pull request itself once its checks on GitHub pass."
                                    .to_string(),
                            ),
                            MergeAnswer::Refused(said) => Some(format!("GitHub said: {}", said.trim())),
                            _ => None,
                        };
                    }
                    Err(e) => return wait(place, record, format!("Plyloft couldn't ask GitHub to merge the release yet ({}); it tries again in a minute.", e.trim())),
                }
            }
            PrReleaseStep::Merging => {
                let url = pr.url.clone().unwrap_or_default();
                {
                    let view = match github.view_pr(&url) {
                        Ok(view) => view,
                        Err(e) => return wait(place, record, format!("Plyloft couldn't read the release pull request on GitHub ({}); it tries again in a minute.", e.trim())),
                    };
                    // 1.172.0 B2 (Challenger): who merges it, as GitHub says
                    // it now — set at Open only before, so GitHub dropping
                    // its auto-merge later, or a 1.171 record already at
                    // Merging, said nothing. Plyloft merges an open one with
                    // no auto-merge itself (`merging`'s MergeNow).
                    let mut changed = false;
                    if view.state == PrState::Open {
                        let p = pr_of(&mut record);
                        let plyloft_merges = !view.auto_merge;
                        changed = p.plyloft_merges != plyloft_merges;
                        p.plyloft_merges = plyloft_merges;
                    }
                    match merging(&record, &pr, &view, &target, now) {
                        Merging::Merged(commit) => {
                            let p = pr_of(&mut record);
                            p.merge_commit = Some(commit);
                            p.step = PrReleaseStep::Merged;
                            p.waiting = None;
                            p.checks_failed = false;
                            p.outdated = false;
                        }
                        Merging::Problem(words) => {
                            pr_of(&mut record).problem = Some(words);
                            pr_of(&mut record).waiting = None;
                            pr_of(&mut record).checks_failed = false;
                            place.save(&record)?;
                            return Ok(Advanced::Waiting(record));
                        }
                        Merging::Wait { words, outdated, checks, failed } => {
                            pr_of(&mut record).outdated = outdated;
                            // DR4 round 2: a flag that changed is saved too.
                            let was = std::mem::replace(&mut pr_of(&mut record).checks_failed, failed);
                            return wait_as(place, record, words, checks, changed || was != failed);
                        }
                        Merging::MergeNow => match {
                            let was = std::mem::replace(&mut pr_of(&mut record).checks_failed, false);
                            changed = changed || was;
                            merge_with_method(place, github, &url, &head, false)
                        } {
                            Ok(answer) => match crate::pr_merge::read_merge_answer(&answer) {
                                // Read again next round, which sees it merged.
                                MergeAnswer::Merged | MergeAnswer::AlreadyMerged => {}
                                MergeAnswer::Refused(said) => {
                                    return wait_as(place, record, format!("GitHub didn't merge the release pull request: {}", said.trim()), false, changed)
                                }
                            },
                            Err(e) => return wait_as(place, record, format!("Plyloft couldn't merge the release pull request yet ({}); it tries again in a minute.", e.trim()), false, changed),
                        },
                    }
                }
            }
            PrReleaseStep::Merged => {
                let commit = pr.merge_commit.clone().unwrap_or_default();
                match tag_merge(place.repo_root, &target, &record.tag, &commit) {
                    Ok(()) => {
                        record.commit_sha = commit;
                        record.tag_pushed = true;
                        let p = pr_of(&mut record);
                        p.step = PrReleaseStep::Tagged;
                        p.waiting = None;
                        p.checks_failed = false;
                    }
                    Err(TagStop::Wait(words)) => return wait(place, record, words),
                    Err(TagStop::Problem(words)) => {
                        pr_of(&mut record).problem = Some(words);
                        place.save(&record)?;
                        return Ok(Advanced::Waiting(record));
                    }
                }
            }
            PrReleaseStep::Tagged => {
                if record.release_kind == ReleaseKind::Github && !pr.release_created {
                    let cards = place.kanban.load(place.workspace_id).unwrap_or_default();
                    let notes = release_notes(&record, &pr, &cards);
                    let tag = record.tag.clone();
                    match github.create_release(&tag, &notes) {
                        Ok(answer) if answer.ok || said_of(&answer).to_ascii_lowercase().contains("already exists") => {
                            pr_of(&mut record).release_created = true;
                        }
                        Ok(answer) => {
                            return wait(place, record, format!(
                                "{} is merged and tagged; GitHub didn't make its release page yet: {}. \
                                 Plyloft tries again in a minute.",
                                tag,
                                said_of(&answer)
                            ))
                        }
                        Err(e) => return wait(place, record, format!("{} is merged and tagged; Plyloft couldn't make its release page on GitHub yet ({}); it tries again in a minute.", tag, e.trim())),
                    }
                    place.save(&record)?;
                }
                return finish(place, record);
            }
        }
        place.save(&record)?;
    }
    Ok(Advanced::Waiting(record))
}

fn said_of(answer: &GhAnswer) -> String {
    if answer.stderr.is_empty() { answer.stdout.clone() } else { answer.stderr.clone() }
}

/// Keep `words` as why it waits, and stop this round.
fn wait<R: tauri::Runtime>(place: &Place<R>, record: PendingRelease, words: String) -> Result<Advanced, ShipError> {
    wait_as(place, record, words, false, false)
}

/// [`wait`], saying whether GitHub is on its way to merging it (its checks
/// running, its merge asked for): 1.171.0 F3, `ReleasePr::merge_on_its_way`.
///
/// `changed`: this round changed the record already (1.172.0 B2 Challenger:
/// who merges it, read at Merging) — saved with it.
fn wait_as<R: tauri::Runtime>(
    place: &Place<R>,
    mut record: PendingRelease,
    words: String,
    on_its_way: bool,
    changed: bool,
) -> Result<Advanced, ShipError> {
    let p = pr_of(&mut record);
    if changed || p.waiting.as_deref() != Some(words.as_str()) || p.merge_on_its_way != on_its_way {
        p.waiting = Some(words);
        p.merge_on_its_way = on_its_way;
        place.save(&record)?;
    }
    Ok(Advanced::Waiting(record))
}

/// What a read of the merging pull request says to do.
#[derive(Debug, PartialEq, Eq)]
enum Merging {
    Merged(String),
    Problem(String),
    /// `checks`: GitHub is on its way to merging it (checks running, its
    /// auto-merge on, the merge commit not said yet) — read every tick.
    /// `failed`: GitHub's checks failed on it (DR4 round 1).
    Wait { words: String, outdated: bool, checks: bool, failed: bool },
    /// Auto-merge isn't on and its checks passed: Plyloft merges it.
    MergeNow,
}

fn merging(record: &PendingRelease, pr: &ReleasePr, view: &PrStatus, target: &str, now: i64) -> Merging {
    let number = pr.number.map(|n| format!("#{n}")).unwrap_or_else(|| "the release pull request".into());
    match view.state {
        PrState::Merged => {
            return match view.merge_commit.clone().filter(|c| !c.is_empty()) {
                Some(commit) => Merging::Merged(commit),
                None => Merging::Wait { words: format!("{number} is merged; GitHub hasn't said its merge commit yet."), outdated: false, checks: true, failed: false },
            }
        }
        PrState::Closed => {
            return Merging::Problem(format!(
                "The release pull request {number} was closed on GitHub without being merged, so {} \
                 wasn't tagged. Dismiss it to release again; its branch stays on GitHub.",
                record.tag
            ))
        }
        PrState::Open => {}
    }
    let state = view.merge_state.as_deref().unwrap_or("");
    if view.mergeable == PrMergeable::Conflicting || state == "dirty" {
        return Merging::Wait {
            words: format!(
                "{number} conflicts with {target} on GitHub, which has moved on since the release was \
                 built. Update the release brings in {target}'s changes, or dismiss it and release again."
            ),
            outdated: true,
            checks: false,
            failed: false,
        };
    }
    if view.checks == PrChecks::Failing {
        let names = view.failing_checks.iter().map(|c| c.label()).collect::<Vec<_>>().join(", ");
        let names = if names.is_empty() { String::new() } else { format!(" ({names})") };
        return Merging::Wait {
            words: format!(
                "Checks failed on GitHub for {number}{names}, so it isn't merged. Fix it in the cards \
                 and release again, or merge it on GitHub."
            ),
            outdated: false,
            checks: false,
            failed: true,
        };
    }
    if state == "behind" {
        return Merging::Wait {
            words: format!(
                "{number} is behind {target} on GitHub, and {target} requires it to be up to date. \
                 Update the release brings in {target}'s changes."
            ),
            outdated: true,
            checks: false,
            failed: false,
        };
    }
    if view.head_sha.as_deref().is_some_and(|h| Some(h) != pr.head.as_deref()) {
        return Merging::Wait {
            words: format!("The release branch on GitHub has a commit Plyloft didn't make; {number} is left to merge on GitHub."),
            outdated: false,
            checks: false,
            failed: false,
        };
    }
    if view.auto_merge {
        return Merging::Wait { words: format!("GitHub merges {number} when its checks pass."), outdated: false, checks: true, failed: false };
    }
    let opened = pr.opened_at.unwrap_or(record.created_at);
    let checks_done = match view.checks {
        PrChecks::Passing => true,
        PrChecks::None => now - opened >= NO_CHECKS_WAIT_MS,
        _ => false,
    };
    let review = matches!(view.review_decision, PrReviewDecision::ReviewRequired | PrReviewDecision::ChangesRequested);
    if review {
        return Merging::Wait { words: format!("{number} waits for a review on GitHub."), outdated: false, checks: false, failed: false };
    }
    if checks_done && view.mergeable == PrMergeable::Mergeable && !matches!(state, "blocked" | "draft") {
        return Merging::MergeNow;
    }
    Merging::Wait { words: format!("{number} waits for its checks on GitHub."), outdated: false, checks: true, failed: false }
}

enum TagStop {
    Wait(String),
    Problem(String),
}

/// The tag on the merge commit, here and on GitHub. A tag already there at
/// that commit counts; at another commit, it is the person's to settle.
fn tag_merge(repo_root: &Path, target: &str, tag: &str, commit: &str) -> Result<(), TagStop> {
    if commit.is_empty() {
        return Err(TagStop::Wait("GitHub hasn't said the release's merge commit yet.".into()));
    }
    if resolve_commit(repo_root, commit).is_none() {
        crate::worktrees::fetch_origin_branch(repo_root, target).map_err(|e| {
            TagStop::Wait(format!("The release is merged; Plyloft couldn't fetch it to tag it yet ({e})."))
        })?;
    }
    if resolve_commit(repo_root, commit).is_none() {
        return Err(TagStop::Wait(format!("The release is merged; its commit isn't on {target} here yet.")));
    }
    let tag_ref = format!("refs/tags/{tag}");
    match resolve_commit(repo_root, &tag_ref) {
        Some(at) if at == commit => {}
        Some(_) => {
            return Err(TagStop::Problem(format!(
                "The release is merged, but a tag {tag} on this computer points at another commit, so \
                 Plyloft didn't tag the merge. Look at `git tag`, then tag it by hand or dismiss it."
            )))
        }
        None => {
            let mut cmd = crate::platform::git_command();
            cmd.args(["-c", "tag.gpgSign=false", "tag", tag, commit])
                .current_dir(repo_root)
                .env("GIT_TERMINAL_PROMPT", "0");
            crate::worktrees::run_bounded(&mut cmd, "git tag", super::TAG_TIMEOUT)
                .map_err(|e| TagStop::Wait(format!("The release is merged; Plyloft couldn't tag it yet ({e}).")))?;
        }
    }
    match crate::worktrees::release_push(repo_root, &tag_ref, super::ship_push_timeout()) {
        Ok(()) => Ok(()),
        Err(failure) => {
            match remote_refs(repo_root, &[&tag_ref]).ok().and_then(|r| r.get(&tag_ref).cloned()) {
                // GitHub has it at this commit already (a push that landed before a stop).
                Some(at) if at == commit => return Ok(()),
                // G8 fixes (m4): at another commit — never moved, and no
                // endless retry: the person's to settle.
                Some(_) => {
                    return Err(TagStop::Problem(format!(
                        "The release is merged, but GitHub has a tag {tag} at another commit already, so \
                         Plyloft didn't tag the merge (it never moves a tag). Look at {tag} on GitHub, then \
                         dismiss the release."
                    )))
                }
                None => {}
            }
            let said = match failure {
                crate::worktrees::ReleasePushFailure::Failed(msg) => msg,
                crate::worktrees::ReleasePushFailure::TimedOut => "the push didn't finish in time".into(),
            };
            Err(TagStop::Wait(format!(
                "The release is merged and tagged on this computer; Plyloft couldn't push {tag} to GitHub \
                 yet ({}). It tries again in a minute.",
                said.trim()
            )))
        }
    }
}

/// Merged and tagged: the cards marked, the local branch gone, this
/// computer brought up to date when that is safe.
fn finish<R: tauri::Runtime>(place: &Place<R>, record: PendingRelease) -> Result<Advanced, ShipError> {
    let kept = mark_released(place.app, place.ws_dir, place.repo_root, place.config, place.kanban, place.workspace_id, &record)?;
    if let Some(pr) = &record.pr {
        // Any release copy left by a stop goes whatever the branch says (m3).
        discard_tree_of(place.repo_root, &pr.branch);
        if resolve_commit(place.repo_root, &format!("refs/heads/{}", pr.branch)).as_deref() == pr.head.as_deref() {
            discard_local(place.repo_root, &pr.branch);
        }
    }
    let refused = crate::after_merge::bring_up_to_date(place.ws_cwd, place.target());
    crate::after_merge::up_to_date_now(place.app, place.workspace_id, refused.is_none());
    crate::kanban::emit_kanban_changed(place.app, place.workspace_id);
    Ok(Advanced::Done { record, kept, brought: refused.is_none() })
}

/// The cards of a release, by id: their titles and issue numbers.
fn card_lines(record: &PendingRelease, cards: &[KanbanCard], issue_as_closes: bool) -> Vec<String> {
    // DR2 round 2: a card gone from the Board has no title to say: left out.
    record
        .card_ids
        .iter()
        .filter_map(|id| cards.iter().find(|c| c.id == *id))
        .map(|c| {
            let title = c.title.split_whitespace().collect::<Vec<_>>().join(" ");
            match c.gh_issue_number {
                Some(n) if issue_as_closes => format!("- {title} (closes #{n})"),
                Some(n) => format!("- {title} (#{n})"),
                None => format!("- {title}"),
            }
        })
        .collect()
}

/// 1.174.0 (DR2, D1(b)): what the release carries that was on the target
/// already — the cards shipped with Ship it, by their pull request (newest
/// first), then the other changes by count.
fn carried_lines(record: &PendingRelease, cards: &[KanbanCard]) -> Vec<String> {
    // A card no longer on the Board has no title to say: left out (its
    // change is still in the release).
    let mut lines: Vec<String> = record
        .merged_card_ids
        .iter()
        .rev()
        .filter_map(|id| cards.iter().find(|c| c.id == *id))
        .map(|c| {
            let title = c.title.split_whitespace().collect::<Vec<_>>().join(" ");
            match c.pr.as_ref().map(|p| p.number).or(c.gh_issue_number) {
                Some(n) => format!("- {title} (#{n})"),
                None => format!("- {title}"),
            }
        })
        .collect();
    if record.other_changes > 0 {
        let n = record.other_changes;
        let what = if n == 1 { "1 other change".to_string() } else { format!("{n} other changes") };
        lines.push(match &record.since_tag {
            Some(since) => format!("- {what} since {since}"),
            None => format!("- {what}"),
        });
    }
    lines
}

/// The release pull request's body: the cards, the checks run on the
/// combined change, and `Closes #N` for every issue card (a squash merge
/// keeps only these words). 1.174.0 (DR2): then what was on the target
/// already; with no card of its own, only the version is its commit.
pub(crate) fn pr_body(record: &PendingRelease, pr: &ReleasePr, cards: &[KanbanCard]) -> String {
    let mut body = if record.card_ids.is_empty() {
        match &record.since_tag {
            Some(since) => format!(
                "Release {} made by Plyloft: everything on {} since {since}, and the version.",
                record.tag, record.branch
            ),
            None => format!("Release {} made by Plyloft: everything on {}, and the version.", record.tag, record.branch),
        }
    } else {
        format!(
            "Release {} made by Plyloft: one commit per card, then the version.\n\n{}",
            record.tag,
            card_lines(record, cards, true).join("\n")
        )
    };
    let carried = carried_lines(record, cards);
    if !carried.is_empty() {
        body.push_str(&format!("\n\nAlready on {}:\n{}", record.branch, carried.join("\n")));
    }
    if !pr.checks_run.is_empty() {
        body.push_str(&format!("\n\nChecks passed on the combined change before it was pushed: {}.", pr.checks_run.join(", ")));
    }
    if !pr.checks_not_run.is_empty() {
        body.push_str(&format!(
            "\n\nNot run on the combined change: {} (each ran on its card's own copy).",
            pr.checks_not_run.join(", ")
        ));
    }
    let closes: Vec<String> = record
        .card_ids
        .iter()
        .filter_map(|id| cards.iter().find(|c| c.id == *id)?.gh_issue_number)
        .map(|n| format!("Closes #{n}"))
        .collect();
    if !closes.is_empty() {
        body.push_str("\n\n");
        body.push_str(&closes.join("\n"));
    }
    body
}

/// The GitHub release's notes, in the ply:release-notes shape for a release
/// that collects several: what a person would notice, one line per card,
/// each keeping its identifier.
pub(crate) fn release_notes(record: &PendingRelease, pr: &ReleasePr, cards: &[KanbanCard]) -> String {
    // 1.174.0 (DR2): its own cards, then what was on the target already.
    let mut lines = card_lines(record, cards, false);
    lines.extend(carried_lines(record, cards));
    let mut notes = format!("## {}\n\n{}", record.tag, lines.join("\n"));
    if let Some(n) = pr.number {
        notes.push_str(&format!("\n\nReleased through #{n}."));
    }
    notes.push('\n');
    notes
}

// ── The press, the poller, Update ───────────────────────────────────────

/// What the window is told of a release through a pull request.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePrResult {
    pub step: PrReleaseStep,
    pub number: Option<u64>,
    pub url: Option<String>,
    pub waiting: Option<String>,
    /// Merged, tagged and the cards marked shipped.
    pub released: bool,
}

impl ReleasePrResult {
    fn of(record: &PendingRelease, released: bool) -> Option<Self> {
        let pr = record.pr.as_ref()?;
        Some(Self {
            step: pr.step,
            number: pr.number,
            url: pr.url.clone(),
            waiting: pr.waiting.clone(),
            released,
        })
    }
}

/// 1.175.0 B2 (`ship::install_held`): the release's install step is held
/// for this computer's OK — and remembered as waiting — or `None`.
fn install_held<R: tauri::Runtime>(place: &Place<R>, tag: &str) -> Option<String> {
    use tauri::Manager;
    let store = place.app.try_state::<crate::project_config::ProjectConfigStore>()?;
    super::install_held(&store, place.workspace_id, tag, place.config.install_script.as_deref())
}

/// 1.175.0 B2: why the release's own checks can't start on this computer.
fn checks_refusal<R: tauri::Runtime>(place: &Place<R>) -> Option<String> {
    use tauri::Manager;
    let store = place.app.try_state::<crate::project_config::ProjectConfigStore>()?;
    crate::checks_consent::release_checks_refusal(&store, place.workspace_id, place.config.verify_pipeline.as_deref().unwrap_or(&[]))
}

/// The press's outcome, after it built (or found) the release and took it
/// as far as it goes now. The project's install step runs only when the
/// release is done here and this computer's target is at it.
pub(crate) fn press_result<R: tauri::Runtime>(
    place: &Place<R>,
    advanced: Advanced,
) -> Result<ShipResult, ShipError> {
    let (install_script, relaunches) = super::install_outcome(place.repo_root, place.config);
    match advanced {
        Advanced::Done { record, kept, brought } => {
            // 1.175.0 B2: an install step this computer hasn't allowed waits.
            let held = place.config.install_script.as_ref().filter(|_| brought).and_then(|_| install_held(place, &record.tag));
            let install_log = match place.config.install_script.as_deref() {
                Some(_) if held.is_some() => held.unwrap_or_default(),
                Some(script) if brought => {
                    super::spawn_install_script(place.repo_root, script).map_err(|e| {
                        format!("{} is released, but its install step didn't start: {e}", record.tag)
                    })?;
                    format!("Released {} through its pull request. Build started in background ({script}).", record.tag)
                }
                Some(script) => format!(
                    "Released {} through its pull request. Its install step ({script}) didn't run: \
                     this computer's {} isn't at the release yet.",
                    record.tag,
                    place.target()
                ),
                None => format!("Released {} through its pull request.", record.tag),
            };
            Ok(ShipResult {
                commit_sha: record.commit_sha.clone(),
                shipped_version: record.version.clone(),
                release_kind: record.release_kind,
                install_log: super::with_kept(install_log, &kept),
                fast_forwarded: brought,
                install_script: if brought { install_script } else { None },
                relaunches: brought && relaunches,
                release_pr: ReleasePrResult::of(&record, true),
                tag: Some(record.tag.clone()),
            })
        }
        Advanced::Waiting(record) => {
            if record.pr.as_ref().is_some_and(|p| p.problem.is_some()) {
                let view = crate::release_record::view(place.repo_root, record);
                return Err(ShipError::Unpublished(crate::worktrees::ReleaseUnpublished { unpublished: view }));
            }
            Ok(ShipResult {
                commit_sha: record.commit_sha.clone(),
                shipped_version: record.version.clone(),
                release_kind: record.release_kind,
                install_log: format!(
                    "{} is on its way through a pull request: Plyloft merges it when its checks pass, \
                     then tags it.",
                    record.tag
                ),
                fast_forwarded: false,
                install_script: None,
                relaunches: false,
                release_pr: ReleasePrResult::of(&record, false),
                tag: Some(record.tag.clone()),
            })
        }
    }
}

/// The real GitHub for `place`, or why `gh` can't be used.
pub(crate) fn real_github<R: tauri::Runtime>(place: &Place<R>) -> Result<RealGitHub, String> {
    real_github_at(place.repo_root)
}

fn real_github_at(repo_root: &Path) -> Result<RealGitHub, String> {
    #[cfg(test)]
    if TEST_NO_REAL_GH.with(|c| c.get()) {
        return Err("tests never reach the real gh".into());
    }
    let slug = super::github_origin(repo_root)
        .ok_or_else(|| "this repository's origin isn't on GitHub".to_string())?;
    let gh = crate::doctor::require("gh")?;
    Ok(RealGitHub { gh, cwd: repo_root.to_path_buf(), slug })
}

/// GitHub may have been asked to merge the release pull request when its
/// checks pass: from the step it is asked at (a stop may come before that
/// is recorded) until it is merged.
pub(crate) fn may_auto_merge(pr: &ReleasePr) -> bool {
    matches!(pr.step, PrReleaseStep::Open | PrReleaseStep::Merging)
}

/// 1.174.0 (DR2): what [`settle_stop`] did with a release whose Stop was
/// asked.
#[derive(Debug)]
pub(crate) enum Settled {
    /// Merged on GitHub meanwhile (or no Stop asked): it can't be taken back,
    /// so it goes on — this record, the ask dropped and saved.
    GoesOn(PendingRelease),
    /// Given up, its record and local branch gone: what was done on GitHub,
    /// in words (empty when nothing of it was there).
    GivenUp(String),
    /// Its auto-merge couldn't be turned off: kept (`stop_requested`), its
    /// `pr.problem` says so — never forgotten while GitHub may merge it.
    Kept(PendingRelease),
}

/// 1.174.0 (DR2): a release whose Stop was asked (`stop_requested`) given up
/// from where it got, as Dismiss gives it up. Before its push, its record and
/// local branch go (nothing was on GitHub). Pushed with no pull request yet,
/// its branch stays on GitHub. Open or merging: GitHub is read first, as
/// [`advance`] reads it — merged, it goes on; else its auto-merge is turned
/// off (`gh pr merge --disable-auto`) and the pull request stays open, and a
/// failure keeps the record with the words as its problem. Merged, or
/// tagged: it goes on. The caller holds the ship lock and the workspace's
/// GitHub account.
pub(crate) fn settle_stop<R: tauri::Runtime>(
    place: &Place<R>,
    record: &PendingRelease,
) -> Result<Settled, ShipError> {
    let goes_on = |record: &PendingRelease| -> Result<Settled, ShipError> {
        // DR2 round 2: what a Stop kept (a failed turn-off's problem, a
        // wait) goes with it, so the release goes on by itself.
        let mut on = PendingRelease { stop_requested: false, ..record.clone() };
        if let Some(pr) = on.pr.as_mut() {
            pr.problem = None;
            pr.waiting = None;
            pr.checks_failed = false;
        }
        crate::release_record::save(place.ws_dir, &on)?;
        super::announce_record(place.app, place.workspace_id);
        Ok(Settled::GoesOn(on))
    };
    if !record.stop_requested {
        return Ok(Settled::GoesOn(record.clone()));
    }
    let given_up = |said: String| -> Result<Settled, ShipError> {
        if let Some(pr) = &record.pr {
            discard_local(place.repo_root, &pr.branch);
        }
        crate::release_record::clear(place.ws_dir)?;
        super::announce_record(place.app, place.workspace_id);
        Ok(Settled::GivenUp(said))
    };
    let Some(pr) = record.pr.as_ref() else {
        // Made here and tagged (its pushes stopped): Dismiss's — the commit
        // and tag stay on this computer.
        return given_up(String::new());
    };
    if pr.step >= PrReleaseStep::Merged {
        return goes_on(record);
    }
    match (pr.step, pr.url.as_deref()) {
        (PrReleaseStep::Building | PrReleaseStep::Built, _) => given_up(String::new()),
        (_, None) => given_up(pushed_branch_stays_words(&pr.branch)),
        (_, Some(url)) => {
            let merged = with_github(place, |g| g.view_pr(url))
                .ok()
                .and_then(Result::ok)
                .is_some_and(|view| view.state == PrState::Merged);
            if merged {
                return goes_on(record);
            }
            if !may_auto_merge(pr) {
                return given_up(String::new());
            }
            let answer = with_github(place, |g| g.disable_auto(url)).and_then(|a| a);
            match auto_merge_off_words(answer, pr.number) {
                Ok(said) => given_up(said),
                Err(words) => {
                    let mut kept = record.clone();
                    pr_of(&mut kept).problem = Some(words);
                    crate::release_record::save(place.ws_dir, &kept)?;
                    super::announce_record(place.app, place.workspace_id);
                    Ok(Settled::Kept(kept))
                }
            }
        }
    }
}

/// DR2 round 1 (owner): Stop of a release pushed before its pull request.
pub(crate) fn pushed_branch_stays_words(branch: &str) -> String {
    format!("Its branch {branch} stays on GitHub; no pull request was opened.")
}

/// The GitHub a test stands in for, or the real one.
fn with_github<R: tauri::Runtime, T>(place: &Place<R>, f: impl FnOnce(&dyn ReleaseGitHub) -> T) -> Result<T, String> {
    #[cfg(test)]
    if let Some(github) = test_github() {
        return Ok(f(github.as_ref()));
    }
    let github = real_github(place)?;
    Ok(f(&github))
}

/// `gh pr merge --disable-auto`'s answer in words: `Ok` when it was turned
/// off, `Err` with why it may still be on.
fn auto_merge_off_words(answer: Result<GhAnswer, String>, number: Option<u64>) -> Result<String, String> {
    let name = number.map(|n| format!("#{n}")).unwrap_or_else(|| "the release pull request".into());
    let failed = match answer {
        Ok(answer) if answer.ok => {
            return Ok(format!(
                "Plyloft turned off merging {name} when its checks pass on GitHub, so it isn't merged \
                 by itself. Its pull request and branch stay on GitHub."
            ))
        }
        Ok(answer) => said_of(&answer),
        Err(e) => e,
    };
    Err(format!(
        "Plyloft couldn't turn off merging {name} when its checks pass on GitHub ({}), so auto-merge \
         may still be on and GitHub may merge it. Close it on GitHub if you don't want it.",
        failed.trim()
    ))
}

/// G8 fixes (major 4), Dismiss: `gh pr merge <url> --disable-auto`, as the
/// caller's GitHub account (its scope). What happened, in words.
pub(crate) fn turn_off_auto_merge(repo_root: Option<&Path>, url: &str, number: Option<u64>) -> String {
    let answer = (|| {
        #[cfg(test)]
        if let Some(github) = test_github() {
            return github.disable_auto(url);
        }
        let root = repo_root.ok_or_else(|| "Plyloft can't find this workspace's repository".to_string())?;
        real_github_at(root)?.disable_auto(url)
    })();
    auto_merge_off_words(answer, number).unwrap_or_else(|words| words)
}

#[cfg(test)]
thread_local! {
    static TEST_NO_REAL_GH: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
    /// Tests stand in for GitHub on the thread that ships.
    pub(crate) static TEST_GITHUB: std::cell::RefCell<Option<std::rc::Rc<dyn ReleaseGitHub>>> =
        const { std::cell::RefCell::new(None) };
}

/// How many steps a press takes a release (all it can now).
pub(crate) const PRESS_STEPS: usize = 12;
/// How many a poller tick takes it (G8 fixes, m10): one, so the ship lock is
/// held only for that step; a tick that moved it lets the next one go on.
pub(crate) const POLL_STEPS: usize = 1;

/// The GitHub a test stands in, if any.
#[cfg(test)]
fn test_github() -> Option<std::rc::Rc<dyn ReleaseGitHub>> {
    TEST_GITHUB.with(|g| g.borrow().clone())
}

/// Advance with the GitHub a test stands in, or the real one.
pub(crate) fn advance_now<R: tauri::Runtime>(
    place: &Place<R>,
    record: PendingRelease,
    steps: usize,
) -> Result<Advanced, ShipError> {
    #[cfg(test)]
    if let Some(github) = test_github() {
        return advance(place, record, github.as_ref(), now_millis(), steps);
    }
    match real_github(place) {
        Ok(github) => advance(place, record, &github, now_millis(), steps),
        // The release is recorded; the poller goes on once `gh` is there.
        Err(e) => wait(place, record, format!("Plyloft can't reach GitHub with the GitHub CLI yet ({}); it tries again in a minute.", e.trim())),
    }
}

/// G8 fixes (m2): emitted when the poller finished a release (merged,
/// tagged, the cards marked): the window says "Released vX" and offers the
/// project's install step, which the poller never runs by itself.
pub const RELEASED_EVENT: &str = "release-pr-released";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasedEvent {
    pub workspace_id: String,
    pub card_count: usize,
    pub result: ShipResult,
    /// The project's install step, offered when this computer's target is
    /// at the release (`ship_release_install` runs it on the press).
    pub install_script: Option<String>,
    /// That step is Plyloft's own install (it quits and relaunches).
    pub relaunches: bool,
}

/// What the poller says of a release it finished.
pub(crate) fn released_event<R: tauri::Runtime>(
    place: &Place<R>,
    record: &PendingRelease,
    kept: &[String],
    brought: bool,
) -> ReleasedEvent {
    let (script, relaunches) = super::install_outcome(place.repo_root, place.config);
    let log = match (&script, brought) {
        (Some(script), false) => format!(
            "Released {} through its pull request. Its install step ({script}) didn't run: this \
             computer's {} isn't at the release yet.",
            record.tag,
            place.target()
        ),
        _ => format!("Released {} through its pull request.", record.tag),
    };
    ReleasedEvent {
        workspace_id: place.workspace_id.to_string(),
        card_count: record.card_ids.len(),
        result: ShipResult {
            commit_sha: record.commit_sha.clone(),
            shipped_version: record.version.clone(),
            release_kind: record.release_kind,
            install_log: super::with_kept(log, kept),
            fast_forwarded: brought,
            install_script: None,
            relaunches: false,
            release_pr: ReleasePrResult::of(record, true),
            tag: Some(record.tag.clone()),
        },
        install_script: script.filter(|_| brought),
        relaunches: brought && relaunches,
    }
}

/// The poller's round (`pr_status`'s thread, every tick): each workspace's
/// release through a pull request that is on its way, while no Ship or Land
/// of it runs — one step per tick (m10: the ship lock is held for that step
/// only). A tick that moved it lets the next tick go on; one that only
/// waited reads it again on the next tick while GitHub merges it, else a
/// minute later (offline, a refusal, a wait on the person): `poll_every_ms`.
pub(crate) fn poll<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, Manager};
    static LAST: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    let last = || LAST.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    let (Some(workspaces), Some(kanban), Some(project_config), Some(ships)) = (
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<KanbanStore>(),
        app.try_state::<crate::project_config::ProjectConfigStore>(),
        app.try_state::<super::ShipRegistry>(),
    ) else {
        return;
    };
    let now = now_millis();
    for ws in workspaces.snapshot().workspaces {
        if crate::pr_status::stopping() {
            return;
        }
        let ws_dir = project_config.workspace_dir(&ws.id);
        // 1.174.0 (DR2): a release whose Stop a quit cut short is withdrawn
        // here, once no press holds it.
        let followed = |record: &PendingRelease| {
            record.stop_requested
                || record.pr.as_ref().is_some_and(|pr| pr.step != PrReleaseStep::Building && pr.problem.is_none())
        };
        let Ok(Some(seen)) = crate::release_record::load(&ws_dir) else { continue };
        if !followed(&seen) || last().get(&ws.id).is_some_and(|at| now - at < poll_every_ms(&seen)) {
            continue;
        }
        let Some(_guard) = ships.try_acquire(&ws.id) else { continue };
        // m1: read again under the lock — a press or a Dismiss may have
        // changed it or taken it away meanwhile.
        let record = match crate::release_record::load(&ws_dir) {
            Ok(Some(record)) if record == seen && followed(&record) => record,
            _ => continue,
        };
        // 1.173.0 (B4): the release's area, read from its tag (its branch).
        // On the branch it was built for (Challenger round 1).
        let mut config = match super::ship_area_for_tag(&project_config, &ws.id, &record.tag) {
            Ok(Some(area)) => area.config,
            Ok(None) => continue,
            Err(e) => {
                // Its area is gone: said on the release (Dismiss), not only
                // in the log. Held areas wait — they come back when fixed.
                if e == super::tag_of_no_area_words(&record.tag) {
                    let mut stopped = record.clone();
                    pr_of(&mut stopped).problem = Some(e.clone());
                    if crate::release_record::save(&ws_dir, &stopped).is_ok() {
                        super::announce_record(app, &ws.id);
                    }
                }
                log::debug!("release_pr: {}: {e}", ws.id);
                continue;
            }
        };
        config.target_branch = record.branch.clone();
        let Ok(repo_root) = super::resolve_workspace_repo_root(&ws.cwd) else { continue };
        let _github = crate::github_account::enter_for_app(app, &ws.id);
        let place = Place {
            app,
            workspace_id: &ws.id,
            ws_cwd: Path::new(&ws.cwd),
            repo_root: &repo_root,
            ws_dir: &ws_dir,
            config: &config,
            kanban: &kanban,
        };
        if record.stop_requested {
            match settle_stop(&place, &record) {
                Ok(Settled::GivenUp(said)) => log::info!("release_pr: {} withdrawn after its Stop. {said}", record.tag),
                Ok(Settled::GoesOn(_)) => log::info!("release_pr: {} merged before its Stop; it goes on", record.tag),
                Ok(Settled::Kept(_)) => log::warn!("release_pr: {}: its auto-merge couldn't be turned off", record.tag),
                Err(e) => log::warn!("release_pr: {}: couldn't withdraw it after its Stop: {e}", record.tag),
            }
            last().remove(&ws.id);
            continue;
        }
        let before = record.pr.as_ref().map(|p| p.step);
        let moved = match advance_now(&place, record, POLL_STEPS) {
            Ok(Advanced::Done { record, kept, brought }) => {
                log::info!("release_pr: {} released through its pull request", record.tag);
                // 1.175.0 B2: the step the window offers waits for the OK.
                if brought && config.install_script.is_some() {
                    let _ = install_held(&place, &record.tag);
                }
                let _ = app.emit(RELEASED_EVENT, released_event(&place, &record, &kept, brought));
                true
            }
            Ok(Advanced::Waiting(record)) => record.pr.as_ref().map(|p| p.step) != before,
            Err(e) => {
                log::debug!("release_pr: {}: {e}", ws.id);
                false
            }
        };
        if moved {
            last().remove(&ws.id);
        } else {
            last().insert(ws.id.clone(), now);
        }
    }
}

/// G8 fixes (m2): **Run the install step** of a release the poller
/// finished — only while this computer's target is at it (or past it) and
/// checked out, as a press's own run would have been.
pub(crate) fn run_install(repo_root: &Path, config: &ProjectConfig, tag: &str) -> Result<String, String> {
    let script = config
        .install_script
        .clone()
        .ok_or_else(|| "This project has no install step. Nothing was run.".to_string())?;
    let target = &config.target_branch;
    let at = resolve_commit(repo_root, &format!("refs/tags/{tag}^{{commit}}"));
    let on_target = super::current_branch(repo_root).is_ok_and(|b| b == *target);
    let here = head_of(repo_root).ok();
    let contains = match (&at, &here) {
        (Some(at), Some(here)) => crate::worktrees::is_ancestor(repo_root, at, here),
        _ => false,
    };
    if !on_target || !contains {
        return Err(format!(
            "{tag}'s install step didn't run: this computer's {target} isn't at {tag} yet. Bring this \
             computer up to date, then run it again."
        ));
    }
    super::spawn_install_script(repo_root, &script)?;
    Ok(format!("{tag}'s install step started in the background ({script})."))
}

/// **Update the release**: GitHub's target moved on and the release pull
/// request is behind it or conflicts with it. On the person's press only:
/// the target is merged into the release branch (a merge commit, never a
/// rebase), the checks run again, and the branch is pushed — a fast-forward
/// of what GitHub has, never forced. A conflict stops it with nothing
/// pushed. Returns what was done, in words.
pub(crate) fn update<R: tauri::Runtime>(
    place: &Place<R>,
    mut record: PendingRelease,
    setup: &crate::worktree_setup::WorktreeSettings,
    // DR2 round 1: *Stop the release*'s flag — it kills the checks, and the
    // release is given up as Stop gives up an open one (`settle_stop`).
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, ShipError> {
    let target = place.target().to_string();
    let pr = pr_of(&mut record).clone();
    let (Some(head), true) = (pr.head.clone(), matches!(pr.step, PrReleaseStep::Open | PrReleaseStep::Merging)) else {
        return Err(format!("{} has no open release pull request to update. Nothing was changed.", record.tag).into());
    };
    crate::worktrees::fetch_origin_branch(place.repo_root, &target)
        .map_err(|e| format!("Plyloft couldn't read {target} on GitHub ({e}). Nothing was changed."))?;
    let base = resolve_commit(place.repo_root, &format!("refs/remotes/origin/{target}"))
        .ok_or_else(|| format!("GitHub has no branch {target}. Nothing was changed."))?;
    if crate::worktrees::is_ancestor(place.repo_root, &base, &head) {
        pr_of(&mut record).outdated = false;
        pr_of(&mut record).checks_failed = false;
        place.save(&record)?;
        return Ok(format!("The release already has {target}'s changes. Nothing was changed."));
    }
    // The local branch at the release's head (made again from the commit if
    // it went).
    let branch_ref = format!("refs/heads/{}", pr.branch);
    match resolve_commit(place.repo_root, &branch_ref) {
        Some(at) if at == head => {}
        Some(_) => {
            return Err(format!(
                "The local {} has moved away from the release, so Plyloft won't update it. Nothing was changed.",
                pr.branch
            )
            .into())
        }
        None => git_run(place.repo_root, &["branch", &pr.branch, &head])?,
    }
    discard_tree_of(place.repo_root, &pr.branch);
    // A copy at the release's head, the branch not checked out in it (m3):
    // the branch moves only once the update is on GitHub.
    let tree = ReleaseTree::add(place.repo_root, &head)?;
    let wt = tree.path.clone();
    if let Err(e) = git_run(&wt, &["merge", "--no-ff", "--no-commit", &base]) {
        let _ = git_run(&wt, &["merge", "--abort"]);
        return Err(format!(
            "{target} on GitHub conflicts with the release, so Plyloft didn't update it: {e} Nothing \
             was pushed. Dismiss the release and release the cards again once they take {target}'s changes."
        )
        .into());
    }
    let subject = format!("chore(release): bring {target} into {}", record.tag);
    commit_in(&wt, &["-m".into(), subject]).map_err(|e| format!("{e} Nothing was pushed."))?;
    let pipeline = place.config.verify_pipeline.clone().unwrap_or_default();
    if !record.skip_verify && !pipeline.is_empty() {
        if let Some(refusal) = checks_refusal(place) {
            return Err(refusal.into());
        }
        // The release copy gets the repository's setup first, as at the build.
        let main_root = crate::worktree_setup::repo_root(place.ws_cwd);
        let path = crate::shell_env::get().path.clone();
        let timeout = std::time::Duration::from_secs(crate::worktree_setup::SETUP_TIMEOUT_SECS);
        let asked = || stop.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst));
        if let Some(done) = crate::worktree_setup::prepare_worktree_until(&main_root, &wt, setup, &path, &[], timeout, stop) {
            // DR2 round 2: a setup Stop killed is the Stop, not a failure.
            if done.state == crate::worktree_setup::WorktreeSetupState::Failed && !asked() {
                return Err(format!(
                    "The release's checks couldn't start: {} Nothing was pushed.",
                    done.reason.unwrap_or_else(|| "its setup failed.".into())
                )
                .into());
            }
        }
        let checks = if asked() {
            crate::verify::TreeChecks { stopped: true, ..Default::default() }
        } else {
            crate::verify::run_script_checks_in(&pipeline, &wt, &[], stop)
        };
        let stopped = checks.stopped;
        if let Some((step, why)) = checks.failed.filter(|_| !stopped) {
            return Err(format!(
                "The checks failed on the release with {target}'s changes: {step}: {} Nothing was pushed.",
                why.trim()
            )
            .into());
        }
    }
    if stop.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst)) {
        drop(tree);
        record.stop_requested = true;
        return Err(match settle_stop(place, &record)? {
            Settled::GivenUp(said) => ShipError::stopped_on_github(&record.tag, &record.version, Some(said)),
            Settled::Kept(kept) => ShipError::Unpublished(crate::worktrees::ReleaseUnpublished {
                unpublished: crate::release_record::view(place.repo_root, kept),
            }),
            Settled::GoesOn(_) => {
                format!("{} merged on GitHub before the Stop, so it goes on. Nothing was pushed.", record.tag).into()
            }
        });
    }
    let new_head = head_of(&wt)?;
    drop(tree);
    let refspec = format!("{new_head}:refs/heads/{}", pr.branch);
    if let Err(failure) = crate::worktrees::release_push(place.repo_root, &refspec, super::ship_push_timeout()) {
        let said = match failure {
            crate::worktrees::ReleasePushFailure::Failed(msg) => msg,
            crate::worktrees::ReleasePushFailure::TimedOut => "the push didn't finish in time".into(),
        };
        return Err(format!("Plyloft couldn't push the updated release: {} Nothing was changed on GitHub.", said.trim()).into());
    }
    // On GitHub: the local branch follows, from the head it was at.
    git_run(place.repo_root, &["update-ref", &branch_ref, &new_head, &head])?;
    record.commit_sha = new_head.clone();
    let p = pr_of(&mut record);
    p.head = Some(new_head);
    p.base = base;
    p.step = PrReleaseStep::Open;
    p.outdated = false;
    p.waiting = None;
    p.checks_failed = false;
    place.save(&record)?;
    let words = format!("The release now has {target}'s changes and passed its checks again; it is merged when its checks on GitHub pass.");
    // Ask GitHub to merge the new head (best effort: the poller goes on).
    if let Err(e) = advance_now(place, record, PRESS_STEPS) {
        log::info!("release_pr: after the update: {e}");
    }
    Ok(words)
}

/// A release copy left from an earlier stop (a quit or a crash mid-build),
/// removed: one with `branch` checked out, or any in a release copy's
/// temporary folder (the branch stays) that no release of this run is using.
fn discard_tree_of(repo_root: &Path, branch: &str) {
    let _ = git_run(repo_root, &["worktree", "prune"]);
    if let Ok(list) = git_capture(repo_root, &["worktree", "list", "--porcelain"]) {
        let wanted = format!("branch refs/heads/{branch}");
        let mut leftovers: Vec<String> = Vec::new();
        let mut path: Option<&str> = None;
        for line in list.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p);
                let live = || live_trees().lock().unwrap_or_else(|e| e.into_inner()).contains(&live_key(Path::new(p)));
                if is_release_copy(p) && !live() {
                    leftovers.push(p.to_string());
                }
            } else if line.trim() == wanted {
                if let Some(p) = path.filter(|p| !is_release_copy(p)) {
                    leftovers.push(p.to_string());
                }
            }
        }
        for p in leftovers {
            remove_tree(repo_root, &p);
        }
    }
}

/// `<tmp>/plyloft-release-…/release`: a release copy's folder.
fn is_release_copy(path: &str) -> bool {
    let p = Path::new(path);
    p.file_name().is_some_and(|n| n == "release")
        && p.parent()
            .and_then(|d| d.file_name())
            .is_some_and(|n| n.to_string_lossy().starts_with(TREE_PREFIX))
}

#[cfg(test)]
#[path = "release_pr_tests.rs"]
mod tests;
