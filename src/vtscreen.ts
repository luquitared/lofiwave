/**
 * A small headless terminal: feeds on a PTY's output and keeps the screen as text, so a run whose terminal is not
 * in tmux (an E2B sandbox's PTY) still has `GET /screen` and a log record of what it showed. It is not a full xterm:
 * it tracks the cursor, erasing, scrolling (with a region), insert/delete, the alternate screen and wide-ish text,
 * and drops colors and everything else. That is what claude's and codex's TUIs use to lay out their text.
 */

export class VtScreen {
  private lines: string[][] = [];
  private alt: string[][] | null = null;   // the main screen, kept while the alternate one is shown
  private altCursor: [number, number] = [0, 0];
  private x = 0;
  private y = 0;
  private saved: [number, number] = [0, 0];
  private top = 0;
  private bottom: number;
  private wrapNext = false;
  /** Lines that scrolled off the top of the main screen, oldest first. */
  readonly scrollback: string[] = [];
  private state: "text" | "esc" | "csi" | "osc" | "oscEsc" | "charset" = "text";
  private params = "";
  private carry = "";      // an incomplete UTF-8 sequence from the previous chunk
  private dec = new TextDecoder("utf-8", { fatal: false });

  constructor(public cols = 120, public rows = 40, private maxScrollback = 5000) {
    this.bottom = rows - 1;
    this.clear();
  }

