import { memo, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useWorkspaces } from "../store/workspaceStore";
import { useTiles } from "../store/tileStore";
import { showTile } from "../store/tileActions";
import { useKanban } from "../store/kanbanStore";
import { useInbox } from "../store/inboxStore";
import { useReconciledFeed } from "../hooks/useNeedsYou";
import { useCardPresenter } from "../hooks/useCardLive";
import { CARD_ROW_PREFIX } from "../lib/inboxReconcile";
import { openCenterMode, switchToWorkspace, useUi } from "../store/uiStore";
import type { WaitingSession } from "../lib/needsYou";
import { workspaceAccentColor } from "../lib/workspaceColor";
import { EMPTY_ARRAY } from "../lib/empties";
import {
  EMPTY_ORDER,
  holdOrder,
  idleWorkspacesLabel,
  itemStateWord,
  recentWorkspaces,
  STACK_CAP,
  stackSlots,
  stackSummary,
  capStackSummary,
  stackItemDot,
  workspaceStack,
  type HeldOrder,
  type StackEntry,
  type StackItem,
} from "../lib/workspaceStack";
import { Icon, StateWord } from "./ux";
import { WorkspaceIconChip } from "./WorkspaceIconChip";

/** The run-state colours (PRINCIPLES): needs you is the work done, green;
 *  failed is amber; working is indigo, pulsing. Always beside words. */

/**
 * The stack of other workspaces (Notion's teamspaces), under the current
 * workspace's section: every other workspace where something needs the
 * person, failed, or is working — `lib/workspaceStack.ts` says which and in
 * what order. A row switches to it, its chevron lists what is going on
 * there, and an item switches and opens that tile or card. Below them, in
 * the slots left under the one cap, the workspaces used recently this
 * session, as plain rows (a name; a click switches). The rest stay in the
 * switcher, behind one quiet "N more workspaces" row.
 *
 * Presentation only: nothing here spawns, kills or unmounts a session — a
 * switch is the switcher's (`switchToWorkspace`), and every warmed
 * workspace's hosts stay mounted as they are.
 */
export function WorkspaceStack({
  now,
  waiting,
  onNavigate,
}: {
  now: number;
  waiting: readonly WaitingSession[];
  onNavigate?: () => void;
}) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const tilesBy = useTiles((s) => s.byWorkspace);
  const cardsBy = useKanban((s) => s.byWorkspace);
  // P-A: the feed as the loaded cards say it, as every count reads it.
  const events = useReconciledFeed(waiting)?.events ?? EMPTY_ARRAY;
  const lastActiveAt = useUi((s) => s.workspaceActiveAt);
  const expanded = useUi((s) => s.stackExpanded);
  const showAll = useUi((s) => s.stackShowAll);
  const captionId = useId();
  // UX P-A Mac walk 5: an item that speaks for its card has its card's dot.
  const presenter = useCardPresenter();

  const entries = useMemo(
    () =>
      workspaceStack({
        workspaces,
        activeId,
        events,
        waiting,
        tilesByWorkspace: tilesBy,
        cardsByWorkspace: cardsBy,
        presentOf: (ws, cardId) => {
          const card = cardsBy[ws]?.cards.find((c) => c.id === cardId);
          return card ? presenter(card) : null;
        },
        lastActiveAt,
        // As the session rows: the clock when drawn (Windows walk, block 10).
        now: Math.max(now, Date.now()),
      }),
    [workspaces, activeId, events, waiting, tilesBy, cardsBy, lastActiveAt, now, presenter],
  );

  const recent = useMemo(
    () =>
      recentWorkspaces({
        workspaces,
        activeId,
        lastActiveAt,
        exclude: new Set(entries.map((e) => e.workspaceId)),
      }),
    [workspaces, activeId, lastActiveAt, entries],
  );

  // One cap for both groups: the stateful rows win the slots (lib: stackSlots).
  const slots = stackSlots(
    entries.map((e) => e.workspaceId),
    recent.map((r) => r.workspaceId),
    showAll,
  );
  // Rows keep their places while a new order settles (lib: holdOrder) — a
  // recent row that starts working shows its state where it is, then moves
  // up once the new order has held.
  const held = useRef<HeldOrder>(EMPTY_ORDER);
  held.current = holdOrder(held.current, slots.wanted, now);
  const stateById = new Map(entries.map((e) => [e.workspaceId, e]));
  const recentById = new Map(recent.map((r) => [r.workspaceId, r]));

  const others = workspaces.filter((w) => w.id !== activeId).length;
  const idle = others - entries.length - slots.recentShown;
  if (others === 0) return null;
  const rows = held.current.shown;

  return (
    <section
      className="shell-stack"
      aria-labelledby={rows.length > 0 ? captionId : undefined}
      aria-label={rows.length > 0 ? undefined : "Other workspaces"}
    >
      {rows.length > 0 && (
        <div id={captionId} className="shell-caption">
          Other workspaces
        </div>
      )}
      {rows.length > 0 && (
        <ul className="shell-stack-list">
          {rows.map((id) => {
            const entry = stateById.get(id) ?? null;
            const name = entry?.name ?? recentById.get(id)?.name;
            if (name == null) return null;
            // One component for both kinds, so a row that gains or loses its
            // state keeps its open button (and the focus on it).
            return (
              <StackRow
                key={id}
                workspaceId={id}
                name={name}
                entry={entry}
                expanded={entry != null && Boolean(expanded[id])}
                onNavigate={onNavigate}
              />
            );
          })}
        </ul>
      )}
      {slots.hiddenActive > 0 && (
        <button
          type="button"
          className="shell-session shell-stack-more"
          onClick={() => useUi.getState().setStackShowAll(true)}
        >
          {slots.hiddenActive} more active
        </button>
      )}
      {showAll && entries.length > STACK_CAP && (
        <button
          type="button"
          className="shell-session shell-stack-more"
          onClick={() => useUi.getState().setStackShowAll(false)}
        >
          Show fewer
        </button>
      )}
      {idle > 0 && (
        <button
          type="button"
          className="shell-session shell-stack-more"
          title="Open the workspace switcher"
          onClick={() => useUi.getState().requestSwitcherOpen(true)}
        >
          {idleWorkspacesLabel(idle)}
        </button>
      )}
    </section>
  );
}

