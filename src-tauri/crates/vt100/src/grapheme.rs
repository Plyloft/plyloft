// Plyloft (vendored change, see VENDORED.md): grapheme clusters, the way
// xterm.js's unicode-graphemes addon ("15-graphemes") forms them — the
// widths Plyloft's terminals, the console host Plyloft ships on Windows
// (OpenConsole) and the TUIs drawing into them (Claude Code, Codex) use.
// Upstream vt100 sizes each code point on its own (unicode-width), so an
// emoji made wide by VS16 (⚠️ = U+26A0 U+FE0F) was one cell, and a ZWJ
// sequence, a flag or a skin tone several.
//
// Like xterm.js's `precedingJoinState`, what joins is decided from the
// characters received since the last cluster started, not from the cell's
// text (a cell keeps at most 22 bytes): the state is set by each printed
// character and cleared by anything else the parser acts on (a control
// character, an escape, CSI, OSC or DCS sequence) and by a resize. It is kept
// across writes.

use unicode_width::UnicodeWidthChar as _;

/// The cluster the last printed character belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JoinState {
    /// Its cell.
    pub at: crate::grid::Pos,
    /// Its width now (1 or 2).
    pub width: u16,
    /// It is one regional indicator, waiting for its pair.
    pub lone_regional_indicator: bool,
    /// Its last character is a ZWJ.
    pub after_zwj: bool,
}

impl JoinState {
    /// The cluster a character starts in its own cell `at`.
    pub fn start(at: crate::grid::Pos, c: char, width: u16) -> Self {
        Self { at, width: width.max(1), lone_regional_indicator: is_regional_indicator(c), after_zwj: false }
    }

    /// The cluster after `c` joined it, `width` wide.
    pub fn joined(self, c: char, width: u16) -> Self {
        Self { width, lone_regional_indicator: false, after_zwj: c == ZWJ, ..self }
    }
}

const ZWJ: char = '\u{200d}';
pub const VS16: char = '\u{fe0f}';

fn is_regional_indicator(c: char) -> bool {
    ('\u{1f1e6}'..='\u{1f1ff}').contains(&c)
}

fn is_emoji_modifier(c: char) -> bool {
    ('\u{1f3fb}'..='\u{1f3ff}').contains(&c)
}

/// `Grapheme_Cluster_Break=Extend` or ZWJ (UAX #29, GB9): what joins any
/// cluster. unicode-width's zero-width characters are these — combining
/// marks, ZWJ/ZWNJ, variation selectors, tags — but for the few that are
/// Control (zero width space, word joiner, BOM); skin tones are Extend too.
fn is_extend(c: char) -> bool {
    is_emoji_modifier(c)
        || (c.width() == Some(0) && !matches!(c, '\u{200b}' | '\u{2060}' | '\u{feff}' | '\u{180e}'))
}

/// `Extended_Pictographic` (Unicode 15, `emoji-data.txt`), by block: what a
/// ZWJ joins to the cluster before it (GB11).
fn is_extended_pictographic(c: char) -> bool {
    matches!(u32::from(c),
        0xa9 | 0xae | 0x203c | 0x2049 | 0x2122 | 0x2139
        | 0x2194..=0x2199 | 0x21a9..=0x21aa | 0x231a..=0x231b | 0x2328 | 0x2388 | 0x23cf
        | 0x23e9..=0x23f3 | 0x23f8..=0x23fa | 0x24c2 | 0x25aa..=0x25ab | 0x25b6 | 0x25c0
        | 0x25fb..=0x25fe | 0x2600..=0x2605 | 0x2607..=0x2612 | 0x2614..=0x2685
        | 0x2690..=0x2705 | 0x2708..=0x2712 | 0x2714 | 0x2716 | 0x271d | 0x2721 | 0x2728
        | 0x2733..=0x2734 | 0x2744 | 0x2747 | 0x274c | 0x274e | 0x2753..=0x2755 | 0x2757
        | 0x2763..=0x2767 | 0x2795..=0x2797 | 0x27a1 | 0x27b0 | 0x27bf | 0x2934..=0x2935
        | 0x2b05..=0x2b07 | 0x2b1b..=0x2b1c | 0x2b50 | 0x2b55 | 0x3030 | 0x303d | 0x3297
        | 0x3299
        | 0x1f000..=0x1f0ff | 0x1f10d..=0x1f10f | 0x1f12f | 0x1f16c..=0x1f171 | 0x1f17e..=0x1f17f
        | 0x1f18e | 0x1f191..=0x1f19a | 0x1f1ad..=0x1f1e5 | 0x1f201..=0x1f20f | 0x1f21a
        | 0x1f22f | 0x1f232..=0x1f23a | 0x1f23c..=0x1f23f | 0x1f249..=0x1f3fa
        | 0x1f400..=0x1f53d | 0x1f546..=0x1f64f | 0x1f680..=0x1f6ff | 0x1f774..=0x1f77f
        | 0x1f7d5..=0x1f7ff | 0x1f80c..=0x1f80f | 0x1f848..=0x1f84f | 0x1f85a..=0x1f85f
        | 0x1f888..=0x1f88f | 0x1f8ae..=0x1f8ff | 0x1f90c..=0x1f93a | 0x1f93c..=0x1f945
        | 0x1f947..=0x1faff | 0x1fc00..=0x1fffd)
}

