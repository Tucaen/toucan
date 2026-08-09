# NodeTerm research for ADE

_Primary-source review, 2026-08-09. NodeTerm is early-access and moving quickly; the release page listed v0.2.40 on 2026-08-08 when this note was written._

## Bottom line

NodeTerm is best understood as a **spatial cockpit for many independent terminal-backed AI sessions**, not as one persistent assistant. Each agent is an ordinary CLI in its own terminal/tmux session. NodeTerm adds layout, lifecycle status, notifications, session recovery, selective cross-session context, source-control tools, and remote clients around those processes. That makes its session model a strong fit for ADE's concern about one assistant accumulating an unusable context. ([Overview](https://nodeterm.dev/docs/), [Agents overview](https://nodeterm.dev/docs/agents/overview/))

For ADE, the most reusable ideas are the separation between a session host and its clients, normalized agent lifecycle events, tmux-backed continuity, and pull-based context links. NodeTerm itself could be used or forked for a personal prototype, but its BUSL license, lack of Windows desktop support, internal rather than public integration seams, and rapidly changing remote features make a clean ADE-owned boundary around it important.

## Product and session model

- A project is a pan/zoom canvas of nodes. Nodes include terminals, agent terminals, sticky notes, groups/worktree frames, Monaco editors, git diffs, web/video surfaces, and an SDK-driven Claude chat. The same project can also be viewed as a board whose cards are live sessions. ([README](https://github.com/eneskirca/nodeterm#features), [Node types](https://nodeterm.dev/docs/concepts/node-types/))
- An agent node is deliberately small: a real terminal plus a one-shot startup command. Built-ins launch `claude`, `codex`, `gemini`, or `opencode`; a custom agent can launch any CLI. This preserves each agent's native authentication, capabilities, transcript, and session semantics instead of proxying all models through a central conversation. ([Agents overview](https://nodeterm.dev/docs/agents/overview/))
- Rich status does not come from scraping terminal text. Installed agent hooks post lifecycle events to a loopback HTTP service, which normalizes them to `working`, `waiting`, `blocked`, and `done`; the UI presents `RUNNING` and `NEEDS YOU`, unread markers, and notifications. Custom agents only expose process/title status unless they gain a hook adapter. ([Status and notifications](https://nodeterm.dev/docs/agents/status-and-notifications/), [Agents overview](https://nodeterm.dev/docs/agents/overview/))
- Capabilities are per-adapter, not assumed globally. All four built-ins currently report status, resume after reboot, and support context links; subagent visualization, conversation branching, managed accounts, permission modes, usage reporting, and SDK chat are currently Claude-specific. ([Capabilities matrix](https://nodeterm.dev/docs/agents/overview/#capabilities-by-agent))
- Claude subagents appear as ephemeral child cards with task, state, duration, token/tool counts, and a streaming transcript. They are observational UI, not durable project nodes. Scheduled/cron work is tracked across sessions and restarts, while an in-session loop dies with that session. ([Subagents and loops](https://nodeterm.dev/docs/agents/subagents-and-loops/))
- Cross-session context is **pull-based**. Linking two built-in agents gives each a helper that can request the other's transcript, summary, or recent output; it does not inject full histories continuously. Claude receives a skill, while Codex/opencode and Gemini receive instructions in `AGENTS.md` or `GEMINI.md`. A linked sticky is announced once and remains readable on demand. ([Context Link](https://nodeterm.dev/docs/agents/context-link/))

This is the key ADE lesson: durable coordination metadata can be shared, but working context should remain bounded per task/session and imported only when needed.

## Persistence and resume

- Every terminal runs in a private tmux server as `nt-<node-id>` using a generated config, independent of the user's normal tmux setup. Closing NodeTerm detaches the client; reopening performs a warm reattach and preserves live processes. ([Terminal persistence](https://nodeterm.dev/docs/concepts/terminal-persistence/))
- Reboot is recovery, not process survival. NodeTerm snapshots up to 256 KB of recent output per terminal, replays it after reboot, and relaunches recognized agents using their native session identifiers: `claude --resume`, `codex resume`, `gemini --resume`, or `opencode --session`. Ordinary OS processes cannot survive a reboot. ([Terminal persistence](https://nodeterm.dev/docs/concepts/terminal-persistence/#across-reboots))
- Canvas state for a folder project lives in `<cwd>/.nodeterm/project.json`. It is portable and git-shareable, is watched for external changes, and has conflict handling for simultaneous local/external edits. Closing a project only detaches it; explicitly deleting it from the recently-closed list destroys its tmux sessions. ([Projects](https://nodeterm.dev/docs/concepts/projects/))
- Server Edition persists auth, browser sessions, workspace, settings, and scrollback in its data directory (or `/data` in Docker). The volume is essential. A container redeploy kills its in-container tmux server and all live processes; only the cold-restore path remains. ([Server Edition](https://nodeterm.dev/docs/remote/server-edition/))

ADE should therefore model `workspace`, `session`, `process attachment`, `agent-native conversation id`, `event log`, and `recovery snapshot` as distinct things. “Resumed conversation” must never be presented as “the same process survived.”

## Remote and mobile access

NodeTerm offers three different remote patterns:

1. **SSH project:** the desktop canvas stays local while terminals, agents, files, and git operate on a remote host. Traffic is multiplexed over one SSH `ControlMaster`; tmux runs remotely. The project file is authoritative on the server with an offline local cache and revision reconciliation. Git worktree features are not supported for SSH projects. ([SSH projects](https://nodeterm.dev/docs/remote/ssh-projects/))
2. **Server Edition:** a headless Node process serves the same React renderer to a browser over a WebSocket-RPC bridge. It supports terminal I/O, files/editor/diff, source control, folder browsing, and agent observability. SDK chat and agent-driven canvas-control verbs are not yet bridged. It is single-user: one scrypt-hashed password, per-browser `HttpOnly` cookies, login lockout, and same-origin checks on WebSocket upgrades. It intentionally serves plain HTTP, defaults to loopback, and requires a TLS reverse proxy/VPN for non-local use. ([Server Edition docs](https://nodeterm.dev/docs/remote/server-edition/), [server implementation notes](https://github.com/eneskirca/nodeterm/blob/main/docs/SERVER.md))
3. **iOS companion:** a separate SwiftUI app is a terminal/session view rather than the canvas. It attaches to the exact desktop tmux sessions, can watch output/status and type replies, connects directly on LAN, and can use an end-to-end encrypted relay off-network. ([Mobile companion](https://nodeterm.dev/docs/remote/mobile-companion/), [README](https://github.com/eneskirca/nodeterm#your-sessions-anywhere))

For ADE's phone requirement, SSH is not the only viable transport. A narrow mobile/web session client over a private overlay network is more usable than a raw SSH terminal while retaining the same trust boundary. A sensible first deployment is a long-lived Linux host, ADE bound to loopback, and access through Tailscale or another TLS/VPN proxy. Keep direct SSH available as an operator/recovery path.

There is current documentation drift: the relay-quota page still describes five free relay bridges per month, but the v0.2.33 release notes say relay remote access became free by removing the Pro gate and quota. Treat relay availability/pricing as volatile until confirmed in the installed release. ([Relay quota page](https://nodeterm.dev/docs/remote/relay-quota-and-pro/), [release history](https://nodeterm.dev/releases))

## Architecture and technology

The repository is TypeScript with a reusable renderer and multiple shells:

- Electron has `main`, a preload-only `window.nodeTerminal` bridge, and a React renderer; shared types and IPC names cross those contexts.
- Electron-free services for PTYs, workspace/settings, git, agents, and hooks sit behind a `CorePlatform` seam. Server Edition supplies a `ServerPlatform` and exposes the same services over WebSocket RPC; a browser shim recreates `window.nodeTerminal` for the unchanged renderer.
- The renderer uses a `TerminalTransport` abstraction. `LocalTransport` talks to the local host and `RemoteTransport` to an SSH host, keeping locality out of the canvas UI.
- React Flow owns live canvas nodes; serialized nodes go to the project file; tmux owns live terminal continuity.
- Principal implementation pieces include Electron, React, TypeScript, React Flow, xterm, tmux through `node-pty`, Monaco, Zustand, Node's HTTP server plus `ws`, and a separate SwiftUI mobile client. ([Architecture summary](https://github.com/eneskirca/nodeterm#architecture), [package.json](https://github.com/eneskirca/nodeterm/blob/main/package.json), [Server Edition notes](https://github.com/eneskirca/nodeterm/blob/main/docs/SERVER.md))

## Reuse and integration options for ADE

| Option | What ADE reuses | Advantage | Main cost/risk |
| --- | --- | --- | --- |
| Run NodeTerm beside the vault | NodeTerm owns sessions/UI; ADE exposes vault search/context through files, a CLI, skill, or MCP server | Fastest validation; minimal fork | Two products and data models; no documented stable plugin API; Context Link may modify repo instruction files |
| Fork/extend NodeTerm | `CorePlatform`, `TerminalTransport`, renderer/canvas, hook normalizer, tmux persistence, Server Edition | Most existing functionality | BUSL obligations and competitive-use restriction; upstream churn; difficult future product/company boundary |
| Build ADE-owned host/client around the same patterns | Independent session registry, PTY/tmux adapter, hook adapters, WebSocket API, web/mobile UI | Clean domain model and license; vault is first-class | Largest engineering effort; terminal correctness, recovery, and security are substantial work |

NodeTerm exposes useful **internal seams**, not a versioned external SDK. The least-coupled experiment is therefore to treat it as a session host and connect ADE through ordinary process/file boundaries. If source reuse is chosen later, isolate NodeTerm behind an ADE `SessionHost` contract so it can be replaced without migrating the vault or coordinator.

Candidate ADE contracts inspired by NodeTerm:

- `SessionHost`: create, attach, resize, send input, interrupt, stop, and recover a terminal-backed session.
- `AgentAdapter`: launch/resume commands, native session-id discovery, hook installation, capability declaration, and event normalization.
- `SessionEvent`: working/waiting/blocked/done plus approval/question/subagent events, independent of the agent vendor.
- `ContextSource`: pull a bounded transcript, summary, recent output, or vault document on demand; never merge every session into a permanent global prompt.
- `ClientTransport`: one protocol usable by desktop, browser, and mobile clients, with authorization enforced at the host.
- `ProjectStore`: durable workspace/session metadata outside transient process state; vault knowledge remains a separate, inspectable source.

## Constraints and risks

- **License:** NodeTerm uses Business Source License 1.1, not an OSI open-source license. Copying, modification, redistribution, and production use are allowed under its grant, except offering it to third parties as hosted, embedded, or standalone software/service in a way that competes with NodeTerm or the licensor's related products. Each release changes to MIT four years after publication. Personal use appears within the grant; a team/company rollout or ADE product would need a fresh license review and possibly a commercial license. This is a product constraint, not merely an attribution task. ([LICENSE](https://github.com/eneskirca/nodeterm/blob/main/LICENSE))
- **Platform:** desktop builds target macOS and x64 Linux, not Windows; tmux is required for continuity. A Windows-first ADE would need WSL/Linux Server Edition or its own Windows session host. The mobile app is iOS-only. ([Installation](https://nodeterm.dev/docs/get-started/installation/), [Mobile companion](https://nodeterm.dev/docs/remote/mobile-companion/))
- **Security blast radius:** the web client can type into shells and read/write files, so compromise is equivalent to the host user. Do not expose it directly. Single-password auth has no roles or least-privilege boundary. Proxy-header SSO is safe only when the proxy is the sole trusted peer and strips/overwrites the asserted header. ([Server Edition](https://nodeterm.dev/docs/remote/server-edition/), [detailed security model](https://github.com/eneskirca/nodeterm/blob/main/docs/SERVER.md))
- **Recovery fidelity:** tmux protects app restarts, not machine/container restarts. Agent-native resume behavior and stored scrollback reconstruct continuity but can diverge from the pre-crash working tree/process state.
- **Agent asymmetry:** the common denominator is terminal + resume + coarse status. Advanced orchestration currently leans heavily on Claude-specific hooks and SDK features; ADE should not bake those into its domain model.
- **Repository intrusion:** project layout in `.nodeterm/project.json` and Context Link additions to `AGENTS.md`/`GEMINI.md` are convenient but mix tool metadata with project/vault content. ADE should make such writes explicit and provide a non-mutating runtime-context path.
- **Fast churn:** current release cadence is daily and official pages can lag shipped behavior. Pin versions and protocol contracts; do not depend on undocumented bridge messages without compatibility tests. ([Releases](https://nodeterm.dev/releases))

## Recommendation for the MVP specification

Use NodeTerm as a **reference implementation and optional prototype host**, not yet as ADE's foundational codebase. Define ADE around bounded, independently resumable sessions and a separate personal-vault knowledge service. Prototype one local/WSL or Linux tmux-backed session, normalized Codex/Claude lifecycle events, and a phone-friendly browser view reachable only through a private network. Validate that workflow before deciding whether to adapt NodeTerm's source or replace the prototype with an ADE-owned session host.
