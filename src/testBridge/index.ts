// SL-0 app tester (docs/app-tester/DESIGN.md): the JS agent of the dev-only
// test bridge. `main.tsx` imports it only when `__PLY_TEST_BRIDGE__` is true
// (test-bridge builds); every other build drops the import and this chunk.
//
// Rust (`src-tauri/src/test_bridge.rs`) calls `window.__plyTestBridge.handle`
// through `eval`; the answer goes back as the `test-bridge://reply` event.

import { emit } from "@tauri-apps/api/event";
import { buildTree, clean, elementForRef, flatten, renderTree, resolve, type Node, type Query } from "./tree";
import { domClick, domKey, domType, hitMark, hitsSince, installHits, parseChord, terminalSequence } from "./input";
import { linesOf, termAt, termWithin } from "./terminals";

type Request = { id: number; method: string; params: Record<string, unknown> };
type Params = Record<string, unknown>;

const MAX_NODES = 3000;
const WAIT_POLL_MS = 150;

declare global {
  interface Window {
    __plyTestBridge?: { handle(request: Request): void };
  }
}

function layoutAvailable(): boolean {
  return !navigator.userAgent.includes("jsdom");
}

function tree(root: Element = document.body) {
  return buildTree(root, {
    layout: layoutAvailable(),
    maxNodes: MAX_NODES,
    terminals: {
      at(el) {
        const term = termAt(el);
        return term ? { lines: linesOf(term) } : null;
      },
    },
  });
}

function query(params: Params): Query {
  return {
    ref: typeof params.ref === "string" ? params.ref : undefined,
    name: typeof params.name === "string" ? params.name : undefined,
    role: typeof params.role === "string" ? params.role : undefined,
    index: typeof params.index === "number" ? params.index : undefined,
  };
}

function find(params: Params): Node {
  return resolve(tree().nodes, query(params));
}

function describe(node: Node) {
  return { ref: node.ref, role: node.role, name: node.name, states: node.states };
}

export function snapshot(params: Params) {
  let root: Element = document.body;
  if (typeof params.scope === "string" && params.scope !== "window") {
    const el = elementForRef(params.scope);
    if (!el) throw new Error(`scope ref ${params.scope} is gone`);
    root = el;
  }
  const { nodes, truncated } = tree(root);
  const maxDepth = typeof params.max_depth === "number" ? params.max_depth : Infinity;
  let text = renderTree(nodes, 0, maxDepth);
  if (typeof params.filter === "string" && params.filter) {
    const needle = params.filter.toLowerCase();
    text = text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(needle))
      .join("\n");
  }
  const dialogs = flatten(nodes).filter((n) => n.role === "dialog" || n.role === "alertdialog");
  return {
    tree: text,
    truncated,
    focused: document.activeElement ? describeActive() : null,
    openDialogs: dialogs.map(describe),
  };
}

function describeActive() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const node = flatten(tree().nodes).find((n) => n.el === el);
  return node ? describe(node) : { tag: el.tagName.toLowerCase() };
}

export function locate(params: Params) {
  const node = find(params);
  const el = node.el;
  (el as HTMLElement).scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const top = document.elementFromPoint?.(cx, cy) ?? null;
  const unobscured = !!top && (top === el || el.contains(top));
  return {
    ...describe(node),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    center: { x: cx, y: cy },
    unobscured,
    obscuredBy: unobscured || !top ? null : clean(`${top.tagName.toLowerCase()} ${top.className ?? ""}`, 60),
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    mark: hitMark(),
  };
}

function click(params: Params) {
  const node = find(params);
  if (node.states.includes("disabled")) throw new Error(`${node.role} "${node.name}" is disabled`);
  domClick(node.el);
  return { clicked: describe(node), via: "dom" };
}

function type(params: Params) {
  const text = typeof params.text === "string" ? params.text : "";
  const node = find(params);
  const replace = params.replace !== false;
  const term = termWithin(node.el);
  if (term) {
    term.focus();
    term.input(text, true);
    // A CLI reads a burst as a paste, and an Enter inside it as a new line
    // (Codex and Claude, walks 2026-11-05): the Enter comes on its own.
    if (params.submit) {
      return new Promise((resolve) =>
        setTimeout(() => {
          term.input("\r", true);
          resolve({ typed: describe(node), via: "dom-terminal" });
        }, SUBMIT_PAUSE_MS),
      );
    }
    return { typed: describe(node), via: "dom-terminal" };
  }
  domType(node.el, text, { replace });
  if (params.submit) domKey(node.el, parseChord("enter"));
  return { typed: describe(node), via: "dom" };
}

