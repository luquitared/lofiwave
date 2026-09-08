/* Agent Console UI — vanilla JS, talks to /api. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------------------------------------------------------- api client
let token = localStorage.getItem("ac_token") || "";
async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-auth-token"] = token;
  const res = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    const t = prompt("This console requires an access token (AUTH_TOKEN):");
    if (t) { token = t; localStorage.setItem("ac_token", t); return api(method, path, body); }
    throw new Error("unauthorized");
  }
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
let types = [], workflows = [], selectedRun = null, logOffset = 0, activeTab = "agents";
const typeByName = (n) => types.find((t) => t.name === n);

// ---------------------------------------------------------------- tabs
$$("nav button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
function switchTab(name, push = true) {
  activeTab = name;
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (push && !location.hash.startsWith(`#${name}`)) history.replaceState(null, "", `#${name}`);
  refresh();
}

// ---------------------------------------------------------------- system info
const loadSystem = guard(async () => {
  const s = await get("/system");
  const addrs = Object.values(s.addresses).flat();
  const ts = s.tailscale;
  $("#sysinfo").replaceChildren(
    h("div", {}, h("b", {}, s.hostname), ` · ${s.platform} · bun ${s.bun} · up ${fmtDur(s.uptime_ms / 1000)}`),
    h("div", {}, ts && ts.ips?.length ? `tailscale: ${ts.dns_name || ""} ${ts.ips.filter((ip) => !ip.includes(":")).join(", ")}${ts.state === "Running" ? "" : ` (${ts.state})`}` : ts ? `tailscale: ${ts.state}` : "tailscale: not installed", addrs.length ? ` · lan: ${addrs.join(", ")}` : ""),
  );
});

// ---------------------------------------------------------------- types
const loadTypes = guard(async () => {
  types = await get("/process-types");
  for (const sel of [$("#start-form [name=type]"), $("#wf-form [name=type]")]) {
    const cur = sel.value;
    sel.replaceChildren(...types.map((t) => h("option", { value: t.name }, `${t.name} (${t.kind})` + (t.available ? "" : " · not found"))));
    if (cur && typeByName(cur)) sel.value = cur;
  }
  const rt = $("#runs-type"); const cur = rt.value;
  rt.replaceChildren(h("option", { value: "" }, "any type"), ...types.map((t) => h("option", { value: t.name }, t.name))); rt.value = cur;
  $("#type-table tbody").replaceChildren(...types.map((t) => h("tr", {},
    h("td", {}, h("b", {}, t.name), t.builtin ? h("span", { class: "muted" }, " built-in") : "", t.description ? h("div", { class: "muted", style: "font-size:12px;max-width:320px" }, t.description) : ""),
    h("td", {}, h("span", { class: "pill" }, t.kind)),
    h("td", { class: "mono" }, t.command, h("div", { class: "muted" }, t.resolved || ""), t.default_cwd ? h("div", { class: "muted", title: t.default_cwd }, `in ${shortCwd(t.default_cwd)}`) : ""),
    h("td", { class: "mono" }, t.args.join(" ")),
    h("td", { class: "mono trunc", title: t.detect }, t.detect || "–"),
    h("td", {}, t.available ? "✓" : h("span", { style: "color:var(--bad)" }, "✗")),
    h("td", { class: "row" },
      h("button", { class: "small", onclick: () => editType(t) }, "Edit"),
      !t.builtin && h("button", { class: "small danger", onclick: () => confirmDo(`Delete process type "${t.name}"?`, async () => { await del(`/process-types/${t.name}`); toast("deleted", true); loadTypes(); }) }, "Delete"),
    ),
  )));
});
function editType(t) {
  const f = $("#type-form");
  f.orig.value = t.name; f.name.value = t.name; f.name.disabled = true; f.kind.value = t.kind; f.command.value = t.command; f.default_cwd.value = t.default_cwd || "";
  f.args.value = t.args.join("\n"); f.detect.value = t.detect; f.env.value = envText(t.env); f.description.value = t.description;
  $("#type-panel-title").textContent = `Edit process type: ${t.name}`; $("#type-panel").open = true; f.command.focus();
}
function newType(kind) {
  const f = $("#type-form"); f.reset(); f.orig.value = ""; f.name.disabled = false; f.kind.value = kind;
  $("#type-panel-title").textContent = kind === "app" ? "New app" : "New process type"; $("#type-panel").open = true;
  switchTab("types"); f.name.focus();
}
function resetTypeForm() { const f = $("#type-form"); f.reset(); f.orig.value = ""; f.name.disabled = false; $("#type-panel-title").textContent = "New process type"; $("#type-panel").open = false; }
$("#type-cancel").onclick = resetTypeForm;
$("#add-app-btn").onclick = () => newType("app");
$("#type-form").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value.trim(), kind: f.kind.value, command: f.command.value.trim(), default_cwd: f.default_cwd.value.trim(), args: f.args.value.split("\n").filter((l) => l !== ""), detect: f.detect.value, env: parseEnv(f.env.value), description: f.description.value };
  if (f.orig.value) await put(`/process-types/${f.orig.value}`, body); else await post("/process-types", body);
  toast("saved", true); resetTypeForm(); loadTypes();
}));

// ---------------------------------------------------------------- process tables (shared by Agents and Apps)
function renderProcRows(tbody, procs) {
  tbody.replaceChildren(...procs.map((p) => h("tr", { class: p.child ? "child" : "" },
    h("td", { class: "mono" }, p.pid),
    h("td", {}, p.type, p.managed && !p.child ? " " : "", p.managed && !p.child ? badge("managed") : ""),
    h("td", { class: "mono trunc", title: p.cwd || "" }, shortCwd(p.cwd) || "–"),
    h("td", { class: "mono trunc", title: p.cmd }, p.cmd),
    h("td", {}, fmtDur(p.elapsedSec)),
    h("td", {}, p.cpu == null ? "–" : `${p.cpu}%`),
    h("td", {}, fmtMem(p.rssKb)),
    h("td", {}, p.run_id ? h("a", { class: "link", href: `#runs/${p.run_id}`, onclick: (e) => { e.preventDefault(); openRun(p.run_id); } }, `#${p.run_id}`, p.workflow_name ? ` ${p.workflow_name}` : "") : "–"),
    h("td", { class: "row" },
      p.run_id && !p.child ? h("button", { class: "small", onclick: () => guard(async () => { const r = await post(`/runs/${p.run_id}/restart`); toast(`restarted as run #${r.id}`, true); refresh(); })() }, "Restart") : "",
      h("button", { class: "small danger", onclick: () => confirmDo(`Stop pid ${p.pid} (${p.type})?`, async () => { await del(`/processes/${p.pid}`); toast("SIGTERM sent", true); refresh(); }) }, "Stop"),
      h("button", { class: "small danger", title: "SIGKILL", onclick: () => confirmDo(`Force kill pid ${p.pid}?`, async () => { await del(`/processes/${p.pid}?force=1`); toast("SIGKILL sent", true); refresh(); }) }, "Kill"),
    ),
  )));
  if (!procs.length) tbody.replaceChildren(h("tr", {}, h("td", { colspan: 9, class: "muted" }, "Nothing running.")));
}
const countText = (procs, what) => {
  const top = procs.filter((p) => !p.child).length, managed = procs.filter((p) => p.managed && !p.child).length;
  return `${top} ${what}${top === 1 ? "" : "s"}${managed ? ` · ${managed} started here` : ""}`;
};

// ---------------------------------------------------------------- agents tab
const loadAgents = guard(async () => {
  const procs = await get("/processes?kind=agent");
  const hideKids = $("#hide-children").checked;
  $("#agent-count").textContent = countText(procs, "agent process");
  renderProcRows($("#agent-table tbody"), procs.filter((p) => !(hideKids && p.child)));
});
$("#hide-children").onchange = loadAgents;
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
      h("td", {}, h("div", { class: "app-name" }, t.name, t.available ? "" : h("span", { class: "muted", title: "command not found on PATH" }, " ✗")), t.description ? h("div", { class: "app-desc" }, t.description) : ""),
      h("td", { class: "mono" }, quoteArgs([t.command, ...t.args]), t.default_cwd ? h("div", { class: "muted", title: t.default_cwd }, `in ${shortCwd(t.default_cwd)}`) : ""),
      h("td", {}, mine.length ? h("span", { class: "pill on" }, `${mine.length} running`) : h("span", { class: "pill" }, "stopped"), mine.length ? h("div", { class: "muted mono", style: "font-size:11.5px" }, `pid ${mine.map((p) => p.pid).join(", ")} · up ${fmtDur(Math.max(...mine.map((p) => p.elapsedSec ?? 0)))}`) : ""),
      h("td", {}, last ? h("a", { class: "link", href: `#runs/${last.id}`, onclick: (e) => { e.preventDefault(); openRun(last.id); } }, badge(last.status), ` ${fmtRel(last.started_at)}`) : h("span", { class: "muted" }, "never")),
      h("td", { class: "row" },
        h("button", { class: "small primary", onclick: () => openStartDialog({ type: t.name }) }, "Start"),
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
  $("#start-title").textContent = type ? `Start ${type}` : kind === "agent" ? "Start an agent" : "Start a process";
  applyStartType();
  dlg.showModal();
  (sf.cwd.value ? sf.prompt : sf.cwd).focus();
}
function applyStartType() {
  const t = typeByName(sf.type.value);
  const needsPrompt = t && (t.args.some((a) => a.includes("{prompt}")) || t.command.includes("{prompt}"));
  $("#prompt-label").hidden = t && !needsPrompt && t.kind === "app";
  sf.cwd.value = t?.default_cwd || sf.cwd.value;
  sf.cwd.placeholder = t?.default_cwd ? t.default_cwd : "start typing to search";
  sf.extra_args.placeholder = t?.name === "claude" ? "--permission-mode acceptEdits" : t?.name === "codex" ? "--full-auto" : "";
}
sf.type.onchange = applyStartType;
$("#start-cancel").onclick = () => dlg.close();
function startFormBody() {
  return { type: sf.type.value, cwd: sf.cwd.value.trim(), prompt: sf.prompt.value, extra_args: sf.extra_args.value, timeout_sec: Number(sf.timeout_sec.value || 0) };
}
$("#preview-btn").onclick = guard(async () => {
  const r = await post("/processes/preview", startFormBody());
  $("#preview").textContent = "$ " + quoteArgs([r.command, ...r.args]);
});
$("#start-submit").onclick = guard(async () => {
  const run = await post("/processes", startFormBody());
  toast(`started run #${run.id} (pid ${run.pid})`, true);
  dlg.close(); refresh();
});
sf.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#start-submit").click(); });

// ---------------------------------------------------------------- workflows
const loadWorkflows = guard(async () => {
  workflows = await get("/workflows");
  const rw = $("#runs-workflow"); const cur = rw.value;
  rw.replaceChildren(h("option", { value: "" }, "any workflow"), ...workflows.map((w) => h("option", { value: w.id }, w.name))); rw.value = cur;
  $("#wf-table tbody").replaceChildren(...workflows.map((w) => h("tr", {},
    h("td", {}, h("b", {}, w.name), w.prompt ? h("div", { class: "muted trunc", style: "max-width:260px;font-size:12px", title: w.prompt }, w.prompt) : ""),
    h("td", {}, w.type_name),
    h("td", { class: "mono trunc", title: w.cwd }, shortCwd(w.cwd)),
    h("td", { class: "mono" }, w.schedule || h("span", { class: "muted" }, "manual")),
    h("td", { title: fmtTime(w.next_run_at) }, w.enabled && w.schedule ? fmtRel(w.next_run_at) : "–"),
    h("td", { title: fmtTime(w.last_run_at) }, fmtRel(w.last_run_at)),
    h("td", {}, h("button", { class: `on-toggle ${w.enabled ? "on" : ""}`, title: w.enabled ? "enabled" : "disabled", onclick: () => guard(async () => { await put(`/workflows/${w.id}`, { enabled: !w.enabled }); loadWorkflows(); })() })),
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
  f.id.value = w.id; f.name.value = w.name; f.type.value = w.type_name; f.cwd.value = w.cwd; f.prompt.value = w.prompt;
  f.extra_args.value = quoteArgs(w.extra_args); f.env.value = envText(w.env);
  f.schedule.value = w.schedule; f.timeout_sec.value = w.timeout_sec; f.enabled.checked = w.enabled; f.allow_overlap.checked = w.allow_overlap;
  $("#wf-panel-title").textContent = `Edit workflow: ${w.name}`; $("#wf-panel").open = true; f.name.focus();
}
function resetWfForm() { const f = $("#wf-form"); f.reset(); f.id.value = ""; $("#wf-panel-title").textContent = "New workflow"; $("#wf-panel").open = false; }
$("#wf-cancel").onclick = resetWfForm;
$("#wf-form").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value.trim(), type: f.type.value, cwd: f.cwd.value.trim(), prompt: f.prompt.value, extra_args: f.extra_args.value, env: parseEnv(f.env.value), schedule: f.schedule.value.trim(), timeout_sec: Number(f.timeout_sec.value || 0), enabled: f.enabled.checked, allow_overlap: f.allow_overlap.checked };
  if (f.id.value) await put(`/workflows/${f.id.value}`, body); else await post("/workflows", body);
  toast("saved", true); resetWfForm(); loadWorkflows();
}));

// ---------------------------------------------------------------- runs
const loadRuns = guard(async () => {
  const q = new URLSearchParams({ limit: 100 });
  for (const [k, id] of [["status", "#runs-status"], ["type", "#runs-type"], ["workflow_id", "#runs-workflow"]]) if ($(id).value) q.set(k, $(id).value);
  const { runs, total } = await get(`/runs?${q}`);
  $("#runs-count").textContent = `${total} run${total === 1 ? "" : "s"}`;
  $("#runs-table tbody").replaceChildren(...runs.map((r) => h("tr", { class: `clickable ${selectedRun?.id === r.id ? "selected" : ""}`, onclick: () => openRun(r.id) },
    h("td", { class: "mono" }, r.id),
    h("td", {}, r.workflow_name ? h("b", {}, r.workflow_name) : h("span", { class: "muted" }, "ad-hoc"), h("div", { class: "muted", style: "font-size:12px" }, `${r.type_name} · ${shortCwd(r.cwd)}`)),
    h("td", {}, r.trigger),
    h("td", {}, badge(r.status)),
    h("td", { title: new Date(r.started_at).toLocaleString() }, fmtRel(r.started_at)),
    h("td", {}, fmtDur(r.duration_ms / 1000)),
    h("td", { class: "mono" }, r.exit_code ?? "–"),
  )));
  if (!runs.length) $("#runs-table tbody").replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "muted" }, "No runs match.")));
});
["#runs-status", "#runs-type", "#runs-workflow"].forEach((id) => ($(id).onchange = loadRuns));

async function openRun(id) {
  switchTab("runs", false);
  history.replaceState(null, "", `#runs/${id}`);
  selectedRun = { id }; logOffset = 0;
  $("#run-detail").hidden = false; $(".split").classList.add("open");
  $("#run-detail").replaceChildren(h("div", { class: "muted" }, "loading…"));
  await refreshRunDetail(true);
  loadRuns();
}
function closeRun() { selectedRun = null; $("#run-detail").hidden = true; $(".split").classList.remove("open"); history.replaceState(null, "", "#runs"); loadRuns(); }

const refreshRunDetail = guard(async (full = false) => {
  if (!selectedRun) return;
  const id = selectedRun.id;
  const r = await get(`/runs/${id}`);
  if (!selectedRun || selectedRun.id !== id) return;
  const changed = full || r.status !== selectedRun.status;
  selectedRun = r;
  if (changed || !$("#run-log")) {
    $("#run-detail").replaceChildren(
      h("h3", {}, `Run #${r.id}`, badge(r.status), h("span", { class: "muted", style: "font-weight:400;font-size:13px" }, r.workflow_name ? `workflow ${r.workflow_name}` : "ad-hoc"), h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: closeRun }, "✕")),
      h("dl", {},
        h("dt", {}, "type"), h("dd", {}, r.type_name),
        h("dt", {}, "cwd"), h("dd", {}, r.cwd),
        h("dt", {}, "command"), h("dd", {}, quoteArgs([r.command, ...r.args])),
        r.prompt ? h("dt", {}, "prompt") : "", r.prompt ? h("dd", { style: "white-space:pre-wrap" }, r.prompt) : "",
        h("dt", {}, "trigger"), h("dd", {}, r.trigger),
        h("dt", {}, "pid"), h("dd", {}, r.pid ?? "–", r.meta?.orphan ? " (started by a previous console instance)" : ""),
        h("dt", {}, "started"), h("dd", {}, new Date(r.started_at).toLocaleString()),
        h("dt", {}, "ended"), h("dd", {}, r.ended_at ? new Date(r.ended_at).toLocaleString() : "–"),
        h("dt", {}, "duration"), h("dd", {}, fmtDur(r.duration_ms / 1000)),
        h("dt", {}, "exit code"), h("dd", {}, r.exit_code ?? "–"),
        r.meta?.timeout_sec ? h("dt", {}, "timeout") : "", r.meta?.timeout_sec ? h("dd", {}, `${r.meta.timeout_sec}s`) : "",
        Object.keys(r.env || {}).length ? h("dt", {}, "env") : "", Object.keys(r.env || {}).length ? h("dd", {}, envText(r.env)) : "",
        r.error ? h("dt", {}, "error") : "", r.error ? h("dd", { style: "color:var(--bad)" }, r.error) : "",
      ),
      sessionsBlock(r),
      h("div", { class: "row" },
        r.status === "running" ? h("button", { class: "small danger", onclick: () => confirmDo(`Stop run #${r.id}?`, async () => { await post(`/runs/${r.id}/kill`); toast("stopped", true); refreshRunDetail(true); }) }, "Stop") : "",
        r.status === "running" ? h("button", { class: "small danger", onclick: () => confirmDo(`Force kill run #${r.id}?`, async () => { await post(`/runs/${r.id}/kill?force=1`); toast("killed", true); refreshRunDetail(true); }) }, "Kill") : "",
        h("button", { class: "small", onclick: () => guard(async () => { const n = await post(`/runs/${r.id}/restart`); toast(`restarted as run #${n.id}`, true); openRun(n.id); })() }, r.status === "running" ? "Restart" : "Run again"),
        h("a", { href: `/api/runs/${r.id}/log?raw=1${token ? `&token=${encodeURIComponent(token)}` : ""}`, target: "_blank" }, h("button", { class: "small" }, "Raw log")),
        r.status !== "running" ? h("button", { class: "small danger", onclick: () => confirmDo(`Delete run #${r.id} and its log?`, async () => { await del(`/runs/${r.id}`); toast("deleted", true); closeRun(); }) }, "Delete") : "",
        h("label", { class: "muted", style: "margin-left:auto;font-size:12px" }, h("input", { type: "checkbox", id: "autoscroll", checked: true }), " follow"),
      ),
      h("pre", { id: "run-log" }, ""),
    );
    logOffset = 0;
  }
  await pollLog();
});

// Agent sessions reported by the hook (scripts/claude-session-hook.sh): id, resume command, transcript link.
function sessionsBlock(r) {
  const list = r.sessions || [];
  if (!list.length) return "";
  const tokenQ = token ? `?token=${encodeURIComponent(token)}` : "";
  return h("div", { class: "sessions" },
    h("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" }, list.length === 1 ? "session" : `${list.length} sessions`),
    ...list.map((s) => {
      const resume = `claude --resume ${s.session_id}`;
      return h("div", { class: "session" },
        h("code", { class: "mono", title: s.transcript_path || "" }, s.session_id),
        h("span", { class: "muted" }, ` ${s.agent}${s.model ? ` · ${s.model}` : ""}${s.source && s.source !== "startup" ? ` · ${s.source}` : ""} · ${fmtRel(s.started_at)}${s.ended_at ? ` → ${fmtDur((s.ended_at - s.started_at) / 1000)}${s.end_reason ? ` (${s.end_reason})` : ""}` : r.status === "running" ? " · live" : ""}`),
        h("span", { class: "row", style: "gap:6px;margin-left:auto" },
          h("button", { class: "small", title: resume, onclick: () => navigator.clipboard?.writeText(resume).then(() => toast("copied resume command", true)) }, "Copy resume"),
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

// ---------------------------------------------------------------- refresh loop
function refresh() {
  if (document.hidden) return;
  if (activeTab === "agents") loadAgents();
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
  else if (m && m[1] === "agents" && m[2] === "start") { switchTab("agents", false); openStartDialog({ kind: "agent" }); }
  else if (m && m[1] === "processes") switchTab("agents", false);
  else switchTab(m && $(`#tab-${m[1]}`) ? m[1] : "agents", false);
})();
