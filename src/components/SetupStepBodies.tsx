// OB-4 (ONBOARDING_SPEC §5): the bodies of Setup's steps, drawn inside the
// frame (`SetupOverlay`). Steps 1, 2 and 10 are built here; step 3 (AI
// tools, OB-5) is `SetupAiStep.tsx`; steps 4 to 9 are in `setup/` (OB-6,
// OB-7a, OB-10, OB-12, OB-13).
import { useState } from "react";
import {
  CBtn,
  Callout,
  ChoiceList,
  Group,
  MoreMenu,
  Row,
  Section,
  Segmented,
  StateWord,
  type RunState,
} from "./ux";
import { machineWords } from "../lib/platform";
import { DETECTED_TEAMS_LABEL } from "../lib/teamStep";
import type { SetupLevel, SetupStepId, WorkMode } from "../lib/settingsShape";
import {
  stateWord,
  type SetupFacts,
  type SetupStepView,
  type StepState,
} from "../lib/setupSteps";
import { CHANGE_LABEL, OFFER_SENTENCE, SET_IT_UP_LABEL, type FirstCardOffer } from "../lib/firstCardGuide";
import {
  QUICK_TOUR_LATER,
  QUICK_TOUR_LINK,
  QUICK_TOUR_SENTENCE,
  tourOfferSentence,
} from "../lib/tutorial/manifest";
import { useAccount } from "../store/accountStore";
import { signedInLine } from "../lib/signIn";

/** A step state's dot; `empty` draws none (nothing to say yet). */
export const STATE_DOT: Record<Exclude<StepState, "empty">, RunState> = {
  done: "done",
  skipped: "empty",
  needs: "aborted",
};

export function StepStateWord({ state }: { state: StepState }) {
  const word = stateWord(state);
  if (state === "empty" || !word) return null;
  return <StateWord state={STATE_DOT[state]}>{word}</StateWord>;
}

// ── Step 1 — Welcome ─────────────────────────────────────────────────────

export const WELCOME_TITLE = "Welcome to Plyloft";

export function WelcomeStep({
  choice,
  onChoose,
}: {
  choice: SetupLevel | null;
  onChoose: (level: SetupLevel) => void;
}) {
  return (
    <>
      <p className="ux-setup-text">
        Plyloft runs your projects with AI coding agents. You describe a task on a card, an agent
        works on it in a separate copy of your code, and you review the result before it lands.
      </p>
      <Section title="How much have you used Git and a terminal?">
        <ChoiceList<SetupLevel | "">
          label="How much have you used Git and a terminal?"
          // QoL 7.1 (S3-5): Setup preselects "I'm new to this" so Continue works at once.
          value={choice ?? ""}
          onChange={(v) => {
            if (v) onChoose(v);
          }}
          options={[
            {
              value: "guided",
              label: "I'm new to this",
              hint: "Plyloft explains each step and asks before it changes anything.",
            },
            {
              value: "fast",
              label: "I use them regularly",
              hint: "A short checklist. Plyloft still asks before it installs or changes anything.",
            },
          ]}
        />
      </Section>
    </>
  );
}

// ── Step 2 — Solo or team ────────────────────────────────────────────────

export const MODE_TITLE = "Do you work alone or with a team?";

export type SoloRefusalView = { workspaceId: string; name: string; sentence: string };

/** The refusal under the choice, with its one way out. */
function RefusalCallout({
  refusal,
  onOpenBoardSettings,
}: {
  refusal: SoloRefusalView;
  onOpenBoardSettings: (workspaceId: string) => void;
}) {
  return (
    <Callout
      kind="warn"
      text={refusal.sentence}
      actions={
        <CBtn tone="strong" onClick={() => onOpenBoardSettings(refusal.workspaceId)}>
          Open board settings
        </CBtn>
      }
    />
  );
}

export function ModeStep({
  choice,
  onChoose,
  detectedLine,
  refusal,
  onOpenBoardSettings,
}: {
  choice: WorkMode | null;
  onChoose: (mode: WorkMode) => void;
  /** "Plyloft found a team on this Mac: “MB Adv”." */
  detectedLine: string | null;
  /** Set when a workspace's board is on GitHub Issues. */
  refusal: SoloRefusalView | null;
  onOpenBoardSettings: (workspaceId: string) => void;
}) {
  return (
    <>
      <ChoiceList<WorkMode | "">
        label={MODE_TITLE}
        value={choice ?? ""}
        onChange={(v) => {
          if (v) onChoose(v);
        }}
        options={[
          {
            value: "solo",
            label: "On my own",
            hint: "Plyloft hides team pages and sharing. Your projects stay on this Mac unless you connect GitHub.",
          },
          {
            value: "team",
            label: "With a team",
            hint: "Share projects, a board and a library with people you invite. A team lives in a private GitHub repository, so you'll need GitHub.",
          },
        ]}
      />
      {detectedLine && <p className="ux-setup-note">{machineWords(detectedLine)}</p>}
      {choice === "solo" && refusal && (
        <RefusalCallout refusal={refusal} onOpenBoardSettings={onOpenBoardSettings} />
      )}
    </>
  );
}

