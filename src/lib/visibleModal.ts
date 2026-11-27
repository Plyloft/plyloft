/**
 * GH #95 (Challenger review 2, P2): a modal only blocks a global shortcut
 * while it is actually on screen.
 *
 * Since Code and Knowledge became sticky hosts (one per warmed workspace,
 * CSS-hidden when inactive), a sheet (`.ux-sheet-backdrop`; before UX-10.1
 * a `.modal-backdrop`) can sit inside a hidden host — `EditorPanel`'s
 * "changed on disk" confirm for a dirty file in another workspace, say. A
 * bare `document.querySelector` guard treated that as an open modal and
 * silently killed ⌘K and ⌘P until the user found a dialog they could not
 * see. The pending confirmation is kept (it shows when its host comes
 * back); it just stops blocking.
 */

/** What a candidate backdrop looks like to the rule. */
export type ModalProbe = {
  /** `getClientRects().length` — 0 when it or an ancestor is `display:none`. */
  rects: number;
  /** Computed `visibility`, which inherits from the hidden host. */
  visibility: string;
};

export function modalBlocksShortcuts(probe: ModalProbe): boolean {
  return probe.rects > 0 && probe.visibility !== "hidden";
}

export function anyModalBlocksShortcuts(
  probes: readonly ModalProbe[],
): boolean {
  return probes.some(modalBlocksShortcuts);
}

/** The probes of every element matching `selector`. */
export function probesOf(
  doc: Pick<Document, "querySelectorAll">,
  selector: string,
  styleOf: (el: Element) => { visibility: string } = (el) => getComputedStyle(el),
): ModalProbe[] {
  return [...doc.querySelectorAll(selector)].map((el) => ({
    rects: el.getClientRects().length,
    visibility: styleOf(el).visibility,
  }));
}

/** True when a modal the user can actually see is open: a sheet
 *  (`.ux-sheet-backdrop`) or a UX-language surface (`.ux-backdrop`, the
 *  Settings shell). */
export function visibleModalOpen(doc: Document = document): boolean {
  return anyModalBlocksShortcuts(probesOf(doc, ".ux-sheet-backdrop, .ux-backdrop"));
}

/** Challenger F6: a sheet the user can see sits above the Settings shell
 *  (its backdrop is drawn over it). A confirmation parked in a hidden
 *  workspace host has rects but inherits `visibility: hidden`, and must not
 *  swallow Settings' Esc or ⌘F. */
export function sheetAbove(
  doc: Pick<Document, "querySelectorAll"> = document,
  styleOf?: (el: Element) => { visibility: string },
): boolean {
  return anyModalBlocksShortcuts(probesOf(doc, ".ux-sheet-backdrop", styleOf));
}
