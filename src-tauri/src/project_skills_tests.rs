//! v1.117.0 (team sharing rung 4) — project skills and the two copy paths.
//!
//! The fixtures are the layouts the real CLIs load, measured against Claude
//! Code 2.1.267 and codex-cli 0.154.0 (`docs/team-sharing/PLAN.md`, Rung 4).
//! If a vendor changes which directory it reads, one of these is what changes
//! with it.

use super::*;
use tempfile::TempDir;

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

const SKILL: &str = "---\nname: ship-a-card\ndescription: How this repo ships a change.\n---\n\nShip through a card.\n";

/// A repo with one skill in both native roots — what Install produces.
fn repo_with_both_roots() -> TempDir {
    let dir = TempDir::new().unwrap();
    for root in INSTALL_ROOTS {
        write(&dir.path().join(root).join("ship-a-card").join("SKILL.md"), SKILL);
    }
    dir
}

#[test]
fn a_skill_in_both_native_roots_is_one_row_with_two_badges() {
    let repo = repo_with_both_roots();
    let found = read_project_skills(repo.path());

    assert!(found.errors.is_empty(), "{:?}", found.errors);
    assert_eq!(found.skills.len(), 1, "{:?}", found.skills);
    let skill = &found.skills[0];
    assert_eq!(skill.name, "ship-a-card");
    assert_eq!(skill.description, "How this repo ships a change.");
    assert!(skill.claude && skill.codex);
    assert!(skill.both_vendors());
    assert!(!skill.diverged);
    assert_eq!(skill.roots, vec![CLAUDE_ROOT, CODEX_ROOT]);
    assert_eq!(found.loaded(), 1);
    assert_eq!(found.roots_present, vec![CLAUDE_ROOT, CODEX_ROOT]);
}

/// Measured: no one directory serves both CLIs, so a skill in one root
/// reaches half the sessions Ply starts. The badge is the only place a member
/// would ever see that.
#[test]
fn a_skill_in_one_root_carries_only_that_vendors_badge() {
    let repo = TempDir::new().unwrap();
    write(
        &repo.path().join(CLAUDE_ROOT).join("claude-only").join("SKILL.md"),
        SKILL,
    );
    write(
        &repo.path().join(".codex/skills").join("codex-only").join("SKILL.md"),
        SKILL,
    );
    let found = read_project_skills(repo.path());

    let claude_only = found.skills.iter().find(|s| s.name == "claude-only").unwrap();
    assert!(claude_only.claude && !claude_only.codex);
    let codex_only = found.skills.iter().find(|s| s.name == "codex-only").unwrap();
    assert!(codex_only.codex && !codex_only.claude);
    assert_eq!(found.loaded(), 0);
    assert_eq!(found.only(Vendor::Claude), 1);
    assert_eq!(found.only(Vendor::Codex), 1);
    // `.codex/skills` is read even though Ply never writes it: a repo that
    // already uses it must not look empty.
    assert_eq!(found.roots_present, vec![CLAUDE_ROOT, ".codex/skills"]);
}

/// The state a badge pair cannot show: both CLIs load it, and they load
/// different instructions.
#[test]
fn two_roots_holding_different_bytes_are_reported_as_diverged() {
    let repo = repo_with_both_roots();
    write(
        &repo.path().join(CODEX_ROOT).join("ship-a-card").join("SKILL.md"),
        "---\ndescription: How this repo ships a change.\n---\n\nSomething else entirely.\n",
    );
    let found = read_project_skills(repo.path());
    let skill = &found.skills[0];
    assert!(skill.diverged);
    assert!(skill.claude && skill.codex);
    // And it is refused for Promote, because Ply does not get to choose which
    // of the member's two versions the team receives.
    let blocked = promote_blocker(skill).expect("a diverged skill is not promotable");
    assert!(blocked.contains("not the same file"), "{blocked}");
}

/// A copy Ply cannot read (here: a symlink inside it, which `read_tree`
/// refuses) is said as an error, never as a divergence it could not measure —
/// read as an empty tree, it used to flag two identical copies `diverged`.
#[test]
#[cfg(unix)]
fn a_copy_that_cannot_be_read_is_an_error_not_a_divergence() {
    let repo = repo_with_both_roots();
    let codex = repo.path().join(CODEX_ROOT).join("ship-a-card");
    std::os::unix::fs::symlink(codex.join("SKILL.md"), codex.join("linked.md")).unwrap();
    let found = read_project_skills(repo.path());

    let skill = &found.skills[0];
    assert!(skill.claude && skill.codex, "both CLIs still load it");
    assert!(!skill.diverged, "nothing was compared, so nothing differs");
    assert_eq!(found.errors.len(), 1, "{:?}", found.errors);
    assert!(found.errors[0].contains(".agents/skills/ship-a-card"), "{:?}", found.errors);
    assert!(found.errors[0].contains("symlink"), "{:?}", found.errors);

    // The first copy unreadable: the others are still compared among
    // themselves, so a real divergence is not hidden behind it.
    let repo = repo_with_both_roots();
    let claude = repo.path().join(CLAUDE_ROOT).join("ship-a-card");
    std::os::unix::fs::symlink(claude.join("SKILL.md"), claude.join("linked.md")).unwrap();
    write(
        &repo.path().join(LEGACY_CODEX_ROOT).join("ship-a-card").join("SKILL.md"),
        "---\ndescription: How this repo ships a change.\n---\n\nSomething else entirely.\n",
    );
    let found = read_project_skills(repo.path());
    assert!(found.skills[0].diverged, "{:?}", found.skills);
    assert_eq!(found.errors.len(), 1, "{:?}", found.errors);
}

/// The rule is the CLIs' own (rung 3): a `description` is what makes a
/// skill load, and nothing else is required. Ply must not list what no
/// session will see.
#[test]
fn a_skill_without_a_description_is_listed_as_unloadable_not_as_a_skill() {
    let repo = TempDir::new().unwrap();
    write(
        &repo.path().join(CLAUDE_ROOT).join("nameonly").join("SKILL.md"),
        "---\nname: nameonly\n---\n\nbody\n",
    );
    let found = read_project_skills(repo.path());

    assert!(found.skills.is_empty(), "{:?}", found.skills);
    assert_eq!(found.unloadable.len(), 1);
    assert_eq!(found.unloadable[0].name, "nameonly");
    assert_eq!(found.unloadable[0].root, CLAUDE_ROOT);
    assert!(found.unloadable[0].reason.contains("description"));
}

/// H4 Mac walk: after Rename here the old folder stayed on disk holding
/// only an untracked `.DS_Store`, and the Library said it was "loaded by
/// neither Claude nor Codex" with a raw read error. A folder of nothing but
/// OS junk is no skill and nothing to report; one with a real file still is.
#[test]
fn a_folder_of_only_os_junk_is_not_a_skill() {
    let repo = TempDir::new().unwrap();
    write(&repo.path().join(CLAUDE_ROOT).join("team-style").join(".DS_Store"), "junk");
    write(&repo.path().join(CLAUDE_ROOT).join("team-style").join("scripts").join("Thumbs.db"), "junk");
    write(&repo.path().join(CODEX_ROOT).join("empty-ish").join("desktop.ini"), "junk");
    write(&repo.path().join(CLAUDE_ROOT).join("half").join("notes.md"), "a real file\n");
    let found = read_project_skills(repo.path());
    assert!(found.skills.is_empty(), "{:?}", found.skills);
    let names: Vec<&str> = found.unloadable.iter().map(|u| u.name.as_str()).collect();
    assert_eq!(names, ["half"], "{:?}", found.unloadable);
    assert!(found.errors.is_empty(), "{:?}", found.errors);
}

/// Claude invokes a skill by its directory and Codex by its frontmatter
/// `name`, so a skill whose two names disagree genuinely has two. Measured
/// with both CLIs; the row says so instead of picking one.
#[test]
fn a_frontmatter_name_that_disagrees_with_the_directory_is_reported_as_the_codex_name() {
    let repo = TempDir::new().unwrap();
    write(
        &repo.path().join(CLAUDE_ROOT).join("dir-name").join("SKILL.md"),
        "---\nname: front-name\ndescription: Two names.\n---\n",
    );
    let found = read_project_skills(repo.path());
    assert_eq!(found.skills[0].name, "dir-name");
    assert_eq!(found.skills[0].codex_name.as_deref(), Some("front-name"));
}

#[test]
fn a_repo_with_no_skill_directories_is_empty_and_silent() {
    let repo = TempDir::new().unwrap();
    let found = read_project_skills(repo.path());
    assert!(found.skills.is_empty());
    assert!(found.unloadable.is_empty());
    assert!(found.errors.is_empty());
    // The doctor hangs its row on this: no roots means no row, rather than
    // "0 project skills loaded", which would read as a fault.
    assert!(found.roots_present.is_empty());
}

// ── Install ─────────────────────────────────────────────────────────

fn team_skill_source() -> TempDir {
    let dir = TempDir::new().unwrap();
    write(&dir.path().join("SKILL.md"), SKILL);
    write(&dir.path().join("references").join("checklist.md"), "- one\n");
    // A skill may ship a helper script, and a copy that drops the executable
    // bit hands the next session a file it cannot run.
    let script = dir.path().join("scripts").join("check.sh");
    write(&script, "#!/bin/sh\necho ok\n");
    make_executable(&script);
    dir
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o111 != 0
}

#[test]
fn install_writes_both_native_roots_and_commits_nothing() {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    let source = team_skill_source();

    let outcome = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    assert_eq!(outcome.written.len(), 2, "{outcome:?}");
    assert!(outcome.unchanged.is_empty());

    // Both CLIs load it now.
    let found = read_project_skills(repo.path());
    assert_eq!(found.loaded(), 1);
    // Resource files travel with the skill — a skill is a directory, not one
    // file, and an instruction that references a missing checklist is broken.
    for root in INSTALL_ROOTS {
        let dir = repo.path().join(root).join("ship-a-card");
        assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), SKILL);
        assert!(dir.join("references").join("checklist.md").is_file());
    }

    // Nothing is committed: the card flow ships it, and the member reviews
    // the new files in the card's diff.
    let status = crate::git::capture(repo.path(), &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.contains(".claude/skills/ship-a-card"), "{status}");
    let log = crate::git::capture(repo.path(), &["log", "--oneline"]);
    assert!(log.is_err() || log.unwrap().trim().is_empty(), "Install committed");
}

// ── A root git ignores ──────────────────────────────────────────────
//
// Against a real `git`, because the rule is git's: the rung 4 walk found a
// repo ignoring `.claude/` wholesale, where Install wrote both copies and a
// card could only ever carry one.

fn repo_ignoring(gitignore: &str) -> TempDir {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    std::fs::write(repo.path().join(".gitignore"), gitignore).unwrap();
    repo
}

#[test]
fn install_into_a_repo_ignoring_claude_says_the_claude_half_will_not_ship() {
    let repo = repo_ignoring(".claude/\n");
    let source = team_skill_source();

    let outcome = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    // Both are still written — the copy is right for this checkout's sessions.
    assert_eq!(outcome.written.len(), 2, "{outcome:?}");
    assert_eq!(outcome.ignored, vec![CLAUDE_ROOT.to_string()]);
    // Exactly what the walk saw: git offers only the Codex half.
    let status = crate::git::capture(repo.path(), &["status", "--porcelain", "-uall"]).unwrap();
    assert!(!status.contains(".claude/"), "{status}");
    assert!(status.contains(".agents/skills/ship-a-card"), "{status}");

    // And the listing says so, repo-wide and on the skill's own row.
    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    assert_eq!(found.skills[0].ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    // Before an Install, too: the team row is asked the same question.
    assert_eq!(
        ignored_skill_roots(repo.path(), "another", INSTALL_ROOTS),
        vec![CLAUDE_ROOT.to_string()]
    );
}

/// The fix the sentence offers, and the one this repo itself uses. Asking git
/// about the bare directory would get this one wrong — see
/// `git::check_ignored`.
#[test]
fn a_carved_out_skills_root_is_not_reported_as_ignored() {
    let repo = repo_ignoring(".claude/*\n!.claude/skills/\n");
    let source = team_skill_source();
    let outcome = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    assert!(outcome.ignored.is_empty(), "{outcome:?}");
    let found = read_project_skills(repo.path());
    assert!(found.ignored_roots.is_empty(), "{:?}", found.ignored_roots);
    assert!(found.skills[0].ignored_roots.is_empty());
    let status = crate::git::capture(repo.path(), &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.contains(".claude/skills/ship-a-card"), "{status}");
}

/// A copy git already tracks ships whatever `.gitignore` says, so it is not
/// reported — only the root, where a new skill would land, still is.
#[test]
fn a_tracked_copy_under_an_ignored_root_is_not_reported_but_the_root_is() {
    let repo = repo_ignoring(".claude/\n");
    let source = team_skill_source();
    install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    crate::git::run(repo.path(), &["add", "-f", ".claude/skills/ship-a-card"]).unwrap();

    let found = read_project_skills(repo.path());
    assert!(found.skills[0].ignored_roots.is_empty(), "{:?}", found.skills[0]);
    assert_eq!(found.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
}

// ── GH #227: links and submodules among the skills ───────────────────
//
// `git check-ignore` refuses a path behind a symbolic link or inside a
// submodule and fails the whole batch with it; the listing used to read that
// as "nothing ignored".

#[cfg(unix)]
fn link(target: &str, at: &Path) {
    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(target, at).unwrap();
}

#[cfg(unix)]
fn skill_link(path: &str, target: &str, ignored: Option<bool>, state: TargetState) -> SkillBoundary {
    SkillBoundary {
        kind: BoundaryKind::Link,
        root: CLAUDE_ROOT.into(),
        skill: path.rsplit_once('/').map(|(_, s)| s.to_string()).filter(|_| path != CLAUDE_ROOT),
        path: path.into(),
        target: target.into(),
        ignored,
        target_state: state,
    }
}

#[cfg(unix)]
#[test]
fn a_linked_skill_does_not_hide_an_ignored_real_one() {
    let repo = repo_ignoring(".claude/\n");
    write(&repo.path().join(".claude/skills/real/SKILL.md"), SKILL);
    write(&repo.path().join("shared/s2/SKILL.md"), SKILL);
    link("../../shared/s2", &repo.path().join(".claude/skills/s2"));

    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    let real = found.skills.iter().find(|s| s.name == "real").unwrap();
    assert_eq!(real.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    // The link is listed as a link, with git's answer for the link itself
    // and for its target; its skill is never guessed either way.
    let s2 = found.skills.iter().find(|s| s.name == "s2").unwrap();
    assert!(s2.ignored_roots.is_empty(), "{s2:?}");
    assert_eq!(
        found.boundaries,
        vec![skill_link(
            ".claude/skills/s2",
            "../../shared/s2",
            Some(true),
            TargetState::Carried("shared/s2".into())
        )]
    );
    assert!(found.unanswered.is_empty(), "{:?}", found.unanswered);
}

/// A link git carries: the other root's answer still comes through, and a
/// target git ignores is said.
#[cfg(unix)]
#[test]
fn a_carried_link_beside_an_ignored_codex_root() {
    let repo = repo_ignoring(".agents/\nshared/\n");
    write(&repo.path().join("shared/s2/SKILL.md"), SKILL);
    link("../../shared/s2", &repo.path().join(".claude/skills/s2"));
    write(&repo.path().join(".agents/skills/s2/SKILL.md"), SKILL);

    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CODEX_ROOT.to_string()]);
    assert_eq!(found.skills[0].ignored_roots, vec![CODEX_ROOT.to_string()]);
    assert_eq!(
        found.boundaries,
        vec![skill_link(
            ".claude/skills/s2",
            "../../shared/s2",
            Some(false),
            TargetState::Ignored("shared/s2".into())
        )]
    );
    assert!(found.unanswered.is_empty());
}

/// The root itself is a link. `.claude/*` + `!.claude/skills/` ignores it:
/// the negation names a directory, and git stores a link as a file.
#[cfg(unix)]
#[test]
fn a_linked_root_is_reported_as_a_link_not_as_clean() {
    let repo = repo_ignoring(".claude/*\n!.claude/skills/\n.agents/\n");
    write(&repo.path().join("shared/skills/one/SKILL.md"), SKILL);
    link("../shared/skills", &repo.path().join(".claude/skills"));
    write(&repo.path().join(".agents/skills/one/SKILL.md"), SKILL);

    let found = read_project_skills(repo.path());
    // Every probe of the Claude root is behind the link; the Codex root's
    // answer is not lost with them.
    assert_eq!(found.ignored_roots, vec![CODEX_ROOT.to_string()]);
    assert_eq!(
        found.boundaries,
        vec![skill_link(
            CLAUDE_ROOT,
            "../shared/skills",
            Some(true),
            TargetState::Carried("shared/skills".into())
        )]
    );
    assert!(found.unanswered.is_empty(), "{:?}", found.unanswered);
    let one = &found.skills[0];
    assert_eq!(one.ignored_roots, vec![CODEX_ROOT.to_string()], "{one:?}");
}

/// Only links in a real root: the root's own answer still comes through.
#[cfg(unix)]
#[test]
fn a_root_holding_only_links_is_still_reported_ignored() {
    let repo = repo_ignoring(".claude/\n");
    for name in ["one", "two"] {
        write(&repo.path().join(format!("shared/{name}/SKILL.md")), SKILL);
        link(&format!("../../shared/{name}"), &repo.path().join(format!(".claude/skills/{name}")));
    }
    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    assert_eq!(found.boundaries.len(), 2);
    assert!(found.boundaries.iter().all(|b| b.ignored == Some(true)), "{:?}", found.boundaries);
    assert_eq!(
        ignored_skill_roots(repo.path(), "another", INSTALL_ROOTS),
        vec![CLAUDE_ROOT.to_string()]
    );
}

/// Install's own question, with the Claude root a link: the Codex root is
/// still answered, and the Claude one is said to be unknown, not clean.
#[cfg(unix)]
#[test]
fn install_into_a_linked_root_still_reports_the_other_root() {
    let repo = repo_ignoring(".agents/\n");
    std::fs::create_dir_all(repo.path().join("shared/skills")).unwrap();
    link("../shared/skills", &repo.path().join(".claude/skills"));
    let asked = skill_roots_ignore(repo.path(), "another", INSTALL_ROOTS);
    assert_eq!(asked.ignored, vec![CODEX_ROOT.to_string()]);
    assert_eq!(
        asked.unknown,
        vec![Unanswered {
            path: CLAUDE_ROOT.into(),
            reason: "it is behind a link".into()
        }]
    );
    // (Install itself refuses to write through a linked root; the team row
    // asks this before it, and says the Claude half is unknown.)
}

/// A repository git will not answer for at all (a config it cannot parse) is
/// not "a folder that isn't a repository": Install's question says every root
/// is unknown, and the listing says the same — never that nothing is ignored.
#[test]
fn a_repository_git_cannot_read_leaves_every_root_unknown_not_clean() {
    let repo = repo_ignoring(".claude/\n");
    write(&repo.path().join(CLAUDE_ROOT).join("ship-a-card").join("SKILL.md"), SKILL);
    let config = repo.path().join(".git").join("config");
    let mut broken = std::fs::read_to_string(&config).unwrap();
    broken.push_str("[core\nbroken");
    std::fs::write(&config, broken).unwrap();

    let asked = skill_roots_ignore(repo.path(), "ship-a-card", INSTALL_ROOTS);
    assert!(asked.ignored.is_empty(), "{asked:?}");
    assert_eq!(
        asked.unknown.iter().map(|u| u.path.as_str()).collect::<Vec<_>>(),
        INSTALL_ROOTS.to_vec(),
        "{asked:?}"
    );
    assert!(asked.unknown.iter().all(|u| u.reason == "git refused the question"), "{asked:?}");

    let found = read_project_skills(repo.path());
    assert!(found.ignored_roots.is_empty());
    assert!(
        found.unanswered.iter().any(|u| u.path == CLAUDE_ROOT),
        "{:?}",
        found.unanswered
    );
    assert!(found.git_details.iter().any(|d| d.contains("bad config")), "{:?}", found.git_details);
}

/// A repository (with a commit) to add as a submodule.
fn submodule_source() -> TempDir {
    let dir = TempDir::new().unwrap();
    crate::git::run(dir.path(), &["init", "-q"]).unwrap();
    write(&dir.path().join("SKILL.md"), SKILL);
    crate::git::run(dir.path(), &["add", "."]).unwrap();
    crate::git::run(
        dir.path(),
        &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "skill"],
    )
    .unwrap();
    dir
}

