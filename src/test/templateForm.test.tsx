// GH #297: a failure is said where it lives, never only as a toast carrying
// the raw error. The tile-layout sheet's new-template form marks its own
// empty name, and a failed save is an alert in the sheet with the raw text
// behind Details.
import { describe, expect, it } from "vitest";
import { WorkspaceTemplateModal } from "../components/WorkspaceTemplateModal";
import { useToasts } from "../store/toastStore";
import { vi } from "vitest";
import { act, nextFrame, renderUi, screen, waitFor } from "./render";

function open(fixtures: Record<string, unknown> = {}) {
  return renderUi(
    <WorkspaceTemplateModal
      workspaceLabel="Lyra"
      claudeAvailable
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
    { fixtures: { templates_list: [], ...fixtures } as never },
  );
}

describe("the new custom template form", () => {
  it("marks an empty name on the field and pushes no toast", async () => {
    const { user, tauri } = open();
    await user.click(screen.getByRole("button", { name: /New template/ }));
    await user.click(screen.getByRole("button", { name: "Save template" }));
    const name = screen.getByRole("textbox", { name: "Template name" });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const said = document.getElementById(name.getAttribute("aria-describedby") ?? "");
    expect(said?.textContent).toBe("Give the template a name.");
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(tauri.callsOf("templates_create")).toHaveLength(0);
  });

  it("says a failed save in the sheet, the raw error only behind Details", async () => {
    const { user } = open({
      templates_create: () => {
        throw "EACCES: permission denied, open templates.json";
      },
    });
    await user.click(screen.getByRole("button", { name: /New template/ }));
    await user.type(screen.getByRole("textbox", { name: "Template name" }), "Reviewer pair");
    await user.click(screen.getByRole("button", { name: "Save template" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^The template wasn't saved\./);
    const details = alert.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector(".ux-details-body")?.textContent).toBe(
      "EACCES: permission denied, open templates.json",
    );
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(0));
  });
});

describe("the layout sheet's words (GH #326)", () => {
  it("says what it opens, and draws + as an icon", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Several sessions at once");
    expect(dialog.textContent).toContain("Opens these sessions in Lyra, next to the ones already running.");
    expect(dialog.textContent).not.toMatch(/already added|canceling changes nothing|\bsh \+/);
    const add = screen.getByRole("button", { name: /New template/ });
    expect(add.textContent).toBe("New template");
    expect(add.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /1 shell and 3 Claude sessions/ })).toBeTruthy();
  });
});

// GH #280: a custom template's delete is a real button beside its radio,
// reached by Tab, and Enter on it deletes — it never applies the layout.
describe("a custom template's delete", () => {
  it("is a named button outside the radio, reachable by keyboard", async () => {
    // jsdom lays nothing out; the sheet's Tab trap only walks what has a box.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const onConfirm = vi.fn();
    const devPair = {
      id: "dp",
      label: "Dev pair",
      description: "",
      tiles: [{ kind: "claude" }, { kind: "shell" }],
      createdAt: 1,
      updatedAt: 1,
    };
    const { user, tauri } = renderUi(
      <WorkspaceTemplateModal
        workspaceLabel="Lyra"
        claudeAvailable
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
      { fixtures: { templates_list: [devPair], templates_delete: null } as never },
    );
    const del = await screen.findByRole("button", { name: "Delete Dev pair" });
    // Not nested inside any radio.
    expect(del.closest("[role='radio']")).toBeNull();
    const radio = screen.getByRole("radio", { name: /Dev pair/ });
    expect(radio.querySelector("button, [onclick]")).toBeNull();
    await nextFrame();
    act(() => radio.focus());
    expect(document.activeElement).toBe(radio);
    await user.tab();
    expect(document.activeElement).toBe(del);
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(tauri.callsOf("templates_delete")).toEqual([
        { cmd: "templates_delete", args: { id: "dp" } },
      ]),
    );
  });
});
