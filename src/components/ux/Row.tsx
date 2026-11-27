import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { naturalWidth, rowStacks } from "../../lib/uxRow";
import { foundKey, parseRowToken } from "../../lib/settingsSearch";
import { ChangedMark, PendingMark, forMachine, useSectionTitle } from "./Page";

export type RowKind = "toggle" | "choice" | "text" | "value" | "item" | "procedure";

/** What a control inside a row inherits: its label, its hint, its state. */
export type RowState = {
  labelId: string;
  hintId: string;
  disabled: boolean;
  readOnly: boolean;
  error: boolean;
  changed: boolean;
};

const RowContext = createContext<RowState | null>(null);

export function useRowState(): RowState | null {
  return useContext(RowContext);
}

/**
 * GH #107 (BOARDS.md §6 "Search in Settings"): the row a search landed on.
 *
 * The surface puts the token it was sent to here — the label, or `Claude ›
 * Builder` where a page draws that label twice; the row it names brings itself
 * into view, takes an ink outline and says `Found here` beside its label, and
 * both go when the surface takes the token away again, two seconds later. A
 * context and not a store: the mark belongs to the surface the search happened
 * on, and nothing about it is ever saved.
 *
 * `nonce` rises on every landing, so landing twice on the same row scrolls to
 * it twice (review 1, N9) — and so a row seen for one landing does not answer
 * for the next.
 *
 * `onMissing` is how the surface learns that the page drew no such row: a link
 * from outside Settings cannot always know whether a conditional row is there,
 * and landing on nothing has to say so rather than look like nothing happened
 * (review 1, MAJOR 2).
 */
type FoundTarget = {
  label: string;
  section: string | null;
  nonce: number;
  /** The two seconds the row is outlined for. Reporting goes on after it, so a
   *  row that arrives late can still take back what was said about it. */
  marked: boolean;
  /** 1.176.1 walk: the landing takes the focus to the row's field. */
  focus: boolean;
  report: (nonce: number) => void;
  /** A page saying whether it is still reading what its rows are made of, and
   *  `null` for "nothing said" — which is what a page that unmounts leaves
   *  behind (review 3, NF1). */
  reportReading: (reading: boolean | null) => void;
};

const FoundRowContext = createContext<FoundTarget | null>(null);

/**
 * How long after a page has settled a row still has to turn up. One paint is
 * enough; this is a few, for a row drawn by a state the page sets in an effect.
 */
const AFTER_SETTLED_MS = 60;

/**
 * The longest a landing waits for a page that never says whether it is reading
 * (review 2, F2). Every page that reads something before it can draw its rows
 * calls {@link usePageReading}; this is the backstop for the rest, and it is
 * generous on purpose — a sentence that says a row is not there has to be true.
 */
const MISSING_CAP_MS = 5000;

/**
 * A page that reads before it can draw its rows says so: `usePageReading(true)`
 * while the read is in flight, `false` once it has landed. Until then a search
 * that landed on one of its rows says nothing — the row may be about to appear.
 */
export function usePageReading(reading: boolean): void {
  const target = useContext(FoundRowContext);
  const report = target?.reportReading;
  useEffect(() => {
    report?.(reading);
    // The page is going: what it said about its own read says nothing about the
    // page that replaces it (review 3, NF1).
    return () => report?.(null);
  }, [report, reading]);
}

/** 1.174.0 (DS4 round 1): the landing the surface is on — its nonce, which
 *  rises on every search or link to a row — or null. A page with a sub-page
 *  goes back to itself on each one, so the row it names can be drawn. */
export function useLandingNonce(): number | null {
  return useContext(FoundRowContext)?.nonce ?? null;
}

