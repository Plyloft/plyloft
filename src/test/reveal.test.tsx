// N14 walk F6: content that opens or fills inline in answer to a press is
// brought into view (smooth unless reduced motion is asked for) and its
// heading takes focus — the hook, Settings › Team › Add somebody › Review, and
// the result of Send invites and Remove from team.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReveal } from "../components/ux";
import { REVEAL_SETTLE_MS } from "../components/ux/useReveal";
import { TeamPage } from "../components/settings/TeamPage";
import type { AccountInfo, TeamStatus } from "../ipc";
import { useAccount } from "../store/accountStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { setTeamAllowed } from "./planGates";
import { renderUi, screen, waitFor, within } from "./render";

let scrolls: { el: Element; options: ScrollIntoViewOptions | boolean | undefined }[] = [];
const original = Element.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;

function reducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  scrolls = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: ScrollIntoViewOptions | boolean) {
    scrolls.push({ el: this, options });
  });
  reducedMotion(false);
});

afterEach(() => {
  Element.prototype.scrollIntoView = original;
  window.matchMedia = originalMatchMedia;
});

function Panel({ focus }: { focus?: boolean }) {
  const [shown, setShown] = useState<string | null>(null);
  const ref = useReveal<HTMLDivElement>(shown, { block: "start", focus });
  return (
    <>
      <button type="button" onClick={() => setShown((s) => (s === "a" ? "b" : "a"))}>
        Show
      </button>
      {shown && (
        <div ref={ref} data-testid="panel">
          <h2>Plan {shown}</h2>
        </div>
      )}
    </>
  );
}

describe("useReveal", () => {
  it("scrolls the content into view smoothly and focuses its heading, again for each new key", async () => {
    const user = userEvent.setup();
    render(<Panel />);
    expect(scrolls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Show" }));
    const panel = screen.getByTestId("panel");
    expect(scrolls).toEqual([{ el: panel, options: { behavior: "smooth", block: "start" } }]);
    const heading = screen.getByRole("heading", { name: "Plan a" });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(scrolls).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Plan b" }));
  });

  it("with reduced motion the jump is instant", async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(scrolls[0].options).toEqual({ behavior: "auto", block: "start" });
  });

  it("focus: false only scrolls (a flow whose own field takes the focus)", async () => {
    const user = userEvent.setup();
    render(<Panel focus={false} />);
    const show = screen.getByRole("button", { name: "Show" });
    await user.click(show);
    expect(scrolls).toHaveLength(1);
    expect(document.activeElement).toBe(show);
  });
});

const OWNER: AccountInfo = {
  signedIn: true,
  login: "owner",
  sub: "1",
  plan: "team",
  teamRepo: "owner/test-team",
  teamRole: "owner",
  status: null,
  periodEnd: null,
  exp: null,
  comp: false,
  entitlementValid: true,
  lastCheckedAt: null,
  offline: false,
  lastKnownPlan: "free",
  team: null,
  deviceName: "Test Mac",
};

function ownerStatus(): TeamStatus {
  return {
    teamRepo: "owner/test-team",
    teamName: "Test team",
    members: [
      { login: "owner", owner: true },
      { login: "joined", owner: false },
    ],
    isOwner: true,
    ignoredRepos: [],
    login: "owner",
    membership: "member",
    membershipReason: null,
    membershipStale: false,
    cloneRoot: "/Users/me/code",
    cloneRootIsDefault: true,
    hasClone: true,
    workspaces: [],
    skills: [],
    refusedSkills: [],
    canWriteLibrary: true,
    writeLibraryReason: null,
    libraryDivergence: null,
    libraryInterruption: null,
    error: null,
  } as unknown as TeamStatus;
}

describe("Settings › Team › Add somebody › Review", () => {
  it("brings the invite plan into view and focuses its heading", async () => {
    useAccount.setState({ info: OWNER, loaded: true });
    setTeamAllowed(true);
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: "owner/test-team" } },
      loaded: true,
    } as never);
    const { user } = renderUi(<TeamPage scope="team" />, {
      fixtures: {
        team_status: () => ownerStatus(),
        team_refresh: () => ownerStatus(),
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [], repos: ["owner/test-team"] },
        team_create_defaults: { login: "owner", workspaces: [] },
        team_billing_get: { stage: { stage: "bound", teamRepo: "owner/test-team" }, team: null, error: null },
        team_invite_plan: {
          login: "newbie",
          teamRepo: "owner/test-team",
          teamName: "Test team",
          steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant" }],
          warnings: [],
          addsToManifest: true,
          digest: "d1",
        },
      },
    });
    const section = within((await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement);
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    scrolls = [];
    await user.click(section.getByRole("button", { name: "Review" }));
    const heading = await screen.findByRole("heading", { name: "Add newbie to Test team" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const flow = heading.closest(".ux-flow");
    expect(scrolls.some((s) => s.el === flow && (s.options as ScrollIntoViewOptions).block === "start")).toBe(true);
  });
});

