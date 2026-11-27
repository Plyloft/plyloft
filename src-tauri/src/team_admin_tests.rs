//! v1.118.0 (team sharing rung 5) — the owner's side of a team.
//!
//! Two builders carry this rung, and they are what these tests are mostly
//! about: the **invite plan**, which is the list of grants the owner reads
//! before Ply touches GitHub, and the **discovery filter**, which decides
//! what is worth proposing as a team workspace. Both are pure, so both are
//! stated here without a GitHub account.
//!
//! The create-team half drives real `git` against a local bare remote, the
//! way rung 2's library tests do: no network, but a genuine commit and push,
//! because "the manifest reached the remote" is the only claim that matters.

use super::*;
use crate::team::parse_manifest;
use std::path::PathBuf;
use tempfile::TempDir;

fn manifest(json: &str) -> TeamManifest {
    parse_manifest(json.as_bytes()).expect("fixture manifest parses")
}

/// The team the acceptance journey builds: one owner, one member, two
/// workspaces.
fn team() -> TeamManifest {
    manifest(
        r#"{"schemaVersion":1,"name":"MB Adv",
            "members":[{"login":"MatteoB-adv","owner":true},{"login":"minidev"}],
            "workspaces":[{"repo":"MatteoB-adv/atelier"},{"repo":"MatteoB-adv/other"}]}"#,
    )
}

// ── Names ───────────────────────────────────────────────────────────

/// "GitHub answered: no access anywhere" — the plan a real lookup yields for
/// a newcomer. Since the 6th Challenger round on PR #29 an *unanswered*
/// lookup is unresolved and grants nothing, so tests that mean "no access"
/// have to say so.
fn no_access(team_repo: &str, manifest: &crate::team::TeamManifest) -> Vec<(String, CollaboratorAccess)> {
    std::iter::once(team_repo.to_string())
        .chain(manifest.workspaces.iter().map(|w| w.repo.clone()))
        .map(|repo| (repo, CollaboratorAccess::None))
        .collect()
}

#[test]
fn a_login_is_letters_digits_and_single_inner_hyphens() {
    for good in ["minidev", "MatteoB-adv", "a", "a-b-c", "x1"] {
        assert!(is_valid_login(good), "{good} should be a login");
    }
    for bad in [
        "",
        "-lead",
        "trail-",
        "double--hyphen",
        "has space",
        "has/slash",
        "under_score",
        "a@b",
        &"x".repeat(40),
    ] {
        assert!(!is_valid_login(bad), "{bad:?} should not be a login");
    }
}

/// The Rust slugify and `scripts/team-init.sh`'s must agree, or a team
/// created in Ply and one created by the script would get different repo
/// names for the same team.
#[test]
fn the_suggested_repo_matches_what_team_init_would_have_picked() {
    assert_eq!(
        suggest_team_repo("MatteoB-adv", "MB Adv"),
        "MatteoB-adv/mb-adv-team"
    );
    assert_eq!(slugify("  Two   Words!! "), "two-words");
    assert_eq!(slugify("---"), "");
    // F6 (team walk): a name already ending in "team" is not doubled.
    assert_eq!(
        suggest_team_repo("test-owner", "Plyloft test team"),
        "test-owner/plyloft-test-team"
    );
    assert_eq!(suggest_team_repo("o", "Team"), "o/team");
    assert_eq!(suggest_team_repo("o", "The A-Team!"), "o/the-a-team");
    assert_eq!(suggest_team_repo("o", "Dreamteam"), "o/dreamteam-team");
    assert_eq!(suggest_team_repo("o", "Teams"), "o/teams-team");
    // Nothing to suggest is empty rather than a repo named `/-team`.
    assert_eq!(suggest_team_repo("MatteoB-adv", "!!!"), "");
    assert_eq!(suggest_team_repo("", "MB Adv"), "");
}

// ── Who may act ─────────────────────────────────────────────────────

/// Ply's own check is the *only* enforcement of "the owner is the only
/// person who edits members and team workspaces": GitHub write access is
/// repository-wide, so any member with write could push a manifest edit.
#[test]
fn only_the_owner_edits_the_team_and_every_refusal_says_why() {
    assert!(authorize_owner_action(true, Some("MatteoB-adv"), Some("MatteoB-adv")).is_ok());
    // Logins are case-insensitive on GitHub; a capital letter is not a
    // reason to lock the owner out of their own team.
    assert!(authorize_owner_action(true, Some("matteob-adv"), Some("MatteoB-ADV")).is_ok());

    // Launch G3: no Team plan is said as the team gate says it, never a key.
    let no_plan = authorize_owner_action(false, Some("MatteoB-adv"), Some("MatteoB-adv"))
        .unwrap_err();
    assert!(no_plan.starts_with(crate::license::TEAM_PLAN_LEAD), "{no_plan}");
    assert!(!no_plan.contains("team key"), "{no_plan}");

    let no_owner = authorize_owner_action(true, None, Some("MatteoB-adv")).unwrap_err();
    assert!(no_owner.contains("names no owner"), "{no_owner}");

    // Unknown login refuses here, and deliberately does *not* refuse for
    // membership: refusing an edit costs a retry, and getting it wrong costs
    // the team's definition of itself.
    let unknown = authorize_owner_action(true, Some("MatteoB-adv"), None).unwrap_err();
    assert!(unknown.contains("could not read your GitHub login"), "{unknown}");

    let not_owner =
        authorize_owner_action(true, Some("MatteoB-adv"), Some("minidev")).unwrap_err();
    assert!(not_owner.contains("MatteoB-adv"), "{not_owner}");
    assert!(not_owner.contains("minidev"), "{not_owner}");
}

// ── The invite plan ─────────────────────────────────────────────────

/// The rung's central claim: an invite is not one grant, it is one per
/// repository the team owns — the team repo *and* every team workspace —
/// and the owner sees all of them before anything is sent.
#[test]
fn an_invite_plan_lists_the_team_repo_and_every_team_workspace() {
    let plan = build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &no_access("MatteoB-adv/mb-adv-team", &team())).unwrap();
    let repos: Vec<&str> = plan.steps.iter().map(|s| s.repo.as_str()).collect();
    assert_eq!(
        repos,
        vec![
            "MatteoB-adv/mb-adv-team",
            "MatteoB-adv/atelier",
            "MatteoB-adv/other"
        ]
    );
    assert_eq!(plan.steps[0].kind, InviteRepoKind::TeamRepo);
    assert_eq!(plan.steps[1].kind, InviteRepoKind::Workspace);
    // One permission, on every repo, and it is write: sharing into the team
    // library is a push, and so is working a card.
    assert!(plan.steps.iter().all(|s| s.permission == "push"));
    // Already listed in the manifest, so nothing to write there.
    assert!(!plan.adds_to_manifest);
    assert!(plan.warnings.is_empty());
}

#[test]
fn a_person_the_manifest_does_not_list_yet_gets_a_manifest_write() {
    let plan = build_invite_plan("newcomer", "MatteoB-adv/mb-adv-team", &team(), &no_access("MatteoB-adv/mb-adv-team", &team())).unwrap();
    assert!(plan.adds_to_manifest);
    assert!(!plan.is_empty());
}

/// GitHub's answer decides each line, and only a measured push right is
/// "nothing to do". An unknown answer is unresolved, not a grant: the PUT
/// sets the permission it names, so a "needless" grant to an admin would
/// take admin away (6th Challenger round on PR #29).
#[test]
fn what_github_already_grants_decides_each_line_and_unknown_is_unresolved() {
    let access = vec![
        (
            "MatteoB-adv/mb-adv-team".to_string(),
            CollaboratorAccess::Write,
        ),
        ("MatteoB-adv/atelier".to_string(), CollaboratorAccess::Read),
        ("MatteoB-adv/other".to_string(), CollaboratorAccess::None),
    ];
    let plan =
        build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &access).unwrap();
    assert_eq!(plan.steps[0].action, InviteAction::AlreadyHas);
    assert_eq!(plan.steps[0].current, "write");
    // Read is not enough: a member who cannot push cannot share into the
    // library, and cannot push a card branch either.
    assert_eq!(plan.steps[1].action, InviteAction::Grant);
    assert_eq!(plan.steps[1].current, "read");
    assert_eq!(plan.steps[2].action, InviteAction::Grant);
    assert_eq!(plan.steps[2].current, "no access");

    // An answer GitHub did not give is shown as unresolved, never planned
    // as a grant, and such a plan is not "nothing to do" either.
    let unanswered = build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &[])
        .unwrap();
    assert!(unanswered
        .steps
        .iter()
        .all(|s| s.action == InviteAction::Unresolved && s.current == "unknown"));
    assert!(unanswered.grants().is_empty(), "nothing is granted on a guess");
    assert!(!unanswered.is_empty());

    // Admin already covers push.
    let admin = vec![(
        "MatteoB-adv/atelier".to_string(),
        CollaboratorAccess::Admin,
    )];
    let plan =
        build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &admin).unwrap();
    assert_eq!(plan.steps[1].action, InviteAction::AlreadyHas);
}

#[test]
fn a_plan_that_grants_and_writes_nothing_says_so() {
    let access = vec![
        (
            "MatteoB-adv/mb-adv-team".to_string(),
            CollaboratorAccess::Write,
        ),
        ("MatteoB-adv/atelier".to_string(), CollaboratorAccess::Admin),
        ("MatteoB-adv/other".to_string(), CollaboratorAccess::Write),
    ];
    let plan =
        build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &access).unwrap();
    assert!(plan.is_empty());
    assert!(plan.grants().is_empty());
}

/// A manifest is hand-editable, so a workspace slug can be nonsense. It is
/// named on the confirmation screen rather than dropped: a member silently
/// missing one workspace is exactly the failure this screen exists to stop.
#[test]
fn a_workspace_slug_ply_cannot_grant_is_named_not_dropped() {
    let broken = manifest(
        r#"{"schemaVersion":1,"name":"MB Adv","members":[{"login":"MatteoB-adv","owner":true}],
            "workspaces":[{"repo":"MatteoB-adv/atelier"},{"repo":"not a repo"}]}"#,
    );
    let plan = build_invite_plan("minidev", "MatteoB-adv/team", &broken, &[]).unwrap();
    assert_eq!(plan.steps.len(), 2);
    assert_eq!(plan.warnings.len(), 1);
    assert!(plan.warnings[0].contains("not a repo"), "{:?}", plan.warnings);
}

