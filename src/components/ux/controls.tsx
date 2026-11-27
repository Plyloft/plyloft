import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { useRowState } from "./Row";
import { effectiveDisabled } from "../../lib/uxRow";
import { noteBlurredField } from "../../lib/rowInUse";
import { useEscapeFirst } from "./useEscapeFirst";
import { MenuList, useDismiss, type MenuItem } from "./MoreMenu";
import { Icon } from "./Icon";
import { isMac, machineWords } from "../../lib/platform";

// The page controls at the sheet's measures (SHEET.md "Toggle", "Fields"):
// rest · hover · keyboard focus · pressed · disabled, and for fields error
// and read-only. Inside a Row they take its label, hint and state.

/** Read-only: no box, the value only. */
function ReadOnlyValue({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={mono ? "ux-readonly-value ux-readonly-value--mono" : "ux-readonly-value"}>
      {children}
    </span>
  );
}

/**
 * A button that opens the system's file picker and hands back the chosen
 * `File`s (their bytes are the page's to read, as a drop's are). Card chat:
 * "Add files…", the same path as a drop. The file input is the browser's own
 * picker, hidden; the button is the layer's.
 */
export function FilePickButton({
  children,
  onFiles,
  disabled,
  title,
  multiple = true,
  accept,
}: {
  children: ReactNode;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  title?: string;
  multiple?: boolean;
  accept?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="cbtn cbtn--quiet"
        disabled={disabled}
        title={title}
        onClick={() => input.current?.click()}
      >
        {children}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        multiple={multiple}
        accept={accept}
        data-ply-file-pick=""
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          // The same file can be picked again next time.
          e.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  overruled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Needed only outside a Row; inside one the row's label names it. */
  label?: string;
  /** Still live, drawn quieter: a level above decides here (the row's hint
   *  says which). Skills hub H9, a Plyloft row's own-Mac switch. */
  overruled?: boolean;
}) {
  const row = useRowState();
  if (row?.readOnly) return <ReadOnlyValue>{checked ? "On" : "Off"}</ReadOnlyValue>;
  const off = effectiveDisabled(disabled, row?.disabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={label ? undefined : row?.labelId}
      aria-describedby={row?.hintId}
      disabled={off}
      className={["ux-toggle", row?.changed ? "ux-toggle--changed" : "", overruled ? "ux-toggle--overruled" : ""]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span className="ux-toggle-knob" aria-hidden />
    </button>
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

/** Keys that move through an open select pop-up (or find an option). */
const SELECT_NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** How long a select's pop-up mark lasts without a sign it closed. */
const SELECT_POPUP_MARK_MS = 15_000;

export function Select({
  value,
  onChange,
  options,
  mono = false,
  error,
  disabled,
  label,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "className"> & {
  value: string;
  onChange: (next: string) => void;
  options: SelectOption[];
  mono?: boolean;
  error?: boolean;
  label?: string;
}) {
  const row = useRowState();
  // Walk 2026-10-23 (also on 1.168.1): Esc that closes the native pop-up
  // reached the surface and closed Settings too. While the pop-up is open
  // (a press or an opening key on the field, until a choice, a blur or
  // that Esc), the field answers Esc itself.
  // Walk 2026-10-23 (also on 1.168.1): Esc that closes the native pop-up
  // reached the surface and closed Settings too. The field marks its pop-up
  // open when a press or an opening key on it opens one, and answers that one
  // Esc itself. The mark never depends on mouseup/click, which WebKit holds
  // while its pop-up is open and Chromium (WebView2) delivers at once: it
  // ends with a choice (change; not `input`, which would re-render the
  // controlled value before React's change), a blur, another key, a press anywhere
  // else, a second press on the field (it closes the pop-up), or after a
  // short while — a same-option pick costs at most one swallowed Esc.
  const [popupOpen, setPopupOpen] = useState(false);
  const field = useRef<HTMLSpanElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  // Mac walk (1.169.0 block A): WebKit's native menu is modal and keeps the
  // Esc that closes it — so any key that reaches the page means the menu is
  // already closed: on a Mac the mark never holds an Esc back. WebView2 hands
  // the open pop-up's keys to the page, so there the mark answers that Esc.
  useEscapeFirst(popupOpen && !isMac(), field, () => setPopupOpen(false));
  useEffect(() => {
    if (!popupOpen) return;
    const elsewhere = (e: PointerEvent) => {
      if (e.target !== select.current) setPopupOpen(false);
    };
    window.addEventListener("pointerdown", elsewhere, true);
    const expire = setTimeout(() => setPopupOpen(false), SELECT_POPUP_MARK_MS);
    return () => {
      window.removeEventListener("pointerdown", elsewhere, true);
      clearTimeout(expire);
    };
  }, [popupOpen]);
  const current = options.find((o) => o.value === value)?.label ?? value;
  if (row?.readOnly) return <ReadOnlyValue mono={mono}>{current}</ReadOnlyValue>;
  const bad = error ?? row?.error ?? false;
  // Written out, not built by a helper, so ux-check can read every class.
  const cls = [
    "ux-field ux-field--select",
    bad ? "ux-field--error" : "",
    row?.changed ? "ux-field--changed" : "",
    mono ? "ux-field--mono" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} ref={field}>
      <select
        className="ux-select"
        value={value}
        ref={select}
        onMouseDown={(e) => {
          if (e.button === 0) setPopupOpen((open) => !open);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") return;
          const opens =
            e.key === " " ||
            (e.key === "Enter" && !isMac()) ||
            (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"));
          if (opens) {
            setPopupOpen(true);
            return;
          }
          // WebView2 sends the open pop-up's navigation keys to the field:
          // moving through it, or typing to find an option, keeps it open.
          if (SELECT_NAVIGATION_KEYS.has(e.key) || (e.key.length === 1 && !e.metaKey && !e.ctrlKey)) return;
          setPopupOpen(false);
        }}
        onBlur={() => setPopupOpen(false)}
        disabled={effectiveDisabled(disabled, row?.disabled)}
        aria-label={label}
        aria-labelledby={label ? undefined : row?.labelId}
        aria-describedby={row?.hintId}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setPopupOpen(false);
          onChange(e.target.value);
        }}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="ux-field-caret" aria-hidden>
        <Icon name="choose" size="sm" />
      </span>
    </span>
  );
}

/**
 * `onCommit` saves on blur **or** Enter; `onChange` follows every keystroke.
 *
 * GH #103 review 1 (BLOCKER): `onCommit` is for a **setting**, which saves as it
 * changes and can be undone (PATTERNS.md §5). A field whose Enter *runs a
 * procedure* — flipping a board to GitHub Issues, sending an invite — takes
 * `onEnter` instead, because blurring a half-typed value must never start
 * something that cannot be undone. The two are separate props rather than a
 * mode flag so `settingsNav.test.ts` can read which one a page used.
 *
 * `onCancel` puts Esc back where it belongs: a field with something to revert
 * answers Esc before the surface around it closes (`useEscapeFirst`, the same
 * mechanism the search field uses), so a typed value is not lost to a keystroke
 * meant for the modal.
 */
export function TextField({
  value,
  onChange,
  onCommit,
  onEnter,
  onCancel,
  mono = false,
  error,
  disabled,
  label,
  wide = false,
  readOnly,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "className"> & {
  value: string;
  onChange: (next: string) => void;
  /** A setting: saved on blur or Enter. */
  onCommit?: (value: string) => void;
  /** A procedure: run on Enter only, never on blur. */
  onEnter?: (value: string) => void;
  /** Esc, while there is something to revert or a question to abandon. */
  onCancel?: () => void;
  mono?: boolean;
  error?: boolean;
  label?: string;
  /** Takes the free width of the row's right side (paths, commands). */
  wide?: boolean;
}) {
  const row = useRowState();
  const field = useRef<HTMLSpanElement>(null);
  useEscapeFirst(!!onCancel, field, () => onCancel?.());
  // Read-only, from the row or its own prop: the value, no box (F15).
  if (row?.readOnly || readOnly) {
    return <ReadOnlyValue mono={mono}>{value || "None"}</ReadOnlyValue>;
  }
  const bad = error ?? row?.error ?? false;
  const cls = [
    "ux-field ux-field--text",
    bad ? "ux-field--error" : "",
    row?.changed ? "ux-field--changed" : "",
    mono ? "ux-field--mono" : "",
    wide ? "ux-field--wide" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span ref={field} className={cls}>
      <input
        className="ux-input"
        value={value}
        disabled={effectiveDisabled(disabled, row?.disabled)}
        aria-label={label}
        aria-labelledby={label ? undefined : row?.labelId}
        aria-describedby={row?.hintId}
        aria-invalid={bad || undefined}
        onChange={(e) => onChange(e.target.value)}
        // Only `onCommit` — a procedure is never started by looking away.
        onBlur={(e) => {
          noteBlurredField(e.target);
          onCommit?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          onCommit?.(e.currentTarget.value);
          onEnter?.(e.currentTarget.value);
        }}
        {...rest}
      />
    </span>
  );
}

/**
 * A segmented control: two or more exclusive choices, all visible.
 *
 * The compact form of a short choice list (BOARDS.md §3: the Library's inner
 * column becomes `Instructions | Skills | Notes` when the centre is narrow;
 * §5: `Claude | Codex` in Builds & runs). More than about four choices belongs
 * in a `Select`, which is why the narrow Library pairs this with one for the
 * scopes.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  /** OB-14: a choice that can't be made here is shown disabled, its reason
   *  as the title — never hidden. */
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  label: string;
}) {
  return (
    <div className="ux-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={o.value === value ? "ux-segment ux-segment--active" : "ux-segment"}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A search or filter field; shows a clear button while it holds text. */
export function SearchField({
  value,
  onChange,
  placeholder,
  disabled = false,
  label,
  inputId,
  onEnter,
  describedBy,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  disabled?: boolean;
  label?: string;
  /** GH #107: so a shortcut (⌘F in Settings) can put the caret here. The
   *  caller's own `useId()`, never a literal. */
  inputId?: string;
  /** Enter, while the field holds text: take the first result. */
  onEnter?: () => void;
  /** The line that says what the field found. */
  describedBy?: string;
}) {
  const field = useRef<HTMLSpanElement>(null);
  // A filled field clears on Esc before its surface closes.
  useEscapeFirst(!!value && !disabled, field, () => onChange(""));
  return (
    <span ref={field} className="ux-field ux-field--search">
      <span className="ux-field-glyph" aria-hidden>
        <Icon name="search" size="sm" />
      </span>
      <input
        className="ux-input"
        type="search"
        id={inputId}
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        aria-describedby={describedBy}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !onEnter) return;
          e.preventDefault();
          onEnter();
        }}
      />
      {value && !disabled && (
        <button
          type="button"
          className="ux-field-clear"
          aria-label="Clear"
          onClick={() => onChange("")}
        >
          <Icon name="close" size="sm" />
        </button>
      )}
    </span>
  );
}

