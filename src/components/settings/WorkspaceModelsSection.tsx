import { ROLE_WORDS } from "../../lib/words";
import { useRef, useState } from "react";
import { CBtn, Captioned, Group, Row, Section, Select, TypeOrChoose } from "../ux";
import { confirmUnknownModel } from "../../lib/unknownModelAsk";
import { useWorkspaces, type Workspace } from "../../store/workspaceStore";
import { type AgentRole, type AgentVendor, type RoleModels } from "../../lib/roleModels";
import { catalogModel, effortOptions, modelSuggestions, unsupportedEffortLine, type ModelCatalog } from "../../lib/modelCatalog";
import { useModelCatalog } from "../../store/modelCatalogStore";
import { catalogFits } from "../../lib/cardModels";
import { useTeamModels, useTeamModelsStore, type TeamModelsState } from "../../store/teamModelsStore";
import {
  FORCE_CLI_DEFAULT_LABEL,
  TEAM_LABEL,
  rowValue,
  withTeamPart,
  withTeam,
  type AppRows,
  effectiveEffort,
  effectivePart,
  fallbackPlaceholder,
  fieldChoice,
  ownsRole,
  teamSuggestsLine,
  teamSummary,
  withModelPart,
  type ModelName,
  type ModelPart,
} from "../../lib/workspaceModels";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * CL-4 (CLARITY_PLAN, idea 11): the open workspace's own Builder and
 * Challenger models, merged field by field over this Mac's rows. Each
 * field's first choice is `Every project's` (1.174.0, DS4; `Use app default`
 * before), its second `The tool's default` (round 2: no flag in this
 * project, whatever the row above says). 1.169.0 (A1): an effort for both
 * vendors, with the levels of the model the row will run on.
 *
 * 1.174.0 (DS4, settings.html scenes 7–8): drawn one AI at a time, as the
 * `Only in <project>` section of AI and models' Claude models / Codex models
 * sub-page; the team's suggestions went to Project › General
 * ({@link TeamModelsSection}, {@link TeamModelsPage}).
 *
 * Personal to this Mac (`Workspace.models` in workspaces.json, through
 * `workspace_set_models`), never in the repository's shared definition
 * (ADR 0003). 1.168.1 (E1): every card spawn follows the roles — the
 * Builder, Plan it, the card's Chat, a plan's proposer and agent runs use
 * the Builder row of their vendor; reviews and a plan's critic the
 * Challenger row. Plain terminal tiles keep the CLI's own. The page's
 * `Reset` stays app-only.
 */

const FOOTNOTE = "Or type the name of any model the tool accepts.";

/** 1.174.0 (DS4, scene 7): the first choice of a project's field — the
 *  Every project section above it. */
export const EVERY_PROJECT_LABEL = "Every project's";

const EFFORT_HEAD = [
  { value: "", label: EVERY_PROJECT_LABEL },
  { value: FORCE_CLI_DEFAULT_LABEL, label: FORCE_CLI_DEFAULT_LABEL },
];

/** The section's title: `Only in lyra`. */
export function onlyInTitle(name: string): string {
  return `Only in ${name}`;
}

/** A model id as a summary names it: the catalog's label, or the id. */
export function catalogName(catalog: ModelCatalog): ModelName {
  return (vendor, id) => catalogModel(catalog, vendor, id)?.label || id;
}

/** What a role's row says under its label (scene 7): the team's suggestion
 *  when there is one, `Follows Every project.` when the project sets nothing
 *  of its own for it, and an effort the model doesn't take. */
function onlyInHint(
  ws: Workspace,
  app: AppRows,
  catalog: ModelCatalog,
  vendor: AgentVendor,
  role: AgentRole,
): string | undefined {
  const fits = catalogFits(catalog, vendor);
  const head =
    teamSuggestsLine(app.team, vendor, role, catalogName(catalog)) ??
    (ownsRole(ws.models, vendor, role) ? null : "Follows Every project.");
  const note = unsupportedEffortLine(
    catalog,
    vendor,
    effectivePart(ws.models, app, vendor, role, "model").value,
    effectivePart(ws.models, app, vendor, role, "reasoning").value,
    effectiveEffort(ws.models, app, vendor, role, fits).value,
  );
  return [head, note].filter(Boolean).join(" ") || undefined;
}

