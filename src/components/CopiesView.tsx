// 1.173.0 A3: Terminals › Copies — scene 3 of the mockup (copies.html). Each
// copy without a card says what changed and what is open in it, and offers
// its ends: Make it a card · Open a pull request · Open a terminal · Throw
// away (a plain button; the toast offers Undo). Scene 4 is the pull-request
// sheet, which says nobody reviewed it and offers Make it a card instead.
//
// Drawn over the tile grid, which stays mounted (hidden): no terminal is
// unmounted to show this (PROJECT_RUNTIME_INVARIANTS).
import { useEffect, useRef, useState } from "react";
import {
  copyMakeCard,
  copyOpenPr,
  copyRefreshPrs,
  copyRestore,
  copyThrowAway,
  openWebLink,
  type CopyView,
  type ShellEnvInfo,
} from "../ipc";
import {
  BRING_IT_BACK,
  COPIES_EMPTY,
  COPIES_LEDE,
  COPIES_STATUS,
  MAKE_IT_A_CARD,
  OPEN_A_PULL_REQUEST,
  copyOpenLabel,
  PR_SHEET_OPEN,
  PR_SHEET_OPENING,
  PR_SHEET_REACH_LEAD,
  PR_SHEET_REACH_TAIL,
  SHOW_THE_PULL_REQUEST,
  THROWN_AWAY_TITLE,
  THROW_AWAY,
  copyChangedWords,
  copyPrWords,
  copyStartChip,
  copyTerminalWords,
  madeCardWords,
  plainCopyError,
  prSheetLede,
  prSheetTitle,
  thrownAwayBody,
  throwAwayAsk,
  throwAwayHeldWords,
} from "../lib/copyWords";
import { machineWords } from "../lib/platform";
import { useCopies, useWorkspaceCopies } from "../store/copiesStore";
import { showPlanRefusal } from "../store/planPrompts";
import { pushToast, UNDO_TOAST_MS } from "../store/toastStore";
import { useTiles } from "../store/tileStore";
import { openNewTile } from "../store/tileActions";
import { openCardStep } from "../store/uiStore";
import { CBtn, EmptyState, Group, MoreMenu, PChip, Page, Row, Section, Sheet, TextField, type MenuItem } from "./ux";
import { linkDidNotOpen } from "../lib/linkToast";

function sayFailure(title: string, e: unknown) {
  if (showPlanRefusal(e)) return;
  const said = plainCopyError(e);
  pushToast({ kind: "error", title, body: machineWords(said.body), details: said.details });
}

/** The kinds of the tiles open in a folder, from the tile store. */
function useKindsIn(workspaceId: string, path: string): string[] {
  return useTiles((s) => {
    const tiles = s.byWorkspace[workspaceId]?.tiles ?? [];
    const root = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return tiles
      .filter((t) => {
        const at = t.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
        return root && (at === root || at.startsWith(`${root}/`)) && t.status === "running";
      })
      .map((t) => t.kind)
      .join("\u0000");
  })
    .split("\u0000")
    .filter(Boolean);
}

