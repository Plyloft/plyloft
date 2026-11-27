import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// SL-0 app tester: PLY_TEST_BRIDGE=1 is honoured only inside a Tauri *debug*
// build (the CLI sets TAURI_ENV_DEBUG for its before-build hook). Anywhere
// else — a release build, a bare `vite build` — it fails the build instead of
// shipping the test agent.
function testBridge(): boolean {
  // @ts-expect-error process is a nodejs global
  const env = process.env;
  if (env.PLY_TEST_BRIDGE !== "1") return false;
  if (env.TAURI_ENV_DEBUG !== "true") {
    throw new Error("PLY_TEST_BRIDGE=1 is for Tauri debug builds only (scripts/app-tester/build-app.sh)");
  }
  return true;
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // SL-0 app tester (docs/app-tester/DESIGN.md): the dev-only test bridge's JS
  // agent is compiled in only when PLY_TEST_BRIDGE=1 (scripts/app-tester/
  // build-app.sh). In every other build this is `false` and the import in
  // main.tsx, with its chunk, is dropped.
  define: {
    __PLY_TEST_BRIDGE__: JSON.stringify(testBridge()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
