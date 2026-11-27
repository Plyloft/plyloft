//! v1.85.0 introduced the offline team-licence layer (`PLY1` keys). Launch
//! G1–G3 (2026-10-02) retire the key as a policy source: **the plan comes
//! from the Plyloft account** ([`crate::account::AccountInfo`], a verified
//! `PLY2` entitlement), and this module is where every gate asks.
//!
//! [`LicenseStore`] keeps its name so the ~100 gate call sites stay where they
//! are (one decision, many action points), but it no longer decides anything
//! from `license.json`:
//!
//! - **Team** (D9, D10): team features run when the plan is `team` with a
//!   valid entitlement, its `teamRepo` is the team this Mac is in
//!   (`settings.team.teamRepo`, compared ignoring case), and the Plyloft
//!   account is the GitHub account the team uses (`settings.team.account`,
//!   recorded at create, join and the first read of the team). See
//!   [`team_access`].
//! - Everything for one person runs on every plan, signed in or not: any
//!   number of cards build at once, and no feature asks for a plan but the
//!   team's. A `pro` entitlement (old ones and comps still say it) grants
//!   nothing more than Free.
//!
//! A stored `PLY1` key unlocks nothing. The file is left as it is and still
//! read, so Diagnostics and the Licence part can say a key is there.
//!
//! The `PLY1` format, kept for that read:
//!
//! ```text
//! PLY1-<base64url(payload_json)>.<base64url(ed25519_sig)>
//! {"team":"MB Adv","seats":5,"issuedAt":1760000000000,"expiresAt":1791536000000,"teamRepo":"MatteoB-adv/mbadv-team"}
//! ```
//!
//! Persistence: `<config_dir>/license.json` (`{schemaVersion, key}`), atomic
//! writes per Hard Rule #3.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Public half of the license keypair (32 bytes, hex). Private half:
/// `~/.tauri/ply-license.pem` on the owner's Mac. NEVER rotate casually —
/// every issued key dies with the pubkey.
const LICENSE_PUBKEY_HEX: &str =
    "63635122d296143f7695e5a9dff81eb5593e4165fbd5a6ff5e4d5a2c78e436ca";

/// Grace window past `expiresAt` during which team features stay on
/// (with a warning banner). Renewal should never be a cliff.
pub const GRACE_MS: i64 = 14 * 24 * 60 * 60 * 1000;

const LICENSE_SCHEMA_VERSION: u32 = 1;

pub const KEY_PREFIX: &str = "PLY1-";

// ── Payload + status ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub team: String,
    pub seats: u32,
    pub issued_at: i64,
    pub expires_at: i64,
    /// v1.114.0: `owner/name` of the team repo, or `None` for a key minted
    /// without `--team-repo` (every pre-1.114 key). Never required — a key
    /// without it unlocks the tier exactly as before, with no team.
    #[serde(default)]
    pub team_repo: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    /// No key entered.
    None,
    Valid,
    /// Past expiry but inside [`GRACE_MS`] — features on, banner up.
    Grace,
    Expired,
}

/// What a stored `PLY1` key says, for Diagnostics and the Licence part. It
/// unlocks nothing (launch G3): the plan is the account's.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    pub status: LicenseStatus,
    pub team: Option<String>,
    pub seats: Option<u32>,
    pub issued_at: Option<i64>,
    pub expires_at: Option<i64>,
    /// The key's `teamRepo`, when it carries one. Not the team this Mac is in
    /// ([`crate::team::current_team_repo`] reads the setting only).
    pub team_repo: Option<String>,
}

impl LicenseInfo {
    fn none() -> Self {
        Self {
            status: LicenseStatus::None,
            team: None,
            seats: None,
            issued_at: None,
            expires_at: None,
            team_repo: None,
        }
    }

    fn from_payload(p: &LicensePayload, now_ms: i64) -> Self {
        let status = if now_ms <= p.expires_at {
            LicenseStatus::Valid
        } else if now_ms <= p.expires_at + GRACE_MS {
            LicenseStatus::Grace
        } else {
            LicenseStatus::Expired
        };
        Self {
            status,
            team: Some(p.team.clone()),
            seats: Some(p.seats),
            issued_at: Some(p.issued_at),
            expires_at: Some(p.expires_at),
            team_repo: p.team_repo.clone(),
        }
    }
}

// ── The plan policy (launch G2, G3) ─────────────────────────────────

/// What the policy reads, at one instant.
#[derive(Debug, Clone)]
pub struct PolicyInputs {
    /// The Plyloft account and its verified plan (Free without one).
    pub account: crate::account::AccountInfo,
    /// The team this Mac is in: `settings.team.teamRepo`.
    pub team_repo: Option<String>,
    /// The GitHub login the team uses: `settings.team.account`, recorded at
    /// create, join and the first read of the team (Challenger P3-5). `None`
    /// before any of them; the account check then waits for that record.
    pub team_login: Option<String>,
    /// Launch T3: the team's owner as this Mac's clone of `team.json` names
    /// them — read only when the account has no Team plan, so a member
    /// without a seat is told whom to ask.
    pub team_owner: Option<String>,
}

impl PolicyInputs {
    /// Signed out, no team: everything paid is closed.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn signed_out() -> Self {
        Self { account: crate::account::AccountInfo::signed_out(), team_repo: None, team_login: None, team_owner: None }
    }
}

/// D9/D10: may team features run, and if not, why. One answer, read by every
/// team gate and sent to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum TeamAccess {
    Allowed,
    /// No valid Team entitlement: a plan other than Team, or a Team plan that
    /// lapsed (the entitlement expired).
    NoTeamPlan,
    /// 1.178.0 (A3 c.4): not signed in to Plyloft on this computer.
    SignedOut,
    /// 1.178.0: the account's Team plan or seat runs on another computer, or
    /// on none yet (the server's unsigned `team` field says so: it only picks
    /// these words; the gate is closed because the signed plan isn't Team).
    TeamElsewhere,
    /// Review fix: the account's Team plan or seat is ready on no computer
    /// yet (`team.state` is `nowhere`): the person chooses one.
    TeamToChoose,
    /// This Mac is in no team.
    NoTeam,
    /// The Team plan is for another team repository.
    #[serde(rename_all = "camelCase")]
    OtherRepo { plan_repo: Option<String>, team_repo: String },
    /// Signed in to Plyloft as another GitHub account than the team's.
    #[serde(rename_all = "camelCase")]
    OtherAccount { login: String, team_login: String },
    /// Launch T3: signed in as the team's account, on a team owned by
    /// somebody else, without a seat on its plan.
    #[serde(rename_all = "camelCase")]
    NoSeat { owner: String, team_repo: String },
}

/// Stable leads of the plan refusals: the frontend tells them apart by these
/// (`src/lib/planGates.ts`), as it does the setup refusals.
pub const TEAM_PLAN_LEAD: &str = "Team plan needed:";
pub const TEAM_OTHER_REPO_LEAD: &str = "Your Team plan is for another team:";
pub const TEAM_OTHER_ACCOUNT_LEAD: &str = "Signed in as another account:";
/// 1.178.0 (D18).
pub const TEAM_SIGNED_OUT_LEAD: &str = "Plyloft account needed:";
/// 1.178.0 (D19).
pub const TEAM_ELSEWHERE_LEAD: &str = "Team is on another computer:";
/// Review fix: no computer holds Team yet.
pub const TEAM_TO_CHOOSE_LEAD: &str = "Choose a computer to use Team.";

