/** SL-0 app tester: test-bridge builds read and type into terminals through
 *  the page's registry (`src/testBridge/terminals.ts`), because WebGL leaves
 *  no text in the DOM. Every xterm in the app registers here, so the tester
 *  reaches a Builder, the Challenger or Setup's terminal as it reaches a
 *  tile. Dropped from every other build: `__PLY_TEST_BRIDGE__` is false there
 *  and the registry never exists. */
function registry(): Set<unknown> | undefined {
  return (window as { __plyTestTerminals?: Set<unknown> }).__plyTestTerminals;
}

/** Registers `term` in test-bridge builds; returns what unregisters it. */
export function registerTestTerminal(term: unknown): () => void {
  if (!__PLY_TEST_BRIDGE__) return () => {};
  registry()?.add(term);
  return () => {
    registry()?.delete(term);
  };
}
