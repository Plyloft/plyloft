import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import {
  CBtn,
  Group,
  Page,
  PageHeader,
  Row,
  RowValue,
  Section,
  Select,
  StatusLine,
  TextField,
  Toggle,
  TypeOrChoose,
  type SelectOption,
} from "../ux";
import {
  FLOW_PART,
  entryWords,
  isPartId,
  partAnchorId,
  pageWords,
  partById,
  type EntryId,
  type PartId,
  type Scope,
} from "../../lib/settingsNav";
import { forMachine } from "../ux/Page";
import { confirmUnknownModel } from "../../lib/unknownModelAsk";
import type { AgentVendor } from "../../lib/roleModels";
import { machineWords } from "../../lib/platform";
import { useSettingsFlow } from "../../store/settingsFlowStore";
import type { MacField } from "../../lib/settingsFields";
import type { MacSettings } from "./useMacSettings";
import { useSettings } from "../../store/settingsStore";

/**
 * UX language card 8 (GH #103): the shell every Settings page is built on,
 * and the four row shapes a This Mac field takes.
 *
 * A field's control reads the committed settings and writes through
 * {@link MacSettings.set}, which saves, says what changed and offers Undo. A
 * text field commits on blur or Enter (PATTERNS.md §5); a toggle and a choice
 * commit as they change, because there is nothing to finish typing.
 */

/**
 * UX-9.3: a page C9 merged into a fuller one (Board and Worktrees) is drawn as a *part* of it. Inside {@link MergedPage} (or {@link PartsOf}) a
 * `SettingsPage` is that part — its own heading, lede and status, then its
 * sections — and not a page with a header of its own. `flow` is the part whose
 * flow is up, if any: that part is drawn as the whole page and the others step
 * aside, because a flow is a focused surface (PATTERNS.md §6).
 */
const PartContext = createContext<{ flow: PartId | null } | null>(null);

export function SettingsPage({
  entry,
  scope,
  hiddenNote,
  title,
  lede,
  status,
  untitled = false,
  back,
  children,
}: {
  entry: EntryId | PartId;
  /** 1.174.0 (DS4): a sub-page's way back to the page it belongs to. */
  back?: { label: string; onClick: () => void };
  /** 1.174.0 (DS5): a part drawn inside a page as that page's own sections
   *  (General's board): no heading or lede of its own, unless its flow is up. */
  untitled?: boolean;
  scope: Scope;
  hiddenNote?: string | null;
  /** Overrides the navigation entry's label, for a page with a longer name. */
  title?: string;
  /** Overrides the entry's lede, where a board fixes other words. */
  lede?: ReactNode;
  /** Under the lede: what is true now. */
  status?: ReactNode;
  children: ReactNode;
}) {
  const part = useContext(PartContext);
  const words = pageWords(entry);
  // Nothing to say, no status area: an empty one would still take the 16 px
  // the sheet puts under the lede.
  const lines =
    hiddenNote || status ? (
      <>
        {hiddenNote && <StatusLine state="empty">{hiddenNote}</StatusLine>}
        {status}
      </>
    ) : undefined;
  if (part) {
    if (part.flow && part.flow !== entry) return null;
    if (part.flow === entry) {
      // The page around it has no header while a flow is up: this is it.
      return (
        <>
          <PageHeader
            scope={scope}
            title={title ?? words.label}
            lede={lede ?? words.lede}
            status={lines}
          />
          {children}
        </>
      );
    }
    // The page's header carries a link's note; the part says what is true of it.
    return (
      <div className="ux-part" id={isPartId(entry) ? partAnchorId(entry) : undefined}>
        {!untitled && <h2 className="ux-part-title">{machineWords(title ?? words.label)}</h2>}
        {!untitled && <p className="ux-part-lede">{forMachine(lede ?? words.lede)}</p>}
        {status && <div className="ux-part-status">{status}</div>}
        {children}
      </div>
    );
  }
  return (
    <Page>
      <PageHeader
        scope={scope}
        title={title ?? words.label}
        lede={lede ?? words.lede}
        status={lines}
        back={back}
      />
      {children}
    </Page>
  );
}

/** The part of `entry`'s page whose flow is up, or null. */
export function useEntryFlow(entry: EntryId): PartId | null {
  const flowId = useSettingsFlow((s) => s.flow);
  const owner = flowId ? FLOW_PART[flowId] : undefined;
  return owner && partById(owner).entry === entry ? owner : null;
}

/**
 * 1.174.0 (DS1): parts drawn inside a page that has a header of its own —
 * General draws the Board part under its rows (`RepositoryPage`'s `after`).
 * Each child is a `SettingsPage` of a part, drawn under its own heading, and
 * alone while its flow is up.
 */
