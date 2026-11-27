// Tiny static server for the harness build, plus three READ-ONLY endpoints the
// mock uses to show the Ply workspace's real files in Code: the seeded Ply
// workspace's cwd (whatever the snapshot says) is mapped onto this repository.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, DIST, OUT } from "./config.mjs";

let WS_CWD = REPO;
const WORKTREE = REPO;
const SKIP = new Set([".git", "node_modules", "target", "dist", ".vite-cache", "ux-audit-out", path.basename(OUT)]);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };

function mapPath(p) {
  if (!p || !(p === WS_CWD || p.startsWith(WS_CWD + "/"))) return null;
  const real = path.resolve(WORKTREE + p.slice(WS_CWD.length));
  if (real !== WORKTREE && !real.startsWith(WORKTREE + "/")) return null;
  return real;
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
function walk(dir, base, out, depth) {
  if (out.length > 20000 || depth > 12) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out, depth + 1);
    else out.push(path.relative(base, full));
  }
}

/** `wsCwd`: the Ply workspace's cwd in the seed; its files are served from REPO. */
export function startServer(port = 4174, { wsCwd = REPO } = {}) {
  WS_CWD = wsCwd;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams.get("path");
    try {
      if (url.pathname === "/__ls") {
        const real = mapPath(q);
        if (!real || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) { res.writeHead(404); return res.end("[]"); }
        const list = fs.readdirSync(real, { withFileTypes: true }).filter((e) => e.name !== ".DS_Store").map((e) => {
          const full = path.join(real, e.name);
          let size = 0; try { size = e.isDirectory() ? 0 : fs.statSync(full).size; } catch {}
          return { name: e.name, path: q + "/" + e.name, isDir: e.isDirectory(), size };
        });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(list));
      }
      if (url.pathname === "/__fs") {
        const real = mapPath(q);
        if (!real || !fs.existsSync(real) || fs.statSync(real).isDirectory()) { res.writeHead(404); return res.end(); }
        if (fs.statSync(real).size > 5 * 1024 * 1024) { res.writeHead(413); return res.end(); }
        const buf = fs.readFileSync(real);
        if (isBinary(buf)) { res.writeHead(415); return res.end(); }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(buf);
      }
      if (url.pathname === "/__walk") {
        const real = mapPath(q);
        const out = [];
        if (real) walk(real, real, out, 0);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ paths: out, truncated: out.length > 20000 }));
      }
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.argv[2] || 4174));
  console.log("serving on", s.address());
}
