//! Skills hub H6b: the Install-time sheet and the check where the card is
//! written (R15 AC 1, §12 H6 Tier 4).

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(["-c", "user.name=Ana", "-c", "user.email=ana@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit_all(dir: &Path, message: &str) -> String {
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-q", "--allow-empty", "-m", message]);
    run_git(dir, &["rev-parse", "HEAD"])
}

const SKILL: &str = "library/claude/acme/skills/team-check";

struct Fixture {
    _dir: TempDir,
    config: PathBuf,
    clone: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let config = dir.path().join("config");
        fs::create_dir_all(&config).unwrap();
        let clone = dir.path().join("team").join("acme__team");
        fs::create_dir_all(&clone).unwrap();
        run_git(&clone, &["init", "-q", "-b", "main"]);
        run_git(&clone, &["config", "core.autocrlf", "false"]);
        let plugin = clone.join("library/claude/acme/.claude-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("plugin.json"), r#"{"name":"acme"}"#).unwrap();
        Fixture { _dir: dir, config, clone }
    }

    fn write(&self, rel: &str, text: &[u8]) {
        let path = self.clone.join(SKILL).join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// Write `rel` and record it executable in git, as on a Mac.
    fn script(&self, rel: &str, text: &str) {
        self.write(rel, text.as_bytes());
        // The working tree's mode too, so a later `git add -A` keeps the bit.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = self.clone.join(SKILL).join(rel);
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        run_git(&self.clone, &["add", "-A"]);
        run_git(&self.clone, &["update-index", "--chmod=+x", &format!("{SKILL}/{rel}")]);
    }

    fn commit(&self, message: &str) -> String {
        commit_all(&self.clone, message)
    }

    fn state(&self) -> crate::skills_hub_state::HubState {
        crate::skills_hub_state::load(&self.config)
    }

    /// The skill's files at `rev`, as a repository copy of it would be.
    fn copy_at(&self, rev: &str) -> CopyFiles {
        copy_files(&self.clone, rev, SKILL).unwrap().expect("the skill is there")
    }
}

fn skill_md(f: &Fixture, body: &str) {
    f.write("SKILL.md", format!("---\nname: team-check\ndescription: Check.\n---\n\n{body}\n").as_bytes());
}

#[test]
fn a_library_path_names_its_approval_key() {
    assert_eq!(
        key_of_path("library/claude/acme/skills/team-check"),
        Some(("acme".into(), "team-check".into()))
    );
    assert_eq!(
        key_of_path("library/codex/plugins/acme/skills/team-check"),
        Some(("acme".into(), "team-check".into()))
    );
    assert_eq!(key_of_path("library/claude/acme/skills/team-check/scripts"), None);
    assert_eq!(key_of_path("elsewhere/acme/skills/x"), None);
}

/// Tier 4 step 1: Install of a skill with an executable script shows the
/// sheet — every file, the script first — and the card is written only for
/// the OK that names exactly what is there.
#[test]
fn install_with_a_script_shows_every_file_script_first_and_waits_for_the_ok() {
    let f = Fixture::new();
    skill_md(&f, "Run the check.");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let commit = f.commit("add team-check");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state())
        .unwrap()
        .expect("Install asks");
    let paths: Vec<&str> = review.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, ["scripts/check.sh", "SKILL.md"]);
    assert_eq!(review.files[0].kind, FileKind::Script);
    assert!(review.files[0].executable);
    assert_eq!(review.files[0].text.as_deref(), Some("#!/bin/sh\necho v1\n"));
    assert!(review.files.iter().all(|file| file.change == "new"));
    assert!(review.first_time);
    assert_eq!(review.approved_at, None);
    assert_eq!(review.commit, commit);
    assert_eq!(review.author.as_deref(), Some("Ana"));

    // Without the sheet: refused with the marker the Library opens it by.
    let RepoAnswer::Refused(why) = repo_answer(&f.clone, &commit, SKILL, "team-check", &[], None).unwrap() else {
        panic!("Install without an OK must be refused");
    };
    assert!(why.contains(crate::skill_card::SCRIPTS_WAIT_MARKER) && why.contains("a script"), "{why}");
    // An OK for other scripts (a pull landed under the sheet): refused too.
    let other = vec!["0".repeat(64)];
    let RepoAnswer::Refused(why) = repo_answer(&f.clone, &commit, SKILL, "team-check", &[], Some(&other)).unwrap() else {
        panic!("an OK for other scripts must be refused");
    };
    assert!(why.contains("changed in the team library while you were reading it"), "{why}");
    assert!(why.contains(crate::skill_card::SCRIPTS_WAIT_MARKER), "{why}");
    // The OK the sheet sent.
    assert_eq!(
        repo_answer(&f.clone, &commit, SKILL, "team-check", &[], Some(&review.scripts_ids)).unwrap(),
        RepoAnswer::Confirmed { scripts_id: review.scripts_ids[0].clone() }
    );
}

