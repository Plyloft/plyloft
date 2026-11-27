//! GH #99 — a Challenger review that fails for the provider's reasons.
//!
//! Found on card #91 (v1.132.0): the second review died in 22 s with
//! "Selected model is at capacity. Please try a different model.", the card
//! shipped anyway, and PR #97 went out with its last commit never reviewed
//! while nothing on the way said so.
//!
//! Decided with the owner on 2026-09-17: retry once, then say it plainly;
//! never block the work. A failure that passes with time (capacity, rate
//! limits, a 5xx, the network, a timeout before any output) is run again
//! by itself, once, after `RETRY_DELAY_SECS`. A failure waiting cannot cure
//! (an unknown model, not signed in, a refused flag — the #74 messages) is
//! never retried.
//!
//! Everything here is pure; `reviewer.rs` owns the provider runs and the
//! waiting.

/// How long Ply waits before the one automatic retry.
pub const RETRY_DELAY_SECS: u64 = 30;
/// Automatic retries per review — across all its passes.
pub const RETRIES_PER_REVIEW: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFailure {
    // Passes with time: retried once.
    AtCapacity,
    RateLimited,
    ServerError,
    Network,
    /// The run hit its timeout without writing anything.
    TimedOutSilent,
    // Waiting cannot cure these: never retried.
    UnknownModel,
    NotSignedIn,
    UsageLimit,
    /// The CLI refused its arguments (a bad flag, a usage error).
    RefusedInvocation,
    /// The run timed out after it had started writing.
    TimedOut,
    NoReviewer,
    Other,
}

impl ProviderFailure {
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::AtCapacity
                | Self::RateLimited
                | Self::ServerError
                | Self::Network
                | Self::TimedOutSilent
        )
    }

    /// The reason in words, for the card and the PR body.
    pub fn reason(self) -> &'static str {
        match self {
            Self::AtCapacity => "The Reviewer's model was at capacity.",
            Self::RateLimited => "The Reviewer's provider was limiting requests.",
            Self::ServerError => "The Reviewer's provider had a server error.",
            Self::Network => "The Reviewer could not reach its provider.",
            Self::TimedOutSilent => "The Reviewer timed out before writing anything.",
            Self::UnknownModel => {
                "The Reviewer's model is not available. Check its name in Settings."
            }
            Self::NotSignedIn => "The Reviewer's CLI is not signed in.",
            Self::UsageLimit => "The Reviewer's plan reached its usage limit.",
            Self::RefusedInvocation => "The Reviewer's CLI refused how Plyloft started it.",
            Self::TimedOut => "The Reviewer timed out.",
            Self::NoReviewer => concat!("No Reviewer was available on ", crate::this_machine!(), "."),
            Self::Other => "The Reviewer could not finish the review.",
        }
    }
}

/// Classify a failed review or pass from its failure text (the record's
/// error, which carries the provider's own sentence since #74), its exit
/// code, whether it timed out, and whether it wrote any output at all.
///
/// Unrecognised failures are `Other` and are not retried: only a failure
/// known to pass with time earns the automatic retry.
pub fn classify(
    text: &str,
    exit_code: Option<i32>,
    timed_out: bool,
    produced_output: bool,
) -> ProviderFailure {
    let t = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| t.contains(needle));

    if has(&["no eligible reviewer"]) {
        return ProviderFailure::NoReviewer;
    }
    // Permanent refusals first: their wording never overlaps the transient
    // ones below ("try a different model" is not "model not supported").
    if has(&[
        "model is not supported",
        "issue with the selected model",
        "model not found",
        "model_not_found",
        "unknown model",
        "invalid model",
        "model does not exist",
        "does not exist or you do not have access",
    ]) {
        return ProviderFailure::UnknownModel;
    }
    if has(&[
        "not logged in",
        "please run /login",
        "run `codex login`",
        "codex login",
        "invalid api key",
        "authentication_error",
        "authentication failed",
        "unauthorized",
        "oauth token has expired",
        "token expired",
    ]) || has_status(&t, 401)
    {
        return ProviderFailure::NotSignedIn;
    }
    if has(&["usage limit", "hit your limit", "quota exceeded", "insufficient_quota"]) {
        return ProviderFailure::UsageLimit;
    }
    if has(&[
        "unknown option",
        "unexpected argument",
        "unrecognized option",
        "unrecognized argument",
        "invalid value for",
        "usage:",
    ]) {
        return ProviderFailure::RefusedInvocation;
    }

    if has(&["at capacity", "overloaded", "capacity exceeded"]) || has_status(&t, 529) {
        return ProviderFailure::AtCapacity;
    }
    if has(&["rate limit", "rate_limit", "ratelimit", "too many requests"]) || has_status(&t, 429)
    {
        return ProviderFailure::RateLimited;
    }
    if has(&[
        "internal server error",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "api_error",
        "server_error",
        "server error",
    ]) || [500, 502, 503, 504].iter().any(|code| has_status(&t, *code))
    {
        return ProviderFailure::ServerError;
    }
    if has(&[
        "network error",
        "error sending request",
        "stream disconnected",
        "connection reset",
        "connection refused",
        "connection closed",
        "connection error",
        "econnreset",
        "econnrefused",
        "etimedout",
        "enotfound",
        "eai_again",
        "socket hang up",
        "fetch failed",
        "could not resolve host",
        "dns error",
        "network is unreachable",
    ]) {
        return ProviderFailure::Network;
    }
    if timed_out {
        return if produced_output {
            ProviderFailure::TimedOut
        } else {
            ProviderFailure::TimedOutSilent
        };
    }
    // clap (Codex) exits 2 on a usage error, often with nothing Ply could
    // extract from the output.
    if exit_code == Some(2) {
        return ProviderFailure::RefusedInvocation;
    }
    ProviderFailure::Other
}

