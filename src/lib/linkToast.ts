/**
 * 1.174.0 (TX6, E10): one form for a link that didn't open, everywhere —
 * a warn, the address as its body, and a press that copies the address so
 * the person can paste it into a browser themselves. The raw error stays
 * behind Details.
 */

export const LINK_DID_NOT_OPEN_TITLE = "The link didn't open";
export const COPY_THE_ADDRESS = "Copy the address";

export interface LinkToast {
  kind: "warn";
  title: string;
  body: string;
  details: string;
  action: { label: string; onClick: () => void };
}

function rawCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** The toast for `address` when opening it threw `cause`. */
export function linkDidNotOpen(
  address: string,
  cause: unknown,
  clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard,
): LinkToast {
  return {
    kind: "warn",
    title: LINK_DID_NOT_OPEN_TITLE,
    body: address,
    details: rawCause(cause),
    action: {
      label: COPY_THE_ADDRESS,
      onClick: () => {
        void clipboard?.writeText(address).catch(() => {});
      },
    },
  };
}
