// UX-8.5: the backend's three refusals become a page's reason; anything else
// is not a refusal (it stays a toast).
import assert from "node:assert/strict";

import { MAX_OPEN_BYTES, fileRefusal } from "./fileRefusal.ts";

assert.equal(MAX_OPEN_BYTES, 5 * 1024 * 1024);
// The exact strings `files::read_text_file` returns.
assert.equal(fileRefusal("binary file")?.kind, "binary");
assert.equal(fileRefusal("file too large (6000000 bytes, max 5242880)")?.kind, "too-large");
assert.equal(fileRefusal("not valid utf-8")?.kind, "not-utf8");
assert.match(fileRefusal("binary file")!.reason, /binary file/);
assert.match(fileRefusal("file too large (1 bytes, max 2)")!.reason, /5 MB/);
assert.match(fileRefusal("not valid utf-8")!.reason, /UTF-8/);
// Not refusals.
assert.equal(fileRefusal("stat: No such file or directory (os error 2)"), null);
assert.equal(fileRefusal("read: Permission denied (os error 13)"), null);
assert.equal(fileRefusal("not a regular file"), null);
assert.equal(fileRefusal(undefined), null);

console.log("fileRefusal: all assertions passed");
