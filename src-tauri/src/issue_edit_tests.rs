use super::*;
use crate::github;
use crate::github_sync::gh_card_id;
use crate::kanban::KanbanColumnId;

const REPO: &str = "o/edit";
const N: u64 = 70;

fn card_with(title: &str, notes: &str) -> KanbanCard {
    let mut c = KanbanCard::new(gh_card_id(N), "ws".into(), title.into(), Some(notes.into()), KanbanColumnId::Todo);
    c.gh_issue_number = Some(N);
    c
}

fn store_with(card: KanbanCard) -> (tempfile::TempDir, KanbanStore) {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    store.create_card("ws", card).unwrap();
    (tmp, store)
}

fn now(store: &KanbanStore) -> KanbanCard {
    store.get_card("ws", &gh_card_id(N)).unwrap()
}

/// The issue as `gh issue view` answers, its body built as Plyloft builds it.
fn view(title: &str, notes: &str, knowledge: Option<&str>, outside: Option<&str>) -> Result<String, String> {
    Ok(view_of(title, &github::build_issue_body(Some(notes), knowledge, outside)))
}

fn view_of(title: &str, body: &str) -> String {
    serde_json::json!({"number": N, "title": title, "body": body, "state": "OPEN", "assignees": [], "labels": [], "updatedAt": "2026-11-09T10:00:00Z"}).to_string()
}

fn last_change(body_by: Option<&str>, title_by: Option<&str>) -> Result<String, String> {
    let renamed: Vec<_> = title_by
        .map(|login| serde_json::json!({"createdAt": "2026-11-09T09:56:00Z", "actor": {"login": login}}))
        .into_iter()
        .collect();
    Ok(serde_json::json!({"data": {"repository": {"issue": {
        "lastEditedAt": body_by.map(|_| "2026-11-09T09:56:00Z"),
        "editor": body_by.map(|login| serde_json::json!({"login": login})),
        "timelineItems": {"nodes": renamed}
    }}}})
    .to_string())
}

fn ok() -> Result<String, String> {
    Ok(String::new())
}

/// The member's edit `before` → `after` on a card in `store`, with gh
/// answering `answers`. Returns what gh was asked and what went on stdin.
fn edit(store: &KanbanStore, before: &KanbanCard, change: impl FnOnce(&mut KanbanCard), answers: Vec<Result<String, String>>) -> (Vec<String>, Vec<String>) {
    store.with_card("ws", &before.id, |c| {
        change(c);
        Ok(())
    })
    .unwrap();
    let after = now(store);
    github::take_test_gh_invocations();
    github::take_test_gh_stdin();
    github::set_test_gh_responses(answers);
    gh_sync_card_edit(store, REPO, "ws", Some(before), &after, true, false);
    let calls = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
    let stdin = github::take_test_gh_stdin();
    github::clear_test_gh_responses();
    (calls, stdin)
}

fn writes(calls: &[String]) -> Vec<&String> {
    calls.iter().filter(|c| c.starts_with("issue edit")).collect()
}

const TITLE_ONLY: &str = "issue edit 70 --repo o/edit --title";
const BODY_ONLY: &str = "issue edit 70 --repo o/edit --body-file -";

