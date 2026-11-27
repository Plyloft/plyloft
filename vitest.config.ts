import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// GH #172: the behavioural UI tests — components rendered under jsdom, with the
// Tauri layer stubbed (src/test/tauri.ts) and every zustand store reset between
// tests (src/test/setup.ts). Kept apart from vite.config.ts so the app's build
// never sees any of it: `vite build` reads vite.config.ts and index.html only.
//
// Only `*.test.tsx` under src/ is collected. The pure contracts stay
// `src/lib/*.test.ts`, run one by one under `node --experimental-strip-types`
// by scripts/ppvp-pure-contracts.sh; the two suffixes never overlap.
export default defineConfig({
  plugins: [react()],
  // The app tester's build constant (vite.config.ts): off under test.
  define: { __PLY_TEST_BRIDGE__: "false" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["src/test/unpooledBuffers.ts", "src/test/setup.ts"],
    // One file's module state (a store, a module-level Map) never leaks into
    // another's: each file gets its own module graph.
    isolate: true,
    restoreMocks: true,
    // The first test in a file that mounts a real CodeMirror view pays the
    // file's cold start (first mount, first keymap, JIT) inside its own time:
    // about 1 s idle, but 3.5–6.5 s under load (8.3 s seen on efficiency
    // cores), which crossed vitest's 5 s default and failed files at random,
    // up to 7 files affected. A timed-out test also keeps running into the
    // next one and fails the rest of its file. 20 s is headroom for a loaded
    // machine; a real hang still fails, later (up to 20 s per hung test).
    testTimeout: 20_000,
  },
});
