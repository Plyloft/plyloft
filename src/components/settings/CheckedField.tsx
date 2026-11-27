import { useEffect, useId, useRef, useState } from "react";
import { Callout, CBtn } from "../ux";
import { confirmChoice } from "../../store/confirmStore";
import { noteRowInUse } from "../../lib/rowInUse";
import {
  checkDecision,
  checkLine,
  checkNotice,
  savedAsLine,
  settingCheck,
  type CheckAction,
  type CheckContext,
  type CheckKind,
  type CheckNoticeModel,
  type Reading,
} from "../../lib/settingCheck";

/**
 * 1.176.1: the line under a checked settings field, the same for every one
 * of them (Program folders, the tile shell, the team clone folder, the
 * project's commands): a calm notice — the warning icon, no tinted box —
 * with its title, its plain sentences and one button per correction.
 */
export function CheckNotice<A extends { id: string; label: string }>({
  notice,
  onPress,
  id,
}: {
  notice: { title: string; lines: string[]; actions: A[] };
  onPress: (action: A) => void;
  /** From {@link useNoticeFocus}: the field's Tab and a "Fix" landing reach
   *  this notice's first offer. */
  id?: string;
}) {
  return (
    <Callout
      id={id}
      actionsBelow
      kind="warn"
      title={notice.title}
      text={notice.lines.join(" ")}
      actions={
        notice.actions.length > 0 ? (
          <>
            {notice.actions.map((a) => (
              <CBtn key={a.id} onClick={() => onPress(a)}>
                {a.label}
              </CBtn>
            ))}
          </>
        ) : undefined
      }
    />
  );
}

/**
 * 1.176.1 walk: a checked field's notice sits under its group, so the page's
 * own tab order went from the field to the next row and skipped the offers.
 * Tab from the field now goes to the notice's first offer while one shows
 * (also when the Tab's own save is what raised it), and a landing from a
 * "Fix" or "Open the setting" focuses that offer instead of the field
 * (`data-landing-focus-to`, read by the Row). Shift+Tab from the offer goes
 * back as the page has it. Returns the id to give the notice.
 */
export function useNoticeFocus(inputId: string, showing: boolean, raised = false): string {
  const noticeId = useId();
  // Walk 4: the notice is part of its field's row for a toast to keep off.
  useEffect(() => {
    if (showing) document.getElementById(noticeId)?.setAttribute("data-notice-for", inputId);
  });
  // 1.176.1 walk 2: a notice a save just raised (not one read when the page
  // opened) is brought into view: near a page's foot it was cut off.
  const wasRaised = useRef(false);
  useEffect(() => {
    if (raised && showing && !wasRaised.current) {
      document.getElementById(noticeId)?.scrollIntoView?.({ block: "nearest" });
    }
    wasRaised.current = raised && showing;
  }, [raised, showing, noticeId]);
  const tabbed = useRef(false);
  const showingRef = useRef(showing);
  showingRef.current = showing;
  const firstOffer = () => document.getElementById(noticeId)?.querySelector<HTMLElement>("button") ?? null;
  // The field names the first offer while the notice shows.
  useEffect(() => {
    const field = document.getElementById(inputId);
    if (!field) return;
    const offer = firstOffer();
    if (showing && offer) {
      if (!offer.id) offer.id = `${noticeId}-first`;
      field.setAttribute("data-landing-focus-to", offer.id);
    } else field.removeAttribute("data-landing-focus-to");
    if (showing && tabbed.current && offer) {
      tabbed.current = false;
      offer.focus();
    }
  });
  useEffect(() => {
    const field = document.getElementById(inputId);
    if (!field) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      tabbed.current = true;
      // The blur saves first; the offer, already there or raised by that
      // save, takes the focus right after.
      window.setTimeout(() => {
        const offer = firstOffer();
        if (offer && showingRef.current && tabbed.current) {
          tabbed.current = false;
          offer.focus();
        }
      }, 0);
      // A Tab that raises no notice leaves nothing pending.
      window.setTimeout(() => {
        tabbed.current = false;
      }, 1500);
    };
    field.addEventListener("keydown", onKey);
    return () => field.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputId, noticeId]);
  return noticeId;
}

const CHECK_FAILED = "Plyloft couldn't check this. Save it again in a moment.";

/**
 * A free-text field read by `setting_check` before its value can stop work:
 * on the person's save (blur, Enter) and when the page opens, never per
 * keystroke.
 *
 * - A typed value is saved as the reading stores it (`~` written out, quotes
 *   dropped) when nothing is wrong; asked about in the confirm sheet when it
 *   is unusual (its correction beside "Save it anyway"); not saved, with its
 *   corrections under the field, when it certainly can't work.
 * - The saved value is read too; when it can't work as written the notice
 *   says so and offers its corrections. Nothing changes without a press.
 * - A press that saves leaves the focus on the field.
 */