fn same_slug(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

impl TeamAccess {
    pub fn allowed(&self) -> bool {
        matches!(self, TeamAccess::Allowed)
    }

    /// The stable code the tests use (the frontend reads `state`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn code(&self) -> &'static str {
        match self {
            TeamAccess::Allowed => "allowed",
            TeamAccess::NoTeamPlan => "team_plan_required",
            TeamAccess::SignedOut => "sign_in_required",
            TeamAccess::TeamElsewhere => "team_elsewhere",
            TeamAccess::TeamToChoose => "team_to_choose",
            TeamAccess::NoTeam => "no_team",
            TeamAccess::OtherRepo { .. } => "team_other_repo",
            TeamAccess::OtherAccount { .. } => "team_account_mismatch",
            TeamAccess::NoSeat { .. } => "team_no_seat",
        }
    }

    /// What a team action says when it is refused. `None` when allowed.
    pub fn refusal(&self) -> Option<String> {
        use crate::platform::{THIS_MACHINE, THIS_MACHINE_CAP};
        Some(match self {
            TeamAccess::Allowed => return None,
            TeamAccess::NoTeamPlan => format!(
                "{TEAM_PLAN_LEAD} team features run on the Team plan. Your Plyloft account isn't on it \
                 (or its plan lapsed). See Settings › Setup and account › Plan."
            ),
            TeamAccess::SignedOut => format!(
                "{TEAM_SIGNED_OUT_LEAD} team features run on a Team plan, and you aren't signed in to \
                 Plyloft on {THIS_MACHINE}. Sign in in Settings › Setup and account › Plan."
            ),
            TeamAccess::TeamElsewhere => format!(
                "{TEAM_ELSEWHERE_LEAD} team features run on one computer at a time. Use Team on this \
                 computer in Settings › Setup and account › Plan brings them here."
            ),
            TeamAccess::TeamToChoose => TEAM_TO_CHOOSE_LEAD.to_string(),
            TeamAccess::NoTeam => {
                format!("{THIS_MACHINE_CAP} is not on a team yet. Create or join one in Settings › Team › Members and library.")
            }
            TeamAccess::OtherRepo { plan_repo, team_repo } => match plan_repo {
                Some(plan_repo) => format!(
                    "{TEAM_OTHER_REPO_LEAD} it covers {plan_repo}, and {THIS_MACHINE} is in {team_repo}. \
                     Join {plan_repo}, or ask {team_repo}'s owner for a seat."
                ),
                None => format!(
                    "{TEAM_OTHER_REPO_LEAD} it isn't bound to {team_repo} yet. Finish creating your \
                     team, or ask {team_repo}'s owner for a seat."
                ),
            },
            TeamAccess::OtherAccount { login, team_login } => format!(
                "{TEAM_OTHER_ACCOUNT_LEAD} you're signed in to Plyloft as {login}, and the team uses \
                 the GitHub account {team_login}. Switch account in Settings › Setup and account › Setup to use team features."
            ),
            TeamAccess::NoSeat { owner, team_repo } => format!(
                "{TEAM_PLAN_LEAD} ask {owner} to give you a seat on {team_repo}'s Team plan. Team \
                 features run for the people holding one."
            ),
        })
    }
}

/// D9/D10, pure: the plan first (no valid Team entitlement, nothing else
/// matters), then this Mac's team, its repository, and the account.
pub fn team_access(inputs: &PolicyInputs) -> TeamAccess {
    let account = &inputs.account;
    if !(account.entitlement_valid && account.plan == crate::account::Plan::Team) {
        return no_team_plan(inputs);
    }
    let Some(team_repo) = inputs.team_repo.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return TeamAccess::NoTeam;
    };
    let plan_repo = account.team_repo.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if !plan_repo.is_some_and(|p| same_slug(p, team_repo)) {
        return TeamAccess::OtherRepo {
            plan_repo: plan_repo.map(str::to_string),
            team_repo: team_repo.to_string(),
        };
    }
    if let (Some(login), Some(team_login)) = (
        account.login.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        inputs.team_login.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    ) {
        if !login.eq_ignore_ascii_case(team_login) {
            return TeamAccess::OtherAccount { login: login.to_string(), team_login: team_login.to_string() };
        }
    }
    TeamAccess::Allowed
}

/// 1.178.0: the server's last `team` field says the account's Team plan or
/// seat runs on another computer, or on none yet. Only the refusal's words
/// read it.
fn team_waits(account: &crate::account::AccountInfo) -> Option<TeamAccess> {
    use crate::account::TeamState;
    if !account.signed_in {
        return None;
    }
    match account.team.as_ref()?.state {
        TeamState::Elsewhere => Some(TeamAccess::TeamElsewhere),
        TeamState::Nowhere => Some(TeamAccess::TeamToChoose),
        _ => None,
    }
}

/// Launch T3: why an account without the Team plan here can't use this
/// Mac's team. Signed out (1.178.0): sign in. Another account than the
/// team's: D10's wording (the seat may be the other account's). A Team plan
/// or seat on another computer (1.178.0), for this team or one not known
/// yet: Use Team on this computer. The team's account on somebody else's
/// team: ask its owner for a seat. Otherwise (the owner whose plan lapsed,
/// no team, no clone read yet): the plain refusal.
fn no_team_plan(inputs: &PolicyInputs) -> TeamAccess {
    let account = &inputs.account;
    if !account.signed_in {
        return TeamAccess::SignedOut;
    }
    let nonblank = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let waits = team_waits(account);
    let elsewhere = waits.is_some().then(|| {
        account.team.as_ref().and_then(|t| nonblank(t.team_repo.as_deref()))
    });
    let (Some(team_repo), Some(login)) = (nonblank(inputs.team_repo.as_deref()), nonblank(account.login.as_deref()))
    else {
        return waits.unwrap_or(TeamAccess::NoTeamPlan);
    };
    if let Some(team_login) = nonblank(inputs.team_login.as_deref()) {
        if !login.eq_ignore_ascii_case(&team_login) {
            return TeamAccess::OtherAccount { login, team_login };
        }
    }
    // A Team plan for another team than this Mac's is not this team's to
    // bring here: the refusals below say so.
    if let Some(plan_repo) = elsewhere {
        if plan_repo.as_deref().is_none_or(|p| same_slug(p, &team_repo)) {
            return waits.unwrap_or(TeamAccess::NoTeamPlan);
        }
    }
    match nonblank(inputs.team_owner.as_deref()) {
        Some(owner) if !owner.eq_ignore_ascii_case(&login) => TeamAccess::NoSeat { owner, team_repo },
        _ => TeamAccess::NoTeamPlan,
    }
}

