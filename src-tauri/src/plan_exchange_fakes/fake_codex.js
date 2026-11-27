// A fake `codex app-server` for plan_exchange_tests (node, so it runs on
// the Mac and on Windows): a thread per process (`thr-<pid>`, known for
// resumes while `threads/<id>` exists), a critique for a message with a plan
// in it, a plan otherwise. With `codex-slow` there a turn waits for
// `turn/interrupt`; with `codex-delay` a turn starts 1.5 s late.
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const root = __ROOT__;
const logFile = __LOG__;
const log = (line) => fs.appendFileSync(logFile, line + "\n");
const has = (name) => fs.existsSync(path.join(root, name));
if (process.argv[2] !== "app-server") process.exit(9);
const pid = process.pid;
log(`codex ${pid} start cwd=${process.cwd()}`);
fs.mkdirSync(path.join(root, "threads"), { recursive: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let k = 0;
let working = "";

async function handle(line) {
  log(`codex ${pid} ${line}`);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  const params = msg.params || {};
  switch (msg.method) {
    case "initialize":
      send({ id, result: { userAgent: "fake" } });
      break;
    case "thread/start":
      fs.writeFileSync(path.join(root, "threads", `thr-${pid}`), "");
      send({ id, result: { thread: { id: `thr-${pid}` } } });
      break;
    case "thread/resume": {
      const th = params.threadId;
      if (th && fs.existsSync(path.join(root, "threads", th))) send({ id, result: { thread: { id: th } } });
      else send({ id, error: { code: -1, message: "no such thread" } });
      break;
    }
    case "turn/start": {
      if (has("codex-delay")) await sleep(1500);
      k += 1;
      const t = `${pid}-${k}`;
      const client = params.clientUserMessageId || "";
      send({ id, result: { turn: { id: `turn-${t}`, status: "inProgress", items: [] } } });
      send({ method: "turn/started", params: { threadId: "x", turn: { id: `turn-${t}` } } });
      send({ method: "item/completed", params: { item: { id: `user-${t}`, type: "userMessage", clientId: client, content: [] } } });
      if (has("codex-slow")) {
        send({ method: "item/agentMessage/delta", params: { itemId: `agent-${t}`, delta: "Ans" } });
        working = `turn-${t}`;
        break;
      }
      let text;
      if (line.includes("----- plan -----")) text = has("ready") ? "Fine.\n\nVerdict: ready" : "1. Tests are missing.\n\nVerdict: changes needed";
      else if (line.includes("Answer my last message again")) text = `## Goal\nRetried plan by ${pid}`;
      else text = `## Goal\nPlan ${k} by ${pid}`;
      send({ method: "item/started", params: { item: { id: `cmd-${t}`, type: "commandExecution", command: "rg TODO" } } });
      send({ method: "item/completed", params: { item: { id: `cmd-${t}`, type: "commandExecution", command: "rg TODO", status: "completed", exitCode: 0 } } });
      send({ method: "item/completed", params: { item: { id: `agent-${t}`, type: "agentMessage", text } } });
      send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1 } } } });
      send({ method: "turn/completed", params: { turn: { id: `turn-${t}`, status: "completed" } } });
      break;
    }
    case "turn/interrupt":
      send({ id, result: {} });
      send({ method: "turn/completed", params: { turn: { id: working, status: "interrupted" } } });
      working = "";
      break;
  }
}

// One line at a time, in order (a delayed turn holds the next line back).
let chain = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => { chain = chain.then(() => handle(line)); });
lines.on("close", () => chain.then(() => process.exit(0)));
