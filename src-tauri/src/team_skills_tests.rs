//! v1.116.0 (team sharing rung 3) — reading the team skill library.
//!
//! The fixtures here are the layouts the real CLIs accept, established
//! against Claude Code 2.1.267 and codex-cli 0.154.0 (see
//! `docs/team-sharing/PLAN.md`, Rung 3). If a vendor changes its format, one
//! of these fixtures is what must change with it.

use super::*;
use tempfile::TempDir;

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

const SKILL: &str = "---\nname: team-conventions\ndescription: How this team ships.\n---\n\nShip through cards.\n";

/// A team clone carrying the same skill in both halves of its library.
fn clone_with_both_halves() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    let claude = claude_library_dir(root).join("ply-team");
    write(
        &claude.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"ply-team","description":"Team skills","version":"1.2.0"}"#,
    );
    write(&claude.join("skills").join("team-conventions").join("SKILL.md"), SKILL);
    write(
        &claude.join("agents").join("team-reviewer.md"),
        "---\nname: team-reviewer\ndescription: Reviews a diff.\n---\n",
    );

    let codex = codex_library_dir(root);
    write(
        &codex_marketplace_manifest(&codex),
        r#"{"name":"ply-team","interface":{"displayName":"Plyloft team library"},
            "plugins":[{"name":"ply-team","source":{"source":"local","path":"./plugins/ply-team"},
            "policy":{"installation":"AVAILABLE"}}]}"#,
    );
    let codex_plugin = codex.join("plugins").join("ply-team");
    write(
        &codex_plugin.join(".codex-plugin").join("plugin.json"),
        r#"{"name":"ply-team","version":"1.2.0","description":"Team skills"}"#,
    );
    write(
        &codex_plugin.join("skills").join("team-conventions").join("SKILL.md"),
        SKILL,
    );
    dir
}

#[test]
fn one_skill_published_to_both_halves_is_one_row_with_two_badges() {
    let dir = clone_with_both_halves();
    let library = read_library(dir.path());

    assert!(library.errors.is_empty(), "{:?}", library.errors);
    assert_eq!(library.skills.len(), 1, "{:?}", library.skills);
    let skill = &library.skills[0];
    assert_eq!(skill.name, "team-conventions");
    assert_eq!(skill.description, "How this team ships.");
    assert!(skill.claude && skill.codex);
    assert!(skill.both_vendors());

    // Both halves are loadable: one plugin directory for Claude's flag, one
    // marketplace for the Codex overlay.
    assert_eq!(library.claude_plugin_dirs.len(), 1);
    let codex = library.codex.as_ref().expect("codex marketplace");
    assert_eq!(codex.name, "ply-team");
    assert_eq!(codex.plugins.len(), 1);
    assert_eq!(codex.plugins[0].version, "1.2.0");
    assert_eq!(codex.plugin_id(&codex.plugins[0]), "ply-team@ply-team");

    assert_eq!(library.loaded_for(Vendor::Claude), 1);
    assert_eq!(library.loaded_for(Vendor::Codex), 1);
}

/// The asymmetry the rung is meant to prevent: a skill only one CLI can load.
/// It is reported, not hidden — the badge and the doctor row are what make it
/// visible to whoever published it.
#[test]
fn a_skill_in_only_one_half_carries_only_that_badge() {
    let dir = clone_with_both_halves();
    write(
        &claude_library_dir(dir.path())
            .join("ply-team")
            .join("skills")
            .join("claude-only")
            .join("SKILL.md"),
        "---\nname: claude-only\ndescription: Only here.\n---\n",
    );

    let library = read_library(dir.path());
    let lonely = library
        .skills
        .iter()
        .find(|s| s.name == "claude-only")
        .expect("the one-sided skill is listed");
    assert!(lonely.claude && !lonely.codex);
    assert!(!lonely.both_vendors());
    assert_eq!(library.loaded_for(Vendor::Claude), 2);
    assert_eq!(library.loaded_for(Vendor::Codex), 1);
}

/// Hooks handed to `--plugin-dir` execute with no prompt, so a plugin
/// carrying them is refused outright — and refusing it must not cost the
/// clean plugins beside it.
#[test]
fn a_claude_plugin_with_a_hooks_directory_is_refused_and_the_others_still_load() {
    let dir = clone_with_both_halves();
    let evil = claude_library_dir(dir.path()).join("evil");
    write(
        &evil.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"evil","description":"hooks"}"#,
    );
    write(
        &evil.join("hooks").join("hooks.json"),
        r#"{"hooks":{"SessionStart":[]}}"#,
    );
    write(
        &evil.join("skills").join("sneaky").join("SKILL.md"),
        "---\nname: sneaky\ndescription: no.\n---\n",
    );

    let library = read_library(dir.path());
    assert_eq!(library.refused.len(), 1);
    assert_eq!(library.refused[0].plugin, "evil");
    assert_eq!(library.refused[0].vendor, Vendor::Claude);
    assert!(library.refused[0].reason.contains("hooks"));

    // Its skills never reach a session, and its directory is never passed.
    assert!(!library.skills.iter().any(|s| s.name == "sneaky"));
    assert_eq!(library.claude_plugin_dirs.len(), 1);
    assert!(library.claude_plugin_dirs[0].ends_with("ply-team"));
}

