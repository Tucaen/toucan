# FirstMate research notes for ADE

Research date: 2026-08-09. Sources are limited to the FirstMate repository's own code and documentation.

## Executive summary

FirstMate is best understood as an **agent distribution**, not a desktop application or a single long-lived model session. A cloned directory supplies an operating prompt (`AGENTS.md`), skills, shell tooling, policies, and on-disk state conventions. The human talks to one coordinating agent, which delegates bounded “ship” or “scout” tasks to isolated agent sessions and later reconciles their results. [README — What it is](https://github.com/kunchenguid/firstmate#what-it-is)

This is directly relevant to ADE: the useful persistence is **outside model context**. FirstMate stores backlog, briefs, reports, preferences, lifecycle events, and endpoint metadata on disk, while worker sessions remain replaceable. A new coordinator session can reconstruct a bounded fleet view after a restart. ADE should therefore implement a persistent control plane with disposable/resumable agent sessions, not one immortal assistant conversation. [Configuration — operational home](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md#operational-home-layout-and-state), [Architecture — fleet snapshot](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#event-driven-supervision)

## Product mental model

- The user has one liaison (“first mate”), but execution is performed by a crew of autonomous agents in visible session endpoints. The liaison routes, supervises, asks only for decisions, and returns PRs, local merges, or investigation reports. [README — Features](https://github.com/kunchenguid/firstmate#features)
- FirstMate explicitly rejects being classified as a model, harness, skill, MCP server, CLI, or installed app. Its unit of deployment is a portable policy-and-tooling directory that specializes a supported terminal agent. [README — What it is](https://github.com/kunchenguid/firstmate#what-it-is)
- Work has two explicit shapes: **ship** tasks change a project through a configured delivery mode; **scout** tasks produce a standalone report and never push. [Architecture — Two task shapes](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#two-task-shapes)
- Authority is deliberately asymmetric: the coordinator is normally read-only over project clones; workers make project changes in isolated worktrees, and merging or discarding requires explicit authority. [AGENTS.md — Identity and prime directives](https://github.com/kunchenguid/firstmate/blob/main/AGENTS.md#1-identity-and-prime-directives)

## Session, context, orchestration, and persistence

```text
human -> coordinator session -> task brief -> isolated worker session + worktree
              ^                                      |
              |---- durable status/report/decision --|
```

- Each ordinary worker gets its own tmux window or another backend-specific endpoint and a clean Git worktree. Parallel sessions do not share a working checkout. [README — How it works](https://github.com/kunchenguid/firstmate#how-it-works), [Architecture — Worktrees](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#worktrees-not-branches-in-your-checkout)
- Optional **secondmates** are persistent, scoped coordinators, but still ordinary direct reports. Each owns an isolated `FM_HOME`, backlog, project clones, state, and session lock. They are idle by default and do not self-initiate audits. [Architecture — Optional secondmates](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#optional-secondmates)
- The operational home separates concerns: `data/` contains durable private records; `state/` contains volatile runtime and append-only lifecycle records; `config/` contains local choices; `projects/` contains clones. Shared instructions/tooling remain in the tracked code root. [Configuration — operational home](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md#operational-home-layout-and-state)
- Status logs are append-only events, not authoritative current-state fields. Current state is reconciled from structured evidence, unresolved decisions are explicitly keyed and closed, and unreadable state remains `unknown` rather than being guessed as idle or working. [Architecture — Event-driven supervision](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#event-driven-supervision), [Architecture — Busy state](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#busy-state-is-semantic-per-adapter)
- Supervision is event-driven: a Bash watcher sleeps without consuming model tokens, durably queues actionable wakes, and wakes the coordinator only when attention is required. A structured JSON fleet snapshot feeds human and bounded-summary views. [Architecture — Event-driven supervision](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#event-driven-supervision)
- Restart tolerance comes from disk and backend state, not unlimited conversational memory. The repository describes killing the coordinator session and reconciling on the next launch; `/stow` captures durable knowledge and unfinished work before context is reset. [README — Features and built-in skills](https://github.com/kunchenguid/firstmate#built-in-skills)
- Runtime backends sit behind a session-provider abstraction for endpoint creation, bounded capture, sending, liveness, and teardown. tmux is the verified reference; Herdr, Zellij, Orca, and cmux are experimental. [Architecture — Runtime session backends](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#runtime-session-backends)

## Integrations and technology stack

- The core implementation and tests are plain **Bash**; the repository is identified by GitHub as predominantly Shell. TypeScript appears in Pi extensions, but this is not a web application stack. [CONTRIBUTING — Repo conventions](https://github.com/kunchenguid/firstmate/blob/main/CONTRIBUTING.md#repo-conventions), [repository language listing](https://github.com/kunchenguid/firstmate)
- Supported agent harnesses include Claude Code, Grok, Pi/`pi-signed`, Codex, OpenCode, Kimi, and Muse in dispatch paths. Backend and harness capabilities differ, so adapters own lifecycle and supervision behavior. [README — Requirements](https://github.com/kunchenguid/firstmate#requirements), [Architecture — Dispatch profiles](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#dispatch-profiles)
- The universal toolchain includes Node, Git, authenticated `gh`, `jq`, and several companion tools (`no-mistakes`, `tasks-axi`, `treehouse`, and other `*-axi` tools); tmux is the default runtime dependency. [Configuration — Toolchain](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md#toolchain)
- GitHub PR workflows and local-only merges are first-class. Optional Relay connects public X and Discord mentions to the same task lifecycle, but is opt-in and stores pairing material locally. [README — Features](https://github.com/kunchenguid/firstmate#features), [Configuration — Relay](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md#relay-env)
- Codex Desktop is **not** a supported backend. FirstMate documents a missing supported, shell-callable bridge that can create, send to, read, and archive the same visible desktop thread over its lifetime. [Codex App backend boundary](https://github.com/kunchenguid/firstmate/blob/main/docs/codex-app-backend.md)

## Remote and mobile access

FirstMate's SSH capability is for placing a **whole secondmate home on another host**. The primary still routes and supervises; the remote host owns its projects, backlog, and workers. It deliberately does not place arbitrary individual workers remotely and never silently fails an unreachable remote route over to a local substitute. [Remote secondmates](https://github.com/kunchenguid/firstmate/blob/main/docs/remote-secondmates.md)

The transport is strongly constrained: public-key SSH, strict host-key checking, no agent forwarding, bounded dead-peer detection, encoded arguments to allowlisted FirstMate executables, and no general remote shell-command string. Remote writes are confined to guarded configuration/handoff/retirement paths. Transport failure is `unknown`; potentially completed operations are not automatically replayed. [Remote secondmates — prerequisites](https://github.com/kunchenguid/firstmate/blob/main/docs/remote-secondmates.md#prerequisites), [Remote secondmates — sync/update/retirement](https://github.com/kunchenguid/firstmate/blob/main/docs/remote-secondmates.md#sync-update-and-retirement)

The repository does **not document a phone client or a remote human-control UI**. SSH-reachable secondmates solve compute placement, not mobile interaction. For ADE, phone access should be a separate authenticated control surface over the same session API: list bounded sessions, read status/transcript tails, send a message, answer a keyed decision, and stop an exact endpoint. A raw shell may be an expert fallback through a private network and SSH/tmux, but it should not be the primary mobile contract. This recommendation is an inference from FirstMate's guarded remote entrypoint and its explicit backend lifecycle contract. [Remote entrypoint constraints](https://github.com/kunchenguid/firstmate/blob/main/docs/remote-secondmates.md#prerequisites), [Codex backend acceptance contract](https://github.com/kunchenguid/firstmate/blob/main/docs/codex-app-backend.md#acceptance-contract)

## Reusable ideas for a personal, local-first ADE

1. **Persist facts, not an endless chat.** Reconstruct a fresh coordinator view from task records, summaries, decisions, artifacts, and vault knowledge selected for the current request.
2. **Use bounded task sessions.** Give every task an immutable ID, scoped brief, project/worktree, lifecycle state, permission envelope, and terminal artifact. Destroy or archive the model session without losing the result.
3. **Separate durable and ephemeral state.** A practical ADE analogue is `vault/` or `knowledge/`, `tasks/`, `runtime/`, `config/`, and `projects/`; only the appropriate layers belong in Git.
4. **Make “unknown” a real state.** Never infer completion from a silent terminal or stale transcript. Prefer harness-native events and require explicit evidence before cleanup or delivery.
5. **Keep supervision outside the model.** File/system events, process liveness, GitHub checks, and timeouts should be handled by a cheap deterministic service; invoke an agent only for judgment.
6. **Separate data and control planes.** Sending agent-readable text is different from interrupting, stopping, or relaunching a process. Expose a small allowlisted control API instead of arbitrary key injection.
7. **Use explicit authority modes.** Encode read-only research, worktree changes, PR creation, local merge, remote actions, and destructive cleanup as distinct permissions with user approval at the irreversible boundary.
8. **Keep the UI replaceable.** First define a backend contract—create, send, observe, return status, stop/archive—then let desktop, terminal, and mobile clients consume it.

## Constraints and risks

- **A liaison can still accumulate bad context.** FirstMate mitigates restart loss with disk state, summaries, and `/stow`, but its primary interface is still one coordinator agent. ADE should go further: coordinator sessions should be short-lived projections over durable state, with retrieval budgets and explicit provenance.
- **Terminal scraping is brittle.** FirstMate prefers semantic harness events, yet Codex and some other adapters can remain `unknown`, and backend behavior requires empirical verification. ADE needs a first-class session protocol or adapter SDK rather than treating terminal pixels as truth. [Architecture — Busy state](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#busy-state-is-semantic-per-adapter)
- **The dependency surface is large and Unix-centric.** Bash, tmux, Git/GH, Node, `jq`, worktree tooling, harness CLIs, and per-backend hooks increase setup and portability cost. This matters especially for a Windows-hosted ADE. [Configuration — Toolchain](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md#toolchain)
- **Remote operation is operationally heavy.** Remote secondmates require host-local credentials and tooling; macOS additionally relies on a GUI login session and Herdr services, and genuine-host verification remains an operator smoke test. [Remote secondmates — readiness](https://github.com/kunchenguid/firstmate/blob/main/docs/remote-secondmates.md#readiness-repair-and-the-human-steps), [Remote secondmates — verification](https://github.com/kunchenguid/firstmate/blob/main/docs/remote-secondmates.md#verification)
- **There is no stable release channel.** GitHub currently shows no releases or tags, so consuming `main` means accepting an evolving contract. Borrow design patterns selectively or pin a reviewed commit rather than coupling ADE directly to the repository. [GitHub releases](https://github.com/kunchenguid/firstmate/releases), [GitHub tags](https://github.com/kunchenguid/firstmate/tags)
- **Scope creep is the main product risk.** FirstMate already spans orchestration, Git workflow, remote hosts, public social relay, multiple harnesses, and multiple terminal backends. ADE's MVP should focus on vault-backed project/session discovery, bounded agent sessions, durable status, and secure desktop/phone continuation before adopting fleet hierarchies or public integrations.

## License

FirstMate is MIT-licensed (copyright 2026 Kun Chen). ADE may reuse, modify, and redistribute its code or patterns provided the copyright and permission notice are retained in copies or substantial portions; the software is supplied without warranty. [LICENSE](https://github.com/kunchenguid/firstmate/blob/main/LICENSE)

