// Contract tests for the dictation WAV encoder (src/lib/wavEncoder.ts).
//
// Self-contained like the other src/lib tests (docs/PPVP.md Tier 3):
//
//     node --experimental-strip-types src/lib/wavEncoder.test.ts

import {
  DICTATION_SAMPLE_RATE,
  concatChunks,
  durationSeconds,
  encodeWav,
  resample,
} from "./wavEncoder.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, label = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`);
}

function near(actual: number, expected: number, tolerance: number, label = ""): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

it("writes the canonical 44-byte PCM header whisper.cpp reads", () => {
  const wav = encodeWav(new Float32Array(1600));
  const view = new DataView(wav.buffer);
  eq(wav.length, 44 + 3200, "length");
  eq(ascii(wav, 0, 4), "RIFF");
  eq(view.getUint32(4, true), 36 + 3200, "RIFF size");
  eq(ascii(wav, 8, 4), "WAVE");
  eq(ascii(wav, 12, 4), "fmt ");
  eq(view.getUint32(16, true), 16, "fmt size");
  eq(view.getUint16(20, true), 1, "PCM");
  eq(view.getUint16(22, true), 1, "mono");
  eq(view.getUint32(24, true), 16_000, "sample rate");
  eq(view.getUint32(28, true), 32_000, "byte rate");
  eq(view.getUint16(32, true), 2, "block align");
  eq(view.getUint16(34, true), 16, "bits");
  eq(ascii(wav, 36, 4), "data");
  eq(view.getUint32(40, true), 3200, "data size");
});

it("encodes samples as clamped little-endian int16", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -3, Number.NaN]));
  const view = new DataView(wav.buffer);
  const pcm = Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true));
  eq(pcm, [0, 32767, -32768, 16383, 32767, -32768, 0]);
  // Little-endian on the wire: 32767 is 0xff 0x7f.
  eq([wav[46], wav[47]], [0xff, 0x7f]);
});

it("an empty recording is a valid header with no data", () => {
  const wav = encodeWav(new Float32Array(0));
  eq(wav.length, 44);
  eq(new DataView(wav.buffer).getUint32(40, true), 0);
});

it("resamples 48 kHz to 16 kHz by averaging each window", () => {
  const input = new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6, 0, 0.3, 0.6]);
  const out = resample(input, 48_000);
  eq(out.length, 3);
  near(out[0], 0.3, 1e-6);
  near(out[1], 0.6, 1e-6);
  near(out[2], 0.3, 1e-6);
});

it("keeps a speech-band tone's frequency through 44.1 kHz → 16 kHz", () => {
  const rate = 44_100;
  const hz = 440;
  const input = new Float32Array(rate); // one second
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.8;
  const out = resample(input, rate);
  eq(out.length, 16_000);
  near(durationSeconds(out), 1, 0.001, "duration");
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++;
  near(crossings / 2, hz, 3, "cycles per second");
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  near(peak, 0.8, 0.05, "amplitude");
});

it("passes 16 kHz through unchanged and upsamples a slow mic", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const same = resample(input, DICTATION_SAMPLE_RATE);
  eq(Array.from(same), Array.from(input));
  if (same === input) throw new Error("returns a copy");
  const up = resample(new Float32Array([0, 1, 0, 1]), 8_000);
  eq(up.length, 8);
  near(up[1], 0.5, 1e-6);
  eq(resample(new Float32Array(0), 48_000).length, 0);
  eq(resample(input, 0).length, 0);
});

it("concatenates worklet chunks in order", () => {
  const joined = concatChunks([new Float32Array([1, 2]), new Float32Array(0), new Float32Array([3])]);
  eq(Array.from(joined), [1, 2, 3]);
});

console.log(`wavEncoder.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  throw new Error(`${failed} wavEncoder test(s) failed`);
}
