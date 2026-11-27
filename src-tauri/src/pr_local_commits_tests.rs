//! 1.169.1 (R2): a pull request never silently carries other cards'
//! commits. Walk R3 (B1–B3): after a local Ship it, the next card started
//! from the local target ahead of origin (`BaseSource::LocalAhead`) and Ship
//! as a PR pushed the land commit of the card before it with its own. These
//! drive Ship as a PR's stop (`pr_carry_stop`, through the real stores of a
//! mock app) against fixture repos: a bare `origin`, the workspace clone `ws`.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore};
use crate::project_config::{ProjectConfig, ProjectConfigStore};
use crate::workspace::WorkspaceStore;
use crate::worktrees::BaseSource;

const CARD_ID: &str = "card-r2";
const HALF: &str = "Land card: Add a half function";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.email", "t@ply.test"]);
    git(dir, &["config", "user.name", "ply-test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn commit(dir: &Path, rel: &str, body: &str, message: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
    git(dir, &["add", rel]);
    git(dir, &["commit", "-q", "-m", message]);
}

struct Fixture {
    _shell_env: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    ws: PathBuf,
    origin: PathBuf,
    ws_id: String,
    wt: PathBuf,
    branch: String,
    source: BaseSource,
}

impl Fixture {
    /// `ws` clones `origin`; `local_land` commits the half card's land on
    /// `ws`'s main first (never pushed), as a local Ship it does. Then a
    /// card starts as every card does (`ensure_for_card`) and commits its own
    /// work in its worktree.
    fn new(local_land: bool) -> Self {
        Self::with(local_land, false)
    }

    /// `offline`: origin can't be reached while the card starts
    /// (`BaseSource::LocalOffline`); it is back for the ship.
    fn with(local_land: bool, offline: bool) -> Self {
        let shell_env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        commit(&seed, ".gitignore", ".plyloft-worktrees/\n.atelier-worktrees/\n", "base");
        let origin = tmp.path().join("origin.git");
        git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
        let ws = tmp.path().join("ws");
        git(
            tmp.path(),
            &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), ws.to_str().unwrap()],
        );
        identity(&ws);
        if local_land {
            commit(&ws, "sum.js", "export function half(n) { return n / 2; }\n", HALF);
        }

        let away = tmp.path().join("origin.away");
        if offline {
            fs::rename(&origin, &away).unwrap();
        }
        let made = crate::worktrees::ensure_for_card(&ws, CARD_ID, "Add a quarter function", "main").unwrap();
        if offline {
            fs::rename(&away, &origin).unwrap();
        }
        let base = made.base.clone().expect("a new card's start");
        identity(&made.worktree_path);
        commit(&made.worktree_path, "quarter.js", "export const quarter = (n) => n / 4;\n", "build: snapshot 1 for Add a quarter function");

        let config = tmp.path().join("config");
        let workspaces = WorkspaceStore::new(config.join("workspaces")).unwrap();
        let kanban = KanbanStore::new(config.join("kanban")).unwrap();
        let project_config = ProjectConfigStore::new(config.join("project")).unwrap();
        let ws_id = workspaces.create("R2".into(), ws.to_string_lossy().into_owned()).unwrap().id;
        let project: ProjectConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "targetBranch": "main",
            "versionFiles": [],
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();
        project_config.set(&ws_id, project).unwrap();
        let mut c = KanbanCard::new(CARD_ID.into(), ws_id.clone(), "Add a quarter function".into(), None, KanbanColumnId::Complete);
        c.worktree_path = Some(made.worktree_path.to_string_lossy().into_owned());
        c.branch_name = Some(made.branch_name.clone());
        c.verify_status = crate::kanban::VerifyStatus::Passed;
        let source = base.source;
        c.worktree_base = Some(base);
        kanban.create_card(&ws_id, c).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(workspaces);
        app.manage(kanban);
        app.manage(project_config);
        Self {
            _shell_env: shell_env,
            _tmp: tmp,
            app,
            ws,
            origin,
            ws_id,
            wt: made.worktree_path,
            branch: made.branch_name,
            source,
        }
    }

    fn card(&self) -> KanbanCard {
        self.app.state::<KanbanStore>().get_card(&self.ws_id, CARD_ID).unwrap()
    }

    /// Ship's stop, exactly as `card_ship_blocking_with` asks it.
    fn stop(&self, mode: &str, carry_local_commits: bool) -> Option<crate::review::ShipOutcome> {
        let handle = self.app.handle();
        super::pr_carry_stop(
            &handle.state::<WorkspaceStore>(),
            &handle.state::<ProjectConfigStore>(),
            &self.ws_id,
            &self.card(),
            &self.wt,
            mode,
            carry_local_commits,
        )
        .unwrap()
    }

    /// The half card lands on local main (never pushed), as a local Ship it
    /// does after this card started. Returns local main's new tip.
    fn land_half_locally(&self) -> String {
        commit(&self.ws, "sum.js", "export function half(n) { return n / 2; }\n", HALF);
        git(&self.ws, &["rev-parse", "main"])
    }

    /// Records `merged` as the target commit Plyloft merged into the card
    /// to resolve a conflict (`ship_conflict::start`).
    fn record_merged_target(&self, merged: &str) {
        self.app
            .state::<KanbanStore>()
            .with_card(&self.ws_id, CARD_ID, |c| {
                c.worktree_base.as_mut().unwrap().merged_target = Some(merged.to_string());
                Ok(())
            })
            .unwrap();
    }

    /// The card's branch on origin, if anything pushed it.
    fn pushed(&self) -> String {
        git(&self.ws, &["ls-remote", "origin", &format!("refs/heads/{}", self.branch)])
    }
}