/// The team repo appearing in the workspace list too must not become two
/// lines for the same repository — the owner would read it as two grants.
#[test]
fn the_team_repo_is_one_line_even_if_the_manifest_also_lists_it() {
    let odd = manifest(
        r#"{"schemaVersion":1,"name":"MB Adv","members":[{"login":"MatteoB-adv","owner":true}],
            "workspaces":[{"repo":"MatteoB-adv/team"},{"repo":"MatteoB-adv/atelier"},
                          {"repo":"matteob-adv/atelier"}]}"#,
    );
    let plan = build_invite_plan("minidev", "MatteoB-adv/team", &odd, &[]).unwrap();
    let repos: Vec<&str> = plan.steps.iter().map(|s| s.repo.as_str()).collect();
    assert_eq!(repos, vec!["MatteoB-adv/team", "MatteoB-adv/atelier"]);
}

#[test]
fn a_plan_refuses_a_login_or_a_team_repo_it_could_not_act_on() {
    let bad_login = build_invite_plan("not a login", "MatteoB-adv/team", &team(), &[])
        .unwrap_err();
    assert!(bad_login.contains("not a GitHub login"), "{bad_login}");
    let bad_repo = build_invite_plan("minidev", "nonsense", &team(), &[]).unwrap_err();
    assert!(bad_repo.contains("owner/name"), "{bad_repo}");
}

// ── The confirmation is worth something ─────────────────────────────

/// The whole point of the screen: Ply may not grant anything the owner did
/// not read. A plan that *shrank* between the review and the press is
/// covered by what was confirmed; one that grew is not.
#[test]
fn a_grant_the_owner_did_not_read_refuses_and_a_smaller_plan_does_not() {
    let reviewed = build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &no_access("MatteoB-adv/mb-adv-team", &team()))
        .unwrap();

    // Exactly what was reviewed.
    assert!(grants_were_confirmed(&reviewed, &reviewed.digest).is_ok());

    // A third workspace appeared in the manifest in between: a repository
    // the owner never saw would be granted, so the press is refused.
    let grown = manifest(
        r#"{"schemaVersion":1,"name":"MB Adv","members":[{"login":"MatteoB-adv","owner":true}],
            "workspaces":[{"repo":"MatteoB-adv/atelier"},{"repo":"MatteoB-adv/other"},
                          {"repo":"MatteoB-adv/secrets"}]}"#,
    );
    let fresh = build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &grown, &no_access("MatteoB-adv/mb-adv-team", &grown)).unwrap();
    let refused = grants_were_confirmed(&fresh, &reviewed.digest).unwrap_err();
    assert!(refused.contains("matteob-adv/secrets"), "{refused}");

    // Somebody else granted one of them in the meantime: fewer grants than
    // the owner approved, which needs no second look.
    let partly_done = vec![(
        "MatteoB-adv/other".to_string(),
        CollaboratorAccess::Write,
    )];
    let smaller =
        build_invite_plan("minidev", "MatteoB-adv/mb-adv-team", &team(), &partly_done).unwrap();
    assert!(grants_were_confirmed(&smaller, &reviewed.digest).is_ok());
}

#[test]
fn the_digest_is_stable_whatever_order_the_manifest_is_in() {
    let one = build_invite_plan("minidev", "MatteoB-adv/team", &team(), &no_access("MatteoB-adv/team", &team())).unwrap();
    let reordered = manifest(
        r#"{"schemaVersion":1,"name":"MB Adv","members":[{"login":"MatteoB-adv","owner":true}],
            "workspaces":[{"repo":"MatteoB-adv/other"},{"repo":"MatteoB-adv/atelier"}]}"#,
    );
    let two = build_invite_plan("minidev", "MatteoB-adv/team", &reordered, &no_access("MatteoB-adv/team", &reordered)).unwrap();
    assert_eq!(one.digest, two.digest);
}

// ── The manifest edits ──────────────────────────────────────────────

#[test]
fn adding_a_member_or_a_workspace_is_idempotent() {
    let base = team();
    assert!(manifest_with_member(&base, "minidev").is_none());
    // Case-insensitively, because GitHub logins are.
    assert!(manifest_with_member(&base, "MINIDEV").is_none());
    let grown = manifest_with_member(&base, "third").expect("a new member is added");
    assert_eq!(grown.members.len(), 3);
    assert!(!grown.members[2].owner, "a new member is never the owner");

    assert!(manifest_with_workspace(&base, "MatteoB-adv/atelier", None).is_none());
    let with_ws = manifest_with_workspace(&base, "MatteoB-adv/new", Some(" Shiny "))
        .expect("a new workspace is added");
    assert_eq!(with_ws.workspaces.len(), 3);
    assert_eq!(with_ws.workspaces[2].name.as_deref(), Some("Shiny"));
    // An empty display name is `None`, not `Some("")` — the repo's own
    // `workspace_default.json` should win, and a blank string would not
    // let it.
    let blank = manifest_with_workspace(&base, "MatteoB-adv/blank", Some("   ")).unwrap();
    assert_eq!(blank.workspaces[2].name, None);
}

/// QoL 14.4 (G25): removing a team workspace takes only that entry off the
/// list, case-insensitively, and is a no-op when it isn't listed.
#[test]
fn removing_a_workspace_takes_only_its_entry_off_the_list() {
    let base = team();
    assert!(manifest_without_workspace(&base, "MatteoB-adv/not-listed").is_none());
    let before = base.workspaces.len();
    let shrunk = manifest_without_workspace(&base, " matteob-ADV/atelier ").expect("listed");
    assert_eq!(shrunk.workspaces.len(), before - 1);
    assert!(!shrunk.workspaces.iter().any(|w| w.repo.eq_ignore_ascii_case("MatteoB-adv/atelier")));
    assert_eq!(shrunk.members, base.members, "members are never touched");
}

/// Whatever Ply writes has to be what `team::parse_manifest` reads back —
/// the manifest is the team, and a round trip that lost a field would lose
/// members.
#[test]
fn a_written_manifest_parses_back_identically() {
    let plan = plan_create_team(
        "MB Adv",
        "MatteoB-adv/mb-adv-team",
        "MatteoB-adv",
        &["MatteoB-adv/atelier".to_string()],
    )
    .unwrap();
    let bytes = manifest_bytes(&plan.manifest()).unwrap();
    assert!(bytes.ends_with(b"\n"), "the file ends with a newline");
    let read_back = parse_manifest(&bytes).unwrap();
    assert_eq!(read_back, plan.manifest());
    assert_eq!(read_back.owner_login(), Some("MatteoB-adv"));
    assert_eq!(read_back.workspaces[0].repo, "MatteoB-adv/atelier");
}

// ── Create team: the form ───────────────────────────────────────────

#[test]
fn the_create_form_refuses_what_would_become_a_repository_on_github() {
    let ok = plan_create_team("MB Adv", "MatteoB-adv/mb-adv-team", "MatteoB-adv", &[]).unwrap();
    assert!(ok.workspaces.is_empty(), "a team with no workspaces is fine");

    let unnamed = plan_create_team("  ", "MatteoB-adv/x", "MatteoB-adv", &[]).unwrap_err();
    assert!(unnamed.contains("needs a name"), "{unnamed}");

    let bad_repo = plan_create_team("MB Adv", "not-a-slug", "MatteoB-adv", &[]).unwrap_err();
    assert!(bad_repo.contains("owner/name"), "{bad_repo}");

    // A blank repo takes the suggestion, computed here rather than in the
    // form: the name that becomes a repository on GitHub comes from one
    // place.
    let suggested = plan_create_team("MB Adv", "  ", "MatteoB-adv", &[]).unwrap();
    assert_eq!(suggested.repo, "MatteoB-adv/mb-adv-team");
    let unsuggestable = plan_create_team("!!!", "", "MatteoB-adv", &[]).unwrap_err();
    assert!(unsuggestable.contains("cannot suggest"), "{unsuggestable}");

    let no_login = plan_create_team("MB Adv", "MatteoB-adv/x", "", &[]).unwrap_err();
    assert!(no_login.contains("GitHub login"), "{no_login}");

    let bad_ws = plan_create_team(
        "MB Adv",
        "MatteoB-adv/x",
        "MatteoB-adv",
        &["../etc".to_string()],
    )
    .unwrap_err();
    assert!(bad_ws.contains("owner/name"), "{bad_ws}");

    // The team repo holds the manifest and the library; it is never also a
    // workspace, and a team that listed it would clone it twice.
    let itself = plan_create_team(
        "MB Adv",
        "MatteoB-adv/x",
        "MatteoB-adv",
        &["MatteoB-adv/x".to_string()],
    )
    .unwrap_err();
    assert!(itself.contains("team repo itself"), "{itself}");

    // The same repo twice is one workspace, not a refusal.
    let deduped = plan_create_team(
        "MB Adv",
        "MatteoB-adv/x",
        "MatteoB-adv",
        &["MatteoB-adv/a".to_string(), "matteob-adv/a".to_string()],
    )
    .unwrap();
    assert_eq!(deduped.workspaces.len(), 1);
}

/// A name with a line break makes the panel
/// header wrong, and is never what anybody meant.
#[test]
fn a_team_name_with_control_characters_is_refused() {
    let error = plan_create_team("MB\nAdv", "owner/team", "MatteoB-adv", &[]).unwrap_err();
    assert!(error.contains("control characters"), "{error}");
}

// ── Create team: against a real git ─────────────────────────────────

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

fn capture(dir: &Path, args: &[&str]) -> String {
    let output = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8_lossy(&output.stdout).to_string()
}

/// A bare repository standing in for the one `gh repo create` would have
/// made, with one commit so it can be cloned.
fn empty_remote(root: &Path) -> PathBuf {
    let bare = root.join("origin.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare", "--initial-branch=main", "."]);
    let seed = root.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "--initial-branch=main", "."]);
    std::fs::write(seed.join(".gitignore"), "").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-m", "seed"]);
    git(&seed, &["remote", "add", "origin", &bare.to_string_lossy()]);
    git(&seed, &["push", "-u", "origin", "main"]);
    bare
}

