//! Try it (TI-2): a Try session's environment, what makes a card busy, which
//! sessions a stop picks, that every removal of a card's copy stops them
//! first, and (unix) that a stop ends the command's whole process group.

use super::*;
use crate::coordination::*;

fn target(ws: &str, card: &str, lane: Option<&str>) -> TryTarget {
    TryTarget { workspace_id: ws.into(), card_id: card.into(), lane: lane.map(str::to_string) }
}

fn ports(base: &str) -> Vec<(String, String)> {
    vec![
        (crate::worktree_ports::ENV_BASE.into(), base.into()),
        (crate::worktree_ports::ENV_COUNT.into(), "10".into()),
    ]
}

fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

#[test]
fn port_and_browser_are_a_try_sessions_only_and_port_only_in_a_card_copy() {
    // A Try session in a card copy: PORT is the copy's base, BROWSER=none,
    // and the port block itself stays.
    let env = spawn_env(ports("41230"), true);
    assert_eq!(get(&env, "PORT"), Some("41230"));
    assert_eq!(get(&env, "BROWSER"), Some("none"));
    assert_eq!(get(&env, crate::worktree_ports::ENV_BASE), Some("41230"));
    assert_eq!(get(&env, crate::worktree_ports::ENV_COUNT), Some("10"));
    // After Ship (the project folder has no port block): BROWSER, no PORT.
    let env = spawn_env(Vec::new(), true);
    assert_eq!(get(&env, "PORT"), None);
    assert_eq!(get(&env, "BROWSER"), Some("none"));
    // Every other tile, in a card copy or not: unchanged.
    assert_eq!(spawn_env(ports("41230"), false), ports("41230"));
    assert!(spawn_env(Vec::new(), false).is_empty());
}

/// The spawn asks `env_for_cwd` and hands its answer through `spawn_env`
/// to `session_env` (the cached PATH is set there, Hard rule 2).
#[test]
fn the_tile_spawn_puts_the_try_env_through_session_env() {
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pty.rs")).unwrap();
    let body = &src[src.find("pub fn spawn_tile<").unwrap()..];
    let body = &body[..body.find("\n    pub fn write(").unwrap()];
    let env = body.find("crate::try_session::spawn_env(").expect("spawn_env");
    let ports = body.find("crate::worktree_ports::env_for_cwd(").expect("env_for_cwd");
    let session = body.find("session_env(&mut command, &env.path, true, &ports, &managed)").expect("session_env");
    assert!(env < ports && ports < session);
    assert!(body.contains("try_session.is_some()"));
}

#[test]
fn a_try_session_never_makes_its_card_busy() {
    let intent = |execution_kind| SpawnIntent {
        provider: Provider::Shell,
        execution_kind,
        attendance: Attendance::HumanAttended,
        write_intent: WriteIntent::Unknown,
        enforcement: Enforcement::Advisory,
        project: SpawnProject::Project { workspace_id: "w".into(), cwd: "/tmp/wt".into() },
        capability: None,
        card_id: None,
        swarm_id: None,
        role_id: None,
        run_id: None,
        retention_class: RetentionClass::Interactive,
        objective: None,
        account: None,
    };
    let t = target("w", "c1", None);
    assert!(crate::pty::tile_keeps_folder_busy(&intent(ExecutionKind::ShellTile), None));
    assert!(!crate::pty::tile_keeps_folder_busy(&intent(ExecutionKind::ShellTile), Some(&t)));
    // And the registry only counts what `tile_keeps_folder_busy` let in.
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pty.rs")).unwrap();
    assert!(src.contains("let shell_tile_cwd = tile_keeps_folder_busy(&intent, try_target.as_ref())"));
    // It is still a shell tile in the coordination record: no new kind an
    // older Plyloft could not read.
    assert!(src.contains("if try_target.is_some() && intent.execution_kind != crate::coordination::ExecutionKind::ShellTile"));
}

#[test]
fn a_stop_picks_the_card_or_only_that_build() {
    let a = target("ws", "c1", Some("a"));
    let own = target("ws", "c1", None);
    let b = target("ws", "c1", Some("b"));
    let other_card = target("ws", "c2", None);
    let other_ws = target("ws2", "c1", None);
    // No lane: every Try session of the card.
    for t in [&a, &own, &b] {
        assert!(selects(t, "ws", "c1", None), "{t:?}");
    }
    assert!(!selects(&other_card, "ws", "c1", None));
    assert!(!selects(&other_ws, "ws", "c1", None));
    // A lane: that build's only.
    assert!(selects(&b, "ws", "c1", Some("b")));
    assert!(!selects(&a, "ws", "c1", Some("b")));
    assert!(!selects(&own, "ws", "c1", Some("b")));

    let sessions: HashMap<String, TrySession> = [("p1", &own), ("p2", &b), ("p3", &other_card), ("p4", &other_ws)]
        .into_iter()
        .map(|(id, t)| (id.to_string(), TrySession { target: t.clone(), cwd: None }))
        .collect();
    let ids = |lane| -> Vec<String> {
        select_ids(&sessions, |s| selects(&s.target, "ws", "c1", lane)).into_iter().map(|(id, _)| id).collect()
    };
    assert_eq!(ids(None), vec!["p1", "p2"]);
    assert_eq!(ids(Some("b")), vec!["p2"]);
    assert!(ids(Some("a")).is_empty());
    // The registry's answer is the same rule over its live sessions.
    assert!(crate::pty::PtyRegistry::default().try_sessions_matching(|_| true).is_empty());
}

