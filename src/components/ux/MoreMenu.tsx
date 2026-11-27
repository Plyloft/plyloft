import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import { CBtn, CIcon } from "../ui/primitives";
import { Icon, type IconName } from "./Icon";
import { menuPlacement, visibleBounds, type MenuPlacement } from "../../lib/menuPlacement";
import type { TourAnchor } from "../../lib/tutorial/manifest";
import { useEscapeFirst } from "./useEscapeFirst";
import { machineWords } from "../../lib/platform";

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** UX-8.2: the item's keyboard shortcut, shown at the row's end. */
      shortcut?: string;
      /** GH #325: one of a set of choices (a menuitemradio) — true on the
       *  current one, drawn with a check. A current choice is selected, not
       *  disabled: picking it again is allowed. */
      checked?: boolean;
      /** v1.154.1: a line under the label — why a disabled item is off —
       *  shown, and read as the item's description. */
      hint?: string;
      /** v1.154.1: `checked` is an on/off switch (a menuitemcheckbox), not
       *  one of a set. */
      toggle?: boolean;
      /** A small mark after the label ("New"). It is read in the item's
       *  name (N14 walk F13). */
      badge?: string;
      /** 1.173.0 A3: the item's tour anchor (`data-ply-tour`). */
      tour?: string;
    }
  | { heading: string }
  | "divider";

/** A pressable item (not a heading, not a divider). */
export type MenuAction = Exclude<MenuItem, "divider" | { heading: string }>;

type MenuRow = { item: MenuAction | "divider"; i: number };

/** The menu cut at its headings: rows before the first heading stand on
 *  their own; each heading holds the rows up to the next one. `i` is the
 *  row's place in `items` (its hint's id). */
function menuSegments(items: MenuItem[]): { heading: { text: string; i: number } | null; rows: MenuRow[] }[] {
  const segments: { heading: { text: string; i: number } | null; rows: MenuRow[] }[] = [{ heading: null, rows: [] }];
  items.forEach((item, i) => {
    if (item !== "divider" && "heading" in item) segments.push({ heading: { text: item.heading, i }, rows: [] });
    else segments[segments.length - 1].rows.push({ item, i });
  });
  return segments.filter((s) => s.heading || s.rows.length > 0);
}

/** A list of items in the menu shell (SHEET.md "MoreMenu"): 8 px radius,
 *  menu shadow, 14 px entries, keyboard with ↑ ↓ Home End Esc. An item's
 *  `hint` (why it is off, or its caveat) is drawn under its label and is the
 *  item's accessible description. */
