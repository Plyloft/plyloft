use super::*;

const STATUS: &str = include_str!("deploy_fixtures/railway_status.json");

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| p.to_string()).collect()
}

fn fixture_map() -> DeployMap {
    let (project, services) = parse_railway_status(STATUS).unwrap();
    let mut railway = RailwayRead { state: RailwayState::Ok, project, services, message: None, read_at: Some(1) };
    mark_this_repository(&mut railway, Some("Acme/Monorepo"));
    DeployMap { repo: Some("Acme/Monorepo".to_string()), railway, workflows: Vec::new(), railway_files: false }
}

fn names(what: &WhatRedeploys) -> Vec<(&str, RebuildReason)> {
    what.services.iter().map(|r| (r.service.name.as_str(), r.reason)).collect()
}

// ── Parsing Railway ────────────────────────────────────────────────────

#[test]
fn a_recorded_status_reads_as_its_environments_and_services() {
    let (project, services) = parse_railway_status(STATUS).unwrap();
    assert_eq!(project.as_deref(), Some("acme-project"));
    let summary: Vec<(&str, &str, Option<&str>, Option<&str>)> = services
        .iter()
        .map(|s| (s.environment.as_str(), s.name.as_str(), s.branch.as_deref(), s.root_directory.as_deref()))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("staging", "app-staging", Some("staging"), None),
            ("staging", "nightly-job", Some("staging"), None),
            ("staging", "site-staging", Some("staging"), Some("site")),
            ("production", "app-production", Some("main"), None),
            ("production", "site-production", Some("main"), Some("site")),
        ]
    );
    let app = services.iter().find(|s| s.name == "app-production").unwrap();
    assert_eq!(app.repo.as_deref(), Some("acme/monorepo"));
    // Custom addresses first, Railway's own after.
    assert_eq!(app.domains, vec!["app.example.com", "app-production-production.up.railway.app"]);
    assert!(app.watch_patterns.is_empty());
    let site = services.iter().find(|s| s.name == "site-production").unwrap();
    assert_eq!(site.domains, vec!["www.example.com"]);
    let job = services.iter().find(|s| s.name == "nightly-job").unwrap();
    assert_eq!(job.watch_patterns.len(), 8);
    assert_eq!(job.watch_patterns[0], "scripts/**");
    assert_eq!(job.cron.as_deref(), Some("15 4 * * *"));
    assert!(job.domains.is_empty());
}

/// `railway status --json` as a real project answered it (1.173.0 walk,
/// ids and owners scrubbed): the app's latest deploy failed and is stopped,
/// the site's succeeded and serves.
const LIVE: &str = include_str!("deploy_fixtures/railway_status_live.json");

