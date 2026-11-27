//! UX P1 point 7 (P-E): a local Ship that stopped on a git conflict,
//! resolved by the card's Builder.
//!
//! Plyloft — not the Builder — starts the merge: `git merge --no-ff
//! --no-commit <target sha>` in the card's own copy, where `<target sha>`
//! is the target branch's commit the failed ship met (`ShipConflict`,
//! recorded by `land_card_local`). Three reasons (the spec's Challenger
//! section): Codex's `workspace-write` sandbox can't write the main
//! repository's `.git`, which a merge in a linked copy writes; the
//! Challenger's range is checked against GitHub's tip while local
//! `<target>` is often ahead of it, so Plyloft records the merged commit as
//! a trusted base (`WorktreeBase::merged_target`); and the record says
//! exactly which commit was merged.
//!
//! The Builder only resolves the conflict marks. Finish and check commits
//! the pending merge as a merge commit and refuses while a mark is left
//! ([`finish_refusal`]); Undo the merge runs `git merge --abort` in the
//! card's copy. Nothing here pushes, and nothing touches the member's own
//! checkout: the flow writes only the card's branch in the card's copy.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::kanban::{KanbanCard, KanbanStore, ReviewStatus};

/// What "Ask the Builder to resolve it" sends, and what it said.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShipConflictMessage {
    /// Pasted into the Builder session as it is.
    pub message: String,
    /// The files left to resolve now: those with conflict marks, then
    /// those git couldn't mark (a binary file, a file deleted on one side).
    pub paths: Vec<String>,
    /// The target branch's name.
    pub branch: String,
    /// The merge was already under way (a second press, after a restart):
    /// nothing new was started, the message is sent again.
    pub already_started: bool,
}

/// A card with no Builder: said in place of the press (adopted 15).
pub const NO_BUILDER: &str =
    "This card has no Builder to resolve it. Resolve the conflict in the card's copy, then ship again.";
/// (Challenger) the card's copy has work since its last Finish and check.
pub const UNCOMMITTED: &str =
    "The card's copy has changes since the last Finish and check. Press Finish and check first, then ask again.";

/// K6 (1.171.0 A3): the person's words for an unknown target.
pub const UNKNOWN_TARGET: &str = "your main branch";

fn branch_name(branch: &str) -> &str {
    if branch.trim().is_empty() {
        UNKNOWN_TARGET
    } else {
        branch
    }
}

/// K6 (1.171.0 A3): the branch a card's conflict is with, by its real name —
/// the one recorded, else the card's start's target (`origin/<target>`),
/// else "your main branch"; never "the target branch".
pub fn conflict_target(card: &KanbanCard, recorded: &str) -> String {
    if !recorded.trim().is_empty() {
        return recorded.to_string();
    }
    card.worktree_base
        .as_ref()
        .map(|b| b.ref_name.strip_prefix("origin/").unwrap_or(&b.ref_name).to_string())
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| UNKNOWN_TARGET.to_string())
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

/// The card's copy, which must exist.
fn worktree_of(card: &KanbanCard) -> Result<PathBuf, String> {
    card.worktree_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| "This card's copy is gone, so nothing could be started there.".to_string())
}

/// A merge is pending in `worktree` (its own `MERGE_HEAD`).
pub fn merge_pending(worktree: &Path) -> Option<String> {
    crate::worktrees::resolve_commit(worktree, "MERGE_HEAD")
}