/// A character's own width in a cluster, as xterm.js counts it: two for
/// VS16, a skin tone and a wide character; one for everything else.
fn own_width(c: char) -> u16 {
    if c == VS16 || is_emoji_modifier(c) || c.width() == Some(2) {
        2
    } else {
        1
    }
}

/// What a character does to the cluster before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Join {
    /// Not part of it: upstream's handling (a cell of its own).
    No,
    /// Appended to it, which is `width` wide after.
    Into { width: u16 },
}

/// How `c` joins `state`'s cluster: Extend and ZWJ always (GB9), a
/// pictograph after a ZWJ (GB11), a regional indicator after a lone one
/// (GB12/13). The cluster's width is then the larger of its own and the
/// character's (xterm.js: `max(oldWidth, width)`), and two for a flag.
pub fn join(state: Option<&JoinState>, c: char) -> Join {
    let Some(state) = state else {
        return Join::No;
    };
    if is_extend(c) || (state.after_zwj && is_extended_pictographic(c)) {
        return Join::Into { width: state.width.max(own_width(c)) };
    }
    if state.lone_regional_indicator && is_regional_indicator(c) {
        return Join::Into { width: 2 };
    }
    Join::No
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(c: char, width: u16) -> JoinState {
        JoinState::start(crate::grid::Pos::default(), c, width)
    }

    #[test]
    fn vs16_and_a_skin_tone_make_their_cluster_two_wide() {
        assert_eq!(join(Some(&state('\u{26a0}', 1)), VS16), Join::Into { width: 2 });
        assert_eq!(join(Some(&state('\u{1f44b}', 2)), VS16), Join::Into { width: 2 });
        assert_eq!(join(Some(&state('\u{261d}', 1)), '\u{1f3fd}'), Join::Into { width: 2 });
        // A space is a cluster too (xterm.js: " 🏽" and " ️" are two wide).
        assert_eq!(join(Some(&state(' ', 1)), '\u{1f3fd}'), Join::Into { width: 2 });
        assert_eq!(join(Some(&state(' ', 1)), VS16), Join::Into { width: 2 });
        // Nothing printed since the last escape: no cluster to join.
        assert_eq!(join(None, VS16), Join::No);
    }

    #[test]
    fn combining_marks_and_vs15_keep_the_width() {
        assert_eq!(join(Some(&state('e', 1)), '\u{301}'), Join::Into { width: 1 });
        assert_eq!(join(Some(&state('\u{26a0}', 1)), '\u{fe0e}'), Join::Into { width: 1 });
        assert_eq!(join(Some(&state('a', 1)), '\u{200b}'), Join::No, "zero width space is Control");
    }

    #[test]
    fn after_a_zwj_a_pictograph_joins_whatever_the_base() {
        let zwj = |c: char, w: u16| state(c, w).joined(ZWJ, w);
        assert_eq!(join(Some(&zwj('\u{1f468}', 2)), '\u{1f469}'), Join::Into { width: 2 });
        // xterm.js: a‍👩 → 2, ❤‍🔥 → 2, 👁‍🗨 → 1.
        assert_eq!(join(Some(&zwj('a', 1)), '\u{1f469}'), Join::Into { width: 2 });
        assert_eq!(join(Some(&zwj('\u{2764}', 1)), '\u{1f525}'), Join::Into { width: 2 });
        assert_eq!(join(Some(&zwj('\u{1f441}', 1)), '\u{1f5e8}'), Join::Into { width: 1 });
        // Not a pictograph: its own cell (xterm.js: 👨‍中, 👨‍─).
        assert_eq!(join(Some(&zwj('\u{1f468}', 2)), '\u{4e2d}'), Join::No);
        assert_eq!(join(Some(&zwj('\u{1f468}', 2)), '\u{2500}'), Join::No);
        // No ZWJ: the next emoji is its own.
        assert_eq!(join(Some(&state('\u{1f468}', 2)), '\u{1f469}'), Join::No);
    }

    #[test]
    fn two_regional_indicators_are_one_flag_and_a_third_starts_the_next() {
        let one = state('\u{1f1ee}', 1);
        assert_eq!(join(Some(&one), '\u{1f1f9}'), Join::Into { width: 2 });
        let flag = one.joined('\u{1f1f9}', 2);
        assert_eq!(join(Some(&flag), '\u{1f1eb}'), Join::No);
        assert_eq!(join(Some(&state('a', 1)), '\u{1f1ee}'), Join::No);
    }

    #[test]
    fn plain_text_box_drawing_and_cjk_are_their_own() {
        assert_eq!(join(Some(&state('a', 1)), 'b'), Join::No);
        assert_eq!(join(Some(&state('\u{2500}', 1)), '\u{2500}'), Join::No);
        assert_eq!(join(Some(&state('\u{4e2d}', 2)), '\u{6587}'), Join::No);
    }
}

