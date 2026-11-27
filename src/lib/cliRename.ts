import { ptyWrite, terminalTileNamePassed } from "../ipc";

/**
 * Terminals block P2, walk of blocks A+B: the member's name typed into the
 * CLI as `/rename <name>`. The Enter is its own write a moment later —
 * Codex 0.163's composer takes text and `\r` in one write as a paste and
 * leaves it unsent; the intake's priming does the same for Claude
 * (`intake.rs` PRIMING_SUBMIT_DELAY_MS). The record learns the name was
 * passed only once it was submitted (`passedName`).
 */
export const SUBMIT_DELAY_MS = 400;

export async function passNameToCli(
  ptyId: string,
  name: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const clean = name.replace(/[\r\n]/g, " ");
  const enc = new TextEncoder();
  try {
    await ptyWrite(ptyId, enc.encode(`/rename ${clean}`));
    await wait(SUBMIT_DELAY_MS);
    await ptyWrite(ptyId, enc.encode("\r"));
    await terminalTileNamePassed(ptyId, clean);
  } catch {
    // The tile ended meanwhile: nothing was passed.
  }
}
