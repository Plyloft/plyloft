// OB-10 (ONBOARDING_SPEC §5 step 6, §12): Setup's "Your team" step, team
// mode only.
//
// - Waits for GitHub (D14): without a signed-in account it shows only
//   *Connect GitHub first.* and `Go to GitHub`; the other steps go on.
// - **Join**: the teams this account can already read whose `team.json`
//   lists it (§12.4, D16 — a bare pending invitation is never listed), and
//   the invite-code field. Either opens the Join sheet — always — which
//   names the repository, its owner as GitHub says, who invited, what
//   joining grants and each invitation Plyloft will accept. A second team
//   first asks to replace the one this Mac is in (one team per Mac).
// - **Create**: team name, repository (the suggestion, editable), the
//   account, the sheet, then Invite people (the existing invite plan) and
//   Copy invite (the code and its message, D11: code only).
// - **Joined** (detected done): *You're in “MB Adv”.*, the half-state the
//   membership probe explains, and the team's projects to get into the
//   projects folder (asked inline when step 7 hasn't chosen one).
//
// What may be accepted on GitHub is decided in Rust (`team_join.rs`); this
// file only draws the sheets and sends what the person confirmed.
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyInviteRows } from "./CopyInvite";
import { CreateTeamGate } from "./TeamCheckout";
import { TeamPlanNotice } from "../settings/TeamPlanNotice";
import { useTeamBilling } from "../../store/teamBillingStore";
import {
  CBtn,
  Callout,
  CheckList,
  CheckRow,
  ChoiceList,
  Details,
  ErrorBlock,
  Group,
  PChip,
  Row,
  RowValue,
  Section,
  Select,
  Sheet,
  StatusLine,
  TextField,
} from "../ux";
import { useAccount } from "../../store/accountStore";
import { openCenterMode } from "../../store/uiStore";
import { useSettings } from "../../store/settingsStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { useWorkMode } from "../../store/workModeStore";
import { useSetup } from "../../store/setupStore";
import { useGithubStatus } from "../../store/githubStatusStore";
import { pushToast } from "../../store/toastStore";
import { machineWords } from "../../lib/platform";
import { chooseProjectsFolder } from "../../store/projectsFolderWrite";
import { ProjectsFolderRow, useProjectsFolderChoice } from "./ProjectsFolderRow";
import { grantingSteps, inviteOutcomeSummary, invitePlanSummary, inviteSendLabel, isGithubLogin, NO_ACCOUNT_CHIP, noAccountSteps, suggestTeamRepo, unresolvedSteps } from "../../lib/teamAdmin";
import {
  setupOpenGithubSso,
  teamCreate,
  teamCreateDefaults,
  teamInviteApply,
  teamInvitePlan,
  teamJoinAcceptWorkspaces,
  teamJoinConfirm,
  teamJoinDetect,
  teamJoinPreview,
  teamJoinWorkspaceInvites,
  teamRefresh,
  teamStatus,
  teamWorkspaceAdd,
  type InvitePlan,
  type JoinDetection,
  type JoinPreview,
  type JoinProblem,
  type JoinWorkspaceInvite,
  type TeamStatus,
} from "../../ipc";
import {
  CODE_HINT,
  CODE_LABEL,
  CONNECT_FIRST,
  CONNECT_FIRST_HINT,
  COPY_INVITE,
  CLONE_AGAIN_LOSES_COPIES,
  FOLDER_GONE_NOTE,
  FOLDER_NOT_REPOSITORY_NOTE,
  addedTitle,
  askOwnerToInvite,
  folderGone,
  folderNotRepository,
  READ_IT_AGAIN,
  TEAM_NOT_READ,
  CREATE_LABEL,
  INVITE_PEOPLE,
  JOIN_LABEL,
  JOIN_HINT,
  JOIN_GENERIC_HINT,
  CODE_BUTTON,
  JOIN_ANOTHER_LABEL,
  JOIN_ANOTHER_HINT,
  CHOOSE_LINE,
  PASTE_OR_CHOOSE_LINE,
  CHOOSE_TEAM_LINE,
  STILL_LOOKING_LINE,
  LOOK_PROBLEM_LINE,
  repoName,
  NOT_NOW_LABEL,
  NOT_NOW_HINT,
  LOOKING,
  accountChoices,
  createBlocker,
  createError,
  createSheet,
  DETECTED_TEAMS_LABEL,
  detectedTeamRow,
  detectionLine,
  getProjectsLabel,
  halfStateLine,
  isFieldProblem,
  joinName,
  joinProblemError,
  joinSheet,
  joinedLine,
  joinedToast,
  onlyProjectToGet,
  replaceSheet,
  ssoFromText,
  teamScreen,
  workspaceInviteSheet,
} from "../../lib/teamStep";
import type { UxError } from "../../lib/uxError";
import { pushErrorToast } from "../../lib/errorToast";

export { TEAM_TITLE, TEAM_WHY } from "../../lib/teamStep";

type Path = "" | "join" | "create" | "none" | `team:${string}`;

const words = (e: unknown) => String((e as Error)?.message ?? e);

