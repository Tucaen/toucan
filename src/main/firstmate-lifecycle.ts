import { createHash } from 'node:crypto'
import type {
  FirstMateDispatchStatus,
  FirstMateForge,
  FirstMateLifecycleStatus,
  FirstMateLifecycleTask,
  FirstMateTaskDispatch,
  FirstMateTaskStage,
  FirstMatePullRequestState,
  FirstMateTaskHistoryEvent,
  FirstMatePendingDecision,
  FirstMateStatusEvidence,
  FirstMateValidatorRuntime
} from '../shared/firstmate'
import {
  FIRSTMATE_TASK_CONTEXT_META_KEY,
  firstMateTaskContextFromMetadata
} from '../shared/firstmate-task-context'
import { parseFirstMateRuntimeRecord } from '../shared/firstmate-runtime-record'
import {
  firstMateWorktreeProvenanceProblem,
  type FirstMateWorktreeProvenance
} from './firstmate-worktree-provenance'

export interface FirstMateRawTask {
  id: string
  meta: string
  status: string
  /**
   * Read-only Git evidence that the reported crew worktree belongs to the pinned checkout, gathered by
   * the caller from FirstMate's own worktree. Absent only when the caller gathered no evidence (a unit
   * test isolating another concern); the runtime that supervises real tasks always supplies it, and a
   * present-but-unreadable probe blocks the task rather than degrading to the weak path check.
   */
  provenance?: FirstMateWorktreeProvenance
}

export interface FirstMateLifecycleFiles {
  runtimeConfig?: string
  journal?: string
  /** The durable dispatch ledger, read back so an already-delivered identity is recognisable. */
  dispatchLedger?: string
  tasks: FirstMateRawTask[]
}

export interface FirstMateLifecycleRecord {
  stage: FirstMateTaskStage
  detail: string
  statusHash: string
  nextAction?: FirstMateLifecycleTask['nextAction']
  dispatch?: FirstMateTaskDispatch
  prUrl?: string
  /**
   * Recorded once ADE has asked the PR's own forge and learned it merged or closed, scoped to the
   * `statusHash` of the `done: PR ...` line it was checked against. A later status line hashes
   * differently, so a new PR is never mistaken for one already resolved.
   */
  prResolution?: 'merged' | 'closed'
  updatedAt: string
  history?: FirstMateTaskHistoryEvent[]
  terminalOutcome?: FirstMateLifecycleTask['terminalOutcome']
  projection?: Pick<FirstMateLifecycleTask, 'id' | 'mode' | 'context' | 'worktree' | 'window'>
  pendingDecisions?: FirstMatePendingDecision[]
}

export interface FirstMateLifecycleJournal {
  version: 1
  tasks: Record<string, FirstMateLifecycleRecord>
}

/** ADE's own durable lifecycle journal inside FirstMate's private state directory. */
export const FIRSTMATE_LIFECYCLE_JOURNAL_FILE = '.ade-lifecycle.json'

/**
 * The durable ledger of validation dispatch identities ADE has delivered, kept in FirstMate's shared
 * state directory rather than ADE's private journal so the receiving boundary can consult it too. It
 * is the durable evidence that turns a stable dispatch identity into exactly-once processing: a
 * repeated identity is recognisable here instead of only in a process's memory or a prompt.
 */
export const FIRSTMATE_DISPATCH_LEDGER_FILE = '.ade-validation-dispatches.json'

/**
 * One dispatch identity's row in the durable ledger. `dispatched` records that ADE began an external
 * send of this identity; `acknowledged` records that a send of it completed. `deliveries` counts how
 * many times the identity was sent, so a repeated delivery leaves durable evidence rather than none.
 */
export interface FirstMateDispatchLedgerEntry {
  taskId: string
  status: 'dispatched' | 'acknowledged'
  recordedAt: string
  deliveries: number
}

interface FirstMateDispatchLedger {
  version: 1
  dispatches: Record<string, FirstMateDispatchLedgerEntry>
}

function isLedgerEntry(value: unknown): value is FirstMateDispatchLedgerEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<FirstMateDispatchLedgerEntry>
  return typeof candidate.taskId === 'string'
    && (candidate.status === 'dispatched' || candidate.status === 'acknowledged')
}

