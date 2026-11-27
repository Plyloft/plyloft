//! 1.176.3 (A5F-01, REV-F1-round2.md): what a Builder session's screen
//! says it is doing — a turn running, a question waiting, back at its
//! prompt, or none of those — read from the rows of its emulated grid
//! (`builder_screens.rs`), and what that would make of it off screen.
//!
//! **Commentary only: it decides nothing.** The window judges the Builders
//! no terminal shows (`src/lib/builderScreenState.ts`, phase 2), with the
//! card terminal's own matchers (`src/lib/attention.ts`) on the rows
//! `builder_session_screens` sends — one copy of the rules. This port stays
//! only to write the dev-only frame capture's `judged` / `off-screen` lines
//! (`builder_screens_capture.rs`), and its fixtures test is a drift alarm:
//! over the shared frames in `builder_screens_fixtures/` it must give each
//! frame's `expect`, as the window's test does
//! (`src/lib/builderScreenState.test.ts`). It differs from `attention.ts`
//! in small ways (REV-offscreen-p1 S5, and Codex's status line here wants
//! its own row shape, M2a); where the outcome would differ, the window is
//! right and this is the one to fix.
//!
//! [`content_rows`] is not commentary: the grid's content clock is cut with
//! it (`ScreenGrids::frame`), and the window reads that clock.
//!
//! Pure: rows in, verdict out. No PTY is touched.
// Every item but `content_rows` has a caller only in a test build with the
// capture compiled in (the tests read frame files; the capture names
// verdicts): elsewhere part of it is unread on purpose.
#![cfg_attr(not(all(test, feature = "test-bridge", debug_assertions)), allow(dead_code))]

/// The rows the card terminal's prompt scan judges (`BuilderSession`).
const TAIL_ROWS: usize = 20;
/// Codex's composer checks read this many settled rows (`codexComposerRows`).
const CODEX_ROWS: usize = 12;
/// `codexAwaitingDecision` reads this many.
const CODEX_DECISION_ROWS: usize = 14;

/// An idle or unknown screen counts as at work while its content changed
/// this recently (the window's `OFF_SCREEN_SETTLE_MS`).
pub(crate) const UNKNOWN_QUIET_MS: i64 = 10_000;
/// Review round 2, M2(b): a running turn whose screen content has not changed
/// for this long is a hung screen, not a turn (the window's
/// `OFF_SCREEN_HUNG_MS`): the byte rule of 1.176.2 decides it.
pub(crate) const RUNNING_STALE_MS: i64 = 5 * 60_000;
/// 1.176.2's rule: at work while it printed this recently (the window's
/// `OFF_SCREEN_WORKING_MS`).
pub(crate) const PRINTED_MS: i64 = 2 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// The CLI's own turn line is in view.
    Running,
    /// A question of the CLI's is in view (a decision, trust, Bypass, limit).
    Asking,
    /// Back at its prompt: no turn, no question.
    Idle,
    /// None of those (half drawn, an overlay, a screen no matcher knows).
    Unknown,
}

impl Verdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Verdict::Running => "running",
            Verdict::Asking => "asking",
            Verdict::Idle => "idle",
            Verdict::Unknown => "unknown",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Verdict> {
        match text.trim() {
            "running" => Some(Verdict::Running),
            "asking" => Some(Verdict::Asking),
            "idle" => Some(Verdict::Idle),
            "unknown" => Some(Verdict::Unknown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Judgement {
    pub verdict: Verdict,
    /// Which rule decided, and why the earlier ones did not (for the capture).
    pub reasons: Vec<String>,
}

/// What a session no terminal shows would count as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OffScreen {
    Working,
    Waiting,
    Nothing,
}

impl OffScreen {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OffScreen::Working => "working",
            OffScreen::Waiting => "waiting",
            OffScreen::Nothing => "nothing",
        }
    }
}

/// The verdict for `vendor`'s screen `rows` (top to bottom, each trimmed at
/// the end). Order: asking, running, idle, unknown.
pub(crate) fn judge(vendor: &str, rows: &[String]) -> Judgement {
    let mut reasons = Vec::new();
    let tail = settled(rows, TAIL_ROWS);
    if tail.is_empty() {
        reasons.push("nothing drawn".into());
        return Judgement { verdict: Verdict::Unknown, reasons };
    }
    // The trust question, Bypass warning and usage-limit menu, read from the
    // drawn text as a Terminals tile's are (`builder::screen_block`).
    let whole = settled(rows, rows.len()).join("\n");
    if let Some((kind, _)) = crate::builder::screen_block(&whole) {
        reasons.push(format!("asking: {kind:?} screen (builder::screen_block)"));
        return Judgement { verdict: Verdict::Asking, reasons };
    }
    let (asking, running, idle): (Option<String>, Option<String>, Result<String, String>) = match vendor {
        "claude" => (claude_decision(tail), claude_running(tail), claude_idle(tail)),
        "codex" => (codex_decision(tail), codex_running(tail), codex_idle(tail)),
        other => {
            reasons.push(format!("no rules for vendor {other:?}"));
            return Judgement { verdict: Verdict::Unknown, reasons };
        }
    };
    if let Some(why) = asking {
        reasons.push(format!("asking: {why}"));
        return Judgement { verdict: Verdict::Asking, reasons };
    }
    if let Some(why) = running {
        reasons.push(format!("running: {why}"));
        return Judgement { verdict: Verdict::Running, reasons };
    }
    match idle {
        Ok(why) => {
            reasons.push(format!("idle: {why}"));
            Judgement { verdict: Verdict::Idle, reasons }
        }
        Err(why) => {
            reasons.push("no question, no turn line".into());
            reasons.push(format!("not idle: {why}"));
            Judgement { verdict: Verdict::Unknown, reasons }
        }
    }
}

