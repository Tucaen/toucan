---
title: Mobile companion plan
created: 2026-09-03
updated: 2026-09-03
status: draft plan (promoted from brain-dumps/mobile-session-access.md)
---

# Mobile companion plan

Connect a phone to one or more running Toucan instances (work PC, private PC), see active
agent chats, read transcripts, send messages, answer approvals, and spawn new chats for a
project.

## Decisions

- **Client**: PWA, served by Toucan itself. No app store, no second build pipeline. Target
  device: Android.
- **Networking**: Tailscale is the transport, but it stays *outside* Toucan. Toucan runs a
  plain HTTP + WebSocket server; Tailscale makes it reachable from the phone. SSH is
  rejected — tunnel management from a phone is hostile, and Tailscale solves the same
  problem (reachability + encryption between your own devices) with none of that.
- **Multi-connection**: falls out of the design. Each PC runs its own server; the PWA keeps
  a saved host list and switches between them. No relay, no cloud component.
- **Auth**: app-level pairing token on top of the tailnet. Desktop shows a token/QR once;
  phone stores it; every request carries it. A device on the tailnet is *reachable*, not
  *trusted* — the token is what authorizes driving agents.
- **Scope v1**: agent chats (claude/codex) only. No terminal nodes. Approvals ARE in v1 —
  without them a remote chat stalls at the first tool permission and read/send is near
  useless.
