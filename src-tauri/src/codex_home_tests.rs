//! v1.116.0 (team sharing rung 3) — the Ply-owned `CODEX_HOME` overlay.
//!
//! The invariant every case here defends: **the member's real Codex home is
//! never written**. Their auth, thread history, memories and state must keep
//! resolving to their own files, their `config.toml` must survive untouched,
//! and their own installed plugins must still load.

use super::*;
use crate::team_skills::{CodexMarketplace, CodexPlugin};
use tempfile::TempDir;

/// Round 3: an overlay's directory is gone — at most the link to the real
/// home that keeps its path resolving is left.
fn dir_gone(path: &Path) -> bool {
    path.symlink_metadata().map_or(true, |meta| meta.file_type().is_symlink())
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// A plausible `~/.codex`: auth, a config, sqlite state, memories, and one
/// plugin the member installed themselves.
fn real_home() -> TempDir {
    let dir = TempDir::new().unwrap();
    let home = dir.path();
    write(&home.join("auth.json"), r#"{"token":"secret"}"#);
    write(
        &home.join("config.toml"),
        "[projects.\"/Users/someone/code\"]\ntrust_level = \"trusted\"\n",
    );
    write(&home.join("state_5.sqlite"), "sqlite");
    write(&home.join("memories").join("note.md"), "remembered");
    // A dotfile: the shipped `openai-curated` marketplace lives in one, so
    // missing these would cost the member their own plugins.
    write(&home.join(".tmp").join("plugins").join("README.md"), "curated");
    write(
        &home
            .join("plugins")
            .join("cache")
            .join("openai-curated-remote")
            .join("ads-manager")
            .join("0.1.19")
            .join("marker"),
        "theirs",
    );
    dir
}

/// A team marketplace holding one plugin with one skill.
fn marketplace(library: &Path) -> CodexMarketplace {
    let plugin_dir = library.join("plugins").join("ply-team");
    write(
        &plugin_dir.join(".codex-plugin").join("plugin.json"),
        r#"{"name":"ply-team","version":"1.2.0"}"#,
    );
    write(
        &plugin_dir
            .join("skills")
            .join("team-conventions")
            .join("SKILL.md"),
        "---\nname: team-conventions\n---\n",
    );
    CodexMarketplace {
        root: library.to_path_buf(),
        name: "ply-team".into(),
        plugins: vec![CodexPlugin {
            name: "ply-team".into(),
            version: "1.2.0".into(),
            dir: plugin_dir,
        }],
        label: crate::team_skills::TEAM_MARKETPLACE_LABEL.into(),
    }
}

/// A second local marketplace, so the fold over several can be exercised.
fn named_marketplace(library: &Path, name: &str, plugin: &str) -> CodexMarketplace {
    let plugin_dir = library.join("plugins").join(plugin);
    write(
        &plugin_dir.join(".codex-plugin").join("plugin.json"),
        &format!(r#"{{"name":"{plugin}","version":"1.0.0"}}"#),
    );
    write(
        &plugin_dir.join("skills").join("one").join("SKILL.md"),
        "---\nname: one\ndescription: d\n---\n",
    );
    CodexMarketplace {
        root: library.to_path_buf(),
        name: name.into(),
        plugins: vec![CodexPlugin {
            name: plugin.into(),
            version: "1.0.0".into(),
            dir: plugin_dir,
        }],
        // The shape Ply's own layer has, so a refusal's words can be checked.
        label: "Plyloft's own marketplace".into(),
    }
}

/// GH #106 review 1: **one layer's collision costs only that layer.**
///
/// Ply's own skills and the team library share one `CODEX_HOME`, because Codex
/// has no session-scoped flag. Registering them together meant a member who
/// happened to have a marketplace of one of those names lost the *other* layer
/// too, silently. Each is folded in on its own now, and the one that cannot be
/// carried is recorded and left out.
#[test]
fn a_colliding_marketplace_costs_only_itself() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();

    // The member already has a marketplace called `ply-app` — the name Ply's own
    // skills use.
    std::fs::write(
        home.path().join("config.toml"),
        "[marketplaces.ply-app]\nsource_type = \"local\"\nsource = \"/somewhere/of/mine\"\n",
    )
    .unwrap();

    let team = marketplace(library.path());
    let ply = named_marketplace(library.path(), "ply-app", "ply");

    // Both orders, because the answer must be about the collision and not about
    // which one was folded first.
    for order in [vec![&team, &ply], vec![&ply, &team]] {
        let overlay = build_all(overlays.path(), recovered.path(), home.path(), &order)
            .expect("the team library still reaches the session");
        let config = std::fs::read_to_string(overlay.path().join("config.toml")).unwrap();
        let parsed: toml::Table = toml::from_str(&config).unwrap();
        let marketplaces = parsed["marketplaces"].as_table().unwrap();

        // The team's went in…
        assert!(marketplaces.contains_key("ply-team"), "{config}");
        assert_eq!(
            parsed["plugins"]["ply-team@ply-team"]["enabled"].as_bool(),
            Some(true),
        );
        let cache = overlay.path().join("plugins").join("cache");
        assert!(cache.join("ply-team/ply-team/1.2.0/.codex-plugin/plugin.json").is_file());

        // …the member's own `ply-app` entry is exactly as they wrote it, never
        // repointed at Ply's…
        assert_eq!(
            marketplaces["ply-app"]["source"].as_str(),
            Some("/somewhere/of/mine"),
        );
        assert!(!parsed["plugins"].as_table().unwrap().contains_key("ply@ply-app"));
        // …and nothing of Ply's was installed under the colliding name.
        assert!(!cache.join("ply-app/ply/1.0.0").exists());

        // The refusal is recorded rather than swallowed, and names the marketplace.
        let refused = overlay.refused();
        assert_eq!(refused.len(), 1, "{refused:?}");
        assert_eq!(refused[0].marketplace, "ply-app");
        assert!(refused[0].reason.contains("ply-app"), "{refused:?}");
    }

    // And when **every** marketplace collides there is nothing for an overlay to
    // be, so the session launches on the member's own home — which is exactly what
    // the single-marketplace `build` has always answered.
    std::fs::write(
        home.path().join("config.toml"),
        "[marketplaces.ply-app]\nsource_type = \"local\"\nsource = \"/mine\"\n\
         [marketplaces.ply-team]\nsource_type = \"local\"\nsource = \"/mine-too\"\n",
    )
    .unwrap();
    let error = build_all(overlays.path(), recovered.path(), home.path(), &[&team, &ply])
        .expect_err("no layer could be carried");
    assert!(error.contains("already have a Codex marketplace"), "{error}");
}

/// A marketplace whose plugin files cannot be copied is left out the same way,
/// and takes nothing of its own with it into the overlay.
#[test]
fn a_marketplace_whose_files_cannot_be_copied_costs_only_itself() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();

    let team = marketplace(library.path());
    let mut broken = named_marketplace(library.path(), "ply-app", "ply");
    // Its plugin directory is not there at all: nothing to copy.
    broken.plugins[0].dir = library.path().join("plugins").join("gone");

    let overlay = build_all(overlays.path(), recovered.path(), home.path(), &[&broken, &team])
        .expect("the team library still reaches the session");
    let config = std::fs::read_to_string(overlay.path().join("config.toml")).unwrap();
    let parsed: toml::Table = toml::from_str(&config).unwrap();
    assert!(parsed["marketplaces"].as_table().unwrap().contains_key("ply-team"));
    // Its config entry was decided but never committed, so nothing declares it…
    assert!(!parsed["marketplaces"].as_table().unwrap().contains_key("ply-app"));
    // …and the half-made cache directory went with it.
    assert!(!overlay.path().join("plugins").join("cache").join("ply-app").exists());
    assert_eq!(overlay.refused().len(), 1);
    assert_eq!(overlay.refused()[0].marketplace, "ply-app");
}

/// GH #106 review 2: the undo of a half-done install must never reach through a
/// **symlink** into the member's own plugin cache.
///
/// The shape that gets there: the member has `~/.codex/plugins/cache/ply-app` of
/// their own, but **no** `[marketplaces.ply-app]` in their config. So the config
/// fold succeeds — nothing in the file collides — and the refusal comes later,
/// from `install_team_plugins`, which finds the overlay's `cache/ply-app` already
/// taken by the link `link_entries` made to their directory. That is the one path
/// on which `remove_installed` is called with a link under its hand, and
/// `remove_dir_all` through it would delete their plugins.
#[test]
fn undoing_an_install_never_reaches_through_the_link_to_the_members_cache() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();

    // Their own `ply-app` in the cache, with a file inside it worth keeping…
    let theirs = home
        .path()
        .join("plugins")
        .join("cache")
        .join("ply-app")
        .join("something")
        .join("2.0.0");
    write(&theirs.join("marker"), "the member's own");
    // …and nothing about it in their config.
    std::fs::write(home.path().join("config.toml"), "model = \"gpt-6\"\n").unwrap();

    let team = marketplace(library.path());
    let ply = named_marketplace(library.path(), "ply-app", "ply");
    let overlay = build_all(overlays.path(), recovered.path(), home.path(), &[&ply, &team])
        .expect("the team library still reaches the session");

    // The member's file is still there, byte for byte.
    assert_eq!(
        std::fs::read_to_string(theirs.join("marker")).unwrap(),
        "the member's own",
        "their own plugin cache must survive the undo",
    );
    // The overlay's entry for that name is still the *link* to their directory,
    // not a directory of Ply's and not a hole.
    let linked = overlay.path().join("plugins").join("cache").join("ply-app");
    assert!(
        std::fs::symlink_metadata(&linked).unwrap().file_type().is_symlink(),
        "the link is left exactly as `link_entries` made it",
    );
    assert!(linked.join("something").join("2.0.0").join("marker").is_file());
    // Nothing of Ply's was installed under it…
    assert!(!linked.join("ply").exists());
    // …the refusal names the layer and the collision…
    assert_eq!(overlay.refused().len(), 1, "{:?}", overlay.refused());
    assert_eq!(overlay.refused()[0].marketplace, "ply-app");
    assert!(
        overlay.refused()[0].reason.contains("Plyloft's own marketplace"),
        "{:?}",
        overlay.refused(),
    );
    // …and the team library went in regardless.
    let config = std::fs::read_to_string(overlay.path().join("config.toml")).unwrap();
    let parsed: toml::Table = toml::from_str(&config).unwrap();
    assert!(parsed["marketplaces"].as_table().unwrap().contains_key("ply-team"));
    assert!(!parsed["marketplaces"].as_table().unwrap().contains_key("ply-app"));
    // The member's own setting survived the round trip, as ever.
    assert_eq!(parsed["model"].as_str(), Some("gpt-6"));

    // And `preflight` — what the Library asks before it lights the Codex chip —
    // refuses this Mac for the same reason, so the chip cannot claim a reach the
    // overlay does not give (review 2).
    let refusal = preflight(home.path(), &ply).expect_err("preflight agrees with build");
    assert!(refusal.contains("collides with one already installed"), "{refusal}");
    assert!(preflight(home.path(), &team).is_ok(), "the team's is unaffected");
}

