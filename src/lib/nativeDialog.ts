/**
 * QoL 1.168 (Challenger 3): the native file dialogs, counted while open. A
 * native dialog takes the focus from the page while the person is still in
 * Plyloft, so "not in front" must not read it as away
 * (`store/notifyGate.ts`, `notifyTarget.ts`). Every open and save dialog goes
 * through here.
 */
import {
  open as pluginOpen,
  save as pluginSave,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

let open = 0;

/** A native dialog is on screen. */
export function nativeDialogOpen(): boolean {
  return open > 0;
}

async function counted<T>(run: () => Promise<T>): Promise<T> {
  open += 1;
  try {
    return await run();
  } finally {
    open -= 1;
  }
}

export function openDialog<T extends OpenDialogOptions>(options?: T) {
  return counted(() => pluginOpen<T>(options));
}

export function saveDialog(options?: SaveDialogOptions) {
  return counted(() => pluginSave(options));
}
