---
status: accepted
---

# Make one work task the single canvas object that owns one provider thread

The canvas shows exactly one interactive card per owner-visible work task, and each card owns one persistent Codex thread for its whole life, including follow-up turns and clarification answers. Direct answers stay in the Coordinator conversation and create no card, while internal provider activity — commands, plans, tool calls, and nested agent invocations — is recorded as labelled activity inside the owning card rather than as additional canvas objects. Task completion posts a concise Coordinator line composed from the worker's structured result, so the detailed output stays in the card transcript and no extra model turn is spent on narration. This trades the ability to visualize an agent's internal fan-out for a canvas whose object count matches the owner's own mental task list.

## Consequences

- Card count is owner-intent driven: a request produces one card by default, and a Coordinator Turn that proposes more is clamped deterministically unless the owner's own words asked for parallel work.
- A task's thread identity is durable state, so a follow-up continues the same conversation instead of starting a fresh session that has lost its context.
- Provider-specific subagent visualization is deliberately not modelled; the common denominator across adapters stays terminal-like activity plus a resumable thread.
- Card transcripts, not the Coordinator conversation, are the home for long results; the conversation keeps one concise line per task outcome.
- Because internal steps are attributed rather than hidden, canvas noise is controlled by collapsing them into the card instead of by discarding the record.
- Task and thread identifiers travel on every Activity Event, so a stuck or ambiguous task can be inspected locally without reconstructing which provider session it owned.
