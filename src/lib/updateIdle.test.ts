// QoL 1.168 G1 (Challenger round 1): when "Install when my work is done" may
// restart Plyloft. Run with Node 22+:
//   node --experimental-strip-types src/lib/updateIdle.test.ts
import assert from "node:assert/strict";
import {
  ACTIVITY_EVENTS,
  IDLE_FOR_MS,
  IDLE_LOOKS,
  idleBlocker,
  installDue,
  nextIdleLooks,
  type IdleFacts,
} from "./updateIdle.ts";

const NOW = 10_000_000;
const quiet: IdleFacts = {
  now: NOW,
  lastInputAt: NOW - IDLE_FOR_MS,
  dirtyFiles: 0,
  working: 0,
  shellCommands: [false, false],
  drafts: 0,
  quitAsk: false,
  modalOpen: false,
  settingsOpen: false,
  setupOpen: false,
  paletteOpen: false,
  windowInFront: true,
};

assert.equal(idleBlocker(quiet), null, "nothing in the way: it may install");
// The 2-minute rule: one millisecond short keeps it waiting.
assert.equal(IDLE_FOR_MS, 120_000);
assert.equal(idleBlocker({ ...quiet, lastInputAt: NOW - IDLE_FOR_MS + 1 }), "input");
assert.equal(idleBlocker({ ...quiet, lastInputAt: NOW }), "input");
// Every other blocker, each on its own.
assert.equal(idleBlocker({ ...quiet, dirtyFiles: 1 }), "files", "a dirty file, even one a save refused");
assert.equal(idleBlocker({ ...quiet, working: 1 }), "working");
assert.equal(idleBlocker({ ...quiet, shellCommands: [false, true] }), "shell", "npm run dev in a shell");
assert.equal(idleBlocker({ ...quiet, shellCommands: [null] }), "shell", "unknown counts as running");
assert.equal(idleBlocker({ ...quiet, shellCommands: [] }), null, "no shell, nothing to ask");
assert.equal(idleBlocker({ ...quiet, drafts: 1 }), "draft", "an unsent draft in a Claude or Codex tile");
assert.equal(idleBlocker({ ...quiet, quitAsk: true }), "quit-sheet");
assert.equal(idleBlocker({ ...quiet, settingsOpen: true }), "settings");
assert.equal(idleBlocker({ ...quiet, setupOpen: true }), "setup");
assert.equal(idleBlocker({ ...quiet, paletteOpen: true }), "palette");
assert.equal(idleBlocker({ ...quiet, modalOpen: true }), "modal");
assert.equal(idleBlocker({ ...quiet, windowInFront: false }), "window", "never restarts a hidden or background window into view");

// Two idle looks in a row install; any busy look starts the count again.
assert.equal(IDLE_LOOKS, 2);
let looks = 0;
looks = nextIdleLooks(looks, true);
assert.equal(installDue(looks), false, "one look is not enough");
looks = nextIdleLooks(looks, false);
assert.equal(looks, 0, "a busy look resets");
looks = nextIdleLooks(nextIdleLooks(looks, true), true);
assert.equal(installDue(looks), true);

// Wheel and scroll count as someone using Plyloft.
assert.deepEqual([...ACTIVITY_EVENTS], ["keydown", "pointerdown", "wheel", "scroll"]);

console.log("updateIdle tests passed");
