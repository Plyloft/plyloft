// Unit tests for the words of a shared setting both sides changed
// (src/lib/settingConflict.ts, 1.173.0 C3).
//
// Run: node --experimental-strip-types src/lib/settingConflict.test.ts

import {
  CONFLICT_LEDE,
  conflictFieldOfInboxId,
  conflictKey,
  conflictTitle,
  differenceRows,
  droppedToast,
  shownOf,
  keepTheirsLabel,
  opensByItself,
} from "./settingConflict.ts";
import { setPlatformForTests } from "./platform.ts";
import type { SettingConflict } from "../ipc.ts";

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

function eq(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}

const NOW = 1_700_000_600;

function conflict(over: Partial<SettingConflict> = {}): SettingConflict {
  return {
    field: "versionFiles",
    label: "Version files",
    author: "test-owner",
    device: "MacBook Pro",
    samePerson: true,
    changedAt: NOW - 600,
    difference: {
      list: true,
      both: ["frontend/package.json", "main.py", "config/appConfig.py"],
      onlyMine: ["shopify/package.json"],
      onlyTheirs: [],
      different: [],
      theirs: "frontend/package.json, main.py, config/appConfig.py",
      mine: "frontend/package.json, main.py, config/appConfig.py, shopify/package.json",
    },
    ...over,
  };
}

setPlatformForTests("mac");

it("names the same person's other computer, as the mockup", () => {
  const c = conflict();
  eq(conflictTitle(c, NOW), "Your MacBook Pro changed “Version files” 10 min ago");
  eq(keepTheirsLabel(c), "Keep the MacBook Pro’s");
  eq(CONFLICT_LEDE, "You changed it here too, before seeing that. Which should the repository keep?");
});

it("a computer without a name is the other Mac, or the other PC", () => {
  const c = conflict({ device: null });
  eq(conflictTitle(c, NOW), "Your other Mac changed “Version files” 10 min ago");
  eq(keepTheirsLabel(c), "Keep the other Mac’s");
  setPlatformForTests("windows");
  eq(conflictTitle(c, NOW), "Your other PC changed “Version files” 10 min ago");
  eq(differenceRows(c)[1].label, "Only this PC adds");
  setPlatformForTests("mac");
});

it("a teammate is named by their name, never by their computer", () => {
  const c = conflict({ samePerson: false, author: "bob", device: "Bob's iMac" });
  eq(conflictTitle(c, NOW), "bob changed “Version files” 10 min ago");
  eq(keepTheirsLabel(c), "Keep bob’s");
  eq(conflictTitle(conflict({ samePerson: false, author: null, changedAt: null }), NOW), "Someone else changed “Version files”");
});

it("a list shows only the difference", () => {
  eq(differenceRows(conflict()), [
    { label: "Both have", items: ["frontend/package.json", "main.py", "config/appConfig.py"] },
    { label: "Only this Mac adds", items: ["shopify/package.json"], added: true },
  ]);
  const areas = conflict({
    field: "areas",
    label: "Areas",
    difference: { list: true, both: ["App"], onlyMine: ["Shop"], onlyTheirs: ["Docs"], different: ["Site"], theirs: "", mine: "" },
  });
  eq(differenceRows(areas).map((r) => r.label), ["Both have", "Set differently on each", "Only this Mac adds", "Only the MacBook Pro has"]);
});

it("one value is theirs against this Mac's", () => {
  const c = conflict({
    samePerson: false,
    author: "bob",
    difference: { list: false, both: [], onlyMine: [], onlyTheirs: [], different: [], theirs: "scripts/theirs.sh", mine: "scripts/mine.sh" },
  });
  eq(differenceRows(c), [
    { label: "bob", items: ["scripts/theirs.sh"] },
    { label: "This Mac", items: ["scripts/mine.sh"] },
  ]);
});

it("opens by itself only where the person is, once per question", () => {
  const key = conflictKey("ws-1", conflict());
  const base = { visible: true, focused: true, activeWorkspaceId: "ws-1", workspaceId: "ws-1", key, asked: new Set<string>() };
  eq(opensByItself(base), true);
  eq(opensByItself({ ...base, visible: false }), false);
  eq(opensByItself({ ...base, focused: false }), false);
  eq(opensByItself({ ...base, activeWorkspaceId: "ws-2" }), false);
  eq(opensByItself({ ...base, asked: new Set([key]) }), false);
  eq(conflictKey("ws-1", conflict({ changedAt: NOW })) === key, false);
});

it("reads the field from the Inbox row's id", () => {
  eq(conflictFieldOfInboxId("setting-conflict:ws-1:versionFiles:1700000000"), "versionFiles");
  eq(conflictFieldOfInboxId("proposal:ws-1"), null);
  // 1.173.0 (E1): a Next improvement direction field, area id with dashes.
  eq(conflictFieldOfInboxId("setting-conflict:ws-1:ni-lyra-site-better:1700000000"), "ni-lyra-site-better");
});


it("another folder on this very Mac is said so, never as this Mac by name", () => {
  const c = conflict({ thisComputer: true, device: "Mac mini" });
  eq(conflictTitle(c, NOW), "You changed “Version files” in another folder on this Mac 10 min ago");
  eq(keepTheirsLabel(c), "Keep the other folder’s");
  setPlatformForTests("windows");
  eq(conflictTitle(c, NOW), "You changed “Version files” in another folder on this PC 10 min ago");
  setPlatformForTests("mac");
});

it("a value made of keys names only the keys set differently", () => {
  const c = conflict({
    field: "models",
    label: "Suggested models and effort",
    difference: {
      list: false, both: [], onlyMine: [], onlyTheirs: [], different: [],
      theirs: "Claude · Build: opus", mine: "Claude · Build: sonnet",
      keys: [{ name: "Claude · Build", theirs: "opus", mine: "sonnet" }],
    },
  });
  eq(differenceRows(c), [
    { label: "The MacBook Pro", items: ["Claude · Build: opus"] },
    { label: "This Mac", items: ["Claude · Build: sonnet"] },
  ]);
  eq(droppedToast(c), {
    title: "Your change to “Suggested models and effort” was dropped",
    body: "Claude · Build: sonnet. Your other changes to it stay.",
  });
});

it("keeping theirs says what this Mac's change carried", () => {
  eq(droppedToast(conflict()), { title: "Your change to “Version files” was dropped", body: "+ shopify/package.json" });
  const one = conflict({
    difference: { list: false, both: [], onlyMine: [], onlyTheirs: [], different: [], theirs: "a.sh", mine: "b.sh" },
  });
  eq(droppedToast(one).body, "This Mac had: b.sh");
});

it("the answer carries the question as shown", () => {
  eq(shownOf(conflict({ theirs: ["a"], changedAt: 5 })), { theirs: ["a"], changedAt: 5 });
  eq(shownOf(conflict({ theirs: undefined, changedAt: null })), { theirs: null, changedAt: null });
});

if (failed > 0) {
  console.error(`${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`settingConflict: ${passed} passed`);
