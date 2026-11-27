//! A card chat's Claude screen, read as a terminal shows it (Challenger
//! round 2, P1-B): every byte the PTY writes is fed to an emulated grid
//! ([`ChatScreen`], `vt100`, the PTY's own size), and the chat's matchers
//! read the grid's rows — so cursor moves, partial repaints and erased lines
//! read as they look, not as a byte stream with its escapes stripped.
//!
//! Whether a turn is over is the transcript's to say (`chat_transcript`);
//! the screen only answers what the transcript can't: may a message be
//! pasted now ([`composer_idle`]), and is Claude waiting on a screen of its
//! own (a blocking screen, the trust question, a menu).
//!
//! **The composer** (Claude Code 2.1.300, Phase 0): a box of two rule rows
//! with the input line between them — `❯ ` and the draft — and its footer
//! below ("? for shortcuts", the mode line; "esc to interrupt" while a turn
//! runs). A menu row also starts with the chevron, but with a numbered
//! choice (`❯ 1. Stop and wait for limit to reset`): never an input line.

use parking_lot::Mutex;
use std::sync::Arc;

/// The chat PTY's size (`pty::spawn_chat`), and so the grid's.
pub(crate) const ROWS: u16 = 40;
pub(crate) const COLS: u16 = 120;

/// A Claude chat session's screen: the PTY's output (`capture`, which the
/// PTY's reader fills) fed into an emulated terminal grid as it is read.
pub(crate) struct ChatScreen {
    capture: Arc<Mutex<Vec<u8>>>,
    grid: Mutex<Grid>,
}

/// The grid and how many of the session's bytes it has been fed — the
/// `pty://data` offset its state stands at (both count from the PTY's
/// first byte, in the reader's order).
struct Grid {
    parser: vt100::Parser,
    fed: u64,
}

/// "Show terminal"'s first paint (`chat_screen`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScreenState {
    /// Escape sequences that redraw the screen **and** its terminal modes
    /// (`state_formatted`: bracketed paste, the cursor keys' mode, the
    /// cursor) — a terminal attached late must send keys and pastes as
    /// Claude asked for them.
    pub formatted: Vec<u8>,
    /// The session's bytes the grid holds: a `pty://data` byte before this
    /// offset is already in `formatted`.
    pub offset: u64,
    pub rows: u16,
    pub cols: u16,
}

impl ChatScreen {
    pub(crate) fn new(capture: Arc<Mutex<Vec<u8>>>) -> Self {
        ChatScreen { capture, grid: Mutex::new(Grid { parser: vt100::Parser::new(ROWS, COLS, 0), fed: 0 }) }
    }

    /// The grid, fed what the PTY wrote since the last read. The grid's lock
    /// is taken first and the capture drained under it, so two readers can
    /// never feed it out of order and `fed` stays the stream's offset.
    fn fed(&self) -> parking_lot::MutexGuard<'_, Grid> {
        let mut grid = self.grid.lock();
        let bytes = std::mem::take(&mut *self.capture.lock());
        if !bytes.is_empty() {
            grid.parser.process(&bytes);
            grid.fed += bytes.len() as u64;
        }
        grid
    }

    /// The grid's rows now (trailing blanks cut), as the matchers read them:
    /// a no-break space is a space (Claude Code 2.1.300 draws `❯` and one),
    /// and on the composer's input line Claude's **suggested prompt** — the
    /// ghost text it draws after a finished turn, faint or grey, which
    /// typing replaces — is not a draft: only the characters drawn plain
    /// are kept (Mac walk of 30e79013, F1).
    pub(crate) fn rows(&self) -> Vec<String> {
        let grid = self.fed();
        let screen = grid.parser.screen();
        let (_, cols) = screen.size();
        screen
            .rows(0, cols)
            .enumerate()
            .map(|(index, row)| {
                let row = row.replace('\u{a0}', " ");
                let row = if may_hold_a_suggestion(&row) { without_ghost_text(screen, index as u16, cols) } else { row };
                row.trim_end().to_string()
            })
            .collect()
    }

    /// The PTY was resized (`pty_resize`, part 2's "Show terminal"): what
    /// was written before is read at the old size, then the grid takes the
    /// new one, so the matchers follow Claude's repaint at its real size.
    pub(crate) fn set_size(&self, rows: u16, cols: u16) {
        let mut grid = self.fed();
        grid.parser.screen_mut().set_size(rows.max(1), cols.max(1));
    }

    #[cfg(test)]
    pub(crate) fn size(&self) -> (u16, u16) {
        self.grid.lock().parser.screen().size()
    }

    /// The first paint of part 2's "Show terminal": the screen and its
    /// modes as escape sequences, the stream offset they stand at, and the
    /// grid's size (the terminal takes it before writing them). The capture
    /// is drained here, so a terminal attaching late starts from this, then
    /// writes only the `pty://data` bytes at or after `offset`.
    pub(crate) fn state(&self) -> ScreenState {
        let grid = self.fed();
        let (rows, cols) = grid.parser.screen().size();
        ScreenState { formatted: grid.parser.screen().state_formatted(), offset: grid.fed, rows, cols }
    }
}

