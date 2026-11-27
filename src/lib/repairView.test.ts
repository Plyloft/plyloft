// 1.176.0 R6: the Repair sheet's words and decisions, from the engine's plan.
//
//     node --experimental-strip-types src/lib/repairView.test.ts
import assert from "node:assert/strict";
import type { RepairPlan, RepairStep } from "./cliRepairIpc.ts";
import {
  blockView,
  evidenceLine,
  stillShortLine,
  giveUpWords,
  isRepaired,
  noteLine,
  passwordNotice,
  pauseBefore,
  refusalWords,
  repairRow,
  repairedLine,
  runItems,
  runningVersion,
  sessionClosable,
  situationLine,
  stepView,
  words,
  tildePath,
  terminalNote,
  type JournalEntry,
} from "./repairView.ts";

const step = (over: Partial<RepairStep> & { kind: RepairStep["kind"] }): RepairStep =>
  ({
    id: `${over.kind}-1`,
    passwordAgain: false,
    by: "plyloft",
    needs: null,
    optional: false,
    writes: true,
    command: null,
    paths: [],
    ...over,
  }) as RepairStep;

const plan = (over: Partial<RepairPlan> = {}): RepairPlan => ({
  tool: "claude",
  situations: [],
  notes: [],
  steps: [],
  block: null,
  nextStep: null,
  manual: [],
  quick: false,
  ...over,
});

// Situations are plain words, never the engine's names.
const missing = situationLine({ kind: "missing" }, "claude");
assert.equal(missing.text, "Claude Code isn't installed on this Mac.");
const owned = situationLine({ kind: "foldersNotOwned", paths: ["/Users/me/.claude"] }, "codex");
assert.match(owned.text, /belong to another account/);
assert.deepEqual(owned.paths, ["/Users/me/.claude"]);
for (const bad of ["EACCES", "symlink", "foldersNotOwned", "PATH"]) assert.ok(!owned.text.includes(bad), bad);
assert.match(situationLine({ kind: "brokenBinary", path: "/x/claude", failure: "badBinary" }, "claude").text, /damaged/);

// Steps: who does it, what it removes.
const chown = stepView(step({ kind: "fixOwnership", by: "terminal", needs: "password", command: "sudo chown -R me /a", paths: ["/a"] }), "claude");
assert.equal(chown.who, "you");
assert.equal(chown.whoWords, "You, in this window");
assert.equal(chown.password, true);
const install = stepView(step({ kind: "runInstaller", by: "terminal", channel: "native" }), "codex");
assert.equal(install.whoWords, "Plyloft");
assert.equal(install.inTerminal, true);
assert.equal(install.title, "Install Codex again with its official installer.");
const npm = stepView(step({ kind: "removeNpmCopy", by: "terminal", prefix: "/p", package: "@openai/codex", paths: ["/p/bin/codex"] }), "codex");
assert.deepEqual(npm.removes, ["/p/bin/codex", "the npm package @openai/codex"]);
assert.deepEqual(stepView(step({ kind: "verify" }), "claude").removes, []);