/// Commit + push the way the production wrapper does, with a git identity
/// so the temp clone can commit at all.
fn publish(dir: &Path, paths: &[String], message: &str) -> Result<(), String> {
    git(dir, &["config", "user.name", "Plyloft Test"]);
    git(dir, &["config", "user.email", "test@example.invalid"]);
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str));
    git(dir, &add);
    git(dir, &["commit", "-m", message]);
    git(dir, &["push"]);
    Ok(())
}

/// Clone a bare remote into `dest`, the way `gh repo clone` would.
fn clone_from(root: &Path, bare: &Path, dest: &Path) -> Result<(), String> {
    git(
        root,
        &["clone", &bare.to_string_lossy(), &dest.to_string_lossy()],
    );
    Ok(())
}

/// The `origin` seam, saying what git would say in production.
///
/// A test's remote is a local path, and `team::origin_matches` deliberately
/// only ever matches a github.com URL — adopting a checkout it cannot
/// identify is the mistake that check exists to prevent. So the seam is what
/// stands in for the real remote, which is why it is injected.
fn origin_says(url: &'static str) -> impl Fn(&Path) -> Option<String> {
    move |_| Some(url.to_string())
}

/// The real thing, for the paths where no clone exists to ask about.
fn origin_of(dir: &Path) -> Option<String> {
    let out = crate::platform::git_command()
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .output()
        .ok()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

const TEAM_ORIGIN: &str = "https://github.com/MatteoB-adv/mb-adv-team.git";

#[test]
fn creating_a_team_pushes_the_manifest_and_the_empty_library() {
    let tmp = TempDir::new().unwrap();
    let bare = empty_remote(tmp.path());
    let clone_dir = tmp.path().join("team").join("MatteoB-adv__mb-adv-team");

    let plan = plan_create_team(
        "MB Adv",
        "MatteoB-adv/mb-adv-team",
        "MatteoB-adv",
        &["MatteoB-adv/atelier".to_string()],
    )
    .unwrap();
    let created = create_team_with(
        &plan,
        CreateStart::Fresh,
        &clone_dir,
        |slug, description| {
            assert_eq!(slug, "MatteoB-adv/mb-adv-team");
            assert_eq!(description, "Plyloft team: MB Adv");
            Ok(())
        },
        |_, dest| clone_from(tmp.path(), &bare, dest),
        publish,
        origin_of,
    )
    .unwrap();

    assert_eq!(created.repo, "MatteoB-adv/mb-adv-team");
    assert!(!created.already_existed);

    // The clone is the one every other team command reads: `TeamStore`'s own
    // directory, not a temporary copy.
    let read_back = crate::team::read_manifest(&clone_dir).unwrap().unwrap();
    assert_eq!(read_back.name, "MB Adv");
    assert_eq!(read_back.owner_login(), Some("MatteoB-adv"));
    assert_eq!(read_back.workspaces[0].repo, "MatteoB-adv/atelier");

    // And the remote really received all of it, library seeds included —
    // rung 3's reader needs `library/codex/` to exist.
    let tracked = capture(&clone_dir, &["ls-tree", "-r", "--name-only", "origin/main"]);
    for path in [
        "team.json",
        "README.md",
        "library/knowledge/.gitkeep",
        "library/claude/.gitkeep",
        "library/codex/.gitkeep",
    ] {
        assert!(tracked.contains(path), "{path} missing from the remote:\n{tracked}");
    }
    // The atomic write's scratch file never survives into the checkout.
    assert!(!clone_dir.join("team.json.atelier-tmp").exists());
}

/// **Resuming is only for what this flow itself left behind.** "It has no
/// `team.json`" describes every ordinary repository too, and resuming into
/// one would overwrite its README and publish the team's membership into it
/// — a public one included. Only private *and* empty qualifies.
#[test]
fn only_an_empty_private_repository_may_be_resumed_into() {
    use crate::github::RemoteRepoState;
    let repo = "MatteoB-adv/mb-adv-team";
    let state = |private: bool, empty: bool, manifest: Option<&str>| {
        Ok(RemoteRepoState {
            private,
            empty,
            manifest: manifest.map(str::to_string),
        })
    };

    // What `gh repo create --private` leaves, and what a run that died
    // before its push leaves.
    assert_eq!(
        resume_decision(repo, "MatteoB-adv", state(true, true, None)),
        Ok(CreateStart::Resume)
    );

    // Public: never a team repo, whatever else is true of it.
    let public = resume_decision(repo, "MatteoB-adv", state(false, true, None)).unwrap_err();
    assert!(public.contains("public"), "{public}");
    // Public with a manifest naming this owner is still public.
    let owned_public = std::str::from_utf8(&manifest_bytes(&team()).unwrap())
        .unwrap()
        .to_string();
    assert!(resume_decision(repo, "MatteoB-adv", state(false, false, Some(&owned_public)))
        .is_err());

    // Private with history and no manifest: somebody's work.
    let used = resume_decision(repo, "MatteoB-adv", state(true, false, None)).unwrap_err();
    assert!(used.contains("already has commits"), "{used}");

    // Private with a file called team.json that is not a manifest: the same.
    assert!(resume_decision(repo, "MatteoB-adv", state(true, false, Some("not json"))).is_err());

    // GitHub could not say: refused, never assumed.
    let unknown = resume_decision(repo, "MatteoB-adv", Err("no such host".to_string()))
        .unwrap_err();
    assert!(unknown.contains("could not confirm"), "{unknown}");
}

/// **A finished team this account owns is recognised, not refused.**
///
/// A push GitHub accepted whose acknowledgement was lost reports a failure
/// and tells the owner to press again; so does an owner who closed Settings
/// before copying the mint command. Refusing the retry with "pick another
/// name" would strand the team they now own with no way back to its command.
#[test]
fn a_finished_team_this_account_owns_is_handed_back_rather_than_refused() {
    use crate::github::RemoteRepoState;
    let repo = "MatteoB-adv/mb-adv-team";
    let text = String::from_utf8(manifest_bytes(&team()).unwrap()).unwrap();
    let finished = |login: &str| {
        resume_decision(
            repo,
            login,
            Ok(RemoteRepoState {
                private: true,
                empty: false,
                manifest: Some(text.clone()),
            }),
        )
    };

    assert_eq!(finished("MatteoB-adv"), Ok(CreateStart::Completed(team())));
    // Case-insensitively, like every login comparison.
    assert!(matches!(finished("matteob-adv"), Ok(CreateStart::Completed(_))));
    // Somebody else's finished team is theirs to finish, and says whose.
    let theirs = finished("minidev").unwrap_err();
    assert!(theirs.contains("owned by MatteoB-adv"), "{theirs}");
}

/// Handing back a finished team writes **nothing** to GitHub: no repository
/// is created, nothing is published, and the remote's history is exactly what
/// it was. It only makes sure this Mac has the clone.
#[test]
fn handing_back_a_finished_team_changes_nothing_on_github() {
    let tmp = TempDir::new().unwrap();
    let (bare, _seed_clone) = team_clone(tmp.path());
    let before = capture(&bare, &["rev-parse", "main"]);
    let clone_dir = tmp.path().join("team").join("MatteoB-adv__team");

    // What was typed may differ; the manifest's own name is the team's.
    let plan = plan_create_team("Typed Differently", "MatteoB-adv/team", "MatteoB-adv", &[])
        .unwrap();
    let created = create_team_with(
        &plan,
        CreateStart::Completed(team()),
        &clone_dir,
        |_, _| panic!("a finished team must not be created again"),
        |_, dest| clone_from(tmp.path(), &bare, dest),
        |_, _, _| panic!("a finished team must not be published over"),
        origin_of,
    )
    .unwrap();

    assert!(created.already_existed);
    assert_eq!(created.name, "MB Adv");
    assert!(clone_dir.join("team.json").is_file(), "this Mac now has the clone");
    assert_eq!(capture(&bare, &["rev-parse", "main"]), before, "GitHub is untouched");
}

/// Only GitHub's documented empty-repository answer reads as empty; a 404 or
/// a network error is not "nothing here to lose".
#[test]
fn only_the_documented_409_reads_as_an_empty_repository() {
    assert!(crate::github::is_empty_repository_error(
        r#"{"message":"Git Repository is empty.","status":"409"}gh: Git Repository is empty. (HTTP 409)"#
    ));
    assert!(!crate::github::is_empty_repository_error("gh: Not Found (HTTP 404)"));
    assert!(!crate::github::is_empty_repository_error("error connecting to api.github.com"));
    assert!(!crate::github::is_empty_repository_error("HTTP 409: conflict"));
}

/// **A creation that died after `gh repo create` can be finished.**
///
/// The repository is the one irreversible step, and everything after it —
/// the clone, the files, the push — is written to be repeatable. Telling the
/// owner to "pick a different name" would be advice to abandon a real,
/// private, empty repository they now own.
#[test]
fn a_creation_that_failed_after_the_repo_existed_finishes_on_the_next_press() {
    let tmp = TempDir::new().unwrap();
    let bare = empty_remote(tmp.path());
    let clone_dir = tmp.path().join("team").join("MatteoB-adv__mb-adv-team");
    let plan = plan_create_team("MB Adv", "MatteoB-adv/mb-adv-team", "MatteoB-adv", &[])
        .unwrap();

    // Attempt one: the repository is made, the clone fails.
    let failed = create_team_with(
        &plan,
        CreateStart::Fresh,
        &clone_dir,
        |_, _| Ok(()),
        |_, _| Err("network went away".to_string()),
        |_, _, _| unreachable!(),
        origin_of,
    )
    .unwrap_err();
    // The error names what is waiting and what to do about it, rather than
    // leaving an empty repository nobody can get back to.
    assert!(failed.contains("MatteoB-adv/mb-adv-team"), "{failed}");
    assert!(failed.contains("Press Create team again"), "{failed}");
    assert!(failed.contains("cloning it"), "{failed}");

    // Attempt two, resuming: no repository is created, everything else runs.
    let created = create_team_with(
        &plan,
        CreateStart::Resume,
        &clone_dir,
        |_, _| panic!("a resume must not create the repository again"),
        |_, dest| clone_from(tmp.path(), &bare, dest),
        publish,
        origin_of,
    )
    .unwrap();
    assert_eq!(created.repo, "MatteoB-adv/mb-adv-team");
    assert!(capture(&clone_dir, &["ls-tree", "-r", "--name-only", "origin/main"])
        .contains("team.json"));
}

/// A run that died at the *push* leaves a complete clone. The next press
/// reuses it — identical bytes stage nothing, and the push runs regardless,
/// which is what carries the stranded commit up.
#[test]
fn a_resume_reuses_the_clone_this_repo_already_has() {
    let tmp = TempDir::new().unwrap();
    let bare = empty_remote(tmp.path());
    let clone_dir = tmp.path().join("team").join("MatteoB-adv__mb-adv-team");
    let plan = plan_create_team("MB Adv", "MatteoB-adv/mb-adv-team", "MatteoB-adv", &[])
        .unwrap();

    let pushed_failed = create_team_with(
        &plan,
        CreateStart::Fresh,
        &clone_dir,
        |_, _| Ok(()),
        |_, dest| clone_from(tmp.path(), &bare, dest),
        |_, _, _| Err("push rejected".to_string()),
        origin_of,
    )
    .unwrap_err();
    assert!(pushed_failed.contains("pushing the manifest"), "{pushed_failed}");
    assert!(clone_dir.join("team.json").is_file());

    let created = create_team_with(
        &plan,
        CreateStart::Resume,
        &clone_dir,
        |_, _| panic!("no repository may be created"),
        |_, _| panic!("the clone this repo already has must be reused"),
        publish,
        origin_says(TEAM_ORIGIN),
    )
    .unwrap();
    assert_eq!(created.repo, "MatteoB-adv/mb-adv-team");
}

/// A directory at the clone path that belongs to a *different* repository is
/// still refused — resuming is about finishing this team, not writing into
/// somebody else's checkout.
#[test]
fn creating_refuses_a_clone_path_that_holds_another_repository() {
    let tmp = TempDir::new().unwrap();
    let other = empty_remote(&tmp.path().join("elsewhere"));
    let clone_dir = tmp.path().join("team").join("taken");
    std::fs::create_dir_all(clone_dir.parent().unwrap()).unwrap();
    clone_from(tmp.path(), &other, &clone_dir).unwrap();

    let plan = plan_create_team("MB Adv", "MatteoB-adv/mb-adv-team", "MatteoB-adv", &[])
        .unwrap();
    let error = create_team_with(
        &plan,
        CreateStart::Fresh,
        &clone_dir,
        |_, _| panic!("no repository may be created once the clone path is taken"),
        |_, _| unreachable!(),
        |_, _, _| unreachable!(),
        origin_says("https://github.com/someone/else.git"),
    )
    .unwrap_err();
    assert!(error.contains("another repository"), "{error}");
}

/// And a path holding something that is not a checkout at all.
#[test]
fn creating_refuses_when_this_mac_already_has_something_at_the_clone_path() {
    let tmp = TempDir::new().unwrap();
    let clone_dir = tmp.path().join("team").join("existing");
    std::fs::create_dir_all(&clone_dir).unwrap();
    std::fs::write(clone_dir.join("mine.txt"), "x").unwrap();
    let plan = plan_create_team("MB Adv", "MatteoB-adv/x", "MatteoB-adv", &[]).unwrap();
    let error = create_team_with(
        &plan,
        CreateStart::Fresh,
        &clone_dir,
        |_, _| panic!("no repository may be created once the clone path is taken"),
        |_, _| unreachable!(),
        |_, _, _| unreachable!(),
        origin_of,
    )
    .unwrap_err();
    assert!(error.contains("not a git checkout"), "{error}");
}

/// The manifest is the file every owner action has to parse before Ply can
/// say anything at all, so it is written through the canonical
/// tempfile-plus-rename helper (hard rule 3) rather than in place.
#[test]
fn the_manifest_is_written_atomically_and_leaves_no_scratch_file() {
    let tmp = TempDir::new().unwrap();
    let clone = tmp.path();
    write_manifest(clone, &team()).unwrap();
    assert_eq!(
        crate::team::read_manifest(clone).unwrap().unwrap(),
        team()
    );
    assert!(!clone.join("team.json.atelier-tmp").exists());

    // A second write replaces the first wholesale — never appends, never
    // leaves the longer previous tail behind.
    let mut smaller = team();
    smaller.workspaces.clear();
    smaller.members.truncate(1);
    write_manifest(clone, &smaller).unwrap();
    assert_eq!(crate::team::read_manifest(clone).unwrap().unwrap(), smaller);
}

// ── Applying an invite ──────────────────────────────────────────────

/// Everything an invite needs beyond the clone, with the boring parts
/// defaulted: the owner is authorized, GitHub says nothing about anyone, and
/// every grant succeeds. Each test overrides only the part it is about.
fn apply(
    clone: &Path,
    confirmed: &str,
    grant: impl FnMut(&str, &str, &str) -> Result<bool, String>,
) -> Result<InviteOutcome, String> {
    invite_member_with(
        &InviteRequest {
            login: "newcomer",
            team_repo: "MatteoB-adv/team",
            confirmed,
        },
        clone,
        &crate::team::RealLibraryGit,
        |_| Ok(()),
        |repos| {
            repos
                .iter()
                .map(|repo| (repo.clone(), CollaboratorAccess::None))
                .collect()
        },
        |_| Vec::new(),
        grant,
    )
}

/// The digest the owner would have confirmed for a plan over `manifest`.
fn confirmed_for(manifest: &TeamManifest, login: &str) -> String {
    build_invite_plan(login, "MatteoB-adv/team", manifest, &no_access("MatteoB-adv/team", &manifest))
        .unwrap()
        .digest
}

/// The manifest first, then the grants. Both halves are recoverable, but
/// they are not equally visible: a member listed without access is on the
/// owner's screen and in the team's history, while access handed out and
/// never recorded is the failure nobody goes looking for.
#[test]
fn an_invite_records_the_member_before_it_grants_anything() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let confirmed = confirmed_for(&team(), "newcomer");

    let outcome = apply(&clone, &confirmed, |repo, login, permission| {
        assert_eq!(login, "newcomer");
        assert_eq!(permission, "push");
        // The manifest is on the *remote* by the time the first grant is
        // asked for, not merely in the local clone.
        let pushed = capture(&clone, &["show", "origin/main:team.json"]);
        assert!(
            pushed.contains("newcomer"),
            "the manifest must be pushed before any grant, got {pushed}"
        );
        let _ = repo;
        Ok(true)
    })
    .unwrap();

    assert!(outcome.manifest_written);
    assert!(outcome.listed);
    assert_eq!(
        outcome.invited,
        vec![
            "MatteoB-adv/team".to_string(),
            "MatteoB-adv/atelier".to_string(),
            "MatteoB-adv/other".to_string()
        ]
    );
    assert!(outcome.failed.is_empty());
    let _ = bare;
}

