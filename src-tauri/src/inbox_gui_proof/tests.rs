use super::*;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, UnixDatagram) {
    let dir = tempfile::Builder::new()
        .prefix("igp")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = crate::platform::canonicalize(dir.path()).unwrap().join("p.sock");
    let receiver = UnixDatagram::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    set_buffer(&receiver, libc::SO_RCVBUF, 65536).unwrap();
    receiver
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    (dir, path, receiver)
}

fn observer(path: &Path) -> GuiInboxProof {
    GuiInboxProof::from_inputs(
        Some(path.as_os_str().to_owned()),
        Some("a".repeat(64).into()),
        Some("b".repeat(64).into()),
        &RequiredInboxSet::Fixed("c".repeat(64)),
    )
    .unwrap()
}

fn feed(licensed: bool) -> InboxFeed {
    InboxFeed {
        generated_at: 123,
        window_days: 14,
        events: vec![crate::inbox::InboxEvent {
            id: "SECRET-ID".into(),
            kind: crate::inbox::InboxEventKind::PrReview,
            group: crate::inbox::InboxGroup::NeedsYou,
            workspace_id: "SECRET-WORKSPACE".into(),
            workspace_name: "SECRET-NAME".into(),
            card_id: None,
            run_id: None,
            title: "SECRET-TITLE\n{\"forged\":true}".into(),
            detail: Some("SECRET-LICENSE".into()),
            url: Some("https://SECRET-URL".into()),
            at: None,
            seen_at: None,
            seen_eligible: true,
        }],
        cost_rollup: vec![],
        eligibility_proof: InboxEligibilityProof {
            generated_at: 123,
            licensed,
            resolved_user_sha256: "d".repeat(64),
            total_rows: 1,
            eligible_unseen_rows: 1,
            by_kind: Default::default(),
            by_group: Default::default(),
            eligible_unseen_set_sha256: "e".repeat(64),
            target_present: Some(true),
            admitted_pr_targets: 1,
            successful_pr_sources: 0,
            failed_pr_sources: 1,
            pr_sources_complete: false,
        },
        card_seen: Default::default(),
    }
}

fn receive(receiver: &UnixDatagram) -> serde_json::Value {
    let mut bytes = [0u8; MAX_BYTES + 1];
    let count = receiver.recv(&mut bytes).unwrap();
    assert!(count <= MAX_BYTES);
    assert!(!String::from_utf8_lossy(&bytes[..count]).contains("SECRET"));
    serde_json::from_slice(&bytes[..count]).unwrap()
}

#[test]
fn disabled_preserves_original_feed_and_errors_without_transport() {
    for required in [RequiredInboxSet::Absent, RequiredInboxSet::Invalid] {
        let disabled = GuiInboxProof::from_inputs(None, None, None, &required).unwrap();
        assert!(disabled.session.is_none());
        let result = disabled
            .observe(|target| {
                assert_eq!(target, None);
                Ok(feed(false))
            })
            .unwrap();
        assert_eq!(result.events[0].id, "SECRET-ID");
        assert_eq!(
            disabled
                .observe(|_| Err("original-error".into()))
                .unwrap_err(),
            "original-error"
        );
    }
}

#[test]
fn rejects_each_missing_or_malformed_input_and_constraint() {
    let (_dir, path, _receiver) = fixture();
    let valid = [
        path.into_os_string(),
        "a".repeat(64).into(),
        "b".repeat(64).into(),
    ];
    for mask in 1..7 {
        let input = |index: usize| {
            if mask & (1 << index) != 0 {
                Some(valid[index].clone())
            } else {
                None
            }
        };
        assert!(GuiInboxProof::from_inputs(
            input(0),
            input(1),
            input(2),
            &RequiredInboxSet::Fixed("c".repeat(64))
        )
        .is_err());
    }
    for index in 0..3 {
        for malformed in [OsString::new(), OsString::from_vec(vec![0xff])] {
            let mut inputs = valid.clone();
            inputs[index] = malformed;
            assert!(GuiInboxProof::from_inputs(
                Some(inputs[0].clone()),
                Some(inputs[1].clone()),
                Some(inputs[2].clone()),
                &RequiredInboxSet::Fixed("c".repeat(64))
            )
            .is_err());
        }
    }
    for index in [1, 2] {
        for malformed in [
            "A".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
        ] {
            let mut inputs = valid.clone();
            inputs[index] = malformed.into();
            assert!(GuiInboxProof::from_inputs(
                Some(inputs[0].clone()),
                Some(inputs[1].clone()),
                Some(inputs[2].clone()),
                &RequiredInboxSet::Fixed("c".repeat(64))
            )
            .is_err());
        }
    }
    for constraint in [
        RequiredInboxSet::Absent,
        RequiredInboxSet::Invalid,
        RequiredInboxSet::Fixed("bad".into()),
    ] {
        assert!(GuiInboxProof::from_inputs(
            Some(valid[0].clone()),
            Some(valid[1].clone()),
            Some(valid[2].clone()),
            &constraint
        )
        .is_err());
    }
}

