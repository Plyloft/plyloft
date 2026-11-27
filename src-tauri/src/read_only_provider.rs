//! Shared launch contract for proved read-only provider executions.
//!
//! The behavioral probe, Phase 4 reviewers, and every Phase 5 discussion leg
//! must use the same restriction profile. Output framing and prompts may
//! differ, but the enforcement-bearing arguments may not.
//!
//! v1.113.0: Claude runs under `--restricted`. Without it, a user-level
//! permission allow rule (a `Bash(*)` entry in `~/.claude/settings.json`,
//! observed on the owner's second Mac on 2026-09-10) merged into the
//! `dontAsk` profile and pre-approved every shell command — the sentinel
//! write escaped and the probe correctly refused eligibility. Restricted
//! mode ignores user/project/local settings files and confines file tools to
//! the working directory. (`Bash` was kept in `--tools` then, for the denial
//! the probe read; since PR #374 it is not offered at all, see below.)
//!
//! GH #216: the Challenger gets the `Skill` tool, so skills delivered as
//! plugins reach a Claude review: the team library's, Plyloft's own, and
//! the repository's **as the integration branch has them** (review 1).
//! `--restricted` makes Claude ignore the reviewed directory's own
//! `.claude/skills` (and the member's personal skills), so the repository's
//! arrive as the `project` plugin built from the branch mirror — all of
//! them, and never from the card's worktree
//! (`shared_library_sync::review_plugin_dir`). A Builder could add or change
//! a skill in the card telling the reviewer to approve: the reviewer follows
//! the rules already on the branch, never the ones under review. A workspace
//! that does not share its library has no mirror, and then no repository
//! skill reaches a Claude review. Codex has no such flag: it reads
//! `.agents/skills` from its working directory, so the review's detached
//! worktree carries the branch tip's skill folders instead of the card's
//! (`pinned_read::pin_skills_to`). `Skill` only loads a skill's text. Under
//! `claude -p` a skill asking for a shell command or a write was refused
//! (Claude Code 2.1.285, 2026-09-30); in the interactive TUI a skill
//! declaring `allowed-tools: Bash` got Bash past `dontAsk` (2.1.300, PR
//! #374), so no command or write tool is offered at all, and each is
//! disallowed outright (`CLAUDE_READ_ONLY_DISALLOWED_TOOLS`). `--strict-mcp-config` keeps every MCP server but the one
//! Plyloft passes with `--mcp-config` (its own `ply` sidecar) out of the
//! session: the member's claude.ai connectors (`mcp__claude_ai_*`) were
//! listed to the Challenger before, denied only at call time.

use ply_collab::Provider;
use std::path::Path;

/// PR #374 (measured, Claude Code 2.1.300, interactive TUI): a skill whose
/// front matter says `allowed-tools: Bash` widened `dontAsk` — the probe's
/// skill ran `/usr/bin/touch` and the sentinel was written, while the same
/// command asked for directly was denied. So no tool that runs a command or
/// writes is listed at all (`--tools`), and each is also disallowed outright
/// (`--disallowedTools`): either alone kept the write out in that run.
pub(crate) const CLAUDE_READ_ONLY_TOOLS: &str = "Read,Grep,Glob,Skill";
pub(crate) const CLAUDE_READ_ONLY_ALLOWED_TOOLS: &str =
    "Read,Grep,Glob,Skill,mcp__ply__knowledge_search,mcp__ply__knowledge_get";
/// Built-ins that run a command, write, schedule, reach the network or hand
/// work to another agent, disallowed outright. `--tools` is the real
/// boundary (only what it lists exists in the session); this list is a
/// second, best-effort layer, by the names Claude Code 2.1.300 uses, in case
/// a skill or setting ever widens the first. Only names the CLI knows: an
/// unknown one denies nothing and prints `Permission deny rule "…" matches
/// no known tool` in the session's terminal (the plan lanes' and the card
/// Chat's Show terminal, 2026-10-16 walk on 2.1.301), so `MultiEdit` and
/// `REPL` — gone from Claude Code by 2.1.300 — are not listed
/// (`RETIRED_CLAUDE_TOOLS`). `--tools` keeps them out on any version.
pub(crate) const CLAUDE_READ_ONLY_DISALLOWED_TOOLS: &str = "Bash,PowerShell,Monitor,Write,Edit,NotebookEdit,Agent,Task,Workflow,EnterWorktree,ExitWorktree,CronCreate,CronDelete,RemoteTrigger,ScheduleWakeup,SendMessage,TeamCreate,TaskCreate,TaskUpdate,TaskStop,Artifact,LSP,WebFetch,WebSearch";
/// Built-in names Claude Code no longer has (2.1.300 and 2.1.301 warn on
/// each in a deny rule): never in `--disallowedTools`, never in `--tools`.
pub(crate) const RETIRED_CLAUDE_TOOLS: [&str; 2] = ["MultiEdit", "REPL"];
/// `--settings` for a read-only Claude session: a skill's inline shell
/// (`` !`cmd` `` and a ```` ```! ```` block, expanded when the skill loads)
/// never runs. Measured with Claude Code 2.1.300: without it the inline
/// command already met `dontAsk`'s denial; with it the skill loads and the
/// command is not run at all.
pub(crate) const CLAUDE_READ_ONLY_SETTINGS: &str = r#"{"disableSkillShellExecution":true}"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestrictionProfile {
    pub provider: Provider,
    pub session_is_ephemeral: bool,
    pub approval_mode: &'static str,
    pub sandbox_mode: Option<&'static str>,
    pub tools: Option<&'static str>,
    pub allowed_tools: Option<&'static str>,
    pub disallowed_tools: Option<&'static str>,
    /// Claude `--restricted`: user/project/local settings files are ignored
    /// so no personal allow rule can widen the profile.
    pub restricted: bool,
}