/// **The retry that used to grant unrecorded access.**
///
/// A first attempt whose *push* was refused leaves the membership commit in
/// the local clone. A plan built from that clone reads "already listed", so
/// skipping the manifest round trip on that basis would send grants for a
/// member the team's own repository still does not name. The round trip
/// therefore always runs — rung 2's "always push, even when the write staged
/// nothing" is exactly this case — and a push that is still refused stops
/// the invite before anything outward-facing happens.
#[test]
fn a_retry_after_a_refused_push_grants_nothing_until_the_manifest_is_pushed() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let confirmed = confirmed_for(&team(), "newcomer");

    // The exact state the finding is about: a previous attempt committed the
    // member locally and its push was refused, so the remote does not name
    // them.
    let mut local = team();
    local.members.push(TeamMember {
        login: "newcomer".to_string(),
        owner: false,
        extra: Default::default(),
    });
    std::fs::write(clone.join("team.json"), manifest_bytes(&local).unwrap()).unwrap();
    git(&clone, &["add", "-A"]);
    git(&clone, &["commit", "-m", "local only — the push was refused"]);
    assert!(
        !capture(&clone, &["show", "origin/main:team.json"]).contains("newcomer"),
        "the remote must not name the member yet"
    );
    assert!(
        !manifest_with_member(
            &crate::team::read_manifest(&clone).unwrap().unwrap(),
            "newcomer"
        )
        .is_some(),
        "the local clone does list them — which is what made this a shortcut"
    );

    // Still diverged: another Mac moved on, so the round trip cannot
    // complete. Nothing may be granted on the strength of the local commit.
    push_manifest(tmp.path(), &bare, &team());
    let refused = apply(&clone, &confirmed, |_, _, _| {
        panic!("no grant may be attempted while the manifest is unpushed")
    })
    .unwrap_err();
    assert!(refused.contains("team.json"), "{refused}");

    // Divergence resolved: the round trip now carries the stranded commit to
    // the remote, and only then are grants sent.
    git(&clone, &["pull", "--rebase"]);
    let granted = std::cell::RefCell::new(Vec::<String>::new());
    let outcome = apply(&clone, &confirmed, |repo, _, _| {
        assert!(
            capture(&clone, &["show", "origin/main:team.json"]).contains("newcomer"),
            "the remote must name the member before any grant"
        );
        granted.borrow_mut().push(repo.to_string());
        Ok(true)
    })
    .unwrap();
    // This call committed nothing — the earlier attempt did — but it pushed,
    // which is what makes the grants legitimate.
    assert!(!outcome.manifest_written);
    assert!(outcome.listed);
    assert_eq!(granted.borrow().len(), 3);
}

/// A clone with no remote records the member nowhere the team can see, so it
/// is not a state to grant from either.
#[test]
fn a_clone_with_no_remote_grants_nothing() {
    let tmp = TempDir::new().unwrap();
    let clone = tmp.path().join("local-only");
    std::fs::create_dir_all(&clone).unwrap();
    git(&clone, &["init", "--initial-branch=main", "."]);
    git(&clone, &["config", "user.name", "Plyloft Test"]);
    git(&clone, &["config", "user.email", "test@example.invalid"]);
    std::fs::write(clone.join("team.json"), manifest_bytes(&team()).unwrap()).unwrap();
    git(&clone, &["add", "-A"]);
    git(&clone, &["commit", "-m", "seed"]);

    let error = apply(&clone, "", |_, _, _| panic!("nothing may be granted"))
        .unwrap_err();
    assert!(error.contains("no remote"), "{error}");
}