/// D9/D10 for **Create team**, where this Mac is on no team yet: the Team
/// plan, not bound to another repository than `repo`, held by the GitHub
/// account that creates it (`creator`). `None` for a fact not known yet (the
/// plan is checked before the login is read).
pub fn team_create_access(
    account: &crate::account::AccountInfo,
    repo: Option<&str>,
    creator: Option<&str>,
) -> TeamAccess {
    if !(account.entitlement_valid && account.plan == crate::account::Plan::Team) {
        if !account.signed_in {
            return TeamAccess::SignedOut;
        }
        return team_waits(account).unwrap_or(TeamAccess::NoTeamPlan);
    }
    let plan_repo = account.team_repo.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let (Some(repo), Some(plan_repo)) = (repo, plan_repo) {
        if !same_slug(repo, plan_repo) {
            return TeamAccess::OtherRepo { plan_repo: Some(plan_repo.to_string()), team_repo: repo.trim().to_string() };
        }
    }
    if let (Some(login), Some(creator)) = (account.login.as_deref(), creator) {
        if !login.trim().eq_ignore_ascii_case(creator.trim()) {
            return TeamAccess::OtherAccount { login: login.trim().to_string(), team_login: creator.trim().to_string() };
        }
    }
    TeamAccess::Allowed
}

/// What the frontend reads to draw the plan and the team locks: the
/// decisions, never the inputs to re-derive them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGates {
    pub plan: crate::account::Plan,
    /// `plan` from a valid entitlement (Free otherwise).
    pub entitlement_valid: bool,
    /// When the entitlement expires (the frontend reads the gates again
    /// then, Challenger P3-6); `None` without one.
    pub exp: Option<i64>,
    pub team: TeamAccess,
    pub team_allowed: bool,
    /// What a refused team action says (`None` when allowed).
    pub team_refusal: Option<String>,
}

impl PlanGates {
    pub fn of(inputs: &PolicyInputs) -> Self {
        let team = team_access(inputs);
        Self {
            plan: if inputs.account.entitlement_valid { inputs.account.plan } else { crate::account::Plan::Free },
            entitlement_valid: inputs.account.entitlement_valid,
            exp: inputs.account.exp,
            team_allowed: team.allowed(),
            team_refusal: team.refusal(),
            team,
        }
    }
}

/// The production inputs from an app's managed stores, read now. A store the
/// app lacks reads as absent (signed out, no team). Never runs a subprocess
/// and never touches the network: gates run on hot paths.
pub fn app_policy_inputs<R: tauri::Runtime>(app: &tauri::AppHandle<R>, now_ms: i64) -> PolicyInputs {
    use tauri::Manager;
    let account = app
        .try_state::<crate::account::AccountStore>()
        .map(|store| store.info_at(now_ms))
        .unwrap_or_else(crate::account::AccountInfo::signed_out);
    let team_settings = app
        .try_state::<crate::settings::SettingsStore>()
        .map(|settings| settings.snapshot().team)
        .unwrap_or_default();
    let team_repo = crate::team::current_team_repo(&team_settings);
    // Only the recorded account: the same answer here and in the read-only
    // Inbox proof, whatever gh's process-wide cache holds.
    let team_login = team_repo.as_ref().and(
        team_settings.account.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(str::to_string),
    );
    let team_owner = team_owner_for(&account, team_repo.as_deref(), |slug| {
        app.try_state::<crate::team::TeamStore>().map(|team| team.clone_dir(slug))
    });
    PolicyInputs { account, team_repo, team_login, team_owner }
}

/// Launch T3: the owner `team.json` names in this Mac's clone of `team_repo`
/// — read (one small local file) only when the account has no Team plan;
/// a Team account never needs it, so the gates' hot path reads nothing.
fn team_owner_for(
    account: &crate::account::AccountInfo,
    team_repo: Option<&str>,
    clone_dir: impl FnOnce(&str) -> Option<PathBuf>,
) -> Option<String> {
    if account.entitlement_valid && account.plan == crate::account::Plan::Team {
        return None;
    }
    if !account.signed_in {
        return None;
    }
    let dir = clone_dir(team_repo?)?;
    crate::team::read_manifest(&dir)
        .ok()
        .flatten()
        .and_then(|m| m.owner_login().map(str::to_string))
}

// ── Key verification ────────────────────────────────────────────────

fn embedded_pubkey() -> Result<VerifyingKey, String> {
    let bytes = hex_decode(LICENSE_PUBKEY_HEX)
        .ok_or_else(|| "license: embedded pubkey is not valid hex".to_string())?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "license: embedded pubkey must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("license: bad embedded pubkey: {e}"))
}

pub(crate) fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Parse + verify a pasted key against an explicit pubkey (tests inject
/// their own keypair; production goes through [`verify_key`]).
pub fn verify_key_with(key: &str, pubkey: &VerifyingKey) -> Result<LicensePayload, String> {
    let body = key
        .trim()
        .strip_prefix(KEY_PREFIX)
        .ok_or_else(|| format!("Not a Plyloft team key (expected a {KEY_PREFIX}… string)."))?;
    let (payload_b64, sig_b64) = body
        .split_once('.')
        .ok_or_else(|| "Malformed team key (missing signature part).".to_string())?;
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "Malformed team key (payload is not base64url).".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "Malformed team key (signature is not base64url).".to_string())?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "Malformed team key (signature must be 64 bytes).".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);
    pubkey
        .verify_strict(&payload_bytes, &sig)
        .map_err(|_| "Invalid team key (signature check failed).".to_string())?;
    serde_json::from_slice::<LicensePayload>(&payload_bytes)
        .map_err(|_| "Invalid team key (unreadable payload).".to_string())
}

/// Production-path verification against the embedded pubkey.
pub fn verify_key(key: &str) -> Result<LicensePayload, String> {
    verify_key_with(key, &embedded_pubkey()?)
}

// ── Persisted key + the policy holder ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicenseFile {
    #[serde(default = "default_license_schema")]
    schema_version: u32,
    #[serde(default)]
    key: Option<String>,
}

fn default_license_schema() -> u32 {
    LICENSE_SCHEMA_VERSION
}

/// Where the policy reads its inputs (an app's stores, or a test's fixed
/// case), at a caller-supplied clock.
type InputSource = Box<dyn Fn(i64) -> PolicyInputs + Send + Sync>;

/// Managed state: the one place every plan gate asks (launch G1–G3), plus the
/// stored `PLY1` key, read only to be reported. A corrupt key file degrades to
/// "no key" (never fatal).
pub struct LicenseStore {
    key: Mutex<Option<String>>,
    source: InputSource,
    /// Test-only: a fixed answer for command-wiring tests that only need
    /// "team features run" or "they don't".
    #[cfg(test)]
    team_allowed_override: Option<std::sync::atomic::AtomicBool>,
}