  private blank(): string[] { return new Array(this.cols).fill(" "); }
  private clear() { this.lines = Array.from({ length: this.rows }, () => this.blank()); }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    const fit = (l: string[]) => (l.length >= cols ? l.slice(0, cols) : [...l, ...new Array(cols - l.length).fill(" ")]);
    let lines = this.lines.map(fit);
    // Shrinking keeps the bottom of the screen (where the cursor and a TUI's input box are), like terminals do.
    while (lines.length > rows) { const gone = lines.shift()!; if (!this.alt) this.pushScrollback(gone); this.y = Math.max(0, this.y - 1); }
    while (lines.length < rows) lines.push(new Array(cols).fill(" "));
    this.lines = lines;
    if (this.alt) this.alt = this.alt.map(fit);
    this.cols = cols; this.rows = rows;
    this.top = 0; this.bottom = rows - 1;
    this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, rows - 1);
    this.wrapNext = false;
  }

  write(data: Uint8Array | string) {
    const s = typeof data === "string" ? data : this.dec.decode(data, { stream: true });
    for (const ch of s) this.feed(ch);
  }

  private pushScrollback(l: string[]) {
    this.scrollback.push(l.join("").replace(/\s+$/, ""));
    if (this.scrollback.length > this.maxScrollback) this.scrollback.splice(0, this.scrollback.length - this.maxScrollback);
  }

  private scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      const gone = this.lines.splice(this.top, 1)[0];
      if (this.top === 0 && !this.alt) this.pushScrollback(gone);
      this.lines.splice(this.bottom, 0, this.blank());
    }
  }
  private scrollDown(n = 1) {
    for (let i = 0; i < n; i++) { this.lines.splice(this.bottom, 1); this.lines.splice(this.top, 0, this.blank()); }
  }
  private lineFeed() {
    if (this.y === this.bottom) this.scrollUp();
    else if (this.y < this.rows - 1) this.y++;
  }

  private feed(ch: string) {
    switch (this.state) {
      case "text": return this.put(ch);
      case "esc": return this.esc(ch);
      case "csi":
        if (/[\x30-\x3f]/.test(ch)) { this.params += ch; return; }
        if (/[\x20-\x2f]/.test(ch)) { this.params += ch; return; }   // intermediates (e.g. "CSI ? 2004 $p"): kept, ignored
        this.state = "text";
        return this.csi(ch, this.params);
      case "osc":
        if (ch === "\x07") this.state = "text";
        else if (ch === "\x1b") this.state = "oscEsc";
        return;
      case "oscEsc": this.state = ch === "\\" ? "text" : "osc"; return;
      case "charset": this.state = "text"; return;
    }
  }

  private put(ch: string) {
    const c = ch.codePointAt(0)!;
    if (c === 0x1b) { this.state = "esc"; return; }
    if (c < 0x20 || c === 0x7f) {
      if (ch === "\r") { this.x = 0; this.wrapNext = false; }
      else if (ch === "\n" || ch === "\x0b" || ch === "\x0c") { this.lineFeed(); this.wrapNext = false; }
      else if (ch === "\b") { this.x = Math.max(0, this.x - 1); this.wrapNext = false; }
      else if (ch === "\t") this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
      return;
    }
    if (c >= 0x80 && c < 0xa0) return;          // C1 controls
    if (/\p{Mn}/u.test(ch)) return;               // combining marks: drop rather than misplace
    if (this.wrapNext) { this.x = 0; this.lineFeed(); this.wrapNext = false; }
    this.lines[this.y][this.x] = ch;
    if (this.x === this.cols - 1) this.wrapNext = true; else this.x++;
  }

  private esc(ch: string) {
    this.state = "text";
    if (ch === "[") { this.state = "csi"; this.params = ""; }
    else if (ch === "]" || ch === "P" || ch === "_" || ch === "^" || ch === "X") this.state = "osc";   // strings: skipped
    else if (ch === "(" || ch === ")" || ch === "*" || ch === "+" || ch === "#" || ch === "%") this.state = "charset";
    else if (ch === "7") this.saved = [this.x, this.y];
    else if (ch === "8") { [this.x, this.y] = this.saved; this.wrapNext = false; }
    else if (ch === "D") this.lineFeed();
    else if (ch === "E") { this.x = 0; this.lineFeed(); }
    else if (ch === "M") { if (this.y === this.top) this.scrollDown(); else this.y = Math.max(0, this.y - 1); }
    else if (ch === "c") { this.clear(); this.x = this.y = 0; this.top = 0; this.bottom = this.rows - 1; }
  }

  private csi(final: string, raw: string) {
    const priv = raw.startsWith("?");
    const nums = raw.replace(/^[?>=<]/, "").replace(/[\x20-\x2f]+$/, "").split(";").map((p) => (p === "" ? NaN : Number(p.split(":")[0])));
    const n = (i: number, def = 1) => (Number.isFinite(nums[i]) && nums[i] > 0 ? nums[i] : def);
    const clampY = (v: number) => Math.max(0, Math.min(this.rows - 1, v));
    const clampX = (v: number) => Math.max(0, Math.min(this.cols - 1, v));
    this.wrapNext = false;
    const row = this.lines[this.y];
    switch (final) {
      case "A": this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - n(0)); break;
      case "B": this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n(0)); break;
      case "C": case "a": this.x = clampX(this.x + n(0)); break;
      case "D": this.x = clampX(this.x - n(0)); break;
      case "E": this.y = clampY(this.y + n(0)); this.x = 0; break;
      case "F": this.y = clampY(this.y - n(0)); this.x = 0; break;
      case "G": case "`": this.x = clampX(n(0) - 1); break;
      case "d": this.y = clampY(n(0) - 1); break;
      case "H": case "f": this.y = clampY(n(0) - 1); this.x = clampX(n(1) - 1); break;
      case "J": {
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
        if (mode === 0) { for (let i = this.x; i < this.cols; i++) row[i] = " "; for (let y = this.y + 1; y < this.rows; y++) this.lines[y] = this.blank(); }
        else if (mode === 1) { for (let i = 0; i <= this.x; i++) row[i] = " "; for (let y = 0; y < this.y; y++) this.lines[y] = this.blank(); }
        else if (mode === 2) this.clear();
        else if (mode === 3) this.scrollback.length = 0;
        break;
      }
      case "K": {
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
        const [a, b] = mode === 0 ? [this.x, this.cols] : mode === 1 ? [0, this.x + 1] : [0, this.cols];
        for (let i = a; i < b; i++) row[i] = " ";
        break;
      }
      case "X": for (let i = this.x; i < Math.min(this.cols, this.x + n(0)); i++) row[i] = " "; break;
      case "P": row.splice(this.x, Math.min(n(0), this.cols - this.x)); while (row.length < this.cols) row.push(" "); break;
      case "@": row.splice(this.x, 0, ...new Array(n(0)).fill(" ")); row.length = this.cols; break;
      case "L": if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < n(0); i++) { this.lines.splice(this.bottom, 1); this.lines.splice(this.y, 0, this.blank()); } break;
      case "M": if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < n(0); i++) { this.lines.splice(this.y, 1); this.lines.splice(this.bottom, 0, this.blank()); } break;
      case "S": this.scrollUp(n(0)); break;
      case "T": if (!priv) this.scrollDown(n(0)); break;
      case "r": {
        const t = n(0) - 1, b = n(1, this.rows) - 1;
        if (t < b && b < this.rows) { this.top = t; this.bottom = b; } else { this.top = 0; this.bottom = this.rows - 1; }
        this.x = 0; this.y = 0;
        break;
      }
      case "s": if (!priv) this.saved = [this.x, this.y]; break;
      case "u": [this.x, this.y] = this.saved; break;
      case "h": case "l":
        if (priv && nums.some((m) => m === 1049 || m === 1047 || m === 47)) this.altScreen(final === "h");
        break;
      default: break;   // m (colors), n (reports), t, q, ...: no effect on the text
    }
  }

  private altScreen(on: boolean) {
    if (on && !this.alt) {
      this.alt = this.lines; this.altCursor = [this.x, this.y];
      this.clear();
    } else if (!on && this.alt) {
      this.lines = this.alt; this.alt = null;
      [this.x, this.y] = this.altCursor;
    }
  }

  /** The screen as text, trailing blanks trimmed. */
  screenText(): string {
    return this.lines.map((l) => l.join("").replace(/\s+$/, "")).join("\n").replace(/\s+$/, "");
  }

  /** The last `n` lines of scrollback plus the screen. */
  text(n = 200): string {
    const screen = this.lines.map((l) => l.join("").replace(/\s+$/, ""));
    const back = this.alt ? [] : this.scrollback.slice(-Math.max(0, n - screen.length));
    return [...back, ...screen].join("\n").replace(/\s+$/, "");
  }

  get altOn(): boolean { return Boolean(this.alt); }
  get cursor(): { x: number; y: number } { return { x: this.x, y: this.y }; }
}

