// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/tryPanel.test.ts
import assert from "node:assert/strict";
import type { CardPresentationState, TryCommandView } from "../ipc.ts";
import {
  TRY_SHEET_STATIC,
  SETTLE_MS,
  TryOutputTail,
  TryTypedEcho,
  askWords,
  commandEnded,
  emptyRun,
  hostPortOf,
  QUICK_EXIT_SENTENCE,
  missingTool,
  ranWords,
  sheetStart,
  tryItOffered,
  tryPreflight,
  tryStatus,
  typedAddress,
  typedAddressProblem,
  withoutPromptLine,
  SETUP_FIELD_LABEL,
  setupToSave,
} from "./tryPanel.ts";

// ── When Try it is offered ────────────────────────────────────────────
const copy = { worktreePath: "/r/.plyloft-worktrees/c1" };
for (const state of ["ready-to-ship", "changes-requested", "result-ready", "review-stale", "verify-failed"] as CardPresentationState[]) {
  assert.equal(tryItOffered(copy, state, false), true, state);
}
for (const state of ["draft", "ready", "running", "queued", "session-closed"] as CardPresentationState[]) {
  assert.equal(tryItOffered(copy, state, false), false, `${state}: no change yet`);
}
// The Builder stopped with a saved round: changes are there.
assert.equal(tryItOffered({ ...copy, builder: { snapshots: [{}] } }, "running", false), true);
// Never after Ship, archived, on a pull request or with no copy.
assert.equal(tryItOffered({ ...copy, builder: { snapshots: [{}] } }, "shipped", false), false);
assert.equal(tryItOffered({ ...copy, archived: true }, "ready-to-ship", false), false);
assert.equal(tryItOffered({ ...copy, prReview: {} }, "ready-to-ship", false), false);
assert.equal(tryItOffered({ worktreePath: null }, "ready-to-ship", false), false);
// Built by both: once a build is done.
const both = (done: boolean) => ({ buildBoth: { lanes: [{ worktreePath: "/a", done: done ? { sha: "s", at: 1 } : null }, { worktreePath: "/b" }] } });
assert.equal(tryItOffered(both(false), "running", true), false);
assert.equal(tryItOffered(both(true), "running", true), true);

// ── Pre-flight ────────────────────────────────────────────────────────
const view = (over: Partial<TryCommandView> = {}) => ({
  command: "npm run dev" as string | null,
  approved: true,
  shared: false,
  readOnly: false,
  ...over,
});
assert.deepEqual(tryPreflight({ view: view({ command: null }), needsPackages: null, setup: null }), { kind: "sheet" });
assert.deepEqual(tryPreflight({ view: view({ command: "  " }), needsPackages: null, setup: null }), { kind: "sheet" });
assert.deepEqual(tryPreflight({ view: view({ approved: false }), needsPackages: { command: "npm ci" }, setup: null }), {
  kind: "ask",
  ask: { kind: "approve", command: "npm run dev" },
});
assert.deepEqual(
  tryPreflight({ view: view(), needsPackages: { command: "npm ci" }, setup: { command: "npm ci", approved: "npm ci" } }),
  { kind: "ask", ask: { kind: "install", setup: "npm ci", approved: true } },
);
assert.deepEqual(
  tryPreflight({ view: view(), needsPackages: { command: "npm ci" }, setup: { command: "npm ci", approved: null } }),
  { kind: "ask", ask: { kind: "install", setup: "npm ci", approved: false } },
);
// The lockfile's install (its frozen form: the copy's lockfile never
// changes), whatever the command runs.
assert.deepEqual(
  tryPreflight({
    view: view({ command: "npm run dev", shared: true }),
    needsPackages: { command: "pnpm install --frozen-lockfile" },
    setup: { command: null, approved: null },
  }),
  { kind: "ask", ask: { kind: "setUp", install: "pnpm install --frozen-lockfile", shared: true, readOnly: false } },
);
assert.deepEqual(
  tryPreflight({ view: view({ shared: true, readOnly: true }), needsPackages: { command: "npm ci" }, setup: null }),
  { kind: "ask", ask: { kind: "setUp", install: "npm ci", shared: true, readOnly: true } },
);
assert.deepEqual(
  tryPreflight({ view: view(), needsPackages: { command: "npm install" }, setup: null }),
  { kind: "ask", ask: { kind: "setUp", install: "npm install", shared: false, readOnly: false } },
  "no lockfile: the plain install",
);
// Challenger: with no lockfile the copy's install writes none; Yarn 2+,
// which can't, says it creates yarn.lock in the copy.
assert.deepEqual(
  tryPreflight({ view: view(), needsPackages: { command: "npm install --no-package-lock", creates: null }, setup: null }),
  { kind: "ask", ask: { kind: "setUp", install: "npm install --no-package-lock", shared: false, readOnly: false } },
);
const berry = tryPreflight({ view: view(), needsPackages: { command: "yarn install", creates: "yarn.lock" }, setup: null });
assert.ok(berry.kind === "ask");
assert.equal(
  askWords(berry.ask, "mac").sentence,
  'Cards\' copies start without packages. Plyloft can install them in each new copy with the setup command below. It\'s saved for this repository when you press Set it up and try. It also creates yarn.lock in the card\'s copy.',
);
assert.equal(
  askWords({ kind: "setUp", install: "npm install --no-package-lock", shared: false, readOnly: false }, "mac").sentence,
  'Cards\' copies start without packages. Plyloft can install them in each new copy with the setup command below. It\'s saved for this repository when you press Set it up and try.',
);
assert.deepEqual(tryPreflight({ view: view(), needsPackages: null, setup: null }), { kind: "start", command: "npm run dev" });

