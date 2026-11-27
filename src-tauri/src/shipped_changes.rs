//! QoL 1.168 (C8, block 5.3): what a shipped card shipped. Once a card ships,
//! its copy of the repository goes to the Trash and `card_review_diff` has
//! nothing to read, so the card page's "See the changes" opened an empty
//! "The result". This reads the files the card's own landing changed, from
//! the project folder's own history, `--numstat`, bounded. Read-only;
//! nothing is fetched or written.
//!
//! - **Which commit.** The card's earliest ship entry (its landing), never
//!   `commit_sha` first: a release after the landing overwrites that.
//! - **A commit shared with other cards** (a batch release: one commit
//!   stamped on every card, or `Card:` trailers naming others) is not listed
//!   as this card's: the result says it shipped in a release with N others.
//! - **A merged pull request** reads its own head against where it forked
//!   (`merge-base(head, commit^1)..head`), so a rebase merge — whose recorded
//!   commit is the last rebased one — still shows every file; without its
//!   head on this computer, the commit against its first parent.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::kanban::{KanbanCard, KanbanStore};
use crate::workspace::WorkspaceStore;

/// At most this many files are listed; the total is still said.
pub const MAX_FILES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippedFile {
    pub path: String,
    /// Lines added and removed; `None` for a binary file.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippedChanges {
    pub commit: String,
    /// The commit's first line.
    pub subject: String,
    pub files: Vec<ShippedFile>,
    /// Every file the commit changed, listed or not.
    pub total_files: usize,
    /// The other cards the commit shipped (a batch release); when non-zero,
    /// `files` is empty — the release's files are not this card's.
    pub shared_with: usize,
}

/// The commit a shipped card landed in: its earliest ship entry, else its
/// recorded `commit_sha`.
pub fn landing_commit(card: &KanbanCard) -> Option<String> {
    card.ship_history
        .iter()
        .min_by_key(|e| e.shipped_at)
        .map(|e| e.commit_sha.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| card.commit_sha.clone().filter(|s| !s.trim().is_empty()))
}

/// The other cards of `cards` whose ship record names `commit`.
pub fn cards_sharing(cards: &[KanbanCard], card_id: &str, commit: &str) -> usize {
    cards
        .iter()
        .filter(|c| c.id != card_id)
        .filter(|c| c.ship_history.iter().any(|e| e.commit_sha == commit) || c.commit_sha.as_deref() == Some(commit))
        .count()
}

