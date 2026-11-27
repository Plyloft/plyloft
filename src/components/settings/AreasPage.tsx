// 1.173.0 (B5): Settings › This repository › Areas (mockup areas.html scene
// 3). Saved in the repository's shared definition through the Repository
// pages' own shell (`RepositoryPage`: the draft, Publish to <branch> — one
// `workspace_definition_save` with "areas" — the status line with who
// changed it last, read-only Macs). Every edit writes each area's tag prefix
// explicitly (`withPrefixes`), and the list is checked as it is typed
// (`areas_check`), its words beside the field they are about.
// 1.174.0 (C10, D6): a project whose setup isn't shared edits the same list
// in its own shell (`KeptHereAreasPage`) and saves it on this Mac.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  areasCheck,
  areasDiscover,
  areasReleases,
  areasSaveLocal,
  workspaceDefinitionBranches,
  type AreaCheck,
  type BranchChoices,
  type AreaDef,
  type AreaRelease,
  type ResolvedArea,
} from "../../ipc";
import {
  ADD_AREA,
  AREAS_SECTION,
  EDIT_AREA,
  OPEN_SHIPPING,
  areaSubId,
  areaSubIndex,
  areaSubPage,
  areaSummary,
  keptRowChange,
  AREAS_LEDE,
  AREAS_TITLE,
  HINT,
  KEPT_HERE_ONLY,
  KEPT_UNTIL_SHARED,
  NOTHING_TO_SUGGEST,
  NO_AREAS,
  LEAVE_UNSAVED_AREAS,
  NOT_SAVED_SEE_ABOVE,
  SAVE_AREAS_FIRST,
  SAVE_HERE,
  SAVING_HERE,
  keptBarSentence,
  sharesAreasLine,
  SUGGEST_AREAS,
  CHOOSE_FOLDER,
  NOTHING_NEW_TO_SUGGEST,
  addArea,
  autoPrefix,
  mergeSuggestion,
  reservedIdWords,
  slugId,
  areaList,
  areaTitle,
  folderWords,
  listProblems,
  pageProblem,
  parseVersionFiles,
  problemsFor,
  removeArea,
  renameArea,
  setField,
  versionFilesText,
  versionNowWords,
  withPrefixes,
  firstSaveOfAreas,
} from "../../lib/areasPage";
import { askAboutDirection } from "./AdoptDirectionSheet";
import { AREA_FIELDS } from "../../lib/repositoryPage";
import type { Scope } from "../../lib/uxScope";
import { machineWords } from "../../lib/platform";
import { useAreas, useAreasFailure, useAreasView } from "../../store/areaStore";
import { loadFailedError } from "../../lib/cardPage";
import type { UxError } from "../../lib/uxError";
import { anchorOf, RepositoryPage, type RepositoryDraft } from "../RepositoryPage";
import { shareWorkspaceSetup, useSetupShareable } from "../AdoptionBanner";
import { adoptionBanner } from "../../lib/adoption";
import { SHARE_IT, SHARE_THE_SETUP } from "../../lib/niDirectionWords";
import { useTeamAllowed } from "../../store/accountStore";
import { SAVE_BAR_LABEL } from "../ux/Publish";
import { CBtn, ErrorBlock, Group, Page, PageHeader, PublishBar, Row, RowValue, Section, Select, Sheet, StatusLine, TextField } from "../ux";
import {
  RELEASE_KIND_LABEL,
  SHIPPING_SETTINGS_SECTION,
  asReleaseKind,
  followChoiceLabel,
  followedReleaseKind,
} from "../../lib/shippingPage";
import type { ReleaseKind } from "../../ipc";
import { useShipOffersPr } from "../../hooks/useDefaultReleaseKind";
import { useUi } from "../../store/uiStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { clearLeaveGuard, setLeaveGuard, type LeaveGuard } from "../../lib/leaveGuard";
import { localSaveProblem, pageError, type PublishProblem } from "../../lib/publishDraft";

const EMPTY_RESOLVED: ResolvedArea[] = [];
const NO_RELEASES: AreaRelease[] = [];