export function WorkspaceModelsSection({ app: appRows, vendor }: { app: RoleModels; vendor: AgentVendor }) {
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));
  const catalog = useModelCatalog();
  // 1.169.0 (A2): the team's suggestions, under this workspace's own rows.
  const team = useTeamModels(ws?.id);
  const app = withTeam(appRows, team.models);
  // Scene 6: with no project open there is no Only in … at all.
  if (!ws) return null;
  return (
    <Section title={onlyInTitle(ws.name)} scope="this-mac">
      <Group>
        <Row kind="text" label="Builder" hint={onlyInHint(ws, app, catalog, vendor, "builder")}>
          <Captioned caption="Model">
            <WorkspaceModelField ws={ws} app={app} catalog={catalog} vendor={vendor} role="builder" />
          </Captioned>
          <Captioned caption="Effort">
            <WorkspaceEffort ws={ws} app={app} catalog={catalog} vendor={vendor} role="builder" />
          </Captioned>
        </Row>
        <Row kind="text" label="Reviewer" hint={onlyInHint(ws, app, catalog, vendor, "challenger")}>
          <Captioned caption="Model">
            <WorkspaceModelField ws={ws} app={app} catalog={catalog} vendor={vendor} role="challenger" />
          </Captioned>
          <Captioned caption="Effort">
            <WorkspaceEffort ws={ws} app={app} catalog={catalog} vendor={vendor} role="challenger" />
          </Captioned>
        </Row>
      </Group>
    </Section>
  );
}

const NO_SUGGESTION = "No suggestion";
/** A2: the first choice of a workspace field when the team suggests one. */
const USE_TEAM_LABEL = "Use the team's";

/** The first choice of a workspace field: the team's when it suggests one. */
function useBelowLabel(app: AppRows, vendor: AgentVendor, role: AgentRole, part: ModelPart): string {
  return rowValue(app.team, vendor, role, part) ? USE_TEAM_LABEL : EVERY_PROJECT_LABEL;
}

/** 1.174.0 (DS4, scene 8): Models suggested for the team's words. */
export const TEAM_MODELS_TITLE = "Models suggested for the team";
export const TEAM_MODELS_NOTE =
  "Each teammate's cards start with these unless their card or their own choice for this project says otherwise.";

/** 1.174.0 (DS4, scene 8): Project › General's Models suggested for the
 *  team — one row per AI with its summary and Change… (Suggest… while it
 *  suggests nothing), which opens {@link TeamModelsPage}. Only while the
 *  project shares its setup, as before. */
export function TeamModelsSection({ workspaceId, onOpen }: { workspaceId: string; onOpen: () => void }) {
  const team = useTeamModels(workspaceId);
  const catalog = useModelCatalog();
  if (!team.shared) return null;
  const named = catalogName(catalog);
  return (
    <Section title={TEAM_MODELS_TITLE} scope="repository" shared={team.shared}>
      <p className="ux-section-note">{TEAM_MODELS_NOTE}</p>
      <Group>
        {(["claude", "codex"] as const).map((vendor) => {
          const summary = teamSummary(team.models, vendor, named);
          return (
            <Row
              key={vendor}
              kind="value"
              label={VENDOR_WORD[vendor]}
              hint={summary}
              action={<CBtn onClick={onOpen}>{summary === "None suggested" ? "Suggest…" : "Change…"}</CBtn>}
            />
          );
        })}
      </Group>
    </Section>
  );
}

/** 1.169.0 (A2): what the team suggests for this repository — in its shared
 *  definition, published through the same queue as every shared field, by
 *  whoever can push it. Read-only for everyone else; absent without a
 *  shared definition. 1.174.0 (DS4): General's sub-page, one section per AI. */