impl LicenseStore {
    /// No account and no team: every paid gate closed. For readers with no
    /// app (and tests that need nothing more).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(config_dir: PathBuf) -> Self {
        Self::with_source(config_dir, Box::new(|_| PolicyInputs::signed_out()))
    }

    /// The product store: the account, the settings and the team store of
    /// `app`, read at each gate.
    pub fn for_app<R: tauri::Runtime>(config_dir: PathBuf, app: tauri::AppHandle<R>) -> Self {
        Self::with_source(config_dir, Box::new(move |now| app_policy_inputs(&app, now)))
    }

    /// The Inbox eligibility proof's store: `account.json` and the settings,
    /// read from disk without writing either.
    pub fn read_only(config_dir: PathBuf, settings: crate::settings::Settings) -> Self {
        let dir = config_dir.clone();
        Self::with_source(
            config_dir,
            Box::new(move |now| {
                let team_repo = crate::team::current_team_repo(&settings.team);
                let team_login = team_repo.as_ref().and(
                    settings.team.account.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(str::to_string),
                );
                let account = crate::account::read_only_info(&dir, now);
                let team_owner = team_owner_for(&account, team_repo.as_deref(), |slug| {
                    Some(crate::team::TeamStore::new(dir.clone()).clone_dir(slug))
                });
                PolicyInputs { account, team_repo, team_login, team_owner }
            }),
        )
    }

    fn with_source(config_dir: PathBuf, source: InputSource) -> Self {
        let path = config_dir.join("license.json");
        let key = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<LicenseFile>(&s).ok())
            .and_then(|f| f.key);
        Self {
            key: Mutex::new(key),
            source,
            #[cfg(test)]
            team_allowed_override: None,
        }
    }

    /// Test-only: the store under one case of the plan matrix
    /// ([`PlanCase::ALL`]), through the real policy.
    #[cfg(test)]
    pub(crate) fn for_plan_test(config_dir: PathBuf, case: PlanCase) -> Self {
        Self::with_source(config_dir, Box::new(move |_| case.inputs()))
    }

    /// Test-only admission fixture for command-wiring tests: team features
    /// run (the case is a matching Team plan).
    #[cfg(test)]
    pub fn new_team_allowed_for_test(config_dir: PathBuf) -> Self {
        let mut store = Self::for_plan_test(config_dir, PlanCase::TeamMatching);
        store.team_allowed_override = Some(std::sync::atomic::AtomicBool::new(true));
        store
    }

    /// Change only the test admission seam while retaining the same managed
    /// instance. Never compiled into the product.
    #[cfg(test)]
    pub(crate) fn set_team_allowed_for_test(&self, allowed: bool) {
        self.team_allowed_override
            .as_ref()
            .expect("test admission fixture required")
            .store(allowed, std::sync::atomic::Ordering::SeqCst);
    }

    /// What the stored key says (reported only). A stored key that fails
    /// verification degrades to `None`.
    pub fn info_at(&self, now_ms: i64) -> LicenseInfo {
        let guard = self.key.lock().unwrap();
        match guard.as_deref().map(verify_key) {
            Some(Ok(payload)) => LicenseInfo::from_payload(&payload, now_ms),
            _ => LicenseInfo::none(),
        }
    }

    pub fn info(&self) -> LicenseInfo {
        self.info_at(chrono::Utc::now().timestamp_millis())
    }

    /// The policy's inputs now.
    pub fn inputs_at(&self, now_ms: i64) -> PolicyInputs {
        (self.source)(now_ms)
    }

    /// The account the gates read (Free without a valid entitlement).
    pub fn account(&self) -> crate::account::AccountInfo {
        self.inputs_at(chrono::Utc::now().timestamp_millis()).account
    }

    /// Every decision at once, for the frontend.
    pub fn gates(&self) -> PlanGates {
        #[cfg_attr(not(test), allow(unused_mut))]
        let mut gates = PlanGates::of(&self.inputs_at(chrono::Utc::now().timestamp_millis()));
        #[cfg(test)]
        if let Some(allowed) = &self.team_allowed_override {
            let allowed = allowed.load(std::sync::atomic::Ordering::SeqCst);
            gates.team_allowed = allowed;
            if allowed {
                gates.team = TeamAccess::Allowed;
                gates.team_refusal = None;
            } else if gates.team.allowed() {
                gates.team = TeamAccess::NoTeamPlan;
                gates.team_refusal = TeamAccess::NoTeamPlan.refusal();
            }
        }
        gates
    }

    /// D9/D10: may team features run now, and if not, why.
    pub fn team_access_at(&self, now_ms: i64) -> TeamAccess {
        #[cfg(test)]
        if let Some(allowed) = &self.team_allowed_override {
            return if allowed.load(std::sync::atomic::Ordering::SeqCst) {
                TeamAccess::Allowed
            } else {
                TeamAccess::NoTeamPlan
            };
        }
        team_access(&self.inputs_at(now_ms))
    }

    pub fn team_access(&self) -> TeamAccess {
        self.team_access_at(chrono::Utc::now().timestamp_millis())
    }

    /// [`team_create_access`] for this account (the test admission seam
    /// answers as for any team gate).
    pub fn team_create_access(&self, repo: Option<&str>, creator: Option<&str>) -> TeamAccess {
        #[cfg(test)]
        if self.team_allowed_override.is_some() {
            return self.team_access();
        }
        team_create_access(&self.account(), repo, creator)
    }

    /// The team gate predicate.
    pub fn team_allowed(&self) -> bool {
        self.team_allowed_at(chrono::Utc::now().timestamp_millis())
    }

    /// The team gate predicate at a caller-supplied clock. Feed assembly and
    /// its proof use one timestamp for every boundary.
    pub fn team_allowed_at(&self, now_ms: i64) -> bool {
        self.team_access_at(now_ms).allowed()
    }

    /// Kept for the OB-8 call sites: team features never run "only because
    /// teams are free during the beta" any more, so a GitHub Issues board is
    /// never held back for an answer (launch G3).
    pub fn unlocked_only_by_beta(&self) -> bool {
        false
    }

}

/// The record that [`adopt_key_team_once`] ran on this profile.
const KEY_TEAM_ADOPTED_FILE: &str = "license-team-adopted";

/// Launch G3 (Challenger P3-7): once per profile, at startup, a stored `PLY1`
/// key that names a team repo gives it to `settings.team.teamRepo` when the
/// setting names none — the one Mac that joined a team by key keeps it. Then
/// the key stays inert: a marker file says it ran, so leaving the team later
/// is never undone by the key. `license.json` is not touched. `Some` when the
/// setting was written.
pub fn adopt_key_team_once(
    config_dir: &std::path::Path,
    settings: &crate::settings::SettingsStore,
    license: &LicenseStore,
) -> Option<crate::settings::Settings> {
    adopt_key_team_with(config_dir, settings, license.info().team_repo)
}

/// [`adopt_key_team_once`] with the key's team repo given (tests cannot mint
/// a key the embedded public key accepts).
pub(crate) fn adopt_key_team_with(
    config_dir: &std::path::Path,
    settings: &crate::settings::SettingsStore,
    key_team_repo: Option<String>,
) -> Option<crate::settings::Settings> {
    let marker = config_dir.join(KEY_TEAM_ADOPTED_FILE);
    if marker.exists() {
        return None;
    }
    let repo = key_team_repo.map(|r| r.trim().to_string()).filter(|r| !r.is_empty())?;
    let saved = match settings.set_team_repo_if_blank(&repo) {
        Ok(saved) => saved,
        Err(e) => {
            log::warn!("license: couldn't keep the key's team {repo}: {e}");
            return None;
        }
    };
    if let Err(e) = crate::atomic::write_atomic_text(&marker, &format!("{repo}\n")) {
        log::warn!("license: couldn't record the key's team adoption: {e}");
    }
    if saved.is_some() {
        log::info!("license: kept the stored key's team {repo} as {}'s team", crate::platform::THIS_MACHINE);
    }
    saved
}

