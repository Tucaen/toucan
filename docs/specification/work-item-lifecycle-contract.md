# Work Item lifecycle contract

This document defines the canonical Work Item state machine, transition authority, Writer Lease protocol, stopping behavior, and ambiguous-execution reconciliation for ADE. It refines the [Coordinator interaction contract](./coordinator-interaction-contract.md). The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Core invariants

1. Work Item State describes progress toward the objective, not Agent Session process state or liveness.
2. Each Work Item has exactly one canonical lifecycle state. Attention, archival, leases, and evidence validity are related records, not competing lifecycle flags.
3. Only the deterministic Coordinator control plane commits state transitions and Writer Lease changes. Owners issue controls and decisions; Agent Sessions report facts, evidence, and requested stopping conditions.
4. Current state and its append-only Activity Event commit atomically. A transition MUST be versioned and idempotent.
5. A Work Item may contain parallel Agent Sessions, but each mutable execution resource has at most one current writer.
6. Coordinator supervision is always reconstructible from durable ADE state. Restrictions on handoff apply to Agent Session execution authority, not to Coordinator continuity.
7. Ambiguous execution enters `reconciling`. Silence, lease expiry, or a worker claim MUST NOT be translated into completion, failure, idleness, rollback, or replay safety.
8. `completed` requires Verified Completion. A confident worker report is never sufficient by itself.

## Canonical states

The canonical state is one of:

| State | Class | Meaning |
| --- | --- | --- |
| `ready` | Ongoing | The Delegation Brief is valid, current prerequisites are satisfied, and the Work Item is eligible for dispatch. No execution resource is leased yet. |
| `active` | Ongoing | At least one required execution branch holds its required Writer Leases and can make progress. |
| `waiting` | Ongoing | No required branch can currently advance, but every impediment has a recorded Wake Condition such as an owner answer, approval, dependency result, or verified provider reset. |
| `paused` | Ongoing | Progress would otherwise be possible, but an owner decision or applicable policy intentionally suspended it. |
| `blocked` | Ongoing | No safe path remains under the current objective, scope, authority, dependencies, and known conditions. A material change is required before continuation. |
| `reconciling` | Ongoing | Execution ownership, effects, or outcome are ambiguous and ADE is establishing the next safe action from evidence. |
| `review_candidate` | Ongoing stopping point | Work reached a reasoned stopping point without sufficient evidence for Verified Completion and requires owner judgment. |
| `completed` | Stopped outcome | Every mandatory acceptance criterion has durable, attributable verification evidence. |
| `failed` | Stopped outcome | An Execution Epoch safely and definitively stopped without satisfying the objective, and no authorized automatic path remains. |
| `cancelled` | Stopped outcome | Cancellation finished: writers were stopped or fenced, observable effects were recorded, and any remaining uncertainty was explicitly preserved. |

Agent Session liveness and state MUST be stored separately. A crashed, failed, waiting, or completed Agent Session does not directly impose the corresponding Work Item State.

## Related conditions

### Needs Attention

`needs_attention` is derived when one or more unresolved Attention Events exist. It is not a Work Item State and does not require independent execution branches to stop.

ADE MUST create an Attention Event for:

- an owner question, decision, or exact Action Intent awaiting approval;
- a Review Candidate;
- a blocking condition only the owner can resolve;
- Reconciliation that cannot determine a safe next action;
- a budget or policy pause requiring owner choice; and
- a stopped result that requires owner awareness and has not been acknowledged.

An automatic wait, including a healthy dependency wait or a queued provider-reset probe, MUST NOT derive `needs_attention` unless it fails or requires an owner decision. Resolving or acknowledging the exact cause resolves its Attention Event; merely viewing unrelated activity does not.

### Archival

Archival changes visibility and retention, not lifecycle outcome. Only `completed`, `failed`, and `cancelled` Work Items may be archived. An ongoing Work Item MUST first reach a stopped outcome, including required Reconciliation.

