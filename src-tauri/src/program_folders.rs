//! 1.176.1: what the Program folders setting (`shell.pathOverride`) holds,
//! read before it can break the app, and the PATH Plyloft's own command steps
//! run with.
//!
//! The owner's MacBook (2026-11-21) held `~/.local/bin/claude` there: a
//! program, written with `~`, where a list of folders is expected. Plyloft
//! takes the setting literally (hard rule 2: tiles get exactly the PATH the
//! person set), so nothing was found — not claude, not curl or bash — and
//! the only hint was "Claude is not on this PATH".
//!
//! [`read_list`] is pure over a [`Disk`] and a [`Ctx`] (strings, with a
//! `windows` flag), so the Windows rules are tested on the Mac. It says, per
//! entry, whether it is a folder that exists, one that doesn't, a file (and
//! the folder that holds it), written with `~` or `~name`, holding a variable
//! (`$PATH`, `${HOME}`, `%USERPROFILE%`), relative or empty; and, for the
//! list, which of claude, codex, git and gh it finds (on the Mac also curl,
//! bash and sh) and which system folders it leaves out.
//!
//! How each case is handled, and why (owner's decision, 2026-11-21):
//!
//! - **A leading `~` or `~/`** is expanded to the home on save: in a list of
//!   folders it can only mean that, and PATH never expands it itself.
//! - **Empty entries** (`a::b`, a trailing separator) are dropped on save.
//!   POSIX reads one as "the current folder", which differs in every tile;
//!   nobody types that on purpose.
//! - **A file** is never saved as is: the row offers "Use its folder", one
//!   press that saves the list with the file replaced by its folder.
//! - **A variable** is not expanded silently: the setting *replaces* what the
//!   shell reports, which `$PATH` suggests it doesn't. The row says so and
//!   offers to save the explicit list ([`Verdict::expanded`]: `$PATH` as the
//!   folders the login shell reported, `$HOME` and the others from the
//!   environment). A variable Plyloft can't read blocks the save.
//! - **`~name`** (another account's home) and **a relative entry** block the
//!   save: a relative folder means a different folder in every tile.
//! - **A folder that doesn't exist** is saved (it may be created later) and
//!   named.
//! - **A list that finds none of claude, codex, git and gh, or leaves the
//!   system folders out** is not refused — a Nix-style list carries its own
//!   basics — but saved only after a confirmation that names what won't be
//!   found, with the one-press correction offered beside it
//!   ([`Verdict::with_shell`]: the list, then the shell's folders).
//!
//! A value already saved is never rewritten by itself: the checks run on the
//! person's save and when the page opens; launch only logs the verdict.
//!
//! [`steps_path`]: Plyloft's own Setup and Repair commands (installers,
//! updates, npm removal, chown, the reach check) get the system folders
//! appended after the person's PATH, so they never die of "command not
//! found" because of the list. These are Plyloft's steps, not the person's
//! tiles: the cached PATH still comes first, unchanged and in order.

use serde::Serialize;

/// The commands the list is asked about.
pub const TOOLS: [&str; 4] = ["claude", "codex", "git", "gh"];
/// The Mac's everyday commands a terminal and an installer need.
pub const MAC_BASICS: [&str; 3] = ["curl", "bash", "sh"];
/// The Mac's system folders, in the order a shell has them.
pub const MAC_SYSTEM_DIRS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// What one entry is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EntryState {
    Folder,
    /// An absolute folder that isn't there.
    Missing,
    /// A file, not a folder; `folder` is the one that holds it.
    File { folder: String },
    Relative,
    Empty,
    /// `~name/…`: another account's home.
    OtherHome,
    /// A variable Plyloft can't read.
    UnknownVariable { name: String },
    /// `$PATH` (or `${PATH}`, `%PATH%`) alone: the shell's whole list.
    ShellFolders,
    /// Mac (review 1): the rest of a folder whose name holds a `:`
    /// (`folder`), which a PATH-style list can't express.
    ColonInName { folder: String },
}

/// One entry of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// As written (trimmed).
    pub text: String,
    /// Exactly as tiles receive it: untrimmed (review 1: a saved
    /// `/usr/bin: /opt/x` gives tiles a relative ` /opt/x`).
    pub raw: String,
    /// The absolute path it stands for, `~` and known variables expanded.
    pub path: Option<String>,
    /// Written with a leading `~`.
    pub tilde: bool,
    /// The variables it holds, by name.
    pub variables: Vec<String>,
    pub state: EntryState,
}

