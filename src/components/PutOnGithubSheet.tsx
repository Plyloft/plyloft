// 1.175.0 F3 (review UX-1; owner I5): the consent sheet of "Put it on
// GitHub…" (`mockups/on-github.html` §2, §2b). Nothing runs before the
// press; the focus is on Cancel; the account, the name, private and what
// is sent are said. The card, Settings › Cards › Shipping and Add a project
// open it (`openPutOnGithub`). The work is `put_on_github.rs`.
import { useEffect, useRef, useState } from "react";
import { CBtn, Properties, Sheet, TextField } from "./ux";
import { machineWords } from "../lib/platform";
import {
  doneToast,
  addCopyFailedToast,
  addSheetWords,
  CONNECT_GITHUB_FIRST,
  outcomeWords,
  PUT_ON_GITHUB,
  putOnGithubNote,
  runningWords,
  sheetWords,
  type Outcome,
  type Preview,
  type Progress,
} from "../lib/putOnGithub";
import {
  onPutOnGithubProgress,
  putOnGithub,
  putOnGithubPreview,
  putOnGithubSendAgain,
  putOnGithubStop,
} from "../lib/putOnGithubIpc";
import { openWebLink, setupGithubStatus } from "../ipc";
import { pushToast } from "../store/toastStore";
import { useSetup } from "../store/setupStore";
import { useGithubStatus } from "../store/githubStatusStore";
import {
  forgetJustPut,
  openPutOnGithub,
  putDone,
  usePutOnGithub,
  usePutOnGithubCount,
  type PutOnGithubAsked,
} from "../store/putOnGithubStore";
import { linkDidNotOpen } from "../lib/linkToast";

type Asked = PutOnGithubAsked;
export { forgetJustPut, openPutOnGithub, usePutOnGithubCount };

/** Settings › Cards › Shipping: the project has no remote at all, so
 *  "Put it on GitHub…" is offered (`onGitHub` false also covers a project
 *  on another host, which the preview refuses). null while read. */
export function useOnlyHere(workspaceId: string, onGitHub: boolean | null): boolean | null {
  const putCount = usePutOnGithubCount(workspaceId);
  const [answer, setAnswer] = useState<{ id: string; on: boolean } | null>(null);
  useEffect(() => {
    if (onGitHub !== false) return;
    let live = true;
    putOnGithubPreview(workspaceId)
      .then(() => live && setAnswer({ id: workspaceId, on: true }))
      .catch(() => live && setAnswer({ id: workspaceId, on: false }));
    return () => {
      live = false;
    };
  }, [workspaceId, onGitHub, putCount]);
  if (onGitHub !== false) return false;
  return answer?.id === workspaceId ? answer.on : null;
}

/** Shipping's press beside "How Ship it ships", on a project only here:
 *  its label and what it does (GitHub not connected: Setup's GitHub step). */
export function usePutOnGithubPress(workspaceId: string, project: string): { label: string; onPress: () => void } {
  const status = useGithubStatus((s) => s.status);
  const refresh = useGithubStatus((s) => s.refresh);
  useEffect(() => {
    if (!status) void refresh();
  }, [status, refresh]);
  const connected = !!status?.accounts?.some((a) => a.active && a.state === "signed-in");
  return connected
    ? { label: PUT_ON_GITHUB, onPress: () => openPutOnGithub({ workspaceId, project }) }
    : { label: CONNECT_GITHUB_FIRST, onPress: connectGithubFirst };
}

/** The card's line under Ship it on a card Ready to ship (Now's `note`):
 *  F3's case first (`putOnGithubNote`), else the words the result gave
 *  (another host, an unreadable address). F8's `nowNote.ts` takes this
 *  over when it lands. */
export function CardShipNote({
  workspaceId,
  project,
  words,
  noRemote,
}: {
  workspaceId: string;
  project: string;
  words: string | null | undefined;
  noRemote: boolean;
}) {
  const justPut = usePutOnGithub((s) => s.justPut[workspaceId] ?? null);
  const status = useGithubStatus((s) => s.status);
  const refresh = useGithubStatus((s) => s.refresh);
  useEffect(() => {
    if (noRemote && !status) void refresh();
  }, [noRemote, status, refresh]);
  const githubConnected = !!status?.accounts?.some((a) => a.active && a.state === "signed-in");
  const note = putOnGithubNote({ noRemote, githubConnected, justPut });
  const text = note?.text ?? words;
  if (!text) return null;
  return (
    <>
      <p className="ux-card-muted" data-ply-no-remote="now">
        {machineWords(text)}
      </p>
      {note?.action && (
        <div className="ux-card-section-actions">
          <CBtn
            data-ply-put-on-github=""
            onClick={
              note.action === PUT_ON_GITHUB ? () => openPutOnGithub({ workspaceId, project }) : connectGithubFirst
            }
          >
            {note.action}
          </CBtn>
        </div>
      )}
    </>
  );
}

