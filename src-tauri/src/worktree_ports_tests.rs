//! Port blocks per card worktree: the pick, the allocation across boards,
//! the backward-compatible load and the variables every spawn gets.

use super::*;
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, PortLookup};
use std::fs;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

fn all_free(_: u16) -> bool {
    true
}

/// The probe's own connects leave the closed listener's port briefly in
/// use; it is free again within moments.
fn becomes_free(base: u16) -> bool {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < until {
        if block_is_free(base) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    false
}

/// The probe itself binds each port of the block for a moment (unix: a
/// 127.0.0.1 bind; Windows: exclusive binds), so two probes of one block at
/// the same time can each see the other's bind and read "busy" — and every
/// test binary on this machine (another worktree's gate, a second `cargo
/// test`) runs these very tests at the same instants from the same starts.
/// Each test therefore looks in its own thousand ports (all below the
/// ephemeral range, 49152–65535, so no outgoing connection lands there),
/// from a point that differs per process, and keeps what it found only once
/// it holds it or has measured it free.
fn blocks_in_my_range(range: u16) -> Vec<u16> {
    let mine: Vec<u16> = block_bases().filter(|b| (range..range + 1000).contains(b)).collect();
    let at = (std::process::id() as usize) % mine.len();
    mine[at..].iter().chain(&mine[..at]).copied().collect()
}

/// A free block and a listener of this test on `base + offset`, bound right
/// after the block read free: a probe elsewhere that held the port at that
/// instant only moves the test to the next block.
fn listening_in_free_block(range: u16, offset: u16, bind: impl Fn(u16) -> std::io::Result<TcpListener>) -> (u16, TcpListener) {
    for base in blocks_in_my_range(range).into_iter().filter(|b| block_is_free(*b)).take(20) {
        if let Ok(listener) = bind(base + offset) {
            return (base, listener);
        }
    }
    panic!("no block in {range}..{} stayed free long enough to listen on", range + 1000);
}

#[test]
fn the_range_is_aligned_blocks_of_ten_between_41000_and_48999() {
    assert!(is_block_base(41000) && is_block_base(41020) && is_block_base(48990));
    assert!(!is_block_base(40990) && !is_block_base(41005) && !is_block_base(49000));
    assert_eq!(block_bases().count(), 800);
    assert_eq!(block_bases().last(), Some(48990));
    assert_eq!(
        port_env(41020),
        vec![("PLYLOFT_PORT_BASE".into(), "41020".into()), ("PLYLOFT_PORT_COUNT".into(), "10".into())]
    );
}

#[test]
fn the_pick_takes_the_lowest_unused_block_and_keeps_a_current_one_nobody_else_holds() {
    let none = HashSet::new();
    assert_eq!(pick_block(&none, None, all_free), Some(41000));
    let used: HashSet<u16> = [41000, 41010, 41030].into();
    assert_eq!(pick_block(&used, None, all_free), Some(41020), "a freed block is reused");
    // Stable: the card's own block stays, even with its server listening.
    assert_eq!(pick_block(&used, Some(41500), |_| false), Some(41500));
    // Taken meanwhile, or not a block: a new one.
    assert_eq!(pick_block(&used, Some(41010), all_free), Some(41020));
    assert_eq!(pick_block(&used, Some(41005), all_free), Some(41020));
    assert_eq!(pick_block(&used, Some(3000), all_free), Some(41020));
}

#[test]
fn the_pick_skips_busy_blocks_but_only_so_many() {
    let none = HashSet::new();
    assert_eq!(pick_block(&none, None, |b| b >= 41030), Some(41030));
    // Everything listening: after MAX_BUSY_SKIPS it takes the next one.
    let after = RANGE_START + PORT_COUNT * MAX_BUSY_SKIPS as u16;
    assert_eq!(pick_block(&none, None, |_| false), Some(after));
    // Every block in use: none.
    let everything: HashSet<u16> = block_bases().collect();
    assert_eq!(pick_block(&everything, None, all_free), None);
}

#[test]
fn a_block_with_a_listening_port_is_not_free() {
    // A block nobody listens on, found the way the allocation looks.
    let (base, listener) =
        listening_in_free_block(44000, 7, |port| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)));
    assert!(!block_is_free(base));
    drop(listener);
    assert!(becomes_free(base));
}

