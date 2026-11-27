use super::*;
use crate::github;
use crate::github_sync::gh_card_id;

const REPO: &str = "o/leave";
const REMOVE: &str = "--remove-assignee @me";

fn card(number: u64, column: KanbanColumnId, assignees: &[&str]) -> KanbanCard {
    let mut c = KanbanCard::new(gh_card_id(number), "ws".into(), format!("Issue {number}"), None, column);
    c.gh_issue_number = Some(number);
    c.gh_assignees = assignees.iter().map(|a| a.to_string()).collect();
    c
}

fn store_with(cards: Vec<KanbanCard>) -> (tempfile::TempDir, KanbanStore) {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    for c in cards {
        store.create_card("ws", c).unwrap();
    }
    (tmp, store)
}

fn calls() -> Vec<String> {
    github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect()
}

/// The gh seam answers `responses` in order, starting with who is signed in.
fn gh(responses: Vec<Result<String, String>>) {
    github::invalidate_login_cache();
    github::take_test_gh_invocations();
    github::set_test_gh_responses(responses);
}

fn done() {
    github::clear_test_gh_responses();
    github::invalidate_login_cache();
}

fn me() -> Result<String, String> {
    Ok("matteo".into())
}

/// D2: only a card of an issue, without a pull request, that hasn't shipped.
#[test]
fn the_name_comes_off_only_a_card_without_a_pull_request() {
    let plain = card(5, KanbanColumnId::Todo, &["matteo"]);
    assert!(applies(&plain));

    let mut open = plain.clone();
    open.pr_url = Some("https://github.com/o/leave/pull/9".into());
    open.pr = Some(crate::pr_status::PrStatus { number: 9, ..Default::default() });
    assert!(!applies(&open), "an open pull request: the work is the member's");
    let mut merged = open.clone();
    merged.pr.as_mut().unwrap().state = crate::pr_status::PrState::Merged;
    assert!(!applies(&merged));
    let mut url_only = plain.clone();
    url_only.pr_url = Some("https://github.com/o/leave/pull/9".into());
    assert!(!applies(&url_only), "a ship recorded the pull request, its status not read yet");
    let mut shipped = plain.clone();
    shipped.ship_status = crate::kanban::ShipStatus::Shipped;
    assert!(!applies(&shipped), "shipped on this computer, without a pull request");
    let mut local = plain.clone();
    local.gh_issue_number = None;
    assert!(!applies(&local));
    // Round 2: a card in Done keeps the name, whatever this computer
    // recorded of how it got there (no pull request, no ship here).
    let mut done_card = plain.clone();
    done_card.column_id = KanbanColumnId::Complete;
    assert!(!applies(&done_card), "archiving a Done card is tidying, not leaving the work");
    assert!(applies(&card(5, KanbanColumnId::InProgress, &["matteo"])));

    // …and then GitHub is never asked, whatever the card says of its holder.
    let _serial = github::test_serial_lock();
    let (_tmp, store) = store_with(vec![open]);
    gh(vec![]);
    assert_eq!(leave(&store, REPO, "ws", &gh_card_id(5)), None);
    assert!(calls().is_empty(), "nothing was asked of GitHub");
    assert_eq!(store.get_card("ws", &gh_card_id(5)).unwrap().gh_assignees, vec!["matteo".to_string()]);
    assert_eq!(take_outcome("ws", &gh_card_id(5)), None);
    done();
}

