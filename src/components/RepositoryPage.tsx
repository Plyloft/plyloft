import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  projectConfigGet,
  projectConfigSet,
  projectConfigSetReview,
  releaseKindSet,
  workspaceDefinitionOpenPullRequest,
  workspaceDefinitionSave,
  setupOpenGithubSso,
  openWebLink,
  worktreeSettingsSet,
  type ProjectConfig,
  type ReviewChecklistClass,
} from "../ipc";
import { quotedLabel } from "../lib/definitionRefresh";
import { publishTarget, publishTargetOfDraft,
  changes as draftChanges,
  commitMessage,
  firstSharedProjectNote,
  isConfigField,
  leaveBody,
  leaveQuestion,
  markHint,
  patchConfig,
  publishBar,
  readOnlyFooter,
  reviewLede,
  reviewTitle,
  readField,
  normalise,
  sameValue,
  readOnlyRowLine,
  rowLabel,
  rowMark,
  reviewMovedNote,
  teamValuesSheet,
  teamValuesToast,
  statusLine,
  isBranchMissing,
  valueText,
  type Change,
  type Draft,
  type FieldKey,
} from "../lib/repositoryPage";
import {
  discardable,
  emptySession,
  reduce,
  type DraftEvent,
  type DraftSession,
} from "../lib/draftSession";
import {
  localSaveProblem,
  pageError,
  publishDraft,
  readAgainProblem,
  firstReadProblem,
  type PublishProblem,
} from "../lib/publishDraft";
import { clearLeaveGuard, setLeaveGuard, type LeaveGuard } from "../lib/leaveGuard";
import { enqueueWrite, watchWrites } from "../lib/localWriteQueue";
import { useRepositoryDefinition, type RepositoryState } from "../hooks/useRepositoryDefinition";
import type { Scope } from "../lib/uxScope";
import { pushToast, UNDO_TOAST_MS } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import {
  CBtn,
  Details,
  ErrorBlock,
  Footnote,
  Page,
  PageHeader,
  PublishBar,
  Sheet,
  SheetChange,
  StatusLine,
  useLandingNonce,
  usePageReading,
} from "./ux";
import { machineWords } from "../lib/platform";
import { UNDO_SUPERSEDED } from "../lib/undoable";
import { useSetup } from "../store/setupStore";
import { linkDidNotOpen } from "../lib/linkToast";
import { confirmSheet } from "../store/confirmStore";
import { moveSharedSetup } from "./AdoptionBanner";
import { workspaceUseTeamValues } from "../lib/sharedSetupIpc";
import { leftOpenLine } from "../lib/sharedSetup";
import { refreshConfiguredProjects } from "../store/setupFinishStore";
import { useSettingConflict } from "../store/settingConflictStore";
import { useAreas } from "../store/areaStore";
import { asReleaseKind } from "../lib/shippingPage";
import { pushErrorToast } from "../lib/errorToast";

/**
 * UX language card 2 (ADR 0004; BOARDS.md §2 and §6): the shell both
 * Repository pages are built on — the header with its scope badge and
 * status line, the draft, the publish bar, the Review sheet and the
 * question asked when you leave a draft behind.
 *
 * With a shared definition the page edits in place and publishes: nothing
 * is sent until Publish, and one `workspace_definition_save` carries every
 * changed field, so the channel makes one commit. Without one the same page
 * edits this Mac's own config and saves as it changes, with no bar.
 */

export interface RepositoryDraft {
  repo: RepositoryState;
  /** The value a row shows: the draft's, else the one in use. */
  value: (key: FieldKey) => unknown;
  /** Resolves false when a This-Mac save was refused, so the control that
   *  asked for it can keep what the person typed (F18). */
  set: (key: FieldKey, next: unknown) => Promise<boolean>;
  /** Several fields at once (a Re-detect): one draft change, or one save. */
  setMany: (next: Partial<Record<FieldKey, unknown>>) => Promise<boolean>;
  /** A change computed from the value as it is when the change is made,
   *  not as the render that built the control saw it: a list edited after
   *  a Sync, or after a native picker was open for a minute (F29). */
  update: (key: FieldKey, next: (current: unknown) => unknown) => Promise<boolean>;
  /** A procedure that writes this Mac's settings itself (Reset), run in the
   *  same queue as every other local write so it cannot land between one's
   *  read and its write, with its failure kept on the page. The job must
   *  not call `set`/`setMany`: those queue behind it and it would wait for
   *  them for ever. A procedure that only reads calls `fail` instead. */
  runLocal: (job: () => Promise<void>, failure: (e: unknown) => PageFailure) => Promise<boolean>;
  /** Puts an error on the page, or takes it away (PATTERNS.md §4). */
  fail: (failure: PageFailure | null) => void;
  /** The Row props a field carries: its mark, its anchor and its hint. */
  rowProps: (key: FieldKey, hint: ReactNode) => RowMarkProps;
  readOnly: boolean;
  /** A write of this workspace's is queued or running, or a publish is in
   *  flight. A procedure that would race them waits for it. */
  busy: boolean;
  /** A publish is in flight: nothing may be edited, because the draft an
   *  edit would join is about to be answered by what that save carried
   *  (F1, F3). A local save does not freeze the page — it moves no
   *  baseline, and the queue keeps the writes in order. */
  frozen: boolean;
  /** Which sub-page is open (`null` = the page itself). */
  sub: string | null;
  openSub: (id: string | null) => void;
  /** A change made by a sub-page that writes a whole list at once. */
  changeCount: number;
  /** The number the publish bar gives this field's change, or undefined. */
  changeNumber: (key: FieldKey) => number | undefined;
}

