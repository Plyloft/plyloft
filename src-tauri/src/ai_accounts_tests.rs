//! 1.179.0 (C1): Claude accounts — ids, folders, names, rows and the
//! signed-in read, on a temporary app config folder. Nothing here calls
//! [`init`]: the folder is passed to the `_in` functions, so no test leaves a
//! global behind for another.

use super::*;
use crate::settings::{AiAccountEntry, ClaudeAccountsSettings};

fn entry(id: &str, name: &str) -> AiAccountEntry {
    AiAccountEntry {
        id: id.into(),
        name: name.into(),
        added_at: "2026-11-27T10:00:00.000Z".into(),
        extra: serde_json::Map::new(),
    }
}

fn accounts(list: &[(&str, &str)]) -> ClaudeAccountsSettings {
    ClaudeAccountsSettings {
        accounts: list.iter().map(|(id, name)| entry(id, name)).collect(),
        ..ClaudeAccountsSettings::default()
    }
}

#[test]
fn ids_are_short_url_safe_and_never_one_in_use() {
    for _ in 0..50 {
        let id = new_id(|_| false);
        assert_eq!(id.len(), 8);
        assert!(valid_id(&id), "{id}");
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{id}");
    }
    // An id in use is never given again: the first three draws are taken.
    let draws = std::cell::Cell::new(0);
    let id = new_id(|_| {
        draws.set(draws.get() + 1);
        draws.get() <= 3
    });
    assert_eq!(draws.get(), 4);
    assert!(valid_id(&id));
    for bad in ["", "A1B2C3D4", "a1b2c3d4 ", "../x", "a/b", "a\\b", "a.b", "é"] {
        assert!(!valid_id(bad), "{bad:?}");
    }
    assert!(!valid_id(&"a".repeat(33)));
    assert!(valid_id(&"a".repeat(32)));
}

#[test]
fn main_is_todays_folder_and_an_account_is_its_own() {
    let config = tempfile::tempdir().unwrap();
    assert_eq!(claude_dir_in(config.path(), None), crate::claude_session::claude_config_dir());
    assert_eq!(
        claude_dir_in(config.path(), Some("a1b2c3d4")),
        Some(config.path().join("ai-accounts").join("claude").join("a1b2c3d4"))
    );
    for bad in ["", "..", "../x", "A1B2C3D4", "/tmp/x"] {
        assert_eq!(claude_dir_in(config.path(), Some(bad)), None, "{bad:?}");
    }
}

