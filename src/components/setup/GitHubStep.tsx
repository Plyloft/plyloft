// OB-7a (ONBOARDING_SPEC §5 step 5), reshaped by 1.175.0 F1 (UX-2): Setup's
// "GitHub for your projects" step, now right after the Plyloft account.
//
// Three rows with no button of their own — the GitHub command, the account,
// Git using that sign-in — and one footer button, `Connect GitHub`, handed
// up through `onPrimary`. It opens **one** consent sheet naming what is
// still missing (install, sign-in, Git using the sign-in); nothing runs
// before its press. Then the parts run in order in the guided runner, whose
// terminal stays closed under Details: the code is shown in its own block,
// with the button that opens github.com. Git's part follows the sign-in
// once Plyloft has read again whether Git still needs it; on a computer
// without Git the yes is remembered (`onboarding.gitHelperConsented`) and
// the Git step does it. A quiet `Update` (D6) and `Add another account`
// stay on their rows; the missing-scopes fix and the single sign-on message
// are callouts; the identity back-fill is offered only when Setup is opened
// again from Settings (the Git step starts from GitHub's address).
//
// Plyloft never reads, stores or shows a token here: Rust's read keeps the
// login, state and scopes only, and agent terminals never get one (D7).
//
// The words and states are pure in `lib/githubStep.ts`.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CBtn,
  Callout,
  Details,
  ErrorBlock,
  Group,
  Row,
  Section,
  Sheet,
  StateWord,
} from "../ux";
import { SetupTerminal } from "../SetupTerminal";
import { IdentitySheet } from "./IdentitySheet";
import { useDoctor } from "../../store/doctorStore";
import { useSetupRun } from "../../store/setupRunStore";
import { useGithubStatus } from "../../store/githubStatusStore";
import { useSetup } from "../../store/setupStore";
import { useSettings } from "../../store/settingsStore";
import { useUi } from "../../store/uiStore";
import { machineWords, platform } from "../../lib/platform";
import { hasPathOverride } from "../../lib/diagnostics";
import {
  setupIdentityWrite,
  setupOpenGithubSso,
  setupOpenPage,
  type IdentityWritten,
  type SetupRunActionId,
} from "../../ipc";
import {
  CODE_HINT,
  CONNECT_GROUP,
  connectDownloadLine,
  ENTERPRISE_NOTE,
  FOOTER_LABEL,
  SCOPE_LINE,
  SKIP_GITHUB_NOTE,
  SSH_NOTE,
  TEAM_NEEDS_GITHUB,
  TOKEN_NOTE,
  accountRow,
  expectedAccountView,
  backfillAddress,
  backfillLine,
  connectFooter,
  connectLine,
  connectParts,
  connectRows,
  connectRuns,
  consentCovers,
  keepHelperYes,
  connectSheet,
  ghInstallFailure,
  ghRow,
  ghUpdateSheet,
  githubConnected,
  helperHint,
  helperNeed,
  isGithubAction,
  missingScopes,
  ssoLine,
  type ConnectPart,
} from "../../lib/githubStep";
import { signInEnd } from "../../lib/setupRun";
import type { StepPrimary } from "./GitStep";

export { GITHUB_TITLE, GITHUB_WHY } from "../../lib/githubStep";

type SheetKind = "connect" | "update" | "backfill" | null;

/** Remember, or forget, the yes to letting Git use the sign-in once Git is
 *  installed (`onboarding.gitHelperConsented`). Never throws. */
export function rememberGitHelperConsent(yes: boolean): void {
  const settings = useSettings.getState();
  if (Boolean(settings.settings.onboarding?.gitHelperConsented) === yes) return;
  void settings
    .update((cur) => ({ ...cur, onboarding: { ...cur.onboarding, gitHelperConsented: yes } }))
    .catch((e) => console.warn("setup: the yes for Git's sign-in wasn't saved", e));
}

