# Toucan architecture

This is the starting map for changing Toucan. It describes ownership and dependency
direction; follow the links for implementation details. Toucan is an Electron application
with a privileged main process, a context-isolated renderer, and a narrow preload seam.

## Runtime map

```text
local files, Git, PTYs, ACP adapters, provider CLIs
                         |
                 src/main modules
                         |
                    Electron IPC
                         |
             src/preload/index.ts interfaces
                         |
        renderer orchestration and feature modules
                         |
                  React presentation

src/shared pure contracts and domain rules are imported by both sides.

mobile/ is a separate static client, served by src/main/remote over HTTP to a phone.
It imports src/shared contracts only, and reaches the host through the same HTTP API
any other client would.
```

[`src/main/index.ts`](../src/main/index.ts) is the composition root. It creates the
main-process modules, registers IPC handlers, owns the `BrowserWindow`, and shuts down
owned processes. [`src/preload/index.ts`](../src/preload/index.ts) translates those IPC
channels into the small `window.*Api` interfaces declared by
[`src/preload/index.d.ts`](../src/preload/index.d.ts). The renderer starts at
[`src/renderer/src/main.tsx`](../src/renderer/src/main.tsx), with
[`App.tsx`](../src/renderer/src/App.tsx) owning workspace-level orchestration.

## Ownership map