#[test]
fn the_net_picks_sessions_inside_the_copy_never_the_project_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let copy = repo.join(".plyloft-worktrees").join("c1");
    std::fs::create_dir_all(copy.join("web")).unwrap();
    assert!(cwd_inside(Some(&copy), &copy));
    assert!(cwd_inside(Some(&copy.join("web")), &copy));
    assert!(!cwd_inside(Some(&repo), &copy), "a Try after Ship runs in the project");
    assert!(!cwd_inside(Some(&repo.join(".plyloft-worktrees").join("c1-b")), &copy));
    assert!(!cwd_inside(None, &copy));
}

#[test]
fn a_stop_without_the_app_is_a_no_op() {
    assert_eq!(stop_card_try_sessions("ws", "c1", None, TryStopReason::Ship), 0);
    assert_eq!(stop_in_dir(std::path::Path::new("/nowhere"), TryStopReason::CopyRemoved), 0);
}

#[test]
fn the_event_says_why_in_kebab_case() {
    let e = TryStoppedEvent {
        workspace_id: "ws".into(),
        card_id: "c1".into(),
        lane: None,
        reason: TryStopReason::Ship,
        pty_ids: vec!["p1".into()],
        words: TryStopReason::Ship.words(),
    };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["reason"], "ship");
    assert_eq!(v["workspaceId"], "ws");
    assert_eq!(v["ptyIds"][0], "p1");
    assert_eq!(v["words"], STOPPED_FOR_SHIP_WORDS);
    assert_eq!(TryStopReason::Archive.words(), None);
    assert_eq!(serde_json::to_value(TryStopReason::CopyRemoved).unwrap(), "copy-removed");
    // The TypeScript twin says the same words.
    let ts = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/tryTile.ts")).unwrap();
    assert!(ts.contains(&format!("export const TRY_STOPPED_FOR_SHIP = \"{STOPPED_FOR_SHIP_WORDS}\";")));
    let ipc = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc.ts")).unwrap();
    assert!(ipc.contains(&format!("\"{TRY_STOPPED_EVENT}\"")), "the frontend listens to the same event");
}

