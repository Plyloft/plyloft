//! Tests for card_area (1.173.0 B3): a card's area decides where it starts,
//! ships and is measured from; files outside it are asked about before Ship.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::areas::AreaDef;
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, VerifyEntry, VerifyStatus};
use crate::project_config::{ProjectConfig, ProjectConfigStore};

const WS: &str = "ws";

fn area(id: &str, name: &str, path: &str, branch: Option<&str>) -> AreaDef {
    AreaDef {
        id: id.into(),
        name: name.into(),
        path: path.into(),
        target_branch: branch.map(str::to_string),
        ..Default::default()
    }
}

/// The walk's sandbox: the app at the root going to `staging`, the site in
/// its folder going to `main`.
fn two() -> Vec<AreaDef> {
    vec![area("app", "App", "/", Some("staging")), area("site", "Site", "site/", Some("main"))]
}

fn config(branch: &str) -> ProjectConfig {
    let mut cfg = crate::project_config::default_atelier_config();
    cfg.target_branch = branch.into();
    cfg
}

fn card(area: Option<&str>) -> KanbanCard {
    let mut c = KanbanCard::new("c1".into(), WS.into(), "Card".into(), None, KanbanColumnId::Todo);
    c.area = area.map(str::to_string);
    c
}

/// A pull request review: its base is the pull request's.
fn review_card() -> KanbanCard {
    let mut c = card(None);
    c.pr_review = Some(Default::default());
    c
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| p.to_string()).collect()
}

// ── Resolution ─────────────────────────────────────────────────────────

#[test]
fn a_repository_without_areas_is_the_workspace_s_branch_for_every_card() {
    let cfg = config("develop");
    assert_eq!(resolve_with(&cfg, &[], None, &card(None)), CardArea::Workspace(cfg.clone()));
    // An id on a card in a repository whose areas were removed is unknown.
    assert_eq!(resolve_with(&cfg, &[], None, &card(Some("site"))), CardArea::Unknown { id: "site".into() });
}

#[test]
fn a_card_s_area_takes_the_area_s_branch() {
    let cfg = config("develop");
    let CardArea::Area { area: site, config } = resolve_with(&cfg, &two(), None, &card(Some("site"))) else { panic!() };
    assert_eq!((site.name.as_str(), config.target_branch.as_str()), ("Site", "main"));
    let CardArea::Area { config, .. } = resolve_with(&cfg, &two(), None, &card(Some("app"))) else { panic!() };
    assert_eq!(config.target_branch, "staging");
    // An area without a branch of its own sends its cards to the workspace's.
    let list = vec![area("app", "App", "/", None), area("site", "Site", "site/", Some("main"))];
    let CardArea::Area { config, .. } = resolve_with(&cfg, &list, None, &card(Some("app"))) else { panic!() };
    assert_eq!(config.target_branch, "develop");
}

#[test]
fn a_card_without_an_area_is_asked_never_sent_to_the_workspace_s_branch() {
    let cfg = config("develop");
    let got = resolve_with(&cfg, &two(), None, &card(None));
    assert_eq!(got, CardArea::NeedsArea);
    assert_eq!(got.refusal().as_deref(), Some(NEEDS_AREA));
    assert!(got.config().is_none());
    // With one area listed, a card without one belongs to it.
    let one = vec![area("site", "Site", "site/", Some("main"))];
    let CardArea::Area { area, .. } = resolve_with(&cfg, &one, None, &card(None)) else { panic!() };
    assert_eq!(area.id, "site");
}

#[test]
fn an_unlisted_area_is_refused_with_its_name() {
    let got = resolve_with(&config("develop"), &two(), None, &card(Some("docs")));
    assert_eq!(got, CardArea::Unknown { id: "docs".into() });
    assert_eq!(
        got.refusal().unwrap(),
        "This card's area, docs, isn't in the repository's areas any more. Choose an area."
    );
}

#[test]
fn held_areas_refuse_every_card_with_or_without_an_area() {
    let cfg = config("develop");
    let held = || Some("Two areas share the folder “site/”.".to_string());
    for c in [card(None), card(Some("site")), review_card()] {
        let got = resolve_with(&cfg, &two(), held(), &c);
        assert!(matches!(got, CardArea::Held { .. }), "{got:?}");
        assert_eq!(
            got.refusal().unwrap(),
            "This repository's areas can't be used: Two areas share the folder “site/”. Fix them in Settings › Project › Areas."
        );
    }
}

#[test]
fn pull_request_reviews_choose_no_area() {
    let cfg = config("develop");
    let c = review_card();
    assert!(exempt(&c));
    assert_eq!(resolve_with(&cfg, &two(), None, &c), CardArea::Workspace(cfg.clone()));
}

// ── Over the stores ────────────────────────────────────────────────────

fn store() -> (tempfile::TempDir, ProjectConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    (dir, store)
}

/// A shared definition whose areas are `areas` (empty: none).
fn with_areas(store: &ProjectConfigStore, ws: &str, branch: &str, areas: &[AreaDef]) {
    store.set(ws, config(branch)).unwrap();
    crate::team_models::share_for_test(store, ws, false);
    crate::areas::save(store, ws, areas).unwrap();
}

/// The repository's areas break the rules and this Mac has no good copy.
fn hold(store: &ProjectConfigStore, ws: &str) {
    let path = crate::workspace_definition::cache_path(store, ws);
    fs::write(
        &path,
        r#"{"schemaVersion":1,"definition":{"name":"w"},"fieldProblems":{"areas":{"message":"Two areas share the folder site/.","kept":null}}}"#,
    )
    .unwrap();
    crate::areas::save(store, ws, &[]).unwrap();
}

