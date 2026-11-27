// G10 (1.170.0): "pull request" and "round" are defined where they appear —
// a help mark beside the sentence, its hover the definition, its press the
// guide's glossary. The sentence stays one piece of text.
import { describe, expect, it } from "vitest";
import { GlossaryText } from "../components/GlossaryText";
import { GLOSSARY_URL } from "../lib/glossary";
import { renderUi, screen, waitFor } from "./render";

describe("a word defined where it appears", () => {
  it("keeps the sentence whole, defines the word on hover and opens the glossary", async () => {
    const { user, tauri } = renderUi(
      <p>
        <GlossaryText text="Shipped as pull request #9, open on GitHub." words={["pull request", "round"]} />
      </p>,
      { fixtures: { open_web_link: null } },
    );
    expect(screen.getByText("Shipped as pull request #9, open on GitHub.")).toBeTruthy();
    const mark = screen.getByRole("button", { name: "What a pull request is" });
    expect(mark.getAttribute("title")).toMatch(/^A pull request is GitHub's request to add a change.*glossary\.$/);
    expect(screen.queryByRole("button", { name: "What a round is" })).toBeNull();
    // Challenger 7: the definition is the mark's description, for a screen
    // reader and the keyboard, not only the mouse's hover.
    const def = document.getElementById(mark.getAttribute("aria-describedby") ?? "");
    expect(def?.textContent).toBe("A pull request is GitHub's request to add a change, where it can be read before it's merged.");
    expect(def?.getAttribute("aria-hidden")).toBe("true");
    await user.click(mark);
    await waitFor(() => expect(tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(tauri.callsOf("open_web_link")[0].args.url).toBe(GLOSSARY_URL);
  });

  it("says nothing more for a sentence without the word", () => {
    renderUi(<GlossaryText text="Nothing to define around here." words={["round"]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
