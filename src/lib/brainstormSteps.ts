/**
 * GH #278: a brainstorm template's steps, said in words — "Scout, then
 * Builder, then Reviewer — up to 3 rounds, 1 hour" — for the sheet's
 * Details, where the raw chain, iteration cap and wall-time used to be the
 * first layer. Pure, so node reads it.
 */

export interface TemplateShape {
  steps: { role: string }[];
  maxIterations: number;
  maxWallSeconds: number;
}

function roleName(role: string): string {
  const r = role.trim();
  return r ? r[0].toUpperCase() + r.slice(1) : r;
}

/** "1 hour", "45 minutes", "1 hour 30 minutes". */
export function durationWords(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ");
}

export function templateStepsWords(t: TemplateShape): string {
  const chain = t.steps.map((s) => roleName(s.role)).join(", then ");
  const rounds = `up to ${t.maxIterations} round${t.maxIterations === 1 ? "" : "s"}`;
  return `${chain || "No steps"} — ${rounds}, ${durationWords(t.maxWallSeconds)}`;
}
