//! Windows walk 2026-10-20 (Try it spec §4.5): a card's copy that Ship
//! couldn't move to the trash — on Windows a program with its folder open
//! (the card's Builder session, whose working folder it is, until it closes —
//! G11: Plyloft closes it after the ship, unless Undo kept it) refuses the
//! rename (os error 32). The card says so (`KanbanCard::kept_copy`), and
//! Plyloft tries again when the card's Builder session closes or ends and at
//! the next launch, clearing the record once the copy is gone. Nothing here
//! ends a program.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::kanban::KanbanStore;

/// A card's copy kept on this machine after the card shipped, and why.
/// Written by the backend alone; local only, never synced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptCopy {
    /// The copy's folder.
    pub path: String,
    /// What the move to the trash said (the card's Details).
    pub reason: String,
    /// When (unix ms) it was kept, or last tried.
    pub at: i64,
    /// A released copy the card still leads to (the release's batch prune
    /// keeps the handle): the commit it held, which a later try requires it
    /// to still hold, clean, before it goes. Absent for Land's copies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

/// What a try again did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Retry {
    /// The card keeps no copy.
    Nothing,
    /// The copy went to the trash (or was gone already): the record is cleared.
    Removed,
    /// Still held; the record has the latest reason.
    StillKept(String),
}

/// Move the card copy at `path` to the trash, as Ship does
/// (`worktrees::prune_worktree_at`); when it can't, record on the card that
/// its copy was kept and why. Returns the move's own result.
pub fn prune_or_keep(
    store: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    ws_cwd: &Path,
    path: &Path,
    cache_paths: &[String],
) -> Result<Option<PathBuf>, String> {
    let moved = crate::worktrees::prune_worktree_at(ws_cwd, path, cache_paths);
    match &moved {
        Ok(_) => clear(store, workspace_id, card_id),
        Err(e) if path.exists() => record(store, workspace_id, card_id, path, e, None),
        Err(_) => {}
    }
    moved
}

/// Record that the card's copy at `path` was kept, and why (`head`: see
/// [`KeptCopy::head`]).
pub fn record(store: &KanbanStore, workspace_id: &str, card_id: &str, path: &Path, reason: &str, head: Option<String>) {
    let kept = KeptCopy {
        path: path.to_string_lossy().to_string(),
        reason: reason.to_string(),
        at: crate::kanban::now_ms(),
        head,
    };
    if let Err(e) = store.with_card(workspace_id, card_id, move |c| {
        c.kept_copy = Some(kept);
        Ok(())
    }) {
        log::warn!("kept copy {workspace_id}/{card_id}: record: {e}");
    }
}