export function TeamStep({
  guided,
  githubConnected,
  onGoGithub,
  onTeam,
  continueRef,
  onNotNow,
  hint,
}: {
  /** Step by step: the "What is a team?" block. */
  guided: boolean;
  /** gh has a signed-in account (step 5); null while not read. */
  githubConnected: boolean | null;
  onGoGithub: () => void;
  /** The team this Mac is in, once the step reads one (the list's state). */
  onTeam?: (team: { repo: string; name: string | null }) => void;
  /** 1.176.3: Setup's Continue asks the step first. The step sets what it
   *  does there: it answers true when it handled the press (opened the Join
   *  sheet, or took "Not now"), false to let Continue move on. */
  continueRef?: { current: (() => boolean) | null };
  /** "Not now": saves what "Skip for now" saved, and moves on. */
  onNotNow?: () => void;
  /** What GitHub's answer, already held by Setup, found: the teams listing
   *  this account and the invitations waiting. Null: not read. */
  hint?: { teams: readonly string[]; invitations: number } | null;
}) {
  const settingsTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  const [status, setStatus] = useState<TeamStatus | null>(null);
  // U27: the read that says most wins. An offline read from before a join,
  // landing after the network read the join started, would leave the step with
  // no team name and no projects, and nothing asks again.
  const reads = useRef({ seq: 0, inFlight: 0, applied: 0, landed: 0 });
  const [readFailed, setReadFailed] = useState(false);
  const load = useCallback(async (network: boolean) => {
    const r = reads.current;
    const mine = ++r.seq;
    if (network) r.inFlight += 1;
    try {
      const next = await (network ? teamRefresh() : teamStatus());
      if (network) {
        if (mine >= r.applied) {
          r.applied = mine;
          r.landed = ++r.seq;
          setStatus(next);
        }
      } else if (r.inFlight === 0 && r.landed < mine) {
        setStatus(next);
      }
      setReadFailed(false);
    } catch {
      // The joined panel says what it can without it.
      setReadFailed(true);
    } finally {
      if (network) r.inFlight -= 1;
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);

  const joined = Boolean(settingsTeamRepo || status?.teamRepo);
  const statusRepo = status?.teamRepo ?? null;
  const statusName = status?.teamName ?? null;
  useEffect(() => {
    if (statusRepo) onTeam?.({ repo: statusRepo, name: statusName });
  }, [statusRepo, statusName, onTeam]);
  const screen = teamScreen({ joined, githubConnected });
  // F5: Settings' "I have an invite code" asks for Join straight away.
  // 1.176.3: the options follow what GitHub found. A listed team: one named
  // option per team (up to three), the first chosen. Only an invitation:
  // Join is chosen. Nothing found, or Setup reopened without the answer:
  // nothing is chosen and nothing is looked up before Join is.
  const named = (hint?.teams ?? []).slice(0, 3);
  const firstChoice = (): Path =>
    named.length > 0 ? `team:${named[0]}` : hint && hint.invitations > 0 ? "join" : "";
  const [path, setPathNow] = useState<Path>(() => useSetup.getState().teamPath ?? firstChoice());
  const touched = useRef(Boolean(useSetup.getState().teamPath));
  const [notice, setNotice] = useState<string | null>(null);
  const setPath = (next: Path) => {
    touched.current = true;
    setNotice(null);
    setPathNow(next);
  };
  const firstKey = firstChoice();
  useEffect(() => {
    if (!touched.current && path === "" && firstKey !== "") setPathNow(firstKey);
  }, [firstKey, path]);
  const askFirst = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    if (!continueRef) return;
    continueRef.current =
      screen !== "choose"
        ? null
        : () => {
            if (path === "none") {
              onNotNow?.();
              return Boolean(onNotNow);
            }
            if (path === "") {
              setNotice(CHOOSE_LINE);
              return true;
            }
            if (path === "create") return false;
            return askFirst.current ? askFirst.current() : false;
          };
    return () => {
      continueRef.current = null;
    };
  });
  useEffect(() => {
    if (useSetup.getState().teamPath) useSetup.setState({ teamPath: null });
  }, []);
  const afterJoin = useCallback(async () => {
    void useWorkMode.getState().refresh();
    // Clone the team repo and ask GitHub who is in it.
    await load(true);
  }, [load]);

  return (
    <>
      {guided && (
        <Details summary="What is a team?">
          <p className="ux-setup-note">
            A private repository on GitHub that you and your teammates can read. Plyloft keeps the team&apos;s member
            list, its shared projects and its library there. The team runs on the owner&apos;s Team plan, with one seat
            per member.
          </p>
        </Details>
      )}
      {screen === "checking" && <p className="ux-setup-note">Checking GitHub…</p>}
      {screen === "needs-github" && (
        <Callout
          kind="info"
          title={CONNECT_FIRST}
          text={CONNECT_FIRST_HINT}
          actions={
            <>
              <CBtn tone="strong" onClick={onGoGithub}>
                Go to GitHub
              </CBtn>
              {onNotNow && (
                <CBtn tone="quiet" onClick={onNotNow}>
                  {NOT_NOW_LABEL}
                </CBtn>
              )}
            </>
          }
        />
      )}
      {screen === "joined" && <JoinedPanel status={status} readFailed={status === null && readFailed} settingsTeamRepo={settingsTeamRepo} reload={load} />}
      {screen === "choose" && (
        <>
          <ChoiceList<Path>
            label="Join or create a team"
            value={path}
            onChange={setPath}
            options={[
              ...named.map((repo) => ({ value: `team:${repo}` as Path, label: `Join ${repoName(repo)}`, hint: JOIN_HINT })),
              {
                value: "join",
                label: named.length > 0 ? JOIN_ANOTHER_LABEL : JOIN_LABEL,
                hint: named.length > 0 ? JOIN_ANOTHER_HINT : JOIN_GENERIC_HINT,
              },
              { value: "create", label: CREATE_LABEL, hint: "You'll be its owner, and invite people after." },
              { value: "none", label: NOT_NOW_LABEL, hint: NOT_NOW_HINT },
            ]}
          />
          {notice && (
            <p className="ux-setup-note" role="status">
              {notice}
            </p>
          )}
          {(path === "join" || path.startsWith("team:")) && (
            <JoinPanel
              key={path}
              only={path.startsWith("team:") ? path.slice(5) : undefined}
              onJoined={afterJoin}
              onGoGithub={onGoGithub}
              askFirst={askFirst}
            />
          )}
          {path === "create" && (
            <CreateTeamGate>{({ boundRepo }) => <CreatePanel onCreated={afterJoin} boundRepo={boundRepo} />}</CreateTeamGate>
          )}
        </>
      )}
    </>
  );
}