/// D2: the member's own name, by `@me` — the others on the issue stay, and
/// a card somebody else holds is left alone.
#[test]
fn only_the_members_own_name_is_taken_off() {
    let _serial = github::test_serial_lock();
    let (_tmp, store) = store_with(vec![
        card(5, KanbanColumnId::Todo, &["giulia", "Matteo"]),
        card(6, KanbanColumnId::Todo, &["giulia"]),
        card(7, KanbanColumnId::Todo, &[]),
    ]);

    gh(vec![me(), Ok(String::new())]);
    assert_eq!(leave(&store, REPO, "ws", &gh_card_id(5)), Some(NameOff::Off { number: 5 }));
    let asked = calls();
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[1], format!("issue edit 5 --repo {REPO} {REMOVE}"));
    assert!(!asked[1].contains("giulia") && !asked[1].contains("matteo"), "no login is ever passed: {asked:?}");
    let left = store.get_card("ws", &gh_card_id(5)).unwrap();
    assert_eq!(left.gh_assignees, vec!["giulia".to_string()], "the teammate stays");
    assert!(!left.unassign_pending);
    // Told once to the gesture that asked.
    assert_eq!(take_outcome("ws", &gh_card_id(5)), Some(NameOff::Off { number: 5 }));
    assert_eq!(take_outcome("ws", &gh_card_id(5)), None);

    // Somebody else's card: the login is read, nothing is written.
    gh(vec![me()]);
    assert_eq!(leave(&store, REPO, "ws", &gh_card_id(6)), None);
    assert!(!calls().iter().any(|c| c.contains("issue edit")));
    assert_eq!(store.get_card("ws", &gh_card_id(6)).unwrap().gh_assignees, vec!["giulia".to_string()]);

    // Nobody's: not even the login is asked.
    gh(vec![]);
    assert_eq!(leave(&store, REPO, "ws", &gh_card_id(7)), None);
    assert!(calls().is_empty());
    done();
}

/// D2-a: GitHub refuses — the card is marked, the outcome says why, and
/// the next Sync tries once more before it reads; when that goes through
/// the mark drops and the card records the name is off.
#[test]
fn a_refusal_marks_the_card_and_the_next_sync_tries_again_before_it_reads() {
    let _serial = github::test_serial_lock();
    let (_tmp, store) = store_with(vec![card(5, KanbanColumnId::Todo, &["matteo", "giulia"])]);
    let id = gh_card_id(5);

    gh(vec![me(), Err("HTTP 502: Bad Gateway".into())]);
    assert_eq!(
        leave(&store, REPO, "ws", &id),
        Some(NameOff::Refused { number: 5, details: "HTTP 502: Bad Gateway".into() })
    );
    let refused = store.get_card("ws", &id).unwrap();
    assert!(refused.unassign_pending);
    assert_eq!(refused.gh_assignees, vec!["matteo".to_string(), "giulia".to_string()], "as GitHub still has it");

    // A Sync GitHub refuses again: still marked, one write tried.
    let list = serde_json::json!([{"number": 5, "title": "Issue 5", "body": "", "state": "OPEN",
        "assignees": [{"login": "matteo"}, {"login": "giulia"}], "labels": [{"name": "status:todo"}]}]);
    gh(vec![me(), Err("HTTP 502".into()), Ok(list.to_string())]);
    crate::github_sync::reconcile(&store, "ws", REPO, None, &Default::default()).unwrap();
    let asked = calls();
    assert_eq!(asked.iter().filter(|c| c.contains(REMOVE)).count(), 1, "{asked:?}");
    assert!(store.get_card("ws", &id).unwrap().unassign_pending);

    // The next one goes through: the write is before the read of the issues.
    let list = serde_json::json!([{"number": 5, "title": "Issue 5", "body": "", "state": "OPEN",
        "assignees": [{"login": "giulia"}], "labels": [{"name": "status:todo"}]}]);
    gh(vec![me(), Ok(String::new()), Ok(list.to_string())]);
    crate::github_sync::reconcile(&store, "ws", REPO, None, &Default::default()).unwrap();
    let asked = calls();
    let write = asked.iter().position(|c| c == &format!("issue edit 5 --repo {REPO} {REMOVE}")).expect("the retry");
    let read = asked.iter().position(|c| c.starts_with("issue list")).expect("the read");
    assert!(write < read, "{asked:?}");
    let after = store.get_card("ws", &id).unwrap();
    assert!(!after.unassign_pending);
    assert_eq!(after.gh_assignees, vec!["giulia".to_string()]);

    // Nothing owed: a Sync asks neither the login nor a write.
    gh(vec![Ok(list.to_string())]);
    crate::github_sync::reconcile(&store, "ws", REPO, None, &Default::default()).unwrap();
    let asked = calls();
    assert_eq!(asked.len(), 1, "{asked:?}");
    done();
}

