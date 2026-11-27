#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const binary = resolve(process.argv[2] ?? "src-tauri/target/debug/ply-mcp");
const repoRoot = resolve(process.argv[3] ?? process.cwd());

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function memoryFile({ id, title, tags = ["auth", "rust"], body }) {
  return `---
schemaVersion: 1
id: ${id}
title: ${title}
tags:
${tags.map((tag) => `  - ${tag}`).join("\n")}
createdAt: '2026-01-01T00:00:00Z'
updatedAt: '2026-01-01T00:00:00Z'
---
${body}
`;
}

function treeSnapshot(root) {
  const entries = [];
  function visit(path, relative) {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const info = statSync(absolute);
      if (info.isDirectory()) {
        entries.push(`d:${childRelative}`);
        visit(absolute, childRelative);
      } else {
        const digest = createHash("sha256")
          .update(readFileSync(absolute))
          .digest("hex");
        entries.push(`f:${childRelative}:${digest}`);
      }
    }
  }
  visit(root, "");
  return entries;
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ply-mcp did not exit after stdin EOF"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "ply-mcp-smoke-"));
let child;

try {
  assert(existsSync(binary), `binary not found: ${binary}`);
  assert(
    !existsSync(join(repoRoot, ".mcp.json")),
    "repository .mcp.json must not exist",
  );

  const configDir = join(fixtureRoot, "config");
  const projectDir = join(fixtureRoot, "project");
  const workspaceDir = join(configDir, "memory", "workspaces", "ws-smoke");
  const globalDir = join(configDir, "memory", "global");
  const sharedDir = join(projectDir, ".atelier", "library", "knowledge");
  for (const directory of [workspaceDir, globalDir, sharedDir]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    join(workspaceDir, "workspace.md"),
    memoryFile({
      id: "workspace-id",
      title: "Auth workspace",
      body: "workspace body",
    }),
  );
  writeFileSync(
    join(sharedDir, "shared.md"),
    memoryFile({
      id: "shared-id",
      title: "Auth shared",
      body: "shared body",
    }),
  );
  writeFileSync(
    join(globalDir, "global.md"),
    memoryFile({
      id: "global-id",
      title: "Auth global",
      body: "global body",
    }),
  );
  writeFileSync(join(globalDir, "malformed.md"), "not frontmatter\n");
  const coordinationDir = join(configDir, "coordination");
  mkdirSync(coordinationDir, { recursive: true });
  writeFileSync(
    join(coordinationDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      trackingStartedAt: Date.now(),
      sessions: [],
      handoffs: [
        {
          schemaVersion: 1,
          id: "handoff-smoke",
          workspaceId: "ws-smoke",
          sourceSessionId: "session-smoke",
          sourceRunId: "run-smoke",
          objective: "smoke handoff",
          createdAt: Date.now(),
        },
      ],
    }),
  );
  const before = treeSnapshot(fixtureRoot);

  child = spawn(
    binary,
    [
      "--config-dir",
      configDir,
      "--workspace-id",
      "ws-smoke",
      "--project-cwd",
      projectDir,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const pending = new Map();
  const output = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
    terminal: false,
  });
  output.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(String(response.id));
    if (waiter) {
      pending.delete(String(response.id));
      waiter.resolve(response);
    }
  });

  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`timeout waiting for ${method}`));
      }, 5000);
      pending.set(String(id), {
        resolve(response) {
          clearTimeout(timer);
          resolveRequest(response);
        },
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ply-mcp-smoke", version: "1" },
  });
  assert(initialized.result?.serverInfo?.name === "ply-mcp", "initialize failed");
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`,
  );

  const listed = await request("tools/list");
  assert(
    JSON.stringify(listed.result.tools.map((tool) => tool.name)) ===
      JSON.stringify([
        "knowledge_search",
        "knowledge_get",
        "coordination_status",
        "handoff_recent",
      ]),
    "unexpected tool surface",
  );

  const searched = await request("tools/call", {
    name: "knowledge_search",
    arguments: { query: "auth", tags: ["AUTH"], limit: 50 },
  });
  assert(searched.result?.isError === false, "knowledge_search returned an error");
  const ids = searched.result.structuredContent.entries.map((entry) => entry.id);
  assert(
    JSON.stringify(ids) ===
      JSON.stringify(["workspace-id", "shared-id", "global-id"]),
    `unexpected layer order: ${JSON.stringify(ids)}`,
  );

  const fetched = await request("tools/call", {
    name: "knowledge_get",
    arguments: { id: "shared-id" },
  });
  assert(
    fetched.result?.structuredContent?.entry?.shared === true,
    "knowledge_get did not return the shared entry",
  );

  const coordination = await request("tools/call", {
    name: "coordination_status",
    arguments: {},
  });
  assert(
    coordination.result?.structuredContent?.status?.state === "active",
    "coordination_status did not return active tracking",
  );

  const handoffs = await request("tools/call", {
    name: "handoff_recent",
    arguments: { limit: 1 },
  });
  assert(
    handoffs.result?.structuredContent?.handoffs?.[0]?.id === "handoff-smoke",
    "handoff_recent did not return the workspace handoff",
  );

  const after = treeSnapshot(fixtureRoot);
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    "accepted-Knowledge fixture changed during read-only calls",
  );

  child.stdin.end();
  const exited = await waitForExit(child);
  assert(
    exited.code === 0 && exited.signal === null,
    `ply-mcp exit was code=${exited.code} signal=${exited.signal}`,
  );
  assert(
    stderr.includes("skip") && stderr.includes("malformed.md"),
    "malformed accepted file was not reported to stderr",
  );

  console.log("ply-mcp smoke: 9/9 checks passed");
  console.log("  ✓ initialize and notification");
  console.log("  ✓ exact read-only tool list");
  console.log("  ✓ workspace → shared → global search order");
  console.log("  ✓ tag filter and knowledge_get");
  console.log("  ✓ coordination_status reports active workspace tracking");
  console.log("  ✓ handoff_recent returns bounded workspace receipts");
  console.log("  ✓ malformed file skipped and logged");
  console.log("  ✓ fixture tree byte-identical after calls");
  console.log("  ✓ EOF exits cleanly; repository has no .mcp.json");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}
