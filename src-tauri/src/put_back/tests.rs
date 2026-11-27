//! N14 F8: Put back in To do — what refuses, what the write keeps and
//! clears, the sessions it stops, and the Start
//! build afterwards continuing on the same branch and worktree.

use std::cell::Cell;
use std::path::Path;

use super::*;
use crate::kanban::{IntakeStatus, KanbanCard, KanbanColumnId, KanbanStore, LastRunStatus, VerifyStatus};
use crate::license::{LicenseStore, PlanCase};
use crate::project_config::ProjectConfigStore;
use crate::workspace::WorkspaceStore;

fn card(id: &str, column: KanbanColumnId) -> KanbanCard {
    KanbanCard::new(id.into(), "ws".into(), format!("Card {id}"), None, column)
}

fn builder(pty: Option<&str>) -> crate::kanban::BuilderState {
    serde_json::from_value(serde_json::json!({
        "vendor": "claude",
        "bypass": false,
        "ptyId": pty,
        "sessionLost": false,
        "startedAt": 1,
        "snapshots": [{ "n": 1, "sha": "abc1234", "at": 2 }],
        "review": { "snapshotN": 1, "provider": "codex", "degraded": false, "status": "done",
                    "verdict": "changes_requested", "at": 3 },
        "waitingReview": { "snapshotN": 1, "requestedAt": 4 },
    }))
    .unwrap()
}

#[test]
fn what_can_be_put_back_and_what_refuses_in_words() {
    let mut c = card("a", KanbanColumnId::InProgress);
    c.worktree_path = Some("/w/a".into());
    assert_eq!(refusal(&c, false), None, "in progress");
    assert_eq!(refusal(&c, true), None, "in progress here, on a GitHub board");
    c.column_id = KanbanColumnId::Complete;
    assert_eq!(refusal(&c, false), None, "waiting to ship");

    let mut todo = c.clone();
    todo.column_id = KanbanColumnId::Todo;
    assert!(refusal(&todo, false).unwrap().contains("already in Ready to start"));
    let mut archived = c.clone();
    archived.archived = true;
    assert!(refusal(&archived, false).unwrap().contains("archived"));
    let mut shipped = c.clone();
    shipped.ship_status = crate::kanban::ShipStatus::Shipped;
    assert!(refusal(&shipped, false).unwrap().contains("shipped"));

    // The owner's words for an open pull request.
    let mut pr = c.clone();
    pr.pr_url = Some("https://github.com/o/r/pull/7".into());
    pr.pr = Some(crate::pr_status::PrStatus::opened(7, 1));
    assert_eq!(
        refusal(&pr, false).as_deref(),
        Some("This card has an open pull request — merge or close it first, or archive the card.")
    );
    // A closed (not merged) pull request is not in the way.
    pr.pr.as_mut().unwrap().state = crate::pr_status::PrState::Closed;
    assert_eq!(refusal(&pr, false), None);

    // A GitHub board: someone else's card, never built here, is not ours.
    // Complete with nothing kept is history; a comparison under way waits.
    let mut history = card("h", KanbanColumnId::Complete);
    history.worktree_path = None;
    assert!(refusal(&history, false).unwrap().contains("no work in progress"));
    let mut comparing = c.clone();
    let mut bb = crate::build_both::new_record("/w/a", "b-a", "/w/a-b", "b-b", false, 1);
    bb.compare = Some(crate::build_both::BuildCompare { status: "running".into(), ..Default::default() });
    comparing.build_both = Some(bb);
    assert!(refusal(&comparing, false).unwrap().contains("comparing the two builds"));

    let theirs = card("t", KanbanColumnId::InProgress);
    assert!(refusal(&theirs, true).unwrap().contains("isn't being built on"));
    assert_eq!(refusal(&theirs, false), None, "a local board has no one else");
}

