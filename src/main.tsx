// React entry point. v1.73.0 (UX revamp step 5b-3): the `#settings` hash
// route is gone — Settings lives in the shell as an overlay
// (`SettingsOverlay`); the dedicated settings window was removed from
// tauri.conf.json.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {
  CODEMIRROR_CONTENT_SELECTOR,
  CODEMIRROR_KINDS,
  DROP_ZONE_SELECTOR,
  EDITABLE_HOST_SELECTOR,
  EDITABLE_TEXT_FIELD_SELECTOR,
  FILE_INPUT_SELECTOR,
  NATIVE_TEXT_KINDS,
  GUIDANCE_TOAST_TTL_MS,
  guardedWindowOpen,
  installDropGuard,
  installNavigationGuard,
  type DropZoneRule,
} from "./lib/dropGuard";
import {
  dismissToast,
  pushToast,
  toastIsShowing,
} from "./store/toastStore";
import { isWindows, platform } from "./lib/platform";
import { installBrowserKeyGuard, installContextMenuGuard } from "./lib/browserKeys";
import { installHeartbeat } from "./lib/heartbeat";
import { watchdogBeat } from "./ipc";

// SL-0 app tester (docs/app-tester/DESIGN.md): the dev-only test bridge's JS
// agent. The terminal registry exists before anything mounts, so no terminal
// is missed; every other build drops this block and the chunk.
if (__PLY_TEST_BRIDGE__) {
  (window as { __plyTestTerminals?: Set<unknown> }).__plyTestTerminals = new Set();
  void import("./testBridge").then((bridge) => bridge.install());
}

// H1 (1.173.0): the window's heartbeat, so the Rust watchdog can log a
// freeze (watchdog.rs). Every 2 s while visible, every 30 s while hidden.
installHeartbeat((visible) => {
  void watchdogBeat(visible).catch(() => {});
});

// Windows (W5): the stylesheet reads the platform off <html> — Windows has no
// traffic lights to make room for.
document.documentElement.dataset.platform = platform();
// …and WebView2's own browser keys (reload, print, zoom, find bar) are
// cancelled once every handler of Ply's has had the key.
// A dev build keeps the developer tools (Ctrl+Shift+I, Inspect).
const guardOptions = { devtools: !import.meta.env.PROD };
if (isWindows()) installBrowserKeyGuard(window, guardOptions);
// …and its page menu (Refresh, Print, Inspect) with them; the editing menu
// over an input or on selected text stays, and a terminal answers its own
// right-click (W4).
if (isWindows()) installContextMenuGuard(window, guardOptions);

// GH #138: the window never navigates on a drop. `dragDropEnabled` is false
// (AGENTS.md hard rule 6), so the OS hands every drop to the web layer —
// including the ones that land between the real targets, where WKWebView
// used to open the dropped file and take the whole shell with it.
//
// One guard, installed once here before the shell mounts, on `window`, in the
// capture phase — in front of every target, so nothing a descendant does can
// get past it. Which means it cannot read `defaultPrevented` as a claim, and
// the registry below is the contract instead: a rule names a zone's root and
// the payload kinds that zone accepts. A zone claims a drag only when it
// accepts what the drag is carrying.
const SHELL_DROP_RULES: readonly DropZoneRule[] = [
  // Every zone the app marks declares its own kinds in `data-drop-accepts`,
  // taken from the one list its own handlers also check: the terminal pane,
  // a card's attachments, a board column, a files row, a tile and the editor
  // host. The nearest accepting zone wins, so CodeMirror's rule below claims
  // a text drag before the editor host around it sees it, while a file or a
  // path walks out to the host, which opens it.
  { selector: DROP_ZONE_SELECTOR, accepts: null },
  { selector: CODEMIRROR_CONTENT_SELECTOR, accepts: CODEMIRROR_KINDS },
  // A file picker really does take files.
  { selector: FILE_INPUT_SELECTOR, accepts: ["files"] },
  // An editable text field takes dropped text — that is a native behaviour
  // and refusing it would kill text drag-and-drop across the app. It does
  // *not* take files: the UA has no insertion for those, only the navigation
  // this card exists to stop. Readonly and disabled fields take nothing.
  { selector: EDITABLE_TEXT_FIELD_SELECTOR, accepts: NATIVE_TEXT_KINDS },
  { selector: EDITABLE_HOST_SELECTOR, accepts: NATIVE_TEXT_KINDS },
];

installDropGuard({
  window,
  rules: () => SHELL_DROP_RULES,
  // One quiet toast, raised while the drag is over ground that will refuse
  // it and taken down when the drag is claimed or ends. Idempotent while it
  // is on screen, and raised again if its own backstop expired under a long
  // hover — so it cannot go out from under a drag the user is still holding,
  // and it cannot accumulate.
  // `message` is where drops go, or (1.172.2 D1) that a screenshot being
  // dragged from its thumbnail isn't saved yet; the guard takes one down
  // before it raises the other.
  showGuidance: (previous, message) =>
    previous !== null && toastIsShowing(previous)
      ? previous
      : pushToast({
          kind: "info",
          title: message,
          ttlMs: GUIDANCE_TOAST_TTL_MS,
        }),
  hideGuidance: dismissToast,
  // A release that really did land on open ground: the one thing in this
  // model that is observed rather than inferred. Said once, and it stays its
  // usual few seconds rather than going with the drag.
  announceRejectedDrop: (message) => {
    pushToast({ kind: "info", title: message });
  },
});

// 1.172.2 D1: a log of what each drag from another app carries, for the
// walk that finds what a screenshot's thumbnail brings (ux-1722/measure.md).
// Dev and test-bridge builds only: a release build drops this block and the
// chunk with it.
if (import.meta.env.DEV || __PLY_TEST_BRIDGE__) {
  void import("./lib/dragProbe").then((probe) => probe.installDragProbe(window));
}

// The in-page half of the navigation refusal. The categorical half is the
// native webview policy in `src-tauri/src/navigation.rs`, which cancels the
// load outright — cancelling `beforeunload` only asks the UA to prompt, and
// the UA is free not to.
const refusedNavigation = (href: string) => {
  console.warn("navigation refused — Plyloft is a single page:", href);
};
installNavigationGuard({
  document,
  currentHref: () => window.location.href,
  onRefused: refusedNavigation,
});
// `window.open(url, "_self")` is a top-level navigation wearing another name.
// The original is captured before the reassignment — reading `window.open`
// inside the replacement would call the replacement.
const nativeWindowOpen = window.open.bind(window) as (
  ...args: unknown[]
) => unknown;
window.open = guardedWindowOpen({
  currentHref: () => window.location.href,
  open: nativeWindowOpen,
  onRefused: refusedNavigation,
}) as typeof window.open;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
