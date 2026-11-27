import { useRef, useState } from "react";
import { CBtn } from "../ui/primitives";
import { MenuList, useDismiss, type MenuItem } from "./MoreMenu";
import { Icon, type IconName } from "./Icon";

export type NavListGroup = {
  label: string;
  /** UX-9.2: the scope icon drawn before a group's name (Settings' four
   *  scopes). Absent on a group that is not a scope. */
  icon?: IconName;
  entries: {
    id: string;
    label: string;
    /** GH #96: the count on the right of an entry, in mono `--muted` (the
     *  Library's `Repository 34`). Absent on an entry that counts nothing. */
    count?: number;
  }[];
};

/** The navigation column of a page surface (UX-9.2): groups named in
 *  sentence case, `--type-caption` muted, with their scope icon; entries one
 *  compact row (`--row-compact` 32 px) of `--type-ui`, the active one on
 *  `--selected`. */
export function NavList({
  groups,
  active,
  also = null,
  onSelect,
  label,
}: {
  groups: NavListGroup[];
  /** The entry shown now; `null` when no entry is (GH #316: while Settings
   *  search results fill the page area, the results are the current view). */
  active: string | null;
  /** GH #313: a filter of the active page, in a group of its own (the
   *  Library's scope on Skills). Its entry is marked with the page's —
   *  `aria-current="true"`, the page keeps `"page"`. */
  also?: string | null;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <nav className="ux-nav" aria-label={label}>
      {groups.map((g) => (
        <div key={g.label} className="ux-nav-group">
          <h3 className="ux-nav-eyebrow">
            {g.icon && <Icon name={g.icon} size="sm" />}
            {g.label}
          </h3>
          <ul className="ux-nav-list">
            {g.entries.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  // Written out, not composed, so ux-check can read every class.
                  className={[
                    "ux-nav-entry",
                    e.id === active || e.id === also ? "ux-nav-entry--active" : "",
                    e.count != null ? "ux-nav-entry--counted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={e.id === active ? "page" : e.id === also ? "true" : undefined}
                  onClick={() => onSelect(e.id)}
                >
                  {e.count == null ? (
                    e.label
                  ) : (
                    <>
                      <span className="ux-nav-entry-label">{e.label}</span>
                      <span className="ux-nav-entry-count">{e.count}</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The compact navigation: a button showing the current group that opens
 *  the same list as a menu. */
export function NavMenuButton({
  groups,
  active,
  onSelect,
  label,
}: {
  groups: NavListGroup[];
  /** The entry shown now; `null` when no entry is (GH #316: while Settings
   *  search results fill the page area, the results are the current view). */
  active: string | null;
  /** GH #313: a filter of the active page, in a group of its own (the
   *  Library's scope on Skills). Its entry is marked with the page's —
   *  `aria-current="true"`, the page keeps `"page"`. */
  also?: string | null;
  onSelect: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, root, () => setOpen(false));
  const group = groups.find((g) => g.entries.some((e) => e.id === active));
  const current = group?.entries.find((e) => e.id === active);
  // A count is part of the entry's words here, so the "current" item matches
  // by the same string the menu draws.
  const entryLabel = (e: { label: string; count?: number }) =>
    e.count != null ? `${e.label} ${e.count}` : e.label;
  const items: MenuItem[] = [];
  groups.forEach((g) => {
    items.push({ heading: g.label });
    for (const e of g.entries) {
      items.push({ label: entryLabel(e), onSelect: () => onSelect(e.id) });
    }
  });
  return (
    <span ref={root} className="ux-nav-menu">
      <CBtn
        ref={trigger}
        tone="strong"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${group?.label ?? ""} › ${current?.label ?? ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        {group?.label ?? label}
        <Icon name="choose" size="sm" />
      </CBtn>
      {open && (
        <MenuList
          items={items}
          label={label}
          current={current ? entryLabel(current) : undefined}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      )}
    </span>
  );
}