/// Through the parser, against what xterm.js 6 with the graphemes addon
/// draws for the same bytes (the B4 Challenger's probe of the tiles' own
/// xterm, `installWideChars`): each row's cells as `(code points, wide)`,
/// continuations left out, and the cursor.
#[cfg(test)]
mod screen_tests {
    fn parser(rows: u16, cols: u16, data: &[&str]) -> crate::Parser {
        let mut p = crate::Parser::new(rows, cols, 0);
        for d in data {
            p.process(d.as_bytes());
        }
        p
    }

    /// xterm.js's probe notation: `|1f468 200dW|58` — each cell's code
    /// points in hex, `W` when two wide; empty cells as `|`.
    fn row(p: &crate::Parser, r: u16) -> String {
        let (_, cols) = p.screen().size();
        let mut out = String::new();
        for col in 0..cols {
            let cell = p.screen().cell(r, col).unwrap();
            if cell.is_wide_continuation() {
                out.push_str("|>");
                continue;
            }
            let hex: Vec<String> = cell.contents().chars().map(|c| format!("{:x}", u32::from(c))).collect();
            out.push('|');
            out.push_str(&hex.join(" "));
            if cell.is_wide() {
                out.push('W');
            }
        }
        out
    }

    fn check(name: &str, rows: u16, cols: u16, data: &[&str], cursor: (u16, u16), expected: &[&str]) {
        let p = parser(rows, cols, data);
        let got: Vec<String> = (0..u16::try_from(expected.len()).unwrap()).map(|r| row(&p, r)).collect();
        assert_eq!(got, expected, "{name}: cells");
        assert_eq!(p.screen().cursor_position(), cursor, "{name}: cursor");
    }

    #[test]
    fn zwj_sequences_stay_one_cluster_however_long() {
        // 25 bytes: more than a cell keeps, still one cluster (the 👦 is
        // dropped from the cell's text, as upstream drops overflow).
        let p = parser(1, 10, &["\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}X"]);
        assert_eq!(p.screen().cursor_position(), (0, 3), "family of four");
        assert!(row(&p, 0).starts_with("|1f468 200d 1f469 200d 1f467W|>|58"), "{}", row(&p, 0));
        let p = parser(1, 10, &["\u{1f469}\u{200d}\u{2764}\u{fe0f}\u{200d}\u{1f48b}\u{200d}\u{1f468}X"]);
        assert_eq!(p.screen().cursor_position(), (0, 3), "kiss");
        assert!(row(&p, 0).ends_with("W|>|58|||||||"), "{}", row(&p, 0));
        // The flag of England: a base and six tags (28 bytes); xterm.js keeps
        // them all, the cell keeps what fits — the same two columns.
        let p = parser(1, 10, &["\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}X"]);
        assert_eq!(p.screen().cursor_position(), (0, 3), "england");
        assert!(row(&p, 0).starts_with("|1f3f4 e0067") && row(&p, 0).ends_with("W|>|58|||||||"), "{}", row(&p, 0));
    }

