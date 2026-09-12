/* Agent Console UI — vanilla JS, talks to /api. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------------------------------------------------------- api client
let token = localStorage.getItem("ac_token") || "";
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
  if (res.status === 401) {
    const t = prompt("This console requires an access token (AUTH_TOKEN):");
    if (t) { token = t; localStorage.setItem("ac_token", t); return api(method, path, body); }
    throw new Error("unauthorized");
  }
  const connection = $("#connection-status");
  if (connection) { connection.textContent = res.status < 500 ? "Connected" : "Server issue"; connection.classList.toggle("online", res.status < 500); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
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
let types = [], workflows = [], selectedRun = null, logOffset = 0, activeTab = "console";
// Console (session-first working view) state.
let consoleData = { live: [], headless: [], adoptable: [] }, consoleRun = null, railSig = "", paneSig = "";
const typeByName = (n) => types.find((t) => t.name === n);

// ---------------------------------------------------------------- tabs
$$("nav button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
function switchTab(name, push = true) {
  if (name !== "runs" && selectedRun) closeRun(false);
  activeTab = name;
  const pages = {
    console: ["Console", "Your live sessions, and a terminal to talk to them."],
    agents: ["Agents", "A clear view of your active sessions and what they’re working on."],
    apps: ["Apps", "Keep your services and local tools within reach."],
    workflows: ["Workflows", "Build repeatable routines. Know exactly what runs next."],
    runs: ["Run history", "Follow live progress and pick up where you left off."],
    types: ["Process types", "Configure the tools that power your workspace."],
  };
  const page = pages[name] || pages.console;
  $("#page-title").textContent = page[0];
  $("#page-location").textContent = page[0];
  $("#page-description").textContent = page[1];
  $$("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false"));
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  // Which tab you're on is view state, not a location: only run/session deep links go in the URL, so
  // reopening the console doesn't drop you back into whatever you last inspected.
  if (push && location.hash) history.replaceState(null, "", location.pathname);
  refresh();
}

// ---------------------------------------------------------------- system info
let systemInfo = null;
const loadSystem = guard(async () => {
  const s = await get("/system");
  systemInfo = s;
  const addrs = Object.values(s.addresses).flat();
  const ts = s.tailscale;
  $("#sysinfo").replaceChildren(
    h("div", {}, h("b", {}, s.hostname), ` · ${s.platform} · bun ${s.bun} · up ${fmtDur(s.uptime_ms / 1000)}`),
    h("div", {}, ts && ts.ips?.length ? `tailscale: ${ts.dns_name || ""} ${ts.ips.filter((ip) => !ip.includes(":")).join(", ")}${ts.state === "Running" ? "" : ` (${ts.state})`}` : ts ? `tailscale: ${ts.state}` : "tailscale: not installed", addrs.length ? ` · lan: ${addrs.join(", ")}` : ""),
  );
});

/** An app's UI link as seen from this browser: {host} becomes the host the console was opened on (works over Tailscale too). */
const appUrl = (t) => (t.url ? t.url.replace("{host}", location.hostname) : "");

