//! v1.32.0 — dependency doctor.
//!
//! The raw probe in `shell_env.rs` is a dumb fact-collector: which CLIs are on
//! PATH and at what version. This module is the *policy* layer on top of it —
//! the single home for "is this tool required", install guidance, and version
//! floors. The frontend renders a `DoctorReport` generically; it carries no
//! tool-specific knowledge.

use std::time::Duration;

use serde::Serialize;

use crate::platform::{THIS_MACHINE, THIS_MACHINE_CAP};
use crate::review_capabilities::{ReviewerCapabilityRegistry, ReviewerCapabilityView};
use crate::shell_env::{self, ShellEnv};

/// Per-tool status row in the doctor report.
#[derive(Serialize, Debug, Clone)]
pub struct ToolStatus {
    /// Stable identifier: "git" | "git-bash" | "claude" | "codex" | "node" | "gh".
    pub id: String,
    /// Display name, e.g. "Claude Code".
    pub name: String,
    /// True when Ply can't function without it: git (and Git Bash on
    /// Windows). OB-2: Claude and Codex are each optional — one AI is enough
    /// (`DoctorReport::ai_ready`).
    pub required: bool,
    /// Resolved on PATH.
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Found *and* actually usable. For claude this is `supports_stream_json()`;
    /// for codex it is `codex_healthy()` (found *and* answering `--version`);
    /// for git/gh there is no meaningful floor, so it equals `found`.
    #[serde(rename = "versionOk")]
    pub version_ok: bool,
    /// One-line plain-language status — what's wrong or what the tool unlocks.
    pub detail: String,
    /// Copyable install (or update) command.
    #[serde(rename = "installCmd")]
    pub install_cmd: String,
    /// Official install / sign-in page.
    #[serde(rename = "docsUrl")]
    pub docs_url: String,
    /// Phase 4: behavioral read-only proof for provider CLIs. `None` for
    /// non-provider tools.
    pub reviewer: Option<ReviewerCapabilityView>,
    /// GH #103: whether the tool has an account signed in. `None` for every
    /// tool Ply does not ask — which is all of them but `gh` and (GH #169)
    /// `claude` — and for those two on a read that did not ask. A tool Ply
    /// cannot ask says nothing rather than claiming it is fine.
    pub auth: Option<ToolAuth>,
    /// OB-2 (D6): a newer release than the one found, read from the vendor's
    /// feed on a Diagnostics read. `None` offline or when up to date.
    pub update: Option<ToolUpdate>,
}

/// GH #103 (BOARDS.md §5 "Settings › Advanced › Diagnostics"): a tool that is
/// installed but signed out is not ready, and the step that fixes it is a
/// command the person runs — not an install.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolAuth {
    /// `Some(true)` signed in · `Some(false)` resolved but signed out ·
    /// `None` Ply asked and got no answer it could read. Never a guess: a
    /// wrong "signed out" sends someone to log in again for nothing.
    pub signed_in: Option<bool>,
    /// The one sentence the row's hint shows.
    pub detail: String,
    /// What the person runs. `gh auth login` to sign in; `gh auth status`
    /// when Ply could not tell and the answer is worth seeing in full.
    pub command: String,
    /// `Sign in`, or `Check` when nothing is known.
    pub action: String,
    /// GH #169 review 1: the step is offered, not asked for. Set on
    /// `claude`'s "Ply could not see a sign-in" and (GH #189) `gh`'s "the
    /// keychain would not say": the row stays neutral (it
    /// counts as ready and draws no warning) and the step is a secondary one,
    /// because the person may be signed in in a way Ply cannot see — and a
    /// primary `Sign in` could move an API-key user onto OAuth.
    #[serde(default)]
    pub optional_step: bool,
}

/// How long a remembered sign-in answer may be reused (GH #103 review 1). GH
/// #169: `claude`'s answer is kept for the same time, so the two rows move
/// together.
///
/// Long enough that opening Diagnostics, its watch's first look and a workspace
/// switch in the same minute cost one `gh` run, short enough that a sign-in in
/// another terminal shows up without anyone pressing anything.
pub const GH_AUTH_TTL: Duration = Duration::from_secs(90);

/// What a report read should do about sign-in.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthProbe {
    /// Say nothing: this read did not ask, and nothing fresh is remembered.
    Skip,
    /// Use what was learnt a moment ago, without running anything.
    Cached(ToolAuth),
    /// Run `gh auth status`.
    Ask,
}

/// GH #103 review 1 (MAJOR): `gh auth status` validates the stored token **over
/// the network**, and the doctor's report is read on app launch, on every
/// workspace switch, on definition events, when the tile shell is saved and
/// whenever a page that shows a doctor row opens. Running it on every one of
/// those was a network round trip nobody asked for, up to six seconds long.
///
/// So only the reads that show the sign-in row ask (`asked`), and even they
/// reuse an answer younger than {@link GH_AUTH_TTL}. A read that does not ask
/// still *shows* a fresh remembered answer — it is the last thing Ply knew, and
/// dropping it would make the row flicker back to the tool's own sentence
/// between two Diagnostics reads.
///
/// `forced` is the one press that is meant to cost something: `Look again, from
/// scratch` re-probes the shell, so it re-asks `gh` too. Review 2 (N2) — without
/// it the cache won even there, and somebody who had just signed in had no way
/// to make Ply look.
pub fn auth_probe(
    asked: bool,
    forced: bool,
    remembered: Option<(Duration, ToolAuth)>,
) -> AuthProbe {
    if forced {
        return AuthProbe::Ask;
    }
    match remembered {
        Some((age, auth)) if age < GH_AUTH_TTL => AuthProbe::Cached(auth),
        _ if asked => AuthProbe::Ask,
        _ => AuthProbe::Skip,
    }
}

/// GH #189: the `gh` row's sentence when the login keychain is locked. `gh`
/// keeps its token there, so it cannot read it and `gh auth status` fails the
/// way it does for a refused token — which says nothing about whether this Mac
/// is signed in.
pub const GH_LOCKED_DETAIL: &str =
    "Found. The keychain is locked, so Plyloft can't check whether it is signed in.";

/// GH #189: `gh` has an account but found no token for it (`The token in
/// default is invalid`) — the keychain did not hand it over. Ply cannot tell
/// whether this Mac is signed in.
pub const GH_TOKEN_UNREAD_DETAIL: &str =
    "Found. gh could not read its sign-in from the keychain, so Plyloft can't check whether it is signed in.";

/// GH #194: the `gh` row's sentence when `gh auth status --json` failed with
/// anything but GitHub refusing the token (HTTP 401): the check never reached
/// GitHub (no DNS, a refused connection, a captive portal), or GitHub was
/// reached and did not say (review 1: a 403 rate limit, a 5xx outage).
/// Nothing about the sign-in is known, and `Sign in` would not help.
pub const GH_UNREACHABLE_DETAIL: &str = concat!(
    "Found. Plyloft couldn't get an answer from GitHub about the sign-in — ",
    crate::this_machine!(),
    " may be offline, or GitHub may be having trouble."
);

/// GH #194: the sentence for a `gh` too old for `gh auth status --json`
/// (before 2.81) that calls a token invalid. Its text words an offline check
/// and a refused token the same, so Ply says it could not confirm rather than
/// "not signed in".
pub const GH_UNCONFIRMED_DETAIL: &str =
    "Found. Plyloft couldn't confirm the sign-in — GitHub may be unreachable, or the token may need gh auth login.";

/// Where `gh auth status` says the token it rejected came from: the `<source>`
/// in `The token in <source> is invalid.` (`keyring`, `default`, `GH_TOKEN`,
/// `oauth_token`), lower-cased.
fn gh_invalid_token_source(lower: &str) -> Option<&str> {
    let at = lower.find("the token in ")? + "the token in ".len();
    let rest = &lower[at..];
    let end = rest.find(" is invalid")?;
    let source = rest[..end].trim();
    (!source.is_empty() && !source.contains('\n')).then_some(source)
}

/// GH #194: whether the `error` gh 2.100 records for a failed check is GitHub
/// refusing the token (an HTTP 401) rather than the check never getting an
/// answer. Captured with fake tokens and an empty `GH_CONFIG_DIR`: a keychain
/// or `hosts.yml` token says `HTTP 401: Bad credentials (https://api.github.com/)`,
/// an environment token `non-200 OK status code: 401 Unauthorized body: …`;
/// offline it is `dial tcp: lookup <host>: no such host` or `connect:
/// connection refused`. Anything but a 401 — a 5xx, a proxy, a TLS failure —
/// is not a refusal: Ply does not know.
pub(crate) fn gh_error_is_refusal(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("http 401")
        || lower.contains("status code: 401")
        || lower.contains("401 unauthorized")
        || lower.contains("bad credentials")
}

/// One account's answer, the one the row is read from.
#[derive(Debug, Clone, PartialEq)]
struct GhAnswer {
    /// `success`, `timeout` or `error`, as gh names it.
    state: String,
    /// The token's source, lower-cased: `keyring`, `default`, `gh_token`, a
    /// `hosts.yml` path.
    source: Option<String>,
    /// Whether GitHub refused the token (see {@link gh_error_is_refusal}).
    /// `None` when Ply read gh's text, which words both the same.
    refused: Option<bool>,
}

/// GH #194: the `hosts` of `gh auth status --json hosts` (gh 2.81 and later),
/// or `None` when `output` is not gh's JSON (an older gh, or an error before
/// gh wrote any). `stdout` comes first in `output`, and gh may add a line to
/// stderr after it, so only the first JSON value is read.
fn gh_json_hosts(output: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    // Review 1: offsets from `split_inclusive`, which keeps every byte of each
    // line (`\r\n` included), so `start` is always the line's real start.
    let start = output
        .split_inclusive('\n')
        .scan(0usize, |at, line| {
            let here = *at;
            *at += line.len();
            Some((here, line))
        })
        .find(|(_, line)| line.trim_start().starts_with('{'))
        .map(|(at, line)| at + (line.len() - line.trim_start().len()))?;
    let value = serde_json::Deserializer::from_str(&output[start..])
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()?;
    match value {
        serde_json::Value::Object(mut root) => match root.remove("hosts")? {
            serde_json::Value::Object(hosts) => Some(hosts),
            _ => None,
        },
        _ => None,
    }
}

/// The host whose answer is the row's (GH #195): `github.com`, where Ply
/// opens pull requests; only when gh has no account there, the host whose name
/// sorts first — the same one from the JSON (a sorted map) and from the text
/// (which lists hosts in `hosts.yml`'s order).
const GH_PRIMARY_HOST: &str = "github.com";

/// The account that decides the row, from `--json`: `Some(None)` for no
/// account at all, `Some(Some(answer))` otherwise, `None` when `output` is not
/// gh's JSON.
///
/// GH #195: the **active** account of the primary host only. Ply asks with
/// `--active` (review 1), so gh lists only each host's active account; the
/// flag is still read here as a defence, since without `--active` gh lists
/// every account (`"active": false` for the ones it does not use), and an
/// inactive account's or another host's failure says nothing about the
/// account gh uses.
fn gh_json_answer(output: &str) -> Option<Option<GhAnswer>> {
    let hosts = gh_json_hosts(output)?;
    let accounts = hosts
        .get(GH_PRIMARY_HOST)
        .or_else(|| hosts.values().next())
        .and_then(|host| host.as_array())
        .filter(|accounts| !accounts.is_empty());
    let Some(accounts) = accounts else {
        return Some(None);
    };
    // gh lists the active account first; look for the flag anyway.
    let entry = accounts
        .iter()
        .find(|e| e.get("active").and_then(|a| a.as_bool()) == Some(true))
        .unwrap_or(&accounts[0]);
    let text = |key: &str| entry.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let source = text("tokenSource").trim().to_ascii_lowercase();
    Some(Some(GhAnswer {
        state: text("state").to_ascii_lowercase(),
        source: (!source.is_empty()).then_some(source),
        refused: Some(gh_error_is_refusal(text("error"))),
    }))
}

/// GH #195: from gh's text, the lines of the primary host's **active**
/// account — `None` when the text marks no account active (a gh before
/// multi-account support, 2.40, or a shape Ply does not know), and the whole
/// text is read as before.
///
/// gh prints each host's name on a line of its own, then each account's block
/// (`  ✓ Logged in to …`, `  X Failed to log in to …`, `  X Timeout trying to
/// log in to …`) followed by its `  - …` lines, one of which is `- Active
/// account: true|false`.
fn gh_text_active_block(output: &str) -> Option<String> {
    let mut hosts: Vec<(&str, Vec<Vec<&str>>)> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indented = line.starts_with(char::is_whitespace);
        if !indented && !trimmed.contains(char::is_whitespace) {
            hosts.push((trimmed, Vec::new()));
            continue;
        }
        let Some((_, accounts)) = hosts.last_mut() else {
            continue;
        };
        let starts_account = trimmed.starts_with('✓') || trimmed.starts_with("X ");
        match accounts.last_mut() {
            Some(account) if !starts_account => account.push(trimmed),
            _ => accounts.push(vec![trimmed]),
        }
    }
    let (_, accounts) = hosts
        .iter()
        .find(|(host, _)| host.eq_ignore_ascii_case(GH_PRIMARY_HOST))
        .or_else(|| hosts.iter().min_by_key(|(host, _)| host.to_ascii_lowercase()))?;
    let active = accounts.iter().find(|account| {
        account
            .iter()
            .any(|line| line.eq_ignore_ascii_case("- active account: true"))
    })?;
    Some(active.join("\n"))
}

/// GH #194: whether `gh auth status --json hosts --active` failed only
/// because this `gh` does not know one of the flags (`--json` before 2.81;
/// review 1: `--active` too, on an older gh still) — gh stops at the flag,
/// before any network call, so asking again without them is the same one
/// check.
pub fn gh_flags_unsupported(exit_ok: bool, output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    !exit_ok
        && (lower.contains("unknown flag: --json") || lower.contains("unknown flag: --active"))
}

/// GH #194: `--json` exits 0 unless gh hits a fatal error. Whether every account in it succeeded —
/// what the plain command's exit status says — so a caller reads the answer
/// the way it read the exit status. `None` when `output` is not gh's JSON.
pub fn gh_json_all_succeeded(output: &str) -> Option<bool> {
    let hosts = gh_json_hosts(output)?;
    let mut accounts = hosts
        .values()
        .filter_map(|host| host.as_array())
        .flatten()
        .peekable();
    if accounts.peek().is_none() {
        return Some(false);
    }
    Some(accounts.all(|e| e.get("state").and_then(|s| s.as_str()) == Some("success")))
}

/// The answers `gh auth status` gives, in words. Pure, so the Tier-1 tests
/// below cover each one without a `gh` on the machine.
///
/// GH #194: `output` is `gh auth status --json hosts --active` where gh has it (2.81 and
/// later; `shell_env::gh_auth_output`), whose `error` tells a token GitHub
/// refused (HTTP 401) from a check that never reached GitHub; an older gh's
/// text, which words both `The token in <source> is invalid`, is read too.
///
/// GH #189: `keychain` is the login keychain's lock state
/// (`keychain_lock.rs`), asked only when `gh` failed. Three answers, and the
/// middle one is never read as the last:
///
/// - **signed in** — `gh` succeeded;
/// - **Ply cannot tell** — the keychain is locked; `gh` failed on a keychain
///   or `default` token while Ply could not see whether the keychain is
///   unlocked; (GH #194) the check never reached GitHub (`Check`, like a
///   timeout); or an older gh's text calls a keychain token (keychain
///   unlocked) or an environment / `hosts.yml` token invalid, which offline
///   it does too (neutral, `Sign in` offered);
/// - **not signed in** — no account configured at all (`not logged into any
///   GitHub hosts`); an unlocked keychain and `The token in default is
///   invalid` (no token anywhere); GitHub refused (HTTP 401) a keychain,
///   environment or `hosts.yml` token.
///
/// GH #195: only the active account of `github.com` (or, with no account
/// there, of another host) decides; gh fails the whole command when
/// any account on any host fails, and those answers change nothing.
pub fn gh_auth_status(
    exit_ok: bool,
    output: &str,
    keychain: crate::keychain_lock::KeychainLock,
) -> ToolAuth {
    use crate::keychain_lock::KeychainLock;
    let signed_in = ToolAuth {
        signed_in: Some(true),
        detail: "Found and signed in — pull requests can be opened from here.".into(),
        command: "gh auth status".into(),
        action: "Check".into(),
        optional_step: false,
    };
    let mut lower = output.to_ascii_lowercase();
    let signed_out = ToolAuth {
        signed_in: Some(false),
        detail: "Found, but not signed in — pull requests can't be opened from here.".into(),
        command: "gh auth login".into(),
        action: "Sign in".into(),
        optional_step: false,
    };
    let cannot_tell = |detail: &str| ToolAuth {
        signed_in: None,
        detail: detail.into(),
        command: "gh auth login".into(),
        action: "Sign in".into(),
        optional_step: true,
    };
    // Nothing came back that Ply can read, or gh never reached GitHub: say so,
    // and the step is to look again.
    let unanswered = |detail: &str| ToolAuth {
        signed_in: None,
        detail: detail.into(),
        command: "gh auth status".into(),
        action: "Check".into(),
        optional_step: false,
    };
    const UNREAD: &str =
        "Found. Plyloft asked whether you are signed in and could not read the answer — it may be offline.";

    let answer = match gh_json_answer(output) {
        // `--json` names no host: nothing in `hosts.yml`, whatever the keychain.
        Some(None) => return signed_out,
        Some(Some(answer)) => answer,
        None => {
            if exit_ok {
                return signed_in;
            }
            // No account at all lives in `hosts.yml`, not the keychain: true
            // whether or not the keychain is locked.
            let no_account = lower.contains("not logged into any")
                || lower.contains("not logged in to any")
                || lower.contains("no accounts");
            if no_account {
                return signed_out;
            }
            // GH #195: the primary host's active account, when gh marks one;
            // gh exits 1 when *any* account fails, so it decides even when the
            // command failed.
            if let Some(block) = gh_text_active_block(output) {
                lower = block.to_ascii_lowercase();
                // `✓ Logged in to …`; a failure says `Failed to log in to`.
                if lower.contains("logged in to") {
                    return signed_in;
                }
            }
            GhAnswer {
                state: "error".into(),
                source: gh_invalid_token_source(&lower).map(str::to_string),
                refused: None,
            }
        }
    };
    if answer.state == "success" {
        return signed_in;
    }
    let source = answer.source.as_deref();
    // A token from the environment or `hosts.yml`: the keychain had no part
    // in the answer.
    if matches!(source, Some(s) if s != "default" && s != "keyring") {
        return match answer.refused {
            Some(true) => signed_out,
            Some(false) => unanswered(GH_UNREACHABLE_DETAIL),
            // An older gh's text: refused or offline, it cannot say which.
            None => cannot_tell(GH_UNCONFIRMED_DETAIL),
        };
    }
    if keychain == KeychainLock::Locked {
        return cannot_tell(GH_LOCKED_DETAIL);
    }
    let source = match (answer.state.as_str(), source) {
        ("error", Some(source)) => source,
        // A timeout, a state this Ply does not know, or text with no token
        // named. In text, gh's own advice to log in is a sign-out.
        _ if answer.refused.is_none()
            && (lower.contains("not logged in") || lower.contains("gh auth login")) =>
        {
            return signed_out
        }
        _ => return unanswered(UNREAD),
    };
    if source == "default" {
        // Review 1 (#189): with the keychain seen unlocked, `default` means gh
        // found no token anywhere (an account in `hosts.yml` with no keychain
        // item) — true online or off. The lock state unknown: Ply cannot tell
        // a locked or denied keychain from a missing token.
        return if keychain == KeychainLock::Unlocked {
            signed_out
        } else {
            cannot_tell(GH_TOKEN_UNREAD_DETAIL)
        };
    }
    // `keyring`: gh read the token from the keychain.
    match answer.refused {
        // GitHub answered, and refused it: revoked or expired.
        Some(true) => signed_out,
        // GH #194: the check never reached GitHub.
        Some(false) => unanswered(GH_UNREACHABLE_DETAIL),
        // An older gh's text words a refused token and an offline check the
        // same; with the keychain seen unlocked, say it could not confirm.
        None if keychain == KeychainLock::Unlocked => cannot_tell(GH_UNCONFIRMED_DETAIL),
        None => cannot_tell(GH_TOKEN_UNREAD_DETAIL),
    }
}

/// GH #169: what one local place said about a Claude Code credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSeen {
    /// The credential is there.
    Present,
    /// The place answered, and there is none.
    Absent,
    /// Ply could not look (a locked or denied keychain, a file it cannot
    /// `stat`). Never read as "absent".
    Unreadable,
}

/// The `claude` row's own sentence when it is found and new enough.
pub const CLAUDE_READY_DETAIL: &str = "Runs your Claude agents and swarms.";

/// 1.176.0 R3: found, and `claude --version` didn't answer — the Codex row's
/// sentence ("Installed but not starting — Repair puts it right, so Codex
/// tiles."), for Claude.
pub const CLAUDE_NOT_STARTING_DETAIL: &str = "Installed but not starting — Repair puts it right, so Claude tiles start again.";

/// R3 review 1: found, and `claude --version` didn't answer in time, twice —
/// slow, not broken (a first run, a busy computer, an antivirus scan).
/// Neutral, modelled on [`CLAUDE_UNSEEN_DETAIL`].
pub const CLAUDE_VERSION_UNKNOWN_DETAIL: &str =
    "Found. Plyloft couldn't read its version in time; if your Claude tiles start, there is nothing to do.";

/// [`CLAUDE_VERSION_UNKNOWN_DETAIL`] for Codex.
pub const CODEX_VERSION_UNKNOWN_DETAIL: &str =
    "Found. Plyloft couldn't read its version in time; if your Codex tiles start, there is nothing to do.";

/// GH #169 review 1: what the `claude` row says when Ply found no credential.
/// A statement about what Ply could see, never "signed out", and the one
/// check that settles it is the person's own: whether their tiles start.
pub const CLAUDE_UNSEEN_DETAIL: &str = concat!(
    "Found. Plyloft could not see a Claude sign-in on ",
    crate::this_machine!(),
    "; if your Claude tiles start, there is nothing to do."
);

/// GH #173: the `gh` row's sentence when it is found and nothing has asked
/// whether it is signed in — true either way.
pub const GH_FOUND_DETAIL: &str = "Found. Diagnostics can check whether it is signed in.";

/// GH #169 (BOARDS.md §5): whether Claude Code is signed in, from **credential
/// presence only** — the keychain item and the credentials file
/// (`claude_auth.rs`). Pure, so every combination is tested.
///
/// There are two answers, not three. A credential in either place is signed
/// in. Neither is `signedIn: None` — Ply could not tell — and **never**
/// `Some(false)`: an API key in the environment, an `apiKeyHelper`, Bedrock or
/// Vertex, or a config directory Ply does not know about all sign Claude Code
/// in without leaving either trace, and a wrong "sign in again" on the one CLI
/// the whole app depends on is the failure this card exists to avoid. Review
/// 1: so that answer is **neutral** (`optional_step`) — it counts as ready,
/// says what Ply could not see, and keeps `claude auth login` as a secondary
/// step rather than the row's.
pub fn claude_auth_status(keychain: CredentialSeen, file: CredentialSeen) -> ToolAuth {
    if keychain == CredentialSeen::Present || file == CredentialSeen::Present {
        return ToolAuth {
            signed_in: Some(true),
            detail: "Found and signed in. Nothing to do.".into(),
            // OB-2 (D2): never `claude auth status` — it runs only in Setup's
            // AI step. A signed-in row is `Ready`; this step is never offered.
            command: "claude auth login".into(),
            action: "Sign in".into(),
            optional_step: false,
        };
    }
    ToolAuth {
        signed_in: None,
        detail: CLAUDE_UNSEEN_DETAIL.into(),
        command: "claude auth login".into(),
        action: "Sign in".into(),
        optional_step: true,
    }
}