export function MenuList({
  id,
  items,
  onClose,
  label,
  current,
}: {
  id?: string;
  items: MenuItem[];
  onClose: (refocus: boolean) => void;
  label: string;
  /** The item shown as the current choice (a navigation menu). */
  current?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Walk follow-ups 2026-10-19: each hint's id, so the item names it as its
  // description (aria-describedby; `aria-description` never reached the
  // WebKit accessibility tree, so a disabled entry's reason went unheard).
  const hintId = useId();
  useEscapeFirst(true, ref, () => onClose(true));
  // Walk follow-ups 2026-10-19: drawn, the menu turns to the side and the
  // direction where all of it is seen — a skill page's `⋯` at the panel's
  // left edge, a row's at the bottom of the window. Before paint, so it never
  // shows clipped first. A menu laid out in its list (`position: static`)
  // stays where it is.
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  // Challenger: the window resized or a list scrolled while the menu is open
  // — measured again from where the stylesheet draws it (`place` back to
  // none and `measure` moved on, one render, still before paint).
  const [measure, setMeasure] = useState(0);
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = menu?.parentElement;
    if (!menu || !anchor) return;
    if (getComputedStyle(menu).position !== "absolute") return;
    const box = menu.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return;
    setPlace(menuPlacement(box, anchor.getBoundingClientRect(), visibleBounds(anchor)));
  }, [measure]);
  useEffect(() => {
    const view = ref.current?.ownerDocument.defaultView;
    if (!view) return;
    let frame: number | null = null;
    const again = (e: Event) => {
      // The menu's own scroll (its max-height) moves nothing around it.
      if (e.type === "scroll" && e.target instanceof Node && ref.current?.contains(e.target)) return;
      if (frame != null) return;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        setPlace(null);
        setMeasure((n) => n + 1);
      });
    };
    view.addEventListener("resize", again);
    view.document.addEventListener("scroll", again, true);
    return () => {
      view.removeEventListener("resize", again);
      view.document.removeEventListener("scroll", again, true);
      if (frame != null) view.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const first =
      ref.current?.querySelector<HTMLButtonElement>(".ux-menu-item--current:not(:disabled)") ??
      ref.current?.querySelector<HTMLButtonElement>('.ux-menu-item[role="menuitemradio"][aria-checked="true"]:not(:disabled)') ??
      ref.current?.querySelector<HTMLButtonElement>(".ux-menu-item:not(:disabled)");
    first?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const all = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>(".ux-menu-item:not(:disabled)") ?? []),
    ];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Tab") {
      // Tab leaves the menu the way Esc does (useEscapeFirst): closed, focus
      // back on its trigger.
      e.stopPropagation();
      onClose(true);
    } else return;
    e.preventDefault();
  }

  function renderItem(item: MenuAction, i: number) {
    return (
      <button
        key={item.label}
        type="button"
        role={item.checked === undefined ? "menuitem" : item.toggle ? "menuitemcheckbox" : "menuitemradio"}
        aria-checked={item.checked}
        disabled={item.disabled}
        className={[
          "ux-menu-item",
          item.danger ? "ux-menu-item--danger" : "",
          current === item.label ? "ux-menu-item--current" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-current={current === item.label ? "page" : undefined}
        aria-labelledby={item.hint ? `${hintId}-${i}-label` : undefined}
        aria-keyshortcuts={item.shortcut}
        aria-describedby={item.hint ? `${hintId}-${i}` : undefined}
        data-ply-tour={item.tour}
        onClick={() => {
          // v1.154.1 (walk I5): an on/off switch (menuitemcheckbox) flips
          // in place — the menu stays open, so the press it qualifies
          // (a press beside an on/off choice) is still there.
          if (!item.toggle) onClose(true);
          item.onSelect();
        }}
      >
        {item.checked !== undefined && (
          <span className="ux-menu-check">
            {item.checked && <Icon name="current" size="sm" />}
          </span>
        )}
        {item.hint ? (
          <>
            <span className="ux-menu-item-label">
              {/* 1.173.0 A3 re-walk: the name is the label (and its badge),
                  through aria-labelledby; the hint is a visible node the
                  description points at — a hidden one never reached the
                  WebKit accessibility tree on a disabled item. */}
              <span id={`${hintId}-${i}-label`}>
                {machineWords(item.label)}
                {item.badge && <MenuBadge text={item.badge} />}
              </span>
              <span id={`${hintId}-${i}`} className="ux-menu-hint">
                {machineWords(item.hint)}
              </span>
            </span>
            {item.shortcut && <kbd className="ux-menu-shortcut">{item.shortcut}</kbd>}
          </>
        ) : item.shortcut ? (
          <>
            <span className="ux-menu-item-label">
              {machineWords(item.label)}
              {item.badge && <MenuBadge text={item.badge} />}
            </span>
            <kbd className="ux-menu-shortcut">{item.shortcut}</kbd>
          </>
        ) : item.badge ? (
          <span className="ux-menu-item-label">
            {machineWords(item.label)}
            <MenuBadge text={item.badge} />
          </span>
        ) : (
          item.label
        )}
      </button>
    );
  }

  return (
    <div
      id={id}
      ref={ref}
      className={[
        "ux-menu",
        place?.start ? "ux-menu--start" : "",
        place?.end ? "ux-menu--end" : "",
        place?.up ? "ux-menu--up" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={place?.maxHeight != null ? { maxHeight: place.maxHeight } : undefined}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {menuSegments(items).flatMap((segment) => {
        const rows = segment.rows.map(({ item, i }) =>
          item === "divider" ? (
            <div key={`d${i}`} className="ux-menu-divider" role="separator" />
          ) : (
            renderItem(item, i)
          ),
        );
        if (!segment.heading) return rows;
        // 1.172.0 D1: a heading names the items under it — a group a
        // screen reader announces ("Session, group"), not a loose line.
        const headingId = `${hintId}-h${segment.heading.i}`;
        return [
          <div key={`g${segment.heading.i}`} className="ux-menu-group" role="group" aria-labelledby={headingId}>
            <div id={headingId} className="ux-menu-heading" aria-hidden="true">
              {segment.heading.text}
            </div>
            {rows}
          </div>,
        ];
      })}
    </div>
  );
}

/** A small mark after a label ("Team" on a team control, "New"). N14 walk
 *  F13: read as part of the control's name (its label, then ", Team"), the
 *  same in a menu item and a button. The reader gets its words with a comma; the
 *  drawn mark is hidden from it. */
export function PlanMark({ text, title }: { text: string; title?: string }) {
  return (
    <>
      <span className="ux-sr-only">, {text}</span>
      <span className="ux-pro-mark" data-ply-pro-mark="" title={title} aria-hidden="true">
        {text}
      </span>
    </>
  );
}

function MenuBadge({ text }: { text: string }) {
  return <PlanMark text={text} />;
}

/** Closes a popover on a click outside `root`. */
export function useDismiss(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (root.current && !root.current.contains(e.target as Node)) close();
    }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, root, close]);
}

