import { useState, type ReactNode } from "react";
import { openWebLink, type BuildLaneId, type KanbanCard } from "../ipc";
import { LANES, isUndecided, laneOf, laneVendorName } from "../lib/buildBoth";
import { foundWords, tryCommandProblem, tryScopeLine } from "../lib/tryCommand";
import {
  FIX_HINT,
  OTHER_WAY_SENTENCE,
  STOP_FAILED_SENTENCE,
  TRY_IT_LABEL,
  TRY_SHEET_LEDE,
  TRY_SHEET_PROJECT_LEDE,
  TRY_SHEET_NOTHING_FOUND,
  TRY_SHEET_STATIC,
  TRY_SHEET_TITLE,
  SETUP_FIELD_LABEL,
  askWords,
  setupToSave,
  ranWords,
  sheetStart,
  tryRunKey,
  tryStatus,
  typedAddressProblem,
  type TryRun,
} from "../lib/tryPanel";
import { showTrySession } from "../lib/trySession";
import { loopbackUrl } from "../lib/tryAddress";
import { isProjectTry, tryCwdFor, type TryLane } from "../lib/tryTile";
import { shownLaneKey, useBuildBoth } from "../store/buildBothStore";
import { useTryRuns } from "../store/tryRunStore";
import { useTryStopped } from "../store/tryStoppedStore";
import { pushToast } from "../store/toastStore";
import { BrowserPane } from "./BrowserPane";
import { CBtn, Details, Segmented, Sheet, StateWord, TextField, revealElement } from "./ux";
import { linkDidNotOpen } from "../lib/linkToast";

/** The copy a card's Try it is about: the build shown, when it is built by
 *  both and not picked yet; else the card's own. */
export function useTryLane(card: KanbanCard): TryLane | null {
  const shown = useBuildBoth((s) => s.shownLane[shownLaneKey(card.workspaceId, card.id)]) ?? "a";
  return isUndecided(card) ? shown : null;
}

/** Try it, pressed from the Now box or the review: the copy's panel, after
 *  whatever a start needs first. */
export function pressTryIt(card: KanbanCard, lane: TryLane | null): void {
  void useTryRuns
    .getState()
    .press(card, lane)
    .then(() => {
      // The panel is where the answer is — running already, or what it asks.
      revealElement(document.querySelector<HTMLElement>(`[data-ply-try-panel="${tryPanelId(card)}"]`));
    });
}

/** The panel's mark: a workspace's card page draws one card at a time, and
 *  each warmed workspace has its page. */
function tryPanelId(card: Pick<KanbanCard, "workspaceId" | "id">): string {
  return `${card.workspaceId}:${card.id}`;
}

/** The card's copy is gone (shipped, archived): nothing to start again in it
 *  — after Ship, Try it in the project is TI-5's. */
function copyGone(card: KanbanCard, lane: TryLane | null): boolean {
  return card.shipStatus === "shipped" || !!card.archived || !tryCwdFor(card, lane);
}

/**
 * Try it TI-4 (docs/try-it/TRY_IT_SPEC.md §3.1, §6): the card page's Try it
 * panel — what the card copy's Try session is doing, as a dot and a word,
 * the preview of the found address, and its ways on. Drawn once Try it was
 * pressed (or Plyloft stopped a preview, which it says). Never holds a
 * terminal: the session is a tile on Terminals (Show the session), so this
 * panel coming and going unmounts nothing else on the page.
 */
