#!/usr/bin/env node

import readline from "node:readline";

const marker = process.argv[2] ?? "ply-phase0-marker";
const serverName = process.argv[3] ?? "ply-phase0-probe";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

input.on("line", (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method } = request;
  if (id == null) return;

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: "0.1.0" },
      });
      break;
    case "ping":
      result(id, {});
      break;
    case "tools/list":
      result(id, {
        tools: [
          {
            name: "phase0_marker",
            description:
              "Return a fixed synthetic marker for Ply's local MCP contract probe.",
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      break;
    case "tools/call":
      if (request.params?.name !== "phase0_marker") {
        error(id, -32602, "unknown tool");
        break;
      }
      result(id, {
        content: [{ type: "text", text: marker }],
        isError: false,
      });
      break;
    default:
      error(id, -32601, `unsupported method: ${method}`);
  }
});
