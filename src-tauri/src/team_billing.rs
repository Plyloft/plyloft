//! Launch T1–T3: a team with seats and payment.
//!
//! - **T1 Create team pays first (D17).** [`create_stage`] decides where
//!   Create team stands from the account and the server's team: choose seats
//!   and Checkout, wait for the payment ([`wait_for_team_plan`]: up to two
//!   minutes, then "your plan will appear shortly" with Check again), then
//!   create the repository and bind it (`commands::team_create` →
//!   [`bind_created_team`]). The repository is never created before the
//!   entitlement says `team` / `owner` with no repo, so an abandoned
//!   Checkout leaves nothing behind. Closing the app after paying is the
//!   same state at the next launch: "Finish creating your team". A comp
//!   owner (`comp: true`) is already there and skips Checkout.
//! - **T2 seats.** Add member takes a seat on the server **before** anything
//!   is written or granted on GitHub ([`add_member_with_seat`]); every seat
//!   taken refuses the add with nothing changed. A GitHub failure after the
//!   seat leaves the seat assigned, and says so. Remove from team frees the
//!   seat once GitHub access is gone ([`free_seat_after_removal`]); a seat
//!   that could not be freed is reported and freed again from Members.
//! - **T3** lives in the plan gates (`license.rs`: a member with no seat is
//!   told whom to ask) and on the Team page.

use serde::Serialize;
use std::time::Duration;

use crate::account::{AccountError, AccountInfo, ErrorCode, Plan, TeamRole};
use crate::billing_client::TeamView;

// ── T1: where Create team stands ────────────────────────────────────

/// What Create team shows next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum CreateStage {
    /// No Plyloft account on this profile.
    SignIn,
    /// No paid plan: choose seats and monthly/yearly, then Checkout.
    Choose,
    /// Paid (or comp) Team owner with no repository yet: create it and bind
    /// it. After a restart this reads "Finish creating your team".
    Create { comp: bool },
    /// The owner's team is bound to `team_repo`: Create team sets it up on
    /// this Mac (the existing resume path) and changes nothing on GitHub.
    Bound { team_repo: String },
    /// The account holds a seat on somebody else's team.
    Member { team_repo: Option<String> },
    /// The team's plan has ended (`canceled`, …). `owner`: this account owns
    /// it and may renew (Checkout again; the server moves the repo and the
    /// seats to the new subscription).
    Lapsed { owner: bool, owner_login: String, team_repo: Option<String>, seats: u32 },
}

/// D17: Create team's stage from the account (its verified entitlement) and
/// the server's `GET /team` answer (`None`: never had one, or not asked).
pub fn create_stage(account: &AccountInfo, team: Option<&TeamView>) -> CreateStage {
    if !account.signed_in {
        return CreateStage::SignIn;
    }
    if account.entitlement_valid {
        match account.plan {
            Plan::Team => {
                return match (account.team_role, account.team_repo.as_deref()) {
                    (Some(TeamRole::Member), repo) => CreateStage::Member { team_repo: repo.map(str::to_string) },
                    (_, Some(repo)) if !repo.trim().is_empty() => CreateStage::Bound { team_repo: repo.trim().to_string() },
                    _ => CreateStage::Create { comp: account.comp },
                };
            }
            // An old Pro entitlement grants what Free does: it buys Team.
            Plan::Pro | Plan::Free => {}
        }
    }
    // 1.178.0: a Team plan or seat active on another computer (or on none
    // yet) signs Free here; the server's unsigned `team` field says it is
    // there, so Create team never offers to buy a second one. It reads as
    // on the computer holding it; the team gate then says Use Team on this
    // computer.
    if let Some(seat) = account.team.as_ref().filter(|t| t.state != crate::account::TeamState::Here) {
        let repo = seat.team_repo.as_deref().map(str::trim).filter(|r| !r.is_empty());
        return match (seat.role, repo) {
            (Some(TeamRole::Member), repo) => CreateStage::Member { team_repo: repo.map(str::to_string) },
            (_, Some(repo)) => CreateStage::Bound { team_repo: repo.to_string() },
            _ => CreateStage::Create { comp: false },
        };
    }
    if let Some(team) = team.filter(|t| t.lapsed()) {
        let owner = account.sub.as_deref().is_some_and(|sub| team.is_owner(sub));
        return CreateStage::Lapsed {
            owner,
            owner_login: team.owner.login.clone(),
            team_repo: team.team_repo.clone(),
            seats: team.seats,
        };
    }
    CreateStage::Choose
}

