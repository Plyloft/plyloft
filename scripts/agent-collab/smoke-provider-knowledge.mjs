#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sidecar = resolve(
  process.argv[2] ?? "src-tauri/binaries/ply-mcp-aarch64-apple-darwin",
);
const repoRoot = resolve(process.argv[3] ?? process.cwd());

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(path) {
  if (!existsSync(path)) return "<absent>";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function configFingerprint(path) {
  if (!existsSync(path)) return "<absent>";
  if (path.endsWith(".claude.json")) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const projectMcp = Object.fromEntries(
      Object.entries(config.projects ?? {})
        .filter(([, value]) => Object.keys(value?.mcpServers ?? {}).length > 0)
        .map(([project, value]) => [project, value.mcpServers]),
    );
    return JSON.stringify(
      stableJson({
        mcpServers: config.mcpServers ?? null,
        projectMcp,
      }),
    );
  }
  return sha256(path);
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
        entries.push(`f:${childRelative}:${sha256(absolute)}`);
      }
    }
  }
  visit(root, "");
  return entries;
}

function exactPids(name) {
  try {
    return new Set(
      execFileSync("pgrep", ["-x", name], { encoding: "utf8" })
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function assertNoNewPids(before, after, name) {
  const added = [...after].filter((pid) => !before.has(pid));
  assert(added.length === 0, `${name} orphan(s) remain: ${added.join(", ")}`);
}

function memoryFile() {
  return `---
schemaVersion: 1
id: phase1b-provider-smoke
title: Phase1B provider sentinel
tags:
  - phase1b
createdAt: '2026-07-23T00:00:00Z'
updatedAt: '2026-07-23T00:00:00Z'
---
PLY_PHASE1B_ACCEPTED_KNOWLEDGE
`;
}

function runProvider(command, args, label) {
  const outcome = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`;
  if (outcome.error) {
    throw new Error(`${label} failed to launch: ${outcome.error.message}`);
  }
  assert(
    outcome.status === 0,
    `${label} exited ${outcome.status}:\n${output.slice(-4000)}`,
  );
  for (const marker of [
    "PLY_PHASE2_COORDINATION_SENTINEL",
    "PLY_PHASE2_HANDOFF_SENTINEL",
    "PLY_PHASE1B_ACCEPTED_KNOWLEDGE",
  ]) {
    assert(
      output.includes(marker),
      `${label} did not return ${marker}:\n${output.slice(-4000)}`,
    );
  }
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "ply-provider-knowledge-"));
try {
  assert(existsSync(sidecar), `sidecar not found: ${sidecar}`);
  const version = execFileSync(sidecar, ["--version"], { encoding: "utf8" }).trim();
  assert(version.includes("protocol 2"), `unexpected sidecar version: ${version}`);

  const configDir = join(fixtureRoot, "config");
  const projectDir = join(fixtureRoot, "project");
  const workspaceDir = join(
    configDir,
    "memory",
    "workspaces",
    "phase1b-smoke",
  );
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(workspaceDir, "provider-sentinel.md"), memoryFile());
  const coordinationDir = join(configDir, "coordination");
  mkdirSync(coordinationDir, { recursive: true });
  const projectIdentity = {
    workspaceId: "phase1b-smoke",
    git: true,
    project: {
      displayPath: join(projectDir, ".git"),
      comparisonKey: join(projectDir, ".git"),
    },
    worktree: {
      displayPath: projectDir,
      comparisonKey: projectDir,
    },
    displayCwd: projectDir,
  };
  const now = Date.now();
  writeFileSync(
    join(coordinationDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      trackingStartedAt: now,
      sessions: [
        {
          schemaVersion: 1,
          id: "PLY_PHASE2_COORDINATION_SENTINEL",
          provider: "shell",
          executionKind: "shell-tile",
          project: { kind: "project", ...projectIdentity },
          attendance: "human-attended",
          writeIntent: "unknown",
          enforcement: "advisory",
          capability: null,
          cardId: null,
          swarmId: null,
          roleId: null,
          runId: null,
          handoffId: null,
          ptyId: "provider-smoke-pty",
          processId: null,
          baseRevision: "provider-smoke-base",
          headRevision: null,
          status: "running",
          exitCode: null,
          error: null,
          diagnostics: [],
          startedAt: now,
          runningAt: now,
          endedAt: null,
          warningsObserved: [],
          retentionClass: "interactive",
          objective: null,
        },
      ],
      handoffs: [
        {
          schemaVersion: 1,
          id: "PLY_PHASE2_HANDOFF_SENTINEL",
          workspaceId: "phase1b-smoke",
          project: projectIdentity,
          sourceSessionId: "provider-smoke-source",
          sourceRunId: "provider-smoke-run",
          cardId: null,
          swarmId: null,
          roleId: null,
          provider: "claude",
          objective: "PLY_PHASE2_HANDOFF_SENTINEL",
          outcomeStatus: "completed",
          exitCode: 0,
          failure: null,
          baseRevision: "provider-smoke-base",
          headRevision: "provider-smoke-head",
          snapshotRunId: "provider-smoke-run",
          changes: {
            total: 1,
            paths: ["provider-smoke.txt"],
            truncated: false,
            swarmCollisions: 0,
          },
          reviewerArtifact: null,
          evidenceWarnings: [],
          verificationArtifacts: [],
          followUps: [],
          createdAt: now,
          protectedBy: [],
        },
      ],
    }),
  );

  // Codex exec requires a trusted repository before it initializes MCP.
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PlyPhase1B",
      "-c",
      "user.email=phase1b.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: projectDir },
  );

  const configPaths = [
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".codex", "config.toml"),
    join(repoRoot, ".mcp.json"),
  ];
  const configBefore = new Map(
    configPaths.map((path) => [path, configFingerprint(path)]),
  );
  const fixtureBefore = treeSnapshot(fixtureRoot);
  const pidsBefore = new Map(
    ["claude", "codex", "ply-mcp"].map((name) => [name, exactPids(name)]),
  );

  const sidecarArgs = [
    "--config-dir",
    configDir,
    "--workspace-id",
    "phase1b-smoke",
    "--project-cwd",
    projectDir,
  ];
  const claudeConfig = JSON.stringify({
    mcpServers: {
      ply: { command: sidecar, args: sidecarArgs },
    },
  });
  runProvider(
    "claude",
    [
      "-p",
      "Call mcp__ply__coordination_status, mcp__ply__handoff_recent, and mcp__ply__knowledge_search with query `Phase1B provider sentinel`. Return only these three markers, one per line: the active session id, the recent handoff id, and the first Knowledge result body.",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "mcp__ply__coordination_status mcp__ply__handoff_recent mcp__ply__knowledge_search",
      "--output-format",
      "json",
      "--mcp-config",
      claudeConfig,
    ],
    "Claude",
  );

  const codexCommand = JSON.stringify(sidecar);
  const codexArgs = JSON.stringify(sidecarArgs);
  runProvider(
    "codex",
    [
      "--ask-for-approval",
      "never",
      "-c",
      `mcp_servers.ply.command=${codexCommand}`,
      "-c",
      `mcp_servers.ply.args=${codexArgs}`,
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--cd",
      projectDir,
      "--json",
      "Call the ply coordination_status, handoff_recent, and knowledge_search MCP tools; use query `Phase1B provider sentinel` for Knowledge. Return only these three markers, one per line: the active session id, the recent handoff id, and the first Knowledge result body.",
    ],
    "Codex",
  );

  // Give provider pipe teardown a bounded window before checking children.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  for (const name of ["claude", "codex", "ply-mcp"]) {
    assertNoNewPids(pidsBefore.get(name), exactPids(name), name);
  }
  for (const [path, before] of configBefore) {
    assert(
      configFingerprint(path) === before,
      `provider MCP/settings config changed: ${path}`,
    );
  }
  assert(
    JSON.stringify(treeSnapshot(fixtureRoot)) === JSON.stringify(fixtureBefore),
    "provider or sidecar changed the fixture tree",
  );

  console.log("provider Knowledge smoke: 6/6 checks passed");
  console.log(`  ✓ bundled sidecar reports ${version}`);
  console.log("  ✓ Claude queried the same coordination, handoff, and Knowledge sentinels");
  console.log("  ✓ Codex queried the same coordination, handoff, and Knowledge sentinels");
  console.log("  ✓ provider MCP/settings and repository config unchanged");
  console.log("  ✓ accepted-Knowledge fixture byte-identical");
  console.log("  ✓ no new Claude, Codex, or ply-mcp process remains");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
