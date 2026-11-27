import {
  INTAKE_CONCLUDE_POLL_TIMEOUT_MS,
  intakeConcludeTimeoutMessage,
} from "./intakeConclude.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  INTAKE_CONCLUDE_POLL_TIMEOUT_MS === 5 * 60_000,
  "the conclude poll bound must remain five minutes",
);
assert(
  intakeConcludeTimeoutMessage() ===
    "Finish planning timed out — the AI didn't write the plan within 5 minutes. Finish planning again, or cancel and plan again.",
  "default copy must be derived from the five-minute bound",
);
assert(
  intakeConcludeTimeoutMessage(60_000).includes("within 1 minute."),
  "singular duration copy must stay grammatical",
);
assert(
  intakeConcludeTimeoutMessage(60_001).includes("within 2 minutes."),
  "copy must report the bounded ceiling rather than understate it",
);

console.log("intakeConclude contract ✓");