/// Codex's shape for the same hazard is a `hooks.json` at the plugin root.
#[test]
fn a_codex_plugin_with_a_root_hooks_file_is_refused() {
    let dir = clone_with_both_halves();
    write(
        &codex_library_dir(dir.path())
            .join("plugins")
            .join("ply-team")
            .join("hooks.json"),
        r#"{"hooks":{}}"#,
    );

    let library = read_library(dir.path());
    assert_eq!(library.refused.len(), 1);
    assert_eq!(library.refused[0].vendor, Vendor::Codex);
    // Refused for Codex, so the marketplace has nothing left to install.
    assert!(library.codex.is_none());
    // The Claude half is untouched, and its badge says so.
    assert_eq!(library.claude_plugin_dirs.len(), 1);
    assert!(library.skills.iter().all(|s| s.claude && !s.codex));
}

/// A manifest may declare hooks inline rather than in a file.
#[test]
fn hooks_declared_in_the_manifest_are_refused_too() {
    let dir = TempDir::new().unwrap();
    let plugin = claude_library_dir(dir.path()).join("inline");
    write(
        &plugin.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"inline","hooks":{"PreToolUse":[]}}"#,
    );

    let library = read_library(dir.path());
    assert_eq!(library.refused.len(), 1);
    assert!(library.refused[0].reason.contains("hooks"));
    assert!(library.claude_plugin_dirs.is_empty());
}

/// A `hooks` key that is present but null is not a hook.
#[test]
fn a_null_hooks_key_is_not_a_refusal() {
    let dir = TempDir::new().unwrap();
    let plugin = claude_library_dir(dir.path()).join("clean");
    write(
        &plugin.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"clean","hooks":null}"#,
    );

    let library = read_library(dir.path());
    assert!(library.refused.is_empty());
    assert_eq!(library.claude_plugin_dirs.len(), 1);
}

