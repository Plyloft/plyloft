//! Tests for areas (1.173.0 B1).

use super::*;
use crate::project_config::VersionFileKind;

fn area(id: &str, path: &str) -> AreaDef {
    AreaDef { id: id.into(), name: id.to_uppercase(), path: path.into(), ..Default::default() }
}

fn file(path: &str) -> VersionFileEntry {
    VersionFileEntry { path: path.into(), kind: VersionFileKind::PackageJson, variable_name: None }
}

/// The two products of the walk's sandbox: the app at the root, the site in
/// its folder (mockup scene 3).
fn lyra() -> Vec<AreaDef> {
    vec![
        AreaDef {
            target_branch: Some("staging".into()),
            version_files: Some(vec![file("frontend/package.json"), file("main.py")]),
            look_at: Some("https://lyra-jun-2025-staging.up.railway.app".into()),
            ..area("app", "/")
        },
        AreaDef {
            name: "Site".into(),
            target_branch: Some("main".into()),
            version_files: Some(vec![file("lyrappc-astro/package.json")]),
            look_at: Some("https://www.lyrappc.com".into()),
            ..area("site", "lyrappc-astro/")
        },
    ]
}

fn config() -> ProjectConfig {
    let mut cfg = crate::project_config::default_atelier_config();
    cfg.target_branch = "develop".into();
    cfg.version_files = vec![file("package.json")];
    cfg
}

#[test]
fn folders_normalize_to_one_form() {
    for (raw, want) in [
        ("", ""),
        ("/", ""),
        ("./", ""),
        (".", ""),
        ("lyrappc-astro/", "lyrappc-astro"),
        ("/lyrappc-astro", "lyrappc-astro"),
        ("./apps//site/", "apps/site"),
        ("apps\\site", "apps/site"),
        (" apps/site ", "apps/site"),
    ] {
        assert_eq!(normalize_path(raw), want, "{raw:?}");
    }
    assert!(area("a", "/").is_root() && area("a", "").is_root() && !area("a", "x").is_root());
}

#[test]
fn the_sandbox_s_two_areas_pass_the_rules() {
    let found = check(&lyra());
    assert!(found.ok(), "{found:?}");
    assert!(found.warnings.is_empty(), "{found:?}");
    assert!(found.ok() && AreaCheck::default().ok());
}

#[test]
fn ids_are_unique_slugs() {
    let found = check(&[area("Site App", "a"), area("ok", "b"), area("ok", "c"), area("-x", "d")]);
    let ids: Vec<_> = found.errors.iter().filter(|p| p.field == "id").map(|p| p.area.clone().unwrap()).collect();
    assert_eq!(ids, vec!["Site App", "ok", "-x"], "{found:?}");
    assert!(found.errors[0].message.contains("lowercase letters, digits and dashes"));
    assert!(!check(&[area(&"a".repeat(ID_MAX), "x")]).errors.iter().any(|p| p.field == "id"));
    assert!(check(&[area(&"a".repeat(ID_MAX + 1), "x")]).errors.iter().any(|p| p.field == "id"));
}

#[test]
fn one_root_area_at_most_and_folders_never_overlap() {
    let two_roots = check(&[area("app", ""), area("site", "/")]);
    assert_eq!(two_roots.errors.len(), 1, "{two_roots:?}");
    assert!(two_roots.errors[0].message.contains("both take the whole repository"));

    let nested = check(&[area("app", ""), area("site", "web"), area("blog", "web/blog")]);
    assert_eq!(nested.errors.len(), 1, "{nested:?}");
    assert!(nested.errors[0].message.contains("overlap"), "{nested:?}");
    assert_eq!(nested.errors[0].area.as_deref(), Some("blog"));

    let same = check(&[area("a", "web"), area("b", "web/")]);
    assert!(same.errors.iter().any(|p| p.message.contains("overlap")), "{same:?}");
    // A sibling that shares a prefix of letters is not inside.
    assert!(check(&[area("a", "web"), area("b", "website")]).ok());
    // The root holds the rest without overlapping anyone.
    assert!(check(&[area("app", "/"), area("a", "web"), area("b", "docs")]).ok());
    // No root at all is allowed: files outside every area belong to none.
    assert!(check(&[area("a", "web"), area("b", "docs")]).ok());
}

#[test]
fn a_folder_outside_the_repository_is_refused() {
    for bad in ["../other", "web/../../x", "C:\\repo\\web", "c:/web"] {
        let found = check(&[area("a", bad)]);
        assert!(found.errors.iter().any(|p| p.field == "path"), "{bad}: {found:?}");
    }
}

#[test]
fn labels_default_to_area_id_and_must_differ() {
    let resolved = resolve(&lyra(), "develop");
    assert_eq!(resolved[0].label, "area:app");
    assert_eq!(resolved[1].label, "area:site");
    let mut list = lyra();
    list[1].label = Some("area:app".into());
    let found = check(&list);
    assert!(found.errors.iter().any(|p| p.field == "label"), "{found:?}");
    list[1].label = Some("  website ".into());
    assert_eq!(resolve(&list, "develop")[1].label, "website");
}

