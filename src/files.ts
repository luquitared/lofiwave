/**
 * Files in a run's folder, over the API: put briefs and inputs in before (or while) it runs, take results out
 * after, without SSH, tar pipes or another user's home directory. Everything is written as the server's user.
 *
 * Every path is relative to the run's cwd and must stay inside it, symlinks included: `..`, absolute paths and a
 * link pointing outside are refused before anything is read or written.
 */
import { resolve, dirname, relative, sep, isAbsolute, join, basename } from "node:path";
import { realpathSync, lstatSync, statSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { ApiError } from "./runner";

const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The run's folder, resolved (it must exist). */
function rootOf(cwd: string): string {
  try { return realpathSync(cwd); } catch { throw new ApiError(404, `the run's folder does not exist: ${cwd}`); }
}

/** Resolve `rel` inside `root`; the result has every existing symlink resolved, so later reads and writes stay inside. */
export function insidePath(cwd: string, rel: string): { root: string; abs: string; rel: string } {
  const root = rootOf(cwd);
  if (rel.includes("\0")) throw new ApiError(400, "path has a NUL byte");
  if (isAbsolute(rel)) throw new ApiError(400, "path must be relative to the run's folder");
  const target = resolve(root, rel);
  if (!within(root, target)) throw new ApiError(400, `path escapes the run's folder: ${rel}`);
  // The deepest part that exists (a dangling link counts) must resolve inside too: a link in the folder can point anywhere.
  let probe = target;
  for (;;) { try { lstatSync(probe); break; } catch { probe = dirname(probe); } }
  let real: string;
  try { real = realpathSync(probe); } catch { throw new ApiError(400, `path goes through a broken symlink: ${rel}`); }
  if (!within(root, real)) throw new ApiError(400, `path leads outside the run's folder through a symlink: ${rel}`);
  const abs = join(real, relative(probe, target));
  return { root, abs, rel: relative(root, abs) };
}

/** Create a run's missing folder (`mkdir_cwd`), only under one of `roots` (CWD_ROOTS), symlinks resolved. */
export function makeFolder(path: string, roots: string[]) {
  if (!isAbsolute(path)) throw new ApiError(400, "mkdir_cwd needs an absolute cwd");
  const target = resolve(path);
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = join(realpathSync(probe), relative(probe, target));
  const realRoots = roots.flatMap((r) => { try { return [realpathSync(r)]; } catch { return []; } });
  if (!realRoots.some((r) => within(r, real))) throw new ApiError(403, `mkdir_cwd may only create folders under ${roots.join(", ")} (CWD_ROOTS)`);
  mkdirSync(real, { recursive: true });
}

export type Entry ={ path: string; type: "file" | "dir" | "symlink" | "other"; size: number; mtime: number; text?: string };

/** A folder's entries (paths relative to it); `recursive` walks into subfolders (not through links), up to `limit` entries. */
export function listDir(abs: string, { recursive = false, limit = 5000 } = {}): { entries: Entry[]; truncated: boolean } {
  const entries: Entry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (entries.length >= limit) return;
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      entries.push({ path: relative(abs, p), type, size: st.size, mtime: Math.round(st.mtimeMs) });
      if (recursive && type === "dir") walk(p);
    }
  };
  walk(abs);
  return { entries, truncated: entries.length >= limit };
}

/** What a request asked to store at a path: a string is UTF-8, `{base64}` is binary. */
export function decodeContent(v: unknown, field: string): Uint8Array {
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v && typeof v === "object" && typeof (v as any).base64 === "string") return Buffer.from((v as any).base64, "base64");
  throw new ApiError(400, `${field} must be a string (UTF-8) or {"base64": "..."}`);
}

/** Write several files under `cwd`. All paths are checked before anything is written. Returns what was written. */
export function writeFiles(cwd: string, files: { path: string; data: Uint8Array }[]): { path: string; size: number }[] {
  const planned = files.map((f) => {
    const p = insidePath(cwd, f.path);
    if (!p.rel) throw new ApiError(400, "a file path is required");
    if (existsSync(p.abs) && statSync(p.abs).isDirectory()) throw new ApiError(400, `${p.rel} is a folder`);
    return { ...p, data: f.data };
  });
  for (const f of planned) {
    mkdirSync(dirname(f.abs), { recursive: true });
    writeFileSync(f.abs, f.data);
  }
  return planned.map((f) => ({ path: f.rel, size: f.data.byteLength }));
}

/** macOS metadata that tar picks up from a Mac (AppleDouble `._*` files, Finder's .DS_Store, zip's __MACOSX/). */
const macNoise = (path: string) => path.split("/").some((s) => s.startsWith("._") || s === ".DS_Store" || s === "__MACOSX");

