// 1.175.0 B2 (SEC-4): the card's Now while its checks wait for this Mac's OK
// (the two versions, one list the first time, a Claude step in its own
// words), the press that allows what is shown, and the install sheet with
// its focus on Not now.
import { describe, expect, it } from "vitest";
import { allowChecksAndRun, ChecksConsentNow } from "../components/ChecksConsentNow";
import { InstallConsentSheet } from "../components/InstallConsentSheet";
import type { ConsentView } from "../lib/checksConsent";
import { NO_CONSENT } from "../lib/checksConsent";
import { cardRowWords } from "../lib/inboxReconcile";
import { presentCard, EMPTY_CARD_LIVE } from "../lib/cardPresentation";
import { useChecksConsent, installHeldAfter } from "../store/checksConsentStore";
import { usePrAutoFix } from "../store/prAutoFixStore";
import { act, nextFrame, renderUi, screen, waitFor } from "./render";

const WS = "ws-1";
const CARD = { workspaceId: WS, id: "card-1" };
const NOW = Date.now();

const changed: ConsentView = {
  checks: {
    needsOk: true,
    firstTime: false,
    approved: [
      { claude: false, text: "./scripts/check.sh" },
      { claude: false, text: "npm test" },
    ],
    current: [
      { claude: false, text: "./scripts/check.sh" },
      { claude: false, text: "npm test" },
      { claude: true, text: "/ppvp", args: "then tidy the release folder" },
    ],
    hash: "hash-of-three",
    who: "example-teammate",
    changedAt: NOW - 2 * 3_600_000 - 60_000,
  },
  install: {
    needsOk: true,
    approved: "scripts/install.sh",
    current: "scripts/deploy-all.sh",
    who: "example-teammate",
    changedAt: NOW - 2 * 3_600_000 - 60_000,
    waiting: { tag: "v1.4.0", at: NOW },
  },
};

