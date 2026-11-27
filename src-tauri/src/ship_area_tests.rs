//! 1.173.0 (B4): versions and releases per area — tags `<prefix>vX.Y.Z`,
//! the release branch `plyloft/release-<prefix>vX.Y.Z`, only the area's
//! version files, one area per release. A repository without areas tags,
//! names and writes exactly as before.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use super::*;
use crate::areas::AreaDef;
use crate::card_area::CardArea;
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, VerifyStatus};
use crate::project_config::{ProjectConfig, ProjectConfigStore, VersionFileEntry, VersionFileKind};
use crate::workspace::WorkspaceStore;

fn package_json(path: &str) -> VersionFileEntry {
    VersionFileEntry { path: path.into(), kind: VersionFileKind::PackageJson, variable_name: None }
}

fn area(id: &str, name: &str, path: &str, files: Option<&[&str]>) -> AreaDef {
    AreaDef {
        id: id.into(),
        name: name.into(),
        path: path.into(),
        version_files: files.map(|f| f.iter().map(|p| package_json(p)).collect()),
        ..Default::default()
    }
}

/// The walk's sandbox: the app at the root (the workspace's version file),
/// the site in `site/` with its own.
fn app_and_site() -> Vec<AreaDef> {
    vec![area("app", "App", "/", None), area("site", "Site", "site/", Some(&["site/package.json"]))]
}

fn config() -> ProjectConfig {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 2,
        "targetBranch": "main",
        "versionFiles": [{ "path": "package.json", "kind": "package_json" }],
        "createdAt": 0,
        "updatedAt": 0,
    }))
    .unwrap()
}

fn card(id: &str, area: Option<&str>) -> KanbanCard {
    let mut c = KanbanCard::new(id.into(), "ws".into(), id.into(), None, KanbanColumnId::Complete);
    c.area = area.map(str::to_string);
    c
}

fn resolved(areas: &[AreaDef], c: &KanbanCard) -> Result<ShipArea, String> {
    ship_area_of(crate::card_area::resolve_with(&config(), areas, None, c), areas)
}

// ── Tags ───────────────────────────────────────────────────────────────

#[test]
fn a_tag_round_trips_for_every_prefix() {
    for (prefix, tag) in [("", "v1.2.3"), ("site-", "site-v1.2.3"), ("docs/", "docs/v1.2.3")] {
        assert_eq!(crate::areas::tag_for(prefix, "1.2.3"), tag);
        assert_eq!(tag_version(prefix, tag), Some("1.2.3"));
    }
    // A skip-verify ship's tag reads as it always did.
    assert_eq!(tag_version("", "v1.2.3-unverified"), Some("1.2.3-unverified"));
    assert_eq!(tag_version("site-", "site-v1.2.3-unverified"), Some("1.2.3-unverified"));
}

#[test]
fn another_area_s_tag_is_never_read_as_the_first_area_s() {
    assert_eq!(tag_version("", "vendor-v1.0.0"), None);
    assert_eq!(tag_version("", "site-v1.0.0"), None);
    assert_eq!(tag_version("site-", "v1.0.0"), None);
    assert_eq!(tag_version("site-", "website-v1.0.0"), None);
    // Strict (Challenger round 1): a pre-release is no release; only a
    // skip-verify ship's exact `-unverified` is read.
    assert_eq!(tag_version("site-", "site-v1.0.0-rc1"), None);
    assert_eq!(tag_version("", "v1.0.0-rc1"), None);
    assert_eq!(tag_version("", "v1.0.0-unverified-x"), None);
    assert_eq!(tag_version("", "v1.0"), None);
    let areas = vec![area("app", "App", "/", None), area("vendor", "Vendor", "vendor/", Some(&["vendor/package.json"]))];
    assert_eq!(area_of_tag(&areas, "main", "vendor-v1.0.0").unwrap().as_deref(), Some("vendor"));
    assert_eq!(area_of_tag(&areas, "main", "v1.0.0").unwrap().as_deref(), Some("app"));
    assert!(area_of_tag(&areas, "main", "docs-v1.0.0").unwrap_err().contains("docs-v1.0.0"));
    // No areas: every tag is the workspace's.
    assert_eq!(area_of_tag(&[], "main", "v1.0.0").unwrap(), None);
}