// ── The fast path's checklist ────────────────────────────────────────────

/** OB-12: a checklist row's inline choice (§3.2 "Choices that cannot be
 *  detected … are inline"): the value it would use, its one action while the
 *  step isn't done, and a way to choose otherwise. */
export interface ChecklistInline {
  hint?: string;
  action?: { label: string; onPress: () => void; disabled?: boolean } | null;
  more?: { label: string; onSelect: () => void }[];
}

export function SetupChecklist({
  steps,
  mode,
  onMode,
  refusal,
  onOpenBoardSettings,
  onOpen,
  aiAction,
  githubAction,
  teamAction,
  inline,
}: {
  steps: SetupStepView[];
  /** Step 2's answer, chosen inline. */
  mode: WorkMode;
  onMode: (mode: WorkMode) => void;
  refusal: SoloRefusalView | null;
  onOpenBoardSettings: (workspaceId: string) => void;
  onOpen: (id: SetupStepId) => void;
  /** OB-5: the AI row's action — the step's own (Install, Update, Sign in),
   *  started in the step; null = "Set up" opens the step to ask which. */
  aiAction?: { label: string; onPress: () => void } | null;
  /** OB-7a: the GitHub row's `Connect GitHub`, started in the step. */
  githubAction?: { label: string; onPress: () => void } | null;
  /** OB-10: the Team row, while GitHub isn't connected (D14). */
  teamAction?: { label: string; onPress: () => void } | null;
  /** OB-12: rows answered inline (Projects folder, First project). */
  inline?: Partial<Record<SetupStepId, ChecklistInline>>;
}) {
  const [refused, setRefused] = useState(false);
  return (
    <>
      <Group label="Setup checklist">
        {steps
          .filter((s) => s.id !== "ready")
          .map((s) =>
            s.id === "mode" ? (
              <Row key={s.id} kind="choice" label={s.title} hint="You can change this later in Settings.">
                <Segmented<WorkMode>
                  label={s.title}
                  value={mode}
                  onChange={(next) => {
                    if (next === "solo" && refusal) {
                      setRefused(true);
                      return;
                    }
                    setRefused(false);
                    onMode(next);
                  }}
                  options={[
                    { value: "solo", label: "On my own" },
                    { value: "team", label: "With a team" },
                  ]}
                />
              </Row>
            ) : (
              <Row
                key={s.id}
                kind="procedure"
                label={s.title}
                hint={inline?.[s.id]?.hint}
                more={inline?.[s.id]?.more ? <MoreMenu items={inline[s.id]!.more!} /> : undefined}
                action={
                  s.state === "done" || s.id === "welcome" ? undefined : inline?.[s.id]?.action ? (
                    <CBtn
                      tone="strong"
                      onClick={inline[s.id]!.action!.onPress}
                      disabled={inline[s.id]!.action!.disabled}
                    >
                      {inline[s.id]!.action!.label}
                    </CBtn>
                  ) : s.id === "ai" && aiAction ? (
                    <CBtn tone="strong" onClick={aiAction.onPress}>
                      {aiAction.label}
                    </CBtn>
                  ) : s.id === "github" && githubAction ? (
                    <CBtn tone="strong" onClick={githubAction.onPress}>
                      {githubAction.label}
                    </CBtn>
                  ) : s.id === "team" && teamAction ? (
                    <CBtn tone="quiet" onClick={teamAction.onPress}>
                      {teamAction.label}
                    </CBtn>
                  ) : (
                    <CBtn tone="strong" onClick={() => onOpen(s.id)}>
                      Set up
                    </CBtn>
                  )
                }
              >
                <StepStateWord state={s.state} />
              </Row>
            ),
          )}
      </Group>
      {refused && refusal && (
        <RefusalCallout refusal={refusal} onOpenBoardSettings={onOpenBoardSettings} />
      )}
    </>
  );
}

