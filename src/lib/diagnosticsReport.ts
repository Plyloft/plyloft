// 1.176.1: Settings › Diagnostics › Copy report — the whole page as one
// plain-text report a person pastes when asking for help. Pure: the page
// hands it what it read (a part it couldn't read is `null`, and the report
// says so in its place), and every line goes through the shared scrub.
// Node runs it: `node --experimental-strip-types src/lib/diagnosticsReport.test.ts`.
import type { DoctorReport } from "../ipc.ts";
import { diagnosticsHint, diagnosticsTitle, type DiagnosticRow } from "./diagnostics.ts";
import { scrubReport } from "./reportScrub.ts";

export const COULDNT_BE_READ = "couldn't be read";

/** What the page read for the report. `null` = that part couldn't be read. */
export interface ReportParts {
  version: string | null;
  platform: string;
  /** "What Plyloft needs": the page's rows (null: no report yet). */
  needs: DiagnosticRow[] | null;
  probeError: string | null;
  /** "What else Plyloft read": one line per row, as the page words it. */
  other: string[] | null;
  /** "Reviewers can't change files". */
  reviewers: DiagnosticRow[] | null;
  /** The build cache row, as one line (null: couldn't be read; "" no row). */
  buildCache: string | null;
  folders: {
    /** The Program folders setting as saved (empty: not set). */
    setting: string;
    /** What the reading of it says ("Can't work as written: …"; null:
     *  couldn't be read), only read when the setting is set. */
    reading: string | null;
    /** Where the folders come from, in words. */
    source: string;
    /** The folders Plyloft looks in now (null: couldn't be read). */
    dirs: string[] | null;
  };
  /** The per-tool Repair report text (null: couldn't be read). */
  tools: { name: string; text: string | null }[];
  /** 1.176.1: "Settings that can't work as written", the page's rows
   *  (`savedSettingChecks.ts`: certain failures only, never Try it's hints).
   *  Absent or empty: no section. Values are scrubbed like paths. */
  settings?: { label: string; value: string; reason: string }[];
}

/** A row's state in a word the page also shows: its button says what to do. */
function stateWord(row: DiagnosticRow): string {
  if (row.fix.kind === "ready") return "Ready";
  // 1.176.1 walk 2: the state, never the page's button ("Open Program
  // folders" means nothing pasted into a message).
  if (row.fix.kind === "app" && row.fix.what === "program-folders") return "Not in your Program folders";
  const state = row.signal === "error" ? "Not ready" : "Needs a look";
  // Walk 3: a report states the state, not the page's button — except a
  // tool's own command (Install, Sign in), which is what is to be done.
  return row.id.startsWith("tool:") ? `${state} (${row.fix.action})` : state;
}

/** One row as the page words it: title, state, then its sentence. The Git
 *  identity's sentence names the person, so a set one says only that. */
export function rowLine(row: DiagnosticRow): string {
  const hint = row.id === "git-identity" && row.signal === "ok" ? "Set." : diagnosticsHint(row);
  const state = stateWord(row);
  // Walk 3: said once ("Codex: Not in your Program folders. codex · Not in
  // your Program folders." repeated it): the hint's own copy of the state
  // goes, the program's name stays.
  const rest = hint.replace(` · ${state}.`, "").replace(`${state}.`, "").trim();
  return rest ? `- ${diagnosticsTitle(row)}: ${state}. ${rest}` : `- ${diagnosticsTitle(row)}: ${state}.`;
}

/** What names a project in the report: "this project", then "project 2"… —
 *  never the name itself, which can be a client's. */
export function projectLabeller(names: readonly (string | null | undefined)[]): (name: string) => string {
  const seen: string[] = [];
  for (const n of names) if (n && !seen.includes(n)) seen.push(n);
  return (name) => {
    const at = seen.indexOf(name);
    return at <= 0 ? "this project" : `project ${at + 1}`;
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with each project's name as its label (a name of one or two
 *  letters is only a label where the row is built, never found in prose). */
export function neutralise(text: string, names: readonly string[], label: (name: string) => string): string {
  let out = text;
  for (const name of names) {
    if (name.trim().length < 3) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, "g"), label(name));
  }
  return out;
}

