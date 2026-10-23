/* lofiwave UI — vanilla JS, talks to /api. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------------------------------------------------------- api client
let token = localStorage.getItem("ac_token") || "";
// The server prints a link with #token=… on start: keep the token, and take it out of the address bar and history.
{
  const m = location.hash.match(/^#token=([^&]+)/);
  if (m) {
    token = decodeURIComponent(m[1]);
    localStorage.setItem("ac_token", token);
    history.replaceState(null, "", location.pathname + location.search);
  }
}
async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-auth-token"] = token;
  let res;
  try { res = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (error) {
    const connection = $("#connection-status");
    if (connection) { connection.textContent = "Offline · retrying"; connection.classList.remove("online"); }
    throw error;
  }
  if (res.status === 401 && path !== "/login") {
    if (await passwordLogin()) return api(method, path, body);
    const t = prompt("Access token (AUTH_TOKEN in .env, or the one the server generated in data/auth-token):");
    if (t) { token = t; localStorage.setItem("ac_token", t); return api(method, path, body); }
    throw new Error("unauthorized");
  }
  const connection = $("#connection-status");
  if (connection) { connection.textContent = res.status < 500 ? "Connected" : "Server issue"; connection.classList.toggle("online", res.status < 500); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
/**
 * With a team password on the server, a 401 opens the sign-in dialog (name + password → session cookie) instead of
 * asking for the token. Every request that hits a 401 meanwhile waits on the same dialog.
 */
let loginWait = null;
function passwordLogin() {
  return (loginWait ??= (async () => {
    const info = await fetch("/api/auth").then((r) => r.json()).catch(() => ({}));
    if (!info.password_login) return false;
    if (token) { token = ""; localStorage.removeItem("ac_token"); }
    const dlg = $("#login-dialog"), form = $("#login-form"), err = $("#login-error");
    form.elements.name.value = localStorage.getItem("ac_name") || "";
    return new Promise((resolve) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const name = form.elements.name.value.trim();
        const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: form.elements.password.value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = data.error || "sign-in failed"; err.hidden = false; return; }
        localStorage.setItem("ac_name", name);
        form.elements.password.value = ""; err.hidden = true;
        dlg.oncancel = null; dlg.close(); loginWait = null;
        resolve(true);
        loadMe();
      };
      dlg.oncancel = (e) => e.preventDefault();
      if (!dlg.open) dlg.showModal();
      (form.elements.name.value ? form.elements.password : form.elements.name).focus();
    });
  })());
}
const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b ?? {});
const put = (p, b) => api("PUT", p, b);
const del = (p) => api("DELETE", p);

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const fmtDur = (s) => {
  if (s == null) return "–";
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "–");
const fmtRel = (ms) => {
  if (!ms) return "–";
  const d = (ms - Date.now()) / 1000;
  const s = fmtDur(Math.abs(d));
  return d > 0 ? `in ${s}` : `${s} ago`;
};
const fmtMem = (kb) => (kb == null ? "–" : kb > 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb > 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);
const badge = (s) => h("span", { class: `badge ${s}` }, s);
const shortCwd = (p) => (p || "").replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
const parseEnv = (text) => Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1)]; }));
const envText = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join("\n");
const quoteArgs = (arr) => arr.map((a) => (/[\s'"$]/.test(a) ? JSON.stringify(a) : a)).join(" ");

let toastTimer;
function toast(msg, ok = false) {
  const feedback = $("#start-feedback");
  if (!ok && $("#start-dialog")?.open && feedback) { feedback.textContent = msg; feedback.hidden = false; }
  const t = $("#toast");
  t.textContent = msg; t.className = ok ? "ok" : ""; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ok ? 2500 : 6000);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
function confirmDo(msg, fn) { if (confirm(msg)) return guard(fn)(); }

// ---------------------------------------------------------------- path picker (combobox over /api/paths)
function attachPathPicker(input) {
  const wrap = input.parentElement;
  let menu = null, items = [], active = -1, timer = null, lastQ = null, closed = true;
  const close = () => { menu?.remove(); menu = null; items = []; active = -1; closed = true; };
  const render = (list) => {
    if (!menu) { menu = h("div", { class: "pp-menu" }); wrap.append(menu); }
    items = list; active = -1; closed = false;
    if (!list.length) { menu.replaceChildren(h("div", { class: "pp-empty" }, input.value ? "No matching paths" : "No recent paths yet")); return; }
    menu.replaceChildren(...list.map((e, i) => h("div", { class: "pp-item", onmousedown: (ev) => { ev.preventDefault(); pick(i); } },
      h("span", {}, shortCwd(e.path)),
      h("span", { class: `src ${e.source}` }, e.source === "fs" ? "dir" : e.source === "run" ? `used ${fmtRel(e.last_used)}` : e.source),
    )));
  };
  const pick = (i) => { if (items[i]) { input.value = items[i].path; input.dispatchEvent(new Event("input", { bubbles: true })); } const wasFs = items[i]?.source === "fs"; close(); if (wasFs) search(true); };
  const search = async (force = false) => {
    const q = input.value.trim();
    if (!force && q === lastQ && menu) return;
    lastQ = q;
    try {
      const { paths } = await get(`/paths?q=${encodeURIComponent(q)}&limit=25`);
      if (document.activeElement === input) render(paths);
    } catch (e) { /* keep the field usable */ }
  };
  const setActive = (i) => {
    active = Math.max(-1, Math.min(items.length - 1, i));
    $$(".pp-item", menu).forEach((el, j) => el.classList.toggle("active", j === active));
    $$(".pp-item", menu)[active]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("focus", () => search(true));
  input.addEventListener("click", () => { if (closed) search(true); });
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 120); });
  input.addEventListener("blur", () => setTimeout(close, 100));
  input.addEventListener("keydown", (e) => {
    if (closed && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); return search(true); }
    if (closed) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === "Tab" && items.length && items[Math.max(active, 0)].source === "fs") { e.preventDefault(); pick(Math.max(active, 0)); }
    else if (e.key === "Escape") { close(); }
  });
}
$$("input[data-pathpicker]").forEach(attachPathPicker);

// ---------------------------------------------------------------- state
let types = [], workflows = [], targets = [], selectedRun = null, logOffset = 0, activeTab = "console";
// Console (session-first working view) state.
let consoleData = { live: [], headless: [], adoptable: [], ended: [] }, consoleRun = null, railSig = "", paneSig = "";
// The rail shows live sessions or recently ended ones; an ended one opens read-only, with a button to turn it back on.
let consoleView = localStorage.getItem("ac_console_view") === "ended" ? "ended" : "live", endedRun = null;
const typeByName = (n) => types.find((t) => t.name === n);

// ---------------------------------------------------------------- tabs
// Main tabs: Sessions, Workflows, Connect, and Advanced, which holds the rest (processes, apps, runs, types).
const ADVANCED = ["agents", "apps", "runs", "types"];
const TITLES = { console: "Sessions", workflows: "Workflows", connect: "Connect", settings: "Settings", agents: "Advanced", apps: "Advanced", runs: "Advanced", types: "Advanced" };
$$("nav button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$$("#subnav button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.sub)));
function switchTab(name, push = true) {
  if (name === "advanced") name = ADVANCED.includes(localStorage.getItem("ac_advanced")) ? localStorage.getItem("ac_advanced") : "runs";
  if (!TITLES[name]) name = "console";
  if (name !== "runs" && selectedRun) closeRun(false);
  if (name !== "console") { closeTerm(); closeChat(); syncFull(false); drawerPicked(); }
  activeTab = name;
  document.body.dataset.tab = name;
  const advanced = ADVANCED.includes(name);
  if (advanced) localStorage.setItem("ac_advanced", name);
  $("#page-title").textContent = TITLES[name];
  $("#subnav").hidden = !advanced;
  $$("#subnav button").forEach((b) => { const on = b.dataset.sub === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
  const navOf = advanced ? "advanced" : name;
  $$("nav button").forEach((b) => { b.classList.toggle("active", b.dataset.tab === navOf); b.setAttribute("aria-current", b.dataset.tab === navOf ? "page" : "false"); });
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  // Which tab you're on is view state, not a location: only run/session deep links go in the URL, so
  // reopening the console doesn't drop you back into whatever you last inspected. Sessions puts the
  // selected session back once it loads (syncConsoleHash).
  if (push && location.hash) history.replaceState(null, "", location.pathname);
  refresh();
}

// ---------------------------------------------------------------- people (signed-in name + who's online)
const loadMe = guard(async () => {
  const me = await get("/me");
  const el = $("#people");
  if (!me.password_login) { el.hidden = true; return; }
  const others = me.online.map((p) => p.name).filter((n) => n !== me.name);
  el.replaceChildren(
    "you: ", h("b", {}, me.name || "?"),
    others.length ? ` · here too: ${others.join(", ")}` : " · nobody else here",
    me.name && me.name !== "api" ? h("button", { class: "small", onclick: guard(async () => { await post("/logout"); location.reload(); }) }, "Sign out") : "",
  );
  el.title = me.online.map((p) => `${p.name} · seen ${fmtRel(p.last_seen)}`).join("\n");
  el.hidden = false;
});
/** " · by lucas" for a run someone started (blank for scheduled runs and older ones). */
/** The swarm a run belongs to (runs started for one job share a `group`); clicking it lists the group's runs. */
const groupTag = (r) => (r.group ? h("span", { class: "wf-tag group-tag", title: `group ${r.group}: show its runs`, onclick: (e) => { e.stopPropagation(); e.preventDefault(); showGroup(r.group); } }, `◇ ${r.group}`) : "");
function showGroup(g) {
  const rg = $("#runs-group");
  if (![...rg.options].some((o) => o.value === g)) rg.append(h("option", { value: g }, g));
  rg.value = g; switchTab("runs");
}
const byWho = (r) =>(r.meta?.started_by ? ` · by ${r.meta.started_by.replace(/^key:/, "")}` : "");

// ---------------------------------------------------------------- system info
let systemInfo = null;
const loadSystem = guard(async () => {
  const s = await get("/system");
  systemInfo = s;
  const addrs = Object.values(s.addresses).flat();
  const ts = s.tailscale;
  // One short line in the top bar; the addresses are in its tooltip.
  const el = $("#sysinfo");
  el.replaceChildren(h("b", {}, s.hostname), ` · up ${fmtDur(s.uptime_ms / 1000)}`);
  el.title = [`${s.hostname} · ${s.platform} · bun ${s.bun}`,
    ts && ts.ips?.length ? `tailscale: ${ts.dns_name || ""} ${ts.ips.filter((ip) => !ip.includes(":")).join(", ")}${ts.state === "Running" ? "" : ` (${ts.state})`}` : ts ? `tailscale: ${ts.state}` : "tailscale: not installed",
    addrs.length ? `lan: ${addrs.join(", ")}` : ""].filter(Boolean).join("\n");
});

/** An app's UI link as seen from this browser: {host} becomes the host the console was opened on (works over Tailscale too). */
const appUrl = (t) => (t.url ? t.url.replace("{host}", location.hostname) : "");

// ---------------------------------------------------------------- types
const loadTypes = guard(async () => {
  types = await get("/process-types");
  // Workflows pick from agents first; apps can be scheduled too.
  const wsel = $("#wf-form [name=type]");
  if (!wsel.closest("dialog[open]")) {
    const cur = wsel.value;
    const sorted = [...types].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1));
    wsel.replaceChildren(...sorted.map((t) => h("option", { value: t.name }, t.name + (t.kind === "app" ? " (app)" : "") + (t.available ? "" : " · not found"))));
    if (cur && typeByName(cur)) wsel.value = cur;
  }
  const rt = $("#runs-type"); const cur = rt.value;
  rt.replaceChildren(h("option", { value: "" }, "All types"), ...types.map((t) => h("option", { value: t.name }, t.name))); rt.value = cur;
  $("#type-table tbody").replaceChildren(...types.map((t) => h("tr", {},
    h("td", { class: "full" }, h("b", {}, t.name), t.builtin ? h("span", { class: "muted" }, " built-in") : "", t.description ? h("div", { class: "muted", style: "font-size:12px;max-width:320px" }, t.description) : ""),
    h("td", {}, h("span", { class: "pill" }, t.kind)),
    h("td", { class: "mono full" }, t.command, h("div", { class: "muted" }, t.resolved || ""), t.default_cwd ? h("div", { class: "muted", title: t.default_cwd }, `in ${shortCwd(t.default_cwd)}`) : ""),
    h("td", { class: "mono full", "data-l": "args" }, t.args.join(" ")),
    h("td", { class: "mono trunc", "data-l": "detect", title: t.detect }, t.detect || "–"),
    h("td", { "data-l": "found" }, t.available ? "✓" : h("span", { style: "color:var(--bad)" }, "✗")),
    h("td", { class: "row" },
      h("button", { class: "small", onclick: () => editType(t) }, "Edit"),
      !t.builtin && h("button", { class: "small danger", onclick: () => confirmDo(`Delete process type "${t.name}"?`, async () => { await del(`/process-types/${t.name}`); toast("deleted", true); loadTypes(); }) }, "Delete"),
    ),
  )));
});
function editType(t) {
  const f = $("#type-form");
  f.orig.value = t.name; f.elements.namedItem("name").value = t.name; f.elements.namedItem("name").disabled = true; f.kind.value = t.kind; f.command.value = t.command; f.default_cwd.value = t.default_cwd || ""; f.url.value = t.url || "";
  f.args.value = t.args.join("\n"); f.interactive_args.value = Array.isArray(t.interactive_args) ? t.interactive_args.join("\n") : (t.interactive_args || ""); f.resume_args.value = Array.isArray(t.resume_args) ? t.resume_args.join("\n") : (t.resume_args || ""); f.detect.value = t.detect; f.env.value = envText(t.env); f.description.value = t.description;
  $("#type-panel-title").textContent = `Edit process type: ${t.name}`; $("#type-panel").open = true; f.command.focus();
}
function newType(kind) {
  const f = $("#type-form"); f.reset(); f.orig.value = ""; f.elements.namedItem("name").disabled = false; f.kind.value = kind;
  $("#type-panel-title").textContent = kind === "app" ? "New app" : "New process type"; $("#type-panel").open = true;
  switchTab("types"); f.elements.namedItem("name").focus();
}
function resetTypeForm() { const f = $("#type-form"); f.reset(); f.orig.value = ""; f.elements.namedItem("name").disabled = false; $("#type-panel-title").textContent = "New process type"; $("#type-panel").open = false; }
$("#type-cancel").onclick = resetTypeForm;
$("#add-app-btn").onclick = () => newType("app");
$("#type-form").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.elements.namedItem("name").value.trim(), kind: f.kind.value, command: f.command.value.trim(), default_cwd: f.default_cwd.value.trim(), url: f.url.value.trim(), args: f.args.value.split("\n").filter((l) => l !== ""), interactive_args: f.interactive_args.value.split("\n").filter((l) => l !== ""), resume_args: f.resume_args.value.split("\n").filter((l) => l !== ""), detect: f.detect.value, env: parseEnv(f.env.value), description: f.description.value };
  if (f.orig.value) await put(`/process-types/${f.orig.value}`, body); else await post("/process-types", body);
  toast("saved", true); resetTypeForm(); loadTypes();
}));