#[test]
fn the_latest_tag_is_the_area_s_own() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let git = |args: &[&str]| {
        let ok = crate::platform::git_command().args(args).current_dir(repo).status().unwrap();
        assert!(ok.success(), "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    git(&["config", "commit.gpgsign", "false"]);
    git(&["commit", "--allow-empty", "-q", "-m", "init"]);
    for tag in ["v1.0.0", "site-v3.0.1", "site-v3.0.0", "vendor-v9.0.0", "v2-v8.0.0", "website-v7.0.0", "site-v9.0.0-rc1", "v9.0.0-beta"] {
        git(&["tag", tag]);
    }
    assert_eq!(latest_version_tag(repo, "").as_deref(), Some("1.0.0"), "vendor-v9, v2-v8 are no app tags");
    assert_eq!(latest_version_tag(repo, "site-").as_deref(), Some("3.0.1"));
    assert_eq!(latest_version_tag(repo, "vendor-").as_deref(), Some("9.0.0"));
    assert_eq!(latest_version_tag(repo, "docs-"), None);
    assert!(tag_exists(repo, "site-v3.0.1").unwrap());
    assert!(!tag_exists(repo, "v3.0.1").unwrap(), "the site's version is not the app's");
}

// ── Version files ──────────────────────────────────────────────────────

#[test]
fn an_area_after_the_first_without_version_files_is_refused() {
    let areas = vec![area("app", "App", "/", None), area("site", "Site", "site/", None)];
    assert_eq!(
        resolved(&areas, &card("c", Some("site"))).unwrap_err(),
        "Site has no version file of its own. Add one in Settings › Project › Areas."
    );
    // An empty list is none either.
    let areas = vec![area("app", "App", "/", None), area("site", "Site", "site/", Some(&[]))];
    assert!(resolved(&areas, &card("c", Some("site"))).unwrap_err().starts_with("Site has no version file"));
}

#[test]
fn each_area_writes_only_its_own_version_files() {
    let areas = app_and_site();
    let site = resolved(&areas, &card("c", Some("site"))).unwrap();
    assert_eq!(site.prefix, "site-");
    assert_eq!(site.tag("3.0.2"), "site-v3.0.2");
    assert_eq!(site.config.version_files, vec![package_json("site/package.json")]);
    assert_eq!(site.name.as_deref(), Some("Site"));
    // The first area without files of its own writes the workspace's.
    let app = resolved(&areas, &card("c", Some("app"))).unwrap();
    assert_eq!(app.prefix, "");
    assert_eq!(app.tag("1.300.1"), "v1.300.1");
    assert_eq!(app.config.version_files, vec![package_json("package.json")]);
}

#[test]
fn the_first_area_never_writes_another_area_s_version_file() {
    let mut cfg = config();
    cfg.version_files.push(package_json("./site/package.json"));
    let areas = app_and_site();
    let got = ship_area_of(crate::card_area::resolve_with(&cfg, &areas, None, &card("c", Some("app"))), &areas);
    assert_eq!(
        got.unwrap_err(),
        "./site/package.json is Site's version file, so a release of App can't write it. Give App a version file of its own in Settings › Project › Areas."
    );
}

#[test]
fn a_card_exempt_from_choosing_releases_as_the_first_area() {
    let areas = app_and_site();
    let mut review = card("r", None);
    review.pr_review = Some(Default::default());
    let got = resolved(&areas, &review).unwrap();
    assert_eq!((got.id.as_deref(), got.prefix.as_str()), (Some("app"), ""));
    assert_eq!(got.config.version_files, vec![package_json("package.json")]);
    // With an app card, one batch: the same area.
    let app = card("a", Some("app"));
    assert_eq!(batch_ship_area(&[&review, &app], |k| resolved(&areas, k)).unwrap().id.as_deref(), Some("app"));
    // Without areas, the workspace's as before.
    assert_eq!(resolved(&[], &review).unwrap().id, None);
}

#[test]
fn held_unknown_and_no_area_refuse_the_release() {
    let areas = app_and_site();
    let held = ship_area_of(CardArea::Held { problem: "Two areas share the folder site/.".into() }, &areas);
    assert_eq!(
        held.unwrap_err(),
        "This repository's areas can't be used: Two areas share the folder site/. Fix them in Settings › Project › Areas."
    );
    assert!(resolved(&areas, &card("c", Some("docs"))).unwrap_err().contains("docs"));
    assert_eq!(resolved(&areas, &card("c", None)).unwrap_err(), crate::card_area::NEEDS_AREA);
}

// ── One area per batch ─────────────────────────────────────────────────

#[test]
fn a_batch_is_one_area() {
    let areas = app_and_site();
    let (a, b, c) = (card("a", Some("site")), card("b", Some("site")), card("c", Some("app")));
    let of = |k: &KanbanCard| resolved(&areas, k);
    let site = batch_ship_area(&[&a, &b], of).unwrap();
    assert_eq!(site.prefix, "site-");
    assert_eq!(
        batch_ship_area(&[&a, &c, &b], of).unwrap_err(),
        "These cards are in different areas (Site, App). Release one area at a time. Nothing was shipped."
    );
    // A card the area refuses is said as it is.
    let none = card("d", None);
    assert_eq!(batch_ship_area(&[&a, &none], of).unwrap_err(), crate::card_area::NEEDS_AREA);
}

// ── Release branches ───────────────────────────────────────────────────

#[test]
fn release_branches_carry_the_area_s_prefix() {
    assert_eq!(release_pr::branch_for("", "1.0.1"), "plyloft/release-v1.0.1");
    assert_eq!(release_pr::branch_for("site-", "1.0.1"), "plyloft/release-site-v1.0.1");
    for branch in ["plyloft/release-v1.0.1", "plyloft/release-site-v1.0.1", "plyloft/release-v1.0.1-unverified"] {
        assert!(release_pr::is_release_branch(branch), "{branch}");
    }
    for branch in ["main", "plyloft/release-notes", "plyloft/release-", "plyloft/card-1-x", "release-v1.0.1"] {
        assert!(!release_pr::is_release_branch(branch), "{branch}");
    }
    let mut record = crate::release_record::PendingRelease {
        version: "3.0.2".into(),
        tag: "site-v3.0.2".into(),
        commit_sha: String::new(),
        branch: "main".into(),
        card_ids: vec![],
        card_revs: Default::default(),
        release_kind: crate::kanban::ReleaseKind::PushOnly,
        skip_verify: false,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: 0,
        stage: crate::release_record::RecordStage::Committing,
        start_commit: None,
        protected: false,
        tag_pushed: false,
        pr: None,
        merged_card_ids: Vec::new(),
        since_tag: None,
        other_changes: 0,
        stop_requested: false,
    };
    assert_eq!(release_pr::prefix_of(&record), "site-");
    record.tag = "v3.0.2".into();
    assert_eq!(release_pr::prefix_of(&record), "");
}

// ── No areas: byte for byte ────────────────────────────────────────────

#[test]
fn a_repository_without_areas_releases_exactly_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    store.set("ws", config()).unwrap();
    for c in [card("c", None), card("c", Some("site"))] {
        // Not shared, or shared without areas: the workspace's config, `v`.
        for shared in [false, true] {
            if shared {
                crate::team_models::share_for_test(&store, "ws", false);
            }
            match ship_area_for_card(&store, "ws", &c) {
                Ok(Some(area)) => {
                    assert!(c.area.is_none());
                    assert_eq!(area, ShipArea { config: store.get("ws").unwrap(), prefix: String::new(), id: None, name: None });
                    assert_eq!(area.tag("1.0.1"), "v1.0.1");
                    assert_eq!(release_pr::branch_for(&area.prefix, "1.0.1"), "plyloft/release-v1.0.1");
                }
                // A card naming an area the repository doesn't have (B3).
                Err(why) => assert!(c.area.is_some() && why.contains("site"), "{why}"),
                Ok(None) => panic!("set up"),
            }
        }
    }
    assert_eq!(ship_area_for_tag(&store, "ws", "v1.0.1").unwrap().unwrap().prefix, "");
    assert_eq!(crate::commit_message::release_tag_subject("v1.0.1"), "chore(release): v1.0.1");
}

