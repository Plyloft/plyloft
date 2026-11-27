// Unit tests for the Responsiveness row's words (src/lib/responsiveness.ts,
// H1 1.173.0).
//
// Run: node --experimental-strip-types src/lib/responsiveness.test.ts

import assert from "node:assert/strict";
import {
  NO_FREEZES,
  clockWords,
  durationWords,
  episodeWords,
  freezeCount,
  memoryWords,
  responsivenessDetails,
  responsivenessAdvice,
  responsivenessHint,
  responsivenessLine,
  responsivenessSummary,
  sizeWords,
  type MemoryFacts,
  type ResponsivenessStatus,
} from "./responsiveness.ts";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const now = new Date(2026, 9, 30, 16, 30);
const at = (h: number, m: number, day = 30) => new Date(2026, 9, day, h, m).getTime();

const low: MemoryFacts = {
  totalBytes: 16 * GB,
  availableBytes: 1.1 * GB,
  swapUsedBytes: 1.9 * GB,
  compressedBytes: 3 * GB,
  processBytes: 800 * MB,
  low: true,
};
const roomy: MemoryFacts = { ...low, availableBytes: 6.2 * GB, low: false };

const empty: ResponsivenessStatus = { startedAt: at(9, 0), episodes: [], lines: [], previousRun: null };

// The words of the pieces.
assert.equal(clockWords(at(14, 2), now), "14:02");
assert.equal(clockWords(at(9, 5, 29), now), "Oct 29, 09:05");
assert.equal(sizeWords(1.1 * GB), "1.1 GB");
assert.equal(sizeWords(820 * MB), "820 MB");
assert.equal(durationWords(40), "40 s");
assert.equal(durationWords(119), "119 s");
assert.equal(durationWords(180), "3 min");
assert.equal(memoryWords(null), "");
assert.equal(memoryWords({ ...low, totalBytes: 0 }), "", "no facts read, no claim");
assert.equal(memoryWords(low), " — memory was low (1.1 GB free, swap 1.9 GB)");
assert.equal(memoryWords(roomy), " — memory was not low (6.2 GB free)");
assert.equal(
  memoryWords({ ...low, swapEstimated: true }),
  " — memory was low (1.1 GB free, page file about 1.9 GB)",
  "Windows estimates its page file",
);

// No freezes.
assert.equal(responsivenessSummary(empty, now), NO_FREEZES);
assert.equal(NO_FREEZES, "No freezes since Plyloft started");
assert.equal(
  responsivenessHint(empty, now),
  "Plyloft checks every few seconds that the window answers, and writes any freeze to its log with the memory at that moment.",
);

// The card's example.
const one: ResponsivenessStatus = {
  ...empty,
  episodes: [{ kind: "window", at: at(14, 2), secs: 40, over: true, memory: low }],
};
assert.equal(
  responsivenessSummary(one, now),
  "The window didn't answer for 40 s at 14:02 — memory was low (1.1 GB free, swap 1.9 GB)",
);

// The app's own main thread, and a freeze still going when read.
assert.equal(
  episodeWords({ kind: "app", at: at(15, 10), secs: 5, over: false, memory: roomy }, now),
  "Plyloft didn't answer for at least 5 s at 15:10 — memory was not low (6.2 GB free)",
);

// The latest one is the row; the hint counts them.
const two: ResponsivenessStatus = {
  ...one,
  episodes: [...one.episodes, { kind: "app", at: at(15, 0), secs: 12, over: true, memory: null }],
};
assert.equal(responsivenessSummary(two, now), "Plyloft didn't answer for 12 s at 15:00");
assert.ok(responsivenessHint(two, now).startsWith("2 freezes since Plyloft started. "));
assert.ok(!responsivenessHint(one, now).includes("freezes since"), "one freeze is the row itself");