// ---------------------------------------------------------------- process tables (shared by Agents and Apps)
function renderProcRows(tbody, procs) {
  tbody.replaceChildren(...procs.map((p) => h("tr", { class: p.child ? "child" : "" },
    h("td", { class: "mono" }, p.pid),
    h("td", {}, p.type, p.managed && !p.child ? " " : "", p.managed && !p.child ? badge("managed") : ""),
    h("td", { class: "sesscell" }, sessionCell(p.session)),
    h("td", { class: "mono trunc", title: p.cwd || "" }, shortCwd(p.cwd) || "–"),
    h("td", { class: "mono trunc", title: p.cmd }, p.cmd),
    h("td", { "data-l": "up" }, fmtDur(p.elapsedSec)),
    h("td", { "data-l": "cpu" }, p.cpu == null ? "–" : `${p.cpu}%`),
    h("td", { "data-l": "mem" }, fmtMem(p.rssKb)),
    h("td", { "data-l": "run" }, p.run_id ? h("a", { class: "link", href: `#runs/${p.run_id}`, onclick: (e) => { e.preventDefault(); openRun(p.run_id); } }, `#${p.run_id}`, p.workflow_name ? ` ${p.workflow_name}` : "") : "–"),
    h("td", { class: "row" },
      p.session?.session_id && !p.child && p.drivable
        ? h("button", { class: "small primary", title: "this session already has a terminal here", onclick: () => { selectConsoleRunId(p.run_id); switchTab("console"); loadConsole(); } }, "Open terminal")
        : p.session?.session_id && !p.child ? h("button", { class: "small", title: `${p.session.resume_cmd} — in a tmux session managed here`, onclick: () => takeOver(p) }, "Take over here") : "",
      !p.child ? remoteControlBtn(p.pid, p.session, p.drivable || Boolean(p.session?.tmux)) : "",
      !p.child && !p.drivable ? chatBtn(p.session) : "",
      p.run_id && !p.child ? h("button", { class: "small", onclick: () => guard(async () => { const r = await post(`/runs/${p.run_id}/restart`); toast(`restarted as run #${r.id}`, true); refresh(); })() }, "Restart") : "",
      h("button", { class: "small danger", onclick: () => confirmDo(`Stop pid ${p.pid} (${p.type})?`, async () => { await del(`/processes/${p.pid}`); toast("SIGTERM sent", true); refresh(); }) }, "Stop"),
      h("button", { class: "small danger", title: "SIGKILL", onclick: () => confirmDo(`Force kill pid ${p.pid}?`, async () => { await del(`/processes/${p.pid}?force=1`); toast("SIGKILL sent", true); refresh(); }) }, "Kill"),
    ),
  )));
  if (!procs.length) tbody.replaceChildren(h("tr", {}, h("td", { colspan: 10, class: "muted" }, "Nothing running.")));
}
const shortId = (id) => (id || "").slice(0, 8);
/** Name / title / status / web link of an agent session, as reported by the agent itself. */
function sessionCell(s) {
  if (!s) return h("span", { class: "muted" }, "–");
  const label = s.title || s.name || shortId(s.session_id);
  return h("div", { class: "sess", title: `${s.agent} session ${s.session_id}${s.name ? `\nname: ${s.name}` : ""}${s.title ? `\ntitle: ${s.title}` : ""}\n${s.resume_cmd}` },
    h("div", {}, s.status ? h("span", { class: `dot ${s.status}`, title: s.status }) : "", label),
    h("div", { class: "muted", style: "font-size:11.5px" },
      s.name && s.title ? `${s.name} · ` : "", h("code", { class: "mono" }, shortId(s.session_id)), s.model ? ` · ${s.model.replace(/^claude-/, "")}` : "",
      s.web_url ? h("a", { href: s.web_url, target: "_blank", style: "margin-left:6px" }, "open on web ↗") : "",
    ),
  );
}
const countText = (procs, what) => {
  const top = procs.filter((p) => !p.child).length, managed = procs.filter((p) => p.managed && !p.child).length;
  return `${top} ${what}${top === 1 ? "" : what.endsWith("process") ? "es" : "s"}${managed ? ` · ${managed} started here` : ""}`;
};

// ---------------------------------------------------------------- agents tab
const loadAgents = guard(async () => {
  const procs = await get("/processes?kind=agent");
  const hideKids = $("#hide-children").checked;
  $("#agent-count").textContent = countText(procs, "agent process");
  renderProcRows($("#agent-table tbody"), procs.filter((p) => !(hideKids && p.child)));
});
$("#hide-children").checked = localStorage.getItem("ac_hide_children") !== "false";
$("#hide-children").onchange = () => { localStorage.setItem("ac_hide_children", String($("#hide-children").checked)); loadAgents(); };

// ---------------------------------------------------------------- apps tab
const loadApps = guard(async () => {
  const [procs, lastRuns] = await Promise.all([get("/processes?kind=app"), get("/runs?limit=200")]);
  const apps = types.filter((t) => t.kind === "app");
  const lastByType = {};
  for (const r of lastRuns.runs) if (!lastByType[r.type_name]) lastByType[r.type_name] = r;
  $("#app-table tbody").replaceChildren(...apps.map((t) => {
    const mine = procs.filter((p) => p.type === t.name && !p.child);
    const last = lastByType[t.name];
    return h("tr", {},
      h("td", { class: "full" }, h("div", { class: "app-name" }, t.name, t.available ? "" : h("span", { class: "muted", title: "command not found on PATH" }, " ✗")), t.description ? h("div", { class: "app-desc" }, t.description) : "",
        appUrl(t) ? h("div", {}, h("a", { class: "link mono", href: appUrl(t), target: "_blank", rel: "noopener" }, appUrl(t))) : ""),
      h("td", { class: "mono full" }, quoteArgs([t.command, ...t.args]), t.default_cwd ? h("div", { class: "muted", title: t.default_cwd }, `in ${shortCwd(t.default_cwd)}`) : ""),
      h("td", {}, mine.length ? h("span", { class: "pill on" }, `${mine.length} running`) : h("span", { class: "pill" }, "stopped"), mine.length ? h("div", { class: "muted mono", style: "font-size:11.5px" }, `pid ${mine.map((p) => p.pid).join(", ")} · up ${fmtDur(Math.max(...mine.map((p) => p.elapsedSec ?? 0)))}`) : ""),
      h("td", { "data-l": "last run" }, last ? h("a", { class: "link", href: `#runs/${last.id}`, onclick: (e) => { e.preventDefault(); openRun(last.id); } }, badge(last.status), ` ${fmtRel(last.started_at)}`) : h("span", { class: "muted" }, "never")),
      h("td", { class: "row" },
        appUrl(t) ? h("a", { href: appUrl(t), target: "_blank", rel: "noopener" }, h("button", { class: "small primary", title: appUrl(t) }, "Open")) : "",
        h("button", { class: "small" + (appUrl(t) ? "" : " primary"), onclick: () => openStartDialog({ type: t.name }) }, "Start"),
        mine.length ? h("button", { class: "small danger", onclick: () => confirmDo(`Stop all ${mine.length} ${t.name} process(es)?`, async () => { for (const p of mine) await del(`/processes/${p.pid}`); toast("stopped", true); refresh(); }) }, "Stop") : "",
        h("button", { class: "small", onclick: () => { $("#runs-type").value = t.name; switchTab("runs"); } }, "Runs"),
        h("button", { class: "small", onclick: () => { editType(t); switchTab("types"); } }, "Edit"),
      ),
    );
  }));
  if (!apps.length) $("#app-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No apps yet. Click “Add app”, or point an agent at the API docs.")));
  $("#app-proc-count").textContent = procs.length ? `(${countText(procs, "process")})` : "";
  renderProcRows($("#app-proc-table tbody"), procs);
});

// ---------------------------------------------------------------- start dialog
const dlg = $("#start-dialog"), sf = $("#start-form");
function openStartDialog({ kind, type } = {}) {
  const sel = sf.type;
  const allowed = type ? types.filter((t) => t.name === type) : types.filter((t) => !kind || t.kind === kind);
  sel.replaceChildren(...allowed.map((t) => h("option", { value: t.name }, `${t.name}` + (t.available ? "" : " · not found"))));
  sel.disabled = allowed.length <= 1;
  sf.prompt.value = ""; sf.extra_args.value = ""; sf.timeout_sec.value = 0; $("#preview").textContent = "";
  $("#start-title").textContent = type ? `Start ${type}` : kind === "agent" ? "New session" : "Start a process";
  $(".more", sf).open = false;
  $("#start-feedback").hidden = true;
  // Sessions can run in an E2B sandbox, with a live terminal there.
  const sandboxes = targets;
  sf.target.replaceChildren(h("option", { value: "" }, "This machine"), ...sandboxes.map((t) => h("option", { value: t.name }, `${t.name} (${targetKindLabel(t)})`)));
  sf.target.value = "";
  $("#start-target-label").hidden = !sandboxes.length || kind === "app";
  applyStartType();
  dlg.showModal();
  (sf.cwd.value ? sf.prompt : sf.cwd).focus();
  // Prefill the folder with the one most recently used, so a test start is a single click.
  if (!sf.cwd.value) get("/paths?limit=1").then(({ paths }) => { if (dlg.open && !sf.cwd.value && paths?.[0]) sf.cwd.value = paths[0].path; }).catch(() => {});
}
/** Agents always start interactive (when tmux is here, or in a sandbox); apps run headless. The server applies the same default. */
const startsInteractive = (t) => t?.kind === "agent" && (Boolean(sf.target.value) || Boolean(systemInfo?.tmux));
function applyStartType() {
  const t = typeByName(sf.type.value);
  const interactive = startsInteractive(t);
  $("#start-target-hint").textContent = sf.target.value
    ? "A live terminal in its own sandbox. The agent works in the sandbox's folder; the folder above is where its conversation is filed here, for Resume."
    : "";
  const needsPrompt = t && (t.args.some((a) => a.includes("{prompt}")) || t.command.includes("{prompt}")) && !interactive;
  sf.prompt.required = Boolean(needsPrompt);
  $("#prompt-label").hidden = t && !needsPrompt && t.kind === "app";
  sf.prompt.placeholder = interactive ? "Optional first message" : "What should it do?";
  sf.cwd.value = t?.default_cwd || sf.cwd.value;
  sf.cwd.placeholder = t?.default_cwd ? t.default_cwd : "start typing to search";
  sf.extra_args.placeholder = t?.name === "claude" ? "--permission-mode acceptEdits" : t?.name === "codex" ? "--sandbox workspace-write" : "";
}
sf.type.onchange = applyStartType;
sf.target.onchange = applyStartType;
$("#start-cancel").onclick = () => dlg.close();
function startFormBody() {
  return { type: sf.type.value, cwd: sf.cwd.value.trim(), prompt: sf.prompt.value, extra_args: sf.extra_args.value, timeout_sec: Number(sf.timeout_sec.value || 0), interactive: startsInteractive(typeByName(sf.type.value)), target: sf.target.value || undefined };
}
$("#preview-btn").onclick = guard(async () => {
  if (!sf.reportValidity()) return;
  $("#start-feedback").hidden = true;
  const r = await post("/processes/preview", startFormBody());
  $("#preview").textContent = "$ " + quoteArgs([r.command, ...r.args]);
});
let starting = false;
$("#start-submit").onclick = guard(async () => {
  if (starting || !sf.reportValidity()) return;      // a double-click used to start two agents
  starting = true;
  const btn = $("#start-submit");
  btn.disabled = true; btn.textContent = "Starting…";
  try {
  $("#start-feedback").hidden = true;
  const run = await post("/processes", startFormBody());
  toast(`started run #${run.id} (pid ${run.pid})`, true);
  dlg.close();
  if (run.meta?.interactive) { selectConsoleRunId(run.id); switchTab("console"); loadConsole(); }
  else refresh();
  } finally { starting = false; btn.disabled = false; btn.textContent = "Start"; }
});
sf.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#start-submit").click(); });

// ---------------------------------------------------------------- resume dialog
// Paste a session id (or the whole `claude --resume <id>` / `codex resume <id>` line); the server finds its transcript,
// which tells us the agent and the folder it ran in — claude only finds a session when started from that folder.
const rdlg = $("#resume-dialog"), rf = $("#resume-form");
let resumeLookup = 0, resumeCwdTouched = false, resumeAgentPicked = false, resumeTimer;
function parseSessionInput(text) {
  const s = text.trim();
  const agent = /^codex\b/.test(s) ? "codex" : /^claude\b/.test(s) ? "claude" : "";
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s);
  return { id: uuid ? uuid[0] : s.split(/\s+/).pop() || "", agent };
}
function openResumeDialog() {
  rf.reset(); resumeCwdTouched = false; resumeAgentPicked = false;
  $("#resume-found").textContent = ""; $("#resume-feedback").hidden = true;
  rdlg.showModal();
  rf.session_id.focus();
}
async function lookUpResume() {
  const { id, agent: typed } = parseSessionInput(rf.session_id.value);
  const agent = typed || (resumeAgentPicked ? rf.agent.value : "");
  rf.agent.value = agent;
  const seq = ++resumeLookup;
  const found = $("#resume-found");
  if (!id) { found.textContent = ""; return; }
  found.textContent = "Looking it up…";
  try {
    const s = await get(`/sessions/${encodeURIComponent(id)}${agent ? `?agent=${agent}` : ""}`);
    if (seq !== resumeLookup) return;
    rf.agent.value = s.agent;
    if (!resumeCwdTouched && s.cwd) rf.cwd.value = s.cwd;
    const title = (s.title || s.name).replace(/\s+/g, " ").trim();
    found.textContent = `Found: ${s.agent}${title ? ` · ${title.length > 80 ? title.slice(0, 80) + "…" : title}` : ""}${s.cwd ? ` · ${shortCwd(s.cwd)}` : ""}${s.status ? ` · open now (${s.status})` : ""}`;
  } catch (e) {
    if (seq === resumeLookup) found.textContent = e.message;
  }
}
rf.session_id.addEventListener("input", () => { clearTimeout(resumeTimer); resumeTimer = setTimeout(lookUpResume, 250); });
rf.agent.onchange = () => { resumeAgentPicked = Boolean(rf.agent.value); lookUpResume(); };
rf.cwd.addEventListener("input", () => { resumeCwdTouched = true; });
$("#resume-cancel").onclick = () => rdlg.close();
let resuming = false;
$("#resume-submit").onclick = async () => {
  if (resuming || !rf.reportValidity()) return;
  resuming = true;
  const btn = $("#resume-submit"), fb = $("#resume-feedback");
  btn.disabled = true; btn.textContent = "Resuming…"; fb.hidden = true;
  try {
    const { id } = parseSessionInput(rf.session_id.value);
    const run = await post("/sessions/resume", { session_id: id, agent: rf.agent.value, cwd: rf.cwd.value.trim() });
    toast(`resumed as run #${run.id}`, true);
    rdlg.close();
    selectConsoleRunId(run.id); switchTab("console"); loadConsole();
  } catch (e) { fb.textContent = e.message; fb.hidden = false; }
  finally { resuming = false; btn.disabled = false; btn.textContent = "Resume"; }
};
rf.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT" && e.target.name === "session_id") { e.preventDefault(); $("#resume-submit").click(); } });
$("#resume-agent-btn").onclick = openResumeDialog;

