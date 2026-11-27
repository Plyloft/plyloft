//! Launch card A1: the Plyloft account and its entitlement.
//!
//! A Plyloft account is a GitHub sign-in (LAUNCH_PLAN §2 D1, §3.1–3.2;
//! the wire contract is `docs/plans/LAUNCH_API.md`):
//!
//! 1. GitHub's OAuth **Device Flow** with the public client id and **no
//!    scopes** ([`request_device_code`], [`poll_for_token`]).
//! 2. The GitHub token goes once to `POST /v1/session` and is dropped right
//!    after; it is never persisted and never logged.
//! 3. The server's opaque session token goes to the OS keychain
//!    ([`KeyringSecrets`]: macOS Keychain, Windows Credential Manager), keyed
//!    by this profile's `deviceId`.
//! 4. The signed entitlement (`PLY2-…`, [`verify_entitlement_with`]) is cached
//!    in `<config_dir>/account.json` with the `deviceId`, the device name and
//!    `lastCheckedAt`, written atomically (Hard Rule #3).
//!
//! `tauri dev` runs with the installed app's identifier (`com.mbadv.ply`), so
//! it shares its config dir. Debug builds therefore use their own file
//! (`account.dev.json`) and keychain service (`com.mbadv.ply.account.dev`):
//! a dev run never reads, replaces or signs out the installed app's account.
//! A debug run that skips the Sign-in screen (`PLYLOFT_DEV_SKIP_SIGNIN=1`,
//! the app tester's Plyloft Test) has no real session to keep, so it never
//! opens the keychain at all ([`DevSkipSecrets`]): each read used to ask the
//! owner for the login keychain password, once per launch and focus.
//!
//! [`AccountInfo`] is the single policy source the later gate cards (G1–G3)
//! read. Nothing here changes the existing licence gates (`license.rs`).
//!
//! **Refresh** ([`AccountStore::refresh_at`]): at launch, every 6 h
//! ([`start_refresher`], a thread that stops on exit — Hard Rule #4) and on
//! demand. `unauthorized` (signed out elsewhere) drops this profile to the
//! signed-out Free state. Both emit [`EVENT_CHANGED`]. A network failure
//! keeps the cached entitlement until its `exp` and marks the info
//! `offline`; past `exp` the plan reads as Free (card 12.2, owner D2), never
//! a lock while an account is signed in.
//!
//! **1.178.0 (A3/A5): the account is optional, and only Team is "one
//! computer at a time".** Every call to plyloft-server sends
//! [`TEAM_CHOICE_HEADER`]; a server that echoes it keeps every computer
//! signed in and signs `plan: "free"` for a computer where the account's
//! Team plan is not active, saying where it is in the unsigned `team` field
//! ([`AccountTeam`], shown only, never a gate). **Use Team on this
//! computer** ([`AccountStore::use_team_at`], `POST /session/use-team`)
//! moves it here. A `replaced` answer is no longer a state anybody sees: the
//! entitlement goes; from a server that echoes the header (a session revoked
//! before its deploy) the session is taken back silently with `POST
//! /session/reclaim` (owner D3); from an older server (a rollback) the
//! account stays signed in on Free, with no reclaim
//! (`AccountStore::on_replaced`).
//!
//! **Keychain reads are rare on purpose.** `account.json` records *that* a
//! session exists (`account: {sub, login}`); the token itself is read only
//! when a request needs it (refresh, sign-out). So `account_get` never
//! touches the keychain and never raises a macOS keychain prompt.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

// ── Build constants ─────────────────────────────────────────────────

/// The public client id of the `Plyloft` GitHub OAuth App (Device Flow on).
/// Public by design: the Device Flow has no client secret in the app.
///
/// The `Plyloft` app on the MatteoB-adv account (2026-10-02). Debug builds read
/// `PLYLOFT_GITHUB_CLIENT_ID` (the `Plyloft Dev` app) first.
pub const PLYLOFT_GITHUB_CLIENT_ID: &str = "Ov23li0sWJmBCyZlMqo3";

/// Public half of the PLY2 entitlement keypair (32 bytes, hex). The private
/// half lives only in plyloft-server's environment (1Password backup).
///
/// Production key, generated 2026-10-02. NEVER rotate casually — every
/// entitlement already issued dies with it, and installed apps only learn a
/// new key from an update. Debug builds read `PLYLOFT_ENTITLEMENT_PUBKEY` (hex)
/// first, so staging runs on the dev key.
const ENTITLEMENT_PUBKEY_HEX: &str =
    "231473ad8d61037dd16589a47f1f94b0434625d7960b1590c12dc2a8b73b522f";

#[cfg_attr(debug_assertions, allow(dead_code))]
const RELEASE_API_BASE: &str = "https://api.plyloft.com/v1";
#[cfg(debug_assertions)]
const DEV_API_BASE: &str = "http://localhost:8787/v1";
const GITHUB_BASE: &str = "https://github.com";

pub const ENTITLEMENT_PREFIX: &str = "PLY2-";
const ENTITLEMENT_VERSION: u32 = 2;

/// Refresh cadence (LAUNCH_PLAN §3.2), measured on the wall clock so a Mac
/// that slept through it refreshes when it wakes.
pub const REFRESH_EVERY_MS: i64 = 6 * 60 * 60 * 1000;
/// After a failed (offline) refresh, the next try comes sooner.
pub const OFFLINE_RETRY_MS: i64 = 30 * 60 * 1000;
/// How often the refresher looks at the wall clock.
const REFRESHER_TICK: Duration = Duration::from_secs(60);
/// Launch A3: the main window coming to the front asks the server again (a
/// plan bought on the site shows up on return), but at most this often —
/// counted from the last time any refresh asked, so focus events, several
/// windows and a "Check now" just before can't add up to a burst.
pub const FOCUS_REFRESH_MIN_MS: i64 = 60 * 1000;

const ACCOUNT_SCHEMA_VERSION: u32 = 1;
const ACCOUNT_FILE_RELEASE: &str = "account.json";
const ACCOUNT_FILE_DEV: &str = "account.dev.json";
const KEYRING_SERVICE_RELEASE: &str = "com.mbadv.ply.account";
const KEYRING_SERVICE_DEV: &str = "com.mbadv.ply.account.dev";
/// Debug builds keep their own account (see the module doc).
const ACCOUNT_FILE: &str = if cfg!(debug_assertions) { ACCOUNT_FILE_DEV } else { ACCOUNT_FILE_RELEASE };
const KEYRING_SERVICE: &str =
    if cfg!(debug_assertions) { KEYRING_SERVICE_DEV } else { KEYRING_SERVICE_RELEASE };

/// The service this process keeps its session under. The second person of a
/// two-member walk (dev-only) must not read the first person's session.
fn keyring_service() -> &'static str {
    #[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]
    if crate::test_bridge::is_member_instance() {
        return "com.mbadv.ply.account.dev.member";
    }
    KEYRING_SERVICE
}
/// LAUNCH_API: `deviceName` is at most 100 characters, trimmed.
const DEVICE_NAME_MAX_CHARS: usize = 100;
/// Debug builds only: the session [`AccountStore::dev_load_entitlement_at`]
/// keeps in the dev keychain. Not a token any server issued.
#[cfg(debug_assertions)]
const DEV_SESSION_PLACEHOLDER: &str = "pls_dev_placeholder";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// GitHub's own default when a device-code answer carries no interval.
const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;
/// RFC 8628 §3.5: `slow_down` adds five seconds to the interval.
const SLOW_DOWN_STEP_SECS: u64 = 5;

/// Emitted with an [`AccountInfo`] whenever the account changes.
pub const EVENT_CHANGED: &str = "account://changed";
/// Emitted with a [`SignInProgress`] while a sign-in runs.
pub const EVENT_SIGN_IN: &str = "account://sign-in";
/// 1.178.0 (A5 §4): sent on every call to plyloft-server; a server that knows
/// the Team-computer rules answers with it. An answer without it is an older
/// server: no `team` field is read from it.
pub const TEAM_CHOICE_HEADER: &str = "X-Plyloft-Team-Choice";

/// Where this build talks to.
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// plyloft-server, with the `/v1` prefix and no trailing slash.
    pub api_base: String,
    pub github_base: String,
    pub client_id: String,
}

impl Endpoints {
    /// Release builds: production, fixed. Debug builds: `PLYLOFT_API_URL`
    /// (default local) and `PLYLOFT_GITHUB_CLIENT_ID` (default the constant).
    pub fn for_build() -> Self {
        #[cfg(debug_assertions)]
        {
            Self {
                api_base: trim_base(&env_nonempty("PLYLOFT_API_URL").unwrap_or_else(|| DEV_API_BASE.into())),
                github_base: GITHUB_BASE.into(),
                client_id: env_nonempty("PLYLOFT_GITHUB_CLIENT_ID")
                    .unwrap_or_else(|| PLYLOFT_GITHUB_CLIENT_ID.into()),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            Self {
                api_base: RELEASE_API_BASE.into(),
                github_base: GITHUB_BASE.into(),
                client_id: PLYLOFT_GITHUB_CLIENT_ID.into(),
            }
        }
    }
}

/// Launch A2: debug builds only — `PLYLOFT_DEV_SKIP_SIGNIN=1` lets a dev run
/// (and the app tester's walks in Plyloft Test) past the Sign-in screen
/// without an account. It changes no plan: the gates still read Free.
pub const DEV_SKIP_SIGNIN_ENV: &str = "PLYLOFT_DEV_SKIP_SIGNIN";

/// Whether this run may skip the Sign-in screen. Release builds: never — the
/// variable is not even read there.
pub fn dev_skip_sign_in() -> bool {
    #[cfg(debug_assertions)]
    {
        dev_skip_from(env_nonempty)
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// The skip, from a reader of the environment (tests pass their own, so no
/// test mutates the process environment).
#[cfg(debug_assertions)]
fn dev_skip_from(read: impl Fn(&str) -> Option<String>) -> bool {
    skip_value_allows(read(DEV_SKIP_SIGNIN_ENV).as_deref())
}

/// Only the exact value `1` skips (`0`, `true`, anything else does not).
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn skip_value_allows(value: Option<&str>) -> bool {
    value == Some("1")
}

#[cfg(debug_assertions)]
fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn trim_base(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

/// The entitlement key this build trusts. Debug builds may override it with
/// `PLYLOFT_ENTITLEMENT_PUBKEY`; release builds may not (LAUNCH_API).
fn build_pubkey() -> Result<VerifyingKey, String> {
    #[cfg(debug_assertions)]
    if let Some(hex) = env_nonempty("PLYLOFT_ENTITLEMENT_PUBKEY") {
        return parse_pubkey_hex(&hex);
    }
    if ENTITLEMENT_PUBKEY_HEX.is_empty() {
        return Err("This build has no entitlement key yet.".into());
    }
    parse_pubkey_hex(ENTITLEMENT_PUBKEY_HEX)
}

fn parse_pubkey_hex(hex: &str) -> Result<VerifyingKey, String> {
    let bytes = crate::license::hex_decode(hex.trim())
        .ok_or_else(|| "entitlement key is not valid hex".to_string())?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "entitlement key must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("bad entitlement key: {e}"))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── Errors ──────────────────────────────────────────────────────────

/// What went wrong, as the frontend receives it: `{code, message}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The server or GitHub could not be reached.
    Network,
    /// This build lacks the client id or the entitlement key.
    NotConfigured,
    BadRequest,
    GithubTokenInvalid,
    Unauthorized,
    Replaced,
    Forbidden,
    SeatLimit,
    SeatInUse,
    NotFound,
    RateLimited,
    /// `POST /checkout`: a paid subscription is already running (one per
    /// account). Launch T1.
    AlreadySubscribed,
    /// `POST /team`: the team is bound to another repository. Launch T1.
    AlreadyBound,
    /// 1.178.0: `POST /session/use-team` on an account with no Team plan now.
    NoTeam,
    /// Any other server answer (5xx, an unknown code, an unreadable body).
    Server,
    /// The server's entitlement failed verification.
    BadEntitlement,
    /// The OS keychain refused a read or a write.
    Keychain,
    /// Device Flow: the code expired before the person entered it.
    ExpiredToken,
    /// Device Flow: the person declined on github.com.
    AccessDenied,
    /// Device Flow: any other GitHub refusal (`device_flow_disabled`, …).
    DeviceFlow,
    Cancelled,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountError {
    pub code: ErrorCode,
    pub message: String,
    /// `replaced` only: the device that took the plan (LAUNCH_API 409 body).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// `replaced` only (QoL 12.1): whether `POST /session/reclaim` could take
    /// the plan back. `Some(false)`: sign out ("Sign in here"), as 1.167
    /// did. `None` (an older server): try.
    #[serde(skip)]
    pub reclaimable: Option<bool>,
    /// A Stripe invoice page the refusal points to (a switch to Team waiting
    /// for its payment); only `https://invoice.stripe.com/…` is ever kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl AccountError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), device_name: None, reclaimable: None, url: None }
    }

    fn network(detail: impl std::fmt::Display) -> Self {
        log::info!("account: network error: {detail}");
        Self::new(ErrorCode::Network, "Plyloft couldn't reach its server. Check the connection and try again.")
    }

    /// Worth keeping the cached entitlement for: the server may be fine a
    /// moment later.
    fn is_transient(&self) -> bool {
        matches!(self.code, ErrorCode::Network | ErrorCode::Server | ErrorCode::RateLimited)
    }
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Map a non-2xx plyloft-server answer (`{error, message}`) to a typed error.
fn server_error(resp: &HttpResponse) -> AccountError {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Body {
        error: Option<String>,
        message: Option<String>,
        device_name: Option<String>,
        reclaimable: Option<bool>,
        url: Option<String>,
    }
    let body: Option<Body> = serde_json::from_str(&resp.body).ok();
    let reclaimable = body.as_ref().and_then(|b| b.reclaimable);
    let url = body
        .as_ref()
        .and_then(|b| b.url.as_deref())
        .filter(|u| crate::billing_client::is_invoice_page(u))
        .map(|u| u.trim().to_string());
    let code_str = body.as_ref().and_then(|b| b.error.clone()).unwrap_or_default();
    let device_name = body
        .as_ref()
        .and_then(|b| b.device_name.as_deref())
        .map(clean_device_name)
        .filter(|n| !n.is_empty());
    let message = body
        .and_then(|b| b.message)
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| format!("The Plyloft server answered {}.", resp.status));
    let code = match code_str.as_str() {
        "bad_request" => ErrorCode::BadRequest,
        "github_token_invalid" => ErrorCode::GithubTokenInvalid,
        "unauthorized" => ErrorCode::Unauthorized,
        "replaced" => ErrorCode::Replaced,
        "forbidden" => ErrorCode::Forbidden,
        "seat_limit" => ErrorCode::SeatLimit,
        "seat_in_use" => ErrorCode::SeatInUse,
        "not_found" => ErrorCode::NotFound,
        "rate_limited" => ErrorCode::RateLimited,
        "already_subscribed" => ErrorCode::AlreadySubscribed,
        "already_bound" => ErrorCode::AlreadyBound,
        "no_team" => ErrorCode::NoTeam,
        // Only an explicit `unauthorized` ends a session: a bare 401 (a proxy,
        // a captive portal) is treated like any other server failure.
        _ => match resp.status {
            429 => ErrorCode::RateLimited,
            _ => ErrorCode::Server,
        },
    };
    AccountError { device_name, reclaimable, url, ..AccountError::new(code, message) }
}

// ── HTTP (injectable) ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
}

#[derive(Clone, PartialEq)]
pub enum Body {
    None,
    Json(serde_json::Value),
    Form(Vec<(&'static str, String)>),
}

/// One request. No `Debug`: it carries tokens, and nothing may log them.
#[derive(Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub bearer: Option<String>,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    /// 1.178.0: the answer carried `X-Plyloft-Team-Choice: 1`
    /// ([`TEAM_CHOICE_HEADER`]), so it came from a server that knows the
    /// Team-computer rules. Any other answer (GitHub, the site, an older
    /// server) says false.
    pub team_choice: bool,
}

impl HttpResponse {
    /// An answer without [`TEAM_CHOICE_HEADER`].
    pub fn new(status: u16, body: impl Into<String>) -> Self {
        Self { status, body: body.into(), team_choice: false }
    }

    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The network, behind a trait so tests never touch it. `Err` is a transport
/// failure (no answer at all); any HTTP status is an `Ok`.
pub trait Http: Send + Sync {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String>;
}

/// The product's HTTP: `reqwest`'s blocking client over rustls (the same TLS
/// stack the updater uses). Always called off the main thread and outside any
/// async task (`spawn_blocking` or a plain thread).
pub struct ReqwestHttp;

fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

impl Http for ReqwestHttp {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String> {
        // One client for the app's life, in a static: it is never dropped,
        // so its runtime thread never ends inside an async context.
        static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                ensure_crypto_provider();
                let built = reqwest::blocking::Client::builder()
                    .timeout(HTTP_TIMEOUT)
                    .user_agent(concat!("Plyloft/", env!("CARGO_PKG_VERSION")))
                    .build()
                    .map_err(|e| format!("http client: {e}"))?;
                CLIENT.get_or_init(|| built)
            }
        };
        let mut rb = match req.method {
            Method::Get => client.get(&req.url),
            Method::Post => client.post(&req.url),
            Method::Put => client.put(&req.url),
            Method::Delete => client.delete(&req.url),
        };
        rb = rb.header("Accept", "application/json");
        if let Some(token) = &req.bearer {
            rb = rb.bearer_auth(token);
        }
        for (name, value) in &req.headers {
            rb = rb.header(*name, value);
        }
        rb = match &req.body {
            Body::None => rb,
            Body::Json(v) => rb
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(v).map_err(|e| format!("encode: {e}"))?),
            Body::Form(pairs) => rb
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(form_encode(pairs)),
        };
        // `without_url`: reqwest's error text otherwise repeats the URL.
        let resp = rb.send().map_err(|e| e.without_url().to_string())?;
        let status = resp.status().as_u16();
        let team_choice = resp
            .headers()
            .get(TEAM_CHOICE_HEADER)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim() == "1");
        let body = resp.text().unwrap_or_default();
        Ok(HttpResponse { status, body, team_choice })
    }
}

/// `application/x-www-form-urlencoded` for the device-flow bodies.
fn form_encode(pairs: &[(&'static str, String)]) -> String {
    fn enc(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

// ── Secrets (injectable) ────────────────────────────────────────────

/// Where the session token lives. `account` is the profile's `deviceId`.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// macOS Keychain / Windows Credential Manager through the `keyring` crate.
pub struct KeyringSecrets;

impl SecretStore for KeyringSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(keyring_service(), account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(keyring_service(), account).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(keyring_service(), account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// A run that skips the Sign-in screen (debug builds only) signs nobody in,
/// so its only session is the dev placeholder [`AccountStore::dev_load_entitlement_at`]
/// stores: that answer needs no keychain. Every other run uses the keychain.
fn product_secrets() -> Box<dyn SecretStore> {
    #[cfg(debug_assertions)]
    if dev_skip_sign_in() {
        return Box::new(DevSkipSecrets);
    }
    Box::new(KeyringSecrets)
}

/// Debug builds, `PLYLOFT_DEV_SKIP_SIGNIN=1`: the placeholder session without
/// the keychain. A profile with no account never asks (refresh returns
/// first), and one with a dev-loaded entitlement gets the placeholder it was
/// given; nothing is written or removed.
#[cfg(debug_assertions)]
pub struct DevSkipSecrets;

#[cfg(debug_assertions)]
impl SecretStore for DevSkipSecrets {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(Some(DEV_SESSION_PLACEHOLDER.to_string()))
    }

    fn set(&self, _account: &str, _secret: &str) -> Result<(), String> {
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

// ── PLY2 entitlement ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    #[default]
    Free,
    /// Old entitlements and comps still say `pro`: it reads and verifies as
    /// before, and grants nothing more than Free (only Team is paid).
    Pro,
    Team,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamRole {
    Owner,
    Member,
}

/// The signed payload (LAUNCH_API § Entitlement token).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementPayload {
    pub v: u32,
    pub sub: String,
    pub login: String,
    pub plan: Plan,
    #[serde(default)]
    pub team_repo: Option<String>,
    #[serde(default)]
    pub team_role: Option<TeamRole>,
    pub device_id: String,
    pub iat: i64,
    pub exp: i64,
    #[serde(default)]
    pub period_end: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub comp: bool,
    /// Launch A3: the paid subscription won't renew (cancelled in the Portal).
    /// Optional: older tokens lack it.
    #[serde(default)]
    pub cancel_at_period_end: bool,
}

/// Verify a `PLY2-` token: prefix, base64url **without padding**, Ed25519
/// `verify_strict` over the exact payload bytes, `v == 2`, this device, and
/// `now < exp`. Tests inject their own key; the product passes
/// [`build_pubkey`]'s.
pub fn verify_entitlement_with(
    token: &str,
    pubkey: &VerifyingKey,
    device_id: &str,
    now_ms: i64,
) -> Result<EntitlementPayload, String> {
    let body = token
        .trim()
        .strip_prefix(ENTITLEMENT_PREFIX)
        .ok_or_else(|| format!("not an entitlement (expected {ENTITLEMENT_PREFIX}…)"))?;
    if body.contains('=') {
        return Err("entitlement is padded base64".into());
    }
    let (payload_b64, sig_b64) = body
        .split_once('.')
        .ok_or_else(|| "entitlement has no signature part".to_string())?;
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "entitlement payload is not base64url".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "entitlement signature is not base64url".to_string())?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "entitlement signature must be 64 bytes".to_string())?;
    pubkey
        .verify_strict(&payload_bytes, &Signature::from_bytes(&sig_arr))
        .map_err(|_| "entitlement signature check failed".to_string())?;
    let payload: EntitlementPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|e| format!("entitlement payload unreadable: {e}"))?;
    if payload.v != ENTITLEMENT_VERSION {
        return Err(format!("entitlement version {} is not {ENTITLEMENT_VERSION}", payload.v));
    }
    if payload.device_id != device_id {
        return Err("entitlement was issued to another device".into());
    }
    if now_ms >= payload.exp {
        return Err("entitlement expired".into());
    }
    Ok(payload)
}

/// 1.175.0 (E-app, contract §6a): the plan the server just sent was refused
/// because this computer's clock is off, not because of the plan.
const CLOCK_OFF: &str = concat!(
    "Plyloft couldn't verify the plan the server sent: the date and time on ",
    crate::this_machine!(),
    " look wrong. Check them, then try again."
);

/// How far this computer's clock may be from the server's before a token
/// that just arrived is read as a clock that is off.
const CLOCK_SKEW_MS: i64 = 10 * 60 * 1000;

/// A token the server **just** sent (only ever asked of a server answer,
/// never of the token kept here, which ages normally) that is already past
/// its `exp` was signed at `iat` by the server's clock: when this computer's
/// clock is more than [`CLOCK_SKEW_MS`] from that `iat`, the clock is the
/// cause. Paid tokens last at most 14 days from 1.175.0 (SRV-1), so a clock
/// two weeks ahead refused every one with a sentence that didn't name it.
/// Only the sentence depends on this: the token is refused either way. The
/// payload is read unverified, for the words alone.
fn clock_is_off(token: &str, now_ms: i64) -> bool {
    let payload = token
        .trim()
        .strip_prefix(ENTITLEMENT_PREFIX)
        .and_then(|body| body.split_once('.'))
        .and_then(|(payload, _)| URL_SAFE_NO_PAD.decode(payload).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let Some(payload) = payload else { return false };
    let (Some(iat), Some(exp)) = (payload["iat"].as_i64(), payload["exp"].as_i64()) else { return false };
    now_ms >= exp && (now_ms - iat).abs() > CLOCK_SKEW_MS
}

// ── Device flow ─────────────────────────────────────────────────────

/// GitHub's answer to `POST /login/device/code`.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub expires_in: u64,
    #[serde(default)]
    pub interval: u64,
}

/// What `account_sign_in_start` returns: what the person types, and where.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInStart {
    /// This sign-in's id; every [`SignInEvent`] of it carries the same one.
    pub attempt: u64,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

/// Progress of a running sign-in ([`EVENT_SIGN_IN`]).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SignInProgress {
    /// Waiting for the person to enter the code on github.com.
    Waiting { interval_secs: u64 },
    /// GitHub asked to poll more slowly.
    SlowDown { interval_secs: u64 },
    /// GitHub said yes; the Plyloft server is creating the session.
    Verifying,
    SignedIn { info: AccountInfo },
    Failed { error: AccountError },
    Cancelled,
}

/// What goes out on [`EVENT_SIGN_IN`]: the progress, tagged with its attempt,
/// so a superseded sign-in's late `cancelled` never touches the new one.
#[derive(Debug, Clone, Serialize)]
pub struct SignInEvent {
    pub attempt: u64,
    #[serde(flatten)]
    pub progress: SignInProgress,
}

#[derive(Deserialize)]
struct GithubOAuthError {
    error: Option<String>,
    error_description: Option<String>,
}

/// `POST {github}/login/device/code` with the client id and **no scope**.
pub fn request_device_code(http: &dyn Http, ep: &Endpoints) -> Result<DeviceCode, AccountError> {
    if ep.client_id.trim().is_empty() {
        return Err(AccountError::new(
            ErrorCode::NotConfigured,
            "This build of Plyloft can't sign in to GitHub yet.",
        ));
    }
    let req = HttpRequest {
        method: Method::Post,
        url: format!("{}/login/device/code", ep.github_base),
        bearer: None,
        headers: vec![],
        body: Body::Form(vec![("client_id", ep.client_id.clone())]),
    };
    let resp = http.send(&req).map_err(AccountError::network)?;
    if let Ok(code) = serde_json::from_str::<DeviceCode>(&resp.body) {
        if resp.ok() {
            return Ok(code);
        }
    }
    Err(github_refusal(&resp))
}

fn github_refusal(resp: &HttpResponse) -> AccountError {
    let err: Option<GithubOAuthError> = serde_json::from_str(&resp.body).ok();
    let (code, desc) = err
        .map(|e| (e.error.unwrap_or_default(), e.error_description))
        .unwrap_or_default();
    if resp.status >= 500 || (code.is_empty() && !resp.ok()) {
        return AccountError::new(ErrorCode::Network, format!("GitHub answered {}. Try again in a moment.", resp.status));
    }
    AccountError::new(
        ErrorCode::DeviceFlow,
        desc.filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| format!("GitHub refused the sign-in ({code}).")),
    )
}

/// Poll `POST {github}/login/oauth/access_token` until the person answers.
///
/// `wait(d)` sleeps for `d` and returns `false` when the sign-in was cancelled
/// (or the app is quitting). Honors `interval`, `authorization_pending`,
/// `slow_down` (+5 s, or GitHub's own larger interval), `expired_token`,
/// `access_denied`, and the code's `expires_in`. A transport failure while
/// polling is retried until the code expires.
pub fn poll_for_token(
    http: &dyn Http,
    ep: &Endpoints,
    code: &DeviceCode,
    wait: &mut dyn FnMut(Duration) -> bool,
    progress: &mut dyn FnMut(SignInProgress),
) -> Result<String, AccountError> {
    #[derive(Deserialize)]
    struct TokenAnswer {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
        interval: Option<u64>,
    }
    let mut interval = if code.interval == 0 { DEFAULT_POLL_INTERVAL_SECS } else { code.interval };
    // 0 = GitHub gave no lifetime; its codes last 15 minutes.
    let lifetime = if code.expires_in == 0 { 900 } else { code.expires_in };
    let mut waited: u64 = 0;
    progress(SignInProgress::Waiting { interval_secs: interval });
    let req = HttpRequest {
        method: Method::Post,
        url: format!("{}/login/oauth/access_token", ep.github_base),
        bearer: None,
        headers: vec![],
        body: Body::Form(vec![
            ("client_id", ep.client_id.clone()),
            ("device_code", code.device_code.clone()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code".into()),
        ]),
    };
    let expired = || AccountError::new(ErrorCode::ExpiredToken, "The sign-in code expired. Start again for a new one.");
    loop {
        if waited >= lifetime {
            return Err(expired());
        }
        if !wait(Duration::from_secs(interval)) {
            return Err(AccountError::new(ErrorCode::Cancelled, "Sign-in cancelled."));
        }
        waited += interval;
        let resp = match http.send(&req) {
            Ok(resp) => resp,
            Err(e) => {
                log::info!("account: device-flow poll failed, retrying: {e}");
                continue;
            }
        };
        let answer: TokenAnswer = match serde_json::from_str(&resp.body) {
            Ok(a) => a,
            Err(_) if resp.status >= 500 || resp.status == 429 => continue,
            Err(_) => return Err(github_refusal(&resp)),
        };
        if let Some(token) = answer.access_token.filter(|t| !t.is_empty()) {
            return Ok(token);
        }
        match answer.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                interval = answer.interval.unwrap_or(0).max(interval + SLOW_DOWN_STEP_SECS);
                progress(SignInProgress::SlowDown { interval_secs: interval });
            }
            Some("expired_token") => return Err(expired()),
            Some("access_denied") => {
                return Err(AccountError::new(ErrorCode::AccessDenied, "The sign-in was declined on GitHub."))
            }
            other => {
                return Err(AccountError::new(
                    ErrorCode::DeviceFlow,
                    answer
                        .error_description
                        .filter(|d| !d.trim().is_empty())
                        .unwrap_or_else(|| format!("GitHub refused the sign-in ({}).", other.unwrap_or("no answer"))),
                ))
            }
        }
    }
}

// ── Server calls ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub sub: String,
    pub login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionAnswer {
    session_token: String,
    entitlement: String,
    account: AccountIdentity,
    /// 1.178.0: the unsigned `team` field (A5 §5), read leniently.
    #[serde(default)]
    team: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct EntitlementAnswer {
    entitlement: String,
    #[serde(default)]
    team: Option<serde_json::Value>,
}

/// 1.178.0: where the account's Team plan is active, as the server's last
/// answer said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamState {
    /// Active on this computer.
    Here,
    /// Active on another computer ([`AccountTeam::device`]).
    Elsewhere,
    /// Active on none yet: ready for **Use Team on this computer**.
    Nowhere,
}

/// 1.178.0 (A5 §5): the account's Team plan or seat as the server's unsigned
/// `team` field describes it. For notices and the **Use Team on this
/// computer** button only: no gate ever opens on it (the signed `plan` alone
/// decides). Persisted in `account.json` so the notice survives a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTeam {
    pub state: TeamState,
    /// `elsewhere` only: the generic label of the computer holding Team
    /// ("MacBook Pro", "Windows PC"), never its own name.
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub team_repo: Option<String>,
    #[serde(default)]
    pub role: Option<TeamRole>,
}

