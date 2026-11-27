import { CBtn, Callout, Captioned, Group, Row, Section, Segmented, Select, StatusLine, useLandingNonce } from "../ux";
import { openRepair } from "../../lib/openRepair";
import { useSetup } from "../../store/setupStore";
import { useDoctor } from "../../store/doctorStore";
import { pickerNote, setupFixes, singleInstalled, vendorOption, vendorReadiness, VENDOR_NAME as READY_VENDOR_NAME } from "../../lib/vendorReadiness";
import { ChooseField, ResetThisPage, SettingsPage, TextRow, ToggleRow } from "./rows";
import { useMacSettings } from "./useMacSettings";
import { newCardsLine } from "../../lib/settingsShape";
import { WorkspaceModelsSection, catalogName, onlyInTitle } from "./WorkspaceModelsSection";
import { useWorkspaces } from "../../store/workspaceStore";
import { AFTER_FIX_ROUND_SETTING_HINT } from "../../lib/fixRoundCheck";
import { onlyInSummary, onlyInVendor, vendorSummary } from "../../lib/workspaceModels";
import { field } from "./fields";
import { CLI_DEFAULT_LABEL, type MacField } from "../../lib/settingsFields";
import type { AgentVendor } from "../../lib/roleModels";
import { effortOptions, modelSuggestions, unsupportedEffortLine, type ModelCatalog } from "../../lib/modelCatalog";
import { useModelCatalog } from "../../store/modelCatalogStore";
import { useEffect, useState } from "react";
import { entryById, type Scope } from "../../lib/settingsNav";
import { machineWords } from "../../lib/platform";
import {
  BUILDER_PERMISSIONS,
  builderPermissionsLabel,
  BUILDER_PERMISSIONS_SETTING_HINT,
  builderPermissionsHelper,
  readBuilderPermissions,
} from "../../lib/builderPermissions";

/**
 * UX language card 8 (GH #103; BOARDS.md §5 "Settings › This Mac › Builds &
 * runs"): who builds on this Mac, on which model, and how runs are kept. Since
 * C9 (UX-9.3) it is `Claude and Codex`, and Notifications are its last
 * sections before Advanced.
 *
 * Built as the board draws it, with two corrections the board itself records:
 * the model is a **field you can type in or pick from** whose first choice is
 * `CLI default` (Ply cannot list a vendor's models, and a name has to work the
 * day the vendor ships it), and `Effort` sits beside it. 1.169.0 (A1): for
 * both vendors (Claude's `--effort`), the models offered and each model's
 * levels from the catalog (`modelCatalog.ts`).
 *
 * 1.174.0 (DS4, settings.html scenes 6–7): AI and models. "Who builds new
 * cards" shows the AI a new card really starts with (W3); Models is one row
 * per AI with its summary and Change…, which opens that AI's sub-page (this
 * Mac's Builder and Reviewer for every project, then `Only in <project>`),
 * and a sentence says which choice wins. Each sub-page row says what its role
 * does, whichever AI builds now. The team's suggestions are Project ›
 * General's.
 */

const CLAUDE_FOOTNOTE = "Or type the name of any model the claude command accepts.";
/** QoL 1.168 S3 (library-team-settings #33): Codex's own command. */
const CODEX_FOOTNOTE = "Or type the name of any model the codex command accepts.";

/**
 * `Keep run history for`: the board shows `30 days`, and the sectioned Settings
 * had a free number of days with empty meaning never.
 *
 * Review 1, finding 8: a closed `Select` would have taken the free number away
 * from anyone who had set 45. It is the layer's type-or-choose instead, so the
 * board's value is one of the choices and any number of days can still be
 * typed.
 */
const RETENTIONS = ["7", "14", "30", "60", "90"];

const VENDOR_NAME: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

/** 1.174.0 (DS4, scene 6): which AI wins, said once over the Models rows. */
export const MODELS_PRECEDENCE =
  "Which one wins: a card's own choice, then this project's, then the team's suggestion, then this Mac's. Terminals use each AI's own choice.";

/** 1.174.0 (DS4, scene 7): the sub-page Change… opens, one per AI. */
type ModelsSub = "claude-models" | "codex-models";
const SUB_VENDOR: Record<ModelsSub, AgentVendor> = { "claude-models": "claude", "codex-models": "codex" };
const subOf = (v: AgentVendor): ModelsSub => (v === "codex" ? "codex-models" : "claude-models");

