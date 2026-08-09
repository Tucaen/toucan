# `jxnl/personal-monorepo-template` research

Research date: 2026-08-09. Sources are the repository's own files and GitHub metadata, inspected at commit [`df863768495aaf524a2bf9b5b25ef2622a2591a1`](https://github.com/jxnl/personal-monorepo-template/tree/df863768495aaf524a2bf9b5b25ef2622a2591a1). ADE recommendations below are analysis, not claims made by the upstream project.

## Executive summary

This is a **Codex-oriented, Git-backed knowledge-vault template**, not an application or agent runtime. Its strongest idea is to make important context explicit, reviewable, hierarchically routed, and independent of any one chat: root and project `AGENTS.md` files explain how to work, project `README.md` files carry status, `GOAL.md`/`RESULT.md` capture longer work, and `people/*.md` records collaboration context. Repo-local skills define onboarding, periodic check-ins, project/person scaffolding, and controlled promotion into durable memory. ([README](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/README.md), [root instructions](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/AGENTS.md))

ADE should adopt this **curated-memory contract and project-local routing**, but should not make one long-running chat the system's identity. A session coordinator can be stateless between requests: it selects a project, assembles a bounded context packet from the vault, starts or resumes an isolated AI session, and promotes only approved, durable outcomes back to the vault. Runtime/session state should live outside the Git vault.

## Information architecture

| Area | Upstream role | ADE reading |
|---|---|---|
| `projects/<project>/README.md` | Durable goal, status, run commands, sources of truth, next steps, and notes. | Canonical project packet and context-packet entry point. |
| `projects/<project>/AGENTS.md` | Project-local ownership, source order, commands, safety gates, and conventions; supplements root instructions. | Provider-neutral session policy for any coding agent launched in that project. |
| `experiments/exp-<topic>-<date>/` | Short-lived spike with explicit graduation/archive criteria. | Useful lifecycle distinct from long-lived projects. |
| `GOAL.md` / `RESULT.md` | Observable outcome, baseline, constraints, verifiers, approvals; then completion and verification evidence. | Good handoff/checkpoint envelope for bounded sessions. |
| `people/*.md` | Public-safe human or agent notes: role, preferences, boundaries, tools, handoffs, failure modes, verification date. | Keep, but private vaults need explicit sensitivity labels and access policy rather than only "public-safe" prose. |
| `.codex/skills/` | Markdown workflows plus optional scripts/references, loaded in place. | Treat as workflow definitions/adapters; do not couple ADE's core domain model to Codex skill semantics. |
| `archive/`, `outputs/`, `docs/` | Reserved destinations; outputs are ignored except `.gitkeep`. | Keep the separation, but define retention and whether artifacts are addressable by sessions. |

The project/experiment split and templates are explicit in the [project scaffolding skill](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/new-project/SKILL.md), [project template](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/templates/project_README.md), [project instruction template](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/templates/PROJECT_AGENTS.md), and [experiment template](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/templates/experiment_README.md). The [goal](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/templates/GOAL.md) and [result](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/templates/RESULT.md) templates make verification and approval gates first-class.

One inconsistency matters for reuse: the checked-in tree is the lightweight template above, while the onboarding vault reference describes an expanded shape with `TODO.md`, `agent/USER_CONTEXT.md`, `notes/`, and `sources/`. Those are created on demand by a Python setup script, not present initially. ([vault reference](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/onboarding/references/shared-memory-vault.md), [setup script](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/onboarding/scripts/setup_shared_memory_vault.py)) ADE should define one versioned vault schema and migrations rather than relying on prose plus conditional scaffolding.

## Agent instructions and memory model

The root `AGENTS.md` is a routing and behavior layer. Agents discover work from `projects/`, `experiments/`, and `README.md`; read the nearest nested instructions; use local rules when they conflict; and write important state to canonical files instead of leaving it in chat. It explicitly routes project status to `README.md`, long-running objectives to `GOAL.md`, completed/verified work to `RESULT.md`, and collaborator context to `people/*.md`. Writes to shared memory and external side effects require approval. ([root instructions](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/AGENTS.md))

