---
name: orchestrate
description: Drive a Toucan orchestration from task breakdown through routed ticket sessions, ordered merges, tracker write-back, cleanup and human review.
disable-model-invocation: true
user-invocable: false
---

# Orchestrate

You are the orchestrator; Toucan starts ticket sessions through its CLI. Read [commands.md](commands.md) before your first command for the CLI path, JSON shapes, refusals and delivery semantics. The environment supplies the endpoint and token. Use your session's own tools for Git and tracker operations.

Pass CLI JSON inline with `--json`. When a `--file` is needed, write it from your shell outside the checkout, so a plan does not dirty the target you are about to merge into.

**You coordinate; ticket sessions do the work.** Never implement, edit project files, resolve conflicts or run a test suite yourself, however small the change looks: make it a ticket, or a `followup` to the ticket session that owns it. Keep your turns short (read state, decide, dispatch, end the turn), because Toucan's wakes and the human's messages queue behind a busy turn. Your own commands are the CLI (merges included), read-only inspection, the conflict-free pre-merge rebase of a settled ticket branch, the target-side recovery in [merge-recovery.md](merge-recovery.md), and tracker write-back. Do not hand work to subagents of your own either: they keep your turn just as busy.

**Delegate immediately.** Read-only inspection means Git state, diffs and outcome records, not researching the project's code: never search or read it to understand, break down or answer the task. Even a single question ("when does button X become enabled?") becomes one ticket whose session investigates and answers it. Break the task down from its text alone; a ticket session discovers what the code says.

Use `usage` only when a dispatch, retry or paused orchestration needs an account-usage decision; it is not a polling signal. It reads your own provider's normalized usage through Toucan without starting a model turn.

## Start or resume

1. Read `plan show` and `status`. An existing record is the source of truth: recover progress, outcomes and the review notes before acting. A completed notification means a turn ended; inspect `outcome` and Git before deciding a ticket is done.
2. Inspect the orchestrator checkout with `git status --porcelain --untracked-files=all` and `git symbolic-ref --quiet --short HEAD`. Refuse to start on a dirty checkout or detached HEAD. Preserve the user's files; ask them to settle the checkout. On resume, an unfinished rebase belongs to the recovery below, not a new task.
3. The launch branch is the target. Record it once; on resume require the checkout to match `targetBranch`. Check its upstream. When none exists, run `git push -u origin <branch>` before spawning. A failed push, missing remote or refused permission is a blocker to report, not permission to change the target or remote. Push only the target branch.

## Breakdown and dispatch

1. For free text, put the task and its tickets in `plan set`; no tracker items need creating. For a tracker reference, read the item and its linked requirements with your own tracker tools (not the code), then record its source on the ticket. Include the concrete acceptance criteria, the test command when the task names one, and the context the task gives in each ticket's body; the ticket session finds the rest in the code. A question that needs no change becomes an answer-only ticket: say in its body that it only asks a question, so its session answers in the final report and commits nothing. See [Answer one question](#answer-one-question) for settling it.
2. Model dependencies explicitly: `blocked_by` in a source becomes `blockedBy` in the CLI JSON. A blocker is satisfied only by `mergeStatus: merged`, which you record after the push succeeds, or `answered`. Keep the graph acyclic. Spawn only tickets whose blockers are all settled that way. Independently ready tickets may run together; merge them serially.
3. Call `route` for all unrouted tickets. If it reports `jevUnavailable`, choose tiers yourself through `route --ticket <id> --tier <tier>`: low for a bounded mechanical edit, medium for familiar feature work, high for cross-module reasoning, frontier for architectural uncertainty. Record the reason in the ticket body. Keep low-confidence routes, model fallbacks and orchestrator routes in the review notes; use the recorded mapping, not invented model names.
4. Call `spawn --ticket <id>`. Inspect its actual model/effort and warnings. On success, write back **in progress** to the ticket's tracker. Record a failed write-back and continue other work. A failed spawn may leave a worktree named in its error; preserve that path in the record. A response with `deferred: true` is provider pacing, not a failed attempt: preserve its state and reason, end the turn, and let Toucan own the recheck. Pacing exists so you do not burn through a window on your own, not to leave usage unused until the reset. On a deferral weigh its `outlook`: when `projectedWithOneMore` stays at or below about 95%, spawn again with `--force --reason <why>` naming the numbers. When the projection is `null` (too little history), judge from the remaining percent, `minutesToReset` and the `working` sessions: 10% left with ten minutes to the reset and little else working is a start, five busy sessions is not. A ticket need not finish before the reset. Otherwise end the turn. When the user asks to start a ticket now, or Toucan relays their Start now, always use `--force --reason` with their request as the reason.
5. End your turn when the remaining progress depends on running ticket sessions or provider pacing. Toucan wakes you on completion, failure, questions, permission prompts and pacing reopen. A `completed (background work pending: N tasks)` wake is not the ticket's result: the session left work running, such as a test suite, and Toucan wakes you again when it reports back. Do not review, merge or escalate that ticket until a later wake for it. On each wake, reread `status`, `plan show` and relevant `outcome` records; after a pacing reopen also reread `usage` before retrying one spawn. Answer questions with `followup` when the task gives you the answer. Permission prompts belong to the human; report them and keep independent work moving.