/**
 * Reads back the durable evidence of a dispatch identity, so recognition of a repeat is code
 * enforced from disk rather than left to a process's memory or the receiver's reading of a prompt.
 * An identity already recorded as `acknowledged` was provably delivered once and must never be sent
 * a second time; a `dispatched`-only identity has an unproven delivery an operator may still resend.
 */
export function firstMateRecognisedDispatch(
  ledgerText: string | undefined,
  dispatchId: string
): FirstMateDispatchLedgerEntry | undefined {
  if (!ledgerText) return undefined
  try {
    const parsed = JSON.parse(ledgerText) as Partial<FirstMateDispatchLedger>
    if (parsed.version !== 1 || !parsed.dispatches || typeof parsed.dispatches !== 'object') return undefined
    const entry = parsed.dispatches[dispatchId]
    return isLedgerEntry(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return values
}

function projectedStatusLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const terminal = lines.filter((line) => {
    const verb = statusParts(line).verb.toLowerCase()
    return verb === 'completed' || verb === 'cancelled' || verb === 'canceled' || verb === 'failed'
  }).at(-1)
  if (terminal) return terminal
  const latest = lines.at(-1) ?? ''
  const { verb, detail } = statusParts(latest)
  if (verb.toLowerCase() !== 'needs-decision') return latest
  const key = /^\[key=([^\]]+)\]/.exec(detail)?.[1]?.trim()
  if (!key) return latest
  return [...lines].reverse().find((line) => {
    const parts = statusParts(line)
    return parts.verb.toLowerCase() === 'resolved'
      && /^\[key=([^\]]+)\]/.exec(parts.detail)?.[1]?.trim() === key
  }) ?? latest
}

function statusParts(line: string): { verb: string; detail: string } {
  const separator = line.indexOf(':')
  if (separator < 1) return { verb: '', detail: line }
  return { verb: line.slice(0, separator).trim(), detail: line.slice(separator + 1).trim() }
}

function statusHash(status: string): string {
  return createHash('sha256').update(status).digest('hex').slice(0, 20)
}

function statusEvidenceId(line: string): string {
  const { verb, detail } = statusParts(line)
  return createHash('sha256')
    .update(`${verb.toLowerCase()}:${detail.replace(/\s+/g, ' ').trim()}`)
    .digest('hex').slice(0, 20)
}

function pendingDecisions(status: string): FirstMatePendingDecision[] {
  const open = new Map<string, FirstMatePendingDecision>()
  const seen = new Set<string>()
  const lines = status.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  const resolvedKeys = new Set(lines.flatMap((line) => {
    const { verb, detail } = statusParts(line)
    const key = /^\[key=([^\]]+)\]/.exec(detail)?.[1]?.trim()
    return verb.toLowerCase() === 'resolved' && key ? [key] : []
  }))
  for (const line of lines) {
    const evidenceId = statusEvidenceId(line)
    if (seen.has(evidenceId)) continue
    seen.add(evidenceId)
    const { verb, detail } = statusParts(line)
    const match = /^\[key=([^\]]+)\]\s*(.*)$/.exec(detail)
    if (!match) continue
    const key = match[1]!.trim()
    if (verb.toLowerCase() === 'needs-decision' && !resolvedKeys.has(key)) {
      open.set(key, { key, detail: match[2]!.trim() })
    }
  }
  return [...open.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function statusEvidence(status: string, mode: string): FirstMateStatusEvidence[] {
  const evidence = status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const { verb: rawVerb, detail } = statusParts(line)
    const verb = rawVerb.toLowerCase()
    const stage: FirstMateTaskStage = verb === 'needs-decision'
      ? 'decision'
      : verb === 'blocked' || verb === 'failed'
        ? 'blocked'
        : verb === 'done' && prFromDone(verb, detail)
          ? 'pr-ready'
          : verb === 'working' && /validat|no-mistakes|checks|\bCI\b/i.test(detail)
            ? 'validating'
            : verb === 'resolved' && mode === 'no-mistakes'
              ? 'validating'
              : 'implemented'
    const outcome = verb === 'failed'
      ? 'failed' as const
      : verb === 'completed'
        ? 'completed' as const
        : verb === 'cancelled' || verb === 'canceled'
          ? 'cancelled' as const
          : undefined
    return { id: statusEvidenceId(line), stage, detail, ...(outcome ? { outcome } : {}) }
  })
  return [...new Map(evidence.map((item) => [item.id, item])).values()]
}