export function BuildsRunsPage({
  scope,
  hiddenNote,
}: {
  scope: Scope;
  hiddenNote?: string | null;
}) {
  const mac = useMacSettings();
  const [sub, setSub] = useState<ModelsSub | null>(null);
  // DS4 round 1: a search or link lands on this page's own rows, so it
  // closes a sub-page that would hide them.
  const landing = useLandingNonce();
  useEffect(() => {
    if (landing !== null) setSub(null);
  }, [landing]);
  const vendorField = field("behavior.builderVendor");
  const synthField = field("behavior.discussionSynthesizer");
  const permissionsField = field("behavior.builderPermissions");
  const permissions = readBuilderPermissions(mac.value(permissionsField)) ?? "asks";
  // 1.174.0 (DS4, W3): the AI a new card really starts with — the last
  // card's pick when there is one (the field reads it so); a press writes
  // Settings' own and forgets that pick (`settingsFields.ts`).
  const newCardVendor = (mac.value(vendorField) === "codex" ? "codex" : "claude") as AgentVendor;
  const models = mac.settings.behavior.models;
  const catalog = useModelCatalog();
  const named = catalogName(catalog);
  const activeWs = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));
  // OB-14 (§13.2): a vendor that can't run here is shown disabled, with why.
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const only = singleInstalled(readiness);
  const fixes = setupFixes(readiness);
  // The fix of the AI that isn't there, when only the other one is.
  const onlyFix = only ? (fixes.find((f) => f.vendor !== only) ?? null) : null;

  if (sub) {
    return (
      <VendorModelsPage
        key={activeWs?.id ?? "none"}
        vendor={SUB_VENDOR[sub]}
        mac={mac}
        catalog={catalog}
        scope={scope}
        onBack={() => setSub(null)}
      />
    );
  }

  const ownSummary = activeWs ? onlyInSummary(activeWs.models, named) : null;
  return (
    <SettingsPage
      entry="claude-codex"
      scope={scope}
      hiddenNote={hiddenNote}
      status={
        <StatusLine state="empty">
          {newCardsLine({ builderVendor: newCardVendor, lastBuilderVendor: null }, only)}
        </StatusLine>
      }
    >
      <Section title="Who builds" scope="this-mac">
        <Group>
          {/* 1.174.0 (DS4 round 0, scene 6): with one AI ready, the line
              that sets the other up stands where the two buttons were. */}
          {onlyFix ? (
            <Row
              kind="value"
              label="Who builds new cards"
              hint={`${onlyFix.sentence} Reviews and discussions use separate ${READY_VENDOR_NAME[only!]} sessions.`}
              action={<CBtn onClick={() => useSetup.getState().openSetup("rerun", "ai")}>{onlyFix.label}</CBtn>}
            />
          ) : (
            <Row
              kind="choice"
              label="Who builds new cards"
              hint={
                only
                  ? [pickerNote(readiness), `Reviews and discussions use separate ${READY_VENDOR_NAME[only]} sessions.`]
                      .filter(Boolean)
                      .join(" ")
                  : "The other AI reviews. Picking an AI on a card makes it the choice here too."
              }
            >
              <Segmented
                value={newCardVendor}
                label="Who builds new cards"
                options={[
                  vendorOption("claude", "Claude", readiness),
                  vendorOption("codex", "Codex", readiness),
                ]}
                onChange={(next) => void mac.set(vendorField, next)}
              />
            </Row>
          )}
          {/* 1.171.0 (D1): the default a new card shows before Start build. */}
          <Row
            kind="choice"
            label="How the Builder asks you"
            hint={`${BUILDER_PERMISSIONS_SETTING_HINT} ${builderPermissionsHelper(permissions, newCardVendor)}`}
          >
            <Select
              label="How the Builder asks you"
              value={permissions}
              onChange={(next) => void mac.set(permissionsField, next)}
              options={BUILDER_PERMISSIONS.map((p) => ({ value: p, label: builderPermissionsLabel(p, newCardVendor) }))}
            />
          </Row>
          {/* 1.175.0 F5 (owner I7): beside "How the Builder asks you", on by default. */}
          <ToggleRow mac={mac} field={field("behavior.checkFixRoundsByItself")} label="After a fix round, check by itself" hint={AFTER_FIX_ROUND_SETTING_HINT} />
          {/* GH #175: mapped to this page by #103 with no control here; the
              Board's discussion dialog reads it as its default and writes it
              back, so it stays a setting and is drawn. */}
          <Row
            kind="choice"
            label="Who writes up a discussion"
            hint="Which AI tool writes the synthesis of a discussion started from the Board's Discuss. The dialog can pick the other one, and remembers it here. A plan challenge on a card is written up by its Builder's AI."
          >
            <Segmented
              value={mac.value(synthField) === "codex" ? "codex" : "claude"}
              label="Who writes up a discussion"
              options={[
                vendorOption("claude", "Claude", readiness),
                vendorOption("codex", "Codex", readiness),
              ]}
              onChange={(next) => void mac.set(synthField, next)}
            />
          </Row>
        </Group>
        {/* QoL 1.168 G9: a tool that isn't ready says so with the way to fix
            it — Setup's AI step, where its install and sign-in are. */}
        {fixes.filter((f) => f !== onlyFix).map((f) => (
          <Callout
            key={f.vendor}
            kind="info"
            text={f.sentence}
            actions={
              <CBtn
                onClick={() =>
                  // 1.176.0 R7: one that doesn't start goes to its Repair.
                  f.repair ? void openRepair(f.vendor) : useSetup.getState().openSetup("rerun", "ai")
                }
              >
                {f.label}
              </CBtn>
            }
          />
        ))}
      </Section>

      {/* 1.174.0 (DS4, scene 6): one row per AI, its four controls on a
          sub-page behind Change…, and the open project's own rows. */}
      <Section title="Models" scope="this-mac">
        <p className="ux-section-note">{machineWords(MODELS_PRECEDENCE)}</p>
        <Group>
          {(["claude", "codex"] as const).map((v) => (
            <Row
              key={v}
              kind="value"
              label={VENDOR_NAME[v]}
              hint={readiness[v].ready ? vendorSummary(models, v, named) : "Not set up"}
              action={<CBtn onClick={() => setSub(subOf(v))}>Change…</CBtn>}
            />
          ))}
          {activeWs && (
            <Row
              kind="value"
              label={onlyInTitle(activeWs.name)}
              findAs="Only in this project"
              hint={ownSummary ?? "Follows the rows above."}
              action={
                <CBtn onClick={() => setSub(subOf(onlyInVendor(activeWs.models, newCardVendor)))}>Change…</CBtn>
              }
            />
          )}
        </Group>
      </Section>

      <Section title="Runs" scope="this-mac">
        <Group>
          <ToggleRow
            mac={mac}
            field={field("behavior.autoResumeSuspended")}
            label="Pick up where a run left off"
            hint="After a crash or a restart, Plyloft resumes the run instead of starting again."
          />
          <Row
            kind="text"
            label="Keep run history for"
            hint="In days. Older runs and their output are deleted from this Mac. Left empty, nothing is ever deleted."
          >
            <ChooseField
              mac={mac}
              field={field("behavior.runHistoryRetention.days")}
              label="Keep run history for, in days"
              options={RETENTIONS}
              defaultLabel="For ever"
              footnote="Or type any number of days."
            />
          </Row>
          {/* Added to the board, which drew only one of the two retentions:
              dropping the control would lose a limit people already set. */}
          <TextRow
            mac={mac}
            field={field("behavior.runHistoryRetention.maxRuns")}
            label="Keep at most"
            hint="The newest runs are kept, however young the rest are. Empty keeps as many as there are."
            placeholder="No limit"
            inputMode="numeric"
          />
          <ToggleRow
            mac={mac}
            field={field("behavior.autoCloseFinishedRunTiles")}
            label="Close a run's tile when it finishes"
            hint="A tile a card opened closes itself a few seconds after the run ends. Tiles you opened yourself always stay."
          />
          <ToggleRow
            mac={mac}
            field={field("behavior.injectGlobalMemories")}
            label="Give card work the notes kept on this Mac"
            hint="Card work always gets the workspace's own notes. On, it also gets the ones that live only here."
          />
        </Group>
      </Section>

      {/* 1.174.0 (DS1): Notifications is a page of its own (Look and feel).
          G4 (launch D8): the Advanced section and its role-chain
          swarms switch are gone with the swarm UI. */}
      <ResetThisPage
        mac={mac}
        page="claude-codex"
        hint="Models, effort, auto-resume and retention go back to how Plyloft ships."
      />
    </SettingsPage>
  );
}

