use super::*;
use crate::kanban::{KanbanCard, KanbanColumnId, RunHistoryEntry};
use crate::snapshots::SnapshotsStore;
use crate::swarms::SwarmRegistry;
use std::fs;
use std::path::PathBuf;

const ONE_WORKSPACE: &str =
    r#"{"workspaces":[{"id":"w1","name":"One","cwd":"/x","createdAt":1,"lastOpenedAt":2}],"activeWorkspaceId":"w1"}"#;

/// A swarm folder the GC can classify (`swarms.rs::write_minimal_state_json`):
/// a finished brainstorm, which is pruned once no card links to it.
fn swarm_dir(config: &Path, id: &str) -> PathBuf {
    let dir = config.join("swarms").join(id);
    fs::create_dir_all(&dir).unwrap();
    let body = format!(
        r#"{{"schemaVersion":1,"id":"{id}","workspaceId":"w1","templateId":"scout-build-review","goal":"gc test","status":"done","state":{{"kind":"done"}},"kind":"brainstorm","iteration":0,"roleBindings":{{}},"runIds":[],"startedAt":1700000000000,"endedAt":1700000000001}}"#
    );
    fs::write(dir.join("state.json"), body).unwrap();
    dir
}

fn snapshot_dir(config: &Path, run_id: &str) -> PathBuf {
    let dir = config.join("snapshots").join(run_id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), "{}").unwrap();
    dir
}

/// A profile with one workspace, `w1`, whose board has one card linking a
/// swarm (`swarm-live`), a brainstorm (`brainstorm-live`) and, through its
/// run history, a run (`run-live`) — each with its folder — beside one
/// swarm folder and one snapshot folder nothing links to.
struct Profile {
    _tmp: tempfile::TempDir,
    config: PathBuf,
}

impl Profile {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        fs::create_dir_all(&config).unwrap();
        fs::write(config.join("workspaces.json"), ONE_WORKSPACE).unwrap();
        let kanban = KanbanStore::new(config.clone()).unwrap();
        let mut card = KanbanCard::new("c1".into(), "w1".into(), "Linked".into(), None, KanbanColumnId::Complete);
        card.linked_swarm_id = Some("swarm-live".into());
        card.linked_brainstorm_id = Some("brainstorm-live".into());
        let entry: RunHistoryEntry = serde_json::from_value(serde_json::json!({
            "runId": "run-live",
            "status": crate::agents::AgentStatus::Done,
            "endedAt": 1,
            "filesChangedCount": 0,
        }))
        .unwrap();
        card.run_history.push(entry);
        kanban.create_card("w1", card).unwrap();
        for id in ["swarm-live", "brainstorm-live", "swarm-orphan"] {
            swarm_dir(&config, id);
        }
        for id in ["run-live", "run-orphan"] {
            snapshot_dir(&config, id);
        }
        Self { _tmp: tmp, config }
    }

    fn board(&self) -> PathBuf {
        self.config.join(crate::kanban::KANBAN_SUBDIR).join("w1.json")
    }

    /// What `setup` does at launch, in its order: the project list, the
    /// boards, the inventory, then the two sweeps. Returns the inventory and
    /// what each sweep answered.
    fn launch(&self) -> (LaunchInventory, Option<(usize, usize)>, Option<(usize, usize)>) {
        self.launch_at(crate::kanban::now_ms())
    }

    /// [`Self::launch`] at `now_ms` (T5: how old a set-aside file is).
    fn launch_at(&self, now_ms: i64) -> (LaunchInventory, Option<(usize, usize)>, Option<(usize, usize)>) {
        let workspaces = WorkspaceStore::new(self.config.clone()).expect("the launch goes on");
        let kanban = KanbanStore::new(self.config.clone()).unwrap();
        let inventory = LaunchInventory::read_at(&workspaces, &kanban, &self.config, None, now_ms);
        let snapshots = SnapshotsStore::new(self.config.clone()).unwrap();
        let swept_snapshots = inventory.sweep_snapshots(&snapshots, &self.config, ["run-handoff".to_string()]);
        let swarms = SwarmRegistry::new(self.config.clone()).unwrap();
        let swept_swarms = inventory.sweep_swarms(&swarms);
        (inventory, swept_snapshots, swept_swarms)
    }

    fn has_swarm(&self, id: &str) -> bool {
        self.config.join("swarms").join(id).is_dir()
    }

    fn has_snapshot(&self, id: &str) -> bool {
        self.config.join("snapshots").join(id).is_dir()
    }

    /// Nothing was pruned: the linked folders and the orphans are all there.
    fn assert_untouched(&self) {
        for id in ["swarm-live", "brainstorm-live", "swarm-orphan"] {
            assert!(self.has_swarm(id), "{id}");
        }
        for id in ["run-live", "run-orphan"] {
            assert!(self.has_snapshot(id), "{id}");
        }
    }
}