// ---------------------------------------------------------------- workflows
const PRESETS = ["", "@hourly", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 1"];
const presetLabel = (cron) => ({ "@hourly": "Every hour", "@daily": "Every day", "0 9 * * *": "Daily 9:00", "0 9 * * 1-5": "Weekdays 9:00", "0 9 * * 1": "Mondays 9:00" })[cron] || cron;
const runLink = (r, text) => h("a", { class: "link", href: `#runs/${r.id}`, onclick: (e) => { e.preventDefault(); openRunOrSession(r); } }, text);
/** A live interactive run opens in Sessions; anything else in the run history. */
function openRunOrSession(r) {
  if (r.status === "running" && (r.meta?.interactive ?? true)) { selectConsoleRunId(r.id); switchTab("console"); return; }
  openRun(r.id);
}
const runWorkflowNow = (w) => guard(async () => {
  const r = await post(`/workflows/${w.id}/run`);
  toast(`started ${w.name} (run #${r.id})${r.meta?.target ? ` on ${r.meta.target}` : ""}`, true);
  if (r.meta?.interactive) { selectConsoleRunId(r.id); switchTab("console"); } else if (r.meta?.target) openRun(r.id); else loadWorkflows();
})();

const loadWorkflows = guard(async () => {
  workflows = await get("/workflows");
  const rw = $("#runs-workflow"); const cur = rw.value;
  rw.replaceChildren(h("option", { value: "" }, "All workflows"), ...workflows.map((w) => h("option", { value: w.id }, w.name))); rw.value = cur;
  const on = workflows.filter((w) => w.enabled && w.schedule).length;
  $("#wf-count").textContent = workflows.length ? `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}${on ? ` · ${on} scheduled` : ""}` : "";
  $("#wf-table tbody").replaceChildren(...workflows.map((w) => h("tr", {},
    h("td", { class: "full" },
      h("button", { class: "wf-name", onclick: () => editWorkflow(w) }, w.name),
      h("div", { class: "muted wf-sub", title: w.prompt || "" }, w.target ? h("span", { class: "pill" }, `☁ ${w.target}`) : "", w.target ? " " : "", `${w.type_name}${w.target ? "" : ` · ${shortCwd(w.cwd)}`}`, w.prompt ? ` · ${w.prompt.split("\n")[0]}` : "")),
    h("td", { "data-l": "schedule", title: w.schedule ? `${w.schedule}\nnext: ${fmtTime(w.next_run_at)}` : "" },
      w.schedule ? h("span", {}, presetLabel(w.schedule), h("div", { class: "muted wf-sub" }, w.enabled ? `next ${fmtRel(w.next_run_at)}` : "paused")) : h("span", { class: "muted" }, "Manual")),
    h("td", { "data-l": "last" }, w.last_run ? runLink(w.last_run, [badge(w.last_run.status), ` ${fmtRel(w.last_run.started_at)}`]) : h("span", { class: "muted" }, "never")),
    h("td", {}, h("button", { class: `on-toggle ${w.enabled ? "on" : ""}`, role: "switch", "aria-checked": String(w.enabled), "aria-label": `Enable ${w.name}`, title: w.enabled ? "enabled" : "paused", onclick: () => guard(async () => { await put(`/workflows/${w.id}`, { enabled: !w.enabled }); loadWorkflows(); })() })),
    h("td", { class: "row" },
      h("button", { class: "small primary", onclick: () => runWorkflowNow(w) }, "Run now"),
      h("button", { class: "small", onclick: () => { $("#runs-workflow").value = w.id; switchTab("runs"); } }, "History"),
      h("button", { class: "small", onclick: () => editWorkflow(w) }, "Edit"),
    ),
  )));
  if (!workflows.length) $("#wf-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted empty" }, "No workflows yet. Make one, or have an agent make them from the Connect page.")));
});

const wdlg = $("#wf-dialog"), wf = $("#wf-form");
function setSchedule(cron) {
  wf.preset.value = PRESETS.includes(cron) ? cron : "custom";
  wf.schedule.value = cron;
  syncPreset();
}
function syncPreset() {
  const custom = wf.preset.value === "custom";
  $("#cron-label").hidden = !custom;
  if (!custom) wf.schedule.value = wf.preset.value;
}
wf.preset.onchange = () => { syncPreset(); if (wf.preset.value === "custom") wf.schedule.focus(); };
function openWorkflowDialog(w) {
  wf.reset(); $("#wf-feedback").hidden = true;
  wf.elements.namedItem("id").value = w?.id ?? "";
  $("#wf-title").textContent = w ? `Edit ${w.name}` : "New workflow";
  $(".more", wf).open = false;
  if (w) {
    wf.elements.namedItem("name").value = w.name; wf.type.value = w.type_name; wf.cwd.value = w.cwd; wf.prompt.value = w.prompt;
    wf.extra_args.value = quoteArgs(w.extra_args); wf.env.value = envText(w.env);
    wf.timeout_sec.value = w.timeout_sec; wf.enabled.checked = w.enabled; wf.allow_overlap.checked = w.allow_overlap;
    fillTargetSelect(w.target);
    $(".more", wf).open = Boolean(w.extra_args.length || Object.keys(w.env || {}).length || w.timeout_sec || w.allow_overlap);
  } else {
    wf.type.value = typeByName("claude") ? "claude" : wf.type.options[0]?.value;
    fillTargetSelect("");
  }
  syncTarget();
  setSchedule(w?.schedule ?? "");
  // The delete button only makes sense on an existing workflow.
  $("#wf-delete")?.remove();
  if (w) $("#wf-cancel").before(h("button", { type: "button", id: "wf-delete", class: "danger", onclick: () => confirmDo(`Delete workflow "${w.name}"? Past runs are kept.`, async () => { await del(`/workflows/${w.id}`); toast("deleted", true); wdlg.close(); loadWorkflows(); }) }, "Delete"));
  wdlg.showModal();
  wf.elements.namedItem("name").focus();
}
const editWorkflow = (w) => openWorkflowDialog(w);
function fillTargetSelect(cur) {
  wf.target.replaceChildren(h("option", { value: "" }, "This machine"), ...targets.map((t) => h("option", { value: t.name }, `${t.name} (${targetKindLabel(t)})`)));
  if (cur && !targets.some((t) => t.name === cur)) wf.target.append(h("option", { value: cur }, `${cur} (missing)`));
  wf.target.value = cur || "";
}
/** On a target the agent works in the target's folder, and the folder here is where its conversation is filed to resume. */
const targetKindLabel = (t) => `E2B sandbox, ${t.config.template}`;
function syncTarget() {
  const remote = Boolean(wf.target.value);
  $("#wf-cwd-label").firstChild.textContent = remote ? "Folder here (to resume the conversation in) " : "Folder ";
  wf.cwd.placeholder = remote ? "optional: the local checkout of the same repo" : "blank = the type's default folder";
  $("#wf-hint").textContent = remote
    ? "Each run gets its own E2B sandbox. With the target's idle_sec and idle_action \"stop\" it is a live session you can open and type into; otherwise it runs headless. Claude's conversation and the sandbox's out/ folder come back at the end."
    : "Each run opens as a live session you can watch and type into. Claude runs close once the agent is done and idle.";
}
wf.target.onchange = syncTarget;
$("#wf-new-btn").onclick = () => openWorkflowDialog(null);
$("#wf-cancel").onclick = () => wdlg.close();
async function saveWorkflow() {
  if (!wf.reportValidity()) return null;
  $("#wf-feedback").hidden = true;
  const body = { name: wf.elements.namedItem("name").value.trim(), type: wf.type.value, cwd: wf.cwd.value.trim(), prompt: wf.prompt.value, target: wf.target.value, extra_args: wf.extra_args.value, env: parseEnv(wf.env.value), schedule: wf.schedule.value.trim(), timeout_sec: Number(wf.timeout_sec.value || 0), enabled: wf.enabled.checked, allow_overlap: wf.allow_overlap.checked };
  const id = wf.elements.namedItem("id").value;
  try { return id ? await put(`/workflows/${id}`, body) : await post("/workflows", body); }
  catch (e) { $("#wf-feedback").textContent = e.message; $("#wf-feedback").hidden = false; return null; }
}
wf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const w = await saveWorkflow();
  if (w) { toast("saved", true); wdlg.close(); loadWorkflows(); }
});
$("#wf-save-run").onclick = async () => {
  const w = await saveWorkflow();
  if (w) { wdlg.close(); runWorkflowNow(w); }
};

// ---------------------------------------------------------------- connect (API docs URL + API keys)
const docsUrl = () => `${location.origin}/api/docs`;
const agentPrompt = (key) => `Read ${docsUrl()} and use the lofiwave API with the header "Authorization: Bearer ${key || "<API key>"}". `;
function copy(text, what) { navigator.clipboard?.writeText(text).then(() => toast(`copied ${what}`, true), () => toast("couldn't copy; select it and copy by hand")); }
$("#copy-docs-url").onclick = () => copy(docsUrl(), "the URL");
$("#copy-agent-prompt").onclick = () => copy(agentPrompt(lastKey), "the prompt");
let lastKey = "";
const loadConnect = guard(async () => {
  $("#docs-url").textContent = docsUrl();
  $("#agent-prompt").textContent = agentPrompt(lastKey ? lastKey.slice(0, 9) + "…" : "");
  let keys;
  try { keys = await get("/keys"); } catch (e) { $("#key-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted empty" }, e.message))); return; }
  $("#key-table tbody").replaceChildren(...keys.map((k) => h("tr", {},
    h("td", { class: "full" }, h("b", {}, k.name), k.created_by ? h("div", { class: "muted wf-sub" }, `by ${k.created_by}`) : ""),
    h("td", { class: "mono", "data-l": "key" }, `${k.prefix}…`),
    h("td", { "data-l": "created", title: fmtTime(k.created_at) }, fmtRel(k.created_at)),
    h("td", { "data-l": "used", title: fmtTime(k.last_used_at) }, k.last_used_at ? fmtRel(k.last_used_at) : h("span", { class: "muted" }, "never")),
    h("td", { class: "row" }, h("button", { class: "small danger", onclick: () => confirmDo(`Revoke "${k.name}"? Anything using it stops working.`, async () => { await del(`/keys/${k.id}`); toast("revoked", true); loadConnect(); }) }, "Revoke")),
  )));
  if (!keys.length) $("#key-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted empty" }, "No keys yet.")));
});
$("#key-form").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const k = await post("/keys", { name: e.target.elements.name.value.trim() });
  e.target.reset();
  lastKey = k.key;
  $("#new-key").replaceChildren(
    h("div", {}, h("b", {}, `Key for ${k.name}`), h("span", { class: "muted" }, " · shown once, copy it now")),
    h("div", { class: "copy-row" }, h("code", { class: "mono" }, k.key), h("button", { class: "small primary", onclick: () => copy(k.key, "the key") }, "Copy key"), h("button", { class: "small", onclick: () => copy(agentPrompt(k.key), "the prompt with the key") }, "Copy prompt with key")),
  );
  $("#new-key").hidden = false;
  loadConnect();
}));

