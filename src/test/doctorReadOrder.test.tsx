// GH #227 review 2: `dependency_doctor` runs on a worker, so two reads can
// answer out of order. A `refresh` sent before a `reprobe` that lands after it
// must not put back the older report.
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorReport } from "../ipc";
import { resetDoctorReadsForTest, useDoctor } from "../store/doctorStore";
import { tauri } from "./tauri";

function report(tag: string): DoctorReport {
  return {
    tools: [],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: tag,
    allRequiredOk: true,
  } as DoctorReport;
}

afterEach(() => {
  resetDoctorReadsForTest();
  useDoctor.setState({ report: null, loading: false, env: null });
});

describe("doctor reads that answer out of order (GH #227)", () => {
  it("a slower, older refresh never overwrites a newer reprobe", async () => {
    resetDoctorReadsForTest();
    const releases: Array<() => void> = [];
    const answers = [report("older refresh"), report("newer reprobe")];
    let n = 0;
    tauri().fixture("dependency_doctor", () => {
      const answer = answers[n++];
      // The first read (the refresh) is held until released; the second
      // (the reprobe) answers at once.
      if (n === 1) return new Promise((resolve) => releases.push(() => resolve(answer)));
      return answer;
    });
    tauri().fixture("shell_env_retry", () => ({ path: "/usr/bin" }));

    const refresh = useDoctor.getState().refresh();
    // Let the refresh's read go out before the reprobe's.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reprobe = useDoctor.getState().reprobe();
    await reprobe;
    expect(useDoctor.getState().report?.probeError).toBe("newer reprobe");
    // The older read is still out: still loading.
    expect(useDoctor.getState().loading).toBe(true);

    releases[0]();
    await refresh;
    expect(tauri().callsOf("dependency_doctor")).toHaveLength(2);
    expect(useDoctor.getState().report?.probeError).toBe("newer reprobe");
    expect(useDoctor.getState().loading).toBe(false);
  });

  it("in order, each answer is applied", async () => {
    resetDoctorReadsForTest();
    let n = 0;
    tauri().fixture("dependency_doctor", () => report(`read ${++n}`));
    await useDoctor.getState().refresh();
    expect(useDoctor.getState().report?.probeError).toBe("read 1");
    await useDoctor.getState().refresh();
    expect(useDoctor.getState().report?.probeError).toBe("read 2");
  });
});