The memory guidance separates two surfaces:

1. A compact assistant/chat profile containing stable user/work context, current priorities, important people/spaces, operating preferences, and recurring help.
2. An explicit plain-file vault for durable, reviewable context across chats.

It says to preserve meaning rather than activity, keep facts/self-report/inference distinct, avoid raw transcripts and source dumps, use roughly 90 days of recurring evidence when supported, and ask before persisting a consequential inference. ([memory guidance](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/assistant/references/memory-guidance.md))

For ADE, make the layers explicit and provider-neutral:

- **Session context:** bounded prompt/history owned by one agent session; disposable or resumable.
- **Session registry:** machine state such as provider, external session ID, working directory, process/PTY, status, timestamps, permissions, and checkpoint pointers; not Git memory.
- **Curated vault:** human-reviewable Markdown facts, decisions, goals, results, people, and project policies.
- **Evidence store:** optional retained source material with provenance, access rules, and retention; read-only by default.

This avoids the context-mess problem: there is no single ever-growing agent context. The coordinator retrieves and summarizes only what the current session needs.

## Workflows

- **Onboarding:** classify setup as brand-new, partial, or established; inspect reachable context before questioning; build and calibrate a work map; offer connectors, recurring checks, project/person monitor threads, writing-style learning, and vault writes behind approval gates. ([onboarding skill](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/onboarding/SKILL.md), [first-meeting flow](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/onboarding/references/first-meeting-flow.md))
- **Ongoing assistant:** one pinned hub chat, quiet recurring discovery, draft-before-send behavior, and notifications only for meaningful changes. ([assistant skill](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/assistant/SKILL.md), [check-in philosophy](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/assistant/references/heartbeat-philosophy.md))
- **Recurring work:** attach a heartbeat to the current Codex thread, infer cadence and stop condition, rename its lifecycle from `loop:` to `done:`, and update rather than duplicate automations. ([loop skill](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/loop/SKILL.md))
- **Scaffolding:** Python helpers create projects/experiments and person notes from templates. The scripts intentionally fail on an existing project path rather than merging. ([project script](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/new-project/scripts/new_project.py), [person skill](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/new-person/SKILL.md))
- **Style learning:** derive channel- and intent-specific writing postures from sent Slack/email, but save synthetic examples rather than raw private messages and ask before writing the generated skill. ([write-like-me skill](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/write-like-me-bootstrap/SKILL.md))

## Dependencies and assumptions

There is no application server, UI, database, search index, session protocol, authentication system, SSH support, or agent-provider abstraction in this repository. The executable helpers use Python's standard library. Integrity tests assume a `pytest` runner but no Python dependency manifest is provided. CI additionally assumes GitHub Actions, Bash, `rsync`, `zip`, and `gh`; it validates Markdown frontmatter and packages a release archive. ([tests](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/tests/test_skills.py), [packaging workflow](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.github/workflows/package.yml))

The behavioral workflows assume Codex-specific capabilities: repo-local skills, plugins/connectors, durable memory/profile surfaces, chat/thread operations, recurring automations, and explicit approval UX. The assistant plugin itself declares version `0.1.0`, `Interactive` and `Read` capabilities, and a `Proprietary` license. ([plugin manifest](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/plugins/assistant/plugin.json)) The recurring model also assumes Codex remains running and permits only one active heartbeat attached to a chat. ([check-in philosophy](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/assistant/references/heartbeat-philosophy.md)) ADE should model jobs, approvals, connectors, and session lifecycle in its own core and expose Codex as one adapter.

The template further assumes a single trusted user, one repository as the vault root, Git-friendly non-secret content, manual curation, and connectors as the source of current truth. Those assumptions fit the personal ADE MVP, but future company use will require tenant/workspace boundaries, policy inheritance, audit logs, secret storage, data classification, and role-based approvals.

## License status

