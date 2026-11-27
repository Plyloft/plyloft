// 1.175.0 F3 walk (R13): after Put it on GitHub, a card shipped only here
// before is on GitHub too — and every surface says so from one fact
// (`put_on_github_sent`): Now's path line, What shipped, the Board.
import { beforeEach, describe, expect, it } from "vitest";
import type { KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { putDone } from "../store/putOnGithubStore";
import { forgetSentToGitHub, readSent, resetSentToGitHubForTests, startSentToGitHub, useSentToGitHub } from "../store/sentToGitHubStore";
import { cardLiveFrom, cardLiveSourcesNow } from "../hooks/useCardLive";
import { presentCard } from "../lib/cardPresentation";
import { ShippedResult } from "../components/ShippedResult";
import { setPlatformForTests } from "../lib/platform";
import { renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-1";
const landed: KanbanCard = {
  id: "card-a",
  workspaceId: WS,
  title: "Add sum",
  columnId: "complete",
  createdAt: 1,
  updatedAt: 1,
  shipStatus: "shipped",
  commitSha: "a1",
  shipHistory: [{ commitSha: "a1", shippedVersion: "unknown", releaseKind: "local", shippedAt: Date.now() }],
} as KanbanCard;

beforeEach(() => {
  setPlatformForTests("mac");
  resetSentToGitHubForTests();
  // The driver started by an earlier test still follows the board.
  tauri().fixture("put_on_github_sent", []);
  useKanban.setState({ byWorkspace: { [WS]: { cards: [landed], loaded: true } } } as never);
  tauri().fixture("card_shipped_changes", { commit: "a1a1a1a1", files: [], subject: "Add sum" });
});

describe("F3 walk (R13): a land here GitHub has since", () => {
  it("says Shipped · on GitHub on the Board and in What shipped", async () => {
    tauri().fixture("put_on_github_sent", ["a1"]);
    await readSent(WS, [landed]);
    expect(tauri().callsOf("put_on_github_sent")[0].args).toEqual({ workspaceId: WS, shas: ["a1"] });
    const live = cardLiveFrom(cardLiveSourcesNow(), landed);
    expect(live.localShipOnGitHub).toBe(true);
    expect(presentCard(landed, live).headline).toBe("Shipped · on GitHub");
    renderUi(<ShippedResult card={landed} />);
    expect(await screen.findByText(/^Shipped on /)).toBeTruthy();
    expect(screen.queryByText(/only on this Mac/)).toBeNull();
  });

  it("still says only on this Mac when GitHub doesn't have it; read again after a put", async () => {
    tauri().fixture("put_on_github_sent", []);
    startSentToGitHub();
    await waitFor(() => expect(tauri().callsOf("put_on_github_sent").length).toBeGreaterThan(0));
    expect(presentCard(landed, cardLiveFrom(cardLiveSourcesNow(), landed)).headline).toBe("Shipped · only on this Mac");
    // Read once per commit.
    await readSent(WS, [landed]);
    const before = tauri().callsOf("put_on_github_sent").length;
    // Put it on GitHub sends it: read again.
    tauri().fixture("put_on_github_sent", ["a1"]);
    // (Send it again into the same repository counts as a put too.)
    putDone(WS, "octocat/lyra");
    await waitFor(() => expect(useSentToGitHub.getState().byWorkspace[WS]?.has("a1")).toBe(true));
    expect(tauri().callsOf("put_on_github_sent").length).toBe(before + 1);
    // Send it again into the same repository: read again too.
    putDone(WS, "octocat/lyra");
    await waitFor(() => expect(tauri().callsOf("put_on_github_sent").length).toBe(before + 2));
  });

  // Review: a land's commit reaching GitHub another way (a later Ship that
  // carried it, Bring in, a push by hand) is read again after a Ship or a
  // Bring in — not only after Put it on GitHub.
  it("reads the lands again after another card ships, and after a Bring in", async () => {
    tauri().fixture("put_on_github_sent", []);
    startSentToGitHub();
    useKanban.setState({ byWorkspace: { [WS]: { cards: [landed], loaded: true } } } as never);
    await waitFor(() => expect(tauri().callsOf("put_on_github_sent").length).toBeGreaterThan(0));
    const before = tauri().callsOf("put_on_github_sent").length;
    // Another card ships to GitHub, carrying the land's commit.
    tauri().fixture("put_on_github_sent", ["a1"]);
    const other = { ...landed, id: "card-b", shipHistory: [{ commitSha: "b1", shippedVersion: "unknown", releaseKind: "push_only", shippedAt: 2 }] } as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [landed, other], loaded: true } } } as never);
    await waitFor(() => expect(useSentToGitHub.getState().byWorkspace[WS]?.has("a1")).toBe(true));
    expect(tauri().callsOf("put_on_github_sent").length).toBeGreaterThan(before);
    // Bring in: read again (once).
    const n = tauri().callsOf("put_on_github_sent").length;
    forgetSentToGitHub(WS);
    await waitFor(() => expect(tauri().callsOf("put_on_github_sent").length).toBe(n + 1));
  });
});
