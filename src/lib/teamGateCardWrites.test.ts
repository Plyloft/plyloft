import assert from "node:assert/strict";

import CASES from "../../fixtures/team-gate-card-write-cases.json" with { type: "json" };
import type { CardPatch } from "../ipc.ts";
import type { KanbanSyncMode } from "../store/workspaceStore.ts";
import {
  githubCardWriteBlocked,
  touchesGithubOwnedCardField,
} from "./teamGateCardWrites.ts";

for (const fixture of CASES) {
  assert.equal(
    githubCardWriteBlocked(
      fixture.mode as KanbanSyncMode,
      fixture.teamAllowed,
      fixture.touchesGithubOwnedField,
    ),
    fixture.blocked,
    fixture.name,
  );
}

const fieldCases: Array<[string, CardPatch, boolean]> = [
  ["empty", {}, false],
  ["title", { title: "Changed" }, true],
  ["notes cleared", { notes: null }, true],
  ["knowledge", { knowledge: "Context" }, true],
  ["column", { columnId: "complete" }, true],
  ["local-only", { suppressRunHistory: true }, false],
  ["mixed", { title: "Changed", suppressRunHistory: true }, true],
];

for (const [name, patch, expected] of fieldCases) {
  assert.equal(touchesGithubOwnedCardField(patch), expected, name);
}

console.log(
  `team-gate card-write fixtures: ${CASES.length + fieldCases.length} passed`,
);
