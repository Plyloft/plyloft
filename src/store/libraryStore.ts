import { create } from "zustand";
import type { LibraryPage, RemovedUpstreamInput, ScopeFilter } from "../lib/librarySkills";

/** Which pair of files a comparison is about (GH #105). */
export type CompareWhat = "duplicate" | "reach";

/**
 * UX language card 4 (GH #96, ADR 0005): where the Library is, per workspace.
 *
 * Session-only, like `useUi`'s centre mode: which page and scope you were
 * looking at is viewer state, and a launch that reopened somebody on a filtered
 * scope would hide skills they never asked to hide. Nothing here is persisted,
 * so there is no schema to migrate.
 *
 * Keyed by `workspaceId` throughout (AGENTS.md: "keep `workspaceId` keyed
 * through editor, terminal, agent and Kanban stores"), because every value here
 * is about one repository's library.
 */
export interface WorkspaceLibrary {
  page: LibraryPage;
  scope: ScopeFilter;
  filter: string;
  /** The skill whose sub-page is open, by row key (`<scope>:<name>`). */
  openSkill: string | null;
  /**
   * The row whose two copies are being compared, by row key.
   *
   * GH #100 (BOARDS.md §4): Compare moved from a sub-page of the **list** to a
   * section of the **skill's page**, so this is now "the open skill, with its
   * comparison showing" — `setCompare` opens the page too, and closing the
   * comparison leaves the member on the page they were reading.
   *
   * GH #105 adds **which** comparison: one name at two scopes (`duplicate`), or
   * the branch's own Claude and Codex copies (`reach`). Two different pairs of
   * files, so the key alone would not say which one to draw.
   */
  compare: { key: string; what: CompareWhat } | null;
  /**
   * The flow a row opened, by row key. A `Flow` is "a focused surface … no
   * navigation" (PATTERNS.md §6), so the host reads this to take the inner
   * column away while one is open — which is why it lives here and not in the
   * page's own React state (GH #96 review 1).
   *
   * GH #101 added `instructions`, the `Set up` step of Library › Instructions.
   * Its key is the constant `"instructions"`: the procedure is about the
   * repository's two files, not about a row that could be one of many.
   *
   * Group B decision §3 added `new-skill`, keyed `"new-skill"` for the same
   * reason: there is no row yet.
   *
   * Owner, 2026-10-19 added `publish`, keyed by the repository row
   * (`repository:<name>`): the scripts sheet before Publish to <branch>, which
   * a refused publish elsewhere (the local-branch block) opens too.
   */
  flow: { kind: "promote" | "align" | "instructions" | "new-skill" | "scripts" | "publish" | "personalize"; key: string } | null;
  /**
   * Skills the integration branch lost while this session was running, from
   * the refresh reports. Not derivable from the branch state: once the mirror
   * has dropped a skill, the only record that a teammate removed it — and that
   * the copy here is the last one — is the report that said so.
   */
  removedUpstream: RemovedUpstreamInput[];
}

const DEFAULT: WorkspaceLibrary = {
  page: "skills",
  scope: "all",
  filter: "",
  openSkill: null,
  compare: null,
  flow: null,
  removedUpstream: [],
};

