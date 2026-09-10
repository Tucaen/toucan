# Cheap routine-work delegation

Plan: [issue #177](https://github.com/Tucaen/ade/issues/177). First slice: [issue #178](https://github.com/Tucaen/ade/issues/178) (Codex provider). Second slice: [issue #179](https://github.com/Tucaen/ade/issues/179) (Claude provider).

A workspace preference, "Delegate routine work cheaply", lets a conversation spawn bounded routine
work (substantial searches, extraction, prescribed checks) onto an economical worker model while
the selected main model keeps planning, diagnosis and review. One `enabled` flag, one worker choice
per provider (`codexWorkerModelId`, `claudeWorkerModelId`), so switching a node's provider keeps
both choices and applies only the active provider's configuration. Policy module:
`src/shared/routine-delegation.ts`.

## Codex

### Mechanism (verified on codex-acp 1.10.0 / Codex 0.153.4)

- The codex-acp adapter parses the `CODEX_CONFIG` environment variable (JSON) once at process start
  and merges it into every `thread/start`/`thread/resume` config. Toucan launches one adapter
  process per canvas node, so `CODEX_CONFIG` is per-session configuration that never touches
  `~/.codex/config.toml`. codex-acp exposes no other surface for this (no session/new param, no
  `_meta`, no CLI flag).
- Config keys, parse-checked on the installed binary: `agents.default_subagent_model`,
  `agents.default_subagent_reasoning_effort`, `agents.max_concurrent_threads_per_session` (native
  concurrency cap, 2), `agents.max_depth` (native recursion bar, 1), and top-level
  `developer_instructions` — the instruction channel at developer priority, so it can actually
  authorize delegation.
- The instruction tells the main model to call `spawn_agent` and omit the `model` parameter so the
  configured subagent default applies; classification happens in the main model's own reasoning,
  never via an extra model call.
- Worker list (`CODEX_WORKER_MODELS`) is explicit and hand-ordered cheapest-first, because account
  model availability does not establish price ordering. Currently: GPT-5.6 Luna ($0.2/M in,
  $1.2/M out — 10x cheaper than Terra) at low reasoning effort.
- Launch-time honesty: if the account's model cache exists and does not list the worker, the
  configuration is withheld (`status: 'unavailable'` with reason) instead of launching sessions
  whose spawns would fail. A configured policy is always surfaced as *requested, not
  provider-confirmed* — neither adapter echoes back the model a spawn actually ran.

### Instruction-only limitations (documented deliberately)

- The read-only worker scope ("reads and prescribed checks only, no code edits") and the fresh
  compact brief format live in `developer_instructions`. The native worker-side channel
  (`features.multi_agent_v2.subagent_developer_instructions`) belongs to the `multi_agent_v2`
  feature, which is disabled in Codex 0.153.4, so there is no runtime enforcement of the worker
  scope — only the concurrency cap and recursion depth are native controls.
- Failure rules (return concise evidence, no retry loops, no silent expensive fallback) are likewise
  instruction-only.

### Live smoke test (2026-09-10)

Versions: codex-acp 1.10.0, Codex CLI 0.153.4, account main model gpt-6-astra.

`codex exec --json --sandbox read-only` with the exact `codexDelegationConfig` values passed as
`-c` overrides and a qualifying bounded task ("list exported `is*` functions in two named files,
delegate via spawn_agent"). Result:

- The parent (gpt-6-astra) spawned one subagent thread; the worker rollout's `session_meta` shows
  `source.subagent.thread_spawn` with the parent thread id, and its `turn_context` shows
  `model=gpt-5.6-luna`, `effort=low`, read-only sandbox.
- The worker received a fresh thread (compact context, no conversation fork) and the parent
  reported the correct answer verbatim.

Transport gap, recorded deliberately: the live test drove the Codex CLI directly with the same
config values as `-c` overrides; it did not go through the codex-acp ACP transport. The
`CODEX_CONFIG` half of the chain (env var → `createSessionConfig` merge into every
`thread/start`/`thread/resume`) was verified by inspecting the installed adapter's code
(codex-acp 1.10.0 dist) and is covered by launch-environment tests, but no end-to-end spawn
through the adapter was exercised live. codex-acp is a pinned dependency, so the inspected code
is the code that ships.

## Claude

### Mechanism (verified on claude-agent-acp 0.75.1 / Agent SDK 0.3.220 / Claude Code 2.1.266)

- claude-agent-acp accepts SDK options per session in `_meta.claudeCode.options` on `session/new`
  and `session/load` (`createSession` spreads them into the `query()` options; a resumed session
  reaches the same code through `getOrCreateSession`, and between-turn recreations reuse the stored
  `creationParams`). Toucan already uses this channel for skills plugins; the delegation adds
  `agents: { 'routine-worker': { description, prompt, tools, model } }`. The SDK forwards `agents`
  in its control-protocol `initialize` request, so the definition exists only for that session —
  nothing is written to `~/.claude/agents` or `settings.json`.
- The parent's routing instruction rides on `_meta.systemPrompt` as a `claude_code` preset
  `append`. It is a system prompt, not a transcript message: no worker text enters the parent
  transcript, and `session/load` replay is unaffected.
- The worker is pinned on its definition (`model: 'haiku'`, the CLI's picker alias, which resolved
  to `claude-haiku-4-5-20251001` here). Precedence read from the installed CLI binary:
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides everything (every subagent then runs on
  `CLAUDE_CODE_SUBAGENT_MODEL` or the main model); otherwise an explicit per-spawn `model`
  parameter or the agent definition's `model` wins over `CLAUDE_CODE_SUBAGENT_MODEL`, which in
  turn wins over inheriting the parent. `CLAUDE_CODE_SUBAGENT_MODEL` is deliberately *not* used:
  it would put every specialist subagent (Explore, Plan, reviewers) on the cheap model.
- Native controls: the worker's `tools` list is `Read, Grep, Glob, Bash` — no `Agent` tool, so it
  cannot delegate further (the recursion bar), and no `Edit`/`Write`, so it cannot edit through
  them. Its own prompt restates the read-only scope and the stop-on-ambiguity rule.
- Launch-time honesty, same visible contract as Codex (`status: 'configured' | 'unavailable'`,
  worded as requested-not-confirmed): the worker is withheld before launch when
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is in the launch environment, or when the last Claude
  session in this process did not list the worker model. The first Claude session has no earlier
  list to consult, so it launches on trust and is verified against its own `session/new` model list
  once it opens — if the list lacks the worker the record turns `unavailable` with a visible
  reason. Residual gap on that one session: the definition is already registered, and the CLI
  would substitute a model missing from its `availableModels` allowlist with "the newest allowed
  model in its family" (warn-level log only) — the visible note is the guard there. The remembered
  list is process-wide and belongs to whichever Claude session opened last, so after an account
  switch it is stale until the next Claude session opens and refreshes it.
- Permissions, working directory and Stop are untouched by construction: the worker runs inside
  the parent's own SDK `query()`, so its tool calls arrive as ordinary `tool_call` notifications
  (stamped `parentToolUseId`, see `delegationOf`) under the parent's permission mode and cwd, and
  cancelling the parent's turn cancels the worker with it. The live smoke test exercised the same
  process shape (worker `Read` calls carried `parent_tool_use_id`); permission prompts raised from
  inside a worker were not exercised live.
- Unsupported versions: the delegation has no version guard. `claude-agent-acp` is pinned to an
  exact version in `package.json`; an older adapter that ignored `_meta.claudeCode.options.agents`
  or `_meta.systemPrompt` would leave the UI reading "requested" while nothing delegates, which is
  why the wording is requested-not-confirmed. Upgrade the adapter deliberately and rerun
  `tests/acp-session-manager-claude-delegation.test.ts` plus the smoke test below.

### Instruction-only limitations (documented deliberately)

- No native concurrency cap: "at most two routine workers" is prompt guidance for Claude.
- `Bash` stays available for prescribed checks, so "no code edits" is native only for the
  `Edit`/`Write` tools; a shell command could still write, and could in principle start a nested
  `claude -p`, so the recursion bar is native only for the `Agent` tool. Prompt guidance covers
  the rest.
- Failure rules (return concise evidence, no retry loops, no silent expensive fallback) are
  instruction-only, as for Codex.
- The FORCE variable can also be set through the `env` block of `settings.json`, which Toucan
  cannot see before launch; only the launch environment is checked.

### Live smoke test (2026-09-10)

Versions: Claude Code 2.1.266, claude-agent-acp 0.75.1, Agent SDK 0.3.220, account main model
claude-opus-5[1m]; `supportedModels()` on this account listed default, opus[1m],
claude-fable-5[1m], sonnet, haiku.

`claude -p --output-format stream-json --verbose --agents <exact claudeDelegationSessionMeta agents JSON>
--append-system-prompt <exact instruction>` with a qualifying bounded task ("list exported `is*`
functions in two named files, delegate"). Result:

- The parent (claude-opus-5) called `Agent` with `subagent_type: "routine-worker"`, a fresh
  self-contained brief, and no `model` parameter.
- Every worker tool call (`Read` ×2, `parent_tool_use_id` set) carried
  `model: claude-haiku-4-5-20251001`; the result's `modelUsage` billed the worker under
  `claude-haiku-4-5` ($0.029 of the $0.35 turn).
- The parent reported the worker's answer verbatim and correctly.

Transport gap, recorded deliberately: the live test drove the CLI directly with the same values
as `--agents`/`--append-system-prompt`; it did not go through claude-agent-acp's `_meta`. That half
(`_meta.claudeCode.options` → `query()` options on `session/new`/`session/load`) was verified by
inspecting the installed adapter's dist and is covered by
`tests/acp-session-manager-claude-delegation.test.ts` against a scripted adapter.
