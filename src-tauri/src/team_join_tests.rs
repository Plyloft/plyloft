//! OB-10 Tier 3: the invite code (format, hostile inputs), and the join
//! decisions against a stub gh — no network, no real invitation accepted.

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

// ── The invite code ─────────────────────────────────────────────────────

#[test]
fn the_code_round_trips_and_is_version_one() {
    let code = encode_invite_code("mb-adv/ply-team").unwrap();
    assert_eq!(code, "ply-join:mb-adv/ply-team");
    assert_eq!(parse_invite_code(&code), Ok("mb-adv/ply-team".to_string()));
    // Explicit version 1, any case of the prefix, surrounding whitespace.
    assert_eq!(parse_invite_code("  ply-join:v1:mb-adv/ply-team\n"), Ok("mb-adv/ply-team".into()));
    assert_eq!(parse_invite_code("PLY-JOIN:mb-adv/ply-team"), Ok("mb-adv/ply-team".into()));
    // An owner that starts with v is not a version.
    assert_eq!(parse_invite_code("ply-join:vercel/team"), Ok("vercel/team".into()));
    // Case is kept as written (GitHub's names read that way).
    assert_eq!(parse_invite_code("ply-join:MB-Adv/Ply.Team_1"), Ok("MB-Adv/Ply.Team_1".into()));
}

#[test]
fn the_same_field_takes_a_bare_name_and_a_github_link() {
    for ok in [
        "mb-adv/ply-team",
        "https://github.com/mb-adv/ply-team",
        "https://github.com/mb-adv/ply-team/",
        "https://github.com/mb-adv/ply-team.git",
        "https://www.github.com/mb-adv/ply-team",
        "HTTPS://GitHub.com/mb-adv/ply-team",
        "github.com/mb-adv/ply-team",
    ] {
        assert_eq!(parse_invite_code(ok), Ok("mb-adv/ply-team".to_string()), "{ok}");
    }
}

#[test]
fn a_newer_version_asks_for_an_update_and_a_bad_one_is_not_a_code() {
    assert_eq!(parse_invite_code("ply-join:v2:mb-adv/ply-team"), Err(CodeRefusal::NewerVersion));
    assert_eq!(parse_invite_code("ply-join:v17:mb-adv/ply-team"), Err(CodeRefusal::NewerVersion));
    for bad in ["ply-join:v0:mb-adv/ply-team", "ply-join:v:mb-adv/ply-team", "ply-join:v1x:mb-adv/t", "ply-join:v99999:a/b", "ply-join:v1:"] {
        assert_eq!(parse_invite_code(bad), Err(CodeRefusal::NotACode), "{bad}");
    }
    assert_eq!(CodeRefusal::NewerVersion.words(), NEWER_CODE);
}

#[test]
fn hostile_inputs_are_refused() {
    let long_name = format!("ply-join:mb-adv/{}", "a".repeat(101));
    let long_owner = format!("ply-join:{}/team", "a".repeat(40));
    let cases: Vec<String> = vec![
        // Injection characters.
        "ply-join:mb-adv/ply-team;rm -rf ~".into(),
        "ply-join:mb-adv/$(whoami)".into(),
        "ply-join:mb-adv/`id`".into(),
        "ply-join:mb-adv/ply-team&&x".into(),
        "ply-join:mb-adv/ply team".into(),
        "ply-join:mb-adv/ply-team\nply-join:evil/x".into(),
        "ply-join:mb-adv/ply-team\0".into(),
        "ply-join:mb-adv/ply-team|cat".into(),
        "ply-join:\"mb-adv/ply-team\"".into(),
        "ply-join:mb-adv/ply-team?x=1".into(),
        "ply-join:mb-adv%2Fply-team".into(),
        // Paths out.
        "ply-join:mb-adv/..".into(),
        "ply-join:../ply-team".into(),
        "ply-join:mb-adv/../../etc".into(),
        "ply-join:mb-adv/.".into(),
        "ply-join:mb-adv\\ply-team".into(),
        "ply-join:/ply-team".into(),
        "ply-join:mb-adv/".into(),
        "ply-join:mb-adv/ply-team/extra".into(),
        // Owners GitHub can't have.
        "ply-join:-mb/ply-team".into(),
        "ply-join:mb--adv/ply-team".into(),
        "ply-join:mb_adv/ply-team".into(),
        "ply-join:mb.adv/ply-team".into(),
        // Overlong.
        long_name,
        long_owner,
        // Unicode confusables and invisibles.
        "ply-join:mb-аdv/ply-team".into(),       // Cyrillic а
        "ply-join:mb-adv／ply-team".into(),      // full-width solidus
        "ply-join:mb-adv/ply\u{200B}-team".into(), // zero-width space
        "ply-join:mb-adv/ply-team\u{202E}".into(), // right-to-left override
        "ply‐join:mb-adv/ply-team".into(),       // U+2010 hyphen
        "ｐｌｙ-join:mb-adv/ply-team".into(),     // full-width letters
        // The future link isn't handled by this release (D11).
        "ply://join?v=1&repo=mb-adv/ply-team".into(),
        // Not a code at all.
        "hello".into(),
        "ply-join:".into(),
        "mb-adv".into(),
    ];
    for bad in &cases {
        assert!(parse_invite_code(bad).is_err(), "accepted {bad:?}");
    }
    assert_eq!(parse_invite_code("   "), Err(CodeRefusal::Empty));
    assert_eq!(parse_invite_code(&"x".repeat(MAX_INVITE_INPUT + 1)), Err(CodeRefusal::TooLong));
    assert_eq!(CodeRefusal::TooLong.words(), "That isn't a Plyloft invite code.");
}