/// What is wrong with the list as written, most important first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    NamesAFile,
    Variable,
    Tilde,
    OtherHome,
    Relative,
    /// Mac: a folder name holds a `:`.
    ColonInName,
    /// Review 1: spaces or quotes around an entry, an empty entry or the same
    /// folder twice — tiles get it exactly as written.
    Untidy,
}

/// A command the list finds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub name: String,
    pub path: String,
}

/// The whole reading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub windows: bool,
    pub entries: Vec<Entry>,
    /// Of [`TOOLS`] (and on the Mac [`MAC_BASICS`]), what the list as
    /// written finds: what tiles would get, since it is taken literally.
    pub found: Vec<Found>,
    /// Of [`TOOLS`], what it doesn't find.
    pub missing: Vec<String>,
    /// Mac: of [`MAC_BASICS`], what it doesn't find.
    pub basics_missing: Vec<String>,
    /// The system folders it leaves out (`/usr/bin`, `/bin`; on Windows
    /// `System32`).
    pub system_folders_missing: Vec<String>,
    pub problems: Vec<Problem>,
    /// What a save stores: `~` expanded, empty entries dropped. `None` while
    /// an entry blocks the save (a file, a variable, `~name`, relative).
    pub save_as: Option<String>,
    /// The list with each file replaced by its folder, when files are what
    /// block the save.
    pub use_folders: Option<String>,
    /// The list with every variable written out (`$PATH` as the shell's
    /// folders), when each one is known.
    pub expanded: Option<String>,
    /// `$PATH` comes first in what was written: the explicit list then has
    /// the shell's folders first.
    pub path_variable_first: bool,
    /// When nothing blocks the save but it leaves the system folders or a
    /// basic out: the list followed by the shell's folders not already in it.
    pub with_shell: Option<String>,
    /// A save waits for the person's confirmation: none of [`TOOLS`] is
    /// found, or system folders or basics are left out.
    pub needs_confirmation: bool,
    /// Review 1: every folder this value would add is already among the
    /// folders the shell reports, so emptying the setting (and following the
    /// shell, also when it changes) is the better fix.
    pub shell_has_them: bool,
}

impl Verdict {
    /// Something in the list as written is wrong (not just missing).
    pub fn malformed(&self) -> bool {
        !self.problems.is_empty()
    }

    #[cfg(test)]
    pub fn finds(&self, name: &str) -> bool {
        self.found.iter().any(|f| f.name == name)
    }
}

/// A path as the disk has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    Dir,
    File,
    Absent,
}

/// The disk, behind a trait so [`read_list`] is tested with a fake one.
pub trait Disk {
    fn kind(&self, path: &str) -> PathKind;
    /// The program `name` in `dir`, as a spawn would find it (on Windows
    /// with PATHEXT).
    fn program(&self, dir: &str, name: &str) -> Option<String>;
}

/// The real disk.
pub struct SystemDisk;

impl Disk for SystemDisk {
    fn kind(&self, path: &str) -> PathKind {
        match std::fs::metadata(path) {
            Ok(m) if m.is_dir() => PathKind::Dir,
            Ok(_) => PathKind::File,
            Err(_) => PathKind::Absent,
        }
    }

    fn program(&self, dir: &str, name: &str) -> Option<String> {
        crate::platform::program_candidates(std::path::Path::new(dir), name)
            .into_iter()
            .find(|c| c.is_file())
            .map(|c| c.to_string_lossy().into_owned())
    }
}

/// What the reading knows besides the disk.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub windows: bool,
    pub home: Option<String>,
    /// What the login shell reported (the last probe's PATH), for `$PATH`.
    pub shell_path: Option<String>,
    /// Other variables (`USERPROFILE`, `LOCALAPPDATA`…), by name.
    pub vars: Vec<(String, String)>,
    /// Windows: `%SystemRoot%` (`C:\Windows` when unknown).
    pub system_root: Option<String>,
}