/// Decision 4 is the default: the first area `vX.Y.Z`, the others
/// `<id>-vX.Y.Z`. An explicit prefix wins at any position, "" included, so
/// reordering the list never retags (Challenger 3).
#[test]
fn an_explicit_tag_prefix_wins_and_the_default_is_decision_4() {
    let resolved = resolve(&lyra(), "develop");
    assert_eq!((resolved[0].tag_prefix.as_str(), resolved[0].first), ("", true));
    assert_eq!((resolved[1].tag_prefix.as_str(), resolved[1].first), ("site-", false));

    let mut list = lyra();
    list[1].tag_prefix = Some("web/".into());
    assert_eq!(resolve(&list, "develop")[1].tag_prefix, "web/");
    assert!(check(&list).ok());
    // The first area's own prefix is used; no area is then tagged vX.Y.Z.
    list[0].tag_prefix = Some("app-".into());
    assert_eq!(resolve(&list, "develop")[0].tag_prefix, "app-");
    let found = check(&list);
    assert!(found.ok(), "{found:?}");
    assert!(found.warnings.iter().any(|p| p.field == "tagPrefix" && p.message == "No area's releases are tagged plain v1.2.3: every release tag has a prefix."));
    // An explicit "" on the second area: it is the one tagged vX.Y.Z, even
    // after the list is reordered.
    list[1].tag_prefix = Some(String::new());
    assert!(check(&list).ok() && check(&list).warnings.iter().all(|p| p.field != "tagPrefix"));
    list.reverse();
    assert_eq!(resolve(&list, "develop")[0].tag_prefix, "", "site, now first, keeps its own");
    assert_eq!(resolve(&list, "develop")[1].tag_prefix, "app-");
    // Two areas tagged alike collide.
    list[1].tag_prefix = Some(String::new());
    assert!(check(&list).errors.iter().any(|p| p.field == "tagPrefix"));
    // Not a ref git takes.
    for bad in ["my site", "site.lock/", "-site", "a..b"] {
        list[1].tag_prefix = Some(bad.into());
        assert!(check(&list).errors.iter().any(|p| p.field == "tagPrefix"), "{bad}");
    }
}

/// B4: a tag reads back only as `<prefix>vX.Y.Z`, exactly.
#[test]
fn a_release_tag_reads_back_strictly() {
    assert_eq!(tag_for("site-", "3.0.2"), "site-v3.0.2");
    assert_eq!(release_version("", "v1.300.1").as_deref(), Some("1.300.1"));
    assert_eq!(release_version("site-", "site-v3.0.2").as_deref(), Some("3.0.2"));
    for (prefix, tag) in [
        ("", "vendor-v1.0.0"),
        ("", "site-v1.0.0"),
        ("site-", "v1.0.0"),
        ("site-", "site-v1.0"),
        ("site-", "site-v1.0.0-rc1"),
        ("site-", "site-v1..0"),
        ("", "v1.2.x"),
    ] {
        assert_eq!(release_version(prefix, tag), None, "{prefix:?} {tag}");
    }
}

#[test]
fn version_files_outside_the_folder_warn_and_do_not_refuse() {
    let mut list = lyra();
    list[1].version_files = Some(vec![file("lyrappc-astro/package.json"), file("frontend/package.json")]);
    // The app's (root) version file inside the site's folder is outside too.
    list[0].version_files = Some(vec![file("main.py"), file("lyrappc-astro/x.json")]);
    let found = check(&list);
    assert!(found.ok(), "warnings only: {found:?}");
    let words: Vec<_> = found.warnings.iter().map(|p| p.message.as_str()).collect();
    assert_eq!(
        words,
        vec![
            "lyrappc-astro/x.json is outside APP's folder (the whole repository).",
            "frontend/package.json is outside Site's folder (lyrappc-astro/).",
        ]
    );
    // An area after the first without files of its own would bump the workspace's.
    list[1].version_files = None;
    assert!(check_warns(&list, "site", "no version file of its own, so a release would change the whole repository's version."));
}

fn check_warns(list: &[AreaDef], id: &str, words: &str) -> bool {
    check(list).warnings.iter().any(|p| p.area.as_deref() == Some(id) && p.message.contains(words))
}

#[test]
fn the_longest_folder_wins_else_the_root_else_none() {
    let list = lyra();
    assert_eq!(area_of_path(&list, "lyrappc-astro/src/pages/index.astro").as_deref(), Some("site"));
    assert_eq!(area_of_path(&list, "lyrappc-astro").as_deref(), Some("site"));
    assert_eq!(area_of_path(&list, "lyrappc-astro-old/x").as_deref(), Some("app"));
    assert_eq!(area_of_path(&list, "AGENTS.md").as_deref(), Some("app"));
    assert_eq!(area_of_path(&list, "./frontend/src/App.tsx").as_deref(), Some("app"));
    assert_eq!(area_of_path(&list, "lyrappc-astro\\src\\x.ts").as_deref(), Some("site"), "Windows separators");
    // Longest of folders that hold it (a list `check` would refuse, still answered).
    let nested = vec![area("web", "web"), area("blog", "web/blog")];
    assert_eq!(area_of_path(&nested, "web/blog/post.md").as_deref(), Some("blog"));
    assert_eq!(area_of_path(&nested, "web/index.html").as_deref(), Some("web"));
    // No root: a file outside every folder belongs to none.
    assert_eq!(area_of_path(&nested, "README.md"), None);
    // No areas: the implicit area, which has no id.
    assert_eq!(area_of_path(&[], "anything"), None);
}

