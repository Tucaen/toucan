# Task canvas vertical-slice demo

This implementation is the deliberately thin experiment from issues #19 and #20. It answers one question: does a Windows-native canvas with one interactive card per work task, each backed by its own Codex thread, give the overview and interaction model ADE wants?

The layout keeps the approved Variant A structure: one permanent Coordinator panel beside one Project canvas. The canvas and the automatic Flow view render the same runtime-backed task cards.

## Interaction model

- A **question** is answered in the Coordinator conversation and creates no card.
- A **work request** creates one task card that owns one persistent Codex thread. Several cards appear only when the owner's own words ask for parallel tasks; otherwise ADE keeps one card and says so.
- A **collapsed card** shows concise status plus the activity the task itself reported, never the long final response and never its internal provider steps.
- An **opened card** is that task's thread surface: objective, acceptance criteria, internal steps, full transcript, and a composer that sends follow-up messages into the same Codex thread.
- **Internal Codex activity** — inspection commands, plans, tool calls, and nested agent invocations — is labelled activity inside the owning card, collapsed behind a step count. It never becomes another card.
- When a task finishes, the Coordinator posts one concise line composed from the task's structured result. The detailed output stays in the card transcript, so no extra model turn is spent on narration.

The rationale is recorded in [ADR 0003](./adr/0003-one-task-one-card-one-provider-thread.md).

## Prerequisites

- Node.js 22 or newer
- a ChatGPT plan that includes Codex access
- one local Git repository that is safe to inspect read-only

The slice uses the official Codex SDK and its local Codex runtime. It authenticates with ChatGPT subscription access, not an API key, and runs natively on Windows without WSL. By default Codex selects the model configured for the signed-in account; `ADE_CODEX_MODEL` can provide an explicit override.

Sign in once with the same ChatGPT account used in Codex:

```powershell
npm run login
```

The browser-based flow stores the local Codex session in the standard Codex configuration. Check it without using model quota with `npm run auth:status`.

## Start ADE

From this repository in PowerShell:

```powershell
npm start -- --project "D:\path\to\fixture-repository" --name "Fixture"
```

Open `http://127.0.0.1:4319`. Optional settings are `--port 4319`, `--data D:\path\to\ade-data`, `ADE_CODEX_MODEL`, `ADE_CODEX_REASONING`, `ADE_PROJECT_PATH`, `ADE_PROJECT_NAME`, and `ADE_DATA_PATH`.

Every Coordinator Turn and task turn runs in Codex's read-only sandbox with approvals disabled, network access disabled, and no permission to mutate the repository. Runtime data is written under ADE's own data root, not inside the configured Project.

## Reproduction scenario

Work through these four requests in order.

1. **Direct answer, no card.**

   ```text
   What is this repository for, and what are its main parts?
   ```

   The answer appears in the Coordinator panel. The canvas stays empty and the activity record shows `request.classified` with mode `answer`.

2. **One work task, one card, one thread.**

   ```text
   Investigate how this repository persists run history and report what one run file contains.
   ```

   Exactly one card appears. Its status and recent activity update live, with no reload. The card's internal steps grow while it inspects the repository; they stay inside the card. When it finishes, the Coordinator posts one concise line with a link to the card, and the full result is in the card transcript.

3. **Follow-up in the same thread.**

   Open the card and send:

   ```text
   Now name the riskiest assumption in that persistence approach.
   ```

   The follow-up and its answer stay in that card. The footer keeps showing the same task id and Codex thread id, so the continuation is verifiably the same thread.

4. **Several tasks plus a clarification.**

   ```text
   Run two parallel tasks. One should map the runtime architecture.
   The other should compare the two most useful next implementation increments,
   but ask me which to prioritize before it concludes.
   ```

   Two cards run concurrently. The clarification appears both in the Coordinator panel and on its originating card; answering from either place records one answer, clears both prompts, and resumes that one thread. While they run, ask `What is running right now?` — the Coordinator answers without adding a card.

## Inspecting a run

Open **Activity** in the lower-left corner for the append-only record. Every event carries its task id and Codex thread id.

Per-task detail is also available directly:

```powershell
curl http://127.0.0.1:4319/api/tasks/<task-id>
```

By default durable files live under `.ade/projects/<project-hash>/` in the directory where ADE is started. `ADE_DATA_PATH` or `--data` can move that root:

- `state.json` is the latest restorable UI/runtime snapshot.
- `runs/<run-id>.jsonl` is the append-only event record for a run.

The `.ade/` data root is intentionally disposable for this experiment and is ignored by this repository's `.gitignore`. A task that was mid-turn when ADE stopped is restored with its outcome recorded as unknown; it is neither called failed nor silently resumed.

## Verify without API usage

```powershell
npm test
```

The tests use injected SDK and provider fakes to verify direct answers without cards, one-card/one-thread task creation, subagent containment, concise collapsed status against a long transcript result, same-thread follow-ups, dual-surface clarification answering, concurrent tasks, visible failure state, thread-identity inspection, event durability, and the Codex SDK configuration — without invoking a model or consuming subscription quota.

## Known contract gaps in this slice

These are deliberate, so the slice stays thin. They are named here rather than implied as compliance with the [Coordinator interaction contract](./specification/coordinator-interaction-contract.md) and [Work Item lifecycle contract](./specification/work-item-lifecycle-contract.md):

- A completed card reports the task's own claim. There is no Verified Completion, no evidence linking, and no `review_candidate` state, so "completed" here means "reported complete".
- The structured task result carries status, concise summary, activities, question, and detail. It does not yet carry verification attempted, evidence, deviations, or the next owner action.
- Fan-out is gated deterministically on the owner's own wording rather than by an explicit confirmation step, and there is no Policy Engine.
- An interrupted task becomes `unknown` and simply stops; there is no `reconciling` state, no Writer Lease, and no fencing of a previous writer.
- Card status is provider-turn liveness, not Work Item State. Work Items, Delegation Brief records, and Attention Events are not implemented as separate durable records.

## Out of scope for this slice

NodeTerm is a reference for the interaction model only; this slice does not depend on it. FirstMate-style orchestration, Personal Vault integration, worktree mutation, remote access, and production persistence remain future work.