/// Listens on 0.0.0.0, which can raise the macOS firewall's prompt when run
/// locally: run it on purpose (`cargo test -- --ignored`).
#[test]
#[ignore = "listens on 0.0.0.0 (macOS firewall prompt); run with --ignored"]
fn a_server_on_every_interface_is_seen() {
    let (base, any) =
        listening_in_free_block(45000, 3, |port| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)));
    assert!(!block_is_free(base), "0.0.0.0");
    drop(any);
    assert!(becomes_free(base));
}

/// [::1] is probed as well (a connect on macOS/Linux, an exclusive bind on
/// Windows).
#[test]
fn a_server_on_ipv6_loopback_is_seen() {
    // Only where this machine has IPv6 loopback.
    let v6 = |port| TcpListener::bind(std::net::SocketAddrV6::new(std::net::Ipv6Addr::LOCALHOST, port, 0, 0));
    if v6(0).is_ok() {
        let (base, v6) = listening_in_free_block(46000, 5, v6);
        assert!(!block_is_free(base), "[::1]");
        drop(v6);
        assert!(becomes_free(base));
    }
}

#[test]
fn probing_a_free_block_takes_well_under_a_second() {
    // Timed on a probe that itself answered "free": a block another probe
    // touched between the find and the measure moves the test on, it
    // doesn't fail it.
    for base in blocks_in_my_range(47000).into_iter().filter(|b| block_is_free(*b)).take(20) {
        let started = std::time::Instant::now();
        let free = block_is_free(base);
        let took = started.elapsed();
        if free {
            assert!(took < std::time::Duration::from_millis(500), "{took:?}");
            return;
        }
    }
    panic!("no block in 47000..48000 stayed free for one probe");
}

