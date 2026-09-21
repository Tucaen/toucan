---
title: Delegation evidence plan
created: 2026-09-10
updated: 2026-09-21
status: shipped v0.10.0 (#181)
---

# Delegation evidence (#181)

The existing delegation card shows model requests separately from provider confirmation,
reported worker tokens, observed failures/interruption and the returned report. Focus still
hides the whole activity card. `src/shared/delegation-evidence.ts` owns the evidence parser and
readout; `mergeActivity` folds it into the shared transcript by tool-call id. Repeated result
patches replace usage rather than adding it, and observed status values are a set, not a retry
counter. No new worker prose, pricing table, analytics service or subscription-savings estimate.

## Transport evidence and limits

Inspected the pinned dependencies on 2026-09-10:

- claude-agent-acp 0.75.1: `dist/acp-agent.js`'s tool-result conversion preserves
  `chunk.content` in `rawOutput`; `dist/tools.js` strips the Agent/Task `<usage>` trailer only
  from the rendered content. The raw trailer therefore survives both live calls and
  `session/load`. We read only its tail-anchored `total_tokens`, never numbers in report prose.
- Agent SDK 0.3.220: `sdk-tools.d.ts`'s completed `AgentOutput` specifies `resolvedModel`,
  `modelsUsed`, `totalTokens` and `usage` input/output/cache counters. The parser accepts this
  structured result when supplied, but the pinned ACP adapter does **not** forward it in
  `rawOutput`. In ordinary shipped sessions confirmation and the breakdown remain unavailable.
  Tests for that shape establish the behavior when evidence exists, not a claim that today's
  adapter supplies it. Alias resolution is not guessed; all reported models remain visible.
- codex-acp 1.10.0: `createSubAgentActivityUpdate` forwards thread/path/activity kind but no
  worker model or usage. Those stay unknown. An interrupted interaction is labeled as such,
  and a completed interaction is not proof that the worker's task succeeded.
- Claude's prompt-response `_meta.quota.token_count` covers the main loop;
  `model_usage` also includes workers, compaction and sidechains. Neither is a replayed
  per-delegation result. ACP `usage_update.used` is context occupancy, not cumulative billed
  input. None of these is relabeled worker usage or subtracted to manufacture overhead.

Invocation totals can include nested work. The card shows each known invocation separately,
never adds parent/child totals, and explicitly leaves unattributed usage and orchestration
overhead unavailable. Missing counters are unavailable. The live CLI comparison also exposed
`usage.output_tokens_details.thinking_tokens` on its structured worker result; the parser
preserves that explicit reasoning counter when present. It is part of output, never added
to it. The pinned adapter drops that structure too. No dollars appear in the card.

A caller's explicit `rawInput.model` is the request for that invocation. The session's current
routine-worker preference is deliberately not applied to historical calls: it may have changed
since they ran. When the adapter drops the original default/model definition, the call's
requested model is unknown too. The session configuration readout remains available elsewhere.

Failures in steps, interrupted Codex interactions and a failure followed by a new status on the
same call are displayed as observed events. There is no guessed retry count, inferred handback
from English prose, or attribution of later parent edits to a worker. The actual report and
steps remain alongside the evidence. A provider replay that omits an intermediate failure
cannot reconstruct it; the shared fold preserves every status it actually receives.

## Reproducible workload comparison

Run `npx tsc -p tsconfig.test.json`, then `node docs/plans/compare-routine-delegation.mjs`.
An optional first argument supplies the native Claude executable. This uses the signed-in
account and makes two budget-bounded calls (maximum $2 per call); it is not part of the test
suite. The script creates twelve temporary TypeScript files, each with two `is*` exports and
one other export, and asks for the count (independently known answer: **24**). Logs and the
summary stay in the new temporary directory; no project file is changed.

Both runs use parent `opus` and read-only inspection tools. The disabled run prohibits
delegation; the enabled run installs exactly `claudeDelegationSessionMeta({ workerModelId:
'haiku' })` and explicitly asks for one routine worker, without a model override. This is a
controlled exercise of the mechanism, not a test of whether the policy spontaneously chooses
to delegate. Like the earlier smoke tests in `cheap-routine-delegation.md`, it drives the CLI
directly: its richer accounting is not claimed to be available in ACP cards.

An initial policy-only pair, without the explicit one-worker instruction, returned 24 in both
runs and spawned no workers in either. Provider-reported list-basis cost was $0.2508855 disabled
and $0.1320145 enabled. That difference is not evidence of delegation savings: no delegation
occurred, and cache creation/read counts differed substantially.

### Controlled results (2026-09-10)

Claude Code 2.1.266; parent confirmed as `claude-opus-5`, worker confirmed in its result as
`claude-haiku-4-5-20251001`. One run per condition, disabled first:

| Observation | Disabled | Enabled, one routine worker |
| --- | --- | --- |
| Result | 24, exact format | 24 plus an unsolicited verification paragraph |
| Worker invocations | 0 | 1, `routine-worker`, no model override |
| Wall time | 13.289 s | 43.170 s |
| Provider-reported total cost, USD list basis | 0.126756 | 0.1704326 |
| Main-loop input / output tokens | 8 / 423 | 6 / 954 |
| Main-loop cache creation / read tokens | 8,055 / 69,166 | 9,131 / 52,294 |
| Main-loop reasoning (included in output) | 32 | 0 |
| Inclusive Opus model-row cost, USD list basis | 0.125748 | 0.141337 |
| Inclusive Haiku model-row cost, USD list basis | 0.001008 | 0.0290956 |

The enabled worker's own structured result reports total 11,390; input 8, output 1,512,
cache creation 1,880, cache read 7,990, and thinking 1,166 (included in output). Its work
was 12 reads and one search. The parent then checked the result by grep and glob. The worker
result is a different scope from the final inclusive Haiku row (976 input, 2,853 output,
9,870 cache creation, 15,171 cache read, 1,454 thinking); these are not summed or treated as
an accounting partition. Haiku also appears in the disabled run with **no delegated worker**,
demonstrating why a model-row cost is not a worker attribution.

The main answer was substantively correct in both conditions. The enabled run failed the
integer-only output requirement (`correct: false` in the script is strict exact-output
validation), so the extra prose is a quality limitation, not hidden as a successful check.
It cost more and took longer in this small example. This does not generalize: one observation,
unequal caches, fixed run order, a tiny uniform fixture, explicit delegation instruction,
and CLI-direct transport all limit comparison. Reported `costBasis: list` is the provider's
list-rate valuation, not a measured subscription charge or quota saving. Parent/worker
accounting is not enough to isolate orchestration overhead; no savings percentage is claimed.
