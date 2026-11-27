//! GH #222 review 2: the record of a release Ship committed and tagged on this
//! Mac but has not yet published.
//!
//! Review 1 inferred it from the target branch's `HEAD` (a `v<X.Y.Z>` tag with
//! `Card:` trailers). That evidence was lost as soon as `HEAD` moved — a Land on
//! top, a reconcile's fast-forward after a tag-push timeout — and it could read
//! another Mac's release pulled from origin as this Mac's. The record is
//! explicit evidence from this Mac only: written atomically (AGENTS.md rule 3)
//! **before the first push**, and cleared only when the release is published
//! (every card marked shipped) or the person dismisses it.
//!
//! One per workspace: `<config_dir>/projects/<workspace_id>/pending_release.json`.
//! A missing file is "none". Unknown fields are ignored and every field added
//! after the first is `#[serde(default)]`, so an older or newer Ply reads it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::platform::THIS_MACHINE;
use crate::kanban::ReleaseKind;

pub const FILE: &str = "pending_release.json";

/// Which of a release's two pushes did not finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleasePushStep {
    /// `git push origin <branch>`.
    Branch,
    /// `git push origin <tag>`.
    Tag,
}

/// Why it did not finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushStopCause {
    /// Stopped at its bound (`ship::SHIP_PUSH_TIMEOUT`); it may have landed.
    TimedOut,
    /// origin (or the transport) refused it; `output` has git's words.
    Refused,
    /// origin's branch moved on: the branch push was refused as not a
    /// fast-forward. The tag was pushed; Ply never force-pushes.
    OriginMoved,
}

/// GH #222 review 3: how far the release had got when the record was last
/// written. The record is first written **before** the release commit
/// (`Committing`), so a release Ply made can never lack one; it becomes
/// `Tagged` once the commit and tag exist. A record left at `Committing`
/// means Ply stopped mid-release (quit, crash, a failed write): it can't be
/// published from here, only dismissed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RecordStage {
    Committing,
    /// Default: a record from before review 3 was written after its tag.
    #[default]
    Tagged,
}

/// The record. `stopped_at` / `cause` are empty while the pushes have not
/// reported — which, read back later, means Ply quit or crashed during them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRelease {
    /// `1.0.1`; the tag is `v1.0.1`.
    pub version: String,
    pub tag: String,
    /// The release commit the tag points at.
    pub commit_sha: String,
    /// The target branch.
    pub branch: String,
    /// Every card the release commit carries.
    pub card_ids: Vec<String>,
    /// Per card, the commit its worktree was merged from: its worktree is put
    /// away after publishing only while it still sits there, clean.
    #[serde(default)]
    pub card_revs: BTreeMap<String, String>,
    /// How it was released; a publish uses it (never `Local`).
    pub release_kind: ReleaseKind,
    /// Ship's skip-verify: the cards are marked `Skipped` when it ships.
    #[serde(default)]
    pub skip_verify: bool,
    #[serde(default)]
    pub stopped_at: Option<ReleasePushStep>,
    #[serde(default)]
    pub cause: Option<PushStopCause>,
    /// git's own words for a refusal, for `Details`.
    #[serde(default)]
    pub output: Option<String>,
    /// The push bound in words ("5 minutes"), for a timeout.
    #[serde(default)]
    pub bound: Option<String>,
    /// Unix ms.
    pub created_at: i64,
    #[serde(default)]
    pub stage: RecordStage,
    /// R7 (Challenger MAJOR 2): the commit the project folder was at when the
    /// release began. A batch commits each card's merge as a temporary commit
    /// on the branch; a release left at `Committing` says how to go back
    /// here. `None` in a record from before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_commit: Option<String>,
    /// R9: the branch push was refused because the branch is protected on
    /// GitHub (`ship::refused_as_protected`). The tag was not pushed then, so
    /// the release can be undone here (`PendingReleaseView::undo`). `false`
    /// in a record from before it.
    #[serde(default)]
    pub protected: bool,
    /// R9 (Challenger minor): an earlier attempt pushed the tag (origin's
    /// branch had moved on), so a later refusal is never "nothing was
    /// pushed" and offers no Undo. `false` in a record from before it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tag_pushed: bool,
    /// G8 (1.170.0): a release through a pull request (a GitHub project):
    /// how far it got. `None` for a release made on the target branch here
    /// (no GitHub, or a record from before it). Such a record keeps `stage`
    /// at `Committing` until it is done, so an older Plyloft that reads it
    /// offers only Dismiss and never pushes the target branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<ReleasePr>,
    /// 1.174.0 (DR2, D1(b)): the cards already on the target since the last
    /// release (shipped with Ship it as pull requests, `release_scope`): the
    /// release carries them without merging them again, and once it is done
    /// each gets a ship-history entry with this release's tag and commit.
    /// Never in `card_ids`. Empty in a record from before it, and in one of
    /// a release with nothing merged since its last tag.
    #[serde(default)]
    pub merged_card_ids: Vec<String>,
    /// 1.174.0 (DR2): the area's last release the counts are from
    /// (`site-v3.0.1`); `None` before the first, and in an older record.
    #[serde(default)]
    pub since_tag: Option<String>,
    /// 1.174.0 (DR2): how many changes on the target since `since_tag` are
    /// not from a card (`release_scope`'s `other_total`); 0 in an older
    /// record.
    #[serde(default)]
    pub other_changes: u32,
    /// 1.174.0 (DR2): *Stop the release* was pressed while a press was
    /// making or sending it. Written by the press itself (never by Stop), so
    /// a quit before the press took it back leaves a record that says to
    /// withdraw it (`release_pr::settle_stop`), never to go on. Not written
    /// while false: an older Plyloft reads the file unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stop_requested: bool,
}

