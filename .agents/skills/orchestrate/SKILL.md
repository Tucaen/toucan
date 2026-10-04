---
name: orchestrate
description: Drive a Toucan orchestration from task breakdown through routed ticket sessions, ordered merges, tracker write-back, cleanup and human review.
disable-model-invocation: true
user-invocable: false
---

# Orchestrate

You are the orchestrator; Toucan starts ticket sessions through its CLI. Read [commands.md](commands.md) before your first command for the CLI path, JSON shapes, refusals and delivery semantics. The environment supplies the endpoint and token. Use your session's own tools for Git, tests and tracker operations.

Keep CLI JSON input files outside the checkout, so writing a plan does not dirty the target you are about to merge into.

## Start or resume

1. Read `plan show` and `status`. An existing record is the source of truth: recover progress, outcomes and the review notes before acting. A completed notification means a turn ended; inspect `outcome` and Git before deciding a ticket is done.
2. Inspect the orchestrator checkout with `git status --porcelain --untracked-files=all` and `git symbolic-ref --quiet --short HEAD`. Refuse to start on a dirty checkout or detached HEAD. Preserve the user's files; ask them to settle the checkout. On resume, an unfinished rebase belongs to the recovery below, not a new task.
3. The launch branch is the target. Record it once; on resume require the checkout to match `targetBranch`. Check its upstream. When none exists, run `git push -u origin <branch>` before spawning. A failed push, missing remote or refused permission is a blocker to report, not permission to change the target or remote. Push only the target branch.

## Breakdown and dispatch

1. For free text, put the task and its tickets in `plan set`; no tracker items need creating. For a tracker reference, read the item and its linked requirements with your own tools, then record its source on the ticket. Include the concrete acceptance criteria, test command and needed context in each ticket's body.
2. Model dependencies explicitly: `blocked_by` in a source becomes `blockedBy` in the CLI JSON. A blocker is satisfied only by `mergeStatus: merged`, which you record after the push succeeds. Keep the graph acyclic. Spawn only tickets whose blockers are all merged. Independently ready tickets may run together; merge them serially.
3. Call `route` for all unrouted tickets. If it reports `jevUnavailable`, choose tiers yourself through `route --ticket <id> --tier <tier>`: low for a bounded mechanical edit, medium for familiar feature work, high for cross-module reasoning, frontier for architectural uncertainty. Record the reason in the ticket body. Keep low-confidence routes, model fallbacks and orchestrator routes in the review notes; use the recorded mapping, not invented model names.
4. Call `spawn --ticket <id>`. Inspect its actual model/effort and warnings. On success, write back **in progress** to the ticket's tracker. Record a failed write-back and continue other work. A failed spawn may leave a worktree named in its error; preserve that path in the record.
5. End your turn when the remaining progress depends on running ticket sessions. Toucan wakes you on completion, failure, questions and permission prompts. A `completed (background work pending: N tasks)` wake is not the ticket's result: the session left work running, such as a test suite, and Toucan wakes you again when it reports back. Do not review, merge or escalate that ticket until a later wake for it. On each wake, reread `status`, `plan show` and relevant `outcome` records. Answer questions with `followup` when the task gives you the answer. Permission prompts belong to the human; report them and keep independent work moving.

## Merge one ticket

Inspect its final report, diff and verification evidence first. Unresolved blocking findings, unexplained skipped/deleted tests or open product questions keep it unmerged. Record findings and follow up with its own session. Confirm the ticket session is settled, its worktree is clean and every blocker is merged.

1. In the ticket worktree, `git rebase <targetBranch>`. Read [merge-recovery.md](merge-recovery.md) for conflicts or rejected pushes.
2. Run the project's **full test suite in that worktree**, using the command established from the project. A passing pre-rebase run is insufficient. If the suite cannot run or fails, keep the ticket unmerged and record the command and failure; never skip or delete a failing test to qualify the merge.
3. Recheck the target checkout is clean and on `targetBranch`, then run `git merge --ff-only <ticketBranch>` there. If the target advanced, repeat the rebase and full suite. Do not force or create a merge commit.
4. Push the target's configured upstream. Only after a successful push, record `mergeStatus: merged`, the resulting commit and commit link in the ticket's body. Close its tracker item with that link using your own tools. A failed tracker write-back leaves the Git merge valid; record the write-back failure separately.
5. Reread the record and dispatch newly unblocked tickets. Repeat for the next settled ticket in dependency order.

## Failure and escalation

Distinguish implementation failures from a question, permission prompt, sign-in or usage-limit pause; waiting on the human or quota is not a failed attempt. For an implementation failure, increment `attempts`, preserve the outcome, route, commit/worktree and reason in the ticket's body, and comment the reason on its tracker. A transport refusal is not evidence the implementation failed: inspect status and work left behind first.

Call `escalate --ticket <id>` once per failed attempt, then respawn on that recorded route. A fresh worktree starts from the target, so carry useful findings and the previous worktree path in the body; instruct the new session how to inspect prior work. Retain earlier attempts. At `frontier`, or when the spawn allowance is exhausted, set `mergeStatus: unmerged` and place it and its blocked dependents on the review list. Rebase-conflict retries have their own two-attempt limit in the recovery reference; escalation never resets that limit.

## Finish and review

Persist progress and review notes in each ticket's `body` through `ticket update`, preserving its acceptance criteria and source. Record commit/worktree links, conflict attempts, escalations, unresolved findings, test omissions, questions, permissions and failed write-backs as they occur, so a resume can rebuild the review list. CLI `attempts` counts failed implementation attempts; keep the conflict counter explicitly in these notes. Reconcile a resumed record against Git before repeating a merge or tracker update.

When no further authorized work can progress, call `cleanup` once and inspect `removed` and `retained`. Unmerged work stays for the human. Report partial cleanup, with the reason and remaining branch/path; retry only after addressing that reason. Cleanup deletes merged local branches and worktrees, while conversations remain in History.

Then call `report` once for the routing report. It covers every orchestration of this project, not only this one. Never edit the tier mapping yourself, even when a proposal looks obvious: the human decides.

Your final answer is the **review list**, with a commit or worktree for every ticket mentioned:

- Low-confidence routes, escalations, orchestrator-routed tickets and model fallbacks.
- Unresolved blocking review findings and any skipped or deleted tests, including the reason.
- Open questions and pending permission prompts requiring the human.
- Unmerged tickets, their blocked dependents and retained worktrees.
- Failed tracker write-backs and partial cleanup.

End it with a **Routing report** section built from `report`: one table of Jev's routes and a separate one of orchestrator routes, each row a provider, tier and model with its tickets, merged without escalation, escalated and median turns. Never merge rows of different providers, even when the model names match. Then list each proposal's `summary` and its `configEntry` `from` → `to` for that provider's file in `config`. With no proposals, say none reached the minimum sample of `minimumSample` settled tickets. Name each entry of `mappingErrors` if there are any.

For a category with no entries say none, concisely. Link merged commits even when there are no findings. If sessions are still working, this is an interim status and you end the turn for Toucan's wake; do not call the orchestration finished.