/// D2-a, U33: the retries count inside the Sync's cap of 25 writes, first;
/// the status-label retries take what is left, and the rest wait.
#[test]
fn the_retries_count_inside_the_syncs_cap_of_writes() {
    let _serial = github::test_serial_lock();
    let cap = crate::github_sync::LABEL_WRITES_PER_SYNC;
    assert_eq!(cap, 25);

    // More names owed than a Sync may write: 25 now, newest issues first.
    let owed: Vec<KanbanCard> = (1..=30u64)
        .map(|n| {
            let mut c = card(n, KanbanColumnId::Todo, &["matteo"]);
            c.unassign_pending = true;
            c
        })
        .collect();
    let (_tmp, store) = store_with(owed.clone());
    let mut answers = vec![me()];
    answers.extend((0..cap).map(|_| Ok(String::new())));
    gh(answers);
    assert_eq!(retry_pending(&store, REPO, "ws", &owed, cap), cap);
    let asked = calls();
    assert_eq!(asked.iter().filter(|c| c.contains(REMOVE)).count(), cap);
    assert!(asked[1].starts_with("issue edit 30 "), "newest first: {asked:?}");
    let still: Vec<u64> =
        store.load("ws").unwrap().iter().filter(|c| c.unassign_pending).filter_map(|c| c.gh_issue_number).collect();
    assert_eq!(still, vec![1, 2, 3, 4, 5], "the rest wait for the next Sync");

    // Three names and thirty labels owed: 3 + 22 writes, then the read.
    let mut cards: Vec<KanbanCard> = (1..=3u64)
        .map(|n| {
            let mut c = card(n, KanbanColumnId::Todo, &["matteo"]);
            c.unassign_pending = true;
            c
        })
        .collect();
    cards.extend((101..=130u64).map(|n| {
        let mut c = card(n, KanbanColumnId::InProgress, &[]);
        c.gh_labels_pending = true;
        c
    }));
    let (_tmp, store) = store_with(cards);
    let mut answers = vec![me()];
    answers.extend((0..cap).map(|_| Ok(String::new())));
    answers.extend([Ok("[]".into()), Ok("[]".into())]); // open, then closed
    gh(answers);
    crate::github_sync::reconcile(&store, "ws", REPO, None, &Default::default()).unwrap();
    let asked = calls();
    let read = asked.iter().position(|c| c.starts_with("issue list")).expect("the read");
    let writes: Vec<&String> = asked[..read].iter().filter(|c| c.starts_with("issue edit")).collect();
    assert_eq!(writes.len(), cap, "{asked:?}");
    assert_eq!(writes.iter().filter(|c| c.contains(REMOVE)).count(), 3);
    assert_eq!(writes.iter().filter(|c| c.contains("--add-label")).count(), cap - 3);
    assert!(writes[0].contains(REMOVE), "the names first: {asked:?}");
    done();
}