struct Built {
    _home: TempDir,
    _library: TempDir,
    _overlays: TempDir,
    _recovered: TempDir,
    home_path: std::path::PathBuf,
    overlay: CodexHomeOverlay,
}

fn build_overlay() -> Built {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());
    let overlay = build(overlays.path(), recovered.path(), home.path(), &market).expect("build the overlay");
    Built {
        home_path: home.path().to_path_buf(),
        _home: home,
        _library: library,
        _overlays: overlays,
        _recovered: recovered,
        overlay,
    }
}

#[test]
fn every_entry_of_the_real_home_is_linked_except_the_two_ply_owns() {
    let built = build_overlay();
    let overlay = built.overlay.path();

    // Windows places files as hard links and its databases not at all
    // (`windows_style_*` below); the symlink shape is unix's.
    let names: &[&str] = if LinkStyle::native() == LinkStyle::Symlink {
        &["auth.json", "state_5.sqlite", "memories", ".tmp"]
    } else {
        &["memories", ".tmp"]
    };
    for &name in names {
        let link = overlay.join(name);
        assert!(
            link.symlink_metadata().unwrap().file_type().is_symlink(),
            "{name} must be a symlink into the member's own home"
        );
        assert_eq!(crate::platform::read_link(&link).unwrap(), built.home_path.join(name));
    }

    // Auth resolves through the link, which is what lets a session inherit
    // the member's sign-in without Ply ever reading the token.
    assert_eq!(
        std::fs::read_to_string(overlay.join("auth.json")).unwrap(),
        r#"{"token":"secret"}"#
    );

    for name in ["config.toml", "plugins"] {
        assert!(
            !overlay
                .join(name)
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
            "{name} is Plyloft's own, never a link"
        );
    }
}

/// A write through the overlay must land in the member's real home, or their
/// thread history would vanish with the overlay.
#[test]
fn writes_through_a_linked_directory_land_in_the_real_home() {
    let built = build_overlay();
    std::fs::write(
        built.overlay.path().join("memories").join("new.md"),
        "written by the session",
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(built.home_path.join("memories").join("new.md")).unwrap(),
        "written by the session"
    );
}

/// The directories Codex writes into are created in the real home when
/// missing, so a first-ever session's history is not stranded in a directory
/// Ply is about to delete.
#[test]
fn missing_writable_directories_are_created_in_the_real_home_and_linked() {
    let built = build_overlay();
    for name in WRITABLE_DIRS {
        assert!(
            built.home_path.join(name).is_dir(),
            "{name} must exist in the real home"
        );
        assert!(
            built
                .overlay
                .path()
                .join(name)
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
            "{name} must be linked, not owned"
        );
    }
}

/// The member's own installed plugins must still load: `plugins/` is Ply's
/// directory, but every marketplace inside it is linked back.
#[test]
fn the_members_own_plugins_are_still_reachable() {
    let built = build_overlay();
    let theirs = built
        .overlay
        .path()
        .join("plugins")
        .join("cache")
        .join("openai-curated-remote");
    assert!(theirs.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(
        std::fs::read_to_string(theirs.join("ads-manager").join("0.1.19").join("marker")).unwrap(),
        "theirs"
    );
}

/// The team plugin is a real copy at the path an installed plugin resolves
/// through: Codex rejects a symlinked plugin root as resolving outside the
/// plugin root (measured during the rung-3 research).
#[test]
fn the_team_plugin_is_copied_into_the_cache_not_linked() {
    let built = build_overlay();
    let installed = built
        .overlay
        .path()
        .join("plugins")
        .join("cache")
        .join("ply-team")
        .join("ply-team")
        .join("1.2.0");

    assert!(
        !installed.symlink_metadata().unwrap().file_type().is_symlink(),
        "a symlinked plugin root is refused by Codex"
    );
    assert!(installed.join(".codex-plugin").join("plugin.json").is_file());
    assert!(installed
        .join("skills")
        .join("team-conventions")
        .join("SKILL.md")
        .is_file());
}

/// The member's own settings survive, with the team entries added.
#[test]
fn the_overlay_config_is_their_file_plus_the_team_entries() {
    let built = build_overlay();
    let original = std::fs::read_to_string(built.home_path.join("config.toml")).unwrap();
    let overlay_config = std::fs::read_to_string(built.overlay.path().join("config.toml")).unwrap();

    // Their settings, through the parse and back out.
    let parsed: toml::Table = toml::from_str(&overlay_config).expect("valid TOML");
    assert_eq!(
        parsed["projects"]["/Users/someone/code"]["trust_level"].as_str(),
        Some("trusted")
    );
    assert!(overlay_config.contains("[marketplaces.ply-team]"));
    assert!(overlay_config.contains("source_type = \"local\""));
    // The entry that actually marks the plugin installed. `-c` cannot supply
    // it — this file is the only thing Codex reads it from.
    assert!(overlay_config.contains("[plugins.\"ply-team@ply-team\"]"));
    assert!(overlay_config.contains("enabled = true"));

    // And the member's own file is untouched.
    assert_eq!(
        std::fs::read_to_string(built.home_path.join("config.toml")).unwrap(),
        original
    );
}

/// Rebuilding for the next session starts from the member's file again, so
/// the appended block never accumulates however many sessions have run.
#[test]
fn rebuilding_appends_the_team_block_exactly_once() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());

    let first = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let first_config = std::fs::read_to_string(first.path().join("config.toml")).unwrap();
    drop(first);
    let second = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let second_config = std::fs::read_to_string(second.path().join("config.toml")).unwrap();

    assert_eq!(first_config, second_config);
    assert_eq!(second_config.matches("[marketplaces.ply-team]").count(), 1);
    assert_eq!(
        second_config
            .matches("[plugins.\"ply-team@ply-team\"]")
            .count(),
        1
    );
}

