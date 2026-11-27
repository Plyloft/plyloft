import { useId, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "../ux/Icon";

/**
 * v1.78.0 — UX revamp Part 2 · P2-0: the enforceable component layer (§A).
 * One button (CBtn / CIcon), one chip (PChip). Thin wrappers over the
 * `.cbtn` / `.cicon` / `.cchip` classes in App.css so plain-CSS call sites
 * and React call sites share one source of truth.
 *
 * Rules (docs/ux-revamp/PART2.md §A):
 * - New and rebuilt surfaces use these — never a fresh ad-hoc button/chip.
 * - Tones reuse the sacred --signal-* vocabulary; never invent chip colors.
 * - Sizes: sm 22px · md 26px (md clears the 24px hit-min).
 */

type BtnTone = "ghost" | "strong" | "accent" | "danger" | "quiet";

export function CBtn({
  tone = "ghost",
  size = "md",
  active = false,
  glyph,
  className,
  children,
  reason,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: BtnTone;
  size?: "sm" | "md";
  active?: boolean;
  glyph?: string;
  ref?: Ref<HTMLButtonElement>;
  /** Why it can't be pressed, shown while it is disabled (1.176.2). `null`: nothing to say now; left out: the button has no such line (a `title` stays a plain title). */
  reason?: string | null;
}) {
  const showing = reason !== undefined && reason !== null && reason.trim() !== "" && rest.disabled === true;
  const cls = [
    "cbtn",
    tone !== "ghost" ? `cbtn--${tone}` : "",
    size === "sm" ? "cbtn--sm" : "",
    active ? "is-active" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const reasonId = useId();
  const button = (
    <button
      type="button"
      className={cls}
      {...rest}
      aria-describedby={showing ? [rest["aria-describedby"], reasonId].filter(Boolean).join(" ") : rest["aria-describedby"]}
    >
      {glyph && (
        <span className="cbtn-glyph" aria-hidden>
          {glyph}
        </span>
      )}
      {children}
    </button>
  );
  if (reason === undefined) return button;
  // 1.176.2 (E1): a button that says why it can't be pressed (`reason`; null:
  // nothing to say now). One structure whether it is enabled or not, so it
  // never remounts on a busy toggle: a wrapper (not disabled, so it tracks the
  // hover a disabled button may not), the button, and the reason's marker. The
  // marker is a Tab stop and the button's description only while the button
  // is disabled and there is a reason; the reason is drawn under the button on
  // hover of the wrapper and on focus of the marker.
  return (
    <span className="cbtn-wrap">
      {button}
      <span
        id={reasonId}
        className="cbtn-reason"
        role={showing ? "note" : undefined}
        aria-label={showing ? reason : undefined}
        aria-hidden={showing ? undefined : true}
        data-reason={showing ? reason : undefined}
        tabIndex={showing ? 0 : -1}
      />
    </span>
  );
}

/** GH #274: an icon button draws a Lucide icon from the one map, never a
 *  text glyph. */
export function CIcon({
  icon,
  tone = "ghost",
  active = false,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  /** 1.174.0 (A7, P32): no accent tone — an icon button is never tinted. */
  tone?: "ghost" | "quiet";
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const cls = [
    "cicon",
    tone !== "ghost" ? `cicon--${tone}` : "",
    active ? "is-active" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      <Icon name={icon} size="sm" />
    </button>
  );
}

type ChipTone = "neutral" | "accent" | "ok" | "warn" | "outline";

export function PChip({
  tone = "neutral",
  glyph,
  children,
}: {
  tone?: ChipTone;
  glyph?: string;
  children: ReactNode;
}) {
  const cls = ["cchip", tone !== "neutral" ? `cchip--${tone}` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls}>
      {glyph && (
        <span className="cchip-glyph" aria-hidden>
          {glyph}
        </span>
      )}
      {children}
    </span>
  );
}
