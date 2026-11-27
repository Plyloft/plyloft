//! 1.175.0 (round 2): what Plyloft couldn't read when it opened, said once
//! on screen (owner, 2026-11-09). The stores keep the facts; this is the
//! window's side of them.
//!
//! - A board file that couldn't be read (`kanban::read_board_file`): opened
//!   from its last saved copy, or started empty when there was none. Before
//!   1.175.0 this travelled as `kanban_load`'s error, which showed an empty
//!   board; with a copy opened the cards are there, so the load succeeds and
//!   the Board asks here once after it (`kanbanStore.ts::loadFromDisk`).

//! - A project list (`workspaces.json`) that couldn't be used
//!   (`workspace::ListTrouble`): set aside, or refused and left as it is.
//!   Plyloft starts with no projects either way (R3), and the window asks
//!   here once after it loaded them (`App.tsx`). The notice's *Show in
//!   Finder* opens the folder with the file selected; the path is the
//!   store's own, never one the page sends.

use serde::Serialize;
use tauri::State;

use crate::kanban::KanbanStore;
use crate::workspace::{ListTrouble, WorkspaceStore};

/// [`crate::kanban::BoardNotice`] for the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardNoticeView {
    /// The last saved copy was opened; `false`: the board started empty.
    pub restored: bool,
    /// Where the file that couldn't be read is kept.
    pub kept_as: String,
    /// T4: on how many restored cards "Merge when checks pass" was turned
    /// off, so the notice says it; 0 when on none.
    pub auto_merge_off: usize,
}

/// What became of this workspace's board file when it couldn't be read, the
/// first time it is asked after that; `None` otherwise. A read of this
/// app's own state: not gated.
#[tauri::command]
pub fn board_unreadable_notice(store: State<'_, KanbanStore>, workspace_id: String) -> Option<BoardNoticeView> {
    let notice = store.take_notice(&workspace_id)?;
    Some(BoardNoticeView {
        restored: notice.restored,
        kept_as: notice.kept_as.display().to_string(),
        auto_merge_off: notice.auto_merge_off,
    })
}

/// Round 6 (W3): the window has shown this workspace's board notice. Until
/// then it is only handed out: a notice that waited its turn behind another
/// toast when Plyloft quit is handed out again at the next launch.
///
/// T2: for a board that isn't on GitHub Issues there is no read from GitHub
/// to wait for, so nothing is left to remember once its notice was shown.
#[tauri::command]
pub fn board_unreadable_said(store: State<'_, KanbanStore>, workspaces: State<'_, WorkspaceStore>, workspace_id: String) {
    note_board_said(&store, &workspaces.snapshot().workspaces, &workspace_id);
}

fn note_board_said(store: &KanbanStore, workspaces: &[crate::workspace::Workspace], workspace_id: &str) {
    store.note_said(workspace_id);
    let on_github_issues = workspaces
        .iter()
        .any(|w| w.id == workspace_id && w.kanban_sync_mode == crate::workspace::KanbanSyncMode::GitHubIssues);
    if !on_github_issues {
        store.settle_local_restore(workspace_id);
    }
}

/// W3: the board notice's *Show in Finder* (File Explorer on Windows): the
/// folder of the file the notice names, with the file selected. The page
/// says which board; the path is the store's own.
#[tauri::command(async)]
pub fn board_unreadable_reveal(store: State<'_, KanbanStore>, workspace_id: String) -> Result<(), String> {
    let path = store
        .trouble_kept_as(&workspace_id)
        .ok_or_else(|| "This board's file was read; there is no file to show.".to_string())?;
    crate::platform::reveal_path(&path).map_err(|e| format!("open failed: {e}"))
}

