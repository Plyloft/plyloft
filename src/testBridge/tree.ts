// SL-0 app tester (docs/app-tester/DESIGN.md): the controls tree the agent
// reads, built from the DOM the way an accessibility tree is — role,
// accessible name, states and a ref stable for the life of the element.
// Loaded only in test-bridge builds (`__PLY_TEST_BRIDGE__`).

export type Node = {
  el: Element;
  ref: string;
  role: string;
  name: string;
  states: string[];
  children: Node[];
  /** Extra lines under the control (a terminal's tail). */
  detail?: string;
};

type TreeOptions = {
  /** Skip elements without layout boxes. Off under jsdom, which lays out nothing. */
  layout: boolean;
  terminals: TerminalLookup;
  maxNodes: number;
};

export type TerminalLookup = {
  /** The terminal whose root element this is, if any. */
  at(el: Element): { lines: string[] } | null;
};

const NAME_MAX = 120;
// Text is read for what it says (a warning, an explanation): keep more of it.
const TEXT_MAX = 400;
const CONTROL_SELECTOR = "button, a[href], input, select, textarea, summary, [contenteditable='true']";
const VALUE_MAX = 80;

const refs = new WeakMap<Element, string>();
// A plain Map (the target lib has no WeakRef): entries whose element left the
// document are dropped on lookup and at every snapshot.
const byRef = new Map<string, Element>();
let nextRef = 0;

export function refFor(el: Element): string {
  let ref = refs.get(el);
  if (!ref) {
    nextRef += 1;
    ref = `e${nextRef}`;
    refs.set(el, ref);
    byRef.set(ref, el);
  }
  return ref;
}

export function elementForRef(ref: string): Element | null {
  const el = byRef.get(ref) ?? null;
  if (!el || !el.isConnected) {
    byRef.delete(ref);
    return null;
  }
  return el;
}

/** Test seam: refs restart between vitest cases. */
export function resetRefs(): void {
  nextRef = 0;
  byRef.clear();
}

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  search: "searchbox",
  number: "spinbutton",
  file: "button",
};

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
  const tag = el.tagName.toLowerCase();
  // UX P1 (P-A): a card surface that says which rule of `presentCard` its
  // words came from is a node of its own, so the walk can compare surfaces.
  if (el.hasAttribute("data-ply-rule") && !NATIVE_ROLE_TAGS.has(tag)) return "group";
  switch (tag) {
    case "button":
    case "summary":
      return "button";
    case "a":
      return el.hasAttribute("href") ? "link" : "";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return "";
      return INPUT_ROLES[type] ?? "textbox";
    }
    case "textarea":
      return "textbox";
    case "select":
      return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    case "option":
      return "option";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "img":
      return el.getAttribute("alt") === "" ? "" : "img";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "dialog":
      return "dialog";
    case "form":
      return "form";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "td":
      return "cell";
    case "th":
      return "columnheader";
    case "progress":
      return "progressbar";
    case "fieldset":
    case "details":
      return "group";
    case "section":
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "";
  }
  if (el.getAttribute("contenteditable") === "true") return "textbox";
  return "";
}

/** Tags whose own role the rule attribute never replaces. */
const NATIVE_ROLE_TAGS = new Set(["button", "summary", "a", "input", "textarea", "select", "section", "details", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th"]);

const NAME_FROM_CONTENT = new Set([
  "button",
  "link",
  "heading",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "cell",
  "columnheader",
  "rowheader",
  "switch",
  "checkbox",
  "radio",
  "treeitem",
  "tooltip",
  "status",
  "alert",
]);

export function clean(text: string, max = NAME_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function textOf(el: Element): string {
  // Skip what is hidden from assistive tech inside the element.
  let out = "";
  el.childNodes.forEach((child) => {
    if (child.nodeType === 3) out += child.textContent ?? "";
    else if (child.nodeType === 1) {
      const e = child as Element;
      if (e.getAttribute("aria-hidden") === "true") return;
      if (e.tagName === "STYLE" || e.tagName === "SCRIPT") return;
      if (e.tagName === "IMG") out += ` ${e.getAttribute("alt") ?? ""} `;
      else out += ` ${textOf(e)} `;
    }
  });
  return out;
}

export function nameOf(el: Element, role = roleOf(el)): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((e): e is HTMLElement => !!e)
      .map((e) => textOf(e))
      .join(" ");
    if (clean(text)) return clean(text);
  }
  const label = el.getAttribute("aria-label");
  if (label && clean(label)) return clean(label);
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const field = el as HTMLInputElement;
    const labels = field.labels ? Array.from(field.labels) : [];
    const fromLabels = clean(labels.map((l) => textOf(l)).join(" "));
    if (fromLabels) return fromLabels;
    const type = field.getAttribute("type");
    if ((type === "button" || type === "submit" || type === "reset") && field.value) {
      return clean(field.value);
    }
    const placeholder = field.getAttribute("placeholder");
    if (placeholder) return clean(placeholder);
  }
  if (tag === "img") return clean(el.getAttribute("alt") ?? "");
  // UX P1 (P-A): a `<Details>` disclosure is a group named "Details", so
  // what is behind it can be told apart from the default surface.
  if (tag === "details" && el.classList.contains("ux-details")) return "Details";
  if (NAME_FROM_CONTENT.has(role)) {
    const content = clean(textOf(el));
    if (content) return content;
  }
  return clean(el.getAttribute("title") ?? "");
}