/// A row that may be the composer's input line (the chevron first, inside
/// the box's edges) and is no numbered menu row: the only rows whose ghost
/// text is left out. A footer is often drawn faint too, and it says
/// whether a turn runs, so no other row loses its faint words.
fn may_hold_a_suggestion(row: &str) -> bool {
    inner(row).starts_with('❯') && !is_menu_row(row)
}

/// Ghost text: faint (SGR 2), or a grey foreground — the palette's bright
/// black (8), the grey ramp (232–250), or an RGB grey. Real typed text is
/// drawn in the default colour.
fn is_ghost(cell: &vt100::Cell) -> bool {
    if cell.dim() {
        return true;
    }
    match cell.fgcolor() {
        vt100::Color::Idx(8) => true,
        vt100::Color::Idx(index) => (232..=250).contains(&index),
        vt100::Color::Rgb(r, g, b) => {
            let (max, min) = (r.max(g).max(b), r.min(g).min(b));
            max - min <= 24 && (64..=200).contains(&max)
        }
        vt100::Color::Default => false,
    }
}

/// The row rebuilt from its cells, with every ghost cell after the chevron
/// drawn as a space.
fn without_ghost_text(screen: &vt100::Screen, row: u16, cols: u16) -> String {
    let mut out = String::new();
    let mut after_chevron = false;
    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else { break };
        if cell.is_wide_continuation() {
            continue;
        }
        let contents = cell.contents();
        let text = if contents.is_empty() { " " } else { contents };
        if after_chevron && is_ghost(cell) {
            out.push_str(&" ".repeat(text.chars().count().max(1)));
        } else {
            out.push_str(&text.replace('\u{a0}', " "));
        }
        if text.contains('❯') {
            after_chevron = true;
        }
    }
    out
}

/// The rows as one text, for the matchers that read words
/// (`claude_session::asks_for_folder_trust`, `blocking_screen`,
/// `asks_for_permission`, `frame_signature`).
pub(crate) fn text(rows: &[String]) -> String {
    rows.join("\n")
}

/// The end of the screen, readable, for a message: non-blank rows that are
/// not only frame glyphs, at most `max_chars` from the end.
pub(crate) fn tail(rows: &[String], max_chars: usize) -> String {
    let lines: Vec<&str> = rows
        .iter()
        .map(|row| row.trim())
        .filter(|row| !row.is_empty() && !is_rule(row))
        .collect();
    let joined = lines.join("\n");
    let count = joined.chars().count();
    if count <= max_chars {
        return joined;
    }
    let cut: String = joined.chars().skip(count - max_chars).collect();
    format!("…{cut}")
}

/// A rule row: box-drawing glyphs only (a flat rule, a box's top or bottom).
fn is_rule(row: &str) -> bool {
    let row = row.trim();
    row.chars().count() >= 8 && row.chars().all(|c| matches!(c, '\u{2500}'..='\u{257F}'))
}

/// A row with its box edges and outer blanks taken off.
fn inner(row: &str) -> &str {
    row.trim().trim_start_matches(['│', '|']).trim_end_matches(['│', '|']).trim()
}

/// A menu row: the chevron and a numbered choice (`❯ 1. …`).
pub(crate) fn is_menu_row(row: &str) -> bool {
    let Some(rest) = inner(row).strip_prefix('❯') else {
        return false;
    };
    let rest = rest.trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with('.')
}

/// The composer's input line: the chevron, then anything but a numbered
/// choice.
fn is_input_line(row: &str) -> bool {
    let row = inner(row);
    (row == "❯" || row.starts_with("❯ ")) && !is_menu_row(row)
}

/// Where the composer box is on the grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ComposerBox {
    pub top: usize,
    pub bottom: usize,
}

/// The lowest composer box: two rule rows with an input line between them
/// (a draft may take more rows).
pub(crate) fn composer_box(rows: &[String]) -> Option<ComposerBox> {
    let rules: Vec<usize> = rows.iter().enumerate().filter(|(_, row)| is_rule(row)).map(|(i, _)| i).collect();
    rules
        .windows(2)
        .rev()
        .find(|pair| rows[pair[0] + 1..pair[1]].iter().any(|row| is_input_line(row)))
        .map(|pair| ComposerBox { top: pair[0], bottom: pair[1] })
}

/// The rows below the box that are not blank: its footer.
fn footer(rows: &[String], composer: ComposerBox) -> Vec<&String> {
    rows[composer.bottom + 1..].iter().filter(|row| !row.trim().is_empty()).collect()
}

/// The composer box is the last thing drawn: below it only its footer (a
/// few rows), no menu.
pub(crate) fn composer_drawn_last(rows: &[String]) -> bool {
    composer_box(rows).is_some_and(|composer| {
        let below = footer(rows, composer);
        below.len() <= 3 && !below.iter().any(|row| is_menu_row(row))
    })
}

