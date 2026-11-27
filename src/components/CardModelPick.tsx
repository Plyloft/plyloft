import { ROLE_WORDS } from "../lib/words";
import { confirmUnknownModel } from "../lib/unknownModelAsk";
import { useEffect, useRef, useState } from "react";
import { CBtn, Popover, Select, TypeOrChoose } from "./ux";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { useWorkspaces } from "../store/workspaceStore";
import type { KanbanCard } from "../ipc";
import { EMPTY_ROLE_MODELS, type AgentRole, type AgentVendor } from "../lib/roleModels";
import { effortOptions, modelSuggestions, unsupportedEffortLine } from "../lib/modelCatalog";
import { useModelCatalog } from "../store/modelCatalogStore";
import {
  FORCE_CLI_DEFAULT_LABEL,
  TEAM_LABEL,
  effectivePart,
  fieldChoice,
  rowValue,
  withTeam,
  type WorkspaceModels,
} from "../lib/workspaceModels";
import { useTeamModels } from "../store/teamModelsStore";
import {
  USE_WORKSPACE_LABEL,
  cardEffectiveEffort,
  cardEffectivePart,
  catalogFits,
  cardModelLine,
  cardSetsRole,
  modelFactWords,
  withCardModelPart,
  withoutCardRole,
  type RoleModelFact,
} from "../lib/cardModels";
import { pushErrorToast } from "../lib/errorToast";

/**
 * 1.168.1 (E2/E3): a role's model on the card page — the model the role
 * will run on (and, while a session runs on another, the one it runs on
 * now), pressed to choose one for this card only: a model (free text, the
 * same suggestions as Settings), the tool's default, or the workspace's,
 * and its effort (1.169.0 A1: both vendors, the levels of the model the
 * role will run on). It applies from the next session (Builder) or
 * review (Challenger); a running one keeps its model. Saved on the card
 * (`kanban_card_set_models`), on this Mac only — never on its GitHub issue.
 */

const VENDOR_WORD: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };
// G2: the saved role id, in the word on screen (the Reviewer).
const ROLE_WORD: Record<AgentRole, string> = ROLE_WORDS;
const FOOTNOTE = "Or type the name of any model the tool accepts.";
const EFFORT_HEAD = [
  { value: "", label: USE_WORKSPACE_LABEL },
  { value: FORCE_CLI_DEFAULT_LABEL, label: FORCE_CLI_DEFAULT_LABEL },
];

/** When the next one picks the model up, in words. */
export function appliesFromWords(role: AgentRole): string {
  return role === "builder"
    ? "For this card only, from its next Builder session. A session already running keeps its model."
    : "For this card only, from its next review. A review already running keeps its model.";
}

