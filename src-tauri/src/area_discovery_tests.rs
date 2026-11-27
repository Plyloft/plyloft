//! 1.173.0 (B2): the two-products detection's fixtures — Lyra-like, one
//! product, nested packages, and the folders that never count.

use super::*;

fn none(_: &str) -> Option<String> {
    None
}

/// Lyra's tracked files that matter (2026-10-30): the app at the root
/// (Python, with a `frontend/` it builds), the Astro site with its own
/// Dockerfile, a second site folder with only a package.json, a database
/// image, skills' and examples' packages.
const LYRA: [&str; 16] = [
    "main.py",
    "requirements.txt",
    "frontend/package.json",
    "frontend/src/App.tsx",
    "frontend/catalyst-ui-kit 2/demo/typescript/package.json",
    "lyrappc-astro/Dockerfile",
    "lyrappc-astro/package.json",
    "lyrappc-astro/src/pages/index.astro",
    "lyrappc-website/package.json",
    "lyrappc-website/radiant-template/radiant-ts/package.json",
    "postgres/Dockerfile",
    "shopify/package.json",
    ".claude/skills/browser-check/package.json",
    "archive/old-site/package.json",
    "archive/old-site/Dockerfile",
    "README.md",
];

fn lyra_read(path: &str) -> Option<String> {
    (path == "lyrappc-astro/package.json").then(|| r#"{"dependencies":{"astro":"6.0.2"}}"#.to_string())
}

#[test]
fn lyra_holds_the_app_at_the_root_and_the_site_beside_it() {
    let found = detect(&LYRA, lyra_read).expect("two products");
    assert!(found.notice);
    assert_eq!(
        found.products,
        vec![
            Product { path: String::new(), kind: ProductKind::App },
            Product { path: "lyrappc-astro".into(), kind: ProductKind::Site },
        ]
    );
    let ids: Vec<_> = found.suggestion.iter().map(|a| (a.id.as_str(), a.name.as_str(), a.path.as_str())).collect();
    assert_eq!(ids, vec![("app", "App", ""), ("site", "Site", "lyrappc-astro")]);
    // What Settings › Areas would save keeps B1's rules.
    let check = crate::areas::check(&found.suggestion);
    assert!(check.errors.is_empty(), "{:?}", check.errors);
}

#[test]
fn one_product_is_no_notice() {
    let single = ["package.json", "Dockerfile", "src/main.ts", "frontend/package.json"];
    assert_eq!(detect(&single, none), None);
    // A root with nothing to ship and nothing beside it.
    assert_eq!(detect(&["README.md", "docs/index.md"], none), None);
    assert_eq!(detect::<&str>(&[], none), None);
}

#[test]
fn a_monorepos_nested_packages_are_one_product() {
    let monorepo = [
        "package.json",
        "pnpm-workspace.yaml",
        "packages/ui/package.json",
        "packages/core/package.json",
        "packages/core/src/index.ts",
        "apps/web/package.json",
    ];
    assert_eq!(detect(&monorepo, none), None);
}

#[test]
fn a_product_inside_another_is_part_of_the_outer_one() {
    let nested = [
        "pyproject.toml",
        "services/api/pyproject.toml",
        "services/api/Dockerfile",
        "services/api/worker/requirements.txt",
        "services/api/worker/Dockerfile",
    ];
    let found = detect(&nested, none).unwrap();
    let paths: Vec<_> = found.products.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, vec!["", "services/api"]);
    assert_eq!(found.suggestion.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["app", "api"]);
}

#[test]
fn hidden_dependency_example_and_deep_folders_never_count() {
    let files = [
        "package.json",
        ".github/actions/x/package.json",
        ".github/actions/x/Dockerfile",
        "node_modules/pkg/package.json",
        "node_modules/pkg/Dockerfile",
        "examples/demo/package.json",
        "examples/demo/Dockerfile",
        "tests/fixtures/app/package.json",
        "tests/fixtures/app/Dockerfile",
        "a/b/c/d/package.json",
        "a/b/c/d/Dockerfile",
    ];
    assert_eq!(detect(&files, none), None);
}