interface LibraryStore {
  byWorkspace: Record<string, WorkspaceLibrary>;
  setPage: (workspaceId: string, page: LibraryPage) => void;
  setScope: (workspaceId: string, scope: ScopeFilter) => void;
  setFilter: (workspaceId: string, filter: string) => void;
  /** Open a skill's sub-page, or `null` to go back to the list. */
  openSkill: (workspaceId: string, key: string | null) => void;
  /** Open `key`'s page with one of its comparisons showing, or close the
   *  comparison and leave the page where it is. */
  setCompare: (workspaceId: string, key: string | null, what?: CompareWhat) => void;
  /** Open a row's flow, or close it. */
  setFlow: (workspaceId: string, flow: WorkspaceLibrary["flow"]) => void;
  /**
   * Record that the branch lost `name`, for the row's transient state.
   *
   * GH #144: `changedAt` is the commit time the report carried (epoch seconds),
   * and it is kept **as the number**. Review 1 (MAJOR): rendering the words here
   * froze them at the moment the report arrived, and this record lives for the
   * whole session — so the row went on saying `2 minutes ago` about a change from
   * hours before. `skillTransient` says the age from `SkillsInput.nowMs` instead.
   * `null` or absent leaves the sentence without an age rather than a guessed one.
   */
  noteRemovedUpstream: (
    workspaceId: string,
    removed: { name: string; author: string | null; changedAt?: number | null },
  ) => void;
  /** The branch carries `name` again (a teammate added or changed it): the
   *  record of its removal is not true any more. */
  forgetRemovedUpstream: (workspaceId: string, name: string) => void;
  /** `Keep on this Mac`: the row goes back to rest, the copy stays. */
  keepOnThisMac: (workspaceId: string, name: string) => void;
  reset: (workspaceId: string) => void;
}

function patch(
  state: LibraryStore,
  workspaceId: string,
  next: Partial<WorkspaceLibrary>,
): Pick<LibraryStore, "byWorkspace"> {
  const was = state.byWorkspace[workspaceId] ?? DEFAULT;
  return {
    byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...was, ...next } },
  };
}

function forget(
  state: LibraryStore,
  workspaceId: string,
  name: string,
): Pick<LibraryStore, "byWorkspace"> | LibraryStore {
  const was = state.byWorkspace[workspaceId];
  if (!was || !was.removedUpstream.some((r) => r.name === name)) return state;
  return patch(state, workspaceId, {
    removedUpstream: was.removedUpstream.filter((r) => r.name !== name),
  });
}

export const useLibrary = create<LibraryStore>((set) => ({
  byWorkspace: {},
  // Changing page or scope closes whatever sub-page was open: a skill's page
  // belongs to the list it was opened from, and leaving it open under another
  // scope's heading would say it lives there.
  setPage: (workspaceId, page) =>
    set((s) => patch(s, workspaceId, { page, openSkill: null, compare: null, flow: null })),
  setScope: (workspaceId, scope) =>
    set((s) => patch(s, workspaceId, { scope, openSkill: null, compare: null, flow: null })),
  setFilter: (workspaceId, filter) => set((s) => patch(s, workspaceId, { filter })),
  openSkill: (workspaceId, key) =>
    set((s) => patch(s, workspaceId, { openSkill: key, compare: null, flow: null })),
  // A row's `Compare` opens the skill, then its comparison: Board 3 draws the
  // comparison under the skill's own header, so there is no comparison without a
  // page to put it on. Closing it (`null`) leaves `openSkill` alone.
  setCompare: (workspaceId, key, what = "duplicate") =>
    set((s) =>
      patch(s, workspaceId, {
        compare: key ? { key, what } : null,
        flow: null,
        ...(key ? { openSkill: key } : {}),
      }),
    ),
  setFlow: (workspaceId, flow) => set((s) => patch(s, workspaceId, { flow })),
  noteRemovedUpstream: (workspaceId, removed) =>
    set((s) => {
      const was = s.byWorkspace[workspaceId] ?? DEFAULT;
      const entry: RemovedUpstreamInput = {
        name: removed.name,
        author: removed.author,
        // No clock here: the row reads one when it is built (review 1, MAJOR).
        changedAt: removed.changedAt ?? null,
      };
      return patch(s, workspaceId, {
        removedUpstream: [
          ...was.removedUpstream.filter((r) => r.name !== removed.name),
          entry,
        ],
      });
    }),
  // `Keep on this Mac` and "a teammate put it back" are the same edit to the
  // same record, and they are named apart because they are different facts.
  forgetRemovedUpstream: (workspaceId, name) =>
    set((s) => forget(s, workspaceId, name)),
  keepOnThisMac: (workspaceId, name) => set((s) => forget(s, workspaceId, name)),
  reset: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.byWorkspace)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),
}));
