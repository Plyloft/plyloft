import { create } from "zustand";
import { teamWorkMode, type WorkModeView } from "../ipc";
import type { WorkMode } from "../lib/settingsShape";
import { useSettings } from "./settingsStore";
import { useWorkspaces } from "./workspaceStore";
import { useLicense } from "./licenseStore";
import { useAccount } from "./accountStore";

/**
 * OB-9 (onboarding §10): the one frontend source of truth for solo or team.
 *
 * The mode is Rust's (`team_work_mode` → `team::effective_work_mode`): an
 * explicit `settings.team.workMode` wins, except that a GitHub Issues board is
 * always team, and otherwise a Team plan owned by this person,
 * `settings.team.teamRepo` or a team clone make it team. The frontend never re-derives it; it asks again
 * whenever one of those inputs may have moved — the settings (a save here, or
 * `settings://changed` from anywhere, which the settings store follows), the
 * workspaces' boards, and the stored key.
 *
 * Solo is presentation only: nothing is deleted or disabled in the backend.
 * Before the first answer the mode is unknown (`null`), and unknown shows every
 * surface — the app as it was before OB-9 — so a slow read never hides a
 * team's pages from the team.
 */
type WorkModeStore = {
  mode: WorkMode | null;
  /** `settings.team.workMode` holds a choice (else `mode` is derived). */
  chosen: boolean;
  refresh: () => Promise<void>;
};

let generation = 0;

export const useWorkMode = create<WorkModeStore>((set) => ({
  mode: null,
  chosen: false,
  refresh: async () => {
    const mine = ++generation;
    try {
      const view: WorkModeView | null | undefined = await teamWorkMode();
      // The last question asked is the one answered: an older read that lands
      // late never overwrites a newer one.
      if (mine !== generation) return;
      if (view && (view.mode === "solo" || view.mode === "team")) {
        set({ mode: view.mode, chosen: view.chosen === true });
      }
    } catch (e) {
      console.warn("work mode not read:", e);
    }
  },
}));

/** Solo — the team surfaces of §10 are not drawn. Unknown is not solo. */
export function isSolo(mode: WorkMode | null): boolean {
  return mode === "solo";
}

/** The hook every §10 surface reads. */
export function useSolo(): boolean {
  return useWorkMode((s) => s.mode === "solo");
}

/** What the mode is computed from, as one string: a change asks again. */
function inputsKey(): string {
  const s = useSettings.getState().settings;
  const boards = useWorkspaces
    .getState()
    .workspaces.map((w) => `${w.id}:${w.kanbanSyncMode ?? "local"}`)
    .join(",");
  const info = useLicense.getState().info;
  const account = useAccount.getState().info;
  return [
    // U6: the plan saying this person owns a team makes it team.
    account?.plan ?? "",
    account?.teamRole ?? "",
    s.team?.workMode ?? "",
    s.team?.teamRepo ?? "",
    boards,
    info?.status ?? "",
    info?.teamRepo ?? "",
  ].join("|");
}

let started = false;
let unsubscribe: (() => void)[] = [];

/** Read the mode once and follow its inputs. Call once from App startup;
 *  idempotent. */
export function startWorkModeSubscription(): void {
  if (started) return;
  started = true;
  let last = inputsKey();
  void useWorkMode.getState().refresh();
  const onChange = () => {
    const next = inputsKey();
    if (next === last) return;
    last = next;
    void useWorkMode.getState().refresh();
  };
  unsubscribe = [
    useSettings.subscribe(onChange),
    useWorkspaces.subscribe(onChange),
    useLicense.subscribe(onChange),
    useAccount.subscribe(onChange),
  ];
}

/** Tests: forget the subscription and the answer. */
export function resetWorkModeForTests(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  started = false;
  generation += 1;
  useWorkMode.setState({ mode: null, chosen: false });
}