// ── The account (several signed in) ────────────────────────────────────────

/** The GitHub account a join uses: gh's active one unless another is
 *  chosen. Returns the login to send (null = the active one). */
function useJoinAccount(): { choices: string[]; account: string | null; setAccount: (a: string) => void } {
  const accounts = useGithubStatus((s) => s.status?.accounts ?? null);
  const remembered = useSettings((s) => s.settings.team?.account ?? null);
  const choices = accountChoices(accounts);
  const [picked, setPicked] = useState<string | null>(null);
  const current = picked ?? (remembered && choices.includes(remembered) ? remembered : (choices[0] ?? null));
  // With one account there is nothing to choose, and nothing is sent.
  return { choices, account: choices.length > 1 ? current : null, setAccount: setPicked };
}

function AccountRow({ choices, account, onChange }: { choices: string[]; account: string | null; onChange: (a: string) => void }) {
  if (choices.length < 2 || !account) return null;
  return (
    <Group label="GitHub account">
      <Row kind="choice" label="GitHub account" hint="The team remembers which of your accounts it uses.">
        <Select
          label="GitHub account"
          value={account}
          onChange={onChange}
          options={choices.map((c) => ({ value: c, label: c }))}
        />
      </Row>
    </Group>
  );
}

// ── Join ─────────────────────────────────────────────────────────────────

type JoinSheetState =
  | { stage: "join"; preview: Exclude<JoinPreview, { kind: "problem" }> }
  | { stage: "replace"; preview: Exclude<JoinPreview, { kind: "problem" }> };

