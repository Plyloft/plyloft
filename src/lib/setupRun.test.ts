// OB-3: the guided terminal's words and its one-time code. Run with:
//
//     node --experimental-strip-types src/lib/setupRun.test.ts

import assert from "node:assert/strict";
import type { SetupGuidedActionId, SetupOutcome, SetupPhase } from "../ipc.ts";
import { keepsTerminalAfter, oneTimeCode, setupLine, setupRunState, showsCode, signInEnd, stopLabel, waitsForEnter } from "./setupRun.ts";

const IDS: SetupGuidedActionId[] = [
  "project.clone",
  "install.claude",
  "update.claude",
  "login.claude",
  "install.codex",
  "update.codex",
  "login.codex",
  "login-device.codex",
  "install.gh",
  "update.gh",
  "login.gh",
  "add-account.gh",
  "setupgit.gh",
  "refresh.gh",
  "install.git",
  "install.node",
  "trust.claude",
];
const OUTCOMES: SetupOutcome[] = [
  "succeeded",
  "not-observed",
  "could-not-tell",
  "failed",
  "timed-out",
  "installer-closed",
  "still-on-old-version",
  "nothing-newer",
  "older-version-now",
  "cancelled",
];
const PHASES: SetupPhase[] = ["preparing", "running", "checking", "waiting-long"];

// Every id has a sentence in every phase and outcome, on both platforms.
for (const platform of ["mac", "windows"] as const) {
  for (const id of IDS) {
    for (const phase of PHASES) {
      const line = setupLine(id, phase, null, platform);
      assert.ok(line.length > 0, `${id} ${phase}`);
      assert.ok(!/undefined|null/.test(line), line);
    }
    for (const outcome of OUTCOMES) {
      const line = setupLine(id, "done", outcome, platform);
      assert.ok(line.length > 0 && line.endsWith("."), `${id} ${outcome}: ${line}`);
      assert.ok(!/undefined|null/.test(line), line);
    }
  }
}

// The spec's own words (§5 steps 3–5).
assert.equal(setupLine("install.claude", "running", null), "Installing Claude Code… this takes about a minute.");
assert.equal(setupLine("install.gh", "running", null), "Installing the GitHub command… this takes about a minute.");
assert.equal(setupLine("login.claude", "running", null), "Finish signing in in your browser. Plyloft notices when you're done.");
assert.equal(
  setupLine("login.gh", "running", null),
  "Enter the code shown below in your browser. Plyloft notices when you're done.",
);
assert.equal(setupLine("install.git", "running", null, "mac"), "Waiting for the macOS installer to finish…");
assert.equal(setupLine("install.git", "running", null, "windows"), "Installing Git for Windows… this takes about a minute.");
assert.equal(setupLine("login.codex", "waiting-long", null), "Still waiting for you to sign in.");
assert.equal(setupLine("login.codex", "done", "not-observed"), "Not signed in yet.");
assert.equal(
  setupLine("install.claude", "done", "failed"),
  "Claude Code's installer stopped with an error. Nothing else was changed.",
);
assert.equal(
  setupLine("install.codex", "done", "not-observed"),
  "Installed, but Plyloft can't find it yet. Quit and reopen Plyloft.",
);
assert.equal(setupLine("install.git", "done", "installer-closed"), "The macOS installer was closed before Git was installed.");
assert.equal(setupLine("install.git", "done", "timed-out"), "The macOS installer didn't finish within 30 minutes.");
// 1.176.0 R2: an install or update stopped at its time limit, and an update
// that left the old version answering.
assert.equal(setupLine("update.claude", "done", "timed-out"), "Claude Code's updater took too long and was stopped.");
assert.equal(setupLine("install.codex", "done", "timed-out"), "Codex's installer took too long and was stopped.");
assert.equal(
  setupLine("update.claude", "done", "still-on-old-version"),
  "Claude Code wasn't updated. It still works, on the version it had.",
);
assert.equal(setupRunState("done", "still-on-old-version"), "aborted");
assert.equal(setupRunState("done", "older-version-now"), "aborted");
assert.equal(setupRunState("done", "nothing-newer"), "empty", "no error colour: it works as before");
assert.equal(
  setupLine("update.gh", "done", "nothing-newer"),
  "The GitHub command's updater found nothing newer. It still works, on the version it had.",
);
assert.equal(setupLine("update.claude", "done", "older-version-now"), "Claude Code wasn't updated, and an older copy of it answers now.");
assert.equal(setupLine("update.claude", "preparing", null), "Checking which version of Claude Code is there…");
assert.equal(setupLine("install.gh", "done", "succeeded"), "The GitHub command is installed.");
assert.equal(setupLine("install.git", "done", "succeeded", "windows"), "Git for Windows is installed.");

// The dot: running while anything runs; done only on success; aborted on an
// error or a timeout; a sign-in not there yet is no error colour.
assert.equal(setupRunState(null, null), "empty");
for (const phase of PHASES) assert.equal(setupRunState(phase, null), "running");
assert.equal(setupRunState("done", "succeeded"), "done");
assert.equal(setupRunState("done", "failed"), "aborted");
assert.equal(setupRunState("done", "timed-out"), "aborted");
assert.equal(setupRunState("done", "installer-closed"), "aborted");
assert.equal(setupRunState("done", "not-observed"), "empty");
assert.equal(setupRunState("done", "cancelled"), "empty");