// The password notice says what macOS asks, that what is typed goes straight
// to macOS and Plyloft doesn't show, log or keep it, and what changes.
const notice = passwordNotice(chown, "claude").join(" ");
assert.match(notice, /password/);
assert.match(notice, /goes straight to macOS\. Plyloft doesn't show it, log it or keep it/);
assert.doesNotMatch(notice, /doesn't read/);
assert.doesNotMatch(notice, /never sees/);
assert.match(notice, /owner of the Claude Code folders/);

// Pauses: a password and sessions always; a removal only after the first step.
assert.equal(pauseBefore(step({ kind: "fixOwnership", needs: "password" }), true), "password");
assert.equal(pauseBefore(step({ kind: "closeSessions", needs: "closeSessions" }), true), "sessions");
assert.equal(pauseBefore(step({ kind: "removeBrokenPayload" }), true), null);
assert.equal(pauseBefore(step({ kind: "removeBrokenPayload" }), false), "removes");
assert.equal(pauseBefore(step({ kind: "removeNpmCopy" }), false), "removes");
assert.equal(pauseBefore(step({ kind: "runInstaller" }), false), "changes");
assert.equal(pauseBefore(step({ kind: "fixPermissions" }), false), "changes");
assert.equal(pauseBefore(step({ kind: "fixPermissions" }), true), null);
assert.equal(pauseBefore(step({ kind: "runInstaller" }), true), null);
assert.equal(pauseBefore(step({ kind: "verify", writes: false }), false), null);
assert.equal(pauseBefore(step({ kind: "reread", writes: false }), false), null);

// Sessions: only a tile with a PTY is Plyloft's to close.
assert.equal(sessionClosable({ source: "tile", id: "a", label: "x", ptyId: "p" }), "tile");
assert.equal(sessionClosable({ source: "agentRun", id: "a", label: null, ptyId: null }), "cannot");
assert.equal(sessionClosable({ source: "tile", id: "a", label: "x", ptyId: null }), "cannot");

// The run's list: done, running, then what waits (not what is already listed).
const journal: JournalEntry[] = [
  { id: "a", kind: "fixOwnership", title: "A", state: "done", failed: [] },
  { id: "b", kind: "runInstaller", title: "B", state: "running", failed: [] },
];
const items = runItems(journal, plan({ steps: [step({ kind: "runInstaller", id: "b" }), step({ kind: "verify", id: "v" })] }), "claude");
assert.deepEqual(items.map((i) => i.state), ["done", "running", "waiting"]);
assert.equal(items[2].title, "Check that Claude Code starts.");

// Blocks.
assert.equal(blockView({ kind: "nothingToRepair", healthyEnough: false }, "claude").fine, true);
assert.equal(blockView({ kind: "offline", proxy: false, details: null }, "claude").retry, true);
assert.match(blockView({ kind: "offline", proxy: true, details: null }, "claude").text, /proxy/);
assert.match(blockView({ kind: "diskFull", freeBytes: 100 * 1024 ** 2, neededBytes: 1024 ** 3 }, "codex").text, /1\.0 GB free and has 100 MB/);
assert.equal(blockView({ kind: "notSureYet", paths: [] }, "claude").retry, true);
const gave = blockView({ kind: "couldNotRepair", reason: "passwordRefused", step: "fixOwnership", evidence: null }, "claude");
assert.equal(gave.byHand, true);
assert.equal(gave.retry, true);
for (const reason of ["stillThereAfter", "onlyByHand", "needsChoice", "pathOrder", "pathOverride", "needsAdmin", "passwordRefused"] as const) {
  assert.ok(giveUpWords(reason, "Codex").length > 20, reason);
}
assert.match(giveUpWords("needsAdmin", "Codex"), /administrator/);
assert.match(giveUpWords("pathOrder", "Codex"), /another copy first/);
// 1.176.0 seams: the PATH set in Settings runs the broken copy — by hand, naming the setting.
assert.match(giveUpWords("pathOverride", "Codex"), /your Program folders in Settings › Look and feel › Editor and terminals/);
const overridden = blockView({ kind: "couldNotRepair", reason: "pathOverride", step: null, evidence: null }, "codex");
assert.equal(overridden.byHand, true);
assert.equal(overridden.retry, false, "no Try again: nothing Plyloft runs changes it");
const first = situationLine({ kind: "pathOverrideFirst", first: "/opt/old/bin/codex", working: "/Users/me/.local/bin/codex" }, "codex");
assert.match(JSON.stringify(first), /Your Program folders in Settings put a copy of Codex that doesn't work first/);
assert.match(JSON.stringify(first), /\/opt\/old\/bin\/codex/);

// The end: repaired only after a step ran and nothing is left; the version that runs.
assert.equal(isRepaired(plan({ block: { kind: "nothingToRepair", healthyEnough: false } }), 2), true);
assert.equal(isRepaired(plan({ block: { kind: "nothingToRepair", healthyEnough: false } }), 0), false);
assert.equal(isRepaired(plan({ block: { kind: "offline", proxy: false, details: null } }), 2), false);
assert.equal(repairedLine("claude", "2.1.4"), "Claude Code is repaired. Version 2.1.4 runs now.");
assert.equal(repairedLine("codex", null), "Codex is repaired. It starts.");
const health = {
  tool: "claude",
  healthy: true,
  runsToday: "/Users/me/.local/bin/claude",
  shouldRun: null,
  installDir: null,
  cached: null,
  copies: [{ path: "/Users/me/.local/bin/claude", alsoAt: [], start: { starts: true, version: "2.1.4" } }],
  folders: [],
  findings: [],
  passedOver: null,
} as unknown as Parameters<typeof runningVersion>[0];
assert.equal(runningVersion(health), "2.1.4");
assert.equal(runningVersion(null), null);

// Terminal windows: the end explains and gives the one line.
const line = 'export PATH="$HOME/.local/bin:$PATH"';
const other = terminalNote(
  plan({
    notes: [{ kind: "terminalRunsOther", terminal: "/usr/local/bin/claude", plyloft: "/Users/me/.local/bin/claude", failure: "exited" }],
    manual: [{ purpose: "pathOrder", command: line }],
  }),
);
assert.equal(other?.line, line);
assert.match(other?.text ?? "", /Terminal window starts the copy at \/usr\/local\/bin\/claude first/);
const native = terminalNote(
  plan({ notes: [{ kind: "updatesGoToNative", runs: "/opt/homebrew/bin/codex", native: "/Users/me/.local/bin/codex" }], tool: "codex" }),
);
assert.match(native?.text ?? "", /can't update itself/);
assert.equal(terminalNote(plan({ notes: [{ kind: "terminalMayPickOld" }] })), null);
assert.equal(noteLine({ kind: "terminalRunsOther", terminal: "a", plyloft: "b", failure: null }, "claude"), null);
assert.equal(noteLine({ kind: "npmCopyCanBeRemoved", path: "/p", prefix: "/q" }, "claude"), null);

// Diagnostics' row.
assert.deepEqual(repairRow(plan({ block: { kind: "nothingToRepair", healthyEnough: true } })), { state: "fine", text: "Claude Code is fine." });
assert.equal(repairRow(plan({ block: { kind: "notSureYet", paths: [] } })).state, "unsure");
assert.equal(repairRow(plan({ situations: [{ kind: "missing" }], steps: [step({ kind: "runInstaller" })] })).state, "needs");

// A removal waits unless it was listed; a password and sessions always wait.
assert.equal(pauseBefore(step({ kind: "removeNpmCopy" }), true), null);
assert.equal(pauseBefore(step({ kind: "fixOwnership", needs: "password" }), true), "password");
// The password words: login password, nothing appears, second time.
const second = passwordNotice({ ...chown, passwordAgain: true }, "claude").join(" ");
assert.match(second, /asks for the password again/);
assert.match(passwordNotice(chown, "claude", true).join(" "), /second time/);
assert.match(passwordNotice(chown, "claude").join(" "), /nothing appears while you type/);
assert.match(situationLine({ kind: "brokenBinary", path: "/x", failure: "signal" }, "codex").text, /system stopped/);
assert.equal(noteLine({ kind: "npmUpdaterMayTouchNative", npm: "/a", native: "/b" }, "claude")?.paths.length, 2);
assert.match(refusalWords("pathRefused", "notConfirmed") ?? "", /couldn't confirm/);
assert.equal(refusalWords("notNextStep", null), null);

// Windows words: this PC, a terminal that isn't the Mac's Terminal.
assert.equal(words("A Terminal window may keep starting it on this Mac.", "windows"), "A terminal window may keep starting it on this PC.");
assert.equal(words("A Terminal window", "mac"), "A Terminal window");
assert.equal(blockView({ kind: "nothingToRepair", healthyEnough: false }, "codex", "0.171.0").title, "Codex 0.171.0 is fine.");
assert.equal(stepView(step({ kind: "closeSessions", by: "you", needs: "closeSessions", sessions: [{ source: "tile", id: "a", label: "x", ptyId: "p" }] } as never), "claude").whoWords, "Plyloft, after you confirm");
assert.equal(stepView(step({ kind: "closeSessions", by: "you", needs: "closeSessions", sessions: [{ source: "agentRun", id: "a", label: null, ptyId: null }] } as never), "claude").whoWords, "You");

assert.equal(tildePath("at /Users/ann/.local/bin/codex"), "at ~/.local/bin/codex");
assert.equal(tildePath("C:\\Users\\ann\\AppData\\npm\\codex.cmd"), "~\\AppData\\npm\\codex.cmd");
assert.equal(stepView(step({ kind: "closeSessions", by: "you", needs: "closeSessions", sessions: [{ source: "tile", id: "a", label: "x", ptyId: "p" }] } as never), "codex").title, "Close the open Codex tile.");
// 1.176.1: outside the Program folders setting.
assert.match(
  situationLine({ kind: "outsideProgramFolders", copy: "/Users/ann/.local/bin/codex", folder: "/Users/ann/.local/bin", problems: [] }, "codex").text,
  /^Codex works, but it is in \/Users\/ann\/\.local\/bin, which isn't among your Program folders in Settings, so tiles can't start it\.$/,
);
assert.match(
  situationLine({ kind: "outsideProgramFolders", copy: "/x/claude", folder: "/x", problems: ["variable"] }, "claude").text,
  /can't find it: it uses a variable, a name starting with \$\./,
);
assert.equal(stepView(step({ kind: "addProgramFolder", folder: "/Users/ann/.local/bin", front: false, was: "/x" } as never), "claude").title, "Add ~/.local/bin at the end of your Program folders.");
assert.equal(
  stepView(step({ kind: "addProgramFolder", folder: "/Users/ann/.local/bin", front: true, was: "/x" } as never), "claude").title,
  "Add ~/.local/bin in front of your Program folders, ahead of a copy of Claude Code there that doesn't start.",
);
assert.equal(stepView(step({ kind: "emptyProgramFolders", was: "~/x" } as never), "codex").title, "Empty Program folders, so Plyloft uses what your shell reports, where Codex is.");
assert.match(situationLine({ kind: "programFoldersMalformed", problems: ["untidy"] }, "claude").text, /^Your Program folders in Settings can't work as written: it has spaces, quotes or empty places in it\. Plyloft looks for Claude Code only there\.$/);
assert.equal(pauseBefore(step({ kind: "addProgramFolder", folder: "/x", writes: true } as never), false), "changes", "a write waits unless agreed");
assert.match(giveUpWords("programFolders", "Claude Code"), /need correcting first.*Nothing was installed/);
const ev = (cause: string, causePath: string | null) =>
  ({ kind: "couldNotRepair", reason: "stillThereAfter", step: "runInstaller", evidence: { actionId: "repair-install.claude", outcome: "failed", cause, causePath, exitCode: 127, finishedAt: null, versionBefore: null, versionAfter: null } }) as const;
assert.equal(evidenceLine(ev("command-not-found", "curl"), false), "The last step needed the curl command and couldn't find it.");
assert.match(evidenceLine(ev("command-not-found", null), true) ?? "", /needed a command .* Your Program folders in Settings may leave it out/);
assert.equal(evidenceLine(ev("permissions", null), true), null);
// 1.176.1 walk: the end never says "repaired" in silence while Program
// folders still misses git or gh, and names the version.
{
  const short = { tool: "claude", situations: [], steps: [], block: { kind: "nothingToRepair", healthyEnough: false }, nextStep: null, manual: [], quick: false, notes: [{ kind: "programFoldersStillShort", missing: ["git", "gh"], problems: [] }] } as unknown as RepairPlan;
  assert.equal(stillShortLine(short, "claude", "2.1.330"), "Claude Code 2.1.330 starts now. Your Program folders still don't find git or gh.");
  const bad = { ...short, notes: [{ kind: "programFoldersStillShort", missing: [], problems: ["tilde"] }] } as unknown as RepairPlan;
  assert.equal(stillShortLine(bad, "codex", null), "Codex starts now. Your Program folders still can't work as written: it is written with ~.");
  assert.equal(stillShortLine({ ...short, notes: [] }, "claude", null), null);
}
// 1.176.1 (Windows walk): an npm copy on the list whose node is off it.
assert.equal(
  situationLine({ kind: "programFoldersLeaveOutWhatItNeeds", path: "/opt/homebrew/bin/codex", needs: "node" }, "codex").text,
  "Codex is in your Program folders, but it needs node, which your Program folders don't find, so tiles can't start it.",
);
console.log("repairView: ok");
