/**
 * Getting started TU-8 (docs/tutorial/TUTORIAL_SPEC.md §12.2, §13, §3.3):
 * New in this version, the tutorial report and Get help's words. Pure — no
 * React, no store, no DOM — so node runs its tests
 * (`src/lib/tutorialWhatsNew.test.ts`).
 */
import type { Platform } from "../platform.ts";
import type { SetupLevel, TutorialProgress, WorkMode } from "../settingsShape.ts";
import { ALL_STEPS, STEP, type TutorialStep } from "./manifest.ts";

// ── Versions ─────────────────────────────────────────────────────────────

/** "1.167.0" → [1, 167, 0]; null for anything that is not one. */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive, as `a` is before, equal to or after `b`. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// ── New in this version (§12.2) ──────────────────────────────────────────
// Since the owner's decision of 2026-10-21 the sheet shows each release's
// highlights (`lib/releaseHighlights.ts`); what stays here is when a person
// has looked (`seenVersion`) and the new-install stamp.

/** A new install: nothing is new to it. Stamped once, before Setup's first
 *  run is done; an install that has run Setup (or was backfilled as an
 *  existing one at startup, `lib.rs::setup`) is left alone. */
export function needsNewInstallStamp(
  record: TutorialProgress | null | undefined,
  firstRunCompletedAt: string | null | undefined,
): boolean {
  if (firstRunCompletedAt) return false;
  return parseVersion(record?.seenVersion) == null && parseVersion(record?.startedVersion) == null;
}

/** New in this version was opened: everything up to `version` is seen.
 *  Never moved back (an older build opened after a newer one). */
export function withSeenVersion(r: TutorialProgress | null | undefined, version: string): TutorialProgress {
  const cur = r ?? {};
  if (parseVersion(cur.seenVersion) != null && compareVersions(cur.seenVersion!, version) >= 0) return cur;
  return { ...cur, seenVersion: version };
}

/**
 * QoL 1.168 S3: the one quiet toast after an update — "Updated to 1.168.0 ·
 * What's new". Shown once per version (`announced` is the version it was last
 * shown for, kept on this machine), only on an install that has run Setup
 * (a new one is stamped seen, `needsNewInstallStamp`), and only while this
 * version's highlights are unseen: opening New in this version first means
 * nothing is said.
 */
export function shouldAnnounceUpdate(facts: {
  version: string | null;
  firstRunCompletedAt: string | null | undefined;
  /** `highlightsUnseen` for the running version. */
  unseen: boolean;
  announced: string | null;
}): boolean {
  if (!facts.version || parseVersion(facts.version) == null) return false;
  if (!facts.firstRunCompletedAt) return false;
  if (!facts.unseen) return false;
  return facts.announced !== facts.version;
}

/** The toast's words. */
export function updatedToastTitle(version: string): string {
  return `Updated to ${version}`;
}
export const UPDATED_TOAST_ACTION = "What's new";

/** The sheet's words. */
export const WHATS_NEW_TITLE = "New in this version";
export const WHATS_NEW_EARLIER = "Since you last looked";
export const WHATS_NEW_FULL_CHANGELOG = "Full changelog";
export const WHATS_NEW_NONE = "The full list of changes is in the changelog on plyloft.com.";

// ── The report (§13) ─────────────────────────────────────────────────────

export interface ReportFacts {
  version: string;
  platform: Platform;
  level: SetupLevel | null;
  workMode: WorkMode | null;
  /** From the account's gates; null unknown. */
  plan: "Free" | "Team" | null;
  /** Get help adds: which AIs read ready on this Mac or PC. */
  ai?: { claude: boolean; codex: boolean } | null;
}

const PLATFORM_WORD: Record<Platform, string> = { mac: "macOS", windows: "Windows" };

function minutesAfter(start: number | null, at: string | undefined): string {
  const ms = at ? Date.parse(at) : NaN;
  if (start == null || Number.isNaN(ms)) return "";
  const m = Math.max(0, Math.round((ms - start) / 60_000));
  return ` at ${m} min`;
}

/**
 * Settings › Diagnostics › Copy tutorial report (§13, D9): plain text the
 * person may paste to us. The app version, this Mac or PC, the level, solo
 * or team, the plan, which tour, and each step done or skipped with its
 * minutes from the start. **Never** a project name, a card title, a brief,
 * a path or an id (SAAS point 4): only step ids, which are the app's own.
 * `where`: Get help adds where the tour is, in the app's own words.
 */
