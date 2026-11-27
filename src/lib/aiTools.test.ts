// OB-5: the AI tools step's words and decisions. Run with:
//
//     node --experimental-strip-types src/lib/aiTools.test.ts

import assert from "node:assert/strict";
import type { SetupSignInAnswer } from "../ipc.ts";
import {
  AI_SUBSCRIPTION_LINE,
  aiContinueReason,
  installLines,
  installTone,
  aiStepReady,
  asksWhich,
  builderView,
  checklistAiAction,
  haltedError,
  leaveSheet,
  switchedWords,
  isAiStepAction,
  isAccountAction,
  looksLikeProxy,
  offlineError,
  PROXY_TEXT,
  readyWords,
  notStartingError,
  refusalError,
  repairToolAfter,
  rowLabel,
  rowRole,
  runActionFor,
  runFailure,
  sheetCopy,
  sheetFor,
  sheetRuns,
  showsProWarning,
  toggleHave,
  toolFacts,
  toolRow,
  vendorPatch,
  wingetNeedsAdmin,
  yourselfPage,
  holdsAiStep,
  showsSetupTrust,
  toolOfAction,
  SETUP_TRUST,
  TRUST_ACTION,
  type Have,
  type RowView,
  type SignIn,
  type ToolFacts,
} from "./aiTools.ts";

const works: ToolFacts = { found: true, works: true, update: null, installCmd: "curl … | bash" };
const missing: ToolFacts = { found: false, works: false, update: null, installCmd: "curl … | bash" };
const answer = (a: Partial<SetupSignInAnswer>): SignIn => ({
  kind: "answer",
  answer: { signedIn: true, method: null, plan: null, words: null, ...a },
});
const unread: SignIn = { kind: "unread" };

// ── Rows per state ───────────────────────────────────────────────────────

let r = toolRow("claude", missing, unread, null);
assert.deepEqual([r.state, r.words, r.action?.id, r.usable], ["missing", "Not installed.", "install", "no"]);

r = toolRow("claude", missing, unread, { actionId: "install.claude", phase: "running", outcome: null });
assert.deepEqual([r.state, r.words, r.action, r.usable], ["installing", "Installing… this takes about a minute.", null, "pending"]);

// Another tool's run leaves this row alone.
r = toolRow("codex", missing, unread, { actionId: "install.claude", phase: "running", outcome: null });
assert.equal(r.state, "missing");

r = toolRow("claude", missing, unread, { actionId: "install.claude", phase: "done", outcome: "not-observed" });
assert.deepEqual(
  [r.state, r.words, r.action?.id],
  ["not-found-yet", "Installed, but Plyloft can't find it yet. Quit and reopen Plyloft.", "check-again"],
);

r = toolRow("claude", { ...works, works: false }, unread, null);
assert.deepEqual([r.state, r.words, r.action?.id], ["too-old", "Installed but too old. Update it to use it with Plyloft.", "update"]);
r = toolRow("codex", { ...works, works: false }, unread, null);
assert.deepEqual([r.state, r.words, r.action?.label], ["broken", "Installed but not starting. Reinstall it.", "Reinstall"]);
// 1.176.0 R3: a Claude that doesn't answer `--version` is not "too old": it
// gets Codex's row, and its Reinstall runs the official installer.
r = toolRow("claude", { ...works, works: false, starts: false }, unread, null);
assert.deepEqual([r.state, r.words, r.action?.id, r.usable], ["broken", "Installed but not starting. Reinstall it.", "reinstall", "no"]);
assert.equal(runActionFor("claude", "reinstall"), "install.claude");
r = toolRow("claude", { ...works, works: false, starts: true }, unread, null);
assert.equal(r.state, "too-old", "one that runs and is old is still updated");
r = toolRow("codex", { ...works, works: false, starts: true }, unread, null);
assert.equal(r.state, "broken", "Codex's rule is unchanged");

r = toolRow("claude", works, { kind: "checking" }, null);
assert.deepEqual([r.state, r.usable, r.action], ["checking", "pending", null]);

r = toolRow("claude", works, answer({ signedIn: false, method: "none" }), null);
assert.deepEqual([r.state, r.words, r.action?.id, r.action?.quiet], ["signed-out", "Installed. Not signed in yet.", "sign-in", false]);

r = toolRow("claude", works, unread, { actionId: "login.claude", phase: "running", outcome: null });
assert.deepEqual([r.state, r.words], ["signing-in", "Finish signing in in your browser. Plyloft notices when you're done."]);
r = toolRow("codex", works, unread, { actionId: "login-device.codex", phase: "waiting-long", outcome: null });
assert.equal(r.state, "signing-in");
assert.match(r.words, /^Enter the code shown below/);

