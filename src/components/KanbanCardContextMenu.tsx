import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MenuList, type MenuItem } from "./ux";

type Props = {
  /** Title of the card — the menu's accessible name. */
  cardTitle: string;
  /** Anchor coords (viewport) — the pointer, or the focused card's left
   *  edge when the menu key or Shift+F10 opened it. */
  x: number;
  y: number;
  items: MenuItem[];
  /** `refocus`: put the keyboard back on the card (Esc, Tab, an item). */
  onClose: (refocus: boolean) => void;
};

/**
 * v1.31.0: right-click menu for a Board card. QoL 1.168 (block 10, C6): the
 * shared menu (`MenuList`: ↑ ↓ Home End Esc, 14 px entries, kept on screen)
 * with Open, the moves, Archive and Delete — not Delete alone — and reachable
 * from the keyboard (the menu key or Shift+F10 on a focused card). Closes on
 * a click outside.
 */
export function KanbanCardContextMenu({ cardTitle, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDown(e: PointerEvent) {
      const node = ref.current;
      if (!node || node.contains(e.target as Node)) return;
      onClose(false);
    }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // In the body: a column scrolls (and clips), and the menu measures the
  // room it has from the window, not from the column.
  return createPortal(
    <div
      ref={ref}
      className="kanban-card-context-menu"
      // A point the menu hangs from; MenuList turns it to stay on screen.
      style={{ top: y, left: x }}
    >
      <MenuList items={items} label={`Card: ${cardTitle}`} onClose={onClose} />
    </div>,
    document.body,
  );
}
