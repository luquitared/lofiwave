/**
 * Everything that isn't ours (`/_lw/*`) goes to the signed-in user's lofiwave, with the two secrets added on the
 * way: E2B's traffic token (gets the request into the sandbox, and wakes it when paused) and lofiwave's
 * AUTH_TOKEN (so lofiwave's UI never asks for a token). Browsers can't set headers on a WebSocket, which is why
 * the terminal goes through here too: the browser talks to us, we open the upstream socket with the headers.
 */
import type { ServerWebSocket } from "bun";
import { type UserRow } from "./db";
import { COOKIE } from "./session";
import { upstream, touch } from "./machines";

/** Request headers not passed on: hop-by-hop ones, our cookie, and whatever lofiwave would take as credentials. */
const DROP_REQ = ["host", "connection", "keep-alive", "upgrade", "transfer-encoding", "te", "trailer", "proxy-authorization",
  "authorization", "x-auth-token", "e2b-traffic-access-token", "accept-encoding", "content-length", "origin", "referer"];
const DROP_RES = ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"];

/** The cookie header without ours (lofiwave has its own cookie, `ac_session`; leave that alone). */
function stripCookie(v: string | null): string | null {
  if (!v) return null;
  const rest = v.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith(`${COOKIE}=`) && !s.startsWith("lwh_"));
  return rest.length ? rest.join("; ") : null;
}

/** lofiwave reads `token` from the query too (raw-log and terminal links); never let a caller's own go through. */
function cleanSearch(url: URL): string {
  const q = new URLSearchParams(url.search);
  q.delete("token");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function proxyHttp(req: Request, u: UserRow): Promise<Response> {
  const url = new URL(req.url);
  const up = upstream(u);
  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!DROP_REQ.includes(k)) headers.set(k, v); });
  const cookie = stripCookie(req.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie); else headers.delete("cookie");
  for (const [k, v] of Object.entries(up.headers)) headers.set(k, v);
  headers.set("accept-encoding", "identity");
  let res: Response;
  try {
    res = await fetch(up.base + url.pathname + cleanSearch(url), {
      method: req.method, headers, redirect: "manual",
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
  } catch (e: any) {
    return Response.json({ error: `your machine didn't answer: ${e?.message ?? e}` }, { status: 502 });
  }
  touch(u);
  const out = new Headers();
  res.headers.forEach((v, k) => { if (!DROP_RES.includes(k)) out.append(k, v); });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

// ---- WebSocket: browser ⟷ us ⟷ the machine's lofiwave

export type WsData = { kind: "proxy"; user: UserRow; path: string; up?: WebSocket; queue: (string | ArrayBuffer | Uint8Array)[] };

export const wsData = (u: UserRow, url: URL): WsData => ({ kind: "proxy", user: u, path: url.pathname + cleanSearch(url), queue: [] });

export const proxySocket = {
  open(ws: ServerWebSocket<WsData>) {
    const d = ws.data, up = upstream(d.user);
    // Bun's client WebSocket takes headers (browsers' can't); it sends no Origin, which lofiwave's own check allows.
    const sock = new WebSocket(`${up.base.replace(/^https/, "wss")}${d.path}`, { headers: up.headers } as any);
    sock.binaryType = "arraybuffer";
    d.up = sock;
    sock.onopen = () => { for (const m of d.queue.splice(0)) sock.send(m); touch(d.user); };
    sock.onmessage = (e) => ws.send(e.data as any);
    sock.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1011 : e.code, e.reason);
    sock.onerror = () => ws.close(1011, "your machine's terminal closed");
  },
  message(ws: ServerWebSocket<WsData>, m: string | Buffer) {
    const d = ws.data;
    // xterm.js sends its size the moment it connects: hold input until the upstream socket is open.
    if (d.up?.readyState === WebSocket.OPEN) d.up.send(m); else d.queue.push(m);
    touch(d.user);
  },
  close(ws: ServerWebSocket<WsData>) {
    try { ws.data.up?.close(); } catch {}
  },
};
