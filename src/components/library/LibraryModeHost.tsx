import { useEffect, useRef, useState } from "react";
import { NavList, Page, Segmented, Select, type NavListGroup } from "../ux";
import { SkillsPage } from "./SkillsPage";
import { useMyLibrarySkills } from "./MyLibrarySection";
import { useSkillsData } from "./useSkillsData";
import { InstructionsPage } from "./InstructionsPage";
import { useInstructionsData } from "./useInstructionsData";
import {
  LIBRARY_PAGES,
  LIBRARY_PAGE_LABEL,
  SCOPE_NAV_LABEL,
  SCOPE_NAV_ORDER,
  scopeCounts,
  skillSections,
  type LibraryPage,
  type ScopeFilter,
} from "../../lib/librarySkills";
import { useLibrary } from "../../store/libraryStore";
import { useProposal } from "../../store/proposalStore";

/**
 * UX language card 4 (GH #96, ADR 0005; BOARDS.md §3): the Library — a centre
 * mode beside Board, Code and Terminals.
 *
 * One host per warmed workspace, mounted the first time that workspace shows
 * the Library and only CSS-hidden after (`stickyHosts` in
 * `NewWorkspaceShell`): a page's local state (a filter, a flow) survives a mode
 * flip. Nothing here ever unmounts a terminal or the editor.
 *
 * UX-9.5 retired the Notes page and the Knowledge panel it embedded: the
 * notes stay on disk, untouched, and the Library is Instructions and Skills.
 *
 * At a wide centre a 220 px inner column holds the two eyebrow groups the board
 * draws. Under 1000 px of centre the column goes and the same choices sit under
 * the lede, as a segmented control and a scope select.
 */
const NARROW_CENTRE = 1000;

export function LibraryModeHost({
  workspaceId,
  cwd,
  visible,
}: {
  workspaceId: string;
  cwd: string;
  /** This workspace's visible mode is the Library. The host stays mounted
   *  either way; hidden, it does no IPC. */
  visible: boolean;
}) {
  const state = useLibrary((s) => s.byWorkspace[workspaceId]);
  const page: LibraryPage = state?.page ?? "skills";
  const scope: ScopeFilter = state?.scope ?? "all";
  // PATTERNS.md §6: a flow is "a focused surface (same shell, no navigation)".
  // While one is open the inner column and the narrow controls go, so the one
  // question it asks is the only thing on the page (review 1).
  const inFlow = state?.flow != null;

  // The centre's own width, not the window's: the sidebar can be resized or
  // closed, so the window says nothing about the room this page has.
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setNarrow(el.clientWidth < NARROW_CENTRE);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Read once, here: the column shows the counts and the page shows the rows,
  // and two callers of the loader would mean two `git pull`s per open and two
  // toasts for one failure.
  const data = useSkillsData(workspaceId, visible);
  // 1.174.0 (X3): My library's count, from All skills' index.
  const mine = useMyLibrarySkills();
  const counts = scopeCounts(data.input ? skillSections(data.input) : [], mine.length);
  // GH #101: the same rule, for the Instructions page's own two reads — only
  // while the Library is this workspace's visible mode, and only while that page
  // is the one showing.
  const instructions = useInstructionsData(
    workspaceId,
    visible && page === "instructions",
  );

  // GH #104: read the Challenger's proposal when this workspace's Library
  // becomes visible, so a page opened after a refresh elsewhere is current.
  //
  // The **subscription** is not here (review 2, R6): it is
  // `startProposalSubscriptions`, at app level, because the card's Ship step and
  // the Inbox row need it whether or not anybody has visited the Library.
  useEffect(() => {
    if (!visible) return;
    void useProposal.getState().refresh(workspaceId);
  }, [workspaceId, visible]);

  const groups: NavListGroup[] = [
    {
      label: "Library",
      entries: LIBRARY_PAGES.map((id) => ({ id, label: LIBRARY_PAGE_LABEL[id] })),
    },
  ];
  // GH #313: the scopes and their counts are the Skills list's filter — skill
  // counts — so they sit beside Skills alone; beside Instructions they would
  // describe a page that is not showing.
  if (page === "skills") {
    groups.push({
      label: "Scope",
      entries: [
        { id: "scope:all", label: SCOPE_NAV_LABEL.all, count: counts.all },
        // A scope with nothing in it is left out: the board's `Ply 4` belongs
        // to the card that ships Ply's own skills, and `Ply 0` would offer a
        // choice that can only land on an empty page.
        ...SCOPE_NAV_ORDER.filter((s) => counts[s] > 0).map((s) => ({
          id: `scope:${s}`,
          label: SCOPE_NAV_LABEL[s],
          count: counts[s],
        })),
      ],
    });
  }

  const select = (id: string) => {
    if (id.startsWith("scope:")) {
      // A scope is a filter of the Skills list, so choosing one lands there
      // (the page first: `setPage` clears the scope's own sub-page).
      useLibrary.getState().setPage(workspaceId, "skills");
      useLibrary
        .getState()
        .setScope(workspaceId, id.slice("scope:".length) as ScopeFilter);
      return;
    }
    useLibrary.getState().setPage(workspaceId, id as LibraryPage);
  };

  // GH #313: the page is always the current entry; on Skills the chosen scope
  // is marked with it, as the filter of that page.
  const active = page;
  const also = page === "skills" ? `scope:${scope}` : null;

  // Under a narrow centre the column's choices sit under the lede, so each
  // page places them itself: a control above its own title would read as part
  // of the shell rather than of the page (BOARDS.md §3, state E).
  const controls = narrow && !inFlow ? (
    // The Library's pages, as the tour points at them (`library-tabs`): this
    // compact row and the nav column below are never drawn together.
    <div className="ux-library-compact" data-ply-tour="library-tabs">
      <Segmented
        value={page}
        onChange={(next) => useLibrary.getState().setPage(workspaceId, next)}
        options={LIBRARY_PAGES.map((id) => ({
          value: id,
          label: LIBRARY_PAGE_LABEL[id],
        }))}
        label="Library"
      />
      {page === "skills" && (
        <Select
          value={scope}
          onChange={(next) =>
            useLibrary.getState().setScope(workspaceId, next as ScopeFilter)
          }
          options={[
            { value: "all", label: `All scopes ${counts.all}` },
            ...SCOPE_NAV_ORDER.filter((s) => counts[s] > 0).map((s) => ({
              value: s,
              label: `${SCOPE_NAV_LABEL[s]} ${counts[s]}`,
            })),
          ]}
          label="Scope"
        />
      )}
    </div>
  ) : null;

  return (
    // GH #311: without its nav beside it, the Library is one column that
    // starts where the screen's title does (ux.css `.ux-library--single`).
    <div ref={host} className={narrow || inFlow ? "ux-library ux-library--single" : "ux-library"}>
      {!narrow && !inFlow && (
        <div className="ux-library-nav" data-ply-tour="library-tabs">
          <NavList groups={groups} active={active} also={also} onSelect={select} label="Library" />
        </div>
      )}
      <div className="ux-library-main">
        <Page wide>
          {page === "skills" && (
            <SkillsPage
              workspaceId={workspaceId}
              cwd={cwd}
              data={data}
              controls={controls}
              visible={visible}
            />
          )}
          {page === "instructions" && (
            <InstructionsPage
              workspaceId={workspaceId}
              data={instructions}
              controls={controls}
            />
          )}
        </Page>
      </div>
    </div>
  );
}