describe("Settings › Team › the result of Send invites and Remove from team", () => {
  const PLAN = {
    login: "newbie",
    teamRepo: "owner/test-team",
    teamName: "Test team",
    steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant", purpose: "" }],
    warnings: [],
    addsToManifest: true,
    digest: "d1",
  };
  const fixtures = {
    team_status: () => ownerStatus(),
    team_refresh: () => ownerStatus(),
    team_work_mode: { mode: "team", chosen: true },
    team_member_states: { members: [], problems: [], repos: ["owner/test-team"] },
    team_create_defaults: { login: "owner", workspaces: [] },
    team_billing_get: { stage: { stage: "bound", teamRepo: "owner/test-team" }, team: null, error: null },
    team_invite_plan: PLAN,
    team_invite_apply: {
      login: "newbie",
      listed: true,
      manifestWritten: true,
      invited: ["owner/test-team"],
      alreadyHad: [],
      alreadyInvited: [],
      failed: [],
    },
    team_member_remove: {
      login: "joined",
      removed: ["owner/test-team"],
      cancelledInvitations: [],
      stillRead: [],
      failed: [],
      manifestUpdated: true,
      manifestError: null,
    },
  };

  function open() {
    useAccount.setState({ info: OWNER, loaded: true });
    setTeamAllowed(true);
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: "owner/test-team" } },
      loaded: true,
    } as never);
    return renderUi(<TeamPage scope="team" />, { fixtures });
  }

  async function membersEl() {
    return (await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement;
  }

  async function sendInvite(user: ReturnType<typeof open>["user"], el: HTMLElement) {
    const section = within(el);
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await screen.findByRole("heading", { name: "Add newbie to Test team" });
    scrolls = [];
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    await section.findByText(/Invitation sent to newbie\./);
  }

  it("Send invites: Members comes into view, its heading takes the lost focus, and the result is in a live region from before", async () => {
    const { user } = open();
    const el = await membersEl();
    const region = within(el).getByRole("status");
    expect(region.textContent).toBe("");
    await sendInvite(user, el);
    expect(region.textContent).toMatch(/Invitation sent to newbie\./);
    // Above the list, under the head that carries the count.
    expect(region.compareDocumentPosition(within(el).getByRole("button", { name: "Review" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() =>
      expect(scrolls.some((s) => s.el === el && (s.options as ScrollIntoViewOptions).block === "start" && (s.options as ScrollIntoViewOptions).behavior === "smooth")).toBe(true),
    );
    await waitFor(() => expect(document.activeElement).toBe(within(el).getByRole("heading", { name: "Members" })));
  });

  it("Send invites: a person who moved focus while it ran keeps it, and still sees the result", async () => {
    const { user } = open();
    const el = await membersEl();
    const section = within(el);
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await screen.findByRole("heading", { name: "Add newbie to Test team" });
    scrolls = [];
    const send = await screen.findByRole("button", { name: "Send invites" });
    await user.click(send);
    section.getByRole("textbox", { name: "Add somebody" }).focus();
    await section.findByText(/Invitation sent to newbie\./);
    await waitFor(() => expect(scrolls.some((s) => s.el === el)).toBe(true));
    expect(document.activeElement).toBe(section.getByRole("textbox", { name: "Add somebody" }));
  });

  it("Send invites: somebody typing in a field outside Members isn't scrolled away from it", async () => {
    let finish: (v: unknown) => void = () => {};
    useAccount.setState({ info: OWNER, loaded: true });
    setTeamAllowed(true);
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: "owner/test-team" } },
      loaded: true,
    } as never);
    const { user } = renderUi(<TeamPage scope="team" />, {
      fixtures: { ...fixtures, team_invite_apply: () => new Promise((resolve) => (finish = resolve)) },
    });
    const el = await membersEl();
    const section = within(el);
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    const outside = screen.getByRole("textbox", { name: "Where team workspaces are cloned" });
    outside.focus();
    scrolls = [];
    finish(fixtures.team_invite_apply);
    await section.findByText(/Invitation sent to newbie\./);
    // Past the correction too: there is none for a reveal that didn't happen.
    await new Promise((resolve) => setTimeout(resolve, REVEAL_SETTLE_MS + 60));
    expect(scrolls.some((s) => s.el === el)).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(section.getByRole("status").textContent).toMatch(/Invitation sent to newbie\./);
  });

  // Walk 2026-11-04, live at 1280x820: after Send invites the page stayed below
  // Members. jsdom lays nothing out, so these pin the order and the correction,
  // not the landing itself.
  describe("A reveal the page's own changes could cut short", () => {
    const smooth = (el: Element) =>
      scrolls.filter((s) => s.el === el && (s.options as ScrollIntoViewOptions).behavior === "smooth");
    const instant = (el: Element) =>
      scrolls.filter((s) => s.el === el && (s.options as ScrollIntoViewOptions).behavior === "auto");

    function openHolding(answer: () => TeamStatus | Promise<TeamStatus>) {
      let holding = false;
      useAccount.setState({ info: OWNER, loaded: true });
      setTeamAllowed(true);
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: "owner/test-team" } },
        loaded: true,
      } as never);
      const opened = renderUi(<TeamPage scope="team" />, {
        fixtures: { ...fixtures, team_status: () => (holding ? answer() : ownerStatus()) },
      });
      return { ...opened, hold: () => (holding = true) };
    }

    async function pressSend(user: ReturnType<typeof open>["user"], el: HTMLElement) {
      const section = within(el);
      await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
      await user.click(section.getByRole("button", { name: "Review" }));
      await screen.findByRole("heading", { name: "Add newbie to Test team" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      scrolls = [];
      await user.click(await screen.findByRole("button", { name: "Send invites" }));
      await section.findByText(/Invitation sent to newbie\./);
    }

    it("Send invites: Members starts coming into view only once the new row has landed", async () => {
      let land: (status: TeamStatus) => void = () => {};
      const { user, hold } = openHolding(() => new Promise<TeamStatus>((resolve) => (land = resolve)));
      const el = await membersEl();
      hold();
      const sawRow: boolean[] = [];
      const record = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions | boolean) {
        if (this === el) sawRow.push(within(el).queryByText("newbie") !== null);
        record.call(this, options);
      };
      await pressSend(user, el);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(smooth(el)).toHaveLength(0);
      const status = ownerStatus();
      land({ ...status, members: [...status.members, { login: "newbie", owner: false }] } as TeamStatus);
      await waitFor(() => expect(smooth(el).length).toBeGreaterThan(0));
      expect(sawRow[0]).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(within(el).getByRole("heading", { name: "Members" })));
    });

    it("Send invites: a local read that fails still brings Members into view", async () => {
      const { user, hold } = openHolding(() => Promise.reject("the clone couldn't be read"));
      const el = await membersEl();
      hold();
      await pressSend(user, el);
      await waitFor(() => expect(smooth(el).length).toBeGreaterThan(0));
    });

    it("Remove from team: the same order", async () => {
      let land: (status: TeamStatus) => void = () => {};
      const { user, hold } = openHolding(() => new Promise<TeamStatus>((resolve) => (land = resolve)));
      const el = await membersEl();
      const section = within(el);
      await user.click(await section.findByRole("button", { name: "More for joined" }));
      await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
      const sheet = within(await screen.findByRole("dialog"));
      hold();
      scrolls = [];
      await user.click(sheet.getByRole("button", { name: "Remove from team" }));
      await section.findByText(/joined removed from the team\./);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(smooth(el)).toHaveLength(0);
      land(ownerStatus());
      await waitFor(() => expect(smooth(el).length).toBeGreaterThan(0));
    });

    it("a smooth scroll that didn't arrive is corrected once, at once, when the page has settled", async () => {
      const { user } = open();
      const el = await membersEl();
      await pressSend(user, el);
      await waitFor(() => expect(smooth(el).length).toBeGreaterThan(0));
      expect(instant(el)).toHaveLength(0);
      await waitFor(() => expect(instant(el)).toHaveLength(1), { timeout: REVEAL_SETTLE_MS + 500 });
      expect((instant(el)[0].options as ScrollIntoViewOptions).block).toBe("start");
      expect(smooth(el)).toHaveLength(1);
    });

    it.each([
      ["a wheel", () => window.dispatchEvent(new Event("wheel"))],
      ["a key", () => window.dispatchEvent(new Event("keydown"))],
      ["a press", () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))],
    ])("%s after it started: the person's place stands, with no correction", async (_name, act) => {
      const { user } = open();
      const el = await membersEl();
      await pressSend(user, el);
      await waitFor(() => expect(smooth(el).length).toBeGreaterThan(0));
      act();
      await new Promise((resolve) => setTimeout(resolve, REVEAL_SETTLE_MS + 60));
      expect(instant(el)).toHaveLength(0);
    });
  });

  it("Remove from team: the same, and the heading wins over the closing sheet's opener", async () => {
    const { user } = open();
    const el = await membersEl();
    const section = within(el);
    await user.click(await section.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    const sheet = within(await screen.findByRole("dialog"));
    scrolls = [];
    await user.click(sheet.getByRole("button", { name: "Remove from team" }));
    await section.findByText(/joined removed from the team\./);
    expect(section.getByRole("status").textContent).toMatch(/joined removed from the team\./);
    await waitFor(() => expect(scrolls.some((s) => s.el === el)).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(section.getByRole("heading", { name: "Members" })));
    // Past the sheet's own frame, which gives focus back to its opener.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.activeElement).toBe(section.getByRole("heading", { name: "Members" }));
  });

  describe("Remove from team, when its frame comes late", () => {
    const realFrame = window.requestAnimationFrame;
    let held: FrameRequestCallback[] = [];
    beforeEach(() => {
      held = [];
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        held.push(cb);
        return held.length;
      }) as typeof window.requestAnimationFrame;
    });
    afterEach(() => {
      window.requestAnimationFrame = realFrame;
    });

    async function removeJoined(user: ReturnType<typeof open>["user"], section: ReturnType<typeof within>) {
      await user.click(await section.findByRole("button", { name: "More for joined" }));
      for (const cb of held.splice(0)) cb(0);
      await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
      const dialog = await screen.findByRole("dialog");
      for (const cb of held.splice(0)) cb(0);
      await user.click(within(dialog).getByRole("button", { name: "Remove from team" }));
      await section.findByText(/joined removed from the team\./);
    }

    it("somebody already typing in Add somebody keeps the field, the letters and Review; Members still comes into view", async () => {
      const { user } = open();
      const el = await membersEl();
      const section = within(el);
      await removeJoined(user, section);
      const field = section.getByRole("textbox", { name: "Add somebody" }) as HTMLInputElement;
      await user.click(field);
      scrolls = [];
      for (const cb of held.splice(0)) cb(0);
      await user.keyboard("newbie");
      expect(field.value).toBe("newbie");
      expect(document.activeElement).toBe(field);
      expect(scrolls.some((s) => s.el === el)).toBe(true);
      await user.click(section.getByRole("button", { name: "Review" }));
      expect(await screen.findByRole("button", { name: "Send invites" })).toBeTruthy();
    });

    it("somebody already in a field outside Members isn't moved or scrolled away", async () => {
      const { user } = open();
      const el = await membersEl();
      await removeJoined(user, within(el));
      const outside = screen.getByRole("textbox", { name: "Where team workspaces are cloned" });
      await user.click(outside);
      scrolls = [];
      for (const cb of held.splice(0)) cb(0);
      expect(document.activeElement).toBe(outside);
      expect(scrolls.some((s) => s.el === el)).toBe(false);
    });

    it("with focus nowhere in particular, the heading still takes it", async () => {
      const { user } = open();
      const el = await membersEl();
      const section = within(el);
      await removeJoined(user, section);
      for (const cb of held.splice(0)) cb(0);
      expect(document.activeElement).toBe(section.getByRole("heading", { name: "Members" }));
    });
  });

  it("reduced motion: the jump is instant", async () => {
    reducedMotion(true);
    const { user } = open();
    const el = await membersEl();
    await sendInvite(user, el);
    await waitFor(() =>
      expect(scrolls.some((s) => s.el === el && (s.options as ScrollIntoViewOptions).behavior === "auto")).toBe(true),
    );
    expect(scrolls.some((s) => s.el === el && (s.options as ScrollIntoViewOptions).behavior === "smooth")).toBe(false);
  });
});
