import { useEffect, useId, useRef, useState } from "react";
import { Group, Row, RowValue, TextField } from "../ux";
import { CheckNotice, useNoticeFocus } from "./CheckedField";
import { noteRowInUse } from "../../lib/rowInUse";
import type { MacSettings } from "./useMacSettings";
import { field } from "./fields";
import { isWindows } from "../../lib/platform";
import { confirmChoice } from "../../store/confirmStore";
import {
  findsLine,
  PROGRAM_FOLDERS_HINT_MAC,
  PROGRAM_FOLDERS_HINT_WINDOWS,
  foldersNotice,
  programFoldersCheck,
  saveDecision,
  type FolderAction,
  type FoldersNotice,
  type ProgramFoldersVerdict,
} from "../../lib/programFolders";

/**
 * 1.176.1: Settings › Editor and terminals › Program folders. The owner's
 * MacBook held `~/.local/bin/claude` there and nothing started; the row said
 * only "Claude is not on this PATH". Now a value is read before it is saved
 * (`program_folders_check`, on save and when the page opens, never per
 * keystroke): a `~` or a stray space is written out, a file is never saved as
 * is ("Use its folder"), a variable is offered as the explicit list (which
 * says it is a fixed copy), and a list that leaves the tools or the system
 * folders out is saved only after the confirm sheet names what won't be
 * found. When the shell already reports every folder the value adds,
 * emptying it comes first. Under the field: what the saved list finds and
 * doesn't. A saved value that can't work is named with its corrections,
 * never rewritten by itself.
 *
 * Review 1 (focus): an offer whose button goes away leaves the focus on the
 * field; a question is the product's confirm sheet, which traps and returns
 * the focus.
 */
const CHECK_FAILED = "Plyloft couldn't check these folders. Save them again in a moment.";