/// One board's trouble as the launch asks for all of them
/// ([`board_unreadable_notices`]): with its project's name and whether its
/// cards come from GitHub Issues, so the window needs neither the project
/// list nor the board loaded to say it and to start its read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchBoardNoticeView {
    pub workspace_id: String,
    /// `None` for a board whose project isn't in the list.
    pub project_name: Option<String>,
    pub restored: bool,
    pub kept_as: String,
    pub auto_merge_off: usize,
    /// The board is on GitHub Issues: opened from its last saved copy, it
    /// sends nothing there until its issues were read once.
    pub github_issues: bool,
}

/// 1.175.0 (round 4, T1): every board trouble not said yet. The launch
/// inventory loads every listed board, so every damaged board is restored
/// (or set aside) at launch, also the board of a project the person doesn't
/// open that day: asked board by board at its first load
/// ([`board_unreadable_notice`], which stays as the fallback), such a board
/// was never said and never read from GitHub, and its issue writes stayed
/// held all session. Each trouble is handed out once, here or there.
///
/// Round 6 (W2): with them, the GitHub Issues boards that still wait for
/// their first read from GitHub. A board whose notice was shown at an
/// earlier launch (its marker says so) has nothing left to say, but its
/// writes are held again until that read — which nothing started unless its
/// Board was opened.
#[tauri::command]
pub fn board_unreadable_notices(
    store: State<'_, KanbanStore>,
    workspaces: State<'_, WorkspaceStore>,
) -> LaunchBoardTroubles {
    launch_board_troubles(&store, &workspaces.snapshot().workspaces)
}

/// What the launch is told about the boards ([`board_unreadable_notices`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchBoardTroubles {
    /// Every trouble not said yet.
    pub notices: Vec<LaunchBoardNoticeView>,
    /// The workspaces whose GitHub Issues board was opened from its last
    /// saved copy and hasn't been read from GitHub since — said or not, at
    /// this launch or an earlier one. The window reads each until it goes
    /// through.
    pub awaiting_read: Vec<String>,
}

fn launch_board_troubles(store: &KanbanStore, workspaces: &[crate::workspace::Workspace]) -> LaunchBoardTroubles {
    let notices = launch_board_notices(store, workspaces);
    let mut awaiting_read: Vec<String> = store
        .restored_awaiting_pull()
        .into_iter()
        .filter(|id| {
            workspaces
                .iter()
                .any(|w| &w.id == id && w.kanban_sync_mode == crate::workspace::KanbanSyncMode::GitHubIssues)
        })
        .collect();
    awaiting_read.sort();
    LaunchBoardTroubles { notices, awaiting_read }
}

fn launch_board_notices(store: &KanbanStore, workspaces: &[crate::workspace::Workspace]) -> Vec<LaunchBoardNoticeView> {
    store
        .take_all_notices()
        .into_iter()
        .map(|(workspace_id, notice)| {
            let workspace = workspaces.iter().find(|w| w.id == workspace_id);
            let github_issues =
                workspace.is_some_and(|w| w.kanban_sync_mode == crate::workspace::KanbanSyncMode::GitHubIssues);
            LaunchBoardNoticeView {
                project_name: workspace.map(|w| w.name.clone()).filter(|name| !name.trim().is_empty()),
                github_issues,
                restored: notice.restored,
                kept_as: notice.kept_as.display().to_string(),
                auto_merge_off: notice.auto_merge_off,
                workspace_id,
            }
        })
        .collect()
}

/// [`ListTrouble`] for the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectListNoticeView {
    /// The file wasn't a project list: it is kept at `path`
    /// (`workspaces.json.broken-<ms>`), and a new list is saved from here.
    SetAside { path: String },
    /// The file is a project list this Plyloft doesn't write over: it is
    /// untouched at `path`, and `why` is what every save answers.
    Refused { path: String, why: String },
}

impl From<ListTrouble> for ProjectListNoticeView {
    fn from(trouble: ListTrouble) -> Self {
        match trouble {
            ListTrouble::SetAside(path) => Self::SetAside { path: path.display().to_string() },
            ListTrouble::Refused { path, why } => Self::Refused { path: path.display().to_string(), why },
        }
    }
}

