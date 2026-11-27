import { Component, type ErrorInfo, type ReactNode } from "react";
import { error as logError } from "@tauri-apps/plugin-log";
import { ErrorBlock } from "./ux";
import { centreRenderError, type RenderErrorReach } from "../lib/uxError";

/**
 * 2026-09-30 walk: a centre view that fails to draw must never leave the
 * window blank and the log silent. Each centre host (Board, the card page,
 * Inbox, Activity, Code, Library, Terminals) sits in one of these, so a
 * render error shows an ErrorBlock where the view was, writes the error to
 * the app log, and leaves every other host — and its terminals — mounted.
 *
 * `resetKey`: when it changes (another card, another mode) the view draws
 * again; "Try again" does the same by hand.
 *
 * Challenger minor: `reach` says what went with the view — the Terminals
 * host and a tile close their terminals, Code its editor — so the block
 * never claims a session survived that did not. TileGrid puts one around
 * each tile, so one bad tile takes only itself down.
 */
type Props = {
  /** How the person names the view: "The card", "The Board". */
  view: string;
  reach?: RenderErrorReach;
  resetKey?: string | null;
  /** A way out other than "Try again" (a tile's "Close tile"). */
  onAction?: (id: string) => void;
  density?: "page" | "dense";
  children: ReactNode;
};
type State = { error: Error | null; key: string | null | undefined };

export class CentreErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const e = error instanceof Error ? error : new Error(String(error));
    const where = (info.componentStack ?? "").trim().split("\n").slice(0, 8).join(" | ");
    logError(`centre render error (${this.props.view}): ${e.message}${e.stack ? `\n${e.stack}` : ""}${where ? `\ncomponents: ${where}` : ""}`).catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={this.props.reach === "tile" ? "center-error center-error--tile" : "center-error"}>
        <ErrorBlock
          error={centreRenderError(this.props.view, error.message, error.stack ?? null, this.props.reach)}
          density={this.props.density}
          onAction={(id) => {
            if (id === "retry") this.setState({ error: null });
            else this.props.onAction?.(id);
          }}
        />
      </div>
    );
  }
}
