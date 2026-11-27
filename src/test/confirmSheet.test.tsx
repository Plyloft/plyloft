// GH #281: a yes/no question is the confirm Sheet, never a native macOS alert.
// `confirmSheet` resolves with the answer; the one host draws the question;
// with no host the answer is Cancel (fail closed, as the native helper was).
import { describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { WorkspaceTemplateModal } from "../components/WorkspaceTemplateModal";
import { confirmChoice, confirmSheet, useConfirmSheet } from "../store/confirmStore";
import { otherDeviceSheet } from "../lib/cardClaim";
import { act, renderUi, screen, waitFor, within } from "./render";

describe("confirmSheet", () => {
  it("asks in the confirm Sheet and resolves with the answer", async () => {
    const { user } = renderUi(<div />);
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = confirmSheet({ title: "Abort this swarm?", confirmLabel: "Abort swarm", destructive: true }).then(
        (ok) => ok,
      );
    });
    const sheet = await screen.findByRole("dialog", { name: "Abort this swarm?" });
    expect(sheet.className).toContain("ux-sheet--confirm");
    await user.click(within(sheet).getByRole("button", { name: "Abort swarm" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      answer = confirmSheet({ title: "Reset the sort order?" }).then((ok) => ok);
    });
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  // Owner decision 2026-09-30: a destructive confirm opens on Cancel, so
  // Enter never destroys; one that loses nothing keeps focus on its confirm.
  it("opens a destructive confirm with focus on Cancel, so Enter declines", async () => {
    const { user } = renderUi(<div />);
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => {
      answer = confirmSheet({ title: "Abort this swarm?", confirmLabel: "Abort swarm", destructive: true }).then(
        (ok) => ok,
      );
    });
    const sheet = await screen.findByRole("dialog", { name: "Abort this swarm?" });
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard("{Enter}");
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      answer = confirmSheet({ title: "Reset the sort order?", confirmLabel: "Reset order" }).then((ok) => ok);
    });
    const plain = await screen.findByRole("dialog", { name: "Reset the sort order?" });
    const confirm = within(plain).getByRole("button", { name: "Reset order" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    await user.keyboard("{Enter}");
    await expect(answer).resolves.toBe(true);
  });

  // 1.173.0 (C2, scene 1): a card another of this person's computers took
  // asks first, focus on Cancel; its three buttons in the mockup's order.
  it("asks before a start on a card your other Mac took, focus on Cancel", async () => {
    const { user } = renderUi(<div />);
    const words = otherDeviceSheet(
      { kind: "elsewhere", name: "MacBook Pro", at: Date.now() - 2 * 3_600_000 },
      "Search terms: sort by impressions",
      Date.now(),
    );
    let answer = Promise.resolve("dismiss" as string);
    act(() => {
      answer = confirmChoice({ ...words, focusCancel: true });
    });
    const sheet = await screen.findByRole("dialog", { name: "This card is being built on your MacBook Pro" });
    expect(sheet.textContent).toContain("was taken there 2 h ago");
    expect(sheet.textContent).toContain("its copy stays there until you delete it.");
    const names = within(sheet)
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => ["Cancel", "Start here too", "Take it over here"].includes(t ?? ""));
    expect(names).toEqual(["Cancel", "Start here too", "Take it over here"]);
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard("{Enter}");
    await expect(answer).resolves.toBe("cancel");

    act(() => {
      answer = confirmChoice({ ...words, focusCancel: true });
    });
    await user.click(await screen.findByRole("button", { name: "Start here too" }));
    await expect(answer).resolves.toBe("alt");
    act(() => {
      answer = confirmChoice({ ...words, focusCancel: true });
    });
    await user.click(await screen.findByRole("button", { name: "Take it over here" }));
    await expect(answer).resolves.toBe("confirm");
  });

  it("fails closed with no host on screen", async () => {
    renderUi(<div />);
    cleanup();
    expect(useConfirmSheet.getState().hosts).toBe(0);
    expect(await confirmSheet({ title: "Delete it?" })).toBe(false);
  });

  it("deletes a custom template only once its Sheet is confirmed", async () => {
    const template = {
      id: "t1",
      label: "Reviewer pair",
      description: "",
      tiles: [{ kind: "shell" }],
      createdAt: 1,
      updatedAt: 1,
    };
    const { user, tauri } = renderUi(
      <WorkspaceTemplateModal
        workspaceLabel="Lyra"
        claudeAvailable
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { fixtures: { templates_list: [template], templates_delete: null } as never },
    );
    // GH #280: a named button beside the radio.
    const remove = await screen.findByRole("button", { name: "Delete Reviewer pair" });
    await user.click(remove);
    const sheet = await screen.findByRole("dialog", { name: "Delete the custom template “Reviewer pair”?" });
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("templates_delete")).toHaveLength(0);

    await user.click(remove);
    await user.click(
      within(await screen.findByRole("dialog", { name: /Delete the custom template/ })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    await act(async () => {});
    expect(tauri.callsOf("templates_delete")).toHaveLength(1);
  });

  // Challenger, 2026-09-30: the modal's window-level Enter caught Enter in
  // the delete confirm above it and applied the layout.
  it("Enter in the delete confirm answers it, not the layout underneath", async () => {
    const template = {
      id: "t1",
      label: "Reviewer pair",
      description: "",
      tiles: [{ kind: "shell" }],
      createdAt: 1,
      updatedAt: 1,
    };
    const applied: string[] = [];
    const { user, tauri } = renderUi(
      <WorkspaceTemplateModal
        workspaceLabel="Lyra"
        claudeAvailable
        onConfirm={(t) => applied.push(t.id)}
        onCancel={() => {}}
      />,
      { fixtures: { templates_list: [template], templates_delete: null } as never },
    );
    await user.click(await screen.findByRole("radio", { name: /Reviewer pair/ }));
    await user.click(screen.getByRole("button", { name: "Delete Reviewer pair" }));
    const sheet = await screen.findByRole("dialog", { name: /Delete the custom template/ });
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: /Delete the custom template/ })).toBeNull();
    expect(applied).toEqual([]);
    expect(tauri.callsOf("templates_delete")).toHaveLength(0);
  });
});
