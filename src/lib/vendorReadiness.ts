/**
 * OB-14 (§13.2–13.4): one AI is enough. Which of Claude and Codex can run
 * on this machine, read from the doctor report — the same rows that decide
 * `aiReady` — and the words every vendor picker, Start build and intake use
 * when one of them can't. Pure, so each case is tested.
 */
import type { DoctorReport } from "../ipc.ts";
import type { AgentVendor } from "./roleModels.ts";
import { machineWords } from "./platform.ts";
import { toolDoesNotStart } from "./cliBroken.ts";

export interface VendorState {
  ready: boolean;
  /** Its CLI is on this machine at all — what the backend's review and
   *  discussion line-up go by (`builder::vendor_installed`). */
  installed: boolean;
  /** Why not, as a short fact: "Codex isn't installed". Null when ready. */
  reason: string | null;
  /** What makes it ready: "install Codex", "sign in to Codex". */
  fix: string | null;
  /** 1.176.0 R7: installed but it doesn't start — the fix is its Repair
   *  (`openRepair`), not Setup. */
  repair?: boolean;
}

export type VendorReadiness = Record<AgentVendor, VendorState>;

const READY: VendorState = { ready: true, installed: true, reason: null, fix: null };

export const VENDOR_NAME: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

export function otherVendor(v: AgentVendor): AgentVendor {
  return v === "claude" ? "codex" : "claude";
}

/** Each vendor's state. With no report yet nothing is known, and nothing is
 *  refused: both read as ready (the backend still refuses a missing CLI). */
export function vendorReadiness(report: DoctorReport | null | undefined): VendorReadiness {
  if (!report) return { claude: READY, codex: READY };
  const row = (id: string) => report.tools.find((t) => t.id === id);
  const claude = row("claude");
  const codex = row("codex");
  // 1.176.0 R7: a Claude that is found but certainly doesn't start (R3) is
  // not ready either, as the backend's `doctor::require` refuses it.
  const claudeState: VendorState =
    claude && !claude.found
      ? { ready: false, installed: false, reason: "Claude Code isn't installed", fix: "install Claude Code" }
      : toolDoesNotStart(claude)
        ? { ready: false, installed: true, reason: "Claude Code doesn't start", fix: "repair Claude Code", repair: true }
        : READY;
  let codexState: VendorState = READY;
  if (codex && !codex.found) {
    codexState = { ready: false, installed: false, reason: "Codex isn't installed", fix: "install Codex" };
  } else if (codex && !codex.versionOk) {
    codexState = { ready: false, installed: true, reason: "Codex doesn't start", fix: "repair Codex", repair: true };
  } else if (codex?.auth?.signedIn === false) {
    codexState = { ready: false, installed: true, reason: "Codex isn't signed in", fix: "sign in to Codex" };
  }
  return { claude: claudeState, codex: codexState };
}

/** A vendor choice for a picker: disabled with its reason when not ready —
 *  shown, never hidden (§13.2). */
export function vendorOption(
  vendor: AgentVendor,
  label: string,
  readiness: VendorReadiness,
): { value: AgentVendor; label: string; disabled?: boolean; title?: string } {
  const state = readiness[vendor];
  if (state.ready) return { value: vendor, label };
  return { value: vendor, label: `${label} — ${state.reason}`, disabled: true, title: `${state.reason}.` };
}

/** The Builder picker's quiet line when a vendor can't be chosen: "Codex
 *  isn't installed on this Mac." Null when both can. */
export function pickerNote(readiness: VendorReadiness): string | null {
  const out: string[] = [];
  for (const v of ["claude", "codex"] as const) {
    const s = readiness[v];
    if (!s.ready) out.push(machineWords(`${s.reason} on this Mac.`));
  }
  return out.length ? out.join(" ") : null;
}

/** QoL 1.168 G9: a vendor that isn't ready, and the button that makes it
 *  ready — "Codex isn't installed on this Mac." · Install Codex — which
 *  opens Setup's AI step, where the install and the sign-in live. */
export interface SetupFix {
  vendor: AgentVendor;
  sentence: string;
  /** "Install Codex", "Sign in to Codex", "Repair Codex". */
  label: string;
  /** 1.176.0 R7: the press is the vendor's Repair. */
  repair?: boolean;
}

export function setupFixes(readiness: VendorReadiness): SetupFix[] {
  const out: SetupFix[] = [];
  for (const vendor of ["claude", "codex"] as const) {
    const s = readiness[vendor];
    if (s.ready || !s.reason) continue;
    const fix = s.fix ?? `install ${VENDOR_NAME[vendor]}`;
    out.push({
      vendor,
      sentence: machineWords(`${s.reason} on this Mac.`),
      label: fix.charAt(0).toUpperCase() + fix.slice(1),
      ...(s.repair ? { repair: true } : {}),
    });
  }
  return out;
}