/** 1.174.0 (DS4, scene 7): AI and models › Claude models (or Codex
 *  models), behind Change…: this Mac's Builder and Reviewer for every
 *  project, then the open project's own. */
function VendorModelsPage({
  vendor,
  mac,
  catalog,
  scope,
  onBack,
}: {
  vendor: AgentVendor;
  mac: ReturnType<typeof useMacSettings>;
  catalog: ModelCatalog;
  scope: Scope;
  onBack: () => void;
}) {
  const models = mac.settings.behavior.models;
  const suggestions = modelSuggestions(catalog, vendor);
  /** 1.176.3: every model the catalog knows, hidden or older ones too. */
  const known = catalog[vendor].models.map((m) => m.id);
  const footnote = vendor === "claude" ? CLAUDE_FOOTNOTE : CODEX_FOOTNOTE;
  const name = VENDOR_NAME[vendor];
  /** 1.169.0 (A1): a saved effort the row's model doesn't take, said. */
  const hintOf = (role: "builder" | "challenger", hint: string) => {
    const rows = models[vendor];
    const note = unsupportedEffortLine(
      catalog,
      vendor,
      rows[role],
      role === "builder" ? rows.builderReasoning : rows.challengerReasoning,
    );
    return note ? `${hint} ${note}` : hint;
  };
  // Written out per AI: a field id assembled from a template is one
  // `settingsFields.test.ts` cannot read (see `Effort`).
  const f =
    vendor === "claude"
      ? {
          builder: field("behavior.models.claude.builder"),
          builderReasoning: field("behavior.models.claude.builderReasoning"),
          challenger: field("behavior.models.claude.challenger"),
          challengerReasoning: field("behavior.models.claude.challengerReasoning"),
        }
      : {
          builder: field("behavior.models.codex.builder"),
          builderReasoning: field("behavior.models.codex.builderReasoning"),
          challenger: field("behavior.models.codex.challenger"),
          challengerReasoning: field("behavior.models.codex.challengerReasoning"),
        };
  return (
    <SettingsPage
      entry="claude-codex"
      scope={scope}
      title={`${name} models`}
      lede={`The model and effort ${name} uses for each role.`}
      back={{ label: entryById("claude-codex").label, onClick: onBack }}
    >
      <Section title="Every project" scope="this-mac">
        <Group>
          <Row kind="text" label="Builder" hint={hintOf("builder", "Does the work on the card.")}>
            <Captioned caption="Model">
              <ChooseField
                mac={mac}
                field={f.builder}
                label={`Builder model (${name})`}
                options={suggestions}
                knownModels={known}
                vendor={vendor}
                defaultLabel={CLI_DEFAULT_LABEL}
                footnote={footnote}
              />
            </Captioned>
            <Captioned caption="Effort">
              <Effort
                mac={mac}
                catalog={catalog}
                vendor={vendor}
                field={f.builderReasoning}
                modelField={f.builder}
                role="Builder"
              />
            </Captioned>
          </Row>
          {/* T14 (1.174.0): the Reviewer's line, as the glossary says it. */}
          <Row
            kind="text"
            label="Reviewer"
            hint={hintOf("challenger", "Reads the Builder's work before anything ships, and can't edit it.")}
          >
            <Captioned caption="Model">
              <ChooseField
                mac={mac}
                field={f.challenger}
                label={`Reviewer model (${name})`}
                options={suggestions}
                knownModels={known}
                vendor={vendor}
                defaultLabel={CLI_DEFAULT_LABEL}
                footnote={footnote}
              />
            </Captioned>
            <Captioned caption="Effort">
              <Effort
                mac={mac}
                catalog={catalog}
                vendor={vendor}
                field={f.challengerReasoning}
                modelField={f.challenger}
                role="Reviewer"
              />
            </Captioned>
          </Row>
        </Group>
      </Section>
      {/* CL-4: the open project's own rows, merged field by field over the
          section above. */}
      <WorkspaceModelsSection app={models} vendor={vendor} />
    </SettingsPage>
  );
}

/** `Effort` (BOARDS.md §5): the levels the row's model takes (1.169.0 A1:
 *  for both vendors). A saved level the model doesn't take stays shown, as
 *  not on this model — it passes no flag, so the model's default runs.
 *
 *  The fields come in as props rather than being built from `role`: a field
 *  id assembled from a template is one `settingsFields.test.ts` cannot read,
 *  and a typo in it would throw the first time the page rendered. */
function Effort({
  mac,
  catalog,
  vendor,
  field: f,
  modelField,
  role,
}: {
  mac: ReturnType<typeof useMacSettings>;
  catalog: ModelCatalog;
  vendor: AgentVendor;
  field: MacField;
  modelField: MacField;
  role: "Builder" | "Reviewer";
}) {
  const value = String(mac.value(f) ?? "");
  const options = effortOptions(catalog, vendor, String(mac.value(modelField) ?? ""), value, [
    { value: "", label: CLI_DEFAULT_LABEL },
  ]);
  return (
    <Select
      value={value}
      options={options}
      label={`${role} effort (${VENDOR_NAME[vendor]})`}
      onChange={(v) => void mac.set(f, v)}
    />
  );
}
