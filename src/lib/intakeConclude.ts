export const INTAKE_CONCLUDE_POLL_TIMEOUT_MS = 300_000;

export function intakeConcludeTimeoutMessage(
  timeoutMs = INTAKE_CONCLUDE_POLL_TIMEOUT_MS,
): string {
  const minutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return `Finish planning timed out — the AI didn't write the plan within ${minutes} ${unit}. Finish planning again, or cancel and plan again.`;
}