/// Main's sessions get nothing new; another account's get its folder in
/// `CLAUDE_CONFIG_DIR`, spelled exactly as its folder is (the text the CLI
/// hashes for its keychain item).
#[test]
fn only_an_account_session_gets_claude_config_dir() {
    let config = tempfile::tempdir().unwrap();
    assert_eq!(spawn_env(None), Some(Vec::new()));
    assert_eq!(spawn_env_in(config.path(), None), Some(Vec::new()));
    let dir = claude_dir_in(config.path(), Some("a1b2c3d4")).unwrap();
    assert_eq!(
        spawn_env_in(config.path(), Some("a1b2c3d4")),
        Some(vec![("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().into_owned())])
    );
    assert_eq!(spawn_env_in(config.path(), Some("../x")), None, "never Main in its place");
}

#[test]
fn a_folder_is_made_once_and_only_for_an_id() {
    let config = tempfile::tempdir().unwrap();
    let dir = create_folder_in(config.path(), "a1b2c3d4").unwrap();
    assert_eq!(dir, claude_accounts_root(config.path()).join("a1b2c3d4"));
    assert!(dir.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }
    assert_eq!(
        create_folder_in(config.path(), "a1b2c3d4").unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists,
        "an existing folder is never taken over"
    );
    assert!(create_folder_in(config.path(), "../escape").is_err());
    assert!(!config.path().join("escape").exists());
}

/// Removal follows no link: a link inside the folder goes as a link, the
/// folder it points to stays; a folder that is itself a link goes as a link.
#[cfg(unix)]
#[test]
fn removing_a_folder_never_follows_a_link() {
    let config = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep.txt"), b"keep").unwrap();

    let dir = create_folder_in(config.path(), "a1b2c3d4").unwrap();
    std::fs::create_dir_all(dir.join("projects").join("p")).unwrap();
    std::fs::write(dir.join("projects").join("p").join("s.jsonl"), b"{}").unwrap();
    std::fs::write(dir.join("settings.json"), b"{}").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.join("skills")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.join("projects").join("linked")).unwrap();
    remove_folder_in(config.path(), "a1b2c3d4").unwrap();
    assert!(!dir.exists());
    assert!(outside.path().join("keep.txt").exists(), "what a link pointed to stays");
    // Already gone is fine.
    remove_folder_in(config.path(), "a1b2c3d4").unwrap();

    let root = claude_accounts_root(config.path());
    std::os::unix::fs::symlink(outside.path(), root.join("b1b2c3d4")).unwrap();
    remove_folder_in(config.path(), "b1b2c3d4").unwrap();
    assert!(std::fs::symlink_metadata(root.join("b1b2c3d4")).is_err());
    assert!(outside.path().join("keep.txt").exists());

    assert!(remove_folder_in(config.path(), "../x").is_err());
}

/// An accounts folder that is a link is refused for making and removing:
/// what is made or deleted through it would be somewhere else.
#[cfg(unix)]
#[test]
fn an_accounts_folder_that_is_a_link_is_refused() {
    let config = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(outside.path().join("claude").join("a1b2c3d4")).unwrap();
    std::os::unix::fs::symlink(outside.path(), config.path().join("ai-accounts")).unwrap();
    assert!(create_folder_in(config.path(), "c1b2c3d4").is_err());
    assert!(remove_folder_in(config.path(), "a1b2c3d4").is_err());
    assert!(outside.path().join("claude").join("a1b2c3d4").is_dir());
}

#[test]
fn repair_protects_the_accounts_folders_and_each_account() {
    let config = tempfile::tempdir().unwrap();
    create_folder_in(config.path(), "a1b2c3d4").unwrap();
    create_folder_in(config.path(), "b1b2c3d4").unwrap();
    let mut dirs = protected_dirs_in(config.path());
    dirs.sort();
    let root = claude_accounts_root(config.path());
    let mut want = vec![
        config.path().join("ai-accounts"),
        root.clone(),
        root.join("a1b2c3d4"),
        root.join("b1b2c3d4"),
    ];
    want.sort();
    assert_eq!(dirs, want);
    // No accounts yet: the two folders are still protected.
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(protected_dirs_in(empty.path()).len(), 2);
}

#[test]
fn signed_in_says_yes_no_or_cant_tell() {
    use CredentialSeen::*;
    for main in [true, false] {
        assert_eq!(seen(Present, Absent, main), SignedIn::Yes);
        assert_eq!(seen(Absent, Present, main), SignedIn::Yes);
        assert_eq!(seen(Unreadable, Present, main), SignedIn::Yes);
        assert_eq!(seen(Unreadable, Absent, main), SignedIn::Unknown);
        assert_eq!(seen(Absent, Unreadable, main), SignedIn::Unknown);
    }
    // Nothing seen: an account folder Plyloft made is not signed in; Main
    // may be signed in another way (an API key), so Plyloft can't tell.
    assert_eq!(seen(Absent, Absent, false), SignedIn::No);
    assert_eq!(seen(Absent, Absent, true), SignedIn::Unknown);
    assert_eq!(serde_json::to_value(SignedIn::Unknown).unwrap(), "unknown");
}

/// The folder's own `.credentials.json`, by its presence alone (Windows, and
/// the macOS fallback). Main's login is never looked at for an account.
#[test]
fn an_accounts_login_file_is_found_in_its_own_folder() {
    let config = tempfile::tempdir().unwrap();
    let dir = create_folder_in(config.path(), "a1b2c3d4").unwrap();
    std::fs::write(dir.join(".credentials.json"), b"").unwrap();
    assert_eq!(signed_in_at(&dir), SignedIn::Yes);
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::remove_file(dir.join(".credentials.json")).unwrap();
        assert_eq!(signed_in_at(&dir), SignedIn::No);
    }
}

#[test]
fn names_are_trimmed_capped_unique_and_main_is_reserved() {
    let list = accounts(&[("a1b2c3d4", "Work")]);
    assert_eq!(clean_name("  Second \t Max\n"), "Second Max");
    assert_eq!(clean_name("Wo\u{7}rk"), "Wo rk");
    assert_eq!(check_name(&list, Target::New, "  Second   Max "), Ok("Second Max".into()));
    for empty in ["", "   ", "\n\t"] {
        assert_eq!(check_name(&list, Target::New, empty), Err(NAME_EMPTY.into()), "{empty:?}");
    }
    assert_eq!(check_name(&list, Target::New, &"x".repeat(41)), Err(NAME_TOO_LONG.into()));
    assert!(check_name(&list, Target::New, &"é".repeat(40)).is_ok(), "characters, not bytes");
    assert_eq!(
        check_name(&list, Target::New, "work"),
        Err("You already have an account named work.".into())
    );
    for main in ["Main", "main", " MAIN "] {
        assert_eq!(
            check_name(&list, Target::New, main),
            Err(name_taken(&clean_name(main))),
            "{main:?}"
        );
        assert!(check_name(&list, Target::Main, main).is_ok(), "Main keeps its own name");
    }
    // Renaming an account to its own name, another case: fine.
    assert_eq!(check_name(&list, Target::Account("a1b2c3d4"), "WORK"), Ok("WORK".into()));
    // Main can't take another account's name, nor an account Main's.
    assert!(check_name(&list, Target::Main, "Work").is_err());
    let renamed = ClaudeAccountsSettings { main_name: Some("Personal".into()), ..list.clone() };
    assert_eq!(main_name(&renamed), "Personal");
    assert!(check_name(&renamed, Target::New, "personal").is_err());
    assert!(check_name(&renamed, Target::Account("a1b2c3d4"), "Personal").is_err());
    assert!(check_name(&renamed, Target::New, "Main").is_err(), "Main stays reserved");
    assert_eq!(main_name(&ClaudeAccountsSettings::default()), "Main");
}

#[test]
fn rows_put_main_first_and_mark_where_new_sessions_start() {
    let config = tempfile::tempdir().unwrap();
    let mut list = accounts(&[("a1b2c3d4", "Work"), ("b1b2c3d4", "Second Max")]);
    let dir = |account: Option<&str>| match account {
        None => Some(std::path::PathBuf::from("/Users/someone/.claude")),
        Some(_) => claude_dir_in(config.path(), account),
    };
    let state = |account: Option<&str>| match account {
        None => SignedIn::Unknown,
        Some("a1b2c3d4") => SignedIn::Yes,
        Some(_) => SignedIn::No,
    };
    let rows = rows_with(&list, dir, state);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].id, None);
    assert_eq!(rows[0].name, "Main");
    assert!(rows[0].is_current, "no current: Main");
    assert_eq!(rows[0].folder.as_deref(), Some("/Users/someone/.claude"));
    assert_eq!(rows[1].id.as_deref(), Some("a1b2c3d4"));
    assert_eq!(rows[1].signed_in, SignedIn::Yes);
    assert_eq!(rows[2].signed_in, SignedIn::No);
    assert_eq!(
        rows[1].folder.as_deref().map(std::path::PathBuf::from),
        claude_dir_in(config.path(), Some("a1b2c3d4"))
    );

    list.current = Some("b1b2c3d4".into());
    let rows = rows_with(&list, dir, state);
    assert_eq!(rows.iter().filter(|r| r.is_current).count(), 1);
    assert!(rows[2].is_current);

    // A current account that isn't listed reads as Main.
    list.current = Some("ffffffff".into());
    let rows = rows_with(&list, dir, state);
    assert!(rows[0].is_current && !rows[1].is_current && !rows[2].is_current);

    let json = serde_json::to_value(&rows[1]).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "id": "a1b2c3d4",
            "name": "Work",
            "signedIn": "yes",
            "isCurrent": false,
            "folder": json["folder"].clone(),
        })
    );
    assert_eq!(serde_json::to_value(&rows[0]).unwrap()["id"], serde_json::Value::Null);
}

