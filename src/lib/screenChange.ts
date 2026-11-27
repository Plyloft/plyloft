/**
 * Windows walk (GH #216 group B, 2026-09-30): after Build done a Claude
 * Builder sat on "The Builder is checking its own work" for four minutes while
 * it was idle at its prompt, and the card said "last output just now".
 *
 * On ConPTY, Claude Code 2.1 (full screen, mouse and focus reporting on)
 * answers every focus change and mouse report with its terminal modes again
 * (`ESC[?2004h ESC[?1000h …`), and ConPTY repaints the whole screen on every
 * resize, even to the size it already has — measured in a ConPTY on the VM,
 * `src/test/fixtures/claudeConptyIdle.json`. Each is output to the PTY reader,
 * so every click, focus change or pointer pass over the app restarted the
 * self-check's ten seconds of silence, and the badge's.
 *
 * On Windows the Builder's terminal therefore counts output only when the
 * screen it shows changed: bytes that leave the same text on screen are no
 * activity. The Mac keeps stamping on arrival, as before.
 *
 * Pure — no Tauri import — so it is unit-tested under node.
 */
import type { ScanBuffer } from "./attention.ts";

/** The visible screen's text: the viewport rows, trailing blanks trimmed. */
export function visibleScreen(buf: ScanBuffer, viewRows: number): string {
  const rows: string[] = [];
  for (let i = buf.baseY; i < buf.baseY + viewRows; i++) {
    rows.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return rows.join("\n");
}

/**
 * Remembers the last screen seen; `changed` says whether this one differs.
 *
 * `scrolled`: the batch scrolled the buffer (xterm's `onScroll` while it was
 * parsed). Output that scrolls is output, even when the screen it leaves
 * reads as the last one did — a command printing the same line again and
 * again (`while (1) { "tick"; sleep 1 }`) fills the screen with identical
 * rows, and would otherwise read as no output and its tile as Ready. A
 * ConPTY repaint redraws the screen in place and does not scroll.
 */
export function screenChangeTracker(): {
  changed(screen: string, scrolled?: boolean): boolean;
} {
  let last: string | null = null;
  return {
    changed(screen, scrolled = false) {
      if (screen === last && !scrolled) return false;
      last = screen;
      return true;
    },
  };
}

/** Whether output is judged by what it does to the screen (Windows' ConPTY)
 *  rather than by its arrival (everywhere else, unchanged). */
export function stampsOnScreenChange(windows: boolean): boolean {
  return windows;
}

/**
 * Whether a tile's readiness scan (the header's Ready / Running) notes PTY
 * output once drawn and only when it changed the screen, rather than on
 * arrival. Windows shell tiles: PowerShell under ConPTY has no PTY probe
 * and no command blocks, so output quiet alone says the prompt is back, and
 * a ConPTY repaint that leaves the prompt as it was (a resize, a focus
 * change) must not read as a command running. Claude and Codex tiles are
 * judged by their screens and keep noting on arrival; the Mac is unchanged.
 */
export function readinessNotedOnScreenChange(
  windows: boolean,
  kind: "claude" | "codex" | "shell" | undefined,
): boolean {
  return stampsOnScreenChange(windows) && kind === "shell";
}

/**
 * Whether a drawn batch that changed the screen counts for a Windows shell
 * tile's readiness. Not inside `resizedUntil` (the app's own refit: a layout
 * change, a window resize, the renderer swap, `RESIZE_REDRAW_MS` after
 * it): xterm re-wraps a long line already on screen and ConPTY repaints it,
 * so the screen changes with no command running — the walk saw an idle
 * prompt read Running for 2 s on Single → Split. The screen tracker still
 * takes the new screen, so only what changes after the window counts.
 */
export function readinessNotesDraw(changed: boolean, now: number, resizedUntil: number): boolean {
  return changed && now >= resizedUntil;
}

/** The part of an xterm `watchContentScroll` reads. */
export interface ScrollSource {
  onScroll(listener: (viewportRow: number) => void): { dispose(): void };
  readonly buffer: { readonly active: { readonly type: string } };
}

/**
 * xterm's `onScroll`, without the event a buffer switch fires. 1.169.0 (B1):
 * xterm 6 also fires `onScroll` when a program enters or leaves the
 * alternate screen (`ESC[?1049h` / `l`), which xterm 5 did not; that is no
 * output scrolling. A switch is told apart by the active buffer differing
 * from the one the last event (or the start) saw — every switch fires one
 * event, so the remembered buffer stays in step. The switch still changes
 * the screen, so the screen comparison counts it as output where it is.
 */
export function watchContentScroll(
  term: ScrollSource,
  listener: (viewportRow: number) => void,
): { dispose(): void } {
  let buffer = term.buffer.active.type;
  return term.onScroll((viewportRow) => {
    const now = term.buffer.active.type;
    const switched = now !== buffer;
    buffer = now;
    if (!switched) listener(viewportRow);
  });
}