#[test]
fn links_to_other_hosts_are_refused_as_such() {
    for other in [
        "https://gitlab.com/mb-adv/ply-team",
        "https://github.com.evil.com/mb-adv/ply-team",
        "https://evil.com/github.com/mb-adv/ply-team",
        "https://user@github.com/mb-adv/ply-team",
        "https://github.com@evil.com/mb-adv/ply-team",
        "https://github.com:443/mb-adv/ply-team",
        "ssh://git@github.com/mb-adv/ply-team",
        "javascript://github.com/%0aalert(1)",
    ] {
        assert_eq!(parse_invite_code(other), Err(CodeRefusal::OtherHost), "{other}");
    }
    for bad in [
        "http://github.com/mb-adv/ply-team",
        "https://github.com/mb-adv/ply-team?tab=x",
        "https://github.com/mb-adv/ply-team#readme",
        "https://github.com/mb-adv/ply-team/tree/main",
        "https://github.com/mb-adv",
    ] {
        assert_eq!(parse_invite_code(bad), Err(CodeRefusal::NotACode), "{bad}");
    }
}

#[test]
fn only_a_team_repo_name_is_ever_encoded() {
    assert_eq!(encode_invite_code(" mb-adv/ply-team "), Some("ply-join:mb-adv/ply-team".into()));
    for bad in ["", "mb-adv", "mb-adv/../x", "mb adv/x", "a/b/c", "mb-аdv/x"] {
        assert_eq!(encode_invite_code(bad), None, "{bad}");
    }
}

#[test]
fn the_invite_message_carries_the_code_and_no_secret() {
    let msg = invite_message("MB Adv", "mb-adv/ply-team").unwrap();
    assert!(msg.starts_with("Join “MB Adv” in Plyloft.\n"), "{msg}");
    assert!(msg.contains("https://github.com/MatteoB-adv/ply-releases/releases/latest\n"));
    assert!(!msg.contains("<ply-site>"));
    // Plyloft accepts the invitation when the code is pasted: no step on GitHub.
    assert!(!msg.contains("check your email"), "{msg}");
    assert!(msg.contains(
        "2. In Plyloft, open Setup › Your team › Join a team and paste this code:\n   ply-join:mb-adv/ply-team\n   \
         Plyloft accepts the GitHub invitation to mb-adv/ply-team for you.\n"
    ), "{msg}");
    assert!(msg.contains("Apple Silicon"));
    // A pointer only: the repository and nothing else from this Mac.
    assert!(!msg.contains('@'));
    assert!(!msg.to_ascii_lowercase().contains("token"));
    assert_eq!(invite_message("MB Adv", "not a repo"), None);
    // A hostile team name is cleaned before it is quoted.
    let msg = invite_message("Evil\u{202E}\nTeam\u{0007}", "mb-adv/ply-team").unwrap();
    assert!(msg.starts_with("Join “Evil Team” in Plyloft."), "{msg}");
}

#[test]
fn a_team_name_is_shown_clean_and_capped() {
    assert_eq!(display_team_name("  MB   Adv "), Some("MB Adv".into()));
    assert_eq!(display_team_name("a\u{200B}b\u{202E}c\u{2066}"), Some("abc".into()));
    assert_eq!(display_team_name("\u{0000}\u{001b}[31m"), Some("[31m".into()));
    assert_eq!(display_team_name("   \u{200B} "), None);
    let long = display_team_name(&"x".repeat(500)).unwrap();
    assert_eq!(long.chars().count(), MAX_TEAM_NAME + 1);
    assert!(long.ends_with('…'));
}

// ── A stub gh ───────────────────────────────────────────────────────────

const ME: &str = "mb-member";
const TEAM: &str = "mb-adv/ply-team";

#[derive(Default)]
struct Stub {
    repos: HashMap<String, Result<Option<RepoFacts>, String>>,
    manifests: HashMap<String, Result<Option<Vec<u8>>, String>>,
    /// After an accept, these manifests become readable.
    after_accept: HashMap<String, Vec<u8>>,
    invitations: RefCell<Option<Result<Vec<Invitation>, String>>>,
    accept_fails: HashMap<u64, String>,
    list: Option<Result<Vec<String>, String>>,
    accepted: RefCell<Vec<u64>>,
    calls: RefCell<Vec<String>>,
}

