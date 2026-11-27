//! 1.175.0 (A2, fix round 1): what the boards name at launch, and whether
//! that can be trusted before anything is pruned on it.
//!
//! Three launch sweeps delete what no card links to any more: discussion
//! records (`discussion::DiscussionRegistry::new`), snapshot folders
//! (`snapshots::SnapshotsStore::gc_orphans`) and swarm folders
//! (`swarms::SwarmRegistry::gc_orphan_swarm_dirs`). Each takes "what is still
//! linked" from the boards of the workspaces in `workspaces.json`. That is
//! only as good as the list and the boards: when the list couldn't be read
//! (set aside as `.broken-<ms>`, OP-3) it is empty, every card-linked swarm
//! and snapshot looks orphaned, and the sweeps would remove them for good.
//! Before 1.175.0 a list that didn't parse stopped the launch before any
//! sweep ran; a board that failed to load was silently left out of two of
//! the three.
//!
//! [`LaunchInventory::read`] gathers the links once and says whether they
//! are the whole picture. When they are not, none of the three prunes:
//! [`LaunchInventory::live_cards`] is `None` (the discussion registry's own
//! "skip the prune" input) and the two sweeps here return `None`. Something
//! left a launch too long costs disk; something pruned on a wrong inventory
//! is gone.

use std::collections::HashSet;
use std::path::Path;

use crate::discussion::LiveCardKey;
use crate::kanban::KanbanStore;
use crate::workspace::WorkspaceStore;

/// The cards of every board on disk — the listed workspaces' and the ones
/// the list doesn't name — and what they link to.
#[derive(Debug, Default)]
pub struct LaunchInventory {
    /// Why the links below are not the whole picture; `None` when they are.
    unreliable: Option<String>,
    cards: HashSet<LiveCardKey>,
    /// `run_history[].run_id` and `linked_run_id` of every card.
    run_ids: HashSet<String>,
    /// `linked_brainstorm_id` and `linked_swarm_id` of every card.
    swarm_ids: HashSet<String>,
}

impl LaunchInventory {
    /// Read every listed workspace's board.
    ///
    /// R1: then every other `<id>.json` in the boards folder. A board the
    /// list doesn't name is never a project the person removed — removing
    /// one deletes its board file (`KanbanStore::delete_workspace`) — so it
    /// belongs to a list that was lost: after a list was set aside and the
    /// person added their folder again, the list is whole and names a new
    /// id, while the old board still links the swarms, runs and discussions
    /// of its cards. It is read where it is, never loaded, moved or written
    /// (`kanban::peek_board`), and what it links is kept.
    ///
    /// Not the whole picture when: the project list was set aside this
    /// launch, or refused (R3: a newer Plyloft's, or one this build can't
    /// read — it reads as no projects); the list is empty while board files
    /// exist; a board, listed or
    /// not, couldn't be read; a board was set aside, or opened from its last
    /// saved copy, since the app started (R2: the store's own session flag,
    /// `KanbanStore::first_not_whole` — a copy is one save behind, and a
    /// swarm or run linked in the lost save is not in it). The first reason
    /// found is kept and logged, once.
    ///
    /// R4: nor when the coordination state was set aside this launch
    /// (`handoffs_set_aside`, `CoordinationRegistry::set_aside`): the
    /// handoffs it retained protect snapshot folders, and an empty registry
    /// protects none of them.
    ///
    /// Round 4 (T5): nor while a file set aside at an earlier launch is
    /// recent ([`recent_set_aside`], [`SET_ASIDE_HOLDS_PRUNES_MS`]). The
    /// session's own flags above last one launch: at the next the board is
    /// an ordinary empty one and the registry an ordinary empty one, the
    /// inventory was "whole" again, and what the set-aside file's cards or
    /// handoffs linked was pruned while the file could still be repaired by
    /// hand.
    pub fn read(
        workspaces: &WorkspaceStore,
        kanban: &KanbanStore,
        config_dir: &Path,
        handoffs_set_aside: Option<&Path>,
    ) -> Self {
        Self::read_at(workspaces, kanban, config_dir, handoffs_set_aside, crate::kanban::now_ms())
    }

