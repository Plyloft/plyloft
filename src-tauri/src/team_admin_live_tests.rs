//! v1.118.0 (team sharing rung 5) — the `gh` answers this rung parses.
//!
//! Every rule in `team_admin.rs` rests on what GitHub actually says to four
//! questions, and each of them is parsed by a wrapper in `github.rs`:
//!
//! | question | endpoint | the answer the parser needs |
//! | --- | --- | --- |
//! | which repos can I reach? | `user/repos` | `full_name` / `archived` / `private` |
//! | is this repo set up for Ply? | `contents/.atelier/…` | a `sha`, or **404** for absent |
//! | what does this person already have? | `collaborators/…/permission` | `admin`/`write`/`read`/`none` |
//! | does this name exist? | `repos/<slug>` | `full_name`, or **404** |
//!
//! Two of those are load-bearing in a way a comment cannot hold: a missing
//! marker is a *404*, not an empty body, and a non-collaborator is the string
//! `"none"`, not a 404. Get either backwards and discovery proposes nothing
//! while claiming it scanned everything, or an invite plan skips the person
//! it was built for.
//!
//! `#[ignore]` because they need `gh` installed and signed in, which the
//! sandboxed gate does not have. Every call here is **read-only** — nothing
//! is created, invited or written. Run them on a developer Mac:
//!
//! ```sh
//! cargo test --lib team_admin::live_tests -- --ignored --nocapture
//! ```

use super::*;

