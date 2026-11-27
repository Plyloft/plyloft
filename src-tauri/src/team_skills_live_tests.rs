//! v1.116.0 (team sharing rung 3) — the acceptance proof, against the real CLIs.
//!
//! This rung's condition was that **both** vendors load the same team skills.
//! Everything else in the suite tests Ply's own logic against fixtures; these
//! cases test the thing that logic exists for: that a real `claude` and a real
//! `codex`, launched the way Ply launches them, actually see the skill.
//!
//! `#[ignore]` because they shell out to two CLIs that must be installed and
//! signed in — the sandboxed gate has neither. Run them on a developer Mac:
//!
//! ```sh
//! cargo test --lib live_tests -- --ignored --nocapture
//! ```
//!
//! The Codex case spends no model turn at all: `codex debug prompt-input`
//! renders the exact model-visible prompt offline, which is the strongest
//! cheap evidence that a skill reached the session, and `claude plugin
//! validate` likewise answers offline. Only the Claude session check costs a
//! turn, because Claude has no equivalent prompt dump.

use crate::codex_home;
use crate::team_skills::{read_library, Vendor};
use std::path::Path;
use tempfile::TempDir;

const SKILL: &str = "---\nname: team-shipping\ndescription: Use when asked how this team ships a change.\n---\n\nEvery change ships through a Plyloft card.\n";

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// The team library shape rung 4 will publish into, built by hand here.
fn team_clone() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    let claude = crate::team_skills::claude_library_dir(root).join("ply-team");
    write(
        &claude.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"ply-team","description":"Skills shared by the team through Plyloft.","version":"1.0.0"}"#,
    );
    write(&claude.join("skills").join("team-shipping").join("SKILL.md"), SKILL);

    let codex = crate::team_skills::codex_library_dir(root);
    write(
        &crate::team_skills::codex_marketplace_manifest(&codex),
        r#"{"name":"ply-team","interface":{"displayName":"Plyloft team library"},
            "plugins":[{"name":"ply-team","source":{"source":"local","path":"./plugins/ply-team"},
            "policy":{"installation":"AVAILABLE"}}]}"#,
    );
    let codex_plugin = codex.join("plugins").join("ply-team");
    write(
        &codex_plugin.join(".codex-plugin").join("plugin.json"),
        r#"{"name":"ply-team","version":"1.0.0","description":"Skills shared by the team through Plyloft."}"#,
    );
    write(
        &codex_plugin.join("skills").join("team-shipping").join("SKILL.md"),
        SKILL,
    );
    dir
}

fn cli(name: &str) -> String {
    let path = which(name).unwrap_or_else(|| panic!("{name} must be installed for this test"));
    path
}