function JoinPanel({
  onJoined,
  onGoGithub,
  askFirst,
  only,
}: {
  onJoined: () => Promise<void>;
  onGoGithub: () => void;
  askFirst?: { current: (() => boolean) | null };
  /** A team GitHub already listed, chosen by name: no lookup, no list. */
  only?: string;
}) {
  const { choices, account, setAccount } = useJoinAccount();
  const [detection, setDetection] = useState<JoinDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const detect = useCallback(async (refresh = false) => {
    setDetecting(true);
    try {
      setDetection(await teamJoinDetect(account, refresh));
    } catch (e) {
      setDetection({
        login: "",
        teams: [],
        scanned: 0,
        truncated: false,
        unanswered: 0,
        timedOut: false,
        problem: { kind: "other", words: "Plyloft couldn't look for your teams.", org: null, repo: null, accepted: false, details: words(e) },
      });
    } finally {
      setDetecting(false);
    }
  }, [account]);
  useEffect(() => {
    if (!only) void detect();
  }, [detect, only]);

  const [code, setCode] = useState("");
  const [fieldProblem, setFieldProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<JoinProblem | null>(null);
  /** What Look again re-asks: the last code or detected repo. */
  const lastAsk = useRef<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [sheet, setSheet] = useState<JoinSheetState | null>(null);
  const [joining, setJoining] = useState(false);

  const ask = useCallback(
    async (text: string) => {
      lastAsk.current = text;
      setAsking(text);
      setFieldProblem(null);
      setProblem(null);
      try {
        const preview = await teamJoinPreview(text, account);
        if (preview.kind === "problem") {
          if (isFieldProblem(preview.problem)) setFieldProblem(preview.problem.words);
          else setProblem(preview.problem);
        } else if (preview.kind === "ready" && preview.alreadyIn) {
          pushToast({ kind: "info", title: `You're already in the team at ${joinName(preview)}.` });
          await onJoined();
        } else {
          setSheet({ stage: "join", preview });
        }
      } catch (e) {
        setProblem({ kind: "other", words: "Plyloft couldn't ask GitHub about that team.", org: null, repo: null, accepted: false, details: words(e) });
      } finally {
        setAsking(null);
      }
    },
    [account, onJoined],
  );

  async function join(preview: Exclude<JoinPreview, { kind: "problem" }>, replace: boolean) {
    setJoining(true);
    try {
      const result = await teamJoinConfirm(
        {
          repo: preview.team.repo,
          acceptInvitation: preview.kind === "invited" ? preview.invitation.id : null,
          acceptWorkspaces: preview.kind === "ready" ? preview.workspaceInvites.map((w) => w.repo) : [],
          replace,
        },
        account,
      );
      setSheet(null);
      if (result.kind === "problem") {
        setProblem(result.problem);
        return;
      }
      const toast = joinedToast(result);
      pushToast({ kind: "info", title: toast.title, body: toast.body });
      await onJoined();
    } catch (e) {
      setSheet(null);
      setProblem({ kind: "other", words: "Plyloft couldn't join the team.", org: null, repo: preview.team.repo, accepted: false, details: words(e) });
    } finally {
      setJoining(false);
    }
  }

  const onProblemAction = (id: string) => {
    if (id === "authorise" && problem?.org) void setupOpenGithubSso(problem.org).catch(() => {});
    else if (id === "github") onGoGithub();
    else if (id === "check" && lastAsk.current) void ask(lastAsk.current);
  };

  const teams = detection?.teams.filter((t) => !t.current) ?? [];
  // Continue on Join (the footer's): what was typed, else the team chosen by
  // name, else the one team found. Never a dead press: it says what is
  // missing; a problem already said once lets the next press go on.
  const [notice, setNotice] = useState<string | null>(null);
  const saidLookup = useRef(false);
  useEffect(() => {
    if (!askFirst) return;
    askFirst.current = () => {
      if (asking !== null) return true;
      if (problem || fieldProblem) return false;
      if (code.trim()) {
        void ask(code);
        return true;
      }
      if (only) {
        void ask(only);
        return true;
      }
      if (detecting) {
        setNotice(STILL_LOOKING_LINE);
        return true;
      }
      if (detection?.problem) {
        if (saidLookup.current) return false;
        saidLookup.current = true;
        setNotice(LOOK_PROBLEM_LINE);
        return true;
      }
      if (teams.length === 1) {
        void ask(teams[0].repo);
        return true;
      }
      setNotice(teams.length > 1 ? CHOOSE_TEAM_LINE : PASTE_OR_CHOOSE_LINE);
      return true;
    };
    return () => {
      askFirst.current = null;
    };
  });
  const line = detection && !detection.problem ? detectionLine(detection) : null;
  const view = sheet ? joinSheet(sheet.preview) : null;

  return (
    <>
      <AccountRow choices={choices} account={account} onChange={setAccount} />
      {!only && detecting && <StatusLine state="running">{LOOKING}</StatusLine>}
      {!only && !detecting && teams.length > 0 && (
        <Group label={DETECTED_TEAMS_LABEL}>
          {teams.map((t) => {
            const row = detectedTeamRow(t, detection?.login);
            return (
              <Row
                key={t.repo}
                kind="procedure"
                label={row.title}
                hint={row.hint}
                action={
                  <CBtn tone="strong" disabled={asking !== null} onClick={() => void ask(t.repo)}>
                    {asking === t.repo ? "Checking…" : row.action}
                  </CBtn>
                }
              />
            );
          })}
        </Group>
      )}
      {!only && !detecting && line && <p className="ux-setup-note">{line}</p>}
      {!only && !detecting && detection && !detection.problem && (
        <CBtn tone="quiet" onClick={() => void detect(true)}>
          Look again
        </CBtn>
      )}
      {!only && !detecting && detection?.problem && !problem && (
        <ErrorBlock error={joinProblemError(detection.problem)} onAction={(id) => (id === "check" ? void detect(true) : onProblemAction(id))} />
      )}
      {!only && (
      <Section title={teams.length > 0 ? "Or paste your invite code" : CODE_LABEL}>
        <Group label={CODE_LABEL}>
          <Row
            kind="text"
            label="Invite code"
            hint={CODE_HINT}
            error={fieldProblem !== null}
            action={
              <CBtn
                tone="strong"
                disabled={!code.trim() || asking !== null}
                onClick={() => void ask(code)}
              >
                {asking === code ? "Checking…" : CODE_BUTTON}
              </CBtn>
            }
          >
            <TextField
              value={code}
              onChange={(next) => {
                setCode(next);
                setFieldProblem(null);
                setNotice(null);
              }}
              onEnter={(v) => {
                if (v.trim()) void ask(v);
              }}
              placeholder="ply-join:owner/team"
              label="Invite code"
              mono
              wide
              spellCheck={false}
              autoComplete="off"
            />
          </Row>
        </Group>
        {fieldProblem && <StatusLine state="aborted">{fieldProblem}</StatusLine>}
      </Section>
      )}
      {notice && (
        <p className="ux-setup-note" role="status">
          {notice}
        </p>
      )}
      {problem && <ErrorBlock error={joinProblemError(problem)} onAction={onProblemAction} busy={asking ? "check" : null} />}

      {sheet?.stage === "join" && view && (
        <Sheet
          title={view.title}
          size="review"
          onClose={() => !joining && setSheet(null)}
          canDismiss={!joining}
          actions={
            <>
              <CBtn tone="quiet" disabled={joining} onClick={() => setSheet(null)}>
                Cancel
              </CBtn>
              <CBtn
                tone="accent"
                disabled={joining}
                onClick={() =>
                  sheet.preview.replaces ? setSheet({ stage: "replace", preview: sheet.preview }) : void join(sheet.preview, false)
                }
              >
                {joining ? "Joining…" : view.confirm}
              </CBtn>
            </>
          }
        >
          {view.lines.map((l) => (
            <p key={l} className="ux-sheet-text">
              {l}
            </p>
          ))}
          {view.accepts.map((l) => (
            <p key={l} className="ux-sheet-text">
              {l}
            </p>
          ))}
          <Details summary="Details">
            <pre className="ux-output">{view.details.join("\n")}</pre>
          </Details>
        </Sheet>
      )}
      {sheet?.stage === "replace" && sheet.preview.replaces && (
        <ReplaceSheet
          preview={sheet.preview}
          joining={joining}
          onCancel={() => setSheet(null)}
          onReplace={() => void join(sheet.preview, true)}
        />
      )}
    </>
  );
}

function ReplaceSheet({
  preview,
  joining,
  onCancel,
  onReplace,
}: {
  preview: Exclude<JoinPreview, { kind: "problem" }>;
  joining: boolean;
  onCancel: () => void;
  onReplace: () => void;
}) {
  const words = replaceSheet(preview.replaces!, joinName(preview));
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      title={words.title}
      lede={machineWords(words.lede)}
      size="confirm"
      onClose={() => !joining && onCancel()}
      canDismiss={!joining}
      initialFocusRef={keep}
      actions={
        <>
          <CBtn ref={keep} tone="quiet" disabled={joining} onClick={onCancel}>
            Cancel
          </CBtn>
          <CBtn tone="accent" disabled={joining} onClick={onReplace}>
            {joining ? "Joining…" : words.confirm}
          </CBtn>
        </>
      }
    >
      <p className="ux-sheet-text">{machineWords(words.kept)}</p>
    </Sheet>
  );
}

