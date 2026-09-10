# Cheap routine-work delegation

Plan: [issue #177](https://github.com/Tucaen/ade/issues/177). First slice: [issue #178](https://github.com/Tucaen/ade/issues/178) (Codex provider).

A workspace preference, "Delegate routine work cheaply", lets a Codex conversation spawn bounded
routine work (substantial searches, extraction, prescribed checks) onto an economical worker model
while the selected main model keeps planning, diagnosis and review. Policy module:
`src/shared/routine-delegation.ts`.

## Mechanism (verified on codex-acp 1.10.0 / Codex 0.153.4)

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

## Instruction-only limitations (documented deliberately)

- The read-only worker scope ("reads and prescribed checks only, no code edits") and the fresh
  compact brief format live in `developer_instructions`. The native worker-side channel
  (`features.multi_agent_v2.subagent_developer_instructions`) belongs to the `multi_agent_v2`
  feature, which is disabled in Codex 0.153.4, so there is no runtime enforcement of the worker
  scope — only the concurrency cap and recursion depth are native controls.
- Failure rules (return concise evidence, no retry loops, no silent expensive fallback) are likewise
  instruction-only.

## Live smoke test (2026-09-10)

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