/// The server's `team` field (`{active, teamRepo, teamRole, device: {name,
/// platform, lastSeen} | null}`) as [`AccountTeam`]. Anything unreadable, an
/// unknown `active`, or `null` reads as no team.
fn team_of(value: Option<&serde_json::Value>) -> Option<AccountTeam> {
    let obj = value?.as_object()?;
    let state = match obj.get("active")?.as_str()? {
        "here" => TeamState::Here,
        "elsewhere" => TeamState::Elsewhere,
        "nowhere" => TeamState::Nowhere,
        _ => return None,
    };
    let text = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    };
    let device = match state {
        TeamState::Elsewhere => text(obj.get("device").and_then(|d| d.get("name")))
            .map(|n| clean_device_name(&n))
            .filter(|n| !n.is_empty()),
        TeamState::Here | TeamState::Nowhere => None,
    };
    let role = obj
        .get("teamRole")
        .and_then(|v| serde_json::from_value::<TeamRole>(v.clone()).ok());
    Some(AccountTeam { state, device, team_repo: text(obj.get("teamRepo")), role })
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

// ── Persisted state ─────────────────────────────────────────────────

/// `<config_dir>/account.json`. Every field is optional on read; see
/// [`parse_account_file`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountFile {
    schema_version: u32,
    /// Random, generated once per profile. Keys the keychain entry and is
    /// sent with every session request.
    device_id: String,
    device_name: Option<String>,
    /// Present exactly while a session token is in the keychain.
    account: Option<AccountIdentity>,
    /// The last verified `PLY2-` token.
    entitlement: Option<String>,
    /// The last time the server answered (ms).
    last_checked_at: Option<i64>,
    /// 1.178.0: the plan of the last verified entitlement, kept when that
    /// entitlement expires or goes (offline, a `replaced` answer), so the
    /// "plan not checked" notices show only when it was Team. Gone at
    /// sign-out. Absent in files before 1.178.0 (read from the cached token).
    last_known_plan: Option<Plan>,
    /// 1.178.0: the server's last `team` field ([`AccountTeam`]). Absent in
    /// files before 1.178.0. (The `replacedBy` of 1.167–1.177 is read past
    /// and no longer written.)
    team: Option<AccountTeam>,
}

/// Read what can be read. A missing, partial, older or corrupt file never
/// panics: each field is taken when it has the right type, and a missing
/// `deviceId` is generated. Returns whether the file needs writing back.
fn parse_account_file(text: Option<&str>) -> (AccountFile, bool) {
    let value: Option<serde_json::Value> = text.and_then(|t| serde_json::from_str(t).ok());
    let obj = value.as_ref().and_then(|v| v.as_object());
    let str_field = |k: &str| {
        obj.and_then(|o| o.get(k))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };
    let device_id = str_field("deviceId").filter(|id| valid_device_id(id));
    let account = obj
        .and_then(|o| o.get("account"))
        .and_then(|v| serde_json::from_value::<AccountIdentity>(v.clone()).ok());
    let file = AccountFile {
        schema_version: ACCOUNT_SCHEMA_VERSION,
        device_id: device_id.clone().unwrap_or_else(new_device_id),
        device_name: str_field("deviceName"),
        account,
        entitlement: str_field("entitlement"),
        last_checked_at: obj.and_then(|o| o.get("lastCheckedAt")).and_then(|v| v.as_i64()),
        last_known_plan: obj
            .and_then(|o| o.get("lastKnownPlan"))
            .and_then(|v| serde_json::from_value::<Plan>(v.clone()).ok()),
        team: obj
            .and_then(|o| o.get("team"))
            .and_then(|v| serde_json::from_value::<AccountTeam>(v.clone()).ok()),
    };
    let schema = obj
        .and_then(|o| o.get("schemaVersion"))
        .and_then(|v| v.as_u64());
    // 1.178.0: a 1.167–1.177 file's `replacedBy` is no state any more; the
    // file is written back without it.
    let legacy_replaced = obj.is_some_and(|o| o.contains_key("replacedBy"));
    let needs_save = device_id.is_none() || schema != Some(ACCOUNT_SCHEMA_VERSION as u64) || legacy_replaced;
    (file, needs_save)
}

/// LAUNCH_API: `^[0-9a-f]{32}$`.
fn valid_device_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Trimmed, at most [`DEVICE_NAME_MAX_CHARS`] characters (cut on a char
/// boundary), trimmed again.
fn clean_device_name(name: &str) -> String {
    name.trim().chars().take(DEVICE_NAME_MAX_CHARS).collect::<String>().trim().to_string()
}

fn new_device_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// This computer's name, as the person sees it (the server shows it to the
/// device that gets replaced: "Your plan moved to <name>.").
fn device_name() -> String {
    // 1.174.0 (E12 round 1): the bounded read (`device_claim::READ_LIMIT`).
    #[cfg(target_os = "macos")]
    {
        let name = crate::device_claim::read_computer_name();
        if name.is_empty() { "Mac".into() } else { name }
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME")
            .ok()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| "Windows PC".into())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        "Computer".into()
    }
}

/// 1.173.0 (C3, C2): the one name this computer goes by on anything another
/// computer reads — a shared-config commit's trailer, a card's claim marker,
/// and (1.175.0) the `deviceName` of a sign-in: `PLYLOFT_DEVICE_NAME` when
/// set (two test profiles on one Mac walk as two computers), else
/// [`model_label`] of `raw` for this platform.
pub(crate) fn shared_name_of(raw: &str) -> String {
    if let Some(named) = std::env::var("PLYLOFT_DEVICE_NAME").ok().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        return clean_device_name(&named);
    }
    model_label(raw, platform_name())
}

/// 1.173.0 (C3): this computer's [`shared_name_of`] — the name kept in the
/// local settings (`device_claim::this_device`, C2) when it is known, else
/// the system's, read once. `None` when the system gives no name of its own.
pub(crate) fn shared_device_name() -> Option<String> {
    if let Some(device) = crate::device_claim::this_device().filter(|d| !d.name.trim().is_empty()) {
        return Some(shared_name_of(&device.name)).filter(|n| !n.is_empty());
    }
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        let name = device_name();
        let generic = ["Mac", "Windows PC", "Computer"].contains(&name.as_str());
        let forced = std::env::var("PLYLOFT_DEVICE_NAME").is_ok_and(|n| !n.trim().is_empty());
        if generic && !forced {
            return None;
        }
        Some(shared_name_of(&name)).filter(|n| !n.is_empty())
    })
    .clone()
}

/// 1.175.0 (E-app round 2; owner 2026-11-09, SRV-4): what of a computer's
/// name may leave it — the Mac model the name contains, nothing else. The
/// same rule as the server's label, so what a teammate reads on a shared
/// issue or a commit is never the computer's own name (which is often its
/// owner's, or anything the owner typed). The model is found whatever the
/// case, with spaces, dashes, dots or nothing between its words, the
/// longest first ("Matteo's MacBook Pro (2)", "MacBook-Pro-di-Matteo",
/// "matteos-MacBook-Pro.local" → "MacBook Pro"); a name with no model is
/// the platform's word: "Mac", "Windows PC", "Computer". Until 1.175.0 the
/// rule cut an owner it recognised and sent the rest, so "Studio di
/// Marta" or "Matteo" went out whole.
pub(crate) fn model_label(raw: &str, platform: &str) -> String {
    const MODELS: &[(&str, &str)] = &[
        ("macbookpro", "MacBook Pro"),
        ("macbookair", "MacBook Air"),
        ("macstudio", "Mac Studio"),
        ("macmini", "Mac mini"),
        ("macpro", "Mac Pro"),
        ("macbook", "MacBook"),
        ("imac", "iMac"),
    ];
    let compact: String = raw.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect();
    if let Some((_, label)) = MODELS.iter().find(|(key, _)| compact.contains(key)) {
        return (*label).to_string();
    }
    match platform {
        "macos" => "Mac",
        "windows" => "Windows PC",
        _ => "Computer",
    }
    .to_string()
}

/// 1.175.0 (E3, SRV-4; owner 2026-11-09): the name a sign-in sends as
/// `deviceName` — never the computer's own: [`shared_name_of`], the model
/// or the platform's word, never empty (a server older than 1.175.0
/// refuses a sign-in without it). The server keeps its own generic label
/// either way; the full name stays on this computer ("This device").
fn sent_device_name(raw: &str, platform: &str) -> String {
    if std::env::var("PLYLOFT_DEVICE_NAME").is_ok_and(|n| !n.trim().is_empty()) {
        return shared_name_of(raw);
    }
    model_label(raw, platform)
}

// ── AccountInfo ─────────────────────────────────────────────────────

