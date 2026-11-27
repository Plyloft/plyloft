import {
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { WorkspaceIcon } from "../store/workspaceStore";
import { workspaceMonogram } from "../lib/workspaceMonogram";
import { monogramInk } from "../lib/workspaceColor";

/**
 * v1.43.0 (Sidebar identity): single chip used in the switcher AND the
 * detail-pane header. Three variants in one component:
 *   - `kind === "monogram"` (or null/undefined icon) → letter(s) from
 *     `workspaceMonogram(name)` on the accent-colored chip.
 *   - `kind === "emoji"` → emoji glyph on a desaturated tint of accent.
 *     Saturated accent backgrounds make most emoji read muddy; the
 *     desaturation here is empirical.
 *   - `kind === "image"` → user-uploaded image scaled to fill. Source
 *     uses `convertFileSrc(path) + "?v={mtime}"` so a replace (same
 *     path, new bytes) invalidates the WebView's URL-keyed cache. If
 *     the image fails to load (file deleted out from under us, etc.),
 *     the chip silently falls back to the monogram rendering.
 *
 * `size` controls dimensions only. Switcher uses `md` (32px); the
 * detail-pane header uses `sm` (28px). Detail chip stays ≤ switcher
 * chip — same identity, more context around it.
 */

export type IconChipSize = "xs" | "sm" | "md";

type Props = {
  icon: WorkspaceIcon | null | undefined;
  name: string;
  /** Resolved CSS color from `workspaceAccentColor()`. Already accounts
   *  for explicit accentColor pick vs djb2-hash fallback. */
  accent: string;
  size?: IconChipSize;
  /** Native `title` tooltip for switcher rows. Detail pane chip can
   *  skip this (the name is right next to it). */
  tooltip?: string;
  onClick?: (e: MouseEvent<HTMLSpanElement>) => void;
  /** Forwarded to the root span so the parent can override the cursor
   *  (e.g. `pointer` only when an onClick is wired). */
  className?: string;
  /** v1.46.0: when > 0, render a red corner badge overhanging the
   *  top-right of the chip. macOS-notification-style — single source
   *  of truth for "this workspace wants you." Caller should only pass
   *  this on the switcher (md) chip — the detail-pane (sm) chip is
   *  for the workspace you're already on, where a badge would be
   *  redundant with the RUNNING / CARDS sections below. */
  attentionCount?: number;
};

// UX-3.3: `xs` (20 px) is the sidebar's workspace switcher and its popover.
const DIMENSIONS: Record<IconChipSize, number> = { xs: 20, sm: 28, md: 32 };

export function WorkspaceIconChip({
  icon,
  name,
  accent,
  size = "md",
  tooltip,
  onClick,
  className,
  attentionCount,
}: Props) {
  const px = DIMENSIONS[size];
  const kind = icon?.kind ?? "monogram";

  /** v1.46.0: badge appears only when count > 0. Cap display at "99+"
   *  so it doesn't visually balloon. */
  const showBadge = (attentionCount ?? 0) > 0;
  const badgeText = !showBadge
    ? null
    : (attentionCount as number) > 99
      ? "99+"
      : String(attentionCount);
  const badge = showBadge ? (
    <span className="ws-icon-chip-attn" aria-label={`${attentionCount} attention items`}>
      {badgeText}
    </span>
  ) : null;

  // Image-load failure is the only async path that can change what we
  // render; track it locally so the chip can fall back to monogram
  // without throwing or showing a broken-image icon.
  const [imageBroken, setImageBroken] = useState(false);

  const baseStyle: CSSProperties = {
    width: px,
    height: px,
    background: accent,
    cursor: onClick ? "pointer" : "default",
  };

  // v1.46.0: when a badge is present, wrap the chip in a positioned
  // container so the badge can overhang the chip's bounds without
  // forcing `overflow: visible` on the chip itself (which would break
  // image chips' rounded-corner clipping). When no badge, render the
  // bare chip — wrapper is a no-op cost either way, but skipping
  // keeps the DOM lean for the common case.
  function withBadge(chip: ReactElement): ReactElement {
    if (!badge) return chip;
    return (
      <span className="ws-icon-chip-wrap" style={{ width: px, height: px }}>
        {chip}
        {badge}
      </span>
    );
  }

  if (kind === "image" && icon?.kind === "image" && !imageBroken) {
    // file:// URLs need conversion under Tauri's asset protocol. The
    // `?v={mtime}` query cache-busts so replacing the image (same path,
    // new bytes) updates the chip without an app restart.
    const src = `${convertFileSrc(icon.path)}?v=${icon.mtime}`;
    // v1.45.2: solid white background under uploaded images. Logos are
    // almost always authored against white; using the workspace accent
    // here caused transparent PNGs to render with an unintended color
    // wash (user complaint after v1.45.1's scope fix made image chips
    // visible at all). Once an image is set, *it* carries the identity
    // signal — accent color is redundant.
    const imageStyle: CSSProperties = { ...baseStyle, background: "var(--chip-ink-light)" };
    return withBadge(
      <span
        className={`ws-icon-chip ${className ?? ""}`}
        style={imageStyle}
        onClick={onClick}
        title={tooltip}
        role={onClick ? "button" : undefined}
        aria-label={onClick ? `Workspace icon, ${name}` : undefined}
      >
        <img
          src={src}
          alt=""
          className="ws-icon-chip-img"
          onError={() => setImageBroken(true)}
        />
      </span>,
    );
  }

  if (kind === "emoji" && icon?.kind === "emoji") {
    // Desaturate the accent slightly so emoji glyphs don't read muddy on
    // top of a saturated solid color. We tint white in via 30% opacity
    // overlay rather than parse the color — works for both `#hex` and
    // `hsl(...)` accents.
    return withBadge(
      <span
        className={`ws-icon-chip ws-icon-chip-emoji ${className ?? ""}`}
        style={baseStyle}
        onClick={onClick}
        title={tooltip}
        role={onClick ? "button" : undefined}
        aria-label={onClick ? `Workspace icon, ${name}` : undefined}
      >
        <span
          className="ws-icon-chip-glyph"
          style={{ fontSize: Math.round(px * 0.62) }}
        >
          {icon.value}
        </span>
      </span>,
    );
  }

  // Monogram (default + fallback for missing-image case). GH #288: one
  // letter, 12 px on the 20 px chip (half the chip above), in the ink that
  // reads on this colour.
  const letters = workspaceMonogram(name);
  return withBadge(
    <span
      className={`ws-icon-chip ws-icon-chip-monogram ws-icon-chip--ink-${monogramInk(accent)} ${className ?? ""}`}
      style={baseStyle}
      onClick={onClick}
      title={tooltip}
      role={onClick ? "button" : undefined}
      aria-label={onClick ? `Workspace icon, ${name}` : undefined}
    >
      <span
        className="ws-icon-chip-letters"
        style={size === "xs" ? undefined : { fontSize: Math.round(px * 0.5) }}
      >
        {letters}
      </span>
    </span>,
  );
}