function parseJournal(text?: string): FirstMateLifecycleJournal {
  if (!text) return { version: 1, tasks: {} }
  try {
    const parsed = JSON.parse(text) as Partial<FirstMateLifecycleJournal>
    if (parsed.version !== 1 || !parsed.tasks || typeof parsed.tasks !== 'object') throw new Error()
    return { version: 1, tasks: parsed.tasks }
  } catch {
    return { version: 1, tasks: {} }
  }
}

function recordedHistory(value: unknown): FirstMateTaskHistoryEvent[] {
  if (!Array.isArray(value)) return []
  const events = value.filter((event): event is FirstMateTaskHistoryEvent => {
    if (!event || typeof event !== 'object') return false
    const item = event as Partial<FirstMateTaskHistoryEvent>
    return typeof item.id === 'string' && typeof item.occurredAt === 'string'
      && typeof item.detail === 'string'
      && ['firstmate-status', 'ade-reconciliation', 'forge'].includes(item.source ?? '')
  })
  return [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
}

export function firstMateValidatorFromRuntimeConfig(text?: string): FirstMateValidatorRuntime | undefined {
  const record = parseFirstMateRuntimeRecord(text)
  return record ? { ...record.validator, configSource: 'ade-runtime' } : undefined
}

const DISPATCH_STATUSES: ReadonlySet<FirstMateDispatchStatus> = new Set([
  'claimed',
  'acknowledged',
  'retryable',
  'unresolved',
  'released'
])

function recordedDispatch(value: unknown): FirstMateTaskDispatch | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<FirstMateTaskDispatch>
  if (typeof candidate.id !== 'string' || !candidate.id) return undefined
  const status = candidate.status
  if (status === undefined || !DISPATCH_STATUSES.has(status)) return undefined
  if (typeof candidate.attempt !== 'number' || !Number.isInteger(candidate.attempt) || candidate.attempt < 1) {
    return undefined
  }
  return {
    id: candidate.id,
    status,
    attempt: candidate.attempt,
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {})
  }
}

/**
 * Mints the stable identity of a validation continuation. It names the logical operation — one
 * implementation line reaching validation — not a delivery attempt, so every attempt of the same
 * continuation reuses it and the attempt count is tracked separately. Derived only from durable
 * task state, so a restart in the middle of minting names the same operation identically. Once
 * minted the identity is journalled and read back rather than recomputed: it travels to the worker
 * as an idempotency key, and the receiving boundary deduplicates repeated deliveries by it.
 */
export function firstMateValidationDispatchId(taskId: string, statusHash: string): string {
  return `${taskId}.${statusHash}`
}

/** What an ADE process observed for a claim it wrote, before it managed to journal the outcome. */
export type FirstMateDispatchMemory = 'claimed' | 'acknowledged' | 'retryable'

export type FirstMateValidationPlan =
  | { action: 'none' }
  | { action: 'dispatch'; dispatchId: string; attempt: number }
  | { action: 'acknowledge'; dispatchId: string; attempt: number }
  | { action: 'retry'; dispatchId: string; attempt: number }
  | {
      action: 'block'
      dispatchId: string
      attempt: number
      reason: 'unresolved-claim' | 'attempts-exhausted'
    }

export interface FirstMateValidationPlanInput {
  task: FirstMateLifecycleTask
  /** Dispatch ids this ADE process claimed, with the outcome it observed in memory. */
  liveDispatches: ReadonlyMap<string, FirstMateDispatchMemory>
  maxAttempts: number
}

/**
 * Decides what reconciliation owes a task, from durable state plus what this process
 * remembers about the claims it made. A durable claim whose outcome this process cannot
 * account for is never re-dispatched: the continuation may already have run, so the task
 * is blocked as recoverable instead.
 */