    /// [`Self::read`] at `now_ms`, which a test moves.
    fn read_at(
        workspaces: &WorkspaceStore,
        kanban: &KanbanStore,
        config_dir: &Path,
        handoffs_set_aside: Option<&Path>,
        now_ms: i64,
    ) -> Self {
        let mut inventory = Self::default();
        if let Some(aside) = handoffs_set_aside {
            inventory.doubt(format!(
                "the record of handoffs couldn't be read and was set aside as {}",
                aside.display()
            ));
        }
        let ids: Vec<String> = workspaces.snapshot().workspaces.into_iter().map(|w| w.id).collect();
        let boards_dir = crate::kanban::boards_dir(config_dir);
        if let Some(aside) = workspaces.set_aside() {
            inventory.doubt(format!("the project list couldn't be read and was set aside as {}", aside.display()));
        } else if let Some(why) = workspaces.refused() {
            inventory.doubt(format!("the project list was refused and left as it is: {why}"));
        } else if ids.is_empty() && has_board_file(&boards_dir) {
            inventory.doubt(format!("the project list is empty, but {} holds boards", boards_dir.display()));
        }
        for workspace_id in &ids {
            match kanban.load(workspace_id) {
                Ok(cards) => inventory.keep(workspace_id, cards),
                Err(error) => inventory.doubt(format!("board '{workspace_id}' could not be read: {error}")),
            }
        }
        match unlisted_boards(&boards_dir, &ids) {
            Ok(unlisted) => {
                for (workspace_id, path) in unlisted {
                    match crate::kanban::peek_board(&path) {
                        Ok(cards) => inventory.keep(&workspace_id, cards),
                        Err(error) => inventory.doubt(format!(
                            "board '{workspace_id}', which the project list doesn't name, could not be read: {error}"
                        )),
                    }
                }
            }
            Err(error) => inventory.doubt(format!("{} could not be listed: {error}", boards_dir.display())),
        }
        if let Some((workspace_id, kept_as)) = kanban.first_not_whole() {
            inventory.doubt(format!(
                "board '{workspace_id}' couldn't be read this launch (its file is kept as {}), so its cards aren't the whole picture",
                kept_as.display()
            ));
        }
        // T5: what an earlier launch set aside, while it is recent.
        let coordination_dir = ply_collab::coordination_path(config_dir);
        let recent = recent_set_aside(&boards_dir, crate::atomic::UNREADABLE_SUFFIX, None, false, now_ms).or_else(|| {
            let state = coordination_dir.file_name()?.to_str()?;
            recent_set_aside(coordination_dir.parent()?, crate::atomic::BROKEN_SUFFIX, Some(state), true, now_ms)
        });
        if let Some(aside) = recent {
            inventory.doubt(format!(
                "{} was set aside less than {} days ago and may still be repaired by hand",
                aside.display(),
                SET_ASIDE_HOLDS_PRUNES_MS / DAY_MS
            ));
        }
        if let Some(why) = &inventory.unreliable {
            log::warn!(
                "launch: nothing is pruned this launch (discussion records, snapshot folders, swarm folders): {why}"
            );
        }
        inventory
    }

    /// `cards` are on the board of `workspace_id`: they and what they link stay.
    fn keep(&mut self, workspace_id: &str, cards: Vec<crate::kanban::KanbanCard>) {
        for card in cards {
            self.run_ids.extend(card.run_history.iter().map(|entry| entry.run_id.clone()));
            self.run_ids.extend(card.linked_run_id.clone());
            self.swarm_ids.extend(card.linked_brainstorm_id.clone());
            self.swarm_ids.extend(card.linked_swarm_id.clone());
            self.cards.insert((workspace_id.to_string(), card.id));
        }
    }

    fn doubt(&mut self, why: String) {
        self.unreliable.get_or_insert(why);
    }

    /// Whether the boards were all read, so what no card links to is unused.
    pub fn reliable(&self) -> bool {
        self.unreliable.is_none()
    }

    /// The cards that exist, for `DiscussionRegistry::new`'s retention;
    /// `None` skips its prune.
    pub fn live_cards(&self) -> Option<&HashSet<LiveCardKey>> {
        self.reliable().then_some(&self.cards)
    }

