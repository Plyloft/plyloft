//! 1.175.0 F2 (UX-3, owner's choice I4): what Setup's solo/team deduction
//! reads from GitHub once step 3 connected it — the Plyloft teams whose
//! `team.json` lists this account (team_join's detection, kept per login for
//! the session, so "Your team" opens on Join as today) and the repository
//! invitations waiting for it (an invited member who hasn't accepted yet
//! isn't listed by any team, UX-20). Read-only: `gh api` reads, each bounded
//! (`project_setup::run`'s deadline, team_join's 30 s in all), with the
//! cached PATH, off the UI thread; nothing is written to GitHub. Not signed
//! in, offline or refused reads as `read: false`, and Setup deduces solo —
//! the quiet link under the step list stays either way.
//!
//! F2 round 2 (review): an invitation counts only when its repository holds
//! a Plyloft team's `team.json` — a collaborator invitation to any other
//! repository says nothing about a team. An invitation whose repository
//! can't be read (private until accepted, offline, too slow) counts as
//! nothing.
use serde::Serialize;
use tauri::AppHandle;

use crate::team_join::{Detection, Invitation, JoinGh};

/// How long the invitations' `team.json` reads take in all.
const INVITATIONS_DEADLINE_AFTER: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamHint {
    /// GitHub answered at least one of the two reads.
    pub read: bool,
    pub login: String,
    /// `owner/name` of each Plyloft team listing the account.
    pub teams: Vec<String>,
    /// Invitations waiting for the account to a Plyloft team's repository
    /// (expired ones, and any other repository's, left out).
    pub invitations: usize,
    /// Why a read failed, in gh's or the sign-in's words (Details only).
    pub problem: Option<String>,
}

/// The waiting invitations to a repository that holds a Plyloft team's
/// `team.json` (read the way `team_join::detect` reads one). Read-only.
pub fn team_invitations(gh: &dyn JoinGh, login: &str, list: &[Invitation], deadline: std::time::Instant) -> usize {
    let mut repos: Vec<String> = Vec::new();
    for i in list.iter().filter(|i| !i.expired) {
        if crate::team_join::is_team_repo(&i.repo) && !repos.iter().any(|r| r.eq_ignore_ascii_case(&i.repo)) {
            repos.push(i.repo.clone());
        }
    }
    let teams: Vec<String> = gh
        .manifests(&repos, deadline)
        .into_iter()
        .filter_map(|(repo, answer)| match answer {
            Ok(Some(bytes)) if crate::team_join::read_team(&repo, &bytes, login).is_ok() => Some(repo),
            _ => None,
        })
        .collect();
    list.iter()
        .filter(|i| !i.expired && teams.iter().any(|r| r.eq_ignore_ascii_case(&i.repo)))
        .count()
}

/// Pure: the hint from the two reads. A detection that stopped on a problem
/// counts as unread; one that merely ran out of time or missed some
/// repositories is what it found (the step's own Look again can do better).
/// `invitations`: the waiting ones to a team's repository (`team_invitations`).
pub fn hint_from(login: &str, teams: &Detection, invitations: Result<usize, &str>) -> TeamHint {
    let teams_read = teams.problem.is_none();
    let mut problem = teams.problem.as_ref().map(|p| p.words.clone());
    let waiting = match invitations {
        Ok(n) => Some(n),
        Err(words) => {
            problem.get_or_insert_with(|| words.to_string());
            None
        }
    };
    TeamHint {
        read: teams_read || waiting.is_some(),
        login: login.to_string(),
        teams: if teams_read { teams.teams.iter().map(|t| t.repo.clone()).collect() } else { Vec::new() },
        invitations: waiting.unwrap_or(0),
        problem,
    }
}

