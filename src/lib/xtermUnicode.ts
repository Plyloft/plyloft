// 1.168.1 (walk #13): wide emoji take two cells, as the TUIs drawing into a
// tile assume. xterm measures with Unicode 6 by default, where wide emoji
// such as 👋 (U+1F44B) are one cell; Claude Code and Codex measure it as two
// (string-width / unicode-width), so the next word was drawn over the
// emoji's right half ("👋What") and the rest of the row moved one cell left.
//
// 1.169.0 (B1): xterm 6 and the unicode-graphemes addon. Widths go by
// grapheme cluster (Unicode 15), as the TUIs measure them: an emoji made wide
// by a variation selector (⚠️ = U+26A0 U+FE0F, ❤️) is two cells, not one, and
// a ZWJ sequence (👨‍👩‍👧), a flag (🇮🇹) or a skin tone (👍🏽) is one two-cell
// character. Box drawing, block elements, braille spinners and the TUIs'
// ● ⏺ ❯ ✻ stay one cell, so the TUI layout is unchanged. Unicode 11 stays
// registered as the fallback: should the graphemes addon not load, the tile
// keeps 1.168.1's widths. Terminal rendering only: no PTY is touched.
// Windows: the system ConPTY (inbox conhost) measures widths itself, one
// cell per UTF-16 code unit as measured: it agrees on 👋 and VS16 emoji, not
// on ZWJ sequences or flags — nor on skin tones (👍🏽), which agreed under
// 1.168.1's Unicode 11 widths (4 = 4) and now differ (2 vs 4): the trade for
// VS16, accepted by the owner. 1.169.0 (B2): the ConPTY Plyloft ships
// (OpenConsole) sizes by grapheme cluster and agrees on all of them; the
// system one is only the fallback. `xtermWideChars.test.tsx` pins both.
import type { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";

/** What a tile's xterm needs for `installWideChars`: `term.unicode` is
 *  still a proposed API in xterm 6 and throws without it. */
export const WIDE_CHAR_OPTIONS = { allowProposedApi: true } as const;

/** The width table every tile uses (the graphemes addon's). */
export const GRAPHEME_WIDTHS = "15-graphemes";
/** The fallback when the graphemes addon cannot load (1.168.1's widths). */
export const FALLBACK_WIDTHS = "11";

/** Switch `term` to grapheme-cluster widths, falling back to Unicode 11.
 *  The one setup every xterm in the app goes through, so tiles cannot
 *  drift apart. False (and xterm's default widths) when the terminal was
 *  made without `allowProposedApi`. */
export function installWideChars(term: Terminal): boolean {
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = FALLBACK_WIDTHS;
  } catch {
    return false;
  }
  try {
    // Registers "15" and "15-graphemes" and activates the latter.
    term.loadAddon(new UnicodeGraphemesAddon());
  } catch {
    term.unicode.activeVersion = FALLBACK_WIDTHS;
  }
  return true;
}
