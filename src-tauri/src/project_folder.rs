//! F1 (1.172.1, owner 2026-10-28): the project folder's true facts, for the
//! Board's "Your project folder is from 16 Sep" and the Sync log.
//!
//! The reconcile's local-branch outcome ([`crate::worktrees::fast_forward_local`])
//! is about the **target branch** (`project_config.target_branch`). The person
//! sees the **folder**: whatever branch it has checked out, the date of its
//! last commit, and how far GitHub's target is beyond it. Before this, a folder
//! on `main` while cards used `staging` heard "Your project folder is behind
//! GitHub" with a count that matched nothing it could see.
//!
//! Everything here is read-only except [`bring_up_to_date`], which moves only
//! the branch the folder already has checked out, only forward, only from its
//! own GitHub copy — the same `fast_forward_local` every Sync runs. It never
//! switches the folder's branch, rewrites, stashes or pushes.

use serde::Serialize;
use std::path::Path;

use crate::git::capture as run_git;
use crate::worktrees::{fast_forward_local, LocalBranchReport, LocalBranchSync};

/// How many changed paths the facts carry (the count is always whole).
pub const CHANGED_PATHS_CAP: usize = 20;
/// How many files the changes sheet draws.
pub const SHEET_FILES_CAP: usize = 50;

/// What the project folder is, read right after the reconcile's fetch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFacts {
    /// The branch the folder has checked out; `None` when it has none
    /// (a detached checkout).
    pub branch: Option<String>,
    /// The folder's current commit.
    pub head: Option<String>,
    /// When that commit was made (unix seconds).
    pub head_at: Option<i64>,
    /// The target branch on this Mac (`refs/heads/<target>`), if it exists.
    pub target_local: Option<String>,
    /// GitHub's target as last fetched (`refs/remotes/origin/<target>`).
    pub target_remote: Option<String>,
    /// Commits GitHub's target has that the folder's commit doesn't.
    pub newer: u32,
    /// Commits the folder's commit has that GitHub's target doesn't.
    pub only_here: u32,
    /// Files with changes not in a commit (tracked files only, as the
    /// fast-forward's own check counts them).
    pub changed_count: u32,
    /// The first [`CHANGED_PATHS_CAP`] of them, repo-relative.
    pub changed_paths: Vec<String>,
}

fn trimmed(s: String) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

fn commit(cwd: &Path, rev: &str) -> Option<String> {
    run_git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .ok()
        .and_then(trimmed)
}