GitHub reports the repository license as `null`, and the commit tree has no root `LICENSE`; therefore the repository as a whole does not grant a clear reuse license. The assistant plugin manifest independently says `"license": "Proprietary"`. Three bundled GitHub workflow skills contain their own Apache-2.0 `LICENSE.txt` files, but those scoped files do not license the rest of the repository. ([GitHub repository metadata](https://api.github.com/repos/jxnl/personal-monorepo-template), [commit tree](https://github.com/jxnl/personal-monorepo-template/tree/df863768495aaf524a2bf9b5b25ef2622a2591a1), [assistant manifest](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/plugins/assistant/plugin.json), [example scoped Apache license](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/gh-address-comments/LICENSE.txt))

Practical consequence: use the architecture as inspiration, but do not copy its unlicensed text, templates, scripts, branding, or assistant plugin into ADE without permission or a clarified upstream license. Reimplement the concepts in ADE's own words and code; track any separately licensed components individually.

## Adopt versus adapt for ADE

| Decision | Recommendation | Reason |
|---|---|---|
| Markdown vault with Git history | **Adopt** | Local-first, inspectable, diffable, recoverable, and usable without ADE. |
| Root + nearest project instructions | **Adopt** | Produces small context packets and lets each project own commands and safety gates. |
| Project/experiment distinction | **Adopt** | Prevents temporary investigations from becoming permanent project clutter. |
| Goal/result/verifier envelope | **Adopt** | Natural contract and handoff between isolated sessions. |
| Meaning-over-motion memory threshold | **Adopt** | Prevents the vault from becoming a transcript or session-log dump. |
| Explicit approval for persistence and side effects | **Adopt** | Essential trust boundary for a central assistant. |
| One pinned Assistant chat as hub | **Adapt** | Present one coordinator UI, but back it with short-lived coordinator turns and isolated provider sessions, not one accumulating model context. |
| Codex heartbeats/threads | **Adapt** | Implement provider-neutral jobs and monitor definitions; thread attachment is an adapter concern. |
| `.codex/skills` as the workflow model | **Adapt** | Support them through a Codex adapter while ADE owns a neutral workflow/capability contract. |
| People notes that are merely "public-safe" | **Adapt** | Personal/team ADE needs sensitivity, provenance, expiry, and sharing policy. |
| Runtime state in the vault | **Reject** | Session/process state is noisy, concurrent, and often sensitive; store it in a local state database with selective durable promotion. |
| Verbatim reuse of upstream content | **Reject for now** | No clear repository-wide license. |

## Integration seams with a session coordinator

1. **Project discovery:** index `projects/*/README.md` and the nearest `AGENTS.md`; expose project ID, roots, sources, commands, policy, and status as typed coordinator data.
2. **Context assembly:** compile a bounded session packet from root policy, project policy, the active goal, recent verified result, selected people notes, and explicit user instructions. Record exactly which sources and revisions were included.
3. **Provider adapters:** map the packet and project working directory into Codex, Claude Code, or other session launch/resume APIs. Store provider IDs and process/PTY details only in the session registry.
4. **Lifecycle events:** normalize `created`, `running`, `awaiting_user`, `blocked`, `completed`, `failed`, `stopped`, and `archived`. `GOAL.md` supplies completion criteria; `RESULT.md` receives verified outcomes after review.
5. **Memory promotion:** on checkpoint/completion, propose a small diff to the canonical project/person/root files. Require approval where policy demands it; never auto-save full transcripts.
6. **Jobs and monitoring:** translate the useful parts of `loop` and monitor threads into scheduler jobs that invoke fresh coordinator turns. A run should retrieve current context, do work, notify only on a meaningful delta, then end.
7. **Remote clients:** phone/SSH or a future web client should talk to the same coordinator API for session list, status, tail, input, pause/resume, and approval. Remote access should not alter the vault or memory model.

The key boundary is: **the vault explains the work; the session registry tracks running work; isolated agents perform the work; the coordinator routes between them.**
