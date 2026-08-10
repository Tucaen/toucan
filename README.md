# ADE

ADE is a Windows-first, local-first Agentic Developer Environment: one secure Coordinator for directing development work across bounded Claude, Codex, and terminal-backed agent sessions from desktop or phone.

The project is currently in Wayfinder planning, with one deliberately thin runnable experiment: the prototype-led multi-agent vertical slice from issue #19. It is not a production implementation.

## Runnable vertical slice

The slice proves one local Project, a real model-backed Coordinator, concurrent bounded Agent Sessions, live runtime state, shared clarification handling, and an inspectable append-only event record. It uses the official Codex SDK with ChatGPT subscription authentication; it does not require an API key or separately billed API tokens.

See [the vertical-slice demo guide](./docs/vertical-slice-demo.md) for the start command, fixture scenario, safety boundary, and verification steps.

## Current direction

- A short-lived Coordinator experience backed by durable Work Items, not one ever-growing model conversation
- Claude as the preferred Coordinator provider, with Codex failover at safe turn boundaries
- Rich Claude and Codex integrations plus a generic terminal adapter for other CLI agents
- A Git-backed Personal Vault for curated knowledge and a separate Session Registry for runtime state
- Native Windows control plane with optional per-project WSL execution environments
- Private phone access through an owner-restricted tailnet, passkey authentication, scoped approvals, and no public or SSH exposure in the MVP
- Worktree isolation, explicit verification evidence, honest uncertain-completion states, and external budget governance

The canonical language is maintained in [CONTEXT.md](./CONTEXT.md). Primary-source investigations are under [docs/research](./docs/research).

Resolved product contracts and their architectural rationale are under [docs/specification](./docs/specification) and [docs/adr](./docs/adr), including the [Coordinator interaction contract](./docs/specification/coordinator-interaction-contract.md) and [Work Item lifecycle contract](./docs/specification/work-item-lifecycle-contract.md).

## Scope

The MVP focuses on development projects and agent sessions. Canvas organization, broader personal/company integrations, multi-user operation, and production implementation remain future work.
