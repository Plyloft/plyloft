import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CliTool } from "../lib/cliHealthIpc";
import type { RepairManualCommand, RepairPlan } from "../lib/cliRepairIpc";
import { cliRepairReport } from "../lib/cliRepairIpc";
import {
  END_NOTE,
  evidenceLine,
  sessionsNote,
  tildePath,
  TOOL_NAME,
  blockView,
  reinstallNote,
  words,
  itemWord,
  manualWords,
  noteLine,
  OPEN_PROGRAM_FOLDERS,
  passwordNotice,
  programFoldersByHand,
  PROGRAM_FOLDERS_OFFER_LINE,
  programFoldersSituation,
  programFoldersOffered,
  stillShortLine,
  PROGRAM_FOLDERS_CHANGED,
  writesProgramFolders,
  pauseWords,
  repairedLine,
  runItems,
  runningVersion,
  sessionClosable,
  sessionWayOut,
  sessionWhat,
  situationLine,
  stepRunLine,
  stepView,
  terminalNote,
  type RunItem,
  type StepView,
  type TerminalNote,
} from "../lib/repairView";
import { setupRunState } from "../lib/setupRun";
import { openTilesOf, useRepair } from "../store/repairStore";
import { useSetupRun } from "../store/setupRunStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useSettings } from "../store/settingsStore";
import { hasPathOverride } from "../lib/diagnostics";
import { SetupTerminal } from "./SetupTerminal";
import { Callout, CBtn, CheckList, CheckRow, Details, Sheet, StatusLine } from "./ux";
import { CopyButton } from "./CopyButton";

const w = (text: string) => words(text);

/** The one host of the Repair sheet, above Settings and Setup (App). */
export function RepairSheetHost() {
  const open = useRepair((s) => s.open);
  const tool = useRepair((s) => s.tool);
  if (!open || !tool) return null;
  return <RepairSheet tool={tool} />;
}

/** Whether a later step of `plan` asks for the password too. */
function passwordFollows(plan: RepairPlan | null, id: string): boolean {
  const steps = plan?.steps ?? [];
  const at = steps.findIndex((s) => s.id === id);
  return steps.slice(at + 1).some((s) => s.needs === "password");
}

/**
 * The guided Repair of one tool (1.176.0 R6): what Plyloft found, what it
 * will do, the steps one at a time, and how it ended. The sequence lives in
 * `useRepair`; this is its view. Words are `lib/repairView.ts`'s.
 */