/** C9: what a caller-drawn trigger spreads on its button. */
export interface MenuTrigger {
  ref: Ref<HTMLButtonElement>;
  props: {
    "data-ply-tour"?: TourAnchor;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls"?: string;
    "aria-describedby"?: string;
    disabled: boolean;
    onClick: () => void;
  };
  label: string;
  icon: IconName;
  /** Something new: the trigger draws its dot (`ux-more-dot`). */
  dot: boolean;
}

/** The ⋯ of a row: everything that is not the row's one action. */
export function MoreMenu({
  items,
  label = "More",
  disabled = false,
  tour,
  icon = "more",
  dot,
  trigger,
  onOpen,
}: {
  items: MenuItem[];
  label?: string;
  /** 1.174.0 (DR3): the menu opens — the Board's ⋯ reads what Release Site…
   *  would carry then, not on every mount. */
  onOpen?: () => void;
  /** 1.169.0 (C9): the caller draws the trigger (the sidebar's Help row,
   *  drawn like Board or Settings) from these props; the menu opens from
   *  its left edge (above it when there is no room below). */
  trigger?: (t: MenuTrigger) => ReactNode;
  /** TU-8 (TUTORIAL_SPEC §12.2): an accent dot on the trigger, and these
   *  words beside it for a screen reader (Help's "Something new in this
   *  version"). */
  dot?: string;
  /** The trigger's icon: the ⋯ unless the menu has a meaning of its own
   *  (the sidebar's Help, TUTORIAL_SPEC §3.3). */
  icon?: IconName;
  /** The trigger's tour anchor (TUTORIAL_SPEC §4.3). */
  tour?: TourAnchor;
  /** The trigger is inert — a write about this row is running — and a menu
   *  open when it went inert closes. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger_ = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const dotId = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger_.current?.focus();
  };
  useDismiss(open, root, () => setOpen(false));
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };
  // Going inert closes the menu. If the keyboard was on the trigger or in the
  // menu, a disabled button drops focus to the page, so it is handed back to
  // the trigger once it is live again — the member's place is kept.
  // A layout effect: it runs before the browser's focus fix-up moves focus off
  // the button that just went disabled, so it can still see where focus was.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (disabled) {
      hadFocus.current =
        root.current != null && root.current.contains(document.activeElement);
      setOpen(false);
    } else if (hadFocus.current) {
      hadFocus.current = false;
      if (document.activeElement == null || document.activeElement === document.body) {
        trigger_.current?.focus();
      }
    }
  }, [disabled]);
  if (trigger) {
    return (
      <span ref={root} className="ux-more ux-more--row">
        {trigger({
          ref: trigger_,
          props: {
            "data-ply-tour": tour,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-controls": open ? menuId : undefined,
            "aria-describedby": dot ? dotId : undefined,
            disabled,
            onClick: toggle,
          },
          label,
          icon,
          dot: Boolean(dot),
        })}
        {dot && (
          <span className="ux-sr-only" id={dotId}>
            {dot}
          </span>
        )}
        {open && <MenuList id={menuId} items={items} label={label} onClose={close} />}
      </span>
    );
  }
  return (
    <span ref={root} className="ux-more">
      <CIcon
        ref={trigger_}
        icon={icon}
        aria-label={label}
        data-ply-tour={tour}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={dot ? dotId : undefined}
        disabled={disabled}
        onClick={toggle}
      />
      {dot && (
        <>
          <span className="ux-more-dot" aria-hidden="true" />
          <span className="ux-sr-only" id={dotId}>
            {dot}
          </span>
        </>
      )}
      {open && <MenuList id={menuId} items={items} label={label} onClose={close} />}
    </span>
  );
}

/**
 * UX-8.2: a primary that opens a menu — the Terminals header's "New ▾".
 * The trigger is a button with its words and a chevron; the menu is the same
 * MenuList as the ⋯, keyboard included.
 */
export function MenuButton({
  label,
  menuLabel,
  items,
  tone = "accent",
  icon,
  title,
  tour,
}: {
  /** The trigger's words ("New"). */
  label: string;
  /** The menu's accessible name ("New session"). */
  menuLabel: string;
  items: MenuItem[];
  /** 1.172.0 (C1): "quiet" for a menu beside a primary (Plan it first ▾). */
  tone?: "accent" | "ghost" | "quiet";
  icon?: IconName;
  title?: string;
  /** The trigger's tour anchor (TUTORIAL_SPEC §4.3). */
  tour?: TourAnchor;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(open, root, () => setOpen(false));
  return (
    <span ref={root} className="ux-more">
      <CBtn
        ref={trigger}
        tone={tone}
        title={title}
        data-ply-tour={tour}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {icon && <Icon name={icon} />}
        {label}
        <Icon name="expand" size="sm" />
      </CBtn>
      {open && <MenuList id={menuId} items={items} label={menuLabel} onClose={close} />}
    </span>
  );
}

/**
 * C6 (UX-6.6, the Card board): a primary with its variants — "Ship it ▾".
 * The main press is the primary; the chevron opens the same MenuList as the
 * ⋯ with the other ways to do it (Ship ▾'s choices). The main button takes the
 * caller's attributes (`data-*`, `title`), so it stays the one thing a
 * keyboard shortcut or a trace looks for. With no other ways (`items` empty)
 * it is the main button alone, so a caller draws its one primary through one
 * element whether or not it has variants (1.174.0 A7, VC-2).
 */
export function SplitButton({
  label,
  onClick,
  items,
  menuLabel,
  disabled,
  tone = "accent",
  mainProps,
}: {
  label: string;
  /** The press itself (C3: a double-click's second click is `detail` 2). */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  items: MenuItem[];
  /** The chevron's accessible name and the menu's ("More ways to ship"). */
  menuLabel: string;
  disabled?: boolean;
  tone?: "accent" | "ghost";
  mainProps?: Record<string, string | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(open, root, () => setOpen(false));
  if (items.length === 0) {
    return (
      <CBtn tone={tone} disabled={disabled} onClick={onClick} {...mainProps}>
        {label}
      </CBtn>
    );
  }
  return (
    <span ref={root} className="ux-more ux-split">
      <CBtn tone={tone} className="ux-split-main" disabled={disabled} onClick={onClick} {...mainProps}>
        {label}
      </CBtn>
      <CBtn
        ref={trigger}
        tone={tone}
        className="ux-split-toggle"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="expand" size="sm" />
      </CBtn>
      {open && <MenuList id={menuId} items={items} label={menuLabel} onClose={close} />}
    </span>
  );
}
