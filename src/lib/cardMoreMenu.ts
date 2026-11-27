// 1.172.0 D1 (T7 CP-4, card-page B5): the card's ⋯ in four headed groups —
// Build, Ship, Session, Card — with Delete last, apart from the rest, and
// nothing in it that Now already offers for the same card state. Pure — no
// React, no stores — so node runs it (`src/lib/cardMoreMenu.test.ts`).
import type { MenuAction, MenuItem } from "../components/ux/MoreMenu.tsx";

export type CardMoreGroup = "build" | "ship" | "session" | "card";

/** A pressable item of the menu (not a heading, not a divider). */
export type CardMoreAction = MenuAction;

export interface CardMoreEntry {
  group: CardMoreGroup;
  item: CardMoreAction;
}

/** The groups in the order the menu shows them, with their headings. */
export const CARD_MORE_GROUPS: readonly { group: CardMoreGroup; heading: string }[] = [
  { group: "build", heading: "Build" },
  { group: "ship", heading: "Ship" },
  { group: "session", heading: "Session" },
  { group: "card", heading: "Card" },
];

/** A label as the person reads it: the "…" that says a sheet follows, the
 *  spacing and the case don't make two presses different. */
export function pressName(label: string): string {
  return label.replace(/…$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** Two labels for the one press: Now's draft says "Plan it with Claude
 *  first", the ⋯ said "Plan again with Claude" — both start the planning
 *  conversation. A name maps to its press's key; anything else is itself. */
function pressKey(label: string): string {
  const name = pressName(label);
  if (/^plan (it |again )?with (claude|codex)( first)?$/u.test(name)) return "plan-with-one-ai";
  // A busy label is the same press as its idle one.
  if (name === "making the card") return "follow up";
  // ("Setting up…" is Start build's too, so it names no one press.)
  if (name === "starting both") return "build with both";
  return name;
}

/** The ⋯ items whose press Now already shows (its primary, its quiet
 *  alternative, See the changes, Try it, the primary's ▾ choices). */
export function nowDuplicates(nowLabels: readonly string[], moreLabels: readonly string[]): string[] {
  const inNow = new Set(nowLabels.map(pressKey));
  return moreLabels.filter((label) => inNow.has(pressKey(label)));
}

/** The menu: each non-empty group under its heading, in `CARD_MORE_GROUPS`
 *  order, the entries in the order they were given. A danger item (Delete
 *  card…) goes last, after a divider, so it never sits beside an ordinary
 *  press. Entries Now already offers are left out (`nowLabels`). */
export function cardMoreMenu(entries: readonly CardMoreEntry[], nowLabels: readonly string[] = []): MenuItem[] {
  const dup = new Set(nowDuplicates(nowLabels, entries.map((e) => e.item.label)));
  const kept = entries.filter((e) => !dup.has(e.item.label));
  const menu: MenuItem[] = [];
  for (const { group, heading } of CARD_MORE_GROUPS) {
    const items = kept.filter((e) => e.group === group).map((e) => e.item);
    const plain = items.filter((i) => !i.danger);
    const danger = items.filter((i) => i.danger);
    if (plain.length === 0 && danger.length === 0) continue;
    menu.push({ heading });
    menu.push(...plain);
    if (danger.length > 0) {
      if (plain.length > 0) menu.push("divider");
      menu.push(...danger);
    }
  }
  return menu;
}

/** The labels of a menu's pressable items, in order. */
export function menuLabels(menu: readonly MenuItem[]): string[] {
  return menu.flatMap((m) => (m === "divider" || "heading" in m ? [] : [m.label]));
}

/** Every press the Now box draws: its primary, its quiet alternatives (See
 *  the changes, Try it, the secondary) and the choices of its menus (the
 *  primary's ▾, Plan it first ▾). The one list `cardMoreMenu` leaves out. */
export function nowPressLabels(now: {
  primary: string;
  alternatives?: readonly ({ label: string } | null | undefined)[];
  menus?: readonly (readonly MenuItem[] | null | undefined)[];
}): string[] {
  return [
    now.primary,
    ...(now.alternatives ?? []).flatMap((a) => (a ? [a.label] : [])),
    ...(now.menus ?? []).flatMap((m) => menuLabels(m ?? [])),
  ];
}

/** 1.172.0 D1 (CP-4): run history's switch and Clear left the ⋯ for the
 *  runs themselves (More about this card). Only an agent's or a team of
 *  agents' run is recorded — the Builder's never is — so the block shows on
 *  a card that has runs, may get them, or doesn't record them. */
export function runHistoryShown(card: {
  runHistory?: readonly unknown[] | null;
  suppressRunHistory?: boolean | null;
  agentConfigId?: string | null;
  swarmTemplateId?: string | null;
  linkedRunId?: string | null;
  linkedSwarmId?: string | null;
}): boolean {
  return (
    (card.runHistory?.length ?? 0) > 0 ||
    card.suppressRunHistory === true ||
    Boolean(card.agentConfigId || card.swarmTemplateId || card.linkedRunId || card.linkedSwarmId)
  );
}
