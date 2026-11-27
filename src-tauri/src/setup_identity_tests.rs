//! OB-6 Tier 3: the identity write on a real git with a temporary global
//! config (`GIT_CONFIG_GLOBAL`, `HOME`, no system config) — never the
//! owner's — and the prefill order as a pure function.

use super::*;
use std::path::{Path, PathBuf};

/// A `git` whose global config is `<dir>/gitconfig`, run in `dir`.
fn git_in(dir: &Path) -> impl Fn() -> Command {
    let dir: PathBuf = dir.to_path_buf();
    move || {
        // `git` from the test process PATH, through the same constructor
        // production uses (never the CLT shim guard's concern here).
        let mut c = crate::platform::git_command_for(crate::shell_env::GitProgram::Bare);
        c.current_dir(&dir)
            .env("GIT_CONFIG_GLOBAL", dir.join("gitconfig"))
            .env("HOME", &dir)
            .env("XDG_CONFIG_HOME", &dir)
            .env("GIT_CONFIG_NOSYSTEM", "1");
        c
    }
}

fn file_in(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("gitconfig")).unwrap_or_default()
}

#[test]
fn only_the_x_at_y_shape_is_checked() {
    for good in ["a@b", "m@example.com", "1234567+matteo@users.noreply.github.com", "  a@b  "] {
        assert!(is_valid_email(good), "{good}");
    }
    for bad in ["", "ab", "@b", "a@", "a@b@c", "a b@c", "a@b\nc", "a@\tb"] {
        assert!(!is_valid_email(bad), "{bad:?}");
        assert_eq!(clean_email(bad), Err(INVALID_EMAIL.to_string()));
    }
    assert_eq!(clean_name("   "), Err(EMPTY_NAME.to_string()));
    assert_eq!(clean_name("  Matteo  ").unwrap(), "Matteo");
}

#[test]
fn a_value_is_one_argv_element_as_given() {
    let hostile = "Matteo \"M\" $(touch pwned) `id`; rm -rf ~\nsecond line";
    assert_eq!(
        write_args(IdentityKey::Name, hostile),
        vec!["config", "--global", "user.name", hostile]
    );
    assert_eq!(write_args(IdentityKey::Email, "a@b")[2], "user.email");
}

#[test]
fn hostile_names_are_written_literally_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    for name in [
        "Matteo \"The Builder\" O'Brien",
        "$(touch pwned) `touch pwned2` ${HOME}",
        "first line\nsecond line",
        "-n --file=/tmp/elsewhere",
        "Zoë Ångström 李",
    ] {
        let written = write_identity(&git, name, "m@example.com").unwrap();
        assert_eq!(written.name, name.trim());
        assert_eq!(written.email, "m@example.com");
        assert_eq!(read_key(&git, IdentityKey::Name).unwrap().as_deref(), Some(name));
    }
    // Nothing was interpreted: no file was made by a `$()` or backticks.
    assert!(!dir.path().join("pwned").exists());
    assert!(!dir.path().join("pwned2").exists());
    // It went to the temporary global file, and only there.
    let text = file_in(dir.path());
    assert!(text.contains("[user]"), "{text}");
    assert!(text.contains("m@example.com"), "{text}");
}

#[test]
fn an_invalid_email_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    assert_eq!(
        write_identity(&git, "Matteo", "not an email"),
        Err(INVALID_EMAIL.to_string())
    );
    assert_eq!(write_identity(&git, "  ", "m@example.com"), Err(EMPTY_NAME.to_string()));
    assert!(!dir.path().join("gitconfig").exists(), "nothing was written");
    assert_eq!(read_key(&git, IdentityKey::Email).unwrap(), None);
}

#[test]
fn the_values_are_read_back_after_the_write() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    assert_eq!(read_key(&git, IdentityKey::Name).unwrap(), None);
    write_identity(&git, "Old", "old@example.com").unwrap();
    let written = write_identity(&git, "New Name", "new@example.com").unwrap();
    assert_eq!(
        written,
        IdentityWritten { name: "New Name".into(), email: "new@example.com".into() }
    );
    assert_eq!(read_key(&git, IdentityKey::Email).unwrap().as_deref(), Some("new@example.com"));
    // One value per key: a write replaces, never adds a second.
    assert_eq!(file_in(dir.path()).matches("email").count(), 1);
}

#[test]
fn a_write_git_refuses_is_an_error_not_a_success() {
    let dir = tempfile::tempdir().unwrap();
    // A global config path git can't write (a directory).
    std::fs::create_dir(dir.path().join("gitconfig")).unwrap();
    let git = git_in(dir.path());
    let err = write_identity(&git, "Matteo", "m@example.com").unwrap_err();
    assert!(err.starts_with("Git didn't save your name"), "{err}");
}

// ── Prefill ────────────────────────────────────────────────────────────

fn gh(name: Option<&str>, email: Option<&str>) -> GhUser {
    GhUser {
        id: 1234567,
        login: "matteo".into(),
        name: name.map(String::from),
        email: email.map(String::from),
    }
}

#[test]
fn the_global_config_comes_first() {
    let p = prefill(
        (Some("Git Name"), Some("git@example.com")),
        Some(&gh(Some("GH Name"), Some("gh@example.com"))),
        Some("System Name"),
    );
    assert_eq!((p.name.as_str(), p.name_source), ("Git Name", PrefillSource::Git));
    assert_eq!((p.email.as_str(), p.email_source), ("git@example.com", PrefillSource::Git));
    assert_eq!(p.github_noreply, None);
}

