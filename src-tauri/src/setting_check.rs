//! 1.176.1: the free-text settings that can stop work, read before they do.
//!
//! On 2026-11-21 one free-text setting (Program folders holding
//! `~/.local/bin/claude`) stopped every tile on the owner's MacBook for a day
//! and nothing said so. `program_folders.rs` reads that one field; this module
//! reads the others the same way: a pure reader per kind of value, over a
//! [`Look`] at the disk and a [`Ctx`] of strings (with a `windows` flag, so the
//! Windows forms are tested on the Mac), behind one IPC command,
//! [`setting_check`]. The words are the frontend's (`src/lib/settingCheck.ts`);
//! this says what the value is.
//!
//! Every check is cheap: file metadata, a directory listing at most, and a
//! read of a small project file (`package.json`, a Makefile). No network, no
//! process, never per keystroke: the field asks on the person's save and when
//! its page opens.
//!
//! What a reading decides ([`Level`]), field by field, and why (owner's rule,
//! 2026-11-21: warn and ask, don't refuse; never save a value that certainly
//! can't work; never rewrite without a press; report a saved broken value, don't
//! change it):
//!
//! **Tile shell** (`shell.tileShell`; every new shell tile, and Try it's tile,
//! spawn it as one program with the cached PATH, `pty.rs::pty_command`):
//! - **Refused** (not saved as typed): a folder; a file that isn't runnable; a
//!   name no program folder holds; a path that isn't there on a disk that is;
//!   `~name`; a variable (`$HOME/…`, `%LOCALAPPDATA%\…`: a spawn reads it literally,
//!   so the one-press fix is the value written out); a program followed by
//!   arguments (`zsh -i`: spawned as one name; the fix is the program alone).
//!   Each of these makes every new shell tile fail at once, so none is saved.
//! - **Asked** (saved after a confirmation that names the consequence): a path
//!   on a disk that isn't connected (`/Volumes/Tools/…`, `E:\…`): it works
//!   again once the disk is back; a program Plyloft doesn't know as a shell
//!   (`tmux`, `vim`): it may be meant, and tiles then run it in place of one;
//!   a relative path (`bin/zsh`): a spawn tries it in the tile's own folder,
//!   so it works in a project that holds it (walk audit, 1.176.1).
//! - **Hint**: a Windows value written as a Mac path to a shell (`/bin/zsh`):
//!   Windows tiles already run the default shell for it, so it works today.
//! - Written out on save, with no question: a leading `~`, quotes around the
//!   value (Explorer's "Copy as path" adds them); the field then says once
//!   what was saved, with the save's Undo. Spaces around it are trimmed where
//!   it is used, so they are neither a finding nor broken.
//! - The dictation footnote of the row stays as it was: a shell that can't take
//!   pasted text is the Diagnostics row's business, not a fault of the value.
//!
//! **Project commands** (Try it's command, the command each card's copy runs
//! before its Builder, and the Install script and Verify script steps, which
//! are chosen from a list and read here only as saved): never refused and
//! never asked — the command is the project's, a teammate's computer may have
//! what this one lacks, the shared ones are edited as a draft the Publish bar
//! holds, and Plyloft can't know every shell form. What certainly fails here
//! (the first word of a command found nowhere, `./x` or a script path missing
//! from the project, `npm run x` with no `x` in `package.json`, `make` with no
//! Makefile) is a **warning** under the field, on save and when the page
//! opens, before a card runs it. What may fail
//! (`make x` with no rule for `x` in a Makefile with no `include` or pattern
//! rule, a script file that isn't runnable where it runs as `./x`) is a
//! **hint** under the field. Builtins, `VAR=x cmd`, `cd … &&` (after which
//! relative words aren't judged), `$VAR` words and pipes are read, not
//! guessed at. Review 1: when the read isn't sure it says nothing —
//! redirections and their targets (`> log`, `2>&1`, `&> log`) are no words;
//! a here-document, `$(…)`, backticks or an open quote leave the line
//! unjudged; a script name after any flag (`-w web`, `--workspace`, `-r`,
//! `--filter`, `--prefix`, `--if-present`) or holding `/` or `.` (`bun run
//! src/index.ts`) isn't judged; `make` is judged only as the line's first
//! step and with no flags (`./configure && make`, `make -j 8 x`).
//! Try it's command is typed into the person's own interactive shell, whose
//! functions, aliases and startup files Plyloft can't read (`nvm`, `conda`,
//! PowerShell's cmdlets): a word not found there is a **hint**
//! ([`Finding::NotFoundHere`]), never a broken setting; the command each
//! card's copy runs goes through `bash -c` with the cached PATH, so its
//! warning is accurate.
//!
//! **Folders** (where team projects are cloned, the projects folder):
//! - **Refused**: a file; a folder that exists but can't be written to.
//! - **Asked**: a folder on a disk that isn't connected (clones fail until it
//!   is back); a relative folder or `~name` (resolved against the app's own
//!   folder, which may work, as in a dev build). Neither is reported as broken
//!   once saved.
//! - Not judged (walk, 1.176.1): a folder inside Plyloft's own data. The team
//!   test setup keeps its clones there and it works; nothing in Plyloft
//!   removes that folder.
//! - **Hint**: a folder that doesn't exist yet on a disk that is there:
//!   Plyloft creates it with the first project it puts there. A link (the
//!   folder or one above it) whose target is away is asked about like a disk
//!   that isn't connected, never "created" (`symlink_metadata`).
//! - The projects folder is stored with `~` by design (`projects.folder`), so
//!   its `~` is kept as typed; elsewhere a leading `~` is written out on save.
//!
//! A value already saved is never rewritten by itself: the reading of the
//! saved value (`typed: false` on the frontend) only reports, and offers the
//! same corrections as presses.