fn which(name: &str) -> Option<String> {
    let out = crate::platform::new_command("/usr/bin/which").arg(name).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Claude: the plugin directories Ply passes must validate as plugins, and
/// the skill must be visible to a real session started with them.
#[test]
#[ignore = "drives the installed claude CLI"]
fn claude_loads_the_team_skill_from_the_plugin_dirs_ply_passes() {
    let clone = team_clone();
    let library = read_library(clone.path());
    assert_eq!(library.loaded_for(Vendor::Claude), 1);
    assert_eq!(library.claude_plugin_dirs.len(), 1);

    let claude = cli("claude");
    for dir in &library.claude_plugin_dirs {
        let out = crate::platform::new_command(&claude)
            .args(["plugin", "validate"])
            .arg(dir)
            .arg("--json")
            .output()
            .expect("run claude plugin validate");
        assert!(
            out.status.success(),
            "claude rejected {}: {}",
            dir.display(),
            String::from_utf8_lossy(&out.stdout)
        );
    }

    // And a real session started the way Ply starts one sees it.
    let mut command = crate::platform::new_command(&claude);
    command.arg("-p");
    for dir in &library.claude_plugin_dirs {
        command.arg("--plugin-dir").arg(dir);
    }
    let out = command
        .arg("List every skill available to you whose name starts with \"team-\". Answer with just the names, one per line, or NONE.")
        .output()
        .expect("run claude");
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(
        answer.contains("team-shipping"),
        "claude did not load the team skill: {answer}"
    );
}

/// Codex: the overlay Ply builds must put the skill in the model-visible
/// prompt, and must leave the member's own `~/.codex` byte-for-byte alone.
#[test]
#[ignore = "drives the installed codex CLI"]
fn codex_loads_the_team_skill_through_the_overlay_without_touching_the_real_home() {
    let clone = team_clone();
    let library = read_library(clone.path());
    let marketplace = library.codex.as_ref().expect("a codex marketplace");
    assert_eq!(library.loaded_for(Vendor::Codex), 1);

    let real_home = codex_home::real_codex_home();
    let config = real_home.join("config.toml");
    let before = std::fs::read(&config).ok();

    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = codex_home::build(overlays.path(), recovered.path(), &real_home, marketplace)
        .expect("build the overlay");

    // `debug prompt-input` renders the model-visible prompt with no API call.
    let cwd = TempDir::new().unwrap();
    let out = crate::platform::new_command(cli("codex"))
        .args(["debug", "prompt-input", "hello"])
        .current_dir(cwd.path())
        .env("CODEX_HOME", overlay.path())
        .output()
        .expect("run codex debug prompt-input");
    let prompt = String::from_utf8_lossy(&out.stdout);
    assert!(
        prompt.contains("team-shipping"),
        "codex did not load the team skill. stdout: {prompt}\nstderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The whole point of the overlay.
    assert_eq!(
        std::fs::read(&config).ok(),
        before,
        "the member's own config.toml was modified"
    );
    let team_cache = real_home
        .join("plugins")
        .join("cache")
        .join(&marketplace.name);
    assert!(
        !team_cache.exists(),
        "the team plugin was installed into the member's real Codex home"
    );

    drop(overlay);
    assert_eq!(std::fs::read_dir(overlays.path()).unwrap().count(), 0);
}

/// **Why an MCP server is refused, demonstrated rather than asserted.**
///
/// A plugin's `.mcp.json` declares stdio servers, and a stdio server is a
/// command line — the official `terraform` plugin's is `docker run …`. This
/// runs a plugin whose server is `/bin/sh -c 'echo … > sentinel'` through an
/// ordinary `claude -p` and checks the sentinel: if the file appears, the
/// command ran with nothing asked, which is exactly the hook hazard through a
/// second door. The test then checks Ply refuses such a plugin, so the two
/// halves — the danger and the guard — stay tied together.
#[test]
#[ignore = "drives the installed claude CLI"]
fn an_mcp_server_in_a_plugin_runs_a_command_and_is_therefore_refused() {
    let dir = TempDir::new().unwrap();
    let sentinel = dir.path().join("mcp-executed");
    let plugin = crate::team_skills::claude_library_dir(dir.path()).join("mcp-probe");
    write(
        &plugin.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"mcp-probe","version":"1.0.0"}"#,
    );
    write(
        &plugin.join(".mcp.json"),
        &format!(
            r#"{{"probe":{{"command":"/bin/sh","args":["-c","echo ran > {}; sleep 5"]}}}}"#,
            sentinel.display()
        ),
    );

    // Ply refuses it, and its directory never becomes a `--plugin-dir`.
    let library = read_library(dir.path());
    assert!(
        library
            .refused
            .iter()
            .any(|p| p.plugin == "mcp-probe" && p.reason.contains("MCP")),
        "{:?}",
        library.refused
    );
    assert!(library.claude_plugin_dirs.is_empty());

    // And this is what the refusal prevents: passed to the CLI, it runs.
    let cwd = TempDir::new().unwrap();
    let out = crate::platform::new_command(cli("claude"))
        .arg("-p")
        .arg("--plugin-dir")
        .arg(&plugin)
        .arg("Say OK.")
        .current_dir(cwd.path())
        .output()
        .expect("run claude");
    assert!(
        sentinel.exists(),
        "the MCP command did not run, so this test no longer demonstrates the hazard \
         it guards — re-check the refusal before relaxing it. claude said: {}",
        String::from_utf8_lossy(&out.stdout)
    );
}

/// The frontmatter rule Ply enforces is the CLIs' own: a skill needs a
/// `description`, and nothing else. Four variants of one file, one session.
#[test]
#[ignore = "drives the installed claude CLI"]
fn only_a_skill_with_a_description_is_loaded_by_the_cli() {
    let dir = TempDir::new().unwrap();
    let plugin = crate::team_skills::claude_library_dir(dir.path()).join("shapes");
    write(
        &plugin.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"shapes","version":"1.0.0"}"#,
    );
    for (skill, body) in [
        ("declared", "---\nname: declared\ndescription: Both fields.\n---\n"),
        ("desconly", "---\ndescription: Description only.\n---\n"),
        ("nameonly", "---\nname: nameonly\n---\n"),
        ("undeclared", "# no frontmatter\n"),
    ] {
        write(&plugin.join("skills").join(skill).join("SKILL.md"), body);
    }

    // What Ply lists.
    let library = read_library(dir.path());
    let listed: Vec<&str> = library.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(listed, vec!["declared", "desconly"], "{listed:?}");

    // What the CLI loads, asked the same way.
    let cwd = TempDir::new().unwrap();
    let out = crate::platform::new_command(cli("claude"))
        .arg("-p")
        .arg("--plugin-dir")
        .arg(&plugin)
        .arg("List every skill from the shapes plugin you can see. Just names, one per line.")
        .current_dir(cwd.path())
        .output()
        .expect("run claude");
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(answer.contains("declared"), "{answer}");
    assert!(answer.contains("desconly"), "{answer}");
    assert!(
        !answer.contains("nameonly") && !answer.contains("undeclared"),
        "the CLI loaded a skill Plyloft does not list, so the rule has changed: {answer}"
    );
}

