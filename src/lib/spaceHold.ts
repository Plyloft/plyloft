// #47 dictation: the hold-Space state machine, shared by the Codex TUI,
// codex-chat and shell tiles. Pure — the controller (dictationController)
// owns the timer, the microphone and the IPC, and performs the effects this
// returns in order.
//
// Mirrors Claude Code's hold mode: Space held ≥ HOLD_MS with no modifier
// while the prompt is idle records; a shorter tap is an ordinary space, sent
// on key-up; auto-repeat is swallowed while held; Esc cancels. Claude tiles
// never get here (`dictationModeFor`), and a prompt that is not idle keeps
// Space as a normal key from the first keydown.

import type { TileKind } from "../store/tileStore";

export const HOLD_MS = 250;

/** Where the transcription goes: a bracketed paste into the Codex TUI, the
 *  codex-chat composer, or a plain write to a shell. */
export type DictationMode = "codex-tui" | "codex-chat" | "shell";

/** Claude tiles have Claude Code's own `/voice`; agent runs have no prompt. */
export function dictationModeFor(kind: TileKind): DictationMode | null {
  switch (kind) {
    case "codex":
      return "codex-tui";
    case "codex-chat":
      return "codex-chat";
    case "shell":
      return "shell";
    default:
      return null;
  }
}

/** GH #67: the toast title when the transcript was refused — naming the gate
 *  that refused it, so the Codex composer matcher and the shell's prompt
 *  check are told apart. */
export function refusedTranscriptTitle(mode: DictationMode): string {
  switch (mode) {
    case "codex-tui":
      return "Transcript not inserted — the composer was not idle";
    case "shell":
      return "Transcript not inserted — the shell is not at its prompt";
    case "codex-chat":
      return "Transcript not inserted — the composer is unavailable";
  }
}

export type HoldPhase ="idle" | "pending" | "recording" | "transcribing";

export interface HoldKey {
  type: "keydown" | "keyup";
  key: string;
  repeat: boolean;
  /** Shift, Ctrl, Alt or Meta held. */
  modifiers: boolean;
  /** Mid-IME composition: never ours. */
  composing?: boolean;
}

export type HoldEvent =
  /** `idle` is asked only when a fresh Space would start a hold, so reading
   *  a terminal buffer costs nothing on every other key. */
  | { type: "key"; key: HoldKey; idle: () => boolean }
  | { type: "hold-elapsed" }
  /** Recording reached its cap: stop and transcribe what there is. */
  | { type: "max-duration" }
  /** Focus left the prompt. */
  | { type: "blur" }
  /** The recorder could not start, or the transcription settled. */
  | { type: "settled" };

export type HoldEffect =
  | "arm-timer"
  | "disarm-timer"
  | "emit-space"
  | "start-recording"
  | "stop-recording"
  | "cancel-recording"
  | "cancel-transcription";

export interface HoldStep {
  phase: HoldPhase;
  effects: HoldEffect[];
  /** True: the key event is Ply's — prevent its default and keep it from
   *  the terminal / textarea. False: let it through untouched. */
  consume: boolean;
}

const isSpace = (key: HoldKey) => key.key === " ";

function stay(phase: HoldPhase, consume = false): HoldStep {
  return { phase, effects: [], consume };
}

export function stepSpaceHold(phase: HoldPhase, event: HoldEvent): HoldStep {
  switch (event.type) {
    case "hold-elapsed":
      return phase === "pending"
        ? { phase: "recording", effects: ["start-recording"], consume: false }
        : stay(phase);
    case "max-duration":
      return phase === "recording"
        ? { phase: "transcribing", effects: ["stop-recording"], consume: false }
        : stay(phase);
    case "blur":
      if (phase === "pending") return { phase: "idle", effects: ["disarm-timer"], consume: false };
      if (phase === "recording") {
        return { phase: "idle", effects: ["cancel-recording"], consume: false };
      }
      // A transcription already under way still lands in its own prompt.
      return stay(phase);
    case "settled":
      return phase === "recording" || phase === "transcribing" ? stay("idle") : stay(phase);
    case "key":
      return stepKey(phase, event.key, event.idle);
  }
}

function stepKey(phase: HoldPhase, key: HoldKey, idle: () => boolean): HoldStep {
  if (key.composing) return stay(phase);
  const down = key.type === "keydown";
  switch (phase) {
    case "idle": {
      // A repeat with no hold of ours behind it (focus arrived mid-press, or
      // the prompt was busy at the first keydown) stays an ordinary key.
      if (down && isSpace(key) && !key.modifiers && !key.repeat && idle()) {
        return { phase: "pending", effects: ["arm-timer"], consume: true };
      }
      return stay("idle");
    }
    case "pending": {
      if (isSpace(key)) {
        if (down) return stay("pending", true); // auto-repeat while deciding
        return { phase: "idle", effects: ["disarm-timer", "emit-space"], consume: true };
      }
      if (down) {
        // Rollover typing ("a b" with Space still down when b lands): the
        // space is a tap, and it must reach the prompt before the next key.
        return { phase: "idle", effects: ["disarm-timer", "emit-space"], consume: false };
      }
      return stay("pending");
    }
    case "recording": {
      if (isSpace(key)) {
        if (down) return stay("recording", true);
        return { phase: "transcribing", effects: ["stop-recording"], consume: true };
      }
      if (down && key.key === "Escape") {
        return { phase: "idle", effects: ["cancel-recording"], consume: true };
      }
      return stay("recording");
    }
    case "transcribing": {
      if (down && key.key === "Escape") {
        return { phase: "idle", effects: ["cancel-transcription"], consume: true };
      }
      return stay("transcribing");
    }
  }
}