use serde::{Deserialize, Serialize};

pub use crate::program_folders::PathKind;

/// What kind of value is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckKind {
    /// `shell.tileShell`.
    TileShell,
    /// A shell command run in the project folder (Try it, Install script).
    Command,
    /// A project-relative script path run with bash (Verify's script steps).
    Script,
    /// A folder Plyloft puts projects in.
    Folder,
}

/// What the reading decides for a typed value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// Saved; nothing to say.
    Ok,
    /// Saved; a line under the field says something worth knowing.
    Hint,
    /// Saved; the line under the field says it will fail here.
    Warn,
    /// Saved only after a confirmation that names the consequence.
    Confirm,
    /// Not saved as typed.
    Blocked,
}

/// One thing the reading found. Worded by `settingCheck.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Finding {
    /// Written with a leading `~` (a spawn reads it literally); `written` is
    /// the value with the home written out.
    Tilde { written: String },
    /// Spaces or quotes around the value.
    Untidy,
    /// `~name…`: another account's home.
    OtherHome,
    /// A variable a spawn reads literally (`$HOME`, `%LOCALAPPDATA%`).
    Variable { name: String },
    /// Not written in full (no leading `/`, no drive letter).
    Relative,
    /// A bare program name none of the program folders holds.
    ProgramNotFound { name: String },
    /// A file that can't be run.
    NotRunnable { path: String },
    /// A folder where a program is expected.
    IsFolder { path: String },
    /// Nothing there, on a disk that is.
    Missing { path: String },
    /// The disk (Mac: `/Volumes/Name`; Windows: a drive or a share) isn't
    /// connected.
    DiskAbsent { disk: String },
    /// `link` (the path or a folder above it) is a link whose target isn't
    /// there.
    LinkAway { link: String, target: String },
    /// Try it only: a word not found in the folders Plyloft knows. It is typed
    /// into the person's own shell, whose functions, aliases and startup
    /// files Plyloft can't read, so it may well be there.
    NotFoundHere { word: String },
    /// A program followed by more words; `program` is the first word.
    HasArguments { program: String },
    /// A program Plyloft doesn't know as a shell.
    NotAShell { name: String },
    /// Windows: a Mac path to a shell; tiles run the default shell instead.
    MacShellPath,
    /// A command's word found nowhere (in the project for `./x`, else in the
    /// program folders tiles get).
    CommandNotFound { word: String },
    /// A project file the command or step names isn't in the project.
    ProjectFileMissing { path: String },
    /// `npm run x` (and the like) with no `x` among `package.json`'s scripts.
    NoScript { script: String, tool: String },
    /// `npm run …` in a project with no `package.json`.
    NoPackageJson,
    /// `make` in a project with no Makefile.
    NoMakefile,
    /// `make x` with no rule for `x` (in a Makefile without includes or
    /// pattern rules).
    NoMakeTarget { target: String },
    /// A file where a folder is expected.
    NotAFolder { path: String },
    /// A folder that can't be written to.
    NotWritable { path: String },
    /// Not there yet; Plyloft creates it when it is first needed.
    WillBeCreated { path: String },
}

impl Finding {
    /// What this finding decides for a typed value of `kind`.
    pub fn level(&self, kind: CheckKind) -> Level {
        use Finding::*;
        let command = matches!(kind, CheckKind::Command | CheckKind::Script);
        match self {
            Tilde { .. } | Untidy | WillBeCreated { .. } | MacShellPath | NoMakeTarget { .. } | NotFoundHere { .. } => {
                Level::Hint
            }
            // A script that isn't runnable runs anyway when bash is handed
            // it (Verify's steps); as `./x` it doesn't.
            NotRunnable { .. } if command => Level::Hint,
            _ if command => Level::Warn,
            DiskAbsent { .. } | LinkAway { .. } | NotAShell { .. } => Level::Confirm,
            // Walk audit (1.176.1): resolved against a folder that differs by
            // where it runs, so it may work today; asked, never refused.
            Relative => Level::Confirm,
            OtherHome if kind == CheckKind::Folder => Level::Confirm,
            _ => Level::Blocked,
        }
    }
}

/// The whole reading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub kind: CheckKind,
    pub windows: bool,
    pub level: Level,
    /// Most important first.
    pub findings: Vec<Finding>,
    /// What the value stands for: the program a tile runs, the folder.
    pub resolved: Option<String>,
    /// What a save stores (trimmed, `~` written out where a spawn reads it
    /// literally). `None` while the value is refused.
    pub save_as: Option<String>,
    /// The one-press correction, when there is one: the program alone, the
    /// variable written out, the folder that holds the file.
    pub fix: Option<String>,
    /// The value as written can't work where Plyloft uses it (for a saved
    /// value: say so, with the correction).
    pub broken: bool,
}

/// The disk, behind a trait so the readers are tested with a fake one.
pub trait Look {
    fn kind(&self, path: &str) -> PathKind;
    /// A file that a spawn can run (Mac: an execute bit; Windows: a PATHEXT
    /// extension).
    fn runnable(&self, path: &str) -> bool;
    /// The program `name` in `dir`, as a spawn would find it (on Windows
    /// with PATHEXT); only one that can be run.
    fn program(&self, dir: &str, name: &str) -> Option<String>;
    /// A folder this account can create files in.
    fn writable(&self, dir: &str) -> bool;
    /// A small text file (a `package.json`, a Makefile), at most 256 KB.
    fn read_small(&self, path: &str) -> Option<String>;
    /// `path` is a link whose target isn't there: the target.
    fn link_away(&self, path: &str) -> Option<String>;
}

