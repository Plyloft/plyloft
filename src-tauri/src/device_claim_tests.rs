use super::*;

const REPO: &str = "o/r";

fn me() -> ThisDevice {
    ThisDevice { id: "uuid-mini".into(), name: "Matteo's Mac mini".into() }
}

/// This computer in `REPO`'s markers.
fn mine() -> String {
    repo_device_id("uuid-mini", REPO)
}

fn me_here() -> MarkerSelf {
    MarkerSelf { id: "dev-mini".into(), name: "Mac mini".into() }
}

fn claim(device: &str, name: &str, at: &str) -> DeviceClaim {
    DeviceClaim { device: device.into(), name: name.into(), login: Some("matteo".into()), at: at.into() }
}

const BODIES: &[&str] = &[
    "",
    "plain text",
    "plain text\n",
    "<!-- atelier:notes -->\nThe brief\n<!-- /atelier:notes -->\n",
    "<!-- atelier:notes -->\nThe brief\n<!-- /atelier:notes -->\n\n<!-- atelier:knowledge -->\nK\n<!-- /atelier:knowledge -->\n\nfreeform",
    "line one\r\nline two\r\n",
    "trailing spaces   \n\n\n",
];

#[test]
fn the_marker_round_trips_and_leaves_every_other_byte_alone() {
    let c = claim("dev-pro", "MacBook Pro", "2026-10-30T08:00:00Z");
    for body in BODIES {
        let with = with_claim(body, Some(&c));
        assert!(with.starts_with(body), "the body is kept as it was: {body:?}");
        assert_eq!(parse(&with), Some(c.clone()), "{with:?}");
        assert_eq!(without_marker(&with), *body, "removing gives back the same bytes");
        assert_eq!(with_claim(&with, None), *body);
        // Moving it (take over) rewrites it in place.
        let moved = with_claim(&with, Some(&claim("dev-mini", "Mac mini", "2026-10-30T10:00:00Z")));
        assert_eq!(parse(&moved).unwrap().device, "dev-mini");
        assert_eq!(without_marker(&moved), *body);
        assert_eq!(moved.matches(OPEN).count(), 1);
    }
}

#[test]
fn a_marker_in_the_middle_is_rewritten_where_it_is() {
    let body = format!("top\n{}\nbottom\n", marker(&claim("a", "A", "t1")));
    let next = with_claim(&body, Some(&claim("b", "B", "t2")));
    assert_eq!(next, format!("top\n{}\nbottom\n", marker(&claim("b", "B", "t2"))));
    assert_eq!(without_marker(&body), "top\nbottom\n");
}

#[test]
fn the_marker_reads_the_documented_shape() {
    let body = "x\n<!-- plyloft:claim device=4f1c name=\"Matteo's Mac mini\" at=2026-10-30T08:00:00Z -->";
    assert_eq!(
        parse(body),
        Some(DeviceClaim {
            device: "4f1c".into(),
            name: "Matteo's Mac mini".into(),
            login: None,
            at: "2026-10-30T08:00:00Z".into()
        })
    );
    assert_eq!(parse("<!-- plyloft:claim name=\"x\" -->"), None, "no device, no claim");
    assert_eq!(parse("no marker"), None);
}

#[test]
fn a_name_never_breaks_out_of_the_marker() {
    let c = claim("d", "Evil\" --> <b>\nName", "t");
    let text = marker(&c);
    assert_eq!(text.matches("-->").count(), 1, "{text}");
    assert!(!text.contains('\n'));
    let read = parse(&text).unwrap();
    assert_eq!(read.device, "d");
    assert_eq!(read.name, "Evil' - b Name");
}

#[test]
fn the_issue_text_kept_outside_the_blocks_never_holds_the_marker() {
    let c = claim("dev-pro", "MacBook Pro", "t");
    let body = with_claim(&crate::github::build_issue_body(Some("n"), None, Some("human")), Some(&c));
    let parsed = crate::github::parse_issue_body(&body);
    assert_eq!(parsed.notes.as_deref(), Some("n"));
    assert_eq!(parsed.raw_remainder.as_deref(), Some("human"));
    // A body with only the marker has nothing to adopt as a brief.
    let only = with_claim("", Some(&c));
    assert_eq!(crate::github::parse_issue_body(&only).raw_remainder, None);
}

