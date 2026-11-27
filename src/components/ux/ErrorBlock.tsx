import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Details } from "./Page";
import { CBtn } from "../ui/primitives";
import { errorForMachine, type UxError, type UxErrorAction } from "../../lib/uxError";
import { cliRepairActionTool, withCliRepair } from "../../lib/cliNotStarting";
import { openRepair } from "../../lib/openRepair";

/**
 * UX language card 7 (GH #102; BOARDS.md §5 "The error shape", PATTERNS.md §4):
 * the block an error lives in, on the page it concerns.
 *
 * A `--raised` block with the aborted border and an aborted dot, the title,
 * then the three parts — `What happened` · `What was left untouched` ·
 * `What to do` — each an eyebrow and a sentence; then up to **two** actions,
 * one per way out; then `Details` with the tool's own output.
 *
 * It is built from a {@link UxError} and only from one. There is no prop that
 * takes a message to split, because the three parts are three facts and a
 * sentence that has been cut up has already lost one of them.
 *
 * `Details` keeps PATTERNS.md §4's closed default; the caller passes
 * `detailsOpen` where a board fixes it open. BOARDS.md §5 does, for the
 * fast-forward refusal, whose raw output is two lines of git. A failing test
 * runner's output is not two lines (GH #102 review 1), so it is not opened for
 * the reader, the pane scrolls, and `detailsToEnd` shows its end — where
 * runners say what failed (GH #62).
 *
 * Review 2: that scroll happens when the disclosure **opens** and when the
 * output changes, never from a ref callback. Inside a closed `<details>` the
 * pane has no height to scroll, and opening one is a native toggle that React
 * does not render for — so a mount-time ref left the log at its start. A ref
 * callback also re-runs whenever its identity changes, which would have yanked
 * the pane to the bottom under a reader's cursor on any later render.
 *
 * Every id is `useId`: each warmed workspace keeps its own host mounted, so
 * two blocks can be in the document at once and a fixed id would make the
 * labels point at the wrong one.
 *
 * GH #150: `density="dense"` draws the same block at a work surface's density
 * (PRINCIPLES.md §4: the card is 13 px, a page 15). Only the measures change,
 * each to a token the card already uses (`ux-error--dense`, PATTERNS.md §4);
 * the structure, the words, the two ways out and the bounded `Details` do
 * not. A page keeps the default. It is a declared deviation, drawn on no
 * board, until the owner validates it at Tier 4.
 */
export function ErrorBlock({
  error: given,
  onAction,
  busy,
  detailsAction,
  detailsOpen,
  detailsToEnd,
  density = "page",
}: {
  error: UxError;
  /** A way out was pressed, by `UxErrorAction.id`. */
  onAction?: (id: string) => void;
  /** The action that is running: it and its siblings go inert. */
  busy?: string | null;
  /** What belongs under the raw output — the card's `Open full log`. */
  detailsAction?: ReactNode;
  /** Draw the disclosure open, where a board fixes it open. */
  detailsOpen?: boolean;
  /** Show the end of the output rather than its start. */
  detailsToEnd?: boolean;
  /** `dense` on a work surface (the card); a page keeps `page` (GH #150). */
  density?: "page" | "dense";
}) {
  // W5: the machine as this platform names it (`this PC`), whoever built the
  // error; Details stay verbatim.
  // 1.176.0 R7: a Claude or Codex that is installed but doesn't start, as
  // the cause: its sentence and Repair, which the block answers itself.
  const error = errorForMachine(withCliRepair(given));
  const press = (id: string) => {
    const tool = cliRepairActionTool(id);
    if (tool) void openRepair(tool);
    else onAction?.(id);
  };
  const repairs = error.actions.some((a) => cliRepairActionTool(a.id));
  const titleId = useId();
  const working = busy != null;
  const output = useRef<HTMLPreElement | null>(null);
  const [open, setOpen] = useState(detailsOpen ?? false);
  // Stable, so no render moves the pane on its own.
  const toEnd = useCallback(() => {
    const el = output.current;
    if (el && detailsToEnd) el.scrollTop = el.scrollHeight;
  }, [detailsToEnd]);
  useEffect(() => {
    if (open) toEnd();
  }, [open, error.details, toEnd]);
  return (
    <section
      className={density === "dense" ? "ux-error ux-error--dense" : "ux-error"}
      role="group" aria-labelledby={titleId}>
      <p className="ux-error-title" id={titleId}>
        <span className="ux-error-dot" aria-hidden />
        <span className="ux-error-title-text">{error.title}</span>
      </p>
      <Part eyebrow="What happened">{error.happened}</Part>
      <Part eyebrow="What was left untouched">{error.untouched}</Part>
      <Part eyebrow="What to do">{error.todo}</Part>
      {/* Its ways out only with somewhere to send a press: a block given no
          onAction draws none (the onePrimary guard counts it as none). */}
      {(onAction || repairs) && error.actions.length > 0 && (
        <div className="ux-error-actions">
          {error.actions.slice(0, 2)
            .filter((action) => onAction || cliRepairActionTool(action.id))
            .map((action) => (
              <Way
                key={action.id}
                action={action}
                busy={busy === action.id}
                disabled={working}
                onClick={() => press(action.id)}
              />
            ))}
        </div>
      )}
      {(error.details || detailsAction) && (
        <div className="ux-error-details">
          <Details
            open={open}
            onToggle={(isOpen) => {
              setOpen(isOpen);
              if (isOpen) toEnd();
            }}
          >
            {error.details && (
              <pre className="ux-error-output" ref={output}>
                {error.details}
              </pre>
            )}
            {detailsAction && <div className="ux-error-details-action">{detailsAction}</div>}
          </Details>
        </div>
      )}
    </section>
  );
}

function Part({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <div className="ux-error-part">
      <p className="ux-error-eyebrow">{eyebrow}</p>
      <p className="ux-error-sentence">{children}</p>
    </div>
  );
}

/** One way out. The first is the primary button; a destructive one is
 *  `--danger` (PATTERNS.md §1) and never the primary. */
function Way({
  action,
  busy,
  disabled,
  onClick,
}: {
  action: UxErrorAction;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <CBtn
      tone={action.primary ? "accent" : action.danger ? "danger" : "ghost"}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {action.label}
    </CBtn>
  );
}
