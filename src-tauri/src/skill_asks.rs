//! 1.175.0 B1 (review SEC-1, proof P1): what the **text** of a skill asks to
//! be allowed to do.
//!
//! A `SKILL.md` is text, and text never asked for an OK. But its front matter
//! and body can make an agent run things with no permission question:
//!
//! - `allowed-tools` naming a command tool (`Bash`, `Bash(git log:*)`) or a
//!   tool that writes files (`Write`, `Edit`, `NotebookEdit`): an agent using
//!   the skill runs them without asking, whatever the session's permission
//!   mode, and outside the card's copy too (measured, Claude Code 2.1.319);
//! - `hooks` in the front matter: commands at set moments of a session;
//! - `` !`…` `` in the text, or a fenced block opened with ```` ```! ````: a
//!   command that runs when the skill loads, before the agent reads the rest,
//!   and never shows as a command in the session.
//!
//! [`analyse`] reads one file's bytes and says which of these it holds, each
//! with the line it is on. It is deliberately conservative: a front matter
//! that can't be read, an `allowed-tools` of a shape it doesn't know, or a
//! tool it doesn't know to be read-only all count as asking — the member is
//! shown the text and decides. Pure: no disk, no git; the callers
//! (`skill_scripts`) key the OK on the file's exact bytes.

use serde::Serialize;

/// Tools that only read: naming them in `allowed-tools` asks for nothing.
/// Anything not listed here, and not a writing tool, counts as a command.
const READ_ONLY_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "ls",
    "notebookread",
    "websearch",
    "webfetch",
    "todowrite",
    "todoread",
    "askuserquestion",
    "exitplanmode",
    "skill",
];

/// Tools that change files.
const WRITE_TOOLS: &[&str] = &["write", "edit", "multiedit", "notebookedit"];

/// The most that is kept of each list (the sheet shows them; a file listing
/// thousands is cut, and still asks).
const MAX_LISTED: usize = 40;

/// Tools named by `allowed-tools`, with the line the key is on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsAsk {
    pub line: usize,
    /// As written (`Bash(git log:*)`), in order.
    pub tools: Vec<String>,
    /// A bare `Bash` (or `*`) is among them: any command.
    pub any: bool,
}

/// A command that runs when the skill loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineAsk {
    pub line: usize,
    /// The command as written; empty for a block whose first line is empty.
    pub command: String,
}

/// `hooks` in the front matter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksAsk {
    pub line: usize,
    /// The moments named (`PreToolUse`, `Stop`…), in order.
    pub moments: Vec<String>,
}

/// What one file's text asks for. `Default`: nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Asks {
    /// The front matter couldn't be read, at this line: what it asks for
    /// isn't known, so it is treated as asking.
    pub unreadable: Option<usize>,
    pub inline: Vec<InlineAsk>,
    pub commands: Option<ToolsAsk>,
    pub writes: Option<ToolsAsk>,
    pub hooks: Option<HooksAsk>,
    /// Keys of the front matter not known to be harmless, in order.
    pub other: Vec<KeyAsk>,
}

/// As the window gets it: the fields, and [`Asks::strongest`] beside them
/// (1.175.0 Y1), so the one rule for "the widest thing it asks" is written
/// here and the window's rows, Share page and sheet all read its answer.
impl Serialize for Asks {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            unreadable: Option<usize>,
            inline: &'a [InlineAsk],
            commands: &'a Option<ToolsAsk>,
            writes: &'a Option<ToolsAsk>,
            hooks: &'a Option<HooksAsk>,
            #[serde(skip_serializing_if = "<[KeyAsk]>::is_empty")]
            other: &'a [KeyAsk],
            #[serde(skip_serializing_if = "Option::is_none")]
            strongest: Option<Strongest>,
        }
        Wire {
            unreadable: self.unreadable,
            inline: &self.inline,
            commands: &self.commands,
            writes: &self.writes,
            hooks: &self.hooks,
            other: &self.other,
            strongest: self.strongest(),
        }
        .serialize(serializer)
    }
}