r = toolRow("claude", works, answer({ signedIn: null }), null);
assert.deepEqual([r.state, r.usable, r.action?.quiet], ["unsure", "maybe", true]);
assert.equal(
  r.words,
  "Installed. Plyloft couldn't tell whether you're signed in; if your Claude tiles start, this is fine.",
);
r = toolRow("codex", works, answer({ signedIn: null }), null);
assert.equal(r.words, "Installed. Plyloft couldn't tell whether you're signed in.");

r = toolRow("claude", works, answer({ method: "claude.ai", plan: "max" }), null);
assert.deepEqual([r.state, r.words, r.action, r.usable], ["ready", "Ready. Signed in with Claude Max.", null, "yes"]);

// D6: a newer release is a quiet Update, never a block.
r = toolRow("claude", { ...works, update: { latest: "2.1.290", command: "claude update" } }, answer({ method: "claude.ai", plan: "max" }), null);
assert.deepEqual([r.words, r.action?.id, r.action?.quiet, r.usable], ["Ready. Signed in with Claude Max. Version 2.1.290 is available.", "update", true, "yes"]);

// A cancelled login re-read as signed out: "Not signed in yet.", no error.
r = toolRow("claude", works, answer({ signedIn: false }), { actionId: "login.claude", phase: "done", outcome: "cancelled" });
assert.equal(r.words, "Installed. Not signed in yet.");
assert.equal(runFailure("login.claude", "cancelled", null, [], "claude auth login"), null);
assert.equal(runFailure("login.claude", "not-observed", 0, [], "claude auth login"), null);

// ── Ready words (MEASUREMENTS §1–2, D3) ──────────────────────────────────

const ready = (tool: "claude" | "codex", a: Partial<SetupSignInAnswer>) =>
  readyWords(tool, { signedIn: true, method: null, plan: null, words: null, ...a });
assert.equal(ready("claude", { method: "claude.ai", plan: "pro" }), "Ready. Signed in with Claude Pro.");
assert.equal(ready("claude", { method: "claude.ai", plan: "team" }), "Ready. Signed in with Claude Team.");
assert.equal(ready("claude", { method: "claude.ai", plan: "enterprise" }), "Ready. Signed in with Claude Enterprise.");
assert.equal(ready("claude", { method: "claude.ai", plan: null }), "Ready.", "unknown plan: never guessed");
assert.equal(ready("claude", { method: "claude.ai", plan: "something-new" }), "Ready.");
assert.equal(ready("claude", { method: "api_key" }), "Ready, with an API key.");
assert.equal(ready("claude", { method: "api_key_helper" }), "Ready, with an API key.");
assert.equal(ready("claude", { method: "oauth_token" }), "Ready.");
assert.equal(ready("claude", { method: "third_party" }), "Ready.");
assert.equal(ready("codex", { method: "chatgpt" }), "Ready. Signed in with ChatGPT.");
assert.equal(ready("codex", { method: "api_key" }), "Ready, with an API key.");
assert.equal(ready("codex", {}), "Ready.");

// ── The Pro warning ──────────────────────────────────────────────────────

assert.equal(showsProWarning(answer({ method: "claude.ai", plan: "pro" })), true);
for (const plan of ["max", "team", "enterprise", null]) {
  assert.equal(showsProWarning(answer({ method: "claude.ai", plan })), false, String(plan));
}
assert.equal(showsProWarning(answer({ method: "api_key", plan: "pro" })), false, "an API key: no warning (D3)");
assert.equal(showsProWarning(answer({ signedIn: false, method: "claude.ai", plan: "pro" })), false);
assert.equal(showsProWarning(unread), false);

// ── The step's `ai` fact, the Builder, and the vendor write ─────────────

const row = (tool: "claude" | "codex", usable: RowView["usable"]): RowView => ({
  tool,
  usable,
  state: usable === "no" ? "missing" : "ready",
  words: "",
  action: null,
});
assert.equal(aiStepReady([row("claude", "yes"), row("codex", "no")]), true);
assert.equal(aiStepReady([row("claude", "maybe"), row("codex", "no")]), true, "could not tell is not a block");
assert.equal(aiStepReady([row("claude", "no"), row("codex", "no")]), false);
assert.equal(aiStepReady([row("claude", "pending"), row("codex", "no")]), null);

