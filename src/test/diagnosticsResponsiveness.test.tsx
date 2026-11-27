// H1 (1.173.0): Settings › Diagnostics › What else Plyloft read ›
// Responsiveness. The real DiagnosticsPage over the stubbed `watchdog_status`:
//
//  - no freezes: the row says so, even with nothing else read;
//  - a freeze: the latest one in words, with the memory at that moment;
//  - Look again reads the watchdog again;
//  - Details carries the watchdog's own log lines.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport } from "../ipc";
import type { ResponsivenessStatus } from "../lib/responsiveness";
import { renderUi, screen } from "./render";

const GB = 1024 * 1024 * 1024;

const report: DoctorReport = {
  tools: [],
  teamSkills: null,
  projectSkills: null,
  microphone: null,
  whisperModel: null,
  dictationShell: null,
  sharedDefinition: null,
  probeError: null,
  allRequiredOk: true,
  aiReady: true,
  gitIdentity: null,
};

function open(status: ResponsivenessStatus) {
  return renderUi(<DiagnosticsPage scope="this-mac" />, {
    fixtures: {
      dependency_doctor: () => report,
      build_cache_status: () => null,
      watchdog_status: () => status,
      // Look again asks the login shell again (reprobe).
      shell_env_retry: () => null,
    },
  });
}

function rowOf(label: string): HTMLElement {
  const row = screen.getByText(label).closest(".ux-row") as HTMLElement | null;
  expect(row, `the ${label} row`).not.toBeNull();
  return row as HTMLElement;
}

describe("Diagnostics › Responsiveness (H1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says there were no freezes", async () => {
    open({ startedAt: 0, episodes: [], lines: [], previousRun: null });
    // 1.174.0 (DS7): one line under the row — what happened, then the rest.
    await screen.findByText(/^No freezes since Plyloft started\. Plyloft checks every few seconds that the window answers/);
    expect(screen.getByText("What else Plyloft read")).toBeTruthy();
    expect(within(rowOf("Responsiveness")).getByText(/^No freezes since Plyloft started\./)).toBeTruthy();
  });

  it("says the latest freeze and the memory then, and Details has the log lines", async () => {
    const at = new Date();
    at.setHours(14, 2, 0, 0);
    const line = "2026-10-30 14:02:40  watchdog: the window has not answered for 10 s; memory: available 1.1 GB of 16.0 GB (low)";
    const { tauri, user } = open({
      startedAt: 0,
      episodes: [
        {
          kind: "window",
          at: at.getTime(),
          secs: 40,
          over: true,
          memory: {
            totalBytes: 16 * GB,
            availableBytes: 1.1 * GB,
            swapUsedBytes: 1.9 * GB,
            compressedBytes: null,
            processBytes: null,
            low: true,
          },
        },
      ],
      lines: [line],
      previousRun: null,
    });
    // 1.174.0 (DS7, scene 13): and with memory low, what to do.
    await screen.findByText(
      /^The window didn't answer for 40 s at 14:02 — memory was low \(1\.1 GB free, swap 1\.9 GB\)\. Close other apps or a virtual machine: Plyloft needs about 2 GB free\. /,
    );
    expect(document.querySelector("pre.ux-output")?.textContent).toContain(line);

    const before = tauri.callsOf("watchdog_status").length;
    await user.click(screen.getByRole("button", { name: "Look again" }));
    expect(tauri.callsOf("watchdog_status").length).toBe(before + 1);
  });

  it("shows a freeze while the page is open, without reopening it (1.173.0 walk)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const at = new Date();
    at.setHours(14, 2, 0, 0);
    let status: ResponsivenessStatus = { startedAt: 0, episodes: [], lines: [], previousRun: null };
    const { tauri } = renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: {
        dependency_doctor: () => report,
        build_cache_status: () => null,
        watchdog_status: () => status,
        shell_env_retry: () => null,
      },
    });
    await screen.findByText(/^No freezes since Plyloft started\./);
    const before = tauri.callsOf("watchdog_status").length;
    status = {
      ...status,
      episodes: [{ kind: "window", at: at.getTime(), secs: 15, over: true, memory: null }],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(tauri.callsOf("watchdog_status").length).toBeGreaterThan(before);
    await screen.findByText(/^The window didn't answer for 15 s at 14:02\. /);
  });

  it("says when Plyloft itself couldn't run because the computer was too busy", async () => {
    const at = new Date();
    at.setHours(14, 2, 0, 0);
    open({
      startedAt: 0,
      episodes: [
        { kind: "window", at: at.getTime(), secs: 10, over: true, memory: null },
        { kind: "busy", at: at.getTime(), secs: 40, over: true, memory: null },
      ],
      lines: [],
      previousRun: null,
    });
    await screen.findByText(/^Plyloft couldn't run for 40 s at 14:02 because the computer was too busy\. /);
    expect(within(rowOf("Responsiveness")).queryByText(/freezes since/)).toBeNull();
  });

  it("says the last run didn't end cleanly", async () => {
    const started = new Date();
    started.setHours(8, 10, 0, 0);
    open({
      startedAt: 0,
      episodes: [],
      lines: [],
      previousRun: { startedAt: started.getTime(), lastBeatAt: null, lastMemory: null },
    });
    await screen.findByText(/The last run \(from 08:10\) didn't end cleanly\./);
  });
});