/// The real disk.
pub struct SystemLook;

const SMALL: u64 = 256 * 1024;

impl Look for SystemLook {
    fn kind(&self, path: &str) -> PathKind {
        crate::program_folders::SystemDisk.kind(path)
    }

    fn runnable(&self, path: &str) -> bool {
        crate::shell_env::is_executable_file(std::path::Path::new(path))
    }

    fn program(&self, dir: &str, name: &str) -> Option<String> {
        crate::platform::program_candidates(std::path::Path::new(dir), name)
            .into_iter()
            .find(|c| crate::shell_env::is_executable_file(c))
            .map(|c| c.to_string_lossy().into_owned())
    }

    fn writable(&self, dir: &str) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let Ok(c) = std::ffi::CString::new(std::ffi::OsStr::new(dir).as_bytes()) else { return false };
            // SAFETY: a valid NUL-terminated path; access() only reads it.
            unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
        }
        #[cfg(not(unix))]
        {
            // Windows' read-only attribute means nothing on a folder: the
            // one honest answer is a file created and removed again.
            tempfile::Builder::new().prefix(".plyloft-check-").tempfile_in(dir).is_ok()
        }
    }

    fn link_away(&self, path: &str) -> Option<String> {
        let p = std::path::Path::new(path);
        let link = std::fs::symlink_metadata(p).ok()?;
        if !link.file_type().is_symlink() || std::fs::metadata(p).is_ok() {
            return None;
        }
        let target = std::fs::read_link(p).ok()?;
        let target = if target.is_absolute() { target } else { p.parent()?.join(target) };
        Some(target.to_string_lossy().into_owned())
    }

    fn read_small(&self, path: &str) -> Option<String> {
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() || meta.len() > SMALL {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }
}

use crate::program_folders::Disk as _;

/// What the reading knows besides the disk.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub windows: bool,
    pub home: Option<String>,
    /// The PATH new tiles get (the cached one, `shell_env::get().path`).
    pub path: String,
    /// Variables a fix may write out (`HOME`, `USERPROFILE`, `LOCALAPPDATA`…).
    pub vars: Vec<(String, String)>,
}

impl Ctx {
    fn var(&self, name: &str) -> Option<String> {
        let same = |k: &str| if self.windows { k.eq_ignore_ascii_case(name) } else { k == name };
        if same("HOME") || (self.windows && same("USERPROFILE")) {
            if let Some(home) = self.home.clone() {
                return Some(home);
            }
        }
        self.vars.iter().find(|(k, _)| same(k)).map(|(_, v)| v.clone()).filter(|v| !v.is_empty())
    }

    fn path_dirs(&self) -> Vec<String> {
        let sep = if self.windows { ';' } else { ':' };
        self.path
            .split(sep)
            .map(|d| d.trim().trim_matches('"').to_string())
            .filter(|d| !d.is_empty() && crate::cli_health::is_absolute(d, self.windows))
            .collect()
    }
}

/// What the field is for, besides its kind.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckContext {
    /// The project folder a command runs in.
    pub project: Option<String>,
    /// Folder: stored with `~` by design and expanded where it is used
    /// (`team.cloneRoot`).
    pub keeps_tilde: bool,
    /// Command: typed into the person's own interactive shell (Try it), not
    /// run by `bash -c` with the cached PATH: a word not found is a hint.
    pub interactive: bool,
}

fn has_sep(text: &str, windows: bool) -> bool {
    text.contains('/') || (windows && text.contains('\\'))
}

fn file_name(path: &str, windows: bool) -> &str {
    let cut = if windows { path.rfind(['/', '\\']) } else { path.rfind('/') };
    cut.map(|i| &path[i + 1..]).unwrap_or(path)
}

/// The value without spaces or one pair of quotes around it.
fn tidy(value: &str) -> &str {
    let t = value.trim();
    let unq = t
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .or_else(|| t.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')))
        .unwrap_or(t);
    unq.trim()
}

/// `~` and `~/…` (`~\…` on Windows) with the home written out; `Err(())` for
/// `~name`; `Ok(None)` without a leading `~`.
fn expand_tilde(text: &str, ctx: &Ctx) -> Result<Option<String>, ()> {
    if !text.starts_with('~') {
        return Ok(None);
    }
    let rest = if text == "~" {
        Some("")
    } else {
        text.strip_prefix("~/").or_else(|| if ctx.windows { text.strip_prefix("~\\") } else { None })
    };
    let Some(rest) = rest else { return Err(()) };
    let Some(home) = ctx.home.as_deref() else { return Ok(None) };
    Ok(Some(if rest.is_empty() {
        home.to_string()
    } else {
        crate::cli_health::join(home, &[rest], ctx.windows)
    }))
}

/// The disk an absolute path lives on, when it is one that can be away: Mac
/// `/Volumes/Name`; Windows a drive root (`E:\`) or a share (`\\server\share`).
pub fn disk_of(path: &str, windows: bool) -> Option<String> {
    if windows {
        let b = path.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return Some(format!("{}:\\", (b[0] as char).to_ascii_uppercase()));
        }
        if let Some(rest) = path.strip_prefix("\\\\") {
            let mut parts = rest.split(['\\', '/']).filter(|p| !p.is_empty());
            let (server, share) = (parts.next()?, parts.next()?);
            return Some(format!("\\\\{server}\\{share}"));
        }
        return None;
    }
    let rest = path.strip_prefix("/Volumes/")?;
    let name = rest.split('/').next().filter(|n| !n.is_empty())?;
    Some(format!("/Volumes/{name}"))
}