// ---------------------------------------------------------------- settings (color scheme, kept per browser)
const THEMES = [
  { id: "system", name: "System", note: "Wave, light or dark like your OS", swatch: ["#16131a", "#f6c9a6", "#fbf6f3", "#8a5ea2"] },
  { id: "wave", name: "Wave", note: "Dark plum, peach", swatch: ["#16131a", "#1f1a25", "#f6c9a6", "#a985b8"] },
  { id: "wave-light", name: "Wave light", note: "Warm paper, lavender", swatch: ["#fbf6f3", "#ffffff", "#8a5ea2", "#f6c9a6"] },
  { id: "forest", name: "Forest", note: "The original green", swatch: ["#111312", "#191c1a", "#c4ef91", "#719653"] },
];
const themePref = () => { try { return localStorage.getItem("ac_theme") || "system"; } catch { return "system"; } };
const systemLight = matchMedia("(prefers-color-scheme: light)");
function applyTheme(pref = themePref()) {
  document.documentElement.dataset.theme = pref === "system" ? (systemLight.matches ? "wave-light" : "wave") : pref;
  const meta = $('meta[name="theme-color"]'); if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (liveTerm) { liveTerm.term.options.theme = termTheme(); if (liveTerm.hist) liveTerm.hist.body.style.setProperty("--hist-bg", termTheme().background); }
}
systemLight.addEventListener("change", () => themePref() === "system" && applyTheme());
// ---------------------------------------------------------------- run targets (Settings)
const loadTargets = guard(async () => {
  const r = await get("/targets");
  targets = r.targets;
  $("#target-table tbody").replaceChildren(...targets.map((t) => h("tr", {},
    h("td", { class: "full" }, h("b", {}, t.name), h("div", { class: "muted wf-sub" }, "E2B sandbox")),
    h("td", { "data-l": "when idle" }, t.config.idle_sec ? `${t.config.idle_sec}s → ${t.config.idle_action}` : h("span", { class: "muted" }, "never")),
    h("td", { class: "mono trunc", "data-l": "template", title: t.config.template }, t.config.template, t.config.repo ? h("div", { class: "muted wf-sub", title: t.config.repo }, `+ ${t.config.repo}`) : ""),
    h("td", { "data-l": "used by" }, t.workflows ? `${t.workflows} workflow${t.workflows === 1 ? "" : "s"}` : h("span", { class: "muted" }, "–")),
    h("td", { class: "row" },
      h("button", { class: "small", onclick: () => checkTarget(t.name) }, "Check"),
      h("button", { class: "small", onclick: () => openTargetDialog(t) }, "Edit"),
      h("button", { class: "small danger", onclick: () => confirmDo(`Delete target "${t.name}"?`, async () => { await del(`/targets/${encodeURIComponent(t.name)}`); toast("deleted", true); loadTargets(); }) }, "Delete"),
    ),
  )));
  if (!targets.length) $("#target-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted empty" }, r.e2b_key ? "No targets yet. Sessions and workflows run on this machine." : "No targets yet. E2B targets need E2B_API_KEY in lofiwave's environment.")));
});
const checkTarget = (name) => guard(async () => {
  const c = await post(`/targets/${encodeURIComponent(name)}/check`);
  toast(c.ok ? `${name}: ok (E2B key works, ${c.running} sandbox(es) running)` : `${name}: ${c.error}`, c.ok);
})();
const tdlg = $("#target-dialog"), tf = $("#target-form");
const linesOf = (map) => Object.entries(map || {}).map(([k, v]) => `${k}=${v}`).join("\n");
const TARGET_FIELDS = ["template", "repo", "permission_mode", "idle_sec", "idle_action", "workdir", "timeout_sec", "on_exit"];
function openTargetDialog(t) {
  tf.reset(); $("#target-feedback").hidden = true;
  tf.orig.value = t?.name ?? "";
  tf.elements.namedItem("name").value = t?.name ?? ""; tf.elements.namedItem("name").disabled = Boolean(t);
  $("#target-title").textContent = t ? `Edit ${t.name}` : "New E2B target";
  for (const k of TARGET_FIELDS) if (t) tf.elements.namedItem(k).value = t.config[k] ?? "";
  if (t && !t.config.idle_sec) tf.idle_sec.value = "";
  tf.env.value = linesOf(t?.config.env); tf.env_from.value = linesOf(t?.config.env_from);
  $(".more", tf).open = false;
  tdlg.showModal();
  (t ? tf.template : tf.elements.namedItem("name")).focus();
}
async function saveTarget() {
  if (!tf.reportValidity()) return null;
  $("#target-feedback").hidden = true;
  const config = {};
  for (const k of TARGET_FIELDS) { const v = tf.elements.namedItem(k).value.trim(); if (v !== "" || k === "repo" || k === "permission_mode") config[k] = /_sec$/.test(k) ? Number(v) : v; }
  if (!tf.idle_sec.value.trim()) config.idle_sec = 0;
  config.env = parseEnv(tf.env.value);
  if (tf.env_from.value.trim()) config.env_from = parseEnv(tf.env_from.value);
  const orig = tf.orig.value;
  try { return orig ? await put(`/targets/${encodeURIComponent(orig)}`, { config }) : await post("/targets", { name: tf.elements.namedItem("name").value.trim(), kind: "e2b", config }); }
  catch (e) { $("#target-feedback").textContent = e.message; $("#target-feedback").hidden = false; return null; }
}
$("#target-new-btn").onclick = () => openTargetDialog(null);
$("#target-cancel").onclick = () => tdlg.close();
tf.addEventListener("submit", async (e) => { e.preventDefault(); const t = await saveTarget(); if (t) { toast("saved", true); tdlg.close(); loadTargets(); } });
$("#target-check").onclick = async () => {
  const t = await saveTarget();
  if (!t) return;
  tf.orig.value = t.name; tf.elements.namedItem("name").disabled = true; loadTargets();
  const c = await post(`/targets/${encodeURIComponent(t.name)}/check`).catch((e) => ({ ok: false, error: e.message }));
  if (c.ok) { toast(`${t.name}: ok (E2B key works, ${c.running} sandbox(es) running)`, true); tdlg.close(); }
  else { $("#target-feedback").textContent = `Saved, but the check failed: ${c.error}`; $("#target-feedback").hidden = false; }
};

function renderSettings() {
  loadTargets();
  const pref = themePref();
  $("#theme-picker").replaceChildren(...THEMES.map((t) => h("button", { class: "theme", role: "radio", "aria-checked": String(pref === t.id), onclick: () => { try { localStorage.setItem("ac_theme", t.id); } catch {} applyTheme(t.id); renderSettings(); } },
    h("span", { class: "theme-swatch", "aria-hidden": "true" }, ...t.swatch.map((c) => h("span", { style: `background:${c}` }))),
    h("span", { class: "theme-name" }, t.name, h("small", {}, t.note)),
  )));
}

// ---------------------------------------------------------------- runs
const loadRuns = guard(async () => {
  const q = new URLSearchParams({ limit: 100 });
  for (const [k, id] of [["status", "#runs-status"], ["type", "#runs-type"], ["workflow_id", "#runs-workflow"], ["group", "#runs-group"]]) if ($(id).value) q.set(k, $(id).value);
  const [{ runs, total }, groups] = await Promise.all([get(`/runs?${q}`), get("/groups")]);
  const rg = $("#runs-group"); const cur = rg.value;
  rg.replaceChildren(h("option", { value: "" }, "All groups"), ...groups.map((g) => h("option", { value: g.group }, `${g.group} (${g.total})`)));
  if (cur && !groups.some((g) => g.group === cur)) rg.append(h("option", { value: cur }, cur));
  rg.value = cur; rg.hidden = !groups.length && !cur;
  $("#runs-count").textContent = `${total} run${total === 1 ? "" : "s"}`;
  $("#runs-table tbody").replaceChildren(...runs.map((r) => h("tr", { class: `clickable ${selectedRun?.id === r.id ? "selected" : ""}`, tabindex: "0", "aria-label": `Open run ${r.id}, ${r.workflow_name || r.type_name}, ${r.status}`, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRun(r.id); } }, onclick: () => openRun(r.id) },
    h("td", { class: "mono" }, "#", r.id),
    h("td", { class: "full" }, r.workflow_name ? h("b", {}, r.workflow_name) : h("span", { class: "muted" }, "ad-hoc"), h("div", { class: "muted", style: "font-size:12px" }, groupTag(r), `${r.type_name} · ${shortCwd(r.cwd)}`)),
    h("td", { "data-l": "trigger" }, r.trigger, r.meta?.started_by ? h("div", { class: "by", style: "font-size:12px" }, r.meta.started_by) : ""),
    h("td", { class: "status" }, badge(r.status)),
    h("td", { "data-l": "started", title: new Date(r.started_at).toLocaleString() }, fmtRel(r.started_at)),
    h("td", { "data-l": "took" }, fmtDur(r.duration_ms / 1000)),
    h("td", { class: "mono", "data-l": "exit" }, r.exit_code ?? "–"),
  )));
  if (!runs.length) $("#runs-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "muted" }, "No runs match.")));
});
["#runs-status", "#runs-type", "#runs-workflow", "#runs-group"].forEach((id) => ($(id).onchange = loadRuns));

async function openRun(id) {
  switchTab("runs", false);
  history.replaceState(null, "", `#runs/${id}`);
  selectedRun = { id }; logOffset = 0;
  $("#run-detail").hidden = false; $(".split").classList.add("open"); document.body.classList.add("run-open");
  $("#run-detail").replaceChildren(h("h3", {}, "Loading run…", h("button", { class: "small", "aria-label": "Close run details", onclick: closeRun }, "✕")));
  $("#run-detail").focus({ preventScroll: true });
  await refreshRunDetail(true);
  loadRuns();
}
function closeRun(updateHash = true) { selectedRun = null; $("#run-detail").hidden = true; $(".split").classList.remove("open"); document.body.classList.remove("run-open"); if (updateHash) history.replaceState(null, "", location.pathname); loadRuns(); $("#runs-status").focus({ preventScroll: true }); }

const refreshRunDetail = guard(async (full = false) => {
  if (!selectedRun) return;
  const id = selectedRun.id;
  const r = await get(`/runs/${id}`);
  if (!selectedRun || selectedRun.id !== id) return;
  const sig = (x) => JSON.stringify((x.sessions || []).map((s) => [s.session_id, s.title, s.name, s.status, s.web_url, s.ended_at]));
  const changed = full || r.status !== selectedRun.status || (r.meta?.remote_url && !selectedRun.meta?.remote_url) || sig(r) !== sig(selectedRun);
  selectedRun = r;
  if (changed || !$("#run-log")) {
    $("#run-detail").replaceChildren(
      h("h3", {}, `Run #${r.id}`, badge(r.status), h("span", { class: "muted", style: "font-weight:400;font-size:13px" }, r.workflow_name ? `workflow ${r.workflow_name}` : "ad-hoc"), h("span", { style: "margin-left:auto" }), h("button", { class: "small", "aria-label": "Close run details", onclick: closeRun }, "✕")),
      h("details", { class: "meta", open: false },
        h("summary", { class: "muted" }, `${r.type_name} · ${shortCwd(r.cwd)} · ${r.trigger} · ${fmtRel(r.started_at)}${r.meta?.remote_url ? " · " : ""}`, r.meta?.remote_url ? h("a", { href: r.meta.remote_url, target: "_blank", onclick: (e) => e.stopPropagation() }, "open on web ↗") : ""),
      h("dl", {},
        h("dt", {}, "type"), h("dd", {}, r.type_name),
        r.meta?.target ? h("dt", {}, "target") : "", r.meta?.target ? h("dd", {}, `${r.meta.target} (E2B)`, r.meta.e2b?.sandbox_id ? h("span", { class: "muted" }, `  sandbox ${r.meta.e2b.sandbox_id}${r.meta.e2b.paused ? " (paused while idle)" : ""}${r.meta.e2b.out_files ? ` · ${r.meta.e2b.out_files} file(s) from out/ in ${r.meta.e2b.out_dir}` : ""}`) : h("span", { class: "muted" }, "  (starting the sandbox…)")) : "",
        h("dt", {}, "cwd"), h("dd", {}, r.cwd),
        h("dt", {}, "command"), h("dd", {}, quoteArgs([r.command, ...r.args])),
        r.prompt ? h("dt", {}, "prompt") : "", r.prompt ? h("dd", { style: "white-space:pre-wrap" }, r.prompt) : "",
        h("dt", {}, "trigger"), h("dd", {}, r.trigger, r.meta?.started_by ? ` by ${r.meta.started_by}` : ""),
        r.group || r.parent_run ? h("dt", {}, "group") : "",
        r.group || r.parent_run ? h("dd", {}, groupTag(r), r.parent_run ? h("a", { class: "link", href: `#runs/${r.parent_run}`, onclick: (e) => { e.preventDefault(); openRun(r.parent_run); } }, `started by run #${r.parent_run}`) : "") : "",
        r.out_dir ? h("dt", {}, "results") : "", r.out_dir ? h("dd", { class: "mono" }, r.out_dir, h("span", { class: "muted" }, "  (GET /api/runs/", String(r.id), "/results)")) : "",
        h("dt", {}, "pid"), h("dd", {}, r.pid ?? "–", r.meta?.orphan ? " (started by a previous console instance)" : ""),
        r.meta?.remote_url ? h("dt", {}, "remote") : "", r.meta?.remote_url ? h("dd", {}, h("a", { href: r.meta.remote_url, target: "_blank" }, r.meta.remote_url), h("span", { class: "muted" }, "  (same session in the Claude app)")) : "",
        r.meta?.tmux ? h("dt", {}, "terminal") : "", r.meta?.tmux ? h("dd", {}, `tmux attach -t ${r.meta.tmux}`, r.status === "running" ? h("span", { class: "muted" }, "  (live screen below)") : h("span", { class: "muted" }, "  (ended; screen saved in the log)")) : "",
        r.meta?.tmux && (r.meta.terminal || r.meta.terminal_error) ? h("dt", {}, "window") : "",
        r.meta?.tmux && (r.meta.terminal || r.meta.terminal_error)
          ? h("dd", {}, r.meta.terminal ? `opened in ${r.meta.terminal} on this machine` : h("span", { class: "muted" }, `no window opened — ${r.meta.terminal_error}`))
          : "",
        h("dt", {}, "started"), h("dd", {}, new Date(r.started_at).toLocaleString()),
        h("dt", {}, "ended"), h("dd", {}, r.ended_at ? new Date(r.ended_at).toLocaleString() : "–"),
        h("dt", {}, "duration"), h("dd", {}, fmtDur(r.duration_ms / 1000)),
        h("dt", {}, "exit code"), h("dd", {}, r.exit_code ?? "–"),
        r.meta?.timeout_sec ? h("dt", {}, "timeout") : "", r.meta?.timeout_sec ? h("dd", {}, `${r.meta.timeout_sec}s`) : "",
        Object.keys(r.env || {}).length ? h("dt", {}, "env") : "", Object.keys(r.env || {}).length ? h("dd", {}, envText(r.env)) : "",
        r.error ? h("dt", {}, "error") : "", r.error ? h("dd", { style: "color:var(--bad)" }, r.error) : "",
      )),
      sessionsBlock(r),
      h("div", { class: "row" },
        r.status === "running" ? h("button", { class: "small danger", onclick: () => confirmDo(`Stop run #${r.id}?`, async () => { await post(`/runs/${r.id}/kill`); toast("stopped", true); refreshRunDetail(true); }) }, "Stop") : "",
        r.status === "running" ? h("button", { class: "small danger", onclick: () => confirmDo(`Force kill run #${r.id}?`, async () => { await post(`/runs/${r.id}/kill?force=1`); toast("killed", true); refreshRunDetail(true); }) }, "Kill") : "",
        h("button", { class: "small", onclick: () => guard(async () => { const n = await post(`/runs/${r.id}/restart`); toast(`restarted as run #${n.id}`, true); openRun(n.id); })() }, r.status === "running" ? "Restart" : "Run again"),
        h("a", { href: `/api/runs/${r.id}/log?raw=1${token ? `&token=${encodeURIComponent(token)}` : ""}`, target: "_blank" }, h("button", { class: "small" }, "Raw log")),
        r.status !== "running" ? h("button", { class: "small danger", onclick: () => confirmDo(`Delete run #${r.id} and its log?`, async () => { await del(`/runs/${r.id}`); toast("deleted", true); closeRun(); }) }, "Delete") : "",
        h("label", { class: "muted", style: "margin-left:auto;font-size:12px" }, h("input", { type: "checkbox", id: "autoscroll", checked: true }), " follow"),
      ),
      h("pre", { id: "run-log", class: r.meta?.interactive && r.status === "running" ? "screen" : "" }, ""),
      r.meta?.interactive && r.status === "running" ? keysForm(r.id, pollScreen) : "",
    );
    logOffset = 0;
  }
  if (r.meta?.interactive && r.status === "running") await pollScreen(); else await pollLog();
});

