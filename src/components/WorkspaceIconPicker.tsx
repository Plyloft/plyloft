import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openDialog } from "../lib/nativeDialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspaces, type WorkspaceIcon } from "../store/workspaceStore";
import { ACCENT_CHOICES, accentChoice, accentName } from "../lib/repositoryAccent";
import { CBtn, FailureText, Swatches, TextField } from "./ux";
import { failure, type Failure } from "../lib/failure";
import { isWindows } from "../lib/platform";

/**
 * v1.44.0 (Sidebar identity Inc 2): the "Icon and colour" popover, opened
 * from a workspace's ⋯ in the switcher. Sections: Colour, Emoji, Image,
 * then Use monogram.
 *
 * GH #289: on the one scale — a `ux-popover` (raised, radius-lg,
 * shadow-popover) with a caption per section in sentence case, the ux
 * Swatches for the colour, CBtn for every button and a TextField for the
 * emoji; the hint in muted small type.
 *
 * Dismissal: click outside, Esc, or selecting an option that auto-closes
 * (upload success, reset). Colour + emoji selections keep the picker
 * open so the user can iterate.
 *
 * Positioning: portaled to `document.body`, fixed-positioned relative
 * to the anchor's `getBoundingClientRect()`. Flips above the anchor if
 * the picker would otherwise overflow the viewport bottom.
 */

type AnchorRect = { left: number; top: number; bottom: number };

type Props = {
  workspaceId: string;
  name: string;
  icon: WorkspaceIcon | null;
  accentColor: string | null;
  anchor: AnchorRect;
  onClose: () => void;
  /** GH #287: a rejection is shown in the picker's error slot. */
  onAccentChange: (color: string | null) => void | Promise<void>;
};

// GH #272: the one palette Settings › General offers too (lib/repositoryAccent).
// "Use the name's colour" clears it, so the chip takes one from the name.

const EMOJI_QUICK = [
  "💼", "🎨", "🔬", "🤖", "📦",
  "🧪", "⚙️", "🌱", "🚀", "✏️",
];

const PICKER_WIDTH = 280;
const PICKER_ESTIMATED_HEIGHT = 380;
const GAP = 6;

