// SP-6: a Challenger's inline markdown drawn as React nodes — code, bold, a
// web link that opens through the backend (never the page navigating), and
// nothing else: `<script>` is text, `javascript:` is not a link.
import { describe, expect, it } from "vitest";
import { InlineMd } from "../components/InlineMd";
import { renderUi, screen, waitFor } from "./render";

describe("<InlineMd>", () => {
  it("draws code, bold and an http(s) link; the link opens through the backend", async () => {
    const { container, user, tauri } = renderUi(
      <p>
        <InlineMd text="`settings.ts` **never** saves it, see [the PR](https://github.com/o/r/pull/7)." />
      </p>,
      { fixtures: { open_web_link: null } },
    );
    expect(container.querySelector("code.ux-md-code")!.textContent).toBe("settings.ts");
    expect(container.querySelector("strong")!.textContent).toBe("never");
    const link = screen.getByRole("link", { name: "the PR" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/7");
    await user.click(link);
    await waitFor(() => expect(tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(tauri.callsOf("open_web_link")[0].args).toEqual({ url: "https://github.com/o/r/pull/7" });
    expect(window.location.href).not.toContain("github.com");
  });

  it("keeps <script> as text and makes no link of javascript:", () => {
    const { container } = renderUi(
      <p>
        <InlineMd text="<script>alert(1)</script> [x](javascript:alert(1)) `a" />
      </p>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("<script>alert(1)</script> [x](javascript:alert(1)) `a");
  });

  it("inside a control, a link is its words", () => {
    const { container } = renderUi(
      <button type="button">
        <InlineMd text="see [docs](https://a.b) and `x`" links={false} />
      </button>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")).toBeTruthy();
    expect(container.textContent).toBe("see docs and x");
  });

  it("a link that the backend refuses says so", async () => {
    const { user } = renderUi(<InlineMd text="[x](https://a.b)" />, {
      withToasts: true,
      fixtures: {
        open_web_link: () => {
          throw new Error("open failed");
        },
      },
    });
    await user.click(screen.getByRole("link", { name: "x" }));
    expect(await screen.findByText("The link didn't open")).toBeTruthy();
    // TX6 (E10): one form — the address is the body, and the toast copies it.
    expect(screen.getByText("https://a.b")).toBeTruthy();
    expect(screen.queryByText(/open failed/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy the address" }));
    expect(await navigator.clipboard.readText()).toBe("https://a.b");
  });
});