/**
 * The regular files and folders in a tar (optionally gzipped). Links, devices and anything else are skipped,
 * so extracting can't plant a symlink that a later entry writes through. Handles ustar, GNU long names and pax paths.
 */
export function untar(input: Uint8Array): { files: { path: string; data: Uint8Array }[]; dirs: string[]; skipped: number } {
  let buf = input;
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try { buf = Bun.gunzipSync(input as Uint8Array<ArrayBuffer>); } catch { throw new ApiError(400, "body looks gzipped but does not decompress"); }
  }
  if (buf.length < 512) throw new ApiError(400, "body is not a tar or tar.gz archive");
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/s, "");
  const octal = (b: Uint8Array) => {
    if (b[0] & 0x80) { let n = 0; for (let i = 1; i < b.length; i++) n = n * 256 + b[i]; return n; }   // base-256 for big sizes
    return parseInt(text(b).trim() || "0", 8);
  };
  // Each header carries a checksum of its own bytes (the checksum field counted as spaces): that is how we know it's a tar.
  const checksumOk = (h: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    return sum === octal(h.subarray(148, 156));
  };
  const files: { path: string; data: Uint8Array }[] = [];
  const dirs: string[] = [];
  let skipped = 0, off = 0, longName = "", paxPath = "";
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    if (!checksumOk(h)) throw new ApiError(400, off ? `the archive is corrupt at byte ${off}` : "body is not a tar or tar.gz archive");
    const size = octal(h.subarray(124, 136));
    const flag = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (flag === "L") { longName = text(data); continue; }
    if (flag === "x") {
      for (const rec of new TextDecoder().decode(data).split("\n")) { const m = /^\d+ path=(.*)$/s.exec(rec); if (m) paxPath = m[1]; }
      continue;
    }
    if (flag === "g") continue;
    const prefix = text(h.subarray(345, 500));
    let name = paxPath || longName || (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
    paxPath = longName = "";
    name = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!name || name === "." || macNoise(name)) { skipped++; continue; }
    // Entries stay inside the folder they are extracted into, not just inside the run's folder.
    if (name.startsWith("/") || name.split("/").includes("..")) throw new ApiError(400, `archive entry escapes its folder: ${name}`);
    if (flag === "0" || flag === "7") files.push({ path: name, data });
    else if (flag === "5") dirs.push(name);
    else skipped++;
  }
  return { files, dirs, skipped };
}

/** Extract a tar(.gz) into `dest` (a folder relative to the run's cwd). Every entry is checked before anything is written. */
export function extractInto(cwd: string, dest: string, archive: Uint8Array) {
  const { files, dirs, skipped } = untar(archive);
  const base = dest.replace(/\/+$/, "");
  const at = (p: string) => (base ? `${base}/${p}` : p);
  for (const d of dirs) mkdirSync(insidePath(cwd, at(d)).abs, { recursive: true });
  const written = writeFiles(cwd, files.map((f) => ({ path: at(f.path), data: f.data })));
  return { extracted: written, dirs: dirs.length, skipped };
}

/** A tar.gz of a folder in the run, streamed from the system's tar (no macOS `._*` files). */
export function archiveOf(root: string, rel: string): Response {
  const proc = Bun.spawn(["tar", "-czf", "-", "-C", root, rel ? `./${rel}` : "."], {
    stdout: "pipe", stderr: "ignore", env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const name = `${basename(rel || root) || "run"}.tar.gz`.replace(/[^\w.-]/g, "_");
  return new Response(proc.stdout as ReadableStream, {
    headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"` },
  });
}

const INLINE_MAX = 64 * 1024, INLINE_TOTAL = 1024 * 1024;

/** A file's contents as text, if it is small UTF-8 with no NUL bytes; else undefined. */
function smallText(abs: string, size: number): string | undefined {
  if (size > INLINE_MAX) return undefined;
  const b = readFileSync(abs);
  if (b.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return undefined; }
}

/** Everything under the run's out/ folder, with small text files inlined (up to 1 MB in all). */
export function resultsOf(cwd: string): { out_dir: string; exists: boolean; files: Entry[]; truncated: boolean } {
  const out = insidePath(cwd, "out");
  if (!existsSync(out.abs) || !statSync(out.abs).isDirectory()) return { out_dir: out.abs, exists: false, files: [], truncated: false };
  const { entries, truncated } = listDir(out.abs, { recursive: true, limit: 2000 });
  let budget = INLINE_TOTAL;
  for (const e of entries) {
    if (e.type !== "file" || e.size > budget) continue;
    const t = smallText(join(out.abs, e.path), e.size);
    if (t !== undefined) { e.text = t; budget -= e.size; }
  }
  return { out_dir: out.abs, exists: true, files: entries.filter((e) => e.type !== "dir"), truncated };
}