/// v1.116.0 (team sharing rung 3): the team library's skills, as the doctor
/// shows them. `None` when this Mac is not on a team — the row is then absent
/// rather than reading "0 team skills loaded", which would look like a fault.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillsStatus {
    /// Skills both CLIs can load. The headline number.
    pub loaded: usize,
    /// Loadable by Claude Code only, and by Codex only. A library in good
    /// order has none of either; a non-zero count is what makes an asymmetry
    /// visible instead of silently halving what a member gets.
    pub claude_only: usize,
    pub codex_only: usize,
    /// Plugins refused for carrying hooks or unusable names.
    pub refused: usize,
    /// Why team skills do not reach a session on this Mac, when something
    /// stops them. A library can be perfectly good and still load into
    /// nothing — no Codex home, a marketplace of the member's own in the way
    /// — and the launch path can only log that. This is where a member sees
    /// it.
    pub blocked: Option<String>,
    pub detail: String,
}

/// What the doctor needs to describe this Mac's team skills.
///
/// `codex_blocked` is resolved by the caller, not here, so [`build_report`]
/// stays pure: it is the answer to "could an overlay be built right now",
/// from [`crate::codex_home::preflight`].
pub struct TeamSkillsInput<'a> {
    pub library: &'a crate::team_skills::TeamSkillsLibrary,
    pub codex_blocked: Option<String>,
}

/// v1.117.0 (team sharing rung 4): the repo's own skills, as the doctor shows
/// them. `None` when the open workspace has no skill directory at all — which
/// is most repositories, and where "0 project skills loaded" would read as a
/// fault rather than as "this repo has none".
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillsStatus {
    /// Skills both CLIs load, so they reach every session Ply starts in this
    /// repo. The same rule as the team-skills row above, for the same reason:
    /// a Builder on one vendor and a Challenger on the other must see the
    /// same instructions.
    pub loaded: usize,
    /// In `.claude/skills` only, and in a Codex root only. Measured: no single
    /// directory serves both CLIs, so this is the normal shape of a repo that
    /// was set up for one of them.
    pub claude_only: usize,
    pub codex_only: usize,
    /// Directories that look like skills and are not loaded — almost always a
    /// missing `description`.
    pub unloadable: usize,
    /// Skills whose two copies in the repo are not the same file, so the two
    /// CLIs load different instructions under one name.
    pub diverged: usize,
    /// Skill roots git ignores in this repo, so a card never carries what is
    /// in them. As much a one-sided skill as a missing copy is — only for
    /// every checkout but this one.
    pub gitignored: Vec<String>,
    /// GH #227: links (a skill directory or a whole root) whose skill no card
    /// carries — git ignores the link itself, or the files it points to. Not
    /// in `gitignored`: the lines Un-ignore writes open directories, and git
    /// stores a link as a file. A link inside a gitignored root is left to
    /// that root's sentence (Un-ignore carries it with the rest).
    pub ignored_links: Vec<String>,
    /// Paths (a root, one skill's copy, a link) git gave no answer for. Said
    /// as unknown — never counted as carried.
    pub unanswered: Vec<String>,
    /// Git's own words for what it would not answer, for Details.
    pub git_details: Vec<String>,
    /// The workspace these counts are about. The doctor is machine-wide, so
    /// without this the number would be about a repo nobody named.
    pub workspace: String,
    pub detail: String,
}

/// What the doctor needs to describe the open workspace's project skills.
pub struct ProjectSkillsInput<'a> {
    pub workspace: &'a str,
    pub skills: &'a crate::project_skills::ProjectSkills,
}

/// Ply's microphone authorization, which Claude Code's `/voice`
/// dictation inherits because macOS attributes a PTY child's request to Ply,
/// and which Ply's own dictation in Codex and shell tiles uses directly.
/// Read through AVFoundation, never by opening the device.
#[derive(Serialize, Debug, Clone)]
pub struct MicrophoneStatus {
    pub access: crate::microphone::MicrophoneAccess,
    pub detail: String,
    /// Where a denial is undone. Present only when denied: a prompt from Ply
    /// cannot clear it.
    #[serde(rename = "settingsUrl")]
    pub settings_url: Option<String>,
}

/// How to use it, whatever the state.
const VOICE_HINT: &str =
    "In a Claude tile, run /voice and hold Space; in a Codex or shell tile, hold Space.";

/// The doctor's view of the microphone. Pure, like the rest.
pub fn microphone_status(access: crate::microphone::MicrophoneAccess) -> MicrophoneStatus {
    use crate::microphone::MicrophoneAccess;
    #[cfg(not(windows))]
    let state = match access {
        MicrophoneAccess::NotAsked => {
            "Not asked yet — Request access so macOS asks on Plyloft's behalf."
        }
        MicrophoneAccess::Granted => "Dictation can hear you.",
        MicrophoneAccess::Denied => {
            "Denied — turn Plyloft on in System Settings → Privacy & Security → Microphone."
        }
    };
    // Windows asks no question of a desktop app: the switches decide, and
    // `microphone::status` never answers NotAsked there.
    #[cfg(windows)]
    let state = match access {
        MicrophoneAccess::NotAsked | MicrophoneAccess::Granted => "Dictation can hear you.",
        MicrophoneAccess::Denied => {
            "Denied — turn on Microphone access and Let desktop apps access your microphone in Settings → Privacy & security → Microphone."
        }
    };
    MicrophoneStatus {
        access,
        detail: format!("{state} {VOICE_HINT}"),
        settings_url: (access == MicrophoneAccess::Denied)
            .then(|| crate::microphone::SETTINGS_URL.to_string()),
    }
}

/// #47: the whisper.cpp row. Optional — only Ply's dictation in Codex and
/// shell tiles needs it. Resolved by the command (cached PATH, then the brew
/// prefixes); no version probe, so opening the doctor never runs it.
pub fn whisper_tool_status(path: Option<String>) -> ToolStatus {
    let found = path.is_some();
    ToolStatus {
        id: crate::dictation::WHISPER_CLI.into(),
        name: "whisper.cpp".into(),
        required: false,
        found,
        path,
        version: None,
        version_ok: found,
        detail: if found {
            format!("Optional — transcribes dictation in Codex and shell tiles, on {THIS_MACHINE}.")
        } else if cfg!(windows) {
            crate::dictation::WHISPER_UNAVAILABLE.into()
        } else {
            "Optional — install to dictate in Codex and shell tiles (hold Space). Runs locally, no cloud.".into()
        },
        install_cmd: install_cmd_for(crate::dictation::WHISPER_CLI, cfg!(windows)),
        docs_url: crate::dictation::WHISPER_DOCS.into(),
        reviewer: None,
        auth: None,
        update: None,
    }
}

/// #47: the dictation model row — whether the model Settings selects is
/// downloaded.
#[derive(Serialize, Debug, Clone)]
pub struct WhisperModelStatus {
    pub model: crate::dictation::DictationModel,
    pub present: bool,
    pub path: String,
    pub detail: String,
}

/// Pure, like the rest: the caller checks the file.
pub fn whisper_model_status(
    model: crate::dictation::DictationModel,
    path: &std::path::Path,
    present: bool,
) -> WhisperModelStatus {
    let size_mb = model.approx_bytes() / (1024 * 1024);
    WhisperModelStatus {
        model,
        present,
        path: path.to_string_lossy().to_string(),
        detail: if present {
            format!("The {} model is downloaded; dictation uses it.", model.as_str())
        } else {
            format!(
                "Not downloaded — Settings › Look and feel › Dictation › The model file › Download (~{size_mb} MB)."
            )
        },
    }
}

/// GH #68: the "Dictation in shell tiles" row. A shell tile inserts the
/// transcript as a bracketed paste and never offers dictation to a line
/// editor without it, so macOS `/bin/bash` 3.2 gets none — silently, before
/// this row. Derived from the configured tile shell and its `--version`, not
/// from a live tile, so it reads the same with no tile open.
#[derive(Serialize, Debug, Clone)]
pub struct DictationShellStatus {
    /// The program new shell tiles run.
    pub shell: String,
    /// Short name for the row, e.g. "zsh" or "bash 3.2.57".
    pub label: String,
    /// The program exists. False means new shell tiles cannot start at all.
    pub found: bool,
    /// Its line editor enables bracketed paste, so held Space dictates.
    pub ok: bool,
    pub detail: String,
}

/// The advice for a shell with no bracketed paste. The tile toast says the
/// same (`toastNoBracketedPaste` in dictationController.ts). Windows has no
/// bash 5 to install: its tiles default to PowerShell 7, which has it.
#[cfg(not(windows))]
const NO_PASTE_ADVICE: &str =
    "switch the tile shell to zsh in Settings › Look and feel › Editor and terminals, or install bash 5 (brew install bash).";
#[cfg(windows)]
const NO_PASTE_ADVICE: &str = "switch the tile shell to PowerShell 7 in Settings › Look and feel › Editor and terminals.";

/// `major.minor.patch` out of `GNU bash, version 3.2.57(1)-release (...)`.
fn bash_version(output: &str) -> Option<(u32, u32, String)> {
    let first = output.lines().next()?;
    if !first.contains("GNU bash") {
        return None;
    }
    let rest = &first[first.find("version")? + "version".len()..];
    let token: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = token.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor, token.trim_end_matches('.').to_string()))
}

/// Pure: the caller checks the file and runs `--version` (bash and sh only;
/// `version_output` is `None` for any other shell).
pub fn dictation_shell_status(
    shell: &str,
    found: bool,
    version_output: Option<&str>,
) -> DictationShellStatus {
    let name = std::path::Path::new(shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| shell.to_string());
    // `zsh.exe` is zsh.
    #[cfg(windows)]
    let name = {
        let lower = name.to_ascii_lowercase();
        lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
    };
    let status = |label: String, ok: bool, detail: String| DictationShellStatus {
        shell: shell.to_string(),
        label,
        found,
        ok,
        detail,
    };
    if !found {
        return status(
            name,
            false,
            format!("{shell} isn't there, so new shell tiles can't start. Choose another tile shell in Settings › Look and feel › Editor and terminals."),
        );
    }
    if name == "zsh" || name == "fish" {
        return status(
            name.clone(),
            true,
            // G2 walk (DS7): plain words; "bracketed paste" is the reason, not the row.
            format!("{name} takes dictation: hold Space at a shell tile's prompt to dictate."),
        );
    }
    if let Some((major, minor, version)) = version_output.and_then(bash_version) {
        let label = format!("bash {version}");
        let short = format!("{major}.{minor}");
        // Readline has had the setting since bash 4.4 and turns it on by
        // default from 5.1.
        return if (major, minor) >= (5, 1) {
            status(
                label,
                true,
                format!("bash {short} takes dictation: hold Space at a shell tile's prompt to dictate."),
            )
        } else if (major, minor) >= (4, 4) {
            status(
                label,
                false,
                format!(
                    "Dictation can't type into bash {short} as it is set up: add `set enable-bracketed-paste on` to ~/.inputrc, or {NO_PASTE_ADVICE}"
                ),
            )
        } else {
            let who = if shell.starts_with("/bin/") {
                format!("macOS {shell} {short}")
            } else {
                format!("{shell} {short}")
            };
            status(
                label,
                false,
                format!("Dictation can't type into {who}: {NO_PASTE_ADVICE}"),
            )
        };
    }
    status(
        name.clone(),
        false,
        format!(
            "Plyloft can't tell whether dictation can type into {name} (it can into zsh, fish and bash 5.1 or later). If held Space does nothing at the prompt, {NO_PASTE_ADVICE}"
        ),
    )
}

/// GH #79: the "Shared workspace definition" row.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedDefinitionStatus {
    pub workspace: String,
    /// `ok`, `pending` (local edits not in the repo yet), `unreadable`, and
    /// 1.173.0 (B1): `kept` (the repository's areas break the rules; this
    /// Mac keeps its last good ones) or `held` (it has none: no card may
    /// start, ship or release).
    pub state: &'static str,
    /// The row's short value: "unreadable (line N)", "Pending sync", "from main".
    pub summary: String,
    pub detail: String,
}

/// The doctor's view of one workspace's definition cache. Pure.
pub fn shared_definition_status(
    workspace: &str,
    cache: &crate::workspace_definition::DefinitionCache,
    queue: &crate::shared_config::PublishQueue,
    local_areas: &[crate::areas::AreaDef],
) -> Option<SharedDefinitionStatus> {
    use crate::workspace_definition::{DefinitionSource, PendingState};
    if let Some(bad) = &cache.unreadable {
        let kept = if cache.definition.is_some() {
            "Plyloft keeps using the last good copy"
        } else {
            concat!("Plyloft has no earlier copy, so ", crate::this_machine!(), " keeps its own settings")
        };
        let branch = cache.branch.as_deref().unwrap_or("the integration branch");
        return Some(SharedDefinitionStatus {
            workspace: workspace.to_string(),
            state: "unreadable",
            summary: bad.summary(),
            // 1.175.0 (C6, SC-9): a value a later Plyloft added isn't the
            // repository's to fix — this computer needs the update.
            // Round 2: with what it couldn't read, so a kind typed wrong
            // (which reads the same) can be found.
            detail: bad.newer_detail(branch, cache.definition.is_some()).unwrap_or_else(|| {
                format!(
                    "{} on {branch} in {workspace} can't be read: {}. {kept}, and never writes over the file; fix it in the repository.",
                    bad.path, bad.message
                )
            }),
        });
    }
    cache.definition.as_ref()?;
    let branch = cache.branch.as_deref().unwrap_or("the integration branch");
    // 1.173.0 (B1): areas that break the rules hold that field alone. Said
    // after anything pending (a queued fix, its pull request), never instead.
    let areas = crate::areas::doctor_sentence(cache, local_areas);
    let with_areas = |row: SharedDefinitionStatus| match &areas {
        None => row,
        Some((held, sentence)) => SharedDefinitionStatus {
            state: match (*held, row.state) {
                (true, _) => "held",
                (false, "pending") => "pending",
                (false, _) => "kept",
            },
            summary: if row.state == "pending" { row.summary } else { "areas can't be used".to_string() },
            detail: format!("{} {sentence}", row.detail),
            ..row
        },
    };
    // 1.173.0 (C3 Challenger 3): a field both sides changed waits for the
    // person's choice, not for the network: said first.
    let choosing: Vec<&str> = queue
        .fields
        .iter()
        .filter(|(_, field)| field.conflict.is_some())
        .map(|(key, _)| crate::workspace_definition::field_label(key))
        .collect();
    if !choosing.is_empty() {
        return Some(with_areas(SharedDefinitionStatus {
            workspace: workspace.to_string(),
            state: "pending",
            summary: format!("Waiting for your choice: {}", choosing.join(", ")),
            detail: format!(
                "{} in {workspace} changed here and in the repository too. {THIS_MACHINE_CAP} keeps its value; Plyloft publishes nothing for it until you choose, in the Inbox or on the Settings page with that row.",
                choosing.join(", ")
            ),
        }));
    }
    // GH #80: pending edits wait for the write channel — in a pull request, or
    // queued until the branch can be reached.
    let prs: std::collections::BTreeSet<u64> = cache
        .pending
        .keys()
        .filter_map(|key| queue.fields.get(key)?.pull_request.as_ref())
        .chain(queue.create_pull_request.as_ref())
        .map(|pr| pr.number)
        .collect();
    if cache.pending_state == Some(PendingState::WaitingForPr) && !prs.is_empty() {
        let fields = if cache.pending.is_empty() {
            ".atelier/workspace.json".to_string()
        } else {
            cache.pending.keys().cloned().collect::<Vec<_>>().join(", ")
        };
        let numbers = prs
            .iter()
            .map(|n| format!("#{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Some(with_areas(SharedDefinitionStatus {
            workspace: workspace.to_string(),
            state: "pending",
            summary: format!("Waiting for PR {numbers} to merge"),
            detail: format!(
                "{branch} refused a direct push of {fields} in {workspace}, so Plyloft opened pull request {numbers}. {THIS_MACHINE_CAP} keeps its value until it merges."
            ),
        }));
    }
    if !cache.pending.is_empty() || queue.create_definition {
        let what = if cache.pending.is_empty() {
            ".atelier/workspace.json".to_string()
        } else {
            cache.pending.keys().cloned().collect::<Vec<_>>().join(", ")
        };
        let why = queue
            .last_error
            .as_deref()
            .map(|e| format!(" Last attempt: {}.", e.lines().last().unwrap_or(e).trim()))
            .unwrap_or_default();
        return Some(with_areas(SharedDefinitionStatus {
            workspace: workspace.to_string(),
            state: "pending",
            summary: "Pending sync".to_string(),
            detail: format!(
                "{what} in {workspace} applies on {THIS_MACHINE} and is queued for {branch}; Plyloft publishes it on the next Sync or refresh.{why}"
            ),
        }));
    }
    let detail = match cache.source {
        DefinitionSource::Repo => format!(
            "{workspace} follows .atelier/workspace.json on {branch}{}.",
            cache
                .author
                .as_deref()
                .map(|a| format!(", last changed by {a}"))
                .unwrap_or_default()
        ),
        DefinitionSource::Legacy => format!(
            "{workspace} has only the legacy .atelier/workspace_default.json on {branch}; Plyloft converted it on {THIS_MACHINE}. Publish .atelier/workspace.json from Settings › Project › General to share the whole definition."
        ),
        DefinitionSource::Seeded => format!(
            "{workspace} was shared from {THIS_MACHINE}; .atelier/workspace.json is not on {branch} yet."
        ),
    };
    Some(with_areas(SharedDefinitionStatus {
        workspace: workspace.to_string(),
        state: "ok",
        summary: format!("from {branch}"),
        detail,
    }))
}

/// Aggregate dependency report for the whole machine.
#[derive(Serialize, Debug, Clone)]
pub struct DoctorReport {
    pub tools: Vec<ToolStatus>,
    /// Passthrough of `ShellEnv::probe_error` (broken login shell, etc.).
    #[serde(rename = "probeError")]
    pub probe_error: Option<String>,
    /// v1.116.0: the "N team skills loaded" row, or `None` off a team.
    #[serde(rename = "teamSkills")]
    pub team_skills: Option<TeamSkillsStatus>,
    /// v1.117.0: the "N project skills loaded" row, or `None` when the open
    /// workspace has no skill directories.
    #[serde(rename = "projectSkills")]
    pub project_skills: Option<ProjectSkillsStatus>,
    /// The Microphone row. `None` from [`build_report`], which stays
    /// free of OS calls; the command fills it in. Also `None` when
    /// AVFoundation cannot answer, so the row is absent rather than a guess.
    pub microphone: Option<MicrophoneStatus>,
    /// #47: the Whisper model row. `None` from [`build_report`], which does
    /// no file I/O; the command fills it in.
    #[serde(rename = "whisperModel")]
    pub whisper_model: Option<WhisperModelStatus>,
    /// GH #68: the "Dictation in shell tiles" row. `None` from
    /// [`build_report`], which runs nothing; the command fills it in.
    #[serde(rename = "dictationShell")]
    pub dictation_shell: Option<DictationShellStatus>,
    /// GH #79: the open workspace's `.atelier/workspace.json`. `None` from
    /// [`build_report`]; the command fills it in when the workspace has a
    /// shared definition (or an unreadable one).
    #[serde(rename = "sharedDefinition")]
    pub shared_definition: Option<SharedDefinitionStatus>,
    /// 1.173.0 (D1): the open workspace's Railway row — "signed in ·
    /// project <name>" or "not linked here". `None` from [`build_report`]
    /// and without the Railway program; the command fills it in. Optional:
    /// never an error.
    pub railway: Option<crate::deploy_map::RailwayDoctorStatus>,
    /// OB-2 (§13.1): git works (and Git Bash on Windows) **and** `ai_ready`.
    /// A too-old claude still counts: it's a warning, not a block (plain-text
    /// fallback still works).
    #[serde(rename = "allRequiredOk")]
    pub all_required_ok: bool,
    /// OB-2 (§13.1): at least one AI — Claude Code or Codex — is found,
    /// usable and not signed out. One is enough.
    #[serde(rename = "aiReady")]
    pub ai_ready: bool,
    /// OB-2: the Git identity row; `None` while git doesn't work or was not
    /// read.
    #[serde(rename = "gitIdentity")]
    pub git_identity: Option<GitIdentityStatus>,
}

/// How each tool is installed, per platform — the one place a command lives.
/// `None` where the platform has no one-line install (whisper.cpp and bash 5
/// on Windows). The Mac's commands are the ones the rows always showed.
pub fn install_cmd(tool: &str) -> Option<&'static str> {
    install_cmd_on(tool, cfg!(windows))
}

/// OB-2 (MEASUREMENTS §8): `gh` on a Mac without Homebrew — the release zip
/// for Apple Silicon, its line checked against `gh_<ver>_checksums.txt`,
/// `bin/gh` copied to `~/.local/bin` (on Ply's PATH). `<ver>` comes from the
/// `releases/latest` redirect, so no API and no rate limit. POSIX, so a bash
/// or zsh tile runs it alike.
pub const GH_ZIP_INSTALL: &str = concat!(
    "v=$(curl -fsSI https://github.com/cli/cli/releases/latest | grep -i '^location:' | sed 's#.*/tag/v##' | tr -d '\\r\\n')",
    " && [ -n \"$v\" ] && z=\"gh_${v}_macOS_arm64\" && d=$(mktemp -d)",
    " && curl -fsSL -o \"$d/$z.zip\" \"https://github.com/cli/cli/releases/download/v$v/$z.zip\"",
    " && curl -fsSL -o \"$d/sums.txt\" \"https://github.com/cli/cli/releases/download/v$v/gh_${v}_checksums.txt\"",
    " && (cd \"$d\" && grep \" $z.zip\\$\" sums.txt | shasum -a 256 -c -)",
    " && unzip -q \"$d/$z.zip\" -d \"$d\" && mkdir -p ~/.local/bin && cp \"$d/$z/bin/gh\" ~/.local/bin/gh",
    " && rm -rf \"$d\" && ~/.local/bin/gh --version"
);

/// Every winget call Ply offers names its source and accepts its agreements
/// (MEASUREMENTS §7: without `--accept-source-agreements` winget exits
/// `0x8A150046` on a fresh PC). Node and gh install per user — the portable
/// zip, no administrator; Git's `--scope user` waits for OB-6's Windows walk.
pub const WINGET_GIT: &str = "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements";
pub const WINGET_GH: &str = "winget install --id GitHub.cli -e --source winget --scope user --accept-package-agreements --accept-source-agreements";
pub const WINGET_NODE: &str = "winget install --id OpenJS.NodeJS.LTS -e --source winget --scope user --accept-package-agreements --accept-source-agreements";
/// OB-2 review (P3-5): Git for Windows over a git that has no Git Bash
/// (MinGit, Scoop): `--force`, because winget may already list `Git.Git` and
/// would otherwise do nothing.
pub const WINGET_GIT_FORCE: &str = "winget install --id Git.Git -e --source winget --force --accept-package-agreements --accept-source-agreements";
/// Codex's official Windows installer (MEASUREMENTS §7).
pub const CODEX_WINDOWS_INSTALL: &str = "irm https://chatgpt.com/codex/install.ps1 | iex";
pub const WINGET_GH_UPGRADE: &str = "winget upgrade --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements";