export function tutorialReport(
  record: TutorialProgress | null | undefined,
  facts: ReportFacts,
  opts: {
    where?: string | null;
    steps?: readonly TutorialStep[];
    /** The email's: how many steps were done and skipped instead of each
     *  one, so the link stays short (a mail handler may cut a long one). */
    short?: boolean;
  } = {},
): string {
  const steps = opts.steps ?? ALL_STEPS;
  const r = record ?? {};
  const start = r.startedAt ? Date.parse(r.startedAt) : NaN;
  const t0 = Number.isNaN(start) ? null : start;
  const lines = [
    "Plyloft tutorial report",
    `App ${facts.version} · ${PLATFORM_WORD[facts.platform]} · ${
      facts.level === "fast" ? "just the essentials" : facts.level === "guided" ? "step by step" : "level not chosen"
    } · ${facts.workMode === "team" ? "team mode" : facts.workMode === "solo" ? "solo mode" : "solo or team unknown"} · plan ${facts.plan ?? "unknown"}`,
  ];
  if (facts.ai !== undefined) {
    const word = (ok: boolean) => (ok ? "ready" : "not ready");
    lines.push(
      facts.ai ? `Claude ${word(facts.ai.claude)} · Codex ${word(facts.ai.codex)}` : "Claude and Codex not checked yet",
    );
  }
  const tour = !r.startedAt
    ? "Full tour not started"
    : r.endedAt
      ? `Full tour ended${minutesAfter(t0, r.endedAt)}`
      : r.paused
        ? "Full tour paused"
        : "Full tour under way";
  lines.push(`${tour} · last started: ${r.path === "quick" ? "the 1-minute tour" : r.path === "full" ? "the full tour" : "none"}`);
  if (opts.where) lines.push(`Where the tour is: ${opts.where}`);
  const known = steps.filter((st) => st.kind !== "interrupt");
  const rows: string[] = [];
  for (const st of known) {
    const done = r.done?.[st.id];
    const skipped = r.skipped?.[st.id];
    if (done) rows.push(`  ${st.id}: done${minutesAfter(t0, done)}`);
    else if (skipped) rows.push(`  ${st.id}: skipped${minutesAfter(t0, skipped)}`);
  }
  // Steps a newer app recorded, counted, never named (an id may say more
  // than this build knows).
  const other = [...Object.keys(r.done ?? {}), ...Object.keys(r.skipped ?? {})].filter(
    (id) => !known.some((st) => st.id === id),
  );
  if (opts.short) {
    const done = known.filter((st) => r.done?.[st.id]).length;
    const skipped = known.filter((st) => !r.done?.[st.id] && r.skipped?.[st.id]).length;
    lines.push(`Steps: ${done} done, ${skipped} skipped`);
  } else if (rows.length > 0) lines.push("Steps:", ...rows);
  else lines.push("Steps: none yet");
  if (other.length > 0) lines.push(`  and ${other.length} from a newer version`);
  const shipped = r.done?.[STEP.ship];
  lines.push(shipped ? `First card shipped${minutesAfter(t0, shipped)}` : "First card not shipped with the tour yet");
  lines.push(`Sections whose tip was shown: ${Array.isArray(r.seenSections) ? r.seenSections.length : 0}`);
  return lines.join("\n");
}

// ── Get help (§3.3, D23, D28) ────────────────────────────────────────────

export const SUPPORT_EMAIL = "support@plyloft.com";
export const GET_HELP_TITLE = "Get help";
export const GET_HELP_LEDE =
  "Tell us what happened. Plyloft adds a short report: app version, this Mac, your AI's status and where the tour is. No project names, code or text.";
export const GET_HELP_NOTE = "Nothing is sent by Plyloft itself.";
/** The address, always on the sheet: a mail app that opens on its own
 *  setup screen (Mail with no account) still leaves the way to write. */
export const GET_HELP_ADDRESS_LINE = `Or write to ${SUPPORT_EMAIL} from any mail, with the report copied.`;

/** Email support: a new email to support with the report in its body, sent
 *  by the person from their own mail app. */
export function supportMailto(report: string): string {
  const subject = encodeURIComponent("Plyloft: I need help");
  const body = encodeURIComponent(`What happened:\n\n\n---\n${report}\n`);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}