/// Run `gh` for real. The unit-test seam in `github.rs` deliberately fails
/// closed so a test cannot reach live credentials by accident, so a test that
/// *means* to must go around it and say so.
fn gh(args: &[&str]) -> Result<String, String> {
    let out = crate::platform::new_command("/opt/homebrew/bin/gh")
        .args(args)
        .output()
        .or_else(|_| crate::platform::new_command("gh").args(args).output())
        .unwrap_or_else(|e| panic!("gh must be installed for this test: {e}"));
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn my_login() -> String {
    gh(&["api", "user", "--jq", ".login"]).expect("gh must be signed in")
}

/// A repo this account can **push** to, which is what the read-only
/// questions below need — `collaborators/…/permission` is refused to anyone
/// without it.
///
/// Deliberately not `affiliation=owner`: measured on the machine this rung
/// was built on, that answers *nothing*, because the repositories this
/// account reaches are reached through an organisation. It is the reason the
/// discovery scan asks `user/repos` with all three affiliations rather than
/// `gh repo list`, which shows only what you own.
fn any_pushable_repo() -> String {
    let json = gh(&[
        "api",
        "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
        "--jq",
        "[.[] | select(.permissions.push == true)] | .[0].full_name",
    ])
    .expect("gh must list the repos this account can reach");
    assert!(
        !json.is_empty() && json != "null",
        "this account can push to no repository, so it cannot ask GitHub \
         about collaborators"
    );
    json
}

/// The discovery scan's list, in the shape `github::GhRepoSummary` parses.
#[test]
#[ignore = "reads the signed-in GitHub account"]
fn the_repo_list_comes_back_in_the_shape_discovery_parses() {
    let json = gh(&[
        "api",
        "user/repos?per_page=5&sort=pushed&affiliation=owner,collaborator,organization_member",
        "--jq",
        "[.[] | {nameWithOwner: .full_name, description: .description, \
         isArchived: .archived, isPrivate: .private}]",
    ])
    .expect("gh must answer user/repos");
    let repos: Vec<crate::github::GhRepoSummary> =
        serde_json::from_str(&json).expect("the discovery scan must parse gh's answer");
    assert!(!repos.is_empty(), "this account can reach no repositories");
    for repo in &repos {
        assert!(
            crate::team::is_valid_repo_slug(&repo.name_with_owner),
            "{} is not owner/name",
            repo.name_with_owner
        );
    }
    // A `description` of JSON `null` must survive as `None` rather than
    // failing the whole scan — most repositories have none.
    println!("scanned {} repos, e.g. {}", repos.len(), repos[0].name_with_owner);
}

/// **A missing marker is a 404, not an empty body.** This is the measurement
/// discovery's filter is built on: `repo_has_file` classifies a 404 as a real
/// "no", and anything else stays an error that lands in `unchecked`.
#[test]
#[ignore = "reads the signed-in GitHub account"]
fn an_absent_workspace_marker_answers_404() {
    let repo = any_pushable_repo();
    let endpoint = format!("repos/{repo}/contents/.atelier/definitely-not-here.json");
    let error = gh(&["api", &endpoint, "--jq", ".sha"])
        .expect_err("a path that does not exist must not succeed");
    assert_eq!(
        crate::github::classify_gh_error(&error),
        crate::github::GhErrorKind::Denied,
        "a 404 on contents must read as a real 'no marker': {error}"
    );
}

/// The marker itself, on a repo that is a Ply workspace: a `sha`, which is
/// what `repo_has_file` reports as "yes".
#[test]
#[ignore = "reads the signed-in GitHub account; needs a repo carrying the marker"]
fn a_repo_set_up_for_ply_answers_with_a_sha() {
    let repo = std::env::var("PLY_MARKED_REPO").unwrap_or_else(|_| {
        // The repository this very card is being built in is one.
        "MatteoB-adv/atelier".to_string()
    });
    let endpoint = format!("repos/{repo}/contents/{}", WORKSPACE_MARKER);
    let sha = gh(&["api", &endpoint, "--jq", ".sha"])
        .unwrap_or_else(|e| panic!("{repo} must carry {WORKSPACE_MARKER}: {e}"));
    assert!(!sha.trim().is_empty(), "the marker must answer with a sha");
}

/// **A non-collaborator is the string `none`, not a 404.** The invite plan
/// reads this to decide `AlreadyHas` vs `Grant`; a 404 here would mean "GitHub
/// would not say", which plans the grant anyway — so both directions are safe,
/// but only one of them is honest about what GitHub answered.
#[test]
#[ignore = "reads the signed-in GitHub account"]
fn collaborator_permission_answers_a_word_including_none() {
    let repo = any_pushable_repo();
    let me = my_login();

    let mine = gh(&[
        "api",
        &format!("repos/{repo}/collaborators/{me}/permission"),
        "--jq",
        ".permission",
    ])
    .expect("the owner may ask about themselves");
    assert!(
        ["admin", "write", "maintain"].contains(&mine.as_str()),
        "the owner of {repo} should have push there, got {mine:?}"
    );

    // `octocat` is GitHub's own demo account and is a collaborator on nothing
    // of ours — the "not a collaborator" cell of the table.
    let stranger = gh(&[
        "api",
        &format!("repos/{repo}/collaborators/octocat/permission"),
        "--jq",
        ".permission",
    ])
    .expect("GitHub answers about a non-collaborator rather than 404ing");
    assert_eq!(
        stranger, "none",
        "a non-collaborator must answer `none`, or every invite plan reads as \
         'GitHub would not say'"
    );
}

/// A name nothing occupies answers 404, which is what `repo_exists` reports
/// as `Ok(false)` — and why `gh repo create` stays the authority on whether a
/// name is actually free.
#[test]
#[ignore = "reads the signed-in GitHub account"]
fn a_repository_name_nobody_holds_answers_404() {
    let me = my_login();
    let endpoint = format!("repos/{me}/ply-rung-5-name-nobody-holds");
    let error = gh(&["api", &endpoint, "--jq", ".full_name"])
        .expect_err("a repository that does not exist must not succeed");
    assert_eq!(
        crate::github::classify_gh_error(&error),
        crate::github::GhErrorKind::Denied,
        "{error}"
    );
}

// ── The pipelines, against this Mac's real team ─────────────────────
//
// Rung 3's live tests ended with one that reads this Mac's actual team clone
// and asserts it produces no error — and that is what caught its last
// defect. The same habit, for the two builders this rung rests on: a fixture
// says what the rule is, a real team says whether the rule survives contact
// with a manifest and a GitHub account nobody wrote for the test.
//
// Everything here is read-only: no repository is created, nobody is invited,
// no manifest is written.

/// This Mac's team clone, when it has one.
fn local_team_clone() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let root = std::path::Path::new(&home)
        .join("Library/Application Support/com.mbadv.ply/team");
    std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.join(crate::team::MANIFEST_FILE).is_file())
}

/// The GitHub slug a team clone's `origin` names.
fn clone_origin_slug(clone: &std::path::Path) -> Option<String> {
    let out = crate::platform::git_command()
        .args(["remote", "get-url", "origin"])
        .current_dir(clone)
        .output()
        .ok()?;
    crate::team::origin_slug(String::from_utf8_lossy(&out.stdout).trim())
}