#[test]
fn the_approved_words_are_word_for_word() {
    assert_eq!(name_taken("Work"), "You already have an account named Work.");
    assert_eq!(sessions_running(2, "Work"), "Close 2 sessions running on Work first.");
    assert_eq!(sessions_running(1, "Work"), "Close 1 session running on Work first.");
}

/// Plyloft never reads a credential here and runs nothing: the signed-in
/// read is `claude_auth`'s attribute look.
#[test]
fn nothing_here_reads_a_secret_or_runs_a_program() {
    let source = include_str!("ai_accounts.rs");
    let code: String = source
        .lines()
        .take_while(|line| !line.starts_with("#[cfg(test)]"))
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["Command", "process::", "read_to_string", "fs::read(", "load_data", "reqwest"] {
        assert!(!code.contains(forbidden), "ai_accounts.rs must not use `{forbidden}`");
    }
}

// ── C2: every session's reader follows its account ─────────────────────

/// What reads Claude's one folder without asking which account: Main's
/// folder (`claude_session::claude_config_dir`) or the variable that moves
/// it. Each such read outside the files below would read Main's files for a
/// session on another account (a transcript not found, the wrong answer
/// pasted by Compare, the wrong trust or settings).
const SINGLE_FOLDER_READS: [&str; 3] = ["claude_config_dir()", "var(\"CLAUDE_CONFIG_DIR\")", "var_os(\"CLAUDE_CONFIG_DIR\")"];

