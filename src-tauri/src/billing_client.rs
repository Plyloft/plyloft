//! Launch T1–T3: the app's billing and team calls to plyloft-server
//! (`docs/plans/LAUNCH_API.md`: `POST /checkout`, `POST /portal`,
//! `GET /team`, `POST /team`, `PUT` / `DELETE /team/seats/{sub}`).
//!
//! Every call goes through [`AccountStore::api_send`]: the session token
//! from the keychain, `X-Plyloft-Device`, the store's injectable HTTP (tests
//! use a fake), and the session ended there on `replaced` / `unauthorized`.
//! Errors are the contract's codes ([`ErrorCode`]); no token is ever logged.

use serde::{Deserialize, Serialize};

use crate::account::{AccountError, AccountStore, ErrorCode, Method};

/// LAUNCH_PLAN D9 / §3.4: a Team has 2–50 seats, the owner's included.
pub const TEAM_MIN_SEATS: u32 = 2;
pub const TEAM_MAX_SEATS: u32 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interval {
    Month,
    Year,
}

/// A GitHub account as the server names it: the numeric id and the login.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamAccount {
    pub sub: String,
    pub login: String,
}

/// `GET /team` (and the answer of `POST /team` and the seat calls).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    #[serde(default)]
    pub team_repo: Option<String>,
    pub owner: TeamAccount,
    /// Seats bought (the owner's included).
    pub seats: u32,
    /// Seat holders, the owner first.
    #[serde(default)]
    pub assigned: Vec<TeamAccount>,
    /// The Stripe status behind the team (`active`, `past_due`, `canceled`…).
    pub status: String,
    #[serde(default)]
    pub period_end: Option<i64>,
    /// The subscription's billing interval, when the server says (Renew
    /// keeps it); `None`: Renew asks.
    #[serde(default)]
    pub interval: Option<Interval>,
}

