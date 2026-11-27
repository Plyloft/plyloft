import { create } from "zustand";

// GH #281: the one way to ask the human yes/no in Ply — the confirm Sheet
// (`Sheet size="confirm"`, through ConfirmDialog), not a native macOS alert.
// `confirmSheet` returns the answer as a Promise; a single host in the App
// (ConfirmSheetHost) draws the question at the head of the queue.
//
// Always await it (or consume it with `.then`) and act only on `true`: the
// repository contract src/lib/nativeDialogs.test.ts fails on an un-awaited
// call, and on any native confirm/alert.
//
// Fails closed, as confirmDialog did: with no host on screen to ask, the
// answer is `false` and the guarded action does not run.

export interface ConfirmRequest {
  /** The question, as the sheet's title. */
  title: string;
  /** One or two sentences under it: what happens, what stays. */
  body?: string;
  /** 1.169.1 (R2): a list under the body, one line each (the commits a
   *  pull request would also carry). */
  items?: string[];
  /** 1.171.0 A3 (DL-21): the list folded under this ("Show them"), the body
   *  read first. */
  itemsLabel?: string;
  /** The accepting button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** The declining button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** F21: an optional third way out, a plain button beside the accepting
   *  one (the Free slot sheet's "Open it"); answered as `alt`. */
  altLabel?: string;
  /** 1.173.0 (B3): `altLabel` sits after the accepting button, which keeps
   *  the focus (Back · Leave those out · Ship anyway). */
  altAfter?: boolean;
  /** 1.173.0 (B3): a sentence under the list; with it, `body` leads. */
  note?: string;
  /** 1.173.0 (C2): a quiet sentence in the sheet's body under the lede. */
  hint?: string;
  /** 1.173.0 (C2): Cancel is the strong button (`cbtn--strong`) and has
   *  the focus; the accepting button keeps its own tone. */
  strongCancel?: boolean;
  /** 1.173.0 (C2): the words are already this platform's (`machineWords`
   *  ran on their templates), and names in them are quoted as they are. */
  asIs?: boolean;
  /** 1.173.0 (B3): files as rows — the path in code style, an outline chip
   *  (scene 4); read like `items`. */
  fileRows?: { path: string; tag: string }[];
  /** A fourth way, a plain button before `altLabel`; answered as `alt2`. */
  alt2Label?: string;
  /** The accepting button is the one filled --danger button. */
  destructive?: boolean;
  /** C3: the safe answer is the default — Cancel takes focus and the
   *  accepting button is not highlighted (a second claim on someone's card). */
  cautious?: boolean;
  /** Windows walk (QoL 7.3): Cancel takes focus while the accepting button
   *  stays the accent one — Enter never opens checkout (the plan sheets). */
  focusCancel?: boolean;
  /** 1.169.0 (C8): a sentence the member ticks before the accepting button
   *  can be pressed (Switch to Team's no-refund consent). */
  agreement?: string;
  /** 1.176.1 walk: the buttons in one column, the same width with a shared
   *  right edge, Cancel first (for three long answers). */
  stacked?: boolean;
  /** G1: a web page to read more (the guide's section), opened in the
   *  browser under the body; it answers nothing. */
  link?: { label: string; url: string };
}

/** How the question was answered: the accepting button, the declining
 *  button, the third button (`altLabel`), or closed without either
 *  (Escape, the backdrop). */
export type ConfirmAnswer = "confirm" | "cancel" | "alt" | "alt2" | "dismiss";

interface Pending extends ConfirmRequest {
  id: number;
  resolve: (answer: ConfirmAnswer) => void;
}

interface ConfirmState {
  queue: Pending[];
  /** Hosts on screen; none, and nothing can be asked. */
  hosts: number;
}

export const useConfirmSheet = create<ConfirmState>(() => ({ queue: [], hosts: 0 }));

let nextId = 1;

/** Ask; resolves `true` only when the human confirmed. */
export function confirmSheet(request: ConfirmRequest): Promise<boolean> {
  if (useConfirmSheet.getState().hosts === 0) {
    console.error("confirmSheet: no host to ask with, treating as Cancel", request.title);
    return Promise.resolve(false);
  }
  return confirmChoice(request).then((answer) => answer === "confirm");
}

/** Ask, and say how it was answered — for a question whose "no" is kept,
 *  where closing the sheet must not count as one. With no host, `dismiss`. */
export function confirmChoice(request: ConfirmRequest): Promise<ConfirmAnswer> {
  if (useConfirmSheet.getState().hosts === 0) {
    console.error("confirmSheet: no host to ask with, treating as Cancel", request.title);
    return Promise.resolve("dismiss");
  }
  return new Promise<ConfirmAnswer>((resolve) => {
    const pending: Pending = { ...request, id: nextId++, resolve };
    useConfirmSheet.setState((s) => ({ queue: [...s.queue, pending] }));
  });
}

/** The head of the queue was answered. `ok: false` is the declining
 *  button unless `dismissed` says the sheet was only closed. */
export function answerConfirm(id: number, ok: boolean, dismissed = false): void {
  answerConfirmWith(id, ok ? "confirm" : dismissed ? "dismiss" : "cancel");
}

/** The head of the queue was answered with `answer`. */
export function answerConfirmWith(id: number, answer: ConfirmAnswer): void {
  const pending = useConfirmSheet.getState().queue.find((p) => p.id === id);
  if (!pending) return;
  useConfirmSheet.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }));
  pending.resolve(answer);
}

/** A host mounted; returns its unmount, which cancels what it held. */
export function registerConfirmHost(): () => void {
  useConfirmSheet.setState((s) => ({ hosts: s.hosts + 1 }));
  return () => {
    const { hosts, queue } = useConfirmSheet.getState();
    useConfirmSheet.setState({ hosts: hosts - 1, queue: hosts - 1 === 0 ? [] : queue });
    if (hosts - 1 === 0) for (const p of queue) p.resolve("dismiss");
  };
}
