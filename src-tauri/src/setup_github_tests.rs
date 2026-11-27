//! OB-7a Tier 3: the GitHub step's reads, pure — accounts from gh's JSON
//! (several, a refused one, none, not JSON, a token never kept), git's
//! credential helper decision, the SSO refusal and its URL.

use super::*;

const TWO_ACCOUNTS: &str = r#"{"hosts":{"github.com":[
  {"state":"success","active":true,"host":"github.com","login":"test-owner","tokenSource":"keyring","token":"gho_SECRET0000000000000000000000000000","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"},
  {"state":"success","active":false,"host":"github.com","login":"mb-work","tokenSource":"keyring","token":"gho_OTHER0000000000000000000000000000","scopes":"gist, repo","gitProtocol":"https"}
]}}"#;

#[test]
fn every_github_account_is_listed_with_its_state_and_scopes() {
    let list = parse_accounts(TWO_ACCOUNTS).unwrap();
    assert_eq!(
        list,
        vec![
            GithubAccount {
                login: "test-owner".into(),
                active: true,
                state: AccountState::SignedIn,
                scopes: Some("gist, read:org, repo, workflow".into()),
            },
            GithubAccount {
                login: "mb-work".into(),
                active: false,
                state: AccountState::SignedIn,
                scopes: Some("gist, repo".into()),
            },
        ]
    );
}

#[test]
fn a_token_in_gh_output_never_reaches_the_answer() {
    let status = GithubStatus {
        gh_found: true,
        accounts: parse_accounts(TWO_ACCOUNTS),
        helper: HelperState::Gh,
        github_email: None,
        github_noreply: None,
        sso: None,
        gcm: Some(GcmSignIn { state: GcmState::Other, login: Some("octo-cat".into()) }),
    };
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains(r#""gcm":{"state":"other","login":"octo-cat"}"#), "{json}");
    assert!(!json.contains("gho_"), "{json}");
    assert!(!json.to_ascii_lowercase().contains("token"), "{json}");
}

#[test]
fn a_refused_token_and_an_unreachable_check_are_told_apart() {
    let out = r#"{"hosts":{"github.com":[
      {"state":"error","active":true,"login":"a","error":"HTTP 401: Bad credentials (https://api.github.com/)"},
      {"state":"error","active":false,"login":"b","error":"dial tcp: lookup api.github.com: no such host"},
      {"state":"timeout","active":false,"login":"c"}
    ]}}"#;
    let states: Vec<_> = parse_accounts(out).unwrap().into_iter().map(|a| a.state).collect();
    assert_eq!(states, vec![AccountState::Refused, AccountState::Unknown, AccountState::Unknown]);
}