/// G8 (1.170.0): the steps of a release through a pull request, in order.
/// Each is written (atomically) as soon as it is reached, so a quit or a
/// crash resumes from the last one: nothing is pushed twice, no pull
/// request is opened twice, and the tag is made only on the merge commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PrReleaseStep {
    /// The release branch is being made on this computer (one commit per
    /// card and the version commit, then the checks). Nothing is pushed.
    /// With no `head`, a stop here is made again from the start.
    #[default]
    Building,
    /// Made and checked: `head` is its last commit, kept on the local
    /// branch. Its push hasn't reported yet.
    Built,
    /// On GitHub at `head`; no pull request yet.
    Pushed,
    /// The pull request is open (`number`, `url`); no merge asked yet.
    Open,
    /// GitHub was asked to merge it when its checks pass (or Plyloft merges
    /// it then, when the repository doesn't allow that).
    Merging,
    /// Merged as `merge_commit`; the tag isn't on GitHub yet.
    Merged,
    /// The tag is on GitHub; the GitHub release (for that kind) and the
    /// cards' shipped state are what is left.
    Tagged,
}

/// G8 (1.170.0): what a release through a pull request knows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePr {
    #[serde(default)]
    pub step: PrReleaseStep,
    /// `plyloft/release-vX.Y.Z` (1.173.0: an area's carries its tag prefix,
    /// `plyloft/release-site-vX.Y.Z`).
    pub branch: String,
    /// GitHub's target branch (`origin/<target>`) the release was built on.
    #[serde(default)]
    pub base: String,
    /// The release branch's last commit, once made.
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub number: Option<u64>,
    #[serde(default)]
    pub url: Option<String>,
    /// When Plyloft opened (or found) it, Unix ms: a repository that reports
    /// no checks is taken to have none only a while after it.
    #[serde(default)]
    pub opened_at: Option<i64>,
    /// The commit the merge made on the target (the tag goes here).
    #[serde(default)]
    pub merge_commit: Option<String>,
    /// `gh release create` answered (the "Publish a GitHub release" kind).
    #[serde(default)]
    pub release_created: bool,
    /// Why it is still waiting, in words (checks running, a review).
    #[serde(default)]
    pub waiting: Option<String>,
    /// Why it can't go on by itself (closed without merging, a push GitHub
    /// refused); the card offers Dismiss.
    #[serde(default)]
    pub problem: Option<String>,
    /// GitHub's target moved on and the pull request is behind it or
    /// conflicts with it: **Update the release** brings the target's changes
    /// in on the person's press (never by itself, never forced).
    #[serde(default)]
    pub outdated: bool,
    /// The checks run on the combined change before it was pushed (their
    /// labels), and the ones not run there (a Claude check).
    #[serde(default)]
    pub checks_run: Vec<String>,
    #[serde(default)]
    pub checks_not_run: Vec<String>,
    /// 1.171.0 F3: the last read of the merging pull request found GitHub on
    /// its way to merging it (its checks running, its auto-merge on); the
    /// poller then reads it every tick. Older records load as false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub merge_on_its_way: bool,
    /// 1.172.0 B2: who merges it — `true` when Plyloft merges it itself
    /// (GitHub's auto-merge wasn't turned on: the repository refused it, or
    /// the target requires no checks), so it merges only while Plyloft is
    /// open and a quit says so (`plyloft_merges_pending`). Set where the
    /// merge is asked (`release_pr::advance`, step Open). Older records load
    /// as false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plyloft_merges: bool,
    /// 1.174.0 (DR4 round 1): the last read found GitHub's checks failed on
    /// it — it waits for the person (Needs you, the sheet's merge step says
    /// so). Cleared by any other read. Older records load as false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub checks_failed: bool,
}

impl ReleasePr {
    pub fn new(branch: String, base: String) -> Self {
        Self {
            step: PrReleaseStep::Building,
            branch,
            base,
            head: None,
            number: None,
            url: None,
            opened_at: None,
            merge_commit: None,
            release_created: false,
            waiting: None,
            problem: None,
            outdated: false,
            checks_run: Vec::new(),
            checks_not_run: Vec::new(),
            merge_on_its_way: false,
            plyloft_merges: false,
            checks_failed: false,
        }
    }
}