/// The discovery pipeline end to end — scan, probe, filter — against the
/// repositories this account can actually reach and this Mac's real
/// manifest. Asserts the shape of the answer, not its contents: what is on
/// somebody's GitHub account is not the test's to know.
#[test]
#[ignore = "reads the signed-in GitHub account and this Mac's team clone"]
fn the_discovery_pipeline_runs_against_a_real_account() {
    let json = gh(&[
        "api",
        "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
        "--jq",
        "[.[] | {nameWithOwner: .full_name, description: .description, \
         isArchived: .archived, isPrivate: .private}]",
    ])
    .expect("gh must answer user/repos");
    let repos: Vec<crate::github::GhRepoSummary> = serde_json::from_str(&json).unwrap();

    let found: Vec<DiscoveredRepo> = repos
        .into_iter()
        .map(|repo| {
            let endpoint = format!("repos/{}/contents/{WORKSPACE_MARKER}", repo.name_with_owner);
            let carries_marker = match gh(&["api", &endpoint, "--jq", ".sha"]) {
                Ok(sha) => Some(!sha.trim().is_empty()),
                Err(e) => match crate::github::classify_gh_error(&e) {
                    crate::github::GhErrorKind::Denied => Some(false),
                    _ => None,
                },
            };
            DiscoveredRepo {
                repo: repo.name_with_owner,
                description: repo.description,
                archived: repo.is_archived,
                private: repo.is_private,
                carries_marker,
            }
        })
        .collect();

    let clone = local_team_clone();
    let manifest = clone
        .as_deref()
        .and_then(|dir| crate::team::read_manifest(dir).ok().flatten());
    let team_repo = clone.as_deref().and_then(clone_origin_slug).unwrap_or_default();
    let discovery = discovery_proposals(&found, &team_repo, manifest.as_ref(), &[]);
    println!(
        "scanned {} · propose {} · already listed {} · unchecked {}",
        discovery.scanned,
        discovery.proposals.len(),
        discovery.already_listed,
        discovery.unchecked
    );
    assert_eq!(discovery.scanned, found.len());
    // Nothing already in the manifest may be proposed, and nothing proposed
    // may be a slug Ply could not clone: the two exclusions the owner would
    // otherwise make by hand, every time.
    for proposal in &discovery.proposals {
        assert!(crate::team::is_valid_repo_slug(&proposal.repo));
        assert!(
            !proposal.repo.eq_ignore_ascii_case(&team_repo),
            "the team repo is never one of its own workspaces"
        );
        if let Some(manifest) = &manifest {
            assert!(
                !manifest
                    .workspaces
                    .iter()
                    .any(|w| w.repo.eq_ignore_ascii_case(&proposal.repo)),
                "{} is already a team workspace and must not be proposed",
                proposal.repo
            );
        }
    }
}

/// The invite plan against this Mac's real manifest, with GitHub's real
/// answers about a real person. Reads only; sends nothing.
///
/// The person asked about is **this account**, which the manifest already
/// lists — so the plan must add nobody to the manifest, and every repository
/// it can reach should come back as needing nothing. That is the acceptance
/// journey's "the member is already in" state, asserted rather than assumed.
#[test]
#[ignore = "reads the signed-in GitHub account and this Mac's team clone"]
fn the_invite_plan_runs_against_this_macs_real_team() {
    let Some(clone) = local_team_clone() else {
        println!("no team clone on this Mac — nothing to check");
        return;
    };
    let manifest = crate::team::read_manifest(&clone)
        .expect("the real manifest must parse")
        .expect("the clone must carry one");
    let team_repo = clone_origin_slug(&clone).expect("the clone must have a GitHub origin");
    let me = my_login();

    let mut repos = vec![team_repo.clone()];
    repos.extend(manifest.workspaces.iter().map(|w| w.repo.clone()));
    let access: Vec<(String, CollaboratorAccess)> = repos
        .iter()
        .filter(|repo| crate::team::is_valid_repo_slug(repo))
        .map(|repo| {
            let endpoint = format!("repos/{repo}/collaborators/{me}/permission");
            let answer = match gh(&["api", &endpoint, "--jq", ".permission"]) {
                Ok(word) => match word.as_str() {
                    "admin" => CollaboratorAccess::Admin,
                    "write" | "maintain" => CollaboratorAccess::Write,
                    "read" | "triage" => CollaboratorAccess::Read,
                    "none" => CollaboratorAccess::None,
                    _ => CollaboratorAccess::Unknown,
                },
                Err(_) => CollaboratorAccess::Unknown,
            };
            (repo.clone(), answer)
        })
        .collect();

    let plan = build_invite_plan(&me, &team_repo, &manifest, &access)
        .expect("a real manifest and a real login must plan");
    println!("{me} on {}: {:#?}", plan.team_name, plan.steps);
    // One line per repository the team owns — the team repo and every
    // workspace — and no duplicates.
    assert_eq!(plan.steps.len(), 1 + manifest.workspaces.len());
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(
        !plan.adds_to_manifest,
        "this account is already listed in its own team's manifest"
    );
    // The digest covers exactly the grants, and confirming it lets the same
    // plan through.
    assert!(grants_were_confirmed(&plan, &plan.digest).is_ok());
}