#[test]
fn the_strict_and_the_reading_branch_over_the_stores() {
    let (_dir, store) = store();
    // No config: as `resolve_base_branch` — main, and nothing refused.
    assert_eq!(config_for_card(&store, WS, &card(None)).unwrap(), None);
    assert_eq!(branch_for_card(&store, WS, &card(None)).unwrap(), "main");
    with_areas(&store, WS, "develop", &[]);
    assert_eq!(branch_for_card(&store, WS, &card(None)).unwrap(), "develop", "no areas: as before");
    with_areas(&store, WS, "develop", &two());
    assert_eq!(branch_for_card(&store, WS, &card(Some("site"))).unwrap(), "main");
    assert_eq!(branch_for_card(&store, WS, &card(Some("app"))).unwrap(), "staging");
    assert_eq!(branch_for_card(&store, WS, &card(None)).unwrap_err(), NEEDS_AREA);
    assert!(branch_for_card(&store, WS, &card(Some("docs"))).unwrap_err().contains("docs"));
    assert_eq!(branch_for_card(&store, WS, &review_card()).unwrap(), "develop", "a review: the workspace's");
    // A reading never refuses: the area's branch, else the workspace's.
    assert_eq!(reading_branch(&store, WS, &card(Some("site"))), "main");
    assert_eq!(reading_branch(&store, WS, &card(None)), "develop");
    assert_eq!(reading_branch(&store, WS, &card(Some("docs"))), "develop");
    hold(&store, WS);
    let err = branch_for_card(&store, WS, &card(Some("site"))).unwrap_err();
    assert!(err.contains("can't be used") && err.contains("Settings › Project › Areas"), "{err}");
    assert!(branch_for_card(&store, WS, &review_card()).is_err(), "held: every card");
    assert_eq!(reading_branch(&store, WS, &card(Some("site"))), "develop");
}

/// 1.174.0 B4 (CH-1): the overlap check reads the stores once for every
/// card, and each area once — with the same answer as `reading_branch`.
#[test]
fn reading_branches_answer_as_reading_branch_for_every_card() {
    let (_dir, store) = store();
    let cards = [card(None), card(Some("site")), card(Some(" site ")), card(Some("app")), card(Some("docs")), card(Some("")), review_card()];
    let same = |store: &ProjectConfigStore, why: &str| {
        let mut reading = ReadingBranches::new(store, WS);
        for c in cards.iter().chain(cards.iter()) {
            assert_eq!(reading.branch(c), reading_branch(store, WS, c), "{why}: {:?}", c.area);
        }
    };
    same(&store, "no config");
    with_areas(&store, WS, "develop", &[]);
    same(&store, "no areas");
    with_areas(&store, WS, "develop", &[area("site", "Site", "site/", Some("main"))]);
    same(&store, "one area");
    with_areas(&store, WS, "develop", &two());
    same(&store, "two areas");
    let mut reading = ReadingBranches::new(&store, WS);
    assert_eq!(reading.branch(&card(Some("site"))), "main");
    assert_eq!(reading.branch(&card(Some("app"))), "staging");
    assert_eq!(reading.branch(&card(None)), "develop", "needs an area: the workspace's");
    hold(&store, WS);
    same(&store, "held");
}

#[test]
fn a_github_board_labels_areas_only_with_two_or_more() {
    let (_dir, store) = store();
    assert!(crate::github_sync::AreaLabels::for_workspace(&store, WS).is_empty());
    with_areas(&store, WS, "develop", &two()[1..]);
    assert!(crate::github_sync::AreaLabels::for_workspace(&store, WS).is_empty(), "one area: no labels");
    with_areas(&store, WS, "develop", &two());
    let labels = crate::github_sync::AreaLabels::for_workspace(&store, WS);
    assert_eq!((labels.label_of("app"), labels.label_of("site")), (Some("area:app"), Some("area:site")));
}

#[test]
fn the_area_line_says_when_its_label_hasn_t_reached_github() {
    let (_dir, store) = store();
    with_areas(&store, WS, "develop", &two());
    let mut c = card(Some("site"));
    c.id = "c-label-line".into();
    c.gh_issue_number = Some(5);
    assert_eq!(state_for(&store, WS, &c).label_line, None);
    crate::github_sync::note_area_label(WS, "c-label-line", true);
    assert_eq!(state_for(&store, WS, &c).label_line.as_deref(), Some("Its area label hasn't reached GitHub yet."));
    // Delivered since (by the other Mac, or a read): no longer said.
    c.gh_area_label = Some("area:site".into());
    assert_eq!(state_for(&store, WS, &c).label_line, None);
    c.gh_area_label = None;
    crate::github_sync::note_area_label(WS, "c-label-line", false);
    assert_eq!(state_for(&store, WS, &c).label_line, None);
}

#[test]
fn an_issue_with_several_areas_labels_asks_naming_them() {
    let (_dir, store) = store();
    with_areas(&store, WS, "develop", &two());
    let mut c = card(None);
    c.gh_area_label = Some("area:app,area:site".into());
    assert_eq!(
        state_for(&store, WS, &c).sentence.as_deref(),
        Some("Its issue is labeled area:app and area:site. Which area is this?")
    );
    assert_eq!(
        several_labels_words(&["a".into(), "b".into(), "c".into()]),
        "Its issue is labeled a, b and c. Which area is this?"
    );
}