/// **The grants come from the manifest the pull produced**, not the one the
/// panel read. A team workspace another Mac added in between is a repository
/// the owner never saw on the confirmation screen, so the press is refused —
/// and the member stays recorded, which the message says.
#[test]
fn a_workspace_added_remotely_refuses_the_press_instead_of_being_granted_unread() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    // What the owner read, before the remote grew.
    let confirmed = confirmed_for(&team(), "newcomer");

    let mut grown = team();
    grown.workspaces.push(TeamWorkspace {
        repo: "MatteoB-adv/secrets".to_string(),
        name: None,
        default_branch: None,
    });
    push_manifest(tmp.path(), &bare, &grown);

    let error = apply(&clone, &confirmed, |_, _, _| {
        panic!("nothing may be granted from a plan the owner did not read")
    })
    .unwrap_err();
    assert!(error.contains("matteob-adv/secrets"), "{error}");
    assert!(error.contains("now listed in the team manifest"), "{error}");
    // The member really is recorded — the manifest half ran before the plan
    // was rebuilt, which is the ordering this rung is built on.
    assert!(capture(&clone, &["show", "origin/main:team.json"]).contains("newcomer"));
}

/// And a workspace the team *removed* is simply not granted, rather than
/// being granted because the panel still listed it.
#[test]
fn a_workspace_removed_remotely_is_not_granted() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let confirmed = confirmed_for(&team(), "newcomer");

    let mut shrunk = team();
    shrunk.workspaces.retain(|w| w.repo != "MatteoB-adv/other");
    push_manifest(tmp.path(), &bare, &shrunk);

    let outcome = apply(&clone, &confirmed, |_, _, _| Ok(true)).unwrap();
    assert_eq!(
        outcome.invited,
        vec![
            "MatteoB-adv/team".to_string(),
            "MatteoB-adv/atelier".to_string()
        ],
        "a repository the team no longer owns must not be granted"
    );
}

/// The owner check re-runs against the pulled manifest: who owns a team is a
/// fact in the very file being edited, and a transfer that landed remotely
/// must stop the write rather than be overwritten by it.
#[test]
fn ownership_is_re_decided_against_the_manifest_the_pull_produced() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let mut transferred = team();
    transferred.members = vec![TeamMember {
        login: "somebody-else".to_string(),
        owner: true,
        extra: Default::default(),
    }];
    push_manifest(tmp.path(), &bare, &transferred);

    let error = invite_member_with(
        &InviteRequest {
            login: "newcomer",
            team_repo: "MatteoB-adv/team",
            confirmed: "",
        },
        &clone,
        &crate::team::RealLibraryGit,
        |manifest| {
            authorize_owner_action(true, manifest.owner_login(), Some("MatteoB-adv"))
        },
        |_| Vec::new(),
        |_| Vec::new(),
        |_, _, _| panic!("nothing may be granted by someone who is not the owner"),
    )
    .unwrap_err();
    assert!(error.contains("somebody-else"), "{error}");
    // Rolled back: the clone is exactly as it was.
    assert!(!capture(&clone, &["status", "--porcelain"]).contains("team.json"));
}

/// A grant GitHub refuses does not lose the rest of the invite, and it does
/// not lose the member either: they are in the manifest, and the PUT behind
/// each grant is idempotent, so the owner's retry is safe.
#[test]
fn a_refused_grant_is_reported_and_the_other_repos_still_get_theirs() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let confirmed = confirmed_for(&team(), "newcomer");
    let outcome = apply(&clone, &confirmed, |repo, _, _| {
        if repo == "MatteoB-adv/atelier" {
            Err("HTTP 403: you do not have admin rights".to_string())
        } else {
            Ok(true)
        }
    })
    .unwrap();
    assert_eq!(outcome.invited.len(), 2);
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].contains("MatteoB-adv/atelier"), "{:?}", outcome.failed);
    assert!(outcome.listed, "the member stays recorded");
}

/// GitHub answering 204 — already a collaborator, or covered by an
/// organisation — is a success, not a failure. That is what makes retrying
/// a half-finished invite safe.
#[test]
fn an_unresolved_step_is_never_granted_and_is_reported_as_failed() {
    // 6th Challenger round on PR #29: with the access lookup failed, the old
    // plan still granted `push`, and GitHub's PUT would have downgraded an
    // admin. Now the step is applied by refusing it, and the grant closure
    // is never reached.
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let plan = build_invite_plan("minidev", "MatteoB-adv/team", &team(), &no_access("MatteoB-adv/team", &team())).unwrap();
    let outcome = invite_member_with(
        &InviteRequest {
            login: "minidev",
            team_repo: "MatteoB-adv/team",
            confirmed: &plan.digest,
        },
        &clone,
        &crate::team::RealLibraryGit,
        |_| Ok(()),
        |repos| {
            repos
                .iter()
                .map(|repo| (repo.clone(), CollaboratorAccess::Unknown))
                .collect()
        },
        |_| Vec::new(),
        |repo, _, _| panic!("no grant may be sent for {repo} while access is unknown"),
    )
    .unwrap();
    assert!(outcome.invited.is_empty());
    assert_eq!(outcome.failed.len(), plan.steps.len());
    assert!(outcome.failed.iter().all(|f| f.contains("refresh")), "{:?}", outcome.failed);
}

#[test]
fn an_account_gone_in_the_race_after_the_lookup_gets_no_grant() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let outcome = invite_member_with(
        &InviteRequest { login: "gone-now", team_repo: "MatteoB-adv/team", confirmed: "" },
        &clone,
        &crate::team::RealLibraryGit,
        |_| Ok(()),
        |repos| repos.iter().map(|repo| (repo.clone(), CollaboratorAccess::NoSuchAccount)).collect(),
        |_| Vec::new(),
        |repo, _, _| panic!("no grant may be sent for {repo}"),
    )
    .unwrap();
    assert!(outcome.invited.is_empty());
    assert!(!outcome.failed.is_empty() && outcome.failed.iter().all(|f| f.contains("did not say what access gone-now has")), "{:?}", outcome.failed);
}

#[test]
fn a_login_nobody_has_is_refused_with_nothing_to_send_or_read_again() {
    let manifest = team();
    let repos = vec!["MatteoB-adv/team".to_string(), "MatteoB-adv/atelier".to_string(), "MatteoB-adv/other".to_string()];
    let access: Vec<(String, CollaboratorAccess)> = repos.iter().map(|r| (r.clone(), CollaboratorAccess::NoSuchAccount)).collect();
    let plan = build_invite_plan("nobody-here", "MatteoB-adv/team", &manifest, &access).unwrap();
    assert!(plan.steps.iter().all(|s| s.action == InviteAction::NoSuchAccount), "{:?}", plan.steps);
    assert!(plan.grants().is_empty() && plan.digest.is_empty(), "nothing to confirm");
    assert!(!plan.is_empty(), "not 'nothing to do': the page says why it can't send");
    assert_eq!(serde_json::to_value(InviteAction::NoSuchAccount).unwrap(), "no_such_account");
}

#[test]
fn a_repo_that_needed_nothing_is_not_reported_as_an_invitation() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    // Every repository answered — an unanswered one would be unresolved, not
    // a grant, and the plan could not be applied at all.
    let access = vec![
        ("MatteoB-adv/team".to_string(), CollaboratorAccess::None),
        ("MatteoB-adv/atelier".to_string(), CollaboratorAccess::None),
        ("MatteoB-adv/other".to_string(), CollaboratorAccess::Write),
    ];
    let plan = build_invite_plan("minidev", "MatteoB-adv/team", &team(), &access).unwrap();
    let outcome = invite_member_with(
        &InviteRequest {
            login: "minidev",
            team_repo: "MatteoB-adv/team",
            confirmed: &plan.digest,
        },
        &clone,
        &crate::team::RealLibraryGit,
        |_| Ok(()),
        |repos| {
            repos
                .iter()
                .map(|repo| {
                    let answer = if repo == "MatteoB-adv/other" {
                        CollaboratorAccess::Write
                    } else {
                        CollaboratorAccess::None
                    };
                    (repo.clone(), answer)
                })
                .collect()
        },
        |_| Vec::new(),
        |repo, _, _| Ok(repo != "MatteoB-adv/atelier"),
    )
    .unwrap();
    assert!(!outcome.manifest_written, "minidev is already listed");
    assert_eq!(outcome.invited, vec!["MatteoB-adv/team".to_string()]);
    // The one GitHub answered 204 for, and the one the plan already knew
    // about, both land here — in the order the owner read them.
    assert_eq!(
        outcome.already_had,
        vec![
            "MatteoB-adv/atelier".to_string(),
            "MatteoB-adv/other".to_string()
        ]
    );
}

/// A clone whose manifest cannot be written is not a state to grant access
/// from: nothing outward-facing happens, and the owner is told.
#[test]
fn nothing_is_granted_when_the_manifest_write_fails() {
    let tmp = TempDir::new().unwrap();
    let error = apply(&tmp.path().join("no-clone-here"), "", |_, _, _| {
        panic!("no grant may be attempted without a recorded member")
    })
    .unwrap_err();
    assert!(error.contains("not cloned"), "{error}");
}

/// A team clone holding the acceptance journey's manifest, with a bare
/// remote behind it.
fn team_clone(root: &Path) -> (PathBuf, PathBuf) {
    let bare = root.join("origin.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare", "--initial-branch=main", "."]);
    let seed = root.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "--initial-branch=main", "."]);
    std::fs::write(
        seed.join("team.json"),
        manifest_bytes(&team()).unwrap(),
    )
    .unwrap();
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
    (bare, clone)
}

/// Another Mac pushing a new manifest, which is what the pull will bring in.
///
/// It also touches an unrelated file, so "the remote moved on" is true even
/// when the manifest it pushes is byte-identical — which is the case a
/// divergence test needs and a drift test does not care about.
fn push_manifest(root: &Path, bare: &Path, manifest: &TeamManifest) {
    let nonce = uuid_ish();
    let other = root.join(format!("other-{nonce}"));
    git(
        root,
        &["clone", &bare.to_string_lossy(), &other.to_string_lossy()],
    );
    git(&other, &["config", "user.name", "Other Mac"]);
    git(&other, &["config", "user.email", "other@example.invalid"]);
    std::fs::write(other.join("team.json"), manifest_bytes(manifest).unwrap()).unwrap();
    std::fs::write(other.join("NOTES.md"), format!("{nonce}\n")).unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-m", "another Mac edited the team"]);
    git(&other, &["push"]);
}

