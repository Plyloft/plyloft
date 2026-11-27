import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { MoreMenu, type MenuItem, type MenuTrigger } from "../ux/MoreMenu";
import { StatusRow } from "../SidebarStatus";
import { openWebLink, type MenuHelpAction } from "../../ipc";
import { updateFlow } from "../UpdatePrompt";
import { shortcutKeys } from "../../lib/shortcuts";
import { QUICK_TOUR_LINK } from "../../lib/tutorial/manifest";
import { tipsOn } from "../../lib/tutorial/quickTour";
import { tourRunning, tourView } from "../../lib/tutorial/tutorialEngine";
import { tourQuiet } from "../../lib/tutorial/tourPanel";
import { useSettings } from "../../store/settingsStore";
import { setTourTips, startQuickTour } from "../../store/quickTourStore";
import { openGetHelp, openWhatsNew, useHelp, whatsNewUnseen } from "../../store/helpStore";
import { pushToast } from "../../store/toastStore";
import { openGuide, resumeGuide, useTutorialRuntime } from "../../store/tutorialStore";
import { useUi } from "../../store/uiStore";
import { linkDidNotOpen } from "../../lib/linkToast";

/** D14: the user guide, on the site. */
export const USER_GUIDE_URL = "https://www.plyloft.com/docs/";

/** The user guide in the browser; a toast says where it is when it can't. */
export function openUserGuide(): void {
  void openWebLink(USER_GUIDE_URL).catch((e: unknown) =>
    pushToast(linkDidNotOpen(USER_GUIDE_URL, e)),
  );
}

/** QoL 1.168 S3: Check for updates — the app menu, the Windows tray, Help,
 *  ⌘K and Settings › Account › Profile. */
export function checkForUpdates(): void {
  void updateFlow().checkNow();
}

/** QoL 1.168 S3: a menu item the page answers (`menu://help`). */
export function runHelpAction(action: MenuHelpAction): void {
  switch (action) {
    case "check-updates":
      checkForUpdates();
      return;
    case "guide":
      openUserGuide();
      return;
    case "whats-new":
      openWhatsNew();
      return;
    case "getting-started":
      void openGuide();
      return;
  }
}

/**
 * Getting started TU-4 (TUTORIAL_SPEC §3.3): Help in the sidebar — since
 * 1.169.0 (C9) a row of its own, "? Help", at the bottom of the navigation
 * above the foot's line (it was a `?` left of Settings): Getting started, Take a 1-minute tour and Tips when I
 * open a section (TU-6), New in this version with the dot on the row while
 * something is unseen, Keyboard shortcuts, User guide and Get help (TU-8).
 */
export function HelpMenu({
  onNavigate,
  trigger,
}: {
  onNavigate?: () => void;
  /** C9: the sidebar draws Help as one of its rows. */
  trigger?: (t: MenuTrigger) => ReactNode;
}) {
  const ended = useSettings((s) => Boolean(s.settings.onboarding?.tutorial?.endedAt));
  // §12.2: the dot follows the record and the version (read at start,
  // `startHelp`).
  const version = useHelp((s) => s.version);
  const record = useSettings((s) => s.settings.onboarding?.tutorial ?? null);
  // The deps are what `whatsNewUnseen` reads from the stores.
  const unseen = useMemo(() => (whatsNewUnseen() ? 1 : 0), [version, record]);
  const tips = useSettings((s) => tipsOn(s.settings.onboarding?.tutorial, s.settings.onboarding?.level));
  const items: MenuItem[] = [
    {
      label: "Getting started",
      // §9: an ended tour is still offered, and reopens where it was.
      hint: ended ? "Start again where you left it" : undefined,
      onSelect: () => {
        onNavigate?.();
        // One guide at a time: the Quick tour gives way (`openGuide`).
        void openGuide();
      },
    },
    {
      label: QUICK_TOUR_LINK,
      onSelect: () => {
        onNavigate?.();
        startQuickTour();
      },
    },
    {
      // §6.5, D15: the switch; unset, the Setup level's default.
      label: "Tips when I open a section",
      toggle: true,
      checked: tips,
      onSelect: () => void setTourTips(!tips).catch(() => {}),
    },
    {
      // §12.2: what changed since the member last looked.
      label: "New in this version",
      badge: unseen > 0 ? "New" : undefined,
      onSelect: () => {
        onNavigate?.();
        openWhatsNew();
      },
    },
    {
      label: "Keyboard shortcuts",
      shortcut: shortcutKeys("shortcuts"),
      onSelect: () => {
        onNavigate?.();
        useUi.getState().setShortcutsOpen(true);
      },
    },
    {
      label: "User guide",
      onSelect: openUserGuide,
    },
    {
      // QoL 1.168 S3: look for a new version now (the Mac's Plyloft menu and
      // the Windows tray have it too).
      label: "Check for updates…",
      onSelect: () => {
        onNavigate?.();
        checkForUpdates();
      },
    },
    {
      // §3.3, D23: a sheet that emails support or copies the report.
      label: "Get help",
      onSelect: () => {
        onNavigate?.();
        openGetHelp();
      },
    },
  ];
  return (
    <MoreMenu
      label="Help"
      icon="help"
      tour="help"
      trigger={trigger}
      items={items}
      dot={unseen > 0 ? "Something new in this version" : undefined}
    />
  );
}

/**
 * §3.4: "Getting started · 4 of 10 · Resume" in the sidebar's foot while a
 * tour is under way and its panel is closed (paused, or not opened since
 * launch) — the only place it waits, with no pill (1.174.0, D3b). While the
 * panel is open the row shows the count alone. The Setup row wins when both
 * apply (`SidebarFoot` draws one). Quiet once B11 is done or skipped
 * (owner, 1.174.0 A8), not at the end of the base chapter.
 */
export function TutorialStatusRow() {
  const record = useSettings((s) => s.settings.onboarding?.tutorial ?? null);
  const snapshot = useTutorialRuntime((s) => s.snapshot);
  const panelOpen = useTutorialRuntime((s) => s.panelOpen);
  const focusRequest = useTutorialRuntime((s) => s.focusRequest);
  const resume = useRef<HTMLButtonElement>(null);
  const view = useMemo(
    () => (tourRunning(record) && snapshot ? tourView(record, snapshot) : null),
    [record, snapshot],
  );
  const shown = view != null && tourRunning(record) && !tourQuiet(record);
  // 1.174.0 (D3b, T10): the tour running is the open panel. While it is
  // open the row keeps the count and has no Resume — one Resume, one place.
  const offersResume = shown && !(panelOpen && !record?.paused);
  // Pause sends the keyboard to this Resume (the pill is gone).
  useEffect(() => {
    if (focusRequest?.to !== "sidebar" || !offersResume || !resume.current) return;
    resume.current.focus({ preventScroll: true });
    useTutorialRuntime.setState({ focusRequest: null });
  }, [focusRequest, offersResume]);
  if (!shown) return null;
  // TU-4 Mac walk: one line cut the count off at the sidebar's width
  // ("Getting started · 2 …"): the count and Resume go on a second line,
  // never cut; it reads as one sentence.
  return (
    <StatusRow
      tone="info"
      text="Getting started"
      detail={`${view.doneCount} of ${view.total}`}
      action={
        offersResume
          ? { label: "Resume", onClick: () => void resumeGuide(), title: "Open the Getting started panel" }
          : undefined
      }
      actionRef={resume}
    />
  );
}
