// Launch T1 (D17): Create team pays first. Setup › Your team and Settings ›
// Team › Create a team both draw this in front of their create form:
//
// - choose seats (2–50, the owner's included) and monthly or yearly, with the
//   prices, then Checkout opens in the browser;
// - "Waiting for the payment…" while the app asks for the plan (two minutes),
//   then "If you paid, your plan will appear shortly" with Look again;
// - once the account is a Team owner with no repository (paid now, paid
//   before a restart, or a comp owner), the create form — "Finish creating
//   your team" when it wasn't paid in this session.
//
// The stage is the backend's (`team_billing::create_stage`); this file only
// draws it. An abandoned Checkout leaves nothing: no repository is created
// before the plan says Team.
import { useEffect, useState, type ReactNode } from "react";
import { CBtn, Callout, ChoiceList, Group, Row, StatusLine, TextField } from "../ux";
import { useTeamBilling } from "../../store/teamBillingStore";
import { useAccount } from "../../store/accountStore";
import type { BillingInterval, CreateStage } from "../../ipc";
import { SignInBody, useSignInFlow } from "./SignInStep";
import {
  FINISH_TITLE,
  LAPSED_TITLE,
  PENDING_TITLE,
  TEAM_MAX_SEATS,
  TEAM_MIN_SEATS,
  WAITING_TITLE,
  checkoutErrorText,
  intervalLabel,
  lapsedText,
  stageNotice,
  totalLine,
} from "../../lib/teamBilling";

export interface CreateGateContext {
  /** The repository the owner's plan is already bound to (set it up here). */
  boundRepo: string | null;
}

export function CreateTeamGate({
  children,
  onCancel,
}: {
  children: (ctx: CreateGateContext) => ReactNode;
  /** Settings' flow: a way back out before the form shows. */
  onCancel?: () => void;
}) {
  const billing = useTeamBilling((s) => s.billing);
  const loading = useTeamBilling((s) => s.loading);
  const step = useTeamBilling((s) => s.step);
  const justPaid = useTeamBilling((s) => s.justPaid);
  const error = useTeamBilling((s) => s.error);
  const load = useTeamBilling((s) => s.load);
  const signedIn = useAccount((s) => s.info?.signedIn ?? null);

  useEffect(() => {
    void load();
  }, [load, signedIn]);

  if (step === "waiting" || step === "opening") return <Waiting />;
  if (step === "pending") return <Pending />;
  if (!billing) {
    return loading || !error ? (
      <StatusLine state="running">Checking your plan…</StatusLine>
    ) : (
      <Callout
        kind="warn"
        title="Plyloft couldn't check your plan."
        text={error.message}
        actions={<CBtn onClick={() => void load()}>Look again</CBtn>}
      />
    );
  }
  const stage: CreateStage = billing.stage;
  // P3-2: the server couldn't say what the team's plan is (signed in, but
  // GET /team failed): said, with Look again, before anything is offered.
  if (billing.error) {
    return (
      <>
        <Callout
          kind="warn"
          title="Plyloft couldn't read the team's plan."
          text={billing.error.message}
          actions={
            <CBtn disabled={loading} onClick={() => void load()}>
              {loading ? "Looking…" : "Look again"}
            </CBtn>
          }
        />
        {onCancel && (
          <div className="ux-flow-actions">
            <CBtn onClick={onCancel}>Cancel</CBtn>
          </div>
        )}
      </>
    );
  }
  if (stage.stage === "create" || stage.stage === "bound") {
    return (
      <>
        <Callout
          kind="info"
          title={
            stage.stage === "bound"
              ? `Your team is ${stage.teamRepo}.`
              : justPaid
                ? "Payment received. Now name your team."
                : stage.comp
                  ? "Your plan includes a team."
                  : FINISH_TITLE
          }
          text={
            stage.stage === "bound"
              ? "Set it up on this Mac: Plyloft finds the team it already made and changes nothing on GitHub."
              : "Plyloft creates the private repository on GitHub and attaches it to your Team plan."
          }
        />
        {children({ boundRepo: stage.stage === "bound" ? stage.teamRepo : null })}
      </>
    );
  }
  if (stage.stage === "choose" || (stage.stage === "lapsed" && stage.owner)) {
    return <Choose renew={stage.stage === "lapsed" ? stage : null} onCancel={onCancel} />;
  }
  const notice = stageNotice(stage);
  return (
    <>
      {notice && stage.stage === "sign_in" && <SignInCallout title={notice.title} text={notice.text} />}
      {notice && stage.stage !== "sign_in" && <Callout kind="info" title={notice.title} text={notice.text} />}
      {error && <StatusLine state="aborted">{checkoutErrorText(error)}</StatusLine>}
      {onCancel && (
        <div className="ux-flow-actions">
          <CBtn onClick={onCancel}>Cancel</CBtn>
        </div>
      )}
    </>
  );
}