/// A numbered menu waits for a choice: a menu row drawn below the last
/// composer box (or with none on screen) — the usage-limit menu, a model or
/// rewind picker, a permission dialog.
pub(crate) fn menu_waiting(rows: &[String]) -> bool {
    let from = composer_box(rows).map_or(0, |composer| composer.bottom + 1);
    rows[from..].iter().any(|row| is_menu_row(row))
}

/// Claude waits at its idle composer: the box drawn last, its footer not
/// saying a turn runs ("esc to interrupt", queued messages, "ctrl+b to run
/// in background" — the footer is what Claude repaints when a turn ends;
/// a spinner row above the box may be left stale), and no menu or dialog.
/// Only then may a message be pasted.
pub(crate) fn composer_idle(rows: &[String]) -> bool {
    let Some(composer) = composer_box(rows) else {
        return false;
    };
    if !composer_drawn_last(rows) || menu_waiting(rows) {
        return false;
    }
    let screen = text(rows);
    if crate::claude_session::asks_for_permission(&screen) || crate::claude_session::asks_for_folder_trust(&screen) {
        return false;
    }
    // A draft of the member's own (typed in the terminal) that starts with
    // `!` (Claude's shell mode) or `/` (the slash menu): Plyloft's paste
    // would land after it and run in the shell, so the composer is not
    // idle — `attention.ts::claudeComposerEscaped`, the Builder's rule.
    let escaped = rows[composer.top + 1..composer.bottom].iter().find(|row| is_input_line(row)).is_some_and(|row| {
        let draft = inner(row).trim_start_matches('❯').trim_start();
        draft.starts_with('!') || draft.starts_with('/')
    });
    if escaped {
        return false;
    }
    !footer(rows, composer).iter().any(|row| {
        let row = row.to_lowercase();
        row.contains("esc to interrupt")
            || row.contains("press up to edit queued messages")
            || row.contains("ctrl+b to run in background")
    })
}

/// Claude's working line: a spinner glyph, then words starting with a
/// capital up to an ellipsis, and on a longer turn its elapsed time and
/// tokens — `✳ Envisioning…`, `✢ Quantumizing… (1m 1s · ↓ 4.4k tokens)`,
/// the todo list's current task `✶ Writing the introduction… (2m 3s · ↓ 1.2k
/// tokens)`, `✻ Compacting conversation…`, a hook's `· Running PreToolUse
/// hook…`, a custom spinner verb. The glyph cycles (✢ ✳ ✶ ✻ ✽ · * on the Mac
/// and on Windows alike); a finished turn's line has no ellipsis
/// (`✻ Churned for 1s · done 7:27 PM`). An answer's or a tool's bullet
/// (`⏺`, `●`), the prompt and the todo list's and check marks' glyphs are
/// no spinner.
pub(crate) fn is_working_line(row: &str) -> bool {
    let row = row.trim();
    let mut chars = row.chars();
    let Some(glyph) = chars.next() else { return false };
    if glyph.is_alphanumeric()
        || matches!(
            glyph,
            '⏺' | '●' | '❯' | '⎿' | '│' | '|' | '>' | '-' | '✓' | '✔' | '✗' | '✘' | '•' | '☐' | '☒' | '■' | '□'
        )
    {
        return false;
    }
    let Some(rest) = chars.as_str().strip_prefix(' ') else { return false };
    if !rest.chars().next().is_some_and(char::is_uppercase) {
        return false;
    }
    let Some(at) = rest.find('…') else { return false };
    let after = &rest[at + '…'.len_utf8()..];
    at > 0 && (after.is_empty() || after.starts_with(" ("))
}

/// Claude shows its working line above its composer box: a turn runs,
/// whatever the footer says — the footer can show something else meanwhile
/// ("paste again to expand"), and a long answer may leave the grid
/// unchanged for many seconds (walks of 1b958f7b: the stuck-turn closer
/// fired 22 s into a 98 s answer). Between the line and the box there may
/// be a tip or the todo list (`⎿ …`, indented rows) and blank rows: read
/// up from the box past those, the first other row is the one that tells.
pub(crate) fn working_line_shown(rows: &[String]) -> bool {
    let Some(composer) = composer_box(rows) else { return false };
    rows[..composer.top]
        .iter()
        .rev()
        .find(|row| {
            let trimmed = row.trim();
            !(trimmed.is_empty() || trimmed.starts_with('⎿') || row.starts_with(char::is_whitespace))
        })
        .is_some_and(|row| is_working_line(row))
}

/// A screen only the member can get past (`claude_session::blocking_screen`:
/// sign-in, first-run setup, the API-key question, the usage-limit menu,
/// the bypass warning), on every frame — except words above a composer box
/// drawn below them (the conversation quoting such a screen).
pub(crate) fn blocker(rows: &[String]) -> Option<&'static str> {
    let from = composer_box(rows).map_or(0, |composer| composer.top);
    crate::claude_session::blocking_screen(&text(&rows[from..]), false)
}