assert.deepEqual(builderView([row("claude", "no"), row("codex", "no")]), { kind: "none" });
assert.equal(builderView([row("claude", "yes"), row("codex", "yes")]).kind, "choose");
const single = builderView([row("claude", "yes"), row("codex", "no")]);
assert.ok(single.kind === "single" && single.vendor === "claude");
assert.equal(single.kind === "single" && single.title, "Claude will build and review your cards.");
const codexOnly = builderView([row("claude", "no"), row("codex", "yes")]);
assert.ok(codexOnly.kind === "single" && codexOnly.title === "Codex will build and review your cards.");
assert.ok(codexOnly.kind === "single" && codexOnly.text.includes("Adding Claude Code later"));

const defaults = { builderVendor: "claude" as const, discussionSynthesizer: "claude" as const };
// Review P3-2: `row(..., "no")` above is a missing tool; a broken one, a
// could-not-tell one or one still being read never moves the Builder.
const state = (r: RowView, s: RowView["state"]): RowView => ({ ...r, state: s });
assert.deepEqual(vendorPatch([row("claude", "no"), row("codex", "yes")], defaults), {
  builderVendor: "codex",
  discussionSynthesizer: "codex",
});
assert.equal(vendorPatch([row("claude", "yes"), row("codex", "no")], defaults), null, "already Claude");
assert.deepEqual(
  vendorPatch([row("claude", "yes"), row("codex", "no")], { builderVendor: "codex", discussionSynthesizer: "codex" }),
  defaults,
);
assert.equal(vendorPatch([row("claude", "pending"), row("codex", "yes")], defaults), null, "wait for the other's read");
assert.equal(vendorPatch([row("claude", "yes"), row("codex", "yes")], { builderVendor: "codex", discussionSynthesizer: "claude" }), null, "both: the person chooses");

// ── Which do you have? ───────────────────────────────────────────────────

assert.equal(asksWhich(missing, missing), true);
assert.equal(asksWhich(works, missing), false);
let have: Set<Have> = new Set();
have = toggleHave(have, "claude", true);
have = toggleHave(have, "codex", true);
assert.deepEqual([...have].sort(), ["claude", "codex"]);
have = toggleHave(have, "neither", true);
assert.deepEqual([...have], ["neither"], "Neither yet clears the others");
have = toggleHave(have, "codex", true);
assert.deepEqual([...have], ["codex"], "a tool clears Neither yet");
assert.equal(rowRole("codex", true, have), "primary");
assert.equal(rowRole("claude", true, have), "also");
assert.equal(rowLabel("claude", "also"), "Also use Claude Code");
assert.equal(rowLabel("codex", "also"), "Also use Codex");
assert.equal(rowLabel("codex", "primary"), "Codex");
assert.equal(rowRole("claude", true, new Set()), "normal");
assert.equal(rowRole("claude", true, new Set<Have>(["neither"])), "normal");
assert.equal(rowRole("claude", false, have), "normal", "installed: the question is gone");

// ── Sheets ───────────────────────────────────────────────────────────────

assert.equal(sheetFor("claude", "install", "mac", false), "install-claude");
assert.equal(sheetFor("claude", "install", "windows", true), "install-claude");
assert.equal(sheetFor("claude", "install", "windows", false), "install-git-then-claude");
assert.equal(sheetFor("codex", "install", "windows", false), "install-codex", "install.ps1: no Node sheet");
assert.equal(sheetFor("codex", "reinstall", "mac", true), "reinstall-codex");
assert.equal(sheetFor("claude", "update", "mac", true), "update-claude");
assert.equal(sheetFor("claude", "sign-in", "mac", true), null);
assert.deepEqual(sheetRuns("install-git-then-claude"), ["install.git", "install.claude"]);
assert.deepEqual(sheetCopy("install-claude"), {
  title: "Install Claude Code?",
  body: "Plyloft will download and run the installer Anthropic publishes. It installs for your user only and doesn't need an administrator.",
  confirm: "Install",
});
assert.deepEqual(sheetCopy("install-git-then-claude"), {
  title: "Install Git for Windows first?",
  body: "Claude Code on Windows needs Git for Windows. Windows may ask for an administrator's permission.",
  confirm: "Install both",
});
assert.equal(sheetCopy("update-claude").body, "Plyloft will run Claude Code's own updater.");
for (const kind of ["install-claude", "install-git-then-claude", "install-codex", "reinstall-codex", "update-claude", "update-codex"] as const) {
  const c = sheetCopy(kind);
  assert.ok(!/\bPly\b/.test(c.title + c.body), `${kind}: says Plyloft`);
}
assert.equal(runActionFor("codex", "sign-in"), "login.codex");
assert.equal(runActionFor("codex", "reinstall"), "install.codex");
assert.equal(runActionFor("claude", "check-again"), null);
assert.ok(isAiStepAction("install.git") && isAiStepAction("login-device.codex") && !isAiStepAction("login.gh"));

