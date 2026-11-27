// 1.176.0 R7: a Claude or Codex tile that didn't start, told apart from a
// session the person ended or a CLI that ran and refused. Repair only on a
// confirmed cause: a refused spawn, or the backend's certain "fails".
// Run: node --experimental-strip-types src/lib/startFailure.test.ts
import assert from "node:assert/strict";
import {
  CODEX_CHAT_DIED_AT_ONCE,
  DIED_AT_ONCE_MS,
  codexChatAsksBackend,
  codexChatStartFailure,
  exitAsksBackend,
  loadFailureSignal,
  repairLabel,
  resumesConversation,
  setsUpScreen,
  spawnStartFailure,
  startFailureLine,
  terminalWayOn,
  verdictStartFailure,
  type ExitFacts,
  type StartVerdict,
} from "./startFailure.ts";

const quick: ExitFacts = {
  cli: "claude",
  code: 1,
  elapsedMs: 400,
  typed: false,
  closedByPlyloft: false,
  drewScreen: false,
  resumed: false,
  output: "",
};

/** The whole rule, as a tile runs it: ask the backend only when worth it,
 *  then Repair only on its "fails". */
function offersRepair(f: ExitFacts, backend: StartVerdict): boolean {
  return exitAsksBackend(f) && verdictStartFailure(f.cli!, backend) !== null;
}

// A broken payload: asked, and the backend confirms → Repair.
const broken = { ...quick, output: "Error: Cannot find module '/Users/me/.local/share/claude/versions/2.1.9/cli.js'\r\n" };
assert.equal(offersRepair(broken, "fails"), true);
assert.equal(offersRepair({ ...quick, cli: "codex", code: 127, output: "env: node: No such file or directory\r\n" }, "fails"), true);
// The backend can't tell (slow, mid-update) → neutral.
assert.equal(offersRepair(broken, "unknown"), false);
assert.equal(offersRepair(broken, "starts"), false);

// The CLI ran and refused: it still answers `--version`, so neutral.
for (const output of [
  "error: unknown option '--frobnicate'\r\n", // a template's bad flag
  "Error loading config.toml: invalid type: string, expected a map\r\n", // a broken Codex config
  "--dangerously-skip-permissions cannot be used with root/sudo privileges\r\n", // a refused permission flag
  "Invalid API key · Please run /login\r\n", // not signed in
  "Unable to connect to API (ENOTFOUND)\r\n", // no network
]) {
  const f = { ...quick, output };
  assert.equal(exitAsksBackend(f), true, `asked: ${output}`);
  assert.equal(offersRepair(f, "starts"), false, `neutral: ${output}`);
}
// Windows: ConPTY swallowed the modes, a healthy tool ended quickly → neutral.
assert.equal(offersRepair({ ...quick, windows: true, output: "error: unknown option\r\n" }, "starts"), false);

// Never asked (so never Repair):
assert.equal(exitAsksBackend({ ...quick, cli: null }), false, "a shell");
assert.equal(exitAsksBackend({ ...quick, code: 0 }), false, "a clean quit");
assert.equal(exitAsksBackend({ ...quick, code: 130 }), false, "Ctrl-C");
assert.equal(exitAsksBackend({ ...quick, code: -1073741510, windows: true }), false, "Ctrl-C on Windows");
assert.equal(exitAsksBackend({ ...quick, code: null }), false, "no code");
assert.equal(exitAsksBackend({ ...quick, typed: true }), false, "the person typed");
assert.equal(exitAsksBackend({ ...broken, typed: true }), false, "typed, even with a load error");
assert.equal(exitAsksBackend({ ...quick, closedByPlyloft: true }), false, "Plyloft stopped it");
assert.equal(exitAsksBackend({ ...broken, closedByPlyloft: true }), false);
assert.equal(exitAsksBackend({ ...quick, elapsedMs: DIED_AT_ONCE_MS + 1 }), false, "past the window");
assert.equal(exitAsksBackend({ ...quick, drewScreen: true }), false, "it set up its screen");
assert.equal(exitAsksBackend({ ...quick, elapsedMs: -5 }), false);
assert.equal(
  exitAsksBackend({ ...quick, resumed: true, output: "No conversation found with session ID: 1234\r\n" }),
  false,
  "a resumed conversation that is gone",
);
// A load error asks even past the window or after a screen.
assert.equal(exitAsksBackend({ ...broken, elapsedMs: DIED_AT_ONCE_MS * 3 }), true);
assert.equal(exitAsksBackend({ ...broken, drewScreen: true }), true);
assert.equal(exitAsksBackend({ ...quick, resumed: true }), true, "resumed, nothing about its session");
assert.equal(verdictStartFailure("codex", "fails")?.cause, "stoppedAtOnce");
assert.equal(verdictStartFailure("codex", null), null);

