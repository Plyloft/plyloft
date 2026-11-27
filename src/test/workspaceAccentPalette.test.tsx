// GH #272: the workspace colour has one palette. The switcher's "Icon and
// colour" offers the same four as Settings › General, a colour an older picker
// stored is shown chosen as the preset it reads as, and each circle is painted
// with the value it writes.
import { describe, expect, it, vi } from "vitest";
import { WorkspaceIconPicker } from "../components/WorkspaceIconPicker";
import { Swatches } from "../components/ux";
import { ACCENT_CHOICES, accentChoice, accentName } from "../lib/repositoryAccent";
import { renderUi, screen } from "./render";

const ANCHOR = { left: 0, top: 0, bottom: 20 };

function picker(accentColor: string | null, onAccentChange = vi.fn()) {
  renderUi(
    <WorkspaceIconPicker
      workspaceId="w"
      name="ply"
      icon={null}
      accentColor={accentColor}
      anchor={ANCHOR}
      onClose={() => {}}
      onAccentChange={onAccentChange}
    />,
  );
  return onAccentChange;
}

describe("the workspace colour palette", () => {
  // GH #289: the same ux Swatches as General, then a way back to the
  // name's own colour.
  it("the switcher offers General's four, then the name's colour", () => {
    picker(null);
    for (const c of ACCENT_CHOICES) {
      expect(screen.getByRole("radio", { name: c.name }).style.background).not.toBe("");
    }
    expect(screen.queryByRole("radio", { name: "blue" })).toBeNull();
    expect(screen.getByText("From the name")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Use the name’s colour" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("an older picker's colour is shown chosen as its preset", () => {
    picker("#dc2626");
    expect(screen.getByRole("radio", { name: "Sunset" }).getAttribute("aria-checked")).toBe("true");
  });

  it("picking a colour writes the value General shows chosen", async () => {
    const onAccentChange = picker(null);
    screen.getByRole("radio", { name: "Magenta" }).click();
    const written = onAccentChange.mock.calls[0][0] as string;
    expect(accentChoice(written)?.name).toBe("Magenta");
  });

  it("General selects Violet for the real Plyloft workspace's #7c3aed, and shows no hex", () => {
    const stored = "#7c3aed";
    renderUi(
      <Swatches
        value={accentChoice(stored)?.value ?? stored}
        options={ACCENT_CHOICES}
        name={accentName(stored)}
        onChange={() => {}}
        label="Accent colour"
      />,
    );
    expect(screen.getByRole("radio", { name: "Violet" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Violet")).toBeTruthy();
    expect(screen.queryByText(/#/)).toBeNull();
    // The circle is painted with the value it writes, not a theme token.
    for (const c of ACCENT_CHOICES) {
      expect(screen.getByRole("radio", { name: c.name }).style.background).not.toBe("");
    }
  });
});
