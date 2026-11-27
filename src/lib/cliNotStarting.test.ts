// 1.176.0 R7: the backend's typed "installed but doesn't start" refusal,
// read once for every surface (toast, error block), its mark never shown.
// Run: node --experimental-strip-types src/lib/cliNotStarting.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLI_NOT_STARTING_PREFIX,
  cliNotStartingIn,
  cliNotStartingSentence,
  cliNotStartingToast,
  cliRepairActionTool,
  decodeCliNotStarting,
  stripCliMarks,
  withCliRepair,
} from "./cliNotStarting.ts";
import { plainCause, plainFailure } from "./plainError.ts";
import { reviewerWords } from "./words.ts";
import type { UxError } from "./uxError.ts";

// The pair: the Rust constant is this one (`cli_fresh::NOT_STARTING_PREFIX`;
// cli_fresh_tests.rs reads this file the other way).
const rust = readFileSync(new URL("../../src-tauri/src/cli_fresh.rs", import.meta.url), "utf8");
assert.ok(rust.includes(`NOT_STARTING_PREFIX: &str = "${CLI_NOT_STARTING_PREFIX}"`), "the Rust prefix is the window's");

// As `cli_fresh::not_starting` writes it.
const mark = (tool: string, sentence: string) => `${CLI_NOT_STARTING_PREFIX}{"tool":"${tool}"}\n${sentence}`;
const REQUIRE =
  "Claude Code is installed at /Users/me/.local/bin/claude but doesn't start — its install is incomplete. Repair it in Settings › Setup and account › Diagnostics › Repair, or reinstall it yourself (curl …) and press Look again there.";
const RESUME = "Codex is installed on this Mac but doesn't start. This card's session was Codex's, so it can't resume until you repair Codex.";
const claude = mark("claude", REQUIRE);
const codexResume = mark("codex", RESUME);

assert.equal(decodeCliNotStarting(claude), "claude");
assert.equal(decodeCliNotStarting(new Error(codexResume)), "codex");
// Wrapped by its caller, the mark is found and stripped inside.
const wrapped = `No eligible reviewer: ${claude}`;
assert.equal(decodeCliNotStarting(wrapped), "claude");
assert.equal(stripCliMarks(wrapped), `No eligible reviewer: ${REQUIRE}`);
assert.equal(stripCliMarks(`Build with both needs Claude and Codex. ${codexResume}`), `Build with both needs Claude and Codex. ${RESUME}`);
// The words alone, without the mark, are not read: a wording change can't
// turn Repair on or off.
assert.equal(decodeCliNotStarting(REQUIRE), null);
assert.equal(decodeCliNotStarting(`${CLI_NOT_STARTING_PREFIX}{"tool":"git"}\nx`), null);
assert.equal(decodeCliNotStarting(`${CLI_NOT_STARTING_PREFIX}{broken\nx`), null);
assert.equal(cliNotStartingIn(undefined, null, "", claude), "claude");
assert.equal(stripCliMarks(null), null);
assert.equal(stripCliMarks("plain"), "plain");

// The shared helpers never show the mark.
assert.equal(plainCause(claude), cliNotStartingSentence("claude"));
assert.equal(reviewerWords(wrapped), `No eligible reviewer: ${REQUIRE}`);
// plainFailure keeps the mark for FailureText, which strips it and offers Repair.
assert.equal(decodeCliNotStarting(plainFailure(claude).sentence), "claude");

// A toast with no press of its own gets Repair; its words lose the mark.
const behind = cliNotStartingToast({ title: "Build not started", body: "Press Start build to try again.", details: claude, hasAction: false })!;
assert.equal(behind.tool, "claude");
assert.equal(behind.body, cliNotStartingSentence("claude"));
assert.equal(behind.details, REQUIRE);
assert.equal(behind.label, "Repair Claude Code");
// In its line: the backend's own sentence stays (it says more).
const inLine = cliNotStartingToast({ title: "Resume didn't go through", body: codexResume, hasAction: false })!;
assert.equal(inLine.body, RESUME);
// One with a press keeps it: only the mark goes.
const own = cliNotStartingToast({ title: codexResume, hasAction: true })!;
assert.equal(own.tool, null);
assert.equal(own.title, RESUME);
assert.equal(cliNotStartingToast({ title: "Saved", hasAction: false }), null);

// Real blocks with their own primary keep it, second; what happened keeps
// the backend's sentence when it carried the mark.
const resumeBlock: UxError = {
  title: "Resume didn't go through.",
  happened: codexResume,
  untouched: "Nothing else changed on the card.",
  todo: "Try again.",
  actions: [
    { id: "choose-claude", label: "Choose Claude", primary: true },
    { id: "dismiss", label: "Dismiss" },
  ],
  details: null,
};
const mapped = withCliRepair(resumeBlock);
assert.equal(mapped.happened, RESUME, "the resume fact stays");
assert.deepEqual(
  mapped.actions.map((a) => [a.id, a.label, a.primary ?? false]),
  [
    ["cli-repair:codex", "Repair Codex", true],
    ["choose-claude", "Choose Claude", false],
  ],
);
assert.equal(mapped.actions.filter((a) => a.primary).length, 1, "one primary");
assert.equal(withCliRepair(mapped), mapped, "mapped once");
const retryBlock: UxError = {
  title: "Build not started.",
  happened: "The program didn't start.",
  untouched: "Nothing was changed.",
  todo: "Press Start build to try again.",
  actions: [{ id: "retry", label: "Try again", primary: true }],
  details: wrapped,
};
const retry = withCliRepair(retryBlock);
assert.equal(retry.happened, cliNotStartingSentence("claude"), "a generic sentence gives way");
assert.equal(retry.details, `No eligible reviewer: ${REQUIRE}`, "Details lose the mark");
assert.deepEqual(retry.actions.map((a) => a.id), ["cli-repair:claude", "retry"]);
assert.equal(cliRepairActionTool("cli-repair:codex"), "codex");
assert.equal(cliRepairActionTool("retry"), null);
const other = { ...retryBlock, details: "network down" };
assert.equal(withCliRepair(other), other);

console.log("cliNotStarting: ok");