impl Stub {
    fn readable(mut self, repo: &str, manifest: Option<&str>) -> Self {
        self.repos.insert(
            repo.into(),
            Ok(Some(RepoFacts {
                full_name: repo.into(),
                private: Some(true),
                owner: repo.split('/').next().map(String::from),
                owner_is_org: false,
            })),
        );
        self.manifests.insert(repo.into(), Ok(manifest.map(|m| m.as_bytes().to_vec())));
        self
    }

    fn hidden(mut self, repo: &str) -> Self {
        self.repos.insert(repo.into(), Ok(None));
        self.manifests.insert(repo.into(), Ok(None));
        self
    }

    fn invites(self, list: Vec<Invitation>) -> Self {
        *self.invitations.borrow_mut() = Some(Ok(list));
        self
    }
}

impl JoinGh for Stub {
    fn repo(&self, repo: &str) -> Result<Option<RepoFacts>, String> {
        self.calls.borrow_mut().push(format!("repo {repo}"));
        self.repos.get(repo).cloned().unwrap_or(Ok(None))
    }
    fn manifest(&self, repo: &str) -> Result<Option<Vec<u8>>, String> {
        self.calls.borrow_mut().push(format!("manifest {repo}"));
        if let Some(bytes) = self.after_accept.get(repo) {
            if !self.accepted.borrow().is_empty() {
                return Ok(Some(bytes.clone()));
            }
        }
        self.manifests.get(repo).cloned().unwrap_or(Ok(None))
    }
    fn invitations(&self) -> Result<Vec<Invitation>, String> {
        self.calls.borrow_mut().push("invitations".into());
        let all = self.invitations.borrow().clone().unwrap_or(Ok(Vec::new()))?;
        // An accepted invitation leaves GitHub's list.
        let accepted = self.accepted.borrow();
        Ok(all.into_iter().filter(|i| !accepted.contains(&i.id)).collect())
    }
    fn accept_invitation(&self, id: u64) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("accept {id}"));
        if let Some(e) = self.accept_fails.get(&id) {
            return Err(e.clone());
        }
        self.accepted.borrow_mut().push(id);
        Ok(())
    }
    fn repos(&self, _limit: usize) -> Result<Vec<String>, String> {
        self.calls.borrow_mut().push("repos".into());
        self.list.clone().unwrap_or(Ok(Vec::new()))
    }
}