/// `code` appears in `text` as a number of its own ("status 429", "API
/// Error: 529 {…}"), not inside a longer one (a sha, a port, a byte count).
fn has_status(text: &str, code: u16) -> bool {
    let needle = code.to_string();
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(found) = text[from..].find(&needle) {
        let start = from + found;
        let end = start + needle.len();
        let before = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before && after {
            return true;
        }
        from = end;
    }
    false
}

/// Run `attempt`; when its result is a retryable provider failure, the
/// review still has a retry and `may_retry` agrees (the review tree is
/// still the pinned revision), call `wait` (which tells the card and
/// sleeps) and run it again — once. Returns the last result and the failure
/// that was retried, if any. `budget` is shared by every pass of one review.
pub fn with_retry<R>(
    budget: &mut u32,
    mut attempt: impl FnMut() -> R,
    failure_of: impl Fn(&R) -> Option<ProviderFailure>,
    mut may_retry: impl FnMut(&R) -> bool,
    mut wait: impl FnMut(ProviderFailure, &R),
) -> (R, Option<ProviderFailure>) {
    let first = attempt();
    let Some(failure) = failure_of(&first).filter(|failure| failure.retryable()) else {
        return (first, None);
    };
    if *budget == 0 || !may_retry(&first) {
        return (first, None);
    }
    *budget -= 1;
    wait(failure, &first);
    (attempt(), Some(failure))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ProviderFailure::*;

    /// The failure texts as the review record carries them.
    #[test]
    fn provider_failures_that_pass_with_time_are_retried() {
        let cases: &[(&str, Option<i32>, bool, bool, ProviderFailure)] = &[
            // Real: card #91, 2026-09-17 (Codex Challenger, 22 s).
            (
                "Reviewer exited with status 1: Selected model is at capacity. Please try a different model..",
                Some(1),
                false,
                true,
                AtCapacity,
            ),
            // Anthropic API overload as Claude Code reports it.
            (
                r#"Reviewer exited with status 1: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
                Some(1),
                false,
                true,
                AtCapacity,
            ),
            (
                r#"Reviewer exited with status 1: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}"#,
                Some(1),
                false,
                true,
                RateLimited,
            ),
            (
                "Pass 2 of 3 exited with status 1: exceeded retry limit, last status: 429 Too Many Requests",
                Some(1),
                false,
                true,
                RateLimited,
            ),
            (
                r#"Reviewer exited with status 1: API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}"#,
                Some(1),
                false,
                true,
                ServerError,
            ),
            (
                "Reviewer exited with status 1: unexpected status 503 Service Unavailable",
                Some(1),
                false,
                true,
                ServerError,
            ),
            (
                "Reviewer exited with status 1: stream error: error sending request for url (https://chatgpt.com/backend-api/codex/responses); retrying 5/5",
                Some(1),
                false,
                true,
                Network,
            ),
            (
                "Reviewer exited with status 1: API Error: Connection error. (cause: fetch failed)",
                Some(1),
                false,
                true,
                Network,
            ),
            ("Reviewer timed out after 10 minutes", None, true, false, TimedOutSilent),
        ];
        for (text, code, timed_out, output, expected) in cases {
            let got = classify(text, *code, *timed_out, *output);
            assert_eq!(got, *expected, "{text}");
            assert!(got.retryable(), "{text}");
        }
        assert_eq!(AtCapacity.reason(), "The Reviewer's model was at capacity.");
    }

    #[test]
    fn failures_waiting_cannot_cure_are_never_retried() {
        let cases: &[(&str, Option<i32>, bool, bool, ProviderFailure)] = &[
            // Real #74 refusals, 2026-09-16.
            (
                "Reviewer exited with status 1: The 'ply-bogus-model' model is not supported when using Codex with a ChatGPT account.",
                Some(1),
                false,
                true,
                UnknownModel,
            ),
            (
                "Reviewer exited with status 1: There's an issue with the selected model (ply-bogus-model). It may not exist or you may not have access to it.",
                Some(1),
                false,
                true,
                UnknownModel,
            ),
            (
                "Reviewer exited with status 1: Invalid API key · Please run /login",
                Some(1),
                false,
                true,
                NotSignedIn,
            ),
            (
                "Reviewer exited with status 1: Not logged in. Run `codex login` first.",
                Some(1),
                false,
                true,
                NotSignedIn,
            ),
            (
                "Reviewer exited with status 2: error: unexpected argument '--bogus' found",
                Some(2),
                false,
                true,
                RefusedInvocation,
            ),
            (
                "Reviewer exited with status 1: error: unknown option '--bogus'",
                Some(1),
                false,
                true,
                RefusedInvocation,
            ),
            ("Reviewer exited with status 2", Some(2), false, false, RefusedInvocation),
            (
                "Reviewer exited with status 1: Claude AI usage limit reached|1758000000",
                Some(1),
                false,
                true,
                UsageLimit,
            ),
            (
                "No eligible reviewer: codex is not installed",
                None,
                false,
                false,
                NoReviewer,
            ),
            ("Reviewer timed out after 10 minutes", None, true, true, TimedOut),
            ("Reviewer exited with status 1", Some(1), false, false, Other),
            ("Reviewer returned no final message", Some(0), false, true, Other),
        ];
        for (text, code, timed_out, output, expected) in cases {
            let got = classify(text, *code, *timed_out, *output);
            assert_eq!(got, *expected, "{text}");
            assert!(!got.retryable(), "{text}");
        }
    }

    #[test]
    fn a_status_code_counts_only_as_a_number_of_its_own() {
        assert!(has_status("api error: 529 {", 529));
        assert!(has_status("status 429", 429));
        assert!(!has_status("commit 45290ab", 529));
        assert!(!has_status("read 15003 bytes", 500));
        // A sha fragment is not a server error.
        assert_eq!(
            classify("Reviewer exited with status 1: at a1500b", Some(1), false, true),
            Other
        );
    }

    #[test]
    fn one_retry_and_no_more() {
        let mut budget = RETRIES_PER_REVIEW;
        let mut calls = 0;
        let mut waits = Vec::new();
        let (result, retried) = with_retry(
            &mut budget,
            || {
                calls += 1;
                "at capacity"
            },
            |text| Some(classify(text, Some(1), false, true)),
            |_| true,
            |failure, _| waits.push(failure),
        );
        assert_eq!((calls, result, retried), (2, "at capacity", Some(AtCapacity)));
        assert_eq!(waits, vec![AtCapacity]);
        assert_eq!(budget, 0);

        // The budget is the review's: a later failure is not retried.
        let (_, retried) = with_retry(
            &mut budget,
            || {
                calls += 1;
                "overloaded"
            },
            |text| Some(classify(text, Some(1), false, true)),
            |_| true,
            |failure, _| waits.push(failure),
        );
        assert_eq!((calls, retried), (3, None));
        assert_eq!(waits.len(), 1);
    }

    /// Review 5: a first attempt that changed the review tree is never run
    /// again on that tree.
    #[test]
    fn no_retry_when_the_guard_refuses() {
        let mut budget = RETRIES_PER_REVIEW;
        let mut calls = 0;
        let (_, retried) = with_retry(
            &mut budget,
            || {
                calls += 1;
                "at capacity"
            },
            |text| Some(classify(text, Some(1), false, true)),
            |_| false,
            |_, _| panic!("never waits"),
        );
        assert_eq!((calls, retried, budget), (1, None, 1));
    }

    #[test]
    fn a_permanent_failure_or_a_success_runs_once() {
        let mut budget = RETRIES_PER_REVIEW;
        let mut calls = 0;
        let (_, retried) = with_retry(
            &mut budget,
            || {
                calls += 1;
                "The 'x' model is not supported"
            },
            |text| Some(classify(text, Some(1), false, true)),
            |_| true,
            |_, _| panic!("never waits"),
        );
        assert_eq!((calls, retried, budget), (1, None, 1));

        let (_, retried) = with_retry(
            &mut budget,
            || {
                calls += 1;
                "approved"
            },
            |_| None,
            |_| true,
            |_, _| panic!("never waits"),
        );
        assert_eq!((calls, retried, budget), (2, None, 1));
    }
}