#[test]
fn a_rebuilt_body_carries_the_cards_marker() {
    let mut card = crate::kanban::KanbanCard::new(
        "c".into(),
        "ws".into(),
        "T".into(),
        Some("brief".into()),
        crate::kanban::KanbanColumnId::InProgress,
    );
    assert!(!card_issue_body(&card, None).contains(OPEN));
    card.gh_claim = Some(claim("dev-pro", "MacBook Pro", "t"));
    let body = card_issue_body(&card, card.gh_claim.as_ref());
    assert_eq!(parse(&body), card.gh_claim);
    assert_eq!(crate::github::parse_issue_body(&body).notes.as_deref(), Some("brief"));
}

#[test]
fn claim_release_and_take_over_follow_the_rules() {
    let now = "2026-10-30T10:00:00Z";
    // Free: this computer's goes on.
    let fresh = next_claim(None, &me_here(), "matteo", ClaimHere::IfFree, now).unwrap();
    assert_eq!((fresh.device.as_str(), fresh.name.as_str(), fresh.at.as_str()), ("dev-mini", "Mac mini", now));
    assert_eq!(fresh.login.as_deref(), Some("matteo"));
    // Already mine: nothing to write.
    assert_eq!(next_claim(Some(&fresh), &me_here(), "matteo", ClaimHere::IfFree, "later"), None);
    // Mine under an older name: renamed, keeping when it was taken.
    let old = claim("dev-mini", "Old name", "2026-10-29T00:00:00Z");
    let renamed = next_claim(Some(&old), &me_here(), "matteo", ClaimHere::IfFree, now).unwrap();
    assert_eq!((renamed.name.as_str(), renamed.at.as_str()), ("Mac mini", "2026-10-29T00:00:00Z"));
    // Another computer's: kept (Start here too), moved on Take it over here.
    let other = claim("dev-pro", "MacBook Pro", "2026-10-30T08:00:00Z");
    assert_eq!(next_claim(Some(&other), &me_here(), "matteo", ClaimHere::IfFree, now), None);
    let taken = next_claim(Some(&other), &me_here(), "matteo", ClaimHere::TakeOver, now).unwrap();
    assert_eq!((taken.device.as_str(), taken.at.as_str()), ("dev-mini", now));
}

fn issue_json(number: u64, body: &str) -> String {
    serde_json::json!({
        "number": number, "title": "Search terms", "body": body,
        "assignees": [{"login": "matteo"}], "labels": [], "state": "OPEN", "updatedAt": ""
    })
    .to_string()
}

fn issue(number: u64, body: &str) -> crate::github::GhIssue {
    serde_json::from_str(&issue_json(number, body)).unwrap()
}

#[test]
fn a_claim_on_the_issue_reads_it_again_and_edits_only_its_body_on_stdin() {
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let _ = crate::github::take_test_gh_invocations();
    let _ = crate::github::take_test_gh_stdin();
    let body = "<!-- atelier:notes -->\nThe brief\n<!-- /atelier:notes -->\n";
    crate::github::set_test_gh_responses(vec![Ok(issue_json(7, body)), Ok(String::new())]);
    let after = claim_on_issue(REPO, &issue(7, body), "matteo", ClaimHere::IfFree, false).unwrap().unwrap();
    assert_eq!(after.device, mine());
    assert_eq!(after.name, "Mac mini", "the owner is not published");
    let calls = crate::github::take_test_gh_invocations();
    assert_eq!(calls.len(), 2, "read again, then the write");
    assert_eq!(&calls[0][..3], &["issue", "view", "7"]);
    assert_eq!(calls[1], ["issue", "edit", "7", "--repo", REPO, "--body-file", "-"]);
    let fed = crate::github::take_test_gh_stdin();
    assert_eq!(without_marker(&fed[0]), body, "byte-identical apart from the marker");
    assert_eq!(parse(&fed[0]), Some(after));

    // Another computer's marker: Start here too writes nothing, reads nothing.
    let theirs = with_claim(body, Some(&claim("dev-pro", "MacBook Pro", "t")));
    crate::github::set_test_gh_responses(vec![]);
    let kept = claim_on_issue(REPO, &issue(7, &theirs), "matteo", ClaimHere::IfFree, false).unwrap();
    assert_eq!(kept.unwrap().device, "dev-pro");
    assert!(crate::github::take_test_gh_invocations().is_empty());

    // Taken over on the other Mac since our read: decided from the fresh read.
    crate::github::set_test_gh_responses(vec![Ok(issue_json(7, &theirs))]);
    let raced = claim_on_issue(REPO, &issue(7, body), "matteo", ClaimHere::IfFree, false).unwrap();
    assert_eq!(raced.unwrap().device, "dev-pro", "the other Mac's newer claim stands");
    assert_eq!(crate::github::take_test_gh_invocations().len(), 1, "read only");

    // Take it over here: moved, the rest of the body as it was.
    crate::github::set_test_gh_responses(vec![Ok(issue_json(7, &theirs)), Ok(String::new())]);
    let taken = claim_on_issue(REPO, &issue(7, &theirs), "matteo", ClaimHere::TakeOver, false).unwrap();
    assert_eq!(taken.unwrap().device, mine());
    let fed = crate::github::take_test_gh_stdin();
    assert_eq!(without_marker(&fed[0]), body);
    crate::github::clear_test_gh_responses();
    set_test_device(None);
}