#[test]
fn the_write_reads_as_to_do_and_keeps_the_branch_worktree_and_history() {
    let mut c = card("a", KanbanColumnId::Complete);
    c.worktree_path = Some("/w/a".into());
    c.branch_name = Some("plyloft/card-a-card-a".into());
    c.last_run_status = Some(LastRunStatus::Success);
    c.verify_status = VerifyStatus::Passed;
    c.intake_status = IntakeStatus::Active;
    let mut b = builder(Some("pty-1"));
    b.session_lost = true;
    b.resume_failed = true;
    c.builder = Some(b);
    apply(&mut c);
    assert_eq!(c.column_id, KanbanColumnId::Todo);
    assert_eq!(c.last_run_status, None, "nothing runs");
    assert_eq!(c.verify_status, VerifyStatus::None, "no checks to show");
    assert_eq!(c.intake_status, IntakeStatus::None);
    assert_eq!(c.worktree_path.as_deref(), Some("/w/a"), "worktree kept");
    assert_eq!(c.branch_name.as_deref(), Some("plyloft/card-a-card-a"), "branch kept");
    let b = c.builder.as_ref().unwrap();
    assert_eq!((b.pty_id.as_deref(), b.session_lost, b.resume_failed), (None, false, false));
    assert!(b.review.is_none() && b.waiting_review.is_none(), "no review under way or waiting");
    assert_eq!(b.snapshots.len(), 1, "the snapshots stay");

    let mut legacy = card("l", KanbanColumnId::Complete);
    legacy.verify_status = VerifyStatus::Legacy;
    apply(&mut legacy);
    assert_eq!(legacy.verify_status, VerifyStatus::Legacy, "a legacy marker is not a run");
}

// ── Over real stores and repositories ────────────────────────────────

fn git(dir: &Path, args: &[&str]) {
    let ok = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .status()
        .is_ok_and(|s| s.success());
    assert!(ok, "git {args:?} failed");
}

fn repo(root: &Path, name: &str) -> String {
    let repo = root.join(name);
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    repo.to_string_lossy().into_owned()
}

struct Rig {
    tmp: tempfile::TempDir,
    workspaces: WorkspaceStore,
    kanban: KanbanStore,
    project_config: ProjectConfigStore,
    w1: String,
    w2: String,
    builders: BuilderRegistry,
    pty: PtyRegistry,
}

/// Two local workspaces over real repositories, two To do cards in each.
fn rig() -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let workspaces = WorkspaceStore::new(config.clone()).unwrap();
    let w1 = workspaces.create("Alpha".into(), repo(tmp.path(), "alpha")).unwrap().id;
    let w2 = workspaces.create("Beta".into(), repo(tmp.path(), "beta")).unwrap().id;
    let kanban = KanbanStore::new(config.clone()).unwrap();
    for (ws, ids) in [(&w1, ["a1", "a2"]), (&w2, ["b1", "b2"])] {
        for id in ids {
            let mut c = card(id, KanbanColumnId::Todo);
            c.workspace_id = ws.clone();
            kanban.create_card(ws, c).unwrap();
        }
    }
    Rig {
        project_config: ProjectConfigStore::new(config).unwrap(),
        tmp,
        workspaces,
        kanban,
        w1,
        w2,
        builders: BuilderRegistry::default(),
        pty: PtyRegistry::default(),
    }
}

impl Rig {
    fn license(&self, case: PlanCase) -> LicenseStore {
        LicenseStore::for_plan_test(self.tmp.path().join("config"), case)
    }

    fn cwd(&self, ws: &str) -> std::path::PathBuf {
        let w = self.workspaces.snapshot().workspaces.into_iter().find(|w| w.id == ws).unwrap();
        w.cwd.into()
    }

    /// A start, as every app path makes it: under CARD_START_LOCK.
    fn start(&self, license: &LicenseStore, ws: &str, id: &str) -> Result<KanbanCard, String> {
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        crate::commands::advance_card_to_in_progress_staged(
            None::<&tauri::AppHandle<tauri::test::MockRuntime>>,
            &self.kanban,
            &self.workspaces,
            &self.project_config,
            license,
            ws,
            id,
            Some("main".into()),
        )
        .map(|(card, _)| card)
    }

    /// A started card's Builder at work: a live session and a running run.
    fn building(&self, ws: &str, id: &str) {
        self.builders.insert_for_test(id, &format!("pty-{id}"), "claude");
        self.kanban
            .with_card(ws, id, |c| {
                c.builder = Some(builder(Some(&format!("pty-{id}"))));
                c.last_run_status = Some(LastRunStatus::Running);
                Ok(())
            })
            .unwrap();
    }