/** Rows redraw when what they show changes, not on every tick. */
function sameEntry(a: StackEntry | null, b: StackEntry | null): boolean {
  if (a == null || b == null) return a === b;
  if (
    a.workspaceId !== b.workspaceId ||
    a.name !== b.name ||
    a.needsYou !== b.needsYou ||
    a.failed !== b.failed ||
    a.working !== b.working ||
    a.running !== b.running ||
    a.items.length !== b.items.length
  ) {
    return false;
  }
  return a.items.every((x, i) => {
    const y = b.items[i];
    return x.key === y.key && x.name === y.name && x.state === y.state && x.words === y.words && x.dot === y.dot;
  });
}

/** Words for a row used recently, idle now: its name and these. */
const RECENT_WORDS = "used recently";

/**
 * One other workspace. With a state (`entry`): its name, the state in words
 * and the chevron that lists what is going on. Used recently and idle now
 * (`entry` null): the name only — no state, no chevron. Either way a click on
 * the name switches to it as the switcher does.
 */
const StackRow = memo(
  function StackRow({
    workspaceId,
    name,
    entry,
    expanded,
    onNavigate,
  }: {
    workspaceId: string;
    name: string;
    entry: StackEntry | null;
    expanded: boolean;
    onNavigate?: () => void;
  }) {
    const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null);
    const rowRef = useRef<HTMLLIElement>(null);
    const openRef = useRef<HTMLButtonElement>(null);
    // Losing its state takes the chevron and the item list away. If the focus
    // was on one of them, it would fall to the page: it goes to the row's
    // name instead. Read during render, while they are still in the DOM.
    const hadEntry = useRef(entry != null);
    const refocus = useRef(false);
    if (hadEntry.current && entry == null) {
      const at = document.activeElement;
      refocus.current =
        at != null && at !== openRef.current && (rowRef.current?.contains(at) ?? false);
    }
    hadEntry.current = entry != null;
    useLayoutEffect(() => {
      if (!refocus.current) return;
      refocus.current = false;
      openRef.current?.focus();
    });
    const summary = entry ? stackSummary(entry) : [];
    const words = entry ? summary.map((p) => p.text).join(", ") : RECENT_WORDS;
    // QoL 1.168 (block 10, A8): two chips and "+N", never one cut mid-word.
    const chips = capStackSummary(summary);
    const listId = `shell-stack-items-${workspaceId}`;
    const toggle = (on?: boolean) => useUi.getState().toggleStackExpanded(workspaceId, on);

    function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
      if (!entry) return;
      if (e.key === "ArrowRight" && !expanded) {
        e.preventDefault();
        toggle(true);
      } else if (e.key === "ArrowLeft" && expanded) {
        e.preventDefault();
        toggle(false);
      }
    }

    function switchTo() {
      switchToWorkspace(workspaceId);
      onNavigate?.();
    }

    return (
      <li ref={rowRef} className="shell-stack-entry">
        <div className="shell-stack-row">
          <button
            ref={openRef}
            type="button"
            className="shell-stack-open"
            aria-label={`${name}, ${words}`}
            title={`${name} — ${words}. Switches to it.`}
            onClick={switchTo}
            onKeyDown={onKeyDown}
          >
            {ws && (
              <WorkspaceIconChip
                icon={ws.icon ?? null}
                name={ws.name}
                accent={workspaceAccentColor(ws.accentColor, ws.name)}
                size="xs"
              />
            )}
            <span className="shell-stack-text">
              <span className="shell-stack-name">{name}</span>
              {entry && (
                <span className="shell-stack-summary" aria-hidden="true">
                  {chips.shown.map((p) => (
                    <StateWord key={p.shell ? "running" : p.state} state={p.dot} live={p.dot === "running"}>
                      {p.text}
                    </StateWord>
                  ))}
                  {chips.more > 0 && <span className="shell-stack-more-chips">+{chips.more}</span>}
                </span>
              )}
            </span>
          </button>
          {entry && (
            <button
              type="button"
              className="shell-stack-toggle"
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              aria-label={`${expanded ? "Hide" : "Show"} what is going on in ${name}`}
              title={expanded ? "Hide the list" : "Show what is going on here"}
              onClick={() => toggle()}
              onKeyDown={onKeyDown}
            >
              <Icon name="expand" size="sm" />
            </button>
          )}
        </div>
        {entry && expanded && (
          <ul id={listId} className="shell-stack-items" aria-label={`In ${name}`}>
            {entry.items.map((item) => (
              <li key={item.key}>
                <StackItemRow
                  workspaceId={workspaceId}
                  item={item}
                  word={itemStateWord(entry, item)}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  },
  (a, b) =>
    a.workspaceId === b.workspaceId &&
    a.name === b.name &&
    a.expanded === b.expanded &&
    a.onNavigate === b.onNavigate &&
    sameEntry(a.entry, b.entry),
);

function StackItemRow({
  workspaceId,
  item,
  word,
  onNavigate,
}: {
  workspaceId: string;
  item: StackItem;
  /** The short state beside the name, when the row mixes states. */
  word: string | null;
  onNavigate?: () => void;
}) {
  function open() {
    openStackItem(workspaceId, item);
    onNavigate?.();
  }
  return (
    <button
      type="button"
      className="shell-session shell-stack-item"
      aria-label={`${item.name}, ${item.words}`}
      title={`${item.name} — ${item.words}. Opens it.`}
      onClick={open}
    >
      {/* UX P-A Mac walk 6: the item says its state on screen, in the
          Inbox row's words, not only in its accessible name. */}
      <StateWord
        state={stackItemDot(item)}
        live={item.dot ? item.dot === "running" : item.state === "working"}
      >
        <span className="shell-session-text">
          <span className="shell-session-name">{item.name}</span>
          <span className="shell-session-state" aria-hidden="true">
            {item.words}
          </span>
        </span>
      </StateWord>
      {word && word !== item.words && (
        <span className="shell-stack-word" aria-hidden="true">
          {word}
        </span>
      )}
    </button>
  );
}

/**
 * Switch to the workspace, then open the item the way its own surface does:
 * a feed row through the Inbox's jump (which also marks it seen), a card on
 * its Board, a tile expanded in Terminals — the current section's row. A
 * workspace removed meanwhile opens nothing (GH #152's guard).
 */
export function openStackItem(workspaceId: string, item: StackItem): void {
  if (!useWorkspaces.getState().workspaces.some((w) => w.id === workspaceId)) return;
  switchToWorkspace(workspaceId);
  if (item.eventId) {
    const ev = useInbox.getState().feed?.events.find((e) => e.id === item.eventId);
    if (ev) {
      useInbox.getState().open(ev);
      return;
    }
    // (Challenger, P-A) A row the frontend adds for a loaded card is not in
    // Rust's feed: it opens its card below and is marked seen, as the
    // Inbox's own open does.
    if (item.eventId.startsWith(CARD_ROW_PREFIX)) void useInbox.getState().markSeen([item.eventId]);
  }
  const target = item.target;
  if (target.kind === "card") {
    useUi.getState().selectCard(workspaceId, target.cardId);
  } else if (target.kind === "tile") {
    // QoL 1.168 (A1): on Terminals, with the keyboard in it.
    showTile(workspaceId, target.tileId);
  } else {
    openCenterMode(workspaceId, "activity");
  }
}
