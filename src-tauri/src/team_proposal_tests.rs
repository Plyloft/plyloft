use super::*;
use std::path::PathBuf;

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

/// A bare "GitHub" repository and the team clone of it, one commit with a
/// skill in both halves.
struct Team {
    _root: tempfile::TempDir,
    bare: PathBuf,
    clone: PathBuf,
}

const SKILL: &str = "library/claude/acme/skills/review-rules";

fn team() -> Team {
    let root = tempfile::tempdir().unwrap();
    let bare = root.path().join("team.git");
    let seed = root.path().join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(root.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
    ] {
        git(&seed, args);
    }
    let file = seed.join(SKILL).join("SKILL.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "Read the diff.\n").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-q", "-m", "seed"]);
    git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&seed, &["push", "-q", "origin", "main"]);
    let clone = root.path().join("clone");
    git(root.path(), &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
    git(&clone, &["config", "user.email", "t@t"]);
    git(&clone, &["config", "user.name", "t"]);
    Team { _root: root, bare, clone }
}

fn request<'a>(team: &'a Team, parent: &'a str, paths: &'a [String], reuse: bool) -> Request<'a> {
    Request {
        clone: &team.clone,
        slug: "acme/team",
        base_branch: "main",
        branch: "plyloft/skill-review-rules-20261018-1200",
        parent,
        paths,
        message: "skills: propose review-rules",
        title: "Skill: review-rules",
        body: "Proposed from Plyloft.",
        reuse,
    }
}

fn edit(text: &'static str) -> impl FnOnce(&Path) -> Result<(), String> {
    move |wt: &Path| std::fs::write(wt.join(SKILL).join("SKILL.md"), text).map_err(|e| e.to_string())
}

#[test]
fn a_branch_is_named_for_the_skill_and_the_minute() {
    let at = chrono::Local.with_ymd_and_hms(2026, 10, 18, 9, 5, 0).unwrap();
    assert_eq!(branch_name("review-rules", at), "plyloft/skill-review-rules-20261018-0905");
    assert_eq!(title("review-rules"), "Skill: review-rules");
}
use chrono::TimeZone;

/// §12 H4 Tests: the 403 message and the protected-branch fallback start
/// from git's own words.
#[test]
fn a_refused_push_is_read_only_or_takes_pull_requests() {
    let cases = [
        ("remote: Permission to acme/team.git denied to ana.\nfatal: unable to access 'https://github.com/acme/team.git/': The requested URL returned error: 403", Some(PushRefusal::ReadOnly)),
        ("remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)", Some(PushRefusal::TakesPullRequests)),
        ("remote: error: GH013: Repository rule violations found for refs/heads/main.", Some(PushRefusal::TakesPullRequests)),
        (" ! [rejected]        main -> main (fetch first)", None),
        // H4 Challenger step 13: no sign-in is no answer about access — on a
        // Mac, on Windows (Git Credential Manager), and GitHub refusing it.
        ("git push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled", Some(PushRefusal::SignIn)),
        ("git push failed: fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled", Some(PushRefusal::SignIn)),
        ("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/team.git/'", Some(PushRefusal::SignIn)),
        ("remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/team.git/'", Some(PushRefusal::SignIn)),
        ("fatal: could not read Password for 'https://ana@github.com': terminal prompts disabled", Some(PushRefusal::SignIn)),
        ("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", Some(PushRefusal::SignIn)),
        // Challenger: Plyloft's account scope refusing to start git at all.
        ("git push: Your team uses the GitHub account ana, which isn't signed in on this PC. Sign it in in Setup's GitHub step, or leave the team and join it again with another account.", Some(PushRefusal::SignIn)),
        ("fatal: unable to access: Could not resolve host: github.com", None),
    ];
    for (detail, want) in cases {
        assert_eq!(push_refusal(detail), want, "{detail}");
    }
    let words = read_only_words(Some("matteo"));
    assert!(words.starts_with("You can read the team library but not change it. Ask matteo for write access"), "{words}");
    assert!(words.contains("pull request from a fork on GitHub"));
    assert!(read_only_words(None).contains("Ask the team's owner"));
}

#[test]
fn the_default_branch_is_the_one_the_clone_tracks() {
    let team = team();
    assert_eq!(default_branch(&team.clone).unwrap(), "main");
    assert_eq!(upstream_commit(&team.clone).unwrap(), git(&team.clone, &["rev-parse", "HEAD"]).trim());
}

