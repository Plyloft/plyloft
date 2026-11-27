// UX-3.4: the sidebar's width and hidden flag, remembered on this Mac.
// Run with Node 22+:  node --experimental-strip-types src/lib/sidebarLayout.test.ts
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Settings } from "./settingsShape.ts";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_LAYOUT,
  sidebarLayoutOf,
  sidebarPresentation,
  withSidebarLayout,
} from "./sidebarLayout.ts";

// Schema migration: a settings.json written before UX-3.4 has no
// `windows.sidebar` — it reads as 240 px, shown, and keeps the Settings size.
{
  const legacy = JSON.parse(
    JSON.stringify({ ...DEFAULT_SETTINGS, windows: { settings: { width: 960, height: 700 } } }),
  ) as Settings;
  assert.equal("sidebar" in legacy.windows, false);
  assert.deepEqual(sidebarLayoutOf(legacy.windows), { width: 240, collapsed: false });
  assert.deepEqual(sidebarLayoutOf(undefined), DEFAULT_SIDEBAR_LAYOUT);
  assert.deepEqual(sidebarLayoutOf({ settings: null, sidebar: null }), DEFAULT_SIDEBAR_LAYOUT);

  const saved = withSidebarLayout(legacy, { width: 280, collapsed: true });
  assert.deepEqual(saved.windows, {
    settings: { width: 960, height: 700 },
    sidebar: { width: 280, collapsed: true },
  });
  // The rest of the file is untouched.
  assert.equal(saved.appearance, legacy.appearance);
  assert.deepEqual(sidebarLayoutOf(saved.windows), { width: 280, collapsed: true });
}

// Width is held to 200–320 and to whole pixels, whatever the file says.
{
  assert.equal(clampSidebarWidth(120), 200);
  assert.equal(clampSidebarWidth(999), 320);
  assert.equal(clampSidebarWidth(250.6), 251);
  assert.equal(clampSidebarWidth(Number.NaN), 240);
  assert.deepEqual(
    sidebarLayoutOf({ settings: null, sidebar: { width: 9000, collapsed: "yes" as unknown as boolean } }),
    { width: 320, collapsed: false },
  );
}

// Nothing changes → the same object, so the settings queue writes nothing.
{
  const once = withSidebarLayout(DEFAULT_SETTINGS, { width: 260, collapsed: false });
  assert.equal(withSidebarLayout(once, { width: 260, collapsed: false }), once);
  assert.notEqual(withSidebarLayout(once, { width: 260, collapsed: true }), once);
}

// Presentation: docked or hidden by ⌘\ at 1000 px and up; below that it is an
// overlay that is closed until asked for, so the stage keeps the full width.
{
  const shown = { width: 240, collapsed: false };
  const hidden = { width: 240, collapsed: true };
  assert.equal(sidebarPresentation(shown, 1280, false), "docked");
  assert.equal(sidebarPresentation(hidden, 1280, false), "hidden");
  assert.equal(sidebarPresentation(shown, 1000, false), "docked");
  assert.equal(sidebarPresentation(shown, 900, false), "hidden");
  assert.equal(sidebarPresentation(shown, 900, true), "overlay");
  assert.equal(sidebarPresentation(hidden, 900, true), "overlay");
}

console.log("sidebarLayout: all assertions passed");