#[test]
fn an_area_s_config_takes_its_branch_and_files_and_falls_back_to_the_workspace() {
    let cfg = config();
    let AreaConfig::Area { area, config: site } = resolve_config(&cfg, &lyra(), Some("site")) else {
        panic!("the site is an area");
    };
    assert_eq!(site.target_branch, "main");
    assert_eq!(site.version_files, vec![file("lyrappc-astro/package.json")]);
    assert_eq!((area.id.as_str(), area.tag_prefix.as_str(), area.branch.as_str()), ("site", "site-", "main"));
    // Everything else is the workspace's.
    assert_eq!(site.install_script, cfg.install_script);
    assert_eq!(site.verify_pipeline, cfg.verify_pipeline);

    // An area without values of its own takes the workspace's.
    let mut list = lyra();
    list[0].target_branch = None;
    list[0].version_files = None;
    let app = resolve_config(&cfg, &list, Some("app"));
    assert_eq!(app.config().unwrap().target_branch, "develop");
    assert_eq!(app.config().unwrap().version_files, cfg.version_files);
    assert_eq!(app.tag_prefix(), Some(""));
    let AreaConfig::Area { area, .. } = app else { panic!() };
    assert_eq!((area.target_branch, area.branch.as_str()), (None, "develop"));

    // No id: the workspace's config exactly, tagged vX.Y.Z.
    for id in [None, Some(""), Some("  ")] {
        let out = resolve_config(&cfg, &lyra(), id);
        assert_eq!(out, AreaConfig::Implicit { config: cfg.clone() }, "{id:?}");
        assert_eq!(out.tag_prefix(), Some(""));
    }
    // An id the list doesn't hold is said, never read as the workspace's.
    let gone = resolve_config(&cfg, &lyra(), Some("gone"));
    assert_eq!(gone, AreaConfig::Unknown { id: "gone".into() });
    assert_eq!((gone.config(), gone.tag_prefix()), (None, None));
    assert_eq!(resolve_config(&cfg, &[], Some("site")), AreaConfig::Unknown { id: "site".into() });
}

