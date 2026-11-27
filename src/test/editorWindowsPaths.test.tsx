// Windows walk (2026-09-30): New skill opened `…\app\.claude/skills\walk-rule\SKILL.md`
// and Open in Code `…\app\.claude\skills\walk-rule\SKILL.md` — two tabs of one
// file, the older one stale and able to overwrite it on save. The editor store
// keys a tab by the file, not by how its path was spelled: on Windows either
// separator and any case are one file; on the Mac nothing changes.
import { afterEach, describe, expect, it } from "vitest";
import { setPlatformForTests } from "../lib/platform";
import { pathKey, samePath } from "../lib/paths";
import { useEditor } from "../store/editorStore";

const WS = "ws-winpath";
const MIXED = "C:\\Users\\me\\app\\.claude/skills\\walk-rule\\SKILL.md";
const NATIVE = "C:\\Users\\me\\app\\.claude\\skills\\walk-rule\\SKILL.md";

afterEach(() => {
  setPlatformForTests(null);
  useEditor.setState({ byWorkspace: {} });
});

describe("one tab per file, however its path is spelled", () => {
  it("on Windows, mixed separators and case open the same tab", () => {
    setPlatformForTests("windows");
    const store = useEditor.getState();
    store.open(WS, MIXED, "v1", null);
    store.setContent(WS, NATIVE, "edited");
    store.open(WS, NATIVE, "v1", null);
    store.open(WS, NATIVE.toLowerCase().replace(/\\/g, "/"), "v1", null);
    const ws = useEditor.getState().byWorkspace[WS];
    expect(ws.openFiles).toHaveLength(1);
    // The tab keeps its first spelling, with the edit made through another.
    expect(ws.openFiles[0].path).toBe(MIXED);
    expect(ws.openFiles[0].content).toBe("edited");
    expect(ws.activePath).toBe(MIXED);
    store.markSaved(WS, NATIVE);
    expect(useEditor.getState().byWorkspace[WS].openFiles[0].initialContent).toBe("edited");
    store.close(WS, NATIVE);
    expect(useEditor.getState().byWorkspace[WS].openFiles).toHaveLength(0);
    expect(useEditor.getState().byWorkspace[WS].activePath).toBeNull();
  });

  it("on the Mac, a backslash is a file-name character and case matters", () => {
    setPlatformForTests("mac");
    const store = useEditor.getState();
    store.open(WS, "/Users/me/a\\b.md", "x", null);
    store.open(WS, "/Users/me/a/b.md", "y", null);
    store.open(WS, "/Users/me/A/b.md", "z", null);
    expect(useEditor.getState().byWorkspace[WS].openFiles).toHaveLength(3);
    expect(samePath("/a/B", "/a/b", false)).toBe(false);
    expect(pathKey("C:\\A//b/C", true)).toBe("c:\\a\\b\\c");
  });
});