// The one-time code: gh's and Codex's, coloured or not, the last one wins.
assert.deepEqual(
  ["login.gh", "add-account.gh", "login-device.codex"].every((id) => showsCode(id as SetupGuidedActionId)),
  true,
);
assert.equal(showsCode("login.claude"), false);
assert.equal(oneTimeCode("! First copy your one-time code: 4F2A-9C1B\nPress Enter to open github.com"), "4F2A-9C1B");
assert.equal(oneTimeCode("Enter this one-time code\x1b[1m\x1b[94m ABCD-EFGH9\x1b[0m (expires in 15 minutes)"), "ABCD-EFGH9");
assert.equal(oneTimeCode("code AAAA-BBBB, then code CCCC-DDDD"), "CCCC-DDDD");
assert.equal(oneTimeCode("released 2026-0927 and 1234-5678"), null, "digits only: a date or a number");
assert.equal(oneTimeCode("see https://github.com/login/device"), null);
assert.equal(oneTimeCode("ABCD-EFGHIJ is too long"), null);
assert.equal(oneTimeCode("XABCD-EFGH is inside a word"), null);

console.log("setupRun: ok");

// OB-12: step 8's clone has its own words (the step says the rest, from the
// final event's `clone`), and it is cancelled rather than stopped.
assert.equal(setupLine("project.clone", "running", null), "Downloading from GitHub… You can cancel at any time.");
assert.equal(setupLine("project.clone", "checking", null), "Checking the download…");
assert.equal(setupLine("project.clone", "done", "succeeded"), "Downloaded.");
assert.equal(setupLine("project.clone", "done", "cancelled"), "Stopped. Nothing was added to Plyloft.");
assert.equal(setupLine("project.clone", "done", "failed"), "The download stopped. Nothing was added to Plyloft.");
assert.equal(setupLine("project.clone", "done", "could-not-tell"), "The download didn't finish. Nothing was added to Plyloft.");
assert.equal(showsCode("project.clone"), false);
assert.equal(stopLabel("project.clone"), "Cancel");
assert.equal(stopLabel("install.gh"), "Stop");

// Claude opened on the review folder: the member answers, Plyloft closes it.
assert.equal(
  setupLine("trust.claude", "running", null),
  "Choose “Yes, I trust this folder” below. Plyloft notices and closes Claude.",
);
assert.equal(setupLine("trust.claude", "checking", null), "Checking whether Claude trusts the folder…");
assert.equal(setupLine("trust.claude", "done", "succeeded"), "Claude trusts Plyloft's review folder.");
assert.equal(setupLine("trust.claude", "done", "not-observed"), "Claude doesn't trust Plyloft's review folder yet.");
assert.equal(setupLine("trust.claude", "done", "cancelled"), "Stopped. Claude doesn't trust the folder yet.");
assert.equal(
  setupLine("trust.claude", "done", "could-not-tell"),
  "Plyloft couldn't tell whether Claude trusts the folder.",
);
assert.equal(setupLine("trust.claude", "running", null, "windows"), setupLine("trust.claude", "running", null));
assert.equal(showsCode("trust.claude"), false);
assert.equal(stopLabel("trust.claude"), "Stop");
// Windows walk: an ended trust run keeps only its line; every other run keeps its terminal.
assert.equal(keepsTerminalAfter("trust.claude"), false);
for (const id of IDS.filter((i) => i !== "trust.claude")) assert.equal(keepsTerminalAfter(id), true, id);

// N14 walk F17 (Challenger P1): only gh's "Press Enter to open" prompt.
assert.equal(waitsForEnter("? Authenticate Git with your GitHub credentials? (Y/n) "), false);
assert.equal(waitsForEnter("! First copy your one-time code: 4F2A-9C1B\n\x1b[1mPress Enter\x1b[0m to open https://github.com/login/device in your browser... "), true);

// 1.175.0 F1: how a GitHub sign-in that didn't succeed ended. The code
// expired (GitHub's device flow answers `expired_token`, which the GitHub
// command prints), or the person stopped it — Stop in Plyloft, or Cancel on
// GitHub's page (`access_denied`). Anything else is not guessed.
const EXPIRED = [
  "! First copy your one-time code: 7F2A-91CD",
  "Press Enter to open https://github.com/login/device in your browser... ",
  "failed to authenticate via web browser: This 'device_code' has expired. (expired_token)",
];
assert.equal(signInEnd("login.gh", "failed", EXPIRED), "expired");
assert.equal(signInEnd("add-account.gh", "failed", EXPIRED), "expired");
assert.equal(signInEnd("login.gh", "not-observed", ["error: expired_token"]), "expired");
assert.equal(signInEnd("login.gh", "failed", ["\x1b[31mfailed to authenticate: the device code has expired\x1b[0m"]), "expired", "coloured output");
assert.equal(
  signInEnd("login.gh", "failed", ["failed to authenticate via web browser: The authorization request was denied. (access_denied)"]),
  "stopped",
  "Cancel on GitHub's page",
);
assert.equal(signInEnd("login.gh", "cancelled", []), "stopped", "Stop in Plyloft");
assert.equal(signInEnd("login.gh", "cancelled", EXPIRED), "stopped", "the person's Stop is what ended it");
assert.equal(signInEnd("login.gh", "failed", ["error connecting to github.com"]), null, "another failure isn't guessed");
assert.equal(signInEnd("login.gh", "succeeded", EXPIRED), null);
assert.equal(signInEnd("login.gh", null, EXPIRED), null, "still running");
assert.equal(signInEnd("install.gh", "failed", EXPIRED), null, "only a sign-in");
assert.equal(signInEnd("setupgit.gh", "cancelled", []), null);
assert.equal(signInEnd("login-device.codex", "cancelled", []), null, "only the GitHub command's");

// 1.176.0 R4 (M3): a Repair's run gets only a neutral line here.
assert.equal(setupLine("repair-chown.claude" as SetupGuidedActionId, "running", null), "A repair is running.");
assert.equal(setupLine("repair-install.codex" as SetupGuidedActionId, "done", "failed"), "The repair step ended.");
