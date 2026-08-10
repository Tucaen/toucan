# Agentic Developer Environment

ADE is a personal, local-first environment for coordinating bounded AI development work from desktop and phone while keeping durable knowledge outside any model's conversational context.

## Language

**Coordinator**:
The stable control point that routes work, presents state, and applies policy across Agent Sessions without being one persistent all-purpose agent.
_Avoid_: Jarvis, central agent, master agent

**Agent Session**:
A bounded interaction with Codex or Claude that has a specific objective, project scope, context packet, and lifecycle.
_Avoid_: global chat, permanent assistant conversation

**Personal Vault**:
The human-reviewable, Git-backed store of durable project knowledge, preferences, goals, decisions, and verified results.
_Avoid_: global context, transcript store, session memory

**Session Registry**:
The local operational record of Agent Sessions, including their provider identity, status, workspace, permissions, and recovery pointers.
_Avoid_: vault, knowledge base

**Context Packet**:
A bounded, provenance-bearing selection of authoritative ADE, vault, and project material assembled for one Coordinator Turn or Agent Session.
_Avoid_: global prompt, full vault dump

**Remote Client**:
An authenticated phone or browser interface that reaches the Coordinator only through an owner-restricted private network.
_Avoid_: public web app, remote shell

**Action Intent**:
A normalized proposal for an Agent Session to use a capability against an exact target in an Execution Environment.
_Avoid_: raw approval prompt, opaque terminal command

**Policy Engine**:
The authority that classifies an Action Intent as allowed, requiring confirmation, or denied remotely before execution.
_Avoid_: prompt-only guardrail, command denylist

**Execution Broker**:
The controlled boundary that executes approved Action Intents and records their outcomes.
_Avoid_: unrestricted shell relay

**Session Adapter**:
A provider-specific bridge through which the Coordinator discovers, starts, observes, steers, resumes, and stops Agent Sessions, with explicit capability reporting.
_Avoid_: universal agent API

**Generic Terminal Adapter**:
The baseline Session Adapter for any command-line agent, limited to terminal input, output, process lifecycle, and capabilities that can be established reliably.
_Avoid_: terminal scraper pretending to know agent state

**Execution Environment**:
The isolated Windows-native or WSL location in which an Agent Session and its assigned worktree run.
_Avoid_: implicit host, shared checkout

**Project**:
An explicitly registered development scope that binds a repository, its curated vault knowledge, preferred Execution Environment, and authority profile.
_Avoid_: automatically discovered folder, arbitrary filesystem root

**Coordinator Turn**:
A short-lived model invocation assembled from current ADE state and a bounded Context Packet to answer, route, or supervise work.
_Avoid_: permanent coordinator conversation, global chat history

**Coordinator Request**:
One owner intent accepted through the Coordinator and durably classified for direct answer, delegation, control, clarification, or rejection; it becomes a Work Item only when durable work tracking is needed.
_Avoid_: prompt, chat message

**Coordinator Context Packet**:
The Context Packet assembled specifically for one Coordinator Turn from the current request and authoritative ADE state.
_Avoid_: conversation history, coordinator memory

**Delegation Brief**:
The durable contract that gives one Agent Session its objective, scope, authority, context, verification expectations, and stopping conditions.
_Avoid_: agent prompt, hand-wave, task message

**Activity Event**:
An ordered, owner-visible record of meaningful Coordinator or Work Item activity, including attributable questions, answers, and evidence, without hidden model reasoning or sensitive raw transcript content.
_Avoid_: chain of thought, terminal noise, heartbeat spam

**Work Item**:
The durable record of an objective, scope, sessions, decisions, approvals, evidence, status, and result that the Coordinator manages across provider turns.
_Avoid_: chat, transcript, agent session

**Work Item State**:
The single objective-level lifecycle condition of a Work Item. Ongoing states are Ready, Active, Waiting, Paused, Blocked, Reconciling, and Review Candidate; stopped outcomes are Completed, Failed, and Cancelled.
_Avoid_: Agent Session status, worker liveness, needs-attention flag

