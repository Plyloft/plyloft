//! 1.174.0 (DR1): what a release of an area carries, on real git
//! repositories: an origin (a bare repository standing for GitHub), a clone
//! that merges there the way GitHub does (squash, merge, rebase, a direct
//! commit), and the project folder on this computer that reads it.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::areas::AreaDef;
use crate::kanban::{KanbanCard, KanbanColumnId};
use crate::project_config::{ProjectConfig, VersionFileEntry, VersionFileKind};

// ── Fixtures ───────────────────────────────────────────────────────────

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

/// The app at the root, the site in `site/`, the docs in `the docs/` (a
/// folder with a space).
fn three_areas() -> Vec<AreaDef> {
    vec![
        area("app", "App", "/", None),
        area("site", "Site", "site/", Some(&["site/package.json"])),
        area("docs", "Docs", "the docs/", Some(&["the docs/package.json"])),
    ]
}

fn config(files: &[&str]) -> ProjectConfig {
    let files: Vec<serde_json::Value> =
        files.iter().map(|p| serde_json::json!({ "path": p, "kind": "package_json" })).collect();
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 2,
        "targetBranch": "main",
        "versionFiles": files,
        "createdAt": 0,
        "updatedAt": 0,
    }))
    .unwrap()
}

/// The release of `id` among `areas` (its branch, files and prefix).
fn ship_area(areas: &[AreaDef], id: &str) -> ShipArea {
    let card = crate::card_area::resolve_with(&config(&["package.json"]), areas, None, &{
        let mut c = KanbanCard::new("x".into(), "ws".into(), "x".into(), None, KanbanColumnId::Complete);
        c.area = Some(id.into());
        c
    });
    crate::ship::ship_area_of(card, areas).unwrap()
}

fn no_area() -> ShipArea {
    ShipArea { config: config(&["package.json"]), prefix: String::new(), id: None, name: None }
}

fn card(id: &str, title: &str) -> KanbanCard {
    KanbanCard::new(id.into(), "ws".into(), title.into(), None, KanbanColumnId::Complete)
}

fn with_pr(mut c: KanbanCard, number: u64, merge_commit: Option<&str>) -> KanbanCard {
    c.pr = Some(crate::pr_status::PrStatus {
        number,
        merge_commit: merge_commit.map(str::to_string),
        ..Default::default()
    });
    c
}

struct Repo {
    path: PathBuf,
    /// Every commit gets its own second unless a test asks for one.
    clock: Cell<i64>,
}

impl Repo {
    fn git(&self, args: &[&str]) -> String {
        self.git_env(args, &[])
    }