#[test]
fn the_card_page_reads_its_area_line() {
    let (_dir, store) = store();
    with_areas(&store, WS, "develop", &two());
    let s = state_for(&store, WS, &card(Some("site")));
    assert_eq!((s.kind.as_str(), s.editable), ("area", true));
    assert_eq!(s.area.as_ref().unwrap().branch, "main");
    assert_eq!(s.areas.len(), 2);
    let mut started = card(Some("site"));
    started.column_id = KanbanColumnId::InProgress;
    assert!(!state_for(&store, WS, &started).editable, "a started card keeps its area");
    let s = state_for(&store, WS, &card(None));
    assert_eq!((s.kind.as_str(), s.sentence.as_deref(), s.editable), ("needsArea", Some("Which area is this?"), true));
    let s = state_for(&store, WS, &card(Some("docs")));
    assert_eq!(s.kind, "unknown");
    assert!(s.sentence.unwrap().contains("docs"));
    // C1: an issue labelled with an area nobody listed says which label.
    let mut labelled = card(None);
    labelled.gh_area_label = Some("area:docs".into());
    let s = state_for(&store, WS, &labelled);
    assert_eq!(
        (s.kind.as_str(), s.sentence.as_deref()),
        ("needsArea", Some("Its issue is labeled area:docs, which isn't one of this repository's areas. Which area is this?"))
    );
    labelled.gh_area_label = Some("AREA:SITE".into());
    assert_eq!(state_for(&store, WS, &labelled).sentence.as_deref(), Some("Which area is this?"), "a listed label");
    // A review card shows nothing; one area shows nothing.
    assert_eq!(state_for(&store, WS, &review_card()).kind, "none");
    with_areas(&store, WS, "develop", &two()[1..]);
    assert_eq!(state_for(&store, WS, &card(None)).kind, "none");
    hold(&store, WS);
    let s = state_for(&store, WS, &card(None));
    assert_eq!((s.kind.as_str(), s.editable), ("held", false));
}

#[test]
fn an_area_is_chosen_while_not_started_or_when_the_card_has_none() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("p")).unwrap();
    let kanban = KanbanStore::new(dir.path().join("k")).unwrap();
    with_areas(&store, WS, "develop", &two());
    kanban.create_card(WS, card(None)).unwrap();
    assert_eq!(set_area(&store, &kanban, WS, "c1", "site").unwrap().area.as_deref(), Some("site"));
    assert!(set_area(&store, &kanban, WS, "c1", "docs").unwrap_err().contains("docs"));
    assert_eq!(set_area(&store, &kanban, WS, "c1", "app").unwrap().area.as_deref(), Some("app"), "Not started: changed");
    kanban
        .with_card(WS, "c1", |c| {
            c.column_id = KanbanColumnId::InProgress;
            Ok(())
        })
        .unwrap();
    assert!(set_area(&store, &kanban, WS, "c1", "site").is_err(), "started in its area: it stays");
    // A started card whose area went away chooses again.
    kanban
        .with_card(WS, "c1", |c| {
            c.area = Some("docs".into());
            Ok(())
        })
        .unwrap();
    assert_eq!(set_area(&store, &kanban, WS, "c1", "site").unwrap().area.as_deref(), Some("site"));
    hold(&store, WS);
    assert!(set_area(&store, &kanban, WS, "c1", "app").unwrap_err().contains("can't be used"));
}

#[test]
fn a_new_card_takes_a_listed_area_and_refuses_another() {
    let (_dir, store) = store();
    assert_eq!(area_for_new_card(&store, WS, None).unwrap(), None);
    assert!(area_for_new_card(&store, WS, Some("site")).is_err(), "no areas: no id");
    with_areas(&store, WS, "develop", &two());
    assert_eq!(area_for_new_card(&store, WS, Some(" site ")).unwrap().as_deref(), Some("site"));
    assert_eq!(area_for_new_card(&store, WS, Some("")).unwrap(), None);
    assert!(area_for_new_card(&store, WS, Some("docs")).unwrap_err().contains("docs"));
}

// ── Files outside the area ─────────────────────────────────────────────

#[test]
fn files_outside_a_folder_area_name_where_they_belong() {
    let got = outside_files(&two(), "site", &paths(&["site/index.astro", "AGENTS.md", "frontend/Legal.tsx"]));
    assert_eq!(
        got.iter().map(|f| (f.path.as_str(), f.belongs.as_str(), f.area.as_deref())).collect::<Vec<_>>(),
        vec![("AGENTS.md", WHOLE_REPOSITORY, Some("app")), ("frontend/Legal.tsx", WHOLE_REPOSITORY, Some("app"))]
    );
    // With no root area, a file in no area is the whole repository's too.
    let list = vec![area("app", "App", "app/", Some("staging")), area("site", "Site", "site/", Some("main"))];
    let got = outside_files(&list, "site", &paths(&["README.md", "app/main.py", "site/a"]));
    assert_eq!(
        got.iter().map(|f| (f.path.as_str(), f.belongs.as_str(), f.area.as_deref())).collect::<Vec<_>>(),
        vec![("README.md", WHOLE_REPOSITORY, None), ("app/main.py", "App", Some("app"))]
    );
}

#[test]
fn the_root_area_s_outside_is_another_area_s_folder() {
    let got = outside_files(&two(), "app", &paths(&["AGENTS.md", "frontend/x.ts", "site/page.astro"]));
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].path.as_str(), got[0].belongs.as_str()), ("site/page.astro", "Site"));
}

#[test]
fn nested_areas_count_the_longest_folder() {
    let list = vec![
        area("app", "App", "/", Some("staging")),
        area("site", "Site", "site/", Some("main")),
        area("docs", "Docs", "site/docs/", Some("main")),
    ];
    let got = outside_files(&list, "site", &paths(&["site/a.astro", "site/docs/b.md", "c.md"]));
    assert_eq!(
        got.iter().map(|f| (f.path.as_str(), f.belongs.as_str())).collect::<Vec<_>>(),
        vec![("site/docs/b.md", "Docs"), ("c.md", WHOLE_REPOSITORY)]
    );
    assert!(outside_files(&list, "docs", &paths(&["site/docs/b.md"])).is_empty());
}

#[test]
fn the_hint_says_where_the_files_go_and_ahead_of_whose_work() {
    let resolved = crate::areas::resolve(&two(), "develop");
    let site = resolved.iter().find(|a| a.id == "site").unwrap().clone();
    let files = outside_files(&two(), "site", &paths(&["AGENTS.md"]));
    assert_eq!(
        outside_hint(&resolved, &site, &files),
        "If they ship with this card, they reach main before the rest of App's work on staging."
    );
    let same = vec![area("app", "App", "/", Some("main")), area("site", "Site", "site/", Some("main"))];
    let resolved = crate::areas::resolve(&same, "develop");
    let site = resolved.iter().find(|a| a.id == "site").unwrap().clone();
    let files = outside_files(&same, "site", &paths(&["AGENTS.md"]));
    assert_eq!(outside_hint(&resolved, &site, &files), "If they ship with this card, they reach main as part of Site's change.");
}