/// H4 (Challenger, the hard rule): a proposal pushes only to a branch of its
/// own — never the default branch, whatever a stored proposal names — and
/// is refused before any commit or push.
#[test]
fn a_proposal_never_pushes_to_the_default_branch() {
    assert!(branch_allowed("plyloft/skill-review-rules-20261018-1200", "main"));
    for bad in ["main", "plyloft/skill-", "feature/x", "plyloft/skill-x/../main", "plyloft/skill-x/"] {
        assert!(!branch_allowed(bad, "main"), "{bad}");
    }
    assert!(!branch_allowed("plyloft/skill-x", "plyloft/skill-x"), "the base branch itself");
    let team = team();
    let main_before = git(&team.bare, &["rev-parse", "main"]).trim().to_string();
    let paths = vec![SKILL.to_string()];
    let mut to_main = request(&team, &main_before, &paths, false);
    to_main.branch = "main";
    let gh = Gh::new("gh-is-never-run".to_string());
    let refused = open(&to_main, &gh, edit("Pushed over main?\n")).unwrap_err();
    assert!(matches!(&refused, ProposalError::Failed(why) if why.contains("never on main")), "{refused:?}");
    assert_eq!(git(&team.bare, &["rev-parse", "main"]).trim(), main_before);
    assert_eq!(git(&team.clone, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
}

/// The proposal's commit is made beside the clone: its checkout, its index
/// and its branch are exactly as they were, and no worktree is left behind.
#[test]
fn a_proposal_commit_never_touches_the_clone_checkout() {
    let team = team();
    let head = git(&team.clone, &["rev-parse", "HEAD"]).trim().to_string();
    let paths = vec![SKILL.to_string()];
    let sha = commit_in_scratch(&request(&team, &head, &paths, false), edit("Read the whole diff.\n")).unwrap();
    assert_ne!(sha, head);
    assert_eq!(git(&team.clone, &["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(git(&team.clone, &["status", "--porcelain"]).trim(), "");
    assert_eq!(std::fs::read_to_string(team.clone.join(SKILL).join("SKILL.md")).unwrap(), "Read the diff.\n");
    assert_eq!(git(&team.clone, &["show", &format!("{sha}:{SKILL}/SKILL.md")]), "Read the whole diff.\n");
    assert_eq!(git(&team.clone, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
    // A write that changes nothing proposes nothing.
    assert_eq!(
        commit_in_scratch(&request(&team, &head, &paths, false), edit("Read the diff.\n")),
        Err(ProposalError::NothingToPropose)
    );
    // A path the write may not touch isn't staged.
    let other = vec!["library/claude/acme/skills/other".to_string()];
    assert_eq!(
        commit_in_scratch(&request(&team, &head, &other, false), edit("Changed outside.\n")),
        Err(ProposalError::NothingToPropose)
    );
}

#[cfg(unix)]
fn fake_gh(dir: &Path) -> Gh {
    let script = dir.join("gh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s ' \"$@\" >> \"{d}/gh.log\"\nprintf '\\n' >> \"{d}/gh.log\"\n\
             case \"$1 $2\" in\n  \"pr create\") echo https://github.com/acme/team/pull/31 ;;\n  \
             \"pr list\") echo 'https://github.com/acme/team/pull/31 OPEN main' ;;\nesac\n",
            d = dir.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    Gh::new(script.to_string_lossy().into_owned())
}

/// R3/R7: the proposal is pushed to its own branch only — the default
/// branch on GitHub is unchanged — and the pull request is opened on the
/// team repository; a second proposal adds a commit to the same branch and
/// keeps the one pull request.
#[cfg(unix)]
#[test]
fn a_proposal_pushes_its_branch_and_opens_one_pull_request() {
    let team = team();
    let gh_dir = tempfile::tempdir().unwrap();
    let gh = fake_gh(gh_dir.path());
    let main_before = git(&team.bare, &["rev-parse", "main"]).trim().to_string();
    let paths = vec![SKILL.to_string()];
    let opened = open(&request(&team, &main_before, &paths, false), &gh, edit("Read the whole diff.\n")).unwrap();
    assert_eq!(opened.number, Some(31));
    assert_eq!(git(&team.bare, &["rev-parse", "main"]).trim(), main_before, "the default branch is never pushed");
    assert_eq!(git(&team.bare, &["rev-parse", &opened.branch]).trim(), opened.commit);
    let log = std::fs::read_to_string(gh_dir.path().join("gh.log")).unwrap();
    assert!(log.contains("pr create --repo acme/team --base main --head plyloft/skill-review-rules-20261018-1200 --title Skill: review-rules"), "{log}");

    let again = open(&request(&team, &opened.commit, &paths, true), &gh, edit("Read the whole diff, twice.\n")).unwrap();
    assert_eq!(again.url, opened.url);
    assert_eq!(git(&team.bare, &["rev-parse", &again.branch]).trim(), again.commit);
    assert_eq!(git(&team.bare, &["rev-parse", &format!("{}^", again.commit)]).trim(), opened.commit);
    let log = std::fs::read_to_string(gh_dir.path().join("gh.log")).unwrap();
    assert_eq!(log.matches("pr create").count(), 1, "{log}");
}

/// R7: once a refused push's change is elsewhere, the clone goes back to
/// GitHub's tip — only when its `HEAD` is exactly that one commit.
#[test]
fn a_refused_commit_is_dropped_only_when_it_is_the_one_commit_ahead() {
    let team = team();
    let tip = git(&team.clone, &["rev-parse", "HEAD"]).trim().to_string();
    std::fs::write(team.clone.join(SKILL).join("SKILL.md"), "Mine.\n").unwrap();
    git(&team.clone, &["commit", "-qam", "mine"]);
    let mine = git(&team.clone, &["rev-parse", "HEAD"]).trim().to_string();
    assert!(!drop_refused_commit(&team.clone, &tip).unwrap(), "not HEAD");
    assert!(drop_refused_commit(&team.clone, &mine).unwrap());
    assert_eq!(git(&team.clone, &["rev-parse", "HEAD"]).trim(), tip);
    assert_eq!(std::fs::read_to_string(team.clone.join(SKILL).join("SKILL.md")).unwrap(), "Read the diff.\n");
}