export function WorkspaceIconPicker({
  workspaceId,
  name,
  icon,
  accentColor,
  anchor,
  onClose,
  onAccentChange,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const setIcon = useWorkspaces((s) => s.setIcon);
  const setIconImage = useWorkspaces((s) => s.setIconImage);
  const [emojiInput, setEmojiInput] = useState("");
  const [imageError, setImageError] = useState<Failure | null>(null);

  // A dialog takes focus when it opens, so Esc and Tab work from the start.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Compute position once at mount. Flip above anchor if the picker
  // would overflow the viewport bottom.
  const position = (() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const spaceBelow = vh - anchor.bottom;
    const flipUp = spaceBelow < PICKER_ESTIMATED_HEIGHT + GAP * 2;
    const top = flipUp
      ? Math.max(GAP, anchor.top - PICKER_ESTIMATED_HEIGHT - GAP)
      : anchor.bottom + GAP;
    const left = Math.min(
      Math.max(GAP, anchor.left),
      vw - PICKER_WIDTH - GAP,
    );
    return { top, left };
  })();

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const node = ref.current;
      if (!node) return;
      if (node.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function pickColor(c: string | null) {
    setImageError(null);
    // Keep open — user may want to iterate. GH #287: a failure is said here.
    Promise.resolve(onAccentChange(c)).catch((e: unknown) =>
      setImageError(failure("Couldn't change the colour.", e)),
    );
  }

  async function pickEmoji(value: string) {
    try {
      await setIcon(workspaceId, { kind: "emoji", value });
      setEmojiInput("");
    } catch (e) {
      // GH #287: said in the picker, not only in the console.
      setImageError(failure("Couldn't set the icon.", e));
    }
  }

  async function commitEmojiInput() {
    const trimmed = emojiInput.trim();
    if (!trimmed) return;
    // Take the first grapheme so users typing a sequence don't end up
    // with a chip full of text. ZWJ-emoji families come through as one
    // entry of `Array.from` only on some platforms — close enough for
    // a personal-tool first-letter heuristic.
    const first = Array.from(trimmed)[0];
    if (!first) return;
    await pickEmoji(first);
  }

  async function uploadImage() {
    setImageError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      const srcPath = typeof picked === "string" ? picked : null;
      if (!srcPath) return;
      await setIconImage(workspaceId, srcPath);
      onClose();
    } catch (e) {
      // Backend errors include the magic-byte rejection + 2 MB cap
      // messages; surface them inline so the user knows why upload
      // bounced.
      const msg = e instanceof Error ? e.message : String(e);
      setImageError({ sentence: msg, details: "" });
    }
  }

  async function resetToMonogram() {
    try {
      await setIcon(workspaceId, null);
      onClose();
    } catch (e) {
      setImageError(failure("Couldn't reset the icon.", e));
    }
  }

  const imagePreviewSrc =
    icon?.kind === "image"
      ? `${convertFileSrc(icon.path)}?v=${icon.mtime}`
      : null;

  // A colour an older picker stored is shown as the preset it reads as.
  const chosen = accentColor ? accentChoice(accentColor)?.value ?? accentColor : null;

  return createPortal(
    <div
      ref={ref}
      className="ux-popover ux-icon-picker"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: PICKER_WIDTH,
      }}
      role="dialog"
      aria-label={`Icon and colour for ${name}`}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <section className="ux-icon-picker-section" aria-labelledby="ws-icon-picker-colour">
        <div id="ws-icon-picker-colour" className="ux-icon-picker-caption">
          Colour
        </div>
        <Swatches
          value={chosen}
          options={ACCENT_CHOICES}
          onChange={(v) => pickColor(v)}
          name={accentColor ? accentName(accentColor) : "From the name"}
          label="Colour"
        />
        <div className="ux-icon-picker-actions">
          <CBtn size="sm" disabled={!accentColor} onClick={() => pickColor(null)}>
            Use the name&rsquo;s colour
          </CBtn>
        </div>
      </section>

      <section className="ux-icon-picker-section" aria-labelledby="ws-icon-picker-emoji">
        <div id="ws-icon-picker-emoji" className="ux-icon-picker-caption">
          Emoji
        </div>
        <div className="ux-icon-picker-emoji">
          {EMOJI_QUICK.map((e) => {
            const selected = icon?.kind === "emoji" && icon.value === e;
            return (
              <CBtn
                key={e}
                size="sm"
                active={selected}
                onClick={() => pickEmoji(e)}
                aria-label={`Set emoji ${e}`}
                aria-pressed={selected}
              >
                {e}
              </CBtn>
            );
          })}
        </div>
        <TextField
          value={emojiInput}
          onChange={setEmojiInput}
          onCommit={() => void commitEmojiInput()}
          label="Any emoji"
          placeholder={`Paste any emoji (or ${isWindows() ? "Win+." : "⌃⌘Space"})`}
        />
      </section>

      <section className="ux-icon-picker-section" aria-labelledby="ws-icon-picker-image">
        <div id="ws-icon-picker-image" className="ux-icon-picker-caption">
          Image
        </div>
        {imagePreviewSrc ? (
          <div className="ux-icon-picker-actions">
            <img className="ux-icon-picker-preview" src={imagePreviewSrc} alt="" />
            <CBtn size="sm" onClick={uploadImage}>
              Replace…
            </CBtn>
            <CBtn size="sm" onClick={resetToMonogram}>
              Remove
            </CBtn>
          </div>
        ) : (
          <div className="ux-icon-picker-actions">
            <CBtn size="sm" onClick={uploadImage}>
              Upload image…
            </CBtn>
          </div>
        )}
        {imageError && (
          <div className="ux-inline-alert" role="alert">
            <FailureText failure={imageError} />
          </div>
        )}
        <p className="ux-icon-picker-hint">PNG, JPG or WebP, up to 2 MB. SVG isn&rsquo;t supported.</p>
      </section>

      <div className="ux-icon-picker-foot">
        <CBtn
          size="sm"
          onClick={resetToMonogram}
          disabled={!icon || icon.kind === "monogram"}
          title="Clear the emoji or image and use the name's first letter"
        >
          Use monogram
        </CBtn>
      </div>
    </div>,
    document.body,
  );
}