## Merge one ticket

Inspect its final report, diff and verification evidence first. Unresolved blocking findings, unexplained skipped/deleted tests or open product questions keep it unmerged. Record findings and follow up with its own session. Confirm the ticket session is settled, its worktree is clean and every blocker is merged.

1. Ticket sessions defer the full test suite to this step, so it runs once, on what is merged. When the ticket branch lacks the `targetBranch` tip, rebase it yourself in its worktree: `git -C <worktree> rebase <targetBranch>`. On a conflict, run `git -C <worktree> rebase --abort` at once and hand the conflict to the session as in [merge-recovery.md](merge-recovery.md); never resolve it yourself. Then, unless a report already names the branch's current HEAD as the commit where the full suite passed, send `followup --ticket <id>`: run the project's full test suite in the worktree and report the commit tested with its result. End your turn; act on its wake. Read [merge-recovery.md](merge-recovery.md) for rejected pushes too.
2. On the wake, take the commit the report names as the one the full suite passed on. A failed, missing or partial suite run keeps the ticket unmerged; record the command and failure. Never accept a skipped or deleted failing test as qualifying the merge.
3. Call `merge --ticket <id> --tested <commit>`. Toucan proves the commit is the ticket branch HEAD and contains the target tip, fast-forwards the target, pushes its upstream, records `mergeStatus: merged` and cleans the ticket up. Merge only through this command, so a merge never sits silently behind your own Git permission prompt.
4. On `ok: true`, put `commit` and its link in the ticket's body and close its tracker item with that link using your own tools. A failed tracker write-back leaves the merge valid; record it separately. Inspect `cleanup.removed` and `cleanup.retained`; record and report a retained reason, and leave the valid merge in place.
5. On a refusal, read `stage`. `check`: nothing moved; act on `error` (a target the branch lacks returns you to step 1). `merge`: the fast-forward failed; record and report it. `push`: the target checkout holds the merge but its upstream does not; with `rejected: true` follow the push-rejected recovery in [merge-recovery.md](merge-recovery.md), otherwise report the authentication, permission or connectivity blocker. Once its cause is fixed, the same `merge` call publishes the local target.
6. Reread the record and dispatch newly unblocked tickets. Repeat for the next settled ticket in dependency order.

## Answer one question

An answer-only ticket is never merged. Once its session's turn has ended with the answer in its final report:

1. Record `ticket update <id> --json '{"mergeStatus":"answered"}'`. Toucan accepts it only when the session has settled with nothing pending, its worktree is clean and its branch holds no commit the target lacks. A refusal naming commits means the session changed something: review and merge it as above instead.
2. Put the answer, with the files and lines it rests on, in the ticket's body and relay it to the user.
3. Call `cleanup --ticket <id>` immediately, as for a merged ticket.
4. A follow-up question becomes a new answer-only ticket. Put the previous answer, its file references and the previous ticket's outcome record path in its body, so the new session reads the cited code and, only if needed, the earlier transcript, instead of searching again.

## Failure and escalation

Distinguish implementation failures from a question, permission prompt, sign-in or usage-limit pause; waiting on the human or quota is not a failed attempt. For an implementation failure, increment `attempts`, preserve the outcome, route, commit/worktree and reason in the ticket's body, and comment the reason on its tracker. A transport refusal is not evidence the implementation failed: inspect status and work left behind first.

