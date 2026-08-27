# Lessons from FirstMate's Orca backend

Research date: 2026-08-24  
Upstream FirstMate snapshot: [`038d0f7`](https://github.com/kunchenguid/firstmate/tree/038d0f7ec6ba7238a151722931434dcf06ff37c4)

## Conclusion

Yes, ADE can learn from FirstMate's Orca backend. The valuable part is not the macOS integration or Orca CLI syntax; it is the explicit model of runtime authority, capabilities, durable identity, partial failure, and proof before cleanup.

ADE should reuse those ideas in its own typed contracts. It should not copy the shell adapter or introduce a generalized multi-backend framework before ADE has a second runtime provider.

## Lessons ranked by relevance

### 1. Separate logical identity from backend authority

FirstMate keeps the stable task alias (`window=fm-<id>`) separate from Orca's opaque terminal handle and worktree ID. Generic operations route through a backend adapter rather than assuming every endpoint is tmux.

For ADE, this sharpens the terminal identity work: a durable ADE session ID should be distinct from a process incarnation and any provider-owned handle. FirstMate task metadata should either reject non-tmux endpoints explicitly today or eventually expose a typed endpoint record rather than treating `window` as inherently tmux-shaped.

Sources: [backend router](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/fm-backend.sh), [Orca backend guide](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/docs/orca-backend.md).

### 2. Make destructive cleanup proof-carrying and fail closed

Before teardown, FirstMate validates exactly one value for each authority field, verifies the task binding, resolves the recorded Orca worktree ID through Orca, and confirms that the returned path matches the recorded path. Missing or mismatched evidence preserves metadata and refuses cleanup. It never substitutes raw directory deletion.

ADE already follows much of this discipline for pinned FirstMate projects and git worktree provenance. The additional lesson is to apply the same proof to terminal/process resources owned by a future persistent host.

Sources: [endpoint validation](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/fm-backend.sh), [teardown](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/fm-teardown.sh), [failure-path tests](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/tests/fm-backend-orca.test.sh).

### 3. Treat resource creation as a transaction with residual receipts

An Orca spawn can create a worktree, create or receive a terminal, and then fail later. FirstMate compensates by closing and releasing resources. If compensation fails, it persists the identities that remain so recovery is possible instead of silently orphaning them.

This should become an acceptance rule for ADE's persistent terminal owner: publish the durable ownership record before declaring success, compensate partial creation, and retain a recovery record when compensation cannot be proven.

Sources: [Orca adapter](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/backends/orca.sh), [spawn lifecycle](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/fm-spawn.sh).

### 4. Separate semantic lifecycle from transport observations

FirstMate treats the backend as an endpoint and capture source. It does not promote terminal text into authoritative worker state. Unreadable or ambiguous observations remain unknown; only proven states authorize recovery.

ADE should preserve ACP and FirstMate lifecycle events as the semantic authority. Terminal liveness should report `unverifiable` when evidence is absent rather than inferring completion from transport loss or terminal text.

Source: [backend contract](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/fm-backend.sh).

### 5. Model capabilities and refuse unsupported operations

FirstMate does not simulate parity between tmux and Orca. Orca lacks verified Escape delivery, native busy state, recovery-grade agent state, and secondmate support, so those operations remain unsupported or unknown.

If ADE later supports multiple terminal owners, the provider contract should expose capabilities explicitly. The UI and lifecycle code should disable or refuse unsupported operations rather than guessing equivalents.

Sources: [backend contract](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/fm-backend.sh), [Orca adapter](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/backends/orca.sh).

### 6. Never silently change resource owners

Orca is explicit-only because it owns both terminal and worktree. If readiness or creation fails, FirstMate stops instead of falling back to tmux and creating resources under a different ownership model.

ADE should retain this invariant: selecting a provider binds the resource owner. A failed provider may be retried or changed explicitly, but an automatic fallback must not create a duplicate process, terminal, or worktree elsewhere.

Source: [FirstMate architecture](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/docs/architecture.md).

### 7. Accept only empirically verified protocol shapes

The adapter accepts response fields observed in a real Orca build and deliberately rejects plausible undocumented alternatives. Fake-CLI tests cover readiness, structured error responses, malformed success data, partial failure, exact command arguments, and cleanup refusal. A verification document records the real build used.

ADE should use the same discipline for any external runtime: typed parsers, fixture-driven contract tests, an opt-in live smoke, and an explicit compatibility record.

Sources: [Orca adapter](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/backends/orca.sh), [verification record](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/docs/verification/runtime-backends.md), [adapter tests](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/tests/fm-backend-orca.test.sh).

### 8. Keep operational reads narrow and bottom-anchored

For terminal prompt delivery, FirstMate types text once, retries only Enter, and checks a bounded live tail. It deliberately avoids paging backward into scrollback because stale UI content can be mistaken for the current composer.

This creates an important boundary for ADE's scrollback ticket: persisted history is for humans, while operational liveness or input-safety checks must use current, bounded evidence. ADE should continue to prefer ACP acknowledgements over terminal-screen inference wherever ACP is available.

Source: [Orca send and composer handling](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/bin/backends/orca.sh).

## Effect on the current ADE tickets

- **#71 stable terminal identity:** distinguish ADE session identity, process incarnation, provider handle, authority, and capabilities. Preserve `unverifiable` as a real state.
- **#75 terminal scrollback:** keep display history separate from the bounded live evidence used for operational decisions.
- **#76 terminal persistence and reattachment:** require transactional creation, residual recovery receipts, exact-owner reattachment, explicit capabilities, and no silent fallback or duplicate spawn.
- **#69 task history:** record the evidence source and uncertainty of transitions rather than deriving semantic completion from terminal observations.

These additions fit the existing tickets. They do not justify a separate generic “backend framework” ticket yet.

## What not to copy

- macOS application paths, Homebrew setup, or Orca-specific readiness assumptions.
- Orca's exact CLI response shapes or forced worktree-removal policy.
- Terminal-screen classification where ADE has semantic ACP events.
- Shell-centric parsing; ADE should use typed TypeScript records and discriminated unions.
- FirstMate's backward-compatible “missing backend means tmux” rule for new ADE-owned records; ADE should use explicit schema versions.
- Orca's missing version/protocol marker. Readiness probing is a workaround, not the ideal interface.

## Architecture verdict

FirstMate's backend boundary is a genuinely useful deep seam: generic lifecycle code sees a small normalized operation set, while ownership, identifiers, readiness, capture formats, and cleanup mechanics remain local to the adapter.

The strongest improvement for ADE is adopting that authority and capability model as terminal persistence is built. Copy the contracts and invariants, not the Orca integration or a premature multi-backend architecture.