/// The other card ids a commit's `Card:` trailers name.
pub fn trailer_cards_other_than(trailers: &str, card_id: &str) -> usize {
    let mut ids: Vec<&str> = trailers.lines().map(str::trim).filter(|l| !l.is_empty() && *l != card_id).collect();
    ids.sort_unstable();
    ids.dedup();
    ids.len()
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn has_commit(repo: &Path, rev: &str) -> bool {
    crate::git::capture(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).is_ok()
}

/// `git diff --numstat -z` output: `added\tremoved\tpath\0`, or for a rename
/// `added\tremoved\t\0old\0new\0` (the new path is the one named).
pub fn parse_numstat_z(out: &str) -> Vec<ShippedFile> {
    let mut files = Vec::new();
    let mut fields = out.split('\0');
    while let Some(head) = fields.next() {
        if head.is_empty() {
            continue;
        }
        let mut parts = head.splitn(3, '\t');
        let (Some(a), Some(r), Some(rest)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if rest.is_empty() {
            // A rename: the old path, then the new one.
            let _old = fields.next();
            match fields.next() {
                Some(new) => new.to_string(),
                None => continue,
            }
        } else {
            rest.to_string()
        };
        files.push(ShippedFile {
            path,
            added: a.parse().ok(),
            removed: r.parse().ok(),
        });
    }
    files
}

/// What `commit` shipped for one card, in `repo`: nothing listed when the
/// commit shipped `shared_with` other cards too; a merged pull request's own
/// `pr_head` against where it forked when that head is here; otherwise the
/// commit against its first parent.
pub fn shipped_changes_in(
    repo: &Path,
    commit: &str,
    card_id: &str,
    ledger_shared: usize,
    pr_head: Option<&str>,
) -> Result<ShippedChanges, String> {
    let commit = commit.trim();
    if !is_hex(commit) {
        return Err("This card has no shipped commit on record.".to_string());
    }
    if !has_commit(repo, commit) {
        return Err(
            "The shipped commit isn't in this computer's copy of the project yet (it may have been merged on GitHub and not pulled here)."
                .to_string(),
        );
    }
    let subject = crate::git::capture(repo, &["log", "-1", "--format=%s", commit])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let trailers = crate::git::capture(repo, &["log", "-1", "--format=%(trailers:key=Card,valueonly)", commit])
        .unwrap_or_default();
    let shared_with = ledger_shared.max(trailer_cards_other_than(&trailers, card_id));
    if shared_with > 0 {
        return Ok(ShippedChanges { commit: commit.to_string(), subject, files: Vec::new(), total_files: 0, shared_with });
    }
    let numstat = |from: &str, to: &str| {
        crate::git::capture_configured(
            repo,
            &["-c", "core.quotePath=false"],
            &["diff", "--no-color", "--no-ext-diff", "--numstat", "-z", "-M", from, to],
        )
    };
    let parent = format!("{commit}^1");
    let has_parent = has_commit(repo, &parent);
    let pr_range = match pr_head.map(str::trim) {
        Some(head) if is_hex(head) && has_parent && has_commit(repo, head) => {
            crate::git::capture(repo, &["merge-base", head, &parent])
                .ok()
                .map(|b| b.trim().to_string())
                .filter(|b| is_hex(b))
                .map(|base| (base, head.to_string()))
        }
        _ => None,
    };
    let out = if let Some((base, head)) = pr_range {
        numstat(&base, &head)?
    } else if has_parent {
        numstat(&parent, commit)?
    } else {
        // A root commit has no parent: its whole tree is what it added.
        crate::git::capture_configured(
            repo,
            &["-c", "core.quotePath=false"],
            &["show", "--no-color", "--no-ext-diff", "--numstat", "-z", "--format=", commit],
        )?
    };
    let mut files = parse_numstat_z(&out);
    let total_files = files.len();
    files.truncate(MAX_FILES);
    Ok(ShippedChanges { commit: commit.to_string(), subject, files, total_files, shared_with: 0 })
}

/// The shipped card's changes: its recorded commit, read in its project folder.
#[tauri::command]
pub async fn card_shipped_changes(
    app: AppHandle,
    kanban: State<'_, KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<ShippedChanges, String> {
    let cards = kanban.load(&workspace_id)?;
    let card = cards
        .iter()
        .find(|c| c.id == card_id)
        .cloned()
        .ok_or_else(|| "The card isn't on this Board any more.".to_string())?;
    let commit = landing_commit(&card).unwrap_or_default();
    let ledger_shared = cards_sharing(&cards, &card_id, &commit);
    // A merged pull request: its own head, so every merge method reads right.
    let pr_head = card
        .pr
        .as_ref()
        .filter(|p| p.state == crate::pr_status::PrState::Merged)
        .and_then(|p| p.head_sha.clone());
    let repo = app
        .state::<WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| std::path::PathBuf::from(w.cwd))
        .ok_or_else(|| "The card's project isn't open.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        shipped_changes_in(&repo, &commit, &card_id, ledger_shared, pr_head.as_deref())
    })
        .await
        .map_err(|e| format!("the shipped-changes worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = crate::platform::git_command()
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn numstat_names_each_file_with_its_lines_renames_by_their_new_path() {
        let out = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\0\
                   2\t0\t\0old/name.md\0new/name.md\0";
        let files = parse_numstat_z(out);
        assert_eq!(
            files,
            vec![
                ShippedFile { path: "src/a.ts".into(), added: Some(3), removed: Some(1) },
                ShippedFile { path: "logo.png".into(), added: None, removed: None },
                ShippedFile { path: "new/name.md".into(), added: Some(2), removed: Some(0) },
            ]
        );
        assert!(parse_numstat_z("").is_empty());
    }

    fn commit_all(repo: &Path, msg: &[&str]) -> String {
        git(repo, &["add", "-A"]);
        let mut args = vec!["commit", "-q"];
        for m in msg {
            args.push("-m");
            args.push(m);
        }
        git(repo, &args);
        git(repo, &["rev-parse", "HEAD"])
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        commit_all(dir.path(), &["first"]);
        dir
    }

    fn card(id: &str, ships: &[(&str, i64)], commit_sha: Option<&str>) -> KanbanCard {
        let history: Vec<_> = ships
            .iter()
            .map(|(sha, at)| serde_json::json!({"commitSha": sha, "shippedVersion": "1.0.0", "releaseKind": "local", "shippedAt": at}))
            .collect();
        serde_json::from_value(serde_json::json!({
            "id": id, "workspaceId": "ws", "title": id, "columnId": "complete",
            "createdAt": 0, "updatedAt": 0, "shipStatus": "shipped",
            "shipHistory": history, "commitSha": commit_sha,
        }))
        .unwrap()
    }

    #[test]
    fn reads_what_a_landed_commit_changed_and_says_when_it_is_missing() {
        let dir = repo();
        let repo = dir.path();
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("b.txt"), "new\n").unwrap();
        let sha = commit_all(repo, &["Land card: Add b"]);

        let shipped = shipped_changes_in(repo, &sha, "c1", 0, None).unwrap();
        assert_eq!(shipped.subject, "Land card: Add b");
        assert_eq!(shipped.total_files, 2);
        assert_eq!(shipped.shared_with, 0);
        let paths: Vec<_> = shipped.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a.txt", "b.txt"]);
        assert_eq!(shipped.files[0].added, Some(1));

        // The root commit: its whole tree.
        let root = git(repo, &["rev-list", "--max-parents=0", "HEAD"]);
        assert_eq!(shipped_changes_in(repo, &root, "c1", 0, None).unwrap().files.len(), 1);

        let missing = shipped_changes_in(repo, "0123456789abcdef0123456789abcdef01234567", "c1", 0, None).unwrap_err();
        assert!(missing.contains("isn't in this computer's copy"), "{missing}");
        assert!(shipped_changes_in(repo, "", "c1", 0, None).unwrap_err().contains("no shipped commit"));
        assert!(shipped_changes_in(repo, "HEAD; rm -rf", "c1", 0, None).is_err(), "only a commit id is read");
    }

    #[test]
    fn a_landing_is_the_cards_own_and_a_batch_release_is_not_listed_as_its_files() {
        let dir = repo();
        let repo = dir.path();
        std::fs::write(repo.join("one.txt"), "1\n").unwrap();
        let land_one = commit_all(repo, &["Land card: one"]);
        std::fs::write(repo.join("two.txt"), "2\n").unwrap();
        let land_two = commit_all(repo, &["Land card: two"]);
        // One release commit for both cards, stamped on each.
        std::fs::write(repo.join("VERSION"), "1.1.0\n").unwrap();
        let release = commit_all(repo, &["Release v1.1.0", "Card: one\nCard: two"]);

        let one = card("one", &[(&land_one, 1), (&release, 5)], Some(&release));
        let two = card("two", &[(&land_two, 2), (&release, 5)], Some(&release));
        let batch_only = card("three", &[(&release, 5)], Some(&release));
        let cards = vec![one.clone(), two.clone(), batch_only.clone()];

        // A card landed, then released: its landing, never the release.
        assert_eq!(landing_commit(&one).as_deref(), Some(land_one.as_str()));
        let read = shipped_changes_in(repo, &land_one, "one", cards_sharing(&cards, "one", &land_one), None).unwrap();
        assert_eq!(read.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["one.txt"]);

        // A card that shipped only in the batch: the release is shared.
        let commit = landing_commit(&batch_only).unwrap();
        assert_eq!(cards_sharing(&cards, "three", &commit), 2);
        let shared = shipped_changes_in(repo, &commit, "three", cards_sharing(&cards, "three", &commit), None).unwrap();
        assert_eq!(shared.shared_with, 2);
        assert!(shared.files.is_empty(), "the release's files are not this card's");

        // The trailers alone say so too (the other cards' records gone).
        let alone = shipped_changes_in(repo, &release, "one", 0, None).unwrap();
        assert_eq!(alone.shared_with, 1);
        assert_eq!(trailer_cards_other_than("one\ntwo\ntwo\n", "one"), 1);
    }

    #[test]
    fn a_rebase_merged_pull_request_reads_its_whole_head() {
        let dir = repo();
        let repo = dir.path();
        let base = git(repo, &["rev-parse", "HEAD"]);
        git(repo, &["checkout", "-q", "-b", "card"]);
        std::fs::write(repo.join("x.txt"), "x\n").unwrap();
        commit_all(repo, &["x"]);
        std::fs::write(repo.join("y.txt"), "y\n").unwrap();
        let head = commit_all(repo, &["y"]);
        // GitHub's rebase merge: the same changes as new commits on a main
        // that moved meanwhile (so the rebased commits are new ones).
        git(repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("other.txt"), "o\n").unwrap();
        commit_all(repo, &["someone else's change"]);
        git(repo, &["cherry-pick", &format!("{base}..{head}")]);
        let merged = git(repo, &["rev-parse", "HEAD"]);
        assert_ne!(merged, head);

        let only_last = shipped_changes_in(repo, &merged, "c", 0, None).unwrap();
        assert_eq!(only_last.total_files, 1, "the last rebased commit alone");
        let whole = shipped_changes_in(repo, &merged, "c", 0, Some(&head)).unwrap();
        let paths: Vec<_> = whole.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["x.txt", "y.txt"]);
        // A head not on this computer: the commit against its first parent.
        let absent = shipped_changes_in(repo, &merged, "c", 0, Some("0123456789abcdef0123456789abcdef01234567")).unwrap();
        assert_eq!(absent.total_files, 1);
    }
}
