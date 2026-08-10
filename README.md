# ADE

ADE is a Windows-first, local-first Agentic Developer Environment: one secure Coordinator for directing development work across bounded Claude, Codex, and terminal-backed agent sessions from desktop or phone.

The project is currently in Wayfinder planning, with one deliberately thin runnable experiment: the prototype-led vertical slice from issues #19 and #20. It is not a production implementation.

## Runnable vertical slice

The slice is a Windows-native task canvas. One owner-visible work task is one interactive card that owns one persistent Codex thread: collapsed it is a concise overview, opened it is that thread's chat surface. Direct questions stay in the Coordinator conversation without creating a card, internal Codex subagent activity stays inside its owning card, and task and thread identity travel on every event in an inspectable append-only record. It uses the official Codex SDK with ChatGPT subscription authentication; it does not require an API key, separately billed API tokens, or WSL.

See [the task canvas demo guide](./docs/vertical-slice-demo.md) for the start command, fixture scenario, safety boundary, and verification steps.

## Current direction

- A short-lived Coordinator experience backed by durable Work Items, not one ever-growing model conversation
- Claude as the preferred Coordinator provider, with Codex failover at safe turn boundaries
- Rich Claude and Codex integrations plus a generic terminal adapter for other CLI agents
- A Git-backed Personal Vault for curated knowledge and a separate Session Registry for runtime state
- Native Windows control plane with optional per-project WSL execution environments
- Private phone access through an owner-restricted tailnet, passkey authentication, scoped approvals, and no public or SSH exposure in the MVP
- Worktree isolation, explicit verification evidence, honest uncertain-completion states, and external budget governance

The canonical language is maintained in [CONTEXT.md](./CONTEXT.md). Primary-source investigations are under [docs/research](./docs/research).

Resolved product contracts and their architectural rationale are under [docs/specification](./docs/specification) and [docs/adr](./docs/adr), including the [Coordinator interaction contract](./docs/specification/coordinator-interaction-contract.md), the [Work Item lifecycle contract](./docs/specification/work-item-lifecycle-contract.md), and the [task canvas decision](./docs/adr/0003-one-task-one-card-one-provider-thread.md).

## Scope

The MVP focuses on development projects and agent sessions. Canvas organization, broader personal/company integrations, multi-user operation, and production implementation remain future work.