Call `escalate --ticket <id>` once per failed attempt, then respawn on that recorded route. A fresh worktree starts from the target, so carry useful findings and the previous worktree path in the body; instruct the new session how to inspect prior work. Retain earlier attempts. At `frontier`, or when the spawn allowance is exhausted, set `mergeStatus: unmerged` and place it and its blocked dependents on the review list. Rebase-conflict retries have their own two-attempt limit in the recovery reference; escalation never resets that limit.

## Finish and review

Persist progress and review notes in each ticket's `body` through `ticket update`, preserving its acceptance criteria and source. Record commit/worktree links, conflict attempts, escalations, unresolved findings, test omissions, questions, permissions and failed write-backs as they occur, so a resume can rebuild the review list. CLI `attempts` counts failed implementation attempts; keep the conflict counter explicitly in these notes. Reconcile a resumed record against Git before repeating a merge or tracker update.

When no further authorized work can progress, call `cleanup` once as a final sweep and inspect `removed` and `retained`. Unmerged work stays for the human. Report partial cleanup, with the reason and remaining branch/path; retry only after addressing that reason. Cleanup deletes merged and answered local branches and worktrees, while conversations remain in History.

Then call `report` once. It covers every orchestration of this project, not only this one, and feeds the routing section of the final answer only under the conditions below. Never edit the tier mapping yourself, even when a proposal looks obvious: the human decides.

## Ticket-state table

Every status you report to the user, interim or final, includes this Markdown table, one row per ticket, with the ticket in the column of its current state and every other cell of its row empty. Show the ticket id and a short title (`#3 Add retry`); do not drop a ticket because it needs nothing.

| Open | In Progress | Test / Background task | Finished | Needs you | Merged |
| ---- | ----------- | ---------------------- | -------- | --------- | ------ |

Place a ticket by the first rule that fits, from `status`, `plan show` and what you know of your own dispatches:

- **Needs you**: a pending question or `permissionPrompt` (`pendingPermissionPrompts`), `auth_required`, `mergeStatus: unmerged` after exhausted escalation or the frontier or spawn allowance, failed rebase-conflict retries, and anything else waiting on the human. Add the reason in the cell.
- **Merged**: `mergeStatus: merged`, linking the commit; an answer-only ticket with `mergeStatus: answered` is marked `answered`.
- **Test / Background task**: the pre-merge `followup` (full suite, or conflict resolution and full suite) you sent is still running, or its last wake was `completed (background work pending: N tasks)`.
- **In Progress**: the session's `state` is `starting` or `working`, and none of the above applies.
- **Finished**: the session has settled (`ready`, or its turn ended with nothing pending) and awaits your review or merge.
- **Open**: `not spawned`, including a ticket whose blockers are unmerged (mark it `blocked`) and one deferred by provider pacing (mark it `deferred`). A ticket whose session shows `not running` after a restart is not Open: reread its outcome and Git, then place it by what they show.

`status` carries no flag for background work or a running followup; derive both from the wakes and your own `followup` calls, and note them in the ticket's `body` so a resume can rebuild the table.

## Final answer

Your final answer is the **review list**, with a commit or worktree for every ticket mentioned. Start it with the ticket-state table.

- Low-confidence routes, escalations, orchestrator-routed tickets and model fallbacks.
- Unresolved blocking review findings and any skipped or deleted tests, including the reason.
- Open questions and pending permission prompts requiring the human.
- Unmerged tickets, their blocked dependents and retained worktrees.
- Failed tracker write-backs and partial cleanup.
- Forced spawns that bypassed the usage limits, with their reasons (`forcedSpawns` in `report`).

For a category with no entries say none, concisely. Link merged commits even when there are no findings. If sessions are still working, this is an interim status and you end the turn for Toucan's wake; do not call the orchestration finished.

**Routing is conditional.** There is no always-on routing section.

- When at least one ticket was escalated in this orchestration, add a **Routing report** built from `report`: one table of Jev's routes and a separate one of orchestrator routes, each row a provider, tier and model with its tickets, merged without escalation, escalated and median turns. Never merge rows of different providers, even when the model names match. Then list each proposal's `summary` and its `configEntry` `from` → `to` for that provider's file in `config`. Name each entry of `mappingErrors` if there are any.
- When nothing was escalated but `report` returns proposals, add a single line naming each proposal's `summary` and its `configEntry` `from` → `to`. No tables.
- Otherwise leave routing out entirely, without saying that it was omitted.