export function CopiesView({
  workspaceId,
  env,
  onShowTerminals,
}: {
  workspaceId: string;
  env: ShellEnvInfo | null;
  /** Back to the grid, after Open a terminal (the header's crumb and the
   *  Copies toggle are the ways back; 1.174.0 E3). */
  onShowTerminals: () => void;
}) {
  const rows = useWorkspaceCopies(workspaceId);
  const [prFor, setPrFor] = useState<CopyView | null>(null);
  const [askThrow, setAskThrow] = useState<CopyView | null>(null);
  const active = rows.filter((r) => r.state === "active");
  const trashed = rows.filter((r) => r.state !== "active" && r.restorable);

  // Challenger 5: the row a press runs on is held until it answers.
  const [busyId, setBusyId] = useState<string | null>(null);
  async function holding(copy: CopyView, run: () => Promise<void>) {
    if (busyId) return;
    setBusyId(copy.id);
    try {
      await run();
    } finally {
      setBusyId(null);
    }
  }

  // Re-walk: a terminal closed (or opened) in a copy is read again at once,
  // and once more when its process has ended, not at the next poll.
  const runningCwds = useTiles((s) =>
    (s.byWorkspace[workspaceId]?.tiles ?? [])
      .filter((t) => t.status === "running")
      .map((t) => t.cwd)
      .sort()
      .join("\u0000"),
  );
  const firstRead = useRef(true);
  useEffect(() => {
    if (firstRead.current) {
      firstRead.current = false;
      return;
    }
    void useCopies.getState().refresh(workspaceId);
    const again = window.setTimeout(() => void useCopies.getState().refresh(workspaceId), 800);
    return () => window.clearTimeout(again);
  }, [runningCwds, workspaceId]);

  useEffect(() => {
    void useCopies.getState().refresh(workspaceId);
    // Challenger 7: what GitHub says of their pull requests, as it opens
    // (`copies://changed` follows a change).
    void copyRefreshPrs(workspaceId).catch(() => {});
  }, [workspaceId]);

  async function makeCard(copy: CopyView) {
    try {
      const made = await copyMakeCard(workspaceId, copy.id);
      await useCopies.getState().refresh(workspaceId);
      // A refused start's reason is the engine's: said plainly.
      const note = made.note ? plainCopyError(made.note).body : null;
      const words = madeCardWords(made.card.title, made.started, note);
      pushToast({
        // Windows walk: a card made is a success, whatever column it is in.
        kind: "info",
        title: words.title,
        body: machineWords(words.body),
        action: { label: "Open the card", onClick: () => openCardStep(workspaceId, made.card.id, "run") },
      });
    } catch (e) {
      sayFailure("Card not made", e);
    }
  }

  async function throwAway(copy: CopyView) {
    setAskThrow(null);
    try {
      await copyThrowAway(workspaceId, copy.id);
      await useCopies.getState().refresh(workspaceId);
      pushToast({
        kind: "info",
        title: THROWN_AWAY_TITLE,
        body: thrownAwayBody(copy.name),
        action: {
          label: "Undo",
          // The ToastBar's Undo window (6 s, paused while the window is
          // hidden); Bring it back stays in Copies for the Trash's 7 days.
          ttlMs: UNDO_TOAST_MS,
          onClick: () => void bringBack(copy),
        },
      });
    } catch (e) {
      sayFailure("Copy not thrown away", e);
    }
  }

  async function bringBack(copy: CopyView) {
    try {
      await copyRestore(workspaceId, copy.id);
      await useCopies.getState().refresh(workspaceId);
    } catch (e) {
      sayFailure("Copy not brought back", e);
    }
  }

  // 1.174.1 P4: what Open opens — the AI the copy was made with, when it is
  // installed — and its button says so.
  function openKind(copy: CopyView): "claude" | "codex" | "shell" {
    return copy.open === "claude" && env?.claudePath ? "claude" : copy.open === "codex" && env?.codexPath ? "codex" : "shell";
  }
  function openTerminal(copy: CopyView) {
    openNewTile(workspaceId, copy.path, openKind(copy), env);
    onShowTerminals();
  }

  return (
    <div className="copies-view">
      <Page>
        {/* 1.174.0 E3 (P24, CP-1, T8): the mode header's "Copies" is the one
            title; no inner title, back link or "Copies N" section head. */}
        {active.length === 0 && trashed.length === 0 ? (
          <EmptyState>{COPIES_EMPTY}</EmptyState>
        ) : (
          <>
            <p className="ux-page-lede copies-lede">{COPIES_LEDE}</p>
            {active.length > 0 && (
              <Group label="Copies">
                {active.map((copy) => (
                  <CopyRow
                    key={copy.id}
                    workspaceId={workspaceId}
                    copy={copy}
                    busy={busyId === copy.id}
                    onMakeCard={() => void holding(copy, () => makeCard(copy))}
                    onOpenPr={() => setPrFor(copy)}
                    onOpenTerminal={() => openTerminal(copy)}
                    openLabel={copyOpenLabel(openKind(copy))}
                    onThrowAway={() =>
                      throwAwayAsk(copy.saved) ? setAskThrow(copy) : void holding(copy, () => throwAway(copy))
                    }
                  />
                ))}
              </Group>
            )}
            {trashed.length > 0 && (
              <Section title="In the Trash" count={trashed.length} countInline>
                <Group label="In the Trash">
                  {trashed.map((copy) => (
                    <Row
                      key={copy.id}
                      kind="item"
                      label={copy.name}
                      hint="Thrown away · stays 7 days in the Trash"
                      action={
                        <CBtn disabled={busyId === copy.id} onClick={() => void holding(copy, () => bringBack(copy))}>
                          {BRING_IT_BACK}
                        </CBtn>
                      }
                    />
                  ))}
                </Group>
              </Section>
            )}
            <p className="ux-footnote">{COPIES_STATUS}</p>
          </>
        )}
      </Page>
      {prFor && (
        <CopyPrSheet
          workspaceId={workspaceId}
          copy={prFor}
          onClose={() => setPrFor(null)}
          onMakeCard={() => {
            const copy = prFor;
            setPrFor(null);
            void holding(copy, () => makeCard(copy));
          }}
        />
      )}
      {askThrow && (
        <ThrowAwaySheet
          copy={askThrow}
          onCancel={() => setAskThrow(null)}
          onConfirm={() => {
            const copy = askThrow;
            void holding(copy, () => throwAway(copy));
          }}
        />
      )}
    </div>
  );
}

