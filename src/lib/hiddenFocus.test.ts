import assert from "node:assert/strict";
import { focusAction, isOffScreen } from "./hiddenFocus.ts";

const shown = { rects: 1, visibility: "visible" };
const visibilityHidden = { rects: 1, visibility: "hidden" };
const displayNone = { rects: 0, visibility: "visible" };

// Both ways a host is hidden count: the sticky and warmed hosts use
// `visibility`, the Terminals mode host uses `display: none`.
assert.equal(isOffScreen(shown), false);
assert.equal(isOffScreen(visibilityHidden), true);
assert.equal(isOffScreen(displayNone), true);

// Focus inside a hidden host is released — the WKWebView case: ⌘⌥2 from
// Code left the editor focused and the keys typed over the Board went in.
assert.equal(focusAction(visibilityHidden, null), "release");
assert.equal(focusAction(displayNone, null), "release");

// Focus on something visible is never touched, whatever is remembered.
assert.equal(focusAction(shown, null), "none");
assert.equal(focusAction(shown, visibilityHidden), "none");
assert.equal(focusAction(shown, shown), "none");

// Nothing focused: the remembered element gets the focus back only once its
// host is shown again.
assert.equal(focusAction(null, shown), "restore");
assert.equal(focusAction(null, visibilityHidden), "none");
assert.equal(focusAction(null, displayNone), "none");
assert.equal(focusAction(null, null), "none");

console.log("hidden focus tests passed");