/// What became of the project list when this launch couldn't use it, the
/// first time it is asked this launch; `None` after that, and when the list
/// was read. A read of this app's own state: not gated.
#[tauri::command]
pub fn project_list_notice(store: State<'_, WorkspaceStore>) -> Option<ProjectListNoticeView> {
    store.take_launch_notice().map(Into::into)
}

/// Y3 round 3: whether the project list was in trouble this launch, and
/// which way (`"setAside"` / `"refused"`), for as long as the process lives.
/// It takes nothing: [`project_list_notice`] hands the notice out once, for
/// the launch toast, and a window that loads again in the same process (the
/// web view's own Reload on a Mac, a content process that restarts) would
/// get `None` there and read its empty list as "no project yet" — the
/// sidebar's "Setup isn't finished" row. A read of this app's own state: not
/// gated.
#[tauri::command]
pub fn project_list_trouble(store: State<'_, WorkspaceStore>) -> Option<&'static str> {
    trouble_kind(store.trouble())
}

/// The kind as the window names it ([`ProjectListNoticeView`]'s tag).
fn trouble_kind(trouble: Option<&ListTrouble>) -> Option<&'static str> {
    trouble.map(|trouble| match trouble {
        ListTrouble::SetAside(_) => "setAside",
        ListTrouble::Refused { .. } => "refused",
    })
}

