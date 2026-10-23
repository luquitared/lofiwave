/*
 * Chat view: a Claude Code session as messages, tool rows, diffs and images, read live from its transcript
 * (server: src/chat, design: docs/rendered-view.md). On a live run of ours it has a composer, which types into the
 * TUI through the server (src/chat/input.ts), and cards that answer Claude's permission prompts, questions and plans
 * (src/chat/approvals.ts); sessions lofiwave didn't start are read-only. Edited files and paths in Claude's text open in a
 * files panel beside the conversation (src/chat/files.ts). Runs of ours also stream Claude's text as it's written, show
 * the model, context and rate limits, and list what each turn changed in git (src/chat/live.ts, checkpoints.ts); any
 * session shows its live task list.
 * Uses app.js's helpers (h, token, toast, fmtDur, shortCwd), which are loaded by the time a view opens.
 */

// ---------------------------------------------------------------- markdown (untrusted: always sanitized)
const mdCache = new Map();
if (window.DOMPurify) {
  // Links leave the console in a new tab, without a referrer.
  DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); } });
}
function markdown(text) {
  let html = mdCache.get(text);
  if (html === undefined) {
    html = window.marked && window.DOMPurify
      ? DOMPurify.sanitize(marked.parse(text, { gfm: true }), { FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "video", "audio"], FORBID_ATTR: ["style"] })
      : null;
    if (mdCache.size > 800) mdCache.delete(mdCache.keys().next().value);
    mdCache.set(text, html);
  }
  const el = h("div", { class: "md" });
  if (html === null) { el.textContent = text; el.style.whiteSpace = "pre-wrap"; return el; }
  el.innerHTML = html;
  highlightBlocks(el);
  return el;
}
function highlightBlocks(el) {
  if (window.hljs) for (const code of el.querySelectorAll("pre code[class*='language-']")) {
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1];
    if (lang && hljs.getLanguage(lang)) { try { hljs.highlightElement(code); } catch {} }
  }
}

// ---------------------------------------------------------------- paths in Claude's text
/** A whole string that is a path, with an optional :line or #L12. Groups: path, line, line. */
const PATH_WHOLE = /^((?:~\/|\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)?$/;
const EXTS = "md|markdown|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonc|jsonl|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ya?ml|toml|ini|cfg|conf|css|scss|html|xml|svg|sql|lua|vue|svelte|env|lock|png|jpe?g|gif|webp";
/** Paths inside prose: anything with a slash, or a bare file name with a known extension. */
const PATH_IN_TEXT = new RegExp(`(?<![\\w@.+/:~-])((?:~/|\\.{0,2}/)?(?:[\\w@.+-]+/)+[\\w@.+-]+|[\\w@+-][\\w@.+-]*\\.(?:${EXTS}))(?::(\\d+)(?::\\d+)?|#L(\\d+))?(?![\\w/])`, "g");
/** Worth asking the server about: not a version number, a URL piece, or a lone word. */
const looksLikePath = (p) => p.length >= 3 && p.length <= 400 && /[/.]/.test(p) && !/^[\d.]+$/.test(p) && !p.includes("//") && !/^\.+$/.test(p);

// ---------------------------------------------------------------- small pieces
/** Next frame, or a short timer when frames don't come (a background tab gets none). */
function nextFrame(fn) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}
const WORK = new Set(["thinking", "command", "file_change", "read", "search", "web", "todo", "tool", "subagent"]);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const isOmitted = (v) => v && typeof v === "object" && v.omitted;
const textOf = (v) => (v == null ? "" : typeof v === "string" ? v : isOmitted(v) ? v.preview : JSON.stringify(v, null, 2));
const failed = (it) => it.status === "failed" || (it.kind === "command" && it.exitCode > 0);