export function PartsOf({ entry, children }: { entry: EntryId; children: ReactNode }) {
  const flow = useEntryFlow(entry);
  return <PartContext.Provider value={{ flow }}>{children}</PartContext.Provider>;
}

/**
 * UX-9.3: one entry's page made of the parts C9 merged into it, each a
 * `SettingsPage` of its own drawn under its own heading. The element tree is
 * the same whether a flow is up or not, so no part loses its state when one
 * opens or closes.
 */
export function MergedPage({
  entry,
  scope,
  hiddenNote,
  children,
}: {
  entry: EntryId;
  scope: Scope;
  hiddenNote?: string | null;
  children: ReactNode;
}) {
  const e = entryWords(entry);
  const flow = useEntryFlow(entry);
  return (
    <Page>
      {flow ? null : (
        <PageHeader
          scope={scope}
          title={e.label}
          lede={e.lede}
          status={hiddenNote ? <StatusLine state="empty">{hiddenNote}</StatusLine> : undefined}
        />
      )}
      <PartContext.Provider value={{ flow }}>{children}</PartContext.Provider>
    </Page>
  );
}

/** The page's last group (BOARDS.md §5: `Reset this page to defaults` —
 *  `Models, effort, auto-resume and retention go back to how Ply ships.`). */
export function ResetThisPage({
  mac,
  page,
  hint,
}: {
  mac: MacSettings;
  page: EntryId;
  hint: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Start again" scope="this-mac">
      <Group>
        <Row
          kind="procedure"
          label="Reset this page to defaults"
          hint={hint}
          action={
            <CBtn
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void mac.reset(page).finally(() => setBusy(false));
              }}
            >
              {busy ? "Resetting…" : "Reset"}
            </CBtn>
          }
        />
      </Group>
    </Section>
  );
}

export function ToggleRow({
  mac,
  field,
  label,
  hint,
}: {
  mac: MacSettings;
  field: MacField;
  label: string;
  hint: ReactNode;
}) {
  return (
    <Row kind="toggle" label={label} hint={hint}>
      <Toggle
        checked={mac.value(field) === true}
        onChange={(next) => void mac.set(field, next)}
      />
    </Row>
  );
}

export function ChoiceRow({
  mac,
  field,
  label,
  hint,
  options,
  mono = false,
}: {
  mac: MacSettings;
  field: MacField;
  label: string;
  hint: ReactNode;
  options: SelectOption[];
  mono?: boolean;
}) {
  return (
    <Row kind="choice" label={label} hint={hint}>
      <Select
        value={String(mac.value(field) ?? "")}
        options={options}
        mono={mono}
        onChange={(next) => void mac.set(field, next)}
      />
    </Row>
  );
}

/**
 * 1.176.2 re-walk: what a save's late `.then` may still write to the box. Only
 * the correction the field made to what was typed (`50,000` stored as 50000,
 * `10` as 500), and only if — read from the store now, not from a closure —
 * the stored value is still what this save produced and the box still holds
 * the text that was committed. After an Undo, or another change, or more
 * typing, it returns null and the render-phase sync (or the person's own
 * text) stands. A save that stored what was typed needs no correction.
 */
export function correctionAfterSave(field: MacField, typed: string, boxNow: string): string | null {
  if (boxNow !== typed) return null;
  const stored = useSettings.getState().settings;
  const now = String(field.read(stored) ?? "");
  if (now === typed) return null;
  if (String(field.read(field.write(stored, typed)) ?? "") !== now) return null;
  return now;
}

/** 1.176.2: the plain line under a field that refused what was typed. */
function RefusalLine({ children }: { children: ReactNode }) {
  return (
    <RowValue>
      <span role="alert">{children}</span>
    </RowValue>
  );
}

/**
 * A field you type in. It commits on blur and on Enter, never per keystroke:
 * a per-keystroke save would write `5` on the way to `5000` and put five
 * toasts on the screen.
 *
 * The box holds what was typed until then, and takes the saved value back
 * afterwards — so a value the field corrected (a scrollback below its floor)
 * is shown as it was really stored.
 */