export function FoundRow({
  /** The row token the surface was sent to, or null for none. */
  token,
  /** Rises on every landing. */
  nonce,
  /** Whether the row should be marked right now (the two seconds). */
  marked,
  /** The landing came from a "Fix" or "Open the setting": the row's field
   *  (or what it names, `data-landing-focus-to`) takes the focus. */
  focus = false,
  /** A row of that name was drawn after all. */
  onArrived,
  /** No row of that name was drawn, and the page has stopped reading. */
  onMissing,
  children,
}: {
  token: string | null;
  nonce: number;
  marked: boolean;
  focus?: boolean;
  onArrived?: (token: string) => void;
  onMissing?: (token: string) => void;
  children: ReactNode;
}) {
  const seen = useRef(-1);
  // What the page has said about its own read, and **which landing it said it
  // about**: a report is only ever about the token it was made under, so a new
  // landing starts from "nothing said" without anyone having to reset it
  // (review 3, NF1). null = nothing said; true = still reading; false = settled.
  const [reported, setReported] = useState<{ token: string | null; value: boolean | null }>({
    token: null,
    value: null,
  });
  const reading = reported.token === token ? reported.value : null;
  const arrived = useRef(onArrived);
  const missing = useRef(onMissing);
  arrived.current = onArrived;
  missing.current = onMissing;

  const target = useMemo<FoundTarget | null>(() => {
    if (token === null) return null;
    const { section, label } = parseRowToken(token);
    return {
      label: foundKey(label),
      section: section === null ? null : foundKey(section),
      nonce,
      marked,
      focus,
      report: (at: number) => {
        seen.current = at;
        arrived.current?.(token);
      },
      reportReading: (value: boolean | null) => setReported({ token, value }),
    };
  }, [token, nonce, marked, focus]);

  // Whatever a page says, the answer does not wait for ever.
  useEffect(() => {
    if (token === null) return;
    const timer = window.setTimeout(() => {
      if (seen.current !== nonce) missing.current?.(token);
    }, MISSING_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [token, nonce]);

  // …and it does not wait at all once the page that reads has settled.
  useEffect(() => {
    if (token === null || reading !== false) return;
    const timer = window.setTimeout(() => {
      if (seen.current !== nonce) missing.current?.(token);
    }, AFTER_SETTLED_MS);
    return () => window.clearTimeout(timer);
  }, [token, nonce, reading]);

  return <FoundRowContext.Provider value={target}>{children}</FoundRowContext.Provider>;
}

/**
 * The unit of every page (PATTERNS.md §3). Left: the label and one hint
 * line. Right: the control or the value, then at most one action and a
 * MoreMenu. When the right side does not fit beside 260 px of label it
 * wraps below the label (the label never gives way). A row hovers only when
 * the whole row opens something (`onOpen`); a row that holds a control
 * stays flat.
 */
export function Row({
  kind,
  label,
  hint,
  mono = false,
  chips,
  children,
  action,
  more,
  onOpen,
  changed,
  state,
  struck = false,
  anchor,
  disabled = false,
  readOnly = false,
  error,
  findAs,
  onPress,
  muted = false,
}: {
  kind: RowKind;
  /** The row's title. With `onOpen` it is drawn inside the row's open
   *  `<button>` (GH #181), so it must be phrasing, non-interactive content —
   *  text, a `<span>`, a `<code>`; never a button, link, input or block. */
  label: ReactNode;
  /** One line under the label. A disabled row says why here. */
  hint?: ReactNode;
  /** The label is a path or a name in mono (a skill, a file). */
  mono?: boolean;
  /** Facts that matter at a glance (Item rows). */
  chips?: ReactNode;
  /** The right side: the control or the value. */
  children?: ReactNode;
  /** At most one action, named by its outcome. */
  action?: ReactNode;
  more?: ReactNode;
  /** The whole row opens a sub-page or a flow (Value, Item). */
  onOpen?: () => void;
  /** Changed here, not published yet. `n` numbers the change and matches
   *  the PublishBar's jump; a change already saved and on its way has none.
   *  `hint` replaces the sentence built from `was` (a removed file). */
  changed?: { n?: number; was?: ReactNode; consequence?: ReactNode; hint?: ReactNode };
  /**
   * GH #96 — what is happening to this item right now (BOARDS.md §3
   * "Transient states"). `publishing` and `waiting` carry the 2 px `--fg` left
   * bar of a change that has not landed; `removed` dims the row and strikes
   * the name through. Never colour alone: each one's words sit in the hint.
   */
  state?: "publishing" | "waiting" | "removed";
  /** A removed item keeps its place, struck through, until it is published. */
  struck?: boolean;
  /** The id a PublishBar jump scrolls to. */
  anchor?: string;
  disabled?: boolean;
  readOnly?: boolean;
  /** What happened and that nothing was changed; replaces the hint. */
  error?: ReactNode;
  /** The words a search lands on this row by, when the drawn label says
   *  more than its index entry (QoL 1.168 G10: `Workspace colour (shared
   *  with …)` is found as `Workspace colour`). */
  findAs?: string;
  /** 1.174.0 (A5): a row whose one action is the keyboard's way in, but
   *  which a mouse press anywhere outside its controls also opens (an Inbox
   *  row and its card). No label button and no chevron: the action is the
   *  row's control. Ignored with `onOpen`. */
  onPress?: () => void;
  /** Seen and no longer asking: the label steps down to `--muted` (never
   *  opacity on text). The row keeps its place and its controls. */
  muted?: boolean;
}) {
  // W5: a row written for the Mac names this platform's machine.
  label = forMachine(label);
  hint = forMachine(hint);
  const labelId = useId();
  const hintId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  // The row a search landed on (GH #107). Only a row whose label is words can
  // be found by its words, and a token that names a section only marks the row
  // under that heading.
  const wanted = useContext(FoundRowContext);
  const section = useSectionTitle();
  const isTarget =
    wanted !== null &&
    (findAs !== undefined || typeof label === "string") &&
    foundKey(findAs ?? (label as string)) === wanted.label &&
    (wanted.section === null || (section !== null && foundKey(section) === wanted.section));
  // Drawn for the two seconds the surface marks it; reported for as long as the
  // surface is still saying anything about that row, so a row that arrives after
  // the mark has gone can still take the sentence back (review 2, F1).
  const found = isTarget && wanted.marked;
  const innerRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const opens = !!onOpen && !disabled;
  const hasSide = children != null || action != null || more != null || opens;

  useLayoutEffect(() => {
    const row = rowRef.current;
    const inner = innerRef.current;
    // A0: a row of a table (a `Group`'s own row) wraps with its table, never
    // on its own — the table measures every row and decides once.
    if (!row || !inner || !hasSide || row.parentElement?.classList.contains("ux-table")) {
      setStacked(false);
      return;
    }
    const measure = () => {
      const cs = getComputedStyle(row);
      const content =
        row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setStacked(rowStacks(content, naturalWidth(inner)));
    };
    measure();
    // The row's width, and the side's content (a long action becoming a
    // short status), both decide it; a stacked side spans the row, so its
    // own size says nothing and its content is watched instead.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(row);
    ro?.observe(inner);
    const mo = new MutationObserver(measure);
    mo.observe(inner, { childList: true, subtree: true, characterData: true });
    return () => {
      ro?.disconnect();
      mo.disconnect();
    };
  }, [hasSide]);

  // The surface is told the row is there as soon as it is, marked or not.
  const nonce = wanted?.nonce ?? -1;
  const report = wanted?.report;
  useEffect(() => {
    if (!isTarget) return;
    report?.(nonce);
  }, [isTarget, nonce, report]);
  // Brought into view on every landing — `nonce` rises even when the same row
  // is asked for twice.
  useEffect(() => {
    if (!found) return;
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [found, nonce]);
  // 1.176.1 walk: a landing from a "Fix" or "Open the setting" puts the
  // focus on the row's own field — after the surface's own first focus,
  // which runs in the same commit — or on what that field names (a checked
  // field's first offer while its notice shows).
  const landFocus = found && wanted.focus;
  useEffect(() => {
    if (!landFocus) return;
    const timer = window.setTimeout(() => {
      const row = rowRef.current;
      const field = row?.querySelector<HTMLElement>("input, textarea, select, button");
      const to = field?.getAttribute("data-landing-focus-to");
      const named = to ? document.getElementById(to) : null;
      (named ?? field)?.focus();
      // 1.176.1 walk 2: the field's notice and its offers are in view too.
      named?.closest<HTMLElement>("[role=alert]")?.scrollIntoView?.({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [landFocus, nonce]);

  const hintBody = error ? (
    error
  ) : changed ? (
    (changed.hint != null ? forMachine(changed.hint) : null) ?? (
      <>
        Changed here, not published yet — was <span className="ux-mono-fg">{changed.was}</span>.
        {changed.consequence ? <> {changed.consequence}</> : null}
      </>
    )
  ) : (
    hint
  );

  // Spelled out so ux-check can read every class (no `ux-row--${state}`).
  const STATE_CLASS = {
    publishing: "ux-row--publishing",
    waiting: "ux-row--waiting",
    removed: "ux-row--removed",
  } as const;
  const cls = [
    "ux-row",
    // A0: the row is drawn as cells (main | value | action | more), so a
    // table can line every row's cells up in shared columns.
    "ux-row--cells",
    hasSide ? "" : "ux-row--no-side",
    // A row with no action: in a table its value spans the action column.
    action == null || action === false || action === "" ? "ux-row--no-action" : "",
    opens ? "ux-row--opens" : "",
    stacked ? "ux-row--stacked" : "",
    changed ? "ux-row--changed" : "",
    state ? STATE_CLASS[state] : "",
    struck ? "ux-row--struck" : "",
    disabled ? "ux-row--disabled" : "",
    error ? "ux-row--error" : "",
    found ? "ux-row--found" : "",
    !opens && onPress && !disabled ? "ux-row--presses" : "",
    muted ? "ux-row--muted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const openRef = useRef<HTMLButtonElement>(null);

  function fromNestedControl(target: EventTarget | null, row: Element): boolean {
    const el = target instanceof Element ? target : null;
    // `details`: a disclosure inside an opening row (GH #174 — `On this Mac`'s
    // `Details` beside its `›`) is its own control, so toggling it, or pressing
    // anything in its body, never also opens the row.
    const hit = el?.closest("button, input, select, textarea, a, details, [role='menu']");
    // The row's own open button (GH #181) is not a nested control: its click —
    // a mouse press on the label, or Enter/Space on it — is the row's.
    if (hit && hit === openRef.current) return false;
    return !!hit && hit !== row && row.contains(hit);
  }

  // GH #181: the row itself is never `role="button"`. A button's children are
  // presentational, so a row that was one hid what it holds — a `Details`, a
  // `Reveal in Finder`, a step's button, a switch — from VoiceOver. The open
  // affordance is the label, as a real `<button>` (first in the row, so Tab
  // reaches it and then each nested control in order); a mouse press anywhere
  // else on the row that is not a control still opens it, as before.
  const openProps = opens
    ? {
        onClick: (e: MouseEvent<HTMLDivElement>) => {
          if (!fromNestedControl(e.target, e.currentTarget)) onOpen!();
        },
      }
    : onPress && !disabled
      ? {
          onClick: (e: MouseEvent<HTMLDivElement>) => {
            if (!fromNestedControl(e.target, e.currentTarget)) onPress();
          },
        }
      : {};

  const labelText = (
    <span
      id={labelId}
      className={mono ? "ux-row-label-text ux-row-label-text--mono" : "ux-row-label-text"}
    >
      {label}
    </span>
  );

  return (
    <RowContext.Provider
      value={{
        labelId,
        hintId,
        disabled,
        readOnly,
        error: !!error,
        changed: !!changed,
      }}
    >
      <div ref={rowRef} id={anchor} className={cls} data-kind={kind} {...openProps}>
        <div className="ux-row-main">
          <div className="ux-row-label">
            {changed &&
              (changed.n != null ? (
                <ChangedMark n={changed.n} />
              ) : (
                <PendingMark label="Waiting to publish" />
              ))}
            {opens ? (
              <button
                ref={openRef}
                type="button"
                className="ux-row-open"
                aria-describedby={hintBody ? hintId : undefined}
              >
                {labelText}
              </button>
            ) : (
              labelText
            )}
            {found && <span className="ux-row-found">Found here</span>}
            {chips && <span className="ux-row-chips">{chips}</span>}
          </div>
          {hintBody && (
            <p id={hintId} className="ux-row-hint">
              {hintBody}
            </p>
          )}
        </div>
        {/* A0: the side is drawn as three cells — the value or control,
            the one action, then ⋯ and the chevron — every one of them even
            when it is empty, so a table's columns hold in a row that leaves
            one of them out. A row with nothing on its side has none, and in
            a table its label takes the row's width (`ux-row--no-side`). */}
        {hasSide && (
          <div className="ux-row-side">
            {/* A disabled fieldset disables every control in it — the
                action and the ⋯ included — for mouse and keyboard alike,
                and no child can re-enable itself (Challenger F11). */}
            <fieldset className="ux-row-fieldset" disabled={disabled}>
              <div ref={innerRef} className="ux-row-side-inner">
                <div className="ux-row-cell ux-row-cell--value">{children}</div>
                <div className="ux-row-cell ux-row-cell--action">{action}</div>
                <div className="ux-row-cell ux-row-cell--more">
                  {more}
                  {opens && (
                    <span className="ux-row-chevron" aria-hidden>
                      ›
                    </span>
                  )}
                </div>
              </div>
            </fieldset>
          </div>
        )}
      </div>
    </RowContext.Provider>
  );
}

/** A value on the right of a Value or Procedure row (status words). */
export function RowValue({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={mono ? "ux-row-value ux-row-value--mono" : "ux-row-value"}>{forMachine(children)}</span>
  );
}

/**
 * QoL 1.168 G11 (visual-b V-5): a small caption over one of a row's
 * controls, where a row holds two of them side by side — `Model` over the
 * model field, `Effort` over its effort — so neither has to be hovered to be
 * told apart. The control keeps its own accessible name.
 */
export function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <span className="ux-captioned">
      <span className="ux-caption" aria-hidden="true">
        {caption}
      </span>
      {children}
    </span>
  );
}