impl TeamView {
    /// D12: `active`, `trialing` and `past_due` keep the plan; anything else
    /// means the team's plan has ended.
    pub fn lapsed(&self) -> bool {
        !matches!(self.status.as_str(), "active" | "trialing" | "past_due")
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn holds_seat(&self, sub: &str) -> bool {
        self.assigned.iter().any(|a| a.sub == sub)
    }

    pub fn is_owner(&self, sub: &str) -> bool {
        self.owner.sub == sub
    }
}

#[derive(Deserialize)]
struct UrlAnswer {
    url: String,
}

fn unreadable(what: &str) -> AccountError {
    AccountError::new(ErrorCode::Server, format!("The Plyloft server sent an unreadable {what}."))
}

/// Stripe's own pages, per call: Checkout and the Customer Portal. A Stripe
/// custom domain (e.g. pay.plyloft.com) would have to be added here too.
pub const CHECKOUT_HOST: &str = "checkout.stripe.com";
pub const PORTAL_HOST: &str = "billing.stripe.com";
/// QoL 12.3: an invoice to pay for Switch to Team (3-D Secure, a declined card).
pub const INVOICE_HOST: &str = "invoice.stripe.com";

/// Only an `https://` page on `host` (exactly) is ever opened from a server
/// answer: no other scheme, host, port or credentials.
fn https_url(body: &str, what: &str, host: &str) -> Result<String, AccountError> {
    let answer: UrlAnswer = serde_json::from_str(body).map_err(|_| unreadable(what))?;
    let url = answer.url.trim().to_string();
    let rest = url.strip_prefix("https://").ok_or_else(|| unreadable(what))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if !authority.eq_ignore_ascii_case(host) {
        return Err(unreadable(what));
    }
    Ok(url)
}

/// A Stripe hosted invoice page: `https://invoice.stripe.com/…` exactly.
pub fn is_invoice_page(url: &str) -> bool {
    let Some(rest) = url.trim().strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority.eq_ignore_ascii_case(INVOICE_HOST)
}

fn team_of(body: &str) -> Result<TeamView, AccountError> {
    serde_json::from_str(body).map_err(|_| unreadable("team"))
}

/// A GitHub numeric id, as the server's path accepts it (`^[0-9]{1,20}$`).
pub fn valid_sub(sub: &str) -> bool {
    !sub.is_empty() && sub.len() <= 20 && sub.bytes().all(|b| b.is_ascii_digit())
}

fn bad_request(message: impl Into<String>) -> AccountError {
    AccountError::new(ErrorCode::BadRequest, message)
}

/// `POST /checkout`: the Stripe Checkout page for a Team, tied to this
/// account — the only plan the app sells. `seats` is 2–50 (`None`: the
/// minimum). `already_subscribed` when a paid subscription already runs.
pub fn checkout(store: &AccountStore, interval: Interval, seats: Option<u32>) -> Result<String, AccountError> {
    let seats = seats.unwrap_or(TEAM_MIN_SEATS);
    check_seats(seats)?;
    let body = serde_json::json!({ "plan": "team", "interval": interval, "seats": seats });
    let answer = store.api_send(Method::Post, "/checkout", Some(body))?;
    https_url(&answer, "checkout link", CHECKOUT_HOST)
}

/// `POST /portal`: the Stripe Customer Portal. `not_found` when this account
/// never had a subscription.
pub fn portal(store: &AccountStore) -> Result<String, AccountError> {
    let answer = store.api_send(Method::Post, "/portal", None)?;
    https_url(&answer, "billing link", PORTAL_HOST)
}

fn check_seats(seats: u32) -> Result<(), AccountError> {
    if !(TEAM_MIN_SEATS..=TEAM_MAX_SEATS).contains(&seats) {
        return Err(bad_request(format!("A team has {TEAM_MIN_SEATS} to {TEAM_MAX_SEATS} seats, yours included.")));
    }
    Ok(())
}

/// `GET /team`: the caller's team, as owner or seat holder; `None` when the
/// caller never had one (`not_found`). A lapsed team comes back with its
/// status.
pub fn team_get(store: &AccountStore) -> Result<Option<TeamView>, AccountError> {
    match store.api_send(Method::Get, "/team", None) {
        Ok(body) => team_of(&body).map(Some),
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `POST /team {teamRepo}`: bind the repository after paying (owner only).
/// Binding the same repository again answers the team; another one is
/// `already_bound`.
pub fn team_bind(store: &AccountStore, team_repo: &str) -> Result<TeamView, AccountError> {
    let repo = team_repo.trim();
    if !crate::team::is_valid_repo_slug(repo) {
        return Err(bad_request(format!("{repo} is not an owner/name repository.")));
    }
    let body = store.api_send(Method::Post, "/team", Some(serde_json::json!({ "teamRepo": repo })))?;
    team_of(&body)
}

/// `PUT /team/seats/{sub} {login}`: give `login` a seat (owner only).
/// Idempotent for someone who already holds one; `seat_limit` when every
/// seat is taken.
pub fn seat_put(store: &AccountStore, sub: &str, login: &str) -> Result<TeamView, AccountError> {
    if !valid_sub(sub) {
        return Err(bad_request("That is not a GitHub account id."));
    }
    if !crate::team_admin::is_valid_login(login) {
        return Err(bad_request(format!("{login:?} is not a GitHub login.")));
    }
    let body = store.api_send(
        Method::Put,
        &format!("/team/seats/{sub}"),
        Some(serde_json::json!({ "login": login.trim() })),
    )?;
    team_of(&body)
}

/// `DELETE /team/seats/{sub}`: free a seat (owner only). `Ok(None)` when they
/// held none (`not_found`): the seat is free either way.
pub fn seat_delete(store: &AccountStore, sub: &str) -> Result<Option<TeamView>, AccountError> {
    if !valid_sub(sub) {
        return Err(bad_request("That is not a GitHub account id."));
    }
    match store.api_send(Method::Delete, &format!("/team/seats/{sub}"), None) {
        Ok(body) => team_of(&body).map(Some),
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `DELETE /team/seat` (1.175.0 D5, SRV-2): the seat holder gives up their
/// own seat. Nothing names a team or an account: the seat is the session's.
/// `Ok(true)`: a seat was held and is free now; `Ok(false)`: the caller held
/// none (a second press, or the owner freed it meanwhile) — a success.
///
/// A server older than 1.175 doesn't know the route and answers `404
/// not_found`. That is an error here, **never** "already free" (which is why
/// the server says that case with a `200`): unlike [`seat_delete`], nothing
/// maps `NotFound` to a success.
pub fn seat_leave(store: &AccountStore) -> Result<bool, AccountError> {
    let body = store.api_send(Method::Delete, "/team/seat", None)?;
    #[derive(Deserialize)]
    struct Answer {
        left: bool,
    }
    serde_json::from_str::<Answer>(&body).map(|answer| answer.left).map_err(|_| unreadable("answer"))
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod test_support {
    //! A signed-in [`AccountStore`] over a fake network, for the billing and
    //! team-seat tests (here and in `team_billing.rs`).
    use crate::account::{
        AccountStore, Body, Endpoints, HttpRequest, HttpResponse, Http, Method, SecretStore,
    };
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    pub const NOW: i64 = 1_760_000_000_000;
    pub const DAY: i64 = 24 * 60 * 60 * 1000;

    /// One request as the fake saw it (no token is kept but the bearer, to
    /// check it is sent).
    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: Method,
        pub url: String,
        pub bearer: Option<String>,
        pub device: Option<String>,
        pub body: String,
    }

    #[derive(Default)]
    pub struct FakeHttp {
        answers: Mutex<VecDeque<Result<HttpResponse, String>>>,
        seen: Mutex<Vec<Seen>>,
    }

    impl FakeHttp {
        pub fn push(&self, status: u16, body: &str) {
            self.answers.lock().unwrap().push_back(Ok(HttpResponse::new(status, body)));
        }
        pub fn push_err(&self) {
            self.answers.lock().unwrap().push_back(Err("connection refused".into()));
        }
        pub fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }
        pub fn clear_seen(&self) {
            self.seen.lock().unwrap().clear();
        }
    }

    impl Http for Arc<FakeHttp> {
        fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String> {
            let body = match &req.body {
                Body::None => String::new(),
                Body::Json(v) => v.to_string(),
                Body::Form(_) => "<form>".into(),
            };
            self.seen.lock().unwrap().push(Seen {
                method: req.method,
                url: req.url.clone(),
                bearer: req.bearer.clone(),
                device: req.headers.iter().find(|(k, _)| *k == "X-Plyloft-Device").map(|(_, v)| v.clone()),
                body,
            });
            self.answers.lock().unwrap().pop_front().expect("an HTTP request the test did not expect")
        }
    }

    #[derive(Default)]
    pub struct FakeSecrets {
        map: Mutex<HashMap<String, String>>,
    }

    impl SecretStore for Arc<FakeSecrets> {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.map.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.map.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.map.lock().unwrap().remove(account);
            Ok(())
        }
    }

    pub struct Rig {
        pub _dir: tempfile::TempDir,
        pub http: Arc<FakeHttp>,
        pub store: AccountStore,
        sk: SigningKey,
    }

    impl Rig {
        /// A PLY2 token for this store's device. `team_repo` / `role` are
        /// JSON fragments (`null`, `"o/n"`, `"owner"`).
        pub fn token(&self, plan: &str, team_repo: &str, role: &str, comp: bool) -> String {
            let payload = format!(
                r#"{{"v":2,"sub":"1234567","login":"octocat","plan":"{plan}","teamRepo":{team_repo},"teamRole":{role},"deviceId":"{}","iat":{NOW},"exp":{},"periodEnd":null,"status":null,"comp":{comp}}}"#,
                self.store.device_id(),
                NOW + 30 * DAY
            );
            let sig = self.sk.sign(payload.as_bytes());
            format!(
                "PLY2-{}.{}",
                URL_SAFE_NO_PAD.encode(payload.as_bytes()),
                URL_SAFE_NO_PAD.encode(sig.to_bytes())
            )
        }

        /// Sign in with `plan` (the fake answers `POST /session`).
        pub fn sign_in(&self, plan: &str, team_repo: &str, role: &str, comp: bool) {
            let ent = self.token(plan, team_repo, role, comp);
            self.http.push(
                200,
                &format!(r#"{{"sessionToken":"pls_secret","entitlement":"{ent}","account":{{"sub":"1234567","login":"octocat"}}}}"#),
            );
            self.store.complete_sign_in("gho_github".into(), "Test Mac", NOW).unwrap();
            self.http.clear_seen();
        }

        /// Queue a `GET /entitlement` answer with `plan`.
        pub fn push_entitlement(&self, plan: &str, team_repo: &str, role: &str, comp: bool) {
            let ent = self.token(plan, team_repo, role, comp);
            self.http.push(200, &format!(r#"{{"entitlement":"{ent}"}}"#));
        }
    }

    pub fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let http = Arc::new(FakeHttp::default());
        let secrets = Arc::new(FakeSecrets::default());
        let store = AccountStore::with_parts(
            dir.path().to_path_buf(),
            Box::new(http.clone()),
            Box::new(secrets),
            Endpoints {
                api_base: "http://api.test/v1".into(),
                github_base: "https://gh.test".into(),
                client_id: "Iv1.test".into(),
            },
            Ok(sk.verifying_key()),
        );
        Rig { _dir: dir, http, store, sk }
    }

    pub fn team_json(repo: Option<&str>, seats: u32, assigned: &[(&str, &str)], status: &str) -> String {
        let repo = repo.map(|r| format!("\"{r}\"")).unwrap_or_else(|| "null".into());
        let assigned: Vec<String> = assigned
            .iter()
            .map(|(sub, login)| format!(r#"{{"sub":"{sub}","login":"{login}"}}"#))
            .collect();
        format!(
            r#"{{"teamRepo":{repo},"owner":{{"sub":"1234567","login":"octocat"}},"seats":{seats},"assigned":[{}],"status":"{status}","periodEnd":1762592000000}}"#,
            assigned.join(",")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn checkout_sends_team_seats_and_interval_with_the_session() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        r.http.push(200, r#"{"url":"https://checkout.stripe.com/c/pay/cs_test_1"}"#);
        let url = checkout(&r.store, Interval::Year, Some(5)).unwrap();
        assert_eq!(url, "https://checkout.stripe.com/c/pay/cs_test_1");
        let seen = r.http.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, Method::Post);
        assert_eq!(seen[0].url, "http://api.test/v1/checkout");
        assert_eq!(seen[0].bearer.as_deref(), Some("pls_secret"));
        assert_eq!(seen[0].device.as_deref(), Some(r.store.device_id().as_str()));
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(body, serde_json::json!({"plan":"team","interval":"year","seats":5}));
    }

    #[test]
    fn checkout_seats_out_of_range_never_reach_the_server() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        for seats in [0, 1, 51, 500] {
            let e = checkout(&r.store, Interval::Month, Some(seats)).unwrap_err();
            assert_eq!(e.code, ErrorCode::BadRequest, "{seats}");
        }
        assert!(r.http.seen().is_empty());
        // No seats given: the minimum.
        r.http.push(200, r#"{"url":"https://checkout.stripe.com/x"}"#);
        checkout(&r.store, Interval::Month, None).unwrap();
        assert!(r.http.seen()[0].body.contains(r#""seats":2"#));
    }

    #[test]
    fn already_subscribed_is_typed() {
        let r = rig();
        r.sign_in("pro", "null", "null", false);
        r.http.push(409, r#"{"error":"already_subscribed","message":"You already have a paid plan. Manage it in the billing portal."}"#);
        let e = checkout(&r.store, Interval::Month, Some(2)).unwrap_err();
        assert_eq!(e.code, ErrorCode::AlreadySubscribed);
        assert!(e.message.contains("billing portal"));
        assert!(r.store.info().signed_in, "a refusal keeps the session");
    }

    #[test]
    fn a_non_https_link_is_never_handed_out() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        r.http.push(200, r#"{"url":"file:///etc/passwd"}"#);
        assert_eq!(checkout(&r.store, Interval::Month, None).unwrap_err().code, ErrorCode::Server);
        r.http.push(200, r#"{"nope":1}"#);
        assert_eq!(portal(&r.store).unwrap_err().code, ErrorCode::Server);
    }

    #[test]
    fn links_are_held_to_stripes_host_per_call() {
        let r = rig();
        r.sign_in("free", "null", "null", false);
        for bad in [
            "https://evil.example/c/pay",
            "https://checkout.stripe.com.evil.example/x",
            "https://user@checkout.stripe.com/x",
            "https://checkout.stripe.com:8443/x",
            "https://billing.stripe.com/p/1",
            "http://checkout.stripe.com/x",
        ] {
            r.http.push(200, &format!(r#"{{"url":"{bad}"}}"#));
            assert_eq!(checkout(&r.store, Interval::Month, None).unwrap_err().code, ErrorCode::Server, "{bad}");
        }
        r.http.push(200, r#"{"url":"https://checkout.stripe.com/x"}"#);
        assert_eq!(portal(&r.store).unwrap_err().code, ErrorCode::Server, "a Checkout page is not the Portal");
        r.http.push(200, r#"{"url":"https://checkout.stripe.com/c/pay/cs_1#frag"}"#);
        assert!(checkout(&r.store, Interval::Month, None).is_ok());
    }

    #[test]
    fn portal_opens_and_not_found_is_typed() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        r.http.push(200, r#"{"url":"https://billing.stripe.com/p/session/1"}"#);
        assert_eq!(portal(&r.store).unwrap(), "https://billing.stripe.com/p/session/1");
        assert_eq!(r.http.seen()[0].url, "http://api.test/v1/portal");
        r.http.push(404, r#"{"error":"not_found","message":"You have no subscription yet."}"#);
        assert_eq!(portal(&r.store).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn signed_out_calls_send_nothing() {
        let r = rig();
        assert_eq!(portal(&r.store).unwrap_err().code, ErrorCode::Unauthorized);
        assert_eq!(team_get(&r.store).unwrap_err().code, ErrorCode::Unauthorized);
        assert!(r.http.seen().is_empty());
    }

    #[test]
    fn team_get_reads_the_team_and_none_when_never_had_one() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        r.http.push(200, &team_json(Some("o/n"), 3, &[("1234567", "octocat"), ("42", "b")], "active"));
        let team = team_get(&r.store).unwrap().unwrap();
        assert_eq!(team.team_repo.as_deref(), Some("o/n"));
        assert_eq!(team.seats, 3);
        assert_eq!(team.assigned.len(), 2);
        assert!(team.holds_seat("42") && team.is_owner("1234567") && !team.lapsed());
        assert_eq!(r.http.seen()[0].method, Method::Get);
        r.http.push(404, r#"{"error":"not_found","message":"You are not on a team."}"#);
        assert_eq!(team_get(&r.store).unwrap(), None);
        // A lapsed team comes back with its status.
        r.http.push(200, &team_json(Some("o/n"), 3, &[("1234567", "octocat")], "canceled"));
        assert!(team_get(&r.store).unwrap().unwrap().lapsed());
    }

    #[test]
    fn team_bind_posts_the_repo_and_types_already_bound_and_forbidden() {
        let r = rig();
        r.sign_in("team", "null", "\"owner\"", false);
        r.http.push(200, &team_json(Some("octocat/acme-team"), 2, &[("1234567", "octocat")], "active"));
        let team = team_bind(&r.store, " octocat/acme-team ").unwrap();
        assert_eq!(team.team_repo.as_deref(), Some("octocat/acme-team"));
        let seen = r.http.seen();
        assert_eq!((seen[0].method, seen[0].url.as_str()), (Method::Post, "http://api.test/v1/team"));
        assert_eq!(seen[0].body, r#"{"teamRepo":"octocat/acme-team"}"#);
        r.http.push(409, r#"{"error":"already_bound","message":"This team is already bound to o/x."}"#);
        assert_eq!(team_bind(&r.store, "o/y").unwrap_err().code, ErrorCode::AlreadyBound);
        r.http.push(403, r#"{"error":"forbidden","message":"Only the team owner can do that."}"#);
        assert_eq!(team_bind(&r.store, "o/y").unwrap_err().code, ErrorCode::Forbidden);
        assert_eq!(team_bind(&r.store, "not a repo").unwrap_err().code, ErrorCode::BadRequest);
        assert_eq!(r.http.seen().len(), 3);
    }

    #[test]
    fn seat_put_and_delete_use_the_numeric_id_path() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        r.http.push(200, &team_json(Some("o/n"), 2, &[("1234567", "octocat"), ("42", "b")], "active"));
        let team = seat_put(&r.store, "42", "b").unwrap();
        assert!(team.holds_seat("42"));
        r.http.push(200, &team_json(Some("o/n"), 2, &[("1234567", "octocat")], "active"));
        assert!(!seat_delete(&r.store, "42").unwrap().unwrap().holds_seat("42"));
        let seen = r.http.seen();
        assert_eq!((seen[0].method, seen[0].url.as_str()), (Method::Put, "http://api.test/v1/team/seats/42"));
        assert_eq!(seen[0].body, r#"{"login":"b"}"#);
        assert_eq!((seen[1].method, seen[1].url.as_str()), (Method::Delete, "http://api.test/v1/team/seats/42"));
    }

    #[test]
    fn seat_errors_are_typed() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        r.http.push(409, r#"{"error":"seat_limit","message":"All 2 seats are taken. Add seats in billing first."}"#);
        assert_eq!(seat_put(&r.store, "42", "b").unwrap_err().code, ErrorCode::SeatLimit);
        r.http.push(403, r#"{"error":"forbidden","message":"b is already on another team."}"#);
        let e = seat_put(&r.store, "42", "b").unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Forbidden, "b is already on another team."));
        r.http.push(404, r#"{"error":"not_found","message":"That person has no seat on this team."}"#);
        assert_eq!(seat_delete(&r.store, "42").unwrap(), None, "no seat: free either way");
        r.http.push(403, r#"{"error":"forbidden","message":"The owner's seat can't be removed."}"#);
        assert_eq!(seat_delete(&r.store, "1234567").unwrap_err().code, ErrorCode::Forbidden);
        r.http.push(500, r#"{"error":"internal","message":"boom"}"#);
        assert_eq!(seat_delete(&r.store, "42").unwrap_err().code, ErrorCode::Server);
        r.http.push_err();
        assert_eq!(seat_put(&r.store, "42", "b").unwrap_err().code, ErrorCode::Network);
    }

    /// 1.175.0 D5: the member's own seat. Both `200`s are a success; an old
    /// server's `404` for the unknown route is a failure, never "already free".
    #[test]
    fn leaving_ones_own_seat_reads_both_answers_and_an_old_servers_404_is_a_failure() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"member\"", false);
        r.http.clear_seen();
        r.http.push(200, r#"{"left":true}"#);
        assert_eq!(seat_leave(&r.store), Ok(true));
        r.http.push(200, r#"{"left":false}"#);
        assert_eq!(seat_leave(&r.store), Ok(false), "no seat any more: a success");
        let seen = r.http.seen();
        assert_eq!((seen[0].method, seen[0].url.as_str()), (Method::Delete, "http://api.test/v1/team/seat"));
        assert_eq!(seen[0].body, "", "nothing from the client names a team or an account");
        assert!(seen[0].bearer.is_some());

        r.http.push(404, r#"{"error":"not_found","message":"Not found."}"#);
        assert_eq!(seat_leave(&r.store).unwrap_err().code, ErrorCode::NotFound, "a server older than 1.175");
        r.http.push(403, r#"{"error":"forbidden","message":"You own this team, and the owner's seat can't be left."}"#);
        let owner = seat_leave(&r.store).unwrap_err();
        assert_eq!((owner.code, owner.message.as_str()), (ErrorCode::Forbidden, "You own this team, and the owner's seat can't be left."));
        r.http.push(500, r#"{"error":"internal","message":"boom"}"#);
        assert_eq!(seat_leave(&r.store).unwrap_err().code, ErrorCode::Server);
        r.http.push_err();
        assert_eq!(seat_leave(&r.store).unwrap_err().code, ErrorCode::Network);
        // An answer that isn't the contract's is not read as "left".
        r.http.push(200, r#"{"ok":true}"#);
        assert!(seat_leave(&r.store).is_err());
        // Last: an ended session ends it for every call after.
        r.http.push(401, r#"{"error":"unauthorized","message":"Sign in again."}"#);
        assert_eq!(seat_leave(&r.store).unwrap_err().code, ErrorCode::Unauthorized);
    }

    #[test]
    fn hostile_ids_and_logins_never_reach_a_path() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        for sub in ["", "abc", "1/../2", "123456789012345678901", "-1"] {
            assert_eq!(seat_put(&r.store, sub, "b").unwrap_err().code, ErrorCode::BadRequest, "{sub}");
            assert_eq!(seat_delete(&r.store, sub).unwrap_err().code, ErrorCode::BadRequest, "{sub}");
        }
        assert_eq!(seat_put(&r.store, "42", "b/../c").unwrap_err().code, ErrorCode::BadRequest);
        assert!(r.http.seen().is_empty());
    }

    #[test]
    fn replaced_drops_to_free_and_unauthorized_ends_the_session() {
        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        r.http.push(409, r#"{"error":"replaced","message":"Your plan moved to Studio iMac.","deviceName":"Studio iMac"}"#);
        assert_eq!(team_get(&r.store).unwrap_err().code, ErrorCode::Replaced);
        // 1.178.0: replaced (here from an older server, which gets no silent
        // reclaim) keeps the account signed in on Free; no replaced state.
        let info = r.store.info();
        assert!(info.signed_in && !info.entitlement_valid);
        assert_eq!(info.plan, crate::account::Plan::Free);
        assert_eq!(r.http.seen().len(), 1, "no reclaim from an older server");

        let r = rig();
        r.sign_in("team", "\"o/n\"", "\"owner\"", false);
        r.http.push(401, r#"{"error":"unauthorized","message":"Please sign in again."}"#);
        assert_eq!(portal(&r.store).unwrap_err().code, ErrorCode::Unauthorized);
        assert!(!r.store.info().signed_in);
    }
}