/// Text-only skill: no sheet beyond the normal Install.
#[test]
fn a_text_only_skill_never_asks() {
    let f = Fixture::new();
    skill_md(&f, "Just words.");
    f.write("notes/table.csv", b"a,b\n1,2\n");
    let commit = f.commit("add");
    assert!(repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state()).unwrap().is_none());
    assert_eq!(repo_answer(&f.clone, &commit, SKILL, "team-check", &[], None).unwrap(), RepoAnswer::Clear);
}

/// The sheet's OK is this Mac's OK for sessions too (the same key), and a
/// later Install still shows the sheet — the repository is everyone's —
/// saying when this version was OK'd here.
#[test]
fn the_ok_is_recorded_for_sessions_and_install_still_shows_the_sheet() {
    let f = Fixture::new();
    skill_md(&f, "Run the check.");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let commit = f.commit("add");
    let held = crate::skill_scripts::holds(&f.clone, &commit, Half::Claude, &f.state()).unwrap();
    assert_eq!(held.len(), 1, "sessions wait for an OK");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state()).unwrap().unwrap();
    record(&f.config, &f.clone, "acme", "team-check", SKILL, &commit, &review.scripts_ids[0], 1_760_000_000_000).unwrap();
    let state = f.state();
    assert!(crate::skill_scripts::holds(&f.clone, &commit, Half::Claude, &state).unwrap().is_empty());
    let approval = state
        .approved(&crate::skill_scripts::origin(&f.clone, "acme"), "team-check", &review.scripts_ids[0])
        .expect("recorded under the H6a key");
    assert_eq!(approval.commit.as_deref(), Some(commit.as_str()));
    // A second Install into another repository asks again, and says so.
    let again = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &state).unwrap().expect("asks");
    assert_eq!(again.approved_at, Some(1_760_000_000_000));
    // Recording twice keeps one approval.
    record(&f.config, &f.clone, "acme", "team-check", SKILL, &commit, &review.scripts_ids[0], 1_760_000_000_001).unwrap();
    assert_eq!(f.state().approvals.len(), 1);
}