/**
 * A list of exclusive choices, each with a sentence of its own: the shape a
 * `Flow` asks a one-step question with (BOARDS.md §6 "Promote"; PATTERNS.md §6).
 *
 * A radio group, not rows that happen to be clickable: GH #96 review 1 found the
 * Promote flow using two `Row`s, so a screen reader was told "button" twice and
 * the arrow keys did nothing. `role="radiogroup"` with `aria-checked` per option
 * and ← ↑ → ↓ Home End moving the choice, which is what the platform's own radio
 * group does — and, as there, only the chosen option is a tab stop.
 */
export function ChoiceList<T extends string>({
  value,
  onChange,
  options,
  label,
  autoFocus = false,
}: {
  /** `null`: nothing chosen yet — a question the person has to answer
   *  themselves (Align, owner 2026-10-19). The first option is the tab stop. */
  value: T | null;
  onChange: (next: T) => void;
  options: { value: T; label: string; hint: string; disabled?: boolean }[];
  label: string;
  /** The question is the surface's one step: focus its tab stop on mount, so
   *  the arrow keys answer it at once (owner-fixes walk). */
  autoFocus?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    group.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
    // Once, on mount: a later re-render must not pull focus back.
  }, []);
  // Every centre-mode host stays mounted per warmed workspace, so two of these
  // can be in the document at once: the hint ids have to be this instance's
  // (review 2 — `repository-hint` was global, and `aria-describedby` then named
  // another workspace's sentence).
  const uid = useId();
  const hintId = (value: string) => `${uid}-${value}-hint`;
  const pickable = options.filter((o) => !o.disabled);
  // The tab stop is the chosen option, unless the choice is one that cannot be
  // picked — then the first that can, so the group is never unreachable by
  // keyboard (review 2).
  const stop = pickable.some((o) => o.value === value) ? value : pickable[0]?.value;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // From the tab stop, not from `value`: a chosen option that cannot be picked
    // is not in `pickable`, and the -1 it indexes to would send ↑ two places.
    // Nothing chosen yet: ↓ chooses the first, ↑ the last.
    const at = value === null ? -1 : pickable.findIndex((o) => o.value === stop);
    const go = (i: number) => {
      const next = pickable[(i + pickable.length) % pickable.length];
      if (!next) return;
      onChange(next.value);
      // The choice moves with the focus, as it does in a native radio group.
      group.current
        ?.querySelector<HTMLButtonElement>(`[data-choice="${next.value}"]`)
        ?.focus();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowRight") go(at + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") go(at === -1 ? pickable.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(pickable.length - 1);
    else return;
    e.preventDefault();
  }

  return (
    <div
      ref={group}
      className="ux-choices"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-choice={o.value}
          aria-checked={o.value === value}
          aria-describedby={hintId(o.value)}
          disabled={o.disabled}
          // One tab stop: Tab reaches the group, the arrows move inside it.
          tabIndex={o.value === stop ? 0 : -1}
          className={o.value === value ? "ux-choice ux-choice--on" : "ux-choice"}
          onClick={() => onChange(o.value)}
        >
          {/* GH #307: the choice is a radio dot beside the words — the accent
              border alone is colour alone, and a coloured left edge is not
              the design system's. */}
          <span className="ux-choice-radio" aria-hidden />
          <span className="ux-choice-label">{machineWords(o.label)}</span>
          <span className="ux-choice-hint" id={hintId(o.value)}>
            {machineWords(o.hint)}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * UX language card 8 (GH #103; SHEET.md "Type-or-choose field", BOARDS.md §5
 * corrected): a field you can **type in or pick from**.
 *
 * Ply cannot list a vendor's models, so a closed `Select` would be a promise
 * it cannot keep: a model works the day the vendor ships it. The field is
 * therefore free text, with the names Ply happens to know offered under a
 * caret, and `CLI default` — pass no flag at all — always first. The list's
 * foot says the rest in words.
 *
 * Not a `<datalist>`, which is what the sectioned Settings used: Safari draws
 * it as a filtering autocomplete that hides every suggestion the moment the
 * field holds text, so `CLI default` was unreachable once anything was typed,
 * and nothing could say what the list was for.
 */
export function TypeOrChoose({
  value,
  onChange,
  onCommit,
  onCancel,
  options,
  defaultLabel,
  footnote,
  label,
  placeholder,
  disabled,
  id,
}: {
  /** What is set, or "" for the CLI's own default. */
  value: string;
  onChange: (next: string) => void;
  /** Blur, Enter, or a choice from the list. */
  onCommit: (value: string) => void;
  /** Esc, while there is something to revert. Closes the list first. */
  onCancel?: () => void;
  /** The names Ply knows, after the default — a name, or (1.169.0) a name
   *  with a line under it (a model's label). */
  options: readonly (string | { value: string; hint?: string })[];
  /** The first item, always: `CLI default`. */
  defaultLabel: string;
  /** The line under the list: `Or type the name of any model your CLI accepts.` */
  footnote: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** 1.176.1: the input's id, for a checked field that puts the focus back. */
  id?: string;
}) {
  const row = useRowState();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useDismiss(open, root, () => setOpen(false));
  // Esc reverts what was typed, before the surface around it takes the key
  // (review 1, finding 7). While the list is open `MenuList` answers Esc
  // itself, so this stands back rather than racing it.
  useEscapeFirst(!open && !!onCancel, root, () => onCancel?.());
  if (row?.readOnly) {
    return <ReadOnlyValue mono>{value || defaultLabel}</ReadOnlyValue>;
  }
  const off = effectiveDisabled(disabled, row?.disabled);
  const pick = (next: string) => {
    setOpen(false);
    caret.current?.focus();
    onChange(next);
    onCommit(next);
  };
  const items: MenuItem[] = [
    { label: defaultLabel, onSelect: () => pick("") },
    ...options.map((o) =>
      typeof o === "string"
        ? { label: o, onSelect: () => pick(o) }
        : { label: o.value, hint: o.hint, onSelect: () => pick(o.value) },
    ),
  ];
  return (
    <span ref={root} className="ux-choose">
      <span
        className={
          row?.changed
            ? "ux-field ux-field--text ux-field--mono ux-field--changed"
            : "ux-field ux-field--text ux-field--mono"
        }
      >
        <input
          id={id}
          className="ux-input"
          value={value}
          disabled={off}
          placeholder={placeholder ?? defaultLabel}
          aria-label={label}
          aria-describedby={row?.hintId}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            noteBlurredField(e.target);
            onCommit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit(e.currentTarget.value);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
            }
          }}
        />
      </span>
      <button
        ref={caret}
        type="button"
        className="ux-choose-caret"
        disabled={off}
        aria-label={`${label} — choose from the list`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="choose" size="sm" />
      </button>
      {open && (
        <span className="ux-choose-list">
          <MenuList
            id={menuId}
            items={items}
            label={label}
            current={value || defaultLabel}
            onClose={(refocus) => {
              setOpen(false);
              if (refocus) caret.current?.focus();
            }}
          />
          <span className="ux-choose-foot">{footnote}</span>
        </span>
      )}
    </span>
  );
}