fn manifest(name: &str, owner: &str, members: &[&str], workspaces: &[&str]) -> String {
    let mut people = vec![format!(r#"{{"login":"{owner}","owner":true}}"#)];
    people.extend(members.iter().map(|m| format!(r#"{{"login":"{m}"}}"#)));
    let ws: Vec<String> = workspaces.iter().map(|w| format!(r#"{{"repo":"{w}"}}"#)).collect();
    format!(
        r#"{{"schemaVersion":1,"name":"{name}","members":[{}],"workspaces":[{}]}}"#,
        people.join(","),
        ws.join(",")
    )
}

fn invitation(id: u64, repo: &str, inviter: &str) -> Invitation {
    Invitation {
        id,
        repo: repo.into(),
        owner: repo.split('/').next().map(String::from),
        owner_is_org: false,
        inviter: Some(inviter.into()),
        expired: false,
    }
}

fn request(repo: &str) -> JoinRequest {
    JoinRequest { repo: repo.into(), accept_invitation: None, accept_workspaces: vec![], replace: false }
}

fn problem_kind(p: &JoinPreview) -> Option<ProblemKind> {
    match p {
        JoinPreview::Problem { problem } => Some(problem.kind),
        _ => None,
    }
}

// ── The sheet ───────────────────────────────────────────────────────────

#[test]
fn a_readable_team_that_lists_you_is_ready_with_its_workspace_invitations() {
    let gh = Stub::default()
        .readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &[ME], &["mb-adv/app", "mb-adv/site", TEAM])))
        .invites(vec![
            invitation(7, "mb-adv/app", "mb-adv"),
            invitation(8, "evil/other", "evil"),
            Invitation { expired: true, ..invitation(9, "mb-adv/site", "mb-adv") },
        ]);
    let JoinPreview::Ready { team, workspace_invites, replaces, already_in, calls } = preview(&gh, TEAM, ME, None) else {
        panic!("not ready");
    };
    assert_eq!(team.name.as_deref(), Some("MB Adv"));
    assert_eq!(team.repo_owner.as_deref(), Some("mb-adv"));
    assert_eq!(team.manifest_owner.as_deref(), Some("mb-adv"));
    assert_eq!(team.url, "https://github.com/mb-adv/ply-team");
    // Only the listed workspace's live invitation; never another repo's.
    assert_eq!(workspace_invites, vec![WorkspaceInvite { id: 7, repo: "mb-adv/app".into(), inviter: Some("mb-adv".into()) }]);
    assert_eq!(replaces, None);
    assert!(!already_in);
    assert!(calls.iter().any(|c| c.contains("repos/mb-adv/ply-team/contents/team.json")));
    // Reading the sheet accepts nothing.
    assert!(gh.accepted.borrow().is_empty());
}

#[test]
fn the_sheet_names_the_team_it_replaces_and_one_already_joined() {
    let gh = Stub::default().readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &[ME], &[])));
    let other = CurrentTeam { repo: "other/team".into(), name: Some("Other team".into()) };
    let JoinPreview::Ready { replaces, already_in, .. } = preview(&gh, TEAM, ME, Some(&other)) else { panic!() };
    assert_eq!(replaces, Some(other));
    assert!(!already_in);
    let same = CurrentTeam { repo: "MB-ADV/ply-team".into(), name: None };
    let JoinPreview::Ready { replaces, already_in, .. } = preview(&gh, TEAM, ME, Some(&same)) else { panic!() };
    assert_eq!(replaces, None);
    assert!(already_in);
}

#[test]
fn access_without_being_listed_or_without_team_json_is_said_so() {
    let gh = Stub::default().readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &["someone"], &[])));
    let p = preview(&gh, TEAM, ME, None);
    assert_eq!(problem_kind(&p), Some(ProblemKind::NotListed));
    let JoinPreview::Problem { problem } = p else { panic!() };
    assert_eq!(problem.words, "You can read the team's repository, but its owner hasn't added you to the team.");

    let gh = Stub::default().readable("mb-adv/website", None);
    let JoinPreview::Problem { problem } = preview(&gh, "mb-adv/website", ME, None) else { panic!() };
    assert_eq!(problem.kind, ProblemKind::NotATeam);
    assert_eq!(problem.words, "mb-adv/website isn't a Plyloft team. It has no team.json.");

    let gh = Stub::default().readable(TEAM, Some("{ not json"));
    assert_eq!(problem_kind(&preview(&gh, TEAM, ME, None)), Some(ProblemKind::NotATeam));
    let huge = format!(r#"{{"name":"x","members":[{{"login":"{ME}"}}],"pad":"{}"}}"#, "x".repeat(MAX_MANIFEST_BYTES));
    let gh = Stub::default().readable(TEAM, Some(&huge));
    assert_eq!(problem_kind(&preview(&gh, TEAM, ME, None)), Some(ProblemKind::NotATeam));
}

#[test]
fn no_access_names_the_account_and_an_expired_invitation_says_ask_again() {
    let gh = Stub::default().hidden(TEAM).invites(vec![invitation(3, "mb-adv/other", "mb-adv")]);
    let JoinPreview::Problem { problem } = preview(&gh, TEAM, ME, None) else { panic!() };
    assert_eq!(problem.kind, ProblemKind::NoAccess);
    assert_eq!(
        problem.words,
        "You don't have access to mb-adv/ply-team yet. Ask the owner to invite your GitHub account “mb-member”."
    );

    let gh = Stub::default().hidden(TEAM).invites(vec![Invitation { expired: true, ..invitation(3, TEAM, "mb-adv") }]);
    let JoinPreview::Problem { problem } = preview(&gh, TEAM, ME, None) else { panic!() };
    assert_eq!(problem.kind, ProblemKind::Expired);
    assert_eq!(problem.words, "The GitHub invitation expired. Ask the owner to invite you again.");
}

#[test]
fn a_pending_invitation_to_the_pasted_repo_is_offered_with_who_invited() {
    let gh = Stub::default().hidden(TEAM).invites(vec![
        invitation(11, "evil/ply-team", "evil"),
        invitation(12, "MB-ADV/ply-team", "mb-friend"),
    ]);
    let JoinPreview::Invited { team, invitation: inv, .. } = preview(&gh, TEAM, ME, None) else { panic!("not invited") };
    assert_eq!(inv.id, 12);
    assert_eq!(inv.inviter.as_deref(), Some("mb-friend"));
    // Invited by a member, not the owner: shown, and allowed.
    assert!(inv.inviter_not_owner);
    assert_eq!(team.repo_owner.as_deref(), Some("MB-ADV"));
    assert!(gh.accepted.borrow().is_empty());

    // An organisation's repository: GitHub's owner is the org, never "not the owner".
    let gh = Stub::default().hidden(TEAM).invites(vec![Invitation { owner_is_org: true, ..invitation(12, TEAM, "someone") }]);
    let JoinPreview::Invited { invitation: inv, .. } = preview(&gh, TEAM, ME, None) else { panic!() };
    assert!(!inv.inviter_not_owner);
}