#[test]
fn a_release_takes_only_this_computers_marker_off() {
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let _ = crate::github::take_test_gh_invocations();
    let _ = crate::github::take_test_gh_stdin();
    let body = "brief\n";
    let here = with_claim(body, Some(&claim(&mine(), "Mac mini", "t")));
    crate::github::set_test_gh_responses(vec![Ok(issue_json(9, &here)), Ok(String::new())]);
    assert_eq!(release_on_issue(REPO, 9).unwrap(), None);
    assert_eq!(crate::github::take_test_gh_invocations().len(), 2);
    assert_eq!(crate::github::take_test_gh_stdin(), vec![body.to_string()], "byte-identical without the marker");

    let theirs = with_claim(body, Some(&claim("dev-pro", "MacBook Pro", "t")));
    crate::github::set_test_gh_responses(vec![Ok(issue_json(9, &theirs))]);
    assert_eq!(release_on_issue(REPO, 9).unwrap().unwrap().device, "dev-pro");
    assert_eq!(crate::github::take_test_gh_invocations().len(), 1, "read only, nothing written");
    crate::github::clear_test_gh_responses();
    set_test_device(None);
}

#[test]
fn without_a_known_computer_nothing_is_written() {
    let _serial = crate::github::test_serial_lock();
    set_test_device(None);
    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![]);
    assert_eq!(claim_on_issue(REPO, &issue(1, "b"), "matteo", ClaimHere::TakeOver, false).unwrap(), None);
    assert!(crate::github::take_test_gh_invocations().is_empty());
    crate::github::clear_test_gh_responses();
}

fn card_in(column: crate::kanban::KanbanColumnId, cached: Option<DeviceClaim>) -> crate::kanban::KanbanCard {
    let mut card = crate::kanban::KanbanCard::new("c".into(), "ws".into(), "T".into(), Some("brief".into()), column);
    card.gh_issue_number = Some(4);
    card.gh_claim = cached;
    card
}

/// Challenger 1: a rebuild copies the marker GitHub has now, never the
/// card's cached one, and drops only this computer's on a settled card.
#[test]
fn a_rebuilt_body_carries_the_live_marker_not_the_cached_one() {
    use crate::kanban::KanbanColumnId::{Complete, InProgress, Todo};
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let _ = crate::github::take_test_gh_invocations();
    let a = claim("dev-a", "MacBook Pro", "t1");
    let b = claim("dev-b", "Mac Studio", "t2");
    let here = claim(&mine(), "Mac mini", "t3");
    let live_body = |c: Option<&DeviceClaim>| issue_json(4, &with_claim("old", c));
    // Cached B, live A: A stays.
    crate::github::set_test_gh_responses(vec![Ok(live_body(Some(&a)))]);
    let (body, kept) = rebuilt_body(REPO, 4, &card_in(InProgress, Some(b.clone()))).unwrap();
    assert_eq!((parse(&body), kept), (Some(a.clone()), Some(a.clone())));
    // Cached A, live none: none.
    crate::github::set_test_gh_responses(vec![Ok(live_body(None))]);
    let (body, kept) = rebuilt_body(REPO, 4, &card_in(InProgress, Some(a.clone()))).unwrap();
    assert_eq!((parse(&body), kept), (None, None));
    // Done (or Ready to start), live this Mac's: dropped in the same write.
    for column in [Complete, Todo] {
        crate::github::set_test_gh_responses(vec![Ok(live_body(Some(&here)))]);
        let (body, kept) = rebuilt_body(REPO, 4, &card_in(column, None)).unwrap();
        assert_eq!((parse(&body), kept), (None, None));
    }
    // Done, live another Mac's: kept.
    crate::github::set_test_gh_responses(vec![Ok(live_body(Some(&a)))]);
    assert_eq!(rebuilt_body(REPO, 4, &card_in(Complete, None)).unwrap().1, Some(a));
    // Unreadable: no guessed marker, an error for the caller.
    crate::github::set_test_gh_responses(vec![Err("offline".into())]);
    assert!(rebuilt_body(REPO, 4, &card_in(InProgress, Some(b))).is_err());
    crate::github::clear_test_gh_responses();
    set_test_device(None);
}