Unarchiving restores visibility without reopening execution. Retention duration, export, and permanent deletion are separate persistence-policy concerns.

### Completion invalidation

If later evidence invalidates a completed result, ADE MUST preserve the historical `completed` state, attach a Completion Invalidation and Attention Event, and offer a linked corrective Work Item. It MUST NOT silently reopen the completed Work Item or rewrite the evidence history.

## Creation and Execution Epochs

Incomplete clarification remains a Coordinator Request rather than creating a premature Work Item. ADE creates a Work Item when work is accepted for durable tracking and either:

- sets it to `ready` when its Delegation Brief is valid and dispatchable; or
- sets it to `waiting` when accepted durable work has a known unmet prerequisite and a Wake Condition.

The first transition to `active` begins the first Execution Epoch. Explicitly retrying `failed` or `cancelled` work creates a new Execution Epoch, records a current Delegation Brief, and enters `ready`. Earlier epochs and stopped outcomes remain immutable history.

Additional work after `completed` creates a linked successor Work Item. A completed Work Item has no outgoing lifecycle transition.

## Transition authority

| Actor | May do | Must not do |
| --- | --- | --- |
| Owner | Pause, resume, cancel, retry, archive, unarchive, revise a Delegation Brief, resolve Attention Events, approve or deny exact Action Intents, and provide judgment for subjective criteria. | Directly write lifecycle state; declare ambiguous work completed or failed; transfer approvals to a replacement session. |
| Agent Session | Report start, checkpoints, observations, evidence, questions, blocked or waiting causes, errors, stopping conditions, and proposed results. | Commit Work Item State; grant or renew its own leases; treat its report as verification; approve owner decisions. |
| Coordinator Turn | Explain, classify, reconcile evidence when judgment is required, and propose a control operation. | Directly mutate Project state, approve for the owner, or bypass deterministic transition validation. |
| Coordinator control plane | Validate and atomically commit lifecycle transitions, Activity Events, Execution Epoch changes, Wake Conditions, and Writer Lease operations. | Infer an unsupported transition from model confidence, silence, or stale state. |

The control plane MAY commit an automatic transition only when its prerequisites are deterministically established from authoritative records and evidence. Otherwise it MUST preserve the current state and create the applicable Attention Event.

## Transition rules

All continuation normalizes through `ready`. Before moving any suspended or stopped Work Item to `ready`, ADE MUST validate the current Delegation Brief, authority, dependencies, budget, and resource availability.

Only `ready` may enter `active`. Granting all required Writer Leases and committing `active` MUST act as one logical operation; a partial acquisition MUST NOT leave writable authority behind.

The allowed lifecycle transitions are:

| From | To | Required cause |
| --- | --- | --- |
| Creation | `ready` | Accepted durable work has a valid, dispatchable Delegation Brief. |
| Creation | `waiting` | Accepted durable work has a recorded unmet prerequisite and Wake Condition. |
| `ready` | `active` | Dispatch succeeds and all required Writer Leases are granted. |
| `ready` | `waiting` | A known prerequisite becomes unmet before dispatch. |
| `ready` | `paused` | An owner or applicable policy suspends dispatch. |
| `ready` | `cancelled` | Cancellation is accepted before any writer or ambiguous effect exists. |
| `waiting` | `ready` | Every applicable Wake Condition is authoritatively satisfied. |
| `waiting` | `paused` | An owner or applicable policy intentionally suspends the queued continuation. |
| `waiting` | `blocked` | Its prerequisite becomes unsatisfiable under the current brief and no safe automatic path remains. |
| `waiting` | `cancelled` | Cancellation is accepted and no writer or ambiguous effect exists. |
| `paused` | `ready` | Resume is accepted and current validation succeeds. |
| `paused` | `cancelled` | Cancellation is accepted and no writer or ambiguous effect exists. |
| `blocked` | `ready` | A recorded decision, dependency change, authority change, or revised brief establishes a safe path. |
| `blocked` | `review_candidate` | A reasoned partial result is available for owner judgment. |
| `blocked` | `failed` | The epoch is safely stopped and definitively unsuccessful. |
| `blocked` | `cancelled` | The owner cancels and no execution ambiguity remains. |
| `active` | `waiting` | Every required branch reaches a Safe Boundary, releases leases, and has a Wake Condition. |
| `active` | `paused` | Every required branch reaches a Safe Boundary, checkpoints, and releases leases after a pause request. |
| `active` | `blocked` | All branches safely stop and no safe path remains under the current brief. |
| `active` | `reconciling` | Execution ownership, effects, liveness, or outcome become ambiguous. |
| `active` | `review_candidate` | All writers safely stop and return a reasoned result without sufficient verification. |
| `active` | `failed` | All writers safely stop and the epoch is definitively unsuccessful. |
| `active` | `cancelled` | Cancellation completes with no ambiguous execution or effects. |
| `reconciling` | `ready` | Prior writers are fenced, effects are classified, and continuation is safe. |
| `reconciling` | `review_candidate` | A reasoned result exists but verification remains insufficient. |
| `reconciling` | `failed` | The epoch is safely established as definitively unsuccessful. |
| `reconciling` | `cancelled` | Cancellation completes with observed and still-unknown effects recorded. |
| `review_candidate` | `ready` | The owner requests more work or revises the brief. |
| `review_candidate` | `failed` | The owner ends the safely stopped epoch as unsuccessful. |
| `review_candidate` | `cancelled` | The owner cancels further pursuit of the objective. |
| `failed` | `ready` | The owner explicitly retries with a new Execution Epoch and current Delegation Brief. |
| `cancelled` | `ready` | The owner explicitly retries with a new Execution Epoch and current Delegation Brief. |

Any ongoing state MAY transition to `completed` when every mandatory criterion has Verified Completion and no execution ambiguity remains. A transition not permitted by this contract MUST be rejected and recorded as such; it MUST NOT be approximated with a nearby state.

## Parallel execution and dependencies

A Work Item MAY contain multiple Agent Sessions only under the fan-out rules in the Coordinator interaction contract. Each independent branch MUST have an isolated worktree and its own scoped brief.

Work Item State aggregates required branches:

- it is `active` while any required branch can safely make progress;
- it becomes `waiting`, `paused`, `blocked`, or `reconciling` only when no required branch can safely advance under the applicable condition; and
- it may complete only after every required contribution is integrated and the aggregate acceptance criteria are verified.

A dependent Agent Session MUST have an explicit Dependency Edge. By default it waits for the prerequisite's verified result. It MAY start from an earlier checkpoint only when its Delegation Brief names an immutable, durable checkpoint contract and the produced checkpoint satisfies it.

Integration into a shared target is a distinct mutable execution resource with one Writer Lease. A live working tree or uncommitted filesystem state MUST NOT be treated as a dependency artifact shared between sessions.

## Safe Boundaries and control delivery

A Safe Boundary exists only when:

1. no provider turn, tool call, or Action Intent is in flight for the affected branch;
2. observable effects and the latest checkpoint are durable;
3. session, process, and resource ownership observations are current enough for the adapter's declared capability; and
4. no unresolved ambiguity affects the proposed next action.

An owner pause or compatible steering request does not retroactively alter an in-flight action. ADE delivers it at the next Safe Boundary. If the session cannot reach a known Safe Boundary or interruption may have produced effects, the affected Work Item enters `reconciling`.

When a Work Item enters `waiting`, `paused`, `blocked`, or `review_candidate`, its sessions MUST checkpoint at a Safe Boundary and release Writer Leases. Entering `reconciling` fences existing tokens and prevents replacement grants until Reconciliation permits them.