#[test]
fn without_a_root_product_there_is_no_notice_but_still_a_suggestion() {
    let files = ["apps/api/go.mod", "apps/api/fly.toml", "apps/site/package.json", "apps/site/vercel.json"];
    let found = detect(&files, none).unwrap();
    assert!(!found.notice, "the notice wants a product at the root");
    assert_eq!(
        found.products.iter().map(|p| (p.path.as_str(), p.kind)).collect::<Vec<_>>(),
        vec![("apps/api", ProductKind::App), ("apps/site", ProductKind::Site)]
    );
}

#[test]
fn two_of_a_kind_take_their_folders_names() {
    let files = [
        "Cargo.toml",
        "billing/package.json",
        "billing/Dockerfile",
        "Admin Panel/package.json",
        "Admin Panel/railway.json",
    ];
    let found = detect(&files, none).unwrap();
    let ids: Vec<_> = found.suggestion.iter().map(|a| (a.id.as_str(), a.name.as_str())).collect();
    assert_eq!(ids, vec![("app", "App"), ("admin-panel", "Admin Panel"), ("billing", "billing")]);
    assert!(crate::areas::check(&found.suggestion).errors.is_empty());
}

#[test]
fn windows_separators_and_a_site_by_its_name() {
    let files = ["package.json", "marketing-site\\package.json", "marketing-site\\netlify.toml"];
    let found = detect(&files, none).unwrap();
    assert_eq!(found.products[1], Product { path: "marketing-site".into(), kind: ProductKind::Site });
}

#[test]
fn a_reserved_folder_name_is_never_an_id() {
    let files = ["go.mod", "all/package.json", "all/Dockerfile", "default/package.json", "default/Dockerfile"];
    let found = detect(&files, none).unwrap();
    for area in &found.suggestion {
        assert!(!RESERVED_IDS.contains(&area.id.as_str()), "{}", area.id);
    }
    assert!(crate::areas::check(&found.suggestion).errors.is_empty(), "{:?}", crate::areas::check(&found.suggestion));
}

