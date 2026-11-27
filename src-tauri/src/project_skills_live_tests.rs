//! v1.117.0 (team sharing rung 4) — the native roots, against the real CLIs.
//!
//! Rung 4 rests on one measurement: **which directory does each CLI read a
//! project skill out of?** Everything else here — two copies per Install, a
//! row that can carry one badge, the doctor's "in a Codex root only" — follows
//! from it. So the measurement is a test, not a note: if a vendor starts
//! reading the other's directory, this is what says so.
//!
//! `#[ignore]` because they shell out to two CLIs that must be installed and
//! signed in — the sandboxed gate has neither. Run them on a developer Mac:
//!
//! ```sh
//! cargo test --lib project_skills::live_tests -- --ignored --nocapture
//! ```
//!
//! The Codex half spends no model turn: `codex debug prompt-input` renders the
//! model-visible prompt offline. Only the Claude half costs a turn, because
//! Claude has no equivalent dump — so both halves of the table are asked in
//! one session each.

use super::*;
use tempfile::TempDir;

fn cli(name: &str) -> String {
    let out = crate::platform::new_command("/usr/bin/which")
        .arg(name)
        .output()
        .unwrap_or_else(|e| panic!("which {name}: {e}"));
    assert!(out.status.success(), "{name} must be installed for this test");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn plant(dir: &Path, name: &str, description: &str) {
    let file = dir.join(name).join("SKILL.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        format!("---\nname: {name}\ndescription: {description}\n---\n\nBody.\n"),
    )
    .unwrap();
}

/// The table in this module's sibling's docs, measured:
///
/// | directory | Claude | Codex |
/// | --- | --- | --- |
/// | `.claude/skills` | loads | no |
/// | `.agents/skills` | no | loads |
///
/// This is why Install writes twice, and why a project skill can reach only
/// half the sessions Ply starts.
#[test]
#[ignore = "drives the installed claude and codex CLIs"]
fn neither_cli_reads_the_other_vendors_project_skill_root() {
    let cwd = TempDir::new().unwrap();
    plant(
        &cwd.path().join(CLAUDE_ROOT),
        "probe-claude-root",
        "Planted in the Claude root.",
    );
    plant(
        &cwd.path().join(CODEX_ROOT),
        "probe-codex-root",
        "Planted in the Codex root.",
    );

    // Ply's own reading of the same repo: one badge each.
    let found = read_project_skills(cwd.path());
    let claude_row = found
        .skills
        .iter()
        .find(|s| s.name == "probe-claude-root")
        .expect("the Claude-root skill");
    assert!(claude_row.claude && !claude_row.codex);
    let codex_row = found
        .skills
        .iter()
        .find(|s| s.name == "probe-codex-root")
        .expect("the Codex-root skill");
    assert!(codex_row.codex && !codex_row.claude);
    assert_eq!(found.loaded(), 0);

    // Codex, offline: the prompt it would send the model.
    let out = crate::platform::new_command(cli("codex"))
        .args(["debug", "prompt-input", "hello"])
        .current_dir(cwd.path())
        .output()
        .expect("run codex debug prompt-input");
    let prompt = String::from_utf8_lossy(&out.stdout);
    assert!(
        prompt.contains("probe-codex-root"),
        "codex did not load {CODEX_ROOT}: {prompt}"
    );
    assert!(
        !prompt.contains("probe-claude-root"),
        "codex now reads {CLAUDE_ROOT} too, so Install need not write twice: {prompt}"
    );

    // Claude, one session.
    let out = crate::platform::new_command(cli("claude"))
        .arg("-p")
        .arg("List every skill available to you whose name starts with \"probe-\". Answer with just the names, one per line, or NONE.")
        .current_dir(cwd.path())
        .output()
        .expect("run claude");
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(
        answer.contains("probe-claude-root"),
        "claude did not load {CLAUDE_ROOT}: {answer}"
    );
    assert!(
        !answer.contains("probe-codex-root"),
        "claude now reads {CODEX_ROOT} too, so Install need not write twice: {answer}"
    );
}

/// And the consequence: what Install writes is loaded by **both**, which is
/// the rung's whole claim about an installed team skill.
#[test]
#[ignore = "drives the installed claude and codex CLIs"]
fn both_clis_load_a_skill_install_wrote() {
    let source = TempDir::new().unwrap();
    std::fs::write(
        source.path().join("SKILL.md"),
        "---\nname: probe-installed\ndescription: Installed by Plyloft from the team library.\n---\n\nBody.\n",
    )
    .unwrap();
    let cwd = TempDir::new().unwrap();
    install_into_repo(cwd.path(), "probe-installed", source.path(), false).expect("install");
    assert_eq!(read_project_skills(cwd.path()).loaded(), 1);

    let out = crate::platform::new_command(cli("codex"))
        .args(["debug", "prompt-input", "hello"])
        .current_dir(cwd.path())
        .output()
        .expect("run codex debug prompt-input");
    let prompt = String::from_utf8_lossy(&out.stdout);
    assert!(
        prompt.contains("probe-installed"),
        "codex did not load the installed skill: {prompt}"
    );

    let out = crate::platform::new_command(cli("claude"))
        .arg("-p")
        .arg("List every skill available to you whose name starts with \"probe-\". Answer with just the names, one per line, or NONE.")
        .current_dir(cwd.path())
        .output()
        .expect("run claude");
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(
        answer.contains("probe-installed"),
        "claude did not load the installed skill: {answer}"
    );
}

/// A skill's two names, measured. Claude invokes it by its **directory** and
/// ignores the frontmatter `name`; Codex lists the frontmatter name. Ply keys
/// a row on the directory because of this, and reports the other as the name
/// Codex uses — so if either CLI changes its mind, this is what fails.
#[test]
#[ignore = "drives the installed claude and codex CLIs"]
fn the_two_clis_name_one_skill_differently_when_its_frontmatter_disagrees() {
    let cwd = TempDir::new().unwrap();
    for root in INSTALL_ROOTS {
        let file = cwd.path().join(root).join("probe-dir-name").join("SKILL.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "---\nname: probe-front-name\ndescription: Two names, one skill.\n---\n\nBody.\n",
        )
        .unwrap();
    }

    let found = read_project_skills(cwd.path());
    assert_eq!(found.skills[0].name, "probe-dir-name");
    assert_eq!(
        found.skills[0].codex_name.as_deref(),
        Some("probe-front-name")
    );

    let out = crate::platform::new_command(cli("codex"))
        .args(["debug", "prompt-input", "hello"])
        .current_dir(cwd.path())
        .output()
        .expect("run codex debug prompt-input");
    let prompt = String::from_utf8_lossy(&out.stdout);
    assert!(
        prompt.contains("probe-front-name"),
        "codex no longer names a skill by its frontmatter: {prompt}"
    );

    let out = crate::platform::new_command(cli("claude"))
        .arg("-p")
        .arg("Invoke the skill whose description is \"Two names, one skill.\" with the Skill tool, then print only the exact skill name string you passed.")
        .current_dir(cwd.path())
        .output()
        .expect("run claude");
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(
        answer.contains("probe-dir-name"),
        "claude no longer names a skill by its directory: {answer}"
    );
}