/// D3: the matrix — which part the member touched, which part changed on
/// GitHub meanwhile — for the title and for the brief. Only the touched
/// part is ever written, and only when GitHub still has what was last read.
#[test]
fn only_the_part_touched_is_written_and_only_if_github_did_not_change_it() {
    let _serial = github::test_serial_lock();
    let start = || card_with("Onboarding: shorter welcome", "Cut the welcome to two screens.");

    // Title touched, nothing changed on GitHub: the title alone.
    let (_t, store) = store_with(start());
    let before = now(&store);
    let (calls, stdin) = edit(&store, &before, |c| c.title = "Onboarding: a shorter welcome".into(), vec![view("Onboarding: shorter welcome", "Cut the welcome to two screens.", None, None), ok()]);
    assert_eq!(writes(&calls), vec![&format!("{TITLE_ONLY} Onboarding: a shorter welcome")], "{calls:?}");
    assert!(stdin.is_empty(), "the body isn't sent");
    assert!(now(&store).edit_conflicts.is_empty() && now(&store).gh_last_read.is_none() && !now(&store).sync_pending);

    // Brief touched, nothing changed on GitHub: the body alone, the title not sent.
    let (_t, store) = store_with(start());
    let before = now(&store);
    let (calls, stdin) = edit(&store, &before, |c| c.notes = Some("Cut the welcome to one screen.".into()), vec![view("Onboarding: shorter welcome", "Cut the welcome to two screens.", None, None), ok()]);
    assert_eq!(writes(&calls), vec![&BODY_ONLY.to_string()], "{calls:?}");
    assert_eq!(stdin, vec![github::build_issue_body(Some("Cut the welcome to one screen."), None, None)]);
    assert!(now(&store).gh_last_read.is_none());

    // Title touched here, the brief improved on GitHub meanwhile: no
    // question; the title is written and the teammate's brief is not.
    let (_t, store) = store_with(start());
    let before = now(&store);
    let (calls, stdin) = edit(&store, &before, |c| c.title = "Onboarding: a shorter welcome".into(), vec![view("Onboarding: shorter welcome", "Cut the welcome to two screens.\nKeep the Skip link.", None, None), ok()]);
    assert_eq!(writes(&calls).len(), 1, "{calls:?}");
    assert!(writes(&calls)[0].starts_with(TITLE_ONLY) && stdin.is_empty());
    assert!(now(&store).edit_conflicts.is_empty());

    // Brief touched here and changed on GitHub: nothing is written, the
    // card keeps the member's text and asks.
    let (_t, store) = store_with(start());
    let before = now(&store);
    let (calls, stdin) = edit(
        &store,
        &before,
        |c| c.notes = Some("Cut the welcome to two screens.\nThe second screen asks for the project folder.".into()),
        vec![view("Onboarding: shorter welcome", "Cut the welcome to two screens.\nKeep the \"Skip\" link on both.", None, None), last_change(Some("example-teammate"), None)],
    );
    assert!(writes(&calls).is_empty() && stdin.is_empty(), "nothing is written: {calls:?}");
    assert!(calls.iter().any(|c| c.starts_with("api graphql")), "who changed it is asked once: {calls:?}");
    let card = now(&store);
    assert_eq!(card.notes.as_deref(), Some("Cut the welcome to two screens.\nThe second screen asks for the project folder."), "the member's version stays here");
    assert_eq!(
        card.edit_conflicts,
        vec![EditConflict {
            part: EditPart::Brief,
            theirs: "Cut the welcome to two screens.\nKeep the \"Skip\" link on both.".into(),
            who: Some("example-teammate".into()),
            at: github::rfc3339_ms(Some("2026-11-09T09:56:00Z")),
        }]
    );
    assert!(!card.sync_pending, "it waits for the member, not for a Sync");
    assert!(card.gh_last_read.is_none());

    // Title touched here and renamed on GitHub: the same, for the title.
    let (_t, store) = store_with(start());
    let before = now(&store);
    let (calls, _) = edit(&store, &before, |c| c.title = "Onboarding: a shorter welcome".into(), vec![view("Onboarding: welcome in two screens", "Cut the welcome to two screens.", None, None), last_change(None, Some("example-teammate"))]);
    assert!(writes(&calls).is_empty());
    let card = now(&store);
    assert_eq!(card.title, "Onboarding: a shorter welcome");
    assert_eq!(card.edit_conflicts.len(), 1);
    assert_eq!((card.edit_conflicts[0].part, card.edit_conflicts[0].theirs.as_str(), card.edit_conflicts[0].who.as_deref()), (EditPart::Title, "Onboarding: welcome in two screens", Some("example-teammate")));

    // Both touched; only the brief changed on GitHub: the title goes, the
    // brief asks.
    let (_t, store) = store_with(start());
    let before = now(&store);
    let (calls, stdin) = edit(
        &store,
        &before,
        |c| {
            c.title = "Welcome".into();
            c.notes = Some("Mine.".into());
        },
        vec![view("Onboarding: shorter welcome", "Theirs.", None, None), last_change(None, None), ok()],
    );
    assert_eq!(writes(&calls), vec![&format!("{TITLE_ONLY} Welcome")], "{calls:?}");
    assert!(stdin.is_empty());
    let card = now(&store);
    assert_eq!(card.edit_conflicts.iter().map(|c| (c.part, c.who.clone())).collect::<Vec<_>>(), vec![(EditPart::Brief, None)], "GitHub didn't say who: Someone else");
}

