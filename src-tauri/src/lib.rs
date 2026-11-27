// The ActivityGate has a no-op fallback off macOS (app_nap.rs).
mod app_nap;
mod platform;
mod legacy_install;
mod microphone;
mod notification_access;
mod dictation;
mod agents;
mod atomic;
mod branch_cleanup;
mod build_cache;
mod copies;
mod bundle_fingerprint;
mod cache_retention;
mod card_area;
mod card_claim;
// 1.173.0 (D1): where a project goes live (Railway, GitHub checks), read only.
mod deploy_map;
mod card_execution;
mod checks_consent;
mod skill_asks;
mod team_leave_seat;
// A card's chat (discussion only) and its attachments: the registry and IPC,
// Plyloft's own record, Claude's transcript read as messages, attachment
// storage and Plyloft's PDF / Word text extraction.
mod chat;
mod chat_attachments;
mod chat_extract;
mod chat_screen;
mod chat_store;
mod chat_transcript;
mod claude_session;
// Windows (W4): the close choice. The decision is pure and tested on every
// platform; only Windows' close consults it.
#[cfg_attr(not(windows), allow(dead_code))]
mod close_choice;
mod codeowners;
mod conpty_host;
mod codex_app;
mod cli_fresh;
mod cli_seen;
mod codex_auto_update;
mod codex_home;
mod codex_sessions;
mod codex_update_prompt;
mod commands;
mod compare;
mod coordination;
mod device_claim;
mod discussion;
mod doctor;
mod doctor_reads;
mod drain;
mod files;
mod files_order;
mod git;
mod github;
mod github_sync;
mod github_account;
mod history_search;
mod inbox;
mod inbox_eligibility;
mod inbox_gui_proof;
#[cfg(test)]
mod inbox_eligibility_ipc_tests;
mod instruction_files;
mod installed_self_check;
mod intake;
mod builder;
mod builder_screens;
// 1.176.3: the off-screen screen rules in Rust — `content_rows` cuts the
// grid's content clock (read by the window's judgement); the rest is the
// dev-only capture's commentary.
mod builder_screen_judge;
// 1.176.3 phase 1: the dev-only Builder screen capture (screens hold the
// person's prompts and files: test-bridge debug builds only).
#[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
mod builder_screens_capture;
mod build_both;
mod branch_codex_skills;
mod claude_auth;
mod keychain_lock;
mod claude_theme;
mod kanban;
mod kept_copy;
mod later_requests;
mod line_comments;
mod knowledge_migrate;
mod issue_edit;
mod issue_text;
mod fix_round;
mod launch_inventory;
mod leave_issue;
mod account;
mod billing_client;
mod license;
mod team;
mod team_admin;
mod team_billing;
mod team_join;
mod team_skills;
mod library_snapshot;
mod terminal_sessions;
mod session_titles;
#[cfg(test)]
mod terminal_sessions_tests;
#[cfg(test)]
mod command_threads_tests;
#[cfg(test)]
mod file_size_ratchet_tests;
mod skill_ignored;
mod skill_scripts;
mod put_on_github;
mod cli_health;
mod cli_repair;
mod cli_repair_report;
mod cli_repair_run;
mod cli_repair_sessions;
/// 1.176.0 R9: the Repair engine against the real installers in a sandbox
/// home (`#[ignore]`d; `scripts/cli-repair-e2e.sh`).
#[cfg(all(test, target_os = "macos"))]
mod cli_repair_e2e_tests;
mod move_shared_setup;
mod stop_sharing;
mod skills_hub_state;
mod skills_hub;
mod skills_index;
mod skill_links;
mod skill_card;
mod skill_copy;
mod skill_migration;
mod skill_bases;
mod skill_upstream;
mod team_proposal;
mod project_skills;
mod ply_skills;
mod ply_skill_switch;
mod personal_skills;
mod personal_instructions;
mod overlap;
mod log_retention;
mod mcp_launch;
mod memory;
mod memory_facts;
mod migrate;
mod my_library;
mod shipped_changes;
mod after_merge;
mod navigation;
mod project_config;
mod pr_draft;
mod pr_links;
mod pr_auto_fix;
mod pr_fix;
mod merge_method;
mod pr_merge;
mod verdict_comment;
mod pr_review;
mod pr_status;
mod proposals;
mod prompts;
mod pty;
mod pty_tile_id;
mod publish_filter;
mod pinned_read;
mod project_folder;
mod plan_exchange;
mod plan_store;
mod put_back;
mod read_only_provider;
mod review;
mod review_capabilities;
mod review_failure;
mod review_anchors;
mod review_base;
mod review_answer;
mod review_context;
mod review_ledger;
mod review_passes;
mod reviewer;
mod search;
mod second_claim;
mod settings;
mod settings_merge;
mod settings_reset;
mod model_catalog;
mod team_models;
mod area_discovery;
mod areas;
mod next_improvement;
mod retry_on;
mod setting_conflict;
mod shared_config;
mod shared_library_sync;
mod shared_library;
mod setup_actions;
mod setup_github;
mod commit_identity;
mod commit_message;
mod project_setup;
mod project_setup_config;
mod setup_identity;
mod setup_run;
// 1.176.0 R2: a run's true outcome and cause, and its record on disk.
mod setup_outcome;
mod setup_last_run;
mod setup_team_hint;
mod program_folders;
mod setting_check;
mod shell_env;
// 1.176.2 R1 (A1-03): Windows' PATH read again from the registry at a probe.
mod registry_path;
mod release_record;
// 1.174.0 (DR1): what a release of an area carries, since its last tag.
mod release_scope;
// 1.176.3: the typed mark for "the folder is not there" (no retry can help).
mod path_gone;
mod ship;
mod ship_conflict;
// 1.170.0 (G6): a card kept up to date with its target branch, by merging.
mod card_sync;
mod skill_history;
mod skill_root_ignore;
// GH #105: which CLIs a skill reaches, and the two moves that change it.
mod skill_reach;
// Skills hub H5 (R12): the Claude and Codex copies of a skill, kept aligned.
mod skill_twins;
mod snapshots;
mod exports;
mod swarm_templates;
mod swarms;
mod templates;
mod trash;
mod try_session;
mod unreadable_notices;
#[cfg(test)]
mod team_gate_allowed_ipc_tests;
#[cfg(test)]
mod team_gate_card_mutation_ipc_tests;
#[cfg(test)]
mod team_gate_soft_degrade_ipc_tests;
#[cfg(test)]
mod skill_card_ipc_tests;
#[cfg(test)]
mod skill_copy_ipc_tests;
#[cfg(test)]
mod team_free_tests;
#[cfg(test)]
mod test_env;
mod verify;
mod verify_logs;
mod watcher;
mod watchdog;
#[cfg(windows)]
mod windows_shell;
mod workspace;
mod workspace_adoption;
mod definition_text;
mod workspace_definition;
mod worktree_ports;
mod worktree_setup;
mod worktrees;
mod writer_queue;
// SL-0 app tester (docs/app-tester/DESIGN.md): the dev-only test bridge. Never
// in a release: the feature is off by default and refused without
// debug_assertions; the bridge itself refuses any identifier but the test one.
#[cfg(all(feature = "test-bridge", not(debug_assertions)))]
compile_error!("the `test-bridge` feature is for debug builds only; it must never reach a release");
#[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
mod test_bridge;

use tauri::{DragDropEvent, Emitter, Manager, RunEvent, WindowEvent};
use serde::Serialize;

pub fn inbox_eligibility_dispatch(args: &[String]) -> Option<Result<String, String>> {
    inbox_eligibility::dispatch(args)
}

/// `main.rs`: this binary started as a card chat's PDF extraction child
/// (`chat_extract::dispatch`): its exit code.
pub fn chat_extract_dispatch(args: &[String]) -> Option<i32> {
    chat_extract::dispatch(args)
}

/// v1.4.0 (L1): pull the first directory-path argument out of argv. argv[0] is
/// the Atelier binary; we scan argv[1..] for the first entry that points to an
/// existing directory and return its canonical absolute path. None if no
/// suitable arg is found. Pure helper — no I/O outside `Path::is_dir` and
/// `canonicalize`.
fn cli_path_from_argv(argv: &[String]) -> Option<String> {
    for raw in argv.iter().skip(1) {
        // Skip flags so future --foo args don't get mistaken for paths.
        if raw.starts_with('-') {
            continue;
        }
        let p = std::path::Path::new(raw);
        if !p.is_dir() {
            continue;
        }
        match crate::platform::canonicalize(p) {
            Ok(abs) => return Some(abs.to_string_lossy().into_owned()),
            Err(_) => return Some(raw.clone()),
        }
    }
    None
}

/// App exit: kill every child Plyloft started (Hard Rule #4). Runs once,
/// on the first of `ExitRequested` / `Exit` (see `app.run` in [`run`]).
///
/// Nothing prevents an exit today (`ExitRequested` never calls
/// `prevent_exit`): the quit guard (S1-2, [`request_quit`]) asks *before*
/// calling `AppHandle::exit`, never inside the exit. If that is ever introduced, this must not run on a
/// prevented exit — it kills every child and refuses new ones for good — or
/// the once-flag (`exit_cleanup::begin`) must be reset when the exit is
/// called off.
fn run_exit_cleanup(app_handle: &tauri::AppHandle, why: &str) {
    if !exit_cleanup::begin() {
        return;
    }
    // H1 (1.173.0): the cleanup below holds the main thread and stops the
    // page; that is no freeze, so the watchdog stops probing first.
    // `watchdog::stop()` still ends its thread last.
    watchdog::quitting();
    log::info!("exit: {why}; stopping every child process");
    // QoL 1.168 (block 4, D11): before any PTY is killed, the Claude and
    // Codex tiles still running are recorded as open at this quit, so the
    // next launch can offer to reopen them; their exits then write nothing.
    if let Ok(config_dir) = app_handle.path().app_config_dir() {
        let pids: std::collections::HashMap<String, u32> = match app_handle.try_state::<pty::PtyRegistry>() {
            Some(registry) => terminal_sessions::live_ptys()
                .into_iter()
                .filter_map(|id| registry.process_id(&id).map(|pid| (id, pid)))
                .collect(),
            None => Default::default(),
        };
        let marked = terminal_sessions::mark_quit_looking(
            &config_dir,
            terminal_sessions::CliHomes::real(),
            pids,
            terminal_sessions::QUIT_LOOK_BUDGET,
        );
        if marked > 0 {
            log::info!("exit: {marked} terminal session(s) recorded as open at quit");
        }
    }
    // SL-1: no new pull-request read starts; one in flight is killed
    // with the other bounded commands (`kill_active_fetches`).
    pr_status::stop_poller();
    // Skills hub H2: no new pull of the team library starts; one in flight
    // is killed with the other bounded commands below.
    skills_hub::stop();
    // Skills hub H7: an All skills refresh stops between workspaces.
    skills_index::stop();
    // Launch A1: the account refresher and any sign-in poll stop.
    if let Some(account) = app_handle.try_state::<account::AccountStore>() {
        account.stop();
    }
    #[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
    test_bridge::stop();
    if let Some(queue) = app_handle.try_state::<writer_queue::WriterQueue>() {
        queue.clear();
    }
    // GH #124: before any PTY is killed, stop handing a card's
    // review on to the one waiting for it: a review killed below
    // must not start its successor, which keeps waiting on the card
    // for the next launch.
    if let Some(registry) = app_handle.try_state::<reviewer::ReviewerRegistry>() {
        registry.slots().close();
    }
    // Coordination owns truthful terminal status. Mark every active
    // record interrupted before subsystem cleanup issues explicit
    // PTY kills; late wait-thread exits are then harmless no-ops.
    if let Some(registry) =
        app_handle.try_state::<coordination::CoordinationRegistry>()
    {
        let _ = registry.interrupt_active("Plyloft exited before the process completed");
    }
    if let Some(registry) = app_handle.try_state::<discussion::DiscussionRegistry>() {
        if let Err(error) =
            registry.interrupt_active("Plyloft exited before the discussion completed")
        {
            log::warn!("discussion exit reconciliation failed: {error}");
        }
    }
    // v1.0: Swarm. Flip running swarms to `Aborted` BEFORE the
    // agent registry tears down their PTYs — keeps the on-disk state
    // ordering coherent (swarm aborted → child runs killed → PTYs
    // dropped) so the next launch's reconcile pass sees consistent state.
    if let Some(swarm_registry) = app_handle.try_state::<swarms::SwarmRegistry>() {
        swarm_registry.kill_all();
    }
    if let Some(agent_registry) = app_handle.try_state::<agents::AgentRegistry>() {
        if let Some(pty_registry) = app_handle.try_state::<pty::PtyRegistry>() {
            agent_registry.kill_all(&pty_registry);
        }
    }
    // OB-3: Setup's guided run — its whole process group, at once —
    // before the PTYs, and no new one after. Hard Rule #4.
    if let (Some(setup), Some(pty)) = (
        app_handle.try_state::<setup_run::SetupRunner>(),
        app_handle.try_state::<pty::PtyRegistry>(),
    ) {
        if setup_run::exit_cleanup(&setup, &pty) {
            log::info!("exit: killed the running setup step");
        }
    }
    // 1.176.0 R5: the automatic Codex update's process tree, and none after.
    if codex_auto_update::shutdown() {
        log::info!("exit: stopped the automatic Codex update");
    }
    // Plan with two AIs: a running exchange is saved `paused{quit}` before
    // its sessions end below, so it reads "Plyloft quit while …" on the
    // next launch, never failed; its driver does nothing after.
    if let Some(plans) = app_handle.try_state::<plan_exchange::PlanExchanges>() {
        plans.interrupt_active();
    }
    // Next improvement (1.173.0 E2): a running round is saved interrupted
    // and its read-only copy removed; its lanes' processes end with the
    // chats' below. Hard Rule #4.
    if let Some(rounds) = app_handle.try_state::<next_improvement::round::Rounds>() {
        rounds.interrupt_all();
    }
    // A card chat's sessions — Claude's whole process group after its
    // hangup, Codex's App Server — before the PTYs, and none after.
    // Hard Rule #4.
    if let Some(registry) = app_handle.try_state::<chat::ChatRegistry>() {
        registry.kill_all();
    }
    // An attachment's PDF being read, in its own child (group).
    let extractions = chat_extract::kill_active();
    if extractions > 0 {
        log::info!("exit: killed {extractions} PDF extraction child(ren)");
    }
    if let Some(registry) = app_handle.try_state::<pty::PtyRegistry>() {
        registry.kill_all();
    }
    if let Some(registry) = app_handle.try_state::<codex_app::CodexAppRegistry>() {
        registry.kill_all();
    }
    // GH #222 review 1: a Ship between its merge and its tag finishes
    // that local half first (bounded), so the checkout is never left
    // with a staged merge or an untagged release commit; no new one
    // starts. Its pushes are killed with the fetches below — the next
    // Ship publishes the release (`ship::pending_release`).
    let releases = ship::finish_releases_before_exit();
    if releases > 0 {
        log::warn!("exit: {releases} release(s) still in their local half after the wait");
    }
    // Card starts / Sync run `git fetch origin` in its own process
    // group (so a timeout can kill ssh/upload-pack too); nothing else
    // would signal it, so kill in-flight fetches here. Hard Rule #4.
    // GH #222: Ship's release pushes are in the same registry.
    let fetches = worktrees::kill_active_fetches();
    if fetches > 0 {
        log::info!("exit: killed {fetches} in-flight git fetch group(s)");
    }
    // A Verify's shared-target reset runs cargo in its own process
    // group, the same way. Hard Rule #4.
    // #47: dictation's whisper-cli runs and model downloads, each in
    // its own process group. Hard Rule #4.
    let dictation_jobs = dictation::JOBS.shutdown();
    if dictation_jobs > 0 {
        log::info!("exit: killed {dictation_jobs} dictation job group(s)");
    }
    // GH #62: each Verify step (and what it started) runs in its
    // own process group. Hard Rule #4.
    let verify_steps = verify::kill_active_steps();
    if verify_steps > 0 {
        log::info!("exit: killed {verify_steps} verify step group(s)");
    }
    let resets = build_cache::kill_active_resets();
    if resets > 0 {
        log::info!("exit: killed {resets} in-flight cargo reset group(s)");
    }
    if let Some(registry) = app_handle.try_state::<watcher::WatcherRegistry>() {
        registry.kill_all();
    }
    if let Some(registry) = app_handle.try_state::<search::SearchRegistry>() {
        registry.cancel_all();
    }
    // v1.25.0 (Cycle G2): history-search rg subprocess. Hard
    // Rule #4: kill the in-flight rg on app exit so it doesn't
    // outlive the parent process.
    if let Some(registry) =
        app_handle.try_state::<history_search::HistorySearchRegistry>()
    {
        registry.cancel();
    }
    // Windows: every process group is a Job Object. Whatever a
    // registry above left in one — a leader's straggler, the codex
    // app-server still inside its grace — ends here, not only when
    // the jobs close with Ply. Hard Rule #4.
    #[cfg(windows)]
    {
        let groups = platform::kill_all_groups();
        if groups > 0 {
            log::info!("exit: killed {groups} remaining process group(s)");
        }
    }
    // H1 (1.173.0): the watchdog thread ends and `run.json` records that
    // this run ended cleanly — last, so a cleanup that hangs above is a run
    // the next start reports. Hard Rule #4.
    watchdog::stop();
    log::info!("exit: cleanup done");
    // Each line is flushed as it is written; this keeps a buffered target
    // from losing the last ones when the process ends right after.
    log::logger().flush();
}

