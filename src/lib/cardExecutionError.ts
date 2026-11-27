export const VERIFY_INFLIGHT_MESSAGE =
  "Checks are running for this card. Finish them before starting more work.";
export const ATTEMPT_PENDING_MESSAGE =
  "Work is already starting for this card.";

/** Recognize only the two backend-owned card-execution refusals. Tauri may
 * surface a command error as either a string or an Error instance. */
export function cardExecutionRefusalMessage(error: unknown): string | null {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  for (const message of [VERIFY_INFLIGHT_MESSAGE, ATTEMPT_PENDING_MESSAGE]) {
    if (raw.includes(message)) return message;
  }
  return null;
}