#[cfg(test)]
pub(crate) mod vt {
    //! Real VT streams for the tests: a full paint from the top, rows placed
    //! by cursor moves, and partial repaints of single rows.

    pub(crate) const RULE: &str = "────────────────────────────────────────";

    /// Clears the screen and paints `rows` from row 1, each placed with a
    /// cursor move and erased first.
    pub(crate) fn paint(rows: &[&str]) -> Vec<u8> {
        let mut out = b"\x1b[2J\x1b[H".to_vec();
        for (index, row) in rows.iter().enumerate() {
            out.extend_from_slice(format!("\x1b[{};1H\x1b[2K{row}", index + 1).as_bytes());
        }
        out
    }

    /// Repaints row `row` (1-based) only: cursor there, erase the line,
    /// write `text`, and put the cursor back in the composer.
    pub(crate) fn repaint(row: usize, text: &str, cursor_row: usize) -> Vec<u8> {
        format!("\x1b7\x1b[{row};1H\x1b[2K{text}\x1b8\x1b[{cursor_row};3H").into_bytes()
    }

    /// The idle composer under an answer.
    pub(crate) fn idle(answer: &str) -> Vec<String> {
        vec![
            format!("⏺ {answer}"),
            String::new(),
            "✻ Worked for 3s · done 2:55 PM".into(),
            RULE.into(),
            "❯ ".into(),
            RULE.into(),
            "  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents".into(),
        ]
    }

