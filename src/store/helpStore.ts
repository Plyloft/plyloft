import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "../lib/platform";
import { TUTORIAL_SINCE } from "../lib/tutorial/manifest";
import { highlightsToShow, highlightsUnseen, type ReleaseHighlights } from "../lib/releaseHighlights";
import { tourRunning, tourView } from "../lib/tutorial/tutorialEngine";
import {
  UPDATED_TOAST_ACTION,
  needsNewInstallStamp,
  shouldAnnounceUpdate,
  tutorialReport,
  updatedToastTitle,
  withSeenVersion,
  type ReportFacts,
} from "../lib/tutorial/whatsNew";
import { vendorReadiness } from "../lib/vendorReadiness";
import { useAccount } from "./accountStore";
import { useDoctor } from "./doctorStore";
import { useSettings } from "./settingsStore";
import { pushToast } from "./toastStore";
import { useTutorialRuntime, writeTutorial } from "./tutorialStore";
import { useWorkMode } from "./workModeStore";

/**
 * Getting started TU-8 (TUTORIAL_SPEC §12.2, §13, §3.3): New in this
 * version, the tutorial report and Get help. In memory but for `seenVersion`,
 * written when New in this version is opened (`writeTutorial`, spread).
 */
/** What New in this version shows: the installed version's highlights,
 *  and the ones of the versions since the member last looked. */
export type WhatsNew = { current: ReleaseHighlights | null; earlier: ReleaseHighlights[] };

type HelpRuntime = {
  /** The running version, once read (`getVersion`). */
  version: string | null;
  /** New in this version is open, with what it showed as it opened
   *  (opening marks it seen, so the list is kept as it was). */
  whatsNew: WhatsNew | null;
  /** Get help is open. */
  getHelp: boolean;
};

export const useHelp = create<HelpRuntime>(() => ({ version: null, whatsNew: null, getHelp: false }));

let versionAsked = false;
let started = false;

/** The running version, read once; off the app (tests) the release the
 *  tour shipped in stands for it. */
export function loadHelpVersion(): void {
  if (versionAsked) return;
  versionAsked = true;
  void getVersion()
    .then(
      (v) => (typeof v === "string" && v ? v : TUTORIAL_SINCE),
      () => TUTORIAL_SINCE,
    )
    .then((version) => useHelp.setState({ version }));
}

/** §12.2: a new install is stamped with the version it started on, once
 *  the settings and the version are read (`needsNewInstallStamp`). */
function stampNewInstall(): void {
  const version = useHelp.getState().version;
  const s = useSettings.getState();
  if (!version || !s.loaded) return;
  const onboarding = s.settings.onboarding;
  if (!needsNewInstallStamp(onboarding?.tutorial, onboarding?.firstRunCompletedAt)) return;
  void writeTutorial((cur) =>
    needsNewInstallStamp(cur, useSettings.getState().settings.onboarding?.firstRunCompletedAt)
      ? withSeenVersion(cur, version)
      : cur,
  ).catch(() => {});
}

/** QoL 1.168 S3: the version the "Updated to" toast was last shown for, on
 *  this machine. Browser storage, like the Codex update's last attempt: a
 *  lost value at worst shows the toast once more. */
const ANNOUNCED_KEY = "ply.updateAnnounced";
let announceDone = false;

function readAnnounced(): string | null {
  try {
    return localStorage.getItem(ANNOUNCED_KEY);
  } catch {
    return null;
  }
}

function writeAnnounced(version: string): void {
  try {
    localStorage.setItem(ANNOUNCED_KEY, version);
  } catch {
    // Non-critical: the toast may show once more.
  }
}

/** After an update: one quiet toast, "Updated to 1.168.0 · What's new",
 *  which opens New in this version. Decided once per launch, when the
 *  version and the settings are both read. */