/// **A freshly authenticated member must not lose their first session.**
///
/// The overlay can only link what the real home already has, so a home
/// holding just an `auth.json` — a member who has run `codex login` and
/// nothing else, which is the acceptance journey — has its thread history,
/// state, memories and installation id created *inside* the disposable
/// overlay. Measured: eight such entries, including
/// `thread_history_1.sqlite`. This runs a real Codex turn from such a home
/// and checks they survive the overlay's removal.
#[test]
#[ignore = "drives the installed codex CLI"]
fn a_fresh_home_keeps_the_state_its_first_session_creates() {
    let home = TempDir::new().unwrap();
    let real_auth = codex_home::real_codex_home().join("auth.json");
    if !real_auth.is_file() {
        eprintln!("no Codex sign-in on this Mac — skipping");
        return;
    }
    std::fs::copy(&real_auth, home.path().join("auth.json")).unwrap();
    assert_eq!(
        std::fs::read_dir(home.path()).unwrap().count(),
        1,
        "the point of this case is a home with nothing but auth"
    );

    let clone = team_clone();
    let library = read_library(clone.path());
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = codex_home::build(
        overlays.path(),
        recovered.path(),
        home.path(),
        library.codex.as_ref().expect("a codex marketplace"),
    )
    .expect("build the overlay");

    let cwd = TempDir::new().unwrap();
    let out = crate::platform::new_command(cli("codex"))
        .args([
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "Reply with the single word READY.",
        ])
        .current_dir(cwd.path())
        .env("CODEX_HOME", overlay.path())
        .output()
        .expect("run codex exec");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("READY"),
        "the session did not run, so this proves nothing: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let created: Vec<String> = std::fs::read_dir(overlay.path())
        .unwrap()
        .flatten()
        .filter(|e| !e.file_type().map(|t| t.is_symlink()).unwrap_or(true))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        // Ply's own entries are never handed to the member.
        .filter(|name| !["config.toml", "plugins", ".ply-overlay.json"].contains(&name.as_str()))
        .collect();
    assert!(
        created.iter().any(|name| name.contains("thread_history")),
        "the session created no thread history in the overlay, so this case no \
         longer exercises what it guards: {created:?}"
    );

    drop(overlay);

    // Everything the session made is now the member's, in their own home.
    for name in &created {
        assert!(
            home.path().join(name).exists(),
            "the overlay took {name} with it; the member lost their first session"
        );
    }
    assert_eq!(std::fs::read_dir(overlays.path()).unwrap().count(), 0);
}

/// The rung's own acceptance sentence: the same authored skill reaches both.
#[test]
#[ignore = "drives both installed CLIs"]
fn the_same_skill_is_loaded_by_both_vendors() {
    let clone = team_clone();
    let library = read_library(clone.path());
    let shipping = library
        .skills
        .iter()
        .find(|s| s.name == "team-shipping")
        .expect("the skill is listed");
    assert!(
        shipping.both_vendors(),
        "rung 3 ships only when both vendors load the same skills"
    );
}