// ── Ship now and Ship batch, end to end ────────────────────────────────

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command().args(args).current_dir(cwd).output().expect("spawn git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

struct Fixture {
    _shell_env: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    ws: PathBuf,
    ws_id: String,
}

impl Fixture {
    /// One repository: the app at the root (`package.json` 1.0.0, tag
    /// v1.0.0), the site in `site/` (`site/package.json` 3.0.1, tag
    /// site-v3.0.1); `cards` are (id, area, file it writes).
    fn new(areas: &[AreaDef], cards: &[(&str, &str, &str)]) -> Self {
        let shell_env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir(&ws).unwrap();
        git(&ws, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.email", "t@ply.test"), ("user.name", "ply-test"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(&ws, &["config", k, v]);
        }
        write(&ws, "package.json", "{\n  \"name\": \"app\",\n  \"version\": \"1.0.0\"\n}\n");
        write(&ws, "site/package.json", "{\n  \"name\": \"site\",\n  \"version\": \"3.0.1\"\n}\n");
        write(&ws, ".gitignore", ".atelier-worktrees/\n.plyloft-worktrees/\n");
        git(&ws, &["add", "."]);
        git(&ws, &["commit", "-q", "-m", "base"]);
        git(&ws, &["tag", "v1.0.0"]);
        git(&ws, &["tag", "site-v3.0.1"]);

        let config_dir = tmp.path().join("config");
        let workspaces = WorkspaceStore::new(config_dir.join("workspaces")).unwrap();
        let kanban = KanbanStore::new(config_dir.join("kanban")).unwrap();
        let project_config = ProjectConfigStore::new(config_dir.join("project")).unwrap();
        let ws_id = workspaces.create("Mono".into(), ws.to_string_lossy().into_owned()).unwrap().id;
        project_config.set(&ws_id, config()).unwrap();
        if !areas.is_empty() {
            crate::team_models::share_for_test(&project_config, &ws_id, false);
            crate::areas::save(&project_config, &ws_id, areas).unwrap();
        }
        for (id, area, file) in cards {
            let made = crate::worktrees::ensure_for_card(&ws, id, id, "main").unwrap();
            for (k, v) in [("user.email", "t@ply.test"), ("user.name", "ply-test"), ("commit.gpgsign", "false")] {
                git(&made.worktree_path, &["config", k, v]);
            }
            write(&made.worktree_path, file, &format!("{id}\n"));
            git(&made.worktree_path, &["add", file]);
            git(&made.worktree_path, &["commit", "-q", "-m", "card work"]);
            let mut c = KanbanCard::new(id.to_string(), ws_id.clone(), id.to_string(), None, KanbanColumnId::Complete);
            c.area = (!area.is_empty()).then(|| area.to_string());
            c.worktree_path = Some(made.worktree_path.to_string_lossy().into_owned());
            c.branch_name = Some(made.branch_name.clone());
            c.verify_status = VerifyStatus::Passed;
            kanban.create_card(&ws_id, c).unwrap();
        }
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        app.manage(workspaces);
        app.manage(kanban);
        app.manage(project_config);
        Self { _shell_env: shell_env, _tmp: tmp, app, ws, ws_id }
    }

    fn ship_now(&self, card_id: &str, version: &str) -> Result<ShipResult, crate::worktrees::ShipError> {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        let h = self.app.handle();
        ship_card(
            h,
            ShipRequest {
                workspace_id: self.ws_id.clone(),
                card_id: card_id.into(),
                release_kind: crate::kanban::ReleaseKind::Local,
                version: version.into(),
                skip_verify: false,
            },
            &h.state::<WorkspaceStore>(),
            &h.state::<KanbanStore>(),
            &ShipRegistry::default(),
            &h.state::<ProjectConfigStore>(),
            &crate::swarms::SwarmRegistry::new(p.join("swarms")).unwrap(),
            &crate::intake::IntakeRegistry::default(),
            &crate::agents::AgentRegistry::new(&p.join("agents")).unwrap(),
            &crate::pty::PtyRegistry::default(),
            &crate::reviewer::ReviewerRegistry::new(p.join("reviews")).unwrap(),
            &crate::discussion::DiscussionRegistry::new(p.join("discussions"), None).unwrap(),
            &crate::coordination::CoordinationRegistry::new(p.join("coordination")).unwrap(),
        )
    }

    fn ship_batch(&self, card_ids: &[&str], version: &str) -> Result<ShipResult, crate::worktrees::ShipError> {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        let h = self.app.handle();
        ship_batch(
            h,
            ShipBatchRequest {
                workspace_id: self.ws_id.clone(),
                card_ids: card_ids.iter().map(|s| s.to_string()).collect(),
                release_kind: crate::kanban::ReleaseKind::Local,
                version: version.into(),
            },
            &h.state::<WorkspaceStore>(),
            &h.state::<KanbanStore>(),
            &ShipRegistry::default(),
            &h.state::<ProjectConfigStore>(),
            &crate::reviewer::ReviewerRegistry::new(p.join("reviews")).unwrap(),
            &crate::discussion::DiscussionRegistry::new(p.join("discussions"), None).unwrap(),
            &crate::coordination::CoordinationRegistry::new(p.join("coordination")).unwrap(),
        )
    }

    fn audit(&self, asked: AuditFor<'_>) -> ShipAuditReport {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        let h = self.app.handle();
        ship_audit_for(
            &h.state::<WorkspaceStore>(),
            &crate::swarms::SwarmRegistry::new(p.join("swarms")).unwrap(),
            &crate::intake::IntakeRegistry::default(),
            &crate::agents::AgentRegistry::new(&p.join("agents")).unwrap(),
            &ShipRegistry::default(),
            &h.state::<KanbanStore>(),
            &h.state::<ProjectConfigStore>(),
            Some(&self.ws_id),
            asked,
        )
        .unwrap()
    }

    fn version_of(&self, file: &str) -> String {
        let body = fs::read_to_string(self.ws.join(file)).unwrap();
        read_json_version_in(&body).unwrap()
    }

    fn tags(&self) -> Vec<String> {
        let mut tags: Vec<String> = git(&self.ws, &["tag", "--list"]).lines().map(str::to_string).collect();
        tags.sort();
        tags
    }
}

#[test]
fn ship_now_of_a_site_card_tags_the_site_and_leaves_the_app_as_it_is() {
    let fx = Fixture::new(&app_and_site(), &[("site-card", "site", "site/page.txt")]);
    let audit = fx.audit(AuditFor { card_id: Some("site-card"), area: None });
    assert_eq!((audit.current_version.as_str(), audit.suggested_next_version.as_str()), ("3.0.1", "3.0.2"));
    assert_eq!((audit.area.name.as_deref(), audit.area.tag_prefix.as_str(), audit.area.refusal.as_deref()), (Some("Site"), "site-", None));

    let result = fx.ship_now("site-card", "3.0.2").expect("the site ships");
    assert_eq!(result.tag.as_deref(), Some("site-v3.0.2"));
    assert_eq!(fx.tags(), vec!["site-v3.0.1", "site-v3.0.2", "v1.0.0"]);
    assert_eq!(fx.version_of("site/package.json"), "3.0.2");
    assert_eq!(fx.version_of("package.json"), "1.0.0", "the app's version is untouched");
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "chore(release): site-v3.0.2");
    assert!(fx.ws.join("site/page.txt").exists());
    // The card records the release's own tag (the card page and Board say it).
    let shipped = fx.app.state::<KanbanStore>().get_card(&fx.ws_id, "site-card").unwrap();
    assert_eq!(shipped.ship_history.last().and_then(|e| e.tag.as_deref()), Some("site-v3.0.2"));
}