pub(crate) fn restriction_profile(provider: Provider) -> Option<RestrictionProfile> {
    match provider {
        Provider::Claude => Some(RestrictionProfile {
            provider,
            session_is_ephemeral: true,
            approval_mode: "dontAsk",
            sandbox_mode: None,
            tools: Some(CLAUDE_READ_ONLY_TOOLS),
            allowed_tools: Some(CLAUDE_READ_ONLY_ALLOWED_TOOLS),
            disallowed_tools: Some(CLAUDE_READ_ONLY_DISALLOWED_TOOLS),
            restricted: true,
        }),
        Provider::Codex => Some(RestrictionProfile {
            provider,
            session_is_ephemeral: true,
            approval_mode: "never",
            sandbox_mode: Some("read-only"),
            tools: None,
            allowed_tools: None,
            disallowed_tools: None,
            restricted: false,
        }),
        _ => None,
    }
}

/// `model` (#74) is the row for the role this spawn plays. It is never
/// enforcement-bearing: `restriction_argv_profile` ignores it, so the
/// probe's proof still covers a session that runs on another model. Blank
/// fields push no flag, which is the behaviour of every Ply before #74.
pub(crate) fn read_only_argv(
    provider: Provider,
    prompt: &str,
    cwd: &Path,
    model: &crate::settings::ModelChoice,
) -> Vec<String> {
    read_only_argv_for(provider, prompt, cwd, model, cfg!(windows))
}

/// Codex's Windows OS sandbox, chosen on the command line so the member's
/// own `config.toml` (which may name none, or `elevated`) never decides it.
///
/// `unelevated` runs each command under a restricted token derived from the
/// member's own, with ACL-enforced filesystem boundaries: Windows itself
/// refuses the write. It needs no administrator setup. `elevated` (separate
/// sandbox users) was measured on 2026-09-25 against codex-cli 0.157.0 and
/// refused: its sandbox user could not even enter the probe's repository in
/// `%TEMP%`, so every read failed too and a review could not see the code.
/// Without either, Codex refuses shell commands by its own policy
/// ("rejected: blocked by policy") — not an OS sandbox, never eligible.
pub(crate) const CODEX_WINDOWS_SANDBOX: &str = "windows.sandbox=unelevated";

/// `windows` chooses the Windows launch contract, so tests on any platform
/// can pin both; the Mac's argv is byte-identical to every Ply before it.
pub(crate) fn read_only_argv_for(
    provider: Provider,
    prompt: &str,
    cwd: &Path,
    model: &crate::settings::ModelChoice,
    windows: bool,
) -> Vec<String> {
    match provider {
        // The interactive TUI, collected through its transcript
        // (`claude_session`), never `claude -p`: the session is named so its
        // transcript can be found, and the prompt is the last argument.
        Provider::Claude => {
            let mut args = vec![
                crate::claude_session::SESSION_ID_FLAG.into(),
                uuid::Uuid::new_v4().to_string(),
                "--permission-mode".into(),
                "dontAsk".into(),
                "--tools".into(),
                CLAUDE_READ_ONLY_TOOLS.into(),
                "--allowedTools".into(),
                CLAUDE_READ_ONLY_ALLOWED_TOOLS.into(),
                "--disallowedTools".into(),
                CLAUDE_READ_ONLY_DISALLOWED_TOOLS.into(),
                // One argv element: no shell parses it, on Windows either.
                "--settings".into(),
                CLAUDE_READ_ONLY_SETTINGS.into(),
                "--restricted".into(),
                "--strict-mcp-config".into(),
            ];
            // 1.169.0 (A1): `--model` and `--effort`, each when chosen.
            args.extend(model.claude_flags());
            args.push(prompt.into());
            args
        }
        Provider::Codex => {
            let mut args: Vec<String> = vec![
                "--ask-for-approval".into(),
                "never".into(),
                "exec".into(),
                "--ephemeral".into(),
            ];
            if let Some(name) = model.model.as_deref() {
                args.push("-m".into());
                args.push(name.to_string());
            }
            if let Some(effort) = model.reasoning.as_deref() {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort={effort}"));
            }
            if windows {
                args.push("-c".into());
                args.push(CODEX_WINDOWS_SANDBOX.into());
            }
            args.extend([
                "--sandbox".into(),
                "read-only".into(),
                "--cd".into(),
                cwd.to_string_lossy().into_owned(),
                "--json".into(),
                prompt.into(),
            ]);
            args
        }
        _ => Vec::new(),
    }
}

/// Windows: ConPTY opens every collected run with its own escape sequences
/// (`ESC[?9001h … ESC]0;claude BEL ESC[?25h`) on the same line as the first
/// byte the CLI writes, and closes it with more. Claude's `--output-format
/// json` answer is that one line, so it never parsed and every review said
/// "returned no final message". Terminal escapes are dropped before a line
/// is read as JSON; JSON itself never carries a raw ESC, so no answer loses
/// a byte, and the Mac's output (which has none) reads as before.
///
/// ConPTY may also draw a run of spaces as an erase and a cursor move
/// instead of the spaces themselves: `ESC[<n>X` (erase n cells, the cursor
/// stays) and then, before the next text, `ESC[<n>C` (forward n). Dropped
/// like the other escapes, a run of spaces inside an answer — its
/// indentation — collapsed to nothing. Both become spaces first: the erase
/// its n, and a forward right after it only what goes past the erased cells,
/// so the pair is n spaces and not 2n. Also used by the Windows Codex
/// probe's evidence (`review_capabilities::codex_windows_evidence`).
pub(crate) fn json_text(text: &str) -> String {
    crate::verify::strip_ansi(&spaces_for_cursor_runs(text))
}

/// The most spaces one `ESC[<n>C` / `ESC[<n>X` stands for: ConPTY's widest
/// screen (`pty::COLLECT_COLS`). A larger count is not a run of spaces.
const MAX_SPACE_RUN: usize = 32_767;

