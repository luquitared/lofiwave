/**
 * A small Connect-RPC client over fetch (https://connectrpc.com/docs/protocol), JSON codec only: enough to talk to
 * E2B's in-sandbox `envd` daemon without its SDK. lofiwave has no dependencies, so this is the whole transport.
 *
 * - Unary: `POST <base>/<service>/<Method>`, `content-type: application/json`, the message as the body; the reply is
 *   the message, or a non-200 with `{code, message}`.
 * - Server streaming: `content-type: application/connect+json`, the request as one enveloped frame. Each frame is
 *   1 flag byte + a 4-byte big-endian length + the JSON message. Flag 0x02 marks the final frame, which carries
 *   `{error?: {code, message}, metadata?}` instead of a message. (0x01 = compressed; we never ask for compression.)
 *
 * Client streaming needs HTTP/2, which fetch here doesn't give us: input goes through unary calls instead.
 */

export class ConnectError extends Error {
  constructor(public code: string, message: string, public httpStatus = 0) { super(message); }
}

const FLAG_COMPRESSED = 0x01;
const FLAG_END = 0x02;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** One enveloped frame holding `msg` as JSON. */
export function envelope(msg: unknown, flags = 0): Uint8Array {
  const body = enc.encode(JSON.stringify(msg));
  const out = new Uint8Array(5 + body.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, body.length, false);
  out.set(body, 5);
  return out;
}

export type Frame = { flags: number; data: Uint8Array };

/** Splits a byte stream into frames, however the chunks happen to be cut. */
export class FrameReader {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames: Frame[] = [];
    while (this.buf.length >= 5) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 5).getUint32(1, false);
      if (this.buf.length < 5 + len) break;
      frames.push({ flags: this.buf[0], data: this.buf.slice(5, 5 + len) });
      this.buf = this.buf.slice(5 + len);
    }
    return frames;
  }
  /** Bytes left over that don't make a whole frame (a truncated stream). */
  get pending(): number { return this.buf.length; }
}

/** HTTP status → Connect code, for errors that didn't come with one (a proxy's 502, say). */
function codeForStatus(s: number): string {
  return ({ 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 404: "unimplemented", 408: "deadline_exceeded", 429: "unavailable", 502: "unavailable", 503: "unavailable", 504: "unavailable" } as Record<number, string>)[s] ?? "unknown";
}

async function errorFrom(res: Response): Promise<ConnectError> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    if (j && typeof j.code === "string") return new ConnectError(j.code, j.message ?? j.code, res.status);
    if (j && typeof j.message === "string") return new ConnectError(codeForStatus(res.status), j.message, res.status);
  } catch { /* not JSON */ }
  return new ConnectError(codeForStatus(res.status), text.trim().slice(0, 300) || `HTTP ${res.status}`, res.status);
}

export type CallOpts = { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch };

const url = (base: string, method: string) => `${base.replace(/\/$/, "")}/${method}`;

/** A unary call; `method` is "package.Service/Method". */
export async function unary<T = any>(base: string, method: string, req: unknown, o: CallOpts = {}): Promise<T> {
  const res = await (o.fetch ?? fetch)(url(base, method), {
    method: "POST",
    headers: { "content-type": "application/json", "connect-protocol-version": "1", ...(o.timeoutMs ? { "connect-timeout-ms": String(o.timeoutMs) } : {}), ...o.headers },
    body: JSON.stringify(req ?? {}),
    signal: o.signal ?? AbortSignal.timeout(o.timeoutMs || 30_000),
  });
  if (res.status !== 200) throw await errorFrom(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * A server-streaming call: yields each message as it arrives, ends cleanly on the end-of-stream frame, and throws
 * its error if it carries one. Aborting `signal` ends the stream (the RPC is cancelled server-side).
 */
export async function* serverStream<T = any>(base: string, method: string, req: unknown, o: CallOpts = {}): AsyncGenerator<T> {
  const res = await (o.fetch ?? fetch)(url(base, method), {
    method: "POST",
    headers: { "content-type": "application/connect+json", "connect-protocol-version": "1", ...(o.timeoutMs ? { "connect-timeout-ms": String(o.timeoutMs) } : {}), ...o.headers },
    body: envelope(req ?? {}),
    signal: o.signal,
  });
  if (res.status !== 200 || !res.body) throw await errorFrom(res);
  const reader = new FrameReader();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    for (const f of reader.push(chunk)) {
      if (f.flags & FLAG_COMPRESSED) throw new ConnectError("internal", "compressed frame, but no compression was asked for");
      const j = f.data.length ? JSON.parse(dec.decode(f.data)) : {};
      if (f.flags & FLAG_END) {
        if (j?.error) throw new ConnectError(j.error.code ?? "unknown", j.error.message ?? j.error.code ?? "stream failed");
        return;
      }
      yield j as T;
    }
  }
  // The body ended without an end-of-stream frame: the connection dropped.
  throw new ConnectError("unavailable", reader.pending ? "stream cut off mid-frame" : "stream ended without an end-of-stream frame");
}
