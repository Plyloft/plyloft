//! 1.176.1: the Program folders reading, Mac and Windows forms, on a fake disk.

use super::*;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Fake {
    dirs: HashSet<String>,
    /// (dir, name) → file.
    programs: HashMap<(String, String), String>,
    windows: bool,
}

impl Fake {
    fn mac() -> Self {
        let mut f = Fake::default();
        for d in ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/Users/ada/.local/bin", "/Users/ada"] {
            f.dirs.insert(d.into());
        }
        f.put("/Users/ada/.local/bin", "claude");
        f.put("/Users/ada/.local/bin", "codex");
        f.put("/usr/bin", "git");
        f.put("/usr/bin", "curl");
        f.put("/bin", "bash");
        f.put("/bin", "sh");
        f.put("/opt/homebrew/bin", "gh");
        f
    }

    fn windows() -> Self {
        let mut f = Fake { windows: true, ..Fake::default() };
        for d in [r"C:\Windows\System32", r"C:\Windows", r"C:\Program Files\Git\cmd", r"C:\Users\Ada\.local\bin", r"C:\Users\Ada\AppData\Roaming\npm"] {
            f.dirs.insert(d.to_ascii_lowercase());
        }
        f.put(r"C:\Users\Ada\.local\bin", "claude.exe");
        f.put(r"C:\Users\Ada\AppData\Roaming\npm", "codex.cmd");
        f.put(r"C:\Program Files\Git\cmd", "git.exe");
        f
    }

    fn put(&mut self, dir: &str, file: &str) {
        let key = if self.windows { dir.to_ascii_lowercase() } else { dir.to_string() };
        let name = file.split('.').next().unwrap().to_string();
        let sep = if self.windows { '\\' } else { '/' };
        self.programs.insert((key, name), format!("{dir}{sep}{file}"));
    }

    fn key(&self, p: &str) -> String {
        if self.windows {
            p.trim_end_matches('\\').to_ascii_lowercase()
        } else {
            p.trim_end_matches('/').to_string()
        }
    }
}

impl Disk for Fake {
    fn kind(&self, path: &str) -> PathKind {
        let k = self.key(path);
        if self.dirs.contains(&k) {
            return PathKind::Dir;
        }
        if self.programs.values().any(|f| self.key(f) == k) {
            return PathKind::File;
        }
        PathKind::Absent
    }

    fn program(&self, dir: &str, name: &str) -> Option<String> {
        self.programs.get(&(self.key(dir), name.to_string())).cloned()
    }
}

const SHELL: &str = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/ada/.local/bin";

fn mac() -> Ctx {
    Ctx {
        windows: false,
        home: Some("/Users/ada".into()),
        shell_path: Some(SHELL.into()),
        vars: vec![("USER".into(), "ada".into())],
        system_root: None,
    }
}

fn win() -> Ctx {
    Ctx {
        windows: true,
        home: Some(r"C:\Users\Ada".into()),
        shell_path: Some(r"C:\Windows\System32;C:\Windows;C:\Program Files\Git\cmd".into()),
        vars: vec![("LOCALAPPDATA".into(), r"C:\Users\Ada\AppData\Local".into()), ("APPDATA".into(), r"C:\Users\Ada\AppData\Roaming".into())],
        system_root: Some(r"C:\Windows".into()),
    }
}