/// Tier 4 step 4 (a text-only change → no question) and the Update side of
/// step 2: Update asks only when a script or an extra file is new to the
/// copies here.
#[test]
fn update_asks_only_for_a_script_the_copies_here_do_not_hold() {
    let f = Fixture::new();
    skill_md(&f, "v1");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let first = f.commit("v1");
    let here = vec![f.copy_at(&first)];

    // SKILL.md alone changed upstream: nothing asked.
    skill_md(&f, "v2 words");
    let text_change = f.commit("words");
    assert_eq!(repo_answer(&f.clone, &text_change, SKILL, "team-check", &here, None).unwrap(), RepoAnswer::Clear);
    assert!(repo_review(&f.clone, "acme", "team-check", SKILL, &here, &f.state()).unwrap().is_none());

    // The script changed: the sheet, marking what changed against here.
    f.script("scripts/check.sh", "#!/bin/sh\necho v2\n");
    let script_change = f.commit("script");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &here, &f.state()).unwrap().expect("asks");
    assert!(!review.first_time);
    let change = |path: &str| review.files.iter().find(|file| file.path == path).unwrap().change;
    assert_eq!(change("scripts/check.sh"), "changed");
    assert_eq!(change("SKILL.md"), "changed");
    assert!(matches!(
        repo_answer(&f.clone, &script_change, SKILL, "team-check", &here, None).unwrap(),
        RepoAnswer::Refused(_)
    ));
    // Once the copies here hold that script, a text change is quiet again.
    let here = vec![f.copy_at(&script_change)];
    skill_md(&f, "v3 words");
    let later = f.commit("words again");
    assert_eq!(repo_answer(&f.clone, &later, SKILL, "team-check", &here, None).unwrap(), RepoAnswer::Clear);

    // A script removed upstream writes nothing that runs: no question.
    run_git(&f.clone, &["rm", "-q", &format!("{SKILL}/scripts/check.sh")]);
    let removed = f.commit("drop the script");
    assert_eq!(repo_answer(&f.clone, &removed, SKILL, "team-check", &here, None).unwrap(), RepoAnswer::Clear);
}

/// Every copy here counts: the Codex twin without the script is asked for.
#[test]
fn a_copy_here_without_the_script_is_asked_for() {
    let f = Fixture::new();
    skill_md(&f, "v1");
    let text_only = f.commit("text");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let with_script = f.commit("script");
    let here = vec![f.copy_at(&with_script), f.copy_at(&text_only)];
    assert!(matches!(
        repo_answer(&f.clone, &with_script, SKILL, "team-check", &here, None).unwrap(),
        RepoAnswer::Refused(_)
    ));
}

/// The executable bit alone is a script change (a copy committed from
/// Windows lost it; the update brings it back).
#[test]
fn a_mode_only_change_asks() {
    let f = Fixture::new();
    skill_md(&f, "v1");
    f.write("scripts/check.sh", b"#!/bin/sh\necho v1\n");
    let plain = f.commit("no bit");
    let here = vec![f.copy_at(&plain)];
    run_git(&f.clone, &["update-index", "--chmod=+x", &format!("{SKILL}/scripts/check.sh")]);
    run_git(&f.clone, &["commit", "-q", "-m", "bit"]);
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &here, &f.state()).unwrap().expect("asks");
    let file = review.files.iter().find(|file| file.path == "scripts/check.sh").unwrap();
    assert!(file.executable);
    assert_eq!(file.change, "changed");
}

/// Windows parity: a `.ps1` with no executable bit is a script by its
/// extension, and asks the same.
#[test]
fn a_powershell_script_asks_without_an_executable_bit() {
    let f = Fixture::new();
    skill_md(&f, "Run check.ps1.");
    f.write("scripts/check.ps1", b"Write-Output 'ok'\r\n");
    let commit = f.commit("ps1");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state()).unwrap().expect("asks");
    assert_eq!(review.files[0].path, "scripts/check.ps1");
    assert_eq!(review.files[0].kind, FileKind::Script);
    assert!(!review.files[0].executable);
    let RepoAnswer::Refused(why) = repo_answer(&f.clone, &commit, SKILL, "team-check", &[], None).unwrap() else {
        panic!("asks");
    };
    assert!(why.contains("a script"), "{why}");
}

/// An image is an extra file: asked about, and not called a script.
#[test]
fn an_image_asks_as_a_file_that_is_not_text() {
    let f = Fixture::new();
    skill_md(&f, "See the diagram.");
    f.write("diagram.png", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    let commit = f.commit("image");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state()).unwrap().expect("asks");
    assert_eq!(review.files[0].kind, FileKind::Extra);
    assert_eq!(review.files[0].text, None);
    let RepoAnswer::Refused(why) = repo_answer(&f.clone, &commit, SKILL, "team-check", &[], None).unwrap() else {
        panic!("asks");
    };
    assert!(why.contains("a file that is not text") && !why.contains("a script"), "{why}");
}