/// The probe runs with the board store free: a slow probe (Windows) never
/// holds every other board read and write up.
#[test]
fn allocation_probes_with_no_lock_held_and_rechecks_before_writing() {
    let b = Boards::new();
    let (wt1, wt2) = (b.wt("c1"), b.wt("c2"));
    let s = b.store();
    s.save("ws", vec![card("c1", "ws", Some(&wt1)), card("c2", "ws", Some(&wt2))]).unwrap();
    let probes = std::sync::atomic::AtomicUsize::new(0);
    let probe = |_: u16| {
        assert!(s.cache_is_free(), "probed under the kanban lock");
        probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        true
    };
    let (base, wrote) = s.ensure_port_base_probed("ws", "c1", None, &probe).unwrap();
    assert_eq!((base, wrote), (Some(41000), true));
    assert!(probes.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    // Taken while the probe ran: the re-check sees it and picks again.
    let raced = |b: u16| {
        if b == 41010 {
            s.with_card("ws", "c1", |c| {
                c.port_base = Some(41010);
                Ok(())
            })
            .unwrap();
        }
        true
    };
    let (base, wrote) = s.ensure_port_base_probed("ws", "c2", None, &raced).unwrap();
    assert_eq!((base, wrote), (Some(41000), true), "41010 was taken during the probe");
    assert_eq!(s.get_card("ws", "c2").unwrap().port_base, Some(41000));
    assert_ne!(s.get_card("ws", "c1").unwrap().port_base, s.get_card("ws", "c2").unwrap().port_base);
}

#[test]
fn only_a_card_worktree_is_a_worktree() {
    let ws = Path::new("/w/repo");
    let wt = ws.join(".plyloft-worktrees").join("card1");
    assert_eq!(worktree_of(&wt), Some((wt.clone(), "card1".into())));
    assert_eq!(worktree_of(&wt.join("src-tauri")), Some((wt.clone(), "card1".into())));
    let legacy = ws.join(".atelier-worktrees").join("c2-b");
    assert_eq!(worktree_of(&legacy.join("x")), Some((legacy.clone(), "c2-b".into())));
    assert_eq!(worktree_of(ws), None, "the main checkout");
    assert_eq!(worktree_of(&ws.join(".plyloft-worktrees")), None);
    assert_eq!(worktree_of(&ws.join(".plyloft-worktrees/.trash/card1")), None);
    assert_eq!(worktree_of(&ws.join(".plyloft-worktrees/.cargo-target")), None);
    assert_eq!(card_ids_for_dir("card1"), vec!["card1".to_string()]);
    assert_eq!(card_ids_for_dir("card1-b"), vec!["card1-b".to_string(), "card1".to_string()]);
    assert!(env_for_cwd(None).is_empty());
    assert!(env_for_cwd(Some(ws)).is_empty());
}

fn card(id: &str, ws: &str, worktree: Option<&Path>) -> KanbanCard {
    let mut c = KanbanCard::new(id.into(), ws.into(), format!("Card {id}"), None, KanbanColumnId::InProgress);
    c.worktree_path = worktree.map(|p| p.to_string_lossy().into_owned());
    c
}

struct Boards {
    _dir: tempfile::TempDir,
    config: PathBuf,
    repo: PathBuf,
}

impl Boards {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        Self { config, repo, _dir: dir }
    }
    fn wt(&self, dir: &str) -> PathBuf {
        let p = self.repo.join(".plyloft-worktrees").join(dir);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn store(&self) -> KanbanStore {
        KanbanStore::new(self.config.clone()).unwrap()
    }
}

#[test]
fn blocks_are_unique_across_every_board_and_freed_with_the_worktree() {
    let b = Boards::new();
    let (wt1, wt2, wt3) = (b.wt("c1"), b.wt("c2"), b.wt("c3"));
    {
        let s = b.store();
        let mut held = card("c1", "ws1", Some(&wt1));
        held.port_base = Some(41000);
        s.save("ws1", vec![held]).unwrap();
        s.save("ws2", vec![card("c2", "ws2", Some(&wt2)), card("c3", "ws2", Some(&wt3)), card("c4", "ws2", None)]).unwrap();
    }
    // A fresh store: ws1's board is on disk only, never loaded.
    let s = b.store();
    // The bookkeeping, not this machine, as for the freed block below: a real
    // probe that found 41010 taken would hand out 41020, and the freed block
    // then wouldn't be the lowest one (seen in the 1.174.3 gate).
    let first = s.ensure_port_base_probed("ws2", "c2", None, &all_free).unwrap().0.unwrap();
    assert_ne!(first, 41000, "ws1's card holds 41000");
    let second = s.ensure_port_base_probed("ws2", "c3", None, &all_free).unwrap().0.unwrap();
    assert_ne!(second, first);
    assert!(is_block_base(first) && is_block_base(second));
    // Persisted, and the same block again on the next ask.
    assert_eq!(s.get_card("ws2", "c2").unwrap().port_base, Some(first));
    assert_eq!(s.ensure_port_base("ws2", "c2", None).unwrap(), Some(first));
    assert_eq!(b.store().ensure_port_base("ws2", "c2", None).unwrap(), Some(first), "after a restart");
    // No worktree, no block.
    assert_eq!(s.ensure_port_base("ws2", "c4", None).unwrap(), None);
    assert!(s.ensure_port_base("ws2", "nope", None).is_err());
    // The worktree goes: its block is free for the next card.
    s.clear_worktree_handle("ws2", "c2").unwrap();
    s.with_card("ws2", "c4", |c| {
        c.worktree_path = Some(b.wt("c4").to_string_lossy().into_owned());
        Ok(())
    })
    .unwrap();
    // The bookkeeping, not this machine: a real probe here is answered by
    // whatever else listens on 41010–41019 at that moment (a Plyloft open on
    // this Mac with a card's dev server, another test binary probing the same
    // block — the 1.173.0 gate's 41030). The probe itself is tested above
    // (`a_block_with_a_listening_port_is_not_free`).
    let (reused, _) = s.ensure_port_base_probed("ws2", "c4", None, &all_free).unwrap();
    assert_eq!(reused, Some(first), "a freed block comes back");
    // ws1's board was read, not written.
    let ws1: serde_json::Value =
        serde_json::from_slice(&fs::read(b.config.join("kanban/workspaces/ws1.json")).unwrap()).unwrap();
    assert_eq!(ws1["cards"][0]["portBase"], 41000);
}

fn both_card(wta: &Path, wtb: &Path) -> KanbanCard {
    let mut c = card("c1", "ws", Some(wta));
    c.build_both = Some(crate::build_both::BuildBoth {
        started_at: 1,
        lanes: vec![
            crate::build_both::BuildLane { lane: "a".into(), worktree_path: wta.to_string_lossy().into(), ..Default::default() },
            crate::build_both::BuildLane { lane: "b".into(), worktree_path: wtb.to_string_lossy().into(), ..Default::default() },
        ],
        ..Default::default()
    });
    c
}

#[test]
fn a_build_with_both_lane_b_gets_a_block_of_its_own() {
    let b = Boards::new();
    let (wta, wtb) = (b.wt("c1"), b.wt("c1-b"));
    let s = b.store();
    s.save("ws", vec![both_card(&wta, &wtb)]).unwrap();
    let a = s.port_base_for_cwd(&wta.join("src")).unwrap();
    assert!(a.wrote, "handed out now");
    assert_eq!(a.workspace_id, "ws");
    // From a folder inside lane b's worktree: lane b's own block.
    fs::create_dir_all(wtb.join("apps/web")).unwrap();
    let lane_b = s.port_base_for_cwd(&wtb.join("apps/web")).unwrap();
    assert_ne!(a.base, lane_b.base);
    let saved = s.get_card("ws", "c1").unwrap();
    assert_eq!(saved.port_base, Some(a.base));
    assert_eq!(saved.build_both.unwrap().lane("b").unwrap().port_base, Some(lane_b.base));
    assert_eq!(s.ensure_port_base("ws", "c1", Some("a")).unwrap(), Some(a.base), "lane a is the card's own");
    // The next spawn there is answered without a write.
    assert_eq!(
        s.port_base_for_cwd(&wtb),
        Some(PortLookup { base: lane_b.base, workspace_id: "ws".into(), wrote: false })
    );
}

/// Picking lane b moves its block with its worktree: spawns there keep it,
/// and no other card can take it while b's server may still listen.
#[test]
fn picking_lane_b_keeps_its_block_on_the_card() {
    let b = Boards::new();
    let (wta, wtb) = (b.wt("c1"), b.wt("c1-b"));
    let s = b.store();
    s.save("ws", vec![both_card(&wta, &wtb), card("c2", "ws", Some(&b.wt("c2")))]).unwrap();
    // The bookkeeping, not this machine (as the reuse test above): with a
    // real probe, lane a's freed block is skipped whenever something else
    // listens on it at that moment — another test here holding a listener
    // on a free block, or a dev server; the 1.174.0 gate saw it once under
    // load.
    let a = s.ensure_port_base_probed("ws", "c1", None, &all_free).unwrap().0.unwrap();
    let lane_b = s.ensure_port_base_probed("ws", "c1", Some("b"), &all_free).unwrap().0.unwrap();
    s.with_card("ws", "c1", |c| {
        crate::build_both::apply_pick(c, "b", None, 2, crate::build_both::ArchivedLane::default())
    })
    .unwrap();
    let picked = s.get_card("ws", "c1").unwrap();
    assert_eq!(picked.worktree_path.as_deref(), Some(wtb.to_string_lossy().as_ref()));
    assert_eq!(picked.port_base, Some(lane_b));
    assert_eq!(s.port_base_for_cwd(&wtb.join("src")).map(|l| (l.base, l.wrote)), Some((lane_b, false)));
    // Another card gets lane a's freed block, never lane b's.
    let other = s.ensure_port_base_probed("ws", "c2", None, &all_free).unwrap().0.unwrap();
    assert_ne!(other, lane_b);
    assert_eq!(other, a, "lane a's block is the free one");
}

#[test]
fn a_worktree_made_before_ports_gets_its_block_on_first_spawn() {
    let b = Boards::new();
    let wt = b.wt("old");
    let s = b.store();
    s.save("ws", vec![card("old", "ws", Some(&wt))]).unwrap();
    assert_eq!(s.get_card("ws", "old").unwrap().port_base, None);
    let base = s.port_base_for_cwd(&wt).unwrap().base;
    assert_eq!(s.get_card("ws", "old").unwrap().port_base, Some(base));
    // Not a card's: nothing.
    assert_eq!(s.port_base_for_cwd(&b.wt("stranger")), None);
    assert_eq!(s.port_base_for_cwd(&b.repo), None);
}

/// Schema migration: a board from before `portBase` loads with none and
/// writes none back; a card with one keeps it through a save and load.
#[test]
fn an_old_board_loads_unchanged_and_a_port_base_round_trips() {
    let b = Boards::new();
    let dir = b.config.join("kanban/workspaces");
    fs::create_dir_all(&dir).unwrap();
    let old = r#"{"version":8,"cards":[{"id":"c1","workspaceId":"ws","title":"Old","columnId":"in_progress",
        "worktreePath":"/tmp/x/.plyloft-worktrees/c1","createdAt":1,"updatedAt":1,
        "buildBoth":{"startedAt":1,"lanes":[{"lane":"b","vendor":"codex","worktreePath":"/tmp/x/.plyloft-worktrees/c1-b","branchName":"b","bypass":false,"sessionLost":false,"resumeFailed":false}]}}]}"#;
    fs::write(dir.join("ws.json"), old).unwrap();
    let s = b.store();
    let cards = s.load("ws").unwrap();
    assert_eq!(cards[0].port_base, None);
    assert_eq!(cards[0].build_both.as_ref().unwrap().lanes[0].port_base, None);
    let json = serde_json::to_value(&cards[0]).unwrap();
    assert!(json.get("portBase").is_none(), "not written when absent");
    assert!(json["buildBoth"]["lanes"][0].get("portBase").is_none());

    let mut with = cards[0].clone();
    with.port_base = Some(41230);
    s.save("ws", vec![with]).unwrap();
    let reread: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("ws.json")).unwrap()).unwrap();
    assert_eq!(reread["cards"][0]["portBase"], 41230);
    assert_eq!(b.store().load("ws").unwrap()[0].port_base, Some(41230));
}

