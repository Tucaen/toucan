# Orchestrator command reference

The CLI a Toucan orchestrator session drives Toucan with. Toucan launches an orchestrator with `TOUCAN_ORCHESTRATOR_URL` and `TOUCAN_ORCHESTRATOR_TOKEN`; the CLI reads both and works nowhere else.

```
node "<skills root>/skills/orchestrate/scripts/orchestrate.mjs" <command> [arguments]
```

The orchestration record is the single source of truth for the plan and its progress. Rebuild your picture from `plan show` after a resume, never from memory.

## Output and exit codes

Every call prints exactly one JSON line on stdout.

| Exit | Meaning                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Toucan accepted the call; the line is its reply, `ok: true`.                                                                                                |
| 1    | Toucan refused (its reply, `ok: false`, `error` says why), could not be reached, or answered with something other than JSON.                                |
| 2    | The CLI refused before sending: a missing environment variable, an unknown command, a bad flag, or unreadable JSON input. `error` ends with the usage line. |

Read `error` and act on it; a refusal writes nothing to the record. One exit 1 is not a refusal: a `spawn` reply with `pending: true` (see [Spawn pending](#spawn-pending)) left a session running, so read `pending` before treating any exit 1 from `spawn` as a failure.

## usage

`usage` prints `{ ok: true, provider, usage, state, pacing, outlook }` for the orchestrator's own provider only. `usage` is a normalized `ProviderUsageEntry` (`status`, `readAt`, `stale`) or `null`; `state` is `available`, `missing`, or `failed`, so an absent reading and a failed refresh are never conflated. A failed or missing refresh can retain a stale last-known `usage` entry. `pacing` carries the current `unrestricted`, `drain`, or `pause` recommendation with its stable `reason`, freshness and provider-wide active-ticket count.

`outlook` is what a decision to `spawn --force` weighs, measured from Toucan's own readings of the five-hour window: `{ usedPercent, resetsAt, minutesToReset, burnRatePerMinute, projectedAtReset, projectedWithOneMore, working }`. `burnRatePerMinute` is the recent pace in percent per minute, from readings in the last hour since the latest reset; it is `null` until Toucan holds two readings at least five minutes apart, and the projections are `null` with it. `projectedAtReset` continues that pace to the reset; `projectedWithOneMore` adds one more session at the average pace per working session. `working` counts the sessions mid-turn on this provider across every Toucan project: `{ tickets, orchestrators, chats }`, your own turn included. Sessions outside Toucan are not counted.

Read it when deciding whether to dispatch, retry, or resume work after a usage-limit pause. Do not poll it: Toucan uses a shared cache and forced reads coalesce, but polling still asks a provider for account state without making progress. The command starts no model turn and never exposes credentials, raw provider payloads, or another provider's usage.

## plan show

`plan show` prints `{ ok: true, record }`. `record` is `null` until the first `plan set`; otherwise it carries `task`, `targetBranch`, `tickets`, `spawnCount` and, once the human has pressed Continue, `spawnBudget` (the count at which spawn next waits for them; absent means 20). A proactively deferred record also carries `pacing` with its state, reason and `retryAt` when a provider reset or Toucan-owned bounded recheck is scheduled. Each ticket has `id`, `title`, `body` or `source`, `blockedBy`, `attempts`, `mergeStatus` (`pending`, `merged`, `unmerged`, `answered`), and `route` and `session` once set.

## plan set

`plan set --file <plan.json>` or `plan set --json '<plan>'` writes the plan and prints `{ ok: true, record }`.

```json
{
  "task": "The whole task, as the user gave it",
  "targetBranch": "main",
  "tickets": [
    { "id": "1", "title": "Short title", "body": "Free-text ticket", "blockedBy": [] },
    { "id": "2", "title": "Tracked ticket", "source": "#12", "blockedBy": ["1"] }
  ]
}
```

- Ids are unique; every `blockedBy` entry names another ticket in the plan, and the graph is acyclic.
- Re-planning is allowed. A ticket that keeps its id keeps its route, session, attempts and merge status; a ticket with a session stays in the plan.
- `spawnCount` and `spawnBudget` survive every re-plan.

## ticket update

`ticket update <id> --json '<fields>'` or `ticket update <id> --file <fields.json>` patches one ticket and prints `{ ok: true, ticket }`.

Fields: `title`, `body`, `source`, `blockedBy`, `attempts` (non-negative integer), `mergeStatus`, and `route` (`tier` of `low`/`medium`/`high`/`frontier`, `model`, `effort`, `confidence` 0-1, `depth` 0-4, `routedBy` `jev`/`orchestrator`, `escalated`, `reviewRequired`). `mergeStatus: answered` marks an answer-only ticket and is refused unless its session has settled with nothing pending, its worktree is clean and its branch holds no commit the target lacks. Toucan owns `id` and `session`; change ids with `plan set`. Prefer `route` and `escalate` over writing `route` by hand. An empty patch is refused.

## route

`route` sends every ticket with no tier, no session and `mergeStatus: pending` to Jev in one request and prints `{ ok: true, routes, warnings, config }`.

- Jev judges each ticket's **difficulty tier** (`low`, `medium`, `high`, `frontier`) and a reasoning-depth score. It never sees the models: Toucan turns the tier into a model through the user's **tier mapping**, and the depth into the nearest effort that model's picker offers. A tier mapped with a fixed effort keeps it.
- Each route is recorded on its ticket: `tier`, `model`, `effort`, `confidence`, `depth`, `routedBy: "jev"`, `escalated: false`. Below confidence 0.6 it also gets `reviewRequired: true`: the ticket still runs on its tier; name it on the review list.
- A mapped model the picker no longer lists falls back to the next tier up's model; `warnings` names each fallback, and any effort that could not be checked against the picker. The ticket keeps its tier.
- `config` names the mapping's files: `user`, and `project` when this project has an override. Report a broken file to the human rather than editing around it.
- Already-routed tickets are not sent again, so `route` after a re-plan routes only the new tickets.

When Jev is unavailable (no `TYPESAFE_API_KEY`, a timeout, an error), `route` exits 1 with `jevUnavailable: true` and the reason. Then judge each ticket's tier yourself, with the same criteria, and record it:

`route --ticket <id> --tier <tier>` resolves the tier through the mapping and records the route with `routedBy: "orchestrator"`. It may also replace a Jev route you disagree with; either way, name orchestrator-routed tickets in your final answer.

## escalate

`escalate --ticket <id>` moves the ticket's route one tier up after a failed attempt. It re-resolves the model and effort, keeps the depth score and how the ticket was routed, sets `escalated: true`, and prints `{ ok: true, ticket, route, warnings }`. Spawn the ticket again to run it on the new route. A ticket already at `frontier` is refused: it goes on the review list.

## spawn

`spawn --ticket <id> [--model <id> --effort <level> | --tier <tier> [--effort <level>]] [--provider claude|codex] [--project <path>] [--force --reason <why>] [--replace]` starts one ticket session and prints:

```json
{
  "ok": true,
  "ticket": "1",
  "session": { "nodeId": "...", "conversationId": "...", "worktreePath": "...", "branch": "ticket/k3x9a0/1" },
  "model": "claude-opus-5-5",
  "effort": "high",
  "warnings": [],
  "route": {
    "tier": "high",
    "model": "opus",
    "effort": "high",
    "confidence": 0.82,
    "depth": 2.1,
    "routedBy": "jev",
    "escalated": false
  },
  "spawnsLeft": 19
}
```

- With only `--ticket`, the session runs on the ticket's recorded route, which is the usual case after `route` or `escalate`. If the picker has dropped the recorded model since, it is resolved again. `--tier` resolves that tier through the mapping instead and records it as your own route. `--model` and `--effort` bypass the mapping entirely. `--effort` overrides a resolved effort. A ticket with no route and neither flag is refused, without counting a spawn.
- The reply's `route` is what was recorded; `warnings` includes any model fallback.
- The session's first prompt is the configured implementation skill (default `/implement`) with the ticket, then the ticket contract.
- Toucan creates a worktree on a fresh `ticket/<scope>/<id>` branch from `targetBranch` (a retry gets `ticket/<scope>/<id>-2`, and so on; the folder is `ticket-<scope>-<id>`), runs the project's setup command there (up to 15 minutes), and then opens the session on the canvas with the ticket as its first prompt. The call returns once the session is up, so expect it to take minutes. A session that is slow to come up returns [pending](#spawn-pending) instead.
- `model` and `effort` are what the running session reports, `null` when it reports none. When they differ from what you asked for, `warnings` says so: treat the session as running on the reported values.
- Orchestrations are provider-homogeneous: the ticket session runs on your own provider, so a Claude orchestrator spawns Claude sessions and a Codex orchestrator Codex sessions, each routed through that provider's own tier mapping. `--provider` may only name your own provider, and `--project` only the orchestrator's own project.
- Ticket sessions commit to their branch and cannot push: a hook refuses it. Land each branch in `targetBranch` with `merge`.
- An orchestration has a spawn budget of 20 per checkpoint. Each call counts before anything is created, so failed spawns, retries and escalations count too. At the budget, spawn is refused with `{ ok: false, budgetReached: true, error }` (HTTP 429, no `deferred`): it is a checkpoint, not a failure and not the end of the orchestration. The node shows it as waiting on the human with **Continue (+20)**. End your turn and do not retry, poll or sleep: when the human presses Continue, Toucan raises the budget by another 20 for this same orchestration and wakes you (a `[Toucan: user pressed Continue (+20)]` message); then reread `status` and `plan show` and retry the refused spawn. Never tell the user to start a new orchestrator or migrate your context.
- Before that count or any Git, setup or canvas work, Toucan atomically checks fresh provider usage against provider-wide active ticket work. A pacing refusal is `{ ok: false, deferred: true, provider, state, reason, retryAt?, outlook }`; it consumes no spawn and leaves no artifact. Weigh `outlook` (see `usage`): when the window will not run out before its reset with one more session working, spawn again with `--force --reason`. Otherwise end the turn with the deferral recorded. Repeating `spawn` while it remains deferred only returns the same refusal; it does not force a usage read or hasten the timer. Toucan owns reset rechecks and wakes you when the gate reopens; then reread `usage`, `status` and `plan show` before one retry. Waiting happens through that wake, never through a shell sleep or polling loop.
- `--force --reason <why>` starts the ticket regardless of the usage limits: it skips pacing, reads no usage, and resumes an orchestration paused by a provider usage limit (its interrupted ticket sessions are told to continue, as with Resume now). Toucan always honours it; `--reason` is required and states why: the user asked (they pressed **Start now** on your node, and Toucan then tells you to run it), or the `outlook` numbers that show the remaining usage suffices. The spawn budget (a checkpoint needing the human's Continue), `blockedBy`, a stopped orchestration, Git and setup work still apply. A forced spawn clears this orchestration's pending pacing deferral, so no reopen wake follows for it, records `pacing.forced: { ticketId, by, at, reason }` (`by` is your node id) and returns it as `forced`. A provider that refuses the session's turns pauses the orchestration as usual.
- A failure before the canvas opens the session removes the new worktree and branch again, and the ticket is free to spawn again: the retry gets a fresh worktree on the next branch name. After the canvas has the session, a failed start is unlinked again, Toucan closes the session so it cannot work the ticket beside your retry, and a spawn the canvas reports as failed keeps its node for the human, without the ticket prompt.

### Spawn pending

A session that is slow to start is not a failed one. When the start wait runs out with the session already on the canvas, `spawn` replies HTTP 202 `{ "ok": false, "pending": true, "ticket", "session", "error", "spawnsLeft" }`. The CLI exits 1 on it, like any `ok: false`, so check `pending` before reading the exit code as a failure.

- The session stays linked to the ticket and open, and its `runs` entry is `starting`. `status` shows the ticket as `starting` until the session reports in.
- Do not spawn it again: a second `spawn` is refused as a [duplicate](#duplicate-spawns). End your turn. Toucan wakes you with `started` when the session is up, or `start-failed` when its start failed; a failed start is unlinked and the ticket may then be spawned again.
- The wait is a quiet period: any output or progress from the session restarts it. Its length is `startTimeoutSeconds` (10 to 3600, default 300) in the provider's entry of the orchestration configuration, in the user file or the project file; the project file wins. Do not lengthen it per call; report a start that keeps timing out to the human.

### Duplicate spawns

A plain `spawn` of a ticket whose latest attempt is still unresolved is refused with `{ ok: false, duplicate: true, error, attempt }` (HTTP 409) and counts no spawn. `attempt` is `{ attempt, nodeId?, branch?, worktreePath?, state }`, where `attempt` is the one-based position in the ticket's `runs` in `plan show`.

An attempt is unresolved while its session is `starting`, `working` or `auth_required`, or `ready` and awaiting your review. It is resolved when the session has `exited` or Toucan is not running it (closed, stopped, killed, a restart), when it was discarded, and when you `escalate`d the ticket after the attempt launched.

- Wait for the session's wake, or read `status`. The refusal is the normal answer to a spawn you did not need.
- `spawn --ticket <id> --replace` (with the usual route flags) stops the unresolved attempt's session and starts a new one. It stops the old session only after pacing and the spawn budget admitted the new spawn, so a deferred or refused replace costs the old attempt nothing. The old worktree and branch stay; the new attempt gets a fresh branch name. Use it only to deliberately supersede an attempt.

### Unrecorded attempts

Toucan compares this orchestration's `ticket/*` worktrees and branches with the record: those under its own `ticket/<scope>/`, never another orchestration's, plus unscoped `ticket/<id>` ones only for an orchestration started before scoped names, which still sees every such branch as before. One no recorded attempt names, or a worktree a live session runs in that the record does not name, is an unrecorded attempt: somebody's work Toucan lost track of (a spawn that failed after the canvas, a lost record, a session the human started there). It is never deleted by `merge` or `cleanup`. `status` lists each under `unrecorded` (and `unrecordedError` when Git could not be read); a sweep keeps it in `retained` with reason `unrecorded attempt`.

Each `unrecorded` entry is `{ ticket, path?, branch, ahead, liveSession, nodeId?, conversationId? }`: `ticket` is the ticket id the branch name belongs to (a plan ticket's id, else the bare slug), `path` is absent for a branch no worktree holds, and `ahead` is the commits the target lacks (`null` when Git could not count them).

Settle each one of two ways:

- **Adopt it**: `spawn --ticket <id> --adopt <worktree-path>` links that worktree, and the live session in it, to the ticket as its current attempt. It takes only `--ticket`, the path and optionally `--project`; any other spawn flag is refused. It creates nothing, so it costs no spawn and consults no pacing, but it goes through the [duplicate guard](#duplicate-spawns): discard or replace an unresolved attempt first. It prints `{ ok: true, ticket, adopted: true, attempt, session, liveSession, ahead }`, and the ticket then reads like any spawned one (wakes, `status`, `merge`). A session the human started has no orchestration edge on the canvas, which is cosmetic. Refused when the path is not an entry of `unrecorded` or its branch belongs to another ticket.
- **Discard it**: see [discard](#discard).

## discard

`discard --ticket <id> --attempt <n>` throws one recorded attempt away; `discard --branch <ticket/...>` does the same for an entry of `status.unrecorded` (the branch exactly as listed). It stops the attempt's session, force-removes its worktree even with uncommitted or unpublished work, deletes its branch with `git branch -D` (commits the target lacks are lost), and for a recorded attempt marks its `runs` entry `discarded`. It never touches the target branch. It prints `{ ok: true, ticket, attempt?, branch, worktree?, removedWorktree, deletedBranch, discardedCommits }`; `discardedCommits` is the commits that were on the branch and not in the target (`null` when Git could not count them).

- `--attempt` is the one-based position in the ticket's `runs` in `plan show`, the number the duplicate refusal and the adopt reply give. Both forms take only their own flags.
- Refused, with nothing marked discarded: a ticket already `merged` or `answered` (use `cleanup --ticket <id>`), an attempt already discarded, an attempt with no recorded branch (a run from before Toucan kept it: discard it with `--branch`), a branch that is not in `unrecorded` (another orchestration's branch never is), and a Git failure that left the worktree or branch in place (`error` says why; fix it and discard again).
- Run it only after the human confirmed that this attempt's work may be lost. Whatever the ticket session left uncommitted, and every unmerged commit, is gone with it. `discard` is the only deliberate deletion of unmerged work in this CLI.

## Being woken

Never wait for a ticket session inside a tool call - a ticket can take an hour. End your turn after spawning. Toucan sends you a follow-up message whenever one of your ticket sessions completes, fails, is cancelled, asks a question or waits on a tool-permission prompt, one line per event:

```
[Toucan: your ticket sessions reported in]
- #12 completed - 4 files - outcome record C:\...\session-outcomes\toucan--12-spawn--1a2b3c4d.md
- #13 asks a question - read it with status, answer it with followup --ticket 13 --text <answer>
- #14 completed (background work pending: 1 task) - 2 files - outcome record C:\...\session-outcomes\toucan--14-spawn--5e6f7a8b.md
```

`completed (background work pending: N tasks)` means the turn ended with background work it started still running - a backgrounded shell or subagent. That work's result arrives in a further turn, which wakes you again; until then the outcome record is not final.

A ticket whose `spawn` answered [pending](#spawn-pending) wakes you once more when its start is settled: `started` (the session is up and working the ticket) or `start-failed` (Toucan gave up on the start and unlinked the session, so the ticket may be spawned again).

Events that arrive close together come as one message. The message names the event and where to read more; it never carries a ticket session's transcript. A message that arrives while you are working reaches you at your next safe boundary. A provider-pacing reopen wake explicitly asks you to reread `usage`, `status` and `plan show`; it is the retry signal for a deferred spawn. When the human resolves a pinned question in the UI, the wake is `[Toucan: user resolved Q<n>]` with their note, if any; reread `question list` and `status`, then continue the work that waited on it.

## status

`status` prints `{ ok: true, tickets, unrecorded, pacing, pendingPermissionPrompts, openQuestions }` (plus `unrecordedError` when Git could not be read, in which case `unrecorded` is empty and says nothing). `pacing` is the durable proactive deferral or `null`; after a forced spawn it carries `forced: { ticketId, by, at, reason }`, alone when no deferral is pending. Each ticket has `id`, `title`, `blockedBy`, `attempts`, `mergeStatus`, `session` (or `null`), `route` (or `null`), and:

- `state`: `not spawned`, `not running` (Toucan is not running its session, e.g. after a restart), or the live session's `starting`, `ready`, `working`, `auth_required`, `exited`.
- `permissionPrompt`: `{ title, answeredBy: "human" }` while the session waits on a tool-permission prompt, else `null`.
- `questions`: pending questions, each `{ id, message, questions: [{ id, question, options, input, ... }] }`.

`pendingPermissionPrompts` lists the ticket ids waiting on the human; name them in your final answer. `openQuestions` are the pinned questions still waiting for the human, as `question list` prints them. `unrecorded` lists the [unrecorded attempts](#unrecorded-attempts); read it on every resume and after every `cleanup`.

`status` does not say whether a ticket has background work pending or a pre-merge `followup` running: that comes from the wakes and your own calls. The SKILL's ticket-state table says how to place each ticket from these fields.

## outcome

`outcome --ticket <id>` prints `{ ok: true, ticket, path, fields }`: the path of the ticket session's session outcome record and its fields (`title`, `status`, `turns`, `commit`, `branch`, `filesTouched`, `failures`, `toolFailures`, `lastResult`, and the rest). Refused while the ticket has no session, or before the session's first turn end has written the record.

`lastResult` and `mainResult` are excerpts, cut at a few hundred characters. `outcome --ticket <id> --full` adds `report`: the ticket session's latest final answer, untruncated, links included - the text to copy a question from. It needs the session running in Toucan; otherwise `report` is `null` and `reportUnavailable` says why.

## followup

`followup --ticket <id> --text <text>` sends the text to the ticket session and prints `{ ok: true, ticket, delivered }`:

- `answered` - the session had a pending question; the text is its answer, in each question's free-text field. A required question that has only fixed options is refused and waits for the human.
- `prompt` - the session was idle; the text starts a new turn.
- `steered` - the session was working; the text reached the turn in flight.
- `queued` - the session was working and takes the text when its turn ends.

It never answers a tool-permission prompt. While a ticket session waits on one, `followup` is refused: that prompt waits for the human.

## question

A question only the human can answer is pinned once, verbatim, for Toucan to show them on your node and on the phone; after that, name it only by its id.

- `question add [--ticket <id>] (--text <markdown> | --file <markdown file>) [--options <json> | --options-file <json file> [--multi] | --options-from-session]` prints `{ ok: true, question }`. The record keeps the markdown exactly as sent, `file:///` links included, up to 16,000 characters (save anything longer in the scratch folder and link it). `question.id` is `Q1`, `Q2`, ...: unique within this orchestration, never reused, kept across restarts and `plan set`. `--ticket` must name a ticket that is not yet merged or answered. Prefer `--file` for multi-line markdown: it is sent byte for byte, with no shell quoting in between; markdown that starts with `--` (a `---` rule, front matter) only goes through `--file`.
- `--options` / `--options-file` give the question clickable answers: a JSON array of 1 to 12 entries, each a label string or `{ "label": "...", "description"?: "..." }` (labels up to 200 characters, descriptions up to 500, no label twice). Toucan renders such a question on your node and on the phone as the same decision panel a ticket session shows its own pending question with - one required choice plus an "Other answer" field - under the markdown, which still carries the full context. `--multi` lets the human pick several. Without `--options` the question is plain text, as before.
- `--options-from-session` (needs `--ticket <id>`; cannot be combined with `--options`, `--options-file` or `--multi`) copies the options from that ticket session's head pending question - the one `status` lists under `questions` - so you do not retype them. It applies only when that request is a single select question with options (`--multi` follows the question's own multi-select); only the options are copied, nothing links the pinned question to the session's request. Toucan refuses with the reason, and pins nothing, when the ticket has no running session, the session has no pending question (a question that only lives in its final report: pass `--options` or pin it as plain text), the request has several questions or a text, number or boolean one, or an option label is unusable. Prefer it over `--options` whenever you pin a ticket session's pending decision question.
- Clicking an answer resolves the question like the human's Erledigt does and wakes you (see Being woken) with the answer as the resolution note: `Answer: <label>`, `Answer: <label>, <label>` for a multi-select, `Answer: <label> (note: <their own text>)` when they also typed something, `Answer: <their text>` for "Other" alone, or `Skipped without an answer.` for Skip. Nothing is sent to the ticket session: relaying the answer to a session still waiting on it is your `followup`.
- `question resolve --id <Q<n>> [--note <text>]` prints `{ ok: true, question, changed }`. Resolving it again is `changed: false` and keeps the first resolution. Resolving here wakes nobody; the human's resolve in the UI wakes you (see Being woken), unless the orchestration is paused or stopped - then the resume wake's `status` shows it gone.
- `question list [--all]` prints `{ ok: true, questions }`: the open ones, oldest first, or every one with `--all`. Each is `{ id, ticketId?, markdown, options?, multiSelect?, createdAt, resolvedAt?, resolution? }`.

A ticket recorded `merged` or `answered` (by `merge` or `ticket update`) resolves its open questions itself, with `resolution` `ticket <id> merged` or `ticket <id> answered`.

## report

`report` takes no arguments and prints the routing report over **every orchestration record of this project**, this one included, with each ticket session's turns and `route:` fields from its outcome record:

```json
{
  "ok": true,
  "orchestrations": 3,
  "minimumSample": 10,
  "jev": [
    {
      "provider": "claude",
      "tier": "medium",
      "model": "sonnet",
      "tickets": 12,
      "mergedWithoutEscalation": 7,
      "mergedAfterEscalation": 0,
      "escalated": 4,
      "unmerged": 1,
      "inProgress": 0,
      "answered": 0,
      "medianTurns": 3,
      "sample": 12
    }
  ],
  "orchestrator": [],
  "skippedRuns": 0,
  "proposals": [
    {
      "provider": "claude",
      "configEntry": "claude.tiers.medium",
      "tier": "medium",
      "from": { "model": "sonnet" },
      "to": { "model": "opus" },
      "evidence": { "model": "sonnet", "mergedWithoutEscalation": 7, "sample": 12 },
      "summary": "claude.tiers.medium → opus: sonnet merged only 7/12 Jev-routed Claude medium tickets without escalation"
    }
  ],
  "mappings": {
    "claude": {
      "low": { "model": "haiku" },
      "medium": { "model": "sonnet" },
      "high": { "model": "opus" },
      "frontier": { "model": "opus", "effort": "max" }
    }
  },
  "config": { "claude": { "user": "<userData>/orchestration-config.json", "project": null } }
}
```

- A row is one provider, tier and model. `provider` is the provider whose ticket sessions ran there, and `model` an id from that provider's picker: the same model name under two providers is two rows, never one. A run recorded before runs named their provider counts as Claude's, because ticket sessions were Claude-only then. Each ticket that ran there counts once: `mergedWithoutEscalation` when it merged there, routed there directly; `mergedAfterEscalation` when it merged there after an escalation from below; `escalated` when it was escalated away to a higher tier; `unmerged` when it stayed unmerged or moved to another model on the same tier; `inProgress` when it is still pending there; `answered` when it was an answer-only ticket, which never counts toward `sample`. `medianTurns` is `null` when no outcome record gives turns.
- `jev` holds tickets Jev routed. `orchestrator` holds tickets whose tier you judged or whose model you named. They are never mixed, and only `jev` rows produce proposals. `skippedRuns` counts runs with no known tier, model or `routedBy`.
- `sample` is the settled tickets Jev routed straight to that tier. Each provider's proposals are judged only from its own rows against its own mapping, and `configEntry` names the entry in that provider's section of the `config` file a proposal would change. A proposal needs `sample` of at least `minimumSample`. It moves a tier down to a lower tier's model that merged at least 90% of its sample without escalation, or else up to the next tier's entry when the tier's own model merged fewer than 70%. It proposes at most one change per tier and nothing past `frontier`.
- `forcedSpawns` lists each orchestration's latest forced spawn as `{ conversationId, ticketId, by, at, reason }`; mention them in the review list.
- `mappings` and `config` hold your own provider and every provider whose ticket sessions ran in this project. `report` only reads. It never changes a mapping. A provider whose mapping cannot be used still gets its counts, with `mappings.<provider>: null`, no proposals of its own and the reason in `mappingErrors.<provider>`.

## merge

`merge --ticket <id> --tested <commit>` lands one tested ticket and prints `{ ok: true, ticket, commit, upstream, cleanup }`. `--tested` is the hash (7 to 64 hex digits) of the ticket branch HEAD you verified: by the ticket session's targeted tests, an affected subset or the full suite, as the risk-based rule in the skill decided. It is not a claim that the full suite passed.

Toucan refuses unless the ticket is `pending` or `unmerged`, every blocker is settled and its session has settled with nothing pending. It then requires a clean ticket worktree, a clean target checkout on `targetBranch`, `--tested` equal to the ticket branch HEAD, that HEAD containing the target tip, and an upstream for the target. It runs `git merge --ff-only`, pushes the target to that upstream, records `mergeStatus: merged` and runs `cleanup --ticket <id>`, whose `{ removed, retained }` is `cleanup`. It never forces and never creates a merge commit.

A refusal is `{ ok: false, ticket, stage, error }` and records nothing:

| `stage` | What moved                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `check` | Nothing. `error` names the failed condition.                                                                                                |
| `merge` | The fast-forward failed; the target is where it was.                                                                                        |
| `push`  | The target checkout holds the merge; its upstream does not. `rejected: true` means the upstream moved on; otherwise auth or network failed. |

After a `push` refusal the same call is safe to repeat: a target that already holds the tested commit is only pushed.

## cleanup

`cleanup [--ticket <id>]` prints `{ ok: true, removed, retained }`. With a ticket it handles that freshly merged or answered ticket only (`merge` already runs it); without one it performs the final sweep. Each entry names its `ticket`, `worktree`, and `branch`; retained entries include a `reason`. Inspect both lists: acceptance of the command does not mean every worktree was removed.

Only tickets recorded as merged or answered qualify. Toucan verifies their branch is contained in both the target and its upstream, retires the settled ticket chat, preflights and removes the clean worktree, deletes the local branch with Git's non-force deletion, and removes its canvas group. Transcripts stay in History. Other sessions, open file editors, dirty files, stashes, missing evidence, and Git failures retain the affected work, but after publication is proved they do not keep the merged ticket's agent process alive. A busy ticket or pending answer blocks retirement. When only the folder cannot be deleted (a process still holds it), the branch, chat and canvas group still go and Toucan retries the folder in the background; the entry stays retained with that reason. Unmerged tickets and earlier failed attempts stay for review. A worktree or branch no recorded attempt names is retained with reason `unrecorded attempt` and is never deleted by `cleanup` (see [unrecorded attempts](#unrecorded-attempts)); retry will not change that, only `spawn --adopt` or `discard` does. A partial cleanup is safe to retry; report its retained entries.