/// Two sessions at once get two overlays; neither may see the other's.
#[test]
fn concurrent_sessions_get_separate_overlays() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());

    let a = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let b = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    assert_ne!(a.path(), b.path());

    // Ending one session leaves the other's home intact.
    let b_path = b.path().to_path_buf();
    drop(a);
    assert!(b_path.join("config.toml").is_file());
}

/// The overlay's life is the session's: dropping the handle removes it, and
/// removing it must never follow a link back into the member's home.
#[test]
fn dropping_keeps_the_overlay_when_its_state_cannot_be_given_back() {
    // Review of PR #26 (2026-09-10): the sweep kept an overlay whose state it
    // could not place, but the normal-exit Drop removed it regardless — the
    // one path where a session's fresh state could still vanish. Force an
    // incomplete adoption: the session "created" a `memories` that collides
    // with the real home's, and the recovery root is a plain file, so the
    // copy-aside cannot be made.
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let blocked = TempDir::new().unwrap();
    let recovered = blocked.path().join("recovered");
    write(&recovered, "not a directory");
    let market = marketplace(library.path());
    let overlay = build(overlays.path(), &recovered, home.path(), &market).expect("build the overlay");
    let overlay_path = overlay.path().to_path_buf();
    crate::platform::remove_link(&overlay_path.join("memories")).unwrap();
    write(&overlay_path.join("memories").join("fresh.md"), "made this session");

    drop(overlay);

    assert!(
        overlay_path.join("memories").join("fresh.md").is_file(),
        "unplaceable state is kept for recovery, never deleted"
    );
    assert!(overlay_path.join(".ply-overlay.json").is_file(), "the marker stays so the sweep can retry");
    assert_eq!(
        std::fs::read_to_string(home.path().join("memories").join("note.md")).unwrap(),
        "remembered",
        "the member's own state is untouched"
    );
}

#[test]
fn dropping_the_overlay_removes_it_and_leaves_the_real_home_whole() {
    let built = build_overlay();
    let overlay_path = built.overlay.path().to_path_buf();
    let home_path = built.home_path.clone();
    let Built { overlay, .. } = built;

    drop(overlay);

    assert!(dir_gone(&overlay_path));
    for name in ["auth.json", "config.toml", "state_5.sqlite"] {
        assert!(home_path.join(name).is_file(), "{name} must survive");
    }
    assert!(home_path.join("memories").join("note.md").is_file());
    assert!(home_path
        .join("plugins")
        .join("cache")
        .join("openai-curated-remote")
        .join("ads-manager")
        .join("0.1.19")
        .join("marker")
        .is_file());
}

/// **A freshly authenticated home creates its state inside the overlay.**
/// Linking can only cover what already exists, so a member who has just run
/// `codex login` would otherwise lose their first session's thread history,
/// state and memories when the overlay went away.
#[test]
fn state_a_session_creates_is_kept_when_the_overlay_goes() {
    let home = TempDir::new().unwrap();
    write(&home.path().join("auth.json"), r#"{"token":"secret"}"#);
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();

    let overlay = build(overlays.path(), recovered.path(), home.path(), &marketplace(library.path())).unwrap();

    // Stand in for what a session writes into a home that had none of it.
    write(&overlay.path().join("thread_history_1.sqlite"), "history");
    write(&overlay.path().join("installation_id"), "abc123");
    write(&overlay.path().join("memories").join("first.md"), "remembered");
    let overlay_path = overlay.path().to_path_buf();

    drop(overlay);

    assert!(dir_gone(&overlay_path), "the overlay is still removed");
    assert_eq!(
        std::fs::read_to_string(home.path().join("thread_history_1.sqlite")).unwrap(),
        "history"
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("installation_id")).unwrap(),
        "abc123"
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("memories").join("first.md")).unwrap(),
        "remembered"
    );
}

/// What Ply owns is not the member's, and is never adopted.
#[test]
fn plys_own_entries_are_not_adopted_into_the_real_home() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let their_config = std::fs::read_to_string(home.path().join("config.toml")).unwrap();

    let overlay = build(overlays.path(), recovered.path(), home.path(), &marketplace(library.path())).unwrap();
    drop(overlay);

    // Their config is untouched, not replaced by the overlay's.
    assert_eq!(
        std::fs::read_to_string(home.path().join("config.toml")).unwrap(),
        their_config
    );
    // And the team plugin was not installed into their cache.
    assert!(!home
        .path()
        .join("plugins")
        .join("cache")
        .join("ply-team")
        .exists());
}

/// A symlinked entry wrote into the real home as it went, so adoption must
/// not touch it — and above all must not replace the member's own file with
/// a link to itself.
#[test]
fn linked_entries_are_left_alone_by_adoption() {
    let built = build_overlay();
    let home = built.home_path.clone();
    let Built { overlay, .. } = built;
    drop(overlay);

    for name in ["auth.json", "state_5.sqlite", "memories"] {
        let entry = home.join(name);
        assert!(
            !entry
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
            "{name} must still be the member's own file, not a link"
        );
    }
    assert_eq!(
        std::fs::read_to_string(home.join("auth.json")).unwrap(),
        r#"{"token":"secret"}"#
    );
}

/// Two sessions at once each create their own state. The first to end is
/// adopted; the second cannot be — Codex reads one file, and merging two
/// SQLite databases is not something Ply may attempt. But it is the member's
/// conversation, so it is **kept for recovery**, never deleted.
#[test]
fn a_second_overlays_state_is_kept_for_recovery_not_deleted() {
    let home = TempDir::new().unwrap();
    write(&home.path().join("auth.json"), "{}");
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());

    let first = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let second = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    write(&first.path().join("state_5.sqlite"), "first");
    write(&second.path().join("state_5.sqlite"), "second");

    drop(first);
    drop(second);

    // The winner is in the member's home, where Codex will read it.
    assert_eq!(
        std::fs::read_to_string(home.path().join("state_5.sqlite")).unwrap(),
        "first"
    );

    // And the loser still exists — somewhere a human can get at it.
    let rescued: Vec<_> = std::fs::read_dir(recovered.path())
        .unwrap()
        .flatten()
        .map(|e| e.path().join("state_5.sqlite"))
        .filter(|p| p.is_file())
        .collect();
    assert_eq!(rescued.len(), 1, "the second session's state was thrown away");
    assert_eq!(std::fs::read_to_string(&rescued[0]).unwrap(), "second");
}

/// **A crash is exactly when a first session's history is sitting in an
/// overlay**, and the startup sweep used to be the one path that still
/// deleted it. Each overlay names its home, so the sweep adopts before it
/// removes.
#[test]
fn the_sweep_gives_a_crashed_sessions_state_back_before_removing_it() {
    let home = TempDir::new().unwrap();
    write(&home.path().join("auth.json"), "{}");
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();

    let overlay = build(
        overlays.path(),
        recovered.path(),
        home.path(),
        &marketplace(library.path()),
    )
    .unwrap();
    write(&overlay.path().join("thread_history_1.sqlite"), "a conversation");
    write(&overlay.path().join("memories").join("note.md"), "remembered");
    let stranded = overlay.path().to_path_buf();
    std::mem::forget(overlay); // as if Plyloft were killed mid-session

    sweep(overlays.path(), recovered.path());

    assert!(dir_gone(&stranded), "the overlay is still cleared");
    assert_eq!(
        std::fs::read_to_string(home.path().join("thread_history_1.sqlite")).unwrap(),
        "a conversation"
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("memories").join("note.md")).unwrap(),
        "remembered"
    );
}

/// An overlay whose home is gone cannot be given back, so it is kept rather
/// than deleted: Ply would rather leave a directory behind than lose a
/// conversation.
#[test]
fn the_sweep_keeps_an_overlay_whose_state_it_cannot_place() {
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let stranded = overlays.path().join("orphan");
    std::fs::create_dir_all(&stranded).unwrap();
    // A marker naming a home that no longer exists.
    write(
        &stranded.join(".ply-overlay.json"),
        r#"{"real_home":"/nonexistent/codex/home"}"#,
    );
    write(&stranded.join("thread_history_1.sqlite"), "a conversation");

    sweep(overlays.path(), recovered.path());

    assert!(
        stranded.join("thread_history_1.sqlite").is_file(),
        "an overlay that could not be given back must be kept"
    );
}