    /// The snapshot folders to keep: every agent run still on disk
    /// (`agents/runs/<id>.json`), every run a card names, and `protected`
    /// (retained handoffs' runs).
    fn snapshot_keep(&self, config_dir: &Path, protected: impl IntoIterator<Item = String>) -> HashSet<String> {
        let mut keep = self.run_ids.clone();
        if let Ok(entries) = std::fs::read_dir(config_dir.join("agents").join("runs")) {
            keep.extend(entries.flatten().filter_map(|entry| {
                entry.file_name().to_str().and_then(|name| name.strip_suffix(".json")).map(String::from)
            }));
        }
        keep.extend(protected);
        keep
    }

    /// v1.17.0's launch GC of orphaned snapshot folders: `(kept, deleted)`,
    /// or `None` when the inventory isn't the whole picture and nothing was
    /// pruned.
    pub fn sweep_snapshots(
        &self,
        store: &crate::snapshots::SnapshotsStore,
        config_dir: &Path,
        protected: impl IntoIterator<Item = String>,
    ) -> Option<(usize, usize)> {
        self.reliable().then(|| store.gc_orphans(&self.snapshot_keep(config_dir, protected)))
    }

    /// v1.28.0's launch GC of orphaned swarm folders: `(kept, deleted)`, or
    /// `None` when the inventory isn't the whole picture and nothing was
    /// pruned.
    pub fn sweep_swarms(&self, registry: &crate::swarms::SwarmRegistry) -> Option<(usize, usize)> {
        self.reliable().then(|| registry.gc_orphan_swarm_dirs(&self.swarm_ids))
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Round 4 (T5; owner's prudent option): how long a file that was set aside
/// keeps the launch prunes off. Long enough for a repair by hand, short
/// enough that the prunes come back by themselves.
pub const SET_ASIDE_HOLDS_PRUNES_MS: i64 = 30 * DAY_MS;

/// T5: a file in `dir` that was set aside less than
/// [`SET_ASIDE_HOLDS_PRUNES_MS`] ago — its name holds `suffix` followed by
/// the time it was set aside, in ms (`<id>.json.unreadable-<ms>`,
/// `<id>.json.bak.unreadable-<ms>`, `state.json.broken-<ms>`). The time is
/// the one in the name, never the file's own (a copy or a restore from a
/// backup changes those). A name whose time can't be read counts as recent:
/// better a prune held back than one made on a guess.
///
/// `of`: only files set aside from this name. `also_empty`: whether a file
/// of zero bytes counts. In the boards folder it does not: the zero-byte
/// copy a restore keeps holds no card to repair.
fn recent_set_aside(dir: &Path, suffix: &str, of: Option<&str>, also_empty: bool, now_ms: i64) -> Option<std::path::PathBuf> {
    let mut recent: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            // Round 7: `<kept file>.unsaid` (kanban's marker that a notice
            // is still owed) holds the suffix in its name and no time that
            // parses — which would count as recent, for good. It is no file
            // set aside: skipped by name, whatever its size.
            if name.to_str().is_some_and(|name| name.ends_with(".unsaid")) {
                return false;
            }
            let Some((from, at)) = name.to_str().and_then(|name| name.rsplit_once(suffix)) else { return false };
            if of.is_some_and(|of| of != from) || from.is_empty() {
                return false;
            }
            if !also_empty && entry.metadata().is_ok_and(|meta| meta.len() == 0) {
                return false;
            }
            at.parse::<i64>().map_or(true, |at| now_ms.saturating_sub(at) < SET_ASIDE_HOLDS_PRUNES_MS)
        })
        .map(|entry| entry.path())
        .collect();
    recent.sort();
    recent.into_iter().next()
}

/// Whether `boards_dir` holds a board file (`<id>.json`).
pub(crate) fn has_board_file(boards_dir: &Path) -> bool {
    std::fs::read_dir(boards_dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
    })
}

/// R1: the board files in `boards_dir` (`<id>.json`, as
/// `KanbanStore::board_ids` tells one from a backup or a set-aside file)
/// whose id isn't in `listed`, sorted by id. No folder is no boards; a
/// folder that can't be listed is an error, since a board in it may link
/// what the sweeps would remove.
fn unlisted_boards(boards_dir: &Path, listed: &[String]) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let entries = match std::fs::read_dir(boards_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut boards = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
        if !id.is_empty() && !id.contains('.') && !listed.iter().any(|known| known == id) {
            boards.push((id.to_string(), entry.path()));
        }
    }
    boards.sort();
    Ok(boards)
}

#[cfg(test)]
#[path = "launch_inventory_tests.rs"]
mod tests;
