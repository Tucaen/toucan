---
status: accepted
---

# Use objective-level Work Item state and resource-scoped Writer Leases

ADE models Work Item State as progress toward a durable objective rather than as a mirror of any Agent Session, while the deterministic Coordinator control plane alone commits versioned transitions from owner controls, worker reports, and verification evidence. Resource-scoped, fenced Writer Leases permit explicitly approved sessions to work concurrently in isolated worktrees without allowing two writers against the same provider session, worktree, or integration target; ambiguous ownership or effects enter Reconciliation instead of being guessed as failure, completion, or replay safety. This adds durable control-plane bookkeeping and explicit stopping states in exchange for honest recovery, safe provider handoff, auditable completion, and concurrency without a coarse Work Item lock.
