import { useEffect, useState } from "react";
import { useSettings } from "../store/settingsStore";

/**
 * Effective theme = either an OS-derived light/dark, or one of the named
 * themes the user explicitly picks. Named themes ignore the OS dark-mode
 * toggle. v1.64.0: neonTokyo/synthwave retired (themes 5→3) — the backend
 * folds old prefs to dark + an accent preset before the frontend sees them.
 */
export type EffectiveTheme = "light" | "dark" | "void";

type SystemTheme = "light" | "dark";

function readSystem(): SystemTheme {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function useColorScheme(): EffectiveTheme {
  const themePref = useSettings((s) => s.settings.appearance.theme);
  const accent = useSettings((s) => s.settings.appearance.accent);
  const [system, setSystem] = useState<SystemTheme>(readSystem);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // "system" resolves to OS light/dark only. Named themes pass through.
  const effective: EffectiveTheme =
    themePref === "system" ? system : (themePref as EffectiveTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effective);
  }, [effective]);

  // v1.64.0: accent preset rides on a separate attribute so it composes
  // with every theme. "violet" (the default) removes the attribute: every
  // theme's own accent is violet, so the default and the Violet choice paint
  // the same (GH #245 — void used to paint cyan under "Violet").
  useEffect(() => {
    if (accent && accent !== "violet") {
      document.documentElement.setAttribute("data-accent", accent);
    } else {
      document.documentElement.removeAttribute("data-accent");
    }
  }, [accent]);

  return effective;
}
