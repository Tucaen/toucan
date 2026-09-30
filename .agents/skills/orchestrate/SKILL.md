---
name: orchestrate
description: Command reference for the Toucan orchestrator CLI - plan show, plan set, ticket update, spawn, status, outcome and followup.
disable-model-invocation: true
user-invocable: false
---

# Orchestrate

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

## plan show

`plan show` prints `{ ok: true, record }`. `record` is `null` until the first `plan set`; otherwise it carries `task`, `targetBranch`, `tickets` and `spawnCount`. Each ticket has `id`, `title`, `body` or `source`, `blockedBy`, `attempts`, `mergeStatus` (`pending`, `merged`, `unmerged`), and `route` and `session` once set.

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
- `spawnCount` survives every re-plan.

## ticket update

`ticket update <id> --json '<fields>'` or `ticket update <id> --file <fields.json>` patches one ticket and prints `{ ok: true, ticket }`.

Fields: `title`, `body`, `source`, `blockedBy`, `attempts` (non-negative integer), `mergeStatus`, and `route` (`tier` of `low`/`medium`/`high`/`frontier`, `model`, `effort`, `confidence` 0-1, `routedBy` `jev`/`orchestrator`, `escalated`). Toucan owns `id` and `session`; change ids with `plan set`. An empty patch is refused.

## spawn

`spawn --ticket <id> --model <id> --effort <level> [--provider claude] [--project <path>]` starts one ticket session and prints:

```json
{
  "ok": true,
  "ticket": "1",
  "session": { "nodeId": "...", "conversationId": "...", "worktreePath": "...", "branch": "ticket/1" },
  "model": "claude-opus-5-5",
  "effort": "high",
  "warnings": [],
  "spawnsLeft": 19
}
```

- Toucan creates a worktree on a fresh `ticket/<id>` branch from `targetBranch` (a retry gets `ticket/<id>-2`, and so on), runs the project's setup command there (up to 15 minutes), and then opens the session on the canvas with the ticket as its first prompt. The call returns once the session is up, so expect it to take minutes.
- `model` and `effort` are what the running session reports, `null` when it reports none. When they differ from what you asked for, `warnings` says so: treat the session as running on the reported values.
- The ticket session is a Claude session; `--provider` accepts only `claude`, and `--project` only the orchestrator's own project.
- Ticket sessions commit to their branch and cannot push: a hook refuses it. You merge each branch into `targetBranch` yourself, then record it with `ticket update <id> --json '{"mergeStatus":"merged"}'`.
- An orchestration has 20 spawns in total. Each call counts before anything is created, so failed spawns, retries and escalations count too. Once they are used, spawn is refused; list what is left for human review.
- A failure before the session opens removes the new worktree and branch again; after the session opens, they stay and `error` names the worktree.

## Being woken

Never wait for a ticket session inside a tool call - a ticket can take an hour. End your turn after spawning. Toucan sends you a follow-up message whenever one of your ticket sessions completes, fails, is cancelled, asks a question or waits on a tool-permission prompt, one line per event:

```
Toucan: your ticket sessions reported in.
- #12 completed - 4 files - outcome record C:\...\session-outcomes\toucan--12-spawn--1a2b3c4d.md
- #13 asks a question - read it with status, answer it with followup --ticket 13 --text <answer>
```

Events that arrive close together come as one message. The message names the event and where to read more; it never carries a ticket session's transcript. A message that arrives while you are working reaches you at your next safe boundary.

## status

`status` prints `{ ok: true, tickets, pendingPermissionPrompts }`. Each ticket has `id`, `title`, `blockedBy`, `attempts`, `mergeStatus`, `session` (or `null`), and:

- `state`: `not spawned`, `not running` (Toucan is not running its session, e.g. after a restart), or the live session's `starting`, `ready`, `working`, `auth_required`, `exited`.
- `permissionPrompt`: `{ title, answeredBy: "human" }` while the session waits on a tool-permission prompt, else `null`.
- `questions`: pending questions, each `{ id, message, questions: [{ id, question, options, input, ... }] }`.

`pendingPermissionPrompts` lists the ticket ids waiting on the human; name them in your final answer.

## outcome

`outcome --ticket <id>` prints `{ ok: true, ticket, path, fields }`: the path of the ticket session's session outcome record and its fields (`title`, `status`, `turns`, `commit`, `branch`, `filesTouched`, `failures`, `toolFailures`, `lastResult`, and the rest). Refused while the ticket has no session, or before the session's first turn end has written the record.

## followup

`followup --ticket <id> --text <text>` sends the text to the ticket session and prints `{ ok: true, ticket, delivered }`:

- `answered` - the session had a pending question; the text is its answer, in each question's free-text field. A required question that has only fixed options is refused and waits for the human.
- `prompt` - the session was idle; the text starts a new turn.
- `steered` - the session was working; the text reached the turn in flight.
- `queued` - the session was working and takes the text when its turn ends.

It never answers a tool-permission prompt. While a ticket session waits on one, `followup` is refused: that prompt waits for the human.
