// Try it TI-5 (docs/try-it/TRY_IT_SPEC.md §3.2): after Ship, Try it in
// <project> — when it is offered, the project's own Try session as the card
// panel's store sees it, and what Code's *Show localhost preview* lists
// first. Pure: no store, no IPC, no DOM, so node runs `tryProject.test.ts`.

import type { KanbanCard } from "../ipc.ts";
import { isSkillCard } from "./skillCards.ts";
import { ownShipEntry } from "./shipVersion.ts";
import { loopbackUrl, portOfAddress } from "./tryAddress.ts";
import { PROJECT_TRY_ID, isProjectTry } from "./tryTile.ts";
import { hostPortOf, type TryRun } from "./tryPanel.ts";

/** The button and the toast's action: "Try it in lyra". */
export function tryInProjectLabel(projectName: string): string {
  const name = projectName.trim();
  return name ? `Try it in ${name}` : "Try it in your project";
}

/** What the rule reads of a card. */
export type ShippedCard = Pick<
  KanbanCard,
  "shipStatus" | "shipHistory" | "prUrl" | "pr" | "prReview" | "kind" | "builder" | "linkedSwarmId"
> &
  Partial<Pick<KanbanCard, "commitSha">> &
  Partial<Pick<KanbanCard, "linkedRunId" | "runHistory" | "buildBoth">>;

/**
 * Whether the card's change is in the project folder now because Ship
 * merged it there on this machine: shipped, its last ship a local merge (not
 * a pull request — see `tryInProjectOffer`), and not a skill card (it
 * changes skills, not the app).
 */
export function shippedLocally(card: ShippedCard): boolean {
  if (card.shipStatus !== "shipped") return false;
  if (card.prReview || isSkillCard(card)) return false;
  // 1.174.0 (DR2 round 1): the card's own ship, not a release that carried it.
  const last = ownShipEntry(card);
  if (!last) return false;
  // A pull request's ship — merged on GitHub (SL-1), open, or shipped as
  // one before SL-1 read pull requests back. Only a closed one's card can
  // have landed here since.
  return !card.prUrl || card.pr?.state === "closed";
}

/** When the Ship receipt offers Try it in <project>. */
export type TryInProjectOffer =
  /** Ship merged it here. */
  | { kind: "local" }
  /** Its pull request was merged on GitHub: offered once the project
   *  folder's checkout holds `mergeCommit` (`try_project_has_commit`). */
  | { kind: "pr"; mergeCommit: string };

export function tryInProjectOffer(card: ShippedCard): TryInProjectOffer | null {
  if (shippedLocally(card)) return { kind: "local" };
  if (card.prReview || isSkillCard(card)) return null;
  const pr = card.prUrl ? card.pr : null;
  if (pr?.state !== "merged" || !pr.mergeCommit?.trim()) return null;
  return { kind: "pr", mergeCommit: pr.mergeCommit.trim() };
}

/** Whether Ship's own toast offers Try it in <project>: the land merged the
 *  change here and that was the whole ship (not a pull request, not a
 *  conflict, not a skill-only ship). Not after a go-live step: it rebuilds
 *  the app detached, and Plyloft can't tell when it is done — the receipt
 *  offers it then, saying so (`GO_LIVE_FIRST`). */
export function shipOffersTryInProject(res: { kind: string; merged: boolean; skillOnly?: boolean }): boolean {
  return res.kind === "local_merge" && res.merged && !res.skillOnly;
}

/** The receipt's line after a ship whose go-live step is rebuilding the app. */
export const GO_LIVE_FIRST = "Plyloft is rebuilding your app first; try it when that has finished.";

/** The workspace the project's Try session runs for. */
export interface TryProject {
  id: string;
  name: string;
  cwd: string;
}

/**
 * The project's Try session as the Try it store runs it: a card-shaped
 * stand-in whose id is `PROJECT_TRY_ID` (one per workspace) and whose
 * "copy" is the workspace's own folder. It has no port block: the folder
 * gets no `PORT`, and the address comes from the output or the common ports.
 */
export function projectTryCard(ws: TryProject): KanbanCard {
  return {
    id: PROJECT_TRY_ID,
    workspaceId: ws.id,
    title: ws.name,
    columnId: "complete",
    createdAt: 0,
    updatedAt: 0,
    worktreePath: ws.cwd,
    portBase: null,
  } as unknown as KanbanCard;
}

/** The common ports' fallback (TI-5): the ones that opened after the session
 *  started — a server that was already there before is never taken for it. */
export function newlyOpenPorts(
  open: readonly number[],
  before: ReadonlySet<number>,
  taken: ReadonlySet<number> = new Set(),
): number[] {
  return open.filter((p) => !before.has(p) && !taken.has(p));
}

/** The ports other Try sessions' addresses are on (starting or running),
 *  never the project session's own fallback: a card's app that opened a
 *  common port after the start is not the project's. */
export function portsOfOtherRuns(
  runs: Readonly<Record<string, TryRun | undefined>>,
  exceptKey: string,
): Set<number> {
  const ports = new Set<number>();
  for (const [key, run] of Object.entries(runs)) {
    if (key === exceptKey || !run?.address) continue;
    if (run.phase !== "running" && run.phase !== "starting") continue;
    const port = portOfAddress(run.address);
    if (port) ports.add(port);
  }
  return ports;
}

/** One running Try session Code's preview can show. */
export interface PreviewChoice {
  key: string;
  /** "Preview lyra · localhost:5173". */
  label: string;
  address: string;
}

/**
 * What *More for Code* lists before *Show localhost preview*: each Try
 * session of `workspaceId` that runs on an address the preview can load
 * (loopback, not https) — the project's first, then the cards' by title.
 * `titleOf` names a card's session (its title, and the build's name when it
 * is built by both); null drops it (the card is gone).
 */
export function tryPreviewChoices(
  runs: Readonly<Record<string, TryRun | undefined>>,
  workspaceId: string,
  projectName: string,
  titleOf: (cardId: string, lane: string | null) => string | null,
): PreviewChoice[] {
  const project: PreviewChoice[] = [];
  const cards: PreviewChoice[] = [];
  for (const [key, run] of Object.entries(runs)) {
    const [ws, cardId, lane] = key.split("\u0000");
    if (ws !== workspaceId || !run || run.phase !== "running" || !run.address || run.secure) continue;
    const address = loopbackUrl(run.address);
    if (!address || address.startsWith("https:")) continue;
    const own = isProjectTry(cardId);
    const name = own ? projectName.trim() || "your project" : titleOf(cardId, lane || null);
    if (!name) continue;
    const choice = { key, label: `Preview ${name} · ${hostPortOf(address)}`, address };
    (own ? project : cards).push(choice);
  }
  cards.sort((a, b) => a.label.localeCompare(b.label));
  return [...project, ...cards];
}
