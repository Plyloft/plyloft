// 1.173.0 (A4 → A3): the one way in to Terminals' "New terminal in a copy"
// sheet from elsewhere — today the "Same folder as …" popover on a tile.
//
// Contract (A3 fills in the host):
// - Callers call `openNewCopySheet({ workspaceId, provider })` and nothing
//   else: the workspace whose Terminals open the sheet, and the AI to
//   preselect.
// - Hosts subscribe with `onOpenNewCopySheet(handler)`. Every warmed
//   workspace mounts its own Terminals, so a handler acts **only when the
//   request's `workspaceId` is its own** and ignores the rest; exactly one
//   host (the sheet's, for that workspace) answers a request.
// - Until A3 lands nothing answers, so the button opens nothing. A3 may also
//   replace this body with a direct open, keeping the signature.

export const OPEN_NEW_COPY_EVENT = "ply:open-new-copy";

/** The kind the sheet preselects: the AI of the terminal that asked. */
export type NewCopyProvider = "claude" | "codex" | "shell";

export interface NewCopySheetRequest {
  workspaceId: string;
  provider: NewCopyProvider;
  /** 1.174.0 E1: asked from a "Same folder" chip — the tile that asked and
   *  the names the toast after the copy uses ("Close codex 1"). */
  from?: NewCopyFrom;
}

export interface NewCopyFrom {
  tileId: string;
  self: string;
  peer: string;
}

/** The preselection for a tile: its kind's AI; for any other kind (an agent
 *  run) the AI its coordination session names; else a shell. */
export function newCopyProviderFor(kind: string, sessionProvider?: string | null): NewCopyProvider {
  if (kind === "claude") return "claude";
  if (kind === "codex" || kind === "codex-chat") return "codex";
  if (sessionProvider === "claude" || sessionProvider === "codex") return sessionProvider;
  return "shell";
}

export function openNewCopySheet(request: NewCopySheetRequest): void {
  window.dispatchEvent(
    new CustomEvent<NewCopySheetRequest>(OPEN_NEW_COPY_EVENT, { detail: { ...request } }),
  );
}

/** Subscribe a host to requests; returns the unsubscribe. The handler sees
 *  every request and must act only on its own workspace's. */
export function onOpenNewCopySheet(handler: (request: NewCopySheetRequest) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<NewCopySheetRequest>).detail;
    if (detail && typeof detail.workspaceId === "string") handler(detail);
  };
  window.addEventListener(OPEN_NEW_COPY_EVENT, listener);
  return () => window.removeEventListener(OPEN_NEW_COPY_EVENT, listener);
}