    fn put_back_with(
        &self,
        ws: &str,
        id: &str,
        busy: &dyn Fn(&KanbanCard) -> Option<String>,
        stop_intake: &dyn Fn() -> Result<bool, String>,
    ) -> Result<KanbanCard, String> {
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let live = Live { builders: &self.builders, pty: &self.pty, busy, stop_intake };
        put_back_locked(&self.kanban, &self.cwd(ws), &[], &live, false, ws, id, Some("me"))
    }

    fn put_back(&self, ws: &str, id: &str) -> Result<KanbanCard, String> {
        self.put_back_with(ws, id, &|_| None, &|| Ok(false))
    }
}

/// The session stops, the card is To do, and the worktree and its branch
/// stay — with the work in them.
#[test]
fn put_back_stops_the_session_and_keeps_the_branch_and_worktree() {
    let r = rig();
    let pro = r.license(PlanCase::Pro);
    let started = r.start(&pro, &r.w1, "a1").unwrap();
    let wt = std::path::PathBuf::from(started.worktree_path.clone().unwrap());
    let branch = started.branch_name.clone().unwrap();
    std::fs::write(wt.join("work.txt"), "so far").unwrap();
    crate::worktrees::commit_pending_in_worktree(&wt, "build: so far").unwrap();
    r.building(&r.w1, "a1");

    let back = r.put_back(&r.w1, "a1").unwrap();
    assert_eq!(r.builders.get_pty("a1"), None, "the Builder session is stopped");
    assert_eq!(back.column_id, KanbanColumnId::Todo);
    assert_eq!(back.last_run_status, None);
    assert_eq!(back.builder.as_ref().unwrap().pty_id, None);
    assert_eq!(back.worktree_path, started.worktree_path, "the worktree is still the card's");
    assert_eq!(back.branch_name.as_deref(), Some(branch.as_str()));
    assert!(wt.join("work.txt").is_file(), "the worktree is still on disk with its work");
    git(&r.cwd(&r.w1), &["rev-parse", "--verify", "-q", &branch]);
    let on_disk = KanbanStore::new(r.tmp.path().join("config")).unwrap().get_card(&r.w1, "a1").unwrap();
    assert_eq!(on_disk.column_id, KanbanColumnId::Todo, "written to disk");
    // N14 walk F19: the put back is recorded, for the Activity's row.
    assert_eq!(back.put_backs.len(), 1);
    assert_eq!(on_disk.put_backs, back.put_backs, "the record is on disk");
}

/// N14 walk F19: every put back is one record, oldest first, capped.
#[test]
fn put_backs_are_recorded_oldest_first_and_capped() {
    let mut c = card("a", KanbanColumnId::InProgress);
    for at in 0..(crate::kanban::MAX_PUT_BACKS as i64 + 3) {
        record_put_back(&mut c, at);
    }
    assert_eq!(c.put_backs.len(), crate::kanban::MAX_PUT_BACKS);
    assert_eq!(c.put_backs.first(), Some(&3));
    assert_eq!(c.put_backs.last(), Some(&(crate::kanban::MAX_PUT_BACKS as i64 + 2)));
}

/// Refused: nothing is stopped and nothing is written.
#[test]
fn a_refused_put_back_stops_nothing_and_writes_nothing() {
    let r = rig();
    let pro = r.license(PlanCase::Pro);
    r.start(&pro, &r.w1, "a1").unwrap();
    r.building(&r.w1, "a1");
    r.kanban
        .with_card(&r.w1, "a1", |c| {
            c.pr_url = Some("https://github.com/o/r/pull/7".into());
            c.pr = Some(crate::pr_status::PrStatus::opened(7, 1));
            Ok(())
        })
        .unwrap();
    let before = r.kanban.get_card(&r.w1, "a1").unwrap();
    let err = r.put_back(&r.w1, "a1").unwrap_err();
    assert_eq!(err, OPEN_PR_REFUSAL);
    assert_eq!(r.builders.get_pty("a1").as_deref(), Some("pty-a1"), "the session goes on");
    let after = r.kanban.get_card(&r.w1, "a1").unwrap();
    assert_eq!(after.column_id, before.column_id);
    assert_eq!(after.pr, before.pr, "the pull request is never touched");
    assert_eq!(after.pr_url, before.pr_url);

    // Work it can't stop (the checks, the Challenger) refuses the same way.
    let r = rig();
    r.start(&pro, &r.w1, "a1").unwrap();
    r.building(&r.w1, "a1");
    let busy = |_: &KanbanCard| Some("The checks are running on this card.".to_string());
    let err = r.put_back_with(&r.w1, "a1", &busy, &|| Ok(false)).unwrap_err();
    assert_eq!(err, "The checks are running on this card.");
    assert!(r.builders.get_pty("a1").is_some());
    assert_eq!(r.kanban.get_card(&r.w1, "a1").unwrap().column_id, KanbanColumnId::InProgress);
}