// ── Create ───────────────────────────────────────────────────────────────

function CreatePanel({ onCreated, boundRepo }: { onCreated: () => Promise<void>; boundRepo: string | null }) {
  const accounts = useGithubStatus((s) => s.status?.accounts ?? null);
  const several = accountChoices(accounts).length > 1;
  const [login, setLogin] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  useEffect(() => {
    let live = true;
    teamCreateDefaults()
      .then((d) => live && setLogin(d.login))
      .catch(() => live && setLogin(null))
      .finally(() => live && setRead(true));
    return () => {
      live = false;
    };
  }, []);
  // Launch T1: a plan already bound to a repository sets that one up here.
  const [name, setName] = useState(() => boundRepo?.split("/")[1] ?? "");
  const [repoTyped, setRepoTyped] = useState<string | null>(boundRepo);
  const repo = repoTyped ?? suggestTeamRepo(login, name);
  const blocker = read ? createBlocker(name, repo, login) : "Reading your GitHub account…";
  const [asking, setAsking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<UxError | null>(null);
  const [ssoOrg, setSsoOrg] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await teamCreate(name.trim(), repo.trim(), []);
      setAsking(false);
      pushToast({
        kind: "info",
        title: created.alreadyExisted ? `“${created.name}” is already your team` : `“${created.name}” created`,
        body: created.alreadyExisted
          ? `${created.repo} was already finished and you own it, so Plyloft changed nothing on GitHub.`
          : `${created.repo} is private on GitHub, with the team's member list and an empty library. Invite people next.`,
      });
      // Launch T1: the repository is on GitHub; attaching it to the plan
      // failed — said, and "Finish creating your team" retries it.
      if (created.bindError) {
        pushErrorToast("The team isn't attached to your plan yet", created.bindError);
      }
      void useTeamBilling.getState().load();
      await onCreated();
    } catch (e) {
      setAsking(false);
      const text = words(e);
      const sso = ssoFromText(text);
      setError(createError(text));
      if (sso?.org) setSsoOrg(sso.org);
    } finally {
      setCreating(false);
    }
  }
  const sheet = createSheet(name, repo.trim());

  return (
    <>
      <Group label="Create a team">
        <Row kind="text" label="Team name" hint="What your teammates see, for example MB Adv.">
          <TextField value={name} onChange={setName} placeholder="MB Adv" label="Team name" />
        </Row>
        <Row kind="text" label="Repository" hint="Private, on GitHub. Plyloft suggests a name; you can change it.">
          <TextField
            value={repo}
            onChange={(v) => setRepoTyped(v)}
            placeholder="owner/name"
            label="Repository"
            mono
            wide
            spellCheck={false}
          />
        </Row>
        <Row
          kind="value"
          label="Owner"
          hint={
            several
              ? "Plyloft creates the team with GitHub's active account. To use another, make it the active one in the GitHub step."
              : "The team is created on this account, and you'll be its owner."
          }
        >
          <RowValue>{login ?? (read ? "Unknown" : "…")}</RowValue>
        </Row>
      </Group>
      {blocker && name.trim() !== "" && <StatusLine state="aborted">{blocker}</StatusLine>}
      <div className="ux-flow-actions">
        <CBtn tone="strong" disabled={blocker !== null || creating} onClick={() => setAsking(true)}>
          Create team
        </CBtn>
      </div>
      {error && (
        <ErrorBlock
          error={error}
          onAction={(id) => {
            if (id === "authorise" && ssoOrg) void setupOpenGithubSso(ssoOrg).catch(() => {});
          }}
        />
      )}
      {asking && (
        <Sheet
          title={sheet.title}
          lede={sheet.lede}
          size="confirm"
          onClose={() => !creating && setAsking(false)}
          canDismiss={!creating}
          actions={
            <>
              <CBtn tone="quiet" disabled={creating} onClick={() => setAsking(false)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" disabled={creating} onClick={() => void create()}>
                {creating ? "Creating…" : sheet.confirm}
              </CBtn>
            </>
          }
        >
          <Details summary="Details">
            <pre className="ux-output">{`gh repo create ${repo.trim()} --private\n(team.json, README.md, library/ — one commit, pushed)`}</pre>
          </Details>
        </Sheet>
      )}
    </>
  );
}

