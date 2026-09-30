# Toucan

A desktop workspace for hosting and steering coding-agent sessions (Claude, Codex) on a canvas. This glossary pins the terms the codebase and its issues use for session-scoped agent policies.

## Language

### Delegation policies

**Routine delegation**:
Offloading routine work — bounded searches, extraction, prescribed checks and recipe-driven mechanical edits — from the main model onto an economical worker model.
_Avoid_: cheap delegation, subagent mode

**Decision delegation**:
Offloading decision-shaped subtasks from the main model onto a decision provider. Independent of routine delegation; the boundary is verdicts versus work that produces or edits files.
_Avoid_: Jev integration, Jev delegation

**Decision-shaped subtask**:
A subtask whose result is a verdict rather than an artifact: choose between options, score candidates, route an intent, classify against fixed labels.

**Decision provider**:
The model a decision-delegating session is told to use, reached through an installed agent skill. Currently only TypeSafe's Jev.
_Avoid_: naming the feature after the provider

### Orchestration

**Orchestrator**:
A dedicated chat node kind that splits one large task into tickets, spawns a ticket session per ticket and merges the results into the branch it was launched on. Plan in `docs/plans/orchestrator-mode.md`.
_Avoid_: orchestrator mode toggle, manager agent

**Ticket session**:
A Toucan-launched chat an orchestrator spawned for one ticket, in its own worktree, bound by the ticket contract.
_Avoid_: subagent (that is the provider's in-turn worker, not a canvas session)

**Ticket contract**:
The rules appended to every ticket session's prompt after the implementation skill: stay in the given worktree, commit, never push, merge or open a PR, end with a final report. It wins over the skill.

**Orchestration record**:
Toucan's tracker-independent state for one orchestration: the task, and per ticket its blockers, route, session, attempts and merge status.

**Difficulty tier**:
Jev's verdict on how hard a ticket is (`low`, `medium`, `high`, `frontier`). Jev never sees models. Toucan's main process asks Jev for it directly, unlike decision delegation, which reaches Jev through the session's skill.

**Tier mapping**:
The user's configuration turning a difficulty tier into a model from the chat node's model picker.

**Requested, not confirmed**:
The honesty stance for every session-launch policy: a session carries the configuration, but nothing verifies the agent honours it, so every surface words the policy as requested rather than enforced.
_Avoid_: enabled (implies enforcement), active