export function TryItPanel({ card }: { card: KanbanCard }) {
  const lane = useTryLane(card);
  const key = tryRunKey(card.workspaceId, card.id, lane);
  const run = useTryRuns((s) => s.runs[key]);
  const stoppedWords = useTryStopped((s) => s.words[key]) ?? null;
  const undecided = isUndecided(card);
  const otherLane: BuildLaneId = lane === "b" ? "a" : "b";
  const otherRun = useTryRuns((s) => (undecided ? s.runs[tryRunKey(card.workspaceId, card.id, otherLane)] : undefined));
  if (!run && !stoppedWords && !otherRun) return null;
  const bb = card.buildBoth;
  const laneName = undecided && lane ? laneVendorName(laneOf(bb, lane), lane) : null;
  return (
    <section className="ux-card-section" aria-label={TRY_IT_LABEL} data-ply-try-panel={tryPanelId(card)}>
      <h2 className="ux-card-heading">{TRY_IT_LABEL}</h2>
      {undecided && (
        <Segmented<BuildLaneId>
          label="Build"
          value={lane ?? "a"}
          onChange={(next) => useBuildBoth.getState().showLane(card.workspaceId, card.id, next)}
          options={LANES.map((id) => ({ value: id, label: laneVendorName(laneOf(bb, id), id) }))}
        />
      )}
      {run ? (
        <TryRunView card={card} lane={lane} run={run} laneName={laneName} stoppedWords={stoppedWords} />
      ) : stoppedWords ? (
        <>
          <p className="ux-try-status" aria-live="polite">
            <StateWord state="empty">Stopped</StateWord>
          </p>
          <p className="ux-card-plain">{stoppedWords}</p>
        </>
      ) : (
        <>
          <p className="ux-try-status" aria-live="polite">
            <StateWord state="empty">Not started</StateWord>
          </p>
          {!copyGone(card, lane) && (
            <div className="ux-card-section-actions">
              <CBtn tone="quiet" onClick={() => pressTryIt(card, lane)}>
                {TRY_IT_LABEL}
              </CBtn>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TryRunView({
  card,
  lane,
  run,
  laneName,
  stoppedWords,
}: {
  card: KanbanCard;
  lane: TryLane | null;
  run: TryRun;
  laneName: string | null;
  stoppedWords: string | null;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [typed, setTyped] = useState("");
  // 1.168.1 B4: Set it up and try's setup command, pre-filled with the
  // suggestion it is for; saved only by the press.
  const [setupDraft, setSetupDraft] = useState<{ for: string; value: string } | null>(null);
  const setUpAsk = run.phase === "ask" && run.ask?.kind === "setUp" && !run.ask.readOnly ? run.ask : null;
  const setupTyped = setUpAsk ? (setupDraft?.for === setUpAsk.install ? setupDraft.value : setUpAsk.install) : "";
  const status = tryStatus(run);
  const store = useTryRuns.getState();
  const showSession = run.tileId ? (
    <CBtn
      tone="quiet"
      onClick={() => {
        if (!showTrySession(run.tileId!)) {
          pushToast({ kind: "info", title: "The session has ended", body: "Try again starts a new one." });
        }
      }}
    >
      Show the session
    </CBtn>
  ) : null;
  const stop = (
    <CBtn tone="quiet" onClick={() => void store.stop(card, lane)}>
      Stop
    </CBtn>
  );
  const openInBrowser =
    run.address && loopbackUrl(run.address) ? (
      <CBtn
        tone={run.secure ? "strong" : "quiet"}
        onClick={() =>
          void openWebLink(loopbackUrl(run.address!)!).catch((e: unknown) =>
            pushToast(linkDidNotOpen(loopbackUrl(run.address!)!, e)),
          )
        }
      >
        Open in browser
      </CBtn>
    ) : null;
  const gone = copyGone(card, lane);
  const changeHow = gone ? null : (
    <CBtn tone="quiet" onClick={() => void store.openSheet(card, lane)}>
      Change how it starts
    </CBtn>
  );
  const tryAgain = gone ? null : (
    <CBtn tone="strong" onClick={() => void store.tryAgain(card, lane)}>
      Try again
    </CBtn>
  );
  const otherWay =
    !gone && run.blocked === "quickExit" && run.cmdForm ? (
      <CBtn tone="quiet" onClick={() => void store.tryOtherWay(card, lane)}>
        Try again the other way
      </CBtn>
    ) : null;
  const typedProblem = typedAddressProblem(typed);

  let actions: ReactNode = null;
  switch (run.phase) {
    case "ask": {
      const words = run.ask ? askWords(run.ask) : null;
      actions = (
        <>
          {words && (
            <CBtn
              tone="strong"
              disabled={!!setUpAsk && !setupToSave(setupTyped)}
              onClick={() => void store.answer(card, lane, setUpAsk ? setupTyped : undefined)}
            >
              {words.action}
            </CBtn>
          )}
          {changeHow}
        </>
      );
      break;
    }
    case "installing":
      actions = null;
      break;
    case "starting":
      actions = (
        <>
          {showSession}
          {stop}
        </>
      );
      break;
    case "running":
      actions = (
        <>
          {!run.secure && (
            <CBtn tone="quiet" onClick={() => setReloadKey((n) => n + 1)}>
              Reload
            </CBtn>
          )}
          {openInBrowser}
          {showSession}
          {stop}
        </>
      );
      break;
    case "stopped":
      actions = (
        <>
          {tryAgain}
          {changeHow}
        </>
      );
      break;
    case "failed":
      actions =
        run.blocked === "scripts" ? (
          <>
            {tryAgain}
            {showSession}
          </>
        ) : (
          <>
            {tryAgain}
            {otherWay}
            {!run.installFailed && changeHow}
            {showSession}
          </>
        );
      break;
  }

  const askSentence =
    run.phase === "ask" && run.ask ? askWords(run.ask, undefined, setUpAsk ? setupTyped : undefined).sentence : null;
  const showsDetailsLine = run.phase === "running" || run.phase === "starting" || run.phase === "stopped";

  return (
    <>
      <p className="ux-try-status" aria-live="polite" data-ply-try-phase={run.phase}>
        <StateWord state={status.dot} live={status.live}>
          {status.word}
        </StateWord>
      </p>
      {run.phase === "stopped" && stoppedWords ? (
        <p className="ux-card-plain">{stoppedWords}</p>
      ) : (
        (askSentence ?? status.sentence) && <p className="ux-card-plain">{askSentence ?? status.sentence}</p>
      )}
      {setUpAsk && <p className="ux-sheet-change-label">{SETUP_FIELD_LABEL}</p>}
      {setUpAsk && (
        <div className="ux-try-address">
          <TextField
            value={setupTyped}
            onChange={(value) => setSetupDraft({ for: setUpAsk.install, value })}
            mono
            wide
            label={SETUP_FIELD_LABEL}
            error={!setupToSave(setupTyped)}
            onEnter={(next) => {
              if (setupToSave(next)) void store.answer(card, lane, next);
            }}
          />
        </div>
      )}
      {setUpAsk && <p className="ux-card-muted">{tryScopeLine(setUpAsk.shared)}</p>}
      {run.phase === "failed" && run.blocked === "quickExit" && run.cmdForm && (
        <p className="ux-card-plain">{OTHER_WAY_SENTENCE}</p>
      )}
      {run.phase === "failed" && run.blocked && run.cmdForm && (
        <p className="ux-card-mono">{run.cmdForm}</p>
      )}
      {run.stopFailed && <p className="ux-card-plain">{STOP_FAILED_SENTENCE}</p>}
      {actions && <div className="ux-card-section-actions">{actions}</div>}

      {run.phase === "starting" && run.noAddress && (
        <div className="ux-try-address">
          <TextField
            value={typed}
            onChange={setTyped}
            mono
            wide
            label="Your app's address"
            placeholder="http://localhost:3000"
            error={!!typedProblem}
            onEnter={(next) => {
              if (!typedAddressProblem(next)) store.useAddress(card, lane, next);
            }}
          />
          <CBtn
            tone="strong"
            disabled={!typed.trim() || !!typedProblem}
            onClick={() => store.useAddress(card, lane, typed)}
          >
            Show it
          </CBtn>
          {typedProblem && <p className="ux-card-muted">{typedProblem}</p>}
        </div>
      )}

      {run.phase === "running" && run.address && !run.secure && (
        <div className="ux-try-preview">
          <BrowserPane workspaceId={card.workspaceId} address={run.address} reloadKey={reloadKey} />
        </div>
      )}

      {run.phase === "failed" && run.blocked !== "scripts" && !run.installFailed && !run.error && (
        <p className="ux-card-muted">{FIX_HINT}</p>
      )}
      {run.phase === "failed" && (
        <Details open>
          {run.command && <p className="ux-card-muted">{ranWords(run, laneName)}</p>}
          {run.lines.length > 0 ? (
            <pre className="ux-output" data-ply-try-lines="">
              {run.lines.join("\n")}
            </pre>
          ) : (
            <p className="ux-card-muted">It printed nothing.</p>
          )}
        </Details>
      )}
      {showsDetailsLine && run.command && (
        <Details>
          <p className="ux-card-muted">{ranWords(run, laneName)}</p>
        </Details>
      )}
    </>
  );
}

/**
 * Try it TI-4 (spec §3.3): the How to start your app sheet — the detected
 * command in the field to use or edit, a field to type one when nothing was
 * found, or a plain website's Open index.html. Save and try saves it through
 * TI-1's save (with or without this repository's build settings here) and
 * starts it.
 */
export function TryStartSheetHost({ workspaceId, project = false }: { workspaceId: string; project?: boolean }) {
  // Two hosts per workspace: the card page's for a card's copy, Code's
  // project strip's for Try it in <project> (TI-5). Each draws its own.
  const sheet = useTryRuns((s) =>
    s.sheet?.card.workspaceId === workspaceId && isProjectTry(s.sheet.card.id) === project ? s.sheet : null,
  );
  if (!sheet) return null;
  return <TryStartSheet key={`${sheet.card.id}:${sheet.lane ?? ""}:${sheet.view ? "read" : "reading"}`} />;
}

function TryStartSheet() {
  const sheet = useTryRuns((s) => s.sheet)!;
  const view = sheet.view;
  // TI-5: the project folder's sheet — its own lede, and no Open index.html
  // (that opens a card's copy's file): a plain website types a command.
  const project = isProjectTry(sheet.card.id);
  const detected = sheetStart(view);
  const start = project && detected.kind === "staticSite" ? { kind: "nothing" as const, text: "" } : detected;
  const [text, setText] = useState(start.text);
  const [typing, setTyping] = useState(start.kind !== "staticSite");
  const store = useTryRuns.getState();
  const problem = tryCommandProblem(text);
  const readOnly = !!view?.readOnly;
  const canSave = !!view && !readOnly && !sheet.busy && !!text.trim() && !problem;
  const found = view && !view.command && text.trim() === start.text && start.kind === "suggested"
    ? foundWords(view.detection)
    : null;
  const scope = view ? `${tryScopeLine(view.shared)} · Building and checking` : null;

  return (
    <Sheet
      title={TRY_SHEET_TITLE}
      lede={project ? TRY_SHEET_PROJECT_LEDE : TRY_SHEET_LEDE}
      size="confirm"
      onClose={store.closeSheet}
      canDismiss={!sheet.busy}
      footNote={scope ?? undefined}
      actions={
        <>
          <CBtn tone="quiet" onClick={store.closeSheet} disabled={sheet.busy}>
            Cancel
          </CBtn>
          {start.kind === "staticSite" && !typing ? (
            <CBtn tone="strong" onClick={() => void store.openIndex()}>
              Open index.html
            </CBtn>
          ) : (
            <CBtn tone="strong" disabled={!canSave} onClick={() => void store.saveAndTry(text)}>
              {sheet.busy ? "Saving…" : "Save and try"}
            </CBtn>
          )}
        </>
      }
    >
      {!view ? (
        <p className="ux-card-muted">Plyloft is reading this repository.</p>
      ) : (
        <>
          {start.kind === "staticSite" && (
            <>
              <p className="ux-card-plain">{TRY_SHEET_STATIC}</p>
              <p className="ux-card-muted">Open index.html shows it in your browser; nothing is started.</p>
              {!typing && !readOnly && (
                <div className="ux-card-section-actions">
                  <CBtn tone="quiet" onClick={() => setTyping(true)}>
                    Type a command instead
                  </CBtn>
                </div>
              )}
            </>
          )}
          {start.kind === "nothing" && <p className="ux-card-plain">{TRY_SHEET_NOTHING_FOUND}</p>}
          {typing && (
            <>
              <p className="ux-sheet-change-label">Command</p>
              <TextField
                value={text}
                onChange={setText}
                mono
                wide
                readOnly={readOnly}
                label="Command"
                placeholder="npm run dev"
                error={!!problem}
                onEnter={(next) => {
                  if (canSave && !tryCommandProblem(next)) void store.saveAndTry(next);
                }}
              />
              {problem && <p className="ux-card-muted">{problem}</p>}
              {found && <p className="ux-card-muted">{found}</p>}
              {readOnly && (
                <p className="ux-card-muted">Set in the repository; ask for write access to change it.</p>
              )}
            </>
          )}
          {sheet.error && (
            <>
              <p className="ux-card-plain">{sheet.error.words}</p>
              <Details>
                <pre className="ux-output">{sheet.error.details}</pre>
              </Details>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