#[test]
fn the_choice_starts_on_the_area_every_changed_file_is_in() {
    assert_eq!(suggested_area(&two(), &paths(&["site/a", "site/b/c"])).as_deref(), Some("site"));
    assert_eq!(suggested_area(&two(), &paths(&["site/a", "README.md"])), None);
    assert_eq!(suggested_area(&two(), &paths(&["README.md"])).as_deref(), Some("app"));
    assert_eq!(suggested_area(&two(), &[]), None);
}

// ── Real repositories ──────────────────────────────────────────────────

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command().args(args).current_dir(cwd).output().expect("spawn git");
    assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.email", "t@ply.test"]);
    git(dir, &["config", "user.name", "ply-test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn write(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

/// origin with `main` (the site's branch) and `staging` (the app's, one
/// commit ahead), and the member's clone of it.
struct Repo {
    _shell_env: std::sync::MutexGuard<'static, ()>,
    tmp: tempfile::TempDir,
    ws: PathBuf,
    main: String,
    staging: String,
}

fn repo() -> Repo {
    let shell_env = crate::shell_env::lock_for_test();
    crate::shell_env::init();
    let tmp = tempfile::tempdir().unwrap();
    let seed = tmp.path().join("seed");
    fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    identity(&seed);
    write(&seed, ".gitignore", ".plyloft-worktrees/\n.atelier-worktrees/\n");
    write(&seed, "AGENTS.md", "rules\n");
    write(&seed, "site/index.astro", "home\n");
    write(&seed, "app/main.py", "print(1)\n");
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "base"]);
    let main = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["checkout", "-q", "-b", "staging"]);
    write(&seed, "app/staging-only.py", "x\n");
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "staging work"]);
    let staging = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["checkout", "-q", "main"]);
    let origin = tmp.path().join("origin.git");
    git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
    let ws = tmp.path().join("ws");
    git(tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), ws.to_str().unwrap()]);
    identity(&ws);
    git(&ws, &["branch", "-q", "staging", "origin/staging"]);
    Repo { _shell_env: shell_env, tmp, ws, main, staging }
}

/// The stores of one workspace over `repo.ws`, its target `staging`, the
/// two areas shared, and one Not started card.
struct Board {
    store: KanbanStore,
    workspaces: crate::workspace::WorkspaceStore,
    configs: ProjectConfigStore,
    license: crate::license::LicenseStore,
    ws: String,
}

fn board(repo: &Repo, area: Option<&str>) -> Board {
    let config = repo.tmp.path().join("config");
    let workspaces = crate::workspace::WorkspaceStore::new(config.join("w")).unwrap();
    let ws = workspaces.create("Mono".into(), repo.ws.to_string_lossy().into_owned()).unwrap().id;
    let configs = ProjectConfigStore::new(config.join("p")).unwrap();
    with_areas(&configs, &ws, "staging", &two());
    let store = KanbanStore::new(config.join("k")).unwrap();
    let mut c = KanbanCard::new("c1".into(), ws.clone(), "Site card".into(), None, KanbanColumnId::Todo);
    c.area = area.map(str::to_string);
    store.create_card(&ws, c).unwrap();
    Board {
        license: crate::license::LicenseStore::new_team_allowed_for_test(config.join("l")),
        store,
        workspaces,
        configs,
        ws,
    }
}

fn start(b: &Board) -> Result<KanbanCard, String> {
    crate::commands::advance_card_to_in_progress(
        None::<&tauri::AppHandle<tauri::test::MockRuntime>>,
        &b.store,
        &b.workspaces,
        &b.configs,
        &b.license,
        &b.ws,
        "c1",
        None,
    )
}

/// Call site: card start (`advance_card_to_in_progress_staged` →
/// `ensure_for_card`) cuts the card's copy from its area's branch.
#[test]
fn a_site_card_starts_from_main_and_an_app_card_from_staging() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.unwrap());
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), r.main);
    assert!(!wt.join("app/staging-only.py").exists());
    drop(b);
    drop(r);

    let r = repo();
    let b = board(&r, Some("app"));
    let wt = PathBuf::from(start(&b).unwrap().worktree_path.unwrap());
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), r.staging);
}

/// Call site: card start refuses Held, an unlisted area and a card with
/// none, before any copy exists.
#[test]
fn a_start_is_refused_on_held_unknown_and_no_area_before_any_copy() {
    let r = repo();
    let b = board(&r, None);
    assert_eq!(start(&b).unwrap_err(), NEEDS_AREA);
    let set = |id: &str| {
        b.store
            .with_card(&b.ws, "c1", |c| {
                c.area = Some(id.into());
                Ok(())
            })
            .unwrap()
    };
    set("docs");
    assert!(start(&b).unwrap_err().contains("docs"));
    set("site");
    hold(&b.configs, &b.ws);
    assert!(start(&b).unwrap_err().contains("can't be used"));
    let c = b.store.get_card(&b.ws, "c1").unwrap();
    assert!(c.worktree_path.is_none() && c.column_id == KanbanColumnId::Todo, "nothing was made");
    assert!(!r.ws.join(".plyloft-worktrees").join("c1").exists());
}

/// Call site: the Board's Behind reading (and so Bring in main's changes'
/// offer) measures each card from its own area's branch
/// (`card_sync::report_by`).
#[test]
fn the_board_measures_each_card_from_its_area_s_branch() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let cards = vec![started];
    let target_of = |c: &KanbanCard| reading_branch(&b.configs, &b.ws, c);
    let report = crate::card_sync::report_by(&r.ws, "staging", &cards, &target_of);
    let sync = &report.cards["c1"];
    assert_eq!((sync.behind, sync.target.as_deref()), (0, Some("main")), "not behind main");
    // Against the workspace's staging it would read one behind.
    let workspace = crate::card_sync::report(&r.ws, "staging", &cards);
    assert_eq!((workspace.cards["c1"].behind, workspace.cards["c1"].target.as_deref()), (1, None));
}

