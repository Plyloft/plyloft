// 1.174.0 (A4, P2 BCI-1 AR-2 VC-2 VC-3): one slot for the notes above the
// Board (mockups/board.html §1–3, §8). Something broken, a setup to decide,
// the project folder and the areas Plyloft found each say what they are
// (`use…Notice`); only the first present is shown whole, the others are one
// line — "2 more notes: … · Show" — and Show opens them in the slot's order,
// with Show fewer under them. Answering the first raises the next. Which
// notes are open is never remembered: the slot starts short again.
//
// Next improvement is a note too, always last: alone it is its own section
// (its slate folds by itself, nextImprovementStore); behind another note it
// is only a name in the line, kept mounted (it reads its round) and drawn
// once Show opens the slot.
//
// No note draws a filled button: the Board's one is New card.
import { useEffect, useRef, useState } from "react";
import { CBtn, Callout } from "./ux";
import { useAdoptionNotice } from "./AdoptionBanner";
import { AreasChoiceSheet, useAreaNotice } from "./AreaNotice";
import { useLocalBranchNotice } from "./errors/LocalBranchState";
import { NextImprovementSection, useNextImprovementShown } from "./NextImprovementSection";
import {
  NEXT_IMPROVEMENT_SUMMARY,
  PROJECT_FOLDER_GONE_BODY,
  PROJECT_FOLDER_GONE_SUMMARY,
  PROJECT_FOLDER_GONE_TITLE,
  NOTES_REGION,
  SHOW_FEWER_NOTES,
  SHOW_MORE_NOTES,
  moreNotesLine,
  orderNotices,
  type BoardNoticeEntry,
  type BoardNoteView,
} from "../lib/boardNotices";
import { machineWords } from "../lib/platform";
import { useNextImprovement } from "../store/nextImprovementStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { CLONE_AGAIN, CLONE_AGAIN_LOSES_COPIES, folderGone } from "../lib/teamStep";
import { teamStatus } from "../ipc";
import { workspaceCwdExists } from "../lib/openPrLinks";
import { NI_TOUR } from "../lib/nextImprovement";

/** U31: the Board kept looking normal with its project's folder gone. The way
 *  back, the Team page's Clone it again, shows only for a project in the team's
 *  list. `cwdMissing` is read by a workspace refresh, so a return to the window
 *  reads it again. */
