/**
 * 1.168.1 (E1, Challenger): whether an agent run went through Codex — the
 * run view's "Codex" badge. A run records its CLI (`provider`) from 1.168.1
 * on; one recorded before it is told by its model's name, as before (every
 * Codex run then passed `-m gpt-5.5`). A Codex run with no model chosen now
 * records no model, so `provider` is the only sign of it.
 */
export function runWentThroughCodex(run: { provider?: string | null; model?: string | null }): boolean {
  if (run.provider) return run.provider === "codex";
  return Boolean(run.model?.startsWith("gpt-"));
}