export function GitHubStep({
  guided,
  team,
  autoConnect,
  gitWorks,
  gitStepNumber,
  rerun = false,
  onPrimary,
  onDone,
}: {
  /** Step by step: the "What is GitHub?" block. */
  guided: boolean;
  /** Team mode: "Your team needs GitHub." */
  team: boolean;
  /** The fast checklist's `Connect GitHub`: start connecting as the step
   *  opens (once). */
  autoConnect?: boolean;
  /** Git answers on this computer; false: its part waits for the Git step. */
  gitWorks: boolean | null;
  /** The Git step's number in the list on screen ("in step 5"). */
  gitStepNumber: number | null;
  /** Setup opened again from Settings: the identity back-fill is offered. */
  rerun?: boolean;
  /** The footer's primary for this step; null when the step leaves. */
  onPrimary: (primary: StepPrimary | null) => void;
  /** Move on (the next step, or back to the checklist). */
  onDone: () => void;
}) {
  const windows = platform() === "windows";
  const report = useDoctor((s) => s.report);
  const ghTool = report?.tools.find((t) => t.id === "gh") ?? null;
  // 1.176.1: a missing tool or a command not found points to Program folders when it is set.
  const programFoldersSet = useSettings((s) => hasPathOverride(s.settings.shell.pathOverride));
  const gh = ghRow(ghTool, report !== null, windows, programFoldersSet);

  const status = useGithubStatus((s) => s.status);
  const refresh = useGithubStatus((s) => s.refresh);
  const reading = useGithubStatus((s) => s.reading);
  const connected = githubConnected(status);
  const account = accountRow(status);
  // F16c: the account Settings › Team asked to sign in (the team's).
  const expectedAccount = useSetup((s) => s.githubAccount);
  const expected = expectedAccountView(status, expectedAccount);

  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const outcome = useSetupRun((s) => s.outcome);
  const tail = useSetupRun((s) => s.tail);
  const evidence = useSetupRun((s) => s.evidence);
  const runError = useSetupRun((s) => s.error);
  const ghRun = run && isGithubAction(run.actionId) ? run : null;
  const running = ghRun !== null && phase !== "done";
  const [started, setStarted] = useState(false);

  // Read on showing, when gh appears or goes, and after each of this
  // step's runs ends (a sign-in, setup-git, a refresh, an install).
  const ghFound = Boolean(ghTool?.found);
  /** The step's own read has answered at least once since it showed. */
  const [readAnswered, setReadAnswered] = useState(false);
  useEffect(() => {
    let live = true;
    void refresh(true).then(() => {
      if (live) setReadAnswered(true);
    });
    return () => {
      live = false;
    };
  }, [refresh, ghFound]);
  const endedRun = ghRun && phase === "done" ? ghRun.runId : null;
  /** The run whose end the step has read GitHub's state after. */
  const [readAfter, setReadAfter] = useState<string | null>(null);
  useEffect(() => {
    if (!endedRun) return;
    let live = true;
    void refresh(true).then(() => {
      if (live) setReadAfter(endedRun);
    });
    return () => {
      live = false;
    };
  }, [endedRun, refresh]);

  // ── What is missing, and the one yes ───────────────────────────────
  const need = helperNeed(gitWorks, status);
  const kept = useSettings((s) => Boolean(s.settings.onboarding?.gitHelperConsented));
  const parts = connectParts(gh.state === "ready", connected, need, kept);
  const later = need === "later";
  /** What the last yes covered (the sheet's parts, or the sign-in that
   *  starts at once). Null: nothing was agreed to in this visit. */
  const [consent, setConsent] = useState<ConnectPart[] | null>(null);
  /** Git's part was started for the yes in force: never twice. */
  const helperStarted = useRef(false);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const sheetWords = connectSheet({ parts, helper: need, windows, installCommand: gh.command, gitStepNumber });

  const startRun = useCallback(async (ids: SetupRunActionId[]) => {
    setSheet(null);
    if (ids.length === 0) return;
    setStarted(true);
    await useSetupRun.getState().startSequence(ids);
  }, []);

  /** F1 round 2: the yes to Git's part (no Git yet) waits for the sign-in
   *  to succeed before it is kept for the Git step. */
  const keepOnSignIn = useRef(false);

  /** Yes to what the sheet named (or the sign-in alone): it runs, in order. */
  const agree = useCallback(
    (agreed: ConnectPart[], helperLater: boolean) => {
      setConsent(agreed);
      helperStarted.current = agreed.length === 1 && agreed[0] === "helper";
      // Without Git, its part is done by the Git step: the yes is kept —
      // at once when an account is already signed in, else only once the
      // sign-in succeeds (F1 round 2).
      const keep = keepHelperYes({ agreedHelperLater: agreed.includes("helper") && helperLater, connectedAtPress: connected === true });
      keepOnSignIn.current = keep === "on-sign-in";
      if (keep === "now") rememberGitHelperConsent(true);
      void startRun(connectRuns(agreed, helperLater));
    },
    [startRun, connected],
  );

  const connect = useCallback(() => {
    if (parts.length === 0) return;
    // A sign-in alone installs nothing and changes nothing here: it starts
    // at once (§4 principle 2). Anything else is named in the sheet first.
    if (sheetWords === null) agree([...parts], false);
    else setSheet("connect");
  }, [parts, sheetWords, agree]);

  // How the step's last run ended.
  const ended = ghRun !== null && phase === "done";
  const end = ended ? signInEnd(ghRun.actionId, outcome, tail) : null;
  const failedRun = ended && outcome !== "succeeded" && end === null;

  // Git's part, after the sign-in: only with the yes, only once, and only
  // if Git still needs it now that Plyloft has read again (on Windows, Git
  // Credential Manager may already answer for this account).
  useEffect(() => {
    if (!consent?.includes("helper") || helperStarted.current) return;
    if (running || connected !== true || need !== "needed") return;
    if (!ghRun || outcome !== "succeeded" || readAfter !== ghRun.runId || reading) return;
    helperStarted.current = true;
    void startRun(["setupgit.gh"]);
  }, [consent, running, connected, need, ghRun, outcome, readAfter, reading, startRun]);

  // The person stopped the sign-in: the yes goes with it, the kept one too.
  useEffect(() => {
    if (end !== "stopped") return;
    setConsent(null);
    rememberGitHelperConsent(false);
  }, [end, endedRun]);

  // F1 round 2: the yes for later is kept only when the sign-in succeeds.
  // Any other end — expired, stopped, failed (an install that failed never
  // reaches it) — keeps nothing; Setup closed before it finished never
  // gets here.
  useEffect(() => {
    if (!endedRun || !ghRun || !keepOnSignIn.current) return;
    const signIn = ghRun.actionId === "login.gh" || ghRun.actionId === "add-account.gh";
    if (outcome === "succeeded" && !signIn) return;
    keepOnSignIn.current = false;
    rememberGitHelperConsent(outcome === "succeeded" && signIn);
  }, [endedRun, ghRun, outcome]);

  // The checklist's Connect GitHub, once the doctor and the step's own read
  // have answered (Challenger P3-3): an account already signed in starts
  // nothing, and a read still out may be about to say so — an earlier
  // answer (Setup's own read on opening) doesn't count.
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoConnect || autoDone.current || !report || !readAnswered || status === null || reading) return;
    autoDone.current = true;
    if (connected !== true) connect();
  }, [autoConnect, report, readAnswered, status, reading, connected, connect]);

  // ── The identity back-fill (Setup opened again from Settings) ──────
  const reported = report?.gitIdentity ?? null;
  const offer = backfillAddress(reported?.email, status?.githubEmail ?? null, status?.githubNoreply ?? null);
  const [pending, setPending] = useState<IdentityWritten | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const askBackfill = () => {
    if (!offer || !reported?.name) return;
    setSaveError(null);
    setPending({ name: reported.name, email: offer });
    setSheet("backfill");
  };
  const saveBackfill = async () => {
    if (!pending) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setupIdentityWrite(pending.name, pending.email);
      setSheet(null);
      void useDoctor.getState().refresh().catch(() => {});
    } catch (e) {
      setSaveError(typeof e === "string" ? e : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── The footer's one button ────────────────────────────────────────
  const foot = connectFooter({ reported: report !== null, running, parts, failed: failedRun, signInEnd: end });
  // After an error or an expired code the same yes still stands; without
  // one in this visit (the step was left and opened again) it is asked.
  // F1 round 2: only when that yes covers everything missing now.
  const again = (foot === "try-again" || foot === "new-code") && consentCovers(consent, parts);
  const shownFoot = foot === "try-again" || foot === "new-code" ? (again ? foot : "connect") : foot;
  const primary: StepPrimary = gh.programFolders
    ? // 1.176.1 walk: never an installer for a gh that may exist.
      { label: "Open Program folders", onClick: () => useUi.getState().openSettingsSection("editor-terminals", { row: "Program folders", focus: true }) }
    : shownFoot === null
      ? { label: FOOTER_LABEL.connect, onClick: () => {}, disabled: true }
      : shownFoot === "continue"
        ? { label: FOOTER_LABEL.continue, onClick: onDone }
        : shownFoot === "connect"
          ? { label: FOOTER_LABEL.connect, onClick: connect, disabled: status === null && reading }
          : { label: FOOTER_LABEL[shownFoot], onClick: () => void startRun(connectRuns(parts, later)) };
  const click = useRef(primary.onClick);
  click.current = primary.onClick;
  const stableClick = useCallback(() => click.current(), []);
  useEffect(() => {
    onPrimary({ label: primary.label, disabled: primary.disabled, onClick: stableClick });
  }, [onPrimary, primary.label, primary.disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  const failure =
    ghRun && phase === "done" ? ghInstallFailure(ghRun.actionId, outcome, gh.command ?? ghRun.display, tail, evidence, programFoldersSet) : null;
  /** The step's run under way (its actions are the GitHub command's). */
  const runningId = running && isGithubAction(ghRun.actionId) ? ghRun.actionId : null;
  const scopes = connected === true && missingScopes(status?.accounts ?? null);
  const rows = connectRows({
    gh,
    account,
    helper: need,
    running: runningId,
    started,
    halted: ended && parts.length > 0,
    signInEnd: end,
    gitStepNumber,
    // N14 item 7: what Git Credential Manager holds, against the account
    // Setup uses (Windows).
    helperHint: helperHint(status?.helper ?? "none", status?.gcm ?? null, status?.accounts?.find((a) => a.active)?.login ?? null),
  });
  const line = connectLine({
    running: runningId,
    signInEnd: end,
    complete: report !== null && parts.length === 0 && connected === true,
  });

  const plan = !started && !running && connected !== true;
  const rowsGroup = (
    <Group label={plan ? CONNECT_GROUP : "GitHub"}>
        {rows.map((row) => (
          <Row
            key={row.key}
            kind="value"
            label={row.label}
            hint={row.hint ? machineWords(row.hint) : undefined}
            action={
              row.key === "gh" && gh.state === "ready" && gh.update ? (
                <CBtn tone="quiet" onClick={() => setSheet("update")} disabled={running}>
                  Update
                </CBtn>
              ) : row.key === "account" && account.action?.id === "add-account.gh" ? (
                <CBtn tone="quiet" onClick={() => void startRun(["add-account.gh"])} disabled={running}>
                  {expected ? expected.label : account.action.label}
                </CBtn>
              ) : undefined
            }
          >
            {row.word && (
              <StateWord state={row.word.state} live={row.word.state === "running"}>
                {row.word.text}
              </StateWord>
            )}
          </Row>
        ))}
        {rerun && connected === true && offer && reported?.email && (
          <Row
            kind="value"
            label="Your commit email"
            hint={backfillLine(reported.email)}
            action={
              <CBtn tone="quiet" onClick={askBackfill} disabled={!reported.name}>
                Use my GitHub address
              </CBtn>
            }
          />
        )}
      </Group>
  );

  return (
    <>
      {team && <p className="ux-setup-note">{TEAM_NEEDS_GITHUB}</p>}
      {expected && (
        <p className="ux-setup-note" data-ply-expected-account>
          {machineWords(expected.note)}
        </p>
      )}
      {guided && (
        <Details summary="What is GitHub?">
          <p className="ux-setup-note">
            A website that keeps your projects&apos; history online. Plyloft talks to it through the GitHub CLI, a
            small program from GitHub, with your own account.
          </p>
        </Details>
      )}

      {/* Before anything started the rows are the plan, under its heading;
          after, they are the three things with their state. */}
      {plan ? <Section title={CONNECT_GROUP}>{rowsGroup}</Section> : rowsGroup}
      {connected !== true && (() => {
        const download = connectDownloadLine(gh.state === "missing" && !gh.programFolders && !running, gh.via);
        return download ? <p className="ux-setup-note">{machineWords(download)}</p> : null;
      })()}
      {connected !== true && <p className="ux-setup-note">{machineWords(SKIP_GITHUB_NOTE)}</p>}

      {scopes && (
        <Callout
          kind="warn"
          text={SCOPE_LINE}
          actions={
            <CBtn tone="strong" onClick={() => void startRun(["refresh.gh"])} disabled={running}>
              Fix
            </CBtn>
          }
        />
      )}
      {status?.sso && (
        <Callout
          kind="warn"
          text={ssoLine(status.sso.org)}
          actions={
            status.sso.org ? (
              <CBtn tone="strong" onClick={() => void setupOpenGithubSso(status.sso!.org!).catch(() => {})}>
                Authorize
              </CBtn>
            ) : undefined
          }
        />
      )}

      {(ghRun || (started && runError)) && <SetupTerminal quiet line={line} codeHint={CODE_HINT} />}
      {failure && (
        <ErrorBlock
          error={failure}
          busy={running ? "retry" : null}
          onAction={(id) => {
            // Try again needs no second yes: the same parts, as agreed.
            if (id === "retry") {
              if (ghRun?.actionId === "update.gh") setSheet("update");
              else if (consentCovers(consent, parts)) void startRun(connectRuns(parts, later));
              else connect();
            } else void setupOpenPage("install-gh").catch(() => {});
          }}
        />
      )}

      <Details summary="About this sign-in">
        <p className="ux-setup-note">{TOKEN_NOTE}</p>
        <p className="ux-setup-note">{SSH_NOTE}</p>
        <p className="ux-setup-note">{ENTERPRISE_NOTE}</p>
      </Details>

      {sheet === "connect" && sheetWords && (
        <ConnectSheet
          words={sheetWords}
          onCancel={() => setSheet(null)}
          onConnect={() => agree([...parts], need === "later")}
        />
      )}

      {sheet === "update" && gh.update && (
        <Sheet
          size="confirm"
          title={ghUpdateSheet(gh.update.detail).title}
          lede={ghUpdateSheet(gh.update.detail).lede}
          onClose={() => setSheet(null)}
          actions={
            <>
              <CBtn tone="quiet" onClick={() => setSheet(null)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void startRun(["update.gh"])}>
                Update
              </CBtn>
            </>
          }
        >
          <Details summary="Details">
            <pre className="ux-output">{gh.update.command}</pre>
          </Details>
        </Sheet>
      )}

      {sheet === "backfill" && pending && (
        <IdentitySheet
          pending={pending}
          from={{ name: reported?.name ?? null, email: reported?.email ?? null }}
          saving={saving}
          error={saveError}
          onCancel={() => setSheet(null)}
          onSave={() => void saveBackfill()}
        />
      )}
    </>
  );
}

/** F1: the one consent sheet. It names everything Connect GitHub will do;
 *  the focus is on Cancel, and nothing runs before the other button. */
function ConnectSheet({
  words,
  onCancel,
  onConnect,
}: {
  words: NonNullable<ReturnType<typeof connectSheet>>;
  onCancel: () => void;
  onConnect: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      size="confirm"
      title={machineWords(words.title)}
      lede={machineWords(words.lede)}
      onClose={onCancel}
      initialFocusRef={cancel}
      actions={
        <>
          <CBtn ref={cancel} tone="quiet" onClick={onCancel}>
            Cancel
          </CBtn>
          <CBtn tone="accent" onClick={onConnect}>
            {words.confirm}
          </CBtn>
        </>
      }
    >
      {words.items.length > 0 && (
        <ol className="ux-sheet-list ux-setup-sheet-list" data-ply-connect-parts="">
          {words.items.map((item) => (
            <li key={item.part} data-ply-connect-part={item.part}>
              <b>{item.title}</b>
              <span>{machineWords(item.body)}</span>
            </li>
          ))}
        </ol>
      )}
      {words.note && <p className="ux-setup-note">{words.note}</p>}
      <Details summary="Details">
        <pre className="ux-output">{words.commands.join("\n")}</pre>
      </Details>
    </Sheet>
  );
}

/** Team mode's `Skip for now` (D14): the Team step waits for GitHub. */
export function SkipGithubSheet({
  onKeep,
  onSkip,
  words,
}: {
  onKeep: () => void;
  onSkip: () => void;
  words: { title: string; lede: string; confirm: string; cancel: string };
}) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      size="confirm"
      title={words.title}
      lede={words.lede}
      onClose={onKeep}
      initialFocusRef={keep}
      actions={
        <>
          <CBtn onClick={onSkip}>{words.confirm}</CBtn>
          <CBtn ref={keep} tone="accent" onClick={onKeep}>
            {words.cancel}
          </CBtn>
        </>
      }
    />
  );
}
