//! The Reviewer's verdict comment on a card's pull request (v1.108.0 E4),
//! posted once per body.
//!
//! 1.176.3 (owner 2026-11-23, REV-F2 option B): before `gh pr comment`,
//! Plyloft reads the pull request's comments (`gh pr view --json comments`,
//! a read) and posts nothing when one already has the identical body — a
//! second Ship of the same reviewed commit no longer posts the same verdict
//! twice. A changed verdict is a different body and is posted. When the read
//! fails, or its answer can't be read, the comment is posted as before: a
//! duplicate is the lesser harm, a verdict nobody sees is the greater.
//! This only ever writes less than before, never more.

use std::process::Output;

/// Post `body` on `pr_url` through `gh` (a bounded `gh` in the card's copy)
/// unless the pull request already has a comment with that body. Best effort:
/// a failure is logged, never returned (agent-collab invariant #5).
pub(crate) fn post_once(pr_url: &str, body: &str, gh: impl Fn(&[&str]) -> Result<Output, String>) {
    if already_there(&gh(&["pr", "view", pr_url, "--json", "comments"]), body) {
        log::info!("builder: the PR has this verdict comment already; not posted again");
        return;
    }
    match gh(&["pr", "comment", pr_url, "--body", body]) {
        Ok(out) if out.status.success() => {}
        Ok(out) => log::warn!(
            "builder: PR verdict comment failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => log::warn!("builder: PR verdict comment failed: {e}"),
    }
}

/// Whether the read's answer holds a comment whose body is `body` — the same
/// text, allowing for GitHub's line endings and the whitespace at either
/// end. A failed or unreadable answer is `false` (the comment is posted).
fn already_there(read: &Result<Output, String>, body: &str) -> bool {
    let Ok(out) = read else { return false };
    if !out.status.success() {
        return false;
    }
    let Ok(view) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return false;
    };
    let same = |text: &str| text.replace("\r\n", "\n").trim() == body.replace("\r\n", "\n").trim();
    view.get("comments")
        .and_then(|c| c.as_array())
        .is_some_and(|comments| {
            comments
                .iter()
                .filter_map(|c| c.get("body").and_then(|b| b.as_str()))
                .any(same)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[cfg(unix)]
    fn status(code: i32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code << 8)
    }
    #[cfg(windows)]
    fn status(code: i32) -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code as u32)
    }

    fn answer(code: i32, stdout: &str) -> Result<Output, String> {
        Ok(Output { status: status(code), stdout: stdout.as_bytes().to_vec(), stderr: Vec::new() })
    }

    /// What `post_once` asked gh, given `view` as the answer to the read.
    fn calls(body: &str, view: Result<Output, String>) -> Vec<Vec<String>> {
        let seen = RefCell::new(Vec::new());
        let view = RefCell::new(Some(view));
        post_once("https://github.com/o/r/pull/7", body, |args| {
            seen.borrow_mut().push(args.iter().map(|a| a.to_string()).collect::<Vec<_>>());
            if args.first() == Some(&"pr") && args.get(1) == Some(&"view") {
                view.borrow_mut().take().unwrap()
            } else {
                answer(0, "")
            }
        });
        seen.into_inner()
    }

    fn posted(calls: &[Vec<String>]) -> usize {
        calls.iter().filter(|c| c.get(1).map(String::as_str) == Some("comment")).count()
    }

    fn comments(bodies: &[&str]) -> String {
        let list: Vec<_> = bodies.iter().map(|b| serde_json::json!({ "author": { "login": "m" }, "body": b })).collect();
        serde_json::json!({ "comments": list }).to_string()
    }

    const BODY: &str = "## Plyloft Reviewer — Codex\n\n**Verdict:** APPROVE on build snapshot 2\n";

    #[test]
    fn the_same_verdict_already_on_the_pull_request_is_not_posted_again() {
        // GitHub hands the body back without its last newline, `\r\n` maybe.
        let there = BODY.trim_end().replace('\n', "\r\n");
        let seen = calls(BODY, answer(0, &comments(&["LGTM", &there])));
        assert_eq!(posted(&seen), 0, "{seen:?}");
        assert_eq!(seen.len(), 1, "one read, no write: {seen:?}");
        assert_eq!(seen[0], ["pr", "view", "https://github.com/o/r/pull/7", "--json", "comments"]);
    }

    #[test]
    fn a_different_verdict_or_none_yet_is_posted() {
        let older = BODY.replace("snapshot 2", "snapshot 1");
        let seen = calls(BODY, answer(0, &comments(&["LGTM", &older])));
        assert_eq!(posted(&seen), 1, "{seen:?}");
        assert_eq!(calls(BODY, answer(0, &comments(&[]))).len(), 2);
        // A comment that only quotes the verdict is not the verdict.
        let quoted = format!("> {}", BODY.trim_end());
        assert_eq!(posted(&calls(BODY, answer(0, &comments(&[&quoted])))), 1);
        let last = calls(BODY, answer(0, &comments(&[])));
        assert_eq!(last[1], ["pr", "comment", "https://github.com/o/r/pull/7", "--body", BODY]);
    }

    /// A read that fails or can't be read: posted, as before 1.176.3.
    #[test]
    fn a_failed_read_still_posts_the_verdict() {
        assert_eq!(posted(&calls(BODY, Err("gh timed out".into()))), 1);
        assert_eq!(posted(&calls(BODY, answer(1, ""))), 1);
        assert_eq!(posted(&calls(BODY, answer(0, "not json"))), 1);
    }
}
