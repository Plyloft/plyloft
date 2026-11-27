import { useEffect, useRef, useState } from "react";
import { CBtn } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/** A copy button that says it copied: its own label turns to "Copied" for a
 *  couple of seconds. 1.176.1: toasts now show above an open sheet, so a
 *  "copied" toast would say it twice; the label stays, and a polite live
 *  region announces it to a screen reader instead. A failure still toasts. */
export function CopyButton({
  text,
  label = "Copy",
  announce,
  size,
  tone,
}: {
  text: string | (() => Promise<string>);
  label?: string;
  announce: string;
  size?: "sm";
  tone?: "quiet";
}) {
  const [state, setState] = useState<"idle" | "copied">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const press = () => {
    const get = typeof text === "function" ? text() : Promise.resolve(text);
    void get
      .then((value) => navigator.clipboard.writeText(value))
      .then(
        () => {
          setState("copied");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState("idle"), 2500);
        },
        (e) =>
          pushErrorToast("Couldn't copy", e, { then: "Select the text and copy it yourself." }),
      );
  };
  return (
    <>
    <span className="ux-sr-only" aria-live="polite">
      {state === "copied" ? announce : ""}
    </span>
    <CBtn size={size} tone={tone} onClick={press}>
      {/* Both words are laid in one cell, so the button keeps the width of the longer. */}
      <span style={{ display: "inline-grid" }}>
        <span style={{ gridArea: "1 / 1", visibility: state === "copied" ? "hidden" : "visible" }} aria-hidden={state === "copied"}>
          {label}
        </span>
        <span style={{ gridArea: "1 / 1", visibility: state === "copied" ? "visible" : "hidden" }} aria-hidden={state !== "copied"}>
          Copied
        </span>
      </span>
    </CBtn>
    </>
  );
}