/// Enough uniqueness for one test's scratch clones.
fn uuid_ish() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

// ── The discovery filter ────────────────────────────────────────────

/// The team repo the acceptance journey's team lives in.
const TEAM_REPO: &str = "MatteoB-adv/mb-adv-team";

fn found(repo: &str, marker: Option<bool>) -> DiscoveredRepo {
    DiscoveredRepo {
        repo: repo.to_string(),
        description: None,
        archived: false,
        private: true,
        carries_marker: marker,
    }
}

/// The filter's whole job: a repository that already carries
/// `.atelier/workspace_default.json` has already been set up for Ply by
/// somebody, and that is the signal. Everything else is excluded, and each
/// exclusion is one the owner would otherwise make by hand.
#[test]
fn discovery_proposes_only_repos_already_set_up_as_ply_workspaces() {
    let scan = vec![
        found("MatteoB-adv/marked", Some(true)),
        found("MatteoB-adv/plain", Some(false)),
    ];
    let discovery = discovery_proposals(&scan, TEAM_REPO, Some(&team()), &[]);
    assert_eq!(discovery.scanned, 2);
    assert_eq!(
        discovery.proposals.iter().map(|p| p.repo.as_str()).collect::<Vec<_>>(),
        vec!["MatteoB-adv/marked"]
    );
}

/// A probe that could not be answered must never join the "no marker" pile:
/// a scan that lost its connection halfway would otherwise report a team's
/// repositories as having nothing to offer.
#[test]
fn a_probe_that_could_not_be_answered_is_counted_not_dismissed() {
    let scan = vec![
        found("MatteoB-adv/marked", Some(true)),
        found("MatteoB-adv/unknown", None),
        found("MatteoB-adv/other-unknown", None),
    ];
    let discovery = discovery_proposals(&scan, TEAM_REPO, None, &[]);
    assert_eq!(discovery.unchecked, 2);
    assert_eq!(discovery.proposals.len(), 1);
}

#[test]
fn discovery_leaves_out_what_the_owner_has_already_decided_about() {
    let scan = vec![
        // Already a team workspace: counted, so the panel can say the team
        // already has it rather than silently showing less.
        found("MatteoB-adv/atelier", Some(true)),
        // Ignored earlier — and case is not a way back onto the list.
        found("matteob-adv/dismissed", Some(true)),
        found("MatteoB-adv/fresh", Some(true)),
    ];
    let ignored = vec!["MatteoB-adv/dismissed".to_string()];
    let discovery = discovery_proposals(&scan, TEAM_REPO, Some(&team()), &ignored);
    assert_eq!(discovery.already_listed, 1);
    assert_eq!(
        discovery.proposals.iter().map(|p| p.repo.as_str()).collect::<Vec<_>>(),
        vec!["MatteoB-adv/fresh"]
    );
}

/// The team repo holds the manifest and the library; adding it as a
/// workspace is refused, so proposing it would be a row whose only outcome
/// is a refusal.
#[test]
fn the_team_repo_is_never_proposed_as_one_of_its_own_workspaces() {
    let scan = vec![
        found(TEAM_REPO, Some(true)),
        found("matteob-adv/MB-ADV-TEAM", Some(true)),
        found("MatteoB-adv/fine", Some(true)),
    ];
    let discovery = discovery_proposals(&scan, TEAM_REPO, None, &[]);
    assert_eq!(
        discovery.proposals.iter().map(|p| p.repo.as_str()).collect::<Vec<_>>(),
        vec!["MatteoB-adv/fine"]
    );
}

#[test]
fn an_archived_or_unclonable_repo_is_never_proposed() {
    let mut archived = found("MatteoB-adv/old", Some(true));
    archived.archived = true;
    let scan = vec![
        archived,
        // A slug Ply could not clone, however marked it claims to be.
        found("not a repo", Some(true)),
        found("MatteoB-adv/fine", Some(true)),
    ];
    let discovery = discovery_proposals(&scan, TEAM_REPO, None, &[]);
    assert_eq!(
        discovery.proposals.iter().map(|p| p.repo.as_str()).collect::<Vec<_>>(),
        vec!["MatteoB-adv/fine"]
    );
}

/// Eight concurrent probes come back in whatever order they finish, so the
/// list has to be ordered here or the same repositories reshuffle on every
/// press.
#[test]
fn proposals_are_sorted_and_never_duplicated() {
    let scan = vec![
        found("MatteoB-adv/zebra", Some(true)),
        found("MatteoB-adv/Alpha", Some(true)),
        found("matteob-adv/alpha", Some(true)),
    ];
    let discovery = discovery_proposals(&scan, TEAM_REPO, None, &[]);
    assert_eq!(
        discovery.proposals.iter().map(|p| p.repo.as_str()).collect::<Vec<_>>(),
        vec!["MatteoB-adv/Alpha", "MatteoB-adv/zebra"]
    );
}

#[test]
fn a_blank_description_is_absent_rather_than_empty() {
    let mut blank = found("MatteoB-adv/x", Some(true));
    blank.description = Some("   ".to_string());
    let mut real = found("MatteoB-adv/y", Some(true));
    real.description = Some(" Ships things ".to_string());
    let discovery = discovery_proposals(&[blank, real], TEAM_REPO, None, &[]);
    assert_eq!(discovery.proposals[0].description, None);
    assert_eq!(
        discovery.proposals[1].description.as_deref(),
        Some("Ships things")
    );
}

// ── Both markers (team walk 2026-10-01, F1) ─────────────────────────

/// A repository adopted under ADR 0003 carries `.atelier/workspace.json`
/// and may never have had the older marker; the walk's sandbox was exactly
/// that and discovery never proposed it.
#[test]
fn the_shared_definition_alone_marks_a_repo_as_set_up() {
    assert!(WORKSPACE_MARKERS.contains(&".atelier/workspace.json"));
    assert!(WORKSPACE_MARKERS.contains(&WORKSPACE_MARKER));
    let scan = vec![
        // workspace.json yes, the old marker never asked.
        found("MatteoB-adv/adopted", combine_marker_answers(&[Ok(true)])),
        // workspace.json no, the old marker yes.
        found("MatteoB-adv/legacy", combine_marker_answers(&[Ok(false), Ok(true)])),
        // Neither.
        found("MatteoB-adv/plain", combine_marker_answers(&[Ok(false), Ok(false)])),
    ];
    let discovery = discovery_proposals(&scan, TEAM_REPO, None, &[]);
    assert_eq!(
        discovery.proposals.iter().map(|p| p.repo.as_str()).collect::<Vec<_>>(),
        vec!["MatteoB-adv/adopted", "MatteoB-adv/legacy"]
    );
    assert_eq!(discovery.unchecked, 0);
}

#[test]
fn a_failed_probe_on_either_marker_is_unknown_unless_the_other_said_yes() {
    let lost = || Err::<bool, String>("offline".to_string());
    assert_eq!(combine_marker_answers(&[lost(), Ok(true)]), Some(true));
    assert_eq!(combine_marker_answers(&[Ok(false), lost()]), None);
    assert_eq!(combine_marker_answers(&[lost(), Ok(false)]), None);
    assert_eq!(combine_marker_answers(&[]), None);
    let scan = vec![found(
        "MatteoB-adv/half",
        combine_marker_answers(&[Ok(false), lost()]),
    )];
    let discovery = discovery_proposals(&scan, TEAM_REPO, None, &[]);
    assert_eq!(discovery.unchecked, 1);
    assert!(discovery.proposals.is_empty());
}

/// F8 (team walk): right after **Create team** the status read — no refresh,
/// no GitHub — already says the creator is a member who can write, as their
/// login, instead of "Checking… GitHub account unknown".
#[test]
fn the_creator_is_a_member_with_write_access_right_after_create() {
    let dir = tempfile::tempdir().unwrap();
    let workspaces = crate::workspace::WorkspaceStore::new(dir.path().join("ws")).unwrap();
    let store = crate::team::TeamStore::new(dir.path().to_path_buf());
    let slug = "test-owner/plyloft-test-team";

    let before = crate::team::status(Some(slug), None, None, &[], &workspaces, &store, false);
    assert_eq!(before.membership, crate::team::Membership::Unknown);

    store.remember_creator(slug, "test-owner");
    let after = crate::team::status(Some(slug), None, None, &[], &workspaces, &store, false);
    assert_eq!(after.membership, crate::team::Membership::Member);
    assert_eq!(after.login.as_deref(), Some("test-owner"));
    let cached = store.cached_membership(slug).expect("remembered");
    assert_eq!(cached.can_write, Some(true));
    // Another team's status is not answered by it.
    assert!(store.cached_membership("someone/else").is_none());
}

// ── N14 items 1 and 9: invitations as a state ───────────────────────

fn invitation(id: u64, login: &str, created_at: &str, expired: bool) -> crate::github::RepoInvitation {
    crate::github::RepoInvitation {
        id,
        login: login.to_string(),
        created_at: created_at.to_string(),
        expired,
    }
}

fn pending(repo: &str, invitation: crate::github::RepoInvitation) -> PendingInvitation {
    PendingInvitation { repo: repo.to_string(), invitation }
}

#[test]
fn an_invitation_expires_seven_days_after_it_was_sent() {
    assert_eq!(invitation_expiry("2026-10-02T09:30:00Z").as_deref(), Some("2026-10-09"));
    // GitHub's dates are UTC; an offset is read as such.
    assert_eq!(invitation_expiry("2026-10-02T23:30:00-02:00").as_deref(), Some("2026-10-10"));
    assert_eq!(invitation_expiry("not a date"), None);
    assert_eq!(invitation_expiry(""), None);
}