#[test]
fn ship_now_of_an_area_without_version_files_is_refused_with_nothing_changed() {
    let areas = vec![area("app", "App", "/", None), area("site", "Site", "site/", None)];
    let fx = Fixture::new(&areas, &[("site-card", "site", "site/page.txt")]);
    let before = git(&fx.ws, &["rev-parse", "HEAD"]);
    let audit = fx.audit(AuditFor { card_id: Some("site-card"), area: None });
    assert_eq!(audit.area.refusal.as_deref(), Some("Site has no version file of its own. Add one in Settings › Project › Areas."));
    let err = fx.ship_now("site-card", "3.0.2").unwrap_err();
    assert_eq!(err.to_string(), "Site has no version file of its own. Add one in Settings › Project › Areas.");
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD"]), before);
    assert_eq!(fx.tags(), vec!["site-v3.0.1", "v1.0.0"]);
}

#[test]
fn ship_batch_releases_one_area_at_a_time() {
    let fx = Fixture::new(
        &app_and_site(),
        &[("s1", "site", "site/a.txt"), ("s2", "site", "site/b.txt"), ("a1", "app", "app.txt")],
    );
    let err = fx.ship_batch(&["s1", "a1"], "3.0.2").unwrap_err();
    assert_eq!(err.to_string(), "These cards are in different areas (Site, App). Release one area at a time. Nothing was shipped.");
    assert_eq!(fx.tags(), vec!["site-v3.0.1", "v1.0.0"]);

    let audit = fx.audit(AuditFor { card_id: None, area: Some("site") });
    assert_eq!(audit.suggested_next_version, "3.0.2");
    let result = fx.ship_batch(&["s1", "s2"], "3.0.2").expect("the site's batch ships");
    assert_eq!(result.tag.as_deref(), Some("site-v3.0.2"));
    assert_eq!(fx.version_of("site/package.json"), "3.0.2");
    assert_eq!(fx.version_of("package.json"), "1.0.0");

    let app = fx.audit(AuditFor { card_id: Some("a1"), area: None });
    assert_eq!((app.current_version.as_str(), app.area.tag_prefix.as_str()), ("1.0.0", ""));
    let result = fx.ship_batch(&["a1"], "1.0.1").expect("the app's batch ships");
    assert_eq!(result.tag.as_deref(), Some("v1.0.1"));
    assert_eq!(fx.version_of("package.json"), "1.0.1");
    assert_eq!(fx.version_of("site/package.json"), "3.0.2", "the site's version is untouched");
    assert_eq!(fx.tags(), vec!["site-v3.0.1", "site-v3.0.2", "v1.0.0", "v1.0.1"]);
}