function statesOf(el: Element, role: string): string[] {
  const states: string[] = [];
  const aria = (name: string) => el.getAttribute(`aria-${name}`);
  const field = el as HTMLInputElement;
  if (field.disabled || aria("disabled") === "true") states.push("disabled");
  if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox") {
    const checked = aria("checked") ?? (field.checked ? "true" : "false");
    states.push(checked === "true" ? "checked" : checked === "mixed" ? "mixed" : "unchecked");
  }
  if (aria("expanded") !== null) states.push(aria("expanded") === "true" ? "expanded" : "collapsed");
  if (aria("selected") === "true" || (el.tagName === "OPTION" && (el as HTMLOptionElement).selected)) {
    states.push("selected");
  }
  if (aria("pressed") === "true") states.push("pressed");
  if (aria("current") && aria("current") !== "false") states.push(`current=${aria("current")}`);
  if (aria("invalid") === "true") states.push("invalid");
  // UX P1 (P-A): the rule of `presentCard` a card surface's words came from.
  const rule = el.getAttribute("data-ply-rule");
  if (rule) states.push(`rule=${rule}`);
  if (field.readOnly || aria("readonly") === "true") states.push("readonly");
  if (el.ownerDocument.activeElement === el) states.push("focused");
  if (role === "heading") {
    const level = aria("level") ?? el.tagName.match(/^H(\d)$/)?.[1];
    if (level) states.push(`level=${level}`);
  }
  if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton") {
    const value =
      "value" in field && typeof field.value === "string"
        ? field.value
        : el.getAttribute("contenteditable") === "true"
          ? el.textContent ?? ""
          : "";
    if (value) states.push(`value="${clean(value, VALUE_MAX)}"`);
  }
  return states;
}

export function isHidden(el: Element, layout: boolean): boolean {
  if ((el as HTMLElement).hidden) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("inert")) return true;
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  if (layout && el.getClientRects().length === 0 && style?.display !== "contents") return true;
  return false;
}

function directText(el: Element): string {
  let out = "";
  el.childNodes.forEach((child) => {
    if (child.nodeType === 3) out += child.textContent ?? "";
  });
  return clean(out, TEXT_MAX);
}

