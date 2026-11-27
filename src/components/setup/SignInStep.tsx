// Launch A2 (LAUNCH_PLAN §2 D1, D2; §3.1): "Sign in to Plyloft".
//
// 1.178.0 (A3): the Plyloft account is optional — only teams need it. There
// is no full-window Sign-in screen any more; one body, `SignInBody`, is
// embedded wherever a sign-in is offered:
// - Setup's step 2 ("Plyloft account"), inside SetupOverlay, whose footer's
//   one primary is Continue (signing in is a bordered button in the body);
// - Settings › Plan's account row, Create team's `sign_in` stage and the
//   joined team's "Sign in to use your seat" notice.
//
// The flow is GitHub's Device Flow run by `account.rs`: Plyloft gets a code,
// the person types it at github.com/login/device, and `account://sign-in`
// reports the progress. The words and the state are `lib/signIn.ts`.
import { useCallback, useEffect, useRef, useState } from "react";
import { CBtn, Section, StatusLine } from "../ux";
import { setupOpenPage, type AccountInfo } from "../../ipc";
import { useAccount } from "../../store/accountStore";
import { pushToast } from "../../store/toastStore";
import { machineWords } from "../../lib/platform";
import {
  DEVICE_PAGE,
  DEV_SKIP_NOTE,
  NO_GITHUB_ACTION,
  NO_GITHUB_NOTE,
  OPEN_DEVICE_PAGE,
  SIGNIN_ABOUT,
  SIGNIN_NOT_GH,
  signInView,
  signedInLine,
  type SignInAction,
} from "../../lib/signIn";
import { DeviceCode } from "./DeviceCode";
import { updateFlow, useUpdateState } from "../UpdatePrompt";
import { pushErrorToast } from "../../lib/errorToast";

/** What `useSignInFlow` takes. */
export interface SignInFlowOptions {
  /** Called once when a sign-in started from this flow finishes: the
   *  account is signed in (`info.signedIn`). Not called for an account that
   *  was already signed in when the flow mounted. */
  onSignedIn?: (info: AccountInfo) => void;
}

/**
 * The view and its actions; one per frame (local `starting`/`checking`).
 * `run("start")` calls the store's `signInStart()` (Device Flow); `cancel()`
 * its `signInCancel()`; `run("refresh")` its `refresh()`. The account store
 * (`useAccount`) holds the code, the progress and the result: a finished
 * sign-in sets `info.signedIn` and `view.done`.
 */
export function useSignInFlow(options?: SignInFlowOptions) {
  const info = useAccount((s) => s.info);
  const signIn = useAccount((s) => s.signIn);
  const progress = useAccount((s) => s.progress);
  const error = useAccount((s) => s.error);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const view = signInView({ info, signIn, progress, error, starting, checking });

  // `onSignedIn`: once, for a sign-in this flow started.
  const startedHere = useRef(false);
  const onSignedIn = useRef(options?.onSignedIn);
  onSignedIn.current = options?.onSignedIn;
  const signedIn = Boolean(info?.signedIn);
  useEffect(() => {
    if (!signedIn || !startedHere.current) return;
    startedHere.current = false;
    const now = useAccount.getState().info;
    if (now?.signedIn) onSignedIn.current?.(now);
  }, [signedIn]);

  const run = useCallback(async (action: SignInAction) => {
    if (action === "refresh") {
      setChecking(true);
      try {
        await useAccount.getState().refresh();
      } finally {
        setChecking(false);
      }
      return;
    }
    startedHere.current = true;
    setStarting(true);
    try {
      await useAccount.getState().signInStart();
    } finally {
      setStarting(false);
    }
  }, []);
  const cancel = useCallback(() => void useAccount.getState().signInCancel(), []);
  return { view, run, cancel };
}

export type SignInFlow = ReturnType<typeof useSignInFlow>;

/** The code, big, with Copy and the page to type it on. */
function CodeBlock({ code }: { code: string }) {
  return (
    <Section title="Your code">
      <p className="ux-setup-text">
        Enter this code on {DEVICE_PAGE} and allow Plyloft. Plyloft asks GitHub for no access to your
        repositories.
      </p>
      {/* N14 walk F1: the code centred with room above and below; the page
          to type it on is the step's one primary while it waits (the frame's
          own primary is off then), Copy code beside it. F17 shares the block
          (`DeviceCode`) with the GitHub CLI's code in Setup's terminal. */}
      <DeviceCode
        code={code}
        page={DEVICE_PAGE}
        openLabel={OPEN_DEVICE_PAGE}
        onOpen={() =>
          void setupOpenPage("github-device").catch((e) =>
            pushErrorToast(`Couldn't open ${DEVICE_PAGE}`, e),
          )
        }
      />
    </Section>
  );
}

/**
 * The props of `SignInBody` — a stable shape: Setup, the Plan page, Create
 * team's `sign_in` stage and the joined team's notice embed it.
 */