#[test]
fn only_a_marker_that_starts_a_line_outside_the_blocks_counts() {
    let c = claim("dev-pro", "MacBook Pro", "t");
    let inside = format!("<!-- atelier:notes -->\n{}\n<!-- /atelier:notes -->\n", marker(&c));
    assert_eq!(parse(&inside), None, "text in the brief is not a claim");
    assert_eq!(without_marker(&inside), inside);
    assert!(with_claim(&inside, Some(&c)).ends_with(&format!("{}\n", marker(&c))));
    let mid_line = format!("see {} here", marker(&c));
    assert_eq!(parse(&mid_line), None);
    // Two markers: the last is live; a write leaves exactly one.
    let two = format!("{}\nbody\n{}\n", marker(&claim("old", "A", "t0")), marker(&c));
    assert_eq!(parse(&two), Some(c.clone()));
    let one = with_claim(&two, Some(&claim("new", "B", "t9")));
    assert_eq!(one.matches(OPEN).count(), 1);
    assert_eq!(parse(&one).unwrap().device, "new");
    assert_eq!(without_marker(&two), "body\n");
}

#[test]
fn names_are_published_without_their_owner() {
    // 1.175.0 (E-app round 2): the rule is `account::model_label`'s (tested
    // there): a marker carries the Mac model, or the platform's word, never
    // the computer's own name — which reaches teammates, and everyone on a
    // public repository.
    if std::env::var("PLYLOFT_DEVICE_NAME").is_err() {
        assert_eq!(shared_device_name("Matteo's \"Mac\" mini"), "Mac mini");
        assert_eq!(shared_device_name("Mac mini di Matteo"), "Mac mini");
        assert_eq!(shared_device_name("MacBook-Pro-di-Matteo"), "MacBook Pro");
        let word = crate::account::model_label("", if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" });
        assert_eq!(shared_device_name("Studio di Marta"), word, "no model: the platform's word");
        assert_eq!(shared_device_name("Matteo"), word);
        // What this computer writes changes; a marker another computer (or
        // an older Plyloft) wrote with a full name is still read as it is.
        let old = "<!-- plyloft:claim device=0123456789abcdef name=\"Studio di Marta\" login=marta at=2026-11-01T10:00:00Z -->";
        assert_eq!(parse(old).map(|c| c.name).as_deref(), Some("Studio di Marta"));
        // The marker's name reads as the card's line does: "On your MacBook Pro".
        let me = MarkerSelf { id: "0123456789abcdef".into(), name: shared_device_name("Matteo's MacBook Pro (2)") };
        let claim = next_claim(None, &me, "matteo", ClaimHere::IfFree, "2026-11-09T10:00:00Z").unwrap();
        assert_eq!(claim.name, "MacBook Pro");
    }
}

#[test]
fn a_marker_carries_a_per_repository_id_never_the_uuid() {
    let id = repo_device_id("uuid-mini", "Owner/Repo");
    assert_eq!(id.len(), 16);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(id, repo_device_id("uuid-mini", "owner/repo"), "the repository's case doesn't matter");
    assert_ne!(id, repo_device_id("uuid-mini", "owner/other"));
    assert_ne!(id, repo_device_id("uuid-pro", "owner/repo"));
    assert!(!id.contains("uuid"));
}

#[test]
fn the_hardware_fingerprint_is_read_from_ioreg_and_reg() {
    let ioreg = "+-o Mac  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"X\"\n      \"IOPlatformUUID\" = \"1A2B-3C4D\"\n    }";
    assert_eq!(value_after(ioreg, "\"IOPlatformUUID\"").as_deref(), Some("1A2B-3C4D"));
    let reg = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    abcd-ef01\r\n";
    assert_eq!(value_after(reg, "MachineGuid").as_deref(), Some("abcd-ef01"));
    assert_eq!(value_after("nothing", "MachineGuid"), None);
}

/// Challenger 2: "Taken over by" only when this computer's own marker was
/// replaced by another's; this computer's next claim clears it.
#[test]
fn a_take_over_is_recorded_only_when_this_computer_lost_its_marker() {
    let here = claim("dev-mini", "Mac mini", "t");
    let pro = claim("dev-pro", "MacBook Pro", "t");
    let mut card = card_in(crate::kanban::KanbanColumnId::InProgress, None);
    assert!(card.take_gh_claim(Some(pro.clone()), Some("dev-mini")));
    assert_eq!((card.gh_claim_here, card.gh_claim_lost_to.as_deref()), (false, None), "never ours: no take-over");
    card.take_gh_claim(Some(here.clone()), Some("dev-mini"));
    assert!(card.gh_claim_here);
    card.take_gh_claim(Some(pro.clone()), Some("dev-mini"));
    assert_eq!((card.gh_claim_here, card.gh_claim_lost_to.as_deref()), (false, Some("MacBook Pro")));
    assert!(!card.take_gh_claim(Some(pro.clone()), Some("dev-mini")), "unchanged");
    card.take_gh_claim(Some(here), Some("dev-mini"));
    assert_eq!(card.gh_claim_lost_to, None, "this computer's next claim clears it");
    card.take_gh_claim(None, Some("dev-mini"));
    assert_eq!((card.gh_claim_here, card.gh_claim_lost_to.as_deref()), (false, None));
}

#[test]
fn a_sync_reads_the_marker_onto_the_card() {
    let c = claim("dev-pro", "MacBook Pro", "t");
    let marked = issue(5, &with_claim("<!-- atelier:notes -->\nb\n<!-- /atelier:notes -->\n", Some(&c)));
    let plan = crate::github_sync::reconcile_plan(std::slice::from_ref(&marked), &[]);
    match &plan.actions[0] {
        crate::github_sync::ReconcileAction::Create(card) => {
            assert_eq!(card.gh_claim.as_ref(), Some(&c));
            assert_eq!(card.notes.as_deref(), Some("b"));
            assert_eq!(card.gh_raw_remainder, None);
        }
        other => panic!("expected a create, got {other:?}"),
    }
    assert!(plan.write_back.is_empty(), "a marked body is not adopted");

    // The marker went away on GitHub: the card follows.
    let mut card = crate::kanban::KanbanCard::new(
        crate::github_sync::gh_card_id(5),
        "ws".into(),
        "Search terms".into(),
        Some("b".into()),
        crate::kanban::KanbanColumnId::Todo,
    );
    card.gh_issue_number = Some(5);
    card.gh_assignees = vec!["matteo".into()];
    card.gh_claim = Some(c);
    let plain = issue(5, "<!-- atelier:notes -->\nb\n<!-- /atelier:notes -->\n");
    let plan = crate::github_sync::reconcile_plan(&[plain], &[card]);
    match &plan.actions[..] {
        [crate::github_sync::ReconcileAction::Patch { gh_claim, .. }] => assert_eq!(*gh_claim, None),
        other => panic!("expected one patch, got {other:?}"),
    }
}

// ── 1.174.0 (E12, CH-5): no unbounded subprocess at startup ──────────────

/// A reader that hangs is cut off at the limit and gives nothing.
#[cfg(unix)]
#[test]
fn a_read_that_hangs_gives_nothing_at_the_limit() {
    let started = std::time::Instant::now();
    let out = read_bounded(
        crate::platform::new_command("/bin/sh").args(["-c", "sleep 5; echo late"]),
        "slow reader",
        std::time::Duration::from_millis(200),
    );
    assert_eq!(out, None);
    assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
    let quick = read_bounded(
        crate::platform::new_command("/bin/sh").args(["-c", "echo '  Mac mini  '"]),
        "quick reader",
        READ_LIMIT,
    );
    assert_eq!(quick.as_deref(), Some("Mac mini"));
}

/// Startup hands the identity to its own thread and goes on at once; a slow
/// read that ends with nothing (a timeout) keeps the id and name saved before.
#[test]
fn identity_runs_off_the_main_thread_and_a_timed_out_read_keeps_the_id() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(crate::settings::SettingsStore::new(tmp.path().to_path_buf()).unwrap());
    let first = store.ensure_device(|| "Mac mini".to_string(), || "hw-1".to_string()).unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let in_thread = store.clone();
    let started = std::time::Instant::now();
    let handle = identify_in_background(move || {
        let kept = in_thread
            .ensure_device(
                || {
                    // A reader as slow as one that timed out, and as empty.
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    String::new()
                },
                String::new,
            )
            .unwrap();
        tx.send(kept).unwrap();
    })
    .unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_millis(200),
        "startup waited {:?} for the identity",
        started.elapsed()
    );
    handle.join().unwrap();
    let kept = rx.recv().unwrap();
    assert_eq!((kept.id.as_str(), kept.name.as_str()), (first.id.as_str(), "Mac mini"));
    assert_eq!(store.snapshot().device.hardware.as_deref(), Some("hw-1"));
}