/** How many terminal columns fit in the screen box, so the server can resize the tmux window to the viewer. */
function screenCols(pre) {
  const probe = h("span", { style: "position:absolute;visibility:hidden;white-space:pre;font:inherit" }, "MMMMMMMMMM");
  pre.appendChild(probe); const cw = probe.getBoundingClientRect().width / 10; probe.remove();
  return Math.max(40, Math.min(220, Math.floor((pre.clientWidth - 22) / cw)));
}
/** Paint an interactive run's tmux pane into `pre`. Shared by the console pane and the run detail. */
async function pollScreenInto(pre, runId, follow = true) {
  if (!pre?.isConnected) return;
  const { text } = await get(`/runs/${runId}/screen?lines=300&cols=${screenCols(pre)}`);
  if (pre.textContent !== text) { pre.textContent = text; if (follow) pre.scrollTop = pre.scrollHeight; }
}
const pollScreen = () => (selectedRun ? pollScreenInto($("#run-log"), selectedRun.id, $("#autoscroll")?.checked !== false) : undefined);

/** The "type into the terminal" row: a text field plus the keys a TUI needs that a text field can't send. */
function keysForm(runId, after) {
  const send = guard(async (payload) => { await post(`/runs/${runId}/keys`, payload); setTimeout(after, 250); });
  const form = h("form", { class: "row keys", onsubmit: (e) => { e.preventDefault(); const text = form.elements.text.value; form.elements.text.value = ""; send({ text, enter: true }); } },
    h("input", { name: "text", placeholder: "type into the terminal… (Enter sends it)", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }),
    h("button", { type: "submit", class: "small primary" }, "Send"),
    h("button", { type: "button", class: "small", title: "send a bare Enter (confirm a dialog)", onclick: () => send({ text: "", enter: true }) }, "⏎"),
    h("button", { type: "button", class: "small", title: "send Escape", onclick: () => send({ keys: ["Escape"], enter: false }) }, "Esc"),
    h("button", { type: "button", class: "small", title: "send Tab", onclick: () => send({ keys: ["Tab"], enter: false }) }, "⇥"),
    h("button", { type: "button", class: "small", title: "arrow up", onclick: () => send({ keys: ["Up"], enter: false }) }, "↑"),
    h("button", { type: "button", class: "small", title: "arrow down", onclick: () => send({ keys: ["Down"], enter: false }) }, "↓"),
    h("button", { type: "button", class: "small", title: "send Ctrl-C", onclick: () => send({ keys: ["C-c"], enter: false }) }, "^C"),
  );
  return form;
}

// Agent sessions on this run (from the claude hook, codex's rollout file, and the agents' own state): name, title, links, resume.
function sessionsBlock(r) {
  const list = r.sessions || [];
  if (!list.length) return "";
  const tokenQ = token ? `?token=${encodeURIComponent(token)}` : "";
  return h("div", { class: "sessions" },
    h("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" }, list.length === 1 ? "session" : `${list.length} sessions`),
    ...list.map((s) => {
      const live = r.status === "running" && !s.ended_at;
      const label = s.title || s.name || "(untitled)";
      return h("div", { class: "session" },
        h("div", { style: "flex:1;min-width:0" },
          h("div", {}, s.status ? h("span", { class: `dot ${s.status}`, title: s.status }) : "", h("b", {}, label), s.name && s.title ? h("span", { class: "muted" }, ` · ${s.name}`) : ""),
          h("div", { class: "muted", style: "font-size:11.5px" },
            h("code", { class: "mono", title: s.transcript_path || "" }, s.session_id),
            ` · ${s.agent}${s.model ? ` · ${s.model}` : ""}${s.source && s.source !== "startup" ? ` · ${s.source}` : ""} · ${fmtRel(s.started_at)}${s.ended_at ? ` → ${fmtDur((s.ended_at - s.started_at) / 1000)}${s.end_reason ? ` (${s.end_reason})` : ""}` : live ? " · live" : ""}`,
          ),
        ),
        h("span", { class: "row", style: "gap:6px;flex-wrap:wrap" },
          s.web_url ? h("a", { href: s.web_url, target: "_blank" }, h("button", { class: "small" }, "Open on web")) : "",
          !live ? h("button", { class: "small primary", title: `${s.resume_cmd} — in a tmux session here, with the type's resume args (claude: --remote-control)`, onclick: () => {
            const go = guard(async () => { const n = await post(`/runs/${r.id}/sessions/${encodeURIComponent(s.session_id)}/resume`); toast(`resumed as run #${n.id}`, true); openRun(n.id); });
            // The conversation came back from the sandbox; the files it changed did not (only out/ does).
            if (s.source === "e2b") confirmDo(`This conversation ran in a sandbox on ${r.meta?.target || "a target"}. It continues here in ${s.cwd}, but files the agent changed there are gone unless it pushed them or left them in out/: pull or check out its branch first.\n\nResume it?`, go);
            else go();
          } }, "Resume here") : "",
          h("button", { class: "small", title: s.resume_cmd, onclick: () => navigator.clipboard?.writeText(s.resume_cmd).then(() => toast("copied: " + s.resume_cmd, true)) }, "Copy resume"),
          s.transcript_path ? h("a", { href: `/api/runs/${r.id}/sessions/${encodeURIComponent(s.session_id)}/transcript${tokenQ}`, target: "_blank" }, h("button", { class: "small" }, "Transcript")) : "",
        ),
      );
    }),
  );
}

async function pollLog() {
  if (!selectedRun) return;
  const pre = $("#run-log"); if (!pre) return;
  const { data, offset, size } = await get(`/runs/${selectedRun.id}/log?offset=${logOffset}`);
  if (size < logOffset) { pre.textContent = ""; logOffset = 0; return pollLog(); }
  if (data) { pre.append(data); logOffset = offset; if ($("#autoscroll")?.checked) pre.scrollTop = pre.scrollHeight; }
}

// ---------------------------------------------------------------- console (session-first working view)
/** The session a run is currently on — the newest one, since a resume/compact adds another. */
const sessOf = (r) => (r.sessions || []).at(-1) || null;
/** What to call a run in the UI: the agent's own session title, else its first prompt line, else the run. */
function runLabel(r) {
  const s = sessOf(r);
  return s?.title || s?.name || (r.prompt || "").split("\n")[0].slice(0, 70) || `${r.type_name} run #${r.id}`;
}
function selectConsoleRunId(id) { localStorage.setItem("ac_console_run", String(id)); consoleRun = null; railSig = paneSig = ""; }
/** The session a #sessions/<id> link asked for, until the console has loaded and either shown it or found it ended. */
let linkedRun = null;
/** Keep the selected session in the address bar, so the link can be shared. */
function syncConsoleHash() {
  if (activeTab !== "console") return;
  const r = consoleView === "ended" ? endedRun : consoleRun;
  const want = r ? `#sessions/${r.id}` : "";
  if (location.hash !== want) history.replaceState(null, "", location.pathname + want);
}
/** Open a session from a link: its terminal if it is still live, else its run in the history. */
function openSessionLink(id) {
  linkedRun = id;
  selectConsoleRunId(id);
  switchTab("console", false);
}

const loadConsole = guard(async () => {
  consoleData = await get("/console");
  consoleData.live = pinnedFirst(consoleData.live);
  consoleData.ended = pinnedFirst(consoleData.ended);
  const { live, ended } = consoleData;
  noteMeter(live);
  $("#drawer-btn").classList.toggle("alert", live.some((r) => actOf(r) === "waiting_input"));
  if (linkedRun) {
    const id = linkedRun; linkedRun = null;
    if (live.some((r) => r.id === id)) setConsoleView("live", false);
    else if (ended.some((r) => r.id === id)) { setConsoleView("ended", false); endedRun = ended.find((r) => r.id === id); }
    else { toast(`session #${id} isn't live; showing its run`, true); return openRun(id); }
  }
  endedRun = ended.find((r) => r.id === endedRun?.id) || ended[0] || null;
  // Keep the selected session if it is still live; otherwise the one we last used, else the newest.
  const remembered = Number(localStorage.getItem("ac_console_run") || 0);
  consoleRun = live.find((r) => r.id === consoleRun?.id) || live.find((r) => r.id === remembered) || live[0] || null;
  if (consoleRun) localStorage.setItem("ac_console_run", String(consoleRun.id));
  syncConsoleHash();
  renderRail();
  renderPane();
});
/** On the other pages only the session list needs the console's data: refresh it while the list is open. */
const drawerShown = () => document.body.classList.contains("drawer-open");

function selectConsoleRun(run) {
  drawerPicked();
  if (activeTab !== "console") { consoleRun = run; paneSig = ""; localStorage.setItem("ac_console_run", String(run.id)); return switchTab("console"); }
  if (run.id === consoleRun?.id) return;
  consoleRun = run; paneSig = "";
  localStorage.setItem("ac_console_run", String(run.id));
  syncConsoleHash();
  patchRail(); renderPane();
}

function setConsoleView(view, render = true) {
  if (view === consoleView) return;
  consoleView = view;
  localStorage.setItem("ac_console_view", view);
  railSig = paneSig = "";
  if (render) { syncConsoleHash(); renderRail(); renderPane(); }
}
function selectEndedRun(run) {
  drawerPicked();
  if (activeTab !== "console") { endedRun = run; railSig = paneSig = ""; return switchTab("console"); }
  if (run.id === endedRun?.id) return;
  endedRun = run; railSig = "";
  syncConsoleHash(); renderRail(); renderPane();
}

/** The Live / Ended switch at the top of the rail. */
function railTabs() {
  const tab = (view, label, n) => h("button", { role: "tab", class: consoleView === view ? "active" : "", "aria-selected": String(consoleView === view), onclick: () => setConsoleView(view) }, `${label} ${n}`);
  return h("div", { class: "subnav rail-tabs", role: "tablist", "aria-label": "Sessions" }, tab("live", "Live", consoleData.live.length), tab("ended", "Ended", consoleData.ended.length));
}
/** The drawer's top row: close, Live / Ended, and Resume. */
const railBar = () => h("div", { class: "rail-bar" },
  h("button", { class: "drawer-x", "aria-label": "Close the session list", onclick: () => setDrawer(false) }, "×"),
  railTabs(),
  h("button", { class: "small rail-resume", title: "Reopen a claude or codex session from its id", onclick: openResumeDialog }, "Resume"));

// ---------------------------------------------------------------- the session drawer
// The session list opens from the left with ☰. On a wide screen it docks beside the session and stays open while you
// work (remembered per browser, open the first time); on a phone it slides over the session and closes when you pick
// one, tap outside or press Esc.
const docked = matchMedia("(min-width: 900px)");
const dockedPref = () => { try { return localStorage.getItem("ac_drawer") !== "0"; } catch { return true; } };
function setDrawer(open, remember = true) {
  document.body.classList.toggle("drawer-open", open);
  $("#drawer-btn").setAttribute("aria-expanded", String(open));
  $("#drawer-backdrop").hidden = !open || docked.matches;
  if (docked.matches) { if (remember) try { localStorage.setItem("ac_drawer", open ? "1" : "0"); } catch {} }
  else if (open) ($("#session-rail .rail-item.active") || $("#session-rail .tile-new") || $("#session-rail button"))?.focus({ preventScroll: true });
}
/** After picking something in the list: a docked list stays, one over the session gets out of the way. */
const drawerPicked = () => { if (!docked.matches) setDrawer(false); };
$("#drawer-btn").onclick = () => { const open = !drawerShown(); setDrawer(open); if (open && activeTab !== "console") loadConsole(); };
$("#drawer-backdrop").onclick = () => setDrawer(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !docked.matches && document.body.classList.contains("drawer-open") && !$("dialog[open]")) { setDrawer(false); $("#drawer-btn").focus(); } });
docked.addEventListener("change", () => setDrawer(docked.matches && dockedPref(), false));
setDrawer(docked.matches && dockedPref(), false);

/** Pinned runs first, in the order they were pinned; the rest keep the server's order (newest first). */
const pinnedFirst = (runs) => [...runs.filter((r) => r.pinned_at).sort((a, b) => a.pinned_at - b.pinned_at), ...runs.filter((r) => !r.pinned_at)];
const setPinned = (r, pinned) => guard(async () => {
  await post(`/runs/${r.id}/pin`, { pinned });
  railSig = "";
  await loadConsole();
})();
/** A rail card with its pin toggle beside it (a button can't hold another button). */
function pinnable(r, card) {
  const on = Boolean(r.pinned_at);
  return h("div", { class: `rail-slot ${on ? "pinned" : ""}` }, card,
    h("button", { class: "rail-pin", title: on ? "Unpin" : "Pin to the top", "aria-label": `${on ? "Unpin" : "Pin"} ${runLabel(r)}`, "aria-pressed": String(on), onclick: () => setPinned(r, !on) }));
}
/** With anything pinned, the list reads "Pinned", then the rest under `rest`; with nothing pinned, no headings. */
function pinGroups(runs, rest, item) {
  const pinned = runs.filter((r) => r.pinned_at), others = runs.filter((r) => !r.pinned_at);
  if (!pinned.length) return runs.map(item);
  return [h("div", { class: "rail-head" }, h("span", {}, "Pinned")), ...pinned.map(item),
    others.length ? h("div", { class: "rail-head" }, h("span", {}, rest)) : "", ...others.map(item)];
}

