---
title: Architecture and code quality
created: 2026-08-30
updated: 2026-08-31
---

# Architecture and code quality

Because Toucan's production code is written by agents, the codebase should be optimized explicitly for agent comprehension and safe agent modification. That means making the right change easy to locate, keeping the relevant context small and local, exposing important behavior through deep modules, and turning architectural rules into fast mechanical feedback wherever possible.

## Current understanding

- Toucan is already substantially more agent-friendly than a typical application at this stage, but it is not yet in the ideal shape. The right description is **strong foundations with growing orchestration hotspots**.
- The strongest pattern is the extraction of behavior into small, pure, specifically named modules such as `attention.ts`, `session-usage.ts`, `composer-keys.ts`, `prompt-outbox.ts`, `worktree-removal.ts`, and `stall-guard.ts`. Their focused tests give an agent a narrow interface through which to understand and change behavior.
- Several stateful subsystems are deep modules with clear ownership and evidence-backed invariants: workspace persistence, worktree removal, terminal identity and scrollback, conversation history, and ACP prompt delivery. `AGENTS.md` records the non-obvious operational contracts and points to their authoritative implementation and tests.
- Strict TypeScript, separate Node and DOM test runners, descriptive test names, and tests colocated by module name make verification discoverable. The code also uses very little unsafe typing or suppression.
- The main weakness is concentration of unrelated responsibilities in a few orchestration files: `App.tsx` is about 1,700 lines, `ChatNode.tsx` about 1,600, `acp-session-manager.ts` about 1,000, and `use-agent-conversation.ts` about 670. These files require a large context window, expose broad interfaces, and make it harder for an agent to predict the full blast radius of a change.
- `ChatViewProps` is a particularly broad interface: it carries conversation state, composer state, attachments, approvals, authentication, selectors, queue actions, and persistence callbacks. This is evidence that several modules meet at one shallow interface rather than behind a few deeper ones.
- The renderer directory is mostly flat. File names are often good, but related state, presentation, and tests are discovered by convention rather than by a feature-level structure or machine-readable dependency rules.
- Architectural intent is protected mainly by tests and the committed agent memory. There is no lint command, dependency-cycle check, layer/import enforcement, or coverage threshold in the standard verification scripts. An agent can therefore introduce a structurally poor change while still passing typecheck and tests.
- Documentation is valuable but can drift: the README still describes a side worklog and lists worktrees as deliberately excluded, while the current code and agent memory say otherwise. Stale orientation is especially costly for agents because they treat repository documentation as evidence.

## Decisions

- Optimize for **local reasoning**, not for small files as an end in itself. A module is good for agents when one bounded set of files contains the behavior, invariants, interface, and focused verification needed for a change.
- Prefer deep modules: small interfaces that hide substantial behavior. Do not split large orchestration files into pass-through wrappers merely to reduce line counts.
- Treat documentation as part of the executable architecture. Durable, surprising invariants belong in `AGENTS.md`; ordinary behavior belongs in names, types, and tests; stale or duplicated claims should be removed.
- Prefer mechanical guardrails over instructions when a rule can be checked automatically. Agent-authored code benefits disproportionately from immediate, deterministic feedback.

## Priorities

1. Map the responsibilities and dependency clusters inside `App.tsx`, `ChatNode.tsx`, `acp-session-manager.ts`, and `use-agent-conversation.ts`. Identify seams where behavior already varies or where a pure state transition can replace coupled orchestration.
2. Deepen one hotspot at a time. The first candidates are the broad `ChatViewProps` interface and the workspace/application orchestration inside `App.tsx`; extract cohesive modules with their own focused interface and tests, leaving composition at the top.
3. Add a standard `check` or equivalent quality gate that runs formatting/linting, strict typechecking, tests, and architecture checks. Introduce import/layer rules only after the intended dependency direction is documented.
4. Add lightweight repository navigation: a current architecture map naming the main processes, feature modules, ownership, dependency direction, and verification command. Reconcile or remove stale README material.
5. Establish a repeatable agent-readiness review for new work: can an unfamiliar agent locate the owner, state the invariant, change behavior through one interface, run focused tests, and detect a forbidden dependency without reading the whole application?

## Measurable outcomes

- A feature change normally touches one cohesive module plus its tests, rather than editing multiple orchestration files.
- No new broad prop/controller interfaces are introduced without grouping behavior behind a deeper interface.
- The standard local gate detects type errors, lint/format issues, dependency violations, and relevant test failures.
- Every architectural invariant is either enforced mechanically or has one concise canonical explanation linked to authoritative code and tests.
- Repository orientation documents match current behavior and are checked during architecture-affecting changes.
- Hotspot size is tracked as a diagnostic rather than a target: large files are acceptable when cohesive, but responsibility count and interface breadth should decline in the current hotspots.

## Open questions

- Which hotspot offers the highest-leverage first deepening without colliding with imminent feature work?
- What dependency direction should be enforced between renderer feature logic, orchestration, shared domain logic, preload, and main-process adapters?
- Should feature code move into explicit feature directories, or would a smaller architecture index provide enough navigation without a disruptive reorganization?
- Which lint and architecture checks provide useful signal for this repository without encouraging agents to optimize for superficial metrics?

## Related topics

- [Mobile session access](mobile-session-access.md)
- [Invisible background processes](invisible-background-processes.md)
