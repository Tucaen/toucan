# Provider budgets, availability, and Coordinator failover

Research date: 2026-08-09. Scope: current official OpenAI and Anthropic documentation for Codex App Server/SDK and Claude Code/Agent SDK.

## Verdict

ADE can safely prefer Claude for **new Coordinator turns**, route a later turn to Codex when Claude reports a hard plan limit, and make Claude eligible again after its reported reset. This is feasible availability routing, not seamless session migration.

The safe policy is:

1. Keep a provider-neutral Work Item and Coordinator checkpoint outside both providers.
2. Choose a provider before a turn starts and hold an exclusive session/worktree lease for that turn.
3. Treat a provider-classified hard quota as a failover signal. Treat context pressure as a compaction or same-provider rollover signal.
4. Never move an in-flight turn silently. Reconcile partial output and tool effects first.
5. At `reset + clock-skew buffer`, probe Claude. Restore it as the preferred provider only for the next safe turn boundary; do not interrupt a healthy Codex-owned turn.

Neither provider exposes a portable conversation state. Native resume works only inside that provider. Cross-provider continuity must use an ADE-owned handoff packet.

## Four states that must not be conflated

| State | Scope | Typical evidence | Correct response |
|---|---|---|---|
| Context pressure/exhaustion | One model-visible session history | Context tokens/fraction, compaction boundary | Compact; if necessary, start a fresh session with a checkpoint. Normally stay on the same provider. |
| Account/plan quota exhausted | Account, plan, model, or quota window | Provider says `rejected`/limit reached and may supply a reset time | Stop new turns on that affected scope; fail over if the alternate is available. |
| Transient throttling/overload | Request, model, or service | Temporary 429, 5xx, 529, timeout | Use the provider's bounded retry/backoff first. Do not mark the account quota exhausted. |
| Auth, credit, entitlement, or policy block | Account/configuration | Login expired, low credit, model entitlement, managed-policy denial | Require remediation or choose a permitted alternative; a timer alone may not fix it. |

Switching providers does not reduce the old session's context. It only creates a new session with whatever explicit state ADE transfers. Conversely, high context usage does not prove the account is near its plan quota.

## Capability matrix

| Capability | Codex App Server / SDK | Claude Code / Agent SDK |
|---|---|---|
| Context/token usage | App Server pushes `thread/tokenUsage/updated` for the active thread. Current high-level SDK docs focus on running/resuming threads; App Server is the stronger integration surface for telemetry. | Claude Code status-line JSON exposes current context tokens, context size, used/remaining percentage, and last-call usage. Agent SDK emits per-step usage and per-`query()` cumulative usage/cost; it does **not** provide a cumulative multi-query session total. |
| Account quota | `account/rateLimits/read` and `account/rateLimits/updated` expose ChatGPT quota buckets, percent used, reached type, and plan/credit data when returned. | Agent SDK emits `RateLimitEvent` on status changes with `allowed`, `allowed_warning`, or `rejected`. Claude subscriber status-line JSON also exposes 5-hour and 7-day windows after the first response. |
| Reset/cooldown | Each Codex quota window can include `resetsAt` (Unix seconds). The documented account snapshot does not provide a generic request `Retry-After`; transient request failures remain a separate error/retry channel. | Subscription `RateLimitInfo.resets_at` and `overage_resets_at` are Unix timestamps. Direct API 429s carry `retry-after` seconds and RFC 3339 reset headers, but Agent SDK does not document passthrough of those raw headers. |
| Resume/branch | App Server supports `thread/resume` and `thread/fork`; SDKs start, continue, and resume local Codex threads. | Claude sessions are saved locally and can be resumed by ID/name; SDK queries can resume or fork a session. |
| Compaction | `thread/compact/start` starts manual compaction and streams a `contextCompaction` item lifecycle. | SDK automatically compacts near the context limit and emits `compact_boundary`; `/compact` can be sent manually. |
| Checkpoint | App Server persistence, fork, and deprecated rollback are thread-history mechanisms, not a provider-neutral workspace checkpoint. | Claude checkpointing snapshots direct file-tool edits before prompts, but omits Bash, external, and some subagent changes; it is explicitly not a substitute for version control. |