#[test]
fn gh_failures_are_put_in_words() {
    let sso = "HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (https://github.com/orgs/acme/sso?authorization_request=AAA)";
    let mut gh = Stub::default();
    gh.repos.insert(TEAM.into(), Err(sso.into()));
    let JoinPreview::Problem { problem } = preview(&gh, TEAM, ME, None) else { panic!() };
    assert_eq!(problem.kind, ProblemKind::Sso);
    assert_eq!(problem.org.as_deref(), Some("acme"));
    assert_eq!(problem.words, "Your organization “acme” needs you to authorize the GitHub CLI for single sign-on.");
    assert!(problem.details.unwrap().contains("SAML"));

    for (err, kind) in [
        ("error connecting to api.github.com\ncheck your internet connection", ProblemKind::Offline),
        ("dial tcp: lookup api.github.com: no such host", ProblemKind::Offline),
        ("It didn't finish within 20 seconds.", ProblemKind::Offline),
        ("HTTP 401: Bad credentials (https://api.github.com/user)", ProblemKind::SignedOut),
        ("HTTP 403: API rate limit exceeded for user", ProblemKind::RateLimited),
        ("HTTP 500: whatever", ProblemKind::Other),
    ] {
        let p = gh_problem(err, ME);
        assert_eq!(p.kind, kind, "{err}");
    }
    assert_eq!(gh_problem("could not resolve host: api.github.com", ME).words, "Joining needs GitHub. You're offline.");
}

// ── Joining: D16 ────────────────────────────────────────────────────────

#[test]
fn joining_a_readable_team_accepts_nothing_and_verifies_the_manifest() {
    let gh = Stub::default()
        .readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &[ME], &[])))
        .invites(vec![invitation(5, "someone/else", "x")]);
    let v = verify_join(&gh, &request(TEAM), ME, None).unwrap();
    assert_eq!(v.repo, TEAM);
    assert!(!v.accepted_invitation);
    assert!(gh.accepted.borrow().is_empty(), "nothing accepted without an invitation asked for");
}

#[test]
fn the_pasted_repos_invitation_is_accepted_then_team_json_is_checked() {
    let mut gh = Stub::default().hidden(TEAM).invites(vec![invitation(12, TEAM, "mb-adv")]);
    gh.after_accept.insert(TEAM.into(), manifest("MB Adv", "mb-adv", &[ME], &[]).into_bytes());
    let v = verify_join(&gh, &JoinRequest { accept_invitation: Some(12), ..request(TEAM) }, ME, None).unwrap();
    assert!(v.accepted_invitation);
    assert_eq!(*gh.accepted.borrow(), vec![12]);
    // Re-listed right before the accept, and the manifest read after it.
    let calls = gh.calls.borrow().clone();
    let at = |c: &str| calls.iter().position(|x| x == c).unwrap();
    assert!(at("invitations") < at("accept 12"));
    assert!(at("accept 12") < calls.iter().rposition(|x| x == "manifest mb-adv/ply-team").unwrap());
}

#[test]
fn an_invitation_to_a_different_repo_is_never_accepted() {
    // The sheet's id now points at another repository (or the frontend sent
    // one): refused, and nothing is accepted.
    let gh = Stub::default().hidden(TEAM).invites(vec![invitation(12, TEAM, "mb-adv"), invitation(99, "evil/team", "evil")]);
    let err = verify_join(&gh, &JoinRequest { accept_invitation: Some(99), ..request(TEAM) }, ME, None).unwrap_err();
    assert_eq!(err.kind, ProblemKind::Other);
    assert!(err.words.contains("Plyloft accepts only the invitation to the team you pasted."), "{}", err.words);
    assert!(gh.accepted.borrow().is_empty());

    // An id that isn't there any more.
    let gh = Stub::default().hidden(TEAM).invites(vec![invitation(12, TEAM, "mb-adv")]);
    let err = verify_join(&gh, &JoinRequest { accept_invitation: Some(13), ..request(TEAM) }, ME, None).unwrap_err();
    assert_eq!(err.kind, ProblemKind::InvitationGone);
    assert!(gh.accepted.borrow().is_empty());

    // Expired since the sheet was read.
    let gh = Stub::default().hidden(TEAM).invites(vec![Invitation { expired: true, ..invitation(12, TEAM, "mb-adv") }]);
    let err = verify_join(&gh, &JoinRequest { accept_invitation: Some(12), ..request(TEAM) }, ME, None).unwrap_err();
    assert_eq!(err.kind, ProblemKind::Expired);
    assert!(gh.accepted.borrow().is_empty());
}

#[test]
fn an_accepted_repo_that_isnt_a_team_stops_and_says_what_was_changed() {
    let gh = Stub::default().hidden("mb-adv/website").invites(vec![invitation(4, "mb-adv/website", "mb-adv")]);
    let err = verify_join(&gh, &JoinRequest { accept_invitation: Some(4), ..request("mb-adv/website") }, ME, None).unwrap_err();
    assert_eq!(err.kind, ProblemKind::NotATeam);
    assert!(err.accepted);
    assert_eq!(
        err.words,
        "mb-adv/website isn't a Plyloft team. It has no team.json. You accepted GitHub's invitation to it; nothing else was changed."
    );

    // Accepted, but the manifest doesn't list you.
    let mut gh = Stub::default().hidden(TEAM).invites(vec![invitation(12, TEAM, "mb-adv")]);
    gh.after_accept.insert(TEAM.into(), manifest("MB Adv", "mb-adv", &["other"], &[]).into_bytes());
    let err = verify_join(&gh, &JoinRequest { accept_invitation: Some(12), ..request(TEAM) }, ME, None).unwrap_err();
    assert_eq!(err.kind, ProblemKind::NotListed);
    assert!(err.accepted);
}