    #[test]
    fn after_a_zwj_only_a_pictograph_joins() {
        check("emoji zwj CJK", 1, 10, &["\u{1f468}\u{200d}\u{4e2d}X"], (0, 5), &["|1f468 200dW|>|4e2dW|>|58|||||"]);
        check("emoji zwj box", 1, 10, &["\u{1f468}\u{200d}\u{2500}X"], (0, 4), &["|1f468 200dW|>|2500|58||||||"]);
        check("a zwj emoji", 1, 10, &["a\u{200d}\u{1f469}X"], (0, 3), &["|61 200d 1f469W|>|58|||||||"]);
        check("eye no vs16", 1, 10, &["\u{1f441}\u{200d}\u{1f5e8}X"], (0, 2), &["|1f441 200d 1f5e8|58||||||||"]);
        check("heart zwj fire", 1, 10, &["\u{2764}\u{200d}\u{1f525}X"], (0, 3), &["|2764 200d 1f525W|>|58|||||||"]);
    }

    #[test]
    fn a_space_is_a_cluster_too() {
        check("skin after space", 1, 10, &[" \u{1f3fd}X"], (0, 3), &["|20 1f3fdW|>|58|||||||"]);
        check("vs16 after space", 1, 10, &[" \u{fe0f}X"], (0, 3), &["|20 fe0fW|>|58|||||||"]);
    }

    #[test]
    fn anything_but_a_printed_character_ends_the_cluster() {
        // SGR, a cursor move, BS, CR: the VS16 after it is a two-column cell
        // of its own, as xterm.js draws it.
        check("vs16 after SGR", 1, 10, &["\u{26a0}\x1b[31m\u{fe0f}X"], (0, 4), &["|26a0|fe0fW|>|58||||||"]);
        check("vs16 after CUP", 1, 10, &["\u{26a0}ab\x1b[1;3H\u{fe0f}"], (0, 4), &["|26a0|61|fe0fW|>||||||"]);
        check("BS then vs16", 1, 10, &["\u{26a0}a\x08\u{fe0f}X"], (0, 4), &["|26a0|fe0fW|>|58||||||"]);
        check("vs16 after CR", 2, 10, &["ab\r\u{fe0f}X"], (0, 3), &["|fe0fW|>|58|||||||", "||||||||||"]);
        // The alternate screen in between, and a character the parser hands
        // to the callbacks (U+FFFD): a new cluster too.
        let p = parser(2, 10, &["\u{26a0}\x1b[?1049h\u{fe0f}X"]);
        assert!(p.screen().alternate_screen());
        assert_eq!(row(&p, 0), "|fe0fW|>|58|||||||");
        check("vs16 after U+FFFD", 1, 10, &["\u{26a0}\u{fffd}\u{fe0f}X"], (0, 4), &["|26a0|fe0fW|>|58||||||"]);
        // A resize in between.
        let mut p = parser(2, 10, &["\u{26a0}"]);
        p.screen_mut().set_size(2, 12);
        p.process("\u{fe0f}X".as_bytes());
        assert_eq!(row(&p, 0), "|26a0|fe0fW|>|58||||||||");
    }

    #[test]
    fn a_vs16_after_cr_or_a_move_on_a_wrapped_row_is_its_own_cell() {
        // Cells and cursor as xterm.js (which marks the continued row where
        // vt100 marks the one it continues: their conventions).
        check("vs16 after CR on wrapped row", 3, 5, &["abcde\u{26a0}Q\r\u{fe0f}"], (1, 2),
            &["|61|62|63|64|65", "|fe0fW|>|||", "|||||"]);
        check("vs16 CUP col1 after wrapped row", 3, 5, &["abcdeFGHI\x1b[2;1H\u{fe0f}"], (1, 2),
            &["|61|62|63|64|65", "|fe0fW|>|48|49|", "|||||"]);
    }

    /// Known gap (VENDORED.md): a spacing mark (`GB9a`, Devanagari's ा) is a
    /// cell of its own here; xterm.js joins it (one cell, cursor at 2).
    #[test]
    fn known_gap_a_spacing_mark_is_its_own_cell() {
        check("devanagari", 1, 10, &["\u{915}\u{93e}X"], (0, 3), &["|915|93e|58|||||||"]);
    }

