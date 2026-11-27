// 1.176.0 R3 (review 4): a codex-chat tile checks Codex's path on a worker
// before `codex_app_start` (which runs on the main thread and only judges
// the snapshot): a Codex gone even after looking again never starts the App
// Server, and the tile says why in the backend's words, not its typed shape.
import { describe, expect, it } from "vitest";
import { CodexSession } from "../components/CodexSession";
import { renderUi, screen, tauri, waitFor } from "./render";

describe("a codex-chat tile on a stale path", () => {
  it("checks first, and stops without the App Server when Codex is gone", async () => {
    const gone =
      'PLY_CLI_UNAVAILABLE_V1:{"tool":"codex","was":"/old/codex"}\n' +
      "codex: not found in PATH. Plyloft looked for it again; it was at /old/codex.";
    renderUi(<CodexSession sessionId="codex-chat-stale" workspaceId="ws" cwd="/p" />, {
      fixtures: {
        codex_approval_list: [],
        cli_fresh_check: () => {
          throw gone;
        },
        codex_app_start: 7,
        codex_app_write: () => null,
        codex_app_stop: () => null,
      },
    });
    await screen.findByText(/Codex couldn't start/);
    expect(tauri().callsOf("cli_fresh_check")[0]?.args).toEqual({ tool: "codex" });
    expect(tauri().callsOf("codex_app_start")).toHaveLength(0);
    await waitFor(() => expect(document.body.textContent).toContain("codex: not found in PATH"));
    expect(document.body.textContent).not.toContain("PLY_CLI_UNAVAILABLE_V1");
  });

  it("starts the App Server once the check passes", async () => {
    renderUi(<CodexSession sessionId="codex-chat-fresh" workspaceId="ws" cwd="/p" />, {
      fixtures: {
        codex_approval_list: [],
        cli_fresh_check: null,
        codex_app_start: 7,
        codex_app_write: () => null,
        codex_app_stop: () => null,
      },
    });
    await waitFor(() => expect(tauri().callsOf("codex_app_start")).toHaveLength(1));
    const order = tauri().calls.map((c) => c.cmd);
    expect(order.indexOf("cli_fresh_check")).toBeLessThan(order.indexOf("codex_app_start"));
  });
});