pub(crate) fn install_cmd_on(tool: &str, windows: bool) -> Option<&'static str> {
    let (mac, win) = match tool {
        "git" => ("xcode-select --install", Some(WINGET_GIT)),
        // v1.113.0: the official installers (no Node, land in ~/.local/bin).
        // `npm install -g` is the legacy channel and would leave a second
        // binary next to a native one.
        "claude" => (
            "curl -fsSL https://claude.ai/install.sh | bash",
            Some("irm https://claude.ai/install.ps1 | iex"),
        ),
        // The standalone installer doubles as the reinstall/update path.
        // OB-2 review (owner decision, MEASUREMENTS §7): Windows uses the
        // official `install.ps1` too — the native `codex.exe`, no Node.js.
        "codex" => (
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            Some(CODEX_WINDOWS_INSTALL),
        ),
        "gh" => ("brew install gh", Some(WINGET_GH)),
        // OB-2: the Mac without Homebrew.
        "gh-zip" => (GH_ZIP_INSTALL, None),
        "rg" => ("brew install ripgrep", Some("winget install --id BurntSushi.ripgrep.MSVC")),
        "node" => ("brew install node", Some(WINGET_NODE)),
        "whisper-cli" => (crate::dictation::WHISPER_INSTALL_CMD, None),
        "bash" => ("brew install bash", None),
        _ => return None,
    };
    if windows {
        win
    } else {
        Some(mac)
    }
}

/// A tool the table knows, on the platform the report is for; a row's
/// command is never empty by accident.
fn install_cmd_for(tool: &str, windows: bool) -> String {
    install_cmd_on(tool, windows).unwrap_or_default().to_string()
}

const CLAUDE_DOCS: &str = "https://docs.claude.com/en/docs/claude-code/setup";
const GIT_DOCS: &str = "https://git-scm.com/downloads";
const CODEX_DOCS: &str = "https://developers.openai.com/codex/quickstart";
const GH_DOCS: &str = "https://cli.github.com";
const NODE_DOCS: &str = "https://nodejs.org/en/download";

// ── OB-2 (§13.1): one AI is enough ─────────────────────────────────────

/// Git works. 1.174.0 (DS7): Diagnostics titles the row by what Git is for
/// ("Gives each card its own copy of the project"), so the sentence is the
/// state alone.
pub const GIT_READY_DETAIL: &str = "Ready.";
/// No git at all.
pub const GIT_MISSING_DETAIL: &str =
    "Required — without Git, Plyloft can't give each card its own copy of the project.";
/// A Mac without the Command Line Tools: `/usr/bin/git` is Apple's shim,
/// which Ply never runs (it would open the install dialog unasked).
pub const GIT_NO_CLT_DETAIL: &str =
    "Not installed. Git comes with Apple's Command Line Tools.";
/// A git that resolves and does not answer `--version`.
pub const GIT_NOT_STARTING_DETAIL: &str = "Found, but it doesn't start. Reinstall it.";

/// DS7 round 1: Diagnostics titles the row "Runs your project checks".
pub const GIT_BASH_READY_DETAIL: &str = "Ready.";
pub const GIT_BASH_MISSING_DETAIL: &str =
    "Git works, but Git Bash wasn't found. Plyloft needs it to run project checks; Git for Windows includes it.";
pub const GIT_BASH_NO_GIT_DETAIL: &str = "Not installed. It comes with Git for Windows.";

pub const CLAUDE_MISSING_DETAIL: &str =
    "Not installed. One AI is enough: install Claude Code or Codex.";
pub const CLAUDE_OPTIONAL_DETAIL: &str = "Not installed. Optional — Codex is ready.";
pub const CODEX_MISSING_DETAIL: &str =
    "Not installed. One AI is enough: install Codex or Claude Code.";
pub const CODEX_OPTIONAL_DETAIL: &str = "Not installed. Optional — Claude Code is ready.";
pub const CODEX_READY_DETAIL: &str = "Runs your Codex agents.";

pub const NODE_READY_DETAIL: &str = "Runs your Codex, which was installed with npm.";
pub const NODE_MISSING_DETAIL: &str =
    "Not found. Your Codex was installed with npm and runs on Node.js.";

/// What the Codex sign-in read found in Codex's own config: where its login
/// is kept (`cli_auth_credentials_store`, MEASUREMENTS §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexStore {
    /// `file`, or unset: the login is `auth.json`.
    File,
    /// `keyring` or `auto`: the login may be in the OS keychain, with no
    /// `auth.json` — a missing file then says nothing.
    Keyring,
    /// `config.toml` exists and could not be read or parsed.
    Unreadable,
}

/// Codex's sign-in when Ply can't see it (a keychain login, or a config it
/// could not read). Neutral, like Claude's: never "signed out".
pub const CODEX_UNSEEN_DETAIL: &str = concat!(
    "Found. Plyloft could not see a Codex sign-in on ",
    crate::this_machine!(),
    "; if your Codex tiles start, there is nothing to do."
);

/// OB-2 (§13.1, D4): whether Codex is signed in, from **file presence only**
/// — `auth.json` in the real `CODEX_HOME`, read beside `config.toml`'s
/// `cli_auth_credentials_store`. No process: `codex login status` runs only
/// in Setup's AI step (OB-5), never here. Pure, so each case is tested.
pub fn codex_auth_status(store: CodexStore, file: CredentialSeen) -> ToolAuth {
    let neutral = || ToolAuth {
        signed_in: None,
        detail: CODEX_UNSEEN_DETAIL.into(),
        command: "codex login".into(),
        action: "Sign in".into(),
        optional_step: true,
    };
    match (file, store) {
        (CredentialSeen::Present, _) => ToolAuth {
            signed_in: Some(true),
            detail: "Found and signed in.".into(),
            command: "codex login".into(),
            action: "Sign in".into(),
            optional_step: false,
        },
        (CredentialSeen::Absent, CodexStore::File) => ToolAuth {
            signed_in: Some(false),
            detail: "Not signed in.".into(),
            command: "codex login".into(),
            action: "Sign in".into(),
            optional_step: false,
        },
        _ => neutral(),
    }
}

/// The git identity row: what `git config --global --get user.name` and
/// `user.email` returned. Read only — Ply never writes it here.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityStatus {
    pub name: Option<String>,
    pub email: Option<String>,
    /// Both are set.
    pub set: bool,
    pub detail: String,
}

/// Pure: the row from the two values (blank reads as unset).
pub fn git_identity_status(name: Option<&str>, email: Option<&str>) -> GitIdentityStatus {
    let clean = |v: Option<&str>| v.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    let (name, email) = (clean(name), clean(email));
    let detail = match (&name, &email) {
        (Some(n), Some(e)) => format!("Git knows you as {n} <{e}>."),
        (None, _) => "Git doesn't know your name yet.".to_string(),
        (Some(_), None) => "Git doesn't know your email yet.".to_string(),
    };
    GitIdentityStatus { set: name.is_some() && email.is_some(), name, email, detail }
}

/// A newer release of a found tool (D6): offered with a quiet `Update`,
/// run only on a press.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolUpdate {
    pub latest: String,
    /// `Version 2.1.290 is available.`
    pub detail: String,
    /// What `Update` runs (§6 `update.*`).
    pub command: String,
}

/// The latest releases Ply read from each vendor's own feed. `None` = not
/// read (not asked yet, or offline): no update line.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LatestVersions {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub gh: Option<String>,
}

/// Pure: an update line when `latest` is newer than `installed`. Anything
/// unreadable says nothing.
pub fn update_line(installed: Option<&str>, latest: Option<&str>, command: &str) -> Option<ToolUpdate> {
    let now = shell_env::parse_semver_from_text(installed?).as_deref().and_then(shell_env::parse_semver)?;
    let latest = latest?.trim();
    let next = shell_env::parse_semver(latest)?;
    (next > now).then(|| ToolUpdate {
        latest: latest.to_string(),
        detail: format!("Version {latest} is available."),
        command: command.to_string(),
    })
}

/// §6 `update.codex`: the standalone install updates itself; npm and
/// Homebrew installs update through their own manager. `real_path` is the
/// resolved binary with its links followed.
pub fn codex_update_cmd(real_path: Option<&str>, windows: bool) -> Option<&'static str> {
    let p = real_path.unwrap_or_default();
    if codex_is_npm(real_path) {
        Some("npm install -g @openai/codex@latest")
    } else if windows {
        // OB-2 review (P3-4): `install.ps1` only over the Codex it installed;
        // Scoop, winget or an unknown place get no Update step.
        codex_is_standalone_windows(real_path).then_some(CODEX_WINDOWS_INSTALL)
    } else if p.contains("/Cellar/") || p.contains("/Caskroom/") {
        Some("brew upgrade codex")
    } else {
        Some("codex update")
    }
}

/// Where Codex's `install.ps1` puts `codex.exe`:
/// `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` (MEASUREMENTS §7), matched
/// from `Programs` on so a moved `%LOCALAPPDATA%` still counts.
pub fn codex_is_standalone_windows(real_path: Option<&str>) -> bool {
    let p = real_path.unwrap_or_default().to_ascii_lowercase().replace('\\', "/");
    p.contains("/programs/openai/codex/bin/")
}

/// A Codex installed with npm (`%APPDATA%\\npm\\codex.cmd`, a
/// `node_modules` wrapper): the one kind that runs on Node.js.
pub fn codex_is_npm(real_path: Option<&str>) -> bool {
    let p = real_path.unwrap_or_default().to_ascii_lowercase().replace('\\', "/");
    p.contains("/node_modules/") || p.contains("/npm/") || p.ends_with(".cmd")
}

/// §6 `update.gh`: winget's, Homebrew's, or the zip path again — the zip
/// only for the gh it installed (`~/.local/bin/gh`). OB-2 review (P3-3): a gh
/// from anywhere else (the `.pkg` in `/usr/local/bin`, MacPorts) gets no
/// Update: the zip would leave a second gh beside it and the line would never
/// clear.
pub fn gh_update_cmd(real_path: Option<&str>, windows: bool) -> Option<&'static str> {
    let p = real_path.unwrap_or_default();
    if windows {
        Some(WINGET_GH_UPGRADE)
    } else if p.contains("/Cellar/") || p.starts_with("/opt/homebrew/") {
        Some("brew upgrade gh")
    } else if p.ends_with("/.local/bin/gh") {
        Some(GH_ZIP_INSTALL)
    } else {
        None
    }
}

/// The update line of one tool (D6), from the facts' latest releases. Only on
/// a tool that is found and fine to run; a missing one is installed instead.
fn tool_update(id: &str, env: &ShellEnv, facts: &DoctorFacts) -> Option<ToolUpdate> {
    match id {
        "claude" if env.supports_stream_json() => {
            update_line(env.claude_version.as_deref(), facts.latest.claude.as_deref(), "claude update")
        }
        "codex" if env.codex_healthy() => update_line(
            env.codex_version.as_deref(),
            facts.latest.codex.as_deref(),
            codex_update_cmd(facts.codex_real_path.as_deref(), facts.windows)?,
        ),
        "gh" if env.gh_path.is_some() => update_line(
            env.gh_version.as_deref(),
            facts.latest.gh.as_deref(),
            gh_update_cmd(facts.gh_real_path.as_deref(), facts.windows)?,
        ),
        _ => None,
    }
}

/// OB-2 review (P3-2): the update lines, attached once the latest releases
/// have been read — the command reads them beside the sign-in checks and
/// joins them last.
pub fn apply_latest(report: &mut DoctorReport, env: &ShellEnv, facts: &DoctorFacts) {
    for tool in &mut report.tools {
        tool.update = tool_update(&tool.id, env, facts);
    }
}

/// OB-2: what the doctor command reads besides the probe, handed to the pure
/// [`build_report_with`]. `Default` is a read that looked at nothing.
#[derive(Debug, Clone, Default)]
pub struct DoctorFacts {
    /// The rows and words for Windows (Git Bash, Node, winget).
    pub windows: bool,
    /// Codex's sign-in from `codex_auth_status`; `None` = not read.
    pub codex_auth: Option<ToolAuth>,
    /// `(user.name, user.email)`, read only when git works; `None` = not read.
    pub identity: Option<(Option<String>, Option<String>)>,
    /// The newest releases, read only from Diagnostics and cached.
    pub latest: LatestVersions,
    /// The resolved binaries with their links followed, for the update path.
    pub codex_real_path: Option<String>,
    pub gh_real_path: Option<String>,
    /// Homebrew resolves: `gh` installs with it; otherwise the zip path.
    pub brew: bool,
}

/// Build the report from a probe snapshot. Pure — no I/O — so it is unit
/// testable against synthetic `ShellEnv`s. A read that looked at nothing
/// besides the probe (no sign-in, no identity, no latest release).
pub fn build_report(
    env: &ShellEnv,
    capabilities: Option<&ReviewerCapabilityRegistry>,
    team_skills: Option<TeamSkillsInput<'_>>,
    project_skills: Option<ProjectSkillsInput<'_>>,
) -> DoctorReport {
    let facts = DoctorFacts { windows: cfg!(windows), ..DoctorFacts::default() };
    build_report_with(env, capabilities, team_skills, project_skills, &facts)
}

/// [`build_report`] with what the command read around the probe. Pure.
pub fn build_report_with(
    env: &ShellEnv,
    capabilities: Option<&ReviewerCapabilityRegistry>,
    team_skills: Option<TeamSkillsInput<'_>>,
    project_skills: Option<ProjectSkillsInput<'_>>,
    facts: &DoctorFacts,
) -> DoctorReport {
    let windows = facts.windows;
    let mut tools = Vec::with_capacity(6);

    // --- git: required. Works = resolved and answered `--version`; on a Mac
    // without the CLT the shim is never run, so it has no version (C9). ---
    let git_ok = env.git_works();
    tools.push(ToolStatus {
        id: "git".into(),
        name: "Git".into(),
        required: true,
        found: git_ok,
        path: env.git_path.clone(),
        version: env.git_version.clone(),
        version_ok: git_ok,
        detail: if git_ok {
            GIT_READY_DETAIL.into()
        } else if !windows && env.clt_installed == Some(false) {
            GIT_NO_CLT_DETAIL.into()
        } else if env.git_path.is_some() {
            GIT_NOT_STARTING_DETAIL.into()
        } else {
            GIT_MISSING_DETAIL.into()
        },
        // OB-6 review (P3-6): a Windows git that resolves but doesn't start
        // is reinstalled with --force (winget would call it installed).
        install_cmd: if windows && !git_ok && env.git_path.is_some() {
            WINGET_GIT_FORCE.into()
        } else {
            install_cmd_for("git", windows)
        },
        docs_url: GIT_DOCS.into(),
        reviewer: None,
        auth: None,
        update: None,
    });

    // --- Git Bash (Windows): required there — project checks run in it. ---
    let git_bash_ok = !windows || env.git_bash_path.is_some();
    if windows {
        tools.push(ToolStatus {
            id: "git-bash".into(),
            name: "Git Bash".into(),
            required: true,
            found: git_bash_ok,
            path: env.git_bash_path.clone(),
            version: None,
            version_ok: git_bash_ok,
            detail: if git_bash_ok {
                GIT_BASH_READY_DETAIL.into()
            } else if git_ok {
                GIT_BASH_MISSING_DETAIL.into()
            } else {
                GIT_BASH_NO_GIT_DETAIL.into()
            },
            // P3-5: over a git without Git Bash, winget may already list
            // Git.Git and do nothing; `--force` installs it anyway.
            install_cmd: if git_ok { WINGET_GIT_FORCE.into() } else { install_cmd_for("git", windows) },
            docs_url: GIT_DOCS.into(),
            reviewer: None,
            auth: None,
            update: None,
        });
    }

    // One AI is enough (§13.1): each is ready when found, usable and not
    // signed out. Claude is never read as signed out (GH #169); Codex is
    // signed out only when its `auth.json` is missing from a file store.
    let claude_found = env.claude_path.is_some();
    // 1.176.0 R3: Codex's rule for Claude — found is about the file, healthy
    // about it starting (`ShellEnv::claude_healthy`). A launcher left
    // pointing at a payload a failed update removed resolves and never runs.
    let claude_starts = env.claude_healthy();
    // R3 review 1: a `--version` that didn't answer in time is not "too
    // old" either: the row stays neutral (`CLAUDE_VERSION_UNKNOWN_DETAIL`).
    let claude_ok = env.supports_stream_json() || env.claude_version_unknown;
    let claude_ready = claude_starts;
    let codex_found = env.codex_path.is_some();
    // Found is about the file; healthy is about it starting. See
    // `ShellEnv::codex_healthy` — a wrapper left behind by a half-finished
    // install resolves on PATH and crashes on every run.
    let codex_ok = env.codex_healthy();
    let codex_auth = if codex_found { facts.codex_auth.clone() } else { None };
    let codex_ready =
        codex_ok && codex_auth.as_ref().map_or(true, |a| a.signed_in != Some(false));
    let ai_ready = claude_ready || codex_ready;

    // --- claude: one of the two AIs ---
    tools.push(ToolStatus {
        id: "claude".into(),
        name: "Claude Code".into(),
        required: false,
        found: claude_found,
        path: env.claude_path.clone(),
        version: env.claude_version.clone(),
        version_ok: claude_ok,
        detail: if !claude_found {
            if codex_ready {
                CLAUDE_OPTIONAL_DETAIL.into()
            } else {
                CLAUDE_MISSING_DETAIL.into()
            }
        } else if !claude_starts {
            CLAUDE_NOT_STARTING_DETAIL.into()
        } else if env.claude_version_unknown {
            CLAUDE_VERSION_UNKNOWN_DETAIL.into()
        } else if !claude_ok {
            "Installed but too old — update it for token tracking and stream output.".into()
        } else {
            CLAUDE_READY_DETAIL.into()
        },
        // R3: `claude update` only for a Claude that runs and is old: one
        // that doesn't start can't update itself (R0 C4) — the official
        // installer puts it back, as for Codex.
        install_cmd: if claude_starts && !claude_ok {
            "claude update".into()
        } else {
            install_cmd_for("claude", windows)
        },
        docs_url: CLAUDE_DOCS.into(),
        reviewer: capabilities.map(|r| r.current(ply_collab::Provider::Claude, env)),
        // GH #169: filled in by `commands::dependency_doctor` from
        // `claude_auth::read`, only on a read that asks.
        auth: None,
        update: tool_update("claude", env, facts),
    });

    // --- codex: the other AI ---
    tools.push(ToolStatus {
        id: "codex".into(),
        name: "Codex CLI".into(),
        required: false,
        found: codex_found,
        path: env.codex_path.clone(),
        version: env.codex_version.clone(),
        version_ok: codex_ok,
        detail: if !codex_found {
            if claude_ready { CODEX_OPTIONAL_DETAIL.into() } else { CODEX_MISSING_DETAIL.into() }
        } else if !codex_ok {
            // 1.176.0 R7: the Repair wording of this release.
            "Installed but not starting — Repair puts it right, so Codex tiles start again.".into()
        } else if env.codex_version_unknown {
            CODEX_VERSION_UNKNOWN_DETAIL.into()
        } else {
            CODEX_READY_DETAIL.into()
        },
        install_cmd: install_cmd_for("codex", windows),
        docs_url: CODEX_DOCS.into(),
        reviewer: capabilities.map(|r| r.current(ply_collab::Provider::Codex, env)),
        auth: codex_auth,
        update: tool_update("codex", env, facts),
    });

    // --- Node.js (Windows, while Codex is installed or chosen) ---
    // OB-2 review: only an npm-installed Codex runs on Node; the official
    // installer's native `codex.exe` does not.
    if windows && codex_found && codex_is_npm(facts.codex_real_path.as_deref()) {
        let node_found = env.node_path.is_some();
        tools.push(ToolStatus {
            id: "node".into(),
            name: "Node.js".into(),
            required: false,
            found: node_found,
            path: env.node_path.clone(),
            version: env.node_version.clone(),
            version_ok: node_found,
            detail: if node_found { NODE_READY_DETAIL.into() } else { NODE_MISSING_DETAIL.into() },
            install_cmd: install_cmd_for("node", windows),
            docs_url: NODE_DOCS.into(),
            reviewer: None,
            auth: None,
            update: None,
        });
    }

    // --- gh: optional ---
    let gh_found = env.gh_path.is_some();
    tools.push(ToolStatus {
        id: "gh".into(),
        name: "GitHub CLI".into(),
        required: false,
        found: gh_found,
        path: env.gh_path.clone(),
        version: env.gh_version.clone(),
        version_ok: gh_found,
        detail: if gh_found {
            // GH #173: the found fact only. The welcome screen and the banner
            // show this when nothing has asked about sign-in, and "lets you
            // open a PR" was a claim about a `gh` that may be signed out.
            GH_FOUND_DETAIL.into()
        } else {
            "Optional — install to open a PR when shipping a card; local merge works without it.".into()
        },
        // OB-2: a Mac without Homebrew gets the release zip (MEASUREMENTS §8).
        install_cmd: if windows || facts.brew {
            install_cmd_for("gh", windows)
        } else {
            install_cmd_for("gh-zip", false)
        },
        docs_url: GH_DOCS.into(),
        reviewer: None,
        // Filled in by `commands::dependency_doctor`, which can run `gh auth
        // status`; `build_report` is pure and does no I/O.
        auth: None,
        update: tool_update("gh", env, facts),
    });

    // §13.1: git works (and Git Bash on Windows) and one AI is ready.
    let all_required_ok = git_ok && git_bash_ok && ai_ready;

    DoctorReport {
        tools,
        team_skills: team_skills.map(|input| team_skills_status(&input)),
        project_skills: project_skills.and_then(|input| project_skills_status(&input)),
        microphone: None,
        whisper_model: None,
        dictation_shell: None,
        shared_definition: None,
        railway: None,
        probe_error: env.probe_error.clone(),
        all_required_ok,
        ai_ready,
        git_identity: if git_ok {
            facts
                .identity
                .as_ref()
                .map(|(name, email)| git_identity_status(name.as_deref(), email.as_deref()))
        } else {
            None
        },
    }
}

/// The doctor's view of one repo's own skills. Pure, like the rest.
///
/// `None` when the repo has no skill root at all: the CLIs read these
/// directories out of the repository themselves, so a repo with none is not a
/// fault to report — it simply has no project skills.
fn project_skills_status(input: &ProjectSkillsInput<'_>) -> Option<ProjectSkillsStatus> {
    use crate::team_skills::Vendor;
    let skills = input.skills;
    if skills.roots_present.is_empty() {
        return None;
    }
    let loaded = skills.loaded();
    let claude_only = skills.only(Vendor::Claude);
    let codex_only = skills.only(Vendor::Codex);
    let diverged = skills.skills.iter().filter(|skill| skill.diverged).count();

    let mut detail = format!(
        "{loaded} project {} loaded from {} into every Claude and Codex session Plyloft starts there.",
        plural(loaded, "skill", "skills"),
        input.workspace
    );
    if claude_only > 0 || codex_only > 0 {
        // Not an error, and the thing a member would otherwise never notice:
        // no one directory serves both CLIs, so a repo set up for one vendor
        // silently gives the other nothing.
        detail.push_str(&format!(
            " {claude_only} in {} only, {codex_only} in a Codex root only — Install writes both.",
            crate::project_skills::CLAUDE_ROOT,
        ));
    }
    if diverged > 0 {
        detail.push_str(&format!(
            " {diverged} {} a different file in each root, so what a session loads \
             depends on which root it reads.",
            plural(diverged, "skill is", "skills are"),
        ));
    }
    // The repo-wide answer, plus any root a particular skill's copy is
    // ignored in (a `.gitignore` can name one skill), in the panel's order.
    let gitignored: Vec<String> = crate::project_skills::SKILL_ROOTS
        .iter()
        .map(|root| root.rel.to_string())
        .filter(|rel| {
            skills.ignored_roots.contains(rel)
                || skills.skills.iter().any(|skill| skill.ignored_roots.contains(rel))
        })
        .collect();
    if let Some(sentence) = crate::project_skills::gitignored_sentence(&gitignored) {
        detail.push(' ');
        detail.push_str(&sentence);
        // GH #215: the row offers the step itself.
        detail.push_str(" Un-ignore shows the exact lines and adds them when you confirm.");
    }
    let links = link_sentences(skills);
    for sentence in &links.sentences {
        detail.push(' ');
        detail.push_str(sentence);
    }
    if !skills.unloadable.is_empty() {
        detail.push_str(&format!(
            " {} {} not loaded: {}.",
            skills.unloadable.len(),
            plural(skills.unloadable.len(), "directory is", "directories are"),
            unloadable_reasons(skills)
        ));
    }
    for error in &skills.errors {
        detail.push_str(&format!(" {error}."));
    }

    Some(ProjectSkillsStatus {
        loaded,
        claude_only,
        codex_only,
        unloadable: skills.unloadable.len(),
        diverged,
        gitignored,
        ignored_links: links.ignored,
        unanswered: links.unanswered,
        git_details: skills.git_details.clone(),
        workspace: input.workspace.to_string(),
        detail,
    })
}