/// Item 1: a repository where the person already has an open invitation is
/// "invited", not a grant offered again; an expired one is a grant; write
/// access already given wins over a stale invitation.
#[test]
fn a_pending_invitation_is_not_offered_again_and_an_expired_one_is() {
    let manifest = team();
    let access = no_access("MatteoB-adv/team", &manifest);
    let invitations = vec![
        pending("MatteoB-adv/team", invitation(1, "Newcomer", "2026-10-02T09:00:00Z", false)),
        pending("MatteoB-adv/atelier", invitation(2, "newcomer", "2026-09-01T09:00:00Z", true)),
        pending("MatteoB-adv/other", invitation(3, "somebody-else", "2026-10-02T09:00:00Z", false)),
    ];
    let plan = build_invite_plan_with("newcomer", "MatteoB-adv/team", &manifest, &access, &invitations).unwrap();
    let actions: Vec<(String, InviteAction, Option<String>)> = plan
        .steps
        .iter()
        .map(|s| (s.repo.clone(), s.action, s.invitation_expires.clone()))
        .collect();
    assert_eq!(
        actions,
        vec![
            ("MatteoB-adv/team".into(), InviteAction::Invited, Some("2026-10-09".into())),
            ("MatteoB-adv/atelier".into(), InviteAction::Grant, None),
            ("MatteoB-adv/other".into(), InviteAction::Grant, None),
        ]
    );
    assert_eq!(plan.steps[0].current, "a pending invitation");
    assert_eq!(plan.digest, "matteob-adv/atelier=push matteob-adv/other=push");

    // GitHub could not say what they have, but an invitation waits: not
    // unresolved, and nothing to grant.
    let unknown: Vec<(String, CollaboratorAccess)> = Vec::new();
    let plan = build_invite_plan_with("newcomer", "MatteoB-adv/team", &manifest, &unknown, &invitations).unwrap();
    assert_eq!(plan.steps[0].action, InviteAction::Invited);
    assert_eq!(plan.steps[1].action, InviteAction::Unresolved);

    // Write access already there: the invitation is history.
    let written: Vec<(String, CollaboratorAccess)> =
        vec![("MatteoB-adv/team".into(), CollaboratorAccess::Write)];
    let plan = build_invite_plan_with("newcomer", "MatteoB-adv/team", &manifest, &written, &invitations).unwrap();
    assert_eq!(plan.steps[0].action, InviteAction::AlreadyHas);
    assert_eq!(plan.steps[0].invitation_expires, None);
}

/// A member with every invitation already sent: nothing to do, and the
/// apply sends nothing and says so.
#[test]
fn applying_an_invite_never_resends_a_pending_invitation() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let all_invited = |repos: &[String]| -> Vec<PendingInvitation> {
        repos
            .iter()
            .map(|repo| pending(repo, invitation(9, "minidev", "2026-10-02T09:00:00Z", false)))
            .collect()
    };
    let repos: Vec<String> = team_repos("MatteoB-adv/team", &team());
    let plan = build_invite_plan_with(
        "minidev",
        "MatteoB-adv/team",
        &team(),
        &no_access("MatteoB-adv/team", &team()),
        &all_invited(&repos),
    )
    .unwrap();
    assert!(plan.is_empty(), "listed and invited everywhere: nothing to do");
    let outcome = invite_member_with(
        &InviteRequest { login: "minidev", team_repo: "MatteoB-adv/team", confirmed: &plan.digest },
        &clone,
        &crate::team::RealLibraryGit,
        |_| Ok(()),
        |repos| repos.iter().map(|r| (r.clone(), CollaboratorAccess::None)).collect(),
        all_invited,
        |repo, _, _| panic!("{repo}: a pending invitation is never sent again"),
    )
    .unwrap();
    assert_eq!(outcome.already_invited, repos);
    assert!(outcome.invited.is_empty() && outcome.failed.is_empty());
}

fn people(repo: &str, collaborators: &[&str], invitations: Vec<crate::github::RepoInvitation>) -> RepoPeople {
    RepoPeople {
        repo: repo.to_string(),
        collaborators: Ok(collaborators.iter().map(|c| c.to_string()).collect()),
        invitations: Ok(invitations),
    }
}

fn four_members() -> TeamManifest {
    manifest(
        r#"{"schemaVersion":1,"name":"MB Adv",
            "members":[{"login":"MatteoB-adv","owner":true},{"login":"joined"},{"login":"invited"},
                       {"login":"lapsed"},{"login":"nobody"}],
            "workspaces":[{"repo":"MatteoB-adv/atelier"},{"repo":"MatteoB-adv/other"}]}"#,
    )
}

/// Item 9: each manifest member is Joined, Invited (with the day it
/// expires) or No access — an expired invitation is No access with its day.
/// The owner is Joined without asking.
#[test]
fn each_member_is_joined_invited_or_without_access() {
    let answers = vec![
        people(
            "MatteoB-adv/team",
            &["MatteoB-adv", "Joined"],
            vec![
                invitation(1, "invited", "2026-10-01T10:00:00Z", false),
                invitation(2, "lapsed", "2026-09-01T10:00:00Z", true),
            ],
        ),
        people("MatteoB-adv/atelier", &["joined"], vec![invitation(3, "joined", "2026-10-01T10:00:00Z", false)]),
        people("MatteoB-adv/other", &[], vec![invitation(4, "joined", "2026-10-01T10:00:00Z", false)]),
    ];
    let states = member_states("MatteoB-adv/team", &four_members(), &answers);
    let rows: Vec<(&str, MemberAccessState, Option<&str>, Option<&str>)> = states
        .members
        .iter()
        .map(|m| {
            (
                m.login.as_str(),
                m.state,
                m.invitation_expires.as_deref(),
                m.invitation_expired.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("MatteoB-adv", MemberAccessState::Joined, None, None),
            ("joined", MemberAccessState::Joined, None, None),
            ("invited", MemberAccessState::Invited, Some("2026-10-08"), None),
            ("lapsed", MemberAccessState::NoAccess, None, Some("2026-09-08")),
            ("nobody", MemberAccessState::NoAccess, None, None),
        ]
    );
    let joined = &states.members[1];
    assert_eq!(joined.workspaces_invited, vec!["MatteoB-adv/other".to_string()]);
    assert!(joined.workspaces_missing.is_empty());
    let nobody = &states.members[4];
    assert_eq!(
        nobody.workspaces_missing,
        vec!["MatteoB-adv/atelier".to_string(), "MatteoB-adv/other".to_string()]
    );
    assert!(states.problems.is_empty());
    assert!(states.members[0].workspaces_missing.is_empty(), "the owner is never asked about");
}

/// "Could not ask" is never "no access": an error, or a full page that
/// doesn't name them, is Unknown and the error is said once.
#[test]
fn a_member_github_could_not_answer_for_is_unknown_not_without_access() {
    let failing = RepoPeople {
        repo: "MatteoB-adv/team".into(),
        collaborators: Ok(vec!["joined".into()]),
        invitations: Err("HTTP 403: Must have admin rights".into()),
    };
    let states = member_states("MatteoB-adv/team", &four_members(), &[failing]);
    assert_eq!(states.members[1].state, MemberAccessState::Joined, "a collaborator needs no invitation read");
    assert_eq!(states.members[2].state, MemberAccessState::Unknown);
    assert_eq!(states.problems, vec!["MatteoB-adv/team: HTTP 403: Must have admin rights".to_string()]);

    let full: Vec<String> = (0..crate::github::TEAM_LIST_PAGE).map(|i| format!("person{i}")).collect();
    let crowded = RepoPeople {
        repo: "MatteoB-adv/team".into(),
        collaborators: Ok(full),
        invitations: Ok(Vec::new()),
    };
    let states = member_states("MatteoB-adv/team", &four_members(), &[crowded]);
    assert_eq!(states.members[4].state, MemberAccessState::Unknown, "a full page may have stopped before them");

    // Nothing read at all (offline): every non-owner is Unknown.
    let states = member_states("MatteoB-adv/team", &four_members(), &[]);
    assert!(states.members[1..].iter().all(|m| m.state == MemberAccessState::Unknown));
}

/// The bounded reads: one page each, as the app sends them.
#[test]
fn the_invitation_and_collaborator_reads_are_one_bounded_page() {
    let _guard = crate::github::test_serial_lock();
    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![
        Ok(r#"[{"id":7,"login":"minidev","createdAt":"2026-10-02T09:00:00Z","expired":false},
              {"id":8,"login":"","createdAt":"","expired":true}]"#
            .into()),
        Ok(r#"["MatteoB-adv","minidev"]"#.into()),
        Ok(String::new()),
        Ok(String::new()),
    ]);
    let invitations = crate::github::repo_invitations("MatteoB-adv/team").unwrap();
    assert_eq!(invitations[0], invitation(7, "minidev", "2026-10-02T09:00:00Z", false));
    assert!(invitations[1].expired && invitations[1].login.is_empty());
    assert_eq!(
        crate::github::repo_collaborator_logins("MatteoB-adv/team").unwrap(),
        vec!["MatteoB-adv".to_string(), "minidev".to_string()]
    );
    crate::github::repo_cancel_invitation("MatteoB-adv/team", 7).unwrap();
    crate::github::repo_remove_collaborator("MatteoB-adv/team", "minidev").unwrap();
    let calls = crate::github::take_test_gh_invocations();
    crate::github::clear_test_gh_responses();
    assert_eq!(calls[0][1], "repos/MatteoB-adv/team/invitations?per_page=100");
    assert_eq!(calls[1][1], "repos/MatteoB-adv/team/collaborators?per_page=100");
    assert_eq!(&calls[2][..4], &["api", "-X", "DELETE", "repos/MatteoB-adv/team/invitations/7"]);
    assert_eq!(&calls[3][..4], &["api", "-X", "DELETE", "repos/MatteoB-adv/team/collaborators/minidev"]);
}

// ── N14 item 3: Remove from team ────────────────────────────────────

fn remove(
    clone: &Path,
    login: &str,
    revoke: impl FnMut(&str, &str) -> Result<Revoked, String>,
) -> Result<RemoveOutcome, String> {
    remove_member_with(
        &RemoveRequest { login, team_repo: "MatteoB-adv/team", acting_login: "MatteoB-adv" },
        clone,
        &crate::team::RealLibraryGit,
        |manifest| authorize_owner_action(true, manifest.owner_login(), Some("MatteoB-adv")),
        revoke,
    )
}

