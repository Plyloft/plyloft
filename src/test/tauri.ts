// GH #172: the stubbed Tauri layer the behavioural UI tests render against.
//
// It sits where the real bridge sits — `window.__TAURI_INTERNALS__`, through
// `@tauri-apps/api/mocks` — so every `invoke` and `listen` in the app reaches it
// unchanged: `src/ipc.ts`, a store calling `invoke` itself, a plugin. Nothing in
// the app is mocked module by module, so a test cannot pass because it stubbed a
// different path from the one the component takes.
//
// - `invoke(cmd, args)` answers from a per-command fixture and is recorded.
//   A command with no fixture resolves `undefined` and is recorded in
//   `unhandled` — and the test **fails** afterwards (setup.ts calls
//   `assertNoUnhandled`), unless it said `allowUnhandled()`. Fail closed: an
//   IPC nobody expected is a finding, not a silent `undefined` (review 1).
// - `listen(event, handler)` is captured, and `emit(event, payload)` runs every
//   live handler for that event, the way a Rust `app.emit` would.
// - A raw request (`invoke(cmd, bytes, { headers })`, D3) is recorded with its
//   body as `args` and its headers as `headers`.
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

/** A command's answer: a value, or a function of its arguments (sync or async).
 *  A function that throws — or returns a rejected promise — is a refused call. */
export type Fixture = unknown | ((args: Record<string, unknown>) => unknown);

export type Call = { cmd: string; args: Record<string, unknown>; headers?: Record<string, string> };

type EventPayload = { event: string; payload: unknown };

export interface TauriStub {
  /** Every `invoke` except the event plugin's own, in order. */
  readonly calls: Call[];
  /** The commands that had no fixture. */
  readonly unhandled: Call[];
  /** Set (or replace) a command's answer. */
  fixture(cmd: string, answer: Fixture): void;
  /** The calls to one command. */
  callsOf(cmd: string): Call[];
  /** Run every handler `listen`ed for `event`. */
  emit(event: string, payload?: unknown): void;
  /** How many handlers are listening for `event` now. */
  listeners(event: string): number;
  /** Let this test end with commands that had no fixture. */
  allowUnhandled(): void;
  /** Throw, naming them, when commands had no fixture and that was not allowed. */
  assertNoUnhandled(): void;
}

let current: TauriStub | null = null;

/** The stub installed for the running test (setup.ts installs one per test). */
export function tauri(): TauriStub {
  if (!current) throw new Error("no Tauri stub installed — is src/test/setup.ts loaded?");
  return current;
}

/** Install a fresh stub, replacing any previous one. */
export function installTauriStub(fixtures: Record<string, Fixture> = {}): TauriStub {
  clearMocks();
  mockWindows("main");
  const answers = new Map<string, Fixture>(Object.entries(fixtures));
  const calls: Call[] = [];
  const unhandled: Call[] = [];
  // event name → callback ids registered through `transformCallback`
  const handlers = new Map<string, number[]>();
  let unhandledAllowed = false;
  // The headers of the invoke being answered: `mockIPC` hands its callback
  // only the command and the payload, so the bridge is wrapped below.
  let pendingHeaders: Record<string, string> | undefined;

  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "plugin:event|listen": {
        const event = String(args.event);
        const id = Number(args.handler);
        handlers.set(event, [...(handlers.get(event) ?? []), id]);
        return id;
      }
      case "plugin:event|unlisten": {
        const event = String(args.event);
        const id = Number(args.eventId);
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== id),
        );
        return null;
      }
      case "plugin:event|emit":
        stub.emit(String(args.event), args.payload);
        return null;
    }
    const call: Call = pendingHeaders ? { cmd, args, headers: pendingHeaders } : { cmd, args };
    pendingHeaders = undefined;
    calls.push(call);
    if (!answers.has(cmd)) {
      unhandled.push(call);
      return undefined;
    }
    const answer = answers.get(cmd);
    return typeof answer === "function"
      ? (answer as (a: Record<string, unknown>, h?: Record<string, string>) => unknown)(args, call.headers)
      : structuredClone(answer);
  });

  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, options?: { headers?: unknown }) => unknown };
  }).__TAURI_INTERNALS__;
  const bridge = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    const headers = options?.headers;
    pendingHeaders =
      headers instanceof Headers
        ? Object.fromEntries(headers.entries())
        : Array.isArray(headers)
          ? Object.fromEntries(headers as [string, string][])
          : (headers as Record<string, string> | undefined);
    return bridge(cmd, args, options);
  };

  const stub: TauriStub = {
    calls,
    unhandled,
    fixture(cmd, answer) {
      answers.set(cmd, answer);
    },
    callsOf(cmd) {
      return calls.filter((c) => c.cmd === cmd);
    },
    emit(event, payload) {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { runCallback: (id: number, data: EventPayload) => void };
      }).__TAURI_INTERNALS__;
      for (const id of handlers.get(event) ?? []) {
        internals.runCallback(id, { event, payload });
      }
    },
    listeners(event) {
      return (handlers.get(event) ?? []).length;
    },
    allowUnhandled() {
      unhandledAllowed = true;
    },
    assertNoUnhandled() {
      if (unhandledAllowed || unhandled.length === 0) return;
      const names = [...new Set(unhandled.map((c) => c.cmd))].join(", ");
      throw new Error(
        `invoke reached command(s) with no fixture: ${names}. Give each a fixture, ` +
          "or call tauri().allowUnhandled() if the test does not care.",
      );
    },
  };
  current = stub;
  return stub;
}

export function uninstallTauriStub(): void {
  clearMocks();
  current = null;
}
