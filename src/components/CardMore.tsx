import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openDialog as openFileDialog } from "../lib/nativeDialog";
import {
  CARD_FILES_DROP_KINDS,
  CARD_PAGE_DROP_KINDS,
  HINT_IDLE_MS,
  acceptsAttr,
  acceptsDrag,
  asDropTarget,
  dragPayloadFor,
  innerZoneTakesDrop,
} from "../lib/dropGuard";
import { DropTooLargeError, readDroppedFile, toastDropRefusals, type DropRefusal } from "../lib/droppedFile";
import { rawError } from "../lib/cardPage";
import { EMPTY_ARRAY } from "../lib/empties";
import type { CardAttachment, KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { pushToast } from "../store/toastStore";
import { confirmSheet } from "../store/confirmStore";
import { CBtn, Icon, StateWord } from "./ux";
import { basename } from "../lib/paths";
import { platformWord } from "../lib/platform";
import { reviewOnly } from "../lib/prReview";

/**
 * GH #255: "More about this card" — the files sent with the card. G4 (launch
 * D8): the agent and swarm template pickers are gone with the swarm UI.
 * 1.172.0 (C1, CP-13): the plan and the longer notes moved up into the
 * card's Brief block (`CardBrief.tsx`), as "The plan (what the Builder
 * follows)" and "More detail (optional)" — the same fields.
 */
export function CardMore({ card, files }: { card: KanbanCard; files: CardFileIngest }) {
  return (
    <div className="ux-card-more">
      <CardFiles card={card} files={files} />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function isImageMime(mime: string | null | undefined): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

// Mirror of the server-side cap in `kanban_attachment_add_from_bytes`. Kept in
// sync so a 50 MB drop is rejected before we burn time reading it into memory.
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

type PendingIngest = {
  key: string;
  /** The card the file is going to: the card page is one mount for every
   *  card it shows, so a row shows only on its own card. */
  cardId: string;
  name: string;
  sizeBytes: number;
};

/** 1.172.2 D5: the card's dropped files, read whole and added — one ingest
 *  for the card's Files area and for a drop anywhere on the card page, so
 *  both show the same "Attaching…" rows and say a refusal the same way. */
export type CardFileIngest = {
  pending: readonly PendingIngest[];
  ingest: (files: File[]) => Promise<void>;
};

export function useCardFileIngest(card: Pick<KanbanCard, "id">): CardFileIngest {
  const addFromBytes = useKanban((s) => s.addAttachmentFromBytes);
  const [pending, setPending] = useState<PendingIngest[]>([]);
  const cardId = card.id;

  async function ingest(files: File[]) {
    // Pre-flight on File.size — the server enforces the same cap, but reading
    // a 50 MB arrayBuffer just to be told no is bad UX.
    // 1.172.2 D2: every file of the drop that isn't added is said in one
    // toast, in the same words as every other drop place.
    const refused: DropRefusal[] = [];
    const accepted: File[] = [];
    for (const f of files) {
      if (f.size > ATTACHMENT_MAX_BYTES) {
        refused.push({ name: f.name, error: new DropTooLargeError(f.name, f.size, ATTACHMENT_MAX_BYTES) });
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length === 0) {
      toastDropRefusals(refused, "card");
      return;
    }

    const stamps = accepted.map((f) => ({
      key: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
      cardId,
      name: f.name,
      sizeBytes: f.size,
    }));
    setPending((prev) => [...prev, ...stamps]);

    let added = 0;
    try {
      for (let i = 0; i < accepted.length; i++) {
        const f = accepted[i];
        const stamp = stamps[i];
        try {
          // GH #230: read whole, or refused as incomplete — never a prefix.
          await addFromBytes(cardId, f.name, await readDroppedFile(f));
          added++;
        } catch (e) {
          refused.push({ name: f.name, error: e });
        } finally {
          setPending((prev) => prev.filter((p) => p.key !== stamp.key));
        }
      }
      toastDropRefusals(refused, "card", added);
    } catch {
      // Defensive: if the loop itself blows up, drop all stamps so the UI
      // doesn't get stuck showing ghost rows forever.
      const keys = new Set(stamps.map((s) => s.key));
      setPending((prev) => prev.filter((p) => !keys.has(p.key)));
    }
  }

  return { pending, ingest };
}

/** 1.172.2 D5: what the card page says while a file is dragged over it. */
export const CARD_PAGE_DROP_LABEL = "Drop to add to this card";
/** How long a `dragleave` waits before the label goes: the next
 *  `dragenter`/`dragover` over the page cancels it. */
export const CARD_PAGE_LEAVE_MS = 50;

/** 1.172.2 D5: the whole card page takes a dropped file into the card's
 *  Files — before, only the Files area did, and it sits inside the card's
 *  closed Details. Files only, never text or a card; a zone inside the page
 *  that takes the drag itself (the card chat, a terminal, the Files area)
 *  keeps it. `onFiles` gets the files of a drop that is the page's. */
export function useCardPageDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const idle = useRef<number>(0);
  const leaving = useRef<number>(0);
  useEffect(
    () => () => {
      window.clearTimeout(idle.current);
      window.clearTimeout(leaving.current);
    },
    [],
  );

  function ours(e: ReactDragEvent<HTMLElement>): boolean {
    return (
      acceptsDrag(e, CARD_PAGE_DROP_KINDS) &&
      !innerZoneTakesDrop(asDropTarget(e.target), e.currentTarget, dragPayloadFor(e))
    );
  }
  function leave() {
    window.clearTimeout(idle.current);
    window.clearTimeout(leaving.current);
    setOver(false);
  }
  function onDragOver(e: ReactDragEvent<HTMLElement>) {
    if (!ours(e)) {
      if (over) leave();
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    // Still here: a leave a moment ago was only a crossing into a child.
    window.clearTimeout(leaving.current);
    if (!over) setOver(true);
    // A drag repeats `dragover` while it is here; silence means it went
    // (released elsewhere, or carried out of the window).
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setOver(false), HINT_IDLE_MS);
  }
  function onDragLeave(e: ReactDragEvent<HTMLElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    // Challenger round 1: WKWebView can give no `relatedTarget` when the
    // drag crosses into a child, so the clear waits a moment and the next
    // dragenter/dragover over the page cancels it — no flicker. A drag that
    // really left (or Esc) sends none, and the label goes.
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setOver(false), CARD_PAGE_LEAVE_MS);
  }
  function onDrop(e: ReactDragEvent<HTMLElement>) {
    leave();
    if (!ours(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  }

  return {
    over,
    zoneProps: {
      "data-drop-zone": "card-page",
      "data-drop-accepts": acceptsAttr(CARD_PAGE_DROP_KINDS),
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave,
      onDrop,
    },
  };
}

/** The quiet outline and centred label over the card page while a file is
 *  dragged over it. */
export function CardPageDropLabel() {
  return (
    <div className="ux-card-page-drop" data-ply-card-page-drop="" aria-hidden="true">
      <span className="ux-card-page-drop-label">{CARD_PAGE_DROP_LABEL}</span>
    </div>
  );
}

/** Walk 2 of #386: who gets the card's files. A pull request card has no
 *  planning conversation; someone else's has no Builder either — its Chat
 *  reads them. */
export function filesHint(card: Pick<KanbanCard, "prReview">): string {
  if (card.prReview) {
    return reviewOnly(card)
      ? "Drop files here. Ask about this card gets them, up to 5 MB each."
      : "Drop files here. Ask about this card and the Builder get them, up to 5 MB each.";
  }
  return "Drop files here. The planning conversation and the Builder get them, up to 5 MB each.";
}

/** The files sent with the card: dropped here or picked; each opens,
 *  shows in Finder or goes. */
function CardFiles({ card, files }: { card: KanbanCard; files: CardFileIngest }) {
  const addFromPath = useKanban((s) => s.addAttachmentFromPath);
  const removeAttachment = useKanban((s) => s.removeAttachment);
  const revealAttachment = useKanban((s) => s.revealAttachment);
  const openAttachment = useKanban((s) => s.openAttachment);

  const [dragOver, setDragOver] = useState(false);
  const [pickedIngest, setPickedIngest] = useState<PendingIngest[]>([]);
  // Dropped files (here or anywhere on the card page) and picked ones.
  const pendingIngest = [...files.pending, ...pickedIngest].filter((p) => p.cardId === card.id);

  const attachments = card.attachments ?? EMPTY_ARRAY;

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    // GH #138: the same question this area's `data-drop-accepts` marker asks.
    if (!acceptsDrag(e, CARD_FILES_DROP_KINDS)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;
    await files.ingest(Array.from(dt.files));
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    // GH #138: text or a URL dragged here attaches nothing, so it must not
    // be offered the copy cursor or the highlight.
    if (!acceptsDrag(e, CARD_FILES_DROP_KINDS)) return;
    if (e.dataTransfer) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragOver) setDragOver(true);
    }
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    // Only clear when the cursor truly leaves the drop target — React
    // re-fires dragleave for child crossings.
    if (e.currentTarget === e.target) setDragOver(false);
  }

  async function onPickFiles() {
    let result: string | string[] | null = null;
    try {
      result = await openFileDialog({ multiple: true });
    } catch (e) {
      pushToast({
        kind: "error",
        title: "The file picker didn't open",
        body: "Nothing was attached. Drop the files on the card instead.",
        copyText: rawError(e),
      });
      return;
    }
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    const stamps = paths.map((p) => ({
      key: `${p}-${Date.now()}-${Math.random()}`,
      cardId: card.id,
      name: basename(p),
      sizeBytes: 0,
    }));
    setPickedIngest((prev) => [...prev, ...stamps]);

    try {
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        const stamp = stamps[i];
        try {
          await addFromPath(card.id, p);
        } catch (e) {
          pushToast({
            kind: "error",
            title: `${basename(p)} wasn't attached`,
            body: "The card's other files are as they were. Details says why.",
            copyText: `${p}: ${rawError(e)}`,
          });
        } finally {
          setPickedIngest((prev) => prev.filter((s) => s.key !== stamp.key));
        }
      }
    } catch {
      const keys = new Set(stamps.map((s) => s.key));
      setPickedIngest((prev) => prev.filter((s) => !keys.has(s.key)));
    }
  }

  async function onRemove(att: CardAttachment) {
    const ok = await confirmSheet({
      title: `Remove ${att.displayName}?`,
      body: "It goes from this card and its copy is deleted. The file you attached from stays where it was.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeAttachment(card.id, att.id);
    } catch (e) {
      pushToast({
        kind: "error",
        title: `${att.displayName} wasn't removed`,
        body: "It is still attached. Try again; Details says why.",
        copyText: rawError(e),
      });
    }
  }

  const isEmpty = attachments.length === 0 && pendingIngest.length === 0;

  return (
    <section className="ux-card-files" aria-label="Files">
      <div className="ux-card-files-head">
        <span className="ux-card-field-label">Files</span>
        <CBtn
          tone="quiet"
          onClick={() => void onPickFiles()}
          title="Pick files to send with this card, up to 5 MB each."
        >
          <Icon name="add" size="sm" />
          Attach
        </CBtn>
      </div>
      <div
        className={dragOver ? "ux-card-files-drop ux-card-files-drop--over" : "ux-card-files-drop"}
        // GH #138: `onDrop` above ingests `dataTransfer.files` and nothing
        // else. One list, shared with those handlers.
        data-drop-zone="card-files"
        data-drop-accepts={acceptsAttr(CARD_FILES_DROP_KINDS)}
        aria-busy={pendingIngest.length > 0 || undefined}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        {isEmpty ? (
          <p className="ux-card-muted">
            {filesHint(card)}
          </p>
        ) : (
          <ul className="ux-card-files-list">
            {attachments.map((att) => (
              <li key={att.id} className="ux-card-file">
                <CBtn
                  tone="quiet"
                  className="ux-card-file-thumb"
                  onClick={() => void openAttachment(att.storedPath)}
                  title={`Open ${att.displayName}`}
                  aria-label={`Open ${att.displayName}`}
                >
                  {isImageMime(att.mimeType) ? (
                    <img className="ux-card-file-image" src={convertFileSrc(att.storedPath)} alt="" />
                  ) : (
                    <Icon name="file" />
                  )}
                </CBtn>
                <span className="ux-card-file-name" title={att.displayName}>
                  {att.displayName}
                </span>
                <span className="ux-card-file-size">{formatBytes(att.sizeBytes)}</span>
                <CBtn
                  tone="quiet"
                  onClick={() => void revealAttachment(att.storedPath)}
                  title={platformWord("showIn")}
                  aria-label={`Show ${att.displayName} in ${platformWord("fileManager")}`}
                >
                  <Icon name="reveal" size="sm" />
                </CBtn>
                <CBtn
                  tone="quiet"
                  onClick={() => void onRemove(att)}
                  title="Remove from this card"
                  aria-label={`Remove ${att.displayName}`}
                >
                  <Icon name="delete" size="sm" />
                </CBtn>
              </li>
            ))}
            {pendingIngest.map((p) => (
              <li key={p.key} className="ux-card-file" aria-busy="true">
                <span className="ux-card-file-name" title={p.name}>
                  <StateWord state="running" live>
                    {p.name}
                  </StateWord>
                </span>
                <span className="ux-card-file-size">
                  {p.sizeBytes > 0 ? `${formatBytes(p.sizeBytes)} · ` : ""}
                  Attaching…
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