/// E12 round 1: a claim made while the identity is still being read waits
/// for the identity thread to end — released however it ends — and a wait
/// that runs out gives up once, not on every claim.
#[test]
fn a_claim_waits_for_the_identity_thread_and_is_released_however_it_ends() {
    static SETTLE: Settle = Settle::new();
    let handle = identify_with(&SETTLE, || std::thread::sleep(std::time::Duration::from_millis(150))).unwrap();
    let started = std::time::Instant::now();
    assert!(SETTLE.wait(std::time::Duration::from_secs(5)), "released when the thread ended");
    assert!(started.elapsed() >= std::time::Duration::from_millis(100));
    handle.join().unwrap();

    // A thread that panics still releases the wait.
    static PANICS: Settle = Settle::new();
    let handle = identify_with(&PANICS, || panic!("reader failed")).unwrap();
    assert!(PANICS.wait(std::time::Duration::from_secs(5)));
    assert!(handle.join().is_err());

    // Nothing ever releases it: the wait runs out, then doesn't wait again.
    static STUCK: Settle = Settle::new();
    assert!(!STUCK.wait(std::time::Duration::from_millis(50)));
    let again = std::time::Instant::now();
    assert!(STUCK.wait(std::time::Duration::from_secs(5)));
    assert!(again.elapsed() < std::time::Duration::from_millis(50));
    assert_eq!(WAIT_LIMIT, std::time::Duration::from_secs(5));
}

