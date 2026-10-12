/*
 * Chat view: a Claude Code session as messages, tool rows, diffs and images, read live from its transcript
 * (server: src/chat, design: docs/rendered-view.md). On a live run of ours it has a composer, which types into the
 * TUI through the server (src/chat/input.ts); sessions lofiwave didn't start are read-only.
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
  if (window.hljs) for (const code of el.querySelectorAll("pre code[class*='language-']")) {
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1];
    if (lang && hljs.getLanguage(lang)) { try { hljs.highlightElement(code); } catch {} }
  }
  return el;
}

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
    this.scroller.append(this.top, this.list, this.pendingEl, this.state);
    this.composer = base.startsWith("/runs/") ? new Composer(this) : null;
    this.root.append(h("div", { class: "chat-main" }, this.scroller, this.jump), this.banner, this.composer?.el ?? "", this.footer());
    this.scroller.addEventListener("scroll", () => { this.atBottom = this.nearBottom(); this.jump.hidden = this.atBottom; ChatView.scrolls.set(this.base, this.atBottom ? null : this.scroller.scrollTop); });
    this.atBottom = true;
    this.connect();
  }

  footer() {
    return h("div", { class: "chat-foot muted" },
      h("span", { class: "chat-pill" }, h("span", { class: "dot" }), h("span", { class: "chat-pill-text" }, "")),
      h("span", { class: "chat-foot-note" }, this.composer ? "" : "Read-only: this session runs outside lofiwave."),
      this.onTerminal ? h("button", { class: "small", onclick: () => this.onTerminal() }, "Open terminal") : "",
    );
  }

  footNote() {
    if (!this.composer) return;
    $(".chat-foot-note", this.root).textContent = this.readOnly ? "Read-only: this run has ended."
      : this.status === "waiting" ? "Claude is waiting on the terminal; sending is paused."
      : this.status === "busy" ? "Messages sent now are queued until Claude finishes the current step."
      : matchMedia("(pointer: coarse)").matches ? "" : "Enter to send · Shift+Enter for a new line · / for commands";
  }

  close() { this.closed = true; clearTimeout(this.retry); clearTimeout(this.screenTimer); this.composer?.close(); try { this.ws?.close(); } catch {} }

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
      this.render();
    } else if (m.t === "status") {
      if (m.read_only !== undefined) this.readOnly = m.read_only;
      this.setStatus(m.status, m.waiting_for);
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
    // Claude is blocked on a dialog (permission, question, plan, a menu). Answering from here comes later (phase 3):
    // show what the terminal shows, and a way there.
    const waiting = this.status === "waiting";
    this.banner.hidden = !waiting;
    if (waiting && (was !== "waiting" || !this.banner.firstChild)) {
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
    this.composer?.update();
    this.footNote();
  }

  /** While Claude waits, a live snapshot of the bottom of the terminal, so a phone can see what it's asking. */
  async pollScreen() {
    clearTimeout(this.screenTimer);
    if (this.closed || this.status !== "waiting" || !this.screenEl) return;
    try {
      const r = await api("GET", `${this.base}/chat/screen?lines=16`);
      if (this.screenEl) { this.screenEl.textContent = r.text; this.screenEl.hidden = !r.text.trim(); }
    } catch { /* the run may just have ended */ }
    this.screenTimer = setTimeout(() => this.pollScreen(), 1500);
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

  /** A finished turn folds to "Worked for 2m 13s"; the live one shows everything. */
  renderTurn(turnId, items, isLast) {
    const live = isLast && this.status === "busy";
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
    return el;
  }

  /** Assistant text in full; runs of tool calls fold into one summary row (unless `flat`: already inside a fold). */
  renderBody(items, turnId, live, flat = false) {
    const out = [];
    for (let i = 0; i < items.length;) {
      const it = items[i];
      if (it.kind === "assistant") { out.push(h("div", { class: "chat-assistant" }, markdown(it.text))); i++; continue; }
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
      markdown(it.markdown || ""));
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
    if (it.status === "interrupted") badges.push(h("span", { class: "chat-badge warn" }, "interrupted"));
    if (it.background) badges.push(h("span", { class: "chat-badge" }, "background"));
    if (running) badges.push(this.status === "busy" || it.kind === "subagent" ? h("span", { class: "chat-spin", title: "running" }) : h("span", { class: "chat-badge" }, "no result"));
    const head = h(expandable ? "button" : "div", { class: `chat-row${open ? " open" : ""}${failed(it) ? " failed" : ""}`, ...(expandable ? { "aria-expanded": String(open), onclick: () => this.toggle(it.id, turnId) } : {}) },
      h("span", { class: expandable ? "chev" : "chev none" }), h("span", { class: "chat-icon" }, icon), h("span", { class: "chat-label" }, label), ...badges);
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
  lazy(label, ref, make) {
    const btn = h("button", { class: "small chat-more", onclick: async () => {
      btn.disabled = true; btn.textContent = "loading…";
      try { const out = make(await fetchText(this.blobPath(ref))); if (out) btn.replaceWith(out); else btn.remove(); }
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

/** A unified diff from structuredPatch hunks, with old and new line numbers. */
function diffView(hunks) {
  const rows = [];
  for (const hk of hunks || []) {
    let o = hk.oldStart, n = hk.newStart;
    rows.push(h("div", { class: "dl hunk" }, h("span", { class: "ln" }), h("span", { class: "ln" }), h("span", { class: "tx" }, `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`)));
    for (const line of hk.lines || []) {
      const s = line[0], tx = line.slice(1);
      if (s === "\\") continue;
      const cls = s === "+" ? "add" : s === "-" ? "del" : "";
      rows.push(h("div", { class: `dl ${cls}` }, h("span", { class: "ln" }, s === "+" ? "" : o), h("span", { class: "ln" }, s === "-" ? "" : n), h("span", { class: "tx" }, (s === "+" || s === "-" ? s : " ") + tx)));
      if (s !== "+") o++;
      if (s !== "-") n++;
    }
  }
  return h("div", { class: "chat-diff" }, ...rows);
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
    this.input.placeholder = off ? (v.loaded ? "This run has ended" : "connecting…") : v.status === "waiting" ? "Claude is waiting on the terminal…" : v.status === "busy" ? "Queue a message for Claude…" : "Message Claude…";
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
