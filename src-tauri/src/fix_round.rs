//! 1.175.0 (F5, UX-5; owner I6, I7): Finish and check by itself after a
//! fix round Plyloft sent the Builder. The rule and the driver live in the
//! window (`src/lib/fixRoundCheck.ts`, `src/store/fixRoundStore.ts`), which
//! alone reads the Builder's terminal; this module keeps the card's two
//! fields and answers the one question the window can't: did the Builder
//! change anything since the snapshot the Reviewer read?
//!
//! Nothing here writes to GitHub, starts a process other than a bounded
//! `git` read, or answers the Builder: the window starts Finish and check
//! through the same path as the person's press.

use tauri::State;

use crate::kanban::{KanbanCard, KanbanStore};

/// "After a fix round" on this card: `Some(true)` checks by itself,
/// `Some(false)` waits for the person, `None` follows the setting.
#[tauri::command]
pub fn card_fix_round_check_set(
    app: tauri::AppHandle,
    kanban: State<'_, KanbanStore>,
    workspace_id: String,
    card_id: String,
    check: Option<bool>,
) -> Result<KanbanCard, String> {
    kanban.with_card(&workspace_id, &card_id, |c| {
        c.fix_round_check = check;
        Ok(())
    })?;
    crate::kanban::emit_kanban_changed(&app, &workspace_id);
    kanban.get_card(&workspace_id, &card_id)
}

/// How many checks Plyloft started by itself in a row on this card (the
/// window counts one before it starts a check, and sets zero at an
/// approval or the person's own press). Book-keeping: the card's
/// `updated_at` stays.
#[tauri::command]
pub fn card_fix_round_self_checks_set(
    app: tauri::AppHandle,
    kanban: State<'_, KanbanStore>,
    workspace_id: String,
    card_id: String,
    count: u8,
) -> Result<u8, String> {
    set_self_checks(&kanban, &workspace_id, &card_id, count)?;
    crate::kanban::emit_kanban_changed(&app, &workspace_id);
    Ok(count)
}

pub(crate) fn set_self_checks(store: &KanbanStore, workspace_id: &str, card_id: &str, count: u8) -> Result<(), String> {
    store.with_card_unstamped(workspace_id, card_id, |c| {
        if c.pr_review.is_some() {
            return Err("This card reviews somebody else's pull request: Plyloft never checks it by itself.".into());
        }
        c.fix_round_self_checks = count;
        Ok(())
    })
}

/// Whether the card's copy differs from its last snapshot — a commit since,
/// or a change git sees (ignored files aside). `None` when it can't be told
/// (no copy, no snapshot, git failed): the window then doesn't start a
/// check by itself on a guess, and says so as it does for any wait.
#[tauri::command(async)]
pub fn card_fix_round_changed(
    kanban: State<'_, KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<Option<bool>, String> {
    let card = kanban.get_card(&workspace_id, &card_id)?;
    Ok(changed_since_snapshot(&card))
}

pub(crate) fn changed_since_snapshot(card: &KanbanCard) -> Option<bool> {
    let path = std::path::PathBuf::from(card.worktree_path.as_deref()?);
    let last = card.builder.as_ref()?.snapshots.last()?.sha.clone();
    if !path.is_dir() || last.trim().is_empty() {
        return None;
    }
    let head = git(&path, &["rev-parse", "HEAD"])?;
    if !head.trim().eq_ignore_ascii_case(last.trim()) {
        return Some(true);
    }
    let status = git(&path, &["status", "--porcelain", "--untracked-files=normal"])?;
    Some(!status.trim().is_empty())
}

fn git(cwd: &std::path::Path, args: &[&str]) -> Option<String> {
    let mut cmd = crate::platform::git_command();
    cmd.current_dir(cwd).args(args);
    crate::worktrees::run_bounded(&mut cmd, "fix round: git", std::time::Duration::from_secs(10)).ok()
}

#[cfg(test)]
#[path = "fix_round_tests.rs"]
mod tests;