fn add_submodule(repo: &Path, source: &Path, at: &str) {
    crate::git::run(
        repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            source.to_str().unwrap(),
            at,
        ],
    )
    .unwrap();
}

/// Review round 1 (M1): a skill that is a submodule made git refuse the batch
/// ("is in submodule") — the real skill beside it is still ignored, the
/// submodule is said as what git stores, and nothing is unanswered.
#[test]
fn a_submodule_skill_does_not_hide_an_ignored_real_one() {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    write(&repo.path().join(".claude/skills/real/SKILL.md"), SKILL);
    let source = submodule_source();
    add_submodule(repo.path(), source.path(), ".claude/skills/sub");
    std::fs::write(repo.path().join(".gitignore"), ".claude/\n").unwrap();

    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    let real = found.skills.iter().find(|s| s.name == "real").unwrap();
    assert_eq!(real.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    assert_eq!(found.boundaries.len(), 1, "{:?}", found.boundaries);
    let b = &found.boundaries[0];
    assert_eq!((b.kind, b.path.as_str()), (BoundaryKind::Submodule, ".claude/skills/sub"));
    // Tracked as a gitlink: git carries it whatever .gitignore says.
    assert_eq!(b.ignored, Some(false));
    assert!(found.unanswered.is_empty(), "{:?}", found.unanswered);

    // Not checked out (no `.git` on disk): still found through the index.
    crate::git::run(repo.path(), &["submodule", "deinit", "-q", "-f", ".claude/skills/sub"]).unwrap();
    assert!(!repo.path().join(".claude/skills/sub/.git").exists());
    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    assert!(found.unanswered.is_empty(), "{:?}", found.unanswered);
    // Known from the index, so git is never asked behind it: one run, no
    // refusal to bisect.
    crate::git::take_check_ignore_runs();
    assert_eq!(
        skill_roots_ignore(repo.path(), "sub", INSTALL_ROOTS).unknown,
        vec![Unanswered {
            path: CLAUDE_ROOT.into(),
            reason: "it is inside a submodule".into()
        }]
    );
    assert_eq!(crate::git::take_check_ignore_runs(), 1);
}

/// Review round 1 (m3): the team rows carry "unknown" for a root git won't
/// answer for, next to the other root's real answer.
#[test]
fn a_team_row_says_unknown_for_a_submodule_root() {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    std::fs::create_dir_all(repo.path().join(".claude")).unwrap();
    let source = submodule_source();
    add_submodule(repo.path(), source.path(), ".claude/skills");
    std::fs::write(repo.path().join(".gitignore"), ".agents/\n").unwrap();
    let row = TeamSkillRow {
        skill: team_skills::TeamSkill {
            name: "ship-a-card".into(),
            description: "d".into(),
            codex_name: None,
            plugin: team_skills::PLY_PLUGIN.into(),
            claude: true,
            codex: true,
        },
        repo: CopyState::Absent,
        ignored_roots: Vec::new(),
        unknown_roots: Vec::new(),
        dir: None,
        halves: Vec::new(),
        needs_ok: None,
        refused: Vec::new(),
    };
    let rows = mark_install_ignored(repo.path(), vec![row]);
    assert_eq!(rows[0].ignored_roots, vec![CODEX_ROOT.to_string()]);
    assert_eq!(
        rows[0].unknown_roots,
        vec![Unanswered {
            path: CLAUDE_ROOT.into(),
            reason: "it is inside a submodule".into()
        }]
    );
}

/// Review round 2: a nested clone that isn't a registered submodule is
/// told apart from one that is — committing it would record a commit with
/// no URL. Also a gitlink `.gitmodules` doesn't name (a nested repo added
/// with plain `git add`).
#[test]
fn a_nested_clone_is_not_a_registered_submodule() {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    write(&repo.path().join(".claude/skills/nested/SKILL.md"), SKILL);
    crate::git::run(&repo.path().join(".claude/skills/nested"), &["init", "-q"]).unwrap();
    let found = read_project_skills(repo.path());
    assert_eq!(found.boundaries.len(), 1, "{:?}", found.boundaries);
    assert_eq!(found.boundaries[0].kind, BoundaryKind::NestedRepository);
    assert_eq!(
        skill_roots_ignore(repo.path(), "nested", INSTALL_ROOTS).unknown,
        vec![Unanswered {
            path: CLAUDE_ROOT.into(),
            reason: "it is inside a repository of its own".into()
        }]
    );

    // Committed with plain `git add`: a gitlink `.gitmodules` doesn't name.
    crate::git::run(
        &repo.path().join(".claude/skills/nested"),
        &["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"],
    )
    .unwrap();
    crate::git::run(repo.path(), &["add", ".claude/skills/nested"]).unwrap();
    assert_eq!(
        crate::git::gitlinks(repo.path(), &[".claude"]),
        vec![".claude/skills/nested".to_string()]
    );
    let found = read_project_skills(repo.path());
    assert_eq!(found.boundaries[0].kind, BoundaryKind::NestedRepository);

    // A registered one next to it is a submodule.
    let source = submodule_source();
    add_submodule(repo.path(), source.path(), ".claude/skills/sub");
    let found = read_project_skills(repo.path());
    let kinds: Vec<(&str, BoundaryKind)> =
        found.boundaries.iter().map(|b| (b.path.as_str(), b.kind)).collect();
    assert!(kinds.contains(&(".claude/skills/nested", BoundaryKind::NestedRepository)), "{kinds:?}");
    assert!(kinds.contains(&(".claude/skills/sub", BoundaryKind::Submodule)), "{kinds:?}");
}

/// Review round 2 (m3): a Promote whose ignore check gets no answer is
/// refused — it reaches every teammate — never treated as "nothing ignored".
#[test]
fn a_promote_the_ignore_check_cannot_answer_is_refused() {
    let not_a_repo = TempDir::new().unwrap();
    let source = team_skill_source();
    let destination = not_a_repo.path().join("library/claude/skills/ship-a-card");
    let error =
        refuse_ignored_library_files(not_a_repo.path(), source.path(), &[destination], "ship-a-card")
            .unwrap_err();
    assert!(error.contains("Plyloft couldn't ask git whether the team repo would commit"), "{error}");
    assert!(error.contains("Nothing was shared"), "{error}");
    assert!(!error.contains("fatal"), "{error}");
}

/// A whole root that is a submodule.
#[test]
fn a_submodule_root_is_said_as_a_repository() {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    std::fs::create_dir_all(repo.path().join(".claude")).unwrap();
    let source = submodule_source();
    add_submodule(repo.path(), source.path(), ".claude/skills");
    std::fs::write(repo.path().join(".gitignore"), ".agents/\n").unwrap();

    let found = read_project_skills(repo.path());
    assert_eq!(found.ignored_roots, vec![CODEX_ROOT.to_string()]);
    assert_eq!(found.boundaries.len(), 1, "{:?}", found.boundaries);
    assert_eq!(found.boundaries[0].kind, BoundaryKind::Submodule);
    assert_eq!(found.boundaries[0].skill, None);
    assert!(found.unanswered.is_empty(), "{:?}", found.unanswered);
}

/// Review round 1 (M2): a skill git gives no answer for is unanswered as
/// itself — never its root, whose own probe answered. The refusal is the
/// one a race gives (a skill turned into a link after it was listed), so
/// git's answers are supplied.
#[test]
fn a_refused_skill_is_unanswered_by_itself_not_by_its_root() {
    use crate::git::IgnoreAnswer;
    let repo = repo_ignoring(".claude/\n");
    write(&repo.path().join(".claude/skills/s2/SKILL.md"), SKILL);
    let mut out = read_project_skills(repo.path());
    out.ignored_roots.clear();
    out.skills[0].ignored_roots.clear();
    let refused = skill_probe(CLAUDE_ROOT, "s2");
    mark_ignored_with(repo.path(), &mut out, |paths| {
        Ok(paths
            .iter()
            .map(|path| {
                if *path == refused {
                    IgnoreAnswer::Unknown(format!(
                        "git check-ignore failed: fatal: pathspec '{path}' is beyond a symbolic link"
                    ))
                } else if path.starts_with(".claude/") {
                    IgnoreAnswer::Ignored
                } else {
                    IgnoreAnswer::NotIgnored
                }
            })
            .collect())
    });
    assert_eq!(out.ignored_roots, vec![CLAUDE_ROOT.to_string()]);
    assert_eq!(
        out.unanswered,
        vec![Unanswered {
            path: ".claude/skills/s2".into(),
            reason: "it is behind a link".into(),
        }]
    );
    // Git's own words are kept for Details, not the row.
    assert!(out.git_details[0].contains("beyond a symbolic link"), "{:?}", out.git_details);
}

/// Not a repository: there is no commit for a card to carry either way, so
/// there is nothing to warn about.
#[test]
fn a_folder_that_is_not_a_repository_ignores_nothing() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    let outcome = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    assert!(outcome.ignored.is_empty());
    assert!(read_project_skills(repo.path()).ignored_roots.is_empty());
}

#[test]
fn the_gitignored_sentence_names_the_root_and_its_fix() {
    assert_eq!(gitignored_sentence(&[]), None);
    let one = gitignored_sentence(&[CLAUDE_ROOT.to_string()]).unwrap();
    assert!(
        one.starts_with(".claude/skills is gitignored in this repo — a card will not carry it"),
        "{one}"
    );
    assert!(one.contains(".claude/* then !.claude/skills/"), "{one}");
    let two = gitignored_sentence(&[CLAUDE_ROOT.to_string(), CODEX_ROOT.to_string()]).unwrap();
    assert!(two.contains(".claude/skills and .agents/skills are gitignored"), "{two}");
    assert!(two.contains("will not carry them"), "{two}");
}

/// A workspace whose folder has been moved or deleted: Install must say so,
/// not rebuild a shell of the repo around one skill and report success.
#[test]
fn install_refuses_a_workspace_folder_that_is_no_longer_there() {
    let temp = TempDir::new().unwrap();
    let gone = temp.path().join("moved-away");
    let source = team_skill_source();

    let refused = install_into_repo(&gone, "ship-a-card", source.path(), false)
        .expect_err("the checkout is gone").to_string();
    assert!(refused.contains(&format!("not on {}", crate::platform::THIS_MACHINE)), "{refused}");
    assert!(!gone.exists(), "Install created the missing folder");
}

#[test]
fn installing_the_same_skill_twice_changes_nothing() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();

    let again = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    assert!(again.written.is_empty(), "{again:?}");
    assert_eq!(again.unchanged.len(), 2);
    assert!(!again.changed());
}

/// The member's own skill of the same name is not collateral damage.
#[test]
fn install_refuses_a_destination_holding_a_different_skill_until_asked() {
    let repo = TempDir::new().unwrap();
    let mine = under(repo.path(), CLAUDE_ROOT).join("ship-a-card");
    write(&mine.join("SKILL.md"), "---\ndescription: Mine.\n---\n\nMy own.\n");
    let source = team_skill_source();

    let refused = install_into_repo(repo.path(), "ship-a-card", source.path(), false)
        .expect_err("a different skill is already there").to_string();
    assert!(refused.contains("already exists"), "{refused}");
    assert!(refused.contains("Nothing was copied"), "{refused}");
    // And nothing was: not even the half that was free.
    assert_eq!(
        std::fs::read_to_string(mine.join("SKILL.md")).unwrap(),
        "---\ndescription: Mine.\n---\n\nMy own.\n"
    );
    assert!(!repo.path().join(CODEX_ROOT).join("ship-a-card").exists());

    // Asked for explicitly, it replaces — and leaves nothing of the old copy
    // behind.
    write(&mine.join("stale.md"), "gone after the replace\n");
    let replaced = install_into_repo(repo.path(), "ship-a-card", source.path(), true).unwrap();
    assert_eq!(replaced.written.len(), 2);
    assert!(!mine.join("stale.md").exists());
    assert_eq!(std::fs::read_to_string(mine.join("SKILL.md")).unwrap(), SKILL);
}

/// The Replace question hangs on this refusal, so it crosses the bridge as a
/// value — `{ notTheSameSkill, message }` — and the window never has to match
/// the sentence. Every other refusal stays a plain string on the wire.
#[test]
fn the_different_skill_refusal_is_a_value_and_every_other_refusal_a_string() {
    let repo = TempDir::new().unwrap();
    let mine = under(repo.path(), CLAUDE_ROOT).join("ship-a-card");
    write(&mine.join("SKILL.md"), "---\ndescription: Mine.\n---\n\nMy own.\n");
    let source = team_skill_source();

    let refused = install_into_repo(repo.path(), "ship-a-card", source.path(), false)
        .expect_err("a different skill is already there");
    let refusal = refused.refusal().expect("the refusal, as a value");
    assert_eq!(refusal.not_the_same_skill, mine.display().to_string());
    let wire = serde_json::to_value(&refused).unwrap();
    assert_eq!(wire["notTheSameSkill"], serde_json::json!(mine.display().to_string()));
    assert!(wire["message"].as_str().unwrap().contains("Nothing was copied"), "{wire}");
    assert_eq!(refused.to_string(), refusal.message, "Rust callers read the same words");

    // A refusal Replace cannot answer is a sentence, exactly as before.
    let other = install_into_repo(repo.path(), "../escape", source.path(), false)
        .expect_err("not a plain name");
    assert!(other.refusal().is_none());
    assert!(serde_json::to_value(&other).unwrap().is_string());

    // The library half refuses the same way.
    let clone = TempDir::new().unwrap();
    let theirs = team_skills::library_skill_dirs(clone.path(), team_skills::PLY_PLUGIN, "ship-a-card");
    write(&theirs[0].join("SKILL.md"), "---\ndescription: Theirs.\n---\n\nA teammate's.\n");
    let refused = write_promoted_skill(
        clone.path(),
        team_skills::PLY_PLUGIN,
        "ship-a-card",
        source.path(),
        false,
    )
    .expect_err("a teammate's skill is already there");
    assert_eq!(
        refused.refusal().map(|r| r.not_the_same_skill.clone()),
        Some(theirs[0].display().to_string())
    );
}

/// The refusal reaches the window as a value only when the library write
/// provably put everything back; an abandoned rollback is said in its own
/// words, and a write that went through is simply the outcome.
#[test]
fn a_promote_refusal_is_a_value_only_over_a_library_left_unchanged() {
    use crate::team::{LibraryError, LibraryOutcome};
    let refusal = NotTheSameSkill {
        not_the_same_skill: "/clone/library/claude/ply-team/skills/deploy".into(),
        message: "… already exists and is not the same skill.".into(),
    };
    let failed = promote_published(Err(LibraryError::Failed("refused".into())), Some(refusal.clone()));
    assert_eq!(failed, Err(CopyError::NotTheSameSkill(refusal.clone())));

    let abandoned = LibraryError::Abandoned { path: "library/claude".into(), detail: "restore failed".into() };
    let said = abandoned.message();
    assert_eq!(
        promote_published(Err(abandoned), Some(refusal.clone())),
        Err(CopyError::Message(said)),
        "not provably unchanged: the library write's words, never the Replace question"
    );

    // Failed with no refusal: a sentence, as before.
    assert_eq!(
        promote_published(Err(LibraryError::Failed("disk full".into())), None),
        Err(CopyError::Message(LibraryError::Failed("disk full".into()).message()))
    );

    let done = LibraryOutcome {
        path: "/clone/library".into(),
        relative_path: "library".into(),
        committed: true,
        pushed: true,
    };
    assert_eq!(promote_published(Ok(done.clone()), None), Ok(done.clone()));
    assert_eq!(promote_published(Ok(done.clone()), Some(refusal)), Ok(done));
}

/// Half-installed is the state a retry finishes, not one it refuses: nothing
/// at the empty destination is being overwritten.
#[test]
fn install_completes_a_half_installed_skill_without_being_asked_to_replace() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    let dirs = repo_skill_dirs(repo.path(), "ship-a-card");
    assert_eq!(copy_state(source.path(), &dirs), CopyState::Absent);

    install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    std::fs::remove_dir_all(repo.path().join(CODEX_ROOT).join("ship-a-card")).unwrap();
    assert_eq!(copy_state(source.path(), &dirs), CopyState::Partial);

    let finished = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    assert_eq!(finished.written.len(), 1);
    assert_eq!(finished.unchanged.len(), 1);
    assert_eq!(copy_state(source.path(), &dirs), CopyState::Same);
}

/// H3b walk: a Claude-only team skill whose Claude copy is in the repo is
/// complete — its team row must not offer "Complete" into Codex's root.
#[test]
fn a_claude_only_team_skill_with_its_claude_copy_here_is_same_not_partial() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    std::fs::remove_dir_all(repo.path().join(CODEX_ROOT).join("ship-a-card")).unwrap();
    let skill = |claude: bool, codex: bool| crate::team_skills::TeamSkill {
        name: "ship-a-card".into(),
        description: "d".into(),
        codex_name: None,
        plugin: "ply-team".into(),
        claude,
        codex,
    };
    let claude_only = reached_skill_dirs(repo.path(), &skill(true, false));
    assert_eq!(claude_only.len(), 1);
    assert_eq!(copy_state(source.path(), &claude_only), CopyState::Same);
    // Both CLIs load it: the missing Codex copy is still "partial".
    let both = reached_skill_dirs(repo.path(), &skill(true, true));
    assert_eq!(copy_state(source.path(), &both), CopyState::Partial);
}

/// Review of PR #27 (4th Challenger round): `.codex/skills` is read but never
/// written, so a diverging copy there survived an Install and the next
/// comparison called the result Same. A disagreeing legacy copy is refused
/// before any byte is written; an identical one is not a conflict.
#[test]
fn install_refuses_a_diverging_legacy_codex_copy_and_accepts_an_identical_one() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    let legacy = under(repo.path(), LEGACY_CODEX_ROOT).join("ship-a-card");
    write(&legacy.join("SKILL.md"), "---\nname: ship-a-card\ndescription: something else\n---\nnot the team's words\n");

    let refused = install_into_repo(repo.path(), "ship-a-card", source.path(), false)
        .expect_err("a legacy copy that disagrees").to_string();
    // The refusal names the legacy copy by its native path.
    assert!(refused.contains(&legacy.display().to_string()), "{refused}");
    for root in INSTALL_ROOTS {
        assert!(!repo.path().join(root).join("ship-a-card").exists(), "{root} must stay untouched");
    }

    // Same bytes in the legacy root: no conflict, the install proceeds.
    std::fs::remove_dir_all(&legacy).unwrap();
    for file in read_tree(source.path()).unwrap() {
        write(&legacy.join(&file.path), &String::from_utf8_lossy(&file.bytes));
        if file.executable {
            make_executable(&legacy.join(&file.path));
        }
    }
    let outcome = install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();
    assert_eq!(outcome.written.len(), INSTALL_ROOTS.len());
}