// ── Failures ─────────────────────────────────────────────────────────────

const off = offlineError("install.claude", { reachable: false, proxy: false, details: "curl: (6) Could not resolve host" });
assert.equal(off.happened, "You're offline, or this network blocks the download.");
assert.equal(off.untouched, "Nothing was installed.");
assert.equal(off.todo, "Connect and press Try again.");
assert.deepEqual(off.actions.map((a) => a.label), ["Try again", "Do it yourself"]);
assert.match(offlineError("install.codex", { reachable: false, proxy: true, details: null }).todo, /may use a proxy/);

const failed = runFailure("install.claude", "failed", 1, ["curl: (22) The requested URL returned error: 500"], "curl -fsSL https://claude.ai/install.sh | bash");
assert.ok(failed);
assert.equal(failed.happened, "Claude Code's installer stopped with an error.");
assert.equal(failed.untouched, "Nothing else was changed.");
assert.equal(failed.todo, "Try again, or install it yourself.");
assert.match(failed.details ?? "", /install\.sh/);
const proxied = runFailure("install.codex", "failed", 56, ["curl: (56) CONNECT tunnel failed, response 407"], "curl … | sh");
assert.equal(proxied?.todo, "Your network may use a proxy. Ask whoever manages it to allow claude.ai / chatgpt.com, or install the tool yourself.");
assert.equal(runFailure("install.claude", "succeeded", 0, [], ""), null);
assert.equal(runFailure("install.claude", "not-observed", 0, [], ""), null);

// 1.176.0 R2: the cause in plain words, and an update that left the old version.
{
  const npm = ["npm error code EACCES", "npm error path /usr/local/lib/node_modules/@anthropic-ai"];
  const old = runFailure("update.claude", "still-on-old-version", 243, npm, "claude update", {
    cause: "permissions",
    causePath: "/usr/local/lib/node_modules/@anthropic-ai",
    versionBefore: "2.1.283",
    versionAfter: "2.1.283",
  });
  assert.ok(old);
  assert.equal(old.title, "Claude Code wasn't updated.");
  assert.equal(old.happened, "The computer didn't let Claude Code's updater change the folder /usr/local/lib/node_modules/@anthropic-ai.");
  assert.equal(old.untouched, "Claude Code still works, on version 2.1.283.");
  assert.match(old.todo, /^That folder may belong to another account/);
  assert.match(old.details ?? "", /^claude update\nnpm error code EACCES/, "raw text only under Details");
  assert.doesNotMatch(old.happened + old.todo, /EACCES|npm/);
  // No version read and no cause: the old words, with what still holds.
  const plain = runFailure("update.codex", "still-on-old-version", 1, [], "codex update");
  assert.equal(plain?.happened, "Codex's updater stopped with an error.");
  assert.equal(plain?.untouched, "Codex still works, on the version it had.");
  assert.equal(plain?.todo, "Try again, or install it yourself.");
  // R0's silent case: it said it finished, exit 0, the old version runs.
  const silent = runFailure("update.claude", "still-on-old-version", 0, ["Successfully updated from 2.1.300 to version 2.1.330"], "claude update", {
    cause: "unknown",
    versionBefore: "2.1.300",
  });
  assert.equal(silent?.happened, "Claude Code's updater said it finished, but the old version still runs.");
  assert.equal(silent?.untouched, "Claude Code still works, on version 2.1.300.");
  assert.equal(
    silent?.todo,
    "Claude Code's folder may not be writable, so trying again won't help. Ask whoever manages this computer, or install it yourself.",
  );
  assert.deepEqual(silent?.actions.map((a) => a.label), ["Do it yourself"], "no Try again that can't help");
  // R0: a failed update left an older copy answering.
  const older = runFailure("update.claude", "older-version-now", 1, [], "claude update", {
    versionBefore: "2.1.330",
    versionAfter: "2.1.300",
  });
  assert.equal(older?.title, "Claude Code wasn't updated.");
  assert.equal(older?.happened, "Claude Code's update didn't finish.");
  assert.equal(older?.untouched, "An older copy of Claude Code answers now: version 2.1.300, where it was 2.1.330.");
  assert.equal(older?.todo, "Install Claude Code again yourself, so the newest copy is the one that runs.");
  assert.deepEqual(older?.actions.map((a) => a.label), ["Do it yourself"]);
  // Nothing newer is no error: the line says it, the tool works.
  assert.equal(runFailure("update.codex", "nothing-newer", 0, [], "x", { versionBefore: "0.80.0" }), null);
  // A refused write with no path named.
  const nopath = runFailure("install.claude", "failed", 1, [], "x", { cause: "permissions" });
  assert.equal(nopath?.happened, "The computer didn't let Claude Code's installer change its files.");
  assert.equal(nopath?.untouched, "Nothing else was changed.");
  const disk = runFailure("install.codex", "failed", 1, [], "x", { cause: "disk-full" });
  assert.equal(disk?.happened, "The disk is full.");
  assert.equal(disk?.todo, "Free some space on the disk, then press Try again.");
  const busy = runFailure("update.claude", "failed", 1, [], "x", { cause: "file-in-use", causePath: "C:\\Users\\me\\.local\\bin\\claude.exe" });
  assert.equal(busy?.happened, "A file it had to replace is in use: C:\\Users\\me\\.local\\bin\\claude.exe.");
  assert.equal(busy?.todo, "Close the open Claude Code tiles and windows, then press Try again.");
  const net = runFailure("install.claude", "failed", 6, ["curl: (6) Could not resolve host: claude.ai"], "x", { cause: "network" });
  assert.equal(net?.happened, "The network didn't answer.");
  assert.equal(net?.todo, "Connect and press Try again.");
  const proxy = runFailure("install.codex", "failed", 56, ["curl: (56) CONNECT tunnel failed, response 407"], "x", { cause: "network" });
  assert.equal(proxy?.todo, PROXY_TEXT);
  // Stopped at its time limit: a failure now, with what may have happened.
  const slow = runFailure("update.codex", "timed-out", null, [], "codex update", { cause: "timed-out" });
  assert.equal(slow?.happened, "Codex's updater took too long and was stopped.");
  assert.equal(slow?.untouched, "Part of it may have been updated.");
  assert.equal(slow?.todo, "Try again, or install it yourself.");
  const slowInstall = runFailure("install.claude", "timed-out", null, [], "x");
  assert.equal(slowInstall?.happened, "Claude Code's installer took too long and was stopped.");
  assert.equal(slowInstall?.untouched, "Part of it may have been installed.");
  // Git's own time-outs stay the Git step's (and Install both's halted block).
  assert.equal(runFailure("install.git", "timed-out", null, [], "x"), null);
  // An unknown cause keeps the old words.
  const unknown = runFailure("install.claude", "failed", 1, [], "x", { cause: "unknown" });
  assert.equal(unknown?.happened, "Claude Code's installer stopped with an error.");
}