const SUBMIT_PAUSE_MS = 600;

function key(params: Params) {
  const keys = typeof params.keys === "string" ? params.keys : "";
  const target = params.ref || params.name ? find(params).el : document.activeElement ?? document.body;
  const chord = parseChord(keys);
  const term = termWithin(target);
  if (term) {
    term.focus();
    term.input(terminalSequence(chord), true);
    return { pressed: keys, via: "dom-terminal" };
  }
  domKey(target, chord);
  return { pressed: keys, via: "dom" };
}

/** One look, no timers: a page behind other windows has its timers
 *  throttled (WebKit, App Nap), so waiting is done by the caller polling
 *  this — `ply-test-mcp`'s `ui_wait_for`. */
export function check(params: Params) {
  const gone = params.gone === true;
  const text = typeof params.text === "string" ? params.text.toLowerCase() : null;
  let present: boolean;
  if (text !== null) {
    present = renderTree(tree().nodes).toLowerCase().includes(text);
  } else {
    try {
      find(params);
      present = true;
    } catch {
      present = false;
    }
  }
  return { present, met: present !== gone };
}

async function waitFor(params: Params) {
  const timeout = typeof params.timeout_ms === "number" ? params.timeout_ms : 10_000;
  const gone = params.gone === true;
  const text = typeof params.text === "string" ? params.text.toLowerCase() : null;
  const started = Date.now();
  for (;;) {
    let present: boolean;
    if (text !== null) {
      present = renderTree(tree().nodes).toLowerCase().includes(text);
    } else {
      try {
        find(params);
        present = true;
      } catch {
        present = false;
      }
    }
    if (present !== gone) return { met: true, waitedMs: Date.now() - started };
    if (Date.now() - started >= timeout) {
      const what = text !== null ? `text "${params.text}"` : `control ${JSON.stringify(query(params))}`;
      throw new Error(`timed out after ${timeout}ms waiting for ${what} to ${gone ? "disappear" : "appear"}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_POLL_MS));
  }
}

function terminal(params: Params) {
  const node = find(params);
  const term = termWithin(node.el);
  if (!term) throw new Error(`no terminal in ${node.role} "${node.name}"`);
  const lines = linesOf(term);
  const count = typeof params.lines === "number" ? params.lines : 60;
  return { ref: node.ref, name: node.name, total: lines.length, lines: lines.slice(-count) };
}

function hits(params: Params) {
  const after = typeof params.after === "number" ? params.after : 0;
  const within = typeof params.ref === "string" ? elementForRef(params.ref) : null;
  return hitsSince(after, within);
}

function toasts() {
  const nodes = flatten(tree().nodes).filter((n) => n.role === "status" || n.role === "alert");
  return nodes.map((n) => ({ ...describe(n), text: clean(n.el.textContent ?? "", 300) }));
}

export async function dispatch(method: string, params: Params): Promise<unknown> {
  switch (method) {
    case "ui.snapshot":
      return snapshot(params);
    case "ui.locate":
      return locate(params);
    case "ui.click":
      return click(params);
    case "ui.type":
      return type(params);
    case "ui.key":
      return key(params);
    case "ui.wait":
      return waitFor(params);
    case "ui.check":
      return check(params);
    case "ui.terminal":
      return terminal(params);
    case "ui.hits":
      return hits(params);
    case "ui.mark":
      return { mark: hitMark() };
    case "ui.toasts":
      return toasts();
    default:
      throw new Error(`unknown method ${method}`);
  }
}

export function install(): void {
  installHits(window);
  window.__plyTestBridge = {
    handle(request: Request) {
      void dispatch(request.method, request.params ?? {})
        .then((result) => emit("test-bridge://reply", { id: request.id, ok: true, result }))
        .catch((error: unknown) =>
          emit("test-bridge://reply", {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    },
  };
  void emit("test-bridge://ready", {});
}