/// `ESC[<n>X`, `ESC[<n>C` and `ESC[<n>G` as the spaces they draw (see
/// `json_text`); every other byte, escapes included, unchanged.
///
/// 1.168.1 (A3, Mac walk): Claude Code's TUI moves to each word's column
/// with `ESC[<n>G` (cursor to column n) instead of writing the space before
/// it (`Try ESC[7G"create ESC[15Ga`), so the intake transcript read
/// "Howdowecountwords?". A move forward of the column this line has reached
/// is that many spaces; a move back (a repaint) draws nothing. The column is
/// counted in characters since the last `\r` or `\n`, escapes not counted.
fn spaces_for_cursor_runs(text: &str) -> String {
    if !text.contains('\x1b') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    // Cells the erase just before this point cleared: the forward that
    // follows it covers them first.
    let mut erased = 0usize;
    // The column (0-based) the text so far on this line has reached.
    let mut col = 0usize;
    let advance = |col: &mut usize, text: &str| {
        for c in text.chars() {
            match c {
                '\r' | '\n' => *col = 0,
                c if c.is_control() => {}
                _ => *col += 1,
            }
        }
    };
    let mut rest = text;
    while let Some(at) = rest.find('\x1b') {
        if at > 0 {
            erased = 0;
        }
        out.push_str(&rest[..at]);
        advance(&mut col, &rest[..at]);
        let seq = &rest[at..];
        let digits = seq
            .get(2..)
            .filter(|_| seq.as_bytes().get(1) == Some(&b'['))
            .map(|tail| tail.bytes().take_while(u8::is_ascii_digit).count());
        let parsed = digits.and_then(|len| {
            let final_byte = *seq.as_bytes().get(2 + len)?;
            if !matches!(final_byte, b'C' | b'X' | b'G') {
                return None;
            }
            let count = if len == 0 { 1 } else { seq[2..2 + len].parse::<usize>().ok()? };
            (count <= MAX_SPACE_RUN).then_some((final_byte, count, 3 + len))
        });
        match parsed {
            Some((b'X', count, used)) => {
                out.extend(std::iter::repeat_n(' ', count));
                col += count;
                erased = count;
                rest = &seq[used..];
            }
            Some((b'G', column, used)) => {
                let to = column.saturating_sub(1);
                if to > col {
                    out.extend(std::iter::repeat_n(' ', to - col));
                    col = to;
                }
                erased = 0;
                rest = &seq[used..];
            }
            Some((_, count, used)) => {
                let n = count.saturating_sub(erased);
                out.extend(std::iter::repeat_n(' ', n));
                col += n;
                erased = 0;
                rest = &seq[used..];
            }
            None => {
                // Another escape: copied whole, for `strip_ansi`, and not
                // counted as columns.
                erased = 0;
                let len = escape_len(seq);
                out.push_str(&seq[..len]);
                rest = &seq[len..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The length in bytes of the escape sequence `seq` opens (`seq` starts with
/// ESC), as `verify::strip_ansi` reads it: CSI to its final letter, OSC to
/// BEL or ESC \\, a charset designation (`ESC ( B`) its three bytes, any
/// other ESC and the character after it. Never past the end.
fn escape_len(seq: &str) -> usize {
    let bytes = seq.as_bytes();
    match bytes.get(1) {
        None => 1,
        Some(b'[') => bytes[2..]
            .iter()
            .position(u8::is_ascii_alphabetic)
            .map_or(bytes.len(), |p| p + 3),
        Some(b']') => {
            let mut i = 2;
            while i < bytes.len() {
                if bytes[i] == 0x07 {
                    return i + 1;
                }
                if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                    return i + 2;
                }
                i += 1;
            }
            bytes.len()
        }
        Some(b'(' | b')' | b'*' | b'+') if bytes.len() >= 3 && bytes[2].is_ascii() => 3,
        Some(_) => 1 + seq[1..].chars().next().map_or(0, char::len_utf8),
    }
}

pub(crate) fn extract_final_message(provider: Provider, raw: &str) -> Option<String> {
    let raw = &json_text(raw);
    let mut found = None;
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(result) = value.get("result").and_then(|item| item.as_str()) {
            found = Some(result.to_string());
        }
        // ADR 0006: Claude under `--json-schema` returns the answer as
        // `structured_output`, the validated object; it wins over `result`.
        if let Some(structured) = value.get("structured_output").filter(|item| item.is_object()) {
            found = Some(structured.to_string());
        }
        if value.get("type").and_then(|item| item.as_str()) == Some("agent_message") {
            if let Some(text) = value.get("text").and_then(|item| item.as_str()) {
                found = Some(text.to_string());
            }
        }
        if let Some(item) = value.get("item") {
            if item.get("type").and_then(|value| value.as_str()) == Some("agent_message") {
                if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                    found = Some(text.to_string());
                }
            }
        }
    }
    if found.is_none() && provider == Provider::Claude {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
            found = value
                .get("structured_output")
                .filter(|item| item.is_object())
                .map(|item| item.to_string())
                .or_else(|| value.get("result").and_then(|item| item.as_str()).map(str::to_string));
        }
    }
    found
}

/// #74: why a refused run was refused, in the provider's own words.
///
/// A CLI that rejects the run — an unknown model is the clearest case —
/// never writes an `agent_message`, so `extract_final_message` returns
/// nothing and the review record would only say "exited with status 1".
/// Claude reports it as the `result` of an `is_error` envelope; Codex
/// emits `turn.failed` (authoritative), a top-level `error` event, and an
/// `item.completed` error item (often only a warning) — ranked in that
/// order, latest wins within a rank.
pub(crate) fn extract_error_message(provider: Provider, raw: &str) -> Option<String> {
    let raw = &json_text(raw);
    let mut best: Option<(u8, String)> = None;
    let consider = |best: &mut Option<(u8, String)>, value: &serde_json::Value| {
        let Some((rank, message)) = error_candidate(provider, value) else {
            return;
        };
        if message.trim().is_empty() {
            return;
        }
        if best.as_ref().map_or(true, |(seen, _)| rank >= *seen) {
            *best = Some((rank, message.trim().to_string()));
        }
    };
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            consider(&mut best, &value);
        }
    }
    if best.is_none() {
        // Claude's `--output-format json` is one pretty-printed object.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
            consider(&mut best, &value);
        }
    }
    best.map(|(_, message)| unwrap_nested_error(&message))
}