export function AreasPage({
  workspaceId,
  hiddenNote = null,
  scope,
}: {
  workspaceId: string;
  hiddenNote?: string | null;
  scope?: Scope;
}) {
  const view = useAreasView(workspaceId);
  const failure = useAreasFailure(workspaceId);
  // C10 round 1: until the areas are read, only the page's head — which
  // shell it is (shared or kept here) isn't known yet, and drawing the
  // shared one first flashes its layout. Round 3: the head says the read
  // is running, or why it failed with Try again.
  if (view === undefined) {
    return (
      <Page>
        <PageHeader
          scope={scope ?? "repository"}
          title={AREAS_TITLE}
          lede={AREAS_LEDE}
          status={
            <>
              {hiddenNote && <StatusLine state="empty">{hiddenNote}</StatusLine>}
              {failure === undefined && <StatusLine state="running">{AREAS_READING}</StatusLine>}
            </>
          }
        />
        {/* Try again is bordered, after the block: the page shell (with
            the kept-here page's Save) keeps one filled button (onePrimary). */}
        {failure !== undefined && (
          <>
            <ErrorBlock error={areasReadError(failure)} />
            <CBtn onClick={() => void useAreas.getState().load(workspaceId)} data-ply-areas-try-again="">
              {AREAS_TRY_AGAIN}
            </CBtn>
          </>
        )}
      </Page>
    );
  }
  // 1.174.0 (C10, D6): nothing shared — the page works, and saves here.
  if (!view.shared) {
    return <KeptHereAreasPage workspaceId={workspaceId} hiddenNote={hiddenNote} scope={scope} />;
  }
  return <SharedAreasPage workspaceId={workspaceId} hiddenNote={hiddenNote} scope={scope} />;
}

/** The shared setup's page: the Repository pages' shell. C11: a publish
 *  that takes the list to two or more areas asks about the direction
 *  written before them. */
function SharedAreasPage({
  workspaceId,
  hiddenNote,
  scope,
}: {
  workspaceId: string;
  hiddenNote: string | null;
  scope?: Scope;
}) {
  return (
    <>
      <RepositoryPage
        workspaceId={workspaceId}
        order={AREA_FIELDS}
        title={AREAS_TITLE}
        lede={AREAS_LEDE}
        hiddenNote={hiddenNote}
        scope={scope}
        subPages={(d) => areaSubPages(areaList(d.value("areas")))}
        onPublished={(sent, before) => {
          if (!("areas" in sent)) return;
          if (!firstSaveOfAreas(areaList(before.areas).length, areaList(sent.areas).length)) return;
          void askAboutDirection(workspaceId);
        }}
      >
        {(d) => <AreasBody edit={sharedEdit(d)} workspaceId={workspaceId} />}
      </RepositoryPage>
    </>
  );
}

/** C10 round 3: while the areas are read, and when the read failed. */
const AREAS_READING = "Reading this project's areas…";
const AREAS_TRY_AGAIN = "Try again";
function areasReadError(cause: unknown): UxError {
  return {
    ...loadFailedError("The areas", cause),
    happened: "Plyloft couldn't read this project's areas.",
    todo: "Press Try again. If it keeps failing, Details says why.",
  };
}

/** DS6: one sub-page per area of the list as it is now (scene 10). */
function areaSubPages(list: AreaDef[]): Record<string, { title: string; lede: string; back: string }> {
  return Object.fromEntries(list.map((_, i) => [areaSubId(i), areaSubPage(list, i)]));
}

/** What the list's body edits, from either shell: the Repository page's
 *  draft (shared: Publish), or this page's own (kept here: Save). */
interface AreasEdit {
  /** The list being edited (a value that isn't one reads as none). */
  value: unknown;
  /** The list as saved: its ids are the ones cards carry. */
  saved: unknown;
  set: (next: AreaDef[] | null) => void;
  /** The first read landed, so an edit is measured against it. */
  read: boolean;
  editable: boolean;
  readOnly: boolean;
  marks: { anchor: string; changed?: { n?: number; hint: ReactNode }; hint?: ReactNode };
  /** DS6: the area whose sub-page is open (its index), or the list. */
  sub: number | null;
  openSub: (index: number | null) => void;
  /** Whether the project's setup is shared, for the sections' scope mark. */
  shared: boolean;
  /** G3a walk: whether it can be shared at all (not solo, on GitHub) — the
   *  mark says "until you share the project" only then. Absent: it can. */
  shareable?: boolean;
}

function sharedEdit(d: RepositoryDraft): AreasEdit {
  const row = d.rowProps("areas", null);
  return {
    value: d.value("areas"),
    saved: d.repo.values.areas,
    set: (next) => void d.set("areas", next),
    read: d.repo.reads > 0 && d.repo.lastReadOk,
    editable: d.repo.shared && !d.readOnly && !d.frozen,
    readOnly: d.readOnly,
    marks: { anchor: row.anchor, changed: row.changed, hint: row.hint },
    sub: areaSubIndex(d.sub),
    openSub: (index) => d.openSub(index == null ? null : areaSubId(index)),
    shared: d.repo.shared,
  };
}

/**
 * 1.174.0 (C10, D6; mockup areas.html §1, §1b, Windows and solo): a project
 * whose setup isn't shared. The list is edited as a draft and saved on this
 * Mac (`areasSaveLocal`, atomic): it decides there until the person shares
 * the setup, whose commit then carries it. The status line says where it
 * stays, with *Share it…* where sharing is possible; the bar says it again
 * beside Discard and Save. No long process: Save says "Saving…" until it
 * lands.
 */
