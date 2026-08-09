---
status: accepted
---

# Build one Coordinator experience from bounded turns and durable records

ADE presents one stable Coordinator, but each model invocation is a new bounded Coordinator Turn assembled from authoritative ADE records and a provenance-bearing Context Packet. Bounded read-only answers may remain direct; lasting or side-effecting Project work is delegated through a durable Work Item to an Agent Session, while deterministic control and supervision do not consume model turns. This trades transcript-native continuity for inspectable state, lower token waste, safe provider routing, and honest recovery when a model or client disappears.

## Consequences

- Provider transcripts are optional inputs, never the source of Coordinator identity or Work Item truth.
- Desktop and phone clients reconstruct the same experience from request records, Activity Events, Work Items, and Attention Events.
- Cross-provider continuity happens only at safe turn boundaries through ADE-owned checkpoints; in-flight turns are never silently migrated or replayed.
- The Coordinator cannot bypass delegation, policy, or approval boundaries to perform project work itself.
- One worker is the default; fan-out requires owner intent because extra agents spend scarce provider quota.
- Structured worker results and deterministic status reporting avoid model turns whose only purpose would be narration.