export interface StartRefusal {
  /** "Codex isn't installed on this Mac. Choose Claude for this card, or install Codex." */
  sentence: string;
  /** The vendor the first action switches the card to, when it is ready. */
  switchTo: AgentVendor | null;
  /** The second action's label: "Install Codex", "Sign in to Codex". */
  fixLabel: string;
  /** 1.176.0 R7: the fix is this vendor's Repair (`openRepair`). */
  repairs: AgentVendor | null;
}

/** §13.2: Start build on a card whose vendor isn't ready is refused, with
 *  two ways out — the other vendor for this card, or fixing this one. */
export function startRefusal(vendor: AgentVendor, readiness: VendorReadiness): StartRefusal | null {
  const state = readiness[vendor];
  if (state.ready) return null;
  const other = otherVendor(vendor);
  const otherReady = readiness[other].ready;
  const fix = state.fix ?? `install ${VENDOR_NAME[vendor]}`;
  const sentence = otherReady
    ? `${state.reason} on this Mac. Choose ${VENDOR_NAME[other]} for this card, or ${fix}.`
    : `${state.reason} on this Mac. ${fix.charAt(0).toUpperCase()}${fix.slice(1)} to build this card.`;
  return {
    sentence: machineWords(sentence),
    switchTo: otherReady ? other : null,
    fixLabel: fix.charAt(0).toUpperCase() + fix.slice(1),
    repairs: state.repair ? vendor : null,
  };
}

/** §13.3: who plans a card — its Builder vendor when ready, else the other
 *  one (the backend's `intake_vendor`, the same rule). */
export function intakeVendorFor(preferred: AgentVendor, readiness: VendorReadiness): AgentVendor {
  if (readiness[preferred].ready) return preferred;
  const other = otherVendor(preferred);
  return readiness[other].ready ? other : preferred;
}

/** Only one of the two can run here. */
export function singleVendor(readiness: VendorReadiness): AgentVendor | null {
  if (readiness.claude.ready && !readiness.codex.ready) return "claude";
  if (readiness.codex.ready && !readiness.claude.ready) return "codex";
  return null;
}

/** Only one of the two is installed at all — the backend's single-vendor
 *  case for reviews and discussions (Challenger P3-3: an installed Codex that
 *  is signed out still takes part, and a discussion then needs it). */
export function singleInstalled(readiness: VendorReadiness): AgentVendor | null {
  if (readiness.claude.installed && !readiness.codex.installed) return "claude";
  if (readiness.codex.installed && !readiness.claude.installed) return "codex";
  return null;
}

/** Plan with two AIs (owner, 2026-10-16, Q5): who proposes and who
 *  critiques. With both vendors ready, the card's Builder vendor proposes
 *  and the other critiques; with one ready, it takes both roles (two
 *  separate sessions); with none, null. The backend's `plan_exchange::lineup`
 *  — the same rule. */
export function twoAisLineup(
  preferred: AgentVendor,
  readiness: VendorReadiness,
): { proposer: AgentVendor; critic: AgentVendor } | null {
  const claude = readiness.claude.ready;
  const codex = readiness.codex.ready;
  if (claude && codex) return { proposer: preferred, critic: otherVendor(preferred) };
  if (claude) return { proposer: "claude", critic: "claude" };
  if (codex) return { proposer: "codex", critic: "codex" };
  return null;
}

/** What stops Plan with two AIs here: only no vendor ready at all (one is
 *  enough, Q5). Null when one is ready. 1.174.1 P5 (T5): "this Mac", or
 *  this PC on Windows (`machineWords`), as the other lines here. */
export function twoAisBlocker(readiness: VendorReadiness): string | null {
  if (readiness.claude.ready || readiness.codex.ready) return null;
  const why = (["claude", "codex"] as const)
    .map((v) => readiness[v].reason ?? `${VENDOR_NAME[v]} isn't ready`)
    .join(", and ");
  return machineWords(
    `Plan with two AIs needs Claude Code or Codex installed and signed in on this Mac. ${why}. Set one up in Setup, then come back.`,
  );
}

/** What stops a discussion here: an installed vendor that isn't ready takes
 *  part (its leg would fail), so it has to be fixed first. Null when none. */
export function discussionBlocker(readiness: VendorReadiness): string | null {
  for (const v of ["claude", "codex"] as const) {
    const s = readiness[v];
    if (s.installed && !s.ready && s.fix) {
      // 1.176.0 R7: a line with no button names where Repair is.
      const fix = s.repair
        ? "Repair it in Settings › Setup and account › Diagnostics › Repair"
        : s.fix.charAt(0).toUpperCase() + s.fix.slice(1);
      return machineWords(
        `${s.reason} on this Mac, and a discussion uses every AI tool that is installed. ${fix} before you start one.`,
      );
    }
  }
  return null;
}
