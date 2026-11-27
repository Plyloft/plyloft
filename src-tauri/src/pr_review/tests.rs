//! Challenger on a pull request: the pasted link, GitHub's answers, whose
//! pull request it is, the card's record and its refresh, what the card
//! offers, the refusals, the persisted field, the worktree on
//! the pull request's head and the review's snapshot.

use super::*;
use crate::kanban::{BuildSnapshot, BuilderReview, KanbanColumnId, KanbanStore};
use std::fs;

const REPO: &str = "test-owner/plyloft-ci-sandbox";
const HEAD: &str = "1111111111111111111111111111111111111111";
const NEXT: &str = "2222222222222222222222222222222222222222";

/// `gh pr view 12 --json PR_VIEW_FIELDS`, the shape gh 2.x answers with.
fn view_json(state: &str, author: &str, cross: bool, head: &str) -> String {
    serde_json::json!({
        "number": 12,
        "title": "Add the retry",
        "url": format!("https://github.com/{REPO}/pull/12"),
        "state": state,
        "author": { "login": author, "is_bot": false },
        "body": "Retries the upload twice.",
        "baseRefName": "main",
        "headRefName": "retry-upload",
        "headRefOid": head,
        "isCrossRepository": cross,
    })
    .to_string()
}

fn facts() -> PrFacts {
    parse_pr_view(&view_json("OPEN", "octo", false, HEAD)).unwrap()
}

fn pr_card(pushable: bool) -> KanbanCard {
    let mut card = KanbanCard::new("card-x-pr12".into(), "ws".into(), card_title(&facts()), Some(brief(&facts())), KanbanColumnId::InProgress);
    card.worktree_path = Some("/w/card-x-pr12".into());
    card.branch_name = Some("plyloft/card-xpr12-review-add-the-retry".into());
    let note = (!pushable).then(|| "This is octo's pull request: the Reviewer only reviews it, and the Builder doesn't change it.".to_string());
    card.pr_review = Some(new_review(&facts(), REPO, HEAD, pushable, note, 1));
    card.builder = Some(builder_state_for("claude").unwrap());
    card
}

#[test]
fn a_pasted_link_or_number_names_a_pull_request_of_this_repository() {
    assert_eq!(parse_pr_input("12", REPO), Ok(12));
    assert_eq!(parse_pr_input(" #12 ", REPO), Ok(12));
    assert_eq!(parse_pr_input(&format!("https://github.com/{REPO}/pull/12"), REPO), Ok(12));
    assert_eq!(parse_pr_input(&format!("https://github.com/{REPO}/pull/12/files"), REPO), Ok(12));
    assert_eq!(parse_pr_input(&format!("https://github.com/{REPO}/pull/12#discussion_r1"), REPO), Ok(12));
    // GitHub's names are case-insensitive.
    assert_eq!(parse_pr_input("https://github.com/TEST-OWNER/Plyloft-CI-Sandbox/pull/7", REPO), Ok(7));
    let other = parse_pr_input("https://github.com/someone/else/pull/3", REPO).unwrap_err();
    assert!(other.contains("someone/else") && other.contains(REPO), "{other}");
    for bad in ["", "0", "#", "pull 12", "https://github.com/a/b/issues/3", "https://gitlab.com/a/b/pull/3"] {
        assert!(parse_pr_input(bad, REPO).is_err(), "{bad:?}");
    }
}

#[test]
fn github_answers_are_read_as_facts_and_a_list() {
    let f = facts();
    assert_eq!((f.number, f.state, f.author.as_deref()), (12, PrState::Open, Some("octo")));
    assert_eq!((f.base_ref.as_str(), f.head_ref.as_str(), f.head_sha.as_str()), ("main", "retry-upload", HEAD));
    assert!(!f.cross_repository);
    assert_eq!(parse_pr_view(&view_json("MERGED", "octo", false, HEAD)).unwrap().state, PrState::Merged);
    assert_eq!(parse_pr_view(&view_json("CLOSED", "octo", false, HEAD)).unwrap().state, PrState::Closed);
    // An unknown fork flag never reads as "same repository".
    let unknown = parse_pr_view(r#"{"number":3,"baseRefName":"main","state":"OPEN"}"#).unwrap();
    assert!(unknown.cross_repository && unknown.author.is_none());
    assert!(parse_pr_view(r#"{"number":3}"#).is_err(), "no base branch");

    let mut reviewed = pr_card(false);
    reviewed.id = "already".into();
    let list = serde_json::json!([
        { "number": 12, "title": "Add the retry", "url": "u12", "author": { "login": "Octo" },
          "headRefName": "retry-upload", "baseRefName": "main", "isCrossRepository": false, "isDraft": false,
          "updatedAt": "2026-10-14T10:00:00Z" },
        { "number": 13, "title": "From a fork", "url": "u13", "author": { "login": "stranger" },
          "headRefName": "patch-1", "baseRefName": "main", "isCrossRepository": true, "isDraft": true },
    ])
    .to_string();
    let prs = parse_pr_list(&list, Some("octo"), &[reviewed]).unwrap();
    assert_eq!(prs.len(), 2);
    assert!(prs[0].mine && prs[0].card_id.as_deref() == Some("already"));
    assert!(!prs[1].mine && prs[1].cross_repository && prs[1].draft && prs[1].card_id.is_none());
}

/// The two `gh` wrappers this feature adds are reads of this repository,
/// bounded like every GitHub call.
#[test]
fn the_two_gh_wrappers_are_bounded_reads() {
    let _serial = crate::github::test_serial_lock();
    crate::github::set_test_gh_responses(vec![Ok("[]".into()), Ok(view_json("OPEN", "octo", false, HEAD))]);
    assert_eq!(crate::github::pr_list_for_review(REPO).unwrap(), "[]");
    assert!(parse_pr_view(&crate::github::pr_view_for_review(REPO, 12).unwrap()).is_ok());
    let calls = crate::github::take_test_gh_invocations();
    crate::github::clear_test_gh_responses();
    assert_eq!(
        calls,
        vec![
            ["pr", "list", "--repo", REPO, "--state", "open", "--limit", "50", "--json", PR_LIST_FIELDS]
                .map(String::from)
                .to_vec(),
            ["pr", "view", "12", "--repo", REPO, "--json", PR_VIEW_FIELDS].map(String::from).to_vec(),
        ]
    );
    for args in &calls {
        assert_eq!(crate::github::gh_timeout_for(&args.iter().map(String::as_str).collect::<Vec<_>>()), crate::github::GH_API_TIMEOUT);
    }
}

/// P3-6: the feature reaches GitHub only through read wrappers — every
/// `crate::github::` name its source uses is on this list.
#[test]
fn the_feature_uses_only_githubs_read_wrappers() {
    let source = include_str!("../pr_review.rs");
    let allowed = [
        "pr_list_for_review",
        "pr_view_for_review",
        "current_login",
        "repo_access",
        "repo_default_branch",
        "is_gh_timeout",
    ];
    let mut used: Vec<&str> = source
        .match_indices("crate::github::")
        .map(|(i, m)| {
            let rest = &source[i + m.len()..];
            let end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(rest.len());
            &rest[..end]
        })
        .collect();
    used.sort();
    used.dedup();
    for name in &used {
        assert!(allowed.contains(name), "crate::github::{name} is not a read wrapper on the list");
    }
    assert!(used.contains(&"pr_view_for_review") && used.contains(&"pr_list_for_review"));
    // And no `gh` or git write is spelled in it directly.
    for verb in ["\"comment\"", "\"edit\"", "\"push\"", "issue_"] {
        assert!(!source.contains(verb), "{verb}");
    }
}

#[test]
fn only_the_members_own_pull_request_of_this_repository_is_fixable() {
    let mine = facts();
    assert_eq!(fix_permission(&mine, Some("octo"), Some(true)), (true, None));
    assert_eq!(fix_permission(&mine, Some("OCTO"), None), (true, None), "GitHub didn't say: it still decides at the push");
    let (ok, why) = fix_permission(&mine, Some("colleague"), Some(true));
    assert!(!ok && why.unwrap().contains("octo's pull request"));
    let (ok, why) = fix_permission(&mine, Some("octo"), Some(false));
    assert!(!ok && why.unwrap().contains("can't push"));
    let (ok, why) = fix_permission(&mine, None, Some(true));
    assert!(!ok && why.unwrap().contains("which GitHub account"));
    let fork = parse_pr_view(&view_json("OPEN", "octo", true, HEAD)).unwrap();
    let (ok, why) = fix_permission(&fork, Some("octo"), Some(true));
    assert!(!ok && why.unwrap().contains("fork"), "even the member's own fork is review-only");
}

#[test]
fn the_card_is_titled_and_briefed_from_the_pull_request() {
    let f = facts();
    assert_eq!(card_title(&f), "Review: Add the retry");
    let b = brief(&f);
    assert!(b.starts_with("Pull request #12 by @octo: Add the retry\n"), "{b}");
    assert!(b.contains("Its branch retry-upload merges into main."), "{b}");
    assert!(b.contains("as its author wrote it:\n\nRetries the upload twice."), "{b}");
    let mut long = f.clone();
    long.body = "x".repeat(BRIEF_BODY_MAX + 50);
    long.title = String::new();
    assert!(brief(&long).ends_with('…'));
    assert_eq!(card_title(&long), "Review: pull request #12");
}

#[test]
fn a_refresh_keeps_the_new_head_and_state_and_a_fork_is_never_pushable() {
    let mut r = new_review(&facts(), REPO, HEAD, true, None, 1);
    assert!(!apply_facts(&mut r, &facts(), 5), "nothing changed");
    assert_eq!(r.checked_at, 5);
    let moved = parse_pr_view(&view_json("OPEN", "octo", false, NEXT)).unwrap();
    assert!(apply_facts(&mut r, &moved, 6));
    assert_eq!((r.head_sha.as_str(), r.branch_head.as_deref()), (NEXT, None), "the branch moves only with an admitted review");
    let merged = parse_pr_view(&view_json("MERGED", "octo", false, NEXT)).unwrap();
    assert!(apply_facts(&mut r, &merged, 7));
    assert_eq!(r.state, PrState::Merged);
    assert_eq!(r.closed_at, 7, "merged or closed: the close is recorded");
    let fork = parse_pr_view(&view_json("OPEN", "octo", true, NEXT)).unwrap();
    apply_facts(&mut r, &fork, 8);
    assert!(!r.pushable && r.fix_note.as_deref().is_some_and(|n| n.contains("fork")));
    r.read_error = Some("offline".into());
    apply_facts(&mut r, &fork, 9);
    assert_eq!(r.read_error, None, "a read that worked clears the last failure");
}

fn review(n: u32, status: &str, verdict: Option<&str>) -> BuilderReview {
    BuilderReview {
        snapshot_n: n,
        provider: "claude".into(),
        status: status.into(),
        verdict: verdict.map(str::to_string),
        ..Default::default()
    }
}

#[test]
fn the_card_offers_review_review_again_or_nothing() {
    let mut card = pr_card(false);
    assert_eq!(review_offer(&card), Some(ReviewOffer::Review), "never reviewed");
    let b = card.builder.as_mut().unwrap();
    b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    b.review = Some(review(1, "running", None));
    assert_eq!(review_offer(&card), Some(ReviewOffer::Running));
    card.builder.as_mut().unwrap().review = Some(review(1, "done", Some("approve")));
    assert_eq!(review_offer(&card), Some(ReviewOffer::Current));
    card.builder.as_mut().unwrap().review = Some(review(1, "done", Some("incomplete")));
    assert_eq!(review_offer(&card), Some(ReviewOffer::RunAgain));
    card.builder.as_mut().unwrap().review = Some(review(1, "failed", None));
    assert_eq!(review_offer(&card), Some(ReviewOffer::RunAgain));
    card.builder.as_mut().unwrap().review = Some(review(1, "done", Some("changes_requested")));
    card.pr_review.as_mut().unwrap().head_sha = NEXT.into();
    assert_eq!(review_offer(&card), Some(ReviewOffer::NewCommits), "a push to the pull request");
    // P3-1: a head the card has as a snapshot (a pushed fix) is not new.
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 });
    card.builder.as_mut().unwrap().review = Some(review(2, "done", Some("approve")));
    assert_eq!(review_offer(&card), Some(ReviewOffer::Current));
    card.pr_review.as_mut().unwrap().state = PrState::Closed;
    assert_eq!(review_offer(&card), Some(ReviewOffer::Closed));
    assert_eq!(review_offer(&KanbanCard::new("c".into(), "ws".into(), "t".into(), None, KanbanColumnId::Todo)), None);
}

#[test]
fn the_builder_and_ship_refusals_say_why() {
    let theirs = pr_card(false);
    assert!(builder_refusal(&theirs).unwrap().contains("octo's pull request"));
    let mut mine = pr_card(true);
    assert_eq!(builder_refusal(&mine), None);
    assert!(ship_refusal(&mine).unwrap().contains("Send the fixes to GitHub"));
    mine.pr_review.as_mut().unwrap().state = PrState::Merged;
    assert!(builder_refusal(&mine).unwrap().contains("merged"));
    let plain = KanbanCard::new("c".into(), "ws".into(), "t".into(), None, KanbanColumnId::Todo);
    assert_eq!((builder_refusal(&plain), ship_refusal(&plain)), (None, None));
    assert!(builder_lead(&pr_card(true)).unwrap().contains("never push"));
    assert_eq!(builder_lead(&plain), None);
    // Build with both refuses it, whoever's it is.
    assert!(crate::build_both::start_refusal(&pr_card(true), |_| None).is_some());
    assert!(crate::build_both::start_refusal(&theirs, |_| None).unwrap().contains("octo's"));
}

#[test]
fn the_review_is_measured_from_the_pull_requests_base() {
    let mut card = pr_card(false);
    card.pr_review.as_mut().unwrap().base_ref = "release/2".into();
    assert_eq!(review_target(&card, "main"), "release/2");
    let plain = KanbanCard::new("c".into(), "ws".into(), "t".into(), None, KanbanColumnId::Todo);
    assert_eq!(review_target(&plain, "main"), "main");
}

/// A card written while the Free plan's slot existed carries `slotReleased`:
/// it still loads, the field is dropped, and the card reads the same.
#[test]
fn a_card_with_the_old_slot_released_field_still_loads() {
    let old = serde_json::json!({
        "id": "c3", "workspaceId": "ws", "title": "Review: x", "columnId": "in_progress",
        "createdAt": 1, "updatedAt": 1,
        "prReview": { "number": 4, "url": "u", "repo": REPO, "baseRef": "main", "headSha": HEAD,
                      "state": "merged", "slotReleased": true }
    });
    let card: KanbanCard = serde_json::from_value(old).unwrap();
    let r = card.pr_review.as_ref().unwrap();
    assert_eq!((r.number, r.state), (4, PrState::Merged));
    let written = serde_json::to_value(&card).unwrap();
    assert!(written["prReview"].get("slotReleased").is_none(), "{written}");
}

/// P2-4: the Inbox asks what the review asks, and nothing once it is over.
#[test]
fn the_inbox_asks_what_the_review_asks() {
    let words = |c: &KanbanCard| {
        crate::inbox::derive_card_events("Lyra", std::slice::from_ref(c), 0)
            .into_iter()
            .map(|e| e.detail.unwrap_or_default())
            .collect::<Vec<_>>()
    };
    let mut card = pr_card(false);
    assert_eq!(words(&card), vec!["Pull request #12 · not reviewed yet".to_string()]);
    let b = card.builder.as_mut().unwrap();
    b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    b.review = Some(review(1, "running", None));
    assert!(words(&card).is_empty(), "reviewing: nothing asked");
    card.builder.as_mut().unwrap().review = Some(review(1, "done", Some("changes_requested")));
    card.review_status = Some(crate::kanban::ReviewStatus::ChangesRequested);
    assert_eq!(words(&card), vec!["Pull request #12 · changes requested".to_string()], "once, not twice");
    card.builder.as_mut().unwrap().review = Some(review(1, "done", Some("approve")));
    card.review_status = None;
    assert!(words(&card).is_empty(), "approved: nothing asked");
    card.pr_review.as_mut().unwrap().head_sha = NEXT.into();
    assert_eq!(words(&card), vec!["Pull request #12 · new commits to review".to_string()]);
    card.pr_review.as_mut().unwrap().state = PrState::Merged;
    assert!(words(&card).is_empty(), "merged: resolved");
    let mut mine = pr_card(true);
    let b = mine.builder.as_mut().unwrap();
    b.snapshots = vec![BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 }, BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 }];
    b.review = Some(review(2, "done", Some("approve")));
    mine.pr_review.as_mut().unwrap().heads = vec![1];
    mine.pr_review.as_mut().unwrap().branch_head = Some(HEAD.into());
    assert_eq!(words(&mine), vec!["Pull request #12 · fix ready to push".to_string()]);
    let mut failed = mine.clone();
    failed.verify_status = crate::kanban::VerifyStatus::Failed;
    assert!(!words(&failed).contains(&"Pull request #12 · fix ready to push".to_string()), "checks failed: not ready");
    assert!(!merge_offered(&mine));
    mine.pr_review.as_mut().unwrap().head_sha = "5555555555555555555555555555555555555555".into();
    assert!(merge_offered(&mine));
    assert_eq!(words(&mine), vec!["Pull request #12 · new commits under your fix".to_string()]);
}

