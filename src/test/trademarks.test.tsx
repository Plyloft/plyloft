// Trademark wording (owner, 2026-10-03): Settings › Account › Profile ›
// "This copy of Plyloft" carries one muted Trademarks line, the search finds
// it, and macOS's About panel carries the same sentence as its credits.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfilePage } from "../components/settings/ProfilePage";
import { SETTINGS_INDEX } from "../lib/settingsIndex";
import { renderUi, screen } from "./render";
import { tauri } from "./tauri";

const SENTENCE =
  "Claude and Claude Code are trademarks of Anthropic, PBC; ChatGPT and Codex are trademarks of OpenAI; GitHub is a trademark of GitHub, Inc.; Git is a trademark of Software Freedom Conservancy. Plyloft is not affiliated with or endorsed by them.";

describe("trademark attribution", () => {
  it("Profile shows the Trademarks line under This copy of Plyloft", () => {
    tauri().fixture("plugin:app|version", () => "1.158.0");
    renderUi(<ProfilePage scope="this-mac" />);
    expect(screen.getByText("Trademarks")).toBeTruthy();
    expect(screen.getByText(SENTENCE)).toBeTruthy();
  });

  it("Settings search finds it by 'trademarks'", () => {
    const entry = SETTINGS_INDEX.find((e) => e.page === "profile-licence" && e.label === "Trademarks");
    expect(entry?.hint).toBe(SENTENCE);
    expect(entry?.synonyms).toContain("trademarks");
  });

  it("the macOS About panel's credits say the same sentence", () => {
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(lib).toContain(`const TRADEMARKS_CREDITS: &str = "${SENTENCE}";`);
    expect(lib).toMatch(/credits: Some\(TRADEMARKS_CREDITS\.into\(\)\)/);
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(conf.bundle.copyright).toBe("© 2026 MB Adv");
  });
});