// ---------------------------------------------------------------- types
const loadTypes = guard(async () => {
  types = await get("/process-types");
  for (const sel of [$("#start-form [name=type]"), $("#wf-form [name=type]")]) {
    if (sel.closest("#start-dialog[open]")) continue;
    const cur = sel.value;
    sel.replaceChildren(...types.map((t) => h("option", { value: t.name }, `${t.name} (${t.kind})` + (t.available ? "" : " · not found"))));
    if (cur && typeByName(cur)) sel.value = cur;
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
$("#start-agent-btn").onclick = () => openStartDialog({ kind: "agent" });

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
function openStartDialog({ kind, type, interactive = false } = {}) {
  const sel = sf.type;
  const allowed = type ? types.filter((t) => t.name === type) : types.filter((t) => !kind || t.kind === kind);
  sel.replaceChildren(...allowed.map((t) => h("option", { value: t.name }, `${t.name}` + (t.available ? "" : " · not found"))));
  sel.disabled = allowed.length <= 1;
  sf.prompt.value = ""; sf.extra_args.value = ""; sf.timeout_sec.value = 0; sf.interactive.checked = Boolean(interactive) && Boolean(systemInfo?.tmux); $("#preview").textContent = "";
  $("#start-title").textContent = type ? `Start ${type}` : kind === "agent" ? "Start an agent" : "Start a process";
  $("#start-feedback").hidden = true;
  applyStartType();
  dlg.showModal();
  (sf.cwd.value ? sf.prompt : sf.cwd).focus();
  // Prefill the folder with the one most recently used, so a test start is a single click.
  if (!sf.cwd.value) get("/paths?limit=1").then(({ paths }) => { if (dlg.open && !sf.cwd.value && paths?.[0]) sf.cwd.value = paths[0].path; }).catch(() => {});
}
function applyStartType() {
  const t = typeByName(sf.type.value);
  const interactive = sf.interactive.checked;
  const needsPrompt = t && (t.args.some((a) => a.includes("{prompt}")) || t.command.includes("{prompt}")) && !interactive;
  sf.prompt.required = Boolean(needsPrompt);
  $("#prompt-label").hidden = t && !needsPrompt && t.kind === "app" && !interactive;
  sf.prompt.placeholder = interactive ? "Optional first message — or leave empty and drive it from the Claude app / the screen below" : "What should the agent do?";
  $("#interactive-label").style.display = systemInfo?.tmux ? "" : "none";   // .row's display:flex would override `hidden`
  $("#interactive-hint").textContent = t?.name === "claude" ? "— stays open in a tmux session and a terminal window on the machine; claude starts with Remote Control so it appears in the Claude app"
    : t?.name === "codex" ? "— opens the Codex TUI in a tmux session, and a terminal window on the machine" : "— runs in a tmux session that stays open (and a terminal window on the machine); uses the type's interactive args";
  sf.cwd.value = t?.default_cwd || sf.cwd.value;
  sf.cwd.placeholder = t?.default_cwd ? t.default_cwd : "start typing to search";
  sf.extra_args.placeholder = t?.name === "claude" ? "--permission-mode acceptEdits" : t?.name === "codex" ? "--full-auto" : "";
}
sf.type.onchange = applyStartType;
sf.interactive.onchange = applyStartType;
$("#start-cancel").onclick = () => dlg.close();
function startFormBody() {
  return { type: sf.type.value, cwd: sf.cwd.value.trim(), prompt: sf.prompt.value, extra_args: sf.extra_args.value, timeout_sec: Number(sf.timeout_sec.value || 0), interactive: sf.interactive.checked };
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

// ---------------------------------------------------------------- workflows
const loadWorkflows = guard(async () => {
  workflows = await get("/workflows");
  const rw = $("#runs-workflow"); const cur = rw.value;
  rw.replaceChildren(h("option", { value: "" }, "All workflows"), ...workflows.map((w) => h("option", { value: w.id }, w.name))); rw.value = cur;
  $("#wf-table tbody").replaceChildren(...workflows.map((w) => h("tr", {},
    h("td", { class: "full" }, h("b", {}, w.name), w.prompt ? h("div", { class: "muted trunc", style: "max-width:260px;font-size:12px", title: w.prompt }, w.prompt) : ""),
    h("td", { "data-l": "type" }, w.type_name),
    h("td", { class: "mono trunc", title: w.cwd }, shortCwd(w.cwd)),
    h("td", { class: "mono", "data-l": "cron" }, w.schedule || h("span", { class: "pill" }, "Manual only")),
    h("td", { "data-l": "next", title: fmtTime(w.next_run_at) }, w.enabled && w.schedule ? fmtRel(w.next_run_at) : "–"),
    h("td", { "data-l": "last", title: fmtTime(w.last_run_at) }, fmtRel(w.last_run_at)),
    h("td", {}, h("button", { class: `on-toggle ${w.enabled ? "on" : ""}`, role: "switch", "aria-checked": String(w.enabled), "aria-label": `Enable ${w.name}`, title: w.enabled ? "enabled" : "disabled", onclick: () => guard(async () => { await put(`/workflows/${w.id}`, { enabled: !w.enabled }); loadWorkflows(); })() })),
    h("td", { class: "row" },
      h("button", { class: "small primary", onclick: () => guard(async () => { const r = await post(`/workflows/${w.id}/run`); toast(`started run #${r.id}`, true); loadWorkflows(); })() }, "Run now"),
      h("button", { class: "small", onclick: () => { $("#runs-workflow").value = w.id; switchTab("runs"); } }, "Runs"),
      h("button", { class: "small", onclick: () => editWorkflow(w) }, "Edit"),
      h("button", { class: "small danger", onclick: () => confirmDo(`Delete workflow "${w.name}"? Past runs are kept.`, async () => { await del(`/workflows/${w.id}`); toast("deleted", true); loadWorkflows(); }) }, "Delete"),
    ),
  )));
  if (!workflows.length) $("#wf-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 8, class: "muted" }, "No workflows yet. Create one above.")));
});
function editWorkflow(w) {
  const f = $("#wf-form");
  f.elements.namedItem("id").value = w.id; f.elements.namedItem("name").value = w.name; f.type.value = w.type_name; f.cwd.value = w.cwd; f.prompt.value = w.prompt;
  f.extra_args.value = quoteArgs(w.extra_args); f.env.value = envText(w.env);
  f.schedule.value = w.schedule; f.timeout_sec.value = w.timeout_sec; f.enabled.checked = w.enabled; f.allow_overlap.checked = w.allow_overlap;
  $("#wf-panel-title").textContent = `Edit workflow: ${w.name}`; $("#wf-panel").open = true; f.elements.namedItem("name").focus();
}
function resetWfForm() { const f = $("#wf-form"); f.reset(); f.elements.namedItem("id").value = ""; $("#wf-panel-title").textContent = "New workflow"; $("#wf-panel").open = false; }
$("#wf-cancel").onclick = resetWfForm;
$("#wf-form").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.elements.namedItem("name").value.trim(), type: f.type.value, cwd: f.cwd.value.trim(), prompt: f.prompt.value, extra_args: f.extra_args.value, env: parseEnv(f.env.value), schedule: f.schedule.value.trim(), timeout_sec: Number(f.timeout_sec.value || 0), enabled: f.enabled.checked, allow_overlap: f.allow_overlap.checked };
  if (f.elements.namedItem("id").value) await put(`/workflows/${f.elements.namedItem("id").value}`, body); else await post("/workflows", body);
  toast("saved", true); resetWfForm(); loadWorkflows();
}));

// ---------------------------------------------------------------- runs
const loadRuns = guard(async () => {
  const q = new URLSearchParams({ limit: 100 });
  for (const [k, id] of [["status", "#runs-status"], ["type", "#runs-type"], ["workflow_id", "#runs-workflow"]]) if ($(id).value) q.set(k, $(id).value);
  const { runs, total } = await get(`/runs?${q}`);
  $("#runs-count").textContent = `${total} run${total === 1 ? "" : "s"}`;
  $("#runs-table tbody").replaceChildren(...runs.map((r) => h("tr", { class: `clickable ${selectedRun?.id === r.id ? "selected" : ""}`, tabindex: "0", "aria-label": `Open run ${r.id}, ${r.workflow_name || r.type_name}, ${r.status}`, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRun(r.id); } }, onclick: () => openRun(r.id) },
    h("td", { class: "mono" }, "#", r.id),
    h("td", { class: "full" }, r.workflow_name ? h("b", {}, r.workflow_name) : h("span", { class: "muted" }, "ad-hoc"), h("div", { class: "muted", style: "font-size:12px" }, `${r.type_name} · ${shortCwd(r.cwd)}`)),
    h("td", { "data-l": "trigger" }, r.trigger),
    h("td", { class: "status" }, badge(r.status)),
    h("td", { "data-l": "started", title: new Date(r.started_at).toLocaleString() }, fmtRel(r.started_at)),
    h("td", { "data-l": "took" }, fmtDur(r.duration_ms / 1000)),
    h("td", { class: "mono", "data-l": "exit" }, r.exit_code ?? "–"),
  )));
  if (!runs.length) $("#runs-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "muted" }, "No runs match.")));
});
["#runs-status", "#runs-type", "#runs-workflow"].forEach((id) => ($(id).onchange = loadRuns));

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
        h("dt", {}, "cwd"), h("dd", {}, r.cwd),
        h("dt", {}, "command"), h("dd", {}, quoteArgs([r.command, ...r.args])),
        r.prompt ? h("dt", {}, "prompt") : "", r.prompt ? h("dd", { style: "white-space:pre-wrap" }, r.prompt) : "",
        h("dt", {}, "trigger"), h("dd", {}, r.trigger),
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
          !live ? h("button", { class: "small primary", title: `${s.resume_cmd} — in a tmux session here; claude also gets --remote-control`, onclick: () => guard(async () => { const n = await post(`/runs/${r.id}/sessions/${encodeURIComponent(s.session_id)}/resume`); toast(`resumed as run #${n.id}`, true); openRun(n.id); })() }, "Resume here") : "",
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

