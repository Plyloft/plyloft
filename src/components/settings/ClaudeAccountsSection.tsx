import { useEffect, useState } from "react";
import {
  CBtn,
  Group,
  MoreMenu,
  PChip,
  Row,
  Section,
  Sheet,
  StateWord,
  StatusLine,
  TextField,
  usePageReading,
  type MenuItem,
} from "../ux";
import { SetupTerminal } from "../SetupTerminal";
import {
  aiAccountAdd,
  aiAccountRemove,
  aiAccountRename,
  aiAccountShowFolder,
  aiAccountsList,
  aiAccountUseForNew,
  type ClaudeAccountRemoved,
  type ClaudeAccountRow,
} from "../../ipc";
import { useSetupRun } from "../../store/setupRunStore";
import { useClaudeAccounts } from "../../store/claudeAccountsStore";
import { platform } from "../../lib/platform";
import {
  ADD_BODY,
  ADD_BUTTON,
  ADD_CONFIRM,
  ADD_NOTE,
  ADD_TITLE,
  CURRENT_MARK,
  MAIN_DETAIL,
  MENU,
  NAME_PLACEHOLDER,
  REMOVE_BODY,
  REMOVE_ONLY,
  REMOVE_SIGN_OUT,
  RENAME_CONFIRM,
  SECTION_TITLE,
  introLine,
  refusal,
  removeTitle,
  removedLine,
  renameTitle,
  replaceRow,
  rowActions,
  signInEnd,
  signInTitle,
  stateDot,
  stateWords,
} from "../../lib/claudeAccounts";

/** What the section has open over it. */
type Open =
  | { kind: "add" }
  | { kind: "rename"; row: ClaudeAccountRow }
  | { kind: "sign-in"; id: string; name: string; runId: string | null }
  | { kind: "remove"; row: ClaudeAccountRow & { id: string } };

/** A section sentence that names an account: drawn as it is (a fragment),
 *  so the name is never turned into another machine's word. */
type Notice = { state: "done" | "aborted"; text: string };

const keyOf = (row: ClaudeAccountRow) => row.id ?? "main";

/**
 * 1.179.0 (C1): Settings › AI and models › Claude accounts, above Models.
 * One row per Claude account, Main first, with its state, the New sessions
 * mark on the one new sessions start on, and a ⋯ of what can be done to it;
 * Add a Claude account… under them.
 *
 * Rust owns everything here (`ai_accounts.rs`): the rows, the names' rules
 * and their refusals, shown as it returns them. An account is named by its
 * id only; its folder is opened by Rust (Show folder), and its sign-in and
 * sign-out are Setup's own guided terminal (`login-account.claude`,
 * `logout-account.claude`): Claude's own login in the browser, nothing typed
 * by Plyloft. With only Main the section is that one quiet row and the button.
 */