export function TeamModelsPage({ workspaceId }: { workspaceId: string }) {
  const team = useTeamModels(workspaceId);
  const catalog = useModelCatalog();
  if (!team.shared) return null;
  const save = async (vendor: AgentVendor, role: AgentRole, part: ModelPart, value: string) => {
    // Challenger 1: one part changed, every other key (a later build's too)
    // kept; nothing left removes `models` (null). Built on the latest value,
    // so a quick second edit keeps the first.
    try {
      await useTeamModelsStore.getState().save(workspaceId, (current) => withTeamPart(current, vendor, role, part, value));
    } catch (e) {
      pushErrorToast(`Couldn't change the team's ${ROLE_WORD[role]} ${part === "model" ? "model" : "effort"} (${VENDOR_WORD[vendor]})`, e);
    }
  };
  const hint = team.readOnly
    ? "Only someone who can push to this repository can change these."
    : "Suggested to everyone who opens this repository. Their own choices still come first.";
  return (
    <>
      {(["claude", "codex"] as const).map((vendor) => (
        <Section key={vendor} title={VENDOR_WORD[vendor]} scope="repository" shared={team.shared}>
          <Group>
            {(["builder", "challenger"] as const).map((role) => (
              <Row key={role} kind="text" label={ROLE_WORD[role]} hint={hint} disabled={team.readOnly}>
                <Captioned caption="Model">
                  <TeamModelField team={team} catalog={catalog} vendor={vendor} role={role} setTeamPart={save} />
                </Captioned>
                <Captioned caption="Effort">
                  <Select
                    value={rowValue(team.models, vendor, role, "reasoning")}
                    options={effortOptions(
                      catalog,
                      vendor,
                      rowValue(team.models, vendor, role, "model"),
                      rowValue(team.models, vendor, role, "reasoning"),
                      [{ value: "", label: NO_SUGGESTION }],
                    )}
                    label={`Team's ${ROLE_WORD[role]} effort (${VENDOR_WORD[vendor]})`}
                    onChange={(v) => void save(vendor, role, "reasoning", v)}
                  />
                </Captioned>
              </Row>
            ))}
          </Group>
        </Section>
      ))}
    </>
  );
}

function TeamModelField({
  team,
  catalog,
  vendor,
  role,
  setTeamPart,
}: {
  team: TeamModelsState;
  catalog: ModelCatalog;
  vendor: AgentVendor;
  role: AgentRole;
  /** The team's suggestion written — a shared setting, published through
   *  the definition's queue (the named settings write `onCommit` makes). */
  setTeamPart: (vendor: AgentVendor, role: AgentRole, part: ModelPart, value: string) => Promise<void>;
}) {
  const committed = rowValue(team.models, vendor, role, "model");
  const where = `the team's ${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]})`;
  const [draft, setDraft] = useState(committed);
  const seen = useRef(committed);
  if (seen.current !== committed) {
    seen.current = committed;
    setDraft(committed);
  }
  return (
    <TypeOrChoose
      value={draft}
      onChange={setDraft}
      onCommit={(v) => {
        if (v.trim() === committed) return;
        // 1.176.3: a name the catalog doesn't list is asked about, never refused.
        void confirmUnknownModel(v, {
          known: catalog[vendor].models.map((m) => m.id),
          vendor,
          where,
          extra: [NO_SUGGESTION],
        }).then((fine) => {
          if (fine === null) return;
          if (!fine) setDraft(committed);
          else void setTeamPart(vendor, role, "model", v);
        });
      }}
      onCancel={draft === committed ? undefined : () => setDraft(committed)}
      options={modelSuggestions(catalog, vendor)}
      defaultLabel={NO_SUGGESTION}
      footnote={FOOTNOTE}
      label={`Team's ${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]})`}
    />
  );
}

const VENDOR_WORD: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };
// G2: the saved role id, in the word on screen (the Reviewer).
const ROLE_WORD: Record<AgentRole, string> = ROLE_WORDS;