/// Unmerged index entries in `worktree`, as git names them. (Challenger)
/// `-z`: without it git quotes a name with an accent or a tab
/// (`"perch\303\251.md"`), which can't be read back as a path — its marks
/// would go unseen.
fn unmerged(worktree: &Path) -> Vec<String> {
    crate::git::capture(worktree, &["diff", "--name-only", "-z", "--diff-filter=U"])
        .unwrap_or_default()
        .split('\0')
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Git's conflict-mark lines in `text`, counted: a line that starts
/// `<<<<<<< ` or `>>>>>>> ` (or is the bare seven), the shapes git writes.
/// A CRLF file's lines count the same.
fn mark_lines(text: &str) -> HashMap<&str, usize> {
    let mut out = HashMap::new();
    for l in text.lines().map(|l| l.trim_end_matches('\r')) {
        let marked = ["<<<<<<<", ">>>>>>>"].iter().any(|mark| {
            l.strip_prefix(mark)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
        });
        if marked {
            *out.entry(l).or_insert(0) += 1;
        }
    }
    out
}

/// True when `text` holds a line shaped like a git conflict mark.
pub fn has_conflict_marks(text: &str) -> bool {
    !mark_lines(text).is_empty()
}

/// `path` as committed at `rev`; empty when it isn't there.
fn at_rev(worktree: &Path, rev: &str, path: &str) -> String {
    crate::git::capture(worktree, &["show", "--no-textconv", &format!("{rev}:{path}")]).unwrap_or_default()
}

/// (Challenger) Whether `path` in the card's copy still holds a mark the
/// merge wrote: a mark-shaped line there more often than either merged
/// side held it. A file that legitimately carries such lines
/// (a guide to git conflicts, a test fixture) isn't refused for keeping
/// them; one git marked is, as before.
fn marks_left(worktree: &Path, path: &str, sides: &[&str]) -> bool {
    let Ok(bytes) = std::fs::read(worktree.join(path)) else { return false };
    let text = String::from_utf8_lossy(&bytes);
    let now = mark_lines(&text);
    if now.is_empty() {
        return false;
    }
    let side_texts: Vec<String> = sides.iter().map(|rev| at_rev(worktree, rev, path)).collect();
    // The most either side held (not their sum): a guide both sides carry
    // unchanged holds its line once in the merged file, so a mark git wrote
    // with the same words still shows as one too many.
    let mut held: HashMap<&str, usize> = HashMap::new();
    for side in &side_texts {
        for (line, n) in mark_lines(side) {
            let most = held.entry(line).or_insert(0);
            *most = (*most).max(n);
        }
    }
    now.iter().any(|(line, n)| *n > held.get(line).copied().unwrap_or(0))
}

/// (marked, unmarked) of a merge: the files that still hold a mark the
/// merge wrote — the ones git reports unmerged now, and the conflict's own
/// list (`recorded`), read too since a file the Builder `git add`ed, marks
/// and all, is no longer unmerged — and the files git lists unmerged with
/// no mark to remove (a binary file, or one deleted on one side and changed
/// on the other: git writes no marks there). Those aren't refused — Codex
/// can't `git add` in a linked copy, and Finish and check stages what is in
/// the folder — but the message names them apart. `sides`: the two commits
/// merged, whose own mark-shaped lines don't count.
fn classify(worktree: &Path, recorded: &[String], sides: &[&str]) -> (Vec<String>, Vec<String>) {
    let now = unmerged(worktree);
    let mut seen = std::collections::BTreeSet::new();
    let (mut marked, mut unmarked) = (Vec::new(), Vec::new());
    for path in now.iter().chain(recorded.iter()) {
        if !seen.insert(path.clone()) {
            continue;
        }
        if marks_left(worktree, path, sides) {
            marked.push(path.clone());
        } else if now.contains(path) {
            unmarked.push(path.clone());
        }
    }
    (marked, unmarked)
}

/// The files of a merge that still hold a conflict mark it wrote (see
/// [`classify`]). A file whose marks are gone counts as resolved, added or
/// not: Finish and check stages it with everything else.
pub fn unresolved(worktree: &Path, recorded: &[String], sides: &[&str]) -> Vec<String> {
    classify(worktree, recorded, sides).0
}

/// "2 files still have conflict marks: a.ts, b.ts. …" — Finish and check's
/// refusal while the merge is not resolved. `undo`: the merge is still
/// pending, so Undo the merge is a way out (not once the Builder committed
/// it itself).
pub fn marks_refusal(paths: &[String], undo: bool) -> String {
    let what = if paths.len() == 1 {
        "1 file still has conflict marks".to_string()
    } else {
        format!("{} files still have conflict marks", paths.len())
    };
    let way = if undo {
        "Ask the Builder to finish them, or undo the merge (⋯ › Undo the merge)."
    } else {
        "Ask the Builder to finish them."
    };
    format!("{what}: {}. {way}", paths.join(", "))
}

/// Finish and check's refusal on a card whose copy has a merge pending with
/// files not resolved yet; `None` otherwise (no merge, or all resolved — the
/// snapshot then commits the merge as a merge commit). (Challenger) Also
/// the merge Plyloft started that the Builder committed itself despite the
/// message, with a mark left in it: that would otherwise be taken like any
/// commit and reach Ship.
pub fn finish_refusal(card: &KanbanCard) -> Option<String> {
    let worktree = card.worktree_path.as_deref().map(Path::new)?;
    let recorded = card
        .ship_conflict
        .as_ref()
        .map(|c| c.paths.clone())
        .unwrap_or_default();
    if let Some(merging) = merge_pending(worktree) {
        let left = unresolved(worktree, &recorded, &["HEAD", &merging]);
        return (!left.is_empty()).then(|| marks_refusal(&left, true));
    }
    let conflict = card.ship_conflict.as_ref()?;
    conflict.merge_started_at?;
    if !crate::worktrees::is_ancestor(worktree, &conflict.target_sha, "HEAD") {
        return None;
    }
    // The card's side: its last Finish and check, from before the merge.
    let before = card.builder.as_ref()?.snapshots.last()?.sha.clone();
    let left = unresolved(worktree, &recorded, &[&before, &conflict.target_sha]);
    (!left.is_empty()).then(|| marks_refusal(&left, false))
}

/// The snapshot's commit message when it commits Plyloft's merge.
pub fn merge_commit_message(card: &KanbanCard, n: u32) -> Option<String> {
    let worktree = card.worktree_path.as_deref().map(Path::new)?;
    let merging = merge_pending(worktree)?;
    // 1.170.0 (G6): a clean Bring in the target's changes records no
    // conflict; the card's start names its target (`origin/<target>`).
    let branch = conflict_target(card, card.ship_conflict.as_ref().map_or("", |c| c.branch.as_str()));
    Some(crate::commit_message::snapshot_merge_subject(n, &card.title, &branch, &short(&merging)))
}

/// The message for the Builder: what Plyloft started and what it may not
/// do. `marked`: files with conflict marks; `unmarked`: files git left
/// unmerged without marks (binary, or deleted on one side).
/// `sync` (1.170.0, G6): the conflict was met by Bring in the target's
/// changes (GitHub's target, merged on the person's press,
/// `card_sync::bring_in`), not by a ship.
pub fn message(sync: bool, branch: &str, target_sha: &str, marked: &[String], unmarked: &[String]) -> String {
    let branch = branch_name(branch);
    let names = |paths: &[String]| -> String {
        paths.iter().map(|p| crate::pr_fix::one_line(p)).collect::<Vec<_>>().join(", ")
    };
    let mut parts: Vec<String> = Vec::new();
    if !marked.is_empty() {
        parts.push(format!(
            "these files have conflict marks: {}. Resolve each one keeping what both sides meant, remove every mark",
            names(marked)
        ));
    }
    if !unmarked.is_empty() {
        parts.push(format!(
            "these files changed on both sides where git couldn't write marks (a binary file, or one deleted on one side): {}. Leave each one as this card should have it; Plyloft takes what is in the folder",
            names(unmarked)
        ));
    }
    let files = if parts.is_empty() {
        "git merged it without conflict marks this time, but nothing is committed yet. Check that the merged code still does what this card meant".to_string()
    } else {
        parts.join("; ")
    };
    let stopped = if sync {
        format!("Bringing {branch}'s changes into this card stopped: {branch} on GitHub changed the same lines.")
    } else {
        format!("Shipping this card stopped: {branch} on {} changed the same lines.", crate::platform::THIS_MACHINE)
    };
    format!(
        "[Plyloft] {stopped} \
Plyloft has started merging {branch} (commit {}) into this branch; {files}, and run the project's checks. \
Don't commit, don't abort the merge, don't rebase, reset, push or force anything. \
Then stop; the person presses Finish and check.",
        short(target_sha)
    )
}

/// What the merge left to resolve, as the press reports it.
fn sent(sync: bool, branch: String, target: &str, marked: Vec<String>, unmarked: Vec<String>, already_started: bool) -> ShipConflictMessage {
    let message = message(sync, &branch, target, &marked, &unmarked);
    let mut paths = marked;
    paths.extend(unmarked);
    ShipConflictMessage { message, paths, branch, already_started }
}

/// "Ask the Builder to resolve it": start the merge of the recorded target
/// commit in the card's copy, record that commit as a trusted base, and
/// return the message. A merge of that same commit already pending (a
/// second press) starts nothing and returns the message again.
pub fn start(kanban: &KanbanStore, workspace_id: &str, card_id: &str) -> Result<ShipConflictMessage, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    if card.builder.is_none() {
        return Err(NO_BUILDER.into());
    }
    let conflict = match (&card.review_status, &card.ship_conflict) {
        (Some(ReviewStatus::ConflictBlocked), Some(c)) => c.clone(),
        // 1.170.0 (G6, orchestrator #8): a bring-in's conflict on a card
        // whose pull request is open is recorded beside its status, never
        // over it; the merge starts for the Builder the same way.
        (_, Some(c)) if c.sync => c.clone(),
        (Some(ReviewStatus::ConflictBlocked), None) => {
            return Err("Plyloft has no record of which commit this card conflicted with (the ship stopped before this version recorded it). Ship it again; if it stops on the conflict again, ask again.".into())
        }
        _ => return Err("This card's last ship didn't stop on a conflict; nothing was started.".into()),
    };
    let worktree = worktree_of(&card)?;
    let branch = conflict_target(&card, &conflict.branch);
    let target = crate::worktrees::resolve_commit(&worktree, &conflict.target_sha).ok_or_else(|| {
        format!(
            "The commit of {} this card conflicted with ({}) isn't in this repository any more; nothing was started. Ship it again.",
            branch_name(&branch),
            short(&conflict.target_sha)
        )
    })?;
    if let Some(pending) = merge_pending(&worktree) {
        if pending != target {
            return Err("A different merge is already under way in the card's copy; nothing was started. Undo it first (⋯ › Undo the merge).".into());
        }
        let (marked, unmarked) = classify(&worktree, &conflict.paths, &["HEAD", &target]);
        let mut all = marked.clone();
        all.extend(unmarked.iter().cloned());
        record_started(kanban, workspace_id, card_id, &target, &all)?;
        return Ok(sent(conflict.sync, branch, &target, marked, unmarked, true));
    }
    // (Challenger) A rebase, cherry-pick or revert the Builder left half
    // done: a merge on top of it would mix the two.
    if let Some(op) = crate::worktrees::pending_operation(&worktree) {
        return Err(format!(
            "The card's copy is in the middle of {op}; nothing was started. Ask the Builder to finish or stop it, then ask again."
        ));
    }
    if crate::worktrees::worktree_is_dirty(&worktree)? {
        return Err(UNCOMMITTED.into());
    }
    if crate::worktrees::is_ancestor(&worktree, &target, "HEAD") {
        // The branch took that commit in already (the Builder merged it and
        // committed, past the last Finish and check).
        return Err(format!(
            "This card's branch already has {} at that commit; nothing was started. Press Finish and check, then ship again.",
            branch_name(&branch)
        ));
    }
    merge_no_commit(&worktree, &target)?;
    let (marked, unmarked) = classify(&worktree, &conflict.paths, &["HEAD", &target]);
    let mut all = marked.clone();
    all.extend(unmarked.iter().cloned());
    record_started(kanban, workspace_id, card_id, &target, &all)?;
    Ok(sent(conflict.sync, branch, &target, marked, unmarked, false))
}