fn count(cwd: &Path, from: &str, to: &str) -> u32 {
    run_git(cwd, &["rev-list", "--count", &format!("{from}..{to}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// The branch the folder has checked out, `None` when detached.
pub fn current_branch(cwd: &Path) -> Option<String> {
    run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().and_then(trimmed)
}

/// Paths of `git status --porcelain --untracked-files=no` (a rename's
/// destination only), with the whole count.
fn tracked_changes(cwd: &Path) -> Option<(u32, Vec<String>)> {
    let status = run_git(cwd, &["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=no"]).ok()?;
    let lines: Vec<&str> = status.lines().filter(|l| !l.trim().is_empty()).collect();
    let paths = lines
        .iter()
        .take(CHANGED_PATHS_CAP)
        .map(|line| {
            let raw = line.get(3..).unwrap_or(line).trim();
            raw.rsplit_once(" -> ").map(|(_, to)| to).unwrap_or(raw).to_string()
        })
        .collect();
    Some((lines.len() as u32, paths))
}

/// Read the folder's facts against `target`. Never fetches: the reconcile
/// fetched GitHub's target just before.
pub fn folder_facts(cwd: &Path, target: &str) -> FolderFacts {
    let head = commit(cwd, "HEAD");
    let head_at = head.as_ref().and_then(|_| {
        run_git(cwd, &["log", "-1", "--format=%ct", "HEAD"])
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
    });
    let target_local = commit(cwd, &format!("refs/heads/{target}"));
    let target_remote = commit(cwd, &format!("refs/remotes/origin/{target}"));
    let (newer, only_here) = match (&head, &target_remote) {
        (Some(h), Some(r)) if h != r => (count(cwd, h, r), count(cwd, r, h)),
        _ => (0, 0),
    };
    let (changed_count, changed_paths) = tracked_changes(cwd).unwrap_or_default();
    FolderFacts {
        branch: current_branch(cwd),
        head,
        head_at,
        target_local,
        target_remote,
        newer,
        only_here,
        changed_count,
        changed_paths,
    }
}

/// The outcome's kind as the window reads it (`fastForwarded`, `dirty`, …).
fn outcome_kind(outcome: &LocalBranchSync) -> String {
    serde_json::to_value(outcome)
        .ok()
        .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

/// (ahead, behind) of the local target against GitHub's, where the outcome
/// knows them.
fn outcome_counts(outcome: &LocalBranchSync) -> (Option<u32>, Option<u32>) {
    match outcome {
        LocalBranchSync::FastForwarded { commits, .. } => (Some(0), Some(*commits)),
        LocalBranchSync::Dirty { behind } => (None, Some(*behind)),
        LocalBranchSync::Diverged { ahead, behind } => (Some(*ahead), Some(*behind)),
        LocalBranchSync::Ahead { ahead } => (Some(*ahead), Some(0)),
        LocalBranchSync::CheckedOutElsewhere { behind, .. } => (None, Some(*behind)),
        LocalBranchSync::UntrackedDiffers { behind, .. } => (None, Some(*behind)),
        LocalBranchSync::UpToDate => (Some(0), Some(0)),
        _ => (None, None),
    }
}

fn opt(n: Option<u32>) -> String {
    n.map(|n| n.to_string()).unwrap_or_else(|| "-".into())
}

/// The Plyloft.log line for one reconcile's local-branch outcome: kind,
/// branch, the folder's branch, ahead/behind, the folder's newer count and
/// its changed-file count. Paths and contents are never logged here.
pub fn outcome_log_line(workspace_id: &str, report: &LocalBranchReport) -> String {
    let (ahead, behind) = outcome_counts(&report.outcome);
    let folder = report.folder.as_ref();
    format!(
        "reconcile local branch: workspace={workspace_id} kind={} branch={} folder_branch={} ahead={} behind={} folder_newer={} folder_only_here={} dirty_files={}",
        outcome_kind(&report.outcome),
        report.branch,
        folder
            .map(|f| f.branch.clone().unwrap_or_else(|| "(none)".into()))
            .unwrap_or_else(|| "-".into()),
        opt(ahead),
        opt(behind),
        opt(folder.map(|f| f.newer)),
        opt(folder.map(|f| f.only_here)),
        opt(folder.map(|f| f.changed_count)),
    )
}

/// Log every reconcile's local-branch outcome at info level, so a report
/// like the owner's ("behind … 532 newer updates", git status clean) can be
/// reconstructed from Plyloft.log. A refusal over changes when git status
/// itself counts none is logged as a warning beside it.
pub fn log_outcome(workspace_id: &str, report: &LocalBranchReport) {
    log::info!("{}", outcome_log_line(workspace_id, report));
    if let (LocalBranchSync::Dirty { .. }, Some(f)) = (&report.outcome, report.folder.as_ref()) {
        if f.changed_count == 0 {
            log::warn!(
                "reconcile local branch: workspace={workspace_id} {} refused over changes, but git status lists none now",
                report.branch
            );
        }
    }
}

/// What *Bring it up to date* did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FolderUpdate {
    /// The folder holds the target branch: the Sync's own fast-forward.
    Target { branch: String, outcome: LocalBranchSync },
    /// The folder holds another branch: moved forward from its own GitHub
    /// copy when strictly behind. Cards keep using `target`.
    OwnBranch { branch: String, target: String, outcome: LocalBranchSync },
    /// The folder's branch exists only on this Mac: GitHub has no copy of it
    /// to bring in (Challenger 2 — not "couldn't read GitHub"). Nothing moved.
    NoGitHubBranch { branch: String, target: String },
    /// Changes not saved in Git: nothing moved (the window opens the sheet).
    Changes { count: u32 },
    /// No branch is checked out: nothing moved.
    NoBranch,
}

/// *Bring it up to date*: only safe, local, forward-only moves of the branch
/// the folder already has. Never a checkout or switch, a rewrite, a stash or
/// a push.
pub fn bring_up_to_date(cwd: &Path, target: &str) -> FolderUpdate {
    let Some(branch) = current_branch(cwd) else {
        return FolderUpdate::NoBranch;
    };
    if let Some((n, _)) = tracked_changes(cwd) {
        if n > 0 {
            return FolderUpdate::Changes { count: n };
        }
    }
    let outcome = fast_forward_local(cwd, &branch);
    if let LocalBranchSync::Offline { reason } = &outcome {
        if branch != target && is_missing_remote_ref(reason) {
            return FolderUpdate::NoGitHubBranch { branch, target: target.to_string() };
        }
    }
    if branch == target {
        FolderUpdate::Target { branch, outcome }
    } else {
        FolderUpdate::OwnBranch { branch, target: target.to_string(), outcome }
    }
}

/// Git's own words (the fetch runs with `LC_ALL=C`) for a branch the remote
/// doesn't have.
fn is_missing_remote_ref(reason: &str) -> bool {
    reason.to_ascii_lowercase().contains("couldn't find remote ref")
}

/// The changes sheet: the folder's changes not in a commit, as the review
/// draws a diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderChanges {
    pub total_count: u32,
    /// The files drawn (at most [`SHEET_FILES_CAP`]).
    pub files: Vec<crate::git::FileDiff>,
    pub truncated: bool,
}

/// Read the folder's tracked changes against its current commit — staged and
/// not — for the sheet. Logged (count and paths, never contents).
pub fn folder_changes(cwd: &Path) -> Result<FolderChanges, String> {
    let (total, _) = tracked_changes(cwd).ok_or_else(|| "git status unavailable".to_string())?;
    let diff = run_git(cwd, &["-c", "core.quotePath=false", "diff", "--no-color", "-M", "HEAD"])?;
    let mut files = crate::git::parse_unified_diff(&diff);
    let truncated = files.len() > SHEET_FILES_CAP;
    files.truncate(SHEET_FILES_CAP);
    log::info!(
        "project folder changes listed: count={total} paths=[{}]",
        files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().join(", ")
    );
    Ok(FolderChanges { total_count: total, files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(dir)
            .output()
            .expect("spawn git");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn identity(dir: &Path) {
        git(dir, &["config", "user.email", "test@ply.test"]);
        git(dir, &["config", "user.name", "ply-test"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        git(dir, &["config", "core.autocrlf", "false"]);
    }

    fn commit_file(dir: &Path, name: &str) -> String {
        fs::write(dir.join(name), format!("{name}\n")).unwrap();
        git(dir, &["add", name]);
        git(dir, &["commit", "-q", "-m", name]);
        git(dir, &["rev-parse", "HEAD"])
    }

    /// origin with `main` and `staging`; the workspace clone ("this Mac")
    /// on `main` with no local `staging` — the owner's LYRA folder — and a
    /// second clone ("the other Mac") to push from.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        commit_file(&seed, "README.md");
        git(&seed, &["branch", "staging"]);
        let origin = tmp.path().join("origin.git");
        git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
        let ws = tmp.path().join("ws");
        let other = tmp.path().join("other");
        for dir in [&ws, &other] {
            git(
                tmp.path(),
                &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), dir.to_str().unwrap()],
            );
            identity(dir);
        }
        (tmp, ws, other)
    }

    fn push_to(other: &Path, branch: &str, files: &[&str]) {
        git(other, &["checkout", "-q", "-B", branch, &format!("origin/{branch}")]);
        for f in files {
            commit_file(other, f);
        }
        git(other, &["push", "-q", "origin", branch]);
    }

    #[test]
    fn facts_of_a_folder_on_another_branch_with_no_local_target() {
        let (_tmp, ws, other) = fixture();
        push_to(&other, "staging", &["a.txt", "b.txt", "c.txt"]);
        assert_eq!(fast_forward_local(&ws, "staging"), LocalBranchSync::NoLocalBranch);
        let f = folder_facts(&ws, "staging");
        assert_eq!(f.branch.as_deref(), Some("main"));
        assert_eq!(f.target_local, None);
        assert!(f.target_remote.is_some());
        assert_eq!(f.newer, 3, "GitHub's staging is three beyond the folder");
        assert_eq!(f.only_here, 0);
        assert_eq!(f.changed_count, 0);
        assert!(f.head_at.unwrap_or(0) > 1_600_000_000);
    }

    #[test]
    fn facts_count_changed_files_but_not_untracked_ones() {
        let (_tmp, ws, _other) = fixture();
        fs::write(ws.join("README.md"), "edited\n").unwrap();
        fs::write(ws.join("new-untracked.txt"), "x\n").unwrap();
        let f = folder_facts(&ws, "main");
        assert_eq!(f.changed_count, 1);
        assert_eq!(f.changed_paths, vec!["README.md".to_string()]);
    }

    #[test]
    fn bring_up_to_date_on_another_branch_moves_only_that_branch_forward() {
        let (_tmp, ws, other) = fixture();
        push_to(&other, "main", &["m.txt"]);
        push_to(&other, "staging", &["s.txt"]);
        let staging_before = git(&ws, &["rev-parse", "origin/staging"]);
        let out = bring_up_to_date(&ws, "staging");
        let FolderUpdate::OwnBranch { branch, target, outcome } = out else {
            panic!("{out:?}");
        };
        assert_eq!((branch.as_str(), target.as_str()), ("main", "staging"));
        assert!(matches!(outcome, LocalBranchSync::FastForwarded { commits: 1, .. }), "{outcome:?}");
        // Never switched: the folder is still on main, now with GitHub's main.
        assert_eq!(git(&ws, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert!(ws.join("m.txt").exists());
        assert!(!ws.join("s.txt").exists(), "staging's work did not come into main");
        // No local staging was made.
        assert!(git(&ws, &["branch", "--list", "staging"]).is_empty());
        assert_eq!(git(&ws, &["rev-parse", "origin/staging"]), staging_before);
    }

    #[test]
    fn bring_up_to_date_on_the_target_is_the_sync_fast_forward() {
        let (_tmp, ws, other) = fixture();
        push_to(&other, "main", &["m.txt"]);
        let out = bring_up_to_date(&ws, "main");
        assert!(
            matches!(&out, FolderUpdate::Target { branch, outcome: LocalBranchSync::FastForwarded { .. } } if branch == "main"),
            "{out:?}"
        );
        assert!(ws.join("m.txt").exists());
    }

    #[test]
    fn bring_up_to_date_with_changes_moves_nothing() {
        let (_tmp, ws, other) = fixture();
        push_to(&other, "main", &["m.txt"]);
        let before = git(&ws, &["rev-parse", "HEAD"]);
        fs::write(ws.join("README.md"), "mine\n").unwrap();
        assert_eq!(bring_up_to_date(&ws, "staging"), FolderUpdate::Changes { count: 1 });
        assert_eq!(git(&ws, &["rev-parse", "HEAD"]), before);
        assert_eq!(fs::read_to_string(ws.join("README.md")).unwrap(), "mine\n");
        assert_eq!(git(&ws, &["symbolic-ref", "--short", "HEAD"]), "main");
    }

    #[test]
    fn bring_up_to_date_on_a_branch_only_here_says_github_has_none() {
        let (_tmp, ws, _other) = fixture();
        git(&ws, &["checkout", "-q", "-b", "mine"]);
        commit_file(&ws, "mine.txt");
        let head = git(&ws, &["rev-parse", "HEAD"]);
        assert_eq!(
            bring_up_to_date(&ws, "staging"),
            FolderUpdate::NoGitHubBranch { branch: "mine".into(), target: "staging".into() }
        );
        assert_eq!(git(&ws, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&ws, &["symbolic-ref", "--short", "HEAD"]), "mine");
    }

    #[test]
    fn a_missing_remote_ref_is_told_from_being_offline() {
        assert!(is_missing_remote_ref("git fetch origin mine: fatal: couldn't find remote ref mine"));
        assert!(!is_missing_remote_ref("git fetch origin main: Could not resolve host: github.com"));
    }

    #[test]
    fn bring_up_to_date_never_moves_a_detached_folder() {
        let (_tmp, ws, other) = fixture();
        push_to(&other, "main", &["m.txt"]);
        let head = git(&ws, &["rev-parse", "HEAD"]);
        git(&ws, &["checkout", "-q", "--detach"]);
        assert_eq!(bring_up_to_date(&ws, "main"), FolderUpdate::NoBranch);
        assert_eq!(git(&ws, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn folder_changes_lists_each_file_with_its_lines() {
        let (_tmp, ws, _other) = fixture();
        fs::write(ws.join("README.md"), "README.md\nmore\n").unwrap();
        commit_file(&ws, "two.txt");
        fs::write(ws.join("two.txt"), "changed\n").unwrap();
        git(&ws, &["add", "two.txt"]);
        let c = folder_changes(&ws).unwrap();
        assert_eq!(c.total_count, 2);
        let mut paths: Vec<_> = c.files.iter().map(|f| f.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["README.md".to_string(), "two.txt".to_string()]);
        assert!(!c.truncated);
    }

    #[test]
    fn the_log_line_names_kind_branches_counts_and_no_paths() {
        let report = LocalBranchReport {
            branch: "staging".into(),
            outcome: LocalBranchSync::Dirty { behind: 532 },
            folder: Some(FolderFacts {
                branch: Some("main".into()),
                newer: 695,
                changed_count: 2,
                changed_paths: vec!["CONTEXT.md".into(), ".claude/settings.json".into()],
                ..Default::default()
            }),
        };
        let line = outcome_log_line("ws-1", &report);
        assert_eq!(
            line,
            "reconcile local branch: workspace=ws-1 kind=dirty branch=staging folder_branch=main ahead=- behind=532 folder_newer=695 folder_only_here=0 dirty_files=2"
        );
        assert!(!line.contains("CONTEXT.md"));
        let none = LocalBranchReport { branch: "staging".into(), outcome: LocalBranchSync::NoLocalBranch, folder: None };
        assert!(outcome_log_line("ws-1", &none).contains("kind=noLocalBranch branch=staging folder_branch=-"));
    }
}