/// B2 re-review (Hard rule 4 on the updater's path): on Windows the
/// updater's install runs `AppHandle::cleanup_before_exit`, starts the
/// installer and calls `std::process::exit(0)` — no `ExitRequested`, so
/// [`run_exit_cleanup`] never ran there, and the installer's own kill of
/// Plyloft (with its 0.5 s pause) never runs either: Plyloft is gone by
/// then. tauri-plugin-updater's hook is that `cleanup_before_exit`, which
/// clears the app's resource table; this resource, held there from setup,
/// runs the same cleanup as a quit when it is dropped, and then waits for
/// the PTYs' console hosts (`conpty\…\OpenConsole.exe`) to end, so none
/// holds a file the installer replaces. A normal quit has already run the
/// cleanup (the once-guard makes this a no-op); the Mac's relaunch goes
/// through `ExitRequested` or this same table.
struct ExitHook(std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>);

impl ExitHook {
    fn new(run: impl FnOnce() + Send + 'static) -> Self {
        Self(std::sync::Mutex::new(Some(Box::new(run))))
    }
}

impl tauri::Resource for ExitHook {}

impl Drop for ExitHook {
    fn drop(&mut self) {
        let run = self.0.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(run) = run {
            run();
        }
    }
}

/// What [`ExitHook`] runs: the quit's cleanup, then the console hosts.
fn exit_before_installer(app_handle: &tauri::AppHandle) {
    run_exit_cleanup(app_handle, "Plyloft closes for an installer (cleanup_before_exit)");
    let left = conpty_host::wait_for_hosts_to_end(std::time::Duration::from_secs(2));
    if left > 0 {
        log::warn!("exit: {left} console host(s) still running after 2 s");
    }
    log::logger().flush();
}

/// The once-guard behind [`run_exit_cleanup`].
mod exit_cleanup {
    use std::sync::atomic::{AtomicBool, Ordering};

    static STARTED: AtomicBool = AtomicBool::new(false);

    /// `true` for the first caller only.
    pub(super) fn begin() -> bool {
        begin_on(&STARTED)
    }

    fn begin_on(flag: &AtomicBool) -> bool {
        !flag.swap(true, Ordering::SeqCst)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// B2 re-review: the exit hook runs its cleanup once, when the
        /// app's resource table drops it (the updater's
        /// `cleanup_before_exit`), and setup registers it.
        #[test]
        fn the_updaters_exit_runs_the_quit_cleanup() {
            use std::sync::atomic::AtomicUsize;
            use std::sync::Arc;
            let runs = Arc::new(AtomicUsize::new(0));
            let hook = super::super::ExitHook::new({
                let runs = runs.clone();
                move || {
                    runs.fetch_add(1, Ordering::SeqCst);
                }
            });
            assert_eq!(runs.load(Ordering::SeqCst), 0);
            drop(hook);
            assert_eq!(runs.load(Ordering::SeqCst), 1);
            let src = include_str!("lib.rs");
            assert!(src.contains("app.resources_table().add(ExitHook::new(move || exit_before_installer(&handle)))"));
            let body = &src[src.find("fn exit_before_installer(").unwrap()..];
            assert!(body.find("run_exit_cleanup(").unwrap() < body.find("wait_for_hosts_to_end(").unwrap());
        }

        #[test]
        fn the_exit_cleanup_runs_once_whichever_event_comes_first() {
            let flag = AtomicBool::new(false);
            assert!(begin_on(&flag), "ExitRequested (or Exit, on Cmd-Q) runs it");
            assert!(!begin_on(&flag), "the Exit that follows ExitRequested doesn't run it again");
        }

        /// H1 (1.173.0, Challenger round 1): the watchdog stops probing
        /// before the cleanup holds the main thread, and its thread ends
        /// last, just before `exit: cleanup done`.
        #[test]
        fn the_watchdog_quits_first_and_stops_last_in_the_exit_cleanup() {
            let src = include_str!("lib.rs");
            let start = src.find("fn run_exit_cleanup(").expect("run_exit_cleanup");
            let end = start + src[start..].find("\n}\n").expect("its end");
            let body = &src[start..end];
            let quitting = body.find("watchdog::quitting();").expect("watchdog::quitting is called");
            let first_log = body.find("log::info!(\"exit: {why}").expect("the first exit line");
            assert!(quitting < first_log, "quitting comes before any cleanup");
            let stop = body.find("watchdog::stop();").expect("watchdog::stop is called");
            let done = body.find("exit: cleanup done").expect("the last exit line");
            assert!(body[..stop].matches("kill").count() > 0 && stop < done, "stop is last");
            assert!(!body[stop..done].contains("kill"), "nothing is killed after stop");
        }

        /// QoL 1.168 block 4 (Challenger round 1): the sessions open at quit
        /// are marked before any child is killed — after, a tile's exit would
        /// end its row first and nothing would be offered at the next launch.
        #[test]
        fn the_quit_marks_open_sessions_before_any_child_is_killed() {
            let src = include_str!("lib.rs");
            let start = src.find("fn run_exit_cleanup(").expect("run_exit_cleanup");
            let end = start + src[start..].find("\n}\n").expect("its end");
            let body = &src[start..end];
            let mark = body.find("terminal_sessions::mark_quit_looking(").expect("mark_quit_looking is called");
            for kill in [
                "swarm_registry.kill_all()",
                "agent_registry.kill_all(",
                "setup_run::exit_cleanup(",
                "registry.kill_all()",
                "chat_extract::kill_active()",
            ] {
                let at = body.find(kill).unwrap_or_else(|| panic!("{kill} is in run_exit_cleanup"));
                assert!(mark < at, "mark_quit_looking runs before {kill}");
            }
        }
    }
}

#[derive(Serialize, Clone)]
struct WindowDropEvent {
    paths: Vec<String>,
    position: (f64, f64),
    #[serde(rename = "windowLabel")]
    window_label: String,
}

/// Quit Ply. Windows' keyboard quit (the Mac quits from its app menu). QoL
/// 1.168 S1-2: through the quit guard ([`request_quit`]), which asks the page
/// first when something would be lost; the exit itself raises
/// `ExitRequested`, where every child is killed (hard rule 4).
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    request_quit(&app);
}

/// QoL 1.168 S1-2: the quit handshake. Every quit Plyloft starts itself — the
/// Mac's Plyloft › Quit and ⌘Q (a custom menu item, see `build_menu`), the
/// tray's Quit, Windows' Ctrl+Shift+Q and the close sheet's Quit — asks the
/// page first: it knows the unsaved files and the sessions mid-turn, and
/// answers at once when nothing would be lost. The same [`close_choice::CloseAsk`]
/// handshake as the Windows close: a page that isn't listening, or doesn't
/// ack in time, never holds a quit back — the quit goes ahead as before.
/// Nothing is prevented in `ExitRequested`, so the cleanup there still runs
/// once, on the real exit only (hard rule 4).
static QUIT_ASK: std::sync::Mutex<close_choice::CloseAsk> =
    std::sync::Mutex::new(close_choice::CloseAsk::new());

/// How long a quit waits for the page's ack before it goes ahead. Longer than
/// the close's: the window may be hidden, and a hidden web view answers late.
const QUIT_ACK_TIMEOUT_MS: u64 = 3000;

fn quit_ask() -> std::sync::MutexGuard<'static, close_choice::CloseAsk> {
    QUIT_ASK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the page is told when a quit asks (`app://quit-asked`).
#[derive(Serialize, Clone)]
struct QuitAsked {
    generation: u64,
}

/// Bring the main window forward, so the quit sheet is seen.
fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(windows)]
    windows_shell::show_main(app);
    #[cfg(not(windows))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// QoL 1.168 S1-2: quit, unless the page says something would be lost — then
/// it shows its sheet (Save all / Quit anyway / Cancel) and answers through
/// `quit_answer`. A second quit while a sheet is up brings it forward.
fn request_quit(app: &tauri::AppHandle) {
    use close_choice::AskStart;
    let start = quit_ask().begin();
    match start {
        AskStart::NotListening => app.exit(0),
        AskStart::AlreadyAsking => show_main_window(app),
        AskStart::Emit(generation) => {
            if app.emit("app://quit-asked", QuitAsked { generation }).is_err() {
                if quit_ask().timed_out(generation) {
                    app.exit(0);
                }
                return;
            }
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(QUIT_ACK_TIMEOUT_MS));
                if quit_ask().timed_out(generation) {
                    log::warn!("quit: the page did not answer; quitting");
                    app.exit(0);
                }
            });
        }
    }
}

/// The page listens for quit asks (called on every load).
#[tauri::command]
fn quit_listening() {
    quit_ask().ready();
}

/// The page stopped listening for quit asks: a quit goes ahead at once.
#[tauri::command]
fn quit_not_listening() {
    quit_ask().gone();
}

/// The page got quit ask `generation`. `ask: false` — nothing would be lost:
/// quit now. `ask: true` — the window comes forward and the page shows its
/// sheet (returns true). False: the ask already timed out, show nothing.
#[tauri::command]
fn quit_ack(app: tauri::AppHandle, generation: u64, ask: bool) -> bool {
    if !quit_ask().ack(generation) {
        return false;
    }
    if !ask {
        quit_ask().answered();
        app.exit(0);
        return false;
    }
    show_main_window(&app);
    true
}

/// The quit sheet's answer: `quit` quits (after the page saved what it was
/// asked to), anything else keeps Plyloft open.
#[tauri::command]
fn quit_answer(app: tauri::AppHandle, choice: String) {
    quit_ask().answered();
    if choice == "quit" {
        app.exit(0);
    }
}

/// Windows (W4): the ask handshake behind the close sheet
/// (`close_choice::CloseAsk`).
#[cfg(windows)]
static CLOSE_ASK: std::sync::Mutex<close_choice::CloseAsk> =
    std::sync::Mutex::new(close_choice::CloseAsk::new());

#[cfg(windows)]
fn close_ask() -> std::sync::MutexGuard<'static, close_choice::CloseAsk> {
    CLOSE_ASK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the page is told when a close asks (`window://close-asked`).
#[cfg(windows)]
#[derive(Serialize, Clone)]
struct CloseAsked {
    generation: u64,
    /// The notification-area icon is there; without it "keep running"
    /// minimizes the window instead.
    tray: bool,
}

/// Windows (W4): the main window's close, by `behavior.windowsCloseAction`.
/// The close itself is always prevented by the caller.
#[cfg(windows)]
fn windows_close_main(app: &tauri::AppHandle) {
    use close_choice::{close_decision, AskStart, CloseDecision, ACK_TIMEOUT_MS};
    let action = app
        .try_state::<settings::SettingsStore>()
        .map(|store| store.snapshot().behavior.windows_close_action)
        .unwrap_or_default();
    match close_decision(action, true) {
        CloseDecision::Hide => windows_shell::close_main(app),
        // The tray's "Quit Plyloft", through the quit guard (S1-2):
        // `ExitRequested` kills every child first.
        CloseDecision::Quit => request_quit(app),
        CloseDecision::AskFrontend => {
            let start = close_ask().begin();
            match start {
                AskStart::NotListening => windows_shell::close_main(app),
                AskStart::AlreadyAsking => windows_shell::show_main(app),
                AskStart::Emit(generation) => {
                    windows_shell::show_main(app);
                    let payload = CloseAsked {
                        generation,
                        tray: windows_shell::has_tray(app),
                    };
                    if app.emit("window://close-asked", payload).is_err() {
                        if close_ask().timed_out(generation) {
                            windows_shell::close_main(app);
                        }
                        return;
                    }
                    // Nobody acked in time: the page cannot answer, so the
                    // close does what it did before the choice existed.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(ACK_TIMEOUT_MS));
                        if close_ask().timed_out(generation) {
                            log::warn!("close sheet not acknowledged; hiding the window");
                            windows_shell::close_main(&app);
                        }
                    });
                }
            }
        }
    }
}