/// D3: a teammate wrote on GitHub exactly what the member wrote here — no
/// question, and nothing to write.
#[test]
fn the_same_text_written_by_both_asks_nothing_and_writes_nothing() {
    let _serial = github::test_serial_lock();
    let (_t, store) = store_with(card_with("T", "Old brief."));
    let before = now(&store);
    let (calls, stdin) = edit(
        &store,
        &before,
        |c| {
            c.notes = Some("New brief.  \n".into());
            c.title = "T2".into();
        },
        vec![view("T2", "New brief.", None, None)],
    );
    assert_eq!(calls.len(), 1, "the read, and nothing else: {calls:?}");
    assert!(stdin.is_empty());
    let card = now(&store);
    assert!(card.edit_conflicts.is_empty() && card.gh_last_read.is_none() && !card.sync_pending);
}

/// D3: what a brief write carries — this computer's notes, and GitHub's
/// current knowledge, text outside the blocks and claim marker. Plyloft's
/// blocks and the marker survive the rewrite; a knowledge edit goes merged
/// with GitHub's current brief.
#[test]
fn a_rewrite_keeps_githubs_other_parts_and_the_claim_marker() {
    let _serial = github::test_serial_lock();
    crate::device_claim::set_test_device(Some(crate::device_claim::ThisDevice { id: "uuid-mini".into(), name: "Mac mini".into() }));
    let other = crate::device_claim::DeviceClaim { device: "dev-pro".into(), name: "MacBook Pro".into(), login: Some("giulia".into()), at: "t1".into() };
    let mut card = card_with("T", "Old brief.");
    card.column_id = KanbanColumnId::InProgress;
    card.knowledge = Some("Old knowledge.".into());
    let (_t, store) = store_with(card);
    let before = now(&store);
    // GitHub meanwhile: new knowledge, a line under the blocks, a marker.
    let body = crate::device_claim::with_claim(&github::build_issue_body(Some("Old brief."), Some("Teammate's knowledge."), Some("A line typed on GitHub.")), Some(&other));
    let (calls, stdin) = edit(&store, &before, |c| c.notes = Some("My brief.".into()), vec![Ok(view_of("T", &body)), ok()]);
    assert_eq!(writes(&calls), vec![&BODY_ONLY.to_string()]);
    let sent = &stdin[0];
    let parsed = github::parse_issue_body(sent);
    assert_eq!(parsed.notes.as_deref(), Some("My brief."));
    assert_eq!(parsed.knowledge.as_deref(), Some("Teammate's knowledge."), "not this computer's older copy");
    assert_eq!(parsed.raw_remainder.as_deref(), Some("A line typed on GitHub."));
    assert_eq!(crate::device_claim::parse(sent), Some(other.clone()), "the marker GitHub has now");
    assert_eq!(now(&store).gh_claim, Some(other.clone()));

    // A knowledge edit: mine, merged with GitHub's current brief. No
    // question even if the knowledge changed on both sides (last writer).
    let before = now(&store);
    let body = crate::device_claim::with_claim(&github::build_issue_body(Some("Teammate's brief."), Some("Teammate's knowledge."), None), Some(&other));
    let (calls, stdin) = edit(&store, &before, |c| c.knowledge = Some("My knowledge.".into()), vec![Ok(view_of("T", &body)), ok()]);
    assert_eq!(writes(&calls).len(), 1, "{calls:?}");
    let parsed = github::parse_issue_body(&stdin[0]);
    assert_eq!((parsed.notes.as_deref(), parsed.knowledge.as_deref()), (Some("Teammate's brief."), Some("My knowledge.")));
    assert!(now(&store).edit_conflicts.is_empty());

    // B3 in the rewrite: an outsider's made-up marker and blocks don't
    // count — the rebuilt body has Plyloft's own block and no such marker.
    let fake = "<!-- plyloft:claim device=aaaa name=\"MacBook Pro\" login=victim at=2026-11-09T10:00:00Z -->";
    store.with_card("ws", &gh_card_id(N), |c| {
        c.gh_author = Some("drive-by-dev".into());
        c.gh_author_association = Some("NONE".into());
        c.notes = Some("Dark mode please.".into());
        c.knowledge = None;
        c.column_id = KanbanColumnId::Todo;
        Ok(())
    })
    .unwrap();
    let before = now(&store);
    let outsiders = format!("Dark mode please.\n{fake}");
    let (_, stdin) = edit(&store, &before, |c| c.notes = Some("Dark mode, for the docs site.".into()), vec![Ok(view_of("T", &outsiders)), ok()]);
    assert_eq!(stdin, vec![github::build_issue_body(Some("Dark mode, for the docs site."), None, None)]);
    assert!(!stdin[0].contains("plyloft:claim"));
    assert!(now(&store).edit_conflicts.is_empty(), "the issue's text was the brief the card had");
    crate::device_claim::set_test_device(None);
}