#[test]
fn no_push_to_a_target_default_or_base_branch() {
    let protected = vec!["main".to_string(), "develop".to_string()];
    assert!(protected_branch_refusal("main", &protected).unwrap().contains("target, default or base"));
    assert!(protected_branch_refusal(" develop ", &protected).is_some());
    assert_eq!(protected_branch_refusal("retry-upload", &protected), None);
    let mut same = facts();
    same.head_ref = "main".into();
    assert!(!fix_permission(&same, Some("octo"), Some(true)).0, "a pull request from its own base branch");
}

/// P3-5: someone else's pull request gets no Verify, no line comments and
/// no put back; the member's own does (but no put back).
#[test]
fn someone_elses_pull_request_gets_no_builder_work_of_any_kind() {
    assert!(work_refusal(&pr_card(false)).unwrap().contains("only reviews it"));
    assert_eq!(work_refusal(&pr_card(true)), None);
    assert_eq!(crate::put_back::refusal(&pr_card(true), false).as_deref(), Some(PUT_BACK_REFUSAL));
    let (_tmp, store) = store_with(pr_card(false));
    let draft: crate::line_comments::LineCommentDraft = serde_json::from_value(serde_json::json!({
        "path": "a.txt", "newStart": 1, "newEnd": 1, "body": "x"
    }))
    .unwrap_or_else(|e| panic!("draft: {e}"));
    assert!(store.add_line_comment("ws", "card-x-pr12", draft).unwrap_err().contains("only reviews it"));
}

/// 1.175.0 G7 (proof P3): no terminal tile starts in the copy of a pull
/// request Plyloft only reviews, at or under it; the member's own pushable
/// pull request, another card's copy, a copy without a card and the project
/// folder are untouched.
fn terminal_cards() -> Vec<KanbanCard> {
    let at = |card: &mut KanbanCard, path: &str| card.worktree_path = Some(path.into());
    let mut theirs = pr_card(false);
    at(&mut theirs, "/w/.plyloft-worktrees/card-x-pr12");
    let mut mine = pr_card(true);
    mine.id = "card-y-pr13".into();
    at(&mut mine, "/w/.plyloft-worktrees/card-y-pr13");
    // The member's own pull request that Plyloft can't push to.
    let mut protected = pr_card(true);
    protected.id = "card-p-pr14".into();
    at(&mut protected, "/w/.plyloft-worktrees/card-p-pr14");
    assert!(apply_protected_head(protected.pr_review.as_mut().unwrap(), &["retry-upload".to_string()]));
    let mut plain = KanbanCard::new("card-z".into(), "ws".into(), "A card".into(), None, KanbanColumnId::InProgress);
    at(&mut plain, "/w/.plyloft-worktrees/card-z");
    plain.build_both = Some(crate::build_both::new_record(
        "/w/.plyloft-worktrees/card-z",
        "plyloft/card-z",
        "/w/.plyloft-worktrees/card-z-b",
        "plyloft/card-z-b",
        false,
        1,
    ));
    vec![theirs, mine, protected, plain]
}

fn only_reviews() -> String {
    format!(
        "This folder is the copy of a pull request Plyloft only reviews, so it opens no terminal in it: its files \
         could run things on {} without asking. The card's Reviewer reads it.",
        crate::platform::THIS_MACHINE
    )
}

fn cannot_tell() -> String {
    format!(
        "Plyloft couldn't tell which card this folder is the copy of, so it opens no terminal in it: the copy of \
         a pull request it only reviews could run things on {} without asking.",
        crate::platform::THIS_MACHINE
    )
}

#[test]
fn no_terminal_starts_in_the_copy_of_a_pull_request_plyloft_only_reviews() {
    let cards = terminal_cards();
    let refused = |cwd: &str| terminal_refusal(Some(&cards), Path::new(cwd));
    // Somebody else's, and the member's own that Plyloft can't push to: the
    // sentence is true of both.
    for copy in ["/w/.plyloft-worktrees/card-x-pr12", "/w/.plyloft-worktrees/card-x-pr12/src/deep", "/w/.plyloft-worktrees/card-p-pr14"] {
        assert_eq!(refused(copy), Some(only_reviews()), "{copy}");
    }
    assert!(!only_reviews().contains("somebody else"));
    for fine in [
        "/w/.plyloft-worktrees/card-y-pr13",
        "/w/.plyloft-worktrees/card-z",
        "/w/.plyloft-worktrees/card-z-b/src",
        "/w",
        "/w/src",
        "/w/.plyloft-worktrees/copy-c0821453",
    ] {
        assert_eq!(refused(fine), None, "{fine}");
    }
    // The spawn of every tile asks it, before anything starts.
    let spawn = include_str!("../commands.rs");
    let body = &spawn[spawn.find("pub fn pty_spawn(").unwrap()..];
    let check = body.find("crate::pr_review::refuse_terminal(&app, workspace_id.as_deref(), cwd.as_deref())?").expect("the check");
    assert!(check < body.find("registry.spawn_tile(").unwrap(), "before the spawn");
}