/// The owner's exact value (2026-11-21): a program, written with `~`.
#[test]
fn the_owners_value_names_a_file_written_with_a_tilde_and_is_never_saved_as_is() {
    let v = read_list("~/.local/bin/claude", &mac(), &Fake::mac());
    assert_eq!(v.problems, vec![Problem::NamesAFile, Problem::Tilde]);
    assert!(v.malformed());
    let e = &v.entries[0];
    assert!(e.tilde);
    assert_eq!(e.path.as_deref(), Some("/Users/ada/.local/bin/claude"));
    assert_eq!(e.state, EntryState::File { folder: "/Users/ada/.local/bin".into() });
    // Taken literally, as tiles get it, it finds nothing at all.
    assert!(v.found.is_empty(), "{:?}", v.found);
    assert_eq!(v.missing, vec!["claude", "codex", "git", "gh"]);
    assert_eq!(v.basics_missing, vec!["curl", "bash", "sh"]);
    assert_eq!(v.system_folders_missing, vec!["/usr/bin", "/bin"]);
    assert_eq!(v.save_as, None, "a file is never saved as is");
    assert_eq!(v.use_folders.as_deref(), Some("/Users/ada/.local/bin"));
    // Its folder alone still leaves the system folders out: that save waits
    // for a confirmation, and offers the shell's folders after it.
    let next = read_list(v.use_folders.as_deref().unwrap(), &mac(), &Fake::mac());
    assert!(next.problems.is_empty());
    assert!(next.finds("claude") && next.finds("codex") && !next.finds("git"));
    assert!(next.needs_confirmation);
    assert_eq!(next.with_shell.as_deref(), Some("/Users/ada/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
}

#[test]
fn a_leading_tilde_is_expanded_on_save_and_empty_entries_dropped() {
    let v = read_list("~/.local/bin::/opt/homebrew/bin:/usr/bin:/bin:", &mac(), &Fake::mac());
    assert_eq!(v.problems, vec![Problem::Tilde, Problem::Untidy], "the empty entries are said on a saved value");
    assert_eq!(v.save_as.as_deref(), Some("/Users/ada/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"));
    // Literally the tilde finds nothing; the saved form does.
    assert!(!v.finds("claude"));
    let saved = read_list(v.save_as.as_deref().unwrap(), &mac(), &Fake::mac());
    assert!(saved.problems.is_empty() && !saved.needs_confirmation, "{saved:?}");
    assert!(TOOLS.iter().all(|t| saved.finds(t)));
}

#[test]
fn a_path_variable_is_not_expanded_silently_but_offered_written_out() {
    let v = read_list("$PATH:/x", &mac(), &Fake::mac());
    assert_eq!(v.problems, vec![Problem::Variable]);
    assert_eq!(v.save_as, None);
    assert_eq!(v.entries[0].state, EntryState::ShellFolders);
    assert_eq!(v.entries[1].state, EntryState::Missing);
    assert!(v.path_variable_first);
    assert_eq!(v.expanded.as_deref(), Some(&format!("{SHELL}:/x")[..]));
    let front = read_list("/x:${PATH}", &mac(), &Fake::mac());
    assert!(!front.path_variable_first);
    assert_eq!(front.expanded.as_deref(), Some(&format!("/x:{SHELL}")[..]));
    // $HOME is written out from the home; an unknown variable blocks.
    let home = read_list("$HOME/.local/bin:/usr/bin:/bin", &mac(), &Fake::mac());
    assert_eq!(home.expanded.as_deref(), Some("/Users/ada/.local/bin:/usr/bin:/bin"));
    let unknown = read_list("$NOPE/bin", &mac(), &Fake::mac());
    assert_eq!(unknown.entries[0].state, EntryState::UnknownVariable { name: "NOPE".into() });
    assert_eq!((unknown.save_as.clone(), unknown.expanded.clone()), (None, None));
    // No shell answer yet: $PATH can't be written out.
    let none = read_list("$PATH:/x", &Ctx { shell_path: None, ..mac() }, &Fake::mac());
    assert_eq!(none.expanded, None);
}

#[test]
fn relative_and_another_accounts_home_block_the_save() {
    let v = read_list("bin:/usr/bin", &mac(), &Fake::mac());
    assert_eq!(v.problems, vec![Problem::Relative]);
    assert_eq!(v.entries[0].state, EntryState::Relative);
    assert_eq!(v.save_as, None);
    let other = read_list("~bob/bin", &mac(), &Fake::mac());
    assert_eq!(other.problems, vec![Problem::OtherHome]);
    assert_eq!(other.save_as, None);
}

#[test]
fn a_good_list_saves_as_is_without_a_question_and_a_missing_folder_is_named() {
    let v = read_list(SHELL, &mac(), &Fake::mac());
    assert!(v.problems.is_empty() && !v.needs_confirmation);
    assert_eq!(v.save_as.as_deref(), Some(SHELL));
    assert!(v.missing.is_empty() && v.basics_missing.is_empty() && v.system_folders_missing.is_empty());
    let gone = read_list(&format!("/opt/new/bin:{SHELL}"), &mac(), &Fake::mac());
    assert_eq!(gone.entries[0].state, EntryState::Missing);
    assert!(gone.problems.is_empty() && gone.save_as.is_some() && !gone.needs_confirmation);
}

#[test]
fn a_list_that_finds_none_of_the_tools_waits_for_a_confirmation() {
    let v = read_list("/opt/homebrew/bin", &Ctx { shell_path: None, ..mac() }, &Fake::mac());
    assert!(v.finds("gh") && v.needs_confirmation);
    assert_eq!(v.with_shell, None, "no shell answer: nothing to add");
    let empty = read_list("", &mac(), &Fake::mac());
    assert_eq!(empty.save_as.as_deref(), Some(""));
    assert!(!empty.needs_confirmation, "emptying it is always fine");
}

#[test]
fn the_windows_forms() {
    let fake = Fake::windows();
    let good = read_list(r"C:\Users\Ada\.local\bin;C:\Windows\System32;C:\Program Files\Git\cmd", &win(), &fake);
    assert!(good.problems.is_empty() && !good.needs_confirmation, "{good:?}");
    assert!(good.finds("claude") && good.finds("git") && !good.finds("gh"));
    assert!(good.basics_missing.is_empty(), "the Mac's basics aren't asked on Windows");
    // A program named, quoted, and %VAR% forms.
    let file = read_list(r#""C:\Users\Ada\.local\bin\claude.exe";C:\Windows\System32"#, &win(), &fake);
    assert_eq!(file.problems, vec![Problem::NamesAFile]);
    assert_eq!(file.use_folders.as_deref(), Some(r"C:\Users\Ada\.local\bin;C:\Windows\System32"));
    let vars = read_list(r"%APPDATA%\npm;%PATH%", &win(), &fake);
    assert_eq!(vars.problems, vec![Problem::Variable]);
    assert_eq!(vars.entries[1].state, EntryState::ShellFolders);
    assert_eq!(
        vars.expanded.as_deref(),
        Some(r"C:\Users\Ada\AppData\Roaming\npm;C:\Windows\System32;C:\Windows;C:\Program Files\Git\cmd")
    );
    let profile = read_list(r"%USERPROFILE%\.local\bin", &win(), &fake);
    assert_eq!(profile.entries[0].path.as_deref(), Some(r"C:\Users\Ada\.local\bin"));
    let tilde = read_list(r"~\.local\bin", &win(), &fake);
    assert_eq!(tilde.save_as.as_deref(), Some(r"C:\Users\Ada\.local\bin"));
    assert_eq!(tilde.system_folders_missing, Vec::<String>::new().into_iter().chain([r"C:\Windows\System32".to_string()]).collect::<Vec<_>>());
    let relative = read_list(r"tools\bin;C:\Windows\System32", &win(), &fake);
    assert_eq!(relative.problems, vec![Problem::Relative]);
}

#[test]
fn the_steps_path_appends_the_system_folders_after_the_persons_never_before() {
    assert_eq!(with_system_dirs("~/.local/bin/claude", false, None), "~/.local/bin/claude:/usr/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(with_system_dirs(SHELL, false, None), SHELL, "nothing to add: unchanged");
    assert_eq!(with_system_dirs("/x:/bin", false, None), "/x:/bin:/usr/bin:/usr/sbin:/sbin", "order kept, no duplicate");
    assert_eq!(with_system_dirs("", false, None), "/usr/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(
        with_system_dirs(r"C:\tools;c:\windows\system32", true, Some(r"C:\Windows")),
        r"C:\tools;c:\windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0"
    );
}

#[test]
fn a_folder_is_put_in_front_once() {
    assert_eq!(prepend("/opt/x:/usr/bin", "/Users/ada/.local/bin", false), "/Users/ada/.local/bin:/opt/x:/usr/bin");
    assert_eq!(prepend("/Users/ada/.local/bin:/usr/bin", "/Users/ada/.local/bin", false), "/Users/ada/.local/bin:/usr/bin");
    assert_eq!(prepend(r"C:\x", r"C:\Users\Ada\.local\bin", true), r"C:\Users\Ada\.local\bin;C:\x");
}

#[test]
fn a_runs_env_keeps_its_own_path_first_and_gets_the_system_folders_after() {
    let snapshot = "~/.local/bin/claude";
    let env = steps_env(vec![("HTTPS_PROXY".into(), "http://p".into())], snapshot, false, None);
    assert_eq!(env.last().unwrap(), &("PATH".to_string(), "~/.local/bin/claude:/usr/bin:/bin:/usr/sbin:/sbin".to_string()));
    assert_eq!(env.len(), 2, "the proxy stays");
    // The plan's own PATH (the installer's folder added) is the one kept.
    let planned = steps_env(vec![("PATH".into(), "/a:/Users/ada/.local/bin".into())], snapshot, false, None);
    assert_eq!(planned, vec![("PATH".to_string(), "/a:/Users/ada/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string())]);
    let win = steps_env(vec![("Path".into(), r"C:\x".into())], "", true, Some(r"D:\Win"));
    assert_eq!(win.len(), 1);
    assert!(win[0].1.starts_with(r"C:\x;D:\Win\System32;D:\Win;"), "{win:?}");
}

/// Review 1: only the command steps get the system folders after their PATH.
#[test]
fn only_the_command_steps_get_the_system_folders() {
    use crate::setup_actions::ActionId;
    for a in [ActionId::InstallClaude, ActionId::UpdateCodex, ActionId::RepairInstallClaude, ActionId::RepairNpmRemoveCodex, ActionId::RepairChownClaude, ActionId::InstallGh, ActionId::InstallGit] {
        assert!(crate::setup_run::adds_system_dirs(a), "{a:?}");
    }
    for a in [ActionId::LoginClaude, ActionId::StatusClaude, ActionId::TrustClaude] {
        assert!(!crate::setup_run::adds_system_dirs(a), "{a:?}");
    }
}

/// Review 1: a saved value read exactly as tiles receive it.
#[test]
fn spaces_trailing_separators_and_duplicates_are_untidy_and_tidied_on_save() {
    let v = read_list("/usr/bin: /opt/homebrew/bin:/bin:/usr/bin:", &mac(), &Fake::mac());
    assert_eq!(v.problems, vec![Problem::Untidy]);
    assert!(!v.finds("gh"), "tiles get ` /opt/homebrew/bin`, a relative folder: gh isn't found");
    assert_eq!(v.save_as.as_deref(), Some("/usr/bin:/opt/homebrew/bin:/bin"), "Tidy it: trimmed, once each, no empty entry");
    let tidy = read_list(v.save_as.as_deref().unwrap(), &mac(), &Fake::mac());
    assert!(tidy.problems.is_empty() && tidy.finds("gh"));
    // Windows: quotes around an entry are Windows' own and stay fine.
    let w = read_list(r#""C:\Program Files\Git\cmd";C:\Windows\System32"#, &win(), &Fake::windows());
    assert!(!w.problems.contains(&Problem::Untidy), "{:?}", w.problems);
}

/// Review 1: `$` in a real folder's name; `:` inside a Mac folder name.
#[test]
fn a_dollar_in_a_real_folder_is_a_folder_and_a_colon_in_a_name_is_said() {
    let mut fake = Fake::mac();
    fake.dirs.insert("/opt/$tools/bin".into());
    fake.dirs.insert("/Volumes/My:Disk/bin".into());
    let v = read_list("/opt/$tools/bin:/usr/bin:/bin", &mac(), &fake);
    assert_eq!(v.entries[0].state, EntryState::Folder);
    assert!(v.problems.is_empty() && v.save_as.is_some());
    let c = read_list("/Volumes/My:Disk/bin:/usr/bin", &mac(), &fake);
    assert_eq!(c.entries[1].state, EntryState::ColonInName { folder: "/Volumes/My:Disk/bin".into() });
    assert!(c.problems.contains(&Problem::ColonInName) && !c.problems.contains(&Problem::Relative));
    assert_eq!(c.save_as, None);
}

/// Review 1: when the shell already reports every folder the value adds,
/// emptying is the better fix (the reading says so).
#[test]
fn the_reading_says_when_the_shell_already_reports_the_folders() {
    let owners = read_list("~/.local/bin/claude", &mac(), &Fake::mac());
    assert!(owners.shell_has_them, "~/.local/bin is in the shell's list");
    let other = read_list("/opt/elsewhere/bin", &mac(), &Fake::mac());
    assert!(!other.shell_has_them);
    let unknown = read_list("~/.local/bin/claude", &Ctx { shell_path: None, ..mac() }, &Fake::mac());
    assert!(!unknown.shell_has_them);
}

#[test]
fn a_folder_is_added_at_the_end_once() {
    assert_eq!(append("/opt/x:/usr/bin", "/Users/ada/.local/bin", false), "/opt/x:/usr/bin:/Users/ada/.local/bin");
    assert_eq!(append("/Users/ada/.local/bin:/usr/bin", "/Users/ada/.local/bin", false), "/Users/ada/.local/bin:/usr/bin");
    assert_eq!(append(r"C:\x;", r"C:\y", true), r"C:\x;C:\y");
}