/// Test-only: the plan matrix every gate test runs under (launch G3). Only
/// [`PlanCase::TeamMatching`] opens the team gates; every other gate is open
/// in every case.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanCase {
    /// Signed in, Free.
    Free,
    /// Signed in on an old `pro` entitlement: the same as Free.
    Pro,
    /// Team, for the team this Mac is in, as the team's account.
    TeamMatching,
    /// Team, for another team repository.
    TeamOtherRepo,
    /// Team for this team, signed in to Plyloft as another account.
    TeamOtherAccount,
    /// A Team entitlement that expired (the plan lapsed): reads as Free.
    Expired,
    /// 1.178.0: not signed in to Plyloft.
    SignedOut,
    /// 1.178.0: signed in on Free here; the account's Team seat runs on
    /// another computer (the server's `team` field).
    TeamElsewhere,
}

#[cfg(test)]
impl PlanCase {
    pub(crate) const ALL: [PlanCase; 8] = [
        PlanCase::Free,
        PlanCase::Pro,
        PlanCase::TeamMatching,
        PlanCase::TeamOtherRepo,
        PlanCase::TeamOtherAccount,
        PlanCase::Expired,
        PlanCase::SignedOut,
        PlanCase::TeamElsewhere,
    ];

    /// The team every case's Mac is in, and the account it uses.
    pub(crate) const TEAM_REPO: &'static str = "acme/team";
    pub(crate) const TEAM_LOGIN: &'static str = "octocat";

    pub(crate) fn team_allowed(self) -> bool {
        self == PlanCase::TeamMatching
    }

    /// What a refused team gate says in this case (`None` when it runs).
    pub(crate) fn team_refusal(self) -> Option<String> {
        team_access(&self.inputs()).refusal()
    }