describe("Now, while the checks wait for the OK", () => {
  it("says who changed them and shows the two versions, the new step marked", async () => {
    const { container } = renderUi(<ChecksConsentNow card={CARD} />, { fixtures: { checks_consent_view: () => changed } });
    expect(
      await screen.findByText(
        "example-teammate changed this repository's checks 2 h ago. Allow them on this Mac? The Builder's work is saved, and nothing has run.",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(screen.getByText("Allowed on this Mac")).toBeTruthy();
    expect(screen.getByText("Now in the repository")).toBeTruthy();
    const lists = container.querySelectorAll("ol");
    expect(lists).toHaveLength(2);
    expect([...lists[0].querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1. ./scripts/check.sh", "2. npm test"]);
    expect([...lists[1].querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "1. ./scripts/check.sh",
      "2. npm test",
      "3. Claude runs /ppvp “then tidy the release folder”",
    ]);
    // Only the step that differs is marked.
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
      "3. Claude runs /ppvp “then tidy the release folder”",
    ]);
    expect(screen.getByText("Step 3 is new. It starts a Claude session in this card's copy with nobody watching.")).toBeTruthy();
    // Round 2 (G5): what the OK covers.
    expect(screen.getByText(/^Your OK is for these steps\. What each script does is the repository's code/)).toBeTruthy();
    // One press, and it is Now's own button: nothing here is a second way out.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows one list the first time", async () => {
    const first: ConsentView = {
      ...changed,
      checks: { ...changed.checks, firstTime: true, approved: [], who: null, changedAt: null, current: changed.checks.approved },
    };
    const { container } = renderUi(<ChecksConsentNow card={CARD} />, { fixtures: { checks_consent_view: () => first } });
    expect(
      await screen.findByText(
        "This repository's checks haven't run on this Mac before. Allow them here? The Builder's work is saved, and nothing has run.",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(screen.getByText("The repository's checks")).toBeTruthy();
    expect(screen.queryByText("Allowed on this Mac")).toBeNull();
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelector("mark")).toBeNull();
  });

  it("folds the versions behind See what changed while the round fixing checks waits", async () => {
    usePrAutoFix.setState({ phases: { "card-1": { step: "checking", head: "h", attempt: 1, at: NOW, snapshotN: 2, snapshotAt: NOW } } });
    const { user, container } = renderUi(<ChecksConsentNow card={CARD} />, { fixtures: { checks_consent_view: () => changed } });
    expect(await screen.findByText(/The fix is saved, and nothing has run\./)).toBeTruthy();
    expect(container.querySelector("ol")).toBeNull();
    const see = screen.getByRole("button", { name: "See what changed" });
    expect(see.getAttribute("aria-expanded")).toBe("false");
    await user.click(see);
    expect(container.querySelectorAll("ol")).toHaveLength(2);
  });

  it("allows the steps on screen, and says so when they changed meanwhile", async () => {
    let refuse = true;
    const { tauri } = renderUi(<ChecksConsentNow card={CARD} />, {
      fixtures: {
        checks_consent_view: () => changed,
        checks_allow_and_run: () => {
          if (refuse) throw new Error("The checks changed since you looked. Look at them again before allowing them.");
          return null;
        },
        kanban_load: () => [],
      },
    });
    await screen.findByText("Now in the repository");
    await act(() => allowChecksAndRun(CARD));
    expect(tauri.callsOf("checks_allow_and_run")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", hash: "hash-of-three" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The checks changed since you looked. Look at them again before allowing them.");
    // The lists were read again, and nothing else was called.
    expect(tauri.callsOf("checks_consent_view").length).toBeGreaterThan(1);
    refuse = false;
    await act(() => allowChecksAndRun(CARD));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("the card's row", () => {
  it("says the checks wait, with the round fixing checks, and opens the card", () => {
    const card = {
      id: "card-1",
      workspaceId: WS,
      title: "Fix login redirect",
      columnId: "in_progress",
      checksHold: { at: NOW },
      verifyStatus: "none",
      verifyHistory: [],
      runHistory: [],
      shipHistory: [],
      dismissedBanners: [],
      intakeHistory: [],
      createdAt: NOW,
      updatedAt: NOW,
    } as never;
    const p = presentCard(card, { ...EMPTY_CARD_LIVE, now: NOW });
    expect(p.rule).toBe("checks-ok");
    expect(p.headline).toBe("The checks need your OK");
    expect(p.action.label).toBe("Allow and run");
    expect(p.column).toBe("needs-you");
    expect(cardRowWords(p, "needs_you")).toEqual({ detail: "The checks need your OK", action: "Open card" });
  });
});

describe("the install step's sheet", () => {
  it("opens from Review with the two paths, focus on Not now, and runs only on Allow and run", async () => {
    const { user, tauri } = renderUi(<InstallConsentSheet />, {
      fixtures: {
        checks_consent_view: () => changed,
        install_allow_and_run: () => "v1.4.0's install step started in the background (scripts/deploy-all.sh).",
      },
      withToasts: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const held = await act(() => installHeldAfter(WS, { tag: "v1.4.0", installScript: "scripts/deploy-all.sh" }));
    expect(held?.held).toEqual({ who: "example-teammate" });
    expect(held?.action.label).toBe("Review");
    act(() => held!.action.onClick());
    const sheet = await screen.findByRole("dialog", { name: "Run the install step on this Mac?" });
    expect(sheet.textContent).toContain(
      "example-teammate changed “After a release, run” 2 h ago. It runs on this Mac after a release, with nobody watching.",
    );
    expect(sheet.textContent).toContain("Allowed on this Mac");
    expect(sheet.textContent).toContain("scripts/install.sh");
    expect(sheet.textContent).toContain("Now in the repository");
    expect(sheet.textContent).toContain("scripts/deploy-all.sh");
    expect(sheet.textContent).toContain(
      "Allow and run lets it run on this Mac from now on, and runs it for v1.4.0. The release itself is done either way.",
    );
    await nextFrame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Not now" }));
    // Round 2 (G5; consents.html 2.4): the focus is on Not now, a plain
    // button; Allow and run is the sheet's one accent button.
    expect(screen.getByRole("button", { name: "Not now" }).className).not.toMatch(/cbtn--(strong|accent)/);
    expect(screen.getByRole("button", { name: "Allow and run" }).className).toContain("cbtn--accent");
    expect(sheet.textContent).toContain("Your OK is for this path. What the script does is the repository's code");
    // Not now: nothing runs, and the sheet goes.
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("install_allow_and_run")).toHaveLength(0);
    // Again, and Allow and run: the path shown is the one allowed.
    act(() => useChecksConsent.getState().openInstallSheet(WS));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(tauri.callsOf("install_allow_and_run")).toHaveLength(1));
    expect(tauri.callsOf("install_allow_and_run")[0].args).toEqual({ workspaceId: WS, path: "scripts/deploy-all.sh" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("v1.4.0's install step started")).toBeTruthy();
  });

  it("stays shut when the step needs no OK, and keeps a refusal inside the sheet", async () => {
    renderUi(<InstallConsentSheet />, { fixtures: { checks_consent_view: () => NO_CONSENT } });
    act(() => useChecksConsent.getState().openInstallSheet(WS));
    await nextFrame();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a refusal in the sheet and starts nothing", async () => {
    const { user } = renderUi(<InstallConsentSheet />, {
      fixtures: {
        checks_consent_view: () => changed,
        install_allow_and_run: () => {
          throw new Error("Plyloft couldn’t record your choice. Try again in a moment.");
        },
      },
    });
    act(() => useChecksConsent.getState().openInstallSheet(WS));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Allow and run" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Plyloft couldn’t record your choice. Try again in a moment.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