/// *Leave those out*, on a real copy: the files outside the area go back to
/// the card's base (an edit restored, an added file removed, a deleted one
/// back) in one commit, the card's own file stays, and the checks' earlier
/// pass doesn't count for the new commit.
#[test]
fn leave_those_out_restores_the_files_and_needs_the_checks_again() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    write(&wt, "site/index.astro", "new home\n");
    write(&wt, "AGENTS.md", "changed rules\n");
    write(&wt, "app/new.py", "added\n");
    fs::remove_file(wt.join("app/main.py")).unwrap();
    git(&wt, &["add", "-A"]);
    git(&wt, &["commit", "-q", "-m", "card work"]);
    let before = git(&wt, &["rev-parse", "HEAD"]);
    let tree_before = git(&wt, &["rev-parse", "HEAD^{tree}"]);
    b.store
        .with_card(&b.ws, "c1", |c| {
            c.verify_history.push(VerifyEntry {
                verify_run_id: "v1".into(),
                status: VerifyStatus::Passed,
                ended_at: 1,
                summary: None,
                steps: Vec::new(),
                tree_sha: Some(tree_before.clone()),
            });
            c.verify_status = VerifyStatus::Passed;
            Ok(())
        })
        .unwrap();
    let card = b.store.get_card(&b.ws, "c1").unwrap();
    assert_eq!(crate::verify::verify_result_on(&tree_before, &card.verify_history), Some(true));

    let outside = outside_for(&b.configs, &b.ws, &card).unwrap();
    assert_eq!(
        outside.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["AGENTS.md", "app/main.py", "app/new.py"]
    );
    assert_eq!(outside.hint, "If they ship with this card, they reach main before the rest of App's work on staging.");

    let wanted: Vec<String> = outside.files.iter().map(|f| f.path.clone()).collect();
    let done = leave_out_card(&b.configs, &b.store, &b.ws, "c1", &wanted, false).unwrap();
    assert_eq!(done.left_out, wanted);
    assert!(!done.builder);
    let sha = done.sha.unwrap();
    assert_ne!(sha, before);
    assert_eq!(git(&wt, &["log", "-1", "--format=%s"]), "chore: leave out files outside Site");
    assert_eq!(git(&wt, &["rev-parse", "HEAD^"]), before, "one commit on top");
    assert_eq!(fs::read_to_string(wt.join("AGENTS.md")).unwrap(), "rules\n");
    assert_eq!(fs::read_to_string(wt.join("app/main.py")).unwrap(), "print(1)\n");
    assert!(!wt.join("app/new.py").exists());
    assert_eq!(fs::read_to_string(wt.join("site/index.astro")).unwrap(), "new home\n", "the card's own file stays");
    assert_eq!(git(&wt, &["status", "--porcelain"]), "", "nothing left uncommitted");
    // Nothing is outside any more.
    let card = b.store.get_card(&b.ws, "c1").unwrap();
    assert!(outside_for(&b.configs, &b.ws, &card).unwrap().files.is_empty());
    // Ship's gate: the pass on the old tree doesn't count for the new one,
    // so Ship waits for the checks to pass again.
    let tree = git(&wt, &["rev-parse", "HEAD^{tree}"]);
    assert_eq!(crate::verify::verify_result_on(&tree, &card.verify_history), None);
    // A second press finds nothing to leave out.
    let again = leave_out_card(&b.configs, &b.store, &b.ws, "c1", &wanted, false).unwrap();
    assert!(again.left_out.is_empty() && again.sha.is_none());
}

#[test]
fn leave_those_out_waits_for_the_builder_and_then_finish_and_check() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    write(&wt, "AGENTS.md", "changed\n");
    git(&wt, &["commit", "-q", "-am", "snapshot"]);
    b.store
        .with_card(&b.ws, "c1", |c| {
            c.builder = Some(serde_json::from_value(serde_json::json!({ "vendor": "claude", "snapshots": [] })).unwrap());
            c.last_run_status = Some(crate::kanban::LastRunStatus::Running);
            Ok(())
        })
        .unwrap();
    let wanted = paths(&["AGENTS.md"]);
    assert_eq!(leave_out_card(&b.configs, &b.store, &b.ws, "c1", &wanted, true).unwrap_err(), LEAVE_OUT_BUILDER_WORKING);
    write(&wt, "site/x", "unsaved\n");
    assert_eq!(leave_out_card(&b.configs, &b.store, &b.ws, "c1", &wanted, false).unwrap_err(), LEAVE_OUT_UNSAVED);
    fs::remove_file(wt.join("site/x")).unwrap();
    let done = leave_out_card(&b.configs, &b.store, &b.ws, "c1", &wanted, false).unwrap();
    assert!(done.builder && done.sha.is_some(), "Finish and check records it next");
    assert_eq!(fs::read_to_string(wt.join("AGENTS.md")).unwrap(), "rules\n");
}

/// Call site: a review and the outcome read the card's changes from its
/// area's base — `reading_branch` feeds `card_changed_file_count`.
#[test]
fn a_site_card_s_changes_are_counted_from_main() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    write(&wt, "site/index.astro", "new\n");
    git(&wt, &["commit", "-q", "-am", "card"]);
    let card = b.store.get_card(&b.ws, "c1").unwrap();
    let target = reading_branch(&b.configs, &b.ws, &card);
    assert_eq!(target, "main");
    assert_eq!(crate::worktrees::card_changed_file_count(&wt, card.worktree_base.as_ref(), &target), 1);
}

