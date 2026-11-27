// v0.10.0 Command Blocks: the OSC 133 marks a shell tile's shell prints, read
// into one block per command (prompt → run → exit). Moved out of Terminal.tsx
// so a recorded byte stream (zsh, bash, PowerShell) can be fed through the
// same handler in a test.
//
// OSC 133 payload kinds (after the "133;" prefix):
//   A — start of prompt
//   B — end of prompt / start of input
//   C — start of command output (the user pressed Enter)
//   D;<exit_code> — command finished
//
// Only C and D make a block: C opens one and anchors an `IMarker` to the
// command's output row; D closes it with a 1-cell decoration on that row,
// green or red by exit code, drawn in the shell tile's left gutter (the
// `.terminal-pane.is-shell .xterm` padding, terminals.css) so it never covers
// the row's first character. A anchors a marker to the prompt, which the next
// C takes as the block's `promptMarker` (Recent commands jumps there, so the
// command line shows above its output); B is accepted and ignored, and a D
// with no open block (the first prompt, an empty Enter) does nothing.
import type { IDecoration, IMarker, ITerminalOptions, ITheme, Terminal } from "@xterm/xterm";
import { textSizeOf } from "./textSize.ts";

/** The options a shell tile's xterm is made with (`Terminal.tsx`), here so
 *  the tests build the very same terminal. `allowProposedApi` is what the D
 *  mark's gutter decoration needs: `registerDecoration` is a proposed API
 *  (xterm 5 and 6) and throws without it (the 2026-10-19 Windows walk: no block was
 *  ever added, and the throw stopped the tile's output). */
export function shellTileTerminalOptions(
  theme: ITheme,
  scrollback = 5000,
  // QoL 1.168 (block 10, A7): Settings › Terminal text size and Screen
  // reader support (`lib/textSize`).
  { textSize = 13, screenReader = false }: { textSize?: unknown; screenReader?: boolean } = {},
): ITerminalOptions {
  return {
    fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
    fontSize: textSizeOf(textSize),
    screenReaderMode: screenReader,
    cursorBlink: true,
    // QoL 1.168 (D3): Settings › Terminals › Scrollback.
    scrollback: terminalScrollback(scrollback),
    theme,
    allowProposedApi: true,
  };
}

/** Settings › Scrollback as xterm takes it: a whole number of lines, 500 to
 *  100,000 (what the field writes); anything else is the shipped 5000. */
export function terminalScrollback(lines: unknown): number {
  const n = typeof lines === "number" ? lines : Number.NaN;
  if (!Number.isFinite(n)) return 5000;
  return Math.max(500, Math.min(100_000, Math.round(n)));
}

export type CommandBlock = {
  id: number;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  marker: IMarker | null;
  /** The row the block's prompt started on (its A), if one was seen. */
  promptMarker: IMarker | null;
  decoration: IDecoration | null;
};

function disposeMarker(m: IMarker | null | undefined) {
  try {
    m?.dispose();
  } catch {
    // ignore
  }
}

export function disposeBlock(b: CommandBlock) {
  try {
    b.decoration?.dispose();
  } catch {
    // ignore
  }
  disposeMarker(b.marker);
  disposeMarker(b.promptMarker);
}

/** The buffer line Recent commands scrolls to for `b`: its prompt's row (A),
 *  so the command line shows above the output, else the row above the
 *  output (a shell that prints no A). Never so high that the output's first
 *  row would fall below a viewport of `rows`. Null when the block left the
 *  scrollback. */
export function blockScrollLine(b: CommandBlock, rows: number): number | null {
  if (!b.marker || b.marker.isDisposed) return null;
  const output = b.marker.line;
  const prompt =
    b.promptMarker && !b.promptMarker.isDisposed && b.promptMarker.line <= output
      ? b.promptMarker.line
      : output - 1;
  return Math.max(0, prompt, output - Math.max(1, rows) + 1);
}

export type CommandBlockTracker = {
  /** The command still running, if a C has had no D yet. */
  open(): CommandBlock | null;
  dispose(): void;
};