export function planValidationDispatch(input: FirstMateValidationPlanInput): FirstMateValidationPlan {
  const { task, liveDispatches, maxAttempts } = input
  const dispatch = task.dispatch

  if (task.terminalOutcome) return { action: 'none' }

  if (task.stage === 'dispatching' && dispatch?.status === 'claimed') {
    const { id: dispatchId, attempt } = dispatch
    const remembered = liveDispatches.get(dispatchId)
    if (remembered === 'acknowledged') return { action: 'acknowledge', dispatchId, attempt }
    if (remembered === 'retryable') return { action: 'retry', dispatchId, attempt }
    if (remembered === 'claimed') return { action: 'none' }
    return { action: 'block', dispatchId, attempt, reason: 'unresolved-claim' }
  }

  if (task.stage !== 'implemented' || task.nextAction !== 'start-validation') return { action: 'none' }

  // A released dispatch resends the identity FirstMate may already have seen, so a worker that
  // did receive the first continuation can recognise the retry instead of validating twice.
  if (dispatch?.status === 'released') {
    return { action: 'dispatch', dispatchId: dispatch.id, attempt: dispatch.attempt }
  }

  const rejected = dispatch?.status === 'retryable' ? dispatch : undefined
  const attempt = (rejected?.attempt ?? 0) + 1
  if (rejected && attempt > maxAttempts) {
    return {
      action: 'block',
      dispatchId: rejected.id,
      attempt: rejected.attempt,
      reason: 'attempts-exhausted'
    }
  }
  // A retry reuses the identity the first attempt minted: it is the same logical continuation, so
  // even a delivery the pre-send rejection could not rule out is deduplicable by the worker.
  return {
    action: 'dispatch',
    dispatchId: rejected?.id ?? firstMateValidationDispatchId(task.id, task.statusEvidenceId ?? task.statusHash),
    attempt
  }
}

/**
 * The record that hands an unresolvable dispatch back to reconciliation, at an operator's
 * explicit request. It keeps the recorded identity so the resend is deduplicable by the worker.
 */
export function firstMateReleasedDispatchRecord(
  task: FirstMateLifecycleTask,
  now: Date
): FirstMateLifecycleRecord | undefined {
  const dispatch = task.dispatch
  if (!dispatch || dispatch.status !== 'unresolved') return undefined
  return {
    stage: 'implemented',
    detail: `Validation dispatch ${dispatch.id} was released for another attempt with the same identity.`,
    statusHash: task.statusHash,
    nextAction: 'start-validation',
    dispatch: { id: dispatch.id, status: 'released', attempt: dispatch.attempt },
    updatedAt: now.toISOString()
  }
}

/**
 * The record that hands an attempts-exhausted dispatch back to reconciliation with a fresh budget,
 * at an operator's explicit request. Every attempt that exhausted the budget failed before the
 * external send, so nothing reached FirstMate and a clean attempt is safe; clearing the dispatch
 * lets reconciliation remint the same stable identity from the unchanged task.
 */
export function firstMateRetriedDispatchRecord(
  task: FirstMateLifecycleTask,
  now: Date
): FirstMateLifecycleRecord | undefined {
  const dispatch = task.dispatch
  if (task.stage !== 'blocked' || dispatch?.status !== 'retryable') return undefined
  return {
    stage: 'implemented',
    detail: `Validation dispatch ${dispatch.id} was reset for a fresh delivery attempt after its pre-send retries were exhausted.`,
    statusHash: task.statusHash,
    nextAction: 'start-validation',
    updatedAt: now.toISOString()
  }
}

type UnfinishedDispatchStatus = 'claimed' | 'unresolved' | 'released'

/**
 * How a task presents while a dispatch is still outstanding. `acknowledged` and `retryable` are
 * absent on purpose: both are settled, so a new implementation line may legitimately restart the
 * attempt count from them.
 */
const UNFINISHED_STAGES: Record<
  UnfinishedDispatchStatus,
  { stage: FirstMateTaskStage; nextAction: FirstMateLifecycleTask['nextAction'] }
> = {
  claimed: { stage: 'dispatching', nextAction: 'await-dispatch' },
  unresolved: { stage: 'blocked', nextAction: 'await-help' },
  released: { stage: 'implemented', nextAction: 'start-validation' }
}