/// Review of PR #27 (4th Challenger round): `Path::exists` says "nothing
/// here" for a dangling link, which let a rename land on top of it without
/// Replace. A link at the destination is an occupant, and a link is refused
/// as a write target on any path.
#[test]
#[cfg(unix)]
fn install_refuses_a_dangling_link_at_the_destination() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    std::fs::create_dir_all(repo.path().join(CLAUDE_ROOT)).unwrap();
    let link = repo.path().join(CLAUDE_ROOT).join("ship-a-card");
    std::os::unix::fs::symlink(repo.path().join("gone"), &link).unwrap();

    let refused = install_into_repo(repo.path(), "ship-a-card", source.path(), false)
        .expect_err("a dangling link is an occupant, not an empty slot").to_string();
    assert!(!refused.is_empty());
    let refused = install_into_repo(repo.path(), "ship-a-card", source.path(), true)
        .expect_err("even Replace must not write through a link").to_string();
    assert!(refused.contains("symlink"), "{refused}");
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link is left as it was");
    assert!(!repo.path().join(CODEX_ROOT).join("ship-a-card").exists());
}

/// Every name either move joins into a path comes out of a directory listing
/// or a manifest, and one of them is joined into somebody else's repository.
#[test]
fn a_skill_name_that_is_not_one_plain_component_is_refused() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    for name in ["../escape", "nested/skill", ".hidden", "", "..", "."] {
        let refused = install_into_repo(repo.path(), name, source.path(), true)
            .expect_err("must be refused").to_string();
        assert!(refused.contains("plain name"), "{name}: {refused}");
    }
    // And nothing was created anywhere near the repo.
    assert!(!repo.path().join(CLAUDE_ROOT).exists());
}

/// A symlink is not followed: copying through one would put a *copy* of its
/// target into the team library or into somebody's repo — not what the author
/// wrote, and a way to smuggle in a file from outside.
#[test]
#[cfg(unix)]
fn a_symlink_in_the_source_is_refused_rather_than_followed() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    let secret = repo.path().join("secret.txt");
    std::fs::write(&secret, "not yours\n").unwrap();
    std::os::unix::fs::symlink(&secret, source.path().join("linked.md")).unwrap();

    let refused = install_into_repo(repo.path(), "ship-a-card", source.path(), false)
        .expect_err("a symlinked file is refused").to_string();
    assert!(refused.contains("symlink"), "{refused}");
    assert!(!repo.path().join(CLAUDE_ROOT).join("ship-a-card").exists());
}

// ── Promote ─────────────────────────────────────────────────────────
//
// Against a real `git` and a local bare remote, because the thing worth
// proving is not that files were copied but that a teammate pulling the team
// repo gets a skill **both** CLIs load — one commit, both halves, manifests
// included.

fn git(dir: &Path, args: &[&str]) {
    let output = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Plyloft Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Plyloft Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .unwrap_or_else(|e| panic!("spawn git {args:?}: {e}"));
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A team repo exactly as `scripts/team-init.sh` leaves it: both library
/// halves present and empty. The first Promote is what makes them a plugin.
fn team_remote_and_clone(root: &Path) -> PathBuf {
    let bare = root.join("origin.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare", "--initial-branch=main", "."]);

    let seed = root.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "--initial-branch=main", "."]);
    std::fs::write(seed.join("team.json"), br#"{"name":"MB Adv"}"#).unwrap();
    for half in ["knowledge", "claude", "codex"] {
        let dir = seed.join("library").join(half);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitkeep"), b"").unwrap();
    }
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-m", "seed"]);
    git(&seed, &["remote", "add", "origin", &bare.to_string_lossy()]);
    git(&seed, &["push", "-u", "origin", "main"]);

    let clone = root.join("clone");
    git(
        root,
        &["clone", &bare.to_string_lossy(), &clone.to_string_lossy()],
    );
    git(&clone, &["config", "user.name", "Plyloft Test"]);
    git(&clone, &["config", "user.email", "test@example.invalid"]);
    clone
}

/// Promote one project skill the way the command does: a single library write
/// spanning both halves.
fn promote(clone: &Path, cwd: &Path, skill: &str, replace: bool) -> Result<(), String> {
    let source = cwd.join(CLAUDE_ROOT).join(skill);
    let paths = team_skills::promote_paths(team_skills::PLY_PLUGIN, skill)?;
    crate::team::publish_library_paths(
        clone,
        &paths,
        &format!("skills: share \"{skill}\" with the team"),
        |clone_dir| {
            write_promoted_skill(clone_dir, team_skills::PLY_PLUGIN, skill, &source, replace)
                .map(|_| ())
                .map_err(String::from)
        },
        &crate::team::RealLibraryGit,
    )
    .map(|_| ())
    .map_err(|error| error.message())
}

#[test]
fn promote_publishes_one_skill_that_both_halves_of_the_library_load() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();

    promote(&clone, repo.path(), "ship-a-card", false).expect("promote");

    // The proof that matters: rung 3's reader, which is what hands skills to
    // the CLIs, sees one skill with both badges.
    let library = team_skills::read_library(&clone);
    assert!(library.errors.is_empty(), "{:?}", library.errors);
    assert!(library.refused.is_empty(), "{:?}", library.refused);
    assert_eq!(library.skills.len(), 1, "{:?}", library.skills);
    assert_eq!(library.skills[0].name, "ship-a-card");
    assert!(library.skills[0].both_vendors());
    assert_eq!(library.claude_plugin_dirs.len(), 1);
    let codex = library.codex.as_ref().expect("a codex marketplace");
    assert_eq!(codex.plugins.len(), 1);
    assert_eq!(
        codex.plugin_id(&codex.plugins[0]),
        format!("{}@{}", team_skills::PLY_PLUGIN, team_skills::PLY_PLUGIN)
    );

    // One commit, and the working tree is clean: nothing was left unstaged
    // for the next write to publish by accident.
    let log = crate::git::capture(&clone, &["log", "--oneline"]).unwrap();
    assert_eq!(log.lines().count(), 2, "{log}");
    assert!(log.contains("ship-a-card"), "{log}");
    let status = crate::git::capture(&clone, &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.trim().is_empty(), "{status}");

    // And it reached the remote, which is the only thing a teammate can see.
    let remote = crate::git::capture(
        &clone,
        &["ls-tree", "-r", "--name-only", "origin/main"],
    )
    .unwrap();
    assert!(remote.contains("library/claude/ply-team/skills/ship-a-card/SKILL.md"), "{remote}");
    assert!(
        remote.contains("library/codex/plugins/ply-team/skills/ship-a-card/SKILL.md"),
        "{remote}"
    );
    assert!(remote.contains("library/codex/.agents/plugins/marketplace.json"), "{remote}");
}

/// A promoted skill whose description is a block scalar reaches the library
/// with its real description, not the indicator.
#[test]
fn a_promoted_block_scalar_description_reaches_the_library() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = TempDir::new().unwrap();
    write(
        &repo.path().join(CLAUDE_ROOT).join("deploy").join("SKILL.md"),
        "---\nname: deploy\ndescription: >-\n  Full deploy pipeline for Lyra staging.\n  Pushes to staging.\n---\n\nDeploy.\n",
    );
    let found = read_project_skills(repo.path());
    assert_eq!(found.skills[0].description, "Full deploy pipeline for Lyra staging. Pushes to staging.");

    promote(&clone, repo.path(), "deploy", false).expect("promote");

    let library = team_skills::read_library(&clone);
    assert!(library.errors.is_empty(), "{:?}", library.errors);
    assert_eq!(library.skills.len(), 1, "{:?}", library.skills);
    assert_eq!(
        library.skills[0].description,
        "Full deploy pipeline for Lyra staging. Pushes to staging."
    );
}

/// `git add -- <dir>` skips an ignored file inside the directory without a
/// word, so a team `.gitignore` naming `*.sh` would publish the skill without
/// its script and call it shared. A Promote reaches every teammate, so it is
/// refused, and the library write's rollback leaves the clone as it was.
#[test]
fn promote_refuses_a_team_repo_that_would_leave_part_of_the_skill_out() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    std::fs::write(clone.join(".gitignore"), "*.sh\n").unwrap();
    git(&clone, &["add", ".gitignore"]);
    git(&clone, &["commit", "-m", "ignore scripts"]);
    git(&clone, &["push"]);
    let head = crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap();

    let repo = repo_with_both_roots();
    let script = repo.path().join(CLAUDE_ROOT).join("ship-a-card").join("scripts").join("check.sh");
    write(&script, "#!/bin/sh\necho ok\n");

    let refused = promote(&clone, repo.path(), "ship-a-card", false).expect_err("a half-published skill");
    assert!(refused.contains(".gitignore ignores"), "{refused}");
    assert!(refused.contains("ship-a-card/scripts/check.sh"), "{refused}");
    assert!(refused.contains("Nothing was shared"), "{refused}");
    // Nothing committed, nothing left behind.
    assert_eq!(crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap(), head);
    assert!(!clone
        .join("library/claude")
        .join(team_skills::PLY_PLUGIN)
        .join("skills/ship-a-card")
        .exists());
    let status = crate::git::capture(&clone, &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.trim().is_empty(), "{status}");
}

/// Review of snapshot 2: the final tree decides. A skill whose own
/// `.gitignore` un-ignores its script against a team `*.sh` rule is wholly
/// committable, so it is shared — with the script, in both halves.
#[test]
fn promote_accepts_a_skill_whose_own_gitignore_excepts_a_team_rule() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    std::fs::write(clone.join(".gitignore"), "*.sh\n").unwrap();
    git(&clone, &["add", ".gitignore"]);
    git(&clone, &["commit", "-m", "ignore scripts"]);
    git(&clone, &["push"]);

    let repo = repo_with_both_roots();
    let skill_dir = repo.path().join(CLAUDE_ROOT).join("ship-a-card");
    write(&skill_dir.join(".gitignore"), "!scripts/check.sh\n");
    write(&skill_dir.join("scripts").join("check.sh"), "#!/bin/sh\necho ok\n");

    promote(&clone, repo.path(), "ship-a-card", false).expect("the final tree is committable");
    let remote =
        crate::git::capture(&clone, &["ls-tree", "-r", "--name-only", "origin/main"]).unwrap();
    assert!(
        remote.contains("library/claude/ply-team/skills/ship-a-card/scripts/check.sh"),
        "{remote}"
    );
    assert!(
        remote.contains("library/codex/plugins/ply-team/skills/ship-a-card/scripts/check.sh"),
        "{remote}"
    );
}

/// Review of snapshot 2: a replacement is judged without the rules of the
/// copy it replaces. The team's version ignored `notes/`; the member's drops
/// that rule and ships notes, and the Replace publishes them.
#[test]
fn a_replace_is_judged_by_its_own_rules_not_the_replaced_copys() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let first = repo_with_both_roots();
    write(
        &first.path().join(CLAUDE_ROOT).join("ship-a-card").join(".gitignore"),
        "notes/\n",
    );
    promote(&clone, first.path(), "ship-a-card", false).expect("first version");

    let second = repo_with_both_roots();
    write(
        &second.path().join(CLAUDE_ROOT).join("ship-a-card").join("notes").join("why.md"),
        "Because.\n",
    );
    promote(&clone, second.path(), "ship-a-card", true).expect("the replacement is committable");
    let remote =
        crate::git::capture(&clone, &["ls-tree", "-r", "--name-only", "origin/main"]).unwrap();
    assert!(
        remote.contains("library/claude/ply-team/skills/ship-a-card/notes/why.md"),
        "{remote}"
    );
    assert!(!remote.contains("ship-a-card/.gitignore"), "{remote}");
}

/// Review of snapshot 1: the skill's own `.gitignore` only takes effect once
/// it is copied into the library, so a check made before the copy passes and
/// `git add` then drops `scripts/`. The check after the copy refuses, and the
/// library write's rollback leaves the clone as it was.
#[test]
fn promote_refuses_a_skill_whose_own_gitignore_would_leave_part_of_it_out() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let head = crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap();

    let repo = repo_with_both_roots();
    let skill_dir = repo.path().join(CLAUDE_ROOT).join("ship-a-card");
    write(&skill_dir.join(".gitignore"), "scripts/\n");
    write(&skill_dir.join("scripts").join("check.sh"), "#!/bin/sh\necho ok\n");

    let refused = promote(&clone, repo.path(), "ship-a-card", false).expect_err("a half-published skill");
    assert!(refused.contains(".gitignore ignores"), "{refused}");
    assert!(refused.contains("ship-a-card/scripts/check.sh"), "{refused}");
    assert_eq!(crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap(), head);
    let status = crate::git::capture(&clone, &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.trim().is_empty(), "{status}");
    assert!(
        !clone
            .join("library/claude")
            .join(team_skills::PLY_PLUGIN)
            .join("skills/ship-a-card")
            .exists(),
        "the copied skill was left in the clone"
    );
}

#[test]
fn promoting_the_same_skill_again_publishes_nothing_new() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();
    let before = crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap();

    promote(&clone, repo.path(), "ship-a-card", false).expect("idempotent");
    assert_eq!(crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap(), before);
}

/// A teammate's skill of the same name is not collateral damage either, and
/// the refusal must leave the library byte-identical — a half-overwritten
/// plugin would be pushed to everyone.
#[test]
fn promote_refuses_to_overwrite_a_teammates_skill_until_asked() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();

    // The member edits their copy and promotes again: same name, other bytes.
    for root in INSTALL_ROOTS {
        write(
            &repo.path().join(root).join("ship-a-card").join("SKILL.md"),
            "---\nname: ship-a-card\ndescription: How this repo ships a change.\n---\n\nRewritten.\n",
        );
    }
    let head = crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap();
    let refused = promote(&clone, repo.path(), "ship-a-card", false)
        .expect_err("the library already holds a different version");
    assert!(refused.contains("already exists"), "{refused}");
    assert_eq!(crate::git::capture(&clone, &["rev-parse", "HEAD"]).unwrap(), head);
    let status = crate::git::capture(&clone, &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.trim().is_empty(), "rolled back: {status}");
    for dir in team_skills::library_skill_dirs(&clone, team_skills::PLY_PLUGIN, "ship-a-card") {
        assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), SKILL);
    }

    // Asked for, it replaces both halves in one commit.
    promote(&clone, repo.path(), "ship-a-card", true).expect("replace");
    for dir in team_skills::library_skill_dirs(&clone, team_skills::PLY_PLUGIN, "ship-a-card") {
        assert!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap().contains("Rewritten"));
    }
}

/// The contract rung 2 settled, now over a tree: the change is in history, or
/// nothing happened. A publish that fails after the files are written must not
/// leave half a plugin in the clone — a `skills/` directory with no
/// `plugin.json` is not a plugin, and the next write would commit it.
#[test]
fn a_promote_that_fails_leaves_no_half_written_plugin_behind() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    let source = repo.path().join(CLAUDE_ROOT).join("ship-a-card");
    let paths = team_skills::promote_paths(team_skills::PLY_PLUGIN, "ship-a-card").unwrap();

    let error = crate::team::publish_library_paths(
        &clone,
        &paths,
        "skills: share",
        |clone_dir| {
            write_promoted_skill(
                clone_dir,
                team_skills::PLY_PLUGIN,
                "ship-a-card",
                &source,
                false,
            )?;
            // Something the caller does after the copy goes wrong — a slug
            // rule, a teammate's rename, a disk that fills.
            Err("refused after writing".to_string())
        },
        &crate::team::RealLibraryGit,
    )
    .expect_err("the mutation failed");
    assert!(crate::team::library_is_provably_unchanged(&Err(error)));

    let status = crate::git::capture(&clone, &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.trim().is_empty(), "not rolled back: {status}");
    assert!(!team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN).exists());
    assert!(!team_skills::codex_plugin_dir(&clone, team_skills::PLY_PLUGIN).exists());
    assert!(
        !team_skills::codex_marketplace_manifest(&team_skills::codex_library_dir(&clone)).exists()
    );
    assert!(team_skills::read_library(&clone).skills.is_empty());
}

/// A team that hand-authored its own plugin manifest keeps it: Ply adds its
/// skill beside what is there and overwrites neither manifest nor the other
/// plugins a marketplace lists.
#[test]
fn promote_writes_beside_what_the_team_already_authored() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();

    let theirs = r#"{"name":"ply-team","description":"Ours, hand written","version":"4.2.0"}"#;
    write(
        &team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN)
            .join(".claude-plugin")
            .join("plugin.json"),
        theirs,
    );
    write(
        &team_skills::codex_marketplace_manifest(&team_skills::codex_library_dir(&clone)),
        r#"{"name":"mbadv","interface":{"displayName":"MB Adv"},
            "plugins":[{"name":"other","source":{"source":"local","path":"./plugins/other"},
            "policy":{"installation":"AVAILABLE"}}]}"#,
    );

    promote(&clone, repo.path(), "ship-a-card", false).expect("promote");

    assert_eq!(
        std::fs::read_to_string(
            team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN)
                .join(".claude-plugin")
                .join("plugin.json")
        )
        .unwrap(),
        theirs,
        "Plyloft rewrote a manifest the team authored"
    );
    let marketplace: serde_json::Value = serde_json::from_slice(
        &std::fs::read(team_skills::codex_marketplace_manifest(
            &team_skills::codex_library_dir(&clone),
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(marketplace["name"], "mbadv");
    assert_eq!(marketplace["interface"]["displayName"], "MB Adv");
    let names: Vec<&str> = marketplace["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["other", team_skills::PLY_PLUGIN]);
}

/// Install and Promote are the two directions of one move, so the round trip
/// has to land where it started: a skill promoted out of one repo installs
/// into another byte-for-byte.
#[test]
fn a_promoted_skill_installs_into_another_repo_unchanged() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    write(
        &repo.path().join(CLAUDE_ROOT).join("ship-a-card").join("references").join("steps.md"),
        "- one\n- two\n",
    );
    // Keep the two roots in step, or the skill is diverged and not promotable.
    write(
        &repo.path().join(CODEX_ROOT).join("ship-a-card").join("references").join("steps.md"),
        "- one\n- two\n",
    );
    promote(&clone, repo.path(), "ship-a-card", false).expect("promote");

    let theirs = TempDir::new().unwrap();
    let library = team_skills::read_library(&clone);
    let source = install_source(&clone, &library.skills[0]).expect("a source in the library");
    install_into_repo(theirs.path(), "ship-a-card", &source, false).expect("install");

    let found = read_project_skills(theirs.path());
    assert_eq!(found.loaded(), 1);
    assert!(!found.skills[0].diverged);
    assert_eq!(read_tree(&source).unwrap(), read_tree(&repo.path().join(CLAUDE_ROOT).join("ship-a-card")).unwrap());
    for dir in repo_skill_dirs(theirs.path(), "ship-a-card") {
        assert_eq!(read_tree(&dir).unwrap(), read_tree(&source).unwrap());
    }
}

// ── What a copy must preserve, and must not break ───────────────────

/// A skill's helper script has to arrive runnable. The mode is part of the
/// file's identity too, so a destination that differs only in its bit is
/// reported as different rather than as up to date — otherwise the one repair
/// a member could make would be the one Ply refuses to do.
#[test]
#[cfg(unix)]
fn a_copy_keeps_the_executable_bit_and_notices_when_it_changes() {
    use std::os::unix::fs::PermissionsExt;
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    install_into_repo(repo.path(), "ship-a-card", source.path(), false).unwrap();

    for dir in repo_skill_dirs(repo.path(), "ship-a-card") {
        assert!(
            is_executable(&dir.join("scripts").join("check.sh")),
            "{} lost the executable bit",
            dir.display()
        );
        assert!(!is_executable(&dir.join("SKILL.md")), "SKILL.md became executable");
    }
    assert_eq!(
        copy_state(source.path(), &repo_skill_dirs(repo.path(), "ship-a-card")),
        CopyState::Same
    );

    // Strip the bit on one copy: same bytes, different file.
    let victim = repo
        .path()
        .join(CLAUDE_ROOT)
        .join("ship-a-card")
        .join("scripts")
        .join("check.sh");
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        copy_state(source.path(), &repo_skill_dirs(repo.path(), "ship-a-card")),
        CopyState::Differs
    );
    assert!(read_project_skills(repo.path()).skills[0].diverged);
}

/// `.claude/skills` can perfectly well be a symlink — one set of skills shared
/// across checkouts — and joining a name onto it would create, or replace, a
/// directory outside the repository Ply was asked to write into.
#[test]
#[cfg(unix)]
fn install_refuses_a_root_that_resolves_outside_the_workspace() {
    let temp = TempDir::new().unwrap();
    let repo = temp.path().join("repo");
    let elsewhere = temp.path().join("elsewhere");
    std::fs::create_dir_all(repo.join(".claude")).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, repo.join(".claude").join("skills")).unwrap();
    let source = team_skill_source();

    let refused = install_into_repo(&repo, "ship-a-card", source.path(), true)
        .expect_err("a root pointing out of the repo").to_string();
    // Since the review checkpoint a link is refused by name wherever it sits
    // on the path — the message names the link, not where it points.
    assert!(refused.contains("symlink"), "{refused}");
    assert!(refused.contains("not part of this repository"), "{refused}");

    // Nothing was written through the link, and nothing in the other root
    // either: the refusal is decided before the first byte.
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    assert!(!repo.join(CODEX_ROOT).join("ship-a-card").exists());
}

