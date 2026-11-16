/* lofiwave UI: the inbox, programmes, and the autopilot cards in Settings. Loaded before app.js; uses its helpers
   ($, h, get/post/put/del, guard, toast, …) only when called, never at load. */
const AP = (() => {
  // ---------------------------------------------------------------- helpers
  const money = (n) => (n === null || n === undefined ? "no cap" : `$${Number(n) >= 100 ? Math.round(n) : Number(n).toFixed(2).replace(/\.00$/, "")}`);
  const ago = (ms) => (ms ? fmtDur((Date.now() - ms) / 1000) : "–");
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "–");
  const typing = (el) => { const a = document.activeElement; return a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
  const openForms = (el) => Boolean(el.querySelector("details.ap-form[open]"));
  /** Redraw `el` only when its data changed, and never under someone's cursor. `force`: after an action of ours. */
  function draw(el, data, build, force = false) {
    const sig = JSON.stringify(data);
    if (!force && (el.dataset.sig === sig || typing(el) || openForms(el))) return;
    const y = window.scrollY;
    el.dataset.sig = sig;
    el.replaceChildren(...[build()].flat().filter(Boolean));
    window.scrollTo(0, y);
  }
  const act = (fn, after) => guard(async (...a) => { await fn(...a); await after?.(); });
  const pill = (text, cls = "") => h("span", { class: `pill ${cls}` }, text);
  const stateBadge = (s) => h("span", { class: `badge ap-state ${String(s).replace(/\s+/g, "-")}` }, s);
  const bar = (spent, cap) => h("div", { class: "ap-bar", title: `${money(spent)} of ${money(cap)}` },
    h("span", { class: "ap-bar-track" }, h("i", { class: cap !== null && cap !== undefined && spent >= cap ? "over" : cap && spent >= 0.8 * cap ? "near" : "", style: `width:${cap ? Math.min(100, (spent / cap) * 100) : 0}%` })),
    h("span", { class: "ap-bar-text" }, `${money(spent)} / ${money(cap)}`));
  const sessionLink = (runId, text = "Open session") => h("a", { class: "link", href: `#sessions/${runId}` }, text);
  const section = (title, count, ...body) => h("section", { class: "ap-section" }, h("h2", { class: "ap-h" }, title, count ? h("span", { class: "ap-count" }, String(count)) : ""), ...body);
  const empty = (text) => h("p", { class: "muted ap-empty" }, text);
  /** A line of small facts under a title. Strings become spans, so the gap between them applies. */
  const sub = (cls, ...parts) => h("div", { class: `ap-item-sub ${cls}` }, ...parts.flat().filter(Boolean).map((x) => (x.nodeType ? x : h("span", {}, String(x)))));
  const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

  /**
   * A dialog made on the spot: fields → values → `submit(values)`. A field is {name, label, type, value, options,
   * wide, placeholder, required, rows, help}; type: text | textarea | number | select | checkbox | path.
   */
  function form(title, fields, submit, { submitLabel = "Save", intro = "" } = {}) {
    const err = h("div", { class: "wide form-error", role: "alert", hidden: true });
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === "textarea") input = h("textarea", { name: f.name, rows: f.rows ?? 5, placeholder: f.placeholder, required: f.required }, f.value ?? "");
      else if (f.type === "select") { input = h("select", { name: f.name }, ...f.options.map((o) => h("option", { value: o.value ?? o }, o.label ?? o))); input.value = f.value ?? (f.options[0]?.value ?? f.options[0] ?? ""); }
      else if (f.type === "checkbox") input = h("input", { type: "checkbox", name: f.name, checked: Boolean(f.value) });
      else input = h("input", { name: f.name, type: f.type === "number" ? "number" : "text", step: f.type === "number" ? "any" : null, min: f.type === "number" ? "0" : null, value: f.value ?? "", placeholder: f.placeholder, required: f.required, autocomplete: "off", list: f.list });
      inputs[f.name] = input;
      if (f.type === "checkbox") return h("label", { class: "wide row" }, input, f.label);
      const wrapped = f.type === "path" ? h("span", { class: "pp" }, input) : input;
      return h("label", { class: f.wide || f.type === "textarea" ? "wide" : "" }, f.label, wrapped, f.help ? h("small", { class: "muted" }, f.help) : "");
    });
    const dlg = h("dialog", { class: "ap-dialog" });
    const close = () => { dlg.close(); dlg.remove(); };
    const el = h("form", { class: "grid", method: "dialog", onsubmit: async (e) => {
      e.preventDefault();
      const v = {};
      for (const f of fields) v[f.name] = f.type === "checkbox" ? inputs[f.name].checked : inputs[f.name].value;
      try { await submit(v); close(); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    } },
      h("h3", { class: "wide" }, title), intro ? h("p", { class: "wide muted hint" }, intro) : "", ...rows, err,
      h("div", { class: "wide row" }, h("button", { type: "submit", class: "primary" }, submitLabel), h("button", { type: "button", style: "margin-left:auto", onclick: close }, "Cancel")));
    dlg.append(el);
    dlg.addEventListener("cancel", () => setTimeout(() => dlg.remove(), 0));
    document.body.append(dlg);
    for (const f of fields) if (f.type === "path") attachPathPicker(inputs[f.name]);
    dlg.showModal();
    (Object.values(inputs).find((i) => i.type !== "checkbox") ?? el).focus();
    return dlg;
  }
  const toggle = (on, fn, label) => h("button", { class: `on-toggle ${on ? "on" : ""}`, role: "switch", "aria-checked": String(Boolean(on)), "aria-label": label, title: label, onclick: fn });

  // ---------------------------------------------------------------- badge in the nav
  let lastNeeds = 0;
  const loadBadge = async () => {
    try {
      const d = await get("/inbox");
      inboxData = d;
      setBadge(d.needs_you);
    } catch { /* offline: the connection pill says so */ }
  };
  function setBadge(n) {
    lastNeeds = n;
    const b = $("#inbox-count");
    if (!b) return;
    b.textContent = String(n); b.hidden = !n;
    document.title = n ? `(${n}) lofiwave` : "lofiwave";
  }

  // ---------------------------------------------------------------- inbox
  let inboxData = null, suggestions = [], focusId = null;

  async function loadInbox(force = false) {
    const [d, items, people] = await Promise.all([get("/inbox"), get("/items?status=open&limit=500"), get("/people")]).catch((e) => { toast(e.message); return []; });
    if (!d) return;
    inboxData = d; setBadge(d.needs_you);
    const el = $("#ap-inbox");
    draw(el, [d.asks.map((a) => [a.id, a.status]), d.prompts.map((p) => p.id), d.stalls.map((s) => [s.run_id, s.what, s.since]), d.items, items, d.recent.map((a) => [a.id, a.policy_id]), people, suggestions, d.channels], () => renderInbox(d, items, people), force);
    if (focusId) {
      const card = document.getElementById(focusId);
      if (card) { card.scrollIntoView({ block: "center" }); card.classList.add("ap-focus"); setTimeout(() => card.classList.remove("ap-focus"), 2500); focusId = null; }
    }
  }
  const reloadInbox = () => loadInbox(true);

  function renderInbox(d, items, people) {
    const team = items.filter((i) => i.kind !== "signal"), signals = items.filter((i) => i.kind === "signal");
    const mineIds = new Set(d.items.map((i) => i.id));
    const byOwner = new Map();
    for (const i of team) { const k = i.owner || "nobody yet"; (byOwner.get(k) ?? byOwner.set(k, []).get(k)).push(i); }
    return [
      section("Needs you", d.needs_you,
        ...suggestions.map(suggestCard),
        d.needs_you ? "" : empty("Nothing is waiting on you."),
        ...d.asks.map(askCard), ...d.prompts.map(promptCard), ...d.stalls.map(stallCard),
        d.channels.length ? "" : h("p", { class: "muted ap-note" }, "Notifications aren't set up, so asks only show here. ", h("a", { class: "link", href: "#settings" }, "Settings → Notifications"))),
      section("On you", d.items.length, d.items.length ? h("div", { class: "ap-list" }, ...d.items.map((i) => itemRow(i))) : empty("No open items with your name on them.")),
      section("Team", team.length,
        addItemForm(people),
        ...[...byOwner].sort(([a], [b]) => a.localeCompare(b)).map(([owner, list]) => h("div", { class: "ap-group" }, h("h3", { class: "ap-sub" }, owner, h("span", { class: "ap-count" }, String(list.length))), h("div", { class: "ap-list" }, ...list.map((i) => itemRow(i, mineIds.has(i.id)))))),
        team.length ? "" : empty("No open items.")),
      section("Signals", signals.length, signals.length ? h("div", { class: "ap-list" }, ...signals.map((i) => itemRow(i))) : empty("No product signals filed. The Slack intake playbook (Settings → Playbooks) files them.")),
      section("Recently decided", 0, d.recent.length ? h("div", { class: "ap-list" }, ...d.recent.map(recentRow)) : empty("No answers yet.")),
    ];
  }

  function askCard(a) {
    const note = h("input", { type: "text", placeholder: a.options.length ? "Add a note, or say what to do instead" : "Your answer", "aria-label": "Answer text" });
    const always = h("input", { type: "checkbox" });
    const scope = h("select", { "aria-label": "Where the rule applies" }, ...(a.programme ? [h("option", { value: "programme" }, `in ${a.programme.name}`)] : []), h("option", { value: "everywhere" }, "everywhere"));
    const maxAmount = h("input", { type: "number", min: "0", step: "any", value: a.amount ?? "", "aria-label": "Highest cap the rule may grant", class: "ap-amount" });
    const send = (option) => act(async () => {
      const body = { text: note.value.trim() };
      if (option) body.option = option;
      if (always.checked && option) { body.always = true; body.everywhere = scope.value === "everywhere"; if (a.kind === "budget") body.max_amount = numOrNull(maxAmount.value); }
      const r = await post(`/asks/${a.id}/answer`, body);
      toast(r.policy ? `answered, and rule #${r.policy.id} made` : "answered", true);
      if (r.suggest_rule) suggestions.push({ ...r.suggest_rule, programme: r.programme });
    }, reloadInbox);
    return h("article", { class: "ap-card ap-ask", id: `ap-ask-${a.id}` },
      h("div", { class: "ap-card-top" },
        h("span", { class: "ap-from" }, a.from, a.programme ? h("span", { class: "muted" }, ` · ${a.programme.name}`) : ""),
        a.for_person ? pill(`for ${a.for_person}`) : "", a.class ? pill(a.class.replace(/_/g, " ")) : "", a.kind !== "question" && a.kind !== a.class ? pill(a.kind) : "",
        h("span", { class: "muted ap-wait" }, `waiting ${ago(a.created_at)}`)),
      h("h3", { class: "ap-title" }, a.title),
      a.body ? h("pre", { class: "ap-body" }, a.body) : "",
      a.kind === "budget" && a.amount !== null ? h("p", { class: "ap-amount-line" }, "Asks to raise its cap to ", h("b", {}, money(a.amount))) : "",
      a.run_status && a.run_status !== "running" ? h("p", { class: "muted ap-note" }, `Its run has ${a.run_status === "queued" ? "not started yet" : "ended"} (${a.run_status}): the answer is recorded, and is read when the session is resumed.`) : "",
      a.options.length ? h("div", { class: "ap-options" }, ...a.options.map((o) => h("button", { class: `ap-option ${o.recommended ? "rec" : ""}`, onclick: send(o.id) },
        h("span", { class: "ap-option-label" }, h("b", {}, /^(approve|deny|yes|no)$/i.test(o.id) ? "" : `${o.id}  `), o.label, o.recommended ? h("span", { class: "ap-rec" }, "recommended") : ""),
        o.detail ? h("small", { class: "muted" }, o.detail) : ""))) : "",
      h("div", { class: "ap-answer" }, note, h("button", { class: a.options.length ? "small" : "small primary", onclick: () => (note.value.trim() ? send("")() : toast("type what to do first")) }, a.options.length ? "Send this instead" : "Send answer")),
      a.can_have_rule && a.options.length ? h("label", { class: "ap-always" }, always, h("span", {}, `Always answer ${a.class} asks this way`), scope, a.kind === "budget" ? h("span", { class: "row" }, "up to $", maxAmount) : "") : "",
      a.class && !a.can_have_rule ? h("p", { class: "muted ap-note" }, `${a.class} decisions are always asked: they can't be given to a rule.`) : "",
      h("div", { class: "ap-card-foot" }, a.run_id ? sessionLink(a.run_id) : "", h("span", { class: "muted" }, `ask #${a.id}`),
        h("button", { class: "small danger", onclick: () => form(`Withdraw ask #${a.id}`, [{ name: "why", label: "Why (optional)", wide: true }], async (v) => { await post(`/asks/${a.id}/cancel`, { why: v.why }); toast("withdrawn", true); reloadInbox(); }, { submitLabel: "Withdraw" }) }, "Withdraw")));
  }

  function suggestCard(s, i) {
    const drop = () => { suggestions.splice(i, 1); reloadInbox(); };
    return h("article", { class: "ap-card ap-suggest" },
      h("p", {}, `You've answered ${s.class} asks the same way ${s.count} times (“${s.label}”). Make it a rule?`),
      h("div", { class: "row" },
        h("button", { class: "small primary", onclick: act(async () => {
          const r = await post("/policies", { class: s.class, answer: s.answer, programme: s.programme_id ?? undefined, max_amount: s.max_amount ?? undefined });
          toast(`rule #${r.id} made: ${s.class} asks are answered without asking`, true); suggestions.splice(i, 1);
        }, reloadInbox) }, s.programme ? `Make it a rule in ${s.programme.name}` : "Make it a rule"),
        h("button", { class: "small", onclick: drop }, "Not now")));
  }

  const shortInput = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v?.command ?? v?.file_path ?? v ?? "", null, 0); return s.length > 400 ? s.slice(0, 400) + "…" : s; };
  const promptCard = (p) => h("article", { class: "ap-card ap-prompt" },
    h("div", { class: "ap-card-top" }, h("span", { class: "ap-from" }, p.label, p.programme ? h("span", { class: "muted" }, ` · ${p.programme.name}`) : ""), pill(p.kind), h("span", { class: "muted ap-wait" }, `waiting ${ago(p.created_at)}`)),
    h("h3", { class: "ap-title" }, p.kind === "question" ? "Claude has a question" : p.kind === "plan" ? "Claude has a plan to approve" : `Wants to use ${p.tool_name}`),
    h("pre", { class: "ap-body" }, shortInput(p.tool_input)),
    h("div", { class: "ap-card-foot" }, sessionLink(p.run_id, "Answer in chat")));

  const stallCard = (s) => h("article", { class: "ap-card ap-stall" },
    h("div", { class: "ap-card-top" }, h("span", { class: "ap-from" }, s.label, s.programme ? h("span", { class: "muted" }, ` · ${s.programme.name}`) : ""), pill("parked")),
    h("p", {}, s.what === "waiting" ? `Waiting on a prompt in its terminal for ${ago(s.since)}${s.waiting_for ? ` (${s.waiting_for})` : ""}.` : `Idle for ${ago(s.since)} without reporting done or blocked.`),
    h("div", { class: "ap-card-foot" }, sessionLink(s.run_id)));

  const closeItem = (i, status) => form(`${status === "done" ? "Done" : "Drop"}: ${i.title}`, [{ name: "note", label: "Note (optional)", wide: true, placeholder: status === "done" ? "how you know it's done" : "why it's not worth doing" }],
    async (v) => { await put(`/items/${i.id}`, { status, ...(v.note.trim() ? { note: v.note.trim() } : {}) }); toast(status === "done" ? "done" : "dropped", true); reloadInbox(); }, { submitLabel: status === "done" ? "Mark done" : "Drop it" });

  function itemRow(i, mine = false) {
    return h("div", { class: `ap-item ${i.overdue ? "overdue" : ""}`, id: `ap-item-${i.id}` },
      h("div", { class: "ap-item-main" },
        h("div", { class: "ap-item-title" }, i.priority === "high" ? h("span", { class: "ap-high", title: "high priority" }, "!") : "", i.title),
        sub("muted",
          pill(i.kind), mine ? pill("you", "on") : "", i.programme ? pill(i.programme.name) : "",
          i.due_at ? h("span", { class: i.overdue ? "ap-overdue" : "" }, `due ${new Date(i.due_at).toLocaleDateString()}${i.overdue ? " (overdue)" : ""}`) : "",
          i.source ? (/^https?:\/\//.test(i.source) ? h("a", { class: "link", href: i.source, target: "_blank", rel: "noopener" }, "source ↗") : h("span", {}, i.source)) : "",
          i.nudges ? h("span", {}, `followed up ${i.nudges}×`) : ""),
        i.body ? h("div", { class: "ap-item-body muted" }, i.body) : "",
        i.note ? h("div", { class: "ap-item-body muted" }, i.note) : ""),
      h("div", { class: "ap-item-acts" }, h("button", { class: "small", onclick: () => closeItem(i, "done") }, "Done"), h("button", { class: "small danger", onclick: () => closeItem(i, "dropped") }, "Drop")));
  }

  function addItemForm(people) {
    const f = h("form", { class: "grid", onsubmit: act(async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      await post("/items", { title: v.title, owner: v.owner.trim(), kind: v.kind, priority: v.priority, due: v.due || undefined, body: v.body });
      toast("added", true); f.reset(); f.closest("details").open = false;
    }, reloadInbox) },
      h("label", { class: "wide" }, "What", h("input", { name: "title", required: true, autocomplete: "off", placeholder: "one line a stranger could act on" })),
      h("label", {}, "Who holds it", h("input", { name: "owner", list: "ap-people", autocomplete: "off", placeholder: "a name, or agent" })),
      h("label", {}, "Kind", h("select", { name: "kind" }, ...["do", "decide", "verify", "risk", "signal"].map((k) => h("option", {}, k)))),
      h("label", {}, "Due", h("input", { name: "due", type: "date" })),
      h("label", {}, "Priority", h("select", { name: "priority" }, h("option", { value: "med" }, "medium"), h("option", { value: "high" }, "high"), h("option", { value: "low" }, "low"))),
      h("label", { class: "wide" }, "Details (optional)", h("textarea", { name: "body", rows: 2 })),
      h("div", { class: "wide row" }, h("button", { type: "submit", class: "primary small" }, "Add item")));
    return h("details", { class: "ap-form" }, h("summary", {}, "+ Add an item"), h("datalist", { id: "ap-people" }, ...people.map((p) => h("option", { value: p.name })), h("option", { value: "agent" })), f);
  }

  function recentRow(a) {
    const said = [a.answer_label, a.answer_text].filter(Boolean).join(". ") || "(no text)";
    const rule = a.answered_via === "rule";
    return h("div", { class: "ap-item" },
      h("div", { class: "ap-item-main" },
        h("div", { class: "ap-item-title" }, a.title),
        sub("", h("b", {}, said), h("span", { class: "muted" }, rule ? `rule #${a.policy_id} (set by ${a.answered_by || "someone"})` : `by ${a.answered_by || "someone"}`), h("span", { class: "muted" }, fmtRel(a.answered_at)),
          h("span", { class: "muted" }, `from ${a.from}`), a.delivered === 0 ? pill("not yet delivered to the run") : "")),
      h("div", { class: "ap-item-acts" },
        rule ? h("button", { class: "small danger", onclick: () => confirmDo(`Turn rule #${a.policy_id} off? ${a.class} asks will be asked again.`, async () => { await put(`/policies/${a.policy_id}`, { enabled: false }); toast("rule turned off", true); reloadInbox(); }) }, "Turn this rule off") : "",
        a.run_id ? sessionLink(a.run_id, "Session") : ""));
  }

  // ---------------------------------------------------------------- programmes
  let progSlug = null, progEvents = [];
  const setHash = (hash) => history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
  function openProgramme(slug) {
    progSlug = slug;
    const el = $("#ap-programmes");
    if (el) delete el.dataset.sig;
    if (activeTab === "programmes") { setHash(slug ? `programmes/${slug}` : ""); loadProgrammes(true); }
  }

  async function loadProgrammes(force = false) {
    const el = $("#ap-programmes");
    try {
      if (!progSlug) { const list = await get("/programmes"); return draw(el, ["list", list], () => renderProgrammeList(list), force); }
      const [p, events] = await Promise.all([get(`/programmes/${progSlug}`), get(`/programmes/${progSlug}/events?since=0`)]);
      progEvents = events;
      draw(el, [p.id, p, events.length, events[0]?.id], () => renderProgramme(p, events), force);
    } catch (e) { toast(e.message); if (progSlug) openProgramme(null); }
  }
  const reloadProg = () => loadProgrammes(true);

  const countsLine = (c) => Object.entries(c).map(([k, n]) => `${n} ${k}`).join(" · ") || "no workers yet";
  function renderProgrammeList(list) {
    return [
      h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: newProgramme }, "+ New programme"), h("span", { class: "muted" }, list.length ? `${list.length} programme${list.length === 1 ? "" : "s"}` : "")),
      list.length ? h("div", { class: "ap-grid" }, ...list.map((p) => h("button", { class: "ap-card ap-prog", onclick: () => openProgramme(p.slug) },
        h("div", { class: "ap-card-top" }, h("span", { class: "ap-prog-name" }, p.name), stateBadge(p.status), p.open_asks ? pill(`${p.open_asks} waiting on a person`, "warn") : ""),
        p.goal ? h("p", { class: "muted ap-clamp" }, p.goal) : "",
        bar(p.spent, p.budget_usd),
        h("div", { class: "muted ap-item-sub" }, countsLine(p.worker_counts)),
        p.summary ? h("p", { class: "ap-clamp" }, p.summary.split("\n")[0]) : "")))
      : h("div", { class: "card" }, h("h2", {}, "No programmes yet"), h("p", { class: "muted" }, "A programme is a line of work run by several agents over time: a goal, a standing brief every worker gets, rules, a budget, and a record of what was decided and produced. Workers reach you through the inbox instead of waiting in a terminal.")),
    ];
  }

  const newProgramme = () => form("New programme", [
    { name: "name", label: "Name", required: true },
    { name: "budget_usd", label: "Budget (USD, blank = no cap)", type: "number" },
    { name: "goal", label: "Goal", type: "textarea", rows: 2, placeholder: "what this line of work is for" },
    { name: "folder", label: "Folder", type: "path", wide: true, placeholder: "where its workers' folders live", help: "Each worker gets a folder of its own under it; PROGRAMME.md is written here." },
    { name: "brief", label: "Standing brief", type: "textarea", rows: 8, placeholder: "what every worker must know: scope, decisions already made, where things are, rules" },
  ], async (v) => {
    const p = await post("/programmes", { name: v.name, goal: v.goal, folder: v.folder.trim(), brief: v.brief, budget_usd: numOrNull(v.budget_usd) });
    toast("programme created", true); openProgramme(p.slug);
  }, { submitLabel: "Create" });

  function renderProgramme(p, events) {
    const api = `/programmes/${p.slug}`;
    const status = h("select", { "aria-label": "Status", onchange: act(async (e) => { await put(api, { status: e.target.value }); }, reloadProg) }, ...["active", "paused", "done"].map((s) => h("option", {}, s)));
    status.value = p.status;
    const editBudget = () => form(`Budget of ${p.name}`, [{ name: "budget_usd", label: "Budget (USD, blank = no cap)", type: "number", value: p.budget_usd ?? "", wide: true }],
      async (v) => { await put(api, { budget_usd: numOrNull(v.budget_usd) }); reloadProg(); });
    const lessons = p.rules.filter((r) => r.kind === "lesson"), rules = p.rules.filter((r) => r.kind === "rule");
    return [
      h("div", { class: "toolbar" }, h("button", { class: "small", onclick: () => openProgramme(null) }, "← All programmes"),
        h("button", { class: "primary small", onclick: () => startWorker(p) }, "+ Start worker"),
        h("a", { class: "link right", href: `/api/programmes/${p.slug}/context${token ? `?token=${encodeURIComponent(token)}` : ""}`, target: "_blank", rel: "noopener" }, "Context as workers read it ↗")),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, p.name, " ", h("code", { class: "mono muted" }, p.slug)), h("label", { class: "row muted" }, "Status", status)),
        p.goal ? h("p", {}, p.goal) : "",
        h("div", { class: "ap-kv" },
          h("div", {}, h("span", { class: "muted" }, "Spend"), bar(p.spent, p.budget_usd), h("button", { class: "small", onclick: editBudget }, "Change budget")),
          p.spend_by_bucket.length ? h("div", {}, h("span", { class: "muted" }, "By bucket"), h("span", {}, p.spend_by_bucket.map((b) => `${b.bucket || "other"} ${money(b.total)}`).join(" · "))) : "",
          h("div", {}, h("span", { class: "muted" }, "Folder"), h("code", { class: "mono" }, p.folder ? shortCwd(p.folder) : "none")),
          h("div", {}, h("span", { class: "muted" }, "Waiting on a person"), p.open_asks ? h("a", { class: "link", href: "#inbox" }, `${p.open_asks} ask${p.open_asks === 1 ? "" : "s"}`) : h("span", {}, "nothing")))),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Where it stands"), h("button", { class: "small", onclick: () => form("Where it stands", [{ name: "text", label: "Summary", type: "textarea", rows: 10, value: p.summary, required: true }], async (v) => { await put(`${api}/summary`, { text: v.text }); reloadProg(); }) }, p.summary ? "Edit" : "Write one")),
        p.summary ? h("pre", { class: "ap-body" }, p.summary) : h("p", { class: "muted" }, "No summary yet. The controller rewrites it each pass; a person can too."),
        p.summary_at ? h("p", { class: "muted ap-note" }, `Written ${fmtRel(p.summary_at)} by ${p.summary_by || "someone"}`) : ""),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Workers"), h("span", { class: "muted" }, countsLine(p.worker_counts))),
        p.workers.length ? h("table", { class: "ap-table" },
          h("thead", {}, h("tr", {}, ...["State", "Worker", "Says", "Spend", ""].map((x) => h("th", {}, x)))),
          h("tbody", {}, ...p.workers.map((w) => workerRow(p, w)))) : empty("No workers yet. Start one, or set up the controller to do it.")),
      briefCard(p),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Rules and lessons"), h("button", { class: "small", onclick: () => form(`Rule for ${p.name}`, [{ name: "title", label: "Title (optional)" }, { name: "body", label: "Rule", type: "textarea", rows: 3, required: true }], async (v) => { await post("/rules", { programme: p.slug, title: v.title, body: v.body }); reloadProg(); }, { submitLabel: "Add rule", intro: "Running workers are told at once; later ones get it at start." }) }, "+ Add rule")),
        h("p", { class: "muted" }, "Rules are yours; lessons are what workers recorded for the next ones. Global rules (Settings) apply here too."),
        rules.length || lessons.length ? h("div", { class: "ap-list" }, ...[...rules, ...lessons].map((r) => ruleRow(r, reloadProg))) : empty("None yet.")),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Decisions"), h("button", { class: "small", onclick: () => form("Record a decision", [{ name: "title", label: "What was decided", required: true, wide: true }, { name: "body", label: "Why, or what it settles (optional)", type: "textarea", rows: 3 }], async (v) => { await post(`${api}/entries`, { kind: "decision", title: v.title, body: v.body }); reloadProg(); }, { submitLabel: "Record", intro: "Workers treat a recorded decision as settled." }) }, "+ Record a decision")),
        p.decisions.length ? h("div", { class: "ap-list" }, ...p.decisions.map((d) => h("div", { class: "ap-item" }, h("div", { class: "ap-item-main" },
          h("div", { class: "ap-item-title" }, d.title),
          sub("muted", h("b", {}, d.by || "unknown"), when(d.at), d.ask_id ? h("span", {}, `ask #${d.ask_id}`) : "", d.run_id ? sessionLink(d.run_id, `run ${d.run_id}`) : ""),
          d.body ? h("div", { class: "ap-item-body muted" }, d.body) : "")))) : empty("None yet. Answered asks land here with who answered.")),
      h("div", { class: "card" }, h("h2", {}, "Figures"), h("p", { class: "muted" }, "The numbers workers quote. Recording a key again supersedes the old value."),
        entryTable(p.figures, ["Key", "Value", "Measured on", "By", "When"], (f) => [h("code", { class: "mono" }, f.key), h("b", {}, f.value), f.body, f.by, when(f.at)])),
      h("div", { class: "card" }, h("h2", {}, "Published outputs"),
        entryTable(p.outputs, ["Key", "Version", "Where", "What", "By", "When"], (o) => [h("code", { class: "mono" }, o.key), o.value, h("code", { class: "mono" }, o.path), o.body, o.by, when(o.at)])),
      controllerCard(p),
      h("div", { class: "card" }, h("h2", {}, "Activity"),
        events.length ? h("div", { class: "ap-events" }, ...events.slice(0, 60).map((e) => h("div", { class: "ap-event" }, h("span", { class: "muted mono" }, when(e.at)), pill(e.kind.replace(/_/g, " ")), h("span", {}, e.text)))) : empty("Nothing yet.")),
    ];
  }

  function entryTable(rows, head, cells) {
    if (!rows.length) return empty("None yet.");
    return h("table", { class: "ap-table" }, h("thead", {}, h("tr", {}, ...head.map((x) => h("th", {}, x)))),
      h("tbody", {}, ...rows.map((r) => h("tr", { class: r.superseded_by ? "ap-superseded" : "", title: r.superseded_by ? "superseded by a later entry" : null }, ...cells(r).map((c, i) => h("td", { "data-label": head[i] }, c ?? ""))))));
  }

  function workerRow(p, w) {
    const says = w.outcome ? [h("b", {}, `${w.outcome.outcome}: `), w.outcome.summary, w.outcome.report_path ? h("div", { class: "muted mono" }, `report: ${w.outcome.report_path}`) : ""] : w.status_line || h("span", { class: "muted" }, "–");
    const live = w.status === "running" || w.status === "queued";
    return h("tr", {},
      h("td", { "data-label": "State" }, stateBadge(w.state), w.open_asks ? h("a", { class: "link ap-inline", href: "#inbox" }, `${w.open_asks} ask${w.open_asks === 1 ? "" : "s"}`) : ""),
      h("td", { "data-label": "Worker" }, h("b", {}, w.worker || `run ${w.run_id}`), w.role === "controller" ? pill("controller") : "",
        h("div", { class: "muted" }, `run ${w.run_id} · ${live ? `up ${ago(w.started_at)}` : `ended ${fmtRel(w.ended_at)}`}${w.started_by ? ` · by ${String(w.started_by).replace(/^key:/, "")}` : ""}`),
        w.brief_current ? "" : h("div", {}, pill(`on brief v${w.brief_seen}, current is v${p.brief_version}`, "warn"))),
      h("td", { "data-label": "Says", class: "full" }, says),
      h("td", { "data-label": "Spend" }, bar(w.spent, w.budget_usd)),
      h("td", { class: "row" },
        sessionLink(w.run_id, live ? "Open session" : "Session"),
        h("button", { class: "small", onclick: () => form(`Budget of ${w.worker || `run ${w.run_id}`}`, [{ name: "budget_usd", label: "Budget (USD, blank = no cap)", type: "number", value: w.budget_usd ?? "", wide: true }], async (v) => { await put(`/runs/${w.run_id}/budget`, { budget_usd: numOrNull(v.budget_usd) }); reloadProg(); }) }, "Budget"),
        live ? h("button", { class: "small danger", onclick: () => confirmDo(`Stop ${w.worker || `run ${w.run_id}`}?`, async () => { await post(`/runs/${w.run_id}/kill`); toast("stopped", true); reloadProg(); }) }, "Stop") : ""));
  }

  const startWorker = (p) => form(`Start a worker in ${p.name}`, [
    { name: "worker", label: "Worker name", required: true, placeholder: "e.g. depth" },
    { name: "type", label: "Agent", type: "select", options: types.filter((t) => t.kind === "agent").map((t) => t.name), value: typeByName("claude") ? "claude" : undefined },
    { name: "budget_usd", label: "Budget (USD, blank = no cap)", type: "number" },
    { name: "brief", label: "Brief", type: "textarea", rows: 10, required: true, placeholder: "what to do, what to read first, what to produce" },
  ], async (v) => {
    const r = await post(`/programmes/${p.slug}/workers`, { worker: v.worker, type: v.type, brief: v.brief, budget_usd: v.budget_usd === "" ? undefined : Number(v.budget_usd) });
    toast(`worker ${v.worker} is run ${r.id}${r.status === "queued" ? " (queued: the machine is full)" : ""}`, true); reloadProg();
  }, { submitLabel: "Start", intro: p.folder ? `Its folder is ${shortCwd(p.folder)}/<name>, with the brief written there as BRIEF.md. The programme's context goes in its system prompt.` : "This programme has no folder yet: set one first." });

  function briefCard(p) {
    const body = h("textarea", { rows: Math.min(24, Math.max(8, p.brief.split("\n").length + 2)), "aria-label": "Standing brief" }, p.brief);
    const note = h("input", { type: "text", placeholder: "what changed, in a line (workers are told)", "aria-label": "What changed" });
    const shown = h("div", { class: "ap-version", hidden: true });
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, `Standing brief${p.brief_version ? ` · v${p.brief_version}` : ""}`),
        h("span", { class: "muted" }, p.workers.some((w) => w.status === "running" && !w.brief_current) ? "some running workers haven't been given this version yet" : "")),
      h("p", { class: "muted" }, "What every worker gets. Saving a change makes a new version and tells running workers what changed."),
      body,
      h("div", { class: "ap-answer" }, note, h("button", { class: "primary small", onclick: act(async () => { if (body.value.trim() === p.brief.trim()) return toast("nothing changed"); await put(`/programmes/${p.slug}/brief`, { body: body.value, note: note.value }); toast("brief saved; running workers are being told", true); document.activeElement?.blur(); }, reloadProg) }, "Save new version")),
      p.briefs.length ? h("details", { class: "ap-versions" }, h("summary", { class: "muted" }, `${p.briefs.length} version${p.briefs.length === 1 ? "" : "s"}`),
        h("div", { class: "ap-list" }, ...p.briefs.map((v) => h("div", { class: "ap-item" }, h("div", { class: "ap-item-main" }, h("div", { class: "ap-item-title" }, `v${v.version}${v.note ? `: ${v.note}` : ""}`), sub("muted", v.by || "someone", when(v.at))),
          h("div", { class: "ap-item-acts" }, h("button", { class: "small", onclick: guard(async () => { const full = await get(`/programmes/${p.slug}/briefs/${v.version}`); shown.replaceChildren(h("div", { class: "muted" }, `v${v.version}`), h("pre", { class: "ap-body" }, full.body)); shown.hidden = false; }) }, "View"))))), shown) : "");
  }

  function ruleRow(r, after) {
    return h("div", { class: `ap-item ${r.enabled ? "" : "off"}` },
      h("div", { class: "ap-item-main" }, h("div", { class: "ap-item-title" }, r.title ? h("b", {}, `${r.title}: `) : "", r.body),
        sub("muted", pill(r.kind), r.scope === "global" ? pill(r.applies === "all" ? "every agent run" : "programme runs") : "", r.by ? `by ${r.by}` : "", when(r.created_at))),
      h("div", { class: "ap-item-acts" },
        toggle(r.enabled, act(() => put(`/rules/${r.id}`, { enabled: !r.enabled }), after), r.enabled ? "On: turn off" : "Off: turn on"),
        h("button", { class: "small", onclick: () => form("Edit rule", [{ name: "title", label: "Title (optional)", value: r.title }, ...(r.scope === "global" ? [{ name: "applies", label: "Applies to", type: "select", value: r.applies, options: [{ value: "programme", label: "programme runs" }, { value: "all", label: "every agent run" }] }] : []), { name: "body", label: "Rule", type: "textarea", rows: 4, value: r.body, required: true }], async (v) => { await put(`/rules/${r.id}`, v); after(); }) }, "Edit"),
        h("button", { class: "small danger", onclick: () => confirmDo("Delete this rule?", async () => { await del(`/rules/${r.id}`); after(); }) }, "Delete")));
  }

  function controllerCard(p) {
    const wf = p.controller_workflow ? workflows.find((w) => w.id === p.controller_workflow) : null;
    const setup = () => form(`Controller of ${p.name}`, [
      { name: "schedule", label: "Schedule (cron; empty = only when a worker reports or ends)", value: wf?.schedule ?? "", placeholder: "0 */2 * * *", wide: true, help: "min hour day month weekday. A schedule is a heartbeat on top of the wake-ups." },
      { name: "type", label: "Agent", type: "select", options: types.filter((t) => t.kind === "agent").map((t) => t.name), value: wf?.type_name ?? (typeByName("claude") ? "claude" : undefined) },
      { name: "cwd", label: "Folder", type: "path", value: wf?.cwd ?? p.folder, placeholder: "blank = the programme's folder" },
    ], async (v) => { await post(`/programmes/${p.slug}/controller`, { schedule: v.schedule.trim(), type: v.type, cwd: v.cwd.trim() }); toast("controller set up", true); await loadWorkflows(); reloadProg(); }, { submitLabel: wf ? "Save" : "Set up" });
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Controller"), h("button", { class: "small", onclick: setup }, p.controller_workflow ? "Change" : "Set up")),
      h("p", { class: "muted" }, "A run that reads the programme from lofiwave each time it wakes: checks finished workers' reports, restarts or unblocks stuck ones, stops idle ones, starts the next wave, rewrites the summary, and raises what a person must decide. It keeps nothing in its own memory, so any session can take over."),
      p.controller_workflow
        ? h("p", {}, wf ? [`Workflow “${wf.name}”: `, wf.schedule ? h("code", { class: "mono" }, wf.schedule) : "wakes on worker events only", wf.enabled ? "" : " (disabled)", wf.next_run_at ? h("span", { class: "muted" }, ` · next ${fmtRel(wf.next_run_at)}`) : "", wf.last_run ? h("span", { class: "muted" }, ` · last run ${wf.last_run.status} ${fmtRel(wf.last_run.started_at)}`) : ""] : `Set up (workflow #${p.controller_workflow}).`)
        : empty("Not set up: nobody acts when a worker finishes or stalls until a person looks."));
  }

  // ---------------------------------------------------------------- settings cards
  async function loadSettings(force = false) {
    const el = $("#ap-settings");
    if (!el) return;
    let d;
    try { d = await Promise.all([get("/rules"), get("/policies"), get("/guards"), get("/autopilot/settings"), get("/people"), get("/playbooks"), inboxData ?? get("/inbox"), get("/programmes")]); }
    catch (e) { return toast(e.message); }
    const [rules, policies, guards, notif, people, playbooks, inbox, programmes] = d;
    draw(el, [rules, policies, guards, notif.settings, notif.channels, notif.sent.length, notif.sent[0]?.at, people, playbooks, programmes.map((p) => p.slug), workflows.map((w) => [w.name, w.schedule])],
      () => renderSettingsCards({ rules, policies, guards, notif, people, playbooks, never: inbox.never_auto ?? [], classes: inbox.classes ?? [], programmes }), force);
  }
  const reloadSettings = () => loadSettings(true);

  function renderSettingsCards({ rules, policies, guards, notif, people, playbooks, never, classes, programmes }) {
    return [
      h("div", { class: "card", id: "ap-set-rules" },
        h("div", { class: "card-head" }, h("h2", {}, "Global rules"), h("button", { class: "primary small", onclick: () => form("Global rule", [
          { name: "title", label: "Title (optional)", placeholder: "Worktrees and PRs" },
          { name: "applies", label: "Applies to", type: "select", options: [{ value: "programme", label: "programme runs" }, { value: "all", label: "every agent run" }] },
          { name: "body", label: "Rule", type: "textarea", rows: 4, required: true, placeholder: "Work in a git worktree and publish work as a pull request." },
        ], async (v) => { await post("/rules", v); reloadSettings(); }, { submitLabel: "Add rule" }) }, "+ New rule")),
        h("p", { class: "muted" }, "Standing instructions every run starts with: how to work, where to compute, how to publish. Runs already going are told when one is added or changed."),
        rules.length ? h("div", { class: "ap-list" }, ...rules.map((r) => ruleRow(r, reloadSettings))) : empty("None yet.")),

      h("div", { class: "card", id: "ap-set-policies" },
        h("div", { class: "card-head" }, h("h2", {}, "Delegation rules"), h("button", { class: "primary small", onclick: () => form("Delegation rule", [
          { name: "class", label: "Class of ask", list: "ap-classes", required: true, placeholder: "merge" },
          { name: "answer", label: "Answer", required: true, value: "approve", help: "approve / deny, or an option's label" },
          { name: "programme", label: "Where", type: "select", options: [{ value: "", label: "everywhere" }, ...programmes.map((p) => ({ value: p.slug, label: `in ${p.name}` }))] },
          { name: "max_amount", label: "Up to (USD; required for budget)", type: "number" },
          { name: "note", label: "Note sent with the answer (optional)", wide: true },
        ], async (v) => { await post("/policies", { class: v.class, answer: v.answer, programme: v.programme || undefined, max_amount: v.max_amount === "" ? undefined : Number(v.max_amount), note: v.note }); reloadSettings(); }, { submitLabel: "Add rule" }) }, "+ New rule")),
        h("datalist", { id: "ap-classes" }, ...classes.filter((c) => !never.includes(c)).map((c) => h("option", { value: c }))),
        h("p", { class: "muted" }, "Asks of a class that are answered without asking you. Each use is logged, and shows under Inbox → Recently decided. ", never.length ? `Never delegated, always asked: ${never.join(", ").replace(/_/g, " ")}.` : ""),
        policies.length ? h("div", { class: "ap-list" }, ...policies.map((p) => h("div", { class: `ap-item ${p.enabled ? "" : "off"}` },
          h("div", { class: "ap-item-main" },
            h("div", { class: "ap-item-title" }, h("b", {}, p.class), " asks → ", h("b", {}, p.answer), p.max_amount !== null ? ` up to ${money(p.max_amount)}` : ""),
            sub("muted", pill(p.programme ? `in ${p.programme.name}` : "everywhere"), `rule #${p.id}`, `set by ${p.created_by || "someone"}`, p.from_ask ? `from ask #${p.from_ask}` : "", `used ${p.applied_count}×`, p.last_applied_at ? `last ${fmtRel(p.last_applied_at)}` : ""),
            p.note ? h("div", { class: "ap-item-body muted" }, p.note) : "",
            p.recent.length ? h("div", { class: "ap-item-body muted" }, "Answered: ", p.recent.map((a) => `“${a.title}”`).join(", ")) : ""),
          h("div", { class: "ap-item-acts" },
            toggle(p.enabled, act(() => put(`/policies/${p.id}`, { enabled: !p.enabled }), reloadSettings), p.enabled ? "On: turn off" : "Off: turn on"),
            h("button", { class: "small danger", onclick: () => confirmDo(`Delete rule #${p.id}?`, async () => { await del(`/policies/${p.id}`); reloadSettings(); }) }, "Delete"))))) : empty("None yet. Tick “Always answer … this way” on an ask to make one.")),

      h("div", { class: "card", id: "ap-set-guards" },
        h("div", { class: "card-head" }, h("h2", {}, "Guards"), h("button", { class: "primary small", onclick: () => guardForm(null) }, "+ New guard")),
        h("p", { class: "muted" }, "Commands no run may execute, checked before each Bash call of a Claude session on this machine and refused with the reason. Not covered: scripts an agent writes and runs, Codex, runs in a sandbox or a container."),
        h("div", { class: "ap-list" }, ...guards.map((g) => h("div", { class: `ap-item ${g.enabled ? "" : "off"}` },
          h("div", { class: "ap-item-main" },
            h("div", { class: "ap-item-title" }, h("b", {}, g.name), g.builtin ? pill("built in") : "", g.when === "over_budget" ? pill("only over budget", "warn") : ""),
            h("div", { class: "ap-item-body" }, h("code", { class: "mono ap-wrap" }, g.pattern), g.unless ? [h("span", { class: "muted" }, " unless "), h("code", { class: "mono ap-wrap" }, g.unless)] : ""),
            h("div", { class: "ap-item-body muted" }, g.message),
            sub("muted", `blocked ${g.hits}×`, g.last_hit_at ? `last ${fmtRel(g.last_hit_at)}` : "")),
          h("div", { class: "ap-item-acts" },
            toggle(g.enabled, act(() => put(`/guards/${g.id}`, { enabled: !g.enabled }), reloadSettings), g.enabled ? "On: turn off" : "Off: turn on"),
            h("button", { class: "small", onclick: () => guardForm(g) }, "Edit"),
            g.builtin ? "" : h("button", { class: "small danger", onclick: () => confirmDo(`Delete guard "${g.name}"?`, async () => { await del(`/guards/${g.id}`); reloadSettings(); }) }, "Delete")))))),

      notifyCard(notif),

      h("div", { class: "card", id: "ap-set-people" },
        h("div", { class: "card-head" }, h("h2", {}, "People"), h("button", { class: "primary small", onclick: () => personForm(null) }, "+ Add person")),
        h("p", { class: "muted" }, "Who items and asks can be addressed to. With a Slack bot token and their Slack id, follow-ups reach them directly."),
        people.length ? h("table", { class: "ap-table" }, h("thead", {}, h("tr", {}, ...["Name", "Signs in as", "Slack id", "Notes", ""].map((x) => h("th", {}, x)))),
          h("tbody", {}, ...people.map((p) => h("tr", {}, h("td", { "data-label": "Name" }, h("b", {}, p.name)), h("td", { "data-label": "Signs in as" }, p.login), h("td", { "data-label": "Slack id", class: "mono" }, p.slack_id), h("td", { "data-label": "Notes", class: "full" }, p.notes),
            h("td", { class: "row" }, h("button", { class: "small", onclick: () => personForm(p) }, "Edit"), h("button", { class: "small danger", onclick: () => confirmDo(`Remove ${p.name}?`, async () => { await del(`/people/${p.id}`); reloadSettings(); }) }, "Remove")))))) : empty("Nobody yet.")),

      h("div", { class: "card", id: "ap-set-playbooks" },
        h("h2", {}, "Playbooks"),
        h("p", { class: "muted" }, "Ready-made unattended runs. Setting one up makes a workflow you can edit under Workflows."),
        h("div", { class: "ap-list" }, ...playbooks.map((pb) => {
          const wf = workflows.find((w) => w.name === pb.title);
          return h("div", { class: "ap-item" },
            h("div", { class: "ap-item-main" }, h("div", { class: "ap-item-title" }, h("b", {}, pb.title)), h("div", { class: "ap-item-body muted" }, pb.description),
              sub("muted", wf ? [pill("set up", "on"), wf.schedule ? h("code", { class: "mono" }, wf.schedule) : "manual only", wf.next_run_at ? `next ${fmtRel(wf.next_run_at)}` : ""] : `suggested: ${pb.schedule}`)),
            h("div", { class: "ap-item-acts" }, h("button", { class: "small", onclick: () => form(pb.title, [
              { name: "schedule", label: "Schedule (cron; empty = manual only)", value: wf?.schedule ?? pb.schedule, wide: true, help: "min hour day month weekday" },
              { name: "type", label: "Agent", type: "select", options: types.filter((t) => t.kind === "agent").map((t) => t.name), value: wf?.type_name ?? (typeByName("claude") ? "claude" : undefined) },
              { name: "cwd", label: "Folder", type: "path", value: wf?.cwd ?? "", placeholder: "blank = your home folder" },
            ], async (v) => { const r = await post(`/playbooks/${pb.name}/workflow`, { schedule: v.schedule.trim(), type: v.type, cwd: v.cwd.trim() }); toast(`workflow “${r.name}” saved`, true); await loadWorkflows(); reloadSettings(); }, { submitLabel: wf ? "Save" : "Set up", intro: pb.description }) }, wf ? "Change" : "Set up")));
        }))),
    ];
  }

  const guardForm = (g) => form(g ? `Guard ${g.name}` : "New guard", [
    { name: "name", label: "Name", value: g?.name, required: true },
    { name: "when", label: "When", type: "select", value: g?.when ?? "always", options: [{ value: "always", label: "always" }, { value: "over_budget", label: "only when the run is over budget" }] },
    { name: "pattern", label: "Pattern (regular expression tested against the command)", value: g?.pattern, required: true, wide: true },
    { name: "unless", label: "Unless (a regular expression that lets a matching command through; optional)", value: g?.unless, wide: true },
    { name: "message", label: "What the agent is told", type: "textarea", rows: 3, value: g?.message },
  ], async (v) => { g ? await put(`/guards/${g.id}`, v) : await post("/guards", v); reloadSettings(); });

  const personForm = (p) => form(p ? p.name : "Add a person", [
    { name: "name", label: "Name", value: p?.name, required: true },
    { name: "login", label: "Signs in to lofiwave as", value: p?.login },
    { name: "slack_id", label: "Slack member id", value: p?.slack_id, placeholder: "U0123ABCD" },
    { name: "notes", label: "Notes (role, language, what to know when writing to them)", type: "textarea", rows: 2, value: p?.notes },
  ], async (v) => { p ? await put(`/people/${p.id}`, v) : await post("/people", v); reloadSettings(); });

  function notifyCard(n) {
    const inputs = {};
    const save = act(async () => {
      const patch = {};
      for (const s of n.settings) { const v = inputs[s.key].value; if (s.secret ? v.trim() !== "" : v !== s.value) patch[s.key] = v; }
      if (!Object.keys(patch).length) return toast("nothing changed");
      await put("/autopilot/settings", patch); toast("saved", true); document.activeElement?.blur();
    }, reloadSettings);
    return h("div", { class: "card", id: "ap-set-notify" },
      h("div", { class: "card-head" }, h("h2", {}, "Notifications"),
        h("span", { class: "row" }, ...(n.channels.length ? n.channels.map((c) => pill(c, "on")) : [pill("no channel set up")]),
          h("button", { class: "small", disabled: !n.channels.length, onclick: act(async () => { const r = await post("/autopilot/notify-test"); const bad = r.sent.filter((s) => !s.ok); toast(bad.length ? `test failed on ${bad.map((s) => `${s.channel}: ${s.error}`).join("; ")}` : "test sent", !bad.length); }, reloadSettings) }, "Send a test"))),
      h("p", { class: "muted" }, "Where asks, finished and blocked runs, parked sessions and the digest go. Each has a link back to the inbox when the console's address is set. Answers are given in the inbox, not in Slack."),
      h("form", { class: "grid", onsubmit: (e) => { e.preventDefault(); save(); } }, ...n.settings.map((s) => {
        const input = h("input", { type: s.secret ? "password" : "text", autocomplete: "off", value: s.secret ? "" : s.value, placeholder: s.secret ? (s.value ? `${s.value} (${s.source}); type to replace` : "not set") : "" });
        inputs[s.key] = input;
        return h("label", {}, h("span", {}, s.key.replace(/_/g, " "), s.source && !s.secret ? h("span", { class: "muted" }, ` (${s.source})`) : ""), input, h("small", { class: "muted" }, s.help),
          s.secret && s.source === "saved" ? h("button", { type: "button", class: "small ap-clear", onclick: act(() => put("/autopilot/settings", { [s.key]: "" }), reloadSettings) }, "Clear") : "");
      }), h("div", { class: "wide row" }, h("button", { type: "submit", class: "primary small" }, "Save notifications"))),
      n.sent.length ? h("details", { class: "ap-versions" }, h("summary", { class: "muted" }, `Recently sent (${n.sent.length})${n.sent.some((s) => !s.ok) ? ", some failed" : ""}`),
        h("div", { class: "ap-events" }, ...n.sent.map((s) => h("div", { class: "ap-event" }, h("span", { class: "muted mono" }, when(s.at)), pill(s.channel), h("span", { class: s.ok ? "" : "ap-overdue" }, s.ok ? "sent" : `failed: ${s.error}`))))) : "");
  }

  // ---------------------------------------------------------------- session list tags
  const railSig = (r) => { const x = r.autopilot; return x ? [x.programme?.slug, x.worker, x.outcome?.outcome, x.open_asks] : null; };
  function railTags(r) {
    const x = r.autopilot;
    if (!x) return "";
    const live = r.status === "running";
    return h("div", { class: "rail-sub ap-rail" },
      x.programme ? h("span", { class: "wf-tag ap-prog-tag", title: `programme ${x.programme.name}${x.worker ? `, worker ${x.worker}` : ""}: open it`, onclick: (e) => { e.stopPropagation(); e.preventDefault(); switchTab("programmes", false); openProgramme(x.programme.slug); } }, `◆ ${x.programme.name}`) : "",
      x.open_asks && live ? h("span", { class: "badge ap-state needs-you", title: "it raised an ask that nobody has answered" }, "needs you") : "",
      x.outcome ? h("span", { class: `badge ap-state ${x.outcome.outcome}`, title: x.outcome.summary }, x.outcome.outcome) : "");
  }

  // ---------------------------------------------------------------- deep links
  /** `#inbox`, `#inbox/ask/3`, `#inbox/item/4`, `#programmes/<slug>`. `first`: the page just opened. Returns whether it took the link. */
  async function route(hash, first) {
    const parts = hash.replace(/^#/, "").split("/");
    if (parts[0] === "inbox") {
      focusId = parts[1] === "ask" && parts[2] ? `ap-ask-${parts[2]}` : parts[1] === "item" && parts[2] ? `ap-item-${parts[2]}` : null;
      switchTab("inbox", false);
      return true;
    }
    if (parts[0] === "programmes") {
      progSlug = parts[1] ? decodeURIComponent(parts[1]) : null;
      const el = $("#ap-programmes"); if (el) delete el.dataset.sig;
      switchTab("programmes", false);
      return true;
    }
    // Opened with no link: land on the inbox when something is waiting.
    if (first && !parts[0]) {
      await loadBadge();
      if (lastNeeds > 0) { switchTab("inbox", false); return true; }
    }
    return false;
  }

  return { loadBadge, loadInbox, loadProgrammes, loadSettings, openProgramme, route, railSig, railTags };
})();