/// A directory with no marker never got past creation, so it holds nothing
/// worth keeping and is simply removed.
#[test]
fn the_sweep_removes_an_overlay_that_never_got_started() {
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let half_built = overlays.path().join("half-built");
    std::fs::create_dir_all(&half_built).unwrap();

    sweep(overlays.path(), recovered.path());
    assert!(!half_built.exists());
}

/// A crash leaves overlays behind; the next launch clears them.
#[test]
fn the_sweep_clears_overlays_a_crash_left_behind() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());

    let stranded = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let stranded_path = stranded.path().to_path_buf();
    std::mem::forget(stranded); // as if Plyloft were killed mid-session

    sweep(overlays.path(), recovered.path());
    assert!(dir_gone(&stranded_path));
    assert!(overlays.path().is_dir(), "the root itself stays");
    // And the sweep, like the drop, does not reach through the links.
    assert!(home.path().join("auth.json").is_file());
}

/// A team marketplace named like one the member already installed would
/// otherwise be copied into their linked cache — a write into `~/.codex`.
#[test]
fn a_marketplace_name_colliding_with_an_installed_one_is_refused() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let mut market = marketplace(library.path());
    market.name = "openai-curated-remote".into();

    let error = build(overlays.path(), recovered.path(), home.path(), &market).expect_err("must refuse");
    assert!(error.contains("collides"), "{error}");

    // The member's own cache is untouched, and the half-built overlay is gone.
    assert_eq!(
        std::fs::read_to_string(
            home.path()
                .join("plugins")
                .join("cache")
                .join("openai-curated-remote")
                .join("ads-manager")
                .join("0.1.19")
                .join("marker")
        )
        .unwrap(),
        "theirs"
    );
    assert_eq!(std::fs::read_dir(overlays.path()).unwrap().count(), 0);
}

/// A home with no `config.toml` is a fresh Codex install, not an error.
#[test]
fn a_home_without_a_config_still_gets_one() {
    let home = TempDir::new().unwrap();
    write(&home.path().join("auth.json"), "{}");
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();

    let overlay = build(overlays.path(), recovered.path(), home.path(), &marketplace(library.path())).unwrap();
    let config = std::fs::read_to_string(overlay.path().join("config.toml")).unwrap();
    assert!(config.contains("[plugins.\"ply-team@ply-team\"]"));
    assert!(!home.path().join("config.toml").exists());
}

#[test]
fn a_missing_codex_home_is_a_named_refusal_not_a_panic() {
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let library = TempDir::new().unwrap();
    let error = build(
        overlays.path(),
        recovered.path(),
        Path::new("/nonexistent/codex/home"),
        &marketplace(library.path()),
    )
    .expect_err("must refuse");
    assert!(error.contains("codex login"), "{error}");
}

/// TOML is not JSON, and Ply no longer writes it by hand: a path with a
/// quote or a backslash, and a marketplace name that is not a bare key, must
/// survive into a file that parses. A broken one would make Codex refuse the
/// whole config — the member's own settings included.
#[test]
fn awkward_names_and_paths_survive_into_valid_toml() {
    let market = CodexMarketplace {
        root: std::path::PathBuf::from(r#"/tmp/a "quoted"\path"#),
        name: "team lib".into(),
        plugins: vec![CodexPlugin {
            name: "p".into(),
            version: "1".into(),
            dir: std::path::PathBuf::from("/tmp/p"),
        }],
        label: crate::team_skills::TEAM_MARKETPLACE_LABEL.into(),
    };
    let config = team_config("", &market).expect("a config");
    let parsed: toml::Table = toml::from_str(&config).expect("valid TOML");

    assert_eq!(
        parsed["marketplaces"]["team lib"]["source"].as_str(),
        Some(r#"/tmp/a "quoted"\path"#)
    );
    assert_eq!(
        parsed["marketplaces"]["team lib"]["source_type"].as_str(),
        Some("local")
    );
    assert_eq!(
        parsed["plugins"]["p@team lib"]["enabled"].as_bool(),
        Some(true)
    );
}

/// The member's own settings survive the round trip.
#[test]
fn the_members_own_settings_are_preserved() {
    let market = CodexMarketplace {
        root: std::path::PathBuf::from("/tmp/lib"),
        name: "team".into(),
        plugins: Vec::new(),
        label: crate::team_skills::TEAM_MARKETPLACE_LABEL.into(),
    };
    let config = team_config(
        "model = \"gpt-6\"\n\n[projects.\"/Users/x/code\"]\ntrust_level = \"trusted\"\n",
        &market,
    )
    .expect("a config");
    let parsed: toml::Table = toml::from_str(&config).expect("valid TOML");

    assert_eq!(parsed["model"].as_str(), Some("gpt-6"));
    assert_eq!(
        parsed["projects"]["/Users/x/code"]["trust_level"].as_str(),
        Some("trusted")
    );
    assert!(parsed["marketplaces"].get("team").is_some());
}

/// **A duplicate TOML table makes Codex refuse the whole file** — measured:
/// "failed to load bootstrap configuration … duplicate key". So a member who
/// has already registered a marketplace of that name must not have one
/// appended; they would lose their own settings, not just the team skills.
/// Appending text could not see the existing entry at all.
#[test]
fn a_marketplace_the_member_already_registered_is_refused_not_duplicated() {
    let market = CodexMarketplace {
        root: std::path::PathBuf::from("/tmp/lib"),
        name: "ply-team".into(),
        plugins: Vec::new(),
        label: crate::team_skills::TEAM_MARKETPLACE_LABEL.into(),
    };
    let theirs = "[marketplaces.ply-team]\nsource_type = \"local\"\nsource = \"/their/own\"\n";

    let error = team_config(theirs, &market).expect_err("must refuse");
    assert!(error.contains("already have"), "{error}");
    assert!(error.contains("ply-team"), "{error}");
}

/// Same for a plugin id they already have installed.
#[test]
fn a_plugin_the_member_already_has_is_refused() {
    let market = CodexMarketplace {
        root: std::path::PathBuf::from("/tmp/lib"),
        name: "ply-team".into(),
        plugins: vec![CodexPlugin {
            name: "shared".into(),
            version: "1".into(),
            dir: std::path::PathBuf::from("/tmp/p"),
        }],
        label: crate::team_skills::TEAM_MARKETPLACE_LABEL.into(),
    };
    let theirs = "[plugins.\"shared@ply-team\"]\nenabled = false\n";

    let error = team_config(theirs, &market).expect_err("must refuse");
    assert!(error.contains("shared@ply-team"), "{error}");
}

/// A config Ply cannot parse is left alone rather than replaced with one that
/// silently drops the member's settings.
#[test]
fn an_unparseable_member_config_refuses_the_overlay() {
    let market = CodexMarketplace {
        root: std::path::PathBuf::from("/tmp/lib"),
        name: "team".into(),
        plugins: Vec::new(),
        label: crate::team_skills::TEAM_MARKETPLACE_LABEL.into(),
    };
    let error = team_config("this is not = = toml", &market).expect_err("must refuse");
    assert!(error.contains("left it alone"), "{error}");
}

/// `preflight` is the doctor's answer to "would a session actually get
/// these?", and it must agree with `build` without writing anything.
#[test]
fn preflight_agrees_with_build_and_writes_nothing() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());

    let before = std::fs::read_dir(home.path()).unwrap().count();
    assert!(preflight(home.path(), &market).is_ok());
    assert_eq!(
        std::fs::read_dir(home.path()).unwrap().count(),
        before,
        "preflight must not create anything"
    );
    assert!(build(overlays.path(), recovered.path(), home.path(), &market).is_ok());

    // And it refuses exactly what build refuses.
    let mut colliding = market.clone();
    colliding.name = "openai-curated-remote".into();
    assert!(preflight(home.path(), &colliding).is_err());
    assert!(build(overlays.path(), recovered.path(), home.path(), &colliding).is_err());

    assert!(preflight(Path::new("/nonexistent/codex"), &market)
        .unwrap_err()
        .contains("codex login"));
}

