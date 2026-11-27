// U6: a Team plan that says this person owns the team makes the mode team
// (Rust decides, `team::effective_work_mode`); the store has to ask again when
// the plan arrives, or the owner's first read stays solo until a relaunch.
import { describe, expect, it } from "vitest";
import { useAccount } from "../store/accountStore";
import { startWorkModeSubscription, useWorkMode } from "../store/workModeStore";
import { act, tauri, waitFor } from "./render";

describe("the work mode follows the plan (U6)", () => {
  it("asks again when the plan's owner role arrives", async () => {
    let asked = 0;
    tauri().fixture("team_work_mode", () => {
      asked += 1;
      return { mode: asked > 1 ? "team" : "solo", chosen: false };
    });
    startWorkModeSubscription();
    await waitFor(() => expect(useWorkMode.getState().mode).toBe("solo"));
    act(() =>
      useAccount.setState({
        info: { signedIn: true, login: "owner", plan: "team", teamRole: "owner", teamRepo: "o/team" } as never,
        loaded: true,
      }),
    );
    await waitFor(() => expect(useWorkMode.getState().mode).toBe("team"));
    expect(asked).toBe(2);
  });
});