#[test]
fn no_account_other_hosts_and_unreadable_output() {
    assert_eq!(parse_accounts(r#"{"hosts":{}}"#), Some(vec![]));
    // An Enterprise host is outside Setup: github.com has no account.
    assert_eq!(
        parse_accounts(r#"{"hosts":{"ghe.acme.com":[{"state":"success","active":true,"login":"m"}]}}"#),
        Some(vec![])
    );
    assert_eq!(parse_accounts("You are not logged into any GitHub hosts."), None);
    assert_eq!(parse_accounts(""), None);
    // A trailing line after the JSON is fine; a login that isn't one is dropped.
    let odd = "{\"hosts\":{\"github.com\":[{\"state\":\"success\",\"active\":true,\"login\":\"$(rm -rf)\"},{\"state\":\"success\",\"login\":\"ok\"}]}}\nwarning";
    assert_eq!(parse_accounts(odd).unwrap().iter().map(|a| a.login.as_str()).collect::<Vec<_>>(), vec!["ok"]);
}

#[test]
fn git_asks_gh_after_setup_git() {
    // CLT's system osxkeychain, then what `gh auth setup-git` writes.
    let out = "credential.helper osxkeychain\ncredential.https://github.com.helper \ncredential.https://github.com.helper !/opt/homebrew/bin/gh auth git-credential\n";
    assert_eq!(helper_state(out, false), HelperState::Gh);
    let win = "credential.helper manager\ncredential.https://github.com.helper \ncredential.https://github.com.helper !\"C:\\Program Files\\GitHub CLI\\gh.exe\" auth git-credential\n";
    assert_eq!(helper_state(win, true), HelperState::Gh);
}

#[test]
fn another_helper_or_none_offers_setup_git() {
    assert_eq!(helper_state("credential.helper osxkeychain\n", false), HelperState::Other);
    assert_eq!(helper_state("credential.helper osxkeychain\ncredential.helper store\n", false), HelperState::Other);
    assert_eq!(helper_state("", false), HelperState::None);
    // An empty value clears what came before, as git does.
    assert_eq!(helper_state("credential.helper osxkeychain\ncredential.helper \n", false), HelperState::None);
    // Another host's helper is not github.com's.
    assert_eq!(
        helper_state("credential.https://dev.azure.com.helper !gh auth git-credential\n", false),
        HelperState::None
    );
    assert_eq!(helper_state("credential.https://gist.github.com.helper !gh auth git-credential\n", false), HelperState::None);
}

#[test]
fn git_credential_manager_counts_only_on_windows() {
    for gcm in ["manager", "manager-core", "\"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe\""] {
        let out = format!("credential.helper {gcm}\n");
        assert_eq!(helper_state(&out, true), HelperState::Gcm, "{gcm}");
        assert_eq!(helper_state(&out, false), HelperState::Other, "{gcm}");
    }
    // A Windows line ending and a bare key (no value) read the same.
    assert_eq!(helper_state("credential.helper manager\r\n", true), HelperState::Gcm);
    assert_eq!(helper_state("credential.helper manager\ncredential.helper\n", true), HelperState::None);
}

#[test]
fn a_saml_refusal_names_the_organisation_from_its_sso_url() {
    let words = "gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (HTTP 403)\nAuthorize in your web browser: https://github.com/orgs/acme/sso?authorization_request=AAAA";
    assert_eq!(sso_need(words), Some(SsoNeed { org: Some("acme".into()) }));
    assert_eq!(
        sso_need("Resource protected by organization SAML enforcement."),
        Some(SsoNeed { org: None })
    );
    assert_eq!(sso_need("HTTP 401: Bad credentials"), None);
    // Not an SSO URL, or not a login: no organisation.
    assert_eq!(sso_need("see https://github.com/orgs/acme/people"), None);
    assert_eq!(sso_need("SAML https://github.com/orgs/a;b/sso"), Some(SsoNeed { org: None }));
}

#[test]
fn the_sso_page_is_built_from_a_valid_login_only() {
    assert_eq!(sso_url("acme").as_deref(), Some("https://github.com/orgs/acme/sso"));
    for bad in ["", "-acme", "a/b", "acme?x=1", "https://evil.example", "a b", "a--b"] {
        assert_eq!(sso_url(bad), None, "{bad:?}");
    }
}

#[test]
fn github_addresses_are_the_public_email_and_the_private_one() {
    let user = crate::setup_identity::GhUser {
        id: 1234567,
        login: "matteo".into(),
        name: None,
        email: Some(" m@example.com ".into()),
    };
    assert_eq!(
        github_addresses(&user),
        (Some("m@example.com".into()), "1234567+matteo@users.noreply.github.com".into())
    );
    let private = crate::setup_identity::GhUser { email: None, ..user };
    assert_eq!(github_addresses(&private).0, None);
}

#[test]
fn an_empty_subsection_never_panics() {
    // `[credential ""] helper = x` reads back as `credential..helper`.
    assert_eq!(helper_state("credential..helper osxkeychain\n", false), HelperState::None);
    assert_eq!(helper_state("credential..helper\ncredential.helper store\n", false), HelperState::Other);
    assert_eq!(helper_state("credential.helper\n", false), HelperState::None);
    assert_eq!(helper_state("credential.x\n", false), HelperState::None);
}

// ── N14 item 7: Git Credential Manager's github.com sign-in ─────────────

#[test]
fn only_the_username_is_read_and_the_answer_is_overwritten() {
    let mut answer = b"protocol=https\nhost=github.com\nusername=octo-cat\npassword=gho_SECRET\n".to_vec();
    assert_eq!(credential_username(&mut answer).as_deref(), Some("octo-cat"));
    assert!(answer.iter().all(|b| *b == 0), "the password is gone from memory");
    let mut crlf = b"username=octo-cat\r\npassword=x\r\n".to_vec();
    assert_eq!(credential_username(&mut crlf).as_deref(), Some("octo-cat"));
    let mut none = b"protocol=https\nhost=github.com\n".to_vec();
    assert_eq!(credential_username(&mut none), None);
    let mut empty = b"username=\npassword=x\n".to_vec();
    assert_eq!(credential_username(&mut empty), None);
}

#[test]
fn gcms_account_is_compared_with_the_account_setup_uses() {
    let found = GcmProbe::Found("Octo-Cat".into());
    assert_eq!(gcm_sign_in(&found, Some("octo-cat")).state, GcmState::Same);
    let other = gcm_sign_in(&found, Some("mb-work"));
    assert_eq!(other.state, GcmState::Other);
    assert_eq!(other.login.as_deref(), Some("Octo-Cat"));
    assert_eq!(gcm_sign_in(&found, None).state, GcmState::Unknown);
    // A username that isn't a GitHub login (a token's placeholder) is not named.
    let odd = gcm_sign_in(&GcmProbe::Found("not a login".into()), Some("mb-work"));
    assert_eq!((odd.state, odd.login), (GcmState::Other, None));
    assert_eq!(gcm_sign_in(&GcmProbe::Missing, Some("x")).state, GcmState::None);
    assert_eq!(gcm_sign_in(&GcmProbe::Unknown, Some("x")).state, GcmState::Unknown);
}

#[test]
fn the_probe_never_lets_git_or_gcm_ask() {
    let command = gcm_probe_command(crate::platform::new_command("probe"));
    let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(args, ["-c", "credential.interactive=never", "-c", "core.askPass=", "credential", "fill"]);
    let envs: Vec<(String, Option<String>)> = command
        .get_envs()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
        .collect();
    for expected in [
        ("GIT_TERMINAL_PROMPT".to_string(), Some("0".to_string())),
        ("GCM_INTERACTIVE".to_string(), Some("never".to_string())),
        ("GIT_ASKPASS".to_string(), None),
        ("SSH_ASKPASS".to_string(), None),
    ] {
        assert!(envs.contains(&expected), "{expected:?} in {envs:?}");
    }
    assert_eq!(GCM_PROBE_INPUT, b"protocol=https\nhost=github.com\n\n");
}

/// A fake git standing in for `git credential fill` with GCM behind it.
#[cfg(unix)]
fn fake_git(dir: &std::path::Path, body: &str) -> std::process::Command {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("git");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    crate::platform::new_command(path)
}

#[test]
#[cfg(unix)]
fn the_probe_reads_gcms_username_from_a_fake_git() {
    let dir = tempfile::tempdir().unwrap();
    let asked = dir.path().join("asked");
    // It answers only when asked the right question, in the right way.
    let body = format!(
        "cat > '{asked}'\n\
         [ \"$GCM_INTERACTIVE\" = never ] && [ \"$GIT_TERMINAL_PROMPT\" = 0 ] || exit 3\n\
         [ \"$5 $6\" = 'credential fill' ] || exit 4\n\
         printf 'protocol=https\\nhost=github.com\\nusername=octo-cat\\npassword=gho_SECRET\\n'",
        asked = asked.display()
    );
    let probe = probe_gcm_with(gcm_probe_command(fake_git(dir.path(), &body)), Duration::from_secs(10));
    assert_eq!(probe, GcmProbe::Found("octo-cat".into()));
    assert_eq!(std::fs::read(&asked).unwrap(), GCM_PROBE_INPUT);
}

#[test]
#[cfg(unix)]
fn no_saved_sign_in_is_missing_and_a_hang_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    // What git prints when GCM may not ask and has nothing saved.
    let missing = "cat >/dev/null\necho 'fatal: could not read Username for https://github.com: terminal prompts disabled' >&2\nexit 128";
    let probe = probe_gcm_with(gcm_probe_command(fake_git(dir.path(), missing)), Duration::from_secs(10));
    assert_eq!(probe, GcmProbe::Missing);

    // Any other failure is not "nothing saved".
    let broken = "cat >/dev/null\necho 'fatal: bad config line 3' >&2\nexit 128";
    let probe = probe_gcm_with(gcm_probe_command(fake_git(dir.path(), broken)), Duration::from_secs(10));
    assert_eq!(probe, GcmProbe::Unknown);
    assert!(no_credential("fatal: Cannot prompt because user interactivity has been disabled."));
    assert!(!no_credential("fatal: Authentication failed for 'https://github.com/'"));

    let hangs = "sleep 30";
    let started = std::time::Instant::now();
    let probe = probe_gcm_with(gcm_probe_command(fake_git(dir.path(), hangs)), Duration::from_millis(300));
    assert_eq!(probe, GcmProbe::Unknown);
    assert!(started.elapsed() < Duration::from_secs(5), "bounded");
}
