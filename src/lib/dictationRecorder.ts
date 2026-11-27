// #47 dictation: microphone capture in the webview. getUserMedia feeds an
// AudioWorklet that forwards mono Float32 chunks; stop() resamples to 16 kHz
// and encodes the WAV in TS (wavEncoder) — no ffmpeg, no SoX. The WKWebView
// media-capture request is granted by wry; macOS's own prompt names Ply
// (NSMicrophoneUsageDescription, #46).

import {
  concatChunks,
  durationSeconds,
  encodeWav,
  resample,
} from "./wavEncoder";

const PROCESSOR = "ply-dictation-capture";

/** Runs on the audio thread. Downmixes to mono and posts ~85 ms chunks (at
 *  48 kHz), so a long recording is a few thousand messages, not a million. */
const WORKLET_SOURCE = `
class PlyDictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.flush();
        this.port.postMessage("flushed");
      }
    };
  }
  flush() {
    if (this.length > 0) {
      this.port.postMessage(this.buffer.slice(0, this.length));
      this.length = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channels = input.length;
      const frames = input[0].length;
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += input[c][i];
        this.buffer[this.length++] = sum / channels;
        if (this.length === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("${PROCESSOR}", PlyDictationCapture);
`;

let workletUrl: string | null = null;

function processorUrl(): string {
  // A blob URL works the same under the dev server and the bundled app's
  // custom scheme, where a separate worklet asset would need its own path.
  workletUrl ??= URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );
  return workletUrl;
}

export class MicrophoneError extends Error {
  readonly reason: "denied" | "unavailable";
  constructor(reason: "denied" | "unavailable", message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface RecordedAudio {
  wav: Uint8Array;
  seconds: number;
}

export interface Recording {
  /** Stop capturing and return the 16 kHz WAV. */
  stop(): Promise<RecordedAudio>;
  /** Stop capturing and discard everything. */
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.getUserMedia || typeof AudioWorkletNode === "undefined") {
    throw new MicrophoneError(
      "unavailable",
      "This window can't open the microphone (no getUserMedia / AudioWorklet).",
    );
  }
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneError("denied", "Plyloft isn't allowed to use the microphone.");
    }
    throw new MicrophoneError("unavailable", `Couldn't open the microphone: ${String(error)}`);
  }

  const context = new AudioContext();
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  try {
    await context.audioWorklet.addModule(processorUrl());
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, PROCESSOR);
    const chunks: Float32Array[] = [];
    let onFlushed: (() => void) | null = null;
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data === "flushed") onFlushed?.();
      else if (event.data instanceof Float32Array) chunks.push(event.data);
    };
    // The graph only runs when it reaches the destination; a zero gain keeps
    // the microphone out of the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    if (context.state === "suspended") await context.resume();
    const sampleRate = context.sampleRate;

    let finished = false;
    const disconnect = () => {
      finished = true;
      try {
        source.disconnect();
        node.disconnect();
        mute.disconnect();
      } catch {
        // already disconnected
      }
      node.port.onmessage = null;
      release();
    };
    return {
      async stop() {
        if (finished) return { wav: encodeWav(new Float32Array(0)), seconds: 0 };
        // The worklet holds up to one partial chunk — the last words.
        await new Promise<void>((resolve) => {
          onFlushed = resolve;
          node.port.postMessage("flush");
          window.setTimeout(resolve, 500);
        });
        disconnect();
        const samples = resample(concatChunks(chunks), sampleRate);
        return { wav: encodeWav(samples), seconds: durationSeconds(samples) };
      },
      cancel() {
        if (!finished) disconnect();
      },
    };
  } catch (error) {
    release();
    if (error instanceof MicrophoneError) throw error;
    throw new MicrophoneError("unavailable", `Couldn't start audio capture: ${String(error)}`);
  }
}
