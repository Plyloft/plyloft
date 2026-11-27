import { useEffect, useState } from "react";
import { openDialog } from "../../lib/nativeDialog";
import { homeDir } from "@tauri-apps/api/path";
import { CBtn, Callout, Group, MoreMenu, Row, RowValue, Section, Segmented, Toggle } from "../ux";
import { SettingsPage } from "./rows";
import { field } from "./fields";
import { useMacSettings, type MacSettings } from "./useMacSettings";
import { useSettings } from "../../store/settingsStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { useUi } from "../../store/uiStore";
import { useWorkMode } from "../../store/workModeStore";
import { useSetup } from "../../store/setupStore";
import { useGithubStatus } from "../../store/githubStatusStore";
import { useSetupFinish, useSetupFinishFeed, useSetupRequired } from "../../store/setupFinishStore";
import { openGuidedCard, startGuidedFirstCard } from "../../store/firstCardGuideStore";
import { OFFER_SENTENCE, firstCardOffer, firstCardWorkspace } from "../../lib/firstCardGuide";
import { setupSummary, soloRefusal } from "../../lib/setupSteps";
import { accountRow } from "../../lib/githubStep";
import { tildeForm } from "../../lib/projectsFolder";
import { keepCloneRootBefore } from "../../store/projectsFolderWrite";
import { folderShown } from "../../lib/firstProject";
import { platform } from "../../lib/platform";
import { DEFAULT_PROJECTS_FOLDER, type SetupLevel, type SetupStepId } from "../../lib/settingsShape";
import type { GithubStatus } from "../../ipc";
import { GitHubAccountsSection } from "./GitHubAccountsSection";
import type { Scope } from "../../lib/settingsNav";
import { TOUR_RESUME_LABEL } from "../../lib/tutorial/manifest";
import { tipsOn } from "../../lib/tutorial/quickTour";
import { tourRunning } from "../../lib/tutorial/tutorialEngine";
import { startQuickTour } from "../../store/quickTourStore";
import { openGuide, startGuideOver } from "../../store/tutorialStore";
import { pushErrorToast } from "../../lib/errorToast";

/** §9.2: the row's hint, by what the switch says now. */
export const WORK_WITH_A_TEAM_HINT = {
  off: "Team pages, sharing and GitHub Issues boards are hidden.",
  on: "Create or join a team in Team › Members and library.",
} as const;

/** OB-15 (§9.2): the other rows' words. */
export const SETUP_PAGE_WORDS = {
  setupHint: "Everything Plyloft needs, checked again each time Setup opens.",
  levelHint: "Step by step explains each step; just the essentials shows them as one checklist.",
  folderHint:
    "New projects and projects you get from GitHub go in this folder. Folders you already have stay where they are.",
  githubHint: "Optional. Plyloft uses the GitHub command's sign-in and never stores it.",
  guideUnderWay: "The guide is on its card. End it there when you're done.",
} as const;

const LEVELS: { value: SetupLevel; label: string }[] = [
  { value: "guided", label: "Step by step" },
  { value: "fast", label: "Just the essentials" },
];

/** The GitHub accounts row's value (§9.2: "2 accounts"). */
export function githubAccountsWords(status: GithubStatus | null): string {
  if (!status) return "Looking…";
  if (!status.ghFound) return "The GitHub command isn't installed";
  if (status.accounts === null) return "Couldn't tell";
  const signedIn = status.accounts.filter((a) => a.state === "signed-in");
  if (signedIn.length === 0) return "Not signed in";
  return signedIn.length === 1 ? signedIn[0].login : `${signedIn.length} accounts`;
}

const openSetup = (step?: SetupStepId) => useSetup.getState().openSetup("rerun", step);

/**
 * Settings › Account › Setup (onboarding §9.2): how Plyloft is set up on this
 * Mac, and the choices made in Setup.
 *
 * - **Setup** — `Done.` or how many steps are done, and `Open setup`; under it
 *   each required item (§4) with its state and, when it is missing, `Fix`,
 *   which opens Setup on that step. The same facts as the sidebar's
 *   "Setup isn't finished" row (`store/setupFinishStore.ts`).
 * - **How setup explains things** — step by step / just the essentials
 *   (`onboarding.level`; unset reads as step by step).
 * - **Work with a team** (OB-9) — shows the mode Plyloft follows
 *   (`team_work_mode`), chosen or derived; pressing it writes
 *   `settings.team.workMode`. Turning it off is refused while a workspace's
 *   board is on GitHub Issues, with the same sentence as Setup's step 2 and
 *   the one way out. Off, the Team group, the Licence part, sharing and GitHub
 *   Issues boards are not drawn anywhere (presentation only).
 * - **Projects folder** — `~/Projects` until chosen; `Change…` picks a folder
 *   and stores it in tilde form, first keeping the team's clone root where
 *   team workspaces already are (`cloneRootToKeep`).
 * - **GitHub accounts** — every account gh is signed in with (OB-7a's read);
 *   `Manage` opens Setup's GitHub step. OB-7b adds the per-workspace account.
 *   The per-workspace account is OB-7b's `GitHubAccountsSection`, drawn
 *   only when gh lists several accounts, mounted below the Projects section.
 */
