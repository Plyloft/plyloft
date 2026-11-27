// GH #222 review 1: Ship as the person meets it once the release push is
// bounded and Ship runs off the main thread (the UI stays live while it runs).
//
//  1. (1.174.0, DR3: the Release sheet) its press is off while this
//     workspace's release or land is running (`shipInFlight`); Close is
//     allowed while it runs, and the outcome is toasted.
//  2. A push stopped at its bound (`{ unpublished }`) closes the dialog,
//     announces `Ship stopped: v1.0.1 isn't published yet.`, and the card's
//     Ship step draws the block (what happened · untouched · what to do,
//     `Publish v1.0.1`, the SHA and `git ls-remote` under Details). A dialog
//     that is gone by then loses nothing: the block and the toast still come.
//  3. The Ship dialog offers `Publish v1.0.1 (already committed)` for the
//     card's pending release and sends that version, not the next one; the
//     block goes once the card ships.
//  4. Any other failure after the dialog is gone is toasted, not lost.
import { describe, expect, it, vi } from "vitest";
import { ReleaseSheet } from "../components/ReleaseSheet";
import { relScope, releaseFixtures } from "./releaseFixtures";
import { PRO_GATES, setPlanGates } from "./planGates";
import { CardShipStep } from "../components/CardShipStep";
import type {
  KanbanCard,
  PendingReleaseView,
  ReleaseUnpublished,
  ShipAuditReport,
  ShipResult,
} from "../ipc";
import { useErrorBlocks } from "../store/errorBlockStore";
import { presentCard } from "../lib/cardPresentation";
import { useCardLive } from "../hooks/useCardLive";
import { cardDeliveryPath, releasePath } from "../lib/deliveryStage";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useEditor } from "../store/editorStore";
import { useUi } from "../store/uiStore";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";

const WS = "ws-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Deploy skill",
  columnId: "complete",
  verifyStatus: "passed",
  shipStatus: "unshipped",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
};

function audit(over: Partial<ShipAuditReport> = {}): ShipAuditReport {
  return {
    activeSwarms: [],
    activeIntakes: [],
    activeRunCount: 0,
    branch: "main",
    branchOk: true,
    currentVersion: "1.0.1",
    suggestedNextVersion: "1.0.2",
    shipInFlight: false,
    pendingRelease: null,
    ...over,
  };
}

const view: PendingReleaseView = {
  version: "1.0.1",
  tag: "v1.0.1",
  branch: "main",
  commitSha: SHA,
  cardIds: [card.id],
  releaseKind: "push_only",
  stoppedAt: "branch",
  cause: "timedOut",
  output: null,
  bound: "5 minutes",
  createdAt: 1,
  problem: null,
};
const pending: PendingReleaseView = view;
const stopped: ReleaseUnpublished = { unpublished: view };

const shipped: ShipResult = {
  commitSha: SHA,
  shippedVersion: "1.0.1",
  releaseKind: "push_only",
  installLog: "",
  fastForwarded: true,
};

/** What `ship_pending_release` answers: the backend's record (review 2). */
let recorded: PendingReleaseView | null = null;
/** Review 3: why the record can't be read, when it can't. */
let unreadable: string | null = null;
const recordFixture = { ship_pending_release: () => ({ release: recorded, unreadable }) };

function seedBoard() {
  recorded = null;
  unreadable = null;
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  useKanban.setState({ byWorkspace: { [WS]: { cards: [card] } } } as never);
}

