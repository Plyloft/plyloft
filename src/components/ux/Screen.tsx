// UX-2.3 (ADR 0007): the primitives the Design System v2 proposed for the
// shell, the card page and lists — Breadcrumb/ScreenHeader, Properties,
// Callout, Timeline, Popover and Flow. One scale: `--type-*`, `--space-*`,
// `--radius-*`; no colour literal (ux-check). ListView is in ListView.tsx.
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "./Icon";
import { useDismiss } from "./MoreMenu";
import { useEscapeFirst } from "./useEscapeFirst";
import { forMachine, type RunState } from "./Page";

/** `parent`: the screen is a page below this crumb (1.174.0 E3: Terminals ›
 *  Copies) — the last crumb is then a link too, with its › after it. */
export type Crumb = { label: string; onClick?: () => void; parent?: boolean };

/**
 * The top of every screen in the stage: where you are, the title, one place
 * for actions. The last crumb is the screen itself and is never a link.
 */
export function ScreenHeader({
  crumbs,
  title,
  size = "title",
  actions,
  subtitle,
}: {
  crumbs: Crumb[];
  /** GH #254: null on a card page, whose title heads its page column. */
  title: ReactNode | null;
  /** `display` on a card page, `title` everywhere else. */
  size?: "title" | "display";
  /** At most one primary and a `⋯`. */
  actions?: ReactNode;
  /** 1.172.1 (F2): one quiet line under the title (the Board's "Cards come
   *  from the GitHub issues of …"). */
  subtitle?: ReactNode;
}) {
  return (
    <header className="ux-screen-header">
      {crumbs.length > 0 && (
        <nav className="ux-crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1 && !c.parent;
            return (
              <span key={`${i}-${c.label}`} className="ux-crumb">
                {!last && c.onClick ? (
                  <button type="button" className="ux-crumb-link" onClick={c.onClick}>
                    {c.label}
                  </button>
                ) : (
                  <span aria-current={last ? "page" : undefined}>{c.label}</span>
                )}
                {!last && <Icon name="opens" size="sm" />}
              </span>
            );
          })}
        </nav>
      )}
      {(title !== null || actions) && (
        <div className="ux-screen-top">
          {title !== null && (
            <h1 className={size === "display" ? "ux-screen-title ux-screen-title--display" : "ux-screen-title"}>
              {title}
            </h1>
          )}
          {actions && <div className="ux-screen-actions">{actions}</div>}
        </div>
      )}
      {subtitle && <div className="ux-screen-subtitle">{subtitle}</div>}
    </header>
  );
}

export type Property = {
  icon?: IconName;
  label: string;
  value: ReactNode;
  /** 1.171.0 C3: a help mark after the label (`TermHelp`). */
  help?: ReactNode;
  /** GH #263: a value that can grow tall (a list of cards) takes a row of
   *  its own across both columns, so it never leaves a hole beside a short
   *  one in the other column. */
  wide?: boolean;
};

/** Key facts under a title, label left in muted, value right. At most eight.
 *  QoL 1.168 (C1, V-1): `line` draws them as one compact line under the
 *  card's Now box — "Builder Claude · Checks Passed · …" — wrapping only
 *  when the page is narrow. */
export function Properties({
  items,
  line = false,
  trailing,
  trailingLabel,
}: {
  items: Property[];
  line?: boolean;
  /** 1.172.0 D2: a press after every fact (the card's Change…), named for a
   *  screen reader by `trailingLabel`. */
  trailing?: ReactNode;
  trailingLabel?: string;
}) {
  return (
    <dl className={line ? "ux-props ux-props--line" : "ux-props"}>
      {items.map((p) => (
        <div key={p.label} className={p.wide ? "ux-prop ux-prop--wide" : "ux-prop"}>
          <dt className="ux-prop-label">
            {p.icon && !line && <Icon name={p.icon} size="sm" />}
            {p.label}
            {p.help}
          </dt>
          <dd className="ux-prop-value">{p.value}</dd>
        </div>
      ))}
      {trailing && (
        <div className="ux-prop ux-prop--trailing">
          <dt className="ux-sr-only">{trailingLabel}</dt>
          <dd className="ux-prop-value">{trailing}</dd>
        </div>
      )}
    </dl>
  );
}

const DOT = {
  running: "ux-state-dot ux-state-dot--running",
  done: "ux-state-dot ux-state-dot--done",
  aborted: "ux-state-dot ux-state-dot--aborted",
  empty: "ux-state-dot",
  warn: "ux-state-dot ux-state-dot--warn",
} as const;
const DOT_LIVE = {
  running: "ux-state-dot ux-state-dot--running ux-state-dot--live",
  done: "ux-state-dot ux-state-dot--done ux-state-dot--live",
  aborted: "ux-state-dot ux-state-dot--aborted ux-state-dot--live",
  empty: "ux-state-dot ux-state-dot--live",
  warn: "ux-state-dot ux-state-dot--warn ux-state-dot--live",
} as const;

/** A run-state dot and its word: never colour alone. */
export function StateWord({ state, children, live }: { state: RunState; children: ReactNode; live?: boolean }) {
  return (
    <span className="ux-state">
      <span className={live ? DOT_LIVE[state] : DOT[state]} aria-hidden="true" />
      {/* 1.171.0 (B1): "Shipped · only on this Mac" reads "this PC" on Windows. */}
      {forMachine(children)}
    </span>
  );
}

const CALLOUT = {
  now: "ux-callout ux-callout--now",
  info: "ux-callout ux-callout--info",
  warn: "ux-callout ux-callout--warn",
  danger: "ux-callout ux-callout--danger",
} as const;