/// Call site: Ship's land here (`land_card_local`) merges a site card into
/// main while the workspace's target is staging; a card with no area lands
/// nowhere.
#[test]
fn ship_lands_a_site_card_on_main_and_refuses_one_without_an_area() {
    use tauri::Manager;
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    write(&wt, "site/index.astro", "shipped home\n");
    git(&wt, &["commit", "-q", "-am", "site work"]);
    let publish = git(&wt, &["rev-parse", "HEAD"]);
    let (ws, store, workspaces, configs) = (b.ws.clone(), b.store, b.workspaces, b.configs);
    let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.manage(workspaces);
    app.manage(store);
    app.manage(configs);
    let handle = app.handle();
    let land = || {
        crate::commands::land_card_local(
            handle,
            &handle.state::<crate::workspace::WorkspaceStore>(),
            &handle.state::<KanbanStore>(),
            &handle.state::<ProjectConfigStore>(),
            &ws,
            "c1",
            Some(publish.as_str()),
        )
    };
    let staging = git(&r.ws, &["rev-parse", "staging"]);
    // No area chosen: nothing lands, on either branch.
    handle
        .state::<KanbanStore>()
        .with_card(&ws, "c1", |c| {
            c.area = None;
            Ok(())
        })
        .unwrap();
    assert_eq!(land().unwrap_err().to_string(), NEEDS_AREA);
    assert_eq!(git(&r.ws, &["rev-parse", "main"]), r.main);
    handle
        .state::<KanbanStore>()
        .with_card(&ws, "c1", |c| {
            c.area = Some("site".into());
            Ok(())
        })
        .unwrap();
    let res = land().unwrap();
    assert!(res.merged, "{res:?}");
    assert_ne!(git(&r.ws, &["rev-parse", "main"]), r.main, "main moved");
    assert_eq!(fs::read_to_string(r.ws.join("site/index.astro")).unwrap(), "shipped home\n");
    assert_eq!(git(&r.ws, &["rev-parse", "staging"]), staging, "staging untouched");
}

// ── Challenger round 1 ─────────────────────────────────────────────────

/// A card whose copy was cut from `branch` (as `ensure_for_card` records it).
fn cut(mut c: KanbanCard, branch: &str) -> KanbanCard {
    c.worktree_path = Some("/tmp/wt-c1".into());
    c.branch_name = Some("plyloft/card-c1".into());
    c.worktree_base = Some(serde_json::from_value(serde_json::json!({
        "commit": "abc", "refName": format!("origin/{branch}"), "source": "origin"
    })).unwrap());
    c
}

/// Challenger 3: a started card — a Todo one with a copy too — keeps its
/// area; one with none to choose chooses only an area whose cards go to the
/// branch its copy was cut from.
#[test]
fn a_started_card_chooses_only_an_area_of_the_branch_it_was_cut_from() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("p")).unwrap();
    let kanban = KanbanStore::new(dir.path().join("k")).unwrap();
    with_areas(&store, WS, "develop", &two());
    // Put back in Not started with its copy: started, its area stays.
    kanban.create_card(WS, cut(card(Some("site")), "main")).unwrap();
    let s = state_for(&store, WS, &kanban.get_card(WS, "c1").unwrap());
    assert_eq!((s.kind.as_str(), s.editable), ("area", false));
    assert!(set_area(&store, &kanban, WS, "c1", "app").is_err());
    // No area, cut from main: Site fits, App (staging) doesn't.
    kanban.with_card(WS, "c1", |c| { c.area = None; Ok(()) }).unwrap();
    let s = state_for(&store, WS, &kanban.get_card(WS, "c1").unwrap());
    assert_eq!((s.kind.as_str(), s.fits.clone()), ("needsArea", vec!["site".to_string()]));
    assert_eq!(
        set_area(&store, &kanban, WS, "c1", "app").unwrap_err(),
        "This card's copy started from main, and App cards go to staging. Choose an area whose cards go to main."
    );
    assert_eq!(set_area(&store, &kanban, WS, "c1", "site").unwrap().area.as_deref(), Some("site"));
    // A card with no copy may take any area.
    let s = state_for(&store, WS, &card(None));
    assert_eq!(s.fits, vec!["app".to_string(), "site".to_string()]);
    // Cut from a branch no area's cards go to: nothing fits, and it says so.
    let s = state_for(&store, WS, &cut(card(None), "develop"));
    assert!(s.fits.is_empty());
    assert_eq!(
        s.sentence.as_deref(),
        Some("This card's copy started from develop, and no area's cards go there. Delete it and make the card again in its area.")
    );
}

/// Challenger 4: a Done, archived or shipped card that never had an area
/// says nothing about areas.
#[test]
fn a_finished_card_without_an_area_shows_nothing() {
    let (_dir, store) = store();
    with_areas(&store, WS, "develop", &two());
    let mut done = card(None);
    done.column_id = KanbanColumnId::Complete;
    assert_eq!(state_for(&store, WS, &done).kind, "none");
    let mut archived = card(None);
    archived.archived = true;
    assert_eq!(state_for(&store, WS, &archived).kind, "none");
    let mut shipped = card(None);
    shipped.ship_status = crate::kanban::ShipStatus::Shipped;
    assert_eq!(state_for(&store, WS, &shipped).kind, "none");
    done.area = Some("site".into());
    assert_eq!(state_for(&store, WS, &done).kind, "area", "one with an area still says it");
}

/// Challenger 9: a skill card a Builder starts on is stamped as the
/// workspace's: it ships there, choosing no area; nobody can choose that id.
#[test]
fn a_skill_card_that_started_building_ships_to_the_workspace_s_branch() {
    let (_dir, store) = store();
    with_areas(&store, WS, "develop", &two());
    let mut c = card(None);
    stamp_started_skill_card(&mut c);
    assert_eq!(c.area.as_deref(), Some(crate::areas::IMPLICIT_AREA_ID));
    assert!(exempt(&c));
    assert_eq!(branch_for_card(&store, WS, &c).unwrap(), "develop");
    assert_eq!(state_for(&store, WS, &c).kind, "none");
    assert!(area_for_new_card(&store, WS, Some("default")).is_err());
    let mut kept = card(Some("site"));
    stamp_started_skill_card(&mut kept);
    assert_eq!(kept.area.as_deref(), Some("site"), "an area it has stays");
}