/// The same guard on the way out. The team clone is Ply's own, but the
/// destination names are joined from a manifest, so the containment check is
/// what makes that irrelevant.
#[test]
#[cfg(unix)]
fn promote_refuses_a_library_path_that_resolves_outside_the_clone() {
    let temp = TempDir::new().unwrap();
    let clone = temp.path().join("clone");
    let elsewhere = temp.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let plugin_skills = team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN);
    std::fs::create_dir_all(&plugin_skills).unwrap();
    std::os::unix::fs::symlink(&elsewhere, plugin_skills.join("skills")).unwrap();
    let repo = repo_with_both_roots();

    let refused = write_promoted_skill(
        &clone,
        team_skills::PLY_PLUGIN,
        "ship-a-card",
        &repo.path().join(CLAUDE_ROOT).join("ship-a-card"),
        true,
    )
    .expect_err("a library path pointing out of the clone").to_string();
    assert!(refused.contains("symlink"), "{refused}");
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    // And the refusal came before anything was written: no manifests, so the
    // library is not left holding a plugin nobody shared a skill with.
    assert!(!team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN)
        .join(".claude-plugin")
        .exists());
    assert!(!team_skills::codex_plugin_dir(&clone, team_skills::PLY_PLUGIN).exists());
}

/// **All destinations, or none.** A Replace that fails on the second root must
/// not leave the first one new and the second one old — that is exactly the
/// `diverged` fault this panel reports — and it must not have destroyed the
/// copy it was replacing, which may hold uncommitted work.
#[test]
#[cfg(unix)]
fn a_replace_that_fails_part_way_puts_everything_back() {
    use std::os::unix::fs::PermissionsExt;
    let repo = TempDir::new().unwrap();
    let mine = "---\ndescription: Mine.\n---\n\nUncommitted work.\n";
    for root in INSTALL_ROOTS {
        write(&repo.path().join(root).join("ship-a-card").join("SKILL.md"), mine);
    }
    let source = team_skill_source();

    // Make the second root unwritable, so staging into it fails after the
    // first root has already been staged.
    let blocked = repo.path().join(CODEX_ROOT);
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let failed = install_into_repo(repo.path(), "ship-a-card", source.path(), true)
        .expect_err("the second root cannot be written").to_string();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.contains("ship-a-card"), "{failed}");

    // Both roots still hold the member's own skill, untouched…
    for root in INSTALL_ROOTS {
        let file = repo.path().join(root).join("ship-a-card").join("SKILL.md");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), mine, "{root}");
    }
    // …and nothing was left lying around that could read as a second skill.
    for root in INSTALL_ROOTS {
        let names: Vec<String> = std::fs::read_dir(repo.path().join(root))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["ship-a-card".to_string()], "{root}: {names:?}");
    }
    assert_eq!(read_project_skills(repo.path()).skills.len(), 1);
}

/// **A badge, not a directory listing, picks the source.** A `library/claude`
/// copy whose `SKILL.md` lost its description leaves the row badged Codex
/// only; copying that directory because it happens to exist would install
/// into the member's repo a file neither CLI reads.
#[test]
fn install_reads_the_library_half_the_badges_vouch_for() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();

    // Break the Claude half only.
    let claude = team_skills::plugin_skill_dir(
        &team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN),
        "ship-a-card",
    );
    write(&claude.join("SKILL.md"), "---\nname: ship-a-card\n---\n\nNo description.\n");

    let library = team_skills::read_library(&clone);
    let row = &library.skills[0];
    assert!(!row.claude && row.codex, "the row must be badged Codex only");
    let source = install_source(&clone, row).expect("the half that still loads");
    assert!(source.starts_with(team_skills::codex_plugin_dir(&clone, team_skills::PLY_PLUGIN)));

    let theirs = TempDir::new().unwrap();
    install_into_repo(theirs.path(), "ship-a-card", &source, false).unwrap();
    // What landed is a skill both CLIs load, not the broken half.
    assert_eq!(read_project_skills(theirs.path()).loaded(), 1);

    // And when neither half loads any more, there is nothing to install
    // rather than something to install badly.
    let codex = team_skills::plugin_skill_dir(
        &team_skills::codex_plugin_dir(&clone, team_skills::PLY_PLUGIN),
        "ship-a-card",
    );
    write(&codex.join("SKILL.md"), "---\nname: ship-a-card\n---\n");
    let library = team_skills::read_library(&clone);
    assert!(library.skills.is_empty(), "{:?}", library.skills);
    assert!(install_source(&clone, row).is_none());
}

/// **Nothing is deleted for being in the way** — the rule rung 3 wrote down
/// about crashed Codex overlays, applied to a crashed copy. The displaced
/// skill a previous copy left behind may be the only surviving copy of that
/// work, so a predictable staging path that the next copy clears would be a
/// silent loss.
#[test]
fn a_copy_never_removes_what_an_earlier_crashed_copy_left_behind() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    // The member's own copy, so the Replace below really rewrites both roots
    // and really needs somewhere to stage.
    for root in INSTALL_ROOTS {
        write(
            &repo.path().join(root).join("ship-a-card").join("SKILL.md"),
            "---\ndescription: Mine.\n---\n",
        );
    }

    // What a copy killed between its two renames leaves behind: a displaced
    // skill, dot-named, holding work nobody else has. These are the exact
    // names the first cut of this code used and cleared on sight, which is
    // what makes this a regression test rather than a restatement.
    let work = "---\ndescription: Unpushed work.\n---\n";
    let mut rescued: Vec<PathBuf> = Vec::new();
    for root in INSTALL_ROOTS {
        for name in [".ship-a-card.ply-old", ".ship-a-card.ply-new"] {
            rescued.push(repo.path().join(root).join(name));
        }
    }
    for dir in &rescued {
        write(&dir.join("SKILL.md"), work);
    }

    install_into_repo(repo.path(), "ship-a-card", source.path(), true).unwrap();

    for dir in &rescued {
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            work,
            "{} was cleared out of the way",
            dir.display()
        );
    }

    // They are not skills to anyone: dot directories are skipped by Ply's
    // reader and by both CLIs' plugin readers.
    let found = read_project_skills(repo.path());
    assert_eq!(found.skills.len(), 1);
    assert_eq!(found.skills[0].name, "ship-a-card");
    assert!(found.unloadable.is_empty());
}

/// A successful copy still cleans up after *itself*: what it displaced is
/// gone once both destinations are in place, so the ordinary case does not
/// litter the repo.
#[test]
fn a_copy_that_succeeds_leaves_nothing_of_its_own_behind() {
    let repo = TempDir::new().unwrap();
    let source = team_skill_source();
    write(
        &repo.path().join(CLAUDE_ROOT).join("ship-a-card").join("SKILL.md"),
        "---\ndescription: Mine.\n---\n",
    );
    install_into_repo(repo.path(), "ship-a-card", source.path(), true).unwrap();

    for root in INSTALL_ROOTS {
        let names: Vec<String> = std::fs::read_dir(repo.path().join(root))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["ship-a-card".to_string()], "{root}: {names:?}");
    }
}

// ── Remove from team ────────────────────────────────────────────────
//
// Found on the rung 3+4 walk: two smoke skills promoted to prove both
// directions then loaded in every session for every member, and retiring them
// took a hand-made commit in the clone. Against real git and a bare remote for
// the reason Promote's tests are: what matters is what a teammate pulls.

/// Retire one skill the way the command does: the halves there now, removed
/// in a single library write.
fn remove(clone: &Path, plugin: &str, skill: &str) -> Result<crate::team::LibraryOutcome, String> {
    let paths = team_skills::remove_paths(clone, plugin, skill)?;
    crate::team::publish_library_paths(
        clone,
        &paths,
        &format!("skills: retire \"{plugin}:{skill}\" from the team library"),
        |clone_dir| team_skills::remove_library_skill(clone_dir, plugin, skill, &paths),
        &crate::team::RealLibraryGit,
    )
    .map_err(|error| error.message())
}

fn head(clone: &Path) -> String {
    crate::git::capture(clone, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
}

fn assert_clean(clone: &Path) {
    let status = crate::git::capture(clone, &["status", "--porcelain", "-uall"]).unwrap();
    assert!(status.trim().is_empty(), "{status}");
}

#[test]
fn remove_retires_both_halves_in_one_pushed_commit_and_leaves_installed_copies() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    for root in INSTALL_ROOTS {
        write(
            &repo.path().join(root).join("keep-me").join("SKILL.md"),
            "---\ndescription: A skill the team keeps.\n---\n",
        );
    }
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();
    promote(&clone, repo.path(), "keep-me", false).unwrap();

    // A member installed it into their repo before it was retired.
    let member = TempDir::new().unwrap();
    let library = team_skills::read_library(&clone);
    let entry = library.skills.iter().find(|s| s.name == "ship-a-card").unwrap();
    install_into_repo(member.path(), "ship-a-card", &install_source(&clone, entry).unwrap(), false)
        .unwrap();

    let before = head(&clone);
    let outcome = remove(&clone, team_skills::PLY_PLUGIN, "ship-a-card").expect("remove");
    assert!(outcome.committed && outcome.pushed, "{outcome:?}");

    // Exactly one commit, deleting the two halves and nothing else.
    let log = crate::git::capture(&clone, &["log", "--format=%s", &format!("{before}..HEAD")])
        .unwrap();
    assert_eq!(log.lines().count(), 1, "{log}");
    assert!(log.contains("retire \"ply-team:ship-a-card\""), "{log}");
    let changed =
        crate::git::capture(&clone, &["show", "--name-status", "--format=", "HEAD"]).unwrap();
    assert!(changed.lines().all(|line| line.starts_with('D')), "{changed}");
    assert!(changed.contains("library/claude/ply-team/skills/ship-a-card/SKILL.md"), "{changed}");
    assert!(
        changed.contains("library/codex/plugins/ply-team/skills/ship-a-card/SKILL.md"),
        "{changed}"
    );
    assert_clean(&clone);

    // What a teammate pulls: the skill gone from both halves, the other one
    // and both manifests untouched.
    let remote =
        crate::git::capture(&clone, &["ls-tree", "-r", "--name-only", "origin/main"]).unwrap();
    assert!(!remote.contains("ship-a-card"), "{remote}");
    assert!(remote.contains("library/claude/ply-team/skills/keep-me/SKILL.md"), "{remote}");
    assert!(remote.contains("library/codex/.agents/plugins/marketplace.json"), "{remote}");
    let library = team_skills::read_library(&clone);
    assert!(library.errors.is_empty(), "{:?}", library.errors);
    let names: Vec<&str> = library.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["keep-me"]);
    assert!(library.skills[0].both_vendors());

    // The member's copies are theirs.
    for dir in repo_skill_dirs(member.path(), "ship-a-card") {
        assert!(dir.join("SKILL.md").is_file(), "{} was removed", dir.display());
    }
}

/// Retiring the last skill leaves no empty `skills/` directory behind — git
/// does not track one, so it would sit in every clone looking like half a
/// plugin — and keeps the plugin itself for the next Promote.
#[test]
fn removing_the_last_skill_prunes_empty_directories_and_keeps_the_plugin() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();

    remove(&clone, team_skills::PLY_PLUGIN, "ship-a-card").expect("remove");

    let claude = team_skills::claude_plugin_dir(&clone, team_skills::PLY_PLUGIN);
    let codex = team_skills::codex_plugin_dir(&clone, team_skills::PLY_PLUGIN);
    assert!(!claude.join("skills").exists());
    assert!(!codex.join("skills").exists());
    assert!(claude.join(".claude-plugin/plugin.json").is_file());
    assert!(codex.join(".codex-plugin/plugin.json").is_file());
    let library = team_skills::read_library(&clone);
    assert!(library.skills.is_empty(), "{:?}", library.skills);
    assert!(library.errors.is_empty(), "{:?}", library.errors);
    assert_clean(&clone);

    // And the plugin still takes a Promote afterwards.
    promote(&clone, repo.path(), "ship-a-card", false).expect("promote again");
    assert!(team_skills::read_library(&clone).skills[0].both_vendors());
}

/// A skill that reached one half only is the state rung 3's badges report;
/// retiring it must work from that half, without naming the other to git.
#[test]
fn a_one_sided_skill_is_removed_from_the_half_that_has_it() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();
    git(&clone, &["rm", "-rq", "library/codex/plugins/ply-team/skills/ship-a-card"]);
    git(&clone, &["commit", "-m", "one half only"]);
    git(&clone, &["push"]);

    let paths = team_skills::remove_paths(&clone, team_skills::PLY_PLUGIN, "ship-a-card").unwrap();
    assert_eq!(paths, vec!["library/claude/ply-team/skills/ship-a-card".to_string()]);
    remove(&clone, team_skills::PLY_PLUGIN, "ship-a-card").expect("remove");
    assert!(team_skills::read_library(&clone).skills.is_empty());
    assert_clean(&clone);
}

#[test]
fn removing_what_is_not_there_is_refused_before_anything_runs() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let refused = team_skills::remove_paths(&clone, team_skills::PLY_PLUGIN, "never-shared")
        .expect_err("nothing to remove");
    assert!(refused.contains("not in the team library"), "{refused}");
    for (plugin, skill) in [("ply-team", "../team"), ("..", "x"), ("ply-team", ".hidden")] {
        assert!(team_skills::remove_paths(&clone, plugin, skill).is_err(), "{plugin}:{skill}");
    }
}

/// Rung 2's contract, for a removal: in history, or nothing happened. A failure
/// after both halves are deleted puts both back byte for byte.
#[test]
fn a_removal_that_fails_after_deleting_puts_both_halves_back() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();
    let before = head(&clone);
    let paths = team_skills::remove_paths(&clone, team_skills::PLY_PLUGIN, "ship-a-card").unwrap();

    let error = crate::team::publish_library_paths(
        &clone,
        &paths,
        "skills: retire",
        |clone_dir| {
            team_skills::remove_library_skill(clone_dir, team_skills::PLY_PLUGIN, "ship-a-card", &paths)?;
            Err("refused after removing".to_string())
        },
        &crate::team::RealLibraryGit,
    )
    .expect_err("the mutation failed");
    assert!(crate::team::library_is_provably_unchanged(&Err(error)));

    assert_eq!(head(&clone), before);
    assert_clean(&clone);
    for dir in team_skills::library_skill_dirs(&clone, team_skills::PLY_PLUGIN, "ship-a-card") {
        assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), SKILL);
    }
    assert!(team_skills::read_library(&clone).skills[0].both_vendors());
}

/// A Claude plugin is whoever its manifest says it is. A hand-authored one
/// whose directory is not named after it is still found, by that identity,
/// and both halves go.
#[test]
fn a_hand_named_claude_plugin_is_removed_by_its_manifest_identity() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();
    git(&clone, &["mv", "library/claude/ply-team", "library/claude/hand-named"]);
    git(&clone, &["commit", "-m", "a plugin directory named by hand"]);
    git(&clone, &["push"]);
    assert!(team_skills::read_library(&clone).skills[0].both_vendors());

    let paths = team_skills::remove_paths(&clone, team_skills::PLY_PLUGIN, "ship-a-card").unwrap();
    assert_eq!(
        paths,
        vec![
            "library/claude/hand-named/skills/ship-a-card".to_string(),
            "library/codex/plugins/ply-team/skills/ship-a-card".to_string(),
        ]
    );
    remove(&clone, team_skills::PLY_PLUGIN, "ship-a-card").expect("remove");
    assert!(team_skills::read_library(&clone).skills.is_empty());
    assert_clean(&clone);
}

/// Challenger's P1 on snapshot 1: `library/claude/alpha/` declaring plugin
/// `beta`, and a Codex-only `alpha`. Retiring `alpha:review` by joining the
/// name onto a path deleted `beta:review` and pushed it. It must remove the
/// Codex half only and leave `beta:review` loading.
#[test]
fn removing_a_skill_never_touches_another_plugin_that_shares_its_directory_name() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let claude_alpha = team_skills::claude_plugin_dir(&clone, "alpha");
    write(
        &claude_alpha.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"beta","version":"1.0.0"}"#,
    );
    write(
        &claude_alpha.join("skills").join("review").join("SKILL.md"),
        "---\ndescription: Beta's review.\n---\n",
    );
    // Codex-only `alpha`: its manifest and marketplace entry, and the skill.
    // `ensure_ply_plugin` keeps the Claude manifest above as it is.
    team_skills::ensure_ply_plugin(&clone, "alpha").unwrap();
    write(
        &team_skills::codex_plugin_dir(&clone, "alpha").join("skills").join("review").join("SKILL.md"),
        "---\ndescription: Alpha's review.\n---\n",
    );
    git(&clone, &["add", "-A"]);
    git(&clone, &["commit", "-m", "two plugins, one directory name"]);
    git(&clone, &["push"]);
    let rows: Vec<(String, bool, bool)> = team_skills::read_library(&clone)
        .skills
        .iter()
        .map(|s| (s.qualified_name(), s.claude, s.codex))
        .collect();
    assert_eq!(
        rows,
        vec![("alpha:review".to_string(), false, true), ("beta:review".to_string(), true, false)]
    );

    let paths = team_skills::remove_paths(&clone, "alpha", "review").unwrap();
    assert_eq!(paths, vec!["library/codex/plugins/alpha/skills/review".to_string()]);
    remove(&clone, "alpha", "review").expect("remove");

    let library = team_skills::read_library(&clone);
    let names: Vec<String> = library.skills.iter().map(|s| s.qualified_name()).collect();
    assert_eq!(names, vec!["beta:review".to_string()]);
    let remote =
        crate::git::capture(&clone, &["ls-tree", "-r", "--name-only", "origin/main"]).unwrap();
    assert!(remote.contains("library/claude/alpha/skills/review/SKILL.md"), "{remote}");
    assert!(!remote.contains("library/codex/plugins/alpha/skills/review"), "{remote}");
    assert_clean(&clone);
}

/// The reader follows a symlinked plugin directory, so a removal resolved
/// through one would delete outside the team clone. Refused before anything
/// is touched.
#[cfg(unix)]
#[test]
fn a_removal_through_a_symlinked_plugin_is_refused() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let outside = tmp.path().join("outside");
    write(
        &outside.join(".claude-plugin").join("plugin.json"),
        r#"{"name":"linked","version":"1.0.0"}"#,
    );
    write(
        &outside.join("skills").join("x").join("SKILL.md"),
        "---\ndescription: Lives outside the clone.\n---\n",
    );
    std::os::unix::fs::symlink(&outside, team_skills::claude_plugin_dir(&clone, "linked")).unwrap();
    assert_eq!(team_skills::read_library(&clone).skills.len(), 1);

    let refused = team_skills::remove_paths(&clone, "linked", "x").expect_err("a symlink");
    assert!(refused.contains("symlink"), "{refused}");
    assert!(outside.join("skills/x/SKILL.md").is_file());
}