function KeptHereAreasPage({
  workspaceId,
  hiddenNote,
  scope,
}: {
  workspaceId: string;
  hiddenNote: string | null;
  scope?: Scope;
}) {
  const view = useAreasView(workspaceId);
  const defined = view?.defined;
  const saved = useMemo(() => (defined?.length ? defined : null), [defined]);
  const [draft, setDraft] = useState<{ list: AreaDef[] | null } | null>(null);
  const [sub, setSub] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<PublishProblem | null>(null);
  const { shareable, status, reload, loading } = useSetupShareable(workspaceId, true);
  const licensed = useTeamAllowed();
  const [shareOpen, setShareOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareRegionId = useId();
  const saveFirstId = useId();
  const shareButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (shareOpen) shareButton.current?.focus();
  }, [shareOpen]);

  const value = draft ? draft.list : saved;
  // Measured with the saved areas' tag prefixes written out, as every edit
  // writes them (`withPrefixes`): writing one out is no change.
  const count = draft ? countChanges(withPrefixes(saved ?? [], view?.areas ?? []), draft.list ?? []) : 0;
  const changed = count > 0;

  // C10 round 0 (owner): leaving with an unsaved draft asks once, through
  // the shell's one leave guard (lib/leaveGuard.ts). Esc stays.
  const [leaving, setLeaving] = useState<{ proceed: () => void } | null>(null);
  const leaveSaveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!changed) return;
    const guard: LeaveGuard = (proceed) => {
      // G3a walk: left from a sub-page (an area's), the move goes where the
      // person pressed — the page's own entry is its list, not the sub-page.
      setLeaving({
        proceed: () => {
          setSub(null);
          proceed();
        },
      });
      return false;
    };
    setLeaveGuard(guard);
    return () => clearLeaveGuard(guard);
  }, [changed]);

  /** True when the draft was saved. */
  const save = async (): Promise<boolean> => {
    if (!draft || saving) return false;
    setSaving(true);
    setProblem(null);
    try {
      const next = await areasSaveLocal(workspaceId, draft.list ?? []);
      useAreas.setState((s) => ({ views: { ...s.views, [workspaceId]: next } }));
      setDraft(null);
      if (firstSaveOfAreas(saved?.length ?? 0, draft.list?.length ?? 0)) {
        // C11: asked through the store, so a Save that leaves still asks.
        void askAboutDirection(workspaceId);
      }
      return true;
    } catch (e) {
      // Said on the page, where the draft still is (PATTERNS.md §4).
      setProblem(localSaveProblem(["areas"], [], String((e as Error)?.message ?? e)));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await shareWorkspaceSetup(workspaceId, status);
      await useAreas.getState().load(workspaceId);
    } finally {
      setSharing(false);
      reload();
    }
  };
  const askedBody = shareable && status ? adoptionBanner({ ...status, action: { kind: "ask" } }, licensed)?.body : null;
  const areasLine = sharesAreasLine(view);
  const shareBody = askedBody && areasLine ? `${askedBody} ${areasLine}` : askedBody;

  const edit: AreasEdit = {
    value,
    saved,
    set: (next) => setDraft({ list: next }),
    read: !!view,
    editable: !!view && !saving,
    readOnly: false,
    marks: { anchor: anchorOf("areas") },
    sub,
    openSub: setSub,
    shared: false,
    shareable,
  };
  const subList = areaList(value);
  const subPage = sub != null && subList[sub] ? areaSubPage(subList, sub) : null;

  // Round 1: the bar and the line wait until it is known whether Share is
  // offered, so neither says the wrong place first.
  const footer = changed && !loading ? (
    <PublishBar
      state="draft"
      label={SAVE_BAR_LABEL}
      sentence={machineWords(keptBarSentence(count, shareable))}
      // A refused save: the error block above the list says what happened;
      // the bar, beside the Save that tries again, only points at it. The
      // bar's Save stays the page's one filled button.
      detail={problem ? <span role="alert">{NOT_SAVED_SEE_ABOVE}</span> : undefined}
      actions={
        <>
          <CBtn
            tone="quiet"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setProblem(null);
            }}
          >
            Discard
          </CBtn>
          <CBtn tone="accent" disabled={saving} onClick={() => void save()} data-ply-areas-save="">
            {saving ? SAVING_HERE : SAVE_HERE}
          </CBtn>
        </>
      }
    />
  ) : undefined;

  return (
    <Page footer={footer}>
      <PageHeader
        scope={scope ?? "repository"}
        title={subPage?.title ?? AREAS_TITLE}
        lede={subPage?.lede ?? AREAS_LEDE}
        back={subPage ? { label: subPage.back, onClick: () => setSub(null) } : undefined}
        status={
          subPage ? undefined : <>
            {hiddenNote && <StatusLine state="empty">{hiddenNote}</StatusLine>}
            {!loading && (
            <p className="ux-status ux-status--empty" data-ply-areas-kept-here="">
              <span className="ux-status-dot" aria-hidden />
              <span className="ux-status-text">
                {machineWords(shareable ? KEPT_UNTIL_SHARED : KEPT_HERE_ONLY)}
                {shareable && (
                  <>
                    {" "}
                    <CBtn
                      size="sm"
                      tone="quiet"
                      aria-expanded={shareOpen}
                      aria-controls={shareRegionId}
                      onClick={() => setShareOpen((o) => !o)}
                      data-ply-areas-share-it=""
                    >
                      {SHARE_IT}
                    </CBtn>
                  </>
                )}
              </span>
            </p>
            )}
          </>
        }
      />
      {shareable && shareOpen && (
        <div id={shareRegionId} role="region" aria-label={SHARE_THE_SETUP} className="ux-sheet-text" data-ply-areas-share="">
          {shareBody && <span className="ux-sheet-hint">{machineWords(shareBody)}</span>}{" "}
          <CBtn
            ref={shareButton}
            size="sm"
            disabled={sharing || saving || changed}
            aria-describedby={changed ? saveFirstId : undefined}
            onClick={() => void share()}
          >
            {sharing ? "Sharing…" : SHARE_THE_SETUP}
          </CBtn>
          {/* Off while a draft is unsaved: say why, beside it. */}
          {changed && (
            <>
              {" "}
              <span className="ux-sheet-hint" id={saveFirstId} data-ply-areas-save-first="">
                {SAVE_AREAS_FIRST}
              </span>
            </>
          )}
        </div>
      )}
      {/* Round 1: the whole story of a refused save (the raw text behind
          Details), with no way out of its own: the bar's Save tries again,
          and it stays the page's one filled button. */}
      {problem && <ErrorBlock error={pageError(problem)} />}
      {view && <AreasBody edit={edit} workspaceId={workspaceId} />}
      {leaving && (
        <Sheet
          size="confirm"
          title={LEAVE_UNSAVED_AREAS}
          onClose={() => setLeaving(null)}
          canDismiss={!saving}
          // The safe action keeps the work: Save has the focus.
          initialFocusRef={leaveSaveRef}
          actions={
            <>
              <CBtn
                tone="quiet"
                disabled={saving}
                onClick={() => {
                  const go = leaving.proceed;
                  setDraft(null);
                  setLeaving(null);
                  go();
                }}
              >
                Discard
              </CBtn>
              {/* Bordered: the bar's Save is the page's one filled button. */}
              <CBtn
                ref={leaveSaveRef}
                disabled={saving}
                onClick={() => {
                  const go = leaving.proceed;
                  // A save that fails keeps the page, its draft and why.
                  void save().then((ok) => {
                    setLeaving(null);
                    if (ok) go();
                  });
                }}
              >
                {saving ? SAVING_HERE : SAVE_HERE}
              </CBtn>
            </>
          }
        />
      )}
    </Page>
  );
}