export function SetupPage({ scope, hiddenNote }: { scope: Scope; hiddenNote?: string | null }) {
  useSetupFinishFeed();
  const required = useSetupRequired();
  const mac = useMacSettings();
  const levelField = field("onboarding.level");
  const folderField = field("projects.folder");
  const mode = useWorkMode((s) => s.mode);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [makingCard, setMakingCard] = useState(false);
  const activeId = useWorkspaces((s) => s.activeId);
  const configuredIds = useSetupFinish((s) => s.configuredIds);
  const guide = useSettings((s) => s.settings.onboarding?.firstCard ?? null);
  // OB-16 (§14): the guided first card, from Settings too.
  const cardWs = firstCardWorkspace(
    activeId,
    workspaces.map((w) => w.id),
    configuredIds,
  );
  const offer = firstCardOffer(guide, required.items, cardWs);
  // Unknown is shown as on: before the first read every surface is drawn.
  const on = mode !== "solo";
  // Once in a team, "Create or join" has nothing to ask.
  const inTeam = useSettings((s) => Boolean(s.settings.team?.teamRepo?.trim()));
  // Recomputed from the workspaces as they are: once the board is back on
  // Local, the refusal goes by itself.
  const refusal = refused ? soloRefusal(workspaces) : null;
  const level = (mac.value(levelField) as SetupLevel | null) ?? "guided";
  const folder = (mac.value(folderField) as string | null) ?? null;

  const github = useGithubStatus((s) => s.status);
  useEffect(() => {
    void useGithubStatus.getState().refresh(false);
  }, []);
  const githubView = accountRow(github);

  async function choose(next: boolean) {
    if (!next) {
      if (soloRefusal(useWorkspaces.getState().workspaces)) {
        setRefused(true);
        return;
      }
    }
    setRefused(false);
    setBusy(true);
    try {
      await useSettings
        .getState()
        .update((cur) => ({ ...cur, team: { ...cur.team, workMode: next ? "team" : "solo" } }));
      await useWorkMode.getState().refresh();
    } catch (e) {
      pushErrorToast(next ? "Couldn't turn on Work with a team" : "Couldn't turn off Work with a team", e);
    } finally {
      setBusy(false);
    }
  }

  async function firstCard() {
    const leave = () => useUi.getState().setSettingsOverlayOpen(false);
    if (offer.kind === "open") {
      await openGuidedCard(offer.workspaceId, offer.cardId);
      leave();
      return;
    }
    if (offer.kind !== "start" || offer.disabled || !cardWs) return;
    setMakingCard(true);
    try {
      await startGuidedFirstCard(cardWs);
      leave();
    } catch {
      // The Board's toast has said why.
    } finally {
      setMakingCard(false);
    }
  }

  async function changeFolder() {
    setPicking(true);
    try {
      const home = await homeDir().catch(() => null);
      const current = folder ?? DEFAULT_PROJECTS_FOLDER;
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose your projects folder",
        defaultPath: home && current.startsWith("~") ? `${home}${current.slice(1)}` : undefined,
      });
      if (!picked || Array.isArray(picked)) return;
      const next = tildeForm(picked, home);
      if (next === folder) return;
      // The OB-12 safeguard: team workspaces already cloned where the clone
      // root points now keep resolving there.
      await keepCloneRootBefore(next);
      await mac.set(folderField, next);
    } catch (e) {
      pushErrorToast("Couldn't change the projects folder", e);
    } finally {
      setPicking(false);
    }
  }

  return (
    <SettingsPage entry="setup" scope={scope} hiddenNote={hiddenNote}>
      <Section title="Setup" scope="this-mac">
        <Group>
          <Row
            kind="procedure"
            label="Setup"
            hint={SETUP_PAGE_WORDS.setupHint}
            action={<CBtn onClick={() => openSetup()}>Open setup</CBtn>}
          >
            <RowValue>{setupSummary(required.steps, required.facts)}</RowValue>
          </Row>
          {required.items.map((item) => (
            <Row
              key={item.id}
              kind="procedure"
              label={item.label}
              action={
                item.state === "missing" ? (
                  <CBtn
                    aria-label={`Fix in Setup: ${item.label}`}
                    onClick={() => openSetup(item.step)}
                  >
                    Fix
                  </CBtn>
                ) : undefined
              }
            >
              <RowValue>{item.words}</RowValue>
            </Row>
          ))}
          {offer.kind !== "none" && (
            <Row
              kind="procedure"
              label="Guided first card"
              hint={offer.kind === "start" ? (offer.disabled ?? OFFER_SENTENCE) : SETUP_PAGE_WORDS.guideUnderWay}
              action={
                <CBtn
                  disabled={makingCard || (offer.kind === "start" && offer.disabled !== null)}
                  onClick={() => void firstCard()}
                >
                  {offer.label}
                </CBtn>
              }
            />
          )}
        </Group>
      </Section>
      <GettingStartedSection mac={mac} />
      <Section title="How you work" scope="this-mac">
        <Group>
          <Row kind="choice" label="How setup explains things" hint={SETUP_PAGE_WORDS.levelHint}>
            <Segmented
              label="How setup explains things"
              value={level}
              options={LEVELS}
              onChange={(next) => void mac.set(levelField, next)}
            />
          </Row>
          <Row
            kind="toggle"
            label="Work with a team"
            hint={!on ? WORK_WITH_A_TEAM_HINT.off : inTeam ? undefined : WORK_WITH_A_TEAM_HINT.on}
          >
            <Toggle checked={on} disabled={busy} onChange={(next) => void choose(next)} />
          </Row>
        </Group>
        {refusal && (
          <Callout
            kind="warn"
            text={refusal.sentence}
            actions={
              <CBtn
                tone="strong"
                onClick={() =>
                  useUi
                    .getState()
                    .openSettingsSection("board", { workspaceId: refusal.workspaceId })
                }
              >
                Open board settings
              </CBtn>
            }
          />
        )}
      </Section>
      <Section title="Projects" scope="this-mac">
        <Group>
          <Row
            kind="value"
            label="Projects folder"
            hint={SETUP_PAGE_WORDS.folderHint}
            action={
              <CBtn disabled={picking} onClick={() => void changeFolder()}>
                Change…
              </CBtn>
            }
          >
            <RowValue mono>{folderShown(folder ?? DEFAULT_PROJECTS_FOLDER, platform() === "windows")}</RowValue>
          </Row>
          <Row
            kind="value"
            label="GitHub accounts"
            hint={githubView.state === "signed-in" ? githubView.hint : SETUP_PAGE_WORDS.githubHint}
            action={<CBtn onClick={() => openSetup("github")}>Manage</CBtn>}
          >
            <RowValue>{githubAccountsWords(github)}</RowValue>
          </Row>
        </Group>
      </Section>
      <GitHubAccountsSection />
    </SettingsPage>
  );
}

