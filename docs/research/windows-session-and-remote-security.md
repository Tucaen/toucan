# Windows session adapter and secure remote-control boundary

Research date: 2026-08-09. Sources are current first-party documentation from OpenAI, Anthropic, Microsoft, Tailscale, NIST, and W3C. Statements marked **Inference** or **Unknown** are not vendor guarantees.

## Executive conclusion

ADE should be a native Windows control plane that owns session metadata, policy, authentication, and audit state. It should supervise provider runtimes through narrow adapters:

- Codex: one ADE-managed `codex app-server` process per execution environment, using local `stdio` rather than exposing its experimental WebSocket transport.
- Claude: the Claude Agent SDK for ADE-created sessions; CLI/VS Code session resume as a bounded compatibility path.
- Execution environment: native PowerShell/Windows sandbox by default, with WSL2 selected per project when Linux-native tooling or Linux CI parity is the real requirement.

Phone access should be an HTTPS web UI reachable only through Tailscale Serve. The application backend remains bound to `127.0.0.1`, tailnet grants admit only the owner's enrolled devices, and ADE still performs its own passkey authentication. A fresh WebAuthn assertion with user verification is required for each high-risk approval. Tailscale identity is network admission and identity context; it is not a substitute for application authentication or confirmation of present intent.

## Codex App Server: supported session boundary