export function RepairSheet({ tool }: { tool: CliTool }) {
  const name = TOOL_NAME[tool];
  const phase = useRepair((s) => s.phase);
  const plan = useRepair((s) => s.plan);
  const journal = useRepair((s) => s.journal);
  const current = useRepair((s) => s.current);
  const pause = useRepair((s) => s.pause);
  const removeNpm = useRepair((s) => s.removeNpm);
  const health = useRepair((s) => s.health);
  const repaired = useRepair((s) => s.repaired);
  const message = useRepair((s) => s.message);
  const details = useRepair((s) => s.details);
  const output = useRepair((s) => s.output);
  const busy = useRepair((s) => s.busy);
  const waiting = useRepair((s) => s.waiting);
  const dismiss = useRepair((s) => s.dismiss);
  const run = useSetupRun((s) => s.run);
  const runPhase = useSetupRun((s) => s.phase);
  const runOutcome = useSetupRun((s) => s.outcome);
  // The tiles listed while sessions are open follow the window's tiles.
  useTiles((s) => s.byWorkspace);
  const primary = useRef<HTMLButtonElement>(null);
  const store = useRepair.getState;

  const running = phase === "running";
  const items = runItems(journal, plan, tool);
  const reportBtn = (
    <CopyButton tone="quiet" label="Copy report" announce="Report copied" text={() => cliRepairReport(tool, false)} />
  );
  // The "looking" line shows only when the look takes a while: on a healthy
  // machine it would flash. The space stays, so the sheet doesn't jump.
  const looking = phase === "looking";
  const [lookShown, setLookShown] = useState(false);
  useEffect(() => {
    if (!looking) {
      setLookShown(false);
      return;
    }
    const t = setTimeout(() => setLookShown(true), 400);
    return () => clearTimeout(t);
  }, [looking]);
  const reinstall = useRepair((s) => s.reinstall);
  const version = runningVersion(health);

  // The terminal line is the step's own words, not the runner's.
  const terminalLine =
    current && run
      ? {
          state: setupRunState(runPhase, runOutcome),
          text: stepRunLine(
            current.title,
            runPhase === "done" ? "done" : "running",
            runOutcome === "succeeded" ? "succeeded" : runOutcome === "cancelled" ? "cancelled" : "other",
          ),
        }
      : null;

  let body: ReactNode = null;
  let actions: ReactNode = null;
  // The one filled button of the phase: what to do next (P32 / VC-2). One
  // phase shows at a time; the others are bordered.
  let main: { label: ReactNode; onClick: () => void } | null = null;
  let lede: string | undefined;

  switch (phase) {
    case "looking":
      body = (
        <div className="ux-repair">
          <div className="ux-repair-looking" style={{ visibility: lookShown ? "visible" : "hidden" }}>
            <StatusLine state="running">{`Plyloft is looking at ${name}…`}</StatusLine>
          </div>
          {plan && !plan.block && <FoundPanel plan={plan} tool={tool} reinstall={reinstall} />}
          {plan && <NpmChoice plan={plan} tool={tool} ticked={removeNpm} onChange={() => {}} disabled />}
        </div>
      );
      break;
    case "found":
      if (plan) {
        const block = plan.block ? blockView(plan.block, tool, version) : null;
        body = (
          <>
            {plan.block ? (
              <BlockPanel plan={plan} tool={tool} version={version} where={health?.runsToday ?? null} />
            ) : (
              <FoundPanel plan={plan} tool={tool} reinstall={reinstall} />
            )}
            <ReopenOffer tool={tool} />
            <NpmChoice plan={plan} tool={tool} ticked={removeNpm} onChange={(on) => void store().tickNpm(on)} />
          </>
        );
        lede = block ? undefined : "Nothing has run yet.";
        actions = (
          <>
            {reportBtn}
            <CBtn onClick={dismiss}>Close</CBtn>
            {block?.fine && (
              <CBtn disabled={busy} onClick={() => store().restart({ reinstall: true })}>
                Reinstall anyway
              </CBtn>
            )}
            {block?.retry && (
              <CBtn ref={primary} disabled={busy} onClick={() => void store().lookAgain()}>
                Try again
              </CBtn>
            )}
          </>
        );
        if (!block) main = { label: reinstall ? `Reinstall ${name}` : "Repair", onClick: () => void store().go() };
      }
      break;
    case "sessions": {
      const step = plan?.steps[0];
      const sessions = step?.kind === "closeSessions" ? step.sessions : [];
      const chats = openTilesOf(tool).filter((t) => t.ptyId === null);
      const closable = [
        ...sessions.filter((s) => sessionClosable(s) === "tile").map((s) => ({ key: s.id, text: sessionWhat(s) })),
        ...chats.map((t) => ({ key: t.id, text: t.workspaceName ? `${t.workspaceName} · ${t.label}` : t.label })),
      ];
      const others = sessions.filter(
        (s) => sessionClosable(s) === "cannot" && !(s.source === "codexAppServer" && chats.length > 0),
      );
      lede = `${name} is open in some places. Plyloft closes it there before it changes anything.`;
      body = (
        <div className="ux-repair">
          {closable.length > 0 && (
            <div>
              <h3 className="ux-repair-head">{closable.length === 1 && others.length === 0 ? "Plyloft will close this tile" : "Plyloft will close these tiles"}</h3>
              <ul className="ux-repair-list ux-repair-list--plain">
                {closable.map((c) => (
                  <li key={c.key}>{c.text}</li>
                ))}
              </ul>
              <p className="ux-setup-note">{w(sessionsNote(closable.length === 1 && others.length === 0))}</p>
            </div>
          )}
          {others.length > 0 && (
            <div>
              <h3 className="ux-repair-head">Plyloft can't close these</h3>
              <ul className="ux-repair-list ux-repair-list--plain">
                {others.map((s) => (
                  <li key={s.id}>
                    {sessionWhat(s)}
                    <p className="ux-repair-removes">{sessionWayOut(s)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
      actions = (
        <>
          <CBtn onClick={dismiss}>Cancel</CBtn>
        </>
      );
      main =
        closable.length > 0
          ? { label: "Close the tiles and go on", onClick: () => void store().closeSessions() }
          : { label: "Look again", onClick: () => void store().lookAgain() };
      break;
    }
    case "paused": {
      const step = plan?.steps.find((s) => s.id === current?.id);
      const view = step ? stepView(step, tool) : current;
      if (view && pause) {
        const words = pauseWords(pause, view);
        body = (
          <div className="ux-repair">
            <RunList items={items} />
            <div>
              <h3 className="ux-repair-head">Next</h3>
              <p className="ux-setup-text">{words.title}</p>
              {pause === "password" &&
                passwordNotice(view, tool, passwordFollows(plan, view.id)).map((line) => (
                  <p key={line} className="ux-setup-note">
                    {w(line)}
                  </p>
                ))}
              {pause === "changes" && <p className="ux-setup-note">{words.text}</p>}
              {pause === "removes" && (
                <>
                  <p className="ux-setup-note">{words.text}</p>
                  <ul className="ux-repair-list ux-repair-list--plain">
                    {view.removes.map((p) => (
                      <li key={p} className="ux-mono-fg">
                        {p}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <StepDetails view={view} />
            </div>
          </div>
        );
        actions = (
          <>
            <CBtn onClick={dismiss}>Close</CBtn>
          </>
        );
        main = { label: words.button, onClick: () => void store().proceed() };
      }
      break;
    }
    case "running":
      body = (
        <div className="ux-repair">
          <RunList items={items} />
          {current?.password && (
            <div>
              {passwordNotice(current, tool, passwordFollows(plan, current.id)).map((line) => (
                <p key={line} className="ux-setup-note">
                  {w(line)}
                </p>
              ))}
            </div>
          )}
          {current?.inTerminal && run && <SetupTerminal line={terminalLine} focus={current.password} onStop={() => store().stop()} />}
          {current?.inTerminal && !run && (
            <div className="ux-setup-terminal-line">
              <StatusLine state="running">{current.title}</StatusLine>
              <CBtn size="sm" onClick={() => void store().stop()}>
                Stop
              </CBtn>
            </div>
          )}
          {current && !current.inTerminal && <StatusLine state="running">{current.title}</StatusLine>}
        </div>
      );
      break;
    case "stopped":
      body = (
        <div className="ux-repair">
          <StatusLine state="aborted">Stopped. Part of the repair may have been done.</StatusLine>
          <RunList items={items} />
          <ReopenOffer tool={tool} />
        </div>
      );
      actions = (
        <>
          <CBtn onClick={dismiss}>Close</CBtn>
          <CBtn ref={primary} onClick={() => store().restart()}>
            Look again
          </CBtn>
        </>
      );
      break;
    case "error":
      body = (
        <div className="ux-repair">
          <StatusLine state="aborted">{message ?? "Plyloft couldn't go on."}</StatusLine>
          <RunList items={items} />
          {plan && plan.manual.length > 0 && (
            <>
              <p className="ux-setup-note">The commands to do it by hand are below.</p>
              <ByHand commands={plan.manual} tool={tool} />
            </>
          )}
          <OutputDetails output={output} extra={details} />
          <ReopenOffer tool={tool} />
        </div>
      );
      actions = (
        <>
          {reportBtn}
          <CBtn onClick={dismiss}>Close</CBtn>
          <CBtn ref={primary} onClick={() => store().restart()}>
            Try again
          </CBtn>
        </>
      );
      break;
    case "end": {
      const block = plan?.block ? blockView(plan.block, tool) : null;
      body = (
        <EndPanel
          plan={plan}
          tool={tool}
          repaired={repaired}
          items={items}
          version={runningVersion(health)}
          output={output}
          removeNpm={removeNpm}
        />
      );
      actions = (
        <>
          {reportBtn}
          {!repaired && block?.retry && <CBtn onClick={() => store().restart()}>Try again</CBtn>}
          <CBtn ref={primary} onClick={dismiss}>
            Close
          </CBtn>
        </>
      );
      break;
    }
    default: {
      const never: never = phase;
      body = <p>{String(never)}</p>;
    }
  }

  const foot = (
    <>
      {actions}
      {main && (
        <CBtn ref={primary} tone="accent" disabled={busy} onClick={main.onClick}>
          {main.label}
        </CBtn>
      )}
    </>
  );
  const other = waiting && waiting !== tool ? waiting : null;
  return (
    <Sheet
      title={`Repair ${name}`}
      lede={lede}
      size="review"
      onClose={dismiss}
      canDismiss={!running}
      initialFocusRef={primary}
      actions={foot}
    >
      {other && (
        <Callout
          kind="info"
          title={`A repair of ${name} is running.`}
          text={`${TOOL_NAME[other]} waits for it.`}
          actions={
            !running ? <CBtn onClick={() => store().show(other)}>{`Repair ${TOOL_NAME[other]}`}</CBtn> : undefined
          }
        />
      )}
      {body}
    </Sheet>
  );
}

function ReopenOffer({ tool }: { tool: CliTool }) {
  const closed = useRepair((s) => s.closed);
  const reopened = useRepair((s) => s.reopened);
  const skipped = useRepair((s) => s.skipped);
  const name = TOOL_NAME[tool];
  if (reopened) {
    return (
      <div>
        <StatusLine state="done">The tiles are open again.</StatusLine>
        {skipped.length > 0 && (
          <p className="ux-setup-note">{`Not opened, because their project is closed: ${skipped.join(", ")}.`}</p>
        )}
      </div>
    );
  }
  if (closed.length === 0) return null;
  const list = closed.map((c) => (c.workspaceName ? `${c.workspaceName} · ${c.label}` : c.label)).join(", ");
  const chats = closed.some((c) => c.kind === "codex-chat");
  return (
    <Callout
      kind="info"
      title={`Plyloft closed ${closed.length === 1 ? "a" : closed.length} ${name} tile${closed.length === 1 ? "" : "s"}.`}
      text={`${list}. They open again in the same projects, each continuing its own conversation.${chats ? " A Codex chat opens as a new chat." : ""}`}
      actions={<CBtn onClick={() => useRepair.getState().reopenTiles()}>Reopen the tiles Plyloft closed</CBtn>}
    />
  );
}

function RunList({ items }: { items: RunItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="ux-repair-head">The steps</h3>
      <ol className="ux-repair-list" aria-label="The steps">
        {items.map((item) => (
          <li key={item.key} aria-current={item.state === "running" ? "step" : undefined}>
            {item.title} <span className="ux-repair-state">{itemWord(item.state)}</span>
            {item.slow && <p className="ux-repair-removes">{item.slow}</p>}
            {item.failed.length > 0 && (
              <p className="ux-repair-removes">{`Plyloft couldn't change: ${tildePath(item.failed.join(", "))}`}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function OutputDetails({ output, extra }: { output: { title: string; lines: string[] } | null; extra: string | null }) {
  if (!output && !extra) return null;
  return (
    <Details summary="Details">
      {extra && <pre className="ux-output">{extra}</pre>}
      {output && (
        <>
          <p className="ux-mono-fg">{output.title}</p>
          {output.lines.length > 0 ? (
            <pre className="ux-output">{output.lines.join("\n")}</pre>
          ) : (
            <p className="ux-setup-note">Nothing is kept from this step.</p>
          )}
        </>
      )}
    </Details>
  );
}

function StepDetails({ view }: { view: StepView }) {
  if (!view.command && view.paths.length === 0) return null;
  return (
    <Details summary="Details">
      {view.command && <p className="ux-mono-fg">{view.command}</p>}
      {view.paths.map((p) => (
        <p key={p} className="ux-mono-fg">
          {tildePath(p)}
        </p>
      ))}
    </Details>
  );
}

function FoundPanel({ plan, tool, reinstall = false }: { plan: RepairPlan; tool: CliTool; reinstall?: boolean }) {
  const situations = plan.situations.map((s) => situationLine(s, tool));
  const steps = plan.steps.map((s) => stepView(s, tool));
  const notes = plan.notes.map((n) => noteLine(n, tool, { canRemoveNpm: plan.notes.some((x) => x.kind === "npmCopyCanBeRemoved") })).filter((n): n is NonNullable<typeof n> => n !== null);
  const paths = [...situations.flatMap((s) => s.paths), ...notes.flatMap((n) => n.paths)];
  return (
    <div className="ux-repair">
      {reinstall ? (
        <p className="ux-setup-text">{w(reinstallNote(TOOL_NAME[tool]))}</p>
      ) : (
        <div>
          <h3 className="ux-repair-head">What Plyloft found</h3>
          <ul className="ux-repair-list ux-repair-list--plain">
            {situations.map((s) => (
              <li key={s.text}>{w(s.text)}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="ux-repair-head">What Plyloft will do</h3>
        <ol className="ux-repair-list">
          {steps.map((s) => (
            <li key={s.id}>
              {s.title} <span className="ux-repair-who">{s.whoWords}</span>
              {s.kind === "closeSessions" && <SessionsDetail plan={plan} tool={tool} />}
              {s.removes.length > 0 && <p className="ux-repair-removes">{`It removes: ${tildePath(s.removes.join(", "))}`}</p>}
              {s.slow && <p className="ux-repair-removes">{s.slow}</p>}
              {s.passwordAgain && <p className="ux-repair-removes">It asks for the password again.</p>}
            </li>
          ))}
        </ol>
      </div>
      <ProgramFoldersOffer plan={plan} byHand />
      {notes.length > 0 && (
        <div>
          <h3 className="ux-repair-head">What stays as it is</h3>
          <ul className="ux-repair-list ux-repair-list--plain">
            {notes.map((n) => (
              <li key={n.text}>{w(n.text)}</li>
            ))}
          </ul>
        </div>
      )}
      {(plan.steps.some((s) => s.command) || paths.length > 0) && (
        <Details summary="Details">
          {plan.steps
            .filter((s) => s.command)
            .map((s) => (
              <p key={s.id} className="ux-mono-fg">
                {s.command}
              </p>
            ))}
          {[...new Set(paths)].map((p) => (
            <p key={p} className="ux-mono-fg">
              {tildePath(p)}
            </p>
          ))}
        </Details>
      )}
    </div>
  );
}

/** D3: the npm copy is removed only when the box is ticked. The box stays
 *  while it is ticked: with it ticked the engine no longer says the copy
 *  "can be removed" — its removal is a step, which names the path. */
function NpmChoice({
  plan,
  tool,
  ticked,
  onChange,
  disabled,
}: {
  plan: RepairPlan;
  tool: CliTool;
  ticked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const note = plan.notes.find((n) => n.kind === "npmCopyCanBeRemoved");
  if (!note && !ticked) return null;
  const removal = plan.steps.find((s) => s.kind === "removeNpmCopy");
  const path = note && note.kind === "npmCopyCanBeRemoved" ? note.path : (removal?.paths[0] ?? null);
  const name = TOOL_NAME[tool];
  return (
    <CheckList label="Optional">
      <CheckRow
        checked={ticked}
        disabled={disabled}
        onChange={onChange}
        hint={w(`Plyloft removes the copy of ${name} that npm installed${path ? ` (${path})` : ""}. Nothing else is removed. Left unticked, it stays.`)}
      >
        Also remove the copy installed with npm
      </CheckRow>
    </CheckList>
  );
}

function BlockPanel({
  plan,
  tool,
  version,
  where,
}: {
  plan: RepairPlan;
  tool: CliTool;
  version: string | null;
  where: string | null;
}) {
  if (!plan.block) return null;
  const view = blockView(plan.block, tool, version);
  const situations = plan.situations
    .filter((s) => s.kind !== "healthy" && s.kind !== "healthyEnough")
    .map((s) => situationLine(s, tool));
  return (
    <div className="ux-repair">
      <StatusLine state={view.fine ? "done" : "aborted"}>{view.title}</StatusLine>
      <p className="ux-setup-text">{w(view.text)}</p>
      {stillShortLine(plan, tool, version) && <p className="ux-setup-text">{w(stillShortLine(plan, tool, version) ?? "")}</p>}
      <EvidenceNote plan={plan} />
      {view.fine && where && (
        <Details summary="Details">
          <p className="ux-mono-fg">{tildePath(where)}</p>
        </Details>
      )}
      {situations.length > 0 && (
        <div>
          <h3 className="ux-repair-head">What Plyloft found</h3>
          <ul className="ux-repair-list ux-repair-list--plain">
            {situations.map((s) => (
              <li key={s.text}>{w(s.text)}</li>
            ))}
          </ul>
        </div>
      )}
      {view.byHand && <ByHand commands={plan.manual} tool={tool} />}
      <ProgramFoldersOffer plan={plan} byHand={false} />
      <TerminalNoteView note={terminalNote(plan)} />
    </div>
  );
}

/** 1.176.1: a last run that ended for want of a command, in words. */
function EvidenceNote({ plan }: { plan: RepairPlan }) {
  const set = useSettings((s) => hasPathOverride(s.settings.shell.pathOverride));
  const line = evidenceLine(plan.block, set);
  return line ? <p className="ux-setup-text">{w(line)}</p> : null;
}

/** 1.176.1: the plan is about the Program folders setting — its row is one
 *  press away (the sheet closes, Settings opens on the row); with a step to
 *  add a folder, the by-hand way is said beside it. */
function ProgramFoldersOffer({ plan, byHand }: { plan: RepairPlan; byHand: boolean }) {
  if (!programFoldersOffered(plan)) return null;
  // 1.176.1 walk 2: no "Or empty Program folders…" when emptying them is
  // the step itself.
  byHand = byHand && programFoldersSituation(plan) !== null && !plan.steps.some((x) => x.kind === "emptyProgramFolders");
  const open = () => {
    useRepair.getState().dismiss();
    useUi.getState().openSettingsSection("editor-terminals", { row: "Program folders", focus: true });
  };
  return (
    <div>
      {byHand ? (
        <p className="ux-setup-note">{w(programFoldersByHand())}</p>
      ) : (
        // Walk 3: the button is never alone.
        <p className="ux-setup-note">{PROGRAM_FOLDERS_OFFER_LINE}</p>
      )}
      <CBtn size="sm" onClick={open}>
        {OPEN_PROGRAM_FOLDERS}
      </CBtn>
    </div>
  );
}

function ByHand({ commands, tool }: { commands: RepairManualCommand[]; tool: CliTool }) {
  if (commands.length === 0) return null;
  return (
    <div>
      <h3 className="ux-repair-head">By hand</h3>
      <ul className="ux-repair-list ux-repair-list--plain">
        {commands.map((c) => (
          <li key={`${c.purpose}-${c.command}`} className="ux-repair-command">
            <span>{w(manualWords(c, tool))}</span>
            <span className="ux-repair-command-row">
              <code>{c.command}</code>
              <CopyButton size="sm" text={c.command} announce="Command copied" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TerminalNoteView({ note }: { note: TerminalNote | null }) {
  if (!note) return null;
  return (
    <div>
      <p className="ux-setup-text">{w(note.text)}</p>
      {note.line && (
        <p className="ux-repair-command-row">
          <code>{note.line}</code>
          <CopyButton size="sm" text={note.line} announce="Line copied" />
        </p>
      )}
    </div>
  );
}

function EndPanel({
  plan,
  tool,
  repaired,
  items,
  version,
  output,
  removeNpm,
}: {
  plan: RepairPlan | null;
  tool: CliTool;
  repaired: boolean;
  items: RunItem[];
  version: string | null;
  output: { title: string; lines: string[] } | null;
  removeNpm: boolean;
}) {
  const block = plan?.block ? blockView(plan.block, tool) : null;
  const good = repaired || block?.fine === true;
  // 1.176.1 (review 1): a change to the setting is said, with the way back.
  const changedFolders = useRepair((s) => s.journal.some((e) => e.state === "done" && writesProgramFolders(e.kind)));
  // 1.176.1 walk: the tool starts, the setting still breaks other things.
  const short = stillShortLine(plan, tool, version);
  const needsChoice = plan?.block?.kind === "couldNotRepair" && plan.block.reason === "needsChoice";
  return (
    <div className="ux-repair">
      {repaired ? (
        <StatusLine state={short ? "aborted" : "done"}>{short ?? repairedLine(tool, version)}</StatusLine>
      ) : short ? (
        <StatusLine state="aborted">{short}</StatusLine>
      ) : (
        block && (
          <>
            <StatusLine state={block.fine ? "done" : "aborted"}>{block.title}</StatusLine>
            <p className="ux-setup-text">{w(block.text)}</p>
            {plan && <EvidenceNote plan={plan} />}
          </>
        )
      )}
      <RunList items={items} />
      {changedFolders && <p className="ux-setup-note">{w(PROGRAM_FOLDERS_CHANGED)}</p>}
      {!good && <p className="ux-setup-note">{w(END_NOTE(TOOL_NAME[tool]))}</p>}
      {needsChoice && plan && (
        <NpmChoice
          plan={plan}
          tool={tool}
          ticked={removeNpm}
          onChange={(on) => useRepair.getState().restart({ removeNpm: on })}
        />
      )}
      {plan && !good && block?.byHand && <ByHand commands={plan.manual} tool={tool} />}
      {plan && (!good || short) && <ProgramFoldersOffer plan={plan} byHand={false} />}
      {plan && <TerminalNoteView note={terminalNote(plan)} />}
      <OutputDetails output={good ? null : output} extra={null} />
      <ReopenOffer tool={tool} />
    </div>
  );
}

/** What closing means, before anything is pressed: each tile by project and
 *  name, the sessions Plyloft can't close and what to do about them. */
function SessionsDetail({ plan, tool }: { plan: RepairPlan; tool: CliTool }) {
  const step = plan.steps.find((s) => s.kind === "closeSessions");
  const sessions = step?.kind === "closeSessions" ? step.sessions : [];
  const chats = openTilesOf(tool).filter((t) => t.ptyId === null);
  const closable = [
    ...sessions.filter((x) => sessionClosable(x) === "tile").map((x) => ({ key: x.id, text: sessionWhat(x) })),
    ...chats.map((t) => ({ key: t.id, text: t.workspaceName ? `${t.workspaceName} · ${t.label}` : t.label })),
  ];
  const others = sessions.filter((x) => sessionClosable(x) === "cannot" && !(x.source === "codexAppServer" && chats.length > 0));
  return (
    <>
      {closable.length > 0 && (
        <>
          <ul className="ux-repair-list ux-repair-list--plain">
            {closable.map((c) => (
              <li key={c.key}>{c.text}</li>
            ))}
          </ul>
          <p className="ux-repair-removes">{w(sessionsNote(closable.length === 1 && others.length === 0))}</p>
        </>
      )}
      {others.map((x) => (
        <p key={x.id} className="ux-repair-removes">
          {`${sessionWhat(x)}: you. ${sessionWayOut(x) ?? ""}`}
        </p>
      ))}
    </>
  );
}