    pub(crate) fn inputs(self) -> PolicyInputs {
        use crate::account::{AccountInfo, Plan};
        let mut account = AccountInfo::signed_out();
        account.signed_in = true;
        account.login = Some(Self::TEAM_LOGIN.to_string());
        account.sub = Some("1".to_string());
        account.entitlement_valid = true;
        account.exp = Some(i64::MAX);
        match self {
            PlanCase::Free => account.plan = Plan::Free,
            PlanCase::Pro => account.plan = Plan::Pro,
            PlanCase::TeamMatching => {
                account.plan = Plan::Team;
                account.team_repo = Some("Acme/Team".to_string());
            }
            PlanCase::TeamOtherRepo => {
                account.plan = Plan::Team;
                account.team_repo = Some("acme/other".to_string());
            }
            PlanCase::TeamOtherAccount => {
                account.plan = Plan::Team;
                account.team_repo = Some(Self::TEAM_REPO.to_string());
                account.login = Some("someone-else".to_string());
            }
            PlanCase::Expired => {
                // What `AccountInfo` reads for an expired Team token.
                account.entitlement_valid = false;
                account.exp = None;
            }
            PlanCase::SignedOut => account = AccountInfo::signed_out(),
            PlanCase::TeamElsewhere => {
                use crate::account::{AccountTeam, TeamState};
                account.plan = Plan::Free;
                account.team = Some(AccountTeam {
                    state: TeamState::Elsewhere,
                    device: Some("Mac mini".to_string()),
                    team_repo: Some(Self::TEAM_REPO.to_string()),
                    role: Some(crate::account::TeamRole::Member),
                });
            }
        }
        PolicyInputs {
            account,
            team_repo: Some(Self::TEAM_REPO.to_string()),
            team_login: Some(Self::TEAM_LOGIN.to_string()),
            team_owner: None,
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_keypair() -> (SigningKey, VerifyingKey) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    fn mint(sk: &SigningKey, payload: &str) -> String {
        let sig = sk.sign(payload.as_bytes());
        format!(
            "{KEY_PREFIX}{}.{}",
            URL_SAFE_NO_PAD.encode(payload.as_bytes()),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }

    fn payload_json(expires_at: i64) -> String {
        format!(
            r#"{{"team":"Test Team","seats":5,"issuedAt":1000,"expiresAt":{expires_at}}}"#
        )
    }

    /// v1.114.0: the same payload plus the optional team repo.
    fn payload_json_with_team_repo(expires_at: i64, team_repo: &str) -> String {
        format!(
            r#"{{"team":"Test Team","seats":5,"issuedAt":1000,"expiresAt":{expires_at},"teamRepo":"{team_repo}"}}"#
        )
    }

    #[test]
    fn embedded_pubkey_is_well_formed() {
        embedded_pubkey().expect("LICENSE_PUBKEY_HEX must decode to a valid Ed25519 key");
    }

    #[test]
    fn round_trip_valid_key() {
        let (sk, vk) = test_keypair();
        let key = mint(&sk, &payload_json(2000));
        let p = verify_key_with(&key, &vk).unwrap();
        assert_eq!(p.team, "Test Team");
        assert_eq!(p.seats, 5);
        assert_eq!(p.expires_at, 2000);
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let (sk, vk) = test_keypair();
        let key = mint(&sk, &payload_json(2000));
        // Replace the payload with a different (longer expiry) one while
        // keeping the original signature.
        let sig_part = key.split('.').nth(1).unwrap();
        let forged = format!(
            "{KEY_PREFIX}{}.{sig_part}",
            URL_SAFE_NO_PAD.encode(payload_json(999_999_999).as_bytes())
        );
        assert!(verify_key_with(&forged, &vk)
            .unwrap_err()
            .contains("signature check failed"));
    }

    #[test]
    fn wrong_key_signature_is_rejected() {
        let (_, vk) = test_keypair();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let key = mint(&other, &payload_json(2000));
        assert!(verify_key_with(&key, &vk).is_err());
    }

    #[test]
    fn malformed_keys_are_rejected_with_readable_errors() {
        let (_, vk) = test_keypair();
        assert!(verify_key_with("garbage", &vk).unwrap_err().contains("PLY1-"));
        assert!(verify_key_with("PLY1-nodot", &vk)
            .unwrap_err()
            .contains("missing signature"));
        assert!(verify_key_with("PLY1-!!!.@@@", &vk)
            .unwrap_err()
            .contains("base64url"));
    }

    #[test]
    fn status_ladder_valid_grace_expired() {
        let p = LicensePayload {
            team: "T".into(),
            seats: 5,
            issued_at: 0,
            expires_at: 1_000_000,
            team_repo: None,
        };
        let at = |now| LicenseInfo::from_payload(&p, now);
        assert_eq!(at(999_999).status, LicenseStatus::Valid);
        assert_eq!(at(1_000_000).status, LicenseStatus::Valid);
        assert_eq!(at(1_000_001).status, LicenseStatus::Grace);
        assert_eq!(at(1_000_000 + GRACE_MS).status, LicenseStatus::Grace);
        assert_eq!(at(1_000_001 + GRACE_MS).status, LicenseStatus::Expired);
    }

    /// Launch G3: a valid stored `PLY1` key unlocks nothing — the store reads
    /// it (for Diagnostics) and the gates answer from the account alone.
    #[test]
    fn a_valid_stored_key_unlocks_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        // A key the embedded pubkey can't have signed still shows the store
        // never consults it; and the default store is signed out.
        std::fs::write(tmp.path().join("license.json"), r#"{"schemaVersion":1,"key":"PLY1-x.y"}"#).unwrap();
        let store = LicenseStore::new(tmp.path().to_path_buf());
        assert!(!store.team_allowed());
        assert_eq!(store.team_access(), TeamAccess::SignedOut);
        // The file is left as it was.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("license.json")).unwrap(),
            r#"{"schemaVersion":1,"key":"PLY1-x.y"}"#
        );
    }

    /// D9/D10: the plan matrix through the real policy. Team access is the
    /// only thing a plan decides; Pro reads as Free.
    #[test]
    fn the_plan_matrix_opens_team_only_for_the_matching_team_and_account() {
        for case in PlanCase::ALL {
            let tmp = tempfile::tempdir().unwrap();
            let store = LicenseStore::for_plan_test(tmp.path().to_path_buf(), case);
            assert_eq!(store.team_allowed(), case.team_allowed(), "{case:?}");
            assert_eq!(store.team_allowed_at(0), case.team_allowed(), "{case:?}");
            let gates = store.gates();
            assert_eq!(gates.team_allowed, case.team_allowed(), "{case:?}");
            assert_eq!(gates.team_refusal.is_none(), case.team_allowed(), "{case:?}");
            let expected = match case {
                PlanCase::TeamMatching => "allowed",
                PlanCase::TeamOtherRepo => "team_other_repo",
                PlanCase::TeamOtherAccount => "team_account_mismatch",
                PlanCase::Free | PlanCase::Pro | PlanCase::Expired => "team_plan_required",
                PlanCase::SignedOut => "sign_in_required",
                PlanCase::TeamElsewhere => "team_elsewhere",
            };
            assert_eq!(store.team_access().code(), expected, "{case:?}");
            assert_eq!(store.team_access().refusal().is_none(), case.team_allowed(), "{case:?}");
        }
    }

    fn inputs(plan: crate::account::Plan, plan_repo: Option<&str>, login: &str) -> PolicyInputs {
        let mut account = crate::account::AccountInfo::signed_out();
        account.signed_in = true;
        account.login = Some(login.into());
        account.plan = plan;
        account.team_repo = plan_repo.map(str::to_string);
        account.entitlement_valid = true;
        PolicyInputs { account, team_repo: Some("Acme/Team".into()), team_login: Some("OctoCat".into()), team_owner: None }
    }

    /// Launch T3: a member without a seat is told whom to ask; another
    /// account than the team's gets D10's words; the owner (a lapse), a
    /// signed-out profile and an unread clone keep the plain refusal.
    #[test]
    fn no_seat_names_the_owner_and_a_mismatch_says_so() {
        use crate::account::Plan;
        let mut member = inputs(Plan::Free, None, "octocat");
        member.team_owner = Some("Boss".into());
        let access = team_access(&member);
        assert_eq!(access, TeamAccess::NoSeat { owner: "Boss".into(), team_repo: "Acme/Team".into() });
        assert_eq!(access.code(), "team_no_seat");
        let words = access.refusal().unwrap();
        assert!(words.starts_with(TEAM_PLAN_LEAD), "{words}");
        assert!(words.contains("ask Boss to give you a seat"), "{words}");
        // Pro is no seat either.
        member.account.plan = Plan::Pro;
        assert!(matches!(team_access(&member), TeamAccess::NoSeat { .. }));

        let mut other = inputs(Plan::Free, None, "hubot");
        other.team_owner = Some("Boss".into());
        assert_eq!(
            team_access(&other),
            TeamAccess::OtherAccount { login: "hubot".into(), team_login: "OctoCat".into() }
        );

        let mut owner = inputs(Plan::Free, None, "octocat");
        owner.team_owner = Some("OCTOCAT".into());
        assert_eq!(team_access(&owner), TeamAccess::NoTeamPlan, "the owner's own lapse");
        let unread = inputs(Plan::Free, None, "octocat");
        assert_eq!(team_access(&unread), TeamAccess::NoTeamPlan);
        let mut signed_out = member.clone();
        signed_out.account = crate::account::AccountInfo::signed_out();
        assert_eq!(team_access(&signed_out), TeamAccess::SignedOut, "1.178.0: signed out says so");
        // A Team plan never reads the owner (and passes).
        let mut team = inputs(Plan::Team, Some("acme/team"), "octocat");
        team.team_owner = Some("Boss".into());
        assert!(team_access(&team).allowed());
    }

    #[test]
    fn the_owner_is_read_from_the_clone_only_without_a_team_plan() {
        use crate::account::Plan;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(crate::team::MANIFEST_FILE),
            r#"{"schemaVersion":1,"name":"Acme","members":[{"login":"Boss","owner":true},{"login":"octocat","owner":false}],"workspaces":[]}"#,
        )
        .unwrap();
        let free = inputs(Plan::Free, None, "octocat").account;
        let path = dir.path().to_path_buf();
        assert_eq!(team_owner_for(&free, Some("Acme/Team"), |_| Some(path.clone())).as_deref(), Some("Boss"));
        assert_eq!(team_owner_for(&free, None, |_| panic!("no team, no read")), None);
        let team = inputs(Plan::Team, Some("acme/team"), "octocat").account;
        assert_eq!(team_owner_for(&team, Some("Acme/Team"), |_| panic!("a Team plan reads nothing")), None);
        let missing = dir.path().join("nope");
        assert_eq!(team_owner_for(&free, Some("Acme/Team"), |_| Some(missing.clone())), None);
    }

    #[test]
    fn repo_and_login_compare_ignoring_case_and_spaces() {
        use crate::account::Plan;
        assert!(team_access(&inputs(Plan::Team, Some(" acme/team "), "octocat")).allowed());
        assert_eq!(
            team_access(&inputs(Plan::Team, Some("acme/other"), "octocat")),
            TeamAccess::OtherRepo { plan_repo: Some("acme/other".into()), team_repo: "Acme/Team".into() }
        );
        // A Team plan not bound to a repository yet is not this team's.
        assert!(matches!(team_access(&inputs(Plan::Team, None, "octocat")), TeamAccess::OtherRepo { plan_repo: None, .. }));
        assert_eq!(
            team_access(&inputs(Plan::Team, Some("acme/team"), "hubot")),
            TeamAccess::OtherAccount { login: "hubot".into(), team_login: "OctoCat".into() }
        );
    }

    #[test]
    fn no_team_plan_wins_over_everything_and_no_team_is_said_as_such() {
        use crate::account::Plan;
        for plan in [Plan::Free, Plan::Pro] {
            assert_eq!(team_access(&inputs(plan, Some("acme/team"), "octocat")), TeamAccess::NoTeamPlan);
        }
        let mut lapsed = inputs(Plan::Team, Some("acme/team"), "octocat");
        lapsed.account.entitlement_valid = false;
        assert_eq!(team_access(&lapsed), TeamAccess::NoTeamPlan);
        let mut no_team = inputs(Plan::Team, Some("acme/team"), "octocat");
        no_team.team_repo = Some("  ".into());
        assert_eq!(team_access(&no_team), TeamAccess::NoTeam);
        // An unknown team login can't be compared: the account check waits.
        let mut unknown = inputs(Plan::Team, Some("acme/team"), "anyone");
        unknown.team_login = None;
        assert!(team_access(&unknown).allowed());
        assert_eq!(team_access(&PolicyInputs::signed_out()), TeamAccess::SignedOut);
    }

    /// 1.178.0: signed out says sign in; a Team seat on another computer (or
    /// ready on none) says Use Team on this computer — read from the
    /// server's unsigned `team` field for the words only: the gate stays
    /// closed because the signed plan is Free. Another account than the
    /// team's still says so first, and a Team plan for another team than
    /// this Mac's isn't this team's to bring here.
    #[test]
    fn signed_out_and_team_elsewhere_are_told_apart() {
        use crate::account::{AccountTeam, Plan, TeamState};
        let seat = |state, repo: Option<&str>| AccountTeam {
            state,
            device: None,
            team_repo: repo.map(str::to_string),
            role: Some(crate::account::TeamRole::Member),
        };
        let with = |team: AccountTeam, login: &str| {
            let mut i = inputs(Plan::Free, None, login);
            i.account.team = Some(team);
            i.team_owner = Some("Boss".into());
            i
        };
        for (state, expected, code) in [
            (TeamState::Elsewhere, TeamAccess::TeamElsewhere, "team_elsewhere"),
            (TeamState::Nowhere, TeamAccess::TeamToChoose, "team_to_choose"),
        ] {
            let access = team_access(&with(seat(state, Some("acme/team")), "octocat"));
            assert_eq!(access, expected, "{state:?}");
            assert_eq!(access.code(), code);
            assert!(!access.allowed());
            // An owner who hasn't bound a repository yet.
            assert_eq!(team_access(&with(seat(state, None), "octocat")), expected);
        }
        assert!(matches!(
            team_access(&with(seat(TeamState::Elsewhere, Some("acme/team")), "hubot")),
            TeamAccess::OtherAccount { .. }
        ));
        assert!(matches!(
            team_access(&with(seat(TeamState::Elsewhere, Some("other/team")), "octocat")),
            TeamAccess::NoSeat { .. }
        ));
        // "Here" from the field without a verified Team plan (it expired) is
        // the plain lapse, never an open gate.
        let mut here = with(seat(TeamState::Here, Some("acme/team")), "octocat");
        here.team_owner = None;
        assert_eq!(team_access(&here), TeamAccess::NoTeamPlan);
        // Not on a team yet: still told where Team is.
        let mut no_team = with(seat(TeamState::Elsewhere, Some("acme/team")), "octocat");
        no_team.team_repo = None;
        assert_eq!(team_access(&no_team), TeamAccess::TeamElsewhere);

        let signed_out = crate::account::AccountInfo::signed_out();
        assert_eq!(team_access(&PolicyInputs::signed_out()).code(), "sign_in_required");
        assert_eq!(team_create_access(&signed_out, Some("o/t"), Some("octocat")), TeamAccess::SignedOut);
        let elsewhere = with(seat(TeamState::Elsewhere, None), "octocat").account;
        assert_eq!(team_create_access(&elsewhere, None, Some("octocat")), TeamAccess::TeamElsewhere);
        let nowhere = with(seat(TeamState::Nowhere, None), "octocat").account;
        assert_eq!(team_create_access(&nowhere, None, Some("octocat")), TeamAccess::TeamToChoose);
        assert_eq!(team_access(&with(seat(TeamState::Nowhere, Some("acme/team")), "octocat")).refusal().unwrap(), TEAM_TO_CHOOSE_LEAD);
        let free = inputs(Plan::Free, None, "octocat").account;
        assert_eq!(team_create_access(&free, None, Some("octocat")), TeamAccess::NoTeamPlan);
    }

    #[test]
    fn refusals_carry_their_stable_leads_and_names() {
        use crate::account::Plan;
        let words = |i: &PolicyInputs| team_access(i).refusal().unwrap();
        assert!(words(&inputs(Plan::Free, None, "octocat")).starts_with(TEAM_PLAN_LEAD));
        let other = words(&inputs(Plan::Team, Some("acme/other"), "octocat"));
        assert!(other.starts_with(TEAM_OTHER_REPO_LEAD) && other.contains("acme/other") && other.contains("Acme/Team"), "{other}");
        let signed_out = team_access(&PolicyInputs::signed_out()).refusal().unwrap();
        assert_eq!(
            signed_out,
            format!(
                "Plyloft account needed: team features run on a Team plan, and you aren't signed in to Plyloft on {}. \
                 Sign in in Settings › Setup and account › Plan.",
                crate::platform::THIS_MACHINE
            ),
            "D18"
        );
        assert!(signed_out.starts_with(TEAM_SIGNED_OUT_LEAD));
        let elsewhere = PlanCase::TeamElsewhere.team_refusal().unwrap();
        assert_eq!(
            elsewhere,
            "Team is on another computer: team features run on one computer at a time. Use Team on this computer \
             in Settings › Setup and account › Plan brings them here.",
            "D19, verbatim on every platform"
        );
        assert!(elsewhere.starts_with(TEAM_ELSEWHERE_LEAD));
        let mismatch = words(&inputs(Plan::Team, Some("acme/team"), "hubot"));
        assert!(mismatch.starts_with(TEAM_OTHER_ACCOUNT_LEAD), "{mismatch}");
        assert!(mismatch.contains("hubot") && mismatch.contains("OctoCat") && mismatch.contains("Switch account"), "{mismatch}");
        // No team key is ever asked for again.
        for case in PlanCase::ALL {
            if let Some(r) = case.team_refusal() {
                assert!(!r.contains("team key"), "{r}");
            }
        }
    }

    /// The frontend reads these leads (`src/lib/planGates.ts`); a change on
    /// one side alone would stop it telling the refusals apart. Only the team
    /// refusals are left: no plan refuses anything else.
    #[test]
    fn the_frontend_knows_every_lead() {
        let ts = include_str!("../../src/lib/planGates.ts");
        for lead in [TEAM_PLAN_LEAD, TEAM_OTHER_REPO_LEAD, TEAM_OTHER_ACCOUNT_LEAD, TEAM_SIGNED_OUT_LEAD, TEAM_ELSEWHERE_LEAD, TEAM_TO_CHOOSE_LEAD] {
            assert!(ts.contains(&format!("\"{lead}\"")), "planGates.ts lacks {lead:?}");
        }
        for gone in ["Pro plan needed:", "Free plan: one card builds at a time."] {
            assert!(!ts.contains(gone), "planGates.ts still reads {gone:?}");
        }
    }

    #[test]
    fn gates_serialize_decisions_for_the_frontend() {
        let tmp = tempfile::tempdir().unwrap();
        let json = serde_json::to_value(LicenseStore::for_plan_test(tmp.path().to_path_buf(), PlanCase::TeamOtherAccount).gates()).unwrap();
        assert_eq!(json["plan"], "team");
        assert!(json.get("proAllowed").is_none() && json.get("cardSlotLimited").is_none(), "{json}");
        assert_eq!(json["teamAllowed"], false);
        assert_eq!(json["team"]["state"], "other_account");
        assert_eq!(json["team"]["teamLogin"], "octocat");
        assert!(json["teamRefusal"].as_str().unwrap().starts_with(TEAM_OTHER_ACCOUNT_LEAD));
        let signed_out = serde_json::to_value(LicenseStore::new(tmp.path().to_path_buf()).gates()).unwrap();
        assert_eq!(signed_out["plan"], "free");
        assert_eq!(signed_out["team"], serde_json::json!({"state": "signed_out"}));
        assert!(signed_out["teamRefusal"].as_str().unwrap().starts_with(TEAM_SIGNED_OUT_LEAD));
        let free = serde_json::to_value(LicenseStore::for_plan_test(tmp.path().to_path_buf(), PlanCase::Free).gates()).unwrap();
        assert_eq!(free["team"]["state"], "no_team_plan");
        let elsewhere =
            serde_json::to_value(LicenseStore::for_plan_test(tmp.path().to_path_buf(), PlanCase::TeamElsewhere).gates()).unwrap();
        assert_eq!(elsewhere["plan"], "free");
        assert_eq!(elsewhere["teamAllowed"], false);
        assert_eq!(elsewhere["team"], serde_json::json!({"state": "team_elsewhere"}));
        assert!(elsewhere["teamRefusal"].as_str().unwrap().starts_with(TEAM_ELSEWHERE_LEAD));
    }

    /// Challenger P3-7: a key's team becomes the setting once, only when the
    /// setting names none; after that (a leave, a relaunch) the key is inert.
    #[test]
    fn a_keys_team_is_adopted_once_and_never_again() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let settings = crate::settings::SettingsStore::new(dir.to_path_buf()).unwrap();
        // No key naming a team: nothing, and no marker (nothing ran).
        assert!(adopt_key_team_with(dir, &settings, None).is_none());
        assert!(!dir.join(KEY_TEAM_ADOPTED_FILE).exists());
        let saved = adopt_key_team_with(dir, &settings, Some(" mb/team ".into())).expect("kept");
        assert_eq!(saved.team.team_repo.as_deref(), Some("mb/team"));
        assert!(dir.join(KEY_TEAM_ADOPTED_FILE).exists());
        // Left the team, relaunched: the key does not bring it back.
        settings.clear_team().unwrap();
        assert!(adopt_key_team_with(dir, &settings, Some("mb/team".into())).is_none());
        assert_eq!(settings.snapshot().team.team_repo, None);
        // A setting already naming a team wins (another profile).
        let other = tempfile::tempdir().unwrap();
        let s2 = crate::settings::SettingsStore::new(other.path().to_path_buf()).unwrap();
        s2.set_joined_team("new/team", None).unwrap();
        assert!(adopt_key_team_with(other.path(), &s2, Some("mb/team".into())).is_none());
        assert_eq!(s2.snapshot().team.team_repo.as_deref(), Some("new/team"));
        assert!(other.path().join(KEY_TEAM_ADOPTED_FILE).exists());
    }