- **Cross-origin: CORS, not per-host bookmarks** (decided while implementing #132, the
  multiple-hosts slice). The client is *served by* one host but holds connections *to*
  another, and same-origin is only guaranteed for the serving host. The alternative —
  bookmark each host separately — is not a host switcher at all: the saved host list lives
  in `localStorage`, which is per origin, so each bookmark would keep its own list and its
  own tokens and switching would mean leaving the app. So Toucan's remote surface answers
  CORS preflights (`OPTIONS`, unauthenticated by necessity — a browser sends a preflight
  without the header it is asking permission to send) and returns
  `Access-Control-Allow-Origin: *` on *every* response, refusals included. `*` grants
  nothing: authorization is the pairing token in an `Authorization` header the requesting
  page has to already know, there are no cookies and no session state, and
  `Access-Control-Allow-Credentials` is deliberately absent, so a hostile page reaching a
  tailnet host learns exactly what any unauthorized caller learns — `401`. Putting the
  headers on failures too is what makes a revoked token distinguishable from an unreachable
  PC: without them a browser turns the `401` into an opaque network error and the phone
  would retry an outage forever instead of dropping that one host into re-pairing.
  WebSockets are not CORS-gated at all, so the chat socket needs nothing extra — but a
  browser *does* refuse `ws:`/`http:` from an HTTPS page, so a phone loaded over
  `tailscale serve` HTTPS can only reach hosts that also speak HTTPS. That is named in the
  UI (`hostBlockedByPageScheme`) rather than left to look like an offline host, and the way
  out is `tailscale serve` on both hosts (#133) or opening the other host directly.

## Architectural obstacles (from code survey, 2026-09-03)

1. **No network surface exists.** Everything is Electron IPC registered in
   `src/main/index.ts`. The server is net-new, lives under `src/main/remote/`, and per
   dependency-cruiser may depend only on `src/shared/` and the existing deep managers.
2. **Streams are bound to one `webContents` sender.** `AcpSessionManager.create()` captures
   `event.sender` and targets it with `webContents.send`. Multi-client needs an event
   broker in main that fans each session's `AgentEvent` stream out to N subscribers
   (renderer + remote clients), with the existing `replay` mechanism as the join-in-flight
   hook.
3. **Transcript state lives in the renderer.** `use-agent-conversation.ts` folds the
   `AgentEvent` stream into React state. The folding must become a pure, runtime-neutral
   reducer (natural home: `src/shared/`) so main can maintain a per-session transcript
   snapshot any client can fetch.
4. **Node creation is renderer-driven.** `addSessionNode` in `App.tsx` mints ids and
   geometry; the process starts on mount. A remote spawn must round-trip through the
   renderer (main asks the focused window to add the node) or main becomes spawn-
   authoritative. v1: round-trip through the renderer — smallest change, keeps the canvas
   the authority on node identity/geometry; revisit if headless spawn is ever needed.
5. **PWA secure-context gotcha.** Service workers, installability, and Web Push require
   HTTPS (or localhost). Plain HTTP over the tailnet gives a working web page but not an
   installable PWA and no push. Fix: `tailscale serve` provides automatic valid `ts.net`
   HTTPS certs in front of Toucan's plain HTTP listener. Ship v1 as a plain web page;
   HTTPS/install/push is a polish ticket.

## Tickets

Published as GitHub issues (2026-09-03), reshaped into tracer-bullet vertical slices; the
issues are the authoritative, detailed versions — the sections below are the original
sketch:

| Issue | Slice | Blocked by |
| --- | --- | --- |
| #125 | Prefactor: shared transcript reducer | — |
| #126 | Remote server + pairing + chat list on the phone | — |
| #127 | Prefactor: agent event broker in main | #125 |
| #128 | Read a chat live from the phone | #127, #126 |
| #129 | Send a message from the phone | #128 |
| #130 | Answer approvals from the phone | #128 |
| #131 | Spawn a new chat from the phone | #128 |
| #132 | Multiple hosts | #126 |
| #133 | Installable PWA + Tailscale HTTPS + setup docs | #126 |
| #134 | Push notifications for attention events | #130, #133 |

Dependency-ordered sketch below. T1–T4 are host-side (main process), T5–T8 the PWA,
T9–T10 polish.

### T1 — Shared transcript reducer

Extract the `AgentEvent` → transcript folding from
`src/renderer/src/use-agent-conversation.ts` into a pure reducer in `src/shared/`
(`foldAgentEvent(state, event) → state`). The hook becomes a thin wrapper over it. No
behavior change; covered by tests replaying recorded event sequences. This is the enabling
refactor for everything else and is worth doing even if the mobile feature stalls.

### T2 — Agent event broker in main

Break the single-sender binding in `AcpSessionManager`. Sessions publish `AgentEvent`s to a
broker; the renderer's `webContents` becomes subscriber #1 (no observable change), and main
keeps a live transcript snapshot per session by running the T1 reducer. Late subscribers get
snapshot + live tail (generalizing the existing `replay` contract). Same treatment for the
inputs: prompt, steer, approval decision become broker-level operations callable by any
authorized client, not just IPC.

### T3 — Remote server skeleton + pairing

New `src/main/remote/` module: HTTP + WebSocket listener (Node `http` + `ws`), **off by
default**, toggle + port in settings. Pairing: desktop generates a long-lived random token,
shows it as QR/text; clients send it as a bearer token on every request and on WS connect.
Constant-time compare, no token in URLs. Binds to all interfaces (tailnet reachability) —
the token is the gate. Includes a "revoke/regenerate token" action.

### T4 — Remote API v1

On top of T2 + T3:

- `GET /api/workspace` — projects + active chat nodes (id, kind, title, project, status,
  attention) derived from `WorkspaceState` + liveness.
- `WS /api/chats/:id` — transcript snapshot on connect, then live `AgentEvent` tail;
  accepts `prompt`, `approval_decision` messages inbound.
- `POST /api/chats` — spawn a new chat for a project `{ projectId, kind, initialInput? }`;
  round-trips through the renderer to add the canvas node (obstacle 4).
- Wire format: reuse `src/shared/agent.ts` types verbatim — no parallel DTO layer.

### T5 — PWA shell + host list

`mobile/` app (Vite + React, TS), built into static assets the T3 server serves at `/`.
Host manager: add host (URL + pairing token, QR scan later), persist in `localStorage`,
switch hosts, connection status, auto-reconnect with backoff.

### T6 — Chat list screen

Active chats grouped by project, with status (running / waiting for approval / idle /
failed) and attention badges, live-updating. This is the app's home screen.

### T7 — Chat view

Transcript rendering from the T1 reducer state: user/assistant messages as bubbles, tool
activity collapsed to one-line summaries, plan/status affordances minimal. Composer for
sending prompts. Approval requests render inline as allow/deny cards (the v1 killer
feature). Handles reconnect via snapshot + tail without duplicating messages.

### T8 — Spawn flow

"New chat" from the chat list: pick project (from `/api/workspace`), pick agent kind, type
an initial prompt, land in the new chat view.

### T9 — HTTPS, install, docs

Document the Tailscale setup (`tailscale serve` for valid HTTPS certs), verify PWA
installability on Android, write the user-facing setup guide (enable server, pair phone,
add host per PC).

### T10 — Push notifications

Web Push (VAPID) from the attention model (`src/shared/attention.ts`): notify on
approval-needed and turn-complete. Requires T9 (secure context). Android Chrome supports
push for installed PWAs.

## Open questions

- Product name for the mobile app (carried over from the brain dump; irrelevant until T5).
- Whether the desktop app must be *open* for remote access (v1: yes — the server lives in
  the Electron main process; a headless host is a separate future).