/// 1.172.0 B2: the release waits for Plyloft's own merge — asked of no one
/// on GitHub, so it merges only while Plyloft is open (the quit note counts
/// it with the cards' pull requests).
pub fn plyloft_merges_pending(record: &PendingRelease) -> bool {
    record
        .pr
        .as_ref()
        .is_some_and(|pr| pr.plyloft_merges && pr.problem.is_none() && pr.step == PrReleaseStep::Merging)
}

/// R9: what Plyloft says of a protected target branch when the push is
/// refused.
pub fn protected_words(branch: &str) -> String {
    // G8 (1.170.0): a GitHub project releases through a pull request, so this
    // is said of another server's protection (GitLab, Gitea) or of a record
    // from before it.
    format!(
        "{branch} is protected, so Plyloft can't push a release to it directly. On GitHub, \
         Plyloft releases through a pull request instead."
    )
}

/// What the window is told: the record, and — when it can't be published from
/// here — why (`problem`). Dismiss is then the only way out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingReleaseView {
    #[serde(flatten)]
    pub record: PendingRelease,
    pub problem: Option<String>,
    /// R9: *Undo the local release* is offered — the branch push was refused
    /// as protected, so neither the branch nor the tag was pushed, and the
    /// record knows the commit the release began on. The undo checks origin
    /// again (`ship::undo_local_release`).
    #[serde(default)]
    pub undo: bool,
}

pub fn path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(FILE)
}

/// The record, or `None` when there is none. A file that can't be parsed is
/// an error (never silently "none": that would let a second release stack on
/// an unpublished one).
pub fn load(workspace_dir: &Path) -> Result<Option<PendingRelease>, String> {
    let file = path(workspace_dir);
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", file.display())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("Plyloft's record of an unpublished release ({}) can't be read: {e}", file.display()))
}

/// Written with tempfile + rename.
pub fn save(workspace_dir: &Path, record: &PendingRelease) -> Result<(), String> {
    crate::atomic::write_atomic_json(&path(workspace_dir), record)
}

/// 1.174.0 (DR4 round 1): the releases this computer finished, newest last
/// (at most `RELEASE_LOG_MAX`) — what the Inbox's News says of a release,
/// also one that carried no card ("site-v3.0.2 released · 2 other
/// changes"). A file of its own beside the record (`released.json`), written
/// with tempfile + rename; absent or unreadable reads as none.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleasedEntry {
    pub tag: String,
    /// Unix ms.
    pub at: i64,
    /// The cards it carried (ticked and already on the target).
    #[serde(default)]
    pub cards: u32,
    #[serde(default)]
    pub other_changes: u32,
    /// With exactly one card: that card, for the row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_title: Option<String>,
}

pub const RELEASE_LOG_FILE: &str = "released.json";
pub const RELEASE_LOG_MAX: usize = 20;