/// E12 round 1: a sync before this computer is known keeps the marker and
/// leaves "here" and "taken over by" as they were.
#[test]
fn an_unknown_computer_leaves_here_and_lost_to_as_they_were() {
    let here = claim("dev-mini", "Mac mini", "t");
    let pro = claim("dev-pro", "MacBook Pro", "t");
    let mut card = card_in(crate::kanban::KanbanColumnId::InProgress, None);
    card.take_gh_claim(Some(here.clone()), Some("dev-mini"));
    assert!(card.gh_claim_here);
    assert!(!card.take_gh_claim(Some(here.clone()), None), "the same marker: unchanged");
    assert!(card.gh_claim_here, "still this computer's");
    assert!(card.take_gh_claim(Some(pro.clone()), None));
    assert_eq!(card.gh_claim.as_ref(), Some(&pro));
    assert_eq!((card.gh_claim_here, card.gh_claim_lost_to.as_deref()), (true, None), "no take-over guessed");
    card.take_gh_claim(Some(pro), Some("dev-mini"));
    assert_eq!((card.gh_claim_here, card.gh_claim_lost_to.as_deref()), (false, Some("MacBook Pro")));
}

// ── 1.175.0 (D2, TM-6): the marker stays while the copy is here ──────────

/// A card of issue 4 in `column`, marked by this computer, in a store.
fn marked_here(
    column: crate::kanban::KanbanColumnId,
    copy: Option<&str>,
) -> (tempfile::TempDir, crate::kanban::KanbanStore, crate::kanban::KanbanCard) {
    let tmp = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let mut card = card_in(column, None);
    card.worktree_path = copy.map(str::to_string);
    store.create_card("ws", card).unwrap();
    store.set_gh_claim("ws", "c", Some(claim(&mine(), "Mac mini", "t3")), Some(&mine())).unwrap();
    let card = store.get_card("ws", "c").unwrap();
    assert!(card.gh_claim_here);
    (tmp, store, card)
}

/// TM-6: closing the Builder session, stopping a start or moving the card
/// back leaves its copy and its commits on this computer, so the marker
/// stays; before, a second copy could be started on the member's other
/// computer without a word.
#[test]
fn the_marker_stays_after_the_session_closed_while_the_copy_is_here() {
    use crate::kanban::KanbanColumnId::{InProgress, Todo};
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![]);
    for column in [InProgress, Todo] {
        let (_tmp, store, card) = marked_here(column, Some("/copies/c"));
        assert!(copy_is_here(&card));
        // Close the Builder session, Stop during the start.
        release_unless_copy_here(&store, REPO, "ws", &card);
        // Move back, a drag.
        release_on_move(&store, REPO, "ws", "c");
        assert!(crate::github::take_test_gh_invocations().is_empty(), "nothing was asked of GitHub");
        assert!(store.get_card("ws", "c").unwrap().gh_claim_here, "still this computer's");
        // A body rebuilt for it (an edit of the brief) keeps the marker too.
        let here = claim(&mine(), "Mac mini", "t3");
        assert_eq!(kept_on_rebuild(&card, Some(here.clone()), REPO), Some(here));
    }
    crate::github::clear_test_gh_responses();
    set_test_device(None);
}

