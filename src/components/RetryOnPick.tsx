import { ROLE_WORDS } from "../lib/words";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CBtn, Popover, Select, TypeOrChoose } from "./ux";
import { pushToast } from "../store/toastStore";
import { useBuilder } from "../store/builderStore";
import { useSettings } from "../store/settingsStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useModelCatalog } from "../store/modelCatalogStore";
import { useTeamModels } from "../store/teamModelsStore";
import { cardRetryPlan, type KanbanCard } from "../ipc";
import { EMPTY_ROLE_MODELS, type AgentRole, type AgentVendor } from "../lib/roleModels";
import { effortOptions, modelSuggestions } from "../lib/modelCatalog";
import { TEAM_LABEL, rowValue, withTeam } from "../lib/workspaceModels";
import { cardRoleModel } from "../lib/cardModels";
import { RETRY_ON_LABEL, retryOffered } from "../lib/retryOn";

/**
 * 1.169.0 (A3): "Retry on…" beside a role's model on the card — once its
 * round has finished or failed. Pressed, it offers the models (the catalog's,
 * the team's suggestion first) and the model's efforts, and runs that round
 * again **once** on the choice: the Builder through Start fresh, the
 * Challenger through its own re-review of the same snapshot (even after a
 * verdict), so every gate of the round applies. The choice travels with that
 * one start only; the card's own models stay as they are; Activity records
 * the retry once it has started. The Challenger's vendor is Rust's
 * (`card_retry_plan`); a review that runs on another drops the choice and
 * says so.
 */

let droppedListening = false;
/** Once: a retry whose review ran on another vendor is said. */
function listenForDropped(): void {
  if (droppedListening) return;
  droppedListening = true;
  void listen<{ workspaceId: string; cardId: string; title: string; vendor: AgentVendor }>("retry-on://dropped", (e) => {
    const named = e.payload.title ? `“${e.payload.title}”: the` : "The";
    pushToast({
      kind: "info",
      title: `${named} review ran on ${VENDOR_WORD[e.payload.vendor] ?? e.payload.vendor} instead`,
      body: "The model you chose for the retry isn't available there; the card's own model ran.",
    });
  }).catch(() => {
    droppedListening = false;
  });
}

const VENDOR_WORD: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };
// G2: the saved role id, in the word on screen (the Reviewer).
const ROLE_WORD: Record<AgentRole, string> = ROLE_WORDS;
const CLI_DEFAULT = "The tool's default";
const FOOTNOTE = "Or type the name of any model the tool accepts.";

export function RetryOnPick({ card, role, vendor: given }: { card: KanbanCard; role: AgentRole; vendor: AgentVendor }) {
  const [open, setOpen] = useState(false);
  const [planned, setPlanned] = useState<AgentVendor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const offered = retryOffered(card, role);
  // The Challenger's vendor is the one Rust will review with.
  useEffect(() => {
    if (!offered || role !== "challenger") return;
    listenForDropped();
    let live = true;
    void cardRetryPlan(card.workspaceId, card.id)
      .then((p) => live && p && setPlanned(p.vendor === "codex" ? "codex" : "claude"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [offered, role, card.workspaceId, card.id, card.builder?.review?.at]);
  if (!offered) return null;
  const vendor = role === "challenger" ? planned ?? given : given;
  const label = `${RETRY_ON_LABEL} another model for the ${ROLE_WORD[role]} round (${VENDOR_WORD[vendor]})`;
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      label={label}
      trigger={
        <CBtn
          ref={trigger}
          tone="quiet"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          title={`Run the ${ROLE_WORD[role]} round again once on another model. The card's own model stays as it is.`}
          data-ply-retry-on={role}
          onClick={() => setOpen((o) => !o)}
        >
          {RETRY_ON_LABEL}
        </CBtn>
      }
    >
      {open && <RetryOnMenu card={card} role={role} vendor={vendor} label={label} onDone={() => setOpen(false)} />}
    </Popover>
  );
}

function RetryOnMenu({
  card,
  role,
  vendor,
  label,
  onDone,
}: {
  card: KanbanCard;
  role: AgentRole;
  vendor: AgentVendor;
  label: string;
  onDone: () => void;
}) {
  const catalog = useModelCatalog();
  const team = useTeamModels(card.workspaceId).models;
  const appRows = useSettings((s) => s.settings.behavior.models) ?? EMPTY_ROLE_MODELS;
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.models ?? null);
  // Starts at what the round would run on now.
  const [first] = useState(() => cardRoleModel(card.models, ws, withTeam(appRows, team), vendor, role, catalog));
  const [model, setModel] = useState(first.model ?? "");
  const [effort, setEffort] = useState(first.reasoning ?? "");
  const [busy, setBusy] = useState(false);
  const teamModel = rowValue(team, vendor, role, "model");
  const suggestions = [
    ...(teamModel ? [{ value: teamModel, hint: TEAM_LABEL }] : []),
    ...modelSuggestions(catalog, vendor).filter((o) => o.value !== teamModel),
  ];
  const retry = async () => {
    setBusy(true);
    const choice = { model: model.trim() || null, reasoning: effort.trim() || null };
    try {
      // The choice travels with this one start; the store says why a start
      // didn't go (one toast), and nothing is recorded unless it started.
      if (role === "builder") await useBuilder.getState().start(card.workspaceId, card.id, choice);
      else await useBuilder.getState().reviewRetry(card.workspaceId, card.id, vendor, choice);
      onDone();
    } catch {
      // Already said by the store.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ux-card-model-menu">
      <p className="ux-card-model-title">{label}</p>
      <TypeOrChoose
        value={model}
        onChange={setModel}
        onCommit={setModel}
        options={suggestions}
        defaultLabel={CLI_DEFAULT}
        footnote={FOOTNOTE}
        label={`Retry model (${VENDOR_WORD[vendor]})`}
      />
      <Select
        value={effort}
        options={effortOptions(catalog, vendor, model, effort, [{ value: "", label: CLI_DEFAULT }])}
        label={`Retry effort (${VENDOR_WORD[vendor]})`}
        onChange={setEffort}
      />
      <p className="ux-card-model-line">
        {role === "builder"
          ? "Starts a new session on the work already in the card's copy. The card's own model stays as it is."
          : "Reviews the same work again once on it. The card's own model stays as it is."}
      </p>
      <CBtn tone="strong" size="sm" disabled={busy} onClick={() => void retry()} data-ply-retry-on-start="">
        {role === "builder" ? "Retry the Builder" : "Retry the review"}
      </CBtn>
    </div>
  );
}