/// The refusal one output event carries, with its rank. Ranks order the
/// events by authority: `turn.failed` is the terminal failure, a top-level
/// `error` is the failure as it happened, and an `item.completed` error
/// item is often only a warning ("Defaulting to fallback metadata").
fn error_candidate(provider: Provider, value: &serde_json::Value) -> Option<(u8, String)> {
    let text = |item: Option<&serde_json::Value>| {
        item.and_then(|item| item.as_str()).map(str::to_string)
    };
    match provider {
        Provider::Claude => {
            if value.get("is_error").and_then(|flag| flag.as_bool()) != Some(true) {
                return None;
            }
            text(value.get("result")).map(|result| (2, result))
        }
        Provider::Codex => {
            match value.get("type").and_then(|item| item.as_str()) {
                Some("turn.failed") => {
                    if let Some(message) =
                        text(value.get("error").and_then(|error| error.get("message")))
                    {
                        return Some((3, message));
                    }
                }
                Some("error") => {
                    if let Some(message) = text(value.get("message")) {
                        return Some((2, message));
                    }
                }
                _ => {}
            }
            let item = value.get("item")?;
            if item.get("type").and_then(|value| value.as_str()) != Some("error") {
                return None;
            }
            text(item.get("message")).map(|message| (1, message))
        }
        _ => None,
    }
}