export function useCheckedField({
  kind,
  committed,
  commit,
  context,
}: {
  kind: CheckKind;
  /** What is saved now ("" for nothing). */
  committed: string;
  /** Save `value`; false when the save was refused. */
  commit: (value: string) => Promise<boolean>;
  context?: CheckContext;
}) {
  const [draft, setDraft] = useState(committed);
  const seen = useRef(committed);
  if (seen.current !== committed) {
    seen.current = committed;
    setDraft(committed);
  }
  const inputId = useId();
  const focusField = () => window.setTimeout(() => document.getElementById(inputId)?.focus(), 0);
  const [saved, setSaved] = useState<Reading | null>(null);
  const [pending, setPending] = useState<Reading | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Review 1: once after a save that stored something other than what was
  // typed (a `~` written out, quotes dropped), the line says what was saved;
  // the save's own Undo puts it back.
  const [savedAs, setSavedAs] = useState<string | null>(null);
  // Walk 3: a notice the save itself raised (the saved value's reading) is
  // brought into view like a refused value's.
  const [savedNow, setSavedNow] = useState(false);
  // The value whose reading waits for a press, and a counter that drops an
  // answer a later press has overtaken.
  const waiting = useRef<string | null>(null);
  const turn = useRef(0);
  const project = context?.project ?? null;
  const keepsTilde = context?.keepsTilde ?? false;
  const ctx: CheckContext = { project, keepsTilde };

  useEffect(() => {
    let live = true;
    setFailed(null);
    if (!committed.trim()) {
      setSaved(null);
      return;
    }
    settingCheck(kind, committed, { project, keepsTilde })
      .then((r) => live && setSaved(r))
      .catch(() => live && setFailed(CHECK_FAILED));
    return () => {
      live = false;
    };
  }, [kind, committed, project, keepsTilde]);

  const store = async (value: string, typed: string = value) => {
    noteRowInUse(inputId);
    turn.current++;
    waiting.current = null;
    setPending(null);
    setSavedAs(null);
    const ok = await commit(value);
    focusField();
    if (ok) {
      seen.current = value;
      setDraft(value);
      setSavedAs(savedAsLine(typed, value));
      setSavedNow(true);
    }
  };

  const keep = () => {
    setSavedAs(null);
    setSavedNow(false);
    turn.current++;
    waiting.current = null;
    setPending(null);
    setDraft(committed);
    focusField();
  };

  const ask = async (notice: CheckNoticeModel, my: number) => {
    const fix = notice.actions.find((a) => a.id === "fix");
    const anyway = notice.actions.find((a) => a.id === "anyway");
    const answer = await confirmChoice({
      title: notice.title,
      body: notice.lines.join(" "),
      confirmLabel: "Save it anyway",
      cancelLabel: "Keep what was there",
      altLabel: fix?.label,
      // 1.176.1 walk 2: one column; the safe answer is the one primary.
      stacked: true,
    });
    if (my !== turn.current) return;
    if (answer === "confirm" && anyway && "value" in anyway) await store(anyway.value, waiting.current ?? anyway.value);
    else if (answer === "alt" && fix) press(fix);
    else keep();
  };

  const onCommit = async (typed: string) => {
    if (typed === committed) {
      waiting.current = null;
      setPending(null);
      return;
    }
    if (!typed.trim()) {
      await store("");
      return;
    }
    if (typed === waiting.current) return;
    const my = ++turn.current;
    try {
      let r = await settingCheck(kind, typed, ctx);
      // The stored form (`~` written out) is what the decision reads.
      if (r.saveAs !== null && r.saveAs !== typed && r.saveAs !== "") r = await settingCheck(kind, r.saveAs, ctx);
      if (my !== turn.current) return;
      const decision = checkDecision(r);
      if (decision.kind === "save") {
        await store(decision.value, typed);
        return;
      }
      waiting.current = typed;
      if (decision.kind === "confirm") {
        const notice = checkNotice(r, true);
        if (notice) await ask(notice, my);
        return;
      }
      setPending(r);
    } catch {
      if (my === turn.current) setFailed(CHECK_FAILED);
    }
  };

  function press(a: CheckAction) {
    switch (a.id) {
      case "keep":
        keep();
        return;
      case "default":
        void store("");
        return;
      case "anyway":
        void store(a.value);
        return;
      case "fix":
        // A correction is read again like anything typed.
        setDraft(a.value);
        focusField();
        void onCommit(a.value);
        return;
      default: {
        const never: never = a;
        return never;
      }
    }
  }

  const notice = pending ? checkNotice(pending, true) : saved ? checkNotice(saved, false) : null;
  const noticeId = useNoticeFocus(inputId, notice !== null, pending !== null || savedNow);
  const line = failed ?? (pending ? null : savedAs) ?? (saved && !pending && !notice ? checkLine(saved) : null);
  return {
    inputId,
    draft,
    setDraft,
    onCommit: (v: string) => void onCommit(v),
    /** Esc: back to what is saved, while there is something to put back. */
    onCancel: draft === committed && !pending ? undefined : keep,
    /** The plain line under the field, or null. */
    line,
    /** The notice under the field, or null. */
    notice: notice ? <CheckNotice id={noticeId} notice={notice} onPress={press} /> : null,
  };
}

/**
 * 1.176.1: the line under a project command (Try it's, the one each card's
 * copy runs first). A command is never refused or asked about — it is the
 * project's, and a teammate's computer may have what this one lacks — so
 * this only reads: the saved value when the field appears, and each value the
 * person saves (`read`), never per keystroke. What it says is
 * "Plyloft can't find cargo …", before a card runs it.
 */
export function useCommandLine(
  kind: "command" | "script",
  saved: string,
  project: string | null,
  /** Typed into the person's own interactive shell (Try it). */
  interactive = false,
) {
  const [value, setValue] = useState(saved);
  const [reading, setReading] = useState<Reading | null>(null);
  // The saved value as the field first shows it, and whenever it changes by
  // other means than typing here (a Publish, another window).
  const first = useRef(saved);
  useEffect(() => {
    if (first.current !== saved) {
      first.current = saved;
      setValue(saved);
    }
  }, [saved]);
  useEffect(() => {
    let live = true;
    if (!value.trim()) {
      setReading(null);
      return;
    }
    settingCheck(kind, value, { project, interactive })
      .then((r) => live && setReading(r))
      .catch(() => live && setReading(null));
    return () => {
      live = false;
    };
  }, [kind, value, project, interactive]);
  return {
    /** Read `next`, the value just saved. */
    read: (next: string) => setValue(next),
    line: reading ? checkLine(reading) : null,
    reading,
  };
}
