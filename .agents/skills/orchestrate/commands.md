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

Read `error` and act on it; a refusal writes nothing to the record.

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

`spawn --ticket <id> [--model <id> --effort <level> | --tier <tier> [--effort <level>]] [--provider claude|codex] [--project <path>] [--force --reason <why>]` starts one ticket session and prints:

```json
{
  "ok": true,
  "ticket": "1",
  "session": { "nodeId": "...", "conversationId": "...", "worktreePath": "...", "branch": "ticket/1" },
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
- Toucan creates a worktree on a fresh `ticket/<id>` branch from `targetBranch` (a retry gets `ticket/<id>-2`, and so on), runs the project's setup command there (up to 15 minutes), and then opens the session on the canvas with the ticket as its first prompt. The call returns once the session is up, so expect it to take minutes.
- `model` and `effort` are what the running session reports, `null` when it reports none. When they differ from what you asked for, `warnings` says so: treat the session as running on the reported values.
- Orchestrations are provider-homogeneous: the ticket session runs on your own provider, so a Claude orchestrator spawns Claude sessions and a Codex orchestrator Codex sessions, each routed through that provider's own tier mapping. `--provider` may only name your own provider, and `--project` only the orchestrator's own project.
- Ticket sessions commit to their branch and cannot push: a hook refuses it. Land each branch in `targetBranch` with `merge`.
- An orchestration has a spawn budget of 20 per checkpoint. Each call counts before anything is created, so failed spawns, retries and escalations count too. At the budget, spawn is refused with `{ ok: false, budgetReached: true, error }` (HTTP 429, no `deferred`): it is a checkpoint, not a failure and not the end of the orchestration. The node shows it as waiting on the human with **Continue (+20)**. End your turn and do not retry, poll or sleep: when the human presses Continue, Toucan raises the budget by another 20 for this same orchestration and wakes you ("The user pressed Continue"); then reread `status` and `plan show` and retry the refused spawn. Never tell the user to start a new orchestrator or migrate your context.
- Before that count or any Git, setup or canvas work, Toucan atomically checks fresh provider usage against provider-wide active ticket work. A pacing refusal is `{ ok: false, deferred: true, provider, state, reason, retryAt?, outlook }`; it consumes no spawn and leaves no artifact. Weigh `outlook` (see `usage`): when the window will not run out before its reset with one more session working, spawn again with `--force --reason`. Otherwise end the turn with the deferral recorded. Repeating `spawn` while it remains deferred only returns the same refusal; it does not force a usage read or hasten the timer. Toucan owns reset rechecks and wakes you when the gate reopens; then reread `usage`, `status` and `plan show` before one retry. Waiting happens through that wake, never through a shell sleep or polling loop.
- `--force --reason <why>` starts the ticket regardless of the usage limits: it skips pacing, reads no usage, and resumes an orchestration paused by a provider usage limit (its interrupted ticket sessions are told to continue, as with Resume now). Toucan always honours it; `--reason` is required and states why: the user asked (they pressed **Start now** on your node, and Toucan then tells you to run it), or the `outlook` numbers that show the remaining usage suffices. The spawn budget (a checkpoint needing the human's Continue), `blockedBy`, a stopped orchestration, Git and setup work still apply. A forced spawn clears this orchestration's pending pacing deferral, so no reopen wake follows for it, records `pacing.forced: { ticketId, by, at, reason }` (`by` is your node id) and returns it as `forced`. A provider that refuses the session's turns pauses the orchestration as usual.
- A failure before the session opens removes the new worktree and branch again; after the session opens, they stay and `error` names the worktree.

## Being woken

Never wait for a ticket session inside a tool call - a ticket can take an hour. End your turn after spawning. Toucan sends you a follow-up message whenever one of your ticket sessions completes, fails, is cancelled, asks a question or waits on a tool-permission prompt, one line per event:

```
Toucan: your ticket sessions reported in.
- #12 completed - 4 files - outcome record C:\...\session-outcomes\toucan--12-spawn--1a2b3c4d.md
- #13 asks a question - read it with status, answer it with followup --ticket 13 --text <answer>
- #14 completed (background work pending: 1 task) - 2 files - outcome record C:\...\session-outcomes\toucan--14-spawn--5e6f7a8b.md
```

`completed (background work pending: N tasks)` means the turn ended with background work it started still running - a backgrounded shell or subagent. That work's result arrives in a further turn, which wakes you again; until then the outcome record is not final.

Events that arrive close together come as one message. The message names the event and where to read more; it never carries a ticket session's transcript. A message that arrives while you are working reaches you at your next safe boundary. A provider-pacing reopen wake explicitly asks you to reread `usage`, `status` and `plan show`; it is the retry signal for a deferred spawn.

## status

`status` prints `{ ok: true, tickets, pacing, pendingPermissionPrompts }`. `pacing` is the durable proactive deferral or `null`; after a forced spawn it carries `forced: { ticketId, by, at, reason }`, alone when no deferral is pending. Each ticket has `id`, `title`, `blockedBy`, `attempts`, `mergeStatus`, `session` (or `null`), `route` (or `null`), and:

- `state`: `not spawned`, `not running` (Toucan is not running its session, e.g. after a restart), or the live session's `starting`, `ready`, `working`, `auth_required`, `exited`.
- `permissionPrompt`: `{ title, answeredBy: "human" }` while the session waits on a tool-permission prompt, else `null`.
- `questions`: pending questions, each `{ id, message, questions: [{ id, question, options, input, ... }] }`.

`pendingPermissionPrompts` lists the ticket ids waiting on the human; name them in your final answer.

`status` does not say whether a ticket has background work pending or a pre-merge `followup` running: that comes from the wakes and your own calls. The SKILL's ticket-state table says how to place each ticket from these fields.

## outcome

`outcome --ticket <id>` prints `{ ok: true, ticket, path, fields }`: the path of the ticket session's session outcome record and its fields (`title`, `status`, `turns`, `commit`, `branch`, `filesTouched`, `failures`, `toolFailures`, `lastResult`, and the rest). Refused while the ticket has no session, or before the session's first turn end has written the record.

## followup

`followup --ticket <id> --text <text>` sends the text to the ticket session and prints `{ ok: true, ticket, delivered }`:

- `answered` - the session had a pending question; the text is its answer, in each question's free-text field. A required question that has only fixed options is refused and waits for the human.
- `prompt` - the session was idle; the text starts a new turn.
- `steered` - the session was working; the text reached the turn in flight.
- `queued` - the session was working and takes the text when its turn ends.

It never answers a tool-permission prompt. While a ticket session waits on one, `followup` is refused: that prompt waits for the human.

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

`merge --ticket <id> --tested <commit>` lands one tested ticket and prints `{ ok: true, ticket, commit, upstream, cleanup }`. `--tested` is the hash (7 to 64 hex digits) the ticket session's full test suite passed on.

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

Only tickets recorded as merged or answered qualify. Toucan verifies their branch is contained in both the target and its upstream, retires the settled ticket chat, preflights and removes the clean worktree, deletes the local branch with Git's non-force deletion, and removes its canvas group. Transcripts stay in History. Other sessions, open file editors, dirty files, stashes, missing evidence, and Git failures retain the affected work, but after publication is proved they do not keep the merged ticket's agent process alive. A busy ticket or pending answer blocks retirement. Unmerged tickets and earlier failed attempts stay for review. A partial cleanup is safe to retry; report its retained entries.