/// Every path that removes a card's copy stops its Try sessions first, by
/// card, with its reason — before its own `prune_worktree_at` — and the
/// prune itself stops whatever runs inside the folder (the net).
#[test]
fn every_removal_of_a_copy_stops_its_try_sessions_first() {
    let src = |f: &str| std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f)).unwrap();
    let body = |text: &str, head: &str| -> String {
        let start = text.find(head).unwrap_or_else(|| panic!("{head}"));
        let rest = &text[start + head.len()..];
        // To the next top-level item.
        let end = rest.find("\n}\n").map_or(rest.len(), |e| e + 3);
        rest[..end].to_string()
    };
    let stops_before_prune = |text: &str, head: &str, reason: &str| {
        let b = body(text, head);
        let stop = b
            .find(&format!("crate::try_session::TryStopReason::{reason}"))
            .unwrap_or_else(|| panic!("{head} stops its Try sessions ({reason})"));
        let call = b[..stop].rfind("stop_card_try_sessions(").unwrap_or_else(|| panic!("{head}: by card"));
        // The prune, or Ship's prune that keeps a held copy (`kept_copy`).
        let prune = ["prune_worktree_at(", "kept_copy::prune_or_keep("]
            .iter()
            .filter_map(|p| b.find(p))
            .min()
            .unwrap_or_else(|| panic!("{head} prunes"));
        assert!(call < prune, "{head}: the stop comes before the prune");
    };
    let commands = src("commands.rs");
    stops_before_prune(&commands, "fn land_card_local<", "Ship");
    stops_before_prune(&commands, "fn kanban_card_archive_locked(", "Archive");
    stops_before_prune(&commands, "pub async fn build_both_stop(", "Discard");
    stops_before_prune(&src("ship.rs"), "fn put_away_worktrees<", "Ship");
    stops_before_prune(&src("kanban.rs"), "pub fn reconcile_ship_backfill", "Ship");
    stops_before_prune(&src("build_both.rs"), "pub fn pick_locked(", "Discard");
    stops_before_prune(&src("put_back.rs"), "fn put_back_locked", "Discard");
    // Delete: before `dispose_deleted_card_worktree` (via finish_card_delete_at).
    let delete = body(&commands, "fn finish_card_delete(");
    let stop = delete.find("crate::try_session::TryStopReason::Delete").expect("delete stops its Try sessions");
    assert!(stop < delete.find("finish_card_delete_at(").expect("then removes"));
    // The set-aside build is stopped by its lane, not the whole card.
    assert!(body(&src("build_both.rs"), "pub fn pick_locked(").contains("stop_card_try_sessions(workspace_id, card_id, Some(loser),"));
    // The net, in the move every removal of a copy ends in: `move_to_trash`
    // and `move_to_trash_prepared` are `move_to_trash_hooked`, which stops
    // what runs inside the folder before the rename.
    let worktrees = src("worktrees.rs");
    let code = &worktrees[..worktrees.find("\nmod tests {").expect("worktrees' tests")];
    let hooked = body(code, "fn move_to_trash_hooked(");
    let net = hooked.find("crate::try_session::stop_in_dir(&path,").expect("the net in the move");
    assert!(net < hooked.find("crate::platform::rename(").expect("the move"));
    assert!(body(code, "fn move_to_trash(").contains("move_to_trash_hooked("));
    assert!(body(code, "fn move_to_trash_prepared(").contains("move_to_trash_hooked("));
    // Every caller of the move, and those that strip caches first stop
    // before that too (on Windows a running server holds files in them).
    let mut callers: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in code.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("fn ").or_else(|| t.strip_prefix("pub fn ")).or_else(|| t.strip_prefix("pub(crate) fn ")) {
            current = rest.split(['(', '<']).next().unwrap_or_default().to_string();
        }
        if (t.contains("move_to_trash(") || t.contains("move_to_trash_prepared(")) && !t.starts_with("//") && !t.starts_with("fn ") && !t.contains("fn move_to_trash") && !callers.contains(&current) {
            callers.push(current.clone());
        }
    }
    callers.retain(|c| !c.starts_with("move_to_trash"));
    callers.sort();
    assert_eq!(callers, ["prune_one_at_tip", "prune_worktree_at", "remove_card_worktree_hooked"], "a new caller of the move: check its stop");
    for head in ["pub fn prune_worktree_at(", "fn prune_one_at_tip("] {
        let b = body(code, head);
        let stop = b.find("crate::try_session::stop_in_dir(").unwrap_or_else(|| panic!("{head} stops first"));
        assert!(stop < b.find("strip_caches(").unwrap(), "{head}: before the caches");
    }
    // App quit: `kill_all` ends a Try session's running job first.
    let kill_all = body(&src("pty.rs"), "pub fn kill_all(&self) {");
    assert!(kill_all.contains("crate::try_session::end_jobs(&jobs, crate::try_session::STOP_GRACE, true)"));
    // A removal waits for the command to end before the copy goes.
    assert!(src("try_session.rs").contains("registry.kill_with(&id, true)"));
}

/// `kanban.rs`'s backfill: the function head the guard above reads.
#[test]
fn the_backfill_head_the_guard_reads_exists() {
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/kanban.rs")).unwrap();
    assert!(src.contains("pub fn reconcile_ship_backfill"));
}

/// Unix: the stop ends a job's whole group — a dev server and the child it
/// started (`npm` → `node`), not just its leader — and never Plyloft's own.
#[cfg(unix)]
#[test]
fn ending_a_job_ends_its_children_too() {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    // A leader that starts a child and waits, like npm under the shell; a
    // trap that ignores SIGTERM in the child, like a stubborn server.
    let mut leader = crate::platform::new_command("/bin/sh")
        .args(["-c", "(trap '' TERM; exec sleep 300) & echo $!; wait"])
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let pgid = leader.id() as i32;
    let mut line = String::new();
    BufReader::new(leader.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let child: i32 = line.trim().parse().unwrap();
    let alive = |pid: i32| unsafe { libc::kill(pid, 0) } == 0;
    assert!(alive(child));
    // Reap the leader as a shell would, so the group's liveness is its members'.
    let reaper = std::thread::spawn(move || leader.wait());
    end_jobs(&[pgid], std::time::Duration::from_millis(300), true);
    reaper.join().unwrap().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while alive(child) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!alive(child), "the child that ignored SIGTERM got SIGKILL");
    // Plyloft's own group and init are never signalled.
    end_jobs(&[unsafe { libc::getpgrp() }, 1, 0], std::time::Duration::from_millis(10), true);
}

