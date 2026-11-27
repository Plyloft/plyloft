// SL-0 app tester: the terminals the page has. Terminals render through
// WebGL, so their text is not in the DOM; `Terminal.tsx` registers each xterm
// instance here (test-bridge builds only) and the agent reads its buffer.

export type RegisteredTerm = {
  element: HTMLElement | undefined;
  buffer: {
    active: {
      length: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  input(data: string, wasUserInput?: boolean): void;
  focus(): void;
};

declare global {
  interface Window {
    __plyTestTerminals?: Set<RegisteredTerm>;
  }
}

export function registry(): Set<RegisteredTerm> {
  if (!window.__plyTestTerminals) window.__plyTestTerminals = new Set();
  return window.__plyTestTerminals;
}

export function termAt(el: Element): RegisteredTerm | null {
  for (const term of registry()) if (term.element === el) return term;
  return null;
}

/** The buffer's lines, trailing blank lines dropped. */
export function linesOf(term: RegisteredTerm): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** The terminal inside (or at) `el`: a tile, a terminal ref, or its root. */
export function termWithin(el: Element): RegisteredTerm | null {
  for (const term of registry()) {
    if (term.element && (term.element === el || el.contains(term.element) || term.element.contains(el))) {
      return term;
    }
  }
  return null;
}