/// The notice's *Show in Finder* (File Explorer on Windows): the folder of
/// the file the notice names, with the file selected.
#[tauri::command(async)]
pub fn project_list_notice_reveal(store: State<'_, WorkspaceStore>) -> Result<(), String> {
    let path = match store.trouble() {
        Some(ListTrouble::SetAside(path)) | Some(ListTrouble::Refused { path, .. }) => path.clone(),
        None => return Err("The project list was read; there is no file to show.".to_string()),
    };
    crate::platform::reveal_path(&path).map_err(|e| format!("open failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_project_list_notice_reaches_the_window_in_camel_case() {
        let aside = ProjectListNoticeView::from(ListTrouble::SetAside("/c/workspaces.json.broken-1".into()));
        assert_eq!(
            serde_json::to_value(&aside).unwrap(),
            serde_json::json!({ "kind": "setAside", "path": "/c/workspaces.json.broken-1" })
        );
        let refused = ProjectListNoticeView::from(ListTrouble::Refused { path: "/c/workspaces.json".into(), why: "why".into() });
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            serde_json::json!({ "kind": "refused", "path": "/c/workspaces.json", "why": "why" })
        );
        let board = BoardNoticeView { restored: true, kept_as: "/c/w.json.unreadable-1".into(), auto_merge_off: 2 };
        assert_eq!(
            serde_json::to_value(&board).unwrap(),
            serde_json::json!({ "restored": true, "keptAs": "/c/w.json.unreadable-1", "autoMergeOff": 2 })
        );
    }

    /// T1: two projects, and the damaged board is in the one nobody opens.
    /// The launch's one ask returns it, with its project's name and whether
    /// its cards come from GitHub Issues; the same trouble is not said
    /// again, by that ask or by the board's own at its first load.
    #[test]
    fn the_launch_is_told_every_board_trouble_once_also_of_a_project_never_opened() {
        use crate::kanban::{KanbanCard, KanbanColumnId, KANBAN_SUBDIR};
        let tmp = tempfile::tempdir().unwrap();
        let boards = tmp.path().join(KANBAN_SUBDIR);
        let card = |ws: &str, id: &str| KanbanCard::new(id.into(), ws.into(), id.into(), None, KanbanColumnId::Todo);
        {
            let before = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            for ws in ["open", "unopened", "local"] {
                before.create_card(ws, card(ws, "a")).unwrap();
                before.create_card(ws, card(ws, "b")).unwrap();
            }
        }
        // `unopened` lost its last save; `local` holds bytes that don't parse
        // and has no copy to open.
        std::fs::write(boards.join("unopened.json"), b"").unwrap();
        std::fs::write(boards.join("local.json"), b"{cut").unwrap();
        std::fs::remove_file(boards.join("local.json.bak")).unwrap();
        let workspaces: Vec<crate::workspace::Workspace> = [("open", "githubIssues", "Site"), ("unopened", "githubIssues", "Lyra"), ("local", "local", "Notes")]
            .into_iter()
            .map(|(id, mode, name)| {
                serde_json::from_value(serde_json::json!({
                    "id": id, "name": name, "cwd": "/x", "createdAt": 1, "lastOpenedAt": 2,
                    "kanbanSyncMode": mode, "githubOwnerRepo": "o/r",
                }))
                .unwrap()
            })
            .collect();

        // What `setup` does: the launch inventory loads every listed board.
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        for ws in &workspaces {
            store.load(&ws.id).unwrap();
        }
        let said = launch_board_notices(&store, &workspaces);
        assert_eq!(said.len(), 2, "{said:?}");
        let (local, lyra) = (&said[0], &said[1]);
        assert_eq!((lyra.workspace_id.as_str(), lyra.project_name.as_deref()), ("unopened", Some("Lyra")));
        assert!(lyra.restored && lyra.github_issues);
        assert!(lyra.kept_as.contains("unopened.json.unreadable-"), "{}", lyra.kept_as);
        assert_eq!((local.workspace_id.as_str(), local.project_name.as_deref()), ("local", Some("Notes")));
        assert!(!local.restored && !local.github_issues);
        assert_eq!(store.restored_awaiting_pull(), ["unopened"], "its issue writes are held until its read");
        // T2: a GitHub Issues board keeps its marker until GitHub was read;
        // a local board's goes once its notice was shown.
        assert!(boards.join("unopened.json.restored").exists());
        std::fs::write(boards.join("notes.json"), b"").unwrap();
        let later = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        // (`notes` has no backup here: give it one by restoring a copied board.)
        std::fs::copy(boards.join("open.json"), boards.join("notes.json.bak")).unwrap();
        later.load("notes").unwrap();
        assert!(boards.join("notes.json.restored").exists(), "written with the restore");
        let notes = launch_board_notices(&later, &workspaces);
        assert!(notes.iter().any(|n| n.workspace_id == "notes" && n.restored && !n.github_issues), "{notes:?}");
        // W3: handed to the window is not shown; the window says when it is.
        assert!(boards.join("notes.json.restored").exists(), "not before its notice was on screen");
        note_board_said(&later, &workspaces, "notes");
        assert!(!boards.join("notes.json.restored").exists(), "a board that isn't on GitHub Issues: said, so gone");
        note_board_said(&store, &workspaces, "unopened");
        note_board_said(&store, &workspaces, "local");
        assert!(boards.join("unopened.json.restored").exists(), "said, and still owed its read");

        // Not said twice: neither by the launch's ask nor by the board's own.
        assert!(launch_board_notices(&store, &workspaces).is_empty());
        // W2: a later launch has nothing to say about `unopened`, and still
        // owes it its read from GitHub — and only it: `local` has none to
        // wait for, `open` was read as it is.
        let relaunched = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        for ws in &workspaces {
            relaunched.load(&ws.id).unwrap();
        }
        let told = launch_board_troubles(&relaunched, &workspaces);
        assert!(told.notices.is_empty(), "{:?}", told.notices);
        assert_eq!(told.awaiting_read, ["unopened"]);
        relaunched.note_pulled("unopened");
        assert!(launch_board_troubles(&relaunched, &workspaces).awaiting_read.is_empty(), "read: nothing left to ask");
        // A board that isn't on GitHub Issues is never read, restored or not.
        let local_only: Vec<crate::workspace::Workspace> = workspaces
            .iter()
            .cloned()
            .map(|mut w| {
                w.kanban_sync_mode = crate::workspace::KanbanSyncMode::Local;
                w
            })
            .collect();
        assert!(launch_board_troubles(&store, &local_only).awaiting_read.is_empty());
        assert_eq!(launch_board_troubles(&store, &workspaces).awaiting_read, ["unopened"], "this launch's restore too");
        assert_eq!(store.take_notice("unopened"), None);
        assert_eq!(store.take_notice("local"), None);
        // And the other way round: a trouble the board said is not in the launch's list.
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        std::fs::write(boards.join("open.json"), b"").unwrap();
        again.load("open").unwrap();
        assert!(again.take_notice("open").is_some());
        assert!(launch_board_notices(&again, &workspaces).is_empty());
    }

    /// Y3 round 3: the kind of trouble is read for the process's life, in
    /// the notice's own tag — also after the launch notice was handed out,
    /// which is what a window that loads again would find.
    #[test]
    fn the_lists_trouble_is_still_read_after_the_notice_was_taken() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("workspaces.json"), br#"{"workspaces":"none"}"#).unwrap();
        let store = WorkspaceStore::new(tmp.path().to_path_buf()).expect("the launch goes on");
        assert_eq!(trouble_kind(store.trouble()), Some("setAside"));
        let notice: ProjectListNoticeView = store.take_launch_notice().expect("said once").into();
        assert_eq!(serde_json::to_value(&notice).unwrap()["kind"], "setAside", "the same word as the notice's");
        assert_eq!(store.take_launch_notice(), None);
        assert_eq!(trouble_kind(store.trouble()), Some("setAside"), "a second window still knows");
        let refused = ListTrouble::Refused { path: "/c/workspaces.json".into(), why: "why".into() };
        assert_eq!(trouble_kind(Some(&refused)), Some("refused"));
        assert_eq!(serde_json::to_value(ProjectListNoticeView::from(refused)).unwrap()["kind"], "refused");
        // A list that was read: nothing.
        let fine = tempfile::tempdir().unwrap();
        assert_eq!(trouble_kind(WorkspaceStore::new(fine.path().to_path_buf()).unwrap().trouble()), None);
        // The command reads; it never takes.
        let module = include_str!("unreadable_notices.rs");
        let command = &module[module.find("pub fn project_list_trouble(").unwrap()..];
        let body = &command[..command.find("\n}\n").unwrap()];
        assert!(body.contains("store.trouble()") && !body.contains("take_launch_notice"), "{body}");
    }

    /// Both commands are registered, and the reveal takes no path from the page.
    #[test]
    fn the_notice_commands_are_registered_and_reveal_the_stores_own_file() {
        let setup = include_str!("lib.rs");
        for command in [
            "board_unreadable_notice",
            "board_unreadable_notices",
            "board_unreadable_said",
            "board_unreadable_reveal",
            "project_list_notice",
            "project_list_trouble",
            "project_list_notice_reveal",
        ] {
            assert!(setup.contains(&format!("unreadable_notices::{command},")), "{command}");
        }
        let module = include_str!("unreadable_notices.rs");
        let reveal = &module[module.find("pub fn project_list_notice_reveal(").unwrap()..];
        let signature = &reveal[..reveal.find(") -> Result").unwrap()];
        assert_eq!(signature, "pub fn project_list_notice_reveal(store: State<'_, WorkspaceStore>");
        // W3: the board's reveal is told which board, never a path.
        let reveal = &module[module.find("pub fn board_unreadable_reveal(").unwrap()..];
        let signature = &reveal[..reveal.find(") -> Result").unwrap()];
        assert_eq!(signature, "pub fn board_unreadable_reveal(store: State<'_, KanbanStore>, workspace_id: String");
        assert!(reveal[..600].contains("store\n        .trouble_kept_as(&workspace_id)"));
    }
}