/// Challenger 7: two builds and no pick — no sheet, and Leave those out is
/// refused in Build with both's words.
#[test]
fn an_undecided_build_with_both_card_asks_nothing_and_leaves_nothing_out() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("p")).unwrap();
    let kanban = KanbanStore::new(dir.path().join("k")).unwrap();
    with_areas(&store, WS, "develop", &two());
    let mut c = card(Some("site"));
    c.build_both = Some(serde_json::from_value(serde_json::json!({ "lanes": [] })).unwrap());
    assert!(crate::build_both::is_undecided(&c));
    assert!(outside_for(&store, WS, &c).is_none());
    kanban.create_card(WS, c).unwrap();
    assert_eq!(
        leave_out_card(&store, &kanban, WS, "c1", &paths(&["AGENTS.md"]), false).unwrap_err(),
        crate::build_both::UNDECIDED_REFUSAL
    );
}

/// Challenger 6 and 5: a rename across the area's edge is named as a pair
/// and goes back whole; Leave those out commits only those files — what
/// else is staged in the copy stays staged.
#[test]
fn a_rename_out_of_another_area_goes_back_whole_and_nothing_else_is_committed() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    git(&wt, &["mv", "app/main.py", "site/main.py"]);
    git(&wt, &["commit", "-q", "-m", "move"]);
    write(&wt, "site/staged.txt", "mine\n");
    git(&wt, &["add", "site/staged.txt"]);
    let card = b.store.get_card(&b.ws, "c1").unwrap();
    let out = outside_for(&b.configs, &b.ws, &card).unwrap();
    assert_eq!(out.files.len(), 1, "{:?}", out.files);
    let f = &out.files[0];
    assert_eq!((f.path.as_str(), f.from.as_deref(), f.belongs.as_str()), ("site/main.py", Some("app/main.py"), WHOLE_REPOSITORY));
    let done = leave_out_card(&b.configs, &b.store, &b.ws, "c1", &[f.path.clone()], false).unwrap();
    assert_eq!(done.left_out, paths(&["app/main.py", "site/main.py"]));
    assert!(done.sha.is_some());
    assert_eq!(fs::read_to_string(wt.join("app/main.py")).unwrap(), "print(1)\n");
    assert!(!wt.join("site/main.py").exists());
    // Committed: only the two; the staged file is still staged, not committed.
    let committed = git(&wt, &["show", "--no-renames", "--name-only", "--format=", "HEAD"]);
    assert_eq!(committed.lines().collect::<Vec<_>>(), vec!["app/main.py", "site/main.py"]);
    assert_eq!(git(&wt, &["status", "--porcelain"]), "A  site/staged.txt");
}

/// Challenger 5: an uncommitted edit put back has nothing to commit — told
/// apart from nothing outside by `left_out` with no commit.
#[test]
fn putting_back_an_uncommitted_edit_commits_nothing() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    write(&wt, "AGENTS.md", "edited, not committed\n");
    let before = git(&wt, &["rev-parse", "HEAD"]);
    let done = leave_out_card(&b.configs, &b.store, &b.ws, "c1", &paths(&["AGENTS.md"]), false).unwrap();
    assert_eq!((done.left_out, done.sha), (paths(&["AGENTS.md"]), None));
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), before);
    assert_eq!(fs::read_to_string(wt.join("AGENTS.md")).unwrap(), "rules\n");
}

// ── Challenger round 2 ─────────────────────────────────────────────────

/// A card made from a started skill card (a follow-up, an implementation
/// card) doesn't take its "default" stamp: in a repository with two areas
/// it asks which area it is.
#[test]
fn a_follow_up_of_a_started_skill_card_chooses_its_area() {
    let (_dir, store) = store();
    with_areas(&store, WS, "develop", &two());
    let mut skill = card(None);
    stamp_started_skill_card(&mut skill);
    assert_eq!(inherited_area(&skill), None);
    let mut follow = card(None);
    follow.area = inherited_area(&skill);
    assert_eq!(resolve(&store, WS, &follow), Some(CardArea::NeedsArea));
    assert_eq!(inherited_area(&card(Some("site"))).as_deref(), Some("site"));
}

/// The follow-up path itself: `ensure_follow_up_card` on a stamped card.
#[test]
fn ship_with_follow_up_of_a_stamped_card_makes_one_without_an_area() {
    let dir = tempfile::tempdir().unwrap();
    let kanban = KanbanStore::new(dir.path().join("k")).unwrap();
    let mut c: KanbanCard = serde_json::from_str(
        r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0,
            "builder":{"vendor":"claude","snapshots":[{"n":1,"sha":"s1","at":0}]}}"#,
    )
    .unwrap();
    stamp_started_skill_card(&mut c);
    kanban.create_card(WS, c).unwrap();
    let finding = crate::review_ledger::LedgerFinding { id: "F1".into(), severity: Some("P2".into()), ..Default::default() };
    let follow = crate::commands::ensure_follow_up_card(&kanban, WS, "c1", &[&finding], "Follow-up: t", "brief", None, None).unwrap();
    assert_eq!(kanban.get_card(WS, &follow.card_id).unwrap().area, None);
}