#[test]
fn then_github_then_the_system() {
    let p = prefill((None, None), Some(&gh(Some("GH Name"), Some("gh@example.com"))), Some("Sys"));
    assert_eq!((p.name.as_str(), p.name_source), ("GH Name", PrefillSource::Github));
    assert_eq!((p.email.as_str(), p.email_source), ("gh@example.com", PrefillSource::Github));
    assert_eq!(p.github_login.as_deref(), Some("matteo"));

    // GitHub has no name: the system's.
    let p = prefill((None, None), Some(&gh(None, Some("gh@example.com"))), Some("Sys Name"));
    assert_eq!((p.name.as_str(), p.name_source), ("Sys Name", PrefillSource::System));

    // Per field: the config's name, GitHub's email.
    let p = prefill((Some("Git Name"), Some("  ")), Some(&gh(Some("GH"), Some("gh@example.com"))), None);
    assert_eq!(p.name_source, PrefillSource::Git);
    assert_eq!(p.email_source, PrefillSource::Github);

    // Nothing anywhere: empty, and the system never offers an email.
    let p = prefill((None, None), None, Some("Sys Name"));
    assert_eq!((p.email.as_str(), p.email_source), ("", PrefillSource::None));
    let p = prefill((None, None), None, None);
    assert_eq!((p.name.as_str(), p.name_source), ("", PrefillSource::None));
}

#[test]
fn a_private_github_email_offers_the_noreply_address() {
    let p = prefill((Some("Git Name"), None), Some(&gh(Some("GH"), None)), None);
    assert_eq!(p.email, "1234567+matteo@users.noreply.github.com");
    assert_eq!(p.email_source, PrefillSource::Github);
    assert_eq!(p.github_noreply.as_deref(), Some("1234567+matteo@users.noreply.github.com"));
    assert!(is_valid_email(&p.email));
    assert_eq!(noreply_address(9, "a-b"), "9+a-b@users.noreply.github.com");
}

#[test]
fn gh_api_user_is_read_for_its_four_fields() {
    let json = r#"{"login":"matteo","id":1234567,"node_id":"x","name":null,"email":null,"company":null}"#;
    assert_eq!(parse_gh_user(json), Some(gh(None, None)));
    let json = r#"{"login":"matteo","id":1234567,"name":"Matteo B","email":"m@example.com"}"#;
    assert_eq!(parse_gh_user(json), Some(gh(Some("Matteo B"), Some("m@example.com"))));
    assert_eq!(parse_gh_user("To get started with GitHub CLI, please run:  gh auth login"), None);
    assert_eq!(parse_gh_user(r#"{"login":"","id":1}"#), None);
}

// ── OB-6 review ────────────────────────────────────────────────────────

#[test]
fn an_included_identity_is_read_and_a_write_goes_to_the_global_file_only() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    let inc = dir.path().join("identity.inc");
    std::fs::write(&inc, "[user]\n\tname = Included Name\n\temail = inc@example.com\n").unwrap();
    std::fs::write(
        dir.path().join("gitconfig"),
        format!("[include]\n\tpath = {}\n", inc.display().to_string().replace('\\', "/")),
    )
    .unwrap();
    // Seen through the include (P3-3), not in the global file itself.
    assert_eq!(read_key(&git, IdentityKey::Name).unwrap().as_deref(), Some("Included Name"));
    assert_eq!(read_key_in(&git, IdentityKey::Name, false).unwrap(), None);
    // The write lands after the include in the global file, and wins.
    let w = write_identity(&git, "Mine", "mine@example.com").unwrap();
    assert_eq!(w.name, "Mine");
    // The included file is never edited.
    assert!(std::fs::read_to_string(&inc).unwrap().contains("Included Name"));
}

#[test]
fn an_include_that_overrides_the_write_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    let inc = dir.path().join("late.inc");
    std::fs::write(&inc, "[user]\n\tname = Late Name\n").unwrap();
    // The include comes after [user], so its value wins.
    std::fs::write(
        dir.path().join("gitconfig"),
        format!(
            "[user]\n\tname = Old\n[include]\n\tpath = {}\n",
            inc.display().to_string().replace('\\', "/")
        ),
    )
    .unwrap();
    let err = write_identity(&git, "Mine", "m@example.com").unwrap_err();
    assert!(err.contains("includes sets other values"), "{err}");
}

#[test]
fn several_values_are_refused_in_words_and_a_partial_write_says_the_name_changed() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    std::fs::write(
        dir.path().join("gitconfig"),
        "[user]\n\tname = Old\n\temail = a@example.com\n\temail = b@example.com\n",
    )
    .unwrap();
    let err = write_identity(&git, "New", "c@example.com").unwrap_err();
    assert!(err.starts_with("Git saved your name, but not your email:"), "{err}");
    assert!(err.contains("more than one email"), "{err}");
    assert_eq!(read_key(&git, IdentityKey::Name).unwrap().as_deref(), Some("New"));
    // Nothing deleted unasked.
    assert!(file_in(dir.path()).contains("b@example.com"));
}

#[test]
fn a_value_already_there_is_not_written_again() {
    let dir = tempfile::tempdir().unwrap();
    let git = git_in(dir.path());
    write_identity(&git, "Same", "same@example.com").unwrap();
    let before = std::fs::metadata(dir.path().join("gitconfig")).unwrap().modified().unwrap();
    let text = file_in(dir.path());
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_identity(&git, "Same", "same@example.com").unwrap();
    assert_eq!(file_in(dir.path()), text);
    assert_eq!(std::fs::metadata(dir.path().join("gitconfig")).unwrap().modified().unwrap(), before);
}
