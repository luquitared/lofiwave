// Sign in with Google against a scratch lofiwave and a stand-in for Google's token endpoint (GOOGLE_TOKEN_URL), through
// the relay (auth-relay/worker.js) as GOOGLE_REDIRECT_URI: the redirect to Google, the relay's forwarding, the code
// exchange with PKCE, who is let in, and the session it ends with.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import relay, { allowed } from "../auth-relay/worker.js";

const ROOT = resolve(import.meta.dir, "..");
const CLIENT = "client-123.apps.googleusercontent.com";
const RELAY = "https://auth.example.test/callback";
const ALLOWED_ORIGINS = "https://*.example.test, http://127.0.0.1:*";

let tmp = "", base = "";
let server: Bun.Subprocess | null = null;
let google: ReturnType<typeof Bun.serve>;
/** What the next code exchange answers with: the ID token's claims, keyed by code. */
const people = new Map<string, Record<string, unknown>>();
const exchanges: URLSearchParams[] = [];

const jwt = (claims: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const claims = (over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 3600, email: "dana@synjuku.ai", email_verified: true, hd: "synjuku.ai", name: "Dana K", ...over });

beforeAll(async () => {
  google = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      exchanges.push(form);
      const who = people.get(form.get("code") ?? "");
      if (!who || form.get("client_secret") !== "s3cret") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ id_token: jwt(who), access_token: "x" });
    },
  });
  tmp = mkdtempSync("/tmp/lwg-");
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env as Record<string, string>, HOME: tmp, DATA_DIR: join(tmp, "data"), PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: "tok", OPEN_TERMINAL: "none", PASSWORD: "",
    GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: "s3cret", GOOGLE_ALLOWED: "synjuku.ai, friend@gmail.com", GOOGLE_REDIRECT_URI: RELAY, GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.port}/token` };
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "server.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 80; i++) { if ((await fetch(`${base}/api/auth`).catch(() => null))?.ok) break; await Bun.sleep(250); }
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  google.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

/** Start a sign-in, "pick" an account at Google (code), go through the relay, and land on the callback. */
async function signIn(code: string, who: Record<string, unknown> | null) {
  if (who) people.set(code, who);
  const start = await fetch(`${base}/api/auth/google/start`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const auth = new URL(start.headers.get("location")!);
  const state = auth.searchParams.get("state")!;
  // Google sends the browser to the registered URI, the relay.
  const relayed = await relay.fetch(new Request(`${RELAY}?code=${code}&state=${state}`), { ALLOWED_ORIGINS });
  expect(relayed.status).toBe(302);
  const back = await fetch(relayed.headers.get("location")!, { redirect: "manual", headers: { cookie } });
  return { auth, back, cookie, state, verifier: exchanges.at(-1)?.get("code_verifier") };
}

test("Google login is advertised, and the start asks Google for the relay's URI with PKCE and the domain hint", async () => {
  expect(await (await fetch(`${base}/api/auth`)).json()).toEqual({ password_login: false, google_login: true });
  const start = await fetch(`${base}/api/auth/google/start`, { redirect: "manual" });
  const q = new URL(start.headers.get("location")!).searchParams;
  expect(q.get("client_id")).toBe(CLIENT);
  expect(q.get("redirect_uri")).toBe(RELAY);
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("hd")).toBeNull(); // a domain and an address are allowed: no single-domain hint
  expect(JSON.parse(Buffer.from(q.get("state")!, "base64url").toString()).r).toBe(`${base}/api/auth/google/callback`);
  expect(start.headers.get("set-cookie")).toContain("SameSite=Lax");
});

test("a synjuku.ai account signs in through the relay and gets a session", async () => {
  const { auth, back } = await signIn("c-dana", claims());
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("/");
  const sent = exchanges.at(-1)!;
  expect(sent.get("redirect_uri")).toBe(RELAY);
  expect(createHash("sha256").update(sent.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge")!);
  const session = back.headers.getSetCookie().find((c) => c.startsWith("ac_session="))!.split(";")[0];
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: session } })).json();
  expect(me.name).toBe("Dana K");
  expect(me.google_login).toBe(true);
});

test("an allowed address signs in; other accounts, and look-alikes of the domain, don't", async () => {
  expect((await signIn("c-friend", claims({ email: "Friend@gmail.com", hd: undefined, name: "Friend" }))).back.status).toBe(302);
  for (const [code, who] of [
    ["c-other", claims({ email: "x@gmail.com", hd: undefined })],
    ["c-lookalike", claims({ email: "dana@synjuku.ai", hd: undefined })], // a personal account with that address
    ["c-unverified", claims({ email_verified: false })],
    ["c-aud", claims({ aud: "someone-else" })],
    ["c-expired", claims({ exp: 1 })],
  ] as const) {
    const { back } = await signIn(code, who);
    expect([code, back.status]).toEqual([code, 403]);
    expect(back.headers.getSetCookie().some((c) => c.startsWith("ac_session=") && !c.startsWith("ac_session=;"))).toBe(false);
  }
});

test("a code can't be used from another browser, twice, or after Google said no", async () => {
  people.set("c-x", claims());
  const start = await fetch(`${base}/api/auth/google/start`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const cb = (q: string, c?: string) => fetch(`${base}/api/auth/google/callback?${q}`, { redirect: "manual", headers: c ? { cookie: c } : {} });
  expect((await cb(`code=c-x&state=${state}`)).status).toBe(403); // no state cookie: another browser
  expect((await cb(`code=c-x&state=${state}`, cookie)).status).toBe(302);
  expect((await cb(`code=c-x&state=${state}`, cookie)).status).toBe(403); // the state is spent
  const denied = await signIn("c-none", null);
  expect(denied.back.status).toBe(403); // Google refused the code
  const again = await fetch(`${base}/api/auth/google/start`, { redirect: "manual" });
  const s2 = new URL(again.headers.get("location")!).searchParams.get("state")!;
  const no = await cb(`error=access_denied&state=${s2}`, again.headers.get("set-cookie")!.split(";")[0]);
  expect(no.status).toBe(403);
  expect(await no.text()).toContain("cancelled");
});

test("the relay forwards only to a console's callback on an allowed origin", async () => {
  const st = (r: string) => Buffer.from(JSON.stringify({ n: "x", r })).toString("base64url");
  const go = (r: string) => relay.fetch(new Request(`${RELAY}?code=c&state=${st(r)}`), { ALLOWED_ORIGINS });
  const ok = await go("https://box.example.test/api/auth/google/callback");
  expect(ok.headers.get("location")).toBe(`https://box.example.test/api/auth/google/callback?code=c&state=${st("https://box.example.test/api/auth/google/callback")}`);
  expect((await go("http://127.0.0.1:7770/api/auth/google/callback")).status).toBe(302);
  for (const r of ["https://evil.test/api/auth/google/callback", "https://example.test.evil.test/api/auth/google/callback", "http://box.example.test/api/auth/google/callback",
    "https://box.example.test/elsewhere", "https://user:pw@box.example.test/api/auth/google/callback", "javascript:alert(1)"]) {
    expect([r, (await go(r)).status]).toEqual([r, 403]);
  }
  expect((await relay.fetch(new Request(`${RELAY}?code=c&state=garbage`), { ALLOWED_ORIGINS })).status).toBe(400);
  expect((await relay.fetch(new Request("https://auth.example.test/"), { ALLOWED_ORIGINS })).status).toBe(404);
  expect(allowed(new URL("https://a.b.example.test/"), "https://*.example.test")).toBe(true);
  expect(allowed(new URL("https://example.test/"), "https://*.example.test")).toBe(false);
  expect(allowed(new URL("https://box.example.test:8443/"), "https://*.example.test")).toBe(false);
});