#[test]
fn a_monorepos_root_holds_its_products_and_is_none_itself() {
    let read = |path: &str| match path {
        "package.json" => Some(r#"{"private":true,"workspaces":["apps/*"]}"#.to_string()),
        "apps/web/package.json" => Some(r#"{"dependencies":{"astro":"6"}}"#.to_string()),
        _ => None,
    };
    let files = [
        "package.json",
        "apps/web/package.json",
        "apps/web/vercel.json",
        "apps/api/go.mod",
        "apps/api/Dockerfile.prod",
        "packages/ui/package.json",
    ];
    let found = detect(&files, read).expect("two products in its folders");
    assert!(found.notice, "a monorepo with two products is told");
    assert_eq!(
        found.products.iter().map(|p| (p.path.as_str(), p.kind)).collect::<Vec<_>>(),
        vec![("apps/api", ProductKind::App), ("apps/web", ProductKind::Site)]
    );
    assert!(crate::areas::check(&found.suggestion).errors.is_empty());
    // The workspace tools' files say the same without `workspaces`.
    for marker in MONOREPO_FILES {
        let files = [marker, "package.json", "a/Cargo.toml", "a/fly.toml", "b/pyproject.toml", "b/render.yaml"];
        let found = detect(&files, none).unwrap();
        assert!(found.notice, "{marker}");
        assert!(found.products.iter().all(|p| !p.path.is_empty()), "{marker}: the root is no product");
    }
    // One product in a monorepo's folders is one product.
    assert_eq!(detect(&["pnpm-workspace.yaml", "package.json", "apps/web/package.json", "apps/web/vercel.json"], none), None);
}

#[test]
fn container_files_in_any_case_and_the_newer_hosting_files() {
    for deploy in ["dockerfile", "DOCKERFILE", "Dockerfile.prod", "Containerfile", "render.yaml", "firebase.json", "nixpacks.toml"] {
        let file = format!("svc/{deploy}");
        let files = ["requirements.txt", "svc/package.json", file.as_str()];
        assert!(detect(&files, none).is_some(), "{deploy}");
    }
    // Google App Engine's app.yaml is too common a name to count.
    assert_eq!(detect(&["requirements.txt", "svc/package.json", "svc/app.yaml"], none), None);
}

#[test]
fn a_docs_folder_counts_only_as_a_website_of_its_own() {
    let site = |path: &str| (path == "docs/package.json").then(|| r#"{"devDependencies":{"vitepress":"1"}}"#.to_string());
    let files = ["Cargo.toml", "docs/package.json", "docs/netlify.toml"];
    let found = detect(&files, site).expect("the docs site");
    assert_eq!(found.products[1], Product { path: "docs".into(), kind: ProductKind::Site });
    // The code's own docs, even with a deploy file, are not.
    let plain = |path: &str| (path == "docs/package.json").then(|| r#"{"dependencies":{"typedoc":"1"}}"#.to_string());
    assert_eq!(detect(&files, plain), None);
    assert_eq!(detect(&["Cargo.toml", "docs/package.json"], site), None, "no deploy file of its own");
}

#[test]
fn git_lists_only_the_names_detect_reads_case_blind() {
    let specs = pathspecs();
    assert!(specs.contains(&"*package.json".to_string()));
    assert!(specs.contains(&":(icase)*dockerfile*".to_string()));
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for file in ["requirements.txt", "site/package.json", "site/DOCKERFILE", "site/src/index.astro", "README.md"] {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
    }
    let git = |args: &[&str]| {
        let ok = crate::platform::git_command().args(args).current_dir(root).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    let out = crate::platform::git_command()
        .args(["-c", "core.quotepath=off", "ls-files", "-z", "--"])
        .args(&specs)
        .current_dir(root)
        .output()
        .unwrap();
    let listed = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut files: Vec<&str> = listed.split('\0').filter(|f| !f.is_empty()).collect();
    files.sort();
    assert_eq!(files, vec!["requirements.txt", "site/DOCKERFILE", "site/package.json"]);
    let found = discover(root.to_str().unwrap()).expect("two products");
    assert_eq!(found.products.len(), 2);
}

#[test]
fn the_suggestion_is_written_out_for_settings_areas() {
    use crate::project_config::VersionFileKind;
    let read = |path: &str| match path {
        "lyrappc-astro/package.json" => {
            Some(r#"{"homepage":"https://www.lyrappc.com","dependencies":{"astro":"6.0.2"}}"#.to_string())
        }
        "package.json" => Some(r#"{"homepage":"not a web address"}"#.to_string()),
        _ => None,
    };
    let files = ["package.json", "requirements.txt", "lyrappc-astro/package.json", "lyrappc-astro/pyproject.toml", "lyrappc-astro/Dockerfile"];
    let found = detect(&files, read).unwrap();
    let [app, site] = &found.suggestion[..] else { panic!("{:?}", found.suggestion) };
    // The first area keeps vX.Y.Z and the workspace's version files.
    assert_eq!(app.tag_prefix.as_deref(), Some(""));
    assert_eq!(app.label.as_deref(), Some("area:app"));
    assert_eq!(app.version_files, None);
    assert_eq!(app.look_at, None, "a homepage that isn't a web address is left out");
    assert_eq!(site.tag_prefix.as_deref(), Some("site-"));
    assert_eq!(site.label.as_deref(), Some("area:site"));
    assert_eq!(site.look_at.as_deref(), Some("https://www.lyrappc.com"));
    let versions: Vec<_> = site.version_files.as_ref().unwrap().iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert_eq!(
        versions,
        vec![("lyrappc-astro/package.json", VersionFileKind::PackageJson), ("lyrappc-astro/pyproject.toml", VersionFileKind::PyProjectToml)]
    );
    let check = crate::areas::check(&found.suggestion);
    assert!(check.errors.is_empty() && check.warnings.is_empty(), "{check:?}");
}

#[test]
fn a_homepage_on_a_code_host_is_not_where_to_look_at_it() {
    for (homepage, kept) in [
        ("https://github.com/o/site#readme", false),
        ("https://www.github.com/o/site", false),
        ("http://GitLab.com/o/site", false),
        ("https://bitbucket.org/o/site", false),
        ("https://o.github.io/site", true),
        ("https://www.lyrappc.com", true),
    ] {
        let manifest = format!(r#"{{"homepage":"{homepage}"}}"#);
        let read = |path: &str| (path == "site/package.json").then(|| manifest.clone());
        let found = detect(&["go.mod", "site/package.json", "site/Dockerfile"], read).unwrap();
        assert_eq!(found.suggestion[1].look_at.is_some(), kept, "{homepage}");
    }
}

/// 1.174.0 (C10 walk, step 12): the solo sandbox — a local repository with
/// no origin, an app at the root and a static site beside it with only its
/// package.json and its page. The site ships on its own.
const SOLO: [&str; 4] = ["package.json", "site/index.html", "site/package.json", "sum.js"];

fn solo_read(path: &str) -> Option<String> {
    match path {
        "package.json" => Some(r#"{"name":"solo-mono","version":"0.1.0","scripts":{"test":"node -e \"console.log(1)\""}}"#.into()),
        "site/package.json" => Some(r#"{"name":"solo-site","version":"0.1.0"}"#.into()),
        _ => None,
    }
}

#[test]
fn a_static_site_beside_the_app_is_a_product_without_a_deploy_file() {
    let found = detect(&SOLO, solo_read).expect("the app and the site");
    assert!(found.notice);
    assert_eq!(
        found.products,
        vec![
            Product { path: String::new(), kind: ProductKind::App },
            Product { path: "site".into(), kind: ProductKind::Site },
        ]
    );
    let [_, site] = &found.suggestion[..] else { panic!("{:?}", found.suggestion) };
    let versions: Vec<_> = site.version_files.as_ref().expect("its own version file").iter().map(|f| f.path.as_str()).collect();
    assert_eq!(versions, vec!["site/package.json"]);
}

#[test]
fn a_page_beside_a_package_is_not_a_site_unless_the_folder_is_one() {
    // A Vite frontend the root app builds has both, and stays part of it.
    assert_eq!(detect(&["package.json", "frontend/package.json", "frontend/index.html"], none), None);
    // docs/ is the code's documentation without a deploy file of its own.
    assert_eq!(detect(&["Cargo.toml", "docs/package.json", "docs/index.html"], none), None);
    // A site folder without its page is still part of the product around it.
    assert_eq!(detect(&["package.json", "site/package.json"], none), None);
    // "site" inside another word is not a site's name.
    assert_eq!(detect(&["package.json", "composite-ui/package.json", "composite-ui/index.html"], none), None);
    // A page in a folder that never holds a product (examples, hidden).
    assert_eq!(detect(&["package.json", "examples/site/package.json", "examples/site/index.html"], none), None);
}

#[test]
fn a_site_word_is_a_whole_part_of_the_folder_s_name() {
    let found = detect(&["package.json", "lyrappc-website/package.json", "lyrappc-website/index.html"], none)
        .expect("the website beside the app");
    assert_eq!(found.products[1], Product { path: "lyrappc-website".into(), kind: ProductKind::Site });
    // A site generator stands in for the name; the page is still needed.
    let astro = |path: &str| (path == "web/package.json").then(|| r#"{"dependencies":{"astro":"6"}}"#.to_string());
    assert!(detect(&["package.json", "web/package.json", "web/index.html"], astro).is_some());
    assert_eq!(detect(&["package.json", "web/package.json"], astro), None);
}

#[test]
fn the_solo_sandbox_is_found_from_git_with_no_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for file in SOLO {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, solo_read(file).unwrap_or_else(|| "<h1>Site</h1>".into())).unwrap();
    }
    let git = |args: &[&str]| {
        let ok = crate::platform::git_command().args(args).current_dir(root).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"]);
    let found = discover(root.to_str().unwrap()).expect("two products");
    assert_eq!(found.products.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(), vec!["", "site"]);
}
