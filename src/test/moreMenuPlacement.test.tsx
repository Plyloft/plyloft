// Walk follow-ups 2026-10-19 (Windows): the skill page's `⋯` opened leftwards
// past the panel's edge, and a row's at the bottom of the list past the
// window's. Measured once drawn, the menu turns where all of it is seen.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoreMenu } from "../components/ux";
import { act } from "@testing-library/react";
import { renderUi, screen } from "./render";

type Box = { left: number; top: number; width: number; height: number };
const rect = ({ left, top, width, height }: Box) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** jsdom's window is 1024 × 768. The panel clips at `panel`; the trigger sits at `anchor`; the menu is
 *  drawn (by the stylesheet's default) under it, right edges together — also
 *  once turned: a re-measure starts from the stylesheet's own place, which is
 *  what MenuList resets to first. */
function layout(panel: Box, anchor: Box, menu: { width: number; height: number }) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("ux-menu")) {
      return rect({ left: anchor.left + anchor.width - menu.width, top: anchor.top + anchor.height + 4, ...menu });
    }
    if (this.classList.contains("ux-more")) return rect(anchor);
    if (this.getAttribute("data-panel") !== null) return rect(panel);
    return rect({ left: 0, top: 0, width: 0, height: 0 });
  });
}

function draw() {
  return renderUi(
    <div>
      <style>{".ux-menu { position: absolute; } [data-panel] { overflow: hidden; }"}</style>
      <div data-panel="">
        <MoreMenu items={[{ label: "Open in Code", onSelect: () => {} }]} label="More for mine" />
      </div>
    </div>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("a ⋯ menu stays in view", () => {
  it("opens rightwards when leftwards would pass the panel's left edge", async () => {
    layout({ left: 300, top: 0, width: 724, height: 768 }, { left: 390, top: 100, width: 30, height: 20 }, { width: 260, height: 200 });
    const { user } = draw();
    await user.click(screen.getByRole("button", { name: "More for mine" }));
    const menu = screen.getByRole("menu", { name: "More for mine" });
    expect(menu.classList.contains("ux-menu--start")).toBe(true);
    expect(menu.classList.contains("ux-menu--up")).toBe(false);
  });

  it("opens above when the bottom of the panel would cut it", async () => {
    layout({ left: 0, top: 0, width: 1024, height: 768 }, { left: 970, top: 720, width: 30, height: 20 }, { width: 260, height: 220 });
    const { user } = draw();
    await user.click(screen.getByRole("button", { name: "More for mine" }));
    const menu = screen.getByRole("menu", { name: "More for mine" });
    expect(menu.classList.contains("ux-menu--up")).toBe(true);
    expect(menu.classList.contains("ux-menu--start")).toBe(false);
  });

  it("measures again when the window changes while it is open", async () => {
    layout({ left: 0, top: 0, width: 1024, height: 768 }, { left: 970, top: 100, width: 30, height: 20 }, { width: 260, height: 220 });
    const { user } = draw();
    await user.click(screen.getByRole("button", { name: "More for mine" }));
    const menu = screen.getByRole("menu", { name: "More for mine" });
    expect(menu.className).toBe("ux-menu");
    // The list scrolled: the trigger is now at the window's bottom.
    vi.restoreAllMocks();
    layout({ left: 0, top: 0, width: 1024, height: 768 }, { left: 970, top: 720, width: 30, height: 20 }, { width: 260, height: 220 });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((done) => requestAnimationFrame(() => done(null)));
    });
    expect(menu.classList.contains("ux-menu--up")).toBe(true);
    // Focus stayed in the menu.
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it("scrolls inside the room it has when it fits neither below nor above", async () => {
    layout({ left: 0, top: 0, width: 1024, height: 768 }, { left: 970, top: 374, width: 30, height: 20 }, { width: 260, height: 460 });
    const { user } = draw();
    await user.click(screen.getByRole("button", { name: "More for mine" }));
    const menu = screen.getByRole("menu", { name: "More for mine" });
    // Below: 768 − 394 − 4 = 370; above: 374 − 4 = 370 — not more, so below,
    // capped at 370 − 4.
    expect(menu.classList.contains("ux-menu--up")).toBe(false);
    expect(menu.style.maxHeight).toBe("366px");
  });

  it("stays as drawn when it fits", async () => {
    layout({ left: 0, top: 0, width: 1024, height: 768 }, { left: 970, top: 100, width: 30, height: 20 }, { width: 260, height: 200 });
    const { user } = draw();
    await user.click(screen.getByRole("button", { name: "More for mine" }));
    expect(screen.getByRole("menu", { name: "More for mine" }).className).toBe("ux-menu");
  });
});