/// D9 (one team per account): Create team refuses a seat holder on somebody
/// else's team before anything reaches GitHub. `None`: no objection here
/// (the plan gate decides the rest).
pub fn create_refusal(account: &AccountInfo) -> Option<String> {
    match create_stage(account, None) {
        CreateStage::Member { team_repo } => Some(format!(
            // 1.175.0 D5: the member can give the seat up themselves.
            "You hold a seat on {}. One team per account: join that team instead, or give up the seat in \
             Settings › Setup and account › Plan.",
            team_repo.as_deref().map(|r| format!("{r}'s team")).unwrap_or_else(|| "a team".into())
        )),
        _ => None,
    }
}

/// What Settings › Team and Setup read: the stage, the server's team, and
/// what could not be read (the page then says so and offers Check again).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamBilling {
    pub stage: CreateStage,
    pub team: Option<TeamView>,
    pub error: Option<AccountError>,
}

// ── T1: waiting for the payment ─────────────────────────────────────

/// LAUNCH_PLAN §5 "Webhook delayed": the app polls for up to 2 minutes.
pub const CHECKOUT_WAIT: Duration = Duration::from_secs(120);
/// Between two asks (well inside the server's 120 a minute).
pub const CHECKOUT_POLL: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WaitOutcome {
    /// The entitlement says Team owner: create the repository next.
    Paid { info: AccountInfo },
    /// Two minutes and still no Team plan: "If you paid, your plan will
    /// appear shortly" with Check again (a delayed webhook, or an abandoned
    /// Checkout — the app can't tell them apart).
    Pending,
    /// The person went back to the choice, or the app is quitting.
    Cancelled,
}

/// The Team plan a paid Checkout gives its buyer (or a comp owner has).
pub fn is_team_owner(info: &AccountInfo) -> bool {
    info.entitlement_valid && info.plan == Plan::Team && info.team_role != Some(TeamRole::Member)
}

/// Poll `refresh` (the account's `GET /entitlement`) every `step` until the
/// entitlement says Team owner, for at most `limit`. `wait(d)` sleeps and
/// returns `false` when cancelled. A refresh that fails (offline, a token
/// that didn't verify) is just another "not yet".
pub fn wait_for_team_plan(
    mut refresh: impl FnMut() -> Result<AccountInfo, AccountError>,
    mut wait: impl FnMut(Duration) -> bool,
    limit: Duration,
    step: Duration,
) -> WaitOutcome {
    let mut waited = Duration::ZERO;
    loop {
        if let Ok(info) = refresh() {
            if is_team_owner(&info) {
                return WaitOutcome::Paid { info };
            }
        }
        if waited >= limit {
            return WaitOutcome::Pending;
        }
        if !wait(step) {
            return WaitOutcome::Cancelled;
        }
        waited += step;
    }
}

// ── T1: bind the repository after creating it ───────────────────────

/// What binding the new repository did, for `CreatedTeam`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bind {
    /// `POST /team` answered with this repository (now or before).
    Bound,
    /// No Team-owner entitlement to bind with (a test build, a plan that
    /// lapsed meanwhile): nothing was sent.
    Skipped,
    /// The server refused or couldn't be reached; the words say how to finish.
    Failed(String),
}

/// D17: after the repository exists (and is this Mac's team), bind it to the
/// owner's Team subscription. Already bound to it: nothing to send. Bound to
/// another: refused before any request (the server would say
/// `already_bound`).
pub fn bind_created_team(
    account: &AccountInfo,
    repo: &str,
    bind: impl FnOnce(&str) -> Result<TeamView, AccountError>,
) -> Bind {
    if !is_team_owner(account) {
        return Bind::Skipped;
    }
    if let Some(bound) = account.team_repo.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        return if bound.eq_ignore_ascii_case(repo.trim()) {
            Bind::Bound
        } else {
            Bind::Failed(format!(
                "Your Team plan is already bound to {bound}, so it can't cover {repo}. Plyloft created {repo} \
                 on GitHub; leave it and use {bound}, or delete {repo} on GitHub."
            ))
        };
    }
    match bind(repo) {
        Ok(team) if team.team_repo.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(repo.trim())) => Bind::Bound,
        Ok(team) => Bind::Failed(format!(
            "The Plyloft server bound your plan to {} instead of {repo}.",
            team.team_repo.unwrap_or_else(|| "nothing".into())
        )),
        Err(e) if e.code == ErrorCode::AlreadyBound => Bind::Failed(format!(
            "{} {repo} is on GitHub, but your plan can't cover it.",
            e.message.trim()
        )),
        Err(e) => Bind::Failed(format!(
            "{repo} is on GitHub, but Plyloft couldn't attach it to your Team plan yet ({}). Press Finish \
             creating your team to try again.",
            e.message.trim()
        )),
    }
}