/// `pty_spawn`'s `tryTarget`: a shell of a workspace's card, never a
/// Claude or Codex tile; absent for every other tile.
#[test]
fn pty_spawn_takes_a_try_target_only_for_a_shell_of_a_workspace() {
    use crate::commands::{try_target_for, PtyTryArg};
    let arg = |card: &str, lane: Option<&str>| Some(PtyTryArg { card_id: card.into(), lane: lane.map(str::to_string) });
    assert_eq!(try_target_for(None, Some("ws"), false).unwrap(), None);
    assert_eq!(try_target_for(arg("c1", None), Some("ws"), false).unwrap(), Some(target("ws", "c1", None)));
    assert_eq!(try_target_for(arg("c1", Some("b")), Some("ws"), false).unwrap(), Some(target("ws", "c1", Some("b"))));
    assert_eq!(try_target_for(arg("c1", Some("")), Some("ws"), false).unwrap(), Some(target("ws", "c1", None)));
    assert!(try_target_for(arg("c1", None), Some("ws"), true).is_err(), "not a Claude/Codex tile");
    assert!(try_target_for(arg("c1", None), None, false).is_err(), "needs its workspace");
    assert!(try_target_for(arg(" ", None), Some("ws"), false).is_err(), "needs its card");
    let parsed: PtyTryArg = serde_json::from_str(r#"{"cardId":"c1","lane":null}"#).unwrap();
    assert_eq!((parsed.card_id.as_str(), parsed.lane), ("c1", None));
}

/// TI-5: a removal of the copy never stops a Try session in the project
/// folder, even one tagged with the card; the member's own stop does.
#[test]
fn a_removal_stops_the_copys_sessions_never_the_projects() {
    let ws = std::path::Path::new("/w/repo");
    let session = |cwd: &std::path::Path, lane: Option<&str>| TrySession { target: target("ws", "c1", lane), cwd: Some(cwd.to_path_buf()) };
    let copy = session(&ws.join(".plyloft-worktrees").join("c1"), None);
    let copy_sub = session(&ws.join(".plyloft-worktrees").join("c1").join("web"), None);
    let lane_b = session(&ws.join(".plyloft-worktrees").join("c1-b"), Some("b"));
    let project = session(ws, None);
    assert!(removal_selects(&copy, "ws", "c1", None));
    assert!(removal_selects(&copy_sub, "ws", "c1", None));
    assert!(removal_selects(&lane_b, "ws", "c1", None));
    assert!(removal_selects(&lane_b, "ws", "c1", Some("b")));
    assert!(!removal_selects(&project, "ws", "c1", None), "after Ship, in the project folder");
    assert!(!removal_selects(&TrySession { target: target("ws", "c1", None), cwd: None }, "ws", "c1", None));
    assert!(selects(&project.target, "ws", "c1", None), "the member's own stop takes it");
    // TI-5 as built: Try it in <project> is tagged with the workspace's own
    // id, not the shipped card's — no archive, delete or Stop of that card
    // names it, and no copy's removal (the net in `prune_worktree_at`) is
    // around its folder.
    let own = TrySession { target: target("ws", PROJECT_TRY_CARD_ID, None), cwd: Some(ws.to_path_buf()) };
    assert!(!removal_selects(&own, "ws", "c1", None), "archive or delete of the shipped card");
    assert!(!selects(&own.target, "ws", "c1", None), "the card's own Stop");
    assert!(!cwd_inside(own.cwd.as_deref(), &ws.join(".plyloft-worktrees").join("c1")));
    assert!(!in_card_copy(own.cwd.as_deref()));
    assert_eq!(spawn_env(Vec::new(), true), vec![("BROWSER".to_string(), "none".to_string())], "no PORT in the project folder");
    // Every removal path asks for the copy's sessions; only the IPC asks for all.
    let src = |f: &str| std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f)).unwrap();
    assert!(src("try_session.rs").contains("stop_with(app, |s| removal_selects(s, workspace_id, card_id, lane), reason)"));
    let commands = src("commands.rs");
    assert_eq!(commands.matches("crate::try_session::stop_all_card_try_sessions(").count(), 1);
    assert!(commands.contains("TryStopReason::Requested"));
}

/// Spec §7: a `.cmd` shim is typed only where the cached PATH has one.
#[test]
fn a_cmd_shim_counts_only_where_it_is_on_the_path() {
    let tmp = tempfile::tempdir().unwrap();
    let node = tmp.path().join("nodejs");
    let bun = tmp.path().join("bun").join("bin");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::create_dir_all(&bun).unwrap();
    std::fs::write(node.join("npm.cmd"), "").unwrap();
    std::fs::write(node.join("npx.cmd"), "").unwrap();
    std::fs::write(bun.join("bun.exe"), "").unwrap();
    std::fs::create_dir_all(node.join("pnpm.cmd")).unwrap(); // a folder is not a shim
    let path = crate::platform::join_path_list(&[node.to_string_lossy().into_owned(), bun.to_string_lossy().into_owned()]);
    let names: Vec<String> = ["npm", "pnpm", "yarn", "npx", "bun", "../npm", ""].iter().map(|s| s.to_string()).collect();
    assert_eq!(cmd_shims_in(&path, &names), vec!["npm".to_string(), "npx".to_string()]);
    // bun with a `.cmd` (an npm-installed bun) counts.
    std::fs::write(bun.join("bun.cmd"), "").unwrap();
    assert_eq!(cmd_shims_in(&path, &names), vec!["bun".to_string(), "npm".to_string(), "npx".to_string()]);
    assert!(cmd_shims_in("", &names).is_empty());
}