// winget's admin answers, signed or unsigned (MEASUREMENTS §7).
assert.equal(wingetNeedsAdmin(0x8a150019), true);
assert.equal(wingetNeedsAdmin(0x8a150019 | 0), true, "as a signed i32");
assert.equal(wingetNeedsAdmin(0x8a15010c | 0), true);
assert.equal(wingetNeedsAdmin(0x8a15003a), true);
assert.equal(wingetNeedsAdmin(0x8a150056), false, "the installer refusing elevation is not this");
assert.equal(wingetNeedsAdmin(null), false);
const admin = runFailure("install.git", "failed", 0x8a150019 | 0, [], "winget install --id Git.Git …");
assert.equal(admin?.happened, "Windows needs an administrator to install Git for Windows.");
assert.equal(admin?.todo, "Ask your IT team to install it, or install it yourself and press Look again.");
assert.deepEqual(admin?.actions.map((a) => a.label), ["Look again", "Do it yourself"]);

const winget = refusalError("Windows' package installer (winget) isn't available on this PC.");
assert.equal(winget?.happened, "Windows' package installer isn't available here.");
assert.deepEqual(winget?.actions.map((a) => a.label), ["Do it yourself", "Look again"]);
assert.equal(refusalError("A setup step is already running: Installing Codex."), null);
assert.equal(refusalError(null), null);
// 1.176.0 seams: Update refused on a copy whose folders aren't writable —
// the backend's typed refusal — offers Repair, the mark never shown.
const updateRefused = refusalError(
  'PLY_CLI_UPDATE_REFUSED_V1:{"tool":"codex"}\nPlyloft can\'t update this Codex: the folders its updater writes aren\'t yours to change. Use Repair in Settings › Setup and account › Diagnostics.',
);
assert.equal(updateRefused?.title, "Codex wasn't updated.");
assert.equal(
  updateRefused?.happened,
  "Plyloft can't update this Codex: the folders its updater writes aren't yours to change. Use Repair in Settings › Setup and account › Diagnostics.",
);
assert.deepEqual(updateRefused?.actions.map((a) => [a.id, a.label]), [["cli-repair:codex", "Repair Codex"]]);
// The words alone, without the mark, are not read.
assert.equal(refusalError("Plyloft can't update this Codex: the folders its updater writes aren't yours to change."), null);

