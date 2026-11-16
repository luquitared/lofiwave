# Autopilot: agents that run without someone watching

_Design, 2026-11-14. Built on `lucas/autopilot`. How to use it is in the README (*Autopilot*); this says why it is shaped
the way it is, and what it does not do._

## The problem

lofiwave could start an agent, type into it, read its screen and tell whether it was working. What it could not do
is let you stop looking. Reading several weeks of sessions on two machines showed the same things each time:

- **Nothing reached a person.** An agent that needed a decision wrote a question in its terminal and stopped. It
  was found when someone happened to look: usually within minutes, sometimes after days. A good share of sessions
  ended on a question nobody answered.
- **Nothing said "finished".** Most runs ended because someone stopped them by hand. A finished run, a stuck run
  and a run waiting on a person looked the same in the list.
- **The same decisions were asked again and again.** Merge this, raise that budget, shut down that finished
  worker: the answer was nearly always yes, and it was typed each time. The decisions that needed thought (sending
  something to a customer, deleting data, anything about money owed) were asked in the same way as the routine ones.
- **Approvals had no author.** They were relayed as message text ("the owner says go"), and at least once an agent
  driving another took the model's own suggested prompt in an input box for a person's approval.
- **Limits lived in prompts.** Budgets, "don't kill the shared tmux server" and "no persistent spot requests" were
  sentences in a brief. Each was broken at least once.
- **Long work kept its state in one conversation.** A multi-agent programme was held together by a controller
  session on someone's laptop: which worker was which, what had been decided, what each could spend. Shared context
  was a brief file edited by hand; running workers learned of a change only if someone told each of them; figures
  quoted to others drifted between files; the lessons of one wave reached the next only if pasted into its briefs.

## The shape

One new thing an agent can do, and one new thing lofiwave keeps.

**An agent can reach a person**: an *ask* (a question, an approval, a budget request, with options and a
recommendation) and an *outcome* (done, blocked, failed, with a summary and a report). Both go to people where they
already are (Slack, Telegram, a webhook) and to an Inbox. The answer comes back into the run as a message that says
who gave it.

**lofiwave keeps what must outlive a session**: who answered what (the decision log), the answers that became rules,
and for a *programme* its standing brief, rules, lessons, figures, outputs, budgets and summary.

Everything else follows from those two.

### Why asks are structured

A question typed in a terminal can't be routed, counted, answered from a phone, or learned from. An ask has a
`class` (what kind of decision it is), options, and an amount when it is about money. That is what makes the rest
possible: the same card in Slack and the Inbox, an answer recorded with its author, and a rule that recognises the
next ask of the same kind.

The agent's side is a command, `lw`, not an MCP server or a tool definition: it works in any agent that can run a
shell command (Claude Code, Codex, a script), needs no per-agent setup, and is easy to test with a shell script
standing in for the agent.

### Why rules are confirmed, not inferred

"It learns what to ask you" could mean a model deciding, from past answers, what you would say. That is the wrong
place for a guess: the cost of a wrong auto-approval is high and nobody would know it happened. So learning is
explicit. lofiwave notices that three asks of a class got the same answer and *offers* a rule; a person makes it;
it applies only to asks of that class whose options include that answer, and (for budgets) only up to a ceiling;
each use is logged and listed under the rule; turning it off is one click. Some classes can never have a rule:
sending things out, deleting, billing, credentials, data leaving the company.

This depends on agents classifying their asks honestly, which they do when told the classes in their system
prompt. An ask with no class, or a class with no rule, simply goes to a person, so the failure mode of a
misclassified ask is an extra question, not a silent approval, except for an agent that labels a customer email
`merge`. That one the `class` can't catch; the guard on what the run may execute, and the review of what rules
answered (in the digest), are the backstops.

### Why guards are a hook

A limit in a prompt is a request. Claude Code's `PreToolUse` hook lets lofiwave refuse a Bash command before it
runs, and tell the agent why. That is used for the handful of commands whose cost is out of proportion (ending
every session on the machine, a spot fleet that relaunches itself, starting machines when over budget), and for
whatever you add. It is deliberately narrow: it matches command lines with regular expressions, it only exists for
interactive claude runs on this machine, and an agent can route around it by writing a script. It turns "the agent
forgot the rule" from an incident into a refused command; it is not a sandbox. For that, use a run target.

