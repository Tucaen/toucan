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

**Requested, not confirmed**:
The honesty stance for every session-launch policy: a session carries the configuration, but nothing verifies the agent honours it, so every surface words the policy as requested rather than enforced.
_Avoid_: enabled (implies enforcement), active