/// D3: the answer. It applies to the value that was shown: an answer to an
/// older question writes nothing.
#[test]
fn the_answer_applies_to_the_value_shown() {
    let _serial = github::test_serial_lock();
    let asking = || {
        let mut c = card_with("T", "Mine.");
        c.edit_conflicts = vec![EditConflict { part: EditPart::Brief, theirs: "Theirs.".into(), who: Some("giulia".into()), at: Some(1) }];
        store_with(c)
    };
    let run = |store: &KanbanStore, keep: Keep, shown: &str, answers: Vec<Result<String, String>>| {
        github::take_test_gh_invocations();
        github::take_test_gh_stdin();
        github::set_test_gh_responses(answers);
        let out = resolve(store, REPO, "ws", &gh_card_id(N), EditPart::Brief, keep, shown);
        let calls: Vec<String> = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        let stdin = github::take_test_gh_stdin();
        github::clear_test_gh_responses();
        (out, calls, stdin)
    };

    // Use GitHub's: the card takes it; nothing is written.
    let (_t, store) = asking();
    let (out, calls, stdin) = run(&store, Keep::Github, "Theirs.", vec![view("T", "Theirs.", None, None)]);
    assert_eq!(out.unwrap().outcome, Resolved::KeptGithub);
    assert!(writes(&calls).is_empty() && stdin.is_empty());
    assert_eq!(now(&store).notes.as_deref(), Some("Theirs."));
    assert!(now(&store).edit_conflicts.is_empty());

    // Keep mine: the body alone, with the member's brief.
    let (_t, store) = asking();
    let (out, calls, stdin) = run(&store, Keep::Mine, "Theirs.", vec![view("T", "Theirs.", Some("K"), None), ok()]);
    assert_eq!(out.unwrap().outcome, Resolved::KeptMine);
    assert_eq!(writes(&calls), vec![&BODY_ONLY.to_string()]);
    assert_eq!(stdin, vec![github::build_issue_body(Some("Mine."), Some("K"), None)]);
    assert!(now(&store).edit_conflicts.is_empty());

    // GitHub's text changed again before the press: nothing is written,
    // whichever button — the question shows the new value.
    for keep in [Keep::Mine, Keep::Github] {
        let (_t, store) = asking();
        let (out, calls, stdin) = run(&store, keep, "Theirs.", vec![view("T", "Theirs, again.", None, None), last_change(Some("bob"), None)]);
        assert_eq!(out.unwrap().outcome, Resolved::ChangedAgain);
        assert!(writes(&calls).is_empty() && stdin.is_empty(), "{keep:?}");
        let card = now(&store);
        assert_eq!(card.notes.as_deref(), Some("Mine."));
        assert_eq!((card.edit_conflicts[0].theirs.as_str(), card.edit_conflicts[0].who.as_deref()), ("Theirs, again.", Some("bob")));
    }

    // GitHub now has the member's version: no question is left.
    let (_t, store) = asking();
    let (out, calls, _) = run(&store, Keep::Mine, "Theirs.", vec![view("T", "Mine.", None, None)]);
    assert_eq!(out.unwrap().outcome, Resolved::Gone);
    assert!(writes(&calls).is_empty());
    assert!(now(&store).edit_conflicts.is_empty());

    // The write is refused: said as such, and the question stays.
    let (_t, store) = asking();
    let (out, _, _) = run(&store, Keep::Mine, "Theirs.", vec![view("T", "Theirs.", None, None), Err("HTTP 502".into())]);
    let err = out.unwrap_err();
    assert!(err.starts_with(CHOICE_NOT_RECORDED) && err.ends_with("HTTP 502"), "{err}");
    assert_eq!(now(&store).edit_conflicts.len(), 1);
    // So is a read that fails.
    let (out, calls, _) = run(&store, Keep::Github, "Theirs.", vec![Err("offline".into())]);
    assert!(out.unwrap_err().starts_with(CHOICE_NOT_RECORDED));
    assert_eq!(calls.len(), 1);
    assert_eq!(now(&store).notes.as_deref(), Some("Mine."));

    // A title's answer writes the title alone.
    let mut c = card_with("Mine", "B");
    c.edit_conflicts = vec![EditConflict { part: EditPart::Title, theirs: "Theirs".into(), who: None, at: None }];
    let (_t, store) = store_with(c);
    github::take_test_gh_invocations();
    github::set_test_gh_responses(vec![view("Theirs", "B", None, None), ok()]);
    let out = resolve(&store, REPO, "ws", &gh_card_id(N), EditPart::Title, Keep::Mine, "Theirs").unwrap();
    let calls: Vec<String> = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
    github::clear_test_gh_responses();
    assert_eq!(out.outcome, Resolved::KeptMine);
    assert_eq!(writes(&calls), vec![&format!("{TITLE_ONLY} Mine")]);
}