/// Leave those out commits the file it names, never what its name matches
/// as a pattern.
#[test]
fn leave_those_out_reads_file_names_literally() {
    let r = repo();
    let b = board(&r, Some("site"));
    let started = start(&b).unwrap();
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    identity(&wt);
    write(&wt, "app/a[1].txt", "outside\n");
    git(&wt, &["add", "app/a[1].txt"]);
    git(&wt, &["commit", "-q", "-m", "card"]);
    // Staged, and matched by `app/a[1].txt` as a pattern.
    write(&wt, "app/a1.txt", "staged, mine\n");
    git(&wt, &["add", "app/a1.txt"]);
    let done = leave_out_card(&b.configs, &b.store, &b.ws, "c1", &paths(&["app/a[1].txt"]), false).unwrap();
    assert!(done.sha.is_some());
    let committed = git(&wt, &["show", "--no-renames", "--name-only", "--format=", "HEAD"]);
    assert_eq!(committed, "app/a[1].txt");
    assert!(!wt.join("app/a[1].txt").exists());
    assert_eq!(git(&wt, &["status", "--porcelain"]), "A  app/a1.txt");
}

/// 1.174.0 (C10 walk, step 13): a project not set up yet (no build
/// settings), its areas kept on this Mac only — the walk's solo sandbox. A
/// card made in Site says so; one made on All areas is asked.
#[test]
fn a_project_not_set_up_with_areas_kept_here_says_each_card_s_area() {
    let (_dir2, bare) = store();
    let (_dir, store) = store();
    assert!(store.get(WS).is_none(), "no build settings");
    crate::areas::save_local(&store, WS, &two()).unwrap();
    let site = state_for(&store, WS, &card(Some("site")));
    assert_eq!(site.kind, "area");
    assert_eq!(site.area.as_ref().map(|a| a.id.as_str()), Some("site"));
    assert!(site.editable);
    let asked = state_for(&store, WS, &card(None));
    assert_eq!(asked.kind, "needsArea");
    assert_eq!(asked.sentence.as_deref(), Some("Which area is this?"));
    assert_eq!(asked.areas.len(), 2);
    // Without areas, nothing is said.
    assert_eq!(state_for(&bare, WS, &card(Some("site"))).kind, "none");
}

/// C10 walk, Challenger round 2: on a project not set up yet, the area its
/// line offers is one `set_area` takes; Start still says it isn't set up.
#[test]
fn a_project_not_set_up_chooses_an_area_and_start_still_says_not_set_up() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("p")).unwrap();
    let kanban = KanbanStore::new(dir.path().join("k")).unwrap();
    crate::areas::save_local(&store, WS, &two()).unwrap();
    kanban.create_card(WS, card(None)).unwrap();
    let chosen = set_area(&store, &kanban, WS, "c1", "site").unwrap();
    assert_eq!(chosen.area.as_deref(), Some("site"));
    // Start and Ship read the project's own settings: none yet.
    assert_eq!(config_for_card(&store, WS, &chosen), Ok(None));
    assert!(resolve(&store, WS, &chosen).is_none());
}

/// Not set up, areas with no branch of their own: a started card's copy has
/// no project branch to be held against — every area fits, and is taken.
#[test]
fn a_project_not_set_up_holds_no_copy_against_a_branch() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("p")).unwrap();
    let kanban = KanbanStore::new(dir.path().join("k")).unwrap();
    let plain = vec![area("app", "App", "/", None), area("site", "Site", "site/", None)];
    crate::areas::save_local(&store, WS, &plain).unwrap();
    kanban.create_card(WS, cut(card(None), "main")).unwrap();
    let s = state_for(&store, WS, &kanban.get_card(WS, "c1").unwrap());
    assert_eq!(s.kind, "needsArea");
    assert_eq!(s.fits, vec!["app".to_string(), "site".to_string()]);
    assert_eq!(s.sentence.as_deref(), Some("Which area is this?"));
    assert!(s.areas.iter().all(|a| a.branch.is_empty()), "the page says the project's branch");
    assert_eq!(set_area(&store, &kanban, WS, "c1", "app").unwrap().area.as_deref(), Some("app"));
}

// ── 1.175.0 (C5 round 2): no card starts from a branch gone from GitHub ──

/// "Until then no card can start" is true: the card's own config refuses
/// with the Board notice's words while the shared setup's branch is gone,
/// and lets go once it isn't. A card of another branch (an area's) isn't held.
#[test]
fn c5r2_a_card_of_a_branch_gone_from_github_doesnt_start_or_ship() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("p")).unwrap();
    store.set(WS, config("staging")).unwrap();
    let mut cache = crate::workspace_definition::DefinitionCache::empty();
    cache.definition = Some(serde_json::from_str(r#"{ "name": "Ply" }"#).unwrap());
    cache.branch = Some("staging".into());
    crate::workspace_definition::save_cache(&store, WS, &cache).unwrap();
    assert!(config_for_card(&store, WS, &card(None)).unwrap().is_some(), "not gone: it starts");

    cache.branch_gone = Some(crate::workspace_definition::BranchGone { branch: "staging".into(), renamed_to: None });
    crate::workspace_definition::save_cache(&store, WS, &cache).unwrap();
    let why = config_for_card(&store, WS, &card(None)).unwrap_err();
    assert!(why.starts_with("staging isn't on GitHub any more.") && why.ends_with("Until then no card can start."), "{why}");
    assert_eq!(branch_for_card(&store, WS, &card(None)).unwrap_err(), why, "Ship reads the same");
    assert!(config_for_card(&store, WS, &review_card()).is_err(), "a review card too");
    assert_eq!(crate::move_shared_setup::branch_gone_refusal(&store, WS, "staging"), Some(why));
    assert_eq!(crate::move_shared_setup::branch_gone_refusal(&store, WS, "main"), None, "another branch isn't held");

    cache.branch_gone = Some(crate::workspace_definition::BranchGone { branch: "staging".into(), renamed_to: Some("develop".into()) });
    crate::workspace_definition::save_cache(&store, WS, &cache).unwrap();
    let why = config_for_card(&store, WS, &card(None)).unwrap_err();
    assert!(why.starts_with("staging is called develop on GitHub now."), "{why}");

    cache.branch_gone = None;
    crate::workspace_definition::save_cache(&store, WS, &cache).unwrap();
    assert!(config_for_card(&store, WS, &card(None)).is_ok());
}