/// What a quit or the scheduled update would make of a session no terminal
/// shows — the window's rule (`offScreenQuitState`), mirrored for the
/// capture's commentary. `content_changed_at`: when the rows above its
/// composer last changed ([`content_rows`], kept per session by the grid);
/// `None` for a first reading, which counts as a change now.
/// `last_output_at`: the PTY's byte stamp. `turn_done`: the CLI's own
/// turn-done line is the last row with text above the composer
/// ([`turn_done_above_composer`], review p2 MF1).
pub(crate) fn off_screen_state(
    verdict: Verdict,
    exited: bool,
    content_changed_at: Option<i64>,
    last_output_at: Option<i64>,
    turn_done: bool,
    now: i64,
) -> (OffScreen, String) {
    if exited {
        return (OffScreen::Nothing, "its process ended".into());
    }
    let quiet = content_changed_at.map_or(0, |at| (now - at).max(0));
    let printed = last_output_at.map(|at| (now - at).max(0));
    let by_output = |said: String| match printed {
        Some(p) if p < PRINTED_MS => (OffScreen::Working, format!("{said}, but it printed {p} ms ago")),
        _ => (OffScreen::Nothing, format!("{said}, nothing printed for 2 minutes")),
    };
    match verdict {
        Verdict::Asking => (OffScreen::Waiting, "a question is in view".into()),
        Verdict::Running if quiet < RUNNING_STALE_MS => {
            (OffScreen::Working, format!("a turn is in view, its screen changed {quiet} ms ago"))
        }
        Verdict::Running => by_output(format!("a turn line frozen for {quiet} ms")),
        Verdict::Idle | Verdict::Unknown if quiet < UNKNOWN_QUIET_MS => (
            OffScreen::Working,
            format!("{} screen whose content changed {quiet} ms ago", verdict.as_str()),
        ),
        // Review p2 MF1: nothing only with the turn-done line, the screen
        // and the output both still for 10 s; else the 2-minute byte rule.
        Verdict::Idle if turn_done => match printed {
            Some(p) if p < UNKNOWN_QUIET_MS => (OffScreen::Working, format!("turn over, but it printed {p} ms ago")),
            _ => (OffScreen::Nothing, format!("turn over, nothing above the composer changed for {quiet} ms")),
        },
        Verdict::Idle => by_output(format!("at its prompt with no turn-done line, still for {quiet} ms")),
        Verdict::Unknown => by_output(format!("unknown screen, still for {quiet} ms")),
    }
}

/// Review p2 MF1: the last row with text above the composer
/// ([`content_rows`]) is the CLI's own turn-done line — Claude's `✻ Churned
/// for 9s · done 11:19 AM`, Codex's `Worked for 21s • 11:22`
/// (`attention.ts::turnDoneAboveComposer`).
pub(crate) fn turn_done_above_composer(vendor: &str, rows: &[String]) -> bool {
    let content = content_rows(vendor, rows);
    let Some(last) = content.iter().rev().find(|r| !r.trim().is_empty()) else {
        return false;
    };
    match vendor {
        "claude" => claude_turn_done(last),
        "codex" => codex_worked_for(last),
        _ => false,
    }
}

/// `^\s*(?:─\s*)?Worked for (\d+h\s*)?(\d+m\s*)?\d+s\b`.
fn codex_worked_for(row: &str) -> bool {
    let t = row.trim_start();
    let t = t.strip_prefix('─').map_or(t, str::trim_start);
    let Some(rest) = t.strip_prefix("Worked for ") else {
        return false;
    };
    for token in rest.split_whitespace() {
        let digits = token.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        let mut unit = token[digits..].chars();
        match unit.next() {
            Some('s') => return unit.next().is_none_or(|c| !is_word_char(c)),
            Some('h' | 'm') if unit.next().is_none() => continue,
            _ => return false,
        }
    }
    false
}

/// Review round 2, M3: the rows whose change is work — everything above the
/// composer. Codex's animated composer and its footer, and Claude's input box
/// with its prompt suggestion and footer, are cut off. The whole screen when
/// no composer is in view.
pub(crate) fn content_rows<'a>(vendor: &str, rows: &'a [String]) -> &'a [String] {
    let end = match vendor {
        // Review p1 MF1: Codex 0.154's starfield also animates the rows just
        // above its chevron; those rows (glyphs and blanks only) go with it.
        "codex" => rows.iter().rposition(|r| codex_composer_line(r) && !codex_choice_line(r)).map(|mut at| {
            while at > 0 && rows[at - 1].chars().all(|c| c.is_whitespace() || "·.•*+˙".contains(c)) {
                at -= 1;
            }
            at
        }),
        "claude" => rows
            .iter()
            .rposition(|r| claude_input_line(r) && !claude_choice_line(r))
            .map(|at| if at > 0 && claude_box_rule(&rows[at - 1]) { at - 1 } else { at }),
        _ => None,
    };
    &rows[..end.unwrap_or(rows.len())]
}

// --- shared helpers -----------------------------------------------------

/// `settledTail`: trailing blank rows dropped, then the last `n`.
fn settled(rows: &[String], n: usize) -> &[String] {
    let mut end = rows.len();
    while end > 0 && rows[end - 1].trim().is_empty() {
        end -= 1;
    }
    &rows[end.saturating_sub(n)..end]
}

/// The row without its leading blanks and box borders (`^[\s│|]*`).
fn unframed(row: &str) -> &str {
    row.trim_start_matches(|c: char| c.is_whitespace() || c == '│' || c == '|')
}

fn lower(row: &str) -> String {
    row.to_lowercase()
}