/** Registers the OSC 133 handler on `term`; `onClosed` gets each finished
 *  command. `now` is the clock (a test's own). */
export function trackCommandBlocks(
  term: Pick<Terminal, "parser" | "registerMarker" | "registerDecoration">,
  onClosed: (block: CommandBlock) => void,
  now: () => number = Date.now,
): CommandBlockTracker {
  let nextBlockId = 1;
  let openBlock: CommandBlock | null = null;
  // The last prompt's A, until a C takes it (or the next A replaces it).
  let pendingPrompt: IMarker | null = null;
  // v1.20.5: belt-and-braces guard against an OSC 133 `C` flood (e.g.
  // a pathological dotfile, a future codex/JSONL byte burst). Coalesce
  // any `C` that arrives within 10ms of the previous `C` (no `D` in
  // between) — that's flood behavior, not real command boundaries.
  let lastCAt: number | null = null;
  const handle = (data: string) => {
    const kind = data.split(";")[0];
    if (kind === "A") {
      disposeMarker(pendingPrompt);
      pendingPrompt = term.registerMarker(0) ?? null;
    } else if (kind === "C") {
      const at = now();
      if (lastCAt != null && at - lastCAt < 10) {
        return;
      }
      lastCAt = at;
      // If a prior `C` never got its matching `D`, dispose its marker
      // before we overwrite the slot — otherwise the IMarker leaks.
      if (openBlock) {
        disposeMarker(openBlock.marker);
        disposeMarker(openBlock.promptMarker);
      }
      const marker = term.registerMarker(0) ?? null;
      const promptMarker = pendingPrompt;
      pendingPrompt = null;
      openBlock = {
        id: nextBlockId++,
        startedAt: at,
        endedAt: null,
        exitCode: null,
        marker,
        promptMarker,
        decoration: null,
      };
    } else if (kind === "D") {
      lastCAt = null;
      if (openBlock) {
        const codeStr = data.split(";")[1];
        const exitCode = codeStr != null && codeStr !== "" ? Number(codeStr) : null;
        const success = exitCode === 0;
        let decoration: IDecoration | null = null;
        if (openBlock.marker && !openBlock.marker.isDisposed) {
          // The gutter mark is extra: if it can't be drawn, the block still
          // closes (and the tile's output goes on). x 0, width 1 is only
          // where xterm puts the element; `.command-block-marker` moves it
          // left of column 0 into the gutter and sizes it to the gutter.
          try {
            decoration =
              term.registerDecoration({
                marker: openBlock.marker,
                layer: "top",
                x: 0,
                width: 1,
              }) ?? null;
            decoration?.onRender((el) => {
              el.classList.add("command-block-marker");
              el.classList.add(success ? "ok" : "fail");
              // 1.174.0 (A7, P32): an 8 px mark drawn by the CSS — a filled
              // dot when it passed, an empty ring when it failed; the title
              // and the label say which.
              el.textContent = "";
              el.title = success ? "Command succeeded" : `Command exited ${exitCode ?? "?"}`;
              el.setAttribute("aria-label", el.title);
            });
          } catch (error) {
            console.error("command blocks: the gutter mark couldn't be drawn", error);
            decoration = null;
          }
        }
        const closed: CommandBlock = {
          ...openBlock,
          endedAt: now(),
          exitCode: Number.isNaN(exitCode) ? null : exitCode,
          decoration,
        };
        openBlock = null;
        onClosed(closed);
      }
    }
  };
  const handler = term.parser.registerOscHandler(133, (data: string) => {
    // A throw here would stop xterm's parser mid-write: the tile would show
    // nothing more, not even its prompt. Whatever goes wrong, log it and
    // keep the stream going.
    try {
      handle(data);
    } catch (error) {
      console.error("command blocks: an OSC 133 mark couldn't be read", error);
    }
    // Return true to mark the OSC as handled (don't try to render it).
    return true;
  });
  return {
    open: () => openBlock,
    dispose: () => {
      handler.dispose();
      disposeMarker(pendingPrompt);
      pendingPrompt = null;
    },
  };
}