/// The disk `path` is on, when that disk isn't there (the system drive
/// always is).
fn disk_away(path: &str, windows: bool, look: &dyn Look) -> Option<String> {
    disk_of(path, windows).filter(|disk| look.kind(disk) == PathKind::Absent)
}

/// Something absent at `path`: a missing file, a disk that isn't there, or a
/// link (`path` or a folder above it) whose target is away — the owner's
/// `~/ply-build` links to an external disk.
fn absent(path: &str, windows: bool, look: &dyn Look) -> Finding {
    if let Some(disk) = disk_away(path, windows, look) {
        return Finding::DiskAbsent { disk };
    }
    let mut at = Some(path.to_string());
    while let Some(p) = at {
        if let Some(target) = look.link_away(&p) {
            return match disk_away(&target, windows, look) {
                Some(disk) => Finding::DiskAbsent { disk },
                None => Finding::LinkAway { link: p, target },
            };
        }
        let up = crate::cli_health::parent(&p, windows).map(str::to_string);
        at = up.filter(|u| *u != p);
    }
    Finding::Missing { path: path.to_string() }
}

/// Shells Plyloft knows (their file stem, lowercase).
pub const KNOWN_SHELLS: [&str; 21] = [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "yash", "nu", "nushell", "xonsh", "elvish",
    "pwsh", "powershell", "cmd", "osh", "ysh", "ion", "wsl",
];

/// The shells `pty_command` replaces with Windows' default for a Mac path.
const UNIX_SHELLS: [&str; 7] = ["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh"];

fn stem(path: &str, windows: bool) -> String {
    let name = file_name(path, windows).to_ascii_lowercase();
    if windows {
        if let Some((s, ext)) = name.rsplit_once('.') {
            if ["exe", "cmd", "bat", "com"].contains(&ext) {
                return s.to_string();
            }
        }
    }
    name
}

/// The first variable in `text`, unless it is a literal part of a name that
/// is there.
fn variable_in(text: &str) -> Option<String> {
    crate::program_folders::variables_in(text).into_iter().next()
}

fn finish(kind: CheckKind, windows: bool, findings: Vec<Finding>, resolved: Option<String>, save_as: Option<String>, fix: Option<String>, broken: bool) -> Reading {
    let level = findings.iter().map(|f| f.level(kind)).max().unwrap_or(Level::Ok);
    Reading {
        kind,
        windows,
        level,
        save_as: if level == Level::Blocked { None } else { save_as },
        findings,
        resolved,
        fix,
        broken,
    }
}

/// Where a program named in full is, or what is wrong with it.
fn read_program_path(path: &str, ctx: &Ctx, look: &dyn Look) -> Result<String, Finding> {
    let w = ctx.windows;
    match look.kind(path) {
        PathKind::Dir => Err(Finding::IsFolder { path: path.to_string() }),
        PathKind::File if look.runnable(path) => Ok(path.to_string()),
        PathKind::File => Err(Finding::NotRunnable { path: path.to_string() }),
        PathKind::Absent => {
            // Windows: `C:\…\pwsh` without its extension, as a spawn finds it.
            if w {
                if let Some(dir) = crate::cli_health::parent(path, w) {
                    if let Some(found) = look.program(dir, file_name(path, w)) {
                        return Ok(found);
                    }
                }
            }
            Err(absent(path, w, look))
        }
    }
}

/// A bare program name on the program folders tiles get.
fn find_on_path(name: &str, ctx: &Ctx, look: &dyn Look) -> Option<String> {
    ctx.path_dirs().iter().find_map(|d| look.program(d, name))
}