assert.equal(looksLikeProxy(["SSL certificate problem: unable to get local issuer certificate"]), true);
assert.equal(looksLikeProxy(["curl: (22) 404"]), false);
assert.equal(yourselfPage("install.git"), "install-git-windows");
assert.equal(yourselfPage("update.codex"), "install-codex");
assert.equal(yourselfPage("install.claude"), "install-claude");

// ── The checklist row and the doctor's facts ────────────────────────────

assert.equal(checklistAiAction(missing, missing), null, "the step asks which first");
assert.deepEqual(checklistAiAction({ ...works, works: false }, missing), { tool: "claude", action: "update", label: "Update Claude Code" });
// R3 review 2: a Claude that doesn't start is reinstalled, never updated with itself.
assert.deepEqual(checklistAiAction({ ...works, works: false, starts: false }, missing), { tool: "claude", action: "reinstall", label: "Repair Claude Code" });
assert.equal(runActionFor("claude", checklistAiAction({ ...works, works: false, starts: false }, works)!.action), "install.claude");
assert.deepEqual(checklistAiAction(missing, { ...works, works: false }), { tool: "codex", action: "reinstall", label: "Repair Codex" });
assert.deepEqual(checklistAiAction(missing, works), { tool: "codex", action: "sign-in", label: "Sign in" });

assert.deepEqual(toolFacts(null), { found: false, works: false, update: null, installCmd: "" });
assert.deepEqual(
  toolFacts({ found: true, versionOk: false, installCmd: "claude update", update: null }),
  { found: true, works: false, update: null, installCmd: "claude update" },
);
// R3: the doctor row's version says whether it starts.
assert.equal(toolFacts({ found: true, versionOk: false, version: "0.1.0", installCmd: "claude update" }).starts, true);
assert.equal(toolFacts({ found: true, versionOk: false, version: null, installCmd: "curl" }).starts, false);
assert.equal(toolFacts({ found: false, versionOk: false, version: null, installCmd: "curl" }).starts, false);

const codexBuilder = { builderVendor: "codex" as const, discussionSynthesizer: "codex" as const };
for (const s of ["broken", "too-old", "not-found-yet"] as const) {
  assert.equal(vendorPatch([row("claude", "yes"), state(row("codex", "no"), s)], codexBuilder), null, s);
}
assert.deepEqual(
  vendorPatch([row("claude", "yes"), state(row("codex", "no"), "signed-out")], codexBuilder),
  defaults,
  "definitively signed out",
);
assert.equal(switchedWords("codex", "claude"), "Plyloft switched who builds your cards from Codex to Claude.");
assert.equal(leaveSheet("login.codex").title, "Stop signing in?");
assert.equal(leaveSheet("install.git").title, "Stop the installer?");
// OB-7a: the GitHub step's runs.
assert.equal(leaveSheet("login.gh").title, "Stop signing in?");
assert.equal(leaveSheet("add-account.gh").title, "Stop signing in?");
assert.equal(leaveSheet("refresh.gh").title, "Stop signing in?");
assert.equal(leaveSheet("setupgit.gh").title, "Stop the GitHub command?");
assert.equal(leaveSheet("install.gh").title, "Stop the installer?");
assert.equal(leaveSheet("update.gh").title, "Stop the installer?");

// Review P3-1: Git for Windows not ready → Claude Code never started.
for (const outcome of ["not-observed", "could-not-tell", "timed-out"] as const) {
  const e = haltedError("install.git", outcome, ["install.claude"], []);
  assert.equal(e?.happened, "Claude Code wasn't installed because Git for Windows isn't ready yet.", outcome);
  assert.deepEqual(e?.actions.map((a) => a.label), ["Try again", "Do it yourself"]);
}
assert.equal(haltedError("install.git", "failed", ["install.claude"], []), null, "failed keeps its own block");
assert.equal(haltedError("install.git", "not-observed", null, []), null, "Git on its own");