#[test]
fn held_areas_refuse_the_release() {
    let fx = Fixture::new(&app_and_site(), &[("site-card", "site", "site/page.txt")]);
    {
        let store = fx.app.state::<ProjectConfigStore>();
        let path = crate::workspace_definition::cache_path(&store, &fx.ws_id);
        fs::write(
            &path,
            r#"{"schemaVersion":1,"definition":{"name":"w"},"fieldProblems":{"areas":{"message":"Two areas share the folder site/.","kept":null}}}"#,
        )
        .unwrap();
        crate::areas::save(&store, &fx.ws_id, &[]).unwrap();
    }
    let want = "This repository's areas can't be used: Two areas share the folder site/. Fix them in Settings › Project › Areas.";
    assert_eq!(fx.audit(AuditFor { card_id: Some("site-card"), area: None }).area.refusal.as_deref(), Some(want));
    assert_eq!(fx.ship_now("site-card", "3.0.2").unwrap_err().to_string(), want);
    assert_eq!(fx.ship_batch(&["site-card"], "3.0.2").unwrap_err().to_string(), want);
    assert_eq!(fx.tags(), vec!["site-v3.0.1", "v1.0.0"]);
}

#[test]
fn without_areas_ship_now_and_ship_batch_tag_v_as_before() {
    let fx = Fixture::new(&[], &[("c1", "", "a.txt"), ("c2", "", "site/b.txt")]);
    let audit = fx.audit(AuditFor { card_id: Some("c1"), area: None });
    assert_eq!((audit.current_version.as_str(), audit.area.tag_prefix.as_str(), audit.area.name.as_deref()), ("1.0.0", "", None));
    let result = fx.ship_now("c1", "1.0.1").unwrap();
    assert_eq!(result.tag.as_deref(), Some("v1.0.1"));
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "chore(release): v1.0.1");
    let result = fx.ship_batch(&["c2"], "1.0.2").unwrap();
    assert_eq!(result.tag.as_deref(), Some("v1.0.2"));
    assert_eq!(fx.version_of("package.json"), "1.0.2");
    assert_eq!(fx.version_of("site/package.json"), "3.0.1", "not a version file of this workspace");
    let shipped = fx.app.state::<KanbanStore>().get_card(&fx.ws_id, "c1").unwrap();
    assert_eq!(shipped.ship_history.last().and_then(|e| e.tag.as_deref()), Some("v1.0.1"));
    assert_eq!(fx.tags(), vec!["site-v3.0.1", "v1.0.0", "v1.0.1", "v1.0.2"]);
}

