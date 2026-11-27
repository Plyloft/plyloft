import { useEffect, useId, useRef, useState } from "react";
import type { FindingAnchor } from "../ipc";
import { findingFocusLive, useUi } from "../store/uiStore";
import {
  anchorFateNote,
  anchorLabel,
  anchorOpenByDefault,
  anchorStateLine,
  anchorStateWord,
  anchorTitle,
  anchorWhere,
} from "../lib/findingAnchors";
import { CBtn, Icon } from "./ux";
import { InlineMd } from "./InlineMd";
import { SMALL_NOTE_MARK } from "../lib/deliveryWords";

/**
 * CL-6: a Challenger finding on the review diff, under the line it names
 * (or under its file's name when the diff doesn't show that line). Its own
 * look, apart from the person's line comments: a neutral row with the
 * finding's id, severity, title and state in words. The text opens from the
 * title; open findings that ask for changes start open, P3s and other
 * non-blocking or closed findings start as one line. "Show in the findings
 * list" goes to the same finding in the review's list, and the list's
 * "Show on the diff" comes back here.
 */
export function FindingAnchorRow({
  anchor,
  cardId,
  showWhere = false,
}: {
  anchor: FindingAnchor;
  cardId: string;
  /** Under the file's name: say which line it is. */
  showWhere?: boolean;
}) {
  const [open, setOpen] = useState(() => anchorOpenByDefault(anchor));
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focus = useUi((s) => s.findingFocus);
  const focusFinding = useUi((s) => s.focusFinding);
  const inList = useUi((s) => (s.findingLists[cardId] ?? 0) > 0);
  const note = anchorFateNote(anchor);
  const where = showWhere ? anchorWhere(anchor) : null;

  // The list asked for this finding: open it, bring it into view, focus it.
  useEffect(() => {
    if (!findingFocusLive(focus) || focus.to !== "diff" || focus.cardId !== cardId || focus.findingId !== anchor.id) return;
    focusFinding(null);
    setOpen(true);
    revealAncestors(rootRef.current);
    rootRef.current?.scrollIntoView?.({ block: "center" });
    toggleRef.current?.focus();
  }, [focus, focusFinding, cardId, anchor.id]);

  return (
    <div
      ref={rootRef}
      className={`card-review-anchor${open ? " is-open" : ""}`}
      role="group"
      aria-label={anchorLabel(anchor)}
      data-ply-diff-anchor={anchor.id}
      data-ply-anchor-fate={anchor.fate}
      data-ply-anchor-state={anchor.state}
    >
      <div className="card-review-anchor-head">
        <button
          ref={toggleRef}
          type="button"
          className="card-review-anchor-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((on) => !on)}
        >
          <Icon name="expand" size="sm" />
          <span className="card-review-anchor-title">
            <InlineMd text={anchorTitle(anchor)} links={false} />
            {/* A dismissal is the state word beside (anchorStateWord), once. */}
            {!anchor.dismissed && anchor.nonBlocking && anchor.state !== "closed" ? ` · ${SMALL_NOTE_MARK}` : ""}
          </span>
        </button>
        <span className="cchip cchip--outline">{anchorStateWord(anchor)}</span>
      </div>
      {where && <p className="card-review-anchor-note">{where}</p>}
      {note && <p className="card-review-anchor-note">{note}</p>}
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            <p className="card-review-anchor-note">{anchorStateLine(anchor)}</p>
            <p className="card-review-anchor-body">
              <InlineMd text={anchor.body} />
            </p>
          </>
        )}
      </div>
      {inList && (
        <CBtn
          tone="quiet"
          size="sm"
          aria-label={`Show ${anchor.id} in the findings list`}
          onClick={() => focusFinding({ cardId, findingId: anchor.id, to: "list" })}
        >
          Show in the findings list
        </CBtn>
      )}
    </div>
  );
}

/** Open every closed `<details>` around `el`, so it can be seen. */
export function revealAncestors(el: Element | null) {
  let details = el?.parentElement?.closest("details") ?? null;
  while (details) {
    details.open = true;
    details = details.parentElement?.closest("details") ?? null;
  }
}