/// D3: an edit made while GitHub can't be reached is sent by the next Sync,
/// judged by what the card had last read — also hours later.
#[test]
fn an_edit_made_offline_is_judged_at_the_sync_that_sends_it() {
    let _serial = github::test_serial_lock();
    let offline = |change: fn(&mut KanbanCard)| {
        let (tmp, store) = store_with(card_with("T", "Old brief."));
        let before = now(&store);
        let (calls, _) = edit(&store, &before, change, vec![Err("error connecting to api.github.com".into())]);
        assert_eq!(calls.len(), 1);
        let card = now(&store);
        assert!(card.sync_pending, "left to Sync");
        (tmp, store)
    };
    let list = |title: &str, notes: &str| {
        Ok(serde_json::json!([{"number": N, "title": title, "body": github::build_issue_body(Some(notes), None, None), "state": "OPEN",
            "assignees": [], "labels": [{"name": "status:todo"}], "updatedAt": "2026-11-09T12:00:00Z"}])
        .to_string())
    };
    let sync = |store: &KanbanStore, answers: Vec<Result<String, String>>| {
        github::take_test_gh_invocations();
        github::take_test_gh_stdin();
        github::set_test_gh_responses(answers);
        crate::github_sync::reconcile(store, "ws", REPO, None, &Default::default()).unwrap();
        let calls: Vec<String> = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        let stdin = github::take_test_gh_stdin();
        github::clear_test_gh_responses();
        (calls, stdin)
    };

    // The brief was edited offline; what it had last read is kept.
    let (_t, store) = offline(|c| c.notes = Some("My brief.".into()));
    assert_eq!(now(&store).gh_last_read.as_ref().and_then(|l| l.brief.clone()), Some(brief_hash(Some("Old brief."))));
    // A second edit before any Sync keeps the first baseline, not its own.
    let before = now(&store);
    edit(&store, &before, |c| c.notes = Some("My brief, again.".into()), vec![Err("offline".into())]);
    assert_eq!(now(&store).gh_last_read.as_ref().and_then(|l| l.brief.clone()), Some(brief_hash(Some("Old brief."))));

    // Sync, GitHub unchanged: the body alone is pushed (plus its labels), and the card is in step.
    let (calls, stdin) = sync(&store, vec![view("T", "Old brief.", None, None), ok(), ok(), list("T", "My brief, again.")]);
    assert!(calls[0].starts_with("issue view 70"), "{calls:?}");
    assert_eq!(writes(&calls)[0], BODY_ONLY, "{calls:?}");
    assert!(!writes(&calls).iter().any(|c| c.contains("--title")), "the title isn't sent: {calls:?}");
    assert_eq!(stdin[0], github::build_issue_body(Some("My brief, again."), None, None));
    let card = now(&store);
    assert!(!card.sync_pending && card.gh_last_read.is_none() && card.edit_conflicts.is_empty());

    // Sync, the brief changed on GitHub meanwhile: not pushed; the card
    // asks, keeps the member's text, and is no longer pending.
    let (_t, store) = offline(|c| c.notes = Some("My brief.".into()));
    let (calls, stdin) = sync(&store, vec![view("T", "Teammate's brief.", None, None), last_change(Some("giulia"), None), ok(), list("T", "Teammate's brief.")]);
    assert!(!writes(&calls).iter().any(|c| c.contains("--body-file") || c.contains("--title")), "{calls:?}");
    assert!(stdin.is_empty());
    let card = now(&store);
    assert_eq!(card.notes.as_deref(), Some("My brief."), "the pull that follows leaves the asked part alone");
    assert_eq!(card.edit_conflicts.iter().map(|c| (c.part, c.theirs.as_str())).collect::<Vec<_>>(), vec![(EditPart::Brief, "Teammate's brief.")]);
    assert!(!card.sync_pending);

    // A card pending from before 1.175.0 has nothing to be judged by: what
    // differs is written as it always was, part by part, with no question.
    let mut old = card_with("My title", "My brief.");
    old.sync_pending = true;
    let (_t, store) = store_with(old);
    let (calls, stdin) = sync(&store, vec![view("Their title", "Their brief.", None, None), ok(), ok(), ok(), list("My title", "My brief.")]);
    let sent = writes(&calls);
    assert!(sent.iter().any(|c| c.starts_with(TITLE_ONLY)) && sent.iter().any(|c| *c == BODY_ONLY), "{calls:?}");
    assert_eq!(stdin, vec![github::build_issue_body(Some("My brief."), None, None)]);
    assert!(now(&store).edit_conflicts.is_empty());
}