/** The changes a draft makes to the list: each area added, removed or
 *  edited counts once (a move counts for the areas that moved). */
function countChanges(before: readonly AreaDef[], after: readonly AreaDef[]): number {
  const ids = new Set([...before.map((a) => a.id), ...after.map((a) => a.id)]);
  let n = 0;
  for (const id of ids) {
    const i = before.findIndex((x) => x.id === id);
    const j = after.findIndex((x) => x.id === id);
    if (i !== j || JSON.stringify(before[i] ?? null) !== JSON.stringify(after[j] ?? null)) n += 1;
  }
  return n;
}

function AreasBody({ edit, workspaceId }: { edit: AreasEdit; workspaceId: string }) {
  const view = useAreasView(workspaceId);
  const published = view?.areas ?? EMPTY_RESOLVED;
  const workspaceBranch = view?.workspaceBranch ?? "";
  const list = areaList(edit.value);
  const publishedIds = useMemo(() => new Set(areaList(edit.saved).map((a) => a.id)), [edit.saved]);
  const editable = edit.editable;
  const [check, setCheck] = useState<AreaCheck | null>(null);
  // 1.173.0 (B4 follow-up): each published area's latest tag and current
  // version, read once when the page opens (git, on a worker).
  // null until the tags are read: the rows say nothing about them before.
  const [releases, setReleases] = useState<AreaRelease[] | null>(null);
  useEffect(() => {
    let live = true;
    areasReleases(workspaceId)
      .then((r) => live && setReleases(r ?? NO_RELEASES))
      .catch(() => live && setReleases(NO_RELEASES));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const [suggesting, setSuggesting] = useState<"idle" | "busy" | "none" | "nothingNew">("idle");

  const commit = (next: AreaDef[]) => edit.set(next.length ? withPrefixes(next, published) : null);

  // Each row's own key for this draft, kept beside the list: a removed row
  // takes its key with it, so the rows after it keep their fields (and what
  // is typed in them). Rebuilt when the list changes under the page (a read,
  // Discard).
  const keys = useRef<string[]>([]);
  const fresh = () => `row-${Math.random().toString(36).slice(2)}`;
  if (keys.current.length !== list.length) keys.current = list.map(fresh);
  // New areas whose folder isn't chosen yet: "" until then, which the check
  // would read as a second whole repository.
  const [pendingFolder, setPendingFolder] = useState<ReadonlySet<string>>(new Set());

  const add = () => {
    keys.current = [...keys.current, fresh()];
    setPendingFolder((s) => new Set([...s, keys.current[keys.current.length - 1]]));
    commit(addArea(list, publishedIds));
  };
  const remove = (index: number) => {
    keys.current = keys.current.filter((_, i) => i !== index);
    commit(removeArea(list, index));
  };
  /** The suggestion merged in: only folders no area here has yet. */
  const merge = (suggestion: AreaDef[]): number => {
    const { list: next, added } = mergeSuggestion(list, suggestion, publishedIds);
    if (added > 0) {
      keys.current = [...keys.current, ...next.slice(list.length).map(fresh)];
      commit(next);
    }
    return added;
  };

  // *Set up areas…* on the Board left Plyloft's suggestion: it is the draft
  // once the page has read the repository (and only where it can be saved).
  // After the page's own effects have taken the read in (a child's effect
  // runs first, and an edit before the read is not accepted).
  const took = useRef(false);
  const read = edit.read;
  useEffect(() => {
    if (took.current || !read || !editable) return;
    took.current = true;
    const t = window.setTimeout(() => {
      const suggestion = useAreas.getState().takeSuggestion(workspaceId);
      if (suggestion?.length) merge(suggestion);
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, editable, workspaceId]);

  // The rules, as the list is typed (B1's `areas_check`), the newest only.
  // A new area whose folder isn't chosen is checked as a folder of its own,
  // so it isn't a second whole repository before anyone typed one.
  const key = JSON.stringify(
    list.map((a, i) => (pendingFolder.has(keys.current[i]) && !a.path ? { ...a, path: `${a.id}.unchosen` } : a)),
  );
  useEffect(() => {
    let live = true;
    const parsed = JSON.parse(key) as AreaDef[];
    if (parsed.length === 0) {
      setCheck(null);
      return;
    }
    const t = window.setTimeout(() => {
      areasCheck(parsed, workspaceId)
        .then((c) => live && setCheck(c))
        .catch(() => live && setCheck(null));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key, workspaceId]);

  async function suggest() {
    setSuggesting("busy");
    try {
      const found = await areasDiscover(workspaceId);
      if (found?.suggestion.length) setSuggesting(merge(found.suggestion) > 0 ? "idle" : "nothingNew");
      else setSuggesting("none");
    } catch {
      setSuggesting("none");
    }
  }

  const problem = pageProblem(view);
  const whole = listProblems(check);
  const marks = edit.marks;
  // DS6 (scene 10): Board label only on a board of GitHub issues.
  // G2 walk: an area with no default release of its own says what
  // Shipping says — "Same as Ship it (…)", the kind it follows now.
  const shipVia = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.shipVia);
  const onGitHub = useShipOffersPr(workspaceId);
  const followed = followedReleaseKind(shipVia, onGitHub);
  const githubBoard = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.kanbanSyncMode === "githubIssues",
  );
  // The branches Cards go to offers (the Shipping row's read), once a
  // sub-page opens.
  const open = edit.sub != null && list[edit.sub] ? edit.sub : null;
  const [branches, setBranches] = useState<BranchChoices | null>(null);
  useEffect(() => {
    // Round 1: closed, the read is dropped, so a reopen (after a failed
    // one, or back online) reads again.
    if (open == null) {
      setBranches(null);
      return;
    }
    if (branches) return;
    let live = true;
    workspaceDefinitionBranches(workspaceId)
      .then((b) => live && setBranches(b))
      .catch(() => live && setBranches({ branches: [], localBranches: [], defaultBranch: "", error: "unreadable", hasOrigin: true }));
    return () => {
      live = false;
    };
  }, [open, branches, workspaceId]);
  // Round 1: a sub-page whose area is gone (the list shrank under it: a
  // Discard, a read) goes back to the list.
  const stale = edit.sub != null && !list[edit.sub];
  const closeSub = edit.openSub;
  useEffect(() => {
    if (stale) closeSub(null);
  }, [stale, closeSub]);

  const savedWithPrefixes = useMemo(() => withPrefixes(areaList(edit.saved), published), [edit.saved, published]);
  const prefixOf = (area: AreaDef, index: number) =>
    area.tagPrefix ?? published.find((p) => p.id === area.id)?.tagPrefix ?? autoPrefix(index, area.id);
  const releaseOf = (area: AreaDef) =>
    publishedIds.has(area.id) ? (releases?.find((r) => r.id === area.id) ?? null) : null;
  const problemLine = problem && (
    <p className="ux-sheet-text" role="status" data-ply-area-problem={problem.held ? "held" : "kept"}>
      {machineWords(problem.text)}
    </p>
  );

  if (open != null) {
    const area = list[open];
    return (
      <>
        {problemLine}
        <AreaRows
          key={keys.current[open]}
          pendingFolder={pendingFolder.has(keys.current[open])}
          otherRoot={list.some(
            (a, j) => j !== open && !(a.path ?? "").replace(/[\\/.\s]/g, "") && !pendingFolder.has(keys.current[j]),
          )}
          onFolderChosen={() =>
            setPendingFolder((s) => {
              const n = new Set(s);
              n.delete(keys.current[open]);
              return n;
            })
          }
          onRemove={() => {
            edit.openSub(null);
            remove(open);
          }}
          area={area}
          index={open}
          followed={followed}
          list={list}
          check={check}
          editable={editable}
          readOnly={edit.readOnly}
          published={publishedIds}
          prefix={prefixOf(area, open)}
          release={releaseOf(area)}
          publishedFiles={published.find((p) => p.id === area.id)?.versionFiles ?? null}
          workspaceBranch={workspaceBranch}
          commit={commit}
          githubBoard={githubBoard}
          branches={branches}
          shared={edit.shared}
          shareable={edit.shareable}
          onOpenShipping={() => useUi.getState().openSettingsSection(SHIPPING_SETTINGS_SECTION, { workspaceId })}
        />
        {/* What the rules say about the list as a whole, here too. */}
        {(whole.errors.length > 0 || whole.warnings.length > 0) && (
          <Group label={AREAS_SECTION}>
            {whole.errors.length > 0 && <Row kind="value" label="Areas" error={whole.errors.join(" ")} />}
            {whole.warnings.length > 0 && <Row kind="value" label="Worth knowing" hint={whole.warnings.join(" ")} />}
          </Group>
        )}
      </>
    );
  }

  // The list's own line ("Areas"): drawn only with something to say — a
  // hint, an error or a change mark (C10 walk: a lone "Areas" under the
  // list said nothing). Without it, the anchor sits on the list.
  const listHint =
    suggesting === "none"
      ? NOTHING_TO_SUGGEST
      : suggesting === "nothingNew"
        ? NOTHING_NEW_TO_SUGGEST
        : list.length
          ? marks.hint ?? undefined
          : NO_AREAS;
  const listLine = listHint != null || whole.errors.length > 0 || marks.changed != null;
  return (
    <>
      {problemLine}
      <Section title={AREAS_SECTION} scope="repository" shared={edit.shared} shareable={edit.shareable}>
        <div id={listLine ? undefined : marks.anchor}>
        <Group label={AREAS_SECTION}>
          {list.map((area, index) => {
            const said = problemsFor(check, area.id, ["id", "name", "path", "targetBranch", "versionFiles", "label", "tagPrefix", "lookAt"]);
            const name = areaTitle(area);
            // C10 §1b: kept here, each changed area says so on its row.
            const keptChange = edit.shared ? null : keptRowChange(area, savedWithPrefixes);
            return (
              <Row
                key={keys.current[index]}
                kind="value"
                label={name}
                // Without the list's own line, a search for "Areas" lands
                // on the list's first row (Challenger round 2).
                findAs={!listLine && index === 0 ? AREAS_SECTION : undefined}
                changed={keptChange ? { hint: machineWords(keptChange) } : undefined}
                hint={areaSummary(area, prefixOf(area, index), workspaceBranch, releases === null ? "reading" : releaseOf(area))}
                error={said.errors.length ? said.errors.join(" ") : undefined}
                action={
                  <CBtn onClick={() => edit.openSub(index)} aria-label={`${EDIT_AREA.replace("…", "")} ${areaTitle(area)}…`}>
                    {EDIT_AREA}
                  </CBtn>
                }
              />
            );
          })}
          {listLine && (
            <Row
              kind="procedure"
              label="Areas"
              anchor={marks.anchor}
              changed={marks.changed}
              hint={listHint}
              error={whole.errors.length ? whole.errors.join(" ") : undefined}
            />
          )}
          {whole.warnings.length > 0 && (
            <Row kind="value" label="Worth knowing" hint={whole.warnings.join(" ")} />
          )}
        </Group>
        </div>
        {/* Round 1 (tidy tables): the list's two presses on a line of their
            own under the table, not in a row's action slot. */}
        {editable && (
          <div className="ux-flow-actions" data-ply-areas-actions="">
            <CBtn
              onClick={() => {
                add();
                // The new area's sub-page, to choose its folder.
                edit.openSub(list.length);
              }}
            >
              {ADD_AREA}
            </CBtn>
            <CBtn disabled={suggesting === "busy"} onClick={() => void suggest()}>
              {suggesting === "busy" ? "Looking…" : SUGGEST_AREAS}
            </CBtn>
          </div>
        )}
      </Section>
    </>
  );
}

/** DS6: the sub-page's own rows beside the fields (`field`), named as the
 *  Shipping rows they mirror. */
const SUB_ROW = { cardsGoTo: "Cards go to", defaultRelease: "Default release" } as const;

/** DS6 (scene 10): one area's sub-page — its rows, Cards go to as a branch
 *  Select, Board label only on a board of GitHub issues, its Default
 *  release with the way to Shipping, and Remove at the foot. */
function AreaRows({
  area,
  index,
  list,
  check,
  editable,
  readOnly,
  published,
  prefix,
  release,
  publishedFiles,
  workspaceBranch,
  commit,
  pendingFolder,
  otherRoot,
  onFolderChosen,
  onRemove,
  githubBoard,
  branches,
  shared,
  shareable,
  onOpenShipping,
  followed,
}: {
  shareable?: boolean;
  /** The kind a release follows where the area chose none (Shipping's). */
  followed: ReleaseKind;
  pendingFolder: boolean;
  /** Another area of the list takes the whole repository. */
  otherRoot: boolean;
  onFolderChosen: () => void;
  onRemove: () => void;
  area: AreaDef;
  index: number;
  list: AreaDef[];
  check: AreaCheck | null;
  editable: boolean;
  readOnly: boolean;
  published: ReadonlySet<string>;
  /** Its tag prefix as published or as it would be written. */
  prefix: string;
  /** Its latest tag and version as read from the repository; `null` for an
   *  area not published yet, or while unknown. */
  release: AreaRelease | null;
  /** Its version files as published. */
  publishedFiles: AreaDef["versionFiles"];
  workspaceBranch: string;
  commit: (next: AreaDef[]) => void;
  githubBoard: boolean;
  /** The project's branches (`workspaceDefinitionBranches`); null while read. */
  branches: BranchChoices | null;
  shared: boolean;
  onOpenShipping: () => void;
}) {
  const name = areaTitle(area);
  // A new area whose name's id belonged to an area removed in this draft.
  const wanted = slugId(area.name ?? "");
  const reserved =
    !published.has(area.id) && wanted && wanted !== area.id && published.has(wanted) && !list.some((a) => a.id === wanted)
      ? wanted
      : null;
  // Version files are typed as text and read on blur, so a comma being
  // typed isn't a file yet.
  const [versions, setVersions] = useState(versionFilesText(area.versionFiles));
  useEffect(() => setVersions(versionFilesText(area.versionFiles)), [area.versionFiles]);

  // The areas setting's write for the Version files field, from what
  // was typed (Settings' undoable rule: an onCommit writes a setting).
  const setVersionFilesFromText = (text: string) =>
    commit(setField(list, index, { versionFiles: parseVersionFiles(text, area.versionFiles) }));
  const said = (fields: string[]) => problemsFor(check, area.id, fields);
  const now = versionNowWords(release, area.versionFiles, publishedFiles);
  const field = (
    label: string,
    fields: string[],
    hint: string,
    value: string,
    onChange: (next: string) => void,
    /** `commitOnBlur`: the field is read when it is left (Enter or blur) and
     *  written to the areas setting then (`setVersionFilesFromText`). */
    opts: { placeholder?: string; mono?: boolean; shown?: string; commitOnBlur?: boolean; error?: string } = {},
  ) => {
    const said_ = said(fields);
    const errors = opts.error ? [opts.error, ...said_.errors] : said_.errors;
    const warnings = said_.warnings;
    return (
      <Row
        kind={editable ? "text" : "value"}
        label={label}
        hint={warnings.length ? `${hint} ${warnings.join(" ")}` : hint}
        error={errors.length ? errors.join(" ") : undefined}
        readOnly={readOnly}
      >
        {editable ? (
          <TextField
            value={value}
            onChange={onChange}
            onCommit={opts.commitOnBlur ? (v) => setVersionFilesFromText(v) : undefined}
            label={`${name}: ${label}`}
            placeholder={opts.placeholder}
            mono={opts.mono}
            error={errors.length > 0}
            wide
          />
        ) : (
          <RowValue mono={opts.mono}>{opts.shown ?? (value || opts.placeholder || "—")}</RowValue>
        )}
      </Row>
    );
  };

  // Cards go to: the branches read from the project (as Shipping's row); the
  // project's own branch means "none of its own".
  const goesTo = area.targetBranch?.trim() || workspaceBranch;
  // Round 1: where the setup is shared, Cards go to offers GitHub's branches
  // (once read). Kept on this Mac, it offers GitHub's (when read without an
  // error) together with this computer's own, so a project with no origin or
  // offline still has a list. Neither list: a text field.
  const local = branches?.localBranches ?? [];
  const originRead = !!branches && branches.hasOrigin && !branches.error ? branches.branches : [];
  const offered = shared && originRead.length > 0 ? originRead : shared ? local : [...new Set([...originRead, ...local])];
  const reading = !branches;
  const known = !reading && offered.length > 0;
  const options = [...new Set([goesTo, workspaceBranch, ...offered].filter(Boolean))].map((b) => ({ value: b, label: b }));
  const setGoesTo = (next: string) =>
    commit(setField(list, index, { targetBranch: !next.trim() || next.trim() === workspaceBranch ? null : next.trim() }));
  const branchSaid = said(["targetBranch"]);
  const chosenKind = asReleaseKind(area.releaseKind);
  const releaseWords = machineWords(chosenKind ? RELEASE_KIND_LABEL[chosenKind] : followChoiceLabel(followed));

  return (
    <Section title={name} scope="repository" shared={shared} shareable={shareable}>
      <Group label={name}>
        {field(
          "Name",
          ["id", "name"],
          reserved ? `${HINT.name} ${reservedIdWords(reserved, area.id)}` : HINT.name,
          area.name ?? "",
          (v) => commit(renameArea(list, index, v, published)),
        )}
        {field(
          "Folder",
          pendingFolder ? [] : ["path"],
          pendingFolder ? CHOOSE_FOLDER : HINT.path,
          area.path ?? "",
          (v) => {
            onFolderChosen();
            commit(setField(list, index, { path: v }));
          },
          {
            placeholder: pendingFolder ? "for example site" : "the whole project",
            mono: true,
            shown: folderWords(area.path ?? ""),
            // B1's save refuses a second whole repository: with another area
            // taking it, an unchosen folder is an error, not a hint. Without
            // one, an empty folder is the root and stays valid.
            error: pendingFolder && !area.path?.trim() && otherRoot ? CHOOSE_FOLDER : undefined,
          },
        )}
        <Row
          kind={editable ? (known || reading ? "choice" : "text") : "value"}
          label={SUB_ROW.cardsGoTo}
          hint={editable && reading ? "Plyloft is reading this repository's branches." : HINT.targetBranch}
          error={branchSaid.errors.length ? branchSaid.errors.join(" ") : undefined}
          readOnly={readOnly}
          disabled={editable && reading}
        >
          {editable && (known || reading) ? (
            <Select value={goesTo} options={options} mono label={`${name}: Cards go to`} onChange={setGoesTo} />
          ) : editable ? (
            <TextField
              value={area.targetBranch ?? ""}
              onChange={(v) => commit(setField(list, index, { targetBranch: v ? v : null }))}
              onCommit={(v) => setGoesTo(v)}
              label={`${name}: Cards go to`}
              placeholder={workspaceBranch}
              mono
              wide
            />
          ) : (
            <RowValue mono>{goesTo || "—"}</RowValue>
          )}
        </Row>
        {field(
          "Version files",
          ["versionFiles"],
          `${HINT.versionFiles}${now ? ` Now ${release?.version}.` : ""}`,
          versions,
          setVersions,
          {
            mono: true,
            placeholder: "the project's own",
            shown: versions ? `${versions}${now}` : undefined,
            commitOnBlur: true,
          },
        )}
        {field(
          "Release tags start with",
          ["tagPrefix"],
          HINT.tagPrefix(prefix),
          prefix,
          (v) => commit(setField(list, index, { tagPrefix: v.trim() })),
          {
            mono: true,
            // C12 (AR-4): never "vX.Y.Z" on screen.
            placeholder: "nothing: tags like v1.0.0",
            shown: prefix || "nothing: tags like v1.0.0",
          },
        )}
        {field(
          "Where to look at it",
          ["lookAt"],
          HINT.lookAt,
          area.lookAt ?? "",
          (v) => commit(setField(list, index, { lookAt: v.trim() ? v.trim() : null })),
          { placeholder: "https://", mono: true },
        )}
        {githubBoard &&
          field(
            "Board label",
            ["label"],
            HINT.label,
            area.label ?? "",
            (v) => commit(setField(list, index, { label: v.trim() ? v : null })),
            { placeholder: `area:${area.id}`, mono: true },
          )}
        <Row
          kind="value"
          label={SUB_ROW.defaultRelease}
          hint={HINT.releaseKind(releaseWords)}
          action={<CBtn onClick={onOpenShipping}>{OPEN_SHIPPING}</CBtn>}
        />
      </Group>
      {editable && (
        <div className="ux-flow-actions">
          <CBtn onClick={onRemove}>Remove {name}</CBtn>
        </div>
      )}
    </Section>
  );
}