/** A3 D20 / D21: a notice that asks for the Plyloft sign-in, with the button
 *  and, once pressed, the code in the same place (`SignInBody`). When the
 *  sign-in completes the account store flips `signedIn`: Create team's gate
 *  reads the plan again (`team_billing_get`) and moves on to "choose"; the
 *  joined-team notice changes to what the account's team says. */
export function SignInCallout({ title, text }: { title: string; text: string }) {
  const flow = useSignInFlow();
  const [shown, setShown] = useState(false);
  const { view, run } = flow;
  const primary = view.primary;
  return (
    <>
      <Callout
        kind="info"
        title={title}
        text={text}
        actions={
          primary && !view.done ? (
            <CBtn
              tone="strong"
              disabled={primary.disabled}
              onClick={() => {
                setShown(true);
                void run(primary.action);
              }}
            >
              {primary.label}
            </CBtn>
          ) : undefined
        }
      />
      {(shown || view.code) && <SignInBody flow={flow} inSetup={false} action={false} />}
    </>
  );
}

/** Renew a lapsed team when its interval isn't known: the seats and the
 *  interval asked again, then Checkout (Settings › Team's lapse notice). */
export function RenewChoice({ renew, onCancel }: { renew: Extract<CreateStage, { stage: "lapsed" }>; onCancel: () => void }) {
  return <Choose renew={renew} onCancel={onCancel} />;
}

function Choose({
  renew,
  onCancel,
}: {
  renew: Extract<CreateStage, { stage: "lapsed" }> | null;
  onCancel?: () => void;
}) {
  const seats = useTeamBilling((s) => s.seats);
  const interval = useTeamBilling((s) => s.interval);
  const error = useTeamBilling((s) => s.error);
  const setInterval = useTeamBilling((s) => s.setInterval);
  const checkout = useTeamBilling((s) => s.checkout);
  const portal = useTeamBilling((s) => s.portal);
  return (
    <>
      {renew && (
        <Callout
          kind="warn"
          title={LAPSED_TITLE}
          text={`${renew.teamRepo ? `${renew.teamRepo}: ` : ""}${lapsedText(true, renew.ownerLogin)}`}
        />
      )}
      <SeatsGroup />
      <ChoiceList<BillingInterval>
        label="Billing"
        value={interval}
        onChange={setInterval}
        options={[
          { value: "month", label: intervalLabel("month"), hint: "Cancel any time; it runs to the end of the month." },
          { value: "year", label: intervalLabel("year"), hint: "20% less than paying monthly." },
        ]}
      />
      <StatusLine state="empty">{totalLine(seats, interval)}</StatusLine>
      {error && (
        <StatusLine state="aborted">
          {checkoutErrorText(error)}{" "}
          {error.code === "already_subscribed" && (
            <CBtn tone="quiet" onClick={() => void portal()}>
              Open billing
            </CBtn>
          )}
        </StatusLine>
      )}
      <div className="ux-flow-actions">
        {onCancel && <CBtn onClick={onCancel}>Cancel</CBtn>}
        <CBtn tone="strong" onClick={() => void checkout()}>
          {renew ? "Renew" : "Continue to payment"}
        </CBtn>
      </div>
      <p className="ux-setup-note">
        The payment page opens in your browser. Plyloft creates the team repository once the payment goes through.
      </p>
    </>
  );
}