// ── Joined ───────────────────────────────────────────────────────────────

function JoinedPanel({
  status,
  readFailed,
  settingsTeamRepo,
  reload,
}: {
  status: TeamStatus | null;
  /** No read of the team has come back at all. */
  readFailed: boolean;
  settingsTeamRepo: string | null;
  reload: (network: boolean) => Promise<void>;
}) {
  // A team named but not cloned yet (just joined, or a key's team on a new
  // Mac): clone it and ask GitHub once.
  const asked = useRef(false);
  const [reading, setReading] = useState(false);
  const readAgain = useCallback(async () => {
    setReading(true);
    try {
      await reload(true);
    } finally {
      setReading(false);
    }
  }, [reload]);
  useEffect(() => {
    // Offline first: a clone on this Mac needs no network to show the team.
    if (asked.current || !status || status.hasClone) return;
    asked.current = true;
    void readAgain();
  }, [status, readAgain]);
  const repo = status?.teamRepo ?? settingsTeamRepo;
  const half = halfStateLine(status?.membership);
  const accountLogin = useAccount((s) => s.info?.login ?? null);
  const askLine = status
    ? askOwnerToInvite({ isOwner: status.isOwner, ownerLogin: status.ownerLogin, login: status.login, accountLogin })
    : null;
  return (
    <>
      <Callout kind="info" title={joinedLine(status?.teamName, repo)} text={half ?? undefined} />
      <TeamPlanNotice ownerLogin={status?.ownerLogin ?? null} isOwner={status?.isOwner ?? false} />
      {/* U27: the projects need the team's repository read here; while it
          isn't, the step says so and offers the read, for owner and member. */}
      {((status && !status.hasClone) || readFailed) && !reading && (
        <>
          <StatusLine state="aborted">{status?.error ?? TEAM_NOT_READ}</StatusLine>
          <div className="ux-flow-actions">
            <CBtn tone="quiet" onClick={() => void readAgain()}>
              {READ_IT_AGAIN}
            </CBtn>
          </div>
        </>
      )}
      {status && <TeamProjects status={status} reload={reload} />}
      {status?.isOwner && <InvitePeople onChanged={() => void reload(false)} />}
      {/* U4/U20: only the owner can invite, so only the owner sends the code. */}
      {repo && status?.isOwner && <CopyInvite name={status.teamName ?? null} />}
      {repo && status?.hasClone && askLine && <p className="ux-setup-note">{askLine}</p>}
    </>
  );
}

/** §5 step 6 Join 3: the team's projects, picked and cloned into the
 *  projects folder — asked inline when step 7 hasn't chosen one. */