/// Access goes first, on the team repo and every team workspace; the
/// manifest is pushed without them only afterwards.
#[test]
fn removing_takes_access_everywhere_first_then_the_manifest() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let mut asked: Vec<String> = Vec::new();
    let outcome = remove(&clone, "minidev", |repo, login| {
        assert_eq!(login, "minidev");
        let pushed = capture(&clone, &["show", "origin/main:team.json"]);
        assert!(pushed.contains("minidev"), "the manifest still lists them while access is taken");
        asked.push(repo.to_string());
        Ok(Revoked {
            cancelled_invitations: usize::from(repo == "MatteoB-adv/other"),
            still_reads: repo == "MatteoB-adv/atelier",
        })
    })
    .unwrap();
    let all = vec![
        "MatteoB-adv/team".to_string(),
        "MatteoB-adv/atelier".to_string(),
        "MatteoB-adv/other".to_string(),
    ];
    assert_eq!(asked, all);
    assert_eq!(outcome.removed, all);
    assert_eq!(outcome.cancelled_invitations, vec!["MatteoB-adv/other".to_string()]);
    assert_eq!(outcome.still_read, vec!["MatteoB-adv/atelier".to_string()]);
    assert!(outcome.failed.is_empty());
    assert!(outcome.manifest_updated, "{:?}", outcome.manifest_error);
    let pushed = parse_manifest(capture(&clone, &["show", "origin/main:team.json"]).as_bytes()).unwrap();
    assert!(!pushed.lists("minidev"));
    assert!(pushed.lists("MatteoB-adv"), "the owner stays");
    assert_eq!(pushed.workspaces.len(), 2, "workspaces untouched");
}

/// Partial failure: the repositories that failed are named, and the
/// manifest is left exactly as it was — the member stays listed (visible as
/// No access) and Remove again finishes it.
#[test]
fn a_partial_failure_names_the_repos_and_leaves_the_manifest_alone() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let before = capture(&clone, &["rev-parse", "origin/main"]);
    let outcome = remove(&clone, "minidev", |repo, _| {
        if repo == "MatteoB-adv/atelier" {
            Err("GitHub refused to remove them (HTTP 403)".into())
        } else {
            Ok(Revoked::default())
        }
    })
    .unwrap();
    assert_eq!(outcome.failed, vec!["MatteoB-adv/atelier: GitHub refused to remove them (HTTP 403)".to_string()]);
    assert_eq!(outcome.removed, vec!["MatteoB-adv/team".to_string(), "MatteoB-adv/other".to_string()]);
    assert!(!outcome.manifest_updated);
    assert_eq!(capture(&clone, &["rev-parse", "origin/main"]), before, "nothing pushed");
    assert!(crate::team::read_manifest(&clone).unwrap().unwrap().lists("minidev"));

    // The retry: every step idempotent, now all succeed.
    let outcome = remove(&clone, "minidev", |_, _| Ok(Revoked::default())).unwrap();
    assert!(outcome.manifest_updated);
}

/// 1.174.3: every revoke done, `team.json` refused: "Remove from team again to
/// finish" has to be true. The retry finds nothing left to revoke (Ok, as
/// `revoke_team_access` answers once GitHub says they have no write access) and
/// reaches the write. Live: the walk of 2026-11-04 did this on GitHub.
#[test]
fn the_retry_after_a_refused_manifest_reaches_the_write_and_finishes() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let hook = bare.join("hooks/pre-receive");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho 'Internal Server Error' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let before = capture(&clone, &["rev-parse", "origin/main"]);
    let first = remove(&clone, "minidev", |_, _| Ok(Revoked::default())).unwrap();
    assert!(first.failed.is_empty());
    assert!(!first.manifest_updated);
    let why = first.manifest_error.unwrap();
    assert!(why.contains("The team's member list is as it was."), "{why}");
    assert!(!why.contains(crate::team::NOTHING_REACHED_GITHUB), "{why}");
    assert_eq!(capture(&bare, &["rev-parse", "main"]), before, "nothing landed");
    assert!(crate::team::read_manifest(&clone).unwrap().unwrap().lists("minidev"), "the clone is back as it was");

    std::fs::remove_file(&hook).unwrap();
    let second = remove(&clone, "minidev", |_, _| Ok(Revoked::default())).unwrap();
    assert!(second.manifest_updated, "{:?}", second.manifest_error);
    let remote = parse_manifest(capture(&bare, &["show", "main:team.json"]).as_bytes()).unwrap();
    assert!(!remote.lists("minidev"));
}

/// 1.174.3: a push that may have landed keeps its commit. The retry finds the
/// manifest already without them, changes nothing, and still pushes it.
#[test]
fn the_retry_pushes_a_removal_an_earlier_push_left_in_the_clone() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let without = manifest_without_member(&team(), "minidev").unwrap();
    write_manifest(&clone, &without).unwrap();
    git(&clone, &["add", "team.json"]);
    git(&clone, &["commit", "-m", "team: remove minidev"]);

    let outcome = remove(&clone, "minidev", |_, _| Ok(Revoked::default())).unwrap();
    assert!(outcome.manifest_updated, "{:?}", outcome.manifest_error);
    let remote = parse_manifest(capture(&bare, &["show", "main:team.json"]).as_bytes()).unwrap();
    assert!(!remote.lists("minidev"));
}

/// Nobody removes the owner or themselves, and a non-owner removes nobody:
/// all refused before GitHub is touched.
#[test]
fn the_owner_and_oneself_are_never_removed_and_only_the_owner_removes() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let never = |repo: &str, _: &str| -> Result<Revoked, String> { panic!("{repo} touched") };
    let error = remove(&clone, "matteob-adv", never).unwrap_err();
    assert!(error.contains("can't remove yourself"), "{error}");
    let error = remove_member_with(
        &RemoveRequest { login: "MatteoB-adv", team_repo: "MatteoB-adv/team", acting_login: "minidev" },
        &clone,
        &crate::team::RealLibraryGit,
        |_| Ok(()),
        never,
    )
    .unwrap_err();
    assert!(error.contains("owns the team"), "{error}");
    let error = remove_member_with(
        &RemoveRequest { login: "minidev", team_repo: "MatteoB-adv/team", acting_login: "minidev2" },
        &clone,
        &crate::team::RealLibraryGit,
        |manifest| authorize_owner_action(true, manifest.owner_login(), Some("minidev2")),
        never,
    )
    .unwrap_err();
    assert!(error.contains("Only the team owner"), "{error}");
    assert!(remove(&clone, "not a login", never).is_err());
}

/// A workspace another Mac added while access was being taken was not
/// revoked: the manifest write refuses and says so, and they stay listed.
#[test]
fn a_workspace_added_meanwhile_keeps_them_listed_until_removed_there_too() {
    let tmp = TempDir::new().unwrap();
    let (bare, clone) = team_clone(tmp.path());
    let grown = manifest_with_workspace(&team(), "MatteoB-adv/new-one", None).unwrap();
    let mut pushed_once = false;
    let outcome = remove(&clone, "minidev", |_, _| {
        if !pushed_once {
            push_manifest(tmp.path(), &bare, &grown);
            pushed_once = true;
        }
        Ok(Revoked::default())
    })
    .unwrap();
    assert!(!outcome.manifest_updated);
    let why = outcome.manifest_error.unwrap();
    assert!(why.contains("MatteoB-adv/new-one") && why.contains("Remove again"), "{why}");
    let remote = parse_manifest(capture(&clone, &["show", "origin/main:team.json"]).as_bytes()).unwrap();
    assert!(remote.lists("minidev"));
}

/// 1.174.3: access is already gone when `team.json` is refused, so the words
/// say only the member list stayed as it was (walk 2026-11-04, GitHub's 500).
#[test]
fn a_refused_manifest_after_removal_does_not_say_nothing_reached_github() {
    let refused = format!(
        "GitHub didn't take the change to team.json. {} Try again. (git push failed)",
        crate::team::NOTHING_REACHED_GITHUB
    );
    assert_eq!(
        removal_manifest_words(&refused),
        "GitHub didn't take the change to team.json. The team's member list is as it was. Try again. (git push failed)",
    );
    let other = "The team gained owner/new while Plyloft was removing them. Press Remove again.";
    assert_eq!(removal_manifest_words(other), other);
    // The other paths keep their words.
    let signed_out = crate::team::sign_in_words("share mine", crate::team::ConflictStage::Push, false);
    assert!(signed_out.contains(crate::team::NOTHING_REACHED_GITHUB), "{signed_out}");
}

/// Somebody already out of the manifest (taken out by hand) still has their
/// access taken; the manifest write is a no-op that still counts as done.
#[test]
fn removing_someone_the_manifest_no_longer_lists_still_takes_their_access() {
    let tmp = TempDir::new().unwrap();
    let (_bare, clone) = team_clone(tmp.path());
    let mut count = 0;
    let outcome = remove(&clone, "stranger", |_, _| {
        count += 1;
        Ok(Revoked::default())
    })
    .unwrap();
    assert_eq!(count, 3);
    assert!(outcome.manifest_updated);
    assert_eq!(manifest_without_member(&team(), "stranger"), None);
}

/// Skills hub H2 (§5.6, Tier 2): `team.json` keys this build does not know
/// — a later app's `library`, a member's own — survive an owner write from
/// this build (adding a member), and a manifest without them still loads.
#[test]
fn unknown_manifest_keys_survive_an_owner_write() {
    let manifest = crate::team::parse_manifest(
        br#"{"schemaVersion":1,"name":"Acme",
             "members":[{"login":"matteo","owner":true,"since":"2026"}],
             "workspaces":[],
             "library":{"plySkillsOff":["card-brief"]}}"#,
    )
    .unwrap();
    let next = manifest_with_member(&manifest, "ana").expect("added");
    let written: serde_json::Value = serde_json::from_slice(&manifest_bytes(&next).unwrap()).unwrap();
    assert_eq!(written["library"]["plySkillsOff"][0], "card-brief");
    assert_eq!(written["members"][0]["since"], "2026");
    assert_eq!(written["members"][1]["login"], "ana");
    assert!(written["members"][1].get("since").is_none());

    let plain = crate::team::parse_manifest(br#"{"name":"Acme","members":[{"login":"a"}]}"#).unwrap();
    assert!(plain.extra.is_empty() && plain.members[0].extra.is_empty());
    let rewritten: serde_json::Value = serde_json::from_slice(&manifest_bytes(&plain).unwrap()).unwrap();
    assert!(rewritten.get("library").is_none());
}
