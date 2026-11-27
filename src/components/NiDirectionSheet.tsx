// 1.173.0 (E5): the direction editor (mockup next-improvement.html scene 2)
// that `openDirectionEditor` opens — from *Direction…* and a start refused
// for a missing direction (1.174.0 A6: Prepare proposals on the first use).
// Four short answers, the approaches each with its own line, who proposes
// and who gives the second opinion, and the "Not to propose again" list with
// *Remove* per row. *Save* writes it with E1's `niDirectionSave`;
// *Save and prepare proposals* then starts a round (E2's `niRoundStart`).
// Prefilled from the draft while none exists; focus on the first field. A
// read-only Mac or an unreadable file shows the values and why, with no
// Save. E6: an unshared project saves on this computer only and says so,
// offering the banner's Share where sharing is possible. A direction
// waiting for a choice opens C3's sheet.
//
// Challenger round 1: Save sends the repository's direction as it is now
// with only the answers the person changed here laid over it, and a change
// that arrives while the sheet is open (`ni://direction`) refreshes the
// answers nobody touched. One host, in App.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  NI_APPROACHES,
  niDirectionAdoptProject,
  niDirectionGet,
  niDirectionSave,
  niRoundStart,
  niUnreject,
  onNiDirection,
  type NiDirection,
  type NiDirectionView,
} from "../ipc";
import { CBtn, FailureText, Segmented, Sheet, TextField } from "./ux";
import { failure, type Failure } from "../lib/failure";
import { rawError } from "../lib/cardPage";
import { machineWords } from "../lib/platform";
import { vendorReadiness } from "../lib/vendorReadiness";
import { adoptionBanner } from "../lib/adoption";
import {
  CHOOSE,
  isNoDirectionRefusal,
  isWebAddress,
  niProblemWords,
  WAITING_FOR_CHOICE,
} from "../lib/nextImprovement";
import {
  APPROACH_LEGEND,
  APPROACH_LINES,
  audiencePlaceholder,
  audienceSuggestion,
  BETTER_HINT,
  DIRECTION_FIELDS,
  directionLede,
  directionTitle,
  lookAtHintWords,
  lookAtSuggestion,
  KEPT_HERE,
  KEPT_HERE_SHORT,
  NO_APPROACH_HINT,
  NONE_READY,
  oneAiWords,
  PROPOSER_OPTIONS,
  proposerNote,
  proposerStandIn,
  PROPOSES_LABEL,
  REJECTED_HEADING,
  rejectedLine,
  rejectedLink,
  REMOVE,
  ROUND_RUNNING_WORDS,
  SAVE_AND_PREPARE,
  SAVED_TITLE,
  savedPendingWords,
  savesToWords,
  SHARE_IT,
  SHARE_THE_SETUP,
  startFailedWords,
  USE_IT,
  WHERE_EMPTY_HINT,
  WHERE_INVALID,
  WHERE_LABEL,
  type NiProposer,
} from "../lib/niDirectionWords";
import { closeDirectionEditor, niKey, takeNotice, useNextImprovement } from "../store/nextImprovementStore";
import { useSettingConflict } from "../store/settingConflictStore";
import { useDoctor } from "../store/doctorStore";
import { pushToast } from "../store/toastStore";
import { useSolo } from "../store/workModeStore";
import { useAreas, useAreasView } from "../store/areaStore";
import { sharesAreasLine } from "../lib/areasPage";
import { useTeamAllowed } from "../store/accountStore";
import { shareWorkspaceSetup, useAdoptionStatus } from "./AdoptionBanner";

export function NiDirectionSheetHost() {
  const ask = useNextImprovement((s) => s.directionAsk);
  if (!ask) return null;
  return <NiDirectionSheet key={`${ask.workspaceId}:${ask.area ?? ""}`} {...ask} />;
}

/** The answers the editor holds; the rest of the file is the repository's. */
const EDITED = ["audience", "better", "avoid", "lookAt", "approaches", "proposer"] as const;
type Edited = (typeof EDITED)[number];

const TEXT_MAX = 1000; // E1's `TEXT_MAX`

/** The base the editor starts from: the saved direction, else the draft
 *  (never "What better means") with the suggested address. With a saved
 *  direction the suggestion is offered beside the field, never filled in.
 *  1.174.0 (C9, P14, NIW-2): For whom starts empty, and an address only the
 *  README gives is offered, not filled in. */