/// The team clone that actually exists on this Mac, whatever state it is in.
/// Guards the state every team is in before its first skill is shared: the
/// library directories exist with only a `.gitkeep`, and that must produce
/// no error for a member to see.
#[test]
#[ignore = "reads this machine's real team clone, if it has one"]
fn this_machines_team_clone_reads_without_errors() {
    let home = std::env::var("HOME").expect("HOME");
    let root = Path::new(&home)
        .join("Library/Application Support/com.mbadv.ply/team");
    let Ok(entries) = std::fs::read_dir(&root) else {
        eprintln!("no team clone on this Mac — nothing to check");
        return;
    };
    for entry in entries.flatten() {
        if !entry.path().join(".git").exists() {
            continue;
        }
        let library = read_library(&entry.path());
        eprintln!(
            "{}: {} skills, {} refused, errors {:?}",
            entry.file_name().to_string_lossy(),
            library.skills.len(),
            library.refused.len(),
            library.errors
        );
        assert!(
            library.errors.is_empty(),
            "a real team clone must read cleanly: {:?}",
            library.errors
        );
    }
}

/// **The member's own installed plugins must survive the overlay.**
///
/// Ply symlinks each marketplace directory of their plugin cache into the
/// overlay, and a team plugin *root* that is itself a symlink is refused by
/// Codex ("resolves outside plugin root") — which raises the fair question of
/// whether their plugins, reached through a symlinked ancestor, are refused
/// too. Measured here rather than argued: they are not. The refusal is about
/// the plugin root itself being a link; a real directory reached through a
/// linked ancestor canonicalizes into their own home and its skills stay
/// contained. This is the regression test for that, because the answer is a
/// property of the CLI and could change under us.
#[test]
#[ignore = "drives the installed codex CLI"]
fn the_members_own_plugins_still_load_through_the_overlay() {
    // A member home with a plugin of their own: a local marketplace, one
    // plugin, one skill. Entirely synthetic, so the case is the same on any
    // machine.
    let home = TempDir::new().unwrap();
    let installed = home
        .path()
        .join("plugins")
        .join("cache")
        .join("their-market")
        .join("their-plugin")
        .join("2.0.0");
    write(
        &installed.join(".codex-plugin").join("plugin.json"),
        r#"{"name":"their-plugin","version":"2.0.0"}"#,
    );
    write(
        &installed.join("skills").join("their-own-skill").join("SKILL.md"),
        "---\nname: their-own-skill\ndescription: A skill the member installed themselves.\n---\n",
    );
    write(
        &home.path().join("config.toml"),
        "[plugins.\"their-plugin@their-market\"]\nenabled = true\n",
    );

    let prompt_input = |codex_home: &Path| {
        let cwd = TempDir::new().unwrap();
        let out = crate::platform::new_command(cli("codex"))
            .args(["debug", "prompt-input", "hello"])
            .current_dir(cwd.path())
            .env("CODEX_HOME", codex_home)
            .output()
            .expect("run codex debug prompt-input");
        String::from_utf8_lossy(&out.stdout).into_owned()
    };

    // Their plugin loads in their own home — otherwise this proves nothing.
    assert!(
        prompt_input(home.path()).contains("their-plugin:their-own-skill"),
        "the fixture's own plugin does not load; the case below would be vacuous"
    );

    let clone = team_clone();
    let library = read_library(clone.path());
    let overlays = TempDir::new().unwrap();
    let recovered = TempDir::new().unwrap();
    let overlay = codex_home::build(
        overlays.path(),
        recovered.path(),
        home.path(),
        library.codex.as_ref().expect("a codex marketplace"),
    )
    .expect("build the overlay");

    let through_overlay = prompt_input(overlay.path());
    assert!(
        through_overlay.contains("their-plugin:their-own-skill"),
        "the overlay cost the member their own plugin: {through_overlay}"
    );
    assert!(
        through_overlay.contains("ply-team:team-shipping"),
        "the team skill did not load: {through_overlay}"
    );
}
