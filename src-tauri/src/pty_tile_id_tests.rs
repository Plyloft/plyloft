use super::*;

#[test]
fn no_requested_id_gets_a_new_uuid() {
    let a = tile_pty_id(None).unwrap();
    let b = tile_pty_id(None).unwrap();
    assert_ne!(a, b);
    assert_eq!(uuid::Uuid::parse_str(&a).unwrap().hyphenated().to_string(), a);
}

#[test]
fn a_canonical_v4_uuid_is_kept_as_it_is_once() {
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(tile_pty_id(Some(&id)).unwrap(), id);
    // Never handed out again in this run, live or not.
    assert_eq!(tile_pty_id(Some(&id)).unwrap_err(), PTY_ID_IN_USE);
}

#[test]
fn anything_but_a_canonical_v4_uuid_is_refused() {
    for bad in [
        "",
        " ",
        "pty-1",
        "00000000-0000-0000-0000-000000000000",
        // version 1, version 7
        "0f8fad5b-d9cb-11ef-a165-70867728950e",
        "0190f8fa-d9cb-7ef0-a165-70867728950e",
        "0F8FAD5B-D9CB-469F-A165-70867728950E",
        "0f8fad5bd9cb469fa16570867728950e",
        "{0f8fad5b-d9cb-469f-a165-70867728950e}",
        " 0f8fad5b-d9cb-469f-a165-70867728950e",
        "urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e",
    ] {
        assert!(valid_tile_id(bad).is_err(), "{bad:?}");
    }
    assert!(valid_tile_id("0f8fad5b-d9cb-469f-a165-70867728950e").is_ok());
}

#[test]
fn the_claims_are_bounded() {
    let mut claims = Claims::default();
    assert!(claims.claim("a", 2));
    assert!(!claims.claim("a", 2));
    assert!(claims.claim("b", 2));
    assert!(claims.claim("c", 2));
    assert_eq!(claims.len(), 2);
    // The oldest is forgotten past the bound; the newer ones are not.
    assert!(!claims.claim("c", 2));
    assert!(claims.claim("a", 2));
}

#[cfg(unix)]
fn shell_intent() -> crate::coordination::SpawnIntent {
    use crate::coordination::*;
    SpawnIntent {
        provider: Provider::Shell,
        execution_kind: ExecutionKind::ShellTile,
        attendance: Attendance::HumanAttended,
        write_intent: WriteIntent::Unknown,
        enforcement: Enforcement::Exempt,
        project: SpawnProject::NonProject { reason: "pty id test".into() },
        capability: None,
        card_id: None,
        swarm_id: None,
        role_id: None,
        run_id: None,
        retention_class: RetentionClass::Interactive,
        objective: None,
    }
}

/// The point of the id: a listener registered before the spawn hears a
/// process that prints and exits at once — every byte, then the exit — and
/// a second spawn under the same live id never starts.
#[cfg(unix)]
#[test]
fn a_listener_registered_before_the_spawn_hears_an_instant_exit_whole() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;
    crate::shell_env::init();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = crate::pty::PtyRegistry::default();
    let id = uuid::Uuid::new_v4().to_string();
    let data: Arc<Mutex<Vec<u8>>> = Arc::default();
    let exit: Arc<Mutex<Option<Option<i32>>>> = Arc::default();
    {
        let (data, id) = (Arc::clone(&data), id.clone());
        app.listen_any("pty://data", move |e| {
            let ev: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            if ev["id"] == id.as_str() {
                let bytes: Vec<u8> = serde_json::from_value(ev["data"].clone()).unwrap();
                data.lock().unwrap().extend(bytes);
            }
        });
    }
    {
        let (exit, data, id) = (Arc::clone(&exit), Arc::clone(&data), id.clone());
        app.listen_any("pty://exit", move |e| {
            let ev: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            if ev["id"] == id.as_str() {
                // The output is all in before the exit (`await_stream_drained`).
                assert!(String::from_utf8_lossy(&data.lock().unwrap()).contains("dead on arrival"));
                *exit.lock().unwrap() = Some(ev["code"].as_i64().map(|c| c as i32));
            }
        });
    }
    let spawn = |script: &str| {
        registry.spawn_tile(
            app.handle().clone(),
            "/bin/sh",
            vec!["-c".into(), script.into()],
            None,
            None,
            shell_intent(),
            80,
            24,
            None,
            Some(id.clone()),
        )
    };
    let started = match spawn("echo dead on arrival; exit 3") {
        Ok(started) => started,
        Err(e) => {
            eprintln!("skipped: no PTY here ({e})");
            return;
        }
    };
    assert_eq!(started, id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while exit.lock().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "no exit event");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(*exit.lock().unwrap(), Some(Some(3)));
    assert!(String::from_utf8_lossy(&data.lock().unwrap()).contains("dead on arrival"));

    // The exited session stays registered until it is killed or forgotten:
    // the same id is refused, and nothing is spawned for it.
    assert!(registry.contains(&id), "an exited tile's session waits for its kill");
    assert_eq!(spawn("sleep 30").unwrap_err(), PTY_ID_IN_USE);
    // Its records keep the id after the kill: it is never used again.
    registry.kill(&id).unwrap();
    assert!(!registry.contains(&id));
    assert_eq!(spawn("sleep 30").unwrap_err(), PTY_ID_IN_USE);
    registry.kill_all();
}

