// #47 dictation: one controller per Codex / shell tile. It feeds key events
// through the pure hold-Space machine (spaceHold) and performs its effects —
// the hold timer, the microphone, the transcription IPC — then hands the
// text to the tile's own insertion path. Nothing here ever sends Enter.

import {
  dictationCancel,
  dictationStatus,
  dictationTranscribe,
  isDictationError,
  microphoneOpenSettings,
} from "../ipc";
import { useSettings } from "../store/settingsStore";
import { useTiles } from "../store/tileStore";
import { pushToast } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { MicrophoneError, startRecording, type Recording } from "./dictationRecorder";
import { NoPasteHint, stepKeyWithHint } from "./noPasteHint";
import { installCommand, isWindows } from "./platform";
import {
  HOLD_MS,
  refusedTranscriptTitle,
  stepSpaceHold,
  type DictationMode,
  type HoldEvent,
  type HoldPhase,
  type HoldStep,
} from "./spaceHold";
import { pushErrorToast } from "./errorToast";

/** Long enough for a paragraph; a stuck key cannot record for ever. */
const MAX_RECORDING_MS = 120_000;
/** A hold released before anything was said: nothing to transcribe. */
const MIN_AUDIO_SECONDS = 0.3;

export interface DictationHost {
  tileId: string;
  mode: DictationMode;
  /** The tile's prompt is waiting for input. Asked on a fresh Space only. */
  isIdle: () => boolean;
  /** A tap: one ordinary space, through the tile's normal input path. */
  emitSpace: () => void;
  /** The transcription, inserted into the prompt — never followed by Enter. */
  insertText: (text: string) => void;
  /** Asked again just before `insertText`, seconds after the hold began: the
   *  prompt may have given way to a program that would take the text as
   *  keystrokes. False keeps the transcript for the user instead; the host
   *  logs what it judged before answering false. */
  canInsert: () => boolean | Promise<boolean>;
  /** GH #68, shell tiles: the shell is at its prompt but its line editor has
   *  no bracketed paste, so `isIdle` never holds. A held Space then explains
   *  why, once per session, instead of doing nothing. */
  lacksBracketedPaste?: () => boolean;
}

/** The one microphone: a second tile cannot start while another records. */
let recordingOwner: DictationController | null = null;

const openDiagnostics = () => useUi.getState().openSettingsSection("diagnostics");
const openTileShell = () => useUi.getState().openSettingsSection("terminals-shell");
const openDictationSettings = () => useUi.getState().openSettingsSection("dictation");

/** GH #68. The doctor row "Dictation in shell tiles" gives the same advice
 *  (`doctor::dictation_shell_status`). */
export function toastNoBracketedPaste(): void {
  const install = installCommand("bash");
  pushToast({
    kind: "warn",
    // G2 walk (DS7): the Diagnostics row's plain words.
    title: "Dictation can't type into this shell",
    body: install
      ? `macOS /bin/bash 3.2 can't take dictation: switch the tile shell to zsh in Settings › Look and feel › Editor and terminals, or install bash 5 (${install}).`
      : "This tile's shell can't take dictation: switch the tile shell to PowerShell 7 in Settings › Look and feel › Editor and terminals.",
    ...(install ? { copyText: install } : {}),
    action: { label: "Open Shell settings", onClick: openTileShell },
  });
}

export function toastWhisperMissing(): void {
  const install = installCommand("whisper");
  // 1.176.2 (E1, A3-03): the Doctor is gone (1.176.0); the page that says
  // where the program stands is Dictation.
  if (!install) {
    // No one-line install here.
    pushToast({
      kind: "error",
      title: "Dictation needs one more program",
      body: "Dictation in Codex and shell tiles isn't available on Windows yet: Plyloft can't install the program it needs there.",
    });
    return;
  }
  pushToast({
    kind: "error",
    title: "Dictation needs one more program",
    // The Dictation page's whisper.cpp row sends on to Diagnostics, so go there.
    body: "whisper.cpp, the program that turns speech into text, isn't installed. Diagnostics installs it in one step; then hold Space again.",
    copyText: install,
    action: { label: "Open Diagnostics", onClick: openDiagnostics },
  });
}

export function toastModelMissing(model: string): void {
  pushToast({
    kind: "error",
    title: "Dictation needs a Whisper model",
    body: `Download the ${model} model in Settings › Look and feel › Dictation.`,
    action: { label: "Open Dictation settings", onClick: openDictationSettings },
  });
}