export function ProgramFoldersRow({ mac }: { mac: MacSettings }) {
  const pathField = field("shell.pathOverride");
  const committed = String(mac.value(pathField) ?? "");
  const [draft, setDraft] = useState(committed);
  const seen = useRef(committed);
  if (seen.current !== committed) {
    seen.current = committed;
    setDraft(committed);
  }
  const inputId = useId();
  const focusField = () => window.setTimeout(() => document.getElementById(inputId)?.focus(), 0);
  // The saved value's reading, and a typed one that waits for a press.
  const [saved, setSaved] = useState<ProgramFoldersVerdict | null>(null);
  const [pending, setPending] = useState<ProgramFoldersVerdict | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  // The value whose reading waits for a press, and a counter that drops an
  // answer a later press has overtaken (the field's blur commits as a
  // notice's button is pressed).
  const waiting = useRef<string | null>(null);
  const turn = useRef(0);

  useEffect(() => {
    let live = true;
    setFailed(null);
    if (!committed.trim()) {
      setSaved(null);
      return;
    }
    programFoldersCheck(committed)
      .then((v) => live && setSaved(v))
      .catch(() => live && setFailed(CHECK_FAILED));
    return () => {
      live = false;
    };
  }, [committed]);

  const store = async (value: string) => {
    // Walk 4: the toast this save raises keeps off this row and its notice.
    noteRowInUse(inputId);
    turn.current++;
    waiting.current = null;
    setPending(null);
    const ok = await mac.set(pathField, value);
    focusField();
    if (!ok) return;
    const now = String(mac.latest(pathField) ?? "");
    seen.current = now;
    setDraft(now);
    // Walk 3: the saved value's notice, if any, comes into view.
    setSavedNow(true);
  };

  const keep = () => {
    turn.current++;
    waiting.current = null;
    setPending(null);
    setDraft(committed);
    focusField();
  };

  /** The question before an unusual list is saved, in the confirm sheet:
   *  its best correction beside "Save it anyway". */
  const ask = async (notice: FoldersNotice, my: number) => {
    const fix = notice.actions.find((a) => a.id !== "anyway" && a.id !== "keep");
    const anyway = notice.actions.find((a) => a.id === "anyway");
    const answer = await confirmChoice({
      title: notice.title,
      body: notice.lines.join(" "),
      confirmLabel: "Save it anyway",
      cancelLabel: "Keep what was there",
      altLabel: fix?.label,
      // 1.176.1 walk: the safe answer is the one primary; one column, the
      // same width and right edge; "Save it anyway" plain.
      strongCancel: true,
      cautious: true,
      stacked: true,
    });
    if (my !== turn.current) return;
    if (answer === "confirm" && anyway && "value" in anyway) await store(anyway.value);
    else if (answer === "alt" && fix) press(fix);
    else keep();
  };

  const setFolders = async (typed: string) => {
    if (typed === committed) {
      waiting.current = null;
      setPending(null);
      return;
    }
    if (!typed.trim()) {
      await store("");
      return;
    }
    // Already waiting for a press about this very value.
    if (typed === waiting.current) return;
    const my = ++turn.current;
    try {
      let v = await programFoldersCheck(typed);
      // A `~` written out or an empty entry dropped: the stored form is
      // what is read for the decision.
      if (v.saveAs !== null && v.saveAs !== typed) v = await programFoldersCheck(v.saveAs);
      if (my !== turn.current) return;
      const decision = saveDecision(v);
      if (decision.kind === "save") {
        await store(decision.value);
        return;
      }
      waiting.current = typed;
      if (decision.kind === "confirm") {
        const notice = foldersNotice(v, true);
        if (notice) await ask(notice, my);
        return;
      }
      setPending(v);
    } catch {
      if (my === turn.current) setFailed(CHECK_FAILED);
    }
  };

  const press = (a: FolderAction) => {
    switch (a.id) {
      case "keep":
        keep();
        return;
      case "empty":
        void store("");
        return;
      case "anyway":
        void store(a.value);
        return;
      case "tidy":
        // The new value shown before it is saved.
        void confirmChoice({
          title: "Save Program folders like this?",
          body: "Plyloft saves the list as new tiles will get it:",
          items: [a.value],
          confirmLabel: a.label,
          cancelLabel: "Keep what was there",
        }).then((answer) => {
          if (answer === "confirm") void store(a.value);
          else focusField();
        });
        return;
      case "useFolders":
      case "expand":
      case "withShell":
        // A correction is read again like anything typed; the notice about
        // the old value goes (1.176.1 walk).
        setPending(null);
        setDraft(a.value);
        focusField();
        void setFolders(a.value);
        return;
      default: {
        const never: never = a;
        return never;
      }
    }
  };

  const notice = pending ? foldersNotice(pending, true) : saved ? foldersNotice(saved, false) : null;
  // 1.176.1 walk: Tab and a "Fix" landing reach the notice's first offer.
  const noticeId = useNoticeFocus(inputId, notice !== null, pending !== null || savedNow);
  // 1.176.1 walk 2: one statement of the problem — the notice's, when it
  // shows; the line under the field otherwise.
  const value = failed ?? (saved && !pending && !notice ? findsLine(saved) : null);

  return (
    <>
      <Group>
        <Row kind="text" label="Program folders" hint={isWindows() ? PROGRAM_FOLDERS_HINT_WINDOWS : PROGRAM_FOLDERS_HINT_MAC}>
          <TextField
            id={inputId}
            value={draft}
            // 1.176.1 walk: an example that passes the row's own check.
            placeholder={isWindows() ? "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32" : "/opt/homebrew/bin:/usr/bin:/bin"}
            mono
            wide
            spellCheck={false}
            onChange={(next) => {
              setDraft(next);
              // A notice about another value goes once the field changes.
              if (pending && next !== waiting.current) setPending(null);
            }}
            onCommit={(v) => void setFolders(v)}
            onCancel={draft === committed && !pending ? undefined : () => press({ id: "keep", label: "" })}
          />
          {value && (
            <RowValue>
              <span className="ux-row-value-lines">{value}</span>
            </RowValue>
          )}
        </Row>
      </Group>
      {notice && <CheckNotice id={noticeId} notice={notice} onPress={press} />}
    </>
  );
}