const CALLOUT_ICON: Record<"info" | "warn" | "danger", IconName> = {
  info: "info",
  warn: "warning",
  danger: "destructive",
};

/**
 * A block out of the page flow. `now` is the card's "what is happening, and
 * the one action"; `info` and `warn` are notices; `danger` only comes before
 * destroying something.
 */
export function Callout({
  kind,
  state,
  live,
  title,
  path,
  text,
  actions,
  titleRef,
  iconTone,
  id,
  actionsBelow = false,
}: {
  kind: "now" | "info" | "warn" | "danger";
  /** F1 (1.172.1): an `info` notice whose toast warns — the warning icon in
   *  its colour, on the calm surface (no tinted box), so the notice and its
   *  toast show the same kind. */
  iconTone?: "warn";
  /** `now` only: the run state its dot shows. */
  state?: RunState;
  live?: boolean;
  title?: ReactNode;
  /** 1.171.0 (B1): a block under the title, before the text — the card's
   *  delivery path (`DeliveryPathLine`). */
  path?: ReactNode;
  text?: ReactNode;
  actions?: ReactNode;
  /** The card page moves focus to its Now title (C6): the title takes focus
   *  programmatically only (`tabIndex -1`). */
  titleRef?: Ref<HTMLParagraphElement>;
  /** 1.176.1: for a field whose Tab and landing reach this notice's offers. */
  id?: string;
  /** 1.176.1 Windows walk: the offers under the text, the notice's full
   *  width, one per line — a long offer squeezed the text to a column. */
  actionsBelow?: boolean;
}) {
  return (
    <div id={id} className={actionsBelow ? `${CALLOUT[kind]} ux-callout--below` : CALLOUT[kind]} role={kind === "warn" || kind === "danger" ? "alert" : undefined}>
      {kind === "now" ? (
        <span className="ux-callout-dot">
          <span className={live ? DOT_LIVE[state ?? "empty"] : DOT[state ?? "empty"]} aria-hidden="true" />
        </span>
      ) : (
        <span className={iconTone === "warn" ? "ux-callout-icon ux-callout-icon--warn" : "ux-callout-icon"}>
          <Icon name={iconTone === "warn" ? "warning" : CALLOUT_ICON[kind]} />
        </span>
      )}
      <div className="ux-callout-text">
        {title && (
          <p className="ux-callout-title" ref={titleRef} tabIndex={titleRef ? -1 : undefined}>
            {forMachine(title)}
          </p>
        )}
        {path}
        {text && <p className="ux-callout-body">{forMachine(text)}</p>}
      </div>
      {actions && <div className="ux-callout-actions">{actions}</div>}
    </div>
  );
}

export type TimelineEvent = {
  id: string;
  state: RunState;
  text: ReactNode;
  when: string;
  live?: boolean;
  /** One way into the thing that did it: "Open session", "See the diff". */
  link?: { label: string; onClick: () => void; ariaLabel?: string };
};

/** A card's story, oldest first. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="ux-timeline">
      {events.map((e) => (
        <li key={e.id} className="ux-timeline-event" data-ply-event={e.id}>
          <span className="ux-timeline-dot">
            <span className={e.live ? DOT_LIVE[e.state] : DOT[e.state]} aria-hidden="true" />
          </span>
          <span className="ux-timeline-text">
            {e.text}
            {e.link && (
              <button type="button" className="ux-timeline-link" onClick={e.link.onClick} aria-label={e.link.ariaLabel}>
                {e.link.label}
              </button>
            )}
          </span>
          <span className="ux-timeline-when">{e.when}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A floating panel anchored under its trigger (the workspace switcher, a
 * filter). Esc and a click outside close it.
 */
export function Popover({
  trigger,
  open,
  onClose,
  label,
  width = "md",
  children,
}: {
  trigger: ReactNode;
  open: boolean;
  onClose: () => void;
  label: string;
  width?: "md" | "lg";
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, root, onClose);
  // Esc closes the popover before the surface under it, while focus is in it.
  useEscapeFirst(open, root, onClose);
  // GH #264: opened under its trigger's left edge it may pass the window's
  // right edge (the card's Blocked by at 900 px); then it opens leftwards,
  // its right edge on the trigger's — unless that would pass the left edge.
  const [end, setEnd] = useState(false);
  useLayoutEffect(() => {
    if (!open) {
      setEnd(false);
      return;
    }
    const box = panel.current?.getBoundingClientRect();
    const anchor = root.current?.getBoundingClientRect();
    if (!box || !anchor || box.width === 0) return;
    const room = document.documentElement.clientWidth || window.innerWidth;
    if (box.right > room && anchor.right - box.width >= 0) setEnd(true);
  }, [open]);
  const cls = [
    "ux-popover",
    width === "lg" ? "ux-popover--lg" : "",
    end ? "ux-popover--end" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div ref={root} className="ux-popover-anchor">
      {trigger}
      {open && (
        <div ref={panel} className={cls} role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A focused procedure in the centre, no navigation: what changes, then one
 * confirming action. The pieces six flows assembled by hand.
 */
export function Flow({
  step,
  title,
  lede,
  actions,
  children,
}: {
  /** Sentence case: "Align · 1 step". */
  step?: string;
  title: ReactNode;
  lede?: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ux-flow">
      {step && <p className="ux-flow-step">{step}</p>}
      <h2 className="ux-flow-title">{forMachine(title)}</h2>
      {lede && <p className="ux-page-lede">{forMachine(lede)}</p>}
      {children}
      <div className="ux-flow-actions">{actions}</div>
    </div>
  );
}