/// GH #99: the last plain (non-JSON) line a refused run printed — a CLI
/// that rejects its arguments ("error: unexpected argument '--x' found")
/// or fails before its JSON stream starts writes only text. Terminal
/// escapes are removed; clap's trailing usage hint is skipped for the
/// line that names the error.
pub(crate) fn extract_plain_error(raw: &str) -> Option<String> {
    let lines: Vec<String> = raw
        .lines()
        .map(strip_ansi)
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .filter(|line| serde_json::from_str::<serde_json::Value>(line).is_err())
        .collect();
    lines
        .iter()
        .find(|line| line.to_ascii_lowercase().starts_with("error"))
        .or_else(|| lines.last())
        .cloned()
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // CSI: parameters until a final byte in @..~.
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Codex wraps the upstream API error as JSON inside the message string.
/// One level of unwrapping turns `{"type":"error","status":400,"error":
/// {"message":"The '…' model is not supported…"}}` back into the sentence
/// the human needs.
fn unwrap_nested_error(message: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(message.trim()) else {
        return message.to_string();
    };
    value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(|item| item.as_str())
        .or_else(|| value.get("message").and_then(|item| item.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| message.to_string())
}

/// The Claude session contract's name in its restriction profile: v2 has no
/// command or write tool at all (`CLAUDE_READ_ONLY_DISALLOWED_TOOLS`), v3
/// also turns a skill's inline shell off (`CLAUDE_READ_ONLY_SETTINGS`).
pub(crate) const CLAUDE_SESSION_PROFILE: &str = "interactive-session-v3";

pub(crate) fn restriction_argv_profile(
    provider: Provider,
    args: &[String],
) -> Result<Vec<String>, String> {
    restriction_argv_profile_for(provider, args, cfg!(windows))
}

pub(crate) fn restriction_argv_profile_for(
    provider: Provider,
    args: &[String],
    windows: bool,
) -> Result<Vec<String>, String> {
    let pair_value = |flag: &str| {
        args.iter()
            .position(|argument| argument == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
            .ok_or_else(|| format!("missing restriction argument {flag}"))
    };
    match provider {
        Provider::Claude => {
            if crate::claude_session::collected_session_id(args).is_none() {
                return Err("missing an interactive --session-id (and no -p)".into());
            }
            if !args.iter().any(|argument| argument == "--restricted") {
                return Err("missing --restricted".into());
            }
            if !args.iter().any(|argument| argument == "--strict-mcp-config") {
                return Err("missing --strict-mcp-config".into());
            }
            Ok(vec![
                CLAUDE_SESSION_PROFILE.into(),
                "--restricted".into(),
                "--strict-mcp-config".into(),
                pair_value("--permission-mode")?,
                pair_value("--tools")?,
                pair_value("--allowedTools")?,
                pair_value("--disallowedTools")?,
                pair_value("--settings")?,
            ])
        }
        Provider::Codex => {
            let approval_index = args
                .iter()
                .position(|argument| argument == "--ask-for-approval")
                .ok_or_else(|| "missing --ask-for-approval".to_string())?;
            let exec_index = args
                .iter()
                .position(|argument| argument == "exec")
                .ok_or_else(|| "missing exec".to_string())?;
            if approval_index >= exec_index {
                return Err("--ask-for-approval must precede exec".into());
            }
            if !args.iter().any(|argument| argument == "--ephemeral") {
                return Err("missing --ephemeral".into());
            }
            let mut profile = vec![
                "--ask-for-approval".into(),
                pair_value("--ask-for-approval")?,
                "--ephemeral".into(),
                "--sandbox".into(),
                pair_value("--sandbox")?,
            ];
            if windows {
                // Enforcement-bearing on Windows: without it Codex has no OS
                // sandbox at all. Any other `-c` (a reasoning effort) is not.
                let sandbox = args
                    .windows(2)
                    .filter(|pair| pair[0] == "-c" && pair[1].starts_with("windows.sandbox="))
                    .map(|pair| pair[1].clone())
                    .collect::<Vec<_>>();
                if sandbox.as_slice() != [CODEX_WINDOWS_SANDBOX] {
                    return Err(format!("missing -c {CODEX_WINDOWS_SANDBOX}"));
                }
                profile.push("-c".into());
                profile.push(CODEX_WINDOWS_SANDBOX.into());
            }
            Ok(profile)
        }
        _ => Err("read-only restriction profile supports Claude or Codex".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ModelChoice;

    fn no_model() -> ModelChoice {
        ModelChoice::default()
    }

    /// 1.169.0 (B2 Challenger, 3): a one-line JSON answer with runs of
    /// spaces, collected at `pty::COLLECT_COLS` (32767) through each
    /// ConPTY in the Windows 11 VM (`cmd /c type` of the file; its ⚠️ comes
    /// back in cmd's code page either way). The bundled one opens with its
    /// own `ESC[1t ESC[c ESC[?1004h ESC[?9001h ESC[?7l ESC[?7h` on the
    /// answer's line; both read as the same JSON, spaces kept.
    #[test]
    fn a_collected_json_answer_reads_the_same_on_both_conptys() {
        let read = |bytes: &[u8]| -> serde_json::Value {
            let text = json_text(&String::from_utf8_lossy(bytes));
            let line = text.lines().find(|l| l.trim_start().starts_with('{')).expect("a JSON line");
            serde_json::from_str(line.trim()).expect("parses")
        };
        let system = read(include_bytes!("conpty_fixtures/collect-json-system.bin"));
        let bundled = read(include_bytes!("conpty_fixtures/collect-json-bundled.bin"));
        assert_eq!(system, bundled);
        assert!(bundled["result"].as_str().unwrap().contains("\n    indented    four   spaces\n"));
        assert_eq!(bundled["permission_denials"][0]["tool_input"]["command"], "ls     -la");
        assert_eq!(bundled["pad"].as_str().unwrap().len(), "word ".len() * 400);
    }

    #[test]
    fn argv_preserves_provider_contract_ordering() {
        let cwd = Path::new("/tmp/pinned");
        let claude = read_only_argv(Provider::Claude, "prompt", cwd, &no_model());
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "dontAsk"]));
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--tools", CLAUDE_READ_ONLY_TOOLS]));
        assert!(claude
            .windows(2)
            .any(|pair| { pair == ["--allowedTools", CLAUDE_READ_ONLY_ALLOWED_TOOLS] }));
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--disallowedTools", CLAUDE_READ_ONLY_DISALLOWED_TOOLS]));
        // A skill's inline shell is off: one argv element, valid JSON.
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--settings", CLAUDE_READ_ONLY_SETTINGS]));
        let settings: serde_json::Value = serde_json::from_str(CLAUDE_READ_ONLY_SETTINGS).unwrap();
        assert_eq!(settings["disableSkillShellExecution"], serde_json::json!(true));
        let windows = read_only_argv_for(Provider::Claude, "prompt", cwd, &no_model(), true);
        assert!(windows.windows(2).any(|pair| pair == ["--settings", CLAUDE_READ_ONLY_SETTINGS]));
        assert!(claude.iter().any(|argument| argument == "--restricted"));
        assert!(claude.iter().any(|argument| argument == "--strict-mcp-config"));

        let codex = read_only_argv(Provider::Codex, "prompt", cwd, &no_model());
        let approval = codex
            .iter()
            .position(|argument| argument == "--ask-for-approval")
            .unwrap();
        let exec = codex
            .iter()
            .position(|argument| argument == "exec")
            .unwrap();
        assert!(approval < exec);
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));
    }

    /// #74: a chosen model reaches the CLI but is not enforcement-bearing
    /// — the probe's restriction profile of the same argv is unchanged, so
    /// a review may run on a different model than the proof was taken on.
    #[test]
    fn a_model_rides_along_without_touching_the_restriction_profile() {
        let cwd = Path::new("/tmp/pinned");
        let claude_model = ModelChoice {
            model: Some("sonnet".into()),
            reasoning: None,
        };
        let claude = read_only_argv(
            Provider::Claude,
            "prompt",
            cwd,
            &claude_model,
        );
        assert!(claude.windows(2).any(|pair| pair == ["--model", "sonnet"]));
        // 1.169.0 (A1): Claude's effort rides along too, profile unchanged.
        let with_effort = read_only_argv(
            Provider::Claude,
            "prompt",
            cwd,
            &ModelChoice { model: Some("sonnet".into()), reasoning: Some("max".into()) },
        );
        assert!(with_effort.windows(2).any(|pair| pair == ["--effort", "max"]));
        assert_eq!(with_effort.last().map(String::as_str), Some("prompt"));
        assert_eq!(
            restriction_argv_profile(Provider::Claude, &with_effort).unwrap(),
            restriction_argv_profile(Provider::Claude, &read_only_argv(Provider::Claude, "prompt", cwd, &no_model())).unwrap()
        );
        assert_eq!(
            restriction_argv_profile(Provider::Claude, &claude).unwrap(),
            restriction_argv_profile(
                Provider::Claude,
                &read_only_argv(Provider::Claude, "prompt", cwd, &no_model())
            )
            .unwrap()
        );

        let codex_model = ModelChoice {
            model: Some("gpt-6-astra".into()),
            reasoning: Some("medium".into()),
        };
        let codex = read_only_argv(
            Provider::Codex,
            "prompt",
            cwd,
            &codex_model,
        );
        assert!(codex.windows(2).any(|pair| pair == ["-m", "gpt-6-astra"]));
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["-c", "model_reasoning_effort=medium"]));
        // Still after `exec`, and the read-only sandbox is untouched.
        let exec = codex.iter().position(|arg| arg == "exec").unwrap();
        assert!(exec < codex.iter().position(|arg| arg == "-m").unwrap());
        assert!(codex.windows(2).any(|pair| pair == ["--sandbox", "read-only"]));
        assert_eq!(
            restriction_argv_profile(Provider::Codex, &codex).unwrap(),
            restriction_argv_profile(
                Provider::Codex,
                &read_only_argv(Provider::Codex, "prompt", cwd, &no_model())
            )
            .unwrap()
        );
    }

    /// #74 (Challenger P2 on snapshot 1): a Codex run that refuses the
    /// model writes no `agent_message`, so `extract_final_message` sees
    /// nothing and the review record would only have said "exited with
    /// status 1". These are the real events `codex exec --json -m
    /// ply-bogus-model` printed on 2026-09-16.
    #[test]
    fn codex_refusal_events_yield_the_reason_where_the_final_message_is_empty() {
        let raw = concat!(
            r#"{"type":"thread.started","thread_id":"01a0a916"}"#,
            "\n",
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `ply-bogus-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}"#,
            "\n",
            r#"{"type":"turn.started"}"#,
            "\n",
            r#"{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'ply-bogus-model' model is not supported when using Codex with a ChatGPT account.\"}}"}"#,
            "\n",
            r#"{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'ply-bogus-model' model is not supported when using Codex with a ChatGPT account.\"}}"}}"#,
            "\n",
        );
        assert_eq!(extract_final_message(Provider::Codex, raw), None);
        // `turn.failed` outranks the fallback-metadata warning, and the
        // API error nested inside the message string is unwrapped.
        assert_eq!(
            extract_error_message(Provider::Codex, raw).as_deref(),
            Some("The 'ply-bogus-model' model is not supported when using Codex with a ChatGPT account.")
        );

        // The warning alone, with no failure, is still better than nothing.
        let warning_only = r#"{"type":"item.completed","item":{"type":"error","message":"Model metadata for `x` not found."}}"#;
        assert_eq!(
            extract_error_message(Provider::Codex, warning_only).as_deref(),
            Some("Model metadata for `x` not found.")
        );

        // A clean review carries no refusal.
        let clean = concat!(
            r#"{"type":"thread.started"}"#,
            "\n",
            r###"{"type":"item.completed","item":{"type":"agent_message","text":"## Verdict\nAPPROVE"}}"###,
            "\n",
        );
        assert_eq!(extract_error_message(Provider::Codex, clean), None);
    }

    /// #74: Claude reports the same refusal as the `result` of an
    /// `is_error` envelope — the shape `claude -p … --output-format json
    /// --model ply-bogus-model` printed on 2026-09-16 — while a successful
    /// review's `result` is never mistaken for an error.
    #[test]
    fn claude_refusal_comes_from_the_is_error_envelope_only() {
        let refused = r#"{"is_error":true,"subtype":"success","type":"result","result":"There's an issue with the selected model (ply-bogus-model). It may not exist or you may not have access to it."}"#;
        assert_eq!(
            extract_error_message(Provider::Claude, refused).as_deref(),
            Some("There's an issue with the selected model (ply-bogus-model). It may not exist or you may not have access to it.")
        );
        let approved = r###"{"type":"result","is_error":false,"result":"## Verdict\nAPPROVE"}"###;
        assert_eq!(extract_error_message(Provider::Claude, approved), None);
        assert_eq!(
            extract_final_message(Provider::Claude, approved).as_deref(),
            Some("## Verdict\nAPPROVE")
        );
    }

    /// Windows: a Claude review collected through ConPTY, as the VM printed
    /// it on 2026-09-25 (claude.exe 2.1.282, `--output-format json
    /// --json-schema`, 32767 columns; the answer trimmed). ConPTY's opening
    /// sequences share the one JSON line, and its closing ones follow it.
    /// Before, this was "Reviewer returned no final message".
    #[test]
    fn a_claude_answer_behind_conpty_escapes_is_read() {
        let raw = "\u{1b}[?9001h\u{1b}[?1004h\u{1b}[?25l\u{1b}[2J\u{1b}[m\u{1b}[H\u{1b}]0;claude\u{7}\u{1b}[?25h\
{\"duration_api_ms\":19501,\"stop_reason\":\"tool_use\",\"permission_denials\":[],\"terminal_reason\":\"completed\",\
\"is_error\":false,\"subtype\":\"success\",\"result\":\"{\\\"verdict\\\":\\\"CHANGES_REQUESTED\\\"}\",\
\"structured_output\":{\"verdict\":\"CHANGES_REQUESTED\",\"findings\":[{\"severity\":\"P1\",\"path\":\"greet.py\",\"line\":3,\
\"title\":\"NameError: nme\",\"body\":\"C:\\\\temp\\\\ \\u001b is text\"}],\"verificationGaps\":[\"Bash is denied.\"]},\
\"ttft_ms\":1523,\"type\":\"result\",\"duration_ms\":19652,\"result_index\":0}\r\n\u{1b}[?9001l\u{1b}[?1004l";
        let answer = extract_final_message(Provider::Claude, raw).expect("the answer is read");
        let value: serde_json::Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(value["verdict"], "CHANGES_REQUESTED");
        assert_eq!(value["findings"][0]["title"], "NameError: nme");
        // An escaped ESC and backslashes inside the answer are the answer's own.
        assert_eq!(value["findings"][0]["body"], "C:\\temp\\ \u{1b} is text");
        assert_eq!(extract_error_message(Provider::Claude, raw), None);

        // A refusal behind the same escapes still says why.
        let refused = "\u{1b}[?9001h\u{1b}]0;claude\u{7}\u{1b}[?25h{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in\"}\r\n\u{1b}[?9001l";
        assert_eq!(extract_error_message(Provider::Claude, refused).as_deref(), Some("Not logged in"));
        assert_eq!(extract_final_message(Provider::Claude, "\u{1b}[?25h\r\n\u{1b}[?9001l"), None);
    }

    /// ConPTY may draw a run of spaces as `ESC[<n>X` (erase) and
    /// `ESC[<n>C` (forward): the indentation inside an answer survives.
    #[test]
    fn conpty_space_runs_inside_an_answer_are_spaces() {
        // The pair is n spaces, not 2n.
        let raw = "{\"type\":\"result\",\"result\":\"fn main() {\\n\u{1b}[4X\u{1b}[4Creturn;\\n}\"}\r\n";
        assert_eq!(
            extract_final_message(Provider::Claude, raw).as_deref(),
            Some("fn main() {\n    return;\n}")
        );
        // A forward alone, an erase alone, and the no-count forms.
        assert_eq!(json_text("a\u{1b}[3Cb"), "a   b");
        assert_eq!(json_text("a\u{1b}[2Xb"), "a  b");
        assert_eq!(json_text("a\u{1b}[Cb\u{1b}[Xc"), "a b c");
        // A forward longer than the erase before it adds only the rest.
        assert_eq!(json_text("a\u{1b}[2X\u{1b}[5Cb"), "a     b");
        // Text between them: the forward is its own run.
        assert_eq!(json_text("a\u{1b}[2Xb\u{1b}[2Cc"), "a  b  c");
        // Other escapes are still dropped, and a Codex JSON line behind them
        // reads as before.
        assert_eq!(json_text("\u{1b}[?25l\u{1b}[1;1H\u{1b}[31mx\u{1b}[0m"), "x");
        assert_eq!(json_text("plain {\"a\":1}"), "plain {\"a\":1}");
        // An escape at the very end, or a count past the widest screen, is
        // not a run of spaces.
        assert_eq!(json_text("a\u{1b}["), "a");
        assert_eq!(json_text("a\u{1b}[99999Cb"), "ab");
        let codex = "\u{1b}[?25h{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"-\u{1b}[2X\u{1b}[2Cindented\"}}\r\n";
        assert_eq!(extract_final_message(Provider::Codex, codex).as_deref(), Some("-  indented"));
    }

    /// 1.168.1 (A3, Mac walk): Claude Code 2.1.x moves to each word's column
    /// with `ESC[<n>G`; those moves are the spaces. Excerpts of a real
    /// Claude Code 2.1.300 PTY capture (the Plyloft Test profile).
    #[test]
    fn claude_codes_column_moves_are_the_spaces_between_words() {
        let tip = "\u{276f} \u{1b}[2mTry\u{1b}[7G\"create\u{1b}[15Ga\u{1b}[17Gutil\u{1b}[22Glogging.py\u{1b}[33Gthat...\"\u{1b}[22m\r\r\n";
        assert_eq!(json_text(tip), "\u{276f} Try \"create a util logging.py that...\"\r\r\n");
        let banner = "\u{1b}[38;2;215;119;87m \u{2590}\u{1b}[48;2;0;0;0m\u{259b}\u{2588}\u{2588}\u{2588}\u{259c}\u{2588}\u{1b}[12G\u{1b}[39m\u{1b}[49m\u{1b}[1mClaude\u{1b}[19GCode\u{1b}[24G\u{1b}[22m\u{1b}[38;2;153;153;153mv2.1.300\u{1b}[39m\r\r\n";
        assert_eq!(json_text(banner), " \u{2590}\u{259b}\u{2588}\u{2588}\u{2588}\u{259c}\u{2588}   Claude Code v2.1.300\r\r\n");
        // The column counts from the line's start; a move back draws nothing.
        assert_eq!(json_text("ab\r\ncd\u{1b}[4Ge"), "ab\r\ncd e");
        assert_eq!(json_text("abcdef\u{1b}[3Gx"), "abcdefx");
        assert_eq!(json_text("\u{1b}[Gx"), "x");
        // A charset designation and shift-in draw nothing ("B\u{2327}" before).
        assert_eq!(json_text("  \u{1b}(B\u{f}\r\u{276f} 1a"), "  \r\u{276f} 1a");
    }

    /// GH #99: a refusal printed as plain text still carries its reason.
    #[test]
    fn a_plain_text_refusal_yields_its_error_line() {
        let clap = "\u{1b}[1m\u{1b}[31merror:\u{1b}[0m unexpected argument '--bogus' found\r\n\r\nUsage: codex exec [OPTIONS]\r\n\r\nFor more information, try '--help'.\r\n";
        assert_eq!(
            extract_plain_error(clap).as_deref(),
            Some("error: unexpected argument '--bogus' found")
        );
        assert_eq!(
            extract_plain_error("{\"type\":\"thread.started\"}\nsomething broke\n").as_deref(),
            Some("something broke")
        );
        assert_eq!(extract_plain_error("{\"type\":\"x\"}\n\n"), None);
    }

    /// The Mac's Codex argv, pinned byte for byte: the Windows sandbox
    /// choice never reaches it.
    #[test]
    fn codex_argv_on_the_mac_is_unchanged() {
        let cwd = Path::new("/tmp/pinned");
        let mac = read_only_argv_for(Provider::Codex, "prompt", cwd, &no_model(), false);
        assert_eq!(
            mac,
            [
                "--ask-for-approval", "never", "exec", "--ephemeral", "--sandbox", "read-only",
                "--cd", "/tmp/pinned", "--json", "prompt",
            ]
        );
        assert_eq!(
            restriction_argv_profile_for(Provider::Codex, &mac, false).unwrap(),
            ["--ask-for-approval", "never", "--ephemeral", "--sandbox", "read-only"]
        );
    }

    /// Windows: Codex's OS sandbox is chosen on the command line, after
    /// `exec` and beside `--sandbox read-only`, and it is enforcement-bearing
    /// — an argv without it (Codex's own "blocked by policy" and no OS
    /// sandbox) fails the contract check; another `-c` does not satisfy it.
    #[test]
    fn codex_argv_on_windows_carries_the_os_sandbox() {
        let cwd = Path::new("/tmp/pinned");
        let model = ModelChoice {
            model: None,
            reasoning: Some("high".into()),
        };
        let win = read_only_argv_for(Provider::Codex, "prompt", cwd, &model, true);
        let exec = win.iter().position(|arg| arg == "exec").unwrap();
        let sandbox = win
            .windows(2)
            .position(|pair| pair == ["-c", CODEX_WINDOWS_SANDBOX])
            .unwrap();
        assert!(exec < sandbox);
        assert_eq!(&win[sandbox + 2..sandbox + 4], ["--sandbox", "read-only"]);
        assert_eq!(
            restriction_argv_profile_for(Provider::Codex, &win, true).unwrap(),
            [
                "--ask-for-approval", "never", "--ephemeral", "--sandbox", "read-only", "-c",
                CODEX_WINDOWS_SANDBOX,
            ]
        );

        let without = read_only_argv_for(Provider::Codex, "prompt", cwd, &model, false);
        assert_eq!(
            restriction_argv_profile_for(Provider::Codex, &without, true).unwrap_err(),
            format!("missing -c {CODEX_WINDOWS_SANDBOX}")
        );
        let mut elevated = win.clone();
        elevated[sandbox + 1] = "windows.sandbox=elevated".into();
        assert!(restriction_argv_profile_for(Provider::Codex, &elevated, true).is_err());
        // Claude's contract is the same on both platforms (each session is
        // named afresh, so its id is left out of the comparison).
        let unnamed = |windows| {
            let mut argv = read_only_argv_for(Provider::Claude, "prompt", cwd, &no_model(), windows);
            let at = argv.iter().position(|a| a == crate::claude_session::SESSION_ID_FLAG).unwrap();
            argv.drain(at..at + 2);
            argv
        };
        assert_eq!(unnamed(true), unnamed(false));
    }

    #[test]
    fn claude_argv_without_restricted_fails_the_contract_check() {
        // The 2026-09-10 escape: a user `Bash(*)` allow rule widened the
        // dontAsk profile. `--restricted` is now enforcement-bearing, so an
        // argv that drops it must be rejected before it ever spawns.
        let cwd = Path::new("/tmp/pinned");
        let mut argv = read_only_argv(Provider::Claude, "prompt", cwd, &no_model());
        assert!(restriction_argv_profile(Provider::Claude, &argv).is_ok());
        argv.retain(|argument| argument != "--restricted");
        assert_eq!(
            restriction_argv_profile(Provider::Claude, &argv).unwrap_err(),
            "missing --restricted"
        );
    }

    /// GH #216: the Challenger may load a skill, but a skill cannot widen
    /// what it may do: nothing that runs a command or writes is allowed,
    /// and the member's own MCP servers and claude.ai connectors stay out
    /// (`--strict-mcp-config`, enforcement-bearing like `--restricted`).
    #[test]
    fn claude_challenger_loads_skills_without_widening_writes() {
        let tools: Vec<&str> = CLAUDE_READ_ONLY_TOOLS.split(',').collect();
        let allowed: Vec<&str> = CLAUDE_READ_ONLY_ALLOWED_TOOLS.split(',').collect();
        assert!(tools.contains(&"Skill"));
        assert!(allowed.contains(&"Skill"));
        for writer in ["Bash", "Write", "Edit", "NotebookEdit", "PowerShell"] {
            assert!(!allowed.contains(&writer), "{writer} must stay out of --allowedTools");
        }
        // PR #374: a skill's `allowed-tools: Bash` widened `dontAsk` in the
        // interactive TUI, so nothing that runs a command or writes is even
        // offered, and each one is disallowed outright.
        let disallowed: Vec<&str> = CLAUDE_READ_ONLY_DISALLOWED_TOOLS.split(',').collect();
        for writer in [
            "Bash", "PowerShell", "Monitor", "Write", "Edit", "NotebookEdit", "Agent", "Task", "Workflow", "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "RemoteTrigger",
            "ScheduleWakeup", "SendMessage", "TeamCreate", "TaskCreate", "TaskUpdate", "TaskStop", "Artifact",
            "LSP", "WebFetch", "WebSearch",
        ] {
            assert!(!tools.contains(&writer), "{writer} must stay out of --tools");
            assert!(disallowed.contains(&writer), "{writer} must be in --disallowedTools");
        }
        assert!(tools.iter().all(|tool| !disallowed.contains(tool)));
        // 2026-10-16 walk: a name Claude Code doesn't know prints "matches
        // no known tool" in the session and denies nothing.
        for retired in RETIRED_CLAUDE_TOOLS {
            assert!(!disallowed.contains(&retired), "{retired} is not a Claude Code tool any more");
            assert!(!tools.contains(&retired), "{retired} must stay out of --tools");
        }
        assert!(allowed
            .iter()
            .all(|tool| !tool.starts_with("mcp__") || tool.starts_with("mcp__ply__")));

        let cwd = Path::new("/tmp/pinned");
        let mut argv = read_only_argv(Provider::Claude, "prompt", cwd, &no_model());
        let profile = restriction_argv_profile(Provider::Claude, &argv).unwrap();
        assert!(profile.iter().any(|argument| argument == "--strict-mcp-config"));
        argv.retain(|argument| argument != "--strict-mcp-config");
        assert_eq!(
            restriction_argv_profile(Provider::Claude, &argv).unwrap_err(),
            "missing --strict-mcp-config"
        );
    }

    /// The Claude read-only session is the interactive TUI, never
    /// `claude -p`: a named session (its transcript is how it is collected)
    /// with the prompt as its last argument, after flags that take one value.
    #[test]
    fn the_claude_session_is_interactive_and_named() {
        let argv = read_only_argv(Provider::Claude, "review this", Path::new("/tmp/pinned"), &no_model());
        assert!(!argv.iter().any(|a| a == "-p" || a == "--print" || a == "--output-format"));
        let id = crate::claude_session::collected_session_id(&argv).expect("a named session");
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(argv.last().map(String::as_str), Some("review this"));
        assert_eq!(argv[argv.len() - 2], "--strict-mcp-config");
        let profile = restriction_argv_profile(Provider::Claude, &argv).unwrap();
        assert_eq!(profile[0], CLAUDE_SESSION_PROFILE);
        assert!(profile.iter().any(|value| value == CLAUDE_READ_ONLY_DISALLOWED_TOOLS));
        assert_eq!(profile.last().map(String::as_str), Some(CLAUDE_READ_ONLY_SETTINGS));
        // A recorded argv without the inline-shell switch is not this contract.
        let mut older = argv.clone();
        let at = older.iter().position(|a| a == "--settings").unwrap();
        older.drain(at..at + 2);
        assert_eq!(
            restriction_argv_profile(Provider::Claude, &older).unwrap_err(),
            "missing restriction argument --settings"
        );
        // A recorded argv without the disallowed list is not this contract.
        let mut old = argv.clone();
        let at = old.iter().position(|a| a == "--disallowedTools").unwrap();
        old.drain(at..at + 2);
        assert_eq!(
            restriction_argv_profile(Provider::Claude, &old).unwrap_err(),
            "missing restriction argument --disallowedTools"
        );
    }
}
