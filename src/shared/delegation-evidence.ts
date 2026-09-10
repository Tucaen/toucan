import type { AgentActivity, DelegationEvidence, DelegationUsage } from './agent'
import { isDelegationActivity } from './tool-identity'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Evidence from an Agent/Task result, not from the worker's prose. Claude's pinned adapter
 * forwards the raw result text (including its totals trailer) on live AND loaded calls, but
 * currently drops the SDK's structured AgentOutput. Accept that documented result shape when
 * present; do not guess models or a token breakdown from the text. Codex's activity payload
 * exposes neither, so it deliberately stays unknown. Cache counters are not added to input:
 * providers differ on whether input already contains them.
 */
export function delegationEvidenceFrom(activity: AgentActivity): DelegationEvidence {
  if (!isDelegationActivity(activity)) return {}
  const input = record(activity.rawInput)
  const requestedModel = text(input.model)
  const output = record(activity.rawOutput)
  const structured = text(output.agentId) !== undefined && output.status === 'completed'
  const models = structured
    ? [text(output.resolvedModel), ...(Array.isArray(output.modelsUsed) ? output.modelsUsed.map(text) : [])]
    : []
  const confirmedModels = [...new Set(models.filter((model): model is string => model !== undefined))]
  let usage: DelegationUsage | undefined
  if (structured) {
    const reported = record(output.usage)
    const counters = {
      total: count(output.totalTokens),
      input: count(reported.input_tokens),
      output: count(reported.output_tokens),
      cacheRead: count(reported.cache_read_input_tokens),
      cacheWrite: count(reported.cache_creation_input_tokens),
      reasoning: count(record(reported.output_tokens_details).thinking_tokens)
    }
    if (Object.values(counters).some((value) => value !== undefined)) {
      usage = { scope: 'worker-invocation', source: 'agent-result', ...counters }
    }
  } else {
    const blocks = Array.isArray(activity.rawOutput) ? activity.rawOutput : [activity.rawOutput]
    for (const block of blocks) {
      const raw =
        typeof block === 'string' ? block : record(block).type === 'text' ? text(record(block).text) : undefined
      if (!raw) continue
      // Only the final provider trailer, never a number mentioned in the report itself.
      const end = raw.trimEnd()
      const opening = end.lastIndexOf('<usage>')
      if (opening < 0 || !end.endsWith('</usage>')) continue
      const trailer = end.slice(opening + 7, -8)
      const match = /^total_tokens: (\d+)\r?$/m.exec(trailer)
      const total = match ? count(Number(match[1])) : undefined
      if (total !== undefined) usage = { scope: 'worker-invocation', source: 'agent-result-trailer', total }
    }
  }
  return {
    ...(requestedModel ? { requestedModel } : {}),
    ...(confirmedModels.length ? { confirmedModels } : {}),
    ...(usage ? { usage } : {}),
    ...(activity.status ? { observedStatuses: [activity.status] } : {})
  }
}

export interface DelegationEvidenceRow {
  label: string
  value: string
}

/**
 * Keep invocation totals separate even for nested workers: the outer result may include the
 * inner usage. No aggregate or subtraction is justified by that evidence. Call ids are the
 * transcript's stable identities; repeated snapshots cannot add another outcome or total.
 */
export function delegationEvidenceRows(
  activity: AgentActivity,
  children: readonly AgentActivity[] = []
): DelegationEvidenceRow[] {
  const evidence = activity.delegationEvidence ?? delegationEvidenceFrom(activity)
  const rows: DelegationEvidenceRow[] = [
    { label: 'Model requested', value: evidence.requestedModel ?? 'Unknown (not reported for this call)' },
    { label: 'Model confirmed', value: evidence.confirmedModels?.join(', ') ?? 'Unknown (not reported)' }
  ]
  const calls = [...new Map([activity, ...children].map((call) => [call.id, call])).values()]
  for (const call of calls) {
    const usage = (call.delegationEvidence ?? delegationEvidenceFrom(call)).usage
    if (!usage) continue
    const fields: [string, number | undefined][] = [
      ['total', usage.total],
      ['input', usage.input],
      ['output', usage.output],
      ['cache read', usage.cacheRead],
      ['cache write', usage.cacheWrite],
      ['reasoning', usage.reasoning]
    ]
    rows.push({
      label: call.id === activity.id ? 'Worker invocation tokens' : `Nested worker tokens (${call.id})`,
      value:
        fields.map(([label, value]) => `${label}: ${value ?? 'unavailable'}`).join(' · ') +
        (usage.source === 'agent-result-trailer' ? ' (provider result trailer)' : ' (provider result)')
    })
  }
  if (!evidence.usage) rows.push({ label: 'Worker invocation tokens', value: 'Unavailable' })
  rows.push({
    label: 'Accounting',
    value:
      'Invocation totals may overlap; not added. Parent totals and unattributed usage unavailable here. Orchestration overhead cannot be isolated.'
  })
  const interrupted = calls.some((call) => record(call.rawInput).activityKind === 'interrupted')
  const failures = calls.filter((call) => call.status === 'failed')
  rows.push({
    label: 'Observed outcome',
    value: interrupted
      ? 'Interrupted interaction reported'
      : activity.status === 'failed'
        ? 'Failed'
        : activity.status === 'completed'
          ? 'Tool call completed (worker quality not verified)'
          : 'In progress'
  })
  if (failures.length)
    rows.push({ label: 'Failed calls', value: failures.map((call) => call.title ?? call.id).join(', ') })
  if (evidence.observedStatuses?.includes('failed') && activity.status !== 'failed') {
    rows.push({ label: 'Earlier outcome', value: 'Failure reported before the current status; retry cost unavailable' })
  }
  rows.push({ label: 'Handback / rework', value: 'See reported result and steps; attribution unavailable' })
  return rows
}