/** The seats, 2–50 with − and +, used by Checkout. */
function SeatsGroup() {
  const seats = useTeamBilling((s) => s.seats);
  const setSeats = useTeamBilling((s) => s.setSeats);
  // P3-9: typing may leave the field empty; the seats are set (2–50) when
  // the field is left or Enter is pressed.
  const [draft, setDraft] = useState<string | null>(null);
  const commitSeats = (v: string) => {
    const n = Number.parseInt(v, 10);
    setSeats(Number.isFinite(n) ? n : seats);
    setDraft(null);
  };
  return (
    <Group label="Your team's plan">
      <Row
        kind="text"
        label="Seats"
        hint={`One per member, yours included: ${TEAM_MIN_SEATS} to ${TEAM_MAX_SEATS}. You can add seats later.`}
        action={
          <>
            <CBtn tone="quiet" disabled={seats <= TEAM_MIN_SEATS} aria-label="One seat fewer" title="One seat fewer" onClick={() => setSeats(seats - 1)}>
              −
            </CBtn>
            <CBtn tone="quiet" disabled={seats >= TEAM_MAX_SEATS} aria-label="One seat more" title="One seat more" onClick={() => setSeats(seats + 1)}>
              +
            </CBtn>
          </>
        }
      >
        <TextField
          value={draft ?? String(seats)}
          onChange={(v) => setDraft(v.replace(/[^0-9]/g, ""))}
          onCommit={commitSeats}
          onCancel={() => setDraft(null)}
          label="Seats"
        />
      </Row>
    </Group>
  );
}

/** A Checkout under way (Renew on the Team page): waiting, then pending. */
export function CheckoutProgress() {
  const step = useTeamBilling((s) => s.step);
  if (step === "waiting" || step === "opening") return <Waiting />;
  if (step === "pending") return <Pending />;
  return null;
}

function Waiting() {
  const step = useTeamBilling((s) => s.step);
  const back = useTeamBilling((s) => s.back);
  const checkout = useTeamBilling((s) => s.checkout);
  return (
    <Callout
      kind="now"
      state="running"
      live
      title={step === "opening" ? "Opening the payment page…" : WAITING_TITLE}
      text="Pay in the browser window that opened. Plyloft carries on here as soon as the payment goes through."
      actions={
        step === "waiting" ? (
          <>
            <CBtn onClick={() => void checkout()}>Open the payment page again</CBtn>
            <CBtn tone="quiet" onClick={() => void back()}>
              Back
            </CBtn>
          </>
        ) : undefined
      }
    />
  );
}

function Pending() {
  const checkAgain = useTeamBilling((s) => s.checkAgain);
  const back = useTeamBilling((s) => s.back);
  const notYet = useTeamBilling((s) => s.notYet);
  const loading = useTeamBilling((s) => s.loading);
  const unpaid = "If you closed Checkout without paying, nothing was charged and no team was created.";
  return (
    <Callout
      kind="info"
      title={PENDING_TITLE}
      text={
        notYet
          ? `Not yet. Stripe can take a few minutes to confirm a payment. ${unpaid}`
          : `Stripe can take a few minutes to confirm a payment. ${unpaid}`
      }
      actions={
        <>
          <CBtn tone="strong" disabled={loading} onClick={() => void checkAgain()}>
            {loading ? "Looking…" : "Look again"}
          </CBtn>
          <CBtn tone="quiet" onClick={() => void back()}>
            Back to the choice
          </CBtn>
        </>
      }
    />
  );
}