// The words: the worktree setup's approval pattern, this PC on Windows.
assert.deepEqual(askWords({ kind: "approve", command: "npm run dev" }, "mac"), {
  sentence: '"npm run dev" comes from this repository and hasn\'t run on this Mac before.',
  action: "Allow and run",
});
assert.match(askWords({ kind: "approve", command: "npm run dev" }, "windows").sentence, /this PC/);
assert.deepEqual(askWords({ kind: "install", setup: "npm ci", approved: true }, "mac"), {
  sentence: "This copy needs its packages first.",
  action: "Install and try",
});
assert.equal(askWords({ kind: "install", setup: "npm ci", approved: false }, "mac").action, "Allow and run");
assert.deepEqual(askWords({ kind: "setUp", install: "npm install", shared: false, readOnly: false }, "mac"), {
  sentence: 'Cards\' copies start without packages. Plyloft can install them in each new copy with the setup command below. It\'s saved for this repository when you press Set it up and try.',
  action: "Set it up and try",
});
assert.equal(askWords({ kind: "setUp", install: "npm install", shared: true, readOnly: true }, "mac").action, "Install them this time");
// 1.168.1 B4: the setup command is never in the sentence alone — it is the
// field below it, and Set it up and try saves what the field holds.
assert.doesNotMatch(askWords({ kind: "setUp", install: "npm install", shared: false, readOnly: false }, "mac").sentence, /npm install/);
assert.equal(SETUP_FIELD_LABEL, "Before the Builder starts, run");
assert.equal(setupToSave("  pnpm install  "), "pnpm install");
assert.equal(setupToSave("   "), null);
// The lockfile note is the suggestion's: gone once the field says otherwise.
{
  const berryAsk = { kind: "setUp" as const, install: "yarn install", shared: false, readOnly: false, creates: "yarn.lock" };
  assert.match(askWords(berryAsk, "mac", "yarn install").sentence, /creates yarn\.lock/);
  assert.match(askWords(berryAsk, "mac").sentence, /creates yarn\.lock/);
  assert.doesNotMatch(askWords(berryAsk, "mac", "yarn install --immutable").sentence, /yarn\.lock/);
}

// ── The sheet ─────────────────────────────────────────────────────────
assert.deepEqual(sheetStart(null), { kind: "nothing", text: "" });
assert.deepEqual(
  sheetStart({ command: null, detection: { kind: "packageScript", command: "npm run dev", script: "dev", packageManager: "npm" } }),
  { kind: "suggested", text: "npm run dev" },
);
assert.deepEqual(sheetStart({ command: null, detection: { kind: "staticSite", file: "index.html" } }), { kind: "staticSite", text: "" });
assert.deepEqual(sheetStart({ command: "make serve", detection: { kind: "none" } }), { kind: "suggested", text: "make serve" });
assert.equal(TRY_SHEET_STATIC, "This looks like a plain website.");