// ── T2: seats ───────────────────────────────────────────────────────

/// Why a seat wasn't taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeatRefusal {
    /// Every seat is taken (`seat_limit`); `seats` when known. `comp`: the
    /// seats are set by Plyloft (no billing to add them in).
    Limit { seats: Option<u32>, comp: bool },
    /// Any other refusal (another team, not the owner, offline…), in the
    /// server's or the network's words.
    Other(String),
}

/// The stable start of "every seat is taken" (`src/lib/teamBilling.ts`
/// reads it to offer Add seats). A comp team's seats are set by Plyloft: no
/// billing is offered.
pub fn seat_limit_words(seats: Option<u32>, login: &str, comp: bool) -> String {
    let all = match seats {
        Some(n) => format!("All {n} seats are taken"),
        None => "All seats are taken".to_string(),
    };
    if comp {
        format!("{all} — the team's seats are set by Plyloft. Nothing was changed on GitHub.")
    } else {
        format!("{all}. Add seats in billing, then add {login} again. Nothing was changed on GitHub.")
    }
}

/// The manifest's members with their GitHub ids, and the logins GitHub
/// couldn't give an id for (round 2, P2-A: an incomplete list never decides
/// that a seat is outside the team).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberIds {
    pub members: Vec<crate::billing_client::TeamAccount>,
    pub unresolved: Vec<String>,
}

/// P3-5: Free the seat is for seats held by somebody the team no longer
/// lists; the owner's seat and a listed member's seat are refused (Remove
/// from team frees a member's). While any listed member couldn't be looked
/// up, nothing is freed: the seat may be theirs.
pub fn seat_free_refusal(sub: &str, owner_sub: Option<&str>, ids: &MemberIds) -> Option<String> {
    if owner_sub == Some(sub) {
        return Some("That is the owner's seat; it can't be freed.".to_string());
    }
    if !ids.unresolved.is_empty() {
        return Some(format!(
            "Couldn't look up {} on GitHub; nothing was changed.",
            ids.unresolved.join(", ")
        ));
    }
    let listed = &ids.members;
    listed.iter().find(|m| m.sub == sub).map(|m| {
        format!("{} is in the team: Remove them from the team to free their seat.", m.login)
    })
}

/// P2-1: Finish creating your team binds this Mac's team repository to the
/// account's plan only for the team's owner as `team.json` names them,
/// acting as the GitHub account the team uses, signed in to Plyloft as that
/// account. A member who has a Team plan of their own can't bind somebody
/// else's team to it.
pub fn bind_current_check(
    manifest_owner: Option<&str>,
    gh_login: Option<&str>,
    account_login: Option<&str>,
) -> Result<(), String> {
    crate::team_admin::authorize_owner_action(true, manifest_owner, gh_login)?;
    if let (Some(account), Some(owner)) = (account_login, manifest_owner) {
        if !account.trim().eq_ignore_ascii_case(owner.trim()) {
            return Err(crate::license::TeamAccess::OtherAccount {
                login: account.trim().to_string(),
                team_login: owner.trim().to_string(),
            }
            .refusal()
            .unwrap_or_default());
        }
    }
    Ok(())
}

/// T2: **seat first, then GitHub.** `resolve` reads `login`'s numeric id,
/// `take` puts the seat on the server, `invite` writes the manifest and the
/// grants. A refused seat stops everything with nothing changed. A failure
/// after the seat keeps the seat and says so (the owner can add them again,
/// which retries the invitation — the seat call is idempotent — or Remove
/// them, which frees it).
pub fn add_member_with_seat<T>(
    login: &str,
    resolve: impl FnOnce(&str) -> Result<String, String>,
    take: impl FnOnce(&str, &str) -> Result<(), SeatRefusal>,
    invite: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let login = login.trim();
    if !crate::team_admin::is_valid_login(login) {
        return Err(format!("{login:?} is not a GitHub login. Logins are letters, digits and single hyphens."));
    }
    let sub = resolve(login).map_err(|e| {
        format!("Plyloft couldn't look up {login} on GitHub ({e}). Nothing was changed.")
    })?;
    take(&sub, login).map_err(|refusal| match refusal {
        SeatRefusal::Limit { seats, comp } => seat_limit_words(seats, login, comp),
        SeatRefusal::Other(why) => format!(
            "Plyloft couldn't give {login} a seat on the team's plan: {} Nothing was changed on GitHub.",
            why.trim()
        ),
    })?;
    invite().map_err(|e| {
        format!(
            "{e} {login} holds a seat on the team's plan: add them again to retry, or press Free the seat \
             (Remove from team… if they're listed)."
        )
    })
}