#[test]
fn ship_batch_s_list_groups_the_ready_cards_by_area() {
    let fx = Fixture::new(
        &app_and_site(),
        &[("s1", "site", "site/a.txt"), ("a1", "app", "app.txt"), ("s2", "site", "site/b.txt"), ("n1", "", "x.txt")],
    );
    let h = fx.app.handle();
    let (kanban, store) = (h.state::<KanbanStore>(), h.state::<ProjectConfigStore>());
    let mut branches = Vec::new();
    let list = pending_ship_cards_with(&kanban, &[fx.ws_id.clone()], &store, |c, branch| {
        branches.push((c.id.clone(), branch.to_string()));
        true
    });
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].card_ids.len(), 4, "the count is every ready card, as before");
    let group = |area: Option<&str>, name: &str, ids: &[&str], refusal: Option<&str>| PendingAreaCards {
        area: area.map(str::to_string),
        name: name.into(),
        card_ids: ids.iter().map(|s| s.to_string()).collect(),
        refusal: refusal.map(str::to_string),
        branch: if refusal.is_some() { String::new() } else { "main".into() },
        tag_prefix: if area == Some("site") { "site-".into() } else { String::new() },
    };
    let mut got = list[0].areas.clone();
    got.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(
        got,
        vec![
            group(None, "", &["n1"], Some(crate::card_area::NEEDS_AREA)),
            group(Some("app"), "App", &["a1"], None),
            group(Some("site"), "Site", &["s1", "s2"], None),
        ]
    );
    assert!(branches.iter().all(|(_, b)| b == "main"));
}