/// …and goes when the copy does: Done, Ready to start with no copy left, a
/// session closed on a card with no copy, an archived card.
#[test]
fn the_marker_goes_when_the_copy_is_no_longer_on_this_computer() {
    use crate::kanban::KanbanColumnId::{Complete, InProgress, Todo};
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let live = issue_json(4, &with_claim("brief", Some(&claim(&mine(), "Mac mini", "t3"))));
    let released = |store: &crate::kanban::KanbanStore, what: &str| {
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        assert_eq!(calls.len(), 2, "{what}: read, then the body without the marker: {calls:?}");
        assert!(calls[1].starts_with("issue edit 4 --repo o/r --body-file -"), "{what}: {calls:?}");
        assert_eq!(store.get_card("ws", "c").unwrap().gh_claim, None, "{what}");
    };
    let _ = crate::github::take_test_gh_invocations();

    // Done, its copy still here (waiting to ship): the list says Done.
    let (_tmp, store, card) = marked_here(Complete, Some("/copies/c"));
    assert!(!copy_is_here(&card));
    crate::github::set_test_gh_responses(vec![Ok(live.clone()), Ok(String::new())]);
    release_on_move(&store, REPO, "ws", "c");
    released(&store, "Done");

    // Ready to start, the copy deleted since.
    let (_tmp, store, _) = marked_here(Todo, None);
    crate::github::set_test_gh_responses(vec![Ok(live.clone()), Ok(String::new())]);
    release_on_move(&store, REPO, "ws", "c");
    released(&store, "Ready to start, no copy");

    // A session closed on a card with no copy on this computer.
    let (_tmp, store, card) = marked_here(InProgress, None);
    crate::github::set_test_gh_responses(vec![Ok(live.clone()), Ok(String::new())]);
    release_unless_copy_here(&store, REPO, "ws", &card);
    released(&store, "no copy");

    // Archived: its copy went to the Trash, whatever the card still records.
    let (_tmp, store, mut card) = marked_here(InProgress, Some("/copies/c"));
    card.archived = true;
    crate::github::set_test_gh_responses(vec![Ok(live), Ok(String::new())]);
    release_unless_copy_here(&store, REPO, "ws", &card);
    released(&store, "archived");

    // A card In progress never loses it on a move's label push: a start
    // writes the marker before the copy exists.
    let (_tmp, store, _) = marked_here(InProgress, None);
    crate::github::set_test_gh_responses(vec![]);
    release_on_move(&store, REPO, "ws", "c");
    assert!(crate::github::take_test_gh_invocations().is_empty());
    assert!(store.get_card("ws", "c").unwrap().gh_claim_here);

    crate::github::clear_test_gh_responses();
    set_test_device(None);
}

/// D2 (TM-6): where the release is asked — a closed session and a stopped
/// start ask only when the copy is gone; a deleted copy, a copy found
/// missing and a merged card ask too.
#[test]
fn the_release_is_asked_where_the_copy_goes_not_where_the_session_closes() {
    let commands = include_str!("commands.rs");
    let release = &commands[commands.find("pub async fn kanban_card_device_release(").unwrap()..];
    let release = &release[..release.find("\n}\n").unwrap()];
    assert!(release.contains("device_claim::release_unless_copy_here("), "{release}");
    assert!(!release.contains("device_claim::release_card("), "{release}");
    assert!(!commands.contains("fn release_claim_on_move("), "moved here: release_on_move");
    // 1.175.0 (D3): the card edit's GitHub half moved to issue_edit.rs.
    assert!(include_str!("issue_edit.rs").contains("crate::device_claim::release_on_move(store, repo, workspace_id, &card.id);"));
    assert!(commands.contains("crate::leave_issue::copy_deleted(&app, &workspace_id, marked);"));
    let sync = include_str!("github_sync.rs");
    assert!(sync.contains("crate::device_claim::release_unless_copy_here(store, repo, workspace_id, &card);"));
    assert!(include_str!("after_merge.rs").contains("crate::leave_issue::merged(app, workspace_id, card);"));
}

