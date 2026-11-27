// A fake `claude` for plan_exchange_tests (node, so the same fake runs on
// the Mac and, through an npm-style `.cmd` shim, under Windows' ConPTY).
// It keeps its transcript in its own cwd's project folder, as Claude does,
// so two sessions in two folders never share one. It answers each bracketed
// paste: a message with a plan in it gets a critique (`Verdict: ready` when
// `ready` is beside the projects, else `changes needed`); any other gets a
// plan after a Read tool call (a 16,000-character plan when `long` is
// there). With `slow` there a turn stays open until Esc; with `noend` no
// `turn_duration` is written; with `menu` a numbered menu is drawn.
// Every pasted message is also written whole to `pastes/<pid>-<n>.txt`.
"use strict";
const fs = require("fs");
const path = require("path");
const root = __ROOT__;
const logFile = __LOG__;
const log = (line) => fs.appendFileSync(logFile, line + "\n");
const has = (name) => fs.existsSync(path.join(root, name));

let sid = "";
let resume = "";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; ) {
  const a = args[i];
  if (a === "--session-id") { sid = args[i + 1]; i += 2; }
  else if (a === "--resume") { sid = args[i + 1]; resume = "1"; i += 2; }
  else if (a === "--restricted" || a === "--strict-mcp-config") { i += 1; }
  else if (a === "--add-dir") {
    i += 1;
    while (i < args.length && !args[i].startsWith("--") && fs.existsSync(args[i]) && fs.statSync(args[i]).isDirectory()) i += 1;
  }
  else if (a.startsWith("--")) { i += 2; }
  else { log("positional " + a); i += 1; }
}
const here = process.cwd();
const slug = here.replace(/[^A-Za-z0-9]/g, "-");
const proj = path.join(root, "claude-config", "projects", slug);
fs.mkdirSync(proj, { recursive: true });
const t = path.join(proj, sid + ".jsonl");
const pid = process.pid;
log(`claude ${pid} start sid=${sid} resume=${resume} cwd=${here}`);
if (resume && !fs.existsSync(t)) {
  process.stdout.write(`No conversation found with session ID: ${sid}\r\n`);
  process.exit(1);
}
const entry = (value) => fs.appendFileSync(t, JSON.stringify(value) + "\n");
const out = (s) => process.stdout.write(s);
const R = "─".repeat(40);
const paint = (a, b, c) => out(`\x1b[2J\x1b[H\x1b[1;1H${a}\x1b[3;1H${b}\x1b[4;1H${R}\x1b[5;1H❯ \x1b[6;1H${R}\x1b[7;1H  ${c}\x1b[5;3H`);
const idle = () => paint("⏺ Answer", "✻ Worked for 1s · done", "? for shortcuts");
const busy = () => paint("❯ working", "✶ Herding… (1s)", "⏵⏵ don't ask on · esc to interrupt");
const doneFooter = () => out("\x1b[7;1H\x1b[2K  ⏵⏵ don't ask on (shift+tab to cycle)\x1b[5;3H");
const menu = () => out("\x1b[8;1H ❯ 1. Bad\x1b[9;1H   2. Fine\x1b[10;1H   0. Dismiss\x1b[5;3H");
const oneLine = (s) => s.replace(/\\/g, "\\\\").replace(/\r/g, "").replace(/\n/g, "\\n");

let n = 0;
let working = false;
let cur = "";
function longPlan() {
  let text = "## Goal\nA long plan by " + pid + "\n";
  for (let k = 1; text.length < 17000; k++) text += `${k}. Step — read \`src/import/csv.rs\`, keep the encoding (é, ü, “quotes”).\n`;
  return text;
}
function reply(message) {
  n += 1;
  log(`claude ${pid} msg[${oneLine(message)}]`);
  fs.mkdirSync(path.join(root, "pastes"), { recursive: true });
  fs.writeFileSync(path.join(root, "pastes", `${pid}-${n}.txt`), message);
  entry({ type: "user", uuid: `u-${pid}-${n}`, promptSource: "typed", message: { role: "user", content: message } });
  if (has("slow")) {
    cur = `m-${pid}-${n}`;
    entry({ type: "assistant", uuid: `a-${pid}-${n}`, message: { id: cur, model: "fake", content: [{ type: "text", text: "Thinking" }], stop_reason: null } });
    working = true;
    busy();
    return;
  }
  let ans;
  if (message.includes("----- plan -----")) {
    ans = has("ready") ? "Looks complete.\n\n**Verdict: ready**" : "1. Tests are missing.\n\nVerdict: changes needed";
  } else if (message.includes("Answer my last message again")) {
    ans = `## Goal\nRetried plan by ${pid}`;
  } else if (has("long")) {
    ans = longPlan();
  } else {
    ans = `## Goal\nPlan ${n} by ${pid}`;
  }
  entry({
    type: "assistant", uuid: `b-${pid}-${n}`,
    message: { id: `t-${pid}-${n}`, model: "fake", content: [{ type: "text", text: "I will read the files first." }, { type: "tool_use", id: `toolu-${pid}-${n}`, name: "Read", input: { file_path: "/etc/hosts" } }], stop_reason: "tool_use" },
  });
  entry({ type: "user", uuid: `r-${pid}-${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu-${pid}-${n}`, content: "ok" }] } });
  entry({
    type: "assistant", uuid: `a-${pid}-${n}`,
    message: { id: `m-${pid}-${n}`, model: "fake", content: [{ type: "text", text: ans }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4 } },
  });
  if (has("noend")) {
    if (has("stuckfooter")) busy(); else idle();
    return;
  }
  entry({ type: "system", subtype: "turn_duration", uuid: `d-${pid}-${n}`, durationMs: 5 });
  busy();
  doneFooter();
}

// Input: an Esc while a turn runs interrupts it; `ESC[200~ … ESC[201~` then
// one CR is a message. Anything else is ignored.
let state = "plain";
let pending = "";
let buf = "";
function feed(c) {
  if (state === "plain") {
    if (c !== "\x1b") return;
    if (working) {
      entry({ type: "user", uuid: `i-${pid}-${n}`, interruptedMessageId: cur, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      log(`claude ${pid} interrupted`);
      working = false;
      doneFooter();
      return;
    }
    state = "open";
    pending = "";
  } else if (state === "open") {
    pending += c;
    if (pending.length === 5) state = pending === "[200~" ? "paste" : "plain";
  } else if (state === "paste") {
    if (c === "\x1b") { state = "close"; pending = ""; } else buf += c;
  } else if (state === "close") {
    pending += c;
    if (pending.length === 5) {
      if (pending === "[201~") state = "cr";
      else { buf += "\x1b" + pending; state = "paste"; }
    }
  } else if (state === "cr") {
    const message = buf;
    buf = "";
    state = "plain";
    reply(message);
  }
}

idle();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const c of chunk) feed(c); });
process.stdin.on("end", () => process.exit(0));
setInterval(() => { if (has("menu")) menu(); }, 1000);
