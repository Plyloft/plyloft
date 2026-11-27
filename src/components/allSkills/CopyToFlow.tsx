import { useEffect, useMemo, useRef, useState } from "react";
import { CBtn, CheckList, CheckRow, Page, StatusLine } from "../ux";
import {
  skillsHubCopyReview,
  skillsHubCopyTargets,
  skillsHubCopyTo,
  type CopyFrom,
  type CopyMade,
  type CopyTargets,
} from "../../ipc";
import { copySentence, namesWords, sortTargets, targetNote, workspaceHints } from "../../lib/allSkills";
import { useWorkspaces } from "../../store/workspaceStore";
import { LatestRequest } from "../../lib/latestRequest";
import { machineWords } from "../../lib/platform";
import { COPY_TO_LABEL } from "../../lib/librarySkills";
import { isScriptsWait, skillCardReach } from "../../lib/skillCards";
import { useKanban } from "../../store/kanbanStore";
import { pushToast } from "../../store/toastStore";
import { openCardStep, useUi } from "../../store/uiStore";
import { refreshAllSkillsFor } from "../../store/allSkillsStore";
import { ScriptApprovalFlow } from "../library/ScriptApprovalFlow";

/**
 * Skills hub H8 (`docs/plans/SKILLS_HUB.md` R5; mockup `skill-used-in.html`
 * 2b): **Copy to…** — the destination picker over All skills.
 *
 * Every other workspace on this Mac, warm or cold, with what a copy there
 * would do (the backend's judge: ready, the same content to link, a
 * different copy to replace, or refused with the reason). Each workspace
 * picked gets its own skill card; a cold one is written in its board file
 * and never opened (the toast offers to open it). The sentence under the
 * list says who gets what, for which CLIs, and when (R18.4). A copy that
 * brings a script or a file that is not text shows H6b's sheet first.
 */
export function CopyToFlow({ from, onClose }: { from: CopyFrom; onClose: () => void }) {
  const [facts, setFacts] = useState<CopyTargets | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);

  const fromKey = JSON.stringify(from);
  useEffect(() => {
    const latest = new LatestRequest();
    const ticket = latest.begin();
    setFacts(undefined);
    setPicked([]);
    skillsHubCopyTargets(from)
      .then((answer) => {
        if (latest.isCurrent(ticket)) setFacts(answer);
      })
      .catch((cause) => {
        if (!latest.isCurrent(ticket)) return;
        setFacts(null);
        // The backend's refusals are sentences (the origin can't be read,
        // nothing committed to copy).
        const message = String((cause as Error)?.message ?? cause);
        setError(message);
      });
    return () => latest.retireAll();
    // `from` is read through its key: a new object for the same skill is the same flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromKey]);

  // In the order they were picked (Mac walk: the sentence, the cards and
  // the toast followed the list's order).
  const chosen = useMemo(
    () =>
      picked
        .map((id) => (facts?.targets ?? []).find((t) => t.workspaceId === id))
        .filter((t): t is NonNullable<typeof t> => t != null && t.target.kind !== "refused"),
    [facts, picked],
  );
  // H8 (Windows walk): two workspaces of one name (and repository) are told
  // apart by the end of their path, as in All skills' Workspaces picker.
  const workspaces = useWorkspaces((s) => s.workspaces);
  const hints = useMemo(
    () =>
      workspaceHints(
        (facts?.targets ?? []).map((t) => ({
          id: t.workspaceId,
          name: t.name,
          cwd: workspaces.find((w) => w.id === t.workspaceId)?.cwd ?? "",
        })),
      ),
    [facts, workspaces],
  );
  // H8 Challenger: a workspace that already has the copy, linked on this
  // Mac only, is linked at once — it gets no card.
  const carded = chosen.filter((t) => t.target.kind !== "linkHere");
  const linkedNow = chosen.filter((t) => t.target.kind === "linkHere");

  // Esc closes the sheet back to the picker, and the picker back to where
  // it was opened — wherever the caret is: the button that opened it went
  // away with the list, so the keyboard is on nothing until Tab (the page's
  // own Esc, back to the mode you were in, must not see it first).
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || busy) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (sheet) setSheet(false);
      else onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, sheet, onClose]);
  // The keyboard starts on the picker (Tab goes through its list).
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sheet) host.current?.focus({ preventScroll: true });
  }, [sheet]);

  async function create(scriptsOk?: string[]) {
    if (!facts || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (!scriptsOk && (await skillsHubCopyReview(from)) != null) {
        setSheet(true);
        return;
      }
      const ids = chosen.map((t) => t.workspaceId);
      const replace = chosen.filter((t) => t.target.kind === "replace").map((t) => t.workspaceId);
      const made = await skillsHubCopyTo(from, ids, replace, scriptsOk);
      if (made.cards.length === 0 && (made.linked ?? []).length === 0) {
        // Nothing made: the reasons stay on the flow, which stays open.
        setError(madeWords(made).body);
        return;
      }
      madeToast(made);
      refreshAllSkillsFor([
        ...made.cards.map((c) => c.workspaceId),
        ...(made.linked ?? []).map((l) => l.workspaceId),
      ]);
      onClose();
    } catch (cause) {
      const message = String((cause as Error)?.message ?? cause);
      if (isScriptsWait(message)) setSheet(true);
      else setError(message);
      if (scriptsOk) throw cause;
    } finally {
      setBusy(false);
    }
  }

  if (sheet && facts) {
    return (
      <div className="ux-hub-host">
        <Page wide>
          <ScriptApprovalFlow
            plugin={from.kind === "team" ? from.plugin : ""}
            skill={facts.skill}
            install={{
              workspaceId: "",
              verb: "copy",
              copyFrom: from,
              into: carded.map((t) => t.name),
              onConfirm: async (ids) => {
                await create(ids);
              },
            }}
            onDone={() => setSheet(false)}
            onCancel={() => setSheet(false)}
          />
        </Page>
      </div>
    );
  }

  const skill = facts?.skill ?? ("skill" in from ? from.skill : "");
  return (
    <div className="ux-hub-host" ref={host} tabIndex={-1}>
      <Page wide>
        <div className="ux-flow" aria-label={`Copy ${skill} to`}>
          <p className="ux-flow-eyebrow">{COPY_TO_LABEL}</p>
          <h2 className="ux-flow-title">
            Copy <span className="ux-mono-fg">{skill}</span> to…
          </h2>
          <p className="ux-page-lede">
            {facts
              ? `From ${facts.fromWords}. Each workspace gets a linked copy through its own card, so you see the change before it ships.`
              : "Each workspace gets a linked copy through its own card, so you see the change before it ships."}
          </p>
          {facts === undefined && <StatusLine state="running">Reading the workspaces on this computer…</StatusLine>}
          {facts?.uncommittedNote && <StatusLine state="empty">{facts.uncommittedNote}</StatusLine>}
          {facts && facts.targets.length === 0 && (
            <StatusLine state="empty">{machineWords("There is no other workspace on this Mac to copy it to.")}</StatusLine>
          )}
          {facts && facts.targets.length > 0 && (
            <CheckList label="Workspaces">
              {sortTargets(facts.targets).map((t) => (
                <CheckRow
                  key={t.workspaceId}
                  checked={picked.includes(t.workspaceId)}
                  disabled={t.target.kind === "refused" || busy}
                  onChange={(on) =>
                    setPicked((now) => (on ? [...now, t.workspaceId] : now.filter((id) => id !== t.workspaceId)))
                  }
                  note={targetNote(t.target, facts.skill, facts.fromWords)}
                >
                  {[t.name, t.repo, hints.get(t.workspaceId)].filter(Boolean).join(" · ")}
                </CheckRow>
              ))}
            </CheckList>
          )}
          {facts && (
            <StatusLine state="empty">
              <strong>What reaches where.</strong>{" "}
              {carded.length > 0 || linkedNow.length === 0
                ? copySentence(
                    facts,
                    carded.map((t) => ({ name: t.name, repo: t.repo })),
                  )
                : ""}
              {linkedNow.length > 0
                ? `${carded.length > 0 ? " " : ""}${namesWords(linkedNow.map((t) => t.name))} ${linkedNow.length > 1 ? "are" : "is"} linked at once: ${linkedNow.length > 1 ? "they have" : "it has"} this version already.`
                : ""}
              {facts.localReason ? ` ${facts.localReason}` : ""}
            </StatusLine>
          )}
          {error && <StatusLine state="aborted">{error}</StatusLine>}
          <div className="ux-flow-actions">
            <CBtn tone="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </CBtn>
            <CBtn tone="accent" onClick={() => void create()} disabled={busy || chosen.length === 0}>
              {busy ? "Making the cards…" : carded.length === 0 && linkedNow.length > 0 ? "Link it" : createLabel(carded.length)}
            </CBtn>
          </div>
        </div>
      </Page>
    </div>
  );
}

