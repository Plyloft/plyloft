import { create } from "zustand";
import {
  accountDevSkipSignIn,
  planGatesGet,
  type PlanGates,
  accountGet,
  accountRefresh,
  accountSignInCancel,
  accountSignInStart,
  accountSignOut,
  accountUseTeam,
  onAccountChanged,
  onAccountSignIn,
  type AccountError,
  type AccountInfo,
  type SignInEvent,
  type SignInProgress,
  type SignInStart,
} from "../ipc";
import { teamAllowed } from "../lib/planGates";
import { machineWords } from "../lib/platform";
import { useSettings } from "./settingsStore";
import { pushToast } from "./toastStore";

/**
 * Launch A1: the GLOBAL Plyloft account store — flat, not per-workspace (the
 * account is the person on this profile). The backend decides the plan
 * (`account.rs::AccountInfo`); this store only mirrors it and the sign-in in
 * progress. Setup's step 2, Settings › Plan and the Team surfaces read it.
 * 1.178.0 (A3): signed out is an ordinary state — nothing covers the app
 * for a missing account.
 */
type AccountStore = {
  info: AccountInfo | null;
  loaded: boolean;
  /** The code to type on github.com while a sign-in waits. */
  signIn: SignInStart | null;
  /** The last `account://sign-in` progress of the current sign-in. */
  progress: SignInProgress | null;
  /** The last failed command or sign-in, as the backend worded it. */
  error: AccountError | null;
  /** The newest sign-in attempt seen. Events of older (superseded) attempts
   *  are dropped, so a late `cancelled` never wipes the new sign-in. */
  attempt: number;
  /** Launch A2: a debug run with `PLYLOFT_DEV_SKIP_SIGNIN=1` never opens the
   *  keychain; Setup's step 2 reads Skipped and the Plan page says so
   *  (release builds: always false). */
  devSkip: boolean;
  /** Launch G3: the backend's plan decisions (`plan_gates_get`). Null
   *  until read: team locks stay locked. */
  gates: PlanGates | null;
  loadGates: () => Promise<void>;
  load: () => Promise<void>;
  /** Start GitHub's Device Flow: the code lands in `signIn`, the progress in
   *  `progress`, and a finished sign-in puts the account in `info`. */
  signInStart: () => Promise<SignInStart | null>;
  signInCancel: () => Promise<void>;
  refresh: () => Promise<void>;
  /** 1.178.0 (A3): *Use Team on this computer* is under way. */
  movingTeam: boolean;
  /** 1.178.0 (A3): *Use Team on this computer* (`account_use_team`): Team
   *  runs here from now on, and off on the computer that held it at its next
   *  refresh. Resolves with the new account, or null when it failed (the
   *  error is in `error`; the caller says so). */
  useTeam: () => Promise<AccountInfo | null>;
  signOut: () => Promise<void>;
};

/** Account commands reject with `{code, message}`; anything else is wrapped. */
function asAccountError(e: unknown): AccountError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    return e as AccountError;
  }
  return { code: "internal", message: String(e) };
}

/** A Sign out pressed here is running (its own `account://changed`
 *  included), or the account is being read at launch: a signed-out answer
 *  then is not a session the server ended. */
let quiet = 0;