/// The files allowed to read it, how many times, and why.
const SINGLE_FOLDER_ALLOWED: &[(&str, usize, &str)] = &[
    ("ai_accounts.rs", 2, "the accessor: Main's folder is `claude_dir(None)`"),
    ("claude_session.rs", 3, "defines Main's folder and Main's `.claude.json`; an account's go through `ai_accounts`"),
    ("claude_theme.rs", 1, "Main's own theme (`main_config_dir`); an account's is read from its folder"),
    ("cli_health.rs", 1, "Diagnostics and Repair inputs, Main's row (rows per account are card C7)"),
    ("doctor_reads.rs", 1, "Diagnostics' update channel, read from Main only"),
    ("claude_auth.rs", 1, "Main's signed-in check; an account's is `read_for_dir` on its folder"),
];

/// A file's code: its tests and comment lines left out.
fn code_of(source: &str) -> String {
    let end = ["\n#[cfg(test)]\nmod tests", "\n#[cfg(test)]\n#[path"]
        .iter()
        .filter_map(|marker| source.find(marker))
        .min()
        .unwrap_or(source.len());
    source[..end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs")
            && !path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with("_tests.rs"))
        {
            out.push(path);
        }
    }
}

/// 1.179.0 (C2): no new read of Claude's single folder appears outside
/// `ai_accounts` and the reasoned list above; a reader of a session's files
/// asks for the folder of the session's account
/// (`ai_accounts::claude_dir`, `recorded_claude_dir`, `CliHomes::claude_for`).
#[test]
fn no_reader_takes_claudes_single_folder_outside_the_allowed_list() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(files.len() > 100, "the crate's sources were found");
    for file in files {
        let code = code_of(&std::fs::read_to_string(&file).unwrap());
        let found: usize = SINGLE_FOLDER_READS.iter().map(|read| code.matches(read).count()).sum();
        let name = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        let allowed = SINGLE_FOLDER_ALLOWED.iter().find(|(allowed, _, _)| *allowed == name);
        match allowed {
            Some((_, most, why)) => assert!(
                found <= *most,
                "{name} reads Claude's single folder {found} times, past its {most} ({why}): ask for the session's account's folder"
            ),
            None => assert_eq!(found, 0, "{name} reads Claude's single folder: ask for the session's account's folder (`ai_accounts`)"),
        }
    }
}

// ── C2: which account a session runs on ────────────────────────────────

#[test]
fn a_new_session_takes_the_current_account_and_a_resume_its_recorded_one() {
    let mut list = accounts(&[("a1b2c3d4", "Work"), ("e5f6a7b8", "Second")]);
    assert_eq!(current_in(&list), None, "Main until one is chosen");
    list.current = Some("a1b2c3d4".into());
    assert_eq!(current_in(&list).as_deref(), Some("a1b2c3d4"));
    assert_eq!(chosen_in(&list, None).unwrap().as_deref(), Some("a1b2c3d4"), "absent: the current one");
    assert_eq!(chosen_in(&list, Some("e5f6a7b8")).unwrap().as_deref(), Some("e5f6a7b8"));
    assert_eq!(chosen_in(&list, Some("00000000")), Err(UNKNOWN_ACCOUNT.to_string()), "never Main in its place");
    // Started on Work; new sessions then switched to Main: Resume stays on Work.
    list.current = None;
    assert_eq!(for_resume_in(&list, Some("a1b2c3d4")).unwrap().as_deref(), Some("a1b2c3d4"));
    assert_eq!(for_resume_in(&list, None).unwrap(), None, "Main stays Main");
    // Work removed: its sessions are not resumed anywhere else.
    list.accounts.retain(|a| a.id != "a1b2c3d4");
    assert_eq!(for_resume_in(&list, Some("a1b2c3d4")), Err(ACCOUNT_REMOVED.to_string()));
    assert_eq!(ACCOUNT_REMOVED, "Its account was removed from Plyloft.");
    // A `current` naming no listed account reads as Main.
    list.current = Some("a1b2c3d4".into());
    assert_eq!(current_in(&list), None);
}