#[test]
fn path_type_permissions_alias_and_disconnection_guards() {
    let (dir, path, receiver) = fixture();
    let wrong_uid = unsafe { libc::geteuid() }.wrapping_add(1);
    assert!(private_identity(&path, true, wrong_uid).is_err());
    assert!(private_identity(path.parent().unwrap(), false, wrong_uid).is_err());
    assert!(connect_private(Path::new("relative.sock")).is_err());
    assert!(connect_private(&path.parent().unwrap().join("../p.sock")).is_err());
    assert!(connect_private(&path.with_file_name("missing")).is_err());
    let file = path.with_file_name("regular");
    std::fs::write(&file, b"unchanged").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(connect_private(&file).is_err());
    let alias = path.with_file_name("alias");
    symlink(&path, &alias).unwrap();
    assert!(connect_private(&alias).is_err());
    for mode in [0o660, 0o604, 0o700, 0o4600] {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(connect_private(&path).is_err(), "socket mode {mode:o}");
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    for mode in [0o750, 0o704, 0o600, 0o1700] {
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(connect_private(&path).is_err(), "parent mode {mode:o}");
    }
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let other = tempfile::tempdir().unwrap();
    let parent_alias = other.path().join("alias");
    symlink(path.parent().unwrap(), &parent_alias).unwrap();
    assert!(connect_private(&parent_alias.join("p.sock")).is_err());
    assert!(connect_private(&path).is_ok());
    drop(receiver);
    // A stream socket passes the file-shape guards but deterministically
    // fails the datagram connect syscall, without racing inherited fork FDs.
    let wrong_type = path.with_file_name("stream.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&wrong_type).unwrap();
    std::fs::set_permissions(&wrong_type, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(connect_private(&wrong_type).is_err());
    assert_eq!(std::fs::read(file).unwrap(), b"unchanged");
}

#[test]
fn typed_redaction_sequence_and_incomplete_lapsed_proofs_are_delivered() {
    let (_dir, path, receiver) = fixture();
    let observer = observer(&path);
    for (index, licensed) in [true, false, true].into_iter().enumerate() {
        let output = observer
            .observe(|target| {
                assert_eq!(target, Some("b".repeat(64).as_str()));
                Ok(feed(licensed))
            })
            .unwrap();
        let record = receive(&receiver);
        assert_eq!(record.as_object().unwrap().len(), 9);
        assert_eq!(record["schemaVersion"], 1);
        assert_eq!(record["session"], "a".repeat(64));
        assert_eq!(record["processId"], std::process::id());
        assert_eq!(record["sequence"], index + 1);
        assert_eq!(record["requiredSetSha256"], "c".repeat(64));
        assert_eq!(record["targetSha256"], "b".repeat(64));
        assert!(
            record["emittedElapsedMs"].as_u64().unwrap()
                >= record["assemblyStartedElapsedMs"].as_u64().unwrap()
        );
        assert_eq!(
            record["proof"],
            serde_json::to_value(output.eligibility_proof).unwrap()
        );
    }
}

#[test]
fn real_datagram_maximum_and_nonblocking_full_queue() {
    let (_dir, path, receiver) = fixture();
    let sender = connect_private(&path).unwrap();
    let payload = vec![b'x'; MAX_BYTES];
    assert_eq!(sender.send(&payload).unwrap(), MAX_BYTES);
    let mut received = vec![0; MAX_BYTES + 1];
    assert_eq!(receiver.recv(&mut received).unwrap(), MAX_BYTES);
    assert_eq!(&received[..MAX_BYTES], &payload);
    let flags = unsafe { libc::fcntl(sender.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0 && flags & libc::O_NONBLOCK != 0);
    // Bound the fixture too; absence of nonblocking is caught above, before send.
    let mut full = false;
    for _ in 0..512 {
        match sender.send(&payload) {
            Ok(size) => assert_eq!(size, MAX_BYTES),
            Err(error) => {
                assert!(
                    matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::ENOBUFS)),
                    "unexpected queue error: {error}"
                );
                full = true;
                break;
            }
        }
    }
    assert!(full, "finite receiver queue must refuse without blocking");
}

#[test]
fn failure_latches_before_assembly_and_never_resumes() {
    let (_dir, path, receiver) = fixture();
    let observer = observer(&path);
    assert_eq!(
        observer
            .observe(|_| Err("SECRET failure".into()))
            .unwrap_err(),
        OBSERVATION_ERROR
    );
    assert_eq!(
        observer
            .observe(|_| panic!("latched closure must not run"))
            .unwrap_err(),
        OBSERVATION_ERROR
    );
    receiver.set_nonblocking(true).unwrap();
    assert!(receiver.recv(&mut [0u8; MAX_BYTES]).is_err());
}

#[test]
fn receiver_loss_and_queue_full_permanently_fail_observation() {
    for disconnect in [false, true] {
        let (_dir, path, receiver) = fixture();
        let observer = observer(&path);
        if disconnect {
            // shutdown a connected peer rather than relying on drop: another
            // concurrently forking fixture may briefly inherit a CLOEXEC fd.
            let (sender, peer) = UnixDatagram::pair().unwrap();
            sender.set_nonblocking(true).unwrap();
            observer.session.as_ref().unwrap().lock().unwrap().socket = sender;
            peer.shutdown(std::net::Shutdown::Both).unwrap();
            drop(peer);
            drop(receiver);
        } else {
            let filler = connect_private(&path).unwrap();
            assert!(
                unsafe { libc::fcntl(filler.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK != 0
            );
            let mut full = false;
            // Small datagrams exhaust mbuf capacity too, leaving no room for
            // the smaller real proof after a rejected maximum-size payload.
            for _ in 0..4096 {
                if filler.send(&[0]).is_err() {
                    full = true;
                    break;
                }
            }
            assert!(full);
            // Deliberately retain the full queue through the observed send.
            assert!(observer.observe(|_| Ok(feed(true))).is_err());
            let mut bytes = [0; MAX_BYTES];
            receiver.set_nonblocking(true).unwrap();
            while receiver.recv(&mut bytes).is_ok() {}
        }
        assert!(observer.observe(|_| Ok(feed(true))).is_err());
        assert!(observer.observe(|_| panic!("cannot resume")).is_err());
    }
}

#[test]
fn count_size_and_both_age_bounds_fail_closed() {
    assert_eq!(MAX_RECORDS, 128);
    assert_eq!(MAX_BYTES, 8192);
    assert_eq!(MAX_AGE, Duration::from_secs(600));
    let (_dir, path, receiver) = fixture();
    let capped = observer(&path);
    for _ in 0..MAX_RECORDS {
        capped.observe(|_| Ok(feed(true))).unwrap();
        receive(&receiver);
    }
    assert!(capped
        .observe(|_| panic!("record cap before assembly"))
        .is_err());

    for oversized in [false, true] {
        let observer = observer(&path);
        let mut session = observer.session.as_ref().unwrap().lock().unwrap();
        let mut calls = 0;
        let result = session.capture(
            |_| {
                let mut value = feed(true);
                if oversized {
                    value.eligibility_proof.by_kind.insert(
                        "x".repeat(MAX_BYTES),
                        crate::inbox::InboxProofCount {
                            total: 0,
                            eligible_unseen: 0,
                        },
                    );
                }
                Ok(value)
            },
            || {
                calls += 1;
                if !oversized && calls == 2 {
                    MAX_AGE
                } else {
                    Duration::ZERO
                }
            },
        );
        assert!(result.is_err());
        assert!(session.failed);
        assert_eq!(session.sequence, 0);
    }
    let observer = observer(&path);
    let mut session = observer.session.as_ref().unwrap().lock().unwrap();
    assert!(session
        .capture(|_| panic!("age cap before assembly"), || MAX_AGE)
        .is_err());
    assert!(session.failed);
}

#[test]
fn concurrent_observed_assemblies_are_serial_and_sequences_are_contiguous() {
    let (_dir, path, receiver) = fixture();
    let observer = std::sync::Arc::new(observer(&path));
    let busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut threads = Vec::new();
    for _ in 0..8 {
        let observer = observer.clone();
        let busy = busy.clone();
        threads.push(std::thread::spawn(move || {
            observer
                .observe(|_| {
                    assert!(!busy.swap(true, std::sync::atomic::Ordering::SeqCst));
                    std::thread::yield_now();
                    assert!(busy.swap(false, std::sync::atomic::Ordering::SeqCst));
                    Ok(feed(true))
                })
                .unwrap();
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
    for sequence in 1..=8 {
        assert_eq!(receive(&receiver)["sequence"], sequence);
    }
}

#[test]
fn poisoned_observer_mutex_never_runs_another_assembly() {
    let (_dir, path, _receiver) = fixture();
    let observer = observer(&path);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = observer.session.as_ref().unwrap().lock().unwrap();
        panic!("fixture poisoning");
    }));
    assert!(observer.observe(|_| panic!("must not run")).is_err());
}
