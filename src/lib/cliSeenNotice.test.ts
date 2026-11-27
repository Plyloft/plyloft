import assert from "node:assert/strict";

import type { CliSeenNotice } from "./cliSeenIpc.ts";
import { cliSeenToast } from "./cliSeenNotice.ts";

// 1.176.1: the words for a tool that changed under the person. The backend
// decides whether to speak (`cli_seen.rs`); these are what it says.

function changed(overrides: Partial<Extract<CliSeenNotice, { kind: "changed" }>> = {}): CliSeenNotice {
  return {
    kind: "changed",
    tool: "claude",
    versionWas: null,
    versionNow: null,
    folderWas: null,
    folderNow: null,
    ...overrides,
  };
}

// A new version, one calm line.
assert.deepEqual(cliSeenToast(changed({ versionWas: "2.1.322", versionNow: "2.1.330" })), {
  kind: "info",
  title: "Claude Code is now 2.1.330 (was 2.1.322).",
});

// A new folder, with the home already as ~.
assert.deepEqual(
  cliSeenToast(changed({ tool: "codex", folderWas: "/opt/homebrew/bin", folderNow: "~/.local/bin" })),
  { kind: "info", title: "Codex now starts from ~/.local/bin (was /opt/homebrew/bin)." },
);

// Both in one sentence.
assert.equal(
  cliSeenToast(
    changed({ tool: "codex", versionWas: "0.166.0", versionNow: "0.171.0", folderWas: "~\\npm", folderNow: "~\\.codex\\bin" }),
  )?.title,
  "Codex is now 0.171.0 (was 0.166.0) and starts from ~\\.codex\\bin (was ~\\npm).",
);

// C: the re-check is said only when its real request starts, on its own line.
assert.deepEqual(cliSeenToast({ kind: "checking", tool: "claude", version: "2.1.330" }), {
  kind: "info",
  title: "Plyloft is checking that Claude Code 2.1.330 can still review safely",
  body: "Once for this version: usually one short request on your plan, at most three.",
});
assert.equal(
  cliSeenToast({ kind: "checking", tool: "codex", version: "0.171.0" })?.body,
  "Once for this version: usually one short request on your plan, at most two.",
);

// Nothing readable: nothing said.
assert.equal(cliSeenToast(changed()), null);
assert.equal(cliSeenToast(changed({ versionNow: "2.1.330" })), null);
assert.equal(cliSeenToast({ kind: "checking", tool: "codex", version: "" }), null);

console.log("cliSeenNotice.test.ts ✓");