function announceUpdate(): void {
  if (announceDone) return;
  const version = useHelp.getState().version;
  const s = useSettings.getState();
  if (!version || !s.loaded) return;
  announceDone = true;
  const show = shouldAnnounceUpdate({
    version,
    firstRunCompletedAt: s.settings.onboarding?.firstRunCompletedAt,
    unseen: whatsNewUnseen(),
    announced: readAnnounced(),
  });
  if (!show) return;
  writeAnnounced(version);
  pushToast({
    kind: "info",
    title: updatedToastTitle(version),
    action: { label: UPDATED_TOAST_ACTION, onClick: openWhatsNew },
    // 1.168.1 (#12): Help keeps the dot and New in this version, so a newer
    // toast replaces this one rather than bringing it back after itself.
    dropWhenCovered: true,
  });
}

/** App start (beside the tour's subscriptions): the version is read at
 *  once, so the report and the dot never wait on the sidebar being shown. */
export function startHelp(): void {
  if (started) return;
  started = true;
  loadHelpVersion();
  useHelp.subscribe(stampNewInstall);
  useSettings.subscribe(stampNewInstall);
  useHelp.subscribe(announceUpdate);
  useSettings.subscribe(announceUpdate);
  stampNewInstall();
  announceUpdate();
}

/** What New in this version would show now. */
export function whatsNewNow(): WhatsNew {
  const version = useHelp.getState().version;
  if (!version) return { current: null, earlier: [] };
  return highlightsToShow(useSettings.getState().settings.onboarding?.tutorial, version);
}

/** The dot on Help: this version's highlights not looked at yet. */
export function whatsNewUnseen(): boolean {
  const version = useHelp.getState().version;
  if (!version) return false;
  return highlightsUnseen(useSettings.getState().settings.onboarding?.tutorial, version);
}

/** Help › New in this version: shows the highlights and marks them seen. */
export function openWhatsNew(): void {
  // Not before the version is read (a few ms at start): opened then, it
  // would show nothing and mark this version seen.
  const version = useHelp.getState().version;
  if (!version) return;
  useHelp.setState({ whatsNew: whatsNewNow() });
  void writeTutorial((cur) => {
    const next = withSeenVersion(cur, version);
    return next === cur ? cur : next;
  }).catch(() => {});
}

export function closeWhatsNew(): void {
  useHelp.setState({ whatsNew: null });
}

export function openGetHelp(): void {
  useHelp.setState({ getHelp: true });
}

export function closeGetHelp(): void {
  useHelp.setState({ getHelp: false });
}

function planWord(): ReportFacts["plan"] {
  const g = useAccount.getState().gates;
  if (!g) return null;
  if (g.teamAllowed) return "Team";
  return "Free";
}

/** Where the tour is, in the app's own words (never the member's). */
function whereNow(): string {
  const record = useSettings.getState().settings.onboarding?.tutorial ?? null;
  const snap = useTutorialRuntime.getState().snapshot;
  if (!tourRunning(record) || !snap) return "no tour under way";
  const view = tourView(record, snap, { focus: useTutorialRuntime.getState().focus });
  if (!view.step) return `${view.doneCount} of ${view.total} done, nothing left to do`;
  return `${view.doneCount} of ${view.total} done, on ${view.step.id}${view.wait ? ` (waiting: ${view.wait})` : ""}`;
}

/** The report, from the stores now. `forHelp`: Get help's — with the AIs'
 *  state and where the tour is. */
export function tutorialReportNow(forHelp = false, short = false): string {
  const settings = useSettings.getState().settings;
  const doctor = useDoctor.getState().report;
  const readiness = vendorReadiness(doctor);
  const facts: ReportFacts = {
    version: useHelp.getState().version ?? TUTORIAL_SINCE,
    platform: platform(),
    level: settings.onboarding?.level ?? null,
    workMode: useWorkMode.getState().mode,
    plan: planWord(),
    // Not checked yet is said so, never "not ready".
    ...(forHelp ? { ai: doctor ? { claude: readiness.claude.ready, codex: readiness.codex.ready } : null } : {}),
  };
  return tutorialReport(settings.onboarding?.tutorial, facts, forHelp ? { where: whereNow(), short } : {});
}

/** Tests: forget the version read. */
export function resetHelpForTests(): void {
  versionAsked = false;
  started = false;
  announceDone = false;
  useHelp.setState({ version: null, whatsNew: null, getHelp: false });
}
