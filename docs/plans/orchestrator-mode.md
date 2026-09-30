---
title: Orchestrator mode plan
created: 2026-09-30
updated: 2026-09-30
status: planned (from a grilling session, 2026-09-30)
---

# Orchestrator mode plan

An **orchestrator** is a chat node that takes one large task, splits it into tickets and drives
each ticket to a merge on its own: it spawns one **ticket session** per ticket in its own
worktree, lets Jev choose each ticket's model through a **tier mapping**, merges the results in
dependency order and finishes with a list of what needs human review. It runs fully
autonomously; the human steers through the canvas, the configuration and the review list.

Builds on: the Jev router experiment (`docs/research/jev-model-routing.md`,
`.agents/skills/route-claude-ticket/`), worktrees as first-class canvas entities, the session
outcome index, and the terminal-context server's lazy local listener with per-agent tokens
(`src/main/terminal-context-mcp.ts`).

## Decisions

### Shape

- **Toucan spawns the ticket sessions, not the agent's own subagent tool.** Only a
  Toucan-launched ACP session gets an exact model and effort at launch, appears on the canvas,
  can be steered or taken over, and leaves a session outcome record. With the provider's
  subagent tool the route would be requested, not confirmed, and invisible.
- **A CLI, not an MCP server.** The orchestrator drives Toucan through a node script shipped
  with its skill (the `settle-worktree.mjs` / `route-ticket.mjs` pattern). It costs no tool
  definition tokens in sessions that never orchestrate and works identically for any provider
  that has a shell. The CLI is a thin client: Toucan's main process owns the ACP sessions, so
  the CLI calls a local endpoint in main (plain JSON over 127.0.0.1, bound lazily, like the
  terminal-context listener).
- **Claude only in the first version.** The design carries a provider field so Codex can be
  added without reshaping it.

### The orchestrator node

- A dedicated node kind, created from the canvas context menu (**New orchestrator**) - not a
  launch toggle, which is easy to forget and hides the capability. It is a chat node with
  `role: 'orchestrator'` and a distinct header badge; an ordinary chat can never become one.
- Its first prompt is the task. The orchestration instructions are on its system prompt, so no
  slash command is needed.
- Its model is the user's choice in the node's model picker, defaulting to the model the tier
  mapping gives `frontier`. Breaking a task down and resolving merge trouble is architecture
  work and is never routed.
- The header carries **Stop orchestration** (stops every ticket session) and, while paused,
  **Resume now**.

### Authority of the spawn token

The token is minted when the orchestrator node launches and passed to the session in its
environment, like `TOUCAN_NODE_ID`. Every call is checked in main at call time:

- only Claude ticket sessions, only in the orchestrator's own project, only into worktrees the
  orchestration created;
- ticket sessions get no token, so orchestrators never nest;
- ticket sessions inherit the orchestrator's permission mode;
- at most 20 spawns per orchestration (retries and escalations count);
- closing the orchestrator node revokes the token.

There is deliberately **no concurrency cap**: how many sessions run at once is the human's
responsibility. Only the dependency graph limits it - a ticket starts when none of its blockers
is unmerged.

### Plan and state: the orchestration record

State is not tied to any ticket system. Toucan keeps one **orchestration record** per
orchestrator conversation in userData (a `durable-json-store`): the task, and per ticket its id,
title, body or source reference, `blocked_by`, route, spawned session, attempts and merge
status. The orchestrator writes it through the CLI; a resumed orchestrator (or a restarted
Toucan) rebuilds its picture from it, never from memory.

- Input is either free text, which becomes a plan held only in the record, or a reference to a
  tracker item, which the orchestrator reads with whatever tools its session has (`gh`, a
  connector, files).
- **Tracker write-back is required, not optional**, but done by the orchestrator with its own
  tools, so no tracker is built in: mark a ticket in progress on spawn, close it with the commit
  link on merge, comment the reason when it fails or stays unmerged. Every write-back that
  failed is listed in the final answer. Toucan's `TicketSource` seam can list and set status
  but cannot create or comment, so it is not the write path.