/// W3 review B1: a member's own file that reached the overlay as a hard link
/// is theirs already, and is never moved over itself or into recovery.
#[cfg(windows)]
#[test]
fn a_hard_linked_home_file_is_not_adopted() {
    let home = real_home();
    let overlay = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    std::fs::hard_link(home.path().join("auth.json"), overlay.path().join("auth.json")).unwrap();

    assert!(adopt_new_state(overlay.path(), home.path(), recovered.path()));
    assert_eq!(std::fs::read_dir(recovered.path()).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_to_string(home.path().join("auth.json")).unwrap(),
        r#"{"token":"secret"}"#
    );
}

/// v1.154.1 round 3 (walk J1): Codex records a thread's transcript as
/// `$CODEX_HOME/sessions/…` — inside the overlay. After the overlay goes, that
/// path must still reach the transcript (it was written through the linked
/// `sessions`), or `codex resume <id>` fails with "no rollout found".
#[cfg(unix)]
#[test]
fn a_finished_overlays_path_still_reaches_its_transcripts() {
    let built = build_overlay();
    let overlay_path = built.overlay.path().to_path_buf();
    let recorded = overlay_path.join("sessions/2026/09/29/rollout-x.jsonl");
    write(&recorded, "{\"type\":\"session_meta\"}");
    let Built { overlay, home_path, .. } = built;
    drop(overlay);

    let link = std::fs::symlink_metadata(&overlay_path).expect("the path stays");
    assert!(link.file_type().is_symlink(), "only a link is left, not the overlay");
    assert_eq!(std::fs::read_link(&overlay_path).unwrap(), home_path);
    assert_eq!(std::fs::read_to_string(&recorded).unwrap(), "{\"type\":\"session_meta\"}");
    assert!(home_path.join("sessions/2026/09/29/rollout-x.jsonl").is_file());
    // Ply's own copy of the config and its plugins went with the overlay.
    assert!(home_path.join("config.toml").is_file());
    assert!(!home_path.join(".ply-overlay.json").exists());
}

/// The sweep leaves such links alone (they are not overlays), clears a
/// crashed session's overlay, and keeps its path resolving the same way.
#[cfg(unix)]
#[test]
fn the_sweep_keeps_finished_paths_resolving() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());

    let finished = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let finished_path = finished.path().to_path_buf();
    drop(finished);
    let crashed = build(overlays.path(), recovered.path(), home.path(), &market).unwrap();
    let crashed_path = crashed.path().to_path_buf();
    write(&crashed_path.join("sessions/2026/09/29/rollout-y.jsonl"), "y");
    std::mem::forget(crashed);

    sweep(overlays.path(), recovered.path());
    sweep(overlays.path(), recovered.path());

    for path in [&finished_path, &crashed_path] {
        assert!(std::fs::symlink_metadata(path).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_link(path).unwrap(), home.path());
    }
    assert_eq!(
        std::fs::read_to_string(crashed_path.join("sessions/2026/09/29/rollout-y.jsonl")).unwrap(),
        "y"
    );
    assert!(home.path().join("auth.json").is_file(), "never reached through the link");

    // A link whose home is gone reaches nothing and is removed; the others stay.
    let gone_home = TempDir::new().unwrap();
    let dangling = overlays.path().join("dangling");
    std::os::unix::fs::symlink(gone_home.path(), &dangling).unwrap();
    drop(gone_home);
    sweep(overlays.path(), recovered.path());
    assert!(dangling.symlink_metadata().is_err());
    assert!(finished_path.symlink_metadata().is_ok());
}

/// A build that fails never had a session, so it leaves nothing behind.
#[test]
fn a_refused_build_leaves_no_link() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    // A config Codex cannot parse refuses every marketplace.
    write(&home.path().join("config.toml"), "not = [valid");
    assert!(build(overlays.path(), recovered.path(), home.path(), &marketplace(library.path())).is_err());
    assert_eq!(std::fs::read_dir(overlays.path()).unwrap().count(), 0);
}

/// Round 3: "Trust and continue" in a Ply session lands in the overlay's copy
/// of `config.toml`. It is kept in Ply's own ledger — never in the member's
/// file — and every later overlay carries it, so Codex does not ask again.
#[test]
fn a_trust_answer_outlives_its_overlay_without_touching_the_members_config() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let overlays = root.path().join("codex-home");
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());
    let theirs = std::fs::read_to_string(home.path().join("config.toml")).unwrap();

    let first = build(&overlays, recovered.path(), home.path(), &market).unwrap();
    // What Codex writes after "Trust and continue" (keyed by the repo root).
    let mut config = std::fs::read_to_string(first.path().join("config.toml")).unwrap();
    config.push_str("\n[projects.\"/w/sandbox app\"]\ntrust_level = \"trusted\"\n");
    std::fs::write(first.path().join("config.toml"), config).unwrap();
    drop(first);

    assert_eq!(std::fs::read_to_string(home.path().join("config.toml")).unwrap(), theirs);
    let ledger = trust_ledger_path(&overlays);
    assert_eq!(ledger, root.path().join("codex-trusted-projects.json"));
    assert_eq!(read_trust_ledger(&ledger).projects, vec!["/w/sandbox app".to_string()]);

    let second = build(&overlays, recovered.path(), home.path(), &market).unwrap();
    let carried = std::fs::read_to_string(second.path().join("config.toml")).unwrap();
    let trusted = trusted_projects(&carried);
    assert!(trusted.contains(&"/w/sandbox app".to_string()), "{carried}");
    assert!(trusted.contains(&"/Users/someone/code".to_string()), "the member's own stays");
    assert!(carried.contains("ply-team"), "the team entries are still there");
    drop(second);
    // Carried answers are not added to the ledger twice.
    assert_eq!(read_trust_ledger(&ledger).projects.len(), 1);
}

/// QoL 1.168 (block 4): "Trust and continue" in a session that is still
/// running reaches the next overlay at once — a second Codex tile in that
/// folder doesn't ask again — and the member's own `config.toml` is still
/// never written. An overlay of another home and a finished session's link
/// lend nothing.
#[test]
fn a_trust_answer_in_a_live_session_reaches_the_next_overlay_at_once() {
    let home = real_home();
    let library = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let overlays = root.path().join("codex-home");
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());
    let theirs = std::fs::read_to_string(home.path().join("config.toml")).unwrap();

    let first = build(&overlays, recovered.path(), home.path(), &market).unwrap();
    let mut config = std::fs::read_to_string(first.path().join("config.toml")).unwrap();
    config.push_str("\n[projects.\"/w/notes app\"]\ntrust_level = \"trusted\"\n");
    std::fs::write(first.path().join("config.toml"), config).unwrap();

    // Another home's live overlay, trusting a folder of its own.
    let other_home = real_home();
    let other = build(&overlays, recovered.path(), other_home.path(), &market).unwrap();
    let mut other_config = std::fs::read_to_string(other.path().join("config.toml")).unwrap();
    other_config.push_str("\n[projects.\"/w/elsewhere\"]\ntrust_level = \"trusted\"\n");
    std::fs::write(other.path().join("config.toml"), other_config).unwrap();

    // The first is still open.
    let second = build(&overlays, recovered.path(), home.path(), &market).unwrap();
    let carried = std::fs::read_to_string(second.path().join("config.toml")).unwrap();
    let trusted = trusted_projects(&carried);
    assert!(trusted.contains(&"/w/notes app".to_string()), "{carried}");
    assert!(!trusted.contains(&"/w/elsewhere".to_string()), "another home's answer stays its own");
    assert!(trusted.contains(&"/Users/someone/code".to_string()), "the member's own stays");
    assert!(first.path().is_dir(), "the live overlay is only read");
    assert_eq!(std::fs::read_to_string(home.path().join("config.toml")).unwrap(), theirs);

    drop(second);
    drop(other);
    drop(first);
    // Carried once, kept once: the ledger has no duplicate after the ends.
    let ledger = read_trust_ledger(&trust_ledger_path(&overlays)).projects;
    assert_eq!(ledger.iter().filter(|p| p.as_str() == "/w/notes app").count(), 1, "{ledger:?}");
    assert_eq!(std::fs::read_to_string(home.path().join("config.toml")).unwrap(), theirs);
}

