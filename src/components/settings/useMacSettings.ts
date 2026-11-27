import { useCallback } from "react";
import { useSettings } from "../../store/settingsStore";
import type { Settings } from "../../lib/settingsShape";
import {
  changeSentence,
  pageResetPaths,
  readPath,
  withPath,
  resetPage,
  type MacField,
} from "../../lib/settingsFields";
import {
  UNDO_SUPERSEDED,
  claimUndo,
  fieldUndoKey,
  releaseUndo,
  resetUndoKey,
  runUndo,
  type LiveUndos,
} from "../../lib/undoable";
import type { EntryId } from "../../lib/settingsNav";
import { dismissToast, pushToast } from "../../store/toastStore";
import { noteControlInUse, rowJustNamed } from "../../lib/rowInUse";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 8 (GH #103; PATTERNS.md §5, BOARDS.md §5): the This Mac
 * pages save as you change them.
 *
 * Every control calls {@link MacSettings.set}. That is one mutation on the
 * settings queue (`lib/settingsQueue.ts`), so it is applied to the settings as
 * they are **when it runs** — never to the copy the render that drew the
 * control was holding. The value it replaces is read inside that same
 * mutation, which is the only moment both the old and the new value are true
 * at once; `Undo` is a second mutation that writes that captured value back.
 *
 * Reading it from a render snapshot instead is the bug card #94 found twice:
 * a toast pressed after another change landed would put the settings back to
 * a state nobody asked for.
 *
 * Review 1 found the other half of the same problem. One field can change twice
 * inside the Undo window — `TypeOrChoose` does it in a single gesture, because
 * blurring commits and then picking commits again — and two live toasts for one
 * field meant the older one could quietly discard the newer change. So there is
 * **one live Undo per field** (a new change dismisses the toast it replaces),
 * and an Undo whose value has moved on **does nothing and says so**
 * (`lib/undoable.ts`, tested on its own).
 */

/** About six seconds (BOARDS.md §5: "Undo for about 6 s"). */
export const UNDO_MS = 6000;

/** The live Undo per key. Module-level, not per mount: a toast outlives the
 *  page that raised it, and an Undo pressed after Settings was closed and
 *  reopened has to find the same bookkeeping. */
const live: LiveUndos = new Map();

export interface MacSettings {
  settings: Settings;
  /** The value a control shows: the committed one, as this render saw it. */
  value: (field: MacField) => unknown;
  /** The value as it is **now**, after a write has landed. A control that shows
   *  what was typed reads this to take a corrected value back (review 1,
   *  finding 13: typing `10` into a field with a floor of 500 left `10` in the
   *  box, because the stored value had not changed). */
  latest: (field: MacField) => unknown;
  /** Save this field, say so, and offer Undo. Resolves false when the write
   *  was refused, so a control can keep what the person typed. */
  set: (field: MacField, next: unknown) => Promise<boolean>;
  /** `Reset this page to defaults`, with one Undo for the whole page. */
  reset: (page: EntryId) => Promise<boolean>;
}

export function useMacSettings(): MacSettings {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const resetSettings = useSettings((s) => s.reset);

  const set = useCallback(
    async (field: MacField, next: unknown): Promise<boolean> => {
      // 1.176.2: what the field refuses is never written; its row says why.
      if (field.refuse?.(next)) return false;
      // Walk 4: the row in use, for the toast this save raises (a checked
      // field has named its own already).
      if (!rowJustNamed() && typeof document !== "undefined" && document.activeElement && !document.activeElement.closest("[data-notice-for]")) {
        noteControlInUse(document.activeElement);
      }
      let was: unknown;
      let wrote: unknown;
      let wroteIn: Settings | undefined;
      let moved = false;
      try {
        await update((latest) => {
          was = field.read(latest);
          const after = field.write(latest, next);
          wrote = field.read(after);
          wroteIn = after;
          moved = !same(was, wrote);
          return after;
        });
      } catch (e) {
        pushToast({
          kind: "error",
          title: `Couldn't save ${lower(field.label)} on this Mac`,
          details: String(e),
        });
        return false;
      }
      // Typing a name and pressing Enter, or blurring a field nobody changed,
      // is not a change: a toast for it would be noise with an Undo that
      // undoes nothing.
      if (!moved) return true;
      const restore = was;
      const announced = wrote;
      offerUndo({
        key: fieldUndoKey(field.id),
        title: changeSentence(field, wrote, wroteIn),
        // Decided inside the mutation, against the state the restore is about
        // to be applied to — never against the last committed one, which a
        // second change to the same field may already have left behind (N1).
        restore: () =>
          runUndo(update, {
            announced,
            read: (latest) => field.read(latest),
            restore: (latest) => field.write(latest, restore),
          }),
      });
      return true;
    },
    [update],
  );

  const reset = useCallback(
    async (page: EntryId): Promise<boolean> => {
      // 1.176.3 (review M1): the Undo puts back what was stored at each path
      // the reset named — never a field's read replayed through its write,
      // which differs where a read is derived (Who builds new cards reads
      // `lastBuilderVendor ?? builderVendor`, and its write clears the first).
      const paths = pageResetPaths(page);
      const at = (s: Settings) => Object.fromEntries(paths.map((p) => [p, readPath(s, p) ?? null]));
      let before: Settings;
      let saved: Settings;
      try {
        // 1.176.3 (owner): the page's keys go back whatever wrote them, so
        // what was there and what landed are the backend's, read under its
        // lock — a value Plyloft wrote after this window's copy included, and
        // the Undo puts that back too.
        ({ before, saved } = await resetSettings((latest) => resetPage(latest, page), paths));
      } catch (e) {
        pushErrorToast("Couldn't put this page back to how Plyloft ships", e);
        return false;
      }
      const announced = at(saved);
      if (same(at(before), announced)) {
        pushToast({
          kind: "info",
          title: "This page is already how Plyloft ships. Nothing was changed.",
        });
        return true;
      }
      const was = before;
      offerUndo({
        key: resetUndoKey(page),
        title: "This page is back to how Plyloft ships, on this Mac.",
        restore: () =>
          runUndo(update, {
            // A page's Undo is overtaken when **any** path it reset has moved
            // on since: putting the rest back would undo a change nobody was
            // asked about.
            announced,
            read: at,
            restore: (latest) => paths.reduce((out, p) => withPath(out, p, was), latest),
          }),
      });
      return true;
    },
    [update, resetSettings],
  );

  return {
    settings,
    value: (field) => field.read(settings),
    latest: (field) => field.read(useSettings.getState().settings),
    set,
    reset,
  };
}

/**
 * One Undo toast, filed under `key`: it replaces whatever was live for that key,
 * and its `restore` reports whether it actually wrote — the value it announced
 * has to still be there when its turn on the queue comes (`runUndo`).
 */
function offerUndo(undo: {
  key: string;
  title: string;
  restore: () => Promise<boolean>;
}): void {
  // Walk 3: after Undo the focus goes back to the field it restored, when
  // that field is still on screen — the control in use once this save's
  // own focus has settled (a checked field puts it back on its input).
  let field: HTMLElement | null = null;
  const note = () => {
    // The second look runs on a timer: the page may be gone by then.
    if (typeof document === "undefined") return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body && el.matches("input, select, textarea, button")) field = el;
  };
  note();
  if (typeof window !== "undefined") window.setTimeout(note, 50);
  const backToField = () => {
    if (field?.isConnected && !field.closest("[hidden], [aria-hidden=true]")) {
      field.focus();
      return;
    }
    // Walk 4: the restored field isn't on this page: never focus on
    // nothing — the open page's heading takes it.
    const heading = document.querySelector<HTMLElement>(".ux-surface .ux-page-title, .ux-surface .ux-surface-title");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  };
  const id = pushToast({
    kind: "info",
    title: undo.title,
    action: {
      label: "Undo",
      ttlMs: UNDO_MS,
      // On the same queue as every other change, and with no toast of its
      // own: an Undo that announced itself would offer to undo the undo.
      onClick: () => {
        releaseUndo(live, undo.key, id);
        void undo
          .restore()
          .then((applied) => {
            // Said from the mutation's answer, not from a comparison made
            // before it: only the mutation knows what it found.
            if (!applied) pushToast({ kind: "warn", title: UNDO_SUPERSEDED });
            else window.setTimeout(backToField, 0);
          })
          .catch((e) =>
            pushErrorToast("Couldn't undo that", e),
          );
      },
    },
  });
  // Two Undos for one thing is how the older one gets pressed and throws the
  // newer change away. There is only ever the latest.
  const replaced = claimUndo(live, undo.key, id);
  if (replaced) dismissToast(replaced);
}

/** Two settings values that mean the same thing. `null` and `undefined` both
 *  mean "nothing set" in `settings.json`, so a model field written blank over
 *  an absent one has not changed. */
function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return a === b;
}

/** `Tile shell` → `tile shell`, for the middle of a sentence; an acronym and
 *  a proper noun keep their capitals. */
function lower(label: string): string {
  const [first, ...rest] = label.split(" ");
  if (first.length > 1 && first === first.toUpperCase()) return label;
  return [first.charAt(0).toLowerCase() + first.slice(1), ...rest].join(" ");
}
