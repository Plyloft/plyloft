// Launch T1–T3: what the team's plan says on a Mac that is in a team (Settings
// › Team and Setup's joined panel):
//
// - T3 no seat: "Ask <owner> to give you a seat" — reading the team and
//   getting its projects stay free;
// - D10: signed in to Plyloft as another account than the team's;
// - T1: the owner's repository exists but isn't attached to the plan yet
//   (the app closed, or the server couldn't be reached) — Finish creating
//   your team;
// - a lapsed team: "The team's plan has ended", Renew for the owner, the
//   owner's name for everybody else.
//
// The backend decides each of them (`license.rs::TeamAccess`, `GET /team`).
import { useEffect, useState } from "react";
import { CBtn, Callout, StatusLine } from "../ux";
import { useAccount } from "../../store/accountStore";
import { useTeamBilling } from "../../store/teamBillingStore";
import { CheckoutProgress, RenewChoice, SignInCallout } from "../setup/TeamCheckout";
import { teamBindCurrent } from "../../ipc";
import { useSettings } from "../../store/settingsStore";
import { openPlanSettings } from "../../store/planPrompts";
import {
  FINISH_TITLE,
  LAPSED_TITLE,
  checkoutErrorText,
  lapseNeedsPortal,
  lapsedPortalText,
  lapsedText,
  signedOutTeamNotice,
  teamForThisMac,
  teamLapsed,
  teamPlanPointer,
} from "../../lib/teamBilling";

const words = (e: unknown) => String((e as Error)?.message ?? e);

export function TeamPlanNotice({ ownerLogin, isOwner }: { ownerLogin: string | null; isOwner: boolean }) {
  const team = useAccount((s) => s.gates?.team ?? null);
  const refusal = useAccount((s) => s.gates?.teamRefusal ?? null);
  const signedIn = useAccount((s) => s.info?.signedIn ?? false);
  // A3 D21: known to be signed out (not merely not read yet).
  const signedOut = useAccount((s) => s.loaded && s.info !== null && !s.info.signedIn);
  // A3: signed in, Team on another computer or not chosen yet (unsigned: said, never a gate).
  const pointer = useAccount((s) => teamPlanPointer(s.info?.signedIn ? s.info.team : null));
  const role = useAccount((s) => s.info?.teamRole ?? null);
  const sub = useAccount((s) => s.info?.sub ?? null);
  const serverTeam = useTeamBilling((s) => s.billing?.team ?? null);
  const macTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  // P3-4: the server's team only when it is this Mac's.
  const billingTeam = teamForThisMac(serverTeam, macTeamRepo, sub);
  const step = useTeamBilling((s) => s.step);
  const error = useTeamBilling((s) => s.error);
  const errorFromCheckout = useTeamBilling((s) => s.errorFromCheckout);
  const portal = useTeamBilling((s) => s.portal);
  /** Renew without a known interval: the choice is asked here. */
  const [asking, setAsking] = useState(false);
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  useEffect(() => {
    if (signedIn) void useTeamBilling.getState().load();
  }, [signedIn]);

  async function finish() {
    setBinding(true);
    setBindError(null);
    try {
      await teamBindCurrent();
      await useAccount.getState().loadGates();
      void useTeamBilling.getState().load();
    } catch (e) {
      setBindError(words(e));
    } finally {
      setBinding(false);
    }
  }

  function renew(seats: number, interval: "month" | "year" | null | undefined) {
    const store = useTeamBilling.getState();
    store.setSeats(seats);
    // P3-1: the team's own interval when the server says; otherwise ask.
    if (interval) {
      store.setInterval(interval);
      void store.checkout();
    } else {
      setAsking(true);
    }
  }

  const lapsed = signedIn && billingTeam && teamLapsed(billingTeam) ? billingTeam : null;
  // The plan's owner is the account that pays (by GitHub id); the manifest's
  // owner is only the fallback when the account doesn't say.
  const lapsedOwner = lapsed
    ? sub
      ? lapsed.owner.sub === sub
      : isOwner && lapsed.owner.login.toLowerCase() === (ownerLogin ?? "").toLowerCase()
    : false;
  return (
    <>
      {signedOut && <SignInCallout title={signedOutTeamNotice(isOwner).title} text={signedOutTeamNotice(isOwner).text} />}
      {pointer && (
        <Callout
          kind="info"
          title={pointer}
          actions={<CBtn onClick={openPlanSettings}>See your plan</CBtn>}
        />
      )}
      {step !== "choose" && <CheckoutProgress />}
      {lapsed && step === "choose" && asking && lapsedOwner && (
        <RenewChoice
          renew={{ stage: "lapsed", owner: true, ownerLogin: lapsed.owner.login, teamRepo: lapsed.teamRepo, seats: lapsed.seats }}
          onCancel={() => setAsking(false)}
        />
      )}
      {lapsed && step === "choose" && !asking && (
        <Callout
          kind="warn"
          title={LAPSED_TITLE}
          text={
            lapsedOwner && lapseNeedsPortal(lapsed.status)
              ? lapsedPortalText()
              : lapsedText(lapsedOwner, lapsed.owner.login)
          }
          actions={
            !lapsedOwner ? undefined : lapseNeedsPortal(lapsed.status) ? (
              // P3-1: a payment to settle is the Portal's, not a new Checkout.
              <CBtn tone="strong" onClick={() => void portal()}>
                Open billing
              </CBtn>
            ) : (
              <CBtn tone="strong" onClick={() => renew(lapsed.seats, lapsed.interval)}>
                Renew
              </CBtn>
            )
          }
        />
      )}
      {lapsed && error && step === "choose" && !asking && (
        <StatusLine state="aborted">
          {errorFromCheckout ? (
            <>
              {checkoutErrorText(error)}{" "}
              <CBtn tone="quiet" onClick={() => void portal()}>
                Open billing
              </CBtn>
            </>
          ) : (
            error.message
          )}
        </StatusLine>
      )}
      {!lapsed && team?.state === "no_seat" && (
        <Callout
          kind="info"
          title={`Ask ${team.owner} to give you a seat`}
          text={`You can read the team and get its projects. Team features run for the members holding a seat on ${team.teamRepo}'s Team plan; ${team.owner} adds you in Settings › Team › Members and library.`}
        />
      )}
      {team?.state === "other_account" && (
        <Callout kind="warn" title="Signed in to Plyloft as another account" text={refusal ?? undefined} />
      )}
      {team?.state === "other_repo" && team.planRepo === null && role === "owner" && isOwner && (
        <Callout
          kind="info"
          title={FINISH_TITLE}
          text={`${team.teamRepo} is on GitHub but not attached to your Team plan yet. Plyloft attaches it; nothing changes on GitHub.`}
          actions={
            <CBtn tone="strong" disabled={binding} onClick={() => void finish()}>
              {binding ? "Finishing…" : "Finish"}
            </CBtn>
          }
        />
      )}
      {bindError && <StatusLine state="aborted">{bindError}</StatusLine>}
    </>
  );
}
