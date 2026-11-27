import { useEffect, useState, type ReactNode } from "react";
import { CBtn, Group, Row, Section, StatusLine, TextField, useReveal } from "../ux";
import { useSettingsFlow } from "../../store/settingsFlowStore";
import { SettingsPage } from "./rows";
import { useWorkspaces } from "../../store/workspaceStore";
import { useKanban } from "../../store/kanbanStore";
import { useAccount, useTeamAllowed } from "../../store/accountStore";
import { openPlanSettings } from "../../store/planPrompts";
import { pushToast } from "../../store/toastStore";
import { confirmSheet } from "../../store/confirmStore";
import {
  kanbanGithubPushLocal,
  workspaceAdoptionStatus,
  workspaceSetKanbanSyncMode,
} from "../../ipc";
import { askForStatusAgain, readDefinition, withinDefinitionHold } from "../../store/definitionReadStore";
import type { Scope } from "../../lib/settingsNav";
import {
  boardSetByRepositoryLine,
  keptLocalRow,
  showKanbanBacking,
  SOLO_REPO_BOARD,
  SOLO_REPO_BOARD_TEAM,
  type AdoptionStatus,
} from "../../lib/adoption";
import { WORK_WITH_A_TEAM } from "../../lib/settingsNav";
import { useUi } from "../../store/uiStore";
import { machineWords } from "../../lib/platform";
import { moveKeptBoard } from "../AdoptionBanner";
import { useSolo } from "../../store/workModeStore";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 8 (GH #103): where this workspace's cards come from, on the
 * `ux` layer. Since C9 (UX-9.3) it is the first part of This repository ›
 * Board and worktrees.
 *
 * When the repository sets the board, the part says so in one line and draws
 * no rows — This repository › General says where the cards come from. (Before
 * C9 the whole entry was hidden, which left a link to it landing elsewhere.)
 *
 * `Back the board with GitHub Issues` is a Procedure row: it states the
 * condition, and its one step asks for the repository and then offers to carry
 * the cards over. Switching back to Local has no confirmation on purpose — it
 * is the way out that loses nothing, and every card stays where it is.
 */
export function BoardPage({
  scope,
  hiddenNote,
  workspaceId,
  setByRepository = false,
  adoption = null,
  reading = false,
}: {
  scope: Scope;
  hiddenNote?: string | null;
  workspaceId: string;
  /** The repository's shared definition sets the board. */
  setByRepository?: boolean;
  /** OB-8 review 2: the workspace's adoption status, for the row that moves a
   *  board kept on this Mac after all — or, R14, a board the repository's
   *  definition says is Local, which the board banner never offers to move. */
  adoption?: AdoptionStatus | null;
  /** Two-account walk: where the cards live is being read. Until the first
   *  answer the page says nothing about it; after that it keeps the last
   *  answer, and holds the moves that answer offers. */
  reading?: boolean;
}) {
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId));
  const refresh = useWorkspaces((s) => s.refresh);
  const reconcileGithub = useKanban((s) => s.reconcileGithub);
  const licensed = useTeamAllowed();
  // Launch G3: the team gate's own words (no Team plan, another team,
  // another account) for the lapse degrade.
  const teamRefusal = useAccount((s) => s.gates?.teamRefusal ?? null);
  const teamAccess = useAccount((s) => s.gates?.team?.state ?? null);
  const flow = useSettingsFlow((s) => s.flow);
  const openFlow = useSettingsFlow((s) => s.open);
  const closeFlow = useSettingsFlow((s) => s.close);
  const [repo, setRepo] = useState(ws?.githubOwnerRepo ?? "");
  const [busy, setBusy] = useState(false);
  /** The press on a move is reading the definition before it asks. */
  const [checking, setChecking] = useState(false);
  const asking = flow === "board-repo";
  // No answer yet: not "on this Mac" and not "Choose a repository", which is
  // what a project sharing its board read like for its first seconds.
  const unread = reading && !adoption;
  // F6: the flow takes the page's place — shown from its top; its Repository
  // field keeps the focus (autoFocus).
  const flowRef = useReveal<HTMLDivElement>(asking, { block: "start", focus: false });
  // OB-8 review 2: the free beta's offer was answered "Keep it on this Mac".
  // Said here, with the one press that moves it after all.
  // §10 row 4: solo mode shows only Local. A board already on GitHub Issues
  // makes the Mac team (`team::effective_work_mode`), so it never reads solo.
  const solo = useSolo();
  // R14: a repository's Local board is moved only while it is Local here.
  const movable = (answer: AdoptionStatus | null, board: string | undefined) => {
    const row = solo ? null : keptLocalRow(answer, licensed);
    return row?.confirm && board === "githubIssues" ? null : row;
  };
  const kept = movable(adoption, ws?.kanbanSyncMode);
  const cardsIn = (answer: AdoptionStatus | null) =>
    answer?.action.kind === "boardKeptLocal" ? answer.action.localCards : 0;
  // Two-account walk: the moves wait for a read. Not `disabled`, so a button with
  // the focus keeps it.
  const held = reading || checking;
  // 1.172.0 (B1): solo mode, and the repository's shared setup puts the
  // board on GitHub Issues — it stays local here. Said instead of "This
  // repository sets its board, so it is the same for everyone", which is
  // not true on this Mac while it works alone.
  const soloHeld =
    solo && adoption?.repoBoard === "githubIssues" && ws?.kanbanSyncMode !== "githubIssues";

  /** Two-account walk: what is on screen may be the last read's, so every move
   *  reads first and acts on what that finds. `null`: no answer landed in time,
   *  and the answer on screen stands. */
  async function readFirst() {
    setChecking(true);
    try {
      const answer = await withinDefinitionHold(
        readDefinition(workspaceId).then(() => workspaceAdoptionStatus(workspaceId, false)),
      );
      if (!answer) return null;
      await refresh().catch(() => {});
      const board = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.kanbanSyncMode;
      return { answer, board };
    } finally {
      setChecking(false);
    }
  }

  async function moveKept() {
    if (!kept || held) return;
    let now = kept;
    let cards = cardsIn(adoption);
    const read = await readFirst();
    if (read) {
      // Moved already: there is nothing to ask, and the page catches up.
      const row = movable(read.answer, read.board);
      if (!row) {
        askForStatusAgain(workspaceId);
        return;
      }
      now = row;
      cards = cardsIn(read.answer);
    }
    // R14: moving a board the repository says is Local is published for
    // everyone; it says so before anything runs.
    if (now.confirm && !(await confirmSheet(now.confirm))) return;
    setBusy(true);
    try {
      await moveKeptBoard(workspaceId, now.repo, now.cardsOnly, cards);
      await refresh();
    } catch (e) {
      pushErrorToast("Couldn't move the board to GitHub Issues", e);
    } finally {
      setBusy(false);
    }
  }

  const keptMove = kept ? (
    <CBtn
      tone="strong"
      disabled={busy}
      aria-disabled={held || undefined}
      aria-busy={held || undefined}
      onClick={() => void moveKept()}
    >
      {busy ? "Moving…" : held ? "Reading…" : kept.move}
    </CBtn>
  ) : null;
  // R14: the repository's board is Local (`kept.confirm`), or this Mac kept
  // its board here (OB-8 review 2).
  const keptRow = !kept ? null : kept.confirm ? (
    <Row kind="procedure" label="Local board" hint={kept.hint} action={keptMove} />
  ) : (
    <Row kind="procedure" label="Kept on this Mac" hint={kept.hint} action={keptMove} />
  );

  // 1.174.0 (DS5, scene 8): the board is one of General's sections, "Where
  // the cards live", whose first row says where they are. Its mark: shared
  // with the project where the repository sets the board; a GitHub Issues
  // board this Mac chose is a project row not shared yet; a local board is
  // this Mac's.
  const ghBacked = ws?.kanbanSyncMode === "githubIssues";
  const repoSets = setByRepository && !soloHeld;
  // A late read found the board has moved while the repository question was up:
  // the question is over, and the flow takes the navigation away, so it goes.
  useEffect(() => {
    if (asking && !busy && (repoSets || ws?.kanbanSyncMode === "githubIssues")) closeFlow();
  }, [asking, busy, repoSets, ws?.kanbanSyncMode, closeFlow]);
  const ghRepo = ws?.githubOwnerRepo?.trim() || "";
  /** The Board row; on GitHub Issues its one action moves it back. */
  const boardRow = (action?: ReactNode) => (
    <Row
      kind={action ? "procedure" : "value"}
      label="Board"
      hint={
        ghBacked
          ? `On GitHub Issues${ghRepo ? ` · ${ghRepo}` : ""}. Everyone who opens this project sees the same cards.`
          : unread
            ? "Reading…"
            : machineWords("The cards live on this Mac. Nobody else sees them.")
      }
      action={action}
    />
  );
  const where = (rows: ReactNode) =>
    // scope: none — nothing read yet, the mark waits for the first answer
    unread ? (
      <Section title="Where the cards live">
        <Group label="Where the cards live">{rows}</Group>
      </Section>
    ) : repoSets ? (
      <Section title="Where the cards live" scope="repository" shared>
        <Group label="Where the cards live">{rows}</Group>
      </Section>
    ) : ghBacked ? (
      <Section title="Where the cards live" scope="repository" shared={false}>
        <Group label="Where the cards live">{rows}</Group>
      </Section>
    ) : (
      <Section title="Where the cards live" scope="this-mac">
        <Group label="Where the cards live">{rows}</Group>
      </Section>
    );

  if (setByRepository && !soloHeld) {
    const setByRepoLine = boardSetByRepositoryLine(adoption?.repoBoard, ghBacked, teamAccess);
    return (
      <SettingsPage
        entry="board"
        scope={scope}
        hiddenNote={hiddenNote}
        untitled
        status={setByRepoLine ? <StatusLine state="empty">{machineWords(setByRepoLine)}</StatusLine> : undefined}
      >
        {where(
          <>
            {boardRow()}
            {keptRow}
          </>,
        )}
      </SettingsPage>
    );
  }
  if (!ws) {
    return (
      <SettingsPage entry="board" scope={scope} hiddenNote={hiddenNote}>
        <Group>
          <Row
            kind="value"
            label="No workspace is open"
            hint="Open one to see where its cards come from."
          />
        </Group>
      </SettingsPage>
    );
  }

  async function enable() {
    const trimmed = repo.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
      pushToast({
        kind: "warn",
        title: "That is not a repository",
        body: "Write it as owner/name, for example acme/widgets.",
      });
      return;
    }
    if (checking) return;
    const read = await readFirst();
    // Cancelled while it read, or the question is over: the board has moved, or
    // the repository now says Local, which has its own row and its own question.
    if (useSettingsFlow.getState().flow !== "board-repo") return;
    if (
      read &&
      (read.board === "githubIssues" ||
        // The test the page draws by: a switch that failed is still this press's.
        !showKanbanBacking(read.answer, licensed, false) ||
        movable(read.answer, read.board))
    ) {
      askForStatusAgain(workspaceId);
      closeFlow();
      return;
    }
    setBusy(true);
    try {
      const localCount = await workspaceSetKanbanSyncMode(workspaceId, "githubIssues", trimmed);
      await refresh();
      closeFlow();
      if (
        localCount > 0 &&
        (await confirmSheet({
          title: `Push ${localCount} existing local ${
            localCount === 1 ? "card" : "cards"
          } to GitHub as issues?`,
          body: "Each becomes an issue in the repository; the cards stay on the board.",
          confirmLabel: "Push",
        }))
      ) {
        const summary = await kanbanGithubPushLocal(workspaceId);
        pushToast({
          kind: summary.failed > 0 ? "warn" : "info",
          title: "Pushed to GitHub",
          body: `${summary.pushed} created${
            summary.failed > 0 ? `, ${summary.failed} failed` : ""
          }.`,
        });
      }
      await reconcileGithub(workspaceId);
    } catch (e) {
      pushErrorToast("Couldn't move the board to GitHub Issues", e);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (held) return;
    const read = await readFirst();
    // Back here already, or the repository sets the board now.
    if (read && (read.board !== "githubIssues" || !showKanbanBacking(read.answer, licensed, true))) {
      askForStatusAgain(workspaceId);
      return;
    }
    setBusy(true);
    try {
      await workspaceSetKanbanSyncMode(workspaceId, "local", null);
      await refresh();
    } catch (e) {
      pushToast({
        kind: "error",
        title: "Couldn't move the board back to this Mac",
        details: String((e as Error)?.message ?? e),
      });
    } finally {
      setBusy(false);
    }
  }

  // The question is a flow: a focused surface with no navigation beside it, one
  // confirming action, and Esc to abandon it. Nothing here runs on blur —
  // moving a board to GitHub Issues creates labels on somebody's repository and
  // cannot be undone, so it takes a press (review 1, BLOCKER).
  if (asking) {
    return (
      <SettingsPage entry="board" scope={scope} hiddenNote={hiddenNote}>
        <div className="ux-flow" ref={flowRef}>
          <p className="ux-flow-eyebrow">Set up · 1 step</p>
          <h2 className="ux-flow-title">Which repository holds the cards?</h2>
          <p className="ux-page-lede">
            The cards become issues in this repository, so everyone who can open it works the same
            board. Plyloft makes the status labels it needs, then offers to carry the cards you already
            have over as issues — it never deletes anything.
          </p>
          <Group>
            <Row
              kind="text"
              label="Repository"
              hint="Write it as owner/name, for example acme/widgets."
            >
              <TextField
                value={repo}
                onChange={setRepo}
                onEnter={() => void enable()}
                onCancel={() => closeFlow()}
                placeholder="owner/name"
                label="Repository"
                mono
                wide
                autoFocus
                disabled={busy}
              />
            </Row>
          </Group>
          <StatusLine state="empty">
            Nothing happens on GitHub until you press Use it.
          </StatusLine>
          <div className="ux-flow-actions">
            <CBtn disabled={busy} onClick={() => closeFlow()}>
              Cancel
            </CBtn>
            <CBtn tone="accent" disabled={busy || checking || !repo.trim()} onClick={() => void enable()}>
              {busy ? "Moving…" : checking ? "Reading…" : "Use it"}
            </CBtn>
          </div>
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      entry="board"
      scope={scope}
      hiddenNote={hiddenNote}
      untitled
      status={
        // What the Board row says is not repeated here: only what needs
        // the person (the lapse, solo mode's team feature).
        ghBacked ? (
          licensed ? null : (
            // v1.85.0: the lapse degrade. Sync is paused in the backend, and
            // moving back to Local is the always-available way out that loses
            // nothing.
            <StatusLine state="aborted">
              {teamRefusal ?? "Team features are off on this Mac."} The board is read-only and
              nothing is syncing. Move the board back to this Mac to keep working — the cards stay,
              and GitHub is left alone.
            </StatusLine>
          )
        ) : soloHeld ? (
          <StatusLine state="empty">{machineWords(SOLO_REPO_BOARD)}</StatusLine>
        ) : solo ? (
          <StatusLine state="empty">
            A board on GitHub Issues is a team feature. Turn on Work with a team under Setup and
            account › Setup to use one.
          </StatusLine>
        ) : null
      }
    >
      {where(
        <>
          {/* Scene 8: on GitHub Issues, one row — the board and the way
              back to this Mac. */}
          {boardRow(
            ghBacked ? (
              <CBtn
                disabled={busy}
                aria-disabled={held || undefined}
                aria-busy={held || undefined}
                onClick={() => void disable()}
              >
                {busy ? "Moving…" : held ? "Reading…" : machineWords("Move the board back to this Mac")}
              </CBtn>
            ) : undefined,
          )}
          {soloHeld && (
            <Row
              kind="procedure"
              label={SOLO_REPO_BOARD_TEAM}
              hint="With Work with a team on, Plyloft offers to move this board to the repository's GitHub Issues."
              action={
                <CBtn
                  tone="strong"
                  onClick={() =>
                    useUi.getState().openSettingsSection("setup", { row: WORK_WITH_A_TEAM })
                  }
                >
                  Open Setup
                </CBtn>
              }
            />
          )}
          {unread || solo || ghBacked ? null : keptRow ? (
            keptRow
          ) : !licensed ? (
            <Row
              kind="procedure"
              label="Back the board with GitHub Issues"
              hint="A Team plan feature: the cards become issues in a repository, so a team works the same board."
              action={
                <CBtn tone="strong" onClick={openPlanSettings}>
                  See your plan
                </CBtn>
              }
            />
          ) : (
            <Row
              kind="procedure"
              label="Back the board with GitHub Issues"
              hint="The cards become issues in a repository, so everyone who can open it works the same board."
              action={
                <CBtn
                  tone="strong"
                  aria-disabled={held || undefined}
                  aria-busy={held || undefined}
                  onClick={() => {
                    if (!held) openFlow("board-repo");
                  }}
                >
                  {held ? "Reading…" : "Choose a repository"}
                </CBtn>
              }
            />
          )}
        </>,
      )}
    </SettingsPage>
  );
}