/// The deduction's read, for `account` (else gh's active one).
#[tauri::command]
pub async fn setup_team_hint(app: AppHandle, account: Option<String>) -> Result<TeamHint, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (gh, login) = match crate::team_join::signed_in(account.as_deref()) {
            Ok(x) => x,
            Err(problem) => return TeamHint { problem: Some(problem.words), ..Default::default() },
        };
        let invitations = gh.invitations().map(|list| {
            team_invitations(&gh, &login, &list, std::time::Instant::now() + INVITATIONS_DEADLINE_AFTER)
        });
        let detection = crate::team_join::detection_for(&app, &gh, &login, false);
        hint_from(&login, &detection, invitations.as_ref().map(|n| *n).map_err(String::as_str))
    })
    .await
    .map_err(|e| format!("setup worker failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_join::{DetectedTeam, JoinProblem, ProblemKind, RepoFacts};
    use std::collections::HashMap;

    fn detection(teams: &[&str], problem: Option<JoinProblem>) -> Detection {
        Detection {
            login: "octocat".into(),
            teams: teams
                .iter()
                .map(|r| DetectedTeam { repo: (*r).into(), name: "Lyra".into(), owner: None, current: false })
                .collect(),
            scanned: teams.len(),
            truncated: false,
            unanswered: 0,
            timed_out: false,
            problem,
        }
    }

    fn invitation(id: u64, repo: &str, expired: bool) -> Invitation {
        Invitation { id, repo: repo.into(), owner: None, owner_is_org: false, inviter: None, expired }
    }

    /// Repositories' `team.json`, as GitHub would answer (read-only).
    struct Manifests(HashMap<String, Result<Option<Vec<u8>>, String>>);
    impl JoinGh for Manifests {
        fn repo(&self, _repo: &str) -> Result<Option<RepoFacts>, String> {
            Ok(None)
        }
        fn manifest(&self, repo: &str) -> Result<Option<Vec<u8>>, String> {
            self.0.get(repo).cloned().unwrap_or(Ok(None))
        }
        fn invitations(&self) -> Result<Vec<Invitation>, String> {
            panic!("the list is passed in")
        }
        fn accept_invitation(&self, _id: u64) -> Result<(), String> {
            panic!("a hint never accepts anything")
        }
        fn repos(&self, _limit: usize) -> Result<Vec<String>, String> {
            panic!("not asked")
        }
    }

    const TEAM_JSON: &str = r#"{"schemaVersion":1,"name":"Lyra","members":[{"login":"lyra-owner","owner":true}],"workspaces":[]}"#;

    #[test]
    fn only_an_invitation_to_a_plyloft_teams_repository_counts() {
        let gh = Manifests(HashMap::from([
            ("lyra/team".to_string(), Ok(Some(TEAM_JSON.as_bytes().to_vec()))),
            ("friend/website".to_string(), Ok(None)),
            ("other/broken".to_string(), Ok(Some(b"not json".to_vec()))),
            ("private/team".to_string(), Err("HTTP 404: Not Found".to_string())),
        ]));
        let list = vec![
            invitation(1, "lyra/team", false),
            invitation(2, "friend/website", false),
            invitation(3, "other/broken", false),
            invitation(4, "private/team", false),
            invitation(5, "lyra/team", true),
        ];
        let far = std::time::Instant::now() + std::time::Duration::from_secs(30);
        assert_eq!(team_invitations(&gh, "octocat", &list, far), 1, "an unrelated repository, an unreadable one and an expired invitation say nothing");
        assert_eq!(team_invitations(&gh, "octocat", &list[1..2], far), 0);
        // Past the deadline nothing is asked: nothing counts.
        assert_eq!(team_invitations(&gh, "octocat", &list, std::time::Instant::now()), 0);
    }

    #[test]
    fn a_team_listing_the_account_and_a_waiting_invitation_are_both_counted() {
        let hint = hint_from("octocat", &detection(&["lyra/team"], None), Ok(1));
        assert_eq!(
            hint,
            TeamHint { read: true, login: "octocat".into(), teams: vec!["lyra/team".into()], invitations: 1, problem: None }
        );
    }

    #[test]
    fn nothing_found_is_a_read_that_says_solo() {
        let hint = hint_from("octocat", &detection(&[], None), Ok(0));
        assert!(hint.read);
        assert!(hint.teams.is_empty());
        assert_eq!(hint.invitations, 0);
    }

    #[test]
    fn one_read_failing_keeps_the_other_and_names_the_problem() {
        let refused = JoinProblem::new(ProblemKind::SignedOut, "Connect GitHub first.");
        let hint = hint_from("octocat", &detection(&["lyra/team"], Some(refused)), Ok(1));
        assert!(hint.read, "the invitations answered");
        assert!(hint.teams.is_empty(), "a detection that stopped on a problem isn't trusted");
        assert_eq!(hint.invitations, 1);
        assert_eq!(hint.problem.as_deref(), Some("Connect GitHub first."));

        let hint = hint_from("octocat", &detection(&["lyra/team"], None), Err("gh: connect: network is unreachable"));
        assert!(hint.read);
        assert_eq!(hint.teams, vec!["lyra/team".to_string()]);
        assert_eq!(hint.invitations, 0);
        assert_eq!(hint.problem.as_deref(), Some("gh: connect: network is unreachable"));
    }

    #[test]
    fn both_reads_failing_is_unread_and_setup_deduces_solo() {
        let offline = JoinProblem::new(ProblemKind::Other, "GitHub couldn't be reached.");
        let hint = hint_from("octocat", &detection(&[], Some(offline)), Err("gh: connect: network is unreachable"));
        assert_eq!(
            hint,
            TeamHint {
                read: false,
                login: "octocat".into(),
                teams: Vec::new(),
                invitations: 0,
                problem: Some("GitHub couldn't be reached.".into()),
            }
        );
    }
}