export function startingPoint(v: NiDirectionView, fromProject = false): NiDirection {
  if (v.exists) return { ...v.direction };
  // C11: *Check the direction first…* starts from the one written before
  // the areas, its list included: that list comes along when it is saved
  // as this area's.
  if (fromProject && v.beforeAreas) return { ...v.beforeAreas };
  const base = v.draft?.direction ?? v.direction;
  const hinted = v.lookAtHint && v.lookAtHint.source !== "readme" ? v.lookAtHint.url : "";
  const lookAt = base.lookAt && v.lookAtHint?.source === "readme" && base.lookAt === v.lookAtHint.url ? "" : base.lookAt;
  return { ...base, rejected: v.direction.rejected, audience: "", better: "", lookAt: lookAt || hinted };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The answers changed here since `start`. */
export function changedAnswers(draft: NiDirection, start: NiDirection): Partial<NiDirection> {
  const out: Partial<NiDirection> = {};
  for (const k of EDITED) if (!same(draft[k], start[k])) (out as Record<Edited, unknown>)[k] = draft[k];
  return out;
}

function NiDirectionSheet({
  workspaceId,
  area,
  thenStart,
  fromProject = false,
}: {
  workspaceId: string;
  area: string | null;
  thenStart: boolean;
  fromProject?: boolean;
}) {
  const [view, setView] = useState<NiDirectionView | null>(null);
  // 1.173.0 re-walk: the area the sheet was opened for names it from the
  // first frame (the dialog's name is its title), before its view is read.
  const askedName = useAreas((s) => (area ? s.views[workspaceId]?.areas.find((a) => a.id === area)?.name : undefined));
  const [draft, setDraft] = useState<NiDirection | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  // C9: *Share it…* beside Save opens what sharing does, and its press.
  const [shareOpen, setShareOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [focusAfter, setFocusAfter] = useState<{ to: number | "first"; at: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const start = useRef<NiDirection | null>(null);
  const resolvedArea = useRef<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  const listHead = useRef<HTMLHeadingElement>(null);
  const removeButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const betterHintId = useId();
  const whereHintId = useId();
  const whereId = useId();
  const shareRegionId = useId();
  const shareRegion = useRef<HTMLDivElement>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const key = niKey(workspaceId, area);
  const running = useNextImprovement((s) => s.rounds[key]?.round?.status === "running");
  const solo = useSolo();
  const licensed = useTeamAllowed();
  const { status: adoption, reload: reloadAdoption } = useAdoptionStatus(
    view && !view.shared ? workspaceId : null,
    solo,
  );

  /** A view read again: the answers nobody touched take its values; what
   *  the person typed stays. The list is always the repository's. */
  const take = useCallback((v: NiDirectionView) => {
    resolvedArea.current = v.area;
    setView(v);
    // E6: the repository's direction was kept over this computer's — once.
    if (v.notice && takeNotice(workspaceId, v)) setNotice(v.notice);
    const next = startingPoint(v, fromProject);
    const before = start.current;
    start.current = next;
    setDraft((d) => {
      if (!d || !before) return next;
      const merged: NiDirection = { ...next };
      for (const k of EDITED) {
        if (!same(d[k], before[k])) (merged as Record<Edited, unknown>)[k] = d[k];
      }
      return merged;
    });
  }, [workspaceId, fromProject]);

  const reread = useCallback(async () => {
    const v = await niDirectionGet(workspaceId, area);
    if (v) take(v);
    return v;
  }, [workspaceId, area, take]);

  useEffect(() => {
    let live = true;
    void niDirectionGet(workspaceId, area)
      .then((v) => {
        if (live && v) take(v);
      })
      .catch((e) => live && setProblem(failure(niProblemWords(rawError(e), "Plyloft couldn't read the direction."), e)));
    // Another Mac's change, a refresh or a press elsewhere, while it's open.
    const off = onNiDirection((e) => {
      if (!live || e.workspaceId !== workspaceId || e.area !== resolvedArea.current) return;
      void niDirectionGet(workspaceId, area)
        .then((v) => {
          if (live && v) take(v);
        })
        .catch(() => {});
    });
    return () => {
      live = false;
      void off.then((f) => f()).catch(() => {});
    };
  }, [workspaceId, area, take]);

  useEffect(() => {
    if (draft) first.current?.focus();
    // Once, when the fields first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft === null]);

  useEffect(() => {
    if (listOpen) listHead.current?.focus();
  }, [listOpen]);

  // Challenger 5: after Remove, the next row's Remove, else the previous
  // one, else the heading; an emptied list hands focus to the first field.
  useEffect(() => {
    if (!focusAfter) return;
    if (focusAfter.to === "first") first.current?.focus();
    else (removeButtons.current[focusAfter.to] ?? listHead.current)?.focus();
  }, [focusAfter]);

  // E6: an unshared project is editable too (kept on this computer).
  const editable = !!view && !view.readOnly && !view.problem;
  const conflicts = view?.pending?.state === "conflict" ? view.pending.conflicts : [];
  const pendingWords = view?.pending?.state !== "conflict" ? savedPendingWords(view?.pending) : null;
  // C11 review: checking the direction written before the areas, the list
  // shown is the one that comes along; it is changed once it is this area's.
  const copying = fromProject && !!view && !view.exists && !!view.beforeAreas;
  const rejected = (copying ? view?.beforeAreas?.rejected : view?.direction.rejected) ?? [];
  const addressOk = !draft || isWebAddress(draft.lookAt);
  const ready = !!draft && draft.better.trim() !== "" && addressOk && conflicts.length === 0;

  // Who proposes: both ready → the segment; one → that one, twice; none →
  // say so.
  const claudeReady = readiness.claude.ready;
  const codexReady = readiness.codex.ready;
  const noneReady = !claudeReady && !codexReady;
  const oneAi: NiProposer | null = claudeReady && !codexReady ? "claude" : codexReady && !claudeReady ? "codex" : null;
  const chosen: NiProposer = draft?.proposer === "codex" ? "codex" : "claude";
  const proposer: NiProposer = oneAi ?? chosen;
  const note = noneReady ? null : proposerNote(proposer, !oneAi);
  const other = (ai: NiProposer): NiProposer => (ai === "claude" ? "codex" : "claude");
  const notReady = oneAi ? readiness[other(oneAi)].reason : null;
  // Challenger 8: the direction names the AI that isn't ready here.
  const asked = draft?.proposer === "codex" || draft?.proposer === "claude" ? draft.proposer : null;
  const standIn = oneAi && asked && asked !== oneAi && notReady ? proposerStandIn(asked, oneAi, notReady) : null;

  // E6: an unshared project keeps it on this computer and says so; the
  // banner's Share is offered where sharing is possible (not solo, on
  // GitHub, the notice above the Board not waiting for another answer).
  const keptHere = !!view && !view.shared;
  const shareable =
    keptHere && !solo && !!adoption?.githubRepo &&
    (adoption.action.kind === "ask" || adoption.action.kind === "none");
  // 1.174.0 (C10, D6 §4a): the areas kept on this Mac go with the Share.
  const areasLine = sharesAreasLine(useAreasView(workspaceId));
  const askedBody = shareable && adoption ? adoptionBanner({ ...adoption, action: { kind: "ask" } }, licensed)?.body : null;
  const shareBody = askedBody && areasLine ? `${askedBody} ${areasLine}` : askedBody;
  const cantSave = view?.problem ?? (view?.readOnly ? view.readOnlyReason : null);

  const save = async (andStart: boolean) => {
    if (!draft || busy || !start.current) return;
    setBusy(true);
    setProblem(null);
    let saved: NiDirectionView;
    try {
      // The file as it is now, with only what was changed here over it.
      const fresh = await niDirectionGet(workspaceId, area);
      const base = fresh ? startingPoint(fresh, fromProject) : start.current;
      const changed = changedAnswers(draft, start.current);
      if (fromProject && fresh && !fresh.exists && fresh.beforeAreas) {
        // C11: this area's copy of the direction written before the areas,
        // with the answers as checked here and its list.
        await niDirectionAdoptProject(workspaceId, [fresh.area], { ...base, ...changed });
        saved = await niDirectionGet(workspaceId, fresh.area);
      } else {
        saved = await niDirectionSave(workspaceId, area, { ...base, ...changed });
      }
    } catch (e) {
      const words = isNoDirectionRefusal(e) ? rawError(e) : niProblemWords(rawError(e), "Plyloft couldn't save the direction.");
      setProblem(failure(words, e));
      setBusy(false);
      return;
    }
    useNextImprovement.getState().setDirection(key, saved);
    // A save that waits — a pull request, offline, a choice — says so.
    const waits = savedPendingWords(saved.pending);
    if (waits) pushToast({ kind: saved.pending?.state === "failed" ? "warn" : "info", title: SAVED_TITLE, body: waits });
    if (andStart) {
      try {
        const round = await niRoundStart(workspaceId, area);
        useNextImprovement.getState().setRound(key, round);
      } catch (e) {
        start.current = null;
        take(saved);
        setProblem(failure(startFailedWords(niProblemWords(rawError(e), "Next improvement couldn't start the round.")), e));
        setBusy(false);
        return;
      }
    }
    closeDirectionEditor();
  };

  const remove = async (index: number) => {
    const row = rejected[index];
    if (!row || removing !== null) return;
    setRemoving(index);
    setProblem(null);
    try {
      const next = await niUnreject(workspaceId, area, { index, title: row.title, at: row.at });
      take(next);
      useNextImprovement.getState().setDirection(key, next);
      const left = next.direction.rejected.length;
      if (left === 0) setListOpen(false);
      setFocusAfter({ to: left === 0 ? "first" : Math.min(index, left - 1), at: Date.now() });
    } catch (e) {
      setProblem(failure(niProblemWords(rawError(e), "Plyloft couldn't remove it from the list."), e));
      // Challenger 4: a list that moved since is shown as it is now.
      void reread().catch(() => {});
    } finally {
      setRemoving(null);
    }
  };

  const share = async () => {
    if (sharing) return;
    setSharing(true);
    setProblem(null);
    try {
      await shareWorkspaceSetup(workspaceId, adoption);
      await reread().catch(() => {});
    } finally {
      setSharing(false);
      reloadAdoption();
    }
  };

  // C9 round 1: Share it… brings what sharing does into view, on its press.
  useEffect(() => {
    if (!shareOpen) return;
    shareRegion.current?.scrollIntoView?.({ block: "nearest" });
    shareButton.current?.focus();
  }, [shareOpen]);

  const set = (patch: Partial<NiDirection>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const toggle = (approach: string) =>
    set({
      approaches: draft?.approaches.includes(approach)
        ? draft.approaches.filter((a) => a !== approach)
        : [...(draft?.approaches ?? []), approach],
    });

  // C11 round 3: checking the direction written before the areas, nothing
  // of the README is offered: the answers are the ones already written.
  const suggestion =
    !copying && view?.lookAtHint && draft && draft.lookAt.trim() === "" && (view.exists || view.lookAtHint.source === "readme")
      ? view.lookAtHint
      : null;
  // C9 (P14): For whom as the project's own words say it, offered while
  // nothing is saved and the field is empty.
  const audienceHint = !copying && !view?.exists && editable && draft && draft.audience.trim() === "" ? (view?.draft?.audience ?? null) : null;
  // C9 (NIW-1, D6): where a save goes, beside Save, before the press.
  const viaPullRequest = !!view?.savesViaPullRequest || view?.pending?.state === "pullRequest";
  const footNote = keptHere ? (
    <span data-ni-kept-here="">
      {machineWords(shareable ? KEPT_HERE : KEPT_HERE_SHORT)}
      {shareable && (
        <>
          {" "}
          <CBtn
            size="sm"
            tone="quiet"
            aria-expanded={shareOpen}
            aria-controls={shareRegionId}
            onClick={() => setShareOpen((o) => !o)}
            data-ni-share-it=""
          >
            {SHARE_IT}
          </CBtn>
        </>
      )}
    </span>
  ) : view?.shared && view.savesTo && editable ? (
    <span data-ni-saves-to="">{savesToWords(view.savesTo, viaPullRequest)}</span>
  ) : undefined;
  const whereHint = !addressOk
    ? WHERE_INVALID
    : (lookAtHintWords(view && !view.exists && !copying ? view.lookAtHint : null, draft?.lookAt ?? "") ?? WHERE_EMPTY_HINT);

  return (
    <Sheet
      title={directionTitle(view?.areaName || askedName || "")}
      lede={directionLede(view && !view.exists && !copying ? view.draft?.from : null)}
      onClose={closeDirectionEditor}
      canDismiss={!busy}
      initialFocusRef={first}
      footNote={footNote}
      leadAction={
        rejected.length > 0 ? (
          <CBtn tone="quiet" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
            {rejectedLink(rejected.length)}
          </CBtn>
        ) : undefined
      }
      actions={
        <>
          <CBtn tone="quiet" disabled={busy} onClick={closeDirectionEditor}>
            {editable ? "Cancel" : "Close"}
          </CBtn>
          {editable && (
            <>
              {/* A start refused for a missing direction came here: only
                  the press that prepares them — unless a round is under
                  way, which only Save fits. */}
              {(!thenStart || running) && (
                <CBtn disabled={busy || !ready} onClick={() => void save(false)}>
                  Save
                </CBtn>
              )}
              {!running && (
                <CBtn tone="accent" disabled={busy || !ready} onClick={() => void save(true)}>
                  {busy ? "Saving…" : SAVE_AND_PREPARE}
                </CBtn>
              )}
            </>
          )}
        </>
      }
    >
      <div className="ni-direction" data-ni-direction="">
        {view && cantSave && (
          <p className="ni-hint" data-ni-cant-save="">
            {machineWords(cantSave)}
          </p>
        )}
        {notice && (
          <p className="ni-hint" data-ni-notice="">
            {notice}
          </p>
        )}
        {view?.shared && view.keptHere && (
          <p className="ni-hint" data-ni-kept-local="">
            {view.keptHere}
          </p>
        )}
        {shareable && shareOpen && (
          <div ref={shareRegion} id={shareRegionId} role="region" aria-label={SHARE_THE_SETUP} className="ni-line ni-line--flush" data-ni-share-open="">
            {shareBody && (
              <span className="ux-sheet-hint" data-ni-share-body="">
                {machineWords(shareBody)}
              </span>
            )}
            <CBtn ref={shareButton} size="sm" disabled={sharing || busy} onClick={() => void share()} data-ni-share="">
              {sharing ? "Sharing…" : SHARE_THE_SETUP}
            </CBtn>
          </div>
        )}
        {running && editable && (
          <p className="ni-hint" data-ni-running="">
            {ROUND_RUNNING_WORDS}
          </p>
        )}
        {conflicts.length > 0 && (
          <p className="ni-line ni-line--flush" data-ni-waiting="">
            {WAITING_FOR_CHOICE}
            <CBtn size="sm" tone="quiet" onClick={() => void useSettingConflict.getState().show(workspaceId, conflicts[0].field)}>
              {CHOOSE}
            </CBtn>
          </p>
        )}
        {pendingWords && (
          <p className="ni-hint" data-ni-pending="">
            {pendingWords}
          </p>
        )}
        {problem && (
          <div className="ni-hint" role="alert">
            <FailureText failure={problem} />
          </div>
        )}
        {draft && (
          <>
            {DIRECTION_FIELDS.map((f, i) => {
              const hint = f.key === "better" && editable && draft.better.trim() === "" ? BETTER_HINT : null;
              return (
                <div key={f.key} className="ux-card-field">
                  <label className="ux-card-field">
                    <span className="ux-card-field-label">{f.label}</span>
                    <textarea
                      ref={i === 0 ? first : undefined}
                      className="ux-card-textarea"
                      rows={2}
                      maxLength={TEXT_MAX}
                      readOnly={!editable}
                      value={String(draft[f.key] ?? "")}
                      placeholder={
                        editable ? (f.key === "audience" ? audiencePlaceholder(view?.areaName || askedName || "") : f.placeholder) : undefined
                      }
                      aria-describedby={hint ? betterHintId : undefined}
                      onChange={(e) => set({ [f.key]: e.target.value } as Partial<NiDirection>)}
                    />
                  </label>
                  {hint && (
                    <span id={betterHintId} className="ni-hint" data-ni-better-hint="">
                      {hint}
                    </span>
                  )}
                  {f.key === "audience" && audienceHint && (
                    <span className="ux-sheet-hint" data-ni-audience-suggestion="">
                      {audienceSuggestion(audienceHint)}{" "}
                      <CBtn
                        size="sm"
                        tone="quiet"
                        onClick={() => {
                          set({ audience: audienceHint.text });
                          first.current?.focus();
                        }}
                      >
                        {USE_IT}
                      </CBtn>
                    </span>
                  )}
                </div>
              );
            })}
            <div className="ux-card-field">
              <span className="ux-card-field-label">{WHERE_LABEL}</span>
              <TextField
                label={WHERE_LABEL}
                wide
                readOnly={!editable}
                value={draft.lookAt}
                error={!addressOk}
                // C9 round 1: the address is offered on its own line, never as
                // a placeholder that reads like a value.
                placeholder="https://…"
                id={whereId}
                aria-describedby={whereHintId}
                onChange={(lookAt) => set({ lookAt })}
              />
              {suggestion && editable && (
                <span className="ni-line ni-line--flush" data-ni-suggestion="">
                  <span className="ni-hint">{lookAtSuggestion(suggestion)}</span>
                  <CBtn
                    size="sm"
                    tone="quiet"
                    onClick={() => {
                      set({ lookAt: suggestion.url });
                      document.getElementById(whereId)?.focus();
                    }}
                  >
                    {USE_IT}
                  </CBtn>
                </span>
              )}
              <span id={whereHintId} className="ni-hint" data-ni-where-hint="" role={!addressOk ? "alert" : undefined}>
                {whereHint}
              </span>
            </div>
            <fieldset className="ni-approaches" disabled={!editable}>
              <legend className="ux-card-field-label">{APPROACH_LEGEND}</legend>
              {NI_APPROACHES.map((a) => (
                <label key={a} className="ni-approach" data-ni-approach={a}>
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={draft.approaches.includes(a)}
                    onChange={() => toggle(a)}
                  />
                  <strong>{APPROACH_LINES[a].name}</strong>
                  <span className="ni-hint">{APPROACH_LINES[a].line}</span>
                </label>
              ))}
              {editable && !draft.approaches.some((a) => (NI_APPROACHES as readonly string[]).includes(a)) && (
                <span className="ni-hint" data-ni-no-approach="">
                  {NO_APPROACH_HINT}
                </span>
              )}
            </fieldset>
            <div className="ux-card-field" data-ni-proposer="">
              <span className="ux-card-field-label">{PROPOSES_LABEL}</span>
              {noneReady ? (
                <span className="ni-hint" data-ni-none-ready="">
                  {machineWords(NONE_READY)}
                </span>
              ) : oneAi ? (
                <>
                  <span data-ni-one-ai="">{oneAiWords(oneAi)}</span>
                  {standIn ? (
                    <span className="ni-hint" data-ni-stand-in="">
                      {machineWords(standIn)}
                    </span>
                  ) : (
                    notReady && <span className="ni-hint">{machineWords(`${notReady} on this Mac.`)}</span>
                  )}
                </>
              ) : (
                <Segmented
                  label={PROPOSES_LABEL}
                  value={chosen}
                  options={PROPOSER_OPTIONS.map((o) => ({ ...o, disabled: !editable }))}
                  onChange={(p) => set({ proposer: p })}
                />
              )}
              {note && (
                <span className="ni-hint" data-ni-proposer-note="">
                  {note}
                </span>
              )}
            </div>
            {listOpen && rejected.length > 0 && (
              <div className="ni-rejected" data-ni-rejected="">
                <h3 ref={listHead} className="ux-card-field-label" tabIndex={-1}>
                  {REJECTED_HEADING}
                </h3>
                <ul className="ni-rejected-list">
                  {rejected.map((row, i) => (
                    <li key={`${row.at}:${row.title}`} className="ni-rejected-row">
                      <span className="ni-rejected-main">
                        <span>{row.title}</span>
                        {rejectedLine(row) && <span className="ni-hint">{rejectedLine(row)}</span>}
                      </span>
                      {editable && !copying && (
                        <CBtn
                          ref={(el) => {
                            removeButtons.current[i] = el;
                          }}
                          size="sm"
                          tone="quiet"
                          aria-label={`${REMOVE} “${row.title}”`}
                          disabled={removing !== null || busy}
                          onClick={() => void remove(i)}
                        >
                          {REMOVE}
                        </CBtn>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
