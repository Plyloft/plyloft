import { useEffect, useMemo } from "react";
import { AvailabilityChips, CBtn, Group, Row, RowValue, Section, StatusLine } from "../ux";
import type { HubRow } from "../../lib/allSkills";
import { firstSentence } from "../../lib/librarySkills";
import {
  ALSO_IN_REPOSITORY,
  EMPTY_HINT,
  LIBRARY_SECTION_TITLE,
  MANAGE_LABEL,
  SET_UP_LABEL,
  emptyLede,
  foundLine,
  librarySectionNote,
  notSetUpWords,
  sectionCount,
  statusIsCurrent,
  statusLine,
} from "../../lib/myLibrary";
import { useAllSkills } from "../../store/allSkillsStore";
import { startMyLibrarySubscriptions, useMyLibrary } from "../../store/myLibraryStore";
import { useUi } from "../../store/uiStore";

const NO_ROWS: readonly HubRow[] = [];

/**
 * 1.174.0 (X3, SL-16): My library's skills, as All skills' index has them —
 * the same rows and the same view, no IPC of its own. The cache is read once
 * if nothing read it yet; All skills keeps it current from there.
 */
export function useMyLibrarySkills(): readonly HubRow[] {
  const rows = useAllSkills((s) => s.rows);
  const loaded = useAllSkills((s) => s.loaded);
  useEffect(() => {
    startMyLibrarySubscriptions();
    if (!useAllSkills.getState().loaded) void useAllSkills.getState().load(false);
  }, [loaded]);
  return useMemo(() => {
    const mine = rows.filter((r) => r.scope === "myLibrary");
    return mine.length === 0 ? NO_ROWS : mine;
  }, [rows]);
}

/** The filter of the Library's field, over a My library row. */
export function matchesFilter(row: HubRow, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (q === "") return true;
  return row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q);
}

/**
 * Open All skills — on a My library skill's page, or (no key) on the list
 * with My library showing. Nothing is written: My library is changed only in
 * All skills (AGENTS.md, My library).
 */
export function openInAllSkills(key: string | null): void {
  const all = useAllSkills.getState();
  if (all.filters.scope !== "all" && all.filters.scope !== "myLibrary") all.setFilters({ scope: "myLibrary" });
  all.setCopy(null);
  all.setOpenKey(key);
  useUi.getState().setAllSkillsOpen(true);
}

/**
 * 1.174.0 (X3, SL-16; mockup `next-1174/mockups/my-library.html`): My library
 * in a project's Library › Skills, after the team library — read-only. Its
 * count and status line are All skills' own words; its rows have no action
 * and no ⋯, and their › opens the skill's page in All skills. `empty` draws
 * the section for a computer that uses none (scope All, no filter): what it
 * is and where to make one.
 */
export function MyLibrarySection({
  rows,
  empty,
  repositoryNames,
}: {
  /** The rows to draw: already filtered by the page's field. */
  rows: readonly HubRow[];
  /** No My library here, and the page may say so. */
  empty: boolean;
  /** The names in this repository's section, for "also in this repository". */
  repositoryNames: ReadonlySet<string>;
}) {
  const view = useMyLibrary((s) => s.view);
  const found = useMyLibrary((s) => s.found);
  const find = useMyLibrary((s) => s.find);
  const account = view ? (view.account ?? view.accounts.find((a) => a.active)?.login ?? view.accounts[0]?.login ?? null) : null;
  // The same question All skills asks on a computer that uses none.
  useEffect(() => {
    if (empty && view && !view.repo) void find(account);
  }, [empty, view, account, find]);

  if (!view?.repo) {
    if (!empty || !view) return null;
    return (
      <Section title={LIBRARY_SECTION_TITLE} count={notSetUpWords()}>
        <p className="ux-section-note">{emptyLede()}</p>
        <p className="ux-section-note">{found ? foundLine(found) : EMPTY_HINT}</p>
        <div className="ux-section-note-action">
          <CBtn size="sm" onClick={() => openInAllSkills(null)}>
            {SET_UP_LABEL}
          </CBtn>
        </div>
      </Section>
    );
  }

  const status = statusLine(view, Date.now());
  return (
    <Section title={LIBRARY_SECTION_TITLE} count={sectionCount(rows.length)}>
      <p className="ux-section-note">{librarySectionNote(view.repo, view.plugin)}</p>
      <div className="ux-library-mine-bar">
        {status && <StatusLine state={statusIsCurrent(status) ? "done" : "empty"}>{status}</StatusLine>}
        <CBtn size="sm" onClick={() => openInAllSkills(null)}>
          {MANAGE_LABEL}
        </CBtn>
      </div>
      {rows.length > 0 && (
        <Group label={LIBRARY_SECTION_TITLE}>
          {rows.map((row) => (
            <Row
              key={row.key}
              kind="item"
              mono
              label={row.name}
              chips={<AvailabilityChips claude={row.claude} codex={row.codex} />}
              hint={firstSentence(row.description)}
              onOpen={() => openInAllSkills(row.key)}
            >
              {repositoryNames.has(row.name) ? <RowValue>{ALSO_IN_REPOSITORY}</RowValue> : null}
            </Row>
          ))}
        </Group>
      )}
    </Section>
  );
}