export const useAccount = create<AccountStore>((set, get) => ({
  info: null,
  loaded: false,
  signIn: null,
  progress: null,
  error: null,
  attempt: 0,
  devSkip: false,
  gates: null,
  movingTeam: false,

  loadGates: async () => {
    try {
      const gates = await planGatesGet();
      if (gates) set({ gates });
    } catch {
      // Backend unavailable: keep the last answer (the backend still gates).
    }
  },

  load: async () => {
    const devSkip = await accountDevSkipSignIn().then(
      (v) => v === true,
      () => false,
    );
    quiet += 1;
    try {
      const info = await accountGet();
      set({ info: info ?? null, loaded: true, devSkip });
    } catch {
      // Backend unavailable (tests outside Tauri): null reads as signed out.
      set({ loaded: true, devSkip });
    } finally {
      quiet -= 1;
    }
  },

  signInStart: async () => {
    set({ error: null, progress: null, signIn: null });
    try {
      const signIn = await accountSignInStart();
      // Its own events may have arrived first; never move backwards.
      set((s) => ({ signIn, attempt: Math.max(s.attempt, signIn.attempt) }));
      return signIn;
    } catch (e) {
      set({ error: asAccountError(e) });
      return null;
    }
  },

  signInCancel: async () => {
    try {
      await accountSignInCancel();
      set({ signIn: null, progress: null });
    } catch (e) {
      set({ error: asAccountError(e) });
    }
  },

  refresh: async () => {
    try {
      const info = await accountRefresh();
      set({ info, loaded: true, error: null });
    } catch (e) {
      set({ error: asAccountError(e) });
    }
  },

  useTeam: async () => {
    if (get().movingTeam) return null;
    set({ error: null, movingTeam: true });
    try {
      const info = await accountUseTeam();
      set({ info, loaded: true, error: null, movingTeam: false });
      void get().loadGates();
      return info;
    } catch (e) {
      set({ error: asAccountError(e), movingTeam: false });
      // A refusal may have ended the session (`unauthorized`): read the
      // account again.
      try {
        const info = await accountGet();
        if (info) set({ info, loaded: true });
      } catch {
        // keep the last answer
      }
      return null;
    }
  },

  signOut: async () => {
    // The person's own Sign out: no "signed out from another computer" toast.
    quiet += 1;
    try {
      const info = await accountSignOut();
      set({ info, loaded: true, error: null, signIn: null, progress: null });
    } catch (e) {
      set({ error: asAccountError(e) });
    } finally {
      quiet -= 1;
    }
  },
}));

/** 1.178.0 (A3, D24): the toast when this computer's session ended without
 *  its own Sign out: the server answered `unauthorized` (e.g. *Sign out other
 *  computers* pressed elsewhere), or the keychain entry vanished. The body
 *  blames no cause. */
export const SIGNED_OUT_NOTICE = {
  title: "Signed out of Plyloft on this Mac",
  body: "Sign in again to use Team features on this computer.",
};

/** 1.178.0 (A3): an account that was signed in reads signed out, and not by
 *  this computer's own Sign out — the server ended the session. The app goes
 *  signed out silently (nothing covers it); only a computer that follows a
 *  team (`settings.team.teamRepo`) is told, once, since its team features
 *  just went off. Exported for the tests. */
export function onSignedInChange(prev: AccountInfo | null, next: AccountInfo | null): void {
  if (!prev?.signedIn || !next || next.signedIn || quiet > 0) return;
  if (!useSettings.getState().settings.team?.teamRepo) return;
  pushToast({
    kind: "info",
    title: machineWords(SIGNED_OUT_NOTICE.title),
    body: machineWords(SIGNED_OUT_NOTICE.body),
  });
}

function applyProgress(event: SignInEvent): void {
  const { attempt, ...rest } = event;
  if (attempt < useAccount.getState().attempt) return;
  useAccount.setState({ attempt });
  const progress = rest as SignInProgress;
  switch (progress.state) {
    case "signed_in":
      useAccount.setState({ info: progress.info, loaded: true, signIn: null, progress, error: null });
      break;
    case "failed":
      useAccount.setState({ signIn: null, progress, error: progress.error });
      break;
    case "cancelled":
      useAccount.setState({ signIn: null, progress: null });
      break;
    default:
      useAccount.setState({ progress });
  }
}

let listeners: Promise<Array<() => void>> | null = null;

/** Load the account and follow `account://changed` and `account://sign-in`,
 *  and watch for the session ending (`onSignedInChange`). Idempotent: the
 *  app calls it once at startup. */
