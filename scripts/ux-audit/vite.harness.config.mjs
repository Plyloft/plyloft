// Harness build of the real Ply frontend (this repo's src, untouched).
// Only difference from `npm run build`: the HTML entry is a virtual module
// that imports the app's real `src/main.tsx` AND exposes the app's own
// zustand stores on `window.__ply` so scenarios can jump straight to states
// (open a card, set a center mode) instead of long click paths. Rendering is
// 100% the app's own components/CSS.
import { createRequire } from "node:module";
import path from "node:path";
import { REPO, OUT, DIST } from "./config.mjs";

export const ROOT = REPO;
const req = createRequire(ROOT + "/package.json");
const { default: react } = await import(req.resolve("@vitejs/plugin-react"));
const VIRTUAL = "virtual:ply-harness-entry";

function harnessEntry() {
  return {
    name: "ply-harness-entry",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace('src="/src/main.tsx"', `src="/${VIRTUAL}"`);
      },
    },
    resolveId(id) {
      if (id === VIRTUAL || id === `/${VIRTUAL}` || id.endsWith(VIRTUAL)) return "\0" + VIRTUAL;
      return null;
    },
    load(id) {
      if (id !== "\0" + VIRTUAL) return null;
      return `
        const stores = import.meta.glob("/src/store/*.ts", { eager: true });
        const libs = import.meta.glob(["/src/lib/cardLifecycle.ts", "/src/lib/undoable.ts"], { eager: true });
        window.__ply = { stores, libs };
        import "/src/main.tsx";
      `;
    },
  };
}

export const config = ({
  root: ROOT,
  configFile: false,
  plugins: [harnessEntry(), react()],
  // `vite.config.ts` defines this for the app's own builds; this config
  // doesn't load that file (`configFile: false`), and without it every
  // capture fails on `__PLY_TEST_BRIDGE__ is not defined` (QoL 1.168 H1).
  define: { __PLY_TEST_BRIDGE__: "false" },
  logLevel: "warn",
  cacheDir: path.join(OUT, ".vite-cache"),
  build: {
    outDir: DIST,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 100000,
  },
});