App Server is the structured integration surface behind rich Codex clients such as the VS Code extension. It exposes authentication, conversation history, approvals, and streamed events over a JSON-RPC protocol. [`thread/list` lists stored threads, `thread/read` returns stored history without loading it, and `thread/resume` reloads a thread so later turns append to it](https://learn.chatgpt.com/docs/app-server#manage-threads).

| Session source | List/read/resume through App Server | Evidence and qualification |
|---|---|---|
| Codex CLI | **Confirmed** for locally stored threads | `thread/list.sourceKinds` explicitly includes `cli`; omitting the filter defaults to CLI and VS Code threads. [App Server thread listing](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination-and-filters) |
| Codex VS Code extension | **Confirmed** for locally stored threads | `sourceKinds` explicitly includes `vscode`, and OpenAI says App Server powers the VS Code extension. [App Server overview](https://learn.chatgpt.com/docs/app-server), [source kinds](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination-and-filters) |
| Codex/ChatGPT Windows desktop task | **Unknown** | The documented source kinds are `cli`, `vscode`, `exec`, `appServer`, subagent variants, and `unknown`; there is no documented `desktop` kind or promise that a separately launched App Server discovers the desktop process's store. This must be tested against the installed desktop build. Absence from the contract is not proof that it cannot work. |
| Codex cloud task | **Not established by this API** | App Server documents stored local thread logs, not an account-wide cloud-task discovery API. Treat cloud execution as a separate adapter until OpenAI documents a shared contract. |

### Local persistence is not account/cloud synchronization

App Server calls a stored thread's backing artifact a persisted JSONL log on disk; archiving moves that file into an archived-sessions directory. [App Server archiving](https://learn.chatgpt.com/docs/app-server#archive-a-thread). This proves local persistence and resumability for the App Server's visible store. It does **not** prove that every conversation signed into the same OpenAI account is synchronized to that store or remotely controllable.

**Inference:** ADE should index `(provider, environment, store, thread_id)` rather than treating an OpenAI account ID as the session locator. Native Windows, each WSL distribution, and cloud execution may have different stores even when they use the same account.

**Unknown:** Whether current Windows desktop tasks appear as `appServer` or `unknown`, whether a second process may resume a thread still owned by the desktop app, and how concurrent ownership is arbitrated. The MVP needs a compatibility probe: create one CLI, VS Code, and desktop thread; list/read/resume from the ADE App Server; then test concurrent resume without allowing file changes.

### Safe Codex adapter shape

Use App Server's default `stdio` transport as a private child-process channel. Do not place the raw App Server listener on the tailnet or internet. OpenAI labels the App Server command and WebSocket transport experimental and unsupported for production; it also warns that non-loopback WebSocket listeners currently permit unauthenticated connections unless authentication is configured. [App Server transports and WebSocket warning](https://learn.chatgpt.com/docs/app-server#protocol).

ADE should serialize ownership of a resumed thread, translate provider approval events into its policy engine, and persist only its own normalized index and audit records. Provider transcripts remain provider-owned data.

### Codex's native Remote is a separate, confirmed phone path

OpenAI now provides Codex Remote through the ChatGPT mobile app for a connected Mac or Windows PC. It can show existing work on that computer, start or continue tasks, send instructions, answer approval requests, and review files, diffs, and results while execution stays on the connected computer. Setup and pairing happen through the ChatGPT desktop app and require the same account/workspace. [Codex Remote](https://learn.chatgpt.com/docs/remote).

This confirms that OpenAI's own desktop and mobile products have a remote-control route. It does **not** expand the documented third-party App Server contract or prove that ADE can attach to the desktop app's child process/store. Treat Codex Remote as an optional provider-native alternative, not as ADE's cross-provider session API. Its availability also depends on rollout and workspace settings.

## Claude Code and VS Code: external control boundary

Claude Code saves CLI conversations continuously as local transcripts and supports `--continue`, `--resume <name|id>`, session branching, and structured non-interactive follow-ups through `claude -p --resume`. Anthropic warns that the JSONL schema is internal and may change, so ADE should use supported CLI/SDK interfaces rather than parse transcript files as a database. [Claude Code session management and script interfaces](https://code.claude.com/docs/en/sessions#access-conversations-from-scripts), [transcript storage](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).

The VS Code extension and standalone CLI share conversation history. External tooling can invoke `vscode://anthropic.claude-code/open`, optionally providing a workspace-local session ID and a prefilled prompt; the prompt is deliberately not auto-submitted. [Claude VS Code URI handler](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools), [shared extension/CLI history](https://code.claude.com/docs/en/vs-code#switch-between-extension-and-cli).

This is enough to locate/resume a known local session and focus it in VS Code, but it is **not** a documented third-party API for enumerating, reading, sending to, approving, and stopping every already-open VS Code panel.

For ADE-created sessions, the Claude Agent SDK is the clean integration boundary. It exposes session IDs, continue/resume/fork semantics, streamed messages, and approval handling; a session persists conversation history, not the filesystem. [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions). Its `SessionStore` can mirror sessions to ADE-controlled S3, Redis, or a database for cross-host resume, although local JSONL remains the default. [Agent SDK external session storage](https://code.claude.com/docs/en/agent-sdk/session-storage).

Concurrency matters: Anthropic documents that resuming the same session in two terminals without forking interleaves both writers into one transcript. ADE therefore needs an exclusive session lease or must fork before a second writer starts. [Claude session branching and concurrent resume](https://code.claude.com/docs/en/sessions#branch-a-session).

### Claude's native Remote Control is a separate option

Claude Code Remote Control already supports steering a local CLI or VS Code session from Claude's mobile apps or browser. The local process makes outbound HTTPS connections and opens no inbound port; execution and filesystem access stay local. However, while connected, the transcript and tool activity are stored on Anthropic servers for synchronization and reconnection. [Remote Control connection and security](https://code.claude.com/docs/en/remote-control#connection-and-security).

Therefore:

- It is a valid optional provider-native phone path for users who accept Anthropic-hosted transcript sync.
- It is not ADE's local-first tailnet path and cannot implement ADE-wide policy consistently across providers.
- Anthropic's Trusted Devices feature is a useful precedent for device enrollment plus recent biometric/passkey confirmation, but it is currently a Team/Enterprise beta and applies to Claude Remote Control, not ADE. [Claude Trusted Devices](https://code.claude.com/docs/en/remote-control#trusted-devices).

## Native Windows versus WSL2

OpenAI officially supports Codex natively in the Windows desktop app, CLI, and IDE extension. The preferred native `elevated` sandbox uses lower-privilege users, filesystem boundaries, firewall rules, and local policy; the `unelevated` fallback is weaker. OpenAI recommends native Windows by default and WSL2 when Linux-native tooling is needed, the workflow already lives in WSL2, or the native sandbox is unsuitable. [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox).

In WSL2, Codex runs in Linux and uses the Linux `bubblewrap` sandbox. OpenAI no longer supports WSL1 and recommends storing WSL projects under the Linux home directory instead of `/mnt/c` for performance and fewer permission/symlink problems. [Codex on WSL](https://learn.chatgpt.com/docs/windows/wsl). Microsoft describes WSL2 as a real Linux kernel inside a managed lightweight VM and likewise recommends keeping files in the same operating-system filesystem as the tools using them. [Microsoft WSL comparison](https://learn.microsoft.com/en-us/windows/wsl/compare-versions), [cross-filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems#file-storage-and-performance-across-file-systems).

Recommended split:

| Concern | Native Windows | WSL2 |
|---|---|---|
| ADE control plane, database, browser backend, Tailscale integration | **Default and authoritative** | Do not require it for the control plane |
| PowerShell/.NET/Windows repos and native desktop tooling | **Default** | Only by explicit project need |
| Bash/tmux/Linux containers/Linux CI parity | Possible but less natural | **Preferred** |
| Worktree location | NTFS Windows path | Linux filesystem such as `~/code`, not `/mnt/c` |
| Codex containment | Preferred Windows elevated sandbox | Linux `bubblewrap` inside WSL2 |

**Inference:** Model `ExecutionEnvironment` as a first-class session attribute (`windows-native` or `wsl:<distro>`), start the provider adapter inside that environment, and never let Windows and WSL processes mutate the same worktree concurrently. ADE may show both stores in one UI, but must not assume they are one filesystem or one transcript store.

## Minimum safe tailnet-only web architecture

```text
owner phone/browser (enrolled Tailscale node)
  -> tailnet grant: owner + approved device/posture -> ADE host:443 only
  -> Tailscale Serve: private HTTPS, never Funnel
  -> ADE backend on 127.0.0.1 only
  -> owner allowlist + passkey login + secure app session + CSRF defense
  -> policy/approval broker + append-only audit
  -> local session adapters (Codex stdio / Claude Agent SDK)
  -> sandboxed Windows or WSL2 worktree
```

### 1. Private network and device identity

Tailscale Serve proxies a private tailnet HTTPS name to a localhost service; Tailscale explicitly distinguishes this from public Funnel, and normal tailnet access controls still apply. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). Use deny-by-default grants restricted to the owner's user identity and approved devices, optionally requiring device posture. [Tailscale grants](https://tailscale.com/docs/features/access-control/grants). Tailscale node identity is cryptographically bound to the device through node keys. [Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity).

Disable Funnel for the host, do not forward router ports, and do not expose SSH in the MVP. Raw SSH would bypass ADE's policy and approval broker.

### 2. Trusted reverse-proxy hop

Serve strips spoofed incoming identity headers and adds `Tailscale-User-Login`, name, and profile data for tailnet traffic. Tailscale warns that a backend trusting these headers must listen only on localhost, otherwise direct callers can forge them. [Serve identity headers and localhost requirement](https://tailscale.com/docs/features/tailscale-serve#identity-headers).

ADE should allowlist exactly the owner's Tailscale login at this hop. **Important limitation:** shared external users may also receive identity headers, tagged nodes do not receive user headers, and a malicious process already running on the ADE host can still call localhost. Tailnet identity reduces remote reachability; it does not defend against local compromise.

### 3. Independent application authentication

After the proxy identity check, require an ADE passkey login and issue a short-lived opaque application session. Use an HTTPS-only, `HttpOnly`, `SameSite=Strict` (or justified `Lax`), `__Host-` cookie; never place the session secret in browser local storage; protect state-changing requests against CSRF; implement idle and absolute timeouts plus explicit logout and local device/session revocation. These controls follow NIST's current session guidance. [NIST session management](https://pages.nist.gov/800-63-4/sp800-63b/session/).

This second layer protects against an accidentally over-broad tailnet grant, a shared node, and confusion between network presence and an authenticated ADE browser session.

### 4. Fresh approval reauthentication

For a high-risk action, require a new WebAuthn assertion with `userVerification: "required"`; WebAuthn reports verified user presence through the signed assertion without disclosing the biometric to ADE. [WebAuthn user verification](https://www.w3.org/TR/webauthn-3/#sctn-user-verification).

**Inference/design requirement:** the server-generated one-time challenge should be bound to a canonical approval record containing the exact capability, normalized target, provider session, worktree, action digest, expiry, and nonce. On success, issue a single-use approval token for only that record. Do not interpret an existing app cookie, access token, or Tailscale identity as current human presence; NIST explicitly distinguishes token possession from subscriber presence and requires reauthentication to confirm continued presence. [NIST reauthentication](https://pages.nist.gov/800-63-4/sp800-63b/session/#reauthentication).

Suggested policy outcomes:

- `ALLOW`: read-only and bounded writes inside the assigned worktree.
- `CONFIRM`: exact remote deletion, history rewrite, merge/publish, credential use, privilege escalation, or escape from the normal sandbox; fresh passkey verification required.
- `DENY_REMOTE`: catastrophic host-wide operations, disabling ADE security, arbitrary unrestricted shell, or changing the tailnet/app-auth boundary. A narrowly defined local Windows break-glass flow may exist and must be audited.

## ADE-owned session adapter contract

The UI should consume one provider-neutral contract while retaining capability flags instead of pretending every vendor is equivalent:

```text
discover(filter) -> SessionSummary[]
read(id, cursor) -> normalized events + provider references
start(spec) / resume(id, lease) / fork(id)
send(id, message, idempotency_key)
stream(id) -> message | tool | approval | status events
decide(approval_id, normalized_decision)
interrupt(id) / archive(id)
capabilities() + health() + environment()
```

Required invariants:

1. One active writer lease per provider session; fork rather than interleave.
2. Every session has an explicit execution environment, worktree, authority profile, and provider store.
3. Provider events are translated into ADE policy decisions before remote approval is possible.
4. Unknown liveness or unsupported control remains `unknown`; never infer `idle` or `complete` from a quiet transcript.
5. Raw provider transports stay local. Only ADE's authenticated API crosses Tailscale Serve.
6. A lost-device kill switch revokes ADE app sessions/passkeys, removes the Tailscale node, cancels pending approvals, and can pause managed sessions.

## Confirmed facts, unknowns, and MVP probes

| Item | Status | MVP action |
|---|---|---|
| List/read/resume local Codex CLI and VS Code threads | **Confirmed contract** | Build against App Server and fixture-test pagination, history, events, and approvals. |
| Discover/resume Windows desktop tasks from an independent App Server | **Unknown** | Run a version-pinned compatibility probe; do not promise this in the MVP until it passes. |
| OpenAI-account-wide synchronization of local App Server JSONL | **Not documented** | Keep local store identity explicit; design cloud as a separate adapter. |
| Resume known Claude CLI/VS Code sessions | **Confirmed, with limits** | Use supported CLI/URI routes; lock writers. Do not parse internal JSONL. |
| Full third-party control of every open Claude VS Code panel | **Not documented** | Prefer Agent SDK sessions for ADE-managed work. Treat URI launch/focus as convenience only. |
| Claude phone continuation | **Confirmed provider feature** | Offer as opt-in and disclose that connected transcripts are stored by Anthropic. |
| Tailnet-only HTTPS to localhost | **Confirmed pattern** | Automated startup check must fail closed if Funnel/public binding is enabled or backend is not loopback-only. |
| Passkey approval bound to an exact action | **ADE design inference** | Threat-model and integration-test replay, expiry, CSRF, concurrent approvals, device revocation, and lost-phone recovery. |

## Bottom line

The viable Windows-first ADE is not a universal terminal multiplexer. It is a durable policy and session control plane with honest provider adapters. Codex App Server gives strong local CLI/VS Code lifecycle control; Claude Agent SDK gives a clean boundary for sessions ADE creates; existing desktop/panel takeover remains capability-gated and explicitly uncertain. Mobile access is safe enough for personal use only when the public internet is excluded, the backend is loopback-only, tailnet identity and ADE authentication are separate layers, and dangerous approvals require fresh action-bound user verification.
