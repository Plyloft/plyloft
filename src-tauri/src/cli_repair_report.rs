//! 1.176.0 R4: the plain-text report a person can copy for support
//! ("Copy report"): the look at the tool (findings, copies with channel and
//! version, folders with owner and writability), the last install or update
//! (without its output unless asked), the app version and the OS. The home
//! folder is written `~` and the user name `<user>` everywhere, the output's
//! lines included. Read only.

use crate::cli_health::{CliHealth, CopyStart, FolderCheck};
use crate::setup_last_run::LastRun;

/// What the report says about this machine besides the look.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub app_version: String,
    pub os: String,
    pub home: Option<String>,
    pub user: Option<String>,
    /// This computer's name (it is in prompts and some paths).
    pub host: Option<String>,
    pub windows: bool,
    /// 1.176.1: where Plyloft looks for programs, and why.
    pub looked_in: Option<LookedIn>,
}

/// 1.176.1: the folders Plyloft looks in — the support question the owner had
/// to be asked three times.
#[derive(Debug, Clone, Default)]
pub struct LookedIn {
    /// The PATH tiles get (the snapshot's).
    pub path: String,
    /// It is the Program folders setting, not what the login shell reported.
    pub from_setting: bool,
    /// The setting's reading, when it is used.
    pub verdict: Option<crate::program_folders::Verdict>,
    /// The last probe's error.
    pub probe_error: Option<String>,
}

fn entry_words(e: &crate::program_folders::Entry) -> String {
    use crate::program_folders::EntryState;
    let mut out = match &e.state {
        EntryState::Folder => "folder".to_string(),
        EntryState::Missing => "folder that doesn't exist".to_string(),
        EntryState::File { folder } => format!("a file, not a folder (its folder: {folder})"),
        EntryState::Relative => "relative".to_string(),
        EntryState::Empty => "empty".to_string(),
        EntryState::OtherHome => "~ in a form that isn't the home (~name, ~+)".to_string(),
        EntryState::UnknownVariable { name } => format!("unknown variable {name}"),
        EntryState::ShellFolders => "the shell's whole list".to_string(),
        EntryState::ColonInName { folder } => format!("part of a folder whose name holds a colon ({folder})"),
    };
    if e.tilde {
        out.push_str(", written with ~ (taken literally)");
    }
    if !e.variables.is_empty() {
        out.push_str(&format!(", variables {} (taken literally)", e.variables.join(", ")));
    }
    out
}

/// The report's lines about where Plyloft looks.
fn looked_in_lines(l: &LookedIn, windows: bool) -> Vec<String> {
    let mut lines = vec![format!(
        "Program folders Plyloft looks in ({}):",
        if l.from_setting { "from the Program folders setting" } else { "from what the login shell reported" }
    )];
    let sep = if windows { ';' } else { ':' };
    let dirs: Vec<&str> = l.path.split(sep).collect();
    if l.path.trim().is_empty() {
        lines.push("  none".into());
    }
    for d in dirs.iter().filter(|d| !d.is_empty()) {
        lines.push(format!("  {d}"));
    }
    if let Some(v) = &l.verdict {
        lines.push("The setting reads:".into());
        for e in &v.entries {
            lines.push(format!("  {} -> {}", if e.text.is_empty() { "(empty)" } else { &e.text }, entry_words(e)));
        }
        let names = |list: &[String]| if list.is_empty() { "nothing".to_string() } else { list.join(", ") };
        let found: Vec<String> = v.found.iter().map(|f| f.name.clone()).collect();
        lines.push(format!("  finds: {}", names(&found)));
        lines.push(format!("  doesn't find: {}", names(&v.missing)));
        if !v.basics_missing.is_empty() {
            lines.push(format!("  basics it doesn't find: {}", names(&v.basics_missing)));
        }
        if !v.system_folders_missing.is_empty() {
            lines.push(format!("  system folders left out: {}", names(&v.system_folders_missing)));
        }
        let problems: Vec<String> = v.problems.iter().map(|p| wire(p)).collect();
        lines.push(format!("  problems: {}", if problems.is_empty() { "none".into() } else { problems.join(", ") }));
    }
    // 1.176.1 walk 2: said as a sentence, not a label.
    lines.push(match l.probe_error.as_deref() {
        Some(e) => format!("The last look at the program folders said: {e}"),
        None => "The last look at the program folders went through.".into(),
    });
    lines
}