/// **Every name in the Codex half becomes a path component.** They come out
/// of JSON any teammate with write access can edit, and `Path::join` with an
/// absolute component throws away the path it was joining onto — so a version
/// of `/etc` would redirect the copy there. Refused, like a hook.
#[test]
fn a_plugin_whose_version_escapes_its_directory_is_refused() {
    for escape in ["/tmp/ply-owned", "..", "../../elsewhere", ""] {
        let dir = clone_with_both_halves();
        write(
            &codex_library_dir(dir.path())
                .join("plugins")
                .join("ply-team")
                .join(".codex-plugin")
                .join("plugin.json"),
            &format!(r#"{{"name":"ply-team","version":"{escape}"}}"#),
        );

        let library = read_library(dir.path());
        // An empty version falls back to the stand-in, which is safe.
        if escape.is_empty() {
            assert!(library.codex.is_some(), "empty version uses the stand-in");
            continue;
        }
        assert!(
            library.codex.is_none(),
            "version {escape:?} must not reach the overlay"
        );
        assert!(
            library.refused.iter().any(|p| p.reason.contains("version")),
            "version {escape:?}: {:?}",
            library.refused
        );
        // And the refusal must reach the badge. A skill still marked Codex
        // here would be counted as loaded by both vendors while the Codex
        // half loads nothing at all.
        assert!(
            library.skills.iter().all(|s| !s.codex),
            "version {escape:?}: a refused plugin's skills kept their badge: {:?}",
            library.skills
        );
        assert_eq!(library.loaded_for(Vendor::Codex), 0, "version {escape:?}");
    }
}

#[test]
fn a_plugin_whose_name_escapes_its_directory_is_refused() {
    for escape in ["../evil", "/tmp/evil", "..", "."] {
        let dir = clone_with_both_halves();
        write(
            &codex_marketplace_manifest(&codex_library_dir(dir.path())),
            &format!(r#"{{"name":"ply-team","plugins":[{{"name":"{escape}"}}]}}"#),
        );

        let library = read_library(dir.path());
        assert!(
            library.codex.is_none(),
            "plugin name {escape:?} must not reach the overlay"
        );
        assert!(
            library.refused.iter().any(|p| p.vendor == Vendor::Codex),
            "plugin name {escape:?}: {:?}",
            library.refused
        );
    }
}

/// The marketplace name is a directory in the overlay's cache, so an
/// unusable one costs the whole Codex half rather than one plugin.
#[test]
fn a_marketplace_whose_name_escapes_is_refused_wholesale() {
    for escape in ["../evil", "/tmp/evil", "", "."] {
        let dir = clone_with_both_halves();
        write(
            &codex_marketplace_manifest(&codex_library_dir(dir.path())),
            &format!(
                r#"{{"name":"{escape}","plugins":[{{"name":"ply-team"}}]}}"#
            ),
        );

        let library = read_library(dir.path());
        assert!(
            library.codex.is_none(),
            "marketplace name {escape:?} must not reach the overlay"
        );
        assert!(
            library.errors.iter().any(|e| e.contains("marketplace name")),
            "marketplace name {escape:?}: {:?}",
            library.errors
        );
        // And the Claude half is untouched by the Codex half's problem.
        assert_eq!(library.claude_plugin_dirs.len(), 1);
    }
}

/// **A refusal must reach the badge, whatever the reason.** Every check now
/// runs before a single skill is badged; this is the invariant that says so,
/// stated once for the whole class rather than per-reason.
#[test]
fn no_refused_plugin_ever_leaves_a_badge_behind() {
    // Each of these refuses the Codex plugin for a different reason.
    let breakages: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
        (
            "hooks",
            Box::new(|root: &Path| {
                write(
                    &codex_library_dir(root)
                        .join("plugins")
                        .join("ply-team")
                        .join("hooks.json"),
                    "{}",
                )
            }),
        ),
        (
            "an unusable version",
            Box::new(|root: &Path| {
                write(
                    &codex_library_dir(root)
                        .join("plugins")
                        .join("ply-team")
                        .join(".codex-plugin")
                        .join("plugin.json"),
                    r#"{"name":"ply-team","version":"../.."}"#,
                )
            }),
        ),
        (
            "a malformed manifest",
            Box::new(|root: &Path| {
                write(
                    &codex_library_dir(root)
                        .join("plugins")
                        .join("ply-team")
                        .join(".codex-plugin")
                        .join("plugin.json"),
                    "{ not json",
                )
            }),
        ),
    ];

    for (label, break_it) in breakages {
        let dir = clone_with_both_halves();
        break_it(dir.path());
        let library = read_library(dir.path());

        assert!(!library.refused.is_empty(), "{label}: expected a refusal");
        assert!(library.codex.is_none(), "{label}: nothing may install");
        assert_eq!(library.loaded_for(Vendor::Codex), 0, "{label}");
        assert!(
            library.skills.iter().all(|s| !s.codex && !s.both_vendors()),
            "{label}: {:?}",
            library.skills
        );
        // The Claude half is untouched by the Codex half's problem.
        assert_eq!(library.loaded_for(Vendor::Claude), 1, "{label}");
    }
}

/// Both vendors require a manifest, so one Ply cannot parse is one the CLI
/// will reject too. Swallowing the parse error meant "declares no hooks", a
/// fallback name and a stand-in version — a plugin advertised as loadable
/// that the CLI would refuse.
#[test]
fn a_plugin_with_a_malformed_manifest_is_refused_not_guessed_at() {
    for broken in ["{ not json", "[]", "\"a string\"", ""] {
        let dir = clone_with_both_halves();
        write(
            &claude_library_dir(dir.path())
                .join("ply-team")
                .join(".claude-plugin")
                .join("plugin.json"),
            broken,
        );

        let library = read_library(dir.path());
        assert!(
            library
                .refused
                .iter()
                .any(|p| p.vendor == Vendor::Claude && p.reason.contains("manifest")),
            "{broken:?}: {:?}",
            library.refused
        );
        // Its directory is never handed to `--plugin-dir`, and its skills
        // never counted.
        assert!(library.claude_plugin_dirs.is_empty(), "{broken:?}");
        assert_eq!(library.loaded_for(Vendor::Claude), 0, "{broken:?}");
        assert!(
            library.skills.iter().all(|s| !s.claude),
            "{broken:?}: {:?}",
            library.skills
        );
    }
}

/// **Both CLIs require a string `name` in the manifest** — measured:
/// `claude plugin validate` fails a manifest that omits it and one that gives
/// it a number. Ply used to substitute the directory name, which advertised a
/// plugin the CLI would reject.
#[test]
fn a_manifest_without_a_usable_name_is_refused() {
    for manifest in [
        r#"{"description":"no name here"}"#,
        r#"{"name":42}"#,
        r#"{"name":""}"#,
        r#"{"name":"   "}"#,
        r#"{"name":null}"#,
    ] {
        let dir = TempDir::new().unwrap();
        let plugin = claude_library_dir(dir.path()).join("ply-team");
        write(&plugin.join(".claude-plugin").join("plugin.json"), manifest);
        write(
            &plugin.join("skills").join("a-skill").join("SKILL.md"),
            "---\nname: a-skill\ndescription: Something.\n---\n",
        );

        let library = read_library(dir.path());
        assert!(
            library
                .refused
                .iter()
                .any(|p| p.reason.contains("`name`")),
            "{manifest}: {:?}",
            library.refused
        );
        assert!(library.claude_plugin_dirs.is_empty(), "{manifest}");
        assert!(library.skills.is_empty(), "{manifest}");
    }
}

/// **An MCP server is a command line.** The official `terraform` plugin's is
/// `docker run …`; a plugin whose `.mcp.json` ran `/bin/sh -c` wrote its
/// sentinel during an ordinary `claude -p`, with nothing asked. Same hazard
/// as a hook, so the same answer.
#[test]
fn a_plugin_carrying_an_mcp_server_is_refused() {
    // Every shape: the file beside the manifest, and either manifest key.
    let shapes: [(&str, &str, &str); 3] = [
        (".mcp.json file", r#"{"name":"ply-team"}"#, ".mcp.json"),
        ("mcpServers key", r#"{"name":"ply-team","mcpServers":{"x":{"command":"sh"}}}"#, ""),
        ("mcp key", r#"{"name":"ply-team","mcp":{"x":{"command":"sh"}}}"#, ""),
    ];
    for (label, manifest, extra_file) in shapes {
        let dir = clone_with_both_halves();
        let plugin = claude_library_dir(dir.path()).join("ply-team");
        write(&plugin.join(".claude-plugin").join("plugin.json"), manifest);
        if !extra_file.is_empty() {
            write(
                &plugin.join(extra_file),
                r#"{"probe":{"command":"/bin/sh","args":["-c","echo ran"]}}"#,
            );
        }

        let library = read_library(dir.path());
        assert!(
            library
                .refused
                .iter()
                .any(|p| p.vendor == Vendor::Claude && p.reason.contains("MCP")),
            "{label}: {:?}",
            library.refused
        );
        // Never handed to `--plugin-dir`, and its skills never badged.
        assert!(library.claude_plugin_dirs.is_empty(), "{label}");
        assert_eq!(library.loaded_for(Vendor::Claude), 0, "{label}");
    }
}

/// Codex plugins carry MCP the same way, and are refused the same way.
#[test]
fn a_codex_plugin_carrying_an_mcp_server_is_refused() {
    let dir = clone_with_both_halves();
    write(
        &codex_library_dir(dir.path())
            .join("plugins")
            .join("ply-team")
            .join(".mcp.json"),
        r#"{"mcpServers":{"x":{"command":"sh"}}}"#,
    );

    let library = read_library(dir.path());
    assert!(
        library
            .refused
            .iter()
            .any(|p| p.vendor == Vendor::Codex && p.reason.contains("MCP")),
        "{:?}",
        library.refused
    );
    assert!(library.codex.is_none());
    assert_eq!(library.loaded_for(Vendor::Codex), 0);
}

/// **Two different skills that share a name are two skills.** Both CLIs name
/// a skill `<plugin>:<name>`, so `a:review` and `b:review` are unrelated.
/// Merging them on the bare name produced one row wearing both badges, and
/// the doctor counted it as loaded by both vendors — a claim that a Codex
/// session loads Claude's `a:review`, which it has never seen.
#[test]
fn same_named_skills_in_different_plugins_stay_separate() {
    let dir = TempDir::new().unwrap();

    let claude = claude_library_dir(dir.path()).join("a");
    write(
        &claude.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"a"}"#,
    );
    write(
        &claude.join("skills").join("review").join("SKILL.md"),
        "---\nname: review\ndescription: Claude's review.\n---\n",
    );

    let codex = codex_library_dir(dir.path());
    write(
        &codex_marketplace_manifest(&codex),
        r#"{"name":"team","plugins":[{"name":"b"}]}"#,
    );
    let codex_plugin = codex.join("plugins").join("b");
    write(
        &codex_plugin.join(".codex-plugin").join("plugin.json"),
        r#"{"name":"b","version":"1.0.0"}"#,
    );
    write(
        &codex_plugin.join("skills").join("review").join("SKILL.md"),
        "---\nname: review\ndescription: Codex's review.\n---\n",
    );

    let library = read_library(dir.path());
    assert_eq!(library.skills.len(), 2, "{:?}", library.skills);

    let a = library.skills.iter().find(|s| s.plugin == "a").unwrap();
    let b = library.skills.iter().find(|s| s.plugin == "b").unwrap();
    assert!(a.claude && !a.codex);
    assert!(b.codex && !b.claude);
    // Neither may claim both vendors, so neither counts as loaded.
    assert!(!a.both_vendors() && !b.both_vendors());
    assert_eq!(a.qualified_name(), "a:review");
    assert_eq!(b.qualified_name(), "b:review");
    // Each description stays with its own skill.
    assert_eq!(a.description, "Claude's review.");
    assert_eq!(b.description, "Codex's review.");
}

/// The intended layout still merges: one skill promoted into both halves
/// under the same plugin name is one row with two badges.
#[test]
fn the_same_plugin_in_both_halves_is_still_one_row() {
    let library = read_library(clone_with_both_halves().path());
    assert_eq!(library.skills.len(), 1);
    assert_eq!(library.skills[0].qualified_name(), "ply-team:team-conventions");
    assert!(library.skills[0].both_vendors());
}

/// The team layer is additive, so a broken half is skipped, not fatal — the
/// same rule the Team Knowledge layer follows (rung 2).
#[test]
fn a_malformed_codex_marketplace_is_reported_and_the_claude_half_still_loads() {
    let dir = clone_with_both_halves();
    write(
        &codex_marketplace_manifest(&codex_library_dir(dir.path())),
        "{ not json",
    );

    let library = read_library(dir.path());
    assert!(library.codex.is_none());
    assert_eq!(library.claude_plugin_dirs.len(), 1);
    assert!(
        library.errors.iter().any(|e| e.contains("valid JSON")),
        "{:?}",
        library.errors
    );
    assert_eq!(library.loaded_for(Vendor::Claude), 1);
}

/// A marketplace entry pointing at a plugin that is not there is named, not
/// silently dropped: someone shared half a skill.
#[test]
fn a_marketplace_entry_without_a_plugin_is_reported() {
    let dir = clone_with_both_halves();
    std::fs::remove_dir_all(
        codex_library_dir(dir.path())
            .join("plugins")
            .join("ply-team")
            .join(".codex-plugin"),
    )
    .unwrap();

    let library = read_library(dir.path());
    assert!(library.codex.is_none());
    assert!(
        library
            .errors
            .iter()
            .any(|e| e.contains("ply-team") && e.contains("plugin.json")),
        "{:?}",
        library.errors
    );
}

/// The state of every team between `team-init.sh` and its first shared
/// skill: the library directories exist, holding only the `.gitkeep` that
/// makes git keep them. That is not a fault and must not read as one.
#[test]
fn a_freshly_initialised_library_is_silent() {
    let dir = TempDir::new().unwrap();
    for half in [
        claude_library_dir(dir.path()),
        codex_library_dir(dir.path()),
    ] {
        std::fs::create_dir_all(&half).unwrap();
        std::fs::write(half.join(".gitkeep"), "").unwrap();
    }

    let library = read_library(dir.path());
    assert!(library.is_empty());
    assert!(library.skills.is_empty());
    assert!(library.refused.is_empty());
    assert!(
        library.errors.is_empty(),
        "an unshared library must not report an error: {:?}",
        library.errors
    );
}

/// A `library/codex/` that exists and cannot be read *is* worth reporting —
/// the silence above is only for "nothing shared yet".
#[test]
fn an_unreadable_codex_marketplace_is_still_reported() {
    let dir = TempDir::new().unwrap();
    // A marketplace manifest that is a directory: present, unreadable.
    std::fs::create_dir_all(codex_marketplace_manifest(&codex_library_dir(dir.path()))).unwrap();

    let library = read_library(dir.path());
    assert!(
        library.errors.iter().any(|e| e.contains("unreadable")),
        "{:?}",
        library.errors
    );
}

/// No team library at all is the common case on a Mac that is on no team.
#[test]
fn an_absent_library_is_empty_and_silent() {
    let dir = TempDir::new().unwrap();
    let library = read_library(dir.path());
    assert!(library.is_empty());
    assert!(library.skills.is_empty());
    assert!(library.refused.is_empty());
    assert!(library.errors.is_empty());
}

/// **A skill needs a description, and that is all it needs.** Measured
/// against both CLIs: `description` alone loads (under the directory's name),
/// `name` alone does not, and no frontmatter does not. Ply used to count the
/// last two, which claimed a skill reached a session that never saw it.
#[test]
fn only_a_skill_with_a_description_counts() {
    let dir = TempDir::new().unwrap();
    let plugin = claude_library_dir(dir.path()).join("ply-team");
    write(
        &plugin.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"ply-team"}"#,
    );
    write(
        &plugin.join("skills").join("undeclared").join("SKILL.md"),
        "# no frontmatter here\n",
    );
    write(
        &plugin.join("skills").join("nameonly").join("SKILL.md"),
        "---\nname: nameonly\n---\n",
    );
    write(
        &plugin.join("skills").join("desconly").join("SKILL.md"),
        "---\ndescription: Loads, named for its directory.\n---\n",
    );

    let library = read_library(dir.path());
    assert_eq!(library.skills.len(), 1, "{:?}", library.skills);
    assert_eq!(library.skills[0].name, "desconly");
    assert_eq!(
        library.skills[0].description,
        "Loads, named for its directory."
    );

    // Both skipped skills are named, each with its own reason: a missing
    // description and a missing frontmatter block are different one-line
    // fixes, and the member is told which.
    assert!(
        library
            .errors
            .iter()
            .any(|e| e.contains("nameonly") && e.contains("no description")),
        "{:?}",
        library.errors
    );
    assert!(
        library
            .errors
            .iter()
            .any(|e| e.contains("undeclared") && e.contains("no frontmatter block")),
        "{:?}",
        library.errors
    );
    // The plugin itself is fine — one unusable skill costs only that skill.
    assert_eq!(library.claude_plugin_dirs.len(), 1);
}

/// The frontmatter rule, in the shapes measured against both CLIs. The two
/// refusals are the only two the CLIs refuse; the rest load, and Ply must not
/// be stricter than the vendor or it hides a working skill.
#[test]
fn frontmatter_matches_what_the_clis_accept() {
    let ok = |text: &str| parse_skill_frontmatter(text).expect("should parse");

    // Quotes are stripped; a value may contain the delimiter character.
    let parsed = ok("---\nname: \"quoted-name\"\ndescription: 'A, description: with colons'\n---\ndescription: not this\n");
    assert_eq!(parsed.name.as_deref(), Some("quoted-name"));
    assert_eq!(parsed.description.as_deref(), Some("A, description: with colons"));

    // A tab-indented key is found: the CLIs read one.
    assert_eq!(
        ok("---\n\tdescription: leading tab\n---\n").description.as_deref(),
        Some("leading tab")
    );

    // `[unterminated` is not valid YAML, but both CLIs load it, so Ply keeps
    // it rather than being stricter than the vendors.
    assert_eq!(
        ok("---\ndescription: [unterminated\n---\n").description.as_deref(),
        Some("[unterminated")
    );

    // The two the CLIs refuse.
    let unclosed = parse_skill_frontmatter("---\ndescription: No closing delimiter.\n")
        .expect_err("a block that never closes is not frontmatter");
    assert!(unclosed.contains("never closed"), "{unclosed}");

    let quote = parse_skill_frontmatter("---\ndescription: \"unclosed quote\n---\nBody.\n")
        .expect_err("an unterminated quoted scalar is refused by the CLI");
    assert!(quote.contains("never closed"), "{quote}");

    // A body that never opens frontmatter is not frontmatter.
    let none = parse_skill_frontmatter("name: nope\n").expect_err("no block");
    assert!(none.contains("no frontmatter"), "{none}");
}

/// Found on LYRA: every one of its skills writes the description as a block
/// scalar, and Ply showed the indicator (`>-`) in its place.
#[test]
fn block_scalar_descriptions_take_their_indented_lines() {
    let description = |text: &str| {
        parse_skill_frontmatter(text).expect("should parse").description.expect("a description")
    };
    let block = |indicator: &str| {
        description(&format!(
            "---\nname: deploy\ndescription: {indicator}\n  Full deploy pipeline.\n  Pushes to staging.\n\n---\nBody.\n"
        ))
    };
    // The six indicators: folding joins with a space, literal keeps newlines,
    // and the chomping indicator decides the trailing newlines.
    assert_eq!(block(">"), "Full deploy pipeline. Pushes to staging.\n");
    assert_eq!(block(">-"), "Full deploy pipeline. Pushes to staging.");
    assert_eq!(block(">+"), "Full deploy pipeline. Pushes to staging.\n\n");
    assert_eq!(block("|"), "Full deploy pipeline.\nPushes to staging.\n");
    assert_eq!(block("|-"), "Full deploy pipeline.\nPushes to staging.");
    assert_eq!(block("|+"), "Full deploy pipeline.\nPushes to staging.\n\n");

    // A blank line inside a folded block is a paragraph break.
    assert_eq!(
        description("---\ndescription: >-\n  First paragraph\n  continues.\n\n  Second.\n---\n"),
        "First paragraph continues.\nSecond."
    );
    // Literal keeps every newline, blank lines and deeper indentation included.
    assert_eq!(
        description("---\ndescription: |\n  one\n\n  two\n    indented\n---\n"),
        "one\n\ntwo\n  indented\n"
    );
    // An indentation digit fixes the content indentation, so leading spaces
    // beyond it are content.
    assert_eq!(
        description("---\ndescription: |2-\n    deeper\n  base\n---\n"),
        "  deeper\nbase"
    );
    assert_eq!(description("---\ndescription: >2\n  folded\n  text\n---\n"), "folded text\n");
    // A comment after the header is not part of it.
    assert_eq!(description("---\ndescription: >- # why\n  commented\n---\n"), "commented");

    // A block followed by another key ends at that key, which still parses.
    let parsed = parse_skill_frontmatter(
        "---\ndescription: >-\n  Folded text\n  here.\nname: after-the-block\n---\n",
    )
    .unwrap();
    assert_eq!(parsed.description.as_deref(), Some("Folded text here."));
    assert_eq!(parsed.name.as_deref(), Some("after-the-block"));

    // `name` takes a block too.
    let parsed = parse_skill_frontmatter("---\nname: |-\n  block-name\ndescription: d\n---\n").unwrap();
    assert_eq!(parsed.name.as_deref(), Some("block-name"));

    // An indented `---` is content of the block, not the closing delimiter,
    // and the keys after the block are still read.
    let parsed = parse_skill_frontmatter(
        "---\ndescription: |-\n  First\n  ---\n  Second\nname: after\n---\n",
    )
    .unwrap();
    assert_eq!(parsed.description.as_deref(), Some("First\n---\nSecond"));
    assert_eq!(parsed.name.as_deref(), Some("after"));
    // A `#` line inside a block is content.
    assert_eq!(description("---\ndescription: |-\n  # heading\n  text\n---\n"), "# heading\ntext");

    // A block that runs to the closing `---` still closes the frontmatter.
    assert_eq!(description("---\ndescription: >-\n  to the end\n---\n"), "to the end");

    // An empty block is no description, as an empty value always was.
    assert!(parse_skill_frontmatter("---\ndescription: >-\n---\n").unwrap().description.is_none());
}

/// YAML's multi-line plain style: indented following lines join with spaces.
#[test]
fn a_plain_description_continued_on_indented_lines_is_joined() {
    let parsed = parse_skill_frontmatter(
        "---\ndescription: Full deploy pipeline for Lyra staging.\n  Checks frontend build freshness,\n  rebuilds if needed.\nname: deploy\n---\n",
    )
    .unwrap();
    assert_eq!(
        parsed.description.as_deref(),
        Some("Full deploy pipeline for Lyra staging. Checks frontend build freshness, rebuilds if needed.")
    );
    assert_eq!(parsed.name.as_deref(), Some("deploy"));

    // An indented key after a plain value is still a key, not a continuation.
    let parsed =
        parse_skill_frontmatter("---\ndescription: plain\n  name: indented-key\n---\n").unwrap();
    assert_eq!(parsed.description.as_deref(), Some("plain"));
    assert_eq!(parsed.name.as_deref(), Some("indented-key"));

    // An indented comment line is not part of a plain value.
    let parsed = parse_skill_frontmatter(
        "---\nname: deploy\n  # deployment helper\ndescription: Deploy\n  # note\n---\n",
    )
    .unwrap();
    assert_eq!(parsed.name.as_deref(), Some("deploy"));
    assert_eq!(parsed.description.as_deref(), Some("Deploy"));

    // A quoted value never continues, and the unclosed quote is still refused.
    let parsed = parse_skill_frontmatter("---\ndescription: \"quoted\"\n  stray\n---\n").unwrap();
    assert_eq!(parsed.description.as_deref(), Some("quoted"));
}

/// A plugin whose manifest is missing is not a plugin — dot directories and
/// stray folders in the library must not become `--plugin-dir` arguments.
#[test]
fn directories_without_a_manifest_are_not_plugins() {
    let dir = TempDir::new().unwrap();
    let library_dir = claude_library_dir(dir.path());
    std::fs::create_dir_all(library_dir.join("notes")).unwrap();
    std::fs::create_dir_all(library_dir.join(".git")).unwrap();

    let library = read_library(dir.path());
    assert!(library.claude_plugin_dirs.is_empty());
    assert!(library.refused.is_empty());
}


/// v1.117.0: a Claude plugin's manifest name became a path component when
/// Install started reading a skill out of `library/claude/<plugin>/skills/`.
/// The Codex half has refused unusable names since rung 3; this is the same
/// refusal on the other door, and it comes out of JSON any teammate with
/// write access can edit.
#[test]
fn a_claude_plugin_whose_manifest_name_escapes_its_directory_is_refused() {
    let dir = TempDir::new().unwrap();
    let plugin = claude_library_dir(dir.path()).join("innocent");
    write(
        &plugin.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"../../../etc","version":"1.0.0"}"#,
    );
    write(&plugin.join("skills").join("team-conventions").join("SKILL.md"), SKILL);

    let library = read_library(dir.path());
    assert!(library.claude_plugin_dirs.is_empty(), "{:?}", library.claude_plugin_dirs);
    assert!(library.skills.is_empty(), "{:?}", library.skills);
    let refused = library
        .refused
        .iter()
        .find(|p| p.vendor == Vendor::Claude)
        .expect("a refusal");
    assert_eq!(refused.plugin, "innocent");
    assert!(refused.reason.contains("not a usable directory name"), "{}", refused.reason);
}

/// GH #156 review 1: a **team** marketplace named for one of Ply's own layers
/// (`ply-app`, `ply-project`) would collide with that layer inside the one
/// `CODEX_HOME` overlay — the Library lit its chip, and the launch refused one of
/// them with a false "you already have one". It is refused where it is read,
/// every plugin with the reason; the Claude half still loads.
#[test]
fn a_team_marketplace_named_for_a_ply_layer_is_refused() {
    for reserved in RESERVED_MARKETPLACES {
        let dir = clone_with_both_halves();
        let manifest = codex_marketplace_manifest(&codex_library_dir(dir.path()));
        let text = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, text.replacen("\"name\":\"ply-team\"", &format!("\"name\":\"{reserved}\""), 1))
            .unwrap();

        let library = read_library(dir.path());
        assert!(library.codex.is_none(), "{reserved}: no Codex half for the overlay");
        assert_eq!(library.refused.len(), 1, "{reserved}: {:?}", library.refused);
        let refused = &library.refused[0];
        assert_eq!(refused.plugin, "ply-team");
        assert_eq!(refused.vendor, Vendor::Codex);
        assert!(refused.reason.contains(reserved), "{}", refused.reason);
        // No Codex badge for a skill no Codex session will get; Claude's stays.
        assert_eq!(library.skills.len(), 1);
        assert!(library.skills[0].claude && !library.skills[0].codex);

        // Ply's own reader for that layer still accepts its own name.
        let own = read_own_library(dir.path(), reserved);
        assert_eq!(own.codex.as_ref().map(|m| m.name.as_str()), Some(reserved));
    }
    // `ply-team` is the name Ply gives every team's marketplace: never reserved.
    assert!(!RESERVED_MARKETPLACES.contains(&PLY_PLUGIN));
    assert!(read_library(clone_with_both_halves().path()).codex.is_some());
}

