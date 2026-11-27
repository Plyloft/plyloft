// QoL 1.168 S1-2: a quit asks only when something would be lost, and says
// what in plain words.
import assert from "node:assert/strict";

import { NOTHING_RUNNING } from "./closeChoice.ts";
import {
  fileNames,
  quitAsks,
  quitSheetWords,
  saveFailedLine,
  workingLine,
  type QuitLoss,
} from "./quitGuard.ts";

const ask = { askWorking: true, workingAcknowledged: false };
const nothing: QuitLoss = { files: [], working: NOTHING_RUNNING };
const oneFile: QuitLoss = { files: [{ workspaceId: "w", path: "/p/README.md" }], working: NOTHING_RUNNING };
const oneSession: QuitLoss = { files: [], working: { ...NOTHING_RUNNING, sessions: 1 } };

// Nothing to lose: no question, whatever the setting.
assert.equal(quitAsks(nothing, ask), false);
// A shell (terminals) is never asked about.
assert.equal(quitAsks({ files: [], working: { ...NOTHING_RUNNING, terminals: 3 } }, ask), false);
// Unsaved files always ask — even with "Don't ask again" and after the close sheet.
assert.equal(quitAsks(oneFile, { askWorking: false, workingAcknowledged: true }), true);
// Work in flight asks while the setting is on, and not after the close sheet named it.
assert.equal(quitAsks(oneSession, ask), true);
assert.equal(quitAsks(oneSession, { askWorking: false, workingAcknowledged: false }), false);
assert.equal(quitAsks(oneSession, { askWorking: true, workingAcknowledged: true }), false);
// A ship in flight counts.
assert.equal(quitAsks({ files: [], working: { ...NOTHING_RUNNING, shipping: true } }, ask), true);

assert.equal(workingLine(NOTHING_RUNNING), null);
assert.equal(workingLine({ ...NOTHING_RUNNING, sessions: 1 }), "1 session is working");
assert.equal(
  workingLine({ ...NOTHING_RUNNING, sessions: 2, builds: 1 }),
  "2 sessions and 1 build are working",
);
assert.equal(workingLine({ ...NOTHING_RUNNING, shipping: true }), "a card is shipping");
assert.equal(
  workingLine({ ...NOTHING_RUNNING, sessions: 1, shipping: true }),
  "1 session is working, and a card is shipping",
);

// Both: one lede, Save all offered, "Don't ask again" about the work only.
const both: QuitLoss = {
  files: [
    { workspaceId: "w", path: "/p/a.ts" },
    { workspaceId: "w", path: "/p/b.ts" },
  ],
  working: { ...NOTHING_RUNNING, sessions: 1 },
};
const w = quitSheetWords(both, "quit", ask);
assert.equal(w.title, "Quit Plyloft?");
assert.equal(w.lede, "2 files have unsaved changes · 1 session is working.");
assert.equal(w.saveAll, "Save all and quit");
assert.equal(w.anyway, "Quit anyway");
assert.equal(w.cancel, "Cancel");
assert.ok(w.dontAsk);
assert.ok(w.workingNote);

// Files only: no "Don't ask again" (files are always asked about).
const f = quitSheetWords(oneFile, "quit", ask);
assert.equal(f.lede, "1 file has unsaved changes.");
assert.equal(f.dontAsk, null);
assert.equal(f.workingNote, null);

// Sessions only: nothing to save.
const s = quitSheetWords(oneSession, "quit", ask);
assert.equal(s.saveAll, null);
assert.equal(s.lede, "1 session is working.");

assert.equal(
  quitSheetWords({ files: [], working: { ...NOTHING_RUNNING, shipping: true } }, "quit", ask).lede,
  "A card is shipping.",
);

// The updater's relaunch says restart.
const u = quitSheetWords(both, "update", ask);
assert.equal(u.title, "Restart Plyloft to update?");
assert.equal(u.saveAll, "Save all and restart");
assert.equal(u.anyway, "Restart anyway");

// After the close sheet, the work in flight is not named again.
const ack = quitSheetWords(both, "quit", { askWorking: true, workingAcknowledged: true });
assert.equal(ack.lede, "2 files have unsaved changes.");
assert.equal(ack.dontAsk, null);

assert.deepEqual(fileNames(both.files), ["a.ts", "b.ts"]);
assert.deepEqual(
  fileNames(
    Array.from({ length: 7 }, (_, i) => ({ workspaceId: "w", path: `/p/f${i}.md` })),
    5,
  ),
  ["f0.md", "f1.md", "f2.md", "f3.md", "f4.md", "and 2 more"],
);

assert.match(saveFailedLine([{ path: "/p/a.ts" }]), /^a\.ts could not be saved, so Plyloft is still open\. Save it/);
assert.match(saveFailedLine([{ path: "/p/a.ts" }, { path: "/p/b.ts" }]), /^a\.ts and b\.ts could not be saved.*Save them/);

console.log("quitGuard.test.ts: ok");

// 1.177.1 (item 21): the open sheet whose work ended says so, with no "Don't
// ask again" and a plain Quit; it never answers by itself (QuitGuardSheet).
{
  const none = quitSheetWords(nothing, "quit", ask);
  assert.equal(none.lede, "Nothing is running, so nothing stops.");
  assert.equal(none.anyway, "Quit Plyloft");
  assert.equal(none.workingNote, null);
  assert.equal(none.dontAsk, null);
  assert.equal(none.saveAll, null);
  assert.equal(quitSheetWords(nothing, "update", ask).anyway, "Restart anyway");
  assert.equal(quitSheetWords(oneSession, "quit", ask).lede, "1 session is working.");
  console.log("quitGuard: nothing left ok");
}

// Review round 3 (M1): with "Don't ask again" on (or the Windows close sheet's
// acknowledgement), a sheet opened for a file that is saved meanwhile never
// says nothing runs while a session works; it says the session works.
{
  const off = { askWorking: false, workingAcknowledged: false };
  const acked = { askWorking: true, workingAcknowledged: true };
  for (const opts of [off, acked]) {
    const w = quitSheetWords(oneSession, "quit", opts);
    assert.notEqual(w.lede, "Nothing is running, so nothing stops.");
    assert.equal(w.lede, "1 session is working.");
    assert.equal(w.anyway, "Quit anyway");
    const waiting = quitSheetWords({ files: [], working: { ...NOTHING_RUNNING, waiting: 1 } }, "quit", opts);
    assert.notEqual(waiting.lede, "Nothing is running, so nothing stops.");
    assert.equal(quitSheetWords(nothing, "quit", opts).lede, "Nothing is running, so nothing stops.");
  }
  console.log("quitGuard: M1 ok");
}
