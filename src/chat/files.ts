/**
 * The chat view's files panel (see docs/rendered-view.md, "Files panel"): a file the session mentions or edited, read
 * from disk as it is now, and which of the paths in Claude's text exist (so only those become links).
 *
 * Only files inside the session's cwd or the home directory are served. Paths are resolved with realpath first, so
 * a symlink can't point out of them.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { ApiError } from "../runner";

/** Bigger files aren't shown: the panel is for reading what Claude wrote, not for browsing logs. */
const MAX_BYTES = 1024 * 1024;
const MAX_PATHS = 300;

const IMAGES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const realOrNull = (p: string) => { try { return realpathSync(p); } catch { return null; } };

/** The folders a session's files may come from: its cwd ("/" doesn't count) and the home directory. */
function roots(cwd: string): string[] {
  return [cwd && cwd !== "/" ? cwd : "", homedir()].filter(Boolean).map(realOrNull).filter((r): r is string => Boolean(r) && r !== "/");
}

const inside = (real: string, rs: string[]) => rs.some((r) => real === r || real.startsWith(r + sep));

/** A path as Claude wrote it: absolute, relative to the cwd, or ~/…. */
const absolute = (cwd: string, p: string) => p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : isAbsolute(p) ? resolve(p) : resolve(cwd || homedir(), p);

/** A path → its absolute and real forms, or null if it's missing or outside the roots. */
function locate(cwd: string, p: string, rs = roots(cwd)): { abs: string; real: string } | null {
  if (!p || p.length > 4096 || p.includes("\0")) return null;
  const abs = absolute(cwd, p);
  const real = realOrNull(abs);
  return real && inside(real, rs) ? { abs, real } : null;
}

/**
 * GET …/chat/file?path=: the file as it is on disk now, as {path, size, mtime, text} (or `binary`/`image` instead of
 * text). With raw=1, an image's bytes, for the panel's preview and for images in a markdown preview. With download=1,
 * any file's bytes as an attachment, whatever its size or type, for the panel's Download button.
 */
export function chatFile(cwd: string, path: string, raw: boolean, download = false): Response {
  if (!path || path.includes("\0")) throw new ApiError(400, "path is required");
  const abs = absolute(cwd, path);
  const real = realOrNull(abs);
  if (!real) throw new ApiError(404, `no such file: ${abs}`);
  if (!inside(real, roots(cwd))) throw new ApiError(403, "only files in the session's folder or your home directory can be shown");
  const st = statSync(real);
  if (st.isDirectory()) throw new ApiError(400, `${abs} is a folder`);
  if (!st.isFile()) throw new ApiError(400, `${abs} is not a regular file`);
  if (download) {
    const name = basename(abs);
    return new Response(Bun.file(real), { headers: {
      "content-type": "application/octet-stream", "cache-control": "private, no-cache", "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, "%27")}`,
    } });
  }
  if (st.size > MAX_BYTES) throw new ApiError(413, `${abs} is ${Math.round(st.size / 1024)} KB; the panel shows files up to 1 MB`);
  const mime = IMAGES[extname(real).toLowerCase()];
  if (raw) {
    if (!mime) throw new ApiError(415, "only images are served raw");
    // An SVG opened on its own is a document: keep any script in it from running on this origin.
    return new Response(Bun.file(real), { headers: {
      "content-type": mime, "cache-control": "private, no-cache", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    } });
  }
  const out: Record<string, unknown> = { path: abs, size: st.size, mtime: st.mtimeMs };
  if (mime) out.image = true;
  else {
    const buf = Buffer.alloc(st.size);
    const fd = openSync(real, "r");
    try { readSync(fd, buf, 0, st.size, 0); } finally { closeSync(fd); }
    if (buf.subarray(0, 8000).includes(0)) out.binary = true;
    else out.text = buf.toString("utf8");
  }
  return Response.json(out);
}

/** POST …/chat/paths {paths}: which of them are files we'd show, as {files: {<as given>: <absolute path>}}. */
export function chatPaths(cwd: string, paths: string[]): { files: Record<string, string> } {
  if (paths.length > MAX_PATHS) throw new ApiError(400, `at most ${MAX_PATHS} paths at a time`);
  const rs = roots(cwd);
  const files: Record<string, string> = {};
  for (const p of new Set(paths)) {
    const at = locate(cwd, p, rs);
    if (!at) continue;
    try { if (statSync(at.real).isFile()) files[p] = at.abs; } catch { /* gone in between */ }
  }
  return { files };
}
