// Try it TI-3 (docs/try-it/TRY_IT_SPEC.md §4.2): finding the address a Try
// session's dev server prints. Pure: no store, no IPC, no DOM.
//
// The PTY hands output over in chunks split anywhere — in the middle of an
// ANSI sequence, of a URL, of a `\r\n` — so the scanner keeps what it needs
// across chunks: the escape-parser state and the current, unfinished line.

/** What the scanner has seen so far. */
export interface TryAddressResult {
  /** The best local address printed so far (`http://localhost:5173/`), or
   *  null. It can still change: an unlabelled one is replaced by a later
   *  labelled one (`Local:`), and any by one inside the card's port block. */
  address: string | null;
  /** `address` is https: a dev server's certificate is usually self-signed,
   *  which the embedded preview cannot accept, so the UI sends it to
   *  **Open in browser** instead. */
  secure: boolean;
  /** `address` came from a labelled line or the card's block — no later
   *  line is expected to beat it but a better-labelled or in-block one. */
  confident: boolean;
  /** Windows PowerShell refused a script ("running scripts is disabled on
   *  this system", or the language-free `.ps1` + `PSSecurityException` /
   *  `UnauthorizedAccess` / `about_Execution_Policies`): the command needs
   *  its `.cmd` form (spec §7). */
  scriptsBlocked: boolean;
}

export interface TryAddressOptions {
  /** The card's port block (`cardPortList`): an address on one of these
   *  ports beats any other. */
  portBlock?: readonly number[];
}

type EscState = "text" | "esc" | "csi" | "osc" | "oscEsc" | "str" | "strEsc";

/** A line longer than this without a newline is cut from the front: no dev
 *  server prints its address in a line this long, and the buffer stays small. */
const MAX_LINE = 4096;

/** `0.0.0.0` means "every interface"; the browser opens it as `localhost`.
 *  `127.x.y.z` is checked whole by `isLoopbackAddress` after the match. */