    #[test]
    fn team_allowed_at_wires_the_existing_test_override() {
        let tmp = tempfile::tempdir().unwrap();
        let allowed = LicenseStore::new_team_allowed_for_test(tmp.path().to_path_buf());
        assert!(allowed.team_allowed_at(123_456));
        allowed.set_team_allowed_for_test(false);
        assert!(!allowed.team_allowed_at(123_456));
        assert!(!allowed.gates().team_allowed);
    }

    /// v1.114.0 (team sharing rung 1): a key minted WITHOUT `--team-repo`
    /// — i.e. every key issued before this version — still verifies, and
    /// carries no team repo. `serde(default)` is the whole compatibility
    /// story; this test is the thing that would go red if it were dropped.
    #[test]
    fn key_without_team_repo_stays_valid() {
        let (sk, vk) = test_keypair();
        let key = mint(&sk, &payload_json(2000));
        let p = verify_key_with(&key, &vk).unwrap();
        assert_eq!(p.team, "Test Team");
        assert_eq!(p.team_repo, None);
        assert_eq!(LicenseInfo::from_payload(&p, 1000).team_repo, None);
    }

    /// A key minted WITH `--team-repo` carries the slug all the way to the
    /// info the frontend renders.
    #[test]
    fn key_with_team_repo_carries_the_slug() {
        let (sk, vk) = test_keypair();
        let key = mint(
            &sk,
            &payload_json_with_team_repo(2000, "MatteoB-adv/mbadv-team"),
        );
        let p = verify_key_with(&key, &vk).unwrap();
        assert_eq!(p.team_repo.as_deref(), Some("MatteoB-adv/mbadv-team"));
        let info = LicenseInfo::from_payload(&p, 1000);
        assert_eq!(info.status, LicenseStatus::Valid);
        assert_eq!(info.team_repo.as_deref(), Some("MatteoB-adv/mbadv-team"));
    }