function toastMicrophone(error: MicrophoneError): void {
  if (error.reason === "denied") {
    const system = isWindows() ? "Windows Settings" : "System Settings";
    pushToast({
      kind: "error",
      title: "Plyloft can't use the microphone",
      body: isWindows()
        ? "In Windows Settings, open Privacy & security › Microphone and turn on Microphone access and Let desktop apps access your microphone, then hold Space again."
        : "In System Settings, open Privacy & Security › Microphone and allow Plyloft, then hold Space again.",
      action: { label: `Open ${system}`, onClick: () => void microphoneOpenSettings().catch(() => {}) },
    });
    return;
  }
  pushErrorToast("Couldn't start the microphone", error);
}

/** The prompt stopped being a prompt while whisper worked: never type the
 *  text into whatever holds the terminal now. Keep it where the user can
 *  paste it. The host logs what it judged; the title names its gate. */
function keepTranscript(text: string, mode: DictationMode): void {
  // 1.176.2 (E1, S-13): "Copied" only when it was; else the words themselves.
  const copying = navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  );
  void Promise.resolve(copying ?? false).then((copied) =>
    pushToast({
      kind: "warn",
      title: refusedTranscriptTitle(mode),
      body: copied
        ? `Copied to the clipboard: “${text}”`
        : `Plyloft couldn't copy it. Here is what you said: “${text}”`,
      copyText: text,
    }),
  );
}

export class DictationController {
  private phase: HoldPhase = "idle";
  private holdTimer: number | null = null;
  private capTimer: number | null = null;
  private recording: Promise<Recording | null> | null = null;
  private requestId: string | null = null;
  /** Bumped by every cancel, so a late result from an abandoned recording
   *  or transcription is dropped instead of inserted. */
  private generation = 0;
  private disposed = false;
  private readonly host: DictationHost;
  private readonly noPasteHint: NoPasteHint | null;

  constructor(host: DictationHost) {
    this.host = host;
    this.noPasteHint = host.lacksBracketedPaste
      ? new NoPasteHint(toastNoBracketedPaste, {
          set: (fn, ms) => window.setTimeout(fn, ms),
          clear: (handle) => window.clearTimeout(handle as number),
        })
      : null;
  }

  /** Feed a keydown / keyup. True when the event is Ply's: the caller
   *  prevents its default and keeps it from the terminal or textarea. */
  handleKey(event: KeyboardEvent): boolean {
    if (this.disposed || (event.type !== "keydown" && event.type !== "keyup")) {
      return false;
    }
    if (this.phase === "idle" && !useSettings.getState().settings.behavior.dictation.enabled) {
      return false;
    }
    const lacksPaste = this.host.lacksBracketedPaste;
    const step = stepKeyWithHint(
      this.phase,
      {
        type: event.type,
        key: event.key,
        repeat: event.repeat,
        modifiers: event.shiftKey || event.ctrlKey || event.altKey || event.metaKey,
        composing: event.isComposing,
      },
      () => (recordingOwner === null || recordingOwner === this) && this.host.isIdle(),
      this.noPasteHint && lacksPaste ? { handle: this.noPasteHint, lacksPaste } : null,
    );
    this.apply(step);
    return step.consume;
  }

  /** The prompt lost focus. */
  blur(): void {
    this.noPasteHint?.cancel();
    this.dispatch({ type: "blur" });
  }