/// Whitespace runs as one space, lower case (for `\s+` in a phrase).
fn squeezed(row: &str) -> String {
    lower(&row.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn is_rule_char(c: char) -> bool {
    c == '─' || c == '━'
}

fn leading_rules(s: &str) -> usize {
    s.chars().take_while(|c| is_rule_char(*c)).count()
}

/// A corner from `corners` and two rules, or eight flat rules, at the row's start.
fn rule_start(row: &str, corners: &[char]) -> bool {
    let t = row.trim_start();
    match t.chars().next() {
        Some(c) if corners.contains(&c) => leading_rules(&t[c.len_utf8()..]) >= 2,
        Some(c) if is_rule_char(c) => leading_rules(t) >= 8,
        _ => false,
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `\d+\.\s` at the start of `s`.
fn numbered_choice(s: &str) -> bool {
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && {
        let rest = &s[digits..];
        rest.starts_with('.') && rest[1..].chars().next().is_some_and(char::is_whitespace)
    }
}

fn short(row: &str) -> String {
    let t = row.trim();
    if t.chars().count() <= 80 {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(80).collect::<String>())
    }
}

// --- Claude Code ----------------------------------------------------------

/// `CLAUDE_INPUT_LINE` (`^[\s│|]*[>❯]\s`) or the bare chevron of an empty box.
fn claude_input_line(row: &str) -> bool {
    let u = unframed(row);
    let mut chars = u.chars();
    match chars.next() {
        Some('>' | '❯') => chars.next().is_none_or(char::is_whitespace),
        _ => false,
    }
}

/// `^[\s│|]*[❯>]\s*\d+\.\s`: a marked numbered choice.
fn claude_choice_line(row: &str) -> bool {
    let u = unframed(row);
    match u.chars().next() {
        Some(c @ ('>' | '❯')) => numbered_choice(u[c.len_utf8()..].trim_start()),
        _ => false,
    }
}

/// `CLAUDE_BOX_RULE`: the input box's top (flat, or a rounded box's top).
fn claude_box_rule(row: &str) -> bool {
    rule_start(row, &['╭', '┌'])
}

fn claude_any_box_rule(row: &str) -> bool {
    rule_start(row, &['╭', '╰', '┌', '└'])
}

fn claude_box_bottom(row: &str) -> bool {
    rule_start(row, &['╰', '└'])
}

const CLAUDE_RUNNING_WORDS: &[&str] = &["esc to interrupt", "press up to edit queued messages", "ctrl+b to run in background"];

/// `CLAUDE_TOOL_RUNNING`: `⎿ Running…`.
fn claude_tool_running(row: &str) -> bool {
    row.find('⎿').is_some_and(|at| row[at + '⎿'.len_utf8()..].trim_start().starts_with("Running…"))
}

/// The spinner line up to its ellipsis (`✻ Processing…`): a glyph that is no
/// word character, no bracket, quote or chevron; blanks; a capitalised word
/// and up to three more; `…`. Returns what follows the ellipsis.
fn claude_spinner_rest(row: &str) -> Option<&str> {
    let t = row.trim_start();
    let glyph = t.chars().next()?;
    if glyph.is_whitespace() || glyph.is_ascii_alphanumeric() || glyph == '_' || "(){}[]<>❯›\"'`|│".contains(glyph) {
        return None;
    }
    let rest = &t[glyph.len_utf8()..];
    let words = rest.trim_start();
    if words.len() == rest.len() {
        return None;
    }
    let word_char = |c: char| c.is_alphabetic() || c == '\'' || c == '’' || c == '-';
    let mut chars = words.char_indices().peekable();
    match chars.next() {
        Some((_, c)) if c.is_ascii_uppercase() => {}
        _ => return None,
    }
    let mut extra = 0;
    loop {
        match chars.peek().copied() {
            Some((_, c)) if word_char(c) => {
                chars.next();
            }
            Some((at, ' ')) if extra < 3 && words[at + 1..].chars().next().is_some_and(word_char) => {
                extra += 1;
                chars.next();
            }
            Some((at, '…')) => return Some(&words[at + '…'.len_utf8()..]),
            _ => return None,
        }
    }
}

/// `CLAUDE_SPINNER`: the spinner line, the ellipsis followed by a blank or the end.
fn claude_spinner(row: &str) -> bool {
    claude_spinner_rest(row).is_some_and(|rest| rest.chars().next().is_none_or(char::is_whitespace))
}

/// `CLAUDE_SPINNER_TIMER`: the spinner with its elapsed timer, `… (1m 26s`.
fn claude_spinner_timer(row: &str) -> bool {
    let Some(rest) = claude_spinner_rest(row) else { return false };
    let Some(mut s) = rest.trim_start().strip_prefix('(') else { return false };
    loop {
        let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return false;
        }
        let unit = s[digits..].chars().next();
        match unit {
            Some('s') => return s[digits + 1..].chars().next().is_none_or(|c| !is_word_char(c)),
            Some('h' | 'm') => s = s[digits + 1..].trim_start(),
            _ => return false,
        }
    }
}

/// `CLAUDE_TURN_DONE`: `✻ Worked for 55s · done 2:55 PM`.
fn claude_turn_done(row: &str) -> bool {
    let l = lower(row);
    let mut from = 0;
    while let Some(found) = l[from..].find("for ") {
        let at = from + found;
        let bounded = l[..at].chars().next_back().is_none_or(|c| !is_word_char(c));
        let digit = l[at + 4..].chars().next().is_some_and(|c| c.is_ascii_digit());
        if bounded && digit {
            let after = &l[at + 4..];
            for (dot, _) in after.match_indices('·') {
                let next = after[dot + '·'.len_utf8()..].trim_start();
                if next.strip_prefix("done").is_some_and(|r| r.chars().next().is_none_or(|c| !is_word_char(c))) {
                    return true;
                }
            }
        }
        from = at + 4;
    }
    false
}

/// `CLAUDE_STATUS_SHAPED`: a glyph, words, and a parenthesised group with the
/// running words, the row ending there.
fn claude_status_shaped(row: &str) -> bool {
    let t = row.trim();
    let Some(glyph) = t.chars().next() else { return false };
    if glyph.is_alphanumeric() || glyph.is_whitespace() || "⏺●>❯".contains(glyph) {
        return false;
    }
    let rest = t[glyph.len_utf8()..].trim_start();
    if !rest.chars().next().is_some_and(char::is_alphabetic) {
        return false;
    }
    let Some(open) = rest.find('(') else { return false };
    if rest[..open].contains(')') || !rest.ends_with(')') {
        return false;
    }
    let inner = &rest[open + 1..rest.len() - 1];
    if inner.contains('(') || inner.contains(')') {
        return false;
    }
    let inner = lower(inner);
    inner.contains("esc to interrupt") || inner.contains("ctrl+b to run in background")
}

/// `claudeTurnRunning`.
fn claude_running(rows: &[String]) -> Option<String> {
    let rows = settled(rows, TAIL_ROWS);
    let bare = |r: &str| matches!(unframed(r), ">" | "❯");
    let box_row = rows.iter().rposition(|r| claude_input_line(r) || bare(r));
    let top = box_row.map(|b| if b > 0 && claude_box_rule(&rows[b - 1]) { b - 1 } else { b });
    if let Some(top) = top.filter(|t| *t > 0) {
        if let Some(above) = rows[..top].iter().rposition(|r| !r.trim().is_empty()) {
            let row = &rows[above];
            if claude_tool_running(row) || claude_spinner(row) {
                return Some(format!("the row above the input box is a running tool or the spinner: {:?}", short(row)));
            }
        }
    }
    let done = rows.iter().rposition(|r| claude_turn_done(r));
    let end = top.unwrap_or(rows.len());
    let spinner_from = done.map_or(0, |d| d + 1);
    if let Some(i) = (spinner_from..end).rev().find(|i| claude_spinner_timer(&rows[*i])) {
        if rows[i + 1..end].iter().all(|r| r.trim().is_empty() || r.starts_with(char::is_whitespace)) {
            return Some(format!("the spinner with its timer after the last finished turn: {:?}", short(&rows[i])));
        }
    }
    if let Some(b) = box_row {
        if let Some(close) = (b + 1..rows.len()).find(|i| claude_box_rule(&rows[*i])) {
            let below = lower(&rows[close + 1..].join("\n"));
            if let Some(word) = CLAUDE_RUNNING_WORDS.iter().find(|w| below.contains(*w)) {
                return Some(format!("{word:?} in the footer below the input box"));
            }
        }
    }
    let from = done.map_or(end.saturating_sub(3), |d| d + 1);
    rows[from.min(end)..end]
        .iter()
        .find(|r| claude_status_shaped(r) || lower(unframed(r)).starts_with("press up to edit queued messages"))
        .map(|r| format!("a status row above the box: {:?}", short(r)))
}

/// `CLAUDE_SLASH_MENU_ROW`: `  ❯ /ply:release-notes   (ply) Writes…`.
fn claude_slash_menu_row(row: &str) -> bool {
    if !row.starts_with(char::is_whitespace) {
        return false;
    }
    let mut s = row.trim_start();
    if let Some(after) = s.strip_prefix('❯') {
        if !after.starts_with(char::is_whitespace) {
            return false;
        }
        s = after.trim_start();
    }
    let Some(name) = s.strip_prefix('/') else { return false };
    let len = name.chars().take_while(|c| c.is_alphanumeric() || "_:.@-".contains(*c)).count();
    if len == 0 {
        return false;
    }
    let rest: &str = &name[name.char_indices().nth(len).map_or(name.len(), |(i, _)| i)..];
    if rest.is_empty() {
        return true;
    }
    let blanks = rest.chars().take_while(|c| c.is_whitespace()).count();
    blanks >= 2 && rest.trim_start().chars().next().is_some()
}

/// `claudeDraftEscape` == true: the draft in the box starts with `!` or `/`.
fn claude_escaped(rows: &[String]) -> bool {
    let Some(bottom) = rows.iter().rposition(|r| claude_any_box_rule(r)) else {
        return rows.iter().filter(|r| claude_slash_menu_row(r)).count() >= 3;
    };
    let top = rows[..bottom].iter().rposition(|r| claude_any_box_rule(r));
    let Some(top) = top.filter(|t| t + 1 < bottom) else {
        return rows.iter().filter(|r| claude_slash_menu_row(r)).count() >= 3;
    };
    let first = unframed(&rows[top + 1]);
    let escaped = first
        .strip_prefix(['>', '❯'])
        .is_some_and(|r| r.starts_with(char::is_whitespace) && r.trim_start().starts_with(['!', '/']))
        || first.starts_with('!');
    escaped || rows[bottom + 1..].iter().any(|r| claude_slash_menu_row(r))
}

/// `matchesClaudePromptBox`: a rule and the input line, or the idle hint.
fn claude_prompt_box(rows: &[String]) -> bool {
    let corner_rule = |r: &str| {
        r.char_indices()
            .any(|(at, c)| "╭╰┌└".contains(c) && leading_rules(&r[at + c.len_utf8()..]) >= 2)
    };
    let flat_rule = |r: &str| {
        let t = r.trim_matches([' ', '\t']);
        t.chars().count() >= 8 && t.chars().all(is_rule_char)
    };
    let rule = rows.iter().any(|r| corner_rule(r) || flat_rule(r));
    let input = rows.iter().any(|r| {
        let u = unframed(r);
        u.strip_prefix(['>', '❯']).is_some_and(|rest| rest.starts_with(char::is_whitespace))
    });
    let hint = rows.iter().any(|r| {
        let s = squeezed(r);
        s.contains("? for shortcuts") || s.contains("shift+tab to cycle")
    });
    (rule && input) || hint
}

/// `CLAUDE_NOT_AT_PROMPT`.
fn claude_not_at_prompt(rows: &[String]) -> Option<String> {
    for row in rows {
        let l = lower(row);
        if let Some(w) = ["esc to interrupt", "do you want to", "would you like to", "esc to cancel"]
            .iter()
            .find(|w| l.contains(*w))
        {
            return Some(format!("{w:?} in view"));
        }
        if claude_choice_line(row) {
            return Some(format!("a numbered choice: {:?}", short(row)));
        }
    }
    None
}

/// `matchesClaudeTurnIdle`.
fn claude_idle(rows: &[String]) -> Result<String, String> {
    if !claude_prompt_box(rows) {
        return Err("no Claude input box (a rule and the chevron, or the idle hint)".into());
    }
    if let Some(why) = claude_running(rows) {
        return Err(why);
    }
    if claude_escaped(rows) {
        return Err("the draft starts with ! or /".into());
    }
    if let Some(why) = claude_not_at_prompt(settled(rows, TAIL_ROWS)) {
        return Err(why);
    }
    Ok("the input box in view, no turn line and no question".into())
}

/// `claudeAwaitingDecision`.
fn claude_decision(rows: &[String]) -> Option<String> {
    let rows = settled(rows, TAIL_ROWS);
    let chevron = rows.iter().rposition(|r| unframed(r).starts_with('❯'))?;
    if !claude_choice_line(&rows[chevron]) {
        return None;
    }
    let below = &rows[chevron + 1..];
    if below.iter().any(|r| lower(r).contains("enter to select")) {
        return Some(format!("Claude's picker, marked choice {:?}", short(&rows[chevron])));
    }
    // 1.177.0 walk round 4 (`claudeMenuFooterBelow`): a numbered menu closed
    // by its own footer (`Esc to cancel · Tab to amend`) before any box rule
    // asks, whatever rule sits under it — Claude 2.1.332 draws the session's
    // name as a rule on the screen's last row.
    let footer_first = below
        .iter()
        .find(|r| lower(r).trim_start().starts_with("esc to cancel") || claude_box_bottom(r))
        .is_some_and(|r| lower(r).trim_start().starts_with("esc to cancel"));
    let sibling = (chevron.saturating_sub(3)..=(chevron + 3).min(rows.len() - 1))
        .any(|i| i != chevron && numbered_choice(unframed(&rows[i]).trim_start_matches(['›', '❯']).trim_start()));
    if footer_first && sibling {
        return Some(format!("Claude's menu closed by its footer, marked choice {:?}", short(&rows[chevron])));
    }
    if below.iter().any(|r| claude_box_bottom(r)) {
        return None;
    }
    rows[..chevron]
        .iter()
        .find(|r| {
            let l = lower(r);
            l.contains("do you want to") || l.contains("would you like to")
        })
        .map(|q| format!("a permission question {:?} over {:?}", short(q), short(&rows[chevron])))
}

// --- Codex ------------------------------------------------------------------

/// `CODEX_COMPOSER_LINE`: `^[\s│|]*›`.
fn codex_composer_line(row: &str) -> bool {
    unframed(row).starts_with('›')
}

/// `CODEX_CHOICE_LINE`: `^[\s│|]*›\s+\d+\.\s`.
fn codex_choice_line(row: &str) -> bool {
    unframed(row).strip_prefix('›').is_some_and(|r| r.starts_with(char::is_whitespace) && numbered_choice(r.trim_start()))
}

/// `CODEX_NOT_AT_COMPOSER`.
const CODEX_NOT_AT_COMPOSER: &[&str] =
    &["esc to interrupt", "press enter to confirm", "press enter to continue", "esc to cancel", "would you like to"];

/// Review round 2, M2(a): Codex's turn status line, on a row of its own:
/// an optional bullet, a label (`Working`), then `(<n>s|m|h … esc to
/// interrupt)` closing the row. A diff line, a quoted phrase or prose that
/// goes on after the parenthesis is not it.
fn codex_status_line(row: &str) -> bool {
    let mut s = row.trim();
    if let Some(c) = s.chars().next().filter(|c| "•◦·*".contains(*c)) {
        s = s[c.len_utf8()..].trim_start();
    }
    if !s.chars().next().is_some_and(char::is_alphabetic) {
        return false;
    }
    let label = s
        .char_indices()
        .find(|(_, c)| !(c.is_alphanumeric() || " '’.,:-".contains(*c)))
        .map_or(s.len(), |(i, _)| i);
    let Some(group) = s[label..].strip_prefix('(') else { return false };
    let digits = group.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || !group[digits..].starts_with(['h', 'm', 's']) {
        return false;
    }
    let Some(close) = group.find(')') else { return false };
    group[close + 1..].trim().is_empty() && lower(&group[..close]).contains("esc to interrupt")
}

/// Codex's running turn (`turnRunningMatcherFor("codex")`, tightened by M2(a)).
fn codex_running(rows: &[String]) -> Option<String> {
    settled(rows, CODEX_ROWS)
        .iter()
        .find(|r| codex_status_line(r))
        .map(|r| format!("Codex's status line: {:?}", short(r)))
}

/// `matchesCodexTurnIdle` (`matchesCodexComposerIdle` and no `!`/`/` draft).
fn codex_idle(rows: &[String]) -> Result<String, String> {
    let rows = settled(rows, CODEX_ROWS);
    for row in rows {
        let l = lower(row);
        if let Some(w) = CODEX_NOT_AT_COMPOSER.iter().find(|w| l.contains(*w)) {
            return Err(format!("{w:?} in the last {CODEX_ROWS} rows: {:?}", short(row)));
        }
    }
    let Some(chevron) = rows.iter().rposition(|r| codex_composer_line(r)) else {
        return Err("no composer line (›) in the last rows".into());
    };
    if codex_choice_line(&rows[chevron]) {
        return Err(format!("the last › row is a numbered choice: {:?}", short(&rows[chevron])));
    }
    if rows.len() - chevron > 8 {
        return Err(format!("the composer is {} rows from the bottom", rows.len() - chevron));
    }
    if unframed(&rows[chevron])['›'.len_utf8()..].trim_start().starts_with(['!', '/']) {
        return Err("the draft starts with ! or /".into());
    }
    Ok(format!("the composer is the last › row, {} rows from the bottom", rows.len() - chevron))
}

/// `codexAwaitingDecision`.
fn codex_decision(rows: &[String]) -> Option<String> {
    let rows = settled(rows, CODEX_DECISION_ROWS);
    if rows.iter().any(|r| lower(r).contains("esc to interrupt")) {
        return None;
    }
    let chevron = rows.iter().rposition(|r| codex_composer_line(r))?;
    if !codex_choice_line(&rows[chevron]) {
        return None;
    }
    let footer = rows[chevron + 1..].iter().any(|r| {
        let l = lower(r);
        l.contains("press enter to confirm") || l.contains("esc to cancel")
    });
    let words = rows.iter().find(|r| {
        let l = lower(r);
        l.contains("would you like to") || l.contains("press enter to confirm")
    });
    match (footer, words) {
        (true, Some(q)) => Some(format!("Codex's approval {:?} over {:?}", short(q), short(&rows[chevron]))),
        _ => None,
    }
}

// --- frame files (the capture writes them, the fixtures test reads them) ---

/// The first line of a frame file.
pub(crate) const FRAME_MAGIC: &str = "# plyloft builder screen frame v1";
/// Ends the header; every line after it is a screen row, verbatim.
pub(crate) const FRAME_ROWS: &str = "# ----";

/// A frame file read back: its header fields in order, and its rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrameFile {
    pub header: Vec<(String, String)>,
    pub rows: Vec<String>,
}

impl FrameFile {
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        self.header.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// A frame file: the magic line, `# key: value` lines, [`FRAME_ROWS`], then
/// the rows. Values are kept on one line.
pub(crate) fn render_frame_file(header: &[(&str, String)], rows: &[String]) -> String {
    let mut out = String::from(FRAME_MAGIC);
    out.push('\n');
    for (key, value) in header {
        out.push_str(&format!("# {key}: {}\n", value.replace(['\n', '\r'], " ")));
    }
    out.push_str(FRAME_ROWS);
    out.push('\n');
    for row in rows {
        out.push_str(row);
        out.push('\n');
    }
    out
}

pub(crate) fn parse_frame_file(text: &str) -> Result<FrameFile, String> {
    let text = text.replace("\r\n", "\n");
    let mut lines = text.split('\n');
    if lines.next().map(str::trim_end) != Some(FRAME_MAGIC) {
        return Err(format!("the first line is not {FRAME_MAGIC:?}"));
    }
    let mut header = Vec::new();
    loop {
        let line = lines.next().ok_or_else(|| format!("no {FRAME_ROWS:?} line"))?;
        if line.trim_end() == FRAME_ROWS {
            break;
        }
        let field = line.strip_prefix("# ").ok_or_else(|| format!("a header line without \"# \": {line:?}"))?;
        let (key, value) = field.split_once(':').ok_or_else(|| format!("a header line without \"key: value\": {line:?}"))?;
        header.push((key.trim().to_string(), value.trim().to_string()));
    }
    let mut rows: Vec<String> = lines.map(|l| l.trim_end().to_string()).collect();
    if rows.last().is_some_and(String::is_empty) {
        rows.pop();
    }
    Ok(FrameFile { header, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(text: &str) -> Vec<String> {
        text.split('\n').map(|r| r.trim_end().to_string()).collect()
    }

    const RULE: &str = "────────────────────────────────────────────────────────────";

    /// `attention.test.ts` R3_TOOL_RUNNING (Claude 2.1, walk H1).
    fn claude_tool_running() -> Vec<String> {
        rows(&[
            "● Bash(node -e \"setTimeout(()=>console.log('ok'),50000)\")",
            "  ⎿  Running… (6s · timeout 1m 30s)",
            "",
            RULE,
            "❯",
            RULE,
            "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
        ]
        .join("\n"))
    }

    /// `attention.test.ts` R3_TURN_OVER.
    fn claude_turn_over() -> Vec<String> {
        rows(&[
            "● ok",
            "",
            "✻ Worked for 55s · done 2:55 PM",
            "",
            RULE,
            "❯",
            RULE,
            "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
        ]
        .join("\n"))
    }

    const CODEX_FOOTER: &str = "  gpt-6-astra default · ~/code/atelier";

    fn codex_working() -> Vec<String> {
        rows(&["› count slowly from 1 to 40", "", "• Working (2s • esc to interrupt)", "", "", "› Ask Codex to do anything", "", CODEX_FOOTER].join("\n"))
    }

    fn codex_starfield() -> Vec<String> {
        rows(&["  ·      .         ·     .            ·", "›·    .        ·        .     ·", "", CODEX_FOOTER, "", "", ""].join("\n"))
    }

    #[test]
    fn claude_screens_read_as_the_card_terminal_reads_them() {
        let j = judge("claude", &claude_tool_running());
        assert_eq!(j.verdict, Verdict::Running, "{:?}", j.reasons);
        let j = judge("claude", &claude_turn_over());
        assert_eq!(j.verdict, Verdict::Idle, "{:?}", j.reasons);
        let spinner = rows(&["● Reading the diff", "", "✢ Honking… (3s)", "", RULE, "❯", RULE].join("\n"));
        assert_eq!(judge("claude", &spinner).verdict, Verdict::Running);
        let question = rows(
            &[
                "● Bash(rm -rf build)",
                "",
                " Do you want to proceed?",
                " ❯ 1. Yes",
                "   2. No, and tell Claude what to do differently (esc)",
            ]
            .join("\n"),
        );
        assert_eq!(judge("claude", &question).verdict, Verdict::Asking);
        // A diff quoting the busy words above a finished turn is not a turn.
        let diff = rows(
            &[
                "● Update(src/lib/attention.ts)",
                "      125 +  /esc to interrupt|press up to edit queued messages/i;",
                "",
                "✻ Worked for 12s · done 3:10 PM",
                "",
                RULE,
                "❯",
                RULE,
                "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
            ]
            .join("\n"),
        );
        // The strict turn-idle gate (`matchesClaudeTurnIdle`) still refuses
        // idle while the words are in view: unknown, which the content clock
        // (M3) then lets go of.
        assert_eq!(judge("claude", &diff).verdict, Verdict::Unknown, "{:?}", judge("claude", &diff).reasons);
    }

    #[test]
    fn codex_screens_read_as_the_card_terminal_reads_them() {
        assert_eq!(judge("codex", &codex_working()).verdict, Verdict::Running);
        assert_eq!(judge("codex", &codex_starfield()).verdict, Verdict::Idle);
        let approval = rows(
            &[
                "• Running touch /tmp/ply-probe.txt",
                "",
                "  Would you like to run the following command?",
                "",
                "  $ touch /tmp/ply-probe.txt",
                "",
                "› 1. Yes, proceed (y)",
                "  2. No, and tell Codex what to do differently (esc)",
                "",
                "  Press enter to confirm or esc to cancel",
            ]
            .join("\n"),
        );
        assert_eq!(judge("codex", &approval).verdict, Verdict::Asking);
        let trust = rows(
            &[
                "> You are in /tmp/sandbox",
                "",
                "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
                "",
                "› 1. Yes, continue",
                "  2. No, quit",
                "",
                "  Press enter to continue",
            ]
            .join("\n"),
        );
        let j = judge("codex", &trust);
        assert_eq!(j.verdict, Verdict::Asking, "{:?}", j.reasons);
        assert_eq!(judge("codex", &[]).verdict, Verdict::Unknown);
        assert_eq!(judge("shell", &codex_working()).verdict, Verdict::Unknown);
    }

    /// Review round 2, M2(a): a finished Codex turn whose answer quotes "esc
    /// to interrupt" above the composer is not a running turn.
    #[test]
    fn a_finished_codex_answer_quoting_the_status_words_is_not_a_turn() {
        let quoted = rows(
            &[
                "• Updated attention.ts: the matcher now reads `esc to interrupt` only on Codex's status line.",
                "  - Working (2s • esc to interrupt) is quoted here, then more prose follows.",
                "      703 +    return (tail) => /esc to interrupt/i.test(tail);",
                "",
                "› Ask Codex to do anything",
                "",
                CODEX_FOOTER,
            ]
            .join("\n"),
        );
        let j = judge("codex", &quoted);
        assert_ne!(j.verdict, Verdict::Running, "{:?}", j.reasons);
        // A status line of another label or a longer timer still is one.
        assert!(codex_status_line("• Running tests (1m 23s • esc to interrupt)"));
        assert!(codex_status_line("  Working (12s • Esc to interrupt)"));
        assert!(!codex_status_line("+ \"• Working (2s • esc to interrupt)\","));
        assert!(!codex_status_line("• Working (2s • esc to interrupt) is what it draws"));
        assert!(!codex_status_line("• Working (esc to interrupt)"));
    }

    /// Review round 2, M2(b): a turn line frozen on screen for five minutes is
    /// a hung screen, not a turn: 1.176.2's byte rule decides it (at work
    /// while it printed in the last 2 minutes). One whose content still
    /// moves is a turn.
    #[test]
    fn a_running_screen_that_stopped_changing_lets_go() {
        let now = 1_000_000_000;
        assert_eq!(off_screen_state(Verdict::Running, false, Some(now - 1_000), None, false, now).0, OffScreen::Working);
        assert_eq!(off_screen_state(Verdict::Running, false, Some(now - RUNNING_STALE_MS + 1), None, false, now).0, OffScreen::Working);
        assert_eq!(off_screen_state(Verdict::Running, false, Some(now - RUNNING_STALE_MS), None, false, now).0, OffScreen::Nothing);
        let frozen = Some(now - RUNNING_STALE_MS);
        assert_eq!(off_screen_state(Verdict::Running, false, frozen, Some(now - 1_000), false, now).0, OffScreen::Working);
        assert_eq!(off_screen_state(Verdict::Running, false, frozen, Some(now - PRINTED_MS), false, now).0, OffScreen::Nothing);
    }

    /// Review round 2, M3: an unknown screen counts as work only while the
    /// rows above its composer change; Codex's composer animating under an
    /// unchanged answer is no work, however fresh its byte stamp.
    #[test]
    fn an_unknown_screen_is_work_only_while_its_content_changes() {
        let frame = |stars: &str| {
            rows(&[
                "• Done. Would you like to see the diff as well?",
                "",
                stars,
                "",
                CODEX_FOOTER,
            ]
            .join("\n"))
        };
        let a = frame("›·    .        ·        .     ·");
        let b = frame("› .     ·     .           ·");
        assert_eq!(judge("codex", &a).verdict, Verdict::Unknown, "{:?}", judge("codex", &a).reasons);
        assert_eq!(content_rows("codex", &a), content_rows("codex", &b), "the animation is below the content");
        let now = 2_000_000_000;
        assert_eq!(off_screen_state(Verdict::Unknown, false, Some(now - 30_000), None, false, now).0, OffScreen::Nothing);
        assert_eq!(off_screen_state(Verdict::Unknown, false, Some(now - 2_000), None, false, now).0, OffScreen::Working);
        // A first reading counts as a change now.
        assert_eq!(off_screen_state(Verdict::Unknown, false, None, None, false, now).0, OffScreen::Working);
        // Claude: the input box and its footer are cut off too.
        let over = claude_turn_over();
        assert_eq!(content_rows("claude", &over), &over[..4]);
    }

    /// Review p1 MF1: Codex 0.154's real animated composer (`attention.test.ts`
    /// CODEX_STARFIELD / CODEX_STARFIELD_SPACED, recorded on the owner's
    /// MacBook) draws glyphs on the row above the chevron too: those rows are
    /// the composer's, not content.
    #[test]
    fn codex_starfield_rows_above_the_chevron_are_not_content() {
        let header = [
            "",
            "╭───────────────────────────────────────────╮",
            "│ >_ OpenAI Codex (v0.154.0)                │",
            "│                                           │",
            "│ model:     gpt-6-astra   /model to change │",
            "│ directory: ~/code/atelier                 │",
            "╰───────────────────────────────────────────╯",
            "",
            "  Tip: Try the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex",
            "",
        ];
        let frame = |stars: &str, chevron: &str| {
            let mut out: Vec<String> = header.iter().map(|r| r.to_string()).collect();
            out.extend([stars, chevron, "", CODEX_FOOTER].iter().map(|r| r.to_string()));
            out.extend(std::iter::repeat_n(String::new(), 20));
            out
        };
        let a = frame("  ·      .         ·     .            ·", "›·    .        ·        .     ·");
        let b = frame("     .    ·           .        ·", "› .     ·     .           ·");
        assert_eq!(content_rows("codex", &a), content_rows("codex", &b));
        // The header (real content) stays.
        assert!(content_rows("codex", &a).iter().any(|r| r.contains("OpenAI Codex")));
    }

    /// Review p2 MF1: the turn-done line, last above the composer.
    #[test]
    fn the_turn_done_line_is_read_last_above_the_composer() {
        assert!(turn_done_above_composer("claude", &claude_turn_over()));
        assert!(!turn_done_above_composer("claude", &claude_tool_running()));
        let codex = |above: &str| rows(&["• f5.txt has 15 lines.", "", above, "", "› Ask Codex to do anything", "", CODEX_FOOTER].join("\n"));
        assert!(turn_done_above_composer("codex", &codex("  Worked for 21s • 11:22")));
        assert!(turn_done_above_composer("codex", &codex("─ Worked for 1m 05s ─────")));
        assert!(!turn_done_above_composer("codex", &codex("• I'll now rewrite the matcher.")));
        assert!(!turn_done_above_composer("codex", &codex("  Worked for many hours")));
        assert!(!turn_done_above_composer("codex", &codex_starfield()));
    }

    #[test]
    fn asking_waits_idle_and_ended_are_nothing() {
        let now = 5_000;
        assert_eq!(off_screen_state(Verdict::Asking, false, Some(0), None, false, now).0, OffScreen::Waiting);
        // At its prompt: nothing once nothing above it changed for 10 s
        // (Codex 0.171 streams an answer with no status line: an idle shape
        // mid-turn, its content moving).
        // Review p2 MF1: with its turn-done line, and nothing printed for
        // 10 s either; without it, the 2-minute byte rule.
        let still = Some(now - UNKNOWN_QUIET_MS);
        assert_eq!(off_screen_state(Verdict::Idle, false, still, still, true, now).0, OffScreen::Nothing);
        assert_eq!(off_screen_state(Verdict::Idle, false, still, Some(now - 1), true, now).0, OffScreen::Working);
        assert_eq!(off_screen_state(Verdict::Idle, false, still, still, false, now).0, OffScreen::Working);
        assert_eq!(off_screen_state(Verdict::Idle, false, still, Some(now - PRINTED_MS), false, now).0, OffScreen::Nothing);
        assert_eq!(off_screen_state(Verdict::Idle, false, Some(now), Some(now), true, now).0, OffScreen::Working);
        assert_eq!(off_screen_state(Verdict::Running, true, Some(now), None, false, now).0, OffScreen::Nothing);
    }

    #[test]
    fn a_frame_file_reads_back_as_written() {
        let rows = vec!["# not a header".to_string(), String::new(), "› x".to_string()];
        let text = render_frame_file(&[("vendor", "codex".into()), ("expect", "?".into()), ("reasons", "a\nb".into())], &rows);
        let back = parse_frame_file(&text).unwrap();
        assert_eq!(back.rows, rows);
        assert_eq!(back.get("vendor"), Some("codex"));
        assert_eq!(back.get("reasons"), Some("a b"));
        assert!(parse_frame_file("no magic\n").is_err());
        assert!(parse_frame_file(&format!("{FRAME_MAGIC}\n# vendor: codex\n")).is_err());
    }

    /// The drift alarm (module docs): every frame under
    /// `builder_screens_fixtures/` — the real captures of the 1.176.3 walks
    /// and the synthetic ones ported from the TS tests — comes out of this
    /// commentary as its `expect` says, as it does in the window
    /// (`src/lib/builderScreenState.test.ts` reads the same files). The
    /// clocks are the frame's own (`last-output-ago-ms`,
    /// `content-changed-ago-ms`). A capture dropped in unedited (`expect: ?`)
    /// fails until somebody writes the truth the walk recorded.
    #[test]
    fn every_captured_frame_reads_as_its_header_says() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/builder_screens_fixtures");
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "txt"))
            .collect();
        files.sort();
        assert!(!files.is_empty(), "no frame files in {}", dir.display());
        let now: i64 = 10_000_000_000;
        let mut wrong = Vec::new();
        for path in &files {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let frame = parse_frame_file(&std::fs::read_to_string(path).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let field = |key: &str| frame.get(key).unwrap_or_else(|| panic!("{name}: no {key}"));
            let expect = field("expect");
            let expect = [OffScreen::Working, OffScreen::Waiting, OffScreen::Nothing]
                .into_iter()
                .find(|o| o.as_str() == expect)
                .unwrap_or_else(|| panic!("{name}: expect is {expect:?}; write working, waiting or nothing (what the walk saw)"));
            let ago = |key: &str| -> Option<i64> {
                let v = field(key);
                (v != "never").then(|| now - v.parse::<i64>().unwrap_or_else(|_| panic!("{name}: {key} is {v:?}")))
            };
            let got = judge(field("vendor"), &frame.rows);
            let (state, why) = off_screen_state(
                got.verdict,
                field("exited") == "true",
                ago("content-changed-ago-ms"),
                ago("last-output-ago-ms"),
                turn_done_above_composer(field("vendor"), &frame.rows),
                now,
            );
            if state != expect {
                wrong.push(format!(
                    "{name}: expected {}, the commentary says {} ({}; {})",
                    expect.as_str(),
                    state.as_str(),
                    why,
                    got.reasons.join("; ")
                ));
            }
        }
        assert!(wrong.is_empty(), "{} of {} frames misread:\n{}", wrong.len(), files.len(), wrong.join("\n"));
    }
}
