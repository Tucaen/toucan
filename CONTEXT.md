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

**Review Candidate**:
A Work Item that reached a reasoned stopping point without evidence sufficient for verified completion and now requires the owner's judgment.
_Avoid_: verified complete, abandoned work

**Attention Event**:
A state change that requires owner awareness or action and may produce an inbox badge or privacy-filtered notification according to its severity.
_Avoid_: routine progress update, full transcript notification
