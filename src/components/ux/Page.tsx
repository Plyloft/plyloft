import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { showBackendText } from "../../lib/backendMarks";
import {
  SCOPE_BADGE,
  scopeMarkIcon,
  scopeWords,
  type Scope,
  type SectionScope,
} from "../../lib/uxScope";
import { Icon, type IconName } from "./Icon";
import { machineWords } from "../../lib/platform";
import { createTidyShare, TidyShareContext, tableProps, useTidyTable } from "./useTidyTable";

/** W5: words written for the Mac, drawn for this platform (`this PC`) — a
 *  string, or the strings among JSX children. */
export function forMachine(node: ReactNode): ReactNode {
  // 1.176.0 seams: a backend text drawn by a primitive (Callout, StatusLine,
  // a row's hint…) never shows the backend's typed marks (`backendMarks`).
  const words = (text: string) => machineWords(showBackendText(text));
  if (typeof node === "string") return words(node);
  if (Array.isArray(node)) return node.map((n) => (typeof n === "string" ? words(n) : n));
  return node;
}

/**
 * The heading of the section a row is in (GH #107). A page may draw the same
 * label under two headings — `Builder` under `Claude` and under `Codex` — and a
 * search that lands on one of them has to mark that one.
 */
const SectionContext = createContext<string | null>(null);

/** The section a row sits in, or null outside one. */
export function useSectionTitle(): string | null {
  return useContext(SectionContext);
}

/** A page surface: one scroll for the whole page, a centred reading column.
 *  Nothing inside it scrolls on its own (PATTERNS.md §2). */
export function Page({
  children,
  wide = false,
  footer,
}: {
  children: ReactNode;
  /** The 880 px list column (the Library) instead of the 720 px one. */
  wide?: boolean;
  /** Sticky at the bottom of the scroll (a page's own bar). */
  footer?: ReactNode;
}) {
  return (
    <div className="ux-page">
      <div className={wide ? "ux-page-column ux-page-column--wide" : "ux-page-column"}>
        {children}
      </div>
      {footer && <div className="ux-page-footer">{footer}</div>}
    </div>
  );
}

/** The scope icon of each scope that has one in the icon map. Ply has none: its
 *  label is the word alone. */
const SCOPE_ICON: Partial<Record<Scope, IconName>> = {
  "this-mac": "thisMac",
  repository: "repository",
  team: "team",
};

/** What a page's scope line says: the icon and the name. */
export type ScopeLabel = { icon?: IconName; name: string };

/**
 * UX-9.2: the place a surface says its pages belong to, when that is not the
 * scope's own name — Settings' pages say their group's name above the title
 * (`Cards · notes-app`, 1.174.0 DS1), so the line and the navigation can
 * never disagree (UX-9.3). Where a row is kept is said by its section
 * (`ScopeMark`).
 */
const ScopeLabelContext = createContext<ScopeLabel | null>(null);
export const ScopeLabelProvider = ScopeLabelContext.Provider;

/** UX-9.2: the scope as a line above the title — its Lucide icon and its name
 *  in small muted type, never a badge in a box. */
export function ScopeBadge({ scope }: { scope?: Scope }) {
  const placed = useContext(ScopeLabelContext);
  const label: ScopeLabel | null =
    placed ?? (scope ? { icon: SCOPE_ICON[scope], name: SCOPE_BADGE[scope].name } : null);
  if (!label) return null;
  return (
    <span className="ux-scope-badge">
      {label.icon && <Icon name={label.icon} size="sm" />}
      <span>{label.name}</span>
    </span>
  );
}

/** Back to `Skills`, back to `Build & release`: the way back from a sub-page, 24 px
 *  above the badge (BOARDS.md §4, §6). */
export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="ux-back" onClick={onClick}>
      <span className="ux-back-arrow" aria-hidden>
        <Icon name="back" size="sm" />
      </span>
      {label}
    </button>
  );
}

/** A line under the last group: who set this page, and when. */
export function Footnote({ children }: { children: ReactNode }) {
  return <p className="ux-footnote">{children}</p>;
}