/** A JSON call that hands back the error body too (api() keeps only the message): the composer needs {draft}. */
async function call(method, path, body, type) {
  const headers = token ? { "x-auth-token": token } : {};
  if (type) headers["content-type"] = type;
  else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch("/api" + path, { method, headers, body: body === undefined || type ? body : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

async function fetchText(path) {
  const headers = token ? { "x-auth-token": token } : {};
  const res = await fetch("/api" + path, { headers });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  return res.text();
}

/** One line per kind of work: "Ran 3 commands (1 failed), edited 2 files". */
function summarize(items) {
  const by = (k) => items.filter((i) => i.kind === k);
  const parts = [];
  const cmds = by("command");
  if (cmds.length) { const f = cmds.filter(failed).length; parts.push(`ran ${plural(cmds.length, "command")}${f ? ` (${f} failed)` : ""}`); }
  const files = new Set(by("file_change").map((i) => i.path));
  if (files.size) parts.push(`edited ${plural(files.size, "file")}`);
  const reads = by("read").length; if (reads) parts.push(`read ${plural(reads, "file")}`);
  const searches = by("search").length; if (searches) parts.push(`searched ${plural(searches, "time")}`);
  const web = by("web").length; if (web) parts.push(`browsed ${plural(web, "page")}`);
  const agents = by("subagent").length; if (agents) parts.push(`ran ${plural(agents, "agent")}`);
  if (by("todo").length) parts.push("updated the plan");
  const tools = by("tool");
  if (tools.length) parts.push(tools.length <= 2 ? `used ${[...new Set(tools.map((t) => toolName(t.name)))].join(", ")}` : `used ${plural(tools.length, "tool")}`);
  if (!parts.length) { const ms = by("thinking").reduce((a, t) => a + (t.durationMs || 0), 0); return ms ? `Thought for ${fmtDur(ms / 1000)}` : "Thought"; }
  const s = parts.join(", ");
  return s[0].toUpperCase() + s.slice(1);
}
const toolName = (n) => (n || "").replace(/^mcp__/, "").replace(/__/g, " · ");

// ---------------------------------------------------------------- the view
class ChatView {
  /** base: "/runs/12" or "/sessions/<id>". onTerminal: switches the pane to the terminal (null when there isn't one). */
  constructor(base, { onTerminal = null } = {}) {
    this.base = base;
    this.onTerminal = onTerminal;
    this.items = new Map();
    this.floor = 0; this.hasEarlier = false;
    this.status = ""; this.waitingFor = ""; this.cwd = ""; this.sessionId = "";
    this.expanded = new Set(); this.collapsed = new Set();
    this.turnEls = new Map(); this.dirty = new Set();
    this.showPrecompact = false; this.loaded = false;
    this.root = h("div", { class: "chat" });
    this.scroller = h("div", { class: "chat-scroll" });
    this.list = h("div", { class: "chat-list" });
    this.top = h("div", { class: "chat-top" });
    this.banner = h("div", { class: "chat-banner", hidden: true });
    this.jump = h("button", { class: "chat-jump small", hidden: true, title: "jump to the latest message", onclick: () => this.toBottom(true) }, "↓ Latest");
    this.state = h("div", { class: "chat-state muted" }, "connecting…");
    /** Messages sent from here that the transcript doesn't show yet: {id, text, images, state, at}. */
    this.pending = [];
    this.pendingEl = h("div", { class: "chat-list chat-pending" });
    this.readOnly = true;
    /** Approvals waiting on someone (runs only): {id, kind, tool_name, tool_input, suggestions, item_id?}. */
    this.requests = [];
    this.cardEls = new Map();
    this.cardsEl = h("div", { class: "chat-cards", hidden: true });
    /** The session's task list, as a strip above the composer while anything on it is open. */
    this.todos = []; this.todoOpen = false;
    this.todoEl = h("div", { class: "chat-todos", hidden: true });
    /** Model, context, cost and rate limits (runs of ours, from Claude's statusline). */
    this.usage = null;
    /** What each finished turn changed in git, by prompt id: {root, files, added, removed, truncated}. */
    this.changes = new Map();
    this.scroller.append(this.top, this.list, this.pendingEl, this.state);
    this.composer = base.startsWith("/runs/") ? new Composer(this) : null;
    this.files = new FilesPanel(this);
    this.root.append(h("div", { class: "chat-body" },
      h("div", { class: "chat-col" }, h("div", { class: "chat-main" }, this.scroller, this.jump), this.todoEl, this.cardsEl, this.banner, this.composer?.el ?? ""),
      this.files.el), this.footer());
    /** Which paths in Claude's text are files (from the server): path as written → absolute path, or false. */
    this.paths = new Map();
    this.list.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[data-path]");
      if (!a || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      this.files.open({ path: a.dataset.path, line: Number(a.dataset.line) || 0 });
    });
    // Keys 1–9 pick an option on the oldest card, unless you're typing somewhere.
    this.onKey = (e) => {
      if (e.key === "Escape" && this.files.isOpen && this.root.offsetParent && !e.target?.closest?.("input, textarea, select, [contenteditable]")) { e.preventDefault(); this.files.close(); return; }
      if (!this.requests.length || e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      if (!this.root.isConnected || !this.root.offsetParent || e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
      const card = this.cardEls.get(this.requests[0].id);
      if (!card?.pick || card.classList.contains("busy")) return;
      e.preventDefault(); card.pick(Number(e.key));
    };
    document.addEventListener("keydown", this.onKey);
    this.scroller.addEventListener("scroll", () => { this.atBottom = this.nearBottom(); this.jump.hidden = this.atBottom; ChatView.scrolls.set(this.base, this.atBottom ? null : this.scroller.scrollTop); });
    this.atBottom = true;
    this.connect();
  }

  footer() {
    return h("div", { class: "chat-foot muted" },
      h("span", { class: "chat-pill" }, h("span", { class: "dot" }), h("span", { class: "chat-pill-text" }, "")),
      h("span", { class: "chat-usage", hidden: true }),
      h("span", { class: "chat-foot-note" }, this.composer ? "" : "Read-only: this session runs outside lofiwave."),
    );
  }

  footNote() {
    if (!this.composer) return;
    $(".chat-foot-note", this.root).textContent = this.readOnly ? "Read-only: this run has ended."
      : this.status === "waiting" ? (this.requests.length ? "Claude is waiting for your answer above (or in the terminal)." : "Claude is waiting on the terminal; sending is paused.")
      : this.status === "busy" ? "Messages sent now are queued until Claude finishes the current step."
      : matchMedia("(pointer: coarse)").matches ? "" : "Enter to send · Shift+Enter for a new line · / for commands";
  }

  close() { this.closed = true; clearTimeout(this.retry); clearTimeout(this.screenTimer); document.removeEventListener("keydown", this.onKey); this.composer?.close(); try { this.ws?.close(); } catch {} }

  connect() {
    if (this.closed) return;
    const q = new URLSearchParams(); if (token) q.set("token", token);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api${this.base}/chat?${q}`);
    this.ws = ws;
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.onMessage(m); };
    ws.onclose = (e) => {
      if (this.closed || this.ws !== ws) return;
      if (e.code === 1011 || e.code === 1006 && !this.loaded) this.setState(e.reason || "couldn't open this session's transcript · retrying…");
      else this.setState("disconnected · reconnecting…", true);
      this.retry = setTimeout(() => this.connect(), 2000);
    };
  }

  setState(msg, keep = false) { this.state.textContent = msg; this.state.hidden = !msg; if (!keep && msg && !this.items.size) this.list.replaceChildren(); }

  onMessage(m) {
    if (m.t === "hello") {
      const switched = this.sessionId && m.session_id !== this.sessionId;
      this.sessionId = m.session_id; this.cwd = m.cwd || this.cwd;
      this.items = new Map(m.items.map((i) => [i.id, i]));
      this.floor = m.floor; this.hasEarlier = m.has_earlier;
      this.turnEls.clear(); this.list.replaceChildren();
      this.readOnly = m.read_only;
      this.requests = m.requests || [];
      this.renderCards();
      this.todos = m.todos || []; this.renderTodos();
      this.usage = m.usage || null; this.renderUsage();
      this.changes = new Map(Object.entries(m.changes || {}));
      this.setStatus(m.status, m.waiting_for);
      this.loaded = true;
      this.composer?.update(); this.footNote();
      this.setState(m.items.length ? "" : m.waiting_for_file ? "No messages yet. The conversation appears here once the first prompt is sent." : "Nothing to show yet.");
      if (switched) toast("the session switched to a new conversation (/clear or a new session)", true);
      this.render({ restore: true });
    } else if (m.t === "items") {
      for (const it of m.upsert) {
        if (it.ordinal < this.floor && !this.items.has(it.id)) continue; // older than what we show; "Load earlier" brings it
        const old = this.items.get(it.id);
        if (old && old.turnId !== it.turnId) this.dirty.add(old.turnId);
        this.items.set(it.id, it); this.dirty.add(it.turnId);
      }
      for (const id of m.remove) { const old = this.items.get(id); if (old) { this.dirty.add(old.turnId); this.items.delete(id); } }
      if (this.items.size) this.setState("");
      this.settlePending(m.upsert);
      if (this.files.isOpen && m.upsert.some((it) => it.kind === "file_change" && it.path === this.files.path && it.status !== "running")) this.files.changed();
      this.render();
    } else if (m.t === "status") {
      if (m.read_only !== undefined) this.readOnly = m.read_only;
      this.setStatus(m.status, m.waiting_for);
    } else if (m.t === "requests") {
      this.setRequests(m.requests);
    } else if (m.t === "todos") {
      this.todos = m.todos || []; this.renderTodos();
    } else if (m.t === "usage") {
      this.usage = m.usage; this.renderUsage();
    } else if (m.t === "changes") {
      const before = this.changes;
      this.changes = new Map(Object.entries(m.changes || {}));
      // Turns whose changes just arrived get their card.
      for (const it of this.items.values()) if (it.kind === "user" && it.promptId && this.changes.has(it.promptId) && !before.has(it.promptId)) this.dirty.add(it.turnId);
      if (this.dirty.size) this.render();
    }
  }

  setStatus(status, waitingFor) {
    const was = this.status;
    this.status = status || ""; this.waitingFor = waitingFor || "";
    const pill = $(".chat-pill", this.root);
    $(".dot", pill).className = `dot ${this.status}`;
    // "shell": the turn is over but a background command it started still runs. Newer statuses show as they are.
    $(".chat-pill-text", pill).textContent = { busy: "Working…", idle: "Idle", waiting: "Waiting for you", shell: "Idle · background task running" }[this.status]
      || (this.status ? this.status[0].toUpperCase() + this.status.slice(1) : this.sessionId ? "Not running" : "");
    // Claude is blocked on something no card here can answer (a menu, the trust prompt, a run without our hook):
    // show what the terminal shows, and a way there.
    const waiting = this.status === "waiting" && !this.requests.length;
    const wasShown = !this.banner.hidden;
    this.banner.hidden = !waiting;
    if (waiting && (!wasShown || !this.banner.firstChild)) {
      this.screenEl = this.composer && !this.readOnly ? h("pre", { class: "chat-screen", hidden: true }) : null;
      this.banner.replaceChildren(
        h("div", { class: "chat-banner-head" },
          h("span", {}, h("b", {}, "The terminal needs you"), `: Claude is waiting (${this.waitingFor || "it needs an answer"}). `, this.onTerminal ? "Answer it in the terminal." : "Answer it where the session runs."),
          this.onTerminal ? h("button", { class: "small primary", onclick: () => this.onTerminal() }, "Open terminal") : ""),
        this.screenEl ?? "");
      this.pollScreen();
    } else if (waiting) $(".chat-banner-head b", this.banner).nextSibling.textContent = `: Claude is waiting (${this.waitingFor || "it needs an answer"}). `;
    if (was !== this.status) { const last = this.turnOrder().at(-1); if (last) { this.dirty.add(last); this.render(); } }
    if (was === "busy" && this.status !== "busy") this.expirePending();
    if (was !== this.status) this.renderTodos();
    this.composer?.update();
    this.footNote();
  }

  /** The task list while anything on it is open: what Claude is on now and how far along it is; a click shows it all. */
  renderTodos() {
    const all = this.todos || [];
    const open = all.filter((t) => t.status !== "completed");
    this.todoEl.hidden = !open.length;
    if (!open.length) { this.todoEl.replaceChildren(); return; }
    const cur = all.find((t) => t.status === "in_progress");
    const working = cur && (this.status === "busy" || this.status === "waiting");
    this.todoEl.replaceChildren(
      h("button", { class: `chat-todos-head${this.todoOpen ? " open" : ""}`, "aria-expanded": String(this.todoOpen), onclick: () => { this.todoOpen = !this.todoOpen; this.renderTodos(); } },
        h("span", { class: "chev" }), working ? h("span", { class: "chat-spin" }) : h("span", { class: "chat-icon" }, cur ? "◐" : "☐"),
        h("span", { class: "chat-label" }, cur ? cur.active || cur.text : `Next: ${open[0].text}`),
        h("span", { class: "muted" }, `${all.length - open.length} of ${all.length} done`)),
      this.todoOpen ? this.todoList(all) : "");
  }

  /** "Opus 5.5 · 12% context · $0.42 · 5h 3% · week 41%", from the run's statusline; the title has the details. */
  renderUsage() {
    const el = $(".chat-usage", this.root), u = this.usage;
    el.hidden = !u;
    if (!u) return;
    const pct = (n) => `${Math.round(n)}%`;
    const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");
    const LIMITS = { five_hour: "5h", seven_day: "week" };
    const parts = [], tips = [];
    let hot = false;
    if (u.model) parts.push(u.model);
    if (u.context_pct != null) {
      parts.push(`${pct(u.context_pct)} context`); hot ||= u.context_pct >= 80;
      tips.push(`Context: ${pct(u.context_pct)} used${u.context_tokens != null && u.context_size ? ` (${Math.round(u.context_tokens / 1000)}k of ${Math.round(u.context_size / 1000)}k tokens)` : ""}`);
    }
    if (u.cost_usd != null) { parts.push(`$${u.cost_usd.toFixed(2)}`); tips.push(`Session cost: $${u.cost_usd.toFixed(2)}${u.lines_added != null ? `, +${u.lines_added} −${u.lines_removed ?? 0} lines` : ""}`); }
    for (const [k, v] of Object.entries(u.rate_limits || {})) {
      const name = LIMITS[k] || k.replace(/_/g, " ");
      parts.push(`${name} ${pct(v.used_percentage)}`); hot ||= v.used_percentage >= 80;
      tips.push(`${name} limit: ${pct(v.used_percentage)} used${v.resets_at ? `, resets ${when(v.resets_at)}` : ""}`);
    }
    el.textContent = parts.join(" · ");
    el.title = tips.join("\n");
    el.classList.toggle("hot", hot);
  }

  /** While Claude waits, a live snapshot of the bottom of the terminal, so a phone can see what it's asking. */
  async pollScreen() {
    clearTimeout(this.screenTimer);
    if (this.closed || this.banner.hidden || !this.screenEl) return;
    try {
      const r = await api("GET", `${this.base}/chat/screen?lines=16`);
      if (this.screenEl) { this.screenEl.textContent = r.text; this.screenEl.hidden = !r.text.trim(); }
    } catch { /* the run may just have ended */ }
    this.screenTimer = setTimeout(() => this.pollScreen(), 1500);
  }

  // ---------------------------------------------------------------- approvals (answered here or in the terminal, first wins)
  setRequests(list) {
    const linked = new Set([...this.requests, ...(list || [])].map((r) => r.item_id).filter(Boolean));
    this.requests = list || [];
    // Rows waiting on a card carry a badge: redraw their turns.
    for (const id of linked) { const it = this.items.get(id); if (it) this.dirty.add(it.turnId); }
    if (linked.size) this.render();
    this.renderCards();
    this.setStatus(this.status, this.waitingFor);
  }

  renderCards() {
    const ids = new Set(this.requests.map((r) => r.id));
    for (const id of [...this.cardEls.keys()]) if (!ids.has(id)) this.cardEls.delete(id);
    const els = this.requests.map((r) => { if (!this.cardEls.has(r.id)) this.cardEls.set(r.id, this.card(r)); return this.cardEls.get(r.id); });
    const cur = [...this.cardsEl.children];
    if (cur.length !== els.length || cur.some((c, i) => c !== els[i])) this.cardsEl.replaceChildren(...els);
    this.cardsEl.hidden = !els.length;
  }

  card(r) {
    const el = h("div", { class: `chat-card k-${r.kind}`, role: "group" });
    const lock = (on) => { el.classList.toggle("busy", on); for (const c of el.querySelectorAll("button, input")) c.disabled = on; };
    // The server's next {t:"requests"} removes the card once Claude has the answer.
    const send = async (answer) => {
      lock(true);
      try { await call("POST", `${this.base}/chat/requests/${encodeURIComponent(r.id)}`, answer); }
      catch (e) {
        if (e.status === 409) { toast("that was already answered in the terminal"); this.setRequests(this.requests.filter((x) => x.id !== r.id)); }
        else { toast(`couldn't answer: ${e.message}`); lock(false); }
      }
    };
    if (r.kind === "question") this.questionCard(el, r, send);
    else if (r.kind === "plan") this.planCard(el, r, send);
    else this.permissionCard(el, r, send);
    return el;
  }

  /** Numbered choices; keys 1–9 press them (see onKey). */
  options(el, list) {
    el.pick = (n) => list[n - 1]?.[1]();
    return h("div", { class: "chat-opts" }, ...list.map(([label, fn], i) =>
      h("button", { class: "chat-opt", onclick: fn }, h("span", { class: "key" }, String(i + 1)), h("span", { class: "chat-opt-text" }, label))));
  }

  /** A line to type into and a button, for "deny, and tell Claude what to do instead". */
  noteRow(placeholder, label, fn) {
    const input = h("input", { class: "chat-note", placeholder, "aria-label": placeholder });
    const btn = h("button", { class: "small", disabled: true, onclick: () => input.value.trim() && fn(input.value.trim()) }, label);
    input.addEventListener("input", () => { btn.disabled = !input.value.trim(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && input.value.trim()) { e.preventDefault(); fn(input.value.trim()); } });
    return h("div", { class: "chat-note-row" }, input, btn);
  }

  permissionCard(el, r, send) {
    const [title, ...body] = this.describeTool(r.tool_name, r.tool_input || {});
    el.append(h("div", { class: "chat-card-head" }, h("b", {}, title), r.mode && r.mode !== "default" ? h("span", { class: "chat-badge" }, r.mode) : ""), ...body);
    const opts = [["Allow", () => send({ decision: "allow" })]];
    (r.suggestions || []).forEach((s, i) => opts.push([`Allow, and ${this.suggestionText(s)}`, () => send({ decision: "allow", suggestion: i })]));
    opts.push(["Deny", () => send({ decision: "deny" })]);
    el.append(this.options(el, opts), this.noteRow("or deny and tell Claude what to do instead…", "Deny with note", (m) => send({ decision: "deny", message: m })));
  }

  /** A permission card's title and what it shows: the command, the diff, the file, or the raw input. */
  describeTool(name, inp) {
    const pre = (text, cls = "") => h("pre", { class: `chat-out ${cls}` }, text);
    const edit = (o, n) => ({ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [...String(o ?? "").split("\n").map((l) => "-" + l), ...String(n ?? "").split("\n").map((l) => "+" + l)] });
    switch (name) {
      case "Bash": return ["Run this command?", inp.description ? h("div", { class: "muted" }, inp.description) : "", pre("$ " + (inp.command || ""), "cmd")];
      case "Edit": return [`Edit ${this.rel(inp.file_path)}?`, diffView([edit(inp.old_string, inp.new_string)], true)];
      case "MultiEdit": return [`Edit ${this.rel(inp.file_path)}?`, diffView((inp.edits || []).map((e) => edit(e.old_string, e.new_string)), true)];
      case "Write": return [`Write ${this.rel(inp.file_path)}?`, pre(inp.content ?? "")];
      case "NotebookEdit": return [`Edit ${this.rel(inp.notebook_path)}?`, pre(inp.new_source ?? "")];
      case "Read": return [`Read ${this.rel(inp.file_path)}?`];
      case "WebFetch": return [`Fetch ${inp.url}?`, inp.prompt ? h("div", { class: "muted" }, inp.prompt) : ""];
      case "WebSearch": return [`Search the web for "${inp.query}"?`];
      case "Grep": case "Glob": return [`Search for "${inp.pattern}"${inp.path ? ` in ${this.rel(inp.path)}` : ""}?`];
      case "Task": case "Agent": return [`Start an agent: ${inp.description || inp.subagent_type || "subagent"}?`, inp.prompt ? h("details", {}, h("summary", { class: "muted" }, "Prompt"), pre(inp.prompt)) : ""];
    }
    return [`Use ${toolName(name)}?`, kvTable(inp)];
  }

  /** "always allow Bash(npm test:*) in this project", from a permission_suggestions entry. */
  suggestionText(s) {
    const where = { session: "for this session", localSettings: "in this project (just you)", projectSettings: "in this project", userSettings: "everywhere", cliArg: "for this session" }[s.destination] || "";
    const tail = where ? ` ${where}` : "";
    if (s.type === "addRules" || s.type === "replaceRules") {
      const rules = (s.rules || []).map((x) => x.ruleContent ? `${x.toolName}(${x.ruleContent})` : x.toolName).join(", ");
      return `${s.behavior === "deny" ? "always deny" : s.behavior === "ask" ? "always ask for" : "always allow"} ${rules}${tail}`;
    }
    if (s.type === "addDirectories") return `always allow access to ${(s.directories || []).map((d) => this.rel(d) || d).join(", ")}${tail}`;
    if (s.type === "setMode") return `${{ acceptEdits: "accept all edits", bypassPermissions: "skip all permission prompts", plan: "switch to plan mode", default: "ask again for each action", auto: "switch to auto mode" }[s.mode] || `switch to ${s.mode} mode`}${tail}`;
    return JSON.stringify(s);
  }

  /** AskUserQuestion: each question's options, plus "Other". One single-choice question answers on click. */
  questionCard(el, r, send) {
    const qs = (r.tool_input?.questions || []).filter((q) => q && typeof q.question === "string");
    const single = qs.length === 1 && !qs[0].multiSelect;
    const rows = qs.map((q) => ({ q, chosen: new Set(), other: "", btns: [], input: null }));
    const answer = (row) => [...row.chosen, ...(row.other.trim() ? [row.other.trim()] : [])].join(", ");
    const complete = () => rows.every((row) => answer(row));
    const submit = () => complete() && send({ decision: "allow", answers: Object.fromEntries(rows.map((row) => [row.q.question, answer(row)])) });
    const submitBtn = h("button", { class: "small primary", disabled: true, onclick: submit }, "Answer");
    const paint = () => {
      for (const row of rows) row.btns.forEach((b, j) => { const on = row.chosen.has(row.q.options[j].label); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
      submitBtn.disabled = !complete();
    };
    el.append(h("div", { class: "chat-card-head" }, h("b", {}, qs.length === 1 ? "Claude has a question" : `Claude has ${qs.length} questions`)));
    for (const row of rows) {
      const { q } = row;
      row.btns = (q.options || []).map((o, j) => h("button", { class: "chat-opt", "aria-pressed": "false", onclick: () => {
        if (single) return send({ decision: "allow", answers: { [q.question]: o.label } });
        if (q.multiSelect) { if (row.chosen.has(o.label)) row.chosen.delete(o.label); else row.chosen.add(o.label); }
        else { row.chosen = new Set([o.label]); row.other = ""; row.input.value = ""; }
        paint();
      } }, h("span", { class: "key" }, String(j + 1)), h("span", { class: "chat-opt-text" }, h("span", {}, o.label), o.description && o.description !== o.label ? h("span", { class: "muted" }, o.description) : "")));
      row.input = h("input", { class: "chat-note", placeholder: "Other…", "aria-label": `other answer to: ${q.question}` });
      row.input.addEventListener("input", () => { row.other = row.input.value; if (!q.multiSelect && row.other.trim()) row.chosen.clear(); paint(); });
      row.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
      el.append(h("div", { class: "chat-q" },
        h("div", { class: "chat-q-text" }, q.header ? h("span", { class: "chat-badge" }, q.header) : "", h("span", {}, q.question), q.multiSelect ? h("span", { class: "muted" }, "(pick any)") : ""),
        h("div", { class: "chat-opts" }, ...row.btns), row.input));
    }
    // Keys pick from the first question that still needs an answer.
    el.pick = (n) => (rows.find((row) => !answer(row)) ?? rows[0])?.btns[n - 1]?.click();
    el.append(h("div", { class: "row chat-card-foot" }, single ? "" : submitBtn, h("button", { class: "small", onclick: () => send({ decision: "deny" }) }, "Skip")));
  }

  /** ExitPlanMode: approve into a mode, or send Claude back to planning with what to change. */
  planCard(el, r, send) {
    el.append(h("div", { class: "chat-card-head" }, h("b", {}, "Claude's plan is ready. Go ahead?")),
      h("div", { class: "chat-card-plan" }, markdown(r.tool_input?.plan || "")));
    el.append(this.options(el, [
      ["Yes, and accept edits without asking", () => send({ decision: "allow", mode: "acceptEdits" })],
      ["Yes, and ask before each edit", () => send({ decision: "allow", mode: "default" })],
    ]), this.noteRow("or tell Claude what to change…", "Keep planning", (m) => send({ decision: "deny", message: m })));
  }

  // ---------------------------------------------------------------- sent from here, not in the transcript yet
  addPending(p) { this.pending.push(p); this.renderPending(); this.toBottom(); }
  updatePending(id, patch) { const p = this.pending.find((x) => x.id === id); if (p) Object.assign(p, patch); this.renderPending(); }
  dropPending(id) { this.pending = this.pending.filter((x) => x.id !== id); this.renderPending(); }

  /** A sent message is done once a user entry with the same text lands (the TUI adds [Image #N] chips and keeps @refs). */
  settlePending(upsert) {
    if (!this.pending.length) return;
    const norm = (s) => (s || "").replace(/\[Image #\d+\]/g, "").replace(/(^|\s)@\S+/g, " ").replace(/\s+/g, " ").trim();
    for (const it of upsert) {
      if (it.kind !== "user" || it.notification) continue;
      const t = norm(it.text || it.command);
      const p = this.pending.find((x) => x.state !== "sending" && (it.startedAt || 0) >= x.at - 10_000 && (norm(x.text) ? t === norm(x.text) || t.includes(norm(x.text)) : true));
      if (p) this.pending = this.pending.filter((x) => x !== p);
    }
    this.renderPending();
  }

  /** Claude finished and a "sent" row never matched (a slash command, say): let it go after a moment. */
  expirePending() {
    setTimeout(() => {
      const old = Date.now() - 8000;
      const before = this.pending.length;
      this.pending = this.pending.filter((p) => p.state === "sending" || p.state === "failed" || p.at > old || this.status === "busy");
      if (this.pending.length !== before) this.renderPending();
    }, 8000);
  }

  renderPending() {
    const label = { sending: "Sending…", queued: "Queued: Claude reads it when it finishes the current step", sent: "Sent", failed: "Not sent" };
    this.pendingEl.replaceChildren(...this.pending.map((p) => h("div", { class: `chat-user pending ${p.state}` },
      p.text ? h("div", { class: "chat-user-text" }, p.text) : "",
      p.images ? h("div", { class: "muted" }, plural(p.images, "attachment")) : "",
      h("div", { class: "chat-pending-state" }, p.state === "sending" ? h("span", { class: "chat-spin" }) : "", label[p.state] + (p.error ? `: ${p.error}` : ""),
        p.state === "failed" ? h("button", { class: "small", onclick: () => this.dropPending(p.id) }, "Dismiss") : ""))));
  }

  // ---------------------------------------------------------------- turns
  sorted() { return [...this.items.values()].sort((a, b) => a.ordinal - b.ordinal); }
  turnOrder() { const seen = []; let prev; for (const it of this.sorted()) if (it.turnId !== prev) { if (!seen.includes(it.turnId)) seen.push(it.turnId); prev = it.turnId; } return seen; }

  render({ restore = false } = {}) {
    if (this.rendering) { this.again = true; return; }
    this.rendering = true;
    nextFrame(() => {
      this.rendering = false;
      const stick = restore ? ChatView.scrolls.get(this.base) == null : this.nearBottom();
      const all = this.sorted();
      const turns = new Map();
      for (const it of all) { if (!turns.has(it.turnId)) turns.set(it.turnId, []); turns.get(it.turnId).push(it); }
      const order = [...turns.keys()];
      // Everything before the last compaction is collapsed under its divider.
      const lastCompact = all.filter((i) => i.kind === "event" && i.event === "compact").at(-1);
      const pre = lastCompact ? order.filter((t) => turns.get(t).at(-1).ordinal < lastCompact.ordinal) : [];
      const els = [];
      if (this.hasEarlier) els.push(h("button", { class: "chat-earlier small", onclick: () => this.loadEarlier() }, "Load earlier messages"));
      if (pre.length && !this.showPrecompact) els.push(h("button", { class: "chat-earlier small", onclick: () => { this.showPrecompact = true; this.render(); } }, `Show ${plural(pre.length, "turn")} from before the conversation was compacted`));
      const lastTurn = order.at(-1);
      for (const t of order) {
        if (!this.showPrecompact && pre.includes(t)) continue;
        let el = this.turnEls.get(t);
        if (!el || this.dirty.has(t)) { el = this.renderTurn(t, turns.get(t), t === lastTurn); this.turnEls.get(t)?.replaceWith(el); this.turnEls.set(t, el); }
        els.push(el);
      }
      for (const t of [...this.turnEls.keys()]) if (!turns.has(t)) this.turnEls.delete(t);
      this.dirty.clear();
      const cur = [...this.list.children];
      if (cur.length !== els.length || cur.some((c, i) => c !== els[i])) this.list.replaceChildren(...els);
      this.top.replaceChildren();
      if (restore && !stick) this.scroller.scrollTop = ChatView.scrolls.get(this.base);
      else if (stick) this.toBottom();
      if (this.again) { this.again = false; this.render(); }
    });
  }

  nearBottom() { const s = this.scroller; return s.scrollHeight - s.scrollTop - s.clientHeight < 150; }

  /** Stick to the bottom, again over a few frames: highlighting and images change heights after the first paint. */
  toBottom(smooth = false) {
    const s = this.scroller;
    s.scrollTo({ top: s.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    let n = 0;
    const again = () => { if (++n > 4 || (!this.atBottom && n > 1)) return; s.scrollTop = s.scrollHeight; requestAnimationFrame(again); };
    if (!smooth) requestAnimationFrame(again);
    this.atBottom = true; this.jump.hidden = true; ChatView.scrolls.set(this.base, null);
  }

  async loadEarlier() {
    try {
      const r = await api("GET", `${this.base}/chat?before=${this.floor}`);
      if (r.session_id !== this.sessionId) return;
      for (const it of r.items) if (!this.items.has(it.id)) { this.items.set(it.id, it); this.dirty.add(it.turnId); }
      this.floor = r.floor; this.hasEarlier = r.has_earlier;
      // Keep what's on screen where it is while the list grows above it.
      const s = this.scroller, before = s.scrollHeight - s.scrollTop;
      this.render();
      nextFrame(() => nextFrame(() => { s.scrollTop = s.scrollHeight - before; }));
    } catch (e) { toast(`couldn't load earlier messages: ${e.message}`); }
  }

  /** A finished turn folds to "Worked for 2m 13s"; the live one (working, or waiting on an answer) shows everything. */
  renderTurn(turnId, items, isLast) {
    const live = isLast && (this.status === "busy" || this.status === "waiting");
    const head = items[0].kind === "user" ? items[0] : null;
    const body = head ? items.slice(1) : items;
    const el = h("section", { class: `chat-turn${live ? " live" : ""}`, "data-turn": turnId });
    if (head) el.append(this.renderUser(head));
    // The reply is the text after the last piece of work; everything before it folds away once the turn is done.
    let cut = body.length;
    while (cut > 0 && !WORK.has(body[cut - 1].kind)) cut--;
    const work = body.slice(0, cut), tail = body.slice(cut);
    const hasWork = work.some((i) => WORK.has(i.kind));
    const foldKey = `t:${turnId}`;
    if (hasWork && !live) {
      const open = this.expanded.has(foldKey);
      const ms = head?.turnDurationMs || ((work.at(-1).completedAt || work.at(-1).startedAt || 0) - (work[0].startedAt || 0));
      const nFailed = work.filter((i) => WORK.has(i.kind) && failed(i)).length;
      el.append(h("button", { class: `chat-fold${open ? " open" : ""}`, "aria-expanded": String(open), onclick: () => this.toggle(foldKey, turnId) },
        h("span", { class: "chev" }), ms > 0 ? `Worked for ${fmtDur(ms / 1000)}` : "Worked", h("span", { class: "muted" }, ` · ${summarize(work.filter((i) => WORK.has(i.kind)))}`),
        nFailed ? h("span", { class: "chat-badge bad" }, `${nFailed} failed`) : ""));
      if (open) el.append(h("div", { class: "chat-folded" }, ...this.renderBody(work, turnId, false, true)));
      else for (const it of work) if (it.kind === "event" && (it.event === "error" || it.event === "compact")) el.append(this.renderEvent(it)); // failures and compactions stay visible
    } else {
      el.append(...this.renderBody(work, turnId, live));
    }
    el.append(...this.renderBody(tail, turnId, live));
    if (!live) { const card = this.editedCard(body, head); if (card) el.append(card); }
    return el;
  }

  /**
   * "Edited 3 files": what a finished turn changed, each file with its +/− counts; a click opens the turn's diff.
   * With git checkpoints (runs of ours, in a repo) the list comes from git, so files changed through commands show
   * too; edits git doesn't see (outside the repo, ignored) are added from the transcript.
   */
  editedCard(items, head) {
    const by = new Map();
    for (const it of items) {
      if (it.kind !== "file_change" || !it.path || it.status !== "completed") continue;
      const f = by.get(it.path) || { path: it.path, added: 0, removed: 0, created: it.op === "write" && it.removed === 0, edits: [] };
      f.added += it.added || 0; f.removed += it.removed || 0; f.edits.push(it);
      by.set(it.path, f);
    }
    const git = head?.promptId ? this.changes.get(head.promptId) : null;
    const prompt = git?.files.length ? head.promptId : "";
    const rows = prompt
      ? [...git.files.map((f) => ({ ...f, created: f.status === "A", deleted: f.status === "D", edits: by.get(f.path)?.edits || [], viaCommand: !by.has(f.path), git: true })),
         ...[...by.values()].filter((f) => !git.files.some((g) => g.path === f.path))]
      : [...by.values()];
    if (!rows.length) return null;
    const agent = this.agent;
    const verb = prompt ? "Changed" : "Edited";
    return h("div", { class: "chat-edited" },
      h("div", { class: "chat-edited-head muted" }, rows.length === 1 ? `${verb} 1 file` : `${verb} ${rows.length}${git?.truncated ? "+" : ""} files`,
        prompt ? h("span", { title: "from git snapshots taken when the prompt was sent and when Claude stopped" }, ` · +${git.added} −${git.removed} in git`) : ""),
      ...rows.map((f) => h("button", { class: "chat-row", title: f.path, onclick: () => this.files.open({ path: f.path, edits: f.edits, agent, tab: "diff", git: f.git ? { prompt } : null }) },
        h("span", { class: "chat-icon" }, f.created ? "+" : f.deleted ? "−" : "✎"), h("span", { class: "chat-label" }, this.rel(f.path)),
        f.viaCommand ? h("span", { class: "chat-badge", title: "changed by a command, not an edit" }, "via a command") : "",
        f.binary ? h("span", { class: "chat-badge" }, "binary")
          : h("span", { class: "chat-diffstat" }, h("span", { class: "add" }, `+${f.added}`), " ", h("span", { class: "del" }, `−${f.removed}`)))));
  }

  /**
   * Paths in rendered text (`src/x.ts:12`, a bare `README.md`, a markdown link to a file) become links into the files
   * panel, but only once the server says the file exists. Answers are cached, so a redraw links at once.
   */
  linkify(el) {
    const found = [];
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^([a-z][\w+.-]*:|#|\/\/)/i.test(href)) continue;
      const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)?$/.exec(decodeURI(href));
      if (m) found.push({ node: a, path: m[1], line: Number(m[2] || m[3]) || 0, whole: true });
    }
    for (const code of el.querySelectorAll(":not(pre) > code")) {
      if (code.closest("a")) continue;
      const m = PATH_WHOLE.exec(code.textContent.trim());
      if (m && looksLikePath(m[1])) found.push({ node: code, path: m[1], line: Number(m[2] || m[3]) || 0, whole: true });
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest("a, code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n; (n = walker.nextNode());) {
      PATH_IN_TEXT.lastIndex = 0;
      for (let m; (m = PATH_IN_TEXT.exec(n.data));) {
        let path = m[1];
        if (!m[2] && !m[3]) path = path.replace(/[.,;:]+$/, "");
        if (looksLikePath(path)) found.push({ node: n, path, line: Number(m[2] || m[3]) || 0, at: m.index, text: m[2] || m[3] ? m[0] : path });
      }
    }
    if (!found.length) return el;
    const apply = () => {
      // Text nodes are split from the end, so earlier offsets stay right.
      for (const f of found.reverse()) {
        const abs = this.paths.get(f.path);
        if (!abs) continue;
        if (f.whole) {
          if (f.node.tagName === "A") { f.node.dataset.path = abs; f.node.dataset.line = f.line; f.node.removeAttribute("target"); f.node.classList.add("chat-path"); f.node.title = abs; }
          else f.node.replaceWith(h("a", { href: "#", class: "chat-path", "data-path": abs, "data-line": f.line, title: abs }, f.node.cloneNode(true)));
          continue;
        }
        if (!f.node.parentNode) continue;
        const after = f.node.splitText(f.at);
        after.splitText(f.text.length);
        after.replaceWith(h("a", { href: "#", class: "chat-path", "data-path": abs, "data-line": f.line, title: abs }, f.text));
      }
    };
    const unknown = [...new Set(found.map((f) => f.path))].filter((p) => !this.paths.has(p));
    if (!unknown.length) apply();
    else this.askPaths(unknown).then(apply);
    return el;
  }

  /** One request for all the paths a render turns up; each is asked about once per view. */
  askPaths(paths) {
    if (!this.pathAsk) {
      const ask = this.pathAsk = { paths: new Set() };
      ask.done = new Promise((r) => setTimeout(r, 30)).then(() => {
        this.pathAsk = null;
        const list = [...ask.paths].slice(0, 300);
        return call("POST", `${this.base}/chat/paths`, { paths: list })
          .then((r) => { for (const [p, abs] of Object.entries(r.files || {})) this.paths.set(p, abs); })
          .catch(() => { for (const p of list) this.paths.delete(p); });
      });
    }
    for (const p of paths) { this.paths.set(p, false); this.pathAsk.paths.add(p); }
    return this.pathAsk.done;
  }

  /** Assistant text in full; runs of tool calls fold into one summary row (unless `flat`: already inside a fold). */
  renderBody(items, turnId, live, flat = false) {
    const out = [];
    for (let i = 0; i < items.length;) {
      const it = items[i];
      if (it.kind === "assistant") { out.push(h("div", { class: `chat-assistant${it.streaming ? " streaming" : ""}` }, it.streaming ? markdown(it.text) : this.linkify(markdown(it.text)))); i++; continue; }
      if (it.kind === "plan") { out.push(this.renderPlan(it)); i++; continue; }
      if (it.kind === "event") { out.push(this.renderEvent(it)); i++; continue; }
      if (it.kind === "user") { out.push(this.renderUser(it)); i++; continue; }
      let j = i;
      while (j < items.length && WORK.has(items[j].kind)) j++;
      if (j === i) { out.push(h("div", { class: "chat-raw muted" }, it.kind)); i++; continue; }
      const group = items.slice(i, j);
      if (flat) out.push(...group.filter((g) => g.kind !== "thinking" || g.text).map((g) => this.renderRow(g, turnId)));
      else out.push(this.renderGroup(group, turnId, live && j === items.length));
      i = j;
    }
    return out;
  }

  renderGroup(group, turnId, liveGroup) {
    const visible = group.filter((i) => !(i.kind === "thinking" && !i.text && group.length > 1));
    if (visible.length === 1) return this.renderRow(visible[0], turnId);
    const key = `g:${group[0].id}`;
    const open = this.expanded.has(key) || (liveGroup && !this.collapsed.has(key));
    const nFailed = group.filter(failed).length;
    const running = liveGroup && group.some((i) => i.status === "running");
    const box = h("div", { class: "chat-group" },
      h("button", { class: `chat-row chat-group-head${open ? " open" : ""}`, "aria-expanded": String(open), onclick: () => this.toggle(key, turnId, liveGroup) },
        h("span", { class: "chev" }), h("span", { class: "chat-label" }, summarize(group)),
        nFailed ? h("span", { class: "chat-badge bad" }, `${nFailed} failed`) : "", running ? h("span", { class: "chat-spin" }) : ""));
    if (open) box.append(h("div", { class: "chat-group-body" }, ...visible.map((it) => this.renderRow(it, turnId))));
    else if (liveGroup) box.append(h("div", { class: "chat-group-body" }, this.renderRow(visible.at(-1), turnId)));
    return box;
  }

  toggle(key, turnId, defaultOpen = false) {
    if (defaultOpen) { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); }
    else if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
    this.dirty.add(turnId);
    const keep = this.scroller.scrollTop;
    this.render();
    nextFrame(() => { if (!this.atBottom) this.scroller.scrollTop = keep; });
  }

  rel(p) {
    if (!p) return "";
    if (this.cwd && p.startsWith(this.cwd + "/")) return p.slice(this.cwd.length + 1);
    return shortCwd(p);
  }

  // ---------------------------------------------------------------- rows
  renderUser(it) {
    if (it.notification) return h("div", { class: "chat-event info" }, h("span", {}, "⚙"), h("span", {}, it.text));
    return h("div", { class: `chat-user${it.queued ? " queued" : ""}`, title: it.queued ? "sent while Claude was working, and read mid-turn" : null },
      it.command ? h("code", { class: "chat-cmd" }, it.command) : "",
      it.text ? h("div", { class: "chat-user-text" }, it.text) : "",
      it.images?.length ? h("div", { class: "chat-images" }, ...it.images.map((im) => this.image(im))) : "",
      it.output !== undefined ? h("pre", { class: "chat-out" }, textOf(it.output) || "(no output)") : "",
    );
  }

  renderEvent(it) {
    if (it.event === "compact") return h("div", { class: "chat-divider" }, h("span", {}, it.text),
      it.detail ? h("details", {}, h("summary", { class: "muted" }, "summary"), h("pre", { class: "chat-out" }, textOf(it.detail))) : "");
    if (it.event === "interrupt") return h("div", { class: "chat-event warn" }, "⏹ Interrupted");
    if (it.event === "error") return h("div", { class: "chat-event bad" }, h("span", {}, "⚠"), h("span", {}, it.text));
    if (it.event === "raw") return h("div", { class: "chat-raw muted", title: "an entry this version of lofiwave doesn't know yet" }, `· ${it.text}`);
    return h("div", { class: "chat-event info" }, h("pre", {}, it.text));
  }

  renderPlan(it) {
    return h("div", { class: "chat-plan" },
      h("div", { class: "chat-plan-head" }, h("b", {}, "Plan"), it.decision ? h("span", { class: `chat-badge ${it.decision === "approved" ? "ok" : "bad"}` }, it.decision) : it.status === "running" ? h("span", { class: "chat-badge" }, "awaiting approval") : ""),
      this.linkify(markdown(it.markdown || "")));
  }

  /** What a tool row says when folded: an icon, a label, and badges. */
  rowLabel(it) {
    switch (it.kind) {
      case "command": return ["$", it.label || it.command];
      case "file_change": return ["✎", `${it.op === "write" && it.removed === 0 ? "Created" : "Edited"} ${this.rel(it.path)}`];
      case "read": return ["▤", `Read ${this.rel(it.label)}`];
      case "search": return ["⌕", `Searched ${it.label}`];
      case "web": return ["◍", it.label.startsWith('"') ? `Searched the web for ${it.label}` : `Fetched ${it.label}`];
      case "thinking": return ["✻", it.durationMs ? `Thought for ${fmtDur(it.durationMs / 1000)}` : "Thought"];
      case "todo": return ["☐", it.steps.length === 1 ? it.steps[0].text : `Plan: ${it.steps.filter((s) => s.status === "completed").length}/${it.steps.length} done`];
      case "subagent": return ["⑂", `Agent: ${it.label}`];
      case "tool": return ["⚒", toolName(it.name)];
    }
    return ["·", it.kind];
  }

  renderRow(it, turnId) {
    const [icon, label] = this.rowLabel(it);
    const expandable = !(it.kind === "thinking" && !it.text);
    const open = this.expanded.has(it.id);
    const running = it.status === "running";
    const badges = [];
    if (it.kind === "file_change") badges.push(h("span", { class: "chat-diffstat" }, h("span", { class: "add" }, `+${it.added}`), " ", h("span", { class: "del" }, `−${it.removed}`)));
    if (failed(it)) badges.push(h("span", { class: "chat-badge bad" }, it.kind === "command" && it.exitCode > 0 ? `exit ${it.exitCode}` : "failed"));
    if (it.status === "interrupted") badges.push(h("span", { class: "chat-badge warn" }, it.denied ? "denied" : "interrupted"));
    if (it.background) badges.push(h("span", { class: "chat-badge" }, "background"));
    if (this.requests?.some((r) => r.item_id === it.id)) badges.push(h("span", { class: "chat-badge warn" }, "needs your answer"));
    else if (running) badges.push(this.status === "busy" || this.status === "waiting" || it.kind === "subagent" ? h("span", { class: "chat-spin", title: "running" }) : h("span", { class: "chat-badge" }, "no result"));
    // An edit opens in the files panel (its diff, the file now, a preview) rather than inline.
    const panel = it.kind === "file_change" && it.path;
    const agent = this.agent;
    const head = h(expandable ? "button" : "div", { class: `chat-row${open ? " open" : ""}${failed(it) ? " failed" : ""}`,
      ...(panel ? { title: `${it.path}: open the diff and the file`, onclick: () => this.files.open({ path: it.path, edits: [it], agent, tab: "diff" }) }
        : expandable ? { "aria-expanded": String(open), onclick: () => this.toggle(it.id, turnId) } : {}) },
      h("span", { class: panel ? "chev none" : expandable ? "chev" : "chev none" }), h("span", { class: "chat-icon" }, icon), h("span", { class: "chat-label" }, label), ...badges);
    const row = h("div", { class: `chat-item k-${it.kind}` }, head);
    if (open) row.append(this.details(it));
    else if (it.kind === "todo" && it.steps.length > 1) row.append(this.todoList(it.steps));
    return row;
  }

  details(it) {
    const d = h("div", { class: "chat-details" });
    switch (it.kind) {
      case "command":
        d.append(h("pre", { class: "chat-out cmd" }, "$ " + it.command));
        if (it.output !== undefined) d.append(this.output(it.output, it));
        break;
      case "file_change":
        if (it.error) d.append(h("pre", { class: "chat-out bad" }, it.error));
        if (isOmitted(it.patch)) d.append(this.lazy(`Load the diff (${fmtBytes(it.patch.bytes)})`, it.patch.blob, (t) => diffView(JSON.parse(t))));
        else if (it.patch) d.append(diffView(it.patch));
        else d.append(h("div", { class: "muted" }, it.status === "running" ? "waiting for the edit…" : "no diff recorded"));
        break;
      case "read": case "search": case "web":
        if (it.kind === "read" && it.label) d.append(h("button", { class: "small chat-more", onclick: () => this.files.open({ path: it.label.replace(/ · \d+ lines$/, "") }) }, "Open the file"));
        if (it.images?.length) d.append(h("div", { class: "chat-images" }, ...it.images.map((im) => this.image(im))));
        if (it.detail !== undefined) d.append(this.output(it.detail, it));
        break;
      case "thinking": d.append(h("div", { class: "chat-thinking" }, it.text)); break;
      case "todo": d.append(this.todoList(it.steps)); break;
      case "subagent": d.append(...this.subagent(it)); break;
      default:
        d.append(kvTable(it.input));
        if (it.answers) d.append(kvTable(it.answers));
        if (it.images?.length) d.append(h("div", { class: "chat-images" }, ...it.images.map((im) => this.image(im))));
        if (it.output !== undefined) d.append(this.output(it.output, it));
    }
    return d;
  }

  todoList(steps) {
    const mark = { completed: "☑", in_progress: "◐", pending: "☐" };
    return h("ul", { class: "chat-todo" }, ...steps.map((s) => h("li", { class: s.status }, h("span", {}, mark[s.status] || "·"), s.text)));
  }

  /** An output box with its own scroll; a long one shows its start and fetches the rest on request. */
  output(v, it) {
    const pre = h("pre", { class: `chat-out${failed(it) ? " bad" : ""}` }, textOf(v) || "(no output)");
    if (!isOmitted(v)) return pre;
    const more = this.lazy(`Show all (${fmtBytes(v.bytes)})`, v.blob, (t) => { pre.textContent = t; return ""; });
    return h("div", {}, pre, more);
  }

  /** A button that fetches a payload left in the transcript and swaps in what `make` builds from it. */
  lazy(label, ref, make, agent = this.agent) {
    const btn = h("button", { class: "small chat-more", onclick: async () => {
      btn.disabled = true; btn.textContent = "loading…";
      try { const out = make(await fetchText(this.blobPath(ref, agent))); if (out) btn.replaceWith(out); else btn.remove(); }
      catch (e) { btn.disabled = false; btn.textContent = label; toast(e.message); }
    } }, label);
    return btn;
  }

  blobPath(ref, agent = this.agent) {
    const q = new URLSearchParams({ ref }); if (agent) q.set("agent", agent);
    return `${this.base}/chat/blob?${q}`;
  }

  image(im) {
    const q = new URLSearchParams({ ref: im.blob }); if (this.agent) q.set("agent", this.agent); if (token) q.set("token", token);
    const src = `/api${this.base}/chat/blob?${q}`;
    return h("a", { href: src, target: "_blank", class: "chat-img" }, h("img", { src, loading: "lazy", alt: "image from the transcript" }));
  }

  /** A subagent's prompt and result, and on request its whole conversation, nested. */
  subagent(it) {
    const out = [];
    if (it.agentType) out.push(h("div", { class: "muted" }, `type: ${it.agentType}`));
    if (it.prompt) out.push(h("details", {}, h("summary", { class: "muted" }, "Prompt"), h("div", { class: "chat-thinking" }, textOf(it.prompt))));
    if (it.result !== undefined) out.push(h("div", { class: "chat-sub-result" }, markdown(textOf(it.result))));
    if (it.childTurnId) {
      const box = h("div", { class: "chat-sub" });
      const btn = h("button", { class: "small", onclick: async () => {
        btn.disabled = true; btn.textContent = "loading…";
        try {
          const r = await api("GET", `${this.base}/chat/subagent/${encodeURIComponent(it.childTurnId)}`);
          const sub = Object.create(this); // same renderers, blobs read from the subagent's file
          sub.agent = it.childTurnId; sub.expanded = this.expanded; sub.status = it.status === "running" ? "busy" : "";
          sub.toggle = (key) => { if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key); paint(); };
          const paint = () => box.replaceChildren(...sub.renderBody(r.items, `sub:${it.id}`, false));
          paint(); btn.remove();
        } catch (e) { btn.disabled = false; btn.textContent = "Show its conversation"; toast(e.message); }
      } }, "Show its conversation");
      out.push(btn, box);
    }
    return out;
  }
}
/** Where each view was scrolled (null = following the bottom), per run, for this page's lifetime. */
ChatView.scrolls = new Map();

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function kvTable(obj) {
  if (obj == null || typeof obj !== "object") return h("pre", { class: "chat-out" }, String(obj ?? ""));
  return h("dl", { class: "chat-kv" }, ...Object.entries(obj).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, typeof v === "string" ? v : JSON.stringify(v, null, 2))]));
}

/**
 * A unified diff from structuredPatch hunks, with old and new line numbers (`bare`: no numbers, for an edit not made
 * yet). `onLine(n)`: a click on a new line number (the files panel jumps to that line of the file).
 */
function diffView(hunks, bare = false, onLine = null) {
  const rows = [];
  for (const hk of hunks || []) {
    let o = hk.oldStart, n = hk.newStart;
    if (!bare) rows.push(h("div", { class: "dl hunk" }, h("span", { class: "ln" }), h("span", { class: "ln" }), h("span", { class: "tx" }, `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`)));
    else if (rows.length) rows.push(h("div", { class: "dl hunk" }, h("span", { class: "ln" }), h("span", { class: "ln" }), h("span", { class: "tx" }, "…")));
    for (const line of hk.lines || []) {
      const s = line[0], tx = line.slice(1);
      if (s === "\\") continue;
      const cls = s === "+" ? "add" : s === "-" ? "del" : "";
      const at = n;
      const newLn = s === "-" || bare ? h("span", { class: "ln" }) : onLine ? h("span", { class: "ln go", title: `line ${at} of the file now`, onclick: () => onLine(at) }, at) : h("span", { class: "ln" }, at);
      rows.push(h("div", { class: `dl ${cls}` }, h("span", { class: "ln" }, s === "+" || bare ? "" : o), newLn, h("span", { class: "tx" }, (s === "+" || s === "-" ? s : " ") + tx)));
      if (s !== "+") o++;
      if (s !== "-") n++;
    }
  }
  return h("div", { class: "chat-diff" }, ...rows);
}

// ---------------------------------------------------------------- the files panel
const isMarkdownPath = (p) => /\.(md|markdown|mdx)$/i.test(p);
const isImagePath = (p) => /\.(png|jpe?g|gif|webp|svg)$/i.test(p);
const LANGS = { ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", jsonc: "json", jsonl: "json", py: "python", rb: "ruby", rs: "rust", sh: "bash", zsh: "bash", yml: "yaml", md: "markdown", mdx: "markdown", html: "xml", svg: "xml", h: "c", cc: "cpp", hpp: "cpp", kt: "kotlin", toml: "ini", cfg: "ini", conf: "ini" };
function langOf(p) {
  const base = p.split("/").pop();
  const name = base === "Dockerfile" ? "dockerfile" : base === "Makefile" ? "makefile" : LANGS[(/\.(\w+)$/.exec(base) || [])[1]?.toLowerCase()] || (/\.(\w+)$/.exec(base) || [])[1]?.toLowerCase();
  return name && window.hljs?.getLanguage(name) ? name : null;
}
/** `rel` against folder `dir`, with . and .. resolved (absolute `rel` stays as is). */
function resolvePath(dir, rel) {
  const out = [];
  for (const part of (rel.startsWith("/") ? rel : `${dir}/${rel}`).split("/")) {
    if (part === "..") out.pop(); else if (part && part !== ".") out.push(part);
  }
  return "/" + out.join("/");
}
/** The file view's line height and top padding, in px: the highlighted line is placed from them. */
const LINE_PX = 18, CODE_PAD = 8;

/**
 * A file beside the conversation: the diff of the edits it was opened from, the file as it is on disk now (scrolled
 * to a line), and a preview for markdown and images. Opened from an edit row, a turn's "Edited N files" card, or a
 * path in Claude's text.
 */
class FilesPanel {
  constructor(view) {
    this.view = view;
    this.isOpen = false;
    this.el = h("aside", { class: "chat-files", hidden: true, "aria-label": "file" });
  }

  /**
   * edits: the file_change items whose diff to show (from a link: every edit of the file in what's loaded).
   * git: {prompt}: show what that turn changed in the file according to git instead (it has the commands' changes too).
   */
  open({ path, line = 0, edits = null, agent = "", tab = "", git = null }) {
    this.path = path; this.line = line; this.agent = agent; this.git = git; this.gitDiff = null;
    this.edits = edits || this.view.sorted().filter((i) => i.kind === "file_change" && i.path === path && i.status === "completed");
    this.file = null;
    this.tab = tab === "diff" && (this.edits.length || git) ? "diff" : !line && (isMarkdownPath(path) || isImagePath(path)) ? "preview" : "current";
    this.isOpen = true; this.el.hidden = false;
    this.view.root.classList.add("files-open");
    this.render();
  }

  close() {
    this.isOpen = false; this.el.hidden = true; this.el.replaceChildren();
    this.view.root.classList.remove("files-open");
  }

  /** Claude changed the open file: what's on disk is news. */
  changed() { this.file = null; if (this.tab !== "diff") this.render(); }

  show(tab, line = 0) { this.tab = tab; if (line) this.line = line; this.render(); }

  render() {
    const p = this.path, rel = this.view.rel(p);
    const tabs = [this.git ? ["diff", "Turn diff"] : this.edits.length ? ["diff", this.edits.length > 1 ? `Diff (${this.edits.length} edits)` : "Diff"] : null, ["current", "Current"], isMarkdownPath(p) || isImagePath(p) ? ["preview", "Preview"] : null].filter(Boolean);
    this.body = h("div", { class: "chat-files-body" });
    this.el.replaceChildren(
      h("div", { class: "chat-files-head" },
        h("div", { class: "chat-files-path", title: p }, h("b", {}, p.split("/").pop()), rel.includes("/") ? h("span", { class: "muted" }, "\u200e" + rel.replace(/\/[^/]*$/, "") + "\u200e") : ""),
        h("button", { class: "small", title: p, onclick: () => navigator.clipboard?.writeText(p).then(() => toast("path copied"), () => toast(p)) }, "Copy path"),
        h("button", { class: "chat-files-x", "aria-label": "close the file", title: "close (Esc)", onclick: () => this.close() }, "×")),
      h("div", { class: "chat-files-bar" },
        h("div", { class: "seg", role: "tablist" }, ...tabs.map(([k, label]) => h("button", { class: k === this.tab ? "on" : "", role: "tab", "aria-selected": String(k === this.tab), onclick: () => this.show(k) }, label))),
        this.tab !== "diff" ? h("button", { class: "small", title: "read the file from disk again", onclick: () => { this.file = null; this.render(); } }, "Reload") : ""),
      this.body);
    if (this.tab === "diff") { if (this.git) this.renderGitDiff(); else this.renderDiff(); } else this.renderFile();
  }

  /** The turn's change to this file, from its git checkpoints (fetched once per open). */
  async renderGitDiff() {
    const body = this.body, p = this.path, jump = (n) => this.show("current", n);
    if (!this.gitDiff) {
      body.append(h("div", { class: "chat-files-note muted" }, "loading…"));
      let d;
      try { d = await call("GET", `${this.view.base}/chat/changes/file?${new URLSearchParams({ prompt: this.git.prompt, path: p })}`); }
      catch (e) { d = { error: e.message }; }
      if (this.path === p) this.gitDiff = d;
      if (this.body !== body) return;
      body.replaceChildren();
    }
    const d = this.gitDiff;
    body.append(h("div", { class: "chat-files-note muted" }, "Everything this turn changed in the file, from git (commands' changes included)."));
    if (d.error) body.append(h("div", { class: "chat-files-note bad" }, d.error));
    else if (d.binary) body.append(h("div", { class: "chat-files-note muted" }, "A binary file: nothing to show."));
    else if (!d.hunks.length) body.append(h("div", { class: "chat-files-note muted" }, "No changes in this file (only its mode, or it was changed and changed back)."));
    else body.append(diffView(d.hunks, false, jump));
  }

  /** Each edit's hunks, in order. A new line number jumps to that line of the file as it is now. */
  renderDiff() {
    const jump = (n) => this.show("current", n);
    this.edits.forEach((it, i) => {
      const box = h("div", { class: "chat-files-edit" });
      if (this.edits.length > 1) box.append(h("div", { class: "chat-files-edit-head muted" }, `Edit ${i + 1} of ${this.edits.length}`,
        h("span", { class: "chat-diffstat" }, h("span", { class: "add" }, `+${it.added}`), " ", h("span", { class: "del" }, `−${it.removed}`))));
      if (it.error) box.append(h("pre", { class: "chat-out bad" }, it.error));
      if (isOmitted(it.patch)) box.append(this.view.lazy(`Load the diff (${fmtBytes(it.patch.bytes)})`, it.patch.blob, (t) => diffView(JSON.parse(t), false, jump), this.agent));
      else if (it.patch) box.append(diffView(it.patch, false, jump));
      else box.append(h("div", { class: "muted" }, "no diff recorded"));
      this.body.append(box);
    });
  }

  rawUrl(p) {
    const q = new URLSearchParams({ path: p, raw: "1" }); if (token) q.set("token", token);
    return `/api${this.view.base}/chat/file?${q}`;
  }

  async renderFile() {
    const body = this.body, p = this.path;
    if (!this.file) {
      body.append(h("div", { class: "chat-files-note muted" }, "loading…"));
      let f;
      try { f = await call("GET", `${this.view.base}/chat/file?path=${encodeURIComponent(p)}`); }
      catch (e) { f = { error: e.message }; }
      if (this.path === p) this.file = f;
      if (this.body !== body) return; // redrawn, or another file opened, while this loaded
      body.replaceChildren();
    }
    const f = this.file;
    if (f.error) return body.append(h("div", { class: "chat-files-note bad" }, f.error));
    if (f.image) return body.append(h("div", { class: "chat-files-img" }, h("img", { src: `${this.rawUrl(p)}&v=${f.mtime}`, alt: p })));
    if (f.binary) return body.append(h("div", { class: "chat-files-note muted" }, `A binary file (${fmtBytes(f.size)}): nothing to show.`));
    body.append(this.tab === "preview" ? this.preview(f.text) : this.code(f.text));
  }

  /** The file with line numbers, highlighted (up to a size), the chosen line marked and scrolled to. */
  code(text) {
    const lines = text.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const code = h("code", {});
    const lang = text.length <= 300_000 ? langOf(this.path) : null;
    if (lang) { try { code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { code.textContent = text; } }
    else code.textContent = text;
    const line = Math.min(this.line, lines.length);
    const box = h("div", { class: "chat-code" },
      line ? h("div", { class: "chat-code-mark", style: `top:${(line - 1) * LINE_PX + CODE_PAD}px` }) : "",
      h("pre", { class: "chat-code-ln", "aria-hidden": "true" }, lines.map((_, i) => i + 1).join("\n")),
      h("pre", { class: "chat-code-tx" }, code));
    if (line) nextFrame(() => { this.body.scrollTop = Math.max(0, (line - 1) * LINE_PX - this.body.clientHeight / 3); });
    return box;
  }

  /** Rendered markdown. Images next to the file show (through the file endpoint); links to other files open here. */
  preview(text) {
    const el = h("div", { class: "md chat-files-md" });
    if (!window.marked || !window.DOMPurify) { el.textContent = text; el.style.whiteSpace = "pre-wrap"; return el; }
    el.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }), { FORBID_TAGS: ["style", "form", "input", "button", "iframe", "video", "audio"], FORBID_ATTR: ["style"] });
    highlightBlocks(el);
    const dir = this.path.replace(/\/[^/]*$/, "");
    const external = (u) => /^([a-z][\w+.-]*:|\/\/)/i.test(u);
    for (const img of el.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      // Remote images would be fetched from the viewer's browser on Claude's say-so: show what they are instead.
      if (!src || external(src)) { img.replaceWith(h("span", { class: "muted" }, `[image: ${img.getAttribute("alt") || src}]`)); continue; }
      let path; try { path = decodeURI(src.split(/[?#]/)[0]); } catch { path = src; }
      img.src = this.rawUrl(resolvePath(dir, path)); img.loading = "lazy";
    }
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (external(href)) continue;
      a.removeAttribute("target");
      let m; try { m = /^([^#?]*)(?:#L(\d+))?/.exec(decodeURI(href)); } catch { m = null; }
      a.addEventListener("click", (e) => { e.preventDefault(); if (m?.[1]) this.open({ path: resolvePath(dir, m[1]), line: Number(m[2]) || 0 }); });
    }
    return el;
  }
}

// ---------------------------------------------------------------- the composer (live runs of ours)
/** Built-in commands' menu flag lives on the server too; this is the fallback before the list loads. */
const isMenuCommand = (cmds, text) => {
  const m = /^(\/[\w:-]+)(\s+\S)?/.exec(text.trim());
  const c = m && cmds?.find((x) => x.name === m[1]);
  return Boolean(c?.menu && !(m[2] && (c.name === "/model" || c.name === "/effort")));
};

class Composer {
  constructor(view) {
    this.view = view;
    this.files = []; // {key, name, kind, url, id?, error?}
    this.commands = null; this.slashSel = 0;
    this.input = h("textarea", { class: "chat-input", rows: 1, placeholder: "Message Claude…", "aria-label": "message", spellcheck: "true" });
    this.input.value = Composer.drafts.get(view.base) || "";
    this.picker = h("input", { type: "file", multiple: true, hidden: true, onchange: () => { this.add([...this.picker.files]); this.picker.value = ""; } });
    this.attach = h("button", { class: "chat-attach", title: "attach images or files (or paste / drop them here)", "aria-label": "attach files", onclick: () => this.picker.click() }, "+");
    this.stop = h("button", { class: "chat-stop small", title: "interrupt Claude (Esc in the terminal)", onclick: () => this.interrupt() }, "■ Stop");
    this.send = h("button", { class: "chat-send primary", onclick: () => this.submit() }, "Send");
    this.chips = h("div", { class: "chat-chips" });
    this.slash = h("div", { class: "chat-slash", role: "listbox", hidden: true });
    this.ask = h("div", { class: "chat-ask", hidden: true });
    this.el = h("div", { class: "chat-compose" }, this.ask, this.slash, this.chips,
      h("div", { class: "chat-input-row" }, this.attach, this.input, this.stop, this.send), this.picker);
    this.input.addEventListener("input", () => { Composer.drafts.set(view.base, this.input.value); this.grow(); this.slashUpdate(); this.update(); });
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); this.add(files); }
    });
    view.root.addEventListener("dragover", (e) => { if (!this.disabled() && [...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); view.root.classList.add("drop"); } });
    view.root.addEventListener("dragleave", (e) => { if (e.target === view.root || !view.root.contains(e.relatedTarget)) view.root.classList.remove("drop"); });
    view.root.addEventListener("drop", (e) => { view.root.classList.remove("drop"); if (e.dataTransfer?.files?.length && !this.disabled()) { e.preventDefault(); this.add([...e.dataTransfer.files]); } });
    this.update();
    nextFrame(() => this.grow());
  }

  close() { for (const f of this.files) if (f.url) URL.revokeObjectURL(f.url); }

  disabled() { return this.view.readOnly || !this.view.loaded; }

  update() {
    const v = this.view, off = this.disabled();
    const uploading = this.files.some((f) => !f.id && !f.error);
    this.input.disabled = off;
    this.attach.disabled = off;
    this.input.placeholder = off ? (v.loaded ? "This run has ended" : "connecting…") : v.status === "waiting" ? (v.requests.length ? "Answer Claude above…" : "Claude is waiting on the terminal…") : v.status === "busy" ? "Queue a message for Claude…" : "Message Claude…";
    this.send.disabled = off || this.sending || uploading || v.status === "waiting" || (!this.input.value.trim() && !this.files.some((f) => f.id));
    this.send.textContent = v.status === "busy" ? "Queue" : "Send";
    this.stop.hidden = off || v.status !== "busy";
  }

  grow() { const t = this.input; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 220) + "px"; }

  key(e) {
    if (!this.slash.hidden) {
      const opts = this.slashMatches();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.slashSel = (this.slashSel + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length; this.slashRender(opts); return; }
      if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && opts.length) { e.preventDefault(); this.slashPick(opts[this.slashSel]); return; }
      if (e.key === "Escape") { e.preventDefault(); this.slash.hidden = true; return; }
    }
    if (e.key !== "Enter" || e.isComposing) return;
    // On a phone Enter is a new line (there's a Send button); elsewhere Shift/Alt+Enter is.
    const send = e.metaKey || e.ctrlKey || (!e.shiftKey && !e.altKey && !matchMedia("(pointer: coarse)").matches);
    if (send) { e.preventDefault(); this.submit(); }
  }

  // ---- the / list
  async slashUpdate() {
    const m = /^\/[\w:-]*$/.exec(this.input.value);
    if (!m) { this.slash.hidden = true; return; }
    if (!this.commands) {
      this.commands = [];
      try { this.commands = (await api("GET", `${this.view.base}/chat/commands`)).commands; } catch { this.commands = null; return; }
    }
    this.slashSel = 0;
    this.slashRender(this.slashMatches());
  }
  slashMatches() {
    const q = this.input.value.slice(1).toLowerCase();
    const all = this.commands || [];
    const starts = all.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
    const has = all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
    return [...starts, ...has].slice(0, 40);
  }
  slashRender(opts) {
    this.slash.hidden = !opts.length;
    this.slash.replaceChildren(...opts.map((c, i) => {
      const el = h("button", { class: `chat-slash-item${i === this.slashSel ? " sel" : ""}`, role: "option", "aria-selected": String(i === this.slashSel), onmousedown: (e) => { e.preventDefault(); this.slashPick(c); } },
        h("span", { class: "name" }, c.name),
        h("span", { class: "desc" }, c.description),
        c.menu ? h("span", { class: "chat-badge", title: "opens a menu: the view switches to the terminal" }, "terminal") : c.source !== "built-in" ? h("span", { class: "chat-badge" }, c.source) : "");
      if (i === this.slashSel) nextFrame(() => el.scrollIntoView({ block: "nearest" }));
      return el;
    }));
  }
  slashPick(c) {
    this.input.value = c.name + " ";
    Composer.drafts.set(this.view.base, this.input.value);
    this.slash.hidden = true;
    this.input.focus();
    this.update();
  }

  // ---- attachments: uploaded as soon as they're added, sent as upload ids
  add(list) {
    for (const file of list) {
      const f = { key: Math.random().toString(36).slice(2), name: file.name || "pasted image", kind: /^image\//.test(file.type) ? "image" : "file", url: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : "" };
      this.files.push(f);
      const name = file.name || `pasted.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
      call("POST", `${this.view.base}/uploads?name=${encodeURIComponent(name)}`, file, file.type || "application/octet-stream")
        .then((r) => { f.id = r.id; f.kind = r.kind; f.name = r.name; })
        .catch((e) => { f.error = e.message; toast(`couldn't upload ${f.name}: ${e.message}`); })
        .finally(() => { this.renderChips(); this.update(); });
    }
    this.renderChips(); this.update();
  }
  renderChips() {
    this.chips.replaceChildren(...this.files.map((f) => h("span", { class: `chat-chip${f.error ? " bad" : ""}`, title: f.error || f.name },
      f.url ? h("img", { src: f.url, alt: "" }) : h("span", { class: "chat-icon" }, "▤"),
      h("span", { class: "name" }, f.name),
      !f.id && !f.error ? h("span", { class: "chat-spin" }) : "",
      h("button", { class: "x", "aria-label": `remove ${f.name}`, onclick: () => { this.files = this.files.filter((x) => x !== f); if (f.url) URL.revokeObjectURL(f.url); this.renderChips(); this.update(); } }, "×"))));
  }

  // ---- sending
  async submit(draft = "") {
    if (this.send.disabled && !draft) return;
    const v = this.view;
    const text = this.input.value.replace(/\s+$/, "");
    const files = this.files.filter((f) => f.id);
    if (!text.trim() && !files.length) return;
    const p = draft ? this.retrying : { id: Math.random().toString(36).slice(2), text, images: files.length, state: "sending", at: Date.now() };
    this.ask.hidden = true;
    this.sending = true; this.update();
    if (!draft) v.addPending(p); else v.updatePending(p.id, { state: "sending", error: "" });
    try {
      const r = await call("POST", `${v.base}/chat/send`, { text, files: files.map((f) => f.id), draft });
      v.updatePending(p.id, { state: r.queued ? "queued" : "sent", at: Date.now() });
      this.input.value = ""; Composer.drafts.delete(v.base); this.grow();
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      this.files = this.files.filter((f) => !files.includes(f)); this.renderChips();
      if (r.opens_menu || isMenuCommand(this.commands, text)) { v.dropPending(p.id); if (v.onTerminal) { toast(`${text.split(/\s/)[0]} opens a menu: it's in the terminal`, true); v.onTerminal(); } }
    } catch (e) {
      if (e.status === 409 && e.data?.draft !== undefined) { this.retrying = p; v.updatePending(p.id, { state: "sending", error: "" }); this.askDraft(e.data.draft); }
      else v.updatePending(p.id, { state: "failed", error: e.message });
    } finally { this.sending = false; this.update(); }
  }

  /** Someone left text in the terminal's input box without sending it: our paste would land after it. */
  askDraft(draft) {
    const cancel = () => { this.ask.hidden = true; this.view.dropPending(this.retrying.id); this.retrying = null; this.input.focus(); };
    this.ask.hidden = false;
    this.ask.replaceChildren(
      h("div", {}, h("b", {}, "The terminal has an unsent draft: "), h("span", { class: "chat-ask-draft" }, draft.length > 240 ? draft.slice(0, 240) + "…" : draft)),
      h("div", { class: "row" },
        h("button", { class: "small primary", onclick: () => this.submit("replace") }, "Replace it"),
        h("button", { class: "small", onclick: () => this.submit("append") }, "Add mine after it"),
        h("button", { class: "small", onclick: cancel }, "Cancel")));
  }

  async interrupt() {
    this.stop.disabled = true;
    try { await call("POST", `${this.view.base}/chat/interrupt`); }
    catch (e) { toast(`couldn't stop: ${e.message}`); }
    finally { this.stop.disabled = false; }
  }
}
/** Unsent composer text per run, so flipping to the terminal and back keeps it. */
Composer.drafts = new Map();