/// D3: while a question is open the pull leaves that part as the member
/// wrote it and keeps the question's "GitHub's value" current; every other
/// part follows GitHub; a question GitHub answered by itself goes.
#[test]
fn a_pull_leaves_the_asked_part_alone_and_follows_github_elsewhere() {
    let mut card = card_with("Mine", "My brief.");
    card.workspace_id = "ws".into();
    card.gh_author_association = Some("MEMBER".into());
    card.gh_last_editor = Some("bob".into());
    card.edit_conflicts = vec![EditConflict { part: EditPart::Brief, theirs: "Theirs.".into(), who: Some("giulia".into()), at: Some(1) }];
    let issue = |title: &str, notes: &str| crate::github::GhIssue {
        number: N,
        title: title.into(),
        body: github::build_issue_body(Some(notes), None, None),
        assignees: Vec::new(),
        labels: vec![crate::github::GhLabel { name: "status:todo".into() }],
        state: "OPEN".into(),
        updated_at: "2026-11-09T12:00:00Z".into(),
        author: None,
        created_at: None,
        state_reason: None,
        origin: Some(crate::issue_text::Origin { association: Some("MEMBER".into()), editor: Some("bob".into()) }),
    };
    use crate::github_sync::{reconcile_plan_with, ReconcileAction};
    // The title changed on GitHub (not asked): pulled. The brief: kept.
    let plan = reconcile_plan_with(&[issue("Theirs title", "Theirs.")], std::slice::from_ref(&card), &Default::default());
    match &plan.actions[..] {
        [ReconcileAction::Patch { title, notes, edit_conflicts, .. }] => {
            assert_eq!(title, "Theirs title");
            assert_eq!(notes.as_deref(), Some("My brief."));
            assert!(edit_conflicts.is_none(), "the question is as it was");
        }
        other => panic!("expected one patch, got {other:?}"),
    }
    // GitHub's brief changed again: the question shows the new value, who and when.
    let plan = reconcile_plan_with(&[issue("Mine", "Theirs, again.")], std::slice::from_ref(&card), &Default::default());
    match &plan.actions[..] {
        [ReconcileAction::Patch { notes, edit_conflicts: Some(conflicts), .. }] => {
            assert_eq!(notes.as_deref(), Some("My brief."));
            assert_eq!((conflicts[0].theirs.as_str(), conflicts[0].who.as_deref()), ("Theirs, again.", Some("bob")));
            assert_eq!(conflicts[0].at, github::rfc3339_ms(Some("2026-11-09T12:00:00Z")));
        }
        other => panic!("expected the question refreshed, got {other:?}"),
    }
    // GitHub now has what the member wrote: the question goes by itself.
    let plan = reconcile_plan_with(&[issue("Mine", "My brief.")], std::slice::from_ref(&card), &Default::default());
    assert!(matches!(&plan.actions[..], [ReconcileAction::Patch { edit_conflicts: Some(c), .. }] if c.is_empty()), "{:?}", plan.actions);
    // Nothing new: nothing to do.
    let plan = reconcile_plan_with(&[issue("Mine", "Theirs.")], std::slice::from_ref(&card), &Default::default());
    assert!(plan.actions.is_empty(), "{:?}", plan.actions);

    // The same for the title, by the pure rule.
    let mut titled = card_with("Mine", "B");
    titled.edit_conflicts = vec![EditConflict { part: EditPart::Title, theirs: "Theirs".into(), who: None, at: None }];
    let kept = kept_on_pull(&titled, "Theirs 2", Some("B2"), None, None);
    assert_eq!(kept.title.as_deref(), Some("Mine"));
    assert!(kept.notes.is_none(), "the brief isn't asked about: it follows GitHub");
    assert_eq!(kept.conflicts.unwrap()[0].theirs, "Theirs 2");
    let none = kept_on_pull(&card_with("T", "B"), "X", Some("Y"), None, None);
    assert!(none.title.is_none() && none.notes.is_none() && none.conflicts.is_none());
}

