export type CodexApprovalRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};

/**
 * During `codex_app_start` the backend can emit stderr/exit just before the
 * command response assigns its pid in React. Accept that same-session early
 * event, while still rejecting stale events once the live pid is known.
 */
export function codexEventBelongsToSession(
  sessionId: string,
  currentProcessId: number | null,
  eventSessionId: string,
  eventProcessId: number,
): boolean {
  return (
    eventSessionId === sessionId &&
    (currentProcessId === null || eventProcessId === currentProcessId)
  );
}

export function codexStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function codexApprovalSummary(
  request: CodexApprovalRequest,
): { title: string; detail: string } {
  const reason = codexStringValue(request.params.reason);
  if (request.method === "item/fileChange/requestApproval") {
    const root = codexStringValue(request.params.grantRoot);
    return {
      title: "Codex asks to change files",
      detail: [reason, root && `In ${root}`].filter(Boolean).join("\n"),
    };
  }
  if (request.method === "item/commandExecution/requestApproval") {
    const command = codexStringValue(request.params.command);
    return {
      title: "Codex asks to run a command",
      detail: [command, reason].filter(Boolean).join("\n"),
    };
  }
  return {
    title: "Codex asks for more permissions",
    detail: reason ?? JSON.stringify(request.params.permissions ?? {}, null, 2),
  };
}
