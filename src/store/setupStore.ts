import { create } from "zustand";
import type { SetupCase } from "../lib/setupSteps";
import type { SetupStepId } from "../lib/settingsShape";

/**
 * OB-4 (ONBOARDING_SPEC §3.1): whether the Setup overlay is drawn, and as
 * which case (§5.0 header). Session-only: what persists is
 * `settings.onboarding` (the resume point, the version seen). App opens it at
 * launch from `launchCase`; Settings › Account › Setup, ⌘K "Open setup" and
 * the sidebar's "Setup isn't finished · Finish" open it as a rerun (OB-15).
 */
interface SetupState {
  open: boolean;
  setupCase: SetupCase;
  /** OB-6: a step asked for by the opener (Diagnostics' identity `Set`
   *  opens step 4). The overlay goes there and clears it. */
  step: SetupStepId | null;
  /** Team walk 2026-10-01 (F5): Settings' "I have an invite code" opens the
   *  Team step on Join, with the invite-code field. Taken once by the step. */
  teamPath: "join" | null;
  /** 1.176.0 R6: Diagnostics' Update and Install of Claude Code or Codex
   *  start that action in the AI step, with its consent sheet — taken once
   *  by the step. */
  aiAction: { tool: "claude" | "codex"; action: "install" | "update" } | null;
  /** N14 walk F16c: the GitHub account the opener needs signed in (Settings ›
   *  Team's "Sign in to GitHub" for the team's account). The GitHub step asks
   *  to sign in as it while it isn't. Cleared on close. */
  githubAccount: string | null;
  openSetup: (
    setupCase: SetupCase,
    step?: SetupStepId,
    options?: {
      teamPath?: "join";
      githubAccount?: string | null;
      aiAction?: { tool: "claude" | "codex"; action: "install" | "update" };
    },
  ) => void;
  closeSetup: () => void;
}

/** Where focus was when Setup opened: the shell turns inert under Setup,
 *  which drops its focus, so it is taken before and given back on close. */
let returnFocus: HTMLElement | null = null;

export const useSetup = create<SetupState>((set, get) => ({
  open: false,
  setupCase: "firstRun",
  step: null,
  teamPath: null,
  aiAction: null,
  githubAccount: null,
  openSetup: (setupCase, step, options) => {
    if (!get().open && typeof document !== "undefined") {
      const at = document.activeElement;
      returnFocus = at instanceof HTMLElement && at !== document.body ? at : null;
    }
    set({
      open: true,
      setupCase,
      step: step ?? null,
      teamPath: options?.teamPath ?? null,
      aiAction: options?.aiAction ?? null,
      githubAccount: options?.githubAccount?.trim() || null,
    });
  },
  closeSetup: () => {
    // An unused `teamPath` (the Team step never drawn) must not outlive this
    // opening and pick Join on a later one.
    set({ open: false, teamPath: null, aiAction: null, githubAccount: null });
    const back = returnFocus;
    returnFocus = null;
    // After the shell is no longer inert (the next frame).
    if (back && typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => {
        if (back.isConnected) back.focus({ preventScroll: true });
      });
    }
  },
}));

/** For key listeners under Setup (on window or document, which see keys
 *  typed inside Setup too): answer nothing while Setup is up. 1.178.0 (A3):
 *  only Setup — a missing Plyloft account covers nothing, so shortcuts and
 *  the tutorial work signed out. */
export function setupIsOpen(): boolean {
  return useSetup.getState().open;
}