/// A real Try session in a PTY, spawned with its command (nothing typed into
/// an interactive shell, whose startup and prompt a loaded test run cannot
/// time). The shell itself in the foreground: no job to end. A shell with
/// job control (`set -m`) running `sh -c 'sleep 300 & wait'`: that command's
/// group is the job, and a stop that waits ends it, the `sleep` included.
#[cfg(unix)]
#[test]
#[ignore = "real PTY job control times out under the full parallel suite; run alone: cargo test --lib a_real_try_session_ends_its_running_job -- --ignored (the Tier 4 walk's orphan check covers it live)"]
fn a_real_try_session_ends_its_running_job() {
    crate::shell_env::init();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = crate::pty::PtyRegistry::default();
    let tmp = tempfile::tempdir().unwrap();
    let spawn = |script: &str| {
        let intent = SpawnIntent {
            provider: Provider::Shell,
            execution_kind: ExecutionKind::ShellTile,
            attendance: Attendance::HumanAttended,
            write_intent: WriteIntent::Unknown,
            enforcement: Enforcement::Exempt,
            project: SpawnProject::NonProject { reason: "try session test".into() },
            capability: None,
            card_id: None,
            swarm_id: None,
            role_id: None,
            run_id: None,
            retention_class: RetentionClass::Interactive,
            objective: None,
            account: None,
        };
        registry.spawn_tile(
            app.handle().clone(),
            "/bin/sh",
            vec!["-c".into(), script.into()],
            Some(tmp.path().to_string_lossy().into_owned()),
            None,
            intent,
            80,
            24,
            Some(target("ws", "c1", None)),
            None,
        )
    };
    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !ok() {
            assert!(std::time::Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    // The idle case: the PTY's own child holds the foreground.
    let idle = match spawn("exec sleep 300") {
        Ok(id) => id,
        Err(e) => {
            eprintln!("skipped: no PTY here ({e})");
            return;
        }
    };
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(registry.foreground_job_of(&idle), None, "the shell's own group is no job");
    registry.kill_with(&idle, true).unwrap();

    // `; :` keeps the outer shell from exec'ing its last command.
    let id = spawn("set -m; sh -c 'sleep 300 & wait'; :").expect("spawn");
    assert_eq!(registry.try_sessions_matching(|_| true).len(), 1);
    let mut job = None;
    wait_for("the command becomes the foreground job", || {
        job = registry.foreground_job_of(&id);
        job.is_some()
    });
    assert_eq!(registry.command_running(&id).unwrap(), Some(true), "the command runs");
    assert!(registry.command_running("no-such-pty").is_err());
    let job = job.unwrap();
    assert!(unsafe { libc::killpg(job, 0) } == 0);
    registry.kill_with(&id, true).unwrap();
    wait_for("the job's group is gone", || unsafe { libc::killpg(job, 0) } != 0);
    assert!(registry.try_sessions_matching(|_| true).is_empty());
}

/// TI-4 (spec §4.4): a copy with a `package.json` and no `node_modules`
/// needs its packages; with them, without a `package.json`, or missing, not.
#[test]
fn a_copy_needs_packages_only_with_package_json_and_no_node_modules() {
    let tmp = tempfile::tempdir().unwrap();
    let copy = tmp.path();
    assert!(!copy_needs_packages(copy), "no package.json: nothing to install");
    std::fs::write(copy.join("package.json"), "{}").unwrap();
    assert!(copy_needs_packages(copy));
    // Yarn Plug'n'Play installs with no node_modules.
    for pnp in [".pnp.cjs", ".pnp.loader.mjs"] {
        std::fs::write(copy.join(pnp), "").unwrap();
        assert!(!copy_needs_packages(copy), "{pnp}");
        std::fs::remove_file(copy.join(pnp)).unwrap();
    }
    assert!(copy_needs_packages(copy));
    std::fs::create_dir_all(copy.join("node_modules")).unwrap();
    assert!(!copy_needs_packages(copy));
    // A folder named package.json is not one.
    let other = tmp.path().join("other");
    std::fs::create_dir_all(other.join("package.json")).unwrap();
    assert!(!copy_needs_packages(&other));
    assert!(!copy_needs_packages(&tmp.path().join("missing")));
}

/// TI-4 (spec §3.3): a plain website's page is the regular `index.html` at
/// the top of the copy — not a folder, not a link, never outside the copy.
#[test]
fn a_plain_website_is_its_own_top_index_html() {
    let tmp = tempfile::tempdir().unwrap();
    let copy = tmp.path().join("copy");
    std::fs::create_dir_all(&copy).unwrap();
    assert!(checked_file_in(&copy, "index.html").is_err(), "none there");
    std::fs::create_dir_all(copy.join("index.html")).unwrap();
    assert!(checked_file_in(&copy, "index.html").is_err(), "a folder is not the page");
    std::fs::remove_dir(copy.join("index.html")).unwrap();
    std::fs::write(copy.join("index.html"), "<p>hi</p>").unwrap();
    let file = checked_file_in(&copy, "index.html").unwrap();
    assert_eq!(file, copy.join("index.html").canonicalize().unwrap());
    // A name that walks out of the copy is refused, though the file exists.
    std::fs::write(tmp.path().join("outside.html"), "<p>no</p>").unwrap();
    let err = checked_file_in(&copy, "../outside.html").unwrap_err();
    assert!(err.contains("outside the card's copy"), "{err}");
}

#[cfg(unix)]
#[test]
fn a_linked_index_html_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let copy = tmp.path().join("copy");
    std::fs::create_dir_all(&copy).unwrap();
    std::fs::write(tmp.path().join("secret.html"), "<p>no</p>").unwrap();
    std::os::unix::fs::symlink(tmp.path().join("secret.html"), copy.join("index.html")).unwrap();
    let err = checked_file_in(&copy, "index.html").unwrap_err();
    assert!(err.contains("link"), "{err}");
    // Even a link that stays inside the copy.
    std::fs::remove_file(copy.join("index.html")).unwrap();
    std::fs::write(copy.join("page.html"), "<p>x</p>").unwrap();
    std::os::unix::fs::symlink(copy.join("page.html"), copy.join("index.html")).unwrap();
    assert!(checked_file_in(&copy, "index.html").is_err());
}

#[test]
fn a_file_url_encodes_what_the_opener_refuses_raw() {
    #[cfg(unix)]
    assert_eq!(
        file_url(std::path::Path::new("/Users/me/My Site/index.html")),
        "file:///Users/me/My%20Site/index.html"
    );
    #[cfg(windows)]
    assert_eq!(
        file_url(std::path::Path::new(r"\\?\C:\Users\me\My Site\index.html")),
        "file:///C:/Users/me/My%20Site/index.html"
    );
    let url = file_url(std::path::Path::new("/a/b\"c#d.html"));
    assert!(crate::platform::url_scheme_allowed(&url, &["file"]), "{url}");
    assert!(!url.contains('#') && !url.contains('"'));
}

/// TI-4: "Install them this time" runs a package manager's plain install
/// and nothing else.
#[test]
fn only_a_plain_install_runs_once() {
    for ok in ["npm install", "pnpm install", " yarn  install ", "bun install"] {
        assert!(is_plain_install(ok), "{ok}");
    }
    for no in ["npm install; rm -rf /", "npm ci", "npm install left-pad", "make install", "", "install"] {
        assert!(!is_plain_install(no), "{no}");
    }
}

/// TI-4 (item 8), walk fix: the copy's install is its lockfile's — the
/// frozen form when there is one (`npm ci`, `pnpm install
/// --frozen-lockfile`…), so the copy's lockfile never changes and never
/// reaches the card's diff; the plain install when there is none.
#[test]
fn the_install_follows_the_copys_lockfile() {
    let tmp = tempfile::tempdir().unwrap();
    let copy = tmp.path().to_string_lossy().into_owned();
    let needs = || crate::commands::try_copy_needs_packages(copy.clone()).map(|p| p.command);
    std::fs::write(tmp.path().join("package.json"), "{}").unwrap();
    assert_eq!(needs().as_deref(), Some("npm install --no-package-lock"), "no lockfile: none written");
    std::fs::write(tmp.path().join("package-lock.json"), "{}").unwrap();
    assert_eq!(needs().as_deref(), Some("npm ci"));
    std::fs::remove_file(tmp.path().join("package-lock.json")).unwrap();
    std::fs::write(tmp.path().join("pnpm-lock.yaml"), "").unwrap();
    assert_eq!(needs().as_deref(), Some("pnpm install --frozen-lockfile"));
    std::fs::remove_file(tmp.path().join("pnpm-lock.yaml")).unwrap();
    std::fs::write(tmp.path().join("yarn.lock"), "# yarn lockfile v1\n").unwrap();
    assert_eq!(needs().as_deref(), Some("yarn install --frozen-lockfile"));
    std::fs::write(tmp.path().join(".yarnrc.yml"), "").unwrap();
    assert_eq!(needs().as_deref(), Some("yarn install --immutable"));
    std::fs::remove_file(tmp.path().join("yarn.lock")).unwrap();
    std::fs::write(tmp.path().join("bun.lock"), "").unwrap();
    assert_eq!(needs().as_deref(), Some("bun install --frozen-lockfile"));
    std::fs::create_dir_all(tmp.path().join("node_modules")).unwrap();
    assert_eq!(needs(), None);
    assert_eq!(crate::commands::try_copy_needs_packages(String::new()), None);
    // "Install them this time" may run the frozen form it is offered.
    let commands = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands.rs")).unwrap();
    let body = &commands[commands.find("pub async fn try_install_packages_once(").unwrap()..];
    let body = &body[..body.find("prepare_worktree(").unwrap()];
    assert!(body.contains("crate::try_session::is_copy_install(&command)"), "the once-install allows the copy's forms");
}

/// Challenger: a copy with no lockfile installs without writing one; the
/// package manager is `packageManager`'s; Yarn 2+ says it creates yarn.lock.
#[test]
fn a_copy_without_a_lockfile_installs_without_writing_one() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let plan = |pkg: &str, berry: bool| {
        std::fs::write(dir.join("package.json"), pkg).unwrap();
        let rc = dir.join(".yarnrc.yml");
        if berry {
            std::fs::write(&rc, "").unwrap();
        } else {
            let _ = std::fs::remove_file(&rc);
        }
        copy_install_for(dir)
    };
    let none = |c: &str| ProjectInstall { command: c.into(), creates: None };
    assert_eq!(plan("{}", false), none("npm install --no-package-lock"));
    assert_eq!(plan(r#"{"packageManager":"pnpm@9.1.0"}"#, false), none("pnpm install --no-lockfile"));
    assert_eq!(plan(r#"{"packageManager":"yarn@1.22.22"}"#, false), none("yarn install --no-lockfile"));
    assert_eq!(plan(r#"{"packageManager":"bun@1.1.0"}"#, false), none("bun install --no-save"));
    let berry = ProjectInstall { command: "yarn install".into(), creates: Some("yarn.lock") };
    assert_eq!(plan(r#"{"packageManager":"yarn@4.1.0"}"#, false), berry);
    assert_eq!(plan("{}", true), berry);
    // A lockfile still wins: its frozen form.
    std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
    assert_eq!(plan("{}", false), none("npm ci"));
    // The project path keeps TI-5's plain install, which creates the lockfile.
    std::fs::remove_file(dir.join("package-lock.json")).unwrap();
    assert_eq!(project_install_for(dir).creates, Some("package-lock.json"));
    for ok in ["npm install --no-package-lock", "pnpm install --no-lockfile", "yarn install --no-lockfile", "bun install --no-save", "npm ci", "yarn install"] {
        assert!(is_copy_install(ok), "{ok}");
    }
    for no in ["npm install --no-package-lock && x", "npm install --save x", "bun install --no-save left-pad"] {
        assert!(!is_copy_install(no), "{no}");
    }
    assert!(!is_project_install("npm install --no-package-lock"), "the project path keeps TI-5's list");
}

/// Walk fix (spec §4.1): a Try session reads its script's body to pass Vite
/// or Astro the card's port.
#[test]
fn a_package_scripts_body_is_read_by_name() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().to_string_lossy().into_owned();
    let read = |name: &str| crate::commands::try_package_script(path.clone(), name.into());
    assert_eq!(read("dev"), None, "no package.json");
    std::fs::write(
        tmp.path().join("package.json"),
        "\u{feff}{\"scripts\":{\"dev\":\"vite --host\",\"start\":7,\"build:x\":\"tsc && vite build\"}}",
    )
    .unwrap();
    assert_eq!(read("dev").as_deref(), Some("vite --host"));
    assert_eq!(read(" build:x ").as_deref(), Some("tsc && vite build"));
    assert_eq!(read("start"), None, "not a string");
    assert_eq!(read("preview"), None);
    assert_eq!(read(""), None);
    assert_eq!(crate::commands::try_package_script(String::new(), "dev".into()), None);
}

/// TI-5: the project folder's install — the lockfile's frozen form, the plain
/// install (which creates the lockfile) when there is none.
#[test]
fn the_project_install_keeps_the_lockfile() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let plan = |files: &[(&str, &str)]| {
        for entry in std::fs::read_dir(dir).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
        }
        project_install_for(dir)
    };
    let frozen = |c: &str| ProjectInstall { command: c.into(), creates: None };
    assert_eq!(plan(&[("package.json", "{}")]), ProjectInstall { command: "npm install".into(), creates: Some("package-lock.json") });
    assert_eq!(plan(&[("package-lock.json", "{}")]), frozen("npm ci"));
    assert_eq!(plan(&[("pnpm-lock.yaml", "")]), frozen("pnpm install --frozen-lockfile"));
    assert_eq!(plan(&[("yarn.lock", "# yarn lockfile v1\n")]), frozen("yarn install --frozen-lockfile"));
    assert_eq!(plan(&[("yarn.lock", "__metadata:\n  version: 8\n")]), frozen("yarn install --immutable"));
    assert_eq!(plan(&[("yarn.lock", ""), (".yarnrc.yml", "")]), frozen("yarn install --immutable"));
    assert_eq!(plan(&[("bun.lock", "")]), frozen("bun install --frozen-lockfile"));
    for ok in ["npm ci", "npm install", "pnpm install --frozen-lockfile", "yarn install --immutable", "bun install --frozen-lockfile"] {
        assert!(is_project_install(ok), "{ok}");
    }
    for no in ["npm ci && rm -rf /", "npm run build", "npm ci --foo", "rm -rf node_modules", ""] {
        assert!(!is_project_install(no), "{no}");
    }
    // The plain install alone is `is_plain_install`'s.
    assert!(!is_plain_install("npm ci"));
}

/// TI-5: `try_install_packages_in_project` refuses an unknown workspace and
/// a command that isn't an install, before anything runs.
#[test]
fn the_project_install_refuses_an_unknown_workspace_and_a_non_install() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = || Some(tmp.path().to_path_buf());
    assert_eq!(checked_project_install(" npm ci ", dir()), Ok(("npm ci".to_string(), tmp.path().to_path_buf())));
    assert!(checked_project_install("npm ci", None).unwrap_err().contains("folder wasn't found"), "unknown workspace");
    assert!(checked_project_install("npm ci", Some(tmp.path().join("gone"))).is_err(), "its folder gone");
    assert!(checked_project_install("npm run dev", dir()).unwrap_err().contains("only runs a package manager's install"));
    assert!(checked_project_install("curl x | sh", dir()).is_err());
    let commands = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands.rs")).unwrap();
    let body = &commands[commands.find("pub async fn try_install_packages_in_project(").unwrap()..];
    let body = &body[..body.find("prepare_worktree(").unwrap()];
    assert!(body.contains("checked_project_install(&command, workspace_cwd_of(&app, &workspace_id))?"), "checked before it runs");
}

/// TI-5: a merged pull request's change is in the project folder once its
/// merge commit is in the checkout's history; a hex commit id only.
#[test]
fn the_project_has_a_commit_once_it_is_in_its_history() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let git = |args: &[&str]| {
        let out = crate::platform::git_command().args(args).current_dir(repo).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "T"]);
    git(&["commit", "-q", "--allow-empty", "-m", "one"]);
    let first = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "-q", "-b", "side"]);
    git(&["commit", "-q", "--allow-empty", "-m", "on a side branch"]);
    let side = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "-q", "main"]);
    assert!(project_has_commit(repo, &first));
    assert!(project_has_commit(repo, &first[..12]));
    assert!(!project_has_commit(repo, &side), "not pulled into the checkout yet");
    assert!(!project_has_commit(repo, "--all"), "never an option");
    assert!(!project_has_commit(repo, "HEAD"));
    assert!(!project_has_commit(repo, "deadbeefdeadbeef"), "unknown commit");
}