/// A folder the member's own config speaks for keeps their word, and a
/// session that answered nothing writes no ledger.
#[test]
fn a_kept_answer_never_overrides_the_members_own_entry() {
    let dir = TempDir::new().unwrap();
    let ledger = dir.path().join("codex-trusted-projects.json");
    crate::atomic::write_atomic_json(
        &ledger,
        &TrustLedger { projects: vec!["/w/a".into(), "/w/b".into()] },
    )
    .unwrap();
    let config = with_kept_trust("[projects.\"/w/a\"]\ntrust_level = \"untrusted\"\n".into(), &ledger);
    assert_eq!(trusted_projects(&config), vec!["/w/b".to_string()]);
    assert!(config.contains("untrusted"));

    let home = real_home();
    let overlay = TempDir::new().unwrap();
    let untouched = dir.path().join("none.json");
    std::fs::copy(home.path().join("config.toml"), overlay.path().join("config.toml")).unwrap();
    keep_trust_answers(overlay.path(), home.path(), &untouched);
    assert!(!untouched.exists());
}

/// The ledger is new persisted state: a missing, empty, older or later file
/// loads (as empty, or ignoring fields it doesn't know), and it round-trips.
#[test]
fn the_trust_ledger_loads_whatever_is_on_disk() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("codex-trusted-projects.json");
    assert_eq!(read_trust_ledger(&path), TrustLedger::default());
    std::fs::write(&path, "{}").unwrap();
    assert_eq!(read_trust_ledger(&path), TrustLedger::default());
    std::fs::write(&path, r#"{"projects":["/w/a"],"laterField":1}"#).unwrap();
    assert_eq!(read_trust_ledger(&path).projects, vec!["/w/a".to_string()]);
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(read_trust_ledger(&path), TrustLedger::default());
    crate::atomic::write_atomic_json(&path, &TrustLedger { projects: vec!["/w/b".into()] }).unwrap();
    assert_eq!(read_trust_ledger(&path).projects, vec!["/w/b".to_string()]);
}

// ── Windows placement (2026-09-30): junctions, hard links, `sqlite_home` ──
//
// `LinkStyle::Windows` is exercised on every platform: hard links and the
// config behave the same on the Mac, and a directory link is a symlink there
// instead of a junction. The `#[cfg(windows)]` cases below run the native
// build, where a directory becomes a junction on a machine without Developer
// Mode (`cargo test --lib codex_home::` in the VM).

struct WindowsBuilt {
    home: TempDir,
    _library: TempDir,
    overlays: TempDir,
    recovered: TempDir,
    overlay: CodexHomeOverlay,
}

fn windows_home() -> TempDir {
    let home = real_home();
    write(&home.path().join("state_5.sqlite-wal"), "journal");
    write(&home.path().join("history.jsonl"), "one\n");
    home
}

fn build_windows_style(home: TempDir) -> WindowsBuilt {
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());
    let overlay = build_all_styled(
        overlays.path(),
        recovered.path(),
        home.path(),
        &[&market],
        LinkStyle::Windows,
    )
    .expect("build the overlay");
    WindowsBuilt { home, _library: library, overlays, recovered, overlay }
}