function CopyRow({
  workspaceId,
  copy,
  busy,
  onMakeCard,
  onOpenPr,
  onOpenTerminal,
  openLabel,
  onThrowAway,
}: {
  workspaceId: string;
  copy: CopyView;
  /** A press on this row is running: its buttons wait. */
  busy: boolean;
  onMakeCard: () => void;
  onOpenPr: () => void;
  onOpenTerminal: () => void;
  /** The open press's words (`copyOpenLabel`). */
  openLabel: string;
  onThrowAway: () => void;
}) {
  const kinds = useKindsIn(workspaceId, copy.path);
  const changed = copy.changed.count > 0;
  // Challenger 9: a closed pull request leaves the copy's ends as they were
  // (another pull request may be opened); open or merged, it is shown.
  const prShown = copy.pr && copy.pr.url && copy.pr.state !== "closed";
  const setup =
    copy.setup?.state === "running" ? "Setting up…" : copy.setup?.state === "failed" ? "Setup failed — Retry from its terminal" : null;
  const hint = [
    // Re-walk: this window's tiles are the truth for what is open (the
    // backend's count catches up on the next read).
    copyTerminalWords(kinds, kinds.length),
    setup,
    prShown ? copyPrWords(copy.pr!) : copyChangedWords(copy.changed),
    copy.pr && !prShown ? copyPrWords(copy.pr) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The row's one button follows what it can do now (scene 3); the rest is
  // in its ⋯ (1.174.0 E3, tidy tables: every Copies button one width, one
  // right edge). Walk fix (d): with a terminal open in the copy, Throw away
  // is shown off with the reason as its hint, never refused after the press.
  const held = throwAwayHeldWords(kinds.length);
  const throwAwayItem: MenuItem = { label: THROW_AWAY, onSelect: onThrowAway, disabled: Boolean(held), hint: held ?? undefined };
  let primary: { label: string; onClick: () => void; strong?: boolean };
  const more: MenuItem[] = [];
  if (prShown) {
    primary = { label: SHOW_THE_PULL_REQUEST, onClick: () => void openWebLink(copy.pr!.url).catch((e: unknown) => pushToast(linkDidNotOpen(copy.pr!.url, e))) };
    more.push({ label: openLabel, onSelect: onOpenTerminal }, throwAwayItem);
  } else if (changed) {
    primary = { label: MAKE_IT_A_CARD, onClick: onMakeCard, strong: true };
    more.push(
      { label: OPEN_A_PULL_REQUEST, onSelect: onOpenPr },
      { label: openLabel, onSelect: onOpenTerminal },
      throwAwayItem,
    );
  } else {
    primary = { label: openLabel, onClick: onOpenTerminal };
    more.push(throwAwayItem, { label: MAKE_IT_A_CARD, onSelect: onMakeCard });
  }
  return (
    <Row
      kind="item"
      label={<b>{copy.name}</b>}
      chips={<PChip>{copyStartChip(copy, Date.now())}</PChip>}
      hint={machineWords(hint)}
      action={
        <CBtn tone={primary.strong ? "strong" : "ghost"} onClick={primary.onClick} disabled={busy}>
          {primary.label}
        </CBtn>
      }
      more={
        <MoreMenu
          label={`More for ${copy.name}`}
          items={more.map((m) => (typeof m === "object" && "onSelect" in m ? { ...m, disabled: busy || m.disabled } : m))}
        />
      }
    />
  );
}

/** Scene 4: the same pull request Ship opens, without the card's review —
 *  and it says so. Focus starts on Cancel. */
export function CopyPrSheet({
  workspaceId,
  copy,
  onClose,
  onMakeCard,
}: {
  workspaceId: string;
  copy: CopyView;
  onClose: () => void;
  onMakeCard: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [title, setTitle] = useState(copy.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function open() {
    if (busy || !title.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      const entry = await copyOpenPr(workspaceId, copy.id, title.trim());
      await useCopies.getState().refresh(workspaceId);
      const url = entry.pr?.url;
      pushToast({
        kind: "info",
        title: "Pull request opened",
        body: entry.pr?.number ? `#${entry.pr.number} for ${copy.baseBranch || "main"}. Nobody has reviewed it here.` : "Nobody has reviewed it here.",
        ...(url ? { action: { label: SHOW_THE_PULL_REQUEST, onClick: () => void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e))) } } : {}),
      });
      onClose();
    } catch (e) {
      const said = plainCopyError(e);
      setFailure(said.body);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={prSheetTitle(copy.name)}
      lede={prSheetLede(copy.changed.count, copy.baseBranch)}
      size="confirm"
      onClose={onClose}
      canDismiss={!busy}
      initialFocusRef={cancel}
      leadAction={
        <CBtn tone="quiet" onClick={onMakeCard} disabled={busy}>
          {MAKE_IT_A_CARD}
        </CBtn>
      }
      actions={
        <>
          <CBtn ref={cancel} tone="strong" onClick={onClose} disabled={busy}>
            Cancel
          </CBtn>
          <CBtn tone="accent" onClick={() => void open()} disabled={busy || !title.trim()}>
            {busy ? PR_SHEET_OPENING : PR_SHEET_OPEN}
          </CBtn>
        </>
      }
    >
      <label className="copy-sheet-field">
        <span className="copy-sheet-label">Title</span>
        <TextField value={title} onChange={setTitle} label="Title" disabled={busy} wide />
      </label>
      <p className="copy-sheet-hint">
        {PR_SHEET_REACH_LEAD} <b>{MAKE_IT_A_CARD}</b> {PR_SHEET_REACH_TAIL}
      </p>
      {failure && (
        <p className="copy-sheet-hint copy-sheet-failure" role="alert">
          {machineWords(failure)}
        </p>
      )}
    </Sheet>
  );
}

/** Throw away, asked only when the copy holds saved changes nowhere else. */
function ThrowAwaySheet({ copy, onCancel, onConfirm }: { copy: CopyView; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const ask = throwAwayAsk(copy.saved)!;
  return (
    <Sheet
      title={ask.title}
      lede={ask.body}
      size="confirm"
      onClose={onCancel}
      initialFocusRef={cancel}
      actions={
        <>
          <CBtn ref={cancel} onClick={onCancel}>
            Cancel
          </CBtn>
          <CBtn tone="strong" onClick={onConfirm}>
            {THROW_AWAY}
          </CBtn>
        </>
      }
    />
  );
}