/// Tier 2 schema-migration (D3): a board written by 1.174.5 has neither
/// field. It loads without them and is written back without them; the
/// card's first edit compares GitHub with the value from before that edit,
/// so nothing is asked that isn't a real double change.
#[test]
fn a_card_from_before_the_fields_edits_without_a_false_question() {
    let _serial = github::test_serial_lock();
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let path = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let json = format!(
        r#"{{
        "version": {},
        "cards": [{{
            "id": "gh-issue-70",
            "workspaceId": "ws",
            "title": "Onboarding: shorter welcome",
            "columnId": "todo",
            "notes": "Cut the welcome to two screens.",
            "ghIssueNumber": 70,
            "ghAssignees": [],
            "createdAt": 1,
            "updatedAt": 2
        }}]
    }}"#,
        crate::kanban::KANBAN_SCHEMA_VERSION
    );
    std::fs::write(&path, json.as_bytes()).unwrap();
    let cards = store.load("ws").unwrap();
    assert!(cards[0].gh_last_read.is_none() && cards[0].edit_conflicts.is_empty());
    assert_eq!(cards[0].notes.as_deref(), Some("Cut the welcome to two screens."));
    store.save("ws", cards).unwrap();
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(!written.contains("ghLastRead") && !written.contains("editConflicts"), "{written}");

    // Its first edit: GitHub still has what the card had → written, no question.
    let before = now(&store);
    let (calls, _) = edit(&store, &before, |c| c.notes = Some("One screen.".into()), vec![view("Onboarding: shorter welcome", "Cut the welcome to two screens.", None, None), ok()]);
    assert_eq!(writes(&calls), vec![&BODY_ONLY.to_string()]);
    let card = now(&store);
    assert!(card.edit_conflicts.is_empty() && card.gh_last_read.is_none());
    assert!(!std::fs::read_to_string(&path).unwrap().contains("ghLastRead"));

    // A question, once raised, is in the file and reads back.
    let before = now(&store);
    edit(&store, &before, |c| c.title = "Mine".into(), vec![view("Theirs", "One screen.", None, None), last_change(None, Some("giulia"))]);
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(written.contains("editConflicts") && written.replace(' ', "").contains("\"part\":\"title\""), "{written}");
    let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap().load("ws").unwrap();
    assert_eq!(again[0].edit_conflicts[0].theirs, "Theirs");
}

/// D3: a card with an open question is a Needs you row from its record
/// alone; a landed, archived or pull-request-review card asks nothing.
#[test]
fn a_card_with_an_open_question_is_a_needs_you_row() {
    let mut card = card_with("T", "B");
    card.updated_at = crate::kanban::now_ms();
    card.edit_conflicts = vec![
        EditConflict { part: EditPart::Title, theirs: "x".into(), who: None, at: None },
        EditConflict { part: EditPart::Brief, theirs: "y".into(), who: None, at: None },
    ];
    let rows = |card: &KanbanCard| crate::inbox::derive_card_events("WS", std::slice::from_ref(card), 0);
    let events = rows(&card);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].id, "edit:gh-issue-70");
    assert_eq!(events[0].group, crate::inbox::InboxGroup::NeedsYou);
    assert_eq!(events[0].detail.as_deref(), Some("The brief changed on GitHub · choose which version the card keeps"));
    card.edit_conflicts.remove(1);
    assert_eq!(rows(&card)[0].detail.as_deref(), Some("The title changed on GitHub · choose which version the card keeps"));
    let mut archived = card.clone();
    archived.archived = true;
    assert!(rows(&archived).is_empty());
    let mut shipped = card.clone();
    shipped.ship_status = crate::kanban::ShipStatus::Shipped;
    assert!(!rows(&shipped).iter().any(|e| e.id.starts_with("edit:")));
    card.edit_conflicts.clear();
    assert!(rows(&card).is_empty());
}

/// D3: where the rule is asked — the member's edit hands over the card as
/// it was; no write of an issue's text sends its title any more; the Sync's
/// push goes through the same rule.
#[test]
fn every_write_of_an_issues_text_goes_through_the_rule() {
    let commands = include_str!("commands.rs");
    let code = commands.split("#[cfg(test)]\nmod tests").next().unwrap();
    assert!(!code.contains("fn gh_sync_card_edit("), "moved here");
    let patch = &code[code.find("pub fn kanban_card_patch<").unwrap()..];
    let patch = &patch[..patch.find("\n}\n").unwrap()];
    let before = patch.find("let before = store.get_card(&workspace_id, &card_id)?;").expect("the card as it was");
    assert!(before < patch.find("store.patch_card(").unwrap());
    assert!(patch.contains("gh_sync_card_edit(&store, &repo, &workspace_id, Some(&before), &updated, touched_body, touched_column);"));
    // Title and body together are sent only when an issue is made.
    for file in ["commands.rs", "github_sync.rs", "issue_edit.rs", "device_claim.rs", "card_claim.rs"] {
        let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file)).unwrap();
        let code = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        assert!(!code.contains("github::issue_edit("), "{file} still rewrites a title with a body");
    }
    let sync = include_str!("github_sync.rs");
    assert!(sync.contains("crate::issue_edit::push_pending(store, repo, workspace_id, card, n)?;"));
}

