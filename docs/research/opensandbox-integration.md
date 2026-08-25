# OpenSandbox integration assessment for ADE

Research date: 2026-08-15

## Executive answer

**Yes, OpenSandbox could be useful in ADE, and integration is technically feasible.** Its best role is an optional execution substrate for untrusted commands, disposable development environments, browser/desktop sandboxes, and eventually remote or Kubernetes-backed jobs. It should not replace ADE's ACP conversation transport, FirstMate lifecycle, or ordinary local terminals.

The clean integration boundary is ADE's Electron main process. OpenSandbox exposes a REST lifecycle service plus per-sandbox execution APIs, and publishes a Node-compatible TypeScript SDK (`@alibaba-group/opensandbox`). ADE can therefore keep the renderer behind a narrow preload API and add a main-process `SandboxJobRuntime` adapter in the same spirit as its existing `TerminalManager` and `FirstMateRuntime` boundaries. [OpenSandbox JavaScript/TypeScript SDK](https://github.com/opensandbox-group/OpenSandbox/tree/main/sdks/sandbox/javascript), [OpenSandbox API specifications](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/api/index.md)

The recommended path is a bounded spike, not a foundational rewrite:

1. Run an externally managed OpenSandbox server locally in WSL2 with a Docker backend.
2. Add one ADE-owned adapter in the Electron main process using the TypeScript SDK or generated OpenAPI client.
3. Prototype a distinct **Sandbox terminal/job** node that creates a sandbox, uploads or safely mounts a workspace, streams execution, and deletes it.
4. Keep the current local `node-pty` terminals and ACP chat nodes unchanged.
5. Evaluate gVisor or Kata separately before claiming that arbitrary agent-generated code is strongly isolated.

This gives ADE a real benefit without binding its durable conversations and project registration model to a young infrastructure project.

## What OpenSandbox is

OpenSandbox is a client/control-plane/data-plane system rather than a single sandbox library:

- Client surface: language SDKs, the `osb` CLI, and an MCP server.
- Contract surface: OpenAPI definitions for lifecycle, diagnostics, in-sandbox execution, and egress.
- Control plane: a Python/FastAPI server that authenticates lifecycle requests and delegates to one configured runtime backend.
- Runtime plane: Docker for local/single-host use or Kubernetes through BatchSandbox or `kubernetes-sigs/agent-sandbox` providers.
- Data plane: the user's workload plus an injected `execd` daemon for commands, PTYs, files, code contexts, and metrics; optional ingress and egress components handle connectivity and policy.

The repository's architecture document explicitly treats the OpenAPI specs as the public contract and separates the lifecycle server from the in-sandbox `execd` service. [Architecture](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md), [repository structure](https://github.com/opensandbox-group/OpenSandbox#project-structure)

### Runtime model

