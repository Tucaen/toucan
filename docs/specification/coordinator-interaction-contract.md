# Coordinator interaction contract

This document defines the owner-facing contract for one central Coordinator experience assembled from bounded model invocations. The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Experience promise and boundary

ADE presents one continuous Coordinator identity across desktop and phone. Continuity comes from durable requests, decisions, Work Items, evidence, and curated knowledge—not from keeping one model conversation alive.

For every accepted owner request, ADE MUST:

1. assign a stable request ID;
2. record the client, linked Project if any, and linked Work Item if any;
3. classify the request before allowing project or external side effects;
4. expose meaningful progress as Activity Events rather than hidden model reasoning;
5. persist the answer, dispatch, control result, or stopping condition before acknowledging it; and
6. treat a retry with the same client idempotency key as the same logical request.

Every accepted interaction has a lightweight durable Coordinator Request. ADE creates a Work Item only when work is delegated, resumable, approval-bearing, explicitly tracked, or expected to outlive the current interaction. Casual questions MUST NOT clutter the Work Item list.

A Coordinator Turn MAY use bounded read-only retrieval over ADE state, the Personal Vault, registered Projects, and permitted external sources. It MUST NOT directly mutate a Project, execute project behavior, cause an external side effect, approve an Action Intent, or impersonate the owner. Those effects require either a deterministic ADE control operation or a bounded Agent Session under the normal policy boundary.

## Request classes and handling modes

Classification describes owner intent. Mode describes how ADE handles it. A follow-up can be reclassified when its intent changes.

| Request class | Examples | Default mode |
| --- | --- | --- |
| **Question** | Explain a concept, compare options, perform a bounded lookup | `answer` |
| **Work request** | Diagnose a failure, change code, run tests, perform substantial research | `delegate` |
| **Control request** | Pause, resume, steer, cancel, retry, or archive managed work | `control` |
| **Decision response** | Answer an open question or approve/deny an exact Action Intent | `control` |
| **Follow-up** | Clarify an answer or add a constraint to a Work Item | Inherit the linked request, then reclassify |

Every request resolves to exactly one initial mode:

- `answer`: a Coordinator Turn returns an answer from bounded, read-only context.
- `delegate`: ADE creates or updates a Work Item and dispatches an Agent Session.
- `control`: ADE validates and applies an operation to its own control plane. A Coordinator Turn is optional and MUST NOT be invoked when deterministic validation and feedback are sufficient.
- `clarify`: ADE asks the minimum questions needed before it can safely select another mode.
- `reject`: ADE explains that policy, capability, or declared scope prevents the request and offers a safe alternative when one exists.

The class and mode MUST be stored with the request. They MAY remain unobtrusive in the conversational interface.

## Project and follow-up targeting

A general question needs no Project. ADE MAY infer a Project when exactly one Project is unambiguous from the active conversation, linked Work Item, or explicit client selection. It MUST show the inferred Project in the dispatch or its expandable detail.

ADE MUST ask before dispatch when ambiguity could select the wrong Project, repository, objective, scope, authority, provider, model, or material cost. It MUST NOT guess merely because one Project was used recently.

A follow-up MAY target the one unambiguous active Work Item in the conversation. ADE MUST show that target. If several Work Items are plausible, ADE asks. It MUST NOT silently reopen or modify completed work.

## Direct answer versus delegation

The Coordinator SHOULD answer directly when all of the following are true:

- the result fits within one bounded Coordinator Turn;
- bounded read-only retrieval is sufficient;
- uncertainty can be stated honestly;
- no Project, provider session, external system, or owner artifact needs to change;
- no specialized execution or reproducible verification is required; and
- the request does not need durable background progress or recovery.

The Coordinator MUST delegate when any of the following is true:

- the request asks for a Project or artifact mutation;
- fulfilling it requires commands, project execution, or another side-effecting capability;
- it requires substantial multi-step investigation or specialized worker context;
- reliable completion requires tests, builds, reproduction, or other durable evidence;
- it can outlive the current interaction or needs independent progress reporting; or
- the owner explicitly asks for an Agent Session.