/// A front-matter key that isn't on the list of harmless ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAsk {
    pub line: usize,
    /// As written.
    pub key: String,
    /// The CLI acts on this key (`mcpServers`, `permissionMode`, `shell`…):
    /// said as letting agents run things. `false`: a key nobody knows.
    pub known: bool,
}

impl KeyAsk {
    fn new(line: usize, key: String) -> Self {
        let known = CLI_KEYS.contains(&fold_key(&key).as_str());
        Self { line, key, known }
    }
}


/// The one thing a row, the Share page's line and the sheet's title have room
/// to say about what a skill's texts ask. 1.175.0 Y1 (walk; the owner's
/// answers of 2026-11-09): **one rule, here** ([`Asks::widest`]) —
///
/// 1. a text whose top Plyloft can't read says "couldn't read what it asks
///    for", even when something known was also found: what it didn't read
///    may be wider than what it did;
/// 2. then commands without asking (tools, hooks, a key the CLI acts on);
/// 3. then a command at load;
/// 4. then a key nobody knows, in the same "couldn't read" words;
/// 5. then changing files without asking.
///
/// A text that asks for command tools and runs a command at load says the
/// tools: any command, at any time, is the wider of the two. The answers
/// have no order of their own (round 3): two texts, or a skill's two copies,
/// are put together and the rule applied — "couldn't read" is first for an
/// unreadable top and fourth for an unknown key, which no ordering of four
/// answers can say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Strongest {
    /// It changes files without asking.
    Files,
    /// It runs a command when it loads.
    Inline,
    /// It lets agents run commands without asking (tools, hooks, a key the
    /// CLI acts on).
    Commands,
    /// Plyloft couldn't read what it asks for (or a key nobody knows).
    Unreadable,
}

impl Asks {
    pub fn any(&self) -> bool {
        self.unreadable.is_some()
            || !self.inline.is_empty()
            || self.commands.is_some()
            || self.writes.is_some()
            || self.hooks.is_some()
            || !self.other.is_empty()
    }

    /// A key the CLI acts on is among the others (it lets agents run things).
    fn other_known(&self) -> bool {
        self.other.iter().any(|key| key.known)
    }

    /// [`Strongest`]'s rule, for one text.
    pub fn strongest(&self) -> Option<Strongest> {
        Self::widest([self])
    }

    /// [`Strongest`]'s rule over every text of a skill (its `SKILL.md`, and
    /// any nested one): what each asks is put together first, so two texts
    /// say what one text asking for both would say.
    pub fn widest<'a>(texts: impl IntoIterator<Item = &'a Asks>) -> Option<Strongest> {
        let (mut top, mut commands, mut inline, mut unknown, mut files) = (false, false, false, false, false);
        for asks in texts {
            top |= asks.unreadable.is_some();
            commands |= asks.commands.is_some() || asks.hooks.is_some() || asks.other_known();
            inline |= !asks.inline.is_empty();
            unknown |= asks.other.iter().any(|key| !key.known);
            files |= asks.writes.is_some();
        }
        if top {
            Some(Strongest::Unreadable)
        } else if commands {
            Some(Strongest::Commands)
        } else if inline {
            Some(Strongest::Inline)
        } else if unknown {
            // A key nobody knows: Plyloft can't tell what it asks for.
            Some(Strongest::Unreadable)
        } else if files {
            Some(Strongest::Files)
        } else {
            None
        }
    }
}

/// Lines of `text` without their `\r` (a file saved on Windows).
fn lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect()
}

/// JavaScript's `\s`, which the CLI's patterns use.
fn js_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// The front matter **as the CLI finds it** (claude 2.1.319, `td`): the
/// text matches `^---\s*\n([\s\S]*?)---\s*\n?`, so it starts after the
/// whitespace that follows the opening `---` (up to and including its last
/// line break) and ends at the **first `---` anywhere** — not at a line of
/// its own. Byte offsets of the captured text, or `None` when the file
/// doesn't open with one.
fn cli_front_matter(text: &str) -> Option<(usize, Option<usize>)> {
    let rest = text.strip_prefix("---")?;
    let space: usize = rest.chars().take_while(|c| js_space(*c)).map(char::len_utf8).sum();
    let last_break = rest[..space].rfind('\n')?;
    let start = 3 + last_break + 1;
    Some((start, text[start..].find("---").map(|at| start + at)))
}