/// Windows walk 2026-10-20: the page stopped answering for seconds at a time
/// during a three-minute install. A plain `#[tauri::command]` runs on the main
/// thread, which on Windows is WebView2's UI thread: every Try IPC is async
/// (an `async fn`, its long work in `spawn_blocking`, or `command(async)`).
#[test]
fn every_try_command_runs_off_the_main_thread() {
    let commands = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands.rs")).unwrap();
    let names = [
        "try_cmd_shims_available",
        "try_folder_exists",
        "try_copy_needs_packages",
        "try_package_script",
        "pty_command_running",
        "try_open_index_html",
        "try_install_packages_once",
        "try_install_packages_in_project",
        "try_project_needs_packages",
        "try_project_has_commit",
        "project_try_command_get",
        "project_try_command_save",
        "project_try_command_approve",
        "stop_card_try_sessions",
    ];
    for name in names {
        let sync = format!("pub fn {name}(");
        let asynchronous = format!("pub async fn {name}(");
        let at = commands
            .find(&asynchronous)
            .or_else(|| commands.find(&sync))
            .unwrap_or_else(|| panic!("{name} not found"));
        let head = &commands[..at];
        let attr = &head[head.rfind("#[tauri::command").unwrap_or_else(|| panic!("{name}: no attribute"))..];
        let is_async_fn = commands[at..].starts_with(&asynchronous);
        assert!(
            attr.starts_with("#[tauri::command(async)]") || is_async_fn,
            "{name} must run off the main thread"
        );
        if is_async_fn {
            // An async fn's body may still block its executor thread; the
            // installs hand their work to the blocking pool.
            let body = &commands[at..];
            let body = &body[..body.find("\n}\n").unwrap()];
            if name.starts_with("try_install_packages") {
                assert!(body.contains("spawn_blocking"), "{name} runs its install in spawn_blocking");
            }
        }
    }
}
