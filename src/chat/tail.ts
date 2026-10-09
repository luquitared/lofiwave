/**
 * Follows a JSONL file as it grows: keeps a byte offset and the trailing partial line, so half-written lines are
 * never parsed. Watches with fs.watch and also polls every second, because watchers drop events on some
 * filesystems. A file that shrinks or is replaced (Claude drops a failed stream from the end) is read again from
 * the start; `onReset` fires first so the reader can throw away what it built.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";

/** Where a line sits in the file, so a big payload can be read back on demand instead of kept in memory. */
export type LineLoc = { offset: number; length: number };

const CHUNK = 1 << 20;

export class JsonlTail {
  private offset = 0;
  private ino = 0;
  private partial: Buffer[] = [];
  private partialStart = 0;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private again = false;
  closed = false;

  constructor(
    readonly path: string,
    private onLine: (value: any, loc: LineLoc) => void,
    private onBatch: () => void,
    private onReset: () => void,
  ) {}

  start() {
    this.read();
    this.timer = setInterval(() => this.read(), 1000);
    this.watchFile();
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
  }

  private watchFile() {
    if (this.watcher || !existsSync(this.path)) return;
    try {
      this.watcher = watch(this.path, () => this.read());
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
    } catch { this.watcher = null; }
  }

  /** Read whatever was appended since last time. Synchronous reads, but in 1MB chunks. */
  read() {
    if (this.closed) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      do {
        this.again = false;
        this.readOnce();
      } while (this.again && !this.closed);
    } finally { this.reading = false; }
  }

  private readOnce() {
    let st;
    try { st = statSync(this.path); } catch { return; } // not there yet: a new session has no file until the first prompt
    if (!this.watcher) this.watchFile();
    if (st.size < this.offset || (this.ino && st.ino !== this.ino)) {
      this.offset = 0; this.partial = []; this.partialStart = 0;
      this.onReset();
    }
    this.ino = st.ino;
    if (st.size === this.offset) return;
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return; }
    let got = 0;
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - this.offset), this.offset);
        if (n <= 0) break;
        got += this.split(buf.subarray(0, n), this.offset);
        this.offset += n;
      }
    } finally { closeSync(fd); }
    if (got) this.onBatch();
  }

  /** Split a chunk into lines; the piece after the last newline waits for the next read. Returns the lines parsed. */
  private split(chunk: Buffer, at: number): number {
    let start = 0, count = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      let line: Buffer, lineStart: number;
      if (this.partial.length) {
        this.partial.push(chunk.subarray(start, nl));
        line = Buffer.concat(this.partial);
        lineStart = this.partialStart;
        this.partial = [];
      } else {
        line = chunk.subarray(start, nl);
        lineStart = at + start;
      }
      start = nl + 1;
      if (!line.length) continue;
      let value: any;
      try { value = JSON.parse(line.toString("utf8")); } catch { continue; } // junk line: skip it, never fail the view
      this.onLine(value, { offset: lineStart, length: line.length });
      count++;
    }
    if (start < chunk.length) {
      if (!this.partial.length) this.partialStart = at + start;
      this.partial.push(Buffer.from(chunk.subarray(start)));
    }
    return count;
  }
}

/** Read one line back from the file by its location (for payloads too big to keep in memory). */
export function readLineAt(path: string, loc: LineLoc): any {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(loc.length);
    readSync(fd, buf, 0, loc.length, loc.offset);
    return JSON.parse(buf.toString("utf8"));
  } finally { closeSync(fd); }
}