The Coordinator remains available throughout this process. A new Coordinator Turn may reconstruct and supervise the same durable state even while an Agent Session is in flight or being reconciled. An in-flight model invocation itself is never silently migrated or replayed.

## Writer Leases

Writer Leases protect adapter-fenceable mutable execution resources, including:

- a provider session or transcript that accepts new turns;
- a mutable worktree;
- a shared integration worktree or target; and
- another execution resource for which an adapter can reliably reject stale writers.

External systems that ADE cannot fence remain governed by exact Action Intents, idempotency controls, and reconciliation evidence rather than pretend leases.

Each logical lease record MUST identify at least the resource, Work Item, Execution Epoch, Agent Session, monotonically increasing fencing token, issue time, expiry time, and current lease disposition. Lease timing is adapter- and resource-specific, configurable, and owner-inspectable; this contract does not set one universal duration.

Only the Coordinator control plane may:

- grant a lease when the resource is unowned or prior ownership was safely reconciled;
- renew it from authoritative adapter or process evidence for the intended session and epoch;
- release it at a Safe Boundary;
- revoke and advance its fencing token; or
- classify expiry and begin Reconciliation.

Model output and silence are not liveness evidence. Expiry immediately invalidates the old token but does not prove the old process stopped, that effects are known, or that replay is safe. ADE MUST fence or stop the previous execution and reconcile it before granting a replacement writer.

An Agent Session MAY hold multiple Writer Leases. Acquisition MUST be deterministic and all-or-nothing for the resources required by its next execution step so competing sessions cannot deadlock while holding partial authority.

## Budget and policy stopping

ADE MUST enforce a budget boundary before starting an action expected to cross it. At the next Safe Boundary, the affected branch checkpoints and releases leases.

- If no required branch can continue, the Work Item becomes `paused`.
- If the owner explicitly queues continuation after a verified provider reset, ADE records a Wake Condition and uses `waiting`.
- A reported reset time is only a probe time; only authoritative recovery satisfies the Wake Condition.
- If another required branch can continue within its authority and budget, the aggregate Work Item remains `active`.
- If a provider cutoff occurs during possible execution, the Work Item enters `reconciling`, not `paused`.

Policy denial is not retried through another agent, provider, or tool. ADE records the denial and uses `blocked`, `review_candidate`, `failed`, or `cancelled` according to the safely established outcome.

## Verified Completion and Review Candidates

Each mandatory acceptance criterion MUST link to durable, attributable evidence and a verifier outcome. Worker-reported, ADE-observed, and evidence-verified claims remain distinguishable.

Owner judgment MAY verify an inherently subjective criterion. An objective criterion that failed or lacks its required evidence cannot be silently accepted. The owner MAY explicitly revise or waive it, but ADE MUST first preserve that decision and update the Delegation Brief or acceptance criteria before evaluating completion.

A Review Candidate gives the owner four valid paths:

1. provide valid subjective verification and complete;
2. explicitly revise or waive criteria, preserve the decision, and then re-evaluate completion;
3. request more work and return through `ready`; or
4. end the epoch as `failed` or `cancelled`.

## Cancellation

Cancellation means stop and reconcile, not rollback. ADE MUST:

1. record `cancellation_requested` as a control fact without pretending the lifecycle is already `cancelled`;
2. prevent new dispatch and lease renewal for affected work;
3. interrupt sessions and fence writers at the next available safe mechanism;
4. enter `reconciling` whenever execution or effects may be ambiguous;
5. record observed effects, still-unknown effects, artifacts, and verification state; and
6. commit `cancelled` only when no writer retains authority and the reconciliation record is durable.

ADE MUST NOT automatically undo effects. Rollback, cleanup, or remediation is a separate owner-visible operation with its own authority and evidence.

## Reconciliation

Reconciliation begins after events such as a lost stream following possible execution, unknown Agent Session liveness, lease expiry, forced interruption, adapter failure, conflicting ownership, or a provider cutoff during a turn.

