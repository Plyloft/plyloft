// Manage subscription (Settings › Plan, the sidebar's plan row): Stripe's
// billing portal in the browser, for whoever pays for Team. The words of a
// refusal are `planPage.ts`'s.
import { accountPortal, type AccountError } from "../ipc";
import { notFoundText } from "./planPage";
import { useAccount } from "../store/accountStore";

export interface PortalNote {
  tone: "empty" | "aborted";
  text: string;
}

function asAccountError(e: unknown): AccountError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AccountError;
  return { code: "internal", message: String((e as Error)?.message ?? e) };
}

/** Opens the portal; what to say when it didn't (`null` when it opened). */
export async function openBillingPortal(): Promise<PortalNote | null> {
  try {
    await accountPortal();
    return null;
  } catch (e) {
    const error = asAccountError(e);
    if (error.code === "not_found") return { tone: "empty", text: notFoundText(useAccount.getState().info) };
    return { tone: "aborted", text: error.message };
  }
}