#[test]
fn without_areas_ship_batch_s_list_is_the_old_one() {
    let plain = Fixture::new(&[], &[("c1", "", "a.txt")]);
    let h = plain.app.handle();
    let list = pending_ship_cards_with(&h.state::<KanbanStore>(), &[plain.ws_id.clone()], &h.state::<ProjectConfigStore>(), |_, _| true);
    assert!(list[0].areas.is_empty());
    assert_eq!(
        serde_json::to_value(&list[0]).unwrap(),
        serde_json::json!({ "workspaceId": plain.ws_id, "cardIds": ["c1"] })
    );
}

#[test]
fn settings_areas_reads_each_area_s_latest_tag_and_version() {
    let fx = Fixture::new(&app_and_site(), &[]);
    git(&fx.ws, &["tag", "site-v3.0.2-rc1"]);
    git(&fx.ws, &["tag", "site-v2.9.0-unverified"]);
    let h = fx.app.handle();
    let got = area_releases(&h.state::<WorkspaceStore>(), &h.state::<ProjectConfigStore>(), &fx.ws_id).unwrap();
    assert_eq!(
        got,
        vec![
            AreaRelease { id: "app".into(), tag_prefix: String::new(), latest_tag: Some("v1.0.0".into()), version: Some("1.0.0".into()) },
            AreaRelease { id: "site".into(), tag_prefix: "site-".into(), latest_tag: Some("site-v3.0.1".into()), version: Some("3.0.1".into()) },
        ]
    );
}

