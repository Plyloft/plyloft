// Settings › Diagnostics, "What else Plyloft read": the shared workspace setup
// and Railway rows (1.173.0 B1/D1), drawn from the doctor report. Railway is
// optional, so every state reads as a value, never a failed row, and the
// command in its words is code. (These cases were held on the retired
// DependencyDoctor component until 1.176.0.)
import { describe, expect, it } from "vitest";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport } from "../ipc";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { renderUi, screen, within } from "./render";

const base = {
  tools: [],
  teamSkills: null,
  projectSkills: null,
  microphone: null,
  whisperModel: null,
  dictationShell: null,
  sharedDefinition: null,
  probeError: null,
  allRequiredOk: true,
} as unknown as DoctorReport;

function seed() {
  useWorkspaces.setState({
    workspaces: [{ id: "ws-1", name: "atelier", cwd: "/repo/atelier" } as Workspace],
    activeId: "ws-1",
  });
}

async function rowOf(label: string, report: DoctorReport) {
  seed();
  renderUi(<DiagnosticsPage scope="this-mac" />, {
    fixtures: { dependency_doctor: () => report, build_cache_status: () => null, project_try_command_get: () => null, worktree_settings_get: () => ({}) },
  });
  return (await screen.findByText(label)).closest(".ux-row") as HTMLElement;
}

describe("Diagnostics: the other reads", () => {
  it.each(["pending", "kept", "held"])("a shared setup that is %s shows its summary and detail", async (state) => {
    const row = await rowOf("Shared setup of atelier", {
      ...base,
      sharedDefinition: {
        workspace: "atelier",
        state,
        summary: "Changes not yet on main",
        detail: "The workspace definition has changes nobody else has yet.",
      },
    } as unknown as DoctorReport);
    expect(within(row).getByText("Changes not yet on main")).toBeTruthy();
    expect(within(row).getByText(/changes nobody else has yet/)).toBeTruthy();
  });

  it.each([
    ["ok", "signed in · project acme-project"],
    ["notLinked", "not linked here"],
    ["signedOut", "signed out"],
    ["unknown", "couldn't be read"],
  ])("a Railway row that is %s reads %s", async (state, summary) => {
    const row = await rowOf("Railway", {
      ...base,
      railway: { workspace: "atelier", state, summary, detail: "Plyloft only reads it." },
    } as unknown as DoctorReport);
    expect(within(row).getByText(summary)).toBeTruthy();
  });

  it("draws the Railway row's command as code", async () => {
    const row = await rowOf("Railway", {
      ...base,
      railway: {
        workspace: "atelier",
        state: "signedOut",
        summary: "signed out",
        detail: "Railway asks for a sign-in. Run `railway login` in a terminal, then Look again.",
      },
    } as unknown as DoctorReport);
    expect(row.querySelector("code")!.textContent).toBe("railway login");
    expect(row.textContent).not.toContain("`");
  });
});