export function ClaudeAccountsSection() {
  const [rows, setRows] = useState<ClaudeAccountRow[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readAgain, setReadAgain] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  usePageReading(rows === null && readError === null);

  useEffect(() => {
    let live = true;
    aiAccountsList()
      .then((list) => {
        if (!live) return;
        setReadError(null);
        setRows(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (live) setReadError(refusal(e));
      });
    return () => {
      live = false;
    };
  }, [readAgain]);

  // 1.179.0 (C2): the tiles, cards and lists that name an account read
  // the rows this section has, after every change it makes.
  useEffect(() => {
    if (rows) useClaudeAccounts.getState().setRows(rows);
  }, [rows]);

  const refresh = () => setReadAgain((n) => n + 1);

  /** Setup's sign-in for one account, in the guided terminal. One run at a
   *  time is Rust's rule: a refusal comes back as the store's `error`, which
   *  the terminal shows. */
  async function signIn(id: string, name: string) {
    setNotice(null);
    setOpen({ kind: "sign-in", id, name, runId: null });
    const run = await useSetupRun.getState().start("login-account.claude", { account: id });
    setOpen((cur) => (cur?.kind === "sign-in" && cur.id === id ? { ...cur, runId: run?.runId ?? null } : cur));
  }

  async function act(work: () => Promise<void>) {
    setNotice(null);
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setNotice({ state: "aborted", text: refusal(e) });
    } finally {
      setBusy(false);
    }
  }

  function menuFor(row: ClaudeAccountRow): MenuItem[] {
    return rowActions(row).map((action): MenuItem => {
      switch (action) {
        case "use":
          return {
            label: MENU.use,
            onSelect: () => void act(async () => setRows(await aiAccountUseForNew(row.id))),
          };
        case "rename":
          return { label: MENU.rename, onSelect: () => setOpen({ kind: "rename", row }) };
        case "signIn":
          return { label: MENU.signIn, onSelect: () => void signIn(row.id!, row.name) };
        case "show":
          return {
            label: MENU.show,
            // Main's home that couldn't be told has no folder to show.
            disabled: row.folder === null,
            onSelect: () => void act(async () => void (await aiAccountShowFolder(row.id))),
          };
        case "remove":
          return {
            label: MENU.remove,
            danger: true,
            onSelect: () => setOpen({ kind: "remove", row: { ...row, id: row.id! } }),
          };
      }
    });
  }

  function removed(result: ClaudeAccountRemoved, id: string) {
    setOpen(null);
    setRows((cur) => cur?.filter((r) => r.id !== id) ?? cur);
    // Only when Claude's login for it is still saved here ("unknown" says
    // nothing either way).
    if (result.loginLeft === "yes") setNotice({ state: "done", text: removedLine(result.name, platform()) });
    refresh();
  }

  return (
    <Section title={SECTION_TITLE} scope="this-mac">
      <p className="ux-section-note">{introLine(platform())}</p>
      {rows === null && readError === null && <StatusLine state="running">Looking…</StatusLine>}
      {readError !== null && (
        <>
          <StatusLine state="aborted">{readError}</StatusLine>
          <div className="ux-section-note-action">
            <CBtn
              tone="quiet"
              onClick={() => {
                setReadError(null);
                setRows(null);
                refresh();
              }}
            >
              Read it again
            </CBtn>
          </div>
        </>
      )}
      {rows !== null && rows.length > 0 && (
        <Group label={SECTION_TITLE}>
          {/* Settings search lands on the section by the row of Main, which is always there whatever it is called (findAs). */}
          {rows.map((account) => (
            <Row
              key={keyOf(account)}
              kind="value"
              label={account.name}
              findAs={account.id === null ? SECTION_TITLE : undefined}
              hint={account.id === null ? MAIN_DETAIL : undefined}
              chips={account.isCurrent ? <PChip>{CURRENT_MARK}</PChip> : undefined}
              more={<MoreMenu items={menuFor(account)} disabled={busy} />}
            >
              <StateWord state={stateDot(account.signedIn)}>{stateWords(account.signedIn)}</StateWord>
            </Row>
          ))}
        </Group>
      )}
      {notice && <StatusLine state={notice.state}>{<>{notice.text}</>}</StatusLine>}
      {readError === null && (
        <div className="ux-section-note-action">
          <CBtn
            disabled={rows === null}
            onClick={() => {
              setNotice(null);
              setOpen({ kind: "add" });
            }}
          >
            {ADD_BUTTON}
          </CBtn>
        </div>
      )}

      {open?.kind === "add" && (
        <AddSheet
          onClose={() => setOpen(null)}
          onAdded={(row) => {
            setRows((cur) => (cur ? [...cur.filter((r) => r.id !== row.id), row] : [row]));
            void signIn(row.id!, row.name);
          }}
        />
      )}
      {open?.kind === "rename" && (
        <RenameSheet
          row={open.row}
          onClose={() => setOpen(null)}
          onRenamed={(row) => {
            setRows((cur) => (cur ? replaceRow(cur, row) : cur));
            setOpen(null);
          }}
        />
      )}
      {open?.kind === "sign-in" && (
        <SignInSheet
          name={open.name}
          runId={open.runId}
          onAgain={() => void signIn(open.id, open.name)}
          onEnded={refresh}
          onClose={() => {
            useSetupRun.getState().clear();
            setOpen(null);
          }}
        />
      )}
      {open?.kind === "remove" && (
        <RemoveSheet row={open.row} onClose={() => setOpen(null)} onRemoved={(r) => removed(r, open.row.id)} />
      )}
    </Section>
  );
}