  /** The tile is going away: stop everything, insert nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.noPasteHint?.cancel();
    this.abortRecording();
    this.abortTranscription();
    this.clearHoldTimer();
    this.phase = "idle";
    this.publish();
    this.disposed = true;
  }

  private dispatch(event: HoldEvent): void {
    if (this.disposed) return;
    this.apply(stepSpaceHold(this.phase, event));
  }

  private apply(step: HoldStep): void {
    const before = this.phase;
    this.phase = step.phase;
    for (const effect of step.effects) {
      switch (effect) {
        case "arm-timer":
          this.clearHoldTimer();
          this.holdTimer = window.setTimeout(() => {
            this.holdTimer = null;
            this.dispatch({ type: "hold-elapsed" });
          }, HOLD_MS);
          break;
        case "disarm-timer":
          this.clearHoldTimer();
          break;
        case "emit-space":
          this.host.emitSpace();
          break;
        case "start-recording":
          this.beginRecording();
          break;
        case "stop-recording":
          this.finishRecording();
          break;
        case "cancel-recording":
          this.abortRecording();
          break;
        case "cancel-transcription":
          this.abortTranscription();
          break;
      }
    }
    if (before !== this.phase) this.publish();
  }

  private publish(): void {
    const phase = this.phase === "recording" || this.phase === "transcribing" ? this.phase : null;
    useTiles.getState().setDictation(this.host.tileId, phase);
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private clearCapTimer(): void {
    if (this.capTimer !== null) window.clearTimeout(this.capTimer);
    this.capTimer = null;
  }

  private releaseMicrophone(): void {
    if (recordingOwner === this) recordingOwner = null;
  }

  private beginRecording(): void {
    const generation = ++this.generation;
    recordingOwner = this;
    this.capTimer = window.setTimeout(() => {
      this.capTimer = null;
      this.dispatch({ type: "max-duration" });
    }, MAX_RECORDING_MS);
    const recording = (async (): Promise<Recording | null> => {
      // Check before the microphone opens: a missing tool should say so
      // before the user speaks a sentence into nothing.
      const status = await dictationStatus();
      const model = useSettings.getState().settings.behavior.dictation.model;
      if (!status.whisperCli) {
        toastWhisperMissing();
        return null;
      }
      if (!status.models.find((entry) => entry.id === model)?.present) {
        toastModelMissing(model);
        return null;
      }
      const started = await startRecording();
      if (generation !== this.generation) {
        started.cancel();
        return null;
      }
      return started;
    })().catch((error: unknown) => {
      if (error instanceof MicrophoneError) toastMicrophone(error);
      else pushErrorToast("Dictation failed", error);
      return null;
    });
    this.recording = recording;
    void recording.then((started) => {
      // Could not start while Space is still held: back to idle now rather
      // than at release.
      if (!started && generation === this.generation && this.phase === "recording") {
        this.clearCapTimer();
        this.releaseMicrophone();
        this.recording = null;
        this.dispatch({ type: "settled" });
      }
    });
  }

  private finishRecording(): void {
    const generation = this.generation;
    const pending = this.recording;
    this.recording = null;
    this.clearCapTimer();
    void (async () => {
      const started = pending ? await pending : null;
      if (!started) {
        this.releaseMicrophone();
        if (generation === this.generation) this.dispatch({ type: "settled" });
        return;
      }
      const audio = await started.stop();
      this.releaseMicrophone();
      if (generation !== this.generation) return;
      if (audio.seconds < MIN_AUDIO_SECONDS) {
        this.dispatch({ type: "settled" });
        return;
      }
      const requestId = `dictation-${this.host.tileId}-${Date.now()}`;
      this.requestId = requestId;
      try {
        const text = await dictationTranscribe(audio.wav, requestId);
        if (generation !== this.generation || this.disposed) return;
        if (text) {
          const eligible = await Promise.resolve(this.host.canInsert()).catch(() => false);
          if (generation !== this.generation || this.disposed) return;
          if (eligible) this.host.insertText(text);
          else keepTranscript(text, this.host.mode);
        } else {
          pushToast({ kind: "info", title: "No speech recognized", body: "Nothing was inserted." });
        }
      } catch (error) {
        if (generation !== this.generation || this.disposed) return;
        this.toastTranscribeError(error);
      } finally {
        if (this.requestId === requestId) this.requestId = null;
        if (generation === this.generation) this.dispatch({ type: "settled" });
      }
    })();
  }

  private toastTranscribeError(error: unknown): void {
    if (!isDictationError(error)) {
      pushErrorToast("Dictation failed", error);
      return;
    }
    switch (error.kind) {
      case "cancelled":
      case "quitting":
        return;
      case "whisper-missing":
        toastWhisperMissing();
        return;
      case "model-missing":
        toastModelMissing(useSettings.getState().settings.behavior.dictation.model);
        return;
      default:
        pushErrorToast("Dictation failed", error);
    }
  }

  private abortRecording(): void {
    this.generation++;
    this.clearCapTimer();
    const pending = this.recording;
    this.recording = null;
    void pending?.then((started) => started?.cancel());
    this.releaseMicrophone();
  }

  private abortTranscription(): void {
    this.generation++;
    const requestId = this.requestId;
    this.requestId = null;
    if (requestId) void dictationCancel(requestId).catch(() => {});
  }
}