/// Read `value` as the Tile shell.
pub fn read_tile_shell(value: &str, ctx: &Ctx, look: &dyn Look) -> Reading {
    let kind = CheckKind::TileShell;
    let w = ctx.windows;
    let text = tidy(value);
    if text.is_empty() {
        return finish(kind, w, Vec::new(), None, Some(String::new()), None, false);
    }
    let mut findings: Vec<Finding> = Vec::new();
    // Spaces around it are trimmed where it is used; quotes are not.
    let untidy = text != value.trim();
    if untidy {
        findings.push(Finding::Untidy);
    }
    // Windows tiles run the default shell for a Mac path to a shell
    // (`pty_command`): it works, and says nothing.
    if w && text.starts_with('/') {
        let s = stem(text, false);
        if UNIX_SHELLS.contains(&s.as_str()) && !text.contains(' ') && look.kind(text) == PathKind::Absent {
            findings.insert(0, Finding::MacShellPath);
            return finish(kind, w, findings, None, Some(text.to_string()), None, false);
        }
    }
    let tilde = match expand_tilde(text, ctx) {
        Err(()) => {
            findings.insert(0, Finding::OtherHome);
            return finish(kind, w, findings, None, None, None, true);
        }
        Ok(t) => t,
    };
    let candidate = tilde.clone().unwrap_or_else(|| text.to_string());
    // A variable: read literally by a spawn, so never saved as typed; the fix
    // is the value written out, when that is a program.
    if let Some(name) = variable_in(&candidate).filter(|_| look.kind(&candidate) == PathKind::Absent) {
        let lookup = |n: &str| ctx.var(n);
        let written = crate::program_folders::expand_vars(&candidate, &lookup);
        let fix = written.filter(|p| read_program_path(p, ctx, look).is_ok());
        findings.insert(0, Finding::Variable { name });
        return finish(kind, w, findings, None, None, fix, true);
    }
    let resolved = if has_sep(&candidate, w) {
        if !crate::cli_health::is_absolute(&candidate, w) {
            Err(Finding::Relative)
        } else {
            read_program_path(&candidate, ctx, look)
        }
    } else {
        find_on_path(&candidate, ctx, look).ok_or_else(|| Finding::ProgramNotFound { name: candidate.clone() })
    };
    let resolved = match resolved {
        Ok(p) => p,
        Err(finding) => {
            // `zsh -i`, `/bin/bash --login`: spawned as one name. A path with
            // spaces in it (`C:\Program Files\…`) was read whole above.
            if candidate.contains(char::is_whitespace) {
                let words: Vec<&str> = candidate.split_whitespace().collect();
                let runs = |p: &str| {
                    if has_sep(p, w) {
                        crate::cli_health::is_absolute(p, w) && read_program_path(p, ctx, look).is_ok()
                    } else {
                        find_on_path(p, ctx, look).is_some()
                    }
                };
                // `/usr/bin/env zsh`: the program is the one env runs.
                let program = if stem(words[0], w) == "env" {
                    words[1..].iter().find(|x| !x.starts_with('-') && !is_assignment(x)).copied()
                } else {
                    Some(words[0])
                };
                if let Some(program) = program.filter(|p| runs(p)) {
                    findings.insert(0, Finding::HasArguments { program: program.to_string() });
                    return finish(kind, w, findings, None, None, Some(program.to_string()), true);
                }
                // Windows walk: `pwsh -NoLogo` where pwsh isn't there. The
                // options come first, then what is true of the program on its
                // own — and no correction, since none would work.
                let options = words[1..].iter().any(|x| x.starts_with('-'));
                if let (Some(program), true) = (program, options) {
                    let alone = if has_sep(program, w) {
                        if crate::cli_health::is_absolute(program, w) {
                            read_program_path(program, ctx, look).err()
                        } else {
                            Some(Finding::Relative)
                        }
                    } else {
                        Some(Finding::ProgramNotFound { name: program.to_string() })
                    };
                    findings.insert(0, Finding::HasArguments { program: program.to_string() });
                    if let Some(f) = alone {
                        findings.insert(1, f);
                    }
                    return finish(kind, w, findings, None, None, None, true);
                }
            }
            let disk_away = matches!(finding, Finding::DiskAbsent { .. } | Finding::LinkAway { .. });
            // `bin/zsh`: a spawn tries it in the tile's own folder, so it can
            // work in a project that holds it. Asked, and not broken.
            let relative = finding == Finding::Relative;
            findings.insert(0, finding);
            let save = (disk_away || relative).then(|| candidate.clone());
            // A disk that isn't connected: asked, saved as written (`~`
            // written out).
            return finish(kind, w, findings, None, save, None, !relative);
        }
    };
    if let Some(written) = tilde {
        findings.push(Finding::Tilde { written: written.clone() });
    }
    let s = stem(&resolved, w);
    if !KNOWN_SHELLS.contains(&s.as_str()) {
        findings.insert(0, Finding::NotAShell { name: file_name(&resolved, w).to_string() });
    }
    // Broken as written: a `~` a spawn reads literally, quotes around it.
    let broken = untidy || findings.iter().any(|f| matches!(f, Finding::Tilde { .. }));
    let fix = broken.then(|| candidate.clone());
    finish(kind, w, findings, Some(resolved), Some(candidate), fix, broken)
}

/// Read `value` as a folder Plyloft puts projects in.
pub fn read_folder(value: &str, context: &CheckContext, ctx: &Ctx, look: &dyn Look) -> Reading {
    let kind = CheckKind::Folder;
    let w = ctx.windows;
    let text = tidy(value);
    if text.is_empty() {
        return finish(kind, w, Vec::new(), None, Some(String::new()), None, false);
    }
    let mut findings: Vec<Finding> = Vec::new();
    if text != value.trim() {
        findings.push(Finding::Untidy);
    }
    // Walk audit: `~name/…` and a relative folder are resolved against the
    // app's own folder (`team::clone_root`), which may work (a dev build);
    // asked on a typed value, never reported as broken.
    let tilde = match expand_tilde(text, ctx) {
        Err(()) => {
            findings.insert(0, Finding::OtherHome);
            return finish(kind, w, findings, None, Some(text.to_string()), None, false);
        }
        Ok(t) => t,
    };
    let path = tilde.clone().unwrap_or_else(|| text.to_string());
    if !crate::cli_health::is_absolute(&path, w) {
        findings.insert(0, Finding::Relative);
        return finish(kind, w, findings, None, Some(text.to_string()), None, false);
    }
    // Stored as typed where `~` is the field's own form; written out
    // elsewhere (the field's users don't expand it).
    let save = if context.keeps_tilde { text.to_string() } else { path.clone() };
    let fix_tilde = tilde.as_ref().filter(|_| !context.keeps_tilde).map(|written| Finding::Tilde { written: written.clone() });
    // Walk (1.176.1): a folder inside Plyloft's own data is not judged. The
    // team test setup keeps its clones there and it works; nothing in
    // Plyloft removes that folder (Reset this Mac resets the settings file).
    match look.kind(&path) {
        PathKind::File => {
            let folder = crate::cli_health::parent(&path, w).map(str::to_string);
            findings.insert(0, Finding::NotAFolder { path: path.clone() });
            finish(kind, w, findings, Some(path), None, folder, true)
        }
        PathKind::Dir => {
            if !look.writable(&path) {
                findings.insert(0, Finding::NotWritable { path: path.clone() });
                return finish(kind, w, findings, Some(path), None, None, true);
            }
            let broken = fix_tilde.is_some();
            findings.extend(fix_tilde);
            let fix = broken.then(|| path.clone());
            finish(kind, w, findings, Some(path), Some(save), fix, broken)
        }
        PathKind::Absent => {
            match absent(&path, w, look) {
                away @ (Finding::DiskAbsent { .. } | Finding::LinkAway { .. }) => {
                    findings.insert(0, away);
                    finish(kind, w, findings, Some(path), Some(save), None, false)
                }
                _ => {
                    // The nearest folder that is there must take a new one.
                    let mut up = crate::cli_health::parent(&path, w).map(str::to_string);
                    while let Some(dir) = up.clone() {
                        match look.kind(&dir) {
                            PathKind::Dir => break,
                            PathKind::File => {
                                findings.insert(0, Finding::NotAFolder { path: dir.clone() });
                                return finish(kind, w, findings, Some(path), None, None, true);
                            }
                            PathKind::Absent => {
                                let next = crate::cli_health::parent(&dir, w).map(str::to_string);
                                if next.as_deref() == Some(dir.as_str()) {
                                    up = None;
                                } else {
                                    up = next;
                                }
                            }
                        }
                    }
                    if let Some(dir) = up.filter(|d| !look.writable(d)) {
                        findings.insert(0, Finding::NotWritable { path: dir });
                        return finish(kind, w, findings, Some(path), None, None, true);
                    }
                    findings.insert(0, Finding::WillBeCreated { path: path.clone() });
                    findings.extend(fix_tilde);
                    finish(kind, w, findings, Some(path), Some(save), None, false)
                }
            }
        }
    }
}

