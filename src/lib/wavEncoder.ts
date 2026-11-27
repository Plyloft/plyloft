// #47 dictation: microphone PCM → the 16 kHz mono 16-bit WAV whisper-cli
// reads. Pure (no DOM, no Tauri) so the byte contract is unit-tested; the
// AudioWorklet that produces the Float32 chunks lives in dictationRecorder.

/** whisper.cpp only accepts 16 kHz input. */
export const DICTATION_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;

/** Join the worklet's chunks into one buffer. */
export function concatChunks(chunks: readonly Float32Array[]): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Resample to `outputRate`. Downsampling averages each output sample's
 * source window — a box filter, enough to keep speech intelligible without
 * aliasing the hiss above 8 kHz into it. The rare mic slower than the target
 * is interpolated linearly.
 */
export function resample(
  input: Float32Array,
  inputRate: number,
  outputRate: number = DICTATION_SAMPLE_RATE,
): Float32Array {
  if (!(inputRate > 0) || input.length === 0) return new Float32Array(0);
  if (inputRate === outputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / (end - start);
    }
    return out;
  }
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const t = position - left;
    out[i] = input[left] * (1 - t) + input[right] * t;
  }
  return out;
}

/** Canonical 44-byte-header PCM WAV: mono, 16-bit little-endian. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number = DICTATION_SAMPLE_RATE,
): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i];
    const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    view.setInt16(WAV_HEADER_BYTES + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Seconds of audio in `samples` at `sampleRate`. */
export function durationSeconds(
  samples: Float32Array,
  sampleRate: number = DICTATION_SAMPLE_RATE,
): number {
  return sampleRate > 0 ? samples.length / sampleRate : 0;
}
