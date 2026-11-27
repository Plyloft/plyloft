// GH #68: a shell tile whose line editor has no bracketed paste (macOS
// /bin/bash 3.2) never offers dictation — Space stays an ordinary key from the
// first keydown, so a held Space used to do nothing at all. This watches for
// that hold without taking a single key from the shell, and says why once per
// session. Pure, like spaceHold: the controller supplies the timer and the
// toast.

import {
  HOLD_MS,
  stepSpaceHold,
  type HoldKey,
  type HoldPhase,
  type HoldStep,
} from "./spaceHold.ts";

export interface HintTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** Shared by every tile: the toast shows once per app session, not per tile. */
export interface HintSession {
  shown: boolean;
}

export const noPasteSession: HintSession = { shown: false };

export class NoPasteHint {
  private timer: unknown = null;
  private readonly show: () => void;
  private readonly timers: HintTimers;
  private readonly session: HintSession;

  constructor(show: () => void, timers: HintTimers, session: HintSession = noPasteSession) {
    this.show = show;
    this.timers = timers;
    this.session = session;
  }

  /** Feed a key event the hold machine left alone. `lacksPaste` is asked on a
   *  fresh Space only: the shell is at its prompt, but its line editor has
   *  bracketed paste off. Never consumes anything — a tap stays a tap, and a
   *  hold still types what it always typed. */
  handleKey(key: HoldKey, lacksPaste: () => boolean): void {
    if (this.session.shown || key.composing) return this.cancel();
    const isSpace = key.key === " ";
    if (key.type === "keyup") {
      if (isSpace) this.cancel();
      return;
    }
    if (!isSpace || key.modifiers) return this.cancel();
    if (key.repeat || this.timer !== null) return;
    if (!lacksPaste()) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.session.shown) return;
      this.session.shown = true;
      this.show();
    }, HOLD_MS);
  }

  /** Focus left the tile, or the tile is going away. */
  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/** One key event through the hold machine, then — only when the machine was
 *  idle and let the key through — through the hint. A prompt that can take
 *  dictation starts a hold instead, so the hint never sees it. */
export function stepKeyWithHint(
  phase: HoldPhase,
  key: HoldKey,
  idle: () => boolean,
  hint: { handle: NoPasteHint; lacksPaste: () => boolean } | null,
): HoldStep {
  const step = stepSpaceHold(phase, { type: "key", key, idle });
  if (phase === "idle" && !step.consume && hint) {
    hint.handle.handleKey(key, hint.lacksPaste);
  }
  return step;
}