#[test]
fn without_access_or_an_invitation_nothing_happens() {
    let gh = Stub::default().hidden(TEAM);
    let err = verify_join(&gh, &request(TEAM), ME, None).unwrap_err();
    assert_eq!(err.kind, ProblemKind::NoAccess);
    assert!(gh.accepted.borrow().is_empty());
}

#[test]
fn a_second_team_needs_the_replacement_confirmed() {
    let gh = Stub::default().readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &[ME], &[])));
    let other = CurrentTeam { repo: "other/team".into(), name: Some("Other team".into()) };
    let err = verify_join(&gh, &request(TEAM), ME, Some(&other)).unwrap_err();
    assert_eq!(err.kind, ProblemKind::NeedsReplace);
    assert_eq!(err.words, format!("{} is in “Other team”. Joining “mb-adv/ply-team” replaces it.", crate::platform::THIS_MACHINE_CAP));
    assert!(gh.calls.borrow().is_empty(), "refused before asking GitHub anything");
    assert!(verify_join(&gh, &JoinRequest { replace: true, ..request(TEAM) }, ME, Some(&other)).is_ok());
    // Re-joining the same team is not a replacement.
    let same = CurrentTeam { repo: TEAM.into(), name: None };
    assert!(verify_join(&gh, &request(TEAM), ME, Some(&same)).is_ok());
}

#[test]
fn a_hostile_request_repo_is_refused_before_any_call() {
    let gh = Stub::default();
    for bad in ["mb-adv/../x", "x", "a/b/c", "mb-аdv/team", "mb adv/team"] {
        let err = verify_join(&gh, &request(bad), ME, None).unwrap_err();
        assert_eq!(err.kind, ProblemKind::NotACode, "{bad}");
    }
    assert!(gh.calls.borrow().is_empty());
}

// ── Team workspace invitations ──────────────────────────────────────────

#[test]
fn only_named_workspaces_the_manifest_lists_are_accepted() {
    let gh = Stub::default().invites(vec![
        invitation(1, "mb-adv/app", "mb-adv"),
        invitation(2, "mb-adv/site", "mb-adv"),
        invitation(3, "evil/app", "evil"),
        invitation(4, TEAM, "mb-adv"),
    ]);
    let listed = vec!["mb-adv/app".to_string(), "mb-adv/site".to_string()];
    // Asked for app and evil/app (not listed) and the team repo: only app.
    let out = accept_workspace_invites(
        &gh,
        &listed,
        &["mb-adv/app".into(), "evil/app".into(), TEAM.into()],
        ME,
    );
    assert_eq!(out.accepted, vec!["mb-adv/app".to_string()]);
    assert_eq!(*gh.accepted.borrow(), vec![1]);
    assert_eq!(out.pending.iter().map(|i| i.id).collect::<Vec<_>>(), vec![2]);
    assert!(out.failed.is_empty());
}

#[test]
fn a_refused_workspace_accept_is_reported_not_hidden() {
    let mut gh = Stub::default().invites(vec![invitation(1, "mb-adv/app", "mb-adv")]);
    gh.accept_fails.insert(1, "dial tcp: i/o timeout".into());
    let out = accept_workspace_invites(&gh, &["mb-adv/app".into()], &["mb-adv/app".into()], ME);
    assert!(out.accepted.is_empty());
    assert_eq!(out.failed, vec![WorkspaceFailure { repo: "mb-adv/app".into(), words: "Joining needs GitHub. You're offline.".into() }]);
}

#[test]
fn a_manifests_workspaces_are_only_owner_name_entries_never_the_team_repo() {
    let bytes = manifest("T", "mb-adv", &[ME], &["mb-adv/app", "../../etc", "a/b/c", "MB-ADV/PLY-TEAM", "mb-adv/app", "mb-аdv/x"]);
    let team = read_team(TEAM, bytes.as_bytes(), ME).unwrap();
    assert_eq!(team.workspaces, vec!["mb-adv/app".to_string()]);
    assert!(team.lists_login);
    // An owner that isn't a login is not shown.
    let bytes = r#"{"name":"T","members":[{"login":"<script>","owner":true},{"login":"mb-member"}]}"#;
    assert_eq!(read_team(TEAM, bytes.as_bytes(), ME).unwrap().owner, None);
}

// ── Detection (§12.4) ───────────────────────────────────────────────────