// The load signals.
for (const code of [126, 127, 9009, -1073741515]) assert.ok(loadFailureSignal(code, ""), String(code));
for (const words of [
  "dyld[123]: Library not loaded: @rpath/libnode.dylib",
  "zsh: bad CPU type in executable",
  "Exec format error",
  "/bin/sh: claude: cannot execute binary file",
  "'codex' is not recognized as an internal or external command,",
  "Error: Cannot find module 'x'",
])
  assert.ok(loadFailureSignal(1, words), words);
assert.equal(loadFailureSignal(1, "error: unknown option"), false);

// The screen set-up, as the two CLIs send it (measured), and not otherwise.
assert.ok(setsUpScreen("\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h")); // Claude Code
assert.ok(setsUpScreen("\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h")); // Codex
assert.ok(setsUpScreen("x\x1b[?1;1049h"));
assert.equal(setsUpScreen("\x1b[?25l\x1b[?25h plain error"), false);
assert.equal(setsUpScreen("\x1b[?2004l"), false);
assert.equal(setsUpScreen("\x1b[?12004h"), false);

// Resuming, by the tile's arguments.
assert.equal(resumesConversation("claude", ["--resume", "abc"]), true);
assert.equal(resumesConversation("claude", ["--session-id", "abc"]), false);
assert.equal(resumesConversation("codex", ["resume", "abc"]), true);
assert.equal(resumesConversation(null, ["--resume", "x"]), false);

// A refused spawn: Repair at once.
const gone =
  'PLY_CLI_UNAVAILABLE_V1:{"tool":"codex","was":"/opt/homebrew/bin/codex"}\ncodex: not found in PATH; it was at /opt/homebrew/bin/codex.';
assert.deepEqual(spawnStartFailure("codex", gone), { tool: "codex", cause: "gone" });
assert.deepEqual(spawnStartFailure("claude", "spawn: Permission denied (os error 13)"), { tool: "claude", cause: "wontRun" });
assert.equal(spawnStartFailure(undefined, "spawn: Permission denied (os error 13)"), null);
assert.equal(spawnStartFailure("claude", "provider terminal requires a project cwd"), null);

// Words.
assert.equal(repairLabel("claude"), "Repair Claude Code");
assert.match(startFailureLine({ tool: "claude", cause: "stoppedAtOnce" }), /^Claude Code didn't start: it stopped as soon as it started/);
assert.match(startFailureLine({ tool: "codex", cause: "gone" }), /^Codex didn't start: Plyloft can't find it on this (Mac|PC) any more\.$/);
assert.equal(startFailureLine({ tool: "claude", cause: "gone" }, true), "Claude Code didn't start: Plyloft can't find it in the Program folders you set.");
assert.equal(terminalWayOn({ tool: "codex", cause: "gone" }), "Press Repair Codex above, or Restart.");
assert.doesNotMatch(terminalWayOn(null), /Setup checks/);

// codex-chat.
assert.equal(codexChatStartFailure(gone).repair, true);
assert.deepEqual(
  codexChatStartFailure('PLY_CLI_NOT_STARTING_V1:{"tool":"codex"}\nCodex CLI is installed at /x but doesn\'t start — …'),
  { sentence: "Codex couldn't start: it is installed but not starting.", repair: true },
);
// The old text without the mark is not read any more.
assert.equal(codexChatStartFailure("Codex CLI is installed at /x but doesn't start — …").repair, false);
assert.equal(codexChatStartFailure("spawn Codex App Server: No such file or directory (os error 2)").repair, true);
assert.equal(codexChatStartFailure("workspace directory does not exist").repair, false);
const chat = { code: 1, elapsedMs: 300, answered: false, stoppedByPlyloft: false, stderr: "" };
assert.equal(codexChatAsksBackend(chat), true);
assert.equal(codexChatAsksBackend({ ...chat, answered: true }), false, "it answered: it started");
assert.equal(codexChatAsksBackend({ ...chat, stoppedByPlyloft: true }), false, "Restart pressed before the first answer");
assert.equal(codexChatAsksBackend({ ...chat, code: 0 }), false);
assert.equal(codexChatAsksBackend({ ...chat, code: null }), false);
assert.equal(codexChatAsksBackend({ ...chat, elapsedMs: DIED_AT_ONCE_MS + 1 }), false);
assert.equal(codexChatAsksBackend({ ...chat, elapsedMs: DIED_AT_ONCE_MS + 1, stderr: "Error: Cannot find module 'x'" }), true);
// A config error before the first answer: asked, but Codex answers `--version` → no Repair.
assert.equal(verdictStartFailure("codex", "starts"), null);
assert.match(CODEX_CHAT_DIED_AT_ONCE, /^Codex couldn't start/);

console.log("startFailure: ok");
