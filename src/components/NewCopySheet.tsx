// 1.173.0 A3: Terminals › New › "In a new copy…" — the sheet of scene 2
// (mockup copies.html): a name, where the copy starts, and what opens in it.
// It makes the copy (A2's `copy_create`, which returns while the setup runs)
// and opens the tile in it at once; the tile head says "Copy · <name>" and
// "Setting up…" until the setup ends.
import type { TileCli } from "../lib/ptySpawnIpc";
import { toolDoesNotStart } from "../lib/cliBroken";
import { REPAIR_IN_DIAGNOSTICS } from "../lib/startFailure";
import { useDoctor } from "../store/doctorStore";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { copyCreate, copyStartPoint, type CopyStartPoint, type ShellEnvInfo } from "../ipc";
import { machineWords } from "../lib/platform";
import {
  NEW_COPY_LEDE,
  NEW_COPY_OPEN,
  NEW_COPY_OPENING,
  newCopyOpeningHint,
  NEW_COPY_TITLE,
  NOT_IN_COPY_LABEL,
  copyTrustSheetHint,
  notInCopyWords,
  plainCopyError,
  startedLocallyWords,
  startsFromWords,
} from "../lib/copyWords";
import type { NewCopyProvider } from "../lib/newCopySheet";
import { useCopies } from "../store/copiesStore";
import { useAreasView, useCurrentArea } from "../store/areaStore";
import { copyBranch } from "../lib/areaPicker";
import { pushToast } from "../store/toastStore";
import { useTiles } from "../store/tileStore";
import { openCodexTile } from "../store/openCodexTile";
import { showNewTile } from "../store/tileActions";
import { CBtn, Segmented, Sheet, TextField } from "./ux";

/** One labelled row of the sheet (1.174.0 E2: one place for its classes). */
function SheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="copy-sheet-field">
      <span className="copy-sheet-label">{label}</span>
      {children}
    </div>
  );
}

/** A quiet line of the sheet. */
function SheetHint({ children, role, failure }: { children: ReactNode; role?: "status" | "alert"; failure?: boolean }) {
  return (
    <p className={failure ? "copy-sheet-hint copy-sheet-failure" : "copy-sheet-hint"} role={role}>
      {children}
    </p>
  );
}

/** The AI choices this Mac has, the preselection kept when it is installed.
 *  1.176.0 R7: one installed that doesn't start (`broken`, from the doctor
 *  report, or Codex's `codexHealthy`) is disabled too, and says where its
 *  Repair is — the segmented control has no room for a button. */
export function newCopyChoices(
  env: ShellEnvInfo | null | undefined,
  broken: readonly TileCli[] = [],
): Array<{ value: NewCopyProvider; label: string; disabled?: boolean; title?: string }> {
  const choice = (value: TileCli, label: string, path: string | null | undefined, healthy: boolean) => {
    if (!path) return { value, label, disabled: true, title: machineWords(`${label} isn't installed on this Mac.`) };
    if (!healthy)
      return {
        value,
        label,
        disabled: true,
        title: machineWords(`${label} doesn't start on this Mac. Repair it in ${REPAIR_IN_DIAGNOSTICS}.`),
      };
    return { value, label, disabled: false, title: undefined };
  };
  return [
    choice("claude", "Claude", env?.claudePath, !broken.includes("claude")),
    choice("codex", "Codex", env?.codexPath, !broken.includes("codex") && env?.codexHealthy !== false),
    { value: "shell" as const, label: "Shell" },
  ];
}

export function firstOpenable(
  env: ShellEnvInfo | null | undefined,
  wanted: NewCopyProvider,
  broken: readonly TileCli[] = [],
): NewCopyProvider {
  const choices = newCopyChoices(env, broken);
  if (!choices.find((c) => c.value === wanted)?.disabled) return wanted;
  return choices.find((c) => !c.disabled)?.value ?? "shell";
}

/** The CLIs the doctor report says don't start (`lib/cliBroken`). */
function useBrokenClis(): TileCli[] {
  const report = useDoctor((s) => s.report);
  return (["claude", "codex"] as const).filter((tool) =>
    toolDoesNotStart(report?.tools.find((t) => t.id === tool)),
  );
}