export interface SignInBodyProps {
  /** The frame's flow (`useSignInFlow()`), so a button the frame draws itself
   *  and the body share one state. */
  flow: SignInFlow;
  /** Setup's step 2: the body also says what the account is
   *  (`SIGNIN_ABOUT`) and that it is not the next step's GitHub sign-in
   *  (`SIGNIN_NOT_GH`, D1). Default false. */
  inSetup?: boolean;
  /** The body draws the sign-in's own button — "Sign in with GitHub", then
   *  "Try again" or "Get a new code" (`flow.view.primary`) — bordered, never
   *  filled. Default true. A frame that offers the sign-in on its own button
   *  (a row's action) passes false and draws `flow.view.primary` itself,
   *  calling `flow.run(primary.action)`. */
  action?: boolean;
}

/**
 * The sign-in: the code while a sign-in waits (Copy code and "Open
 * github.com/login/device", the one filled button while GitHub waits), the
 * status line (asking for a code, waiting, GitHub asked to slow down,
 * verifying, signed in as …, or what went wrong), Cancel while it waits, the
 * bordered Sign in with GitHub (or its way out after a failure) and D2's "No
 * GitHub account? Create one". A debug build that skips sign-in shows its
 * note in place of the button.
 *
 * Calls the account store (`useAccount`) through `flow`: `signInStart()`,
 * `signInCancel()`. The frame knows sign-in finished from `flow.view.done`
 * (or `useAccount((s) => s.info?.signedIn)`), or from `useSignInFlow`'s
 * `onSignedIn`.
 */
export function SignInBody({ flow, inSetup = false, action = true }: SignInBodyProps) {
  const { view, run, cancel } = flow;
  const devSkip = useAccount((s) => s.devSkip);
  const [noGithubNote, setNoGithubNote] = useState(false);
  const devNote = devSkip && !view.done;
  const button = action && !devNote ? view.primary : null;
  const noGithub = view.noGithub && !devNote;
  return (
    <>
      {inSetup && <p className="ux-setup-text">{SIGNIN_ABOUT}</p>}
      {inSetup && <p className="ux-setup-note">{machineWords(SIGNIN_NOT_GH)}</p>}
      {devNote && <p className="ux-setup-note">{DEV_SKIP_NOTE}</p>}
      {view.code && <CodeBlock code={view.code} />}
      {view.status && <StatusLine state={view.status.tone}>{machineWords(view.status.text)}</StatusLine>}
      {(view.cancel || view.secondary) && (
        <div className="ux-setup-links">
          {view.cancel && (
            <CBtn tone="quiet" onClick={cancel}>
              Cancel
            </CBtn>
          )}
          {view.secondary && (
            <CBtn tone="quiet" onClick={() => void run(view.secondary!.action)}>
              {view.secondary.label}
            </CBtn>
          )}
        </div>
      )}
      {(button || noGithub) && (
        <div className="ux-setup-firstcard">
          {button && (
            // 1.178.0 (A3): bordered — signing in is optional.
            <CBtn disabled={button.disabled} onClick={() => void run(button.action)}>
              {button.label}
            </CBtn>
          )}
          {noGithub && (
            // D2: no GitHub account yet — GitHub's sign-up page, then come back.
            <CBtn
              tone="quiet"
              onClick={() => {
                setNoGithubNote(true);
                void setupOpenPage("github-signup").catch(() => {});
              }}
            >
              {NO_GITHUB_ACTION}
            </CBtn>
          )}
        </div>
      )}
      {noGithub && noGithubNote && <p className="ux-setup-note">{NO_GITHUB_NOTE}</p>}
    </>
  );
}

/** Setup's step 2: the body, with its own bordered Sign in with GitHub. The
 *  footer's one primary is Setup's Continue (SetupOverlay). */
export function AccountStep() {
  const flow = useSignInFlow();
  return <SignInBody flow={flow} inSetup />;
}

/** After a sign-in: "Signed in as octocat · Free", once, as the app goes on. */
export function useSignedInToast(): void {
  const progress = useAccount((s) => s.progress);
  const seen = useRef(progress);
  useEffect(() => {
    if (progress === seen.current) return;
    seen.current = progress;
    if (progress?.state === "signed_in") {
      pushToast({ kind: "info", title: signedInLine(progress.info) });
    }
  }, [progress]);
}

/** Launch A2: while Setup covers the app, the sidebar's update row is out
 *  of reach — so its footer offers it. Opens App's install dialog, which
 *  sits above it. */
export function InstallUpdateButton() {
  const state = useUpdateState();
  if (state.kind !== "available") return null;
  return (
    <CBtn
      tone="quiet"
      title={`Install Plyloft ${state.version} and relaunch — asks first`}
      onClick={() => updateFlow().openFromBanner()}
    >
      Install update
    </CBtn>
  );
}
