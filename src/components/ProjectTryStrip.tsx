import { useState } from "react";
import { openWebLink } from "../ipc";
import {
  OTHER_WAY_SENTENCE,
  STOP_FAILED_SENTENCE,
  askWords,
  ranWords,
  tryRunKey,
  tryStatus,
  typedAddressProblem,
} from "../lib/tryPanel";
import { showTrySession } from "../lib/trySession";
import { loopbackUrl } from "../lib/tryAddress";
import { PROJECT_TRY_ID } from "../lib/tryTile";
import { platform } from "../lib/platform";
import { projectTryCard, tryInProjectLabel } from "../lib/tryProject";
import { useTryRuns } from "../store/tryRunStore";
import { useWorkspaces } from "../store/workspaceStore";
import { pushToast } from "../store/toastStore";
import { CBtn, Details, StateWord, TextField } from "./ux";
import { TryStartSheetHost } from "./TryItPanel";
import { linkDidNotOpen } from "../lib/linkToast";

/**
 * Try it TI-5 (docs/try-it/TRY_IT_SPEC.md §3.2): the project's own Try
 * session (Try it in <project>, after Ship), said at the top of Code's
 * localhost preview — what it asks first, *Starting your app…*, *Running on
 * localhost:N* · Stop · Show the session, or *Couldn't start* with the last
 * lines behind Details. TI-4's words. Drawn only while there is such a
 * session's run; the preview below it is the strip's own `BrowserPane`.
 */
export function ProjectTryStrip({ workspaceId }: { workspaceId: string }) {
  const key = tryRunKey(workspaceId, PROJECT_TRY_ID, null);
  const run = useTryRuns((s) => s.runs[key]);
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null);
  const [typed, setTyped] = useState("");
  if (!run || !ws) return null;
  const card = projectTryCard({ id: ws.id, name: ws.name, cwd: ws.cwd });
  const store = useTryRuns.getState();
  const status = tryStatus(run, platform(), "project");
  const sentence = run.phase === "ask" && run.ask ? askWords(run.ask).sentence : status.sentence;

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
    <CBtn tone="quiet" onClick={() => void store.stop(card, null)}>
      Stop
    </CBtn>
  );
  const tryAgain = (
    <CBtn tone="strong" onClick={() => void store.tryAgain(card, null)}>
      Try again
    </CBtn>
  );
  const url = run.address ? loopbackUrl(run.address) : null;
  const openInBrowser = url ? (
    <CBtn
      tone={run.secure ? "strong" : "quiet"}
      onClick={() =>
        void openWebLink(url).catch((e: unknown) =>
          pushToast(linkDidNotOpen(url, e)),
        )
      }
    >
      Open in browser
    </CBtn>
  ) : null;

  // The card panel's other way (spec §7): a PowerShell session that ended at
  // once, its command having a `.cmd` form.
  const otherWay =
    run.blocked === "quickExit" && run.cmdForm ? (
      <CBtn tone="quiet" onClick={() => void store.tryOtherWay(card, null)}>
        Try again the other way
      </CBtn>
    ) : null;
  const typedProblem = typedAddressProblem(typed);

  // The card panel's Change how it starts: the How to start your app sheet,
  // for the project folder (its host is below). Its Save and try starts the
  // new command; a later Try again reads it as saved.
  const changeHow = (
    <CBtn tone="quiet" onClick={() => void store.openSheet(card, null)}>
      Change how it starts
    </CBtn>
  );

  let actions = null;
  switch (run.phase) {
    case "ask":
      actions = run.ask ? (
        <CBtn tone="strong" onClick={() => void store.answer(card, null)}>
          {askWords(run.ask).action}
        </CBtn>
      ) : null;
      break;
    case "installing":
      break;
    case "starting":
      actions = (
        <>
          {stop}
          {showSession}
        </>
      );
      break;
    case "running":
      actions = (
        <>
          {run.secure && openInBrowser}
          {stop}
          {showSession}
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
      actions = (
        <>
          {tryAgain}
          {otherWay}
          {!run.installFailed && changeHow}
          {showSession}
        </>
      );
      break;
  }

  return (
    <section className="code-try-strip" aria-label={tryInProjectLabel(ws.name)} data-ply-project-try={run.phase}>
      <div className="code-try-strip-line">
        <p className="ux-try-status" aria-live="polite">
          <StateWord state={status.dot} live={status.live}>
            {status.word}
          </StateWord>
        </p>
        {actions && <div className="ux-card-section-actions">{actions}</div>}
      </div>
      {sentence && <p className="ux-card-muted">{sentence}</p>}
      {run.stopFailed && <p className="ux-card-muted">{STOP_FAILED_SENTENCE}</p>}
      {run.phase === "failed" && run.blocked === "quickExit" && run.cmdForm && (
        <p className="ux-card-muted">{OTHER_WAY_SENTENCE}</p>
      )}
      {run.phase === "failed" && run.blocked && run.cmdForm && <p className="ux-card-mono">{run.cmdForm}</p>}
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
              if (!typedAddressProblem(next)) store.useAddress(card, null, next);
            }}
          />
          <CBtn
            tone="strong"
            disabled={!typed.trim() || !!typedProblem}
            onClick={() => store.useAddress(card, null, typed)}
          >
            Show it
          </CBtn>
          {typedProblem && <p className="ux-card-muted">{typedProblem}</p>}
        </div>
      )}
      {run.phase === "failed" && (
        <Details open>
          {run.command && <p className="ux-card-muted">{ranWords(run, null, "project")}</p>}
          {run.lines.length > 0 ? (
            <pre className="ux-output">{run.lines.join("\n")}</pre>
          ) : (
            <p className="ux-card-muted">It printed nothing.</p>
          )}
        </Details>
      )}
      <TryStartSheetHost workspaceId={workspaceId} project />
    </section>
  );
}
