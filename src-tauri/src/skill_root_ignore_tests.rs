//! GH #215 — un-ignoring a skill root, against real git.
//!
//! Only shapes answered by directory lines above or at the root are fixed:
//! the plan names the file and the exact lines, the append leaves every
//! existing byte where it was, `git check-ignore` stops reporting the root,
//! the rest of the opened directories stays as it was, what other rules
//! ignore inside a skill (`.env`, `key.pem`, `node_modules/`, `.DS_Store`)
//! stays ignored — for the member and for a teammate with other excludes —
//! and a second run adds nothing. Every shape that would need a line inside
//! the root is refused with nothing written, and the manual edit suggested
//! where there is a safe one. The review's reproductions (`mod regressions`)
//! each end one of those two ways, with nothing leaked.
//!
//! Every repository sets `core.excludesFile` to a file of its own (holding
//! `.DS_Store`), so the member's real `~/.config/git/ignore` never reaches a
//! test.

use super::*;
use tempfile::TempDir;

const SKILL: &str =
    "---\nname: ship-a-card\ndescription: How this repo ships a change.\n---\n\nShip it.\n";
const PROBE: &str = ".claude/skills/ship-a-card/SKILL.md";
/// Rules every fixture's root `.gitignore` starts with; the member's
/// excludes file carries `.DS_Store`.
const SENSITIVE_RULES: &str = ".env\n*.pem\nnode_modules/\n";
/// Files other rules ignore inside a skill — existing, and in a skill that
/// does not exist yet.
const KEEP_IGNORED: [&str; 8] = [
    ".claude/skills/ship-a-card/.env",
    ".claude/skills/ship-a-card/key.pem",
    ".claude/skills/ship-a-card/node_modules/x/index.js",
    ".claude/skills/ship-a-card/.DS_Store",
    ".claude/skills/later/.env",
    ".claude/skills/later/deep/key.pem",
    ".claude/skills/later/node_modules/y",
    ".claude/skills/later/.DS_Store",
];

struct Fixture {
    _dir: TempDir,
    repo: PathBuf,
    global: PathBuf,
}

