// OB-4 review (P3-4), Tier 3 source contract. Run with Node 22+:
//   node --experimental-strip-types src/lib/setupGuards.test.ts
//
// A key listener on `window` or `document` hears keys typed inside Setup too:
// the shell under Setup is inert, but its listeners are not. Each one that can
// act on a key (open a search, close a card, switch a mode) answers nothing
// while Setup is up — through `setupIsOpen()`. The behaviour is held in
// setupOverlay.test.tsx; this keeps a new listener from skipping the guard.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const GUARDED = [
  "../components/SettingsOverlay.tsx",
  "../components/CommandPalette.tsx",
  "../components/WorkspaceTemplateModal.tsx",
  "../components/SidebarSlot.tsx",
  "../components/Tile.tsx",
  "../components/KanbanBoard.tsx",
  "../components/CardDetailPanel.tsx",
];

for (const file of GUARDED) {
  const src = read(file);
  // OB-15: the palette also imports `useSetup` (⌘K "Open setup").
  assert.match(src, /import \{[^}]*\bsetupIsOpen\b[^}]*\} from "\.\.\/store\/setupStore";/, file);
  const listeners = src.match(/(window|document)\.addEventListener\("keydown"/g) ?? [];
  const guards = src.match(/if \(setupIsOpen\(\)\) return;/g) ?? [];
  assert.ok(listeners.length > 0, `${file} has a key listener`);
  assert.equal(guards.length, listeners.length, `${file}: one guard per key listener`);
}

// App's shortcut handler swallows every app shortcut while Setup is up
// (setupIsOpen).
assert.match(read("../App.tsx"), /if \(setupIsOpen\(\)\) \{\s*e\.preventDefault\(\);/);
assert.match(
  read("../store/setupStore.ts"),
  /return useSetup\.getState\(\)\.open;/,
);

// The dialog stack treats anything under an inert layer as not on screen.
assert.match(read("./dialogFocus.ts"), /current\.hasAttribute\("inert"\)\) return false;/);

console.log(`setupGuards: ${GUARDED.length + 2} passed`);
