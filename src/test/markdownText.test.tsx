// Windows parity walk: the result's "Why?" showed the review raw ("##
// Verdict", list dashes) and Build with both's "The Challenger's answer"
// showed raw backticks. Both draw the reviewer's words with the full
// markdown renderer (lib/markdown: marked + DOMPurify, lazily loaded).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MarkdownText } from "../components/MarkdownText";
import { renderUi, screen, tauri, waitFor } from "./render";
import { renderAgentMarkdown, renderMarkdown } from "../lib/markdown";

const REVIEW = [
  "## Verdict",
  "APPROVE",
  "",
  "## Findings",
  "- A — `calcAbs(value)` returns **the absolute value**",
  "- B — see https://example.com/x",
  "",
  '<img src="x" onerror="alert(1)"><script>alert(2)</script>',
].join("\n");

describe("a reviewer's words in markdown", () => {
  it("draws headings, lists and code, never the raw markers", async () => {
    const { container } = renderUi(<MarkdownText text={REVIEW} />);
    const md = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-ply-markdown]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(md.className).toBe("ux-card-report");
    expect(md.querySelector("h2")?.textContent).toBe("Verdict");
    expect(md.querySelectorAll("li")).toHaveLength(2);
    expect(md.querySelector("code")?.textContent).toBe("calcAbs(value)");
    expect(md.querySelector("strong")?.textContent).toBe("the absolute value");
    expect(md.textContent).not.toMatch(/##|`|\*\*/);
  });

  it("injects no HTML: scripts and handlers are stripped", async () => {
    const { container } = renderUi(<MarkdownText text={REVIEW} />);
    await waitFor(() => expect(container.querySelector("[data-ply-markdown]")).not.toBeNull());
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("opens a link in the browser, never in the page", async () => {
    const { user } = renderUi(<MarkdownText text={"see [the docs](https://example.com/docs)"} />);
    tauri().fixture("open_web_link", () => null);
    const link = await screen.findByRole("link", { name: "the docs" });
    await user.click(link);
    expect(tauri().callsOf("open_web_link").map((c) => c.args.url)).toEqual(["https://example.com/docs"]);
  });

  // Challenger: an agent's text is untrusted — nothing that fetches,
  // overlays or asks for input.
  it("drops remote and data: images (their alt text stays), style overlays and forms", async () => {
    const hostile = [
      "![tracking pixel](https://evil.example/p.png)",
      "",
      "![inline](data:image/png;base64,iVBORw0KGgo=)",
      "",
      '<div style="position:fixed;inset:0;background:white">Click to approve</div>',
      "",
      '<form action="https://evil.example"><input name="token"><button>Send</button><textarea></textarea><select><option>x</option></select></form>',
      "",
      '<video src="https://evil.example/v.mp4"></video><iframe src="https://evil.example"></iframe>',
    ].join("\n");
    const { container } = renderUi(<MarkdownText text={hostile} />);
    const md = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-ply-markdown]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(md.querySelector("img")).toBeNull();
    expect(md.textContent).toContain("tracking pixel");
    expect(md.textContent).toContain("inline");
    expect(md.innerHTML).not.toMatch(/evil\.example|data:image/);
    expect(md.querySelector("[style]")).toBeNull();
    expect(md.textContent).toContain("Click to approve");
    for (const tag of ["form", "input", "button", "textarea", "select", "video", "iframe"]) {
      expect(md.querySelector(tag)).toBeNull();
    }
  });

  it("keeps the default renderer for the person's own files", () => {
    expect(renderMarkdown("![logo](https://example.com/l.png)")).toContain("<img");
    expect(renderAgentMarkdown("![logo](https://example.com/l.png)")).not.toContain("<img");
  });

  it("is what the result's Why? and the Reviewer's answer draw", () => {
    const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(strip("src/components/OutcomeScreen.tsx")).toMatch(
      /<Details summary="Why\?">\s*<MarkdownText text=\{text\} \/>\s*<\/Details>/,
    );
    expect(strip("src/components/BuildBothStep.tsx")).toMatch(
      /<Details summary="The Reviewer's answer">\s*<MarkdownText text=\{bb\.compare\.excerpt\} \/>/,
    );
    // The lazy chunk: imported in an effect, never at the top.
    expect(strip("src/components/MarkdownText.tsx")).not.toMatch(/^import .*lib\/markdown/m);
  });
});