// Claude's review folder: its own run, offered once Claude is Ready and
// Claude says the folder is untrusted; never part of the step's readiness.
assert.equal(TRUST_ACTION, "trust.claude");
assert.equal(toolOfAction(TRUST_ACTION), null, "no row follows the trust run");
assert.equal(toolOfAction("login.claude"), "claude");
assert.ok(isAiStepAction(TRUST_ACTION), "its terminal is the AI step's");
assert.ok(!holdsAiStep(TRUST_ACTION), "Continue never waits on it");
assert.ok(holdsAiStep("login.claude") && holdsAiStep("install.git"));
{
  const ready = { state: "ready" } as const;
  assert.ok(showsSetupTrust(ready, false, false));
  assert.ok(!showsSetupTrust(ready, true, false), "trusted");
  assert.ok(!showsSetupTrust(ready, null, false), "unreadable says nothing on a first run");
  assert.ok(!showsSetupTrust(ready, undefined, false), "not read yet");
  assert.ok(!showsSetupTrust(ready, false, true), "Not now");
  for (const state of ["missing", "signed-out", "unsure", "checking", "signing-in"] as const) {
    assert.ok(!showsSetupTrust({ state }, false, false), state);
  }
  // A running trust run's row is the plain Ready one.
  const claude = toolFacts({ found: true, versionOk: true, installCmd: "x" });
  const answer: SignIn = { kind: "answer", answer: { signedIn: true, method: "claude.ai", plan: "max", words: null } };
  const row = toolRow("claude", claude, answer, { actionId: TRUST_ACTION, phase: "running", outcome: null });
  assert.equal(row.state, "ready");
  assert.equal(aiStepReady([row]), true);
}
assert.match(SETUP_TRUST.text, /Plyloft never answers that for you/);
assert.match(SETUP_TRUST.text, /Settings › Setup and account › Diagnostics/);
// 1.171.0 D2 (FR-14): the easy way out says what it costs.
assert.match(SETUP_TRUST.text, /Until you do, Claude can't review your cards\./);
assert.equal(SETUP_TRUST.later, "Later (reviews wait)");
assert.equal(leaveSheet(TRUST_ACTION).title, "Stop Claude?");
assert.match(leaveSheet(TRUST_ACTION).body, /Settings › Setup and account › Diagnostics/);
assert.match(leaveSheet(TRUST_ACTION).body, /Stop it, or keep going/, "the words name the sheet's own buttons");

// 1.179.0 (C1): a Claude account's sign-in or sign-out is Settings' run,
// never the AI step's own (it would otherwise read as `login.claude`'s).
for (const id of ["login-account.claude", "logout-account.claude"]) {
  assert.equal(isAccountAction(id), true, id);
  assert.equal(toolOfAction(id), null, id);
  assert.equal(isAiStepAction(id), false, id);
  assert.equal(holdsAiStep(id), false, id);
}
assert.equal(isAccountAction("login.claude"), false);
assert.equal(isAiStepAction("login.claude"), true);

// 1.176.0 R4 (M3): a Repair's run is no AI step's install or sign-in.
for (const id of ["repair-install.claude", "repair-chown.claude", "repair-npm-remove.codex", "repair-chown.codex"]) {
  assert.equal(toolOfAction(id), null, id);
  assert.equal(isAiStepAction(id), false, id);
  assert.equal(holdsAiStep(id), false, id);
}
{
  const claude = toolFacts({ found: true, versionOk: true, installCmd: "x" });
  const answer: SignIn = { kind: "answer", answer: { signedIn: true, method: "claude.ai", plan: "max", words: null } };
  const row = toolRow("claude", claude, answer, {
    actionId: "repair-chown.claude" as typeof TRUST_ACTION,
    phase: "running",
    outcome: null,
  });
  assert.equal(row.state, "ready", "a repair's chown is not a sign-in");
  assert.doesNotMatch(row.words, /signing in/i);
}

// 1.176.0 R6: Repair is offered after a failed install or update of Claude Code or Codex.
for (const outcome of ["failed", "timed-out", "still-on-old-version", "older-version-now", "not-observed", "could-not-tell"] as const) {
  assert.equal(repairToolAfter("update.claude", outcome), "claude", outcome);
  assert.equal(repairToolAfter("install.codex", outcome), "codex", outcome);
}
for (const outcome of ["succeeded", "cancelled", "nothing-newer", null] as const) {
  assert.equal(repairToolAfter("update.claude", outcome), null, String(outcome));
}
assert.equal(repairToolAfter("install.git", "failed"), null);
// Ended without the tool working: a block; with it working: none.
const quiet = notStartingError("install.claude", "not-observed", false, [], "curl …");
assert.equal(quiet?.title, "Claude Code doesn't start yet.");
assert.equal(notStartingError("install.claude", "not-observed", true, [], "curl …"), null);
assert.equal(notStartingError("install.claude", "failed", false, [], "curl …"), null);
assert.equal(notStartingError("login.claude", "not-observed", false, [], "x"), null);
assert.equal(repairToolAfter("update.gh", "failed"), null);
assert.equal(repairToolAfter("login.claude", "failed"), null);

// 1.176.1: the owner's installer ended `exit 127` for want of curl, with a
// Program folders setting that held no folder.
const notFound = runFailure("install.claude", "failed", 127, ["bash: line 1: curl: command not found"], "x", { cause: "command-not-found", causePath: "curl" }, true)!;
assert.equal(notFound.happened, "Claude Code's installer needed the curl command and couldn't find it.");
assert.match(notFound.todo, /Program folders in Settings › Look and feel › Editor and terminals may leave it out/);
const notFoundNoSetting = runFailure("update.codex", "failed", 127, [], "x", { cause: "command-not-found", causePath: null })!;
assert.equal(notFoundNoSetting.happened, "Codex's updater needed a command it couldn't find.");
assert.doesNotMatch(notFoundNoSetting.todo, /Program folders/);
// 1.176.1 walk: with Program folders set, a tool missing from the snapshot
// is "not in your Program folders", and its press opens that row.
{
  const v = toolRow("claude", missing, unread, null, true);
  assert.deepEqual([v.state, v.words, v.action?.id, v.action?.label], ["missing", "Not in your Program folders.", "program-folders", "Open Program folders"]);
  assert.equal(runActionFor("claude", "program-folders"), null, "it never starts an installer");
}

// 1.176.4 (setup lane, item 3): the AI step says what each action does.
{
  const missing = (tool: "claude" | "codex") =>
    toolRow(tool, { found: false, works: false, update: null, installCmd: "x" }, { kind: "unread" }, null);
  const rows = [missing("claude"), missing("codex")];
  // (a) only the one the person chose is filled.
  assert.equal(installTone("primary", true), "accent");
  assert.equal(installTone("primary", false), "strong", "both chosen: today's weights");
  assert.equal(installTone("normal", false), "strong", "none chosen: today's weights");
  assert.equal(installTone("also", true), "quiet");
  // (c) one line per Install, naming what it downloads and from where.
  const lines = installLines(rows, false, true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Anthropic/);
  assert.match(lines[0], /claude\.ai/);
  assert.match(lines[1], /OpenAI/);
  assert.match(lines[1], /chatgpt\.com/);
  assert.doesNotMatch(lines.join(" "), /Windows|Mac/, "no machine name where the part doesn't apply");
  const win = installLines([rows[0]], true, false);
  assert.match(win[0], /Git for Windows/);
  assert.match(win[0], /Windows may ask for an administrator's permission\./);
  assert.doesNotMatch(installLines([rows[1]], true, false)[0], /Windows may ask/, "Codex needs no administrator");
  // a row with no Install action has no line
  const ready = toolRow("claude", { found: true, works: true, update: null, installCmd: "x" }, { kind: "answer", answer: { signedIn: true, method: null, plan: null, words: null } }, null);
  assert.deepEqual(installLines([ready], false, true), []);
  // (b) why Continue is disabled
  const F = (found: boolean, works: boolean, starts?: boolean) => ({ found, works, starts, update: null, installCmd: "x" });
  const none = { claude: F(false, false), codex: F(false, false) };
  assert.match(aiContinueReason({ running: true, aiReady: false, facts: none }) ?? "", /still/);
  assert.match(aiContinueReason({ running: false, aiReady: false, facts: { ...none, claude: F(true, true) } }) ?? "", /Sign in/);
  assert.match(aiContinueReason({ running: false, aiReady: false, facts: none }) ?? "", /Install/);
  assert.equal(aiContinueReason({ running: false, aiReady: null, facts: none }), null, "nothing is known yet: nothing is said");
  assert.equal(
    aiContinueReason({ running: false, aiReady: false, facts: { ...none, claude: F(true, false, true) } }),
    "Claude Code: Installed but too old. Update it to use it with Plyloft. Or press Skip for now.",
  );
  assert.equal(
    aiContinueReason({ running: false, aiReady: false, facts: { ...none, codex: F(true, false) } }),
    "Codex: Installed but not starting. Reinstall it. Or press Skip for now.",
  );
  assert.equal(
    aiContinueReason({ running: false, aiReady: false, facts: { claude: F(true, false, true), codex: F(true, false) } }),
    "Claude Code: Installed but too old. Update it to use it with Plyloft. Codex: Installed but not starting. Reinstall it. Or press Skip for now.",
    "both broken: both are named",
  );
  assert.equal(
    aiContinueReason({ running: false, aiReady: false, facts: { claude: F(true, false, true), codex: F(true, true) } }),
    "Sign in to Codex to go on, or press Skip for now.",
    "the quicker action when one tool only needs a sign-in",
  );
  // (d)
  assert.match(AI_SUBSCRIPTION_LINE, /Anthropic or OpenAI/);
}

console.log("aiTools: ok");
