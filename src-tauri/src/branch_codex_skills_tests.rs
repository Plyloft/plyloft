//! GH #156 — the integration branch's `.agents/skills`, delivered to Codex as
//! the `ply-project` marketplace in the `CODEX_HOME` overlay.

use super::*;
use tempfile::TempDir;

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn skill_md(name: &str) -> String {
    format!("---\nname: {name}\ndescription: The {name} skill.\n---\n\nBody of {name}.\n")
}

/// A workspace directory whose mirror (a plain directory with a manifest, which
/// `resolve_mirror` accepts) holds `codex` under `.agents/skills` and `claude`
/// under `.claude/skills`.
fn workspace(root: &Path, codex: &[&str], claude: &[&str]) -> PathBuf {
    let workspace = root.join("projects").join("ws");
    let mirror = workspace.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
    std::fs::create_dir_all(&mirror).unwrap();
    write(
        &mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST),
        &serde_json::json!({ "schemaVersion": 2, "cwd": "/x", "branch": "staging" }).to_string(),
    );
    for name in codex {
        write(&mirror.join(".agents/skills").join(name).join("SKILL.md"), &skill_md(name));
    }
    for name in claude {
        write(&mirror.join(".claude/skills").join(name).join("SKILL.md"), &skill_md(name));
    }
    workspace
}

fn mirror_of(workspace: &Path) -> PathBuf {
    workspace.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR)
}