#[test]
fn an_area_reads_with_only_id_and_keeps_keys_it_does_not_know() {
    let def: AreaDef = serde_json::from_str(r#"{ "id": "site", "futureKey": { "x": 1 } }"#).unwrap();
    assert_eq!((def.name.as_str(), def.path.as_str()), ("", ""));
    assert_eq!(def.display_name(), "site");
    assert!(def.is_root());
    let back = serde_json::to_value(&def).unwrap();
    assert_eq!(back, serde_json::json!({ "id": "site", "name": "", "path": "", "futureKey": { "x": 1 } }));
    // camelCase on disk.
    let text = serde_json::to_string(&lyra()[1]).unwrap();
    for key in ["\"targetBranch\"", "\"versionFiles\"", "\"lookAt\""] {
        assert!(text.contains(key), "{key} in {text}");
    }
    assert!(!text.contains("tagPrefix") && !text.contains("label"), "absent stays absent: {text}");
}

#[test]
fn normalizing_trims_and_drops_empty_texts() {
    let raw = AreaDef {
        id: " site ".into(),
        name: " Site ".into(),
        path: "./lyrappc-astro/".into(),
        target_branch: Some(" ".into()),
        tag_prefix: Some(" ".into()),
        label: Some("".into()),
        look_at: Some(" https://www.lyrappc.com ".into()),
        ..Default::default()
    };
    let n = raw.normalized();
    assert_eq!((n.id.as_str(), n.name.as_str(), n.path.as_str()), ("site", "Site", "lyrappc-astro"));
    assert_eq!((n.target_branch, n.label), (None, None));
    assert_eq!(n.tag_prefix.as_deref(), Some(""), "an explicit empty prefix stays");
    assert_eq!(n.look_at.as_deref(), Some("https://www.lyrappc.com"));
}

// ── This Mac's copy ────────────────────────────────────────────────────

fn store() -> (tempfile::TempDir, ProjectConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
    (dir, store)
}

#[test]
fn the_store_round_trips_atomically_and_keeps_unknown_keys() {
    let (_dir, store) = store();
    assert!(load(&store, "ws").is_empty(), "no file: no areas");
    save(&store, "ws", &lyra()).unwrap();
    assert_eq!(load(&store, "ws"), normalized(&lyra()));
    let file = path(&store, "ws");
    assert!(!file.with_file_name("areas.json.atelier-tmp").exists());
    // A key from a newer Plyloft survives a save here.
    let mut raw: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    raw["later"] = Value::from(1);
    std::fs::write(&file, serde_json::to_vec(&raw).unwrap()).unwrap();
    save(&store, "ws", &lyra()[..1]).unwrap();
    let raw: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(raw["later"], 1);
    assert_eq!(raw["schemaVersion"], 1);
    assert_eq!(load(&store, "ws").len(), 1);
    // Unreadable: none, until the next refresh writes the repository's —
    // and set aside beside it (CH-6), never written over.
    std::fs::write(&file, "{broken").unwrap();
    assert!(load(&store, "ws").is_empty());
    assert!(!file.exists(), "set aside, not left to be written over");
    let aside: Vec<String> = std::fs::read_dir(store.workspace_dir("ws"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("areas.json.unreadable-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    save_release_kind(&store, "ws", Some("github".into())).unwrap();
    assert_eq!(load_release_kind(&store, "ws").as_deref(), Some("github"), "a new file after it");
}

/// Tier 2 (v1.11.x template): an `areas.json` with only what 1.173.0 writes
/// loads; one without `areas` (or `schemaVersion`) loads as none.
#[test]
fn an_areas_file_without_its_fields_loads_as_none() {
    let (_dir, store) = store();
    std::fs::create_dir_all(store.workspace_dir("ws")).unwrap();
    std::fs::write(path(&store, "ws"), r#"{ "schemaVersion": 1 }"#).unwrap();
    assert!(load(&store, "ws").is_empty());
    std::fs::write(path(&store, "ws"), r#"{ "areas": [{ "id": "site", "path": "web" }] }"#).unwrap();
    assert_eq!(load(&store, "ws")[0].path, "web");
}

#[test]
fn only_a_shared_workspace_has_areas() {
    let (_dir, store) = store();
    save(&store, "ws", &lyra()).unwrap();
    assert!(for_workspace(&store, "ws").is_empty(), "a leftover file decides nothing");
    assert_eq!(view(&store, "ws", ""), AreasView::default());
    crate::team_models::share_for_test(&store, "ws", false);
    assert_eq!(for_workspace(&store, "ws").len(), 2);
    let v = view(&store, "ws", "");
    assert!(v.shared && !v.read_only && v.check.ok());
    assert_eq!(v.areas.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["APP", "Site"]);
    assert_eq!(v.defined, normalized(&lyra()));
    crate::team_models::share_for_test(&store, "ws", true);
    assert!(view(&store, "ws", "").read_only);
}

/// `project_config::config_for`: the area's branch and files, else the
/// workspace's; a workspace without areas is exactly `get`'s config.
#[test]
fn config_for_reads_the_store_and_the_workspace_config() {
    let (_dir, store) = store();
    assert!(crate::project_config::config_for(&store, "ws", None).is_none(), "no config: none");
    store.set("ws", config()).unwrap();
    let plain = crate::project_config::config_for(&store, "ws", None).unwrap();
    assert_eq!(plain, AreaConfig::Implicit { config: store.get("ws").unwrap() }, "no areas: the workspace's");
    assert!(matches!(crate::project_config::config_for(&store, "ws", Some("site")), Some(AreaConfig::Unknown { .. })));
    crate::team_models::share_for_test(&store, "ws", false);
    save(&store, "ws", &lyra()).unwrap();
    let site = crate::project_config::config_for(&store, "ws", Some("site")).unwrap();
    assert_eq!((site.config().unwrap().target_branch.as_str(), site.tag_prefix()), ("main", Some("site-")));
    let none = crate::project_config::config_for(&store, "ws", None).unwrap();
    assert_eq!(none.config(), store.get("ws").as_ref());
}

/// Challenger 6–9: the rest of the rules.
#[test]
fn reserved_ids_labels_branches_addresses_and_shares_are_refused() {
    for id in RESERVED_IDS {
        let found = check(&[area(id, "web")]);
        assert!(found.errors.iter().any(|p| p.field == "id" && p.message.contains("keeps for itself")), "{id}");
    }
    assert_eq!(IMPLICIT_AREA_ID, "default");
    // TX8 (T42): the field is called Name, so the words say name.
    let reserved = check(&[area(RESERVED_IDS[0], "web")]);
    assert!(reserved.errors.iter().any(|p| p.message.ends_with("give the area another name.")), "{:?}", reserved.errors);
    let twice = check(&[area("app", "web"), area("app", "web2")]);
    assert!(
        twice.errors.iter().any(|p| p.message == "Two areas are called “APP”: each needs its own name."),
        "{:?}",
        twice.errors
    );

    let labelled = |label: &str| {
        let mut list = lyra();
        list[1].label = Some(label.into());
        check(&list)
    };
    assert!(labelled("AREA:APP").errors.iter().any(|p| p.field == "label"), "case-insensitive");
    assert!(labelled(&"x".repeat(LABEL_MAX + 1)).errors.iter().any(|p| p.field == "label"));
    assert!(labelled(&"x".repeat(LABEL_MAX)).ok());
    assert!(labelled("site,web").errors.iter().any(|p| p.field == "label"));
    for own in ["status:done", "Status:todo", "plyloft:skill"] {
        assert!(labelled(own).errors.iter().any(|p| p.field == "label"), "{own}");
    }

    let branched = |branch: &str| {
        let mut list = lyra();
        list[1].target_branch = Some(branch.into());
        check(&list)
    };
    for good in ["main", "release/2026", "feature-x"] {
        assert!(branched(good).ok(), "{good}");
    }
    for bad in ["two words", "a..b", "-x", "x.lock", "a/.b", "x~1", "x:y", "@", "end/", "x@{1}"] {
        assert!(branched(bad).errors.iter().any(|p| p.field == "targetBranch"), "{bad}");
    }

    let looked = |url: &str| {
        let mut list = lyra();
        list[1].look_at = Some(url.into());
        check(&list)
    };
    assert!(looked("http://localhost:4321").ok());
    for bad in ["www.lyrappc.com", "file:///etc", "javascript:alert(1)", "https://"] {
        assert!(looked(bad).errors.iter().any(|p| p.field == "lookAt"), "{bad}");
    }

    for bad in ["  C:\\web", "\\\\server\\share", "//server/share"] {
        assert!(check(&[area("a", bad)]).errors.iter().any(|p| p.field == "path"), "{bad}");
    }
}

/// Challenger 5: version files are read from the workspace's folder.
#[test]
fn version_files_are_read_from_the_workspace_s_folder() {
    assert_eq!(repo_path("frontend", "package.json"), "frontend/package.json");
    assert_eq!(repo_path("", "./package.json"), "package.json");
    let list = vec![
        AreaDef { version_files: Some(vec![file("package.json")]), ..area("app", "frontend") },
        AreaDef { version_files: Some(vec![file("../site/package.json")]), ..area("site", "site") },
    ];
    // Opened on frontend/: its package.json is the app's.
    let found = check_in(&list, "frontend");
    assert!(!found.warnings.iter().any(|p| p.area.as_deref() == Some("app")), "{found:?}");
    // At the root, the same entry is outside the app's folder.
    assert!(check(&list).warnings.iter().any(|p| p.area.as_deref() == Some("app") && p.message.starts_with("package.json")));
}

/// Challenger 10: the words a change of the areas reads as.
#[test]
fn a_change_names_the_areas_that_changed() {
    let before = serde_json::to_value(lyra()).unwrap();
    let mut list = lyra();
    list[1].target_branch = Some("staging".into());
    let after = serde_json::to_value(&list).unwrap();
    assert_eq!(change_words(&before, &after).as_deref(), Some("Site changed"));
    list[0].look_at = None;
    let both = serde_json::to_value(&list).unwrap();
    assert_eq!(change_words(&before, &both).as_deref(), Some("APP and Site changed"));
    // Added, removed or renamed: no such words (the lists of names say it).
    assert_eq!(change_words(&before, &serde_json::to_value(&lyra()[..1]).unwrap()), None);
    assert_eq!(change_words(&Value::Null, &after), None);
    assert_eq!(change_words(&before, &before), None);
}

/// Challenger 1: a list that breaks the rules reads, keeps its raw value
/// and says why; a wrong type too.
#[test]
fn a_list_that_breaks_the_rules_reads_as_invalid_and_writes_back_as_it_was() {
    let raw = serde_json::json!([{ "id": "site", "path": "web" }, { "id": "site", "path": "docs", "x": 1 }]);
    let field = AreasField::from_value(raw.clone());
    assert!(field.problem().unwrap().contains("Two areas"));
    assert_eq!(field.valid(), None);
    assert_eq!(serde_json::to_value(&field).unwrap(), raw);
    let odd = AreasField::from_value(Value::from("site"));
    assert!(odd.problem().unwrap().contains("aren't a list"));
    assert_eq!(serde_json::to_value(&odd).unwrap(), Value::from("site"));
    let good = AreasField::from_value(serde_json::to_value(lyra()).unwrap());
    assert_eq!(good.valid().map(<[AreaDef]>::len), Some(2));
}

/// Challenger 2.3: a broken list is kept as a JSON value — every key, in
/// whatever order the file had them.
#[test]
fn a_broken_list_is_kept_as_a_value_whatever_its_key_order() {
    let text = r#"[{ "x": 1, "path": "web", "id": "site" }, { "path": "docs", "id": "site" }]"#;
    let raw: Value = serde_json::from_str(text).unwrap();
    let field: AreasField = serde_json::from_str(text).unwrap();
    assert!(field.problem().is_some());
    let back: Value = serde_json::from_str(&serde_json::to_string(&field).unwrap()).unwrap();
    assert_eq!(back, raw);
}

/// Challenger 2.1: git is asked for the workspace's folder only when an
/// area has version files; held is one rule.
#[test]
fn the_workspace_s_folder_is_asked_for_only_when_version_files_need_it() {
    let (_dir, store) = store();
    crate::team_models::share_for_test(&store, "ws", false);
    let mut list = lyra();
    for a in &mut list {
        a.version_files = None;
    }
    save(&store, "ws", &list).unwrap();
    let asked = std::cell::Cell::new(false);
    view_with(&store, "ws", || {
        asked.set(true);
        String::new()
    });
    assert!(!asked.get(), "no version files: no git");
    save(&store, "ws", &lyra()).unwrap();
    view_with(&store, "ws", || {
        asked.set(true);
        String::new()
    });
    assert!(asked.get());
    // Not a repository: the root, and not remembered.
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(workspace_prefix(&dir.path().to_string_lossy()), "");
}

// ── 1.173.0 (G1): the default release kind ────────────────────────────

fn kind(k: &str) -> Option<String> {
    Some(k.to_string())
}

#[test]
fn an_area_s_release_kind_round_trips_and_a_later_one_is_kept_as_written() {
    let def: AreaDef = serde_json::from_str(r#"{ "id": "site", "releaseKind": "push_only" }"#).unwrap();
    assert_eq!(def.release_kind, kind("push_only"));
    assert_eq!(serde_json::to_value(&def).unwrap()["releaseKind"], "push_only");
    assert_eq!(def.normalized().release_kind, kind("push_only"), "normalizing keeps it");
    assert_eq!(resolve(&[def], "main")[0].release_kind, kind("push_only"));
    // A kind a later Plyloft adds is kept as written, so a publish here never
    // erases it; a wrong type reads as unset; the list stays usable.
    let later: Vec<AreaDef> = serde_json::from_str(
        r#"[{ "id": "site", "path": "web", "releaseKind": "deploy_preview" }, { "id": "app", "releaseKind": 3 }]"#,
    )
    .unwrap();
    assert_eq!((later[0].release_kind.clone(), later[1].release_kind.clone()), (kind("deploy_preview"), None));
    assert_eq!(serde_json::to_value(&later).unwrap()[0]["releaseKind"], "deploy_preview");
    assert!(matches!(AreasField::from_value(serde_json::to_value(&later).unwrap()), AreasField::Valid(_)));
    // Absent stays absent.
    let text = serde_json::to_string(&lyra()[1]).unwrap();
    assert!(!text.contains("releaseKind"), "{text}");
}

/// Tier 2 (v1.11.x template): an `areas.json` written before G1 loads with
/// no default release kind; saving the areas keeps a kind, saving a kind
/// keeps the areas, and nothing is written when nothing changes.
#[test]
fn the_workspace_s_release_kind_lives_beside_the_areas() {
    let (_dir, store) = store();
    assert_eq!(load_release_kind(&store, "ws"), None);
    save_release_kind(&store, "ws", None).unwrap();
    assert!(!path(&store, "ws").exists(), "no file just to say not chosen");
    std::fs::create_dir_all(store.workspace_dir("ws")).unwrap();
    std::fs::write(path(&store, "ws"), r#"{ "schemaVersion": 1, "areas": [{ "id": "site", "path": "web" }] }"#).unwrap();
    assert_eq!(load_release_kind(&store, "ws"), None);
    save_release_kind(&store, "ws", kind("github")).unwrap();
    assert_eq!(load(&store, "ws")[0].path, "web", "the areas stay");
    save(&store, "ws", &lyra()).unwrap();
    assert_eq!(load_release_kind(&store, "ws"), kind("github"), "the kind stays");
    let raw: Value = serde_json::from_slice(&std::fs::read(path(&store, "ws")).unwrap()).unwrap();
    assert_eq!(raw["releaseKind"], "github");
    save_release_kind(&store, "ws", None).unwrap();
    let raw: Value = serde_json::from_slice(&std::fs::read(path(&store, "ws")).unwrap()).unwrap();
    assert!(raw.get("releaseKind").is_none(), "not written while unset: {raw}");
    // A later kind is kept as written; a wrong type is unset; the file stays readable.
    std::fs::write(path(&store, "ws"), r#"{ "areas": [{ "id": "site", "path": "web" }], "releaseKind": "later" }"#).unwrap();
    assert_eq!((load_release_kind(&store, "ws"), load(&store, "ws").len()), (kind("later"), 1));
    std::fs::write(path(&store, "ws"), r#"{ "areas": [{ "id": "site", "path": "web" }], "releaseKind": 3 }"#).unwrap();
    assert_eq!((load_release_kind(&store, "ws"), load(&store, "ws").len()), (None, 1));
}

#[test]
fn this_mac_sets_its_own_release_kind_only_where_nothing_is_shared() {
    use crate::kanban::ReleaseKind;
    let (_dir, store) = store();
    set_local_release_kind(&store, "ws", Some(ReleaseKind::PushOnly)).unwrap();
    let v = view(&store, "ws", "");
    assert!(!v.shared);
    assert_eq!(v.release_kind, kind("push_only"), "the view says it without a definition");
    crate::team_models::share_for_test(&store, "ws", false);
    assert!(set_local_release_kind(&store, "ws", Some(ReleaseKind::Local)).is_err(), "shared: it's published");
    assert_eq!(view(&store, "ws", "").release_kind, kind("push_only"));
}

// ── 1.174.0 (C10, D6): kept on this Mac until the setup is shared ─────

fn files_in(store: &ProjectConfigStore, prefix: &str) -> Vec<String> {
    std::fs::read_dir(store.workspace_dir("ws"))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with(prefix))
                .collect()
        })
        .unwrap_or_default()
}

/// Tier 2 (v1.11.x template): an `areas.json` exactly as 1.173.0 wrote it
/// loads as the repository's (`source` absent = shared) with nothing set
/// aside, still decides nothing where nothing is shared, and a save here
/// writes neither new key while they hold their defaults. A wrong type of
/// either reads as its default and the file stays readable.
#[test]
fn c10_an_areas_file_from_1_173_loads_as_the_repository_s() {
    let (_dir, store) = store();
    std::fs::create_dir_all(store.workspace_dir("ws")).unwrap();
    let old = r#"{ "schemaVersion": 1, "areas": [{ "id": "app", "path": "" }, { "id": "site", "path": "site" }], "releaseKind": "github" }"#;
    std::fs::write(path(&store, "ws"), old).unwrap();
    let stored = load_stored(&store, "ws");
    assert_eq!(stored.source, AreasSource::Shared);
    assert_eq!(stored.set_aside, None);
    assert_eq!(load(&store, "ws").len(), 2);
    assert!(for_workspace(&store, "ws").is_empty(), "not shared, not saved here: decides nothing");
    assert!(kept_here(&store, "ws").is_none());
    assert!(!view(&store, "ws", "").kept_here);
    save(&store, "ws", &lyra()).unwrap();
    let raw: Value = serde_json::from_slice(&std::fs::read(path(&store, "ws")).unwrap()).unwrap();
    assert!(raw.get("source").is_none() && raw.get("setAside").is_none(), "{raw}");
    assert_eq!(raw["releaseKind"], "github", "the kind stays");
    for wrong in [r#""source": 3, "setAside": "x""#, r#""source": "later", "setAside": { "areas": 1 }"#] {
        std::fs::write(path(&store, "ws"), format!(r#"{{ "areas": [{{ "id": "site", "path": "web" }}], {wrong} }}"#)).unwrap();
        let stored = load_stored(&store, "ws");
        assert_eq!((stored.source, stored.set_aside, stored.areas.len()), (AreasSource::Shared, None, 1), "{wrong}");
    }
    assert!(files_in(&store, "areas.json.unreadable-").is_empty(), "nothing was unreadable");
}

/// D6: where nothing is shared, the areas saved here decide — cards, Ship
/// and the picker read them — and say they are this Mac's.
#[test]
fn c10_unshared_the_areas_saved_here_decide() {
    let (_dir, store) = store();
    store.set("ws", config()).unwrap();
    save_local(&store, "ws", &lyra()).unwrap();
    assert_eq!(for_workspace(&store, "ws"), normalized(&lyra()));
    assert_eq!(kept_here(&store, "ws"), Some(normalized(&lyra())));
    let raw: Value = serde_json::from_slice(&std::fs::read(path(&store, "ws")).unwrap()).unwrap();
    assert_eq!(raw["source"], "local");
    let v = view(&store, "ws", "");
    assert!(!v.shared && v.kept_here && !v.read_only && !v.held && v.check.ok());
    assert_eq!(v.workspace_branch, "develop");
    assert_eq!(v.areas.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["APP", "Site"]);
    assert_eq!(v.areas[1].branch, "main");
    // A card start and a Ship resolve the area from here.
    let site = crate::project_config::config_for(&store, "ws", Some("site")).unwrap();
    assert!(matches!(&site, AreaConfig::Area { area, .. } if area.id == "site"), "{site:?}");
    assert_eq!(site.config().unwrap().target_branch, "main");
    // A list that breaks the rules is refused; nothing changes.
    let both_root = vec![area("a", ""), area("b", "/")];
    assert!(save_local(&store, "ws", &both_root).is_err());
    assert_eq!(for_workspace(&store, "ws").len(), 2);
    // None left: the implicit area again, still this Mac's own.
    save_local(&store, "ws", &[]).unwrap();
    assert!(for_workspace(&store, "ws").is_empty());
    assert!(kept_here(&store, "ws").is_none());
    // Shared: the repository decides, and Settings publishes there instead.
    crate::team_models::share_for_test(&store, "ws", false);
    assert!(save_local(&store, "ws", &lyra()).is_err(), "shared: published, not saved here");
}

/// D6: once the setup is shared, the repository decides. The same list
/// becomes the repository's; another one is set aside — its own file, kept
/// whatever the answer — and taken out of the list this Mac runs with.
#[test]
fn c10_shared_the_repository_decides_and_this_mac_s_list_is_set_aside() {
    let (_dir, store) = store();
    save_local(&store, "ws", &lyra()).unwrap();
    crate::team_models::share_for_test(&store, "ws", false);
    assert_eq!(reconcile_shared(&store, "ws", Some(&normalized(&lyra())[..])).unwrap(), None, "the same list");
    assert_eq!(load_stored(&store, "ws").source, AreasSource::Shared);
    assert_eq!(for_workspace(&store, "ws").len(), 2);
    assert!(kept_here(&store, "ws").is_none());
    assert!(files_in(&store, "areas.set-aside-").is_empty());
    assert_eq!(reconcile_shared(&store, "ws", None).unwrap(), None, "the repository's already: nothing to do");

    // Another computer shared first, with other areas.
    std::fs::remove_file(crate::workspace_definition::cache_path(&store, "ws")).unwrap();
    let mine = vec![area("app", ""), area("web", "web")];
    save_local(&store, "ws", &mine).unwrap();
    crate::team_models::share_for_test(&store, "ws", false);
    let aside = reconcile_shared(&store, "ws", Some(&normalized(&lyra())[..])).unwrap().expect("set aside");
    assert_eq!(aside.areas, normalized(&mine));
    assert!(load(&store, "ws").is_empty(), "the repository's apply next");
    assert_eq!(set_aside(&store, "ws"), Some(aside.clone()));
    assert_eq!(files_in(&store, "areas.set-aside-"), vec![aside.file.clone()]);
    let kept: Value =
        serde_json::from_slice(&std::fs::read(store.workspace_dir("ws").join(&aside.file)).unwrap()).unwrap();
    assert_eq!(kept["areas"][1]["id"], "web");
    let v = view(&store, "ws", "");
    assert_eq!(v.set_aside.unwrap().iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["app", "web"]);
    // Answered: asked no more; the file stays.
    assert_eq!(clear_set_aside(&store, "ws").unwrap(), Some(aside.clone()));
    assert_eq!(set_aside(&store, "ws"), None);
    assert_eq!(files_in(&store, "areas.set-aside-").len(), 1, "set aside, not deleted");
    assert_eq!(clear_set_aside(&store, "ws").unwrap(), None);
}

/// A repository list that breaks the rules is no match: this Mac's list is
/// set aside rather than run beside a held field.
#[test]
fn c10_a_broken_repository_list_sets_this_mac_s_aside() {
    let (_dir, store) = store();
    save_local(&store, "ws", &lyra()).unwrap();
    crate::team_models::share_for_test(&store, "ws", false);
    assert!(reconcile_shared(&store, "ws", None).unwrap().is_some());
    assert!(load(&store, "ws").is_empty());
}

/// CH-6: two writers at once (a refresh and a save here) never lose one
/// another's field: each read-modify-write runs alone.
#[test]
fn c10_writers_of_areas_json_run_one_at_a_time() {
    let (_dir, store) = store();
    std::thread::scope(|scope| {
        for n in 0..8 {
            let store = &store;
            scope.spawn(move || {
                if n % 2 == 0 {
                    save(store, "ws", &lyra()).unwrap();
                } else {
                    save_release_kind(store, "ws", Some(format!("k{n}"))).unwrap();
                }
            });
        }
    });
    assert_eq!(load(&store, "ws").len(), 2);
    assert!(load_release_kind(&store, "ws").is_some());
    assert!(files_in(&store, "areas.json.unreadable-").is_empty());
}

/// C17: a newer Plyloft's `areas.json` is never written over.
#[test]
fn a_newer_plyloft_s_areas_file_refuses_the_write_and_is_left_as_it_is() {
    let (_dir, store) = store();
    let file = path(&store, "ws");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let newer = format!(r#"{{"schemaVersion":{},"areas":[]}}"#, SCHEMA_VERSION + 1);
    std::fs::write(&file, &newer).unwrap();
    let error = save(&store, "ws", &lyra()).expect_err("refused");
    assert_eq!(error, crate::atomic::newer_refusal("The list of areas", SCHEMA_VERSION + 1, SCHEMA_VERSION));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer);
}

/// C17 (round 1): a newer Plyloft's `areas.json` that doesn't parse here
/// reads as none, refuses the write, and is never set aside.
#[test]
fn a_newer_areas_file_that_does_not_parse_here_is_left_byte_identical() {
    let (_dir, store) = store();
    let file = path(&store, "ws");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let newer = format!(r#"{{"schemaVersion":{},"areas":{{"site":"now a map"}}}}"#, SCHEMA_VERSION + 1);
    std::fs::write(&file, &newer).unwrap();
    assert!(load(&store, "ws").is_empty());
    let error = save(&store, "ws", &lyra()).expect_err("refused");
    assert_eq!(error, crate::atomic::newer_refusal("The list of areas", SCHEMA_VERSION + 1, SCHEMA_VERSION));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer, "byte-identical");
    assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1, "nothing set aside");
}
