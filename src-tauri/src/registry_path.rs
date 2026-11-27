//! 1.176.2 R1 (A1-03): on Windows, the PATH a new terminal would get, read
//! again from the registry at each probe (startup, *Look again*, the
//! re-probe after Setup's install), so a tool installed since Plyloft started
//! is found without a relaunch. A running process's own environment never
//! changes after launch; installers write the registry instead.
//!
//! Additive only: the process PATH is kept exactly as it is, in its order,
//! and each folder of the machine `Path` then the user `Path` it doesn't have
//! is appended — as the known installer folders are (`shell_env::augment_path`).
//! When nothing was installed since launch the PATH is byte-for-byte the
//! process's. The pure part is tested on every platform with Windows-shaped
//! strings; only [`current`] reads the registry, and only on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

/// Pure: `%NAME%` expanded through `lookup`, as Windows'
/// `ExpandEnvironmentStrings` does: an unknown name, an empty one (`%%`), or
/// a `%` without its closing one, stays exactly as written.
pub fn expand_vars(text: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('%') {
            // `%%` is an empty name, never found: kept as written like any
            // unknown one, and the scan goes on after its closing `%`.
            Some(close) => {
                let name = &after[..close];
                match (!name.is_empty()).then(|| lookup(name)).flatten() {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Windows' limit for one environment variable's value, in UTF-16 units
/// (32,767 with its closing NUL).
pub const MAX_PATH_VALUE: usize = 32_766;

/// Pure: two Windows PATH entries name the same folder — case-insensitive,
/// regardless of surrounding quotes or a trailing separator.
fn same_windows_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_string();
    norm(a).eq_ignore_ascii_case(&norm(b))
}

/// Pure: a PATH entry that names a folder by an absolute path — a drive
/// letter (`C:\…`, `C:/…`) or a UNC share (`\\server\…`), quotes aside.
/// A relative one (`.`, `bin`, `C:bin`, `\bin`, an unexpanded `%X%\bin`)
/// would be searched from each child's working folder.
fn absolute_windows_dir(entry: &str) -> bool {
    let e = entry.trim().trim_matches('"');
    let b = e.as_bytes();
    e.starts_with(r"\\")
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
}

/// Pure: `process` (the PATH Plyloft was started with) with every folder of
/// `machine` then `user` (the registry's raw `Path` values) that it doesn't
/// already have appended, each expanded through `lookup`. `;`-separated, as
/// on Windows. Nothing new: `process` unchanged.
///
/// REV-R1: an entry is split again after its expansion (a variable can hold a
/// `;` list) and each piece de-duplicated; `%PATH%` is never expanded (an
/// installer's or `setx`'s self-reference would append the PATH to itself);
/// only absolute folders are added; and appending stops before the value
/// would pass [`MAX_PATH_VALUE`], the launch PATH always kept whole.
pub fn merged_path(
    process: &str,
    machine: Option<&str>,
    user: Option<&str>,
    lookup: impl Fn(&str) -> Option<String>,
) -> String {
    let mut have: Vec<String> = process
        .split(';')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .collect();
    let lookup = |name: &str| if name.eq_ignore_ascii_case("PATH") { None } else { lookup(name) };
    let mut out = process.to_string();
    let mut units = out.encode_utf16().count();
    for raw in [machine, user].into_iter().flatten() {
        for entry in raw.split(';').map(str::trim).filter(|e| !e.is_empty()) {
            let expanded = expand_vars(entry, &lookup);
            for piece in expanded.split(';').map(str::trim) {
                if piece.is_empty()
                    || !absolute_windows_dir(piece)
                    || have.iter().any(|h| same_windows_dir(h, piece))
                {
                    continue;
                }
                let sep = usize::from(!out.is_empty() && !out.ends_with(';'));
                let needed = sep + piece.encode_utf16().count();
                if units + needed > MAX_PATH_VALUE {
                    log::warn!(
                        "shell_env: the registry's PATH folders from {piece} on are not added: \
                         the PATH would pass Windows' {MAX_PATH_VALUE}-character limit"
                    );
                    return out;
                }
                if sep == 1 {
                    out.push(';');
                }
                out.push_str(piece);
                units += needed;
                have.push(piece.to_string());
            }
        }
    }
    out
}

/// Pure, 1.176.3: the PATH for one of Plyloft's own `gh` children — `base`
/// (the PATH that child would get anyway) with the folder of `program` (the
/// probed git) appended, so the `git` gh launches by its bare name is found
/// after a Git installed while Plyloft was open. `None` when nothing changes:
/// `program` isn't an absolute path, its folder is already on `base`, the
/// folder can't be one PATH entry (it holds the separator), or the result
/// would pass [`MAX_PATH_VALUE`]. Appended only, never prepended: what `base`
/// resolves first stays first. `windows` picks `;` and Windows' folder
/// comparison (case-insensitive, quotes and trailing separators aside);
/// otherwise `:` and an exact comparison, a trailing `/` aside.
pub fn with_folder_of(base: &str, program: &str, windows: bool) -> Option<String> {
    let (sep, folder) = if windows {
        let folder = &program[..program.rfind(['\\', '/'])?];
        (';', folder.trim_end_matches(['\\', '/']))
    } else {
        let folder = &program[..program.rfind('/')?];
        (':', folder.trim_end_matches('/'))
    };
    let absolute = if windows { absolute_windows_dir(folder) } else { folder.starts_with('/') };
    if !absolute || folder.contains(sep) {
        return None;
    }
    let have = |entry: &str| {
        if windows {
            same_windows_dir(entry, folder)
        } else {
            entry.trim_end_matches('/') == folder
        }
    };
    if base.split(sep).any(have) {
        return None;
    }
    let mut out = base.to_string();
    if !out.is_empty() && !out.ends_with(sep) {
        out.push(sep);
    }
    out.push_str(folder);
    (out.encode_utf16().count() <= MAX_PATH_VALUE).then_some(out)
}

/// Pure, 1.176.4 (owner, 2026-11-23): the PATH for one of Plyloft's own `gh`
/// children on a Mac whose `/usr/bin/git` is Apple's placeholder (no Command
/// Line Tools: running it only opens Apple's install dialog) — `base` with
/// the folder of `program` (the probed working git) put **in front**, so the
/// `git` gh launches by its bare name is that one. Only when `/usr/bin` is on
/// `base` and comes before the folder, or the folder is absent; `None`
/// (nothing changes) otherwise: the folder already comes first, `/usr/bin`
/// isn't there to answer, `program` is `/usr/bin`'s own git, isn't absolute,
/// its folder holds `:`, or the result would pass [`MAX_PATH_VALUE`]. macOS
/// shapes only (`:`, exact comparison, a trailing `/` aside).
pub fn with_folder_first(base: &str, program: &str) -> Option<String> {
    const USR_BIN: &str = "/usr/bin";
    let folder = program[..program.rfind('/')?].trim_end_matches('/');
    if !folder.starts_with('/') || folder.contains(':') || folder == USR_BIN {
        return None;
    }
    let at = |dir: &str| base.split(':').position(|entry| entry.trim_end_matches('/') == dir);
    let usr_bin = at(USR_BIN)?;
    if at(folder).is_some_and(|i| i < usr_bin) {
        return None;
    }
    let out = format!("{folder}:{base}");
    (out.encode_utf16().count() <= MAX_PATH_VALUE).then_some(out)
}

/// The PATH a probe uses on Windows: [`merged_path`] over the registry's
/// machine and user `Path`, falling back to `process` when neither reads.
#[cfg(windows)]
pub fn current(process: &str) -> String {
    let machine = reg::string(reg::Root::Machine, reg::MACHINE_ENV, "Path");
    let user = reg::string(reg::Root::User, reg::USER_ENV, "Path");
    if machine.is_none() && user.is_none() {
        return process.to_string();
    }
    merged_path(process, machine.as_deref(), user.as_deref(), lookup)
}

/// A variable's value as a new terminal would see it: the user's registry
/// value, then the machine's (an installer may have just defined it, as
/// nvm-windows does `NVM_HOME`), each expanded through Plyloft's own
/// environment; else Plyloft's own (`SystemRoot`, `USERPROFILE`…, which the
/// registry's `Environment` keys don't hold).
#[cfg(windows)]
fn lookup(name: &str) -> Option<String> {
    // REV-R1 M1: never the PATH itself (`merged_path` holds to it as well).
    if name.eq_ignore_ascii_case("PATH") {
        return None;
    }
    let own = |n: &str| std::env::var(n).ok();
    reg::string(reg::Root::User, reg::USER_ENV, name)
        .or_else(|| reg::string(reg::Root::Machine, reg::MACHINE_ENV, name))
        .map(|value| expand_vars(&value, own))
        .or_else(|| own(name))
}

#[cfg(windows)]
mod reg {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };

    pub const MACHINE_ENV: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
    pub const USER_ENV: &str = "Environment";

    #[derive(Clone, Copy)]
    pub enum Root {
        Machine,
        User,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A string value, read only and unexpanded (`RRF_NOEXPAND`: the caller
    /// expands it, with the registry's own variables first).
    pub fn string(root: Root, subkey: &str, name: &str) -> Option<String> {
        let hkey: HKEY = match root {
            Root::Machine => HKEY_LOCAL_MACHINE,
            Root::User => HKEY_CURRENT_USER,
        };
        let (sub, name) = (wide(subkey), wide(name));
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        // A value can grow between the sizing call and the read: try twice.
        for _ in 0..2 {
            let mut len: u32 = 0;
            // SAFETY: NUL-terminated names; no buffer, only its size asked.
            let sized = unsafe {
                RegGetValueW(hkey, PCWSTR(sub.as_ptr()), PCWSTR(name.as_ptr()), flags, None, None, Some(&mut len))
            };
            if sized != ERROR_SUCCESS || len == 0 {
                return None;
            }
            let mut buf = vec![0u16; (len as usize).div_ceil(2) + 1];
            let mut got = (buf.len() * 2) as u32;
            // SAFETY: the buffer and its byte length are ours for the call.
            let status = unsafe {
                RegGetValueW(
                    hkey,
                    PCWSTR(sub.as_ptr()),
                    PCWSTR(name.as_ptr()),
                    flags,
                    None,
                    Some(buf.as_mut_ptr().cast()),
                    Some(&mut got),
                )
            };
            if status == ERROR_SUCCESS {
                let chars = (got as usize / 2).min(buf.len());
                return Some(String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(name: &str) -> Option<String> {
        match name.to_ascii_uppercase().as_str() {
            "SYSTEMROOT" => Some(r"C:\Windows".into()),
            "USERPROFILE" => Some(r"C:\Users\Ada".into()),
            "LOCALAPPDATA" => Some(r"C:\Users\Ada\AppData\Local".into()),
            "NVM_HOME" => Some(r"C:\Users\Ada\AppData\Roaming\nvm".into()),
            _ => None,
        }
    }

    #[test]
    fn variables_expand_as_windows_does() {
        assert_eq!(expand_vars(r"%SystemRoot%\system32", vars), r"C:\Windows\system32");
        assert_eq!(expand_vars(r"%USERPROFILE%\.cargo\bin", vars), r"C:\Users\Ada\.cargo\bin");
        assert_eq!(expand_vars(r"%NVM_HOME%", vars), r"C:\Users\Ada\AppData\Roaming\nvm");
        // Unknown, unclosed or empty: as written.
        assert_eq!(expand_vars(r"%NOPE%\bin", vars), r"%NOPE%\bin");
        assert_eq!(expand_vars(r"C:\100%\bin", vars), r"C:\100%\bin");
        assert_eq!(expand_vars(r"a%%b", vars), r"a%%b");
        // `%%` is an empty name Windows doesn't find: both kept as written,
        // and the scan goes on after them (`ExpandEnvironmentStringsW`).
        assert_eq!(expand_vars(r"%%SystemRoot%", vars), r"%%SystemRoot%");
        assert_eq!(expand_vars(r"%%%SystemRoot%", vars), r"%%C:\Windows");
        assert_eq!(expand_vars("", vars), "");
        assert_eq!(expand_vars(r"C:\plain", vars), r"C:\plain");
        // Not ASCII around a name: no byte slicing goes wrong.
        assert_eq!(expand_vars(r"C:\Útil\%SystemRoot%\è", vars), r"C:\Útil\C:\Windows\è");
    }

    /// The PATH a Look again reads after Node.js was installed while Plyloft
    /// was open: the launch PATH unchanged, Node's folder appended.
    #[test]
    fn a_folder_installed_since_launch_is_appended_to_the_launch_path() {
        let process = r"C:\Windows\system32;C:\Windows;C:\Program Files\Git\cmd;C:\Users\Ada\AppData\Local\Microsoft\WindowsApps";
        let machine = r"%SystemRoot%\system32;%SystemRoot%;C:\Program Files\Git\cmd;C:\Program Files\nodejs\";
        let user = r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;%NVM_HOME%;C:\Users\Ada\AppData\Roaming\npm";
        assert_eq!(
            merged_path(process, Some(machine), Some(user), vars),
            format!(
                r"{process};C:\Program Files\nodejs\;C:\Users\Ada\AppData\Roaming\nvm;C:\Users\Ada\AppData\Roaming\npm"
            )
        );
    }

    #[test]
    fn nothing_new_leaves_the_launch_path_byte_for_byte() {
        let process = r"C:\WINDOWS\system32;C:\Windows\;c:\program files\git\cmd;";
        let machine = r"%SystemRoot%\System32;%SystemRoot%;C:\Program Files\Git\cmd\";
        assert_eq!(merged_path(process, Some(machine), None, vars), process);
        assert_eq!(merged_path(process, None, None, vars), process);
        // Quoted, empty and blank entries.
        assert_eq!(merged_path(process, Some(r#";"C:\Program Files\Git\cmd"; ;"#), Some(""), vars), process);
    }

    #[test]
    fn machine_before_user_no_duplicates_and_an_empty_launch_path() {
        let merged = merged_path("", Some(r"C:\a;C:\b"), Some(r"C:\B\;C:\c;C:\a"), vars);
        assert_eq!(merged, r"C:\a;C:\b;C:\c");
        // A trailing `;` is not doubled.
        assert_eq!(merged_path(r"C:\x;", Some(r"C:\y"), None, vars), r"C:\x;C:\y");
        // An entry whose variable can't be expanded isn't a folder: not added
        // (REV-R1 F2).
        assert_eq!(merged_path(r"C:\x", None, Some(r"%NOPE%\bin"), vars), r"C:\x");
    }

    /// REV-R1 M1: a user `Path` holding `%PATH%` (a known installer and
    /// `setx` mistake) never appends the PATH to itself, and a variable whose
    /// value is a `;` list is split and de-duplicated piece by piece.
    #[test]
    fn a_variable_that_expands_to_a_list_is_split_and_never_the_path_itself() {
        let path_is = |n: &str| n.eq_ignore_ascii_case("path").then(|| r"C:\a;C:\b".to_string());
        assert_eq!(merged_path(r"C:\a", None, Some(r"%PATH%;C:\b"), path_is), r"C:\a;C:\b");
        assert_eq!(merged_path(r"C:\a", None, Some(r"%Path%\x"), path_is), r"C:\a");
        let tools = |n: &str| (n == "MYTOOLS").then(|| r"C:\a; C:\c ;C:\A\;C:\d".to_string());
        assert_eq!(merged_path(r"C:\a", Some(r"%MYTOOLS%"), Some(r"C:\d"), tools), r"C:\a;C:\c;C:\d");
    }

    /// REV-R1 F2: only absolute folders are added; a relative entry (`.`,
    /// `bin`, an unexpanded `%UNDEFINED%\bin`) would search each child's
    /// working folder. What the launch PATH already holds is left alone.
    #[test]
    fn only_absolute_registry_folders_are_appended() {
        let user = r#".;bin;%UNDEFINED%\bin;..\tools;\rooted;C:relative;C:\ok;D:/also;\\server\share\bin;"C:\quoted dir""#;
        assert_eq!(
            merged_path(r".;C:\x", None, Some(user), vars),
            r#".;C:\x;C:\ok;D:/also;\\server\share\bin;"C:\quoted dir""#
        );
    }

    /// REV-R1 M1: the merged value stays within Windows' 32,767-character
    /// limit for one variable: the launch PATH whole, later entries dropped.
    #[test]
    fn the_merged_path_never_passes_the_windows_variable_limit() {
        let process = format!(r"C:\{}", "p".repeat(32_700));
        let user = format!(r"C:\{};C:\short;C:\{}", "u".repeat(100), "v".repeat(10));
        let merged = merged_path(&process, None, Some(&user), vars);
        assert!(merged.encode_utf16().count() <= MAX_PATH_VALUE, "{}", merged.len());
        assert!(merged.starts_with(&process));
        // Appending stops at the first folder that doesn't fit: no later one
        // jumps ahead of it.
        assert_eq!(merged, process);
        let fits = merged_path(&process, None, Some(r"C:\short;C:\next"), vars);
        assert_eq!(fits, format!(r"{process};C:\short;C:\next"));
        // A launch PATH already over the limit is kept whole; nothing is added.
        let huge = format!(r"C:\{}", "h".repeat(40_000));
        assert_eq!(merged_path(&huge, Some(r"C:\new"), None, vars), huge);
        // Counted in UTF-16 units, as Windows counts.
        let wide = format!(r"C:\{}", "€".repeat(32_758));
        assert_eq!(merged_path(&wide, None, Some(r"C:\abc"), vars), wide);
        assert_eq!(merged_path(&wide, None, Some(r"C:\a"), vars), format!(r"{wide};C:\a"));
    }

    /// REV-R1 F3 (runs only on Windows; read only, nothing written): the
    /// registry reader reads real values, unexpanded, and misses cleanly.
    #[cfg(windows)]
    #[test]
    fn the_registry_reader_reads_the_real_environment_keys() {
        let machine = reg::string(reg::Root::Machine, reg::MACHINE_ENV, "Path").expect("the machine Path");
        assert!(machine.to_ascii_lowercase().contains("system32"), "{machine}");
        assert!(!machine.contains('\0'));
        // HKCU\Environment\TEMP is `%USERPROFILE%\AppData\Local\Temp` on a
        // stock account: read as stored when it is there.
        if let Some(temp) = reg::string(reg::Root::User, reg::USER_ENV, "TEMP") {
            assert!(!temp.is_empty() && !temp.contains('\0'), "{temp}");
        }
        assert_eq!(reg::string(reg::Root::User, reg::USER_ENV, "NoSuchValue-plyloft-xyz"), None);
        assert_eq!(reg::string(reg::Root::User, r"NoSuchKey-plyloft-xyz", "Path"), None);
        assert_eq!(lookup("PATH"), None);
        assert_eq!(lookup("Path"), None);
        assert!(lookup("SystemRoot").is_some());
    }

    /// REV-R1 F3 (Windows only): the probe's PATH starts with Plyloft's own,
    /// whole, and stays within the variable limit when that one does.
    #[cfg(windows)]
    #[test]
    fn the_current_path_starts_with_the_process_path() {
        let process = std::env::var("PATH").unwrap_or_default();
        let current = current(&process);
        assert!(current.starts_with(&process));
        if process.encode_utf16().count() <= MAX_PATH_VALUE {
            assert!(current.encode_utf16().count() <= MAX_PATH_VALUE);
        }
        for added in current[process.len()..].split(';').filter(|e| !e.is_empty()) {
            assert!(absolute_windows_dir(added), "{added}");
        }
    }

    /// 1.176.3: gh's PATH gets the probed git's folder appended, only when
    /// it is absent — Windows shapes.
    #[test]
    fn gh_path_appends_the_probed_gits_folder_on_windows() {
        let launch = r"C:\Windows\system32;C:\Windows";
        let git = r"C:\Program Files\Git\cmd\git.exe";
        assert_eq!(
            with_folder_of(launch, git, true).as_deref(),
            Some(r"C:\Windows\system32;C:\Windows;C:\Program Files\Git\cmd"),
            "appended after, never prepended"
        );
        // A trailing `;` gets no empty entry.
        assert_eq!(
            with_folder_of(&format!("{launch};"), git, true).as_deref(),
            Some(r"C:\Windows\system32;C:\Windows;C:\Program Files\Git\cmd")
        );
        // An empty PATH: the folder alone.
        assert_eq!(with_folder_of("", git, true).as_deref(), Some(r"C:\Program Files\Git\cmd"));
        // Already there, however it is spelled: nothing changes.
        for have in [
            r"C:\Windows;C:\Program Files\Git\cmd",
            r"C:\Windows;c:\program files\git\CMD\",
            r#"C:\Windows;"C:\Program Files\Git\cmd""#,
        ] {
            assert_eq!(with_folder_of(have, git, true), None, "{have}");
        }
        // Not absolute, or not one entry: nothing changes.
        for odd in ["git.exe", r"cmd\git.exe", r"C:git.exe", r"\Git\cmd\git.exe", r"C:\a;b\git.exe"] {
            assert_eq!(with_folder_of(launch, odd, true), None, "{odd}");
        }
        // A UNC share is absolute.
        assert_eq!(
            with_folder_of(launch, r"\\srv\tools\git\cmd\git.exe", true).as_deref(),
            Some(r"C:\Windows\system32;C:\Windows;\\srv\tools\git\cmd")
        );
        // Past Windows' limit: nothing changes (the launch PATH stays whole).
        let long = format!(r"C:\{}", "a".repeat(MAX_PATH_VALUE - 10));
        assert_eq!(with_folder_of(&long, git, true), None);
    }

    /// The same rule with macOS shapes: a git already on the PATH (the
    /// usual case) changes nothing.
    #[test]
    fn gh_path_appends_the_probed_gits_folder_on_macos() {
        let finder = "/usr/bin:/bin:/usr/sbin:/sbin";
        assert_eq!(with_folder_of(finder, "/usr/bin/git", false), None);
        assert_eq!(with_folder_of("/usr/bin/:/bin", "/usr/bin/git", false), None);
        assert_eq!(
            with_folder_of(finder, "/opt/homebrew/bin/git", false).as_deref(),
            Some("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        );
        assert_eq!(with_folder_of("", "/opt/homebrew/bin/git", false).as_deref(), Some("/opt/homebrew/bin"));
        // Case matters on this comparison: no Windows folding.
        assert_eq!(
            with_folder_of("/Opt/Homebrew/Bin", "/opt/homebrew/bin/git", false).as_deref(),
            Some("/Opt/Homebrew/Bin:/opt/homebrew/bin")
        );
        for odd in ["git", "bin/git", "/odd:dir/git", "/git"] {
            assert_eq!(with_folder_of(finder, odd, false), None, "{odd}");
        }
    }

    /// 1.176.4 (owner, 2026-11-23): on a Mac whose `/usr/bin/git` is Apple's
    /// placeholder, the probed git's folder goes in front — only when
    /// `/usr/bin` would otherwise answer gh's bare `git` first.
    #[test]
    fn gh_path_puts_the_probed_gits_folder_first_over_apples_placeholder() {
        let finder = "/usr/bin:/bin:/usr/sbin:/sbin";
        let brew = "/opt/homebrew/bin/git";
        // Folder absent: in front.
        assert_eq!(
            with_folder_first(finder, brew).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        );
        // Folder after `/usr/bin` (however `/usr/bin` is spelled): in front too.
        assert_eq!(
            with_folder_first("/usr/bin/:/bin:/opt/homebrew/bin", brew).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin/:/bin:/opt/homebrew/bin")
        );
        // Folder already before `/usr/bin`: nothing changes.
        assert_eq!(with_folder_first("/opt/homebrew/bin:/usr/bin:/bin", brew), None);
        assert_eq!(with_folder_first("/opt/homebrew/bin/:/usr/bin", brew), None);
        // No `/usr/bin` on the PATH: the placeholder can't answer, nothing changes.
        assert_eq!(with_folder_first("/bin:/usr/sbin", brew), None);
        assert_eq!(with_folder_first("", brew), None);
        // The probed git is `/usr/bin`'s own: nothing changes.
        assert_eq!(with_folder_first(finder, "/usr/bin/git"), None);
        assert_eq!(with_folder_first(finder, "/usr/bin//git"), None);
        // Not absolute, or not one entry: nothing changes.
        for odd in ["git", "bin/git", "/odd:dir/git", "/git"] {
            assert_eq!(with_folder_first(finder, odd), None, "{odd}");
        }
        // Past the cap: nothing changes.
        let long = format!("/usr/bin:/{}", "a".repeat(MAX_PATH_VALUE - 10));
        assert_eq!(with_folder_first(&long, brew), None);
    }

    /// The probe reads it only on Windows: the Mac's probe is untouched.
    #[test]
    fn only_the_windows_probe_reads_the_registry() {
        let src = include_str!("shell_env.rs");
        let at = src.find("crate::registry_path::current(").expect("the probe reads it");
        let before = &src[..at];
        let cfg = before.rfind("#[cfg(").expect("under a cfg");
        assert!(before[cfg..].starts_with("#[cfg(windows)]"), "{}", &before[cfg..]);
    }
}
