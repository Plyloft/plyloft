//! v1.86.0 (team-tier roadmap cycle 3): the pre-merge overlap warning.
//!
//! Two cards (or a card and a teammate's open PR) silently editing the
//! same files is the first real pain of parallel agent runs — solo users
//! hit it with the 3-parallel-card-swarm cap, teams hit it across
//! machines. This module answers "which files does this card's work
//! share with other in-flight work?" so the Run and Ship steps can warn
//! BEFORE the merge conflict (or the silent clobber) happens.
//!
//! Two halves, split by the team gate (docs/team-tier/ROADMAP.md):
//! - **Local (free):** this card's worktree diff vs every other
//!   non-archived card with a live worktree in the same workspace.
//!   Protects the solo parallel-swarm path.
//! - **Teammate (paid):** this card's files vs open PRs' changed files
//!   in the workspace's repo (via `gh`). Soft-degrades: unlicensed or
//!   non-GH workspaces simply get no teammate rows.
//!
//! The warning is ADVISORY — it never blocks a move, a run, or a ship.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

/// One overlap row the FE renders. `kind` is `local_card` or
/// `teammate_pr`; `other` is the card title or `PR #N · title`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlapWarning {
    pub kind: OverlapKind,
    pub other_id: String,
    pub other_title: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlapKind {
    LocalCard,
    TeammatePr,
}

/// Changed files of a worktree relative to its own base: committed work on
/// the branch plus anything dirty or untracked in the working tree. Paths
/// are repo-relative. GH #191: the base is
/// [`crate::worktrees::card_diff_base`] (recorded base, `origin/<target>`,
/// local `<target>`), so a stale local target can't report upstream files
/// as this card's.
pub fn changed_files<'a>(
    worktree: &Path,
    recorded_base: impl Into<crate::review_base::Recorded<'a>>,
    target_branch: &str,
) -> Result<BTreeSet<String>, String> {
    let mut files = BTreeSet::new();
    // Committed on the branch since its base. No base resolves in odd
    // repos — degrade to dirty-only.
    let fork = crate::worktrees::card_diff_base(worktree, "HEAD", recorded_base, target_branch);
    if let Some(Ok(out)) = fork.map(|fork| {
        crate::git::capture(worktree, &["diff", "--name-only", "-M", &format!("{fork}...HEAD")])
    }) {
        for line in out.lines() {
            let l = line.trim();
            if !l.is_empty() {
                files.insert(l.to_string());
            }
        }
    }
    // Dirty + untracked (the run may not have committed yet).
    files.extend(dirty_files(worktree)?);
    Ok(files)
}

/// Uncommitted files of a worktree: modified, staged and untracked.
pub fn dirty_files(worktree: &Path) -> Result<BTreeSet<String>, String> {
    let status = crate::git::capture(worktree, &["status", "--porcelain"])?;
    Ok(parse_porcelain_paths(&status).into_iter().collect())
}

/// The files another card's worktree still has in flight. A card whose
/// branch is already merged into the fetched `origin/<target>` (merged on
/// another Mac, say) has no pending commits, only whatever is uncommitted.
/// Only when the checkout is still on that recorded branch: one switched
/// elsewhere keeps its full changed set.
///
/// Since GH #191 the merged shortcut is an optimisation only (it skips the
/// branch diff): [`changed_files`] measures from `origin/<target>` too, so it
/// returns the same set for a merged card, and no test can tell the two
/// apart. The test below pins the result, not which path produced it.
pub fn pending_files(
    worktree: &Path,
    branch: Option<&str>,
    recorded_base: Option<&str>,
    target_branch: &str,
) -> Result<BTreeSet<String>, String> {
    let merged = branch.is_some_and(|b| {
        crate::worktrees::checked_out_branch(worktree).as_deref() == Some(b)
            && crate::worktrees::merged_into_origin(worktree, b, recorded_base, target_branch)
    });
    if merged {
        dirty_files(worktree)
    } else {
        changed_files(worktree, recorded_base, target_branch)
    }
}

/// Extract repo-relative paths from `git status --porcelain` output.
/// Handles the rename form (`R  old -> new` reports BOTH sides — the
/// old path disappearing collides just as hard as the new one
/// appearing) and quoted paths (unusual names).
pub fn parse_porcelain_paths(porcelain: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let rest = &line[3..];
        let unquote = |s: &str| s.trim().trim_matches('"').to_string();
        match rest.split_once(" -> ") {
            Some((old, new)) => {
                out.push(unquote(old));
                out.push(unquote(new));
            }
            None => out.push(unquote(rest)),
        }
    }
    out
}

