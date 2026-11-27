// A fake `claude` that only asks Claude's folder-trust question and records
// every character typed at it (plan_exchange_tests: never answered).
"use strict";
const fs = require("fs");
const logFile = __LOG__;
fs.appendFileSync(logFile, `claude ${process.pid} start\n`);
process.stdout.write("Quick safety check: Is this a project you created or one you trust?\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to cancel\r\n");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => fs.appendFileSync(logFile + ".typed", chunk));
process.stdin.on("end", () => process.exit(0));