/// Round 3: the refusal fails closed. With no board (it couldn't be read,
/// or the tile names no workspace) a folder that is a card's copy by its
/// path starts no terminal; a board read as empty (its file set aside) or
/// one where no card owns the copy doesn't either. A folder under no
/// worktrees root, and a copy without a card, always start.
#[test]
fn a_cards_copy_starts_no_terminal_when_its_card_cannot_be_told() {
    let cards = terminal_cards();
    for copy in ["/w/.plyloft-worktrees/card-x-pr12", "/w/.plyloft-worktrees/card-z", "/w/.atelier-worktrees/card-old/src"] {
        assert_eq!(terminal_refusal(None, Path::new(copy)), Some(cannot_tell()), "no board: {copy}");
        assert_eq!(terminal_refusal(Some(&[]), Path::new(copy)), Some(cannot_tell()), "an empty board: {copy}");
    }
    assert_eq!(terminal_refusal(Some(&cards), Path::new("/w/.plyloft-worktrees/card-gone")), Some(cannot_tell()));
    for fine in ["/w", "/w/src", "/Users/someone", "/w/.plyloft-worktrees/copy-c0821453", "/w/.plyloft-worktrees/copy-c0821453/src"] {
        assert_eq!(terminal_refusal(None, Path::new(fine)), None, "{fine}");
        assert_eq!(terminal_refusal(Some(&[]), Path::new(fine)), None, "{fine}");
    }
    // The command gives it the board only when the tile's workspace has one it could read.
    let own = include_str!("../pr_review.rs");
    let (_, body) = own.split_once("pub fn refuse_terminal<R: tauri::Runtime>(").unwrap();
    let body = body.split_once("\n}\n").unwrap().0;
    assert!(body.contains("workspace_id.and_then(|id| app.try_state::<KanbanStore>().and_then(|store| store.load(id).ok()))"));
    assert!(!body.contains("unwrap_or_default"), "an unread board is not an empty one");
}

/// Merged with v1.165.0: the card's Chat is told what the card is — never
/// that a Builder changes someone else's pull request.
#[test]
fn the_cards_chat_is_told_whose_pull_request_it_is() {
    use crate::chat::{chat_instructions, ChatContext};
    use crate::chat_store::ChatVendor;
    for (pushable, words) in [(false, "someone else's pull request"), (true, "the member's own pull request")] {
        let card = pr_card(pushable);
        let context = ChatContext {
            title: card.title.clone(),
            notes: card.notes.clone().unwrap_or_default(),
            project_dir: None,
            plan: None,
            pull_request: chat_note_of(&card),
        };
        let text = chat_instructions(ChatVendor::Claude, &context, Path::new("/att"));
        assert!(text.contains("This card reviews pull request #12"), "{text}");
        assert!(text.contains(words), "{text}");
        assert!(!text.contains("Code changes are made by the card's Builder"), "{text}");
    }
    let plain = ChatContext { title: "T".into(), ..ChatContext::default() };
    assert!(chat_instructions(ChatVendor::Codex, &plain, Path::new("/att")).contains("Code changes are made by the card's Builder"));
}

/// Walk of #386: the chat is told the pull request's range in its folder
/// when the card recorded where it leaves its base — never a ref that
/// isn't a commit id.
#[test]
fn the_cards_chat_is_told_the_pull_requests_range() {
    let mut card = pr_card(false);
    assert!(!chat_note_of(&card).unwrap().contains("git diff"));
    card.worktree_base = Some(crate::worktrees::WorktreeBase {
        commit: "abc123def4567890abc123def4567890abc123de".into(),
        ref_name: "origin/main".into(),
        source: crate::worktrees::BaseSource::Origin,
        note: None,
        origin_slug: None,
        origin_url: None,
        merged_target: None,
    });
    let note = chat_note_of(&card).unwrap();
    assert!(note.contains("`git diff abc123def4567890abc123def4567890abc123de...HEAD`"), "{note}");
    assert!(note.contains("where it leaves main"), "{note}");
    assert!(!chat_note(card.pr_review.as_ref().unwrap(), Some("main; rm -rf /")).contains("git diff"));
    assert_eq!(chat_note_of(&KanbanCard::new("c".into(), "ws".into(), "T".into(), None, KanbanColumnId::Todo)), None);
}

/// Walk of #386 (step 7): Resume on a pull request card whose Builder never
/// started is refused in words — no conversation to continue, and no way
/// past the setup the first Fix with the Builder runs. Once a session ran,
/// it resumes as any card's.
#[test]
fn a_builder_that_never_started_is_not_resumed() {
    let mut card = pr_card(true);
    assert_eq!(resume_refusal(&card).as_deref(), Some(NOT_STARTED_RESUME_REFUSAL));
    card.builder.as_mut().unwrap().started_at = 5;
    assert_eq!(resume_refusal(&card), None);
    let plain = KanbanCard::new("plain".into(), "ws".into(), "T".into(), None, KanbanColumnId::InProgress);
    assert_eq!(resume_refusal(&plain), None);
}

/// Walk of #386: "Overlapping edits" on a pull request card never lists
/// its own pull request, nor one a listed card already reviews.
#[test]
fn overlapping_edits_skip_the_cards_own_pull_request() {
    use crate::overlap::{OverlapKind, OverlapWarning};
    let me = pr_card(true);
    let mut other = pr_card(false);
    other.id = "card-y-pr27".into();
    other.pr_review.as_mut().unwrap().number = 27;
    let plain = KanbanCard::new("plain".into(), "ws".into(), "T".into(), None, KanbanColumnId::InProgress);
    let cards = vec![me.clone(), other.clone(), plain.clone()];
    let row = |id: &str| OverlapWarning {
        kind: OverlapKind::LocalCard,
        other_id: id.into(),
        other_title: "t".into(),
        files: vec!["sum.js".into()],
    };
    assert!(overlap_skips_pr(&me, &cards, &[], 12));
    assert!(!overlap_skips_pr(&me, &cards, &[], 27));
    assert!(overlap_skips_pr(&me, &cards, &[row("card-y-pr27")], 27));
    assert!(!overlap_skips_pr(&me, &cards, &[row("plain")], 27));
    // A card that reviews no pull request skips none of them.
    assert!(!overlap_skips_pr(&plain, &cards, &[], 12));
}

/// P3-4: a few reads a tick, the longest waiting first; a rate limit
/// pauses all.
#[test]
fn the_poller_reads_a_few_a_tick_and_a_rate_limit_pauses_all() {
    let cards: Vec<KanbanCard> = (0..5)
        .map(|i| {
            let mut c = pr_card(false);
            c.id = format!("c{i}");
            c.pr_review.as_mut().unwrap().checked_at = 0;
            c
        })
        .collect();
    let at = |i: i64| Some(Attempt { at: i, failures: 0 });
    let due = due_cards(cards.iter().enumerate().map(|(i, c)| (c, at(10 - i as i64))), POLL_MS * 10);
    assert_eq!(due.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["c4", "c3", "c2"]);
    assert!(pauses_all("HTTP 403: API rate limit exceeded for user"));
    assert!(pauses_all("gh: You have exceeded a secondary rate limit"));
    assert!(pauses_all("x-ratelimit-remaining: 0"));
    assert!(!pauses_all("HTTP 403: Resource not accessible by integration"), "a plain 403 pauses only its card");
    assert!(!pauses_all("HTTP 404: Not Found"));
}

#[test]
fn the_challenger_is_the_vendor_chosen() {
    for chosen in ["claude", "codex"] {
        let b = builder_state_for(chosen).unwrap();
        assert_eq!(crate::builder::challenger_for(&b.vendor), chosen);
        assert!(b.snapshots.is_empty() && b.pty_id.is_none() && b.review.is_none() && b.started_at == 0);
    }
    assert!(builder_state_for("gemini").is_err());
}

#[test]
fn new_card_ids_are_distinct_and_make_distinct_branches() {
    let a = new_card_id(1_760_000_000_000, 12);
    let b = new_card_id(1_760_000_000_001, 12);
    assert!(a.starts_with("card-") && a.ends_with("-pr12"), "{a}");
    assert_ne!(a, b);
    assert_ne!(crate::worktrees::make_branch_name(&a, "Review: x"), crate::worktrees::make_branch_name(&b, "Review: x"));
    assert!(crate::worktrees::is_card_branch(&crate::worktrees::make_branch_name(&a, "Review: x")));
}

#[test]
fn the_poller_reads_an_open_pull_request_every_few_minutes_and_backs_off() {
    let mut card = pr_card(false);
    card.pr_review.as_mut().unwrap().checked_at = 0;
    assert!(!poll_due(&card, None, 0, POLL_MS - 1));
    assert!(poll_due(&card, None, 0, POLL_MS));
    assert!(!poll_due(&card, Some(POLL_MS), 1, POLL_MS * 2), "a failure waits twice as long");
    assert!(poll_due(&card, Some(POLL_MS), 1, POLL_MS * 3));
    assert!(poll_due(&card, Some(0), 30, POLL_MAX_MS), "never longer than the cap");
    card.archived = true;
    assert!(!poll_due(&card, None, 0, i64::MAX / 2));
    let mut merged = pr_card(false);
    merged.pr_review.as_mut().unwrap().state = PrState::Merged;
    assert!(!poll_due(&merged, None, 0, i64::MAX / 2), "merged or closed: nothing to follow");
}

/// Schema migration: a board from before this release loads with no
/// `prReview`; a card with one round-trips; a record missing fields (a
/// later build's, read by this one) loads with defaults; a card without it
/// doesn't write it.
#[test]
fn the_persisted_field_is_backward_compatible() {
    let old = serde_json::json!({
        "id": "c1", "workspaceId": "ws", "title": "Old", "columnId": "in_progress",
        "createdAt": 1, "updatedAt": 1
    });
    let card: KanbanCard = serde_json::from_value(old).unwrap();
    assert!(card.pr_review.is_none());
    let written = serde_json::to_value(&card).unwrap();
    assert!(written.get("prReview").is_none(), "absent, not null");

    let with = pr_card(true);
    let json = serde_json::to_value(&with).unwrap();
    assert_eq!(json["prReview"]["number"], 12);
    assert_eq!(json["prReview"]["baseRef"], "main");
    assert_eq!(json["prReview"]["state"], "open");
    let back: KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(back.pr_review, with.pr_review);

    let partial = serde_json::json!({
        "id": "c2", "workspaceId": "ws", "title": "Review: x", "columnId": "in_progress",
        "createdAt": 1, "updatedAt": 1,
        "prReview": { "number": 4, "url": "u", "repo": REPO, "baseRef": "main", "headSha": HEAD }
    });
    let card: KanbanCard = serde_json::from_value(partial).unwrap();
    let r = card.pr_review.unwrap();
    assert_eq!((r.number, r.state, r.pushable, r.branch_head), (4, PrState::Open, false, None));
}

// ── git: the worktree on the pull request's head ────────────────────────

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args)
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
        .trim()
        .to_string()
}

fn identity(dir: &Path) {
    for (k, v) in [("user.email", "t@t"), ("user.name", "t"), ("commit.gpgsign", "false")] {
        git(dir, &["config", k, v]);
    }
}

fn commit(dir: &Path, file: &str, text: &str) -> String {
    fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", file]);
    git(dir, &["rev-parse", "HEAD"])
}

/// An origin with `main` and a pull request #12 kept as GitHub keeps one
/// (`refs/pull/12/head`, no branch of the clone's), and a clone of it.
struct Repos {
    _tmp: tempfile::TempDir,
    origin: PathBuf,
    author: PathBuf,
    clone: PathBuf,
}

fn repos() -> Repos {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let author = tmp.path().join("author");
    let clone = tmp.path().join("clone");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), author.to_str().unwrap()]);
    identity(&author);
    git(&author, &["checkout", "-q", "-b", "main"]);
    commit(&author, "a.txt", "a");
    git(&author, &["push", "-q", "origin", "main"]);
    git(&author, &["checkout", "-q", "-b", "retry-upload"]);
    let head = commit(&author, "b.txt", "b");
    git(&author, &["push", "-q", "origin", &format!("{head}:refs/pull/12/head")]);
    git(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), clone.to_str().unwrap()]);
    identity(&clone);
    Repos { _tmp: tmp, origin, author, clone }
}