function renderRail() {
  const { live, headless, adoptable, ended } = consoleData;
  const sig = JSON.stringify([consoleView, live.map((r) => [r.id, runLabel(r), r.pinned_at]), headless.map((r) => [r.id, runLabel(r)]), adoptable.map((p) => [p.pid, p.session?.session_id || "", p.session?.web_url || "", p.live_run]), ended.map((r) => [r.id, runLabel(r), r.pinned_at]), endedRun?.id]);
  if (sig === railSig) return patchRail();
  railSig = sig;
  if (consoleView === "ended") return $("#session-rail").replaceChildren(railBar(), h("div", { class: "rail-strip" }, ...endedRail()));
  $("#session-rail").replaceChildren(railBar(), h("div", { class: "rail-strip" },
    ...pinGroups(live, "Live", (r) => pinnable(r, h("button", { class: `rail-item tile ${consoleRun?.id === r.id ? "active" : ""} ${actOf(r) === "waiting_input" ? "needs" : ""}`, "data-run": r.id, "aria-current": consoleRun?.id === r.id ? "true" : "false", onclick: () => selectConsoleRun(r) },
      h("div", { class: `tile-act ${actOf(r)}` }, h("span", { class: `dot ${actOf(r)}` }), h("span", { class: "tile-act-text" }, tileAct(r))),
      h("div", { class: "rail-title" }, runLabel(r)),
      meter(r),
      h("div", { class: "rail-sub" }, r.workflow_name ? h("span", { class: "wf-tag" }, `⌁ ${r.workflow_name}`) : "", groupTag(r), `${r.type_name} · ${shortCwd(r.cwd)}`),
      h("div", { class: "rail-sub dim rail-up" }, railUp(r)),
    ))),
    h("button", { class: "tile-new", onclick: () => { drawerPicked(); openStartDialog({ kind: "agent" }); } }, h("span", { "aria-hidden": "true" }, "+"), "Start a session"),
    headless.length ? h("div", { class: "rail-head" }, h("span", {}, `${headless.length} running · log only`)) : "",
    ...headless.map((r) => h("a", { class: "rail-item flat", href: `#runs/${r.id}`, onclick: (e) => { e.preventDefault(); openRun(r.id); } },
      h("div", { class: "rail-title" }, runLabel(r)),
      h("div", { class: "rail-sub" }, `${r.type_name} · run #${r.id} · log only`),
    )),
    adoptable.length ? h("div", { class: "rail-head" }, h("span", { title: "on this machine, but the console did not start them, so there is no pane to type into" }, `${adoptable.length} started outside the console`)) : "",
    ...adoptable.map((p) => h("div", { class: "rail-item flat" },
      h("div", { class: "rail-title" }, h("span", { class: `dot ${p.session?.status || ""}`, title: p.session?.status || "" }), p.session?.title || p.session?.name || `${p.type} · pid ${p.pid}`),
      h("div", { class: "rail-sub" }, `${p.type} · ${shortCwd(p.cwd) || "?"}`),
      h("div", { class: "rail-sub dim" }, `pid ${p.pid} · ${originOf(p)}`, p.session?.web_url ? h("a", { href: p.session.web_url, target: "_blank", style: "margin-left:8px" }, "web ↗") : ""),
      p.live_run
        ? h("div", { class: "row", style: "gap:6px" },
            h("button", { class: "small primary", title: "this conversation is already open here; this process is a second copy of it", onclick: () => selectConsoleRunId(p.live_run) }, `Open run #${p.live_run}`),
            h("button", { class: "small danger", onclick: () => confirmDo(`Stop pid ${p.pid}? The conversation stays open in run #${p.live_run}.`, async () => { await del(`/processes/${p.pid}`); toast("SIGTERM sent", true); loadConsole(); }) }, "Stop this copy"))
      : p.session?.session_id
        ? h("div", { class: "row", style: "gap:6px" },
            h("button", { class: "small", title: "stop it and reopen the conversation in a tmux pane here, so it can be driven from the browser", onclick: () => takeOver(p) }, "Take over here"),
            chatBtn(p.session),
            remoteControlBtn(p.pid, p.session, Boolean(p.session.tmux)))
        : h("div", { class: "rail-sub dim" }, "no session id — can't take over"),
    )),
  ));
}

function endedRail() {
  const { ended } = consoleData;
  if (!ended.length) return [h("div", { class: "rail-head" }, h("span", {}, "Nothing ended yet"))];
  return pinGroups(ended, "Ended", (r) => pinnable(r, h("button", { class: `rail-item tile ${endedRun?.id === r.id ? "active" : ""}`, "aria-current": endedRun?.id === r.id ? "true" : "false", onclick: () => selectEndedRun(r) },
    h("div", { class: "tile-act" }, h("span", { class: "dot" }), h("span", {}, r.status && r.status !== "success" ? r.status : "ended")),
    h("div", { class: "rail-title" }, runLabel(r)),
    h("div", { class: "rail-sub" }, r.workflow_name ? h("span", { class: "wf-tag" }, `⌁ ${r.workflow_name}`) : "", groupTag(r), `${r.type_name} · ${shortCwd(r.cwd)}${byWho(r)}`),
    h("div", { class: "rail-sub dim" }, endedWhen(r)),
  )));
}
const endedWhen = (r) => `ended ${r.ended_at ? fmtRel(r.ended_at) : "?"}` + (r.ended_at ? ` · ran ${fmtDur((r.ended_at - r.started_at) / 1000)}` : "") + (r.status && r.status !== "success" ? ` · ${r.status}` : "");

/** Start an ended session again: reopen its conversation if it has one, else rerun the same command. */
const turnBackOn = (r) => guard(async () => {
  const s = sessOf(r);
  const n = s?.session_id ? await post(`/runs/${r.id}/sessions/${encodeURIComponent(s.session_id)}/resume`) : await post(`/runs/${r.id}/restart`);
  if (r.pinned_at) { await post(`/runs/${n.id}/pin`, { pinned: true }); await post(`/runs/${r.id}/pin`, { pinned: false }); }
  toast(`back on as run #${n.id}`, true);
  selectConsoleRunId(n.id);
  setConsoleView("live", false);
  await loadConsole();
})();

/** An ended session, read-only: its conversation from the transcript, else the terminal log saved when it stopped. */
function endedPaneFor(r) {
  const s = sessOf(r);
  const tokenQ = token ? `?token=${encodeURIComponent(token)}` : "";
  const body = h("div", { id: "ended-read", class: "chat" }, h("div", { class: "muted" }, "loading…"));
  (async () => {
    let items;
    try {
      if (!s?.transcript_path) throw new Error("no transcript");
      const msgs = await get(`/runs/${r.id}/sessions/${encodeURIComponent(s.session_id)}/messages`);
      if (!msgs.length) throw new Error("empty transcript");
      items = msgs.map((m) => h("div", { class: `msg ${m.role}`, title: m.at ? new Date(m.at).toLocaleString() : "" }, m.role === "tool" ? `→ ${m.text}` : m.text));
    } catch {
      let log = await get(`/runs/${r.id}/log`);
      if (log.size > log.offset) log = await get(`/runs/${r.id}/log?offset=${log.size - 512 * 1024}`);
      items = [h("pre", { class: "screen" }, log.data || "(nothing was saved for this session)")];
    }
    body.replaceChildren(...items);
    body.scrollTop = body.scrollHeight;
  })().catch((e) => body.replaceChildren(h("div", { class: "muted" }, e.message)));
  return [
    h("div", { class: "pane-head" },
      h("div", { class: "pane-id" },
        h("h2", {}, runLabel(r)),
        h("div", { class: "pane-meta muted" },
          `${r.type_name} · ${shortCwd(r.cwd)}${byWho(r)} · ${endedWhen(r)}`, s?.model ? ` · ${s.model}` : "",
          s?.session_id ? h("code", { class: "mono", title: s.session_id }, shortId(s.session_id)) : "",
        ),
      ),
      h("div", { class: "row pane-actions" },
        h("button", { class: "small primary", title: s?.session_id ? `${s.resume_cmd} — in a new terminal here` : "run the same command again", onclick: () => turnBackOn(r) }, "Turn back on"),
        s?.transcript_path ? h("a", { href: `/api/runs/${r.id}/sessions/${encodeURIComponent(s.session_id)}/transcript${tokenQ}`, target: "_blank" }, h("button", { class: "small" }, "Transcript")) : "",
        h("button", { class: "small", title: "the full run record: command, env, log, sessions", onclick: () => openRun(r.id) }, "Details"),
      ),
    ),
    body,
    h("div", { class: "pane-foot muted" }, "Read-only. Turn it back on to keep going."),
  ];
}

/** Where a session was launched: its tmux target if it has one, else the shell that spawned it. */
function originOf(p) {
  if (p.drivable) return "terminal here";
  if (p.session?.tmux) return `tmux ${p.session.tmux.split(":")[0]}`;
  const parent = (p.parent_cmd || "").replace(/^-/, "").split(/\s+/)[0].split("/").pop();
  return parent ? `${parent} · no terminal here` : "no terminal here";
}

/** What a live run is doing (working / idle / waiting_input), from the run itself, else its session's own status. */
const actOf = (r) => r.activity || sessOf(r)?.status || "";
const ACT_LABEL = { working: "working", idle: "idle", waiting_input: "needs you" };
/** The tile's status line: "working · 4m". */
const tileAct = (r) => (ACT_LABEL[actOf(r)] || "running") + (ACT_LABEL[r.activity] && r.activity_since ? ` · ${fmtDur((Date.now() - r.activity_since) / 1000)}` : "");
// Who started it goes here, not after the folder, where a long path would cut it off.
const railUp = (r) => `up ${fmtDur((Date.now() - r.started_at) / 1000)}${byWho(r)}` + (sessOf(r)?.model ? ` · ${sessOf(r).model.replace(/^claude-/, "")}` : "");

// ---------------------------------------------------------------- activity meter
// Each tile shows the last six minutes as twelve 30-second bars: how much of each one the run spent working (or
// waiting on you). Sampled on every refresh, in this browser only; before the page loaded, a run's current state
// is filled back to when it began (activity_since), and anything older is blank.
const METER_BUCKET = 30_000, METER_BARS = 12;
const meterLog = new Map(); // run id → Map(bucket → { n, working, waiting })
function noteMeter(runs) {
  const now = Math.floor(Date.now() / METER_BUCKET);
  for (const id of meterLog.keys()) if (!runs.some((r) => r.id === id)) meterLog.delete(id);
  for (const r of runs) {
    const act = actOf(r);
    const sample = () => ({ n: 1, working: act === "working" ? 1 : 0, waiting: act === "waiting_input" ? 1 : 0 });
    let log = meterLog.get(r.id);
    if (!log) {
      log = new Map(); meterLog.set(r.id, log);
      if (r.activity_since) for (let k = Math.max(Math.floor(r.activity_since / METER_BUCKET), now - METER_BARS + 1); k < now; k++) log.set(k, sample());
    }
    const e = log.get(now);
    if (!e) log.set(now, sample());
    else { e.n++; if (act === "working") e.working++; else if (act === "waiting_input") e.waiting++; }
    for (const k of log.keys()) if (k <= now - METER_BARS) log.delete(k);
  }
}
function meterBars(r) {
  const now = Math.floor(Date.now() / METER_BUCKET), log = meterLog.get(r.id);
  return Array.from({ length: METER_BARS }, (_, i) => {
    const e = log?.get(now - METER_BARS + 1 + i);
    if (!e) return { cls: "none", pct: 10 };
    const w = e.working / e.n, q = e.waiting / e.n;
    return { cls: q > w ? "wait" : w > 0 ? "work" : "idle", pct: Math.round(Math.max(0.14, w + q * 0.6) * 100) };
  });
}
const meter = (r) => h("span", { class: "meter", "aria-hidden": "true" }, ...meterBars(r).map((b) => h("i", { class: b.cls, style: `height:${b.pct}%` })));

/** Keep the live bits fresh (working/idle, uptime, meter) without touching the DOM structure. */
function patchRail() {
  for (const r of consoleData.live) {
    const el = $(`#session-rail [data-run="${r.id}"]`);
    if (!el) continue;
    const selected = consoleRun?.id === r.id;
    el.classList.toggle("active", selected);
    el.classList.toggle("needs", actOf(r) === "waiting_input");
    el.setAttribute("aria-current", selected ? "true" : "false");
    const act = $(".tile-act", el);
    if (act) act.className = `tile-act ${actOf(r)}`;
    const dot = $(".dot", el);
    if (dot) dot.className = `dot ${actOf(r)}`;
    const text = $(".tile-act-text", el);
    if (text) text.textContent = tileAct(r);
    const up = $(".rail-up", el);
    if (up) up.textContent = railUp(r);
    const bars = $$(".meter i", el);
    meterBars(r).forEach((b, i) => { if (bars[i]) { bars[i].className = b.cls; bars[i].style.height = `${b.pct}%`; } });
  }
}

/**
 * Reopen a session in a tmux pane we can type into. The process in these lists is still running, and a resume keeps
 * its session id, so the server stops it first (replace_pid): two agents on one transcript interleave their histories.
 */
function takeOver(p) {
  const label = p.session?.title || p.session?.name || `pid ${p.pid}`;
  if (!confirm(`Take over "${label}"?\n\nThis stops the ${p.type} running now (pid ${p.pid}) and reopens the same conversation here. Anything it is doing right now is interrupted.`)) return;
  return guard(async () => {
    toast("stopping the original and reopening here…", true);
    const r = await post("/sessions/resume", { agent: p.session.agent, session_id: p.session.session_id, cwd: p.session.cwd || p.cwd, replace_pid: p.pid });
    toast(`taking over as run #${r.id}`, true);
    selectConsoleRunId(r.id);
    await loadConsole();
  })();
}

/**
 * Turn Remote Control on for a claude session that is already running. In a tmux pane (or, on a Mac, an iTerm or
 * Terminal.app tab) the console types /remote-control into it; anywhere else there is nothing to type into, so the only
 * way is to stop it and reopen the conversation here. The server says which (409); we only ask before the reopen.
 */
function remoteControlBtn(pid, s, inPane) {
  if (!pid || s?.agent !== "claude" || s.web_url) return "";
  const title = inPane ? "type /remote-control into its terminal, so it shows up in the Claude app" : "type /remote-control into its terminal if the console can reach it, else offer to reopen it here with Remote Control on";
  return h("button", { class: "small", title, onclick: () => enableRemote(pid, s, inPane) }, "Remote Control");
}
function enableRemote(pid, s, inPane) {
  const label = s.title || s.name || `pid ${pid}`;
  return guard(async () => {
    toast("turning on Remote Control…", true);
    let r;
    try { r = await post(`/processes/${pid}/remote-control`, {}); }
    catch (e) {
      if (inPane || !/replace: true/.test(e.message)) throw e;
      if (!confirm(`"${label}" is not in a terminal the console can type into.\n\nStop it and reopen the same conversation here, with Remote Control on? Anything it is doing right now is interrupted.`)) return;
      toast("reopening with Remote Control…", true);
      r = await post(`/processes/${pid}/remote-control`, { replace: true });
    }
    if (r.run) { toast(`reopened as run #${r.run.id}`, true); selectConsoleRunId(r.run.id); switchTab("console"); loadConsole(); return; }
    toast(r.web_url ? "Remote Control is on — the session is in the Claude app" : "sent /remote-control; the web link appears once it connects", true);
    refresh();
  })();
}