/// A healthy profile prunes as it always did: what a card links to stays,
/// and so do a run still on disk and a retained handoff's run; what nothing
/// links to goes.
#[test]
fn a_whole_inventory_still_prunes_the_real_orphans() {
    let profile = Profile::new();
    fs::create_dir_all(profile.config.join("agents/runs")).unwrap();
    fs::write(profile.config.join("agents/runs/run-on-disk.json"), "{}").unwrap();
    for id in ["run-on-disk", "run-handoff"] {
        snapshot_dir(&profile.config, id);
    }
    let (inventory, snapshots, swarms) = profile.launch();
    assert!(inventory.reliable());
    assert_eq!(inventory.live_cards().unwrap(), &HashSet::from([("w1".to_string(), "c1".to_string())]));
    assert_eq!(snapshots, Some((3, 1)));
    assert_eq!(swarms, Some((2, 1)));
    assert!(profile.has_swarm("swarm-live") && profile.has_swarm("brainstorm-live"));
    assert!(!profile.has_swarm("swarm-orphan"));
    for id in ["run-live", "run-on-disk", "run-handoff"] {
        assert!(profile.has_snapshot(id), "{id}");
    }
    assert!(!profile.has_snapshot("run-orphan"));
}

/// The blocker: `workspaces.json` doesn't parse, so it is set aside and the
/// list is empty. No board is read, every linked swarm and snapshot would
/// look orphaned, and the sweeps would remove them. Nothing is pruned.
#[test]
fn a_project_list_set_aside_prunes_nothing() {
    let profile = Profile::new();
    fs::write(profile.config.join("workspaces.json"), br#"{"workspaces":[{"id":"w1","na"#).unwrap();
    let (inventory, snapshots, swarms) = profile.launch();
    assert!(!inventory.reliable());
    assert!(inventory.unreliable.as_deref().unwrap().contains("workspaces.json.broken-"), "{:?}", inventory.unreliable);
    assert_eq!(inventory.live_cards(), None, "the discussion registry skips its prune");
    assert_eq!((snapshots, swarms), (None, None));
    profile.assert_untouched();

    // The next launch finds no list at all, and the boards still there. T6:
    // and the set-aside file, which it names again.
    let (inventory, snapshots, swarms) = profile.launch();
    assert!(inventory.unreliable.as_deref().unwrap().contains("workspaces.json.broken-"), "{:?}", inventory.unreliable);
    assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
    profile.assert_untouched();

    // Without the set-aside file (moved away by hand): an empty list beside boards.
    for entry in fs::read_dir(&profile.config).unwrap().flatten() {
        if entry.file_name().to_string_lossy().starts_with("workspaces.json.broken-") {
            fs::remove_file(entry.path()).unwrap();
        }
    }
    let (inventory, snapshots, swarms) = profile.launch();
    assert!(inventory.unreliable.as_deref().unwrap().contains("the project list is empty"), "{:?}", inventory.unreliable);
    assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
    profile.assert_untouched();
}

/// R3: a list that was refused (a newer Plyloft's, or one this build can't
/// read) no longer stops the launch: it reads as no projects, with the
/// boards and what they link still there. Nothing is pruned, and the list
/// is left byte for byte.
#[test]
fn a_project_list_refused_prunes_nothing() {
    let newer = format!(r#"{{"version":{},"workspaces":[]}}"#, crate::workspace::WORKSPACES_VERSION + 1);
    let unknown = r#"{"workspaces":[{"id":"w1","name":"One","cwd":"/x","createdAt":1,"lastOpenedAt":2,"kanbanSyncMode":"future"}]}"#;
    for refused in [newer.as_str(), unknown] {
        let profile = Profile::new();
        fs::write(profile.config.join("workspaces.json"), refused).unwrap();
        let (inventory, snapshots, swarms) = profile.launch();
        let why = inventory.unreliable.as_deref().unwrap();
        assert!(why.contains("the project list was refused"), "{why}");
        assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
        profile.assert_untouched();
        assert_eq!(fs::read_to_string(profile.config.join("workspaces.json")).unwrap(), refused);
    }
}

/// A listed board that fails to load (here a newer Plyloft's) was silently
/// left out of the snapshot and swarm keep sets. Nothing is pruned.
#[test]
fn a_board_that_fails_to_load_prunes_nothing() {
    let profile = Profile::new();
    let newer = crate::kanban::KANBAN_SCHEMA_VERSION + 1;
    fs::write(profile.board(), format!(r#"{{"version":{newer},"cards":[]}}"#)).unwrap();
    let (inventory, snapshots, swarms) = profile.launch();
    assert!(inventory.unreliable.as_deref().unwrap().contains("board 'w1' could not be read"), "{:?}", inventory.unreliable);
    assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
    profile.assert_untouched();
}

/// A board set aside this launch reads as an empty board, with its cards'
/// links gone from the picture. Nothing is pruned on that launch — the
/// store's own session flag says so (R2), not a file name and a clock; one
/// set aside at an earlier launch doesn't hold the next ones back.
#[test]
fn a_board_set_aside_this_launch_prunes_nothing() {
    let profile = Profile::new();
    fs::write(profile.board(), b"{not a board").unwrap();
    let (inventory, snapshots, swarms) = profile.launch();
    let why = inventory.unreliable.as_deref().unwrap();
    assert!(why.contains("board 'w1' couldn't be read this launch") && why.contains("w1.json.unreadable-"), "{why}");
    assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
    profile.assert_untouched();

    // T5: the next launch reads an ordinary empty board, but the file set
    // aside is recent and may still be repaired by hand: nothing is pruned.
    let (inventory, snapshots, swarms) = profile.launch();
    let why = inventory.unreliable.as_deref().unwrap();
    assert!(why.contains("w1.json.unreadable-") && why.contains("less than 30 days ago"), "{why}");
    assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
    profile.assert_untouched();

    // Thirty days on the prunes resume; the file stays where it is.
    let (inventory, snapshots, swarms) = profile.launch_at(crate::kanban::now_ms() + 31 * DAY_MS);
    assert!(inventory.reliable(), "{:?}", inventory.unreliable);
    assert!(snapshots.is_some() && swarms.is_some());
    assert!(!profile.has_swarm("swarm-live"), "what only the lost cards linked goes, as it did at the second launch before");
    let boards = profile.config.join(crate::kanban::KANBAN_SUBDIR);
    assert!(fs::read_dir(&boards).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".unreadable-")));
}

/// T5: how old a set-aside file is comes from the `<ms>` in its name, never
/// from the file's own times. One day: held. Thirty-one: the prunes resume.
/// A name whose time can't be read: held. A zero-byte copy (what a restore
/// from an empty file keeps) and a restored marker hold nothing.
#[test]
fn a_recent_set_aside_board_file_keeps_the_prunes_off() {
    let now = crate::kanban::now_ms();
    let launch_with = |name: &str, bytes: &[u8]| {
        let profile = Profile::new();
        fs::write(profile.config.join(crate::kanban::KANBAN_SUBDIR).join(name), bytes).unwrap();
        let (inventory, snapshots, swarms) = profile.launch_at(now);
        (inventory.unreliable.clone(), snapshots.is_some() && swarms.is_some(), profile.has_swarm("swarm-orphan"))
    };
    let held = |(why, swept, orphan_kept): (Option<String>, bool, bool)| {
        assert!(why.as_deref().is_some_and(|why| why.contains("less than 30 days ago")), "{why:?}");
        assert!(!swept && orphan_kept, "nothing pruned");
    };
    let pruned = |(why, swept, orphan_kept): (Option<String>, bool, bool)| {
        assert_eq!(why, None);
        assert!(swept && !orphan_kept, "pruned as usual");
    };
    held(launch_with(&format!("gone.json.unreadable-{}", now - DAY_MS), b"{cut"));
    held(launch_with(&format!("gone.json.unreadable-{}", now - 29 * DAY_MS), b"{cut"));
    pruned(launch_with(&format!("gone.json.unreadable-{}", now - 31 * DAY_MS), b"{cut"));
    held(launch_with("gone.json.unreadable-soon", b"{cut"));
    held(launch_with("gone.json.unreadable-", b"{cut"));
    held(launch_with(&format!("gone.json.unreadable-{}", now + DAY_MS), b"{cut"));
    // A backup set aside because this build can't open its cards counts too.
    held(launch_with(&format!("gone.json.bak.unreadable-{}", now - DAY_MS), b"{cut"));
    // Nothing to repair in these.
    pruned(launch_with(&format!("gone.json.unreadable-{}", now - DAY_MS), b""));
    pruned(launch_with("gone.json.restored", br#"{"backupWrittenMs":1,"keptAs":"x"}"#));
    // Round 7: the marker beside a kept file is no file set aside, empty
    // (as it is written) or not — its name alone would hold the prunes off
    // for good, its time never parsing.
    pruned(launch_with(&format!("gone.json.unreadable-{}.unsaid", now - 31 * DAY_MS), b""));
    pruned(launch_with(&format!("gone.json.unreadable-{}.unsaid", now - 31 * DAY_MS), b"not empty"));
    pruned(launch_with("gone.json.unreadable-.unsaid", b"not empty"));
    pruned(launch_with("notes.txt", b"unreadable- is not in this name's place"));
}

/// R2: a board opened from its last saved copy is one save behind — a swarm
/// or a run linked in the lost save is not in it. Nothing is pruned on that
/// launch, also for what the restored cards don't name.
#[test]
fn a_board_opened_from_its_last_saved_copy_prunes_nothing_this_launch() {
    for unreadable in [&b""[..], &b"{not a board"[..]] {
        let profile = Profile::new();
        // A second save, so the backup holds the card; then the lost save.
        let kanban = KanbanStore::new(profile.config.clone()).unwrap();
        kanban.create_card("w1", KanbanCard::new("c2".into(), "w1".into(), "Later".into(), None, KanbanColumnId::Todo)).unwrap();
        drop(kanban);
        fs::write(profile.board(), unreadable).unwrap();

        let workspaces = WorkspaceStore::new(profile.config.clone()).unwrap();
        let kanban = KanbanStore::new(profile.config.clone()).unwrap();
        let inventory = LaunchInventory::read(&workspaces, &kanban, &profile.config, None);
        assert_eq!(kanban.load("w1").unwrap().len(), 1, "the backup's card is on the board");
        let why = inventory.unreliable.as_deref().unwrap();
        assert!(why.contains("board 'w1' couldn't be read this launch"), "{why}");
        assert_eq!(inventory.live_cards(), None);
        let snapshots = SnapshotsStore::new(profile.config.clone()).unwrap();
        assert_eq!(inventory.sweep_snapshots(&snapshots, &profile.config, Vec::new()), None);
        assert_eq!(inventory.sweep_swarms(&SwarmRegistry::new(profile.config.clone()).unwrap()), None);
        profile.assert_untouched();
    }
}

/// No projects and no boards is a fresh profile, not a lost list.
#[test]
fn an_empty_list_with_no_boards_is_the_whole_picture() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().to_path_buf();
    let workspaces = WorkspaceStore::new(config.clone()).unwrap();
    let kanban = KanbanStore::new(config.clone()).unwrap();
    let inventory = LaunchInventory::read(&workspaces, &kanban, &config, None);
    assert!(inventory.reliable());
    assert_eq!(inventory.live_cards(), Some(&HashSet::new()));
}

/// A card on the board `old.json` that links a swarm and, through its run
/// history, a run — with their folders.
fn unlisted_board(profile: &Profile, swarm: &str, run: &str) -> PathBuf {
    let other = tempfile::tempdir().unwrap();
    let kanban = KanbanStore::new(other.path().to_path_buf()).unwrap();
    let mut card = KanbanCard::new("old-card".into(), "old".into(), "From the lost list".into(), None, KanbanColumnId::Complete);
    card.linked_swarm_id = Some(swarm.into());
    card.run_history.push(
        serde_json::from_value(serde_json::json!({
            "runId": run,
            "status": crate::agents::AgentStatus::Done,
            "endedAt": 1,
            "filesChangedCount": 0,
        }))
        .unwrap(),
    );
    kanban.create_card("old", card).unwrap();
    let board = profile.config.join(crate::kanban::KANBAN_SUBDIR).join("old.json");
    fs::copy(other.path().join(crate::kanban::KANBAN_SUBDIR).join("old.json"), &board).unwrap();
    swarm_dir(&profile.config, swarm);
    snapshot_dir(&profile.config, run);
    board
}

/// R1: the list was set aside at an earlier launch and the person added
/// their folder again, so the list is whole and names a new id (`w1` here).
/// The old board is still on disk under its old id, and what its cards link
/// was pruned. It is read where it is, and what it links stays; the real
/// orphans still go, and the board file is not touched.
#[test]
fn a_board_the_list_does_not_name_still_protects_what_it_links() {
    let profile = Profile::new();
    let old = unlisted_board(&profile, "swarm-old", "run-old");
    let bytes = fs::read(&old).unwrap();
    let boards = profile.config.join(crate::kanban::KANBAN_SUBDIR);
    let listing = |dir: &Path| {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };
    let before = listing(&boards);

    let (inventory, snapshots, swarms) = profile.launch();
    assert!(inventory.reliable(), "{:?}", inventory.unreliable);
    assert!(inventory.live_cards().unwrap().contains(&("old".to_string(), "old-card".to_string())));
    assert_eq!(snapshots, Some((2, 1)));
    assert_eq!(swarms, Some((3, 1)));
    assert!(profile.has_swarm("swarm-old") && profile.has_snapshot("run-old"), "what the unlisted board links stays");
    assert!(profile.has_swarm("swarm-live") && profile.has_snapshot("run-live"));
    assert!(!profile.has_swarm("swarm-orphan") && !profile.has_snapshot("run-orphan"), "the real orphans still go");
    assert_eq!(fs::read(&old).unwrap(), bytes, "read where it is: byte-identical");
    assert_eq!(listing(&boards), before, "nothing moved, nothing written beside it");
}

/// R1: an unlisted board that can't be read may link anything, so nothing
/// is pruned — and it is left exactly as it was found, never set aside.
#[test]
fn an_unlisted_board_that_cannot_be_read_prunes_nothing_and_is_left_alone() {
    let newer = format!(r#"{{"version":{},"cards":[]}}"#, crate::kanban::KANBAN_SCHEMA_VERSION + 1);
    for unreadable in [&b"{not a board"[..], newer.as_bytes()] {
        let profile = Profile::new();
        let old = profile.config.join(crate::kanban::KANBAN_SUBDIR).join("old.json");
        fs::write(&old, unreadable).unwrap();
        let (inventory, snapshots, swarms) = profile.launch();
        let why = inventory.unreliable.as_deref().unwrap();
        assert!(why.contains("board 'old'") && why.contains("doesn't name"), "{why}");
        assert_eq!((inventory.live_cards(), snapshots, swarms), (None, None, None));
        profile.assert_untouched();
        assert_eq!(fs::read(&old).unwrap(), unreadable, "byte-identical");
        assert_eq!(fs::read_dir(old.parent().unwrap()).unwrap().count(), 2, "w1.json and old.json: nothing set aside");
    }
}

/// R1: an unlisted board file at zero bytes is an empty board only while no
/// backup beside it holds cards; the backup is not read as the board.
#[test]
fn an_empty_unlisted_board_beside_a_backup_with_cards_prunes_nothing() {
    let profile = Profile::new();
    let boards = profile.config.join(crate::kanban::KANBAN_SUBDIR);
    fs::write(boards.join("old.json"), b"").unwrap();
    let (inventory, ..) = profile.launch();
    assert!(inventory.reliable(), "an empty file with no backup is an empty board: {:?}", inventory.unreliable);

    let profile = Profile::new();
    let boards = profile.config.join(crate::kanban::KANBAN_SUBDIR);
    fs::write(boards.join("old.json"), b"").unwrap();
    fs::copy(boards.join("w1.json"), boards.join("old.json.bak")).unwrap();
    let (inventory, snapshots, swarms) = profile.launch();
    assert!(inventory.unreliable.as_deref().unwrap().contains("its backup holds cards"), "{:?}", inventory.unreliable);
    assert_eq!((snapshots, swarms), (None, None));
    profile.assert_untouched();
    assert_eq!(fs::read(boards.join("old.json")).unwrap(), b"");
}

#[test]
fn unlisted_boards_are_the_board_files_the_list_does_not_name() {
    let tmp = tempfile::tempdir().unwrap();
    // T2: a restored marker (`<id>.json.restored`) is not a board either.
    for name in ["w1.json", "old.json", "old.json.bak", "old.json.unreadable-17", "old.json.restored", "lost.json.restored", "gone.json.atelier-tmp", ".json", "notes.txt"] {
        fs::write(tmp.path().join(name), "{}").unwrap();
    }
    let found = unlisted_boards(tmp.path(), &["w1".to_string()]).unwrap();
    assert_eq!(found, vec![("old".to_string(), tmp.path().join("old.json"))]);
    assert_eq!(unlisted_boards(&tmp.path().join("none"), &[]).unwrap(), Vec::new(), "no folder: no boards");
    assert!(unlisted_boards(&tmp.path().join("w1.json"), &[]).is_err(), "a folder that can't be listed is said");
}

/// R4: a coordination state set aside this launch opens empty, and the
/// handoffs it retained protect snapshot folders. Nothing is pruned on that
/// launch; the next one, with the registry read, prunes again.
#[test]
fn a_coordination_state_set_aside_prunes_nothing() {
    let profile = Profile::new();
    let state = ply_collab::coordination_path(&profile.config);
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    fs::write(&state, b"{ cut short").unwrap();
    let launch = |now_ms: i64| {
        let coordination = crate::coordination::CoordinationRegistry::new(profile.config.clone()).expect("the launch goes on");
        let workspaces = WorkspaceStore::new(profile.config.clone()).unwrap();
        let kanban = KanbanStore::new(profile.config.clone()).unwrap();
        let inventory = LaunchInventory::read_at(&workspaces, &kanban, &profile.config, coordination.set_aside(), now_ms);
        let snapshots = SnapshotsStore::new(profile.config.clone()).unwrap();
        let swept = inventory.sweep_snapshots(&snapshots, &profile.config, coordination.protected_snapshot_run_ids());
        (inventory, swept)
    };
    let now = crate::kanban::now_ms();
    let (inventory, swept) = launch(now);
    let why = inventory.unreliable.as_deref().unwrap();
    assert!(why.contains("the record of handoffs") && why.contains("state.json.broken-"), "{why}");
    assert_eq!((inventory.live_cards(), swept), (None, None));
    profile.assert_untouched();

    // T5: the launches after it, while the file set aside is recent — the
    // registry is an ordinary empty one by then, and says nothing.
    for later in [now + DAY_MS, now + 29 * DAY_MS] {
        let (inventory, swept) = launch(later);
        let why = inventory.unreliable.as_deref().unwrap();
        assert!(why.contains("state.json.broken-") && why.contains("less than 30 days ago"), "{why}");
        assert_eq!(swept, None);
        profile.assert_untouched();
    }
    // Another store's file set aside in that folder is not the handoffs'.
    fs::write(state.with_file_name(format!("reviewer-capabilities.json.broken-{}", now + 40 * DAY_MS)), b"{cut").unwrap();

    let (inventory, swept) = launch(now + 31 * DAY_MS);
    assert!(inventory.reliable(), "{:?}", inventory.unreliable);
    assert_eq!(swept, Some((1, 1)));
    // `setup` hands the registry's answer in.
    assert!(include_str!("lib.rs").contains(".and_then(|coordination| coordination.set_aside().map(|aside| aside.to_path_buf()))"));
}
