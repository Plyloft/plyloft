import { CBtn } from "./ui/primitives";
import { pressOnce, usePressRunning } from "../lib/pressOnce";
import { READING_BUSY } from "../lib/errorButtons";

/** 1.176.3: the press that reads again what a failed read left unread. One
 *  read at a time per `pressKey` (a second press does nothing, and the button
 *  says it is reading); `run` settles when the read has, and shows its own
 *  failure again (it never raises a second toast). Draw it only when a new
 *  read can differ (`retryCanHelp`). */
export function ReadAgainButton({
  pressKey,
  label,
  run,
  size = "md",
  busy: busyOutside = false,
  name,
}: {
  pressKey: string;
  label: string;
  run: () => Promise<unknown>;
  size?: "sm" | "md";
  /** A read of the same thing is running that this button did not start. */
  busy?: boolean;
  /** What it reads, for a screen reader: "Try again: src". */
  name?: string;
}) {
  const busy = usePressRunning(pressKey) || busyOutside;
  return (
    <CBtn
      size={size}
      disabled={busy}
      aria-label={name && !busy ? `${label}: ${name}` : undefined}
      aria-busy={busy || undefined}
      onClick={() => void pressOnce(pressKey, async () => void (await run()))}
    >
      {busy ? READING_BUSY : label}
    </CBtn>
  );
}
