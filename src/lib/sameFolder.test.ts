// Unit tests for the "Same folder as …" words (src/lib/sameFolder.ts, 1.173.0 A4).
//
// Run: node --experimental-strip-types src/lib/sameFolder.test.ts

import assert from "node:assert/strict";
import {
  SAME_FOLDER_COPY,
  SAME_FOLDER_SHORT,
  copyMadeToastWords,
  copyStartWords,
  folderPeerName,
  folderSelfName,
  folderTileName,
  sameFolderBody,
  sameFolderChanged,
  sameFolderHint,
  sameFolderChip,
  sameFolderHeadline,
  sameFolderShow,
} from "./sameFolder.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

it("a default label reads as its AI; a given title stays as it is", () => {
  assert.equal(folderTileName({ kind: "codex", label: "codex 1" }), "Codex");
  assert.equal(folderTileName({ kind: "claude", label: "claude 2" }), "Claude");
  assert.equal(folderTileName({ kind: "codex-chat", label: "codex chat 1" }), "Codex chat");
  assert.equal(folderTileName({ kind: "claude", label: "fix the footer", labelSource: "auto" }), "fix the footer");
  assert.equal(folderTileName({ kind: "codex", label: "My work", labelSource: "user" }), "My work");
  assert.equal(folderTileName({ kind: "agent-run", label: "builder" }), "Builder");
  assert.equal(folderTileName({ kind: "agent-run", label: " " }), "this terminal");
});

it("a peer with no tile here is named by its AI", () => {
  assert.equal(folderPeerName(null, "codex"), "Codex");
  assert.equal(folderPeerName(null, "claude"), "Claude");
  assert.equal(folderPeerName(undefined, "shell"), "a terminal");
  assert.equal(folderPeerName(null, null), "another session");
  assert.equal(folderPeerName({ kind: "codex", label: "codex 1" }, "claude"), "Codex");
});

it("1.174.0 E1: two tiles of one AI are told apart by their labels", () => {
  const one = { kind: "codex", label: "codex 1" };
  const two = { kind: "codex", label: "codex 2" };
  assert.equal(folderPeerName(two, "codex", one), "codex 2");
  assert.equal(folderSelfName(one, [two]), "codex 1");
  // Different AIs keep the AI's name; a given title stays.
  assert.equal(folderPeerName({ kind: "claude", label: "claude 1" }, "claude", one), "Claude");
  assert.equal(folderSelfName(one, [{ kind: "claude", label: "claude 1" }]), "Codex");
  assert.equal(folderPeerName({ kind: "codex", label: "Tidy the Inbox", labelSource: "auto" }, "codex", one), "Tidy the Inbox");
  assert.equal(folderSelfName(one, [null]), "Codex", "a peer with no tile here: the AI");
});

it("the chip names the peer, and how many more", () => {
  assert.equal(sameFolderChip(["Codex"]), "Same folder as Codex");
  assert.equal(sameFolderChip(["Codex", "Claude 2"]), "Same folder as Codex and 1 more");
  assert.equal(sameFolderChip([]), "Same folder");
  // 1.174.0 E4 (P21): a narrow tile's short form.
  assert.equal(SAME_FOLDER_SHORT, "Same folder");
});

it("the bold line names both terminals (scene 1)", () => {
  assert.equal(
    sameFolderHeadline("Claude", ["Codex"]),
    "Claude and Codex are working in the same folder.",
  );
  assert.equal(
    sameFolderHeadline("Claude", ["Claude"]),
    "Both Claude terminals are working in the same folder.",
  );
  assert.equal(
    sameFolderHeadline("Claude", ["Codex", "Claude 2"]),
    "Claude and 2 other terminals are working in the same folder.",
  );
});