#[test]
fn the_card_worktree_starts_at_the_fetched_pull_request_head() {
    let r = repos();
    let head = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    assert_eq!(head, git(&r.author, &["rev-parse", "HEAD"]));
    assert_eq!(git(&r.clone, &["rev-parse", "refs/ply/pr/12"]), head);
    // Nothing of origin's branches moved, and no branch was made for it.
    assert!(crate::git::capture(&r.clone, &["rev-parse", "--verify", "--quiet", "refs/heads/retry-upload"]).is_err());
    assert!(crate::worktrees::fetch_pull_head(&r.clone, 99).is_err(), "no such pull request");

    let id = "card-abc-pr12";
    let made = crate::worktrees::ensure_for_pr_card(&r.clone, id, "Review: Add the retry", &head).unwrap();
    assert!(made.created && crate::worktrees::is_card_branch(&made.branch_name));
    assert_eq!(crate::worktrees::head_sha(&made.worktree_path).unwrap(), head);
    assert!(crate::worktrees::ensure_for_pr_card(&r.clone, id, "Review: Add the retry", &head).is_err(), "never adopted");
    let base = recorded_base(&r.clone, "main", &head).unwrap();
    assert_eq!(base.commit, git(&r.clone, &["rev-parse", "origin/main"]));
    assert_eq!(base.ref_name, "origin/main");
}

#[test]
fn review_again_brings_the_branch_to_new_commits_and_never_drops_unpushed_fixes() {
    use crate::worktrees::{move_pr_card_branch, PrBranchMove};
    let r = repos();
    let first = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    let made = crate::worktrees::ensure_for_pr_card(&r.clone, "card-m-pr12", "Review: m", &first).unwrap();
    let wt = made.worktree_path;
    assert_eq!(move_pr_card_branch(&wt, &first, Some(&first)).unwrap(), PrBranchMove::Already);

    // The author pushes another commit: a fast-forward.
    let second = commit(&r.author, "c.txt", "c");
    git(&r.author, &["push", "-q", "-f", "origin", &format!("{second}:refs/pull/12/head")]);
    let fetched = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    assert_eq!(fetched, second);
    assert_eq!(move_pr_card_branch(&wt, &second, Some(&first)).unwrap(), PrBranchMove::FastForwarded);
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), second);

    // The author rewrites it (a force push): the card held nothing of its
    // own, so the branch follows.
    git(&r.author, &["reset", "-q", "--hard", &first]);
    let rewritten = commit(&r.author, "d.txt", "d");
    git(&r.author, &["push", "-q", "-f", "origin", &format!("{rewritten}:refs/pull/12/head")]);
    let fetched = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    assert_eq!(move_pr_card_branch(&wt, &fetched, Some(&second)).unwrap(), PrBranchMove::Reset);
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), rewritten);

    // Uncommitted edits: refused, nothing moved.
    fs::write(wt.join("e.txt"), "e").unwrap();
    assert!(move_pr_card_branch(&wt, &first, Some(&rewritten)).unwrap_err().contains("uncommitted"));
    fs::remove_file(wt.join("e.txt")).unwrap();

    // A Builder's fix not pushed yet, and the pull request rewritten again:
    // refused, the fix stays.
    identity(&wt);
    let fix = commit(&wt, "fix.txt", "fix");
    assert!(move_pr_card_branch(&wt, &first, Some(&rewritten)).unwrap_err().contains("not pushed"));
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), fix);
    let _ = &r.origin;
}

// ── the review's snapshot ───────────────────────────────────────────────

fn store_with(card: KanbanCard) -> (tempfile::TempDir, KanbanStore) {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    store.create_card("ws", card).unwrap();
    (tmp, store)
}

#[test]
fn each_head_of_the_pull_request_is_one_snapshot_reviewed_once() {
    use crate::builder::record_pr_head_review;
    use crate::review_passes::ReviewKind;
    let (_tmp, store) = store_with(pr_card(false));
    let id = "card-x-pr12";
    record_pr_head_review(&store, "ws", id, HEAD, ReviewKind::Sweep, 10).unwrap();
    let card = store.get_card("ws", id).unwrap();
    assert_eq!(card.pr_review.as_ref().unwrap().branch_head.as_deref(), Some(HEAD), "admitted: the branch is there");
    let b = card.builder.as_ref().unwrap();
    assert_eq!(b.snapshots.iter().map(|s| (s.n, s.sha.as_str())).collect::<Vec<_>>(), vec![(1, HEAD)]);
    let running = b.review.as_ref().unwrap();
    assert_eq!((running.snapshot_n, running.status.as_str(), running.provider.as_str()), (1, "running", "claude"));
    // The Challenger chosen stays the reviewer whatever vendor builds.
    store
        .with_card("ws", id, |c| {
            c.pr_review.as_mut().unwrap().challenger = Some("codex".into());
            c.builder.as_mut().unwrap().vendor = "codex".into();
            c.builder.as_mut().unwrap().review = Some(review(1, "failed", None));
            Ok(())
        })
        .unwrap();
    record_pr_head_review(&store, "ws", id, HEAD, ReviewKind::Sweep, 10).unwrap();
    assert_eq!(store.get_card("ws", id).unwrap().builder.unwrap().review.unwrap().provider, "codex");
    store
        .with_card("ws", id, |c| {
            c.pr_review.as_mut().unwrap().challenger = None;
            c.builder.as_mut().unwrap().vendor = "claude".into();
            Ok(())
        })
        .unwrap();

    // Asked again while it runs, or once it has a verdict: refused.
    assert!(record_pr_head_review(&store, "ws", id, HEAD, ReviewKind::Sweep, 11).is_err());
    store
        .with_card("ws", id, |c| {
            c.builder.as_mut().unwrap().review = Some(review(1, "done", Some("changes_requested")));
            c.review_status = Some(crate::kanban::ReviewStatus::ChangesRequested);
            Ok(())
        })
        .unwrap();
    let words = record_pr_head_review(&store, "ws", id, HEAD, ReviewKind::FollowUp, 12).unwrap_err();
    assert_eq!(words, crate::builder::PR_HEAD_REVIEWED);

    // New commits: snapshot 2, a follow-up, the old request superseded.
    record_pr_head_review(&store, "ws", id, NEXT, ReviewKind::FollowUp, 13).unwrap();
    let card = store.get_card("ws", id).unwrap();
    let b = card.builder.as_ref().unwrap();
    assert_eq!(b.snapshots.len(), 2);
    assert_eq!(b.review.as_ref().map(|r| (r.snapshot_n, r.kind)), Some((2, ReviewKind::FollowUp)));
    assert_eq!(card.review_status, None);
    assert_eq!(card.pr_review.as_ref().unwrap().heads, vec![1, 2], "both are the pull request's heads");

    // An incomplete review of a head runs again on the same snapshot.
    store
        .with_card("ws", id, |c| {
            c.builder.as_mut().unwrap().review = Some(review(2, "done", Some("incomplete")));
            Ok(())
        })
        .unwrap();
    record_pr_head_review(&store, "ws", id, NEXT, ReviewKind::FollowUp, 14).unwrap();
    assert_eq!(store.get_card("ws", id).unwrap().builder.unwrap().snapshots.len(), 2);

    // A card that reviews no pull request is not this path.
    let plain = KanbanCard::new("plain".into(), "ws".into(), "t".into(), None, KanbanColumnId::InProgress);
    store.create_card("ws", plain).unwrap();
    assert!(record_pr_head_review(&store, "ws", "plain", HEAD, ReviewKind::Sweep, 15).is_err());
}

/// P2-2: new commits on top of the head an unpushed fix is built on are
/// merged in; a rewrite or a conflict changes nothing.
#[test]
fn bring_in_the_new_commits_merges_them_under_an_unpushed_fix() {
    use crate::worktrees::{merge_pr_head_into_card, move_pr_card_branch};
    let r = repos();
    let first = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    let wt = crate::worktrees::ensure_for_pr_card(&r.clone, "card-g-pr12", "Review: g", &first).unwrap().worktree_path;
    identity(&wt);
    let fix = commit(&wt, "fix.txt", "fix");
    // Someone pushes on top of the reviewed head.
    let more = commit(&r.author, "more.txt", "more");
    git(&r.author, &["push", "-q", "-f", "origin", &format!("{more}:refs/pull/12/head")]);
    let head = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    // Review again says what to do instead of dropping the fix.
    assert_eq!(move_pr_card_branch(&wt, &head, Some(&first)).unwrap_err(), MERGE_FIRST);
    merge_pr_head_into_card(&wt, &head, Some(&first)).unwrap();
    let tip = crate::worktrees::head_sha(&wt).unwrap();
    assert!(crate::worktrees::is_ancestor(&wt, &fix, &tip) && crate::worktrees::is_ancestor(&wt, &head, &tip));
    assert_eq!(merge_pr_head_into_card(&wt, &head, Some(&head)), Ok(false), "already in the branch: nothing to merge");
    // A conflict: aborted, the branch as it was.
    fs::write(r.author.join("fix.txt"), "theirs").unwrap();
    git(&r.author, &["add", "-A"]);
    git(&r.author, &["commit", "-q", "-m", "conflict"]);
    let conflicting = git(&r.author, &["rev-parse", "HEAD"]);
    git(&r.author, &["push", "-q", "-f", "origin", &format!("{conflicting}:refs/pull/12/head")]);
    let head2 = crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap();
    assert!(merge_pr_head_into_card(&wt, &head2, Some(&head)).unwrap_err().contains("conflict"));
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), tip);
    assert!(!crate::worktrees::worktree_is_dirty(&wt).unwrap());
    // Round 3: a lock git left behind is named in the words.
    let lock = PathBuf::from(git(&wt, &["rev-parse", "--absolute-git-dir"])).join("index.lock");
    fs::write(&lock, "").unwrap();
    let words = merge_pr_head_into_card(&wt, &head2, Some(&head)).unwrap_err();
    assert!(words.contains("lock file") && words.contains("index.lock"), "{words}");
    fs::remove_file(&lock).unwrap();
    // A rewrite (the head the fix is built on is gone): refused.
    let rewritten = {
        git(&r.author, &["reset", "-q", "--hard", &first]);
        let sha = commit(&r.author, "other.txt", "other");
        git(&r.author, &["push", "-q", "-f", "origin", &format!("{sha}:refs/pull/12/head")]);
        crate::worktrees::fetch_pull_head(&r.clone, 12).unwrap()
    };
    assert!(merge_pr_head_into_card(&wt, &rewritten, Some(&head2)).unwrap_err().contains("rewritten"));
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), tip, "nothing changed");
}

/// P3-6: the whole flow on a mock app — create (as the workspace's
/// account, `gh` only read), a second review on Free while the first runs,
/// Review again on new commits, the poller seeing the merge and
/// cleaning up, the Builder refused on someone else's card, and Sync never
/// making an issue of a pull request card.
mod app_flow {
    use super::*;
    use crate::license::{LicenseStore, PlanCase};
    use crate::review_passes::ReviewKind;
    use crate::workspace::WorkspaceStore;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    struct World {
        repos: Repos,
        app: tauri::App<MockRuntime>,
        ws: String,
        config: PathBuf,
        _config_tmp: tempfile::TempDir,
    }

    fn world() -> World {
        let repos = repos();
        TEST_REPO.with(|r| *r.borrow_mut() = Some("o/r".into()));
        let config_tmp = tempfile::tempdir().unwrap();
        let config = config_tmp.path().to_path_buf();
        let workspaces = WorkspaceStore::new(config.clone()).unwrap();
        let ws = workspaces.create("Lyra".into(), repos.clone.to_string_lossy().into_owned()).unwrap().id;
        let app = mock_builder()
            .manage(workspaces)
            .manage(KanbanStore::new(config.clone()).unwrap())
            .manage(LicenseStore::for_plan_test(config.clone(), PlanCase::Free))
            .build(mock_context(noop_assets()))
            .expect("mock app");
        World { repos, app, ws, config, _config_tmp: config_tmp }
    }