const loadConsole = guard(async () => {
  consoleData = await get("/console");
  const live = consoleData.live;
  // Keep the selected session if it is still live; otherwise the one we last used, else the newest.
  const remembered = Number(localStorage.getItem("ac_console_run") || 0);
  consoleRun = live.find((r) => r.id === consoleRun?.id) || live.find((r) => r.id === remembered) || live[0] || null;
  if (consoleRun) localStorage.setItem("ac_console_run", String(consoleRun.id));
  renderRail();
  renderPane();
});

function selectConsoleRun(run) {
  if (run.id === consoleRun?.id) return;
  consoleRun = run; paneSig = "";
  localStorage.setItem("ac_console_run", String(run.id));
  patchRail(); renderPane();
}

function renderRail() {
  const { live, headless, adoptable } = consoleData;
  const sig = JSON.stringify([live.map((r) => [r.id, runLabel(r)]), headless.map((r) => [r.id, runLabel(r)]), adoptable.map((p) => [p.pid, p.session?.session_id || ""])]);
  if (sig === railSig) return patchRail();
  railSig = sig;
  $("#session-rail").replaceChildren(
    h("div", { class: "rail-head" },
      h("span", {}, live.length ? `${live.length} live session${live.length === 1 ? "" : "s"}` : "No live sessions"),
      h("button", { class: "small primary", onclick: () => openStartDialog({ kind: "agent", interactive: true }) }, "+ New"),
    ),
    ...live.map((r) => {
      const s = sessOf(r);
      return h("button", { class: `rail-item ${consoleRun?.id === r.id ? "active" : ""}`, "data-run": r.id, "aria-current": consoleRun?.id === r.id ? "true" : "false", onclick: () => selectConsoleRun(r) },
        h("div", { class: "rail-title" }, h("span", { class: `dot ${s?.status || ""}`, title: s?.status || "" }), runLabel(r)),
        h("div", { class: "rail-sub" }, `${r.type_name} · ${shortCwd(r.cwd)}`),
        h("div", { class: "rail-sub dim rail-up" }, railUp(r)),
      );
    }),
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
      p.session?.session_id
        ? h("button", { class: "small", title: "reopen this session in a tmux pane here, so it can be driven from the browser", onclick: () => takeOver(p) }, "Take over here")
        : h("div", { class: "rail-sub dim" }, "no session id — can't take over"),
    )),
  );
}