export interface RowMarkProps {
  anchor: string;
  hint: ReactNode;
  changed?: { n?: number; hint: ReactNode };
  readOnly: boolean;
  /** Nothing is edited while a publish is in flight: the draft it would
   *  join is about to be answered by what that save carried (F1, F3). */
  disabled: boolean;
}

export interface SubPage {
  title: string;
  lede: ReactNode;
  /** The label of the way back (`← Build & release`). */
  back: string;
}

/** A `ProjectConfig` under the page's field names, so Undo can name the
 *  value a row really had. */
function configValues(config: ProjectConfig): Record<string, unknown> {
  return {
    integrationBranch: config.targetBranch,
    versionFiles: config.versionFiles,
    installScript: config.installScript ?? null,
    verifyPipeline: config.verifyPipeline ?? null,
    cachePaths: config.cachePaths ?? null,
    sharedBuildCache: config.sharedBuildCache ?? true,
  };
}

/** An error that needs someone to act, kept on the page (PATTERNS.md §4).
 *  The same three parts the publish sequence speaks in. */
export type PageFailure = PublishProblem;

/** A local save that failed part-way through: the fields it had already
 *  written before it threw. `saveLocal` attaches them so the page can say
 *  what really landed rather than claiming nothing did. */
class LocalSaveError extends Error {
  written: FieldKey[];
  constructor(cause: unknown, written: FieldKey[]) {
    super(String(cause));
    this.name = "LocalSaveError";
    this.written = written;
  }
}

function localFailure(next: Partial<Record<FieldKey, unknown>>, e: unknown): PageFailure {
  return localSaveProblem(
    Object.keys(next) as FieldKey[],
    e instanceof LocalSaveError ? e.written : [],
    e instanceof LocalSaveError ? e.message : String(e),
  );
}

export function anchorOf(key: string): string {
  return `ux-repo-row-${key}`;
}