/**
 * The badge, the title, one sentence; then at most a status line.
 *
 * GH #96: `scope` is optional. A page has one scope (PATTERNS.md §2) — except a
 * list page that shows every scope at once, where the sections carry it and a
 * badge on the header would claim the whole page belonged to one of them.
 */
export function PageHeader({
  scope,
  title,
  lede,
  status,
  back,
}: {
  scope?: Scope;
  title: string;
  lede: ReactNode;
  status?: ReactNode;
  /** A sub-page's way back to the page it belongs to. */
  back?: { label: string; onClick: () => void };
}) {
  return (
    <header className="ux-page-header">
      {back && <BackLink label={back.label} onClick={back.onClick} />}
      <ScopeBadge scope={scope} />
      <h1 className="ux-page-title">{machineWords(title)}</h1>
      <p className="ux-page-lede">{forMachine(lede)}</p>
      {status && <div className="ux-page-status">{status}</div>}
    </header>
  );
}

/**
 * 1.174.0 (DS1, D6 b): where a section's rows are kept, right of its title —
 * a grey icon and one of the five shapes of `scopeWords` (`on this Mac`,
 * `shared with the project`…), in this platform's words.
 */
/** 1.174.0 G3a walk: whether the open project can be shared at all — set
 *  once by Settings for its active project (`projectShareable`), read by
 *  every project mark that isn't told otherwise. */
export const ProjectShareableContext = createContext<boolean>(true);

export function ScopeMark(props: ScopeMarkProps) {
  const { scope } = props;
  const shared = props.scope === "repository" ? props.shared : false;
  const pageShareable = useContext(ProjectShareableContext);
  const shareable = props.scope === "repository" ? (props.shareable ?? pageShareable) : true;
  return (
    <span className="ux-scope-mark">
      <Icon name={scopeMarkIcon(scope, { shared })} size="sm" />
      <span>{machineWords(scopeWords(scope, { shared, shareable }))}</span>
    </span>
  );
}

/** A mark's scope: a project row says whether the project shares its setup,
 *  since the mark's words depend on it. */
type ScopeMarkProps =
  | { scope: Exclude<SectionScope, "repository">; shared?: undefined; shareable?: undefined }
  /** `shareable` false: nowhere to share it (solo, no GitHub) — "on this
   *  Mac", never "until you share the project". */
  | { scope: "repository"; shared: boolean; shareable?: boolean };

/** The same for a section, whose mark is optional. */
type SectionScopeProps =
  | { scope?: Exclude<SectionScope, "repository">; shared?: undefined; shareable?: undefined }
  | { scope: "repository"; shared: boolean; shareable?: boolean };

export function Section({
  title,
  count,
  countInline = false,
  action,
  scope,
  shared,
  shareable,
  children,
}: {
  title: string;
  count?: ReactNode;
  /** GH #310: the count right after the title ("Needs you 3"), for a
   *  section that is a group of things rather than a group of settings. */
  countInline?: boolean;
  /** 1.173.0 (F1): the section's one quiet action, at the end of its head
   *  (the Inbox's News: Clear the news). */
  action?: ReactNode;
  children: ReactNode;
} & SectionScopeProps) {
  title = machineWords(title);
  return (
    <SectionContext.Provider value={title}>
      <section className="ux-section">
        <div className={countInline ? "ux-section-head ux-section-head--inline" : "ux-section-head"}>
          <h2 className="ux-section-title">{title}</h2>
          {/* With a mark, the count sits by the title and the mark at the
              far right (TeamPage's Members · 3 … shared with the team). */}
          {count != null && <span className="ux-section-count">{forMachine(count)}</span>}
          {scope === "repository" ? (
            <ScopeMark scope={scope} shared={shared === true} shareable={shareable} />
          ) : (
            scope && <ScopeMark scope={scope} />
          )}
          {action != null && <span className="ux-section-action">{action}</span>}
        </div>
        <TidyColumns>{children}</TidyColumns>
      </section>
    </SectionContext.Provider>
  );
}

/** F6: the tables inside share their action column (useTidyTable's
 *  `TidyShare`): the same button width and right edge down the whole scope.
 *  1.176.3 (owner, 2026-11-23): the scope is a `Section`, not the page — Plan's
 *  "Sign out" no longer takes the width of a button two sections away. */