/** Where a session was launched: its tmux target if it has one, else the shell that spawned it. */
function originOf(p) {
  if (p.drivable) return "terminal here";
  if (p.session?.tmux) return `tmux ${p.session.tmux.split(":")[0]}`;
  const parent = (p.parent_cmd || "").replace(/^-/, "").split(/\s+/)[0].split("/").pop();
  return parent ? `${parent} · no terminal here` : "no terminal here";
}

const railUp = (r) => `up ${fmtDur((Date.now() - r.started_at) / 1000)}` + (sessOf(r)?.model ? ` · ${sessOf(r).model.replace(/^claude-/, "")}` : "");
/** Keep the live bits fresh (working/idle, uptime) without touching the DOM structure. */
function patchRail() {
  for (const r of consoleData.live) {
    const el = $(`#session-rail [data-run="${r.id}"]`);
    if (!el) continue;
    const selected = consoleRun?.id === r.id;
    el.classList.toggle("active", selected);
    el.setAttribute("aria-current", selected ? "true" : "false");
    const dot = $(".dot", el);
    if (dot) { dot.className = `dot ${sessOf(r)?.status || ""}`; dot.title = sessOf(r)?.status || ""; }
    const up = $(".rail-up", el);
    if (up) up.textContent = railUp(r);
  }
}

/**
 * Reopen a session in a tmux pane we can type into. When the session is still running (every process in
 * these lists is), claude keeps the same session id, so the new process shares the original's transcript —
 * two agents writing one history. Worth a word before doing it.
 */
function takeOver(p) {
  const label = p.session?.title || p.session?.name || `pid ${p.pid}`;
  if (!confirm(`Take over "${label}"?\n\nThat session is still running, so this starts a SECOND ${p.type} on the same conversation — both write the same transcript and their histories interleave. Stop the original first if you don't want that.`)) return;
  return guard(async () => {
    const r = await post("/sessions/resume", { agent: p.session.agent, session_id: p.session.session_id, cwd: p.session.cwd || p.cwd });
    toast(`taking over as run #${r.id}`, true);
    selectConsoleRunId(r.id);
    await loadConsole();
  })();
}

function renderPane() {
  const r = consoleRun;
  // Rebuild only when the run or its session changes: a rebuild would drop whatever is half-typed in the keys field,
  // and idle/working flips constantly. Everything volatile is patched in place below.
  const sig = r ? JSON.stringify([r.id, r.status, r.meta?.remote_url || "", sessOf(r)?.session_id || ""]) : `empty:${consoleData.live.length}:${consoleData.adoptable.length}`;
  if (sig !== paneSig) {
    paneSig = sig;
    $("#session-pane").replaceChildren(...(r ? paneFor(r) : [emptyPane()]));
  }
  if (!r) return;
  const s = sessOf(r);
  const dot = $("#pane-dot"); if (dot) { dot.className = `dot ${s?.status || ""}`; dot.title = s?.status || ""; }
  const label = $("#pane-label"); if (label && label.textContent !== runLabel(r)) label.textContent = runLabel(r);
  const up = $("#pane-up"); if (up) up.textContent = `up ${fmtDur((Date.now() - r.started_at) / 1000)}`;
  pollScreenInto($("#console-screen"), r.id, $("#console-follow")?.checked !== false);
}