/// The skills a built marketplace's one plugin carries, by directory.
fn skills_in(marketplace: &CodexMarketplace) -> Vec<String> {
    assert_eq!(marketplace.plugins.len(), 1);
    let mut names: Vec<String> = std::fs::read_dir(marketplace.plugins[0].dir.join("skills"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The whole tree, bytes and all; links compared as links, never followed.
fn snapshot(root: &Path) -> Vec<(PathBuf, String, Vec<u8>)> {
    fn walk(root: &Path, at: &Path, out: &mut Vec<(PathBuf, String, Vec<u8>)>) {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(at)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            let meta = std::fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&path).unwrap();
                out.push((relative, "link".into(), target.to_string_lossy().as_bytes().to_vec()));
            } else if meta.is_dir() {
                out.push((relative, "dir".into(), Vec::new()));
                walk(root, &path, out);
            } else {
                out.push((relative, "file".into(), std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn the_marketplace_carries_exactly_the_mirrors_codex_skills() {
    let tree = TempDir::new().unwrap();
    let ws = workspace(tree.path(), &["alpha", "beta"], &["claude-only"]);
    // A directory on the branch no CLI would load: no description.
    write(
        &mirror_of(&ws).join(".agents/skills/broken/SKILL.md"),
        "---\nname: broken\n---\n",
    );
    // A helper script, whose mode must survive.
    let helper = mirror_of(&ws).join(".agents/skills/alpha/run.sh");
    write(&helper, "#!/bin/sh\n");
    crate::platform::set_mode(&helper, 0o755).unwrap();
    let checkout = tree.path().join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();

    let marketplace = session_marketplace(&ws, &checkout).expect("the branch has Codex skills");
    assert_eq!(marketplace.name, MARKETPLACE_NAME);
    assert_eq!(marketplace.name, "ply-project");
    assert_eq!(marketplace.plugins[0].name, "project", "Codex lists `project:<name>`");
    assert_eq!(marketplace.plugin_id(&marketplace.plugins[0]), "project@ply-project");
    assert_eq!(marketplace.label, MARKETPLACE_LABEL);
    // Exactly the loadable Codex copies: not the Claude-only skill, not the one
    // no CLI loads.
    assert_eq!(skills_in(&marketplace), vec!["alpha", "beta"]);
    // Byte for byte, mode included.
    for name in ["alpha", "beta"] {
        let delivered = crate::project_skills::read_tree(
            &marketplace.plugins[0].dir.join("skills").join(name),
        )
        .unwrap();
        let branch =
            crate::project_skills::read_tree(&mirror_of(&ws).join(".agents/skills").join(name))
                .unwrap();
        assert_eq!(delivered, branch, "{name}");
    }
    // It lives under the workspace's own builds directory.
    assert!(marketplace.root.starts_with(ws.join(BUILDS_DIR)));
    // And the reader agrees: this is a marketplace both `codex_home` and the
    // team reader accept.
    let library = crate::team_skills::read_own_library(
        marketplace.root.parent().unwrap().parent().unwrap(),
        MARKETPLACE_NAME,
    );
    assert_eq!(library.codex.as_ref().map(|m| m.name.as_str()), Some("ply-project"));
    assert!(library.refused.is_empty(), "{:?}", library.refused);
}

#[test]
fn a_skill_removed_on_the_branch_is_not_delivered() {
    let tree = TempDir::new().unwrap();
    let ws = workspace(tree.path(), &["alpha", "beta"], &[]);
    let checkout = tree.path().join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();

    let first = session_marketplace(&ws, &checkout).unwrap();
    assert_eq!(skills_in(&first), vec!["alpha", "beta"]);

    // The branch loses `beta` (the mirror is rebuilt without it).
    std::fs::remove_dir_all(mirror_of(&ws).join(".agents/skills/beta")).unwrap();
    let second = session_marketplace(&ws, &checkout).unwrap();
    assert_eq!(skills_in(&second), vec!["alpha"]);
    // A new, content-named build — the one a running session reads is left alone.
    assert_ne!(first.root, second.root);
    assert!(first.plugins[0].dir.join("skills/beta/SKILL.md").is_file());

    // And the last one goes: no marketplace at all.
    std::fs::remove_dir_all(mirror_of(&ws).join(".agents/skills/alpha")).unwrap();
    assert!(session_marketplace(&ws, &checkout).is_none());
}

#[test]
fn a_copy_the_session_directory_already_has_is_not_delivered_twice() {
    let tree = TempDir::new().unwrap();
    let ws = workspace(tree.path(), &["same", "changed", "absent"], &[]);
    let checkout = tree.path().join("checkout");
    write(&checkout.join(".agents/skills/same/SKILL.md"), &skill_md("same"));
    write(&checkout.join(".agents/skills/changed/SKILL.md"), "---\ndescription: old\n---\n");
    // A Claude copy in the checkout is not a Codex copy.
    write(&checkout.join(".claude/skills/absent/SKILL.md"), &skill_md("absent"));

    let marketplace = session_marketplace(&ws, &checkout).unwrap();
    assert_eq!(skills_in(&marketplace), vec!["absent", "changed"]);
    // The branch's version, never the checkout's.
    assert_eq!(
        std::fs::read_to_string(marketplace.plugins[0].dir.join("skills/changed/SKILL.md"))
            .unwrap(),
        skill_md("changed"),
    );

    // A worktree without any copy gets all three.
    let worktree = tree.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let marketplace = session_marketplace(&ws, &worktree).unwrap();
    assert_eq!(skills_in(&marketplace), vec!["absent", "changed", "same"]);
}

#[test]
fn nothing_is_built_without_codex_skills_on_the_branch() {
    let tree = TempDir::new().unwrap();
    let checkout = tree.path().join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();

    // No mirror at all.
    let bare = tree.path().join("projects").join("bare");
    std::fs::create_dir_all(&bare).unwrap();
    assert!(session_marketplace(&bare, &checkout).is_none());
    assert!(!bare.join(BUILDS_DIR).exists());

    // A mirror with Claude skills only.
    let ws = workspace(tree.path(), &[], &["deploy"]);
    assert!(session_marketplace(&ws, &checkout).is_none());
    assert!(!ws.join(BUILDS_DIR).exists(), "no build for an empty layer");

    // A mirror whose only Codex copy no CLI loads.
    write(&mirror_of(&ws).join(".agents/skills/broken/SKILL.md"), "no frontmatter\n");
    assert!(session_marketplace(&ws, &checkout).is_none());
    assert!(!ws.join(BUILDS_DIR).exists());
}

#[test]
fn a_launch_stamps_its_build_and_the_chip_reads_write_nothing() {
    let tree = TempDir::new().unwrap();
    let ws = workspace(tree.path(), &["alpha"], &[]);
    let checkout = tree.path().join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();
    let home = tree.path().join("codex-home");
    write(&home.join("auth.json"), "{}");

    // The chip's question builds nothing and stamps nothing.
    let before = snapshot(tree.path());
    assert_eq!(delivery(&home), Delivery { reaches: true, refused: None });
    assert_eq!(snapshot(tree.path()), before, "delivery() writes nothing anywhere");

    // A launch builds and stamps.
    let marketplace = session_marketplace(&ws, &checkout).unwrap();
    let digest = marketplace
        .root
        .parent()
        .and_then(|library| library.parent())
        .and_then(|build| build.file_name())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let stamp = ws.join(BUILDS_DIR).join(format!("{digest}.last-used"));
    assert!(stamp.is_file(), "the launch stamps the build it used");
    // Nothing half-built is left beside it.
    let leftovers: Vec<String> = std::fs::read_dir(ws.join(BUILDS_DIR))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // A second launch with the same branch reuses the directory.
    assert_eq!(session_marketplace(&ws, &checkout).unwrap().root, marketplace.root);
}

#[test]
fn delivery_says_a_collision_and_stays_quiet_without_codex() {
    let tree = TempDir::new().unwrap();
    // No Codex home: a member who does not use Codex. Dark, and nothing said.
    assert_eq!(delivery(&tree.path().join("nope")), Delivery::default());

    // A member with a `ply-project` marketplace of their own.
    let home = tree.path().join("codex-home");
    write(
        &home.join("config.toml"),
        "[marketplaces.ply-project]\nsource_type = \"local\"\nsource = \"/mine\"\n",
    );
    let answer = delivery(&home);
    assert!(!answer.reaches);
    let reason = answer.refused.unwrap();
    assert!(reason.contains("ply-project"), "{reason}");
    assert!(reason.contains(MARKETPLACE_LABEL), "names the layer: {reason}");

    // One in their plugin cache instead.
    let other = tree.path().join("codex-home-2");
    std::fs::create_dir_all(other.join("plugins/cache/ply-project")).unwrap();
    assert!(!delivery(&other).reaches);
    // An enabled `project@ply-project` of their own.
    let third = tree.path().join("codex-home-3");
    write(&third.join("config.toml"), "[plugins.\"project@ply-project\"]\nenabled = true\n");
    assert!(!delivery(&third).reaches);
}

/// **Nothing is written into the member's CLI folders or the repository** — the
/// build, and the overlay a launch makes from it, compared byte for byte.
#[test]
fn a_build_and_its_overlay_write_nothing_outside_plys_own_directories() {
    let tree = TempDir::new().unwrap();
    let config = tree.path().join("config");
    let ws = workspace(&config, &["alpha", "beta"], &["deploy"]);

    // The member's home-shaped roots, each with a skill of their own, and a
    // Codex home with the directories a session writes into already there.
    let home = tree.path().join("home");
    for skills in [".claude/skills", ".codex/skills", ".agents/skills"] {
        write(&home.join(skills).join("mine/SKILL.md"), "---\ndescription: Mine.\n---\n");
    }
    let codex = home.join(".codex");
    write(&codex.join("auth.json"), r#"{"token":"secret"}"#);
    write(&codex.join("config.toml"), "model = \"o3\"\n");
    for dir in ["sessions", "logs", "shell_snapshots"] {
        std::fs::create_dir_all(codex.join(dir)).unwrap();
    }
    // The checkout, with Codex and Claude copies of its own.
    let checkout = tree.path().join("checkout");
    write(&checkout.join(".agents/skills/alpha/SKILL.md"), "---\ndescription: local\n---\n");
    write(&checkout.join(".claude/skills/deploy/SKILL.md"), &skill_md("deploy"));

    let before = snapshot(tree.path());
    let overlays = config.join("team").join("codex-home");
    for _ in 0..2 {
        let marketplace = session_marketplace(&ws, &checkout).unwrap();
        let overlay = crate::codex_home::build_all(
            &overlays,
            &config.join("team").join("codex-home-recovered"),
            &codex,
            &[&marketplace],
        )
        .unwrap();
        assert!(overlay.refused().is_empty(), "{:?}", overlay.refused());
        let cache = overlay.path().join("plugins/cache/ply-project/project/1.0.0/skills");
        assert!(cache.join("alpha/SKILL.md").is_file());
        assert!(cache.join("beta/SKILL.md").is_file());
        drop(overlay);
    }
    let outside = |at: &Path| -> Vec<(PathBuf, String, Vec<u8>)> {
        snapshot(at)
            .into_iter()
            .filter(|(relative, _, _)| {
                !relative.starts_with("config/projects/ws/shared_codex_skills_session_plugins")
                    && !relative.starts_with("config/team")
            })
            .collect()
    };
    assert_eq!(
        before,
        outside(tree.path()),
        "the member's ~/.codex, ~/.claude, ~/.agents, the checkout and the mirror \
         are byte-identical",
    );
    // The filter is what hides the build, so the comparison is not vacuous.
    assert_ne!(snapshot(tree.path()).len(), before.len());
}

/// A `LibraryState` written before GH #156 has no `branchCodex`, and reads as
/// "not delivered" — what it meant then — rather than failing to decode.
#[test]
fn a_library_state_without_branch_codex_still_reads() {
    let old = serde_json::json!({
        "shared": true,
        "branch": "staging",
        "readOnly": false,
        "repository": null,
        "pending": [],
        "branchSkills": ["deploy"],
    });
    let state: crate::workspace_definition::LibraryState = serde_json::from_value(old).unwrap();
    assert_eq!(state.branch_codex, Delivery::default());
    assert!(!state.branch_codex.reaches);
    // And the new field is spelled the way the window reads it.
    let written = serde_json::to_value(crate::workspace_definition::LibraryState {
        branch_codex: Delivery { reaches: true, refused: None },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(written["branchCodex"], serde_json::json!({ "reaches": true, "refused": null }));
}

/// Review 1: the build a launch is about to reuse is stamped **before** it is
/// looked for, so another launch's prune — which may run between any two lines —
/// never sees it as unused. A build last used thirty-one days ago is reused, not
/// pruned, and its stamp is fresh again.
#[test]
fn a_reused_build_is_stamped_before_it_is_looked_for() {
    let tree = TempDir::new().unwrap();
    let ws = workspace(tree.path(), &["alpha"], &[]);
    let checkout = tree.path().join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();
    let first = session_marketplace(&ws, &checkout).unwrap();
    let build = first.root.parent().unwrap().parent().unwrap().to_path_buf();
    let digest = build.file_name().unwrap().to_string_lossy().into_owned();
    let stamp = ws.join(BUILDS_DIR).join(format!("{digest}.last-used"));

    // Last used long ago: a prune right now would remove it.
    let old = std::time::SystemTime::now() - Duration::from_secs(31 * 24 * 3600);
    for path in [&stamp, &build] {
        crate::platform::set_modified(path, old).unwrap();
    }

    let again = session_marketplace(&ws, &checkout).expect("reused, not pruned");
    assert_eq!(again.root, first.root);
    assert!(build.join("library/codex/.agents/plugins/marketplace.json").is_file());
    let age = std::fs::metadata(&stamp).unwrap().modified().unwrap().elapsed().unwrap();
    assert!(age < Duration::from_secs(60), "the stamp is fresh: {age:?}");

    // The order itself: the stamp is written above the first `whole` check in
    // `build_marketplace`, so no prune can fall between finding and stamping.
    let source = include_str!("branch_codex_skills.rs");
    let body = &source[source.find("fn build_marketplace(").unwrap()..];
    let stamped = body.find("write_atomic_text(&stamp").unwrap();
    let looked = body.find("if !whole(&dest)").unwrap();
    assert!(stamped < looked, "stamp before the build is looked for");
}

/// Walk F4: `current_in_checkout` crosses to the window as `currentInCheckout`
/// (what `SkillsPage`'s press reads), and a state without it still decodes.
#[test]
fn a_library_state_spells_current_in_checkout_for_the_window() {
    let written = serde_json::to_value(crate::workspace_definition::LibraryState {
        current_in_checkout: vec!["deploy".into()],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(written["currentInCheckout"], serde_json::json!(["deploy"]));
    let old = serde_json::json!({
        "shared": true,
        "branch": "staging",
        "readOnly": false,
        "repository": null,
        "pending": [],
        "branchSkills": ["deploy"],
    });
    let state: crate::workspace_definition::LibraryState = serde_json::from_value(old).unwrap();
    assert!(state.current_in_checkout.is_empty());
}