/** TU-8 (TUTORIAL_SPEC §3.5): the rows' words. */
export const GETTING_STARTED_WORDS = {
  tourHint: "The Getting started tour points at the real buttons while you build a card, in your project. It never presses anything for you.",
  tourStart: "Start the tour",
  startOver: "Start over",
  quickHint: "A quick look at each part of Plyloft, one pointer at a time.",
  tipsHint: "The first time you open a part of the app, Plyloft shows one tip about it.",
} as const;

/**
 * TU-8 (TUTORIAL_SPEC §3.5): Settings › Account › Setup › Getting started —
 * the tour (Resume, or Start, and Start over), the 1-minute tour and the
 * tips switch (the same field as Help's). Settings closes first: the tour is
 * drawn over the shell, not over Settings.
 */
function GettingStartedSection({ mac }: { mac: MacSettings }) {
  const record = useSettings((s) => s.settings.onboarding?.tutorial ?? null);
  const level = useSettings((s) => s.settings.onboarding?.level ?? null);
  const running = tourRunning(record);
  // An ended tour reopens where it was (§9): it is resumed, not started.
  const ended = useSettings((s) => {
    const t = s.settings.onboarding?.tutorial;
    return Boolean(t?.startedAt && t.endedAt);
  });
  const resumes = running || ended;
  const tipsField = field("onboarding.tutorial.tips");
  // Settings closes first, and gives the keyboard back to what opened it a
  // frame later: the tour starts after that, so its own focus holds (as
  // Setup's Ready does, TU-6 Mac walk).
  const leave = (then: () => void) => {
    useUi.getState().setSettingsOverlayOpen(false);
    requestAnimationFrame(() => requestAnimationFrame(then));
  };
  return (
    <Section title="Getting started" scope="this-mac">
      <Group>
        <Row
          kind="procedure"
          label="Getting started tour"
          hint={GETTING_STARTED_WORDS.tourHint}
          action={
            <CBtn onClick={() => leave(() => void openGuide())}>
              {resumes ? TOUR_RESUME_LABEL : GETTING_STARTED_WORDS.tourStart}
            </CBtn>
          }
          // G1 walk (tidy tables): one action; Start over is behind ⋯.
          more={
            record?.startedAt ? (
              <MoreMenu
                label="More for Getting started tour"
                items={[
                  {
                    label: GETTING_STARTED_WORDS.startOver,
                    onSelect: () => leave(() => void startGuideOver().then(() => openGuide())),
                  },
                ]}
              />
            ) : undefined
          }
        />
        <Row
          kind="procedure"
          label="Take a 1-minute tour"
          hint={GETTING_STARTED_WORDS.quickHint}
          action={
            <CBtn onClick={() => leave(startQuickTour)}>Start</CBtn>
          }
        />
        <Row kind="toggle" label="Tips when I open a section" hint={GETTING_STARTED_WORDS.tipsHint}>
          <Toggle
            checked={tipsOn(record, level)}
            onChange={(next) => void mac.set(tipsField, next)}
          />
        </Row>
      </Group>
    </Section>
  );
}
