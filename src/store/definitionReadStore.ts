import { create } from "zustand";
import { workspaceDefinitionRefresh } from "../ipc";
import type { RefreshMoment } from "../lib/definitionRefresh";

/**
 * Two-account walk, 2026-11-02: the frontend's one way of reading a project's
 * shared definition from its integration branch. The warmed workspaces' timer
 * (`App.tsx`) reads through here, and so do the moments a person is looking at
 * the answer: Settings › Project opening, Team's "Read it again", and the press
 * that moves a board.
 *
 * Those three read with the moment `pageRead`: the backend's `refresh_with`, so
 * a read that changes the board is the ten-minute read. The read itself publishes
 * nothing (no queue drained, no library or direction pushed); what it finds can
 * start the Board's existing automatic steps, as any read does. Only a person's
 * own change and the other reads publish.
 *
 * It is a fetch: one at a time per workspace, and a page doesn't read again
 * within `DEFINITION_REREAD_MIN_MS` of a read that went through. A read that
 * didn't reach the remote doesn't count, or it would hold the next one back.
 * While a Project page stays open it reads every `DEFINITION_PAGE_READ_EVERY_MS`
 * (`useProjectPageReads`).
 */

/** How long after a read of a workspace a page opening doesn't read it again. */
export const DEFINITION_REREAD_MIN_MS = 30_000;

/** How often a Project page left open reads again. */
export const DEFINITION_PAGE_READ_EVERY_MS = 60_000;

/** No pointer or key in the window for this long: a page stops reading. */
export const DEFINITION_PAGE_IDLE_MS = 15 * 60_000;

/** An answer this old on screen is recent: a page doesn't hold its presses for a
 *  read that would refresh it. */
const DEFINITION_ANSWER_RECENT_MS = 2 * DEFINITION_PAGE_READ_EVERY_MS;

/** The longest a page holds its presses for a read (`useBoundedHold`): a fetch
 *  on a network that hangs takes 20 s a go, and what the page knows is still the
 *  last good answer. The read itself goes on. */
export const DEFINITION_READ_HOLD_MS = 15_000;

/** `unreached`: the read returned, but its fetch failed (`fetchError`), so what
 *  it read is this Mac's last fetched copy. `failed`: it didn't run at all. */
export type DefinitionReadOutcome = "read" | "unreached" | "failed";

interface DefinitionReads {
  reading: Record<string, true>;
  /** Rises when somebody pressed for a read, or a press found the page out of
   *  date: every status on screen reads again, whatever the report said. */
  statusAsked: Record<string, number>;
}

export const useDefinitionReads = create<DefinitionReads>(() => ({ reading: {}, statusAsked: {} }));

const inFlight = new Map<string, { moment: RefreshMoment; read: Promise<DefinitionReadOutcome> }>();
const lastReadAt = new Map<string, number>();
/** When a read last came back with anything, reached or not: offline, a page
 *  doesn't hold its presses again and again for the same answer. */
const lastAnswerAt = new Map<string, number>();

function setReading(workspaceId: string, on: boolean) {
  useDefinitionReads.setState((s) => {
    if (on === !!s.reading[workspaceId]) return s;
    const reading = { ...s.reading };
    if (on) reading[workspaceId] = true;
    else delete reading[workspaceId];
    return { reading };
  });
}

/** Read now, or join the read already running. Never rejects: offline, or with
 *  its folder gone, a workspace keeps what it has. A warm or ten-minute read that
 *  finds a `pageRead` running follows it, because it also publishes what waits. */
export function readDefinition(
  workspaceId: string,
  moment: RefreshMoment = "pageRead",
  /** Nobody waits on this one: a page's presses aren't held for it. */
  { quiet = false }: { quiet?: boolean } = {},
): Promise<DefinitionReadOutcome> {
  if (!quiet) setReading(workspaceId, true);
  const running = inFlight.get(workspaceId);
  if (running) {
    if (running.moment === "pageRead" && moment !== "pageRead") {
      return running.read.then(() => readDefinition(workspaceId, moment, { quiet }));
    }
    return running.read;
  }
  const read = Promise.resolve()
    .then(() => workspaceDefinitionRefresh(workspaceId, moment))
    .then(
      (report): DefinitionReadOutcome => {
        lastAnswerAt.set(workspaceId, Date.now());
        if (report?.fetchError) return "unreached";
        lastReadAt.set(workspaceId, Date.now());
        return "read";
      },
      (e): DefinitionReadOutcome => {
        console.warn(`workspace definition ${moment} refresh failed:`, e);
        return "failed";
      },
    )
    .finally(() => {
      inFlight.delete(workspaceId);
      setReading(workspaceId, false);
    });
  inFlight.set(workspaceId, { moment, read });
  return read;
}

/** How long until a page may read this workspace: 0 when it may now. */
export function definitionReadDueIn(workspaceId: string): number {
  const last = lastReadAt.get(workspaceId);
  if (last === undefined) return 0;
  return Math.max(0, last + DEFINITION_REREAD_MIN_MS - Date.now());
}

/** A page asking: read unless one has just gone through. A read already running
 *  is joined. */
export function readDefinitionIfDue(workspaceId: string, { quiet = false }: { quiet?: boolean } = {}): void {
  if (!inFlight.has(workspaceId) && definitionReadDueIn(workspaceId) > 0) return;
  void readDefinition(workspaceId, "pageRead", { quiet });
}

/** A report arrived, from whichever read made it (a Sync, Start build, a publish
 *  in the backend): if it reached the remote, the definition has just been read. */
export function noteDefinitionRead(report: { workspaceId: string; fetchError?: string | null }): void {
  lastAnswerAt.set(report.workspaceId, Date.now());
  if (!report.fetchError) lastReadAt.set(report.workspaceId, Date.now());
}

export function definitionAnswerIsRecent(workspaceId: string): boolean {
  const last = lastAnswerAt.get(workspaceId);
  return last !== undefined && Date.now() - last < DEFINITION_ANSWER_RECENT_MS;
}

/** See `statusAsked`. */
export function askForStatusAgain(workspaceId: string): void {
  useDefinitionReads.setState((s) => ({
    statusAsked: { ...s.statusAsked, [workspaceId]: (s.statusAsked[workspaceId] ?? 0) + 1 },
  }));
}

/** `work`'s answer, or `null` once a page has waited as long as it holds. */
export function withinDefinitionHold<T>(work: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DEFINITION_READ_HOLD_MS);
    void work.then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function useDefinitionReading(workspaceId: string | null): boolean {
  return useDefinitionReads((s) => (workspaceId ? !!s.reading[workspaceId] : false));
}

export function resetDefinitionReadsForTests(): void {
  inFlight.clear();
  lastReadAt.clear();
  lastAnswerAt.clear();
  useDefinitionReads.setState({ reading: {}, statusAsked: {} });
}