/// A live intake on the card is ended; a card without one asks nothing.
#[test]
fn a_live_intake_is_ended_with_the_put_back() {
    let r = rig();
    let pro = r.license(PlanCase::Pro);
    r.start(&pro, &r.w1, "a1").unwrap();
    r.start(&pro, &r.w1, "a2").unwrap();
    r.kanban
        .with_card(&r.w1, "a1", |c| {
            c.intake_status = IntakeStatus::Active;
            Ok(())
        })
        .unwrap();
    // Asked every time, whatever the card says (the registry knows).
    let asked = Cell::new(0);
    let live_one = || {
        asked.set(asked.get() + 1);
        Ok(true)
    };
    let back = r.put_back_with(&r.w1, "a1", &|_| None, &live_one).unwrap();
    assert_eq!(asked.get(), 1);
    assert_eq!(back.intake_status, IntakeStatus::None);
    let none = || {
        asked.set(asked.get() + 1);
        Ok(false)
    };
    let back = r.put_back_with(&r.w1, "a2", &|_| None, &none).unwrap();
    assert_eq!(asked.get(), 2, "asked even when the card records none");
    assert_eq!(back.intake_status, IntakeStatus::None);
}

/// On Free, a second card starts while the first is at work (no plan limits
/// how many build at once). The first, put back and started again, continues
/// on its own branch and worktree with the work in it — even with its title
/// changed while it waited in To do, and with the other card still at work.
#[test]
fn put_back_then_start_build_continues_on_the_same_branch() {
    let r = rig();
    let free = r.license(PlanCase::Free);
    let first = r.start(&free, &r.w1, "a1").unwrap();
    let wt = std::path::PathBuf::from(first.worktree_path.clone().unwrap());
    std::fs::write(wt.join("work.txt"), "so far").unwrap();
    crate::worktrees::commit_pending_in_worktree(&wt, "build: so far").unwrap();
    let tip = crate::worktrees::head_sha(&wt).unwrap();
    std::fs::write(wt.join("uncommitted.txt"), "kept too").unwrap();
    r.building(&r.w1, "a1");
    r.start(&free, &r.w2, "b1").expect("another card starts while a1 is at work");

    r.put_back(&r.w1, "a1").unwrap();

    // Renamed while in To do: the branch was named from the first title.
    r.kanban
        .with_card(&r.w1, "a1", |c| {
            c.title = "A brand new title".into();
            Ok(())
        })
        .unwrap();
    let before = r.kanban.get_card(&r.w1, "a1").unwrap();
    let again = r.start(&free, &r.w1, "a1").unwrap();
    assert!(crate::commands::continues_kept_work(&before, &again), "the brief says it continues");
    assert_eq!(again.column_id, KanbanColumnId::InProgress);
    assert_eq!(again.worktree_path, first.worktree_path, "the same worktree");
    assert_eq!(again.branch_name, first.branch_name, "the same branch");
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), tip, "its commits are there");
    assert!(wt.join("uncommitted.txt").is_file(), "and what was not committed yet");
    assert_eq!(again.builder.as_ref().unwrap().snapshots.len(), 1, "its snapshots too");
    assert_eq!(r.kanban.get_card(&r.w2, "b1").unwrap().column_id, KanbanColumnId::InProgress, "b1 still at work");
}