impl Ctx {
    /// This machine.
    pub fn now() -> Self {
        let windows = cfg!(windows);
        Self {
            windows,
            home: crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned()),
            shell_path: crate::shell_env::shell_reported_path(),
            vars: std::env::vars().filter(|(k, _)| k != "PATH" && k != "Path").collect(),
            system_root: std::env::var("SystemRoot").ok().filter(|v| !v.is_empty()),
        }
    }

    fn var(&self, name: &str) -> Option<String> {
        let same = |k: &str| if self.windows { k.eq_ignore_ascii_case(name) } else { k == name };
        if same("PATH") {
            return self.shell_path.clone();
        }
        if same("HOME") || (self.windows && same("USERPROFILE") && self.home.is_some()) {
            if let Some(home) = self.home.clone() {
                return Some(home);
            }
        }
        self.vars.iter().find(|(k, _)| same(k)).map(|(_, v)| v.clone()).filter(|v| !v.is_empty())
    }

    fn system_dirs(&self) -> Vec<String> {
        system_dirs(self.windows, self.system_root.as_deref())
    }
}

/// The system folders a command step needs (Mac: `/usr/bin:/bin:/usr/sbin:
/// /sbin`; Windows: System32, the Windows folder, Wbem and PowerShell 5's).
pub fn system_dirs(windows: bool, system_root: Option<&str>) -> Vec<String> {
    if !windows {
        return MAC_SYSTEM_DIRS.iter().map(|s| s.to_string()).collect();
    }
    let root = system_root.unwrap_or(r"C:\Windows").trim_end_matches(['\\', '/']).to_string();
    vec![
        format!(r"{root}\System32"),
        root.clone(),
        format!(r"{root}\System32\Wbem"),
        format!(r"{root}\System32\WindowsPowerShell\v1.0"),
    ]
}

fn sep(windows: bool) -> char {
    if windows {
        ';'
    } else {
        ':'
    }
}

fn same_dir(a: &str, b: &str, windows: bool) -> bool {
    crate::cli_health::norm(a, windows) == crate::cli_health::norm(b, windows)
}

/// The entries exactly as written (as tiles receive them).
fn split_raw(value: &str, windows: bool) -> Vec<String> {
    value.split(sep(windows)).map(str::to_string).collect()
}

fn split(value: &str, windows: bool) -> Vec<String> {
    value.split(sep(windows)).map(|d| d.trim().trim_matches('"').trim().to_string()).collect()
}

