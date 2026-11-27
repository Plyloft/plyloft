// 1.177.0 Compare: a tile-keyed twin of the Builder's `writePaste`
// (`builderStore.ts`, keyed by card). Text into a Claude or Codex tile's PTY:
// the bracketed paste, then — for Send — its Enter (Codex on Windows takes
// the Enter apart, `builderInject.submitsSeparately`); for Put it in its box,
// the paste alone. Pure over its deps, so node tests it:
//
//     node --experimental-strip-types src/lib/pasteIntoTile.test.ts
//
// `guard` runs synchronously right before the first write and refuses with
// its words: nothing is written unless every guard holds right then. There
// is no hold-and-retry. The text is never logged or kept here, and an error
// names the situation, never the content.
import {
  PASTE_END,
  PASTE_START,
  composerSafe,
  codexScreenHelp,
  pasteBodyBytes,
  pasteBytes,
  plainForKeys,
  writePasteThenSubmit,
} from "./builderInject.ts";
import { notReachedWords, reachedNotSentWords, type CompareVendor } from "./compareWords.ts";
import type { TileScreenNow } from "./tileScreen.ts";

export interface PasteTileDeps {
  write(bytes: Uint8Array): Promise<void>;
  /** The tile's screen now (`lib/tileScreen`), or null. */
  screen(): TileScreenNow | null;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface PasteTileOptions {
  /** The target tile's vendor. */
  vendor: CompareVendor;
  windows: boolean;
  /** Send (paste, then Enter) or Put it in its box (the paste alone). */
  submit: boolean;
  /** Why the tile can't take text right now, or null. Read synchronously
   *  just before the first write. */
  guard(): string | null;
  /** Windows Codex Send: false before an Enter means the pass is no longer
   *  wanted (cancelled, off, the pair changed). The member's own typing in
   *  the tile since the paste is checked here as well. */
  stillWanted?(): boolean;
}

export type PasteTileResult =
  | { ok: true }
  /** A guard held it back: nothing was written. */
  | { ok: false; written: false; words: string }
  /** The first write failed: nothing reached the tile. */
  | { ok: false; written: false; words: string; failed: true }
  /** Something reached the tile's box and the rest failed. */
  | { ok: false; written: true; words: string };

const encoder = new TextEncoder();

/** Write `text` (already `comparePreparePaste`'s) into the tile's PTY. */
export async function pasteIntoTile(
  text: string,
  options: PasteTileOptions,
  deps: PasteTileDeps,
): Promise<PasteTileResult> {
  const refused = options.guard();
  if (refused) return { ok: false, written: false, words: refused };
  let wrote = false;
  let pasteStart = 0;
  const write = async (bytes: Uint8Array) => {
    await deps.write(bytes);
    wrote = true;
  };
  try {
    if (options.vendor === "codex" && options.windows) {
      // ConPTY replays a paste to Codex as keys: plain keys, and the Enter
      // once the paste settled (`writePasteThenSubmit`).
      if (!options.submit) {
        await write(pasteBodyBytes(text));
      } else {
        pasteStart = deps.now();
        await writePasteThenSubmit(text, {
          write,
          lastOutputAt: async () => deps.screen()?.lastOutputAt ?? null,
          composerHoldsPaste: () => deps.screen()?.holds(plainForKeys(text)) ?? null,
          overlayOpen: () => {
            const s = deps.screen();
            return s ? s.overlay : null;
          },
          // No Enter if the member typed into the tile since the paste began:
          // it would submit their keys with ours (ConPTY interleaves them).
          stillWanted: () => {
            const typed = deps.screen()?.lastInputAt;
            return typed !== undefined && typed <= pasteStart && (options.stillWanted?.() ?? true);
          },
          now: deps.now,
          sleep: deps.sleep,
        });
      }
    } else {
      await write(
        options.submit ? pasteBytes(text) : encoder.encode(`${PASTE_START}${composerSafe(text)}${PASTE_END}`),
      );
    }
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const help = codexScreenHelp(message, false);
    if (wrote) return { ok: false, written: true, words: help ?? reachedNotSentWords(options.vendor) };
    return { ok: false, written: false, failed: true, words: help ?? notReachedWords(options.vendor) };
  }
}