/** "Connect GitHub first": Setup's GitHub step. */
export function connectGithubFirst() {
  useSetup.getState().openSetup("rerun", "github");
}

/** The one host, in the app: draws the sheet while one is asked. */
export function PutOnGithubHost() {
  const asked = usePutOnGithub((s) => s.asked);
  if (!asked) return null;
  return <PutOnGithubSheet {...asked} onClose={() => usePutOnGithub.setState({ asked: null })} />;
}

type Phase =
  | { kind: "reading" }
  | { kind: "ask"; preview: Preview }
  | { kind: "running"; progress: Progress | null }
  | { kind: "after"; outcome: Outcome }
  | { kind: "unavailable"; words: string };

export function PutOnGithubSheet({ workspaceId, project, onDone, start, onClose }: Asked & { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });
  const [login, setLogin] = useState<string | null>(null);
  const [name, setName] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);
  const read = useRef<Preview | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([putOnGithubPreview(workspaceId), setupGithubStatus(false)])
      .then(([preview, status]) => {
        if (!alive) return;
        const account = status.accounts?.find((a) => a.active && a.state === "signed-in") ?? null;
        setLogin(start?.login ?? account?.login ?? null);
        setName(start?.name ?? preview.name);
        read.current = preview;
        setPhase({ kind: "ask", preview });
        // Add a project's ticked copy: pressed in Add's own sheet.
        if (start && !started.current) {
          started.current = true;
          void run(start.login, start.name);
        }
      })
      .catch((e) => {
        if (!alive) return;
        if (start) {
          const t = addCopyFailedToast(project);
          pushToast({ kind: "error", title: t.title, body: t.body, details: String((e as Error)?.message ?? e) });
          onClose();
          return;
        }
        setPhase({ kind: "unavailable", words: String((e as Error)?.message ?? e) });
      });
    const off = onPutOnGithubProgress((p) => {
      if (p.workspaceId === workspaceId) setPhase({ kind: "running", progress: p });
    });
    return () => {
      alive = false;
      void off.then((f) => f());
    };
  }, [workspaceId]);

  function finish(outcome: Outcome) {
    if (outcome.kind === "done") {
      const t = doneToast(project, outcome.repo);
      pushToast({
        kind: "info",
        title: t.title,
        body: t.body,
        action: {
          label: t.action,
          onClick: () => {
            const url = `https://github.com/${outcome.repo}`;
            void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
          },
        },
      });
      putDone(workspaceId, outcome.repo);
      onDone?.(outcome.repo);
      onClose();
      return;
    }
    setPhase({ kind: "after", outcome });
  }

  async function press() {
    if (!login) return;
    await run(login, name.trim());
  }

  async function run(as: string, called: string) {
    setPhase({ kind: "running", progress: null });
    try {
      finish(await putOnGithub(workspaceId, as, called));
    } catch (e) {
      finish({ kind: "notCreated", words: String((e as Error)?.message ?? e), large: null, signIn: false });
    }
  }

  async function sendAgain() {
    setPhase({ kind: "running", progress: null });
    try {
      finish(await putOnGithubSendAgain(workspaceId, login));
    } catch (e) {
      finish({ kind: "notCreated", words: String((e as Error)?.message ?? e), large: null, signIn: false });
    }
  }

  if (phase.kind === "reading") {
    return <Sheet title={machineWords(`Put “${project}” on GitHub?`)} size="confirm" onClose={onClose} asIs />;
  }
  if (phase.kind === "unavailable") {
    return (
      <Sheet
        title={machineWords("The project wasn't put on GitHub.")}
        lede={machineWords(phase.words)}
        size="confirm"
        onClose={onClose}
        asIs
        actions={<CBtn onClick={onClose}>Close</CBtn>}
      />
    );
  }
  if (phase.kind === "running") {
    const words = phase.progress ? runningWords(phase.progress) : null;
    return (
      <Sheet
        title={machineWords(`Put “${project}” on GitHub?`)}
        size="confirm"
        onClose={onClose}
        canDismiss={false}
        asIs
        actions={
          <CBtn onClick={() => void putOnGithubStop(workspaceId)} disabled={!phase.progress}>
            Stop
          </CBtn>
        }
      >
        {words ? (
          <>
            <p className="ux-sheet-lede">{machineWords(words.created)}</p>
            <p className="ux-sheet-hint" aria-live="polite">
              {machineWords(words.sending)}
            </p>
          </>
        ) : (
          <p className="ux-sheet-hint" aria-live="polite">
            {machineWords("Creating the private repository on GitHub…")}
          </p>
        )}
      </Sheet>
    );
  }
  if (phase.kind === "after") {
    const words = outcomeWords(phase.outcome)!;
    return (
      <Sheet
        title={machineWords(words.title)}
        size="confirm"
        onClose={onClose}
        asIs
        actions={
          <>
            <CBtn ref={cancelRef} onClick={onClose}>
              Close
            </CBtn>
            {words.signIn && <CBtn onClick={connectGithubFirst}>Sign in to GitHub</CBtn>}
            {words.again && (
              <CBtn
                onClick={() =>
                  words.again!.id === "send"
                    ? void sendAgain()
                    : read.current && setPhase({ kind: "ask", preview: read.current })
                }
              >
                {words.again.label}
              </CBtn>
            )}
          </>
        }
      >
        {words.lines.map((line) => (
          <p key={line} className="ux-sheet-lede">
            {machineWords(line)}
          </p>
        ))}
      </Sheet>
    );
  }
  // Asking.
  if (!login) {
    return (
      <Sheet
        title={machineWords(`Put “${project}” on GitHub?`)}
        lede={machineWords("Connect GitHub first: Plyloft makes the repository in your GitHub account.")}
        size="confirm"
        onClose={onClose}
        asIs
        initialFocusRef={cancelRef}
        actions={
          <>
            <CBtn ref={cancelRef} onClick={onClose}>
              Cancel
            </CBtn>
            <CBtn onClick={connectGithubFirst}>Connect GitHub first</CBtn>
          </>
        }
      />
    );
  }
  const words = sheetWords(project, login, name || phase.preview.name, phase.preview);
  return (
    <Sheet
      title={machineWords(words.title)}
      lede={machineWords(words.lede)}
      size="confirm"
      onClose={onClose}
      asIs
      initialFocusRef={cancelRef}
      actions={
        <>
          <CBtn ref={cancelRef} onClick={onClose}>
            {words.cancel}
          </CBtn>
          <CBtn tone="accent" disabled={!name.trim()} onClick={() => void press()}>
            {words.confirm}
          </CBtn>
        </>
      }
    >
      <Properties
        items={words.rows.map((row) => ({
          label: row.label,
          wide: row.id === "name",
          value:
            row.id === "name" ? (
              <>
                <TextField label="Name on GitHub" value={name} onChange={setName} mono />
                <span className="ux-sheet-hint">{`github.com/${login}/${name.trim()}`}</span>
              </>
            ) : (
              machineWords(row.value)
            ),
        }))}
      />
    </Sheet>
  );
}

/** Add a project › A folder, with "Also keep a private copy on GitHub"
 *  ticked: Add asks first (focus on Cancel). Its press adds the project,
 *  then the copy runs in `PutOnGithubSheet` (`start`). */
export function AddAndPutOnGithubSheet({
  project,
  line,
  busy,
  onCancel,
  onConfirm,
}: {
  project: string;
  /** The tick's line: the repository and the branch sent. */
  line: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const words = addSheetWords(project);
  return (
    <Sheet
      title={words.title}
      lede={words.lede}
      size="confirm"
      onClose={onCancel}
      initialFocusRef={cancelRef}
      actions={
        <>
          <CBtn ref={cancelRef} onClick={onCancel}>
            {words.cancel}
          </CBtn>
          <CBtn tone="accent" disabled={busy} onClick={onConfirm}>
            {words.confirm}
          </CBtn>
        </>
      }
    >
      <p className="ux-sheet-lede">{machineWords(line)}</p>
    </Sheet>
  );
}