/// `git merge --no-ff --no-commit <target>` in the card's copy, bounded and
/// registered: Ok once a merge is pending there (conflicted or not); every
/// way it doesn't start says that nothing was started, with the copy as it
/// was. Shared by "Ask the Builder to resolve it" and 1.170.0's Bring in
/// the target's changes (`card_sync::bring_in`).
pub(crate) fn merge_no_commit(worktree: &Path, target: &str) -> Result<(), String> {
    // Hard rule 4 (Challenger): bounded and registered like Bring in the new
    // commits' merge — a filter (LFS) or a hook waiting can't hold the ship
    // lock forever, and quitting kills it.
    let mut cmd = crate::platform::git_command();
    cmd.args(["merge", "--no-ff", "--no-commit", target])
        .current_dir(worktree)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no");
    let said = match crate::worktrees::run_bounded_output(&mut cmd, crate::worktrees::PR_MERGE_TIMEOUT) {
        Ok(out) => format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(crate::worktrees::BoundedFailure::Truncated) => String::new(),
        Err(crate::worktrees::BoundedFailure::Quitting) => {
            return Err("Plyloft is quitting; nothing was started.".into())
        }
        Err(crate::worktrees::BoundedFailure::Spawn(e)) => {
            return Err(format!("Git couldn't run in the card's copy; nothing was started. {e}"))
        }
        Err(crate::worktrees::BoundedFailure::TimedOut) => {
            if merge_pending(worktree).is_some() {
                let _ = crate::git::run(worktree, &["merge", "--abort"]);
            }
            return Err(format!(
                "Git didn't finish the merge within {} seconds in the card's copy; it was stopped and nothing was started. Ask again.",
                crate::worktrees::PR_MERGE_TIMEOUT.as_secs()
            ));
        }
    };
    if merge_pending(worktree).is_none() {
        // git refused before it began (an untracked file in the way, say):
        // nothing was merged, the copy is as it was.
        return Err(format!(
            "Git didn't start the merge in the card's copy; nothing was changed. Git said: {}",
            said.trim()
        ));
    }
    Ok(())
}

