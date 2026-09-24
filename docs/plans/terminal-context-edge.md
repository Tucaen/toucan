---
title: Terminal-context edge plan
created: 2026-09-17
updated: 2026-09-21
status: shipped v0.15.0 (#199, #202, #203)
---

# Terminal-context edge: an agent reads a connected terminal's output

Plan for issue #199 (former private tracker). Decisions resolved in the issue
comments (2026-09-17, amended same day); this doc records the resolved design and the
implementation slices.

A user-drawn edge from a terminal node to a chat node grants exactly one capability: the chat
node's agent may read that terminal's output on demand, through a tool. Edges are typed
connections carrying that capability, never freeform arrows. Read-only by construction — no
write/input path exists anywhere in the design.

Why this beats the agent running its own build: the motivating loop is a dev server with hot
reload. The agent cannot own that process (the port is taken, and a second instance loses the
running app state the user is watching), so its fallback today is triggering cold full builds —
minutes per fix-check cycle where the hot reloader had the answer in seconds. The value is
concentrated in long-lived processes the agent cannot reproduce; for one-shot commands the agent's
own shell remains strictly better, which is why the feature is expected to sit unused in >90% of
sessions and is costed accordingly (see delivery).

## Resolved decisions

1. **Delivery: a Toucan-hosted MCP server, passed only to sessions that have an edge, enforced at
   call time in main.** Injection/steering was rejected (one-shot — defeats re-read-after-fix, the
   whole value); a scrollback file under `additionalDirectories` was rejected (write-debounced and
   deliberately unfsynced, so stale mid-build; raw ANSI; grant fixed at session creation). The
   always-on variant (server on every session, edge checked at call time) was rejected too: even
   one tool definition (~100–300 tokens) per session is a cost >90% of sessions should not pay.
   Tokens are spent only when a session actually has an edge, and per call only for the bounded
   tail returned.
2. **Lifecycle: runtime-only, never persisted.** Closing either node removes the edge. It does not
   survive a restart — terminals hydrate `unverifiable` (#136 tracks restart semantics) — so no
   `WorkspaceState` field, no validation/pruning in `workspace-store.ts`, no remote-projection
   decision. Revisit persistence if #136 lands. Within one app run the edge survives an
   incarnation exit: the retained tail (crash/build output) is exactly what the agent needs then,
   and the read result says explicitly that the process has exited.
3. **Scope: 512 KiB retained, bounded incremental reads.** Per-read default is a small tail
   (~200 lines / 16 KiB) with a size parameter capped at the retained buffer — 512 KiB is ~130k
   tokens and must never be one tool result. Main keeps a read cursor per (agent session,
   terminal) so a repeat read returns only output since the last read, which is what makes the
   hot-reload loop cheap. A server-side filter parameter is a possible follow-up; raising the
   retention cap is not planned — beyond it, redirect the command's output to a file.

## Slice 1 — canvas edges (renderer) and the edge registry (main)

The canvas has no edges at all today: the `ReactFlow` in `App.tsx` carries no `edges` prop and no
node declares handles. This slice introduces them as the typed terminal-context connection only:

- `TerminalNode` grows a source handle, `ChatNode` a target handle. `isValidConnection` admits
  terminal→chat only; per issue non-goals there are no generic untyped edges, so nothing else is
  connectable. Multiple terminals may feed one chat node; the tool then takes a terminal selector
  or reports the connected set.
- Edge state is React state in `App.tsx` beside `nodes` — deliberately not `WorkspaceState`
  (decision 2). The React Flow removal wrapper that already feeds `recentlyClosedNodes` also drops
  edges touching a removed node.
- Main is the privilege boundary, so the renderer's edge set is mirrored into a main-process
  **edge registry** (new module, injected at the composition root like the broker): renderer IPC
  replaces the full edge set on every change (idempotent, last-write-wins — simpler than deltas
  and self-healing after a renderer reload), keyed by the terminal's durable `sessionId` and the
  chat node's agent session. Every read the MCP tool serves is checked against this registry at
  call time; the tool definition being present never implies the capability.

## Slice 2 — retained tail and cursors in `terminal-manager.ts`

Reads go through the terminal's owner, keyed by the durable sessionId and the reading agent's
session. Unlike every other terminal call they do *not* take an incarnationId: a reader that has
never seen this terminal cannot name its current incarnation, and after a crash-and-restart the
only honest answer is the one the manager already knows. The incarnation is reported back on the
result instead, which is what a reader needs it for — telling a new process from the old one.

The scrollback store stays display-only per AGENTS.md (its file is write-debounced and unfsynced;
handing an agent stale mid-build output would be the fix loop reading the previous build), so the
manager retains its own bounded in-memory tail per running terminal, fed from the same `onData`
that feeds the renderer, capped at `TERMINAL_SCROLLBACK_MAX_BYTES`. The tail outlives the
incarnation's exit within the process (kept on `lastStates`' lifetime, dropped when the session is
gone), so a read after a crash returns the crash output labeled with the manager's own liveness
verdict — never derived from retained content, which remains barred from any operational meaning.

Read cursors live beside the tail: per (agent session, terminal session), advanced only by the
serving read, reset when the incarnation changes (a new process's byte 0 is not the old one's).
Output is ANSI-stripped at read time (store raw, strip on serve — the renderer still wants the raw
bytes), and each result carries: liveness verdict, whether this is a delta or a from-the-top read,
how much retained output the size cap skipped.

## Slice 3 — the MCP server and session gating

- One in-process MCP server exposing a single `read_terminal_output` tool (parameters: optional
  terminal selector when several edges exist, optional size override capped at retention; both
  optional so the bare call does the right thing). Results are plain text — both adapters flatten
  content blocks anyway.
- **Transport: verified and resolved (2026-09-17) — the localhost HTTP listener.** Read from the
  pinned dists: claude-agent-acp 0.75.1 accepts `mcpServers` entries of `type: 'http' | 'sse'`
  (`{url, headers}`, forwarded into the SDK's `mcpServers` options) plus stdio, and codex-acp
  1.10.0 accepts `type: 'http'` (mapped to Codex's `{url, http_headers}`) plus stdio while
  rejecting SSE and ACP transports outright. So HTTP is the one transport both take, and the
  stdio bridge fallback is not needed. Implementation: `src/main/terminal-context-mcp.ts`, a
  hand-rolled stateless streamable-HTTP JSON-RPC server (initialize / notifications / tools/list
  / tools/call / ping, always-JSON responses) on a lazily bound 127.0.0.1 port — no edge, no
  listener — with a per-agent bearer token minted with the grant, so a stray local process cannot
  read terminals and the serving read is keyed to the right cursor.
- The server is included in `mcpServers` only when the chat node has a terminal edge at session
  creation (the `withAdditionalDirectories`/delegation seam is where per-session configuration
  already composes). Sessions without an edge carry zero extra tokens.
- **Mid-session edge adoption**: `mcpServers`, like `additionalDirectories`, is fixed at creation,
  so drawing an edge onto a running session restarts it at the next safe boundary — `idle`,
  `result`, `dormant`, `exited`, never `working`/`starting`/`attention`/`stalled` — the
  worktree-claim-adoption pattern (`adoptClaimedWorktrees`); the resume replays the transcript and
  the recreated session carries the tool. Unlike worktree adoption this is not Codex-only: the cwd
  does not change, so Claude's directory-scoped resume is safe. Removing an edge forces nothing:
  the call-time registry check already refuses, and the definition drops off at the next natural
  resume.
- MCP `tools/list_changed` (always-connected server advertising zero tools until an edge exists)
  is noted as a later upgrade that would remove the adoption restart, pending verification that
  both adapters honor it mid-session.

## Tests

- Registry: grant/revoke/prune on node close, call-time refusal without an edge, renderer-reload
  resync (slice 1).
- Manager tail: cap, cursor delta semantics, cursor reset on new incarnation, exited-tail
  retention and labeling, ANSI stripping (slice 2).
- Session gating: `mcpServers` populated only with an edge, on both `session/new` and
  `session/load`, against the scripted adapter (slice 3, beside
  `tests/acp-session-manager-launch.test.ts`).
- Adoption: edge drawn mid-session restarts only at a safe boundary (the worktree-adoption test
  shape).
- Live smoke per provider, deliberately outside `npm test` (it needs a real dev server, account
  tokens and a drawn edge): start `npm run dev` in a plain terminal node, draw its edge onto a
  chat node of the provider under test, ask the agent to break and fix a renderer file while
  re-reading the terminal — the first read must return the hot-reload error, the read after the
  fix only the fresh rebuild output (the cursor delta), and a session opened with no edge must
  not list `read_terminal_output` at all.

## Non-goals (restated from the issue)

No write/input access to the terminal. No generic untyped edges — this ships as the
terminal-context feature with an edge as its UI. No persistence of edges (decision 2), no remote
projection, and no operational meaning ever derived from retained output on Toucan's side.