A client creates a sandbox from an OCI image or snapshot, with an entrypoint, TTL, CPU/memory/GPU limits, environment, metadata, volumes, network policy, and optional extensions. The server provisions it synchronously through Docker or Kubernetes, while SDK readiness helpers wait until the workload and execution daemon are usable. Lifecycle operations cover create/list/get/delete, expiration renewal, endpoints, metadata, snapshots, pause, and resume. [Lifecycle API](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/api/index.md#1-sandbox-lifecycleyml), [server documentation](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/server.md)

Inside the sandbox, `execd` provides:

- command execution and interruption with SSE output;
- background commands and incremental logs;
- persistent Bash sessions;
- interactive PTY sessions over WebSocket;
- file/directory CRUD and upload/download;
- stateful code execution through Jupyter-backed contexts;
- CPU/memory metrics and streaming metrics.

The published OpenAPI specification documents commands, sessions, filesystem operations, metrics, and token authentication. The interactive PTY endpoints exist in the implementation/architecture but are not part of the core API summary and should be treated as a surface to verify during a spike. [Execd API summary](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/api/index.md#3-execd-apiyaml), [architecture: execd](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md#51-execd)

### APIs and SDKs

The low-level Sandbox SDK exists for Python, Java/Kotlin, JavaScript/TypeScript, C#/.NET, and Go. A higher-level Code Interpreter SDK exists for several languages, and a Python MCP server exposes sandbox creation, command execution, and text file operations to MCP clients. [SDK list](https://github.com/opensandbox-group/OpenSandbox#documentation), [MCP server](https://github.com/opensandbox-group/OpenSandbox/tree/main/sdks/mcp/sandbox/python)

The TypeScript SDK is the natural ADE dependency. It supports lifecycle, command streaming, file operations, endpoints, volumes, network-policy updates, a credential vault, and sandbox administration. It is ESM with CJS exports, targets Node 20+, depends on `openapi-fetch` and `undici`, and is browser-capable except for true streaming multipart uploads. Its current package name still carries the Alibaba scope. [TypeScript SDK README](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/README.md), [package manifest](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/package.json)

For ADE, the SDK belongs in the main process, not the renderer. That keeps the server API key and sandbox access tokens out of renderer state, avoids browser upload limitations, and preserves ADE's context-isolated preload design.

## Deployment and platform compatibility

### Local Docker

The documented local requirements are Python 3.10+ and Docker Engine 20.10+. The server supports Linux, macOS, and **Windows through WSL2**; Windows is not documented as a native server or Windows-container sandbox target. [Server requirements](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/server.md#requirements)

Docker runtime configuration includes host, bridge, or custom networks, capability dropping, `no-new-privileges`, seccomp/AppArmor selection, PID limits, bind mounts, and a configurable host-port range. Network-policy sandboxes require bridge mode and an egress sidecar. Host bind mounts are rejected by default until the operator configures allowed host-path prefixes. [Server configuration](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)

**Inference for ADE:** local use is practical because ADE already provisions and talks to Ubuntu via `wsl.exe`. However, OpenSandbox adds prerequisites ADE does not currently install: Python/`uv`, Docker access, OCI images, configuration, and a long-running server. The cleaner first version is for ADE to connect to an explicitly configured external service, even if that service runs in the user's Ubuntu WSL distribution. ADE should not silently make Docker part of FirstMate setup.

### Windows and WSL

OpenSandbox can be controlled from ADE on Windows, but its built-in workloads are presently Linux containers. A repository issue requesting first-class Windows guest sandboxes describes the current server as runnable on Windows through WSL2 and the built-in images as Linux-targeted; it was closed in favor of a tracking issue, not because Windows guests already exist. [Windows runtime request](https://github.com/opensandbox-group/OpenSandbox/issues/438)

Consequences for ADE:

- Linux builds, tests, CLIs, browsers, and code-interpreter workloads are a good fit.
- Windows-only binaries, PowerShell/Win32 automation, Windows installers, and native Windows test environments are not.
- A Windows checkout exposed to WSL at `/mnt/<drive>/...` may be bind-mounted only if the Docker deployment can resolve the same host path. The exact mapping depends on whether Docker Engine runs inside WSL or Docker Desktop supplies it and must be tested in the intended deployment.
- Copy/upload or a Docker named volume is safer and more portable than exposing the live checkout. A host bind gives sandboxed code direct access to whatever host files the mount permits, which weakens the value of the sandbox. OpenSandbox's volume proposal calls out host-path exposure as a security risk. [Volume OSEP](https://github.com/opensandbox-group/OpenSandbox/blob/main/oseps/0003-volume-and-volumebinding-support.md)

### Kubernetes

Kubernetes 1.21.1+ is supported. The server can use its own BatchSandbox controller or the `kubernetes-sigs/agent-sandbox` CRD provider. Helm charts cover the controller, server, ingress gateway, pooling, batch delivery, and pause/resume. [Kubernetes controller chart](https://github.com/opensandbox-group/OpenSandbox/tree/main/kubernetes/charts/opensandbox-controller), [server Kubernetes configuration](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md#kubernetes--only-when-runtimetype--kubernetes)

Kubernetes is strategically interesting for a future ADE remote-execution/team mode, but it is much too operationally heavy for the default Windows desktop path. It also introduces ingress, TLS, API-key distribution, namespace/tenant isolation, image registry, storage, and cluster-runtime concerns that ADE does not currently own.

## Isolation and security

OpenSandbox provides useful controls, but **the default Docker/runc configuration must not be described as hardware isolation**.

### Isolation levels

- Default `runc`: standard process/container isolation sharing the host/VM kernel.
- gVisor: additional syscall/kernel boundary through `runsc`.
- Kata Containers: a VM-backed sandbox using QEMU.
- Kata + Firecracker: Kubernetes only.

Secure runtimes are administrator-wide settings, validated when the server starts, and must already be installed in Docker/containerd; OpenSandbox does not install them. The project recommends gVisor for a security/performance balance and Kata for unknown code. [Secure container runtime guide](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md)

For ADE's stated use case—agent-generated commands against user projects—the choice matters. A plain container is still useful for dependency isolation and cleanup, but gVisor/Kata is the appropriate evaluation target before positioning this as a security boundary.

### Authentication and endpoint exposure

The lifecycle server supports a single API key via `OPEN-SANDBOX-API-KEY`. If no key is configured, startup requires an explicit insecure-mode acknowledgment. The server docs recommend enabling the key in production. `execd` separately supports `X-EXECD-ACCESS-TOKEN`, while secured external service endpoints are presently limited to Kubernetes gateway mode. [Server authentication](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/server.md#api-authentication), [API authentication](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/api/index.md)

**Inference for ADE:** for local Docker, bind the lifecycle server to loopback, require an API key, retain secrets in the main process/OS-protected configuration, and never expose direct sandbox ports beyond the host unless there is a reviewed proxy/TLS design. The one-server-key model is adequate for a single-user local service but is not a complete multi-user authorization system.

### Network controls and credentials

The optional egress sidecar provides FQDN/wildcard/IP/CIDR rules, DNS filtering, optional nftables enforcement, and an experimental transparent HTTPS interception/credential-injection mode. Strict IP/CIDR enforcement requires `dns+nft`; the default DNS mode does not enforce static IP/CIDR targets. IPv6 coverage is incomplete and disabled by default. The sidecar requires a Linux kernel and `CAP_NET_ADMIN`, and it conflicts with transparent service-mesh sidecars. [Egress component](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/egress.md), [egress configuration](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md#egress)

The Credential Vault can keep real outbound credentials out of sandbox environment variables/files and inject them only into matching HTTPS requests, but it relies on the experimental transparent MITM path and stores credentials in memory. It is promising for remote/shared deployments, not a reason to hand agent credentials to an early local prototype. [Credential Vault](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/credential-vault.md)

### Workspace safety

ADE's project registration rules say that selecting/registering a checkout is read-only and writes require separate authorization. An OpenSandbox integration must preserve that policy explicitly:

- creating or uploading a disposable copy is not the same as authorizing writes to the user's checkout;
- a read-only host mount can support analysis, but write-back should be an explicit import/apply operation;
- a read-write bind mount should be treated as direct checkout write authorization, not as harmless sandbox setup;
- mounting Docker sockets, WSL home directories, agent credential homes, or ADE/FirstMate private data into the sandbox should be prohibited.

## Fit with ADE's current architecture

ADE is a Windows-first Electron/TypeScript application with three relevant boundaries:

- `src/main/terminal-manager.ts` abstracts a bidirectional terminal process (`onData`, `write`, `resize`, `kill`) and sends events through Electron IPC.
- `src/main/acp-session-manager.ts` owns provider-neutral ACP conversations over child-process stdio.
- `src/main/firstmate-runtime.ts` owns the Windows-to-WSL bridge, private FirstMate home, and managed ACP launch environment; see `AGENTS.md` for lifecycle-projection ownership.

These boundaries make OpenSandbox feasible, but they also show where it does **not** fit.

### Strong integration seams

#### 1. A distinct sandbox node or job

This is the strongest product seam. A `SandboxJobRuntime` in the Electron main process could own instance creation/deletion, workspace transfer, streamed execution, selected artifact export, and cleanup. The renderer would receive only ADE-owned DTOs through preload.

For an xterm-like experience, OpenSandbox's PTY WebSocket can potentially back the existing terminal interaction model. Because PTY support is less prominent than the stable command/file SDK surface—and an ingress header bug has existed around PTY WebSockets—it needs an explicit compatibility test before ADE relies on it. [Interactive PTY architecture](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md#51-execd), [PTY ingress issue](https://github.com/opensandbox-group/OpenSandbox/issues/1050)

An initial **job console** using command SSE is lower-risk than a fully interactive terminal: run command, stream output, cancel, inspect files/diff, and export selected changes.

#### 2. An agent-accessible sandbox tool

OpenSandbox publishes an MCP server, and the repository demonstrates running Codex CLI inside a sandbox. This supports two experiments:

- expose OpenSandbox as an MCP tool to ADE-hosted agents, leaving the agent/ACP process on the host; or
- run an agent CLI inside the sandbox when the user explicitly selects an isolated execution mode.

The first is architecturally smaller. The second complicates authentication, durable provider sessions, project sync, ACP adapter launch, and resume behavior. [OpenSandbox MCP](https://github.com/opensandbox-group/OpenSandbox/tree/main/sdks/mcp/sandbox/python), [Codex CLI example](https://github.com/opensandbox-group/OpenSandbox/tree/main/examples/codex-cli)

#### 3. A remote runtime implementation

ADE's README already identifies its narrow preload API as a seam that could replace local IPC with remote transport. OpenSandbox's backend-neutral lifecycle/exec contracts fit that future direction. A later ADE `ExecutionTarget` could select local PTY, local OpenSandbox, or a remote OpenSandbox service while the canvas remains unchanged.

### Poor integration seams

- **Replacing ACP:** OpenSandbox is not a conversation protocol. ADE should keep ACP for chat, models, approvals, authentication, plans, and worklog events.
- **Replacing FirstMate's lifecycle:** FirstMate's durable tasks, captain conversation, external-project identity, and validator lifecycle are not supplied by OpenSandbox.
- **Automatically sandboxing every terminal:** ordinary shells need instant startup, native Windows tools, full interactive fidelity, and direct project access. Making Docker/WSL mandatory would regress ADE's foundation.
- **Mounting FirstMate's private home into sandboxes:** this would expose durable task state and credentials across a boundary intended to protect them.

### Possible later seam: a FirstMate crew backend

OpenSandbox could eventually host disposable FirstMate **crewmates** while the captain conversation and durable FirstMate lifecycle remain where they are. This is potentially valuable: each task could receive a bounded image, resources, network policy, workspace copy, and TTL, while ADE continues to observe FirstMate's existing task records.

It is not an ADE-only switch today. ADE provisions `FM_BACKEND=tmux`, exposes `backend: 'tmux'` in its runtime status type, and renders tmux explicitly (`src/main/firstmate-runtime.ts`, `src/shared/firstmate.ts`, and `src/renderer/src/FirstMatePanel.tsx`). FirstMate's runtime-backend interface owns endpoint creation, capture, text/key sends, current-path discovery, liveness, and teardown; unknown backend names fail rather than falling back. An `opensandbox` adapter therefore belongs primarily in FirstMate, with ADE subsequently adding selection, setup/status, and presentation support. [FirstMate runtime backend architecture](https://github.com/kunchenguid/firstmate/blob/main/docs/architecture.md#runtime-session-backends)

That adapter would also have to preserve FirstMate's worktree/PR semantics and semantic worker-state evidence. A remote sandbox clone is a better security fit than mounting ADE's live checkout, but it makes local-only projects and uncommitted changes an explicit transfer/write-back problem. This should follow, not precede, an ADE-native job-console spike.

## Integration shapes compared

| Shape | ADE change | Benefit | Main risk | Recommendation |
|---|---|---|---|---|
| Agent MCP tool | Configure/run OpenSandbox MCP and expose it to selected agents | Fast proof that agents benefit from disposable execution | Provider-specific MCP config; less ADE-native lifecycle/UI | Useful first experiment |
| Main-process TypeScript SDK + job node | Add `SandboxJobRuntime`, preload DTOs, and a new canvas node | Clean native UX; command/file/lifecycle control | SDK/API churn and server setup | **Best product spike** |
| PTY-backed sandbox terminal | Adapt WebSocket PTY to `TerminalProcess`-like interface | Familiar interactive shell in a sandbox | PTY endpoint maturity, resize/auth/proxy behavior | Second phase after job console |
| Run ACP adapter/agent inside sandbox | Custom agent image and remote stdio/bridge | Stronger containment of the agent process itself | Credentials, resume, ACP transport, workspace sync, image lifecycle | Defer |
| OpenSandbox FirstMate crew backend | Add a verified backend adapter to FirstMate; keep its captain/lifecycle | Isolated disposable crewmates per task | Cross-project change; worktree, state, transport, and write-back semantics | Plausible later phase |
| Replace FirstMate lifecycle | Rebuild durable lifecycle on OpenSandbox | Little unique benefit | Loses FirstMate semantics; major rewrite | Do not pursue |
| Kubernetes remote execution | Connect ADE to a managed cluster service | Scale, stronger runtime options, team workloads | Large operations/security surface | Future/server product only |

## Licensing and maturity

### License

The repository and published JavaScript package are Apache License 2.0. Integration and redistribution are commercially permissive provided ADE preserves the required notices and observes the license terms. Container images and bundled third-party tools still need an artifact-level license inventory; an Apache-licensed orchestrator does not relicense arbitrary sandbox images, CLIs, or model artifacts. [OpenSandbox license](https://github.com/opensandbox-group/OpenSandbox/blob/main/LICENSE), [JavaScript SDK package manifest](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/package.json)

### Maturity signals

Positive signals:

- Active multi-component releases and signed artifacts; as of this assessment the releases page includes server `0.2.2`, JavaScript SDK `0.1.11`, execd `1.0.22`, and egress `1.1.6`.
- Published SDKs across several languages, OpenAPI contracts, end-to-end tests, Helm deployment, security reporting, and release verification.
- A sizable public community (about 13,000 stars and 1,100 forks at the research date).
- Docker and Kubernetes are documented as production-ready by the server documentation.

[Releases](https://github.com/opensandbox-group/OpenSandbox/releases), [security policy](https://github.com/opensandbox-group/OpenSandbox/blob/main/SECURITY.md), [server documentation](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/server.md)

Caution signals:

- The server is `0.2.x`, JavaScript/Python/C# SDKs are `0.1.x`, and the server's own PyPI metadata classifies it as **Alpha** even though the docs call the runtime backends production-ready.
- The roadmap labels several central areas “implementing” or “implemented / maturing,” including persistent volumes, pause/resume, secure runtimes, secure endpoint access, SDK parity, and observability.
- The project supports security fixes only on the latest release and `main`, which implies ADE must keep pace rather than pinning indefinitely.
- Public contract/docs and implementation have had recent alignment fixes; pinning exact component versions and running ADE-owned contract tests is necessary.

[Server package metadata](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/pyproject.toml), [roadmap](https://github.com/opensandbox-group/OpenSandbox/blob/main/ROADMAP.md), [supported security versions](https://github.com/opensandbox-group/OpenSandbox/blob/main/SECURITY.md#supported-versions), [server 0.2.2 release notes](https://github.com/opensandbox-group/OpenSandbox/releases/tag/server/v0.2.2)

**Assessment:** promising and active, suitable for an optional experimental integration. It is not yet a dependency ADE should make mandatory for every user or trust without its own security and compatibility validation.

## Suggested spike

### Scope

Build a developer-only main-process prototype with no renderer polish beyond a basic control surface:

1. Connect to an already-running local OpenSandbox service at a configured loopback URL.
2. Verify health and report version/capabilities.
3. Create a pinned Linux image with 1 CPU, 1–2 GiB memory, a short TTL, and deny-by-default egress.
4. Upload a small disposable project copy rather than bind-mounting ADE's checkout.
5. Run a build/test command and stream output.
6. Cancel it, read an output artifact, and delete the sandbox.
7. Exercise process crash, server restart, expired TTL, denied network, corrupt image, and cleanup recovery.
8. Separately test the PTY WebSocket for create/input/output/resize/exit before designing a terminal node.

### Acceptance questions

- Does Docker + OpenSandbox start reliably through the intended WSL/Docker Desktop arrangement on a clean Windows machine?
- Can Electron's main process use the pinned SDK without packaging or CJS/ESM issues?
- Are SSE cancellation and PTY WebSocket behavior robust enough for ADE's UI?
- Can workspace upload/export preserve executable bits, symlinks, Git metadata, line endings, and large repositories acceptably?
- Does deny-by-default egress behave as expected against direct IPs, alternate DNS, IPv6, and package managers?
- Can every ADE-created sandbox be recovered or reaped after ADE/server crashes?
- What is cold-image and warm-image startup latency on representative Windows hardware?
- Does gVisor or Kata work in the chosen Windows/WSL deployment, or is strong isolation available only on a remote Linux/Kubernetes target?

### Seam to design first

Keep ADE's interface much smaller than OpenSandbox's SDK. For the first spike, one deep module should own service probing, sandbox creation, workspace transfer, policy/TTL defaults, streamed execution, selected artifact export, and guaranteed cleanup:

```ts
interface SandboxJobRuntime {
  probe(): Promise<SandboxCapabilities>
  run(request: SandboxJobRequest, observer: SandboxJobObserver): Promise<SandboxJobResult>
  cancel(jobId: string): Promise<void>
}
```

`SandboxJobRequest` should describe intent—workspace source, command, resource profile, network posture, timeout, and requested outputs—not OpenSandbox lifecycle calls. `run` should return only after the result and cleanup outcome are known. Pin the OpenSandbox dependency in one adapter behind this seam and use an in-memory adapter for interface-level tests. This contains package renames, API churn, backend differences, cleanup ordering, and a future replacement instead of reproducing OpenSandbox's surface across ADE callers.

If the spike proves interactive PTY value, add a separate terminal-session interface then. Do not force PTY lifecycle, job execution, and ACP transport into one shallow abstraction before they have two real adapters and verified common semantics.

## Decision

**Proceed with a small optional spike if ADE wants an isolated execution or remote-runtime feature.** OpenSandbox is unusually well aligned with ADE's TypeScript/Electron boundary and Windows-via-WSL posture, and it offers substantially more than raw Docker: lifecycle, streamed execution, files, PTYs, snapshots, network policy, credentials, SDKs, and a Kubernetes path.

Do not integrate it merely as “extra sandboxing” around existing ACP/FirstMate processes. The highest-value product is a clearly separate sandbox execution target with explicit workspace transfer and write-back. Start with a local Docker job console, preserve current local terminals and ACP conversations, and treat gVisor/Kata plus deny-by-default networking as separate requirements for any future security claim.