function renderPane() {
  if (activeTab !== "console") return; // the list shows on every page; the session only on Sessions
  if (consoleView === "ended") {
    closeTerm(); syncFull(false);
    const sig = `ended:${endedRun?.id ?? ""}`;
    if (sig !== paneSig) {
      paneSig = sig;
      $("#session-pane").replaceChildren(...(endedRun ? endedPaneFor(endedRun) : [h("div", { class: "pane-empty" }, h("h2", {}, "No ended sessions"))]));
    }
    return;
  }
  const r = consoleRun;
  const mode = paneMode(r);
  if (!r || r.id !== liveTerm?.runId) closeTerm();
  else if (mode !== "terminal") parkTerm();
  if (!r || mode !== "chat" || liveChat?.runId !== r.id) closeChat();
  if (mode !== "terminal") syncFull(false);
  // Rebuild only when the run or its session changes: idle/working flips constantly. Everything volatile is patched in place below.
  const sig = r ? JSON.stringify([r.id, r.status, mode, r.meta?.remote_url || "", sessOf(r)?.session_id || "", sessOf(r)?.web_url || ""]) : `empty:${consoleData.live.length}:${consoleData.adoptable.length}`;
  if (sig !== paneSig) {
    paneSig = sig;
    $("#session-pane").replaceChildren(...(r ? paneFor(r) : [emptyPane()]));
  }
  if (!r) return;
  const s = sessOf(r);
  const dot = $("#pane-dot"); if (dot) { dot.className = `dot ${s?.status || ""}`; dot.title = s?.status || ""; }
  const label = $("#pane-label"); if (label && label.textContent !== runLabel(r)) label.textContent = runLabel(r);
  const up = $("#pane-up"); if (up) up.textContent = `up ${fmtDur((Date.now() - r.started_at) / 1000)}`;
  syncFull(mode === "terminal");
  if (mode === "terminal") openTerm(r.id);
  else openChat(r.id);
}

function paneFor(r) {
  const s = sessOf(r);
  const mode = paneMode(r);
  return [
    h("div", { class: "pane-head" },
      h("div", { class: "pane-id" },
        h("h2", {}, h("span", { id: "pane-dot", class: `dot ${s?.status || ""}`, title: s?.status || "" }), h("span", { id: "pane-label" }, runLabel(r))),
        s?.model ? h("span", { class: "chip mono" }, s.model.replace(/^claude-/, "")) : "",
        s?.web_url ? h("a", { class: "chip ok", href: s.web_url, target: "_blank", title: "open this session on claude.ai" }, "Remote Control ↗") : "",
        h("div", { class: "pane-meta muted" },
          `${r.type_name} · ${shortCwd(r.cwd)}${byWho(r)} · `, h("span", { id: "pane-up" }, `up ${fmtDur((Date.now() - r.started_at) / 1000)}`),
          s?.session_id ? h("code", { class: "mono", title: s.session_id }, shortId(s.session_id)) : "",
        ),
      ),
      h("div", { class: "row pane-actions" },
        viewSwitch(r, mode),
        mode === "terminal" ? h("button", { class: "small", id: "select-btn", title: "turn the mouse into a plain text selector: drag to select, it's copied when you let go; click again to give the mouse back to tmux", onclick: () => toggleSelect() }, selectLabel()) : "",
        mode === "terminal" ? h("button", { class: "small", id: "full-btn", title: "hide the top bar and session list, terminal edge to edge (Ctrl+Shift+F)", onclick: () => toggleFull() }, fullLabel()) : "",
        s?.web_url ? "" : remoteControlBtn(r.pid, s, true),
        h("button", { class: "small", title: "the full run record: command, env, log, sessions", onclick: () => openRun(r.id) }, "Details"),
        h("button", { class: "small danger", onclick: () => confirmDo(`Stop "${runLabel(r)}" (run #${r.id})?`, async () => { await post(`/runs/${r.id}/kill`); toast("stopped", true); consoleRun = null; railSig = paneSig = ""; loadConsole(); }) }, "Stop"),
      ),
    ),
    mode === "terminal" ? h("div", { id: "console-term", class: "term" }, h("span", { class: "term-status" }, "connecting…")) : h("div", { id: "console-chat" }),
    mode === "terminal" ? h("div", { class: "term-hint muted" }, copyHint()) : "",
    h("div", { class: "pane-foot muted mono" }, r.meta?.e2b ? `E2B sandbox ${r.meta.e2b.sandbox_id || "(starting…)"}${r.meta.e2b.paused ? " · paused while idle; opening the terminal resumes it" : ""}` : `tmux attach -t ${r.meta?.tmux || "?"}`),
  ];
}

// tmux has mouse mode on, so a plain drag selects inside tmux and never reaches the system clipboard. xterm.js
// bypasses tmux with Option-drag on a Mac (macOptionClickForcesSelection) and Shift-drag elsewhere; the browser
// never sees the fn key, so the Terminal.app habit doesn't work here.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function copyHint() {
  return `Copy: "Select text", then drag (or ${isMac ? "⌥" : "Shift"}-drag). Scrolling up shows history to you only; Esc returns.`;
}

// Select mode: xterm stops reporting the mouse to tmux, so a plain drag is a normal text selection. We switch
// mouse tracking off locally (never sent to tmux) and swallow tmux's attempts to turn it back on while the mode
// is on; leaving the mode restores whatever tmux last asked for.
const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015];
let selectMode = false;
const selectLabel = () => (selectMode ? "Done selecting" : "Select text");
function setMouseTracking(term, on) {
  const t = liveTerm;
  let seq = MOUSE_MODES.map((m) => `\x1b[?${m}l`).join("");
  if (on && t?.mouseModes?.size) seq += [...t.mouseModes].map((m) => `\x1b[?${m}h`).join("");
  if (t) t.localWrites++; // our own sequences must not be mistaken for tmux's requests
  term.write(seq, () => { if (t) t.localWrites--; });
}
function toggleSelect(on = !selectMode) {
  selectMode = on;
  const t = liveTerm;
  if (t) { setMouseTracking(t.term, !on); if (!on) t.term.clearSelection(); t.term.focus(); }
  const b = $("#select-btn"); if (b) { b.textContent = selectLabel(); b.classList.toggle("on", on); }
}

// ---------------------------------------------------------------- full screen (terminal only)
const fullLabel = () => (document.body.classList.contains("term-full") ? "⤡ Exit full screen" : "⤢ Full screen");
function toggleFull(on = !document.body.classList.contains("term-full")) {
  document.body.classList.toggle("term-full", on);
  try { localStorage.setItem("ac_term_full", on ? "1" : ""); } catch {}
  const b = $("#full-btn"); if (b) b.textContent = fullLabel();
  liveTerm?.term.focus();
}
// Full screen only makes sense with a terminal on screen: drop it when there isn't one, restore it when there is.
function syncFull(hasTerm) {
  let want = false; try { want = localStorage.getItem("ac_term_full") === "1"; } catch {}
  document.body.classList.toggle("term-full", hasTerm && want);
  const b = $("#full-btn"); if (b) b.textContent = fullLabel();
}

// ---------------------------------------------------------------- live terminal (xterm.js ⟷ websocket ⟷ tmux attach)
/**
 * How the pane shows a run: "chat" (the session rendered from its transcript, Claude only) or "terminal" (xterm.js on
 * the tmux pane). Saved per browser. Terminal by default, Chat on phones (no keys for Esc/Tab/arrows) where it can.
 */
function paneMode(r) {
  const saved = localStorage.getItem("ac_term_mode");
  if (saved === "chat" && chatable(r)) return "chat";
  if (saved === "terminal") return "terminal";
  return chatable(r) && matchMedia("(max-width: 700px)").matches ? "chat" : "terminal";
}
function setPaneMode(mode) { localStorage.setItem("ac_term_mode", mode); paneSig = ""; renderPane(); }
/** The chat view reads Claude Code transcripts; other agents (Codex) and plain commands get the terminal only. */
function chatable(r) {
  if (!r) return false;
  const s = sessOf(r);
  if (s) return s.agent === "claude";
  return /(^|\/)claude$/.test(typeByName(r.type_name)?.command || "");
}
function viewSwitch(r, mode) {
  const views = [["chat", "Chat", "the session as messages, tool calls and diffs, read from its transcript; scrolls on its own"], ["terminal", "Terminal", "a real terminal in the browser"]]
    .filter(([m]) => m !== "chat" || chatable(r));
  return h("div", { class: "seg", role: "group", "aria-label": "View" },
    ...views.map(([m, label, title]) => h("button", { class: `small${m === mode ? " on" : ""}`, title, "aria-pressed": String(m === mode), onclick: () => m !== mode && setPaneMode(m) }, label)));
}

/**
 * A mouse report for pointer movement with no button held. tmux treats any input as activity and sizes the shared
 * window to the most active viewer, so passing these on would let whoever merely hovers over their tab take it.
 * SGR form: ESC [ < b ; x ; y M, X10 form: ESC [ M b x y; motion = +32, no button = 3.
 */
function isBareMotion(d) {
  const sgr = d.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (sgr) return (Number(sgr[1]) & 35) === 35;
  return d.length === 6 && d.startsWith("\x1b[M") && ((d.charCodeAt(3) - 32) & 35) === 35;
}

const termTheme = () => ({ background: getComputedStyle(document.documentElement).getPropertyValue("--term-bg").trim() || "#110e14" });
/**
 * Draw with WebGL where the browser has it: the default DOM renderer rebuilds rows of spans on every redraw, which
 * is what makes a full-screen TUI feel sluggish. If the GPU context is lost, xterm falls back to the DOM renderer.
 */
function useWebgl(term) {
  if (!window.WebglAddon) return;
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {}
}
const termOptions = (extra) => ({ fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "monospace", fontSize: 13, macOptionClickForcesSelection: true, altClickMovesCursor: false, theme: termTheme(), ...extra });

// ---------------------------------------------------------------- private scrollback
// Scrolling inside tmux (copy-mode) belongs to the pane, so one viewer scrolling moved everyone's screen. Instead the
// wheel never reaches tmux: scrolling up opens a read-only snapshot of the pane's history over the live terminal, in
// this browser only. Scrolling past the bottom, Esc or clicking the bar returns to the live view; typing returns too,
// and the keys go to the session.
//
// The snapshot is plain text in a <pre> that the browser scrolls itself, not a second xterm: xterm redraws whole rows,
// so its scrolling steps a line at a time, while a native scroller follows the trackpad pixel for pixel, with momentum.

// xterm's default 16-colour palette, so the snapshot looks like the live terminal.
const ANSI16 = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];
function ansi256(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) { const v = 8 + 10 * (n - 232); return `rgb(${v},${v},${v})`; }
  const lv = [0, 95, 135, 175, 215, 255], i = n - 16;
  return `rgb(${lv[Math.floor(i / 36)]},${lv[Math.floor(i / 6) % 6]},${lv[i % 6]})`;
}
const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
/** tmux `capture-pane -e` output → HTML: SGR colours and styles become spans, any other escape is dropped. */
function ansiToHtml(text) {
  let st = {}, out = "";
  const span = (chunk) => {
    if (!chunk) return;
    let fg = st.fg, bg = st.bg;
    if (st.inverse) [fg, bg] = [bg || "var(--hist-bg)", fg || "var(--hist-fg)"];
    const css = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && "font-weight:bold", st.dim && "opacity:.6", st.italic && "font-style:italic",
      (st.underline || st.strike) && `text-decoration:${[st.underline && "underline", st.strike && "line-through"].filter(Boolean).join(" ")}`].filter(Boolean).join(";");
    out += css ? `<span style="${css}">${escHtml(chunk)}</span>` : escHtml(chunk);
  };
  const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b./g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    span(text.slice(last, m.index)); last = re.lastIndex;
    if (m[1] === undefined) continue;
    const p = m[1].split(/[;:]/).map((x) => Number(x) || 0);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) st = {};
      else if (c === 1) st.bold = true; else if (c === 2) st.dim = true; else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true; else if (c === 7) st.inverse = true; else if (c === 9) st.strike = true;
      else if (c === 22) st.bold = st.dim = false; else if (c === 23) st.italic = false; else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false; else if (c === 29) st.strike = false;
      else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30]; else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 82];
      else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40]; else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 92];
      else if (c === 39) st.fg = null; else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        let col = null;
        if (p[i + 1] === 5) { col = ansi256(p[i + 2] & 255); i += 2; }
        else if (p[i + 1] === 2) { col = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
        st[c === 38 ? "fg" : "bg"] = col;
      }
    }
  }
  span(text.slice(last));
  return out;
}

// The snapshot is fetched as soon as the pointer comes over the terminal, so the first wheel tick opens it at once.
// It's only used while fresh; an older one is fetched again.
const HIST_FRESH_MS = 4000;
function fetchHistory(t) {
  if (t.histReq && Date.now() - t.histReq.at < HIST_FRESH_MS) return t.histReq.p;
  const p = api("GET", `/runs/${t.runId}/history`);
  t.histReq = { at: Date.now(), p };
  p.catch(() => { if (t.histReq?.p === p) t.histReq = null; });
  return p;
}

/** Keys typed in the history view, as the bytes xterm would have sent; null for keys that only close it. */
function keyBytes(e) {
  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const c = e.key.toUpperCase().charCodeAt(0);
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : null;
  }
  const named = { Enter: "\r", Backspace: "\x7f", Tab: "\t", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };
  if (named[e.key]) return named[e.key];
  return e.key.length === 1 ? (e.altKey ? "\x1b" : "") + e.key : null;
}