// ── The status ────────────────────────────────────────────────────────
const run = emptyRun("npm run dev");
assert.deepEqual(tryStatus(run, "mac"), { dot: "running", live: true, word: "Starting your app…", sentence: null });
assert.deepEqual(tryStatus({ ...run, noAddress: true }, "mac"), {
  dot: "running",
  live: false,
  word: "Started",
  sentence: "Your app started but Plyloft can't see its address.",
});
const running = { ...run, phase: "running" as const, address: "http://localhost:41003/" };
assert.deepEqual(tryStatus(running, "mac"), { dot: "done", live: false, word: "Running on localhost:41003", sentence: null });
assert.equal(
  tryStatus({ ...running, address: "https://localhost:41003/", secure: true }, "mac").sentence,
  "This app uses a secure address. Open it in your browser.",
);
assert.equal(tryStatus({ ...run, phase: "stopped" }, "mac").dot, "empty");
const failed = tryStatus({ ...run, phase: "failed" }, "mac");
assert.equal(failed.dot, "aborted");
assert.equal(failed.word, "Couldn't start");
assert.equal(
  failed.sentence,
  "Your app stopped while starting. Nothing in your project changed. The last lines it printed are below.",
);
assert.equal(
  tryStatus({ ...run, phase: "failed", blocked: "scripts", cmdForm: "npm.cmd run dev" }, "windows").sentence,
  "Windows blocked a script this command needs. Plyloft can run it the other way:",
);
// A quick exit has its own words, with or without the .cmd form on offer.
assert.equal(tryStatus({ ...run, phase: "failed", quickExit: true }, "mac").sentence, QUICK_EXIT_SENTENCE);
assert.equal(
  tryStatus({ ...run, phase: "failed", quickExit: true, blocked: "quickExit", cmdForm: "npm.cmd run dev" }, "windows").sentence,
  "Your app stopped right after starting. Nothing in your project changed. The last lines it printed are below.",
);
// The project's strip says the same.
assert.equal(tryStatus({ ...run, phase: "failed", quickExit: true }, "mac", "project").sentence, QUICK_EXIT_SENTENCE);
// A missing tool is named.
assert.match(
  tryStatus({ ...run, phase: "failed", lines: ["zsh: command not found: npm"] }, "mac").sentence!,
  /Plyloft couldn't start "npm"\. Is Node\.js installed\?$/,
);
assert.equal(missingTool(["npm : The term 'npm' is not recognized as the name of a cmdlet"], "npm run dev"), "npm");
assert.equal(missingTool(["'npm' is not recognized as an internal or external command"], "npm run dev"), "npm");
assert.equal(missingTool(["vite v5 ready"], "npm run dev"), null);

assert.equal(hostPortOf("http://127.0.0.1:8000/admin"), "127.0.0.1:8000");
assert.equal(ranWords({ command: "npm run dev", address: "http://localhost:41003/" }, null), 'Ran "npm run dev" in the card\'s copy · port 41003');
assert.equal(ranWords({ command: "npm run dev", address: null }, "Codex"), 'Ran "npm run dev" in Codex\'s copy');

// ── A typed address: loopback only ────────────────────────────────────
assert.equal(typedAddressProblem("localhost:3000", "mac"), null);
assert.equal(typedAddress("localhost:3000"), "http://localhost:3000/");
assert.equal(typedAddress("http://[::1]:5173/x"), "http://[::1]:5173/x");
assert.match(typedAddressProblem("http://example.com", "mac")!, /^Only an address on this Mac/);
assert.match(typedAddressProblem("http://192.168.1.4:3000", "windows")!, /this PC/);
assert.equal(typedAddress("http://evil.test:80@localhost:3000"), null);

