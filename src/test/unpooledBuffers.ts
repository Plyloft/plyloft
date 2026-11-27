// Loaded first of vitest's `setupFiles` (vitest.config.ts), before setup.ts
// and before any test file imports xterm.
//
// @xterm/addon-unicode-graphemes builds its Unicode width table when the
// module is evaluated: `Buffer.from(base64)` when a `Buffer` exists (always
// under vitest, even in jsdom), `atob` otherwise (the app's webview). Its
// UnicodeTrie then reads the table's header through `new DataView(data.buffer)`,
// ignoring `byteOffset`. Node hands out a string under 4 KB (this one decodes
// to 3023 bytes) as a slice of a shared 8 KB pool, so the header was read from
// whatever else sat at the start of that pool and the inflate threw
// "Data error" — or did not, depending on how many bytes the modules evaluated
// before it had taken from the pool. Any change to a test file's import graph
// could flip it (C3's settingConflictStore did, for setupMountLoop).
//
// With no pool, every Buffer owns its ArrayBuffer at offset 0, as the
// webview's `atob` path always does. Nothing else depends on pooling.
Buffer.poolSize = 0;