/** `Create 1 card`, `Create 2 cards`. */
export function createLabel(n: number): string {
  return n === 1 ? "Create 1 card" : `Create ${n} cards`;
}

/** One toast for every card (toasts show one at a time): what was made,
 *  what wasn't and why, and **Open <workspace>** for the first card — a cold
 *  workspace is opened only when the member asks. */
export function madeWords(made: CopyMade): { title: string; body: string } {
  const names = made.cards.map((c) => c.name);
  const linked = (made.linked ?? []).map((l) => l.name);
  const title =
    made.cards.length === 0 && linked.length > 0
      ? `Linked in ${namesWords(linked)}`
      : made.cards.length === 1
        ? `Card made in ${names[0]}: ${made.cards[0].card.title}`
        : `${made.cards.length} cards made`;
  const parts: string[] = [];
  if (made.cards.length === 1) parts.push(skillCardReach(made.cards[0].card));
  else if (made.cards.length > 1) parts.push(`${names.join(", ")} each have a card to ship.`);
  if (linked.length > 0) {
    parts.push(machineWords(`${namesWords(linked)} had this version already: linked on this Mac, no card needed.`));
  }
  for (const r of made.refused) parts.push(`Not in ${r.name}: ${r.why}`);
  return { title, body: parts.join(" ") };
}

/** The card the toast opens: the first picked whose workspace is already
 *  open (its board loaded), so the toast never warms a cold workspace while
 *  a warm one was picked; the first picked when none is. */
export function cardToOpen(made: CopyMade, isWarm: (workspaceId: string) => boolean): CopyMade["cards"][number] | undefined {
  return made.cards.find((c) => isWarm(c.workspaceId)) ?? made.cards[0];
}

function madeToast(made: CopyMade) {
  const words = madeWords(made);
  const first = cardToOpen(made, (id) => useKanban.getState().byWorkspace[id]?.loaded === true);
  pushToast({
    kind: made.refused.length > 0 ? "warn" : "info",
    ...words,
    ...(first
      ? {
          action: {
            label: `Open ${first.name}`,
            onClick: () => {
              useUi.getState().setAllSkillsOpen(false);
              void useKanban
                .getState()
                .loadFromDisk(first.workspaceId, true)
                .then(() => openCardStep(first.workspaceId, first.card.id, "outcome"));
            },
          },
        }
      : {}),
  });
}