export function TextRow({
  mac,
  field,
  label,
  hint,
  placeholder,
  mono = false,
  wide = false,
  inputMode,
  after,
}: {
  mac: MacSettings;
  field: MacField;
  label: string;
  hint: ReactNode;
  placeholder?: string;
  mono?: boolean;
  wide?: boolean;
  inputMode?: "numeric";
  /** Something beside the field (a probe's answer). */
  after?: ReactNode;
}) {
  const committed = String(mac.value(field) ?? "");
  const [draft, setDraft] = useState(committed);
  const [refusal, setRefusal] = useState<string | null>(null);
  const seen = useRef(committed);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const focused = useRef(false);
  // Derived state: the box follows the saved value whenever that changes
  // underneath it (a save, an Undo, another window). Done in render rather
  // than an effect so no frame ever shows the old text. Not under the
  // person's fingers: a focused box whose text isn't what it last saw keeps
  // it (1.176.2 re-walk).
  if (seen.current !== committed) {
    const typing = focused.current && draft !== seen.current;
    seen.current = committed;
    if (!typing) {
      setDraft(committed);
      if (refusal !== null) setRefusal(null);
    }
  }
  return (
    <Row kind="text" label={label} hint={hint}>
      <TextField
        value={draft}
        placeholder={placeholder}
        mono={mono}
        wide={wide}
        inputMode={inputMode}
        spellCheck={false}
        onFocus={() => {
          focused.current = true;
        }}
        onBlurCapture={() => {
          focused.current = false;
        }}
        onChange={setDraft}
        onCommit={(v) => {
          // 1.176.2: a value the field refuses stays in the box, with why.
          const refused = field.refuse?.(v) ?? null;
          setRefusal(refused);
          if (refused) return;
          // Review 1, finding 13: the field can correct what was typed —
          // a scrollback of `10` is stored as 500 — and when the correction
          // lands on the value already there, nothing in the committed state
          // changes and the box would keep showing `10`. So the box is put
          // back from what is really stored, every time.
          void mac.set(field, v).then((ok) => {
            // A refused write leaves what was typed where it is: the person
            // still has it, the error toast says what happened, and wiping the
            // box would lose the only copy (review 2, N4).
            if (!ok) return;
            const now = correctionAfterSave(field, v, draftRef.current);
            if (now === null) return;
            seen.current = now;
            setDraft(now);
          });
        }}
        // Esc puts back what is stored, before the modal takes the key. Only
        // while there is something to put back, so Esc still closes Settings
        // from a field nobody has touched.
        onCancel={
          draft === committed && refusal === null
            ? undefined
            : () => {
                setDraft(committed);
                setRefusal(null);
              }
        }
      />
      {refusal && <RefusalLine>{refusal}</RefusalLine>}
      {after}
    </Row>
  );
}

/**
 * A type-or-choose field bound to a settings field (SHEET.md "Type-or-choose
 * field"): the model rows of Builds & runs, and the tile shell.
 *
 * Like {@link TextRow} it holds what was typed until blur or Enter, and takes
 * the saved value back afterwards.
 */
export function ChooseField({
  mac,
  field,
  label,
  options,
  defaultLabel,
  footnote,
  placeholder,
  onSaved,
  knownModels,
  vendor,
}: {
  mac: MacSettings;
  field: MacField;
  label: string;
  /** 1.176.3: a model field — the names the app lists. A typed name outside
   *  them is asked about before it is saved, never refused. */
  knownModels?: readonly string[];
  vendor?: AgentVendor;
  options: readonly (string | { value: string; hint?: string })[];
  defaultLabel: string;
  footnote: string;
  placeholder?: string;
  /** Run after a save landed (a check that reads the saved value). */
  onSaved?: () => void;
}) {
  const committed = String(mac.value(field) ?? "");
  const [draft, setDraft] = useState(committed);
  const [refusal, setRefusal] = useState<string | null>(null);
  const seen = useRef(committed);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  if (seen.current !== committed) {
    seen.current = committed;
    setDraft(committed);
    if (refusal !== null) setRefusal(null);
  }
  return (
    <>
    <TypeOrChoose
      value={draft}
      onChange={setDraft}
      onCommit={(v) => {
        // 1.176.2: a value the field refuses stays in the box, with why.
        const refused = field.refuse?.(v) ?? null;
        setRefusal(refused);
        if (refused) return;
        // 1.176.3: blur and a pick both commit; one question per value.
        void confirmUnknownModel(v, {
          known: v.trim() === seen.current.trim() ? undefined : knownModels,
          vendor: vendor ?? "claude",
          where: label,
        }).then((fine) => {
          if (fine === null) return;
          // Anything but a yes: the box goes back, nothing is written.
          if (!fine) {
            setDraft(seen.current);
            return;
          }
          void mac.set(field, v).then((ok) => {
            if (!ok) return;
            const now = correctionAfterSave(field, v, draftRef.current);
            if (now !== null) {
              seen.current = now;
              setDraft(now);
            }
            onSaved?.();
          });
        });
      }}
      onCancel={
        draft === committed && refusal === null
          ? undefined
          : () => {
              setDraft(committed);
              setRefusal(null);
            }
      }
      options={options}
      defaultLabel={defaultLabel}
      footnote={footnote}
      label={label}
      placeholder={placeholder}
    />
    {refusal && <RefusalLine>{refusal}</RefusalLine>}
    </>
  );
}