// ── Step 10 — Ready ──────────────────────────────────────────────────────

export const READY_TITLE = "Plyloft is ready";

export function ReadyStep({
  facts,
  steps,
  teamName,
  teamsFound = [],
  projectsFolder,
  workspaceName,
  tourWorkspaceName,
  guided,
  onFinishStep,
  firstCard,
  firstCardBusy = false,
  onFirstCard,
  firstCardInFooter = false,
  onProjectSettings,
  tour = null,
  quickTour = null,
}: {
  facts: SetupFacts;
  steps: SetupStepView[];
  teamName: string | null;
  /** F2's deduction: `owner/name` of each Plyloft team listing the account
   *  (`setup_team_hint`), said while no team is joined here. */
  teamsFound?: readonly string[];
  projectsFolder: string;
  workspaceName: string | null;
  /** 1.176.3: the project the tour starts in (it can differ from Setup's). */
  tourWorkspaceName?: string | null;
  guided: boolean;
  onFinishStep: (id: SetupStepId) => void;
  /** OB-16 (§14): the guided first card's offer. */
  firstCard: FirstCardOffer;
  firstCardBusy?: boolean;
  onFirstCard: () => void;
  /** UX P-C: the offer is the footer's primary ("I'm new to this"); the
   *  body keeps its sentence and the set-up line, not a second button. */
  firstCardInFooter?: boolean;
  /** UX P-C: the set-up line's Change / Set it up (the Project settings step). */
  onProjectSettings?: () => void;
  /** Getting started TU-5 (TUTORIAL_SPEC §2, D6): "I'm new to this" — Start
   *  the tour, in place of the guided first card. `leads`: it is the
   *  footer's primary (nothing required missing); else a quiet button here. */
  tour?: { label: string; leads: boolean; busy: boolean; onStart: () => void } | null;
  /** Getting started TU-6 (§2, D7): "I use them regularly" — a quiet *Take
   *  a 1-minute tour*, in place of the guided first card (which stays in the
   *  full tour's B3 and in Settings › Account › Setup). */
  quickTour?: { busy: boolean; onStart: () => void } | null;
}) {
  const state = (id: SetupStepId): StepState => steps.find((s) => s.id === id)?.state ?? "empty";
  const stillToDo = steps.filter((s) => s.required.length > 0 && s.state !== "done");
  const account = useAccount((s) => s.info);
  const devSkip = useAccount((s) => s.devSkip);
  const tourSentence = tour ? tourOfferSentence(tourWorkspaceName ?? workspaceName) : null;
  return (
    <>
      {/* 1.176.3 (walk): while the tour leads, its sentence comes first, so the
          footer's two buttons are never read without the words that explain them. */}
      {tour?.leads && <p className="ux-setup-note">{tourSentence}</p>}
      <Group label="What you have">
        <Row
          kind="value"
          label="Plyloft account"
          // 1.171.0 A3 (walk#1/#2): never "Not signed in" beside Done — the
          // step can be done before the account's details are read. 1.178.0
          // (A3, D7): optional, so not signed in says what it is for; a test
          // build that skips sign-in says so (the step reads Skipped).
          hint={
            facts.plyloftSignedIn && account?.signedIn
              ? `${signedInLine(account)}.`
              : state("account") === "done"
                ? "Signed in."
                : devSkip && !account?.signedIn
                  ? "Sign-in skipped on this test build."
                  : "Not signed in. Only needed to start or join a team."
          }
        >
          <StepStateWord state={state("account")} />
        </Row>
        <Row
          kind="value"
          label="AI"
          hint={state("ai") === "done" ? "Claude Code or Codex is ready." : "No AI tool is ready yet."}
        >
          <StepStateWord state={state("ai")} />
        </Row>
        <Row
          kind="value"
          label="Git"
          hint={
            state("git") === "done"
              ? "Git works, and your commits carry your name."
              : "Git or your name isn't set up yet."
          }
        >
          <StepStateWord state={state("git")} />
        </Row>
        <Row kind="value" label="GitHub for pull requests" hint={facts.githubSignedIn ? "Connected." : "Local only."}>
          <StepStateWord state={state("github")} />
        </Row>
        {facts.workMode === "team" && (
          <Row
            kind="value"
            label="Team"
            hint={
              facts.teamJoined
                ? (teamName ?? "You're in a team.")
                : // Immediacy walk (run 1, note 3): what the deduction found.
                  teamsFound.length > 0
                  ? `${DETECTED_TEAMS_LABEL}: ${teamsFound.join(", ")}.`
                  : "Not in a team yet."
            }
          >
            <StepStateWord state={state("team")} />
          </Row>
        )}
        <Row kind="value" label="Projects folder" hint={projectsFolder}>
          <StepStateWord state={state("folder")} />
        </Row>
        <Row kind="value" label="First project" hint={workspaceName ?? "None yet."}>
          <StepStateWord state={state("project")} />
        </Row>
      </Group>
      {stillToDo.length > 0 && (
        <Section title="Still to do">
          <Group label="Still to do">
            {stillToDo.map((s) => (
              <Row
                key={s.id}
                kind="procedure"
                label={s.title}
                action={
                  <CBtn tone="strong" onClick={() => onFinishStep(s.id)}>
                    Finish
                  </CBtn>
                }
              >
                <StepStateWord state={s.state} />
              </Row>
            ))}
          </Group>
        </Section>
      )}
      {tour && (
        <div className="ux-setup-firstcard" data-ply-tour-offer={tour.leads ? "footer" : "body"}>
          {!tour.leads && (
            <CBtn tone="quiet" disabled={tour.busy} onClick={tour.onStart}>
              {tour.label}
            </CBtn>
          )}
          {!tour.leads && <p className="ux-setup-note">{tourSentence}</p>}
          {/* UX P-C: what the press saves first, before the press; or why
              Plyloft couldn't read it (the tour still starts; its card's
              Start build asks for it then). */}
          {firstCard.kind === "start" && firstCard.setUp && (
            <p className="ux-setup-note" data-ply-first-card-setup="">
              {firstCard.setUp.line}
              {onProjectSettings && (
                <>
                  {" "}
                  <CBtn tone="quiet" onClick={onProjectSettings}>
                    {CHANGE_LABEL}
                  </CBtn>
                </>
              )}
            </p>
          )}
          {firstCard.kind === "start" && firstCard.setItUp && firstCard.disabled && (
            <p className="ux-setup-note">
              {firstCard.disabled}
              {onProjectSettings && (
                <>
                  {" "}
                  <CBtn tone="quiet" onClick={onProjectSettings}>
                    {SET_IT_UP_LABEL}
                  </CBtn>
                </>
              )}
            </p>
          )}
        </div>
      )}
      {quickTour && !tour && (
        <div className="ux-setup-firstcard" data-ply-quick-tour-offer="">
          <CBtn tone="quiet" disabled={quickTour.busy} onClick={quickTour.onStart}>
            {QUICK_TOUR_LINK}
          </CBtn>
          <p className="ux-setup-note">{QUICK_TOUR_SENTENCE}</p>
          <p className="ux-setup-note">{machineWords(QUICK_TOUR_LATER)}</p>
        </div>
      )}
      {/* TU-6: on "I use them regularly" the 1-minute tour takes the guided
          card's place; a guided card under way keeps its way back. */}
      {!tour && (!quickTour || firstCard.kind === "open") && firstCard.kind !== "none" && (
        <div className="ux-setup-firstcard" data-ply-first-card-offer={firstCardInFooter ? "footer" : "body"}>
          {!firstCardInFooter && (
            <CBtn
              tone="quiet"
              disabled={firstCardBusy || (firstCard.kind === "start" && firstCard.disabled !== null)}
              reason={firstCard.kind === "start" ? (firstCard.disabled ?? null) : null}
              onClick={onFirstCard}
            >
              {firstCard.label}
            </CBtn>
          )}
          {firstCard.kind === "start" && firstCard.disabled && (
            <p className="ux-setup-note">
              {firstCard.disabled}
              {firstCard.setItUp && onProjectSettings && (
                <>
                  {" "}
                  <CBtn tone="quiet" onClick={onProjectSettings}>
                    {SET_IT_UP_LABEL}
                  </CBtn>
                </>
              )}
            </p>
          )}
          {guided && firstCard.kind === "start" && !firstCard.disabled && (
            <p className="ux-setup-note">{OFFER_SENTENCE}</p>
          )}
          {/* UX P-C: the press saves the detected settings first; this says
              what it will use, before the press. */}
          {firstCard.kind === "start" && !firstCard.disabled && firstCard.setUp && (
            <p className="ux-setup-note" data-ply-first-card-setup="">
              {firstCard.setUp.line}
              {onProjectSettings && (
                <>
                  {" "}
                  <CBtn tone="quiet" onClick={onProjectSettings}>
                    {CHANGE_LABEL}
                  </CBtn>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </>
  );
}