export function TidyColumns({ children }: { children: ReactNode }) {
  const [share] = useState(createTidyShare);
  return <TidyShareContext.Provider value={share}>{children}</TidyShareContext.Provider>;
}

/** Rows of one kind under a hairline, split by hairlines — and a table (A0):
 *  its rows share columns (main | value | action | more), so every action
 *  button in it has the same width and right edge, ⋯ keeps one slot, and the
 *  whole table wraps at once (useTidyTable). */
export function Group({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const table = useTidyTable(ref);
  return (
    <div ref={ref} {...tableProps(table, "ux-group")} role="group" aria-label={label && machineWords(label)}>
      {children}
    </div>
  );
}

/** 1.173.0 (D2): `warn` — true now and worth knowing, not a failure (a
 *  service that restarts too); the warn colour on the dot only. */
export type RunState = "running" | "done" | "aborted" | "empty" | "warn";

// Spelled out so ux-check can read every class (no `ux-status--${state}`).
const STATUS_CLASS = {
  running: "ux-status ux-status--running",
  done: "ux-status ux-status--done",
  aborted: "ux-status ux-status--aborted",
  empty: "ux-status ux-status--empty",
  warn: "ux-status ux-status--warn",
} as const;

/** One sentence of what is true now, with a run-state dot. */
export function StatusLine({
  state,
  children,
}: {
  state: RunState;
  children: ReactNode;
}) {
  return (
    <p className={STATUS_CLASS[state]}>
      <span className="ux-status-dot" aria-hidden />
      <span className="ux-status-text">{forMachine(children)}</span>
    </p>
  );
}

/** Paths, SHAs, commands and raw output: closed by default.
 *
 *  GH #102 review 2: `onToggle` reports the native disclosure's new state.
 *  Opening a `<details>` is not a React render, and nothing inside it has a
 *  measurable height while it is closed, so a caller that has to place its
 *  content (scroll a log to its end) needs the moment it opens. */
export function Details({
  summary = "Details",
  open,
  onToggle,
  "data-ply-self-check-disclosure": observe,
  children,
}: {
  summary?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** The card page's disclosures are watched by the installed self-check
   *  (`data-ply-self-check-disclosure` on the `<details>` itself, whose
   *  native toggle it waits for). */
  "data-ply-self-check-disclosure"?: string;
  children: ReactNode;
}) {
  return (
    <details
      className="ux-details"
      data-ply-self-check-disclosure={observe}
      open={open}
      onToggle={onToggle ? (e) => onToggle(e.currentTarget.open) : undefined}
    >
      <summary className="ux-details-summary">
        <Icon name="expand" size="sm" />
        {summary}
      </summary>
      <div className="ux-details-body">{children}</div>
    </details>
  );
}

/** What belongs here, and the action that creates the first one. */
export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ux-group ux-empty">
      <p className="ux-empty-text">{forMachine(children)}</p>
      {action && <div className="ux-empty-action">{action}</div>}
    </div>
  );
}

/** The last group of a page; each row names what is lost. */
export function DangerZone({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const table = useTidyTable(ref);
  return (
    <div ref={ref} {...tableProps(table, "ux-group ux-danger-zone")} role="group" aria-label="Danger zone">
      {children}
      {/* 1.174.0 (A7, owner): a calm group; the red is its icon beside the
          first row's title (mockups/board.html §7b) and the destructive
          buttons. Drawn last, placed by the CSS, so the rows stay the
          group's first children. */}
      <span className="ux-danger-zone-icon" aria-hidden="true">
        <Icon name="destructive" size="sm" />
      </span>
    </div>
  );
}

/** The number of a change not yet published; matches the PublishBar jump. */
export function ChangedMark({ n }: { n: number }) {
  return (
    <span className="ux-changed-mark" aria-label={`Change ${n}`}>
      {n}
    </span>
  );
}

/** A change already saved here and on its way to the branch carries the
 *  mark without a number: there is no jump for it in the bar. */
export function PendingMark({ label }: { label: string }) {
  return (
    <span className="ux-changed-mark ux-changed-mark--pending" aria-label={label}>
      ·
    </span>
  );
}