/// What the row says about links and about paths git would not answer for.
struct LinkSentences {
    sentences: Vec<String>,
    ignored: Vec<String>,
    unanswered: Vec<String>,
}

/// GH #227. A link or a repository of its own is described as what git
/// stores — the link, or the commit, not the files behind it — with git's
/// answer for it said as git gave it, and for a link where its files are.
/// A path git would not answer for is said to be unknown, in plain words
/// (git's own go to Details), never "not ignored".
fn link_sentences(skills: &crate::project_skills::ProjectSkills) -> LinkSentences {
    use crate::project_skills::{BoundaryKind, TargetState};
    let mut sentences = Vec::new();
    let mut ignored = Vec::new();
    let mut unanswered = Vec::new();
    for b in &skills.boundaries {
        // A skill's link inside a root git ignores: the root's sentence and
        // its Un-ignore cover it — once the root is open, git carries the link.
        let in_ignored_root = b.skill.is_some() && skills.ignored_roots.contains(&b.root);
        let mut sentence = match b.kind {
            BoundaryKind::Link => format!(
                "{} is a link to {}: git stores the link, not the files it points to",
                b.path,
                if b.target.is_empty() { "somewhere Plyloft can't read" } else { &b.target },
            ),
            BoundaryKind::Submodule => format!(
                "{} is a submodule: git stores which commit it is at, not its files, so card \
                 worktrees and teammates get {} only once the submodule is checked out there",
                b.path,
                if b.skill.is_some() { "the skill" } else { "the skills" },
            ),
            // GH #227 review 2: not a registered submodule — committing it
            // records a commit with no URL, which nothing can check out.
            BoundaryKind::NestedRepository => format!(
                "{} is a repository of its own that isn't a registered submodule (a nested \
                 clone or worktree): committing it would record only which commit it is at, \
                 with nowhere to fetch it from, so no card worktree or teammate could check it \
                 out. Add it with git submodule add, or keep {} in a plain directory",
                b.path,
                if b.skill.is_some() { "the skill" } else { "the skills" },
            ),
        };
        let mut unshipped = b.kind == BoundaryKind::NestedRepository;
        match (in_ignored_root, b.ignored) {
            (true, _) => sentence.push_str(&format!(
                "{}it sits in {}, which is gitignored — un-ignoring {} carries it too",
                if b.kind == BoundaryKind::NestedRepository { ". And " } else { ", and " },
                b.root,
                b.root
            )),
            (false, Some(false)) => {}
            (false, Some(true)) => {
                unshipped = true;
                sentence.push_str(", and git ignores it itself, so a card carries neither it nor what is behind it");
                if b.kind == BoundaryKind::Link {
                    sentence.push_str(&format!(
                        ". To carry the link, add !/{} (no trailing slash: git stores a link as a \
                         file) after the rule that ignores it{}",
                        b.path,
                        // GH #227 review 2: only for a whole root. For one
                        // skill's link the parent is the root, and
                        // `/<root>/*` would ignore every other skill in it.
                        match (b.skill.is_none(), b.path.rsplit_once('/')) {
                            (true, Some((parent, _))) => format!(
                                ", with !/{parent}/ and /{parent}/* before it if {parent}/ is \
                                 ignored as a whole"
                            ),
                            _ => String::new(),
                        },
                    ));
                }
            }
            (false, None) => {
                unanswered.push(b.path.clone());
                sentence.push_str(", and Plyloft couldn't ask git whether it is ignored, so the row doesn't say either way");
            }
        }
        if b.kind == BoundaryKind::Link && b.ignored != Some(true) {
            match &b.target_state {
                TargetState::Carried(_) | TargetState::Unknown => {}
                TargetState::Ignored(dir) => {
                    unshipped = true;
                    sentence.push_str(&format!(
                        "; git ignores its files in {dir}, so no card carries them — card \
                         worktrees and teammates get a link to nothing"
                    ));
                }
                TargetState::Outside => sentence.push_str(
                    "; it points outside the workspace, so card worktrees and teammates get \
                     the skill only where that path exists on their machine",
                ),
                TargetState::Missing => {
                    sentence.push_str(concat!("; it points at nothing on ", crate::this_machine!()))
                }
            }
        }
        if unshipped {
            ignored.push(b.path.clone());
        }
        sentence.push('.');
        sentences.push(sentence);
    }
    // Grouped by reason, so a reason is said once.
    let mut reasons: Vec<&str> = skills.unanswered.iter().map(|u| u.reason.as_str()).collect();
    reasons.dedup();
    reasons.sort_unstable();
    reasons.dedup();
    for reason in reasons {
        let paths: Vec<&str> = skills
            .unanswered
            .iter()
            .filter(|u| u.reason == reason)
            .map(|u| u.path.as_str())
            .collect();
        sentences.push(format!(
            "Plyloft couldn't ask git whether {} {} ignored — {reason} — so the row doesn't say \
             either way.",
            paths.join(" and "),
            if paths.len() == 1 { "is" } else { "are" },
        ));
        unanswered.extend(paths.iter().map(|p| p.to_string()));
    }
    LinkSentences {
        sentences,
        ignored,
        unanswered,
    }
}

/// The distinct reasons skill directories are not loaded, deduplicated, so the
/// row says *why* rather than only how many.
fn unloadable_reasons(skills: &crate::project_skills::ProjectSkills) -> String {
    let mut reasons: Vec<&str> = skills
        .unloadable
        .iter()
        .map(|skill| skill.reason.as_str())
        .collect();
    reasons.sort_unstable();
    reasons.dedup();
    reasons.join("; ")
}

/// The doctor's view of a team library. Pure, like the rest of the report.
///
/// `loaded` counts skills that reach **every** session Ply starts, which is
/// the only number a member can act on. A skill in one half of the library
/// does not, and neither does one whose vendor cannot be prepared on this
/// Mac — reporting the library's contents as if they were loaded is how a
/// member ends up believing their team's skills are working when Codex is
/// getting none of them.
fn team_skills_status(input: &TeamSkillsInput<'_>) -> TeamSkillsStatus {
    let library = input.library;
    let both = library.skills.iter().filter(|s| s.both_vendors()).count();
    let claude_only = library.skills.iter().filter(|s| s.claude && !s.codex).count();
    let codex_only = library.skills.iter().filter(|s| s.codex && !s.claude).count();
    let refused = library.refused.len();
    // A blocked vendor loads nothing, so nothing reaches every session.
    let blocked = input.codex_blocked.clone();
    let loaded = if blocked.is_some() { 0 } else { both };

    let mut detail = format!(
        "{loaded} team {} loaded into every Claude and Codex session Plyloft starts.",
        plural(loaded, "skill", "skills")
    );
    if let Some(reason) = &blocked {
        detail.push_str(&format!(
            " {} {} Claude sessions, but Codex sessions get none: {reason}.",
            both + claude_only,
            plural(both + claude_only, "skill reaches", "skills reach"),
        ));
    } else if claude_only > 0 || codex_only > 0 {
        // A one-sided skill is not an error, but it is the thing a member
        // would otherwise never notice: half the team gets it, half does not.
        detail.push_str(&format!(
            " {claude_only} Claude only, {codex_only} Codex only — publish those to both halves of the library."
        ));
    }
    if refused > 0 {
        detail.push_str(&format!(
            " {refused} {} not loaded: {}.",
            plural(refused, "plugin", "plugins"),
            refusal_reasons(library)
        ));
    }
    // Errors the library reader collected — a half that could not be read at
    // all. Logged at launch; said out loud here.
    for error in &library.errors {
        detail.push_str(&format!(" {error}."));
    }

    TeamSkillsStatus {
        loaded,
        claude_only,
        codex_only,
        refused,
        blocked,
        detail,
    }
}

/// The distinct reasons plugins were refused, so the row says *why* rather
/// than only how many.
fn refusal_reasons(library: &crate::team_skills::TeamSkillsLibrary) -> String {
    let mut reasons: Vec<&str> = library
        .refused
        .iter()
        .map(|plugin| plugin.reason.as_str())
        .collect();
    reasons.sort_unstable();
    reasons.dedup();
    reasons.join("; ")
}

fn plural(n: usize, one: &'static str, many: &'static str) -> &'static str {
    if n == 1 {
        one
    } else {
        many
    }
}

/// Resolve a required CLI's resolved path, or a friendly, specific error
/// string. Use this at shell-out sites instead of assuming the tool exists —
/// `SAAS_READINESS.md` principle #3. The error is safe to surface straight to
/// a non-technical user.
/// OB-14 (§13.3): the same "ready" as the report's `ai_ready` rows, for one
/// vendor — Claude found and starting (1.176.0 R3); Codex found, starting and not signed out (its
/// `auth.json`, file presence only — never `codex login status`). Used to pick
/// who runs an intake. `codex_signed_in` is the file check's answer.
pub fn vendor_ready_with(env: &ShellEnv, vendor: &str, codex_signed_in: Option<bool>) -> bool {
    match vendor {
        "codex" => env.codex_healthy() && codex_signed_in != Some(false),
        _ => env.claude_healthy(),
    }
}

/// [`vendor_ready_with`] reading Codex's sign-in file when it matters.
pub fn vendor_ready(env: &ShellEnv, vendor: &str) -> bool {
    let signed_in = if vendor == "codex" && env.codex_healthy() {
        let (store, file) = crate::doctor_reads::codex_auth();
        codex_auth_status(store, file).signed_in
    } else {
        None
    };
    vendor_ready_with(env, vendor, signed_in)
}

pub fn require(tool_id: &str) -> Result<String, String> {
    // 1.176.0 R3: Claude's and Codex's path is checked on disk first, and
    // looked for again once when it fails (`cli_fresh`; never on the UI
    // thread, where the look is left to the background).
    match crate::cli_fresh::Cli::from_id(tool_id) {
        Some(cli) => {
            let fresh = crate::cli_fresh::fresh_env(cli, shell_env::get(), crate::cli_fresh::REQUIRE);
            require_with(&fresh.env, tool_id, crate::cli_fresh::usable)
        }
        // 1.176.2 R1 (A1-02): gh's path is checked on disk too (the same
        // `usable`); its sentence then says Look again. No look of its own.
        None => require_with(&shell_env::get(), tool_id, crate::cli_fresh::usable),
    }
}

/// Pure core of [`require`], so the gate is testable without the global probe
/// cache. Split out in the 2026-08-30 codex fix.
#[cfg(test)]
fn require_in(env: &ShellEnv, tool_id: &str) -> Result<String, String> {
    require_with(env, tool_id, |_| true)
}

/// [`require_in`] with the disk check (`usable`) for Claude's, Codex's and
/// gh's path: one that isn't there reads as not installed, not as a path to run.
pub(crate) fn require_with(env: &ShellEnv, tool_id: &str, usable: impl Fn(&str) -> bool) -> Result<String, String> {
    let (path, name, docs) = match tool_id {
        "claude" => (env.claude_path.clone(), "Claude Code", CLAUDE_DOCS),
        "git" => (env.git_path.clone(), "Git", GIT_DOCS),
        "codex" => (env.codex_path.clone(), "Codex CLI", CODEX_DOCS),
        "gh" => (env.gh_path.clone(), "GitHub CLI", GH_DOCS),
        other => return Err(format!("Unknown tool '{other}' requested.")),
    };
    let on_disk = matches!(tool_id, "claude" | "codex" | "gh").then_some(&usable);
    let path = path.filter(|p| on_disk.map_or(true, |usable| usable(p))).ok_or_else(|| {
        format!(
            "{name} isn't installed, or isn't on Plyloft's PATH. Install it ({docs}), \
             then open Settings › Setup and account › Diagnostics and press Look again."
        )
    })?;
    // OB-2 review (P3-1): a git that doesn't work is never handed out — on a
    // Mac without the Command Line Tools the resolved `/usr/bin/git` is
    // Apple's shim, and running it opens the install dialog unasked.
    if tool_id == "git" && !env.git_works() {
        return Err(if env.clt_installed == Some(false) {
            "Git isn't installed: it comes with Apple's Command Line Tools. \
             Install them from Settings › Setup and account › Diagnostics, then Look again."
                .to_string()
        } else {
            format!(
                "Git is at {path} but doesn't start. Reinstall it ({docs}), then open \
                 Settings › Setup and account › Diagnostics and Look again."
            )
        });
    }
    // Resolved is not the same as working: a half-finished npm install leaves
    // the codex wrapper on PATH but crashes on every run, and an agent started
    // against it dies on spawn with a Node stack trace.
    // R3: the same for Claude — never `claude update`, which runs the binary
    // that doesn't start.
    let starts = match tool_id {
        "codex" => env.codex_healthy(),
        "claude" => env.claude_healthy(),
        _ => true,
    };
    if !starts {
        let sentence = format!(
            "{name} is installed at {path} but doesn't start — its install is incomplete. \
             Repair it in Settings › Setup and account › Diagnostics › Repair, or reinstall it yourself ({}) \
             and press Look again there.",
            install_cmd_for(tool_id, cfg!(windows))
        );
        // 1.176.0 R7: typed, so every surface offers Repair (`cliNotStarting.ts`).
        return Err(match crate::cli_fresh::Cli::from_id(tool_id) {
            Some(cli) => crate::cli_fresh::not_starting(cli, &sentence),
            None => sentence,
        });
    }
    Ok(path)
}

