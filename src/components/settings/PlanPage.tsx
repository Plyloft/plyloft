import { useState } from "react";
import { CBtn, Callout, Group, Row, RowValue, Section, StatusLine } from "../ux";
import { SettingsPage } from "./rows";
import { useAccount } from "../../store/accountStore";
import { pushErrorToast } from "../../lib/errorToast";
import { accountRefresh, accountSignOutOthers, type AccountError } from "../../ipc";
import { pushToast } from "../../store/toastStore";
import { openBillingPortal, type PortalNote } from "../../lib/billingPortal";
import { confirmSheet } from "../../store/confirmStore";
import { moveTeamHere } from "../../store/planPrompts";
import { useUi } from "../../store/uiStore";
import { DEV_SKIP_NOTE, SIGNIN_ABOUT } from "../../lib/signIn";
import { machineWords } from "../../lib/platform";
import { useSettings } from "../../store/settingsStore";
import { GIVE_UP_ACTION, GIVE_UP_CONFIRM, gaveUpToast, giveUpSheet, refusedWords, seatElsewhere, seatElsewhereNotice } from "../../lib/teamLeave";
import { seatGiveUp } from "../../lib/teamLeaveIpc";
import { SignInBody, useSignInFlow } from "../setup/SignInStep";
import {
  MEMBER_BILLING,
  START_TEAM_HINT,
  THIS_DEVICE_HINT,
  USE_TEAM_BUSY,
  USE_TEAM_HERE,
  canManage,
  canStartTeam,
  fmtDateTime,
  isTeamMember,
  offlineNote,
  paymentProblem,
  paymentProblemText,
  planHint,
  planLine,
  planUnverified,
  planUnverifiedText,
  teamChoice,
  teamHere,
} from "../../lib/planPage";
import type { Scope } from "../../lib/settingsNav";

/**
 * Launch A3 (LAUNCH_PLAN §2 D12, D14–D16; §5): Settings › Account › Plan.
 *
 * Two sections (1.178.0, A3 "Struttura della pagina Plan"): *Your plan* —
 * the plan, Subscription or Billing for Team, *Start a team* for anyone not
 * on Team (signed out too) — and *Plyloft account* — the account row (Sign
 * in with GitHub, its code shown on this page, or Sign out), *This device*
 * only on the computer that holds Team, *Last checked* only while signed in.
 * A Team plan or seat active on another computer (D14), or ready and not
 * chosen (D15), is a calm callout under the lede with **Use Team on this
 * computer**. Free has no devices and no notices. Shown in solo mode too:
 * the plan is the person's. Team is bought from Settings › Team, which
 * "Start a team" opens.
 *
 * The backend decides the plan (`account.rs::AccountInfo`); the words are
 * `lib/planPage.ts`'s.
 */
