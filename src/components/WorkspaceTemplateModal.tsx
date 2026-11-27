import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  WORKSPACE_TEMPLATES,
  countClaudeTiles,
  type WorkspaceTemplate,
} from "../lib/workspaceTemplates";
import { useUserTemplates } from "../store/templatesStore";
import { pushToast } from "../store/toastStore";
import { confirmSheet, useConfirmSheet } from "../store/confirmStore";
import type { UserTemplate, UserTileSeedKind } from "../ipc";
import { CBtn, CIcon, Details, Icon, Sheet } from "./ux";
import { rawError } from "../lib/cardPage";
import { setupIsOpen } from "../store/setupStore";

type Props = {
  /** Project receiving the optional session layout. */
  workspaceLabel: string;
  /** Whether `claude` is on PATH. Drives skip-warnings. */
  claudeAvailable: boolean;
  onConfirm: (template: WorkspaceTemplate) => void;
  onCancel: () => void;
};

const COLS = 4;

function userToTemplate(u: UserTemplate): WorkspaceTemplate {
  return {
    id: `user:${u.id}`,
    label: u.label,
    description: u.description || undefined,
    tiles: u.tiles.map((t) => ({ kind: t.kind })),
  };
}

export function WorkspaceTemplateModal({
  workspaceLabel,
  claudeAvailable,
  onConfirm,
  onCancel,
}: Props) {
  const [selectedId, setSelectedId] = useState<string>("shell-1");
  const [showCreate, setShowCreate] = useState(false);
  /** GH #297: a failed delete, said in the sheet with its raw text behind Details. */
  const [deleteError, setDeleteError] = useState<{ label: string; raw: string } | null>(null);
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // The quiet one-shell default takes focus when the sheet opens.
  const initialRef = useRef<HTMLButtonElement | null>(null);

  const userTemplates = useUserTemplates((s) => s.userTemplates);
  const userTemplatesLoaded = useUserTemplates((s) => s.loaded);
  const refreshUserTemplates = useUserTemplates((s) => s.refresh);
  const removeUserTemplate = useUserTemplates((s) => s.remove);

  useEffect(() => {
    if (!userTemplatesLoaded) refreshUserTemplates().catch(() => {});
  }, [userTemplatesLoaded, refreshUserTemplates]);

  const allTemplates = useMemo<WorkspaceTemplate[]>(
    () => [
      ...WORKSPACE_TEMPLATES.filter((template) => template.tiles.length > 0),
      ...userTemplates.map(userToTemplate),
    ],
    [userTemplates],
  );

  const selected = useMemo(
    () => allTemplates.find((t) => t.id === selectedId) ?? null,
    [selectedId, allTemplates],
  );

  const claudeSkipCount = useMemo(() => {
    if (!selected) return 0;
    return claudeAvailable ? 0 : countClaudeTiles(selected);
  }, [selected, claudeAvailable]);

  // Enter confirms and the arrows move between layouts; Esc and Tab are the
  // Sheet's (the shared dialog stack, UX-10.1).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      // GH #280: a key on the delete button or in the new-template form is
      // theirs — Enter there must not apply the layout.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".ws-template-delete, input, textarea, select")) return;
      // A sheet over this one (the delete-template confirm) owns its keys:
      // Enter on its Cancel must not apply the layout underneath.
      if (useConfirmSheet.getState().queue.length > 0) return;
      const dialog = target?.closest?.('[role="dialog"]');
      if (dialog && !dialog.querySelector(".ws-template-grid")) return;
      if (e.key === "Enter" && selected) {
        e.preventDefault();
        onConfirm(selected);
      } else if (
        e.key === "ArrowRight" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown"
      ) {
        const idx = allTemplates.findIndex((t) => t.id === selectedId);
        if (idx < 0) return;
        let next = idx;
        if (e.key === "ArrowRight") next = idx + 1;
        else if (e.key === "ArrowLeft") next = idx - 1;
        else if (e.key === "ArrowDown") next = idx + COLS;
        else if (e.key === "ArrowUp") next = idx - COLS;
        if (next >= 0 && next < allTemplates.length) {
          e.preventDefault();
          const tpl = allTemplates[next];
          setSelectedId(tpl.id);
          cardRefs.current[tpl.id]?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [selectedId, selected, onConfirm, allTemplates]);

  return (
    <Sheet
      title="Several sessions at once"
      lede={`Opens these sessions in ${workspaceLabel}, next to the ones already running.`}
      onClose={onCancel}
      initialFocusRef={initialRef}
      actions={
        <>
          <CBtn onClick={onCancel}>Cancel</CBtn>
          <CBtn
            tone="accent"
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
          >
            Open these sessions
          </CBtn>
        </>
      }
    >
        <div
          className="ws-template-grid"
          role="radiogroup"
          aria-label="Sets of sessions"
        >
          {allTemplates.map((tpl) => {
            const claudeN = countClaudeTiles(tpl);
            const willSkip = !claudeAvailable && claudeN > 0;
            const isUser = tpl.id.startsWith("user:");
            // GH #280: a custom template's delete sits beside its card, a
            // real button with a name — never a click-only span inside the
            // radio.
            const card = (
              <button
                ref={(el) => {
                  cardRefs.current[tpl.id] = el;
                  if (tpl.id === "shell-1") initialRef.current = el;
                }}
                type="button"
                role="radio"
                aria-checked={tpl.id === selectedId}
                className={`ws-template-card${
                  tpl.id === selectedId ? " selected" : ""
                }${willSkip ? " warn" : ""}${isUser ? " user-template" : ""}`}
                onClick={() => setSelectedId(tpl.id)}
                onDoubleClick={() => onConfirm(tpl)}
              >
                <span className="ws-template-card-label">{tpl.label}</span>
                <span className="ws-template-card-count">
                  {tpl.tiles.length} session{tpl.tiles.length === 1 ? "" : "s"}
                </span>
                {tpl.description && (
                  <span className="ws-template-card-desc">{tpl.description}</span>
                )}
                {willSkip && (
                  <span className="ws-template-card-warn">
                    Claude isn't installed, so {claudeN} Claude session
                    {claudeN === 1 ? " is" : "s are"} left out.
                  </span>
                )}
              </button>
            );
            if (!isUser) return <span key={tpl.id} className="ws-template-cell">{card}</span>;
            return (
              <span key={tpl.id} className="ws-template-cell">
                {card}
                <CIcon
                  icon="delete"
                  className="ws-template-delete"
                  aria-label={`Delete ${tpl.label}`}
                  title={`Delete ${tpl.label}`}
                  onClick={async () => {
                    if (
                      !(await confirmSheet({
                        title: `Delete the custom template “${tpl.label}”?`,
                        body: "Workspaces already opened with it keep their tiles.",
                        confirmLabel: "Delete",
                        destructive: true,
                      }))
                    ) {
                      return;
                    }
                    const userId = tpl.id.slice("user:".length);
                    setDeleteError(null);
                    try {
                      await removeUserTemplate(userId);
                      if (selectedId === tpl.id) {
                        setSelectedId("shell-1");
                      }
                    } catch (err) {
                      // GH #297: said in the sheet, where the template is.
                      setDeleteError({ label: tpl.label, raw: rawError(err) });
                    }
                  }}
                />
              </span>
            );
          })}
          <button
            type="button"
            className="ws-template-card ws-template-card-new"
            onClick={() => setShowCreate(true)}
            title="Save a template of your own"
          >
            <span className="ws-template-card-label">
              <Icon name="add" size="sm" />
              New template
            </span>
          </button>
        </div>
        {deleteError && (
          <div className="ux-sheet-alert" role="alert">
            <p>
              “{deleteError.label}” wasn't deleted. It is still in the list; try again.
            </p>
            {deleteError.raw && <Details>{deleteError.raw}</Details>}
          </div>
        )}
        {showCreate && (
          <NewUserTemplateForm
            onCancel={() => setShowCreate(false)}
            onCreated={(t) => {
              setShowCreate(false);
              setSelectedId(`user:${t.id}`);
            }}
          />
        )}
        {selected && claudeSkipCount > 0 && (
          <p className="ws-template-warn">
            Heads up: {claudeSkipCount} claude tile
            {claudeSkipCount === 1 ? "" : "s"} will be skipped because{" "}
            <code>claude</code> isn&rsquo;t in the program folders Plyloft looks in.
          </p>
        )}
    </Sheet>
  );
}

function NewUserTemplateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (t: UserTemplate) => void;
}) {
  const [label, setLabel] = useState("");
  const [labelMissing, setLabelMissing] = useState(false);
  const [noTiles, setNoTiles] = useState(false);
  // The save's raw error: shown only in its Details.
  const [saveError, setSaveErrorDetails] = useState<string | null>(null);
  const labelErrorId = useId();
  const tilesErrorId = useId();
  const [description, setDescription] = useState("");
  const [shellCount, setShellCount] = useState(1);
  const [claudeCount, setClaudeCount] = useState(2);
  const [saving, setSaving] = useState(false);
  const create = useUserTemplates((s) => s.create);

  async function commit() {
    // GH #297: a form marks its own fields; it never toasts a validation.
    const trimmed = label.trim();
    const tiles: { kind: UserTileSeedKind }[] = [];
    for (let i = 0; i < shellCount; i++) tiles.push({ kind: "shell" });
    for (let i = 0; i < claudeCount; i++) tiles.push({ kind: "claude" });
    setLabelMissing(!trimmed);
    setNoTiles(tiles.length === 0);
    if (!trimmed || tiles.length === 0) return;
    setSaveErrorDetails(null);
    setSaving(true);
    try {
      const saved = await create({
        id: "",
        label: trimmed,
        description: description.trim(),
        tiles,
        createdAt: 0,
        updatedAt: 0,
      });
      pushToast({
        kind: "info",
        title: "Custom template saved",
        body: trimmed,
      });
      onCreated(saved);
    } catch (e) {
      setSaveErrorDetails(rawError(e));
      setSaving(false);
    }
  }

  return (
    <div className="ws-template-newform">
      <div className="ws-template-newform-row">
        <input
          type="text"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            if (e.target.value.trim()) setLabelMissing(false);
          }}
          placeholder="Template name (e.g. 'Reviewer pair')"
          aria-label="Template name"
          aria-invalid={labelMissing || undefined}
          aria-describedby={labelMissing ? labelErrorId : undefined}
          autoFocus
          disabled={saving}
        />
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          disabled={saving}
        />
      </div>
      <div className="ws-template-newform-row">
        <label>
          Shell tiles:
          <input
            type="number"
            min={0}
            max={16}
            value={shellCount}
            onChange={(e) => {
              const n = Math.max(0, Number(e.target.value) || 0);
              setShellCount(n);
              if (n > 0) setNoTiles(false);
            }}
            aria-invalid={noTiles || undefined}
            aria-describedby={noTiles ? tilesErrorId : undefined}
            disabled={saving}
          />
        </label>
        <label>
          Claude tiles:
          <input
            type="number"
            min={0}
            max={16}
            value={claudeCount}
            onChange={(e) => {
              const n = Math.max(0, Number(e.target.value) || 0);
              setClaudeCount(n);
              if (n > 0) setNoTiles(false);
            }}
            aria-invalid={noTiles || undefined}
            aria-describedby={noTiles ? tilesErrorId : undefined}
            disabled={saving}
          />
        </label>
        <div className="ws-template-newform-actions">
          <CBtn size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </CBtn>
          <CBtn size="sm" tone="strong" onClick={commit} disabled={saving}>
            {saving ? "Saving…" : "Save template"}
          </CBtn>
        </div>
      </div>
      {labelMissing && (
        <p className="ux-sheet-alert" id={labelErrorId}>
          Give the template a name.
        </p>
      )}
      {noTiles && (
        <p className="ux-sheet-alert" id={tilesErrorId}>
          Add at least one tile.
        </p>
      )}
      {saveError !== null && (
        <div className="ux-sheet-alert" role="alert">
          <p>The template wasn't saved. Nothing else changed; try again.</p>
          {saveError && <Details>{saveError}</Details>}
        </div>
      )}
    </div>
  );
}