it("the sentences say what changed, where a copy starts and what it leaves out (E1)", () => {
  assert.deepEqual(
    sameFolderBody({ targetBranch: "main", githubRepo: "me/app", localAhead: 1 }, true, { count: 2, names: ["InboxPanel.tsx", "inboxView.ts"] }),
    {
      risk: "2 files changed here since both opened: InboxPanel.tsx, inboxView.ts. They can change the same files without seeing each other's edits.",
      copy: "Start the next session in a copy of its own instead. It starts from main on GitHub; changes not yet on GitHub aren't in it.",
    },
  );
  // Challenger 1 (E1-7): "not yet on GitHub" only when it is true — this
  // Mac's branch diverged from GitHub's. Level (or nothing read): no clause.
  assert.equal(
    sameFolderBody({ targetBranch: "main", githubRepo: "me/app", localAhead: 0 }).copy,
    "Start the next session in a copy of its own instead. It starts from main on GitHub.",
  );
  assert.equal(
    sameFolderBody({ targetBranch: "main", githubRepo: "me/app" }).copy,
    "Start the next session in a copy of its own instead. It starts from main on GitHub.",
  );
  // Strictly ahead: the copy starts from this Mac's branch, with its steps.
  assert.equal(
    sameFolderBody({ targetBranch: "main", githubRepo: "me/app", startsLocal: true, localAhead: 0 }).copy,
    "Start the next session in a copy of its own instead. It starts from main on this Mac.",
  );
  assert.equal(sameFolderChanged({ count: 1, names: ["a.ts"] }), "1 file changed here since both opened: a.ts.");
  // 1.174.1 P6 (T6): three or more tiles — "they", not "both".
  assert.equal(sameFolderChanged({ count: 1, names: ["a.ts"] }, 3), "1 file changed here since they opened: a.ts.");
  assert.equal(sameFolderChanged({ count: 2, names: ["a.ts", "b.ts"] }, 2), "2 files changed here since both opened: a.ts, b.ts.");
  assert.equal(
    sameFolderBody({ targetBranch: "main" }, false, { count: 2, names: ["a.ts", "b.ts"] }, 4).risk,
    "2 files changed here since they opened: a.ts, b.ts. They can change the same files without seeing each other's edits.",
  );
  assert.equal(sameFolderChanged({ count: 5, names: ["a.ts", "b.ts", "c.ts"] }), "5 files changed here since both opened: a.ts, b.ts and 3 more.");
  // Without GitHub there is no "not yet on GitHub" to say.
  assert.equal(sameFolderBody({ targetBranch: "main" }).copy, "Start the next session in a copy of its own instead. It starts from main.");
});

it("says GitHub only when origin is GitHub, and never a bare GitHub", () => {
  assert.equal(copyStartWords({ targetBranch: "main", githubRepo: "me/app" }), "main on GitHub");
  // No origin (the copy starts from the local branch) or another host.
  assert.equal(copyStartWords({ targetBranch: "main" }), "main");
  assert.equal(copyStartWords({ targetBranch: "staging", githubRepo: null }), "staging");
  // No target branch saved: origin's default branch.
  assert.equal(copyStartWords({ targetBranch: "", defaultBranch: "trunk", githubRepo: "me/app" }), "trunk on GitHub");
  assert.equal(copyStartWords({ targetBranch: " ", defaultBranch: "trunk" }), "trunk");
  // Nothing known.
  assert.equal(copyStartWords(null), "the project's main branch");
  assert.equal(copyStartWords({ githubRepo: "me/app" }), "the project's main branch on GitHub");
  for (const start of [null, {}, { githubRepo: "me/app" }, { targetBranch: "main" }]) {
    assert.ok(!/from GitHub/.test(sameFolderBody(start).copy ?? ""), JSON.stringify(start));
  }
});

it("without a copy possible (no git) the sentence says only the risk", () => {
  assert.deepEqual(sameFolderBody({ targetBranch: "main", githubRepo: "me/app" }, false), {
    risk: "They can change the same files without seeing each other's edits.",
    copy: null,
  });
});

it("the actions and the hint use the mockup's words", () => {
  assert.equal(SAME_FOLDER_COPY, "Start a new one in a copy");
  assert.equal(sameFolderShow("Codex"), "Show Codex");
  assert.equal(sameFolderHint("codex 1"), "Then close codex 1 here: its conversation stays in Resume…");
  assert.deepEqual(copyMadeToastWords("codex 3", "codex 1", "codex 2"), {
    title: "codex 3 is in its own copy",
    body: "codex 1 still shares the folder with codex 2. Its conversation stays in Resume…",
    action: "Close codex 1",
  });
});

it("no developer word reaches the screen", () => {
  const all = [
    sameFolderChip(["Codex"]),
    sameFolderHeadline("Claude", ["Codex"]),
    sameFolderBody({ targetBranch: "main", githubRepo: "me/app" }).risk,
    sameFolderBody({ targetBranch: "main", githubRepo: "me/app" }).copy,
    SAME_FOLDER_COPY,
    sameFolderHint("codex 1"),
  ].join(" ");
  for (const word of ["worktree", "PR", "CLI", "diff", "origin", "HEAD", "snapshot", "Overlap"]) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(all), word);
  }
});

if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed`);
