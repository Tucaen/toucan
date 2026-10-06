# Toucan

**A Windows desktop workspace where Claude and Codex sessions remember what earlier sessions
tried, run side by side on one canvas, and can be answered from your phone.**

![Toucan demo: a new Claude session recalls what an earlier session tried, then a Codex session works in a worktree alongside it](docs/images/toucan-demo.gif)

_A new Claude session is asked what was already tried for quoted CSV fields and answers from
Toucan's session records. A Codex session then works in a worktree alongside it, all on one canvas._

## Why Toucan

- **Agents remember across sessions.** After every turn Toucan records what the conversation set
  out to do, which files it touched, how it ended and what failed, without spending any model
  tokens. Later Claude and Codex sessions check those records before starting, so they build on
  earlier work instead of redoing it. Ask "what did we try for X last week?" and get an answer.
- **Many agents, one canvas.** Terminals, Claude and Codex chats, and Git worktrees are nodes on
  a zoomable canvas. Run several agents in parallel, each in its own worktree, and keep every one
  of them in view. Every node type has a keyboard shortcut, and nodes snap and tile like windows.
- **Hand a large task to an orchestrator.** A **New orchestrator** node, Claude or Codex, splits
  one task into dependent tickets, routes each to a model tier, starts a ticket session per
  ticket in its own worktree, and merges the tested results in dependency order. Every ticket
  session is an ordinary node you can watch, steer or take over. It ends with a review list and
  a routing report that proposes tier-mapping changes once enough tickets have settled; Toucan
  never applies them itself.
- **Guard-rails on every agent.** Every Claude and Codex session, whether chat, orchestrator or
  ticket, runs behind a command guard that blocks dangerous shell commands before they execute:
  recursive deletes of a drive or home directory, disk formatting, piping a download into a
  shell, force pushes, `git clean -fdx`, dropping a database and more. The blocked command shows
  up as a failed tool call with the reason. Edit the pattern list or turn the guard off from the
  header's **Command guard** button, or switch it off for a single chat node.
- **Answer your agents from your phone.** A mobile companion shows which chats are working, which
  are waiting and which need an approval. Read transcripts live, answer approvals and questions,
  and start new chats, over your own tailnet. Whichever device answers first wins; the other
  client's card resolves.

See [all features](docs/features.md) for the full tour.

## Install

Download `Toucan-Setup-<version>-x64.exe` from the
[latest release](https://github.com/Tucaen/toucan/releases/latest) and run it. It installs per
user without admin rights and updates itself in the background; nothing is applied until you
click **Restart to update**.

The builds are not yet code-signed, so Windows SmartScreen shows "Windows protected your PC" on
first run: click **More info**, then **Run anyway**.

Claude and Codex use their existing subscription sign-in; Toucan bundles both agent adapters, so
you do not need Node or npm.

## Quick start

1. **Add project** in the sidebar and pick a folder.
2. Right-click the canvas, or use the keyboard: `Ctrl+N` Claude, `Ctrl+Shift+N` Codex, `Ctrl+T`
   terminal, `Ctrl+Shift+G` worktree, `Ctrl+H` conversation history, `Ctrl+P` file.
3. Arrange nodes with `Alt+Arrow` (snap to halves and quarters) and `Ctrl+Shift+A` (tile).
4. For the phone companion, follow the [mobile companion setup](docs/mobile-companion-setup.md).

## How it's built

Toucan is an Electron app with a privileged main process, a narrow context-isolated preload seam
and a React renderer; the [architecture map](docs/architecture.md) covers the details. A few
decisions worth calling out:

- **Session memory is plain Markdown, not a database.** Each conversation gets one small record,
  written atomically at every turn boundary from the transcript alone. Agents read the records
  with `grep` over a sandboxed folder, so recalling past work costs a few hundred bytes of context
  and no extra model call. See [the design notes](docs/plans/session-outcome-index.md).
- **Phone and desktop can never both answer.** A pending approval is resolved in one place on the
  host, keyed on the request the agent is waiting on, so the race between two clients is decided
  in the host rather than in either UI.
- **Provider-neutral agents.** Claude and Codex both run through Agent Client Protocol adapters
  behind one session manager, and each adapter version can be updated or pinned independently of
  the app. See [adapter management](docs/adapter-management.md).
- **The orchestrator drives Toucan through a CLI, not an MCP server.** It costs no tool-definition
  tokens in sessions that never orchestrate, works the same for any provider with a shell, and
  Toucan's main process still owns every ticket session, so each one gets an exact model and
  effort at launch and leaves a session record. See the
  [orchestrator plan](docs/plans/orchestrator-mode.md).
- **The command guard never touches your own agent config.** It is a `PreToolUse` hook
  registered per session, through the session's settings for Claude and launch overrides for
  Codex, and it runs on Toucan's bundled runtime, so Windows needs neither bash nor jq. An edited
  pattern list applies to sessions started afterwards and never changes one already running.
- **Architecture rules are enforced, not just written down.** `npm run check` runs Prettier, typed
  ESLint with zero warnings allowed, dependency-cruiser boundary rules, strict TypeScript and
  about 290 test files. CI runs the same gate on every push to `main` and every pull request,
  and a release is only published if it passes.

## How this was built

Toucan is built with AI coding agents, mostly Claude Code and Codex, and increasingly from inside
Toucan itself. I decide what gets built and how it fits together, review what the agents produce,
and maintain the guardrails that keep the quality up: the verification gate above, an
[architecture map](docs/architecture.md), and an [AGENTS.md](AGENTS.md) that records the
project's non-obvious invariants so every new session starts from them. Directing agents well
turned out to be the most interesting engineering problem here, which is why so much of Toucan is
about giving them memory and oversight.

## Status

Toucan is under active development and targets Windows x64 only. Workspace state stays on your
machine. Live shell processes end when Toucan exits; restoring running terminals is not
implemented.

## Documentation

- [Features](docs/features.md): everything Toucan does today.
- [Developing Toucan](docs/development.md): setting up a checkout, the verification gate,
  packaging and releases.
- [Architecture map](docs/architecture.md): process topology, module ownership and dependency
  boundaries.
- [AGENTS.md](AGENTS.md): operational invariants and sharp edges for agents working in the
  repository.
- `docs/research` preserves ideas and investigations; they are not claims about current behavior
  unless promoted into the features page or the architecture map.

## Acknowledgements

Credits to [NodeTerm](https://nodeterm.dev) for the idea of putting terminals and agents on one zoomable canvas.

## License and security

Toucan is licensed under the [Apache License 2.0](LICENSE). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).