    fn push_pull(w: &World, number: u64, file: &str) -> String {
        let sha = commit(&w.repos.author, file, file);
        git(&w.repos.author, &["push", "-q", "-f", "origin", &format!("{sha}:refs/pull/{number}/head")]);
        sha
    }

    fn view(number: u64, state: &str, author: &str, head: &str) -> String {
        view_json(state, author, false, head).replace("\"number\":12", &format!("\"number\":{number}"))
    }

    fn settle(w: &World, card_id: &str, verdict: &str) {
        let kanban = w.app.state::<KanbanStore>();
        kanban
            .with_card(&w.ws, card_id, |c| {
                let b = c.builder.as_mut().unwrap();
                let n = b.snapshots.last().unwrap().n;
                b.review = Some(review(n, "done", Some(verdict)));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn create_review_again_the_merge_and_no_github_write() {
        let _serial = crate::github::test_serial_lock();
        let w = world();
        let app = w.app.handle();
        let kanban = app.state::<KanbanStore>();
        let head12 = git(&w.repos.author, &["rev-parse", "HEAD"]);
        let start_review = |id: &str, head: &str| {
            crate::builder::record_pr_head_review(&kanban, &w.ws, id, head, ReviewKind::Sweep, 1).map(|_| ())
        };

        // Create: the member's own pull request #12.
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Ok(view(12, "OPEN", "octo", &head12)),
            Ok("octo".into()),
            Ok("true\ntrue".into()),
        ]);
        let made = create(app, &w.ws, "https://github.com/o/r/pull/12", "codex", start_review).unwrap();
        assert!(!made.existing && made.review_error.is_none(), "{:?}", made.review_error);
        let card12 = made.card.clone();
        let pr = card12.pr_review.as_ref().unwrap();
        assert!(pr.pushable && pr.challenger.as_deref() == Some("codex"));
        assert_eq!(pr.branch_head.as_deref(), Some(head12.as_str()));
        assert_eq!(crate::worktrees::head_sha(Path::new(card12.worktree_path.as_deref().unwrap())).unwrap(), head12);
        assert_eq!(card12.builder.as_ref().unwrap().review.as_ref().unwrap().status, "running");
        assert_eq!(card12.gh_issue_number, None);
        // The same link again: that card, nothing made.
        assert!(create(app, &w.ws, "12", "codex", |_, _| panic!("no review")).unwrap().existing);

        // Free: #13 (a colleague's) starts while #12 is still reviewed —
        // any number of cards work at once, on every plan.
        let head13 = push_pull(&w, 13, "thirteen.txt");
        crate::github::set_test_gh_responses(vec![Ok(view(13, "OPEN", "colleague", &head13)), Ok("true\ntrue".into())]);
        let card13 = create(app, &w.ws, "13", "claude", start_review).unwrap().card;
        settle(&w, &card12.id, "changes_requested");
        assert!(!card13.pr_review.as_ref().unwrap().pushable);

        // Someone else's: no Builder, by any start.
        let refusal = crate::commands::advance_card_to_in_progress::<MockRuntime>(
            None,
            &kanban,
            &app.state::<WorkspaceStore>(),
            &crate::project_config::ProjectConfigStore::new(w.config.clone()).unwrap(),
            &app.state::<LicenseStore>(),
            &w.ws,
            &card13.id,
            Some("main".into()),
        )
        .unwrap_err();
        assert!(refusal.contains("colleague's pull request"), "{refusal}");

        // New commits on #12: Review again reviews the new head as snapshot
        // 2, while #13's review still runs.
        let next12 = push_pull(&w, 12, "twelve-b.txt");
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next12))]);
        let again = start(app, &w.ws, &card12.id, false, |h| start_review(&card12.id, h)).unwrap();
        let b = again.builder.as_ref().unwrap();
        assert_eq!(b.snapshots.iter().map(|s| s.sha.as_str()).collect::<Vec<_>>(), vec![head12.as_str(), next12.as_str()]);
        assert_eq!(again.pr_review.as_ref().unwrap().heads, vec![1, 2]);
        assert_eq!(b.review.as_ref().unwrap().provider, "codex", "the Reviewer chosen");

        // The poller sees #12 merged: its worktree goes to the trash and
        // Plyloft's ref goes.
        settle(&w, &card12.id, "approve");
        kanban
            .with_card_unstamped(&w.ws, &card12.id, |c| {
                c.pr_review.as_mut().unwrap().checked_at = 0;
                Ok(())
            })
            .unwrap();
        crate::github::set_test_gh_responses(vec![Ok(view(12, "MERGED", "octo", &next12))]);
        poll_once(app);
        let merged = kanban.get_card(&w.ws, &card12.id).unwrap();
        assert_eq!(merged.pr_review.as_ref().unwrap().state, PrState::Merged);
        assert_eq!(merged.worktree_path, None, "the worktree went to the trash");
        assert!(crate::git::capture(&w.repos.clone, &["rev-parse", "--verify", "--quiet", "refs/ply/pr/12"]).is_err());
        assert!(merged.branch_cleanup.is_some(), "the branch waits for N18's sweep");

        // Sync never makes an issue of a pull request card.
        crate::github::set_test_gh_responses(vec![]);
        let pushed = crate::github_sync::push_local(&kanban, &w.ws, "o/r", &Default::default());
        let _ = pushed;

        // Every gh call was a read.
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();
        assert!(!calls.is_empty());
        for args in &calls {
            let pr_read = matches!(args.first().map(String::as_str), Some("pr"))
                && matches!(args.get(1).map(String::as_str), Some("view" | "list"));
            let api_read = matches!(args.first().map(String::as_str), Some("api"))
                && !args.iter().any(|a| a == "-X" || a == "--method" || a == "-f" || a == "-F");
            let repo_read = matches!(args.first().map(String::as_str), Some("repo"))
                && matches!(args.get(1).map(String::as_str), Some("view"));
            let ok = pr_read || api_read || repo_read;
            assert!(ok, "a gh call that isn't a read: {args:?}");
        }
    }

    /// Round 2 (P2-A): after Bring in the new commits the card is not stuck
    /// — merged, not built yet, until Build done snapshots the merge; then
    /// its fix is built on the new head and can be pushed.
    #[test]
    fn after_bring_in_the_new_commits_the_merge_is_built_then_pushable() {
        let _serial = crate::github::test_serial_lock();
        let w = world();
        let app = w.app.handle();
        let kanban = app.state::<KanbanStore>();
        let head12 = git(&w.repos.author, &["rev-parse", "HEAD"]);
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Ok(view(12, "OPEN", "octo", &head12)),
            Ok("octo".into()),
            Ok("true\ntrue".into()),
        ]);
        let card = create(app, &w.ws, "12", "codex", |id, head| {
            crate::builder::record_pr_head_review(&kanban, &w.ws, id, head, ReviewKind::Sweep, 1).map(|_| ())
        })
        .unwrap()
        .card;
        settle(&w, &card.id, "changes_requested");
        // The Builder's fix (snapshot 2), not pushed.
        let wt = PathBuf::from(card.worktree_path.clone().unwrap());
        identity(&wt);
        commit(&wt, "fix.txt", "fix");
        crate::builder::record_build_done(&kanban, &w.ws, &card.id, true, None, ReviewKind::FollowUp, None, false).unwrap();
        let fixed = kanban.get_card(&w.ws, &card.id).unwrap();
        assert!(unpushed_fix(&fixed) && !merge_offered(&fixed));
        // Someone pushes on top: Review again sends to Bring in the new commits.
        let next = push_pull(&w, 12, "more.txt");
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next))]);
        assert_eq!(start(app, &w.ws, &card.id, false, |_| panic!("no review")).unwrap_err(), MERGE_FIRST);
        assert!(merge_offered(&kanban.get_card(&w.ws, &card.id).unwrap()));
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next))]);
        // Round 3: a session opened meanwhile is seen under the card's lock.
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next))]);
        assert!(merge_new_commits(app, &w.ws, &card.id, || true).unwrap_err().contains("Close the Builder session"));
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next))]);
        let merged = merge_new_commits(app, &w.ws, &card.id, || false).unwrap();
        assert!(merged_not_built(&merged) && !unpushed_fix(&merged) && !merge_offered(&merged));
        assert_eq!(merged.pr_review.as_ref().unwrap().branch_head.as_deref(), Some(next.as_str()));
        assert_eq!(inbox_ask(&merged).map(|a| a.1), Some("Pull request #12 · merged, not built yet".to_string()));
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next))]);
        assert_eq!(start(app, &w.ws, &card.id, false, |_| panic!("no review")).unwrap_err(), MERGED_NOT_BUILT);
        // Build done (as `pr_review_merge_head` runs it) snapshots the merge.
        crate::builder::record_build_done(&kanban, &w.ws, &card.id, true, None, ReviewKind::FollowUp, None, false).unwrap();
        let built = kanban.get_card(&w.ws, &card.id).unwrap();
        assert!(!merged_not_built(&built) && unpushed_fix(&built) && !merge_offered(&built));
        // Walk 3 of #386 (finding 5): the merge is recorded for Activity, and
        // the head it brought in is not "new commits" to review again.
        let merges = &built.pr_review.as_ref().unwrap().merges;
        assert_eq!((merges.len(), merges[0].head.as_str()), (1, next.as_str()));
        assert!(fix_on_head(&built));
        assert_ne!(review_offer(&built), Some(ReviewOffer::NewCommits));
        let tip = crate::worktrees::head_sha(&wt).unwrap();
        assert!(crate::worktrees::is_ancestor(&wt, &next, &tip), "the fix is built on the new head");
        // Bring in again with the head already in: nothing merged, still fine.
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &next))]);
        let again = merge_new_commits(app, &w.ws, &card.id, || false).unwrap();
        assert!(!again.pr_review.as_ref().unwrap().merged && unpushed_fix(&again));
        // Round 3: pushing records the pushed snapshot as the mark; a later
        // fix is a new one.
        let pushed = again.builder.as_ref().unwrap().snapshots.last().unwrap().clone();
        record_pushed(&kanban, &w.ws, &card.id, &pushed.sha).unwrap();
        let after = kanban.get_card(&w.ws, &card.id).unwrap();
        assert_eq!(after.pr_review.as_ref().unwrap().head_mark, pushed.n);
        assert!(!unpushed_fix(&after) && !merge_offered(&after));
        crate::github::clear_test_gh_responses();
        let _ = crate::github::take_test_gh_invocations();
    }

    /// Walk 3 of #386 (finding 6): a Bring in the new commits that
    /// conflicted is kept on the card — pressing it again would conflict
    /// again — until the pull request's head or the card's fix changes.
    #[test]
    fn a_conflicting_bring_in_is_kept_until_the_head_or_the_fix_changes() {
        let _serial = crate::github::test_serial_lock();
        let w = world();
        let app = w.app.handle();
        let kanban = app.state::<KanbanStore>();
        let head12 = git(&w.repos.author, &["rev-parse", "HEAD"]);
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Ok(view(12, "OPEN", "octo", &head12)),
            Ok("octo".into()),
            Ok("true\ntrue".into()),
        ]);
        let card = create(app, &w.ws, "12", "codex", |id, head| {
            crate::builder::record_pr_head_review(&kanban, &w.ws, id, head, ReviewKind::Sweep, 1).map(|_| ())
        })
        .unwrap()
        .card;
        settle(&w, &card.id, "changes_requested");
        let wt = PathBuf::from(card.worktree_path.clone().unwrap());
        identity(&wt);
        commit(&wt, "fix.txt", "ours");
        crate::builder::record_build_done(&kanban, &w.ws, &card.id, true, None, ReviewKind::FollowUp, None, false).unwrap();
        // Someone adds the same file on GitHub, differently.
        let theirs = push_pull(&w, 12, "fix.txt");
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &theirs))]);
        let words = merge_new_commits(app, &w.ws, &card.id, || false).unwrap_err();
        assert!(crate::worktrees::is_pr_merge_conflict(&words), "{words}");
        let conflicted = kanban.get_card(&w.ws, &card.id).unwrap();
        assert!(merge_conflicts_again(&conflicted) && merge_offered(&conflicted));
        // Walk 4 of #386: the head read is in the Activity, not merged yet.
        let merges = &conflicted.pr_review.as_ref().unwrap().merges;
        assert_eq!((merges.len(), merges[0].head.as_str(), merges[0].snapshot), (1, theirs.as_str(), None));
        // The Builder resolves it and Build done snapshots a new fix.
        git(&wt, &["merge", "-q", "-X", "ours", "-m", "resolved", &theirs]);
        crate::builder::record_build_done(&kanban, &w.ws, &card.id, true, None, ReviewKind::FollowUp, None, false).unwrap();
        let built = kanban.get_card(&w.ws, &card.id).unwrap();
        assert!(!merge_conflicts_again(&built), "the fix changed");
        // Walk 4 of #386 (finding 1): the Builder's merge contains the pull
        // request's head, so the fix is built on it — no "New commits under
        // your fix", nothing to bring in, and once its review settles it is
        // ready to push.
        let pr = built.pr_review.as_ref().unwrap();
        let last = built.builder.as_ref().unwrap().snapshots.last().unwrap().clone();
        assert_eq!(pr.branch_head.as_deref(), Some(theirs.as_str()));
        assert!(pr.merge_conflict.is_none());
        assert!(fix_on_head(&built) && unpushed_fix(&built) && !merge_offered(&built) && !merged_not_built(&built));
        assert_ne!(review_offer(&built), Some(ReviewOffer::NewCommits));
        assert_eq!(pr.merges.len(), 1);
        assert_eq!(pr.merges[0].snapshot, Some(last.n), "the snapshot is the merge, for the Activity");
        settle(&w, &card.id, "approve");
        let approved = kanban.get_card(&w.ws, &card.id).unwrap();
        assert_eq!(inbox_ask(&approved).map(|a| a.1), Some("Pull request #12 · fix ready to push".to_string()));
        // A card Build done left before this change (the head not taken in)
        // is put right by its next read: Check GitHub.
        kanban
            .with_card_unstamped(&w.ws, &card.id, |c| {
                let p = c.pr_review.as_mut().unwrap();
                p.branch_head = Some(head12.clone());
                p.head_mark = 1;
                p.merges.clear();
                p.merge_conflict = Some(PrConflict { head: theirs.clone(), fix: "old".into() });
                Ok(())
            })
            .unwrap();
        assert!(merge_offered(&kanban.get_card(&w.ws, &card.id).unwrap()), "stuck as walk 4 found it");
        crate::github::set_test_gh_responses(vec![Ok(view(12, "OPEN", "octo", &theirs))]);
        let read = refresh_card(app, &w.ws, &card.id).unwrap();
        let pr = read.pr_review.as_ref().unwrap();
        assert_eq!(pr.branch_head.as_deref(), Some(theirs.as_str()));
        assert!(pr.merge_conflict.is_none() && fix_on_head(&read) && !merge_offered(&read));
        assert_eq!(pr.merges.iter().map(|m| m.snapshot).collect::<Vec<_>>(), vec![Some(last.n)]);
        assert_eq!(inbox_ask(&read).map(|a| a.1), Some("Pull request #12 · fix ready to push".to_string()));
        crate::github::clear_test_gh_responses();
        let _ = crate::github::take_test_gh_invocations();
    }

    /// Walk 4 of #386 (finding 2): Resume the Builder of a pull request card
    /// passes while another card is at work — its fix pushed or not.
    #[test]
    fn resume_passes_while_another_card_is_at_work() {
        let w = world();
        let app = w.app.handle();
        let kanban = app.state::<KanbanStore>();
        let mut pr = pr_card(true);
        pr.workspace_id = w.ws.clone();
        pr.worktree_path = None;
        let b = pr.builder.as_mut().unwrap();
        b.started_at = 5;
        b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
        pr.pr_review.as_mut().unwrap().heads = vec![1];
        pr.pr_review.as_mut().unwrap().branch_head = Some(HEAD.into());
        pr.pr_review.as_mut().unwrap().head_mark = 1;
        kanban.create_card(&w.ws, pr.clone()).unwrap();
        let other = KanbanCard::new("card-other".into(), w.ws.clone(), "Add a farewell function".into(), None, KanbanColumnId::InProgress);
        kanban.create_card(&w.ws, other).unwrap();
        let admit = || crate::commands::resume_admission(&kanban, &w.ws, &pr.id);
        // Its fix is pushed, the other card is in progress: it resumes.
        admit().unwrap();
        // A fix not pushed: it resumes too.
        kanban
            .with_card_unstamped(&w.ws, &pr.id, |c| {
                c.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 });
                Ok(())
            })
            .unwrap();
        admit().unwrap();
    }
}

