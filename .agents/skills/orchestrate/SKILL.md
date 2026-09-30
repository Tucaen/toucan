---
name: orchestrate
description: Command reference for the Toucan orchestrator CLI - plan show, plan set, ticket update and spawn.
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