/// The merge under way: its start time, the files it left to resolve, and
/// the merged commit as the card's trusted base candidate.
fn record_started(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    target: &str,
    paths: &[String],
) -> Result<(), String> {
    let at = crate::kanban::now_ms();
    kanban.with_card(workspace_id, card_id, |c| {
        if let Some(conflict) = c.ship_conflict.as_mut() {
            conflict.merge_started_at.get_or_insert(at);
            if !paths.is_empty() {
                conflict.paths = paths.to_vec();
            }
        }
        // A card from before recorded bases has none to add it to; its
        // review keeps the local computation, as before.
        if let Some(base) = c.worktree_base.as_mut() {
            base.merged_target = Some(target.to_string());
        }
        Ok(())
    })
}

/// "Undo the merge": `git merge --abort` in the card's copy, and the card
/// back at Ship stopped on a conflict. With no merge pending (the Builder
/// aborted it) only the record is put back.
pub fn undo(kanban: &KanbanStore, workspace_id: &str, card_id: &str) -> Result<(), String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    let worktree = worktree_of(&card)?;
    if merge_pending(&worktree).is_some() {
        crate::git::run(&worktree, &["merge", "--abort"])
            .map_err(|e| format!("The merge couldn't be undone; the card's copy is as it was. {e}"))?;
    }
    kanban.with_card(workspace_id, card_id, |c| {
        // 1.170.0 (G6): a conflict Bring in the target's changes met is
        // undone whole — the card is back where that press found it, and
        // the press is offered again.
        // (Challenger) The review status the press found is put back (an
        // approval stands). An open pull request's was never changed, so
        // whatever its loop wrote since stays.
        if let Some(conflict) = c.ship_conflict.take_if(|conflict| conflict.sync) {
            if c.review_status == Some(ReviewStatus::ConflictBlocked) {
                c.review_status = conflict.review_before;
            }
        } else if let Some(conflict) = c.ship_conflict.as_mut() {
            conflict.merge_started_at = None;
            c.review_status = Some(ReviewStatus::ConflictBlocked);
        }
        Ok(())
    })
}

/// A new round (a Finish and check that recorded a new snapshot) on a card
/// whose ship stopped on a conflict: the conflict is history, and the next
/// ship tries again.
pub fn clear_on_new_round(card: &mut KanbanCard) {
    if card.review_status == Some(ReviewStatus::ConflictBlocked) {
        card.review_status = None;
    }
    card.ship_conflict = None;
}