    /// A turn running: the spinner above the box, "esc to interrupt" below.
    pub(crate) fn working(prompt: &str) -> Vec<String> {
        vec![
            format!("❯ {prompt}"),
            String::new(),
            "✶ Herding… (2s · ↓ 12 tokens)".into(),
            RULE.into(),
            "❯ ".into(),
            RULE.into(),
            "  ⏵⏵ don't ask on (shift+tab to cycle) · esc to interrupt · ← for agents".into(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::vt::*;
    use super::*;

    fn grid(stream: &[u8]) -> Vec<String> {
        let capture = Arc::new(Mutex::new(stream.to_vec()));
        ChatScreen::new(capture).rows()
    }

    fn rows_of(rows: &[String]) -> Vec<&str> {
        rows.iter().map(String::as_str).collect()
    }

    #[test]
    fn a_painted_idle_composer_is_idle_and_a_running_turn_is_not() {
        let idle = idle("OK");
        assert!(composer_idle(&grid(&paint(&rows_of(&idle)))));
        let working = working("Reply with exactly: OK");
        let rows = grid(&paint(&rows_of(&working)));
        assert!(composer_drawn_last(&rows));
        assert!(!composer_idle(&rows), "esc to interrupt in the footer");
    }

    /// The end of a turn repaints the footer only; the spinner row above the
    /// box keeps its stale words. Read from the grid, that is idle.
    #[test]
    fn a_footer_only_repaint_at_the_end_of_a_turn_reads_idle() {
        let working = working("Reply with exactly: OK");
        let mut stream = paint(&rows_of(&working));
        assert!(!composer_idle(&grid(&stream)));
        stream.extend(repaint(7, "  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents", 5));
        let rows = grid(&stream);
        assert!(rows[2].contains("Herding…"), "the stale spinner is still drawn: {rows:?}");
        assert!(composer_idle(&rows));
        // The raw stream still holds "esc to interrupt": only the grid knows
        // it was erased.
        assert!(String::from_utf8_lossy(&stream).contains("esc to interrupt"));
    }

    /// A resize: the grid takes the PTY's new size and reads Claude's repaint
    /// at it.
    #[test]
    fn a_resize_then_a_repaint_reads_at_the_new_size() {
        let capture = Arc::new(Mutex::new(paint(&rows_of(&working("hi")))));
        let screen = ChatScreen::new(capture.clone());
        assert!(!composer_idle(&screen.rows()));
        screen.set_size(24, 60);
        assert_eq!(screen.size(), (24, 60));
        let narrow: Vec<String> = idle("OK").into_iter().map(|row| row.chars().take(60).collect()).collect();
        capture.lock().extend(paint(&rows_of(&narrow)));
        let rows = screen.rows();
        assert_eq!(rows.len(), 24);
        assert!(composer_idle(&rows), "{rows:?}");
        assert!(!screen.state().formatted.is_empty());
    }

    /// Challenger round 1 (part 2), P1-1 and P2-1/P2-2: the first paint
    /// carries the modes Claude set (bracketed paste), the grid's size and
    /// the offset of the bytes it holds.
    #[test]
    fn the_first_paint_carries_the_modes_the_size_and_the_offset() {
        let stream = b"\x1b[?2004h\x1b[Hhello".to_vec();
        let len = stream.len() as u64;
        let capture = Arc::new(Mutex::new(stream));
        let screen = ChatScreen::new(capture.clone());
        let state = screen.state();
        let text = String::from_utf8_lossy(&state.formatted).into_owned();
        assert!(text.contains("\x1b[?2004h"), "{text:?}");
        assert!(text.contains("hello"));
        assert_eq!((state.rows, state.cols), (ROWS, COLS));
        assert_eq!(state.offset, len);
        // Fed by the matchers meanwhile: the offset still counts every byte.
        capture.lock().extend_from_slice(b" world");
        let _ = screen.rows();
        screen.set_size(24, 60);
        capture.lock().extend_from_slice(b"!");
        let state = screen.state();
        assert_eq!(state.offset, len + 7);
        assert_eq!((state.rows, state.cols), (24, 60));
        // A terminal that turned bracketed paste off is painted without it.
        capture.lock().extend_from_slice(b"\x1b[?2004l");
        let text = String::from_utf8_lossy(&screen.state().formatted).into_owned();
        assert!(!text.contains("\x1b[?2004h"), "{text:?}");
    }

    /// Mac walk of 30e79013, F1: after a finished turn Claude Code 2.1.300
    /// draws a suggested prompt in its input box — faint or grey, after `❯`
    /// and a no-break space — which comes back when cleared. It is no
    /// draft: the composer reads idle. A plain draft still counts, and a
    /// faint footer still says a turn runs.
    #[test]
    fn a_suggested_prompt_drawn_faint_or_grey_reads_as_an_idle_composer() {
        let frame = |input: &str, footer: &str| {
            let mut out = b"\x1b[2J\x1b[H".to_vec();
            let lines = [
                "\u{23fa} ONE".to_string(),
                String::new(),
                "\u{273b} Worked for 3s".to_string(),
                RULE.to_string(),
                input.to_string(),
                RULE.to_string(),
                footer.to_string(),
            ];
            for (index, line) in lines.iter().enumerate() {
                out.extend_from_slice(format!("\x1b[{};1H\x1b[2K{line}", index + 1).as_bytes());
            }
            out.extend_from_slice(b"\x1b[5;3H");
            out
        };
        let quiet = "  \x1b[2m\u{23f5}\u{23f5} don't ask on (shift+tab to cycle) \u{b7} \u{2190} for agents\x1b[0m";
        let idle_with = |input: &str, footer: &str| {
            let screen = ChatScreen::new(Arc::new(Mutex::new(frame(input, footer))));
            let rows = screen.rows();
            (composer_idle(&rows), rows)
        };
        // Faint (SGR 2) after ❯ and a no-break space.
        let (idle, rows) = idle_with("\u{276f}\u{a0}\x1b[2mReply with exactly THREE.\x1b[0m", quiet);
        assert!(idle, "{rows:?}");
        assert_eq!(rows[4], "\u{276f}");
        // Bright black (90), the 256-colour grey ramp, an RGB grey.
        for ghost in ["\x1b[90m", "\x1b[38;5;244m", "\x1b[38;2;153;153;153m"] {
            let (idle, rows) = idle_with(&format!("\u{276f}\u{a0}{ghost}just testing streaming, write a few paragraphs\x1b[0m"), quiet);
            assert!(idle, "{ghost:?}: {rows:?}");
        }
        // A suggestion starting with / is no slash draft of the member's.
        let (idle, _) = idle_with("\u{276f} \x1b[2m/compact\x1b[0m", quiet);
        assert!(idle);
        // The empty composer with a no-break space.
        let (idle, _) = idle_with("\u{276f}\u{a0}", quiet);
        assert!(idle);
        // Controls: a plain draft starting with ! is the member's own; a
        // faint footer saying a turn runs still holds the paste.
        let (idle, _) = idle_with("\u{276f}\u{a0}!ls", quiet);
        assert!(!idle);
        let (idle, rows) = idle_with("\u{276f} \x1b[2mReply\x1b[0m", "  \x1b[2m\u{23f5}\u{23f5} don't ask on \u{b7} esc to interrupt\x1b[0m");
        assert!(!idle, "{rows:?}");
        // A plain draft stays on the row (other rows are read as they are).
        let (_, rows) = idle_with("\u{276f} my own words", quiet);
        assert_eq!(rows[4], "\u{276f} my own words");
        // A numbered menu row drawn faint is still a menu.
        let (idle, _) = idle_with("\u{276f} \x1b[2m1. Stop and wait\x1b[0m", quiet);
        assert!(!idle);
    }

    #[test]
    fn the_screen_is_fed_as_it_grows() {
        let capture = Arc::new(Mutex::new(paint(&rows_of(&working("hi")))));
        let screen = ChatScreen::new(capture.clone());
        assert!(!composer_idle(&screen.rows()));
        capture.lock().extend(repaint(7, "  ? for shortcuts", 5));
        assert!(composer_idle(&screen.rows()));
        assert!(capture.lock().is_empty(), "read once");
    }

    #[test]
    fn a_menu_with_the_chevron_is_no_composer_and_blocks() {
        // The usage-limit menu, chevron on its first choice, in a box.
        let limit = paint(&[
            "⏺ Partial answer",
            "",
            RULE,
            "  You've hit your limit · resets 3pm",
            "",
            "  ❯ 1. Stop and wait for limit to reset",
            "    2. Upgrade your plan",
            RULE,
            "  Enter to confirm · Esc to cancel",
        ]);
        let rows = grid(&limit);
        assert!(composer_box(&rows).is_none(), "a menu row is no input line");
        assert!(menu_waiting(&rows));
        assert!(!composer_idle(&rows));
        assert_eq!(blocker(&rows), Some(crate::claude_session::USAGE_LIMIT));

        // The same menu drawn below a composer box still blocks.
        let mut below = idle("earlier answer");
        below.extend(["  ❯ 1. Stop and wait for limit to reset".into(), "    2. Upgrade your plan".into()]);
        let rows = grid(&paint(&rows_of(&below)));
        assert!(!composer_drawn_last(&rows) && !composer_idle(&rows));
        assert_eq!(blocker(&rows), Some(crate::claude_session::USAGE_LIMIT), "below the box: no quote");
    }

    #[test]
    fn a_model_or_rewind_picker_waits_for_a_choice() {
        let picker = paint(&[
            " Select model",
            "",
            " ❯ 1. Default (recommended)",
            "   2. Opus",
            "   3. Sonnet",
            "",
            " Enter to confirm · Esc to exit",
        ]);
        let rows = grid(&picker);
        assert!(menu_waiting(&rows));
        assert!(!composer_idle(&rows));
        let rewind = paint(&[" Rewind", " ❯ 1. Restore the code and the conversation", "   2. Never mind"]);
        assert!(!composer_idle(&grid(&rewind)));
    }

    /// Claude Code 2.1.300's `/model` picker as the Windows walk of 567616d4
    /// drew it (`step9-model-menu`): the conversation above, one rule, the
    /// picker in place of the composer box, the chevron on the current
    /// choice (the 2nd, in colour, with a check mark), numbers padded for
    /// ten and more, a scroll arrow, the effort line and its footer.
    #[test]
    fn claude_s_model_picker_in_place_of_the_composer_waits_for_a_choice() {
        let wide = "─".repeat(120);
        let picker = paint(&[
            "\x1b[1m●\x1b[22m ALPHA",
            "  OMEGA",
            "",
            "\x1b[2m✻ Sautéed for 1s · done 11:43 PM\x1b[22m",
            "",
            "\x1b[48;5;237m❯  /model is what I would type in a terminal; here just tell me in one sentence what /model does.\x1b[49m",
            "",
            "● /model is a built-in Claude Code command that lets you see and change which Claude model the session uses.",
            "",
            "\x1b[2m✻ Baked for 1s · done 11:44 PM\x1b[22m",
            &format!("\x1b[38;5;104m{wide}\x1b[39m"),
            "",
            "   \x1b[1;38;5;104mSelect model\x1b[22;39m",
            "   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,",
            "   specify with --model.",
            "",
            "      1. Default (recommended)  \x1b[38;5;209mOpus 5.5\x1b[39m · Best for everyday, complex tasks",
            "   \x1b[38;5;104m❯\x1b[39m  2. \x1b[32mOpus 5.5 ✓\x1b[39m                For complex work and everyday tasks",
            "      3. Fable 5.1                For your toughest challenges",
            "      4. Sonnet 5.5               Most efficient for simpler tasks",
            "   ↓ 10. Opus 4.8                 Best for everyday, complex tasks",
            "     … +3 models",
            "",
            "   \x1b[38;5;209m●\x1b[39m Medium effort (default) \x1b[2m←/→ to adjust\x1b[22m",
            "",
            "   \x1b[2mEnter to set as default · s to use this session only · Esc to cancel\x1b[22m",
        ]);
        let rows = grid(&picker);
        assert!(composer_box(&rows).is_none(), "the picker took the composer's place");
        assert!(menu_waiting(&rows), "the chevron on the 2nd choice is a menu row: {rows:#?}");
        assert!(!composer_idle(&rows));
        assert_eq!(blocker(&rows), None, "a picker is no blocking screen: the member answers it");
    }

    /// Claude Code 2.1.300's working line above an empty composer (the
    /// walks of 1b958f7b, Windows `step1-attesa` and the live test's own
    /// screens): a turn runs even when the footer doesn't say so.
    #[test]
    fn claude_s_working_line_says_a_turn_runs() {
        for line in [
            "✢ Quantumizing… (1m 1s · ↓ 4.4k tokens)",
            "✳ Envisioning…",
            "✳ Envisioning… (8s · ↓ 497 tokens · thought for 1s)",
            "✶ Ruminating…",
            "✻ Pondering…",
            "✽ Herding… (2s · ↑ 12 tokens)",
            "· Fiddle-faddling…",
            "* Sautéing…",
            "✶ Writing the introduction… (2m 3s · ↓ 1.2k tokens)",
            "✻ Compacting conversation…",
            "· Running PreToolUse hook…",
            "✽ Spelunking the river delta… (14s · ↑ 3 tokens · esc to interrupt)",
        ] {
            assert!(is_working_line(line), "{line}");
            let rows = grid(&paint(&[
                "❯  Write a 3000-word essay about rivers, with headings.",
                "",
                line,
                "  ⎿  Tip: Run /install-slack-app to use Claude in Slack",
                "",
                RULE,
                "❯ ",
                RULE,
                "  paste again to expand",
            ]));
            assert!(composer_idle(&rows), "the composer alone reads idle: {rows:?}");
            assert!(working_line_shown(&rows), "{line}: {rows:?}");
        }
        for line in [
            "✻ Churned for 1s · done 7:27 PM",
            "✻ Baked for 1s · done 11:44 PM",
            "⏺ Reading 2 files… (ctrl+o to expand)",
            "● The answer ends here…",
            "❯  Tell me more…",
            "  ⎿  Interrupted · What should Claude do instead?",
            "Rivers…",
            "✓ Wrote the outline…",
            "☐ Draft the conclusion…",
            "• Some list item…",
            "✻ the lowercase verb…",
            "✳ Envisioning… and more words",
        ] {
            assert!(!is_working_line(line), "{line}");
        }
        assert!(!working_line_shown(&grid(&paint(&rows_of(&idle("OK"))))));

        // The todo list (eight rows) between the line and the box.
        let mut todo = vec!["❯  Write a 3000-word essay about rivers.".to_string(), String::new()];
        todo.push("✶ Writing the introduction… (2m 3s · ↓ 1.2k tokens)".into());
        todo.push("  ⎿  ☒ Plan the essay".into());
        for task in ["Sources", "Upper course", "Middle course", "Lower course", "Deltas", "People", "Conclusion"] {
            todo.push(format!("     ☐ {task}"));
        }
        todo.extend(["".to_string(), RULE.into(), "❯ ".into(), RULE.into(), "  paste again to expand".into()]);
        let rows = grid(&paint(&rows_of(&todo)));
        assert!(composer_idle(&rows));
        assert!(working_line_shown(&rows), "past eight todo rows: {rows:?}");
        // A finished answer above the box: the first other row is its
        // bullet's, not a spinner, whatever is above it.
        let done = grid(&paint(&[
            "✳ Envisioning… (8s · ↓ 497 tokens)",
            "",
            "⏺ The answer.",
            "",
            "✻ Churned for 9s · done 7:27 PM",
            "",
            RULE,
            "❯ ",
            RULE,
            "  ? for shortcuts",
        ]));
        assert!(!working_line_shown(&done), "{done:?}");
        let answer = grid(&paint(&["✳ Envisioning…", "⏺ The answer.", "  more of it", RULE, "❯ ", RULE, "  ? for shortcuts"]));
        assert!(!working_line_shown(&answer), "stops at the answer's bullet");
    }

    #[test]
    fn a_blocker_quoted_above_the_composer_is_the_conversation() {
        let quoted = paint(&[
            "⏺ When Claude asks you to Select login method, choose the first option.",
            "",
            RULE,
            "❯ ",
            RULE,
            "  ? for shortcuts",
        ]);
        let rows = grid(&quoted);
        assert!(composer_idle(&rows));
        assert_eq!(blocker(&rows), None);
        // The same words with no composer below them: the sign-in screen.
        let sign_in = paint(&[" Select login method:", " ❯ 1. Claude account with subscription", "   2. Anthropic Console account"]);
        assert_eq!(blocker(&grid(&sign_in)), Some(crate::claude_session::NOT_LOGGED_IN));
    }

    #[test]
    fn the_trust_question_and_a_permission_dialog_are_no_idle_composer() {
        let trust = paint(&[
            " Quick safety check: Is this a project you created or one you trust?",
            "",
            " ❯ 1. Yes, I trust this folder",
            "   2. No, exit",
            "",
            " Enter to confirm · Esc to cancel",
        ]);
        let rows = grid(&trust);
        assert!(crate::claude_session::asks_for_folder_trust(&text(&rows)));
        assert!(!composer_idle(&rows));
        let permission = paint(&[
            " Read file",
            " Do you want to proceed?",
            " ❯ 1. Yes",
            "   2. No, and tell Claude what to do differently (esc)",
        ]);
        let rows = grid(&permission);
        assert!(crate::claude_session::asks_for_permission(&text(&rows)));
        assert!(!composer_idle(&rows));
    }

    #[test]
    fn a_draft_in_the_composer_is_still_its_input_line() {
        let draft = paint(&[RULE, "❯ half a message", RULE, "  ? for shortcuts"]);
        assert!(composer_idle(&grid(&draft)));
        // The member's own `!` or `/` draft: Plyloft's paste would run in
        // the shell or open the slash menu, so the composer isn't idle.
        for escaped in ["❯ !ls", "❯ /cost", "❯   !rm"] {
            assert!(!composer_idle(&grid(&paint(&[RULE, escaped, RULE, "  ? for shortcuts"]))), "{escaped}");
        }
        let numbered = paint(&[RULE, "❯ 1. is how my list starts", RULE, "  ? for shortcuts"]);
        assert!(!composer_idle(&grid(&numbered)), "a numbered draft reads as a menu: refused, never mis-sent");
    }

    /// 1.169.0 (B4): the grid sizes emoji as the terminals do (vendored
    /// vt100, `crates/vt100/VENDORED.md`): a VS16 emoji, a ZWJ sequence, a
    /// flag and a skin tone are each one two-column character. The matchers
    /// read the rows as before, and the first paint of "Show terminal" lays
    /// them out where the live screen has them.
    #[test]
    fn emoji_in_an_answer_and_a_draft_read_as_drawn() {
        let answer = "Done \u{26a0}\u{fe0f} \u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467} \u{1f1ee}\u{1f1f9} \u{1f44d}\u{1f3fd}";
        let idle = idle(answer);
        let rows = grid(&paint(&rows_of(&idle)));
        assert_eq!(rows[0], format!("\u{23fa} {answer}"));
        assert!(composer_idle(&rows), "{rows:?}");
        assert!(tail(&rows, 400).contains(answer));
        let draft = paint(&[RULE, "\u{276f} check \u{26a0}\u{fe0f} first", RULE, "  ? for shortcuts"]);
        let rows = grid(&draft);
        assert_eq!(rows[1], "\u{276f} check \u{26a0}\u{fe0f} first");
        assert!(composer_idle(&rows));
        assert!(!composer_idle(&grid(&paint(&[RULE, "\u{276f} !\u{26a0}\u{fe0f}", RULE, "  ? for shortcuts"]))));
    }

    #[test]
    fn a_suggested_prompt_with_an_emoji_is_still_ghost_text() {
        let stream = paint(&[RULE, "\u{276f} \x1b[2mtry \u{26a0}\u{fe0f} this\x1b[0m", RULE, "  ? for shortcuts"]);
        let rows = grid(&stream);
        assert_eq!(rows[1], "\u{276f}");
        assert!(composer_idle(&rows), "{rows:?}");
    }

    /// The Challenger's case (B1, finding 2): a box row with ⚠️, its right
    /// edge then placed by absolute position at the column Claude counts.
    /// One edge, where Claude meant it; the first paint replays the same
    /// screen (src/test/chatReplayWideChars.test.tsx replays it into xterm).
    #[test]
    fn a_box_edge_placed_after_a_vs16_emoji_lands_once_and_replays_the_same() {
        let top = format!("\u{256d}{}\u{256e}", "\u{2500}".repeat(10));
        let bottom = format!("\u{2570}{}\u{256f}", "\u{2500}".repeat(10));
        let live = format!("{top}\r\n\u{2502}\u{26a0}\u{fe0f}X       \u{2502}\r\n{bottom}\x1b[2;12H\u{2502}");
        let screen = ChatScreen::new(Arc::new(Mutex::new(live.into_bytes())));
        screen.set_size(4, 12);
        let rows = screen.rows();
        assert_eq!(rows[1], "\u{2502}\u{26a0}\u{fe0f}X       \u{2502}");
        let state = screen.state();
        let replayed = ChatScreen::new(Arc::new(Mutex::new(state.formatted)));
        replayed.set_size(state.rows, state.cols);
        assert_eq!(replayed.rows()[..3], rows[..3]);
    }

    /// The bytes `src/test/chatReplayWideChars.test.tsx` replays into the
    /// tile's xterm are this crate's own: the fixture is checked here, so a
    /// change in `state_formatted()` fails a test (rewrite it with
    /// `PLY_UPDATE_FIXTURES=1 cargo test --lib chat_screen::`).
    #[test]
    fn the_replay_fixture_is_vt100s_own_output() {
        let top = format!("\u{256d}{}\u{256e}", "\u{2500}".repeat(10));
        let bottom = format!("\u{2570}{}\u{256f}", "\u{2500}".repeat(10));
        let live = format!("{top}\r\n\u{2502}\u{26a0}\u{fe0f}X       \u{2502}\r\n{bottom}\x1b[2;12H\u{2502}");
        let mut parser = vt100::Parser::new(4, 12, 0);
        parser.process(live.as_bytes());
        let replay = String::from_utf8(parser.screen().state_formatted()).unwrap();
        let fixture = serde_json::json!({
            "comment": "Written by chat_screen::tests::the_replay_fixture_is_vt100s_own_output: a 4x12 grid's state_formatted() after `live` (vendored vt100).",
            "rows": 4,
            "cols": 12,
            "live": live,
            "replay": replay,
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/test/fixtures/chatReplayVs16.json");
        let text = format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap());
        if std::env::var_os("PLY_UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "{} is stale", path.display());
    }
}