/// The account as every reader sees it: the frontend, and later the plan
/// gates (G1–G3). Derived here; nobody re-derives the policy.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    /// A session exists on this profile.
    pub signed_in: bool,
    pub login: Option<String>,
    pub sub: Option<String>,
    /// `free` whenever there is no verified, unexpired entitlement.
    pub plan: Plan,
    pub team_repo: Option<String>,
    pub team_role: Option<TeamRole>,
    /// The Stripe status that produced the plan (`past_due` = payment problem).
    pub status: Option<String>,
    pub period_end: Option<i64>,
    /// Launch A3: the subscription ends at `period_end` instead of renewing.
    pub cancel_at_period_end: bool,
    /// The entitlement's expiry; `None` without a valid one.
    pub exp: Option<i64>,
    pub comp: bool,
    /// A verified, unexpired entitlement is in hand (D1: without one the
    /// app waits for sign-in).
    pub entitlement_valid: bool,
    pub last_checked_at: Option<i64>,
    /// The last refresh could not reach the server; the cached entitlement
    /// stands until `exp`.
    pub offline: bool,
    pub device_name: Option<String>,
    /// 1.178.0: the plan of the last verified entitlement, also once it
    /// expired or went (`None` signed out, or before any verified plan). The
    /// offline and "plan not checked" notices show only when it is Team.
    pub last_known_plan: Option<Plan>,
    /// 1.178.0: the account's Team plan or seat and where it is active, from
    /// the server's unsigned `team` field. `None` signed out, without a Team
    /// plan or seat, or from an older server. Never opens a gate.
    pub team: Option<AccountTeam>,
}

impl AccountInfo {
    /// No session, no entitlement: Free. What a reader without an account
    /// store (a narrow test app, a read-only proof) sees.
    pub fn signed_out() -> Self {
        info_of_file(&AccountFile::default(), None, false, 0)
    }
}

/// The account as `file` has it at `now`, the entitlement verified with
/// `pubkey` (none: everything reads as Free).
fn info_of_file(file: &AccountFile, pubkey: Option<&VerifyingKey>, offline: bool, now: i64) -> AccountInfo {
    let mut info = AccountInfo {
        signed_in: false,
        login: None,
        sub: None,
        plan: Plan::Free,
        team_repo: None,
        team_role: None,
        status: None,
        period_end: None,
        cancel_at_period_end: false,
        exp: None,
        comp: false,
        entitlement_valid: false,
        last_checked_at: file.last_checked_at,
        offline,
        device_name: file.device_name.clone(),
        last_known_plan: None,
        team: None,
    };
    let Some(account) = file.account.clone() else {
        info.offline = false;
        return info;
    };
    info.signed_in = true;
    info.login = Some(account.login);
    info.sub = Some(account.sub);
    info.team = file.team.clone();
    let verified = match (pubkey, file.entitlement.as_deref()) {
        (Some(key), Some(token)) => verify_entitlement_with(token, key, &file.device_id, now).ok(),
        _ => None,
    };
    // A file from before 1.178.0 has no `lastKnownPlan`: its cached token,
    // verified but read past its `exp`, says it.
    info.last_known_plan = match (&verified, file.last_known_plan) {
        (Some(p), _) => Some(p.plan),
        (None, Some(plan)) => Some(plan),
        (None, None) => match (pubkey, file.entitlement.as_deref()) {
            (Some(key), Some(token)) => verify_entitlement_with(token, key, &file.device_id, i64::MIN).ok().map(|p| p.plan),
            _ => None,
        },
    };
    if let Some(p) = verified {
        // A verified Team plan runs here, whatever the last `team` field said
        // and also when an older server sent none: the frontend reads "the
        // seat is here" from `team` against either server.
        if p.plan == Plan::Team {
            info.team = Some(AccountTeam {
                state: TeamState::Here,
                device: None,
                team_repo: p.team_repo.clone(),
                role: p.team_role,
            });
        }
        info.login = Some(p.login);
        info.sub = Some(p.sub);
        info.plan = p.plan;
        info.team_repo = p.team_repo;
        info.team_role = p.team_role;
        info.status = p.status;
        info.period_end = p.period_end;
        info.cancel_at_period_end = p.cancel_at_period_end;
        info.exp = Some(p.exp);
        info.comp = p.comp;
        info.entitlement_valid = true;
    }
    info
}

/// Launch G3: the account as `<config_dir>`'s file has it, read without
/// writing anything (no device id is generated, no keychain is read) — for
/// readers outside the app, such as the Inbox eligibility proof.
pub fn read_only_info(config_dir: &std::path::Path, now: i64) -> AccountInfo {
    let text = std::fs::read_to_string(config_dir.join(ACCOUNT_FILE)).ok();
    let (file, _) = parse_account_file(text.as_deref());
    info_of_file(&file, build_pubkey().ok().as_ref(), false, now)
}

// ── The store ───────────────────────────────────────────────────────

/// A sleep that a stop cuts short.
#[derive(Default)]
pub struct Stopper {
    stopped: Mutex<bool>,
    cv: Condvar,
}

impl Stopper {
    pub fn stop(&self) {
        *self.stopped.lock().unwrap() = true;
        self.cv.notify_all();
    }

    pub fn is_stopped(&self) -> bool {
        *self.stopped.lock().unwrap()
    }

    /// Sleep for `d`; `false` when stopped before or during it.
    pub fn wait(&self, d: Duration) -> bool {
        let guard = self.stopped.lock().unwrap();
        let (guard, _) = self.cv.wait_timeout_while(guard, d, |stopped| !*stopped).unwrap();
        !*guard
    }
}

pub struct AccountStore {
    path: PathBuf,
    file: Mutex<AccountFile>,
    offline: AtomicBool,
    http: Box<dyn Http>,
    secrets: Box<dyn SecretStore>,
    endpoints: Endpoints,
    pubkey: Result<VerifyingKey, String>,
    /// Stops the refresher and any sign-in on exit.
    app_stop: Arc<Stopper>,
    /// The running sign-in's cancel, if any.
    sign_in: Mutex<Option<Arc<Stopper>>>,
    /// The last sign-in attempt id handed out.
    attempts: std::sync::atomic::AtomicU64,
    /// Serialises the operations that talk to the server and change the
    /// session (refresh, sign-in completion, sign-out), so a refresh can't
    /// bring back a session a sign-out just ended.
    net: Mutex<()>,
    /// Launch A3: when a refresh last asked the server (any trigger) — the
    /// focus refresh's throttle ([`Self::claim_focus_refresh`]).
    last_refresh_ask: Mutex<Option<i64>>,
    /// 1.178.0: whether plyloft-server's last answer echoed
    /// [`TEAM_CHOICE_HEADER`] (`None`: no answer yet this run). In memory
    /// only: an app update or a server rollback may change it.
    team_choice: Mutex<Option<bool>>,
    /// 1.178.0 (owner D3): when a `replaced` answer last started the silent
    /// reclaim, which runs at most once per [`OFFLINE_RETRY_MS`].
    silent_reclaim_at: Mutex<Option<i64>>,
}

#[cfg(test)]
mod owns_team_tests {
    use super::{AccountInfo, Plan, TeamRole};

    #[test]
    fn only_a_team_plans_owner_owns_a_team() {
        let info = |plan, role| AccountInfo { plan, team_role: role, ..AccountInfo::signed_out() };
        assert!(info(Plan::Team, Some(TeamRole::Owner)).owns_team());
        assert!(!info(Plan::Team, Some(TeamRole::Member)).owns_team());
        assert!(!info(Plan::Team, None).owns_team());
        assert!(!info(Plan::Free, Some(TeamRole::Owner)).owns_team());
        assert!(!AccountInfo::signed_out().owns_team());
    }

    /// Wired into the work mode, for the team mode to follow the plan.
    #[test]
    fn the_work_mode_reads_it() {
        assert!(include_str!("commands.rs").contains("plan_owns_team: account.info().owns_team()"));
        assert!(include_str!("team.rs").contains("signals.plan_owns_team"));
    }
}

impl AccountInfo {
    /// U6: the verified plan says this person owns a team.
    pub fn owns_team(&self) -> bool {
        self.plan == Plan::Team && self.team_role == Some(TeamRole::Owner)
    }
}

impl AccountStore {
    /// The product store: keychain, real network, this build's endpoints/key.
    pub fn new(config_dir: PathBuf) -> Self {
        let pubkey = build_pubkey();
        if let Err(e) = &pubkey {
            log::warn!("account: {e}");
        }
        Self::with_parts(
            config_dir,
            Box::new(ReqwestHttp),
            product_secrets(),
            Endpoints::for_build(),
            pubkey,
        )
    }

    pub fn with_parts(
        config_dir: PathBuf,
        http: Box<dyn Http>,
        secrets: Box<dyn SecretStore>,
        endpoints: Endpoints,
        pubkey: Result<VerifyingKey, String>,
    ) -> Self {
        let path = config_dir.join(ACCOUNT_FILE);
        let text = std::fs::read_to_string(&path).ok();
        let (file, needs_save) = parse_account_file(text.as_deref());
        let store = Self {
            path,
            file: Mutex::new(file),
            offline: AtomicBool::new(false),
            http,
            secrets,
            endpoints,
            pubkey,
            app_stop: Arc::new(Stopper::default()),
            sign_in: Mutex::new(None),
            attempts: std::sync::atomic::AtomicU64::new(0),
            net: Mutex::new(()),
            last_refresh_ask: Mutex::new(None),
            team_choice: Mutex::new(None),
            silent_reclaim_at: Mutex::new(None),
        };
        if needs_save {
            let snapshot = store.file.lock().unwrap().clone();
            if let Err(e) = store.save(&snapshot) {
                log::warn!("account: could not write {ACCOUNT_FILE}: {e}");
            }
        }
        store
    }

    fn save(&self, file: &AccountFile) -> Result<(), String> {
        crate::atomic::write_atomic_json(&self.path, file)
    }

    /// Change the file under its lock and write it (atomically). The memory
    /// copy follows even if the disk write fails: the session is real.
    fn update(&self, f: impl FnOnce(&mut AccountFile)) {
        let mut guard = self.file.lock().unwrap();
        f(&mut guard);
        if let Err(e) = self.save(&guard) {
            log::warn!("account: could not write {ACCOUNT_FILE}: {e}");
        }
    }

    pub fn device_id(&self) -> String {
        self.file.lock().unwrap().device_id.clone()
    }

    pub fn info(&self) -> AccountInfo {
        self.info_at(now_ms())
    }

    pub fn info_at(&self, now: i64) -> AccountInfo {
        let file = self.file.lock().unwrap().clone();
        let offline = self.offline.load(Ordering::SeqCst);
        info_of_file(&file, self.pubkey.as_ref().ok(), offline, now)
    }

    fn verify(&self, token: &str, now: i64) -> Result<EntitlementPayload, AccountError> {
        let key = self
            .pubkey
            .as_ref()
            .map_err(|e| AccountError::new(ErrorCode::NotConfigured, e.clone()))?;
        verify_entitlement_with(token, key, &self.device_id(), now).map_err(|e| {
            log::warn!("account: server entitlement refused: {e}");
            let message = if e == "entitlement expired" && clock_is_off(token, now) { CLOCK_OFF } else { "Plyloft couldn't verify the plan the server sent." };
            AccountError::new(ErrorCode::BadEntitlement, message)
        })
    }

    fn api(&self, path: &str) -> String {
        format!("{}{path}", self.endpoints.api_base)
    }

    /// The headers of a call to plyloft-server for this device (A5 §4:
    /// [`TEAM_CHOICE_HEADER`] on every one).
    fn server_headers(device_id: &str) -> Vec<(&'static str, String)> {
        vec![("X-Plyloft-Device", device_id.to_string()), (TEAM_CHOICE_HEADER, "1".to_string())]
    }

    /// Note whether plyloft-server's answer echoed [`TEAM_CHOICE_HEADER`].
    fn heard(&self, resp: &HttpResponse) {
        *self.team_choice.lock().unwrap() = Some(resp.team_choice);
    }