/// The same front matter read the strict way (the CLI's second pattern,
/// `^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)`): closed by a
/// `---` on a line of its own.
fn strict_front_matter(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("---")?;
    let rest = rest.trim_start_matches([' ', '\t']);
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n'))?;
    let mut from = 0;
    while let Some(at) = rest[from..].find("\n---") {
        let at = from + at;
        let after = rest[at + 4..].trim_start_matches([' ', '\t']);
        if after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n") {
            return Some(rest[..at].strip_suffix('\r').unwrap_or(&rest[..at]));
        }
        from = at + 1;
    }
    None
}

/// The CLI's own second try (`ef` in claude 2.1.319), line for line: when a
/// front matter isn't YAML, every line `key: value` whose key is letters,
/// `_` or `-`, whose value isn't already quoted or a real list, and whose
/// value holds a character YAML reads specially (`{}[]*&#!|>%@` or a
/// backtick, or `: `) gets its value put in double quotes. Then it is
/// parsed again. Reproduced so a hand-written description with a colon
/// reads here as it reads there — and a key that only appears on that
/// second try is seen.
pub(crate) fn cli_requote(front: &str) -> String {
    front.split('\n').map(requote_line).collect::<Vec<_>>().join("\n")
}

fn requote_line(line: &str) -> String {
    let keep = || line.to_string();
    let key_len = line.chars().take_while(|c| c.is_ascii_alphabetic() || matches!(c, '_' | '-')).count();
    if key_len == 0 || !line[key_len..].starts_with(':') {
        return keep();
    }
    let after = &line[key_len + 1..];
    let value = after.trim_start_matches(js_space);
    // `\s+` then `\S.*$`: some space, a value, and no line break inside it
    // (JavaScript's `.` stops at a CR or a Unicode line separator).
    if value.len() == after.len() || value.is_empty() || value.contains(['\r', '\u{2028}', '\u{2029}']) {
        return keep();
    }
    let quoted = |q: char| value.starts_with(q) && value.ends_with(q);
    if quoted('"') || quoted('\'') {
        return keep();
    }
    if value.starts_with('[') && value.ends_with(']') && matches!(serde_yaml_ng::from_str::<serde_yaml_ng::Value>(value), Ok(serde_yaml_ng::Value::Sequence(_))) {
        return keep();
    }
    let special = value.contains(['{', '}', '[', ']', '*', '&', '#', '!', '|', '>', '%', '@', '`']) || value.contains(": ");
    if !special {
        return keep();
    }
    format!("{}: \"{}\"", &line[..key_len], value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Parse a front matter as the CLI does (`vHn`): as written; failing that,
/// after [`cli_requote`] with leading tabs turned into spaces. The text that
/// parsed comes back with the value.
fn parse_like_the_cli(front: &str) -> Result<(serde_yaml_ng::Value, String), serde_yaml_ng::Error> {
    match serde_yaml_ng::from_str(front) {
        Ok(value) => Ok((value, front.to_string())),
        Err(first) => {
            let retried: String = cli_requote(front)
                .split('\n')
                .map(|line| {
                    let tabs = line.chars().take_while(|c| *c == '\t').count();
                    format!("{}{}", "  ".repeat(tabs), &line[tabs..])
                })
                .collect::<Vec<_>>()
                .join("\n");
            match serde_yaml_ng::from_str(&retried) {
                Ok(value) => Ok((value, retried)),
                Err(_) => Err(first),
            }
        }
    }
}

/// A key as it is compared: unquoted, lower case, without `-` or `_`.
fn fold_key(key: &str) -> String {
    key.trim().chars().filter(|c| !matches!(c, '-' | '_')).flat_map(char::to_lowercase).collect()
}

/// Front-matter keys known to be harmless (folded): they describe the skill
/// or choose a model, and grant nothing. Everything else asks. Established
/// from the installed CLI's own key list (`Zm` in claude 2.1.319, 62 keys):
/// these are the ones of it that neither run, allow, connect nor configure
/// anything. `allowed-tools` and `hooks` have their own rule.
const HARMLESS_KEYS: &[&str] = &[
    "name", "description", "argumenthint", "arguments", "model", "effort", "version", "whentouse", "license",
    "metadata", "disablemodelinvocation", "userinvocable", "author", "homepage", "repository", "keywords",
    "compatibility", "displayname", "createdby", "improvedby", "paths", "color",
];

/// The rest of the CLI's key list (folded): keys it acts on. One of them in
/// a skill's front matter is said as letting agents run things; a key the
/// CLI doesn't know at all is said as something Plyloft can't read.
const CLI_KEYS: &[&str] = &[
    "shell", "context", "agent", "mcpservers", "lspservers", "agents", "outputstyles", "themes", "workflows",
    "channels", "monitors", "settings", "experimental", "commands", "skills", "dependencies", "userconfig",
    "defaultenabled", "fallback", "evals", "tools", "disallowedtools", "permissionmode", "maxturns",
    "autocompactwindow", "initialprompt", "memory", "background", "omitclaudemd", "isolation", "observer",
    "observermessage", "observesubagents", "keepcodinginstructions", "forceforplugin", "type", "originsessionid",
    "hidefromslashcommandtool",
];

/// A top-level key written on `line` (a line starting at the margin), raw.
fn margin_key(line: &str) -> Option<&str> {
    if line.is_empty() || line.starts_with([' ', '\t', '#', '-', '{', '[', '}', ']']) {
        return None;
    }
    let (key, _) = line.split_once(':')?;
    Some(key.trim().trim_matches(|c| c == '"' || c == '\''))
}

/// The 1-based line of the file a top-level key is on. `first`: the line
/// the front matter's text starts on.
fn key_line(front: &[&str], first: usize, key: &str) -> usize {
    let folded = fold_key(key);
    front
        .iter()
        .position(|line| margin_key(line).is_some_and(|written| written == key || fold_key(written) == folded))
        .map_or(first, |i| first + i)
}

/// An anchor, an alias or a merge key in `front`: the line it is on (0-based
/// within the front matter). Only where YAML reads one — at the start of a
/// value or of a list item, or inside a `[…]` / `{…}` — never a `*` or `&`
/// in the middle of words.
fn anchor_line(front: &[&str]) -> Option<usize> {
    let name = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '-'));
    front.iter().position(|line| {
        let mut item = line.trim_start();
        while let Some(rest) = item.strip_prefix("- ") {
            item = rest.trim_start();
        }
        if item.starts_with("<<") && item[2..].trim_start().starts_with(':') {
            return true;
        }
        let value = match item.split_once(": ") {
            Some((_, value)) => value.trim_start(),
            None if item.ends_with(':') => "",
            None => item,
        };
        let mut chars = value.chars();
        if matches!(chars.next(), Some('&' | '*')) && name(chars.next()) {
            return true;
        }
        if !value.starts_with(['[', '{']) {
            return false;
        }
        let mut opens = true;
        let mut inside = value.chars().peekable();
        while let Some(c) = inside.next() {
            match c {
                '[' | '{' | ',' | ':' => opens = true,
                ' ' | '\t' => {}
                '&' | '*' if opens && name(inside.peek().copied()) => return true,
                _ => opens = false,
            }
        }
        false
    })
}