// ── 1.175.0 round 2 (finding 7): a leaver's marker gives way ─────────────

fn issue_held_by(number: u64, body: &str, assignees: &[&str]) -> crate::github::GhIssue {
    let mut i = issue(number, body);
    i.assignees = assignees.iter().map(|l| crate::github::GhUser { login: l.to_string() }).collect();
    i
}

fn view_json(number: u64, body: &str, assignees: &[&str]) -> String {
    let assignees: Vec<_> = assignees.iter().map(|l| serde_json::json!({"login": l})).collect();
    serde_json::json!({"number": number, "title": "Search terms", "body": body, "assignees": assignees, "labels": [], "state": "OPEN", "updatedAt": ""}).to_string()
}

/// Since D2 a member who moves a card back comes off its issue while their
/// marker stays (their copy is still on their computer). The teammate who
/// then claims the card gets a marker of their own in its place.
#[test]
fn a_marker_left_by_somebody_no_longer_assigned_gives_way_to_the_claimant() {
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let _ = crate::github::take_test_gh_invocations();
    let _ = crate::github::take_test_gh_stdin();
    let giulia = DeviceClaim { device: "dev-giulia".into(), name: "MacBook Air".into(), login: Some("giulia".into()), at: "t1".into() };
    let body = with_claim("brief", Some(&giulia));
    // matteo claimed it: he is the only assignee now, giulia left.
    crate::github::set_test_gh_responses(vec![Ok(view_json(9, &body, &["matteo"])), Ok(String::new())]);
    let after = claim_on_issue(REPO, &issue_held_by(9, &body, &["matteo"]), "matteo", ClaimHere::IfFree, false).unwrap().unwrap();
    assert_eq!((after.login.as_deref(), after.device.as_str()), (Some("matteo"), mine().as_str()));
    let written = crate::github::take_test_gh_stdin();
    assert_eq!(written.len(), 1);
    assert!(!written[0].contains("giulia") && written[0].contains("login=matteo"), "{}", written[0]);
    assert_eq!(markers(&written[0]).len(), 1, "one marker, in place of hers");
    crate::github::clear_test_gh_responses();
    set_test_device(None);
}

/// …and never the marker of somebody still assigned (both hold the card),
/// of this login's own other computer, or one that names nobody.
#[test]
fn a_marker_of_somebody_still_assigned_is_never_replaced_by_a_plain_claim() {
    let _serial = crate::github::test_serial_lock();
    set_test_device(Some(me()));
    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![]);
    let kept = |claim: &DeviceClaim, assignees: &[&str], what: &str| {
        let body = with_claim("brief", Some(claim));
        let after = claim_on_issue(REPO, &issue_held_by(9, &body, assignees), "matteo", ClaimHere::IfFree, false).unwrap();
        assert_eq!(after.as_ref(), Some(claim), "{what}");
        assert!(crate::github::take_test_gh_invocations().is_empty(), "{what}: nothing read again, nothing written");
    };
    let giulia = DeviceClaim { device: "dev-giulia".into(), name: "MacBook Air".into(), login: Some("giulia".into()), at: "t1".into() };
    kept(&giulia, &["Giulia", "matteo"], "she is still on the issue");
    let own_other = DeviceClaim { device: "dev-pro".into(), name: "MacBook Pro".into(), login: Some("Matteo".into()), at: "t1".into() };
    kept(&own_other, &["matteo"], "this login's other computer: it asks first");
    let nameless = DeviceClaim { device: "dev-old".into(), name: "Mac".into(), login: None, at: "t1".into() };
    kept(&nameless, &["matteo"], "a marker that names nobody");

    // She came back on the issue between the first look and the write: the
    // read right before the write decides, and hers stays.
    let body = with_claim("brief", Some(&giulia));
    crate::github::set_test_gh_responses(vec![Ok(view_json(9, &body, &["matteo", "giulia"]))]);
    let after = claim_on_issue(REPO, &issue_held_by(9, &body, &["matteo"]), "matteo", ClaimHere::IfFree, false).unwrap();
    assert_eq!(after, Some(giulia));
    let calls = crate::github::take_test_gh_invocations();
    assert_eq!(calls.len(), 1, "read again, nothing written: {calls:?}");
    crate::github::clear_test_gh_responses();
    set_test_device(None);
}