function TeamProjects({ status, reload }: { status: TeamStatus; reload: (network: boolean) => Promise<void> }) {
  const folder = useSettings((s) => s.settings.projects?.folder ?? null);
  const cloneRoot = useSettings((s) => s.settings.team?.cloneRoot ?? null);
  // The account the team was joined with (the backend falls back to it too).
  const account = useSettings((s) => s.settings.team?.account ?? null);
  const askFolder = !folder && !cloneRoot;
  // Null until the person has chosen or pressed Get: the only project to get
  // starts ticked, and follows what the reads say until then.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [pending, setPending] = useState<JoinWorkspaceInvite[]>([]);
  // 1.176.2 (E1, S-6): a read that failed is not "no invitation is waiting".
  const [invitesFailed, setInvitesFailed] = useState(false);
  const [confirmInvites, setConfirmInvites] = useState<JoinWorkspaceInvite[] | null>(null);
  const [getting, setGetting] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    teamJoinWorkspaceInvites(account)
      .then((r) => {
        if (!live) return;
        setInvitesFailed(false);
        setPending(r.pending);
      })
      .catch(() => live && setInvitesFailed(true));
    return () => {
      live = false;
    };
  }, [status.teamRepo, account]);

  // U31: a project whose folder is gone can be got again.
  const open = status.workspaces.filter((w) => !w.registered || folderGone(w));
  const only = onlyProjectToGet(status.workspaces);
  const picked = chosen ?? (only ? [only] : []);
  // 1.175.0 F2: the same "Projects folder" row as "Your first project"
  // (`ProjectsFolderRow`), saved by the first Get.
  const folderChoice = useProjectsFolderChoice(askFolder && open.length > 0);
  if (status.workspaces.length === 0) {
    return status.hasClone ? <p className="ux-setup-note">The team doesn&apos;t share any projects yet.</p> : null;
  }

  /** The folder's write, when it wasn't done yet: the clone root kept first
   *  where team projects already are (lib/projectsFolder.ts), the folder
   *  made when it is missing, then `projects.folder` in tilde form. The
   *  team's clone reads the setting, so it is written for the attempt;
   *  F2 round 2: `undo` puts it back when nothing landed. */
  async function saveFolder(): Promise<(() => Promise<void>) | null> {
    const was = useSettings.getState().settings;
    const before = was.projects?.folder ?? null;
    if (before) return null;
    const rootBefore = was.team?.cloneRoot ?? null;
    await chooseProjectsFolder(folderChoice.folder);
    const rootWritten = useSettings.getState().settings.team?.cloneRoot ?? null;
    // F2 review (round 3): both go back — the folder, and the clone root the
    // safeguard pinned for it — each only while it is still what was written
    // here. A quit in the middle of the clone can't put them back.
    return async () => {
      await useSettings.getState().update((cur) => ({
        ...cur,
        projects: cur.projects?.folder === folderChoice.folder ? { ...cur.projects, folder: before } : cur.projects,
        team: rootWritten !== rootBefore && cur.team?.cloneRoot === rootWritten ? { ...cur.team, cloneRoot: rootBefore } : cur.team,
      }));
    };
  }

  async function get(repos: string[]) {
    const needs = pending.filter((i) => repos.some((r) => r.toLowerCase() === i.repo.toLowerCase()));
    if (needs.length > 0 && confirmInvites === null) {
      setConfirmInvites(needs);
      return;
    }
    setConfirmInvites(null);
    let undoFolder: (() => Promise<void>) | null = null;
    let landed = false;
    try {
      if (askFolder) undoFolder = await saveFolder();
      if (needs.length > 0) {
        const accepted = await teamJoinAcceptWorkspaces(
          needs.map((n) => n.repo),
          account,
        );
        setPending(accepted.pending);
        for (const f of accepted.failed) {
          pushToast({ kind: "error", title: `Couldn't accept the invitation to ${f.repo}`, details: f.words });
        }
      }
      // U7: the first project this press added is the one that opens.
      let firstAdded: string | null = null;
      for (const repo of repos) {
        setGetting(repo);
        try {
          const added = await teamWorkspaceAdd(repo);
          if (added.registered || added.cloned) landed = true;
          if ((added.registered || added.cloned) && firstAdded === null) firstAdded = added.path;
          pushToast({ kind: "info", title: addedTitle(added) });
        } catch (e) {
          pushErrorToast(`Couldn't get ${repo}`, e);
        }
      }
      setChosen([]);
      // F2 round 2: nothing landed — the folder setting goes back as it was.
      if (!landed && undoFolder) {
        await undoFolder().catch(() => {});
        undoFolder = null;
      }
      await useWorkspaces.getState().refresh();
      const opened = useWorkspaces.getState().workspaces.find((w) => w.cwd === firstAdded);
      // U7: shown, not only active: closing Setup lands on its Board, whatever
      // the app opens on otherwise.
      if (opened) {
        await useWorkspaces.getState().setActive(opened.id);
        openCenterMode(opened.id, "board");
      }
      await reload(false);
    } catch (e) {
      if (!landed && undoFolder) await undoFolder().catch(() => {});
      pushErrorToast("Couldn't get the team's projects", e);
    } finally {
      setGetting(null);
    }
  }

  const sheet = confirmInvites ? workspaceInviteSheet(confirmInvites) : null;
  return (
    <Section title="The team's projects" count={`${status.workspaces.length}`}>
      <CheckList label="The team's projects">
        {status.workspaces.map((w) => (
          <CheckRow
            key={w.repo}
            checked={(w.registered && !folderGone(w)) || picked.includes(w.repo)}
            disabled={(w.registered && !folderGone(w)) || w.conflict !== null || getting !== null}
            onChange={(on) => setChosen(on ? [...picked, w.repo] : picked.filter((r) => r !== w.repo))}
            note={
              folderGone(w)
                ? `${FOLDER_GONE_NOTE}. ${CLONE_AGAIN_LOSES_COPIES}`
                : folderNotRepository(w)
                ? FOLDER_NOT_REPOSITORY_NOTE
                : w.registered
                ? "Added"
                : w.conflict
                  ? w.conflict
                  : pending.some((p) => p.repo.toLowerCase() === w.repo.toLowerCase())
                    ? "Invitation waiting"
                    : undefined
            }
          >
            {w.name} <PChip>{w.repo}</PChip>
          </CheckRow>
        ))}
      </CheckList>
      {invitesFailed && (
        <p className="ux-setup-note" role="status" data-ply-invites-failed="">
          Plyloft couldn&apos;t look for invitations, so one that is waiting isn&apos;t marked. Leave this step and open it again to look once more.
        </p>
      )}
      {askFolder && open.length > 0 && <ProjectsFolderRow choice={folderChoice} disabled={getting !== null} />}
      {open.length > 0 && (
        <div className="ux-flow-actions">
          <CBtn
            tone="strong"
            disabled={picked.length === 0 || getting !== null || (askFolder && folderChoice.notAFolder)}
            onClick={() => void get(picked)}
          >
            {getting ? `Getting ${getting}…` : getProjectsLabel(picked.length || 0)}
          </CBtn>
        </div>
      )}
      {sheet && confirmInvites && (
        <Sheet
          title={sheet.title}
          size="confirm"
          onClose={() => setConfirmInvites(null)}
          actions={
            <>
              <CBtn tone="quiet" onClick={() => setConfirmInvites(null)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void get(picked)}>
                {sheet.confirm}
              </CBtn>
            </>
          }
        >
          {sheet.lines.map((l) => (
            <p key={l} className="ux-sheet-text">
              {l}
            </p>
          ))}
        </Sheet>
      )}
    </Section>
  );
}