// ── When the command ended (Windows walk 2026-10-20) ──────────────────
{
  const at = (over: Partial<Parameters<typeof commandEnded>[0]>) =>
    commandEnded({
      tileStatus: "running",
      running: false,
      sawRunning: false,
      goneLooks: 0,
      promptBack: false,
      echoSeen: true,
      outputAfterEcho: true,
      msSinceTyped: 5_000,
      ...over,
    });
  // (c) The tile's shell ended: always.
  assert.equal(at({ tileStatus: "done", msSinceTyped: 0, outputAfterEcho: false }), true);
  assert.equal(at({ tileStatus: "crashed", running: true }), true);
  // "Nothing runs" alone is never an end: on Windows it is also what the
  // job says before PowerShell started the command.
  assert.equal(at({}), false);
  assert.equal(at({ msSinceTyped: 60_000 }), false);
  // (a) Seen running, then gone on two looks in a row.
  assert.equal(at({ sawRunning: true, goneLooks: 1 }), false);
  assert.equal(at({ sawRunning: true, goneLooks: 2 }), true);
  assert.equal(at({ sawRunning: true, goneLooks: 2, running: true }), false);
  assert.equal(at({ sawRunning: true, goneLooks: 2, running: null }), false);
  // (b) The prompt came back after the typed line.
  assert.equal(at({ promptBack: true }), true);
  assert.equal(at({ promptBack: true, running: null }), true, "the prompt is enough where the PTY can't say");
  assert.equal(at({ promptBack: true, running: true }), false, "something still runs");
  // Never before SETTLE_MS, never with nothing printed after the echo.
  assert.equal(at({ promptBack: true, msSinceTyped: SETTLE_MS - 1 }), false);
  assert.equal(at({ sawRunning: true, goneLooks: 3, msSinceTyped: 1_000 }), false);
  assert.equal(at({ promptBack: true, outputAfterEcho: false }), false);
  assert.equal(at({ sawRunning: true, goneLooks: 2, outputAfterEcho: false }), false);
  // OSC 133 D after the echo: always, even while something seems to run.
  assert.equal(at({ commandDone: true, running: true, msSinceTyped: 100, outputAfterEcho: false }), true);
  // The Mac's line editor editing its prompt again, once the echo was seen.
  assert.equal(at({ promptEditing: true, msSinceTyped: 600, outputAfterEcho: false }), true);
  assert.equal(at({ promptEditing: true, msSinceTyped: 400 }), false);
  assert.equal(at({ promptEditing: true, echoSeen: false }), false);
  assert.equal(at({ promptEditing: true, running: true }), false);
  // Unix: two "nothing runs" looks a second apart, with output after the echo.
  assert.equal(at({ goneForMs: 1_000, msSinceTyped: 1_500 }), true);
  assert.equal(at({ goneForMs: 900, msSinceTyped: 1_400 }), false, "too close together");
  assert.equal(at({ goneForMs: 1_000, outputAfterEcho: false }), false);
  assert.equal(at({ goneForMs: 1_000, echoSeen: false }), false);
  assert.equal(at({ goneForMs: 1_000, running: null }), false);
}

// ── What came after the typed line ────────────────────────────────────
{
  // zsh: the echo, npm's error, the prompt back (no newline after it).
  const zsh = new TryTypedEcho("npm run nope");
  zsh.feed("npm run nope\r\n");
  assert.equal(zsh.echoSeen, true);
  assert.equal(zsh.outputAfterEcho, false, "the echo alone is not the command's output");
  assert.equal(zsh.promptBack, false);
  zsh.feed('npm error Missing script: "nope"\r\n');
  assert.equal(zsh.outputAfterEcho, true);
  assert.equal(zsh.promptBack, false);
  zsh.feed("me@Mac-mini card-c1 % ");
  assert.equal(zsh.promptBack, true);
  // Details: what the command printed, not the line before it.
  assert.deepEqual(withoutPromptLine(zsh.linesAfter()!), ['npm error Missing script: "nope"']);
  assert.equal(new TryTypedEcho("npm run dev").linesAfter(), null, "nothing until the echo");

  // PowerShell under ConPTY: colours, a wrapped echo, CSI H repaints, and a
  // long prompt broken in two by the repaint.
  const ps = new TryTypedEcho("npm.cmd run dev '--' --port 41080");
  ps.feed("\u001b[?25l\u001b[93mnpm.cmd\u001b[0m run dev \u001b[90m'--'\u001b[0m --po\u001b[2;1Hrt 41080\u001b[?25h");
  assert.equal(ps.echoSeen, true, "spaces and line breaks don't hide the echo");
  assert.equal(ps.outputAfterEcho, false);
  ps.feed("\r\n\u001b[3;1H> vite --port 41080\u001b[K");
  assert.equal(ps.outputAfterEcho, true);
  assert.equal(ps.promptBack, false, "npm's own '> vite' line is not a prompt");
  ps.feed("\u001b[5;1HPS C:\\ply-test\\vite-app\\.plyloft-worktrees\\card-\u001b[6;1Hmvgu7ie8-0> ");
  assert.equal(ps.promptBack, true);

  // A line editor that draws the line again on Enter: the last echo counts.
  const redraw = new TryTypedEcho("npm run dev");
  redraw.feed("npm run dev\u001b[1;1HPS C:\\r> npm run dev\r\n");
  assert.equal(redraw.outputAfterEcho, false);
  // A themed prompt's mark.
  const themed = new TryTypedEcho("npm run nope");
  themed.feed("npm run nope\r\nnpm error Missing script\r\n~/r/c1 on main ❯ ");
  assert.equal(themed.promptBack, true);
  // Nothing echoed at all (never seen): the first line is taken as the echo.
  const silent = new TryTypedEcho("npm run dev");
  silent.feed("something else\r\n");
  assert.equal(silent.outputAfterEcho, false);
  silent.feed("$ ");
  assert.equal(silent.promptBack, true);
}