export function startAccountListeners(): Promise<void> {
  if (!listeners) {
    listeners = Promise.all([
      onAccountChanged((info) => useAccount.setState({ info, loaded: true })),
      onAccountSignIn(applyProgress),
      // Every way the account arrives (a refresh's answer, either
      // `account://changed` listener, a sign-in) passes through the store.
      Promise.resolve(useAccount.subscribe((next, prev) => {
        if (next.info !== prev.info) onSignedInChange(prev.info, next.info);
      })),
    ]);
  }
  return listeners.then(() => useAccount.getState().load());
}

/** Tests: the next test's stub gets its own listeners (src/test/setup.ts). */
export function stopAccountListenersForTests(): void {
  const pending = listeners;
  listeners = null;
  void pending?.then((stops) => stops.forEach((stop) => stop())).catch(() => {});
}

/** This profile holds a signed-in account. QoL 1.168 (owner D1, D2): a plan
 *  that can't be verified is Free here (the gates read it so), never a lock.
 *  1.178.0 (A3): nothing requires it — only starting or joining a team. */
export function accountReady(info: AccountInfo | null | undefined): boolean {
  return Boolean(info?.signedIn);
}

/** The plan the gates use: `free` until a valid entitlement says otherwise. */
export function currentPlan(info: AccountInfo | null): AccountInfo["plan"] {
  return info?.entitlementValid ? info.plan : "free";
}

/** Launch G3: do team features run on this Mac now — the backend's answer,
 *  read from the account (the plan, its team, the account's match). */
export function useTeamAllowed(): boolean {
  return useAccount((s) => teamAllowed(s.gates));
}

export { teamAllowed };

let gatesStarted = false;
let gatesStops: Array<() => void> = [];

/** What the team half of the gates reads from the settings, as one string. */
function teamSettingsKey(): string {
  const team = useSettings.getState().settings.team;
  return `${team?.teamRepo ?? ""}|${team?.account ?? ""}`;
}

/** Read the plan gates and read them again whenever the account or this
 *  Mac's team changes. Call once from App startup; idempotent. */
export function startPlanGates(): void {
  if (gatesStarted) return;
  gatesStarted = true;
  void useAccount.getState().loadGates();
  let lastTeam = teamSettingsKey();
  gatesStops.push(
    useSettings.subscribe(() => {
      const next = teamSettingsKey();
      if (next === lastTeam) return;
      lastTeam = next;
      void useAccount.getState().loadGates();
    }),
  );
  // Challenger P3-6: also on every account refresh tick (the backend says so
  // each time), when the window comes back to the front, and at the
  // entitlement's expiry — the plan moves with the clock too.
  void onAccountChanged((info) => {
    useAccount.setState({ info, loaded: true });
    void useAccount.getState().loadGates();
  }).then((stop) => {
    if (gatesStarted) gatesStops.push(stop);
    else stop();
  });
  const onFocus = () => void useAccount.getState().loadGates();
  window.addEventListener("focus", onFocus);
  gatesStops.push(() => window.removeEventListener("focus", onFocus));
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const armExpiry = (exp: number | null | undefined) => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (exp == null) return;
    // setTimeout holds at most ~24.8 days; a later expiry is re-armed by the
    // reads in between (every refresh tick and focus).
    const wait = Math.min(Math.max(exp - Date.now() + 1000, 0), 2 ** 31 - 1);
    expiryTimer = setTimeout(() => void useAccount.getState().loadGates(), wait);
  };
  gatesStops.push(
    useAccount.subscribe((next, prev) => {
      if (next.gates?.exp !== prev.gates?.exp) armExpiry(next.gates?.exp);
    }),
  );
  gatesStops.push(() => {
    if (expiryTimer) clearTimeout(expiryTimer);
  });
}

/** Tests: forget the subscription and the answer. */
export function stopPlanGatesForTests(): void {
  for (const stop of gatesStops) stop();
  gatesStops = [];
  gatesStarted = false;
  useAccount.setState({ gates: null });
}