/// Words a shell runs itself: never looked for on disk.
const BUILTINS: [&str; 40] = [
    "cd", "export", "source", ".", "set", "unset", "echo", "printf", "test", "[", "[[", "true", "false", "exit",
    "eval", "alias", "pushd", "popd", ":", "read", "wait", "ulimit", "umask", "trap", "type", "shift", "local",
    "return", "if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "{", "!",
];
/// Builtins whose next word is the program they run.
const PREFIXES: [&str; 6] = ["exec", "command", "env", "time", "nohup", "builtin"];

/// The simple commands of a line: each one's words, as a shell splits them
/// (quotes dropped, redirections and their targets left out), in order.
/// `None` when the line holds something a plain read can't be sure of (a
/// here-document, `$(…)` or backticks, an open quote): then nothing is said.
///
/// `escapes`: a backslash escapes the next character (bash, Git Bash
/// included); in PowerShell (Try it's tile on Windows) it is a path's.
fn simple_commands(line: &str, escapes: bool) -> Option<Vec<Vec<String>>> {
    let mut out: Vec<Vec<String>> = vec![Vec::new()];
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    // The next word is a redirection's target (`> log`), not an argument.
    let mut target = false;
    let mut chars = line.chars().peekable();
    fn end_word(out: &mut [Vec<String>], word: &mut String, in_word: &mut bool, target: &mut bool) {
        if *in_word {
            let w = std::mem::take(word);
            if *target {
                *target = false;
            } else {
                out.last_mut().expect("one").push(w);
            }
            *in_word = false;
        }
    }
    fn split(out: &mut Vec<Vec<String>>) {
        if !out.last().expect("one").is_empty() {
            out.push(Vec::new());
        }
    }
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && q == '"' && escapes {
                if let Some(n) = chars.next() {
                    word.push(n);
                }
            } else if q == '"' && (c == '`' || (c == '$' && chars.peek() == Some(&'('))) {
                return None;
            } else {
                word.push(c);
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                in_word = true;
            }
            '\\' if escapes => {
                if let Some(n) = chars.next() {
                    word.push(n);
                    in_word = true;
                }
            }
            '`' => return None,
            '$' if chars.peek() == Some(&'(') => return None,
            '#' if !in_word => break,
            '>' | '<' => {
                // `2>&1`, `2> err`: the fd number is not a word.
                if in_word && !word.is_empty() && word.chars().all(|d| d.is_ascii_digit()) {
                    word.clear();
                    in_word = false;
                } else {
                    end_word(&mut out, &mut word, &mut in_word, &mut target);
                }
                if c == '<' && chars.peek() == Some(&'<') {
                    return None;
                }
                if chars.peek() == Some(&c) || chars.peek() == Some(&'|') {
                    chars.next();
                }
                if chars.peek() == Some(&'&') {
                    chars.next();
                    // `>&2`, `>&-`: a duplicate, no target.
                    if chars.peek().is_some_and(|d| d.is_ascii_digit() || *d == '-') {
                        while chars.peek().is_some_and(|d| d.is_ascii_digit() || *d == '-') {
                            chars.next();
                        }
                        continue;
                    }
                }
                target = true;
            }
            '&' => {
                end_word(&mut out, &mut word, &mut in_word, &mut target);
                if chars.peek() == Some(&'>') {
                    // `&> log`, `&>> log`.
                    chars.next();
                    if chars.peek() == Some(&'>') {
                        chars.next();
                    }
                    target = true;
                } else {
                    if chars.peek() == Some(&'&') {
                        chars.next();
                    }
                    split(&mut out);
                }
            }
            ';' | '|' | '\n' | '(' | ')' => {
                end_word(&mut out, &mut word, &mut in_word, &mut target);
                split(&mut out);
            }
            c if c.is_whitespace() => end_word(&mut out, &mut word, &mut in_word, &mut target),
            _ => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() || target && !in_word {
        return None;
    }
    end_word(&mut out, &mut word, &mut in_word, &mut target);
    out.retain(|c| !c.is_empty());
    Some(out)
}

fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit()),
        None => false,
    }
}

