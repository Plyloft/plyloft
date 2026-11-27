// GH #211: the changes bar is fed by the protocol's diff, which carries only
// `apply_patch` edits. After a turn that ran shell commands and reported no
// file change, the bar says why it is empty — and only then. The real
// `CodexSession`, the App Server played through the #172 stub.
//
//  1. Commands ran, no fileChange → the hint, once the turn is over (not while
//     it runs: a patch could still come).
//  2. No commands → no hint and no bar.
//  3. A command that was declined never ran → no hint.
//  4. Commands ran and the diff has files → the bar, not the hint.
//  5. The next turn starts clean: the hint goes with the turn that earned it.
//  Review 1 (m3), from Codex's own `commandActions`:
//  6. Read-only commands (search, read, listFiles) after a question → no hint.
//  7. A command with an `unknown` part, or an empty list → the hint.
import { describe, expect, it } from "vitest";
import { screen } from "./render";
import { SHELL_CHANGES_HINT } from "../components/CodexChanges";
import {
  completeTurn,
  emitCodex,
  renderReadySession,
  runCommand,
  startTurn,
  settled,
} from "./codexChat";

const hint = () => screen.queryByText(SHELL_CHANGES_HINT);

const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("the changes bar says why it is empty after shell commands (GH #211)", () => {
  it("1. commands ran, no file change → the hint, once the turn is over", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    runCommand("turn-1", "cmd-1", "printf hi > a.txt");
    expect(hint()).toBeNull();

    completeTurn("turn-1", "completed");
    expect(await screen.findByText(SHELL_CHANGES_HINT)).toBeTruthy();
    expect(r.container.querySelector(".codex-changes-bar")).toBeNull();
  });

  it("2. no commands → no hint, no bar", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    emitCodex({ method: "item/agentMessage/delta", params: { itemId: "m1", delta: "Done." } });
    completeTurn("turn-1", "completed");
    await settled();
    expect(hint()).toBeNull();
    expect(r.container.querySelector(".codex-changes")).toBeNull();
  });

  it("3. a declined command never ran → no hint", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    emitCodex({
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", command: "rm -rf x", status: "declined" },
      },
    });
    completeTurn("turn-1", "completed");
    await settled();
    expect(hint()).toBeNull();
  });

  it("4. commands ran and the diff has files → the bar, not the hint", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    runCommand("turn-1", "cmd-1", "ls");
    emitCodex({ method: "turn/diff/updated", params: { turnId: "turn-1", diff: DIFF } });
    completeTurn("turn-1", "completed");
    await settled();
    expect(r.container.querySelector(".codex-changes-bar")).not.toBeNull();
    expect(hint()).toBeNull();
  });

  it("5. the next turn starts clean", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    runCommand("turn-1", "cmd-1", "printf hi > a.txt");
    completeTurn("turn-1", "completed");
    await screen.findByText(SHELL_CHANGES_HINT);

    await startTurn(r, "turn-2");
    expect(hint()).toBeNull();
    completeTurn("turn-2", "completed");
    await settled();
    expect(hint()).toBeNull();
  });

  it("6. read-only commands after a question → no hint", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    runCommand("turn-1", "cmd-1", "rg -n foo src", [{ type: "search", command: "rg -n foo src" }]);
    runCommand("turn-1", "cmd-2", "sed -n 1,40p a.ts", [
      { type: "read", command: "sed -n 1,40p a.ts" },
    ]);
    runCommand("turn-1", "cmd-3", "ls src", [{ type: "listFiles", command: "ls src" }]);
    completeTurn("turn-1", "completed");
    await settled();
    expect(hint()).toBeNull();
  });

  it("7. an unknown part, or no reading at all → the hint", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    runCommand("turn-1", "cmd-1", "cat a && printf x > b", [
      { type: "read", command: "cat a" },
      { type: "unknown", command: "printf x > b" },
    ]);
    completeTurn("turn-1", "completed");
    expect(await screen.findByText(SHELL_CHANGES_HINT)).toBeTruthy();

    await startTurn(r, "turn-2");
    runCommand("turn-2", "cmd-2", "make", []);
    completeTurn("turn-2", "completed");
    expect(await screen.findByText(SHELL_CHANGES_HINT)).toBeTruthy();
  });
});