/// The owner gate against reality: this Mac is signed in as a *member*, so
/// every manifest edit is refused, and the refusal names both people.
///
/// Ply's own check is the only enforcement of this — GitHub write access is
/// repository-wide — so it is worth asserting against a real team rather
/// than only a fixture.
#[test]
#[ignore = "reads the signed-in GitHub account and this Mac's team clone"]
fn the_owner_gate_answers_correctly_for_whoever_is_signed_in_here() {
    let Some(clone) = local_team_clone() else {
        println!("no team clone on this Mac — nothing to check");
        return;
    };
    let manifest = crate::team::read_manifest(&clone).unwrap().unwrap();
    let owner = manifest.owner_login().expect("the manifest must name an owner");
    let me = my_login();
    let verdict = authorize_owner_action(true, Some(owner), Some(&me));
    if me.eq_ignore_ascii_case(owner) {
        assert!(verdict.is_ok(), "the owner must be allowed to edit their own team");
    } else {
        let refusal = verdict.expect_err("a member is not the owner");
        assert!(refusal.contains(owner), "{refusal}");
        assert!(refusal.contains(&me), "{refusal}");
        println!("refused, correctly: {refusal}");
    }
    // And no key is a refusal whoever you are.
    assert!(authorize_owner_action(false, Some(owner), Some(&me)).is_err());
}

/// The empty-repository answer resume relies on, which could not be measured
/// while building without creating a repository. Point it at an empty private
/// repo you own to confirm GitHub still answers the documented 409:
///
/// ```sh
/// PLY_EMPTY_REPO=owner/empty-repo cargo test --lib \
///   team_admin::live_tests::an_empty_repository_answers_the_documented_409 -- --ignored
/// ```
#[test]
#[ignore = "needs an empty repository named in PLY_EMPTY_REPO"]
fn an_empty_repository_answers_the_documented_409() {
    let Ok(repo) = std::env::var("PLY_EMPTY_REPO") else {
        println!("PLY_EMPTY_REPO not set — nothing to check");
        return;
    };
    let endpoint = format!("repos/{repo}/commits?per_page=1");
    let error = gh(&["api", &endpoint, "--jq", "length"])
        .expect_err("an empty repository has no commits to list");
    assert!(
        crate::github::is_empty_repository_error(&error),
        "resume reads only this answer as empty; GitHub said: {error}"
    );
}

/// And a repository with history is not empty — measured on the repository
/// this card is built in.
#[test]
#[ignore = "reads the signed-in GitHub account"]
fn a_repository_with_history_lists_a_commit() {
    let count = gh(&[
        "api",
        "repos/MatteoB-adv/atelier/commits?per_page=1",
        "--jq",
        "length",
    ])
    .expect("a repository with history lists its commits");
    assert_eq!(count, "1");
}

/// The recovery path reads a finished team's `team.json` through the raw
/// media type, and decides from it whose team it is. Measured on this Mac's
/// real team repo: the raw bytes come back and parse as the manifest.
#[test]
#[ignore = "reads the signed-in GitHub account and this Mac's team clone"]
fn a_finished_teams_manifest_reads_back_raw_and_parses() {
    let Some(clone) = local_team_clone() else {
        println!("no team clone on this Mac — nothing to check");
        return;
    };
    let repo = clone_origin_slug(&clone).expect("the clone must have a GitHub origin");
    let raw = gh(&[
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        &format!("repos/{repo}/contents/team.json"),
    ])
    .expect("the team repo must serve its manifest raw");
    let manifest = crate::team::parse_manifest(raw.as_bytes())
        .expect("the raw bytes must be the manifest itself, not a JSON envelope");
    assert!(manifest.owner_login().is_some());
}
