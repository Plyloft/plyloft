import { useState } from "react";
import { CBtn, Group, Row, Select, Sheet, TypeOrChoose } from "./ux";
import { useBuildBoth } from "../store/buildBothStore";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { useWorkspaces } from "../store/workspaceStore";
import { startFieldHint, startModelPrefill, startModelsRequest } from "../lib/buildBoth";
import { EMPTY_ROLE_MODELS } from "../lib/roleModels";
import { effortOptions, modelSuggestions } from "../lib/modelCatalog";
import { useModelCatalog } from "../store/modelCatalogStore";
import { useTeamModels } from "../store/teamModelsStore";
import { withTeam } from "../lib/workspaceModels";

const CLI_DEFAULT = "The tool's default";
const FOOTNOTE = "Or type the name of any model the tool accepts.";
const EFFORT_HEAD = [{ value: "", label: CLI_DEFAULT }];

/**
 * CL-8 — Build with both, pressed: the model of each build, for this card
 * only, before anything moves. Each field starts at its vendor's effective
 * Builder row (this workspace, then the app, then the CLI's own default),
 * and says where that came from. The models chosen are kept on each build
 * and used on its start and on every Resume. Rendered by the card panel of
 * the workspace whose card asked.
 */
export function BuildBothStartSheet({ workspaceId }: { workspaceId: string }) {
  const choosing = useBuildBoth((s) => s.choosing);
  if (!choosing || choosing.workspaceId !== workspaceId) return null;
  return <StartSheet key={choosing.cardId} workspaceId={workspaceId} cardId={choosing.cardId} />;
}

function StartSheet({ workspaceId, cardId }: { workspaceId: string; cardId: string }) {
  // 1.169.0 (A2): prefilled through the team's suggestions too.
  const team = useTeamModels(workspaceId).models;
  const app = withTeam(useSettings((s) => s.settings.behavior.models) ?? EMPTY_ROLE_MODELS, team);
  const own = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.models ?? null);
  const cardModels = useKanban((s) => s.byWorkspace[workspaceId]?.cards.find((c) => c.id === cardId)?.models ?? null);
  // Read once, when the sheet opens: what the person edits is theirs.
  const [claude] = useState(() => startModelPrefill(own, app, "claude", cardModels));
  const [codex] = useState(() => startModelPrefill(own, app, "codex", cardModels));
  const catalog = useModelCatalog();
  const [claudeModel, setClaudeModel] = useState(claude.model);
  const [claudeEffort, setClaudeEffort] = useState(claude.reasoning);
  const [codexModel, setCodexModel] = useState(codex.model);
  const [codexEffort, setCodexEffort] = useState(codex.reasoning);
  const { cancelStart, startWith } = useBuildBoth.getState();
  const begin = () =>
    void startWith(
      workspaceId,
      cardId,
      startModelsRequest({
        claude: { model: claudeModel, reasoning: claudeEffort },
        codex: { model: codexModel, reasoning: codexEffort },
      }),
    );
  return (
    <Sheet
      title="Build with both"
      size="confirm"
      lede="Claude and Codex each build this card in their own copy of the repository; the Reviewer compares the two and you pick one. Choose each build's model — for this card only."
      onClose={cancelStart}
      actions={
        <>
          <CBtn tone="quiet" onClick={cancelStart}>
            Cancel
          </CBtn>
          <CBtn tone="strong" onClick={begin} data-ply-build-both-begin="">
            Start both builds
          </CBtn>
        </>
      }
    >
      <Group label="This card only">
        <Row kind="text" label="Build (Claude)" hint={startFieldHint(claude, claudeModel, claudeEffort)}>
          <TypeOrChoose
            value={claudeModel}
            onChange={setClaudeModel}
            onCommit={setClaudeModel}
            options={modelSuggestions(catalog, "claude")}
            defaultLabel={CLI_DEFAULT}
            footnote={FOOTNOTE}
            label="Build model (Claude)"
          />
          <Select
            value={claudeEffort}
            options={effortOptions(catalog, "claude", claudeModel, claudeEffort, EFFORT_HEAD)}
            label="Build effort (Claude)"
            onChange={setClaudeEffort}
          />
        </Row>
        <Row kind="text" label="Build (Codex)" hint={startFieldHint(codex, codexModel, codexEffort)}>
          <TypeOrChoose
            value={codexModel}
            onChange={setCodexModel}
            onCommit={setCodexModel}
            options={modelSuggestions(catalog, "codex")}
            defaultLabel={CLI_DEFAULT}
            footnote={FOOTNOTE}
            label="Build model (Codex)"
          />
          <Select
            value={codexEffort}
            options={effortOptions(catalog, "codex", codexModel, codexEffort, EFFORT_HEAD)}
            label="Build effort (Codex)"
            onChange={setCodexEffort}
          />
        </Row>
      </Group>
    </Sheet>
  );
}