/// The scripts of the project's `package.json`, `None` without one (or when
/// it can't be read as JSON).
fn package_scripts(project: &str, ctx: &Ctx, look: &dyn Look) -> Option<Vec<String>> {
    let text = look.read_small(&crate::cli_health::join(project, &["package.json"], ctx.windows))?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(v.get("scripts").and_then(|s| s.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default())
}

/// The project's Makefile, by the names make reads.
fn makefile(project: &str, ctx: &Ctx, look: &dyn Look) -> Option<String> {
    ["GNUmakefile", "makefile", "Makefile"]
        .iter()
        .find_map(|n| look.read_small(&crate::cli_health::join(project, &[n], ctx.windows)))
}

/// A Makefile names `target` as a rule, as far as a plain read says: `None`
/// when it can't say (an `include`, a pattern rule, a variable in a target).
fn make_has_target(makefile: &str, target: &str) -> Option<bool> {
    let mut found = false;
    for line in makefile.lines() {
        let t = line.trim_start();
        if line.starts_with('\t') || t.starts_with('#') {
            continue;
        }
        if t.starts_with("include ") || t.starts_with("-include ") || t.starts_with("sinclude ") {
            return None;
        }
        let Some((targets, rest)) = t.split_once(':') else { continue };
        // `VAR := x`, `VAR ::= x` are assignments, not rules.
        if rest.starts_with('=') || targets.contains('=') {
            continue;
        }
        if targets.contains('%') || targets.contains('$') {
            return None;
        }
        if targets.split_whitespace().any(|n| n == target) {
            found = true;
        }
    }
    Some(found)
}

/// One command word: in the project for `./x`, else on the program folders.
fn read_word(word: &str, cwd_known: bool, interactive: bool, project: Option<&str>, ctx: &Ctx, look: &dyn Look) -> Option<Finding> {
    let w = ctx.windows;
    // PowerShell's own commands (`Remove-Item`, `Set-Location`) in Try it's
    // tile on Windows.
    let cmdlet = |x: &str| {
        x.split_once('-').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && a.chars().chain(b.chars()).all(|c| c.is_ascii_alphabetic()))
    };
    if interactive && w && cmdlet(word) {
        return None;
    }
    if word.is_empty() || word.contains('$') || word.contains('`') || word.contains('*') || (w && word.contains('%')) {
        return None;
    }
    let word = match expand_tilde(word, ctx) {
        Ok(Some(t)) => t,
        Ok(None) => word.to_string(),
        Err(()) => return None,
    };
    if has_sep(&word, w) {
        let path = if crate::cli_health::is_absolute(&word, w) {
            word.clone()
        } else {
            // After a `cd`, or without the project, a relative word isn't
            // judged.
            let (Some(project), true) = (project, cwd_known) else { return None };
            let rel = word.strip_prefix("./").or_else(|| if w { word.strip_prefix(".\\") } else { None }).unwrap_or(&word);
            crate::cli_health::join(project, &[rel], w)
        };
        // PowerShell runs a `.ps1` the file system doesn't mark runnable.
        let ps1 = w && interactive && word.to_ascii_lowercase().ends_with(".ps1");
        return match look.kind(&path) {
            PathKind::File if look.runnable(&path) || ps1 => None,
            PathKind::File => Some(Finding::NotRunnable { path: word }),
            PathKind::Dir => Some(Finding::IsFolder { path: word }),
            PathKind::Absent => {
                if w {
                    if let Some(dir) = crate::cli_health::parent(&path, w) {
                        if look.program(dir, file_name(&path, w)).is_some() {
                            return None;
                        }
                    }
                }
                Some(if crate::cli_health::is_absolute(&word, w) { absent(&path, w, look) } else { Finding::ProjectFileMissing { path: word } })
            }
        };
    }
    let lower = word.to_ascii_lowercase();
    if BUILTINS.contains(&word.as_str()) || (w && ["cmd", "start", "call", "set", "if", "copy", "del", "dir", "type", "rem"].contains(&lower.as_str())) {
        return None;
    }
    if find_on_path(&word, ctx, look).is_some() {
        return None;
    }
    // Typed into the person's own shell, which may add it (a function, an
    // alias, its startup files): a hint, never a certainty.
    Some(if interactive { Finding::NotFoundHere { word } } else { Finding::CommandNotFound { word } })
}

