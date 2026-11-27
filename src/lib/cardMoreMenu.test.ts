// 1.172.0 D1 pure contract: the card's ⋯ in headed groups, Delete last and
// apart, nothing Now already offers. Run with:
//   node --experimental-strip-types src/lib/cardMoreMenu.test.ts
import assert from "node:assert/strict";
import {
  CARD_MORE_GROUPS,
  cardMoreMenu,
  menuLabels,
  nowDuplicates,
  nowPressLabels,
  pressName,
  runHistoryShown,
  type CardMoreEntry,
} from "./cardMoreMenu.ts";

const noop = () => {};
const e = (group: CardMoreEntry["group"], label: string, danger = false): CardMoreEntry => ({
  group,
  item: { label, onSelect: noop, ...(danger ? { danger: true } : {}) },
});

// The groups, in their order, each under its heading.
assert.deepEqual(
  CARD_MORE_GROUPS.map((g) => g.heading),
  ["Build", "Ship", "Session", "Card"],
);
{
  const menu = cardMoreMenu([
    e("card", "Archive"),
    e("card", "Delete card…", true),
    e("session", "Open a terminal in the card's copy"),
    e("build", "Challenge the plan…"),
    e("ship", "Release…"),
    e("session", "Close the Builder session…"),
    e("card", "Follow up"),
  ]);
  assert.deepEqual(menu.map((m) => (m === "divider" ? "—" : "heading" in m ? `# ${m.heading}` : m.label)), [
    "# Build",
    "Challenge the plan…",
    "# Ship",
    "Release…",
    "# Session",
    "Open a terminal in the card's copy",
    "Close the Builder session…",
    "# Card",
    "Archive",
    "Follow up",
    "—",
    "Delete card…",
  ]);
}

// An empty group has no heading; Delete is last and alone after its divider.
{
  const menu = cardMoreMenu([e("card", "Delete card…", true), e("card", "Archive")]);
  assert.deepEqual(
    menu.map((m) => (m === "divider" ? "—" : "heading" in m ? `# ${m.heading}` : m.label)),
    ["# Card", "Archive", "—", "Delete card…"],
  );
  assert.equal(menuLabels(menu).slice(-1)[0], "Delete card…");
  // Only Delete: no divider before it.
  assert.deepEqual(cardMoreMenu([e("card", "Delete card…", true)]).filter((m) => m === "divider"), []);
}

// Nothing Now offers: by its name, whatever the "…", the case or the spacing.
{
  assert.equal(pressName("Release…"), "release");
  assert.equal(pressName("  Build  with both "), "build with both");
  const menu = cardMoreMenu(
    [e("build", "Build with both"), e("card", "Follow up"), e("build", "Plan again with Claude"), e("card", "Archive")],
    ["Start build", "build with both", "Making the card…"],
  );
  assert.deepEqual(menuLabels(menu), ["Plan again with Claude", "Archive"]);
}

// One press, two names: Now's "Plan it with Claude first" and the ⋯'s
// "Plan again with Claude" both start the planning conversation.
assert.deepEqual(nowDuplicates(["Plan it with Claude first"], ["Plan again with Claude", "Plan with two AIs…"]), [
  "Plan again with Claude",
]);
assert.deepEqual(nowDuplicates(["Plan it with Codex first"], ["Plan again with Codex"]), ["Plan again with Codex"]);
// Start build's busy "Setting up…" isn't Build with both's.
assert.deepEqual(nowDuplicates(["Setting up…"], ["Build with both"]), []);
assert.deepEqual(nowDuplicates(["Starting both…"], ["Build with both"]), ["Build with both"]);
assert.deepEqual(nowDuplicates([], ["Archive"]), []);

// Run history's block: a card with runs, one that may get them (an agent's
// or a team of agents'), or one that doesn't record them — never a Builder
// card with none.
assert.equal(runHistoryShown({}), false);
assert.equal(runHistoryShown({ runHistory: [] }), false);
assert.equal(runHistoryShown({ runHistory: [{}] }), true);
assert.equal(runHistoryShown({ suppressRunHistory: true }), true);
assert.equal(runHistoryShown({ agentConfigId: "a1" }), true);
assert.equal(runHistoryShown({ swarmTemplateId: "t1" }), true);
assert.equal(runHistoryShown({ linkedSwarmId: "s1" }), true);
assert.equal(runHistoryShown({ linkedRunId: "r1" }), true);

// Now's presses, one list: primary, alternatives, every menu's choices
// (the primary's ▾ and Plan it first ▾, 1.172.0 C1).
assert.deepEqual(
  nowPressLabels({
    primary: "Start build",
    alternatives: [undefined, { label: "Try it" }, null],
    menus: [[{ label: "Build with both", onSelect: noop }], undefined, [{ heading: "x" }, { label: "Plan with two AIs", onSelect: noop }]],
  }),
  ["Start build", "Try it", "Build with both", "Plan with two AIs"],
);
assert.deepEqual(
  cardMoreMenu([e("build", "Plan with two AIs…"), e("card", "Archive")], nowPressLabels({ primary: "Start build", menus: [[{ label: "Plan with two AIs", onSelect: noop }]] })).map((m) => (typeof m === "string" ? m : "heading" in m ? `# ${m.heading}` : m.label)),
  ["# Card", "Archive"],
);

console.log("cardMoreMenu.test.ts: ok");