/** Builds the tree under `root` (the root itself included when it is a control). */
export function buildTree(root: Element, options: TreeOptions): { nodes: Node[]; truncated: boolean } {
  for (const [ref, el] of byRef) if (!el.isConnected) byRef.delete(ref);
  let count = 0;
  let truncated = false;
  const walk = (el: Element): Node[] => {
    if (count >= options.maxNodes) {
      truncated = true;
      return [];
    }
    if (isHidden(el, options.layout)) return [];
    const terminal = options.terminals.at(el);
    if (terminal) {
      count += 1;
      const tail = terminal.lines.slice(-3).map((l) => `  ${l}`).join("\n");
      return [
        {
          el,
          ref: refFor(el),
          role: "terminal",
          name: terminalName(el),
          states: [`${terminal.lines.length} lines`],
          children: [],
          detail: tail,
        },
      ];
    }
    const role = roleOf(el);
    const name = role ? nameOf(el, role) : "";
    const children: Node[] = [];
    // A leaf control's content is its name; do not repeat it as text.
    const leaf = role !== "" && NAME_FROM_CONTENT.has(role) && role !== "status" && role !== "alert";
    if (!leaf || el.querySelector(`${CONTROL_SELECTOR}, [role]`)) {
      if (!role) {
        // A paragraph with inline parts (code, strong, a span) and no
        // control inside reads as one line, whole.
        const plain = !el.querySelector(`${CONTROL_SELECTOR}, [role], .xterm`) && !options.terminals.at(el);
        const text = plain ? clean(textOf(el), TEXT_MAX) : directText(el);
        if (text) {
          count += 1;
          children.push({ el, ref: refFor(el), role: "text", name: text, states: [], children: [] });
        }
        if (plain) return children;
      } else if (!NAME_FROM_CONTENT.has(role)) {
        // 1.173.0 walk: a control-less role (a list item, a region) with
        // its words straight inside it reads them too, as assistive tech
        // does; before, `<li>A line</li>` was an empty listitem.
        const text = directText(el);
        if (text) {
          count += 1;
          children.push({ el, ref: refFor(el), role: "text", name: text, states: [], children: [] });
        }
      }
      for (const child of Array.from(el.children)) children.push(...walk(child));
    }
    if (!role) return children; // generic wrapper: lift its children
    count += 1;
    return [{ el, ref: refFor(el), role, name, states: statesOf(el, role), children }];
  };
  const nodes = walk(root);
  return { nodes, truncated };
}

function terminalName(el: Element): string {
  const label = el.closest(".tile")?.querySelector(".tile-label")?.textContent;
  return clean(label ?? "") || "terminal";
}

export function renderTree(nodes: Node[], depth = 0, maxDepth = Infinity): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const pad = "  ".repeat(depth);
    if (node.role === "text") {
      lines.push(`${pad}- text: ${node.name}`);
    } else {
      const name = node.name ? ` "${node.name}"` : "";
      const states = node.states.length ? ` (${node.states.join(", ")})` : "";
      lines.push(`${pad}- ${node.role}${name} [ref=${node.ref}]${states}`);
    }
    if (node.detail) lines.push(node.detail.replace(/^/gm, pad));
    if (depth + 1 < maxDepth && node.children.length) {
      lines.push(renderTree(node.children, depth + 1, maxDepth));
    }
  }
  return lines.filter(Boolean).join("\n");
}

export function flatten(nodes: Node[]): Node[] {
  const out: Node[] = [];
  const visit = (list: Node[]) => {
    for (const node of list) {
      out.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

export type Query = { ref?: string; name?: string; role?: string; index?: number };

/**
 * Finds one control. By ref; else by name — exact, then case-insensitive,
 * then substring — optionally narrowed by role. More than one match without
 * an `index` is an error listing the candidates: never a guess.
 */
export function resolve(nodes: Node[], query: Query): Node {
  const all = flatten(nodes).filter((n) => n.role !== "text");
  if (query.ref) {
    const hit = all.find((n) => n.ref === query.ref);
    if (hit) return hit;
    const el = elementForRef(query.ref);
    if (!el) throw new Error(`ref ${query.ref} is gone (take a new snapshot)`);
    throw new Error(`ref ${query.ref} is not visible now`);
  }
  if (!query.name) throw new Error("give a ref or a name");
  const wanted = query.name;
  const pool = query.role ? all.filter((n) => n.role === query.role) : all;
  const tiers = [
    pool.filter((n) => n.name === wanted),
    pool.filter((n) => n.name.toLowerCase() === wanted.toLowerCase()),
    pool.filter((n) => n.name.toLowerCase().includes(wanted.toLowerCase())),
  ];
  const matches = tiers.find((tier) => tier.length > 0) ?? [];
  if (matches.length === 0) {
    const role = query.role ? ` ${query.role}` : "";
    throw new Error(`no visible${role} control named "${wanted}"`);
  }
  if (query.index !== undefined) {
    const hit = matches[query.index];
    if (!hit) throw new Error(`only ${matches.length} matches for "${wanted}"`);
    return hit;
  }
  if (matches.length > 1) {
    const list = matches
      .slice(0, 10)
      .map((n) => `${n.role} "${n.name}" [ref=${n.ref}]`)
      .join("; ");
    throw new Error(`${matches.length} controls match "${wanted}": ${list} — pass a ref, a role or an index`);
  }
  return matches[0];
}
