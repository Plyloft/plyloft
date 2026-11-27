import { create } from "zustand";
import {
  accountCheckout,
  accountPortal,
  teamBillingGet,
  teamCheckoutWait,
  teamCheckoutWaitCancel,
  type AccountError,
  type BillingInterval,
  type TeamBilling,
} from "../ipc";
import { useAccount } from "./accountStore";
import { TEAM_MIN_SEATS, clampSeats } from "../lib/teamBilling";

/**
 * Launch T1–T3: the GLOBAL "team with seats and payment" store — one per app,
 * shared by Setup › Your team and Settings › Team, so a payment started in one
 * is still being waited for in the other. Nothing here is persisted: after a
 * restart the account's own plan says where Create team stands (the backend's
 * `team_billing::create_stage`), which is how "Finish creating your team"
 * comes back.
 */
export type CheckoutStep = "choose" | "opening" | "waiting" | "pending";

type TeamBillingStore = {
  billing: TeamBilling | null;
  loading: boolean;
  step: CheckoutStep;
  seats: number;
  interval: BillingInterval;
  /** Paid in this session: the create form says "Payment received". */
  justPaid: boolean;
  /** The last refused Checkout / Portal, as the backend worded it. */
  error: AccountError | null;
  /** Round 2 (P3-c): `error` came from a refused Checkout (said with Open
   *  billing), not from reading the plan or opening the Portal. */
  errorFromCheckout: boolean;
  /** Look again found no plan yet. */
  notYet: boolean;
  load: () => Promise<TeamBilling | null>;
  setSeats: (n: number) => void;
  setInterval: (i: BillingInterval) => void;
  checkout: () => Promise<void>;
  checkAgain: () => Promise<void>;
  back: () => Promise<void>;
  portal: () => Promise<void>;
};

function asAccountError(e: unknown): AccountError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AccountError;
  return { code: "internal", message: String((e as Error)?.message ?? e) };
}

export const useTeamBilling = create<TeamBillingStore>((set, get) => ({
  billing: null,
  loading: false,
  step: "choose",
  seats: TEAM_MIN_SEATS,
  interval: "month",
  justPaid: false,
  error: null,
  errorFromCheckout: false,
  notYet: false,

  load: async () => {
    const mine = ++loadGeneration;
    set({ loading: true });
    try {
      const billing = await teamBillingGet();
      // P3-2: only the newest read paints; a slow older one is dropped.
      if (mine !== loadGeneration) return billing;
      set({ billing, error: null, errorFromCheckout: false });
      // "Payment received" belongs to the form that follows the payment only.
      if (billing.stage.stage !== "create") set({ justPaid: false });
      // Renew starts from the seats the team had.
      if (billing.stage.stage === "lapsed" && get().step === "choose") {
        set({ seats: clampSeats(billing.stage.seats) });
      }
      return billing;
    } catch (e) {
      if (mine === loadGeneration) set({ error: asAccountError(e), errorFromCheckout: false });
      return null;
    } finally {
      if (mine === loadGeneration) set({ loading: false });
    }
  },

  setSeats: (n) => set({ seats: clampSeats(n) }),
  setInterval: (interval) => set({ interval }),

  checkout: async () => {
    const { seats, interval } = get();
    set({ step: "opening", error: null, notYet: false });
    try {
      await accountCheckout("team", interval, seats);
    } catch (e) {
      const error = asAccountError(e);
      set({ step: "choose", error, errorFromCheckout: true });
      // A subscription Plyloft hasn't seen yet (paid, then the app closed):
      // read the plan again — the stage then moves on by itself. Otherwise
      // the subscription is managed in the Portal (LAUNCH_API: open it).
      if (error.code === "already_subscribed") {
        await useAccount.getState().refresh();
        const billing = await get().load();
        const stage = billing?.stage.stage;
        if (stage !== "create" && stage !== "bound") {
          set({ error, errorFromCheckout: true }); // the read above cleared it; the refusal still stands
          await accountPortal().catch((e) => set({ error: asAccountError(e), errorFromCheckout: false }));
        }
      }
      return;
    }
    set({ step: "waiting" });
    await wait(set, get);
  },

  checkAgain: async () => {
    set({ notYet: false, error: null });
    await useAccount.getState().refresh();
    const billing = await get().load();
    const stage = billing?.stage.stage;
    if (stage === "create" || stage === "bound") {
      set({ step: "choose", justPaid: true });
    } else {
      set({ notYet: true });
    }
  },

  back: async () => {
    set({ step: "choose", notYet: false });
    await teamCheckoutWaitCancel().catch(() => {});
  },

  portal: async () => {
    set({ error: null, errorFromCheckout: false });
    try {
      await accountPortal();
    } catch (e) {
      set({ error: asAccountError(e), errorFromCheckout: false });
    }
  },
}));

/** The newest `load`: older answers are dropped. */
let loadGeneration = 0;

/** The newest wait: Open Checkout again starts another, and the backend
 *  cancels the older one, whose late answer must not move the page. */
let waitGeneration = 0;

/** Up to two minutes of asking; then the plan, "pending", or nothing (back). */
async function wait(
  set: (partial: Partial<TeamBillingStore>) => void,
  get: () => TeamBillingStore,
): Promise<void> {
  const mine = ++waitGeneration;
  try {
    const outcome = await teamCheckoutWait();
    // P3-3: a payment that landed is always taken, whatever the page did since.
    if (outcome.state === "paid") {
      useAccount.setState({ info: outcome.info, loaded: true });
      set({ step: "choose", justPaid: true });
      await get().load();
      return;
    }
    if (mine !== waitGeneration || get().step !== "waiting") return; // superseded, or went back
    if (outcome.state === "pending") {
      set({ step: "pending" });
    } else {
      set({ step: "choose" });
    }
  } catch (e) {
    if (mine !== waitGeneration) return;
    set({ step: "pending", error: asAccountError(e), errorFromCheckout: false });
  }
}