/** tmux key names (as `POST /keys` takes them) → the bytes a terminal sends for them. */
const NAMED: Record<string, string> = {
  Enter: "\r", Escape: "\x1b", Tab: "\t", BTab: "\x1b[Z", BSpace: "\x7f", Space: " ",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D", Home: "\x1b[H", End: "\x1b[F",
  PageUp: "\x1b[5~", PPage: "\x1b[5~", PageDown: "\x1b[6~", NPage: "\x1b[6~", Delete: "\x1b[3~", DC: "\x1b[3~", Insert: "\x1b[2~", IC: "\x1b[2~",
  F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS", F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~", F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
};

/** The bytes for one tmux key name (`C-c`, `M-x`, `Up`, `a`), or null when it isn't one we know. */
export function keyBytes(name: string): string | null {
  if (NAMED[name] !== undefined) return NAMED[name];
  const m = /^(C|M)-(.+)$/.exec(name);
  if (m) {
    const rest = keyBytes(m[2]);
    if (rest === null) return null;
    if (m[1] === "M") return "\x1b" + rest;
    if (rest.length !== 1) return null;
    const c = rest.toLowerCase().charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60);
    const special: Record<string, string> = { "@": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f", " ": "\x00", "?": "\x7f" };
    return special[rest] ?? null;
  }
  return name.length === 1 ? name : null;
}
