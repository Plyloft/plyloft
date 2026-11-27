// GH #172: the one way a behavioural UI test renders something.
//
//     const { user, tauri } = renderUi(<EditorPage scope="mac" />, {
//       fixtures: { settings_set: ({ settings }) => settings },
//     });
//     await user.click(screen.getByRole("button", { name: "Undo" }));
//     expect(tauri.callsOf("settings_set")).toHaveLength(1);
//
// - The stores are the app's own zustand stores, reset to their initial state
//   after every test (setup.ts). Seed one with `useX.setState(…)` before
//   rendering, as the app's own loaders would have.
// - Tauri is the stub from ./tauri: `fixtures` answer `invoke`, `tauri.calls`
//   records it, `tauri.emit` runs what was `listen`ed.
// - `fakeTimers: true` puts the clock under the test's control and gives back a
//   `user` that advances it, so a 6-second toast can expire in a line.
// - `withToasts: true` renders the app's `ToastStack` beside the component, so
//   a toast (and its Undo) is on screen the way the person would see it.
import type { ReactElement } from "react";
import { act, render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ToastStack } from "../components/ToastStack";
import { ConfirmSheetHost } from "../components/ConfirmSheetHost";
import { tauri as currentStub, type Fixture, type TauriStub } from "./tauri";

export interface RenderUiOptions {
  /** Answers for `invoke`, by command. Added to the stub for this test. */
  fixtures?: Record<string, Fixture>;
  /** Fake timers, with `user` advancing them. */
  fakeTimers?: boolean;
  /** Render the toast stack beside the component. */
  withToasts?: boolean;
}

export type RenderUi = RenderResult & {
  user: ReturnType<typeof userEvent.setup>;
  tauri: TauriStub;
};

export function renderUi(ui: ReactElement, options: RenderUiOptions = {}): RenderUi {
  const tauri = currentStub();
  for (const [cmd, answer] of Object.entries(options.fixtures ?? {})) {
    tauri.fixture(cmd, answer);
  }
  if (options.fakeTimers) vi.useFakeTimers({ shouldAdvanceTime: false });
  const user = userEvent.setup(
    options.fakeTimers ? { advanceTimers: (ms) => vi.advanceTimersByTime(ms) } : {},
  );
  // GH #281: the confirm Sheet's host is always there, as it is in the App,
  // so a `confirmSheet` question is on screen for the test to answer.
  const result = render(
    <>
      {ui}
      {options.withToasts && <ToastStack />}
      <ConfirmSheetHost />
    </>,
  );
  return { ...result, user, tauri };
}

/** Let one animation frame pass, inside `act` — what a surface that focuses
 *  or measures "on the next frame" (the dialog stack, CodeMirror) waits for. */
export async function nextFrame(): Promise<void> {
  await act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

export { tauri } from "./tauri";
export { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
