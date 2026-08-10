# Multi-agent vertical-slice demo

This implementation is the deliberately thin experiment from issue #19. It keeps the approved Variant A layout: one permanent Coordinator panel beside one Project canvas. The canvas and automatic Flow view render the same runtime-backed Agent Sessions.

## Prerequisites

- Node.js 22 or newer
- a ChatGPT plan that includes Codex access
- one local Git repository that is safe to inspect read-only

The slice uses the official Codex SDK and its local Codex runtime. It authenticates with ChatGPT subscription access, not an API key. By default Codex selects the model configured for the signed-in account; `ADE_CODEX_MODEL` can provide an explicit override.

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

Every Coordinator and Agent Session runs in Codex's read-only sandbox with approvals disabled, network access disabled, and no permission to mutate the repository. Runtime data is written under ADE's own data root, not inside the configured Project.

## Reproduction scenario

Paste this multiline Coordinator request:

```text
Review this repository with exactly two concurrent Agent Sessions.
Have one session map the main architecture and risks.
Have the other compare the two most useful next implementation increments, but ask me which one to prioritize before it concludes.
```

Expected behavior:

1. The Coordinator response appears in the permanent right panel.
2. At least two session cards enter `Starting` and `Working` from real provider calls without a reload.
3. One session completes while the other changes to `Needs input`.
4. The same clarification appears in both the Coordinator panel and its originating card.
5. Answer from either location. Both prompts disappear, one `question.answered` event is recorded, and that same session resumes.
6. Open **Activity** in the lower-left corner to inspect the request, delegations, state changes, question, answer, and outcomes.

By default, durable files live under `.ade/projects/<project-hash>/` in the directory where ADE is started. `ADE_DATA_PATH` or `--data` can move that root:

- `state.json` is the latest restorable UI/runtime snapshot.
- `runs/<run-id>.jsonl` is the append-only event record for a run.

The `.ade/` data root is intentionally disposable for this experiment and is ignored by this repository's `.gitignore`.

## Verify without API usage

```powershell
npm test
```

The tests use injected SDK and provider fakes to verify concurrent execution, visible failure state, single-answer clarification semantics, same-thread resume, event durability, streaming activity, and the Codex SDK configuration without invoking a model or consuming subscription quota.