/// Paths resolved before the pull can miss a copy a teammate added meanwhile.
/// Removing some halves while another still holds the skill is refused before
/// anything is deleted, rather than reported done.
#[test]
fn a_skill_that_would_still_load_is_not_reported_removed() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let repo = repo_with_both_roots();
    promote(&clone, repo.path(), "ship-a-card", false).unwrap();
    let before = head(&clone);
    // Only the Codex half, as if the Claude copy had arrived with the pull.
    let paths = vec!["library/codex/plugins/ply-team/skills/ship-a-card".to_string()];

    let refused = crate::team::publish_library_paths(
        &clone,
        &paths,
        "skills: retire",
        |clone_dir| {
            team_skills::remove_library_skill(clone_dir, team_skills::PLY_PLUGIN, "ship-a-card", &paths)
        },
        &crate::team::RealLibraryGit,
    )
    .map_err(|error| error.message())
    .expect_err("still loads");
    assert!(refused.contains("changed in the team library"), "{refused}");
    assert!(refused.contains("left unchanged"), "{refused}");
    assert_eq!(head(&clone), before);
    assert_clean(&clone);
    assert!(team_skills::read_library(&clone).skills[0].both_vendors());
}

/// Challenger's P1 on snapshot 2: the paths are chosen, then the publish
/// pulls, and a teammate's pushed manifest rename arrives in that pull —
/// `library/claude/alpha/` is plugin `beta` now. Deleting the planned path
/// would retire `beta:review` and push it; the post-pull re-resolution
/// refuses before anything is deleted.
#[test]
fn a_manifest_rename_arriving_with_the_pull_stops_the_removal() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let alpha = team_skills::claude_plugin_dir(&clone, "alpha");
    write(&alpha.join(".claude-plugin").join("plugin.json"), r#"{"name":"alpha"}"#);
    write(
        &alpha.join("skills").join("review").join("SKILL.md"),
        "---\ndescription: Alpha's review.\n---\n",
    );
    git(&clone, &["add", "-A"]);
    git(&clone, &["commit", "-m", "alpha"]);
    git(&clone, &["push"]);

    // Chosen against the clone as it is: alpha's directory.
    let paths = team_skills::remove_paths(&clone, "alpha", "review").unwrap();
    assert_eq!(paths, vec!["library/claude/alpha/skills/review".to_string()]);

    // A teammate renames the plugin and pushes before the member's publish.
    let mate = tmp.path().join("mate");
    git(
        tmp.path(),
        &["clone", &tmp.path().join("origin.git").to_string_lossy(), &mate.to_string_lossy()],
    );
    write(
        &mate.join("library/claude/alpha/.claude-plugin/plugin.json"),
        r#"{"name":"beta"}"#,
    );
    git(&mate, &["commit", "-am", "alpha is beta now"]);
    git(&mate, &["push"]);

    let refused = crate::team::publish_library_paths(
        &clone,
        &paths,
        "skills: retire",
        |clone_dir| team_skills::remove_library_skill(clone_dir, "alpha", "review", &paths),
        &crate::team::RealLibraryGit,
    )
    .map_err(|error| error.message())
    .expect_err("the planned directory belongs to beta now");
    assert!(refused.contains("not in the team library any more"), "{refused}");

    // The pull landed; nothing of beta's was touched, locally or on GitHub.
    assert_clean(&clone);
    let names: Vec<String> = team_skills::read_library(&clone)
        .skills
        .iter()
        .map(|s| s.qualified_name())
        .collect();
    assert_eq!(names, vec!["beta:review".to_string()]);
    let remote =
        crate::git::capture(&clone, &["ls-tree", "-r", "--name-only", "origin/main"]).unwrap();
    assert!(remote.contains("library/claude/alpha/skills/review/SKILL.md"), "{remote}");
}

/// A team library whose Claude plugin `beta` lives in `library/claude/alpha-dir`
/// (a plugin is whoever its manifest says), with its Codex half listed as
/// `beta` in the marketplace — one skill, `ship-a-card`, in both.
fn library_with_plugin_named_apart_from_its_dir(clone: &Path, source: &Path) {
    let claude = team_skills::claude_library_dir(clone).join("alpha-dir");
    write(
        &claude.join(".claude-plugin/plugin.json"),
        r#"{ "name": "beta", "version": "1.0.0" }"#,
    );
    let codex = team_skills::codex_plugin_dir(clone, "beta");
    write(
        &codex.join(".codex-plugin/plugin.json"),
        r#"{ "name": "beta", "version": "1.0.0" }"#,
    );
    write(
        &team_skills::codex_marketplace_manifest(&team_skills::codex_library_dir(clone)),
        r#"{ "name": "team-market", "plugins": [{ "name": "beta" }] }"#,
    );
    for plugin_dir in [claude, codex] {
        for file in read_tree(source).unwrap() {
            let path = plugin_dir.join("skills/ship-a-card").join(&file.path);
            write(&path, &String::from_utf8_lossy(&file.bytes));
            if file.executable {
                make_executable(&path);
            }
        }
    }
}

/// Install and the team row's copy state read the directory the reader read,
/// not one joined onto the plugin's name.
#[test]
fn install_reads_a_plugin_from_the_directory_its_manifest_names() {
    let clone = TempDir::new().unwrap();
    let source = team_skill_source();
    library_with_plugin_named_apart_from_its_dir(clone.path(), source.path());
    let library = team_skills::read_library(clone.path());
    let row = library
        .skills
        .iter()
        .find(|s| s.plugin == "beta" && s.name == "ship-a-card")
        .expect("the reader lists beta:ship-a-card");
    assert!(row.claude && row.codex, "{row:?}");

    let dirs = team_skills::library_skill_dirs(clone.path(), "beta", "ship-a-card");
    assert!(dirs[0].starts_with(team_skills::claude_library_dir(clone.path()).join("alpha-dir")), "{dirs:?}");
    let from = install_source(clone.path(), row).expect("a half to install from");
    assert!(from.starts_with(team_skills::claude_library_dir(clone.path()).join("alpha-dir")), "{from:?}");

    let repo = TempDir::new().unwrap();
    let view = |repo: &Path| {
        build_view("ws", "repo", repo, Some((clone.path(), &library)), false, None, None).team
    };
    assert_eq!(view(repo.path())[0].repo, CopyState::Absent);
    let outcome = install_into_repo(repo.path(), "ship-a-card", &from, false).unwrap();
    assert_eq!(outcome.written.len(), 2);
    assert_eq!(view(repo.path())[0].repo, CopyState::Same);
}

/// Promote stages the paths the plugin's name puts it at; a plugin of that
/// name in another directory is refused rather than written where the commit
/// does not look.
#[test]
fn promote_refuses_a_plugin_that_lives_apart_from_its_name() {
    let clone = TempDir::new().unwrap();
    write(
        &team_skills::claude_library_dir(clone.path()).join("elsewhere/.claude-plugin/plugin.json"),
        &format!(r#"{{ "name": "{}", "version": "1.0.0" }}"#, team_skills::PLY_PLUGIN),
    );
    let source = team_skill_source();
    let refused = write_promoted_skill(clone.path(), team_skills::PLY_PLUGIN, "ship-a-card", source.path(), false)
        .expect_err("the plugin is not where its name puts it")
        .to_string();
    assert!(refused.contains("Nothing was shared"), "{refused}");
    assert!(refused.contains("elsewhere"), "{refused}");
    assert!(!team_skills::claude_plugin_dir(clone.path(), team_skills::PLY_PLUGIN).exists());
    assert!(!team_skills::claude_library_dir(clone.path()).join("elsewhere/skills").exists());
}

/// Decision §6: two copies are "the same" over their whole tree, not just
/// `SKILL.md`; a repository copy in two roots is one copy only while they agree.
#[test]
fn tree_digest_names_whole_identical_trees_only() {
    let dir = TempDir::new().unwrap();
    let a = dir.path().join("a/ship-a-card");
    let b = dir.path().join("b/ship-a-card");
    for root in [&a, &b] {
        write(&root.join("SKILL.md"), SKILL);
        write(&root.join("scripts/check.sh"), "echo ok\n");
    }
    let da = tree_digest(&[a.clone()]).unwrap();
    assert_eq!(Some(da.clone()), tree_digest(&[b.clone()]));
    // One copy in two directories that agree is still that copy.
    assert_eq!(Some(da.clone()), tree_digest(&[a.clone(), b.clone()]));

    // A helper file changes, SKILL.md does not: no longer identical.
    write(&b.join("scripts/check.sh"), "echo changed\n");
    let db = tree_digest(&[b.clone()]).unwrap();
    assert_ne!(da, db);
    // Two directories of one copy that disagree have no name at all.
    assert_eq!(tree_digest(&[a.clone(), b.clone()]), None);
    // A directory that is not there is never called identical.
    assert_eq!(tree_digest(&[dir.path().join("missing")]), None);
    assert_eq!(tree_digest(&[]), None);
}

// ── New skill (group B decision §3) ─────────────────────────────────

/// A new skill in a repository whose branch carries nothing.
fn create_new_skill_here(cwd: &Path, name: &str, description: &str) -> Result<CreatedSkill, String> {
    create_new_skill(cwd, name, description, &[])
}

fn git_repo() -> TempDir {
    let repo = TempDir::new().unwrap();
    crate::git::run(repo.path(), &["init", "-q"]).unwrap();
    repo
}

#[test]
fn a_new_skill_name_is_lowercase_letters_digits_and_hyphens() {
    for good in ["deploy", "ship-a-card", "v2-notes", "a", "0day"] {
        assert_eq!(new_skill_name_problem(good), None, "{good}");
    }
    for bad in [
        "", "Deploy", "ship_a_card", "ship a card", "-deploy", "deploy-", "ship--card",
        "../x", "x/y", "x\\y", ".hidden", "déploy",
    ] {
        assert!(new_skill_name_problem(bad).is_some(), "{bad:?} must be refused");
    }
    assert!(new_skill_name_problem(&"a".repeat(NEW_SKILL_NAME_MAX)).is_none());
    assert!(new_skill_name_problem(&"a".repeat(NEW_SKILL_NAME_MAX + 1)).is_some());
}

#[test]
fn a_new_skill_is_written_for_both_clis_with_the_same_text() {
    let repo = git_repo();
    let created = create_new_skill_here(
        repo.path(),
        "ship-a-card",
        "Use when shipping a change from a card.",
    )
    .unwrap();
    let claude = under(repo.path(), CLAUDE_ROOT).join("ship-a-card").join("SKILL.md");
    let codex = under(repo.path(), CODEX_ROOT).join("ship-a-card").join("SKILL.md");
    assert_eq!(created.claude_file, claude.to_string_lossy());
    assert_eq!(created.codex_file, codex.to_string_lossy());
    let text = std::fs::read_to_string(&claude).unwrap();
    assert_eq!(text, std::fs::read_to_string(&codex).unwrap());
    assert!(text.starts_with(
        "---\nname: \"ship-a-card\"\ndescription: \"Use when shipping a change from a card.\"\n---\n"
    ));
    // Both CLIs load it, as one skill in both roots, the same bytes.
    let found = read_project_skills(repo.path());
    let skill = found.skills.iter().find(|s| s.name == "ship-a-card").unwrap();
    assert!(skill.claude && skill.codex && !skill.diverged, "{skill:?}");
    assert_eq!(skill.description, "Use when shipping a change from a card.");
    // No temp file left behind (atomic write).
    for dir in repo_skill_dirs(repo.path(), "ship-a-card") {
        let names: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("SKILL.md")]);
    }
}

#[test]
fn a_description_yaml_would_misread_is_quoted() {
    let repo = git_repo();
    let description = r#"Use when: the "deploy" script fails"#;
    create_new_skill_here(repo.path(), "fix-deploy", description).unwrap();
    let found = read_project_skills(repo.path());
    let skill = found.skills.iter().find(|s| s.name == "fix-deploy").unwrap();
    assert!(skill.claude && skill.codex);
    let text = new_skill_text("fix-deploy", description);
    assert!(text.contains(r#"description: "Use when: the \"deploy\" script fails""#), "{text}");
}

/// L4: whatever was typed, a YAML reader gets exactly that string back — never
/// a null, a boolean, a number, a comment or a key.
#[test]
fn the_new_skill_frontmatter_round_trips_through_yaml() {
    for description in [
        "null", "true", "yes", "~", "123", "x\t# y", "x:\ty", "a: b", "- dash", "# hash",
        r#"back\slash and "quotes""#, "line\u{2028}sep", "next\u{85}line", "para\u{2029}graph",
        "bell\u{7}", "'single'", "{flow}", "Use when…",
    ] {
        for name in ["deploy", "123", "null", "true"] {
            let text = new_skill_text(name, description);
            let front = text
                .strip_prefix("---\n")
                .and_then(|rest| rest.split_once("\n---\n"))
                .map(|(head, _)| head)
                .unwrap();
            // One line per key: nothing typed can break the block.
            assert_eq!(front.lines().count(), 2, "{front:?}");
            let parsed: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(front)
                .unwrap_or_else(|error| panic!("{front:?}: {error}"));
            assert_eq!(
                parsed.get("description").and_then(|v| v.as_str()),
                Some(description),
                "{front:?}"
            );
            assert_eq!(parsed.get("name").and_then(|v| v.as_str()), Some(name), "{front:?}");
        }
    }
}

/// L5: Windows device names are refused everywhere, in any case.
#[test]
fn windows_device_names_are_not_skill_names() {
    for reserved in ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"] {
        assert!(windows_reserved(reserved), "{reserved}");
        assert!(windows_reserved(&reserved.to_uppercase()), "{reserved}");
        assert!(new_skill_name_problem(reserved).is_some(), "{reserved}");
    }
    for fine in ["com", "com0", "com10", "lpt", "console", "nul-check", "auxiliary"] {
        assert!(!windows_reserved(fine), "{fine}");
    }
}

#[test]
fn a_new_skill_is_refused_where_it_cannot_be_shipped_or_would_collide() {
    // Not a repository.
    let plain = TempDir::new().unwrap();
    let error = create_new_skill_here(plain.path(), "deploy", "Use when deploying.").unwrap_err();
    assert!(error.contains("not a git repository"), "{error}");
    assert!(!plain.path().join(CLAUDE_ROOT).exists());

    // A bad name, a missing or multi-line description.
    let repo = git_repo();
    assert!(create_new_skill_here(repo.path(), "Deploy", "Use when deploying.").is_err());
    assert!(create_new_skill_here(repo.path(), "deploy", "  ").is_err());
    assert!(create_new_skill_here(repo.path(), "deploy", "Use when\ndeploying.").is_err());

    // Taken in any root either CLI reads — the legacy Codex root included.
    write(&repo.path().join(LEGACY_CODEX_ROOT).join("deploy").join("SKILL.md"), SKILL);
    let error = create_new_skill_here(repo.path(), "deploy", "Use when deploying.").unwrap_err();
    assert!(error.contains(".codex/skills"), "{error}");
    assert!(!repo.path().join(CLAUDE_ROOT).join("deploy").exists());

    // A name the integration branch carries (L6).
    let error = create_new_skill(repo.path(), "shipped", "Use when shipping.", &["shipped".into()])
        .unwrap_err();
    assert!(error.contains("integration branch already carries"), "{error}");
    assert!(!repo.path().join(CLAUDE_ROOT).join("shipped").exists());

    // A root git ignores: nothing written, and the way out named.
    std::fs::write(repo.path().join(".gitignore"), ".agents/\n").unwrap();
    let error = create_new_skill_here(repo.path(), "release", "Use when releasing.").unwrap_err();
    assert!(error.contains(".agents/skills") && error.contains("Un-ignore"), "{error}");
    assert!(!repo.path().join(CLAUDE_ROOT).join("release").exists());
    assert!(!repo.path().join(CODEX_ROOT).join("release").exists());
}

#[cfg(unix)]
#[test]
fn a_read_only_checkout_is_refused_and_left_as_it_was() {
    use std::os::unix::fs::PermissionsExt;
    let repo = git_repo();
    std::fs::create_dir_all(repo.path().join(".claude")).unwrap();
    std::fs::create_dir_all(repo.path().join(".agents")).unwrap();
    let locked = repo.path().join(".agents");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = create_new_skill_here(repo.path(), "deploy", "Use when deploying.");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = result.unwrap_err();
    assert!(error.contains("read-only"), "{error}");
    // The Claude copy written first was taken back.
    assert!(!repo.path().join(CLAUDE_ROOT).join("deploy").exists());
    // …and the `.claude/skills` it created for it, now empty (L5); `.claude`
    // was there before and stays.
    assert!(!repo.path().join(CLAUDE_ROOT).exists());
    assert!(repo.path().join(".claude").is_dir());
}

/// L9: a digest only for directories inside the places skills are listed from.
#[test]
fn tree_digests_are_only_given_inside_the_skill_roots() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("repo/.claude/skills");
    let inside = root.join("deploy");
    let outside = dir.path().join("elsewhere/deploy");
    for skill in [&inside, &outside] {
        write(&skill.join("SKILL.md"), SKILL);
    }
    let allowed = vec![root.clone()];
    let digests = tree_digests_within(
        &[
            vec![inside.clone()],
            vec![outside.clone()],
            vec![inside.clone(), outside.clone()],
            // `..` cannot step out of an allowed root.
            vec![root.join("..").join("..").join("..").join("elsewhere/deploy")],
            // Nor is the root itself a skill.
            vec![root.clone()],
        ],
        &allowed,
    );
    assert_eq!(digests[0], tree_digest(&[inside]));
    assert!(digests[0].is_some());
    assert_eq!(&digests[1..], &[None, None, None, None]);
}

/// Windows walk 2026-09-30: a root is joined one component at a time, so a
/// path has one separator throughout (no `\\.claude/skills\\` on Windows).
#[test]
fn roots_are_joined_with_the_platforms_own_separator() {
    let cwd = Path::new("base");
    let joined = under(cwd, ".claude/skills");
    assert_eq!(joined, Path::new("base").join(".claude").join("skills"));
    assert_eq!(repo_skill_dirs(cwd, "x")[1], Path::new("base").join(".agents").join("skills").join("x"));
    if cfg!(windows) {
        assert!(!joined.to_string_lossy().contains('/'));
    }
}

// ── N14 item 2: Promote reads the branch's aligned copy ────────────────

/// A project repo on `main` with `ship-a-card` committed in both roots.
fn committed_repo() -> TempDir {
    let repo = repo_with_both_roots();
    git(repo.path(), &["init", "-q", "--initial-branch=main", "."]);
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-q", "-m", "skills"]);
    repo
}

/// Every file under `dir` but `.git`, with its bytes.
fn checkout_bytes(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn plumbing(dir: &Path) -> crate::shared_config::Plumbing {
    crate::shared_config::Plumbing { cwd: dir.to_path_buf() }
}

const EDITED: &str = "---\nname: ship-a-card\ndescription: How this repo ships a change.\n---\n\nA local edit.\n";

/// The walk's F4 case: the checkout's Claude and Codex copies differ, the
/// branch's are aligned. Promote reads the branch's, says the local change is
/// left out, and the checkout is byte for byte what it was.
#[test]
fn promote_reads_the_branchs_aligned_copy_when_the_checkouts_two_differ() {
    let repo = committed_repo();
    write(&repo.path().join(CODEX_ROOT).join("ship-a-card").join("SKILL.md"), EDITED);
    assert!(read_project_skills(repo.path()).skills[0].diverged);
    let before = checkout_bytes(repo.path());
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    assert!(branch.tip.is_some());

    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").expect("promotable");
    assert_eq!(std::fs::read_to_string(source.dir.join("SKILL.md")).unwrap(), SKILL);
    assert!(source.local_changes_left_out);
    assert_eq!(checkout_bytes(repo.path()), before, "the checkout is never written");

    // And it really goes into the team library from there.
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let paths = team_skills::promote_paths(team_skills::PLY_PLUGIN, "ship-a-card").unwrap();
    crate::team::publish_library_paths(
        &clone,
        &paths,
        "skills: share",
        |clone_dir| {
            write_promoted_skill(clone_dir, team_skills::PLY_PLUGIN, "ship-a-card", &source.dir, false)
                .map(|_| ())
                .map_err(String::from)
        },
        &crate::team::RealLibraryGit,
    )
    .map_err(|e| e.message())
    .expect("promote");
    for dir in team_skills::library_skill_dirs(&clone, team_skills::PLY_PLUGIN, "ship-a-card") {
        assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), SKILL);
    }
    assert_eq!(checkout_bytes(repo.path()), before);
}