    /// The signature covers the payload bytes, so adding `teamRepo` to an
    /// already-signed key is a forgery and must be refused.
    #[test]
    fn team_repo_cannot_be_grafted_onto_a_signed_key() {
        let (sk, vk) = test_keypair();
        let key = mint(&sk, &payload_json(2000));
        let sig_part = key.split('.').nth(1).unwrap();
        let forged = format!(
            "{KEY_PREFIX}{}.{sig_part}",
            URL_SAFE_NO_PAD.encode(payload_json_with_team_repo(2000, "evil/repo").as_bytes())
        );
        assert!(verify_key_with(&forged, &vk)
            .unwrap_err()
            .contains("signature check failed"));
    }

    /// Tier-2 schema test: the persisted file round-trips, a missing key
    /// field and a corrupt file both degrade to "no license".
    #[test]
    fn store_schema_migration_and_corruption_degrade() {
        let tmp = tempfile::tempdir().unwrap();

        // Fresh dir → None.
        let store = LicenseStore::new(tmp.path().to_path_buf());
        assert_eq!(store.info().status, LicenseStatus::None);

        // Hand-written minimal file (older writer without schemaVersion).
        std::fs::write(
            tmp.path().join("license.json"),
            r#"{"key":"PLY1-not-actually-valid"}"#,
        )
        .unwrap();
        let store = LicenseStore::new(tmp.path().to_path_buf());
        // Key present but unverifiable → degrades to None, never panics.
        assert_eq!(store.info().status, LicenseStatus::None);

        // Corrupt JSON → None.
        std::fs::write(tmp.path().join("license.json"), "{nope").unwrap();
        let store = LicenseStore::new(tmp.path().to_path_buf());
        assert_eq!(store.info().status, LicenseStatus::None);
        // Launch A3: keys are retired — nothing writes license.json any more.
        assert_eq!(std::fs::read_to_string(tmp.path().join("license.json")).unwrap(), "{nope");
    }
}
