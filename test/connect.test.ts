import { test, expect } from "bun:test";
import { envelope, FrameReader, serverStream, unary, ConnectError } from "../src/connect";

const dec = new TextDecoder();

test("envelope: flag byte, big-endian length, JSON", () => {
  const f = envelope({ a: 1 });
  expect(f[0]).toBe(0);
  expect(new DataView(f.buffer).getUint32(1, false)).toBe(7);
  expect(dec.decode(f.slice(5))).toBe('{"a":1}');
  expect(envelope({}, 2)[0]).toBe(2);
});

test("FrameReader reassembles frames cut at any byte", () => {
  const all = new Uint8Array([...envelope({ n: 1 }), ...envelope({ n: 2, s: "x".repeat(300) }), ...envelope({ end: true }, 2)]);
  for (const cut of [1, 3, 5, 6, 17, 64]) {
    const r = new FrameReader();
    const got: any[] = [];
    for (let i = 0; i < all.length; i += cut) for (const f of r.push(all.slice(i, i + cut))) got.push({ flags: f.flags, msg: JSON.parse(dec.decode(f.data)) });
    expect(got.map((g) => g.msg.n ?? "end")).toEqual([1, 2, "end"]);
    expect(got[2].flags).toBe(2);
    expect(r.pending).toBe(0);
  }
});

function server(handler: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({ port: 0, fetch: handler });
}

test("serverStream: request shape, messages, clean end", async () => {
  let seen: { ct: string | null; ver: string | null; body: any; path: string } | null = null;
  const srv = server(async (req) => {
    const buf = new Uint8Array(await req.arrayBuffer());
    seen = { ct: req.headers.get("content-type"), ver: req.headers.get("connect-protocol-version"), body: JSON.parse(dec.decode(buf.slice(5))), path: new URL(req.url).pathname };
    const body = new ReadableStream({
      async start(c) {
        c.enqueue(envelope({ event: { start: { pid: 7 } } }));
        await Bun.sleep(5);
        const two = new Uint8Array([...envelope({ event: { data: { pty: "aGk=" } } }), ...envelope({ event: { end: {} } })]);
        c.enqueue(two.slice(0, 10)); await Bun.sleep(5); c.enqueue(two.slice(10));
        c.enqueue(envelope({}, 2));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "application/connect+json" } });
  });
  const got: any[] = [];
  for await (const m of serverStream(`http://localhost:${srv.port}`, "process.Process/Start", { process: { cmd: "x" } })) got.push(m);
  srv.stop(true);
  expect(seen!.ct).toBe("application/connect+json");
  expect(seen!.ver).toBe("1");
  expect(seen!.path).toBe("/process.Process/Start");
  expect(seen!.body).toEqual({ process: { cmd: "x" } });
  expect(got).toEqual([{ event: { start: { pid: 7 } } }, { event: { data: { pty: "aGk=" } } }, { event: { end: {} } }]);
});

test("serverStream: end-of-stream error is thrown; a cut stream is an error", async () => {
  const srv = server((req) => {
    const p = new URL(req.url).pathname;
    const frames = p.endsWith("/Err") ? [envelope({ error: { code: "not_found", message: "no such process" } }, 2)] : [envelope({ a: 1 }).slice(0, 4)];
    return new Response(new Blob(frames));
  });
  const run = async (m: string) => { const out = []; for await (const x of serverStream(`http://localhost:${srv.port}`, m, {})) out.push(x); return out; };
  const e1 = await run("s/Err").catch((e) => e);
  expect(e1).toBeInstanceOf(ConnectError);
  expect(e1.code).toBe("not_found");
  const e2 = await run("s/Cut").catch((e) => e);
  expect(e2.code).toBe("unavailable");
  srv.stop(true);
});

test("unary: JSON in and out, errors carry the Connect code", async () => {
  const srv = server(async (req) => {
    const b = await req.json();
    if (b.fail) return Response.json({ code: "permission_denied", message: "nope" }, { status: 403 });
    if (b.proxy) return new Response("sandbox not found", { status: 502 });
    return Response.json({ echo: b, ct: req.headers.get("content-type") });
  });
  const base = `http://localhost:${srv.port}`;
  expect(await unary(base, "a/B", { x: 1 })).toEqual({ echo: { x: 1 }, ct: "application/json" });
  const e = await unary(base, "a/B", { fail: 1 }).catch((e) => e);
  expect([e.code, e.message, e.httpStatus]).toEqual(["permission_denied", "nope", 403]);
  const p = await unary(base, "a/B", { proxy: 1 }).catch((e) => e);
  expect([p.code, p.message]).toEqual(["unavailable", "sandbox not found"]);
  srv.stop(true);
});