#[test]
fn a_checkout_equal_to_the_branch_leaves_nothing_out() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert!(!source.local_changes_left_out);
    // A copy in one root only is aligned too.
    std::fs::remove_dir_all(repo.path().join(CODEX_ROOT)).unwrap();
    git_rm_and_commit(repo.path(), CODEX_ROOT);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert!(!source.local_changes_left_out);
    assert_eq!(std::fs::read_to_string(source.dir.join("SKILL.md")).unwrap(), SKILL);
}

fn git_rm_and_commit(repo: &Path, path: &str) {
    git(repo, &["add", "-A", "--", path]);
    git(repo, &["commit", "-q", "-m", "change"]);
}

/// Skills hub H5 (R12 rule 2, a library publish): the branch's Codex copy
/// changed alone since the link record's aligned state, so it is the one
/// shared — no Align asked.
#[test]
fn promote_shares_the_copy_that_changed_alone_since_the_link_record() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let tip = pl.rev_parse_commit("refs/heads/main").unwrap();
    let id = pl.ls_tree(&tip, &format!("{CLAUDE_ROOT}/ship-a-card"), false)[0].sha.clone();
    write(
        &repo.path().join(".atelier/skill-links/ship-a-card.json"),
        &format!(r#"{{"schemaVersion":1,"origin":{{"kind":"team"}},"base":{{"claude":"{id}","codex":"{id}"}}}}"#),
    );
    write(&repo.path().join(CODEX_ROOT).join("ship-a-card").join("SKILL.md"), EDITED);
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-q", "-m", "codex edit"]);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert_eq!(std::fs::read_to_string(source.dir.join("SKILL.md")).unwrap(), EDITED);
}

#[test]
fn promote_refuses_when_the_branchs_two_copies_differ_or_it_isnt_there() {
    let repo = committed_repo();
    write(&repo.path().join(CODEX_ROOT).join("ship-a-card").join("SKILL.md"), EDITED);
    git_rm_and_commit(repo.path(), CODEX_ROOT);
    let pl = plumbing(repo.path());
    // H5 (Challenger): the history is a record — Codex's copy alone changed
    // since the two were the same, so it is the one shared.
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let shared_alone = branch_source(&pl, repo.path(), &branch, "ship-a-card").expect("the copy that changed alone");
    assert_eq!(std::fs::read_to_string(shared_alone.dir.join("SKILL.md")).unwrap(), EDITED);
    // Claude's copy changes too, differently: nobody wins, Align asks.
    write(&repo.path().join(CLAUDE_ROOT).join("ship-a-card").join("SKILL.md"), "---\nname: ship-a-card\ndescription: Other.\n---\nClaude's own edit.\n");
    git_rm_and_commit(repo.path(), CLAUDE_ROOT);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let refused = branch_source(&pl, repo.path(), &branch, "ship-a-card").err().expect("refused");
    assert!(refused.contains("on main and Codex's are not the same file"), "{refused}");
    // H5: Align exists for every workspace now (a card where there is no
    // shared channel), so the words name it everywhere.
    assert!(refused.contains("Align them on main first."), "{refused}");
    let shared = PromoteBranch { shared: true, ..branch.clone() };
    let trees = branch_skill_trees(&pl, branch.tip.as_deref().unwrap());
    let words = branch_promote_blocker("ship-a-card", &shared, trees.get("ship-a-card"), crate::skill_twins::Judgement::Differ).unwrap();
    assert!(words.contains("Align them on main first."), "{words}");

    // Only in the checkout: nothing committed to share.
    write(&repo.path().join(CLAUDE_ROOT).join("draft").join("SKILL.md"), SKILL);
    let refused = branch_source(&pl, repo.path(), &branch, "draft").err().expect("refused");
    assert_eq!(
        refused,
        "`draft` isn't on main yet. Promote to Team shares the copy committed on main, so ship it with a card first."
    );
    // No such branch at all.
    let missing = PromoteBranch::resolve(&pl, "staging", false);
    assert!(missing.tip.is_none());
    let refused = branch_source(&pl, repo.path(), &missing, "ship-a-card").err().unwrap();
    assert!(refused.contains("this repository has no staging yet"), "{refused}");
}

/// The panel: a checkout whose two copies differ is no longer blocked when the
/// branch is aligned; it carries the note instead. Without a branch to read,
/// the old checkout rule still answers.
#[test]
fn the_view_blocks_on_the_branch_and_notes_the_checkout() {
    let repo = committed_repo();
    write(&repo.path().join(CODEX_ROOT).join("ship-a-card").join("SKILL.md"), EDITED);
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let trees = branch_skill_trees(&pl, branch.tip.as_deref().unwrap());
    assert_eq!(trees.len(), 1, "{trees:?}");
    let pair = &trees["ship-a-card"];
    assert!(pair.0.is_some() && pair.0 == pair.1);

    let view = build_view(
        "ws",
        "repo",
        repo.path(),
        None,
        true,
        None,
        Some(BranchView { git: &pl, branch: &branch, trees: &trees }),
    );
    let row = &view.skills[0];
    assert_eq!(row.promote_blocked, None);
    assert!(row.promote_note.as_deref().unwrap().starts_with("The copies of `ship-a-card` in this checkout aren't the same."));
    assert!(row.promote_note.as_deref().unwrap().contains("your local changes aren't included"));

    let view = build_view("ws", "repo", repo.path(), None, true, None, None);
    assert!(view.skills[0].promote_blocked.is_some());
    assert_eq!(view.skills[0].promote_note, None);
}

/// With a remote, GitHub's copy is the branch (a local commit not pushed yet
/// is not shared); a shared workspace never falls back to the local branch.
#[test]
fn the_branch_is_githubs_copy_when_there_is_one() {
    let repo = committed_repo();
    let first = plumbing(repo.path()).rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &first]);
    write(&repo.path().join(CLAUDE_ROOT).join("ship-a-card").join("SKILL.md"), EDITED);
    write(&repo.path().join(CODEX_ROOT).join("ship-a-card").join("SKILL.md"), EDITED);
    git(repo.path(), &["commit", "-q", "-am", "local only"]);
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    assert_eq!(branch.tip.as_deref(), Some(first.as_str()));
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert_eq!(std::fs::read_to_string(source.dir.join("SKILL.md")).unwrap(), SKILL);
    assert!(source.local_changes_left_out);

    let shared = PromoteBranch::resolve(&pl, "other", true);
    git(repo.path(), &["branch", "other"]);
    assert!(PromoteBranch::resolve(&pl, "other", false).tip.is_some());
    assert!(shared.tip.is_none(), "a shared workspace reads GitHub's branch only");
}

/// A symlink committed inside the skill is refused, never followed.
#[test]
#[cfg(unix)]
fn a_branch_copy_with_a_symlink_is_refused() {
    let repo = committed_repo();
    for root in INSTALL_ROOTS {
        std::os::unix::fs::symlink("SKILL.md", repo.path().join(root).join("ship-a-card").join("link.md")).unwrap();
    }
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-q", "-m", "link"]);
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let refused = branch_source(&pl, repo.path(), &branch, "ship-a-card").err().unwrap();
    assert!(refused.contains("link.md, which is not a plain file"), "{refused}");
}

// ── N14 review fixes ───────────────────────────────────────────────────

/// P2-1: a tree path is never joined unchecked — a backslash or `..` name
/// (Windows traversal) is refused, and nothing is written outside.
#[test]
fn write_file_refuses_paths_that_could_leave_its_folder() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("root");
    for bad in [
        "..\\evil.txt",
        "a\\..\\..\\evil.txt",
        "../evil.txt",
        "a/../../evil.txt",
        "./x",
        "/abs.txt",
        "C:/evil.txt",
        "a/C:evil",
        "a//b",
        "nul\0.txt",
        "",
    ] {
        let refused = crate::shared_library_sync::write_file(&root, bad, b"x", false);
        assert!(refused.is_err(), "{bad:?} was written");
    }
    assert!(!dir.path().join("evil.txt").exists());
    crate::shared_library_sync::write_file(&root, "a/b/ok.md", b"x", false).unwrap();
    assert_eq!(std::fs::read(root.join("a/b/ok.md")).unwrap(), b"x");
}

/// P3-4: size caps, refused in words.
#[test]
fn a_branch_copy_too_large_is_refused() {
    let repo = committed_repo();
    let big = vec![b'a'; PROMOTE_FILE_MAX + 1];
    for root in INSTALL_ROOTS {
        std::fs::write(repo.path().join(root).join("ship-a-card").join("data.txt"), &big).unwrap();
    }
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-q", "-m", "big"]);
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let refused = branch_source(&pl, repo.path(), &branch, "ship-a-card").err().unwrap();
    assert!(refused.contains("is too large to share with the team"), "{refused}");
}

/// Mac walk 2 (H3a): a skill committed on the local branch but not on
/// GitHub's is not "isn't on main yet" — the words name GitHub's branch,
/// and Promote's rule (GitHub's copy) is unchanged.
#[test]
fn a_skill_committed_only_locally_says_github_has_not_got_it() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let first = pl.rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &first]);
    write(&repo.path().join(CLAUDE_ROOT).join("draft").join("SKILL.md"), SKILL);
    git_rm_and_commit(repo.path(), CLAUDE_ROOT);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    assert!(branch.from_github);
    assert_eq!(branch.tip.as_deref(), Some(first.as_str()), "GitHub's copy is still the one read");
    let refused = branch_source(&pl, repo.path(), &branch, "draft").err().expect("refused");
    assert_eq!(
        refused,
        "`draft` isn't on main on GitHub yet. Promote to Team shares the copy committed there, so ship it with a card first."
    );
    let shared = PromoteBranch { shared: true, ..branch.clone() };
    let trees = branch_skill_trees(&pl, &first);
    let words = branch_promote_blocker("draft", &shared, trees.get("draft"), crate::skill_twins::Judgement::One).unwrap();
    assert!(words.ends_with("so publish it to main first."), "{words}");
}

/// Owner, 2026-10-19: "isn't on GitHub's main yet … push it first" is the way
/// to a Promote, so the row says it only where Promote is the next thing to
/// offer — not where the team library already holds the same copy, and not
/// to a member who cannot promote. The row marks it as that kind of blocker,
/// so the Library can also leave it off a copy linked to the team's.
#[test]
fn not_on_the_branch_yet_is_said_only_where_promote_comes_next() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let first = pl.rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &first]);
    write(&repo.path().join(CLAUDE_ROOT).join("draft").join("SKILL.md"), SKILL);
    git_rm_and_commit(repo.path(), CLAUDE_ROOT);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let trees = branch_skill_trees(&pl, branch.tip.as_deref().unwrap());
    let clone = TempDir::new().unwrap();
    let library = team_skills::read_library(clone.path());
    let row = |can_promote: bool| {
        let view = build_view(
            "ws",
            "repo",
            repo.path(),
            Some((clone.path(), &library)),
            can_promote,
            None,
            Some(BranchView { git: &pl, branch: &branch, trees: &trees }),
        );
        view.skills.into_iter().find(|s| s.skill.name == "draft").unwrap()
    };
    // Not in the team library, and this member may promote: said.
    let said = row(true);
    assert_eq!(said.team, CopyState::Absent);
    assert!(said.promote_blocked.as_deref().unwrap().starts_with("`draft` isn't on main on GitHub yet."));
    assert!(said.promote_waits_for_branch);
    // A member who cannot promote: Promote isn't offered, so neither is the way to it.
    let cannot = row(false);
    assert_eq!(cannot.promote_blocked, None);
    assert!(!cannot.promote_waits_for_branch);
    // The team library already holds this very copy: nothing to promote.
    for dir in team_skills::library_skill_dirs(clone.path(), team_skills::PLY_PLUGIN, "draft") {
        write(&dir.join("SKILL.md"), SKILL);
    }
    let in_team = row(true);
    assert_eq!(in_team.team, CopyState::Same);
    assert_eq!(in_team.promote_blocked, None);
    assert!(!in_team.promote_waits_for_branch);
}

/// P3-3: the local branch ahead of GitHub's is said, naming the commit read.
#[test]
fn a_local_branch_ahead_of_github_is_said() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let first = pl.rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &first]);
    assert_eq!(PromoteBranch::resolve(&pl, "main", false).ahead_note, None);
    git(repo.path(), &["commit", "-q", "--allow-empty", "-m", "local"]);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let note = branch.ahead_note.expect("said");
    assert_eq!(
        note,
        format!(
            "Your local main has commits that aren't on GitHub yet; Plyloft shared main as GitHub has it (commit {}).",
            &first[..7]
        )
    );
}

/// P3-5: one copy with uncommitted edits (the two copies still equal to each
/// other is not required) carries the note too.
#[test]
fn one_edited_copy_carries_the_note() {
    let repo = committed_repo();
    for root in INSTALL_ROOTS {
        write(&repo.path().join(root).join("ship-a-card").join("SKILL.md"), EDITED);
    }
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let trees = branch_skill_trees(&pl, branch.tip.as_deref().unwrap());
    let view = build_view(
        "ws",
        "repo",
        repo.path(),
        None,
        true,
        None,
        Some(BranchView { git: &pl, branch: &branch, trees: &trees }),
    );
    let row = &view.skills[0];
    assert!(!row.skill.diverged);
    assert_eq!(
        row.promote_note.as_deref(),
        Some("This checkout's `ship-a-card` has changes not on main. Promote to Team shares the copy committed on main; your local changes aren't included.")
    );
    // Unchanged checkout: no note.
    let clean = committed_repo();
    let pl = plumbing(clean.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let trees = branch_skill_trees(&pl, branch.tip.as_deref().unwrap());
    let view = build_view("ws", "repo", clean.path(), None, true, None, Some(BranchView { git: &pl, branch: &branch, trees: &trees }));
    assert_eq!(view.skills[0].promote_note, None);
}

/// Cold read 2026-10-19: nobody edited here — GitHub's branch has a newer
/// commit of the skill than the checkout. The note says the branch moved on,
/// not "your local changes aren't included"; the toast says the same.
#[test]
fn a_checkout_only_behind_githubs_branch_says_the_branch_is_newer() {
    let repo = committed_repo();
    for root in INSTALL_ROOTS {
        write(&repo.path().join(root).join("ship-a-card").join("SKILL.md"), EDITED);
    }
    git(repo.path(), &["commit", "-q", "-am", "newer on GitHub"]);
    let pl = plumbing(repo.path());
    let newer = pl.rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &newer]);
    git(repo.path(), &["reset", "-q", "--hard", "HEAD~1"]);
    let branch = PromoteBranch::resolve(&pl, "main", true);
    assert_eq!(branch.tip.as_deref(), Some(newer.as_str()));
    let trees = branch_skill_trees(&pl, &newer);
    let view = build_view(
        "ws",
        "repo",
        repo.path(),
        None,
        true,
        None,
        Some(BranchView { git: &pl, branch: &branch, trees: &trees }),
    );
    assert_eq!(
        view.skills[0].promote_note.as_deref(),
        Some("main on GitHub has a newer `ship-a-card` than this checkout. Promote to Team shares the copy on GitHub.")
    );
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert!(source.local_changes_left_out && source.checkout_behind);
    assert_eq!(
        newer_shared_line("ship-a-card", &branch),
        "Plyloft shared the newer `ship-a-card` from main on GitHub; this checkout's copy is older."
    );
}

/// GitHub's main has a newer `ship-a-card` than the checkout's `HEAD`, which
/// is one commit behind it.
fn repo_behind_github() -> (TempDir, String) {
    let repo = committed_repo();
    for root in INSTALL_ROOTS {
        write(&repo.path().join(root).join("ship-a-card").join("SKILL.md"), EDITED);
    }
    git(repo.path(), &["commit", "-q", "-am", "newer on GitHub"]);
    let newer = plumbing(repo.path()).rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &newer]);
    git(repo.path(), &["reset", "-q", "--hard", "HEAD~1"]);
    (repo, newer)
}

fn behind_note(repo: &Path, tip: &str) -> Option<String> {
    let pl = plumbing(repo);
    let branch = PromoteBranch::resolve(&pl, "main", true);
    let trees = branch_skill_trees(&pl, tip);
    let view = build_view("ws", "repo", repo, None, true, None, Some(BranchView { git: &pl, branch: &branch, trees: &trees }));
    view.skills[0].promote_note.clone()
}

/// Challenger: behind GitHub *and* edited here is a local change.
#[test]
fn behind_with_an_uncommitted_edit_keeps_the_local_changes_words() {
    let (repo, newer) = repo_behind_github();
    for root in INSTALL_ROOTS {
        write(&repo.path().join(root).join("ship-a-card").join("SKILL.md"), "---\nname: ship-a-card\ndescription: How this repo ships a change.\n---\n\nMine.\n");
    }
    let note = behind_note(repo.path(), &newer).unwrap();
    assert!(note.contains("your local changes aren't included"), "{note}");
}

/// Challenger: a copy `HEAD` has and the checkout lacks is an uncommitted
/// deletion, not "behind".
#[test]
fn behind_with_a_deleted_twin_is_not_behind() {
    let (repo, newer) = repo_behind_github();
    std::fs::remove_dir_all(repo.path().join(CODEX_ROOT).join("ship-a-card")).unwrap();
    let pl = plumbing(repo.path());
    let at = BehindBase::read(&pl, &newer).unwrap();
    let trees = branch_skill_trees(&pl, &newer);
    assert!(!checkout_behind(&pl, repo.path(), &newer, "ship-a-card", &trees["ship-a-card"], &at));
}

/// Challenger: a local commit on other files, and GitHub newer on the skill:
/// the skill is behind.
#[test]
fn ahead_on_other_files_and_behind_on_the_skill_says_the_branch_is_newer() {
    let (repo, newer) = repo_behind_github();
    write(&repo.path().join("README.md"), "local\n");
    git(repo.path(), &["add", "README.md"]);
    git(repo.path(), &["commit", "-q", "-m", "local, other file"]);
    let note = behind_note(repo.path(), &newer).unwrap();
    assert!(note.starts_with("main on GitHub has a newer `ship-a-card`"), "{note}");
}

/// Cold read 2026-10-19: a change committed here and not on GitHub is still
/// "your local changes aren't included".
#[test]
fn a_local_commit_ahead_of_github_keeps_the_local_changes_words() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let first = pl.rev_parse_commit("HEAD").unwrap();
    git(repo.path(), &["update-ref", "refs/remotes/origin/main", &first]);
    for root in INSTALL_ROOTS {
        write(&repo.path().join(root).join("ship-a-card").join("SKILL.md"), EDITED);
    }
    git(repo.path(), &["commit", "-q", "-am", "local"]);
    let branch = PromoteBranch::resolve(&pl, "main", true);
    let trees = branch_skill_trees(&pl, &first);
    let view = build_view(
        "ws",
        "repo",
        repo.path(),
        None,
        true,
        None,
        Some(BranchView { git: &pl, branch: &branch, trees: &trees }),
    );
    assert!(view.skills[0].promote_note.as_deref().unwrap().contains("your local changes aren't included"));
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert!(source.local_changes_left_out && !source.checkout_behind);
}

