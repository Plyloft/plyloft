import assert from "node:assert/strict";
import { boardFocusReturnCard } from "./boardFocus.ts";

assert.equal(
  boardFocusReturnCard(
    { workspaceId: "workspace-a", selectedCardId: "card-a" },
    { workspaceId: "workspace-a", selectedCardId: null },
  ),
  "card-a",
  "closing a card in the same workspace restores its opener",
);

assert.equal(
  boardFocusReturnCard(
    { workspaceId: "workspace-a", selectedCardId: "card-a" },
    { workspaceId: "workspace-b", selectedCardId: null },
  ),
  null,
  "switching workspaces must not look like a card close",
);

assert.equal(
  boardFocusReturnCard(
    { workspaceId: "workspace-a", selectedCardId: "card-a" },
    { workspaceId: "workspace-a", selectedCardId: "card-b" },
  ),
  null,
  "changing the open card does not restore the previous opener",
);

assert.equal(
  boardFocusReturnCard(
    { workspaceId: "workspace-a", selectedCardId: null },
    { workspaceId: "workspace-a", selectedCardId: null },
  ),
  null,
  "an already-closed Board does not manufacture a focus target",
);

console.log("boardFocus: workspace-scoped focus transitions passed");
