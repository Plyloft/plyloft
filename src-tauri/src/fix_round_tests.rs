use super::*;
use crate::kanban::{BuildSnapshot, KanbanColumnId};

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn card_on(dir: &std::path::Path, sha: &str) -> KanbanCard {
    let mut card = KanbanCard::new("c".into(), "ws".into(), "T".into(), None, KanbanColumnId::InProgress);
    card.worktree_path = Some(dir.to_string_lossy().into_owned());
    let mut builder: crate::kanban::BuilderState = serde_json::from_value(serde_json::json!({
        "ptyId": "p", "vendor": "claude", "startedAt": 0, "snapshots": []
    }))
    .unwrap();
    builder.snapshots.push(BuildSnapshot { n: 1, sha: sha.into(), at: 1 });
    card.builder = Some(builder);
    card
}

/// F5 (§1c "Nessun file cambiato"): the copy against the snapshot the
/// Reviewer read — the same → nothing to check; a change git sees, or a
/// commit since → something to check; unknown → `None`, never a guess.
#[test]
fn whether_the_builder_changed_anything_since_the_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git_in(dir, &["init", "-q"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
    git_in(dir, &["add", "."]);
    git_in(dir, &["commit", "-q", "-m", "one"]);
    let head = git_in(dir, &["rev-parse", "HEAD"]);
    let card = card_on(dir, &head);
    assert_eq!(changed_since_snapshot(&card), Some(false));
    // An ignored file is not a change.
    std::fs::create_dir_all(dir.join("build")).unwrap();
    std::fs::write(dir.join("build/out"), "x").unwrap();
    assert_eq!(changed_since_snapshot(&card), Some(false));
    // An edit is.
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    assert_eq!(changed_since_snapshot(&card), Some(true));
    // A commit since the snapshot is, even with a clean tree.
    git_in(dir, &["commit", "-q", "-am", "two"]);
    assert_eq!(changed_since_snapshot(&card), Some(true));
    // Unknown: no copy, no snapshot.
    let mut gone = card.clone();
    gone.worktree_path = Some(dir.join("missing").to_string_lossy().into_owned());
    assert_eq!(changed_since_snapshot(&gone), None);
    let mut no_snap = card.clone();
    no_snap.builder.as_mut().unwrap().snapshots.clear();
    assert_eq!(changed_since_snapshot(&no_snap), None);
}

/// F5 (owner I6): the count of checks started by itself, kept on the card;
/// never on a card that reviews somebody else's pull request.
#[test]
fn the_count_is_kept_and_never_on_a_review_card() {
    let tmp = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c".into(), "ws".into(), "T".into(), None, KanbanColumnId::InProgress);
    store.create_card("ws", card).unwrap();
    set_self_checks(&store, "ws", "c", 2).unwrap();
    assert_eq!(store.get_card("ws", "c").unwrap().fix_round_self_checks, 2);
    set_self_checks(&store, "ws", "c", 0).unwrap();
    assert_eq!(store.get_card("ws", "c").unwrap().fix_round_self_checks, 0);
    store
        .with_card("ws", "c", |c| {
            c.pr_review = Some(crate::pr_review::PrReview { number: 1, ..Default::default() });
            Ok(())
        })
        .unwrap();
    assert!(set_self_checks(&store, "ws", "c", 1).is_err());
}

/// F5, Tier 2 schema migration: a card from 1.174.5 has neither field — it
/// loads following the setting, with no count, keeps the rest, and is
/// written back without them; set, both round-trip.
#[test]
fn a_card_from_1_174_5_loads_without_the_fix_round_fields() {
    let old = r#"{"id":"c1","workspaceId":"ws","title":"Old","notes":"brief","columnId":"in_progress","createdAt":1,"updatedAt":2,"prAutoFix":true}"#;
    let card: KanbanCard = serde_json::from_str(old).unwrap();
    assert_eq!((card.fix_round_check, card.fix_round_self_checks), (None, 0));
    assert_eq!((card.title.as_str(), card.pr_auto_fix), ("Old", Some(true)));
    let back = serde_json::to_value(&card).unwrap();
    assert!(back.get("fixRoundCheck").is_none() && back.get("fixRoundSelfChecks").is_none(), "{back}");
    let mut set = card;
    set.fix_round_check = Some(false);
    set.fix_round_self_checks = 2;
    let back = serde_json::to_value(&set).unwrap();
    assert_eq!((back["fixRoundCheck"].clone(), back["fixRoundSelfChecks"].clone()), (serde_json::json!(false), serde_json::json!(2)));
    let again: KanbanCard = serde_json::from_value(back).unwrap();
    assert_eq!((again.fix_round_check, again.fix_round_self_checks), (Some(false), 2));
}