/// What freeing a removed member's seat did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SeatFreed {
    pub freed: bool,
    pub error: Option<String>,
}

/// T2: free the seat **after** GitHub access is gone (`access_removed`:
/// every repository succeeded). Before that nothing is sent: a member still
/// holding access keeps the seat they use. A failure is reported; Members
/// lists a seat held by someone outside the team with Free the seat.
/// `free` answers whether a seat was there to free (`false`: they held none,
/// so nothing is claimed).
pub fn free_seat_after_removal(
    login: &str,
    access_removed: bool,
    resolve: impl FnOnce(&str) -> Result<String, String>,
    free: impl FnOnce(&str) -> Result<bool, String>,
) -> SeatFreed {
    if !access_removed {
        return SeatFreed::default();
    }
    let sub = match resolve(login) {
        Ok(sub) => sub,
        Err(e) => {
            return SeatFreed {
                freed: false,
                error: Some(format!(
                    "Plyloft couldn't look up {login} on GitHub to free their seat ({e}). Free it from Members."
                )),
            }
        }
    };
    match free(&sub) {
        Ok(freed) => SeatFreed { freed, error: None },
        Err(e) => SeatFreed {
            freed: false,
            error: Some(format!(
                "{login} is out of the team on GitHub, but their seat is still taken ({e}). Free it from Members."
            )),
        },
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing_client::test_support::*;
    use crate::billing_client::{self, TeamAccount};
    use std::cell::RefCell;

    fn team(status: &str, repo: Option<&str>) -> TeamView {
        TeamView {
            team_repo: repo.map(str::to_string),
            owner: TeamAccount { sub: "1234567".into(), login: "octocat".into() },
            seats: 3,
            assigned: vec![TeamAccount { sub: "1234567".into(), login: "octocat".into() }],
            status: status.into(),
            period_end: None,
            interval: None,
        }
    }

    // ── create_stage ──

    #[test]
    fn stage_follows_the_account_and_the_team() {
        let r = rig();
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::SignIn);
        r.sign_in("free", "null", "null", false);
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Choose);
        // An old Pro entitlement, paid or comp, chooses seats like Free.
        r.sign_in("pro", "null", "null", false);
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Choose);
        r.sign_in("pro", "null", "null", true);
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Choose);
        r.sign_in("team", "null", "\"owner\"", false);
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Create { comp: false });
        r.sign_in("team", "\"octocat/acme-team\"", "\"owner\"", false);
        assert_eq!(
            create_stage(&r.store.info_at(NOW), None),
            CreateStage::Bound { team_repo: "octocat/acme-team".into() }
        );
        r.sign_in("team", "\"boss/team\"", "\"member\"", false);
        assert_eq!(
            create_stage(&r.store.info_at(NOW), None),
            CreateStage::Member { team_repo: Some("boss/team".into()) }
        );
    }

    /// 1.178.0: signed out, Create team asks for the sign-in (no request:
    /// `team_billing_get` sends nothing then); a Team plan or seat on another
    /// computer never offers a second purchase.
    #[test]
    fn signed_out_signs_in_and_team_elsewhere_never_buys_twice() {
        use crate::account::{AccountTeam, TeamState};
        let signed_out = AccountInfo::signed_out();
        assert_eq!(create_stage(&signed_out, None), CreateStage::SignIn);
        assert_eq!(
            serde_json::to_value(create_stage(&signed_out, None)).unwrap(),
            serde_json::json!({"stage": "sign_in"})
        );
        let r = rig();
        r.sign_in("free", "null", "null", false);
        let free = r.store.info_at(NOW);
        let with = |state, repo: Option<&str>, role| AccountInfo {
            team: Some(AccountTeam { state, device: None, team_repo: repo.map(str::to_string), role: Some(role) }),
            ..free.clone()
        };
        assert_eq!(
            create_stage(&with(TeamState::Elsewhere, Some("boss/team"), TeamRole::Member), None),
            CreateStage::Member { team_repo: Some("boss/team".into()) }
        );
        assert_eq!(
            create_stage(&with(TeamState::Nowhere, Some("octocat/acme-team"), TeamRole::Owner), None),
            CreateStage::Bound { team_repo: "octocat/acme-team".into() }
        );
        assert_eq!(
            create_stage(&with(TeamState::Nowhere, None, TeamRole::Owner), None),
            CreateStage::Create { comp: false }
        );
        assert!(create_refusal(&with(TeamState::Elsewhere, Some("boss/team"), TeamRole::Member)).is_some());
        // "Here" without a verified Team plan (it lapsed) reads as before.
        assert_eq!(create_stage(&with(TeamState::Here, Some("o/t"), TeamRole::Owner), None), CreateStage::Choose);
        assert!(team_billing_get_sends_nothing_signed_out());
    }

    /// `commands::team_billing_get` signed out: the stage only, before any
    /// request (the source is read, as the command needs an app).
    fn team_billing_get_sends_nothing_signed_out() -> bool {
        let src = include_str!("commands.rs");
        let at = src.find("pub async fn team_billing_get").expect("the command");
        let body = &src[at..at + 900];
        let guard = body.find("if !info.signed_in").expect("signed-out guard");
        let ask = body.find("billing_client::team_get").expect("the request");
        guard < ask
    }

    #[test]
    fn a_seat_holder_cannot_create_a_second_team() {
        let r = rig();
        r.sign_in("team", "\"boss/team\"", "\"member\"", false);
        let why = create_refusal(&r.store.info_at(NOW)).unwrap();
        assert!(why.contains("boss/team's team") && why.contains("One team per account"), "{why}");
        r.sign_in("team", "null", "\"owner\"", false);
        assert_eq!(create_refusal(&r.store.info_at(NOW)), None);
        r.sign_in("free", "null", "null", false);
        assert_eq!(create_refusal(&r.store.info_at(NOW)), None);
    }

    #[test]
    fn finish_binds_only_for_the_manifests_owner() {
        // The owner, acting and signed in as the owner.
        assert!(bind_current_check(Some("Boss"), Some("boss"), Some("BOSS")).is_ok());
        // A member with a Team plan of their own (owner role, no repo yet):
        // their gh login and Plyloft account are theirs, the manifest is Boss's.
        let e = bind_current_check(Some("Boss"), Some("member"), Some("member")).unwrap_err();
        assert!(e.contains("Only the team owner (Boss)"), "{e}");
        // The owner's gh account, but signed in to Plyloft as somebody else.
        let e = bind_current_check(Some("Boss"), Some("boss"), Some("member")).unwrap_err();
        assert!(e.starts_with(crate::license::TEAM_OTHER_ACCOUNT_LEAD), "{e}");
        // No manifest owner or no login: refused, never bound on a guess.
        assert!(bind_current_check(None, Some("boss"), Some("boss")).is_err());
        assert!(bind_current_check(Some("Boss"), None, Some("boss")).is_err());
    }

    #[test]
    fn free_the_seat_refuses_the_owner_and_listed_members() {
        let mut ids = MemberIds {
            members: vec![TeamAccount { sub: "2".into(), login: "joined".into() }],
            unresolved: vec![],
        };
        assert!(seat_free_refusal("1", Some("1"), &ids).unwrap().contains("owner's seat"));
        assert!(seat_free_refusal("2", Some("1"), &ids).unwrap().contains("joined is in the team"));
        assert_eq!(seat_free_refusal("9", Some("1"), &ids), None);
        // Round 2 (P2-A): one member GitHub couldn't look up — "9" may be theirs.
        ids.unresolved.push("early".into());
        assert_eq!(
            seat_free_refusal("9", Some("1"), &ids).as_deref(),
            Some("Couldn't look up early on GitHub; nothing was changed.")
        );
    }

    #[test]
    fn a_comp_owner_skips_checkout() {
        let r = rig();
        r.sign_in("team", "null", "\"owner\"", true);
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Create { comp: true });
    }

    #[test]
    fn a_lapsed_team_offers_renew_to_its_owner_and_names_the_owner_to_others() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        let info = r.store.info_at(NOW);
        assert_eq!(
            create_stage(&info, Some(&team("canceled", Some("octocat/acme-team")))),
            CreateStage::Lapsed {
                owner: true,
                owner_login: "octocat".into(),
                team_repo: Some("octocat/acme-team".into()),
                seats: 3
            }
        );
        let mut other = team("unpaid", Some("boss/team"));
        other.owner = TeamAccount { sub: "9".into(), login: "boss".into() };
        assert!(matches!(
            create_stage(&info, Some(&other)),
            CreateStage::Lapsed { owner: false, ref owner_login, .. } if owner_login == "boss"
        ));
        // A live team on a Free account (not yet refreshed) is no lapse.
        assert_eq!(create_stage(&info, Some(&team("active", None))), CreateStage::Choose);
    }

    // ── The create-team state machine: paid, abandoned, delayed, restarted ──

    fn wait_on(r: &Rig) -> (WaitOutcome, usize) {
        let mut waits = 0;
        let outcome = wait_for_team_plan(
            || r.store.refresh_at(NOW),
            |_| {
                waits += 1;
                true
            },
            Duration::from_secs(8),
            Duration::from_secs(4),
        );
        (outcome, waits)
    }

    #[test]
    fn paid_checkout_reaches_create_then_bind() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Choose);
        r.http.push(200, r#"{"url":"https://checkout.stripe.com/c/pay/cs_1"}"#);
        billing_client::checkout(&r.store, billing_client::Interval::Month, Some(2)).unwrap();
        // The webhook lands between the first and the second ask.
        r.push_entitlement("free", "null", "null", false);
        r.push_entitlement("team", "null", "\"owner\"", false);
        let (outcome, waits) = wait_on(&r);
        let WaitOutcome::Paid { info } = outcome else { panic!("{outcome:?}") };
        assert_eq!(waits, 1);
        assert_eq!(create_stage(&info, None), CreateStage::Create { comp: false });
        // The repository is created (commands::team_create), then bound.
        r.http.push(200, &team_json(Some("octocat/acme-team"), 2, &[("1234567", "octocat")], "active"));
        let bind = bind_created_team(&info, "octocat/acme-team", |repo| billing_client::team_bind(&r.store, repo));
        assert_eq!(bind, Bind::Bound);
        r.push_entitlement("team", "\"octocat/acme-team\"", "\"owner\"", false);
        let after = r.store.refresh_at(NOW).unwrap();
        assert_eq!(create_stage(&after, None), CreateStage::Bound { team_repo: "octocat/acme-team".into() });
    }

    #[test]
    fn abandoned_or_delayed_checkout_waits_two_minutes_then_pending() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        for _ in 0..3 {
            r.push_entitlement("free", "null", "null", false);
        }
        let (outcome, waits) = wait_on(&r);
        assert_eq!(outcome, WaitOutcome::Pending);
        assert_eq!(waits, 2, "8 s at 4 s a step: asked at 0, 4 and 8");
        // Abandoned: nothing was created and the stage is the choice again.
        assert_eq!(create_stage(&r.store.info_at(NOW), None), CreateStage::Choose);
        // Delayed: Check again later finds the plan.
        r.push_entitlement("team", "null", "\"owner\"", false);
        assert!(matches!(wait_on(&r).0, WaitOutcome::Paid { .. }));
    }

    #[test]
    fn the_wait_survives_an_offline_ask_and_stops_on_cancel() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        r.http.push_err();
        r.push_entitlement("team", "null", "\"owner\"", false);
        assert!(matches!(wait_on(&r).0, WaitOutcome::Paid { .. }));
        r.push_entitlement("free", "null", "null", false);
        let outcome = wait_for_team_plan(|| r.store.refresh_at(NOW), |_| false, CHECKOUT_WAIT, CHECKOUT_POLL);
        assert_eq!(outcome, WaitOutcome::Cancelled);
    }

    #[test]
    fn the_production_wait_is_two_minutes() {
        assert_eq!(CHECKOUT_WAIT, Duration::from_secs(120));
        let mut asks = 0;
        let outcome = wait_for_team_plan(
            || {
                asks += 1;
                Err(AccountError::new(ErrorCode::Network, "offline"))
            },
            |_| true,
            CHECKOUT_WAIT,
            CHECKOUT_POLL,
        );
        assert_eq!(outcome, WaitOutcome::Pending);
        assert_eq!(asks, 31, "every 4 s from 0 to 120 s");
    }

    #[test]
    fn app_restarted_after_paying_resumes_at_repo_creation() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        // Paid, then the app closed before the entitlement arrived. The next
        // launch's refresh brings the Team plan with no repository.
        r.push_entitlement("team", "null", "\"owner\"", false);
        let info = r.store.refresh_at(NOW).unwrap();
        assert_eq!(create_stage(&info, None), CreateStage::Create { comp: false });
        // A Team owner never waits for a payment again.
        assert!(matches!(wait_for_team_plan(|| Ok(info.clone()), |_| panic!("no wait"), CHECKOUT_WAIT, CHECKOUT_POLL), WaitOutcome::Paid { .. }));
    }

    #[test]
    fn restarted_after_the_repo_but_before_the_bind_binds_on_finish() {
        let r = rig();
        r.sign_in("team", "null", "\"owner\"", false);
        let info = r.store.info_at(NOW);
        r.http.push_err();
        let failed = bind_created_team(&info, "octocat/acme-team", |repo| billing_client::team_bind(&r.store, repo));
        let Bind::Failed(words) = failed else { panic!("{failed:?}") };
        assert!(words.contains("Finish creating your team"), "{words}");
        // Finish creating your team: the same bind, now reachable.
        r.http.push(200, &team_json(Some("octocat/acme-team"), 2, &[("1234567", "octocat")], "active"));
        assert_eq!(
            bind_created_team(&info, "octocat/acme-team", |repo| billing_client::team_bind(&r.store, repo)),
            Bind::Bound
        );
    }

    #[test]
    fn bind_is_skipped_or_refused_without_a_request_when_it_cannot_apply() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        let never = |_: &str| -> Result<TeamView, AccountError> { panic!("no request") };
        assert_eq!(bind_created_team(&r.store.info_at(NOW), "o/n", never), Bind::Skipped);
        r.sign_in("team", "\"octocat/acme-team\"", "\"owner\"", false);
        assert_eq!(bind_created_team(&r.store.info_at(NOW), "OctoCat/Acme-Team", never), Bind::Bound);
        assert!(matches!(bind_created_team(&r.store.info_at(NOW), "octocat/other", never), Bind::Failed(_)));
        r.sign_in("team", "\"boss/team\"", "\"member\"", false);
        assert_eq!(bind_created_team(&r.store.info_at(NOW), "o/n", never), Bind::Skipped);
    }

    #[test]
    fn already_bound_says_the_repo_is_not_covered() {
        let r = rig();
        r.sign_in("team", "null", "\"owner\"", false);
        r.http.push(409, r#"{"error":"already_bound","message":"That repository already belongs to another team."}"#);
        let bind = bind_created_team(&r.store.info_at(NOW), "o/n", |repo| billing_client::team_bind(&r.store, repo));
        assert!(matches!(bind, Bind::Failed(ref w) if w.contains("belongs to another team")), "{bind:?}");
    }

    // ── Seats: the order of operations ──

    #[test]
    fn add_member_takes_the_seat_before_any_github_write() {
        let order = RefCell::new(Vec::<String>::new());
        let out = add_member_with_seat(
            " b ",
            |login| {
                order.borrow_mut().push(format!("resolve {login}"));
                Ok("42".into())
            },
            |sub, login| {
                order.borrow_mut().push(format!("seat {sub} {login}"));
                Ok(())
            },
            || {
                order.borrow_mut().push("invite".into());
                Ok("outcome")
            },
        );
        assert_eq!(out.unwrap(), "outcome");
        assert_eq!(*order.borrow(), vec!["resolve b", "seat 42 b", "invite"]);
    }

    #[test]
    fn seat_limit_stops_before_github_and_names_add_seats() {
        let invited = RefCell::new(false);
        let e = add_member_with_seat(
            "b",
            |_| Ok("42".into()),
            |_, _| Err(SeatRefusal::Limit { seats: Some(2), comp: false }),
            || {
                *invited.borrow_mut() = true;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(!*invited.borrow());
        assert!(e.starts_with("All 2 seats are taken."), "{e}");
        assert!(e.contains("Add seats") && e.contains("Nothing was changed on GitHub"), "{e}");
        assert_eq!(seat_limit_words(None, "b", false).split('.').next(), Some("All seats are taken"));
        // P3-6: a comp team's seats are Plyloft's to set — no billing.
        let comp = seat_limit_words(Some(10), "b", true);
        assert!(comp.starts_with("All 10 seats are taken — the team's seats are set by Plyloft."), "{comp}");
        assert!(!comp.contains("billing"), "{comp}");
    }

    #[test]
    fn other_seat_refusals_and_lookup_failures_change_nothing() {
        let e = add_member_with_seat(
            "b",
            |_| Ok("42".into()),
            |_, _| Err(SeatRefusal::Other("b is already on another team.".into())),
            || -> Result<(), String> { panic!("no invite") },
        )
        .unwrap_err();
        assert!(e.contains("already on another team") && e.contains("Nothing was changed"), "{e}");
        let e = add_member_with_seat(
            "ghost",
            |_| Err("HTTP 404".into()),
            |_, _| panic!("no seat"),
            || -> Result<(), String> { panic!("no invite") },
        )
        .unwrap_err();
        assert!(e.contains("couldn't look up ghost"), "{e}");
        let e = add_member_with_seat("b/../c", |_| panic!(), |_, _| panic!(), || -> Result<(), String> { panic!() })
            .unwrap_err();
        assert!(e.contains("not a GitHub login"), "{e}");
    }

    #[test]
    fn a_github_failure_after_the_seat_keeps_the_seat_and_says_so() {
        let e = add_member_with_seat(
            "b",
            |_| Ok("42".into()),
            |_, _| Ok(()),
            || -> Result<(), String> { Err("git push was refused.".into()) },
        )
        .unwrap_err();
        assert!(e.starts_with("git push was refused."), "{e}");
        assert!(e.contains("holds a seat") && e.contains("add them again") && e.contains("Free the seat") && e.contains("Remove from team…"), "{e}");
    }

    #[test]
    fn seat_ordering_against_the_fake_server() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        // First add: seat taken, invitation fails → the seat stays.
        r.http.push(200, &team_json(Some("o/n"), 2, &[("1234567", "octocat"), ("42", "b")], "active"));
        let take = |sub: &str, login: &str| {
            billing_client::seat_put(&r.store, sub, login).map(|_| ()).map_err(|e| match e.code {
                ErrorCode::SeatLimit => SeatRefusal::Limit { seats: Some(2), comp: false },
                _ => SeatRefusal::Other(e.message),
            })
        };
        assert!(add_member_with_seat("b", |_| Ok("42".into()), take, || -> Result<(), String> { Err("x".into()) }).is_err());
        // Retry: the seat call is idempotent, the invitation goes through.
        r.http.push(200, &team_json(Some("o/n"), 2, &[("1234567", "octocat"), ("42", "b")], "active"));
        assert!(add_member_with_seat("b", |_| Ok("42".into()), take, || Ok(())).is_ok());
        // A third person: no seat left, nothing invited.
        r.http.push(409, r#"{"error":"seat_limit","message":"All 2 seats are taken. Add seats in billing first."}"#);
        let e = add_member_with_seat("c", |_| Ok("43".into()), take, || -> Result<(), String> { panic!("no invite") })
            .unwrap_err();
        assert!(e.starts_with("All 2 seats are taken."), "{e}");
        // Remove b: GitHub first, then the seat.
        r.http.push(200, &team_json(Some("o/n"), 2, &[("1234567", "octocat")], "active"));
        let freed = free_seat_after_removal("b", true, |_| Ok("42".into()), |sub| {
            billing_client::seat_delete(&r.store, sub).map(|t| t.is_some()).map_err(|e| e.message)
        });
        assert_eq!(freed, SeatFreed { freed: true, error: None });
        let methods: Vec<_> = r.http.seen().iter().map(|s| (s.method, s.url.clone())).collect();
        assert_eq!(
            methods,
            vec![
                (crate::account::Method::Put, "http://api.test/v1/team/seats/42".to_string()),
                (crate::account::Method::Put, "http://api.test/v1/team/seats/42".to_string()),
                (crate::account::Method::Put, "http://api.test/v1/team/seats/43".to_string()),
                (crate::account::Method::Delete, "http://api.test/v1/team/seats/42".to_string()),
            ]
        );
    }

    #[test]
    fn the_seat_is_freed_only_after_github_access_is_gone() {
        let asked = RefCell::new(false);
        let out = free_seat_after_removal(
            "b",
            false,
            |_| {
                *asked.borrow_mut() = true;
                Ok("42".into())
            },
            |_| panic!("no free before GitHub"),
        );
        assert_eq!(out, SeatFreed::default());
        assert!(!*asked.borrow());
        // P3-7: somebody who held no seat: nothing is claimed.
        let out = free_seat_after_removal("b", true, |_| Ok("42".into()), |_| Ok(false));
        assert_eq!(out, SeatFreed { freed: false, error: None });
        let out = free_seat_after_removal("b", true, |_| Ok("42".into()), |_| Err("offline".into()));
        assert!(!out.freed);
        assert!(out.error.as_deref().is_some_and(|e| e.contains("seat is still taken") && e.contains("Free it from Members")));
        let out = free_seat_after_removal("b", true, |_| Err("gh down".into()), |_| panic!("no id, no call"));
        assert!(out.error.as_deref().is_some_and(|e| e.contains("couldn't look up b")));
    }
}