// ── Walk 2 of #386 ──────────────────────────────────────────────────────

/// Finding 2: right after Push the fixes, GitHub can still answer with the
/// head the push replaced; the card keeps the pushed head (no "New commits
/// under your fix"), until GitHub catches up or the settle window passes.
#[test]
fn a_read_right_after_the_push_that_still_has_the_old_head_is_not_new_commits() {
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots = vec![BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 }, BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 }];
    b.review = Some(review(2, "done", Some("approve")));
    {
        let p = card.pr_review.as_mut().unwrap();
        p.heads = vec![1];
        p.branch_head = Some(HEAD.into());
        p.head_mark = 1;
    }
    assert!(crate::pr_review::fix_review_settled(&card) && unpushed_fix(&card));
    apply_pushed(&mut card, NEXT, 1_000).unwrap();
    let p = card.pr_review.as_ref().unwrap();
    assert_eq!(p.pushes, vec![PrPush { sha: NEXT.into(), over: HEAD.into(), at: 1_000 }]);
    assert_eq!((p.head_sha.as_str(), p.branch_head.as_deref(), p.head_mark), (NEXT, Some(NEXT), 2));
    // GitHub not caught up: the old head again.
    let lagging = parse_pr_view(&view_json("OPEN", "octo", false, HEAD)).unwrap();
    apply_facts(card.pr_review.as_mut().unwrap(), &lagging, 2_000);
    assert_eq!(card.pr_review.as_ref().unwrap().head_sha, NEXT);
    assert!(!merge_offered(&card) && !unpushed_fix(&card), "delivered, not new commits under it");
    assert_eq!(review_offer(&card), Some(ReviewOffer::Current));
    assert_eq!(inbox_ask(&card), None, "approved and pushed: nothing asked");
    // Caught up: the same.
    let caught = parse_pr_view(&view_json("OPEN", "octo", false, NEXT)).unwrap();
    apply_facts(card.pr_review.as_mut().unwrap(), &caught, 3_000);
    assert_eq!(card.pr_review.as_ref().unwrap().head_sha, NEXT);
    // A real new head is new commits, at once.
    let mut moved_card = card.clone();
    let other = parse_pr_view(&view_json("OPEN", "octo", false, "5555555555555555555555555555555555555555")).unwrap();
    apply_facts(moved_card.pr_review.as_mut().unwrap(), &other, 4_000);
    assert_eq!(review_offer(&moved_card), Some(ReviewOffer::NewCommits));
    // Past the settle window an old head is taken as GitHub says it.
    apply_facts(card.pr_review.as_mut().unwrap(), &lagging, 1_000 + PUSH_SETTLE_MS + 1);
    assert_eq!(card.pr_review.as_ref().unwrap().head_sha, HEAD);
}

/// Finding 7: the merge or close is recorded for the Activity; reopened, cleared.
#[test]
fn the_close_is_recorded_when_plyloft_reads_it() {
    let mut r = new_review(&facts(), REPO, HEAD, true, None, 1);
    let closed = parse_pr_view(&view_json("CLOSED", "octo", false, HEAD)).unwrap();
    apply_facts(&mut r, &closed, 7);
    assert_eq!((r.state, r.closed_at), (PrState::Closed, 7));
    apply_facts(&mut r, &closed, 9);
    assert_eq!(r.closed_at, 7, "the first read of it");
    apply_facts(&mut r, &facts(), 11);
    assert_eq!(r.closed_at, 0, "reopened");
}

/// Finding 5: "fix ready to push" waits for the fix's review.
#[test]
fn the_inbox_says_fix_ready_only_once_its_review_settled() {
    let mut mine = pr_card(true);
    let b = mine.builder.as_mut().unwrap();
    b.snapshots = vec![BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 }, BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 }];
    b.review = Some(review(2, "running", None));
    mine.pr_review.as_mut().unwrap().heads = vec![1];
    mine.pr_review.as_mut().unwrap().branch_head = Some(HEAD.into());
    assert!(!fix_review_settled(&mine));
    assert_eq!(inbox_ask(&mine), None, "reviewing: nothing asked yet");
    mine.builder.as_mut().unwrap().review = Some(review(2, "done", Some("changes_requested")));
    assert!(!fix_review_settled(&mine));
    assert_eq!(inbox_ask(&mine).map(|a| a.1), Some("Pull request #12 · changes requested".to_string()));
    mine.builder.as_mut().unwrap().review = Some(review(2, "done", Some("approve")));
    assert!(fix_review_settled(&mine));
    assert_eq!(inbox_ask(&mine).map(|a| a.1), Some("Pull request #12 · fix ready to push".to_string()));
}