/// GH #216 review 2: a double-quoted description is read with its escapes, so
/// what `New skill…` wrote (always quoted, escaped) shows as it was typed —
/// and agrees with a real YAML reader.
#[test]
fn quoted_scalars_are_read_with_their_escapes() {
    for typed in [
        "Use when deploying.", r#"back\slash and "quotes""#, "x\t# y", "x:\ty", "null",
        "line\u{2028}sep", "next\u{85}line", "bell\u{7}", "café …",
    ] {
        let text = crate::project_skills::new_skill_text("deploy", typed);
        let line = text.lines().find(|l| l.starts_with("description: ")).unwrap();
        let raw = line.trim_start_matches("description: ");
        assert_eq!(scalar(raw).unwrap(), typed, "{raw}");
        let yaml: String = serde_yaml_ng::from_str(raw).unwrap();
        assert_eq!(yaml, typed);
    }
    assert_eq!(scalar(r#""\x41\u00e9\U0001F600\N\_""#).unwrap(), "Aé😀\u{85}\u{a0}");
    assert_eq!(scalar("'it''s'").unwrap(), "it's");
    assert_eq!(scalar(r#""unknown \q kept""#).unwrap(), r"unknown \q kept");
    assert!(scalar(r#""never closed \""#).is_err());
    assert!(scalar("'never closed").is_err());
}

/// Skills hub H6b walk (R15): the team's Claude plugin gains hooks. Settings
/// said so, but the Library rows quietly lost Claude, a Claude-only skill
/// vanished and the Inbox was silent. The refusal now names its skills, each
/// row says why Claude doesn't get it, and the Inbox asks the owner once.
#[test]
fn a_refused_plugin_is_said_on_its_skills_rows_and_once_in_the_inbox() {
    let dir = clone_with_both_halves();
    let claude = claude_library_dir(dir.path()).join("ply-team");
    write(
        &claude.join("skills").join("mine").join("SKILL.md"),
        "---\nname: mine\ndescription: Claude only.\n---\n",
    );
    write(&claude.join("hooks").join("hooks.json"), r#"{"hooks":{}}"#);
    let library = read_library(dir.path());
    assert_eq!(library.refused.len(), 1, "{:?}", library.refused);
    assert_eq!(library.refused[0].skills, ["mine", "team-conventions"]);

    let cwd = TempDir::new().unwrap();
    let rows = crate::project_skills::team_skill_rows(dir.path(), &library, cwd.path());
    let row = |name: &str| rows.iter().find(|r| r.skill.name == name).unwrap_or_else(|| panic!("{name} listed"));
    let both = row("team-conventions");
    assert!(both.skill.codex && !both.skill.claude);
    assert_eq!(both.refused.len(), 1);
    assert_eq!(both.refused[0].vendor, Vendor::Claude);
    assert!(both.refused[0].reason.contains("hooks"));
    // Its halves: only the one the library lists for it.
    assert_eq!(both.halves.len(), 1);
    assert!(both.halves[0].contains("codex"), "{:?}", both.halves);
    let mine = row("mine");
    assert!(!mine.skill.claude && !mine.skill.codex, "held only by the refused plugin");
    assert_eq!(mine.refused.len(), 1);
    assert!(mine.halves.is_empty());

    let snapshot: crate::workspace::WorkspacesFile = serde_json::from_value(serde_json::json!({
        "workspaces": [{"id": "w1", "name": "first", "cwd": "/x", "createdAt": 0, "lastOpenedAt": 0}],
        "activeWorkspaceId": "w1"
    }))
    .unwrap();
    let events = crate::inbox::derive_team_plugin_refused_events(dir.path(), &snapshot);
    assert_eq!(events.len(), 1, "one row per refused plugin");
    let event = &events[0];
    assert_eq!(event.kind, crate::inbox::InboxEventKind::TeamPluginRefused);
    assert_eq!(event.title, "Claude doesn't get the team's ply-team skills");
    let detail = event.detail.as_deref().unwrap();
    assert!(detail.contains("Ask the team owner to remove the hooks"), "{detail}");
    assert!(detail.contains(crate::platform::THIS_MACHINE), "{detail}");
    assert!(event.id.starts_with("team-plugin:ply-team:refused:"), "{}", event.id);
    // The hooks go: the row goes too.
    std::fs::remove_dir_all(claude.join("hooks")).unwrap();
    assert!(crate::inbox::derive_team_plugin_refused_events(dir.path(), &snapshot).is_empty());
}
