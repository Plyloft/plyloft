import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  knowledgeProjectState,
  libraryInstructionsView,
  librarySetUpInstructions,
  onSharedLibraryEdited,
  onWorkspaceDefinitionRefreshed,
  personalInstructionRead,
  personalInstructionReveal,
  workspaceDefinitionOpenPullRequest,
  type InstructionFlowPlan,
  type InstructionsView,
} from "../../ipc";
import type { LibraryStateLike } from "../../lib/sharedLibrary";
import { LatestRequest } from "../../lib/latestRequest";
import { useEditor } from "../../store/editorStore";
import {
  instructionFileMode,
  readOnlyLine,
  type FileOpenMode,
  type ReadOnlyInstructionCopy,
} from "../../lib/readOnlyFile";
import { useLibrary } from "../../store/libraryStore";
import { openCenterMode } from "../../store/uiStore";
import { pushToast } from "../../store/toastStore";
import { platformWord } from "../../lib/platform";
import { ASK_BUILDER, bringBranchPrompt } from "../../lib/askBuilder";
import { useWorkspaces } from "../../store/workspaceStore";
import { askTheBuilder } from "./askTheBuilder";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 6 (GH #101): everything the Instructions page reads and does,
 * for one workspace.
 *
 * Two reads, because two things are true at once: what the instruction files say
 * (the doctor, over the branch's mirror or the checkout) and what the shared
 * channel is doing about them (the queue, a pull request, offline). They are
 * refetched on the same two events `useSkillsData` listens to — a local queue
 * edit and a refresh that brought a teammate's change — so a page left open never
 * shows a state that has passed.
 *
 * Only the newest request may paint (`LatestRequest`): a view builds the mirror
 * and may fetch, so an answer about a previous workspace can land after a switch.
 * And only while the Library is the workspace's visible mode, for the reason the
 * Skills page loads that way: eight hidden hosts each reading on every refresh
 * would be eight reads nobody is looking at.
 */
export interface InstructionsData {
  view: InstructionsView | null;
  library: LibraryStateLike | null;
  loading: boolean;
  /** A step or an action of this page is running. */
  busy: boolean;
  reload: () => void;
  openInCode: (path: string) => Promise<void>;
  /**
   * The same press for a copy Code may only read, and never write.
   *
   * - `branch` (GH #142): a copy only the branch has. The path is the mirror's,
   *   produced by Rust (`InstructionFileRow.readOnlyPath`) — Ply rebuilds that
   *   file from the branch on every refresh.
   * - `this-mac` (GH #174): the member's own `~/.claude/CLAUDE.md` or
   *   `~/.codex/AGENTS.md`. The path is the one Rust listed
   *   (`PersonalInstructionFile.path`), and its bytes come from
   *   `personal_instruction_read`, which judges that path with
   *   `listed_instruction_file` before it reads.
   *
   * Either way the tab cannot be saved: `instructionFileMode` answers read-only
   * for both, and a `checkout` copy is not a thing this press can be asked for.
   */
  openReadOnly: (path: string, copy: ReadOnlyInstructionCopy) => Promise<void>;
  setUp: (plan: InstructionFlowPlan) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  openPullRequest: (number: number) => Promise<void>;
}

/** A refusal in words this page wrote, shown as the toast's line (GH #297). */
class Refusal extends Error {}

export function useInstructionsData(
  workspaceId: string,
  active: boolean,
): InstructionsData {
  const [view, setView] = useState<InstructionsView | null>(null);
  const [library, setLibrary] = useState<LibraryStateLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const request = useRef(new LatestRequest());

  /**
   * The two reads, each painting **as it lands** (GH #160).
   *
   * They are not one answer: `library_instructions_view` waits for the workspace
   * lock — which the publish a press has just started holds for as long as a
   * fetch, a push and maybe a `gh pr create` take — and the queue state, which is
   * what the row's transient sentence is read from, waits for nothing. Held
   * together, the row sat on its pre-press sentence for the whole drain, which is
   * what the member reported as "the row does not refresh".
   */
  const load = useCallback(async () => {
    const ticket = request.current.begin();
    setLoading(true);
    const instructions = libraryInstructionsView(workspaceId).then(
      (value) => {
        if (request.current.isCurrent(ticket)) setView(value);
      },
      (reason) => {
        if (!request.current.isCurrent(ticket)) return;
        pushErrorToast("Couldn't read this repository's instructions", reason);
      },
    );
    const shared = knowledgeProjectState(workspaceId).then(
      (value) => {
        if (request.current.isCurrent(ticket)) setLibrary(value);
      },
      // A workspace that shares nothing is ordinary, and not worth a toast.
      () => {
        if (request.current.isCurrent(ticket)) setLibrary(null);
      },
    );
    await Promise.all([instructions, shared]);
    // Only the newest request may say the page has settled: a retired one used to
    // return above this and leave `loading` true for good.
    if (request.current.isCurrent(ticket)) setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!active) return;
    void load();
    const offEdited = onSharedLibraryEdited((id) => {
      if (id === workspaceId) void load();
    });
    const offRefreshed = onWorkspaceDefinitionRefreshed((report) => {
      if (report.workspaceId === workspaceId) void load();
    });
    return () => {
      request.current.retireAll();
      void offEdited.then((off) => off());
      void offRefreshed.then((off) => off());
    };
  }, [workspaceId, load, active]);

  /** This page's own reload — what the page offers and what a write here ends in. */
  const reload = useCallback(() => void load(), [load]);

  const run = useCallback(
    async (what: string, work: () => Promise<void>) => {
      setBusy(true);
      try {
        await work();
      } catch (cause) {
        // GH #297: a refusal this page words itself is the line; anything
        // else is raw, behind Details, and the title says what failed.
        pushToast(
          cause instanceof Refusal
            ? { kind: "error", title: what, body: cause.message }
            : { kind: "error", title: what, details: String((cause as Error)?.message ?? cause) },
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /**
   * Hand one file to Code, as `mode` says. `mode` is `instructionFileMode`'s,
   * never a flag worked out here: the checkout's copy is the only writable one,
   * and the branch's copy and a personal file open as reading views, with the
   * line that says where they live (GH #142, GH #174).
   */
  const showInCode = useCallback(
    (path: string, content: string, mode: FileOpenMode, branch: string | null) => {
      const opened = useEditor
        .getState()
        .open(
          workspaceId,
          path,
          content,
          mode.readOnly
            ? { place: mode.place, line: readOnlyLine(mode.place, branch, "instructions") }
            : null,
        );
      openCenterMode(workspaceId, "code");
      // GH #174 review 1: a dirty writable tab of this path was brought forward
      // instead; `run` turns this into the toast that says why.
      if (!opened.opened) throw new Refusal(opened.reason);
    },
    [workspaceId],
  );

  /**
   * The one step. The backend decides where it writes — the shared channel, or
   * the checkout when there is no shared definition — and says which it did, so
   * the toast can tell the truth about what happens next.
   *
   * The flow closes either way, and the press **ends in this page's own reload**
   * — the rule every write on the Skills page keeps — because a shared publish's
   * library event and a checkout write's silence are both things the row's
   * sentence has to be read again after.
   *
   * GH #160: not awaited. The publish this just queued is draining on its own
   * thread and holds the workspace lock, so awaiting the read that queues behind
   * it held the toast back and kept `Set up` greyed out for the whole drain. The
   * reload paints when it lands, and the drain's own refresh reloads again with
   * the outcome — the pull request the change waits in, or the shared state.
   *
   * It is **not** the `library-edited` listener's reload said twice (review 1,
   * NIT): that event is emitted only by `app_library_change`, so the checkout
   * path — `published === false`, where `instruction_files::apply` writes the
   * working tree and emits nothing — has this reload and nothing else. On the
   * shared path the two do overlap, and `LatestRequest` retires the older ticket,
   * so the page paints once either way.
   */
  const setUp = useCallback(
    (plan: InstructionFlowPlan) =>
      run("Couldn't set up the instructions", async () => {
        const published = await librarySetUpInstructions(workspaceId, plan);
        const cwd = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.cwd ?? null;
        useLibrary.getState().setFlow(workspaceId, null);
        reload();
        pushToast({
          kind: "info",
          title: published
            ? "Publishing the instructions"
            : "Instructions written in your project folder",
          // GH #101 review 1 (MAJOR): a Sync does not bring the branch's
          // AGENTS.md into a checkout — nothing does but a pull. The toast says
          // what the member has to do for the agents **here** to read it.
          // QoL 13.2 (D4): the way to bring the branch here is the Builder.
          body: published
            ? `Both files go onto the integration branch in one commit. Your project folder is untouched — ${ASK_BUILDER} to bring the branch here so the agents here read them too.`
            : "AGENTS.md and CLAUDE.md are changed in your project folder. Nothing reaches anyone until you commit it.",
          ...(published && cwd
            ? { action: { label: ASK_BUILDER, onClick: () => askTheBuilder(workspaceId, cwd, bringBranchPrompt(null, "AGENTS.md and CLAUDE.md")) } }
            : {}),
        });
      }),
    [run, workspaceId, reload],
  );

  return {
    view,
    library,
    loading,
    busy,
    reload,
    openInCode: (path) =>
      run("Couldn't open the file in Code", async () => {
        const content = await invoke<string>("fs_read_text_file", { path });
        showInCode(path, content, instructionFileMode("checkout"), null);
      }),
    openReadOnly: (path, copy) =>
      run("Couldn't open the file in Code", async () => {
        const mode = instructionFileMode(copy);
        // The type already keeps `checkout` out; this keeps it out at runtime
        // too, so no caller can reach a writable tab through this press.
        if (!mode.readOnly) throw new Refusal("Only a read-only copy opens here.");
        // A personal file is read by Rust through its guard, never by a
        // general-purpose read of a path the window holds (GH #174).
        const content =
          copy === "this-mac"
            ? await personalInstructionRead(path)
            : await invoke<string>("fs_read_text_file", { path });
        showInCode(path, content, mode, view?.branch ?? null);
      }),
    setUp,
    reveal: (path) =>
      run(`Couldn't show the file in ${platformWord("fileManager")}`, () => personalInstructionReveal(path)),
    openPullRequest: (number) =>
      run(`Couldn't open pull request #${number}`, () =>
        workspaceDefinitionOpenPullRequest(workspaceId, number),
      ),
  };
}
