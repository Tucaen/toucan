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

1. Read `plan show` and `status`. An existing record is the source of truth: recover progress, outcomes and the review notes before acting, and settle `status.unrecorded` as [Unrecorded attempts](#unrecorded-attempts) describes. A completed notification means a turn ended; inspect `outcome` and Git before deciding a ticket is done.
2. Inspect the orchestrator checkout with `git status --porcelain --untracked-files=all` and `git symbolic-ref --quiet --short HEAD`. Refuse to start on a dirty checkout or detached HEAD. Preserve the user's files; ask them to settle the checkout. On resume, an unfinished rebase belongs to the recovery below, not a new task.
3. The launch branch is the target. Record it once; on resume require the checkout to match `targetBranch`. Check its upstream. When none exists, run `git push -u origin <branch>` before spawning. A failed push, missing remote or refused permission is a blocker to report, not permission to change the target or remote. Push only the target branch.

## Breakdown and dispatch

1. For free text, put the task and its tickets in `plan set`; no tracker items need creating. For a tracker reference, read the item and its linked requirements with your own tracker tools (not the code), then record its source on the ticket. Include the concrete acceptance criteria, the test command when the task names one, and the context the task gives in each ticket's body; the ticket session finds the rest in the code. A question that needs no change becomes an answer-only ticket: say in its body that it only asks a question, so its session answers in the final report and commits nothing. See [Answer one question](#answer-one-question) for settling it.
2. Model dependencies explicitly: `blocked_by` in a source becomes `blockedBy` in the CLI JSON. A blocker is satisfied only by `mergeStatus: merged`, which you record after the push succeeds, or `answered`. Keep the graph acyclic. Spawn only tickets whose blockers are all settled that way. Independently ready tickets may run together; merge them serially.
3. Call `route` for all unrouted tickets. If it reports `jevUnavailable`, choose tiers yourself through `route --ticket <id> --tier <tier>`: low for a bounded mechanical edit, medium for familiar feature work, high for cross-module reasoning, frontier for architectural uncertainty. Record the reason in the ticket body. Keep low-confidence routes, model fallbacks and orchestrator routes in the review notes; use the recorded mapping, not invented model names.
4. Call `spawn --ticket <id>`. Inspect its actual model/effort and warnings. On success, write back **in progress** to the ticket's tracker. Record a failed write-back and continue other work. Read a reply before its exit code, because exit 1 covers three different answers:
   - `pending: true`: the session is slow to start, not failed. It stays linked and open. Write back **in progress**, end the turn and wait for the `started` or `start-failed` wake; never respawn. Only a `start-failed` wake frees the ticket to spawn again.
   - `duplicate: true`: the ticket already has an unresolved attempt, named in `attempt`. Do not spawn again: wait for its wake or read `status`. Use `--replace` only when you have decided that attempt is superseded, and record why in the ticket's body.
   - A failure before the canvas leaves nothing behind and the ticket may spawn again; a failure after it leaves a worktree and branch named in `error` and a node the human can see, so preserve that path in the record and check `status.unrecorded` before retrying. A worktree or branch no recorded attempt names is an unrecorded attempt: see [Unrecorded attempts](#unrecorded-attempts).

   A response with `budgetReached: true` is the spawn-budget checkpoint, not a failed attempt and not a reason to give up: end the turn and wait for the human's **Continue (+20)**, which raises the budget for this same orchestration and wakes you to retry (see `spawn` in the commands reference). A response with `deferred: true` is provider pacing, not a failed attempt: preserve its state and reason, end the turn, and let Toucan own the recheck. Pacing exists so you do not burn through a window on your own, not to leave usage unused until the reset. On a deferral weigh its `outlook`: when `projectedWithOneMore` stays at or below about 95%, spawn again with `--force --reason <why>` naming the numbers. When the projection is `null` (too little history), judge from the remaining percent, `minutesToReset` and the `working` sessions: 10% left with ten minutes to the reset and little else working is a start, five busy sessions is not. A ticket need not finish before the reset. Otherwise end the turn. When the user asks to start a ticket now, or Toucan relays their Start now, always use `--force --reason` with their request as the reason.

5. End your turn when the remaining progress depends on running ticket sessions, pending starts, provider pacing or the human's Continue at the spawn budget. Toucan wakes you on completion, failure, questions, permission prompts, a pending start's `started` or `start-failed`, pacing reopen and Continue; after a Continue wake reread `status` and `plan show`, then retry the refused spawn. A `completed (background work pending: N tasks)` wake is not the ticket's result: the session left work running, such as a test suite, and Toucan wakes you again when it reports back. Do not review, merge or escalate that ticket until a later wake for it. On each wake, reread `status`, `plan show` and relevant `outcome` records; after a pacing reopen also reread `usage` before retrying one spawn. Answer questions with `followup` when the task gives you the answer. A question only the human can answer is pinned once, whether a ticket session asks it, a final report leaves an open product question, or it is your own (then without `--ticket`). Run `question list` first and add nothing already pinned. Read the ticket's `outcome --ticket <id> --full` and copy the question, its context and every link verbatim from `report` into `question add --ticket <id> --file <md>`; never paraphrase or shorten it. When the question has fixed answers - the ticket session's pending question in `status` lists them under `questions[].options`, or you offer a choice yourself - pass them too: `--options-from-session` when the ticket session's pending question is a single select question (preferred, it copies the options exactly), otherwise `--options-file <json>` (`--multi` when several may be picked): Toucan then shows the human the same clickable decision panel the session itself shows, with an "Other" free-text field, instead of text alone. When `report` is `null`, copy it from the session's transcript named in the outcome record instead. From then on name only its id (`Q3`) in every later status, the table and the final answer, never repeat the question text. When the human answers in chat, run `question resolve --id <Q<n>>` (with `--note` for the answer) and send the answer to the session with `followup`. A `[Toucan: user resolved Q<n>]` wake means the human answered in the UI: reread `question list` and `status`, relay their note to the waiting session with `followup` (for a question with options the note is `Answer: <label>` of the option they clicked, plus `(note: ...)` for their own text; a click answers you, not the session), and continue the work that waited on it. Permission prompts belong to the human; report them and keep independent work moving.

## Merge one ticket

Inspect its final report, diff and verification evidence first. Unresolved blocking findings, unexplained skipped/deleted tests or open product questions keep it unmerged. Record findings and follow up with its own session. Confirm the ticket session is settled, its worktree is clean and every blocker is merged.

1. When the ticket branch lacks the `targetBranch` tip, rebase it yourself in its worktree: `git -C <worktree> rebase <targetBranch>`. On a conflict, run `git -C <worktree> rebase --abort` at once and hand the conflict to the session as in [merge-recovery.md](merge-recovery.md); never resolve it yourself. Then decide how much to verify, from the risk of the diff. CI/CD runs the full suite after the merge anyway, and a full run costs real hardware and time, more so with several projects running in parallel, so do not run it by reflex. Read [merge-recovery.md](merge-recovery.md) for rejected pushes too.
   - **Skip the full suite** when the change cannot plausibly break a test (you would bet on it at about 99%): docs, Markdown or skill prose only, comments, copy and text changes, assets and the like. Merge on the ticket session's own targeted verification, taking the branch HEAD as the commit to pass to `--tested`.
   - **Verify further** only when the risk is real: shared or cross-cutting code, build, config or dependency changes, a refactor touching many callers, or targeted tests that left you in doubt. Prefer the affected test subset over the whole suite where that suffices; use the full suite when no subset covers the risk. Unless a report already names the branch's current HEAD as the commit where that run passed, send `followup --ticket <id>` naming the tests to run in the worktree (or the full suite) and asking for the commit tested with its result. End your turn; act on its wake.
   - **Record it:** put the decision and its reason (for example "skipped full suite: SKILL.md prose only") in the ticket's body, and list each skipped full run on the review list as a decision, not as a defect.
2. When you asked for a run, take the commit its report names as the one it passed on. A failed, missing or partial test run keeps the ticket unmerged; record the command and failure. Never accept a skipped or deleted failing test as qualifying the merge, whatever the risk call was. When you skipped the full suite, the commit to pass is the branch HEAD after the rebase; the ticket session's report must still show its targeted verification passing, and a failing or missing one keeps the ticket unmerged.
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

Call `escalate --ticket <id>` once per failed attempt, then respawn on that recorded route. A fresh worktree starts from the target, so carry useful findings and the previous worktree path in the body; instruct the new session how to inspect prior work. Retain earlier attempts. At `frontier`, set `mergeStatus: unmerged` and place it and its blocked dependents on the review list. Rebase-conflict retries have their own two-attempt limit in the recovery reference; escalation never resets that limit.

## Unrecorded attempts

`status.unrecorded` lists worktrees and `ticket/*` branches no recorded attempt names, with their `ahead` commit count and whether a `liveSession` runs there. Read it on every resume and after each `cleanup`: they are work Toucan lost track of, and no `merge` or `cleanup` deletes them (a sweep reports them as retained with reason `unrecorded attempt`). `unrecordedError` means Git could not be read: say the list is unknown, never that it is empty.

Settle every entry whose ticket is not yet merged or answered, one at a time:

1. Read what is there: `git -C <path> log <targetBranch>..HEAD` and `git -C <path> status --porcelain`, and the ticket's outcome record when one exists.
2. Work worth keeping (`ahead` above 0, or a live session): `spawn --ticket <id> --adopt <path>`. It costs no spawn and the ticket continues as a normal attempt. An adopted node has no orchestration edge on the canvas; that is cosmetic. When the ticket still has an unresolved attempt, the guard refuses the adoption: choose which attempt survives and `discard` the other.
3. Work not worth keeping: ask the human, naming the branch, the `ahead` count and any uncommitted files, and run `discard` (`--branch <ticket/...>`, or `--ticket <id> --attempt <n>` for a recorded attempt) **only after they confirm**. `discard` stops the session, force-removes the worktree and deletes the branch with its unmerged commits; it cannot be undone. Your own judgement that an attempt failed, an escalation or a `--replace` never stands in for that confirmation. Pin the question when the human does not answer in this turn, with the ticket id.
4. Reread `status` and record the outcome (adopted or discarded, branch, commits lost) in the ticket's body.

## Finish and review

Persist progress and review notes in each ticket's `body` through `ticket update`, preserving its acceptance criteria and source. Record commit/worktree links, conflict attempts, escalations, unresolved findings, test omissions, questions, permissions and failed write-backs as they occur, so a resume can rebuild the review list. CLI `attempts` counts failed implementation attempts; keep the conflict counter explicitly in these notes. Reconcile a resumed record against Git before repeating a merge or tracker update.

When no further authorized work can progress, call `cleanup` once as a final sweep and inspect `removed` and `retained`. Unmerged work stays for the human. Report partial cleanup, with the reason and remaining branch/path; retry only after addressing that reason. Cleanup deletes merged and answered local branches and worktrees, while conversations remain in History.

Then call `report` once. It covers every orchestration of this project, not only this one, and feeds the routing section of the final answer only under the conditions below. Never edit the tier mapping yourself, even when a proposal looks obvious: the human decides.

## Ticket-state table

Every status you report to the user, interim or final, includes this Markdown table, one row per ticket, with the ticket in the column of its current state and every other cell of its row empty. Show the ticket id and a short title (`#3 Add retry`); do not drop a ticket because it needs nothing.

| Open | In Progress | Test / Background task | Finished | Needs you | Merged |
| ---- | ----------- | ---------------------- | -------- | --------- | ------ |

Place a ticket by the first rule that fits, from `status`, `plan show` and what you know of your own dispatches:

- **Needs you**: a pending question or `permissionPrompt` (`pendingPermissionPrompts`), `auth_required`, `mergeStatus: unmerged` after exhausted escalation or the frontier, an orchestration at its spawn budget waiting for the human's **Continue (+20)** (`budgetReached`; the tickets it could not spawn stay Open), failed rebase-conflict retries, and anything else waiting on the human. Add the reason in the cell; for a pinned question, the ticket and its id (`#3 · Q3`), never the question's text.
- **Merged**: `mergeStatus: merged`, linking the commit; an answer-only ticket with `mergeStatus: answered` is marked `answered`.
- **Test / Background task**: the pre-merge `followup` (test run, or conflict resolution and test run) you sent is still running, or its last wake was `completed (background work pending: N tasks)`.
- **In Progress**: the session's `state` is `starting` or `working`, and none of the above applies. A ticket whose `spawn` answered `pending` belongs here (note `pending start`) until its `started` or `start-failed` wake; on `start-failed` it is Open again.
- **Finished**: the session has settled (`ready`, or its turn ended with nothing pending) and awaits your review or merge.
- **Open**: `not spawned`, including a ticket whose blockers are unmerged (mark it `blocked`) one deferred by provider pacing (mark it `deferred`) and one refused at the spawn budget (mark it `awaiting Continue`). A ticket whose session shows `not running` after a restart is not Open: reread its outcome and Git, then place it by what they show.

An `unrecorded` entry is not a ticket row. Put it in the cell of the ticket it names: **Needs you**, marked `unrecorded` with its branch, while it awaits the human's decision to adopt or discard; once adopted, wherever the adopted session's state places the ticket.

`status` carries no flag for background work or a running followup; derive both from the wakes and your own `followup` calls, and note them in the ticket's `body` so a resume can rebuild the table.

## Final answer

Your final answer is the **review list**, with a commit or worktree for every ticket mentioned. Start it with the ticket-state table.

Write every file you reference, interim or final, and above all screenshots and other images, as a Markdown link to its absolute path as a file URL, e.g. `[before.png](file:///C:/Users/me/shots/before.png)` with spaces as `%20`, never a bare path or a path in backticks: the link opens with one click on the desktop and the phone, and the phone companion fetches a linked file from the desktop by its absolute path and cannot resolve a relative one. After a merge, point at the file in the project checkout, because cleanup removes the worktree. Toucan opens only files inside a project or worktree, so the link must point there, never at the system temp folder: save screenshots, images, reports and anything else meant for the human in the scratch folder your instructions name (`.toucan-scratch` in the main project checkout, ignored by git, so it never blocks a merge or cleanup) and link it from there; a file you or a ticket session left elsewhere is copied into it first.

- Low-confidence routes, escalations, orchestrator-routed tickets and model fallbacks.
- Unresolved blocking review findings and any skipped or deleted tests, including the reason.
- Merges that skipped the full suite on a risk call, with the ticket and the reason (a decision for the human to see, not a defect).
- Open questions (by their pinned id) and pending permission prompts requiring the human.
- Unmerged tickets, their blocked dependents and retained worktrees.
- Unrecorded attempts still open (ticket, branch, `ahead`, live or not), tickets whose start is `pending`, and every `discard` or `--replace` with the human's confirmation or your reason for it.
- Failed tracker write-backs and partial cleanup.
- Forced spawns that bypassed the usage limits, with their reasons (`forcedSpawns` in `report`).

For a category with no entries say none, concisely. Link merged commits even when there are no findings. If sessions are still working, this is an interim status and you end the turn for Toucan's wake; do not call the orchestration finished.

**Routing is conditional.** There is no always-on routing section.

- When at least one ticket was escalated in this orchestration, add a **Routing report** built from `report`: one table of Jev's routes and a separate one of orchestrator routes, each row a provider, tier and model with its tickets, merged without escalation, escalated and median turns. Never merge rows of different providers, even when the model names match. Then list each proposal's `summary` and its `configEntry` `from` → `to` for that provider's file in `config`. Name each entry of `mappingErrors` if there are any.
- When nothing was escalated but `report` returns proposals, add a single line naming each proposal's `summary` and its `configEntry` `from` → `to`. No tables.
- Otherwise leave routing out entirely, without saying that it was omitted.