ADE MUST:

1. fence affected lease tokens and stop new dispatch against the resources;
2. reacquire authoritative adapter, process, and session state;
3. inspect relevant worktree status, commits, diffs, artifacts, tests, Action Intent receipts, and external outcome receipts;
4. classify each claim as worker-reported, ADE-observed, evidence-verified, or still unknown;
5. determine whether the previous writer is stopped or reliably fenced; and
6. atomically persist the reconciliation result, current-state transition, and Activity Event.

Permitted outcomes are:

| Established result | Transition |
| --- | --- |
| No relevant effects; old writer fenced | `ready` |
| A safe checkpoint supports authorized continuation | `ready`, followed by fresh dispatch to `active` |
| All acceptance criteria verified | `completed` |
| Reasoned result but insufficient verification | `review_candidate` |
| Safely established definitive failure | `failed` |
| Cancellation complete with observed and unknown effects recorded | `cancelled` |
| No safe classification or next action | Remain `reconciling` and create an Attention Event |

ADE MUST NOT blindly replay a non-idempotent operation, infer rollback from missing evidence, translate `unknown` into `failed`, or grant a replacement lease while stale execution can still write.

## Atomic state and race handling

Every mutable Work Item record MUST carry a current version and, once execution has begun, its current Execution Epoch identifier. Every command, transition proposal, lease operation, and worker report MUST identify the Work Item, expected version or causal event, applicable epoch when one exists, actor, and idempotency key.

The first valid operation commits the new materialized state and append-only Activity Event atomically. A duplicate idempotency key returns the prior logical result. A stale command or late report is retained as attributable evidence but MUST NOT overwrite current state or resurrect an older epoch.

When desktop and phone, two workers, or a late adapter event conflict, the first valid recorded decision wins. Other callers receive the current version and may explicitly propose a new operation. If materialized state and its event history cannot be reconciled, ADE fails closed and enters recovery rather than guessing.

## Acceptance scenarios

The lifecycle contract is satisfied when at least these scenarios pass:

1. A valid Work Item begins `ready`, acquires leases, and becomes `active` in one logical dispatch operation.
2. A worker process dies while its outcome is unknown; the Work Item becomes `reconciling`, not `failed` or `ready`.
3. An expired Writer Lease rejects the stale token, but a replacement is not granted until prior execution is fenced and reconciled.
4. Two approved parallel workers mutate separate worktrees concurrently without sharing a Writer Lease.
5. Two workers cannot hold current leases for the same provider session, worktree, or integration target.
6. A dependent worker waits for a verified result unless its brief explicitly accepts a named durable checkpoint.
7. A pause request takes effect at a Safe Boundary, checkpoints work, releases leases, and results in `paused` only when no other required branch can progress.
8. An explicit provider reset queue uses `waiting` and does not wake from a reported timestamp alone.
9. A provider cutoff after possible execution enters `reconciling` and does not replay the action.
10. A worker's success claim without sufficient evidence produces a Review Candidate rather than `completed`.
11. Owner judgment completes a subjective criterion, while an objective failure requires an explicit preserved revision or waiver.
12. Cancellation with uncertain effects records those effects and reconciles before becoming `cancelled`; cleanup is not automatic.
13. Retrying `failed` or `cancelled` work creates a new Execution Epoch and fresh leases without deleting prior history.
14. A stale worker report after retry remains visible evidence but cannot mutate the new epoch.
15. Archiving preserves the stopped outcome, and unarchiving does not resume execution.
16. Later-invalidated completion evidence preserves historical completion and produces an Attention Event plus an optional corrective successor.

## Deferred configuration

This contract intentionally leaves adapter-specific lease durations, renewal cadence, liveness probes, retry counts, Attention Event severity, retention periods, and persistence schema to their owning implementation contracts. Those details MUST preserve the invariants and observable behavior defined here.
