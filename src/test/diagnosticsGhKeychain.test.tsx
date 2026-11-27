// GH #189: with the login keychain locked, `gh auth status` fails the way it
// does for a refused token, and Diagnostics used to draw `Found, but not signed
// in` with a primary `Sign in`. The backend now answers "Ply cannot tell"
// (neutral, `optionalStep`), and the page — the real DiagnosticsPage, the real
// doctor store, the report through the stubbed `dependency_doctor` — draws:
//
//  - locked: the keychain's sentence, `Ready`, counted in `N of M ready`, no
//    `Sign in` button on the row, `Sign in` first in its ⋯ menu;
//  - not signed in at all: today's warning, `Sign in` the row's own button.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport, ToolAuth, ToolStatus } from "../ipc";
import { renderUi, screen } from "./render";

const LOCKED = "Found. The keychain is locked, so Plyloft can't check whether it is signed in.";
const SIGNED_OUT = "Found, but not signed in — pull requests can't be opened from here.";

function tool(over: Partial<ToolStatus>): ToolStatus {
  return {
    id: "gh",
    name: "GitHub command",
    required: false,
    found: true,
    path: "/opt/homebrew/bin/gh",
    version: "2.100.0",
    versionOk: true,
    detail: "Found. Diagnostics can check whether it is signed in.",
    installCmd: "brew install gh",
    docsUrl: "https://cli.github.com",
    reviewer: null,
    ...over,
  };
}

/** What `dependency_doctor` answers with `gh`'s sign-in as given; claude is
 *  found and signed in, so the count is about `gh` alone. */
function report(ghAuth: ToolAuth): DoctorReport {
  return {
    tools: [
      tool({
        id: "claude",
        name: "Claude Code",
        required: true,
        path: "/Users/me/.local/bin/claude",
        version: "2.1.280",
        detail: "Runs your Claude agents and swarms.",
        installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
        docsUrl: "https://docs.claude.com/en/docs/claude-code",
        auth: {
          signedIn: true,
          detail: "Found and signed in. Nothing to do.",
          command: "claude auth status",
          action: "Check",
          optionalStep: false,
        },
      }),
      tool({ auth: ghAuth }),
    ],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
  } as DoctorReport;
}

async function openDiagnostics(ghAuth: ToolAuth) {
  const r = renderUi(<DiagnosticsPage scope="this-mac" />, {
    fixtures: {
      dependency_doctor: () => report(ghAuth),
      build_cache_status: () => null,
    },
  });
  // 1.174.0 (DS7): the hint is "gh <version> · <sentence>".
  const hint = await screen.findByText(new RegExp(`${ghAuth.detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  const row = hint.closest(".ux-row") as HTMLElement | null;
  expect(row, "the gh row").not.toBeNull();
  return { ...r, row: row as HTMLElement };
}

describe("Diagnostics' gh row with the keychain locked (GH #189)", () => {
  it("is neutral: Ready, counted, and Sign in only in its menu", async () => {
    const { user, row, tauri } = await openDiagnostics({
      signedIn: null,
      detail: LOCKED,
      command: "gh auth login",
      action: "Sign in",
      optionalStep: true,
    });
    // It asked, as Diagnostics does.
    expect(tauri.callsOf("dependency_doctor")[0].args).toMatchObject({ withAuth: true });
    expect(within(row).getByText("Ready")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(within(row).queryByText(/not signed in/)).toBeNull();
    expect(screen.getByText("2 of 2 ready")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "More about gh" }));
    const items = screen.getAllByRole("menuitem");
    expect(items[0].textContent).toContain("Sign in — runs gh auth login in a shell tile");
  });

  it("a gh with no account at all still says so, with Sign in on the row", async () => {
    const { row } = await openDiagnostics({
      signedIn: false,
      detail: SIGNED_OUT,
      command: "gh auth login",
      action: "Sign in",
      optionalStep: false,
    });
    expect(within(row).getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(within(row).queryByText("Ready")).toBeNull();
    expect(screen.getByText("1 of 2 ready")).toBeTruthy();
  });
});

// GH #247: a required tool was marked with a chip. 1.174.0 (DS7, scene
// 13): no chips in a title — the row is titled by what it is for, and the
// program is in its hint.
describe("Diagnostics' gh row title", () => {
  it("says what gh is for, with no Required chip", async () => {
    const { row } = await openDiagnostics({
      signedIn: null,
      detail: LOCKED,
      command: "gh auth login",
      action: "Sign in",
      optionalStep: true,
    });
    expect(within(row).getByText("Opens pull requests and reads GitHub's checks")).toBeTruthy();
    expect(within(row).getByText(/^gh /)).toBeTruthy();
    expect(screen.queryByText("Required")).toBeNull();
  });
});