#[cfg(unix)]
#[test]
fn a_malformed_requested_id_starts_nothing() {
    crate::shell_env::init();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = crate::pty::PtyRegistry::default();
    let refused = registry.spawn_tile(
        app.handle().clone(),
        "/bin/sh",
        vec!["-c".into(), "sleep 30".into()],
        None,
        None,
        shell_intent(),
        80,
        24,
        None,
        Some("not-a-uuid".into()),
    );
    assert!(refused.is_err());
    assert!(!registry.contains("not-a-uuid"));
}

/// Two spawns racing for one requested id: exactly one starts, and nothing
/// of the other ever reaches a listener under that id (it never ran).
#[cfg(unix)]
#[test]
fn two_spawns_racing_for_one_id_start_one_child_and_leak_no_output() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;
    crate::shell_env::init();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = Arc::new(crate::pty::PtyRegistry::default());
    let id = uuid::Uuid::new_v4().to_string();
    let data: Arc<Mutex<Vec<u8>>> = Arc::default();
    {
        let (data, id) = (Arc::clone(&data), id.clone());
        app.listen_any("pty://data", move |e| {
            let ev: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            if ev["id"] == id.as_str() {
                let bytes: Vec<u8> = serde_json::from_value(ev["data"].clone()).unwrap();
                data.lock().unwrap().extend(bytes);
            }
        });
    }
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let racers: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|mark| {
            let (registry, app, id, barrier) = (Arc::clone(&registry), app.handle().clone(), id.clone(), Arc::clone(&barrier));
            std::thread::spawn(move || {
                barrier.wait();
                registry
                    .spawn_tile(
                        app,
                        "/bin/sh",
                        vec!["-c".into(), format!("echo racer-{mark}; sleep 2")],
                        None,
                        None,
                        shell_intent(),
                        80,
                        24,
                        None,
                        Some(id),
                    )
                    .map(|_| mark)
            })
        })
        .collect();
    let results: Vec<Result<&str, String>> = racers.into_iter().map(|t| t.join().unwrap()).collect();
    if results.iter().any(|r| matches!(r, Err(e) if e.starts_with("openpty"))) {
        eprintln!("skipped: no PTY here");
        return;
    }
    let won: Vec<&str> = results.iter().filter_map(|r| r.as_ref().ok().copied()).collect();
    assert_eq!(won.len(), 1, "{results:?}");
    assert!(results.iter().any(|r| r.as_ref().err().map(String::as_str) == Some(PTY_ID_IN_USE)));
    let lost = if won[0] == "one" { "racer-two" } else { "racer-one" };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !String::from_utf8_lossy(&data.lock().unwrap()).contains(&format!("racer-{}", won[0])) {
        assert!(std::time::Instant::now() < deadline, "the winner's output never came");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!String::from_utf8_lossy(&data.lock().unwrap()).contains(lost), "the loser's output leaked");
    registry.kill_all();
}