/// Unit tests do not initialize the GUI shell cache. Let portability-focused
/// tests prefer the same doctor-owned resolution without installing global
/// test state; callers may supply a host fallback.
#[cfg(test)]
pub fn resolved_path_if_initialized(tool_id: &str) -> Option<String> {
    let env = shell_env::try_get()?;
    match tool_id {
        "claude" => env.claude_path.clone(),
        "git" => env.git_path.clone(),
        "codex" => env.codex_path.clone(),
        "gh" => env.gh_path.clone(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain_lock::KeychainLock;

    #[test]
    fn microphone_row_says_how_to_dictate_in_every_state() {
        use crate::microphone::MicrophoneAccess;
        for access in [
            MicrophoneAccess::NotAsked,
            MicrophoneAccess::Granted,
            MicrophoneAccess::Denied,
        ] {
            let row = microphone_status(access);
            assert_eq!(row.access, access);
            assert!(row.detail.ends_with(VOICE_HINT), "{}", row.detail);
        }
    }

    #[test]
    fn only_a_denied_microphone_links_to_system_settings() {
        use crate::microphone::MicrophoneAccess;
        assert_eq!(microphone_status(MicrophoneAccess::NotAsked).settings_url, None);
        assert_eq!(microphone_status(MicrophoneAccess::Granted).settings_url, None);
        let denied = microphone_status(MicrophoneAccess::Denied);
        assert_eq!(
            denied.settings_url.as_deref(),
            Some(crate::microphone::SETTINGS_URL)
        );
        // Windows writes the page `Privacy & security`.
        assert!(denied.detail.to_lowercase().contains("privacy & security → microphone"));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_shell_is_known_without_its_exe() {
        let zsh = dictation_shell_status(r"C:\msys64\usr\bin\zsh.exe", true, None);
        assert!(zsh.ok, "{}", zsh.detail);
        assert_eq!(zsh.label, "zsh");
    }

    #[test]
    fn build_report_leaves_the_microphone_to_the_command() {
        let report = build_report(&env(Some("/c"), Some("1.5.0"), Some("/git")), None, None, None);
        assert!(report.microphone.is_none());
        let json = serde_json::to_value(microphone_status(
            crate::microphone::MicrophoneAccess::NotAsked,
        ))
        .unwrap();
        assert_eq!(json["access"], "not-asked");
        assert!(json["settingsUrl"].is_null());
    }

    /// The Mac's words, or Windows' where the two differ.
    fn mac_or_windows(mac: &'static str, windows: &'static str) -> &'static str {
        if cfg!(windows) {
            windows
        } else {
            mac
        }
    }

    #[test]
    fn every_tool_has_its_install_command_on_each_platform() {
        let table = [
            ("git", "xcode-select --install", Some(WINGET_GIT)),
            ("claude", "curl -fsSL https://claude.ai/install.sh | bash", Some("irm https://claude.ai/install.ps1 | iex")),
            ("codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh", Some(CODEX_WINDOWS_INSTALL)),
            ("gh", "brew install gh", Some(WINGET_GH)),
            ("gh-zip", GH_ZIP_INSTALL, None),
            ("rg", "brew install ripgrep", Some("winget install --id BurntSushi.ripgrep.MSVC")),
            ("node", "brew install node", Some(WINGET_NODE)),
            ("whisper-cli", "brew install whisper.cpp", None),
            ("bash", "brew install bash", None),
        ];
        for (tool, mac, windows) in table {
            assert_eq!(install_cmd_on(tool, false), Some(mac), "{tool}");
            assert_eq!(install_cmd_on(tool, true), windows, "{tool}");
            // No brew, curl or a POSIX pipe reaches a Windows row.
            if let Some(cmd) = windows {
                assert!(!cmd.contains("brew") && !cmd.contains("curl"), "{cmd}");
            }
        }
        assert_eq!(install_cmd_on("nothing", false), None);
        assert_eq!(install_cmd("gh"), install_cmd_on("gh", cfg!(windows)));
    }

    #[cfg(windows)]
    #[test]
    fn windows_rows_offer_windows_commands() {
        let r = build_report_for_test(&env(None, None, None), None);
        assert_eq!(tool(&r, "git").install_cmd, WINGET_GIT);
        assert_eq!(tool(&r, "claude").install_cmd, "irm https://claude.ai/install.ps1 | iex");
        assert_eq!(tool(&r, "codex").install_cmd, CODEX_WINDOWS_INSTALL);
        assert_eq!(tool(&r, "gh").install_cmd, WINGET_GH);
        for t in &r.tools {
            assert!(!t.install_cmd.contains("brew") && !t.detail.contains("Mac"), "{t:?}");
        }
        let whisper = whisper_tool_status(None);
        assert_eq!(whisper.install_cmd, "");
        assert!(whisper.detail.contains("isn't available on Windows yet"), "{}", whisper.detail);
        assert!(whisper_tool_status(Some(r"C:\w\whisper-cli.exe".into())).detail.contains("this PC"));
        let bash = dictation_shell_status(r"C:\Program Files\Git\bin\bash.exe", true, None);
        assert!(bash.detail.contains("PowerShell 7") && !bash.detail.contains("brew"), "{}", bash.detail);
        assert!(!crate::dictation::whisper_missing_message().contains("brew"));
    }

    #[cfg(not(windows))]
    #[test]
    fn whisper_row_is_optional_and_names_the_brew_formula() {
        let missing = whisper_tool_status(None);
        assert_eq!(missing.id, "whisper-cli");
        assert!(!missing.required && !missing.found && !missing.version_ok);
        assert_eq!(missing.install_cmd, "brew install whisper.cpp");
        assert!(missing.detail.contains("hold Space"), "{}", missing.detail);
        let found = whisper_tool_status(Some("/opt/homebrew/bin/whisper-cli".into()));
        assert!(found.found && found.version_ok);
        assert_eq!(found.path.as_deref(), Some("/opt/homebrew/bin/whisper-cli"));
        // An optional row never blocks: the report's required check ignores it.
        let mut report = build_report(&env(Some("/c"), Some("1.5.0"), Some("/git")), None, None, None);
        report.tools.push(missing);
        assert!(report.tools.iter().filter(|t| t.required).all(|t| t.found));
    }

    #[test]
    fn whisper_model_row_points_a_missing_model_at_settings() {
        use crate::dictation::DictationModel;
        let path = std::path::Path::new("/x/whisper/models/ggml-small.bin");
        let missing = whisper_model_status(DictationModel::Small, path, false);
        assert!(!missing.present);
        assert!(missing.detail.contains("Settings › Look and feel › Dictation › The model file"), "{}", missing.detail);
        assert!(missing.detail.contains("466 MB"), "{}", missing.detail);
        let ready = whisper_model_status(DictationModel::Base, path, true);
        assert!(ready.detail.contains("base"));
        let json = serde_json::to_value(&ready).unwrap();
        assert_eq!(json["model"], "base");
        assert_eq!(json["present"], true);
        assert!(build_report(&env(None, None, None), None, None, None).whisper_model.is_none());
    }

    const MACOS_BASH: &str = "GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)\nCopyright (C) 2007 Free Software Foundation, Inc.";

    #[cfg(not(windows))]
    #[test]
    fn macos_bash_3_2_gets_the_no_bracketed_paste_advice() {
        let row = dictation_shell_status("/bin/bash", true, Some(MACOS_BASH));
        assert!(row.found && !row.ok);
        assert_eq!(row.label, "bash 3.2.57");
        assert_eq!(
            row.detail,
            "Dictation can't type into macOS /bin/bash 3.2: switch the tile shell to zsh in Settings › Look and feel › Editor and terminals, or install bash 5 (brew install bash)."
        );
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["shell"], "/bin/bash");
        assert_eq!(json["ok"], false);
        // /bin/sh on macOS is the same bash 3.2.
        assert!(!dictation_shell_status("/bin/sh", true, Some(MACOS_BASH)).ok);
    }

    #[test]
    fn zsh_and_fish_dictate_without_running_anything() {
        let zsh = dictation_shell_status("/bin/zsh", true, None);
        assert!(zsh.found && zsh.ok, "{}", zsh.detail);
        assert_eq!(zsh.label, "zsh");
        assert!(zsh.detail.contains("hold Space"), "{}", zsh.detail);
        // G2 walk (DS7): the row says it in plain words.
        assert!(!zsh.detail.contains("bracketed"), "{}", zsh.detail);
        assert!(dictation_shell_status("/opt/homebrew/bin/fish", true, None).ok);
    }

    #[test]
    fn bash_is_ok_from_5_1_and_4_4_to_5_0_is_told_about_inputrc() {
        let v = |s: &str| format!("GNU bash, version {s}(1)-release (aarch64-apple-darwin24.0.0)");
        let bash52 = dictation_shell_status("/opt/homebrew/bin/bash", true, Some(&v("5.2.37")));
        assert!(bash52.ok, "{}", bash52.detail);
        assert_eq!(bash52.label, "bash 5.2.37");
        assert!(dictation_shell_status("/usr/local/bin/bash", true, Some(&v("5.1.0"))).ok);
        let bash50 = dictation_shell_status("/usr/local/bin/bash", true, Some(&v("5.0.18")));
        assert!(!bash50.ok);
        assert!(bash50.detail.contains("enable-bracketed-paste"), "{}", bash50.detail);
        let bash40 = dictation_shell_status("/usr/local/bin/bash", true, Some(&v("4.0.1")));
        assert!(!bash40.ok);
        assert!(bash40.detail.starts_with("Dictation can't type into /usr/local/bin/bash 4.0:"), "{}", bash40.detail);
    }

    #[test]
    fn an_unknown_or_missing_tile_shell_is_never_reported_as_dictating() {
        let unread = dictation_shell_status("/bin/bash", true, None);
        assert!(unread.found && !unread.ok);
        assert!(
            unread.detail.contains(mac_or_windows("brew install bash", "PowerShell 7")),
            "{}",
            unread.detail
        );
        let nu = dictation_shell_status("/opt/homebrew/bin/nu", true, None);
        assert!(!nu.ok);
        assert!(nu.detail.contains("can't tell whether dictation can type into nu"), "{}", nu.detail);
        let gone = dictation_shell_status("/opt/homebrew/bin/zsh", false, None);
        assert!(!gone.found && !gone.ok);
        assert!(gone.detail.contains("can't start"), "{}", gone.detail);
        assert!(build_report(&env(None, None, None), None, None, None).dictation_shell.is_none());
    }

    /// The pre-v1.116.0 two-argument shape: these cases are about tools, not
    /// about a team, so they assert against a machine that is on none.
    fn build_report_for_test(
        env: &ShellEnv,
        capabilities: Option<&ReviewerCapabilityRegistry>,
    ) -> DoctorReport {
        build_report(env, capabilities, None, None)
    }

    fn row(
        library: &crate::team_skills::TeamSkillsLibrary,
        codex_blocked: Option<&str>,
    ) -> TeamSkillsStatus {
        build_report(
            &env(Some("/c"), Some("1.5.0"), Some("/git")),
            None,
            Some(TeamSkillsInput {
                library,
                codex_blocked: codex_blocked.map(str::to_string),
            }),
            None,
        )
        .team_skills
        .expect("a team-skills row")
    }

    fn env(claude: Option<&str>, claude_v: Option<&str>, git: Option<&str>) -> ShellEnv {
        ShellEnv {
            path: String::new(),
            shell: String::new(),
            claude_path: claude.map(String::from),
            claude_version: claude_v.map(String::from),
            codex_path: None,
            codex_version: None,
            git_path: git.map(String::from),
            // A git given here works: it answered `--version`.
            git_version: git.map(|_| "2.50.1".to_string()),
            gh_path: None,
            gh_version: None,
            probe_error: None,
            ..ShellEnv::default()
        }
    }

    fn tool<'a>(r: &'a DoctorReport, id: &str) -> &'a ToolStatus {
        r.tools.iter().find(|t| t.id == id).expect("tool present")
    }

    #[test]
    fn report_lists_four_tools_with_correct_required_flags() {
        let r = build_report_for_test(&env(Some("/c"), Some("1.5.0"), Some("/git")), None);
        let ids: Vec<&str> = r.tools.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, mac_or_windows_ids());
        assert!(tool(&r, "git").required);
        // §13.1: one AI is enough — neither is required on its own.
        assert!(!tool(&r, "claude").required);
        assert!(!tool(&r, "codex").required);
        assert!(!tool(&r, "gh").required);
    }

    fn mac_or_windows_ids() -> Vec<&'static str> {
        if cfg!(windows) {
            vec!["git", "git-bash", "claude", "codex", "gh"]
        } else {
            vec!["git", "claude", "codex", "gh"]
        }
    }

    /// The facts of a Mac read, or of a Windows one.
    fn facts(windows: bool) -> DoctorFacts {
        DoctorFacts { windows, ..DoctorFacts::default() }
    }

    fn report_on(e: &ShellEnv, f: &DoctorFacts) -> DoctorReport {
        build_report_with(e, None, None, None, f)
    }

    fn with_codex(mut e: ShellEnv) -> ShellEnv {
        e.codex_path = Some("/x/codex".into());
        e.codex_version = Some("0.156.1".into());
        e
    }

    fn signed_in_codex() -> Option<ToolAuth> {
        Some(codex_auth_status(CodexStore::File, CredentialSeen::Present))
    }

    #[test]
    fn all_required_ok_needs_git_and_one_ai() {
        let mac = facts(false);
        // Claude only.
        let claude_only = report_on(&env(Some("/c"), Some("1.5.0"), Some("/git")), &mac);
        assert!(claude_only.ai_ready && claude_only.all_required_ok);
        // Codex only, signed in.
        let codex_only = report_on(
            &with_codex(env(None, None, Some("/git"))),
            &DoctorFacts { codex_auth: signed_in_codex(), ..facts(false) },
        );
        assert!(codex_only.ai_ready && codex_only.all_required_ok, "Codex alone is enough");
        // Both.
        let both = report_on(&with_codex(env(Some("/c"), Some("1.5.0"), Some("/git"))), &mac);
        assert!(both.ai_ready && both.all_required_ok);
        // Neither.
        let neither = report_on(&env(None, None, Some("/git")), &mac);
        assert!(!neither.ai_ready && !neither.all_required_ok);
        // git missing → not ok, whatever the AIs.
        let no_git = report_on(&env(Some("/c"), Some("1.5.0"), None), &mac);
        assert!(no_git.ai_ready && !no_git.all_required_ok);
    }

    #[test]
    fn a_codex_that_is_signed_out_or_not_starting_is_not_an_ai_ready() {
        let signed_out = DoctorFacts {
            codex_auth: Some(codex_auth_status(CodexStore::File, CredentialSeen::Absent)),
            ..facts(false)
        };
        let r = report_on(&with_codex(env(None, None, Some("/git"))), &signed_out);
        assert!(!r.ai_ready && !r.all_required_ok);
        assert_eq!(tool(&r, "claude").detail, CLAUDE_MISSING_DETAIL);
        let codex = tool(&r, "codex");
        assert_eq!(codex.auth.as_ref().unwrap().signed_in, Some(false));
        assert_eq!(codex.auth.as_ref().unwrap().detail, "Not signed in.");
        assert_eq!(codex.auth.as_ref().unwrap().command, "codex login");
        // A keychain login Ply cannot see is neutral, and counts.
        let unseen = DoctorFacts {
            codex_auth: Some(codex_auth_status(CodexStore::Keyring, CredentialSeen::Absent)),
            ..facts(false)
        };
        assert!(report_on(&with_codex(env(None, None, Some("/git"))), &unseen).ai_ready);
        // Not starting: not ready.
        let mut dead = with_codex(env(None, None, Some("/git")));
        dead.codex_version = None;
        assert!(!report_on(&dead, &facts(false)).ai_ready);
    }

    #[test]
    fn each_ai_row_says_the_other_one_is_enough() {
        let mac = facts(false);
        let neither = report_on(&env(None, None, Some("/git")), &mac);
        assert_eq!(tool(&neither, "claude").detail, "Not installed. One AI is enough: install Claude Code or Codex.");
        assert_eq!(tool(&neither, "codex").detail, "Not installed. One AI is enough: install Codex or Claude Code.");
        let claude_only = report_on(&env(Some("/c"), Some("1.5.0"), Some("/git")), &mac);
        assert_eq!(tool(&claude_only, "codex").detail, "Not installed. Optional — Claude Code is ready.");
        assert_eq!(tool(&claude_only, "claude").detail, CLAUDE_READY_DETAIL);
        let codex_only = report_on(
            &with_codex(env(None, None, Some("/git"))),
            &DoctorFacts { codex_auth: signed_in_codex(), ..facts(false) },
        );
        assert_eq!(tool(&codex_only, "claude").detail, "Not installed. Optional — Codex is ready.");
        assert_eq!(tool(&codex_only, "codex").detail, "Runs your Codex agents.");
        assert_eq!(tool(&codex_only, "codex").auth.as_ref().unwrap().detail, "Found and signed in.");
        // Windows: the official installer needs no Node, so no Node sentence.
        let win = report_on(&env(Some("/c"), Some("1.5.0"), Some("/git")), &facts(true));
        assert_eq!(tool(&win, "codex").detail, "Not installed. Optional — Claude Code is ready.");
        assert_eq!(tool(&win, "codex").install_cmd, CODEX_WINDOWS_INSTALL);
    }

    #[test]
    fn a_mac_without_the_clt_has_no_working_git_and_says_why() {
        // The probe never ran the shim: resolved, no version.
        let mut e = env(Some("/c"), Some("1.5.0"), None);
        e.git_path = Some("/usr/bin/git".into());
        e.clt_installed = Some(false);
        let r = report_on(&e, &DoctorFacts { identity: Some((Some("A".into()), None)), ..facts(false) });
        let git = tool(&r, "git");
        assert!(!git.found && !git.version_ok);
        assert_eq!(git.detail, "Not installed. Git comes with Apple's Command Line Tools.");
        assert_eq!(git.install_cmd, "xcode-select --install");
        assert!(!r.all_required_ok);
        // No identity row while git doesn't work.
        assert!(r.git_identity.is_none());
    }

    #[test]
    fn a_homebrew_git_without_the_clt_works() {
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/opt/homebrew/bin/git"));
        e.clt_installed = Some(false);
        let r = report_on(&e, &facts(false));
        assert!(tool(&r, "git").found);
        assert_eq!(tool(&r, "git").detail, GIT_READY_DETAIL);
        assert!(r.all_required_ok);
    }

    #[test]
    fn a_git_that_does_not_start_is_not_working() {
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/weird/git"));
        e.git_version = None;
        let r = report_on(&e, &facts(false));
        assert!(!tool(&r, "git").found);
        assert_eq!(tool(&r, "git").detail, GIT_NOT_STARTING_DETAIL);
        assert!(!r.all_required_ok);
        // OB-6 review P3-6: on Windows its reinstall is forced.
        let w = report_on(&e, &facts(true));
        assert_eq!(tool(&w, "git").install_cmd, WINGET_GIT_FORCE);
        let mut missing = e.clone();
        missing.git_path = None;
        assert_eq!(tool(&report_on(&missing, &facts(true)), "git").install_cmd, WINGET_GIT);
    }

    #[test]
    fn windows_needs_git_bash_and_shows_node_only_for_an_npm_codex() {
        let win = facts(true);
        let mut e = env(Some("/c"), Some("1.5.0"), Some(r"C:\Git\cmd\git.exe"));
        // Without Git Bash: not ok, and the row says what is missing.
        let r = report_on(&e, &win);
        let bash = tool(&r, "git-bash");
        assert!(bash.required && !bash.found);
        assert_eq!(
            bash.detail,
            "Git works, but Git Bash wasn't found. Plyloft needs it to run project checks; Git for Windows includes it."
        );
        // P3-5: winget may already list Git.Git (MinGit, Scoop): forced.
        assert_eq!(bash.install_cmd, WINGET_GIT_FORCE);
        assert!(WINGET_GIT_FORCE.contains("--force"));
        assert!(!r.all_required_ok);
        // With it.
        e.git_bash_path = Some(r"C:\Git\bin\bash.exe".into());
        let r = report_on(&e, &win);
        assert!(tool(&r, "git-bash").found);
        assert_eq!(tool(&r, "git-bash").detail, GIT_BASH_READY_DETAIL);
        assert!(r.all_required_ok);
        // No Node row without Codex.
        assert!(r.tools.iter().all(|t| t.id != "node"));
        // The official installer's native codex.exe: no Node row.
        let native = DoctorFacts {
            codex_real_path: Some(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe".into()),
            ..facts(true)
        };
        let r = report_on(&with_codex(e.clone()), &native);
        assert!(r.tools.iter().all(|t| t.id != "node"));
        assert_eq!(tool(&r, "codex").install_cmd, CODEX_WINDOWS_INSTALL);
        // An npm Codex: the Node row, missing.
        let npm = DoctorFacts {
            codex_real_path: Some(r"C:\Users\u\AppData\Roaming\npm\codex.cmd".into()),
            ..facts(true)
        };
        let r = report_on(&with_codex(e.clone()), &npm);
        let node = tool(&r, "node");
        assert!(!node.required && !node.found);
        assert_eq!(node.detail, NODE_MISSING_DETAIL);
        assert_eq!(node.install_cmd, WINGET_NODE);
        assert!(node.install_cmd.contains("--scope user"));
        // …and found.
        let mut with_node = with_codex(e.clone());
        with_node.node_path = Some(r"C:\nodejs\node.exe".into());
        with_node.node_version = Some("24.19.0".into());
        let r = report_on(&with_node, &npm);
        assert!(tool(&r, "node").found);
        assert_eq!(tool(&r, "node").detail, NODE_READY_DETAIL);
        // Neither git nor Git Bash: plain Git for Windows.
        let r = report_on(&env(Some("/c"), Some("1.5.0"), None), &win);
        assert_eq!(tool(&r, "git-bash").detail, GIT_BASH_NO_GIT_DETAIL);
        assert_eq!(tool(&r, "git-bash").install_cmd, WINGET_GIT);
        // A Mac has neither row.
        let mac = report_on(&with_codex(env(Some("/c"), Some("1.5.0"), Some("/git"))), &facts(false));
        assert!(mac.tools.iter().all(|t| t.id != "node" && t.id != "git-bash"));
    }

    #[test]
    fn windows_rows_offer_the_measured_winget_commands() {
        let r = report_on(&env(None, None, None), &facts(true));
        assert_eq!(tool(&r, "git").install_cmd, WINGET_GIT);
        assert_eq!(tool(&r, "gh").install_cmd, WINGET_GH);
        assert!(WINGET_GH.contains("--scope user") && WINGET_NODE.contains("--scope user"));
        for cmd in [WINGET_GIT, WINGET_GH, WINGET_NODE, WINGET_GH_UPGRADE] {
            assert!(cmd.contains("--accept-source-agreements") && cmd.contains("--source winget"), "{cmd}");
        }
        for t in &r.tools {
            assert!(!t.install_cmd.contains("brew") && !t.install_cmd.contains("curl"), "{t:?}");
        }
    }

    #[test]
    fn gh_on_a_mac_without_homebrew_installs_from_the_release_zip() {
        let without = report_on(&env(None, None, Some("/git")), &facts(false));
        assert_eq!(tool(&without, "gh").install_cmd, GH_ZIP_INSTALL);
        for part in ["gh_${v}_macOS_arm64", "gh_${v}_checksums.txt", "shasum -a 256 -c", "~/.local/bin/gh", "releases/latest"] {
            assert!(GH_ZIP_INSTALL.contains(part), "{part}");
        }
        assert!(!GH_ZIP_INSTALL.contains("brew") && !GH_ZIP_INSTALL.contains("sudo"));
        let with = report_on(&env(None, None, Some("/git")), &DoctorFacts { brew: true, ..facts(false) });
        assert_eq!(tool(&with, "gh").install_cmd, "brew install gh");
        assert_eq!(install_cmd_on("gh-zip", false), Some(GH_ZIP_INSTALL));
        assert_eq!(install_cmd_on("gh-zip", true), None);
    }

    #[test]
    fn the_git_identity_row_reads_both_values() {
        let git = env(Some("/c"), Some("1.5.0"), Some("/git"));
        let set = report_on(
            &git,
            &DoctorFacts { identity: Some((Some("Matteo Braghetta".into()), Some("m@example.com".into()))), ..facts(false) },
        );
        let id = set.git_identity.expect("a row");
        assert!(id.set);
        assert_eq!(id.detail, "Git knows you as Matteo Braghetta <m@example.com>.");
        let unset = report_on(&git, &DoctorFacts { identity: Some((None, None)), ..facts(false) });
        let id = unset.git_identity.expect("a row");
        assert!(!id.set);
        assert_eq!(id.detail, "Git doesn't know your name yet.");
        assert_eq!(git_identity_status(Some("A"), Some("  ")).detail, "Git doesn't know your email yet.");
        assert_eq!(git_identity_status(Some(" "), Some("a@b")).detail, "Git doesn't know your name yet.");
        // Not read → no row; identity is never part of allRequiredOk.
        let unread = report_on(&git, &facts(false));
        assert!(unread.git_identity.is_none());
        assert!(unset.all_required_ok);
    }

    #[test]
    fn a_newer_release_offers_update_and_offline_says_nothing() {
        let mut e = with_codex(env(Some("/c"), Some("2.1.283"), Some("/git")));
        e.gh_path = Some("/opt/homebrew/bin/gh".into());
        e.gh_version = Some("2.100.0".into());
        let online = DoctorFacts {
            latest: LatestVersions {
                claude: Some("2.1.290".into()),
                codex: Some("0.157.1".into()),
                gh: Some("2.101.0".into()),
            },
            codex_real_path: Some("/Users/u/.codex/packages/standalone/bin/codex".into()),
            gh_real_path: Some("/opt/homebrew/Cellar/gh/2.100.0/bin/gh".into()),
            ..facts(false)
        };
        let r = report_on(&e, &online);
        let claude = tool(&r, "claude").update.clone().expect("claude update");
        assert_eq!(claude.detail, "Version 2.1.290 is available.");
        assert_eq!(claude.command, "claude update");
        assert_eq!(tool(&r, "codex").update.as_ref().unwrap().command, "codex update");
        assert_eq!(tool(&r, "gh").update.as_ref().unwrap().command, "brew upgrade gh");
        // An update is never a block.
        assert!(r.all_required_ok);
        // Offline (nothing read): no update line anywhere.
        let offline = report_on(&e, &facts(false));
        assert!(offline.tools.iter().all(|t| t.update.is_none()));
        // Up to date, or newer than the feed: nothing.
        assert_eq!(update_line(Some("2.1.290"), Some("2.1.290"), "x"), None);
        assert_eq!(update_line(Some("2.1.291"), Some("2.1.290"), "x"), None);
        assert_eq!(update_line(None, Some("2.1.290"), "x"), None);
        assert_eq!(update_line(Some("2.1.283"), Some("garbage"), "x"), None);
        // A missing tool gets Install, not Update.
        let missing = report_on(&env(None, None, Some("/git")), &online);
        assert!(tool(&missing, "claude").update.is_none());
    }

    #[test]
    fn a_gh_ply_did_not_install_gets_no_update_line_and_updates_attach_late() {
        let mut e = env(Some("/c"), Some("2.1.283"), Some("/git"));
        e.gh_path = Some("/usr/local/bin/gh".into());
        e.gh_version = Some("2.100.0".into());
        let mut f = DoctorFacts {
            gh_real_path: Some("/usr/local/bin/gh".into()),
            latest: LatestVersions { gh: Some("2.101.0".into()), ..LatestVersions::default() },
            ..facts(false)
        };
        assert!(tool(&report_on(&e, &f), "gh").update.is_none(), "the .pkg gh: no zip over it");
        // P3-2: built without the releases, attached once they are read.
        f.gh_real_path = Some("/Users/u/.local/bin/gh".into());
        let mut late = report_on(&e, &DoctorFacts { latest: LatestVersions::default(), ..f.clone() });
        assert!(tool(&late, "gh").update.is_none());
        f.latest.claude = Some("2.1.290".into());
        apply_latest(&mut late, &e, &f);
        assert_eq!(tool(&late, "gh").update.as_ref().unwrap().command, GH_ZIP_INSTALL);
        assert_eq!(tool(&late, "claude").update.as_ref().unwrap().latest, "2.1.290");
        assert!(tool(&late, "git").update.is_none());
    }

    #[test]
    fn require_git_never_hands_out_a_git_that_does_not_work() {
        // P3-1: the CLT shim, resolved and never run.
        let mut e = env(Some("/c"), Some("1.5.0"), None);
        e.git_path = Some("/usr/bin/git".into());
        e.clt_installed = Some(false);
        let err = require_in(&e, "git").expect_err("the shim is refused");
        assert!(err.contains("Command Line Tools"), "{err}");
        // A git that doesn't start, elsewhere.
        e.clt_installed = None;
        e.git_path = Some("/x/git".into());
        assert!(require_in(&e, "git").expect_err("dead").contains("doesn't start"));
        // A working one (Homebrew's, no CLT) is handed out.
        let mut brew = env(Some("/c"), Some("1.5.0"), Some("/opt/homebrew/bin/git"));
        brew.clt_installed = Some(false);
        assert_eq!(require_in(&brew, "git").as_deref(), Ok("/opt/homebrew/bin/git"));
    }

    #[test]
    fn each_update_goes_through_the_tools_own_installer() {
        assert_eq!(codex_update_cmd(Some("/Users/u/.codex/packages/standalone/codex"), false), Some("codex update"));
        assert_eq!(codex_update_cmd(Some("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"), false), Some("npm install -g @openai/codex@latest"));
        assert_eq!(codex_update_cmd(Some("/opt/homebrew/Caskroom/codex/0.1/codex"), false), Some("brew upgrade codex"));
        // P3-4: Windows — install.ps1 only over its own install, npm over npm's,
        // nothing for Scoop, winget or an unknown place.
        assert_eq!(
            codex_update_cmd(Some(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe"), true),
            Some(CODEX_WINDOWS_INSTALL)
        );
        assert_eq!(codex_update_cmd(Some(r"C:\Users\u\AppData\Roaming\npm\codex.cmd"), true), Some("npm install -g @openai/codex@latest"));
        assert_eq!(codex_update_cmd(Some(r"C:\Users\u\scoop\apps\codex\current\codex.exe"), true), None);
        assert_eq!(codex_update_cmd(Some(r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links\codex.exe"), true), None);
        assert_eq!(codex_update_cmd(None, true), None);
        assert!(!codex_is_npm(Some("/Users/u/.codex/packages/standalone/codex")));
        assert_eq!(gh_update_cmd(Some("/opt/homebrew/Cellar/gh/2.1/bin/gh"), false), Some("brew upgrade gh"));
        assert_eq!(gh_update_cmd(Some("/Users/u/.local/bin/gh"), false), Some(GH_ZIP_INSTALL));
        assert_eq!(gh_update_cmd(None, true), Some(WINGET_GH_UPGRADE));
        // P3-3: a gh Ply didn't install (the .pkg, MacPorts): no Update step.
        assert_eq!(gh_update_cmd(Some("/usr/local/bin/gh"), false), None);
        assert_eq!(gh_update_cmd(Some("/opt/local/bin/gh"), false), None);
        assert_eq!(gh_update_cmd(None, false), None);
    }

    #[test]
    fn codex_sign_in_is_read_from_its_files_only() {
        use CredentialSeen::*;
        let present = codex_auth_status(CodexStore::File, Present);
        assert_eq!((present.signed_in, present.detail.as_str()), (Some(true), "Found and signed in."));
        assert_eq!(codex_auth_status(CodexStore::Keyring, Present).signed_in, Some(true));
        let absent = codex_auth_status(CodexStore::File, Absent);
        assert_eq!((absent.signed_in, absent.detail.as_str()), (Some(false), "Not signed in."));
        assert_eq!((absent.action.as_str(), absent.command.as_str()), ("Sign in", "codex login"));
        // Keyring/auto, an unreadable config or file: Ply can't tell — neutral.
        for (store, file) in [(CodexStore::Keyring, Absent), (CodexStore::Unreadable, Absent), (CodexStore::File, Unreadable)] {
            let auth = codex_auth_status(store, file);
            assert_eq!(auth.signed_in, None, "{store:?} {file:?}");
            assert!(auth.optional_step);
            assert_eq!(auth.detail, CODEX_UNSEEN_DETAIL);
        }
    }

    #[test]
    fn diagnostics_never_runs_claude_or_codex_status() {
        // D2/D4: `claude auth status` and `codex login status` run only in
        // Setup's AI step (OB-5). No sign-in step the doctor offers runs
        // them, whatever the answer…
        use CredentialSeen::*;
        let mut auths = Vec::new();
        for a in [Present, Absent, Unreadable] {
            for b in [Present, Absent, Unreadable] {
                auths.push(claude_auth_status(a, b));
            }
            for store in [CodexStore::File, CodexStore::Keyring, CodexStore::Unreadable] {
                auths.push(codex_auth_status(store, a));
            }
        }
        for auth in &auths {
            assert!(!auth.command.contains("auth status") && !auth.command.contains("login status"), "{auth:?}");
        }
        // …and neither the doctor's read nor its reads around the probe spawn
        // them: the command's body and this module name no status command.
        let commands = include_str!("commands.rs");
        let start = commands.find("fn dependency_doctor_blocking(").expect("the doctor command");
        let body = &commands[start..start + commands[start..].find("\n}\n").expect("its end")];
        let code = |text: &str| -> String {
            text.lines()
                .take_while(|line| !line.starts_with("#[cfg(test)]"))
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        for text in [code(body), code(include_str!("doctor.rs")), code(include_str!("doctor_reads.rs"))] {
            for forbidden in ["\"auth\", \"status\"", "\"login\", \"status\"", "claude auth status", "codex login status"] {
                assert!(!text.contains(forbidden), "the doctor must not run {forbidden}");
            }
        }
    }

    // ── GH #103: `gh` signed in, signed out, or Ply could not tell ──────

    #[test]
    fn gh_signed_in_has_nothing_to_do() {
        let auth = gh_auth_status(true, "github.com\n  ✓ Logged in to github.com as MatteoB-adv", KeychainLock::Unknown);
        assert_eq!(auth.signed_in, Some(true));
        assert_eq!(auth.action, "Check");
        assert!(auth.detail.contains("signed in"));
    }

    #[test]
    fn gh_signed_out_offers_sign_in_with_the_boards_sentence() {
        let auth = gh_auth_status(
            false,
            "You are not logged into any GitHub hosts. To log in, run: gh auth login",
            KeychainLock::Unknown,
        );
        assert_eq!(auth.signed_in, Some(false));
        assert_eq!(
            auth.detail,
            "Found, but not signed in — pull requests can't be opened from here."
        );
        assert_eq!(auth.command, "gh auth login");
        assert_eq!(auth.action, "Sign in");
    }

    #[test]
    fn gh_no_accounts_is_signed_out_too() {
        // Newer `gh` words it differently; both are a sign-out.
        let auth = gh_auth_status(false, "no accounts are configured", KeychainLock::Unknown);
        assert_eq!(auth.signed_in, Some(false));
        assert_eq!(auth.command, "gh auth login");
    }

    #[test]
    fn gh_unreadable_answer_never_claims_signed_out() {
        // A timed-out check, or any output Ply cannot read: it says it could
        // not tell. Sending someone to log in again for nothing is worse than
        // saying nothing.
        let timeout = "github.com\n  X Timeout trying to log in to github.com account MatteoB-adv (keyring)\n  - Active account: true";
        for lock in [KeychainLock::Unlocked, KeychainLock::Unknown] {
            let auth = gh_auth_status(false, timeout, lock);
            assert_eq!(auth.signed_in, None, "{lock:?}");
            assert_eq!(auth.command, "gh auth status");
            assert_eq!(auth.action, "Check");
            assert!(auth.detail.contains("could not read the answer"));
        }
    }

    /// Review 1 (#192): gh 2.100's *text* words a non-timeout network failure
    /// as a refused token (`X Failed to log in to nonexistent.invalid using
    /// token (GH_ENTERPRISE_TOKEN)` / `- The token in GH_ENTERPRISE_TOKEN is
    /// invalid.`, exit 1) — for a keychain account, this.
    const GH_OFFLINE_KEYRING: &str = "github.com
  X Failed to log in to github.com account MatteoB-adv (keyring)
  - Active account: true
  - The token in keyring is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u MatteoB-adv";

    #[test]
    fn an_older_gh_calling_a_token_invalid_never_claims_signed_out() {
        // GH #194: a gh before 2.81 has no `--json`, and its text words an
        // offline check and a refused token the same. With the keychain seen
        // unlocked that is "could not confirm", neutral, `Sign in` offered —
        // never the warning.
        let unlocked = gh_auth_status(false, GH_OFFLINE_KEYRING, KeychainLock::Unlocked);
        assert_eq!(unlocked.signed_in, None);
        assert!(unlocked.optional_step);
        assert_eq!(unlocked.detail, GH_UNCONFIRMED_DETAIL);
        assert_eq!(unlocked.action, "Sign in");
        assert_eq!(unlocked.command, "gh auth login");
        // With the lock unseen, #189's sentence; locked, the keychain's.
        let unseen = gh_auth_status(false, GH_OFFLINE_KEYRING, KeychainLock::Unknown);
        assert_eq!(unseen.detail, GH_TOKEN_UNREAD_DETAIL);
        assert!(unseen.optional_step);
        assert_eq!(
            gh_auth_status(false, GH_OFFLINE_KEYRING, KeychainLock::Locked).detail,
            GH_LOCKED_DETAIL
        );
        // The same for a token from the environment — captured offline from
        // gh 2.100.0's text (`GH_HOST=nonexistent.invalid`, a fake
        // `GH_ENTERPRISE_TOKEN`, an empty `GH_CONFIG_DIR`), whatever the lock.
        for lock in LOCKS {
            let env = gh_auth_status(false, GH_TEXT_OFFLINE_ENV, lock);
            assert_eq!(env.signed_in, None, "{lock:?}");
            assert!(env.optional_step, "{lock:?}");
            assert_eq!(env.detail, GH_UNCONFIRMED_DETAIL, "{lock:?}");
        }
    }

    /// gh 2.100.0, `gh auth status` (text), offline: `GH_HOST=nonexistent.invalid`,
    /// `GH_ENTERPRISE_TOKEN=<fake>`, empty `GH_CONFIG_DIR`. Exit 1.
    const GH_TEXT_OFFLINE_ENV: &str = "nonexistent.invalid
  X Failed to log in to nonexistent.invalid using token (GH_ENTERPRISE_TOKEN)
  - Active account: true
  - The token in GH_ENTERPRISE_TOKEN is invalid.";

    // ── GH #194: `--json` tells a refused token from a check that never
    //    reached GitHub ────────────────────────────────────────────────────
    //
    // Captured from gh 2.100.0 with an empty `GH_CONFIG_DIR` (or one holding
    // only a fake single-account `hosts.yml`, `version: "1"` so no migration
    // runs), `env -i`, fake tokens — no keychain item is read and no real
    // account is used. `--json` exits 0 in every case. The `hosts.yml` path
    // gh printed (the capture's scratch directory) is shortened here.

    /// `GH_HOST=nonexistent.invalid GH_ENTERPRISE_TOKEN=<fake>`: DNS failure.
    const GH_JSON_OFFLINE_ENV: &str = r#"{"hosts":{"nonexistent.invalid":[{"state":"error","error":"Post \"https://nonexistent.invalid/api/graphql\": dial tcp: lookup nonexistent.invalid: no such host","active":true,"host":"nonexistent.invalid","login":"","tokenSource":"GH_ENTERPRISE_TOKEN","gitProtocol":"https"}]}}"#;

    /// `GH_HOST=localhost GH_ENTERPRISE_TOKEN=<fake>`: nothing listening.
    const GH_JSON_CONNECTION_REFUSED_ENV: &str = r#"{"hosts":{"localhost":[{"state":"error","error":"Post \"https://localhost/api/graphql\": dial tcp [::1]:443: connect: connection refused","active":true,"host":"localhost","login":"","tokenSource":"GH_ENTERPRISE_TOKEN","gitProtocol":"https"}]}}"#;

    /// `GH_TOKEN=<fake>` against github.com: GitHub refused it.
    const GH_JSON_REFUSED_ENV: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"non-200 OK status code: 401 Unauthorized body: \"{\\r\\n  \\\"message\\\": \\\"Bad credentials\\\",\\r\\n  \\\"documentation_url\\\": \\\"https://docs.github.com/rest\\\",\\r\\n  \\\"status\\\": \\\"401\\\"\\r\\n}\"","active":true,"host":"github.com","login":"","tokenSource":"GH_TOKEN","gitProtocol":"https"}]}}"#;

    /// A fake token in `hosts.yml` for `github.com`: GitHub refused it. A
    /// stored token is checked by the same call as a keychain one
    /// (`shared.GetScopes`), so this is the error a revoked keychain token gets.
    const GH_JSON_REFUSED_HOSTS_YML: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Bad credentials (https://api.github.com/)","active":true,"host":"github.com","login":"fakeuser","tokenSource":"/tmp/gh/hosts.yml","gitProtocol":"https"}]}}"#;

    /// The same `hosts.yml` for `nonexistent.invalid`: DNS failure.
    const GH_JSON_OFFLINE_HOSTS_YML: &str = r#"{"hosts":{"nonexistent.invalid":[{"state":"error","error":"Get \"https://nonexistent.invalid/api/v3/\": dial tcp: lookup nonexistent.invalid: no such host","active":true,"host":"nonexistent.invalid","login":"fakeuser","tokenSource":"/tmp/gh/hosts.yml","gitProtocol":"https"}]}}"#;

    /// No account: stdout's JSON, then gh's line on stderr.
    const GH_JSON_NO_HOSTS: &str = "{\"hosts\":{}}\nYou are not logged into any GitHub hosts. To log in, run: gh auth login";

    /// A keychain token, offline. Not captured — Ply never reads the real
    /// keychain, and a fake item would be a keychain write — but the same
    /// entry as `GH_JSON_OFFLINE_HOSTS_YML` with gh's `keyring` source and
    /// github.com's API host (`buildEntry` differs only in the source label).
    const GH_JSON_OFFLINE_KEYRING: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"Get \"https://api.github.com/\": dial tcp: lookup api.github.com: no such host","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    /// A revoked keychain token: `GH_JSON_REFUSED_HOSTS_YML` with the
    /// `keyring` source.
    const GH_JSON_REFUSED_KEYRING: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Bad credentials (https://api.github.com/)","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    /// Signed in from the keychain (gh's `authEntry`, from its source).
    const GH_JSON_SIGNED_IN_KEYRING: &str = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}"#;

    /// The locked keychain's answer (`default`: no token read), from source.
    const GH_JSON_LOCKED: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Requires authentication (https://api.github.com/)","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"default","gitProtocol":"https"}]}}"#;

    /// A check that timed out (`authEntryStateTimeout`), from source.
    const GH_JSON_TIMEOUT_KEYRING: &str = r#"{"hosts":{"github.com":[{"state":"timeout","error":"Get \"https://api.github.com/\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    /// Review 1: GitHub reached, and no answer about the token — an outage
    /// (`HTTP 503`) or a rate limit (`HTTP 403`). The shape of gh's
    /// `HTTPError` (`HTTP <code>: <message> (<url>)`) as in the 401 capture;
    /// the codes are not captured.
    const GH_JSON_OUTAGE_KEYRING: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"HTTP 503: Service Unavailable (https://api.github.com/)","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;
    const GH_JSON_RATE_LIMITED_KEYRING: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/)","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    #[test]
    fn github_reached_without_an_answer_is_never_signed_out() {
        for output in [GH_JSON_OUTAGE_KEYRING, GH_JSON_RATE_LIMITED_KEYRING] {
            for lock in LOCKS {
                let auth = gh_auth_status(false, output, lock);
                assert_ne!(auth.signed_in, Some(false), "{lock:?} {output}");
            }
            for lock in [KeychainLock::Unlocked, KeychainLock::Unknown] {
                // The warn row: `signedIn: null`, `Check`, not offered.
                let auth = gh_auth_status(false, output, lock);
                assert_eq!(auth.signed_in, None);
                assert_eq!(auth.detail, GH_UNREACHABLE_DETAIL);
                assert_eq!(auth.action, "Check");
                assert!(!auth.optional_step);
            }
        }
        // The sentence claims neither offline only nor "not signed in".
        assert!(GH_UNREACHABLE_DETAIL.contains("GitHub may be having trouble"));
        assert!(!GH_UNREACHABLE_DETAIL.contains("not signed in"));
    }

    /// Review 1: `gh auth status --json hosts --active` on gh 2.100.0, `env -i`,
    /// a fake `hosts.yml` with two accounts on `nonexistent.invalid` (the
    /// inactive `otheruser` never listed, so never looked up) and one on
    /// `alsonot.invalid`. JSON sorts hosts; the text lists them in `hosts.yml`'s
    /// order (`nonexistent.invalid` first). Path shortened.
    const GH_JSON_ACTIVE_TWO_HOSTS: &str = r#"{"hosts":{"alsonot.invalid":[{"state":"error","error":"Get \"https://alsonot.invalid/api/v3/\": dial tcp: lookup alsonot.invalid: no such host","active":true,"host":"alsonot.invalid","login":"thirduser","tokenSource":"/tmp/gh/hosts.yml","gitProtocol":"https"}],"nonexistent.invalid":[{"state":"error","error":"Get \"https://nonexistent.invalid/api/v3/\": dial tcp: lookup nonexistent.invalid: no such host","active":true,"host":"nonexistent.invalid","login":"fakeuser","tokenSource":"/tmp/gh/hosts.yml","gitProtocol":"https"}]}}"#;

    #[test]
    fn with_no_github_com_account_json_and_text_pick_the_same_host() {
        // Captured shape of `--active`: one entry per host, all active.
        let hosts = gh_json_hosts(GH_JSON_ACTIVE_TWO_HOSTS).unwrap();
        assert_eq!(hosts.len(), 2);
        for accounts in hosts.values() {
            let accounts = accounts.as_array().unwrap();
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0]["active"], true);
        }
        assert!(!GH_JSON_ACTIVE_TWO_HOSTS.contains("otheruser"));
        // No github.com: the host whose name sorts first, from either shape,
        // although the text lists it second.
        let text = "zeta.example
  ✓ Logged in to zeta.example account z (keyring)
  - Active account: true

alpha.example
  X Failed to log in to alpha.example account a (keyring)
  - Active account: true
  - The token in keyring is invalid.";
        assert!(gh_text_active_block(text).unwrap().contains("alpha.example"));
        let json = r#"{"hosts":{"zeta.example":[{"state":"success","active":true,"host":"zeta.example","login":"z","tokenSource":"keyring","gitProtocol":"https"}],"alpha.example":[{"state":"error","error":"HTTP 401: Bad credentials (https://alpha.example/api/v3/)","active":true,"host":"alpha.example","login":"a","tokenSource":"keyring","gitProtocol":"https"}]}}"#;
        let from_json = gh_auth_status(false, json, KeychainLock::Unlocked);
        assert_eq!(from_json.signed_in, Some(false));
        // Text from an older gh cannot say refused or offline: neutral, but
        // the same host's failure — not zeta's success.
        let from_text = gh_auth_status(false, text, KeychainLock::Unlocked);
        assert_eq!(from_text.detail, GH_UNCONFIRMED_DETAIL);
    }

    #[test]
    fn json_is_found_after_crlf_lines() {
        // Review 1: line offsets must count every byte, `\r\n` included.
        // Three short CRLF lines: counting one byte per line break would land
        // three bytes early, inside `c`, and the JSON would not be read.
        let output = format!("a\r\nb\r\nc\r\n{GH_JSON_REFUSED_KEYRING}\r\n");
        assert!(gh_json_hosts(&output).is_some());
        assert_eq!(
            gh_auth_status(false, &output, KeychainLock::Unlocked).signed_in,
            Some(false)
        );
        let indented = format!("  {GH_JSON_SIGNED_IN_KEYRING}");
        assert_eq!(gh_auth_status(true, &indented, KeychainLock::Unknown).signed_in, Some(true));
    }

    #[test]
    fn offline_is_never_signed_out_whatever_the_token_or_the_lock() {
        // The #194 finding: offline with the keychain unlocked read as "not
        // signed in". gh's JSON says the check never reached GitHub.
        for output in [
            GH_JSON_OFFLINE_KEYRING,
            GH_JSON_OFFLINE_ENV,
            GH_JSON_CONNECTION_REFUSED_ENV,
            GH_JSON_OFFLINE_HOSTS_YML,
        ] {
            for lock in LOCKS {
                // `--json` exits 0; the caller passes whether every account
                // succeeded, so `false` here.
                let auth = gh_auth_status(false, output, lock);
                assert_ne!(auth.signed_in, Some(false), "{lock:?} {output}");
                assert!(!auth.detail.contains("not signed in"), "{lock:?} {output}");
            }
            let unlocked = gh_auth_status(false, output, KeychainLock::Unlocked);
            assert_eq!(unlocked.signed_in, None, "{output}");
            assert_eq!(unlocked.detail, GH_UNREACHABLE_DETAIL, "{output}");
            // The step is to look again, not to sign in.
            assert_eq!(unlocked.action, "Check");
            assert_eq!(unlocked.command, "gh auth status");
            assert!(!unlocked.optional_step);
        }
        // A keychain token with the keychain locked is still the keychain's
        // sentence (#189).
        assert_eq!(
            gh_auth_status(false, GH_JSON_OFFLINE_KEYRING, KeychainLock::Locked).detail,
            GH_LOCKED_DETAIL
        );
    }

    #[test]
    fn a_token_github_refused_is_signed_out() {
        // #189 review 1 holds: GitHub answered and refused a keychain token
        // with the keychain unlocked — revoked or expired — and that warns.
        // gh read the token, so the answer is the same when the lock was not
        // seen.
        for lock in [KeychainLock::Unlocked, KeychainLock::Unknown] {
            let auth = gh_auth_status(false, GH_JSON_REFUSED_KEYRING, lock);
            assert_eq!(auth.signed_in, Some(false), "{lock:?}");
            assert!(!auth.optional_step);
            assert_eq!(auth.action, "Sign in");
            assert_eq!(auth.command, "gh auth login");
        }
        // A locked keychain stays "cannot tell" whatever gh said (#189).
        assert_eq!(
            gh_auth_status(false, GH_JSON_REFUSED_KEYRING, KeychainLock::Locked).detail,
            GH_LOCKED_DETAIL
        );
        // A token from the environment or `hosts.yml` GitHub refused: the
        // keychain had no part in it, so whatever the lock.
        for output in [GH_JSON_REFUSED_ENV, GH_JSON_REFUSED_HOSTS_YML] {
            for lock in LOCKS {
                let auth = gh_auth_status(false, output, lock);
                assert_eq!(auth.signed_in, Some(false), "{lock:?} {output}");
                assert!(!auth.optional_step);
            }
        }
    }

    #[test]
    fn gh_json_reads_the_other_answers_as_the_text_did() {
        // Signed in, whatever the lock.
        for lock in LOCKS {
            let auth = gh_auth_status(true, GH_JSON_SIGNED_IN_KEYRING, lock);
            assert_eq!(auth.signed_in, Some(true), "{lock:?}");
        }
        // No account: signed out, whatever the lock (`--json` exits 0).
        for lock in LOCKS {
            for ok in [true, false] {
                let auth = gh_auth_status(ok, GH_JSON_NO_HOSTS, lock);
                assert_eq!(auth.signed_in, Some(false), "{lock:?}");
                assert!(!auth.optional_step);
            }
        }
        // `default` (no token read): locked → the keychain's sentence; lock
        // unseen → cannot tell; unlocked → no token anywhere, signed out —
        // online or off, since no token is no token.
        assert_eq!(
            gh_auth_status(false, GH_JSON_LOCKED, KeychainLock::Locked).detail,
            GH_LOCKED_DETAIL
        );
        assert_eq!(
            gh_auth_status(false, GH_JSON_LOCKED, KeychainLock::Unknown).detail,
            GH_TOKEN_UNREAD_DETAIL
        );
        assert_eq!(
            gh_auth_status(false, GH_JSON_LOCKED, KeychainLock::Unlocked).signed_in,
            Some(false)
        );
        // A timeout: could not read the answer.
        for lock in [KeychainLock::Unlocked, KeychainLock::Unknown] {
            let auth = gh_auth_status(false, GH_JSON_TIMEOUT_KEYRING, lock);
            assert_eq!(auth.signed_in, None);
            assert_eq!(auth.action, "Check");
            assert!(auth.detail.contains("could not read the answer"));
        }
    }

    #[test]
    fn only_a_401_is_a_refusal() {
        assert!(gh_error_is_refusal("HTTP 401: Bad credentials (https://api.github.com/)"));
        assert!(gh_error_is_refusal("non-200 OK status code: 401 Unauthorized body: \"…\""));
        for offline in [
            "Post \"https://nonexistent.invalid/api/graphql\": dial tcp: lookup nonexistent.invalid: no such host",
            "Post \"https://localhost/api/graphql\": dial tcp [::1]:443: connect: connection refused",
            "HTTP 502: Bad Gateway (https://api.github.com/)",
            "x509: certificate signed by unknown authority",
            "",
        ] {
            assert!(!gh_error_is_refusal(offline), "{offline}");
        }
    }

    #[test]
    fn an_older_gh_without_json_is_asked_the_plain_way() {
        // gh before 2.81 stops at the flag (the shape captured from 2.100.0
        // with an unknown flag), exit 1.
        let old = "unknown flag: --json\n\nUsage:  gh auth status [flags]";
        assert!(gh_flags_unsupported(false, old));
        // Review 1: an older gh still stops at `--active` the same way.
        let older = "unknown flag: --active\n\nUsage:  gh auth status [flags]";
        assert!(gh_flags_unsupported(false, older));
        // Another unknown flag is not these two: nothing to ask again.
        assert!(!gh_flags_unsupported(false, "unknown flag: --hostname"));
        // Any other failure, and any success, is the answer itself.
        assert!(!gh_flags_unsupported(false, GH_OFFLINE_KEYRING));
        assert!(!gh_flags_unsupported(true, GH_JSON_NO_HOSTS));
        // `--json` exits 0: whether every account succeeded is what the
        // caller reads instead, and plain text is not JSON.
        assert_eq!(gh_json_all_succeeded(GH_JSON_SIGNED_IN_KEYRING), Some(true));
        assert_eq!(gh_json_all_succeeded(GH_JSON_OFFLINE_KEYRING), Some(false));
        assert_eq!(gh_json_all_succeeded(GH_JSON_NO_HOSTS), Some(false));
        assert_eq!(gh_json_all_succeeded(GH_OFFLINE_KEYRING), None);
        assert_eq!(gh_json_all_succeeded(""), None);
    }

    // ── GH #189: a locked keychain is "cannot tell", never "signed out" ──

    /// `gh auth status` on the build Mac, signed in, token in the keychain.
    const GH_SIGNED_IN_KEYRING: &str = "github.com
  ✓ Logged in to github.com account MatteoB-adv (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'";

    /// The owner's walk of 1.146.0: the same Mac with the login keychain
    /// locked. `gh` cannot read its token, so the source is `default`.
    const GH_LOCKED: &str = "github.com
  X Failed to log in to github.com account MatteoB-adv (default)
  - Active account: true
  - The token in default is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u MatteoB-adv";

    /// A keychain token GitHub refused (revoked, expired).
    const GH_REFUSED_KEYRING: &str = "github.com
  X Failed to log in to github.com account MatteoB-adv (keyring)
  - Active account: true
  - The token in keyring is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u MatteoB-adv";

    /// gh 2.100.0 with no account at all (an empty `GH_CONFIG_DIR`).
    const GH_NO_HOSTS: &str =
        "You are not logged into any GitHub hosts. To log in, run: gh auth login";

    const LOCKS: [KeychainLock; 3] =
        [KeychainLock::Locked, KeychainLock::Unlocked, KeychainLock::Unknown];

    #[test]
    fn gh_signed_in_from_the_keychain_is_signed_in_whatever_the_lock() {
        for lock in LOCKS {
            let auth = gh_auth_status(true, GH_SIGNED_IN_KEYRING, lock);
            assert_eq!(auth.signed_in, Some(true), "{lock:?}");
            assert!(!auth.optional_step);
        }
    }

    #[test]
    fn a_locked_keychain_is_cannot_tell_never_signed_out() {
        let auth = gh_auth_status(false, GH_LOCKED, KeychainLock::Locked);
        assert_eq!(auth.signed_in, None);
        assert_eq!(auth.detail, GH_LOCKED_DETAIL);
        assert!(!auth.detail.contains("not signed in"));
        // Neutral, like claude's unseen sign-in: `Sign in` is offered, not the
        // row's step.
        assert!(auth.optional_step);
        assert_eq!(auth.action, "Sign in");
        assert_eq!(auth.command, "gh auth login");
        // Whatever else gh failed with, while the keychain is locked.
        for output in [GH_REFUSED_KEYRING, "anything else", ""] {
            assert_eq!(gh_auth_status(false, output, KeychainLock::Locked), auth);
        }
    }

    #[test]
    fn a_missing_token_is_cannot_tell_only_while_the_lock_is_unseen() {
        // `default` with the lock unknown: gh has the account and got no token
        // — locked, denied or timed out, Ply cannot tell which.
        let unseen = gh_auth_status(false, GH_LOCKED, KeychainLock::Unknown);
        assert_eq!(unseen.signed_in, None);
        assert!(unseen.optional_step);
        assert_eq!(unseen.detail, GH_TOKEN_UNREAD_DETAIL);
        // Review 1: `default` with the keychain seen unlocked is no token
        // anywhere (an account in `hosts.yml`, its keychain item gone) — a
        // gh that is genuinely signed out says so.
        let unlocked = gh_auth_status(false, GH_LOCKED, KeychainLock::Unlocked);
        assert_eq!(unlocked.signed_in, Some(false));
        assert!(!unlocked.optional_step);
        assert_eq!(unlocked.action, "Sign in");
        // A keychain token refused while Ply could not see the lock: unknown.
        let unseen = gh_auth_status(false, GH_REFUSED_KEYRING, KeychainLock::Unknown);
        assert_eq!(unseen.signed_in, None);
        assert!(unseen.optional_step);
    }

    #[test]
    fn gh_with_no_account_is_signed_out_even_with_the_keychain_locked() {
        // `hosts.yml` has nothing: the keychain has no part in that answer.
        for lock in LOCKS {
            let auth = gh_auth_status(false, GH_NO_HOSTS, lock);
            assert_eq!(auth.signed_in, Some(false), "{lock:?}");
            assert!(!auth.optional_step);
            assert_eq!(auth.action, "Sign in");
        }
    }

    // ── GH #195: the active github.com account decides, not the first failure ──
    //
    // Not captured: a second account's token is looked up in the keychain
    // first (`TokenForUser`), and the captures above never touch it. Written
    // from gh 2.100.0's `statusRun` and `authEntry.String`: the host's name,
    // the active account first, a blank line between accounts and between
    // hosts; `--json` lists the same entries with `"active"`.

    /// Active keychain account fine; an inactive one refused.
    const GH_TEXT_ACTIVE_OK_INACTIVE_BAD: &str = "github.com
  ✓ Logged in to github.com account MatteoB-adv (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  X Failed to log in to github.com account old-bot (keyring)
  - Active account: false
  - The token in keyring is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u old-bot";

    /// Active account with no token read (`default`: the #189 locked shape);
    /// an inactive one fine.
    const GH_TEXT_ACTIVE_DEFAULT_INACTIVE_OK: &str = "github.com
  X Failed to log in to github.com account MatteoB-adv (default)
  - Active account: true
  - The token in default is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u MatteoB-adv

  ✓ Logged in to github.com account other (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************";

    /// github.com fine; a second host's only account refused, listed first
    /// (gh lists hosts in `hosts.yml`'s order).
    const GH_TEXT_OTHER_HOST_BAD: &str = "ghe.example.com
  X Failed to log in to ghe.example.com account matteo (keyring)
  - Active account: true
  - The token in keyring is invalid.
  - To re-authenticate, run: gh auth login -h ghe.example.com
  - To forget about this account, run: gh auth logout -h ghe.example.com -u matteo

github.com
  ✓ Logged in to github.com account MatteoB-adv (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************";

    /// `GH_TOKEN` is the active account (the environment wins); the stored
    /// account is listed as inactive and is fine.
    const GH_TEXT_ACTIVE_ENV_BAD_INACTIVE_OK: &str = "github.com
  X Failed to log in to github.com using token (GH_TOKEN)
  - Active account: true
  - The token in GH_TOKEN is invalid.

  ✓ Logged in to github.com account MatteoB-adv (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************";

    /// The active account timed out; an inactive one was refused and carries
    /// gh's `gh auth login` advice.
    const GH_TEXT_ACTIVE_TIMEOUT_INACTIVE_BAD: &str = "github.com
  X Timeout trying to log in to github.com account MatteoB-adv (keyring)
  - Active account: true

  X Failed to log in to github.com account old-bot (keyring)
  - Active account: false
  - The token in keyring is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u old-bot";

    const GH_JSON_ACTIVE_OK_INACTIVE_BAD: &str = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"},{"state":"error","error":"HTTP 401: Bad credentials (https://api.github.com/)","active":false,"host":"github.com","login":"old-bot","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    /// Listed inactive-first, to hold the reading to the flag, not the order.
    const GH_JSON_ACTIVE_OFFLINE_INACTIVE_OK: &str = r#"{"hosts":{"github.com":[{"state":"success","active":false,"host":"github.com","login":"other","tokenSource":"keyring","gitProtocol":"https"},{"state":"error","error":"Get \"https://api.github.com/\": dial tcp: lookup api.github.com: no such host","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    const GH_JSON_ACTIVE_REFUSED_INACTIVE_OK: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Bad credentials (https://api.github.com/)","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"},{"state":"success","active":false,"host":"github.com","login":"other","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    /// `ghe.example.com` sorts before `github.com`: the primary host is
    /// chosen by name, not by place.
    const GH_JSON_OTHER_HOST_BAD: &str = r#"{"hosts":{"ghe.example.com":[{"state":"error","error":"HTTP 401: Bad credentials (https://ghe.example.com/api/v3/)","active":true,"host":"ghe.example.com","login":"matteo","tokenSource":"keyring","gitProtocol":"https"}],"github.com":[{"state":"success","active":true,"host":"github.com","login":"MatteoB-adv","tokenSource":"keyring","gitProtocol":"https"}]}}"#;

    #[test]
    fn an_inactive_account_or_another_host_never_flips_the_row() {
        // gh exits 1 (text) / the caller reports "not every account
        // succeeded" (JSON): `exit_ok` is false in every case.
        for output in [
            GH_TEXT_ACTIVE_OK_INACTIVE_BAD,
            GH_TEXT_OTHER_HOST_BAD,
            GH_JSON_ACTIVE_OK_INACTIVE_BAD,
            GH_JSON_OTHER_HOST_BAD,
        ] {
            for lock in LOCKS {
                let auth = gh_auth_status(false, output, lock);
                assert_eq!(auth.signed_in, Some(true), "{lock:?} {output}");
                assert!(!auth.optional_step);
            }
        }
        // The caller still sees what the exit status would have said.
        assert_eq!(gh_json_all_succeeded(GH_JSON_ACTIVE_OK_INACTIVE_BAD), Some(false));
        assert_eq!(gh_json_all_succeeded(GH_JSON_OTHER_HOST_BAD), Some(false));
    }

    #[test]
    fn the_active_accounts_failure_is_read_as_before() {
        // `default` on the active account: #189's three answers by lock, not
        // the inactive account's success.
        assert_eq!(
            gh_auth_status(false, GH_TEXT_ACTIVE_DEFAULT_INACTIVE_OK, KeychainLock::Locked).detail,
            GH_LOCKED_DETAIL
        );
        assert_eq!(
            gh_auth_status(false, GH_TEXT_ACTIVE_DEFAULT_INACTIVE_OK, KeychainLock::Unknown).detail,
            GH_TOKEN_UNREAD_DETAIL
        );
        assert_eq!(
            gh_auth_status(false, GH_TEXT_ACTIVE_DEFAULT_INACTIVE_OK, KeychainLock::Unlocked)
                .signed_in,
            Some(false)
        );
        // An environment token called invalid in text: "could not confirm"
        // (#194), whatever the lock — not the stored account's success.
        for lock in LOCKS {
            let auth = gh_auth_status(false, GH_TEXT_ACTIVE_ENV_BAD_INACTIVE_OK, lock);
            assert_eq!(auth.detail, GH_UNCONFIRMED_DETAIL, "{lock:?}");
        }
        // The active account timed out: could not read the answer — the
        // inactive account's `gh auth login` advice does not make it a
        // sign-out.
        for lock in [KeychainLock::Unlocked, KeychainLock::Unknown] {
            let auth = gh_auth_status(false, GH_TEXT_ACTIVE_TIMEOUT_INACTIVE_BAD, lock);
            assert_eq!(auth.signed_in, None, "{lock:?}");
            assert_eq!(auth.action, "Check");
            assert!(auth.detail.contains("could not read the answer"));
        }
        // JSON: the active account's own error, found by its flag.
        for lock in [KeychainLock::Unlocked, KeychainLock::Unknown] {
            assert_eq!(
                gh_auth_status(false, GH_JSON_ACTIVE_OFFLINE_INACTIVE_OK, lock).detail,
                GH_UNREACHABLE_DETAIL,
                "{lock:?}"
            );
            assert_eq!(
                gh_auth_status(false, GH_JSON_ACTIVE_REFUSED_INACTIVE_OK, lock).signed_in,
                Some(false),
                "{lock:?}"
            );
        }
        for output in [GH_JSON_ACTIVE_OFFLINE_INACTIVE_OK, GH_JSON_ACTIVE_REFUSED_INACTIVE_OK] {
            assert_eq!(
                gh_auth_status(false, output, KeychainLock::Locked).detail,
                GH_LOCKED_DETAIL
            );
        }
    }

    #[test]
    fn text_with_no_active_account_marked_is_read_whole() {
        // A gh before multi-account support (2.40) marks no account active:
        // the whole text decides, as before #195.
        assert_eq!(gh_text_active_block("github.com\n  X github.com: authentication failed"), None);
        assert_eq!(gh_text_active_block(GH_NO_HOSTS), None);
        // gh 2.100 prints the active account first; the block is found by its
        // `- Active account: true` line all the same, as the JSON by its flag.
        let inactive_first = "github.com
  X Failed to log in to github.com account old-bot (keyring)
  - Active account: false
  - The token in keyring is invalid.

  ✓ Logged in to github.com account MatteoB-adv (keyring)
  - Active account: true";
        for lock in LOCKS {
            assert_eq!(gh_auth_status(false, inactive_first, lock).signed_in, Some(true), "{lock:?}");
        }
        assert_eq!(
            gh_text_active_block(GH_TEXT_OTHER_HOST_BAD).as_deref(),
            Some(
                "✓ Logged in to github.com account MatteoB-adv (keyring)\n- Active account: true\n- Git operations protocol: https\n- Token: gho_************************************"
            )
        );
    }

    #[test]
    fn only_a_read_that_asks_runs_gh_and_a_fresh_answer_is_reused() {
        let signed_in = gh_auth_status(true, "Logged in", KeychainLock::Unknown);
        // A read that does not ask never runs anything…
        assert_eq!(auth_probe(false, false, None), AuthProbe::Skip);
        // …but still shows what was learnt a moment ago, so the row does not
        // flicker back between two Diagnostics reads.
        assert_eq!(
            auth_probe(false, false, Some((Duration::from_secs(5), signed_in.clone()))),
            AuthProbe::Cached(signed_in.clone())
        );
        // Stale and not asked: say nothing rather than something old.
        assert_eq!(
            auth_probe(false, false, Some((GH_AUTH_TTL, signed_in.clone()))),
            AuthProbe::Skip
        );
        // A read that asks reuses a fresh answer and re-runs a stale one.
        assert_eq!(
            auth_probe(true, false, Some((Duration::from_secs(89), signed_in.clone()))),
            AuthProbe::Cached(signed_in.clone())
        );
        assert_eq!(
            auth_probe(true, false, Some((GH_AUTH_TTL, signed_in.clone()))),
            AuthProbe::Ask
        );
        assert_eq!(auth_probe(true, false, None), AuthProbe::Ask);
    }

    #[test]
    fn look_again_from_scratch_beats_the_cache() {
        // Review 2 (N2): the one press that is meant to cost something. Without
        // this, somebody who had just signed in had no way to make Ply look —
        // the answer from ten seconds ago won.
        let signed_out = gh_auth_status(false, "You are not logged into any GitHub hosts.", KeychainLock::Unknown);
        assert_eq!(
            auth_probe(true, true, Some((Duration::from_secs(1), signed_out.clone()))),
            AuthProbe::Ask
        );
        // Forced wins even when nothing asked for the row at all, because only
        // `Look again, from scratch` forces.
        assert_eq!(auth_probe(false, true, Some((Duration::ZERO, signed_out))), AuthProbe::Ask);
        assert_eq!(auth_probe(false, true, None), AuthProbe::Ask);
    }

    #[test]
    fn a_tool_ply_does_not_ask_about_says_nothing() {
        let report = build_report_for_test(&env(Some("/c"), Some("1.5.0"), Some("/g")), None);
        for tool in &report.tools {
            assert!(
                tool.auth.is_none(),
                "{} claims to know about sign-in before anything asked",
                tool.id
            );
        }
    }

    // ── GH #169: claude's sign-in, from credential presence only ──────────

    #[test]
    fn claude_with_a_credential_in_either_place_is_signed_in() {
        use CredentialSeen::*;
        for (keychain, file) in [(Present, Absent), (Present, Unreadable), (Absent, Present), (Unreadable, Present), (Present, Present)] {
            let auth = claude_auth_status(keychain, file);
            assert_eq!(auth.signed_in, Some(true), "{keychain:?} / {file:?}");
            // BOARDS.md §5, word for word.
            assert_eq!(auth.detail, "Found and signed in. Nothing to do.");
            assert_eq!(auth.action, "Sign in"); // never shown: the row is Ready
        }
    }

    #[test]
    fn a_missing_credentials_file_never_reads_as_signed_out_when_the_keychain_has_one() {
        // The Mac this was built on: the keychain item, no file.
        let auth = claude_auth_status(CredentialSeen::Present, CredentialSeen::Absent);
        assert_eq!(auth.signed_in, Some(true));
    }

    #[test]
    fn claude_is_never_reported_signed_out() {
        // Every combination, including "both places answered: nothing" — an
        // API key or an apiKeyHelper leaves no trace in either.
        use CredentialSeen::*;
        for keychain in [Present, Absent, Unreadable] {
            for file in [Present, Absent, Unreadable] {
                let auth = claude_auth_status(keychain, file);
                assert_ne!(auth.signed_in, Some(false), "{keychain:?} / {file:?}");
            }
        }
        let unknown = claude_auth_status(Absent, Absent);
        assert_eq!(unknown.signed_in, None);
        // What Ply could not see, not a claim; the login is offered, not asked.
        assert_eq!(unknown.detail, CLAUDE_UNSEEN_DETAIL);
        assert!(!unknown.detail.contains("not signed in"));
        assert!(!unknown.detail.contains("signed out"));
        assert_eq!(unknown.command, "claude auth login");
        assert_eq!(unknown.action, "Sign in");
        assert!(unknown.optional_step, "neutral: a secondary step, never the row's");
        assert!(!claude_auth_status(Present, Absent).optional_step);
        assert_eq!(claude_auth_status(Unreadable, Unreadable), unknown);
    }

    #[test]
    fn an_unasked_gh_row_claims_nothing_about_sign_in() {
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/g"));
        e.gh_path = Some("/opt/homebrew/bin/gh".into());
        let report = build_report_for_test(&e, None);
        let gh = tool(&report, "gh");
        assert!(gh.found && gh.auth.is_none());
        assert_eq!(gh.detail, GH_FOUND_DETAIL);
        assert!(!gh.detail.contains("lets you open"));
    }

    #[test]
    fn the_claude_row_keeps_its_sentence_until_something_asks() {
        let report = build_report_for_test(&env(Some("/c"), Some("1.5.0"), Some("/g")), None);
        let claude = tool(&report, "claude");
        assert_eq!(claude.detail, CLAUDE_READY_DETAIL);
        assert!(claude.auth.is_none());
    }

    #[test]
    fn too_old_claude_is_a_warning_not_a_block() {
        // found but old: required check passes (found), but version_ok is false.
        // On both platforms, each read with its own other requirements met
        // (Windows also needs Git Bash), so only the old Claude is under test.
        let mut e = env(Some("/c"), Some("0.1.0"), Some("/git"));
        e.git_bash_path = Some(r"C:\Git\bin\bash.exe".into());
        for windows in [false, true] {
            let r = report_on(&e, &facts(windows));
            assert!(r.all_required_ok, "old-but-present claude must not block (windows: {windows})");
            let c = tool(&r, "claude");
            assert!(c.found);
            assert!(!c.version_ok);
            assert_eq!(c.install_cmd, "claude update");
        }
    }

    #[test]
    fn missing_claude_install_cmd_is_the_installer_not_updater() {
        let r = build_report_for_test(&env(None, None, Some("/git")), None);
        assert_eq!(
            tool(&r, "claude").install_cmd,
            mac_or_windows(
                "curl -fsSL https://claude.ai/install.sh | bash",
                "irm https://claude.ai/install.ps1 | iex"
            )
        );
        assert!(!tool(&r, "claude").version_ok);
    }

    #[test]
    fn codex_on_path_but_not_starting_is_not_reported_healthy() {
        // Real failure mode (2026-08-30): a half-installed @openai/codex left
        // its Node wrapper on PATH, so the path resolved while every run
        // crashed. `found` is a fact about the file; `version_ok` has to be a
        // fact about it running, or the doctor green-lights a dead CLI and the
        // tile toolbar keeps offering it.
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/git"));
        e.codex_path = Some("/x/codex".into());
        e.codex_version = None;
        let r = build_report_for_test(&e, None);
        let c = tool(&r, "codex");
        assert!(c.found, "the wrapper is on PATH");
        assert!(!c.version_ok, "but it never starts");
        // 1.176.0 R7: its way is Repair.
        assert!(
            c.detail.contains("Repair"),
            "detail must tell the user what to do: {}",
            c.detail
        );
        assert_eq!(
            c.install_cmd,
            mac_or_windows(
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
                CODEX_WINDOWS_INSTALL
            )
        );
    }

    #[test]
    fn codex_answering_version_is_healthy_and_offers_the_plain_installer() {
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/git"));
        e.codex_path = Some("/x/codex".into());
        e.codex_version = Some("0.151.0".into());
        let c_env = e.clone();
        let r = build_report_for_test(&e, None);
        let c = tool(&r, "codex");
        assert!(c.found && c.version_ok);
        assert!(c_env.codex_healthy());
        assert_eq!(
            c.install_cmd,
            mac_or_windows(
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
                CODEX_WINDOWS_INSTALL
            )
        );
    }

    #[test]
    fn require_codex_refuses_a_resolved_but_dead_wrapper() {
        // agents.rs gates Provider::Codex runs on require("codex"). Handing it
        // a path that crashes on spawn turns a clear dependency error into a
        // Node stack trace inside a dying tile.
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/git"));
        e.codex_path = Some("/x/codex".into());
        e.codex_version = None;
        let err = require_in(&e, "codex").expect_err("dead codex must not pass");
        assert!(err.contains("doesn't start"), "{err}");
        assert!(
            err.contains(mac_or_windows(
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
                CODEX_WINDOWS_INSTALL
            )),
            "{err}"
        );

        e.codex_version = Some("0.151.0".into());
        assert_eq!(require_in(&e, "codex").as_deref(), Ok("/x/codex"));
    }

    /// 1.176.0 R3 (blind spots 3, 4): a Claude whose `--version` doesn't
    /// answer is "installed but not starting", not "too old"; its fix is the
    /// official installer (never `claude update`, which runs the broken
    /// binary — R0 C4), and it is not ready: not for the one-AI check, not
    /// for an intake, not for `require`.
    #[test]
    fn a_claude_that_does_not_start_is_not_ready_and_is_reinstalled() {
        let e = env(Some("/c"), None, Some("/git"));
        assert!(!e.claude_healthy());
        for windows in [false, true] {
            let r = report_on(&e, &facts(windows));
            let c = tool(&r, "claude");
            assert!(c.found, "the launcher is there");
            assert!(!c.version_ok);
            assert_eq!(c.detail, CLAUDE_NOT_STARTING_DETAIL);
            assert_eq!(
                c.install_cmd,
                if windows {
                    "irm https://claude.ai/install.ps1 | iex"
                } else {
                    "curl -fsSL https://claude.ai/install.sh | bash"
                }
            );
            assert!(c.update.is_none(), "no update line for a Claude that doesn't run");
            assert!(!r.ai_ready, "no AI that starts (windows: {windows})");
        }
        assert!(!vendor_ready_with(&e, "claude", None));
        let err = require_in(&e, "claude").expect_err("a Claude that doesn't start is never handed out");
        assert!(err.contains("doesn't start"), "{err}");
        assert!(err.contains(mac_or_windows(
            "curl -fsSL https://claude.ai/install.sh | bash",
            "irm https://claude.ai/install.ps1 | iex"
        )), "{err}");
        assert!(!err.contains("claude update"), "{err}");

        // Starting again: ready, the ordinary row.
        let fixed = env(Some("/c"), Some("2.1.330"), Some("/git"));
        assert!(vendor_ready_with(&fixed, "claude", None));
        assert_eq!(require_in(&fixed, "claude").as_deref(), Ok("/c"));
        assert_eq!(tool(&report_on(&fixed, &facts(false)), "claude").detail, CLAUDE_READY_DETAIL);
    }

    /// R3 review 1: a `--version` that didn't answer in time (twice) is not
    /// a Claude or Codex that doesn't start: ready, handed out, a neutral row,
    /// no fix offered.
    #[test]
    fn a_slow_version_answer_is_not_a_broken_tool() {
        let mut e = with_codex(env(Some("/c"), None, Some("/git")));
        e.claude_version_unknown = true;
        e.codex_version = None;
        e.codex_version_unknown = true;
        assert!(e.claude_healthy() && e.codex_healthy());
        let r = report_on(&e, &facts(false));
        let c = tool(&r, "claude");
        assert!(c.version_ok, "no Update or Reinstall for a slow answer");
        assert_eq!(c.detail, CLAUDE_VERSION_UNKNOWN_DETAIL);
        assert_eq!(tool(&r, "codex").detail, CODEX_VERSION_UNKNOWN_DETAIL);
        assert!(tool(&r, "codex").version_ok);
        assert!(r.ai_ready);
        assert_eq!(require_in(&e, "claude").as_deref(), Ok("/c"));
        assert_eq!(require_in(&e, "codex").as_deref(), Ok("/x/codex"));
        assert!(vendor_ready_with(&e, "claude", None));
        assert!(vendor_ready_with(&e, "codex", None));
        assert_eq!(crate::builder::vendor_missing_refusal(&e, "claude", false), None);
        // A real failure is still refused everywhere.
        e.claude_version_unknown = false;
        assert!(require_in(&e, "claude").is_err());
        assert!(crate::builder::vendor_missing_refusal(&e, "claude", false).unwrap().contains("doesn't start"));
    }

    /// R3: a path `require` would hand out that isn't on disk (a launcher a
    /// failed update left dangling) reads as not installed — the friendly
    /// sentence an agent's run shows — not as a program to start.
    #[test]
    fn require_never_hands_out_a_claude_or_codex_path_that_is_gone() {
        let e = with_codex(env(Some("/gone/claude"), Some("2.1.330"), Some("/git")));
        let gone = |_: &str| false;
        for tool_id in ["claude", "codex"] {
            let err = require_with(&e, tool_id, gone).expect_err(tool_id);
            assert!(err.contains("isn't installed"), "{err}");
        }
        // git is not judged by the CLI disk check (its own rules apply).
        assert_eq!(require_with(&e, "git", gone).as_deref(), Ok("/git"));
        assert_eq!(require_with(&e, "claude", |_| true).as_deref(), Ok("/gone/claude"));
    }

    /// 1.176.2 R1 (A1-02): a `gh` gone from disk since the probe (uninstalled,
    /// moved) reads as not installed, with Look again — never a path handed
    /// out to fail as "a file or folder it needed isn't there any more".
    #[test]
    fn require_never_hands_out_a_gh_path_that_is_gone() {
        let mut e = env(Some("/c"), Some("2.1.330"), Some("/git"));
        e.gh_path = Some(r"C:\Program Files\GitHub CLI\gh.exe".into());
        let err = require_with(&e, "gh", |_| false).expect_err("gone");
        assert!(err.contains("GitHub CLI isn't installed") && err.contains("Look again"), "{err}");
        assert_eq!(
            require_with(&e, "gh", |_| true).as_deref(),
            Ok(r"C:\Program Files\GitHub CLI\gh.exe")
        );
        // `require` itself checks gh on disk.
        let src = include_str!("doctor.rs");
        let body = &src[src.find("pub fn require(tool_id").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("require_with(&shell_env::get(), tool_id, crate::cli_fresh::usable)"), "{body}");
    }

    #[test]
    fn require_missing_codex_still_reports_it_as_not_installed() {
        let e = env(Some("/c"), Some("1.5.0"), Some("/git"));
        let err = require_in(&e, "codex").expect_err("absent codex must not pass");
        assert!(err.contains("isn't installed"), "{err}");
    }

    // ── v1.116.0: the team-skills row ───────────────────────────────

    fn library(
        both: usize,
        claude_only: usize,
        codex_only: usize,
        refused: usize,
    ) -> crate::team_skills::TeamSkillsLibrary {
        use crate::team_skills::{RefusedPlugin, TeamSkill, TeamSkillsLibrary, Vendor};
        let skill = |n: usize, claude: bool, codex: bool| TeamSkill {
            codex_name: None,
            name: format!("skill-{n}-{claude}-{codex}"),
            description: "A shared skill.".into(),
            plugin: "ply-team".into(),
            claude,
            codex,
        };
        let mut skills = Vec::new();
        skills.extend((0..both).map(|n| skill(n, true, true)));
        skills.extend((0..claude_only).map(|n| skill(n, true, false)));
        skills.extend((0..codex_only).map(|n| skill(n, false, true)));
        TeamSkillsLibrary {
            skills,
            refused: (0..refused)
                .map(|n| RefusedPlugin {
                    plugin: format!("evil-{n}"),
                    vendor: Vendor::Claude,
                    reason: "it carries hooks".into(),
                    skills: Vec::new(),
                })
                .collect(),
            ..TeamSkillsLibrary::default()
        }
    }

    fn report_with(library: &crate::team_skills::TeamSkillsLibrary) -> TeamSkillsStatus {
        row(library, None)
    }

    // ── v1.117.0 (rung 4): the project-skills row ──────────────────

    /// Build a `ProjectSkills` the way the reader would, without a filesystem:
    /// these cases are about the row's arithmetic and its sentences.
    fn project(
        both: usize,
        claude_only: usize,
        codex_only: usize,
        diverged: usize,
        unloadable: usize,
    ) -> crate::project_skills::ProjectSkills {
        use crate::project_skills::{ProjectSkill, ProjectSkills, UnloadableSkill};
        let skill = |n: usize, claude: bool, codex: bool, diverged: bool| ProjectSkill {
            name: format!("skill-{n}-{claude}-{codex}-{diverged}"),
            codex_name: None,
            description: "A repo skill.".into(),
            claude,
            codex,
            roots: Vec::new(),
            diverged,
            ignored_roots: Vec::new(), asks: None, asks_id: None, share_refusal: None,
        };
        let mut skills = Vec::new();
        skills.extend((0..both).map(|n| skill(n, true, true, false)));
        skills.extend((0..claude_only).map(|n| skill(n, true, false, false)));
        skills.extend((0..codex_only).map(|n| skill(n, false, true, false)));
        skills.extend((0..diverged).map(|n| skill(n, true, true, true)));
        ProjectSkills {
            skills,
            unloadable: (0..unloadable)
                .map(|n| UnloadableSkill {
                    name: format!("broken-{n}"),
                    root: crate::project_skills::CLAUDE_ROOT.into(),
                    reason: "it has no description in its frontmatter".into(),
                })
                .collect(),
            roots_present: vec![crate::project_skills::CLAUDE_ROOT.into()],
            ..ProjectSkills::default()
        }
    }

    fn project_row(skills: &crate::project_skills::ProjectSkills) -> Option<ProjectSkillsStatus> {
        build_report(
            &env(Some("/c"), Some("1.5.0"), Some("/git")),
            None,
            None,
            Some(ProjectSkillsInput {
                workspace: "atelier",
                skills,
            }),
        )
        .project_skills
    }

    /// A repo with no skill directory gets no row: the CLIs read these out of
    /// the repository itself, so "0 loaded" would report a fault where there
    /// is simply nothing.
    #[test]
    fn a_repo_with_no_skill_roots_has_no_project_row() {
        let mut skills = project(0, 0, 0, 0, 0);
        skills.roots_present.clear();
        assert!(project_row(&skills).is_none());
        // And a machine with no workspace open at all.
        assert!(build_report_for_test(&env(Some("/c"), Some("1.5.0"), Some("/git")), None)
            .project_skills
            .is_none());
    }

    /// Same rule as the team row: "loaded" means every session Ply starts gets
    /// it, and Ply starts both vendors — a Builder on one, a Challenger on the
    /// other.
    #[test]
    fn the_project_row_counts_only_skills_both_clis_load() {
        let row = project_row(&project(2, 0, 0, 0, 0)).expect("a row");
        assert_eq!(row.loaded, 2);
        assert_eq!((row.claude_only, row.codex_only, row.diverged), (0, 0, 0));
        assert!(row.detail.starts_with("2 project skills loaded from atelier"), "{}", row.detail);
        // The workspace is named: the doctor is machine-wide, and an unnamed
        // count would be about a repo nobody identified.
        assert_eq!(row.workspace, "atelier");
    }

    #[test]
    fn a_one_sided_project_skill_is_named_rather_than_counted_as_loaded() {
        let row = project_row(&project(1, 2, 1, 0, 0)).expect("a row");
        assert_eq!(row.loaded, 1);
        assert_eq!((row.claude_only, row.codex_only), (2, 1));
        assert!(row.detail.contains("2 in .claude/skills only"), "{}", row.detail);
        assert!(row.detail.contains("1 in a Codex root only"), "{}", row.detail);
    }

    /// The one fault a badge pair cannot show: both CLIs load it, and they do
    /// not load the same file.
    #[test]
    fn diverged_copies_are_reported_in_the_project_row() {
        let row = project_row(&project(0, 0, 0, 1, 0)).expect("a row");
        assert_eq!(row.diverged, 1);
        // It is still loaded by both — the divergence is about *what* they load.
        assert_eq!(row.loaded, 1);
        assert!(
            row.detail.contains("1 skill is a different file in each root"),
            "{}",
            row.detail
        );
    }

    /// Found on the rung 4 walk: `.claude/` ignored wholesale, both copies on
    /// disk, both badges lit — and no card ever carries the Claude half. The
    /// row spells the root out the way it spells out a one-sided one.
    #[test]
    fn a_gitignored_root_is_spelled_out_with_its_fix() {
        let mut skills = project(1, 0, 0, 0, 0);
        skills.ignored_roots = vec![crate::project_skills::CLAUDE_ROOT.into()];
        let row = project_row(&skills).expect("a row");
        assert_eq!(row.gitignored, vec![".claude/skills".to_string()]);
        // Both CLIs still load it here; the fault is every other checkout.
        assert_eq!(row.loaded, 1);
        assert!(
            row.detail.contains(".claude/skills is gitignored in this repo — a card will not carry it"),
            "{}",
            row.detail
        );
        assert!(row.detail.contains(".claude/* then !.claude/skills/"), "{}", row.detail);
        assert!(row.detail.ends_with("Un-ignore shows the exact lines and adds them when you confirm."), "{}", row.detail);

        // One skill's copy ignored by a rule naming it counts too.
        let mut one = project(1, 0, 0, 0, 0);
        one.skills[0].ignored_roots = vec![crate::project_skills::CODEX_ROOT.into()];
        let row = project_row(&one).expect("a row");
        assert_eq!(row.gitignored, vec![".agents/skills".to_string()]);

        // And a repo whose roots all ship says nothing about it.
        let clean = project_row(&project(1, 0, 0, 0, 0)).expect("a row");
        assert!(clean.gitignored.is_empty());
        assert!(!clean.detail.contains("gitignored"), "{}", clean.detail);
        assert!(!clean.detail.contains("Un-ignore"), "{}", clean.detail);
    }

    /// GH #227: a link is said as what git stores — the link, not the files
    /// it points to — with git's answer for it and for its files, and a path
    /// git would not answer for is said as unknown in plain words, never as
    /// clean; git's own words go to Details.
    #[test]
    fn links_and_unanswered_paths_are_explained_not_guessed() {
        use crate::project_skills::{BoundaryKind, SkillBoundary, TargetState, Unanswered};
        let link = |skill: Option<&str>, path: &str, ignored: Option<bool>, state: TargetState| {
            SkillBoundary {
                kind: BoundaryKind::Link,
                root: crate::project_skills::CLAUDE_ROOT.into(),
                skill: skill.map(str::to_string),
                path: path.into(),
                target: "../shared/x".into(),
                ignored,
                target_state: state,
            }
        };
        let mut carried = project(1, 0, 0, 0, 0);
        carried.boundaries = vec![link(
            Some("s2"),
            ".claude/skills/s2",
            Some(false),
            TargetState::Carried("shared/x".into()),
        )];
        let row = project_row(&carried).expect("a row");
        assert!(
            row.detail.contains(
                ".claude/skills/s2 is a link to ../shared/x: git stores the link, not the files \
                 it points to."
            ),
            "{}",
            row.detail
        );
        assert!(row.ignored_links.is_empty() && row.unanswered.is_empty());
        assert!(row.gitignored.is_empty());
        assert!(!row.detail.contains("Un-ignore"), "{}", row.detail);

        // Carried, but its files are ignored where they live: said concretely.
        let mut dangling = project(1, 0, 0, 0, 0);
        dangling.boundaries = vec![link(
            Some("s2"),
            ".claude/skills/s2",
            Some(false),
            TargetState::Ignored("shared/x".into()),
        )];
        let row = project_row(&dangling).expect("a row");
        assert!(
            row.detail.contains("git ignores its files in shared/x, so no card carries them"),
            "{}",
            row.detail
        );
        assert_eq!(row.ignored_links, vec![".claude/skills/s2".to_string()]);

        // A whole root that is a link git ignores: the line that carries it.
        let mut ignored = project(1, 0, 0, 0, 0);
        ignored.boundaries = vec![link(None, ".claude/skills", Some(true), TargetState::Unknown)];
        let row = project_row(&ignored).expect("a row");
        assert_eq!(row.ignored_links, vec![".claude/skills".to_string()]);
        assert!(row.detail.contains("git ignores it itself"), "{}", row.detail);
        assert!(
            row.detail.contains("add !/.claude/skills (no trailing slash"),
            "{}",
            row.detail
        );
        assert!(row.gitignored.is_empty());

        // Review round 1 (m1): a skill's link inside a gitignored root is the
        // root's to answer — Un-ignore carries the link with the rest.
        let mut inside = project(1, 0, 0, 0, 0);
        inside.ignored_roots = vec![crate::project_skills::CLAUDE_ROOT.into()];
        inside.boundaries = vec![link(
            Some("s2"),
            ".claude/skills/s2",
            Some(true),
            TargetState::Carried("shared/x".into()),
        )];
        let row = project_row(&inside).expect("a row");
        assert!(row.ignored_links.is_empty(), "{:?}", row.ignored_links);
        assert!(!row.detail.contains("git ignores it itself"), "{}", row.detail);
        assert!(
            row.detail.contains("un-ignoring .claude/skills carries it too"),
            "{}",
            row.detail
        );

        // No answer: plain words, git's text only in `git_details`.
        let mut unknown = project(1, 0, 0, 0, 0);
        unknown.boundaries = vec![link(Some("s3"), ".claude/skills/s3", None, TargetState::Unknown)];
        unknown.unanswered = vec![Unanswered {
            path: ".agents/skills/s4".into(),
            reason: "it is inside a submodule".into(),
        }];
        unknown.git_details = vec!["git check-ignore failed: fatal: boom".into()];
        let row = project_row(&unknown).expect("a row");
        assert_eq!(
            row.unanswered,
            vec![".claude/skills/s3".to_string(), ".agents/skills/s4".to_string()]
        );
        assert!(
            row.detail.contains("Plyloft couldn't ask git whether it is ignored"),
            "{}",
            row.detail
        );
        assert!(
            row.detail.contains(
                "Plyloft couldn't ask git whether .agents/skills/s4 is ignored — it is inside a \
                 submodule — so the row doesn't say either way."
            ),
            "{}",
            row.detail
        );
        assert!(!row.detail.contains("fatal"), "{}", row.detail);
        assert_eq!(row.git_details, vec!["git check-ignore failed: fatal: boom".to_string()]);
        assert!(!row.detail.contains("gitignored"), "{}", row.detail);
    }

    /// GH #227 review 2 (m1): for one skill's link git ignores, the row
    /// names only `!/<link>` — never `/<root>/*`, which would ignore every
    /// other skill. Proven against git: the named line carries the link and
    /// the other skills stay carried.
    #[cfg(unix)] // a symlink fixture
    #[test]
    fn an_ignored_skill_link_names_a_line_that_keeps_the_other_skills() {
        let repo = tempfile::TempDir::new().unwrap();
        let top = repo.path();
        crate::git::run(top, &["init", "-q"]).unwrap();
        let skill = "---\nname: x\ndescription: d\n---\n";
        for dir in [".claude/skills/real", "shared/s2"] {
            std::fs::create_dir_all(top.join(dir)).unwrap();
            std::fs::write(top.join(dir).join("SKILL.md"), skill).unwrap();
        }
        std::os::unix::fs::symlink("../../shared/s2", top.join(".claude/skills/s2")).unwrap();
        let rules = ".claude/*\n!.claude/skills/\ns2\n";
        std::fs::write(top.join(".gitignore"), rules).unwrap();

        let skills = crate::project_skills::read_project_skills(top);
        assert!(skills.ignored_roots.is_empty(), "{:?}", skills.ignored_roots);
        let row = project_row(&skills).expect("a row");
        assert_eq!(row.ignored_links, vec![".claude/skills/s2".to_string()]);
        assert!(
            row.detail.contains("add !/.claude/skills/s2 (no trailing slash"),
            "{}",
            row.detail
        );
        assert!(!row.detail.contains("/.claude/skills/*"), "{}", row.detail);
        assert!(!row.detail.contains("!/.claude/skills/ and"), "{}", row.detail);

        let ignored = |path: &str| {
            crate::platform::git_command()
                .args(["check-ignore", "-q", "--", path])
                .current_dir(top)
                .status()
                .unwrap()
                .success()
        };
        assert!(ignored(".claude/skills/s2"));
        std::fs::write(top.join(".gitignore"), format!("{rules}!/.claude/skills/s2\n")).unwrap();
        assert!(!ignored(".claude/skills/s2"), "the named line carries the link");
        assert!(!ignored(".claude/skills/real/SKILL.md"), "the other skill stays carried");
        assert!(!ignored(".claude/skills/later/SKILL.md"), "and one added later");
        // What the round-1 clause would have added ignores them all.
        std::fs::write(
            top.join(".gitignore"),
            format!("{rules}!/.claude/skills/\n/.claude/skills/*\n!/.claude/skills/s2\n"),
        )
        .unwrap();
        assert!(ignored(".claude/skills/real/SKILL.md"), "the clause this test forbids");

        // A root-level link still gets the parent lines.
        let mut root = skills.clone();
        root.boundaries = vec![crate::project_skills::SkillBoundary {
            skill: None,
            path: ".claude/skills".into(),
            ..skills.boundaries[0].clone()
        }];
        let row = project_row(&root).expect("a row");
        assert!(
            row.detail.contains("with !/.claude/ and /.claude/* before it"),
            "{}",
            row.detail
        );
    }

    /// Review round 2: a nested clone is said as one — committing it gives
    /// nobody anything to check out — and warns; a submodule is said as one.
    #[test]
    fn a_nested_clone_and_a_submodule_are_told_apart() {
        use crate::project_skills::{BoundaryKind, SkillBoundary, TargetState};
        let boundary = |kind| SkillBoundary {
            kind,
            root: crate::project_skills::CLAUDE_ROOT.into(),
            skill: Some("sub".into()),
            path: ".claude/skills/sub".into(),
            target: String::new(),
            ignored: Some(false),
            target_state: TargetState::Unknown,
        };
        let mut nested = project(1, 0, 0, 0, 0);
        nested.boundaries = vec![boundary(BoundaryKind::NestedRepository)];
        let row = project_row(&nested).expect("a row");
        assert!(row.detail.contains("isn't a registered submodule"), "{}", row.detail);
        assert!(row.detail.contains("git submodule add"), "{}", row.detail);
        assert_eq!(row.ignored_links, vec![".claude/skills/sub".to_string()]);

        let mut sub = project(1, 0, 0, 0, 0);
        sub.boundaries = vec![boundary(BoundaryKind::Submodule)];
        let row = project_row(&sub).expect("a row");
        assert!(row.detail.contains(".claude/skills/sub is a submodule"), "{}", row.detail);
        assert!(row.ignored_links.is_empty(), "{:?}", row.ignored_links);
    }

    /// GH #51: this repository's own row, read from its real skill roots. A
    /// skill added to one root only, or edited in one copy, turns the doctor
    /// row on `atelier` into a warning — and a Claude or Codex session here
    /// into one that never sees it.
    #[test]
    fn this_repositorys_skills_load_in_both_clis() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root");
        let skills = crate::project_skills::read_project_skills(repo_root);
        let row = project_row(&skills).expect("the repo carries skills");
        assert!(row.loaded >= 1, "{}", row.detail);
        assert_eq!(
            (row.claude_only, row.codex_only, row.diverged, row.unloadable),
            (0, 0, 0, 0),
            "{}",
            row.detail
        );
        assert!(row.gitignored.is_empty(), "{}", row.detail);
        assert!(skills.errors.is_empty(), "{:?}", skills.errors);
        // v1.117.0 shipped the row with a run of spaces in the middle.
        assert!(row.detail.contains("session Plyloft starts there."), "{}", row.detail);
    }

    #[test]
    fn an_unloadable_directory_is_counted_with_its_reason() {
        let row = project_row(&project(1, 0, 0, 0, 2)).expect("a row");
        assert_eq!(row.unloadable, 2);
        assert!(row.detail.contains("2 directories are not loaded"), "{}", row.detail);
        // Deduplicated: two directories with the same cause say it once.
        assert_eq!(row.detail.matches("no description").count(), 1, "{}", row.detail);
    }

    /// A Mac on no team has no row at all — "0 team skills loaded" would read
    /// as a fault rather than as "you are not on a team".
    #[test]
    fn no_team_means_no_row() {
        let report = build_report_for_test(&env(Some("/c"), Some("1.5.0"), Some("/git")), None);
        assert!(report.team_skills.is_none());
    }

    #[test]
    fn the_headline_number_counts_only_skills_both_clis_load() {
        let row = report_with(&library(3, 0, 0, 0));
        assert_eq!(row.loaded, 3);
        assert_eq!((row.claude_only, row.codex_only, row.refused), (0, 0, 0));
        assert!(
            row.detail.starts_with("3 team skills loaded"),
            "{}",
            row.detail
        );
    }

    /// The count is of skills, not of library entries: a skill only one CLI
    /// loads is not "loaded", because half the team's sessions lack it.
    #[test]
    fn a_one_sided_skill_is_named_rather_than_counted_as_loaded() {
        let row = report_with(&library(1, 2, 1, 0));
        assert_eq!(row.loaded, 1);
        assert_eq!(row.claude_only, 2);
        assert_eq!(row.codex_only, 1);
        assert!(
            row.detail.contains("2 Claude only, 1 Codex only"),
            "{}",
            row.detail
        );
    }

    #[test]
    fn refused_plugins_are_reported_with_their_reason() {
        let row = report_with(&library(1, 0, 0, 1));
        assert_eq!(row.refused, 1);
        assert!(row.detail.contains("1 plugin not loaded"), "{}", row.detail);
        assert!(row.detail.contains("it carries hooks"), "{}", row.detail);
        // A refusal costs only the refused plugin.
        assert_eq!(row.loaded, 1);
    }

    #[test]
    fn a_single_skill_reads_as_singular() {
        let row = report_with(&library(1, 0, 0, 0));
        assert!(
            row.detail.starts_with("1 team skill loaded"),
            "{}",
            row.detail
        );
    }

    /// An empty library on a team Mac is a real state (nothing shared yet)
    /// and reads as zero, not as an error.
    #[test]
    fn an_empty_library_on_a_team_mac_still_reports_a_row() {
        let row = report_with(&library(0, 0, 0, 0));
        assert_eq!(row.loaded, 0);
        assert!(
            row.detail.starts_with("0 team skills loaded"),
            "{}",
            row.detail
        );
    }

    /// A library can be in perfect order and still load into nothing. The row
    /// is about what a session gets, so a blocked vendor means zero — and it
    /// says which sessions still get the skills, and why the others do not.
    #[test]
    fn a_blocked_codex_means_nothing_reaches_every_session() {
        let status = row(
            &library(3, 1, 0, 0),
            Some("Codex home is missing: /Users/x/.codex"),
        );
        assert_eq!(status.loaded, 0);
        assert_eq!(
            status.blocked.as_deref(),
            Some("Codex home is missing: /Users/x/.codex")
        );
        assert!(
            status.detail.starts_with("0 team skills loaded"),
            "{}",
            status.detail
        );
        // The four the Claude half still carries are not silently written off.
        assert!(
            status
                .detail
                .contains("4 skills reach Claude sessions, but Codex sessions get none"),
            "{}",
            status.detail
        );
        assert!(status.detail.contains("Codex home is missing"), "{}", status.detail);
    }

    #[test]
    fn nothing_is_blocked_when_the_overlay_can_be_built() {
        let status = row(&library(2, 0, 0, 0), None);
        assert_eq!(status.loaded, 2);
        assert!(status.blocked.is_none());
        assert!(!status.detail.contains("Codex sessions get none"));
    }

    /// A half of the library that could not be read at all is logged at
    /// launch and would otherwise never be seen.
    #[test]
    fn library_read_errors_reach_the_row() {
        let mut broken = library(1, 0, 0, 0);
        broken
            .errors
            .push("library/codex marketplace is not valid JSON".into());
        let status = row(&broken, None);
        assert!(
            status.detail.contains("library/codex marketplace is not valid JSON"),
            "{}",
            status.detail
        );
    }

    #[test]
    fn probe_error_passes_through() {
        let mut e = env(Some("/c"), Some("1.5.0"), Some("/git"));
        e.probe_error = Some("login shell broke".into());
        assert_eq!(
            build_report_for_test(&e, None).probe_error.as_deref(),
            Some("login shell broke")
        );
    }
}