// Challenger: the echo is found again only while the line is being entered.
{
  // PowerShell 5.1 quotes the line in its error block: that is output, and
  // the first sentence stays.
  const ps51 = new TryTypedEcho("npm.cmd run dev");
  ps51.feed("npm.cmd run dev\r\n");
  ps51.feed(
    "npm.cmd : The term 'npm.cmd' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n" +
      "Check the spelling of the name, or if a path was included, verify that the path is correct and try again.\r\n" +
      "At line:1 char:1\r\n+ npm.cmd run dev\r\n+ ~~~~~~~\r\n" +
      "    + CategoryInfo          : ObjectNotFound: (npm.cmd:String) [], CommandNotFoundException\r\n" +
      "    + FullyQualifiedErrorId : CommandNotFoundException\r\n \r\nPS C:\\r\\c1> ",
  );
  const kept = withoutPromptLine(ps51.linesAfter()!);
  assert.match(kept[0], /^npm\.cmd : The term 'npm\.cmd' is not recognized/);
  assert.ok(kept.includes("+ npm.cmd run dev"));
  assert.equal(ps51.promptBack, true);

  // A `>>` continuation prompt is PowerShell waiting for more, not the
  // prompt back.
  const more = new TryTypedEcho("npm run dev '");
  more.feed("npm run dev '\r\n>> ");
  assert.equal(more.promptBack, false);

  // An echo split in the middle of a word by a cursor move.
  const split = new TryTypedEcho("npm.cmd run dev");
  split.feed("npm.c\u001b[2;1Hmd run dev\r\nnpm error boom\r\n");
  assert.equal(split.echoSeen, true);
  assert.deepEqual(split.linesAfter(), ["npm error boom"]);

  // PSReadLine's grey prediction after the cursor, cleared on Enter.
  const predicted = new TryTypedEcho("npm run dev");
  predicted.feed("npm run dev\u001b[38;5;238m -- --port 3000\u001b[0m\u001b[15D");
  assert.equal(predicted.outputAfterEcho, false, "the prediction is not output");
  predicted.feed("\u001b[K\r\n");
  assert.equal(predicted.outputAfterEcho, false);
  assert.deepEqual(predicted.linesAfter(), []);
  predicted.feed("> vite\r\n");
  assert.deepEqual(predicted.linesAfter(), ["> vite"]);

  // OSC 133 D after the entered line: the command finished; one before it
  // (the last prompt's) is not.
  const marked = new TryTypedEcho("npm run nope");
  marked.feed("\u001b]133;D;0\u0007npm run nope");
  assert.equal(marked.commandDone, false);
  marked.feed("\r\nnpm error Missing script\r\n\u001b]133;D;1\u001b\\\u001b]133;A\u0007➜  c1 git:(main) ✗ ");
  assert.equal(marked.commandDone, true);
}

// ConPTY repaints npm's error with cursor moves, not newlines: every line
// reaches the last lines.
{
  const conpty = new TryOutputTail();
  conpty.feed("\u001b[?25l\u001b[4;1H> npm.cmd run nope\u001b[K\u001b[5;1Hnpm error Missing script: \"nope\"\u001b[K");
  conpty.feed("\u001b[6;1Hnpm error\u001b[K\u001b[7;1Hnpm error To see a list of scripts, run:\u001b[K\u001b[8;1Hnpm error   npm run\u001b[K\u001b[?25h");
  conpty.feed("\r\n\u001b[10;1HPS C:\\r\\c1> ");
  assert.deepEqual(withoutPromptLine(conpty.read()), [
    "> npm.cmd run nope",
    'npm error Missing script: "nope"',
    "npm error",
    "npm error To see a list of scripts, run:",
    "npm error   npm run",
  ]);
}