/// P3-6: a checkout copy Plyloft refuses to read counts as "not included".
#[test]
#[cfg(unix)]
fn a_refused_checkout_copy_counts_as_left_out() {
    let repo = committed_repo();
    let codex = repo.path().join(CODEX_ROOT).join("ship-a-card");
    std::os::unix::fs::symlink(codex.join("SKILL.md"), codex.join("linked.md")).unwrap();
    let pl = plumbing(repo.path());
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let source = branch_source(&pl, repo.path(), &branch, "ship-a-card").unwrap();
    assert!(source.local_changes_left_out);
}

/// Review 2 (P3-a): names that differ only in case are refused.
#[test]
fn a_branch_copy_with_case_only_duplicates_is_refused() {
    let repo = committed_repo();
    let pl = plumbing(repo.path());
    let head = pl.rev_parse_commit("HEAD").unwrap();
    // Built with plumbing: a case-insensitive file system can't hold both.
    let index = repo.path().join(".git").join("case-index");
    let run = |args: &[&str]| {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(repo.path())
            .env("GIT_INDEX_FILE", &index)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    run(&["read-tree", &head]);
    let sha = run(&["rev-parse", "HEAD:.claude/skills/ship-a-card/SKILL.md"]);
    for root in INSTALL_ROOTS {
        run(&["update-index", "--add", "--cacheinfo", &format!("100644,{sha},{root}/ship-a-card/notes.md")]);
        run(&["update-index", "--add", "--cacheinfo", &format!("100644,{sha},{root}/ship-a-card/NOTES.md")]);
    }
    let tree = run(&["write-tree"]);
    let commit = run(&["commit-tree", &tree, "-p", &head, "-m", "case"]);
    run(&["update-ref", "refs/heads/main", &commit]);
    let branch = PromoteBranch::resolve(&pl, "main", false);
    let refused = branch_source(&pl, repo.path(), &branch, "ship-a-card").err().unwrap();
    assert!(refused.contains("apart from upper and lower case"), "{refused}");
}

/// Review 2 (P3-a): names Windows doesn't keep as written.
#[test]
fn windows_device_and_trailing_names_are_recognised() {
    use crate::shared_library_sync::windows_unsafe_name as bad;
    for name in ["CON", "nul.txt", "Aux", "prn.md", "COM1", "lpt9.log", "x.", "x "] {
        assert!(bad(name), "{name}");
    }
    // 1.175.0 G6: the rest of the platform's list.
    for name in ["COM0", "lpt0.txt", "CONIN$", "conout$.log", "COM\u{b9}", "com\u{b2}.md", "LPT\u{b3}", "lpt\u{b9}.txt"] {
        assert!(bad(name), "{name}");
    }
    for name in ["COM10", "COM", "LPT", "COM1x", "CONIN", "CONOUT", "com\u{2074}", "console.md", "nullable", "SKILL.md", "a.b"] {
        assert!(!bad(name), "{name}");
    }
    if cfg!(windows) {
        let dir = TempDir::new().unwrap();
        assert!(crate::shared_library_sync::write_file(dir.path(), "a/CON.txt", b"x", false).is_err());
    }
}

// ── Share with Team…: what a personal skill may not hold ───────────────

/// A personal skill's folder holding `files`, nested ones too.
fn personal_skill_with(files: &[&str]) -> TempDir {
    let dir = TempDir::new().unwrap();
    write(&dir.path().join("SKILL.md"), SKILL);
    for file in files {
        write(&dir.path().join(file), "x");
    }
    dir
}

fn refusal_of(dir: &Path) -> Option<String> {
    refuse_private_files("deploy", dir).err().map(|error| error.to_string())
}

/// Round 3 (S3): the names that stop a publish, and two that don't.
#[test]
fn the_private_names_cover_keys_and_credential_files_and_no_more() {
    for name in [
        "id_ed25519", "id_ed25519.pub", "id_ecdsa", "ID_DSA", ".npmrc", ".netrc", ".pypirc", ".htpasswd",
        "cert.p12", "cert.PFX", "release.jks", "debug.keystore", "putty.ppk", "credentials", "credentials.json",
        "Credentials.yaml", "secrets.toml", "secrets.env", "prod.tfvars", "service-account.json",
        "service-account-prod.json", "secrets", "credentials.prod.json", "secrets.properties", "credentials.TXT",
    ] {
        let dir = personal_skill_with(&[name]);
        let words = refusal_of(dir.path()).unwrap_or_else(|| panic!("{name} should stop it"));
        assert!(words.starts_with(&format!("deploy holds {name}, which looks private")), "{words}");
    }
    // Round 5 (V1): `credentials.*` and `secrets.*` only as data files —
    // prose and code under those names are no secret.
    for name in [
        "config.json", "token.txt", "tokens.md", "my-credentials.md", "service-account.md", "npmrc", "keys.md",
        "environment.md", "secrets.md", "credentials.py", "credentials.rs", "secrets.ts", "credentials.json.md",
        "secretsmanager.json",
    ] {
        let dir = personal_skill_with(&[name]);
        assert_eq!(refusal_of(dir.path()), None, "{name} is no private name");
    }
}

#[test]
fn a_private_name_is_refused_at_any_depth_and_in_any_case() {
    for name in [".env", ".env.local", ".ENV", "cert.pem", "cert.PEM", "server.key", "id_rsa", "id_rsa.pub", "ID_RSA"] {
        let dir = personal_skill_with(&[name]);
        assert_eq!(
            refusal_of(dir.path()).as_deref(),
            Some(format!("deploy holds {name}, which looks private, so nothing was shared. Move it out of the skill's folder, then try again.").as_str()),
        );
        let nested = personal_skill_with(&[Path::new("config").join("deep").join(name).to_str().unwrap()]);
        let words = refusal_of(nested.path()).expect("nested");
        // `/` on every platform, never Windows' `\`.
        assert!(words.starts_with(&format!("deploy holds config/deep/{name}, which")), "{words}");
    }
}

#[test]
fn a_name_that_only_looks_alike_is_shared() {
    let dir = personal_skill_with(&["run.sh", ".gitignore", ".gitattributes", "keys.md", "pem.txt", "notes.env", "a.key.txt", "docs/environment.md"]);
    assert_eq!(refusal_of(dir.path()), None);
}

#[test]
fn a_git_folder_or_file_anywhere_is_the_git_refusal() {
    const WORDS: &str = "deploy is a git repository of its own, so its files wouldn't reach your team. Nothing was shared. Copy the skill without its .git folder, then try again.";
    // A folder, nested, in another case, the file of a worktree or submodule.
    for file in [".git/HEAD", "vendor/.git/HEAD", ".GIT/HEAD", ".git", "vendor/.git"] {
        let dir = personal_skill_with(&[file]);
        assert_eq!(refusal_of(dir.path()).as_deref(), Some(WORDS), "{file}");
    }
    // Ahead of a private file met first.
    let dir = personal_skill_with(&[".env", "z/.git/HEAD"]);
    assert_eq!(refusal_of(dir.path()).as_deref(), Some(WORDS));
}

/// Bug 2 of the share proposal: a skill that's a git clone reached the team as
/// an empty reference and was reported as shared. Now nothing is written,
/// neither to the team's clone or GitHub nor to the repository.
#[test]
fn a_skill_that_is_a_git_clone_writes_nothing_anywhere() {
    let tmp = TempDir::new().unwrap();
    let clone = team_remote_and_clone(tmp.path());
    let before = head(&clone);
    let repo = TempDir::new().unwrap();
    let skill = personal_skill_with(&[]);
    git(skill.path(), &["init", "--quiet", "."]);
    // In the order `personal_skill_promote` runs them.
    let share = |source: &Path| -> Result<(), CopyError> {
        refuse_private_files("deploy", source)?;
        install_into_repo(repo.path(), "deploy", source, false)?;
        let paths = team_skills::promote_paths(team_skills::PLY_PLUGIN, "deploy")?;
        crate::team::publish_library_paths(
            &clone,
            &paths,
            "skills: share",
            |dir| {
                write_promoted_skill(dir, team_skills::PLY_PLUGIN, "deploy", source, false)
                    .map(|_| ())
                    .map_err(String::from)
            },
            &crate::team::RealLibraryGit,
        )
        .map(|_| ())
        .map_err(|error| CopyError::Message(error.message()))
    };
    let refused = share(skill.path()).expect_err("refused").to_string();
    assert!(refused.contains("is a git repository of its own"), "{refused}");
    assert_eq!(head(&clone), before);
    assert_eq!(crate::git::capture(&clone, &["rev-parse", "origin/main"]).unwrap().trim(), before.trim());
    assert_clean(&clone);
    assert!(team_skills::read_library(&clone).skills.is_empty());
    assert_eq!(std::fs::read_dir(repo.path()).unwrap().count(), 0, "the repository got nothing");

    // The same folder without its .git goes through: the refusal is the only
    // thing that stopped it.
    std::fs::remove_dir_all(skill.path().join(".git")).unwrap();
    share(skill.path()).expect("shared");
    assert_eq!(team_skills::read_library(&clone).skills.len(), 1);
}

/// The command runs the refusal before either way out writes.
#[test]
fn the_personal_promote_refuses_before_it_writes() {
    let source = include_str!("commands.rs");
    let (_, body) = source.split_once("pub async fn personal_skill_promote(").expect("the command");
    let (body, _) = body.split_once("\n}\n").expect("its body");
    let refuse = body.find("refuse_private_files(&skill, &source)?").expect("the refusal");
    assert!(refuse < body.find("install_into_repo(").expect("the repository write"));
    assert!(refuse < body.find("promote_into_library(").expect("the team write"));
}

/// Propose mine upstream: the refusal reads the folder the proposal copies.
#[test]
fn the_proposal_refuses_before_it_writes() {
    let source = include_str!("skills_hub_decisions.rs");
    let (_, body) = source.split_once("pub async fn skills_hub_propose_upstream").expect("the command");
    let (body, _) = body.split_once("\n}\n").expect("its body");
    let refuse = body.find("refuse_unpublishable(&skill, &source, true, \"nothing was shared\")").expect("the refusal");
    assert!(body.find("proposal_source(").expect("the folder") < refuse);
    assert!(refuse < body.find("team_proposal::open(").expect("the team write"));
}

/// A project's skill: the refusal reads the branch's copy, the one that goes.
#[test]
fn the_project_promote_refuses_before_it_writes() {
    let source = include_str!("commands.rs");
    let (_, body) = source.split_once("pub async fn project_skill_promote(").expect("the command");
    let (body, _) = body.split_once("\n}\n").expect("its body");
    let refuse = body.find("refuse_private_files_on_branch(&skill, &source.dir, &branch)?").expect("the refusal");
    assert!(body.find("branch_source(").expect("the copy") < refuse);
    assert!(refuse < body.find("promote_into_library(").expect("the team write"));
}

/// The page's "same files" and All skills' index read a skill alike: a `.git`
/// is no part of either. A real difference still shows.
#[test]
fn a_git_folder_is_not_part_of_a_skills_digest() {
    let dir = personal_skill_with(&["run.sh"]);
    let clean = tree_digest(&[dir.path().to_path_buf()]).unwrap();
    write(&dir.path().join(".git/HEAD"), "x");
    write(&dir.path().join("vendor/.GIT"), "x");
    assert_eq!(tree_digest(&[dir.path().to_path_buf()]).as_deref(), Some(clean.as_str()));
    write(&dir.path().join("run.sh"), "y");
    assert_ne!(tree_digest(&[dir.path().to_path_buf()]).as_deref(), Some(clean.as_str()));
}

/// A project's skill: the file may be committed, so moving it isn't enough.
/// Each path says what it knows, and the personal words stay apart.
#[test]
fn a_project_skills_refusal_says_the_file_may_be_committed() {
    let dir = personal_skill_with(&["config/.env"]);
    let local = PromoteBranch { branch: "main".to_string(), tip: None, shared: false, ahead_note: None, from_github: false };
    let on_branch = refuse_private_files_on_branch("deploy", dir.path(), &local).unwrap_err().to_string();
    assert_eq!(
        on_branch,
        "deploy holds config/.env, which looks private, so nothing was shared. It's committed on main, so take it out with a commit, then try again; it stays in that branch's history."
    );
    // The copy read is GitHub's: a commit only here wouldn't change the answer.
    let github = PromoteBranch { from_github: true, ..local.clone() };
    let on_github = refuse_private_files_on_branch("deploy", dir.path(), &github).unwrap_err().to_string();
    assert_eq!(
        on_github,
        "deploy holds config/.env, which looks private, so nothing was shared. It's committed on main, so take it out with a commit and get that commit to main on GitHub, then try again; it stays in that branch's history."
    );
    let in_checkout = refuse_private_files_in_checkout("deploy", dir.path()).unwrap_err().to_string();
    assert_eq!(
        in_checkout,
        "deploy holds config/.env, which looks private, so nothing was shared. Move it out of the skill's folder, then try again. If it's committed, take it out with a commit; it stays in the history of any branch that has it."
    );
    assert_eq!(
        refusal_of(dir.path()).as_deref(),
        Some("deploy holds config/.env, which looks private, so nothing was shared. Move it out of the skill's folder, then try again.")
    );

    // A clean copy goes on each path, and a `.git` keeps its own words.
    let clean = personal_skill_with(&["run.sh"]);
    assert!(refuse_private_files_on_branch("deploy", clean.path(), &local).is_ok());
    assert!(refuse_private_files_in_checkout("deploy", clean.path()).is_ok());
    let git = personal_skill_with(&[".git/HEAD"]);
    let words = refusal_of(git.path());
    assert_eq!(refuse_private_files_on_branch("deploy", git.path(), &github).err().map(|e| e.to_string()), words);
    assert_eq!(refuse_private_files_in_checkout("deploy", git.path()).err().map(|e| e.to_string()), words);
}

/// What git really does for `project_skill_promote`: a `.env` committed on the
/// branch is in the copy it reads, with the file gone from the checkout or not.
#[test]
fn a_private_file_committed_on_the_branch_is_in_the_copy_refused() {
    let repo = git_repo();
    let skill = repo.path().join(CLAUDE_ROOT).join("deploy");
    write(&skill.join("SKILL.md"), SKILL);
    write(&skill.join(".env"), "x");
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "--quiet", "-m", "x"]);
    std::fs::remove_file(skill.join(".env")).unwrap();
    let plumbing = crate::shared_config::Plumbing { cwd: repo.path().to_path_buf() };
    let tip = crate::git::capture(repo.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
    let branch = PromoteBranch { branch: "main".to_string(), tip: Some(tip), shared: false, ahead_note: None, from_github: false };
    let source = branch_source(&plumbing, repo.path(), &branch, "deploy").expect("the branch's copy");
    let words = refuse_private_files_on_branch("deploy", &source.dir, &branch).unwrap_err().to_string();
    assert!(words.contains("It's committed on main"), "{words}");
    assert!(words.starts_with("deploy holds .env,"), "{words}");
}

/// 1.175.0 B1: the Share page's second status line and the Library's
/// Promote read what the skill's own text asks for — `SKILL.md`, never
/// another file that happens to hold the same words.
#[test]
fn b1_the_share_preview_and_the_library_say_what_a_skills_text_asks_for() {
    use crate::skill_asks::Strongest;
    let asking = "---\nname: deploy\ndescription: d\nallowed-tools: Bash\n---\n\nState: !`git status`\n";
    let dir = TempDir::new().unwrap();
    write(&dir.path().join("SKILL.md"), asking);
    let preview = share_preview(Some("owner/team".to_string()), "deploy", Some(dir.path()));
    // Y1: tools and a command at load — the Share page says the tools.
    assert_eq!(preview.asks, Some(Strongest::Commands));
    assert_eq!(serde_json::to_value(&preview).unwrap()["asks"], "commands");
    // Y1 round 2: a personal skill's page reads every text of the folder,
    // as Promote's does — a nested `SKILL.md` with tools beside a root text
    // that only runs a command at load says the tools.
    let two = TempDir::new().unwrap();
    write(&two.path().join("SKILL.md"), "---\nname: deploy\ndescription: d\n---\n\nState: !`git status`\n");
    assert_eq!(share_preview(None, "deploy", Some(two.path())).asks, Some(Strongest::Inline));
    write(&two.path().join("inner/SKILL.md"), "---\nname: inner\ndescription: d\nallowed-tools: Bash\n---\n\nwords\n");
    assert_eq!(share_preview(None, "deploy", Some(two.path())).asks, Some(Strongest::Commands));
    // Round 3: no text is read past the size the classifier reads. A text
    // over it is said as unreadable — it asks — whatever the others say.
    let big = TempDir::new().unwrap();
    write(&big.path().join("SKILL.md"), SKILL);
    assert_eq!(share_preview(None, "deploy", Some(big.path())).asks, None);
    std::fs::create_dir_all(big.path().join("inner")).unwrap();
    let over = vec![b'x'; crate::skill_scripts::CONTENT_READ_MAX as usize + 1];
    std::fs::write(big.path().join("inner/SKILL.md"), &over).unwrap();
    assert_eq!(share_preview(None, "deploy", Some(big.path())).asks, Some(Strongest::Unreadable));
    std::fs::write(big.path().join("inner/SKILL.md"), &over[..over.len() - 1]).unwrap();
    assert_eq!(share_preview(None, "deploy", Some(big.path())).asks, None, "at the cap it is read: plain text");
    let preview = include_str!("project_skills.rs");
    let (_, body) = preview.split_once("pub fn share_preview(").unwrap();
    let body = body.split_once("\n}\n").unwrap().0;
    assert!(body.contains("*size <= crate::skill_scripts::CONTENT_READ_MAX"), "the classifier's own cap");
    // Plain text: nothing, and the key isn't written.
    let plain = personal_skill_with(&["notes.md"]);
    write(&plain.path().join("notes.md"), asking);
    let preview = share_preview(None, "deploy", Some(plain.path()));
    assert_eq!(preview.asks, None);
    assert!(serde_json::to_value(&preview).unwrap().get("asks").is_none());

    let tree = |files: &[(&str, &str)]| -> Vec<TreeFile> {
        files.iter().map(|(path, text)| TreeFile { path: path.to_string(), executable: false, bytes: text.as_bytes().to_vec() }).collect()
    };
    assert_eq!(asks_of_tree(&tree(&[("SKILL.md", asking)])), Some(Strongest::Commands));
    let at_load = "---\nname: deploy\ndescription: d\n---\n\nState: !`git status`\n";
    assert_eq!(asks_of_tree(&tree(&[("SKILL.md", at_load)])), Some(Strongest::Inline));
    // Two texts: the widest of the two.
    assert_eq!(asks_of_tree(&tree(&[("SKILL.md", at_load), ("docs/SKILL.md", asking)])), Some(Strongest::Commands));
    assert_eq!(asks_of_tree(&tree(&[("SKILL.md", "---\ndescription: d\nallowed-tools: Write\n---\n")])), Some(Strongest::Files));
    assert_eq!(asks_of_tree(&tree(&[("SKILL.md", SKILL), ("ref.md", asking)])), None);
    assert_eq!(asks_of_tree(&tree(&[("SKILL.md", SKILL), ("docs/SKILL.md", asking)])), Some(Strongest::Commands), "a nested one counts (round 2)");
}