export function PlanPage({ scope, hiddenNote }: { scope: Scope; hiddenNote?: string | null }) {
  const info = useAccount((s) => s.info);
  const devSkip = useAccount((s) => s.devSkip);
  const [note, setNote] = useState<PortalNote | null>(null);
  const [managing, setManaging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Check now's own failure (a keychain refusal, a server error), kept
   *  here — the account store's error belongs to sign-in. Offline is not one:
   *  it resolves, and the offline note says it. */
  const [checkError, setCheckError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signedIn = Boolean(info?.signedIn);
  const pastDue = paymentProblem(info);
  const pastDueText = paymentProblemText(info);
  // 1.178.0 (A3): both said only when the last verified plan was Team.
  const offline = offlineNote(info);
  const unverified = planUnverified(info) && info ? (offline ?? planUnverifiedText(info)) : null;
  // D14 / D15: Team on another computer, or ready and not chosen.
  const choice = teamChoice(info);
  const movingTeam = useAccount((s) => s.movingTeam);
  // D9: signing in runs here, its code shown on this page (SignInBody).
  const flow = useSignInFlow();
  const signInPrimary = !signedIn && !devSkip ? flow.view.primary : null;
  const signInUnderWay = !signedIn && !devSkip && (flow.view.code != null || flow.view.status != null);

  // 1.175.0 D5: the seat this account holds on a team this Mac isn't in.
  const macTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  const seatAway = seatElsewhere(info, macTeamRepo);
  const [givingUp, setGivingUp] = useState(false);
  const giveUp = async (teamRepo: string) => {
    const sheet = giveUpSheet(teamRepo);
    const yes = await confirmSheet({
      title: sheet.title,
      body: machineWords(sheet.lede),
      confirmLabel: GIVE_UP_CONFIRM,
      // Cancel has the focus; the accepting button isn't red: nothing in use is lost.
      cautious: true,
    });
    if (!yes) return;
    setGivingUp(true);
    try {
      await seatGiveUp();
      pushToast({ kind: "info", ...gaveUpToast(teamRepo) });
    } catch (e) {
      pushToast({ kind: "error", title: "Couldn't give up the seat", body: machineWords(refusedWords(e, true)) });
    } finally {
      setGivingUp(false);
    }
  };

  const checkNow = async () => {
    setRefreshing(true);
    setCheckError(null);
    try {
      const next = await accountRefresh();
      useAccount.setState({ info: next, loaded: true });
    } catch (e) {
      setCheckError((e as AccountError)?.message ?? String(e));
    } finally {
      setRefreshing(false);
    }
  };


  const manage = async () => {
    setManaging(true);
    setNote(null);
    try {
      setNote(await openBillingPortal());
    } finally {
      setManaging(false);
    }
  };
  const [signingOutOthers, setSigningOutOthers] = useState(false);
  const signOutOthers = async () => {
    const yes = await confirmSheet({
      title: "Sign out your other computers?",
      body: "Every other computer signed in to your Plyloft account is signed out and needs a new sign-in. This one stays signed in. Use it if you no longer have a computer, or don't know one.",
      confirmLabel: "Sign out other computers",
      // Lane 2 Mac walk: destructive — Cancel takes focus, Enter is safe.
      destructive: true,
    });
    if (!yes) return;
    setSigningOutOthers(true);
    try {
      const n = await accountSignOutOthers();
      pushToast({
        kind: "info",
        title: n === 0 ? "No other computer was signed in" : n === 1 ? "1 other computer signed out" : `${n} other computers signed out`,
      });
    } catch (e) {
      pushErrorToast("Other computers weren't signed out", e);
    } finally {
      setSigningOutOthers(false);
    }
  };

  const signOut = async () => {
    const yes = await confirmSheet({
      title: "Sign out of Plyloft?",
      body: machineWords("Everything for one person keeps working. Team features turn off on this Mac until you sign in again."),
      confirmLabel: "Sign out",
    });
    if (!yes) return;
    setSigningOut(true);
    try {
      await useAccount.getState().signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const status = (
    <>
      {!signedIn && devSkip && <StatusLine state="empty">{DEV_SKIP_NOTE}</StatusLine>}
      {/* A3 D14 / D15: calm — the icon carries the colour, the button is
          bordered; individual work goes on here either way. */}
      {choice && (
        <Callout
          kind="info"
          title={choice.title}
          text={machineWords(choice.text)}
          actions={
            <CBtn disabled={movingTeam} onClick={() => void moveTeamHere()}>
              {movingTeam ? USE_TEAM_BUSY : USE_TEAM_HERE}
            </CBtn>
          }
        />
      )}
      {/* 1.175.0 D5 (SRV-2): a seat on a team this Mac never joined — the
          way out is here, not a request to somebody else. Calm: nothing in
          use is lost, so the notice is an `info` and its button bordered. */}
      {seatAway && (
        <Callout
          kind="info"
          title={seatElsewhereNotice(seatAway).title}
          text={seatElsewhereNotice(seatAway).text}
          actions={
            // With the D14 / D15 callout above, Use Team on this computer is the
            // page's one bordered action; giving the seat up is quiet then.
            <CBtn tone={choice ? "quiet" : undefined} disabled={givingUp} onClick={() => void giveUp(seatAway)}>
              {GIVE_UP_ACTION}
            </CBtn>
          }
        />
      )}
      {unverified && (
        <Callout
          kind="warn"
          title="Your plan isn't checked"
          text={machineWords(unverified)}
          actions={
            <CBtn tone="strong" disabled={refreshing} onClick={() => void checkNow()}>
              {refreshing ? "Checking…" : "Check now"}
            </CBtn>
          }
        />
      )}
      {pastDueText && <StatusLine state="aborted">{pastDueText}</StatusLine>}
      {offline && !unverified && <StatusLine state="empty">{offline}</StatusLine>}
      {note && <StatusLine state={note.tone}>{note.text}</StatusLine>}
      {checkError && <StatusLine state="aborted">{checkError}</StatusLine>}
    </>
  );

  return (
    <SettingsPage entry="plan" scope={scope} hiddenNote={hiddenNote} status={status}>
      <Section title="Your plan" scope="account">
        <Group>
          <Row kind="value" label="Plan" readOnly hint={planHint(info)}>
            <RowValue>{planLine(info)}</RowValue>
          </Row>
          {canManage(info) && (
            <Row
              kind="procedure"
              label="Subscription"
              hint={
                pastDue
                  ? "Stripe couldn't take the last payment and is trying again. Your plan stays meanwhile; update your card in the billing portal."
                  : "Payment method, invoices, monthly or yearly, and cancelling, in Stripe's billing portal."
              }
              action={
                <CBtn
                  tone={pastDue ? "accent" : "ghost"}
                  disabled={managing}
                  onClick={() => void manage()}
                >
                  {managing ? "Opening…" : "Manage subscription"}
                </CBtn>
              }
            />
          )}
          {isTeamMember(info) && (
            <Row kind="value" label="Billing" readOnly hint={MEMBER_BILLING}>
              <RowValue>the team owner</RowValue>
            </Row>
          )}
          {canStartTeam(info) && (
            <Row
              kind="procedure"
              label="Start a team"
              hint={START_TEAM_HINT}
              action={
                <CBtn onClick={() => useUi.getState().openSettingsSection("team-workspaces")}>
                  Open Team
                </CBtn>
              }
            />
          )}
        </Group>
      </Section>

      {/* A3 D25: the second section is the account; This device is a Team row. */}
      <Section title="Plyloft account" scope="account">
        <Group>
          <Row
            kind="value"
            label="Plyloft account"
            readOnly
            hint={
              signedIn
                ? "Your GitHub sign-in, used only to start or join a team. This is separate from the GitHub accounts Plyloft uses for pull requests."
                : SIGNIN_ABOUT
            }
            action={
              signedIn ? (
                <CBtn disabled={signingOut} onClick={() => void signOut()}>
                  Sign out
                </CBtn>
              ) : signInPrimary ? (
                // D9: bordered, not accent — signing in stays optional.
                <CBtn
                  disabled={signInPrimary.disabled}
                  onClick={() => void flow.run(signInPrimary.action)}
                >
                  {signInPrimary.label}
                </CBtn>
              ) : undefined
            }
          >
            <RowValue mono>{signedIn ? (info?.login ?? "?") : "not signed in"}</RowValue>
          </Row>
          {teamHere(info) && (
            <Row
              kind="value"
              label="This device"
              readOnly
              hint={THIS_DEVICE_HINT}
              action={
                <CBtn disabled={signingOutOthers} onClick={() => void signOutOthers()}>
                  {signingOutOthers ? "Signing out…" : "Sign out other computers"}
                </CBtn>
              }
            >
              <RowValue>{info?.deviceName ?? "—"}</RowValue>
            </Row>
          )}
          {signedIn && (
            <Row
              kind="value"
              label="Last checked"
              readOnly
              hint={
                offline ??
                "Plyloft asks for your plan every 6 hours, and when you come back to its window."
              }
              action={
                <CBtn disabled={refreshing} onClick={() => void checkNow()}>
                  {refreshing ? "Checking…" : "Check now"}
                </CBtn>
              }
            >
              <RowValue>{info?.lastCheckedAt ? fmtDateTime(info.lastCheckedAt) : "not yet"}</RowValue>
            </Row>
          )}
        </Group>
        {/* D9: the code, its progress and Cancel, under the row. */}
        {signInUnderWay && <SignInBody flow={flow} action={false} />}
      </Section>
    </SettingsPage>
  );
}