/// D3 round 2: *Use as brief* is the member's edit of the brief, judged by
/// the card as it was before the press. It replaced the whole body with no
/// baseline, so a teammate's brief written meanwhile was lost (TM-4's case).
#[test]
fn use_as_brief_is_judged_as_an_edit_of_the_brief() {
    let _serial = github::test_serial_lock();
    let mut card = card_with("T", "Mine.");
    card.gh_raw_remainder = Some("Text outside.".into());
    let (_tmp, store) = store_with(card);
    let before = now(&store);
    let adopt = |store: &KanbanStore| {
        let before = now(store);
        let after = store.adopt_gh_remainder("ws", &before.id, None).unwrap();
        (before, after)
    };

    // GitHub still has the brief this computer read: the brief is written,
    // the outside text moved into it (not left outside twice), title untouched.
    let (b, after) = adopt(&store);
    github::take_test_gh_invocations();
    github::take_test_gh_stdin();
    github::set_test_gh_responses(vec![view("T", "Mine.", None, Some("Text outside.")), ok()]);
    gh_sync_card_edit(&store, REPO, "ws", Some(&b), &after, true, false);
    let calls: Vec<String> = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
    let stdin = github::take_test_gh_stdin();
    github::clear_test_gh_responses();
    assert_eq!(writes(&calls), [&BODY_ONLY.to_string()], "{calls:?}");
    let parsed = github::parse_issue_body(&stdin[0]);
    assert_eq!(parsed.notes.as_deref(), after.notes.as_deref());
    assert!(parsed.notes.as_deref().unwrap().contains("Text outside."));
    assert_eq!(parsed.raw_remainder, None, "the moved text isn't left outside too: {}", stdin[0]);
    assert!(now(&store).edit_conflicts.is_empty());

    // A teammate rewrote the brief meanwhile: nothing is written, the card asks.
    let mut card = before.clone();
    card.notes = Some("Mine.".into());
    card.gh_raw_remainder = Some("Text outside.".into());
    let (_tmp, store) = store_with(card);
    let (b, after) = adopt(&store);
    github::take_test_gh_invocations();
    github::set_test_gh_responses(vec![view("T", "Giulia's better brief.", None, Some("Text outside.")), last_change(Some("giulia"), None)]);
    gh_sync_card_edit(&store, REPO, "ws", Some(&b), &after, true, false);
    let calls: Vec<String> = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
    github::clear_test_gh_responses();
    assert!(writes(&calls).is_empty(), "{calls:?}");
    let asked = now(&store).edit_conflicts;
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0].part, asked[0].theirs.as_str(), asked[0].who.as_deref()), (EditPart::Brief, "Giulia's better brief.", Some("giulia")));

    // Outside text GitHub has that isn't what was moved stays where it is.
    let mut card = before.clone();
    card.gh_raw_remainder = Some("Text outside.".into());
    let (_tmp, store) = store_with(card);
    let (b, after) = adopt(&store);
    github::take_test_gh_stdin();
    github::set_test_gh_responses(vec![view("T", "Mine.", None, Some("Text outside, and more.")), ok()]);
    gh_sync_card_edit(&store, REPO, "ws", Some(&b), &after, true, false);
    let stdin = github::take_test_gh_stdin();
    github::clear_test_gh_responses();
    github::take_test_gh_invocations();
    assert_eq!(github::parse_issue_body(&stdin[0]).raw_remainder.as_deref(), Some("Text outside, and more."));

    // The command passes the card as it was.
    let commands = include_str!("commands.rs");
    let code = &commands[commands.find("pub fn kanban_card_use_issue_remainder<").unwrap()..];
    let code = &code[..code.find("\n}\n").unwrap()];
    assert!(code.contains("let (before, updated) = (store.get_card(&workspace_id, &card_id)?, store.adopt_gh_remainder(&workspace_id, &card_id, email)?);"));
    assert!(code.contains("gh_sync_card_edit(&store, &repo, &workspace_id, Some(&before), &updated, true, false);"));
}