/// Both builds stop: the card keeps Claude's worktree (its own) and is To
/// do with no Builder; Codex's build is set aside with its branch kept, as
/// Stop both does.
#[test]
fn a_card_built_by_both_stops_both_builds_and_keeps_its_own_worktree() {
    use crate::build_both::{lane_key, new_record, LANE_A, LANE_B};
    let r = rig();
    let ws_cwd = r.cwd(&r.w1);
    let a = crate::worktrees::ensure_for_card(&ws_cwd, "a1", "Card a1", "main").unwrap();
    let base = a.base.as_ref().unwrap().commit.clone();
    let b = crate::worktrees::ensure_variant_for_card(&ws_cwd, "a1", &a.branch_name, &base).unwrap();
    std::fs::write(b.worktree_path.join("codex.txt"), "x").unwrap();
    r.kanban
        .with_card(&r.w1, "a1", |c| {
            c.column_id = KanbanColumnId::InProgress;
            c.worktree_path = Some(a.worktree_path.to_string_lossy().into_owned());
            c.branch_name = Some(a.branch_name.clone());
            c.last_run_status = Some(LastRunStatus::Running);
            let mut bb = new_record(
                &a.worktree_path.to_string_lossy(),
                &a.branch_name,
                &b.worktree_path.to_string_lossy(),
                &b.branch_name,
                false,
                10,
            );
            for lane in [LANE_A, LANE_B] {
                bb.lane_mut(lane).unwrap().pty_id = Some(format!("pty-{lane}"));
            }
            c.build_both = Some(bb);
            Ok(())
        })
        .unwrap();
    r.builders.insert_for_test(&lane_key("a1", LANE_A), "pty-a", "claude");
    r.builders.insert_for_test(&lane_key("a1", LANE_B), "pty-b", "codex");

    let back = r.put_back(&r.w1, "a1").unwrap();
    assert_eq!(r.builders.get_pty(&lane_key("a1", LANE_A)), None, "Claude's build stopped");
    assert_eq!(r.builders.get_pty(&lane_key("a1", LANE_B)), None, "Codex's build stopped");
    assert_eq!(back.column_id, KanbanColumnId::Todo);
    assert!(!crate::build_both::is_undecided(&back), "no longer built by both");
    assert_eq!(back.build_both.as_ref().unwrap().outcome.as_ref().unwrap().kind, "stopped");
    assert!(a.worktree_path.is_dir(), "the card's own worktree stays");
    assert_eq!(back.worktree_path.as_deref(), Some(a.worktree_path.to_string_lossy().as_ref()));
    assert!(!b.worktree_path.exists(), "Codex's build is set aside");
    git(&ws_cwd, &["rev-parse", "--verify", "-q", &b.branch_name]);
    git(&ws_cwd, &["show", &format!("{}:codex.txt", b.branch_name)]);
}

/// The frontend shows the open-PR words before the press, as these.
#[test]
fn the_frontend_says_the_open_pr_refusal_in_the_same_words() {
    let ts = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/cardLifecycle.ts"),
    )
    .unwrap();
    assert!(ts.contains(&format!("\"{OPEN_PR_REFUSAL}\"")), "cardLifecycle.ts PUT_BACK_OPEN_PR drifted");
}

// ── Challenger P2: a kept handle whose worktree is gone ───────────────

