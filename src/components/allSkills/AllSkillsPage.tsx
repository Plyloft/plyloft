import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AvailabilityChips,
  CBtn,
  CheckList,
  CheckRow,
  DuplicateChip,
  EmptyState,
  Group,
  Icon,
  Page,
  PageHeader,
  Popover,
  Properties,
  Row,
  SearchField,
  Section,
  Segmented,
  Select,
  StatusLine,
} from "../ux";
import {
  CLI_FILTER_LABEL,
  copyFromOf,
  filterRows,
  firstSentence,
  itemOffsets,
  ITEM_HEIGHT,
  libraryKey,
  linkStateWords,
  listItems,
  rowKeys,
  rowNotes,
  SCOPE_FILTER_LABEL,
  SCOPE_ORDER,
  scopeChip,
  scopeCounts,
  STATE_FILTER_LABEL,
  statusWords,
  stepKey,
  updatesChip,
  usedIn,
  usedInEntryWords,
  usedInLine,
  visibleRange,
  type CliFilter,
  type HubRow,
  type HubScope,
  type ListItem,
  type StateFilter,
  type UsedInEntry,
  workspaceHints,
} from "../../lib/allSkills";
import { machineWords } from "../../lib/platform";
import { COPY_TO_LABEL } from "../../lib/librarySkills";
import { closeCopyTo, refreshAllSkills, useAllSkills } from "../../store/allSkillsStore";
import { openLibraryPage, useUi } from "../../store/uiStore";
import { useLibrary } from "../../store/libraryStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { MyLibraryPanel, MyLibrarySkillActions } from "./MyLibrary";
import { CopyToFlow } from "./CopyToFlow";
import type { HubIndexLink } from "../../ipc";

/** The row's link chip: `Linked · up to date`, `Linked on this Mac · …`. */
function linkChipWords(link: HubIndexLink): string {
  return `${link.local ? machineWords("Linked on this Mac") : "Linked"} · ${linkStateWords(link.state)}`;
}

/**
 * Skills hub H7 (`docs/plans/SKILLS_HUB.md` R4, mockup `all-skills.html`):
 * every skill this Mac can see, in one list — filters by scope, state,
 * workspace and CLI, and where each one is used.
 *
 * App-level: it works with no workspace open, and it is drawn over the
 * per-workspace hosts, which stay mounted (NewWorkspaceShell). The list is
 * virtualised over the page's one scroll; the keyboard never leaves the
 * filter or the list (the active row is the list's `aria-activedescendant`),
 * so a row scrolled out of the window can be unmounted under it.
 *
 * Keys: ⌘F or `/` puts the caret in the filter; ↓ from it enters the list;
 * ↑ ↓ Home End move through the rows; Enter opens one; Esc goes back — from
 * a skill to the list, from the list to where you were.
 */
export function AllSkillsPage() {
  const openKey = useAllSkills((s) => s.openKey);
  const rows = useAllSkills((s) => s.rows);
  const copy = useAllSkills((s) => s.copy);
  const open = useMemo(() => (openKey ? rows.find((r) => r.key === openKey) ?? null : null), [openKey, rows]);
  // Once, as the page opens: read everything again behind the cache.
  useEffect(() => {
    refreshAllSkills();
    // H8: leaving All skills (a mode, a workspace) leaves Copy to… too.
    return () => useAllSkills.getState().setCopy(null);
  }, []);
  // Skills hub H8: Copy to… over the list or the skill it was opened from.
  if (copy) return <CopyToFlow from={copy} onClose={closeCopyTo} />;
  return open ? <HubSkillPage row={open} /> : <HubListPage />;
}

function close() {
  useUi.getState().setAllSkillsOpen(false);
}

/** Text typed in the filter reaches the list 100 ms later (§7.3). */
function useDebounced(value: string, ms = 100): string {
  const [out, setOut] = useState(value);
  useEffect(() => {
    if (value === out) return;
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, out, ms]);
  return value === "" ? "" : out;
}