fn ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The variables in `text`, in order: `$NAME`, `${NAME…}`, `%NAME%`.
pub(crate) fn variables_in(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '$' if chars.get(i + 1) == Some(&'{') => {
                let name: String = chars[i + 2..].iter().take_while(|c| ident(**c)).collect();
                if !name.is_empty() {
                    out.push(name);
                }
                i += 2;
            }
            '$' => {
                let name: String = chars[i + 1..].iter().take_while(|c| ident(**c)).collect();
                if name.chars().next().is_some_and(|c| !c.is_ascii_digit()) {
                    i += name.len();
                    out.push(name);
                }
                i += 1;
            }
            '%' => {
                let name: String = chars[i + 1..].iter().take_while(|c| ident(**c)).collect();
                if !name.is_empty() && chars.get(i + 1 + name.len()) == Some(&'%') {
                    i += name.len() + 2;
                    out.push(name);
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    out
}

/// `text` with each variable replaced by `lookup`'s value; `None` when one is
/// unknown.
pub(crate) fn expand_vars(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' && chars.get(i + 1) == Some(&'{') {
            let end = chars[i..].iter().position(|c| *c == '}').map(|p| p + i)?;
            let name: String = chars[i + 2..end].iter().take_while(|c| ident(**c)).collect();
            out.push_str(&lookup(&name)?);
            i = end + 1;
            continue;
        }
        if c == '$' {
            let name: String = chars[i + 1..].iter().take_while(|c| ident(**c)).collect();
            if name.chars().next().is_some_and(|c| !c.is_ascii_digit()) {
                out.push_str(&lookup(&name)?);
                i += 1 + name.len();
                continue;
            }
        }
        if c == '%' {
            let name: String = chars[i + 1..].iter().take_while(|c| ident(**c)).collect();
            if !name.is_empty() && chars.get(i + 1 + name.len()) == Some(&'%') {
                out.push_str(&lookup(&name)?);
                i += name.len() + 2;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    Some(out)
}

fn is_path_var(name: &str, windows: bool) -> bool {
    if windows {
        name.eq_ignore_ascii_case("PATH")
    } else {
        name == "PATH"
    }
}

/// The parent folder of a file path.
fn folder_of(path: &str, windows: bool) -> String {
    crate::cli_health::parent(path, windows).unwrap_or(path).to_string()
}

fn state_of(path: &str, windows: bool, disk: &dyn Disk) -> EntryState {
    if !crate::cli_health::is_absolute(path, windows) {
        return EntryState::Relative;
    }
    match disk.kind(path) {
        PathKind::Dir => EntryState::Folder,
        PathKind::File => EntryState::File { folder: folder_of(path, windows) },
        PathKind::Absent => EntryState::Missing,
    }
}

fn read_entry(raw: &str, ctx: &Ctx, disk: &dyn Disk) -> Entry {
    let w = ctx.windows;
    let text = raw.trim().trim_matches('"').trim();
    let entry = |path: Option<String>, tilde, variables, state| Entry {
        text: text.to_string(),
        raw: raw.to_string(),
        path,
        tilde,
        variables,
        state,
    };
    if text.is_empty() {
        return entry(None, false, Vec::new(), EntryState::Empty);
    }
    // Review 1: a `$` or `%` in a folder that is there as written is part of
    // its name, not a variable.
    let literal = crate::cli_health::is_absolute(text, w) && disk.kind(text) == PathKind::Dir;
    let variables = if literal { Vec::new() } else { variables_in(text) };
    if variables.len() == 1 && {
        let n = &variables[0];
        [format!("${n}"), format!("${{{n}}}"), format!("%{n}%")].iter().any(|f| if w { f.eq_ignore_ascii_case(text) } else { f == text })
            && is_path_var(n, w)
    } {
        return entry(None, false, variables, EntryState::ShellFolders);
    }
    // `~`, `~/…` (and `~\…` on Windows); `~name…` is another account's.
    let tilde_rest = if text == "~" {
        Some("")
    } else {
        text.strip_prefix("~/").or_else(|| if w { text.strip_prefix("~\\") } else { None })
    };
    let tilde = tilde_rest.is_some();
    if text.starts_with('~') && !tilde {
        return entry(None, false, variables, EntryState::OtherHome);
    }
    let base = match (tilde_rest, ctx.home.as_deref()) {
        (Some(rest), Some(home)) if rest.is_empty() => home.to_string(),
        (Some(rest), Some(home)) => crate::cli_health::join(home, &[rest], w),
        (Some(_), None) => return entry(None, true, variables, EntryState::Relative),
        (None, _) => text.to_string(),
    };
    if !variables.is_empty() {
        let lookup = |name: &str| if is_path_var(name, w) { None } else { ctx.var(name) };
        let Some(expanded) = expand_vars(&base, &lookup) else {
            let unknown = variables
                .iter()
                .find(|n| is_path_var(n, w) || ctx.var(n).is_none())
                .cloned()
                .unwrap_or_default();
            return entry(None, tilde, variables, EntryState::UnknownVariable { name: unknown });
        };
        let state = state_of(&expanded, w, disk);
        return entry(Some(expanded), tilde, variables, state);
    }
    let state = state_of(&base, w, disk);
    entry(Some(base), tilde, variables, state)
}

/// The folders a list stands for, in order, for a search: literally (as tiles
/// get it: only absolute entries without `~` or a variable), or expanded.
fn literal_dirs(entries: &[Entry], windows: bool) -> Vec<String> {
    entries
        .iter()
        .filter(|e| e.raw == e.text && !e.tilde && e.variables.is_empty() && crate::cli_health::is_absolute(&e.text, windows))
        .filter(|e| e.state == EntryState::Folder)
        .map(|e| e.text.clone())
        .collect()
}

fn push_unique(list: &mut Vec<String>, dir: &str, windows: bool) {
    if !list.iter().any(|d| same_dir(d, dir, windows)) {
        list.push(dir.to_string());
    }
}

fn join_list(dirs: &[String], windows: bool) -> String {
    dirs.join(&sep(windows).to_string())
}

/// Read `value` as the Program folders setting.
pub fn read_list(value: &str, ctx: &Ctx, disk: &dyn Disk) -> Verdict {
    let w = ctx.windows;
    let mut entries: Vec<Entry> = split_raw(value, w).iter().map(|t| read_entry(t, ctx, disk)).collect();
    // Mac: `/Volumes/My:Disk/bin` splits in two; the second half reads
    // relative. When the two joined back are a folder, say what it is.
    if !w {
        for i in 1..entries.len() {
            if entries[i].state == EntryState::Relative && !entries[i].tilde {
                let joined = format!("{}:{}", entries[i - 1].text, entries[i].text);
                if disk.kind(&joined) == PathKind::Dir {
                    entries[i].state = EntryState::ColonInName { folder: joined };
                }
            }
        }
    }

    let dirs = literal_dirs(&entries, w);
    let mut names: Vec<&str> = TOOLS.to_vec();
    if !w {
        names.extend(MAC_BASICS);
    }
    let found: Vec<Found> = names
        .iter()
        .filter_map(|name| {
            dirs.iter().find_map(|d| disk.program(d, name)).map(|path| Found { name: name.to_string(), path })
        })
        .collect();
    let has = |n: &str| found.iter().any(|f| f.name == n);
    let missing: Vec<String> = TOOLS.iter().filter(|n| !has(n)).map(|n| n.to_string()).collect();
    let basics_missing: Vec<String> =
        if w { Vec::new() } else { MAC_BASICS.iter().filter(|n| !has(n)).map(|n| n.to_string()).collect() };
    let wanted: Vec<String> = if w { ctx.system_dirs().into_iter().take(1).collect() } else { vec!["/usr/bin".into(), "/bin".into()] };
    let system_folders_missing: Vec<String> =
        wanted.into_iter().filter(|s| !dirs.iter().any(|d| same_dir(d, s, w))).collect();

    let mut problems: Vec<Problem> = Vec::new();
    let mut add = |p: Problem| {
        if !problems.contains(&p) {
            problems.push(p);
        }
    };
    for e in &entries {
        match &e.state {
            EntryState::File { .. } => add(Problem::NamesAFile),
            EntryState::OtherHome => add(Problem::OtherHome),
            EntryState::Relative if !e.tilde => add(Problem::Relative),
            EntryState::ColonInName { .. } => add(Problem::ColonInName),
            _ => {}
        }
        // Quotes around a Windows entry are read by Windows itself.
        let quoted_ok = w && e.raw.trim() == format!("\"{}\"", e.text);
        if e.raw != e.text && !quoted_ok && e.state != EntryState::Empty {
            add(Problem::Untidy);
        }
        if !e.variables.is_empty() {
            add(Problem::Variable);
        }
        if e.tilde {
            add(Problem::Tilde);
        }
    }
    let non_empty = entries.iter().filter(|e| e.state != EntryState::Empty).count();
    if entries.len() > 1 && non_empty < entries.len() && non_empty > 0 {
        add(Problem::Untidy);
    }
    {
        let mut seen: Vec<String> = Vec::new();
        for e in entries.iter().filter(|e| e.state != EntryState::Empty) {
            let key = e.path.clone().unwrap_or_else(|| e.text.clone());
            if seen.iter().any(|d| same_dir(d, &key, w)) {
                add(Problem::Untidy);
            }
            seen.push(key);
        }
    }
    problems.sort_by_key(|p| *p as u8);

    let blocks = |e: &Entry| {
        !e.variables.is_empty()
            || matches!(
                e.state,
                EntryState::File { .. }
                    | EntryState::OtherHome
                    | EntryState::Relative
                    | EntryState::UnknownVariable { .. }
                    | EntryState::ColonInName { .. }
            )
    };
    let kept = |e: &Entry| e.state != EntryState::Empty;
    let path_of = |e: &Entry| e.path.clone().unwrap_or_else(|| e.text.clone());
    // Trimmed, empty entries dropped, each folder once: what tidying stores.
    let save_as = (!entries.iter().any(blocks)).then(|| {
        let mut out: Vec<String> = Vec::new();
        for e in entries.iter().filter(|e| kept(e)) {
            push_unique(&mut out, &path_of(e), w);
        }
        join_list(&out, w)
    });

    // Files are the only blockers: the list with their folders instead.
    let only_files = entries.iter().any(|e| matches!(e.state, EntryState::File { .. }))
        && entries.iter().all(|e| matches!(e.state, EntryState::File { .. }) || !blocks(e));
    let use_folders = only_files.then(|| {
        let mut out: Vec<String> = Vec::new();
        for e in entries.iter().filter(|e| kept(e)) {
            match &e.state {
                EntryState::File { folder } => push_unique(&mut out, folder, w),
                _ => out.push(path_of(e)),
            }
        }
        join_list(&out, w)
    });

    // Every variable written out, when each is known (and nothing else blocks).
    let has_vars = entries.iter().any(|e| !e.variables.is_empty());
    let shell_dirs: Option<Vec<String>> = ctx.shell_path.as_deref().map(|p| {
        split(p, w).into_iter().filter(|d| !d.is_empty()).collect()
    });
    let first_kept = entries.iter().find(|e| kept(e));
    let path_variable_first = first_kept.is_some_and(|e| e.state == EntryState::ShellFolders);
    let expanded = (has_vars
        && entries.iter().all(|e| {
            e.variables.is_empty()
                || e.state == EntryState::ShellFolders
                || matches!(e.state, EntryState::Folder | EntryState::Missing)
        })
        && entries.iter().all(|e| !e.variables.is_empty() || !blocks(e))
        && (shell_dirs.is_some() || !entries.iter().any(|e| e.state == EntryState::ShellFolders)))
    .then(|| {
        let mut out: Vec<String> = Vec::new();
        for e in entries.iter().filter(|e| kept(e)) {
            if e.state == EntryState::ShellFolders {
                for d in shell_dirs.iter().flatten() {
                    push_unique(&mut out, d, w);
                }
            } else {
                push_unique(&mut out, &path_of(e), w);
            }
        }
        join_list(&out, w)
    });

    let short = !system_folders_missing.is_empty() || !basics_missing.is_empty();
    let none_found = missing.len() == TOOLS.len();
    let with_shell = match (&save_as, &shell_dirs) {
        (Some(saved), Some(shell)) if short || none_found => {
            let mut out: Vec<String> = split(saved, w).into_iter().filter(|d| !d.is_empty()).collect();
            for d in shell {
                push_unique(&mut out, d, w);
            }
            let joined = join_list(&out, w);
            (joined != *saved).then_some(joined)
        }
        _ => None,
    };
    let needs_confirmation = save_as.as_deref().is_some_and(|s| !s.is_empty()) && (none_found || short);
    // The folders this value would add, beside what the shell reports.
    let adds: Vec<String> = entries
        .iter()
        .filter_map(|e| match &e.state {
            EntryState::File { folder } => Some(folder.clone()),
            EntryState::Empty | EntryState::ShellFolders => None,
            _ => e.path.clone(),
        })
        .collect();
    let shell_has_them = !adds.is_empty()
        && shell_dirs.as_ref().is_some_and(|shell| adds.iter().all(|a| shell.iter().any(|d| same_dir(d, a, w))));

    Verdict {
        windows: w,
        entries,
        found,
        missing,
        basics_missing,
        system_folders_missing,
        problems,
        save_as,
        use_folders,
        expanded,
        path_variable_first,
        with_shell,
        needs_confirmation,
        shell_has_them,
    }
}

/// The saved setting read on this machine; `None` without one.
pub fn saved_verdict() -> Option<Verdict> {
    let value = crate::shell_env::path_override()?;
    Some(read_list(&value, &Ctx::now(), &SystemDisk))
}

/// Pure: `path` with the system folders appended, those not already in it,
/// after everything the person's PATH holds (never a replacement or a
/// reorder).
pub fn with_system_dirs(path: &str, windows: bool, system_root: Option<&str>) -> String {
    let mut parts: Vec<String> = path.split(sep(windows)).map(str::to_string).filter(|p| !p.trim().is_empty()).collect();
    let before = parts.len();
    for dir in system_dirs(windows, system_root) {
        push_unique(&mut parts, &dir, windows);
    }
    if parts.len() == before {
        return path.to_string();
    }
    join_list(&parts, windows)
}

/// The PATH of one of Plyloft's own command steps on this machine.
pub fn steps_path(path: &str) -> String {
    let root = std::env::var("SystemRoot").ok().filter(|v| !v.is_empty());
    with_system_dirs(path, cfg!(windows), root.as_deref())
}

/// Pure: a Setup or Repair run's environment with its PATH — the one the
/// run's plan gives (an installer's own folder added, npm's prefix first) or
/// else the snapshot's — followed by the system folders. Last entry wins in
/// `spawn_setup`, so the PATH is set once, at the end.
pub fn steps_env(
    mut env: Vec<(String, String)>,
    snapshot_path: &str,
    windows: bool,
    system_root: Option<&str>,
) -> Vec<(String, String)> {
    let is_path = |k: &str| if windows { k.eq_ignore_ascii_case("PATH") } else { k == "PATH" };
    let base = env.iter().rev().find(|(k, _)| is_path(k)).map(|(_, v)| v.clone()).unwrap_or_else(|| snapshot_path.to_string());
    env.retain(|(k, _)| !is_path(k));
    env.push(("PATH".into(), with_system_dirs(&base, windows, system_root)));
    env
}

/// Pure: `value` with `folder` at the end (once): the person's own order
/// stays first (review 1).
pub fn append(value: &str, folder: &str, windows: bool) -> String {
    let mut parts: Vec<String> = split(value, windows).into_iter().filter(|p| !p.is_empty()).collect();
    push_unique(&mut parts, folder, windows);
    join_list(&parts, windows)
}

/// Pure: `value` with `folder` in front (once).
pub fn prepend(value: &str, folder: &str, windows: bool) -> String {
    let mut parts: Vec<String> = vec![folder.to_string()];
    for p in split(value, windows).into_iter().filter(|p| !p.is_empty()) {
        push_unique(&mut parts, &p, windows);
    }
    join_list(&parts, windows)
}

/// Save `value` as the Program folders setting the way Settings' own save
/// does (`commands::settings_set`): the store's atomic write, the override
/// recorded for every later re-probe, a re-probe now (before this returns,
/// so the next look sees it), and both events every window listens to.
pub fn save_override<R: tauri::Runtime>(app: &tauri::AppHandle<R>, value: &str) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let store = app.try_state::<crate::settings::SettingsStore>().ok_or("The settings aren't ready.")?;
    // 1.176.2 R2: changed under the store's lock, and the window told at once,
    // before the re-probe's seconds: its next save is built on this value.
    // Empty is "not set", as Settings' own field writes it.
    let saved = store.update(|s| s.shell.path_override = (!value.trim().is_empty()).then(|| value.to_string()))?;
    let _ = app.emit("settings://changed", saved.clone());
    crate::shell_env::configure_path_override(saved.shell.path_override.as_deref());
    let capabilities = app.try_state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
    // As Settings' own save does (`commands::settings_set`): a change this
    // look finds is the person's own Program folders, not told back
    // (`cli_seen`), until the look is over.
    let own = crate::cli_seen::OwnChange::new(&[crate::cli_fresh::Cli::Claude, crate::cli_fresh::Cli::Codex]);
    crate::commands::re_probe_and_forget(capabilities.as_ref().map(|s| s.inner()));
    drop(own);
    let _ = app.emit(crate::commands::SHELL_ENV_CHANGED_EVENT, crate::commands::snapshot_env());
    Ok(())
}

/// Repair's "Add {folder} to Program folders": checked again first — the
/// setting is still exactly what the plan saw (`was`, bound into the step's
/// id) and the folder is an absolute folder on disk. At the end, unless
/// `front` (a copy of the tool earlier in the list would still win).
pub fn add_folder<R: tauri::Runtime>(app: &tauri::AppHandle<R>, folder: &str, front: bool, was: &str) -> Result<String, String> {
    let windows = cfg!(windows);
    let current = still(was)?;
    if !crate::cli_health::is_absolute(folder, windows) || SystemDisk.kind(folder) != PathKind::Dir {
        return Err(format!("{folder} isn't a folder any more."));
    }
    let next = if front { prepend(&current, folder, windows) } else { append(&current, folder, windows) };
    save_override(app, &next)?;
    Ok(next)
}

/// Repair's "Empty Program folders": the setting is still what the plan saw.
pub fn empty<R: tauri::Runtime>(app: &tauri::AppHandle<R>, was: &str) -> Result<(), String> {
    still(was)?;
    save_override(app, "")
}

/// Pure over the recorded setting: it is still `was`.
fn still(was: &str) -> Result<String, String> {
    let current = crate::shell_env::path_override().ok_or("Program folders is empty now: nothing needs changing.")?;
    if current != was {
        return Err("Program folders changed since Plyloft looked. Press Try again.".into());
    }
    Ok(current)
}

/// `program_folders_check(value)`: the reading of a candidate value, for the
/// Program folders row (on save and when the page opens) and Diagnostics.
#[tauri::command(async)]
pub fn program_folders_check(value: String) -> Verdict {
    read_list(&value, &Ctx::now(), &SystemDisk)
}

#[cfg(test)]
#[path = "program_folders_tests.rs"]
mod tests;