function useProjectFolderGoneNotice(workspaceId: string, solo: boolean): BoardNoteView | null {
  const missing = useWorkspaces((s) => s.cwdMissing[workspaceId] === true);
  const cwd = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.cwd ?? null);
  const [teamRow, setTeamRow] = useState(false);
  useEffect(() => {
    const onFocus = () => {
      void workspaceCwdExists(workspaceId)
        .then((there) => {
          const was = useWorkspaces.getState().cwdMissing[workspaceId] === true;
          if (typeof there === "boolean" && there === was) {
            useWorkspaces.setState((s) => ({ cwdMissing: { ...s.cwdMissing, [workspaceId]: !there } }));
          }
        })
        .catch(() => {});
    };
    // The same two events the Board's refresh and a Project page's read return
    // on (`useProjectPageReads`): the window's focus, and shown again from hidden.
    const onVisible = () => {
      if (document.visibilityState !== "hidden") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId]);
  useEffect(() => {
    setTeamRow(false);
    if (!missing || solo || !cwd) return;
    let live = true;
    void teamStatus()
      .then((status) => {
        if (live) setTeamRow(status?.workspaces?.some((w) => folderGone(w) && w.localPath === cwd) === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [missing, solo, cwd]);
  if (!missing) return null;
  return {
    id: "project-folder-gone",
    kind: "broken",
    summary: PROJECT_FOLDER_GONE_SUMMARY,
    body: (
      <div data-ply-project-folder-gone="">
        <Callout
          kind="info"
          iconTone="warn"
          title={PROJECT_FOLDER_GONE_TITLE}
          text={teamRow ? `${PROJECT_FOLDER_GONE_BODY} ${CLONE_AGAIN_LOSES_COPIES}` : PROJECT_FOLDER_GONE_BODY}
          actions={
            teamRow ? (
              <CBtn onClick={() => useUi.getState().openSettingsSection("team-workspaces")}>{CLONE_AGAIN}</CBtn>
            ) : undefined
          }
        />
      </div>
    ),
  };
}

export function BoardNotices({
  workspaceId,
  solo = false,
  ghBacked,
}: {
  workspaceId: string;
  /** OB-9: solo mode (the adoption banner asks nothing about sharing). */
  solo?: boolean;
  /** The project folder's note belongs to a GitHub-backed Board, beside its
   *  Sync (E3 round 2). */
  ghBacked: boolean;
}) {
  // Every note's hook runs whatever is shown: the adoption banner's
  // automatic steps, the area discovery's read and the folder's state go on.
  const adoption = useAdoptionNotice(workspaceId, solo);
  const areas = useAreaNotice(workspaceId);
  const folder = useLocalBranchNotice(workspaceId);
  const ni = useNextImprovementShown(workspaceId);
  const gone = useProjectFolderGoneNotice(workspaceId, solo);
  const notes = orderNotices<BoardNoteView>([gone, adoption, areas, ghBacked ? folder : null]);
  const niEntry: BoardNoticeEntry | null = ni
    ? { id: "next-improvement", kind: "next-improvement", summary: NEXT_IMPROVEMENT_SUMMARY }
    : null;
  const rest: BoardNoticeEntry[] = [...notes.slice(1), ...(niEntry ? [niEntry] : [])];

  // Open for this workspace only: another project starts short.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === workspaceId && rest.length > 0;
  const showRef = useRef<HTMLButtonElement>(null);
  const fewerRef = useRef<HTMLButtonElement>(null);
  const [focusTo, setFocusTo] = useState<"show" | "fewer" | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    (focusTo === "fewer" ? fewerRef : showRef).current?.focus();
    setFocusTo(null);
  }, [focusTo, open]);

  // Round 1: no more notes, nothing open (a later one starts short).
  useEffect(() => {
    if (rest.length === 0 && openFor !== null) setOpenFor(null);
  }, [rest.length, openFor]);

  // Round 1: ⋯ › Show Next improvement and the Inbox's Look at the ideas
  // open the slot, so the section shows behind another note too.
  const openSlot = useNextImprovement((s) => (s.openSlot?.workspaceId === workspaceId ? s.openSlot.at : null));
  useEffect(() => {
    if (openSlot === null) return;
    setOpenFor(workspaceId);
    useNextImprovement.setState({ openSlot: null });
  }, [openSlot, workspaceId]);

  // Round 1: a note answered while focus was in the slot hands focus to
  // the note that took its place (its first button), else to the slot.
  const sectionRef = useRef<HTMLElement>(null);
  const focusInSlot = useRef(false);
  const firstId = notes[0]?.id ?? null;
  const lastFirst = useRef(firstId);
  useEffect(() => {
    const was = lastFirst.current;
    lastFirst.current = firstId;
    if (was === null || was === firstId || !focusInSlot.current) return;
    const el = sectionRef.current;
    const active = document.activeElement;
    if (!el || (active && active !== document.body && !el.contains(active))) return;
    const next = el.querySelector<HTMLElement>("[data-ply-note] button:not(:disabled)") ?? el;
    next.focus();
  }, [firstId]);

  const line = moreNotesLine(rest);
  return (
    <>
      {notes.length > 0 && (
        <section
          ref={sectionRef}
          className="ux-notes"
          aria-label={NOTES_REGION}
          data-ply-board-notes=""
          tabIndex={-1}
          onFocus={() => {
            focusInSlot.current = true;
          }}
          onBlur={(e) => {
            // Focus leaving for somewhere else; a button taken away (no
            // next target) keeps it "in the slot".
            if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusInSlot.current = false;
          }}
        >
          {(open ? notes : notes.slice(0, 1)).map((n) => (
            <div key={n.id} className="ux-notes-item" data-ply-note={n.id}>
              {n.body}
            </div>
          ))}
          {line && !open && (
            // Behind another note, Next improvement's tour step points at
            // the line that names it (talk.next-improvement).
            <div className="ux-notes-more" data-ply-tour={niEntry ? NI_TOUR : undefined}>
              <span className="ux-notes-more-text">{machineWords(line)}</span>
              <CBtn
                ref={showRef}
                size="sm"
                aria-expanded={false}
                onClick={() => {
                  setOpenFor(workspaceId);
                  setFocusTo("fewer");
                }}
              >
                {SHOW_MORE_NOTES}
              </CBtn>
            </div>
          )}
          {open && (
            <div className="ux-notes-more">
              <span className="ux-notes-more-text" />
              <CBtn
                ref={fewerRef}
                size="sm"
                aria-expanded
                onClick={() => {
                  setOpenFor(null);
                  setFocusTo("show");
                }}
              >
                {SHOW_FEWER_NOTES}
              </CBtn>
            </div>
          )}
        </section>
      )}
      {/* 1.173.0 (E3) → A4: Next improvement's ideas for the current area,
          under the other notes; never covers the Board. */}
      <NextImprovementSection workspaceId={workspaceId} folded={notes.length > 0 && !open} />
      {/* 1.174.0 (C10, D6): this Mac's areas set aside when the setup came
          in with others — one sheet, its focus on "Use the repository's". */}
      <AreasChoiceSheet workspaceId={workspaceId} />
    </>
  );
}