pub fn load_released(workspace_dir: &Path) -> Vec<ReleasedEntry> {
    std::fs::read(workspace_dir.join(RELEASE_LOG_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Add a finished release (the same tag once), keeping the newest.
pub fn append_released(workspace_dir: &Path, entry: ReleasedEntry) -> Result<(), String> {
    let mut list = load_released(workspace_dir);
    list.retain(|e| e.tag != entry.tag);
    list.push(entry);
    let skip = list.len().saturating_sub(RELEASE_LOG_MAX);
    let list: Vec<ReleasedEntry> = list.into_iter().skip(skip).collect();
    crate::atomic::write_atomic_json(&workspace_dir.join(RELEASE_LOG_FILE), &list)
}

/// Gone. A record already gone is not an error.
pub fn clear(workspace_dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(path(workspace_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove the pending-release record: {e}")),
    }
}

/// GH #222 review 3: what the window is told about a workspace's record — the
/// record (with its problem, if any), or why the file can't be read. Dismiss
/// works for both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingReleaseState {
    pub release: Option<PendingReleaseView>,
    pub unreadable: Option<String>,
}

/// True when `sha` is on the local `branch` (reachable from its tip).
fn on_branch(repo_root: &Path, sha: &str, branch: &str) -> bool {
    crate::git::run(
        repo_root,
        &["merge-base", "--is-ancestor", sha, &format!("refs/heads/{branch}")],
    )
    .is_ok()
}

/// The record with what this checkout says about it: it must have been
/// tagged, its tag must still exist here and point at its commit, and
/// (review 3) that commit must still be on its branch — or it can't be
/// published from here.
pub fn view(repo_root: &Path, record: PendingRelease) -> PendingReleaseView {
    // G8: a release through a pull request says its own problem, if any; it
    // is never undone here (its branch is on GitHub, not the target).
    if let Some((problem, branch)) = record.pr.as_ref().map(|pr| (pr.problem.clone(), pr.branch.clone())) {
        let mut record = record;
        // G8 fixes (m6): recorded at "Building" with no build of it running
        // now — a quit or a crash stopped it, and Continue makes it again.
        if crate::ship::release_pr::unbuilt(&record)
            && !crate::ship::release_pr::building_now(repo_root, &branch)
        {
            let words = crate::ship::release_pr::stopped_building_words(&record.tag);
            if let Some(pr) = record.pr.as_mut() {
                pr.waiting = Some(words);
            }
        }
        return PendingReleaseView { record, problem, undo: false };
    }
    let tag_commit = crate::git::capture(
        repo_root,
        &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{}^{{commit}}", record.tag)],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    // Review 3–4: a record left at `Committing` — Ply stopped mid-release. Its
    // words follow what is there: with no tag, a staged merge may be left.
    if record.stage == RecordStage::Committing {
        let problem = if tag_commit.is_some() {
            format!(
                "Plyloft stopped just after making {tag} — its record was never finished — so it won't \
                 publish it on its own. Nothing was pushed. Look at `git log` and `git tag` on {branch}.",
                tag = record.tag,
                branch = record.branch
            )
        } else if let Some(words) = temporary_commits_left(repo_root, &record) {
            words
        } else {
            format!(
                "Plyloft stopped while making {tag}, before it was tagged, so there is nothing to \
                 publish. Nothing was pushed, but a staged merge may be left in the checkout: check \
                 `git status`, then `git log` and `git tag` on {branch}.",
                tag = record.tag,
                branch = record.branch
            )
        };
        return PendingReleaseView { record, problem: Some(problem), undo: false };
    }
    let problem = match tag_commit {
        None => Some(format!(
            "The tag {} no longer exists on {THIS_MACHINE}, so Plyloft can't tell what to publish.",
            record.tag
        )),
        Some(sha) if sha != record.commit_sha => Some(format!(
            "The tag {} now points at another commit than the release Plyloft made, so Plyloft won't publish it.",
            record.tag
        )),
        Some(_) if !on_branch(repo_root, &record.commit_sha, &record.branch) => Some(format!(
            "The release commit of {} is no longer on {} (it was reset or rebased away), so \
             pushing {} would not publish it.",
            record.tag, record.branch, record.branch
        )),
        Some(_) => None,
    };
    // R9 (Challenger MAJOR): a record written before `protected` (1.169.0)
    // is read from git's words, so the people stuck on it get the words and
    // the way out too.
    let mut record = record;
    record.protected = !record.tag_pushed && (record.protected || refused_as_protected_here(&record));
    let undo = problem.is_none()
        && record.protected
        && record.stopped_at == Some(ReleasePushStep::Branch)
        && undo_start(repo_root, &record).is_some();
    PendingReleaseView { record, problem, undo }
}

/// A branch push refused in words that say the branch is protected.
fn refused_as_protected_here(record: &PendingRelease) -> bool {
    record.stopped_at == Some(ReleasePushStep::Branch)
        && record.cause == Some(PushStopCause::Refused)
        && record.output.as_deref().is_some_and(crate::ship::refused_as_protected)
}

/// R9: the commit an undo puts the branch back on — the record's
/// `start_commit`, or for a record from before it (1.169.0) the release
/// commit's parent when it has exactly one (a release commit is one commit
/// on its start).
pub fn undo_start(repo_root: &Path, record: &PendingRelease) -> Option<String> {
    if let Some(start) = record.start_commit.as_deref().filter(|s| !s.is_empty()) {
        return Some(start.to_string());
    }
    if record.commit_sha.is_empty() {
        return None;
    }
    let line = crate::git::capture(repo_root, &["rev-list", "--parents", "-n", "1", &record.commit_sha]).ok()?;
    let ids: Vec<&str> = line.split_whitespace().collect();
    (ids.len() == 2).then(|| ids[1].to_string())
}

/// R7 (Challenger MAJOR 2): a batch stopped mid-way (a quit, a crash) can
/// leave its cards' temporary commits on the branch (`ship::BATCH_STEP_PREFIX`).
/// They are named, with the exact way back to the commit the release began
/// on — which Plyloft never runs itself. `None` when the branch holds none.
fn temporary_commits_left(repo_root: &Path, record: &PendingRelease) -> Option<String> {
    let start = record.start_commit.as_deref()?;
    let range = format!("{start}..refs/heads/{}", record.branch);
    let subjects = crate::git::capture(repo_root, &["log", "--format=%s", &range]).ok()?;
    let subjects: Vec<&str> = subjects.lines().filter(|l| !l.is_empty()).collect();
    let temporary: Vec<&str> = subjects
        .iter()
        .copied()
        .filter(|s| s.starts_with(crate::ship::BATCH_STEP_PREFIX))
        .collect();
    if temporary.is_empty() {
        return None;
    }
    let (tag, branch) = (&record.tag, &record.branch);
    let short = &start[..start.len().min(12)];
    let listed = temporary.iter().map(|s| format!("“{s}”")).collect::<Vec<_>>().join(", ");
    let commits = if temporary.len() == 1 { "a temporary commit" } else { "temporary commits" };
    let others = subjects.len() - temporary.len();
    let way_back = if others == 0 {
        format!(
            "To put {branch} back where it was before the release, run `git reset --hard {short}` in \
             the project folder. That also drops any change there that isn't in a commit, so check \
             `git status` first."
        )
    } else {
        format!(
            "{branch} also has {others} other commit(s) since the release began ({short}), so don't \
             simply reset it: look at `git log {short}..{branch}` and keep what is yours."
        )
    };
    Some(format!(
        "Plyloft stopped while making {tag}, before it was tagged, so there is nothing to publish. \
         Nothing was pushed, but {branch} still has {commits} Plyloft made while merging the batch: \
         {listed}. {way_back}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> PendingRelease {
        PendingRelease {
            version: "1.0.1".into(),
            tag: "v1.0.1".into(),
            commit_sha: "abc".into(),
            branch: "main".into(),
            card_ids: vec!["card-1".into()],
            card_revs: BTreeMap::new(),
            release_kind: ReleaseKind::PushOnly,
            skip_verify: false,
            stopped_at: Some(ReleasePushStep::Tag),
            cause: Some(PushStopCause::TimedOut),
            output: None,
            bound: Some("5 minutes".into()),
            created_at: 1,
            stage: RecordStage::Tagged,
            start_commit: None,
            protected: false,
            tag_pushed: false,
            pr: None,
            merged_card_ids: Vec::new(),
            since_tag: None,
            other_changes: 0,
            stop_requested: false,
        }
    }

    /// Missing file: none. Round trip through the atomic write, no temp file
    /// left. Cleared twice: fine.
    #[test]
    fn missing_is_none_and_it_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        save(dir.path(), &record()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(record()));
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![FILE.to_string()]);
        clear(dir.path()).unwrap();
        clear(dir.path()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
    }

    /// Backward compatible: the first shape (no optional fields) loads with
    /// defaults, and fields a later Ply adds are ignored.
    #[test]
    fn an_older_or_newer_record_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path(dir.path()),
            r#"{
              "version": "1.0.1", "tag": "v1.0.1", "commitSha": "abc", "branch": "main",
              "cardIds": ["card-1"], "releaseKind": "github", "createdAt": 7,
              "someFieldFromTheFuture": { "x": 1 }
            }"#,
        )
        .unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.release_kind, ReleaseKind::Github);
        assert_eq!(loaded.stopped_at, None);
        assert_eq!(loaded.cause, None);
        assert!(loaded.card_revs.is_empty());
        assert!(!loaded.skip_verify);
        assert_eq!(loaded.created_at, 7);
        // Review 3: a record from before `stage` was written after its tag.
        assert_eq!(loaded.stage, RecordStage::Tagged);
        // R9: a record from before `protected` was no protection refusal.
        assert!(!loaded.protected);
    }

    /// R9: `protected` round-trips, and Undo is offered only for a tagged
    /// release whose branch push was refused as protected (so its tag was
    /// never pushed) and whose record knows where it began.
    #[test]
    fn undo_is_offered_only_for_a_branch_push_refused_as_protected() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let git = |args: &[&str]| crate::git::capture(repo, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        for (k, v) in [("user.email", "t@t"), ("user.name", "t"), ("commit.gpgsign", "false")] {
            git(&["config", k, v]);
        }
        git(&["commit", "-q", "--allow-empty", "-m", "start"]);
        let start = git(&["rev-parse", "HEAD"]).trim().to_string();
        let root = start.clone();
        git(&["commit", "-q", "--allow-empty", "-m", "chore(release): v1.0.1"]);
        git(&["tag", "v1.0.1"]);
        let sha = git(&["rev-parse", "HEAD"]).trim().to_string();
        let refused = PendingRelease {
            commit_sha: sha,
            stopped_at: Some(ReleasePushStep::Branch),
            cause: Some(PushStopCause::Refused),
            output: Some("GH006: Protected branch update failed".into()),
            start_commit: Some(start),
            protected: true,
            ..record()
        };
        let ws = tempfile::tempdir().unwrap();
        save(ws.path(), &refused).unwrap();
        assert_eq!(load(ws.path()).unwrap(), Some(refused.clone()));
        let v = view(repo, refused.clone());
        assert!(v.problem.is_none() && v.undo, "{v:?}");
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!((wire["protected"].as_bool(), wire["undo"].as_bool()), (Some(true), Some(true)));

        for (why, other) in [
            ("not protected", PendingRelease { protected: false, output: Some("no".into()), ..refused.clone() }),
            ("the tag went before", PendingRelease { tag_pushed: true, ..refused.clone() }),
            ("stopped at the tag", PendingRelease { stopped_at: Some(ReleasePushStep::Tag), ..refused.clone() }),
            ("no start, a root commit", PendingRelease { start_commit: None, commit_sha: root.clone(), ..refused.clone() }),
            ("mid-release", PendingRelease { stage: RecordStage::Committing, ..refused.clone() }),
            ("tag moved", PendingRelease { commit_sha: "0".repeat(40), ..refused.clone() }),
        ] {
            assert!(!view(repo, other).undo, "{why}");
        }

        // Challenger MAJOR: a 1.169.0 record — no `protected`, no
        // `startCommit` — refused in GitHub's protection words gets the
        // words and Undo, back to the release commit's one parent.
        let mut old = serde_json::to_value(PendingRelease { protected: false, start_commit: None, ..refused.clone() }).unwrap();
        old.as_object_mut().unwrap().remove("protected");
        std::fs::write(path(ws.path()), old.to_string()).unwrap();
        let loaded = load(ws.path()).unwrap().unwrap();
        assert!(!loaded.protected && loaded.start_commit.is_none());
        let v = view(repo, loaded.clone());
        assert!(v.record.protected && v.undo, "{v:?}");
        assert_eq!(undo_start(repo, &loaded).as_deref(), Some(root.as_str()));
        // Another refusal's words: neither.
        let v = view(repo, PendingRelease { output: Some("no releases today".into()), ..loaded });
        assert!(!v.record.protected && !v.undo, "{v:?}");
    }

    /// R7 (Challenger MAJOR 2): `startCommit` is optional — a record from
    /// before it loads unchanged — and round-trips when present.
    #[test]
    fn a_record_without_its_start_commit_loads_and_one_with_it_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let old = serde_json::to_value(record()).unwrap();
        assert!(old.get("startCommit").is_none(), "not written when unknown");
        std::fs::write(path(dir.path()), old.to_string()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(record()));
        let with = PendingRelease { start_commit: Some("abc123".into()), ..record() };
        save(dir.path(), &with).unwrap();
        assert_eq!(load(dir.path()).unwrap().unwrap().start_commit.as_deref(), Some("abc123"));
    }

    /// R7 (Challenger MAJOR 2): a batch left at `Committing` with its
    /// temporary commits on the branch names them and the way back; with a
    /// commit of the member's after them, it says not to simply reset.
    #[test]
    fn a_batch_stopped_mid_way_names_its_temporary_commits_and_the_way_back() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let git = |args: &[&str]| crate::git::capture(repo, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        for (k, v) in [("user.email", "t@t"), ("user.name", "t"), ("commit.gpgsign", "false")] {
            git(&["config", k, v]);
        }
        git(&["commit", "-q", "--allow-empty", "-m", "start"]);
        let start = git(&["rev-parse", "HEAD"]).trim().to_string();
        let temp = format!("{}“Card” (temporary, folded into the release)", crate::ship::BATCH_STEP_PREFIX);
        git(&["commit", "-q", "--allow-empty", "-m", &temp]);
        let stopped = PendingRelease {
            stage: RecordStage::Committing,
            start_commit: Some(start.clone()),
            ..record()
        };
        let problem = view(repo, stopped.clone()).problem.unwrap();
        assert!(problem.contains(&format!("“{temp}”")), "{problem}");
        assert!(problem.contains(&format!("`git reset --hard {}`", &start[..12])), "{problem}");

        git(&["commit", "-q", "--allow-empty", "-m", "mine"]);
        let problem = view(repo, stopped.clone()).problem.unwrap();
        assert!(problem.contains("1 other commit(s)") && !problem.contains("reset --hard"), "{problem}");

        // Without a start commit (an older record): the words as before.
        let problem = view(repo, PendingRelease { start_commit: None, ..stopped }).problem.unwrap();
        assert!(problem.contains("a staged merge may be left"), "{problem}");
    }

    /// G8 (1.170.0): `pr` is optional and additive — a 1.169.1 record (no
    /// `pr`) loads unchanged and is written back without it; a release
    /// through a pull request round-trips, a `pr` written with only its
    /// branch loads with every other field defaulted, and its view says its
    /// own problem and never offers Undo.
    #[test]
    fn a_record_without_a_pull_request_loads_and_one_with_it_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path(dir.path()),
            r#"{
              "version": "1.0.1", "tag": "v1.0.1", "commitSha": "abc", "branch": "main",
              "cardIds": ["card-1"], "releaseKind": "push_only", "createdAt": 7, "stage": "tagged",
              "startCommit": "s", "protected": true, "tagPushed": true,
              "stoppedAt": "branch", "cause": "refused", "output": "GH006"
            }"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap().unwrap();
        assert_eq!(old.pr, None);
        assert!(old.protected && old.tag_pushed && old.start_commit.as_deref() == Some("s"));
        save(dir.path(), &old).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert!(wire.get("pr").is_none(), "not written when absent: {wire}");

        let mut pr = ReleasePr::new("plyloft/release-v1.0.1".into(), "b".into());
        pr.step = PrReleaseStep::Merging;
        pr.head = Some("h".into());
        pr.number = Some(5);
        pr.url = Some("https://github.com/o/r/pull/5".into());
        pr.checks_not_run = vec!["/ppvp".into()];
        let with = PendingRelease { stage: RecordStage::Committing, pr: Some(pr), ..record() };
        save(dir.path(), &with).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(with.clone()));
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert_eq!(wire["pr"]["step"], "merging");
        assert_eq!(wire["stage"], "committing", "an older Plyloft offers only Dismiss");

        let mut bare = serde_json::to_value(record()).unwrap();
        bare["pr"] = serde_json::json!({ "branch": "plyloft/release-v1.0.1" });
        std::fs::write(path(dir.path()), bare.to_string()).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap().pr.unwrap();
        assert_eq!(loaded, ReleasePr::new("plyloft/release-v1.0.1".into(), String::new()));

        let repo = tempfile::tempdir().unwrap();
        let mut stuck = with.pr.clone().unwrap();
        stuck.problem = Some("closed".into());
        let v = view(repo.path(), PendingRelease { pr: Some(stuck), protected: true, ..with });
        assert_eq!((v.problem.as_deref(), v.undo), (Some("closed"), false));
    }

    /// 1.171.0 F3: `mergeOnItsWay` — a record from 1.170 (without it) loads
    /// as false; set, it round-trips; unset, it isn't written (an older
    /// Plyloft reads the file unchanged).
    #[test]
    fn a_pull_request_without_merge_on_its_way_loads_and_one_with_it_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = serde_json::to_value(record()).unwrap();
        old["pr"] = serde_json::json!({ "branch": "plyloft/release-v1.0.1", "step": "merging",
            "waiting": "#5 waits for its checks on GitHub." });
        std::fs::write(path(dir.path()), old.to_string()).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        assert!(!loaded.pr.as_ref().unwrap().merge_on_its_way);
        save(dir.path(), &loaded).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert!(wire["pr"].get("mergeOnItsWay").is_none(), "not written when false: {wire}");
        let mut on = loaded.clone();
        on.pr.as_mut().unwrap().merge_on_its_way = true;
        save(dir.path(), &on).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert_eq!(wire["pr"]["mergeOnItsWay"], true);
        assert_eq!(load(dir.path()).unwrap(), Some(on));
    }

    /// 1.172.0 B2: `plyloftMerges` — a record from 1.171 (without it) loads
    /// as false and isn't counted by the quit note; set, it round-trips and
    /// counts only while the release is merging with no problem.
    #[test]
    fn a_pull_request_without_plyloft_merges_loads_and_one_with_it_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = serde_json::to_value(record()).unwrap();
        old["pr"] = serde_json::json!({ "branch": "plyloft/release-v1.0.1", "step": "merging",
            "waiting": "Plyloft merges the release pull request once its checks on GitHub pass." });
        std::fs::write(path(dir.path()), old.to_string()).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        assert!(!loaded.pr.as_ref().unwrap().plyloft_merges);
        assert!(!plyloft_merges_pending(&loaded), "an older record is not counted");
        save(dir.path(), &loaded).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert!(wire["pr"].get("plyloftMerges").is_none(), "not written when false: {wire}");
        let mut on = loaded.clone();
        on.pr.as_mut().unwrap().plyloft_merges = true;
        save(dir.path(), &on).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert_eq!(wire["pr"]["plyloftMerges"], true);
        assert_eq!(load(dir.path()).unwrap(), Some(on.clone()));
        assert!(plyloft_merges_pending(&on));
        // Only while it is merging and nothing stopped it.
        for step in [PrReleaseStep::Open, PrReleaseStep::Merged, PrReleaseStep::Tagged] {
            let mut other = on.clone();
            other.pr.as_mut().unwrap().step = step;
            assert!(!plyloft_merges_pending(&other), "{step:?}");
        }
        let mut stuck = on.clone();
        stuck.pr.as_mut().unwrap().problem = Some("closed".into());
        assert!(!plyloft_merges_pending(&stuck));
        assert!(!plyloft_merges_pending(&record()), "a release made here");
    }

    /// 1.174.0 (DR2), schema migration (PATTERNS v1.11.x): the four fields
    /// are additive. A 1.173 record (none of them) loads with them defaulted
    /// and is written back without `stopRequested`; a 1.174 record of a
    /// release with no card of its own round-trips with them; and since a
    /// 1.173 Plyloft ignores fields it doesn't know (no `deny_unknown_fields`
    /// here, ever), it reads that record as an ordinary one whose `cardIds`
    /// is empty — which its readers take without a panic (`view` below; the
    /// ship-side readers in `ship_area_tests`).
    #[test]
    fn a_release_with_no_card_of_its_own_loads_in_older_and_newer_plyloft() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = serde_json::to_value(record()).unwrap();
        for key in ["mergedCardIds", "sinceTag", "otherChanges", "stopRequested"] {
            old.as_object_mut().unwrap().remove(key);
        }
        old["pr"] = serde_json::json!({ "branch": "plyloft/release-v1.0.1", "step": "open", "number": 7 });
        std::fs::write(path(dir.path()), old.to_string()).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        assert!(loaded.merged_card_ids.is_empty() && loaded.since_tag.is_none());
        assert_eq!((loaded.other_changes, loaded.stop_requested), (0, false));
        save(dir.path(), &loaded).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert!(wire.get("stopRequested").is_none(), "not written when false: {wire}");
        assert_eq!(wire["cardIds"], serde_json::json!(["card-1"]));

        let newer = PendingRelease {
            card_ids: Vec::new(),
            merged_card_ids: vec!["card-merged".into()],
            since_tag: Some("v1.0.0".into()),
            other_changes: 2,
            stop_requested: true,
            stage: RecordStage::Committing,
            pr: Some(ReleasePr::new("plyloft/release-v1.0.1".into(), "base".into())),
            ..record()
        };
        save(dir.path(), &newer).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(newer.clone()));
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert_eq!(wire["cardIds"], serde_json::json!([]));
        assert_eq!((wire["mergedCardIds"][0].as_str(), wire["otherChanges"].as_u64()), (Some("card-merged"), Some(2)));
        assert_eq!((wire["sinceTag"].as_str(), wire["stopRequested"].as_bool()), (Some("v1.0.0"), Some(true)));
        assert_eq!(wire["stage"], "committing", "an older Plyloft offers only Dismiss");

        // The view of it, with and without its pull request, never panics.
        let repo = tempfile::tempdir().unwrap();
        let v = view(repo.path(), newer.clone());
        assert!(v.record.card_ids.is_empty() && !v.undo);
        let v = view(repo.path(), PendingRelease { pr: None, ..newer.clone() });
        assert!(v.problem.is_some() && !v.undo, "{v:?}");
        let v = view(repo.path(), PendingRelease { pr: None, stage: RecordStage::Tagged, ..newer });
        assert!(v.problem.is_some(), "its tag isn't here: {v:?}");
    }

    /// 1.174.0 (DR4 round 1), schema migration (PATTERNS v1.11.x):
    /// `checksFailed` is additive — an older pull request record loads
    /// without it as false and is written back without it; one with it
    /// round-trips, and an older Plyloft ignores the field it doesn't know.
    #[test]
    fn checks_failed_loads_in_older_and_newer_plyloft() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = serde_json::to_value(record()).unwrap();
        old["pr"] = serde_json::json!({ "branch": "plyloft/release-v1.0.1", "step": "merging", "number": 7 });
        std::fs::write(path(dir.path()), old.to_string()).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        assert!(!loaded.pr.as_ref().unwrap().checks_failed);
        save(dir.path(), &loaded).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert!(wire["pr"].get("checksFailed").is_none(), "not written when false: {wire}");

        let mut pr = ReleasePr::new("plyloft/release-v1.0.1".into(), "b".into());
        pr.step = PrReleaseStep::Merging;
        pr.checks_failed = true;
        let newer = PendingRelease { stage: RecordStage::Committing, pr: Some(pr), ..record() };
        save(dir.path(), &newer).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(newer));
        let wire: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert_eq!(wire["pr"]["checksFailed"], serde_json::json!(true));
    }

    /// 1.174.0 (DR4 round 1): the finished releases' log — absent reads as
    /// none, a tag once, the newest kept; an entry without the optional
    /// fields loads (a later field is additive).
    #[test]
    fn the_released_log_keeps_the_newest_once() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_released(dir.path()).is_empty());
        for i in 0..(RELEASE_LOG_MAX + 3) {
            append_released(dir.path(), ReleasedEntry { tag: format!("v1.0.{i}"), at: i as i64, cards: 0, other_changes: 1, card_id: None, card_title: None }).unwrap();
        }
        append_released(dir.path(), ReleasedEntry { tag: "v1.0.22".into(), at: 99, cards: 1, other_changes: 0, card_id: Some("c".into()), card_title: Some("T".into()) }).unwrap();
        let list = load_released(dir.path());
        assert_eq!(list.len(), RELEASE_LOG_MAX);
        assert_eq!(list.iter().filter(|e| e.tag == "v1.0.22").count(), 1);
        assert_eq!(list.last().unwrap().at, 99);
        std::fs::write(dir.path().join(RELEASE_LOG_FILE), r#"[{"tag":"v2.0.0","at":5}]"#).unwrap();
        assert_eq!(load_released(dir.path())[0].cards, 0);
    }

    /// An unreadable record is an error, never "none".
    #[test]
    fn an_unreadable_record_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), "{ not json").unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(err.contains("can't be read"), "{err}");
    }
}