#[test]
fn a_recorded_accounts_folder_is_read_only_while_it_is_there() {
    let config = tempfile::tempdir().unwrap();
    test_root::set(Some(config.path().to_path_buf()));
    let dir = create_folder_in(config.path(), "a1b2c3d4").unwrap();
    assert_eq!(recorded_claude_dir(Some("a1b2c3d4")), Some(dir.clone()));
    assert!(!recorded_account_removed(Some("a1b2c3d4")));
    assert_eq!(recorded_claude_dir(None), crate::claude_session::claude_config_dir(), "Main");
    assert!(!recorded_account_removed(None), "Main is never removed");
    assert_eq!(account_dirs(), vec![(Some("a1b2c3d4".to_string()), dir)]);
    remove_folder_in(config.path(), "a1b2c3d4").unwrap();
    assert_eq!(recorded_claude_dir(Some("a1b2c3d4")), None, "never another folder in its place");
    assert!(recorded_account_removed(Some("a1b2c3d4")));
    assert!(account_dirs().is_empty());
    test_root::set(None);
}

/// Remove counts the sessions running on the account (`PtyRegistry`); an
/// empty registry has none.
#[test]
fn an_account_with_no_session_has_none_running() {
    let registry = crate::pty::PtyRegistry::default();
    assert_eq!(registry.sessions_on_account("a1b2c3d4"), 0);
}

// ── C3: Main by its id, and Start fresh on another account ─────────────

/// The new-session menu's `Claude on Main` while another account is current
/// asks for [`MAIN_ID`] and runs on Main as today (no `CLAUDE_CONFIG_DIR`);
/// absent is still the current one. Asking changes nothing about it.
#[test]
fn main_is_asked_for_by_its_id_while_another_account_is_current() {
    let config = tempfile::tempdir().unwrap();
    let mut list = accounts(&[("a1b2c3d4", "Work")]);
    list.current = Some("a1b2c3d4".into());
    let main = chosen_in(&list, Some(MAIN_ID));
    assert_eq!(main, Ok(None), "Main, not the current account");
    assert_eq!(spawn_env_in(config.path(), main.unwrap().as_deref()), Some(Vec::new()), "no variable for Main");
    assert_eq!(chosen_in(&list, None).unwrap().as_deref(), Some("a1b2c3d4"), "absent: the current one");
    // A resumed tile that names Main by that id stays on Main.
    assert_eq!(for_resume_in(&list, Some(MAIN_ID)), Ok(None));
    // No id Plyloft makes (8 hex characters) is Main's.
    assert!(!MAIN_ID.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(list.current.as_deref(), Some("a1b2c3d4"), "the current account is left as it was");
}

/// Start fresh on {name} (`builder_start`'s `account`, decided by
/// [`chosen_in`] in `builder::start`): the new Builder runs on the account
/// named, with its folder in `CLAUDE_CONFIG_DIR`; an id no account has is
/// refused; absent is today's Start fresh, on the current one. The spawn
/// itself needs an `AppHandle`, which no Builder start test has: this pins
/// the decision and the variable it gives.
#[test]
fn start_fresh_on_an_account_runs_there_and_an_unknown_one_is_refused() {
    let config = tempfile::tempdir().unwrap();
    let mut list = accounts(&[("a1b2c3d4", "Work"), ("e5f6a7b8", "Second")]);
    // The Builder stopped on Main, new sessions start on Main: on Work.
    let chosen = chosen_in(&list, Some("a1b2c3d4")).unwrap();
    assert_eq!(chosen.as_deref(), Some("a1b2c3d4"));
    let dir = claude_dir_in(config.path(), chosen.as_deref()).unwrap();
    assert_eq!(
        spawn_env_in(config.path(), chosen.as_deref()),
        Some(vec![(CONFIG_DIR_VAR.to_string(), dir.to_string_lossy().into_owned())])
    );
    assert_eq!(list.current, None, "nothing switches by itself");
    // The Builder stopped on Work, the current one: Main, by its id.
    list.current = Some("a1b2c3d4".into());
    assert_eq!(chosen_in(&list, Some(MAIN_ID)), Ok(None));
    // Unknown, or removed since the window read the list: refused.
    assert_eq!(chosen_in(&list, Some("00000000")), Err(UNKNOWN_ACCOUNT.to_string()));
    list.accounts.retain(|a| a.id != "e5f6a7b8");
    assert_eq!(chosen_in(&list, Some("e5f6a7b8")), Err(UNKNOWN_ACCOUNT.to_string()));
    // Absent: the current one, as Start fresh always started.
    assert_eq!(chosen_in(&list, None).unwrap().as_deref(), Some("a1b2c3d4"));
}
