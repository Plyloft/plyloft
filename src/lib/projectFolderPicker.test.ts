// 1.176.3: the folder step's help sentence and where the native panel opens.
//   node --experimental-strip-types src/lib/projectFolderPicker.test.ts
import assert from "node:assert/strict";
import { FOLDER_HELP, pickerStart } from "./projectFolderPicker.ts";

const projects = { path: "/Users/a/Projects", exists: true, notAFolder: false };
assert.equal(pickerStart(projects, "/Users/a"), "/Users/a/Projects", "the Projects folder, when it is a folder");
assert.equal(pickerStart({ ...projects, exists: false }, "/Users/a"), "/Users/a", "missing: home");
assert.equal(pickerStart({ ...projects, notAFolder: true }, "/Users/a"), "/Users/a", "a file: home");
assert.equal(
  pickerStart({ path: "%USERPROFILE%\\Projects", exists: true, notAFolder: false }, "C:\\Users\\a"),
  "C:\\Users\\a",
  "an unexpanded path is no path the panel can open",
);
assert.equal(pickerStart(null, "/Users/a"), "/Users/a");
assert.equal(pickerStart(null, null), null, "no home either: the system chooses");
assert.ok(FOLDER_HELP.includes("holds your project"));
console.log("projectFolderPicker: ok");