function unfinishedDispatch(durable?: FirstMateLifecycleRecord): {
  dispatch: FirstMateTaskDispatch
  stage: FirstMateTaskStage
  nextAction: FirstMateLifecycleTask['nextAction']
} | undefined {
  const dispatch = recordedDispatch(durable?.dispatch)
  const presentation = dispatch && UNFINISHED_STAGES[dispatch.status as UnfinishedDispatchStatus]
  return dispatch && presentation ? { dispatch, ...presentation } : undefined
}

function prFromDone(verb: string, detail: string): string | undefined {
  if (verb !== 'done') return undefined
  const match = /\bPR\s+(https:\/\/[^\s]+)/i.exec(detail)
  return match?.[1]?.replace(/[),.;]+$/, '')
}

/**
 * Names the forge a PR URL belongs to, from its host alone - not every PR URL is GitHub, and not
 * every project even uses a forge with a PR concept. `undefined` covers every host ADE has no live
 * merge check implemented for, so the caller leaves those tasks exactly as `pr-ready` today rather
 * than guessing at a forge it cannot actually ask.
 */
export function firstMateForgeFromPrUrl(url: string): FirstMateForge | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'github.com' || host === 'www.github.com' ? 'github' : undefined
  } catch {
    return undefined
  }
}

/**
 * The record that tells a `pr-ready` task's PR merged or closed, so the next reload of durable
 * task state stops presenting it as awaiting review. Scoped to the task's current `statusHash`:
 * a worker that later opens a new PR on the same task rehashes and this resolution no longer
 * applies to it, so the new PR gets its own live check rather than inheriting the old verdict.
 */
export function firstMatePrResolvedRecord(
  task: FirstMateLifecycleTask,
  state: Exclude<FirstMatePullRequestState, 'open'>,
  now: Date
): FirstMateLifecycleRecord | undefined {
  if (task.stage !== 'pr-ready' || !task.prUrl) return undefined
  const occurredAt = now.toISOString()
  const outcome = state === 'merged' ? 'completed' as const : 'cancelled' as const
  return {
    stage: task.stage,
    detail: task.detail,
    statusHash: task.statusHash,
    nextAction: task.nextAction,
    prUrl: task.prUrl,
    prResolution: state,
    updatedAt: occurredAt,
    terminalOutcome: outcome,
    projection: {
      id: task.id, mode: task.mode, ...(task.context ? { context: task.context } : {}),
      ...(task.worktree ? { worktree: task.worktree } : {}), ...(task.window ? { window: task.window } : {})
    },
    ...(task.pendingDecisions ? { pendingDecisions: task.pendingDecisions } : {}),
    history: [{
      id: `forge:${task.statusHash}:${state}`,
      occurredAt,
      source: 'forge',
      stage: task.stage,
      detail: `Pull request ${state}.`,
      outcome
    }]
  }
}

function taskContextProblem(
  taskId: string,
  meta: Map<string, string>,
  context: NonNullable<FirstMateLifecycleTask['context']>,
  kind: 'ship' | 'scout',
  provenance?: FirstMateWorktreeProvenance
): string | undefined {
  const recordedProject = meta.get('project')
  if (recordedProject !== context.project.wslPath) {
    return `Task ${taskId} recorded project ${JSON.stringify(recordedProject ?? 'missing')}, but its pinned ADE project `
      + `${context.project.adeProjectId} is ${JSON.stringify(context.project.wslPath)}.`
  }
  const worktree = meta.get('worktree')
  if (!worktree || worktree === recordedProject) {
    return `Task ${taskId} does not record an isolated crew worktree distinct from its pinned external checkout.`
  }
  if (provenance) {
    const provenanceProblem = firstMateWorktreeProvenanceProblem(taskId, worktree, provenance)
    if (provenanceProblem) return provenanceProblem
  }

  if (kind === 'ship') {
    const mode = meta.get('mode')
    const modeMatches = context.project.mode === 'no-mistakes-prod-only'
      ? mode === 'no-mistakes' || mode === 'direct-PR'
      : mode === context.project.mode
    if (!modeMatches) {
      return `Task ${taskId} recorded delivery mode ${JSON.stringify(mode ?? 'missing')}, which drifts from `
        + `the pinned ${JSON.stringify(context.project.mode)} project posture.`
    }
    const autonomy = meta.get('yolo')
    const expectedAutonomy = context.project.autonomy ? 'on' : 'off'
    if (autonomy !== expectedAutonomy) {
      return `Task ${taskId} recorded yolo=${autonomy ?? 'missing'}, but its pinned autonomy is ${expectedAutonomy}.`
    }
  }

  const harness = meta.get('harness') ?? ''
  const harnessAgent = /^codex(?:$|[-_])/.test(harness)
    ? 'codex'
    : /^claude(?:$|[-_])/.test(harness) ? 'claude' : undefined
  if (harnessAgent !== context.validator.agent) {
    return `Task ${taskId} recorded harness ${JSON.stringify(harness || 'missing')}, but its pinned provider is `
      + `${context.validator.agent}.`
  }
  const model = meta.get('model')
  if (model !== context.validator.model) {
    return `Task ${taskId} recorded model ${JSON.stringify(model ?? 'missing')}, but its pinned model is `
      + `${JSON.stringify(context.validator.model)}.`
  }
  return undefined
}