## Codex details

### Context and usage

App Server emits `thread/tokenUsage/updated` for an active thread, making it the supported live context-usage signal for an embedded client. The public Codex SDK page documents starting, continuing, and resuming local threads, while the Python SDK controls local App Server over JSON-RPC; it does not document a high-level account-budget API. ADE should therefore use the raw App Server account and thread protocol for its Codex budget adapter, even if it uses the SDK for convenient turn execution. [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

`account/usage/read` is historical token activity—lifetime tokens, peak daily tokens, streaks, and optional daily buckets. It is **not remaining quota** and must not drive failover. It also requires Codex-backed authentication; API-key-only and Bedrock authentication are excluded. [Codex App Server: token usage](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt)

### Account quota and reset

For ChatGPT-backed Codex, `account/rateLimits/read` returns a backward-compatible bucket plus an optional multi-bucket `rateLimitsByLimitId`; `account/rateLimits/updated` pushes changes. Windows contain `usedPercent`, `windowDurationMins`, and `resetsAt`; `rateLimitReachedType` is the service-classified reached state. `resetsAt` is Unix seconds. Optional workspace credit and earned-reset information can also appear. [Codex App Server: rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

Implications:

- Prefer `rateLimitReachedType` and the complete bucket map over inferring exhaustion from `usedPercent >= 100`.
- Scope availability by account/auth mode and `limitId`; one model/bucket can differ from another.
- Treat `resetsAt` as `nextProbeAt`, not guaranteed availability.
- Do not automatically consume an earned reset credit. That changes account state and should require an explicit ADE policy or user approval.
- The documented account snapshot has no generic transient-request `Retry-After` field. Preserve classified turn errors separately and apply bounded retry/backoff before failover.

### Resume and compaction

`thread/resume` reopens a stored thread so later turns append; `thread/fork` creates a branch and can copy through a completed turn. Forking a mid-turn source records an interruption marker, which reinforces the rule that ADE should hand off only after reconciling an active turn. `thread/compact/start` returns immediately and reports progress through the normal turn/item stream. Deprecated `thread/rollback` only drops turns from in-memory context and writes a marker to persisted JSONL; it should not be modeled as an ADE checkpoint. [Codex App Server: threads](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread), [Codex App Server: compaction](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)

## Claude details

### Context and usage

Claude Code's status-line input exposes `context_window.total_input_tokens`, `total_output_tokens`, `context_window_size`, `used_percentage`, `remaining_percentage`, and a per-category `current_usage`. These describe the live context from the most recent API response, not cumulative lifetime usage; values can be absent before the first response and temporarily null after compaction. [Claude Code status line](https://code.claude.com/docs/en/statusline#context-window-fields)

Agent SDK assistant messages carry per-step token usage. The final result carries usage and estimated cost cumulative only for that `query()` invocation. Each resumed call reports independently, and top-level `usage` excludes subagent consumption; `modelUsage`/`model_usage` includes the whole agent tree. Cost is a client estimate, not authoritative account billing. ADE must aggregate its own Work Item totals and still keep those totals separate from provider quota. [Agent SDK cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

### Account quota, reset, and transient limits

The Python Agent SDK's `RateLimitEvent` is emitted when rate-limit status changes. `RateLimitInfo` includes:

- `status`: `allowed`, `allowed_warning`, or `rejected`;
- `rate_limit_type`: `five_hour`, `seven_day`, model-specific seven-day windows, or `overage`;
- `utilization` from 0 to 1;
- `resets_at`, plus overage status/reset details;
- the raw provider object for forward-compatible diagnostics.

This is sufficient to stop new Claude turns on `rejected` and schedule a later probe. It is an event, not a documented always-available account polling API, so ADE must persist the last observation. [Claude Agent SDK Python reference](https://code.claude.com/docs/en/agent-sdk/python#ratelimitevent)

For Claude.ai subscribers, status-line JSON exposes 5-hour and 7-day percentages and reset timestamps after the first API response. User-facing session/weekly/Opus limit messages block requests until their shown reset; `/usage` displays limits and resets. The shared session/weekly limits differ from model-specific Opus limits. [Claude Code usage-limit errors](https://code.claude.com/docs/en/errors#youve-hit-your-session-limit), [Claude Code status-line data](https://code.claude.com/docs/en/statusline#available-data)

Claude explicitly distinguishes quota from temporary conditions: a 529 is service overload and does not count against quota; a short-lived server 429 without the subscription quota headers is unrelated to plan quota. Claude Code retries transient failures with exponential backoff (up to ten attempts for applicable cases), but avoids replay after completed text/tool blocks because duplicate tool effects are possible. [Claude Code retries and errors](https://code.claude.com/docs/en/errors#automatic-retries)

Therefore, fail over for a provider-classified hard quota, not for every 429/529/timeout. A persistent overload may justify a separately labelled temporary availability fallback after retries, but it must not set `quota.status = REJECTED`.

Authentication mode matters. With a direct Anthropic API key, rate limits are organization/workspace/model-scoped RPM, input-TPM, and output-TPM token buckets that replenish continuously. A 429 includes `retry-after`; response headers expose limit, remaining, and reset values, with token remaining rounded to the nearest thousand. These API throughput limits are not the Claude.ai 5-hour/weekly subscription windows. The Agent SDK does not document that `RateLimitEvent` represents API RPM/TPM or exposes raw API rate-limit headers, so an API-key adapter should capture structured process errors and—where supported by the underlying client/gateway—HTTP headers separately. [Anthropic API rate limits](https://platform.claude.com/docs/en/api/rate-limits)

### Resume, compaction, and checkpointing

Claude CLI sessions are continuously stored as local transcripts and resume with conversation and tool history. Sessions created by `claude -p` or Agent SDK can be resumed by explicit session ID even when they do not appear in the picker. Agent SDK resume/fork branches conversation history, not the filesystem; session files must exist locally, or be mirrored through `SessionStore` for cross-host resume. Anthropic explicitly notes that capturing results, decisions, and diffs as application state and starting fresh is often more robust than moving transcripts. Different product surfaces maintain their own session histories, so ADE must retain the exact adapter and session identity. [Claude Code sessions](https://code.claude.com/docs/en/sessions), [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

The Agent SDK automatically compacts near the context limit and emits `type: system`, `subtype: compact_boundary`; `/compact` can trigger it manually. Compaction replaces older detail with a summary, so early instructions are not guaranteed to survive. [Agent SDK agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction)

Claude checkpoints are useful recovery aids but incomplete. In Claude Code, checkpoints can coordinate conversation rewind/summarization with tracked edits. In Agent SDK, file checkpointing covers only `Write`, `Edit`, and `NotebookEdit`; it excludes Bash changes, most subagent edits, directories, and remote files, and rewinding files does **not** rewind conversation history. Shared `SessionStore` and Agent SDK file checkpointing cannot be enabled together. ADE must use its own worktree/repository fingerprint and verification evidence as the cross-provider checkpoint. [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing), [Agent SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing), [Agent SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)

## Recommended provider-neutral contract

Keep raw observations separate from routing decisions; never flatten provider signals into one ambiguous `tokensRemaining` number.

```ts
type AvailabilityState =
  | "available"
  | "warning"
  | "quota_blocked"
  | "throttled"
  | "overloaded"
  | "context_pressure"
  | "context_exhausted"
  | "credit_blocked"
  | "entitlement_blocked"
  | "auth_required"
  | "offline"
  | "unknown";

interface ProviderBudgetSnapshot {
  provider: "claude" | "codex";
  accountScope: string;          // auth/account/plan identity, not a secret
  modelScope?: string;
  observedAt: string;
  provenance: "push" | "poll" | "turn_error" | "local_aggregate";
  confidence: "authoritative" | "derived" | "unknown";

  context?: {
    sessionId: string;
    usedTokens?: number;
    limitTokens?: number;
    usedFraction?: number;
    compaction: "supported" | "in_progress" | "unavailable" | "unknown";
  };

  quota?: {
    status: "allowed" | "warning" | "rejected" | "unknown";
    windows: Array<{
      kind: string;
      utilization?: number;      // normalized 0..1
      resetsAt?: string;
    }>;
    creditStatus?: "ok" | "blocked" | "unknown";
  };

  transient?: {
    kind: "throttle" | "overload" | "timeout" | "network";
    retryAt?: string;
    attempts?: number;
  };

  availability: AvailabilityState;
  nextProbeAt?: string;          // hint, never a guarantee
  raw?: unknown;                 // redacted provider payload for diagnostics
}
```

The adapter should also advertise capabilities separately: `resume`, `fork`, `compact`, `interrupt`, `usageStream`, `quotaPoll`, `quotaEvents`, and `filesystemCheckpoint`. This prevents ADE from assuming symmetry that does not exist.

## Safe handoff and recovery rules

1. **Persist before dispatch.** Before every Coordinator turn, store objective, acceptance criteria, constraints, plan, decisions, open questions, provider/session IDs, worktree path, HEAD, dirty-state digest, changed files, tests, and outstanding approvals.
2. **Lease the Work Item.** Only one provider session may issue tools against a worktree at a time. Never concurrently resume the same logical session.
3. **Classify terminal state.** Do not switch on token count alone. Distinguish completed, safely interrupted, quota-blocked before work, and ambiguous partial execution.
4. **Reconcile ambiguous turns.** If streaming stopped after text or a tool call began, inspect processes, repository status, diff, and test state. Never blindly replay a non-idempotent action.
5. **Use native recovery first.** On context pressure, compact or roll into a fresh same-provider session. On a transient error, exhaust the bounded retry policy. On hard quota, mark only the affected account/model/window unavailable.
6. **Create an explicit handoff packet.** Include facts and artifacts, not hidden reasoning or a full transcript: objective, constraints, accepted decisions, current plan, exact file/test state, unresolved risks, and the next safe action. Exclude secrets and require the receiving agent to verify the workspace before writing.
7. **Do not transfer approvals.** Re-evaluate tool permissions and request scope-specific approval under the receiving provider/session.
8. **Use sticky ownership.** Let an active Codex turn or worker session finish even if Claude resets. Make Claude preferred again only for the next Coordinator turn or an explicit migration boundary.
9. **Probe after reset.** Schedule `reset + buffer`, obtain a fresh provider observation or harmless probe, then close the circuit. Apply minimum dwell time and backoff to prevent Claude/Codex oscillation.
10. **Fail closed.** If both providers are blocked or state is ambiguous, pause the Work Item and ask the user rather than fan out duplicate agents.

## MVP recommendation

- Use **Claude Agent SDK** for execution and `RateLimitEvent`; optionally ingest subscriber status-line data when running Claude Code as the managed client.
- Use **Codex App Server directly** for `thread/tokenUsage/updated`, `account/rateLimits/read`, and `account/rateLimits/updated`; use a Codex SDK only as a convenience execution layer.
- Route only Coordinator turns automatically. Keep bounded worker/agent sessions on their original provider unless deliberately replaced.
- Default Claude, fall back to Codex on authoritative Claude `rejected`, and restore Claude preference after a successful post-reset probe.
- Treat context thresholds as a checkpoint/compact policy, not a provider failover policy.

## Unknowns and version-sensitive areas

- The public high-level Codex SDK page does not document ChatGPT quota read/events; App Server does. Validate the pinned SDK/App Server protocol version in an MVP integration test.
- Claude documents `RateLimitEvent` as a state-change event, not a general account query. Confirm what initial event is emitted for each supported auth mode and retain a CLI/status-line or harmless-probe fallback.
- Agent SDK does not document raw Anthropic API `retry-after` or `anthropic-ratelimit-*` passthrough, nor that subscription-shaped `RateLimitEvent` maps to API RPM/TPM. Keep these observation paths distinct.
- A reset timestamp does not guarantee capacity, credit, authentication, or policy access at that instant; always re-observe.
- Neither provider documents portable compaction summaries or cross-provider session import. ADE owns semantic handoff.
- Provider error and bucket taxonomies can grow. Preserve redacted raw payloads, default unknown states to non-destructive behavior, and avoid parsing human error text when structured data exists.
