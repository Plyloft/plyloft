import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const kanbanStore = source("../store/kanbanStore.ts");
assert.match(kanbanStore, /\{ id: "in_progress", label: "Working" \}/);
assert.match(kanbanStore, /\{ id: "complete", label: "Done" \}/);
assert.match(kanbanStore, /id: "complete"/);

const board = source("../components/KanbanBoard.tsx");
assert.match(board, /data-ply-board-card-id=\{card\.id\}/);
assert.match(board, /boardFocusReturnCard\(/);
assert.match(board, /previousSelectionRef/);
// UX-5.7: the Needs you filter is per workspace, in the Board's filter.
assert.match(board, /s\.filter\[workspaceId\]/);
assert.match(board, /opener \?\? fallback/);
assert.match(board, /\.focus\(\{ preventScroll: true \}\)/);

const card = source("../components/CardDetailPanel.tsx");
// C6 (UX-6.2): the card page shows its state once — no column chip, no
// stepper; the Status property and the Now callout say it.
assert.doesNotMatch(card, /columnLabel\(/);
assert.doesNotMatch(card, /<CardStepper/);
const escapeStart = card.indexOf("function onEsc(e: KeyboardEvent)");
const escapeEnd = card.indexOf(
  'document.addEventListener("keydown", onEsc, true)',
  escapeStart,
);
assert.notEqual(escapeStart, -1);
assert.notEqual(escapeEnd, -1);
const escapeRoute = card.slice(escapeStart, escapeEnd);
assert.match(escapeRoute, /\[role="dialog"\]\[aria-modal="true"\]/);
assert.match(escapeRoute, /\.ux-sheet-backdrop/);
assert.match(escapeRoute, /details\[open\]/);
assert.ok(
  escapeRoute.indexOf("disclosure.open = false") <
    escapeRoute.indexOf("ui.selectCard"),
  "focused disclosures must close before the card returns to Board",
);

const shortcutStart = card.indexOf(
  "function onPrimaryShortcut(event: KeyboardEvent)",
);
const shortcutEnd = card.indexOf(
  'document.addEventListener("keydown", onPrimaryShortcut, true)',
  shortcutStart,
);
const shortcutRoute = card.slice(shortcutStart, shortcutEnd);
assert.match(shortcutRoute, /dialogOwnsCommand/);
assert.match(shortcutRoute, /statePresentation\.actionId === "ship"/);
for (const editable of [
  'closest(".xterm")',
  'closest(".cm-editor")',
  'closest("input")',
  'closest("textarea")',
  "contenteditable",
]) {
  assert.ok(shortcutRoute.includes(editable), `missing Cmd-Enter guard: ${editable}`);
}


const dialogFocus = source("./dialogFocus.ts");
assert.match(dialogFocus, /const dialogStack: DialogStackEntry\[\] = \[\]/);
assert.match(dialogFocus, /topVisibleDialogToken\(\) !== token/);
assert.match(dialogFocus, /details\[open\]/);
assert.match(dialogFocus, /event\.key !== "Tab"/);
assert.match(dialogFocus, /opener\?\.isConnected && isFocusVisible\(opener\)/);

// UX-10.1: every modal is a Sheet, which owns the dialog contract — the
// shared focus stack, the dialog role, modal state and its bound name.
const sheet = source("../components/ux/Sheet.tsx");
assert.match(sheet, /useDialogFocus\s*\(/, "Sheet must consume dialog focus");
assert.match(sheet, /role="dialog"/, "Sheet must expose dialog role");
assert.match(sheet, /aria-modal="true"/, "Sheet must expose modal state");
assert.match(sheet, /aria-labelledby=\{titleId\}/, "Sheet must bind its name");
for (const component of [
  "DiscussionModal.tsx",
  "CardDeleteDialog.tsx",
  "ConfirmDialog.tsx",
  "ReleaseSheet.tsx",
  "UpdatePrompt.tsx",
  "WorkspaceTemplateModal.tsx",
]) {
  const dialogSource = source(`../components/${component}`);
  assert.match(dialogSource, /<Sheet\b/, `${component} must draw a Sheet`);
  assert.doesNotMatch(
    dialogSource,
    /modal-(card|backdrop)/,
    `${component} must not draw a legacy modal`,
  );
}

const stateHeader = source("../components/CardStateHeader.tsx");
// C6: the Now callout's title takes focus programmatically (`titleRef`).
assert.match(stateHeader, /titleRef=\{ref\}/);
assert.match(
  stateHeader,
  /aria-live="polite"[\s\S]*\{(?:machineWords\()?nowAnnouncement\(label, disabled \? \(actionName \?\? actionLabel\) : actionLabel, disabled\)\)?\}/,
);

assert.match(board, /<BoardFilterMenu/);
assert.match(
  source("../components/BoardFilterMenu.tsx"),
  /checked=\{filter\.needsYouOnly\}/,
);
assert.match(board, /aria-atomic="true"/);
assert.match(board, /`Showing all \$\{areaCards\.length\} cards`/); // 1.173.0 B2: the count follows the area

const css = source("../App.css");
const reducedStart = css.indexOf("@media (prefers-reduced-motion: reduce)");
const reducedEnd = css.indexOf(".sr-only", reducedStart);
assert.notEqual(reducedStart, -1);
assert.notEqual(reducedEnd, -1);
const reducedMotion = css.slice(reducedStart, reducedEnd);
// GH #171: `.dot-running` went with the Agents panel, its only user.
assert.doesNotMatch(css, /\.dot-running\b/);
// UX-5.4: the Board card's state is a StateWord; its dot's pulse is the ux
// layer's one pulse, which reduced motion stops (UX-0.9).
assert.doesNotMatch(css, /\.kanban-card-state/);
// UX-10.2: the old sidebar's rows and the Activity dot went with their CSS;
// what still animates is stopped here.
// GH #250: the lifecycle pill went with Ship batch's rows, its last user.
assert.doesNotMatch(css, /\.kanban-card-lifecycle/);
for (const selector of [
  ".card-detail-brainstorm-banner--running .card-detail-brainstorm-banner-icon",
]) {
  assert.ok(
    reducedMotion.includes(selector),
    `missing reduced-motion selector: ${selector}`,
  );
}
assert.match(reducedMotion, /animation: none !important/);
assert.match(reducedMotion, /transition: none !important/);

const discussion = source("../components/DiscussionModal.tsx");
assert.match(discussion, /presentation\.sections\.map\(\(section\) =>/);
// GH #104: the post-ship lesson proposal panel is retired (ADR 0005). What
// replaces it — the Challenger's improvement proposal — has its own contract in
// `proposals.test.ts` and draws a `ProposalBlock`, not a section list.

console.log("p3Integration: P3-5 integration wiring assertions passed");