/// Put back, then the folder is deleted (and pruned, or not): the next
/// start checks the recorded branch out again with its work — after a
/// rename too — and the card records exactly what the Builder uses.
#[test]
fn a_put_back_card_whose_folder_went_starts_on_its_recorded_branch() {
    for (prune, rename) in [(false, false), (true, false), (false, true), (true, true)] {
        let what = format!("prune {prune}, rename {rename}");
        let r = rig();
        let pro = r.license(PlanCase::Pro);
        let first = r.start(&pro, &r.w1, "a1").unwrap();
        let wt = std::path::PathBuf::from(first.worktree_path.clone().unwrap());
        let branch = first.branch_name.clone().unwrap();
        std::fs::write(wt.join("work.txt"), "so far").unwrap();
        crate::worktrees::commit_pending_in_worktree(&wt, "build: so far").unwrap();
        r.put_back(&r.w1, "a1").unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        if prune {
            git(&r.cwd(&r.w1), &["worktree", "prune"]);
        }
        if rename {
            r.kanban
                .with_card(&r.w1, "a1", |c| {
                    c.title = "Renamed while waiting".into();
                    Ok(())
                })
                .unwrap();
        }
        let before = r.kanban.get_card(&r.w1, "a1").unwrap();
        let again = r.start(&pro, &r.w1, "a1").unwrap();
        assert_eq!(again.branch_name.as_deref(), Some(branch.as_str()), "{what}: the recorded branch");
        assert_eq!(again.worktree_path, first.worktree_path, "{what}: where the card's worktree lives");
        assert_eq!(again.worktree_base, first.worktree_base, "{what}: its base kept");
        assert!(wt.join("work.txt").is_file(), "{what}: with its work");
        let head = crate::git::capture(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(head.trim(), branch, "{what}: the Builder works on the branch the card records");
        assert!(crate::commands::continues_kept_work(&before, &again), "{what}");
    }
}

/// The recorded branch is gone too: the worktree is made afresh, and the
/// card records the new one — never the old handle — and the brief does
/// not say it continues.
#[test]
fn a_kept_handle_with_no_branch_left_is_replaced_by_the_fresh_worktree() {
    let r = rig();
    let pro = r.license(PlanCase::Pro);
    let first = r.start(&pro, &r.w1, "a1").unwrap();
    let wt = std::path::PathBuf::from(first.worktree_path.clone().unwrap());
    r.put_back(&r.w1, "a1").unwrap();
    git(&r.cwd(&r.w1), &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    git(&r.cwd(&r.w1), &["branch", "-D", first.branch_name.as_deref().unwrap()]);
    r.kanban
        .with_card(&r.w1, "a1", |c| {
            c.title = "Another title".into();
            Ok(())
        })
        .unwrap();
    let before = r.kanban.get_card(&r.w1, "a1").unwrap();
    let again = r.start(&pro, &r.w1, "a1").unwrap();
    let fresh = crate::worktrees::make_branch_name("a1", "Another title");
    assert_eq!(again.branch_name.as_deref(), Some(fresh.as_str()), "the new branch is recorded");
    let head = crate::git::capture(Path::new(again.worktree_path.as_deref().unwrap()), &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
    assert_eq!(head.trim(), fresh);
    assert!(again.worktree_base.is_some());
    assert!(!crate::commands::continues_kept_work(&before, &again));
}

/// The Codex build picked (`<id>-b`), put back, its folder gone: its own
/// branch is checked out again in its own folder.
#[test]
fn a_put_back_codex_pick_whose_folder_went_comes_back_on_its_branch() {
    let r = rig();
    let ws_cwd = r.cwd(&r.w1);
    let a = crate::worktrees::ensure_for_card(&ws_cwd, "a1", "Card a1", "main").unwrap();
    let base = a.base.as_ref().unwrap().commit.clone();
    let b = crate::worktrees::ensure_variant_for_card(&ws_cwd, "a1", &a.branch_name, &base).unwrap();
    std::fs::write(b.worktree_path.join("codex.txt"), "x").unwrap();
    crate::worktrees::commit_pending_in_worktree(&b.worktree_path, "build").unwrap();
    r.kanban
        .with_card(&r.w1, "a1", |c| {
            c.column_id = KanbanColumnId::InProgress;
            c.worktree_path = Some(b.worktree_path.to_string_lossy().into_owned());
            c.branch_name = Some(b.branch_name.clone());
            c.worktree_base = a.base.clone();
            Ok(())
        })
        .unwrap();
    r.put_back(&r.w1, "a1").unwrap();
    std::fs::remove_dir_all(&b.worktree_path).unwrap();
    let pro = r.license(PlanCase::Pro);
    let again = r.start(&pro, &r.w1, "a1").unwrap();
    assert_eq!(again.branch_name.as_deref(), Some(b.branch_name.as_str()));
    assert_eq!(again.worktree_path.as_deref(), Some(b.worktree_path.to_string_lossy().as_ref()), "its own folder");
    assert!(b.worktree_path.join("codex.txt").is_file());
    let head = crate::git::capture(&b.worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
    assert_eq!(head.trim(), b.branch_name);
}

/// A write that fails after the sessions were stopped says they were.
#[test]
fn a_failed_write_after_stopping_says_what_was_stopped() {
    let r = rig();
    let pro = r.license(PlanCase::Pro);
    r.start(&pro, &r.w1, "a1").unwrap();
    r.building(&r.w1, "a1");
    // The card goes between the read and the write (an intake stop that
    // deleted it stands in for any failed write).
    let gone = || {
        r.kanban.delete_card(&r.w1, "a1").unwrap();
        Ok(false)
    };
    let err = r.put_back_with(&r.w1, "a1", &|_| None, &gone).unwrap_err();
    assert!(err.starts_with("Its sessions were stopped, but the card couldn't be moved back to Ready to start"), "{err}");
    assert_eq!(r.builders.get_pty("a1"), None);
}