/** A command whose answer the test gives later. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const counts = { ship_pending_count: 0, ship_pending_cards: null, ship_unverified_count: 0 };

describe("the Ship step's record (GH #222 review 2)", () => {
  function renderStep() {
    return renderUi(
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={() => {}} />
      </section>,
      {
        fixtures: {
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          ...recordFixture,
          ship_pending_release_dismiss: () => {
            recorded = null;
            unreadable = null;
            return null;
          },
        },
      },
    );
  }

  it("is read from the backend on mount, and goes when the record is cleared any other way", async () => {
    seedBoard();
    recorded = view;
    const { tauri } = renderStep();
    expect(await screen.findByText("v1.0.1 isn't published yet.")).toBeTruthy();
    // Cleared elsewhere (another window's publish): the event, then the read.
    recorded = null;
    await act(async () => tauri.emit("ship-pending-release-changed", WS));
    await waitFor(() => expect(screen.queryByText("v1.0.1 isn't published yet.")).toBeNull());
    // Another workspace's event is not this one's.
    recorded = view;
    await act(async () => tauri.emit("ship-pending-release-changed", "ws-other"));
    expect(screen.queryByText("v1.0.1 isn't published yet.")).toBeNull();
  });

  it("Dismiss asks first, says what stays local, then clears it (control: Cancel keeps it)", async () => {
    seedBoard();
    recorded = view;
    const { user, tauri } = renderStep();
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    const confirm = screen.getByRole("dialog");
    expect(within(confirm).getByText(/stay on this Mac only/)).toBeTruthy();
    expect(within(confirm).getByText(/nothing on GitHub changes/)).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("ship_pending_release_dismiss")).toHaveLength(0);
    expect(screen.getByText("v1.0.1 isn't published yet.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(tauri.callsOf("ship_pending_release_dismiss")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("v1.0.1 isn't published yet.")).toBeNull());
  });

  it("one that can't be published from here says why and offers only Dismiss", async () => {
    seedBoard();
    recorded = { ...view, problem: "The tag v1.0.1 no longer exists on this Mac, so Plyloft can't tell what to publish." };
    renderStep();
    expect(await screen.findByText("v1.0.1 can't be published from here.")).toBeTruthy();
    expect(screen.getByText(/no longer exists on this Mac/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish v1.0.1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("a refused push says GitHub refused it, with git's words under Details", async () => {
    seedBoard();
    recorded = { ...view, cause: "refused", output: "git push origin main failed: no releases today" };
    renderStep();
    expect(await screen.findByText(/GitHub refused the push of main/)).toBeTruthy();
    expect(screen.getByText(/no releases today/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish v1.0.1" })).toBeTruthy();
  });
});

describe("a protected branch (R9)", () => {
  const protectedView: PendingReleaseView = {
    ...view,
    cause: "refused",
    output: "git push origin main failed: remote: error: GH006: Protected branch update failed for refs/heads/main.",
    protected: true,
    undo: true,
  };
  function renderStep(undo: () => unknown) {
    return renderUi(
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={() => {}} />
      </section>,
      {
        fixtures: {
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          ...recordFixture,
          ship_pending_release_undo: undo,
        },
      },
    );
  }

  it("says the branch is protected and Undo asks first, then clears it (control: Cancel keeps it)", async () => {
    seedBoard();
    recorded = protectedView;
    const { user, tauri } = renderStep(() => {
      recorded = null;
      return "Undid v1.0.1: main is back at 01234567, where the release began.";
    });
    expect(
      await screen.findByText(
        "main is protected, so Plyloft can't push a release to it directly. On GitHub, Plyloft releases through a pull request instead.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo the local release" }));
    const confirm = screen.getByRole("dialog");
    expect(within(confirm).getByText(/deletes the tag v1\.0\.1 on this Mac/)).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("ship_pending_release_undo")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Undo the local release" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Undo the local release" }));
    await waitFor(() => expect(tauri.callsOf("ship_pending_release_undo")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/main is protected, so Plyloft/)).toBeNull());
  });

  it("a refused Undo says why and keeps the block; no Undo when it isn't offered", async () => {
    seedBoard();
    recorded = protectedView;
    const { user } = renderStep(() => {
      throw "Plyloft can't undo v1.0.1: v1.0.1 is on GitHub already. Nothing was changed.";
    });
    await user.click(await screen.findByRole("button", { name: "Undo the local release" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Undo the local release" }));
    expect(await screen.findByText("The local release couldn't be undone.")).toBeTruthy();
    expect(screen.getByText(/main is protected, so Plyloft/)).toBeTruthy();

    const { readPendingRelease, unpublishedReleaseError } = await import("../lib/uxError");
    const without = unpublishedReleaseError(readPendingRelease({ ...protectedView, undo: false })!);
    expect(without.actions.map((a) => a.id)).toEqual(["publish", "dismiss"]);
    expect(readPendingRelease({ ...view, protected: undefined, undo: undefined })!.undo).toBe(false);
  });
});

// G8 (1.170.0): a release through a pull request is a state of the card —
// "Release pull request open", "Merging the release", "Tagged" — with Open on
// GitHub, Continue, Update the release when GitHub's main moved on under it,
// and Dismiss; one that can't go on by itself is the error shape.
describe("a release through a pull request (G8)", () => {
  const pr = {
    step: "merging" as const,
    branch: "plyloft/release-v1.0.1",
    head: SHA,
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    waiting: "#12 waits for its checks on GitHub.",
    outdated: false,
    checksRun: ["scripts/check.sh"],
    checksNotRun: [],
  };
  const onTheWay: PendingReleaseView = {
    ...view,
    stoppedAt: null,
    cause: null,
    bound: null,
    stage: "committing",
    pr,
  };
  function renderStep(fixtures: Record<string, unknown> = {}) {
    return renderUi(
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={() => {}} />
      </section>,
      {
        fixtures: {
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          ...recordFixture,
          open_web_link: () => undefined,
          ...fixtures,
        },
      },
    );
  }

  // 1.174.0 (DR4): a card in a release on its way points to the Release
  // sheet, which follows it; the card has no release of its own.
  it("says how far it got, and Show it opens the Release sheet", async () => {
    seedBoard();
    recorded = onTheWay;
    const opened = vi.fn();
    renderUi(
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={opened} />
      </section>,
      { fixtures: { improvement_proposal_state: null, improvement_proposal_trust_stopped: null, ...recordFixture } },
    );
    expect(await screen.findByText("v1.0.1: Merging the release #12")).toBeTruthy();
    expect(screen.getByText("This card is in v1.0.1. The Release sheet follows it.")).toBeTruthy();
    for (const name of ["Continue v1.0.1", "Update the release", "Dismiss", "Open on GitHub"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });


  it("behind main on GitHub, the card still points to the sheet (Update the release is the sheet's)", async () => {
    seedBoard();
    recorded = { ...onTheWay, pr: { ...pr, step: "open", outdated: true, waiting: "#12 is behind main on GitHub." } };
    renderStep();
    expect(await screen.findByText("v1.0.1: Release pull request open #12")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update the release" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show it" })).toBeTruthy();
  });


  it("one that can't go on by itself is the error shape, with Dismiss", async () => {
    seedBoard();
    recorded = { ...onTheWay, problem: "The release pull request #12 was closed on GitHub without being merged." };
    renderStep();
    expect(await screen.findByText("v1.0.1's release pull request can't go on by itself.")).toBeTruthy();
    expect(screen.getByText(/closed on GitHub without being merged/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open on GitHub" })).toBeTruthy();
  });

  // G8 fixes (major 4, major 3): Dismiss says what it does on GitHub — the
  // pull request stays, its auto-merge is turned off — and what Plyloft
  // said back is shown; the record says what it holds back, as it is.
  // G8 fixes (major 3): the record says what it holds back, as it is. 1.174.0
  // (DR4): giving it up is the sheet's Stop the release (auto-merge off).
  it("says what the record holds back; giving it up is the sheet's Stop", async () => {
    seedBoard();
    recorded = onTheWay;
    renderStep();
    const { readPendingRelease, unpublishedReleaseError } = await import("../lib/uxError");
    expect(unpublishedReleaseError(readPendingRelease(onTheWay)!).untouched).toBe(
      "Until it is merged, no other release or local land of main starts here, and the card isn't shipped another way. The card is marked shipped once it is merged and tagged.",
    );
    expect(await screen.findByRole("button", { name: "Show it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });


  // G8 fixes (m6): recorded at "Building" with no build running — it says it
  // stopped, and Continue makes it again.
  // G8 fixes (m6): recorded at "Building" with no build running — it says it
  // stopped; Continue is the sheet's.
  it("a release a quit stopped while it was being made says so", async () => {
    seedBoard();
    const stopped = "Plyloft stopped while it was making v1.0.1 (it was quit or closed). Nothing of it is on GitHub. Continue v1.0.1 makes it again from the start.";
    recorded = { ...onTheWay, pr: { ...pr, step: "building", head: null, number: null, url: null, waiting: stopped } };
    renderStep();
    expect(await screen.findByText("v1.0.1: Stopped while it was being made")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show it" })).toBeTruthy();
  });


  // 1.170 walk (Mac and Windows): the card said "Ship didn't go through"
  // with Try again for the whole release, from the press until the board
  // said Shipped. It says the release, at every step, and then Shipped.
  it("the card says the release on its way at every step, never a failed ship, then Shipped", async () => {
    seedBoard();
    const built: KanbanCard = { ...card, notes: "Add the deploy skill.", lastRunStatus: "success" };
    useKanban.setState({ byWorkspace: { [WS]: { cards: [built] } } } as never);
    function Now() {
      const c = useKanban((s) => s.byWorkspace[WS]!.cards[0]!);
      const live = useCardLive(c);
      const p = presentCard(c, live);
      // 1.171.0 B2 (B1 Challenger leftover): the path line says the release.
      const path = cardDeliveryPath(c, p.rule, live.releasing);
      return (
        <>
          <p data-testid="now">{`${p.headline} · ${p.sentence} · ${p.action.label}`}</p>
          <p data-testid="path">{path?.line ?? ""}</p>
        </>
      );
    }
    renderUi(<Now />);
    const now = () => screen.getByTestId("now").textContent ?? "";
    const steps = [
      ["building", null, "v1.0.1: Building the release. · View the release"],
      ["built", null, "v1.0.1: Release made, not on GitHub yet. · View the release"],
      ["pushed", null, "v1.0.1: Release branch on GitHub. · View the release"],
      ["open", 12, "v1.0.1: Release pull request open #12. · Open on GitHub"],
      ["merging", 12, "v1.0.1: Merging the release #12. · Open on GitHub"],
      ["merged", 12, "v1.0.1: Merged, tagging it. · Open on GitHub"],
      ["tagged", 12, "v1.0.1: Tagged. · Open on GitHub"],
    ] as const;
    for (const [step, number, words] of steps) {
      act(() =>
        useErrorBlocks.getState().setUnpublished(WS, {
          ...onTheWay,
          pr: { ...pr, step, number, url: number ? pr.url : null, waiting: null },
        }),
      );
      expect(now()).toBe(`Releasing through a pull request · ${words}`);
      expect(screen.getByTestId("path").textContent).toBe(
        releasePath({ tag: "v1.0.1", step, number }).line,
      );
      expect(screen.getByTestId("path").textContent).toMatch(/^On this Mac/);
    }
    // 1.172.0 B3: the record's who-merges fact reaches the path line.
    act(() =>
      useErrorBlocks.getState().setUnpublished(WS, {
        ...onTheWay,
        pr: { ...pr, step: "merging", plyloftMerges: true },
      }),
    );
    expect(screen.getByTestId("path").textContent).toBe(
      "On this Mac → On GitHub, release pull request #12 · Plyloft merges it when its checks pass, while it's open on this Mac → Next: Released v1.0.1",
    );
    act(() =>
      useErrorBlocks.getState().setUnpublished(WS, {
        ...onTheWay,
        pr: { ...pr, step: "merging", mergeOnItsWay: true },
      }),
    );
    expect(screen.getByTestId("path").textContent).toMatch(/· GitHub merges it when its checks pass → Next: Released v1\.0\.1$/);
    // A problem with the record is no release on its way (where Ship is the
    // primary it is a Ship that didn't go through: surfaceAgreement.test.ts).
    act(() => useErrorBlocks.getState().setUnpublished(WS, { ...onTheWay, problem: "The tag moved." }));
    expect(now()).not.toMatch(/^Releasing/);
    // The end, in the backend's order: the board says Shipped, then the
    // record goes — never a failed or ready state between.
    act(() => useErrorBlocks.getState().setUnpublished(WS, onTheWay));
    act(() =>
      useKanban.setState({
        byWorkspace: { [WS]: { cards: [{ ...built, shipStatus: "shipped", shippedVersion: "1.0.1", commitSha: SHA }] } },
      } as never),
    );
    expect(now()).toMatch(/^Shipped · /);
    act(() => useErrorBlocks.getState().setUnpublished(WS, null));
    expect(now()).toMatch(/^Shipped · /);
  });

});

describe("Dismiss wherever the refusal is met (GH #222 review 3)", () => {
  it("an unreadable record is drawn on any card's Ship step, with Dismiss that removes it", async () => {
    seedBoard();
    unreadable = "Plyloft's record of an unpublished release (/x/pending_release.json) can't be read: EOF";
    const { user, tauri } = renderUi(
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={() => {}} />
      </section>,
      {
        fixtures: {
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          ...recordFixture,
          ship_pending_release_dismiss: () => {
            unreadable = null;
            return null;
          },
        },
      },
    );
    expect(await screen.findByText("Plyloft's record of an unpublished release can't be read.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    const confirm = screen.getByRole("dialog");
    expect(within(confirm).getByText(/stay on this Mac only/)).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(tauri.callsOf("ship_pending_release_dismiss")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByText("Plyloft's record of an unpublished release can't be read.")).toBeNull(),
    );
  });

  it("a Merge refused by a recorded release leads to the Ship step (toast says Merge)", async () => {
    seedBoard();
    const { observeShipAttempt } = await import("../store/errorBlockStore");
    renderUi(<></>, { withToasts: true });
    expect(observeShipAttempt(WS, [card.id], "merge", { refused: stopped })).toBe(true);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual([
      "Merge stopped: v1.0.1 isn't published yet.",
    ]);
    expect(useErrorBlocks.getState().byWorkspace[WS]?.unpublished?.tag).toBe("v1.0.1");
    // And an unreadable record, the same way.
    useToasts.setState({ toasts: [] });
    expect(observeShipAttempt(WS, [card.id], "merge", { refused: { recordUnreadable: "bad" } })).toBe(true);
    expect(useErrorBlocks.getState().byWorkspace[WS]?.unreadableRecord).toBe("bad");
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

});

describe("GH #222 review 4", () => {
  it("a record Plyloft left mid-release is dismissed with words that promise no commit or tag", async () => {
    seedBoard();
    recorded = {
      ...view,
      stage: "committing",
      problem: "Plyloft stopped while making v1.0.1, before it was tagged, so there is nothing to publish.",
    };
    const { user } = renderUi(
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={() => {}} />
      </section>,
      { fixtures: { improvement_proposal_state: null, improvement_proposal_trust_stopped: null, ...recordFixture } },
    );
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    const confirm = screen.getByRole("dialog");
    expect(within(confirm).getByText(/may not exist/)).toBeTruthy();
    expect(within(confirm).getByText(/git status for a staged merge/)).toBeTruthy();
    expect(within(confirm).queryByText(/stay on this Mac only/)).toBeNull();
  });

});

// 1.174.0 (DR3): the Release sheet carries what the batch dialog and the
// card's Release flow did for GH #222, R6 and DL-32 — ported here.
describe("the Release sheet and a recorded release (GH #222, R6, DL-32)", () => {
  const ask = { workspaceId: WS, areaId: null };
  const scope = relScope({ workspaceId: WS, readyCardIds: [card.id] });
  function sheetFixtures(over: Partial<ShipAuditReport> = {}) {
    return { ...releaseFixtures(scope, { ...audit({ targetBranch: "main", releasesThroughPr: false }), ...over }), ...counts };
  }
  function Host() {
    const now = useUi((s) => s.releaseSheet);
    return now ? <ReleaseSheet ask={now} onClose={() => useUi.getState().setReleaseSheet(null)} /> : null;
  }
  const openSheet = () => act(() => useUi.getState().setReleaseSheet(ask));

  it("keeps the press off while this workspace's release or land runs", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={ask} onClose={() => {}} />, { fixtures: sheetFixtures({ shipInFlight: true }) });
    const sheet = await screen.findByRole("dialog", { name: "Release Ply" });
    await waitFor(() =>
      expect(within(sheet).getByRole("alert").textContent).toBe(
        "Another release or land of this project is still running. Wait for it to finish.",
      ),
    );
    expect((within(sheet).getByRole("button", { name: /^Release v/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a push stopped at its bound closes the sheet, announces once, and puts Publish v1.0.1 on the Ship step", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    const { user } = renderUi(
      <>
        <Host />
        <section aria-label="Ship step">
          <CardShipStep card={card} onOpenRelease={() => {}} />
        </section>
      </>,
      {
        withToasts: true,
        fixtures: {
          ...sheetFixtures(),
          release_area: () => {
            recorded = view;
            return Promise.reject(stopped);
          },
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          ...recordFixture,
        },
      },
    );
    openSheet();
    const press = (await screen.findByRole("button", { name: /^Release v/ })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await user.click(press);
    await waitFor(() => expect(useUi.getState().releaseSheet).toBeNull());
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Ship stopped: v1.0.1 isn't published yet."]);
    const step = screen.getByRole("region", { name: "Ship step" });
    expect(within(step).getByText("v1.0.1 isn't published yet.")).toBeTruthy();
    expect(within(step).getByRole("button", { name: "Publish v1.0.1" })).toBeTruthy();
  });

  it("publishes the release already committed: its version and kind, never a new one", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    let sent: unknown = null;
    const { user } = renderUi(<ReleaseSheet ask={ask} onClose={() => {}} />, {
      fixtures: {
        ...sheetFixtures({ pendingRelease: pending }),
        release_area: (args: Record<string, unknown>) => {
          sent = args.request;
          return shipped;
        },
        kanban_load: { cards: [card] },
      },
    });
    const publish = (await screen.findByRole("button", { name: "Publish v1.0.1" })) as HTMLButtonElement;
    await waitFor(() => expect(publish.disabled).toBe(false));
    // Publishing is the push: on this Mac only is off.
    expect((screen.getByRole("radio", { name: /On this Mac only/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(publish);
    await waitFor(() =>
      expect(sent).toMatchObject({ cardIds: [card.id], version: "1.0.1", releaseKind: "push_only", skipVerify: false }),
    );
  });

  it("offers Dismiss for an unreadable record and keeps the press off", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={ask} onClose={() => {}} />, {
      fixtures: sheetFixtures({ pendingRecordUnreadable: "EOF" }),
    });
    expect(await screen.findByRole("button", { name: "Dismiss the record…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Release v/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Plyloft's record of an unpublished release can't be read: EOF");
  });

  it("says up front that another workspace's release holds it back", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={ask} onClose={() => {}} />, {
      fixtures: sheetFixtures({ pendingElsewhere: "v2.0.0 of Shop, on this repository's main, isn't published yet." }),
    });
    expect(await screen.findByText("v2.0.0 of Shop, on this repository's main, isn't published yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Release v/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toasts a failure once the sheet is gone", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    const ship = deferred<ShipResult>();
    const { user } = renderUi(<Host />, {
      withToasts: true,
      fixtures: { ...sheetFixtures(), release_area: () => ship.promise },
    });
    openSheet();
    const press = (await screen.findByRole("button", { name: /^Release v/ })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await user.click(press);
    // Close is allowed while it runs.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => ship.reject("git push origin main failed: denied"));
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    const [toast] = useToasts.getState().toasts;
    expect(toast.title).toBe("v3.0.2 wasn't released");
    expect(`${toast.body ?? ""} ${toast.details ?? ""}`).toContain("denied");
  });

  // R6: the project folder's changes refuse it before anything is merged —
  // Show them always, Ask the Builder to commit them for a card that may.
  it("refused by the project folder's changes offers Show them and Ask the Builder to commit them", async () => {
    const dirty = 'PLY_TARGET_DIRTY_V1:{"totalCount":1,"paths":["README.md"],"truncated":false}';
    seedBoard();
    setPlanGates(PRO_GATES);
    const askBuilder = vi.fn(async () => "sent" as const);
    const { useBuilder } = await import("../store/builderStore");
    useBuilder.setState({ askBuilder } as never);
    useKanban.setState({ byWorkspace: { [WS]: { cards: [{ ...card, builder: { vendor: "claude", bypass: false } as never }] } } } as never);
    const { user } = renderUi(<Host />, { fixtures: { ...sheetFixtures(), release_area: () => Promise.reject(dirty) } });
    openSheet();
    const press = (await screen.findByRole("button", { name: /^Release v/ })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await user.click(press);
    await screen.findByText(/1 changed file in your project folder isn't saved in a commit/);
    expect(screen.getByRole("button", { name: "Show them" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ask the Builder to commit them" }));
    expect(useUi.getState().releaseSheet).toBeNull();
    await waitFor(() => expect(askBuilder).toHaveBeenCalled());
  });

  // DR3 round 1: one ticked card with a Builder keeps its own ways out — a
  // conflict to resolve (ReleaseFlow's "Ask the Builder to resolve it"); the
  // line says the card is still ready.
  it("a conflict on the one ticked card offers Ask the Builder to resolve it", async () => {
    const conflict =
      "Plyloft couldn't merge “Deploy skill” (card/card-1) into main: it conflicts with main in README.md. " +
      "Nothing was released, and your project folder is as it was. Open the card and press Fix with the Builder. Git said: boom";
    seedBoard();
    setPlanGates(PRO_GATES);
    const resolveShipConflict = vi.fn(async () => "sent" as never);
    const { useBuilder } = await import("../store/builderStore");
    useBuilder.setState({ resolveShipConflict } as never);
    useKanban.setState({ byWorkspace: { [WS]: { cards: [{ ...card, builder: { vendor: "claude", bypass: false } as never }] } } } as never);
    const { user } = renderUi(<Host />, {
      fixtures: { ...sheetFixtures(), release_area: () => Promise.reject(conflict), kanban_load: { cards: [card] } },
    });
    openSheet();
    const press = (await screen.findByRole("button", { name: /^Release v/ })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await user.click(press);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The cards on main are as they were; Deploy skill is still ready.");
    await user.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    expect(useUi.getState().releaseSheet).toBeNull();
    await waitFor(() => expect(resolveShipConflict).toHaveBeenCalledWith(WS, card.id));
  });

  // DL-32: only a release that relaunches Plyloft waits for the work running
  // here or asks for the editor's unsaved files first.
  it("Plyloft's own repository waits for the work and asks to save first; any other project doesn't", async () => {
    seedBoard();
    setPlanGates(PRO_GATES);
    act(() =>
      useEditor.setState({
        byWorkspace: { [WS]: { openFiles: [{ path: "/p/a.ts", content: "b", initialContent: "a" }], activePath: null } } as never,
      }),
    );
    const first = renderUi(<ReleaseSheet ask={ask} onClose={() => {}} />, {
      fixtures: sheetFixtures({ activeRunCount: 1, relaunches: true }),
    });
    expect(await screen.findByRole("button", { name: "Wait for the work, then release" })).toBeTruthy();
    expect(screen.getByText(/A release restarts Plyloft: save them first\./)).toBeTruthy();
    first.unmount();
    renderUi(<ReleaseSheet ask={ask} onClose={() => {}} />, { fixtures: sheetFixtures({ activeRunCount: 1, relaunches: false }) });
    expect(await screen.findByRole("button", { name: /^Release v/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Wait for the work, then release" })).toBeNull();
    expect(screen.queryByText(/A release restarts Plyloft/)).toBeNull();
    act(() => useEditor.setState({ byWorkspace: {} }));
  });
});