/** Everything but the definition's own fields, so a local save keeps them. */
function blankConfig(branch: string): ProjectConfig {
  return {
    schemaVersion: 0,
    targetBranch: branch,
    versionFiles: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

export function RepositoryPage({
  workspaceId,
  order,
  title,
  lede,
  subPages = {},
  openAt = null,
  fallbackBranch = null,
  hiddenNote = null,
  scope = "repository",
  detailPath = ".atelier/workspace.json",
  children,
  danger,
  below,
  after = null,
  afterReading = false,
  flowUp = false,
  onPublished,
}: {
  workspaceId: string;
  order: readonly FieldKey[];
  title: string;
  lede: ReactNode;
  /** 1.174.0 (DS6): or built from the draft, for sub-pages named after
   *  what is being edited (an area). */
  subPages?: Record<string, SubPage> | ((draft: RepositoryDraft) => Record<string, SubPage>);
  /** A sub-page something outside asked for (a class drafted on a card). */
  openAt?: string | null;
  /** The repository's default branch, for a workspace that names none of
   *  its own yet: the first local save must not guess one. */
  fallbackBranch?: string | null;
  /** A link asked for an entry its condition hides and landed here: the
   *  page says what is hidden and where to switch it on (BOARDS.md §2). */
  hiddenNote?: string | null;
  /** What the navigation already knows this page's scope is, for the badge
   *  while the first read is in flight. */
  scope?: Scope;
  detailPath?: string;
  children: (draft: RepositoryDraft) => ReactNode;
  /** The This-Mac page's danger zone (`Reset`), rendered under the groups. */
  danger?: (draft: RepositoryDraft) => ReactNode;
  /** 1.174.0 (DS4): sections under `after` that are not fields of the
   *  definition and keep no part state — General's Models suggested for the
   *  team. Drawn on the page itself only, never under a sub-page or a flow. */
  below?: (draft: RepositoryDraft) => ReactNode;
  /** 1.174.0 (DS1): parts of the page drawn under its rows that are not
   *  fields of the definition — General's Board (`PartsOf`). */
  after?: ReactNode;
  /** That part hasn't drawn its rows yet: a link landing on one of them waits. */
  afterReading?: boolean;
  /** A flow of one of those parts is up: the page shows that part alone, as
   *  the focused surface a flow is (PATTERNS.md §6). The draft is kept, and
   *  the part keeps its place in the tree, so it keeps its state. */
  flowUp?: boolean;
  /** 1.174.0 (C11): after a publish landed — the fields it sent, and the
   *  values they had before it (Areas asks about the direction then). */
  onPublished?: (sent: Record<string, unknown>, before: Record<string, unknown>) => void;
}) {
  const onPublishedRef = useRef(onPublished);
  onPublishedRef.current = onPublished;
  const repo = useRepositoryDefinition(workspaceId, { releaseKind: order.includes("releaseKind") });
  // The draft's life — what an edit, a Discard and a Publish may do, and
  // when — is `lib/draftSession.ts`'s, so it is one rule with a test that
  // runs a save that takes its time, rather than a handful of `disabled`
  // props (F1, F3).
  const [session, setSession] = useState<DraftSession>(emptySession);
  const draft = session.draft;
  const [sub, setSub] = useState<string | null>(null);
  // DS4 round 1: a search or link lands on the page's own rows, so it
  // closes a sub-page (General's team models, Version files…) first. The
  // draft is kept.
  const landing = useLandingNonce();
  useEffect(() => {
    if (landing !== null) setSub(null);
  }, [landing]);
  // Local writes run one after another, in a queue that belongs to the
  // workspace rather than to this mount: a toast's Undo pressed after
  // Settings was closed and opened again joins the same queue (F5), and
  // the page stays busy while anything is still in it (F14).
  const [writing, setWriting] = useState(0);
  // The page holds still from the moment Publish is pressed until the read
  // that says what the save did has landed (F3).
  const publishInFlight = session.phase !== "idle";
  const busy = writing > 0 || publishInFlight;

  useEffect(() => watchWrites(workspaceId, setWriting), [workspaceId]);
  const [reviewing, setReviewing] = useState(false);
  const [leaving, setLeaving] = useState<{ proceed: () => void } | null>(null);
  // The question that is open, so a publish resolving after `Stay` does
  // not navigate on a question nobody is answering any more (F1).
  const leavingNow = useRef<{ proceed: () => void } | null>(null);
  leavingNow.current = leaving;
  // PATTERNS.md §4: an error that needs action stays on the page. A toast
  // says it happened; this says what happened, what was left unchanged and
  // what to do, until the next write goes through (F9).
  const [failure, setFailure] = useState<PageFailure | null>(null);
  const rename = useWorkspaces((s) => s.rename);
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  const reload = repo.reload;
  const latest = useRef(repo);
  latest.current = repo;
  // The session is kept in a ref as well as in state, and `move` is its
  // only writer — a render that assigned it would put back the state React
  // has not flushed yet, undoing a change made a moment ago, which is the
  // one thing the ref is here to prevent. A second change made in the same
  // tick as the first — two removals in one batch — builds on it rather
  // than on the render both handlers were drawn in (F29, F14).
  const sessionRef = useRef<DraftSession>(session);
  const draftRef = useRef<Draft>(draft);
  /** The page tells the session what happened; `lib/draftSession.ts` says
   *  what it means. Synchronously, so a second event in the same tick as
   *  the first sees the result of it. */
  const dispatch = useCallback((event: DraftEvent): boolean => {
    const { session: next, accepted } = reduce(sessionRef.current, event);
    if (next !== sessionRef.current) {
      sessionRef.current = next;
      draftRef.current = next.draft;
      setSession(next);
    }
    return accepted;
  }, []);

  const list = useMemo(
    () => (repo.shared ? draftChanges(order, repo.values, draft) : []),
    [repo.shared, order, repo.values, draft],
  );

  useEffect(() => {
    if (openAt) setSub(openAt);
  }, [openAt]);

  // A page that moves to another workspace drops its draft. One whose workspace
  // gains or loses a shared definition keeps it (two-account walk: that read now
  // lands as somebody starts editing): gained, it waits on the publish bar for
  // the person's press; lost, it is saved on this Mac below, as an edit here is.
  const shared = repo.shared;
  useEffect(() => {
    dispatch({ kind: "reset" });
  }, [workspaceId, dispatch]);

  // What the page shows can move without a read of its own — a rename or
  // an accent picked in the sidebar. Draft keys the values have caught up
  // with go (F6); nothing is settled by it, because only a read says what
  // a save did.
  const values = repo.values;
  useEffect(() => {
    dispatch({ kind: "valuesChanged", values });
  }, [values, dispatch]);

  // Every read that completed, and what it said. By now React has rendered
  // with whatever it brought, so the values an edit would be judged
  // against are the ones the page is showing. A read that succeeded is
  // what lets the page be edited again; one that failed brings no values,
  // so the reducer keeps it still and the page says so (F3).
  const reads = repo.reads;
  const lastReadOk = repo.lastReadOk;
  useEffect(() => {
    dispatch(lastReadOk ? { kind: "read", ok: true, values } : { kind: "read", ok: false });
    // `values` is not a dependency of *this* effect: a read that brought
    // the same values is still a read, and one that failed brought none.
    // The effect above keeps the draft in step with the values themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, lastReadOk, dispatch]);

  // ── Saving ─────────────────────────────────────────────────────────
  // This Mac: every control saves as it changes, and the toast offers Undo
  // for a few seconds (PATTERNS.md §5).
  const saveLocal = useCallback(
    async (
      next: Partial<Record<FieldKey, unknown>>,
      announce: boolean,
      /** An Undo: the values its toast announced. It writes only while the
       *  fields still hold them (A5F-08). */
      onlyIfStill?: Partial<Record<FieldKey, unknown>>,
    ) => {
      const state = latest.current;
      const keys = Object.keys(next) as FieldKey[];
      // The config-backed fields go in one write, onto the config as it is
      // on disk right now — never this render's copy of it.
      const touchesConfig = keys.some(isConfigField);
      // A read that fails is not a reason to write a whole config built
      // from a copy that may be old: that is the lost update this queue
      // exists to stop, so the save fails instead.
      const onDisk = touchesConfig
        ? await projectConfigGet(workspaceId).catch((e) => {
            throw new LocalSaveError(
              machineWords(`Plyloft couldn't read this repository's settings on this Mac before writing them: ${e}`),
              [],
            );
          })
        : null;
      const config = onDisk ?? state.config ?? blankConfig(fallbackBranch ?? state.branch);
      // What Undo puts back: the config as it really is, not as the page
      // last read it, and the workspace's own fields from the page.
      const was: Partial<Record<FieldKey, unknown>> = {};
      for (const key of keys) {
        was[key] = isConfigField(key)
          ? readField(key, configValues(config))
          : state.values[key] ?? null;
      }
      if (onlyIfStill) {
        const moved = (Object.keys(onlyIfStill) as FieldKey[]).some(
          (key) => !sameValue(normalise(key, onlyIfStill[key]), normalise(key, was[key])),
        );
        if (moved) {
          pushToast({ kind: "warn", title: UNDO_SUPERSEDED });
          return;
        }
      }
      // Each field has its own home, so a batch is several writes. What
      // landed before one of them failed is remembered, and the error says
      // so rather than claiming nothing changed.
      const written: FieldKey[] = [];
      try {
        for (const key of keys) {
          const to = next[key];
          if (key === "name") {
            await rename(workspaceId, String(to ?? ""));
          } else if (key === "accentColor") {
            await invoke("workspace_set_accent_color", { id: workspaceId, color: to ?? null });
            await refreshWorkspaces();
          } else if (key === "selfCheck") {
            await projectConfigSetReview(workspaceId, { selfCheck: to !== false });
          } else if (key === "reviewChecklist") {
            await projectConfigSetReview(workspaceId, {
              reviewChecklist: (to ?? []) as ReviewChecklistClass[],
              baseChecklist: state.review?.reviewChecklist ?? [],
            });
          } else if (key === "worktreeCopy") {
            // SL-4: an empty list clears it.
            await worktreeSettingsSet(workspaceId, { worktreeCopy: (to ?? []) as string[] });
          } else if (key === "worktreeSetup") {
            await worktreeSettingsSet(workspaceId, { worktreeSetup: (to as string | null) ?? "" });
          } else if (key === "releaseKind") {
            // 1.173.0 (G1): this Mac's own default release kind, where
            // Release… and Ship batch read it (the area store).
            await releaseKindSet(workspaceId, asReleaseKind(to));
            void useAreas.getState().load(workspaceId);
          } else {
            continue;
          }
          written.push(key);
        }
        // Every config-backed field in one atomic write.
        if (touchesConfig) {
          await projectConfigSet(workspaceId, patchConfig(config, next));
          written.push(...keys.filter(isConfigField));
          // OB-15: a first config may finish Setup's `project` item.
          refreshConfiguredProjects();
        }
      } catch (e) {
        await reload();
        throw new LocalSaveError(e, written);
      }
      // The authoritative read before the next write in the queue runs, so
      // the one after it starts from what is really on disk.
      await reload();
      if (!announce || keys.length === 0) return;
      pushToast({
        kind: "info",
        title:
          keys.length === 1
            ? `${quotedLabel(rowLabel(keys[0]))} set on this Mac`
            : `${keys.length} settings changed on this Mac`,
        body: keys.length === 1 ? valueText(keys[0], next[keys[0]]) : undefined,
        action: {
          label: "Undo",
          ttlMs: UNDO_TOAST_MS,
          // Through the queue like any other change (F5): an Undo that
          // read the config beside a change in flight would write a whole
          // config without it.
          onClick: () => void enqueueLocal(was, false, next),
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, rename, refreshWorkspaces, reload, fallbackBranch],
  );

  /** One local write at a time, each starting after the one before it has
   *  written and been read back. */
  const enqueueLocal = useCallback(
    (
      next: Partial<Record<FieldKey, unknown>>,
      announce: boolean,
      onlyIfStill?: Partial<Record<FieldKey, unknown>>,
    ): Promise<boolean> =>
      enqueueWrite(workspaceId, () => saveLocal(next, announce, onlyIfStill))
        .then(() => {
          setFailure(null);
          return true;
        })
        .catch((e) => {
          setFailure(localFailure(next, e));
          pushToast({
            kind: "error",
            title: "Couldn't save on this Mac",
            details: String(e),
          });
          // The page goes back to what is on disk, for the keys that still
          // hold what this save tried to write: one edited again since has
          // its own save on the way and keeps its value.
          // Back to what is on disk, for the keys that still hold what this
          // save tried to write: one edited again since has its own save on
          // the way and keeps its value.
          dispatch({ kind: "localSaveFailed", tried: next });
          return false;
        }),
    [workspaceId, saveLocal, dispatch],
  );

  const wasShared = useRef(shared);
  useEffect(() => {
    const lost = wasShared.current && !shared;
    wasShared.current = shared;
    const held = draftRef.current;
    if (lost && Object.keys(held).length > 0) void enqueueLocal(held, false);
  }, [shared, enqueueLocal]);

  /** A procedure of the page's own, in the same queue, with its failure
   *  kept on the page rather than only in a toast (F32). */
  const runLocal = useCallback(
    (job: () => Promise<void>, failure: (e: unknown) => PageFailure): Promise<boolean> =>
      enqueueWrite(workspaceId, job)
        .then(async () => {
          setFailure(null);
          await latest.current.reload();
          return true;
        })
        .catch(async (e) => {
          setFailure(failure(e));
          // A procedure can fail with part of its work done — a directory
          // half removed — so the page reads back what this Mac has rather
          // than keeping what it had before the attempt (F32).
          await latest.current.reload().catch(() => {});
          return false;
        }),
    [workspaceId],
  );

  const setMany = useCallback(
    (next: Partial<Record<FieldKey, unknown>>): Promise<boolean> => {
      if (latest.current.readOnly) return Promise.resolve(false);
      // Both scopes hold the new values in the draft: shared, until Publish
      // sends them; local, until the save is read back. A list edit made
      // before the one before it landed then builds on the new list, not on
      // the one the page was last rendered with (F4, F14). An edit while a
      // save is out is refused by the session itself.
      const accepted = dispatch({ kind: "edit", values: latest.current.values, next });
      if (!accepted) return Promise.resolve(false);
      if (latest.current.shared) return Promise.resolve(true);
      return enqueueLocal(next, true);
    },
    [enqueueLocal, dispatch],
  );

  const set = useCallback(
    (key: FieldKey, next: unknown) => setMany({ [key]: next }),
    [setMany],
  );

  const update = useCallback(
    (key: FieldKey, next: (current: unknown) => unknown) => {
      const draftNow = draftRef.current;
      const current = key in draftNow ? draftNow[key] : latest.current.values[key] ?? null;
      return setMany({ [key]: next(current) });
    },
    [setMany],
  );

  const value = useCallback(
    (key: FieldKey) => (key in draft ? draft[key] : repo.values[key] ?? null),
    [draft, repo.values],
  );

  const changeNumber = useCallback(
    (key: FieldKey) => list.find((c) => c.key === key)?.n,
    [list],
  );

  // One line under the last group when one person set every field; when
  // the authors differ it gives way to a hint per row (BOARDS.md §2).
  const footerLine = repo.readOnly
    ? readOnlyFooter(order, repo.provenance, repo.author)
    : null;

  const rowProps = useCallback(
    (key: FieldKey, hint: ReactNode): RowMarkProps => {
      // A This-Mac page has nothing unpublished: its draft is only the
      // value a save in flight has not been read back yet.
      const mark = rowMark(key, repo.values, repo.shared ? draft : {}, repo.pending, order, {
        bases: session.bases,
        author: repo.author,
      });
      const sentence = markHint(mark, key);
      const perRow =
        repo.readOnly && footerLine == null ? readOnlyRowLine(repo.provenance?.[key]) : null;
      return {
        anchor: anchorOf(key),
        hint: perRow ?? hint,
        changed: sentence
          ? { n: mark.kind === "draft" ? mark.n : undefined, hint: sentence }
          : undefined,
        readOnly: repo.readOnly,
        disabled: publishInFlight,
      };
    },
    [repo, draft, order, footerLine, publishInFlight],
  );

  // ── Publishing: one save, one commit ───────────────────────────────
  // The sequence — what is sent, what each failure leaves behind, and what
  // the session is told at every point — is `lib/publishDraft.ts`, run by
  // `publishDraft.test.ts` with a save that settles and a read that fails
  // when it says so. What is here is this workspace's own functions.
  const publish = useCallback(() => {
    const state = latest.current;
    // SL-4: only the setup row puts `worktreeSetup` in the draft; publishing
    // what it typed is this Mac agreeing to run it. Another field's publish
    // never approves a command the definition happens to carry.
    const approveSetup = "worktreeSetup" in sessionRef.current.draft;
    // C11: what this publish sends, and what those fields were before it.
    const sending: Record<string, unknown> = { ...sessionRef.current.draft };
    const before: Record<string, unknown> = { ...(state.values as Record<string, unknown>) };
    return publishDraft({
      session: () => sessionRef.current,
      dispatch,
      definition: state.definition,
      values: state.values,
      branch: state.branch,
      // Windows walk (C5): the toast names where it really goes.
      target: publishTargetOfDraft(sending, state.branch, state.publishing),
      sharedProject: state.sharedProject,
      tryCommand: state.config?.tryCommand ?? null,
      readError: state.error,
      order,
      save: (base, payload) => workspaceDefinitionSave(workspaceId, base, payload, approveSetup),
      reload: () => reload().catch(() => {}),
      refreshWorkspaces: () => refreshWorkspaces().catch(() => {}),
      onProblem: setFailure,
      onPublished: ({ queued, branch, count }) => {
        setReviewing(false);
        onPublishedRef.current?.(sending, before);
        // What the publish itself did is said once, by the toasts the
        // refresh report raises (App.tsx); this says only what is true now.
        pushToast({
          kind: "info",
          title: queued ? `Publishing to ${branch}` : "Already published",
          body: queued
            ? `${count === 1 ? "One change" : `${count} changes`} in one commit; your project folder is untouched.`
            : "The repository already has these values.",
        });
      },
      onFailed: (e) =>
        pushErrorToast("Couldn't publish", e),
    });
  }, [workspaceId, order, reload, refreshWorkspaces, dispatch]);

  // ── Leaving a draft asks once (BOARDS.md §6) ───────────────────────
  useEffect(() => {
    if (list.length === 0) return;
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
  }, [list.length]);

  const ctx: RepositoryDraft = {
    repo,
    value,
    set,
    setMany,
    rowProps,
    readOnly: repo.readOnly,
    busy,
    frozen: publishInFlight,
    update,
    runLocal,
    fail: setFailure,
    sub,
    openSub: setSub,
    changeCount: list.length,
    changeNumber,
  };

  const pages = typeof subPages === "function" ? subPages(ctx) : subPages;
  const page = sub ? (pages[sub] ?? null) : null;
  const bar = repo.shared ? publishBar(list, repo.branch, repo.publishing, session.published) : null;
  // WALKFIX-3 (item 2): where this Publish really commits (C5's move).
  const target = publishTarget(list, repo.branch, repo.publishing);

  // While the save is out the bar says so and carries no action: the rows
  // are held still, and a person looking at a greyed page is owed the
  // reason (PATTERNS.md §3).
  const footer =
    session.phase === "publishing" ? (
      <PublishBar
        state="publishing"
        sentence={`Publishing to ${repo.branch}…`}
        detail="The rows hold still until it lands."
        actions={null}
      />
    ) : session.phase === "settling" ? (
      // The save is done, one way or the other. Saying "Publishing…" here
      // would argue with the error block a failed one puts on the page.
      <PublishBar
        state={repo.error ? "waiting" : "publishing"}
        sentence={
          repo.error ? "Plyloft couldn't read back what changed" : "Reading back what changed…"
        }
        detail={machineWords(
          repo.error
            ? `The rows hold still until it can: until then Plyloft doesn't know what this Mac has, and an edit made now would be measured against the wrong thing. Read again above${
                list.length > 0 ? ", or discard what is here" : ""
              }.`
            : "The rows hold still until Plyloft knows what this Mac has now.",
        )}
        actions={
          // Only when there is something to drop: a button that does
          // nothing is worse than no button (PATTERNS.md §3).
          repo.error && list.length > 0 ? (
            <CBtn
              tone="quiet"
              disabled={writing > 0 || !discardable(session)}
              onClick={() => dispatch({ kind: "discard" })}
            >
              Discard
            </CBtn>
          ) : null
        }
      />
    ) : bar ? (
    <PublishBar
      state={bar.kind === "draft" ? "draft" : bar.kind === "publishing" ? "publishing" : "waiting"}
      sentence={bar.sentence}
      detail={
        bar.kind === "draft"
          ? // A read that failed may have left the page behind, and the
            // first shared build field publishes values it read here.
            repo.error
            ? "Plyloft couldn't read this repository's settings a moment ago, so publishing is held: what it has may be out of date. Read them again above, then publish."
            : undefined
          : bar.detail
      }
      jumps={
        bar.kind === "draft"
          ? bar.jumps.map((j) => ({
              n: j.n,
              label: j.label,
              onSelect: () => {
                setSub(null);
                window.requestAnimationFrame(() =>
                  document
                    .getElementById(anchorOf(j.key))
                    ?.scrollIntoView({ block: "center", behavior: "smooth" }),
                );
              },
            }))
          : undefined
      }
      actions={
        bar.kind === "draft" ? (
          <>
            <CBtn
              tone="quiet"
              disabled={writing > 0 || !discardable(session)}
              onClick={() => dispatch({ kind: "discard" })}
            >
              Discard
            </CBtn>
            <CBtn tone="strong" disabled={busy} onClick={() => setReviewing(true)}>
              Review
            </CBtn>
            <CBtn
              tone="accent"
              disabled={busy || !!repo.error}
              onClick={() => void publish()}
            >
              {bar.publishLabel}
            </CBtn>
          </>
        ) : bar.kind === "choosing" ? (
          // C3 Challenger 3: the question, from where the field is.
          <CBtn
            tone="strong"
            onClick={() => void useSettingConflict.getState().show(workspaceId, bar.field)}
          >
            Choose…
          </CBtn>
        ) : bar.kind === "openUrl" ? (
          // C4 round 2: its own recorded address, never #N in this repository.
          <CBtn tone="strong" onClick={() => void openWebLink(bar.url).catch((e: unknown) => pushToast(linkDidNotOpen(bar.url, e)))}>
            Open pull request
          </CBtn>
        ) : bar.kind === "moveTo" ? (
          // C5 (SC-5): the rename's one press.
          <CBtn tone="strong" onClick={() => void moveSharedSetup(workspaceId, bar.to).then(() => repo.reload())}>
            Move to {bar.to}
          </CBtn>
        ) : bar.kind === "cantWrite" ? (
          // C5 (SC-8): the way out for a member who can't write.
          <CBtn tone="strong" onClick={() => void useTeamValues()}>
            Use the team's values…
          </CBtn>
        ) : bar.kind === "trouble" ? (
          // C4 (SC-7): the press that fixes the sign-in.
          <CBtn
            tone="strong"
            onClick={() => {
              const action = bar.action;
              if (action.id === "authorize" && action.org) {
                void setupOpenGithubSso(action.org).catch(() => {});
              } else {
                useSetup.getState().openSetup("rerun", "github");
              }
            }}
          >
            {machineWords(bar.action.label)}
          </CBtn>
        ) : bar.kind === "pullRequest" ? (
          <CBtn
            tone="strong"
            onClick={() =>
              void workspaceDefinitionOpenPullRequest(workspaceId, bar.number).catch((e) =>
                pushToast({
                  kind: "warn",
                  title: `Couldn't open pull request #${bar.number}`,
                  details: String(e),
                }),
              )
            }
          >
            Open pull request
          </CBtn>
        ) : null
        // Waiting and publishing carry no action: the change is already
        // saved here and on its way, and withdrawing one from the channel
        // is not something Ply can do. The boards drew an inert
        // `Publish to staging` beside them; a button that cannot act is
        // noise, so the sentence carries it instead (PATTERNS.md §3).
      }
    />
  ) : undefined;

  /** C5 (SC-8): "Use the team's values…": the sheet, then the drop. */
  async function useTeamValues() {
    const keys = repo.publishing?.queued ?? [];
    const sheet = teamValuesSheet(keys, repo.values, repo.repositoryValues, repo.publishing?.cantWrite?.repository ?? "this repository");
    if (!(await confirmSheet(sheet))) return;
    try {
      const used = await workspaceUseTeamValues(workspaceId);
      const open = leftOpenLine(used.leftOpen);
      pushToast({ kind: "info", ...teamValuesToast(used.dropped), ...(open ? { details: open } : {}) });
    } catch (e) {
      pushToast({ kind: "warn", title: "Couldn't use the team's values", body: "Nothing changed on this Mac. Details has the reason.", details: String((e as Error)?.message ?? e) });
    }
    await repo.reload();
  }

  const footnote = sub ? null : footerLine;
  // Publishing the first build setting of a repository that shares none
  // brings the rest of this Mac's with it (F25).
  const firstShare = firstSharedProjectNote(repo.sharedProject, repo.values, list);
  // GH #107 (review 2, F2): every row here is the definition Ply has read, so a
  // search that landed on one says nothing until the read has landed.
  usePageReading(repo.loading || afterReading);

  // Until the first read lands there is nothing true to show: the rows
  // would be a page of defaults reading as this repository's settings. A
  // read that failed says so, and offers the one step that fixes it.
  // 1.174.0 (DS1): one tree for both states, so a part drawn under the rows
  // (`after`: General's Board) keeps its place, and its state, when the read
  // lands.
  const loading = repo.loading;

  return (
    <>
      <Page footer={flowUp || loading ? undefined : footer}>
        {!flowUp && (
          <PageHeader
            scope={scope}
            title={loading ? title : (page?.title ?? title)}
            lede={loading ? lede : (page?.lede ?? lede)}
            status={
              loading ? (
                repo.error ? undefined : (
                  <StatusLine state="running">Reading this repository's settings…</StatusLine>
                )
              ) : sub ? undefined : (
                <>
                  {hiddenNote && <StatusLine state="empty">{hiddenNote}</StatusLine>}
                  <RepositoryStatus repo={repo} />
                </>
              )
            }
            back={!loading && page ? { label: page.back, onClick: () => setSub(null) } : undefined}
          />
        )}
        {/* QoL 1.168 block 8 (A5): the first read failed — the error shape,
            the raw text behind Details, as the loaded page draws it. */}
        {!flowUp && loading && repo.error && (
          <ErrorBlock
            error={pageError(firstReadProblem(repo.error), {
              id: "reload",
              label: "Read again",
              primary: true,
            })}
            onAction={() => void repo.reload()}
          />
        )}
        {/* GH #102's one `ErrorBlock` draws both: the page builds the
            `UxError`, because what a way out does is the page's. */}
        {!flowUp && !loading && repo.error && (
          <ErrorBlock
            error={pageError(readAgainProblem(repo.error), {
              id: "reload",
              label: "Read again",
              primary: true,
            })}
            onAction={() => void repo.reload()}
          />
        )}
        {!flowUp && !loading && failure && (
          <ErrorBlock
            error={pageError(failure, { id: "aside", label: "Put this aside", primary: true })}
            onAction={() => setFailure(null)}
          />
        )}
        {/* DS5 round 1: the rows stay mounted while a part's flow is up, so
            what is being typed in one (General's Name) is there after Cancel. */}
        {!loading && <div hidden={flowUp}>{children(ctx)}</div>}
        {(loading || !sub) && after}
        {!flowUp && !loading && !sub && below?.(ctx)}
        {!flowUp && !loading && !sub && danger?.(ctx)}
        {!flowUp && !loading && footnote && <Footnote>{footnote}</Footnote>}
      </Page>
      {!loading && reviewing && (
        <Sheet
          title={reviewTitle(list.length)}
          lede={
            <>
              {machineWords(reviewLede(target))}
              {firstShare && <> {machineWords(firstShare)}</>}
            </>
          }
          onClose={() => setReviewing(false)}
          footNote={`One commit · ${detailPath}`}
          actions={
            <>
              <CBtn tone="strong" onClick={() => setReviewing(false)}>
                Back
              </CBtn>
              <CBtn
                tone="accent"
                disabled={busy || !!repo.error}
                onClick={() => void publish()}
              >
                Publish to {target}
              </CBtn>
            </>
          }
        >
          {list.map((c) => {
            // C3 (SC-3): the repository changed this field while it was
            // drafted here — said on its line; Publish asks which to keep.
            const moved = reviewMovedNote(
              c.key,
              repo.values,
              { bases: session.bases, author: repo.author, changedAt: repo.changedAt },
              Date.now() / 1000,
            );
            return (
              <SheetChange
                key={c.key}
                label={c.label}
                from={c.fromDetail}
                to={c.toDetail}
                consequence={moved ? <>{c.consequence} {moved}</> : c.consequence}
              />
            );
          })}
          <Details summary="Details">
            {target} · {detailPath}
            {commitMessage(list).map((line) => (
              <span key={line} className="ux-details-line">
                {line}
              </span>
            ))}
          </Details>
        </Sheet>
      )}
      {!loading && leaving && (
        <LeaveSheet
          list={list}
          note={firstShare}
          branch={repo.branch}
          canDiscard={writing === 0 && discardable(session)}
          canPublish={!busy && !repo.error}
          onDiscard={() => {
            const go = leaving.proceed;
            // Refused while the save is out: it would drop what that save
            // is still carrying (F1). The button is disabled too.
            if (!dispatch({ kind: "discard" })) return;
            setLeaving(null);
            go();
          }}
          onStay={() => setLeaving(null)}
          onPublish={() => {
            const asked = leaving;
            // A publish that failed leaves the question standing: the toast
            // says why, and the three ways out are still there.
            void publish().then((ok) => {
              if (!ok) return;
              // `Stay` while it was in flight answered the question
              // already; nothing navigates behind that answer.
              if (leavingNow.current !== asked) return;
              setLeaving(null);
              asked.proceed();
            });
          }}
        />
      )}
    </>
  );
}

/** BOARDS.md §6: `Discard` alone on the left, `Stay` and `Publish` on the
 *  right — the destructive way out sits away from the two safe ones. */
function LeaveSheet({
  list,
  note,
  branch,
  canDiscard,
  canPublish,
  onDiscard,
  onStay,
  onPublish,
}: {
  list: Change[];
  note: string | null;
  branch: string;
  /** The save is done, so dropping what was never sent is the person's
   *  call — and their way out when a read keeps failing. */
  canDiscard: boolean;
  canPublish: boolean;
  onDiscard: () => void;
  onStay: () => void;
  onPublish: () => void;
}) {
  // G2 Windows walk: the safe choice has the focus, never the dialog.
  const stayRef = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      size="confirm"
      title={leaveQuestion(list.length)}
      initialFocusRef={stayRef}
      lede={
        <>
          {leaveBody(list)}
          {note && <> {machineWords(note)}</>}
        </>
      }
      onClose={onStay}
      leadAction={
        <CBtn tone="quiet" disabled={!canDiscard} onClick={onDiscard}>
          Discard
        </CBtn>
      }
      actions={
        <>
          {/* Always a way out: it changes nothing. */}
          <CBtn ref={stayRef} tone="strong" onClick={onStay}>
            Stay
          </CBtn>
          <CBtn tone="accent" disabled={!canPublish} onClick={onPublish}>
            Publish to {branch}
          </CBtn>
        </>
      }
    >
      {list.map((c) => (
        <SheetChange key={c.key} label={c.label} from={c.fromDetail} to={c.toDetail} />
      ))}
    </Sheet>
  );
}

function RepositoryStatus({ repo }: { repo: RepositoryState }) {
  const view = statusLine(
    {
      branch: repo.branch,
      author: repo.author,
      changedAt: repo.changedAt,
      readOnly: repo.readOnly,
      repository: repo.repository,
      offline: repo.publishing?.offline ?? false,
      branchMissing: isBranchMissing(repo.publishing),
      trouble: repo.publishing?.trouble ?? null,
      local: !repo.shared,
      removedFrom: repo.removedFrom,
      unreadable: repo.unreadable,
      sharingWaits: repo.sharingWaits,
    },
    Date.now() / 1000,
  );
  if (view.kind === "readOnly" || view.kind === "local") {
    return <StatusLine state="empty">{view.text}</StatusLine>;
  }
  if (view.kind === "branchMissing") {
    return (
      <StatusLine state={view.state}>
        <span className="ux-mono-fg">{view.branch}</span>
        {view.tail}
      </StatusLine>
    );
  }
  return (
    <StatusLine state={view.state}>
      {/* 1.174.0 (DS1, D6): the line says which rows it is about — each
          section says where its own rows are kept. */}
      Rows shared with the project come from <span className="ux-mono-fg">{view.branch}</span>
      {view.tail}
    </StatusLine>
  );
}