/// Windows: the page listens for close asks (called on every load).
#[tauri::command]
fn window_close_listening() {
    #[cfg(windows)]
    close_ask().ready();
}

/// Windows: the page stopped listening for close asks (its sheet host
/// unmounted), so a close hides at once until it listens again.
#[tauri::command]
fn window_close_not_listening() {
    #[cfg(windows)]
    close_ask().gone();
}

/// Windows: the page got close ask `generation`. True: show the sheet.
#[tauri::command]
fn window_close_ack(generation: u64) -> bool {
    #[cfg(windows)]
    {
        close_ask().ack(generation)
    }
    #[cfg(not(windows))]
    {
        let _ = generation;
        false
    }
}

/// Windows: the close sheet's answer — `tray` hides to the notification
/// area, `quit` quits (the tray's "Quit Plyloft"), anything else leaves the
/// window open. The page saves "Don't ask again" itself, through Settings.
#[tauri::command]
fn window_close_answer(app: tauri::AppHandle, choice: String) {
    #[cfg(windows)]
    {
        use close_choice::CloseAnswer;
        close_ask().answered();
        match CloseAnswer::parse(&choice) {
            CloseAnswer::Tray => windows_shell::close_main(&app),
            // S1-2: through the quit guard; the sheet already named the
            // sessions, so the page asks only about unsaved files.
            CloseAnswer::Quit => request_quit(&app),
            CloseAnswer::Stay => {}
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, choice);
    }
}

/// The About panel's credits on macOS: the same sentence as the Trademarks
/// row in Settings › Account › Profile (`ProfilePage.tsx`; a test keeps them
/// equal). Windows has no native About panel, so the Profile row carries it.
#[cfg(target_os = "macos")]
const TRADEMARKS_CREDITS: &str = "Claude and Claude Code are trademarks of Anthropic, PBC; ChatGPT and Codex are trademarks of OpenAI; GitHub is a trademark of GitHub, Inc.; Git is a trademark of Software Freedom Conservancy. Plyloft is not affiliated with or endorsed by them.";

/// macOS only. Tauri's own `Menu::default` (tauri 2.11, src/menu/menu.rs) is
/// what `app::build` installs automatically when `.menu(...)` is never
/// called and the target is macOS (`self.enable_macos_default_menu`,
/// src/app.rs `build`) — every other platform gets no app-level menu bar at
/// all unless one is registered explicitly. That default builds the App
/// submenu's title and its "About/Hide/Quit" labels from `pkg_info.name` —
/// `productName`, "Ply" (the bundle/identifier contract, AGENTS.md hard
/// rule, stays put) — so left alone, macOS's app menu would keep reading
/// "Ply" even once Info.plist's CFBundleName says "Plyloft". This mirrors
/// that default item for item — same submenus, same predefined items — with
/// the display name swapped in for the App submenu, About, Hide and Quit, and
/// one difference (QoL 1.168 S1-2): Quit is a plain item with ⌘Q whose click
/// goes through the quit guard and then `AppHandle::exit`, so the app-exit
/// cleanup below (hard rule 4) still runs on every quit.
/// Registering this on Windows/Linux too would hand them a real native menu
/// bar they don't have today, and its predefined Quit item there ends the
/// event loop directly rather than going through the app-exit event this
/// module handles further down (where the actual child cleanup lives),
/// orphaning PTYs and agents; the caller below gates the `.menu(build_menu)`
/// call to macOS for exactly that reason.
/// The Help menu's Keyboard Shortcuts item; its press is `menu://shortcuts`.
#[cfg(target_os = "macos")]
const HELP_SHORTCUTS_MENU_ID: &str = "ply-help-shortcuts";
/// The Mac's Plyloft › Quit item (S1-2).
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "app-quit";
/// QoL 1.168 S3: the menu items whose press the page answers, by id, and
/// what `menu://help` tells it (`help_menu_action`). The Windows tray's
/// Check for Updates sends the same `check-updates`.
#[cfg(target_os = "macos")]
const CHECK_UPDATES_MENU_ID: &str = "ply-check-updates";
#[cfg(target_os = "macos")]
const HELP_GUIDE_MENU_ID: &str = "ply-help-guide";
#[cfg(target_os = "macos")]
const HELP_WHATS_NEW_MENU_ID: &str = "ply-help-whats-new";
#[cfg(target_os = "macos")]
const HELP_GETTING_STARTED_MENU_ID: &str = "ply-help-getting-started";

/// What `menu://help` carries for a menu item's id; None for the rest.
#[cfg(target_os = "macos")]
fn help_menu_action(id: &str) -> Option<&'static str> {
    match id {
        CHECK_UPDATES_MENU_ID => Some("check-updates"),
        HELP_GUIDE_MENU_ID => Some("guide"),
        HELP_WHATS_NEW_MENU_ID => Some("whats-new"),
        HELP_GETTING_STARTED_MENU_ID => Some("getting-started"),
        _ => None,
    }
}

#[cfg(all(test, target_os = "macos"))]
mod help_menu_tests {
    use super::*;

    #[test]
    fn help_menu_items_name_what_the_page_opens() {
        assert_eq!(help_menu_action(CHECK_UPDATES_MENU_ID), Some("check-updates"));
        assert_eq!(help_menu_action(HELP_GUIDE_MENU_ID), Some("guide"));
        assert_eq!(help_menu_action(HELP_WHATS_NEW_MENU_ID), Some("whats-new"));
        assert_eq!(help_menu_action(HELP_GETTING_STARTED_MENU_ID), Some("getting-started"));
        // Shortcuts and Quit keep their own paths; anything else is not the page's.
        assert_eq!(help_menu_action(HELP_SHORTCUTS_MENU_ID), None);
        assert_eq!(help_menu_action(QUIT_MENU_ID), None);
        assert_eq!(help_menu_action(""), None);
    }
}