    #[test]
    fn flags_keycaps_vs15_and_split_writes() {
        check("3 RI", 1, 10, &["\u{1f1ee}\u{1f1f9}\u{1f1eb}X"], (0, 4), &["|1f1ee 1f1f9W|>|1f1eb|58||||||"]);
        check("vs15", 1, 10, &["\u{26a0}\u{fe0e}X"], (0, 2), &["|26a0 fe0e|58||||||||"]);
        check("keycap", 1, 10, &["1\u{fe0f}\u{20e3}X"], (0, 3), &["|31 fe0f 20e3W|>|58|||||||"]);
        check("vs16 split writes", 1, 10, &["\u{26a0}", "\u{fe0f}", "X"], (0, 3), &["|26a0 fe0fW|>|58|||||||"]);
        check("zwj split writes", 1, 10, &["\u{1f468}\u{200d}", "\u{1f469}\u{200d}", "\u{1f467}X"], (0, 3),
            &["|1f468 200d 1f469 200d 1f467W|>|58|||||||"]);
    }

    #[test]
    fn widening_in_the_last_column_wraps_the_cluster() {
        // xterm.js: the row above keeps a blank last column, the cluster
        // starts the next row, which is marked wrapped.
        check("wrap end", 3, 5, &["abcd\u{26a0}", "\u{fe0f}X"], (1, 3), &["|61|62|63|64|", "|26a0 fe0fW|>|58||", "|||||"]);
        let p = parser(3, 5, &["abcd\u{26a0}\u{fe0f}X"]);
        assert!(p.screen().row_wrapped(0));
    }

    #[test]
    fn widening_into_the_last_column_leaves_the_wrap_pending() {
        check("into the last column", 3, 5, &["abc\u{26a0}\u{fe0f}"], (0, 5), &["|61|62|63|26a0 fe0fW|>"]);
        check("then the next character wraps", 3, 5, &["abc\u{26a0}\u{fe0f}Z"], (1, 1), &["|61|62|63|26a0 fe0fW|>", "|5a||||"]);
    }

    #[test]
    fn a_wide_character_in_the_column_taken_goes_with_it() {
        // 中 at columns 2–3 of a 4-column row, then ⚠ at column 1 widened:
        // 中's half in the last column is cleared and the row is no longer
        // marked wrapped (upstream's rule for writing over a wide char).
        let before = parser(2, 4, &["  \u{4e2d}X"]);
        assert!(before.screen().row_wrapped(0), "X wrapped the row");
        let p = parser(2, 4, &["  \u{4e2d}X", "\u{1b}[1;2H\u{26a0}\u{fe0f}"]);
        assert_eq!(row(&p, 0), "|20|26a0 fe0fW|>|");
        assert!(!p.screen().row_wrapped(0));
        assert_eq!(p.screen().cursor_position(), (0, 3));
    }

    #[test]
    fn the_formatted_replay_is_the_same_screen() {
        let live = "\u{256d}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{256e}\r\n\u{2502}\u{26a0}\u{fe0f}X       \u{2502}\r\n\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{256f}\u{1b}[2;12H\u{2502}";
        let p = parser(4, 12, &[live]);
        assert_eq!(p.screen().rows(0, 12).nth(1).unwrap(), "\u{2502}\u{26a0}\u{fe0f}X       \u{2502}");
        let mut replay = crate::Parser::new(4, 12, 0);
        replay.process(&p.screen().state_formatted());
        assert_eq!(replay.screen().rows(0, 12).collect::<Vec<_>>(), p.screen().rows(0, 12).collect::<Vec<_>>());
    }

    #[test]
    fn a_one_column_screen_keeps_upstreams_handling() {
        // No room for two columns: a lone VS16 and a widening VS16 are
        // appended, never a panic.
        let p = parser(2, 1, &["\u{fe0f}", "a\u{fe0f}"]);
        assert_eq!(p.screen().size(), (2, 1));
    }

    #[test]
    fn plain_text_combining_marks_box_drawing_and_cjk_are_unchanged() {
        check("plain", 1, 10, &["e\u{301}\u{2500}\u{2502}\u{4e2d}\u{23fa}\u{276f}"], (0, 7), &["|65 301|2500|2502|4e2dW|>|23fa|276f|||"]);
    }
}