/** The settings write behind every workspace field: one part of the
 *  workspace's rows, through `workspace_set_models`, built on the latest rows
 *  (edits still being saved included). Says so when it was refused. Resolves
 *  to what the field shows afterwards, or null if refused. */
async function setModelPart(
  ws: Workspace,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
  choice: string,
): Promise<string | null> {
  const store = useWorkspaces.getState();
  try {
    await store.updateModels(ws.id, (current) => withModelPart(current, vendor, role, part, choice));
    const now = useWorkspaces.getState().workspaces.find((w) => w.id === ws.id)?.models;
    return fieldChoice(now, vendor, role, part);
  } catch (e) {
    pushErrorToast(`Couldn't change ${ws.name}'s ${ROLE_WORD[role]} ${part === "model" ? "model" : "effort"} (${VENDOR_WORD[vendor]})`, e);
    return null;
  }
}

function WorkspaceModelField({
  ws,
  app,
  catalog,
  vendor,
  role,
}: {
  ws: Workspace;
  app: AppRows;
  catalog: ModelCatalog;
  vendor: AgentVendor;
  role: AgentRole;
}) {
  const committed = fieldChoice(ws.models, vendor, role, "model");
  const where = `${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]}) in ${ws.name}`;
  const [draft, setDraft] = useState(committed);
  const seen = useRef(committed);
  if (seen.current !== committed) {
    seen.current = committed;
    setDraft(committed);
  }
  const teamModel = rowValue(app.team, vendor, role, "model");
  const suggestions = [
    ...(teamModel ? [{ value: teamModel, hint: TEAM_LABEL }] : []),
    ...modelSuggestions(catalog, vendor).filter((o) => o.value !== teamModel),
  ];
  return (
    <TypeOrChoose
      value={draft}
      onChange={setDraft}
      onCommit={(v) => {
        if (v.trim() === committed) return;
        const known = catalog[vendor].models.map((m) => m.id);
        // 1.176.3: a name the catalog doesn't list is asked about, never refused.
        void confirmUnknownModel(v, {
          known,
          vendor,
          where,
          extra: [FORCE_CLI_DEFAULT_LABEL, "cli default", teamModel],
        }).then((fine) => {
          if (fine === null) return;
          if (!fine) {
            setDraft(committed);
            return;
          }
          void setModelPart(ws, vendor, role, "model", v).then((now) => {
            // A refused write leaves what was typed where it is (the toast says why).
            if (now === null) return;
            seen.current = now;
            setDraft(now);
          });
        });
      }}
      onCancel={draft === committed ? undefined : () => setDraft(committed)}
      options={[FORCE_CLI_DEFAULT_LABEL, ...suggestions]}
      defaultLabel={useBelowLabel(app, vendor, role, "model")}
      footnote={FOOTNOTE}
      label={`${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]}) for this workspace`}
      // 1.174.0 (DS4): the team's model when it suggests one, else the
      // section above ("Every project's").
      placeholder={teamModel ? fallbackPlaceholder(app, vendor, role, "model") : EVERY_PROJECT_LABEL}
    />
  );
}

/** The levels of the model this row will run on (1.169.0 A1: both
 *  vendors); a saved level it doesn't take is kept, shown as such. */
function WorkspaceEffort({
  ws,
  app,
  catalog,
  vendor,
  role,
}: {
  ws: Workspace;
  app: AppRows;
  catalog: ModelCatalog;
  vendor: AgentVendor;
  role: AgentRole;
}) {
  const value = fieldChoice(ws.models, vendor, role, "reasoning");
  const model = effectivePart(ws.models, app, vendor, role, "model").value;
  return (
    <Select
      value={value}
      options={effortOptions(catalog, vendor, model, value, [
        { value: "", label: useBelowLabel(app, vendor, role, "reasoning") },
        ...EFFORT_HEAD.slice(1),
      ])}
      label={`${ROLE_WORD[role]} effort (${VENDOR_WORD[vendor]}) for this workspace`}
      onChange={(v) => void setModelPart(ws, vendor, role, "reasoning", v)}
    />
  );
}