/// Finding 3: the first Fix with the Builder carries the Challenger's
/// request for changes in its first prompt, and isn't owed it again; the
/// brief says Push the fixes, never Ship.
#[test]
fn the_first_builder_brief_carries_the_findings_and_says_push_the_fixes() {
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    let mut r = review(1, "done", Some("changes_requested"));
    r.provider = "codex".into();
    r.builder_handoff = Some("New findings:\n\n- F1\n  average() divides by zero on an empty list.".into());
    r.at = 5;
    b.review = Some(r);
    let lead = builder_lead(&card).unwrap();
    assert!(lead.contains("Send the fixes to GitHub") && lead.contains("never push"), "{lead}");
    assert!(lead.contains("The Reviewer (Codex) reviewed snapshot 1"), "{lead}");
    assert!(lead.contains("F1\n  average() divides by zero"), "{lead}");
    assert!(session_findings(&card).is_some());
    let preamble = crate::builder::builder_preamble_for(&card.title, true);
    assert!(preamble.contains("Send the fixes to GitHub") && !preamble.contains("presses Ship"), "{preamble}");
    assert!(crate::builder::builder_preamble("x").contains("presses Ship"), "a normal card's is unchanged");
    // Without a handoff, the findings themselves.
    let mut listed = card.clone();
    let lr = listed.builder.as_mut().unwrap().review.as_mut().unwrap();
    lr.builder_handoff = None;
    lr.findings = vec![crate::review_passes::ReviewFinding {
        severity: Some("P2".into()),
        title: "Empty list".into(),
        body: "Divides by zero.".into(),
        location: Some("sum.js:3".into()),
        id: Some("F1".into()),
        ..Default::default()
    }];
    let words = session_findings(&listed).unwrap();
    assert!(words.contains("- F1 [P2] Empty list (sum.js:3)\n  Divides by zero."), "{words}");
    // Walk 3 of #386 (finding 1): a later session (Fix with the Builder
    // again) is told the open request too.
    card.builder.as_mut().unwrap().started_at = 9;
    assert!(session_findings(&card).is_some());
    assert!(builder_lead(&card).unwrap().contains("requests these changes"));
    // Approved: nothing to send; the human says what to fix.
    let mut approved = pr_card(true);
    approved.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    approved.builder.as_mut().unwrap().review = Some(review(1, "done", Some("approve")));
    assert_eq!(session_findings(&approved), None);
    assert!(builder_lead(&approved).unwrap().contains("asks for no changes"));
    assert!(builder_lead(&approved).unwrap().contains(WAIT_FOR_THE_HUMAN));
    // Walk 3 of #386 (finding 1): and on a later session, which used to be
    // told only "You fix it" and invented a change.
    approved.builder.as_mut().unwrap().started_at = 9;
    let later = builder_lead(&approved).unwrap();
    assert!(later.contains("the human says here what to fix") && later.contains("change nothing and commit nothing"), "{later}");
    // Challenger round 3: a review still running (or failed) hasn't said
    // anything yet — the brief doesn't claim it asked for no changes.
    let mut running = approved.clone();
    running.builder.as_mut().unwrap().review = Some(review(1, "running", None));
    let lead = builder_lead(&running).unwrap();
    assert!(!lead.contains("asks for no changes") && lead.contains("No request for changes"), "{lead}");
    running.builder.as_mut().unwrap().review = Some(review(1, "failed", None));
    assert!(!builder_lead(&running).unwrap().contains("asks for no changes"));
}

/// Challenger round 3: a Push the fixes that timed out after GitHub took
/// it records no push; the next read finds the card's own fix as the head.
/// The card takes it as pushed (on that head, a later fix built on it),
/// not as new commits under the fix to bring in.
#[test]
fn a_fix_that_reached_github_without_a_recorded_push_is_taken_as_pushed() {
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots = vec![BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 }, BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 }];
    b.review = Some(review(2, "done", Some("approve")));
    {
        let p = card.pr_review.as_mut().unwrap();
        p.heads = vec![1];
        p.branch_head = Some(HEAD.into());
        p.head_mark = 1;
    }
    let landed = parse_pr_view(&view_json("OPEN", "octo", false, NEXT)).unwrap();
    apply_facts(card.pr_review.as_mut().unwrap(), &landed, 5_000);
    assert!(adopt_landed_fix(&mut card, 5_000));
    let p = card.pr_review.as_ref().unwrap();
    assert_eq!((p.branch_head.as_deref(), p.head_mark), (Some(NEXT), 2));
    assert_eq!(p.pushes, vec![PrPush { sha: NEXT.into(), over: HEAD.into(), at: 5_000 }]);
    assert!(!merge_offered(&card) && !unpushed_fix(&card));
    assert!(!adopt_landed_fix(&mut card, 6_000), "once");
    // A later fix is built on it and pushable.
    let later = "6666666666666666666666666666666666666666";
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 3, sha: later.into(), at: 3 });
    assert!(unpushed_fix(&card) && !merge_offered(&card));
    // Someone else's head is not adopted: it is new commits.
    let mut other = pr_card(true);
    other.builder.as_mut().unwrap().snapshots = vec![BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 }];
    other.pr_review.as_mut().unwrap().heads = vec![1];
    other.pr_review.as_mut().unwrap().branch_head = Some(HEAD.into());
    let moved = parse_pr_view(&view_json("OPEN", "octo", false, NEXT)).unwrap();
    apply_facts(other.pr_review.as_mut().unwrap(), &moved, 1);
    assert!(!adopt_landed_fix(&mut other, 1));
    assert_eq!(review_offer(&other), Some(ReviewOffer::NewCommits));
}

/// Schema migration for the walk's fields: absent on an older card, round
/// trip, not written when empty.
#[test]
fn the_pushes_and_the_close_are_backward_compatible() {
    let old = serde_json::json!({ "number": 4, "url": "u", "repo": REPO, "baseRef": "main", "headSha": HEAD });
    let r: PrReview = serde_json::from_value(old).unwrap();
    assert!(r.pushes.is_empty() && r.closed_at == 0);
    let json = serde_json::to_value(&r).unwrap();
    assert!(json.get("pushes").is_none() && json.get("closedAt").is_none());
    let mut with = r.clone();
    with.pushes.push(PrPush { sha: NEXT.into(), over: HEAD.into(), at: 3 });
    with.closed_at = 4;
    let json = serde_json::to_value(&with).unwrap();
    assert_eq!(json["pushes"][0]["over"], HEAD);
    assert_eq!(json["closedAt"], 4);
    assert_eq!(serde_json::from_value::<PrReview>(json).unwrap(), with);
}

// ── Walk 3 of #386 ──────────────────────────────────────────────────────

/// Finding 7 (owner decision): a pull request whose head is the target,
/// the default or the base branch is review-only from the start, in words
/// that say why; its chat is told so.
#[test]
fn a_pull_request_from_a_protected_branch_is_review_only() {
    let mut card = pr_card(true);
    let pr = card.pr_review.as_mut().unwrap();
    assert!(!apply_protected_head(pr, &["main".into(), "trunk".into()]));
    assert!(pr.pushable, "retry-upload is the pull request's own branch");
    pr.head_ref = "trunk".into();
    pr.base_ref = "walk-base-11".into();
    assert!(apply_protected_head(pr, &["main".into(), "trunk".into()]));
    assert!(!pr.pushable);
    assert_eq!(pr.fix_note.as_deref(), Some("This pull request's branch is trunk: Plyloft reviews it but can't push fixes to it."));
    assert!(!apply_protected_head(pr, &["trunk".into()]), "once");
    assert!(builder_refusal(&card).unwrap().contains("can't push fixes to it"));
    let note = chat_note_of(&card).unwrap();
    assert!(note.contains("can't push fixes to it") && !note.contains("someone else's"), "{note}");
    // The base counts even when not listed.
    let mut base = pr_card(true);
    let p = base.pr_review.as_mut().unwrap();
    p.base_ref = "retry-upload".into();
    assert!(apply_protected_head(p, &[]));
    assert_eq!(protected_head_note("feature", &["main".into(), String::new()]), None);
}

/// Finding 9: each Builder session's start is kept for Activity (at most
/// [`FIX_STARTS_KEPT`]); finding 6: a conflict is "again" only while the
/// head and the fix are the ones it met.
#[test]
fn fix_starts_are_kept_and_a_conflict_holds_only_for_its_head_and_fix() {
    let mut card = pr_card(true);
    for at in 1..=(FIX_STARTS_KEPT as i64 + 3) {
        record_fix_start(card.pr_review.as_mut().unwrap(), at);
    }
    let starts = &card.pr_review.as_ref().unwrap().fix_starts;
    assert_eq!((starts.len(), starts[0], *starts.last().unwrap()), (FIX_STARTS_KEPT, 4, FIX_STARTS_KEPT as i64 + 3));
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 2, sha: "f1".into(), at: 2 });
    card.pr_review.as_mut().unwrap().head_sha = NEXT.into();
    card.pr_review.as_mut().unwrap().merge_conflict = Some(PrConflict { head: NEXT.into(), fix: "f1".into() });
    assert!(merge_conflicts_again(&card));
    card.pr_review.as_mut().unwrap().head_sha = "33".into();
    assert!(!merge_conflicts_again(&card), "the head changed");
    card.pr_review.as_mut().unwrap().head_sha = NEXT.into();
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 3, sha: "f2".into(), at: 3 });
    assert!(!merge_conflicts_again(&card), "the fix changed");
}

/// The fields walk 3 adds: an old record reads without them, they aren't
/// written while empty, and they round-trip.
#[test]
fn the_fix_starts_merges_and_conflict_are_backward_compatible() {
    let old = serde_json::json!({ "number": 4, "url": "u", "repo": REPO, "baseRef": "main", "headSha": HEAD, "pushes": [] });
    let r: PrReview = serde_json::from_value(old).unwrap();
    assert!(r.fix_starts.is_empty() && r.merges.is_empty() && r.merge_conflict.is_none());
    let json = serde_json::to_value(&r).unwrap();
    assert!(json.get("fixStarts").is_none() && json.get("merges").is_none() && json.get("mergeConflict").is_none());
    let mut with = r.clone();
    with.fix_starts = vec![1, 2];
    record_merge(&mut with, NEXT, 5);
    with.merge_conflict = Some(PrConflict { head: NEXT.into(), fix: HEAD.into() });
    let json = serde_json::to_value(&with).unwrap();
    assert_eq!(json["fixStarts"][1], 2);
    assert_eq!(json["merges"][0]["head"], NEXT);
    assert_eq!(json["mergeConflict"]["fix"], HEAD);
    assert_eq!(serde_json::from_value::<PrReview>(json).unwrap(), with);
}

/// Challenger on walk 3 of #386: a card that turns review-only (a protected
/// head found later, a fork) while its fix isn't pushed says the fix is kept
/// on its branch, once — it can never be pushed.
#[test]
fn a_card_turned_review_only_keeps_its_fix_and_says_so() {
    let mut card = pr_card(true);
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 2, sha: NEXT.into(), at: 2 });
    assert!(unpushed_fix(&card), "a fix not pushed yet");
    note_kept_fix(&mut card);
    assert_eq!(card.pr_review.as_ref().unwrap().fix_note, None, "pushable: nothing said");
    let pr = card.pr_review.as_mut().unwrap();
    pr.head_ref = "main".into();
    assert!(apply_protected_head(pr, &["main".into()]));
    note_kept_fix(&mut card);
    note_kept_fix(&mut card);
    let note = card.pr_review.as_ref().unwrap().fix_note.clone().unwrap();
    assert!(note.starts_with(PROTECTED_HEAD_LEAD), "{note}");
    assert_eq!(note.matches(KEPT_FIX_LEAD).count(), 1, "{note}");
    assert!(note.contains("plyloft/card-xpr12-review-add-the-retry"), "{note}");
    assert!(!card.pr_review.as_ref().unwrap().pushable, "a fix that can't be pushed");
    // No fix: nothing to say.
    let mut bare = pr_card(true);
    bare.pr_review.as_mut().unwrap().pushable = false;
    note_kept_fix(&mut bare);
    assert_eq!(bare.pr_review.as_ref().unwrap().fix_note, None);
}

// ── Walk 4 of #386 ──────────────────────────────────────────────────────

