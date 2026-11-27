import { useSkillsHub } from "../../store/skillsHubStore";
import { useWorkMode } from "../../store/workModeStore";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useTeamAllowed } from "../../store/accountStore";
import {
  COULD_NOT_LEAVE,
  LEAVE_LEDE_SEAT,
  LEAVE_LEDE_TODAY,
  holdsSeatHere,
  leaveRowHint,
  leaveSheetLists,
  leftToast,
  refusedWords,
  type LeftSeat,
} from "../../lib/teamLeave";
import { teamLeaveSeat } from "../../lib/teamLeaveIpc";
import { useSettings } from "../../store/settingsStore";
import { DEFAULT_PROJECTS_FOLDER } from "../../lib/settingsShape";
import { useWorkspaces } from "../../store/workspaceStore";
import { askForStatusAgain, readDefinition, type DefinitionReadOutcome } from "../../store/definitionReadStore";
import { useBoundedHold } from "../../hooks/useBoundedHold";
import { PROJECT_READ_FAILED_WORDS } from "../../lib/definitionRefresh";
import { pushToast } from "../../store/toastStore";
import { useSettingsFlow } from "../../store/settingsFlowStore";
import { useUi } from "../../store/uiStore";
import { useSetup } from "../../store/setupStore";
import {
  teamCreate,
  teamCreateDefaults,
  teamDiscover,
  teamDiscoveryClearIgnored,
  teamDiscoveryIgnore,
  teamInviteApply,
  teamWorkspaceListRemove,
  teamInvitePlan,
  teamLeave,
  teamMemberRemove,
  teamMemberStates,
  teamSeatFree,
  teamSeatGive,
  teamMemberIds,
  type MemberIds,
  teamLibraryReveal,
  teamLibraryMoveAside,
  teamLibraryRevealAside,
  teamLibraryUndoResolve,
  type ReapplyChoice,
  teamRefresh,
  teamStatus,
  teamWorkspaceAdd,
  teamWorkspaceListAdd,
  type CreateTeamDefaults,
  type Discovery,
  type InvitePlan,
  type Membership,
  type ReapplyReport,
  type TeamStatus,
} from "../../ipc";
import {
  MOVE_ASIDE_ACTION,
  PUBLISH_ACTION,
  REAPPLY_ACTION,
  REVEAL_ACTION,
  UNDO_ACTION,
  divergenceError,
  interruptionError,
  reapplyError,
  resolvedError,
} from "../../lib/teamLibraryRecovery";
import { TeamConflictChooser } from "./TeamConflictChooser";
import { runTeamLibraryReapply } from "../teamLibraryReapply";
import { LatestRequest } from "../../lib/latestRequest";
import { SKILL_VENDOR_LABEL, teamSkillsSummaryLabel } from "../../lib/teamSkills";
import {
  createTeamGate,
  discoverySummary,
  grantingSteps,
  READING_GITHUB_ACCOUNT,
  invitationNote,
  inviteOutcomeSummary,
  invitePlanSummary,
  inviteSendLabel,
  NO_ACCOUNT_CHIP,
  noAccountSteps,
  nothingToDo,
  isGithubLogin,
  isRepoSlug,
  memberStateChip,
  memberStateHint,
  removalClaimsNote,
  REMOVAL_UNFINISHED_HINT,
  removalLeftUnfinished,
  removalLede,
  removeOutcomeSummary,
  statesAfterRemoval,
  shortDay,
  suggestTeamRepo,
  unresolvedSteps,
  workspaceGivenNote,
  workspacesToGive,
  everyonesAccess,
  everyonesAccessSummary,
  everyonesAccessSent,
} from "../../lib/teamAdmin";
import { FINISH_TITLE } from "../../lib/teamBilling";
import { decodeHalfMadeTeam } from "../../lib/teamAdmin";
import { openLibraryPage } from "../../store/uiStore";
import { leavePage } from "../../lib/leaveGuard";
import {
  CBtn,
  ChoiceList,
  DangerZone,
  EmptyState,
  ErrorBlock,
  Group,
  MoreMenu,
  PChip,
  Row,
  RowValue,
  Section,
  Sheet,
  StatusLine,
  TextField,
  Toggle,
  usePageReading,
  revealElement,
  settleReveal,
  useReveal,
} from "../ux";
import { SettingsPage } from "./rows";
import { useCheckedField } from "./CheckedField";
import type { Scope } from "../../lib/settingsNav";
import { machineWords, platformWord } from "../../lib/platform";
import { CopyInviteRows } from "../setup/CopyInvite";
import {
  CLONE_AGAIN,
  CLONE_AGAIN_LOSES_COPIES,
  FOLDER_GONE_NOTE,
  FOLDER_NOT_REPOSITORY_NOTE,
  addedTitle,
  folderGone,
  folderNotRepository,
} from "../../lib/teamStep";
import { CreateTeamGate } from "../setup/TeamCheckout";
import { TeamPlanNotice } from "./TeamPlanNotice";
import { TeamLibraryNotices, TeamLibraryPullLine, TeamReadError } from "../TeamLibraryPull";
import { useTeamBilling } from "../../store/teamBillingStore";
import { teamStatesKey, useTeamMemberStates } from "../../store/teamMemberStatesStore";
import { ghTrouble } from "../../lib/ghTrouble";
import { inField } from "../../lib/dialogFocus";
import { GhTroubleStatus } from "../GhTroubleStatus";
import { relativeWhen } from "../../lib/proposals";
import {
  isSeatLimit,
  membersWithoutSeat,
  noFreeSeatFor,
  noFreeSeatWords,
  seatCountLabel,
  seatEvidence,
  seatsOutsideTheTeam,
  teamForThisMac,
} from "../../lib/teamBilling";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 8 (GH #103): Settings › Team & account › Team, on the `ux`
 * layer.
 *
 * A team **is** a private GitHub repository (ADR 0002): there is no Ply server,
 * so everything here is read out of three places that can each be absent — the
 * pasted key (which team), the local clone (who is in it, which workspaces) and
 * GitHub (may this account read it). The page shows only what it knows and
 * names the missing half when a member cannot get in.
 *
 * **Joining is a Procedure row with a flow** (PATTERNS.md §6): with no team, the
 * row says so and its one step opens a flow asking which way in — an invite
 * code, or creating a team here. The choice is a
 * `ChoiceList`, so it is one radio group with its own ids rather than two rows
 * that happen to be clickable.
 *
 * Launch G3: the team this Mac is in is `settings.team.teamRepo` (created or
 * joined here); team features run on the Team plan of the Plyloft account
 * (`accountStore`'s gates). Keys are retired: no path asks for one.
 *
 * The owner's half — members, invites, assisted discovery — is gated on exactly
 * the condition the backend gates on, so the page never offers a press that
 * could only be refused.
 */

const MEMBERSHIP_LABEL: Record<Membership, string> = {
  member: "Member",
  not_listed: "Not on the team's member list",
  no_repo_access: "No access to the team's repository",
  // Drawn as "Checking membership of <repo>…" or "… not checked" (F16c).
  unknown: "Checking…",
};

const MEMBERSHIP_STATE: Record<Membership, "done" | "aborted" | "empty"> = {
  member: "done",
  not_listed: "aborted",
  no_repo_access: "aborted",
  unknown: "empty",
};

function errorText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

export function TeamPage({
  scope,
  hiddenNote,
}: {
  scope: Scope;
  hiddenNote?: string | null;
}) {
  const licensed = useTeamAllowed();
  // Launch G3: creating a team needs the Team plan (T1 makes it pay first).
  const teamPlan = useAccount((s) => s.gates?.plan === "team");
  const cloneRoot = useSettings((s) => s.settings.team?.cloneRoot ?? null);
  // OB-12: with no clone root of its own the team clones into the projects
  // folder Setup chose, else its default ~/Projects (1.168.1; ~/code only
  // while team checkouts are already there — `team::effective_clone_root`,
  // which `status.cloneRoot` reports).
  const defaultRoot = useSettings((s) => s.settings.projects?.folder ?? DEFAULT_PROJECTS_FOLDER);
  const settingsTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  /** F16c: the GitHub account the team's reads run as (`settings.team.account`),
   *  when one is recorded: named while the membership is being checked and in
   *  the line when that account isn't signed in. */
  const teamAccount = useSettings((s) => s.settings.team?.account?.trim() || null);
  const reloadSettings = useSettings((s) => s.load);
  const updateSettings = useSettings((s) => s.update);
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  const flow = useSettingsFlow((s) => s.flow);
  const openFlow = useSettingsFlow((s) => s.open);
  const closeFlow = useSettingsFlow((s) => s.close);

  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Two-account walk: Read it again also reads the open project's definition. */
  const activeWorkspaceId = useWorkspaces((s) => s.activeId);
  const [readingProject, setReadingProject] = useState(false);
  /** How the last press's project read ended: "Read just now" claims only a read
   *  that reached the remote. `null`: no press yet. */
  const [projectRead, setProjectRead] = useState<DefinitionReadOutcome | null>(null);
  // A project read on a network that hangs gives the button back; it still
  // claims nothing until it lands.
  const holdingProject = useBoundedHold(readingProject);
  /** N14 walk F22: when the last read of the team from GitHub went through,
   *  for the quiet "Read just now" beside Read it again. `null` until one has,
   *  and again after one that failed — a failure says so on its own line. */
  const [readAt, setReadAt] = useState<number | null>(null);
  const [addingRepo, setAddingRepo] = useState<string | null>(null);
  // 1.176.1: read before it can stop a clone (`setting_check::read_folder`,
  // on save and when the page opens); its `~` is kept as typed, as
  // `team::clone_root` writes it out.
  const root = useCheckedField({
    kind: "folder",
    committed: cloneRoot ?? "",
    commit: (value) => setCloneRoot(value),
    context: { keepsTilde: true },
  });
  // The commit is the setting's write, read first.
  const setCloneRootChecked = root.onCommit;
  /** GH #226: the last "Reapply mine on top" that left something to do, and
   *  whether one is running. */
  const [reapplied, setReapplied] = useState<ReapplyReport | null>(null);
  const [reapplying, setReapplying] = useState(false);
  /** QoL 13.3 (Challenger): the choices sent last, kept for a later round. */
  const [chosen, setChosen] = useState<Record<string, ReapplyChoice>>({});
  /** Team walk 2026-10-01 (F2): what the last Send invites or Remove from team
   *  did, said in Members. One line, so a newer result replaces an older one;
   *  it goes at the next action on the page or the next read from GitHub. */
  const [memberResult, setMemberResult] = useState<MemberResult | null>(null);
  /** N14 (items 1 and 9): counts the reads of the team from GitHub, so
   *  Members asks who has joined after each one (and not on local reads). */
  const [githubReads, setGithubReads] = useState(0);
  /** QoL 14.4 (G24): bumped to ask Members for Give everyone access. */
  const [everyoneAsk, setEveryoneAsk] = useState(0);
  /** QoL 14.4 (G25): the team workspace the Remove sheet is open for. */
  const [unlisting, setUnlisting] = useState<{ repo: string; name: string } | null>(null);
  const [unlistBusy, setUnlistBusy] = useState(false);

  // Onboarding §11.1: the team this Mac is in, as the backend reads it
  // (`team::current_team_repo`: the setting) once it has answered, and the
  // setting until then. Launch G3: a key never names it.
  const teamRepo = status?.teamRepo ?? settingsTeamRepo ?? null;
  // GH #107 (review 2, F2): the members, the proposals and the workspaces come
  // from a read of the team repository, so a search that landed on one of their
  // rows says nothing until that read has landed. Otherwise `Add somebody` looks
  // absent for as long as `gh` takes.
  usePageReading(status === null || syncing);

  /** Every request takes a ticket and only the newest may touch the page: a
   *  refresh takes a `gh repo clone` worth of time, so a reply about the team a
   *  *previous* key named could otherwise land last and repaint this with
   *  somebody else's team. */
  const request = useRef(new LatestRequest());
  /** Which read from GitHub the button is busy for. A local read takes a newer
   *  `request` ticket and retires that read's answer, but the read still ends. */
  const networkRead = useRef(new LatestRequest());
  /** The answer this page's last read from GitHub got, when it got one. A local
   *  read always calls its verdict stale (`team::status_after_sync`: it asked nobody),
   *  and the backend's gates rely on that. To the header, a write's local read
   *  with this same verdict is that answer, not a read that failed. */
  const freshAnswer = useRef<Pick<TeamStatus, "teamRepo" | "membership"> | null>(null);
  /** What the last read from GitHub couldn't do. A local read asks nobody, so it
   *  has no error of its own to replace this with: a pull that failed stays said
   *  (and Setup's close still reads again for it) until a read goes through. */
  const lastReadError = useRef<string | null>(null);

  // A verdict still stale after a read from GitHub didn't come from one: the
  // probe failed, or `team_refresh` answered from the clone (`skills_hub::team_pull`
  // when the pull is switched off or skipped). So no "Read just now", no re-read.
  const noteGithubRead = useCallback((read: TeamStatus) => {
    if (!read.membershipStale) setGithubReads((n) => n + 1);
    setReadAt(read.error || read.membershipStale ? null : Date.now());
  }, []);

  const load = useCallback(async (withNetwork: boolean) => {
    const ticket = request.current.begin();
    const current = () => request.current.isCurrent(ticket);
    const networkTicket = withNetwork ? networkRead.current.begin() : null;
    // Retired only by a local read: the team is the same and this is its newest
    // read from GitHub. Its status may predate the write, so that isn't applied;
    // that the read happened and how it ended count, and one more local read
    // shows what it brought to the clone and the verdict it left.
    const newestGithubRead = () => networkTicket !== null && networkRead.current.isCurrent(networkTicket);
    if (withNetwork) {
      setSyncing(true);
      setMemberResult(null);
    }
    try {
      const next = withNetwork ? await teamRefresh() : await teamStatus();
      // OB-9: a refresh can clone the team repo — a team signal.
      if (withNetwork) void useWorkMode.getState().refresh();
      // H4 Windows re-walk: a finished read re-reads the open Library page.
      if (withNetwork) useSkillsHub.getState().noteTeamRead();
      if (!current()) {
        if (newestGithubRead()) {
          freshAnswer.current = next.membershipStale ? null : next;
          lastReadError.current = next.error;
          noteGithubRead(next);
          void load(false);
        }
        return null;
      }
      if (withNetwork) {
        freshAnswer.current = next.membershipStale ? null : next;
        lastReadError.current = next.error;
      }
      const fresh = freshAnswer.current;
      setStatus(
        withNetwork
          ? next
          : {
              ...next,
              error: next.error ?? lastReadError.current,
              membershipStale:
                next.membershipStale && !(fresh?.teamRepo === next.teamRepo && fresh.membership === next.membership),
            },
      );
      if (withNetwork) noteGithubRead(next);
      return next;
    } catch (e) {
      if (!current() && !newestGithubRead()) return null;
      if (withNetwork) {
        freshAnswer.current = null;
        setReadAt(null);
        // What's on the page is now the last answer GitHub gave, and says so.
        setStatus((shown) => shown && { ...shown, membershipStale: true });
      }
      pushErrorToast("Couldn't read the team", e);
      return null;
    } finally {
      if (newestGithubRead()) setSyncing(false);
    }
  }, [noteGithubRead]);

  // The press. The team's read and the open project's, whose definition says
  // where its cards live: the answer on General comes from here, not the team.
  const readAgain = useCallback(async () => {
    setReadingProject(true);
    setProjectRead(null);
    try {
      const [, outcome] = await Promise.all([
        load(true),
        activeWorkspaceId ? readDefinition(activeWorkspaceId) : null,
      ]);
      setProjectRead(outcome);
      // A press: the status reads again even if the definition didn't move.
      if (activeWorkspaceId) askForStatusAgain(activeWorkspaceId);
    } finally {
      setReadingProject(false);
    }
  }, [load, activeWorkspaceId]);

  // Local read on open (instant), then one clone-or-pull plus membership
  // check. Re-runs when the key changes, which is exactly the join moment.
  useEffect(() => {
    void (async () => {
      const local = await load(false);
      if (!local?.teamRepo) return;
      await load(true);
    })();
    return () => {
      request.current.retireAll();
      networkRead.current.retireAll();
      freshAnswer.current = null;
      lastReadError.current = null;
      setSyncing(false);
      // F22: "Read just now" was about the team before; another one is
      // unread until its own read goes through.
      setReadAt(null);
    };
  }, [load, teamRepo]);

  // N14 walk F16: back from Setup (where gh may have been signed in), a page
  // that showed a GitHub sign-in trouble reads the team again.
  const setupOpen = useSetup((s) => s.open);
  const setupWasOpen = useRef(setupOpen);
  useEffect(() => {
    const closed = setupWasOpen.current && !setupOpen;
    setupWasOpen.current = setupOpen;
    if (closed && status?.teamRepo && ghTrouble(status.error, undefined, { account: teamAccount })) {
      void load(true);
    }
  }, [setupOpen, status, load, teamAccount]);

  // GH #226: what the member settles by hand in the clone (a collision, a
  // stray file, a rebase Ply didn't start) goes once a read of the clone finds
  // it at rest and in step. A push that is still owed keeps its block.
  useEffect(() => {
    const settled =
      reapplied &&
      ["collision", "stopped", "dirty", "foreign", "unrecovered"].includes(reapplied.result);
    if (status && settled && !status.libraryDivergence && !status.libraryInterruption) {
      setReapplied(null);
    }
    // QoL 13.3: choices put together and since published (or undone)
    // elsewhere — the clone no longer has them waiting.
    if (status && reapplied?.result === "resolved" && !status.libraryResolved) {
      setReapplied(null);
    }
  }, [status, reapplied]);

  async function setCloneRoot(next: string): Promise<boolean> {
    const value = next.trim() === "" ? null : next.trim();
    if (value === cloneRoot) return true;
    // Saved at once rather than kept as a draft: the picker below clones into
    // this path the moment it is pressed, so an unsaved value would clone
    // somewhere nobody had seen.
    try {
      await updateSettings((latest) => ({
        ...latest,
        team: { ...latest.team, cloneRoot: value },
      }));
      // Cleared, the root is the one the backend now works out (the projects
      // folder, or ~/code while team checkouts are there): say that one.
      const next = await load(false);
      pushToast({
        kind: "info",
        title: `Team workspaces will be cloned into ${value ?? next?.cloneRoot ?? status?.cloneRoot ?? defaultRoot} on this Mac.`,
      });
      return true;
    } catch (e) {
      pushErrorToast("Couldn't save where to clone", e);
      return false;
    }
  }

  async function pick(repo: string) {
    setMemberResult(null);
    setAddingRepo(repo);
    try {
      const added = await teamWorkspaceAdd(repo);
      await refreshWorkspaces();
      await load(false);
      pushToast({
        kind: "info",
        title: addedTitle(added),
        body: `${
          added.cloned
            ? `Cloned to ${added.path} and registered as a workspace.`
            : `Using the copy already at ${added.path}.`
        }${
          added.membershipFromCache
            ? " GitHub could not be reached — added on your last confirmed membership."
            : ""
        }`,
      });
    } catch (e) {
      pushErrorToast("Couldn't add the team workspace", e);
    } finally {
      setAddingRepo(null);
    }
  }

  /** GH #226: rebase this Mac's unpublished library changes onto GitHub's
   *  and publish them, then re-read the clone — the block goes when the
   *  clone is back in step, and a report that left something to do replaces
   *  it with its own. */
  async function reapply(choices?: Record<string, ReapplyChoice>) {
    setReapplying(true);
    try {
      const report = await runTeamLibraryReapply(choices);
      setReapplied(report && reapplyError(report) ? report : null);
      await load(false);
    } finally {
      setReapplying(false);
    }
  }

  /** QoL 13.3: Undo the choices put together on this computer (local). */
  async function undoResolved() {
    setReapplying(true);
    try {
      const said = await teamLibraryUndoResolve();
      pushToast({ kind: "info", title: "Undone", body: said });
      setReapplied(null);
    } catch (e) {
      pushErrorToast("Couldn't undo your choices", e, { then: "Nothing was published." });
    } finally {
      await load(false);
      setReapplying(false);
    }
  }

  /** QoL 13.3: Move the team clone's uncommitted edits aside (local). */
  async function moveAside() {
    setReapplying(true);
    try {
      const moved = await teamLibraryMoveAside();
      const n = moved.paths.length;
      pushToast({
        kind: "info",
        title: n === 1 ? "1 file moved aside" : `${n} files moved aside`,
        body: machineWords(
          "They're copied into a dated folder on this Mac, and the team library on this Mac is back to its last change. Press Reapply mine on top again.",
        ),
        details: moved.dir,
        action: {
          label: platformWord("showIn"),
          onClick: () =>
            void teamLibraryRevealAside().catch((e) =>
              pushErrorToast("Couldn't show the folder", e),
            ),
        },
      });
      setReapplied(null);
    } catch (e) {
      pushErrorToast("Couldn't move the files aside", e, { then: "Nothing was published." });
    } finally {
      await load(false);
      setReapplying(false);
    }
  }

  // ── No team on this Mac: one procedure, one flow ────────────────────────
  if (!teamRepo) {
    if (flow === "join-team") {
      return (
        <SettingsPage entry="team-workspaces" scope={scope} hiddenNote={hiddenNote}>
          <JoinFlow
            teamPlan={teamPlan}
            onCancel={closeFlow}
            onCreate={() => openFlow("create-team")}
            onInviteCode={() => {
              closeFlow();
              // Setup › Team holds the invite-code field and the Join sheet
              // that says what joining grants; Settings does not copy them.
              useSetup.getState().openSetup("rerun", "team", { teamPath: "join" });
            }}
          />
        </SettingsPage>
      );
    }
    if (flow === "create-team") {
      return (
        <SettingsPage entry="team-workspaces" scope={scope} hiddenNote={hiddenNote}>
          {/* Launch T1 (D17): seats and Checkout first; the form once paid. */}
          <CreateTeamGate onCancel={closeFlow}>
            {({ boundRepo }) => (
              <CreateTeamFlow
                boundRepo={boundRepo}
                onCancel={closeFlow}
                onCreated={() => {
                  // The backend has recorded the new team as this Mac's
                  // (`settings.team.teamRepo`); read both so every surface follows.
                  // F8 (team walk 2026-10-01): with the network, at once — a local
                  // read left the page on "Checking…" until Read it again.
                  void reloadSettings();
                  void load(true);
                  closeFlow();
                }}
              />
            )}
          </CreateTeamGate>
        </SettingsPage>
      );
    }
    return (
      <SettingsPage
        entry="team-workspaces"
        scope={scope}
        hiddenNote={hiddenNote}
        lede="A team is a private GitHub repository: it says who is in the team, which repositories are team workspaces, and holds the library they share. It runs on its owner's Team plan, one seat per member."
        status={
          <StatusLine state="empty">
            {machineWords("No team on this Mac. Everything you have keeps working exactly as it does now.")}
          </StatusLine>
        }
      >
        <Section title="Joining a team" scope="team">
          <Group>
            <Row
              kind="procedure"
              label="Join or create a team"
              hint="Join with an invite code somebody sent you, or create a team here and be its owner. Team features run on the Team plan of your Plyloft account."
              action={
                <CBtn tone="strong" onClick={() => openFlow("join-team")}>
                  Start
                </CBtn>
              }
            />
          </Group>
        </Section>
      </SettingsPage>
    );
  }

  const membership = status?.membership ?? "unknown";
  // N14 walk F16: gh not signed in (or Git couldn't sign in) is one plain
  // line with Setup › GitHub as its way out; the raw words go to Details.
  // F16c: with the team's account known, gh's trouble names it.
  const trouble = ghTrouble(status?.error, "read the team", { account: teamAccount });
  // No answer because GitHub couldn't be asked: "not checked", not "Checking…".
  // F16c: only a read actually under way (the first local read, or a read
  // from GitHub) is "Checking membership of <repo> as <account>…"; no answer
  // otherwise — a failed or rejected read, or GitHub answered nothing without
  // an error — is "not checked". Never "account unknown" while checking, and
  // the account named is the team's recorded one (a rejoin with another
  // account never shows the previous login).
  const failed = trouble !== null || Boolean(status?.error);
  const checking = membership === "unknown" && !failed && (status === null || syncing);
  const notChecked = membership === "unknown" && !checking;
  const checkingAs = teamAccount;
  const workspaces = status?.workspaces ?? [];
  // DESIGN.md's rule: the manifest AND GitHub read access. The backend
  // enforces it before any clone (`team.rs::authorize_add`); the page must not
  // offer a button that can only be refused.
  const canAdd = membership === "member";
  const blockedReason =
    status?.membershipReason ??
    "Plyloft has not confirmed your team membership with GitHub yet — press Read it again.";
  const isOwner = licensed && (status?.isOwner ?? false);
  // GH #226: what a reapply left to do outranks the plain divergence it
  // started from — it names the file, or says why nothing ran.
  const recovery =
    (reapplied && reapplyError(reapplied)) ??
    // QoL 13.3: choices put together here, waiting for Publish or Undo.
    (status?.libraryResolved ? resolvedError(status.libraryResolved) : null) ??
    (status?.libraryInterruption ? interruptionError(status.libraryInterruption) : null) ??
    (status?.libraryDivergence ? divergenceError(status.libraryDivergence) : null);

  return (
    <SettingsPage
      entry="team-workspaces"
      scope={scope}
      hiddenNote={hiddenNote}
      title={status?.teamName ?? "Team"}
      lede="The team this Mac is in, who is in it, which of its workspaces are on this Mac, and its library."
      status={
        <>
          <StatusLine state={MEMBERSHIP_STATE[membership]}>
            {checking
              ? "Checking membership of "
              : notChecked
                ? "Membership of "
                : `${MEMBERSHIP_LABEL[membership]} of `}
            <span className="ux-mono-fg">{teamRepo}</span>
            {checking ? `${checkingAs ? ` as ${checkingAs}` : ""}…` : ""}
            {notChecked ? " not checked" : ""}
            {checking
              ? ""
              : status?.login
                ? `, as ${status.login}`
                : notChecked || teamAccount
                  ? ""
                  : ", GitHub account unknown"}
            {status?.ownerLogin ? ` · owned by ${status.ownerLogin}` : ""}
            {/* A read under way is about to answer; if it fails, it says so here. */}
            {status?.membershipStale && !syncing ? " · this is the last answer GitHub gave" : ""}
          </StatusLine>
          {status?.membershipReason && (
            <StatusLine state="aborted">{status.membershipReason}</StatusLine>
          )}
          {trouble ? (
            <GhTroubleStatus trouble={trouble} />
          ) : (
            status?.error && <TeamReadError error={status.error} />
          )}
        </>
      }
    >
      <TeamPlanNotice ownerLogin={status?.ownerLogin ?? null} isOwner={status?.isOwner ?? false} />
      {/* Skills hub H2: GitHub no longer lets this account read the library
          (R16, asks), or this Mac is no longer in the team (R17). */}
      <TeamLibraryNotices onChanged={() => void load(true)} />
      {recovery && (
        <ErrorBlock
          error={recovery}
          busy={reapplying ? REAPPLY_ACTION : null}
          onAction={(id) => {
            if (id === REAPPLY_ACTION || id === PUBLISH_ACTION) void reapply();
            if (id === UNDO_ACTION) void undoResolved();
            if (id === MOVE_ASIDE_ACTION) void moveAside();
            if (id === REVEAL_ACTION) {
              teamLibraryReveal().catch((e) =>
                pushErrorToast("Couldn't show the team clone", e),
              );
            }
          }}
        />
      )}
      {/* QoL 13.3: a collision is chosen here, file by file. */}
      {reapplied?.result === "collision" && reapplied.paths.length > 0 && (
        <TeamConflictChooser
          key={reapplied.paths.join("\n")}
          paths={reapplied.paths}
          busy={reapplying}
          initial={chosen}
          onSettle={(choices) => {
            setChosen(choices);
            void reapply(choices);
          }}
        />
      )}
      <Section title={`${platformWord("thisMachine")} and the team`} scope="this-mac">
        <Group>
          <Row
            kind="text"
            label="Where team workspaces are cloned"
            hint={`Team workspaces land here${
              status?.cloneRootIsDefault ? ", which is the default" : ""
            }: ${status?.cloneRoot ?? defaultRoot}`}
          >
            <TextField
              id={root.inputId}
              value={root.draft}
              onChange={root.setDraft}
              onCommit={(v) => setCloneRootChecked(v)}
              onCancel={root.onCancel}
              placeholder={status?.cloneRoot ?? defaultRoot}
              label="Where team workspaces are cloned"
              mono
              wide
            />
            {root.line && <RowValue>{root.line}</RowValue>}
          </Row>
          <Row
            kind="procedure"
            label="Read the team again"
            hint="Plyloft pulls the team repository, asks GitHub what your account can reach, and reads this project's shared setup again."
            action={
              <CBtn
                disabled={syncing || holdingProject}
                aria-busy={syncing || holdingProject || undefined}
                onClick={() => void readAgain()}
              >
                {syncing || holdingProject ? "Reading…" : "Read it again"}
              </CBtn>
            }
          >
            {/* N14 walk F22: a read that went through says so, quietly. */}
            {!syncing &&
              !readingProject &&
              (projectRead === "unreached" || projectRead === "failed" ? (
                <RowValue>{PROJECT_READ_FAILED_WORDS}</RowValue>
              ) : (
                readAt !== null && <ReadWhen at={readAt} />
              ))}
          </Row>
        </Group>
        {root.notice}
      </Section>

      {isOwner && status && (
        <Members
          status={status}
          teamRepo={teamRepo}
          githubReads={githubReads}
          syncing={syncing}
          everyoneAsk={everyoneAsk}
          result={memberResult}
          onResult={setMemberResult}
          onChanged={() => load(false)}
        />
      )}

      <Section
        title="Team workspaces"
        scope="team"
        count={
          workspaces.length === 0
            ? status?.hasClone
              ? "none in the manifest yet"
              : "not read yet"
            : `${workspaces.length} in the manifest`
        }
      >
        {!canAdd && workspaces.length > 0 && (
          <p className="ux-footnote">
            Only team members can clone team workspaces. {blockedReason}
          </p>
        )}
        {workspaces.length === 0 ? (
          <EmptyState>
            {status?.hasClone
              ? "The team lists no workspaces yet. The owner adds them."
              : "Plyloft has not read the team repository on this Mac yet — press “Read it again”."}
          </EmptyState>
        ) : (
          <Group>
            {workspaces.map((w) => (
              <Row
                key={w.repo}
                kind="item"
                label={w.name}
                hint={w.conflict ?? (folderGone(w) ? `${w.repo}. ${CLONE_AGAIN_LOSES_COPIES}` : w.repo)}
                error={w.conflict ?? undefined}
                chips={
                  folderGone(w) ? (
                    <PChip>{FOLDER_GONE_NOTE}</PChip>
                  ) : folderNotRepository(w) ? (
                    <PChip>{FOLDER_NOT_REPOSITORY_NOTE}</PChip>
                  ) : w.registered ? (
                    <PChip tone="accent">Open here</PChip>
                  ) : undefined
                }
                more={
                  isOwner ? (
                    <MoreMenu
                      label={`More for ${w.name}`}
                      disabled={unlistBusy}
                      items={[
                        {
                          label: "Remove from the team workspaces…",
                          danger: true,
                          onSelect: () => setUnlisting({ repo: w.repo, name: w.name }),
                        },
                      ]}
                    />
                  ) : undefined
                }
                action={
                  w.conflict ? (
                    // Nowhere to clone it: both candidate paths hold other
                    // repositories. Said on the row, because the only button
                    // possible could only fail.
                    <RowValue>Its path is taken</RowValue>
                  ) : folderGone(w) ? (
                    // U31: registered here, and its folder is gone.
                    <CBtn
                      tone="strong"
                      disabled={!canAdd || addingRepo !== null}
                      title={!canAdd ? blockedReason : `Clone into ${w.localPath}`}
                      onClick={() => void pick(w.repo)}
                    >
                      {addingRepo === w.repo ? "Adding…" : CLONE_AGAIN}
                    </CBtn>
                  ) : w.registered ? (
                    <RowValue mono>{w.localPath}</RowValue>
                  ) : (
                    <CBtn
                      tone="strong"
                      disabled={!canAdd || addingRepo !== null}
                      title={
                        !canAdd
                          ? blockedReason
                          : w.cloned
                            ? `Use the copy at ${w.localPath}`
                            : `Clone into ${w.localPath} and register it`
                      }
                      onClick={() => void pick(w.repo)}
                    >
                      {addingRepo === w.repo ? "Adding…" : w.cloned ? "Register" : "Clone and add"}
                    </CBtn>
                  )
                }
              />
            ))}
          </Group>
        )}
      </Section>

      {unlisting && (
        <Sheet
          title={`Remove ${unlisting.name} from the team workspaces?`}
          size="confirm"
          lede={`${unlisting.repo} comes off the team's list: members stop being offered it. Their clones and workspaces stay on their computers, and their access to the repository on GitHub stays as it is — remove that on GitHub if you want to. Removing a member later no longer takes away their access to this repository either.`}
          onClose={() => (unlistBusy ? undefined : setUnlisting(null))}
          canDismiss={!unlistBusy}
          actions={
            <>
              <CBtn onClick={() => setUnlisting(null)} disabled={unlistBusy}>
                Cancel
              </CBtn>
              <CBtn
                tone="danger"
                className="ux-danger-fill"
                disabled={unlistBusy}
                onClick={() => {
                  const target = unlisting;
                  setUnlistBusy(true);
                  void teamWorkspaceListRemove(target.repo)
                    .then((removed) => {
                      setUnlisting(null);
                      setMemberResult(null);
                      pushToast({
                        kind: "info",
                        title: removed ? `${target.name} is no longer a team workspace` : `${target.repo} wasn't listed`,
                        body: removed ? "Add it again from Give the team a workspace if you change your mind." : undefined,
                      });
                      void load(false);
                    })
                    .catch((e: unknown) =>
                      pushErrorToast("Couldn't remove the team workspace", e),
                    )
                    .finally(() => setUnlistBusy(false));
                }}
              >
                {unlistBusy ? "Removing…" : "Remove from the team"}
              </CBtn>
            </>
          }
        />
      )}

      {isOwner && status && (
        <GiveWorkspace
          teamRepo={teamRepo}
          listed={workspaces.map((w) => w.repo)}
          otherMembers={status.members.filter((m) => !m.owner).length}
          onChanged={() => {
            setMemberResult(null);
            void load(false);
          }}
          onGiveEveryone={() => setEveryoneAsk((n) => n + 1)}
        />
      )}

      {isOwner && (
        <FindWorkspaces
          ignoredCount={status?.ignoredRepos.length ?? 0}
          onChanged={() => {
            setMemberResult(null);
            void load(false);
          }}
          onGiveEveryone={
            (status?.members.filter((m) => !m.owner).length ?? 0) > 0 ? () => setEveryoneAsk((n) => n + 1) : null
          }
        />
      )}

      <TeamLibraryLink
        skills={status?.skills ?? []}
        refused={status?.refusedSkills ?? []}
        hasClone={status?.hasClone ?? false}
      />

      {/* Onboarding §11.1 / launch G3: leaving is this one row (a key never
          kept a Mac in a team after the beta). */}
      <LeaveTeam
        teamRepo={teamRepo}
        ownerLogin={status?.ownerLogin ?? null}
        onLeft={() => {
          void reloadSettings();
          void load(false);
        }}
      />
    </SettingsPage>
  );
}

/** The danger zone's one row. For a member who holds a seat (1.175.0 D5,
 *  owner D5-a): one action — the seat on the team's plan goes first, then
 *  this Mac stops following the team; if Plyloft's account can't be reached
 *  nothing changes. For the owner, a member without a seat and a team with
 *  no seats: this Mac stops following the team, as before. Nothing is
 *  deleted — the clones and workspaces stay — and nothing changes on GitHub. */
export function LeaveTeam({ teamRepo, ownerLogin, onLeft }: { teamRepo: string; ownerLogin: string | null; onLeft: () => void }) {
  const [asking, setAsking] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const seat = useAccount((s) => holdsSeatHere(s.info, teamRepo));
  const offline = useAccount((s) => s.info?.offline ?? false);
  const lists = leaveSheetLists(ownerLogin);

  async function leave() {
    setBusy(true);
    setRefused(null);
    try {
      if (seat) {
        // The seat first: a refusal leaves this Mac in the team, said in the sheet.
        let out: LeftSeat;
        try {
          out = await teamLeaveSeat();
        } catch (e) {
          setRefused(refusedWords(e));
          return;
        }
        void useWorkMode.getState().refresh();
        setAsking(false);
        pushToast(leftToast(teamRepo, out));
        onLeft();
        return;
      }
      await teamLeave();
      void useWorkMode.getState().refresh();
      setAsking(false);
      pushToast({
        kind: "info",
        title: machineWords(`This Mac has left ${teamRepo}.`),
        body: "Its workspaces and clones are still here. Join or create a team whenever you like.",
      });
      onLeft();
    } catch (e) {
      pushErrorToast(COULD_NOT_LEAVE, e);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (busy) return;
    setRefused(null);
    setAsking(false);
  };
  return (
    <Section title="Danger zone" scope="team">
      <DangerZone>
        <Row
          kind="procedure"
          label="Leave this team"
          hint={machineWords(leaveRowHint(teamRepo, seat, offline))}
          action={
            <CBtn tone="danger" disabled={busy || (seat && offline)} onClick={() => setAsking(true)}>
              {seat ? "Leave…" : "Leave"}
            </CBtn>
          }
        />
      </DangerZone>
      {asking && (
        <Sheet
          title={`Leave ${teamRepo}?`}
          size="confirm"
          lede={machineWords(seat ? LEAVE_LEDE_SEAT : LEAVE_LEDE_TODAY)}
          onClose={close}
          canDismiss={!busy}
          initialFocusRef={cancelRef}
          actions={
            <>
              <CBtn ref={cancelRef} onClick={close} disabled={busy}>
                Cancel
              </CBtn>
              <CBtn
                tone="danger"
                className="ux-danger-fill"
                onClick={() => void leave()}
                disabled={busy}
              >
                {busy ? "Leaving…" : "Leave the team"}
              </CBtn>
            </>
          }
        >
          {seat && (
            <>
              <p className="ux-sheet-list-title">What you lose</p>
              <ul className="ux-sheet-list">
                {lists.lose.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="ux-sheet-list-title">What stays</p>
              <ul className="ux-sheet-list">
                {lists.stays.map((line) => (
                  <li key={line}>{machineWords(line)}</li>
                ))}
              </ul>
              <p className="ux-sheet-hint">{lists.hint}</p>
              {refused && (
                <p className="ux-sheet-hint" role="alert">
                  <b>{COULD_NOT_LEAVE}</b> {machineWords(refused)}
                </p>
              )}
            </>
          )}
        </Sheet>
      )}
    </Section>
  );
}

// ── The join flow ───────────────────────────────────────────────────────

/** Join or create: an invite code (Setup › Team takes it) or a new team on
 *  this account. Launch G3: keys are retired, so there is no key path; the
 *  Team plan is what team features run on (`teamPlan`: this account has it). */
function JoinFlow({
  teamPlan,
  onCancel,
  onCreate,
  onInviteCode,
}: {
  teamPlan: boolean;
  onCancel: () => void;
  onCreate: () => void;
  /** Team walk 2026-10-01 (F5): open Setup › Team on Join, where the invite
   *  code is pasted. */
  onInviteCode: () => void;
}) {
  const [way, setWay] = useState<"code" | "create">("create");
  // F6: the flow takes the page's place — shown from its top, heading focused.
  const revealRef = useReveal<HTMLDivElement>(true, { block: "start" });
  return (
    <div className="ux-flow" ref={revealRef}>
      <p className="ux-flow-eyebrow">Join or create · 1 step</p>
      <h2 className="ux-flow-title">Join or create a team</h2>
      <p className="ux-page-lede">
        A team is a private GitHub repository. Join one somebody invited you to, or create one on
        your account and become its owner. Team features run on the Team plan.
      </p>
      <ChoiceList
        value={way}
        onChange={setWay}
        label="Join or create a team"
        options={[
          {
            value: "code",
            label: "I have an invite code",
            hint: "Setup › Team takes the code and shows what joining grants before anything happens.",
          },
          {
            value: "create",
            label: "Create a team",
            hint: teamPlan
              ? "Plyloft makes a private repository on GitHub with the team's member list and an empty library, and nothing else."
              : "Needs the Team plan on your Plyloft account (Settings › Setup and account › Plan). Plyloft then makes a private repository on GitHub with the team's member list and an empty library.",
          },
        ]}
      />
      <StatusLine state="empty">
        Nothing happens on GitHub until the next step, and reading what a team shares is always
        free.
      </StatusLine>
      <div className="ux-flow-actions">
        <CBtn onClick={onCancel}>Cancel</CBtn>
        <CBtn tone="accent" onClick={way === "code" ? onInviteCode : onCreate}>
          Continue
        </CBtn>
      </div>
    </div>
  );
}

/**
 * The owner's one step once the plan is paid (launch T1): the team is this
 * Mac's, and attached to the plan, as soon as it exists. Keys are retired.
 */
function CreateTeamFlow({
  boundRepo = null,
  onCancel,
  onCreated,
}: {
  /** Launch T1: the repository the owner's plan is already bound to. */
  boundRepo?: string | null;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [defaults, setDefaults] = useState<CreateTeamDefaults | null>(null);
  const [name, setName] = useState(() => boundRepo?.split("/")[1] ?? "");
  const [repo, setRepo] = useState(boundRepo ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await teamCreateDefaults();
        if (live) setDefaults(next);
      } catch (e) {
        if (live) setDefaults({ login: null, workspaces: [] });
        pushErrorToast("Couldn't read your GitHub account", e);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const login = defaults?.login ?? null;
  const suggestion = suggestTeamRepo(login, name);
  // F7: until `team_create_defaults` answers, the account is being read,
  // not missing — Create waits without an error.
  const gate = createTeamGate(defaults !== null, name, repo, login);

  async function create() {
    setCreating(true);
    try {
      const created = await teamCreate(name.trim(), repo.trim(), picked);
      void useWorkMode.getState().refresh();
      pushToast({
        kind: "info",
        title: created.alreadyExisted
          ? `${created.name} is already your team`
          : `${created.name} created`,
        body: created.alreadyExisted
          ? `${created.repo} was already finished and you own it, so Plyloft changed nothing on GitHub.`
          : `${created.repo} is private on GitHub, with the team's member list and an empty library. Plyloft cloned it to ${created.clonePath}.`,
      });
      // Launch T1: attaching it to the plan failed — said; the Team page
      // then offers "Finish creating your team".
      if (created.bindError) {
        pushErrorToast("The team isn't attached to your plan yet", created.bindError, {
          then: `Press ${FINISH_TITLE} to attach it.`,
        });
      }
      void useTeamBilling.getState().load();
      onCreated();
    } catch (e) {
      const half = decodeHalfMadeTeam(e);
      if (half) {
        // A3-80: the repository is on GitHub; what to do is the body, not Details.
        pushToast({ kind: "error", title: "Your team isn't finished", body: half.body, details: errorText(e) });
      } else {
        pushErrorToast("Couldn't create the team", e);
      }
    } finally {
      setCreating(false);
    }
  }

  // F6: shown from its top (after Checkout too), heading focused.
  const revealRef = useReveal<HTMLDivElement>(true, { block: "start" });
  return (
    <div className="ux-flow" ref={revealRef}>
      <p className="ux-flow-eyebrow">Create · 1 step</p>
      <h2 className="ux-flow-title">Create a team</h2>
      <p className="ux-page-lede">
        A team is a private GitHub repository: it holds the list of who is in the team and
        which repositories are team workspaces, plus the library they share. Plyloft creates that on
        GitHub and attaches it to your Team plan, which holds one seat per member.
      </p>
      <Group>
        <Row
          kind="text"
          label="Team name"
          hint={
            login
              ? `Created as ${login}.`
              : gate.reading
                ? READING_GITHUB_ACCOUNT
                : "Plyloft could not read your GitHub account."
          }
        >
          <TextField
            value={name}
            onChange={setName}
            onCancel={onCancel}
            placeholder="MB Adv"
            label="Team name"
          />
        </Row>
        <Row
          kind="text"
          label="Team repository"
          hint={
            repo.trim()
              ? "Created private on GitHub."
              : suggestion
                ? `Left empty, Plyloft creates ${suggestion} — private.`
                : "Write it as owner/name."
          }
        >
          <TextField
            value={repo}
            onChange={setRepo}
            onCancel={onCancel}
            placeholder={suggestion || "owner/name"}
            label="Team repository"
            mono
            wide
          />
        </Row>
      </Group>
      {(defaults?.workspaces.length ?? 0) > 0 && (
        <Section
          title="Which of your workspaces the team gets"
          scope="team"
          count={`${picked.length} of ${defaults?.workspaces.length} picked`}
        >
          <p className="ux-footnote">
            Your workspaces that are GitHub repositories. A member picks these in their own Plyloft and
            gets them cloned. You can add more later.
          </p>
          <Group>
            {defaults?.workspaces.map((candidate) => (
              <Row key={candidate.repo} kind="toggle" label={candidate.name} hint={candidate.repo}>
                <Toggle
                  checked={picked.includes(candidate.repo)}
                  label={`Give the team ${candidate.name}`}
                  onChange={(on) =>
                    setPicked((current) =>
                      on
                        ? [...current, candidate.repo]
                        : current.filter((r) => r !== candidate.repo),
                    )
                  }
                />
              </Row>
            ))}
          </Group>
        </Section>
      )}
      {gate.message && !gate.reading && <StatusLine state="aborted">{gate.message}</StatusLine>}
      <div className="ux-flow-actions">
        <CBtn disabled={creating} onClick={onCancel}>
          Cancel
        </CBtn>
        <CBtn
          tone="accent"
          disabled={!gate.canCreate || creating}
          title={gate.message ?? "Create the private team repository and its member list"}
          onClick={() => void create()}
        >
          {creating ? "Creating…" : "Create team"}
        </CBtn>
      </div>
    </div>
  );
}

// ── The owner's half ────────────────────────────────────────────────────

/** What the last Send invites or Remove from team did. */
type MemberResult = { ok: boolean; text: string };

/**
 * Who is in the team, and adding somebody.
 *
 * Every row can be run through the same confirmation: the plan is one grant
 * per repository the team owns, so re-running it for an existing member shows
 * exactly the repositories they are missing and nothing else.
 */
function Members({
  status,
  teamRepo,
  githubReads,
  syncing,
  everyoneAsk,
  result,
  onResult,
  onChanged,
}: {
  status: TeamStatus;
  teamRepo: string;
  /** Bumped by each read of the team from GitHub. */
  githubReads: number;
  /** A read of the team from GitHub is under way. */
  syncing: boolean;
  /** QoL 14.4 (G24): bumped when a new team workspace asks for Give
   *  everyone access. */
  everyoneAsk: number;
  result: MemberResult | null;
  onResult: (result: MemberResult | null) => void;
  /** Reads the team on this Mac again; settled once the page shows it. */
  onChanged: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [plan, setPlan] = useState<InvitePlan | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  /** Enter in Add somebody can start another Review while one is asked. */
  const reviewRequest = useRef(new LatestRequest());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** N14 (items 1 and 9): Joined / Invited / No access, from GitHub. */
  const remembered = useTeamMemberStates((s) => s.byTeam[teamStatesKey(teamRepo)] ?? null);
  const rememberStates = useTeamMemberStates((s) => s.remember);
  const unfinishedRemovals = useTeamMemberStates((s) => s.unfinishedRemovals[teamStatesKey(teamRepo)]);
  const noteRemoval = useTeamMemberStates((s) => s.noteRemoval);
  /** A states read has been asked for since this section opened: its answer
   *  replaces them, and its failure is said under the list. */
  const [statesAsked, setStatesAsked] = useState(false);
  // 1.174.3: the last known chips only beside a read that speaks for them. A
  // team read answered from the clone asks no states, and they'd stand unsaid.
  const states = syncing || statesAsked || githubReads > 0 ? remembered : null;
  const [statesError, setStatesError] = useState<string | null>(null);
  const statesRequest = useRef(new LatestRequest());
  /** N14 (item 3): the member the Remove sheet is open for, and the run. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  /** Walk 2026-11-03: the sheet or plan a result answers has gone, and the page
   *  was left scrolled past Members. Asked after each send and Remove:
   *  `always`, where the row that held focus goes with the member. */
  const [revealResult, setRevealResult] = useState<{ always: boolean } | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!revealResult) return;
    let settle = () => {};
    // The next frame: a closing sheet gives focus back to its opener in this one.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const section = resultRef.current?.closest("section") ?? null;
      // Somebody already in a field keeps it, whatever ended: the frame can come
      // late, and focus taken here sends their letters nowhere. One elsewhere on
      // the page isn't scrolled away from it either.
      const typing = inField(active);
      if (typing && !section?.contains(active)) return;
      revealElement(section, {
        block: "start",
        focus: !typing && (revealResult.always || !active || active === document.body),
      });
      settle = settleReveal(section);
    });
    return () => {
      cancelAnimationFrame(frame);
      settle();
    };
  }, [revealResult]);
  /** Walk 2026-11-04: a send adds rows above where the page rests, and a smooth
   *  scroll that was under way when they landed stopped short of Members. The
   *  reveal waits for the local read that brings them. */
  const readThenReveal = (always: boolean) => {
    const reveal = () => setRevealResult({ always });
    void onChanged().then(reveal, reveal);
  };
  /** Launch T2: the team's seats on the plan (`GET /team`), when signed in. */
  const serverTeam = useTeamBilling((s) => s.billing?.team ?? null);
  const accountSub = useAccount((s) => s.info?.sub ?? null);
  // P3-6: a comp team's seats are set by Plyloft — no billing to add them in.
  const comp = useAccount((s) => s.info?.comp ?? false);
  // P3-4: only this Mac's team.
  const seatsTeam = teamForThisMac(serverTeam, teamRepo, accountSub);
  /** P3-5: the manifest's members with their GitHub ids (seats match by id). */
  const [memberIds, setMemberIds] = useState<MemberIds | null>(null);
  const [idsError, setIdsError] = useState<string | null>(null);
  const [giving, setGiving] = useState<string | null>(null);
  const hasSeats = seatsTeam !== null;
  const membersKey = status.members.map((m) => m.login).join(",");
  useEffect(() => {
    if (!hasSeats) return;
    let live = true;
    teamMemberIds()
      .then((ids) => {
        if (!live) return;
        setMemberIds(ids);
        setIdsError(null);
      })
      .catch((e) => {
        if (!live) return;
        setMemberIds(null);
        // Not GitHub's look-ups (`member_ids` names those), the owner's gate.
        setIdsError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [hasSeats, membersKey, githubReads]);
  const openPortal = useTeamBilling((s) => s.portal);
  const portalError = useTeamBilling((s) => s.error);
  /** The last Add refused because every seat is taken. */
  const [seatLimit, setSeatLimit] = useState<string | null>(null);
  // F6: the refusal lands under the list — brought into view when it does.
  const seatLimitRef = useReveal<HTMLDivElement>(seatLimit, { focus: false });
  /** N14 walk F7: the login Review was asked for while no seat is free. */
  const [noSeatFor, setNoSeatFor] = useState<string | null>(null);
  /** F6/F7: whether the plan takes focus when it shows. A plan reached on its
   *  own (a seat freed while Review waited) only takes it from nowhere or
   *  from the no-seat flow it replaces. */
  const [planFocus, setPlanFocus] = useState(true);
  const seatsLoading = useTeamBilling((s) => s.loading);
  const [freeing, setFreeing] = useState<string | null>(null);
  // Signed out there is nothing to ask the server (and no seats to show).
  const reloadSeats = () => {
    if (useAccount.getState().info?.signedIn) void useTeamBilling.getState().load();
  };
  // QoL 14.4 (G26): seats bought in billing show on return — the window's
  // next focus after Add seats opened it reads them again (for an hour),
  // as does each Read it again.
  const portalOpenedAt = useRef<number | null>(null);
  const openSeatsPortal = () => {
    onResult(null);
    portalOpenedAt.current = Date.now();
    void openPortal();
  };
  useEffect(() => {
    const onFocus = () => {
      const at = portalOpenedAt.current;
      if (at === null) return;
      if (Date.now() - at > 3_600_000) {
        portalOpenedAt.current = null;
        return;
      }
      if (useAccount.getState().info?.signedIn) void useTeamBilling.getState().load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (githubReads > 0 && useAccount.getState().info?.signedIn) void useTeamBilling.getState().load();
  }, [githubReads]);

  const readStates = useCallback(async () => {
    const ticket = statesRequest.current.begin();
    setStatesAsked(true);
    try {
      const next = await teamMemberStates();
      if (!statesRequest.current.isCurrent(ticket)) return;
      rememberStates(teamRepo, () => next);
      setStatesError(null);
    } catch (e) {
      if (!statesRequest.current.isCurrent(ticket)) return;
      setStatesError(errorText(e));
    }
  }, [rememberStates, teamRepo]);

  useEffect(() => {
    if (githubReads > 0) void readStates();
  }, [githubReads, readStates]);

  useEffect(() => {
    const request = statesRequest.current;
    return () => request.retireAll();
  }, []);

  const stateOf = (login: string) =>
    states?.members.find((m) => m.login.toLowerCase() === login.toLowerCase()) ?? null;
  // P3-6: the sheet lists what the backend will act on (its own list); until
  // that is read, the same rule here — the team repo, then each valid,
  // distinct team workspace.
  // 1.174.3: both, since remembered states may predate what the status lists.
  const teamRepos =
    [...(states?.repos ?? []), teamRepo, ...status.workspaces.map((w) => w.repo)].filter(
      (repo, i, all) =>
        isRepoSlug(repo) &&
        all.findIndex((r) => r.toLowerCase() === repo.toLowerCase()) === i,
    );

  async function remove(login: string) {
    setRemoveBusy(true);
    setSeatLimit(null);
    try {
      const outcome = await teamMemberRemove(login);
      const said = removeOutcomeSummary(outcome);
      setRemoving(null);
      onResult({ ok: said.kind === "info", text: `${said.title}. ${said.body}` });
      pushToast({ kind: said.kind, title: said.title, body: said.body });
      // Walk 2026-11-04: the row doesn't keep "Joined" until the read lands, or
      // for good when it fails.
      rememberStates(teamRepo, (shown) => shown && statesAfterRemoval(shown, outcome, teamRepo));
      noteRemoval(teamRepo, login, removalLeftUnfinished(outcome));
      readThenReveal(true);
      void readStates();
      reloadSeats();
    } catch (e) {
      pushErrorToast(`Couldn't remove ${login}`, e);
    } finally {
      setRemoveBusy(false);
    }
  }

  async function review(login: string, takeFocus = true) {
    setSeatLimit(null);
    setSendError(null); // U17: another plan, no longer that refusal.
    // Walk 2026-11-04: whether GitHub knows the login comes before the seats, so
    // a typo isn't offered a seat to buy. Reading the plan writes nothing. With
    // none free, any other answer, or none, is the no-seat sheet: no claim about
    // the account, and the backend still takes the seat before GitHub on send.
    const noSeat = seatsTeam !== null && noFreeSeatFor(seatsTeam, login, memberIds?.members ?? null);
    const ticket = reviewRequest.current.begin();
    const showNoSeat = () => {
      setNoSeatFor(login);
      reloadSeats();
    };
    setNoSeatFor(null);
    setPlanFocus(takeFocus);
    setPlanning(login);
    setPlan(null);
    try {
      const read = await teamInvitePlan(login);
      if (!reviewRequest.current.isCurrent(ticket)) return;
      if (noSeat && noAccountSteps(read).length === 0) showNoSeat();
      else setPlan(read);
    } catch (e) {
      if (!reviewRequest.current.isCurrent(ticket)) return;
      if (noSeat) {
        showNoSeat();
        return;
      }
      pushErrorToast("Couldn't work out what to grant", e);
    } finally {
      if (reviewRequest.current.isCurrent(ticket)) setPlanning(null);
    }
  }

  // A press. A plan that follows a freed seat by itself calls review directly,
  // and keeps the Remove result that freed it on screen.
  function pressReview(login: string) {
    onResult(null);
    void review(login);
  }

  async function send() {
    if (!plan) return;
    setSending(true);
    setSendError(null);
    setSeatLimit(null);
    try {
      const outcome = await teamInviteApply(plan.login, plan.digest);
      noteRemoval(teamRepo, plan.login, false);
      setPlan(null);
      setDraft("");
      const note = invitationNote(outcome);
      onResult(note ? { ok: true, text: note } : null);
      readThenReveal(false);
      void readStates();
      reloadSeats();
      pushToast({
        kind: outcome.failed.length > 0 ? "error" : "info",
        title:
          outcome.failed.length > 0
            ? `${outcome.login}: some grants were refused`
            : `${outcome.login} added`,
        body: inviteOutcomeSummary(outcome),
      });
    } catch (e) {
      const text = errorText(e);
      if (isSeatLimit(text)) {
        // Launch T2: every seat is taken — nothing changed on GitHub; Add
        // seats opens billing.
        setPlan(null);
        setSeatLimit(text);
      } else {
        // U17: said where the press was; a toast fades and the page looks dead.
        setSendError(`Couldn't add the member. ${text}`);
        // An add can fail after it wrote the manifest: the page lists them then,
        // so their row offers Remove and not a Free the seat that would be refused.
        void onChanged();
      }
      reloadSeats();
    } finally {
      setSending(false);
    }
  }

  // QoL 14.4 (G24): Give everyone access — each member's Review access plan,
  // read one after another, reviewed on one list and sent together. The
  // same plans and the same send as one member's (each carries its digest).
  const [everyone, setEveryone] = useState<{ plans: InvitePlan[]; noSeat: string[]; unread: string[] } | null>(null);
  const [everyoneBusy, setEveryoneBusy] = useState<"reading" | "sending" | null>(null);
  async function reviewEveryone() {
    onResult(null);
    const others = status.members.filter((m) => !m.owner).map((m) => m.login);
    const noSeat = others.filter((login) => unseated.has(login.toLowerCase()));
    setPlan(null);
    setEveryone(null);
    setEveryoneBusy("reading");
    const plans: InvitePlan[] = [];
    const unread: string[] = [];
    try {
      for (const login of others) {
        if (noSeat.includes(login)) continue;
        try {
          plans.push(await teamInvitePlan(login));
        } catch {
          unread.push(login);
        }
      }
      setEveryone({ plans, noSeat, unread });
    } finally {
      setEveryoneBusy(null);
    }
  }
  async function sendEveryone() {
    if (!everyone) return;
    const { ready, waiting, noAccount } = everyonesAccess(everyone.plans);
    setEveryoneBusy("sending");
    const refused: string[] = [];
    const sent: string[] = [];
    try {
      for (const p of ready) {
        try {
          const outcome = await teamInviteApply(p.login, p.digest);
          noteRemoval(teamRepo, p.login, false);
          if (outcome.failed.length > 0) refused.push(`${p.login} (${outcome.failed.join(", ")})`);
          else sent.push(p.login);
        } catch (e) {
          refused.push(`${p.login}: ${errorText(e)}`);
        }
      }
      const left = {
        refused,
        waiting: [...waiting.map((p) => p.login), ...everyone.unread],
        noSeat: everyone.noSeat,
        noAccount: noAccount.map((p) => p.login),
      };
      setEveryone(null);
      readThenReveal(false);
      void readStates();
      reloadSeats();
      const said = everyonesAccessSent(sent, left);
      pushToast({ kind: refused.length > 0 ? "error" : "info", title: said.title, body: said.body });
    } finally {
      setEveryoneBusy(null);
    }
  }
  const everyoneAskSeen = useRef(everyoneAsk);
  useEffect(() => {
    if (everyoneAsk === everyoneAskSeen.current) return;
    everyoneAskSeen.current = everyoneAsk;
    void reviewEveryone();
    // Only a new ask starts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyoneAsk]);

  async function freeSeat(sub: string, login: string) {
    onResult(null);
    setSeatLimit(null);
    setFreeing(sub);
    try {
      await teamSeatFree(sub);
      pushToast({ kind: "info", title: `${login}'s seat is free again` });
    } catch (e) {
      pushErrorToast(`Couldn't free ${login}'s seat`, e);
    } finally {
      setFreeing(null);
      reloadSeats();
    }
  }

  async function giveSeat(login: string) {
    onResult(null);
    setGiving(login);
    setSeatLimit(null);
    try {
      await teamSeatGive(login);
      pushToast({ kind: "info", title: `${login} has a seat` });
    } catch (e) {
      const text = errorText(e);
      if (isSeatLimit(text)) setSeatLimit(text);
      else pushToast({ kind: "error", title: `Couldn't give ${login} a seat`, details: text });
    } finally {
      setGiving(null);
      reloadSeats();
    }
  }

  // Round 2 (P2-A): a list with members GitHub couldn't look up never
  // decides that a seat is outside the team.
  const idsComplete = memberIds !== null && memberIds.unresolved.length === 0;
  // By id, and not a login the page already lists: its ids are read just after
  // the list changes, and the row meanwhile would offer a refused Free the seat.
  const strays = (seatsTeam && idsComplete ? seatsOutsideTheTeam(seatsTeam, memberIds.members) : []).filter(
    (holder) => !status.members.some((m) => m.login.toLowerCase() === holder.login.toLowerCase()),
  );
  const unseated = new Set(
    (seatsTeam ? membersWithoutSeat(seatsTeam, memberIds?.members ?? null) : []).map((m) => m.login.toLowerCase()),
  );

  // F7: while Review waits for a seat, coming back from billing (the window
  // takes focus again) reads the seats again; Look again does it at once.
  // Once a seat is free the plan is read for the same login.
  useEffect(() => {
    if (!noSeatFor) return;
    const onFocus = () => {
      if (useAccount.getState().info?.signedIn) void useTeamBilling.getState().load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [noSeatFor]);
  const seatFreed =
    noSeatFor !== null && seatsTeam !== null && !noFreeSeatFor(seatsTeam, noSeatFor, memberIds?.members ?? null);
  const reviewNow = useRef(review);
  reviewNow.current = review;
  useEffect(() => {
    if (!seatFreed || !noSeatFor) return;
    const active = document.activeElement;
    const take = !active || active === document.body || active.closest("[data-ply-no-seat]") !== null;
    void reviewNow.current(noSeatFor, take);
  }, [seatFreed, noSeatFor]);

  const draftValid = isGithubLogin(draft);
  return (
    <Section
      title="Members"
      scope="team"
      count={
        seatsTeam
          ? seatCountLabel(seatsTeam)
          : status.members.length === 1
            ? "just you"
            : `${status.members.length} in the manifest`
      }
    >
      {/* Under the section's head with its count, which the reveal shows too.
          Always mounted, so a screen reader announces what lands in it. */}
      <div ref={resultRef} className="ux-member-result" role="status" aria-live="polite" aria-atomic="true">
        {result && <StatusLine state={result.ok ? "done" : "aborted"}>{result.text}</StatusLine>}
      </div>
      <Group>
        {seatsTeam && (
          <Row
            kind="value"
            label="Seats"
            hint="One per member, yours included. Add somebody takes one; Remove from team frees it. Fewer seats take effect at renewal."
            action={
              comp ? undefined : (
                <CBtn onClick={openSeatsPortal} title="Change the number of seats in billing">
                  Add seats
                </CBtn>
              )
            }
          >
            <RowValue>{seatCountLabel(seatsTeam)}</RowValue>
          </Row>
        )}
        {status.members.map((member) => {
          const view = stateOf(member.login);
          // 1.174.3: Remove got as far as their access. The way on is Remove again.
          const unfinished =
            !member.owner && (unfinishedRemovals ?? []).some((l) => l.toLowerCase() === member.login.toLowerCase());
          const chip = unfinished
            ? memberStateChip({ state: "no_access", invitationExpires: null })
            : view && !member.owner
              ? memberStateChip(view)
              : null;
          const noSeat = !member.owner && unseated.has(member.login.toLowerCase());
          return (
            <Row
              key={member.login}
              kind="item"
              label={member.login}
              mono
              hint={
                member.owner
                  ? "The owner: the only account that can edit members and team workspaces."
                  : unfinished
                    ? REMOVAL_UNFINISHED_HINT
                    : ((view && memberStateHint(view, teamRepo)) ??
                    (noSeat
                      ? "They have no seat on the team's plan yet. Give them one."
                      : "A member. Check what GitHub gives them, and grant anything missing."))
              }
              chips={
                member.owner || chip || noSeat ? (
                  <>
                    {member.owner && <PChip tone="accent">owner</PChip>}
                    {chip && <PChip tone={chip.tone}>{chip.word}</PChip>}
                    {noSeat && <PChip tone="warn">No seat</PChip>}
                  </>
                ) : undefined
              }
              action={
                // N14 walk F2: while the member holds no seat, the one row
                // action is Give a seat; Review access moves to ⋯ meanwhile
                // (PATTERNS §3: one action per row).
                unfinished ? (
                  <CBtn
                    tone="strong"
                    disabled={removeBusy || sending || giving !== null}
                    title={`Finish taking ${member.login} out of the team`}
                    onClick={() => {
                      onResult(null);
                      setRemoving(member.login);
                    }}
                  >
                    Remove from team…
                  </CBtn>
                ) : noSeat ? (
                  <CBtn
                    tone="strong"
                    disabled={giving !== null || sending || removeBusy}
                    title={`Give ${member.login} a seat on the team's plan`}
                    onClick={() => void giveSeat(member.login)}
                  >
                    {giving === member.login ? "Giving…" : "Give a seat"}
                  </CBtn>
                ) : (
                  <CBtn
                    disabled={planning !== null || sending || removeBusy}
                    title="Check what this person can reach, and grant anything missing"
                    onClick={() => pressReview(member.login)}
                  >
                    {planning === member.login ? "Reviewing…" : "Review access"}
                  </CBtn>
                )
              }
              more={
                member.owner ? undefined : (
                  <MoreMenu
                    label={`More for ${member.login}`}
                    disabled={removeBusy || sending || giving !== null}
                    items={[
                      ...(noSeat || unfinished
                        ? [
                            {
                              label: "Review access",
                              disabled: planning !== null,
                              onSelect: () => pressReview(member.login),
                            },
                          ]
                        : []),
                      ...(unfinished
                        ? []
                        : [
                            {
                              label: "Remove from team…",
                              danger: true,
                              onSelect: () => {
                                onResult(null);
                                setRemoving(member.login);
                              },
                            },
                          ]),
                    ]}
                  />
                )
              }
            />
          );
        })}
        {status.members.some((m) => !m.owner) && (
          <Row
            kind="procedure"
            label="Everyone's access"
            hint="Review every member at once and grant, in one send, what the team gives them: the team repository and every team workspace."
            action={
              <CBtn
                disabled={everyoneBusy !== null || planning !== null || sending}
                onClick={() => void reviewEveryone()}
                data-ply-team-everyone=""
              >
                {everyoneBusy === "reading" ? "Checking…" : "Give everyone access"}
              </CBtn>
            }
          />
        )}
        <Row
          kind="text"
          label="Add somebody"
          hint="Plyloft shows every repository and permission it would grant before it sends anything."
          action={
            <CBtn
              tone="strong"
              disabled={!draftValid || planning !== null || sending}
              title={
                draftValid
                  ? "See every repository and permission before anything is sent"
                  : "A GitHub login is letters, digits and single hyphens"
              }
              onClick={() => pressReview(draft.trim())}
            >
              {planning === draft.trim() ? "Checking…" : "Review"}
            </CBtn>
          }
        >
          {/* Enter, never blur: asking GitHub what a half-typed login can
              reach is a network round trip about somebody who does not exist,
              and the answer would sit on the page as a plan to confirm
              (review 1, finding 5). */}
          <TextField
            value={draft}
            onChange={setDraft}
            onEnter={(v) => {
              if (isGithubLogin(v)) pressReview(v.trim());
            }}
            onCancel={() => setDraft("")}
            placeholder="their GitHub login"
            label="Add somebody"
            mono
          />
        </Row>
        {strays.map((holder) => (
          <Row
            key={holder.sub}
            kind="item"
            label={holder.login}
            mono
            hint="Holds a seat but isn't in the team: an add that didn't finish on GitHub, or a removal whose seat stayed. Add them again to finish, or free the seat."
            chips={<PChip tone="warn">seat only</PChip>}
            action={
              <CBtn disabled={freeing !== null} onClick={() => void freeSeat(holder.sub, holder.login)}>
                {freeing === holder.sub ? "Freeing…" : "Free the seat"}
              </CBtn>
            }
          />
        ))}
        <CopyInviteRows name={status.teamName} />
      </Group>
      {seatsTeam && memberIds && memberIds.unresolved.length > 0 && (
        <p className="ux-footnote">
          Couldn't look up {memberIds.unresolved.join(", ")} on GitHub, so seats held by people outside the team
          aren&apos;t shown. Read it again to retry.
        </p>
      )}
      {seatsTeam && idsError && (
        <p className="ux-footnote">
          Plyloft couldn't read the team's members, so seats held by people outside the team aren&apos;t
          shown: {idsError}
        </p>
      )}
      {seatLimit && (
        <div ref={seatLimitRef}>
          <StatusLine state="aborted">
            {seatLimit}{" "}
            {!comp && (
              <CBtn tone="strong" onClick={openSeatsPortal}>
                Add seats
              </CBtn>
            )}
          </StatusLine>
        </div>
      )}
      {portalError && seatsTeam && <StatusLine state="aborted">{portalError.message}</StatusLine>}
      {statesError && (
        <p className="ux-footnote">
          Plyloft couldn't read who has joined from GitHub: {statesError}
        </p>
      )}
      {states && states.problems.length > 0 && (
        <p className="ux-footnote">
          GitHub didn't answer for everything, so some states are missing:{" "}
          {states.problems.join("; ")}
        </p>
      )}
      {removing && (
        <Sheet
          title={`Remove ${removing} from ${status.teamName ?? teamRepo}?`}
          size="confirm"
          lede={removalLede(removing, teamRepos)}
          onClose={() => (removeBusy ? undefined : setRemoving(null))}
          canDismiss={!removeBusy}
          initialFocusRef={keepRef}
          actions={
            <>
              <CBtn ref={keepRef} onClick={() => setRemoving(null)} disabled={removeBusy}>
                Cancel
              </CBtn>
              <CBtn
                tone="danger"
                className="ux-danger-fill"
                onClick={() => void remove(removing)}
                disabled={removeBusy}
              >
                {removeBusy ? "Removing…" : "Remove from team"}
              </CBtn>
            </>
          }
        >
          <Group>
            {teamRepos.map((repo, i) => (
              <Row
                key={repo}
                kind="item"
                label={repo}
                mono
                hint={i === 0 ? "The team repository" : "A team workspace"}
              />
            ))}
          </Group>
          <p className="ux-footnote">{removalClaimsNote(removing)}</p>
          {seatsTeam && seatEvidence(seatsTeam, removing, memberIds) === true && (
            <p className="ux-footnote">Their seat on the team's plan goes free.</p>
          )}
          <p className="ux-footnote">
            If GitHub refuses any repository, Plyloft says which and keeps them in the team until
            every one is done.
          </p>
        </Sheet>
      )}
      {everyone && (
        <EveryoneReview
          view={everyone}
          sending={everyoneBusy === "sending"}
          onSend={() => void sendEveryone()}
          onCancel={() => setEveryone(null)}
        />
      )}
      {plan && (
        <InviteReview
          plan={plan}
          takeFocus={planFocus}
          // Only with seats on the server: a dev plan has none, and a member
          // who holds one takes no other.
          takesSeat={seatsTeam !== null && seatEvidence(seatsTeam, plan.login, memberIds) === false}
          sending={sending}
          error={sendError}
          onSend={() => void send()}
          onCancel={() => {
            setSendError(null);
            // Review access on a row opens this too: what's being typed stays.
            // A name GitHub doesn't know stays, to fix a typo (owner, 2026-11-04).
            if (plan.login.toLowerCase() === draft.trim().toLowerCase() && noAccountSteps(plan).length === 0) setDraft("");
            setPlan(null);
          }}
        />
      )}
      {!plan && noSeatFor && seatsTeam && (
        <NoSeatReview
          login={noSeatFor}
          teamName={status.teamName ?? teamRepo}
          seats={seatsTeam.seats}
          comp={comp}
          checking={seatsLoading}
          onAddSeats={openSeatsPortal}
          onCheckAgain={reloadSeats}
          onCancel={() => setNoSeatFor(null)}
        />
      )}
    </Section>
  );
}

/** QoL 14.4 (G24): Give everyone access's one list — every member's grants
 *  read before anything is sent, then one send. */
function EveryoneReview({
  view,
  sending,
  onSend,
  onCancel,
}: {
  view: { plans: InvitePlan[]; noSeat: string[]; unread: string[] };
  sending: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  const access = everyonesAccess(view.plans);
  const revealRef = useReveal<HTMLDivElement>(view.plans.map((p) => p.digest).join(","), { block: "start", focus: true });
  const waiting = [...access.waiting.map((p) => p.login), ...view.unread];
  return (
    <div className="ux-flow" ref={revealRef} data-ply-team-everyone-review="">
      <p className="ux-flow-eyebrow">Give everyone access</p>
      <h2 className="ux-flow-title">What each member gets</h2>
      <p className="ux-page-lede">
        {everyonesAccessSummary({ ...access, waiting }, view.noSeat)}
      </p>
      <Group>
        {access.ready.map((p) => (
          <Row
            key={p.login}
            kind="item"
            label={p.login}
            mono
            hint={grantingSteps(p)
              .map((step) => `${step.repo} (${step.permission})`)
              .join(", ")}
            chips={<PChip tone="warn">{`${grantingSteps(p).length} to grant`}</PChip>}
          />
        ))}
        {access.done.map((p) => (
          <Row key={p.login} kind="item" label={p.login} mono hint="Has everything already." chips={<PChip tone="ok">no change</PChip>} />
        ))}
        {access.noAccount.map((p) => (
          <Row key={p.login} kind="item" label={p.login} mono hint="Nothing is sent to them." chips={<PChip tone="warn">{NO_ACCOUNT_CHIP}</PChip>} />
        ))}
        {waiting.map((login) => (
          <Row key={login} kind="item" label={login} mono hint="GitHub didn't answer for them: read it again, then check them alone." chips={<PChip>could not check</PChip>} />
        ))}
      </Group>
      <div className="ux-flow-actions">
        <CBtn disabled={sending} onClick={onCancel}>
          Cancel
        </CBtn>
        <CBtn
          tone="accent"
          disabled={sending || access.ready.length === 0}
          title={access.ready.length === 0 ? "Nothing to grant" : `Grant ${access.grants} on GitHub`}
          onClick={onSend}
        >
          {sending ? "Sending…" : `Send ${access.grants === 1 ? "1 grant" : `${access.grants} grants`}`}
        </CBtn>
      </div>
    </div>
  );
}

/**
 * Adding a member is not one grant: it is write access to the team repository
 * **and** to every team workspace. The owner is handing someone the ability to
 * push to all of them, so every one is listed with its permission and with
 * what GitHub already gives that person, and nothing is sent until the list has
 * been read. `plan.digest` travels back so the backend can refuse a repository
 * that appeared after it was read.
 */
function InviteReview({
  plan,
  takeFocus,
  takesSeat,
  sending,
  error,
  onSend,
  onCancel,
}: {
  plan: InvitePlan;
  /** False when the plan came on its own and focus is elsewhere. */
  takeFocus: boolean;
  /** Sending it would take a seat on the team's plan. */
  takesSeat: boolean;
  sending: boolean;
  /** U17: why the last Send didn't go. */
  error: string | null;
  onSend: () => void;
  onCancel: () => void;
}) {
  const grants = grantingSteps(plan).length;
  const unresolved = unresolvedSteps(plan).length;
  const noAccount = noAccountSteps(plan).length;
  const cantSend = noAccount > 0 || unresolved > 0 || (grants === 0 && !plan.addsToManifest);
  // Nothing to do: the sheet reports, with no add on offer.
  const nothing = nothingToDo(plan);
  // F6: the plan fills in below the list — brought into view, its heading
  // focused, for each login reviewed.
  // Reached on its own, it only has to be seen: `start` would scroll away what
  // the owner is reading, such as the Remove result that freed the seat.
  const revealRef = useReveal<HTMLDivElement>(`${plan.login}:${plan.digest}`, {
    block: takeFocus ? "start" : "nearest",
    focus: takeFocus,
  });
  return (
    <div className="ux-flow" ref={revealRef}>
      <p className="ux-flow-eyebrow">{nothing ? "Review access" : "Add a member · 1 step"}</p>
      <h2 className="ux-flow-title">
        {nothing ? `${plan.login} in ${plan.teamName}` : `Add ${plan.login} to ${plan.teamName}`}
      </h2>
      <p className="ux-page-lede">{invitePlanSummary(plan)}</p>
      <Group>
        {plan.steps.map((step) => (
          <Row
            key={step.repo}
            kind="item"
            label={step.repo}
            mono
            hint={`${step.kind === "team_repo" ? "The team repository" : "A team workspace"} — ${step.purpose}${step.action === "no_such_account" ? "" : ` GitHub gives them ${step.current} today.`}`}
            chips={
              step.action === "grant" ? (
                <PChip tone="warn">{`grant ${step.permission}`}</PChip>
              ) : step.action === "no_such_account" ? (
                <PChip tone="warn">{NO_ACCOUNT_CHIP}</PChip>
              ) : step.action === "invited" ? (
                <PChip>
                  {step.invitationExpires
                    ? `invited · expires ${shortDay(step.invitationExpires)}`
                    : "invited"}
                </PChip>
              ) : step.action === "unresolved" ? (
                <PChip>could not check — read it again</PChip>
              ) : (
                <PChip tone="ok">no change</PChip>
              )
            }
          />
        ))}
      </Group>
      {takesSeat && !cantSend && <p className="ux-footnote">This takes one seat.</p>}
      {plan.warnings.map((warning) => (
        <StatusLine key={warning} state="aborted">
          {warning}
        </StatusLine>
      ))}
      {error && (
        <div role="alert">
          <StatusLine state="aborted">{error}</StatusLine>
        </div>
      )}
      <div className="ux-flow-actions">
        <CBtn disabled={sending} onClick={onCancel}>
          Cancel
        </CBtn>
        {!nothing && (
          <CBtn
            tone="accent"
            disabled={sending || cantSend}
            title={`Grant ${grants} repositories on GitHub`}
            reason={
              noAccount > 0
                ? `GitHub has no account named ${plan.login}`
                : unresolved > 0
                  ? "GitHub did not answer for every repository — read it again before sending"
                  : null
            }
            onClick={onSend}
          >
            {sending ? "Sending…" : inviteSendLabel(plan)}
          </CBtn>
        )}
      </div>
    </div>
  );
}

/**
 * N14 walk F7: Review with every seat taken, for a login GitHub didn't say is
 * unknown. No plan shows and nothing can be sent: the owner adds seats in
 * billing (the Portal) and comes back —
 * focus or Look again reads the seats, and a free seat goes on to the plan.
 * A comp team's seats are set by Plyloft, so it offers no billing.
 */
function NoSeatReview({
  login,
  teamName,
  seats,
  comp,
  checking,
  onAddSeats,
  onCheckAgain,
  onCancel,
}: {
  login: string;
  teamName: string;
  seats: number;
  comp: boolean;
  checking: boolean;
  onAddSeats: () => void;
  onCheckAgain: () => void;
  onCancel: () => void;
}) {
  const words = noFreeSeatWords(seats, login, comp);
  const revealRef = useReveal<HTMLDivElement>(login, { block: "start" });
  return (
    <div className="ux-flow" ref={revealRef} data-ply-no-seat="">
      <p className="ux-flow-eyebrow">Add a member · 1 step</p>
      <h2 className="ux-flow-title">
        Add {login} to {teamName}
      </h2>
      <StatusLine state="aborted">{words.title}</StatusLine>
      <p className="ux-page-lede">{words.body}</p>
      <div className="ux-flow-actions">
        <CBtn onClick={onCancel}>Cancel</CBtn>
        <CBtn disabled={checking} onClick={onCheckAgain}>
          {checking ? "Looking…" : "Look again"}
        </CBtn>
        {!comp && (
          <CBtn tone="accent" title="Change the number of seats in billing" onClick={onAddSeats}>
            Add seats
          </CBtn>
        )}
      </div>
    </div>
  );
}

/**
 * Team walk 2026-10-01 (F1): after the team exists the owner can still give it
 * any workspace — the GitHub-backed ones open on this Mac (what Create team
 * offered, minus what the manifest lists) or any `owner/name` typed in. Both
 * go through `team_workspace_list_add`, which validates the slug and writes
 * the manifest; the owner then grants existing members access with Check
 * access, which the line under the list says until the page is left.
 */
function GiveWorkspace({
  onGiveEveryone,
  teamRepo,
  listed,
  otherMembers,
  onChanged,
}: {
  /** QoL 14.4 (G24): opens Give everyone access in Members. */
  onGiveEveryone: () => void;
  teamRepo: string;
  listed: string[];
  otherMembers: number;
  onChanged: () => void;
}) {
  const [candidates, setCandidates] = useState<{ repo: string; name: string }[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [given, setGiven] = useState<string | null>(null);
  const [offerEveryone, setOfferEveryone] = useState(false);

  useEffect(() => {
    let live = true;
    teamCreateDefaults()
      .then((defaults) => {
        if (live) setCandidates(defaults.workspaces);
      })
      .catch(() => {
        // The typed field below still works; the list is a convenience.
        if (live) setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const offered = workspacesToGive(candidates ?? [], listed, teamRepo);
  const typed = draft.trim();
  const typedValid = isRepoSlug(typed);

  async function give(repo: string) {
    setBusy(repo);
    try {
      const added = await teamWorkspaceListAdd(repo, null);
      if (repo === typed) setDraft("");
      setGiven(added ? workspaceGivenNote(repo, otherMembers) : `${repo} was already a team workspace.`);
      setOfferEveryone(added && otherMembers > 0);
      onChanged();
    } catch (e) {
      pushErrorToast("Couldn't add the team workspace", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Give the team a workspace" scope="team">
      {candidates === null && <p className="ux-footnote">Reading your workspaces…</p>}
      <Group>
        {offered.map((candidate) => (
          <Row
            key={candidate.repo}
            kind="item"
            label={candidate.name}
            hint={candidate.repo}
            action={
              <CBtn
                tone="strong"
                disabled={busy !== null}
                title="Add it to the team as a team workspace"
                onClick={() => void give(candidate.repo)}
              >
                {busy === candidate.repo ? "Adding…" : "Add"}
              </CBtn>
            }
          />
        ))}
        <Row
          kind="text"
          label="Another repository"
          hint="Any GitHub repository, written as owner/name. It becomes a team workspace."
          action={
            <CBtn
              tone="strong"
              disabled={!typedValid || busy !== null}
              title={typedValid ? "Add it to the team as a team workspace" : "Write it as owner/name"}
              onClick={() => void give(typed)}
            >
              {busy === typed && typed ? "Adding…" : "Add"}
            </CBtn>
          }
        >
          <TextField
            value={draft}
            onChange={setDraft}
            onEnter={(v) => {
              if (isRepoSlug(v.trim())) void give(v.trim());
            }}
            onCancel={() => setDraft("")}
            placeholder="owner/name"
            label="Another repository"
            mono
            wide
          />
        </Row>
      </Group>
      {given && (
        <StatusLine state="done">
          {given}
          {offerEveryone && (
            <>
              {" "}
              <CBtn
                tone="strong"
                onClick={() => {
                  setOfferEveryone(false);
                  onGiveEveryone();
                }}
              >
                Give everyone access
              </CBtn>
            </>
          )}
        </StatusLine>
      )}
    </Section>
  );
}

/**
 * Assisted discovery. A repository carrying `.atelier/workspace.json` (ADR
 * 0003) or the older `.atelier/workspace_default.json` has already been set
 * up as a Ply workspace by somebody, which is the whole signal. Ply proposes; the owner decides — a team workspace is cloned onto
 * every member's Mac, and that is never Ply's call.
 */
function FindWorkspaces({
  ignoredCount,
  onChanged,
  onGiveEveryone,
}: {
  ignoredCount: number;
  onChanged: () => void;
  /** QoL 14.4 (G24): Give everyone access, when the team has members. */
  onGiveEveryone: (() => void) | null;
}) {
  const [scan, setScan] = useState<Discovery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function run() {
    setScanning(true);
    try {
      setScan(await teamDiscover());
    } catch (e) {
      pushErrorToast("Couldn't look through your repositories", e);
    } finally {
      setScanning(false);
    }
  }

  function drop(repo: string) {
    setScan((current) =>
      current ? { ...current, proposals: current.proposals.filter((p) => p.repo !== repo) } : current,
    );
  }

  async function add(repo: string) {
    setBusy(repo);
    try {
      const added = await teamWorkspaceListAdd(repo, null);
      drop(repo);
      onChanged();
      pushToast({
        kind: "info",
        title: added ? `${repo} is a team workspace` : `${repo} was already listed`,
        body: added
          ? onGiveEveryone
            ? "Every member can now pick it in their own Plyloft. They need GitHub access to it too: Give everyone access grants it in one send."
            : "Members you add from now on get access to it with their invite."
          : "The team already listed it.",
        ...(added && onGiveEveryone ? { action: { label: "Give everyone access", onClick: onGiveEveryone } } : {}),
      });
    } catch (e) {
      pushErrorToast("Couldn't add the team workspace", e);
    } finally {
      setBusy(null);
    }
  }

  async function ignore(repo: string) {
    setBusy(repo);
    try {
      await teamDiscoveryIgnore(repo);
      drop(repo);
      onChanged();
    } catch (e) {
      pushErrorToast("Couldn't ignore the repository", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Find team workspaces" scope="team">
      <Group>
        <Row
          kind="procedure"
          label="Look through your repositories"
          hint={
            scan
              ? discoverySummary(scan)
              : "Plyloft looks for repositories you can reach that are already set up as Plyloft workspaces. It proposes; you decide."
          }
          action={
            <CBtn disabled={scanning} onClick={() => void run()}>
              {scanning ? "Looking…" : "Look"}
            </CBtn>
          }
        />
        {scan?.proposals.map((proposal) => (
          <Row
            key={proposal.repo}
            kind="item"
            label={proposal.repo}
            mono
            hint={proposal.description ?? "Already set up as a Plyloft workspace."}
            chips={proposal.private ? <PChip>private</PChip> : undefined}
            action={
              <CBtn
                tone="strong"
                disabled={busy !== null}
                title="Add it to the team as a team workspace"
                onClick={() => void add(proposal.repo)}
              >
                {busy === proposal.repo ? "Adding…" : "Add"}
              </CBtn>
            }
            more={
              <MoreMenu
                label={`More for ${proposal.repo}`}
                items={[
                  {
                    label: "Never propose this again",
                    onSelect: () => void ignore(proposal.repo),
                  },
                ]}
              />
            }
          />
        ))}
        {ignoredCount > 0 && (
          <Row
            kind="procedure"
            label="Repositories you told Plyloft to stop proposing"
            hint={machineWords(`${ignoredCount} on this Mac. Other Macs decide for themselves.`)}
            action={
              <CBtn
                onClick={() => {
                  void (async () => {
                    try {
                      await teamDiscoveryClearIgnored();
                      onChanged();
                      await run();
                    } catch (e) {
                      pushErrorToast("Couldn't clear them", e);
                    }
                  })();
                }}
              >
                Show them again
              </CBtn>
            }
          />
        )}
      </Group>
    </Section>
  );
}

/**
 * UX-9.5: the team library's skills are the Library's to show — its Team scope
 * lists them with the CLIs each one reaches, compares them and removes one for
 * everyone (`Remove from Team…`). Here they are one row that says how many and
 * opens that scope, closing Settings on the way.
 *
 * A plugin the team library carries and a CLI refused is still listed here,
 * one row each: it is a fault of the library on this Mac, and the Library's
 * list has no row for a skill that never loaded.
 */
function TeamLibraryLink({
  skills,
  refused,
  hasClone,
}: {
  skills: TeamStatus["skills"];
  refused: TeamStatus["refusedSkills"];
  hasClone: boolean;
}) {
  const activeId = useWorkspaces((s) => s.activeId);
  const setOpen = useUi((s) => s.setSettingsOverlayOpen);
  return (
    <Section title="Library" scope="team">
      {/* Skills hub H2 (R1): pulled in the background; when it last was. */}
      <TeamLibraryPullLine asNote />
      <Group>
        <Row
          kind="value"
          label="Team skills"
          hint="Loaded into every Claude and Codex session Plyloft starts for you. The Library lists them, compares them and removes one for everyone."
          onOpen={
            activeId
              ? () =>
                  leavePage(() => {
                    setOpen(false);
                    openLibraryPage(activeId, "skills", "team");
                  })
              : undefined
          }
        >
          <RowValue>
            {activeId ? teamSkillsSummaryLabel(skills, hasClone) : "open a workspace to see them"}
          </RowValue>
        </Row>
        {refused.map((plugin) => (
          <Row
            key={`${plugin.vendor}:${plugin.plugin}`}
            kind="item"
            label={plugin.plugin}
            mono
            error={`Not loaded — ${plugin.reason}.`}
            chips={<PChip tone="warn">{SKILL_VENDOR_LABEL[plugin.vendor]}</PChip>}
          />
        ))}
      </Group>
    </Section>
  );
}

/** N14 walk F22: "Read just now", then "Read 4 minutes ago" — its own clock,
 *  so the page around it does not re-render while it ages. */
function ReadWhen({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [at]);
  return <RowValue>Read {relativeWhen(at, now)}</RowValue>;
}