function recordedTask(
  raw: FirstMateRawTask,
  journal: FirstMateLifecycleJournal
): FirstMateLifecycleTask | undefined {
  const meta = parseKeyValues(raw.meta)
  const kind = meta.get('kind') ?? 'ship'
  if (kind !== 'ship' && kind !== 'scout') return undefined
  const mode = kind === 'scout' ? 'scout' : meta.get('mode') ?? 'unknown'
  const context = firstMateTaskContextFromMetadata(raw.meta)
  const declaresContext = raw.meta.split(/\r?\n/).some(
    (line) => line.startsWith(`${FIRSTMATE_TASK_CONTEXT_META_KEY}=`)
  )
  const worktree = meta.get('worktree')
  const window = meta.get('window')
  const line = projectedStatusLine(raw.status)
  const evidenceId = statusEvidenceId(line)
  const decisions = pendingDecisions(raw.status)
  const evidence = statusEvidence(raw.status, mode)
  const attachContext = (task: FirstMateLifecycleTask): FirstMateLifecycleTask => ({
    ...task,
    statusEvidenceId: evidenceId,
    statusEvidence: evidence,
    pendingDecisions: decisions,
    ...(context ? { context } : {}),
    ...(worktree ? { worktree } : {}),
    ...(window ? { window } : {})
  })
  const hash = statusHash(raw.status)
  if (!declaresContext) {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'blocked',
      detail: `Task ${raw.id} has no durable ADE task context; supervision cannot safely infer its project, posture, or validator.`,
      statusHash: hash,
      nextAction: 'await-help'
    })
  }
  if (declaresContext && !context) {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'blocked',
      detail: `Task ${raw.id} declares an ADE task context, but the durable carrier is malformed or ambiguous.`,
      statusHash: hash,
      nextAction: 'await-help'
    })
  }
  if (context) {
    const problem = taskContextProblem(raw.id, meta, context, kind, raw.provenance)
    if (problem) {
      return attachContext({
        id: raw.id,
        mode,
        stage: 'blocked',
        detail: problem,
        statusHash: hash,
        nextAction: 'await-help'
      })
    }
  }
  if (!line) return undefined
  const { verb, detail } = statusParts(line)
  const prUrl = prFromDone(verb, detail)
  const durable = journal.tasks[raw.id]
  const durableHistory = recordedHistory(durable?.history)
  const durableDispatch = recordedDispatch(durable?.dispatch)
  const holdsValidationGate = durableDispatch
    && ['claimed', 'acknowledged', 'unresolved'].includes(durableDispatch.status)
    ? durableDispatch
    : undefined
  const evidenceDispatchId = firstMateValidationDispatchId(raw.id, evidenceId)

  if (prUrl) {
    // ADE already asked the PR's own forge and learned it merged or closed: stop presenting it as
    // awaiting review instead of waiting on FirstMate's own task-record teardown to catch up.
    if (durable?.statusHash === hash && durable.prResolution) return undefined
    return attachContext({ id: raw.id, mode, stage: 'pr-ready', detail, statusHash: hash, nextAction: 'review-pr', prUrl, history: durableHistory })
  }
  if (verb === 'needs-decision') {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'decision',
      detail,
      statusHash: hash,
      nextAction: 'await-decision',
      ...(holdsValidationGate ? { dispatch: holdsValidationGate } : {}),
      history: durableHistory
    })
  }
  if (verb === 'blocked' || verb === 'failed') {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'blocked',
      detail,
      statusHash: hash,
      nextAction: 'await-help',
      ...(holdsValidationGate ? { dispatch: holdsValidationGate } : {}),
      history: durableHistory,
      ...(verb === 'failed' ? { terminalOutcome: 'failed' as const } : {})
    })
  }
  if (verb === 'working' && /validat|no-mistakes|checks|\bCI\b/i.test(detail)) {
    return attachContext({ id: raw.id, mode, stage: 'validating', detail, statusHash: hash, nextAction: 'await-validation', history: durableHistory })
  }

  if (verb === 'resolved' && mode === 'no-mistakes') {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'validating',
      detail,
      statusHash: hash,
      nextAction: 'await-validation',
      history: durableHistory
    })
  }
  if (verb === 'done' && durableDispatch?.id === evidenceDispatchId) {
    return attachContext({
      id: raw.id,
      mode,
      stage: durable.stage,
      detail: durable.detail,
      statusHash: hash,
      ...(durable.nextAction ? { nextAction: durable.nextAction } : {}),
      dispatch: durableDispatch,
      history: durableHistory
    })
  }
  if (durable && durable.statusHash === hash) {
    const dispatch = recordedDispatch(durable.dispatch)
    return attachContext({
      id: raw.id,
      mode,
      stage: durable.stage,
      detail: durable.detail,
      statusHash: hash,
      ...(durable.nextAction ? { nextAction: durable.nextAction } : {}),
      ...(dispatch ? { dispatch } : {}),
      ...(durable.prUrl ? { prUrl: durable.prUrl } : {}),
      history: durableHistory,
      ...(durable.terminalOutcome ? { terminalOutcome: durable.terminalOutcome } : {})
    })
  }
  // A dispatch this journal never finished outlives the status line that provoked it. Without
  // this, a second `done` line would rehash the task into fresh, actionable work and dispatch a
  // continuation that may already be running.
  const unfinished = unfinishedDispatch(durable)
  if (unfinished) {
    return attachContext({
      id: raw.id,
      mode,
      stage: unfinished.stage,
      detail: durable?.detail ?? detail,
      statusHash: hash,
      nextAction: unfinished.nextAction,
      dispatch: unfinished.dispatch,
      history: durableHistory
    })
  }
  if (verb === 'done') {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'implemented',
      detail,
      statusHash: hash,
      ...(mode === 'no-mistakes' ? { nextAction: 'start-validation' as const } : {}),
      history: durableHistory
    })
  }
  if (verb === 'completed' || verb === 'cancelled' || verb === 'canceled') {
    return attachContext({
      id: raw.id,
      mode,
      stage: 'implemented',
      detail,
      statusHash: hash,
      history: durableHistory,
      terminalOutcome: verb === 'completed' ? 'completed' : 'cancelled'
    })
  }
  return undefined
}