**Work Task**:
The owner-visible unit of delegated work on the task canvas: one objective, one owning Task Thread, and exactly one Task Card. Its card status reports provider-turn liveness, not Work Item State. In the current slice one Work Task stands in for a Work Item and its single Agent Session.
_Avoid_: subagent as a canvas object, one card per internal agent step

**Task Card**:
The single interactive canvas object for one Work Task: a compact status overview when collapsed, and that task's chat-like thread surface when opened.
_Avoid_: terminal tile per agent, dashboard row, duplicate card per provider step

**Task Thread**:
The persistent provider conversation one Work Task owns for its whole life, including follow-up turns and answered clarifications.
_Avoid_: fresh session per message, one shared global thread

**Task Transcript**:
The owner-visible message record inside one Task Card: the task's own questions and results plus the owner's follow-ups. Internal provider mechanics are counted and labelled activity, never presented as owner messages.
_Avoid_: raw terminal log, chain of thought, provider transcript dump

**Writer Lease**:
A time-bounded, renewable, fenced grant that gives one Agent Session exclusive write authority over one mutable execution resource, such as a provider session or worktree. Expiry revokes authority but does not prove that prior execution stopped or make replay safe.
_Avoid_: Work Item lock, ownership flag, mutex

**Execution Epoch**:
One auditable period of Work Item execution governed by a Delegation Brief. Explicitly reopening failed or cancelled work starts a new Execution Epoch rather than erasing the stopped outcome.
_Avoid_: retry counter, reused run

**Safe Boundary**:
A point at which no provider turn, tool call, or Action Intent is in flight, observable effects and the latest checkpoint are durable, and no unresolved execution ambiguity affects the next action. Coordinator supervision does not pause while an Agent Session waits to reach one.
_Avoid_: arbitrary timeout, token threshold, assumed idle

**Reconciliation**:
The evidence-driven recovery process that establishes execution ownership, observed effects, remaining uncertainty, and the next safe action after an interruption or ambiguous outcome. It never treats lease expiry, silence, or a worker claim as proof that execution stopped or that replay is safe.
_Avoid_: blind retry, assumed rollback, failure guess

**Wake Condition**:
A recorded, observable condition that permits a Waiting Work Item to become eligible for execution again, such as an owner decision, dependency result, or verified provider reset.
_Avoid_: polling guess, reported reset time

**Dependency Edge**:
An explicit ordering relationship requiring one Agent Session contribution to produce a named verified result or contracted durable checkpoint before another contribution may proceed.
_Avoid_: assumed ordering, shared live working tree

**Review Candidate**:
A Work Item that reached a reasoned stopping point without evidence sufficient for verified completion and now requires the owner's judgment.
_Avoid_: verified complete, abandoned work

**Verified Completion**:
A Work Item outcome in which every mandatory acceptance criterion is supported by durable, attributable evidence. Owner judgment may verify subjective criteria; changing or waiving an objective criterion requires an explicit preserved decision before completion.
_Avoid_: worker-reported success, assumed success, done

**Completion Invalidation**:
A durable warning that evidence supporting a completed Work Item no longer holds. It preserves the historical outcome, requires owner attention, and may link to a corrective successor Work Item without reopening the completed item.
_Avoid_: rewritten completion, silent reopen

**Attention Event**:
A state change that requires owner awareness or action and may produce an inbox badge or privacy-filtered notification according to its severity. Outstanding Attention Events derive the owner-facing needs-attention condition without replacing the Work Item State.
_Avoid_: routine progress update, full transcript notification

**Needs Attention**:
The derived owner-facing condition that one or more unresolved Attention Events exist for a Work Item. It is not a lifecycle state and does not imply that every independent execution branch must stop.
_Avoid_: Work Item state, unread activity