| Area                             | Owner                                                                                                                                                                                                                  | Responsibility and interface                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisted domain contracts       | [`src/shared/terminal.ts`](../src/shared/terminal.ts), [`agent.ts`](../src/shared/agent.ts), [`worktree.ts`](../src/shared/worktree.ts), [`conversation.ts`](../src/shared/conversation.ts)                            | Cross-process data shapes, validation-independent domain rules, and stable identities.                                                                                                                                                                                                                                                                                           |
| Cross-cutting pure rules         | [`src/shared`](../src/shared)                                                                                                                                                                                          | Attention, activity folding, worktree handoff, titles, stall guards, and text normalization. These modules know no runtime process.                                                                                                                                                                                                                                              |
| Application composition and IPC  | [`src/main/index.ts`](../src/main/index.ts)                                                                                                                                                                            | Construct adapters, validate IPC entry points, and connect process-owned interfaces to preload channels. Business decisions belong in the module that owns them, not in handlers.                                                                                                                                                                                                |
| Background process policy        | [`src/main/background-process.ts`](../src/main/background-process.ts)                                                                                                                                                  | Applies the hidden-window invariant to every non-interactive Node child process. Agent-specific launch and descendant-process propagation remain in [`agent-process.ts`](../src/main/agent-process.ts).                                                                                                                                                                          |
| Agent sessions                   | [`src/main/acp-session-manager.ts`](../src/main/acp-session-manager.ts)                                                                                                                                                | ACP lifecycle, prompts and steering, replay, auth, approvals, model/mode/effort state, commands, and agent events behind `AcpSessionManager`. Process launch policy is isolated in [`agent-process.ts`](../src/main/agent-process.ts).                                                                                                                                           |
| Plain terminals                  | [`src/main/terminal-manager.ts`](../src/main/terminal-manager.ts)                                                                                                                                                      | PTY ownership, incarnation identity, attachment authorization, liveness, resize/write/kill, and output delivery behind `TerminalManager`. [`terminal-scrollback-store.ts`](../src/main/terminal-scrollback-store.ts) separately owns bounded display-only history.                                                                                                               |
| Provider discovery               | [`src/main/session-providers.ts`](../src/main/session-providers.ts)                                                                                                                                                    | Claude/Codex launch arguments, installed-session discovery, and lightweight transcript previews behind `SessionProviders`.                                                                                                                                                                                                                                                       |
| Conversation history and titles  | [`src/main/conversation-history.ts`](../src/main/conversation-history.ts), [`conversation-title-store.ts`](../src/main/conversation-title-store.ts)                                                                    | Paginated provider-transcript discovery and Toucan-owned durable title metadata. Provider transcripts are read, never rewritten.                                                                                                                                                                                                                                                 |
| Workspace persistence            | [`src/main/workspace-store.ts`](../src/main/workspace-store.ts)                                                                                                                                                        | Validation, migration, serialized durable writes, backup recovery, and unrecoverable-state reporting behind `WorkspaceStore`.                                                                                                                                                                                                                                                    |
| Git worktrees                    | [`src/main/git-worktree.ts`](../src/main/git-worktree.ts)                                                                                                                                                              | Git execution, discovery, status, and evidence-gated creation/removal behind `WorktreeManager`. Renderer confirmation policy lives in [`worktree-removal.ts`](../src/renderer/src/worktree-removal.ts).                                                                                                                                                                          |
| Account usage                    | [`src/main/provider-usage.ts`](../src/main/provider-usage.ts)                                                                                                                                                          | Provider-neutral caching interface over the Claude and Codex usage adapters.                                                                                                                                                                                                                                                                                                     |
| Remote access                    | [`src/main/remote/remote-server.ts`](../src/main/remote/remote-server.ts)                                                                                                                                                                                                                              | The HTTP listener a paired phone talks to, off by default, plus its pairing token ([`pairing.ts`](../src/main/remote/pairing.ts)), durable settings ([`remote-access-store.ts`](../src/main/remote/remote-access-store.ts)) and route/asset decisions ([`remote-routes.ts`](../src/main/remote/remote-routes.ts)). The workspace projection it serves is pushed in by the renderer; it derives none of its own.                                                                                       |
| Mobile companion client          | [`mobile/`](../mobile)                                                                                                                                                                                                                                                                                | Pairing screen and chat list as a static build served at `/`. Its list decisions live in [`chat-list.ts`](../mobile/src/chat-list.ts), its connection, composer and answer state in [`chat-connection.ts`](../mobile/src/chat-connection.ts), its question-set form rules in [`decision-answers.ts`](../mobile/src/decision-answers.ts) and its transport in [`remote-client.ts`](../mobile/src/remote-client.ts).                                                                                                                                                                                                                                                                                       |
| Privilege seam                   | [`src/preload/index.ts`](../src/preload/index.ts), [`index.d.ts`](../src/preload/index.d.ts)                                                                                                                           | The only renderer-facing access to IPC, Electron clipboard operations, and process-owned capabilities. Keep runtime exposure and declared interfaces synchronized.                                                                                                                                                                                                               |
| Canvas orchestration             | [`src/renderer/src/App.tsx`](../src/renderer/src/App.tsx), [`canvas-workspace.ts`](../src/renderer/src/canvas-workspace.ts), [`node-fit.ts`](../src/renderer/src/node-fit.ts)                                          | Compose workspace modules, projects, worktrees, React Flow nodes, recently closed sessions, conversion between persisted and live nodes, and session-local fit/restore geometry.                                                                                                                                                                                                 |
| Workspace lifecycle              | [`workspace-persistence.ts`](../src/renderer/src/workspace-persistence.ts), [`workspace-attention.ts`](../src/renderer/src/workspace-attention.ts), [`WorkspaceDialogs.tsx`](../src/renderer/src/WorkspaceDialogs.tsx) | Load-before-save and unrecoverable-state safety; durable attention transitions, aggregation, pruning, and canvas-node projection; workspace-level dialog presentation. [`use-provider-rate-limits.ts`](../src/renderer/src/use-provider-rate-limits.ts) owns the single account-wide usage poll.                                                                                 |
| Agent conversation orchestration | [`src/renderer/src/use-agent-conversation.ts`](../src/renderer/src/use-agent-conversation.ts), [`ChatNode.tsx`](../src/renderer/src/ChatNode.tsx)                                                                      | Wire conversation state to the rendered chat. Event-to-transcript folding is the shared reducer in [`src/shared/agent-transcript.ts`](../src/shared/agent-transcript.ts); the hook owns only renderer-local delivery state (draft, outbox, optimistic sends) and IPC. Composer and transcript decisions are delegated to pure feature modules.                                    |
| Terminal presentation            | [`src/renderer/src/TerminalNode.tsx`](../src/renderer/src/TerminalNode.tsx)                                                                                                                                            | xterm lifecycle and the presentation of main-owned terminal identity/liveness. Retained scrollback never participates in operational decisions.                                                                                                                                                                                                                                  |
| Renderer feature logic           | Small non-TSX modules in [`src/renderer/src`](../src/renderer/src)                                                                                                                                                     | Pure decisions for composer behavior, queued prompts, decisions, usage, activity/card recognition, scrolling, liveness presentation, and worktree removal. Tests call these interfaces directly; TSX modules render their results.                                                                                                                                               |
| Brain-dump library UI            | [`src/renderer/src/BrainDumpLibraryPanel.tsx`](../src/renderer/src/BrainDumpLibraryPanel.tsx), [`use-brain-dump-library.ts`](../src/renderer/src/use-brain-dump-library.ts)                                            | The docked library panel and the one owner of its async library/capture state. Width and mode decisions live in [`brain-dump-panel-layout.ts`](../src/renderer/src/brain-dump-panel-layout.ts), link handling in [`brain-dump-links.ts`](../src/renderer/src/brain-dump-links.ts), and topic presentation in [`brain-dump-topics.ts`](../src/renderer/src/brain-dump-topics.ts). |
| Tool-card extension seam         | [`src/renderer/src/tool-card-families.tsx`](../src/renderer/src/tool-card-families.tsx)                                                                                                                                | Ordered registry mapping normalized agent activities to purpose-built card modules. Add a family here instead of branching throughout the transcript renderer.                                                                                                                                                                                                                   |