export function firstMateLifecycleFromFiles(files: FirstMateLifecycleFiles): FirstMateLifecycleStatus {
  const journal = parseJournal(files.journal)
  const validator = firstMateValidatorFromRuntimeConfig(files.runtimeConfig)
  const rawTasks = new Map(files.tasks.map((task) => [task.id, task]))
  const closedTaskIds = new Set(
    Object.entries(journal.tasks)
      .filter(([id, record]) => {
        const raw = rawTasks.get(id)
        return record.prResolution !== undefined
          && (!raw || record.statusHash === statusHash(raw.status))
      })
      .map(([id]) => id)
  )
  for (const task of files.tasks) {
    const verb = statusParts(projectedStatusLine(task.status)).verb.toLowerCase()
    if (verb === 'cancelled' || verb === 'canceled' || verb === 'completed') closedTaskIds.add(task.id)
  }
  const tasks = files.tasks
    .map((task) => recordedTask(task, journal))
    .filter((task): task is FirstMateLifecycleTask => task !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
  const liveIds = new Set(tasks.map((task) => task.id))
  for (const [id, record] of Object.entries(journal.tasks)) {
    if (liveIds.has(id) || !record.terminalOutcome || !record.projection) continue
    tasks.push({
      ...record.projection,
      stage: record.stage,
      detail: record.detail,
      statusHash: record.statusHash,
      ...(record.nextAction ? { nextAction: record.nextAction } : {}),
      ...(record.dispatch ? { dispatch: record.dispatch } : {}),
      ...(record.prUrl ? { prUrl: record.prUrl } : {}),
      history: recordedHistory(record.history),
      ...(record.pendingDecisions ? { pendingDecisions: record.pendingDecisions } : {}),
      terminalOutcome: record.terminalOutcome
    })
    closedTaskIds.add(id)
  }
  tasks.sort((left, right) => left.id.localeCompare(right.id))
  return {
    supervision: 'app-native',
    ...(validator ? { validator } : {}),
    ...(closedTaskIds.size ? { closedTaskIds: [...closedTaskIds].sort() } : {}),
    tasks
  }
}

export function noMistakesInvocation(harness: string): string {
  if (/^codex(?:$|[-_])/.test(harness)) return '$no-mistakes'
  if (/^(claude|cursor|grok)(?:$|[-_])/.test(harness)) return '/no-mistakes'
  return 'Load the no-mistakes skill and continue validation now.'
}

export function noMistakesContinuation(
  harness: string,
  runtimeConfigPath: string,
  dispatchId: string,
  ledgerPath: string
): string {
  return `${noMistakesInvocation(harness)}\n\n`
    + `ADE validation dispatch id: ${dispatchId}. Treat this id as the idempotency key for this `
    + `continuation. ADE has durably recorded it in the shared dispatch ledger ${ledgerPath}. Before `
    + 'starting validation, consult that ledger: if this dispatch id is already recorded there as '
    + 'started or completed, do not begin a second validation run — report the existing run instead. '
    + 'Otherwise record it as started before you begin and as completed when you finish, so a repeated '
    + 'delivery of this identity is durably recognised rather than validated twice.\n\n'
    + `ADE has pinned this task's validator in ${runtimeConfigPath}. `
    + 'Treat that task-scoped structured record as authoritative. Before starting validation, use its validator to '
    + 'set NM_HOME to validator.nmHome plus ADE_FIRSTMATE_VALIDATOR_AGENT and ADE_FIRSTMATE_VALIDATOR_MODEL for this '
    + 'task; do not use a later global configuration, a conflicting inherited value, filtered doctor text, or guessed '
    + 'homes. Fail closed before starting a pipeline unless no-mistakes reports that exact task-scoped data directory '
    + 'and this disposable worktree\'s no-mistakes remote routes to the repository cache inside validator.nmHome; an '
    + 'inherited NM_HOME or stale worktree-local remote must never start validation in another task\'s cache. '
    + 'Continue this committed task directly through validation and report decisions, blockers, failures, and PR readiness '
    + 'through the existing FirstMate authority boundary.'
}

export function firstMateAppWakeMessage(tasks: FirstMateLifecycleTask[]): string {
  const summary = tasks.map((task) => {
    const context = task.context
    return `${task.id}=${task.stage}` + (context
      ? `[project=${context.project.adeProjectId};path=${context.project.wslPath};mode=${task.mode};`
        + `validator=${context.validator.agent}/${context.validator.model}]`
      : '')
  }).join(', ')
  return `\u2063FIRSTMATE_OP: v1 ade-app-wake: Durable task lifecycle changed: ${summary}. `
    + 'ADE is the captain conversation host; reconcile the listed task status and preserve the existing authority boundary.'
}

export function firstMateReconciliationFailureMessage(reason: string): string {
  return `\u2063FIRSTMATE_OP: v1 ade-app-wake: Lifecycle reconciliation failed: ${reason}. `
    + 'ADE will retry from durable task state; use the existing authority boundary if intervention is required.'
}
