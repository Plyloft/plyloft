// 1.179.0 (C1): Settings › AI and models › Claude accounts. Main alone is a
// quiet row and the Add button; Add makes the folder through
// `ai_account_add`, then runs Setup's `login-account.claude` for the new id
// in the guided terminal; Rename, Use for new sessions and Show folder go
// through their commands; Remove signs out first (`logout-account.claude`,
// then `ai_account_remove` with signOut) or doesn't. Rust's refusals are
// shown as it returns them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountsSection } from "../components/settings/ClaudeAccountsSection";
import { setPlatformForTests } from "../lib/platform";
import type { ClaudeAccountRemoved, ClaudeAccountRow, SetupProgressEvent, SetupStarted } from "../ipc";
import { act, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

// xterm draws on a canvas jsdom does not have.
vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    write(_data: unknown, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

afterEach(() => {
  setPlatformForTests(null);
});

const MAIN: ClaudeAccountRow = { id: null, name: "Main", signedIn: "yes", isCurrent: true, folder: "/Users/someone/.claude" };
const WORK: ClaudeAccountRow = {
  id: "acct01",
  name: "Work",
  signedIn: "no",
  isCurrent: false,
  folder: "/Users/someone/Library/Application Support/com.mbadv.ply/ai-accounts/claude/acct01",
};

const INTRO_MAC =
  "Use more than one Claude subscription on this Mac. Each account signs in with Claude's own login and keeps its own folder. New sessions start on the account you choose; a running session keeps its account.";
const INTRO_PC =
  "Use more than one Claude subscription on this PC. Each account signs in with Claude's own login and keeps its own folder. New sessions start on the account you choose; a running session keeps its account.";

const LOGIN_RUN: SetupStarted = {
  runId: "run-login",
  actionId: "login-account.claude",
  ptyId: "pty-login",
  display: "claude auth login",
  watch: { kind: "claude-sign-in" },
};
const LOGOUT_RUN: SetupStarted = {
  runId: "run-logout",
  actionId: "logout-account.claude",
  ptyId: "pty-logout",
  display: "claude auth logout",
  watch: { kind: "exit-code" },
};

function progress(run: SetupStarted, over: Partial<SetupProgressEvent>): SetupProgressEvent {
  return {
    runId: run.runId,
    actionId: run.actionId,
    ptyId: run.ptyId,
    phase: "running",
    outcome: null,
    exitCode: null,
    reprobed: false,
    tail: [],
    ...over,
  };
}

/** The fixtures every test needs; `rows` is what the list answers. */
function fixtures(rows: () => ClaudeAccountRow[], extra: Record<string, unknown> = {}) {
  return {
    ai_accounts_list: () => rows(),
    setup_active: null,
    pty_resize: null,
    ...extra,
  };
}

const rowOf = (name: string) => screen.getByText(name, { selector: ".ux-row *" }).closest(".ux-row") as HTMLElement;

async function openMenu(user: ReturnType<typeof renderUi>["user"], name: string) {
  await user.click(within(rowOf(name)).getByRole("button", { name: "More" }));
  return screen.getByRole("menu");
}

const menuLabels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((b) => b.textContent);

describe("ClaudeAccountsSection", () => {
  it("with only Main: one quiet row, its mark, and the Add button", async () => {
    const r = renderUi(<ClaudeAccountsSection />, { fixtures: fixtures(() => [MAIN]) });
    expect(await screen.findByText("Main")).toBeTruthy();
    expect(screen.getByText("Claude accounts")).toBeTruthy();
    expect(screen.getByText(INTRO_MAC)).toBeTruthy();
    expect(screen.getByText("The account Claude uses on its own.")).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(within(rowOf("Main")).getByText("New sessions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a Claude account…" })).toBeTruthy();
    // Nothing alarming: no error, no state of another account.
    expect(document.querySelector(".ux-status--aborted")).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
    // Main can be neither removed nor signed in again here, and is already
    // the one new sessions use.
    expect(menuLabels(await openMenu(r.user, "Main"))).toEqual(["Rename…", "Show folder"]);
  });

  it("says each state in its own words; unknown is never Not signed in", async () => {
    renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [{ ...MAIN, signedIn: "unknown" }, WORK]),
    });
    expect(await screen.findByText("Plyloft can't tell whether this account is signed in.")).toBeTruthy();
    expect(within(rowOf("Work")).getByText("Not signed in")).toBeTruthy();
    expect(within(rowOf("Main")).queryByText("Not signed in")).toBeNull();
  });

  it("says the machine as a PC on Windows", async () => {
    setPlatformForTests("windows");
    renderUi(<ClaudeAccountsSection />, { fixtures: fixtures(() => [MAIN]) });
    expect(await screen.findByText(INTRO_PC)).toBeTruthy();
  });

  it("adds an account: the folder first, then Claude's sign-in for its id in the guided terminal", async () => {
    let rows = [MAIN];
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => rows, {
        ai_account_add: ({ name }: Record<string, unknown>) => {
          rows = [MAIN, { ...WORK, name: String(name) }];
          return rows[1];
        },
        setup_run: () => {
          tauri().emit("setup://progress", progress(LOGIN_RUN, {}));
          return LOGIN_RUN;
        },
      }),
    });
    await r.user.click(await screen.findByRole("button", { name: "Add a Claude account…" }));
    const sheet = screen.getByRole("dialog", { name: "Add a Claude account" });
    expect(
      within(sheet).getByText(
        "Plyloft makes a folder for this account and opens Claude's own sign-in. Sign in with the subscription you want this account to use. Plyloft never sees your password or your login.",
      ),
    ).toBeTruthy();
    expect(
      within(sheet).getByText(
        "This account has its own settings, skills and folder trust. Your Main skills and settings aren't used here.",
      ),
    ).toBeTruthy();
    expect(within(sheet).getByText("Name")).toBeTruthy();
    const field = within(sheet).getByRole("textbox") as HTMLInputElement;
    expect(field.placeholder).toBe("Work");
    await r.user.type(field, "Work");
    await r.user.click(within(sheet).getByRole("button", { name: "Make the folder and sign in" }));

    await waitFor(() => expect(r.tauri.callsOf("setup_run")).toHaveLength(1));
    // The name crosses once; the sign-in names the account by its id only.
    expect(r.tauri.callsOf("ai_account_add").map((c) => c.args)).toEqual([{ name: "Work" }]);
    expect(r.tauri.callsOf("setup_run")[0].args).toEqual({
      actionId: "login-account.claude",
      args: { account: "acct01" },
      cols: null,
      rows: null,
    });
    const order = r.tauri.calls.map((c) => c.cmd).filter((c) => c === "ai_account_add" || c === "setup_run");
    expect(order).toEqual(["ai_account_add", "setup_run"]);
    expect(await screen.findByRole("dialog", { name: "Sign in to Claude account Work" })).toBeTruthy();
    const listsBefore = r.tauri.callsOf("ai_accounts_list").length;

    rows = [MAIN, { ...WORK, signedIn: "yes" }];
    act(() => tauri().emit("setup://progress", progress(LOGIN_RUN, { phase: "done", outcome: "succeeded", exitCode: 0 })));
    expect(await screen.findByText("Work is signed in.")).toBeTruthy();
    // The row is read again once the sign-in ended.
    await waitFor(() => expect(r.tauri.callsOf("ai_accounts_list").length).toBeGreaterThan(listsBefore));
    await r.user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(within(rowOf("Work")).getByText("Signed in")).toBeTruthy());
  });

  it("says when no sign-in was seen, and Try again runs the sign-in again", async () => {
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN, WORK], {
        setup_run: () => {
          tauri().emit("setup://progress", progress(LOGIN_RUN, {}));
          return LOGIN_RUN;
        },
      }),
    });
    await screen.findByText("Work");
    await r.user.click(within(await openMenu(r.user, "Work")).getByRole("menuitem", { name: "Sign in again" }));
    await waitFor(() => expect(r.tauri.callsOf("setup_run")).toHaveLength(1));
    act(() => tauri().emit("setup://progress", progress(LOGIN_RUN, { phase: "done", outcome: "not-observed", exitCode: 0 })));
    expect(
      await screen.findByText(
        "Plyloft didn't see a sign-in for Work. Try again, or close the window if you signed in elsewhere.",
      ),
    ).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(r.tauri.callsOf("setup_run")).toHaveLength(2));
    expect(r.tauri.callsOf("setup_run")[1].args).toMatchObject({ actionId: "login-account.claude", args: { account: "acct01" } });
  });

  it("shows the name's refusal as Rust returns it, and starts no sign-in", async () => {
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN, WORK], {
        ai_account_add: () => {
          throw "You already have an account named Work.";
        },
        setup_run: LOGIN_RUN,
      }),
    });
    await r.user.click(await screen.findByRole("button", { name: "Add a Claude account…" }));
    const sheet = screen.getByRole("dialog", { name: "Add a Claude account" });
    await r.user.type(within(sheet).getByRole("textbox"), "work");
    await r.user.click(within(sheet).getByRole("button", { name: "Make the folder and sign in" }));
    expect(await within(sheet).findByText("You already have an account named Work.")).toBeTruthy();
    expect(r.tauri.callsOf("setup_run")).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Add a Claude account" })).toBeTruthy();
  });

  it("renames Main by its null id", async () => {
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN], {
        ai_account_rename: ({ name }: Record<string, unknown>) => ({ ...MAIN, name }),
      }),
    });
    await screen.findByText("Main");
    await r.user.click(within(await openMenu(r.user, "Main")).getByRole("menuitem", { name: "Rename…" }));
    const sheet = screen.getByRole("dialog", { name: "Rename Main" });
    const field = within(sheet).getByRole("textbox") as HTMLInputElement;
    expect(field.value).toBe("Main");
    await r.user.clear(field);
    await r.user.type(field, "Personal");
    await r.user.click(within(sheet).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(r.tauri.callsOf("ai_account_rename").map((c) => c.args)).toEqual([{ id: null, name: "Personal" }]),
    );
    expect(await screen.findByText("Personal")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Use for new sessions moves the mark to that account", async () => {
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN, WORK], {
        ai_account_use_for_new: () => [
          { ...MAIN, isCurrent: false },
          { ...WORK, isCurrent: true },
        ],
      }),
    });
    await screen.findByText("Work");
    expect(within(rowOf("Main")).getByText("New sessions")).toBeTruthy();
    expect(menuLabels(await openMenu(r.user, "Work"))).toEqual([
      "Use for new sessions",
      "Rename…",
      "Sign in again",
      "Show folder",
      "Remove…",
    ]);
    await r.user.click(screen.getByRole("menuitem", { name: "Use for new sessions" }));
    await waitFor(() => expect(within(rowOf("Work")).getByText("New sessions")).toBeTruthy());
    expect(within(rowOf("Main")).queryByText("New sessions")).toBeNull();
    expect(r.tauri.callsOf("ai_account_use_for_new").map((c) => c.args)).toEqual([{ id: "acct01" }]);
  });

  it("Show folder asks Rust to open it, by id", async () => {
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN, WORK], { ai_account_show_folder: null }),
    });
    await screen.findByText("Work");
    await r.user.click(within(await openMenu(r.user, "Work")).getByRole("menuitem", { name: "Show folder" }));
    await waitFor(() => expect(r.tauri.callsOf("ai_account_show_folder").map((c) => c.args)).toEqual([{ id: "acct01" }]));
  });

  async function openRemove(r: ReturnType<typeof renderUi>) {
    await screen.findByText("Work");
    await r.user.click(within(await openMenu(r.user, "Work")).getByRole("menuitem", { name: "Remove…" }));
    const sheet = screen.getByRole("dialog", { name: "Remove Work?" });
    expect(
      within(sheet).getByText(
        "Plyloft deletes this account's folder. Conversations kept only there go with it. Signing out first lets Claude remove its own login for this account.",
      ),
    ).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeTruthy();
    return sheet;
  }

  const left = (loginLeft: ClaudeAccountRemoved["loginLeft"], signOut: boolean): ClaudeAccountRemoved => ({
    name: "Work",
    signOut,
    loginLeft,
  });

  it("removes without signing out, and says Claude's login is still saved on this Mac", async () => {
    let rows = [MAIN, WORK];
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => rows, {
        ai_account_remove: ({ signOut }: Record<string, unknown>) => {
          rows = [MAIN];
          return left("yes", Boolean(signOut));
        },
      }),
    });
    const sheet = await openRemove(r);
    await r.user.click(within(sheet).getByRole("button", { name: "Remove without signing out" }));
    expect(await screen.findByText("Work is removed. Claude's own login for it is still saved on this Mac.")).toBeTruthy();
    expect(r.tauri.callsOf("ai_account_remove").map((c) => c.args)).toEqual([{ id: "acct01", signOut: false }]);
    expect(r.tauri.callsOf("setup_run")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Work")).toBeNull());
  });

  it("says this PC on Windows after a removal that left the login", async () => {
    setPlatformForTests("windows");
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN, WORK], { ai_account_remove: left("yes", false) }),
    });
    const sheet = await openRemove(r);
    await r.user.click(within(sheet).getByRole("button", { name: "Remove without signing out" }));
    expect(await screen.findByText("Work is removed. Claude's own login for it is still saved on this PC.")).toBeTruthy();
  });

  it("signs out first in the guided terminal, then removes with signOut", async () => {
    let rows = [MAIN, WORK];
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => rows, {
        setup_run: () => {
          tauri().emit("setup://progress", progress(LOGOUT_RUN, {}));
          return LOGOUT_RUN;
        },
        ai_account_remove: () => {
          rows = [MAIN];
          return left("no", true);
        },
      }),
    });
    const sheet = await openRemove(r);
    await r.user.click(within(sheet).getByRole("button", { name: "Sign out and remove" }));
    await waitFor(() => expect(r.tauri.callsOf("setup_run")).toHaveLength(1));
    expect(r.tauri.callsOf("setup_run")[0].args).toEqual({
      actionId: "logout-account.claude",
      args: { account: "acct01" },
      cols: null,
      rows: null,
    });
    // Nothing is removed while Claude's sign-out runs.
    expect(r.tauri.callsOf("ai_account_remove")).toHaveLength(0);
    act(() => tauri().emit("setup://progress", progress(LOGOUT_RUN, { phase: "done", outcome: "succeeded", exitCode: 0 })));
    await waitFor(() =>
      expect(r.tauri.callsOf("ai_account_remove").map((c) => c.args)).toEqual([{ id: "acct01", signOut: true }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Claude removed its own login: nothing more to say.
    expect(screen.queryByText(/is removed/)).toBeNull();
  });

  it("shows Remove's refusal as Rust returns it, and keeps the account", async () => {
    const r = renderUi(<ClaudeAccountsSection />, {
      fixtures: fixtures(() => [MAIN, WORK], {
        ai_account_remove: () => {
          throw "Close 2 sessions running on Work first.";
        },
      }),
    });
    const sheet = await openRemove(r);
    await r.user.click(within(sheet).getByRole("button", { name: "Remove without signing out" }));
    expect(await within(sheet).findByText("Close 2 sessions running on Work first.")).toBeTruthy();
    expect(rowOf("Work")).toBeTruthy();
  });
});
