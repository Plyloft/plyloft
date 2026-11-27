// GH #230: a file dropped into Ply is saved whole, or the drop says it could
// not be read completely — never a silently truncated file. The observed
// truncations were macOS screenshots read while still being written: the
// webview handed back a prefix cut at a 64 KiB multiple. Here a `File`'s read
// is made to do the same, through the real `saveDroppedFile` and, for the
// editor, the real `EditorPanel` drop host, with the Tauri layer stubbed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { useToasts } from "../store/toastStore";
import { useEditor } from "../store/editorStore";
import {
  DROP_REREAD_DELAY_MS,
  DropTooLargeError,
  IncompleteDropError,
  dropRefusalWords,
  dropRefusalsWords,
  droppedBytesIncomplete,
  toastDropRefusals,
  pngReachesEnd,
  readDroppedFile,
  saveDroppedFile,
} from "../lib/droppedFile";
import { fireEvent, nextFrame, renderUi, screen, tauri, waitFor } from "./render";

/** ~400 KiB: past several 64 KiB boundaries, small enough to stay fast. */
const SIZE = 400 * 1024 + 4321;
const noSleep = { sleep: () => Promise.resolve() };

function chunk(type: string, length: number): Uint8Array {
  const c = new Uint8Array(12 + length);
  c.set([length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255]);
  c.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  for (let i = 8; i < 8 + length; i++) c[i] = (i * 31) % 251 || 1;
  return c;
}

/** A well-formed PNG exactly `size` bytes long: signature, IHDR, IDAT chunks
 *  of up to 64 KiB of data, IEND — so a cut at a 64 KiB multiple lands mid-IDAT. */
function png(size: number): Uint8Array {
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", 13)];
  let left = size - 8 - 25 - 12;
  while (left > 0) {
    const data = Math.min(65_536, left - 12);
    parts.push(chunk("IDAT", data));
    left -= 12 + data;
  }
  parts.push(chunk("IEND", 0));
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (at !== size) throw new Error(`png fixture is ${at}, not ${size}`);
  return out;
}

/** Text of `size` bytes: no NUL, so the editor's pre-flight lets it through. */
function text(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 64 === 63 ? 10 : 97 + (i % 26);
  return bytes;
}

/** A dropped `File` whose successive whole reads return `reads` in turn (the
 *  last one repeating), and whose `size` is `reportedSize`. jsdom's `Blob` has
 *  no `arrayBuffer`, so the handle is built the way WebKit's behaves: a read
 *  returns what is on disk now; a slice reads the finished bytes. */
function fileReading(name: string, reportedSize: number, reads: Uint8Array[]): File {
  const last = reads[reads.length - 1];
  let n = 0;
  return {
    name,
    size: reportedSize,
    type: "",
    arrayBuffer: vi.fn(async () => reads[Math.min(n++, reads.length - 1)].slice().buffer),
    slice: (start?: number, end?: number) => ({
      arrayBuffer: async () => last.slice(start, end).buffer,
    }),
  } as unknown as File;
}

/** A dropped `File` that reads whole. */
const wholeFile = (name: string, bytes: Uint8Array) => fileReading(name, bytes.length, [bytes]);

/** D3: the raw bodies `fs_save_dropped_file` was sent. */
function savedBytes(): Uint8Array[] {
  return tauri()
    .callsOf("fs_save_dropped_file")
    .map((c) => c.args as unknown as Uint8Array);
}

describe("droppedBytesIncomplete", () => {
  it("passes a whole PNG and a whole non-PNG", () => {
    expect(droppedBytesIncomplete(SIZE, png(SIZE))).toBeNull();
    expect(droppedBytesIncomplete(1000, text(1000))).toBeNull();
  });

  it("names a read shorter than File.size", () => {
    expect(droppedBytesIncomplete(454_561, png(454_561).slice(0, 262_144))).toBe(
      "read 262144 of its 454561 bytes",
    );
  });

  it("names a PNG cut before IEND even when File.size agrees with the cut", () => {
    const cut = png(454_561).slice(0, 262_144);
    expect(droppedBytesIncomplete(262_144, cut)).toMatch(/PNG stops after 262144 bytes/);
  });

  it("names a read longer than File.size: the file changed while being read", () => {
    expect(droppedBytesIncomplete(262_144, png(SIZE))).toMatch(/changed while being read/);
  });
});