// Plyloft starved by a busy computer (the 2026-10-30 freezes).
assert.equal(
  episodeWords({ kind: "busy", at: at(14, 2), secs: 40, over: true, memory: low }, now),
  "Plyloft couldn't run for 40 s at 14:02 because the computer was too busy — memory was low (1.1 GB free, swap 1.9 GB)",
);
// One moment, three kinds: counted once; and the busy one is the row.
const together: ResponsivenessStatus = {
  ...empty,
  episodes: [
    { kind: "window", at: at(14, 2), secs: 10, over: true, memory: null },
    { kind: "app", at: at(14, 2), secs: 35, over: true, memory: null },
    { kind: "busy", at: at(14, 2), secs: 40, over: true, memory: low },
  ],
};
assert.equal(freezeCount(together.episodes), 1);
assert.ok(!responsivenessHint(together, now).includes("freezes since"), responsivenessHint(together, now));
assert.ok(responsivenessSummary(together, now).startsWith("Plyloft couldn't run for 40 s"));
assert.equal(freezeCount(two.episodes), 2, "apart in time: two");
assert.equal(freezeCount([]), 0);

// The last run that didn't end cleanly.
const unclean: ResponsivenessStatus = {
  ...empty,
  previousRun: { startedAt: at(8, 10, 29), lastBeatAt: at(13, 58, 29), lastMemory: low },
};
assert.ok(
  responsivenessHint(unclean, now).startsWith(
    "The last run (from Oct 29, 08:10) didn't end cleanly; the window last answered at Oct 29, 13:58 — memory was low (1.1 GB free, swap 1.9 GB). ",
  ),
  responsivenessHint(unclean, now),
);
assert.ok(
  responsivenessHint({ ...empty, previousRun: { startedAt: at(8, 10) } }, now).startsWith(
    "The last run (from 08:10) didn't end cleanly. ",
  ),
);
assert.equal(responsivenessSummary(unclean, now), NO_FREEZES, "this run had none");

// Copy details: the row in words, then the watchdog's own lines.
assert.equal(
  responsivenessDetails({ ...one, lines: ["2026-10-30 14:02:40  watchdog: the window has not answered for 10 s; memory: …"] }, now),
  "responsiveness: The window didn't answer for 40 s at 14:02 — memory was low (1.1 GB free, swap 1.9 GB)\n2026-10-30 14:02:40  watchdog: the window has not answered for 10 s; memory: …",
);

// 1.174.0 (DS7, scene 13): low memory says what to do — Plyloft counts an
// eighth of memory free as enough (memory_facts::is_low).
assert.equal(responsivenessAdvice(one), "Close other apps or a virtual machine: Plyloft needs about 2 GB free.");
assert.ok(responsivenessHint(one, now).startsWith("Close other apps or a virtual machine: Plyloft needs about 2 GB free. "));
assert.equal(
  responsivenessAdvice({ ...one, episodes: [{ ...one.episodes[0]!, memory: { ...low, totalBytes: 0 } }] }),
  "Close other apps or a virtual machine.",
  "no total read: the advice alone",
);
assert.equal(
  responsivenessAdvice({
    ...one,
    episodes: [{ ...one.episodes[0]!, memory: { ...low, availableBytes: 6 * GB, compressedBytes: 6 * GB } }],
  }),
  "Close other apps or a virtual machine.",
  "low from the compressor alone: no figure",
);
assert.equal(responsivenessAdvice(empty), null);
assert.equal(responsivenessAdvice({ ...one, episodes: [{ ...one.episodes[0]!, memory: roomy }] }), null, "memory wasn't low");
assert.equal(responsivenessAdvice(two), null, "the latest freeze is the one it is about");
assert.match(responsivenessHint(unclean, now), /memory was low \(1\.1 GB free, swap 1\.9 GB\)\. Close other apps or a virtual machine: Plyloft needs about 2 GB free\. /);
assert.equal(
  responsivenessLine(one, now),
  `The window didn't answer for 40 s at 14:02 — memory was low (1.1 GB free, swap 1.9 GB). ${responsivenessHint(one, now)}`,
);
assert.ok(responsivenessLine(empty, now).startsWith("No freezes since Plyloft started. Plyloft checks"));

console.log("responsiveness: ok");