#[test]
fn each_service_carries_its_latest_deployments_state() {
    let (project, services) = parse_railway_status(LIVE).unwrap();
    assert_eq!(project.as_deref(), Some("plyloft-walk-1173"));
    let summary: Vec<(&str, Option<&str>, Option<&str>, Option<&str>)> = services
        .iter()
        .map(|s| (s.name.as_str(), s.branch.as_deref(), s.root_directory.as_deref(), s.deploy_status.as_deref()))
        .collect();
    assert_eq!(
        summary,
        vec![("app", Some("main"), None, Some("FAILED")), ("site", Some("main"), Some("site"), Some("SUCCESS"))]
    );
    // The recorded fixture's states read too; a service without a latest
    // deployment has none, and a lower-case state is upper-cased.
    let (_, recorded) = parse_railway_status(STATUS).unwrap();
    assert_eq!(recorded.iter().find(|s| s.name == "app-staging").unwrap().deploy_status.as_deref(), Some("SUCCESS"));
    let (_, sparse) = parse_railway_status(r#"{"environments":{"edges":[{"node":{"name":"p","serviceInstances":{"edges":[{"node":{"serviceName":"a"}},{"node":{"serviceName":"b","latestDeployment":{"status":"building"}}}]}}}]}}"#).unwrap();
    assert_eq!(sparse[0].deploy_status, None);
    assert_eq!(sparse[1].deploy_status.as_deref(), Some("BUILDING"));
}

#[test]
fn root_directories_are_read_from_the_repository_root() {
    assert_eq!(normalize_root(Some("/site")), Some("site".into()));
    assert_eq!(normalize_root(Some("site/")), Some("site".into()));
    assert_eq!(normalize_root(Some("./apps/web")), Some("apps/web".into()));
    assert_eq!(normalize_root(Some("/")), None);
    assert_eq!(normalize_root(Some("")), None);
    assert_eq!(normalize_root(None), None);
}

#[test]
fn an_answer_that_is_not_railways_is_refused_and_a_sparse_one_reads() {
    assert!(parse_railway_status("not json").is_err());
    let (project, services) = parse_railway_status(r#"{"name":"p","environments":{"edges":[{"node":{"name":"production","serviceInstances":{"edges":[{"node":{"serviceName":"img","source":{"image":"redis"}}}]}}}]}}"#).unwrap();
    assert_eq!(project.as_deref(), Some("p"));
    assert_eq!(services.len(), 1);
    assert_eq!(services[0].repo, None);
    assert_eq!(services[0].branch, None);
    assert!(services[0].domains.is_empty());
}

#[test]
fn failures_read_as_their_state() {
    assert_eq!(classify_failure("No linked project found. Run railway link to connect to a project"), RailwayState::NotLinked);
    assert_eq!(classify_failure("Unauthorized. Please login with `railway login`"), RailwayState::SignedOut);
    assert_eq!(classify_failure("error: something else"), RailwayState::Failed);
}

// ── The link ───────────────────────────────────────────────────────────

const CONFIG: &str = r#"{
  "projects": {
    "/work/monorepo": {"projectPath": "/work/monorepo", "name": "acme-project", "project": "x", "environment": "y"}
  },
  "user": {"token": null, "accessToken": "secret"}
}"#;

#[test]
fn a_folder_or_one_inside_it_is_linked() {
    let link = link_for(CONFIG, Path::new("/work/monorepo")).unwrap().unwrap();
    assert_eq!(link.project.as_deref(), Some("acme-project"));
    assert!(link.signed_in);
    assert!(link_for(CONFIG, Path::new("/work/monorepo/site")).unwrap().is_some());
    assert_eq!(link_for(CONFIG, Path::new("/work/other")).unwrap(), None);
    assert_eq!(link_for("{oops", Path::new("/work/monorepo")), None);
    let signed_out = link_for(r#"{"projects":{"/w":{"name":"p"}},"user":{}}"#, Path::new("/w")).unwrap().unwrap();
    assert!(!signed_out.signed_in);
}

#[test]
fn a_missing_program_reads_as_none_and_runs_nothing() {
    let read = read_railway(&RailwayInputs {
        program: None,
        path_env: "",
        folder: Path::new("/work/monorepo"),
        config: Some(CONFIG),
        repo_top: None,
        timeout: Duration::from_secs(1),
    });
    assert_eq!(read.state, RailwayState::NoCli);
    assert!(read.read_at.is_none());
}

#[test]
fn an_unlinked_folder_runs_nothing() {
    // The program would fail loudly if it ran.
    for config in [Some(CONFIG), None] {
        let read = read_railway(&RailwayInputs {
            program: Some("/nonexistent/railway"),
            path_env: "",
            folder: Path::new("/work/other"),
            config,
            repo_top: None,
            timeout: Duration::from_secs(1),
        });
        assert_eq!(read.state, RailwayState::NotLinked);
        assert!(read.read_at.is_none(), "nothing ran");
    }
}

#[cfg(unix)]
fn fake_railway(dir: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("railway");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
fn linked_config(folder: &Path) -> String {
    let key = folder.to_string_lossy().replace('\\', "\\\\");
    format!(r#"{{"projects":{{"{key}":{{"name":"acme-project"}}}},"user":{{"accessToken":"t"}}}}"#)
}

#[cfg(unix)]
#[test]
fn a_linked_folder_is_read_through_the_program() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = dir.path().join("status.json");
    std::fs::write(&fixture, STATUS).unwrap();
    let program = fake_railway(dir.path(), &format!("[ \"$1 $2\" = \"status --json\" ] || exit 9\ncat '{}'", fixture.display()));
    let config = linked_config(dir.path());
    let read = read_railway(&RailwayInputs {
        program: Some(program.to_str().unwrap()),
        path_env: "/usr/bin:/bin",
        folder: dir.path(),
        config: Some(&config),
        repo_top: None,
        timeout: Duration::from_secs(5),
    });
    assert_eq!(read.state, RailwayState::Ok, "{:?}", read.message);
    assert_eq!(read.project.as_deref(), Some("acme-project"));
    assert_eq!(read.services.len(), 5);
    assert!(read.read_at.is_some());
}

#[cfg(unix)]
#[test]
fn a_program_past_its_bound_is_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_railway(dir.path(), "sleep 20");
    let config = linked_config(dir.path());
    let started = Instant::now();
    let read = read_railway(&RailwayInputs {
        program: Some(program.to_str().unwrap()),
        path_env: "/usr/bin:/bin",
        folder: dir.path(),
        config: Some(&config),
        repo_top: None,
        timeout: Duration::from_millis(400),
    });
    assert_eq!(read.state, RailwayState::TimedOut);
    assert_eq!(read.project.as_deref(), Some("acme-project"), "the link still names it");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[cfg(unix)]
#[test]
fn a_refusal_reads_as_its_state() {
    let dir = tempfile::tempdir().unwrap();
    let config = linked_config(dir.path());
    let run = |body: &str| {
        let program = fake_railway(dir.path(), body);
        read_railway(&RailwayInputs {
            program: Some(program.to_str().unwrap()),
            path_env: "/usr/bin:/bin",
            folder: dir.path(),
            config: Some(&config),
            repo_top: None,
            timeout: Duration::from_secs(5),
        })
    };
    assert_eq!(run("echo 'Unauthorized. Please login with `railway login`' >&2; exit 1").state, RailwayState::SignedOut);
    assert_eq!(run("echo 'No linked project found.' >&2; exit 1").state, RailwayState::NotLinked);
    let failed = run("echo 'boom' >&2; exit 1");
    assert_eq!(failed.state, RailwayState::Failed);
    assert_eq!(failed.message.as_deref(), Some("boom"));
    assert_eq!(run("echo '{not json'").state, RailwayState::Failed);
}

// ── Watch paths (gitignore-style) ──────────────────────────────────────

#[test]
fn watch_paths_follow_gitignore_rules() {
    let p = |list: &[&str]| paths(list);
    // No list: everything.
    assert!(watch_matches(&[], "anything/at/all.rs"));
    // A folder and everything under it.
    assert!(watch_matches(&p(&["scripts/**"]), "scripts/a/b.py"));
    assert!(!watch_matches(&p(&["scripts/**"]), "site/scripts/b.py"), "a slash anchors at the root");
    // Leading slash anchors too.
    assert!(watch_matches(&p(&["/site/**"]), "site/index.astro"));
    assert!(!watch_matches(&p(&["/site/**"]), "app/site/x"));
    // A bare name matches at any depth.
    assert!(watch_matches(&p(&["requirements.txt"]), "requirements.txt"));
    assert!(watch_matches(&p(&["requirements.txt"]), "services/requirements.txt"));
    // `*` stays within a folder; `**` crosses them.
    assert!(watch_matches(&p(&["/src/*.js"]), "src/a.js"));
    assert!(!watch_matches(&p(&["/src/*.js"]), "src/lib/a.js"));
    assert!(watch_matches(&p(&["/src/**/*.js"]), "src/lib/a.js"));
    // A folder name matches what's inside it.
    assert!(watch_matches(&p(&["config"]), "config/settings.toml"));
    // `!` takes back, the last match wins.
    let neg = p(&["/src/**", "!/src/docs/**"]);
    assert!(watch_matches(&neg, "src/main.rs"));
    assert!(!watch_matches(&neg, "src/docs/readme.md"));
    // A leading `/` on the changed path is the root.
    assert!(watch_matches(&p(&["scripts/**"]), "/scripts/x.py"));
}

// ── GitHub's filters ───────────────────────────────────────────────────

#[test]
fn github_globs_follow_githubs_cheat_sheet() {
    assert!(github_glob("main", "main"));
    assert!(!github_glob("main", "main2"));
    assert!(github_glob("releases/*", "releases/v1"));
    assert!(!github_glob("releases/*", "releases/v1/x"));
    assert!(github_glob("releases/**", "releases/v1/x"));
    assert!(github_glob("site/**", "site/src/pages/index.astro"));
    assert!(github_glob("**.js", "a/b/c.js"));
    assert!(github_glob("*.js", "c.js"));
    assert!(!github_glob("*.js", "a/c.js"));
    assert!(github_glob("**/README.md", "README.md"));
    assert!(github_glob("**/README.md", "docs/README.md"));
    assert!(github_glob("docs/**/*.md", "docs/a.md"));
    assert!(github_glob("docs/**/*.md", "docs/x/y/a.md"));
    assert!(github_glob("v[12].[0-9]+.[0-9]+", "v1.10.3"));
    assert!(github_glob("*feature", "my-feature"));
    assert!(github_glob("ver?sion", "vesion"));
    assert!(github_glob("ver?sion", "version"));
}

#[test]
fn github_filters_take_back_with_a_bang_in_order() {
    let list = paths(&["sub-project/**", "!sub-project/docs/**"]);
    assert!(github_filter(&list, "sub-project/src/a.rs"));
    assert!(!github_filter(&list, "sub-project/docs/a.md"));
    assert!(!github_filter(&list, "other/a.rs"));
}

const CI: &str = r#"
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches:
      - main
      - 'releases/**'
    paths-ignore:
      - 'docs/**'
      - '**.md'
jobs:
  backend:
    runs-on: ubuntu-latest
    steps: []
  frontend:
    name: frontend
    runs-on: ubuntu-latest
  matrix:
    name: build ${{ matrix.os }}
    runs-on: ubuntu-latest
"#;

const SITE: &str = r#"
on:
  pull_request:
    paths: ['site/**', '.github/workflows/site.yml']
jobs:
  site:
    name: Site
"#;

const DEPLOY: &str = "on: push\njobs:\n  ship: {}\n";
const BOTH: &str = "on: [push, pull_request]\njobs:\n  test: {}\n";

#[test]
fn workflows_read_their_events_filters_and_jobs() {
    let ci = parse_workflow("ci.yml", CI).unwrap();
    assert_eq!(ci.name, "CI");
    assert_eq!(ci.jobs, vec!["backend", "frontend", "matrix"]);
    assert_eq!(ci.push.as_ref().unwrap().branches, Some(paths(&["main"])));
    let pr = ci.pull_request.as_ref().unwrap();
    assert_eq!(pr.branches, Some(paths(&["main", "releases/**"])));
    assert_eq!(pr.paths_ignore, Some(paths(&["docs/**", "**.md"])));
    assert_eq!(pr.paths, None);

    let site = parse_workflow("site.yaml", SITE).unwrap();
    assert_eq!(site.name, "site", "the file's name without its extension");
    assert_eq!(site.jobs, vec!["Site"]);
    assert_eq!(site.push, None);
    assert_eq!(site.pull_request.as_ref().unwrap().paths, Some(paths(&["site/**", ".github/workflows/site.yml"])));

    assert_eq!(parse_workflow("deploy.yml", DEPLOY).unwrap().pull_request, None);
    let both = parse_workflow("both.yml", BOTH).unwrap();
    assert_eq!(both.pull_request, Some(Trigger::default()));
    assert!(both.push.is_some());
    assert_eq!(parse_workflow("x.yml", "just: text"), None);
    assert_eq!(parse_workflow("x.yml", ":::"), None);
}

#[test]
fn workflow_files_are_read_from_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let wf = dir.path().join(".github/workflows");
    std::fs::create_dir_all(&wf).unwrap();
    std::fs::write(wf.join("ci.yml"), CI).unwrap();
    std::fs::write(wf.join("site.yaml"), SITE).unwrap();
    std::fs::write(wf.join("notes.txt"), "no").unwrap();
    let read = read_workflows(dir.path());
    assert_eq!(read.iter().map(|w| w.file.as_str()).collect::<Vec<_>>(), vec!["ci.yml", "site.yaml"]);
    assert!(read_workflows(&dir.path().join("missing")).is_empty());
}

#[test]
fn workflow_paths_decide_which_checks_run() {
    let mut map = fixture_map();
    map.workflows = vec![
        parse_workflow("ci.yml", CI).unwrap(),
        parse_workflow("site.yml", SITE).unwrap(),
        parse_workflow("deploy.yml", DEPLOY).unwrap(),
    ];
    let checks = |branch: &str, changed: &[&str]| {
        what_redeploys(&map, branch, &paths(changed)).checks.into_iter().map(|c| c.file).collect::<Vec<_>>()
    };
    assert_eq!(checks("main", &["site/index.astro"]), vec!["ci.yml", "site.yml"]);
    assert_eq!(checks("main", &["routers/a.py"]), vec!["ci.yml"]);
    // paths-ignore: only docs and markdown changed → CI is skipped.
    assert_eq!(checks("main", &["docs/a.txt", "README.md"]), Vec::<String>::new());
    // One file outside the ignore is enough.
    assert_eq!(checks("main", &["docs/a.txt", "routers/a.py"]), vec!["ci.yml"]);
    // Branch filters.
    assert_eq!(checks("releases/v2", &["routers/a.py"]), vec!["ci.yml"]);
    assert_eq!(checks("staging", &["routers/a.py"]), Vec::<String>::new());
    assert_eq!(checks("staging", &["site/a"]), vec!["site.yml"]);
    let what = what_redeploys(&map, "main", &paths(&["routers/a.py"]));
    assert_eq!(what.checks[0].jobs, vec!["backend", "frontend", "matrix"]);
}

// ── What a merge redeploys ─────────────────────────────────────────────

#[test]
fn a_site_only_change_updates_the_site_and_restarts_the_app_too() {
    let what = what_redeploys(&fixture_map(), "main", &paths(&["site/src/pages/pricing.astro", "site/package.json"]));
    assert_eq!(names(&what), vec![("site-production", RebuildReason::InRoot), ("app-production", RebuildReason::AnyChange)]);
    assert!(what.services.iter().all(|r| r.rebuilds_on_any_change), "neither has watch paths");
    assert_eq!(what.services[0].domains, vec!["www.example.com"]);
    assert_eq!(what.services[1].domains[0], "app.example.com");
    assert_eq!(what.project.as_deref(), Some("acme-project"));
    assert_eq!(what.railway_read_at, Some(1));
    assert_eq!(what.changed, 2);
    assert!(what.has_anything());
}

#[test]
fn an_app_change_updates_the_app_and_restarts_the_site_too() {
    let what = what_redeploys(&fixture_map(), "main", &paths(&["routers/users.py"]));
    assert_eq!(names(&what), vec![("app-production", RebuildReason::InRoot), ("site-production", RebuildReason::AnyChange)]);
}

#[test]
fn watch_paths_decide_on_the_other_branch() {
    let map = fixture_map();
    let what = what_redeploys(&map, "staging", &paths(&["routers/users.py"]));
    assert_eq!(
        names(&what),
        vec![
            ("app-staging", RebuildReason::InRoot),
            ("nightly-job", RebuildReason::Watched),
            ("site-staging", RebuildReason::AnyChange),
        ]
    );
    let job = what.services.iter().find(|r| r.service.name == "nightly-job").unwrap();
    assert!(!job.rebuilds_on_any_change);
    // A change no watch path takes leaves the job alone.
    let what = what_redeploys(&map, "staging", &paths(&["docs/notes.md"]));
    assert!(names(&what).iter().all(|(n, _)| *n != "nightly-job"));
    // A bare name in the watch paths matches at any depth.
    let what = what_redeploys(&map, "staging", &paths(&["requirements.txt"]));
    assert!(names(&what).contains(&("nightly-job", RebuildReason::Watched)));
}

#[test]
fn another_repository_or_branch_or_nothing_changed_rebuilds_nothing() {
    let mut map = fixture_map();
    assert!(what_redeploys(&map, "develop", &paths(&["site/a"])).services.is_empty());
    assert!(what_redeploys(&map, "main", &[]).services.is_empty());
    map.repo = Some("acme/other".into());
    assert!(what_redeploys(&map, "main", &paths(&["site/a"])).services.is_empty());
    map.repo = None;
    let what = what_redeploys(&map, "main", &paths(&["site/a"]));
    assert!(what.services.is_empty());
    assert!(!what.has_anything());
}

#[test]
fn an_empty_map_has_nothing_to_show() {
    let map = DeployMap { repo: None, railway: RailwayRead::nothing(RailwayState::NoCli), workflows: Vec::new(), railway_files: false };
    assert!(!map.has_anything());
    assert!(fixture_map().has_anything());
}

// ── Doctor ─────────────────────────────────────────────────────────────

#[test]
fn the_doctor_row_says_signed_in_or_not_linked_and_is_never_an_error() {
    let read = fixture_map().railway;
    let row = doctor_status("monorepo", Some(&read), None).unwrap();
    assert_eq!(row.state, "ok");
    assert_eq!(row.summary, "signed in · project acme-project");
    let not = doctor_status("monorepo", Some(&RailwayRead::nothing(RailwayState::NotLinked)), None).unwrap();
    assert_eq!(not.summary, "not linked here");
    assert_eq!(doctor_status("monorepo", Some(&RailwayRead::nothing(RailwayState::NoCli)), None), None);
    let timed = doctor_status("monorepo", Some(&RailwayRead::nothing(RailwayState::TimedOut)), None).unwrap();
    assert_eq!(timed.state, "unknown");
    // Nothing read yet: the link alone, which can't say whose project it is.
    let link = RailwayLink { project: Some("acme-project".into()), signed_in: true, linked_at: "/w".into() };
    assert_eq!(doctor_status("m", None, Some(Some(&link))).unwrap().summary, "signed in");
    assert_eq!(doctor_status("m", None, Some(None)).unwrap().summary, "not linked here");
    let out = RailwayLink { project: None, signed_in: false, linked_at: "/w".into() };
    assert_eq!(doctor_status("m", None, Some(Some(&out))).unwrap().state, "signedOut");
    assert_eq!(doctor_status("m", None, None), None);
    for row in [row, not, timed] {
        for word in ["CLI", "PR ", "worktree", "diff"] {
            assert!(!row.detail.contains(word) && !row.summary.contains(word), "{word} in {row:?}");
        }
    }
}

#[test]
fn the_cache_hands_back_a_fresh_reading_and_drops_an_old_one() {
    let id = "deploy-map-cache-test";
    cache().lock().unwrap().insert(
        id.into(),
        Cached { at: Instant::now(), railway: RailwayRead::nothing(RailwayState::NotLinked) },
    );
    assert_eq!(cached_railway(id, Some(CACHE_FOR)).unwrap().state, RailwayState::NotLinked);
    if let Some(old) = Instant::now().checked_sub(CACHE_FOR + Duration::from_secs(1)) {
        cache().lock().unwrap().get_mut(id).unwrap().at = old;
        assert!(cached_railway(id, Some(CACHE_FOR)).is_none());
        assert!(cached_railway(id, None).is_some(), "the Doctor still sees it");
    }
}

// ── Challenger round 1 ─────────────────────────────────────────────────

fn read_of(state: RailwayState) -> RailwayRead {
    RailwayRead::nothing(state)
}

#[test]
fn a_read_that_asks_reads_again_unless_a_settled_answer_is_fresh() {
    let fresh = Duration::from_secs(5);
    let old = CACHE_FOR + Duration::from_secs(1);
    // A cached "signed out" is read again when the Doctor asks.
    assert_eq!(doctor_pick(Some((fresh, read_of(RailwayState::SignedOut))), true, false), DoctorPick::Ask);
    assert_eq!(doctor_pick(Some((fresh, read_of(RailwayState::TimedOut))), true, false), DoctorPick::Ask);
    assert_eq!(doctor_pick(Some((fresh, read_of(RailwayState::Failed))), true, false), DoctorPick::Ask);
    // A settled answer is kept ten minutes.
    assert_eq!(
        doctor_pick(Some((fresh, read_of(RailwayState::Ok))), true, false),
        DoctorPick::Use(read_of(RailwayState::Ok))
    );
    assert_eq!(doctor_pick(Some((old, read_of(RailwayState::Ok))), true, false), DoctorPick::Ask);
    assert_eq!(doctor_pick(None, true, false), DoctorPick::Ask);
    // Without asking: only a reading under ten minutes, never a run.
    assert_eq!(doctor_pick(Some((old, read_of(RailwayState::Ok))), false, true), DoctorPick::LinkOnly);
    assert_eq!(doctor_pick(None, false, true), DoctorPick::LinkOnly);
    assert_eq!(
        doctor_pick(Some((fresh, read_of(RailwayState::SignedOut))), false, false),
        DoctorPick::Use(read_of(RailwayState::SignedOut))
    );
    // Signed in again since (`railway login`): Check again shows it.
    assert_eq!(doctor_pick(Some((fresh, read_of(RailwayState::SignedOut))), false, true), DoctorPick::LinkOnly);
}

#[test]
fn the_signed_out_words_name_the_doctors_button_and_the_command_as_code() {
    let row = doctor_status("m", Some(&read_of(RailwayState::SignedOut)), None).unwrap();
    assert!(row.detail.contains("`railway login`"), "{}", row.detail);
    assert!(row.detail.ends_with("then Check again."), "{}", row.detail);
}

#[test]
fn a_failure_says_plain_words_and_keeps_railways_own_for_details() {
    let mut read = read_of(RailwayState::Failed);
    read.message = Some("error: GraphQL 500 internal".into());
    let row = doctor_status("monorepo", Some(&read), None).unwrap();
    assert_eq!(row.detail, "Railway didn't answer for monorepo. Ship works the same.");
    assert_eq!(row.technical.as_deref(), Some("error: GraphQL 500 internal"));
}

const PARENT_LINKED: &str = r#"{"projects":{"/work":{"projectPath":"/work","name":"other-project"}},"user":{"accessToken":"t"}}"#;

#[test]
fn a_link_on_a_folder_above_the_repository_is_another_projects() {
    let link = link_for_in(PARENT_LINKED, &["/work/monorepo".into()], false).unwrap().unwrap();
    assert_eq!(link.linked_at, "/work");
    assert!(link_above(&link, "/work/monorepo", false));
    assert!(!link_above(&link, "/work", false), "the repository's own folder is its link");
    // read_railway runs nothing (the program doesn't exist).
    let read = read_railway(&RailwayInputs {
        program: Some("/nonexistent/railway"),
        path_env: "",
        folder: Path::new("/work/monorepo"),
        config: Some(PARENT_LINKED),
        repo_top: Some("/work/monorepo"),
        timeout: Duration::from_secs(1),
    });
    assert_eq!(read.state, RailwayState::OtherProject);
    assert!(read.read_at.is_none(), "nothing ran");
    let row = doctor_status("monorepo", Some(&read), None).unwrap();
    assert_eq!(row.summary, "not linked here");
}

#[test]
fn a_project_building_another_repository_is_not_named() {
    let mut read = fixture_map().railway;
    mark_this_repository(&mut read, Some("other/repo"));
    assert!(read.services.iter().all(|s| !s.this_repository));
    let row = doctor_status("monorepo", Some(&read), None).unwrap();
    assert_eq!(row.summary, "signed in");
    assert!(!row.detail.contains("acme-project"));
    let map = DeployMap { repo: Some("other/repo".into()), railway: read, workflows: Vec::new(), railway_files: false };
    assert!(what_redeploys(&map, "main", &paths(&["site/a"])).services.is_empty());
    let ours = fixture_map();
    assert!(ours.railway.services.iter().all(|s| s.this_repository));
}

#[test]
fn the_deepest_link_wins_over_both_spellings() {
    let config = r#"{"projects":{"/real/work":{"name":"outer"},"/link/work/monorepo":{"name":"inner"}},"user":{}}"#;
    let link = link_for_in(config, &["/link/work/monorepo/site".into(), "/real/work/monorepo/site".into()], false)
        .unwrap()
        .unwrap();
    assert_eq!(link.project.as_deref(), Some("inner"));
}

#[test]
fn a_windows_key_matches_a_folder_in_another_case() {
    let config = r#"{"projects":{"C:\\Users\\Me\\Repo":{"name":"acme-project"}},"user":{"token":"t"}}"#;
    let link = link_for_in(config, &[r"c:\users\me\repo\site".into()], true).unwrap().unwrap();
    assert_eq!(link.project.as_deref(), Some("acme-project"));
    assert_eq!(link_for_in(config, &[r"c:\users\me\repo".into()], false).unwrap(), None, "case counts where the volume keeps it");
    assert!(link_above(&link, r"C:\Users\Me\Repo\inner", true));
}

fn service_json(latest: &str, active: &str, source: &str) -> String {
    format!(
        r#"{{"name":"p","environments":{{"edges":[{{"node":{{"name":"production","serviceInstances":{{"edges":[{{"node":{{"serviceName":"s","latestDeployment":{latest},"activeDeployments":{active}{source}}}}}]}}}}}}]}}}}"#
    )
}

#[test]
fn the_branch_comes_from_the_first_deployment_that_names_one() {
    let json = service_json(
        r#"{"meta":{"branch":null,"repo":"acme/old","rootDirectory":"x"}}"#,
        r#"[{"meta":{"repo":"acme/monorepo"}},{"meta":{"branch":"main","repo":"acme/monorepo","rootDirectory":"/site"}}]"#,
        "",
    );
    let (_, services) = parse_railway_status(&json).unwrap();
    assert_eq!(services[0].branch.as_deref(), Some("main"));
    assert_eq!(services[0].repo.as_deref(), Some("acme/monorepo"), "no source: that deployment's repository");
    assert_eq!(services[0].root_directory.as_deref(), Some("site"));
}

#[test]
fn a_source_without_a_repository_is_never_github_connected() {
    let latest = r#"{"meta":{"branch":"main","repo":"acme/monorepo"}}"#;
    let (_, image) = parse_railway_status(&service_json(latest, "[]", r#","source":{"repo":null,"image":"redis"}"#)).unwrap();
    assert_eq!(image[0].repo, None);
    let (_, sourced) = parse_railway_status(&service_json(latest, "[]", r#","source":{"repo":"acme/new"}"#)).unwrap();
    assert_eq!(sourced[0].repo.as_deref(), Some("acme/new"), "the source wins");
    let (_, none) = parse_railway_status(&service_json(latest, "[]", "")).unwrap();
    assert_eq!(none[0].repo.as_deref(), Some("acme/monorepo"));
}

#[test]
fn pull_request_target_counts_like_a_pull_request() {
    let wf = parse_workflow("t.yml", "on:\n  pull_request_target:\n    branches: [main]\njobs:\n  label: {}\n").unwrap();
    assert_eq!(wf.pull_request, None);
    let mut map = fixture_map();
    map.workflows = vec![wf];
    assert_eq!(what_redeploys(&map, "main", &paths(&["a"])).checks.len(), 1);
    assert!(what_redeploys(&map, "staging", &paths(&["a"])).checks.is_empty());
}

#[test]
fn more_filter_cases() {
    // Re-included after a negation.
    let list = paths(&["app/**", "!app/docs/**", "app/docs/api/**"]);
    assert!(github_filter(&list, "app/docs/api/x.md"));
    assert!(!github_filter(&list, "app/docs/x.md"));
    // A watch list of negations only takes nothing (gitignore: nothing ignored).
    assert!(!watch_matches(&paths(&["!docs/**"]), "src/a.rs"));
    // A folder pattern takes what's inside it.
    assert!(watch_matches(&paths(&["site/"]), "site/src/index.astro"));
    assert!(!watch_matches(&paths(&["site/"]), "website/index.astro"));
    // `pull_request:` with nothing, or only types: no filter.
    let null = parse_workflow("a.yml", "on:\n  pull_request:\njobs:\n  x: {}\n").unwrap();
    assert_eq!(null.pull_request, Some(Trigger::default()));
    let types = parse_workflow("b.yml", "on:\n  pull_request:\n    types: [opened]\njobs:\n  x: {}\n").unwrap();
    assert_eq!(types.pull_request, Some(Trigger::default()));
    // Anchors and aliases.
    let alias = parse_workflow(
        "c.yml",
        "on:\n  push: &main\n    branches: [main]\n    paths: ['site/**']\n  pull_request: *main\njobs:\n  x: {}\n",
    )
    .unwrap();
    assert_eq!(alias.pull_request.as_ref().unwrap().branches, Some(paths(&["main"])));
    assert_eq!(alias.pull_request.as_ref().unwrap().paths, Some(paths(&["site/**"])));
}

#[test]
fn an_unparsable_workflow_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let wf = dir.path().join(".github/workflows");
    std::fs::create_dir_all(&wf).unwrap();
    std::fs::write(wf.join("bad.yml"), "on: [push\njobs: {").unwrap();
    std::fs::write(wf.join("ci.yml"), CI).unwrap();
    let read = read_workflows(dir.path());
    assert_eq!(read.iter().map(|w| w.file.as_str()).collect::<Vec<_>>(), vec!["ci.yml"]);
}

#[test]
fn folders_ignore_case_on_the_mac_and_windows() {
    assert_eq!(FOLDERS_IGNORE_CASE, cfg!(any(windows, target_os = "macos")));
    let config = r#"{"projects":{"/Users/Me/Repo":{"name":"acme-project"}},"user":{}}"#;
    let link = link_for_in(config, &["/Users/me/repo".into()], true).unwrap().unwrap();
    assert_eq!(link.project.as_deref(), Some("acme-project"));
}

#[test]
fn railway_files_are_found_at_the_root_or_one_folder_down() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!has_railway_files(dir.path()));
    std::fs::write(dir.path().join("Dockerfile"), "FROM x").unwrap();
    assert!(!has_railway_files(dir.path()), "a Dockerfile alone is no sign");
    std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
    std::fs::write(dir.path().join("node_modules/railway.json"), "{}").unwrap();
    assert!(!has_railway_files(dir.path()), "never inside node_modules");
    std::fs::create_dir_all(dir.path().join("site")).unwrap();
    std::fs::write(dir.path().join("site/railway.toml"), "").unwrap();
    assert!(has_railway_files(dir.path()));
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("railway.json"), "{}").unwrap();
    assert!(has_railway_files(root.path()));
}