/// The names in an `allowed-tools` value: a YAML list, or one string with
/// commas or spaces between tools (never inside a tool's parentheses).
/// `None`: a shape this doesn't know.
fn tool_names(value: &serde_yaml_ng::Value) -> Option<Vec<String>> {
    use serde_yaml_ng::Value;
    match value {
        Value::Null => Some(Vec::new()),
        Value::String(text) => Some(split_tools(text)),
        Value::Sequence(items) => {
            let mut out = Vec::new();
            for item in items {
                match item {
                    Value::String(text) => out.extend(split_tools(text)),
                    _ => return None,
                }
            }
            Some(out)
        }
        _ => None,
    }
}

fn split_tools(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    for c in text.chars() {
        match c {
            '(' => {
                depth += 1;
                current.push(c);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                current.push(c);
            }
            ',' | ' ' | '\t' | '\n' if depth == 0 => {
                if !current.trim().is_empty() {
                    out.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// The tool's own name, lowercased: `Bash(git log:*)` → `bash`.
fn tool_base(tool: &str) -> String {
    tool.split('(').next().unwrap_or(tool).trim().to_ascii_lowercase()
}

/// Read what `bytes` — a `SKILL.md`, or any other text of a plugin — asks to
/// be allowed to do.
pub fn analyse(bytes: &[u8]) -> Asks {
    let Ok(text) = std::str::from_utf8(bytes) else {
        // Not text: `skill_scripts::classify` already asks about it as a file.
        return Asks::default();
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let all = lines(text);
    let mut asks = Asks::default();
    // Round 2 (G1.1): the whole file, its front matter included. The CLI
    // ends the front matter at the first `---` anywhere, so what Plyloft
    // reads as front matter can be body there, and its commands run.
    read_markers(&all, &mut asks);
    if all.first().is_some_and(|line| line.trim_end() == "---") || text.starts_with("---") {
        read_front_matter(text, &mut asks);
    }
    asks
}

fn read_front_matter(text: &str, asks: &mut Asks) {
    use serde_yaml_ng::Value;
    let Some((start, end)) = cli_front_matter(text) else {
        // `---` with nothing the CLI reads as an opening line: no front matter.
        return;
    };
    // The line of the file the front matter's text starts on.
    let first = text[..start].matches('\n').count() + 1;
    let Some(end) = end else {
        // Opened and never closed.
        asks.unreadable = Some(1);
        return;
    };
    let front = &text[start..end];
    let closing = text[..end].matches('\n').count() + 1;
    // Where it ends must not depend on who reads it: the CLI's two patterns
    // agree, or part of what looks like front matter is body there.
    let strict = strict_front_matter(text).unwrap_or("");
    if (!front.trim().is_empty() || !strict.trim().is_empty()) && strict.trim() != front.trim() {
        asks.unreadable = Some(closing);
        return;
    }
    let front_lines = lines(front);
    // A `...` ends a YAML document: what follows it is read by some and not by others.
    if let Some(at) = front_lines.iter().position(|line| line.trim_end() == "...") {
        asks.unreadable = Some(first + at);
        return;
    }
    let (parsed, read_text) = match parse_like_the_cli(front) {
        Ok(read) => read,
        Err(error) => {
            // Round 2 (G1.2): unreadable always asks. (Round 1 let it pass
            // when it named neither the tools nor hooks; a key written with
            // an escape is named by neither word.)
            asks.unreadable = Some(error.location().map_or(first, |at| first + at.line().saturating_sub(1)));
            return;
        }
    };
    let read_lines = lines(&read_text);
    if let Some(at) = anchor_line(&read_lines) {
        asks.unreadable = Some(first + at);
        return;
    }
    let map = match parsed {
        Value::Mapping(map) => map,
        // An empty front matter asks for nothing.
        Value::Null => return,
        _ => {
            asks.unreadable = Some(first);
            return;
        }
    };
    let mut parsed_keys = Vec::new();
    for (key, value) in &map {
        let written = match key {
            Value::String(key) => key.clone(),
            other => serde_yaml_ng::to_string(other).unwrap_or_default().trim().to_string(),
        };
        let folded = fold_key(&written);
        let line = key_line(&front_lines, first, &written);
        parsed_keys.push(folded.clone());
        if !matches!(key, Value::String(_)) {
            asks.other.push(KeyAsk::new(line, written));
        } else if folded == "allowedtools" {
            let Some(tools) = tool_names(value) else {
                asks.unreadable = Some(line);
                continue;
            };
            let (mut commands, mut writes) = (Vec::new(), Vec::new());
            for tool in tools {
                let base = tool_base(&tool);
                if READ_ONLY_TOOLS.contains(&base.as_str()) {
                    continue;
                }
                if WRITE_TOOLS.contains(&base.as_str()) {
                    writes.push(tool);
                } else {
                    commands.push(tool);
                }
            }
            if !commands.is_empty() {
                let any = commands.iter().any(|tool| matches!(tool.trim().to_ascii_lowercase().as_str(), "bash" | "*" | "bash(*)"));
                commands.truncate(MAX_LISTED);
                asks.commands = Some(ToolsAsk { line, tools: commands, any });
            }
            if !writes.is_empty() {
                writes.truncate(MAX_LISTED);
                asks.writes = Some(ToolsAsk { line, tools: writes, any: false });
            }
        } else if folded == "hooks" {
            if value.is_null() {
                continue;
            }
            let moments = match value {
                Value::Mapping(hooks) => hooks.keys().filter_map(|m| m.as_str().map(str::to_string)).take(MAX_LISTED).collect(),
                _ => Vec::new(),
            };
            asks.hooks = Some(HooksAsk { line, moments });
        } else if !HARMLESS_KEYS.contains(&folded.as_str()) && asks.other.len() < MAX_LISTED {
            // Round 2 (G1.4): an allow-list. A key not known to be harmless asks.
            asks.other.push(KeyAsk::new(line, written));
        }
    }
    // Every key written at the margin is one the parse found. A line that
    // looks like a key and isn't one (inside a flow mapping or a quoted
    // text spanning lines) is read differently by a line reader: it asks.
    for (at, line) in front_lines.iter().enumerate() {
        if let Some(written) = margin_key(line) {
            if !written.contains('\\') && !parsed_keys.contains(&fold_key(written)) {
                asks.unreadable = Some(first + at);
                return;
            }
        }
    }
}

/// A fence line (three or more backticks or tildes) and what follows it.
fn fence(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    for mark in ['`', '~'] {
        let run = trimmed.chars().take_while(|c| *c == mark).count();
        if run >= 3 {
            return Some(&trimmed[run..]);
        }
    }
    None
}

/// What starts a command block for the CLI: three backticks followed by
/// `!`. Its pattern (read from claude 2.1.319) is unanchored and global —
/// ```!\s*\n?([\s\S]*?)\n?``` — so the mark counts wherever it is in the
/// text: after other words on a line, in a quote, in a list item.
const BLOCK_MARK: &str = "```!";

/// The commands a text runs when it loads, over every line of the file (the
/// front matter's too). Both scans are at least as wide as the CLI's:
///
/// - **Block:** every [`BLOCK_MARK`], closed or not, empty or not (the CLI
///   needs a closing ``` and a command that isn't blank).
/// - **Inline:** the CLI's pattern is `(?<=^|\s)!`([^`]+)`` (global,
///   multiline), run on the text after ordinary code spans are blanked, and
///   only when the text holds `` !` ``. Here every `!` directly followed by
///   a backtick counts, whatever comes before it, closed or not, in a code
///   span or not. A match of the CLI's always holds that pair on one line.
fn read_markers(lines: &[&str], asks: &mut Asks) {
    for (index, line) in lines.iter().enumerate() {
        let next = || lines.get(index + 1).map(|next| next.trim()).filter(|next| !next.contains("```")).unwrap_or("");
        let mut rest = *line;
        while let Some(at) = rest.find(BLOCK_MARK) {
            let after = &rest[at + BLOCK_MARK.len()..];
            let here = after.split("```").next().unwrap_or(after).trim();
            push_inline(asks, index + 1, if here.is_empty() { next() } else { here });
            rest = after;
        }
        // `~~~!` at the start of a line: not the CLI's, flagged since B1.
        if fence(line).is_some_and(|after| line.trim_start().starts_with('~') && after.trim_start().starts_with('!')) {
            push_inline(asks, index + 1, lines.get(index + 1).map(|l| l.trim()).filter(|l| fence(l).is_none()).unwrap_or(""));
        }
        // !`command` anywhere in a line, a code block's included: the text is
        // rewritten before any agent reads it.
        let mut rest = *line;
        while let Some(at) = rest.find("!`") {
            let after = &rest[at + 2..];
            let command = after.split('`').next().unwrap_or(after);
            push_inline(asks, index + 1, command.trim());
            rest = after;
        }
    }
}

fn push_inline(asks: &mut Asks, line: usize, command: &str) {
    if asks.inline.len() < MAX_LISTED {
        let command: String = command.chars().take(400).collect();
        asks.inline.push(InlineAsk { line, command });
    }
}

#[cfg(test)]
#[path = "skill_asks_tests.rs"]
mod tests;