    /// 1.178.0: whether plyloft-server's last answer this run came from a
    /// server that knows the Team-computer rules (`None`: none yet).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn server_knows_team_choice(&self) -> Option<bool> {
        *self.team_choice.lock().unwrap()
    }

    /// The answer's `team` field, read only from a server that echoed
    /// [`TEAM_CHOICE_HEADER`] (an older server has none to give).
    fn team_from(resp: &HttpResponse, value: Option<&serde_json::Value>) -> Option<AccountTeam> {
        if resp.team_choice {
            team_of(value)
        } else {
            None
        }
    }

    // ── Sign-in ──

    /// Ask GitHub for a device code and arm a fresh cancel (a sign-in already
    /// running is cancelled). The caller polls with [`Self::finish_sign_in`].
    /// Returns the code, its cancel and its attempt id (increasing).
    pub fn begin_sign_in(&self) -> Result<(DeviceCode, Arc<Stopper>, u64), AccountError> {
        let code = request_device_code(self.http.as_ref(), &self.endpoints)?;
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        let cancel = Arc::new(Stopper::default());
        if let Some(previous) = self.sign_in.lock().unwrap().replace(cancel.clone()) {
            previous.stop();
        }
        if self.app_stop.is_stopped() {
            cancel.stop();
        }
        Ok((code, cancel, attempt))
    }

    pub fn cancel_sign_in(&self) {
        if let Some(cancel) = self.sign_in.lock().unwrap().take() {
            cancel.stop();
        }
    }

    /// Poll GitHub, then create the session. Blocking: run it on its own
    /// thread.
    pub fn finish_sign_in(
        &self,
        code: &DeviceCode,
        cancel: &Arc<Stopper>,
        progress: &mut dyn FnMut(SignInProgress),
    ) -> Result<AccountInfo, AccountError> {
        let app_stop = self.app_stop.clone();
        let mut wait = |d: Duration| cancel.wait(d) && !app_stop.is_stopped();
        let result = poll_for_token(self.http.as_ref(), &self.endpoints, code, &mut wait, progress)
            .and_then(|github_token| {
                if cancel.is_stopped() {
                    return Err(AccountError::new(ErrorCode::Cancelled, "Sign-in cancelled."));
                }
                progress(SignInProgress::Verifying);
                self.complete_sign_in_unless(github_token, &device_name(), now_ms(), Some(cancel))
            });
        let mut slot = self.sign_in.lock().unwrap();
        if slot.as_ref().is_some_and(|s| Arc::ptr_eq(s, cancel)) {
            *slot = None;
        }
        result
    }

    /// Tests: [`Self::complete_sign_in_unless`] with no sign-in to cancel it.
    #[cfg(test)]
    pub fn complete_sign_in(
        &self,
        github_token: String,
        device_name: &str,
        now: i64,
    ) -> Result<AccountInfo, AccountError> {
        self.complete_sign_in_unless(github_token, device_name, now, None)
    }

    /// `POST /session` with the GitHub token, which is dropped when this
    /// returns. Last sign-in wins on the server; this device's entry then
    /// holds the new session. Abandoned when `cancel` stops: checked
    /// once `net` is held (a sign-out may have run while we waited for it)
    /// and again after `POST /session`, when the new session is ended.
    fn complete_sign_in_unless(
        &self,
        github_token: String,
        device_name: &str,
        now: i64,
        cancel: Option<&Stopper>,
    ) -> Result<AccountInfo, AccountError> {
        let cancelled = || cancel.is_some_and(|c| c.is_stopped());
        let cancelled_error = || AccountError::new(ErrorCode::Cancelled, "Sign-in cancelled.");
        let _net = self.net.lock().unwrap();
        if cancelled() {
            return Err(cancelled_error());
        }
        let device_name = clean_device_name(device_name);
        let device_name = device_name.as_str();
        let device_id = self.device_id();
        let req = HttpRequest {
            method: Method::Post,
            url: self.api("/session"),
            bearer: None,
            headers: vec![(TEAM_CHOICE_HEADER, "1".to_string())],
            body: Body::Json(serde_json::json!({
                "githubToken": github_token,
                "deviceId": device_id,
                "deviceName": sent_device_name(device_name, platform_name()),
                "platform": platform_name(),
            })),
        };
        drop(github_token);
        let resp = self.http.send(&req).map_err(AccountError::network);
        drop(req);
        let resp = resp?;
        self.heard(&resp);
        if !resp.ok() {
            return Err(server_error(&resp));
        }
        let answer: SessionAnswer = serde_json::from_str(&resp.body)
            .map_err(|_| AccountError::new(ErrorCode::Server, "The Plyloft server sent an unreadable sign-in answer."))?;
        if cancelled() {
            self.end_server_session(&answer.session_token);
            return Err(cancelled_error());
        }
        let payload = match self.verify(&answer.entitlement, now) {
            Ok(payload) => payload,
            Err(e) => {
                self.end_server_session(&answer.session_token);
                return Err(e);
            }
        };
        let team = Self::team_from(&resp, answer.team.as_ref());
        if let Err(e) = self.secrets.set(&device_id, &answer.session_token) {
            log::warn!("account: keychain write failed: {e}");
            self.end_server_session(&answer.session_token);
            return Err(AccountError::new(
                ErrorCode::Keychain,
                "Plyloft couldn't save the sign-in in the keychain.",
            ));
        }
        self.offline.store(false, Ordering::SeqCst);
        self.update(|f| {
            f.account = Some(answer.account.clone());
            f.entitlement = Some(answer.entitlement.clone());
            f.last_checked_at = Some(now);
            f.last_known_plan = Some(payload.plan);
            f.team = team;
            f.device_name = Some(device_name.to_string());
        });
        Ok(self.info_at(now))
    }

    /// Best effort: tell the server to forget a session we will not keep.
    fn end_server_session(&self, session_token: &str) {
        let req = HttpRequest {
            method: Method::Delete,
            url: self.api("/session"),
            bearer: Some(session_token.to_string()),
            headers: vec![(TEAM_CHOICE_HEADER, "1".to_string())],
            body: Body::None,
        };
        if let Err(e) = self.http.send(&req) {
            log::info!("account: DELETE /session not delivered: {e}");
        }
    }

    /// A `replaced` answer (1.178.0). The entitlement goes either way (a
    /// Team token must not outlive the move) and nobody sees a "replaced"
    /// state any more.
    ///
    /// - From a server that echoed [`TEAM_CHOICE_HEADER`]: a session revoked
    ///   before that server's deploy. It is taken back silently through
    ///   `POST /session/reclaim` (owner D3; with the header a reclaim never
    ///   moves Team and doesn't count toward the server's daily limit), at
    ///   most once per [`OFFLINE_RETRY_MS`]. `reclaimable: false`, or a
    ///   reclaim the server refuses as `unauthorized`, is a session the
    ///   server closed: signed out quietly, as any `unauthorized` is. A
    ///   reclaim that fails otherwise (offline, rate limited) leaves the
    ///   account signed in on Free until the next try.
    /// - From an older server (no echo; a rollback): no reclaim — there it
    ///   would take the plan from the other computer, and two computers
    ///   would bounce it between them. Signed in on Free; every refresh asks
    ///   again.
    ///
    /// The caller holds `net`, and has just noted the answer ([`Self::heard`]).
    fn on_replaced(&self, e: &AccountError, token: String, device_id: &str, now: i64) {
        self.free_here();
        if *self.team_choice.lock().unwrap() != Some(true) {
            log::info!("account: session replaced by an older server; Free here, still signed in");
            return;
        }
        if e.reclaimable == Some(false) {
            log::info!("account: session replaced and not reclaimable; signed out");
            self.drop_session();
            return;
        }
        if !self.claim_silent_reclaim(now) {
            log::info!("account: session replaced; reclaimed recently, Free here until the next try");
            return;
        }
        match self.reclaim_locked(token, device_id, now) {
            Ok(()) => log::info!("account: session replaced before the server's update; taken back"),
            Err(e) if e.code == ErrorCode::Unauthorized => {
                log::info!("account: session replaced and refused back; signed out");
                self.drop_session();
            }
            Err(e) => log::info!("account: session replaced; not taken back ({:?}): Free here", e.code),
        }
    }

    /// May the silent reclaim run at `now`? Yes once per
    /// [`OFFLINE_RETRY_MS`]; a yes counts at once. A clock that moved back is
    /// not held against it.
    fn claim_silent_reclaim(&self, now: i64) -> bool {
        let mut last = self.silent_reclaim_at.lock().unwrap();
        if let Some(at) = *last {
            if now >= at && now - at < OFFLINE_RETRY_MS {
                return false;
            }
        }
        *last = Some(now);
        true
    }

    /// Free here, still signed in: the entitlement and the `team` field go,
    /// the session stays (and so does [`AccountFile::last_known_plan`]).
    fn free_here(&self) {
        self.offline.store(false, Ordering::SeqCst);
        self.update(|f| {
            f.entitlement = None;
            f.team = None;
        });
    }

    /// Drop to the signed-out Free state: no session, no entitlement, no
    /// last known plan.
    fn drop_session(&self) {
        let device_id = self.device_id();
        if let Err(e) = self.secrets.delete(&device_id) {
            log::warn!("account: keychain delete failed: {e}");
        }
        self.offline.store(false, Ordering::SeqCst);
        self.update(|f| {
            f.account = None;
            f.entitlement = None;
            f.last_known_plan = None;
            f.team = None;
        });
    }

    /// `POST /session/reclaim` with the session this profile holds (no
    /// GitHub code), with [`TEAM_CHOICE_HEADER`]: a server that knows it
    /// never moves Team for it (A5 §3.6). The server rotates the token: the
    /// new one is kept at once, since the old one is dead. A refusal, a
    /// network failure or a plan that doesn't verify leaves the account
    /// signed in (on Free when no plan verified). The caller holds `net`.
    fn reclaim_locked(&self, token: String, device_id: &str, now: i64) -> Result<(), AccountError> {
        let req = HttpRequest {
            method: Method::Post,
            url: self.api("/session/reclaim"),
            bearer: Some(token),
            headers: Self::server_headers(device_id),
            body: Body::None,
        };
        let resp = self.http.send(&req).map_err(AccountError::network);
        drop(req);
        let resp = resp?;
        self.heard(&resp);
        if !resp.ok() {
            return Err(server_error(&resp));
        }
        let answer: SessionAnswer = serde_json::from_str(&resp.body)
            .map_err(|_| AccountError::new(ErrorCode::Server, "The Plyloft server sent an unreadable answer."))?;
        if let Err(e) = self.secrets.set(device_id, &answer.session_token) {
            log::warn!("account: keychain write failed: {e}");
            self.end_server_session(&answer.session_token);
            return Err(AccountError::new(
                ErrorCode::Keychain,
                "Plyloft couldn't save the sign-in in the keychain.",
            ));
        }
        let team = Self::team_from(&resp, answer.team.as_ref());
        let verified = self.verify(&answer.entitlement, now);
        self.offline.store(false, Ordering::SeqCst);
        self.update(|f| {
            f.account = Some(answer.account.clone());
            f.last_checked_at = Some(now);
            if let Ok(payload) = &verified {
                f.entitlement = Some(answer.entitlement.clone());
                f.last_known_plan = Some(payload.plan);
                f.team = team;
            }
        });
        verified.map(|_| ())
    }

    /// The session token for a call to the server, read from the keychain.
    /// `Ok(None)`: signed out, or `account.json` alone (L5: no account then;
    /// the profile is signed out here). The caller holds `net`.
    fn session_token(&self) -> Result<Option<String>, AccountError> {
        if self.file.lock().unwrap().account.is_none() {
            return Ok(None);
        }
        match self.secrets.get(&self.device_id()) {
            Ok(Some(token)) => Ok(Some(token)),
            Ok(None) => {
                log::info!("account: no session in the keychain; signed out");
                self.drop_session();
                Ok(None)
            }
            Err(e) => {
                log::warn!("account: keychain read failed: {e}");
                Err(AccountError::new(
                    ErrorCode::Keychain,
                    "Plyloft couldn't read its sign-in from the keychain.",
                ))
            }
        }
    }

    // ── Refresh ──

    /// `GET /entitlement`. Signed out: nothing to do, no request.
    /// `unauthorized`: the session ends here. `replaced`: Free here, still
    /// signed in, and the session taken back silently ([`Self::on_replaced`]).
    /// A network or server failure keeps the cached entitlement (until its
    /// `exp`) and marks the info offline. A token that fails verification
    /// leaves the state as it was.
    pub fn refresh_at(&self, now: i64) -> Result<AccountInfo, AccountError> {
        // Launch A3 (P2-3): stamped before waiting for `net` or the keychain,
        // so a focus event during a refresh in flight is told no.
        if self.file.lock().unwrap().account.is_some() {
            *self.last_refresh_ask.lock().unwrap() = Some(now);
        }
        let _net = self.net.lock().unwrap();
        let Some(token) = self.session_token()? else {
            return Ok(self.info_at(now));
        };
        // A dev-loaded plan (debug builds) has no server session: a server
        // asked with its placeholder answers `unauthorized` and would sign
        // the profile out. It keeps the loaded plan until its `exp`.
        #[cfg(debug_assertions)]
        if token == DEV_SESSION_PLACEHOLDER {
            return Ok(self.info_at(now));
        }
        // 1.178.0: no shortcut for a session an older version saw replaced
        // (its `replacedBy` is no state any more): the server is asked.
        let device_id = self.device_id();
        let req = HttpRequest {
            method: Method::Get,
            url: self.api("/entitlement"),
            bearer: Some(token.clone()),
            headers: Self::server_headers(&device_id),
            body: Body::None,
        };
        let outcome = match self.http.send(&req) {
            Err(e) => Err(AccountError::network(e)),
            Ok(resp) => {
                self.heard(&resp);
                if resp.ok() {
                    serde_json::from_str::<EntitlementAnswer>(&resp.body)
                        .map(|answer| (Self::team_from(&resp, answer.team.as_ref()), answer.entitlement))
                        .map_err(|_| AccountError::new(ErrorCode::Server, "The Plyloft server sent an unreadable plan."))
                } else {
                    Err(server_error(&resp))
                }
            }
        };
        drop(req);
        match outcome {
            Ok((team, entitlement)) => {
                let payload = self.verify(&entitlement, now)?;
                self.offline.store(false, Ordering::SeqCst);
                self.update(|f| {
                    f.entitlement = Some(entitlement.clone());
                    f.last_checked_at = Some(now);
                    f.last_known_plan = Some(payload.plan);
                    f.team = team;
                });
                Ok(self.info_at(now))
            }
            Err(e) if e.code == ErrorCode::Replaced => {
                self.on_replaced(&e, token, &device_id, now);
                Ok(self.info_at(now))
            }
            Err(e) if e.code == ErrorCode::Unauthorized => {
                log::info!("account: session no longer valid; signed out");
                self.drop_session();
                Ok(self.info_at(now))
            }
            Err(e) if e.is_transient() => {
                self.offline.store(true, Ordering::SeqCst);
                Ok(self.info_at(now))
            }
            Err(e) => Err(e),
        }
    }

    pub fn refresh(&self) -> Result<AccountInfo, AccountError> {
        self.refresh_at(now_ms())
    }

    /// Launch A3: may a window-focus refresh ask the server at `now`? Yes
    /// when signed in and no refresh asked in the last
    /// [`FOCUS_REFRESH_MIN_MS`]; a yes counts as an ask at once, so a second
    /// focus event racing this one is told no. A clock that moved back
    /// (`now` before the last ask) is not held against it.
    pub fn claim_focus_refresh(&self, now: i64) -> bool {
        if self.file.lock().unwrap().account.is_none() {
            return false;
        }
        let mut last = self.last_refresh_ask.lock().unwrap();
        if let Some(at) = *last {
            if now >= at && now - at < FOCUS_REFRESH_MIN_MS {
                return false;
            }
        }
        *last = Some(now);
        true
    }

    /// When a refresh last asked the server (any trigger), if one did.
    pub fn last_refresh_ask(&self) -> Option<i64> {
        *self.last_refresh_ask.lock().unwrap()
    }

    /// The focus refresh, at `now`, as the app's thread runs it
    /// ([`refresh_on_focus`]): `None` when [`Self::claim_focus_refresh`] says no
    /// (nothing is sent), else the refresh's own answer.
    #[cfg(test)]
    pub fn refresh_on_focus_at(&self, now: i64) -> Option<Result<AccountInfo, AccountError>> {
        if !self.claim_focus_refresh(now) {
            return None;
        }
        Some(self.refresh_at(now))
    }

    // ── Billing and team calls (launch T1–T3, `billing_client.rs`) ──

    /// One authenticated call to plyloft-server: `Bearer <session>`,
    /// `X-Plyloft-Device` and [`TEAM_CHOICE_HEADER`], the body as JSON.
    /// Returns the answer's body on a 2xx. Signed out (or no session in the
    /// keychain): `unauthorized` without a request. An `unauthorized` answer
    /// ends the session here exactly as a refresh does; a `replaced` one is
    /// handled as a refresh handles it ([`Self::on_replaced`]); both are
    /// returned. The token is read from the keychain for this call only and
    /// never logged.
    pub fn api_send(&self, method: Method, path: &str, body: Option<serde_json::Value>) -> Result<String, AccountError> {
        let _net = self.net.lock().unwrap();
        let signed_out = || AccountError::new(ErrorCode::Unauthorized, "Sign in to Plyloft first.");
        let Some(token) = self.session_token()? else {
            return Err(signed_out());
        };
        // A dev-loaded plan has no server session to send (see `refresh_at`).
        #[cfg(debug_assertions)]
        if token == DEV_SESSION_PLACEHOLDER {
            return Err(AccountError::network("a dev-loaded plan has no server session"));
        }
        let device_id = self.device_id();
        let req = HttpRequest {
            method,
            url: self.api(path),
            bearer: Some(token.clone()),
            headers: Self::server_headers(&device_id),
            body: body.map(Body::Json).unwrap_or(Body::None),
        };
        let resp = self.http.send(&req).map_err(AccountError::network);
        drop(req);
        let resp = resp?;
        self.heard(&resp);
        if resp.ok() {
            return Ok(resp.body);
        }
        let e = server_error(&resp);
        match e.code {
            ErrorCode::Replaced => self.on_replaced(&e, token, &device_id, now_ms()),
            ErrorCode::Unauthorized => self.drop_session(),
            _ => {}
        }
        Err(e)
    }

    // ── Use Team on this computer (1.178.0, A5 §3.3) ──

    /// `POST /session/use-team`: the account's Team plan becomes active on
    /// this computer; the computer that had it stays signed in and gets Free
    /// at its next refresh. Returns the account with the new plan. Signed out:
    /// `unauthorized`, no request. `no_team` (the account has no Team plan
    /// now): the `team` field goes, so the button goes with it. `unauthorized`
    /// ends the session as a refresh does. Offline or rate limited: the state
    /// is left alone and the error says so.
    pub fn use_team_at(&self, now: i64) -> Result<AccountInfo, AccountError> {
        let _net = self.net.lock().unwrap();
        let signed_out = || AccountError::new(ErrorCode::Unauthorized, "Sign in to Plyloft first.");
        let Some(token) = self.session_token()? else {
            return Err(signed_out());
        };
        #[cfg(debug_assertions)]
        if token == DEV_SESSION_PLACEHOLDER {
            return Err(AccountError::network("a dev-loaded plan has no server session"));
        }
        let device_id = self.device_id();
        let req = HttpRequest {
            method: Method::Post,
            url: self.api("/session/use-team"),
            bearer: Some(token.clone()),
            headers: Self::server_headers(&device_id),
            body: Body::None,
        };
        let resp = self.http.send(&req).map_err(AccountError::network);
        drop(req);
        let resp = resp?;
        self.heard(&resp);
        if !resp.ok() {
            let e = server_error(&resp);
            match e.code {
                ErrorCode::NoTeam => self.update(|f| f.team = None),
                ErrorCode::Replaced => self.on_replaced(&e, token, &device_id, now),
                ErrorCode::Unauthorized => self.drop_session(),
                _ => {}
            }
            return Err(e);
        }
        let answer: EntitlementAnswer = serde_json::from_str(&resp.body)
            .map_err(|_| AccountError::new(ErrorCode::Server, "The Plyloft server sent an unreadable plan."))?;
        let payload = self.verify(&answer.entitlement, now)?;
        let team = Self::team_from(&resp, answer.team.as_ref());
        self.offline.store(false, Ordering::SeqCst);
        self.update(|f| {
            f.entitlement = Some(answer.entitlement.clone());
            f.last_checked_at = Some(now);
            f.last_known_plan = Some(payload.plan);
            f.team = team;
        });
        Ok(self.info_at(now))
    }

    /// QoL 12.1 (Challenger H1): "Sign out other computers" — every other
    /// session of this account is signed out for good (none can take the
    /// plan back). Returns how many. 1.178.0 (A5 §3.5): on a Team plan the
    /// server also makes this computer the one Team runs on; the command asks
    /// for the plan again right after.
    pub fn sign_out_others(&self) -> Result<u32, AccountError> {
        let body = self.api_send(Method::Post, "/sessions/others/sign-out", None)?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Answer {
            signed_out: u32,
        }
        serde_json::from_str::<Answer>(&body)
            .map(|a| a.signed_out)
            .map_err(|_| AccountError::new(ErrorCode::Server, "The Plyloft server sent an unreadable answer."))
    }

    // ── Sign-out ──

    /// `DELETE /session` (best effort: offline still signs out here), then
    /// forget the session and the entitlement. The `deviceId` stays.
    pub fn sign_out_at(&self, now: i64) -> AccountInfo {
        self.cancel_sign_in();
        let _net = self.net.lock().unwrap();
        let device_id = self.device_id();
        match self.secrets.get(&device_id) {
            Ok(Some(token)) => self.end_server_session(&token),
            Ok(None) => {}
            Err(e) => log::warn!("account: keychain read failed at sign-out: {e}"),
        }
        self.drop_session();
        self.info_at(now)
    }

    pub fn sign_out(&self) -> AccountInfo {
        self.sign_out_at(now_ms())
    }

    /// Debug builds only (launch G walks): take a `PLY2-` token minted with
    /// the dev keypair for this device (`scripts/dev-mint-entitlement.sh`)
    /// as this profile's plan — what a sign-in would store, without GitHub or
    /// the server. A placeholder session goes in the (dev) keychain; refresh
    /// and server calls never send it, so the plan holds until `exp` whether
    /// or not a server is reachable. Never compiled into a release build.
    #[cfg(debug_assertions)]
    pub fn dev_load_entitlement_at(&self, token: &str, now: i64) -> Result<AccountInfo, AccountError> {
        let _net = self.net.lock().unwrap();
        let token = token.trim();
        let key = self
            .pubkey
            .as_ref()
            .map_err(|e| AccountError::new(ErrorCode::NotConfigured, e.clone()))?;
        let device_id = self.device_id();
        let payload = verify_entitlement_with(token, key, &device_id, now)
            .map_err(|e| AccountError::new(ErrorCode::BadEntitlement, format!("This token can't be used here: {e}.")))?;
        self.secrets
            .set(&device_id, DEV_SESSION_PLACEHOLDER)
            .map_err(|e| AccountError::new(ErrorCode::Keychain, format!("The dev keychain refused the placeholder session: {e}")))?;
        self.offline.store(false, Ordering::SeqCst);
        self.update(|f| {
            f.account = Some(AccountIdentity { sub: payload.sub.clone(), login: payload.login.clone() });
            f.entitlement = Some(token.to_string());
            f.last_checked_at = Some(now);
            f.last_known_plan = Some(payload.plan);
            // No server says where Team runs for a dev-loaded plan.
            f.team = None;
        });
        Ok(self.info_at(now))
    }

    /// Dev-only (team walks): whether this profile's plan is a dev-loaded one,
    /// which holds no seat because no server knows it, so the seat steps of
    /// Add member and Remove from team have nothing to ask. Never compiled into
    /// a release; a test-bridge build's callers sit under the same gate.
    ///
    /// All of it, or no. A real plan can't pass in a test-bridge build: signed
    /// in, its session isn't the placeholder; on a skip-signin run the session
    /// is, but the plan was signed with the production key, so either this run
    /// trusts that key (refused below) or its signature doesn't verify.
    #[cfg(all(debug_assertions, any(test, feature = "test-bridge")))]
    pub fn dev_plan_has_no_seats_at(&self, now: i64) -> bool {
        let Ok(key) = self.pubkey.as_ref() else { return false };
        if parse_pubkey_hex(ENTITLEMENT_PUBKEY_HEX).is_ok_and(|production| production == *key) {
            return false;
        }
        let info = self.info_at(now);
        if !info.signed_in || !info.entitlement_valid {
            return false;
        }
        matches!(self.secrets.get(&self.device_id()), Ok(Some(token)) if token == DEV_SESSION_PLACEHOLDER)
    }

    /// App exit (Hard Rule #4): the refresher and any sign-in stop.
    pub fn stop(&self) {
        self.app_stop.stop();
        self.cancel_sign_in();
    }

    pub fn stopper(&self) -> Arc<Stopper> {
        self.app_stop.clone()
    }
}

// ── App glue ────────────────────────────────────────────────────────

use tauri::{Emitter, Manager};

fn emit_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, info: &AccountInfo) {
    let _ = app.emit(EVENT_CHANGED, info);
}

/// `account_sign_in_start`: get a code, start polling on a thread, return the
/// code. Blocking (one GitHub request): call it from `spawn_blocking`.
pub fn sign_in_start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<SignInStart, AccountError> {
    let store = app.state::<AccountStore>();
    let (code, cancel, attempt) = store.begin_sign_in()?;
    let start = SignInStart {
        attempt,
        user_code: code.user_code.clone(),
        verification_uri: code.verification_uri.clone(),
        expires_in: code.expires_in,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<AccountStore>();
        let emit = |progress: SignInProgress| {
            let _ = app.emit(EVENT_SIGN_IN, &SignInEvent { attempt, progress });
        };
        let mut progress = |p: SignInProgress| emit(p);
        let outcome = store.finish_sign_in(&code, &cancel, &mut progress);
        let event = match outcome {
            Ok(info) => {
                emit_changed(&app, &info);
                SignInProgress::SignedIn { info }
            }
            Err(e) if e.code == ErrorCode::Cancelled => SignInProgress::Cancelled,
            Err(error) => SignInProgress::Failed { error },
        };
        emit(event);
    });
    Ok(start)
}

/// On-demand refresh; emits [`EVENT_CHANGED`]. Blocking.
pub fn refresh_and_emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<AccountInfo, AccountError> {
    let store = app.state::<AccountStore>();
    let result = store.refresh();
    emit_changed(app, &store.info());
    result
}

/// Launch A3: the main window came to the front. Off the event loop, ask the
/// server again unless a refresh asked within [`FOCUS_REFRESH_MIN_MS`]
/// (decided before any thread starts, so a burst of focus events costs
/// nothing); emits [`EVENT_CHANGED`] when it asked.
pub fn refresh_on_focus<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let store = app.state::<AccountStore>();
    if store.app_stop.is_stopped() || !store.claim_focus_refresh(now_ms()) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<AccountStore>();
        if let Err(e) = store.refresh_at(now_ms()) {
            log::info!("account: focus refresh failed: {}", e.message);
        }
        emit_changed(&app, &store.info());
    });
}