Budgets are the same idea one level up. Spend is what the worker reports (`lw spend`), because lofiwave has no way
to meter a cloud account; the cap is enforced where lofiwave can act (commands that start machines are refused once
over, and people are told), and raising it is an ask.

### Why a programme is files and a database

Agents are good with files, and a brief has to be readable by a person with `cat`. But a file edited by hand has no
history, no author, and no way to tell the workers already running that it changed. So the database is the source
(versions, authors, who has which version, what supersedes what) and the file is generated from it: one
`CONTEXT.md` per programme, rewritten on every change, which every worker is pointed at and can reprint with
`lw context`.

Two rules keep it honest:

- **A decision has an author and is written by a person.** A run can't record one; it gets one by having an ask
  answered. The context lists decisions as settled.
- **A figure has one current value.** Recording a figure again supersedes the old one, which is kept but no longer
  shown. Workers are told to quote figures from the context, not from memory.

Changes travel. A new brief version, a new rule or a lesson is typed into each running worker as a message that
starts `[lofiwave]`, with the lines that changed; it waits if the worker is at a prompt and is retried until it
lands or the run ends.

### Why the controller is a playbook

The controller that held a programme together was a long conversation, so the programme stopped when that session
did. Here the controller is a fixed set of instructions run by a fresh session each time: read the programme, check
what finished, deal with what is stuck, start what the brief plans, rewrite the summary, ask what only a person can
decide, stop. It is woken by events (a worker reported or ended) and optionally by a schedule. Because it carries
nothing between passes, it can run on the machine the workers run on, be restarted, or be done by a person.

It starts workers through the same API a person does, and starting a wave the brief did not plan is an ask.

### Managing people

Follow-up between people was done by nudging. The ledger is the same list for agents and people: an item has an
owner and a date, and lofiwave follows up with the owner when the date passes. Items arrive from agents, from
people, and from *intake* runs that read where people already write (Slack, the endings of sessions) and file what
they find, keyed by source so a second pass adds nothing. Intake is an agent run with a playbook, not an
integration: lofiwave does not hold a Slack token for reading, the agent's own connector does.

Product signals are items of kind `signal`, and one playbook turns the strongest into one-page specs and an ask.

## What it does not do

- **Answering from Slack or Telegram.** Notifications carry a link to the Inbox card. Buttons in the message need a
  Slack app with a public interactivity endpoint, or a Telegram bot being polled; neither is built.
- **Stop a determined run.** Decisions are refused to calls that carry a run id, but a run holds the console's
  token (its hooks need it) and could call the API without saying who it is. With sign-ins for people and API keys
  for agents the record at least shows which kind of caller answered. Per-run tokens with a narrower scope would
  close it.
- **Meter spend.** Budgets work on what workers report.
- **Cover everything with guards.** Bash command lines in local claude runs only (see above).
- **Runs on targets or in containers.** They can't reach the console, so they have no `lw`, no programme context and
  no guards.
- **Codex.** It gets the instructions and `lw`; it has no hooks here, so no guards, and its activity is read off
  the screen, so stall detection is coarser.
- **One console per machine.** A programme lives in one lofiwave. Sessions on another machine don't show in its
  Inbox (ideas-fridge §3, federation).

## Where things are

| | |
|---|---|
| `src/autopilot/schema.ts` | the tables |
| `src/autopilot/core.ts` | settings, the event log, notifications, the outbox of messages owed to runs |
| `src/autopilot/asks.ts` | asks, answers, delegation rules |
| `src/autopilot/programmes.ts` | programmes, the brief, rules and lessons, entries, spend, outcomes, the context document |
| `src/autopilot/guards.ts` | guards and the `PreToolUse` hook |
| `src/autopilot/items.ts` | the ledger and people |
| `src/autopilot/playbooks.ts` | the controller's and the intake runs' prompts |
| `src/autopilot/tick.ts` | background work: delivery, ends, stalls, waking the controller, the digest |
| `src/autopilot/routes.ts` | the HTTP API, and the `lw` shim |
| `scripts/lw.ts` | the `lw` command |
| `public/autopilot.js` | Inbox, Programmes and the Settings cards |
| `test/autopilot.e2e.test.ts`, `test/autopilot.test.ts` | a programme run end to end with script workers; the pure parts |

`src/runner.ts` knows none of this: it exposes two hooks (`runHooks.context`, `runHooks.started`) that the autopilot
modules fill in.