fn recovered_files(recovered: &Path, name: &str) -> Vec<String> {
    std::fs::read_dir(recovered)
        .map(|dirs| {
            dirs.flatten()
                .map(|d| d.path().join(name))
                .filter(|p| p.is_file())
                .map(|p| std::fs::read_to_string(p).unwrap())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn windows_style_hard_links_files_links_directories_and_leaves_databases_to_sqlite_home() {
    let built = build_windows_style(windows_home());
    let overlay = built.overlay.path();
    let home = built.home.path();

    for name in ["auth.json", "history.jsonl"] {
        let placed = overlay.join(name);
        assert!(!placed.symlink_metadata().unwrap().file_type().is_symlink(), "{name}");
        assert!(is_same_file(&placed, &home.join(name)), "{name} must be the member's own file");
    }
    for name in ["memories", ".tmp", "sessions"] {
        assert!(
            overlay.join(name).symlink_metadata().unwrap().file_type().is_symlink(),
            "{name}: a link (a junction on Windows), never a copy"
        );
    }
    // No database is placed: two `-wal` journals for one database would be
    // the member's history corrupted.
    for name in ["state_5.sqlite", "state_5.sqlite-wal"] {
        assert!(overlay.join(name).symlink_metadata().is_err(), "{name} must not be in the overlay");
    }
    let config: toml::Table =
        toml::from_str(&std::fs::read_to_string(overlay.join("config.toml")).unwrap()).unwrap();
    assert_eq!(config["sqlite_home"].as_str(), Some(home.to_string_lossy().as_ref()));
    // The marker names the hard links, sorted, before they were made.
    let marker = read_marker_full(overlay).unwrap();
    assert_eq!(marker.hard_links, vec!["auth.json".to_string(), "history.jsonl".to_string()]);
    // The member's own config is not touched.
    assert!(!std::fs::read_to_string(home.join("config.toml")).unwrap().contains("sqlite_home"));
}

#[test]
fn windows_style_writes_reach_the_real_file_and_dropping_leaves_the_home_whole() {
    let built = build_windows_style(windows_home());
    let overlay_path = built.overlay.path().to_path_buf();
    // An in-place append, the way Codex writes its history.
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(overlay_path.join("history.jsonl"))
            .unwrap();
        file.write_all(b"two\n").unwrap();
    }
    write(&overlay_path.join("memories").join("new.md"), "through the link");
    // Something the session created: adopted into the real home.
    write(&overlay_path.join("installation_id"), "abc");

    let WindowsBuilt { home, overlay, recovered, overlays, .. } = built;
    drop(overlay);

    let home = home.path();
    assert_eq!(std::fs::read_to_string(home.join("history.jsonl")).unwrap(), "one\ntwo\n");
    assert_eq!(std::fs::read_to_string(home.join("auth.json")).unwrap(), r#"{"token":"secret"}"#);
    assert_eq!(std::fs::read_to_string(home.join("state_5.sqlite")).unwrap(), "sqlite");
    assert_eq!(std::fs::read_to_string(home.join("state_5.sqlite-wal")).unwrap(), "journal");
    assert_eq!(std::fs::read_to_string(home.join("memories").join("note.md")).unwrap(), "remembered");
    assert_eq!(std::fs::read_to_string(home.join("memories").join("new.md")).unwrap(), "through the link");
    assert_eq!(std::fs::read_to_string(home.join("installation_id")).unwrap(), "abc");
    assert!(home.join("plugins/cache/openai-curated-remote/ads-manager/0.1.19/marker").is_file());
    assert!(dir_gone(&overlay_path));
    assert_eq!(std::fs::read_dir(recovered.path()).unwrap().count(), 0, "nothing needed rescuing");
    drop(overlays);
}

/// `codex logout` in a terminal while a Plyloft tile runs: the overlay's hard
/// link is then the only name of the old `auth.json`. It must not be put back
/// into the home — the member removed it — and it is not thrown away either.
#[test]
fn windows_style_never_puts_back_a_file_the_member_removed() {
    let built = build_windows_style(windows_home());
    std::fs::remove_file(built.home.path().join("auth.json")).unwrap();
    let WindowsBuilt { home, overlay, recovered, .. } = built;
    drop(overlay);
    assert!(!home.path().join("auth.json").exists(), "a removed sign-in came back");
    assert_eq!(recovered_files(recovered.path(), "auth.json"), vec![r#"{"token":"secret"}"#.to_string()]);
}

/// A file Codex replaced (write a new one, rename it over) is no longer the
/// member's: the real one is left as it was, the new one is kept for recovery.
#[test]
fn windows_style_keeps_a_replaced_file_for_recovery() {
    let built = build_windows_style(windows_home());
    let overlay = built.overlay.path().to_path_buf();
    write(&overlay.join("auth.json.tmp"), r#"{"token":"new"}"#);
    std::fs::rename(overlay.join("auth.json.tmp"), overlay.join("auth.json")).unwrap();
    let WindowsBuilt { home, overlay, recovered, .. } = built;
    drop(overlay);
    assert_eq!(std::fs::read_to_string(home.path().join("auth.json")).unwrap(), r#"{"token":"secret"}"#);
    assert_eq!(recovered_files(recovered.path(), "auth.json"), vec![r#"{"token":"new"}"#.to_string()]);
}

/// A crash: the startup sweep gives the session's state back and removes the
/// overlay without reaching through a single link.
#[test]
fn windows_style_sweep_after_a_crash_leaves_the_home_whole() {
    let built = build_windows_style(windows_home());
    let overlay_path = built.overlay.path().to_path_buf();
    write(&overlay_path.join("goals_1.sqlite"), "created by a Codex that ignored sqlite_home");
    let WindowsBuilt { home, overlay, recovered, overlays, .. } = built;
    std::mem::forget(overlay);

    sweep(overlays.path(), recovered.path());

    let home = home.path();
    assert!(dir_gone(&overlay_path));
    for (name, contents) in [
        ("auth.json", r#"{"token":"secret"}"#),
        ("history.jsonl", "one\n"),
        ("state_5.sqlite", "sqlite"),
        ("goals_1.sqlite", "created by a Codex that ignored sqlite_home"),
    ] {
        assert_eq!(std::fs::read_to_string(home.join(name)).unwrap(), contents, "{name}");
    }
    assert_eq!(std::fs::read_to_string(home.join("memories/note.md")).unwrap(), "remembered");
    assert_eq!(std::fs::read_dir(recovered.path()).unwrap().count(), 0);
}

/// Persisted-state compatibility: a marker written before `hard_links`
/// existed reads as having none, and a marker with none is written exactly as
/// before, so an older build reads a newer build's unix marker unchanged.
#[test]
fn an_overlay_marker_from_before_hard_links_still_reads() {
    let old: OverlayMarker = serde_json::from_str(r#"{"real_home":"/Users/m/.codex"}"#).unwrap();
    assert_eq!(
        old,
        OverlayMarker { real_home: PathBuf::from("/Users/m/.codex"), hard_links: Vec::new() }
    );
    assert_eq!(serde_json::to_string(&old).unwrap(), r#"{"real_home":"/Users/m/.codex"}"#);
    // And an overlay swept with an old marker is adopted as before.
    let home = real_home();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = overlays.path().join("old");
    std::fs::create_dir(&overlay).unwrap();
    std::fs::write(
        overlay.join(MARKER),
        serde_json::to_vec(&serde_json::json!({ "real_home": home.path() })).unwrap(),
    )
    .unwrap();
    write(&overlay.join("installation_id"), "id");
    sweep(overlays.path(), recovered.path());
    assert_eq!(std::fs::read_to_string(home.path().join("installation_id")).unwrap(), "id");
}

#[test]
fn sqlite_home_points_at_the_real_home_unless_the_member_chose_one() {
    let home = Path::new("/Users/m/.codex");
    let read = |config: String| toml::from_str::<toml::Table>(&config).unwrap();
    let set = read(with_sqlite_home("model = \"o3\"\n".into(), home, false));
    assert_eq!(set["sqlite_home"].as_str(), Some("/Users/m/.codex"));
    assert_eq!(set["model"].as_str(), Some("o3"));
    let theirs = read(with_sqlite_home("sqlite_home = \"/data/codex\"\n".into(), home, false));
    assert_eq!(theirs["sqlite_home"].as_str(), Some("/data/codex"));
    let relative = read(with_sqlite_home("sqlite_home = \"db\"\n".into(), home, false));
    assert_eq!(relative["sqlite_home"].as_str(), Some(home.join("db").to_string_lossy().as_ref()));
    let env = read(with_sqlite_home("model = \"o3\"\n".into(), home, true));
    assert!(env.get("sqlite_home").is_none(), "CODEX_SQLITE_HOME already names theirs");
}

/// The capability probe links one file and one directory the way a build
/// would and leaves nothing behind — above all nothing of the member's gone.
#[test]
fn the_link_probe_answers_and_leaves_nothing() {
    let home = windows_home();
    let overlays = TempDir::new().unwrap();
    assert_eq!(probe_links(overlays.path(), home.path(), LinkStyle::Windows), Ok(()));
    assert_eq!(std::fs::read_dir(overlays.path()).unwrap().count(), 0);
    assert_eq!(std::fs::read_to_string(home.path().join("auth.json")).unwrap(), r#"{"token":"secret"}"#);
    assert_eq!(std::fs::read_to_string(home.path().join("memories/note.md")).unwrap(), "remembered");
    // An empty home has nothing to link, so nothing to refuse, and no probe.
    let empty = TempDir::new().unwrap();
    assert_eq!(probe_links(overlays.path(), empty.path(), LinkStyle::Windows), Ok(()));
    assert_eq!(std::fs::read_dir(overlays.path()).unwrap().count(), 0);
}

/// The overlay's removal never goes through a link, at any level Ply links
/// into — nor lists a `plugins` that is itself a link.
#[test]
fn removing_an_overlay_never_reaches_through_its_links() {
    let theirs = TempDir::new().unwrap();
    write(&theirs.path().join("keep.txt"), "theirs");
    write(&theirs.path().join("inner").join("keep.txt"), "theirs");
    let root = TempDir::new().unwrap();
    let overlay = root.path().join("overlay");
    std::fs::create_dir_all(overlay.join("plugins").join("cache")).unwrap();
    crate::platform::link(theirs.path(), &overlay.join("top")).unwrap();
    crate::platform::link(theirs.path(), &overlay.join("plugins").join("linked")).unwrap();
    crate::platform::link(theirs.path(), &overlay.join("plugins").join("cache").join("m")).unwrap();
    std::fs::hard_link(theirs.path().join("keep.txt"), overlay.join("hard.txt")).unwrap();
    remove_overlay_dir(&overlay).unwrap();
    assert!(overlay.symlink_metadata().is_err());
    assert_eq!(std::fs::read_to_string(theirs.path().join("keep.txt")).unwrap(), "theirs");
    assert_eq!(std::fs::read_to_string(theirs.path().join("inner/keep.txt")).unwrap(), "theirs");

    // `plugins` itself a link: removed as a link, its target never listed.
    let other = root.path().join("other");
    std::fs::create_dir(&other).unwrap();
    crate::platform::link(theirs.path(), &other.join("plugins")).unwrap();
    remove_overlay_dir(&other).unwrap();
    assert!(other.symlink_metadata().is_err());
    assert!(theirs.path().join("inner/keep.txt").is_file());
}

#[test]
fn a_codex_home_on_another_drive_is_refused_in_words() {
    let code = if cfg!(windows) { 17 } else { 18 };
    let said = hard_link_refusal("auth.json", &std::io::Error::from_raw_os_error(code));
    assert!(said.contains("different drive"), "{said}");
    assert!(said.contains("Codex starts on your own home"), "{said}");
    let other = hard_link_refusal("auth.json", &std::io::Error::from_raw_os_error(13));
    assert!(other.starts_with("link auth.json into the Codex overlay: "), "{other}");
}

/// The VM case: the native build on Windows, where a directory without
/// Developer Mode is a junction.
#[cfg(windows)]
#[test]
fn the_native_windows_overlay_is_junctions_and_hard_links_and_leaves_a_junction_behind() {
    let home = windows_home();
    let library = TempDir::new().unwrap();
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let market = marketplace(library.path());
    let overlay = build(overlays.path(), recovered.path(), home.path(), &market)
        .expect("Windows builds the overlay without Developer Mode");
    let path = overlay.path().to_path_buf();
    assert!(path.join("memories").symlink_metadata().unwrap().file_type().is_symlink());
    assert!(!path.join("auth.json").symlink_metadata().unwrap().file_type().is_symlink());
    assert!(crate::platform::same_file(&path.join("auth.json"), &home.path().join("auth.json")));
    assert!(path.join("state_5.sqlite").symlink_metadata().is_err());
    write(&path.join("sessions/2026/09/30/rollout-w.jsonl"), "w");
    drop(overlay);

    // The path is kept resolving (a junction or a symlink), and the sweep
    // leaves it alone.
    assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(path.join("sessions/2026/09/30/rollout-w.jsonl")).unwrap(), "w");
    sweep(overlays.path(), recovered.path());
    assert!(std::fs::symlink_metadata(&path).is_ok());
    for (name, contents) in [("auth.json", r#"{"token":"secret"}"#), ("state_5.sqlite", "sqlite"), ("history.jsonl", "one\n")] {
        assert_eq!(std::fs::read_to_string(home.path().join(name)).unwrap(), contents, "{name}");
    }
    assert!(home.path().join("memories/note.md").is_file());

    // A tombstone whose home is gone is removed — the link, not its target.
    let gone = TempDir::new().unwrap();
    let dangling = overlays.path().join("dangling");
    crate::platform::link(gone.path(), &dangling).unwrap();
    drop(gone);
    sweep(overlays.path(), recovered.path());
    assert!(dangling.symlink_metadata().is_err());
    assert!(path.symlink_metadata().is_ok());
}

/// Rust's `remove_dir_all` on a directory holding a junction removes the
/// junction, never what it points at (checked here, not assumed).
#[cfg(windows)]
#[test]
fn std_remove_dir_all_does_not_follow_a_junction() {
    let theirs = TempDir::new().unwrap();
    write(&theirs.path().join("keep.txt"), "theirs");
    let root = TempDir::new().unwrap();
    let parent = root.path().join("parent");
    std::fs::create_dir(&parent).unwrap();
    crate::platform::link(theirs.path(), &parent.join("j")).unwrap();
    std::fs::remove_dir_all(&parent).unwrap();
    assert_eq!(std::fs::read_to_string(theirs.path().join("keep.txt")).unwrap(), "theirs");
}

// ── Review round 1: a database and its journals adopt as one unit ──

/// An overlay dir as a crashed session leaves it: its marker, and `files`.
fn crashed_overlay(root: &Path, home: &Path, files: &[(&str, &str)]) -> PathBuf {
    let overlay = root.join("crashed");
    std::fs::create_dir_all(&overlay).unwrap();
    write_marker(&overlay, home, &[]).unwrap();
    for (name, contents) in files {
        write(&overlay.join(name), contents);
    }
    overlay
}

/// BLOCKER (review 1): Codex ignored `sqlite_home` and made its own database
/// with a `-wal` in the overlay. The database cannot go home (the member has
/// one), so its journal must not either — SQLite would replay it into the
/// member's database.
#[test]
fn a_losing_databases_journal_never_goes_into_the_real_home() {
    let home = TempDir::new().unwrap();
    write(&home.path().join("state_5.sqlite"), "the member's 200 rows");
    let root = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = crashed_overlay(
        root.path(),
        home.path(),
        &[("state_5.sqlite", "foreign"), ("state_5.sqlite-wal", "foreign wal"), ("state_5.sqlite-shm", "shm")],
    );

    assert!(adopt_new_state(&overlay, home.path(), recovered.path()));

    assert_eq!(std::fs::read_to_string(home.path().join("state_5.sqlite")).unwrap(), "the member's 200 rows");
    for sidecar in ["state_5.sqlite-wal", "state_5.sqlite-shm"] {
        assert!(!home.path().join(sidecar).exists(), "{sidecar} reached the member's database");
    }
    // Kept together, in one recovery folder.
    let kept: Vec<_> = std::fs::read_dir(recovered.path()).unwrap().flatten().collect();
    assert_eq!(kept.len(), 1);
    for (name, contents) in [("state_5.sqlite", "foreign"), ("state_5.sqlite-wal", "foreign wal")] {
        assert_eq!(std::fs::read_to_string(kept[0].path().join(name)).unwrap(), contents);
    }
}

#[test]
fn a_database_the_session_created_goes_home_with_its_journals() {
    let home = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = crashed_overlay(
        root.path(),
        home.path(),
        &[("goals_1.sqlite", "db"), ("goals_1.sqlite-wal", "wal"), ("notes.db", "db2"), ("notes.db-journal", "j")],
    );
    assert!(adopt_new_state(&overlay, home.path(), recovered.path()));
    for (name, contents) in [("goals_1.sqlite", "db"), ("goals_1.sqlite-wal", "wal"), ("notes.db", "db2"), ("notes.db-journal", "j")] {
        assert_eq!(std::fs::read_to_string(home.path().join(name)).unwrap(), contents, "{name}");
    }
    assert_eq!(std::fs::read_dir(recovered.path()).unwrap().count(), 0);
}

/// A journal with no database of its own in the overlay, a journal beside a
/// *link* to the member's database, and a family whose real home already
/// holds only a journal: all to recovery, none home.
#[test]
fn a_journal_whose_database_is_not_going_home_is_kept_for_recovery() {
    let home = TempDir::new().unwrap();
    write(&home.path().join("state_5.sqlite"), "theirs");
    write(&home.path().join("queue_1.sqlite-wal"), "their wal");
    let root = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = crashed_overlay(
        root.path(),
        home.path(),
        &[("orphan.sqlite-wal", "orphan"), ("queue_1.sqlite", "new db"), ("state_5.sqlite-wal", "beside a link")],
    );
    crate::platform::link(&home.path().join("state_5.sqlite"), &overlay.join("state_5.sqlite"))
        .or_else(|_| std::fs::hard_link(home.path().join("state_5.sqlite"), overlay.join("state_5.sqlite")))
        .unwrap();
    assert!(adopt_new_state(&overlay, home.path(), recovered.path()));
    assert!(!home.path().join("orphan.sqlite-wal").exists());
    assert!(!home.path().join("queue_1.sqlite").exists(), "beside someone else's journal");
    assert!(!home.path().join("state_5.sqlite-wal").exists());
    assert_eq!(std::fs::read_to_string(home.path().join("queue_1.sqlite-wal")).unwrap(), "their wal");
    assert_eq!(std::fs::read_to_string(home.path().join("state_5.sqlite")).unwrap(), "theirs");
    let kept = std::fs::read_dir(recovered.path()).unwrap().flatten().next().unwrap().path();
    for name in ["orphan.sqlite-wal", "queue_1.sqlite", "state_5.sqlite-wal"] {
        assert!(kept.join(name).is_file(), "{name}");
    }
}

#[test]
fn sqlite_families_are_named_by_their_database() {
    assert_eq!(sqlite_family("state_5.sqlite"), Some("state_5.sqlite"));
    assert_eq!(sqlite_family("state_5.sqlite-wal"), Some("state_5.sqlite"));
    assert_eq!(sqlite_family("state_5.sqlite-shm"), Some("state_5.sqlite"));
    assert_eq!(sqlite_family("x.db-journal"), Some("x.db"));
    assert_eq!(sqlite_family("history.jsonl"), None);
    assert_eq!(sqlite_family("sqlite-notes.md"), None);
}

/// Minor (review 1): a cache Codex rewrites with a rename, to what the
/// member's file already says, is not state worth rescuing every session.
#[test]
fn windows_style_a_replaced_file_with_the_same_contents_is_dropped() {
    let built = build_windows_style(windows_home());
    let overlay = built.overlay.path().to_path_buf();
    write(&overlay.join("history.jsonl.tmp"), "one\n");
    std::fs::rename(overlay.join("history.jsonl.tmp"), overlay.join("history.jsonl")).unwrap();
    let WindowsBuilt { home, overlay, recovered, .. } = built;
    drop(overlay);
    assert_eq!(std::fs::read_to_string(home.path().join("history.jsonl")).unwrap(), "one\n");
    assert_eq!(std::fs::read_dir(recovered.path()).unwrap().count(), 0);
}

/// Minor (review 1): the marker is written atomically; a temp a crash left
/// beside it is Ply's, never adopted into the member's home.
#[test]
fn a_marker_temp_left_by_a_crash_is_not_adopted() {
    let home = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = crashed_overlay(root.path(), home.path(), &[(".ply-overlay.json.atelier-tmp", "{")]);
    assert!(adopt_new_state(&overlay, home.path(), recovered.path()));
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    assert_eq!(read_marker(&overlay), Some(home.path().to_path_buf()));
}

#[test]
fn codex_versions_compare_by_number() {
    assert!(version_at_least(Some("0.158.0"), (0, 158, 0)));
    assert!(version_at_least(Some("codex-cli 0.159.2\n"), (0, 158, 0)));
    assert!(!version_at_least(Some("0.157.9"), (0, 158, 0)));
    assert!(!version_at_least(None, (0, 158, 0)));
    // Not initialised (a test) or not Windows: never the reason.
    assert_eq!(windows_codex_supported(None), Ok(()));
    assert_eq!(windows_codex_supported(Some(None)), Ok(()));
}

/// The Windows gate: an unanswered probe is said as such, distinct from a
/// Codex with no readable version.
#[test]
fn the_windows_codex_gate_says_which_case_it_is() {
    let pending = sqlite_home_gate(None).unwrap_err();
    assert!(pending.contains("still checking Codex"), "{pending}");
    let unknown = sqlite_home_gate(Some(None)).unwrap_err();
    assert!(unknown.contains("could not read this Codex's version"), "{unknown}");
    assert!(sqlite_home_gate(Some(Some("0.157.0"))).unwrap_err().contains("0.157.0"));
    assert_eq!(sqlite_home_gate(Some(Some("codex-cli 0.159.2"))), Ok(()));
}