A small repository lookup can remain a direct answer. Tool count or elapsed time alone MUST NOT determine delegation; the boundary is durable execution, context, side effects, verification, and recovery.

An explicit instruction not to delegate is a constraint. ADE MUST provide the bounded answer it can, explain what it cannot establish, and offer delegation as an option rather than starting a worker anyway.

ADE MUST use `control`, not delegation, for supported operations on existing ADE records and managed sessions. A control request that creates a new Project-side effect becomes a work request.

## Clarification ownership

The Coordinator asks questions that determine Project, objective, scope, authority, provider, model, cost, or whether delegation is appropriate. These answers become small durable decisions; they do not require preserving an ever-growing Coordinator transcript.

An Agent Session asks implementation questions that emerge only after Project inspection. When a worker asks a question, ADE MUST either:

- relay it to the owner through the central conversation; or
- answer without interruption only when the answer is an exact match to an authoritative owner decision, registered Project fact, applicable policy, or other authoritative ADE record.

Model confidence alone is never sufficient for automatic answering. When ADE answers for the owner, the Activity Timeline MUST show the worker's complete question, the Coordinator's answer, the authoritative source, and the affected Work Item and Agent Session. A material answer SHOULD also appear in the main conversation.

## Coordinator Context Packet

Every Coordinator Turn receives a new Coordinator Context Packet. The packet is a bounded, provenance-bearing projection, not the provider's prior conversation history and not a dump of the Personal Vault.

ADE MUST assemble the packet in this order of authority:

1. authenticated owner request, client constraints, and explicit provider or model override;
2. linked Work Item objective, scope, owner decisions, unresolved questions, current status, and latest checkpoint;
3. active Project identity, instructions, and authority profile;
4. current Session Registry summaries, outstanding approvals, Attention Events, and relevant evidence;
5. selected Personal Vault and Project material with source, sensitivity, and freshness metadata;
6. bounded summaries of relevant prior owner interactions; and
7. current provider capability, quota, availability, and session-context observations.

Every included item MUST identify its source. Untrusted repository or provider content MUST remain distinguishable from owner instructions and ADE policy. Secrets MUST be omitted unless an authorized operation explicitly requires them.

When the packet exceeds its budget, ADE MUST preserve current owner instructions, safety constraints, accepted decisions, exact identifiers, and unresolved approvals. It SHOULD then prefer verified facts and recent checkpoints over narrative history, and summaries over raw transcripts. It MUST NOT silently drop a constraint or transform an unresolved question into a fact.

The packet manifest, selection reasons, truncation notices, and sources MUST be inspectable. The owner MUST be able to correct a fact and choose whether the correction applies only to the current request or is proposed as a durable Personal Vault update. Hidden model reasoning MUST NOT become durable state.

## Provider and model selection

Coordinator provider selection and worker provider selection are independent. A Coordinator Turn and the Agent Session it dispatches need not use the same provider or model.

For each new model invocation, ADE MUST apply this precedence:

1. an exact-model override applicable to the invocation;
2. a provider override applicable to the invocation;
3. the applicable Work Item preference;
4. the configured Project preference;
5. the configured global preference; and
6. an eligible available fallback.

An override can be scoped to a turn, Work Item, Project, or global preference. An informal override defaults to the current turn. For a work request, "use Codex" or "use Claude" applies to the worker unless the owner says otherwise; for a direct question it applies to the Coordinator Turn. ADE MUST show its interpretation when the instruction could reasonably target both.

A provider override permits ADE to select an eligible model from that provider. An exact-model override does not. Neither kind of explicit override may silently fall back to another provider or model.

Once started, an invocation is pinned. ADE MUST NOT interrupt an active turn or worker merely because another provider becomes preferable, and it MUST NOT replay an invocation while its outcome or side effects are ambiguous.

New Coordinator Turns and new Agent Sessions are independently budget-aware. Active Agent Sessions retain sticky provider ownership; replacement or handoff is explicit.

## Provider quota behavior