function HubListPage() {
  const index = useAllSkills((s) => s.index);
  const rows = useAllSkills((s) => s.rows);
  const names = useAllSkills((s) => s.names);
  const loaded = useAllSkills((s) => s.loaded);
  const refreshing = useAllSkills((s) => s.refreshing);
  const reading = useAllSkills((s) => s.reading);
  const filters = useAllSkills((s) => s.filters);
  const expanded = useAllSkills((s) => s.expanded);
  const activeKey = useAllSkills((s) => s.activeKey);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const [text, setText] = useState(filters.text);
  const debounced = useDebounced(text);
  const filterId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const { setFilters, setActiveKey, setOpenKey, expand } = useAllSkills.getState();

  useEffect(() => {
    if (debounced !== filters.text) setFilters({ text: debounced });
  }, [debounced, filters.text, setFilters]);

  const teamRepo = index.team?.repo ?? null;
  const myLibraryRepo = index.myLibrary?.repo ?? null;
  const copies = useCallback((row: HubRow) => usedIn(row, names, teamRepo, myLibraryRepo).entries, [names, teamRepo, myLibraryRepo]);
  // Scope is applied by the list; the segments count what each would show.
  const now = Date.now();
  const matched = useMemo(
    () => filterRows(rows, filters, now, copies),
    // `now` moves every render; the list is re-filtered when its inputs do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filters, copies],
  );
  const counts = useMemo(() => scopeCounts(matched), [matched]);
  const items = useMemo(() => listItems(matched, filters.scope, expanded), [matched, filters.scope, expanded]);
  const keys = useMemo(() => rowKeys(items), [items]);
  const offsets = useMemo(() => itemOffsets(items), [items]);
  const total = useMemo(() => scopeCounts(rows).all, [rows]);
  const mineCount = useMemo(() => rows.filter((r) => r.scope === "myLibrary").length, [rows]);
  const readingCount = Object.keys(reading).length;

  // Focus the filter when the page opens (Tier 4: "filter focus").
  useEffect(() => {
    document.getElementById(filterId)?.focus({ preventScroll: true });
  }, [filterId]);

  const activeId = (key: string) => `${filterId}-row-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  function scrollToKey(key: string) {
    const at = items.findIndex((i) => i.key === key);
    const list = listRef.current;
    const scroller = list?.closest(".ux-page") as HTMLElement | null;
    if (at < 0 || !list || !scroller) return;
    const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = listTop + offsets[at];
    const bottom = top + ITEM_HEIGHT[items[at].kind];
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }

  function move(step: number | "first" | "last") {
    const next =
      step === "first" ? keys[0] ?? null : step === "last" ? keys[keys.length - 1] ?? null : stepKey(keys, activeKey, step);
    if (!next) return;
    setActiveKey(next);
    scrollToKey(next);
  }

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") {
      if (activeKey && keys[0] === activeKey) {
        document.getElementById(filterId)?.focus();
      } else move(-1);
    } else if (e.key === "Home") move("first");
    else if (e.key === "End") move("last");
    else if (e.key === "Enter" && activeKey) setOpenKey(activeKey);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  }

  function onFilterKey(e: KeyboardEvent<HTMLDivElement>) {
    // Only the text field's own keys: a filter button or the Workspaces
    // popover inside this row keeps its arrows and its Esc.
    if (!(e.target instanceof HTMLElement) || e.target.id !== filterId) return;
    if (e.key === "ArrowDown") {
      // ↓ from the filter enters the list at its first row (walk).
      e.preventDefault();
      const first = keys[0] ?? null;
      if (first) {
        setActiveKey(first);
        scrollToKey(first);
      }
      listRef.current?.focus();
    } else if (e.key === "Escape" && !e.defaultPrevented && !text) {
      e.preventDefault();
      close();
    }
  }

  // ⌘F / `/` from anywhere on the page puts the caret in the filter.
  function onPageKey(e: KeyboardEvent<HTMLDivElement>) {
    const typing = e.target instanceof HTMLInputElement;
    if ((e.key === "f" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
      e.preventDefault();
      document.getElementById(filterId)?.focus();
    } else if (e.key === "Escape" && !e.defaultPrevented && !typing) {
      // Esc anywhere else on the page (a filter button): back to where you were.
      e.preventDefault();
      close();
    }
  }

  // Two workspaces of one name (two checkouts of a repository) say where.
  const workspaceOptions = useMemo(() => {
    const hints = workspaceHints(workspaces);
    return workspaces.map((w) => ({ id: w.id, name: w.name, hint: hints.get(w.id) ?? null }));
  }, [workspaces]);

  const scopeOptions = (["all", ...SCOPE_ORDER] as const)
    .filter((s) => s === "all" || s === "repository" || counts[s] > 0 || filters.scope === s)
    .map((s) => ({ value: s, label: `${machineWords(SCOPE_FILTER_LABEL[s])} ${counts[s]}` }));

  return (
    <div className="ux-hub-host" onKeyDown={onPageKey}>
      <Page wide>
        <PageHeader
          title="All skills"
          lede={machineWords(
            "Every skill this Mac can see — in your repositories, the team library, My library, on this Mac, and in Plyloft — and where each one is used.",
          )}
        />
        <div className="ux-library-filter" onKeyDown={onFilterKey}>
          <SearchField
            inputId={filterId}
            value={text}
            onChange={setText}
            placeholder={`Filter ${total} ${total === 1 ? "skill" : "skills"} by name or description`}
          />
          <CBtn size="sm" onClick={refreshAllSkills} disabled={refreshing} aria-busy={refreshing || undefined}>
            {refreshing ? "Reading…" : "Read again"}
          </CBtn>
        </div>
        <div className="ux-hub-filters">
          <Segmented<HubScope | "all">
            label="Scope"
            value={filters.scope}
            onChange={(scope) => setFilters({ scope })}
            options={scopeOptions}
          />
          <Select
            label="State"
            value={filters.state}
            onChange={(state) => setFilters({ state: state as StateFilter })}
            options={(Object.keys(STATE_FILTER_LABEL) as StateFilter[]).map((s) => ({ value: s, label: STATE_FILTER_LABEL[s] }))}
          />
          <WorkspaceFilter
            picked={filters.workspaces}
            options={workspaceOptions}
            onChange={(picked) => setFilters({ workspaces: picked })}
          />
          <Select
            label="Reaches"
            value={filters.cli}
            onChange={(cli) => setFilters({ cli: cli as CliFilter })}
            options={(Object.keys(CLI_FILTER_LABEL) as CliFilter[]).map((c) => ({ value: c, label: CLI_FILTER_LABEL[c] }))}
          />
        </div>
        <StatusLine state={refreshing ? "running" : "empty"}>
          {loaded ? statusWords(index, refreshing, readingCount, now) : "Reading the last copy of the index…"}
        </StatusLine>
        {index.team?.problem && <StatusLine state="empty">{index.team.problem}</StatusLine>}
        {(filters.scope === "all" || filters.scope === "myLibrary") && <MyLibraryPanel skills={mineCount} />}
        {loaded && items.length === 0 && (
          <EmptyState>
            {rows.length === 0
              ? refreshing
                ? "Reading every workspace, the team library and this Mac…"
                : "No skills on this Mac yet."
              : "No skill matches these filters."}
          </EmptyState>
        )}
        {items.length > 0 && (
          <VirtualList
            listRef={listRef}
            items={items}
            offsets={offsets}
            activeKey={activeKey}
            activeId={activeId}
            onKeyDown={onListKey}
            renderRow={(row, active) => (
              <HubRowView
                row={row}
                id={activeId(row.key)}
                active={active}
                reading={row.workspaceId != null && reading[row.workspaceId] === true}
                line={usedInLine(row, usedIn(row, names, teamRepo, myLibraryRepo))}
                updates={row.scope === "team" ? updatesChip(usedIn(row, names, teamRepo, myLibraryRepo)) : null}
                onOpen={() => setOpenKey(row.key)}
                onCopy={copyFromOf(row) ? () => useAllSkills.getState().setCopy(copyFromOf(row)) : null}
              />
            )}
            onMore={expand}
          />
        )}
      </Page>
    </div>
  );
}

function WorkspaceFilter({
  picked,
  options,
  onChange,
}: {
  picked: readonly string[];
  options: { id: string; name: string; hint: string | null }[];
  onChange: (picked: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLSpanElement>(null);
  // Esc closes an open popover first, wherever the caret is — its trigger, a
  // filter beside it, nowhere after a button inside it went away — before
  // the page's own Esc (back to the mode you were in) can see it (walks).
  useEffect(() => {
    if (!open) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const label =
    picked.length === 0
      ? `All ${options.length} workspaces`
      : picked.length === 1
        ? options.find((o) => o.id === picked[0])?.name ?? "1 workspace"
        : `${picked.length} workspaces`;
  return (
    <span className="ux-hub-popover" ref={body}>
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      label="Workspaces"
      trigger={
        <CBtn size="sm" aria-expanded={open} active={picked.length > 0} onClick={() => setOpen((v) => !v)}>
          {`Workspaces: ${label}`}
          <Icon name="expand" size="sm" />
        </CBtn>
      }
    >
      <CheckList label="Workspaces">
        {options.map((o) => (
          <CheckRow
            key={o.id}
            checked={picked.includes(o.id)}
            onChange={(on) => onChange(on ? [...picked, o.id] : picked.filter((id) => id !== o.id))}
            note={o.hint ?? undefined}
          >
            {o.name}
          </CheckRow>
        ))}
      </CheckList>
      {picked.length > 0 && (
        <CBtn
          size="sm"
          onClick={() => {
            onChange([]);
            // The button goes with the choice: the caret stays in the
            // popover, on its first workspace.
            requestAnimationFrame(() => body.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus());
          }}
        >
          Every workspace
        </CBtn>
      )}
    </Popover>
    </span>
  );
}

/**
 * The rows over the page's one scroll (`.ux-page`): only those in the
 * window, plus a few either side, are mounted.
 */
function VirtualList({
  listRef,
  items,
  offsets,
  activeKey,
  activeId,
  onKeyDown,
  renderRow,
  onMore,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  items: ListItem[];
  offsets: number[];
  activeKey: string | null;
  activeId: (key: string) => string;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  renderRow: (row: HubRow, active: boolean) => ReactNode;
  onMore: (scope: string) => void;
}) {
  const [view, setView] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = list?.closest(".ux-page") as HTMLElement | null;
    if (!list || !scroller) return;
    const measure = () => {
      const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setView((v) => {
        const next = { top: scroller.scrollTop - listTop, height: scroller.clientHeight };
        return v.top === next.top && v.height === next.height ? v : next;
      });
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [listRef]);
  const [from, to] = visibleRange(offsets, view.top, view.height);
  const activeIn = activeKey != null && items.some((i) => i.key === activeKey);
  return (
    <div
      ref={listRef}
      className="ux-hub-list"
      role="listbox"
      aria-label="Skills"
      tabIndex={0}
      aria-activedescendant={activeIn && activeKey ? activeId(activeKey) : undefined}
      onKeyDown={onKeyDown}
      style={{ height: offsets[offsets.length - 1] }}
    >
      {items.slice(from, to).map((item, i) => {
        const at = from + i;
        const style = { top: offsets[at], height: ITEM_HEIGHT[item.kind] };
        if (item.kind === "head") {
          return (
            <div key={item.key} className="ux-hub-item ux-hub-head" style={style} role="presentation">
              <h2 className="ux-section-title">{machineWords(item.title)}</h2>
              <span className="ux-section-count">
                {item.count} {item.count === 1 ? "skill" : "skills"}
              </span>
            </div>
          );
        }
        if (item.kind === "more") {
          return (
            <div key={item.key} className="ux-hub-item ux-hub-more" style={style} role="presentation">
              <CBtn size="sm" onClick={() => onMore(item.scope)}>
                {`Show all · ${item.hidden} more`}
              </CBtn>
            </div>
          );
        }
        return (
          <div key={item.key} className="ux-hub-item" style={style} role="presentation">
            {renderRow(item.row, item.key === activeKey)}
          </div>
        );
      })}
    </div>
  );
}

function HubRowView({
  row,
  id,
  active,
  reading,
  line,
  updates,
  onOpen,
  onCopy,
}: {
  row: HubRow;
  id: string;
  active: boolean;
  reading: boolean;
  line: string | null;
  updates: string | null;
  onOpen: () => void;
  /** Skills hub H8: Copy to… for this row (`null`: not offered). */
  onCopy: (() => void) | null;
}) {
  const notes = rowNotes(row, reading);
  const hint = row.placeholder
    ? `Folder not found · ${row.path ?? ""}`
    : [firstSentence(row.description), ...notes.filter((n) => !n.startsWith("Folder not found")), line]
        .filter(Boolean)
        .join(" · ");
  const missing = row.missing ? `Folder not found · ${row.path ?? ""}` : null;
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={[
        "ux-row ux-row--opens ux-hub-row",
        active ? "ux-hub-row--active" : "",
        row.missing ? "ux-hub-row--missing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onOpen}
    >
      <div className="ux-row-main">
        <div className="ux-row-label">
          <span className="ux-row-label-text ux-row-label-text--mono">{row.name}</span>
          <span className="ux-row-chips">
            <span className="cchip cchip--outline">{row.placeholder ? "Repository" : scopeChip(row)}</span>
            <AvailabilityChips claude={row.claude} codex={row.codex} />
            {updates && <DuplicateChip>{updates}</DuplicateChip>}
            {row.link && <DuplicateChip>{linkChipWords(row.link)}</DuplicateChip>}
          </span>
        </div>
        <p className="ux-row-hint ux-hub-hint">{missing ? `${missing}${hint && !row.placeholder ? ` · ${hint}` : ""}` : hint}</p>
      </div>
      {onCopy && (
        <CBtn
          size="sm"
          className="ux-hub-row-copy"
          // The list's keyboard is the listbox's: Enter opens the skill, whose
          // page has Add to other projects… as a button of its own.
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
        >
          {COPY_TO_LABEL}
        </CBtn>
      )}
      <span className="ux-row-chevron" aria-hidden>
        <Icon name="opens" size="sm" />
      </span>
    </div>
  );
}

// ── A skill, read through the hub ────────────────────────────────────

function HubSkillPage({ row }: { row: HubRow }) {
  const names = useAllSkills((s) => s.names);
  const teamRepo = useAllSkills((s) => s.index.team?.repo ?? null);
  const myLibraryRepo = useAllSkills((s) => s.index.myLibrary?.repo ?? null);
  const reading = useAllSkills((s) => (row.workspaceId ? s.reading[row.workspaceId] === true : false));
  const activeWorkspace = useWorkspaces((s) => s.activeId);
  const used = useMemo(() => usedIn(row, names, teamRepo, myLibraryRepo), [row, names, teamRepo, myLibraryRepo]);
  const back = useRef<HTMLDivElement>(null);
  const { setOpenKey } = useAllSkills.getState();

  useEffect(() => {
    back.current?.querySelector<HTMLElement>(".ux-back")?.focus({ preventScroll: true });
  }, [row.key]);

  function goBack() {
    setOpenKey(null);
    // The list takes the keyboard back, on the row that was open.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".ux-hub-list")?.focus());
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      goBack();
    }
  }

  // Where it opens in a workspace's own Library.
  const target = row.scope === "repository" ? row.workspaceId : activeWorkspace;
  const copyFrom = copyFromOf(row);
  const key = libraryKey(row);
  function openInWorkspace(workspaceId: string, skillKey: string) {
    openLibraryPage(workspaceId, "skills");
    useLibrary.getState().openSkill(workspaceId, skillKey);
  }

  const notes = rowNotes(row, reading);
  const props = [
    { label: "Where", value: row.placeholder ? "Folder not found" : scopeChip(row) },
    { label: "Reaches", value: [row.claude ? "Claude" : null, row.codex ? "Codex" : null].filter(Boolean).join(" and ") || "No CLI" },
    ...(row.link
      ? [
          {
            label: "Linked to",
            value: `${row.link.originWords}${row.link.local ? machineWords(", on this Mac only") : ""} · ${linkStateWords(row.link.state)}`,
          },
        ]
      : []),
    { label: "Folder", value: <span className="ux-row-value ux-row-value--mono">{row.dir}</span>, wide: true },
  ];

  return (
    <div className="ux-hub-host" onKeyDown={onKey} ref={back}>
      <Page wide>
        <PageHeader
          back={{ label: "All skills", onClick: goBack }}
          title={row.name}
          lede={row.description || (row.placeholder ? "This workspace's folder isn't on this Mac now." : "")}
          status={
            notes.length > 0 ? <StatusLine state={row.missing ? "aborted" : "empty"}>{notes.join(" · ")}</StatusLine> : undefined
          }
        />
        <Properties items={props} />
        {((target && key) || copyFrom) && !row.placeholder && !row.missing && (
          <div className="ux-hub-actions">
            {target && key && (
              <CBtn tone="strong" onClick={() => openInWorkspace(target, key)}>
                {row.scope === "repository" ? "Open in its workspace" : "Open in the Library"}
              </CBtn>
            )}
            {copyFrom && <CBtn onClick={() => useAllSkills.getState().setCopy(copyFrom)}>{COPY_TO_LABEL}</CBtn>}
          </div>
        )}
        <MyLibrarySkillActions row={row} onBack={goBack} />
        <Section
          title="Used in"
          count={row.scope === "plyloft" ? "every session Plyloft starts" : `${used.count} ${used.count === 1 ? "workspace" : "workspaces"}`}
        >
          {used.entries.length === 0 ? (
            <EmptyState>{row.scope === "repository" ? "Only here." : "No repository on this Mac has it."}</EmptyState>
          ) : (
            <Group label="Used in">
              {used.entries.map((entry) => (
                <UsedInRow key={entry.row.key} entry={entry} onOpen={() => openInWorkspace(entry.row.workspaceId!, `repository:${entry.row.name}`)} />
              ))}
            </Group>
          )}
        </Section>
      </Page>
    </div>
  );
}

function UsedInRow({ entry, onOpen }: { entry: UsedInEntry; onOpen: () => void }) {
  const words = usedInEntryWords(entry);
  const hint = entry.row.missing ? `Folder not found · ${entry.row.path ?? ""}` : entry.row.repo ?? entry.row.path ?? "";
  return (
    <Row
      kind="item"
      label={words}
      hint={hint}
      chips={<AvailabilityChips claude={entry.row.claude} codex={entry.row.codex} />}
      onOpen={entry.row.missing ? undefined : onOpen}
    />
  );
}