/// Finding 1: a fix snapshot that contains the pull request's head (the
/// Builder merged it) is on that head — marked just before the fix, the
/// conflict gone, the snapshot recorded as the merge; one that doesn't
/// contain it, or a head snapshot, changes nothing.
#[test]
fn a_fix_that_contains_the_head_is_on_it() {
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    b.snapshots.push(BuildSnapshot { n: 2, sha: "fix".into(), at: 2 });
    let pr = card.pr_review.as_mut().unwrap();
    pr.heads = vec![1];
    pr.branch_head = Some(HEAD.into());
    pr.head_mark = 1;
    // New commits on GitHub, read under the fix.
    pr.head_sha = NEXT.into();
    pr.merge_conflict = Some(PrConflict { head: NEXT.into(), fix: "fix".into() });
    assert!(merge_offered(&card));
    assert!(note_head_read(&mut card, 3));
    assert!(!note_head_read(&mut card, 4), "once per head");
    assert_eq!(card.pr_review.as_ref().unwrap().merges, vec![PrMerge { head: NEXT.into(), at: 3, snapshot: None }]);
    // The Builder's merge, snapshot 3, contains NEXT; snapshot 2 doesn't.
    card.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 3, sha: "merge".into(), at: 5 });
    let contains = |a: &str, b: &str| a == NEXT && b == "merge";
    assert!(!adopt_head_in_fix(&mut card.clone(), &|_: &str, _: &str| false, 6), "not contained: nothing");
    assert!(adopt_head_in_fix(&mut card, &contains, 6));
    let pr = card.pr_review.as_ref().unwrap();
    assert_eq!((pr.branch_head.as_deref(), pr.head_mark, pr.merge_conflict.as_ref()), (Some(NEXT), 2, None));
    assert_eq!(pr.merges, vec![PrMerge { head: NEXT.into(), at: 3, snapshot: Some(3) }]);
    assert!(fix_on_head(&card) && unpushed_fix(&card) && !merge_offered(&card));
    assert_ne!(review_offer(&card), Some(ReviewOffer::NewCommits));
    assert!(!adopt_head_in_fix(&mut card, &contains, 7), "done once");
    // A fix built on top of a head it already had isn't called a merge.
    let mut later = card.clone();
    later.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 4, sha: "fix2".into(), at: 8 });
    later.pr_review.as_mut().unwrap().head_sha = "33".into();
    let contains = |a: &str, b: &str| a == "33" && (b == "fix2" || b == "merge");
    assert!(adopt_head_in_fix(&mut later, &contains, 9));
    assert_eq!(later.pr_review.as_ref().unwrap().merges.len(), 1, "no merge recorded: the head was in before");
    // A head snapshot (a review of GitHub's head) is not a fix.
    let mut head = pr_card(true);
    head.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 1, sha: NEXT.into(), at: 1 });
    head.pr_review.as_mut().unwrap().heads = vec![1];
    assert!(!adopt_head_in_fix(&mut head, &|_: &str, _: &str| true, 2));
}

/// Challenger on walk 4: a head force-pushed back to a commit the fix's own
/// head already had is in the fix without a merge — not adopted on a read
/// or at Build done (pushing would bring back the commits taken off); and a
/// read that changes nothing says nothing changed.
#[test]
fn a_head_that_went_back_is_not_adopted_and_a_still_read_changes_nothing() {
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    b.snapshots.push(BuildSnapshot { n: 2, sha: "fix".into(), at: 2 });
    let pr = card.pr_review.as_mut().unwrap();
    pr.heads = vec![1];
    pr.branch_head = Some(HEAD.into());
    pr.head_mark = 1;
    // GitHub's head went back to "older", an ancestor of HEAD (and so of
    // the fix).
    pr.head_sha = "older".into();
    let contains = |a: &str, b: &str| a == "older" && (b == HEAD || b == "fix");
    assert!(!adopt_head_in_fix(&mut card, &contains, 3));
    let pr = card.pr_review.as_ref().unwrap();
    assert_eq!((pr.branch_head.as_deref(), pr.head_mark), (Some(HEAD), 1), "still on the head it was built on");
    assert!(!fix_on_head(&card));

    // A merge recorded before walk 4 (no snapshot) whose snapshot isn't the
    // newest any more: nothing to label, nothing changed, on every read.
    let mut old = pr_card(true);
    let b = old.builder.as_mut().unwrap();
    b.snapshots.push(BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 });
    b.snapshots.push(BuildSnapshot { n: 2, sha: "merge".into(), at: 2 });
    b.snapshots.push(BuildSnapshot { n: 3, sha: "fix2".into(), at: 3 });
    let pr = old.pr_review.as_mut().unwrap();
    pr.heads = vec![1];
    pr.head_sha = NEXT.into();
    pr.branch_head = Some(NEXT.into());
    pr.head_mark = 2;
    pr.merges = vec![PrMerge { head: NEXT.into(), at: 2, snapshot: None }];
    let before = old.clone();
    let contains = |a: &str, b: &str| a == NEXT && (b == "merge" || b == "fix2");
    assert!(!adopt_head_in_fix(&mut old, &contains, 4));
    assert_eq!(old.pr_review, before.pr_review);
}

/// Walk 4's `snapshot` on a merge: an old record reads without it, it isn't
/// written while unset, and it round-trips.
#[test]
fn the_merge_snapshot_is_backward_compatible() {
    let old = serde_json::json!({ "number": 4, "url": "u", "repo": REPO, "headSha": HEAD, "merges": [{ "head": NEXT, "at": 5 }] });
    let r: PrReview = serde_json::from_value(old).unwrap();
    assert_eq!(r.merges, vec![PrMerge { head: NEXT.into(), at: 5, snapshot: None }]);
    let json = serde_json::to_value(&r).unwrap();
    assert!(json["merges"][0].get("snapshot").is_none());
    let mut with = r.clone();
    with.merges[0].snapshot = Some(3);
    let json = serde_json::to_value(&with).unwrap();
    assert_eq!(json["merges"][0]["snapshot"], 3);
    assert_eq!(serde_json::from_value::<PrReview>(json).unwrap(), with);
}

mod sync_prune_tests;

// ── Mac walk 2026-10-17 of #386 ─────────────────────────────────────────

/// Card #26 of the walk: the fix (snapshot 10) was pushed, then two plain
/// commits landed on the pull request's branch on GitHub. A read is plain
/// new commits to review (Review again), not new commits under the fix,
/// and records no `merges` entry. A card a read before the fix left in the
/// wrong state (a snapshot-less entry for that head) recovers on the next
/// read; a real read under an unpushed fix keeps its entry.
#[test]
fn new_commits_on_top_of_a_pushed_fix_are_new_commits_to_review() {
    const FIX: &str = "6bbed95b00000000000000000000000000000000";
    const PLAIN: &str = "0e8982b400000000000000000000000000000000";
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots = (1..=9).map(|n| BuildSnapshot { n, sha: format!("{n:040}"), at: n as i64 }).collect();
    b.snapshots[8].sha = HEAD.into();
    b.snapshots.push(BuildSnapshot { n: 10, sha: FIX.into(), at: 10 });
    b.review = Some(review(10, "done", Some("approve")));
    {
        let p = card.pr_review.as_mut().unwrap();
        p.heads = vec![1, 9];
        p.head_sha = HEAD.into();
        p.branch_head = Some(HEAD.into());
        p.head_mark = 9;
    }
    assert!(unpushed_fix(&card));
    apply_pushed(&mut card, FIX, 1_000).unwrap();
    assert_eq!(inbox_ask(&card), None, "approved and pushed: nothing asked");
    // Two plain commits on GitHub, then a Sync / poll.
    let moved = parse_pr_view(&view_json("OPEN", "octo", false, PLAIN)).unwrap();
    let read = |card: &mut KanbanCard, now: i64| {
        apply_facts(card.pr_review.as_mut().unwrap(), &moved, now);
        adopt_landed_fix(card, now);
        adopt_head_in_fix(card, &|_: &str, _: &str| false, now);
        note_head_read(card, now)
    };
    let mut fresh = card.clone();
    assert!(!read(&mut fresh, 2_000), "no merges entry on a read");
    let p = fresh.pr_review.as_ref().unwrap();
    assert_eq!(p.head_sha, PLAIN);
    assert!(p.merges.is_empty(), "{:?}", p.merges);
    assert!(!merge_offered(&fresh) && !unpushed_fix(&fresh) && !fix_on_head(&fresh));
    assert_eq!(review_offer(&fresh), Some(ReviewOffer::NewCommits));
    assert_eq!(inbox_ask(&fresh).map(|(_, w)| w), Some("Pull request #12 · new commits to review".to_string()));
    // The walk's card: a read before the fix recorded the entry.
    let mut stuck = card.clone();
    stuck.pr_review.as_mut().unwrap().merges.push(PrMerge { head: PLAIN.into(), at: 2_000, snapshot: None });
    assert!(read(&mut stuck, 3_000), "the wrong entry is dropped: the card changed");
    assert!(stuck.pr_review.as_ref().unwrap().merges.is_empty());
    assert_eq!(review_offer(&stuck), Some(ReviewOffer::NewCommits));
    assert!(!read(&mut stuck, 4_000), "then nothing changes");
    // A new fix after the push, then new commits: under the fix, recorded and kept.
    let mut fixed = card.clone();
    fixed.builder.as_mut().unwrap().snapshots.push(BuildSnapshot { n: 11, sha: "fix2".into(), at: 1_500 });
    assert!(read(&mut fixed, 2_000));
    assert!(merge_offered(&fixed));
    assert_eq!(fixed.pr_review.as_ref().unwrap().merges, vec![PrMerge { head: PLAIN.into(), at: 2_000, snapshot: None }]);
    assert!(!read(&mut fixed, 3_000));
    assert_eq!(fixed.pr_review.as_ref().unwrap().merges.len(), 1, "a real read under the fix stays");
}

/// Challenger on 55c90ec2: a pushed fix the pull request was taken off (its
/// branch force-pushed back to the head the fix was built on, a commit the
/// card already has) is no fix under the head any more, and no longer
/// matches Bring in the new commits. The card says the head changed (new
/// commits to review, Review again), not "Approved" with nothing to do;
/// Review again then brings the card's branch back to that head
/// (`move_pr_card_branch`: the branch holds nothing but the pushed fix).
#[test]
fn a_pushed_fix_the_pull_request_was_taken_off_is_a_head_to_review_again() {
    const FIX: &str = "6bbed95b00000000000000000000000000000000";
    let mut card = pr_card(true);
    let b = card.builder.as_mut().unwrap();
    b.snapshots = vec![BuildSnapshot { n: 1, sha: HEAD.into(), at: 1 }, BuildSnapshot { n: 2, sha: FIX.into(), at: 2 }];
    b.review = Some(review(2, "done", Some("approve")));
    {
        let p = card.pr_review.as_mut().unwrap();
        p.heads = vec![1];
        p.branch_head = Some(HEAD.into());
        p.head_mark = 1;
    }
    apply_pushed(&mut card, FIX, 1_000).unwrap();
    assert_eq!(review_offer(&card), Some(ReviewOffer::Current));
    // Past the settle window GitHub reports HEAD again: the fix was taken off.
    let back = parse_pr_view(&view_json("OPEN", "octo", false, HEAD)).unwrap();
    let now = 1_000 + PUSH_SETTLE_MS + 1;
    apply_facts(card.pr_review.as_mut().unwrap(), &back, now);
    assert!(!adopt_landed_fix(&mut card, now), "HEAD is a head snapshot, not a fix that landed");
    let contains = |a: &str, b: &str| a == HEAD && b == FIX;
    assert!(!adopt_head_in_fix(&mut card, &contains, now), "a head that went back is not adopted");
    assert!(!note_head_read(&mut card, now));
    assert!(!merge_offered(&card) && !unpushed_fix(&card));
    assert_eq!(review_offer(&card), Some(ReviewOffer::NewCommits));
    assert_eq!(inbox_ask(&card).map(|(_, w)| w), Some("Pull request #12 · new commits to review".to_string()));
    // Still on the pushed fix (no move yet): a plain read of the pushed
    // head itself is current, as before.
    let mut on_fix = card.clone();
    on_fix.pr_review.as_mut().unwrap().head_sha = FIX.into();
    assert_eq!(review_offer(&on_fix), Some(ReviewOffer::Current));
}