export function CardModelPick({
  card,
  role,
  fact,
  readOnly = false,
}: {
  card: KanbanCard;
  role: AgentRole;
  fact: RoleModelFact;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  // Esc or a press outside closes the menu; focus goes back to the chip
  // unless the press put it somewhere else (after the press's own focus
  // change, which follows the dismiss).
  // Walk 2026-10-22: closing the menu — Esc, a press outside, the chip —
  // saves what the model field holds, as Enter and Tab-out do; it never
  // drops a typed name.
  const commitOnClose = useRef<(() => void) | null>(null);
  const close = () => {
    commitOnClose.current?.();
    setOpen(false);
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) chip.current?.focus();
    }, 0);
  };
  const vendor = fact.vendor;
  const words = modelFactWords(fact);
  const label = `${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]})`;
  if (readOnly) {
    return (
      <code className="ux-card-mono ux-card-model-value" title={label}>
        {words}
      </code>
    );
  }
  return (
    <Popover
      open={open}
      onClose={close}
      label={`${label} for this card`}
      trigger={
        <CBtn
          ref={chip}
          tone="quiet"
          size="sm"
          className="ux-card-model-chip"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}: ${words} — choose for this card`}
          title={`${label}: ${words}. Press to choose one for this card.`}
          data-ply-card-model={role}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {words}
        </CBtn>
      }
    >
      <CardModelMenu card={card} role={role} vendor={vendor} fact={fact} commitOnClose={commitOnClose} />
    </Popover>
  );
}

function CardModelMenu({
  card,
  role,
  vendor,
  fact,
  commitOnClose,
}: {
  card: KanbanCard;
  role: AgentRole;
  vendor: AgentVendor;
  fact: RoleModelFact;
  /** Set here: what closing the menu runs first (saves the typed model). */
  commitOnClose: { current: (() => void) | null };
}) {
  const appRows = useSettings((s) => s.settings.behavior.models) ?? EMPTY_ROLE_MODELS;
  // 1.169.0 (A2): the team's suggestion, between the workspace's and the app's.
  const team = useTeamModels(card.workspaceId).models;
  const app = withTeam(appRows, team);
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.models ?? null);
  const own = card.models ?? null;
  const catalog = useModelCatalog();
  const save = async (next: WorkspaceModels | null): Promise<boolean> => {
    try {
      await useKanban.getState().setCardModels(card.workspaceId, card.id, next);
      return true;
    } catch (e) {
      pushErrorToast(`Couldn't change this card's ${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]})`, e);
      return false;
    }
  };
  const committed = fieldChoice(own, vendor, role, "model");
  const [draft, setDraft] = useState(committed);
  const seen = useRef(committed);
  if (seen.current !== committed) {
    seen.current = committed;
    setDraft(committed);
  }
  const root = useRef<HTMLDivElement>(null);
  const focusField = () => root.current?.querySelector<HTMLInputElement>("input")?.focus();
  // Walk 2026-10-22: the menu opens with the model field focused, so what
  // is typed goes there — never to the app's one-letter shortcuts.
  useEffect(() => {
    focusField();
    return () => {
      commitOnClose.current = null;
    };
  }, [commitOnClose]);
  // The model field's value is saved once per change: by Enter, Tab-out or
  // a pick from the list, or — when the menu closes — by the close itself.
  // Blank is the workspace's (as the list's first item); a field left as it
  // was saves nothing.
  const saved = useRef(committed);
  saved.current = committed;
  const commitModel = (value: string) => {
    const v = value.trim();
    if (v === saved.current.trim()) return;
    // 1.176.3: a name no list holds is asked about, never refused. Blur, the
    // menu's close and Enter all land here: one question per value.
    void confirmUnknownModel(v, {
      known: catalog[vendor].models.map((m) => m.id),
      vendor,
      where: `${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]}) for this card`,
      extra: [FORCE_CLI_DEFAULT_LABEL, "cli default", rowValue(team, vendor, role, "model")],
    }).then((fine) => {
      if (fine === null) return;
      if (!fine) {
        setDraft(committed);
        return;
      }
      if (v === saved.current.trim()) return;
      saved.current = v;
      void save(withCardModelPart(own, vendor, role, "model", v)).then((ok) => {
        if (!ok) setDraft(committed);
      });
    });
  };
  const latest = useRef(draft);
  latest.current = draft;
  commitOnClose.current = () => commitModel(latest.current);
  const below = effectivePart(ws, app, vendor, role, "model");
  const placeholder = below.value
    ? `${below.value} (${below.source === "workspace" ? "this workspace" : below.source === "team" ? "team" : "app default"})`
    : USE_WORKSPACE_LABEL;
  const teamModel = rowValue(team, vendor, role, "model");
  const suggestions = [
    ...(teamModel ? [{ value: teamModel, hint: TEAM_LABEL }] : []),
    ...modelSuggestions(catalog, vendor).filter((o) => o.value !== teamModel),
  ];
  const label = `${ROLE_WORD[role]} model (${VENDOR_WORD[vendor]}) for this card`;
  const effort = fieldChoice(own, vendor, role, "reasoning");
  // Finding 14: a Build with both choice for this vendor's Builder is what
  // the next session runs on (as `builderModelFact` says), until a choice
  // here replaces it.
  const chosen =
    role === "builder" && card.builder?.vendor === vendor ? card.builder?.chosenModel ?? null : null;
  const runsOn = chosen ? chosen.model?.trim() || null : cardEffectivePart(own, ws, app, vendor, role, "model").value;
  const notOnModel = unsupportedEffortLine(
    catalog,
    vendor,
    runsOn,
    chosen ? chosen.reasoning?.trim() || null : cardEffectivePart(own, ws, app, vendor, role, "reasoning").value,
    chosen ? null : cardEffectiveEffort(own, ws, app, vendor, role, catalogFits(catalog, vendor)).value,
  );
  return (
    <div ref={root} className="ux-card-model-menu">
      <p className="ux-card-model-title">{label}</p>
      <TypeOrChoose
        value={draft}
        onChange={setDraft}
        onCommit={commitModel}
        options={[FORCE_CLI_DEFAULT_LABEL, ...suggestions]}
        defaultLabel={USE_WORKSPACE_LABEL}
        footnote={FOOTNOTE}
        label={label}
        placeholder={placeholder}
      />
      <Select
        value={effort}
        options={effortOptions(catalog, vendor, runsOn, effort, EFFORT_HEAD)}
        label={`${ROLE_WORD[role]} effort (${VENDOR_WORD[vendor]}) for this card`}
        onChange={(v) => void save(withCardModelPart(own, vendor, role, "reasoning", v))}
      />
      {notOnModel && <p className="ux-card-model-line">{notOnModel}</p>}
      <p className="ux-card-model-line">
        {fact.fromBuildBoth
          ? `Runs on ${fact.next}, chosen when Build with both started. A choice here replaces it.`
          : cardModelLine(own, ws, app, vendor, role, catalog)}
      </p>
      <p className="ux-card-model-line">{appliesFromWords(role)}</p>
      <CBtn
        tone="quiet"
        size="sm"
        disabled={!cardSetsRole(own, vendor, role)}
        onClick={() => {
          // The button disables once nothing is left to clear: focus stays in
          // the menu (on the field), so the next Esc closes the menu only.
          saved.current = "";
          latest.current = "";
          setDraft("");
          focusField();
          void save(withoutCardRole(own, vendor, role));
        }}
      >
        {USE_WORKSPACE_LABEL}
      </CBtn>
    </div>
  );
}