Provider-account quota is distinct from an individual session's context usage. ADE MUST preserve provider-specific observations and window names rather than flattening five-hour, weekly, or other limits into one invented token balance.

When a provider reports that a quota window is approaching its limit, ADE MUST warn the owner at the next safe boundary and ask before changing routing. The warning MUST show:

- the provider and limiting quota window;
- observed utilization or provider warning state;
- reported reset time when available;
- observation confidence; and
- which new Coordinator Turns or Agent Sessions a switch would affect.

The warning offers at least:

- switch the next eligible invocation;
- switch the linked Work Item until reset;
- keep the current provider; and
- dismiss the warning until utilization changes materially.

Near-quota status alone MUST NOT trigger an automatic switch. If a default-routed invocation cannot start because its provider is authoritatively exhausted, ADE MAY automatically use an eligible fallback at that safe boundary and MUST disclose the substitution.

If an explicitly selected provider or model is exhausted, ADE MUST NOT fall back automatically. It pauses the Work Item, makes clear that it will not run before capacity returns, and offers:

- queue for automatic start after ADE verifies the reset;
- switch provider or model; or
- leave paused.

Queuing after reset requires explicit owner choice. A reported reset timestamp is a probe time, not proof of restored capacity. After ADE verifies recovery, the configured provider becomes preferred again for new work; active work remains where it is.

If trustworthy quota telemetry is unavailable, ADE reports `unknown`. Local token use MAY be shown as a labeled approximation but MUST NOT drive confident switching. ADE MUST NOT send artificial requests solely to start or manipulate a provider quota window. It MAY give the owner a configurable reminder to begin real work.

Exact observation sources, warning thresholds, reset probes, and circuit-breaker rules belong to the provider budget and availability contract.

## Session-context quality warning

ADE treats context-window capacity and probable context-quality degradation as separate from provider-account quota. Long context can become less reliable before the provider's hard length limit, but there is no universal token count at which this begins.

For the MVP, ADE MUST provide a heuristic Context Risk Warning based on a versioned, configurable provider/model profile. The warning MUST:

- identify the provider, model, and observed context usage;
- say that quality **may** degrade rather than claiming it has;
- expose the heuristic and its provenance; and
- offer the owner the relevant native context controls when the adapter supports them.

Automatic session rollover is outside the MVP. ADE MUST NOT start a fresh session, compact, or switch providers merely because its Context Risk Warning fired. Provider-native automatic compaction may still occur and MUST be reported honestly when observable.

## Delegation contract

Before dispatch, ADE MUST create or update the Work Item and persist a Delegation Brief containing:

- the objective and observable acceptance criteria;
- the Project, workspace or worktree when known, and Execution Environment;
- included context and explicit exclusions;
- selected provider and model, including any owner override;
- authority profile and actions known to require confirmation;
- expected verification evidence;
- stop conditions and budget boundary; and
- circumstances that require owner attention.

When Project, scope, and authority are unambiguous, ADE starts one primary Agent Session without asking for dispatch confirmation. The conversational acknowledgment SHOULD be one concise line stating that an agent is starting, what it will do, and how the result will be checked. It mentions the Project, provider, model, or authority only when ambiguous, explicitly overridden, unusual, or changed because of availability. Full detail remains expandable.

ADE MUST NOT start more than one Agent Session for a request without owner confirmation unless the owner explicitly requested parallel agents. Before fan-out, ADE explains the decomposition, number of workers, isolation, and expected quota cost. One primary worker is the default.

An Agent Session receives only its Delegation Brief and purpose-built Context Packet. It does not inherit the Coordinator transcript, unrelated Work Items, or blanket authority. Dispatch means accepted work, not completed work.

## Supervision and Activity Timeline

Supervision MUST be event-driven and deterministic wherever judgment is not required. Process life, adapter events, quota observations, timeouts, artifacts, and test results MUST NOT require periodic model invocations merely to generate reassuring status text.

Each request and Work Item has one ordered, append-only stream of Activity Events. Desktop and Remote Clients render the same logical stream. Each event MUST contain:

- a stable event ID, request ID, timestamp, and actor;
- an event type and concise owner-readable summary;
- the resulting status when it changed;
- related Work Item, session, approval, artifact, evidence, question, answer, and source IDs as applicable; and
- a redaction marker when a client may not show full detail.

The main conversation SHOULD show dispatch, material milestones, changed plans, owner attention, recovery, verification, and results. Low-level tool and session events remain available in an expandable view. Exact timeline density is provisional until the Coordinator UI prototype validates it.

ADE MUST expose waiting, retrying, quota pressure, provider unavailability, unknown liveness, and reconciliation when they affect progress. It MUST NOT expose chain-of-thought, fabricate fine-grained activity, or infer progress from silence. Repeated low-value events SHOULD be coalesced without erasing state changes or audit references.

A manual status request SHOULD return current deterministic state without invoking a model. Completion of an unrelated Work Item updates its timeline and attention inbox; it interrupts the active conversation only when owner action is required or the event is urgent.

Phone and lock-screen notifications MUST reveal no more than the Project label and a generic condition such as "ADE needs your decision." Prompts, filenames, diffs, commands, and approval details require authenticated access.

## Results and verification language

Every Agent Session MUST return a structured result containing:

- actual outcome and stopping condition;
- changed or produced artifacts;
- verification attempted and evidence obtained;
- deviations, assumptions, and unresolved risks;
- pending decisions or approvals; and
- the next owner action, or explicitly that none is required.

ADE MUST distinguish what the worker reported, what ADE observed, and what evidence verified. A confident worker claim is not verified completion. Subjective or insufficiently verified work is presented for review under the verification contract's applicable state.

ADE MUST display a structured result without requiring another model invocation. A Coordinator Turn is used only when judgment is needed, such as reconciling conflicting evidence, interpreting verification, combining workers, or producing an owner-requested synthesis.

## Control, steering, and approvals

Control operations MUST target stable IDs, not whichever session happens to be visible. They remain available even when every model provider is unavailable.

A compatible steering constraint is delivered at the worker's next safe input boundary. A change to objective, Project, authority, provider, model, or already-completed work pauses dispatch or execution and requires a revised Delegation Brief. ADE MUST NOT imply that an in-flight tool call changed retroactively.

The Coordinator may explain or classify a pending Action Intent but MUST NOT approve it from inferred owner preference or prior behavior. Approval comes only from the owner or an already-applicable explicit policy, applies to the exact intent, and does not transfer to a replacement session or provider. Only the affected action pauses when unrelated safe work can continue.

Cancellation means stop and reconcile. ADE preserves observed effects, reports uncertain effects, and does not automatically undo changes. Rollback or cleanup is a separate operation.

Authorized work continues across desktop or phone disconnects within its existing authority and budget. Outstanding questions, approvals, warnings, and results remain durable. If two clients submit conflicting decisions, the first valid recorded decision wins; the other client receives the current state instead of silently overwriting it.

## Error and degraded behavior

Errors are part of the interaction contract, not exceptional UI text.

| Failure point | Required behavior |
| --- | --- |
| Request validation or context assembly | Do not dispatch. Identify the missing, conflicting, or unsafe input and preserve the request for correction. |
| Near provider quota | Warn and ask at a safe boundary; do not switch automatically. |
| Default provider exhausted before invocation | Use an eligible fallback, disclose it, and leave active work untouched. |
| Explicit provider or model exhausted | Pause, state that work cannot run until reset, and offer queue, switch, or remain paused. |
| Transient provider or adapter error | Apply bounded retry, show the retry, then stop with the classified error. |
| Stream lost before outcome is known | Mark the outcome unknown, reacquire state, inspect observable effects, and only then continue, replace, or ask. |
| Agent Session liveness unknown | Preserve ownership until reconciliation or lease policy resolves it; do not call it idle, complete, or safe to replay. |
| Policy denial | Do not retry through another tool, provider, or model. Explain the denied capability and safe alternatives. |
| Confirmation required | Pause only the affected action and surface the exact Action Intent. |
| Context conflict or stale evidence | Prefer the authoritative source, identify the conflict, and request owner judgment when it changes the outcome materially. |
| All model providers unavailable | Keep deterministic status, timeline, approval, cancellation, artifact, and queue operations available. |
| Client disconnect | Continue only already-authorized work and reconstruct the same state on reconnect. |