/// Walk R3 B2–B3: the card starts from local main ahead of origin by the
/// half card's land. Ship as a PR stops before any push and lists that
/// commit — never the card's own snapshot — in the wire shape the window
/// reads (`localCommits`). *Include them and ship as a PR* passes the stop on to the
/// push. Merge live never asks.
#[test]
fn a_pull_request_from_a_local_ahead_start_stops_and_lists_the_land_commit() {
    let fx = Fixture::new(true);
    assert_eq!(fx.source, BaseSource::LocalAhead, "the walk's start");

    let stop = fx.stop("pr", false).expect("Ship as a PR stops");
    assert_eq!(stop.kind, "carries_local_commits");
    assert!(!stop.merged && stop.pr_url.is_none());
    let local = stop.local_commits.clone().expect("the commits");
    assert_eq!(local.target, "main");
    assert_eq!(local.count, 1);
    assert_eq!(local.subjects, vec![HALF.to_string()], "the land, not the card's own snapshot");
    let wire = serde_json::to_value(&stop).unwrap();
    assert_eq!(wire["kind"], "carries_local_commits");
    assert_eq!(wire["localCommits"]["subjects"][0], HALF);
    assert_eq!(wire["localCommits"]["count"], 1);
    assert_eq!(fx.pushed(), "", "nothing was pushed");

    assert!(fx.stop("pr", true).is_none(), "Include them and ship as a PR goes on to the push");
    assert!(fx.stop("merge_live", false).is_none(), "a local land carries nothing to GitHub");

    // The card's own line reads the same commits now…
    let card = fx.card();
    let line = super::pr_carries_local_commits(&fx.ws, &card, "main").expect("the card's line");
    assert_eq!(line, local);
    // …and once GitHub has main, there is nothing to say or stop on.
    git(&fx.ws, &["push", "-q", "origin", "main"]);
    assert!(super::pr_carries_local_commits(&fx.ws, &card, "main").is_none());
    assert!(fx.stop("pr", false).is_none());
}

/// Regression: a card started from GitHub's own main (the normal case) has
/// nothing extra, so Ship as a PR goes straight on, as before.
#[test]
fn a_pull_request_from_an_origin_start_never_stops() {
    let fx = Fixture::new(false);
    assert_eq!(fx.source, BaseSource::Origin);
    assert!(fx.stop("pr", false).is_none());
    assert!(super::pr_carries_local_commits(&fx.ws, &fx.card(), "main").is_none());
}

/// A skill card keeps its own refusal (`skill_pr_carries_local_commits`,
/// which has no *anyway*, tested in `skill_card_ipc_tests`): this stop
/// leaves skill cards to it, and that refusal counts the same commits.
#[test]
fn a_skill_card_keeps_its_own_refusal() {
    let source = include_str!("commands.rs");
    let (_, stop) = source.split_once("fn pr_carry_stop(").expect("the stop");
    let stop = stop.split_once("\n}\n").unwrap().0;
    assert!(stop.contains("card.skill_card().is_some()"), "skill cards are left to their own refusal");
    let (_, skill) = source.split_once("pub(crate) fn skill_pr_carries_local_commits(").expect("the skill refusal");
    let skill = skill.split_once("\n}\n").unwrap().0;
    assert!(skill.contains("pr_carries_local_commits(ws_cwd, card, target)?"), "one way of finding them");
}