/// 1.178.0: **Use Team on this computer**; emits [`EVENT_CHANGED`]. Blocking.
pub fn use_team_and_emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<AccountInfo, AccountError> {
    let store = app.state::<AccountStore>();
    let result = store.use_team_at(now_ms());
    emit_changed(app, &store.info());
    result
}

/// Sign out; emits [`EVENT_CHANGED`]. Blocking.
pub fn sign_out_and_emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AccountInfo {
    let info = app.state::<AccountStore>().sign_out();
    emit_changed(app, &info);
    info
}

/// The refresher: at launch, then every [`REFRESH_EVERY_MS`] of wall-clock
/// time ([`OFFLINE_RETRY_MS`] after an offline attempt). A plain thread that
/// holds no child process; [`AccountStore::stop`] ends it at exit.
pub fn start_refresher<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let stop = app.state::<AccountStore>().stopper();
    std::thread::spawn(move || {
        let mut next_due = now_ms();
        let mut deferred: Option<i64> = None;
        loop {
            if stop.is_stopped() {
                return;
            }
            let now = now_ms();
            if now >= next_due {
                let store = app.state::<AccountStore>();
                let signed_in = store.info_at(now).signed_in;
                match refresher_step(now, signed_in, store.last_refresh_ask(), deferred) {
                    RefresherStep::Idle => next_due = now + REFRESH_EVERY_MS,
                    RefresherStep::Defer { at, until } => {
                        deferred = Some(at);
                        next_due = until;
                    }
                    RefresherStep::Adopt { at } => {
                        deferred = None;
                        let after = store.info();
                        emit_changed(&app, &after);
                        next_due = at + if after.offline { OFFLINE_RETRY_MS } else { REFRESH_EVERY_MS };
                    }
                    RefresherStep::Refresh => {
                        deferred = None;
                        if let Err(e) = store.refresh_at(now) {
                            log::info!("account: refresh failed: {}", e.message);
                        }
                        // Every tick says so (Challenger P3-6): the plan gates also
                        // move with the clock (an entitlement past `exp`), so the
                        // window reads them again even when nothing else changed.
                        let after = store.info();
                        emit_changed(&app, &after);
                        next_due = now + if after.offline { OFFLINE_RETRY_MS } else { REFRESH_EVERY_MS };
                    }
                }
            }
            if !stop.wait(REFRESHER_TICK) {
                return;
            }
        }
    });
}

/// What the refresher does when it is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefresherStep {
    /// Signed out: nothing to ask.
    Idle,
    /// Another trigger (a focus, Check now) asked at `at`, under a minute ago:
    /// don't ask again; look again at `until`, when its answer is in.
    Defer { at: i64, until: i64 },
    /// The ask deferred to has landed and nothing asked since: plan the next
    /// tick from it.
    Adopt { at: i64 },
    Refresh,
}