Every terminal error report MUST state what failed, whether effects may already have occurred, what ADE checked, what remains safe, and whether owner action is required. Raw provider diagnostics MAY be expandable, but the primary message uses ADE language and retains the provider classification.

ADE MUST NOT blindly replay non-idempotent operations, hide a fallback, translate `unknown` into `failed`, or translate `failed` into "nothing changed." If reconciliation cannot establish a safe next step, ADE stops and asks the owner.

## Logical response shape

All clients consume the same logical response, independent of rendering technology:

```text
CoordinatorResponse
  request_id
  class: question | work | control | decision | follow_up
  mode: answer | delegate | control | clarify | reject
  status
  message
  project_id?
  coordinator_provider_and_model?
  work_item_id?
  delegation_brief_id?
  worker_provider_and_model?
  quota_warning?
  context_risk_warning?
  attention_ids[]
  artifact_ids[]
  evidence_ids[]
  source_ids[]
  assumptions[]
  next_action?
  latest_event_id
```

`message` is the concise conversational rendering; linked records carry inspectable detail. Direct answers distinguish fact from inference. Delegated responses distinguish accepted work, observed progress, worker reports, and verified results.

## Acceptance scenarios

The MVP interaction contract is satisfied when these scenarios pass through desktop and phone clients:

1. A conceptual question receives one direct answer without creating a Work Item or Agent Session.
2. "Fix bug XY" with one unambiguous Project creates a Work Item, starts one worker immediately, and shows a concise acknowledgment plus expandable brief.
3. The same request with two plausible Projects asks before dispatch.
4. A worker's implementation question is answered from an exact Project fact; the timeline shows the complete question, answer, source, Work Item, and session.
5. A proposed two-worker fan-out waits for confirmation unless parallel work was explicitly requested.
6. A provider nearing its five-hour or weekly quota warns and asks before switching.
7. A default-routed invocation blocked by hard quota uses an eligible fallback and discloses it without moving active work.
8. An explicit exact-model request blocked by quota pauses and offers queue-after-verified-reset, switch, or remain paused.
9. A recovered preferred provider becomes eligible for new work without moving an active fallback-owned session.
10. A Context Risk Warning identifies its heuristic and token observation but causes no automatic rollover.
11. A worker result appears without a model-powered Coordinator synthesis and distinguishes reported, observed, and verified claims.
12. With both providers unavailable, the owner can still inspect, cancel, approve, view artifacts, and manage queued work.
13. A dropped stream after a possible tool effect enters reconciliation and does not duplicate the action.
14. Desktop and phone submit conflicting decisions; the first valid decision wins and both converge on the same timeline.
15. A phone reconnect reconstructs the same request, outstanding attention, and result without provider transcript continuity.
16. A lock-screen notification reveals only a generic condition; authenticated detail contains the exact action or question.
17. An explicit "do not delegate" request produces a bounded answer or an honest limitation, not a worker.
18. A morning reminder may invite real Claude work, but ADE sends no artificial model request to manipulate a quota window.

## Deliberately deferred details

The [Work Item lifecycle contract](./work-item-lifecycle-contract.md) defines Work Item states, transitions, Writer Leases, stopping behavior, and ambiguous-execution reconciliation. This interaction contract leaves these remaining details to their owning tickets:

- Personal Vault retrieval, promotion, sensitivity, and expiry;
- Session Adapter capability flags and provider telemetry mechanics;
- Action Intent classification and exact approval policy;
- verification evidence requirements and Attention Event severity;
- exact provider-quota thresholds, reset probing, and circuit breakers;
- model-specific Context Risk Warning profiles;
- timeline density, interaction layout, and notification usability validation;
- persistence schemas, retention, audit integrity, and migrations.

Later contracts may refine record shapes and thresholds, but MUST preserve the interaction invariants above.