fn run(dir: &Path, args: &[&str]) {
    let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn write(path: &Path, contents: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// A repository with one Claude skill holding files other rules ignore, and
/// a sibling `.claude` file.
fn fixture() -> Fixture {
    let dir = TempDir::new().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run(&repo, &["init", "-q", "."]);
    run(&repo, &["config", "user.email", "t@example.com"]);
    run(&repo, &["config", "user.name", "t"]);
    let global = dir.path().join("global-ignore");
    write(&global, b".DS_Store\n");
    run(&repo, &["config", "core.excludesFile", global.to_str().unwrap()]);
    write(&repo.join(PROBE), SKILL.as_bytes());
    for file in &KEEP_IGNORED[..4] {
        write(&repo.join(file), b"secret\n");
    }
    write(&repo.join(".claude/settings.local.json"), b"{}\n");
    write(&repo.join(".gitignore"), SENSITIVE_RULES.as_bytes());
    Fixture {
        _dir: dir,
        repo,
        global,
    }
}

/// `git check-ignore`'s own answer in the real repository.
fn ignored(repo: &Path, path: &str) -> bool {
    ignored_with(repo, &[], path)
}

fn ignored_with(repo: &Path, config: &[String], path: &str) -> bool {
    let mut cmd = crate::platform::git_command();
    for setting in config {
        cmd.arg("-c").arg(setting);
    }
    cmd.args(["check-ignore", "-q", "--", path])
        .current_dir(repo)
        .status()
        .unwrap()
        .success()
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

const COMMENT: &str = "# Plyloft: un-ignore .claude/skills so commits carry the skills";

fn assert_kept(repo: &Path, prefix: &str) {
    for file in KEEP_IGNORED {
        let path = format!("{prefix}{file}");
        assert!(ignored(repo, &path), "{path} stays ignored");
    }
}

/// Plan, apply what it shows, and hold the invariants every fixed shape
/// shares.
fn fix_and_hold(f: &Fixture, file: &Path, expected: &[&str]) -> IgnoreFixOutcome {
    assert!(ignored(&f.repo, PROBE), "the fixture ignores the skill to begin with");
    assert_kept(&f.repo, "");
    let sibling = ignored(&f.repo, ".claude/settings.local.json");
    let before = read(file);
    let plan = super::plan(&f.repo).unwrap();
    assert_eq!(plan.roots, vec![".claude/skills".to_string()]);
    assert!(plan.refused.is_empty(), "{:?}", plan.refused);
    assert_eq!(plan.edits.len(), 1, "{:?}", plan.edits);
    let mut want = vec![COMMENT];
    want.extend_from_slice(expected);
    assert_eq!(plan.edits[0].lines, lines(&want));
    for line in &plan.edits[0].lines[1..] {
        assert!(
            !line.contains("/skills/*") && !line.contains("**"),
            "nothing reaches inside the root: {line}"
        );
    }

    let outcome = apply(&f.repo, &plan.edits).unwrap();
    assert!(outcome.still_ignored.is_empty(), "{outcome:?}");
    assert!(!ignored(&f.repo, PROBE), "git carries the skill now");
    assert!(!ignored(&f.repo, ".claude/skills/later/SKILL.md"), "and a skill added later");
    assert_kept(&f.repo, "");
    assert_eq!(
        ignored(&f.repo, ".claude/settings.local.json"),
        sibling,
        "the rest of .claude is as it was"
    );
    let after = read(file);
    assert_eq!(&after[..before.len()], &before[..], "existing bytes untouched");
    assert!(outcome.sentence.contains("Git no longer ignores .claude/skills"), "{}", outcome.sentence);

    // Idempotent: nothing is left to add, and nothing is written again.
    let again = super::plan(&f.repo).unwrap();
    assert!(again.edits.is_empty() && again.roots.is_empty(), "{again:?}");
    assert!(apply(&f.repo, &again.edits).is_err());
    assert_eq!(read(file), after);
    outcome
}

/// Plan for a shape Ply must not fix: nothing offered, nothing written, and
/// the refusal returned.
fn refused_untouched(f: &Fixture) -> IgnoreRefusal {
    let file = f.repo.join(".gitignore");
    let before = std::fs::read(&file).ok();
    let plan = super::plan(&f.repo).unwrap();
    assert!(plan.edits.is_empty(), "{:?}", plan.edits);
    assert!(!plan.refused.is_empty());
    assert!(apply(&f.repo, &plan.edits).is_err());
    assert_eq!(std::fs::read(&file).ok(), before);
    assert!(ignored(&f.repo, PROBE));
    plan.refused[0].clone()
}

// ── Fixed ────────────────────────────────────────────────────────────

#[test]
fn a_directory_rule_is_opened_level_by_level_and_its_siblings_stay_ignored() {
    // `.claude/` — git cannot re-include anything under an excluded
    // directory, so the directory is opened, re-closed for everything else,
    // and the root opened inside it. No line reaches inside a skill, so the
    // other rules keep working there as they are.
    let f = fixture();
    let file = f.repo.join(".gitignore");
    let text = format!("{SENSITIVE_RULES}.claude/\ndist/\n");
    write(&file, text.as_bytes());
    run(&f.repo, &["add", ".gitignore"]);
    run(&f.repo, &["commit", "-q", "-m", "ignore"]);
    let outcome = fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
    assert_eq!(outcome.written[0].file, ".gitignore");
    assert_eq!(outcome.written[0].reach, EditReach::Repository, "tracked");
    assert_eq!(
        String::from_utf8(read(&file)).unwrap(),
        format!("{text}{COMMENT}\n!/.claude/\n/.claude/*\n!/.claude/skills/\n")
    );
    assert!(ignored(&f.repo, ".claude/settings.local.json"));
    assert!(outcome.sentence.contains("Commit .gitignore"), "{}", outcome.sentence);
}

#[test]
fn a_bare_name_rule_without_a_final_newline_keeps_that_convention() {
    let f = fixture();
    let file = f.repo.join(".gitignore");
    let text = format!("{SENSITIVE_RULES}target\n.claude");
    write(&file, text.as_bytes());
    let outcome = fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
    assert_eq!(outcome.written[0].reach, EditReach::Untracked, "not tracked yet");
    assert!(outcome.sentence.contains("Commit .gitignore"), "{}", outcome.sentence);
    assert_eq!(
        String::from_utf8(read(&file)).unwrap(),
        format!("{text}\n{COMMENT}\n!/.claude/\n/.claude/*\n!/.claude/skills/"),
        "a newline separates the block; the file still ends without one"
    );
}

#[test]
fn a_contents_rule_needs_only_the_root_and_keeps_existing_carve_outs() {
    let f = fixture();
    let file = f.repo.join(".gitignore");
    write(&file, format!("{SENSITIVE_RULES}.claude/*\n!.claude/commands/\n").as_bytes());
    write(&f.repo.join(".claude/commands/go.md"), b"go\n");
    fix_and_hold(&f, &file, &["!/.claude/skills/"]);
    assert!(!ignored(&f.repo, ".claude/commands/go.md"), "the carve-out still holds");
}

#[test]
fn a_rule_naming_the_root_directory_is_answered_for_that_root() {
    // `skills/` ignores both roots by name; each gets `!/<root>/`.
    let f = fixture();
    let file = f.repo.join(".gitignore");
    write(&file, format!("{SENSITIVE_RULES}skills/\n").as_bytes());
    let plan = super::plan(&f.repo).unwrap();
    assert_eq!(plan.roots, lines(&[".claude/skills", ".agents/skills"]));
    assert!(plan.refused.is_empty(), "{:?}", plan.refused);
    assert_eq!(
        plan.edits[0].lines,
        lines(&[
            "# Plyloft: un-ignore .claude/skills and .agents/skills so commits carry the skills",
            "!/.claude/skills/",
            "!/.agents/skills/",
        ])
    );
    apply(&f.repo, &plan.edits).unwrap();
    assert!(!ignored(&f.repo, PROBE));
    assert!(ignored(&f.repo, "src/skills/x"), "elsewhere the rule still holds");
    assert_kept(&f.repo, "");
}

#[test]
fn a_rule_in_info_exclude_is_fixed_there_for_this_clone_only() {
    let f = fixture();
    let root_before = read(&f.repo.join(".gitignore"));
    let file = f.repo.join(".git/info/exclude");
    write(&file, b"# local\n.claude/\n");
    let outcome = fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
    assert_eq!(outcome.written[0].file, ".git/info/exclude");
    assert_eq!(outcome.written[0].reach, EditReach::Clone);
    assert_eq!(read(&f.repo.join(".gitignore")), root_before, "the .gitignore is untouched");
    assert!(!outcome.sentence.contains("Commit"), "{}", outcome.sentence);
}

#[test]
fn crlf_files_get_crlf_lines() {
    let f = fixture();
    let file = f.repo.join(".gitignore");
    write(&file, b".env\r\n*.pem\r\nnode_modules/\r\n.claude/\r\n");
    fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
    assert_eq!(
        String::from_utf8(read(&file)).unwrap(),
        format!(".env\r\n*.pem\r\nnode_modules/\r\n.claude/\r\n{COMMENT}\r\n!/.claude/\r\n/.claude/*\r\n!/.claude/skills/\r\n")
    );
}

#[test]
fn a_teammates_own_excludes_still_apply_inside_the_skills() {
    // The committed lines name only directories on the way to the root, so a
    // teammate's excludes file and info/exclude keep working inside it.
    let f = fixture();
    let file = f.repo.join(".gitignore");
    write(&file, format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
    let mate = f.repo.parent().unwrap().join("mate-ignore");
    write(&mate, b".idea/\n*.swp\n.envrc\n");
    let config = [format!("core.excludesFile={}", mate.display())];
    for path in [
        ".claude/skills/ship-a-card/.idea/workspace.xml",
        ".claude/skills/ship-a-card/a.swp",
        ".claude/skills/ship-a-card/.envrc",
    ] {
        assert!(ignored_with(&f.repo, &config, path), "{path} stays ignored for the teammate");
    }
    write(&f.repo.join(".git/info/exclude"), b"local-notes.md\n");
    assert!(ignored(&f.repo, ".claude/skills/ship-a-card/local-notes.md"));
}

#[test]
fn a_workspace_below_the_top_of_the_repo_writes_the_file_the_rule_is_in() {
    let f = fixture();
    let sub = f.repo.join("app");
    write(&sub.join(PROBE), SKILL.as_bytes());
    let file = f.repo.join(".gitignore");
    write(&file, b".claude/\n");
    let plan = super::plan(&sub).unwrap();
    assert_eq!(plan.edits[0].file, ".gitignore");
    assert_eq!(
        plan.edits[0].lines[1..],
        lines(&["!/app/.claude/", "/app/.claude/*", "!/app/.claude/skills/"])
    );
    apply(&sub, &plan.edits).unwrap();
    assert!(!ignored(&f.repo, "app/.claude/skills/ship-a-card/SKILL.md"));
    assert!(ignored(&f.repo, ".claude/settings.local.json"), "the top one is not touched");
}

/// A workspace directory with glob characters in its name: the lines name
/// it literally, so a sibling the unescaped glob would match stays ignored.
fn a_glob_named_workspace(dir: &str, escaped: &str, sibling: &str) {
    let f = fixture();
    let sub = f.repo.join(dir);
    write(&sub.join(PROBE), SKILL.as_bytes());
    for file in &KEEP_IGNORED[..4] {
        write(&sub.join(file), b"secret\n");
    }
    write(&f.repo.join(sibling).join(PROBE), SKILL.as_bytes());
    let file = f.repo.join(".gitignore");
    write(&file, format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    let plan = super::plan(&sub).unwrap();
    assert!(plan.refused.is_empty(), "{:?}", plan.refused);
    assert_eq!(
        plan.edits[0].lines[1..],
        lines(&[
            &format!("!/{escaped}/.claude/"),
            &format!("/{escaped}/.claude/*"),
            &format!("!/{escaped}/.claude/skills/"),
        ])
    );
    apply(&sub, &plan.edits).unwrap();
    assert!(!ignored(&f.repo, &format!("{dir}/{PROBE}")));
    assert!(ignored(&f.repo, &format!("{sibling}/{PROBE}")), "{sibling} is not matched");
    assert_kept(&f.repo, &format!("{dir}/"));
    assert!(super::plan(&sub).unwrap().edits.is_empty());
}

#[test]
fn a_workspace_named_with_brackets_is_named_literally() {
    a_glob_named_workspace("web[1]", "web\\[1]", "web1");
}

// `*` can't be in a Windows file name.
#[cfg(unix)]
#[test]
fn a_workspace_named_with_a_star_is_named_literally() {
    a_glob_named_workspace("a*b", "a\\*b", "aXb");
}

#[test]
fn the_check_matches_names_as_this_clone_does() {
    // With core.ignorecase off, a dormant `!SETTINGS.LOCAL.JSON` does not
    // match settings.local.json, so opening `.claude` exposes nothing and the
    // fix is offered. A scratch repository matching without regard to case
    // (the default on this disk) would refuse it.
    let f = fixture();
    run(&f.repo, &["config", "core.ignorecase", "false"]);
    let file = f.repo.join(".gitignore");
    write(&file, format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    write(&f.repo.join(".claude/.gitignore"), b"!SETTINGS.LOCAL.JSON\n");
    fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
    assert!(ignored(&f.repo, ".claude/settings.local.json"));
}

// ── Explained, not fixed ─────────────────────────────────────────────

#[test]
fn a_recursive_rule_is_refused_with_the_edit_to_make() {
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/**\n").as_bytes());
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains("also ignores the files inside .claude/skills"), "{}", refusal.reason);
    assert!(refusal.reason.contains("each teammate's own"), "{}", refusal.reason);
    assert_eq!(
        refusal.suggestion.as_deref(),
        Some("Replace the line .claude/** with:\n.claude/*\n!/.claude/skills/")
    );
    assert_eq!(refusal.rule, ".gitignore:4: .claude/**");
    // The suggestion works, and keeps .env and the rest ignored.
    write(
        &f.repo.join(".gitignore"),
        format!("{SENSITIVE_RULES}.claude/*\n!/.claude/skills/\n").as_bytes(),
    );
    assert!(!ignored(&f.repo, PROBE));
    assert_kept(&f.repo, "");
}

#[test]
fn a_star_in_a_nested_gitignore_is_refused() {
    let f = fixture();
    write(&f.repo.join(".claude/.gitignore"), b"*\n");
    let before = read(&f.repo.join(".claude/.gitignore"));
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains("A rule in .claude/.gitignore"), "{}", refusal.reason);
    assert_eq!(refusal.suggestion, None);
    assert!(refusal.reason.contains("so it no longer matches inside"), "{}", refusal.reason);
    assert_eq!(read(&f.repo.join(".claude/.gitignore")), before);
}

#[test]
fn a_name_rule_that_hides_skill_files_is_refused() {
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}*.md\n").as_bytes());
    let refusal = refused_untouched(&f);
    assert_eq!(refusal.rule, ".gitignore:4: *.md");
}

#[test]
fn a_whitelist_repo_is_refused() {
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("*\n!.gitignore\n{SENSITIVE_RULES}").as_bytes());
    refused_untouched(&f);
}

#[test]
fn a_dormant_negation_outside_the_root_is_refused() {
    // Opening `.claude` wakes `.claude/.gitignore`, whose negation would
    // un-ignore settings.local.json.
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    write(&f.repo.join(".claude/.gitignore"), b"!settings.local.json\n");
    let refusal = refused_untouched(&f);
    assert!(
        refusal.reason.contains("would make git read a .gitignore it skips today")
            && refusal.reason.contains("would un-ignore .claude/settings.local.json"),
        "{}",
        refusal.reason
    );
    assert!(
        refusal.rule.contains("after the fix, .claude/.gitignore:1: !settings.local.json would win"),
        "{}",
        refusal.rule
    );
    assert!(ignored(&f.repo, ".claude/settings.local.json"));
}

#[test]
fn a_dormant_negation_inside_the_root_is_refused() {
    // `.claude/.gitignore` would un-ignore every skill's .env once read.
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    write(&f.repo.join(".claude/.gitignore"), b"!.env\n");
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains(".env, which is ignored now"), "{}", refusal.reason);
}

#[test]
fn too_many_files_to_check_is_refused_not_passed() {
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    for i in 0..(walk_max() + 10) {
        write(&f.repo.join(format!(".claude/skills/big/f{i}.txt")), b"");
    }
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains(&format!("more than {} files", walk_max())), "{}", refusal.reason);
}

#[cfg(unix)]
#[test]
fn an_unreadable_directory_left_open_is_refused_by_name() {
    // `locked/` would be open after the fix, and its own `.gitignore` could
    // un-ignore anything in it; Ply can't list it, so it can't say.
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    let locked = f.repo.join(".claude/skills/locked");
    write(&locked.join(".gitignore"), b"!.env\n");
    write(&locked.join(".env"), b"secret\n");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read_dir(&locked).is_ok(); // running as root
    let plan = super::plan(&f.repo);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    if readable {
        return;
    }
    let plan = plan.unwrap();
    assert!(plan.edits.is_empty(), "{:?}", plan.edits);
    assert!(
        plan.refused[0].reason.contains("couldn't list .claude/skills/locked"),
        "{}",
        plan.refused[0].reason
    );
    assert!(ignored(&f.repo, ".claude/skills/locked/.env"));
}

#[test]
fn a_skills_own_negation_is_named_as_the_rule_that_would_win() {
    // The skill's `.gitignore` is skipped today (its directory is excluded);
    // once `.claude` is open it would un-ignore `.env.example`, which the
    // root's `.env*` ignores. The refusal names that rule, not the root's.
    let f = fixture();
    write(&f.repo.join(".gitignore"), b".env*\n.claude/\n");
    write(&f.repo.join(".claude/skills/ship-a-card/.gitignore"), b"# local\n!.env.example\n");
    write(&f.repo.join(".claude/skills/ship-a-card/.env.example"), b"X=1\n");
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains("a .gitignore it skips today"), "{}", refusal.reason);
    assert!(
        refusal.reason.contains("would un-ignore .claude/skills/ship-a-card/.env.example"),
        "{}",
        refusal.reason
    );
    assert!(!refusal.reason.contains("the rule that ignores"), "{}", refusal.reason);
    assert!(
        refusal.rule.contains(
            "after the fix, .claude/skills/ship-a-card/.gitignore:2: !.env.example would win"
        ),
        "{}",
        refusal.rule
    );
    assert!(refusal.rule.contains("ignored today by .gitignore:1: .env*"), "{}", refusal.rule);
}

#[test]
fn a_git_directory_inside_a_skill_is_not_walked() {
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    for i in 0..(walk_max() + 10) {
        write(&f.repo.join(format!(".claude/skills/ship-a-card/.git/objects/o{i}")), b"");
    }
    let plan = super::plan(&f.repo).unwrap();
    assert!(plan.refused.is_empty(), "{:?}", plan.refused);
    assert!(!plan.edits.is_empty());
}

#[test]
fn an_excludes_rule_besides_a_repository_rule_says_both() {
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    write(&f.global, b".DS_Store\n.claude/\n");
    let refusal = refused_untouched(&f);
    assert!(
        refusal.reason.starts_with("Besides a rule in this repository, .claude/skills is also ignored by"),
        "{}",
        refusal.reason
    );
}

/// Timings for the report (review 3): ~18,000 entries under an opened
/// directory, planned and confirmed. `cargo test … -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_eighteen_thousand_entries() {
    WALK_MAX.with(|max| max.set(20_000));
    let f = fixture();
    write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
    for d in 0..300 {
        for i in 0..59 {
            write(&f.repo.join(format!(".claude/skills/s{d}/ref/f{i}.md")), b"");
        }
    }
    let t = std::time::Instant::now();
    let plan = super::plan(&f.repo).unwrap();
    let planned = t.elapsed();
    assert!(plan.refused.is_empty(), "{:?}", plan.refused);
    let t = std::time::Instant::now();
    apply(&f.repo, &plan.edits).unwrap();
    eprintln!("TIMING plan {planned:?}, confirm {:?}", t.elapsed());
}

#[cfg(unix)]
#[test]
fn a_linked_info_exclude_is_refused_at_plan_time() {
    let f = fixture();
    let target = f.repo.parent().unwrap().join("shared-exclude");
    write(&target, b".claude/\n");
    let link = f.repo.join(".git/info/exclude");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains("is a link"), "{}", refusal.reason);
    assert_eq!(read(&target), b".claude/\n");
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
}

#[test]
fn a_rule_in_the_excludes_file_is_explained_not_fixed() {
    let f = fixture();
    write(&f.global, b".DS_Store\n.claude/\n");
    let global_before = read(&f.global);
    let refusal = refused_untouched(&f);
    assert_eq!(refusal.root, ".claude/skills");
    // The fixture sets core.excludesFile in the clone's own .git/config, and
    // the sentence says so rather than "your own git settings".
    assert!(refusal.reason.contains("this clone's own git config"), "{}", refusal.reason);
    assert!(refusal.reason.contains("outside the repository"), "{}", refusal.reason);
    assert!(refusal.rule.starts_with(f.global.to_str().unwrap()), "{}", refusal.rule);
    assert!(refusal.rule.ends_with(":2: .claude/"), "{}", refusal.rule);
    assert_eq!(read(&f.global), global_before, "the excludes file is never touched");
}

#[test]
fn a_rule_inside_the_skills_directory_is_explained_not_fixed() {
    let f = fixture();
    let file = f.repo.join(".claude/skills/.gitignore");
    write(&file, b"*\n");
    let before = read(&file);
    let refusal = refused_untouched(&f);
    assert!(refusal.reason.contains("inside the skills directory"), "{}", refusal.reason);
    assert_eq!(read(&file), before);
}

#[test]
fn a_confirmation_that_no_longer_matches_writes_nothing() {
    let f = fixture();
    let file = f.repo.join(".gitignore");
    write(&file, b".claude/\n");
    let plan = super::plan(&f.repo).unwrap();
    // The file changes after the confirmation opened: the lines it showed
    // would no longer be the ones that work.
    write(&file, b".claude/\n.agents/\n");
    let error = apply(&f.repo, &plan.edits).unwrap_err();
    assert!(error.contains("nothing was written"), "{error}");
    assert_eq!(read(&file), b".claude/\n.agents/\n");

    // Lines other than the ones worked out are never written either.
    let mut forged = super::plan(&f.repo).unwrap().edits;
    forged[0].lines.push("!*".into());
    assert!(apply(&f.repo, &forged).is_err());
    assert_eq!(read(&file), b".claude/\n.agents/\n");
}

#[test]
fn nothing_ignored_is_nothing_to_plan() {
    let f = fixture();
    let plan = super::plan(&f.repo).unwrap();
    assert_eq!(plan, IgnorePlan::default());
}

#[test]
fn append_block_keeps_every_existing_byte() {
    let block = lines(&["# c", "!/x/"]);
    assert_eq!(append_block(b"", &block), b"# c\n!/x/\n");
    assert_eq!(append_block(b"a\n", &block), b"a\n# c\n!/x/\n");
    assert_eq!(append_block(b"a", &block), b"a\n# c\n!/x/");
    assert_eq!(append_block(b"a\r\n", &block), b"a\r\n# c\r\n!/x/\r\n");
    assert_eq!(append_block(b"a\n", &[]), b"a\n");
}

#[test]
fn path_components_are_escaped_and_suggestions_named() {
    assert_eq!(esc_path("a*b/web[1]/q?/b\\s"), "a\\*b/web\\[1]/q\\?/b\\\\s");
    assert_eq!(
        suggestion(".gitignore", "/.claude/**", ".claude/skills").as_deref(),
        Some("Replace the line /.claude/** with:\n/.claude/*\n!/.claude/skills/")
    );
    assert_eq!(
        suggestion(".gitignore", ".claude/skills/**", ".claude/skills").as_deref(),
        Some("Remove the line .claude/skills/**.")
    );
    assert_eq!(
        suggestion(".gitignore", "app/**", "app/.claude/skills").as_deref(),
        Some("Replace the line app/** with:\napp/*\n!/app/.claude/\n/app/.claude/*\n!/app/.claude/skills/")
    );
    assert_eq!(suggestion(".gitignore", "*.md", ".claude/skills"), None);
    assert_eq!(suggestion(".gitignore", "*/**", ".claude/skills"), None);
}

/// The review's reproductions (round 2): each shape is now either fixed with
/// nothing un-ignored but the skills, or refused with nothing written.
mod regressions {
    use super::*;

    /// Plan and apply what is offered; return what went from ignored to not.
    fn outcome(f: &Fixture, check: &[&str]) -> (IgnorePlan, Vec<String>) {
        let before: Vec<bool> = check.iter().map(|p| ignored(&f.repo, p)).collect();
        let plan = super::super::plan(&f.repo).unwrap();
        if !plan.edits.is_empty() {
            apply(&f.repo, &plan.edits).unwrap();
        }
        let leaked = check
            .iter()
            .zip(before)
            .filter(|(p, was)| *was && !ignored(&f.repo, p))
            .map(|(p, _)| p.to_string())
            .collect();
        (plan, leaked)
    }

    fn refused_nothing_leaked(f: &Fixture, check: &[&str]) -> IgnoreRefusal {
        let (plan, leaked) = outcome(f, check);
        assert!(plan.edits.is_empty(), "{:?}", plan.edits);
        assert!(leaked.is_empty(), "{leaked:?}");
        assert!(ignored(&f.repo, PROBE));
        plan.refused[0].clone()
    }

    const STAR_STAR: Option<&str> = Some("Replace the line .claude/** with:\n.claude/*\n!/.claude/skills/");

    #[test]
    fn c01_a_rule_repeated_after_its_negation() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"*.pem\n!public.pem\n*.pem\n.claude/**\n");
        write(&f.repo.join(".claude/skills/ship-a-card/public.pem"), b"x");
        let r = refused_nothing_leaked(
            &f,
            &[".claude/skills/ship-a-card/public.pem", ".claude/skills/later/public.pem"],
        );
        assert_eq!(r.suggestion.as_deref(), STAR_STAR);
    }

    #[test]
    fn c01c_a_rule_repeated_across_files() {
        let f = fixture();
        write(&f.global, b"*.log\n");
        write(&f.repo.join(".git/info/exclude"), b"!*.log\n");
        write(&f.repo.join(".gitignore"), b"*.log\n.claude/**\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/debug.log"]);
    }

    #[test]
    fn c02_negation_before_and_after() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"*.env\n!example.env\n.claude/**\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/prod.env"]);
    }

    #[test]
    fn c03_nested_anchored_and_middle_slash_rules() {
        let f = fixture();
        write(
            &f.repo.join(".gitignore"),
            b"build/\n/.claude/skills/ship-a-card/secret\n.claude/skills/*/private/\n/.claude/skills/*.key\n",
        );
        write(&f.repo.join(".claude/.gitignore"), b"skills/*/tokens.txt\n*\n");
        write(&f.global, b".DS_Store\n.claude/skills/*/notes/\n");
        refused_nothing_leaked(
            &f,
            &[
                ".claude/skills/ship-a-card/secret",
                ".claude/skills/ship-a-card/private/a",
                ".claude/skills/ship-a-card/build/a",
                ".claude/skills/ship-a-card/tokens.txt",
                ".claude/skills/ship-a-card/notes/a",
                ".claude/skills/x.key",
            ],
        );
    }

    #[test]
    fn c04_escaped_rules() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"\\#secret\nsecret\\ \n\\!bang\nsp  \n.claude/**\n");
        refused_nothing_leaked(
            &f,
            &[
                ".claude/skills/ship-a-card/#secret",
                ".claude/skills/ship-a-card/secret ",
                ".claude/skills/ship-a-card/!bang",
                ".claude/skills/ship-a-card/sp",
            ],
        );
    }

    #[test]
    fn c05_crlf_and_trailing_space() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b".env \r\n*.pem\r\n.claude/**\r\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/.env", ".claude/skills/ship-a-card/k.pem"]);
    }

    #[test]
    fn c06_teammate_excludes_under_a_recursive_rule() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b".env\n.claude/**\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/.env"]);
    }

    #[test]
    fn c07_ignorecase() {
        let f = fixture();
        run(&f.repo, &["config", "core.ignorecase", "true"]);
        write(&f.repo.join(".gitignore"), b".env\n.claude/**\n");
        write(&f.repo.join(".claude/skills/ship-a-card/.ENV"), b"x");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/.ENV"]);
    }

    #[test]
    fn c07b_ignorecase_and_a_name_rule() {
        let f = fixture();
        run(&f.repo, &["config", "core.ignorecase", "true"]);
        write(&f.global, b"SECRETS.MD\n");
        write(&f.repo.join(".gitignore"), b"*.md\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/SECRETS.MD"]);
    }

    #[test]
    fn c07c_ignorecase_with_a_directory_rule_is_fixed_and_keeps_the_upper_case_file() {
        let f = fixture();
        run(&f.repo, &["config", "core.ignorecase", "true"]);
        write(&f.repo.join(".gitignore"), b".env\n.claude/\n");
        write(&f.repo.join(".claude/skills/ship-a-card/.ENV"), b"x");
        let (plan, leaked) = outcome(&f, &[".claude/skills/ship-a-card/.ENV"]);
        assert!(!plan.edits.is_empty(), "{:?}", plan.refused);
        assert!(leaked.is_empty(), "{leaked:?}");
        assert!(!ignored(&f.repo, PROBE));
    }

    #[test]
    fn c08_double_star_prefix_rules() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"**/.terraform/*\n**/secrets/**\n.claude/**\n");
        let r = refused_nothing_leaked(
            &f,
            &[".claude/skills/ship-a-card/.terraform/x", ".claude/skills/ship-a-card/secrets/a"],
        );
        assert_eq!(r.suggestion.as_deref(), STAR_STAR, "a `**/` rule elsewhere doesn't block the advice");
    }

    #[test]
    fn c09_suffix_double_star_rules() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"secrets/**\ntmp/**\n.claude/**\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/secrets/a", "secrets/a"]);
    }

    #[test]
    fn c10_dormant_negation_outside_the_root() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b".claude/\n");
        write(&f.repo.join(".claude/.gitignore"), b"!settings.local.json\n");
        let r = refused_nothing_leaked(&f, &[".claude/settings.local.json"]);
        assert!(r.reason.contains("settings.local.json"), "{}", r.reason);
    }

    #[test]
    fn c11_many_files_under_a_recursive_rule() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"*.pem\n!public.pem\n*.pem\nnode_modules/\n.claude/**\n");
        for i in 0..(walk_max() + 10) {
            write(&f.repo.join(format!(".claude/skills/a-skill/node_modules/p/{i}.js")), b"");
        }
        write(&f.repo.join(".claude/skills/z-skill/public.pem"), b"x");
        refused_nothing_leaked(&f, &[".claude/skills/z-skill/public.pem"]);
    }

    #[test]
    fn c11b_many_ignored_files_under_a_directory_rule_are_not_walked() {
        // node_modules stays ignored after the fix, so it is not descended
        // into and does not count against the limit.
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"node_modules/\n.claude/\n");
        for i in 0..(walk_max() + 10) {
            write(&f.repo.join(format!(".claude/skills/a-skill/node_modules/p/{i}.js")), b"");
        }
        let (plan, leaked) = outcome(&f, &[".claude/skills/a-skill/node_modules/p/1.js"]);
        assert!(!plan.edits.is_empty(), "{:?}", plan.refused);
        assert!(leaked.is_empty(), "{leaked:?}");
    }

    #[test]
    fn c12_many_skills() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b".env\n*.pem\nnode_modules/\n*.log\ncoverage/\n.claude/\n");
        for i in 0..100 {
            write(&f.repo.join(format!(".claude/skills/s{i}/SKILL.md")), SKILL.as_bytes());
            write(&f.repo.join(format!(".claude/skills/s{i}/.env")), b"x");
        }
        let (plan, leaked) = outcome(&f, &[".claude/skills/s1/.env", ".claude/skills/s99/.env"]);
        assert!(!plan.edits.is_empty(), "{:?}", plan.refused);
        assert!(leaked.is_empty(), "{leaked:?}");
    }

    #[test]
    fn c13_whitelist_with_a_secret() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b"*\n!.gitignore\n!*/\n!src/**\n");
        write(&f.repo.join(".claude/skills/ship-a-card/credentials.json"), b"x");
        refused_nothing_leaked(
            &f,
            &[".claude/skills/ship-a-card/credentials.json", ".claude/skills/ship-a-card/.env"],
        );
    }

    #[test]
    fn c14_after_a_partial_manual_edit() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b".env\n.claude/**\n!/.claude/skills/\n");
        refused_nothing_leaked(&f, &[".claude/skills/ship-a-card/.env"]);
    }

    #[test]
    fn c15_directory_rule_and_a_negation_below_it() {
        let f = fixture();
        write(&f.global, b"cache/\n");
        write(&f.repo.join(".gitignore"), b"!keep.txt\n.claude/**\n");
        refused_nothing_leaked(
            &f,
            &[".claude/skills/ship-a-card/cache/keep.txt", ".claude/skills/ship-a-card/cache/x"],
        );
    }

    #[test]
    fn c16_a_rule_naming_skills() {
        let f = fixture();
        write(&f.repo.join(".gitignore"), b".env\nship-*\n");
        refused_nothing_leaked(
            &f,
            &[".claude/skills/ship-a-card/.env", ".claude/skills/ship-a-card/node_modules/x"],
        );
    }
}