export function NewCopySheet({
  workspaceId,
  env,
  provider,
  onClose,
  onMade,
}: {
  workspaceId: string;
  env: ShellEnvInfo | null;
  provider: NewCopyProvider;
  onClose: () => void;
  /** After the copy is made and its tile opened (1.174.0 E1: that tile). */
  onMade?: (tile: { id: string; label: string } | null) => void;
}) {
  // Focus starts on the name (the sheet reads this ref after mount).
  const nameWrap = useRef<HTMLLabelElement>(null);
  const nameRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    nameRef.current = nameWrap.current?.querySelector("input") ?? null;
  }, []);
  const [name, setName] = useState("");
  const broken = useBrokenClis();
  const [open, setOpen] = useState<NewCopyProvider>(() => firstOpenable(env, provider, broken));
  const [start, setStart] = useState<CopyStartPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // 1.173.0 (B2): a new copy starts from the current area's branch (one
  // area: its branch); otherwise the workspace's target.
  const areaView = useAreasView(workspaceId);
  const area = useCurrentArea(workspaceId);
  const target = copyBranch(areaView, area?.id ?? null);

  useEffect(() => {
    let live = true;
    setStart(null);
    copyStartPoint(workspaceId, target)
      .then((sp) => live && setStart(sp))
      .catch(() => live && setStart(null));
    return () => {
      live = false;
    };
  }, [workspaceId, target]);

  const startsFrom = startsFromWords(start, Date.now());
  const notInCopy = notInCopyWords(start);
  const trustHint = copyTrustSheetHint(open, start?.claudeTrusted);

  async function make() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const row = await copyCreate(workspaceId, name, open, target);
      useCopies.getState().upsert(workspaceId, row);
      const tiles = useTiles.getState();
      const tile =
        open === "claude"
          ? tiles.addClaudeTile(workspaceId, row.path)
          : open === "codex"
            ? openCodexTile(workspaceId, row.path, env, "codex")
            : tiles.addShellTile(workspaceId, row.path);
      showNewTile(tile);
      // E2 (P20): what the sheet said before isn't said again; only what
      // turned up while it was made — GitHub unreachable, or this Mac's
      // branch found ahead of (or diverged from) GitHub's when the sheet's
      // own read didn't say so (Challenger 1, E2-1).
      const sheetSaid =
        row.baseSource === "localAhead"
          ? Boolean(start?.startsLocal)
          : row.baseSource === "origin"
            ? (start?.localAhead ?? 0) > 0
            : false;
      const local =
        start?.fromGitHub && !sheetSaid ? startedLocallyWords(row.baseSource, row.baseBranch, row.baseNote) : null;
      if (local) pushToast({ kind: "info", title: "Copy made", body: machineWords(local) });
      onMade?.(tile ? { id: tile.id, label: tile.label } : null);
      onClose();
    } catch (e) {
      setFailure(plainCopyError(e).body);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={NEW_COPY_TITLE}
      lede={NEW_COPY_LEDE}
      size="confirm"
      onClose={onClose}
      canDismiss={!busy}
      initialFocusRef={nameRef}
      actions={
        <>
          <CBtn onClick={onClose} disabled={busy}>
            Cancel
          </CBtn>
          <CBtn tone="accent" onClick={() => void make()} disabled={busy || startsFrom === null || !!start?.gone}>
            {busy ? NEW_COPY_OPENING : NEW_COPY_OPEN}
          </CBtn>
        </>
      }
    >
      <label ref={nameWrap} className="copy-sheet-field">
        <span className="copy-sheet-label">Name</span>
        <TextField
          value={name}
          onChange={setName}
          onEnter={() => void make()}
          placeholder="what you're trying"
          label="Name"
          disabled={busy}
          wide
        />
      </label>
      <SheetField label="Starts from">
        <span className="copy-sheet-value" aria-live="polite">
          {start === null ? "Reading where it starts…" : startsFrom ? machineWords(startsFrom) : "This project has no branch to start a copy from yet."}
        </span>
      </SheetField>
      {/* E2 (P20, CP-2): what stays out, before the press. */}
      {notInCopy && (
        <SheetField label={NOT_IN_COPY_LABEL}>
          <span className="copy-sheet-value">{machineWords(notInCopy)}</span>
        </SheetField>
      )}
      <SheetField label="Open">
        <Segmented<NewCopyProvider> label="Open" value={open} onChange={setOpen} options={newCopyChoices(env, broken)} />
      </SheetField>
      {/* E2 (P19, D12 a): the trust question, announced. */}
      {trustHint && !busy && <SheetHint>{trustHint}</SheetHint>}
      {busy && <SheetHint role="status">{machineWords(newCopyOpeningHint(Boolean(start?.fromGitHub)))}</SheetHint>}
      {failure && (
        <SheetHint role="alert" failure>
          {machineWords(failure)}
        </SheetHint>
      )}
    </Sheet>
  );
}