/** Add a Claude account: a name, then the folder and Claude's sign-in. */
function AddSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (row: ClaudeAccountRow) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await aiAccountAdd(name);
      onAdded(row);
    } catch (e) {
      // The name's refusal, as Rust words it ("You already have an account
      // named Work.").
      setError(refusal(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      size="confirm"
      title={ADD_TITLE}
      lede={ADD_BODY}
      onClose={onClose}
      canDismiss={!busy}
      actions={
        <>
          <CBtn tone="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </CBtn>
          <CBtn tone="accent" onClick={() => void add()} disabled={busy}>
            {ADD_CONFIRM}
          </CBtn>
        </>
      }
    >
      <Group>
        <Row kind="text" label="Name" error={error ?? undefined}>
          <TextField
            value={name}
            onChange={setName}
            onEnter={() => void add()}
            placeholder={NAME_PLACEHOLDER}
            disabled={busy}
            error={error !== null}
            autoFocus
          />
        </Row>
      </Group>
      <p className="ux-section-note">{ADD_NOTE}</p>
    </Sheet>
  );
}

/** Rename an account, Main included (`id` null). */
function RenameSheet({
  row,
  onClose,
  onRenamed,
}: {
  row: ClaudeAccountRow;
  onClose: () => void;
  onRenamed: (row: ClaudeAccountRow) => void;
}) {
  const [name, setName] = useState(row.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onRenamed(await aiAccountRename(row.id, name));
    } catch (e) {
      setError(refusal(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      size="confirm"
      asIs
      title={renameTitle(row.name)}
      onClose={onClose}
      canDismiss={!busy}
      actions={
        <>
          <CBtn tone="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </CBtn>
          <CBtn tone="accent" onClick={() => void rename()} disabled={busy}>
            {RENAME_CONFIRM}
          </CBtn>
        </>
      }
    >
      <Group>
        <Row kind="text" label="Name" error={error ?? undefined}>
          <TextField
            value={name}
            onChange={setName}
            onEnter={() => void rename()}
            disabled={busy}
            error={error !== null}
            autoFocus
          />
        </Row>
      </Group>
    </Sheet>
  );
}

/** Setup's guided terminal running Claude's own sign-in for one account. */
function SignInSheet({
  name,
  runId,
  onAgain,
  onEnded,
  onClose,
}: {
  name: string;
  /** The run this sheet started; null until `setup_run` answers, or when it
   *  was refused (the terminal then shows why). */
  runId: string | null;
  onAgain: () => void;
  onEnded: () => void;
  onClose: () => void;
}) {
  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const outcome = useSetupRun((s) => s.outcome);
  const refused = useSetupRun((s) => s.error);
  const mine = runId !== null && run?.runId === runId && run.actionId === "login-account.claude";
  const running = mine && phase !== "done";
  // Before `setup_run` answers nothing can be closed or tried again; a
  // refused start (another step running, claude not installed) can.
  const starting = runId === null && refused === null;
  const ended = mine && phase === "done";

  // The row's state is read again once the run has ended, however it ended.
  useEffect(() => {
    if (ended) onEnded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, runId]);

  return (
    <Sheet
      asIs
      title={signInTitle(name)}
      onClose={onClose}
      canDismiss={!running && !starting}
      actions={
        running || starting ? undefined : (
          <>
            {!(ended && outcome === "succeeded") && <CBtn onClick={onAgain}>Try again</CBtn>}
            <CBtn tone={ended && outcome === "succeeded" ? "accent" : undefined} onClick={onClose}>
              Close
            </CBtn>
          </>
        )
      }
    >
      <SetupTerminal focus line={mine ? signInEnd(name, phase, outcome) : null} />
    </Sheet>
  );
}

/** Remove an account: Claude's own sign-out first, or not. */
function RemoveSheet({
  row,
  onClose,
  onRemoved,
}: {
  row: ClaudeAccountRow & { id: string };
  onClose: () => void;
  onRemoved: (result: ClaudeAccountRemoved) => void;
}) {
  const [step, setStep] = useState<"ask" | "signing-out" | "removing">("ask");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const signedOut = step === "signing-out" && runId !== null && run?.runId === runId && phase === "done";

  async function remove(signOut: boolean) {
    setStep("removing");
    setError(null);
    try {
      onRemoved(await aiAccountRemove(row.id, signOut));
    } catch (e) {
      // "Close 2 sessions running on Work first.", or a folder that
      // couldn't be deleted: the account stays listed.
      setError(refusal(e));
      setStep("ask");
    }
  }

  async function signOutAndRemove() {
    setError(null);
    setStep("signing-out");
    const started = await useSetupRun.getState().start("logout-account.claude", { account: row.id });
    if (!started) {
      setError(useSetupRun.getState().error);
      setStep("ask");
      return;
    }
    setRunId(started.runId);
  }

  // The sign-out's end, whatever it was, then the removal: Claude's login
  // that is still saved is said after it (`loginLeft`).
  useEffect(() => {
    if (!signedOut) return;
    useSetupRun.getState().clear();
    void remove(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedOut]);

  const asking = step === "ask";
  return (
    <Sheet
      size="confirm"
      asIs
      title={removeTitle(row.name)}
      lede={REMOVE_BODY}
      onClose={onClose}
      canDismiss={asking}
      actions={
        <>
          <CBtn tone="quiet" onClick={onClose} disabled={!asking}>
            Cancel
          </CBtn>
          <CBtn onClick={() => void remove(false)} disabled={!asking}>
            {REMOVE_ONLY}
          </CBtn>
          <CBtn tone="danger" onClick={() => void signOutAndRemove()} disabled={!asking}>
            {REMOVE_SIGN_OUT}
          </CBtn>
        </>
      }
    >
      {step === "signing-out" && runId !== null && (
        <SetupTerminal quiet />
      )}
      {error && <StatusLine state="aborted">{<>{error}</>}</StatusLine>}
    </Sheet>
  );
}