/// R15's size rule holds on this sheet too.
#[test]
fn a_large_file_is_listed_without_its_text() {
    let f = Fixture::new();
    skill_md(&f, "Big.");
    let big = format!("#!/bin/sh\n{}\n", "x".repeat((SHOW_FILE_MAX as usize) + 10));
    f.script("scripts/big.sh", &big);
    f.commit("big");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state()).unwrap().expect("asks");
    let file = review.files.iter().find(|file| file.path == "scripts/big.sh").unwrap();
    assert!(file.too_large && file.text.is_none());
    let text = review.files.iter().find(|file| file.path == "SKILL.md").unwrap();
    assert!(text.text.is_some());
}

#[test]
fn copy_files_reads_what_git_records() {
    let f = Fixture::new();
    skill_md(&f, "v1");
    f.script("scripts/check.sh", "#!/bin/sh\n");
    let commit = f.commit("v1");
    let copy = f.copy_at(&commit);
    assert_eq!(copy.len(), 2);
    assert!(copy["scripts/check.sh"].1, "the executable bit, from git");
    assert!(!copy["SKILL.md"].1);
    assert_eq!(copy_files(&f.clone, &commit, "library/claude/acme/skills/none").unwrap(), None);
}

/// Challenger (H6b) with the owner fixes: an OK that follows an upstream
/// rename (same scripts) is "this version, OK'd here" on the Install sheet
/// too — the sheet still asks, as Install always does.
#[test]
fn the_sheet_says_an_ok_that_followed_a_rename() {
    let f = Fixture::new();
    skill_md(&f, "Run the check.");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let commit = f.commit("add");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[], &f.state()).unwrap().unwrap();
    record(&f.config, &f.clone, "acme", "team-check", SKILL, &commit, &review.scripts_ids[0], 1_760_000_000_000).unwrap();
    let parent = f.clone.join("library/claude/acme/skills");
    fs::rename(parent.join("team-check"), parent.join("team-verify")).unwrap();
    f.commit("rename");
    let renamed = "library/claude/acme/skills/team-verify";
    let again = repo_review(&f.clone, "acme", "team-verify", renamed, &[], &f.state()).unwrap().expect("Install still asks");
    assert_eq!(again.scripts_ids, review.scripts_ids, "the same scripts");
    assert!(
        f.state().approved(&crate::skill_scripts::origin(&f.clone, "acme"), "team-verify", &again.scripts_ids[0]).is_none(),
        "no approval under the new name: only the rename lookup finds it"
    );
    assert_eq!(again.approved_at, Some(1_760_000_000_000), "the OK followed the rename");
}

/// A member's repository beside the fixture: `main` holds `team-check`
/// without its script (as `.claude/skills/team-check`), a branch `feat` adds
/// the library's very script, and the checkout is on `feat`.
fn repo_with_script_on_a_branch(f: &Fixture, script: &str) -> PathBuf {
    let repo = f.clone.parent().unwrap().parent().unwrap().join("member-repo");
    let skill = repo.join(".claude/skills/team-check");
    fs::create_dir_all(skill.join("scripts")).unwrap();
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(&repo, &["config", "core.autocrlf", "false"]);
    fs::write(skill.join("SKILL.md"), "---\nname: team-check\ndescription: Check.\n---\n\nv1\n").unwrap();
    commit_all(&repo, "main");
    run_git(&repo, &["checkout", "-q", "-b", "feat"]);
    fs::write(skill.join("scripts/check.sh"), script).unwrap();
    run_git(&repo, &["add", "-A"]);
    run_git(&repo, &["update-index", "--chmod=+x", ".claude/skills/team-check/scripts/check.sh"]);
    run_git(&repo, &["commit", "-q", "-m", "script on a branch"]);
    repo
}