### Routing: difficulty tiers

- **Jev judges the task, the human judges the models.** Jev is shown the tickets, never the
  model list: it returns a **difficulty tier** (`low` / `medium` / `high` / `frontier`) and a
  reasoning-depth score per ticket, all tickets in one call. Passing models to Jev would make it
  route on the pickers' one-line marketing descriptions ("For your toughest challenges").
- The **tier mapping** in the configuration turns a tier into a model from the same list the
  chat node's model picker shows, optionally with an effort. Toucan maps the depth score to the
  nearest effort that model's picker offers. Defaults: low → Haiku, medium → Sonnet 5.5,
  high → Opus 5.5, frontier → Opus 5.5 at max effort.
- A mapped model that the picker no longer lists falls back to the next tier up, reported.
- Jev's confidence gates the route: below the threshold the ticket still runs on its tier and
  is marked for review.
- **Jev unavailable** (no `TYPESAFE_API_KEY`, timeout, error): the orchestrator picks the tier
  itself with the same criteria. Such routes are tagged `routedBy: orchestrator`, kept out of
  Jev's statistics and named in the final answer. Toucan shows before launch whether Jev is
  reachable.
- **Escalation** after a failed ticket: one tier up, at most up to `frontier`; a failure there
  goes to the review list.
- Every route is recorded as `route:` fields (tier, model, effort, confidence, routedBy,
  escalated) in the ticket session's outcome record and in the orchestration record.