/// D2: a card taken up again keeps the name — Start build's gate and a
/// claim drop the mark, and a Sync writes nothing for a card being worked
/// on, one that got a pull request, or one that is no longer the member's.
#[test]
fn a_card_taken_up_again_keeps_the_name() {
    let _serial = github::test_serial_lock();
    let owed = |number: u64, column: KanbanColumnId, assignees: &[&str]| {
        let mut c = card(number, column, assignees);
        c.unassign_pending = true;
        c
    };
    let mut shipped = owed(3, KanbanColumnId::Complete, &["matteo"]);
    shipped.pr_url = Some("https://github.com/o/leave/pull/9".into());
    let mut archived_while_building = owed(4, KanbanColumnId::InProgress, &["matteo"]);
    archived_while_building.archived = true;
    let cards = vec![
        owed(1, KanbanColumnId::InProgress, &["matteo"]),
        owed(2, KanbanColumnId::Todo, &["giulia"]),
        shipped,
        archived_while_building,
        owed(5, KanbanColumnId::Todo, &["matteo"]),
    ];
    let (_tmp, store) = store_with(cards.clone());

    // Start build on #5: the gate lets it through, the mark drops.
    taken_up(&store, "ws", &gh_card_id(5));
    assert!(!store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    let local = store.load("ws").unwrap();

    gh(vec![me(), Ok(String::new())]);
    assert_eq!(retry_pending(&store, REPO, "ws", &local, 25), 1);
    let asked = calls();
    assert_eq!(
        asked.iter().filter(|c| c.contains(REMOVE)).collect::<Vec<_>>(),
        vec![&format!("issue edit 4 --repo {REPO} {REMOVE}")],
        "only the archived card's: {asked:?}"
    );
    let after = store.load("ws").unwrap();
    assert!(after.iter().all(|c| !c.unassign_pending), "every mark is settled");
    let names = |n: u64| after.iter().find(|c| c.gh_issue_number == Some(n)).unwrap().gh_assignees.clone();
    assert_eq!(names(1), vec!["matteo".to_string()], "being built again: the name stays");
    assert_eq!(names(3), vec!["matteo".to_string()], "it has a pull request now");
    assert_eq!(names(2), vec!["giulia".to_string()]);
    assert!(names(4).is_empty());
    done();

    // Where the mark is dropped: Start build's claim gate, and a claim —
    // each before it reads who holds the issue (round 2), so a retry on its
    // way has finished by then.
    let commands = include_str!("commands.rs");
    let dropped = commands.find("let owed = crate::leave_issue::taken_up(store, &workspace_id, &card_id);").expect("the gate drops the mark");
    let gate_read = commands[dropped..].find("crate::github::issue_view(repo, number).map_err(unread)?").expect("then reads");
    assert!(gate_read < 300, "right before the gate's read");
    // Round 3: a reading that fails (no network) owes the removal again.
    assert!(commands[dropped..dropped + gate_read].contains("crate::leave_issue::not_taken(store, &workspace_id, &card_id, owed, claim_unverified(e))"));
    assert!(commands[dropped..].contains("crate::github::current_login().map_err(unread)?"));
    assert_eq!(commands.split("#[cfg(test)]\nmod tests").next().unwrap().matches("leave_issue::taken_up(").count(), 1);
    let claim = include_str!("card_claim.rs");
    let claim = &claim[claim.find("pub(crate) fn claim_card(").unwrap()..];
    let dropped = claim
        .find("let owed = matches!(mode, ClaimMode::Claim { .. }) && crate::leave_issue::taken_up(store, workspace_id, card_id);")
        .expect("a claim drops it too, a read of the claim state drops nothing");
    assert!(dropped < claim.find("crate::github::issue_view(repo, number)").unwrap(), "before the claim's read");
    assert!(claim.contains(".map_err(|e| crate::leave_issue::not_taken(store, workspace_id, card_id, owed, e))"), "round 3: a claim that fails owes it again");
}

/// Round 2 (major): the Sync read the board, then the member started the
/// card again; the retry must not take the name off from that older
/// reading. And a retry already on its way is waited for by the claim.
#[test]
fn a_retry_decides_from_the_card_as_it_is_and_a_claim_waits_for_one_on_its_way() {
    let _serial = github::test_serial_lock();
    let mut owed = card(5, KanbanColumnId::Todo, &["matteo"]);
    owed.unassign_pending = true;
    let (_tmp, store) = store_with(vec![owed]);
    // The Sync's reading: the mark is on.
    let seen = store.load("ws").unwrap();
    assert!(seen[0].unassign_pending);
    // Start build since: the gate (or the claim) said "wanted again".
    assert!(taken_up(&store, "ws", &gh_card_id(5)), "a removal was owed");
    assert!(!taken_up(&store, "ws", &gh_card_id(5)), "and no longer is");
    // Round 3: the reading that follows failed — owed again; a card that
    // owed nothing is not marked by a failure.
    assert_eq!(not_taken(&store, "ws", &gh_card_id(5), true, "offline"), "offline");
    assert!(store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    assert!(taken_up(&store, "ws", &gh_card_id(5)));
    not_taken(&store, "ws", &gh_card_id(5), false, ());
    assert!(!store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    gh(vec![me()]);
    assert_eq!(retry_pending(&store, REPO, "ws", &seen, 25), 0);
    assert!(!calls().iter().any(|c| c.contains(REMOVE)), "nothing is taken off a card started again");
    assert_eq!(store.get_card("ws", &gh_card_id(5)).unwrap().gh_assignees, vec!["matteo".to_string()]);
    done();

    // The other order: while a removal holds the lock (its `gh` call is on
    // its way), "wanted again" waits; it goes on as soon as that is done.
    store.set_unassign_pending("ws", &gh_card_id(5), true).unwrap();
    let turn = name_lock();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let store = &store;
        scope.spawn(move || {
            taken_up(store, "ws", &gh_card_id(5));
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(std::time::Duration::from_millis(150)).is_err(), "the claim waits for the removal");
        assert!(store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
        drop(turn);
        rx.recv_timeout(std::time::Duration::from_secs(10)).expect("then goes on");
    });
    assert!(!store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    // A leave and a retry take the same lock for their write.
    let source = include_str!("leave_issue.rs");
    let leave = &source[source.find("pub fn leave(").unwrap()..];
    assert!(leave[..200].contains("let _turn = name_lock();"));
    let retry = &source[source.find("pub fn retry_pending(").unwrap()..];
    let locked = retry.find("let _turn = name_lock();").unwrap();
    assert!(locked < retry.find("store.get_card(workspace_id, &seen.id)").unwrap(), "read again under the lock");
    assert!(locked < retry.find("issue_remove_assignee_me(").unwrap());
}

/// Round 2 (major): Archive by hand of a card that is Done writes nothing
/// and says nothing — the name on its closed issue stays.
#[test]
fn archiving_a_done_card_leaves_the_name_on_its_issue() {
    let _serial = github::test_serial_lock();
    let mut done_card = card(5, KanbanColumnId::Complete, &["matteo"]);
    done_card.archived = true;
    let mut owed = card(6, KanbanColumnId::Complete, &["matteo"]);
    owed.unassign_pending = true;
    let (_tmp, store) = store_with(vec![done_card, owed]);
    gh(vec![]);
    assert_eq!(leave(&store, REPO, "ws", &gh_card_id(5)), None);
    assert!(calls().is_empty(), "GitHub isn't asked");
    assert_eq!(take_outcome("ws", &gh_card_id(5)), None, "and nothing is said");
    assert_eq!(store.get_card("ws", &gh_card_id(5)).unwrap().gh_assignees, vec!["matteo".to_string()]);
    // A card that became Done while a removal was owed: unmarked, unwritten.
    let local = store.load("ws").unwrap();
    gh(vec![me()]);
    assert_eq!(retry_pending(&store, REPO, "ws", &local, 25), 0);
    assert!(!calls().iter().any(|c| c.contains(REMOVE)));
    assert!(!store.get_card("ws", &gh_card_id(6)).unwrap().unassign_pending);
    done();
}

/// Round 2: an issue GitHub says is gone is never retried again; any other
/// refusal keeps the mark, and a closed issue simply takes the write.
#[test]
fn an_issue_that_is_gone_is_no_longer_retried() {
    let _serial = github::test_serial_lock();
    const GONE: &str = "GraphQL: Could not resolve to an issue or pull request with the number of 5. (repository.issue)";
    let owed = |n: u64| {
        let mut c = card(n, KanbanColumnId::Todo, &["matteo"]);
        c.unassign_pending = true;
        c
    };
    let (_tmp, store) = store_with(vec![owed(5), owed(6), card(7, KanbanColumnId::Todo, &["matteo"])]);
    let local = store.load("ws").unwrap();
    // #6 first (newest): refused for another reason, it stays. #5 is gone.
    gh(vec![me(), Err("HTTP 403: Resource not accessible".into()), Err(GONE.into())]);
    assert_eq!(retry_pending(&store, REPO, "ws", &local, 25), 2);
    assert!(store.get_card("ws", &gh_card_id(6)).unwrap().unassign_pending, "may pass later");
    assert!(!store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending, "gone: no more retries");
    // Leaving a card whose issue is gone marks nothing and says nothing.
    gh(vec![me(), Err(GONE.into())]);
    assert_eq!(leave(&store, REPO, "ws", &gh_card_id(7)), None);
    assert!(!store.get_card("ws", &gh_card_id(7)).unwrap().unassign_pending);
    done();
    assert!(gone(GONE));
    for not_gone in ["HTTP 502", "error connecting to api.github.com", "HTTP 403: Resource not accessible", "Could not resolve to a Repository with the name 'o/r'."] {
        assert!(!gone(not_gone), "{not_gone}");
    }
}

/// D2: while a board opened from its last saved copy holds its writes, the
/// name isn't taken off (the write never reaches gh); the mark sends it
/// with the Sync that reads the board.
#[test]
fn a_held_board_keeps_the_name_for_the_next_sync() {
    let _serial = github::test_serial_lock();
    let (_tmp, store) = store_with(vec![card(5, KanbanColumnId::Todo, &["matteo"])]);
    github::set_test_issue_write_hold(Some(REPO));
    gh(vec![me()]);
    let outcome = leave(&store, REPO, "ws", &gh_card_id(5));
    github::set_test_issue_write_hold(None);
    assert!(matches!(&outcome, Some(NameOff::Refused { number: 5, details }) if github::is_held_refusal(details)), "{outcome:?}");
    assert!(!calls().iter().any(|c| c.contains("issue edit")), "gh was never asked to write");
    assert!(store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    done();
}

/// D2: GitHub can't say who is signed in — nothing is written (whose name
/// would it be?), and the Sync decides once it can.
#[test]
fn an_unknown_login_writes_nothing_and_leaves_it_to_sync() {
    let _serial = github::test_serial_lock();
    let (_tmp, store) = store_with(vec![card(5, KanbanColumnId::Todo, &["giulia"])]);
    gh(vec![Err("gh: not logged in".into())]);
    assert!(matches!(leave(&store, REPO, "ws", &gh_card_id(5)), Some(NameOff::Refused { number: 5, .. })));
    assert!(!calls().iter().any(|c| c.contains("issue edit")));
    assert!(store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    // The Sync knows who it is: the card is a teammate's, so nothing is owed.
    let local = store.load("ws").unwrap();
    gh(vec![me()]);
    assert_eq!(retry_pending(&store, REPO, "ws", &local, 25), 0);
    assert!(!calls().iter().any(|c| c.contains("issue edit")));
    assert!(!store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    // And while it still can't say, a Sync writes nothing and keeps the mark.
    store.set_unassign_pending("ws", &gh_card_id(5), true).unwrap();
    let local = store.load("ws").unwrap();
    gh(vec![Err("gh: not logged in".into())]);
    assert_eq!(retry_pending(&store, REPO, "ws", &local, 25), 0);
    assert!(store.get_card("ws", &gh_card_id(5)).unwrap().unassign_pending);
    done();
}

/// Tier 2 schema-migration (D2): a board written by 1.174.5 has no
/// `unassignPending`. It loads with the mark off, keeps every other field,
/// is written back without it, and a Sync tries nothing for it.
#[test]
fn a_board_from_before_the_mark_loads_without_it_and_nothing_is_tried() {
    let _serial = github::test_serial_lock();
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws-1745.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let json = format!(
        r#"{{
        "version": {},
        "cards": [{{
            "id": "gh-issue-62",
            "workspaceId": "ws-1745",
            "title": "left before 1.175.0",
            "columnId": "todo",
            "ghIssueNumber": 62,
            "ghAssignees": ["matteo"],
            "ghLabelsPending": false,
            "worktreePath": "/copies/gh-issue-62",
            "createdAt": 1,
            "updatedAt": 2
        }}]
    }}"#,
        crate::kanban::KANBAN_SCHEMA_VERSION
    );
    std::fs::write(&path, json.as_bytes()).unwrap();
    let cards = store.load("ws-1745").unwrap();
    assert_eq!(cards.len(), 1);
    assert!(!cards[0].unassign_pending);
    assert_eq!(cards[0].gh_issue_number, Some(62));
    assert_eq!(cards[0].gh_assignees, vec!["matteo".to_string()]);
    assert_eq!(cards[0].worktree_path.as_deref(), Some("/copies/gh-issue-62"));

    // No attempt: neither the login nor a write is asked.
    gh(vec![]);
    assert_eq!(retry_pending(&store, REPO, "ws-1745", &cards, 25), 0);
    assert!(calls().is_empty());
    done();

    // Written back, the file still has no such field; with the mark it has
    // it, and it reads back.
    store.save("ws-1745", cards).unwrap();
    assert!(!std::fs::read_to_string(&path).unwrap().contains("unassignPending"));
    store.set_unassign_pending("ws-1745", "gh-issue-62", true).unwrap();
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(written.replace(' ', "").contains("\"unassignPending\":true"), "{written}");
    let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    assert!(again.load("ws-1745").unwrap()[0].unassign_pending);
}

/// D2: the three gestures that leave a card ask for it — Move back and Stop
/// during the start (both `kanban_card_put_back`), and an archive by hand,
/// never the auto-archive. Nothing else does.
#[test]
fn only_move_back_and_an_archive_by_hand_take_the_name_off() {
    let commands = include_str!("commands.rs");
    let code = commands.split("#[cfg(test)]\nmod tests").next().unwrap();
    assert_eq!(code.matches("crate::leave_issue::leave(").count(), 2, "put back and archive");
    let body = |name: &str| {
        let from = &code[code.find(&format!("pub async fn {name}(")).unwrap()..];
        &from[..from.find("\n}\n").unwrap()]
    };
    let put_back = body("kanban_card_put_back");
    let labels = put_back.find("gh_sync_card_edit(&store, &repo, &workspace_id, None, &updated, false, true);").unwrap();
    assert!(put_back[labels..].contains("crate::leave_issue::leave(&store, &repo, &workspace_id, &card_id);"));
    let archive = body("kanban_card_archive");
    let by_hand = archive.find("if !auto.unwrap_or(false) {").expect("never the auto-archive");
    assert!(archive[by_hand..].contains("crate::leave_issue::leave(&store, &repo, &workspace_id, &card_id);"));
    assert!(archive.find("team_gate(").unwrap() < by_hand, "inside the team gate");
    // The write itself exists once, with no login to pass.
    let github = include_str!("github.rs");
    let code = github.split("#[cfg(test)]\nmod tests").next().unwrap();
    assert_eq!(code.matches("\"--remove-assignee\"").count(), 1);
    assert!(code.contains("pub fn issue_remove_assignee_me(repo: &str, number: u64)"));
}

/// TM-6: the card whose copy is about to be deleted, when this computer
/// marked its issue — by the folder's name (the card's id) or by its path.
#[test]
fn the_card_of_a_deleted_copy_is_found_only_when_this_computer_marked_it() {
    let mut by_id = card(5, KanbanColumnId::Todo, &["matteo"]);
    by_id.gh_claim_here = true;
    let mut by_path = card(6, KanbanColumnId::Todo, &["matteo"]);
    by_path.gh_claim_here = true;
    by_path.worktree_path = Some("/copies/from-a-copy".into());
    let mut unmarked = card(7, KanbanColumnId::Todo, &["matteo"]);
    unmarked.worktree_path = Some("/copies/gh-issue-7".into());
    let (_tmp, store) = store_with(vec![by_id, by_path, unmarked]);
    let owner = |dir: &str, path: &str| marked_owner(&store, "ws", dir, std::path::Path::new(path));
    assert_eq!(owner("gh-issue-5", "/copies/gh-issue-5"), Some("gh-issue-5".into()));
    assert_eq!(owner("from-a-copy", "/copies/from-a-copy"), Some("gh-issue-6".into()));
    assert_eq!(owner("gh-issue-7", "/copies/gh-issue-7"), None, "another computer's, or nobody's");
    assert_eq!(owner("stray", "/copies/stray"), None);
}