## Dependency direction

These rules are stated in path terms so they can become import-lint rules without
reinterpretation. “May import” is directional; the reverse direction is forbidden
unless explicitly listed.

| Importing path                | May import                                                                                                 | Must not import                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/shared/**`               | `src/shared/**`; runtime-neutral libraries or type-only external contracts                                 | `src/main/**`, `src/preload/**`, `src/renderer/**`, Electron, Node runtime modules, React, browser globals             |
| `src/main/**`                 | `src/shared/**`, `src/main/**`, Electron/Node and external process adapters                                | `src/preload/**`, `src/renderer/**`                                                                                    |
| `src/preload/**`              | Shared types and Electron's `contextBridge`, `ipcRenderer`, or deliberately exposed clipboard operations   | `src/main/**`, `src/renderer/**`; domain decisions or persistence/process implementations                              |
| `src/renderer/src/**`         | `src/shared/**`, other renderer modules, browser-safe libraries, and the declared `window.*Api` interfaces | `src/main/**`, the preload implementation, Electron or Node runtime modules, direct filesystem/process/provider access |
| `src/main/remote/**`          | `src/shared/**`, other `src/main` modules, Node's HTTP and crypto                                        | Electron's `app`/`BrowserWindow`/`ipcMain` beyond the composition root's wiring, and any renderer module            |
| `mobile/**`                   | `src/shared/**` type contracts, React, browser APIs                                                        | `src/main/**`, `src/preload/**`, `src/renderer/**`, Node runtime modules                                            |
| Renderer pure feature modules | Shared contracts and other pure renderer feature modules                                                   | React views (`App.tsx`, `ChatNode.tsx`, card TSX files), `window.*Api`, or side effects                                |

Additional rules:

- Cross-process values are defined in `src/shared`, transported by preload, and
  validated or interpreted by their owning module. Do not create a second IPC shape in
  a renderer module.
- Main-process adapters satisfy interfaces consumed by `index.ts`; renderer modules do
  not select or instantiate them.
- `App.tsx` may orchestrate feature modules, but reusable decisions should flow toward
  a pure interface rather than back into `App.tsx` or a view.
- TSX card modules may depend on their adjacent recognition/presentation logic;
  recognition modules must not depend on the TSX view. The ordered registry is the one
  intentional assembly point.
- Tests may cross these production layers to exercise an interface. Production code may
  never import `tests/**`.

## Engineering principles

These principles guide changes within the dependency boundaries above. They are review
criteria rather than reasons to reorganize working code mechanically.

- Organize code around clear ownership and cohesive capabilities. The Electron runtime
  directories (`main`, `preload`, `renderer`, and `shared`) are real architectural boundaries;
  within them, introduce capability directories when they improve locality, not merely to
  satisfy a folder convention.
- Keep capability internals private once a capability has an explicit boundary. Consumers
  should use its deliberate public module rather than importing implementation details. A
  capability does not need an `index.ts` barrel when a named module is already the clearest
  interface.
- Composition roots may depend on capabilities; capabilities must not depend on composition
  roots. `src/main/index.ts` composes main-process modules and `App.tsx` composes renderer
  capabilities. Reusable decisions must not import either root.
- React components should primarily render UI and coordinate interactions. Put substantial
  transitions, policies, parsing, and domain decisions in focused hooks or pure modules where
  they can be tested without rendering. UI-specific behavior may remain with the UI that owns
  it.
- State belongs at its narrowest genuine owner. Lift it or place it in context only when
  multiple consumers genuinely share its lifetime and authority.
- Keep one authority for external or process-owned data. A renderer projection needed for UI
  is valid; a second independently mutable copy of provider, filesystem, or main-process state
  is not unless its synchronization contract is explicit.
- Use effects to synchronize React with systems outside React: browser APIs, timers,
  subscriptions, persistence, IPC, and owned processes. Prefer render-time derivation, event
  handlers, or explicit state transitions for ordinary computation and interaction handling.
- Prefer composition of cohesive interfaces over components controlled by broad collections
  of flags and callbacks. Evaluate an interface by the responsibilities it exposes, not by raw
  prop or file count.
- New runtime dependencies require written justification in the change description. Explain
  why existing code or dependencies are insufficient and note relevant bundle, packaging,
  native-binary, Windows-support, maintenance, and licensing implications.

The TypeScript projects already reflect the runtime split:
[`tsconfig.node.json`](../tsconfig.node.json) builds main, preload, and shared code;
[`tsconfig.web.json`](../tsconfig.web.json) builds renderer, preload declarations, and
shared code. They are compilation partitions, not permission to bypass the rules above.

## Important seams and deep modules

- **Preload interfaces** are the privilege seam. A transport change should be possible
  behind `window.terminalApi`, `window.agentApi`, `window.usageApi`,
  `window.worktreeApi`, and `window.conversationApi` without changing canvas behavior.
- **WorkspaceStore**, **TerminalManager**, **AcpSessionManager**, **WorktreeManager**, and
  **ConversationHistory** are deep modules: each concentrates filesystem, subprocess,
  protocol, recovery, or lifecycle complexity behind a small interface used by the
  composition root and its tests.
- **Shared domain rules** are the cross-process decision seam. Identity and safety rules
  such as attention folding, worktree blockers, and activity delegation have one owner
  that both runtimes can use.
- **Persisted/live canvas conversion** in `canvas-workspace.ts` keeps serializable state
  independent of React callbacks and runtime handles.
- **Workspace lifecycle coordination** keeps load-before-save and unrecoverable-state protection
  behind `useWorkspacePersistence`; `useWorkspaceAttention` is the one interface for attention
  transitions and their projection onto canvas nodes. `App.tsx` supplies snapshots and composes
  these modules without reimplementing their state machines.
- **The brain-dump panel** is docked, not overlaid: it is a sibling of the canvas region, so
  opening it narrows React Flow's box instead of remounting it, and it stays mounted (hidden)
  once opened so selection, search, scroll, and an unsent draft survive a close. What the
  library contains is always re-read from `window.brainDumpApi`; a capture's prose summary is
  never treated as state.
- **Remote access** has one gate and one authority. Every `/api` route is authorized by the
  pairing token, compared in constant time and never accepted from a URL; the static client
  bundle is public because the pairing screen has to load before a token exists. The canvas
  remains the authority on what a phone lists: the renderer publishes a
  `RemoteWorkspaceProjection` and the host serves the latest one rather than deriving a second
  view of the workspace.
- **Pure renderer feature modules** keep high-frequency UI decisions testable without
  rendering. Their adjacent DOM tests verify the wiring rather than duplicating the
  decision matrix.

## Verification

Canonical repository checks are:

```sh
npm run check
npm run check:full
```

`npm run check:architecture` runs the dependency rules in
[`dependency-cruiser.config.mjs`](../dependency-cruiser.config.mjs), including cycle detection.
Each rule is named in its failure output and reports the offending importer and dependency path.

`npm run build:mobile` builds the phone client into `out/mobile`, where the remote server looks
for it; `npm run build` runs it after `electron-vite build`, which owns the sibling directories.

`npm test` first compiles and runs `tests/**/*.test.ts` with Node's test runner, then
runs `tests/**/*.dom.test.tsx` under Vitest/jsdom. Representative interfaces:

- process and protocol lifecycle: [`acp-session-manager-steering.test.ts`](../tests/acp-session-manager-steering.test.ts), [`terminal-manager.test.ts`](../tests/terminal-manager.test.ts)
- persistence and recovery: [`workspace-store.test.ts`](../tests/workspace-store.test.ts), [`terminal-scrollback-store.test.ts`](../tests/terminal-scrollback-store.test.ts)
- worktree safety and canvas restoration: [`git-worktree.test.ts`](../tests/git-worktree.test.ts), [`canvas-workspace.test.ts`](../tests/canvas-workspace.test.ts)
- remote access, decisions then listener: [`remote-access.test.ts`](../tests/remote-access.test.ts), [`remote-server.test.ts`](../tests/remote-server.test.ts), [`remote-access.dom.test.tsx`](../tests/remote-access.dom.test.tsx)
- mobile companion, decisions then screens: [`mobile-chat-connection.test.ts`](../tests/mobile-chat-connection.test.ts), [`mobile-chat-view.test.ts`](../tests/mobile-chat-view.test.ts), [`mobile-decision-answers.test.ts`](../tests/mobile-decision-answers.test.ts), [`mobile-chat-answers.dom.test.tsx`](../tests/mobile-chat-answers.dom.test.tsx)
- pure rule plus rendered wiring: [`session-usage.test.ts`](../tests/session-usage.test.ts) with [`session-usage-bar.dom.test.tsx`](../tests/session-usage-bar.dom.test.tsx), and [`prompt-outbox.test.ts`](../tests/prompt-outbox.test.ts) with [`composer-queue-while-busy.dom.test.tsx`](../tests/composer-queue-while-busy.dom.test.tsx)
- cross-process replay into UI: [`acp-session-manager-replay.test.ts`](../tests/acp-session-manager-replay.test.ts), [`restored-chat-transcript.dom.test.tsx`](../tests/restored-chat-transcript.dom.test.tsx)

## Documentation responsibilities

- [`README.md`](../README.md) is the human entry point: product status, setup, everyday
  commands, packaging, and a short link here.
- This document is the current structural map: process topology, module ownership,
  dependency rules, seams, and verification routes.
- [`AGENTS.md`](../AGENTS.md) is durable project memory for non-obvious invariants and
  sharp edges that agents must preserve. It should point to authoritative code/tests and
  must not grow into a second architecture map.
- `docs/brain-dumps` and `docs/research` preserve ideas and investigations; they are not
  statements of current architecture unless promoted here or into code.

When a change alters user-visible capabilities, setup or verification commands, process
boundaries, or module ownership, update the corresponding orientation document in the
same change. Reviewers should treat a stale README or architecture map as an incomplete
architecture-facing change; reserve `AGENTS.md` updates for new non-obvious invariants or
sharp edges rather than duplicating the public orientation docs.