#[cfg(target_os = "macos")]
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some("Plyloft".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        credits: Some(TRADEMARKS_CREDITS.into()),
        ..Default::default()
    };

    // `init_app_menu` (src/app.rs, macOS only) looks these two up by id to
    // install the NSApp window list (`set_as_windows_menu_for_nsapp`) and
    // wire Spotlight-style menu search (`set_as_help_menu_for_nsapp`); a
    // plain `Submenu::with_items` has no id and both lookups silently no-op.
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // QoL walk of block 6: Help › Keyboard Shortcuts, a way to the sheet on
    // every keyboard layout (an Italian ⌘? is macOS's own Help search, and
    // never reaches the page). No accelerator: ⌘/ and ⌘⇧/ stay the page's.
    // QoL 1.168 S3: the in-app Help's ways in, so the menu bar's Help is not
    // only macOS's search.
    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, HELP_GUIDE_MENU_ID, "Plyloft User Guide", true, None::<&str>)?,
            &MenuItem::with_id(app, HELP_SHORTCUTS_MENU_ID, "Keyboard Shortcuts", true, None::<&str>)?,
            &MenuItem::with_id(app, HELP_WHATS_NEW_MENU_ID, "New in This Version", true, None::<&str>)?,
            &MenuItem::with_id(app, HELP_GETTING_STARTED_MENU_ID, "Getting Started", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Plyloft",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Plyloft"), Some(about_metadata))?,
                    // QoL 1.168 S3: look for a new version now.
                    &MenuItem::with_id(app, CHECK_UPDATES_MENU_ID, "Check for Updates…", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some("Hide Plyloft"))?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    // One item beyond tauri 2.11's own default (which stops
                    // at Hide/Hide Others/Quit): the standard macOS app-menu
                    // convention also has Show All here, so it's added.
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    // QoL 1.168 S1-2: not `PredefinedMenuItem::quit`, which
                    // is `-[NSApp terminate:]` and can't be held back: a
                    // plain item whose click (`on_menu_event` below) goes
                    // through the quit guard, and from there `AppHandle::exit`
                    // — `ExitRequested`, every child killed (hard rule 4).
                    &MenuItem::with_id(app, QUIT_MENU_ID, "Quit Plyloft", true, Some("CmdOrCtrl+Q"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Windows: while `count` things wait on the user, a dot on the taskbar
/// button and the tray icon and the count in the tray's tooltip — the
/// stand-in for the dock badge (`setBadgeCount` is a no-op there).
/// Nothing on other platforms.
#[tauri::command]
fn window_set_attention(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    count: u32,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_shell::set_attention(&app, &window, count).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, count);
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows: before any PTY spawn, so a tile's Ctrl+C interrupts its
    // command whichever way Ply was launched (platform.rs).
    #[cfg(windows)]
    if !platform::restore_ctrl_c_for_children() {
        eprintln!("could not clear the ignore-Ctrl+C flag: {}", std::io::Error::last_os_error());
    }
    let required_inbox_set = inbox::RequiredInboxSet::from_environment();
    let gui_inbox_proof = match inbox_gui_proof::GuiInboxProof::from_environment(&required_inbox_set) {
        Ok(observer) => observer,
        Err(condition) => {
            eprintln!("{condition}");
            std::process::exit(2);
        }
    };
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    // The second person of a two-member walk (dev-only, test bridge builds).
    #[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
    test_bridge::apply_instance(&mut context);

    let mut builder = tauri::Builder::default();

    // GH #138: the categorical half of the navigation refusal. Registered
    // before anything else so it covers the very first load of the app page.
    builder = builder.plugin(navigation::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch brings the (maybe hidden) window back. On
            // Windows it is the way back besides the tray icon.
            #[cfg(windows)]
            windows_shell::show_main(app);
            #[cfg(not(windows))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // v1.4.0 (L1): CLI activation. The shim at scripts/cli/atelier
            // resolves the user's `cd` to an absolute path and invokes
            // `open -na Atelier --args <abspath>`. macOS's open ships a
            // new instance which the single-instance plugin routes here;
            // argv[1..] carries the path. First arg that points to an
            // existing directory becomes the target workspace.
            if let Some(path) = cli_path_from_argv(&argv) {
                if let Some(store) = app.try_state::<workspace::WorkspaceStore>() {
                    match store.open_or_create_at_path(&path) {
                        Ok(ws) => {
                            log::info!(
                                "cli activation: focused/created workspace '{}' at {}",
                                ws.name,
                                ws.cwd
                            );
                            // v1.5.7 (Bug #1): notify frontend so the
                            // zustand workspace store re-fetches and
                            // switches active. Without this, the disk
                            // state changes but the React sidebar stays
                            // stale until the next reload.
                            let _ = app.emit("workspace://activated", &ws.id);
                        }
                        Err(e) => {
                            log::warn!("cli activation: open_or_create_at_path failed: {e}");
                        }
                    }
                }
            }
        }));
    }

    let mut builder = builder
        .manage(required_inbox_set)
        .manage(gui_inbox_proof)
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        // Never offer a release older than the Plyloft installed on this PC,
        // even when the running copy is older still (legacy_install.rs).
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current, remote| {
                    legacy_install::offer_update(
                        &current,
                        &remote.version,
                        legacy_install::installed_plyloft_version().as_ref(),
                    )
                })
                .build(),
        )
        // v1.73.0 (UX revamp step 5b-3): the settings window is gone —
        // Settings lives in the shell as an overlay. No denylist needed.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(pty::PtyRegistry::default())
        .manage(setup_run::SetupRunner::default())
        .manage(codex_app::CodexAppRegistry::default())
        .manage(card_execution::CardExecutionGate::default())
        .manage(writer_queue::WriterQueue::default())
        .manage(watcher::WatcherRegistry::default())
        .manage(search::SearchRegistry::default());
    // macOS only: see `build_menu`'s doc comment for why this must not run
    // on Windows/Linux.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(build_menu).on_menu_event(|app, event| {
            if event.id() == HELP_SHORTCUTS_MENU_ID {
                let _ = app.emit("menu://shortcuts", ());
            } else if event.id().as_ref() == QUIT_MENU_ID {
                request_quit(app);
            } else if let Some(action) = help_menu_action(event.id().as_ref()) {
                // The window comes forward: its sheet answers the press.
                show_main_window(app);
                let _ = app.emit("menu://help", action);
            }
        });
    }
    let app = builder
        .setup(|app| {
            // The window is up but frozen while this closure runs (it is on
            // the main thread), so its length is logged.
            let setup_started = std::time::Instant::now();
            // Cycle 1 (com.matteo.atelier → com.mbadv.ply rebrand): migrate the
            // legacy app-data dir BEFORE any store loads. Runs once (sentinel-
            // guarded); on a clean install it's a no-op. A migration error
            // aborts startup on purpose — better than letting the stores create
            // an empty new dir that would then look "already migrated" forever
            // (the old dir stays intact for a clean retry). See migrate.rs.
            {
                let new_cfg = app
                    .path()
                    .app_config_dir()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
                if let Some(old_cfg) = migrate::legacy_dir_for(&new_cfg) {
                    match migrate::migrate_legacy_app_data(&old_cfg, &new_cfg) {
                        Ok(outcome) => log::info!("app-data migration: {outcome:?}"),
                        Err(e) => {
                            log::error!("app-data migration failed, aborting startup: {e}");
                            return Err(Box::new(e));
                        }
                    }
                }
            }
            shell_env::init();
            // B2 re-review: the updater's exit runs the quit's cleanup too.
            {
                let handle = app.handle().clone();
                app.resources_table().add(ExitHook::new(move || exit_before_installer(&handle)));
            }
            // 1.169.0 (B2): choose the ConPTY off the main thread, so the
            // first tile's spawn doesn't pay for the bundled one's trial.
            #[cfg(windows)]
            std::thread::spawn(|| {
                conpty_host::ensure();
            });
            log::info!(
                "atelier startup: shell={} claude={}",
                shell_env::get().shell,
                shell_env::get()
                    .claude_path
                    .clone()
                    .unwrap_or_else(|| "<not found>".into()),
            );
            match mcp_launch::resolve_and_validate_sidecar() {
                Ok(path) => log::info!("knowledge sidecar ready: {}", path.display()),
                Err(error) => {
                    // The shell remains usable when a packaging error affects
                    // Knowledge retrieval; provider launch surfaces the same
                    // actionable failure before injecting MCP configuration.
                    log::warn!("knowledge sidecar unavailable: {error}");
                }
            }
            if let Ok(log_dir) = app.path().app_log_dir() {
                log_retention::prune_old(&log_dir);
            }
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                cache_retention::prune_old(&cache_dir.join("dropped"));
            }
            // v1.63.0: App Nap suppression is conditional. The gate acquires
            // the NSActivity token when the first PTY stream starts and the
            // 30s runtime tick releases it after a sustained idle window
            // (no live PTYs, no Running swarms) — so a hidden, idle Ply can
            // actually nap. See app_nap::ActivityGate.
            let nap_gate = std::sync::Arc::new(app_nap::ActivityGate::new());
            app.manage(nap_gate.clone());
            app.state::<pty::PtyRegistry>().set_gate(nap_gate.clone());
            app.state::<codex_app::CodexAppRegistry>()
                .set_gate(nap_gate.clone());
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            // A card's chat: its sessions, killed on quit (`run_exit_cleanup`)
            // and when their card is deleted; idle ones suspended.
            {
                let chats = chat::ChatRegistry::new(config_dir.clone());
                chats.set_gate(nap_gate);
                let handle = app.handle().clone();
                chats.set_emitter(std::sync::Arc::new(move |event: &str, payload: serde_json::Value| {
                    let _ = handle.emit(event, payload);
                }));
                chats.start_sweeper();
                chats.install_global();
                // Plan with two AIs: its driver runs on the chats' lanes;
                // a running exchange is saved paused on quit
                // (`run_exit_cleanup`, before the chats end).
                let plans = plan_exchange::PlanExchanges::new(
                    chats.clone(),
                    std::sync::Arc::new(plan_exchange::AppEnv { app: app.handle().clone() }),
                );
                app.manage(plans);
                // Next improvement's rounds run on the chats' lanes too,
                // hosted by the workspace (E2).
                app.manage(next_improvement::round::Rounds::new(
                    config_dir.join("projects"),
                    std::sync::Arc::new(next_improvement::round::AppEnv { app: app.handle().clone() }),
                ));
                app.manage(chats);
                // Temporary folders a PDF extraction child left behind.
                std::thread::spawn(chat_extract::clean_leftovers);
            }
            app.manage(
                codex_app::CodexApprovalStore::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
            );
            // Agent collaboration Phase 2A: one Tauri-owned coordination
            // snapshot. Construction reconciles prior active records to
            // interrupted and performs bounded startup retention. It never
            // resurrects a process.
            let coordination_registry =
                coordination::CoordinationRegistry::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            coordination_registry.set_app_handle(app.handle().clone());
            app.state::<pty::PtyRegistry>()
                .set_coordination(coordination_registry.clone());
            app.manage(coordination_registry);
            let reviewer_capabilities =
                review_capabilities::ReviewerCapabilityRegistry::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            reviewer_capabilities
                .invalidate_drift(&shell_env::get())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(reviewer_capabilities);
            app.manage(
                reviewer::ReviewerRegistry::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
            );
            let store = workspace::WorkspaceStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            // v1.4.0 (L1): cold-start CLI activation. If the binary was
            // launched with a path arg (`open -na Atelier --args <path>`
            // when no instance was running), find/create the workspace
            // before frontend code reads activeWorkspaceId. Same helper
            // as the warm-instance single-instance callback.
            let cold_argv: Vec<String> = std::env::args().collect();
            if let Some(path) = cli_path_from_argv(&cold_argv) {
                if let Err(e) = store.open_or_create_at_path(&path) {
                    log::warn!("cli activation (cold start): {e}");
                } else {
                    log::info!("cli activation (cold start): opened {path}");
                }
            }
            // v1.61.0 (Phase 5 — onboarding): drain the import queue left by
            // scripts/onboard.sh. Each listed repo's
            // `.atelier/workspace_default.json` becomes a pre-registered
            // workspace (idempotent). If any were created this launch, drop a
            // `welcome_pending` sentinel so the frontend can show a one-time
            // welcome toast. Best-effort: a failure here must never block
            // startup (mirrors the snapshot-capture F1 pattern).
            {
                let queue = config_dir.join("pending_imports.json");
                match store.import_pending(&queue) {
                    Ok(n) if n > 0 => {
                        let sentinel = config_dir.join("welcome_pending");
                        if let Err(e) = std::fs::write(&sentinel, b"1") {
                            log::warn!("onboarding: failed to write welcome sentinel: {e}");
                        }
                        log::info!("onboarding: imported {n} workspace(s) from queue");
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("onboarding: import_pending failed: {e}"),
                }
            }
            app.manage(store);
            let settings_store = settings::SettingsStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            let initial_settings = settings_store.snapshot();
            // v1.0: honor `shell.pathOverride` if set. Workaround for cases
            // where the bash login probe at startup misses the user's
            // interactive PATH (sandboxing, missing `.bash_profile`, etc.).
            // The override REPLACES the probed PATH entirely. Recorded in
            // shell_env so every later re-probe (Look again, Setup, a Codex
            // update) applies it too instead of dropping it.
            shell_env::configure_path_override(initial_settings.shell.path_override.as_deref());
            if let Some(override_path) = shell_env::path_override() {
                let env = shell_env::apply_path_override(&override_path);
                log::info!(
                    "shell_env: pathOverride applied; claude={}",
                    env.claude_path.clone().unwrap_or_else(|| "<not found>".into())
                );
            }
            // 1.169.0 (A1): the model menus' catalog — the cached site file
            // now, then `codex debug models` and the site in the background
            // (after the PATH override above, so Codex is found as spawns
            // find it).
            model_catalog::init(app.handle(), config_dir.clone());
            // v1.32.0: first-run backfill. An established user upgrading into
            // v1.32.0 has no `onboarding.firstRunCompletedAt` yet — but they
            // are not a first-run user. If workspaces already exist, mark
            // first-run complete now so the guided welcome screen never shows
            // for them; a genuine fresh install (zero workspaces) keeps the
            // None and gets the welcome.
            // OB-4: not while a first run is under way in Setup
            // (`needs_first_run_backfill`).
            if initial_settings.onboarding.first_run_completed_at.is_none() {
                let has_workspaces = app
                    .try_state::<workspace::WorkspaceStore>()
                    .map(|s| !s.snapshot().workspaces.is_empty())
                    .unwrap_or(false);
                if initial_settings
                    .onboarding
                    .needs_first_run_backfill(has_workspaces)
                {
                    match settings_store.update(|s| {
                        s.onboarding.first_run_completed_at.get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
                    }) {
                        Ok(_) => log::info!(
                            "onboarding: backfilled firstRunCompletedAt (existing install)"
                        ),
                        Err(e) => log::warn!("onboarding: backfill failed: {e}"),
                    }
                }
            }
            // v1.49.0 (Team Mode Phase 0): identity backfill. Cache
            // `git config --global user.email` once at startup so that every
            // write to shared-library stores (prompts/agents/swarm templates/
            // user templates/cards) carries an `author` / `lastEditedBy`.
            // We only fetch if currently `None` — the cached value is
            // authoritative; a user who changes their git email after first
            // launch can clear the field via Settings later.
            //
            // OB-2 (C9): only through a git that works — on a Mac without the
            // Command Line Tools a bare `git` is Apple's shim, and running it
            // opens the install dialog unasked. The probe (above) found out
            // without running it.
            let probed = shell_env::get();
            let working_git = probed.git_works().then(|| probed.git_path.clone()).flatten();
            if let (true, Some(git)) = (initial_settings.identity.user_email.is_none(), working_git) {
                match crate::platform::new_command(&git)
                    .args(["config", "--global", "user.email"])
                    .env("PATH", &probed.path)
                    .output()
                {
                    Ok(out) if out.status.success() => {
                        let email = String::from_utf8_lossy(&out.stdout)
                            .trim()
                            .to_string();
                        if !email.is_empty() {
                            match settings_store.update(|s| {
                                s.identity.user_email.get_or_insert_with(|| email.clone());
                            }) {
                                Ok(_) => log::info!(
                                    "identity: backfilled userEmail from git config ({email})"
                                ),
                                Err(e) => log::warn!("identity: backfill save failed: {e}"),
                            }
                        }
                    }
                    Ok(_) => log::info!(
                        "identity: git config --global user.email returned non-zero; \
                         leaving userEmail unset"
                    ),
                    Err(e) => log::warn!("identity: git spawn failed: {e}"),
                }
            }
            app.manage(settings_store);
            // 1.173.0 (C2): this computer's id and name for the claim marker
            // on a GitHub Issues board (made once, the name read again).
            // 1.174.0 (E12, CH-5): off the main thread, each read bounded
            // (`device_claim::READ_LIMIT`), so the window never waits on it.
            let identity_app = app.handle().clone();
            if let Err(e) = device_claim::identify_in_background(move || {
                if let Some(store) = identity_app.try_state::<settings::SettingsStore>() {
                    if let Err(e) =
                        store.ensure_device(device_claim::read_computer_name, device_claim::read_hardware_id)
                    {
                        log::warn!("device: identity not saved: {e}");
                    }
                }
            }) {
                log::warn!("device: identity thread not started: {e}");
            }

            let files_order = files_order::FilesOrderStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(files_order);

            let agent_registry = agents::AgentRegistry::new(&config_dir)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            let agent_config_dir = agent_registry.config_dir().to_path_buf();
            // Reconcile any pending/running runs left over from a previous
            // crash or force-quit. Mark them killed and collect their IDs so
            // the kanban store can also clear matching `linkedRunId`s below.
            let orphan_run_ids = agent_registry.reconcile_orphans();
            // v0.8.0: prune historical runs at startup based on the user's
            // retention policy. No-op if both fields are null. v1.0 also
            // cleans `<cwd>/.atelier/swarm/<runId>/` for pruned swarm runs;
            // needs a workspace_id → cwd lookup that the registry doesn't
            // own, so we snapshot WorkspaceStore once and pass a closure.
            let cwd_lookup_snapshot: std::collections::HashMap<String, std::path::PathBuf> =
                app.try_state::<workspace::WorkspaceStore>()
                    .map(|s| {
                        s.snapshot()
                            .workspaces
                            .into_iter()
                            .map(|w| (w.id, std::path::PathBuf::from(w.cwd)))
                            .collect()
                    })
                    .unwrap_or_default();
            // R6 (resumable swarms): protect runs whose parent swarm is
            // Running or Suspended from pruning. swarm_registry isn't
            // app-managed yet at this point in setup, so we build a
            // snapshot map of {swarm_id -> status} from the on-disk
            // SwarmRegistry that's already been constructed. The closure
            // captures it so prune_runs can check status without needing
            // the registry handle directly.
            let protected_swarm_ids: std::collections::HashSet<String> = {
                let temp_registry = swarms::SwarmRegistry::new(config_dir.clone()).ok();
                temp_registry
                    .map(|r| {
                        r.list()
                            .into_iter()
                            .filter(|s| {
                                matches!(
                                    s.status,
                                    swarms::SwarmStatus::Running | swarms::SwarmStatus::Suspended
                                )
                            })
                            .map(|s| s.id)
                            .collect()
                    })
                    .unwrap_or_default()
            };
            agent_registry.prune_runs(
                initial_settings.behavior.run_history_retention.days,
                initial_settings.behavior.run_history_retention.max_runs,
                |wsid: &str| cwd_lookup_snapshot.get(wsid).cloned(),
                |sid: &str| protected_swarm_ids.contains(sid),
            );

            // v1.5.0 (S2): age-based cleanup of `<workspace_cwd>/.atelier/
            // swarm/<runId>/` artifact dirs. Complements `prune_runs` (which
            // only deletes dirs whose run record gets pruned) by reaping
            // orphans + dirs that survive when the user has no per-count /
            // per-day retention configured. Protected: any runId belonging
            // to a Running / Suspended swarm.
            let protected_run_ids: std::collections::HashSet<String> = {
                let temp_registry = swarms::SwarmRegistry::new(config_dir.clone()).ok();
                temp_registry
                    .map(|r| {
                        r.list()
                            .into_iter()
                            .filter(|s| {
                                matches!(
                                    s.status,
                                    swarms::SwarmStatus::Running
                                        | swarms::SwarmStatus::Suspended
                                )
                            })
                            .flat_map(|s| s.run_ids.into_iter())
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let workspace_cwds: Vec<std::path::PathBuf> = cwd_lookup_snapshot
                .values()
                .cloned()
                .collect();
            swarms::prune_stale_swarm_artifact_dirs(
                &workspace_cwds,
                initial_settings.behavior.swarm_artifact_retention_days,
                &protected_run_ids,
            );

            // v1.12.0 (Cycle C): per-workspace project_config store.
            // Bootstraps Atelier-shaped workspaces with the hardcoded
            // defaults so v1.12.x ships zero behavior change. Future
            // workspaces (LYRA etc.) materialize their config via the
            // setup-agent flow that lands in v1.12.1.
            let project_config_store =
                project_config::ProjectConfigStore::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            let bootstrap_input: Vec<(String, std::path::PathBuf)> = cwd_lookup_snapshot
                .iter()
                .map(|(id, cwd)| (id.clone(), cwd.clone()))
                .collect();
            project_config_store.bootstrap_atelier_workspaces(&bootstrap_input);
            app.manage(project_config_store);

            // v1.11.0 (Cycle B): GC the per-workspace
            // `.plyloft-worktrees/.trash/` (and legacy `.atelier-worktrees/.trash/`) dirs: entries older than 7 days
            // (TRASH_TTL_SECS) are reaped, and the rest lose their build
            // caches. Now at launch and then daily, on a thread, since
            // healing an old trash removes gigabytes. Best-effort.
            app.manage(build_cache::TrashCleanupLog::default());
            app.manage(branch_cleanup::BacklogState::default());

            app.manage(agent_registry);

            let kanban_store = kanban::KanbanStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            kanban_store.reconcile_orphan_runs(&orphan_run_ids);

            // v1.34.x: backfill ship-state on cards whose worktree
            // branch was already merged onto the workspace's target
            // branch but whose kanban entry never got marked
            // `Shipped` (the v1.31.0 Outcome-screen Ship-it path
            // dropped that side-effect). One-shot per workspace per
            // boot; idempotent by predicate so a clean board is a
            // no-op. Failure on any single workspace logs and
            // continues — nothing else hinges on this.
            {
                let project_config_state =
                    app.state::<project_config::ProjectConfigStore>();
                for (ws_id, cwd) in &cwd_lookup_snapshot {
                    let cfg_opt = project_config_state.get(ws_id);
                    let target_branch = cfg_opt
                        .as_ref()
                        .map(|c| c.target_branch.clone())
                        .unwrap_or_else(|| "main".to_string());
                    let reader = |repo_root: &std::path::Path| -> Option<String> {
                        cfg_opt.as_ref().and_then(|cfg| {
                            ship::read_project_version(repo_root, cfg)
                        })
                    };
                    let cache_paths =
                        cfg_opt.as_ref().map(|c| c.cache_paths.clone()).unwrap_or_default();
                    let _ = kanban_store.reconcile_ship_backfill(
                        ws_id,
                        cwd,
                        &target_branch,
                        &cache_paths,
                        &reader,
                    );
                }
            }

            // 1.174.0 (A6 round 1): the first card shipped on this Mac, from
            // every board file (each just read above, so cached), once —
            // Next improvement then shows by itself on every project.
            {
                let settings_state = app.state::<settings::SettingsStore>();
                if settings_state.snapshot().next_improvement.first_card_shipped_at.is_none() {
                    let now = kanban::now_ms();
                    let first = cwd_lookup_snapshot
                        .iter()
                        .filter_map(|(ws_id, _)| kanban_store.load(ws_id).ok())
                        .filter_map(|cards| kanban::earliest_ship_ms(&cards, now))
                        .min();
                    if let Err(e) = settings_state.backfill_first_card_shipped(first) {
                        log::warn!("settings: first shipped card not recorded: {e}");
                    }
                }
            }

            // 1.175.0 (A2, fix round 1): what the boards name, read once for
            // the three launch sweeps (discussion records here, snapshot and
            // swarm folders below). When the project list or a board
            // couldn't be read it is not the whole picture, and none of the
            // three prunes on it (`launch_inventory`).
            // R4: a coordination state set aside this launch protects none
            // of the snapshots its handoffs did.
            let handoffs_set_aside = app
                .try_state::<coordination::CoordinationRegistry>()
                .and_then(|coordination| coordination.set_aside().map(|aside| aside.to_path_buf()));
            let launch_inventory = launch_inventory::LaunchInventory::read(
                &app.state::<workspace::WorkspaceStore>(),
                &kanban_store,
                &config_dir,
                handoffs_set_aside.as_deref(),
            );
            // Agent collaboration Phase 5A: discussions are a dedicated
            // read-only orchestration record, not a generic Swarm. Retention
            // protects records linked to cards that still exist. If any
            // board cannot be read, skip age/count pruning conservatively
            // rather than risk deleting a live link.
            let discussion_registry = discussion::DiscussionRegistry::new(
                config_dir.clone(),
                launch_inventory.live_cards(),
            )
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(discussion_registry);

            app.manage(kanban_store);
            // 1.175.0 (R2): a board opened from its last saved copy sends
            // nothing to its issues before GitHub was read once.
            {
                let handle = app.handle().clone();
                github::hold_issue_writes_while(Box::new(move |repo| {
                    let Some(kanban) = handle.try_state::<kanban::KanbanStore>() else { return false };
                    let awaiting = kanban.restored_awaiting_pull();
                    !awaiting.is_empty()
                        && handle.try_state::<workspace::WorkspaceStore>().is_some_and(|workspaces| {
                            github_sync::restored_board_holds(&awaiting, &workspaces.snapshot().workspaces, repo)
                        })
                }));
            }
            // Try it (TI-2): a removal of a card's copy stops its Try sessions.
            try_session::install(app.handle());
            cli_fresh::install(app.handle());
            // 1.176.1: a tool that changed under the person is said once.
            cli_seen::install(app.handle(), config_dir.clone());
            // 1.176.0 R5: the automatic Codex update, only while Codex is idle.
            codex_auto_update::start(app.handle().clone());
            // A card worktree's port block for every spawn there
            // (`worktree_ports`), read from — and handed out on — the boards.
            {
                let handle = app.handle().clone();
                worktree_ports::install_resolver(std::sync::Arc::new(move |cwd: &std::path::Path| {
                    let found = handle.try_state::<kanban::KanbanStore>()?.port_base_for_cwd(cwd)?;
                    // Handed out just now: the card on screen shows it.
                    if found.wrote {
                        kanban::emit_kanban_changed(&handle, &found.workspace_id);
                    }
                    Some(found.base)
                }));
                // 1.173.0 A3: a copy's folder gets a block of its own, and
                // no card is handed a block a copy holds.
                let handle = app.handle().clone();
                worktree_ports::install_resolver(std::sync::Arc::new(move |cwd: &std::path::Path| {
                    copies::port_base_for_cwd(&handle, cwd)
                }));
                let handle = app.handle().clone();
                worktree_ports::install_holder(std::sync::Arc::new(move || {
                    match handle.try_state::<project_config::ProjectConfigStore>() {
                        Some(configs) => copies::held_port_bases(configs.root(), None),
                        None => Default::default(),
                    }
                }));
            }

            // v1.65.0 (UX revamp step 1 — Inbox): per-user seen store (the
            // only new persisted JSON; atomic writes, self-pruning) + the
            // in-memory PR cache. The feed itself is a pure derivation —
            // see inbox.rs.
            let seen_store = inbox::SeenStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(seen_store);
            app.manage(inbox::InboxState::default());

            // Launch G1–G3: the one place every plan gate asks. It reads the
            // Plyloft account, the team settings and the team store at each
            // gate; a stored PLY1 key (license.json) is only reported.
            app.manage(license::LicenseStore::for_app(config_dir.clone(), app.handle().clone()));
            // Launch G3 (Challenger P3-7): once, a stored key's team becomes
            // the setting when none is set; then the key stays inert.
            let _ = license::adopt_key_team_once(
                &config_dir,
                &app.state::<settings::SettingsStore>(),
                &app.state::<license::LicenseStore>(),
            );
            // Launch A1: the Plyloft account (GitHub sign-in, PLY2
            // entitlement). A missing or corrupt account.json degrades to
            // signed out; the session token is in the OS keychain.
            app.manage(account::AccountStore::new(config_dir.clone()));

            // v1.114.0 (team sharing rung 1): where this Mac keeps the team
            // repo it was pointed at by the key (`<config>/team/<slug>/`).
            // Cloned on demand from Settings → Team; never a workspace.
            app.manage(team::TeamStore::new(config_dir.clone()));

            // v1.116.0 (rung 3): a Codex team-skills overlay is removed when
            // its session ends, so anything still here belongs to a run that
            // was killed rather than closed.
            codex_home::sweep(
                &codex_home::overlays_root(&config_dir),
                &codex_home::recovered_root(&config_dir),
            );
            // Where the Windows link-capability probe links into, for the
            // Library's and the doctor's "would Codex get these" answer.
            codex_home::init(&codex_home::overlays_root(&config_dir));

            // v1.7.0: intake agent state — IntakeStore (system-prompt
            // override + drafts dir bookkeeping) and IntakeRegistry
            // (in-memory `card_id → pty_id` mapping for active sessions).
            let intake_store = intake::IntakeStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(intake_store);
            app.manage(intake::IntakeRegistry::default());
            app.manage(builder::BuilderRegistry::default());
            // N18: the trash pass also sweeps card branches, which reads the
            // board and the Builder sessions: started once both are managed.
            build_cache::spawn_trash_gc(app.handle().clone());

            let prompts_store = prompts::PromptsStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(prompts_store);

            let templates_store = templates::TemplatesStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(templates_store);

            // v1.35.0: persistent, outcome-anchored memory layer. Per-workspace +
            // opt-in global; markdown + YAML frontmatter. CRUD in v1.35.0,
            // dispatch-time injection in v1.36.0, post-ship suggester in v1.37.0.
            let memory_store = memory::MemoryStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(memory_store);

            // v1.68.0 (UX revamp step 3b — Knowledge merge): one-time,
            // sentinel-guarded, NON-DESTRUCTIVE migration of personal
            // prompts + per-card knowledge into the unified Knowledge
            // store (the extended memory store). Best-effort — a failure
            // never blocks startup; the de-dupe makes re-runs harmless.
            {
                use tauri::Manager;
                let ws_ids: Vec<String> =
                    cwd_lookup_snapshot.keys().cloned().collect();
                let prompts_state = app.state::<prompts::PromptsStore>();
                let memory_state = app.state::<memory::MemoryStore>();
                let kanban_state = app.state::<kanban::KanbanStore>();
                knowledge_migrate::run_once(
                    &config_dir,
                    &ws_ids,
                    &prompts_state,
                    &memory_state,
                    &kanban_state,
                );
            }

            // v1.25.0 (Cycle G2): cross-artifact history search registry.
            // Rooted at config_dir so it knows where to spawn ripgrep
            // against the on-disk artifact layout. Single in-flight
            // session globally — `Cmd-Shift-H` modal is one-at-a-time.
            app.manage(history_search::HistorySearchRegistry::new(
                config_dir.clone(),
            ));

            // v1.2.0: custom swarm templates + per-workspace role bindings.
            // Both stores are additive — T1 just constructs and manages them;
            // T3+T5 wire them into the orchestrator.
            let swarm_templates_store =
                swarm_templates::SwarmTemplatesStore::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(swarm_templates_store);

            let role_bindings_store =
                swarm_templates::RoleBindingsStore::new(config_dir.clone())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(role_bindings_store);

            // v1.9.0 (Phase A): per-card ship pipeline state. The
            // registry only holds the concurrent-ship lock — actual ship
            // work happens inline in the `ship_card` IPC handler.
            app.manage(ship::ShipRegistry::default());

            // v1.9.x (Phase A.5): drain coordinator. While draining,
            // swarm/intake/agent-run/verify dispatches are blocked. The
            // frontend orchestrates the polling + 10s grace window.
            app.manage(drain::DrainCoordinator::default());

            // v1.10.x (Phase B): verify pipeline registry. Holds the
            // single-active-verify queue and per-card recent results.
            app.manage(verify::VerifyRegistry::default());
            // GH #62: the full step logs of each card's last verify run.
            verify_logs::init(&config_dir);

            let snapshots_store = snapshots::SnapshotsStore::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

            // v1.17.0 (Cycle E.5): GC orphaned snapshot dirs at launch.
            // Live runIds = (a) every `<config_dir>/agents/runs/*.json` on
            // disk, plus (b) every `card.run_history[].run_id` and
            // `card.linked_run_id` referenced by any workspace's kanban —
            // (b) keeps diffs viewable for cards that hold history entries
            // even after `prune_runs` has reaped the underlying agent run
            // record. Best-effort sweep; mirrors `gc_trash`.
            // Phase 2D: retained handoffs are durable receipts for their
            // snapshot manifests. Keep those run directories alive even when
            // the AgentRun and card history have otherwise aged out.
            // 1.175.0: the keep set is `launch_inventory`'s, and nothing is
            // pruned when the boards weren't all read.
            let handoff_run_ids = app
                .try_state::<coordination::CoordinationRegistry>()
                .map(|coordination| coordination.protected_snapshot_run_ids())
                .unwrap_or_default();
            if let Some((snap_kept, snap_deleted)) =
                launch_inventory.sweep_snapshots(&snapshots_store, &config_dir, handoff_run_ids)
            {
                if snap_deleted > 0 {
                    log::info!(
                        "snapshots: gc_orphans pruned {snap_deleted} orphan dir(s); kept {snap_kept}"
                    );
                }
            }
            app.manage(snapshots_store);

            // v1.0: Swarm. Reconcile any swarms left in `Running` state
            // by a previous crash; mirrors the agent registry orphan pass above.
            // Must run after the agent reconcile so swarm runs are already
            // marked killed by the time the swarm flips to Aborted.
            let swarm_registry = swarms::SwarmRegistry::new(config_dir.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            swarm_registry.reconcile_orphans();
            // v1.30.0 (parallel swarms): seed the card-swarm concurrency cap
            // from settings; kept in sync afterward by the settings_set command.
            swarm_registry.set_card_swarm_cap(initial_settings.card_swarm_cap());

            // v1.28.0 (Cycle I-2): GC orphaned swarm dirs at launch. Live
            // swarmIds = every `card.linked_brainstorm_id` + every
            // `card.linked_swarm_id` across every workspace's kanban (including
            // archived / Legacy cards — archive ≠ delete). Adhoc swarms
            // survive regardless via the classifier carveout. Conservative
            // on corrupt state.json (skips, logs warn). Mirrors the snapshots
            // gc_orphans pattern above.
            // 1.175.0: the keep set is `launch_inventory`'s, and nothing is
            // pruned when the boards weren't all read.
            if let Some((swarm_kept, swarm_deleted)) = launch_inventory.sweep_swarms(&swarm_registry) {
                if swarm_deleted > 0 {
                    log::info!(
                        "swarms: gc_orphan_swarm_dirs pruned {swarm_deleted} orphan dir(s); kept {swarm_kept}"
                    );
                }
            }

            swarm_registry.set_app_handle(app.handle().clone());
            app.manage(swarm_registry);

            // v1.1.1: opt-in auto-resume of any Suspended swarms. Runs once
            // at startup, after `reconcile_orphans` has flipped orphan Running
            // swarms to Suspended. All registries `swarm_resume` needs
            // (Agent, Pty, Workspace, Snapshots, Swarm) are now managed.
            // One native notification fires summarizing the count.
            if initial_settings.behavior.auto_resume_suspended {
                use tauri::Manager;
                let suspended_ids: Vec<String> = app
                    .state::<swarms::SwarmRegistry>()
                    .list()
                    .into_iter()
                    .filter(|s| s.status == swarms::SwarmStatus::Suspended)
                    .map(|s| s.id)
                    .collect();
                if !suspended_ids.is_empty() {
                    log::info!(
                        "auto-resume: attempting to resume {} suspended swarm(s)",
                        suspended_ids.len()
                    );
                    let mut succeeded = 0usize;
                    for id in &suspended_ids {
                        match swarms::swarm_resume(&app.handle(), id) {
                            Ok(_) => succeeded += 1,
                            Err(e) => log::warn!("auto-resume: swarm '{id}' failed: {e}"),
                        }
                    }
                    if succeeded > 0 {
                        use tauri_plugin_notification::NotificationExt;
                        let body = if succeeded == 1 {
                            "Auto-resumed 1 suspended swarm".to_string()
                        } else {
                            format!("Auto-resumed {succeeded} suspended swarms")
                        };
                        let _ = app
                            .notification()
                            .builder()
                            .title("Plyloft")
                            .body(body)
                            .show();
                    }
                }
            }

            // v1.30.0 (parallel swarms): startup pump of the card-swarm
            // queue. Gated behind the same opt-in as auto-resume — both
            // fire `claude` PTYs at launch, so a user who declined
            // auto-resume should not get surprise dispatches. Runs after
            // the auto-resume pass so resumed swarms claim their slots first.
            if initial_settings.behavior.auto_resume_suspended {
                for ws_id in cwd_lookup_snapshot.keys() {
                    kanban::pump_card_queue(&app.handle(), ws_id);
                }
            }

            // Tell the watcher which paths to exclude (Atelier's own state)
            if let Some(reg) = app.try_state::<watcher::WatcherRegistry>() {
                reg.add_excluded(config_dir.clone());
                reg.add_excluded(agent_config_dir);
                if let Ok(log_dir) = app.path().app_log_dir() {
                    reg.add_excluded(log_dir);
                }
                reg.set_enabled(initial_settings.behavior.file_watcher_enabled);
            }

            // The runtime tick: swarm wall-time and the App Nap release. GH #171:
            // it no longer fires scheduled agents, and the file-change and
            // agent-finished listeners that fired triggered agents are gone.
            agents::start_runtime_tick(app.handle().clone());

            // Phase 3: retry queued unattended writer intents only after a
            // durable coordination transition releases a worktree.
            writer_queue::start_listener(app.handle().clone());
            card_execution::start_listener(app.handle().clone());

            // v1.0: Swarm. Subscribe to `agent://run-done` and route
            // swarm-spawned runs to the FSM. Must run after the agent registry
            // is registered (above) so `start_run` can find it via app.state.
            swarms::start_swarm_listener(app.handle().clone());

            // v1.17.0 (Cycle E.5): launch the intake idle-sweeper thread.
            // Cancels intakes whose `last_activity_at` is older than
            // `IDLE_INTAKE_TIMEOUT_MS` and whose card has not reached
            // `intake_status == Ready`. 60-min cutoff (v1.20.3); idle
            // is real — both PTY output and user input bump the
            // activity beacon, so an interactive prompt that the user
            // is reading-and-typing on can take as long as needed.
            // v1.20.3: thread the AppHandle in so the sweeper can emit
            // `intake://swept` events for FE banner UX.
            // GH #124: a Challenger review that was waiting on one this
            // restart ended starts now, as a sweep or a follow-up by the
            // card's ledger.
            {
                let reviews_app = app.handle().clone();
                std::thread::spawn(move || {
                    builder::start_waiting_reviews(&reviews_app);
                    // SL-6: a comparison that was due when Plyloft quit.
                    build_both::compare_due_at_launch(&reviews_app);
                    // Windows walk 2026-10-20: a card copy a Ship had to keep
                    // (a program had it open) goes now that nothing does.
                    kept_copy::retry_all_at_launch(&reviews_app);
                });
            }

            {
                let sweeper_app = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(
                        intake::INTAKE_SWEEPER_TICK_SECS,
                    ));
                    use tauri::Manager;
                    let kanban_state = match sweeper_app.try_state::<kanban::KanbanStore>() {
                        Some(s) => s,
                        None => continue,
                    };
                    let intake_store = match sweeper_app.try_state::<intake::IntakeStore>() {
                        Some(s) => s,
                        None => continue,
                    };
                    let pty_state = match sweeper_app.try_state::<pty::PtyRegistry>() {
                        Some(s) => s,
                        None => continue,
                    };
                    let intake_state =
                        match sweeper_app.try_state::<intake::IntakeRegistry>() {
                            Some(s) => s,
                            None => continue,
                        };
                    intake::idle_sweeper_tick(
                        &sweeper_app,
                        &kanban_state,
                        &intake_store,
                        &pty_state,
                        &intake_state,
                    );
                });
            }

            // SL-1 (ship loop): read the open pull requests Plyloft opened
            // back from GitHub — 60 s while checks run, 10 min otherwise.
            // Stopped on exit (`pr_status::stop_poller` below).
            pr_status::start_poller(app.handle().clone());
            // Challenger on a pull request: its own poller (P3-4).
            pr_review::start_poller(app.handle().clone());
            // Skills hub H2 (R1): the team library, pulled in the background —
            // a little after launch, then every 10 minutes and on wake.
            // Stopped on exit (`skills_hub::stop` above).
            skills_hub::start(app.handle().clone());

            // Launch A1: refresh the plan at launch and every 6 h. Stopped
            // on exit (`AccountStore::stop` below).
            account::start_refresher(app.handle().clone());

            // Windows (W4): the tray icon is the way back to a closed window
            // and the way to quit; the web view loses its browser keys.
            #[cfg(windows)]
            {
                if let Err(error) = windows_shell::install_tray(app.handle()) {
                    log::warn!("tray icon unavailable: {error}");
                }
                if let Some(window) = app.get_webview_window("main") {
                    windows_shell::disable_browser_accelerators(&window);
                }
            }

            // SL-0: the dev-only test bridge (refuses the real identifier).
            #[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
            test_bridge::start(app.handle());

            // H1 (1.173.0): the window's heartbeat and the main thread are
            // watched; the previous run's marker is read off this thread.
            watchdog::start(app.handle());

            log::info!("startup: setup took {} ms", setup_started.elapsed().as_millis());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_quit,
            quit_listening,
            quit_not_listening,
            quit_ack,
            quit_answer,
            window_set_attention,
            window_close_listening,
            window_close_not_listening,
            window_close_ack,
            window_close_answer,
            commands::shell_env_info,
            commands::shell_env_retry,
            cli_fresh::cli_fresh_check,
            cli_seen::cli_seen_take,
            cli_fresh::cli_start_verdict,
            setup_run::setup_run,
            setup_run::setup_stop,
            setup_run::setup_active,
            setup_run::setup_check,
            setup_run::setup_reach,
            setup_run::setup_open_page,
            setup_last_run::setup_last_run,
            project_setup::project_inspect,
            project_setup::projects_folder_look,
            project_setup::projects_folder_create,
            project_setup::project_init,
            project_setup::project_inspect_work,
            project_setup::project_save_work,
            project_setup::project_unsaved_files,
            project_setup::project_work_ignore_plan,
            project_setup::project_ignore_plan,
            project_setup::project_new_preview,
            project_setup::project_new,
            project_setup::project_repo_list,
            project_setup::project_clone,
            project_setup::project_first_commit_push,
            project_setup_config::project_detect_for_setup,
            project_setup_config::project_local_origin,
            commands::workspace_set_github_account,
            commands::workspace_set_merge_when_checks_pass,
            commands::workspace_set_ship_via,
            commands::workspace_mark_ship_notice_seen,
            commands::workspace_ship_offers_pr,
            commands::workspace_set_delete_card_branches,
            commands::workspace_set_dont_work_here,
            commands::workspace_set_default_area,
            commands::workspace_dismiss_area_notice,
            area_discovery::areas_discover,
            branch_cleanup::branch_cleanup_pending,
            branch_cleanup::branch_cleanup_answer,
            branch_cleanup::branch_backlog_answer,
            commands::workspace_set_list_grouping,
            commands::workspace_set_models,
            github_account::github_account_workspaces,
            setup_identity::setup_identity_prefill,
            setup_identity::setup_identity_write,
            setup_identity::setup_open_git_downloads,
            setup_github::setup_github_status,
            setup_github::setup_open_github_sso,
            // OB-10: Setup's Team step — join (detected, invite code), the
            // team workspace invitations, Copy invite.
            team_join::team_join_detect,
            setup_team_hint::setup_team_hint,
            team_join::team_join_preview,
            team_join::team_join_confirm,
            team_join::team_join_workspace_invites,
            team_join::team_join_accept_workspaces,
            team_join::team_invite_code,
            commands::dependency_doctor,
            commands::build_cache_status,
            commands::build_cache_clear,
            // GH #215: Diagnostics' Un-ignore on a gitignored skill root —
            // the plan the confirmation shows, then the confirmed append.
            skill_root_ignore::skill_root_ignore_plan,
            skill_root_ignore::skill_root_ignore_fix,
            commands::microphone_request_access,
            legacy_install::legacy_install_probe,
            legacy_install::legacy_install_remove,
            commands::microphone_open_settings,
            commands::open_web_link,
            commands::open_support_mail,
            commands::terminal_conversations,
            commands::terminal_tile_auto_name,
            commands::terminal_tile_name_passed,
            commands::terminal_resume_check,
            commands::terminal_sessions_history_all,
            commands::terminal_reopen_offers,
            commands::terminal_reopen_dismiss,
            commands::terminal_link_target,
            commands::terminal_tile_title,
            commands::terminal_tile_rename,
            commands::tile_screen_block,
            commands::dictation_status,
            commands::dictation_transcribe,
            commands::dictation_cancel,
            commands::dictation_model_download,
            commands::dictation_model_download_cancel,
            commands::pty_prompt_idle,
            commands::clipboard_read_text,
            commands::pty_prompt_state,
            commands::reviewer_capability_probe,
            commands::reviewer_run,
            commands::reviewer_list,
            commands::discussion_prepare,
            commands::discussion_launch,
            commands::discussion_list,
            commands::discussion_resume,
            commands::discussion_retry,
            commands::discussion_abort,
            // GH #101 — Library › Instructions (BOARDS.md §5). The Phase 1C
            // panel's two commands are gone with it: `set_up` is the one entry
            // point, and it decides whether the step publishes or writes.
            commands::library_instructions_view,
            commands::library_instructions_set_up,
            commands::personal_instruction_reveal,
            // GH #174: `On this Mac`'s `›`, read-only in Code.
            commands::personal_instruction_read,
            chat::chat_open,
            chat::chat_messages,
            chat::chat_send,
            chat::chat_interrupt,
            chat::chat_screen,
            chat::chat_close,
            chat::chat_attachment_add,
            chat::chat_attachment_list,
            chat::chat_attachment_remove,
            compare::compare_tile_answer,
            compare::compare_prepare_paste,
            plan_exchange::plan_exchange_start,
            plan_exchange::plan_exchange_get,
            plan_exchange::plan_exchange_stop,
            plan_exchange::plan_exchange_retry,
            plan_exchange::plan_exchange_more,
            plan_exchange::plan_exchange_accept,
            plan_exchange::plan_exchange_discard,
            plan_exchange::plan_exchange_screen,
            plan_exchange::plan_exchange_open_cards,
            codex_app::codex_app_start,
            codex_app::codex_app_write,
            codex_app::codex_app_stop,
            codex_app::codex_approval_list,
            codex_app::codex_approval_add,
            codex_app::codex_approval_matches,
            codex_app::codex_approval_remove,
            commands::coordination_status,
            commands::coordination_handoff_recent,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_session_lightness,
            commands::pty_console_host,
            commands::stop_card_try_sessions,
            commands::try_cmd_shims_available,
            commands::try_folder_exists,
            commands::try_copy_needs_packages,
            commands::try_package_script,
            commands::pty_command_running,
            commands::pty_shell_alone,
            commands::try_open_index_html,
            commands::try_install_packages_once,
            commands::try_install_packages_in_project,
            commands::try_project_needs_packages,
            commands::try_project_has_commit,
            commands::workspace_list,
            commands::onboarding_take_welcome,
            commands::workspace_create,
            commands::workspace_delete,
            commands::workspace_set_active,
            commands::workspace_rename,
            commands::workspace_cwd_exists,
            commands::workspace_set_files,
            commands::workspace_set_accent_color,
            commands::workspace_set_layout_preset,
            commands::workspace_set_icon,
            commands::workspace_set_icon_image,
            commands::fs_list_dir,
            commands::fs_list_files_recursive,
            commands::fs_read_text_file,
            commands::fs_write_text_file,
            commands::fs_save_dropped_file,
            commands::fs_watch_workspace,
            commands::claude_review_trust_status,
            commands::fs_unwatch_workspace,
            commands::fs_ignored_paths,
            commands::search_start,
            commands::search_cancel,
            commands::history_search_start,
            commands::history_search_cancel,
            commands::ripgrep_available,
            commands::settings_get,
            model_catalog::model_catalog_get,
            team_models::team_models_get,
            areas::areas_get,
            areas::areas_check,
            areas::areas_save_local,
            areas::areas_answer_set_aside,
            areas::release_kind_set,
            stop_sharing::workspace_stop_sharing,
            stop_sharing::workspace_keep_setup_local,
            move_shared_setup::workspace_move_shared_setup,
            put_on_github::put_on_github_preview,
            put_on_github::put_on_github,
            put_on_github::put_on_github_send_again,
            put_on_github::put_on_github_stop,
            put_on_github::put_on_github_sent,
            cli_health::cli_health,
            cli_repair_run::cli_repair_plan,
            cli_repair_run::cli_repair_run,
            cli_repair_run::cli_repair_in_use,
            cli_repair_run::cli_repair_report,
            move_shared_setup::workspace_use_team_values,
            workspace_adoption::workspace_propose_conversion_again,
            workspace_adoption::workspace_conversion_notice_seen,
            next_improvement::ni_direction_get,
            next_improvement::round::ni_round_start,
            next_improvement::round::ni_round_change,
            next_improvement::round::ni_round_stop,
            next_improvement::round::ni_round_get,
            next_improvement::round::ni_round_mark,
            next_improvement::ni_direction_save,
            next_improvement::ni_reject,
            next_improvement::ni_unreject,
            next_improvement::ni_direction_notice_seen,
            next_improvement::ni_direction_project,
            next_improvement::ni_direction_adopt_project,
            retry_on::card_retry_plan,
            commands::settings_set,
            settings_reset::settings_reset,
            commands::identity_get,
            commands::installed_self_check_intake_authority,
            commands::installed_self_check_write_report,
            commands::reveal_log_dir,
            watchdog::watchdog_beat,
            watchdog::watchdog_status,
            program_folders::program_folders_check,
            setting_check::setting_check,
            commands::files_order_get,
            commands::files_order_set,
            commands::files_order_clear,
            commands::agent_list,
            commands::agent_get,
            commands::agent_run_start,
            commands::agent_run_request,
            commands::agent_run_queue,
            commands::agent_run_list,
            commands::agent_run_get,
            commands::agent_run_kill,
            commands::agent_transcript_read,
            commands::probe_localhost_ports,
            commands::probe_ports,
            commands::notification_send_test,
            commands::notification_access,
            commands::notification_request_access,
            commands::notification_open_settings,
            commands::kanban_load,
            commands::kanban_card_create,
            commands::kanban_card_delete,
            commands::kanban_card_worktree_state,
            commands::kanban_card_delete_github,
            commands::kanban_card_patch,
            commands::kanban_card_set_run_state,
            commands::kanban_github_reconcile,
            commands::kanban_github_refresh,
            commands::kanban_card_claim,
            commands::github_current_login,
            commands::kanban_card_claim_state,
            commands::kanban_card_device_claim,
            commands::kanban_card_device_release,
            pr_links::kanban_card_linked_pull_requests,
            pr_links::kanban_open_pr_links,
            worktree_setup::project_folder_check,
            checks_consent::checks_consent_view,
            checks_consent::checks_allow_and_run,
            checks_consent::install_allow_and_run,
            commands::kanban_card_use_issue_remainder,
            commands::codeowners_check,
            commands::account_get,
            commands::account_dev_skip_sign_in,
            commands::account_sign_in_start,
            commands::account_sign_in_cancel,
            commands::account_refresh,
            commands::account_use_team,
            commands::account_sign_out,
            commands::license_get,
            commands::plan_gates_get,
            #[cfg(debug_assertions)]
            commands::account_dev_load_entitlement,
            commands::team_status,
            commands::team_refresh,
            commands::team_work_mode,
            commands::team_workspace_add,
            commands::team_library_reapply,
            commands::team_library_undo_resolve,
            commands::team_library_move_aside,
            commands::team_library_reveal_aside,
            commands::team_library_reveal,
            commands::team_create_defaults,
            commands::team_create,
            commands::team_leave,
            team_leave_seat::team_leave_seat,
            team_leave_seat::seat_give_up,
            commands::team_invite_plan,
            commands::team_invite_apply,
            commands::team_member_states,
            commands::team_member_remove,
            commands::team_billing_get,
            commands::account_checkout,
            commands::account_portal,
            commands::team_checkout_wait,
            commands::team_checkout_wait_cancel,
            commands::account_sign_out_others,
            commands::team_bind_current,
            commands::team_seat_free,
            commands::team_seat_give,
            commands::team_member_ids,
            commands::team_discover,
            commands::team_discovery_ignore,
            commands::team_discovery_clear_ignored,
            commands::team_workspace_list_add,
            commands::team_workspace_list_remove,
            commands::project_skills_view,
            commands::skill_tree_digests,
            commands::project_skill_create,
            commands::personal_skills_view,
            commands::ply_skills_view,
            commands::ply_skill_ipc::ply_skill_setting,
            commands::ply_skill_ipc::ply_skill_personalize,
            commands::personal_skill_reveal,
            commands::skill_history,
            commands::personal_skill_promote,
            commands::personal_skill_share_preview,
            commands::project_skill_promote,
            commands::skills_hub_install,
            commands::skills_hub_update,
            commands::skills_hub_card_refresh,
            commands::skills_hub_card_behind,
            commands::skills_hub_links,
            commands::skills_hub_compare,
            commands::skills_hub_link,
            commands::skills_hub_decisions::skills_hub_compare3,
            commands::skills_hub_decisions::skills_hub_keep_mine,
            commands::skills_hub_decisions::skills_hub_propose_upstream,
            commands::skills_hub_decisions::skills_hub_removed_choice,
            commands::skills_hub_decisions::skills_hub_renamed_choice,
            commands::skills_hub_twins::skills_hub_align,
            commands::skills_hub_carry::skills_hub_carry,
            commands::skills_hub_copy::skills_hub_copy_targets,
            commands::skills_hub_copy::skills_hub_copy_review,
            commands::skills_hub_copy::skills_hub_copy_to,
            commands::team_skill_remove,
            commands::card_overlap_check,
            commands::inbox_feed,
            commands::inbox_mark_seen,
            commands::inbox_mark_all_seen,
            commands::activity_feed,
            commands::workspace_set_kanban_sync_mode,
            commands::kanban_github_push_local,
            commands::kanban_get_card,
            commands::kanban_clear_run_history,
            commands::kanban_card_advance_to_in_progress,
            commands::kanban_card_archive,
            commands::kanban_card_put_back,
            issue_edit::card_edit_conflict_resolve,
            issue_text::card_issue_problem,
            fix_round::card_fix_round_check_set,
            fix_round::card_fix_round_self_checks_set,
            fix_round::card_fix_round_changed,
            leave_issue::card_name_off_outcome,
            unreadable_notices::board_unreadable_notice,
            unreadable_notices::board_unreadable_notices,
            unreadable_notices::board_unreadable_said,
            unreadable_notices::board_unreadable_reveal,
            unreadable_notices::project_list_notice,
            unreadable_notices::project_list_trouble,
            unreadable_notices::project_list_notice_reveal,
            commands::kanban_card_set_board_order,
            commands::kanban_card_set_blocked_by,
            commands::kanban_card_follow_up,
            commands::kanban_card_set_builder_vendor_pref,
            commands::kanban_card_set_builder_permissions,
            commands::kanban_card_set_models,
            commands::card_line_comment_add,
            commands::card_line_comment_update,
            commands::card_line_comment_remove,
            commands::card_line_comments_mark_sent,
            commands::kanban_card_add_later_request,
            commands::kanban_card_remove_later_request,
            commands::kanban_card_restore,
            commands::kanban_card_fork_to_implementation,
            commands::worktree_reveal,
            commands::fs_reveal_in_workspace,
            commands::fs_create_file,
            commands::fs_create_dir,
            commands::fs_rename_entry,
            commands::fs_trash_entry,
            commands::fs_undo_trash,
            commands::fs_reveal_entry,
            commands::fs_open_dropped,
            commands::fs_copy_into_workspace,
            commands::worktree_kept_list,
            commands::worktree_kept_delete,
            commands::worktree_list,
            commands::worktree_delete,
            // 1.173.0 A2: copies without a card.
            commands::copy_create,
            commands::copy_list,
            commands::copy_throw_away,
            commands::copy_restore,
            commands::copy_setup_retry,
            commands::copy_start_point,
            commands::copy_make_card,
            commands::copy_open_pr,
            commands::copy_refresh_prs,
            commands::card_copy_changes,
            // GH #102: `Move the local copy to Trash` on the fast-forward
            // refusal. An app command, so it needs no plugin capability of
            // its own; the Trash is reached through Foundation, not the fs
            // plugin (src-tauri/capabilities/default.json is unchanged).
            commands::worktree_trash_untracked,
            commands::card_review_diff,
            shipped_changes::card_shipped_changes,
            commands::card_review_merge,
            commands::card_review_request_changes,
            commands::card_review_followup_message,
            commands::card_outcome,
            commands::card_review_tip,
            commands::card_local_base_commits,
            commands::card_ship_preflight,
            commands::project_folder_changes_detail,
            commands::project_folder_bring_up_to_date,
            commands::card_ship,
            commands::card_pr_commands::card_pr_refresh,
            commands::card_pr_commands::pr_read_signed_out_again,
            commands::card_pr_commands::quit_plyloft_merges,
            commands::card_pr_commands::card_pr_merge,
            commands::card_pr_commands::card_bring_up_to_date,
            commands::card_pr_commands::card_pr_set_auto_merge,
            commands::card_pr_commands::card_pr_fix_message,
            commands::card_pr_commands::card_ship_conflict_start,
            commands::card_pr_commands::card_ship_conflict_undo,
            commands::card_pr_commands::cards_target_sync,
            commands::card_pr_commands::card_bring_in_target,
            card_area::card_area_state,
            deploy_map::deploy_map_get,
            deploy_map::deploy_what_changes,
            card_area::kanban_card_set_area,
            card_area::card_outside_files,
            card_area::card_leave_out_files,
            commands::card_pr_commands::card_pr_push_update,
            commands::card_pr_commands::card_pr_draft_prepare,
            commands::card_pr_commands::card_pr_draft_read,
            commands::card_pr_commands::card_pr_draft_save,
            commands::card_pr_commands::workspace_fix_failing_checks_offered,
            commands::card_pr_commands::card_pr_draft_forget,
            commands::card_pr_commands::card_pr_text,
            commands::card_pr_commands::card_pr_edit,
            commands::card_pr_commands::card_set_pr_auto_fix,
            commands::card_pr_commands::card_pr_auto_fix_begin,
            commands::card_pr_commands::card_pr_auto_fix_stop,
            commands::card_pr_commands::workspace_set_fix_failing_checks,
            commands::pr_review_list,
            commands::pr_review_create,
            commands::pr_review_refresh,
            commands::pr_review_start,
            commands::pr_review_merge_head,
            commands::card_ship_with_follow_up,
            commands::project_config_get,
            commands::workspace_definition_refresh,
            commands::workspace_definition_get,
            commands::workspace_definition_resolve_conflict,
            commands::workspace_definition_save,
            commands::workspace_definition_branches,
            commands::workspace_definition_publish,
            commands::workspace_adoption_status,
            commands::workspace_adoption_share,
            commands::workspace_adoption_decline,
            commands::workspace_adoption_board_choice,
            commands::workspace_adoption_setup_elsewhere,
            commands::workspace_definition_open_pull_request,
            commands::project_config_list,
            commands::project_config_detect,
            commands::project_config_set,
            commands::project_try_command_get,
            commands::project_try_command_save,
            commands::project_try_command_approve,
            commands::project_config_set_review,
            commands::project_review_get,
            commands::project_config_delete,
            commands::project_config_list_templates,
            commands::project_config_apply_template,
            commands::kanban_attachment_add_from_bytes,
            commands::kanban_attachment_add_from_path,
            commands::kanban_attachment_remove,
            commands::kanban_attachment_reveal,
            commands::kanban_attachment_open,
            commands::kanban_attachment_gc_card,
            commands::kanban_swarm_gc_card,
            commands::ship_audit,
            commands::areas_releases,
            commands::ship_card,
            commands::ship_pending_count,
            commands::ship_pending_cards,
            release_scope::release_scope,
            release_scope::release_scopes,
            commands::ship_batch,
            commands::release_area,
            commands::release_stop,
            commands::ship_pending_release,
            commands::ship_pending_release_dismiss,
            commands::ship_pending_release_undo,
            commands::ship_release_update,
            commands::ship_release_install,
            commands::ship_unverified_count,
            commands::drain_status,
            commands::drain_start,
            commands::drain_cancel,
            commands::verify_start,
            commands::verify_status,
            commands::verify_list_inflight,
            commands::verify_reveal_log,
            commands::prompts_list,
            commands::prompts_create,
            commands::prompts_update,
            commands::prompts_delete,
            commands::prompts_promote,
            commands::prompts_demote,
            commands::prompts_fork,
            commands::memory_list,
            commands::memory_get,
            commands::memory_create,
            commands::memory_update,
            commands::memory_delete,
            commands::memory_search,
            commands::knowledge_list_project,
            commands::knowledge_promote_project,
            commands::knowledge_demote_project,
            commands::knowledge_fork_project,
            commands::knowledge_project_state,
            commands::knowledge_project_save,
            commands::knowledge_project_delete,
            commands::project_skill_publish,
            commands::project_skill_publish_review,
            commands::project_skill_unpublish,
            commands::project_skill_unpublish_undo,
            // GH #105: skills available to both CLIs, kept aligned.
            commands::project_skills_available_to_both,
            commands::project_skill_align,
            // GH #104 (ADR 0005): the Challenger's improvement proposal.
            commands::improvement_proposal_state,
            commands::improvement_proposal_trust_stopped,
            commands::improvement_proposal_dismiss,
            commands::improvement_proposal_approve,
            commands::builder_note_correction,
            commands::knowledge_list_team,
            commands::knowledge_promote_team,
            commands::knowledge_demote_team,
            commands::knowledge_fork_team,
            commands::card_compose_dispatch_prompt,
            commands::templates_list,
            commands::templates_create,
            commands::templates_update,
            commands::templates_delete,
            commands::templates_promote,
            commands::templates_demote,
            commands::templates_fork,
            commands::snapshot_get_changes,
            commands::shell_integration_script,
            commands::swarm_start,
            commands::swarm_get,
            commands::swarm_list,
            commands::swarm_abort,
            commands::swarm_card_slot_status,
            commands::swarm_instance_abort,
            commands::agent_run_export,
            commands::swarm_export,
            commands::swarm_mailbox_read,
            commands::swarm_resume,
            commands::swarm_templates_list,
            commands::swarm_templates_get,
            commands::swarm_template_unbound_roles,
            commands::intake_start,
            commands::intake_conclude,
            commands::intake_cancel,
            commands::intake_read_draft,
            commands::intake_apply,
            commands::intake_read_transcript,
            commands::builder_start,
            commands::builder_resume,
            commands::worktree_settings_get,
            commands::worktree_settings_set,
            commands::worktree_env_proposal,
            commands::worktree_env_proposal_answer,
            commands::card_worktree_setup_retry,
            commands::card_worktree_setup_skip,
            commands::builder_done,
            commands::builder_self_check_message,
            commands::builder_accept_pushback,
            // Findings filter: the threshold and "Not a real issue".
            commands::project_config_set_blocking_findings,
            commands::review_finding_dismiss,
            commands::builder_review_again,
            commands::builder_review_retry,
            commands::builder_verdict_delivered,
            commands::builder_close,
            commands::builder_session_ended,
            commands::session_skill_drift,
            commands::skills_hub_scripts_review,
            commands::skills_hub_approve,
            commands::skills_hub_install_review,
            skills_hub::skills_hub_library_status,
            skills_hub::skills_hub_library_switch,
            skills_hub::skills_hub_keep_last_copy,
            my_library::my_library_status,
            my_library::my_library_find,
            my_library::my_library_create,
            my_library::my_library_use,
            my_library::my_library_forget,
            my_library::my_library_recreate,
            my_library::my_library_pull_now,
            my_library::my_library_publish,
            skills_index::skills_hub_index,
            skills_index::skills_hub_index_refresh,
            commands::builder_read_capture,
            commands::build_both_start,
            commands::build_both_start_lanes,
            commands::build_both_lane_resume,
            commands::build_both_lane_start_fresh,
            commands::build_both_lane_done,
            commands::build_both_lane_stop,
            commands::build_both_compare_again,
            commands::build_both_pick,
            commands::build_both_lane_diff,
            commands::build_both_stop,
            commands::builder_last_output_at,
            commands::builder_session_blocks,
            builder_screens::builder_session_screens,
            commands::intake_ended_cards,
            commands::card_plan_challenge_set,
            commands::card_plan_challenge_clear,
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => match window.label() {
                "main" => {
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    let _ = window.app_handle().save_window_state(StateFlags::all());
                    // Windows: by `behavior.windowsCloseAction` — ask in
                    // Ply's sheet, hide to the tray (minimized if the tray
                    // failed to install) or quit. The Mac hides, always.
                    #[cfg(windows)]
                    windows_close_main(window.app_handle());
                    #[cfg(not(windows))]
                    {
                        let _ = window.hide();
                        // H1: a hidden page beats every 30 s; no silence.
                        watchdog::window_shown(false);
                    }
                    api.prevent_close();
                }
                // v1.73.0 (step 5b-3): the settings window is gone.
                _ => {}
            },
            // Launch A3: a plan bought on the site shows up on return — the
            // main window coming to the front asks the server again, at most
            // once a minute (the throttle is the account store's).
            WindowEvent::Focused(true) if window.label() == "main" => {
                // H1: on screen again — its silence counts from now.
                watchdog::window_shown(true);
                account::refresh_on_focus(window.app_handle());
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) => {
                let payload = WindowDropEvent {
                    paths: paths.iter().map(|p| p.to_string_lossy().to_string()).collect(),
                    position: (position.x, position.y),
                    window_label: window.label().to_string(),
                };
                let _ = window.app_handle().emit("window://drop", payload);
            }
            _ => {}
        })
        .build(context)
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // Hard Rule #4, on every way out. `app.exit` (Plyloft › Quit and
        // Cmd-Q since S1-2, the tray, Windows' keyboard quit, the close
        // sheet — each after the quit guard) raises `ExitRequested`; a quit
        // macOS starts itself (the Dock's Quit, logging out) is
        // `-[NSApp terminate:]`, which tao turns into `LoopDestroyed` —
        // `RunEvent::Exit` only, never `ExitRequested`. Both run the same
        // cleanup, once (`exit_cleanup::begin`).
        RunEvent::ExitRequested { .. } => run_exit_cleanup(app_handle, "quit requested"),
        RunEvent::Exit => run_exit_cleanup(app_handle, "the app is exiting"),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod team_gate_fixture_tests {
    use std::path::Path;
    use std::process::Command;

    /// The bash Ply runs scripts with (`shell_env::bash_program`): on Windows
    /// Git Bash, never System32's WSL launcher.
    fn bash() -> Command {
        let path = std::env::var("PATH").unwrap_or_default();
        crate::platform::new_command(crate::shell_env::bash_program(&path).expect("a bash (Git Bash on Windows)"))
    }

    /// Whether the renderers' `jq` is on the PATH of the bash that runs them.
    fn has_jq() -> bool {
        bash()
            .args(["-c", "command -v jq"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn t1_fixture_renders_through_production_decoders() {
        if !has_jq() {
            crate::test_env::skip("jq is not on PATH; the fixture renderer needs it");
            return;
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = temp.path().join("fixture");
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root");
        let renderer = repo_root.join("scripts/prepare-team-gate-t1-fixture.sh");

        let rendered = bash()
            .arg(&renderer)
            .arg("--render-only")
            .arg(&fixture)
            .output()
            .expect("run fixture renderer");
        assert!(
            rendered.status.success(),
            "renderer failed: {}",
            String::from_utf8_lossy(&rendered.stderr)
        );

        let workspace: crate::workspace::WorkspaceDefault = serde_json::from_slice(
            &std::fs::read(fixture.join(".atelier/workspace_default.json"))
                .expect("workspace default"),
        )
        .expect("decode WorkspaceDefault");
        assert_eq!(workspace.name, "Ply Team Gate T-1");
        assert_eq!(
            workspace.github_owner_repo.as_deref(),
            Some("MatteoB-adv/ply-team-gate-t1-fixture")
        );
        assert_eq!(
            workspace.kanban_sync_mode,
            crate::workspace::KanbanSyncMode::Local
        );

        let prompts: crate::prompts::PromptsFile = serde_json::from_slice(
            &std::fs::read(fixture.join(".atelier/library/prompts.json"))
                .expect("shared prompts"),
        )
        .expect("decode PromptsFile");
        assert_eq!(prompts.version, 1);
        assert_eq!(prompts.prompts.len(), 1);
        assert_eq!(prompts.prompts[0].id, "t1-shared-prompt");

        let templates: crate::templates::TemplatesFile = serde_json::from_slice(
            &std::fs::read(fixture.join(".atelier/library/templates.json"))
                .expect("shared templates"),
        )
        .expect("decode TemplatesFile");
        assert_eq!(templates.version, 1);
        assert_eq!(templates.templates.len(), 1);
        assert_eq!(
            templates.templates[0].id,
            "t1-shared-workspace-template"
        );

        let swarm_templates: crate::swarm_templates::SwarmTemplatesFile =
            serde_json::from_slice(
                &std::fs::read(fixture.join(".atelier/library/swarm_templates.json"))
                    .expect("shared swarm templates"),
            )
            .expect("decode SwarmTemplatesFile");
        assert_eq!(swarm_templates.version, 1);
        assert_eq!(swarm_templates.templates.len(), 1);
        assert_eq!(
            swarm_templates.templates[0].id,
            "t1-shared-swarm-template"
        );

        let knowledge = ply_memory::read_shared(&fixture).expect("decode shared Knowledge");
        assert_eq!(knowledge.len(), 1);
        assert_eq!(knowledge[0].id, "t1-shared-knowledge");
        assert!(knowledge[0].shared);

        let initialized = crate::platform::git_command()
            .args(["init", "-b", "main"])
            .current_dir(&fixture)
            .output()
            .expect("git init fixture");
        assert!(initialized.status.success(), "git init must pass");
        // Windows runs no script by its shebang: through bash there.
        #[cfg(windows)]
        let mut verify = {
            let mut bash = bash();
            bash.arg("scripts/verify.sh");
            bash
        };
        #[cfg(not(windows))]
        let mut verify = crate::platform::new_command(fixture.join("scripts/verify.sh"));
        let verified = verify
            .current_dir(&fixture)
            .output()
            .expect("run verify fixture");
        assert!(
            verified.status.success(),
            "verify fixture failed: {}",
            String::from_utf8_lossy(&verified.stderr)
        );
        assert!(String::from_utf8_lossy(&verified.stdout)
            .contains("T-1 verify fixture passed"));
    }

    #[test]
    fn t2_fixture_renders_and_drains_through_production_import() {
        if !has_jq() {
            crate::test_env::skip("jq is not on PATH; the fixture renderer needs it");
            return;
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = temp.path().join("fixture");
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root");
        let renderer = repo_root.join("scripts/prepare-team-gate-t2-fixture.sh");

        let rendered = bash()
            .arg(&renderer)
            .arg("--render-only")
            .arg(&fixture)
            .output()
            .expect("run T-2 fixture renderer");
        assert!(
            rendered.status.success(),
            "renderer failed: {}",
            String::from_utf8_lossy(&rendered.stderr)
        );

        let workspace: crate::workspace::WorkspaceDefault = serde_json::from_slice(
            &std::fs::read(fixture.join(".atelier/workspace_default.json"))
                .expect("workspace default"),
        )
        .expect("decode WorkspaceDefault");
        assert_eq!(workspace.name, "Ply Team Gate T-2");
        assert_eq!(
            workspace.kanban_sync_mode,
            crate::workspace::KanbanSyncMode::Local
        );
        assert_eq!(workspace.github_owner_repo, None);

        let knowledge = ply_memory::read_shared(&fixture).expect("decode shared Knowledge");
        assert_eq!(knowledge.len(), 1);
        assert_eq!(knowledge[0].id, "t2-shared-baseline");
        assert!(knowledge[0].shared);

        let config = tempfile::tempdir().expect("config tempdir");
        let store = crate::workspace::WorkspaceStore::new(config.path().to_path_buf())
            .expect("workspace store");
        let queue = config.path().join("pending_imports.json");
        std::fs::write(
            &queue,
            serde_json::to_vec(&vec![fixture.to_string_lossy().to_string()])
                .expect("encode pending queue"),
        )
        .expect("write pending queue");

        assert_eq!(store.import_pending(&queue).expect("drain pending import"), 1);
        assert!(!queue.exists(), "production import drains its queue");
        let snapshot = store.snapshot();
        assert_eq!(snapshot.workspaces.len(), 1);
        let imported = &snapshot.workspaces[0];
        assert_eq!(imported.name, "Ply Team Gate T-2");
        assert_eq!(
            imported.kanban_sync_mode,
            crate::workspace::KanbanSyncMode::Local
        );
        assert_eq!(imported.github_owner_repo, None);
        assert_eq!(
            imported.cwd,
            crate::platform::canonicalize(&fixture)
                .expect("canonical fixture")
                .to_string_lossy()
        );
    }
}

#[cfg(test)]
mod team_gate_ipc_tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::webview::InvokeRequest;

    fn snapshot_files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn visit(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            let mut entries = std::fs::read_dir(path)
                .expect("read snapshot directory")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect snapshot directory");
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                let kind = entry.file_type().expect("snapshot file type");
                if kind.is_dir() {
                    visit(root, &path, out);
                } else if kind.is_file() {
                    out.insert(
                        path.strip_prefix(root).expect("snapshot relative path").into(),
                        std::fs::read(path).expect("snapshot file"),
                    );
                }
            }
        }

        let mut out = BTreeMap::new();
        visit(root, root, &mut out);
        out
    }

    /// Launch G3: a case the team gate refuses gets the gate's words for that
    /// case; the matching Team plan goes past the gate to the command's own
    /// next step, whose exact answer is `free_answer` (the fixture's missing
    /// ids, the unarmed `gh` seam — never the gate).
    fn assert_gate_answer(
        webview: &tauri::WebviewWindow<MockRuntime>,
        command: &str,
        body: serde_json::Value,
        policy: crate::license::PlanCase,
        free_answer: &str,
    ) {
        let response = get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "http://tauri.localhost".parse().expect("invoke URL"),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        let gate_error = serde_json::Value::String(policy.team_refusal().unwrap_or_default());
        match policy {
            _ if !policy.team_allowed() => assert_eq!(
                response.expect_err(command),
                gate_error,
                "{command} must refuse through its registered production IPC path"
            ),
            _ => assert_eq!(
                response.expect_err(command),
                serde_json::Value::String(free_answer.to_string()),
                "{command} must pass the gate without a key and reach its next step"
            ),
        }
    }

    #[test]
    fn none_state_refuses_14_registered_strict_commands_before_side_effects() {
        for policy in crate::license::PlanCase::ALL {
            none_state_under(policy);
        }
    }

    fn none_state_under(policy: crate::license::PlanCase) {
        let temp = tempfile::tempdir().expect("tempdir");
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).expect("project directory");

        let workspaces = crate::workspace::WorkspaceStore::new(config.clone())
            .expect("workspace store");
        let workspace = workspaces
            .create("Team gate IPC".into(), project.to_string_lossy().into_owned())
            .expect("workspace");
        workspaces
            .set_kanban_sync(
                &workspace.id,
                crate::workspace::KanbanSyncMode::GitHubIssues,
                Some("fixture/never-called".into()),
            )
            .expect("seed GitHub-backed workspace");

        let kanban = crate::kanban::KanbanStore::new(config.clone()).expect("kanban store");
        kanban
            .create_card(
                &workspace.id,
                crate::kanban::KanbanCard::new(
                    "gate-card".into(),
                    workspace.id.clone(),
                    "Gate card".into(),
                    None,
                    crate::kanban::KanbanColumnId::Todo,
                ),
            )
            .expect("seed gate card");

        let before = snapshot_files(temp.path());
        let app = mock_builder()
            .manage(workspaces)
            .manage(kanban)
            .manage(crate::license::LicenseStore::for_plan_test(config.clone(), policy))
            .manage(
                crate::project_config::ProjectConfigStore::new(config.clone())
                    .expect("project config store"),
            )
            .manage(crate::prompts::PromptsStore::new(config.clone()).expect("prompts store"))
            .manage(crate::settings::SettingsStore::new(config.clone()).expect("settings store"))
            .manage(crate::memory::MemoryStore::new(config.clone()).expect("memory store"))
            .manage(crate::templates::TemplatesStore::new(config.clone()).expect("templates store"))
            .manage(
                crate::swarm_templates::SwarmTemplatesStore::new(config.clone())
                    .expect("swarm templates store"),
            )
            .invoke_handler(tauri::generate_handler![
                crate::commands::workspace_set_kanban_sync_mode,
                crate::commands::kanban_card_advance_to_in_progress,
                crate::commands::prompts_promote,
                crate::commands::prompts_demote,
                crate::commands::prompts_fork,
                crate::commands::knowledge_promote_project,
                crate::commands::knowledge_demote_project,
                crate::commands::knowledge_fork_project,
                crate::commands::templates_promote,
                crate::commands::templates_demote,
                crate::commands::templates_fork,
                // GH #171: the three swarm-template moves are no command any
                // more (Settings › Swarm templates is retired).
            ])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");

        let workspace_id = workspace.id;
        let project_cwd = project.to_string_lossy().into_owned();
        let strict_calls = [
            (
                "workspace_set_kanban_sync_mode",
                serde_json::json!({
                    "workspaceId": workspace_id,
                    "mode": "githubIssues",
                    "repo": "fixture/never-called"
                }),
                "test gh seam is not armed: gh label create status:todo --repo fixture/never-called --color ededed --force",
            ),
            (
                "kanban_card_advance_to_in_progress",
                serde_json::json!({
                    "workspaceId": workspace_id,
                    "cardId": "gate-card",
                    "targetBranch": null
                }),
                "Push the card to GitHub first: it has no issue to claim yet.",
            ),
            (
                "prompts_promote",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "prompt not found in personal: shared-id",
            ),
            (
                "prompts_demote",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "no shared library at <cwd>/.atelier/library/prompts.json",
            ),
            (
                "prompts_fork",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "no shared library at <cwd>/.atelier/library/prompts.json",
            ),
            (
                "knowledge_promote_project",
                serde_json::json!({
                    "projectCwd": project_cwd,
                    "id": "shared-id",
                    "workspaceId": null
                }),
                "knowledge entry not found in Global: shared-id",
            ),
            (
                "knowledge_demote_project",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "knowledge entry not found in shared: shared-id",
            ),
            (
                "knowledge_fork_project",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "knowledge entry not found in shared: shared-id",
            ),
            (
                "templates_promote",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "user template not found in personal: shared-id",
            ),
            (
                "templates_demote",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "no shared library at <cwd>/.atelier/library/templates.json",
            ),
            (
                "templates_fork",
                serde_json::json!({"projectCwd": project_cwd, "id": "shared-id"}),
                "no shared library at <cwd>/.atelier/library/templates.json",
            ),
        ];

        assert_eq!(strict_calls.len(), 11);
        for (command, body, free_answer) in strict_calls {
            assert_gate_answer(&webview, command, body, policy, free_answer);
        }
        if !policy.team_allowed() {
            assert_eq!(snapshot_files(temp.path()), before);
        }
    }
}