/// Launch A3 (P2-3): the refresher never doubles an ask another trigger just
/// made — at launch the first focus and the launch refresh coincide.
pub fn refresher_step(now: i64, signed_in: bool, last_ask: Option<i64>, deferred: Option<i64>) -> RefresherStep {
    if !signed_in {
        return RefresherStep::Idle;
    }
    if let (Some(at), Some(d)) = (last_ask, deferred) {
        if at == d {
            return RefresherStep::Adopt { at };
        }
    }
    match last_ask {
        Some(at) if now >= at && now - at < FOCUS_REFRESH_MIN_MS => {
            RefresherStep::Defer { at, until: at + FOCUS_REFRESH_MIN_MS }
        }
        _ => RefresherStep::Refresh,
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 1.175.0 (E-app round 2): one rule for the name another computer
    /// reads — the Mac model, or the platform's word; never the name itself.
    #[test]
    fn a_computer_is_named_by_its_model_alone() {
        for (raw, label) in [
            ("Matteo's MacBook Pro", "MacBook Pro"),
            ("Matteo\u{2019}s Mac mini", "Mac mini"),
            ("Matteo\u{2019}s MacBook Pro (2)", "MacBook Pro"),
            ("MacBook-Pro-di-Matteo", "MacBook Pro"),
            ("matteos-MacBook-Pro.local", "MacBook Pro"),
            ("Matteos-Mac-mini", "Mac mini"),
            ("Mac mini di Matteo", "Mac mini"),
            ("MacBook Air da Rita", "MacBook Air"),
            ("iMac von Jan", "iMac"),
            ("MacBook du Luc", "MacBook"),
            ("Marta's Mac Studio", "Mac Studio"),
            ("MAC PRO", "Mac Pro"),
            ("macbookpro", "MacBook Pro"),
            // No model: the platform's word, never the name.
            ("Studio di Marta", "Mac"),
            ("Matteo", "Mac"),
            ("Marta Rossi's Workstation", "Mac"),
            ("", "Mac"),
        ] {
            assert_eq!(model_label(raw, "macos"), label, "{raw:?}");
        }
        assert_eq!(model_label("MARTA-PC", "windows"), "Windows PC");
        assert_eq!(model_label("DESKTOP-4F2K", "windows"), "Windows PC");
        assert_eq!(model_label("matteo-thinkpad", "linux"), "Computer");
        if std::env::var("PLYLOFT_DEVICE_NAME").is_err() {
            assert_eq!(shared_name_of("  Mac mini di Matteo "), "Mac mini");
            assert_eq!(shared_name_of("Studio di Marta"), model_label("", platform_name()));
        }
    }

    /// C2's kept name, when known, is the one C3's commits carry too.
    #[test]
    fn the_shared_name_is_the_one_the_settings_keep() {
        if std::env::var("PLYLOFT_DEVICE_NAME").is_ok() {
            return;
        }
        crate::device_claim::set_test_device(Some(crate::device_claim::ThisDevice {
            id: "u".into(),
            name: "Matteo's MacBook Air".into(),
        }));
        assert_eq!(shared_device_name().as_deref(), Some("MacBook Air"));
        crate::device_claim::set_test_device(None);
    }
    use ed25519_dalek::{Signer, SigningKey};
    use std::collections::{HashMap, VecDeque};

    const DEVICE: &str = "device-a";
    const NOW: i64 = 1_760_000_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn keypair() -> (SigningKey, VerifyingKey) {
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    fn payload(plan: &str, device: &str, exp: i64) -> String {
        format!(
            r#"{{"v":2,"sub":"1234567","login":"octocat","plan":"{plan}","teamRepo":null,"teamRole":null,"deviceId":"{device}","iat":{NOW},"exp":{exp},"periodEnd":null,"status":null,"comp":false}}"#
        )
    }

    fn mint(sk: &SigningKey, payload: &str) -> String {
        let sig = sk.sign(payload.as_bytes());
        format!(
            "{ENTITLEMENT_PREFIX}{}.{}",
            URL_SAFE_NO_PAD.encode(payload.as_bytes()),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }

    // ── PLY2 verification ──

    #[test]
    fn good_entitlement_verifies() {
        let (sk, vk) = keypair();
        let token = mint(&sk, &payload("pro", DEVICE, NOW + DAY));
        let p = verify_entitlement_with(&token, &vk, DEVICE, NOW).unwrap();
        assert_eq!(p.plan, Plan::Pro);
        assert_eq!(p.login, "octocat");
        assert_eq!(p.sub, "1234567");
        assert!(!p.comp);
    }

    #[test]
    fn team_payload_carries_repo_and_role() {
        let (sk, vk) = keypair();
        let json = format!(
            r#"{{"v":2,"sub":"1","login":"a","plan":"team","teamRepo":"o/n","teamRole":"owner","deviceId":"{DEVICE}","iat":1,"exp":{},"periodEnd":5,"status":"past_due","comp":true}}"#,
            NOW + DAY
        );
        let p = verify_entitlement_with(&mint(&sk, &json), &vk, DEVICE, NOW).unwrap();
        assert_eq!(p.plan, Plan::Team);
        assert_eq!(p.team_repo.as_deref(), Some("o/n"));
        assert_eq!(p.team_role, Some(TeamRole::Owner));
        assert_eq!(p.status.as_deref(), Some("past_due"));
        assert_eq!(p.period_end, Some(5));
        assert!(p.comp);
    }

    #[test]
    fn forged_payload_and_foreign_key_are_refused() {
        let (sk, vk) = keypair();
        let token = mint(&sk, &payload("free", DEVICE, NOW + DAY));
        let sig = token.split('.').nth(1).unwrap();
        let forged = format!(
            "{ENTITLEMENT_PREFIX}{}.{sig}",
            URL_SAFE_NO_PAD.encode(payload("team", DEVICE, NOW + DAY).as_bytes())
        );
        assert!(verify_entitlement_with(&forged, &vk, DEVICE, NOW).unwrap_err().contains("signature"));
        let other = SigningKey::from_bytes(&[12u8; 32]);
        let foreign = mint(&other, &payload("pro", DEVICE, NOW + DAY));
        assert!(verify_entitlement_with(&foreign, &vk, DEVICE, NOW).unwrap_err().contains("signature"));
    }

    #[test]
    fn wrong_device_is_refused() {
        let (sk, vk) = keypair();
        let token = mint(&sk, &payload("pro", "device-b", NOW + DAY));
        assert!(verify_entitlement_with(&token, &vk, DEVICE, NOW).unwrap_err().contains("another device"));
    }

    #[test]
    fn expired_is_refused_at_and_after_exp() {
        let (sk, vk) = keypair();
        let token = mint(&sk, &payload("pro", DEVICE, NOW));
        assert!(verify_entitlement_with(&token, &vk, DEVICE, NOW - 1).is_ok());
        assert!(verify_entitlement_with(&token, &vk, DEVICE, NOW).unwrap_err().contains("expired"));
        assert!(verify_entitlement_with(&token, &vk, DEVICE, NOW + 1).is_err());
    }

    #[test]
    fn wrong_prefix_version_and_shape_are_refused() {
        let (sk, vk) = keypair();
        let token = mint(&sk, &payload("pro", DEVICE, NOW + DAY));
        let ply1 = token.replacen(ENTITLEMENT_PREFIX, "PLY1-", 1);
        assert!(verify_entitlement_with(&ply1, &vk, DEVICE, NOW).unwrap_err().contains("PLY2-"));
        assert!(verify_entitlement_with("PLY2-nodot", &vk, DEVICE, NOW).unwrap_err().contains("signature part"));
        assert!(verify_entitlement_with("PLY2-!!.@@", &vk, DEVICE, NOW).unwrap_err().contains("base64url"));
        let v1 = payload("pro", DEVICE, NOW + DAY).replace(r#""v":2"#, r#""v":1"#);
        assert!(verify_entitlement_with(&mint(&sk, &v1), &vk, DEVICE, NOW).unwrap_err().contains("version"));
        let unknown_plan = payload("enterprise", DEVICE, NOW + DAY);
        assert!(verify_entitlement_with(&mint(&sk, &unknown_plan), &vk, DEVICE, NOW).is_err());
    }

    /// Tier 3: hostile shapes never panic and never verify.
    #[test]
    fn hostile_tokens_are_refused_without_panicking() {
        let (sk, vk) = keypair();
        let good = mint(&sk, &payload("pro", DEVICE, NOW + DAY));
        let (head, sig) = good.split_once('.').unwrap();
        let short_sig = URL_SAFE_NO_PAD.encode([0u8; 63]);
        let not_json = mint(&sk, "not json");
        let huge = format!("{ENTITLEMENT_PREFIX}{}.{sig}", "A".repeat(1 << 20));
        for hostile in [
            String::new(),
            "PLY2-".into(),
            "PLY2-.".into(),
            format!("{head}.{sig}.extra"),
            format!("{head}.{short_sig}"),
            format!("{head}+/.{sig}"),
            format!(" {head}\n.{sig}"),
            good.to_lowercase(),
            not_json,
            huge,
        ] {
            assert!(verify_entitlement_with(&hostile, &vk, DEVICE, NOW).is_err(), "{:.40}", hostile);
        }
        // Surrounding whitespace alone is tolerated (a cached copy).
        assert!(verify_entitlement_with(&format!("  {good}\n"), &vk, DEVICE, NOW).is_ok());
    }

    #[test]
    fn padded_base64_is_refused() {
        let (sk, vk) = keypair();
        // A payload whose length is not a multiple of 3, so padding exists.
        let json = payload("pro", DEVICE, NOW + DAY) + " ";
        let json = if json.len() % 3 == 0 { json + " " } else { json };
        let sig = sk.sign(json.as_bytes());
        let padded = format!(
            "{ENTITLEMENT_PREFIX}{}.{}",
            base64::engine::general_purpose::URL_SAFE.encode(json.as_bytes()),
            base64::engine::general_purpose::URL_SAFE.encode(sig.to_bytes())
        );
        assert!(padded.contains('='));
        assert!(verify_entitlement_with(&padded, &vk, DEVICE, NOW).unwrap_err().contains("padded"));
        // The same bytes unpadded verify (the refusal is about padding only).
        assert!(verify_entitlement_with(&mint(&sk, &json), &vk, DEVICE, NOW).is_ok());
    }

    #[test]
    fn release_pubkey_constant_is_empty_or_well_formed() {
        if !ENTITLEMENT_PUBKEY_HEX.is_empty() {
            parse_pubkey_hex(ENTITLEMENT_PUBKEY_HEX).expect("ENTITLEMENT_PUBKEY_HEX must be a valid key");
        }
        assert!(parse_pubkey_hex("0891c267f480660605a889ae0a1ba5362cefe935fb8b01508ab2b8e5de23ccdc").is_ok());
        assert!(parse_pubkey_hex("zz").is_err());
        assert!(parse_pubkey_hex("00").is_err());
    }

    // ── Fakes ──

    #[derive(Default)]
    struct FakeHttp {
        answers: Mutex<VecDeque<Result<HttpResponse, String>>>,
        seen: Mutex<Vec<(Method, String, Option<String>, Vec<(&'static str, String)>, String)>>,
    }

    impl FakeHttp {
        /// An answer without `X-Plyloft-Team-Choice`: an older server (or
        /// GitHub).
        fn push(&self, status: u16, body: &str) {
            self.answers.lock().unwrap().push_back(Ok(HttpResponse::new(status, body)));
        }
        /// An answer from a 1.178 server, which echoes the header.
        fn push_new(&self, status: u16, body: &str) {
            self.answers
                .lock()
                .unwrap()
                .push_back(Ok(HttpResponse { team_choice: true, ..HttpResponse::new(status, body) }));
        }
        fn push_err(&self) {
            self.answers.lock().unwrap().push_back(Err("connection refused".into()));
        }
        fn seen(&self) -> Vec<(Method, String, Option<String>, Vec<(&'static str, String)>, String)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Http for Arc<FakeHttp> {
        fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String> {
            let body = match &req.body {
                Body::None => String::new(),
                Body::Json(v) => v.to_string(),
                Body::Form(p) => form_encode(p),
            };
            self.seen.lock().unwrap().push((
                req.method,
                req.url.clone(),
                req.bearer.clone(),
                req.headers.clone(),
                body,
            ));
            self.answers
                .lock()
                .unwrap()
                .pop_front()
                .expect("an HTTP request the test did not expect")
        }
    }

    #[derive(Default)]
    struct FakeSecrets {
        map: Mutex<HashMap<String, String>>,
        fail_set: AtomicBool,
    }

    impl SecretStore for Arc<FakeSecrets> {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.map.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if self.fail_set.load(Ordering::SeqCst) {
                return Err("denied".into());
            }
            self.map.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.map.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn endpoints() -> Endpoints {
        Endpoints {
            api_base: "http://api.test/v1".into(),
            github_base: "https://gh.test".into(),
            client_id: "Iv1.test".into(),
        }
    }

    struct Rig {
        _dir: tempfile::TempDir,
        dir: PathBuf,
        http: Arc<FakeHttp>,
        secrets: Arc<FakeSecrets>,
        store: AccountStore,
        sk: SigningKey,
    }

    fn rig_in(dir: tempfile::TempDir) -> Rig {
        let (sk, vk) = keypair();
        let http = Arc::new(FakeHttp::default());
        let secrets = Arc::new(FakeSecrets::default());
        let path = dir.path().to_path_buf();
        let store = AccountStore::with_parts(
            path.clone(),
            Box::new(http.clone()),
            Box::new(secrets.clone()),
            endpoints(),
            Ok(vk),
        );
        Rig { _dir: dir, dir: path, http, secrets, store, sk }
    }

    fn rig() -> Rig {
        rig_in(tempfile::tempdir().unwrap())
    }

    impl Rig {
        fn token(&self, plan: &str, exp: i64) -> String {
            mint(&self.sk, &payload(plan, &self.store.device_id(), exp))
        }

        fn sign_in(&self, plan: &str, exp: i64) -> AccountInfo {
            let ent = self.token(plan, exp);
            self.http.push(
                200,
                &format!(r#"{{"sessionToken":"pls_secret","entitlement":"{ent}","account":{{"sub":"1234567","login":"octocat"}}}}"#),
            );
            self.store.complete_sign_in("gho_github".into(), "Test Mac", NOW).unwrap()
        }

        /// Sign in against a 1.178 server, whose answer carries `team`
        /// (a JSON fragment: `null`, `{"active":…}`).
        fn sign_in_new(&self, plan: &str, exp: i64, team: &str) -> AccountInfo {
            let ent = self.token(plan, exp);
            self.http.push_new(
                200,
                &format!(r#"{{"sessionToken":"pls_secret","entitlement":"{ent}","account":{{"sub":"1234567","login":"octocat"}},"team":{team}}}"#),
            );
            self.store.complete_sign_in("gho_github".into(), "Test Mac", NOW).unwrap()
        }

        fn file(&self) -> serde_json::Value {
            serde_json::from_str(&std::fs::read_to_string(self.dir.join(ACCOUNT_FILE)).unwrap()).unwrap()
        }
    }

    // ── Device flow ──

    fn code(interval: u64, expires_in: u64) -> DeviceCode {
        DeviceCode {
            device_code: "dc".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in,
            interval,
        }
    }

    #[test]
    fn device_code_request_sends_client_id_and_no_scope() {
        let http = Arc::new(FakeHttp::default());
        http.push(
            200,
            r#"{"device_code":"dc","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
        );
        let c = request_device_code(&http, &endpoints()).unwrap();
        assert_eq!(c.user_code, "ABCD-1234");
        let seen = http.seen();
        assert_eq!(seen[0].1, "https://gh.test/login/device/code");
        assert_eq!(seen[0].4, "client_id=Iv1.test");
        assert!(!seen[0].4.contains("scope"));
    }

    #[test]
    fn device_code_without_client_id_is_not_configured() {
        let http = Arc::new(FakeHttp::default());
        let mut ep = endpoints();
        ep.client_id = String::new();
        assert_eq!(request_device_code(&http, &ep).unwrap_err().code, ErrorCode::NotConfigured);
        assert!(http.seen().is_empty());
    }

    #[test]
    fn device_code_refusal_is_a_device_flow_error() {
        let http = Arc::new(FakeHttp::default());
        http.push(200, r#"{"error":"device_flow_disabled","error_description":"Device Flow must be explicitly enabled for this App"}"#);
        let e = request_device_code(&http, &endpoints()).unwrap_err();
        assert_eq!(e.code, ErrorCode::DeviceFlow);
        assert!(e.message.contains("Device Flow"));
    }

    fn poll(http: &Arc<FakeHttp>, c: &DeviceCode) -> (Result<String, AccountError>, Vec<u64>, Vec<String>) {
        let mut waits = vec![];
        let mut events = vec![];
        let r = poll_for_token(
            http,
            &endpoints(),
            c,
            &mut |d| {
                waits.push(d.as_secs());
                true
            },
            &mut |p| events.push(serde_json::to_value(&p).unwrap()["state"].as_str().unwrap().to_string()),
        );
        (r, waits, events)
    }

    #[test]
    fn polling_waits_through_pending_and_slow_down() {
        let http = Arc::new(FakeHttp::default());
        http.push(200, r#"{"error":"authorization_pending"}"#);
        http.push(200, r#"{"error":"slow_down","interval":10}"#);
        http.push_err();
        http.push(200, r#"{"error":"slow_down"}"#);
        http.push(200, r#"{"access_token":"gho_x","token_type":"bearer","scope":""}"#);
        let (r, waits, events) = poll(&http, &code(5, 900));
        assert_eq!(r.unwrap(), "gho_x");
        // 5, 5, then slow_down → 10 (max(GitHub's 10, 5+5)), a network blip
        // keeps 10, slow_down again → 15.
        assert_eq!(waits, vec![5, 5, 10, 10, 15]);
        assert_eq!(events, vec!["waiting", "slow_down", "slow_down"]);
        let seen = http.seen();
        assert_eq!(seen[0].1, "https://gh.test/login/oauth/access_token");
        assert!(seen[0].4.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"));
        assert!(seen[0].4.contains("device_code=dc"));
    }

    #[test]
    fn polling_ends_on_expired_denied_and_unknown() {
        let http = Arc::new(FakeHttp::default());
        http.push(200, r#"{"error":"expired_token"}"#);
        assert_eq!(poll(&http, &code(5, 900)).0.unwrap_err().code, ErrorCode::ExpiredToken);
        http.push(200, r#"{"error":"access_denied"}"#);
        assert_eq!(poll(&http, &code(5, 900)).0.unwrap_err().code, ErrorCode::AccessDenied);
        http.push(200, r#"{"error":"incorrect_device_code","error_description":"bad code"}"#);
        let e = poll(&http, &code(5, 900)).0.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::DeviceFlow, "bad code"));
    }

    #[test]
    fn polling_stops_at_the_code_lifetime() {
        let http = Arc::new(FakeHttp::default());
        http.push(200, r#"{"error":"authorization_pending"}"#);
        http.push(200, r#"{"error":"authorization_pending"}"#);
        let (r, waits, _) = poll(&http, &code(5, 10));
        assert_eq!(r.unwrap_err().code, ErrorCode::ExpiredToken);
        assert_eq!(waits, vec![5, 5]);
    }

    #[test]
    fn polling_honours_cancel() {
        let http = Arc::new(FakeHttp::default());
        let r = poll_for_token(&http, &endpoints(), &code(5, 900), &mut |_| false, &mut |_| {});
        assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
        assert!(http.seen().is_empty());
    }

    #[test]
    fn finish_sign_in_cancelled_by_cancel_sign_in() {
        let r = rig();
        r.http.push(
            200,
            r#"{"device_code":"dc","user_code":"U","verification_uri":"v","expires_in":900,"interval":5}"#,
        );
        let (c, cancel, attempt) = r.store.begin_sign_in().unwrap();
        assert_eq!(attempt, 1);
        r.store.cancel_sign_in();
        let e = r.store.finish_sign_in(&c, &cancel, &mut |_| {}).unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        assert!(!r.store.info().signed_in);
    }

    #[test]
    fn stopper_wait_returns_false_once_stopped() {
        let s = Stopper::default();
        assert!(s.wait(Duration::from_millis(1)));
        s.stop();
        assert!(!s.wait(Duration::from_secs(60)));
    }

    // ── Session ──

    #[test]
    fn sign_in_stores_token_in_keychain_not_on_disk() {
        let r = rig();
        let info = r.sign_in("pro", NOW + 30 * DAY);
        assert!(info.signed_in && info.entitlement_valid);
        assert_eq!(info.plan, Plan::Pro);
        assert_eq!(info.login.as_deref(), Some("octocat"));
        assert_eq!(info.last_checked_at, Some(NOW));
        assert_eq!(info.device_name.as_deref(), Some("Test Mac"));
        let device = r.store.device_id();
        assert_eq!(r.secrets.map.lock().unwrap().get(&device).map(String::as_str), Some("pls_secret"));
        let raw = std::fs::read_to_string(r.dir.join(ACCOUNT_FILE)).unwrap();
        assert!(!raw.contains("pls_secret") && !raw.contains("gho_github"));
        // The request carried the contract's fields.
        let seen = r.http.seen();
        assert_eq!((seen[0].0, seen[0].1.as_str()), (Method::Post, "http://api.test/v1/session"));
        let body: serde_json::Value = serde_json::from_str(&seen[0].4).unwrap();
        assert_eq!(body["githubToken"], "gho_github");
        assert_eq!(body["deviceId"], device.as_str());
        // 1.175.0 (E3): the name sent is the short one (on Windows, the
        // platform's word); the full one stays here.
        assert_eq!(body["deviceName"].as_str(), Some(sent_device_name("Test Mac", platform_name()).as_str()));
        assert!(body["platform"].is_string());
        assert!(seen[0].2.is_none());
    }

    #[test]
    fn sign_in_with_bad_entitlement_ends_the_server_session() {
        let r = rig();
        let other = SigningKey::from_bytes(&[99u8; 32]);
        let ent = mint(&other, &payload("pro", &r.store.device_id(), NOW + DAY));
        r.http.push(
            200,
            &format!(r#"{{"sessionToken":"pls_x","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#),
        );
        r.http.push(204, "");
        let e = r.store.complete_sign_in("gho".into(), "M", NOW).unwrap_err();
        assert_eq!(e.code, ErrorCode::BadEntitlement);
        let seen = r.http.seen();
        assert_eq!((seen[1].0, seen[1].2.as_deref()), (Method::Delete, Some("pls_x")));
        assert!(!r.store.info_at(NOW).signed_in);
        assert!(r.secrets.map.lock().unwrap().is_empty());
    }

    #[test]
    fn sign_in_with_keychain_refusal_is_a_keychain_error() {
        let r = rig();
        r.secrets.fail_set.store(true, Ordering::SeqCst);
        let ent = r.token("free", NOW + DAY);
        r.http.push(
            200,
            &format!(r#"{{"sessionToken":"pls_x","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#),
        );
        r.http.push(204, "");
        assert_eq!(r.store.complete_sign_in("gho".into(), "M", NOW).unwrap_err().code, ErrorCode::Keychain);
        assert!(!r.store.info_at(NOW).signed_in);
    }

    #[test]
    fn sign_in_server_errors_are_typed() {
        let r = rig();
        r.http.push(401, r#"{"error":"github_token_invalid","message":"Not our token."}"#);
        let e = r.store.complete_sign_in("gho".into(), "M", NOW).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::GithubTokenInvalid, "Not our token."));
        r.http.push(429, "");
        assert_eq!(r.store.complete_sign_in("gho".into(), "M", NOW).unwrap_err().code, ErrorCode::RateLimited);
        r.http.push(502, "<html>bad gateway</html>");
        assert_eq!(r.store.complete_sign_in("gho".into(), "M", NOW).unwrap_err().code, ErrorCode::Server);
        r.http.push_err();
        assert_eq!(r.store.complete_sign_in("gho".into(), "M", NOW).unwrap_err().code, ErrorCode::Network);
    }

    // ── Refresh ──

    #[test]
    fn refresh_applies_a_new_plan_with_device_header() {
        let r = rig();
        r.sign_in("free", NOW + DAY);
        let ent = r.token("team", NOW + 40 * DAY);
        r.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        let info = r.store.refresh_at(NOW + 1000).unwrap();
        assert_eq!(info.plan, Plan::Team);
        assert_eq!(info.last_checked_at, Some(NOW + 1000));
        assert!(!info.offline);
        let seen = r.http.seen();
        let get = &seen[1];
        assert_eq!((get.0, get.1.as_str()), (Method::Get, "http://api.test/v1/entitlement"));
        assert_eq!(get.2.as_deref(), Some("pls_secret"));
        assert_eq!(
            get.3,
            vec![("X-Plyloft-Device", r.store.device_id()), (TEAM_CHOICE_HEADER, "1".to_string())]
        );
        // The sign-in sent the capability too (A5 §4), with no device header.
        assert_eq!(seen[0].3, vec![(TEAM_CHOICE_HEADER, "1".to_string())]);
        // An older server's answer: no `team` field to read, and it is noted;
        // the verified Team plan still says the seat is here.
        assert_eq!(
            info.team,
            Some(AccountTeam { state: TeamState::Here, device: None, team_repo: None, role: None })
        );
        assert_eq!(r.store.server_knows_team_choice(), Some(false));
        assert_eq!(info.last_known_plan, Some(Plan::Team));
    }

    const ELSEWHERE: &str = r#"{"active":"elsewhere","teamRepo":"acme/board","teamRole":"member","device":{"name":"Mac mini","platform":"macos","lastSeen":1764150000000}}"#;
    const NOWHERE: &str = r#"{"active":"nowhere","teamRepo":null,"teamRole":"owner","device":null}"#;

    /// 1.178.0 (A5 §5): a new server's `team` field, mapped to the app's
    /// shape, kept in `account.json` and read again after a restart.
    #[test]
    fn a_new_server_says_where_team_runs_and_it_is_kept() {
        let r = rig();
        let info = r.sign_in_new("free", NOW + 30 * DAY, ELSEWHERE);
        assert_eq!(info.plan, Plan::Free);
        assert_eq!(
            info.team,
            Some(AccountTeam {
                state: TeamState::Elsewhere,
                device: Some("Mac mini".into()),
                team_repo: Some("acme/board".into()),
                role: Some(TeamRole::Member),
            })
        );
        assert_eq!(r.store.server_knows_team_choice(), Some(true));
        assert_eq!(r.file()["team"]["state"], "elsewhere");
        assert!(r.file().get("replacedBy").is_none());
        let again = rig_in(r._dir);
        assert_eq!(again.store.info_at(NOW).team.as_ref().map(|t| t.state), Some(TeamState::Elsewhere));
        // Ready on no computer: no device, an owner without a repository yet.
        again.secrets.map.lock().unwrap().insert(again.store.device_id(), "pls_secret".into());
        let ent = again.token("free", NOW + 30 * DAY);
        again.http.push_new(200, &format!(r#"{{"entitlement":"{ent}","team":{NOWHERE}}}"#));
        let info = again.store.refresh_at(NOW + 1).unwrap();
        assert_eq!(
            info.team,
            Some(AccountTeam { state: TeamState::Nowhere, device: None, team_repo: None, role: Some(TeamRole::Owner) })
        );
        // No Team plan or seat any more: the field goes.
        again.http.push_new(200, &format!(r#"{{"entitlement":"{ent}","team":null}}"#));
        assert_eq!(again.store.refresh_at(NOW + 2).unwrap().team, None);
        // Unreadable shapes read as no team.
        for odd in [r#"{"active":"somewhere"}"#, r#""here""#, "[]", r#"{"teamRepo":"a/b"}"#] {
            assert_eq!(team_of(Some(&serde_json::from_str(odd).unwrap())), None, "{odd}");
        }
    }

    /// An older server (no echo) sends no `team`; one it carried anyway is
    /// not read. A verified Team plan reads as "here" against either server.
    #[test]
    fn an_old_servers_team_field_is_never_read() {
        let r = rig();
        let ent = r.token("free", NOW + DAY);
        r.http.push(
            200,
            &format!(r#"{{"sessionToken":"s","entitlement":"{ent}","account":{{"sub":"1","login":"a"}},"team":{ELSEWHERE}}}"#),
        );
        let info = r.store.complete_sign_in("g".into(), "M", NOW).unwrap();
        assert_eq!(info.team, None);
        assert_eq!(r.store.server_knows_team_choice(), Some(false));
        let team = mint(
            &r.sk,
            &format!(
                r#"{{"v":2,"sub":"1","login":"a","plan":"team","teamRepo":"acme/board","teamRole":"owner","deviceId":"{}","iat":{NOW},"exp":{},"periodEnd":null,"status":"active","comp":false}}"#,
                r.store.device_id(),
                NOW + DAY
            ),
        );
        r.http.push(200, &format!(r#"{{"entitlement":"{team}"}}"#));
        let info = r.store.refresh_at(NOW + 1).unwrap();
        assert_eq!(
            info.team,
            Some(AccountTeam {
                state: TeamState::Here,
                device: None,
                team_repo: Some("acme/board".into()),
                role: Some(TeamRole::Owner),
            })
        );
    }

    /// Owner D3: a session revoked as `replaced` before the new server's
    /// deploy is taken back silently — one reclaim, with the capability
    /// header, no GitHub code, the rotated token kept, nothing shown.
    #[test]
    fn a_replaced_session_on_a_new_server_is_taken_back_silently() {
        let r = rig();
        r.sign_in("team", NOW + 30 * DAY);
        r.http.push_new(
            409,
            r#"{"error":"replaced","message":"Your plan moved to another computer (PC).","deviceName":"PC","reclaimable":true}"#,
        );
        r.http.push_new(
            200,
            &format!(
                r#"{{"sessionToken":"pls_rotated","entitlement":"{}","account":{{"sub":"1","login":"octocat"}},"team":{ELSEWHERE}}}"#,
                r.token("free", NOW + 30 * DAY)
            ),
        );
        let info = r.store.refresh_at(NOW + 1).unwrap();
        assert!(info.signed_in && info.entitlement_valid);
        assert_eq!(info.plan, Plan::Free);
        assert_eq!(info.team.as_ref().map(|t| t.state), Some(TeamState::Elsewhere));
        assert_eq!(info.last_known_plan, Some(Plan::Free));
        assert_eq!(info.last_checked_at, Some(NOW + 1));
        let seen = r.http.seen();
        assert_eq!(seen.len(), 3, "sign-in, refresh, one reclaim; nothing to GitHub");
        let (method, url, bearer, headers, body) = seen[2].clone();
        assert_eq!(method, Method::Post);
        assert!(url.ends_with("/session/reclaim"), "{url}");
        assert_eq!(bearer.as_deref(), Some("pls_secret"));
        assert!(headers.contains(&("X-Plyloft-Device", r.store.device_id())));
        assert!(headers.contains(&(TEAM_CHOICE_HEADER, "1".to_string())));
        assert!(body.is_empty());
        let device = r.store.device_id();
        assert_eq!(r.secrets.map.lock().unwrap().get(&device).map(String::as_str), Some("pls_rotated"));
        let json = serde_json::to_value(&info).unwrap();
        assert!(json.get("replacedBy").is_none(), "no replaced state on the wire");
    }

    /// The silent reclaim is bounded: once per retry window, whatever its
    /// answer; one that doesn't go through (rate limited, offline) leaves the
    /// account signed in on Free and the next refresh asks again.
    #[test]
    fn the_silent_reclaim_runs_once_per_window_and_a_failure_stays_signed_in() {
        let r = rig();
        r.sign_in("team", NOW + 30 * DAY);
        let replaced = r#"{"error":"replaced","message":"Moved.","deviceName":"PC","reclaimable":true}"#;
        r.http.push_new(409, replaced);
        r.http.push_new(429, r#"{"error":"rate_limited","message":"Too many requests."}"#);
        let info = r.store.refresh_at(NOW + 1).unwrap();
        assert!(info.signed_in && !info.entitlement_valid);
        assert_eq!(info.plan, Plan::Free);
        assert_eq!(info.last_known_plan, Some(Plan::Team), "kept for the Team notices");
        assert!(r.file()["entitlement"].is_null(), "a Team token must not outlive the move");
        let device = r.store.device_id();
        assert_eq!(r.secrets.map.lock().unwrap().get(&device).map(String::as_str), Some("pls_secret"));
        // Inside the window: the server is asked (no shortcut), no reclaim.
        let before = r.http.seen().len();
        r.http.push_new(409, replaced);
        assert!(r.store.refresh_at(NOW + 2).unwrap().signed_in);
        assert_eq!(r.http.seen().len(), before + 1, "one GET, no reclaim");
        // Past it: one more try (offline this time), still signed in.
        r.http.push_new(409, replaced);
        r.http.push_err();
        assert!(r.store.refresh_at(NOW + 1 + OFFLINE_RETRY_MS).unwrap().signed_in);
        assert_eq!(r.http.seen().len(), before + 3);
        assert!(r.http.seen().last().unwrap().1.ends_with("/session/reclaim"));
    }

    /// A new server that says the session can't come back, or refuses the
    /// reclaim as `unauthorized`, closed it: signed out quietly, as any
    /// `unauthorized` is (a signed-out profile is no state to repair).
    #[test]
    fn a_new_servers_closed_replaced_session_signs_out_quietly() {
        let r = rig();
        r.sign_in("team", NOW + 30 * DAY);
        r.http.push_new(409, r#"{"error":"replaced","message":"Moved.","deviceName":"PC","reclaimable":false}"#);
        let info = r.store.refresh_at(NOW + 1).unwrap();
        assert!(!info.signed_in);
        assert_eq!((info.plan, info.last_known_plan, info.team.clone()), (Plan::Free, None, None));
        assert!(r.secrets.map.lock().unwrap().is_empty());
        assert_eq!(r.http.seen().len(), 2, "no reclaim asked");

        let r = rig();
        r.sign_in("team", NOW + 30 * DAY);
        r.http.push_new(409, r#"{"error":"replaced","message":"Moved.","reclaimable":true}"#);
        r.http.push_new(401, r#"{"error":"unauthorized","message":"This computer can't take the plan back by itself any more. Sign in again."}"#);
        assert!(!r.store.refresh_at(NOW + 1).unwrap().signed_in);
        assert!(r.secrets.map.lock().unwrap().is_empty());
    }

    /// An older server (a rollback) that answers `replaced`: no silent
    /// reclaim there (it would take the plan from the other computer and the
    /// two would bounce it). Signed in on Free, the session kept, and every
    /// refresh asks the server again.
    #[test]
    fn an_old_servers_replaced_keeps_the_account_on_free_and_never_reclaims() {
        let r = rig();
        r.sign_in("team", NOW + 30 * DAY);
        let replaced = r#"{"error":"replaced","message":"Your plan moved to PC.","deviceName":"PC","reclaimable":true}"#;
        r.http.push(409, replaced);
        let info = r.store.refresh_at(NOW + 1).unwrap();
        assert!(info.signed_in && !info.entitlement_valid);
        assert_eq!(info.plan, Plan::Free);
        assert_eq!(info.team, None);
        assert_eq!(r.http.seen().len(), 2, "no reclaim");
        let device = r.store.device_id();
        assert_eq!(r.secrets.map.lock().unwrap().get(&device).map(String::as_str), Some("pls_secret"));
        r.http.push(409, replaced);
        r.store.refresh_at(NOW + 1 + REFRESH_EVERY_MS).unwrap();
        assert_eq!(r.http.seen().len(), 3, "asked again, still no reclaim");
        // A billing call's `replaced` is handled the same way.
        r.http.push(409, replaced);
        assert_eq!(r.store.api_send(Method::Get, "/team", None).unwrap_err().code, ErrorCode::Replaced);
        assert!(r.store.info().signed_in);
        assert_eq!(r.http.seen().len(), 4);
    }

    /// 1.178.0: Use Team on this computer — one POST with the session and
    /// the capability header; the new plan and `team` are kept.
    #[test]
    fn use_team_moves_team_here() {
        let r = rig();
        r.sign_in_new("free", NOW + 30 * DAY, NOWHERE);
        let ent = r.token("team", NOW + 14 * DAY);
        r.http.push_new(
            200,
            &format!(r#"{{"entitlement":"{ent}","team":{{"active":"here","teamRepo":null,"teamRole":"owner","device":null}}}}"#),
        );
        let info = r.store.use_team_at(NOW + 5).unwrap();
        assert!(info.entitlement_valid);
        assert_eq!(info.plan, Plan::Team);
        assert_eq!(info.last_known_plan, Some(Plan::Team));
        assert_eq!(info.last_checked_at, Some(NOW + 5));
        assert_eq!(info.team.as_ref().map(|t| t.state), Some(TeamState::Here));
        let (method, url, bearer, headers, body) = r.http.seen().last().unwrap().clone();
        assert_eq!(method, Method::Post);
        assert_eq!(url, "http://api.test/v1/session/use-team");
        assert_eq!(bearer.as_deref(), Some("pls_secret"));
        assert_eq!(headers, vec![("X-Plyloft-Device", r.store.device_id()), (TEAM_CHOICE_HEADER, "1".to_string())]);
        assert!(body.is_empty());
    }

    #[test]
    fn use_team_errors_are_typed_and_signed_out_sends_nothing() {
        let r = rig();
        assert_eq!(r.store.use_team_at(NOW).unwrap_err().code, ErrorCode::Unauthorized);
        assert!(r.http.seen().is_empty());
        r.sign_in_new("free", NOW + 30 * DAY, NOWHERE);
        // Offline and rate limited: the state is left alone.
        r.http.push_err();
        assert_eq!(r.store.use_team_at(NOW).unwrap_err().code, ErrorCode::Network);
        r.http.push_new(429, r#"{"error":"rate_limited","message":"Too many requests."}"#);
        assert_eq!(r.store.use_team_at(NOW).unwrap_err().code, ErrorCode::RateLimited);
        assert_eq!(r.store.info_at(NOW).team.as_ref().map(|t| t.state), Some(TeamState::Nowhere));
        // No Team plan any more: typed, and the button's reason goes.
        r.http.push_new(409, r#"{"error":"no_team","message":"Your account has no Team plan right now."}"#);
        let e = r.store.use_team_at(NOW).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NoTeam, "Your account has no Team plan right now."));
        let info = r.store.info_at(NOW);
        assert!(info.signed_in && info.team.is_none());
        assert_eq!(serde_json::to_value(ErrorCode::NoTeam).unwrap(), "no_team");
        // A closed session: signed out, as a refresh does.
        r.http.push_new(401, r#"{"error":"unauthorized","message":"Please sign in again."}"#);
        assert_eq!(r.store.use_team_at(NOW).unwrap_err().code, ErrorCode::Unauthorized);
        assert!(!r.store.info_at(NOW).signed_in);
    }

    #[test]
    fn sign_out_others_posts_and_reads_the_count() {
        let r = rig();
        r.sign_in("pro", NOW + 30 * DAY);
        r.http.push_new(200, r#"{"signedOut":2}"#);
        assert_eq!(r.store.sign_out_others().unwrap(), 2);
        let (method, url, bearer, headers, _) = r.http.seen().last().unwrap().clone();
        assert_eq!(method, Method::Post);
        assert!(url.ends_with("/sessions/others/sign-out"));
        assert_eq!(bearer.as_deref(), Some("pls_secret"));
        assert!(headers.contains(&(TEAM_CHOICE_HEADER, "1".to_string())));
        assert!(r.store.info().signed_in);
    }

    /// Schema (1.178.0, backward compatible): files written by 1.167–1.177
    /// with `replacedBy` still load. Signed out: signed out. Signed in: signed
    /// in on Free, and the next refresh asks the server again (no shortcut).
    /// Either way the file is written back without `replacedBy`.
    #[test]
    fn replaced_files_of_1_167_to_1_177_load_and_ask_the_server_again() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(ACCOUNT_FILE),
            r#"{"schemaVersion":1,"deviceId":"0123456789abcdef0123456789abcdef","deviceName":"Mac","replacedBy":"Old PC"}"#,
        )
        .unwrap();
        let old = read_only_info(dir.path(), NOW);
        assert!(!old.signed_in);
        assert_eq!((old.last_known_plan, old.team.clone()), (None, None));
        let r = rig_in(dir);
        assert!(!r.store.info_at(NOW).signed_in);
        assert!(r.file().get("replacedBy").is_none(), "written back without it");
        assert!(!r.store.refresh_at(NOW).unwrap().signed_in && r.http.seen().is_empty(), "signed out needs no network");

        std::fs::write(
            r.dir.join(ACCOUNT_FILE),
            r#"{"schemaVersion":1,"deviceId":"0123456789abcdef0123456789abcdef","deviceName":"Mac","account":{"sub":"1","login":"octocat"},"entitlement":null,"lastCheckedAt":5,"replacedBy":"Old PC"}"#,
        )
        .unwrap();
        let r = rig_in(r._dir);
        let info = r.store.info_at(NOW);
        assert!(info.signed_in && !info.entitlement_valid);
        assert_eq!(info.plan, Plan::Free);
        assert!(r.file().get("replacedBy").is_none());
        assert_eq!(r.file()["account"]["login"], "octocat");
        r.secrets.map.lock().unwrap().insert(r.store.device_id(), "pls_old".into());
        let ent = r.token("pro", NOW + DAY);
        r.http.push_new(200, &format!(r#"{{"entitlement":"{ent}","team":null}}"#));
        let info = r.store.refresh_at(NOW).unwrap();
        assert!(info.entitlement_valid);
        assert_eq!(info.plan, Plan::Pro);
        assert_eq!(r.http.seen().len(), 1, "asked the server");
    }

    /// Schema (1.178.0): a file without `lastKnownPlan` or `team` reads them
    /// as absent; its cached token, read past its `exp`, still gives the last
    /// known plan. Unreadable values default.
    #[test]
    fn files_without_the_new_fields_read_defaults() {
        let r = rig();
        r.sign_in("team", NOW + DAY);
        let mut file = r.file();
        let obj = file.as_object_mut().unwrap();
        obj.remove("lastKnownPlan");
        obj.remove("team");
        std::fs::write(r.dir.join(ACCOUNT_FILE), file.to_string()).unwrap();
        let r = rig_in(r._dir);
        let expired = r.store.info_at(NOW + 2 * DAY);
        assert!(expired.signed_in && !expired.entitlement_valid);
        assert_eq!(expired.plan, Plan::Free);
        assert_eq!(expired.last_known_plan, Some(Plan::Team), "from the cached token");
        assert_eq!(expired.team, None);
        let mut file = r.file();
        file["entitlement"] = serde_json::Value::Null;
        file["lastKnownPlan"] = "gold".into();
        file["team"] = serde_json::json!({"state": 3});
        std::fs::write(r.dir.join(ACCOUNT_FILE), file.to_string()).unwrap();
        let r = rig_in(r._dir);
        let info = r.store.info_at(NOW);
        assert!(info.signed_in);
        assert_eq!((info.last_known_plan, info.team), (None, None));
    }

    /// The last known plan outlives the entitlement's `exp` and an offline
    /// spell, and goes at sign-out with the `team` field.
    #[test]
    fn the_last_known_plan_outlives_expiry_and_goes_at_sign_out() {
        let r = rig();
        r.sign_in_new("team", NOW + DAY, r#"{"active":"here","teamRepo":"acme/board","teamRole":"member","device":null}"#);
        assert_eq!(r.file()["lastKnownPlan"], "team");
        r.http.push_err();
        let info = r.store.refresh_at(NOW + 2 * DAY).unwrap();
        assert!(info.offline && !info.entitlement_valid);
        assert_eq!((info.plan, info.last_known_plan), (Plan::Free, Some(Plan::Team)));
        assert_eq!(info.team.as_ref().map(|t| t.state), Some(TeamState::Here), "the last answer's");
        r.http.push_new(204, "");
        let out = r.store.sign_out_at(NOW + 2 * DAY);
        assert!(!out.signed_in);
        assert_eq!((out.plan, out.last_known_plan, out.team), (Plan::Free, None, None));
        assert!(r.file()["lastKnownPlan"].is_null() && r.file()["team"].is_null());
        // A Free sign-in remembers Free.
        assert_eq!(r.sign_in("free", NOW + DAY).last_known_plan, Some(Plan::Free));
    }

    #[test]
    fn a_bare_401_is_transient_not_a_sign_out() {
        let r = rig();
        r.sign_in("pro", NOW + DAY);
        r.http.push(401, "<html>captive portal</html>");
        let info = r.store.refresh_at(NOW).unwrap();
        assert!(info.signed_in && info.offline);
        assert_eq!(info.plan, Plan::Pro);
    }

    #[test]
    fn the_dev_sign_in_skip_takes_only_1_and_never_a_release() {
        assert!(skip_value_allows(Some("1")));
        for v in [None, Some("0"), Some("true"), Some("yes"), Some(" 1"), Some("")] {
            assert!(!skip_value_allows(v), "{v:?}");
        }
        // Through a reader, never by setting the process environment
        // (which would race with every other test reading it).
        #[cfg(debug_assertions)]
        {
            assert!(dev_skip_from(|n| (n == DEV_SKIP_SIGNIN_ENV).then(|| "1".to_string())));
            assert!(!dev_skip_from(|n| (n == DEV_SKIP_SIGNIN_ENV).then(|| "0".to_string())));
            assert!(!dev_skip_from(|_| None));
        }
        // A release test run (`cargo test --release`) never skips.
        if !cfg!(debug_assertions) {
            assert!(!dev_skip_sign_in());
        }
    }

    /// The release build's source: the skip's env read sits only behind
    /// `debug_assertions`, and the release branch is a plain `false`.
    #[test]
    fn the_dev_sign_in_skip_is_compiled_out_of_release() {
        let src = include_str!("account.rs");
        let start = src.find("pub fn dev_skip_sign_in() -> bool {").expect("the fn");
        let body = &src[start..start + src[start..].find("\n}\n").expect("its end")];
        let release = body.split("#[cfg(not(debug_assertions))]").nth(1).expect("a release branch");
        assert_eq!(release.split_whitespace().collect::<String>(), "{false}");
        let debug = body.split("#[cfg(not(debug_assertions))]").next().unwrap();
        assert!(debug.contains("#[cfg(debug_assertions)]") && debug.contains("dev_skip_from(env_nonempty)"));
        let from = src.find("fn dev_skip_from(").expect("the reader");
        assert!(src[..from].trim_end().ends_with("#[cfg(debug_assertions)]"), "the reader exists only in debug builds");
    }

    #[test]
    fn debug_and_release_keep_separate_accounts() {
        assert_ne!(ACCOUNT_FILE_DEV, ACCOUNT_FILE_RELEASE);
        assert_ne!(KEYRING_SERVICE_DEV, KEYRING_SERVICE_RELEASE);
        assert_eq!(ACCOUNT_FILE_RELEASE, "account.json");
        if cfg!(debug_assertions) {
            assert_eq!((ACCOUNT_FILE, KEYRING_SERVICE), (ACCOUNT_FILE_DEV, KEYRING_SERVICE_DEV));
        } else {
            assert_eq!((ACCOUNT_FILE, KEYRING_SERVICE), (ACCOUNT_FILE_RELEASE, KEYRING_SERVICE_RELEASE));
        }
    }

    #[test]
    fn device_name_is_trimmed_and_cut_to_100_chars_on_a_char_boundary() {
        assert_eq!(clean_device_name("  Mac  "), "Mac");
        let long = "é".repeat(150);
        assert_eq!(clean_device_name(&long).chars().count(), 100);
        assert_eq!(clean_device_name(&format!("{} x", "a".repeat(99))), "a".repeat(99));
        let r = rig();
        let ent = r.token("free", NOW + DAY);
        r.http.push(
            200,
            &format!(r#"{{"sessionToken":"s","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#),
        );
        let info = r.store.complete_sign_in("g".into(), &format!("  {long}  "), NOW).unwrap();
        assert_eq!(info.device_name.unwrap().chars().count(), 100);
        let body: serde_json::Value = serde_json::from_str(&r.http.seen()[0].4).unwrap();
        let sent = body["deviceName"].as_str().unwrap();
        assert!(!sent.is_empty() && sent.chars().count() <= 100, "{sent}");
    }

    /// 1.175.0 (E-app, contract §6a): a plan that arrives already past its
    /// `exp` because this computer's clock is more than ten minutes from
    /// the server's (`iat`, its own time when it signed) says to check the
    /// date and time; any other refusal keeps its sentence. The token is
    /// refused either way: only the words change.
    #[test]
    fn a_plan_refused_because_of_the_clock_says_so() {
        let sign_in_at = |exp: i64, now: i64| {
            let r = rig();
            let ent = r.token("pro", exp);
            r.http.push(200, &format!(r#"{{"sessionToken":"s","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#));
            r.http.push(200, ""); // the session it won't keep is ended
            r.store.complete_sign_in("g".into(), "Test Mac", now).unwrap_err()
        };
        // Issued at NOW for 14 days; this computer thinks it is 20 days later.
        let e = sign_in_at(NOW + 14 * DAY, NOW + 20 * DAY);
        assert_eq!(e.code, ErrorCode::BadEntitlement);
        assert_eq!(e.message, CLOCK_OFF);
        assert!(e.message.contains("date and time") && e.message.contains(crate::this_machine!()), "{}", e.message);
        // A token that really ran out on arrival (the server's own clock):
        // the sentence stays the plan's.
        let e = sign_in_at(NOW + 1, NOW + 2);
        assert_eq!(e.message, "Plyloft couldn't verify the plan the server sent.");
        // A token that fails for anything else, whatever the clock.
        let r = rig();
        let other = mint(&r.sk, &payload("pro", "ffffffffffffffffffffffffffffffff", NOW + DAY));
        r.http.push(200, &format!(r#"{{"sessionToken":"s","entitlement":"{other}","account":{{"sub":"1","login":"a"}}}}"#));
        r.http.push(200, "");
        let e = r.store.complete_sign_in("g".into(), "Test Mac", NOW + 20 * DAY).unwrap_err();
        assert_eq!(e.message, "Plyloft couldn't verify the plan the server sent.");
        // The pure rule.
        let r = rig();
        let t = r.token("pro", NOW + 14 * DAY);
        assert!(clock_is_off(&t, NOW + 15 * DAY));
        assert!(!clock_is_off(&t, NOW + 13 * DAY), "not expired: nothing to explain");
        assert!(!clock_is_off(&r.token("pro", NOW + 60_000), NOW + 120_000), "a minute past exp, seconds after iat: the plan");
        assert!(!clock_is_off("garbage", NOW));
    }

    /// 1.175.0 (E3, SRV-4): the full name of this computer never leaves it.
    /// A Mac sends its name without the owner, a PC the platform's word;
    /// never an empty name (a server older than 1.175.0 requires one).
    #[test]
    fn a_sign_in_sends_the_short_name_never_the_computers_own() {
        if std::env::var("PLYLOFT_DEVICE_NAME").is_ok() {
            return;
        }
        for (raw, sent) in [
            ("Matteo's MacBook Pro", "MacBook Pro"),
            ("Matteo\u{2019}s Mac mini", "Mac mini"),
            ("Mac mini di Marta", "Mac mini"),
            ("matteos-MacBook-Pro.local", "MacBook Pro"),
            ("iMac", "iMac"),
            // Round 2: a name with no model never goes out.
            ("MacBook-Pro-di-Matteo", "MacBook Pro"),
            ("Matteo\u{2019}s MacBook Pro (2)", "MacBook Pro"),
            ("Studio di Marta", "Mac"),
            ("Matteo", "Mac"),
            // The app's own fallback when the system gave no name.
            ("Mac", "Mac"),
            ("", "Mac"),
            ("   ", "Mac"),
        ] {
            assert_eq!(sent_device_name(raw, "macos"), sent, "{raw:?}");
        }
        // A PC's name (COMPUTERNAME) is often its owner's: the word alone.
        for raw in ["MARTA-PC", "DESKTOP-4F2K9QH", "Windows PC", ""] {
            assert_eq!(sent_device_name(raw, "windows"), "Windows PC", "{raw:?}");
        }
        assert_eq!(sent_device_name("matteo-thinkpad", "linux"), "Computer");
        // Through the sign-in: sent short, kept whole here.
        let r = rig();
        let ent = r.token("free", NOW + DAY);
        r.http.push(200, &format!(r#"{{"sessionToken":"s","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#));
        let info = r.store.complete_sign_in("g".into(), "Matteo's MacBook Pro", NOW).unwrap();
        assert_eq!(info.device_name.as_deref(), Some("Matteo's MacBook Pro"), "This device shows the computer's own name");
        let body: serde_json::Value = serde_json::from_str(&r.http.seen()[0].4).unwrap();
        assert_eq!(body["deviceName"].as_str(), Some(sent_device_name("Matteo's MacBook Pro", platform_name()).as_str()));
        assert_ne!(body["deviceName"], "Matteo's MacBook Pro");
    }

    #[test]
    fn an_invalid_device_id_is_regenerated() {
        for bad in ["kept-id", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "6f1c-…"] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join(ACCOUNT_FILE), format!(r#"{{"deviceId":"{bad}"}}"#)).unwrap();
            let r = rig_in(dir);
            let id = r.store.device_id();
            assert!(valid_device_id(&id) && id != bad, "{bad}");
            assert_eq!(r.file()["deviceId"], id.as_str(), "written back");
        }
    }

    #[test]
    fn a_cancel_seen_after_waiting_for_net_sends_nothing() {
        let r = rig();
        let cancel = Stopper::default();
        cancel.stop();
        let e = r.store.complete_sign_in_unless("g".into(), "M", NOW, Some(&cancel)).unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        assert!(r.http.seen().is_empty());
    }

    #[test]
    fn a_cancel_during_post_session_ends_the_new_session() {
        // The cancel lands while POST /session is in flight: the fake stops
        // it as it answers.
        struct CancelOnSend {
            inner: Arc<FakeHttp>,
            cancel: Arc<Stopper>,
        }
        impl Http for CancelOnSend {
            fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String> {
                self.cancel.stop();
                self.inner.send(req)
            }
        }
        let (sk, vk) = keypair();
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let cancel = Arc::new(Stopper::default());
        let secrets = Arc::new(FakeSecrets::default());
        let store = AccountStore::with_parts(
            dir.path().to_path_buf(),
            Box::new(CancelOnSend { inner: http.clone(), cancel: cancel.clone() }),
            Box::new(secrets.clone()),
            endpoints(),
            Ok(vk),
        );
        let ent = mint(&sk, &payload("pro", &store.device_id(), NOW + DAY));
        http.push(200, &format!(r#"{{"sessionToken":"pls_new","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#));
        http.push(204, "");
        let e = store.complete_sign_in_unless("g".into(), "M", NOW, Some(&cancel)).unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        let seen = http.seen();
        assert_eq!((seen[1].0, seen[1].2.as_deref()), (Method::Delete, Some("pls_new")));
        assert!(!store.info_at(NOW).signed_in);
        assert!(secrets.map.lock().unwrap().is_empty());
    }

    #[test]
    fn sign_in_attempts_increase_and_events_carry_them() {
        let r = rig();
        let code_json = r#"{"device_code":"dc","user_code":"U","verification_uri":"v","expires_in":900,"interval":5}"#;
        r.http.push(200, code_json);
        r.http.push(200, code_json);
        let (_, first, a1) = r.store.begin_sign_in().unwrap();
        let (_, _, a2) = r.store.begin_sign_in().unwrap();
        assert!(a2 > a1);
        assert!(first.is_stopped(), "a new sign-in cancels the previous one");
        let ev = serde_json::to_value(SignInEvent { attempt: a1, progress: SignInProgress::Cancelled }).unwrap();
        assert_eq!(ev, serde_json::json!({"attempt": a1, "state": "cancelled"}));
        let ev = serde_json::to_value(SignInEvent { attempt: 3, progress: SignInProgress::Waiting { interval_secs: 5 } }).unwrap();
        assert_eq!(ev, serde_json::json!({"attempt": 3, "state": "waiting", "intervalSecs": 5}));
    }

    #[test]
    fn unauthorized_signs_out() {
        let r = rig();
        r.sign_in("pro", NOW + 30 * DAY);
        r.http.push(401, r#"{"error":"unauthorized","message":"Session revoked."}"#);
        let info = r.store.refresh_at(NOW + 1).unwrap();
        assert!(!info.signed_in);
        assert_eq!((info.last_known_plan, info.team.clone()), (None, None));
        assert_eq!(info.plan, Plan::Free);
    }

    #[test]
    fn offline_keeps_the_cached_plan_until_exp() {
        let r = rig();
        r.sign_in("pro", NOW + 3 * DAY);
        r.http.push_err();
        let info = r.store.refresh_at(NOW + DAY).unwrap();
        assert!(info.offline && info.signed_in && info.entitlement_valid);
        assert_eq!(info.plan, Plan::Pro);
        assert_eq!(info.last_checked_at, Some(NOW), "lastCheckedAt is the last answer");
        // A 5xx counts as offline too.
        r.http.push(503, "");
        assert!(r.store.refresh_at(NOW + DAY).unwrap().offline);
        // Past exp: still signed in, plan Free, no valid entitlement.
        let later = r.store.info_at(NOW + 3 * DAY);
        assert!(later.signed_in && !later.entitlement_valid);
        assert_eq!(later.plan, Plan::Free);
        assert_eq!(later.exp, None);
        // The next good answer clears offline.
        let ent = r.token("pro", NOW + 40 * DAY);
        r.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        let info = r.store.refresh_at(NOW + 3 * DAY).unwrap();
        assert!(!info.offline && info.entitlement_valid);
    }

    // ── Launch A3: the focus refresh's throttle ──

    #[test]
    fn focus_refresh_asks_at_most_once_a_minute() {
        let r = rig();
        r.sign_in("free", NOW + 30 * DAY);
        let asks = |r: &Rig| r.http.seen().iter().filter(|s| s.1.ends_with("/entitlement")).count();
        // Signing in is not a refresh: the first focus asks.
        let ent = r.token("pro", NOW + 40 * DAY);
        r.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        let info = r.store.refresh_on_focus_at(NOW + 1000).expect("asked").unwrap();
        assert_eq!(info.plan, Plan::Pro, "a plan bought on the site shows up on return");
        // A burst of focus events within the minute sends nothing.
        for dt in [1001, 2000, 30_000, 60_999] {
            assert!(r.store.refresh_on_focus_at(NOW + dt).is_none(), "{dt}");
        }
        assert_eq!(asks(&r), 1);
        // A minute after the last ask, it asks again.
        r.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        assert!(r.store.refresh_on_focus_at(NOW + 61_000).is_some());
        assert_eq!(asks(&r), 2);
    }

    #[test]
    fn any_refresh_counts_toward_the_focus_throttle() {
        let r = rig();
        r.sign_in("free", NOW + 30 * DAY);
        // "Check now" (or the 6 h tick) asked a moment ago: focus waits.
        let ent = r.token("free", NOW + 30 * DAY);
        r.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        r.store.refresh_at(NOW + 5000).unwrap();
        assert!(!r.store.claim_focus_refresh(NOW + 20_000));
        // An offline ask counts too: no hammering a server that isn't there.
        r.http.push_err();
        assert!(r.store.refresh_at(NOW + 70_000).unwrap().offline);
        assert!(!r.store.claim_focus_refresh(NOW + 100_000));
        assert!(r.store.claim_focus_refresh(NOW + 130_000));
    }

    #[test]
    fn a_focus_during_a_refresh_in_flight_is_told_no() {
        let r = Arc::new(rig());
        r.sign_in("free", NOW + 30 * DAY);
        let ent = r.token("free", NOW + 30 * DAY);
        r.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        // A refresh that waits for `net` (another server call running).
        let held = r.store.net.lock().unwrap();
        let worker = {
            let r = r.clone();
            std::thread::spawn(move || r.store.refresh_at(NOW + 1000).map(|_| ()))
        };
        while r.store.last_refresh_ask() != Some(NOW + 1000) {
            std::thread::yield_now();
        }
        assert!(!r.store.claim_focus_refresh(NOW + 2000), "the refresh in flight counts");
        drop(held);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn the_refresher_never_doubles_another_triggers_ask() {
        use RefresherStep::*;
        let min = FOCUS_REFRESH_MIN_MS;
        assert_eq!(refresher_step(NOW, false, None, None), Idle);
        assert_eq!(refresher_step(NOW, true, None, None), Refresh, "launch, nothing asked yet");
        // The first focus at launch asked a moment ago: wait for its answer.
        assert_eq!(refresher_step(NOW + 5, true, Some(NOW), None), Defer { at: NOW, until: NOW + min });
        // Its answer is in and nothing asked since: plan from it, no request.
        assert_eq!(refresher_step(NOW + min, true, Some(NOW), Some(NOW)), Adopt { at: NOW });
        // Something asked again meanwhile: defer to that one.
        assert_eq!(
            refresher_step(NOW + min, true, Some(NOW + min - 10), Some(NOW)),
            Defer { at: NOW + min - 10, until: NOW + 2 * min - 10 }
        );
        // An old ask, or a clock moved back: ask.
        assert_eq!(refresher_step(NOW + min, true, Some(NOW), None), Refresh);
        assert_eq!(refresher_step(NOW - 1000, true, Some(NOW), None), Refresh);
    }

    #[test]
    fn cancel_at_period_end_is_read_and_defaults_to_false() {
        let r = rig();
        let info = r.sign_in("pro", NOW + 30 * DAY);
        assert!(!info.cancel_at_period_end, "older tokens lack the field");
        let p = payload("pro", &r.store.device_id(), NOW + 40 * DAY)
            .replace(r#""comp":false}"#, r#""comp":false,"cancelAtPeriodEnd":true}"#);
        r.http.push(200, &format!(r#"{{"entitlement":"{}"}}"#, mint(&r.sk, &p)));
        let info = r.store.refresh_at(NOW + 1000).unwrap();
        assert!(info.entitlement_valid && info.cancel_at_period_end);
        assert_eq!(serde_json::to_value(&info).unwrap()["cancelAtPeriodEnd"], true);
    }

    #[test]
    fn concurrent_focus_events_claim_once() {
        let r = Arc::new(rig());
        r.sign_in("free", NOW + 30 * DAY);
        let wins: usize = (0..8)
            .map(|_| {
                let r = r.clone();
                std::thread::spawn(move || r.store.claim_focus_refresh(NOW + 1000))
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap() as usize)
            .sum();
        assert_eq!(wins, 1);
    }

    #[test]
    fn focus_refresh_signed_out_or_with_the_clock_moved_back() {
        let r = rig();
        // Signed out: never asks, and doesn't use up the minute.
        assert!(r.store.refresh_on_focus_at(NOW).is_none());
        assert!(r.http.seen().is_empty());
        r.sign_in("free", NOW + 30 * DAY);
        assert!(r.store.claim_focus_refresh(NOW));
        // The clock moved back past the last ask: not held against it.
        assert!(r.store.claim_focus_refresh(NOW - 10 * 60 * 1000));
    }

    #[test]
    fn a_bad_refreshed_entitlement_leaves_the_state_alone() {
        let r = rig();
        r.sign_in("pro", NOW + 30 * DAY);
        let wrong_device = mint(&r.sk, &payload("free", "someone-else", NOW + DAY));
        r.http.push(200, &format!(r#"{{"entitlement":"{wrong_device}"}}"#));
        assert_eq!(r.store.refresh_at(NOW + 1).unwrap_err().code, ErrorCode::BadEntitlement);
        assert_eq!(r.store.info_at(NOW + 1).plan, Plan::Pro);
    }

    #[test]
    fn refresh_without_keychain_entry_signs_out_and_signed_out_makes_no_request() {
        let r = rig();
        assert!(!r.store.refresh_at(NOW).unwrap().signed_in);
        assert!(r.http.seen().is_empty());
        r.sign_in("pro", NOW + DAY);
        r.secrets.map.lock().unwrap().clear();
        assert!(!r.store.refresh_at(NOW).unwrap().signed_in);
        assert_eq!(r.http.seen().len(), 1, "no GET without a token");
    }

    /// A Plyloft Test walk (skip-signin) asked the owner for the login
    /// keychain password at every launch and focus: its store answers with
    /// the placeholder session and never writes or removes anything.
    #[test]
    fn a_skip_signin_run_reads_the_placeholder_without_the_keychain() {
        let s = DevSkipSecrets;
        assert_eq!(s.get("device").unwrap().as_deref(), Some(DEV_SESSION_PLACEHOLDER));
        assert!(s.set("device", "pls_real").is_ok());
        assert_eq!(s.get("device").unwrap().as_deref(), Some(DEV_SESSION_PLACEHOLDER));
        assert!(s.delete("device").is_ok());
    }

    /// Team walks: only a verified plan on the placeholder session holds no
    /// seat. A real sign-in, a signed-out profile, an expired plan, or a plan
    /// that doesn't verify on a skip-signin run still go to the server.
    #[test]
    fn only_a_dev_loaded_plan_holds_no_seat() {
        let r = rig();
        assert!(!r.store.dev_plan_has_no_seats_at(NOW), "signed out");
        r.sign_in("team", NOW + DAY);
        assert!(!r.store.dev_plan_has_no_seats_at(NOW), "a real session, a valid plan");

        let r = rig();
        r.store.dev_load_entitlement_at(&r.token("team", NOW + DAY), NOW).unwrap();
        assert!(r.store.dev_plan_has_no_seats_at(NOW));
        assert!(!r.store.dev_plan_has_no_seats_at(NOW + DAY + 1), "expired");
        r.secrets.map.lock().unwrap().clear();
        assert!(!r.store.dev_plan_has_no_seats_at(NOW), "no placeholder session");

        // A skip-signin run over a plan another key signed (a real one): the
        // session is the placeholder, the plan doesn't verify.
        let real = rig();
        real.sign_in("team", NOW + DAY);
        let dev_key = SigningKey::from_bytes(&[9; 32]).verifying_key();
        let skip = AccountStore::with_parts(
            real.dir.clone(),
            Box::new(real.http.clone()),
            Box::new(DevSkipSecrets),
            endpoints(),
            Ok(dev_key),
        );
        assert!(!skip.dev_plan_has_no_seats_at(NOW), "signed by a key this run doesn't trust");
        // The same over the production key, when this build has one.
        if let Ok(production) = parse_pubkey_hex(ENTITLEMENT_PUBKEY_HEX) {
            let store = AccountStore::with_parts(
                real.dir.clone(),
                Box::new(real.http.clone()),
                Box::new(DevSkipSecrets),
                endpoints(),
                Ok(production),
            );
            assert!(!store.dev_plan_has_no_seats_at(NOW), "a run trusting the production key");
        }
        let unconfigured = AccountStore::with_parts(
            real.dir.clone(),
            Box::new(real.http.clone()),
            Box::new(DevSkipSecrets),
            endpoints(),
            Err("no key".into()),
        );
        assert!(!unconfigured.dev_plan_has_no_seats_at(NOW));
    }

    /// Launch G walks: the debug-only loader takes a token for this device,
    /// signs the profile in with its plan, sends nothing, keeps a placeholder
    /// session so an offline refresh keeps the plan — and refuses a token
    /// for another device or one already expired, writing nothing.
    #[test]
    fn the_dev_loader_takes_a_token_for_this_device_only() {
        let r = rig();
        let other = mint(&r.sk, &payload("team", "another-device", NOW + DAY));
        assert!(r.store.dev_load_entitlement_at(&other, NOW).unwrap_err().message.contains("another device"));
        let expired = r.token("pro", NOW - 1);
        assert!(r.store.dev_load_entitlement_at(&expired, NOW).is_err());
        assert!(!r.store.info_at(NOW).signed_in, "nothing written");

        let info = r.store.dev_load_entitlement_at(&format!("  {}  ", r.token("pro", NOW + DAY)), NOW).unwrap();
        assert!(info.signed_in && info.entitlement_valid);
        assert_eq!(info.plan, Plan::Pro);
        assert_eq!(info.login.as_deref(), Some("octocat"));
        assert!(r.http.seen().is_empty(), "no server, no GitHub");
        assert_eq!(r.file()["account"]["login"], "octocat");
        // A refresh never sends the placeholder to a server (it would answer
        // `unauthorized` and sign the profile out): it keeps the plan until
        // exp, and so does any other server call.
        let after = r.store.refresh_at(NOW + 1).unwrap();
        assert!(after.signed_in && after.entitlement_valid && after.plan == Plan::Pro);
        assert!(r.store.api_send(Method::Get, "/team", None).is_err());
        assert!(r.http.seen().is_empty(), "the placeholder never reaches a server");
        assert!(r.store.info_at(NOW + 1).signed_in, "still signed in");
        // Past exp it reads as Free (a lapse).
        assert_eq!(r.store.info_at(NOW + DAY).plan, Plan::Free);
    }

    #[test]
    fn sign_out_deletes_the_server_session_even_offline() {
        let r = rig();
        r.sign_in("pro", NOW + DAY);
        let device = r.store.device_id();
        r.http.push(204, "");
        let info = r.store.sign_out_at(NOW);
        assert!(!info.signed_in);
        let seen = r.http.seen();
        assert_eq!((seen[1].0, seen[1].1.as_str(), seen[1].2.as_deref()), (Method::Delete, "http://api.test/v1/session", Some("pls_secret")));
        assert_eq!(r.store.device_id(), device, "deviceId outlives a sign-out");
        r.sign_in("free", NOW + DAY);
        r.http.push_err();
        assert!(!r.store.sign_out_at(NOW).signed_in);
        assert!(r.secrets.map.lock().unwrap().is_empty());
    }

    // ── account.json ──

    #[test]
    fn missing_file_creates_a_device_id_once() {
        let r = rig();
        let id = r.store.device_id();
        assert_eq!(id.len(), 32);
        let file = r.file();
        assert_eq!(file["schemaVersion"], ACCOUNT_SCHEMA_VERSION);
        assert_eq!(file["deviceId"], id.as_str());
        let again = rig_in(r._dir);
        assert_eq!(again.store.device_id(), id);
        let info = again.store.info_at(NOW);
        assert!(!info.signed_in && !info.offline);
        assert_eq!(info.plan, Plan::Free);
    }

    #[test]
    fn old_and_partial_files_load_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        // A writer with no schemaVersion and only a device id.
        std::fs::write(dir.path().join(ACCOUNT_FILE), r#"{"deviceId":"0123456789abcdef0123456789abcdef"}"#).unwrap();
        let r = rig_in(dir);
        assert_eq!(r.store.device_id(), "0123456789abcdef0123456789abcdef");
        assert_eq!(r.file()["schemaVersion"], ACCOUNT_SCHEMA_VERSION, "stamped on load");
        // Wrong types for some fields, unknown extra fields, a future schema:
        // what is readable is kept, the rest defaults.
        std::fs::write(
            r.dir.join(ACCOUNT_FILE),
            r#"{"schemaVersion":7,"deviceId":"0123456789abcdef0123456789abcdef","deviceName":42,"account":{"sub":"1"},"lastCheckedAt":"yesterday","replacedBy":"Old Mac","future":true}"#,
        )
        .unwrap();
        let r = rig_in(r._dir);
        assert_eq!(r.store.device_id(), "0123456789abcdef0123456789abcdef");
        let info = r.store.info_at(NOW);
        assert!(!info.signed_in, "an account without login is no account");
        assert_eq!(info.device_name, None);
        assert_eq!(info.last_checked_at, None);
        assert_eq!((info.last_known_plan, info.team), (None, None));
        assert!(r.file().get("replacedBy").is_none(), "an older file's replacedBy is not written back");
    }

    #[test]
    fn corrupt_file_degrades_to_a_fresh_signed_out_state() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ACCOUNT_FILE), "{nope").unwrap();
        let r = rig_in(dir);
        assert!(!r.store.info_at(NOW).signed_in);
        assert_eq!(r.store.device_id().len(), 32);
        assert!(r.file().is_object(), "rewritten whole");
        // A JSON value that is not an object, too.
        std::fs::write(r.dir.join(ACCOUNT_FILE), "[1,2]").unwrap();
        let r = rig_in(r._dir);
        assert!(!r.store.info_at(NOW).signed_in);
    }

    #[test]
    fn a_tampered_cached_entitlement_reads_as_free() {
        let r = rig();
        r.sign_in("pro", NOW + DAY);
        let mut file = r.file();
        let forged = mint(&SigningKey::from_bytes(&[1u8; 32]), &payload("team", &r.store.device_id(), NOW + DAY));
        file["entitlement"] = forged.into();
        std::fs::write(r.dir.join(ACCOUNT_FILE), file.to_string()).unwrap();
        let r = rig_in(r._dir);
        let info = r.store.info_at(NOW);
        assert!(info.signed_in && !info.entitlement_valid);
        assert_eq!(info.plan, Plan::Free);
    }

    #[test]
    fn a_copied_account_file_does_not_carry_the_plan_to_another_device() {
        let r = rig();
        r.sign_in("pro", NOW + DAY);
        let mut file = r.file();
        file["deviceId"] = "another-machine".into();
        std::fs::write(r.dir.join(ACCOUNT_FILE), file.to_string()).unwrap();
        let r = rig_in(r._dir);
        assert_eq!(r.store.info_at(NOW).plan, Plan::Free);
    }

    #[test]
    fn info_serializes_camel_case_for_the_frontend() {
        let r = rig();
        let json = serde_json::to_value(r.sign_in("pro", NOW + DAY)).unwrap();
        for key in [
            "signedIn", "login", "sub", "plan", "teamRepo", "teamRole", "status", "periodEnd", "exp",
            "comp", "entitlementValid", "lastCheckedAt", "offline", "deviceName",
            "cancelAtPeriodEnd", "lastKnownPlan", "team",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(json.get("replacedBy").is_none(), "1.178.0: no replaced state on the wire");
        assert_eq!(json["lastKnownPlan"], "pro");
        assert!(json["team"].is_null());
        let team = AccountTeam {
            state: TeamState::Elsewhere,
            device: Some("Mac mini".into()),
            team_repo: Some("acme/board".into()),
            role: Some(TeamRole::Member),
        };
        assert_eq!(
            serde_json::to_value(&team).unwrap(),
            serde_json::json!({"state":"elsewhere","device":"Mac mini","teamRepo":"acme/board","role":"member"})
        );
        assert_eq!(json["plan"], "pro");
        let e = serde_json::to_value(AccountError::new(ErrorCode::GithubTokenInvalid, "x")).unwrap();
        assert_eq!(e, serde_json::json!({"code":"github_token_invalid","message":"x"}));
        let p = serde_json::to_value(SignInProgress::SlowDown { interval_secs: 10 }).unwrap();
        assert_eq!(p, serde_json::json!({"state":"slow_down","intervalSecs":10}));
    }

    #[test]
    fn no_pubkey_build_reads_everything_as_free_and_refuses_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let store = AccountStore::with_parts(
            dir.path().to_path_buf(),
            Box::new(http.clone()),
            Box::new(Arc::new(FakeSecrets::default())),
            endpoints(),
            Err("This build has no entitlement key yet.".into()),
        );
        let (sk, _) = keypair();
        let ent = mint(&sk, &payload("pro", &store.device_id(), NOW + DAY));
        http.push(200, &format!(r#"{{"sessionToken":"s","entitlement":"{ent}","account":{{"sub":"1","login":"a"}}}}"#));
        http.push(204, "");
        assert_eq!(store.complete_sign_in("g".into(), "M", NOW).unwrap_err().code, ErrorCode::NotConfigured);
    }

    #[test]
    fn form_encoding_escapes_reserved_characters() {
        assert_eq!(form_encode(&[("a", "x y:z/&".into())]), "a=x+y%3Az%2F%26");
    }
}