/** A team member's name ("last changed by …") is not for a report. */
const noAuthor = (text: string) => text.replace(/,? last changed by [^.]*?(?=[.,]|$)/g, "");

/** The report's "What else Plyloft read" lines, from the doctor report.
 *  Project names become labels; who last changed a shared setup, and the
 *  Railway project's name, are left out. */
export function otherLines(
  report: DoctorReport | null,
  responsiveness: string | null,
  extraNames: readonly (string | null | undefined)[] = [],
): string[] {
  const names = [
    report?.projectSkills?.workspace,
    report?.sharedDefinition?.workspace,
    report?.railway?.workspace,
    ...extraNames,
  ];
  const label = projectLabeller(names);
  const all = names.filter((n): n is string => !!n);
  const clean = (t: string) => neutralise(noAuthor(t), all, label);
  const out: string[] = [];
  if (responsiveness) out.push(`- Responsiveness: ${responsiveness}`);
  if (report?.teamSkills) out.push(`- Team skills: ${report.teamSkills.loaded} loaded. ${report.teamSkills.detail}`);
  if (report?.projectSkills) {
    const p = report.projectSkills;
    out.push(`- Skills in ${label(p.workspace)}: ${p.loaded} loaded. ${clean(p.detail)}`);
  }
  if (report?.sharedDefinition) {
    const d = report.sharedDefinition;
    out.push(`- Shared setup of ${label(d.workspace)}: ${clean(d.summary)}. ${clean(d.detail)}`);
  }
  if (report?.railway) {
    const r = report.railway;
    out.push(`- Railway: ${clean(r.summary).replace(/project\s+\S.*$/i, "project (name left out)")}. ${clean(r.detail)}`);
  }
  return out;
}

/** The build cache row, as one line. */
export function buildCacheLine(
  row: { workspaceName: string; enabled: boolean; status: { exists: boolean } },
  size: string,
  label: string,
): string {
  return `- Build cache: ${label}, ${row.status.exists ? size : "empty"}${row.enabled ? "" : " (off)"}.`;
}

const section = (title: string, lines: string[]) => [title, ...lines, ""];
const unread = (what: string) => `${what} ${COULDNT_BE_READ}.`;

/** The whole report, scrubbed. */
export function diagnosticsReport(p: ReportParts): string {
  const lines: string[] = [];
  lines.push("Plyloft Diagnostics report");
  lines.push(`Plyloft ${p.version ?? `(version ${COULDNT_BE_READ})`} on ${p.platform}`);
  lines.push("");

  lines.push(
    ...section(
      "What Plyloft needs",
      p.needs == null ? [unread("The tools check")] : [...p.needs.map(rowLine), ...(p.probeError ? [`- Plyloft's look at the program folders failed: ${p.probeError}`] : [])],
    ),
  );
  if (p.settings && p.settings.length > 0) {
    lines.push(
      ...section(
        "Settings that can't work as written",
        p.settings.map((x) => `- ${x.label}: ${x.value}. ${x.reason}`),
      ),
    );
  }
  if (p.other == null) lines.push(...section("What else Plyloft read", [unread("It")]));
  else if (p.other.length > 0) lines.push(...section("What else Plyloft read", p.other));
  if (p.reviewers == null) lines.push(...section("Reviewers can't change files", [unread("It")]));
  else if (p.reviewers.length > 0) lines.push(...section("Reviewers can't change files", p.reviewers.map(rowLine)));
  if (p.buildCache == null) lines.push(...section("What Plyloft is keeping on this disk", [unread("The build cache")]));
  else if (p.buildCache) lines.push(...section("What Plyloft is keeping on this disk", [p.buildCache]));

  const f = p.folders;
  lines.push(
    ...section("Program folders", [
      f.setting.trim() ? `- Setting: ${f.setting}` : "- Setting: not set",
      ...(f.setting.trim() ? [`- Reading: ${f.reading ?? unread("It")}`] : []),
      `- Plyloft looks in: ${f.source}`,
      ...(f.dirs == null ? [`- ${unread("The list of folders")}`] : f.dirs.map((d) => `  ${d}`)),
    ]),
  );

  for (const t of p.tools) {
    const text = t.text?.trim();
    lines.push(...section(t.name, [text ? text : unread("Its report")]));
  }
  return scrubReport(lines.join("\n").trimEnd() + "\n");
}