#[test]
fn detection_lists_only_readable_teams_that_list_you() {
    let mut gh = Stub::default()
        .readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &[ME], &[])))
        .readable("other/team", Some(&manifest("Other", "other", &["someone"], &[])))
        .readable("mb-adv/app", None)
        // A pending invitation is never listed on its own (D16).
        .invites(vec![invitation(1, "pending/team", "pending")]);
    gh.manifests.insert("broken/x".into(), Err("HTTP 500".into()));
    gh.list = Some(Ok(vec!["mb-adv/app".into(), TEAM.into(), "other/team".into(), "broken/x".into(), "not a repo".into()]));
    let d = detect(&gh, ME, Some(TEAM), later());
    assert_eq!(
        d.teams,
        vec![DetectedTeam { repo: TEAM.into(), name: "MB Adv".into(), owner: Some("mb-adv".into()), current: true }]
    );
    assert_eq!(d.scanned, 4);
    assert_eq!(d.unanswered, 1);
    assert!(!d.truncated);
    assert_eq!(d.problem, None);
    assert!(gh.accepted.borrow().is_empty());
    assert!(!gh.calls.borrow().iter().any(|c| c == "invitations"), "detection never reads invitations");
}

#[test]
fn detection_that_couldnt_ask_says_why() {
    let mut gh = Stub::default();
    gh.list = Some(Err("could not resolve host: api.github.com".into()));
    let d = detect(&gh, ME, None, later());
    assert_eq!(d.problem.unwrap().kind, ProblemKind::Offline);

    let mut gh = Stub::default();
    gh.manifests.insert("a/b".into(), Err("dial tcp: i/o timeout".into()));
    gh.list = Some(Ok(vec!["a/b".into()]));
    let d = detect(&gh, ME, None, later());
    assert_eq!(d.problem.unwrap().kind, ProblemKind::Offline);

    let mut gh = Stub::default();
    gh.list = Some(Ok((0..150).map(|i| format!("o/r{i}")).collect()));
    let d = detect(&gh, ME, None, later());
    assert_eq!(d.scanned, DETECT_LIMIT);
    assert!(d.truncated);
}

fn later() -> std::time::Instant {
    std::time::Instant::now() + DETECT_DEADLINE_AFTER
}

#[test]
fn detection_stops_at_its_deadline_and_says_how_many_went_unasked() {
    let mut gh = Stub::default().readable(TEAM, Some(&manifest("MB Adv", "mb-adv", &[ME], &[])));
    gh.list = Some(Ok(vec![TEAM.into(), "o/a".into()]));
    // A deadline already past: nothing more is asked of GitHub.
    let d = detect(&gh, ME, None, std::time::Instant::now());
    assert!(d.timed_out);
    assert_eq!(d.unanswered, 2);
    assert!(d.teams.is_empty());
    assert!(!gh.calls.borrow().iter().any(|c| c.starts_with("manifest")));
    assert_eq!(d.problem.unwrap().kind, ProblemKind::Offline);
    // Such a look is never kept for the session.
    remember_detection(&Detection { login: "deadline-login".into(), ..d_clean() });
    let mut timed = d_clean();
    timed.login = "deadline-login-2".into();
    timed.timed_out = true;
    remember_detection(&timed);
    assert!(cached_detection("deadline-login-2", None).is_none());
    assert!(cached_detection("DEADLINE-LOGIN", None).is_some());
}

fn d_clean() -> Detection {
    Detection { login: String::new(), teams: vec![], scanned: 0, truncated: false, unanswered: 0, timed_out: false, problem: None }
}

#[test]
fn a_kept_detection_rereads_which_team_is_current() {
    let mut kept = d_clean();
    kept.login = "kept-login".into();
    kept.teams = vec![DetectedTeam { repo: TEAM.into(), name: "MB Adv".into(), owner: None, current: false }];
    remember_detection(&kept);
    assert!(cached_detection("kept-login", Some("MB-ADV/ply-team")).unwrap().teams[0].current);
    assert!(!cached_detection("kept-login", None).unwrap().teams[0].current);
}

#[test]
fn a_too_large_manifest_is_not_a_team_anywhere() {
    let mut gh = Stub::default().readable(TEAM, None);
    gh.manifests.insert(TEAM.into(), Err(TOO_LARGE_MANIFEST.into()));
    let JoinPreview::Problem { problem } = preview(&gh, TEAM, ME, None) else { panic!() };
    assert_eq!(problem.kind, ProblemKind::NotATeam);
    assert!(problem.words.contains(TOO_LARGE_MANIFEST));
    assert_eq!(verify_join(&gh, &request(TEAM), ME, None).unwrap_err().kind, ProblemKind::NotATeam);
    gh.list = Some(Ok(vec![TEAM.into()]));
    let d = detect(&gh, ME, None, later());
    assert_eq!((d.unanswered, d.problem), (0, None));
}

