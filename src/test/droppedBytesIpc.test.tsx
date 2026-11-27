// D3 (1.172.2): a dropped file's bytes cross to Plyloft's core as the raw
// request body — never `Array.from(bytes)`, a JSON number array ~4× the file —
// and its other arguments as ASCII headers, the name percent-encoded.
import { describe, expect, it } from "vitest";
import { droppedNameHeader, fsOpenDropped, fsSaveDroppedFile, kanbanAttachmentAddFromBytes } from "../ipc";
import { tauri } from "./render";

const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

describe("dropped bytes go as a raw body", () => {
  it("fsSaveDroppedFile sends the bytes and the encoded name and length", async () => {
    tauri().fixture("fs_save_dropped_file", "/cache/dropped/x.png");
    await fsSaveDroppedFile("My shot é.png", bytes);
    const [call] = tauri().callsOf("fs_save_dropped_file");
    expect(call.args).toBeInstanceOf(Uint8Array);
    expect(call.args as unknown as Uint8Array).toEqual(bytes);
    expect(call.headers).toEqual({ "x-ply-file-name": "My%20shot%20%C3%A9.png", "x-ply-expected-len": "8" });
  });

  it("fsOpenDropped sends the workspace, and the modification time only when known", async () => {
    tauri().fixture("fs_open_dropped", { path: "/p/a.txt", inside: true });
    await fsOpenDropped("ws-1", "a.txt", bytes, 1761665700123);
    await fsOpenDropped("ws-1", "a.txt", bytes, null);
    const [withTime, without] = tauri().callsOf("fs_open_dropped");
    expect(withTime.args).toBeInstanceOf(Uint8Array);
    expect(withTime.headers).toEqual({
      "x-ply-workspace-id": "ws-1",
      "x-ply-file-name": "a.txt",
      "x-ply-expected-len": "8",
      "x-ply-modified-ms": "1761665700123",
    });
    expect(without.headers).not.toHaveProperty("x-ply-modified-ms");
  });

  it("kanbanAttachmentAddFromBytes sends the card in headers", async () => {
    tauri().fixture("kanban_attachment_add_from_bytes", { id: "a1" });
    await kanbanAttachmentAddFromBytes("ws-1", "card-1", "notes 📝.md", bytes);
    const [call] = tauri().callsOf("kanban_attachment_add_from_bytes");
    expect(call.args as unknown as Uint8Array).toEqual(bytes);
    expect(call.headers).toEqual({
      "x-ply-workspace-id": "ws-1",
      "x-ply-card-id": "card-1",
      "x-ply-file-name": "notes%20%F0%9F%93%9D.md",
    });
  });

  it("a name header is plain ASCII, and a lone surrogate never refuses the drop", () => {
    expect(droppedNameHeader("Screenshot 2026-10-28 à 15.35 📸.png")).toBe(
      "Screenshot%202026-10-28%20%C3%A0%2015.35%20%F0%9F%93%B8.png",
    );
    expect(droppedNameHeader("half \uD83D.png")).toBe("half%20%EF%BF%BD.png");
    expect(droppedNameHeader("\uDCA9tail")).toBe("%EF%BF%BDtail");
    expect(decodeURIComponent(droppedNameHeader("ok 📸"))).toBe("ok 📸");
  });
});