/// This computer's name, for [`scrub`].
pub fn host_name() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: gethostname writes at most `buf.len()` bytes into `buf`.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let name = String::from_utf8_lossy(&buf[..end]).into_owned();
        let short = name.split('.').next().unwrap_or_default().to_string();
        (!short.is_empty()).then_some(short)
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok().filter(|h| !h.is_empty())
    }
}

/// `scheme://user:pass@host` with the part before `@` taken out.
fn strip_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"').unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(cut) => {
                out.push_str("<redacted>@");
                rest = &tail[cut + 1..];
            }
            None => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Review 2: tokens with no scheme around them — GitHub's (`ghp_`, `gho_`,
/// `ghu_`, `ghs_`, `ghr_`, `github_pat_`), OpenAI's and Anthropic's (`sk-`,
/// `sk-ant-`) — and a long run after `token`, `key`, `secret`,
/// `authorization` or `password` (Bearer/Basic included) are `<redacted>`.
pub fn strip_tokens(text: &str) -> String {
    const PREFIXES: [&str; 8] = ["github_pat_", "sk-ant-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-"];
    const WORDS: [&str; 5] = ["authorization", "password", "secret", "token", "key"];
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_ascii_lowercase().chars().collect();
    let starts_with = |at: usize, word: &str| {
        let w: Vec<char> = word.chars().collect();
        lower.len() >= at + w.len() && lower[at..at + w.len()] == w[..]
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || !token_char(chars[i - 1]);
        if boundary {
            if let Some(prefix) = PREFIXES.iter().find(|p| starts_with(i, p)) {
                let body = i + prefix.chars().count();
                let end = (body..chars.len()).find(|&j| !token_char(chars[j])).unwrap_or(chars.len());
                if end - body >= 16 {
                    out.push_str("<redacted>");
                    i = end;
                    continue;
                }
            }
        }
        // A keyword may close a name (`GH_TOKEN`, `api_key`).
        if i == 0 || !chars[i - 1].is_ascii_alphanumeric() {
            if let Some(word) = WORDS.iter().find(|w| starts_with(i, w)) {
                let mut j = i + word.len();
                // The rest of the word (`tokens`, `api_key_x`) and the separators.
                while j < chars.len() && (token_char(chars[j])) {
                    j += 1;
                }
                let sep_start = j;
                while j < chars.len() && matches!(chars[j], ' ' | ':' | '=' | '"' | '\'') {
                    j += 1;
                }
                for scheme in ["bearer ", "basic ", "token "] {
                    if starts_with(j, scheme) {
                        j += scheme.len();
                    }
                }
                let run_end = (j..chars.len())
                    .find(|&k| !(chars[k].is_ascii_alphanumeric() || "+/=_.-".contains(chars[k])))
                    .unwrap_or(chars.len());
                if j > sep_start && run_end - j >= 20 {
                    out.extend(&chars[i..j]);
                    out.push_str("<redacted>");
                    i = run_end;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `name` only where it is a whole path component (between separators).
fn replace_component(text: &str, name: &str, with: &str, fold: bool) -> String {
    let sep = |c: Option<char>| c.is_none_or(|c| c == '/' || c == '\\');
    let hay = if fold { text.to_ascii_lowercase() } else { text.to_string() };
    let needle = if fold { name.to_ascii_lowercase() } else { name.to_string() };
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = hay[at..].find(&needle) {
        let start = at + found;
        let end = start + needle.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        out.push_str(&text[at..start]);
        // A component: a separator before, and a separator or the end after.
        if before.is_some_and(|c| c == '/' || c == '\\') && sep(after) {
            out.push_str(with);
        } else {
            out.push_str(&text[start..end]);
        }
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

/// `text` with the home as `~` and the user name as `<user>` (Windows:
/// without case, either slash).
pub fn scrub(text: &str, facts: &Facts) -> String {
    let mut out = strip_tokens(&strip_credentials(text));
    if let Some(home) = facts.home.as_deref().filter(|h| h.len() > 1) {
        out = replace_all(&out, home, "~", facts.windows);
        if facts.windows {
            out = replace_all(&out, &home.replace('\\', "/"), "~", true);
            out = replace_all(&out, &home.replace('\\', "\\\\"), "~", true);
        }
    }
    if let Some(host) = facts.host.as_deref().filter(|h| h.len() > 1) {
        out = replace_word(&out, &format!("{host}.local"), "<host>", true);
        out = replace_word(&out, host, "<host>", true);
    }
    match facts.user.as_deref() {
        // A one-letter name only as a whole path component: as a word it
        // would eat every "a" in the text.
        Some(user) if user.chars().count() == 1 => out = replace_component(&out, user, "<user>", facts.windows),
        Some(user) if !user.is_empty() => out = replace_word(&out, user, "<user>", facts.windows),
        _ => {}
    }
    out
}

fn replace_all(text: &str, needle: &str, with: &str, fold: bool) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    if !fold {
        return text.replace(needle, with);
    }
    let lower = text.to_ascii_lowercase();
    let n = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = lower[at..].find(&n) {
        out.push_str(&text[at..at + found]);
        out.push_str(with);
        at += found + n.len();
    }
    out.push_str(&text[at..]);
    out
}

/// `word` where it isn't part of a longer name (letters, digits, `_`, `-`, `.`
/// on either side).
fn replace_word(text: &str, word: &str, with: &str, fold: bool) -> String {
    let hay = if fold { text.to_ascii_lowercase() } else { text.to_string() };
    let needle = if fold { word.to_ascii_lowercase() } else { word.to_string() };
    let part = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.';
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = hay[at..].find(&needle) {
        let start = at + found;
        let end = start + needle.len();
        let before = text[..start].chars().next_back();
        let mut rest = text[end..].chars();
        let after = rest.next();
        // A full stop ends a sentence unless a name goes on after it.
        let after_part = match after {
            Some('.') => rest.next().is_some_and(|c| c.is_ascii_alphanumeric()),
            Some(c) => part(c),
            None => false,
        };
        out.push_str(&text[at..start]);
        if before.is_some_and(part) || after_part {
            out.push_str(&text[start..end]);
        } else {
            out.push_str(with);
        }
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

fn yes_no(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    }
}

fn start_line(start: Option<&CopyStart>) -> String {
    match start {
        None => "not run".into(),
        Some(s) if s.starts => format!("starts, version {}", s.version.as_deref().unwrap_or("?")),
        Some(s) if s.inconclusive => "no answer in time".into(),
        Some(s) => format!(
            "does not start ({}{}{})",
            s.failure.map(|f| failure_words(&f).to_string()).unwrap_or_else(|| "?".into()),
            s.exit_code.map(|c| format!(", exit {c}")).unwrap_or_default(),
            s.signal.map(|c| format!(", signal {c}")).unwrap_or_default(),
        ),
    }
}

fn folder_line(f: &FolderCheck) -> String {
    format!(
        "  {} ({}, {}{}) exists: {}, yours: {}, writable: {}{}",
        f.path,
        wire(&f.role),
        wire(&f.channel),
        if f.system_folder { ", system" } else { "" },
        yes_no(Some(f.exists)),
        yes_no(f.owned_by_user),
        yes_no(Some(f.writable)),
        f.checked.as_deref().filter(|c| *c != f.path).map(|c| format!(", tested at {c}")).unwrap_or_default(),
    )
}

/// 1.176.1 walk 2: why a copy didn't start, in words.
fn failure_words(f: &crate::cli_health::StartFailure) -> &'static str {
    use crate::cli_health::StartFailure as S;
    match f {
        S::NotFound => "its file or the program it needs isn't there",
        S::PermissionDenied => "it isn't allowed to run",
        S::TimedOut => "no answer in time",
        S::BadBinary => "its program file is damaged",
        S::SpawnFailed => "it couldn't be started",
        S::Exited => "it ended without saying its version",
        S::Unreadable => "its answer couldn't be read",
        S::Signal => "it was stopped by the system",
    }
}

/// 1.176.1 walk 2: a finding as a short plain sentence, every fact kept
/// (the report printed each one as JSON).
fn finding_line(f: &crate::cli_health::Finding) -> Vec<String> {
    use crate::cli_health::Finding as F;
    let list = |v: &[String]| v.join(", ");
    let folders = |v: &[crate::cli_health::FolderRef]| {
        v.iter()
            .map(|r| {
                let mut tags = Vec::new();
                if r.needed_now {
                    tags.push("needed now");
                }
                if r.system_folder {
                    tags.push("a system folder");
                }
                if tags.is_empty() { r.path.clone() } else { format!("{} ({})", r.path, tags.join(", ")) }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    match f {
        F::Missing => vec!["No copy of it was found anywhere.".into()],
        F::NoWorkingCopy => vec!["Every copy found fails to start.".into()],
        F::CachedPathStale { cached, now, usable } => vec![format!(
            "The path tiles use ({}) {} and is not what is found now ({}).",
            cached.as_deref().unwrap_or("none"),
            if *usable { "can be run" } else { "can't be run" },
            now.as_deref().unwrap_or("nothing"),
        )],
        F::FirstOnPathIsNotTheWorkingOne { first, working, working_on_path } => vec![format!(
            "Tiles run {}, but the copy that works is {}, {}.",
            first.as_deref().unwrap_or("nothing"),
            working,
            if *working_on_path { "which is further down the program folders" } else { "which is not in the program folders" },
        )],
        F::DoesNotStart { path, failure, exit_code, signal, tail } => {
            let mut out = vec![format!(
                "{path} does not start ({}{}{}).",
                failure_words(failure),
                exit_code.map(|c| format!(", exit {c}")).unwrap_or_default(),
                signal.map(|c| format!(", signal {c}")).unwrap_or_default(),
            )];
            if let Some(t) = tail.as_deref().filter(|t| !t.trim().is_empty()) {
                out.push("It said:".into());
                out.extend(t.lines().map(|l| format!("  | {l}")));
            }
            out
        }
        F::StartInconclusive { path } => vec![format!("{path} gave no answer in time; it may still start.")],
        F::DanglingLink { path, target, channel } => vec![format!(
            "{path} is a broken link to {} ({} install).",
            target.as_deref().unwrap_or("an unknown place"),
            wire(channel),
        )],
        F::NotExecutable { path } => vec![format!("{path} is not marked as a program, so it can't be run.")],
        F::Unreadable { paths } => vec![format!("These folders can't be read, so what is in them is unknown: {}.", list(paths))],
        F::CopyNotOwned { path, system_folder } => vec![format!(
            "{path} belongs to another account{}.",
            if *system_folder { " (in a system folder)" } else { "" }
        )],
        F::FoldersNotWritable { folders: v } => vec![format!("These folders can't be written to: {}.", folders(v))],
        F::FoldersNotOwned { folders: v } => vec![format!("These folders belong to another account: {}.", folders(v))],
        F::SeveralCopies { paths } => vec![format!("There are several copies: {}.", list(paths))],
        F::NativeDirNotOnPath { dir } => vec![format!("The installer's folder {dir} is not in the program folders.")],
    }
}

fn wire<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

/// Pure: the report.
pub fn report(
    h: &CliHealth,
    last: Option<&LastRun>,
    include_tail: bool,
    manual: &[crate::cli_repair::ManualCommand],
    facts: &Facts,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Plyloft {} on {}", facts.app_version, facts.os));
    lines.push(format!("Tool: {}", h.tool.program()));
    lines.push(format!("Healthy: {}", yes_no(Some(h.healthy))));
    lines.push(format!("Runs today: {}", h.runs_today.as_deref().unwrap_or("nothing")));
    lines.push(format!("Should run: {}", h.should_run.as_deref().unwrap_or("nothing")));
    lines.push(format!("Install folder: {}", h.install_dir.as_deref().unwrap_or("unknown")));
    if let Some(l) = &facts.looked_in {
        lines.extend(looked_in_lines(l, facts.windows));
    }
    if let Some(c) = &h.cached {
        lines.push(format!(
            "Cached path: {} (usable: {}, same as now: {}, now: {})",
            c.path.as_deref().unwrap_or("none"),
            yes_no(Some(c.usable)),
            yes_no(Some(c.matches_now)),
            c.now.as_deref().unwrap_or("none"),
        ));
    }
    lines.push("Copies:".into());
    if h.copies.is_empty() {
        lines.push("  none".into());
    }
    for c in &h.copies {
        let target = if c.dangling {
            format!(" -> {} (broken link)", c.link_end.as_deref().or(c.link_target.as_deref()).unwrap_or("?"))
        } else {
            c.real_path.as_deref().filter(|r| *r != c.path).map(|r| format!(" -> {r}")).unwrap_or_default()
        };
        lines.push(format!(
            "  {}{} ({} install{}) yours: {}, {}",
            c.path,
            target,
            wire(&c.channel),
            c.path_rank
                .map(|r| format!(", number {} in the program folders", r + 1))
                .unwrap_or_else(|| ", not in the program folders".into()),
            yes_no(c.owned_by_user),
            start_line(c.start.as_ref()),
        ));
        for also in &c.also_at {
            lines.push(format!("    also at {also}"));
        }
        if let Some(tail) = c.start.as_ref().and_then(|s| s.tail.as_deref()).filter(|_| include_tail) {
            for line in tail.lines() {
                lines.push(format!("    | {line}"));
            }
        }
    }
    lines.push("Folders:".into());
    for f in &h.folders {
        lines.push(folder_line(f));
    }
    lines.push("Findings:".into());
    if h.findings.is_empty() {
        lines.push("  none".into());
    }
    for f in &h.findings {
        lines.extend(finding_line(f).into_iter().map(|l| format!("  {l}")));
    }
    match last {
        None => lines.push("Last install or update: none recorded".into()),
        Some(run) => {
            lines.push(format!(
                "Last install or update: {} {} at {}, exit {}, cause {}{}, version {} -> {}",
                run.action_id,
                run.outcome.as_deref().unwrap_or("?"),
                run.finished_at.as_deref().unwrap_or("?"),
                run.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "-".into()),
                run.cause.as_deref().unwrap_or("-"),
                run.cause_path.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(),
                run.version_before.as_deref().unwrap_or("-"),
                run.version_after.as_deref().unwrap_or("-"),
            ));
            if include_tail {
                lines.push("  Output:".into());
                for line in &run.tail {
                    lines.push(format!("  | {line}"));
                }
            }
        }
    }
    // R4b: the current plan's commands, so a copied report can be followed.
    lines.push("By hand:".into());
    if manual.is_empty() {
        lines.push("  nothing".into());
    }
    for m in manual {
        lines.push(format!("  [{}] {}", wire(&m.purpose), m.command));
    }
    scrub(&lines.join("\n"), facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_health::{CliTool, Finding};

    fn facts() -> Facts {
        Facts {
            app_version: "1.176.0".into(),
            os: "macos aarch64".into(),
            home: Some("/Users/ada".into()),
            user: Some("ada".into()),
            host: Some("Adas-MacBook".into()),
            windows: false,
            looked_in: None,
        }
    }

    /// 1.176.1: the owner's report, with where Plyloft looked and why.
    #[test]
    fn the_report_says_where_plyloft_looks_and_what_the_setting_reads() {
        use crate::program_folders::{read_list, Ctx, Disk, PathKind};
        struct OneFile;
        impl Disk for OneFile {
            fn kind(&self, path: &str) -> PathKind {
                if path == "/Users/ada/.local/bin/claude" { PathKind::File } else { PathKind::Absent }
            }
            fn program(&self, _dir: &str, _name: &str) -> Option<String> {
                None
            }
        }
        let ctx = Ctx { home: Some("/Users/ada".into()), ..Ctx::default() };
        let verdict = read_list("~/.local/bin/claude", &ctx, &OneFile);
        let h = CliHealth {
            tool: CliTool::Claude,
            healthy: false,
            runs_today: None,
            should_run: Some("/Users/ada/.local/bin/claude".into()),
            install_dir: Some("/Users/ada/.local/bin".into()),
            cached: None,
            copies: Vec::new(),
            folders: Vec::new(),
            passed_over: None,
            findings: Vec::new(),
        };
        let f = Facts {
            looked_in: Some(LookedIn {
                path: "~/.local/bin/claude".into(),
                from_setting: true,
                verdict: Some(verdict),
                probe_error: Some("Neither claude nor codex is in your Program folders".into()),
            }),
            ..facts()
        };
        let text = report(&h, None, false, &[], &f);
        assert!(text.contains("Program folders Plyloft looks in (from the Program folders setting):\n  ~/.local/bin/claude\n"), "{text}");
        assert!(text.contains("  ~/.local/bin/claude -> a file, not a folder (its folder: ~/.local/bin), written with ~ (taken literally)"), "{text}");
        assert!(text.contains("  doesn't find: claude, codex, git, gh"), "{text}");
        assert!(text.contains("  system folders left out: /usr/bin, /bin"), "{text}");
        assert!(text.contains("  problems: namesAFile, tilde"), "{text}");
        assert!(text.contains("The last look at the program folders said: Neither claude"), "{text}");
        assert!(!text.contains("/Users/ada"), "{text}");
        let shell = Facts {
            looked_in: Some(LookedIn { path: "/Users/ada/.local/bin:/usr/bin".into(), ..LookedIn::default() }),
            ..facts()
        };
        let text = report(&h, None, false, &[], &shell);
        assert!(
            text.contains("(from what the login shell reported):\n  ~/.local/bin\n  /usr/bin\nThe last look at the program folders went through."),
            "{text}"
        );
    }

    #[test]
    fn tokens_without_a_scheme_are_scrubbed() {
        let f = facts();
        let ghp = format!("ghp_{}", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4");
        assert_eq!(scrub(&format!("using {ghp} now"), &f), "using <redacted> now");
        assert_eq!(scrub("key sk-ant-api03-abcdefghijklmnopqrstuv end", &f), "key <redacted> end");
        assert_eq!(
            scrub("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", &f),
            "Authorization: Bearer <redacted>"
        );
        assert_eq!(scrub("GH_TOKEN=0123456789abcdef0123456789abcdef", &f), "GH_TOKEN=<redacted>");
        // Ordinary words stay.
        assert_eq!(scrub("the key point, a token gesture, sk-1", &f), "the key point, a token gesture, sk-1");
    }

    #[test]
    fn a_one_letter_user_credentials_and_the_host_are_scrubbed_safely() {
        let f = Facts { home: Some("/Users/u".into()), user: Some("u".into()), ..facts() };
        assert_eq!(
            scrub("/Users/u/x and /private/u/y, a user upgrade", &f),
            "~/x and /private/<user>/y, a user upgrade"
        );
        assert_eq!(
            scrub("proxy http://me:secret@proxy.corp:8080/ and https://github.com/x", &facts()),
            "proxy http://<redacted>@proxy.corp:8080/ and https://github.com/x"
        );
        assert_eq!(scrub("ada@Adas-MacBook.local ~ %", &facts()), "<user>@<host> ~ %");
    }

    #[test]
    fn the_home_and_the_user_name_never_reach_the_report() {
        let h = CliHealth {
            tool: CliTool::Claude,
            healthy: false,
            runs_today: Some("/Users/ada/.local/bin/claude".into()),
            should_run: None,
            install_dir: Some("/Users/ada/.local/bin".into()),
            cached: None,
            copies: Vec::new(),
            folders: Vec::new(),
            passed_over: None,
            findings: vec![Finding::DanglingLink {
                path: "/Users/ada/.local/bin/claude".into(),
                target: Some("/Users/ada/.local/share/claude/versions/2.1.330".into()),
                channel: crate::cli_health::InstallChannel::Native,
            }],
        };
        let run = LastRun {
            action_id: "update.claude".into(),
            outcome: Some("failed".into()),
            cause: Some("permissions".into()),
            cause_path: Some("/Users/ada/.local/bin".into()),
            tail: vec!["EACCES: permission denied, open '/Users/ada/.local/bin/x' (user ada)".into()],
            ..LastRun::default()
        };
        let manual = vec![crate::cli_repair::ManualCommand {
            purpose: crate::cli_repair::ManualPurpose::Ownership,
            command: "sudo chown -R -P -- ada /Users/ada/.claude".into(),
        }];
        let text = report(&h, Some(&run), true, &manual, &facts());
        assert!(text.contains("By hand:\n  [ownership] sudo chown -R -P -- <user> ~/.claude"), "{text}");
        assert!(!text.contains("/Users/ada"), "{text}");
        assert!(!text.contains(" ada"), "{text}");
        assert!(text.contains("~/.local/bin/claude"));
        assert!(text.contains("(user <user>)"));
        // Without the tail, the output's lines are left out.
        let short = report(&h, Some(&run), false, &manual, &facts());
        assert!(!short.contains("EACCES"));
        assert!(short.contains("cause permissions (~/.local/bin)"));
    }

    #[test]
    fn a_name_inside_another_word_stays() {
        let f = facts();
        assert_eq!(scrub("adaptive ada.", &f), "adaptive <user>.");
        let w = Facts { home: Some(r"C:\Users\Ada".into()), user: Some("Ada".into()), host: None, windows: true, ..f };
        assert_eq!(scrub(r"c:\users\ada\.local\bin and C:/Users/Ada/x", &w), r"~\.local\bin and ~/x");
    }

    #[test]
    fn findings_are_plain_sentences_with_every_fact() {
        use crate::cli_health::{Finding, StartFailure};
        let lines = finding_line(&Finding::FirstOnPathIsNotTheWorkingOne {
            first: Some("/opt/homebrew/bin/claude".into()),
            working: "/Users/x/.local/bin/claude".into(),
            working_on_path: false,
        });
        assert_eq!(
            lines,
            vec!["Tiles run /opt/homebrew/bin/claude, but the copy that works is /Users/x/.local/bin/claude, which is not in the program folders."]
        );
        let lines = finding_line(&Finding::DoesNotStart {
            path: "/a/claude".into(),
            failure: StartFailure::BadBinary,
            exit_code: Some(137),
            signal: None,
            tail: Some("Killed".into()),
        });
        assert_eq!(lines[0], "/a/claude does not start (its program file is damaged, exit 137).");
        assert_eq!(lines[2], "  | Killed");
        let lines = finding_line(&Finding::NativeDirNotOnPath { dir: "/Users/x/.local/bin".into() });
        assert!(!lines.join(" ").contains('{'), "{lines:?}");
    }
}