function paneFor(r) {
  const s = sessOf(r);
  return [
    h("div", { class: "pane-head" },
      h("div", { class: "pane-id" },
        h("h2", {}, h("span", { id: "pane-dot", class: `dot ${s?.status || ""}`, title: s?.status || "" }), h("span", { id: "pane-label" }, runLabel(r))),
        h("div", { class: "pane-meta muted" },
          `${r.type_name} · ${shortCwd(r.cwd)} · `, h("span", { id: "pane-up" }, `up ${fmtDur((Date.now() - r.started_at) / 1000)}`),
          s?.model ? ` · ${s.model}` : "",
          s?.session_id ? h("code", { class: "mono", title: s.session_id }, shortId(s.session_id)) : "",
        ),
      ),
      h("div", { class: "row pane-actions" },
        s?.web_url ? h("a", { href: s.web_url, target: "_blank" }, h("button", { class: "small" }, "Open on web ↗")) : "",
        h("button", { class: "small", title: "the full run record: command, env, log, sessions", onclick: () => openRun(r.id) }, "Details"),
        h("button", { class: "small danger", onclick: () => confirmDo(`Stop "${runLabel(r)}" (run #${r.id})?`, async () => { await post(`/runs/${r.id}/kill`); toast("stopped", true); consoleRun = null; railSig = paneSig = ""; loadConsole(); }) }, "Stop"),
        h("label", { class: "muted follow" }, h("input", { type: "checkbox", id: "console-follow", checked: true }), " follow"),
      ),
    ),
    h("pre", { id: "console-screen", class: "screen" }, "connecting to the terminal…"),
    keysForm(r.id, () => pollScreenInto($("#console-screen"), r.id, true)),
    h("div", { class: "pane-foot muted mono" }, `tmux attach -t ${r.meta?.tmux || "?"}`),
  ];
}

function emptyPane() {
  const n = consoleData.adoptable.length;
  return h("div", { class: "pane-empty" },
    h("h2", {}, "No live session"),
    h("p", { class: "muted" }, "An interactive run keeps a terminal open that you can type into from here — the agent also shows up in the Claude app."),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: () => openStartDialog({ kind: "agent", interactive: true }) }, "+ Start an agent")),
    n ? h("p", { class: "muted" }, `${n} agent session${n === 1 ? "" : "s"} on this machine started outside the console, so there is no pane to type into. Take one over from the list to open one.`) : "",
  );
}

// ---------------------------------------------------------------- refresh loop
function refresh() {
  if (document.hidden) return;
  if (activeTab === "console") loadConsole();
  else if (activeTab === "agents") loadAgents();
  else if (activeTab === "apps") loadTypes().then(loadApps);
  else if (activeTab === "workflows") loadWorkflows();
  else if (activeTab === "runs") { loadRuns(); if (selectedRun) refreshRunDetail(); }
  else if (activeTab === "types") loadTypes();
}
setInterval(refresh, 3000);
setInterval(loadSystem, 30000);
document.addEventListener("visibilitychange", () => !document.hidden && refresh());

(async () => {
  await Promise.all([loadSystem(), loadTypes(), loadWorkflows()]);
  const m = location.hash.match(/^#(\w+)(?:\/(\w+))?/);
  if (m && m[1] === "runs" && m[2]) openRun(Number(m[2]));
  else if (m && m[1] === "console" && /^\d+$/.test(m[2] || "")) { selectConsoleRunId(Number(m[2])); switchTab("console", false); }
  else if (m && m[1] === "agents" && m[2] === "start") { switchTab("agents", false); openStartDialog({ kind: "agent" }); }
  else if (m && m[1] === "processes") switchTab("agents", false);
  else switchTab(m && $(`#tab-${m[1]}`) ? m[1] : "console", false);
})();

$("#refresh-btn").onclick = () => { refresh(); loadSystem(); };
window.addEventListener("hashchange", () => {
  const [tab, id] = location.hash.slice(1).split("/");
  if (tab === "runs" && /^\d+$/.test(id || "")) openRun(Number(id));
  else if ($(`#tab-${tab}`)) { if (selectedRun) closeRun(false); switchTab(tab, false); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && selectedRun && !dlg.open) closeRun(); });