/// Challenger (H6b): an Update card is cut from the target branch, not from
/// the checkout's `HEAD`. A script the checkout's branch already has but the
/// target branch lacks is new where the card writes it, so it asks.
#[test]
fn update_compares_with_the_target_branch_not_head() {
    let f = Fixture::new();
    skill_md(&f, "v1");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let commit = f.commit("v1");
    let repo = repo_with_script_on_a_branch(&f, "#!/bin/sh\necho v1\n");
    let dirs = vec![".claude/skills/team-check".to_string(), ".agents/skills/team-check".to_string()];
    // HEAD (feat) holds the script as the library has it: nothing new there.
    let at_head = copies_at(&repo, &["HEAD"], &dirs);
    assert_eq!(at_head.len(), 1);
    assert_eq!(repo_answer(&f.clone, &commit, SKILL, "team-check", &at_head, None).unwrap(), RepoAnswer::Clear);
    // The target branch (no origin here: `refs/heads/main`) lacks it: asks.
    let at_target = copies_at(&repo, &["refs/remotes/origin/main", "refs/heads/main", "HEAD"], &dirs);
    assert_eq!(at_target.len(), 1);
    assert!(!at_target[0].contains_key("scripts/check.sh"));
    let RepoAnswer::Refused(why) = repo_answer(&f.clone, &commit, SKILL, "team-check", &at_target, None).unwrap() else {
        panic!("the target branch lacks the script, so the update asks");
    };
    assert!(why.contains(crate::skill_card::SCRIPTS_WAIT_MARKER), "{why}");
    // A target branch without the skill at all is one empty copy: it asks.
    run_git(&repo, &["checkout", "-q", "--orphan", "bare"]);
    run_git(&repo, &["rm", "-rqf", "--cached", "."]);
    run_git(&repo, &["commit", "-q", "--allow-empty", "-m", "no skill"]);
    let none = copies_at(&repo, &["refs/heads/bare"], &dirs);
    assert_eq!(none, vec![CopyFiles::new()]);
    assert!(matches!(
        repo_answer(&f.clone, &commit, SKILL, "team-check", &none, None).unwrap(),
        RepoAnswer::Refused(_)
    ));
    // No rev resolves: no copies (every file is new).
    assert!(copies_at(&repo, &["refs/heads/nope"], &dirs).is_empty());
}

/// Challenger (H6b): the sheet's words follow what is new. An Update whose
/// only new file is an image says "a file that is not text", and a file one
/// copy here lacks is never shown as unchanged.
#[test]
fn an_update_names_what_is_new_against_every_copy() {
    let f = Fixture::new();
    skill_md(&f, "v1");
    f.script("scripts/check.sh", "#!/bin/sh\necho v1\n");
    let first = f.commit("v1");
    let claude = f.copy_at(&first);
    f.write("diagram.png", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    let image = f.commit("image");
    let here = vec![claude.clone()];
    let RepoAnswer::Refused(why) = repo_answer(&f.clone, &image, SKILL, "team-check", &here, None).unwrap() else {
        panic!("the new image asks");
    };
    assert!(why.contains("a file that is not text") && !why.contains("a script"), "{why}");

    // The Codex twin lacks the script: it is not "unchanged" on the sheet.
    let mut codex = claude.clone();
    codex.remove("scripts/check.sh");
    let review = repo_review(&f.clone, "acme", "team-check", SKILL, &[claude, codex], &f.state())
        .unwrap()
        .expect("asks");
    let change = |path: &str| review.files.iter().find(|file| file.path == path).unwrap().change;
    assert_eq!(change("scripts/check.sh"), "changed");
    assert_eq!(change("diagram.png"), "new");
    assert_eq!(change("SKILL.md"), "unchanged");
}