#[test]
fn without_areas_the_implicit_area_reads_the_latest_strict_v_tag() {
    // 1.173.0 (G1, the D2 leftover): releases from before 1.173 have no
    // record of their kind; How this goes live still names the latest tag.
    let fx = Fixture::new(&[], &[]);
    git(&fx.ws, &["tag", "v1.1.0-unverified"]);
    git(&fx.ws, &["tag", "v1.2.0-rc1"]);
    git(&fx.ws, &["tag", "vnext"]);
    let h = fx.app.handle();
    let got = area_releases(&h.state::<WorkspaceStore>(), &h.state::<ProjectConfigStore>(), &fx.ws_id).unwrap();
    assert_eq!(
        got,
        vec![AreaRelease {
            id: crate::areas::IMPLICIT_AREA_ID.into(),
            tag_prefix: String::new(),
            latest_tag: Some("v1.0.0".into()),
            version: Some("1.0.0".into()),
        }]
    );
}

/// 1.174.0 (DR2): a record of a release with no card of its own, read by the
/// ship-side readers a 1.173 Plyloft has too: a Ship of a card is refused in
/// words (never a panic), a press of exactly its (no) cards takes it on, its
/// Release pull request body and notes have no empty card line, and a record
/// with no card is never taken for published.
#[test]
fn a_release_with_no_card_of_its_own_is_read_without_a_panic() {
    let record = crate::release_record::PendingRelease {
        version: "1.0.1".into(),
        tag: "v1.0.1".into(),
        commit_sha: "abc".into(),
        branch: "main".into(),
        card_ids: vec![],
        card_revs: Default::default(),
        release_kind: crate::kanban::ReleaseKind::PushOnly,
        skip_verify: false,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: 0,
        stage: crate::release_record::RecordStage::Tagged,
        start_commit: None,
        protected: false,
        tag_pushed: false,
        pr: None,
        merged_card_ids: vec!["gone".into()],
        since_tag: Some("v1.0.0".into()),
        other_changes: 1,
        stop_requested: false,
    };
    let view = crate::release_record::PendingReleaseView { record: record.clone(), problem: None, undo: false };
    let said = resume_or_refuse(&view, &["card-1".to_string()], &[]).unwrap_err().to_string();
    assert!(said.contains("v1.0.1 () is committed here"), "{said}");
    assert!(resume_or_refuse(&view, &[], &[]).is_ok());

    let pr = crate::release_record::ReleasePr::new("plyloft/release-v1.0.1".into(), "b".into());
    let body = release_pr::pr_body(&record, &pr, &[]);
    assert!(body.starts_with("Release v1.0.1 made by Plyloft: everything on main since v1.0.0, and the version."), "{body}");
    // A card gone from the Board has no title to say: left out.
    assert!(body.contains("Already on main:\n- 1 other change since v1.0.0") && !body.contains("gone"), "{body}");
    let notes = release_pr::release_notes(&record, &pr, &[]);
    assert_eq!(notes, "## v1.0.1\n\n- 1 other change since v1.0.0\n");

    let dir = tempfile::tempdir().unwrap();
    let kanban = KanbanStore::new(dir.path().join("kanban")).unwrap();
    let ws_dir = dir.path().join("ws");
    crate::release_record::save(&ws_dir, &record).unwrap();
    assert_eq!(live_record(&ws_dir, &kanban, "ws").unwrap(), Some(record), "kept");
}