async function openHistory(t, lines) {
  if (t.hist) return;
  t.histLines = (t.histLoading ? t.histLines : 0) + lines; // keep counting while the snapshot loads
  if (t.histLoading) return;
  t.histLoading = true;
  let text, own_scroll;
  try { ({ text, own_scroll } = await fetchHistory(t)); }
  catch (e) { toast(`couldn't load the history: ${e.message}`); return; }
  finally { t.histLoading = false; }
  t.histReq = null; // a snapshot is shown once; the next one is fetched fresh
  if (t.closed || liveTerm !== t || t.hist) return;
  // Nothing to snapshot: the app draws full-screen and keeps its own history, so the wheel goes to it (shared, as before).
  if (own_scroll) { t.ownScroll = true; return; }
  const lineH = t.term.element ? t.term.element.clientHeight / t.term.rows : 16;
  const fg = t.term.options.theme?.foreground || "#ffffff";
  const body = h("pre", { class: "term-history-body", tabindex: "0" });
  body.style.cssText = `font-family:${t.term.options.fontFamily};font-size:${t.term.options.fontSize}px;line-height:${lineH}px;--hist-fg:${fg};--hist-bg:${termTheme().background}`;
  body.innerHTML = ansiToHtml(text);
  const box = h("div", { class: "term-history" },
    h("div", { class: "term-history-bar", title: "back to the live screen", onclick: () => closeHistory(t) }, "Scrolled back · only you see this · snapshot, the session keeps running · scroll down or Esc to return"),
    body);
  t.el.append(box);
  body.scrollTop = body.scrollHeight - body.clientHeight - t.histLines * lineH;
  t.hist = { box, body, lineH, overscroll: 0 };
  body.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeHistory(t); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) { e.preventDefault(); toggleFull(); return; }
    if (e.metaKey || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return; // ⌘C copies, modifiers alone do nothing
    if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) return; // these scroll the snapshot
    e.preventDefault();
    const d = keyBytes(e);
    closeHistory(t);
    if (d && t.ws?.readyState === 1) t.ws.send(JSON.stringify({ t: "i", d }));
  });
  body.addEventListener("paste", (e) => {
    const d = e.clipboardData?.getData("text");
    e.preventDefault(); closeHistory(t);
    if (d && t.ws?.readyState === 1) t.ws.send(JSON.stringify({ t: "i", d }));
  });
  body.focus({ preventScroll: true });
}
function closeHistory(t) {
  if (!t.hist) return;
  const { box } = t.hist; t.hist = null;
  box.remove();
  if (!t.closed) t.term.focus();
}
/**
 * Capture-phase wheel handler on the terminal box. The wheel never reaches tmux: on the live terminal, scrolling up
 * opens the private history. In the history the browser does the scrolling; we only watch for scrolling down at the
 * bottom, which closes it. A session that scrolls itself (a full-screen app with no tmux history) gets the wheel as
 * mouse reports, as many as the movement is worth: xterm would send at most one per wheel event, which crawls.
 */
function onTermWheel(t, e) {
  if (t.ownScroll && !t.mouseModes?.size) return; // nothing is listening for the mouse: leave it to xterm
  const px = t.term.element ? t.term.element.clientHeight / t.term.rows : 16; // one line, in pixels
  const dy = e.deltaMode === 1 ? e.deltaY * px : e.deltaMode === 2 ? e.deltaY * t.term.element.clientHeight : e.deltaY;
  if (t.hist) {
    const b = t.hist.body;
    const atBottom = b.scrollTop >= b.scrollHeight - b.clientHeight - 1;
    if (dy < 0 || !atBottom) { t.hist.overscroll = 0; return; } // native scroll
    e.preventDefault();
    if ((t.hist.overscroll += dy) >= 2 * px) closeHistory(t);
    return;
  }
  e.preventDefault(); e.stopPropagation();
  t.wheelAcc = !t.ownScroll && dy > 0 ? 0 : (t.wheelAcc || 0) + dy / px;
  const lines = Math.trunc(t.wheelAcc);
  if (!lines) return;
  t.wheelAcc -= lines;
  if (t.ownScroll) return sendWheel(t, e, lines);
  openHistory(t, -lines);
}

/**
 * Wheel reports (button 64 up, 65 down) at the pointer, in the encoding tmux asked for (SGR, else X10). They go out one
 * at a time, 12 ms apart: a burst in one write reaches the app as a single wheel step. Turning the other way, or a
 * long fling, never queues more than 60.
 */
function sendWheel(t, e, lines) {
  const box = t.term.element.getBoundingClientRect();
  t.wheelAt = [Math.min(t.term.cols, Math.max(1, Math.floor((e.clientX - box.left) / (box.width / t.term.cols)) + 1)),
    Math.min(t.term.rows, Math.max(1, Math.floor((e.clientY - box.top) / (box.height / t.term.rows)) + 1))];
  t.wheelQueue = Math.sign(t.wheelQueue || 0) === -Math.sign(lines) ? lines : Math.max(-60, Math.min(60, (t.wheelQueue || 0) + lines));
  if (t.wheelTimer) return;
  const step = () => {
    if (!t.wheelQueue || t.closed || t.ws?.readyState !== 1) { t.wheelQueue = 0; t.wheelTimer = null; return; }
    const b = t.wheelQueue < 0 ? 64 : 65, [col, row] = t.wheelAt;
    t.ws.send(JSON.stringify({ t: "i", d: t.mouseModes.has(1006) ? `\x1b[<${b};${col};${row}M` : `\x1b[M${String.fromCharCode(32 + b, 32 + col, 32 + row)}` }));
    t.wheelQueue -= Math.sign(t.wheelQueue);
    t.wheelTimer = setTimeout(step, 12);
  };
  step();
}

let liveTerm = null; // { runId, el, term, fit, ws, ro, retry, closed, hist }
function closeTerm() {
  if (!liveTerm) return;
  const t = liveTerm; liveTerm = null;
  closeHistory(t);
  t.closed = true; clearTimeout(t.retry); clearTimeout(t.parkTimer); t.ro?.disconnect();
  t.el.remove();
  paneSig = ""; // the pane lost its terminal: rebuild it next time
  try { t.ws?.close(); } catch {}
  t.term.dispose();
}
/**
 * Switching to another view keeps the terminal attached, out of sight, for a minute, so flipping back is instant.
 * A parked terminal sends nothing: no resizes (with window-size latest a hidden tab would resize the pane for
 * everyone), and no input.
 */
function parkTerm() {
  const t = liveTerm;
  if (!t || t.parked) return;
  t.parked = true;
  $("#term-park").append(t.el);
  t.parkTimer = setTimeout(() => { if (liveTerm === t && t.parked) closeTerm(); }, 60_000);
}

/** Attach the pane's #console-term to run `runId` (no-op if it already is). Reconnects while the run is live. */
function openTerm(runId) {
  const el = $("#console-term");
  if (!el) return closeTerm();
  if (liveTerm && liveTerm.runId === runId && liveTerm.el === el) return;
  if (liveTerm?.parked && liveTerm.runId === runId) {
    const t = liveTerm;
    clearTimeout(t.parkTimer); t.parked = false;
    el.replaceWith(t.el);
    try { t.fit.fit(); } catch {}
    t.term.focus();
    return;
  }
  closeTerm();
  const term = new Terminal(termOptions({ cursorBlink: true, scrollback: 5000 }));
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  useWebgl(term);
  const t = { runId, el, term, fit, ws: null, ro: null, retry: null, closed: false };
  liveTerm = t;
  const status = (msg) => { const s = $(".term-status", el); if (s) s.textContent = msg; };
  const send = (obj) => { if (t.ws?.readyState === 1) t.ws.send(JSON.stringify(obj)); };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) { e.preventDefault(); toggleFull(); return false; }
    return true;
  });
  term.onData((d) => { if (!isBareMotion(d)) send({ t: "i", d }); });
  // Remember which mouse modes tmux turned on, so leaving select mode can restore them; while selecting, swallow them.
  t.mouseModes = new Set(); t.localWrites = 0;
  const trackModes = (on) => (params) => {
    const ms = params.flat().filter((m) => MOUSE_MODES.includes(m));
    if (!ms.length || t.localWrites) return false;
    ms.forEach((m) => (on ? t.mouseModes.add(m) : t.mouseModes.delete(m)));
    return on && selectMode; // true = handled (dropped) while in select mode
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackModes(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackModes(false));
  if (selectMode) setMouseTracking(term, false);
  el.addEventListener("wheel", (e) => onTermWheel(t, e), { capture: true, passive: false });
  el.addEventListener("pointerenter", () => { if (!t.ownScroll && !t.hist) fetchHistory(t).catch(() => {}); });
  // Copy on select: the forced (Option/Shift) selection, or one in the history view, goes to the clipboard on mouse-up.
  el.addEventListener("mouseup", () => {
    const sel = t.hist ? String(getSelection() || "") : term.hasSelection() && term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).then(() => toast(`copied ${sel.length} chars`, true), () => {});
  });
  term.onResize(({ cols, rows }) => { if (!t.parked) send({ t: "r", cols, rows }); });
  t.ro = new ResizeObserver(() => { if (t.parked) return; try { fit.fit(); } catch {} });
  t.ro.observe(el);
  const connect = () => {
    if (t.closed) return;
    try { fit.fit(); } catch {}
    const q = new URLSearchParams({ cols: term.cols, rows: term.rows });
    if (token) q.set("token", token);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/runs/${runId}/tty?${q}`);
    ws.binaryType = "arraybuffer";
    t.ws = ws;
    ws.onopen = () => { status(""); term.focus(); };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = (e) => {
      if (t.closed || t.ws !== ws || document.hidden) return;
      if (e.reason === "session ended") { status("session ended"); loadConsole(); return; }
      status("disconnected · reconnecting…");
      t.retry = setTimeout(connect, 2000);
    };
  };
  t.connect = connect;
  connect();
}
// A background tab drops its terminal (it would otherwise keep a tmux client competing for the window size) and
// reattaches when it comes back.
document.addEventListener("visibilitychange", () => {
  const t = liveTerm;
  if (!t) return;
  if (document.hidden && t.parked) closeTerm();
  else if (document.hidden) { clearTimeout(t.retry); const ws = t.ws; t.ws = null; try { ws?.close(); } catch {} }
  else if (!t.ws || t.ws.readyState > 1) t.connect();
});

// ---------------------------------------------------------------- chat view (public/chat.js)
let liveChat = null; // { runId, view }
function openChat(runId) {
  if (!liveChat || liveChat.runId !== runId) {
    closeChat();
    liveChat = { runId, view: new ChatView(`/runs/${runId}`, { onTerminal: () => setPaneMode("terminal") }) };
  }
  // A rebuilt pane has a fresh placeholder: move the live view into it.
  const el = $("#console-chat"), root = liveChat.view.root;
  if (el && el !== root) { el.replaceWith(root); root.id = "console-chat"; }
}
// The pane loses its chat with it, so it is rebuilt next time (else a new view has no placeholder to move into).
function closeChat() { if (liveChat) { liveChat.view.close(); liveChat.view.root.remove(); liveChat = null; paneSig = ""; } }

/** A session lofiwave didn't start (Agents tab, the rail's "started outside"): its chat, read-only, in a dialog. */
let dialogChat = null;
function openSessionChat(s) {
  const dlg = $("#chat-dialog");
  dialogChat?.close();
  dialogChat = new ChatView(`/sessions/${encodeURIComponent(s.session_id)}`);
  $("#chat-dialog-title").textContent = s.title || s.name || `session ${shortId(s.session_id)}`;
  $("#chat-dialog-meta").textContent = `${s.agent} · ${shortCwd(s.cwd)} · ${s.session_id}`;
  $("#chat-dialog-body").replaceChildren(dialogChat.root);
  dlg.onclose = () => { dialogChat?.close(); dialogChat = null; };
  if (!dlg.open) dlg.showModal();
}
const chatBtn = (s) => (s?.agent === "claude" && s.session_id ? h("button", { class: "small", title: "read this session's conversation (read-only)", onclick: () => openSessionChat(s) }, "View chat") : "");

function emptyPane() {
  const n = consoleData.adoptable.length;
  return h("div", { class: "pane-empty" },
    h("h2", {}, "No live sessions"),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: () => openStartDialog({ kind: "agent" }) }, "+ New session"), h("button", { onclick: openResumeDialog }, "Resume by ID")),
    n ? h("p", { class: "muted" }, `${n} running elsewhere on this machine — take one over from the list.`) : "",
  );
}

// ---------------------------------------------------------------- refresh loop
function refresh() {
  if (document.hidden) return;
  if (activeTab === "console" || drawerShown()) loadConsole();
  if (activeTab === "console") return;
  if (activeTab === "agents") loadAgents();
  else if (activeTab === "apps") loadTypes().then(loadApps);
  else if (activeTab === "workflows") loadWorkflows();
  else if (activeTab === "connect") loadConnect();
  else if (activeTab === "settings") renderSettings();
  else if (activeTab === "runs") { loadRuns(); if (selectedRun) refreshRunDetail(); }
  else if (activeTab === "types") loadTypes();
}
setInterval(refresh, 3000);
setInterval(loadSystem, 30000);
setInterval(() => !document.hidden && loadMe(), 10000);
document.addEventListener("visibilitychange", () => !document.hidden && refresh());

(async () => {
  applyTheme(); // the page head already set the scheme; this syncs theme-color
  await Promise.all([loadSystem(), loadTypes(), loadWorkflows(), loadMe(), loadTargets()]);
  const m = location.hash.match(/^#(\w+)(?:\/(\w+))?/);
  if (m && m[1] === "runs" && m[2]) openRun(Number(m[2]));
  else if (m && (m[1] === "sessions" || m[1] === "console") && /^\d+$/.test(m[2] || "")) openSessionLink(Number(m[2]));
  else if (m && m[1] === "agents" && m[2] === "start") { switchTab("console", false); openStartDialog({ kind: "agent" }); }
  else if (m && m[1] === "processes") switchTab("agents", false);
  else switchTab(m && ($(`#tab-${m[1]}`) || m[1] === "advanced") ? m[1] : "console", false);
})();

$("#refresh-btn").onclick = () => { refresh(); loadSystem(); };
$("#new-session-btn").onclick = () => openStartDialog({ kind: "agent" });
window.addEventListener("hashchange", () => {
  const [tab, id] = location.hash.slice(1).split("/");
  if (tab === "runs" && /^\d+$/.test(id || "")) openRun(Number(id));
  else if ((tab === "sessions" || tab === "console") && /^\d+$/.test(id || "")) openSessionLink(Number(id));
  else if ($(`#tab-${tab}`) || tab === "advanced") { if (selectedRun) closeRun(false); switchTab(tab, false); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && selectedRun && !$("dialog[open]")) closeRun(); });
