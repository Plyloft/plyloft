// 1.176.1: a release done while its install step waits for this Mac's OK
// says so in a toast with Review — and a toast over a sheet can't be reached
// by keyboard, so the finished Release sheet offers Review itself.
import { describe, expect, it, vi } from "vitest";
import { ReleaseFollow } from "../components/ReleaseProgress";
import type { ShipResult } from "../ipc";
import { renderUi, screen } from "./render";

const result = { commitSha: "abc12345", shippedVersion: "3.0.2", releaseKind: "push_only", installLog: "", tag: "v3.0.2" } as unknown as ShipResult;

function follow(heldInstall: { label: string; onClick: () => void } | null, done: boolean) {
  return renderUi(
    <ReleaseFollow
      workspaceId="ws-1"
      tag="v3.0.2"
      branch="main"
      kind="push_only"
      throughPr={false}
      pr={null}
      problem={null}
      stage="tagged"
      cardCount={1}
      lede=""
      done={done ? { result, cards: 1, others: 0, tag: "v3.0.2" } : null}
      pressing={false}
      canStop={false}
      stopping={false}
      failure={null}
      onStop={() => {}}
      onContinue={() => {}}
      onClose={() => {}}
      onReread={() => {}}
      heldInstall={heldInstall}
    />,
  );
}

describe("the finished Release sheet and a held install step", () => {
  it("offers Review beside Done, and it opens the install sheet's press", async () => {
    const onClick = vi.fn();
    const view = follow({ label: "Review", onClick }, true);
    await view.user.click(await screen.findByRole("button", { name: "Review" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("offers nothing extra when nothing is held", async () => {
    follow(null, true);
    await screen.findByRole("button", { name: "Done" });
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });
});

// The sheet's own Review: shown while the step waits for this Mac's OK, gone
// once pressed, once the OK is given, and for another release.
import { ReleaseSheet } from "../components/ReleaseSheet";
import { useChecksConsent } from "../store/checksConsentStore";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, waitFor, within } from "./render";
import { PRO_GATES, setPlanGates } from "./planGates";
import { relScope, releaseFixtures } from "./releaseFixtures";

const install = (needsOk: boolean) => ({
  checks: { needsOk: false },
  install: { needsOk, approved: "scripts/install.sh", current: "scripts/install.sh", who: "Giulia", changedAt: 1, waiting: needsOk ? { tag: "v3.0.2", at: 1 } : null },
});

async function released() {
  useWorkspaces.setState({ workspaces: [{ id: "ws-1", name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: "ws-1" });
  useKanban.setState({ byWorkspace: { "ws-1": { cards: [], loaded: true } } } as never);
  setPlanGates(PRO_GATES);
  const view = renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1", areaId: null }} onClose={() => {}} />, {
    fixtures: {
      ...releaseFixtures(relScope({ readyCardIds: [] })),
      release_area: { commitSha: "abc12345", shippedVersion: "3.0.2", releaseKind: "push_only", installLog: "", tag: "v3.0.2", installScript: "scripts/install.sh" },
      checks_consent_view: () => install(true),
      kanban_load: { cards: [] },
    },
    withToasts: true,
  });
  const sheet = await screen.findByRole("dialog", { name: "Release lyra" });
  const press = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
  await waitFor(() => expect(press.disabled).toBe(false));
  await view.user.click(press);
  const done = await screen.findByRole("dialog", { name: "v3.0.2 is released" });
  return { view, done };
}

describe("the Release sheet's own Review", () => {
  it("is offered while the install step waits, and goes once pressed", async () => {
    const { view, done } = await released();
    await view.user.click(await within(done).findByRole("button", { name: "Review" }));
    expect(useChecksConsent.getState().installSheet).toBe("ws-1");
    await waitFor(() => expect(within(done).queryByRole("button", { name: "Review" })).toBeNull());
    view.tauri.allowUnhandled();
  });

  it("goes once the OK is given", async () => {
    const { view, done } = await released();
    await within(done).findByRole("button", { name: "Review" });
    act(() => useChecksConsent.setState({ byWorkspace: { "ws-1": install(false) as never } }));
    await waitFor(() => expect(within(done).queryByRole("button", { name: "Review" })).toBeNull());
    view.tauri.allowUnhandled();
  });
});