fn clear(store: &KanbanStore, workspace_id: &str, card_id: &str) {
    let has = store.get_card(workspace_id, card_id).is_ok_and(|c| c.kept_copy.is_some());
    if !has {
        return;
    }
    if let Err(e) = store.with_card(workspace_id, card_id, |c| {
        c.kept_copy = None;
        Ok(())
    }) {
        log::warn!("kept copy {workspace_id}/{card_id}: clear: {e}");
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (crate::platform::canonicalize(a), crate::platform::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

/// The card's kept copy, when its path is a card folder of this workspace
/// (directly in one of its worktree folders) named after the card — the
/// only folder a delete or a retry may act on for it.
pub fn validated_path(ws_cwd: &Path, card: &crate::kanban::KanbanCard) -> Option<PathBuf> {
    let path = PathBuf::from(&card.kept_copy.as_ref()?.path);
    let name = crate::worktrees::card_worktree_location(ws_cwd, &path).ok()?;
    (name == card.id).then_some(path)
}

/// Try again to move the card's kept copy to the trash. A copy the card
/// holds again as its own (`worktree_path`) is not a leftover: the record
/// goes, the folder stays. The card's branch record (N18) gets the trash
/// entry the ship couldn't give it.
pub fn retry(store: &KanbanStore, workspace_id: &str, card_id: &str, ws_cwd: &Path, cache_paths: &[String]) -> Retry {
    let Ok(card) = store.get_card(workspace_id, card_id) else {
        return Retry::Nothing;
    };
    let Some(kept) = card.kept_copy.clone() else {
        return Retry::Nothing;
    };
    // Only a card folder of this workspace named after the card is acted on;
    // a record naming anything else is dropped, the folder left alone.
    let Some(path) = validated_path(ws_cwd, &card) else {
        log::warn!("kept copy {workspace_id}/{card_id}: its path is not this card's folder; record dropped");
        clear(store, workspace_id, card_id);
        return Retry::Nothing;
    };
    if !path.exists() {
        clear(store, workspace_id, card_id);
        return Retry::Removed;
    }
    // The card still leads to the folder: only a released copy (the batch
    // prune's, `head` recorded) that still holds exactly what was released
    // goes, with its handle; anything else is the card's own again.
    let its_own = card.worktree_path.as_deref().is_some_and(|p| same_dir(Path::new(p), &path));
    if its_own {
        let released = card.ship_status == crate::kanban::ShipStatus::Shipped
            && kept.head.is_some()
            && crate::worktrees::head_sha(&path).ok() == kept.head
            && crate::worktrees::worktree_is_dirty(&path).ok() == Some(false);
        if !released {
            clear(store, workspace_id, card_id);
            return Retry::Nothing;
        }
    }
    // One try per folder at a time: a session's close, its end and the
    // launch can all ask at once.
    let Some(_flight) = Flight::take(&path) else {
        return Retry::StillKept("another try is under way".into());
    };
    match crate::worktrees::prune_worktree_at(ws_cwd, &path, cache_paths) {
        Ok(entry) => {
            crate::verify_logs::card_worktree_removed(workspace_id, card_id);
            let entry = entry.map(|e| e.to_string_lossy().to_string());
            if let Err(e) = store.with_card(workspace_id, card_id, move |c| {
                c.kept_copy = None;
                if its_own {
                    c.worktree_path = None;
                    c.branch_name = None;
                    c.worktree_base = None;
                    c.worktree_setup = None;
                }
                if let (Some(rec), Some(entry)) = (c.branch_cleanup.as_mut(), entry) {
                    if rec.trash_entry.is_none() && rec.outcome.is_none() {
                        rec.trash_entry = Some(entry);
                    }
                }
                Ok(())
            }) {
                log::warn!("kept copy {workspace_id}/{card_id}: clear: {e}");
            }
            log::info!("kept copy {workspace_id}/{card_id}: moved to the trash on a later try");
            Retry::Removed
        }
        Err(e) => {
            record(store, workspace_id, card_id, &path, &e, kept.head.clone());
            Retry::StillKept(e)
        }
    }
}

/// The folders being tried now (`retry`'s single flight).
static IN_FLIGHT: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

struct Flight(PathBuf);

impl Flight {
    fn take(path: &Path) -> Option<Self> {
        let mut set = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
        set.insert(path.to_path_buf()).then(|| Flight(path.to_path_buf()))
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// Every kept copy of the workspace, tried again (the launch). Returns how
/// many went.
pub fn retry_all(store: &KanbanStore, workspace_id: &str, ws_cwd: &Path, cache_paths: &[String]) -> usize {
    let Ok(cards) = store.load(workspace_id) else {
        return 0;
    };
    cards
        .iter()
        .filter(|c| c.kept_copy.is_some())
        .filter(|c| retry(store, workspace_id, &c.id, ws_cwd, cache_paths) == Retry::Removed)
        .count()
}

/// The launch, on its own worker (never the main thread): every
/// workspace's kept copies tried again, the boards told of what went.
pub fn retry_all_at_launch(app: &tauri::AppHandle) {
    use tauri::Manager;
    let store = app.state::<KanbanStore>();
    let configs = app.state::<crate::project_config::ProjectConfigStore>();
    for ws in app.state::<crate::workspace::WorkspaceStore>().snapshot().workspaces {
        let tidied = retry_all(&store, &ws.id, Path::new(&ws.cwd), &configs.cache_paths(&ws.id));
        if tidied > 0 {
            log::info!("kept copy: {tidied} card copy(ies) of {} moved to the trash at launch", ws.id);
            crate::kanban::emit_kanban_changed(app, &ws.id);
        }
    }
}

/// How long after a session closed each try waits: its processes take a
/// moment to exit, and Windows lets go of the folder only then.
pub const AFTER_SESSION_TRIES: [Duration; 4] = [
    Duration::from_millis(300),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

/// The card's Builder session closed or ended: try its kept copy again, on a
/// worker, a few times while the session's processes exit, then tell the
/// board. Nothing when the card keeps no copy.
pub fn retry_after_session(app: &tauri::AppHandle, workspace_id: &str, card_id: &str) {
    use tauri::Manager;
    let store = app.state::<KanbanStore>();
    if !store.get_card(workspace_id, card_id).is_ok_and(|c| c.kept_copy.is_some()) {
        return;
    }
    let Some(ws_cwd) = app
        .state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd))
    else {
        return;
    };
    let cache_paths = app.state::<crate::project_config::ProjectConfigStore>().cache_paths(workspace_id);
    let app = app.clone();
    let (workspace_id, card_id) = (workspace_id.to_string(), card_id.to_string());
    std::thread::spawn(move || {
        let store = app.state::<KanbanStore>();
        let mut outcome = Retry::Nothing;
        for wait in AFTER_SESSION_TRIES {
            std::thread::sleep(wait);
            outcome = retry(&store, &workspace_id, &card_id, &ws_cwd, &cache_paths);
            if !matches!(outcome, Retry::StillKept(_)) {
                break;
            }
        }
        if let Retry::StillKept(e) = &outcome {
            log::info!("kept copy {workspace_id}/{card_id}: still held after the session closed: {e}");
        }
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::{KanbanCard, KanbanColumnId};

    fn shipped_card(store: &KanbanStore, id: &str) {
        let mut card = KanbanCard::new(id.into(), "ws".into(), format!("T {id}"), None, KanbanColumnId::Complete);
        card.branch_cleanup = Some(crate::branch_cleanup::BranchCleanup::new(
            &format!("atelier/{id}"),
            "abc123",
            crate::branch_cleanup::CleanupReason::Landed,
            1,
            None,
        ));
        store.create_card("ws", card).unwrap();
    }

    /// Schema: a board from before `keptCopy` loads with none, and one
    /// written with it reads back the same.
    #[test]
    fn a_card_from_before_kept_copy_loads_without_one() {
        let old = br#"{"id":"c","workspaceId":"ws","title":"T","columnId":"complete","createdAt":1,"updatedAt":1}"#;
        let card: KanbanCard = serde_json::from_slice(old).expect("parse");
        assert_eq!(card.kept_copy, None);
        let json = serde_json::to_string(&card).unwrap();
        assert!(!json.contains("keptCopy"), "nothing written while nothing was kept");
        let mut card = card;
        card.kept_copy = Some(KeptCopy { path: "/r/.plyloft-worktrees/c".into(), reason: "in use".into(), at: 5, head: None });
        let json = serde_json::to_string(&card).unwrap();
        assert!(json.contains(r#""keptCopy":{"path":"/r/.plyloft-worktrees/c","reason":"in use","at":5}"#), "{json}");
        let back: KanbanCard = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kept_copy, card.kept_copy);
    }

    /// Tier 2 (schema): an untouched `kanban.json` whose card has no
    /// `keptCopy` loads, and a save of that board (a change to another
    /// field) adds no `keptCopy` key to it.
    #[test]
    fn an_old_board_loads_and_saves_without_a_kept_copy_key() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let file = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json");
        let old = br#"{"version":8,"cards":[{"id":"c1","workspaceId":"ws","title":"Old","columnId":"complete","createdAt":1,"updatedAt":1,"worktreePath":"/r/.plyloft-worktrees/c1"}]}"#;
        std::fs::write(&file, old).unwrap();
        let card = store.get_card("ws", "c1").expect("the old card loads");
        assert_eq!(card.kept_copy, None);
        store
            .with_card("ws", "c1", |c| {
                c.title = "Old, renamed".into();
                Ok(())
            })
            .unwrap();
        let saved = std::fs::read_to_string(&file).unwrap();
        assert!(saved.contains("Old, renamed"), "the board was written");
        assert!(!saved.contains("keptCopy"), "no keptCopy key added: {saved}");
        // Read back from disk by a fresh store, the same.
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(again.get_card("ws", "c1").unwrap().kept_copy, None);
    }

    /// A record naming anything but this card's folder of this workspace is
    /// never acted on: dropped, the folder left alone.
    #[test]
    fn a_kept_copy_outside_the_cards_folder_is_never_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let store = KanbanStore::new(tmp.path().join("state")).unwrap();
        shipped_card(&store, "card-x");
        let other = crate::worktrees::worktree_path_for_card(&ws, "card-y");
        let outside = tmp.path().join("elsewhere").join("card-x");
        for dir in [&other, &outside] {
            std::fs::create_dir_all(dir).unwrap();
            record(&store, "ws", "card-x", dir, "held", None);
            let card = store.get_card("ws", "card-x").unwrap();
            assert_eq!(validated_path(&ws, &card), None, "{}", dir.display());
            assert_eq!(retry(&store, "ws", "card-x", &ws, &[]), Retry::Nothing);
            assert!(dir.is_dir(), "left alone: {}", dir.display());
            assert_eq!(store.get_card("ws", "card-x").unwrap().kept_copy, None, "record dropped");
        }
    }

    /// One try per folder at a time.
    #[test]
    fn a_second_try_of_the_same_folder_waits_for_the_first() {
        let path = PathBuf::from("/r/.plyloft-worktrees/c1");
        let first = Flight::take(&path).expect("free");
        assert!(Flight::take(&path).is_none(), "the same folder is under way");
        assert!(Flight::take(Path::new("/r/.plyloft-worktrees/c2")).is_some(), "another folder is not");
        drop(first);
        assert!(Flight::take(&path).is_some(), "free again");
    }

    /// The Windows walk's os error 32, stood in for by a trash the copy
    /// can't be renamed into: the card records the kept copy and why; a try
    /// while the holder stays keeps it, with the latest reason; once the
    /// holder is gone the try moves it, clears the record and gives the
    /// branch record its trash entry.
    #[cfg(unix)]
    #[test]
    fn a_kept_copy_is_said_on_the_card_and_goes_once_nothing_holds_it() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let store = KanbanStore::new(tmp.path().join("state")).unwrap();
        shipped_card(&store, "card-x");
        let copy = crate::worktrees::worktree_path_for_card(&ws, "card-x");
        std::fs::create_dir_all(&copy).unwrap();
        std::fs::write(copy.join("index.html"), "<h1>Hello</h1>").unwrap();
        let trash = copy.parent().unwrap().join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        let hold = |held: bool| {
            let mode = if held { 0o555 } else { 0o755 };
            std::fs::set_permissions(&trash, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        hold(true);

        let moved = prune_or_keep(&store, "ws", "card-x", &ws, &copy, &[]);
        assert!(moved.is_err(), "the move failed: {moved:?}");
        assert!(copy.is_dir(), "the copy is still there");
        let kept = store.get_card("ws", "card-x").unwrap().kept_copy.expect("the card says it was kept");
        assert_eq!(kept.path, copy.to_string_lossy());
        assert!(kept.reason.contains("rename to trash"), "{}", kept.reason);

        // The holder is still there: kept, and the card keeps saying so.
        assert!(matches!(retry(&store, "ws", "card-x", &ws, &[]), Retry::StillKept(_)));
        assert!(store.get_card("ws", "card-x").unwrap().kept_copy.is_some());

        // The holder went (the Builder session closed): the copy goes.
        hold(false);
        assert_eq!(retry(&store, "ws", "card-x", &ws, &[]), Retry::Removed);
        assert!(!copy.exists(), "moved to the trash");
        let card = store.get_card("ws", "card-x").unwrap();
        assert_eq!(card.kept_copy, None, "the card no longer says it was kept");
        let entry = card.branch_cleanup.and_then(|r| r.trash_entry).expect("the branch record has the entry");
        assert!(Path::new(&entry).join("index.html").is_file(), "the copy is in the trash whole");
        assert_eq!(retry(&store, "ws", "card-x", &ws, &[]), Retry::Nothing, "nothing more to try");
    }

    /// The launch tries every kept copy; a copy the card took back as its
    /// own, or one already gone, only loses its record.
    #[test]
    fn the_launch_tries_every_kept_copy_and_never_removes_the_cards_own() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let store = KanbanStore::new(tmp.path().join("state")).unwrap();
        for id in ["left", "own", "gone"] {
            shipped_card(&store, id);
        }
        let left = crate::worktrees::worktree_path_for_card(&ws, "left");
        let own = crate::worktrees::worktree_path_for_card(&ws, "own");
        std::fs::create_dir_all(&left).unwrap();
        std::fs::create_dir_all(&own).unwrap();
        let gone = crate::worktrees::worktree_path_for_card(&ws, "gone");
        for (id, path) in [("left", &left), ("own", &own), ("gone", &gone)] {
            record(&store, "ws", id, path, "held", None);
        }
        let own_path = own.to_string_lossy().to_string();
        store
            .with_card("ws", "own", move |c| {
                c.worktree_path = Some(own_path);
                Ok(())
            })
            .unwrap();

        assert_eq!(retry_all(&store, "ws", &ws, &[]), 2, "the leftover and the one gone already");
        assert!(!left.exists(), "the leftover went to the trash");
        assert!(own.is_dir(), "the card's own copy stays");
        for id in ["left", "own", "gone"] {
            assert_eq!(store.get_card("ws", id).unwrap().kept_copy, None, "{id}");
        }
    }

    /// The paths that keep a shipped copy record it, and a closed or ended
    /// Builder session tries it again.
    #[test]
    fn ship_records_a_kept_copy_and_a_closed_session_tries_it_again() {
        let src = |f: &str| std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f)).unwrap();
        let commands = src("commands.rs");
        let land = &commands[commands.find("fn land_card_local<").unwrap()..];
        let land = &land[..land.find("\n}\n").unwrap()];
        assert!(land.contains("crate::kept_copy::prune_or_keep(kanban, workspace_id, card_id, &ws_cwd, &path, &cache_paths)"));
        assert!(!land.contains("crate::worktrees::prune_worktree_at("), "Land's prune goes through prune_or_keep");
        for command in ["pub fn builder_close(", "pub fn builder_session_ended("] {
            let body = &commands[commands.find(command).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("crate::kept_copy::retry_after_session(&app, &workspace_id, &card_id)"), "{command}");
        }
        let kanban = src("kanban.rs");
        let backfill = &kanban[kanban.find("pub fn reconcile_ship_backfill(").unwrap()..];
        let backfill = &backfill[..backfill.find("\n    }\n").unwrap()];
        assert!(backfill.contains("crate::kept_copy::prune_or_keep("));
        // The release's batch prune and the archive record it too; a build's
        // own session ending tries it again.
        assert!(src("ship.rs").contains("crate::kept_copy::record(kanban, workspace_id, &card.id, &path, &e, head.clone())"));
        let archive = &commands[commands.find("fn kanban_card_archive_locked(").unwrap()..];
        assert!(archive[..archive.find("\n}\n").unwrap()].contains("crate::kept_copy::prune_or_keep(store,"));
        let ended = &commands[commands.find("pub fn builder_session_ended(").unwrap()..];
        let lane = &ended[..ended.find("lane_session_ended").unwrap() + 200];
        assert!(lane.contains("crate::kept_copy::retry_after_session(&app, &workspace_id, card)"));
        // At launch, on the launch's worker thread, not in `setup` itself.
        let lib = src("lib.rs");
        let worker = lib.find("let reviews_app = app.handle().clone();").unwrap();
        let call = lib.find("kept_copy::retry_all_at_launch(&reviews_app)").expect("tried at launch");
        assert!(call > worker && lib[worker..call].contains("std::thread::spawn(move || {"));
    }
}