#[test]
fn a_join_that_couldnt_be_remembered_says_what_was_accepted() {
    let verified = Verified {
        repo: TEAM.into(),
        team: ReadTeam { name: None, owner: None, lists_login: true, workspaces: vec![] },
        accepted_invitation: true,
    };
    let p = not_remembered(&verified, "disk full");
    assert!(p.accepted);
    assert_eq!(p.details.as_deref(), Some("disk full"));
    assert!(p.words.contains("couldn't remember it"));
}

#[test]
fn calls_about_the_team_use_the_account_it_was_joined_with() {
    assert_eq!(team_account(None, Some("mb-work")), Some("mb-work".into()));
    assert_eq!(team_account(Some("other"), Some("mb-work")), Some("other".into()));
    assert_eq!(team_account(Some("  "), Some("mb-work")), Some("mb-work".into()));
    assert_eq!(team_account(None, None), None);
}

#[test]
fn the_sheet_carries_githubs_owner_apart_from_the_manifests() {
    // A manifest that claims someone else as owner: both are sent, GitHub's
    // as the repository's owner.
    let gh = Stub::default().readable("evil/ply-team", Some(&manifest("MB Adv", "mb-adv", &[ME], &[])));
    let JoinPreview::Ready { team, .. } = preview(&gh, "evil/ply-team", ME, None) else { panic!() };
    assert_eq!(team.repo_owner.as_deref(), Some("evil"));
    assert_eq!(team.manifest_owner.as_deref(), Some("mb-adv"));
    assert_eq!(team.name.as_deref(), Some("MB Adv"));
}

// ── GitHub's answers, parsed ────────────────────────────────────────────

#[test]
fn invitations_parse_from_githubs_json_and_drop_what_isnt_a_repo() {
    let json = r#"[
      {"id":101,"repository":{"full_name":"mb-adv/ply-team","private":true,"owner":{"login":"mb-adv","type":"User"}},"inviter":{"login":"mb-adv"},"expired":false,"permissions":"write"},
      {"id":102,"repository":{"full_name":"acme/team","owner":{"login":"acme","type":"Organization"}},"inviter":{"login":"bob"},"expired":true},
      {"id":103,"repository":{"full_name":"../etc/passwd"},"inviter":{"login":"x"}},
      {"repository":{"full_name":"no/id"}},
      {"id":104,"repository":{"full_name":"x/y","owner":{"login":"<b>","type":"User"}},"inviter":{"login":"bad login"}}
    ]"#;
    let list = parse_invitations(json).unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0], invitation(101, TEAM, "mb-adv"));
    assert!(list[1].owner_is_org && list[1].expired);
    assert_eq!(list[2].owner, None);
    assert_eq!(list[2].inviter, None);
    assert!(parse_invitations("not json").is_err());
}

#[test]
fn a_repo_answer_parses_its_owner_and_privacy() {
    let facts = parse_repo(r#"{"full_name":"mb-adv/ply-team","private":true,"owner":{"login":"mb-adv","type":"User"}}"#).unwrap();
    assert_eq!(facts.owner.as_deref(), Some("mb-adv"));
    assert_eq!(facts.private, Some(true));
    assert!(parse_repo(r#"{"full_name":"a/b/c"}"#).is_err());
}

#[test]
fn the_join_answers_serialize_for_the_step() {
    let p = JoinPreview::Problem { problem: code_problem(CodeRefusal::NotACode) };
    let json = serde_json::to_value(&p).unwrap();
    assert_eq!(json["kind"], "problem");
    assert_eq!(json["problem"]["kind"], "not-a-code");
    assert_eq!(json["problem"]["words"], "That isn't a Plyloft invite code.");
    let r = JoinResult::Joined {
        repo: TEAM.into(),
        name: "MB Adv".into(),
        accepted_invitation: true,
        workspaces: WorkspaceAccepts::default(),
        replaced: None,
    };
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["kind"], "joined");
    assert_eq!(json["acceptedInvitation"], true);
}

// ── Live gh (read-only; run by hand) ────────────────────────────────────

/// `cargo test live_team_join_reads -- --ignored` with gh signed in: the
/// three reads a join relies on (§12.4: every answer gets a live test).
/// Reads only — never accepts, never writes.
#[test]
#[ignore]
fn live_team_join_reads() {
    let gh = RealJoinGh { tools: Tools::production(), token: None };
    let invitations = gh.invitations().expect("user/repository_invitations answers");
    eprintln!("pending invitations: {}", invitations.len());
    let repos = gh.repos(10).expect("user/repos answers");
    eprintln!("repos: {repos:?}");
    if let Some(first) = repos.first() {
        let facts = gh.repo(first).expect("repos/<r> answers");
        assert!(facts.is_some(), "a listed repository is readable");
        let _ = gh.manifest(first).expect("contents/team.json answers (404 is Ok(None))");
    }
    assert_eq!(gh.repo("octocat/this-repo-does-not-exist-ply").unwrap(), None);
}