/// The variables reach a PTY session whose cwd is in a card worktree, and
/// only that one (`spawn_collect`: the same `env_for_cwd` call as `spawn`
/// and `spawn_with_capture`).
#[cfg(unix)]
#[test]
fn a_session_in_a_card_worktree_gets_its_ports_and_one_elsewhere_does_not() {
    use crate::coordination::*;
    crate::shell_env::init();
    let b = Boards::new();
    let wt = b.wt("envcard");
    let mine = std::fs::canonicalize(&wt).unwrap();
    install_resolver(Arc::new(move |cwd: &Path| {
        let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
        cwd.starts_with(&mine).then_some(41770)
    }));
    let registry = crate::pty::PtyRegistry::default();
    let run = |cwd: &Path| {
        let outcome = registry
            .spawn_collect(
                "/bin/sh",
                vec!["-c".into(), "echo \"ports=$PLYLOFT_PORT_BASE/$PLYLOFT_PORT_COUNT\"; echo \"path=$PATH\"".into()],
                Some(cwd.to_string_lossy().into_owned()),
                None,
                vec![("CARGO_TARGET_DIR".into(), "/tmp/t".into())],
                SpawnIntent {
                    provider: Provider::Claude,
                    execution_kind: ExecutionKind::ReviewerProbe,
                    attendance: Attendance::Unattended,
                    write_intent: WriteIntent::ReadOnly,
                    enforcement: Enforcement::Exempt,
                    project: SpawnProject::NonProject { reason: "worktree ports test".into() },
                    capability: None,
                    card_id: None,
                    swarm_id: None,
                    role_id: None,
                    run_id: None,
                    retention_class: RetentionClass::Ephemeral,
                    objective: None,
                },
                30,
            )
            .expect("spawn_collect");
        crate::verify::strip_ansi(&String::from_utf8_lossy(&outcome.output))
    };
    let inside = run(&wt);
    assert!(inside.contains("ports=41770/10"), "{inside}");
    // The cached PATH is still the session's PATH (Hard Rule #2).
    assert!(inside.contains(&format!("path={}", crate::shell_env::get().path)), "{inside}");
    let outside = run(&b.repo);
    assert!(outside.contains("ports=/"), "{outside}");
}

#[test]
fn every_spawn_path_in_a_worktree_asks_for_its_ports() {
    let src = |f: &str| fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f)).unwrap();
    let pty = src("pty.rs");
    assert_eq!(pty.matches("crate::worktree_ports::env_for_cwd(").count(), 3, "spawn, spawn_with_capture, spawn_collect");
    assert_eq!(pty.matches("session_env(&mut command, &env.path, true, &ports,").count(), 2);
    assert!(pty.contains("extra_env.into_iter().chain(ports)"));
    assert!(src("verify.rs").contains("job.build_env.extend(crate::worktree_ports::env_for_cwd("));
    assert!(src("codex_app.rs").contains("crate::worktree_ports::env_for_cwd("));
    let commands = src("commands.rs");
    assert!(commands.contains("store.ensure_port_base(workspace_id, card_id, pending.lane.as_deref())"));
    assert!(commands.contains("&ports,\n        Duration::from_secs(crate::worktree_setup::SETUP_TIMEOUT_SECS)"));
    assert!(src("lib.rs").contains("worktree_ports::install_resolver("));
}