/// Read `value` as a command line Plyloft types in a tile or runs in the
/// project folder (`context.project`).
pub fn read_command(value: &str, context: &CheckContext, ctx: &Ctx, look: &dyn Look) -> Reading {
    let kind = CheckKind::Command;
    let w = ctx.windows;
    let text = value.trim();
    if text.is_empty() {
        return finish(kind, w, Vec::new(), None, Some(String::new()), None, false);
    }
    let project = context.project.as_deref().filter(|p| !p.trim().is_empty());
    let mut findings: Vec<Finding> = Vec::new();
    let mut cwd_known = true;
    let push = |findings: &mut Vec<Finding>, f: Finding| {
        if !findings.contains(&f) {
            findings.push(f);
        }
    };
    let Some(commands) = simple_commands(text, !(w && context.interactive)) else {
        return finish(kind, w, Vec::new(), None, Some(text.to_string()), None, false);
    };
    for (nth, words) in commands.into_iter().enumerate() {
        let mut i = 0;
        while i < words.len() && is_assignment(&words[i]) {
            i += 1;
        }
        while i < words.len() && PREFIXES.contains(&words[i].as_str()) {
            i += 1;
            while i < words.len() && (words[i].starts_with('-') || is_assignment(&words[i])) {
                i += 1;
            }
        }
        let Some(first) = words.get(i) else { continue };
        if first == "cd" || first == "pushd" || first == "popd" {
            cwd_known = false;
            continue;
        }
        if let Some(f) = read_word(first, cwd_known, context.interactive, project, ctx, look) {
            push(&mut findings, f);
            continue;
        }
        let rest = &words[i + 1..];
        let (Some(project), true) = (project, cwd_known) else { continue };
        let tool = stem(first, w);
        // `npm run x`, `npm test`, `pnpm run x`, `yarn run x`. Any flag before
        // `--` (`-w web`, `--workspace`, `-r`, `--filter`, `--prefix`,
        // `--if-present`) may change where or whether the script is looked
        // up, and a name with `/` or `.` is a file (`bun run src/index.ts`):
        // not judged.
        let own_args = |from: usize| -> Option<Vec<&String>> {
            let args: Vec<&String> = rest.iter().skip(from).take_while(|a| a.as_str() != "--").collect();
            (!args.iter().any(|a| a.starts_with('-'))).then_some(args)
        };
        let script = match (tool.as_str(), rest.first().map(String::as_str)) {
            ("npm" | "pnpm" | "yarn" | "bun", Some("run" | "run-script")) => {
                own_args(1).and_then(|a| a.first().map(|s| s.to_string()))
            }
            ("npm" | "pnpm", Some("test" | "t")) => own_args(1).map(|_| "test".to_string()),
            _ => None,
        }
        .filter(|s| !s.contains('/') && !s.contains('.') && !(w && s.contains('\\')));
        if let Some(script) = script {
            match package_scripts(project, ctx, look) {
                None if look.kind(&crate::cli_health::join(project, &["package.json"], w)) == PathKind::Absent => {
                    push(&mut findings, Finding::NoPackageJson)
                }
                None => {}
                Some(scripts) if !scripts.contains(&script) => push(&mut findings, Finding::NoScript { script, tool }),
                Some(_) => {}
            }
            continue;
        }
        if tool == "make" || tool == "gmake" {
            // Judged only as the line's first step (`./configure && make`
            // writes the Makefile first) and with no flags (`-C dir`, `-f
            // file`, `-j 8` take a value a plain read can't tell apart).
            if nth > 0 || rest.iter().any(|a| a.starts_with('-')) {
                continue;
            }
            match makefile(project, ctx, look) {
                None => push(&mut findings, Finding::NoMakefile),
                Some(text) => {
                    for target in rest.iter().filter(|a| !a.starts_with('-') && !a.contains('=')) {
                        if make_has_target(&text, target) == Some(false) {
                            push(&mut findings, Finding::NoMakeTarget { target: target.clone() });
                        }
                    }
                }
            }
        }
    }
    findings.sort_by_key(|f| std::cmp::Reverse(f.level(kind)));
    finish(kind, w, findings, None, Some(text.to_string()), None, false)
}

/// Read `value` as a project-relative script that bash runs (Verify's script
/// step, the Install script).
pub fn read_script(value: &str, context: &CheckContext, ctx: &Ctx, look: &dyn Look) -> Reading {
    let kind = CheckKind::Script;
    let w = ctx.windows;
    let text = value.trim();
    if text.is_empty() {
        return finish(kind, w, Vec::new(), None, Some(String::new()), None, false);
    }
    let mut findings = Vec::new();
    let mut resolved = None;
    if let Some(project) = context.project.as_deref().filter(|p| !p.trim().is_empty()) {
        let path = if crate::cli_health::is_absolute(text, w) {
            text.to_string()
        } else {
            let rel = text.strip_prefix("./").unwrap_or(text);
            crate::cli_health::join(project, &[rel], w)
        };
        match look.kind(&path) {
            PathKind::File => resolved = Some(path),
            PathKind::Dir => findings.push(Finding::IsFolder { path: text.to_string() }),
            PathKind::Absent => findings.push(Finding::ProjectFileMissing { path: text.to_string() }),
        }
    }
    finish(kind, w, findings, resolved, Some(text.to_string()), None, false)
}

/// Read a value of `kind`.
pub fn read(kind: CheckKind, value: &str, context: &CheckContext, ctx: &Ctx, look: &dyn Look) -> Reading {
    match kind {
        CheckKind::TileShell => read_tile_shell(value, ctx, look),
        CheckKind::Command => read_command(value, context, ctx, look),
        CheckKind::Script => read_script(value, context, ctx, look),
        CheckKind::Folder => read_folder(value, context, ctx, look),
    }
}

impl Ctx {
    /// This machine.
    pub fn now() -> Self {
        Self {
            windows: cfg!(windows),
            home: crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned()),
            path: crate::shell_env::try_get().map(|e| e.path.clone()).unwrap_or_default(),
            vars: std::env::vars().filter(|(k, _)| k != "PATH" && k != "Path").collect(),
        }
    }
}

/// `setting_check(kind, value, context)`: the reading of a candidate value,
/// for a settings field (on save and when its page opens) and Diagnostics.
#[tauri::command(async)]
pub fn setting_check(kind: CheckKind, value: String, context: Option<CheckContext>) -> Reading {
    read(kind, &value, &context.unwrap_or_default(), &Ctx::now(), &SystemLook)
}

#[cfg(test)]
#[path = "setting_check_tests.rs"]
mod tests;