/// B1 (scene 1.7): Promote records this computer's OK only after the publish
/// landed, through the rule that checks the page spoke of the bytes shared.
#[test]
fn b1_promote_records_the_sharers_ok_only_for_a_push_that_landed() {
    let source = include_str!("commands.rs");
    let (_, body) = source.split_once("pub async fn project_skill_promote(").expect("the command");
    let body = body.split_once("\n}\n").expect("its body").0;
    let record = body.find("if committed && pushed { crate::skill_scripts::own_promote_needs_no_ok(").expect("the record");
    assert!(body.find("promote_into_library(").expect("the publish") < record);
    assert!(body.find("LibraryWrite::PullRequest(pr) => (Default::default(), false, false, Some(pr))").expect("a pull request is neither") < record);
    let rule = include_str!("skill_scripts.rs");
    let (_, rule) = rule.split_once("pub(crate) fn own_promote_needs_no_ok<").expect("the rule");
    let rule = rule.split_once("\n}\n").unwrap().0;
    assert!(rule.contains("if promote_was_shown(shared, shown) {\n        own_share_needs_no_ok("), "only the bytes the page showed");
    // Round 2 (G3): nothing is read from the checkout after the push.
    assert!(!rule.contains("read_project_skills") && !rule.contains("promote_source"), "{rule}");
    assert!(body.contains("shown.as_deref()"));

    // The id the page was given is the id of the copy shared, or nothing is recorded.
    let asking = "---\nname: deploy\ndescription: d\nallowed-tools: Bash\n---\n\nwords\n";
    let shared = TempDir::new().unwrap();
    write(&shared.path().join("SKILL.md"), asking);
    let id = crate::skill_scripts::scripts_id_of_folder(shared.path()).unwrap().expect("an asking text has an id");
    assert!(crate::skill_scripts::promote_was_shown(shared.path(), Some(&id)));
    assert!(!crate::skill_scripts::promote_was_shown(shared.path(), None), "an older window sends none: it asks here too");
    assert!(!crate::skill_scripts::promote_was_shown(shared.path(), Some("")));
    assert!(!crate::skill_scripts::promote_was_shown(shared.path(), Some("another")), "the page showed other bytes");
    // The branch's copy changed after the page was read: not the bytes shown.
    write(&shared.path().join("SKILL.md"), &asking.replace("words", "other words"));
    assert!(!crate::skill_scripts::promote_was_shown(shared.path(), Some(&id)));
    // A text that asks for nothing records nothing, whatever id came.
    let plain = personal_skill_with(&["run.txt"]);
    assert!(!crate::skill_scripts::promote_was_shown(plain.path(), Some(&id)));
}

#[test]
fn the_share_preview_lists_what_a_share_copies() {
    let dir = personal_skill_with(&["run.sh", "docs/notes.txt", ".hidden"]);
    let preview = share_preview(Some("owner/team".to_string()), "deploy", Some(dir.path()));
    assert_eq!(preview.team_repo.as_deref(), Some("owner/team"));
    let files = preview.files.expect("listed");
    assert_eq!(files, ["SKILL.md", ".hidden", "docs/notes.txt", "run.sh"]);
    assert_eq!(preview.total_bytes, SKILL.len() as u64 + 3);
    assert_eq!(preview.refusal, None);
    let copied: Vec<String> = read_tree(dir.path()).unwrap().into_iter().map(|file| file.path).collect();
    let mut sorted = files.clone();
    sorted.sort();
    assert_eq!(sorted, copied);

    // The metadata-only walk against the reader a share copies with: same paths,
    // same order, same sizes.
    let listed = list_tree(dir.path()).unwrap();
    let read: Vec<(String, u64)> =
        read_tree(dir.path()).unwrap().into_iter().map(|file| (file.path.clone(), file.bytes.len() as u64)).collect();
    assert_eq!(listed, read);

    // The reader no longer lists it: the same words as the press.
    let gone = share_preview(None, "deploy", None);
    assert_eq!(gone.files, None);
    assert_eq!(gone.refusal, Some(not_in_own_folders("deploy")));
    assert_eq!(not_in_own_folders("deploy"), format!("deploy isn't in your own skills folders on {}.", crate::platform::THIS_MACHINE));
}

/// The page says what the press would: the guard's own words, so the two
/// can't differ, and nothing listed for a folder that won't go.
#[test]
fn the_share_preview_refuses_what_the_guard_refuses_in_the_pages_words() {
    for files in [&[".env"][..], &["config/.env", "run.sh"][..], &[".git/HEAD", "run.sh"][..], &["vendor/.git"][..]] {
        let dir = personal_skill_with(files);
        let preview = share_preview(Some("owner/team".to_string()), "deploy", Some(dir.path()));
        assert!(refusal_of(dir.path()).is_some(), "{files:?}");
        let words = preview.refusal.clone().expect("refused");
        assert!(!words.contains("shared.") && !words.contains("try again"), "nothing was pressed: {words}");
        assert_eq!(preview.files, None);
        assert_eq!(preview.total_bytes, 0);
        assert_eq!(preview.team_repo.as_deref(), Some("owner/team"));
    }
    let env = personal_skill_with(&["config/.env"]);
    assert_eq!(
        share_preview(None, "deploy", Some(env.path())).refusal.as_deref(),
        Some("deploy holds config/.env, which looks private, so Plyloft won't share it. Move it out of the skill's folder.")
    );
    let git = personal_skill_with(&[".git/HEAD"]);
    assert_eq!(
        share_preview(None, "deploy", Some(git.path())).refusal.as_deref(),
        Some("deploy is a git repository of its own, so its files wouldn't reach your team. Copy the skill without its .git folder.")
    );
}

// ── 1.175.0 D4 (TM-7): names a Windows computer can't hold ─────────────

fn paths(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

/// Decided on the names alone, so a Mac and a PC refuse the same skill.
#[test]
fn a_name_windows_cannot_have_is_found_on_every_platform() {
    for name in ["notes: v2.md", "a<b.md", "a>b.md", "say \"hi\".md", "a|b.md", "draft?.md", "all*.md", "back\\slash.md", "tab\there.md", "ends.", "ends "] {
        assert_eq!(
            windows_names_in(&paths(&["SKILL.md", name])),
            Some(WindowsNames::CannotHave { first: name.to_string(), more: 0, reserved: false }),
            "{name:?}"
        );
    }
    for name in ["aux.md", "CON", "nul.txt", "com1", "LPT9.log", "prn"] {
        assert_eq!(
            windows_names_in(&paths(&["SKILL.md", name])),
            Some(WindowsNames::CannotHave { first: name.to_string(), more: 0, reserved: true }),
            "{name:?}"
        );
    }
    // A folder's name counts, and so does a name deeper down.
    assert_eq!(
        windows_names_in(&paths(&["SKILL.md", "docs", "docs/aux", "docs/aux/a.md"])),
        Some(WindowsNames::CannotHave { first: "docs/aux".to_string(), more: 0, reserved: true })
    );
    for fine in [&["SKILL.md", "run.sh", "docs", "docs/notes v2.md", ".hidden", "com10.md", "console.md", "a.b.c"][..]] {
        assert_eq!(windows_names_in(&paths(fine)), None, "{fine:?}");
    }
}

/// G6: **Publish / Update on <branch>** and **Ship it with a card** check the
/// files that would travel, each root's copy by itself.
#[test]
fn g6_the_files_a_publish_or_a_card_would_send_are_checked_by_name() {
    let check = |files: &[&str]| refuse_windows_names_of_files("deploy", files.iter().copied(), "nothing was published");
    assert_eq!(check(&[".claude/skills/deploy/SKILL.md", ".claude/skills/deploy/docs/notes v2.md"]), Ok(()));
    // The same file in both copies is one name twice, not two that clash.
    assert_eq!(check(&[".claude/skills/deploy/SKILL.md", ".agents/skills/deploy/SKILL.md"]), Ok(()));
    assert_eq!(
        check(&[".claude/skills/deploy/SKILL.md", ".claude/skills/deploy/notes: v2.md"]).unwrap_err(),
        "deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was published. Rename \
         the file, then try again. If it's committed, rename it with a commit."
    );
    // A folder's name, known only from the files under it.
    assert_eq!(
        check(&[".agents/skills/deploy/SKILL.md", ".agents/skills/deploy/aux/a.md"]).unwrap_err(),
        "deploy holds \u{201c}aux\u{201d}, a name Windows keeps for itself, so nothing was published. Rename the \
         file, then try again. If it's committed, rename it with a commit."
    );
    let clash = check(&[".claude/skills/deploy/README.md", ".claude/skills/deploy/readme.md"]).unwrap_err();
    assert!(clash.contains("which Windows can't tell apart, so nothing was published. Rename one of them"), "{clash}");
    // A workspace in a folder of the repository: the root is whatever comes
    // before the skill's own folder.
    assert!(check(&["apps/web/.claude/skills/deploy/CONIN$"]).unwrap_err().contains("a name Windows keeps for itself"));
    let carried = refuse_windows_names_of_files("deploy", [".claude/skills/deploy/what?.md"].into_iter(), "no card was made");
    assert!(carried.unwrap_err().contains("a name Windows can't have, so no card was made. Rename the file"));
}

/// Round 3: a skill's two copies are put together and the one rule applied.
/// The Claude copy holds only a key nobody knows ("couldn't read" by
/// itself), the Codex copy `allowed-tools: Bash`: the row says commands, as
/// one text asking for both would — not "couldn't read", which the greater
/// of the two answers gave.
#[test]
fn y1_a_skills_two_copies_are_put_together_before_the_rule() {
    use crate::skill_asks::Strongest;
    let repo = TempDir::new().unwrap();
    let unknown = "---\nname: deploy\ndescription: Ships it.\ntriggers: [a]\n---\nShip.\n";
    let tools = "---\nname: deploy\ndescription: Ships it.\nallowed-tools: Bash\n---\nShip.\n";
    write(&repo.path().join(".claude/skills/deploy/SKILL.md"), unknown);
    let alone = read_project_skills(repo.path());
    assert_eq!(alone.skills[0].asks, Some(Strongest::Unreadable));
    write(&repo.path().join(".agents/skills/deploy/SKILL.md"), tools);
    let both = read_project_skills(repo.path());
    assert_eq!(both.skills.len(), 1);
    assert_eq!((both.skills[0].claude, both.skills[0].codex), (true, true));
    assert_eq!(both.skills[0].asks, Some(Strongest::Commands));
    // The other way round, and with a top that can't be read: that one is first.
    write(&repo.path().join(".claude/skills/deploy/SKILL.md"), tools);
    write(&repo.path().join(".agents/skills/deploy/SKILL.md"), unknown);
    assert_eq!(read_project_skills(repo.path()).skills[0].asks, Some(Strongest::Commands));
    write(&repo.path().join(".agents/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: d\nmetadata:\n  a: [b\n---\nShip.\n");
    assert_eq!(read_project_skills(repo.path()).skills[0].asks, Some(Strongest::Unreadable));
}

/// G6: the Share page of a repository skill whose text asks says the refusal
/// before the press, as a personal skill's Share page does.
#[cfg(not(windows))]
#[test]
fn g6_a_repository_skill_that_asks_says_a_refused_name_on_its_share_page() {
    let repo = TempDir::new().unwrap();
    let asking = "---\nname: deploy\ndescription: Ships it.\nallowed-tools: Bash(git push:*)\n---\nShip.\n";
    write(&repo.path().join(".claude/skills/deploy/SKILL.md"), asking);
    write(&repo.path().join(".claude/skills/deploy/docs/notes: v2.md"), "x");
    write(&repo.path().join(".claude/skills/plain/SKILL.md"), SKILL);
    write(&repo.path().join(".claude/skills/plain/what?.md"), "x");
    let read = read_project_skills(repo.path());
    let of = |name: &str| read.skills.iter().find(|skill| skill.name == name).unwrap().clone();
    assert_eq!(
        of("deploy").share_refusal.as_deref(),
        Some(
            "deploy holds \u{201c}docs/notes: v2.md\u{201d}, a name Windows can't have, so Plyloft won't share it. \
             Rename the file in the skill's folder."
        )
    );
    // A skill of plain text has no Share page: its press says it.
    assert_eq!(of("plain").share_refusal, None);
    std::fs::rename(
        repo.path().join(".claude/skills/deploy/docs/notes: v2.md"),
        repo.path().join(".claude/skills/deploy/docs/notes v2.md"),
    )
    .unwrap();
    let read = read_project_skills(repo.path());
    assert_eq!(read.skills.iter().find(|skill| skill.name == "deploy").unwrap().share_refusal, None);
}

#[test]
fn two_names_that_differ_only_by_case_are_found_and_several_refused_names_are_counted() {
    assert_eq!(
        windows_names_in(&paths(&["README.md", "SKILL.md", "readme.md"])),
        Some(WindowsNames::Clash("README.md".to_string(), "readme.md".to_string()))
    );
    // In two folders they are two files.
    assert_eq!(windows_names_in(&paths(&["a", "a/README.md", "b", "b/readme.md"])), None);
    assert_eq!(
        windows_names_in(&paths(&["Docs", "Docs/x.md", "docs", "docs/x.md"])),
        Some(WindowsNames::Clash("Docs".to_string(), "docs".to_string()))
    );
    // A refused name is said before a clash, and the rest are counted.
    assert_eq!(
        windows_names_in(&paths(&["README.md", "aux.md", "notes: v2.md", "readme.md", "what?.md"])),
        Some(WindowsNames::CannotHave { first: "aux.md".to_string(), more: 2, reserved: true })
    );
}

/// The words of `STRINGS-sharing.md` D4, for each place a skill is read from.
#[test]
fn the_windows_refusal_says_the_file_and_how_to_fix_it() {
    let one = WindowsNames::CannotHave { first: "notes: v2.md".to_string(), more: 0, reserved: false };
    let (subject, what, it) = windows_names_subject("meeting-notes", &one);
    assert_eq!(subject, "meeting-notes holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have");
    assert_eq!((what, it), ("the file", "it"));
    let reserved = WindowsNames::CannotHave { first: "aux.md".to_string(), more: 0, reserved: true };
    assert_eq!(
        windows_names_subject("meeting-notes", &reserved).0,
        "meeting-notes holds \u{201c}aux.md\u{201d}, a name Windows keeps for itself"
    );
    let several = WindowsNames::CannotHave { first: "notes: v2.md".to_string(), more: 2, reserved: false };
    assert_eq!(
        windows_names_subject("meeting-notes", &several),
        ("meeting-notes holds \u{201c}notes: v2.md\u{201d} and 2 more files with names Windows can't have".to_string(), "them", "them")
    );
    let two = WindowsNames::CannotHave { first: "aux.md".to_string(), more: 1, reserved: true };
    assert_eq!(
        windows_names_subject("meeting-notes", &two).0,
        "meeting-notes holds \u{201c}aux.md\u{201d} and 1 more file with a name Windows can't have"
    );
    let clash = WindowsNames::Clash("README.md".to_string(), "readme.md".to_string());
    assert_eq!(
        windows_names_subject("meeting-notes", &clash),
        (
            "meeting-notes holds \u{201c}README.md\u{201d} and \u{201c}readme.md\u{201d}, which Windows can't tell apart".to_string(),
            "one of them",
            "one of them"
        )
    );
}

/// On a Mac the file exists, and the press and the page both refuse it —
/// the refusal isn't left to the Windows computer that would stop updating.
/// (A PC can't hold such a file to begin with, so there is nothing to make there.)
#[cfg(unix)]
#[test]
fn a_skill_with_a_name_windows_cannot_have_is_refused_on_a_mac_too() {
    let dir = personal_skill_with(&["notes: v2.md"]);
    assert_eq!(
        refusal_of(dir.path()).as_deref(),
        Some("deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was shared. Rename the file, then try again.")
    );
    let preview = share_preview(Some("owner/team".to_string()), "deploy", Some(dir.path()));
    assert_eq!(
        preview.refusal.as_deref(),
        Some("deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so Plyloft won't share it. Rename the file in the skill's folder.")
    );
    assert_eq!(preview.files, None);

    let local = PromoteBranch { branch: "staging".to_string(), tip: None, shared: false, ahead_note: None, from_github: false };
    assert_eq!(
        refuse_private_files_on_branch("deploy", dir.path(), &local).unwrap_err().to_string(),
        "deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was shared. It's committed on staging, so rename it with a commit, then try again."
    );
    let github = PromoteBranch { from_github: true, ..local.clone() };
    assert_eq!(
        refuse_private_files_on_branch("deploy", dir.path(), &github).unwrap_err().to_string(),
        "deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was shared. It's committed on staging, so rename it with a commit and get that commit to staging on GitHub, then try again."
    );
    assert_eq!(
        refuse_private_files_in_checkout("deploy", dir.path()).unwrap_err().to_string(),
        "deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was shared. Rename the file, then try again. If it's committed, rename it with a commit."
    );
    // My library: the one gate of every path a skill leaves for GitHub
    // (merged with block A's lane), in its own words for what didn't happen.
    assert_eq!(
        refuse_unpublishable("deploy", dir.path(), false, "nothing was added to My library").unwrap_err().to_string(),
        "deploy holds \u{201c}notes: v2.md\u{201d}, a name Windows can't have, so nothing was added to My library. Rename the file, then try again."
    );

    // A reserved name and several names, in their own words.
    let reserved = personal_skill_with(&["docs/aux.md"]);
    assert_eq!(
        refusal_of(reserved.path()).as_deref(),
        Some("deploy holds \u{201c}docs/aux.md\u{201d}, a name Windows keeps for itself, so nothing was shared. Rename the file, then try again.")
    );
    let several = personal_skill_with(&["notes: v2.md", "what?.md", "z."]);
    assert_eq!(
        refusal_of(several.path()).as_deref(),
        Some("deploy holds \u{201c}notes: v2.md\u{201d} and 2 more files with names Windows can't have, so nothing was shared. Rename them, then try again.")
    );
    // A private file is still said first, and a clean folder goes.
    let both = personal_skill_with(&[".env", "notes: v2.md"]);
    assert!(refusal_of(both.path()).unwrap().contains("which looks private"));
    assert_eq!(refusal_of(personal_skill_with(&["run.sh"]).path()), None);
    assert!(refuse_unpublishable("deploy", personal_skill_with(&["run.sh"]).path(), true, "nothing was added to My library").is_ok());
    // There too a private name is said first.
    let said = refuse_unpublishable("deploy", both.path(), false, "nothing was added to My library").unwrap_err().to_string();
    assert!(said.contains("which looks private"), "{said}");
}

/// The share never writes before the check: `copy_into`, the library write
/// and the proposal all come after the guard that now holds this check.
#[test]
fn the_windows_name_check_is_part_of_the_guard_every_share_already_calls() {
    let source = include_str!("project_skills.rs");
    let body = &source[source.find("fn refuse_private(").expect("the guard")..];
    let body = &body[..body.find("\n}\n").expect("its end")];
    assert!(body.contains("None => refuse_windows_names(skill, source, &at, \"nothing was shared\")"), "{body}");
    // My library (merged with block A's lane): the check is the one gate's,
    // on the files that would travel, before the folder is read.
    let mine = include_str!("my_library.rs");
    let check = mine
        .find("refuse_unpublishable(skill, dir, in_checkout, \"nothing was added to My library\")")
        .expect("the check");
    let read = mine[check..].find("read_dir_files(dir)?").expect("the read that follows");
    assert!(read > 0);
}

/// A folder gone between the read and the press is refused as unread, the same
/// on the page and on the press.
#[test]
fn the_share_preview_refuses_a_folder_it_cannot_read() {
    let dir = personal_skill_with(&[]);
    let gone = dir.path().join("not-here");
    let preview = share_preview(None, "deploy", Some(&gone));
    assert_eq!(preview.files, None);
    let words = preview.refusal.expect("refused");
    assert!(words.starts_with("Plyloft could not read deploy: "), "{words}");
    assert!(words.contains("os error"), "the page puts this in plain words: {words}");
    assert_eq!(Some(words), refusal_of(&gone));
}

/// The same rule on a link as the reader: refused anywhere, never followed.
#[cfg(unix)]
#[test]
fn the_share_list_refuses_a_link_as_the_reader_does() {
    let outside = personal_skill_with(&["big.bin"]);
    let dir = personal_skill_with(&[]);
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("sub").join("link")).unwrap();
    let listed = list_tree(dir.path()).expect_err("a link");
    let read = read_tree(dir.path()).expect_err("a link");
    assert_eq!(listed, read);
    assert_eq!(share_preview(None, "deploy", Some(dir.path())).files, None);
}