/// GH #227: a symbolic link among the skills (or as the root) made the
/// doctor's batched `git check-ignore` fail, so every root read as not
/// ignored and the plan said there was nothing to do.
#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A skill living elsewhere in the repo, linked into `.claude/skills`.
    fn link_skill(f: &Fixture, name: &str) {
        write(&f.repo.join(format!("shared/{name}/SKILL.md")), SKILL.as_bytes());
        symlink(format!("../../shared/{name}"), f.repo.join(format!(".claude/skills/{name}")))
            .unwrap();
    }

    #[test]
    fn a_linked_skill_beside_an_ignored_one_still_gets_the_fix() {
        let f = fixture();
        link_skill(&f, "linked");
        let file = f.repo.join(".gitignore");
        write(&file, format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
        fix_and_hold(&f, &file, &["!/.claude/", "/.claude/*", "!/.claude/skills/"]);
        // Once the root is open, git carries the link itself.
        assert!(!ignored(&f.repo, ".claude/skills/linked"));
    }

    #[test]
    fn a_root_holding_only_links_still_gets_the_fix() {
        let f = fixture();
        std::fs::remove_dir_all(f.repo.join(".claude/skills/ship-a-card")).unwrap();
        link_skill(&f, "one");
        link_skill(&f, "two");
        let file = f.repo.join(".gitignore");
        write(&file, format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
        let plan = super::plan(&f.repo).unwrap();
        assert_eq!(plan.roots, vec![".claude/skills".to_string()]);
        assert_eq!(
            plan.edits[0].lines,
            lines(&[COMMENT, "!/.claude/", "/.claude/*", "!/.claude/skills/"])
        );
        let outcome = apply(&f.repo, &plan.edits).unwrap();
        assert!(outcome.still_ignored.is_empty(), "{outcome:?}");
        assert!(!ignored(&f.repo, ".claude/skills/one"));
        assert!(!ignored(&f.repo, ".claude/skills/two"));
    }

    /// The root itself is a link, and git ignores the link (`.claude/*`
    /// matches it; `!.claude/skills/` names a directory, which a link is
    /// not). Nothing Ply writes for a directory changes that, so the plan
    /// explains it — with the line that does carry a link — and offers no
    /// edit, instead of "no root is ignored".
    #[test]
    fn a_linked_root_git_ignores_is_explained_and_nothing_is_written() {
        let f = fixture();
        std::fs::create_dir_all(f.repo.join("shared")).unwrap();
        std::fs::rename(f.repo.join(".claude/skills"), f.repo.join("shared/skills")).unwrap();
        symlink("../shared/skills", f.repo.join(".claude/skills")).unwrap();
        let file = f.repo.join(".gitignore");
        let text = format!("{SENSITIVE_RULES}.claude/*\n!.claude/skills/\n");
        write(&file, text.as_bytes());
        assert!(ignored(&f.repo, ".claude/skills"), "git ignores the link");

        let plan = super::plan(&f.repo).unwrap();
        assert_eq!(plan.roots, vec![".claude/skills".to_string()]);
        assert!(plan.edits.is_empty(), "{plan:?}");
        assert_eq!(plan.refused.len(), 1, "{plan:?}");
        let refusal = &plan.refused[0];
        assert!(refusal.reason.contains(".claude/skills is a link"), "{}", refusal.reason);
        assert!(!refusal.reason.contains("fatal"), "{}", refusal.reason);
        assert_eq!(refusal.rule, ".gitignore:4: .claude/*");
        let suggestion = refusal.suggestion.clone().unwrap();
        assert!(suggestion.contains("\n!/.claude/skills\n"), "{suggestion}");

        // The suggested line does carry the link: proven against git.
        write(&file, format!("{text}!/.claude/skills\n").as_bytes());
        assert!(!ignored(&f.repo, ".claude/skills"), "the named line carries the link");
        write(&file, text.as_bytes());
        assert_eq!(read(&file), text.as_bytes(), "Plyloft wrote nothing");
    }

    /// Mixed: a fixable Codex root beside a Claude root that is an ignored
    /// link. The Codex lines are offered, the link explained, and the outcome
    /// never says the link is no longer ignored.
    #[test]
    fn a_fixable_root_beside_an_ignored_linked_root() {
        let f = fixture();
        std::fs::create_dir_all(f.repo.join("shared")).unwrap();
        std::fs::rename(f.repo.join(".claude/skills"), f.repo.join("shared/skills")).unwrap();
        symlink("../shared/skills", f.repo.join(".claude/skills")).unwrap();
        write(&f.repo.join(".agents/skills/ship-a-card/SKILL.md"), SKILL.as_bytes());
        let file = f.repo.join(".gitignore");
        write(&file, format!("{SENSITIVE_RULES}.claude/*\n!.claude/skills/\n.agents/\n").as_bytes());

        let plan = super::plan(&f.repo).unwrap();
        assert_eq!(plan.roots, vec![".claude/skills".to_string(), ".agents/skills".to_string()]);
        assert_eq!(plan.edits.len(), 1, "{plan:?}");
        assert_eq!(plan.edits[0].roots, vec![".agents/skills".to_string()]);
        assert_eq!(plan.refused.len(), 1);
        assert_eq!(plan.refused[0].root, ".claude/skills");

        let outcome = apply(&f.repo, &plan.edits).unwrap();
        assert!(outcome.sentence.contains("Git no longer ignores .agents/skills."), "{}", outcome.sentence);
        assert!(!outcome.sentence.contains("no longer ignores .claude"), "{}", outcome.sentence);
        assert!(
            outcome.sentence.contains("Git still ignores .claude/skills (a link)"),
            "{}",
            outcome.sentence
        );
        assert!(ignored(&f.repo, ".claude/skills"), "the link is still ignored");
    }

    /// Review round 2: one skill's link git ignores by a rule of its own
    /// stays ignored after the root is fixed, and the outcome says so.
    #[test]
    fn the_outcome_names_a_skill_link_that_stays_ignored() {
        let f = fixture();
        link_skill(&f, "linked");
        let file = f.repo.join(".gitignore");
        write(&file, format!("{SENSITIVE_RULES}.claude/\nlinked\n").as_bytes());
        let plan = super::plan(&f.repo).unwrap();
        assert_eq!(plan.roots, vec![".claude/skills".to_string()]);
        let outcome = apply(&f.repo, &plan.edits).unwrap();
        assert!(outcome.sentence.contains("Git no longer ignores .claude/skills."), "{}", outcome.sentence);
        assert!(
            outcome.sentence.contains("Git still ignores .claude/skills/linked (a link)"),
            "{}",
            outcome.sentence
        );
        assert!(ignored(&f.repo, ".claude/skills/linked"));
    }

    /// Review round 1 (M1): a skill that is a submodule, beside an ignored
    /// real one, doesn't hide the root from the plan.
    #[test]
    fn a_submodule_skill_beside_an_ignored_one_still_gets_the_fix() {
        let f = fixture();
        let source = TempDir::new().unwrap();
        run(source.path(), &["init", "-q", "."]);
        write(&source.path().join("SKILL.md"), SKILL.as_bytes());
        run(source.path(), &["add", "."]);
        run(
            source.path(),
            &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "s"],
        );
        run(
            &f.repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                source.path().to_str().unwrap(),
                ".claude/skills/sub",
            ],
        );
        let file = f.repo.join(".gitignore");
        write(&file, format!("{SENSITIVE_RULES}.claude/\n").as_bytes());
        let plan = super::plan(&f.repo).unwrap();
        assert_eq!(plan.roots, vec![".claude/skills".to_string()]);
        assert_eq!(
            plan.edits[0].lines,
            lines(&[COMMENT, "!/.claude/", "/.claude/*", "!/.claude/skills/"])
        );
    }

    /// A linked root git carries (as a link): "no root is ignored" is true,
    /// and the plan is empty rather than an error.
    #[test]
    fn a_linked_root_git_carries_has_nothing_to_fix() {
        let f = fixture();
        std::fs::create_dir_all(f.repo.join("shared")).unwrap();
        std::fs::rename(f.repo.join(".claude/skills"), f.repo.join("shared/skills")).unwrap();
        symlink("../shared/skills", f.repo.join(".claude/skills")).unwrap();
        let plan = super::plan(&f.repo).unwrap();
        assert!(plan.roots.is_empty() && plan.edits.is_empty(), "{plan:?}");
    }

    /// A linked root beside an ignored Codex root: the Codex root is still
    /// reported and fixed.
    #[test]
    fn a_linked_claude_root_does_not_hide_an_ignored_codex_root() {
        let f = fixture();
        std::fs::create_dir_all(f.repo.join("shared")).unwrap();
        std::fs::rename(f.repo.join(".claude/skills"), f.repo.join("shared/skills")).unwrap();
        symlink("../shared/skills", f.repo.join(".claude/skills")).unwrap();
        write(&f.repo.join(".agents/skills/ship-a-card/SKILL.md"), SKILL.as_bytes());
        write(&f.repo.join(".gitignore"), format!("{SENSITIVE_RULES}.agents/\n").as_bytes());
        let plan = super::plan(&f.repo).unwrap();
        assert_eq!(plan.roots, vec![".agents/skills".to_string()]);
        assert!(!plan.edits.is_empty(), "{plan:?}");
    }
}