/** Create › Invite people: the existing invite plan, confirmed in a sheet. */
function InvitePeople({ onChanged }: { onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [plan, setPlan] = useState<InvitePlan | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function review(login: string) {
    setChecking(true);
    try {
      setPlan(await teamInvitePlan(login.trim()));
    } catch (e) {
      pushErrorToast("Couldn't work out what to grant", e);
    } finally {
      setChecking(false);
    }
  }

  async function send() {
    if (!plan) return;
    setSending(true);
    setSendError(null);
    try {
      const outcome = await teamInviteApply(plan.login, plan.digest);
      setPlan(null);
      setDraft("");
      onChanged();
      pushToast({
        kind: outcome.failed.length > 0 ? "error" : "info",
        title: outcome.failed.length > 0 ? `${outcome.login}: some invitations were refused` : `${outcome.login} invited`,
        body: `${inviteOutcomeSummary(outcome)} Now send them the invite: press ${COPY_INVITE}.`,
      });
    } catch (e) {
      // U17: in the sheet, which stays open.
      setSendError(`Couldn't invite them. ${words(e)}`);
    } finally {
      setSending(false);
    }
  }

  const valid = isGithubLogin(draft);
  const grants = plan ? grantingSteps(plan).length : 0;
  const unresolved = plan ? unresolvedSteps(plan).length : 0;
  const noAccount = plan ? noAccountSteps(plan).length : 0;
  return (
    <Section title={INVITE_PEOPLE}>
      <Group label={INVITE_PEOPLE}>
        <Row
          kind="text"
          label="GitHub login"
          hint="Plyloft shows every repository and permission it would grant before it sends anything."
          action={
            <CBtn tone="strong" disabled={!valid || checking} onClick={() => void review(draft)}>
              {checking ? "Checking…" : "Review"}
            </CBtn>
          }
        >
          <TextField
            value={draft}
            onChange={setDraft}
            onEnter={(v) => {
              if (isGithubLogin(v)) void review(v);
            }}
            placeholder="their GitHub login"
            label="GitHub login"
            mono
          />
        </Row>
      </Group>
      {plan && (
        <Sheet
          title={`Invite ${plan.login} to ${plan.teamName}?`}
          lede={invitePlanSummary(plan)}
          size="review"
          onClose={() => {
            if (sending) return;
            setSendError(null);
            setPlan(null);
          }}
          canDismiss={!sending}
          actions={
            <>
              <CBtn
                tone="quiet"
                disabled={sending}
                onClick={() => {
                  setSendError(null);
                  setPlan(null);
                }}
              >
                Cancel
              </CBtn>
              <CBtn
                tone="accent"
                disabled={sending || noAccount > 0 || unresolved > 0 || (grants === 0 && !plan.addsToManifest)}
                onClick={() => void send()}
              >
                {sending ? "Sending…" : inviteSendLabel(plan)}
              </CBtn>
            </>
          }
        >
          {sendError && (
            <div role="alert">
              <StatusLine state="aborted">{sendError}</StatusLine>
            </div>
          )}
          <Group label="What Plyloft grants">
            {plan.steps.map((step) => (
              <Row
                key={step.repo}
                kind="item"
                label={step.repo}
                mono
                hint={`${step.kind === "team_repo" ? "The team repository" : "A team project"}.${step.action === "no_such_account" ? "" : ` GitHub gives them ${step.current} today.`}`}
                chips={
                  step.action === "grant" ? (
                    <PChip tone="warn">{`grant ${step.permission}`}</PChip>
                  ) : step.action === "no_such_account" ? (
                    <PChip tone="warn">{NO_ACCOUNT_CHIP}</PChip>
                  ) : step.action === "unresolved" ? (
                    <PChip>couldn&apos;t check</PChip>
                  ) : (
                    <PChip tone="ok">no change</PChip>
                  )
                }
              />
            ))}
          </Group>
          {plan.warnings.map((w) => (
            <StatusLine key={w} state="aborted">
              {w}
            </StatusLine>
          ))}
        </Sheet>
      )}
    </Section>
  );
}

/** §12.2: Copy invite — the code and its message on the clipboard, and the
 *  code on screen. */
function CopyInvite({ name }: { name: string | null }) {
  return (
    <Group label="Invite code">
      <CopyInviteRows name={name} />
    </Group>
  );
}
