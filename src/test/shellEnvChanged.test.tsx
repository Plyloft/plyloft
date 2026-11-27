// 2026-10-16: a changed Settings PATH override re-probes in the background
// and the backend sends `shell-env://changed`. Without taking it, the
// Terminals page kept the old snapshot (no Claude/Codex buttons) until the
// next Look again.
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorReport, ShellEnvInfo } from "../ipc";
import { resetDoctorReadsForTest, startDoctorSubscriptions, useDoctor } from "../store/doctorStore";
import { tauri } from "./tauri";

afterEach(() => {
  resetDoctorReadsForTest();
  useDoctor.setState({ report: null, loading: false, env: null });
});

describe("shell-env://changed", () => {
  it("replaces the window's env and re-reads the doctor report", async () => {
    tauri().fixture("dependency_doctor", () => ({ tools: [], allRequiredOk: true }) as unknown as DoctorReport);
    useDoctor.setState({ env: { path: "/usr/bin", claudePath: null } as ShellEnvInfo });
    startDoctorSubscriptions();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fresh = { path: "/Users/me/.npm-global/bin", claudePath: "/Users/me/.npm-global/bin/claude" };
    tauri().emit("shell-env://changed", fresh);

    expect(useDoctor.getState().env).toEqual(fresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tauri().callsOf("dependency_doctor").length).toBeGreaterThan(0);
  });
});