- After each orchestration Toucan reports success and escalation rates per tier and model and
  proposes mapping changes when the evidence supports one ("high → Sonnet 5.5: 9/10 without
  escalation"). It never changes the mapping itself; the human applies it, or asks an agent to.

### Ticket sessions

- `spawn` creates the worktree through Toucan (including the project's setup command), starts a
  Claude chat in it with the resolved model and effort, and draws it on the worktree's canvas,
  titled `#<id> <title>`. An **orchestrated-by** edge links it to the orchestrator: a
  projection of persisted node data like the lineage edge, never drawn or removed by hand, and
  it grants nothing.
- The prompt is the configured **implementation skill** (default `/implement`) with the ticket
  body, followed by the **ticket contract**: stay in the given worktree, commit to its branch,
  never push, merge or open a PR, and end with a final report of verification commands,
  unresolved review findings and open questions. The contract wins over the skill.
- The no-push rule is enforced, not only requested: the spawned worktree gets a `pre-push` hook
  that refuses. Ticket branches are never pushed; only the target branch is (see Merging).
- The orchestrator may answer a ticket session's *questions* with a follow-up. It never answers
  *permission* prompts: one agent granting another rights the human did not grant is
  escalation. Those wait for the human and are listed in the orchestrator's status and final
  answer.

### Waking the orchestrator

The orchestrator does not wait inside Bash (10-minute tool timeout; a ticket can take an hour).
Background Bash plus the CLI's own task-notification wake-up does work under the pinned
adapter, but Toucan sees no turn for that cycle, so the node would look idle while working.
Instead the orchestrator ends its turn after spawning, and **Toucan sends it a follow-up
prompt** through `promptWhenIdle` whenever a ticket session completes, fails or asks
something ("#12 completed, 4 files, outcome record <path>"). Toucan owns the turn, so the node
shows real working state, and this carries over to other providers unchanged.

### Merging

- The target is the branch the orchestrator was launched on. The orchestrator refuses to start
  on a dirty working tree, and creates the upstream (`git push -u origin <branch>`) at start
  when there is none.
- Per ticket, one at a time, in dependency order: rebase the ticket branch onto the target,
  run the full test suite in the ticket's worktree, `git merge --ff-only` in the orchestrator's
  checkout, push. A rejected push means fetch, rebase, re-test, retry. No PRs.
- A rebase conflict goes back to the ticket's own session, which knows what the change was for.
  After two failed attempts the ticket stays unmerged, goes to the review list, and its
  dependents stay blocked.
- When the orchestration finishes, merged worktrees and their local ticket branches are removed
  in one step (their canvas groups go with them; transcripts stay in History). Unmerged
  worktrees stay for the human.

### Usage limits

Every session shares the account's quota, so the orchestrator cannot handle its own limit.
Toucan owns the pause: on a usage-limit error from any session of the orchestration it marks
the orchestration `paused`, spawns nothing and does not wake the orchestrator. At the reset
time (`claude-usage.ts` already reads `resets_at`) it resumes the affected ticket sessions and
wakes the orchestrator with "limit reset". A pause never counts as an attempt.

### The review list

The orchestrator's final answer, since it is not tied to a ticket system. It lists: low-confidence
routes, escalations, orchestrator-routed tickets, unresolved blocking review findings, skipped or
deleted tests, ticket sessions' open questions, pending permission prompts, unmerged tickets and
failed tracker write-backs - each with its commit or worktree.

### Configuration

One file per user in userData with an optional per-project override, both holding the tier
mapping and the implementation skill. The files are the source of truth, so an agent can edit
the mapping. A settings panel (user tab, project-override tab) edits them: tier pickers fed from
the chat node's model list, with models the picker no longer offers shown as missing, and the
implementation-skill field with the ticket contract beside it - what the skill must do and what
it must not do.

## Live verification (#37)

Run `npm run build:test-out`, then `node scripts/verify-orchestration.mjs` outside `npm test`.
The harness uses real Claude ACP sessions, the shipped workflow, endpoint, spawner, wake handling,
outcome records and cleanup, with a headless canvas transport. Two dependent changes exercise a
fresh upstream on a **local bare remote**, deliberate Jev-unavailable fallback routing, ticket
commits, rebase/full-suite/fast-forward/push, and final cleanup. It retains the temporary fixture
and evidence and stops at permission prompts rather than granting them. No tracker or external
remote is involved, so tracker write-back, real Jev routing and conflict retries are not covered
by this smoke; the desktop cleanup path is covered by the DOM suite.

2026-09-30 run: **not yet an end-to-end pass**. The first networked run opened an orchestrator but
requested permission to read its shipped skill. That exposed a launch omission: orchestrator
sessions now receive the specific `orchestrate` skill directory as an additional directory;
ordinary sessions do not. The next run read all three workflow files successfully and stopped
on Claude's tool-permission prompt for the initial Git/CLI inspection command, as intended by
the harness. Fixture: `toucan-orchestration-smoke-LyGYw5` under the OS temporary directory;
conversation `2de569fa-1baa-4ba0-9ba2-3f8f13101320`; evidence in `evidence.txt`. No ticket was
spawned or merged in that run. Completing this acceptance criterion requires a human-approved
run that can execute those fixture commands; it remains pending.

## Open facts to settle during implementation

- Whether the chat node's model list and effort options are available to main at spawn time
  for a node that has never launched (the catalogue is written from ACP session configuration).
- `package.json` pins `@agentclientprotocol/claude-agent-acp` 0.84.0 while `node_modules` held
  0.81.0 on 2026-09-30; the notification and steering behavior relied on above was read from
  0.81.0.

## Tickets

Sub-issues of #32.

| Issue | Slice | Blocked by |
| --- | --- | --- |
| #33 | Orchestrator node, spawn token, local endpoint and orchestration record | — |
| #34 | `spawn`: ticket worktree and Claude ticket session, orchestrated-by edge, `pre-push` guard | #33 |
| #35 | Wake the orchestrator on ticket session events; `status`, `outcome`, `followup` | #34 |
| #36 | Difficulty-tier routing through Jev and the tier mapping configuration | #34 |
| #37 | Orchestrator instructions: breakdown, merging, escalation, write-back, review list, cleanup | #35, #36 |
| #38 | Usage-limit pause and resume; Stop orchestration | #35 |
| #39 | Orchestration settings panel | #36 |
| #40 | Routing report with tier mapping proposals | #36 |