describe("pngReachesEnd walks the chunk chain", () => {
  it("accepts data after IEND", () => {
    const whole = png(SIZE);
    const trailing = new Uint8Array(whole.length + 300);
    trailing.set(whole);
    trailing.fill(0x41, whole.length);
    expect(pngReachesEnd(trailing)).toBe(true);
    expect(droppedBytesIncomplete(trailing.length, trailing)).toBeNull();
  });

  it("refuses a cut mid-IDAT, and a chunk whose declared length runs past the end", () => {
    const whole = png(SIZE);
    expect(pngReachesEnd(whole.slice(0, 131_072))).toBe(false);
    // Cut exactly at a chunk boundary, before IEND: every chunk fits, no IEND.
    expect(pngReachesEnd(whole.slice(0, whole.length - 12))).toBe(false);
    // "IEND" bytes inside IDAT data are not the end.
    const fake = whole.slice(0, 200_000);
    fake.set([0x49, 0x45, 0x4e, 0x44], fake.length - 8);
    expect(pngReachesEnd(fake)).toBe(false);
  });
});

describe("saveDroppedFile", () => {
  it("saves a ~400 KiB drop byte-identical and tells Rust the length", async () => {
    tauri().fixture("fs_save_dropped_file", () => "/cache/dropped/x-shot.png");
    const bytes = png(SIZE);
    const file = wholeFile("Screenshot 2026-10-28 à 15.35 📸.png", bytes);
    await expect(saveDroppedFile(file, noSleep)).resolves.toBe("/cache/dropped/x-shot.png");
    const [call] = tauri().callsOf("fs_save_dropped_file");
    // D3: the bytes are the raw body, never a JSON number array.
    expect(call.args).toBeInstanceOf(Uint8Array);
    expect(call.args as unknown as Uint8Array).toEqual(bytes);
    expect(call.headers).toEqual({
      "x-ply-file-name": "Screenshot%202026-10-28%20%C3%A0%2015.35%20%F0%9F%93%B8.png",
      "x-ply-expected-len": String(bytes.length),
    });
  });

  it("refuses a read that stops at 256 KiB of a larger file, and saves nothing", async () => {
    const whole = png(454_561);
    const file = fileReading("shot.png", whole.length, [whole.slice(0, 262_144)]);
    const err = await saveDroppedFile(file, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteDropError);
    expect(String(err)).toMatch(/shot\.png could not be read completely \(read 262144 of its 454561 bytes\)/);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(2);
    expect(savedBytes()).toEqual([]);
  });

  it("refuses a PNG still being written whose File.size is the cut length", async () => {
    const cut = png(454_561).slice(0, 262_144);
    const file = fileReading("shot.png", cut.length, [cut]);
    await expect(saveDroppedFile(file, noSleep)).rejects.toThrow(/PNG stops after 262144 bytes/);
    expect(savedBytes()).toEqual([]);
  });

  it("waits once and reads again; a whole second read is saved", async () => {
    tauri().fixture("fs_save_dropped_file", () => "/cache/dropped/y-shot.png");
    const whole = png(454_561);
    const file = fileReading("shot.png", whole.length, [whole.slice(0, 262_144), whole]);
    const waits: number[] = [];
    await saveDroppedFile(file, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([DROP_REREAD_DELAY_MS]);
    expect(savedBytes()[0]).toEqual(whole);
  });

  it("gives up after one ~500 ms wait", async () => {
    const whole = png(327_681);
    const file = fileReading("s.png", whole.length, [whole.slice(0, 327_680)]);
    const waits: number[] = [];
    await expect(
      readDroppedFile(file, { sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toBeInstanceOf(IncompleteDropError);
    expect(waits).toEqual([500]);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(2);
  });

  it("turns a read that rejects (WebKit's NotReadableError) into an incomplete drop", async () => {
    const file = fileReading("shot.png", SIZE, [png(SIZE)]);
    const notReadable = new DOMException("The file changed", "NotReadableError");
    (file.arrayBuffer as ReturnType<typeof vi.fn>).mockRejectedValue(notReadable);
    const err = await saveDroppedFile(file, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteDropError);
    expect(String(err)).toMatch(/shot\.png could not be read completely \(the read failed — NotReadableError: The file changed\)/);
    expect(savedBytes()).toEqual([]);
  });
});

// 1.176.1: three screenshots dragged into a tile were saved as 0-byte files,
// with no message. An empty read is refused, and nothing reaches the disk.
describe("a file that arrives empty (1.176.1)", () => {
  it("is refused, after the one re-read, and nothing is saved", async () => {
    tauri().fixture("fs_save_dropped_file", () => "/cache/dropped/x.png");
    for (const reported of [0, 123_456]) {
      const waits: number[] = [];
      const file = fileReading("Screenshot.png", reported, [new Uint8Array(0)]);
      const err = (await saveDroppedFile(file, { sleep: async (ms) => void waits.push(ms) }).catch((e: unknown) => e)) as IncompleteDropError;
      expect(err).toBeInstanceOf(IncompleteDropError);
      expect(err.kind).toBe("empty");
      expect(err.message).toMatch(/arrived empty: 0 bytes/);
      expect(waits).toHaveLength(1);
    }
    expect(tauri().callsOf("fs_save_dropped_file")).toHaveLength(0);
  });

  it("says so in plain words, in the product's drop-it-again style", () => {
    const err = new IncompleteDropError("Screenshot.png", "it arrived empty: 0 bytes", "empty");
    const one = dropRefusalWords(err, "Screenshot.png", "terminal");
    expect(one.title).toBe("Screenshot.png arrived empty");
    expect(one.body).toBe("Nothing was saved. Drop it again in a moment, or drag the saved file.");
    expect(one.details).toMatch(/0 bytes/);
    const three = dropRefusalsWords(
      ["a.png", "b.png", "c.png"].map((name) => ({ name, error: new IncompleteDropError(name, "it arrived empty: 0 bytes", "empty") })),
      "terminal",
    );
    expect(three?.body).toBe("a.png, b.png and c.png. They weren't saved yet. Drag the saved files again in a moment.");
  });

  it("droppedBytesIncomplete refuses an empty read only where it can't be a real empty file", () => {
    expect(droppedBytesIncomplete(0, new Uint8Array(0), "Screenshot.png", "")).toBe("it arrived empty: 0 bytes");
    expect(droppedBytesIncomplete(0, new Uint8Array(0), "clip", "video/quicktime")).toBe("it arrived empty: 0 bytes");
    expect(droppedBytesIncomplete(5, new Uint8Array(0), "notes.txt", "text/plain")).toBe("it arrived empty: 0 bytes");
    for (const name of ["__init__.py", ".gitkeep", ".env.example", "empty.txt"]) {
      expect(droppedBytesIncomplete(0, new Uint8Array(0), name, "")).toBeNull();
    }
  });

  it("a real empty file is saved as before (review 1)", async () => {
    tauri().fixture("fs_save_dropped_file", () => "/cache/dropped/__init__.py");
    const file = fileReading("__init__.py", 0, [new Uint8Array(0)]);
    await expect(saveDroppedFile(file, noSleep)).resolves.toBe("/cache/dropped/__init__.py");
    expect(tauri().callsOf("fs_save_dropped_file")).toHaveLength(1);
  });
});

describe("why a drop was refused (1.172.2 D1)", () => {
  it("a read that rejects NotFoundError is a file that hasn't arrived — one short re-read, no more", async () => {
    const file = fileReading("Screenshot 13.59.41.png", SIZE, [png(SIZE)]);
    const notFound = new DOMException("The object can not be found here.", "NotFoundError");
    (file.arrayBuffer as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    const waits: number[] = [];
    const err = await readDroppedFile(file, { sleep: async (ms) => void waits.push(ms) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteDropError);
    expect((err as IncompleteDropError).kind).toBe("arriving");
    expect((err as IncompleteDropError).reason).toMatch(/NotFoundError: The object can not be found here\./);
    expect(waits).toEqual([DROP_REREAD_DELAY_MS]);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["NotReadableError", "saving"],
    ["SecurityError", "unreadable"],
  ])("a read that rejects %s is %s", async (name, kind) => {
    const file = fileReading("a.png", SIZE, [png(SIZE)]);
    (file.arrayBuffer as ReturnType<typeof vi.fn>).mockRejectedValue(new DOMException("x", name));
    const err = (await readDroppedFile(file, noSleep).catch((e: unknown) => e)) as IncompleteDropError;
    expect(err.kind).toBe(kind);
  });

  it("a cut read is still being saved; a longer one changed while read", async () => {
    const whole = png(454_561);
    const cut = (await readDroppedFile(fileReading("s.png", whole.length, [whole.slice(0, 262_144)]), noSleep).catch(
      (e: unknown) => e,
    )) as IncompleteDropError;
    expect(cut.kind).toBe("saving");
    const longer = new Uint8Array(whole.length + 10);
    longer.set(whole);
    const grew = (await readDroppedFile(fileReading("s.png", whole.length, [longer]), noSleep).catch(
      (e: unknown) => e,
    )) as IncompleteDropError;
    expect(grew.kind).toBe("changed");
  });
});

describe("what a refused drop says (1.172.2 D2)", () => {
  const ENGINE = /Error\b|NotFoundError|NotReadableError|bytes/;
  const notFound = new IncompleteDropError(
    "Screenshot 13.59.41.png",
    "the read failed — NotFoundError: The object can not be found here.",
    "arriving",
  );

  it("names the reason by kind, never the engine's text", () => {
    const arriving = dropRefusalWords(notFound, "Screenshot 13.59.41.png", "terminal");
    expect(arriving.title).toBe("Screenshot 13.59.41.png hadn't arrived yet");
    expect(arriving.body).toBe(
      "It's still being saved, or still on its way from your other computer. Drag the saved file again in a moment.",
    );
    const saving = dropRefusalWords(new IncompleteDropError("a.png", "read 262144 of its 454561 bytes", "saving"), "a.png", "card");
    expect([saving.title, saving.body]).toEqual(["a.png was still being saved", "Drop it again in a moment."]);
    const changed = dropRefusalWords(new IncompleteDropError("a.png", "it changed while being read", "changed"), "a.png", "card");
    expect(changed.title).toBe("a.png was still being saved");
    const unreadable = new IncompleteDropError("a.png", "the read failed — SecurityError: no", "unreadable");
    expect(dropRefusalWords(unreadable, "a.png", "card")).toMatchObject({
      title: "a.png couldn't be read",
      body: "Nothing was added. Drop it again, or pick it with Attach.",
    });
    expect(dropRefusalWords(unreadable, "a.png", "terminal").body).toBe("Nothing was added to the terminal. Drop it again.");
    expect(dropRefusalWords(unreadable, "a.png", "chat").body).toBe("Nothing was added. Drop it again, or pick it with Add files.");
    expect(dropRefusalWords(new Error("ipc: disk full"), "a.png", "editor")).toMatchObject({
      title: "a.png didn't open",
      body: "Nothing was opened. Drop it again.",
    });
    expect(dropRefusalWords(new DropTooLargeError("big.mov", 12 * 1024 * 1024, 5 * 1024 * 1024), "big.mov", "card")).toMatchObject({
      title: "big.mov is too big",
      body: "It is 12 MB; a card takes files up to 5 MB.",
    });
    for (const w of [arriving, saving, changed]) {
      expect(w.title).not.toMatch(ENGINE);
      expect(w.body).not.toMatch(ENGINE);
    }
  });

  it("keeps the raw reason behind Details", () => {
    expect(dropRefusalWords(notFound, "Screenshot 13.59.41.png", "terminal").details).toBe(
      "Screenshot 13.59.41.png could not be read completely (the read failed — NotFoundError: The object can not be found here.)",
    );
  });

  it("says several refused files of one drop in one toast", () => {
    useToasts.setState({ toasts: [], queue: [] });
    const refused = ["a.png", "b.png"].map((name) => ({
      name,
      error: new IncompleteDropError(name, "the read failed — NotFoundError: gone", "arriving"),
    }));
    toastDropRefusals(refused, "terminal");
    const all = [...useToasts.getState().toasts, ...useToasts.getState().queue];
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("2 files weren't added");
    expect(all[0].body).toBe("a.png and b.png. They weren't saved yet. Drag the saved files again in a moment.");
    expect(all[0].body).not.toMatch(ENGINE);
    expect(all[0].details).toMatch(/^a\.png could not .*NotFoundError: gone\)\nb\.png could not .*NotFoundError: gone\)$/);
    expect(all[0].kind).toBe("warn");
  });

  it("never says \"Nothing was added\" when others of the drop went in", () => {
    const err = new Error("disk full");
    expect(dropRefusalWords(err, "b.png", "terminal", 1).body).toBe("The others were added. Drop it again.");
    expect(dropRefusalWords(err, "b.png", "card", 1).body).toBe("The others were added. Drop it again, or pick it with Attach.");
    expect(dropRefusalWords(err, "b.png", "editor", 2).body).toBe("The others opened. Drop it again.");
    expect(dropRefusalWords(err, "b.png", "terminal", 0).body).toBe("Nothing was added to the terminal. Drop it again.");
    expect(dropRefusalWords(notFound, "Screenshot 13.59.41.png", "terminal", 1).body).toMatch(
      /Drag the saved file again in a moment\. The others were added\.$/,
    );
    const two = dropRefusalsWords(
      [
        { name: "b.png", error: err },
        { name: "c.png", error: err },
      ],
      "card",
      3,
    );
    expect(two?.body).toBe("b.png and c.png. The others were added. Drop them again, or pick them with Attach.");
  });

  it("names a too-big file apart from the ones to drop again", () => {
    const big = new DropTooLargeError("a.mov", 9 * 1024 * 1024, 5 * 1024 * 1024);
    const words = dropRefusalsWords(
      [
        { name: "a.mov", error: big },
        { name: "b.png", error: new Error("disk full") },
      ],
      "card",
    );
    expect(words?.body).toBe("a.mov is over 5 MB. b.png: drop it again, or pick it with Attach.");
  });

  it("says a drop of files none of which were saved yet as one 'drag the saved files' line", () => {
    const words = dropRefusalsWords(
      ["a.png", "b.png"].map((name) => ({ name, error: new IncompleteDropError(name, "x", "arriving") })),
      "terminal",
    );
    expect(words?.body).toBe("a.png and b.png. They weren't saved yet. Drag the saved files again in a moment.");
  });

  it("names at most three files, and says nothing when nothing failed", () => {
    const err = new Error("x");
    const words = dropRefusalsWords(["a", "b", "c", "d", "e"].map((name) => ({ name, error: err })), "card");
    expect(words?.body).toBe("a, b, c and 2 more. Nothing was added. Drop them again, or pick them with Attach.");
    expect(toastDropRefusals([], "card")).toBeNull();
  });
});

describe("a file dropped on the editor", () => {
  const WS = "ws-drop";

  function drop(host: Element, file: File) {
    fireEvent.drop(host, {
      dataTransfer: { types: ["Files"], files: [file], getData: () => "" },
    });
  }

  async function render() {
    const r = renderUi(<EditorPanel workspaceId={WS} />, { withToasts: true });
    await nextFrame();
    const host = r.container.querySelector("[data-drop-accepts]");
    if (!host) throw new Error("no editor drop host");
    return host;
  }

  const openedBytes = () =>
    tauri()
      .callsOf("fs_open_dropped")
      .map((c) => c.args as unknown as Uint8Array);

  it("sends a ~400 KiB text drop byte-identical, to be found in the workspace", async () => {
    const bytes = text(SIZE);
    tauri().fixture("fs_open_dropped", () => ({ path: "/p/docs/notes.txt", inside: true }));
    tauri().fixture("fs_read_text_file", () => "opened");
    const host = await render();
    drop(host, wholeFile("notes.txt", bytes));
    await waitFor(() => expect(tauri().callsOf("fs_read_text_file")).toHaveLength(1));
    expect(openedBytes()[0]).toBeInstanceOf(Uint8Array);
    expect(openedBytes()[0]).toEqual(bytes);
    expect(tauri().callsOf("fs_open_dropped")[0].headers).toMatchObject({
      "x-ply-workspace-id": WS,
      "x-ply-file-name": "notes.txt",
      "x-ply-expected-len": String(bytes.length),
    });
    // No writable copy in the cache any more.
    expect(savedBytes()).toEqual([]);
  });

  // QoL 6.4 (E10): the workspace's own file opens as itself — ⌘S saves it.
  it("opens the workspace's own file when the drop is one of them", async () => {
    tauri().fixture("fs_open_dropped", () => ({ path: "/p/docs/notes.txt", inside: true }));
    tauri().fixture("fs_read_text_file", () => "# notes");
    const host = await render();
    drop(host, wholeFile("notes.txt", text(64)));
    await waitFor(() => expect(useEditor.getState().byWorkspace[WS]?.openFiles).toHaveLength(1));
    const tab = useEditor.getState().byWorkspace[WS].openFiles[0];
    expect(tab.path).toBe("/p/docs/notes.txt");
    expect(tab.readOnly ?? null).toBeNull();
    // Challenger D1: it says which file of the project it opened.
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Opened notes.txt from this project"),
    );
  });

  // Challenger D1: a slow search says it is looking, and the line goes when done.
  it("says it is looking for the file when the search takes a moment", async () => {
    let finish: (v: unknown) => void = () => {};
    tauri().fixture("fs_open_dropped", () => new Promise((res) => (finish = res)));
    tauri().fixture("fs_read_text_file", () => "# notes");
    const host = await render();
    drop(host, wholeFile("notes.txt", text(64)));
    await waitFor(
      () =>
        expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Looking for this file in the project…"),
      { timeout: 2000 },
    );
    finish({ path: "/cache/dropped/open-1/notes.txt", inside: false });
    await waitFor(() => expect(useEditor.getState().byWorkspace[WS]?.openFiles).toHaveLength(1));
    expect(useToasts.getState().toasts.map((t) => t.title)).not.toContain("Looking for this file in the project…");
  });

  // QoL 6.4 (E10): a file from outside opens read-only and says why; Copy
  // into the project makes it a file of the project, opened in its place.
  it("opens a file from outside read-only, and copies it into the project", async () => {
    const copy = "/cache/dropped/open-1/notes.txt";
    tauri().fixture("fs_open_dropped", () => ({ path: copy, inside: false }));
    tauri().fixture("fs_read_text_file", () => "# notes");
    tauri().fixture("fs_copy_into_workspace", () => "/p/notes.txt");
    const host = await render();
    drop(host, wholeFile("notes.txt", text(64)));
    await waitFor(() => expect(useEditor.getState().byWorkspace[WS]?.openFiles).toHaveLength(1));
    expect(useEditor.getState().byWorkspace[WS].openFiles[0].readOnly?.place).toBe("outside");
    expect(await screen.findByText(/a copy of a file from outside this project/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy into the project" }));
    await waitFor(() =>
      expect(useEditor.getState().byWorkspace[WS].openFiles.map((f) => f.path)).toEqual(["/p/notes.txt"]),
    );
    expect(tauri().callsOf("fs_copy_into_workspace")[0].args).toEqual({
      workspaceId: WS,
      source: copy,
      name: "notes.txt",
    });
    expect(useEditor.getState().byWorkspace[WS].openFiles[0].readOnly ?? null).toBeNull();
  });

  it("says a file it can't open and one it couldn't read in one toast (Reviewer round 1)", async () => {
    const binary = fileReading("shot.bin", 16, [Uint8Array.from([0x89, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])]);
    const whole = text(SIZE);
    const cut = fileReading("notes.txt", whole.length, [whole.slice(0, 5 * 65_536)]);
    const host = await render();
    vi.useFakeTimers();
    fireEvent.drop(host, { dataTransfer: { types: ["Files"], files: [binary, cut], getData: () => "" } });
    await vi.advanceTimersByTimeAsync(DROP_REREAD_DELAY_MS + 100);
    vi.useRealTimers();
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("2 files didn't open"));
    const all = [...useToasts.getState().toasts, ...useToasts.getState().queue];
    expect(all.filter((t) => t.kind !== "info")).toHaveLength(1);
    expect(all.map((t) => t.title)).not.toContain("Cannot open dropped file");
    expect(all[0].details).toMatch(/^shot\.bin: shot\.bin is not a text file\.\nnotes\.txt could not be read completely/);
  });

  it("says a short read was still being saved, in plain words, and sends nothing", async () => {
    const whole = text(SIZE);
    const file = fileReading("notes.txt", whole.length, [whole.slice(0, 5 * 65_536)]);
    tauri().fixture("fs_open_dropped", () => ({ path: "/p/notes.txt", inside: true }));
    tauri().fixture("fs_read_text_file", () => "opened");
    const host = await render();
    vi.useFakeTimers();
    drop(host, file);
    // The re-read's wait, and not the toast's own 6 s dismissal.
    await vi.advanceTimersByTimeAsync(DROP_REREAD_DELAY_MS + 100);
    vi.useRealTimers();
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("notes.txt was still being saved"));
    const toast = useToasts.getState().toasts.find((t) => t.title === "notes.txt was still being saved")!;
    expect(toast.body).toBe("Drop it again in a moment.");
    // 1.172.2 D2: the byte counts are behind Details, not in the line.
    expect(toast.details).toMatch(/notes\.txt could not be read completely \(read 327680 of its 413921 bytes\)/);
    expect(openedBytes()).toEqual([]);
    expect(tauri().callsOf("fs_read_text_file")).toEqual([]);
  });
});

// Every drop site that materializes a dropped `File` reads it through the
// whole-file reader: no raw `arrayBuffer()` of a dropped file is left beside it.
describe("the drop sites", () => {
  const source = (path: string) =>
    readFileSync(resolve(process.cwd(), "src/components", path), "utf8");

  it.each([
    ["Terminal.tsx", /saveDroppedFile\(f\)/],
    ["EditorPanel.tsx", /openDroppedFile\(droppedInto, file\)/],
    ["CardMore.tsx", /readDroppedFile\(f\)/],
  ])("%s reads the dropped file whole", (file, call) => {
    const src = source(file);
    expect(src).toMatch(call);
    expect(src).not.toMatch(/\b(f|file)\.arrayBuffer\(\)/);
    expect(src).not.toMatch(/\bfsSaveDroppedFile\(/);
  });

  it("the terminal tells the person when a drop could not be saved", () => {
    const src = source("Terminal.tsx");
    const body = src.slice(src.indexOf("async function handleHtmlDrop"), src.indexOf("function firstUriListEntry"));
    // 1.172.2 D2: one toast for the whole drop, in the shared plain words.
    expect(body).toMatch(/toastDropRefusals\(refused, "terminal", saved\.length\)/);
    expect(body).not.toMatch(/pushToast\(/);
  });
});