// ── TI-5: the project folder after Ship ───────────────────────────────
{
  const allowed = { command: "npm run dev", approved: true, shared: true, readOnly: false };
  // No packages there: the backend's install for that folder — never
  // worktree setup's ask, whatever a card's copy would get.
  assert.deepEqual(
    tryPreflight({
      view: allowed,
      needsPackages: { command: "pnpm install --frozen-lockfile" },
      setup: { command: "npm ci", approved: "npm ci" },
      project: true,
      projectInstall: { command: "pnpm install --frozen-lockfile", creates: null },
    }),
    { kind: "ask", ask: { kind: "projectInstall", install: "pnpm install --frozen-lockfile", creates: null } },
  );
  assert.deepEqual(tryPreflight({ view: allowed, needsPackages: { command: "npm ci" }, setup: null, project: true, projectInstall: null }), {
    kind: "start",
    command: "npm run dev",
  });
  // This machine's OK first, as for a card's copy.
  assert.deepEqual(
    tryPreflight({ view: { ...allowed, approved: false }, needsPackages: null, setup: null, project: true }),
    { kind: "ask", ask: { kind: "approve", command: "npm run dev" } },
  );
  assert.deepEqual(askWords({ kind: "projectInstall", install: "npm ci", creates: null }, "mac"), {
    sentence: 'Your project has no packages yet. Install them with "npm ci" in your project\'s folder?',
    action: "Install and try",
  });
  assert.equal(
    askWords({ kind: "projectInstall", install: "npm install", creates: "package-lock.json" }, "mac").sentence,
    'Your project has no packages yet. Install them with "npm install" in your project\'s folder? It also creates package-lock.json there.',
  );
  const failedInstall = { ...emptyRun("npm run dev"), phase: "failed" as const, installFailed: true };
  assert.equal(
    tryStatus(failedInstall, "mac", "project").sentence,
    "Installing the packages didn't finish. The last lines it printed are below.",
    "the install ran in the project itself: no claim that nothing changed",
  );
  assert.match(tryStatus(failedInstall, "mac").sentence ?? "", /Nothing in your project changed/);
  assert.equal(
    ranWords({ command: "npm run dev", address: "http://localhost:5173/" }, null, "project"),
    'Ran "npm run dev" in your project\'s folder · port 5173',
  );
}

// ── The output's last lines ───────────────────────────────────────────
const tail = new TryOutputTail(3);
tail.feed("\u001b[32mone\u001b[0m\r\ntwo\nthr");
tail.feed("ee\nfour\r\n");
assert.deepEqual(tail.read(), ["two", "three", "four"]);
tail.feed("half");
assert.deepEqual(tail.read(), ["three", "four", "half"]);
// A bare \r redraws the line: the progress bar's last state is the line.
const bar = new TryOutputTail(5);
bar.feed("start\nloading 10%\rloading 5");
bar.feed("0%\r");
bar.feed("loading 100%\r\ndone\n");
assert.deepEqual(bar.read(), ["start", "loading 100%", "done"]);

// ── The shell's prompt is not one of the last lines ───────────────────
const npmFail = ['npm error Missing script: "nope"', "npm error To see a list of scripts, run:"];
for (const prompt of [
  "example@Mac-mini---Agent card-mvgoh6va-0 %",
  "me@host ~ %",
  "me@box:~/app$",
  "root@box:/srv#",
  "bash-3.2$",
  "PS C:\\Users\\me\\app>",
  "PS>",
  "C:\\Users\\me\\app>",
  "$",
  "%",
]) {
  assert.deepEqual(withoutPromptLine([...npmFail, prompt]), npmFail, prompt);
}
// Output that merely has an @ and a mark at the end is kept.
assert.deepEqual(withoutPromptLine(["pkg@1.0.0 done 100%"]), ["pkg@1.0.0 done 100%"]);
assert.deepEqual(withoutPromptLine(["> my-app@0.0.0 dev"]), ["> my-app@0.0.0 dev"]);
assert.deepEqual(withoutPromptLine(["npm error x", "[me@box app]$"]), ["npm error x"]);
// Only the last line, and only a prompt's shape.
assert.deepEqual(withoutPromptLine(npmFail), npmFail);
assert.deepEqual(withoutPromptLine(["me@host ~ %", "Error: boom"]), ["me@host ~ %", "Error: boom"]);
assert.deepEqual(withoutPromptLine(["Downloading 100%"]), ["Downloading 100%"]);
assert.deepEqual(withoutPromptLine(["Email me@host.com for help"]), ["Email me@host.com for help"]);
assert.deepEqual(withoutPromptLine(["  VITE ready → http://localhost:5173/"]), ["  VITE ready → http://localhost:5173/"]);
assert.deepEqual(withoutPromptLine([]), []);

console.log("tryPanel tests passed");
