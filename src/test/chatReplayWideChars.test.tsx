// 1.169.0 (B4): a card chat's "Show terminal" first paints from the
// backend's emulated grid (src-tauri/src/chat_screen.rs, `state_formatted()`),
// then follows the live stream. Upstream vt100 0.16.2 sized a VS16 emoji
// (⚠️) as one cell where the tile's xterm (installWideChars: grapheme widths)
// and Claude Code size it as two: whenever Claude then placed something by
// absolute position — here its box's right edge at column 12 — the grid put
// it one cell further left, and the replay drew the row one cell too wide
// (B1 Challenger, finding 2). The vendored vt100 (src-tauri/crates/vt100,
// VENDORED.md) sizes by grapheme cluster: the replay is the live screen.
// LIVE and REPLAY come from the crate itself: `fixtures/chatReplayVs16.json`
// is the vendored vt100's `state_formatted()` for LIVE on a 4×12 grid,
// checked by chat_screen::tests::the_replay_fixture_is_vt100s_own_output,
// so a change in the backend's replay fails a test there.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";
import fixture from "./fixtures/chatReplayVs16.json";

const LIVE = fixture.live;
const REPLAY = fixture.replay;
// Upstream vt100 0.16.2, before B4 (its real output then, kept as the
// before): the edge drawn at column 12 landed beside the one Claude wrote
// at its column 12.
const REPLAY_UPSTREAM = "\u001b[?25h\u001b[m\u001b[H\u001b[J╭──────────╮\r\n│⚠️X       ││\r\n╰──────────╯\u001b[2;12H│";

async function screen(data: string): Promise<string[]> {
  const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: fixture.cols, rows: fixture.rows });
  installWideChars(term);
  await new Promise<void>((r) => term.write(data, r));
  const rows = [0, 1, 2, 3].map((y) => term.buffer.active.getLine(y)!.translateToString(true));
  term.dispose();
  return rows;
}

describe("a card chat's replayed screen with a VS16 emoji", () => {
  it("live: the box row is 12 cells, its edge at column 12", async () => {
    expect(await screen(LIVE)).toEqual(["╭──────────╮", "│⚠️X       │", "╰──────────╯", ""]);
  });

  it("the replay is the live screen", async () => {
    expect(await screen(REPLAY)).toEqual(await screen(LIVE));
  });

  it("before B4 (upstream vt100), the replay's row was one cell too wide and wrapped its edge", async () => {
    expect(await screen(REPLAY_UPSTREAM)).toEqual(["╭──────────╮", "│⚠️X       │", "│", "╰──────────╯"]);
  });
});