/// Sorted intersection of two changed-file sets.
pub fn intersect(a: &BTreeSet<String>, b: &BTreeSet<String>) -> Vec<String> {
    a.intersection(b).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// #34's banner: a sibling merged into origin/main on another Mac,
    /// while this Mac's local main is stale. Its committed work must not
    /// read as pending; its uncommitted files still do.
    #[test]
    fn pending_files_ignores_a_worktree_merged_into_origin() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let wt = tmp.path().join("wt");
        std::fs::create_dir(&repo).unwrap();
        let git = |dir: &Path, args: &[&str]| crate::git::run(dir, args).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            git(&repo, args);
        }
        git(&repo, &["worktree", "add", "-q", "-b", "card", wt.to_str().unwrap(), "main"]);
        std::fs::write(wt.join("shared.rs"), "x\n").unwrap();
        git(&wt, &["add", "shared.rs"]);
        git(&wt, &["commit", "-q", "-m", "card work"]);

        // Not merged anywhere yet: pending is the plain changed set.
        assert_eq!(pending_files(&wt, Some("card"), None, "main").unwrap(), set(&["shared.rs"]));

        // origin/main now holds the card; local main is stale.
        git(&repo, &["update-ref", "refs/remotes/origin/main", "card"]);
        // GH #191: changed_files measures from origin/main too, so the merged
        // card's own commits no longer read as changed even here.
        assert!(changed_files(&wt, None::<&str>, "main").unwrap().is_empty(), "the stale view");
        assert!(pending_files(&wt, Some("card"), None, "main").unwrap().is_empty());

        std::fs::write(wt.join("after.rs"), "y\n").unwrap();
        assert_eq!(pending_files(&wt, Some("card"), None, "main").unwrap(), set(&["after.rs"]));

        // Challenger P2: the checkout switched to an unmerged branch while
        // the card still records the merged one. Its commits count again.
        git(&wt, &["checkout", "-q", "-b", "elsewhere"]);
        std::fs::write(wt.join("new.rs"), "z\n").unwrap();
        git(&wt, &["add", "new.rs"]);
        git(&wt, &["commit", "-q", "-m", "unmerged work"]);
        assert_eq!(
            pending_files(&wt, Some("card"), None, "main").unwrap(),
            changed_files(&wt, None::<&str>, "main").unwrap()
        );
        assert!(pending_files(&wt, Some("card"), None, "main").unwrap().contains("new.rs"));
    }

    #[test]
    fn intersect_returns_sorted_common_files() {
        let a = set(&["src/b.rs", "src/a.rs", "README.md"]);
        let b = set(&["src/a.rs", "docs/x.md", "src/b.rs"]);
        assert_eq!(intersect(&a, &b), vec!["src/a.rs", "src/b.rs"]);
        assert!(intersect(&a, &set(&["zzz"])).is_empty());
    }

    #[test]
    fn porcelain_parse_handles_plain_rename_and_quoted() {
        let porcelain = " M src/main.rs\n?? new_file.txt\nR  old.rs -> new.rs\nA  \"weird name.txt\"\n";
        let paths = parse_porcelain_paths(porcelain);
        assert_eq!(
            paths,
            vec![
                "src/main.rs",
                "new_file.txt",
                "old.rs",
                "new.rs",
                "weird name.txt"
            ]
        );
    }

    /// Real-repo round trip: committed-on-branch + dirty + untracked all
    /// show up; files merged into target don't.
    #[test]
    fn changed_files_sees_committed_dirty_and_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let git = |args: &[&str]| crate::git::run(repo, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(repo.join("base.txt"), "base").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "base"]);
        git(&["checkout", "-q", "-b", "card-branch"]);
        std::fs::write(repo.join("committed.txt"), "x").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "work"]);
        std::fs::write(repo.join("base.txt"), "dirty edit").unwrap();
        std::fs::write(repo.join("untracked.txt"), "new").unwrap();

        let files = changed_files(repo, None::<&str>, "main").unwrap();
        assert!(files.contains("committed.txt"));
        assert!(files.contains("base.txt"));
        assert!(files.contains("untracked.txt"));
        assert_eq!(files.len(), 3);
    }
}