    fn git_env(&self, args: &[&str], env: &[(&str, &str)]) -> String {
        let mut cmd = crate::platform::git_command();
        cmd.args(args).current_dir(&self.path);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(&self, file: &str, body: &str) {
        let path = self.path.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn tick(&self) -> String {
        let t = self.clock.get() + 1;
        self.clock.set(t);
        format!("{t} +0000")
    }

    /// Commit `files` as `author`, committed by `committer` at `at` (its
    /// own second when `None`). Returns the sha.
    fn commit_as(&self, files: &[(&str, &str)], message: &[&str], author: &str, committer: &str, at: Option<&str>) -> String {
        for (f, body) in files {
            self.write(f, body);
        }
        self.git(&["add", "-A"]);
        let date = at.map(str::to_string).unwrap_or_else(|| self.tick());
        let mut args = vec!["commit", "-q", "--allow-empty"];
        for m in message {
            args.extend(["-m", m]);
        }
        let env = [
            ("GIT_AUTHOR_NAME", author),
            ("GIT_AUTHOR_EMAIL", "a@example.com"),
            ("GIT_AUTHOR_DATE", date.as_str()),
            ("GIT_COMMITTER_NAME", committer),
            ("GIT_COMMITTER_EMAIL", "c@example.com"),
            ("GIT_COMMITTER_DATE", date.as_str()),
        ];
        self.git_env(&args, &env);
        self.git(&["rev-parse", "HEAD"])
    }

    fn commit(&self, files: &[(&str, &str)], subject: &str) -> String {
        self.commit_as(files, &[subject], "Matteo", "Matteo", None)
    }

    /// A merge commit of `branch` into the checked-out branch, as GitHub's
    /// "Create a merge commit" writes it.
    fn merge(&self, branch: &str, subject: &str, title: &str) -> String {
        let date = self.tick();
        let env = [
            ("GIT_AUTHOR_NAME", "Matteo"),
            ("GIT_AUTHOR_EMAIL", "a@example.com"),
            ("GIT_AUTHOR_DATE", date.as_str()),
            ("GIT_COMMITTER_NAME", "GitHub"),
            ("GIT_COMMITTER_EMAIL", "noreply@github.com"),
            ("GIT_COMMITTER_DATE", date.as_str()),
        ];
        self.git_env(&["merge", "-q", "--no-ff", branch, "-m", subject, "-m", title], &env);
        self.git(&["rev-parse", "HEAD"])
    }
}

/// An origin, the clone that stands for GitHub's merges, and this
/// computer's project folder — all on `main`, with the first commit
/// (`package.json` 1.0.0, `site/package.json` 3.0.1, `the docs/package.json`
/// 1.0.0) tagged `v1.0.0` and `site-v3.0.1`.
struct World {
    _tmp: tempfile::TempDir,
    github: Repo,
    here: Repo,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let mk = |name: &str| {
        let path = tmp.path().join(name);
        fs::create_dir_all(&path).unwrap();
        Repo { path, clock: Cell::new(1_700_000_000) }
    };
    fs::create_dir_all(&origin).unwrap();
    let bare = Repo { path: origin.clone(), clock: Cell::new(0) };
    bare.git(&["init", "-q", "--bare", "-b", "main"]);
    let github = mk("github");
    github.git(&["init", "-q", "-b", "main"]);
    for repo in [&github] {
        repo.git(&["config", "user.email", "t@t"]);
        repo.git(&["config", "user.name", "t"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "tag.gpgsign", "false"]);
    }
    github.git(&["remote", "add", "origin", origin.to_str().unwrap()]);
    github.commit(
        &[
            ("package.json", r#"{"version":"1.0.0"}"#),
            ("site/package.json", r#"{"version":"3.0.1"}"#),
            ("the docs/package.json", r#"{"version":"1.0.0"}"#),
            ("README.md", "hello"),
        ],
        "init",
    );
    github.git(&["tag", "v1.0.0"]);
    github.git(&["tag", "site-v3.0.1"]);
    github.git(&["push", "-q", "origin", "main", "--tags"]);
    let here = mk("here");
    let out = crate::platform::git_command()
        .args(["clone", "-q", origin.to_str().unwrap(), here.path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    here.git(&["config", "user.email", "t@t"]);
    here.git(&["config", "user.name", "t"]);
    here.git(&["config", "commit.gpgsign", "false"]);
    here.clock.set(1_800_000_000);
    World { _tmp: tmp, github, here }
}

fn read_scope(w: &World, areas: &[AreaDef], area: &ShipArea, cards: &[KanbanCard], github: bool) -> ReleaseScope {
    read_scope_in(w, areas, area, cards, github, "")
}

fn read_scope_in(w: &World, areas: &[AreaDef], area: &ShipArea, cards: &[KanbanCard], github: bool, prefix: &str) -> ReleaseScope {
    let place = place_for(&w.here.path, areas, area, github, prefix);
    read(&place, cards, Vec::new(), None, false)
}

fn place_for<'a>(repo: &'a Path, areas: &'a [AreaDef], area: &'a ShipArea, github: bool, prefix: &'a str) -> ScopePlace<'a> {
    ScopePlace {
        workspace_id: "ws",
        repo_root: repo,
        area,
        areas,
        workspace_prefix: prefix,
        github,
        icase: false,
        fetch_ttl: Some(std::time::Duration::ZERO),
        prefetch_problem: None,
    }
}

fn titles(scope: &ReleaseScope) -> (Vec<String>, Vec<String>) {
    (
        scope.cards.iter().map(|c| c.card_id.clone()).collect(),
        scope.other_changes.iter().map(|o| o.title.clone()).collect(),
    )
}

// ── Pure parts ─────────────────────────────────────────────────────────

#[test]
fn pull_request_numbers_are_read_from_squash_and_merge_subjects() {
    assert_eq!(squash_number("Privacy: list Google Cloud KMS (#382)"), Some(382));
    assert_eq!(squash_number("Fix (#12) the thing"), None);
    assert_eq!(squash_number("No number"), None);
    assert_eq!(merge_pr("Merge pull request #385 from owner/card-b"), Some((385, "owner/card-b".into())));
    assert_eq!(merge_pr("Merge branch 'main'"), None);
}

#[test]
fn release_commits_are_never_a_change() {
    let c = |subject: &str| Commit {
        sha: "s".into(),
        parents: vec!["p".into()],
        author: "a".into(),
        subject: subject.into(),
        body: String::new(),
        committer: "c".into(),
        committed_at: 0,
    };
    assert!(is_release_commit(&c("chore(release): site-v3.0.2")));
    assert!(is_release_commit(&c("chore(release): app-v1.4.1 (#392)")));
    assert!(is_release_commit(&c("Merge pull request #391 from owner/plyloft/release-site-v3.0.2")));
    assert!(!is_release_commit(&c("Merge pull request #390 from owner/plyloft/card-x")));
    assert!(!is_release_commit(&c("feat: release notes page")));
}

#[test]
fn the_root_area_leaves_out_every_other_area_and_an_area_its_nested_ones() {
    let mut areas = three_areas();
    areas.push(area("blog", "Blog", "site/blog", Some(&["site/blog/package.json"])));
    let (own, others) = crate::areas::area_folders(&areas, Some("app"), false).unwrap();
    assert_eq!(own, "");
    assert_eq!(others, vec!["site", "the docs", "site/blog"]);
    let (own, others) = crate::areas::area_folders(&areas, Some("site"), false).unwrap();
    assert_eq!(own, "site");
    assert_eq!(others, vec!["site/blog"], "only the folders inside its own");
    let (_, others) = crate::areas::area_folders(&areas, Some("docs"), false).unwrap();
    assert!(others.is_empty());
    // No area asked: the first one's.
    assert_eq!(crate::areas::area_folders(&areas, None, false).unwrap().0, "");
    // No areas: the whole repository.
    assert_eq!(crate::areas::area_folders(&[], None, false), None);
    assert_eq!(scope_folders(&[], None, "", false), (String::new(), vec![]));
    assert_eq!(scope_folders(&[], None, "apps\\web", false).0, "apps/web");
}

#[test]
fn windows_folders_read_with_backslashes_and_any_case() {
    let areas = vec![
        area("app", "App", "/", None),
        area("site", "Site", "Web\\Site\\", Some(&["web/site/package.json"])),
        area("blog", "Blog", "web/site/blog", Some(&["web/site/blog/package.json"])),
    ];
    let folders = crate::areas::area_folders(&areas, Some("site"), true).unwrap();
    assert_eq!(folders.0, "Web/Site");
    assert_eq!(folders.1, vec!["web/site/blog"], "nested whatever the case on Windows");
    assert!(crate::areas::area_folders(&areas, Some("site"), false).unwrap().1.is_empty(), "case matters on a Mac");
    assert_eq!(
        pathspecs(&folders, "", true),
        vec![":(top,literal,icase)Web/Site".to_string(), ":(top,literal,icase,exclude)web/site/blog".to_string()]
    );
    assert_eq!(
        pathspecs(&crate::areas::area_folders(&areas, Some("app"), false).unwrap(), "", false),
        vec![":/", ":(top,literal,exclude)Web/Site", ":(top,literal,exclude)web/site/blog", ":(top,literal,exclude).atelier"]
    );
}

#[test]
fn a_patch_is_the_default_and_a_first_release_offers_its_file_s_version() {
    let none = |_: &str| false;
    let kinds = |v: &[VersionChoice]| v.iter().map(|c| (c.kind, c.tag.clone())).collect::<Vec<_>>();
    let v = version_choices(Some("3.0.1"), Some("3.0.1"), "site-", none);
    assert_eq!(kinds(&v), vec![
        (VersionKind::Patch, "site-v3.0.2".into()),
        (VersionKind::Minor, "site-v3.1.0".into()),
        (VersionKind::Major, "site-v4.0.0".into()),
    ]);
    // Never released: the file's version as it is, then the next ones (G2
    // walk: never 0.1.0 before the file's own version, which would be refused).
    let v = version_choices(Some("1.0.0"), None, "site-", none);
    assert_eq!(kinds(&v), vec![
        (VersionKind::AsIs, "site-v1.0.0".into()),
        (VersionKind::Patch, "site-v1.0.1".into()),
        (VersionKind::Minor, "site-v1.1.0".into()),
        (VersionKind::Major, "site-v2.0.0".into()),
    ]);
    assert_eq!(version_choices(Some("0.1.0"), None, "", none).len(), 1);
    // Never released and no version file (or one at 0.0.0): 0.1.0 first.
    for file in [None, Some("0.0.0")] {
        let v = version_choices(file, None, "", none);
        assert_eq!(v[0].kind, VersionKind::First);
        assert_eq!(v[0].version, "0.1.0");
    }
    // The file ahead of the tag: patch of the file, then the file as it is.
    let v = version_choices(Some("3.1.0"), Some("3.0.1"), "site-", none);
    assert_eq!(kinds(&v)[..2], [(VersionKind::Patch, "site-v3.1.1".into()), (VersionKind::AsIs, "site-v3.1.0".into())]);
    // …unless that tag exists.
    let v = version_choices(Some("3.1.0"), Some("3.0.1"), "site-", |t| t == "site-v3.1.0");
    assert!(v.iter().all(|c| c.kind != VersionKind::AsIs));
    // The default's tag exists: the next free patch comes first, the taken
    // one stays said.
    let v = version_choices(Some("3.0.1"), Some("3.0.1"), "site-", |t| t == "site-v3.0.2" || t == "site-v3.0.3");
    assert_eq!((v[0].tag.as_str(), v[0].taken), ("site-v3.0.4", false));
    assert_eq!((v[1].tag.as_str(), v[1].taken), ("site-v3.0.2", true));
    // L walk (Mac): every taken patch it skipped is said too, in order.
    assert_eq!((v[2].tag.as_str(), v[2].taken), ("site-v3.0.3", true));
    assert_eq!(v.iter().filter(|c| c.tag == "site-v3.0.3").count(), 1);
    // The walk's case: never released, the file at 1.0.0, v1.0.0–v1.0.2
    // taken. All three are listed once, each taken, before Minor and Major.
    let v = version_choices(Some("1.0.0"), None, "", |t| ["v1.0.0", "v1.0.1", "v1.0.2"].contains(&t));
    let tags: Vec<_> = v.iter().map(|c| (c.tag.as_str(), c.taken)).collect();
    assert_eq!(
        tags,
        [("v1.0.3", false), ("v1.0.0", true), ("v1.0.1", true), ("v1.0.2", true), ("v1.1.0", false), ("v2.0.0", false)]
    );
}

#[test]
fn only_this_area_s_ready_cards_are_kept() {
    let pending = vec![crate::ship::PendingShipCards {
        workspace_id: "ws".into(),
        card_ids: vec!["a".into(), "b".into(), "c".into()],
        areas: vec![
            crate::ship::PendingAreaCards {
                area: Some("site".into()),
                name: "Site".into(),
                card_ids: vec!["a".into()],
                refusal: None,
                branch: "main".into(),
                tag_prefix: "site-".into(),
            },
            crate::ship::PendingAreaCards {
                area: Some("app".into()),
                name: "App".into(),
                card_ids: vec!["b".into()],
                refusal: None,
                branch: "main".into(),
                tag_prefix: String::new(),
            },
            crate::ship::PendingAreaCards {
                area: None,
                name: String::new(),
                card_ids: vec!["c".into()],
                refusal: Some("no area".into()),
                branch: String::new(),
                tag_prefix: String::new(),
            },
        ],
    }];
    let areas = three_areas();
    assert_eq!(ready_of_area(&pending, &ship_area(&areas, "site")), vec!["a"]);
    assert_eq!(ready_of_area(&pending, &ship_area(&areas, "app")), vec!["b"]);
    assert!(ready_of_area(&pending, &ship_area(&areas, "docs")).is_empty());
    let plain = vec![crate::ship::PendingShipCards { workspace_id: "ws".into(), card_ids: vec!["a".into()], areas: vec![] }];
    assert_eq!(ready_of_area(&plain, &no_area()), vec!["a"]);
}

// ── On git ─────────────────────────────────────────────────────────────

/// GitHub's main after `site-v3.0.1`, in the site unless said:
/// card A squashed (#382), a direct commit, card B merged (#385), card C
/// rebased (two commits, merge commit known), an other pull request
/// squashed (#386, by dependabot), an other pull request merged (#387), a
/// commit at the root, one in the docs, and an `-unverified` tag between.
/// Returns the cards.
fn github_history(w: &World) -> Vec<KanbanCard> {
    let g = &w.github;
    g.commit_as(&[("site/a.txt", "a")], &["Privacy: list Google Cloud KMS (#382)"], "Matteo", "GitHub", None);
    g.git(&["tag", "site-v3.0.2-unverified"]);
    g.commit(&[("site/footer.txt", "typo")], "Fix a typo in the footer");
    // Card B: a merge commit.
    g.git(&["checkout", "-q", "-b", "card-b"]);
    g.commit(&[("site/b.txt", "b")], "feat: pricing page");
    g.git(&["checkout", "-q", "main"]);
    g.merge("card-b", "Merge pull request #385 from owner/card-b", "Pricing page: add the viewport line");
    // Card C: rebased, two commits GitHub wrote in the same second.
    let at = g.tick();
    g.commit_as(&[("site/c1.txt", "1")], &["feat: home page part 1"], "Matteo", "GitHub", Some(&at));
    let c_merge = g.commit_as(&[("site/c2.txt", "2")], &["feat: home page part 2"], "Matteo", "GitHub", Some(&at));
    // Not from a card.
    g.commit_as(&[("site/lock.json", "x")], &["Bump astro to 5.14 (#386)"], "dependabot", "GitHub", None);
    g.git(&["checkout", "-q", "-b", "deps"]);
    g.commit_as(&[("site/deps.txt", "d")], &["chore: bump sharp"], "renovate", "renovate", None);
    g.git(&["checkout", "-q", "main"]);
    g.merge("deps", "Merge pull request #387 from renovate/deps", "Bump sharp to 0.34");
    g.commit(&[("README.md", "hello again")], "Say hello again");
    g.commit(&[("the docs/guide.md", "g")], "Write the guide");
    g.git(&["push", "-q", "origin", "main", "--tags"]);
    vec![
        with_pr(card("A", "Privacy: list Google Cloud KMS"), 382, None),
        with_pr(card("B", "Pricing page: add the viewport line"), 385, None),
        with_pr(card("C", "Home page: say hello"), 388, Some(&c_merge)),
        card("D", "Not shipped yet"),
    ]
}

#[test]
fn each_area_counts_what_reached_main_in_its_folder_since_its_last_tag() {
    let w = world();
    let cards = github_history(&w);
    let areas = three_areas();

    let site = read_scope(&w, &areas, &ship_area(&areas, "site"), &cards, true);
    assert_eq!(site.refusal, None);
    assert!(site.fetch_problem.is_none());
    assert_eq!(site.since_tag.as_deref(), Some("site-v3.0.1"), "never the -unverified tag");
    assert!(site.since_at.is_some());
    assert_eq!(site.folder.as_deref(), Some("site"));
    let (cards_in, others) = titles(&site);
    assert_eq!(cards_in, vec!["A", "B", "C"], "squash, merge and rebase, oldest first");
    assert_eq!(others, vec!["Fix a typo in the footer", "Bump astro to 5.14 (#386)", "Bump sharp to 0.34"]);
    let c = site.cards.iter().find(|c| c.card_id == "C").unwrap();
    assert_eq!(c.commits.len(), 2, "both rebased commits are the card's");
    assert_eq!(c.pr_number, Some(388));
    assert_eq!(site.cards[1].title, "Pricing page: add the viewport line");
    let bump = &site.other_changes[1];
    assert_eq!((bump.pr_number, bump.author.as_str()), (Some(386), "dependabot"));
    let merged = &site.other_changes[2];
    assert_eq!((merged.pr_number, merged.author.as_str()), (Some(387), "renovate"), "a merge's author is its branch's");
    assert_eq!(site.other_changes[0].pr_number, None, "a direct commit");
    assert_eq!(site.current_version, "3.0.1");
    assert_eq!(site.version_source.as_deref(), Some("site/package.json"));
    assert!(site.version_on_github);
    assert_eq!(site.versions[0].tag, "site-v3.0.2");
    assert_eq!(site.versions[0].kind, VersionKind::Patch);

    // The root area: everything outside the site's and the docs' folders.
    let app = read_scope(&w, &areas, &ship_area(&areas, "app"), &cards, true);
    assert_eq!(app.since_tag.as_deref(), Some("v1.0.0"));
    assert_eq!(app.folder.as_deref(), Some(""));
    assert_eq!(titles(&app), (vec![], vec!["Say hello again".to_string()]));
    assert_eq!(app.versions[0].tag, "v1.0.1");

    // A folder with a space, never released: everything in it so far.
    let docs = read_scope(&w, &areas, &ship_area(&areas, "docs"), &cards, true);
    assert_eq!(docs.since_tag, None);
    assert_eq!(titles(&docs).1, vec!["init", "Write the guide"]);
    assert_eq!(docs.versions[0].kind, VersionKind::AsIs);
    assert_eq!(docs.versions[0].tag, "docs-v1.0.0");
    assert_eq!(docs.versions[1].tag, "docs-v1.0.1");
}

#[test]
fn github_s_tags_are_fetched_and_a_new_tag_resets_the_count() {
    let w = world();
    let cards = github_history(&w);
    let areas = three_areas();
    // Another computer released the site at GitHub's tip.
    w.github.git(&["tag", "site-v3.0.2"]);
    w.github.git(&["push", "-q", "origin", "site-v3.0.2"]);
    let site = read_scope(&w, &areas, &ship_area(&areas, "site"), &cards, true);
    assert_eq!(site.since_tag.as_deref(), Some("site-v3.0.2"));
    assert!(site.cards.is_empty() && site.other_changes.is_empty(), "nothing new since");
    assert_eq!(site.versions[0].tag, "site-v3.0.3");
    assert!(version_choices(Some("3.0.1"), Some("3.0.1"), "site-", |t| tag_exists(&w.here.path, t))[1].taken);
}

#[test]
fn a_card_is_known_by_its_landed_commit_and_by_its_trailer() {
    let w = world();
    let g = &w.github;
    let landed = g.commit(&[("site/land.txt", "l")], "feat: land it");
    g.commit_as(&[("site/t.txt", "t")], &["feat: from a trailer", "Card: T"], "Matteo", "Matteo", None);
    g.commit_as(&[("site/u.txt", "u")], &["feat: gone card", "Card: GONE"], "Matteo", "Matteo", None);
    g.git(&["push", "-q", "origin", "main"]);
    let mut land = card("L", "Land it");
    land.commit_sha = Some(landed);
    let cards = vec![land, card("T", "From a trailer")];
    let areas = three_areas();
    let site = read_scope(&w, &areas, &ship_area(&areas, "site"), &cards, true);
    assert_eq!(titles(&site), (vec!["L".into(), "T".into()], vec!["feat: gone card".into()]));
}

#[test]
fn release_commits_on_main_are_left_out() {
    let w = world();
    let g = &w.github;
    g.commit(&[("site/x.txt", "x")], "Fix x");
    g.git(&["checkout", "-q", "-b", "plyloft/release-site-v3.0.2"]);
    g.commit(&[("site/package.json", r#"{"version":"3.0.2"}"#)], "chore(release): site-v3.0.2");
    g.git(&["checkout", "-q", "main"]);
    g.merge("plyloft/release-site-v3.0.2", "Merge pull request #391 from owner/plyloft/release-site-v3.0.2", "chore(release): site-v3.0.2");
    g.commit(&[("package.json", r#"{"version":"1.0.1"}"#)], "chore(release): v1.0.1 (#392)");
    g.git(&["push", "-q", "origin", "main"]);
    let areas = three_areas();
    let site = read_scope(&w, &areas, &ship_area(&areas, "site"), &[], true);
    assert_eq!(titles(&site).1, vec!["Fix x"]);
    assert_eq!(site.current_version, "3.0.2", "the version file on GitHub");
    let app = read_scope(&w, &areas, &ship_area(&areas, "app"), &[], true);
    assert!(app.other_changes.is_empty());
}

#[test]
fn this_computer_s_main_is_compared_with_github_s() {
    let w = world();
    let areas = three_areas();
    let site_area = ship_area(&areas, "site");
    // Level.
    let s = read_scope(&w, &areas, &site_area, &[], true);
    assert_eq!((s.local_ahead, s.local_behind, s.diverged), (Some(0), Some(0), false));
    // Behind by 2.
    w.github.commit(&[("site/1.txt", "1")], "one");
    w.github.commit(&[("site/2.txt", "2")], "two");
    w.github.git(&["push", "-q", "origin", "main"]);
    let s = read_scope(&w, &areas, &site_area, &[], true);
    assert_eq!((s.local_ahead, s.local_behind, s.diverged), (Some(0), Some(2), false));
    assert_eq!(s.other_changes.len(), 2, "counted on GitHub's main, not this computer's");
    // Ahead by 1 once caught up.
    w.here.git(&["merge", "-q", "--ff-only", "origin/main"]);
    w.here.commit(&[("site/local.txt", "l")], "local only");
    let s = read_scope(&w, &areas, &site_area, &[], true);
    assert_eq!((s.local_ahead, s.local_behind, s.diverged), (Some(1), Some(0), false));
    // Both moved on.
    w.github.commit(&[("site/3.txt", "3")], "three");
    w.github.git(&["push", "-q", "origin", "main"]);
    let s = read_scope(&w, &areas, &site_area, &[], true);
    assert_eq!((s.local_ahead, s.local_behind, s.diverged), (Some(1), Some(1), true));
}

#[test]
fn without_github_this_computer_s_main_is_counted_whole() {
    let w = world();
    w.here.commit(&[("site/here.txt", "h")], "Made here");
    w.here.commit(&[("README.md", "root")], "At the root");
    // Not fetched: GitHub's change isn't seen.
    w.github.commit(&[("other.txt", "o")], "On the origin only");
    w.github.git(&["push", "-q", "origin", "main"]);
    let s = read_scope(&w, &[], &no_area(), &[], false);
    assert_eq!(s.folder.as_deref(), Some(""), "no areas, at the root: the whole repository");
    assert_eq!(s.since_tag.as_deref(), Some("v1.0.0"));
    assert_eq!(titles(&s).1, vec!["Made here", "At the root"]);
    assert!(!s.through_github && !s.version_on_github);
    assert_eq!(s.version_source.as_deref(), Some("package.json"));
}

#[test]
fn an_unreachable_github_says_so_and_counts_what_was_seen() {
    let w = world();
    w.here.git(&["remote", "set-url", "origin", "/nowhere/at/all.git"]);
    let areas = three_areas();
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &[], true);
    assert_eq!(s.fetch_problem.as_deref(), Some(fetch_problem_words("main").as_str()));
    assert_eq!(s.refusal, None);
    assert_eq!(s.since_tag.as_deref(), Some("site-v3.0.1"));
}

#[test]
fn a_missing_target_branch_is_a_refusal() {
    let w = world();
    let mut a = no_area();
    a.config.target_branch = "staging".into();
    let s = read_scope(&w, &[], &a, &[], false);
    assert_eq!(s.refusal.as_deref(), Some(no_target_words("staging", false).as_str()));
}

#[test]
fn a_recorded_release_is_in_flight_for_its_own_area_only() {
    let w = world();
    let areas = three_areas();
    let record: PendingRelease = serde_json::from_value(serde_json::json!({
        "version": "3.0.2",
        "tag": "site-v3.0.2",
        "commitSha": "",
        "branch": "main",
        "cardIds": [],
        "releaseKind": "github",
        "createdAt": 0,
        "pr": { "step": "open", "branch": "plyloft/release-site-v3.0.2", "number": 391 }
    }))
    .unwrap();
    let read_with = |id: &str| {
        let area = ship_area(&areas, id);
        let place = place_for(&w.here.path, &areas, &area, false, "");
        read(&place, &[], Vec::new(), Some(record.clone()), true)
    };
    let site = read_with("site");
    let flight = site.in_flight.unwrap();
    assert_eq!((flight.tag.as_str(), flight.pr_number, flight.step), ("site-v3.0.2", Some(391), Some(PrReleaseStep::Open)));
    assert!(site.busy);
    assert_eq!(read_with("app").in_flight, None);
}

#[test]
fn the_scope_is_said_in_camel_case() {
    let json = serde_json::to_value(ReleaseScope::default()).unwrap();
    for key in ["sinceTag", "otherChanges", "readyCardIds", "localAhead", "localBehind", "diverged", "versionSource", "inFlight", "refusal"] {
        assert!(json.get(key).is_some(), "{key}");
    }
    let _ = Path::new(".");
}

// ── Round 1 ────────────────────────────────────────────────────────────

#[test]
fn plyloft_s_shared_config_commits_are_never_a_change_but_a_mixed_one_is() {
    let w = world();
    let g = &w.github;
    // A direct chore(config) commit (the channel's push).
    g.commit(&[(".atelier/workspace.json", "{\"a\":1}")], "chore(config): set the areas");
    // The channel's pull request, merged…
    g.git(&["checkout", "-q", "-b", "atelier/config-areas-1"]);
    g.commit(&[(".atelier/workspace.json", "{\"a\":2}")], "chore(config): set the areas again");
    g.git(&["checkout", "-q", "main"]);
    g.merge("atelier/config-areas-1", "Merge pull request #12 from owner/atelier/config-areas-1", "Settings: Areas");
    // …and squashed.
    g.commit(&[(".atelier/workspace.json", "{\"a\":3}")], "Settings: Areas (#13)");
    // A skill on the same channel, and the instruction files.
    g.commit(&[(".claude/skills/x/SKILL.md", "s"), ("AGENTS.md", "rules")], "chore(config): add the skill x");
    // A person's commit in the same shape that also changes code.
    g.commit(&[(".atelier/workspace.json", "{\"a\":4}"), ("src/app.ts", "code")], "chore(config): areas and a fix");
    g.git(&["push", "-q", "origin", "main"]);
    for (areas, area) in [(three_areas(), ship_area(&three_areas(), "app")), (vec![], no_area())] {
        let s = read_scope(&w, &areas, &area, &[], true);
        assert_eq!(titles(&s).1, vec!["chore(config): areas and a fix"], "areas: {}", areas.len());
        assert_eq!(s.other_total, 1);
    }
    assert!(pathspecs(&(String::new(), vec![]), "", false).contains(&":(top,literal,exclude).atelier".to_string()));
}

#[test]
fn a_count_git_cant_read_says_so_in_words() {
    let w = world();
    // The area's latest tag names a commit this copy doesn't have: git
    // can't count.
    fs::write(w.here.path.join(".git/refs/tags/site-v3.0.9"), "1234567890123456789012345678901234567890\n").unwrap();
    let areas = three_areas();
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &[], false);
    assert_eq!(
        s.count_problem.as_deref(),
        Some("Plyloft couldn't read what changed since site-v3.0.9. Try again in a moment.")
    );
    assert!(s.cards.is_empty() && s.other_changes.is_empty());
}

#[test]
fn a_same_second_pull_request_before_a_rebase_is_not_the_card_s() {
    let w = world();
    let g = &w.github;
    let at = g.tick();
    g.commit_as(&[("site/lock.json", "x")], &["Bump astro to 5.14 (#386)"], "dependabot", "GitHub", Some(&at));
    g.commit_as(&[("site/o.txt", "o")], &["feat: other card's", "Card: E"], "Matteo", "GitHub", Some(&at));
    g.commit_as(&[("site/c1.txt", "1")], &["feat: home page part 1"], "Matteo", "GitHub", Some(&at));
    let c_merge = g.commit_as(&[("site/c2.txt", "2")], &["feat: home page part 2"], "Matteo", "GitHub", Some(&at));
    g.git(&["push", "-q", "origin", "main"]);
    let areas = three_areas();
    let rebased = with_pr(card("C", "Home page"), 388, Some(&c_merge));
    let cards = vec![rebased.clone(), card("E", "Other card")];
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &cards, true);
    let c = s.cards.iter().find(|c| c.card_id == "C").unwrap();
    assert_eq!(c.commits.len(), 2, "only its own two commits");
    assert!(s.cards.iter().any(|c| c.card_id == "E"), "another card's trailer stays that card's");
    assert_eq!(titles(&s).1, vec!["Bump astro to 5.14 (#386)"]);
    // A card known to squash never takes its neighbours.
    let mut squashed = rebased;
    squashed.pr.as_mut().unwrap().merge_method = Some(crate::merge_method::MergeMethod::Squash);
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &[squashed], true);
    assert_eq!(s.cards[0].commits.len(), 1);
    assert_eq!(s.other_total, 3);
}

#[test]
fn without_areas_a_workspace_in_a_folder_counts_its_folder() {
    let w = world();
    w.here.commit(&[("apps/web/index.ts", "w")], "In the folder");
    w.here.commit(&[("README.md", "r")], "Outside it");
    let s = read_scope_in(&w, &[], &no_area(), &[], false, "apps/web/");
    assert_eq!(s.folder.as_deref(), Some("apps/web"));
    assert_eq!(titles(&s).1, vec!["In the folder"]);
}

#[test]
fn a_shallow_copy_is_said_to_be_partial() {
    let w = world();
    let areas = three_areas();
    assert!(!read_scope(&w, &areas, &ship_area(&areas, "site"), &[], true).partial);
    w.github.commit(&[("site/x.txt", "x")], "one more");
    w.github.git(&["push", "-q", "origin", "main"]);
    let shallow = w._tmp.path().join("shallow");
    let origin = w._tmp.path().join("origin.git");
    let url = format!("file://{}", origin.display());
    let out = crate::platform::git_command()
        .args(["clone", "-q", "--depth", "1", &url, shallow.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let area = ship_area(&areas, "site");
    let place = place_for(&shallow, &areas, &area, true, "");
    let s = read(&place, &[], Vec::new(), None, false);
    assert!(s.partial);
    let still = crate::platform::git_command().args(["rev-parse", "--is-shallow-repository"]).current_dir(&shallow).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&still.stdout).trim(), "true", "never deepened");
}

#[test]
fn the_versions_read_are_said() {
    let w = world();
    let areas = three_areas();
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &[], true);
    assert_eq!((s.file_version.as_deref(), s.tag_version.as_deref()), (Some("3.0.1"), Some("3.0.1")));
    let d = read_scope(&w, &areas, &ship_area(&areas, "docs"), &[], true);
    assert_eq!((d.file_version.as_deref(), d.tag_version), (Some("1.0.0"), None));
}

#[test]
fn only_the_newest_other_changes_are_listed() {
    let w = world();
    for i in 0..(OTHER_CHANGES_MAX + 3) {
        w.here.commit(&[(&format!("site/{i}.txt"), "x")], &format!("change {i}"));
    }
    let areas = three_areas();
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &[], false);
    assert_eq!(s.other_total, OTHER_CHANGES_MAX + 3);
    assert_eq!(s.other_changes.len(), OTHER_CHANGES_MAX);
    assert_eq!(s.other_changes[0].title, "change 3");
    assert_eq!(s.other_changes.last().unwrap().title, format!("change {}", OTHER_CHANGES_MAX + 2));
}

#[test]
fn reads_at_the_same_time_share_one_fetch() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    let fetches = std::sync::Arc::new(AtomicUsize::new(0));
    let key = format!("test\0{}", std::process::id());
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let fetches = fetches.clone();
            let key = key.clone();
            std::thread::spawn(move || {
                shared_fetch(&key, Duration::from_secs(30), || {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(())
                })
            })
        })
        .collect();
    for t in threads {
        assert_eq!(t.join().unwrap(), Ok(()));
    }
    assert_eq!(fetches.load(Ordering::SeqCst), 1);
    // A zero time to live always fetches again.
    shared_fetch(&key, Duration::ZERO, || {
        fetches.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert_eq!(fetches.load(Ordering::SeqCst), 2);
}

#[test]
fn the_fetch_problem_names_this_machine() {
    assert_eq!(
        fetch_problem_words("main"),
        format!("Plyloft couldn't read main on GitHub just now, so this is what {} saw of it last.", crate::this_machine!())
    );
}

// ── Round 2 ────────────────────────────────────────────────────────────

#[test]
fn a_count_problem_names_the_tag_or_the_branch() {
    assert_eq!(
        count_problem_words(Some("site-v3.0.1"), "main"),
        "Plyloft couldn't read what changed since site-v3.0.1. Try again in a moment."
    );
    assert_eq!(count_problem_words(None, "main"), "Plyloft couldn't read what changed on main. Try again in a moment.");
    // A first release git can't count: a tree of its history is missing.
    let w = world();
    w.here.commit(&[("the docs/new.md", "n")], "A docs change");
    let tree = w.here.git(&["rev-parse", "HEAD^{tree}"]);
    let loose = w.here.path.join(".git/objects").join(&tree[..2]).join(&tree[2..]);
    fs::remove_file(&loose).unwrap();
    let areas = three_areas();
    let s = read_scope(&w, &areas, &ship_area(&areas, "docs"), &[], false);
    assert_eq!(s.since_tag, None);
    assert_eq!(s.count_problem.as_deref(), Some("Plyloft couldn't read what changed on main. Try again in a moment."));
}

#[test]
fn a_refused_area_in_the_list_keeps_its_name_prefix_and_branch() {
    let w = world();
    let areas = vec![area("app", "App", "/", None), area("site", "Site", "site/", None)];
    let ws = Workspace {
        repo_root: w.here.path.clone(),
        prefix: String::new(),
        areas: areas.clone(),
        cards: Vec::new(),
        pending: Vec::new(),
        record: None,
        busy: false,
        github: false,
        branch: "main".into(),
    };
    let releases: Vec<(Option<String>, Result<ShipArea, String>)> = ["app", "site"]
        .iter()
        .map(|id| {
            let mut c = KanbanCard::new("x".into(), "ws".into(), "x".into(), None, KanbanColumnId::Complete);
            c.area = Some(id.to_string());
            let resolved = crate::card_area::resolve_with(&config(&["package.json"]), &areas, None, &c);
            (Some(id.to_string()), crate::ship::ship_area_of(resolved, &areas))
        })
        .collect();
    let scopes = scopes_in(&ws, "ws", releases, std::time::Duration::ZERO);
    assert_eq!(scopes.len(), 2);
    assert_eq!(scopes[0].refusal, None);
    let site = &scopes[1];
    assert_eq!(site.refusal.as_deref(), Some("Site has no version file of its own. Add one in Settings › Project › Areas."));
    assert_eq!(
        (site.area.as_deref(), site.name.as_deref(), site.tag_prefix.as_str(), site.target_branch.as_str()),
        (Some("site"), Some("Site"), "site-", "main")
    );
}

#[test]
fn a_workspace_in_a_subfolder_leaves_out_its_own_shared_config() {
    let w = world();
    let h = &w.here;
    h.commit(&[("sub/.atelier/workspace.json", "{}")], "chore(config): set the areas");
    h.commit(&[("sub/.claude/skills/x/SKILL.md", "s"), ("sub/AGENTS.md", "r")], "chore(config): add the skill x");
    h.commit(&[("sub/src/app.ts", "code")], "Fix the app");
    h.commit(&[("sub/AGENTS.md", "r2"), ("sub/src/app.ts", "code 2")], "chore(config): rules and a fix");
    let s = read_scope_in(&w, &[], &no_area(), &[], false, "sub/");
    assert_eq!(s.folder.as_deref(), Some("sub"));
    assert_eq!(titles(&s).1, vec!["Fix the app", "chore(config): rules and a fix"]);
    assert_eq!(
        pathspecs(&(String::from("sub"), vec![]), "sub/", false),
        vec![":(top,literal)sub".to_string(), ":(top,literal,exclude)sub/.atelier".to_string()]
    );
    // A path outside the workspace's folder is never a config file.
    let c = Commit {
        sha: "s".into(),
        parents: vec!["p".into()],
        author: "a".into(),
        subject: "chore(config): x".into(),
        body: String::new(),
        committer: "c".into(),
        committed_at: 0,
    };
    assert!(is_config_only(&c, Some(&["sub/AGENTS.md".to_string()]), "sub"));
    assert!(!is_config_only(&c, Some(&["AGENTS.md".to_string()]), "sub"));
    assert!(is_config_only(&c, Some(&["AGENTS.md".to_string()]), ""));
}

#[test]
fn a_branch_github_doesn_t_have_is_a_refusal_not_a_fetch_problem() {
    let w = world();
    let mut a = no_area();
    a.config.target_branch = "staging".into();
    let s = read_scope(&w, &[], &a, &[], true);
    assert_eq!(s.refusal.as_deref(), Some(no_target_words("staging", true).as_str()));
    assert_eq!(s.fetch_problem, None);
}

#[test]
fn a_failed_fetch_is_shared_for_five_seconds_at_most() {
    use std::time::Duration;
    let ttl = Duration::from_secs(30);
    assert!(still_fresh(Duration::from_secs(20), true, ttl));
    assert!(still_fresh(Duration::from_secs(4), false, ttl));
    assert!(!still_fresh(Duration::from_secs(6), false, ttl));
    assert!(!still_fresh(Duration::from_secs(1), false, Duration::ZERO));
}

#[test]
fn only_the_newest_cards_are_listed() {
    let w = world();
    let mut cards = Vec::new();
    for i in 0..(CARDS_MAX + 2) {
        let id = format!("k{i}");
        w.here.commit_as(&[(&format!("site/{i}.txt"), "x")], &[&format!("feat: {i}"), &format!("Card: {id}")], "M", "M", None);
        cards.push(card(&id, &format!("Card {i}")));
    }
    let areas = three_areas();
    let s = read_scope(&w, &areas, &ship_area(&areas, "site"), &cards, false);
    assert_eq!(s.cards_total, CARDS_MAX + 2);
    assert_eq!(s.cards.len(), CARDS_MAX);
    assert_eq!(s.cards[0].card_id, "k2");
}

/// G2 walk (Mac) round 1: GitHub's release branches are listed once per
/// repository within the TTL, and not at all when the target couldn't be
/// fetched.
#[test]
fn release_branches_are_read_once_and_never_after_a_fetch_problem() {
    let repo = tempfile::tempdir().unwrap();
    let calls = std::cell::Cell::new(0);
    let list = || {
        calls.set(calls.get() + 1);
        Ok(["refs/heads/plyloft/release-v1.0.0".to_string()].into_iter().collect())
    };
    let ttl = std::time::Duration::from_secs(30);
    let a = super::release_branches_on_github(repo.path(), true, ttl, list);
    let b = super::release_branches_on_github(repo.path(), true, ttl, list);
    assert_eq!((calls.get(), a.len(), b.len()), (1, 1, 1));
    let other = tempfile::tempdir().unwrap();
    assert!(super::release_branches_on_github(other.path(), false, ttl, list).is_empty());
    assert_eq!(calls.get(), 1, "no read after a fetch problem");
}

/// Windows G2 walk: a release record's change forgets the listed release
/// branches — the next read lists them again.
#[test]
fn forgetting_the_release_branches_lists_them_again() {
    let repo = tempfile::tempdir().unwrap();
    let calls = std::cell::Cell::new(0);
    let list = || {
        calls.set(calls.get() + 1);
        Ok(std::collections::HashSet::new())
    };
    let ttl = std::time::Duration::from_secs(30);
    super::release_branches_on_github(repo.path(), true, ttl, list);
    super::release_branches_on_github(repo.path(), true, ttl, list);
    assert_eq!(calls.get(), 1);
    super::forget_release_branches(repo.path());
    super::release_branches_on_github(repo.path(), true, ttl, list);
    assert_eq!(calls.get(), 2, "listed again after a record changed");
}