const ADDRESS_RE =
  /\b(https?):\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]):(\d{1,5})(\/[^\s"'<>`)\]]*)?/i;

/** The words a dev server puts before the address it serves on. `Local` and
 *  `Loopback` (Vite, Next, Astro, CRA) rank above the generic verbs, which
 *  an API or a helper process prints as well. */
const STRONG_LABEL_RE = /\b(local|loopback)\b/i;
const LABEL_RE = /\b(ready on|running on|listening on|available at)\b/i;
/** A proxy line names where requests are forwarded, not the app — when
 *  these come before the address (`/api → http://…`); after it
 *  (`http://localhost:3000 → open it`) the address is still the app's. */
const PROXY_RE = /proxy|proxying|→/i;

/** PowerShell's sentence, matched across a wrap: ConPTY wraps at the console
 *  width, at a space or in the middle of a word. */
const SCRIPTS_BLOCKED_RE = /running\s*scripts\s*is\s*disabled\s*on\s*this\s*system/i;
/** The same error in any language: the script's name, and one of the
 *  invariant tokens PowerShell prints within the next few lines. */
const PS1_RE = /\.ps1\b/i;
const PS_POLICY_TOKEN_RE = /about_Execution_Policies|PSSecurityException|UnauthorizedAccess/i;
/** How many lines after the latest `.ps1` line a token still counts. */
const PS1_WINDOW = 8;

/** The address as the browser will read it (`new URL(…).href`) when it is
 *  http(s) on this machine's loopback — `localhost`, `127.0.0.0/8` or
 *  `[::1]` — else null. Load exactly this string: what was checked is what
 *  is loaded, whatever backslashes or `@` the input held. */
export function loopbackUrl(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const m = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const ok =
    host === "localhost" || host === "[::1]" || Boolean(m && m.slice(1).every((o) => Number(o) <= 255));
  return ok ? url.href : null;
}

/** True for an http(s) address on this machine's loopback (`loopbackUrl`).
 *  The preview loads nothing else. */
export function isLoopbackAddress(address: string): boolean {
  return loopbackUrl(address) !== null;
}

/** With `marks` (Try it's echo watch): a cursor move to a line comes out
 *  as this instead of a newline, so a repaint is told from a real newline. */
export const CURSOR_LINE_MARK = "\u0002";
/** With `marks`: an OSC 133 `D` (the shell's "command finished", Command
 *  blocks' shell integration) comes out as this. */
export const COMMAND_DONE_MARK = "\u0001";

/** Strips ANSI/OSC from chunks fed in order, keeping parser state between
 *  them. Exported for tests. */
export class AnsiStripper {
  private state: EscState = "text";
  private readonly marks: boolean;
  private osc = "";

  constructor(options: { marks?: boolean } = {}) {
    this.marks = options.marks ?? false;
  }

  private oscEnded(): string {
    const done = this.marks && /^133;D(?:;|$)/.test(this.osc);
    this.osc = "";
    return done ? COMMAND_DONE_MARK : "";
  }

  feed(chunk: string): string {
    let out = "";
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      const code = ch.charCodeAt(0);
      switch (this.state) {
        case "text":
          if (code === 0x1b) this.state = "esc";
          else if (code === 0x9b) this.state = "csi";
          else if (code === 0x9d) {
            this.state = "osc";
            this.osc = "";
          }
          else out += ch;
          break;
        case "esc":
          if (ch === "[") this.state = "csi";
          else if (ch === "]") {
            this.state = "osc";
            this.osc = "";
          }
          // DCS, SOS, PM, APC: strings ended by ST, like OSC.
          else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") this.state = "str";
          // Charset selects and the like take one more byte (ESC ( B).
          else if (code >= 0x20 && code <= 0x2f) this.state = "esc";
          else this.state = "text";
          break;
        case "csi":
          // Parameters and intermediates until a final byte 0x40–0x7e.
          if (code >= 0x40 && code <= 0x7e) {
            this.state = "text";
            // A repaint (ConPTY) moves the cursor instead of printing
            // newlines and spaces: a move to a line (CUP, HVP, CNL, VPA) is a
            // line break, a move right (CUF) a space.
            if (ch === "H" || ch === "f" || ch === "E" || ch === "d") out += this.marks ? CURSOR_LINE_MARK : "\n";
            else if (ch === "C") out += " ";
          }
          break;
        case "osc":
          if (code === 0x07) {
            this.state = "text";
            out += this.oscEnded();
          } else if (code === 0x1b) this.state = "oscEsc";
          else if (this.osc.length < 64) this.osc += ch;
          break;
        case "oscEsc":
          if (ch === "\\") {
            this.state = "text";
            out += this.oscEnded();
          } else this.state = "osc";
          break;
        case "str":
          if (code === 0x1b) this.state = "strEsc";
          break;
        case "strEsc":
          this.state = ch === "\\" ? "text" : "str";
          break;
      }
    }
    return out;
  }
}

interface Candidate {
  address: string;
  /** Higher wins; equal keeps the first printed. */
  rank: number;
}

/** The candidate a line offers, or null: the first loopback address on a
 *  line that is not a proxy line, ranked by the card's block and the label. */
function candidateOf(line: string, portBlock: readonly number[]): Candidate | null {
  const m = line.match(ADDRESS_RE);
  if (!m || m.index === undefined) return null;
  if (PROXY_RE.test(line.slice(0, m.index))) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase() === "0.0.0.0" ? "localhost" : m[2].toLowerCase();
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // A sentence's full stop or comma after the address is not part of it.
  const path = (m[4] ?? "").replace(/[.,;:!?]+$/, "");
  const address = `${scheme}://${host}:${port}${path}`;
  if (!isLoopbackAddress(address)) return null;
  // Only the words before the address label it.
  const before = line.slice(0, m.index);
  const label = STRONG_LABEL_RE.test(before) ? 2 : LABEL_RE.test(before) ? 1 : 0;
  const inBlock = portBlock.includes(port) ? 4 : 0;
  return { address, rank: inBlock + label };
}

function better(a: Candidate | null, b: Candidate | null): Candidate | null {
  if (!a) return b;
  if (!b) return a;
  return b.rank > a.rank ? b : a;
}

/**
 * Feed it a Try session's output, chunk by chunk; it answers with the best
 * local address printed so far and whether PowerShell blocked a script.
 *
 * Ranking (spec §4.2): an address on the card's port block beats any other;
 * then a line labelled `Local`/`Loopback`, then `ready on`/`running on`/
 * `listening on`/`available at`, then an unlabelled one, which is only
 * tentative. Equal ranks keep the first printed. A proxy line never counts.
 *
 * Lines are judged when they end (a newline, a carriage return, or a cursor
 * move to another line). An unfinished line offers its address, provisionally,
 * once something that cannot be part of the URL follows it — so
 * `http://localhost:51` + `73/` is never taken for port 51.
 */
export class TryAddressScanner {
  private readonly stripper = new AnsiStripper();
  private readonly portBlock: readonly number[];
  private line = "";
  /** The last line judged, for a sentence wrapped across two. */
  private previous = "";
  private lineNo = 0;
  private ps1LineNo: number | null = null;
  private best: Candidate | null = null;
  /** The unfinished line's candidate, dropped when that line ends. */
  private pending: Candidate | null = null;
  private scriptsBlocked = false;

  constructor(options: TryAddressOptions = {}) {
    this.portBlock = options.portBlock ?? [];
  }

  feed(chunk: string): TryAddressResult {
    const text = this.stripper.feed(chunk);
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") {
        this.judge(this.line);
        this.line = "";
      } else {
        this.line += ch;
        if (this.line.length > MAX_LINE) this.line = this.line.slice(-MAX_LINE);
      }
    }
    this.pending = null;
    if (this.line) {
      const m = this.line.match(ADDRESS_RE);
      if (m && m.index !== undefined && m.index + m[0].length < this.line.length) {
        this.pending = candidateOf(this.line, this.portBlock);
      }
    }
    return this.current();
  }

  /** The output ended (the session exited): judge the unfinished line too. */
  flush(): TryAddressResult {
    this.judge(this.line);
    this.line = "";
    this.pending = null;
    return this.current();
  }

  current(): TryAddressResult {
    const c = better(this.best, this.pending);
    return {
      address: c?.address ?? null,
      secure: c ? c.address.startsWith("https:") : false,
      confident: c ? c.rank > 0 : false,
      scriptsBlocked: this.scriptsBlocked,
    };
  }

  private judge(line: string): void {
    if (!line.trim()) return;
    this.lineNo++;
    if (!this.scriptsBlocked) this.judgePolicy(line);
    this.previous = line;
    this.best = better(this.best, candidateOf(line, this.portBlock));
  }

  private judgePolicy(line: string): void {
    const prev = this.previous;
    if (
      SCRIPTS_BLOCKED_RE.test(line) ||
      SCRIPTS_BLOCKED_RE.test(`${prev} ${line}`) ||
      // Wrapped in the middle of a word: the two halves joined, no space.
      SCRIPTS_BLOCKED_RE.test(`${prev}${line}`.replace(/\s+/g, ""))
    ) {
      this.scriptsBlocked = true;
      return;
    }
    if (PS1_RE.test(line) || PS1_RE.test(`${prev}${line}`)) this.ps1LineNo = this.lineNo;
    if (
      this.ps1LineNo !== null &&
      this.lineNo - this.ps1LineNo <= PS1_WINDOW &&
      (PS_POLICY_TOKEN_RE.test(line) || PS_POLICY_TOKEN_RE.test(`${prev}${line}`.replace(/\s+/g, "")))
    ) {
      this.scriptsBlocked = true;
    }
  }
}

/** The whole output at once, for a transcript already in hand. */
export function scanTryOutput(text: string, options: TryAddressOptions = {}): TryAddressResult {
  const s = new TryAddressScanner(options);
  s.feed(text);
  return s.flush();
}

/** The port of a local address (`http://localhost:5173/x` → 5173), or null. */
export function portOfAddress(address: string): number | null {
  const m = address.match(/^https?:\/\/(?:\[[^\]]+\]|[^/:]+):(\d{1,5})(?:[/?#]|$)/i);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

/** The ports a card copy may serve on: its block `port_base…port_base+count-1`
 *  (spec §4.2 step 2). Ports below 1024 (never probed, like `probe_ports`)
 *  and past 65535 are left out. */
export function cardPortList(portBase: number, count = 10): number[] {
  const out: number[] = [];
  if (!Number.isInteger(portBase) || portBase < 1) return out;
  for (let p = portBase; p < portBase + count && p <= 65535; p++) if (p >= 1024) out.push(p);
  return out;
}