/// Source pin: Ship as a PR's stop is asked before anything is gated or
/// pushed, with the person's *anyway*; Ship with follow-up asks it before
/// it makes the follow-up card, and hands the *anyway* on.
#[test]
fn the_stop_comes_before_the_gate_the_push_and_the_follow_up_card() {
    let source = include_str!("commands.rs");
    let (_, ship) = source.split_once("fn card_ship_blocking_with(").expect("card_ship");
    let (ship, _) = ship.split_once("pub async fn card_ship_with_follow_up(").expect("its end");
    let stop = ship
        .find("pr_carry_stop(&workspaces, &project_config, &workspace_id, &card, &wt, &mode, carry_local_commits)?")
        .expect("the stop");
    assert!(stop < ship.find("ship_tree_gate(&app").unwrap());
    assert!(stop < ship.find("crate::worktrees::release_push(").unwrap());
    assert!(ship.find("skill_pr_carries_local_commits(").unwrap() < stop, "after the skill card's own refusal");

    let (_, follow) = source.split_once("fn card_ship_with_follow_up_blocking(").expect("follow-up");
    let follow = follow.split_once("\n}\n").unwrap().0;
    let stop = follow.find("pr_carry_stop(").expect("the follow-up's stop");
    assert!(stop < follow.find("ensure_follow_up_card(").unwrap());
    assert!(follow.contains("        mode,\n        carry_local_commits,\n        Some(line),"));

    let (_, command) = source.split_once("pub async fn card_ship(").expect("card_ship");
    let command = command.split_once("\n}\n").unwrap().0;
    assert!(command.contains("carry_local_commits: Option<bool>"));
    assert!(command.contains("card_ship_blocking(app.clone(), workspace_id.clone(), card_id.clone(), mode, carry, draft)"));
}

/// Challenger 1: local main merged into the card's copy outside Plyloft's
/// conflict flow (the Builder, or by hand) — the card started from GitHub's
/// main, yet its pull request would carry the half card's land. It stops.
#[test]
fn local_main_merged_into_an_origin_started_card_stops() {
    let fx = Fixture::new(false);
    assert_eq!(fx.source, BaseSource::Origin);
    fx.land_half_locally();
    assert!(fx.stop("pr", false).is_none(), "not merged into the card: nothing carried");
    git(&fx.wt, &["merge", "-q", "--no-edit", "main"]);
    let stop = fx.stop("pr", false).expect("it stops");
    assert_eq!(stop.local_commits.unwrap().subjects, vec![HALF.to_string()], "the land, not the merge itself");
}

/// Challenger 2 + 4: the target commit the conflict flow merged in counts
/// while the card's branch holds it — and not after *Undo the merge*, which
/// leaves the record behind.
#[test]
fn a_conflict_merge_counts_until_it_is_undone() {
    let fx = Fixture::new(false);
    let merged = fx.land_half_locally();
    // Started, then undone: the record stays, the branch never got it.
    fx.record_merged_target(&merged);
    assert!(fx.stop("pr", false).is_none(), "an undone merge carries nothing");

    // Finished: the branch holds it. Local main moves back to GitHub's, so
    // only the record can say what the merge brought.
    git(&fx.wt, &["merge", "-q", "--no-edit", &merged]);
    let at_origin = git(&fx.ws, &["rev-parse", "origin/main"]);
    git(&fx.ws, &["update-ref", "refs/heads/main", &at_origin]);
    let stop = fx.stop("pr", false).expect("the merged target counts");
    assert_eq!(stop.local_commits.unwrap().subjects, vec![HALF.to_string()]);
}

/// Challenger 4: an offline start from a local main holding a land stops too.
#[test]
fn an_offline_start_holding_a_land_stops() {
    let fx = Fixture::with(true, true);
    assert_eq!(fx.source, BaseSource::LocalOffline);
    let stop = fx.stop("pr", false).expect("it stops");
    assert_eq!(stop.local_commits.unwrap().subjects, vec![HALF.to_string()]);
}

/// Challenger 4: GitHub has no `main` at all — no stop (the pull request is
/// refused there anyway, in GitHub's words).
#[test]
fn no_target_on_github_never_stops() {
    let fx = Fixture::new(true);
    git(&fx.origin, &["update-ref", "-d", "refs/heads/main"]);
    git(&fx.ws, &["update-ref", "-d", "refs/remotes/origin/main"]);
    assert!(fx.stop("pr", false).is_none());
}

/// Challenger 3: the check reads GitHub's target as it is now — a main
/// pushed from elsewhere since the last fetch carries nothing any more.
#[test]
fn the_check_fetches_github_first() {
    let fx = Fixture::new(true);
    let other = fx.ws.parent().unwrap().join("other");
    git(fx.ws.parent().unwrap(), &["clone", "-q", fx.origin.to_str().unwrap(), other.to_str().unwrap()]);
    identity(&other);
    git(&other, &["fetch", "-q", fx.ws.to_str().unwrap(), "main"]);
    git(&other, &["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    git(&other, &["push", "-q", "origin", "main"]);
    assert!(super::pr_carries_local_commits(&fx.ws, &fx.card(), "main").is_some(), "stale until fetched");
    assert!(fx.stop("pr", false).is_none(), "Ship as a PR fetched first");
}
