import { isAgentProvider, type AgentProvider } from './agent-provider'
import {
  ORCHESTRATION_PACING_REASONS,
  type OrchestrationPacingRecommendation,
  type OrchestrationPacingReason,
  type OrchestrationUsageFreshness
} from './orchestration-pacing-types'
import { fileUrlOf } from './local-file-link'
import { isRecord } from './record'
import { SCRATCH_DIRECTORY_NAME } from './scratch-directory'
import { toucanPrompt } from './toucan-prompt'

/**
 * The orchestration record and the rules its writes are held to (#33; plan in
 * `docs/plans/orchestrator-mode.md`). An orchestrator is a chat node that splits one large task
 * into tickets and drives each to a merge; this is Toucan's tracker-independent state for one
 * orchestrator conversation - the task, the target branch, and per ticket its blockers, route,
 * spawned session, attempts and merge status. The orchestrator writes it through the CLI shipped
 * with its skill, and a resumed orchestrator (or a restarted Toucan) rebuilds its picture from it,
 * never from memory.
 *
 * Everything here is pure: main's endpoint (`src/main/orchestrator-endpoint.ts`) authorizes a call
 * and hands the payload to these functions, so what a plan may say is decided once, testable
 * without a listener. Keyed by `(provider, conversationId)` like conversation titles and outcome
 * records, because the conversation, not the canvas node, is what a resumed orchestrator is.
 */

/** The one role a chat node can carry. Set when the node is created and never changed after. */
export const ORCHESTRATOR_ROLE = 'orchestrator'
export type ChatNodeRole = typeof ORCHESTRATOR_ROLE

/** Narrows persisted or IPC input: a role is either absent or exactly the orchestrator's. */
export function isChatNodeRole(value: unknown): value is ChatNodeRole {
  return value === ORCHESTRATOR_ROLE
}

/**
 * The two environment variables an orchestrator's adapter process carries, beside
 * `TOUCAN_NODE_ID`. Only an orchestrator session has them; every other session has them removed,
 * even when Toucan itself inherited them from an orchestrator's shell.
 */
export const ORCHESTRATOR_URL_ENV = 'TOUCAN_ORCHESTRATOR_URL'
export const ORCHESTRATOR_TOKEN_ENV = 'TOUCAN_ORCHESTRATOR_TOKEN'

/** Where the CLI lives under a Toucan skills root (`.agents`), shipped with the `orchestrate` skill. */
export const ORCHESTRATE_SKILL_PATH = ['skills', 'orchestrate', 'SKILL.md'] as const
export const ORCHESTRATE_CLI_PATH = ['skills', 'orchestrate', 'scripts', 'orchestrate.mjs'] as const

/** The CLI's commands, as they travel to the endpoint. */
export const ORCHESTRATOR_COMMANDS = [
  'plan set',
  'plan show',
  'ticket update',
  'spawn',
  'status',
  'outcome',
  'followup',
  'route',
  'escalate',
  'merge',
  'cleanup',
  'discard',
  'report',
  'usage',
  'question add',
  'question resolve',
  'question list'
] as const
export type OrchestratorCommand = (typeof ORCHESTRATOR_COMMANDS)[number]

export const DIFFICULTY_TIERS = ['low', 'medium', 'high', 'frontier'] as const
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number]

export function isDifficultyTier(value: unknown): value is DifficultyTier {
  return DIFFICULTY_TIERS.includes(value as DifficultyTier)
}

/**
 * `answered` is a question-only ticket: its session answered in its final report and committed
 * nothing, so there is nothing to merge. The endpoint accepts it only on Git evidence.
 */
export const TICKET_MERGE_STATUSES = ['pending', 'merged', 'unmerged', 'answered'] as const
export type TicketMergeStatus = (typeof TICKET_MERGE_STATUSES)[number]

/** Done for good: nothing of the ticket is left to land, so it satisfies its dependents and is cleaned up. */
export function isTicketSettled(status: TicketMergeStatus): boolean {
  return status === 'merged' || status === 'answered'
}

/**
 * How a ticket was routed (#36): its difficulty tier, the model and effort the tier mapping gave it,
 * and who judged the tier. `route` and `escalate` write it; `ticket update` may still correct it.
 */
export interface TicketRoute {
  tier?: DifficultyTier
  model?: string
  effort?: string
  /** Jev's confidence in the tier; absent when the orchestrator supplied the tier itself. */
  confidence?: number
  /** Jev's reasoning-depth score (0-4), kept so an escalation settles its effort the same way. */
  depth?: number
  routedBy?: 'jev' | 'orchestrator'
  escalated?: boolean
  /** Jev's confidence was below the review threshold: the ticket runs on its tier and goes on the review list. */
  reviewRequired?: boolean
}

/** Every field a route may carry; anything else in a route is refused. */
export const TICKET_ROUTE_FIELDS = [
  'tier',
  'model',
  'effort',
  'confidence',
  'depth',
  'routedBy',
  'escalated',
  'reviewRequired'
] as const

/** The ticket session Toucan spawned for a ticket (#34). Toucan-owned: `ticket update` cannot set it. */
export interface TicketSession {
  nodeId?: string
  conversationId?: string
  worktreePath?: string
  branch?: string
}

export type TicketRunState = 'starting' | 'started'

/**
 * One ticket session a ticket was run in and the route it launched on (#40). `session` is only the
 * latest; the routing report needs every attempt, because an escalated ticket's failure belongs to
 * the tier it failed on, and `route` by then says the tier it was escalated to.
 */
export interface TicketRun {
  conversationId?: string
  /**
   * `starting` from the moment the canvas holds the session until it reports in (#1). Absent
   * once it has - and on every run recorded before this existed, which all had started.
   */
  state?: TicketRunState
  /**
   * The provider whose session ran it - the orchestrator's, since ticket sessions are
   * provider-homogeneous (#44). Absent on runs recorded before #47: read it through
   * `ticketRunProvider`.
   */
  provider?: AgentProvider
  route?: TicketRoute
  /**
   * Where the attempt ran (#4), so `discard --attempt <n>` can find attempt n and the unrecorded
   * detection counts every attempt's worktree and branch as recorded. Absent on runs recorded before.
   */
  nodeId?: string
  worktreePath?: string
  branch?: string
  /** The attempt was discarded: its session stopped, worktree removed and branch deleted. */
  discarded?: true
}

/**
 * The provider a run's session belongs to. A run without the field reads as Claude's: every
 * released Toucan spawned only Claude ticket sessions, whatever the orchestrator's provider. Codex
 * runs that unreleased #44 development builds recorded without it are miscounted as Claude's, an
 * accepted cost of never guessing from the record's provider.
 */
export function ticketRunProvider(run: Pick<TicketRun, 'provider'> | undefined): AgentProvider {
  return run?.provider ?? 'claude'
}

export interface OrchestrationTicket {
  id: string
  title: string
  /** The ticket's text when the plan was free text; absent when `source` references a tracker item. */
  body?: string
  /** A reference to a tracker item (an issue URL, `#12`, a file path) the orchestrator reads itself. */
  source?: string
  /** Ids of tickets in this record that must merge before this one starts. */
  blockedBy: string[]
  route?: TicketRoute
  session?: TicketSession
  /** Every spawned session, oldest first. Toucan-owned; absent in records written before #40. */
  runs?: TicketRun[]
  attempts: number
  mergeStatus: TicketMergeStatus
}

export type OrchestrationLifecycle =
  { status: 'paused'; resetsAt?: number; affectedNodeIds: string[] } | { status: 'stopped' }

/** A proactive spawn deferral, kept apart from an actual provider-rejection lifecycle pause. */
export interface OrchestrationPacingDeferral {
  state: 'drain' | 'pause'
  reason: OrchestrationPacingReason
  constrainingWindow: 'five_hour' | 'usage_freshness' | 'none'
  freshness: OrchestrationUsageFreshness
  activeTicketSessions: number
  retryAt?: number
  deferredAt: string
}

/**
 * The latest spawn the orchestrator forced past the usage limits - on the user's request or its own
 * judgement that the remaining usage suffices. An audit fact, never a gate.
 */
export interface OrchestrationPacingForced {
  ticketId: string
  /** The orchestrator node that forced it. */
  by: string
  at: string
  reason: string
}

/**
 * `record.pacing`: a pending deferral, the latest forced spawn, or both. Read the deferral through
 * `pacingDeferral`; a record holding only `forced` may attempt a spawn.
 */
export type OrchestrationRecordPacing =
  (OrchestrationPacingDeferral & { forced?: OrchestrationPacingForced }) | { forced: OrchestrationPacingForced }

/** The proactive deferral a record holds, without the forced-spawn audit beside it. */
export function pacingDeferral(
  record: Pick<OrchestrationRecord, 'pacing'> | undefined
): OrchestrationPacingDeferral | undefined {
  const pacing = record?.pacing
  if (!pacing || !('state' in pacing)) return undefined
  const { forced: _forced, ...deferral } = pacing
  return deferral
}

/** Keeps the forced-spawn audit when a write drops the deferral. */
const forcedOnly = (record: OrchestrationRecord): { pacing?: OrchestrationRecordPacing } =>
  record.pacing?.forced ? { pacing: { forced: record.pacing.forced } } : {}

export interface OrchestrationRecord {
  version: 1
  provider: AgentProvider
  conversationId: string
  /** The orchestrator's project checkout; every call is scoped to it. */
  projectPath: string
  task: string
  targetBranch: string
  tickets: OrchestrationTicket[]
  /**
   * How many ticket sessions this orchestration has spawned, retries and escalations included.
   * Toucan-owned and never reset by a re-plan; absent in records written before spawning existed,
   * which reads as none.
   */
  spawnCount?: number
  /**
   * The spawn count at which `spawn` stops and waits for the human's Continue (`spawnBudget`).
   * Toucan-owned, never reset by a re-plan; absent is one checkpoint (`SPAWNS_PER_CHECKPOINT`).
   */
  spawnBudget?: number
  /** Absent is the normal running state, preserving records written before pause/stop existed. */
  lifecycle?: OrchestrationLifecycle
  /**
   * Durable proactive pacing state. Without a deferral (`pacingDeferral`) this orchestration may
   * attempt a spawn; `forced` records the latest spawn forced past the usage limits.
   */
  pacing?: OrchestrationRecordPacing
  /**
   * Every question the orchestrator pinned for the human, resolved ones included, oldest first. Read
   * the open ones through `openOrchestrationQuestions`. Never reset by a re-plan; absent is none.
   */
  openQuestions?: OrchestrationQuestion[]
  createdAt: string
  updatedAt: string
}

/**
 * A question for the human, stored once and verbatim (#2): the orchestrator copies it with its
 * links and context the first time it is asked, and every later status message names only its id,
 * so the human finds the screenshots in the pinned question rather than scrolling up for them.
 */
export interface OrchestrationQuestion {
  /** `Q1`, `Q2`, ...: unique within the orchestration and never reused. */
  id: string
  /** The ticket it came from; settling that ticket resolves the question. */
  ticketId?: string
  /** Exactly as the orchestrator sent it, `file:///` links included. */
  markdown: string
  /**
   * The fixed answers the human may click, as a session's own decision panel offers them. Absent
   * is a plain-text question; an "Other" free-text answer is always offered beside these.
   */
  options?: OrchestrationQuestionOption[]
  /** Several options may be picked; only meaningful with `options`. */
  multiSelect?: true
  createdAt: string
  resolvedAt?: string
  /** The human's or orchestrator's note, or why Toucan resolved it. */
  resolution?: string
}

/** One clickable answer of a pinned question: the label is what the human sees and what the note carries. */
export interface OrchestrationQuestionOption {
  label: string
  description?: string
}

export interface OrchestrationIdentity {
  provider: AgentProvider
  conversationId: string
  projectPath: string
}

/** A ticket as `plan set` states it: what the orchestrator decides, none of the progress. */
export type PlannedTicket = Pick<OrchestrationTicket, 'id' | 'title' | 'body' | 'source' | 'blockedBy'>

export interface OrchestrationPlan {
  task: string
  targetBranch: string
  tickets: PlannedTicket[]
}

/** What `ticket update` may change: the orchestrator-owned fields, each optional. */
export type TicketUpdate = Partial<
  Pick<OrchestrationTicket, 'title' | 'body' | 'source' | 'blockedBy' | 'route' | 'attempts' | 'mergeStatus'>
>

type Outcome<K extends string, T> =
  ({ [key in K]: T } & { error?: undefined }) | ({ [key in K]?: undefined } & { error: string })

const refuse = (error: string): { error: string } => ({ error })

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

function parseBlockedBy(value: unknown, where: string): string[] | string {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(nonEmptyString)) return `${where}: blockedBy must be a list of ticket ids`
  return [...new Set(value.map((id) => id.trim()))]
}

function parsePlannedTicket(value: unknown, index: number): PlannedTicket | string {
  const where = `tickets[${index}]`
  if (!isRecord(value)) return `${where} must be an object`
  if (!nonEmptyString(value.id)) return `${where}: id must be a non-empty string`
  if (!nonEmptyString(value.title)) return `${where}: title must be a non-empty string`
  if (!optionalString(value.body)) return `${where}: body must be a string`
  if (!optionalString(value.source)) return `${where}: source must be a string`
  const blockedBy = parseBlockedBy(value.blockedBy, where)
  if (typeof blockedBy === 'string') return blockedBy
  return {
    id: value.id.trim(),
    title: value.title.trim(),
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    blockedBy
  }
}

/**
 * The dependency graph's one rule set, applied to a whole plan and again to every `blockedBy`
 * update: blockers must exist in the record, a ticket cannot wait for itself, and the graph must be
 * acyclic - merging in dependency order is impossible otherwise, and a cycle would leave every
 * ticket on it blocked forever.
 */
function dependencyError(tickets: ReadonlyArray<Pick<OrchestrationTicket, 'id' | 'blockedBy'>>): string | undefined {
  const ids = new Set<string>()
  for (const ticket of tickets) {
    if (ids.has(ticket.id)) return `duplicate ticket id "${ticket.id}"`
    ids.add(ticket.id)
  }
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy) {
      if (blocker === ticket.id) return `ticket "${ticket.id}" is blocked by itself`
      if (!ids.has(blocker)) return `ticket "${ticket.id}" is blocked by unknown ticket "${blocker}"`
    }
  }
  const blockersOf = new Map(tickets.map((ticket) => [ticket.id, ticket.blockedBy]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): string | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'visiting') return `dependency cycle: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}`
    state.set(id, 'visiting')
    for (const blocker of blockersOf.get(id) ?? []) {
      const cycle = visit(blocker, [...path, id])
      if (cycle) return cycle
    }
    state.set(id, 'done')
    return undefined
  }
  for (const ticket of tickets) {
    const cycle = visit(ticket.id, [])
    if (cycle) return cycle
  }
  return undefined
}

/** Validates what `plan set` sent. Ids and titles are trimmed; `blockedBy` is deduplicated. */
export function parsePlanInput(value: unknown): Outcome<'plan', OrchestrationPlan> {
  if (!isRecord(value)) return refuse('the plan must be a JSON object with task, targetBranch and tickets')
  if (!nonEmptyString(value.task)) return refuse('the plan needs a non-empty task')
  if (!nonEmptyString(value.targetBranch)) return refuse('the plan needs a non-empty targetBranch')
  if (!Array.isArray(value.tickets)) return refuse('the plan needs a tickets list')
  const tickets: PlannedTicket[] = []
  for (const [index, entry] of value.tickets.entries()) {
    const ticket = parsePlannedTicket(entry, index)
    if (typeof ticket === 'string') return refuse(ticket)
    tickets.push(ticket)
  }
  const invalid = dependencyError(tickets)
  if (invalid) return refuse(invalid)
  return { plan: { task: value.task, targetBranch: value.targetBranch.trim(), tickets } }
}

/**
 * Writes a plan into the record. Re-planning is allowed - a breakdown gets revised - but a ticket
 * that keeps its id keeps its progress (route, session, attempts, merge status), and a ticket that
 * already has a session cannot be dropped: that session is running work the record would otherwise
 * stop describing.
 */
export function applyPlan(
  existing: OrchestrationRecord | undefined,
  plan: OrchestrationPlan,
  identity: OrchestrationIdentity,
  now: string
): Outcome<'record', OrchestrationRecord> {
  const kept = new Set(plan.tickets.map((ticket) => ticket.id))
  const orphaned = existing?.tickets.find((ticket) => ticket.session && !kept.has(ticket.id))
  if (orphaned) return refuse(`ticket "${orphaned.id}" has a session and cannot be dropped from the plan`)
  const previous = new Map(existing?.tickets.map((ticket) => [ticket.id, ticket]))
  return {
    record: {
      version: 1,
      provider: identity.provider,
      conversationId: identity.conversationId,
      projectPath: identity.projectPath,
      task: plan.task,
      targetBranch: plan.targetBranch,
      tickets: plan.tickets.map((ticket) => {
        const before = previous.get(ticket.id)
        return {
          ...ticket,
          ...(before?.route ? { route: before.route } : {}),
          ...(before?.session ? { session: before.session } : {}),
          ...(before?.runs ? { runs: before.runs } : {}),
          attempts: before?.attempts ?? 0,
          mergeStatus: before?.mergeStatus ?? 'pending'
        }
      }),
      ...(existing?.spawnCount ? { spawnCount: existing.spawnCount } : {}),
      ...(existing?.spawnBudget ? { spawnBudget: existing.spawnBudget } : {}),
      ...(existing?.lifecycle ? { lifecycle: existing.lifecycle } : {}),
      ...(existing?.pacing ? { pacing: existing.pacing } : {}),
      ...(existing?.openQuestions ? { openQuestions: existing.openQuestions } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isNonNegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0

function parseRoute(value: unknown): TicketRoute | string {
  if (!isRecord(value)) return 'route must be an object'
  for (const key of Object.keys(value)) {
    if (!(TICKET_ROUTE_FIELDS as readonly string[]).includes(key)) {
      return `route has unknown field "${key}"`
    }
  }
  if (value.tier !== undefined && !isDifficultyTier(value.tier)) {
    return `route.tier must be one of ${DIFFICULTY_TIERS.join(', ')}`
  }
  if (!optionalString(value.model)) return 'route.model must be a string'
  if (!optionalString(value.effort)) return 'route.effort must be a string'
  if (
    value.confidence !== undefined &&
    !(isFiniteNumber(value.confidence) && value.confidence >= 0 && value.confidence <= 1)
  ) {
    return 'route.confidence must be a number from 0 to 1'
  }
  if (value.routedBy !== undefined && value.routedBy !== 'jev' && value.routedBy !== 'orchestrator') {
    return 'route.routedBy must be jev or orchestrator'
  }
  if (value.depth !== undefined && !(isFiniteNumber(value.depth) && value.depth >= 0 && value.depth <= 4)) {
    return 'route.depth must be a number from 0 to 4'
  }
  if (value.escalated !== undefined && typeof value.escalated !== 'boolean') return 'route.escalated must be a boolean'
  if (value.reviewRequired !== undefined && typeof value.reviewRequired !== 'boolean') {
    return 'route.reviewRequired must be a boolean'
  }
  return value
}

/** Fields `ticket update` never touches, each with the reason it gives. */
const PROTECTED_TICKET_FIELDS: Record<string, string> = {
  id: '"id" cannot be updated; re-plan with plan set instead',
  session: '"session" is set by Toucan when it spawns the ticket session',
  runs: '"runs" is kept by Toucan: one entry per spawned ticket session'
}

/** Validates a `ticket update` patch. An empty patch is refused: it is always a mistake. */
export function parseTicketUpdate(value: unknown): Outcome<'patch', TicketUpdate> {
  if (!isRecord(value)) return refuse('the update must be a JSON object of ticket fields')
  const patch: TicketUpdate = {}
  for (const [key, field] of Object.entries(value)) {
    const protectedReason = PROTECTED_TICKET_FIELDS[key]
    if (protectedReason) return refuse(protectedReason)
    switch (key) {
      case 'title':
        if (!nonEmptyString(field)) return refuse('title must be a non-empty string')
        patch.title = field.trim()
        break
      case 'body':
      case 'source':
        if (typeof field !== 'string') return refuse(`${key} must be a string`)
        patch[key] = field
        break
      case 'blockedBy': {
        const blockedBy = parseBlockedBy(field, 'update')
        if (typeof blockedBy === 'string') return refuse(blockedBy)
        patch.blockedBy = blockedBy
        break
      }
      case 'route': {
        const route = parseRoute(field)
        if (typeof route === 'string') return refuse(route)
        patch.route = route
        break
      }
      case 'attempts':
        if (!isNonNegativeInteger(field)) {
          return refuse('attempts must be a non-negative integer')
        }
        patch.attempts = field
        break
      case 'mergeStatus':
        if (!TICKET_MERGE_STATUSES.includes(field as TicketMergeStatus)) {
          return refuse(`mergeStatus must be one of ${TICKET_MERGE_STATUSES.join(', ')}`)
        }
        patch.mergeStatus = field as TicketMergeStatus
        break
      default:
        return refuse(`unknown field "${key}"`)
    }
  }
  if (Object.keys(patch).length === 0) return refuse('the update names no fields')
  return { patch }
}

export function applyTicketUpdate(
  record: OrchestrationRecord,
  ticketId: string,
  patch: TicketUpdate,
  now: string
): Outcome<'record', OrchestrationRecord> {
  if (!record.tickets.some((ticket) => ticket.id === ticketId)) return refuse(`the plan has no ticket "${ticketId}"`)
  const tickets = record.tickets.map((ticket) => (ticket.id === ticketId ? { ...ticket, ...patch } : ticket))
  if (patch.blockedBy) {
    const invalid = dependencyError(tickets)
    if (invalid) return refuse(invalid)
  }
  const updated = { ...record, tickets, updatedAt: now }
  return {
    record:
      patch.mergeStatus && isTicketSettled(patch.mergeStatus)
        ? resolveTicketQuestions(updated, ticketId, `ticket ${ticketId} ${patch.mergeStatus}`, now)
        : updated
  }
}

/**
 * The longest question `question add` takes. It is refused rather than clipped, because the point
 * of the record is the verbatim text; a report longer than this belongs in a scratch file it links.
 * @internal exported for tests
 */
export const ORCHESTRATION_QUESTION_LIMIT = 16_000

const QUESTION_ID = /^Q([1-9][0-9]*)$/

/** Whether `value` is a question id as `question add` issues them: `Q1`, `Q2`, ... */
export function isOrchestrationQuestionId(value: string): boolean {
  return QUESTION_ID.test(value)
}

/** The questions still waiting for the human, oldest first. */
export function openOrchestrationQuestions(
  record: Pick<OrchestrationRecord, 'openQuestions'>
): OrchestrationQuestion[] {
  return (record.openQuestions ?? []).filter((question) => question.resolvedAt === undefined)
}

/** The most clickable answers a pinned question may carry, and the longest label and description. */
export const ORCHESTRATION_QUESTION_OPTION_LIMITS = { count: 12, label: 200, description: 500 } as const

/** What `question add` stores for a question: its ticket, markdown and, optionally, clickable answers. */
export interface OrchestrationQuestionInput {
  ticketId?: string
  markdown: string
  options?: OrchestrationQuestionOption[]
  multiSelect?: true
}

/** Validates and trims a list of options, however it arrived (`--options`, or a session's pending question). */
export function parseQuestionOptions(value: unknown): Outcome<'options', OrchestrationQuestionOption[]> {
  const limits = ORCHESTRATION_QUESTION_OPTION_LIMITS
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.count) {
    return refuse(`question add --options needs a JSON array of 1 to ${limits.count} options`)
  }
  const options: OrchestrationQuestionOption[] = []
  for (const entry of value as unknown[]) {
    // A bare string is the label: `["Yes", "No"]` is the common case.
    const option = typeof entry === 'string' ? { label: entry } : entry
    if (!isRecord(option) || Object.keys(option).some((key) => key !== 'label' && key !== 'description')) {
      return refuse('question add --options entries are a label or { "label", "description"? }')
    }
    if (!nonEmptyString(option.label) || option.label.trim().length > limits.label) {
      return refuse(`every option needs a label of 1 to ${limits.label} characters`)
    }
    if (
      option.description !== undefined &&
      (!nonEmptyString(option.description) || option.description.trim().length > limits.description)
    ) {
      return refuse(`an option's description is 1 to ${limits.description} characters`)
    }
    const label = option.label.trim()
    if (options.some((candidate) => candidate.label === label)) return refuse(`the option "${label}" is given twice`)
    options.push({ label, ...(nonEmptyString(option.description) ? { description: option.description.trim() } : {}) })
  }
  return { options }
}

/**
 * Validates `question add`'s optional `--ticket <id>`, the markdown the CLI read from `--text` or
 * `--file`, and the optional clickable answers (`--options`, `--multi`).
 */
export function parseQuestionAddInput(
  value: unknown
): Outcome<'add', OrchestrationQuestionInput & { optionsFromSession?: true }> {
  const args = isRecord(value) ? value : {}
  if (
    Object.keys(args).some(
      (key) => !['ticket', 'markdown', 'options', 'multiSelect', 'optionsFromSession'].includes(key)
    )
  ) {
    return refuse(
      'question add takes only [--ticket <id>] --text <markdown> or --file <markdown file> [--options <json> | --options-file <file> [--multi] | --options-from-session]'
    )
  }
  if (args.ticket !== undefined && !nonEmptyString(args.ticket))
    return refuse('question add --ticket needs a ticket id')
  if (!nonEmptyString(args.markdown)) return refuse('question add needs --text <markdown> or --file <markdown file>')
  if (args.markdown.length > ORCHESTRATION_QUESTION_LIMIT) {
    return refuse(
      `the question is longer than ${ORCHESTRATION_QUESTION_LIMIT} characters; save the long part in the scratch folder and link it`
    )
  }
  if (args.multiSelect !== undefined && args.multiSelect !== true) return refuse('question add --multi takes no value')
  if (args.optionsFromSession !== undefined && args.optionsFromSession !== true) {
    return refuse('question add --options-from-session takes no value')
  }
  if (args.optionsFromSession === true) {
    if (args.options !== undefined || args.multiSelect !== undefined) {
      return refuse(
        'question add --options-from-session takes the options from the ticket session; it cannot be combined with --options, --options-file or --multi'
      )
    }
    if (!nonEmptyString(args.ticket)) {
      return refuse(
        "question add --options-from-session needs --ticket <id>, the ticket whose session's question it copies"
      )
    }
  }
  if (args.multiSelect === true && args.options === undefined) return refuse('question add --multi needs --options')
  const parsed = args.options === undefined ? undefined : parseQuestionOptions(args.options)
  if (parsed?.error !== undefined) return refuse(parsed.error)
  return {
    add: {
      ...(nonEmptyString(args.ticket) ? { ticketId: args.ticket.trim() } : {}),
      markdown: args.markdown,
      ...(args.optionsFromSession === true ? { optionsFromSession: true as const } : {}),
      ...(parsed?.options ? { options: parsed.options } : {}),
      ...(parsed?.options && args.multiSelect === true ? { multiSelect: true as const } : {})
    }
  }
}

/** Validates `question resolve --id <Q<n>> [--note <text>]`; `3` and `q3` both read as `Q3`. */
export function parseQuestionResolveInput(value: unknown): Outcome<'resolve', { id: string; note?: string }> {
  const args = isRecord(value) ? value : {}
  if (Object.keys(args).some((key) => key !== 'id' && key !== 'note')) {
    return refuse('question resolve takes only --id <Q<n>> [--note <text>]')
  }
  const id = typeof args.id === 'string' ? `Q${args.id.trim().replace(/^q/i, '')}` : ''
  if (!QUESTION_ID.test(id)) return refuse('question resolve needs --id <Q<n>>, the id question add returned')
  if (args.note !== undefined && !nonEmptyString(args.note)) return refuse('question resolve --note needs a text')
  return { resolve: { id, ...(nonEmptyString(args.note) ? { note: args.note.trim() } : {}) } }
}

/** Validates `question list [--all]`: open questions by default, every one with `--all`. */
export function parseQuestionListInput(value: unknown): Outcome<'list', { all: boolean }> {
  if (value === undefined) return { list: { all: false } }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'all') ||
    (value.all !== undefined && value.all !== true)
  ) {
    return refuse('question list takes only an optional --all')
  }
  return { list: { all: value.all === true } }
}

/** The next free id: one past the highest ever issued, so a resolved question's id is never reused. */
function nextQuestionId(questions: readonly OrchestrationQuestion[]): string {
  const highest = Math.max(0, ...questions.map((question) => Number(QUESTION_ID.exec(question.id)?.[1] ?? 0)))
  return `Q${highest + 1}`
}

/** Pins a question. A ticket it names must be in the plan and not yet settled. */
export function addOrchestrationQuestion(
  record: OrchestrationRecord,
  input: OrchestrationQuestionInput,
  now: string
): Outcome<'record', OrchestrationRecord> & { question?: OrchestrationQuestion } {
  if (input.ticketId !== undefined) {
    const ticket = record.tickets.find((candidate) => candidate.id === input.ticketId)
    if (!ticket) return refuse(`the plan has no ticket "${input.ticketId}"`)
    if (isTicketSettled(ticket.mergeStatus)) return refuse(`ticket ${ticket.id} is already ${ticket.mergeStatus}`)
  }
  const questions = record.openQuestions ?? []
  const question: OrchestrationQuestion = {
    id: nextQuestionId(questions),
    ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
    markdown: input.markdown,
    ...(input.options ? { options: input.options, ...(input.multiSelect ? { multiSelect: true as const } : {}) } : {}),
    createdAt: now
  }
  return { record: { ...record, openQuestions: [...questions, question], updatedAt: now }, question }
}

/**
 * Resolves one question. Resolving it again changes nothing (`changed: false`) and keeps the first
 * resolution, so a stale second press from the UI wakes nobody.
 */
export function resolveOrchestrationQuestion(
  record: OrchestrationRecord,
  id: string,
  now: string,
  note?: string
): Outcome<'record', OrchestrationRecord> & { question?: OrchestrationQuestion; changed?: boolean } {
  const questions = record.openQuestions ?? []
  const existing = questions.find((question) => question.id === id)
  if (!existing) return refuse(`this orchestration has no question ${id}`)
  if (existing.resolvedAt !== undefined) return { record, question: existing, changed: false }
  const question: OrchestrationQuestion = { ...existing, resolvedAt: now, ...(note ? { resolution: note } : {}) }
  return {
    record: {
      ...record,
      openQuestions: questions.map((candidate) => (candidate.id === id ? question : candidate)),
      updatedAt: now
    },
    question,
    changed: true
  }
}

/** A settled ticket's open questions are moot: nothing of it is left to ask about. */
function resolveTicketQuestions(
  record: OrchestrationRecord,
  ticketId: string,
  resolution: string,
  now: string
): OrchestrationRecord {
  if (!record.openQuestions?.some((question) => question.ticketId === ticketId && question.resolvedAt === undefined)) {
    return record
  }
  return {
    ...record,
    openQuestions: record.openQuestions.map((question) =>
      question.ticketId === ticketId && question.resolvedAt === undefined
        ? { ...question, resolvedAt: now, resolution }
        : question
    )
  }
}

function isTicketSession(value: unknown): value is TicketSession {
  return isRecord(value) && [value.nodeId, value.conversationId, value.worktreePath, value.branch].every(optionalString)
}

function isTicketRun(value: unknown): value is TicketRun {
  return (
    isRecord(value) &&
    optionalString(value.conversationId) &&
    optionalString(value.nodeId) &&
    optionalString(value.worktreePath) &&
    optionalString(value.branch) &&
    (value.discarded === undefined || value.discarded === true) &&
    (value.state === undefined || value.state === 'starting' || value.state === 'started') &&
    (value.provider === undefined || isAgentProvider(value.provider)) &&
    (value.route === undefined || typeof parseRoute(value.route) !== 'string')
  )
}

function isOrchestrationTicket(value: unknown): value is OrchestrationTicket {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.title) &&
    optionalString(value.body) &&
    optionalString(value.source) &&
    Array.isArray(value.blockedBy) &&
    value.blockedBy.every(nonEmptyString) &&
    (value.route === undefined || typeof parseRoute(value.route) !== 'string') &&
    (value.session === undefined || isTicketSession(value.session)) &&
    (value.runs === undefined || (Array.isArray(value.runs) && value.runs.every(isTicketRun))) &&
    isFiniteNumber(value.attempts) &&
    TICKET_MERGE_STATUSES.includes(value.mergeStatus as TicketMergeStatus)
  )
}

function isOrchestrationLifecycle(value: unknown): value is OrchestrationLifecycle {
  if (!isRecord(value)) return false
  if (value.status === 'stopped') return Object.keys(value).every((key) => key === 'status')
  return (
    value.status === 'paused' &&
    (value.resetsAt === undefined || isFiniteNumber(value.resetsAt)) &&
    Array.isArray(value.affectedNodeIds) &&
    value.affectedNodeIds.every(nonEmptyString)
  )
}

function isOrchestrationPacingForced(value: unknown): value is OrchestrationPacingForced {
  return (
    isRecord(value) &&
    nonEmptyString(value.ticketId) &&
    nonEmptyString(value.by) &&
    nonEmptyString(value.at) &&
    nonEmptyString(value.reason)
  )
}

function isOrchestrationRecordPacing(value: unknown): value is OrchestrationRecordPacing {
  if (!isRecord(value)) return false
  if (value.forced !== undefined && !isOrchestrationPacingForced(value.forced)) return false
  if (value.state === undefined) return value.forced !== undefined && Object.keys(value).length === 1
  return isOrchestrationPacingDeferral(value)
}

function isOrchestrationPacingDeferral(value: unknown): value is OrchestrationPacingDeferral {
  return (
    isRecord(value) &&
    (value.state === 'drain' || value.state === 'pause') &&
    ORCHESTRATION_PACING_REASONS.includes(value.reason as OrchestrationPacingReason) &&
    (value.constrainingWindow === 'five_hour' ||
      value.constrainingWindow === 'usage_freshness' ||
      value.constrainingWindow === 'none') &&
    (value.freshness === 'fresh' || value.freshness === 'stale' || value.freshness === 'unavailable') &&
    isNonNegativeInteger(value.activeTicketSessions) &&
    (value.retryAt === undefined || isFiniteNumber(value.retryAt)) &&
    nonEmptyString(value.deferredAt)
  )
}

function isQuestionOptionList(value: unknown): value is OrchestrationQuestionOption[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((option) => isRecord(option) && nonEmptyString(option.label) && optionalString(option.description))
  )
}

function isOrchestrationQuestion(value: unknown): value is OrchestrationQuestion {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    QUESTION_ID.test(value.id) &&
    (value.ticketId === undefined || nonEmptyString(value.ticketId)) &&
    nonEmptyString(value.markdown) &&
    (value.options === undefined || isQuestionOptionList(value.options)) &&
    (value.multiSelect === undefined || (value.multiSelect === true && value.options !== undefined)) &&
    typeof value.createdAt === 'string' &&
    optionalString(value.resolvedAt) &&
    optionalString(value.resolution)
  )
}

function isOrchestrationQuestionList(value: unknown): value is OrchestrationQuestion[] {
  return (
    Array.isArray(value) &&
    value.every(isOrchestrationQuestion) &&
    new Set(value.map((question) => question.id)).size === value.length
  )
}

/** The store's parse predicate: a record on disk is used only if every field still holds. */
export function isOrchestrationRecord(value: unknown): value is OrchestrationRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isAgentProvider(value.provider) &&
    nonEmptyString(value.conversationId) &&
    nonEmptyString(value.projectPath) &&
    typeof value.task === 'string' &&
    typeof value.targetBranch === 'string' &&
    Array.isArray(value.tickets) &&
    value.tickets.every(isOrchestrationTicket) &&
    (value.spawnCount === undefined || isNonNegativeInteger(value.spawnCount)) &&
    (value.spawnBudget === undefined || (isNonNegativeInteger(value.spawnBudget) && value.spawnBudget > 0)) &&
    (value.lifecycle === undefined || isOrchestrationLifecycle(value.lifecycle)) &&
    (value.pacing === undefined || isOrchestrationRecordPacing(value.pacing)) &&
    (value.openQuestions === undefined || isOrchestrationQuestionList(value.openQuestions)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

/**
 * How many ticket sessions an orchestration may spawn before it waits for the human, retries and
 * escalations included (#34). A checkpoint against a runaway loop, not a cap and not a concurrency
 * limit: reaching it refuses `spawn` with `budgetReached` until the human presses Continue, which
 * raises the budget by another checkpoint (`continueSpawnBudget`). How many run at once is the
 * human's call.
 */
export const SPAWNS_PER_CHECKPOINT = 20

/** The spawn count at which this orchestration next waits for the human. */
export function spawnBudget(record: Pick<OrchestrationRecord, 'spawnBudget'>): number {
  return record.spawnBudget ?? SPAWNS_PER_CHECKPOINT
}

/** Whether the orchestration has used its spawn budget and now waits for the human's Continue. */
export function spawnBudgetReached(record: Pick<OrchestrationRecord, 'spawnBudget' | 'spawnCount'>): boolean {
  return (record.spawnCount ?? 0) >= spawnBudget(record)
}

/**
 * The human's Continue: raises the budget by another checkpoint. It acts only on a record that has
 * reached its budget, so a second press on a stale button cannot raise it twice.
 */
export function continueSpawnBudget(record: OrchestrationRecord, now: string): OrchestrationRecord {
  if (record.lifecycle?.status === 'stopped' || !spawnBudgetReached(record)) return record
  return { ...record, spawnBudget: spawnBudget(record) + SPAWNS_PER_CHECKPOINT, updatedAt: now }
}

/** The implementation skill a ticket session's prompt opens with, until #36 makes it configurable. */
export const DEFAULT_IMPLEMENTATION_SKILL = '/implement'

/**
 * What `spawn` asks for. Ticket sessions use their orchestrator's provider. Either an
 * explicit model with its effort, or a tier the tier mapping resolves (#36), or neither - then the
 * ticket's recorded route decides.
 */
export interface SpawnInput {
  ticketId: string
  /** When supplied, must match the orchestrator's provider. */
  provider?: AgentProvider
  model?: string
  tier?: DifficultyTier
  /** Required with `model`; with a tier or the recorded route it overrides the resolved effort. */
  effort?: string
  /** The project the caller names, if it names one; refused unless it is the orchestrator's own. */
  projectPath?: string
  /**
   * Start regardless of the usage limits: skips proactive pacing and resumes a reactive pause.
   * Always comes with `forceReason`, which the record keeps.
   */
  force?: true
  forceReason?: string
  /** Stop the ticket's unresolved attempt first instead of refusing as a duplicate (#2). */
  replace?: true
  /**
   * Link this unrecorded worktree (and its live session, if any) to the ticket as its current
   * attempt instead of spawning (#4). Takes nothing else but the ticket.
   */
  adopt?: string
}

const tierError = (flag: string): string => `${flag} must be one of ${DIFFICULTY_TIERS.join(', ')}`

/** Validates what `spawn` sent - the CLI's `--ticket`, `--model`/`--tier`, `--effort` and optional flags. */
export function parseSpawnInput(value: unknown): Outcome<'spawn', SpawnInput> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('spawn needs --ticket <id>')
  if (args.adopt !== undefined) {
    if (!nonEmptyString(args.adopt)) return refuse('spawn --adopt needs the unrecorded worktree path')
    if (!optionalString(args.project)) return refuse('--project must be a path')
    const extra = ['model', 'tier', 'effort', 'provider', 'force', 'reason', 'replace'].filter(
      (key) => args[key] !== undefined
    )
    if (extra.length > 0)
      return refuse('spawn --adopt takes only --ticket <id> and the worktree path, not other spawn flags')
    return {
      spawn: {
        ticketId: args.ticket.trim(),
        adopt: args.adopt.trim(),
        ...(nonEmptyString(args.project) ? { projectPath: args.project.trim() } : {})
      }
    }
  }
  if (args.model !== undefined && args.tier !== undefined) {
    return refuse('spawn takes --model <id> --effort <level> or --tier <tier>, not both')
  }
  if (args.model !== undefined && !nonEmptyString(args.model)) return refuse('spawn needs --model <id>')
  if (args.tier !== undefined && !isDifficultyTier(args.tier)) return refuse(tierError('--tier'))
  if (args.effort !== undefined && !nonEmptyString(args.effort)) return refuse('spawn needs --effort <level>')
  if (nonEmptyString(args.model) && !nonEmptyString(args.effort)) return refuse('spawn --model needs --effort <level>')
  if (args.model === undefined && args.tier === undefined && args.effort !== undefined) {
    return refuse('spawn --effort goes with --model <id> or --tier <tier>')
  }
  if (args.provider !== undefined && !isAgentProvider(args.provider)) {
    return refuse(`provider ${JSON.stringify(args.provider)} is not supported`)
  }
  if (!optionalString(args.project)) return refuse('--project must be a path')
  if (args.force !== undefined && args.force !== true) return refuse('--force takes no value')
  if (args.force === true && !nonEmptyString(args.reason)) {
    return refuse('spawn --force needs --reason <why>: the user asked, or why the remaining usage suffices')
  }
  if (args.force !== true && args.reason !== undefined) return refuse('--reason goes with --force')
  if (args.replace !== undefined && args.replace !== true) return refuse('--replace takes no value')
  return {
    spawn: {
      ticketId: args.ticket.trim(),
      ...(isAgentProvider(args.provider) ? { provider: args.provider } : {}),
      ...(nonEmptyString(args.model) ? { model: args.model.trim() } : {}),
      ...(isDifficultyTier(args.tier) ? { tier: args.tier } : {}),
      ...(nonEmptyString(args.effort) ? { effort: args.effort.trim() } : {}),
      ...(nonEmptyString(args.project) ? { projectPath: args.project.trim() } : {}),
      ...(args.force === true && nonEmptyString(args.reason)
        ? { force: true as const, forceReason: args.reason.trim() }
        : {}),
      ...(args.replace === true ? { replace: true as const } : {})
    }
  }
}

/**
 * Tickets the user may ask to start now: not settled, not yet spawned, and with every blocker
 * settled. The endpoint re-checks all of this at spawn time; the list only decides what the UI offers.
 */
export function startableTickets(record: OrchestrationRecord): OrchestrationTicket[] {
  if (record.lifecycle?.status === 'stopped') return []
  const settled = new Set(
    record.tickets.filter((ticket) => isTicketSettled(ticket.mergeStatus)).map((ticket) => ticket.id)
  )
  return record.tickets.filter(
    (ticket) =>
      !isTicketSettled(ticket.mergeStatus) &&
      !ticket.session &&
      ticket.blockedBy.every((blocker) => settled.has(blocker))
  )
}

/**
 * What `route` asks for (#36): nothing, and Jev judges every unrouted ticket; or one ticket and the
 * tier the orchestrator judged itself - the way through when Jev is unavailable.
 */
export function parseRouteInput(value: unknown): Outcome<'route', { ticketId?: string; tier?: DifficultyTier }> {
  const args = isRecord(value) ? value : {}
  if (args.ticket === undefined && args.tier === undefined) return { route: {} }
  if (!nonEmptyString(args.ticket)) return refuse('route --tier needs --ticket <id>')
  if (args.tier === undefined) return refuse('route --ticket needs --tier <tier>, the tier you judged yourself')
  if (!isDifficultyTier(args.tier)) return refuse(tierError('--tier'))
  return { route: { ticketId: args.ticket.trim(), tier: args.tier } }
}

/** Validates `escalate`'s `--ticket <id>`. */
export function parseEscalateInput(value: unknown): Outcome<'ticketId', string> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('escalate needs --ticket <id>')
  return { ticketId: args.ticket.trim() }
}

/** Writes a ticket's route; the one write `route`, `escalate` and `spawn` share. */
export function recordTicketRoute(
  record: OrchestrationRecord,
  ticketId: string,
  route: TicketRoute,
  now: string
): OrchestrationRecord {
  const tickets = record.tickets.map((ticket) => (ticket.id === ticketId ? { ...ticket, route } : ticket))
  return { ...record, tickets, updatedAt: now }
}

/** A refusal at the spawn budget carries `budgetReached`, the machine-readable "wait for Continue". */
export type SpawnReservation = Outcome<'record', OrchestrationRecord> & { budgetReached?: true }

/**
 * Counts one spawn against the record before anything is created, so a spawn that fails later -
 * a worktree git refuses, a setup command that exits non-zero - still counts: the budget bounds
 * attempts, and an attempt that failed is exactly what a runaway loop is made of.
 */
export function reserveSpawn(record: OrchestrationRecord, ticketId: string, now: string): SpawnReservation {
  const ticket = record.tickets.find((candidate) => candidate.id === ticketId)
  if (!ticket) return refuse(`the plan has no ticket "${ticketId}"`)
  if (record.lifecycle?.status === 'paused') {
    return refuse(
      record.lifecycle.resetsAt === undefined
        ? 'this orchestration is paused until its usage reset is known'
        : `this orchestration is paused until ${new Date(record.lifecycle.resetsAt).toISOString()}`
    )
  }
  if (record.lifecycle?.status === 'stopped') return refuse('this orchestration has been stopped')
  if (isTicketSettled(ticket.mergeStatus)) return refuse(`ticket ${ticketId} is already ${ticket.mergeStatus}`)
  const blockers = ticket.blockedBy.filter((id) => {
    const blocker = record.tickets.find((candidate) => candidate.id === id)
    return !blocker || !isTicketSettled(blocker.mergeStatus)
  })
  if (blockers.length > 0) return refuse(`ticket ${ticketId} has unmerged blockers: ${blockers.join(', ')}`)
  if (spawnBudgetReached(record)) {
    return {
      ...refuse(
        `this orchestration has used its spawn budget of ${spawnBudget(record)} (retries and escalations count) and ` +
          'is waiting for the human to press Continue (+${SPAWNS_PER_CHECKPOINT}) on your node. End your turn now: Toucan wakes you when ' +
          'they do, then retry the spawn. Do not poll, sleep or give up on the orchestration'
      ),
      budgetReached: true
    }
  }
  return { record: { ...record, spawnCount: (record.spawnCount ?? 0) + 1, updatedAt: now } }
}

/** The latest attempt of a ticket that still holds it (#2): what `spawn` names when it refuses. */
export interface UnresolvedAttempt {
  /** One-based, counted over the ticket's `runs`. */
  attempt: number
  nodeId?: string
  branch?: string
  worktreePath?: string
  /** `starting` (not yet reporting in), or the live session's status: `working`, `ready` (awaiting review) ... */
  state: string
}

/**
 * Whether a ticket's latest attempt is still unresolved, which makes a plain `spawn` of it a
 * duplicate (#2). `live` is the broker's status for the session, undefined when Toucan is not
 * running it. The rule, in order:
 *
 * - no recorded session, or the ticket merged/answered: nothing to guard (a settled ticket is
 *   refused by `reserveSpawn` anyway);
 * - the run is `starting`, or the session is `starting`, `working` or `auth_required`: unresolved,
 *   whatever the route says - work in flight is never overlapped silently;
 * - the session is `ready`, i.e. settled and awaiting review: unresolved, unless the ticket was
 *   escalated since the attempt launched (its route now differs from the run's launch route), which
 *   is the orchestrator's verdict that the attempt failed;
 * - the session is `exited`, or Toucan is not running it (closed, stopped, killed, a restart): resolved.
 *
 * A start that failed is already unlinked by `abandonTicketSession`, so it never reaches this.
 */
export function unresolvedAttempt(
  ticket: OrchestrationTicket,
  live: { status: string } | undefined
): UnresolvedAttempt | undefined {
  const session = ticket.session
  if (!session || isTicketSettled(ticket.mergeStatus)) return undefined
  const runs = ticket.runs ?? []
  const last = runs[runs.length - 1]
  if (last?.discarded) return undefined
  const starting = last?.state === 'starting'
  const state = live?.status ?? (starting ? 'starting' : undefined)
  if (state === undefined || state === 'exited') return undefined
  if (state === 'ready' && !starting) {
    const launched = last?.route
    const escalatedSince =
      ticket.route?.escalated === true &&
      (launched?.tier !== ticket.route.tier || launched?.model !== ticket.route.model)
    if (escalatedSince) return undefined
  }
  return {
    attempt: Math.max(runs.length, 1),
    ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    ...(session.branch ? { branch: session.branch } : {}),
    ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
    state
  }
}

/** The refusal text for a duplicate spawn. */
export function duplicateSpawnMessage(ticketId: string, attempt: UnresolvedAttempt): string {
  return (
    `ticket ${ticketId} already has an unresolved attempt: attempt ${attempt.attempt}, ` +
    `branch ${attempt.branch ?? 'unknown'}, worktree ${attempt.worktreePath ?? 'unknown'}, state ${attempt.state}. ` +
    'Do not spawn it again: wait for its wake or check status. To discard that attempt and start a new one, ' +
    'spawn again with --replace, which stops the old session first'
  )
}

/** Records a proactive provider-wide deferral without consuming a spawn or changing ticket work. */
export function deferOrchestration(
  record: OrchestrationRecord,
  recommendation: OrchestrationPacingRecommendation,
  now: string
): OrchestrationRecord {
  if (record.lifecycle !== undefined || recommendation.state === 'unrestricted') return record
  const pacing: OrchestrationPacingDeferral = {
    state: recommendation.state,
    reason: recommendation.reason,
    constrainingWindow: recommendation.constrainingWindow,
    freshness: recommendation.freshness,
    activeTicketSessions: recommendation.activeTicketSessions,
    ...(recommendation.resetsAt !== undefined ? { retryAt: recommendation.resetsAt } : {}),
    deferredAt: pacingDeferral(record)?.deferredAt ?? now
  }
  const forced = record.pacing?.forced
  return { ...record, pacing: { ...pacing, ...(forced ? { forced } : {}) }, updatedAt: now }
}

/**
 * Clears only proactive pacing; a provider-rejection pause, a stopped record and the forced-spawn
 * audit remain intact.
 */
export function clearOrchestrationPacing(record: OrchestrationRecord, now: string): OrchestrationRecord {
  if (!pacingDeferral(record)) return record
  const { pacing: _pacing, ...running } = record
  return { ...running, ...forcedOnly(record), updatedAt: now }
}

/**
 * A spawn forced past the usage limits: any pending deferral is cleared and
 * the override is recorded. Every other spawn gate stays with `reserveSpawn`.
 */
export function recordForcedSpawn(
  record: OrchestrationRecord,
  forced: OrchestrationPacingForced,
  now: string
): OrchestrationRecord {
  const { pacing: _pacing, ...running } = record
  return { ...running, pacing: { forced }, updatedAt: now }
}

/** Records a provider usage pause without turning it into a ticket attempt or escalation. */
export function pauseOrchestration(
  record: OrchestrationRecord,
  affectedNodeId: string | undefined,
  resetsAt: number | undefined,
  now: string
): OrchestrationRecord {
  if (record.lifecycle?.status === 'stopped') return record
  const { pacing: _pacing, ...withoutProactivePacing } = record
  const previous = record.lifecycle?.status === 'paused' ? record.lifecycle : undefined
  const knownResets = [previous?.resetsAt, resetsAt].filter((value): value is number => value !== undefined)
  return {
    ...withoutProactivePacing,
    ...forcedOnly(record),
    lifecycle: {
      status: 'paused',
      ...(knownResets.length > 0 ? { resetsAt: Math.max(...knownResets) } : {}),
      affectedNodeIds: [...new Set([...(previous?.affectedNodeIds ?? []), ...(affectedNodeId ? [affectedNodeId] : [])])]
    },
    updatedAt: now
  }
}

/** Clears only a pause. A stopped orchestration cannot be restarted accidentally. */
export function resumeOrchestration(record: OrchestrationRecord, now: string): OrchestrationRecord {
  if (record.lifecycle?.status !== 'paused') return record
  const { lifecycle: _lifecycle, ...running } = record
  return { ...running, updatedAt: now }
}

/** Permanently retires this orchestration while retaining its plan and ticket history. */
export function stopOrchestration(record: OrchestrationRecord, now: string): OrchestrationRecord {
  if (record.lifecycle?.status === 'stopped') return record
  const { pacing: _pacing, ...withoutProactivePacing } = record
  return { ...withoutProactivePacing, ...forcedOnly(record), lifecycle: { status: 'stopped' }, updatedAt: now }
}

/**
 * Records the ticket session Toucan spawned and the route it launched on; with `updateTicketSession`
 * and `abandonTicketSession` the only writes to `session` and `runs`, which `ticket update` refuses.
 * A spawn records its session as soon as the canvas holds it (`starting`), before it is ready (#1).
 */
export function recordTicketSession(
  record: OrchestrationRecord,
  ticketId: string,
  session: TicketSession,
  now: string,
  route?: TicketRoute,
  state: TicketRunState = 'started'
): OrchestrationRecord {
  const run: TicketRun = {
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    ...(state === 'starting' ? { state } : {}),
    provider: record.provider,
    ...(route ? { route } : {}),
    ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
    ...(session.branch ? { branch: session.branch } : {})
  }
  // A session spawned before runs were kept (#40) joins the history without a launch route: by now
  // `route` is the new spawn's, so the report takes that session's route from its outcome record.
  const earlier = (ticket: OrchestrationTicket): TicketRun[] =>
    ticket.runs ??
    (ticket.session?.conversationId
      ? [
          {
            conversationId: ticket.session.conversationId,
            ...(ticket.session.nodeId ? { nodeId: ticket.session.nodeId } : {}),
            ...(ticket.session.worktreePath ? { worktreePath: ticket.session.worktreePath } : {}),
            ...(ticket.session.branch ? { branch: ticket.session.branch } : {})
          }
        ]
      : [])
  const tickets = record.tickets.map((ticket) =>
    ticket.id === ticketId ? { ...ticket, session, runs: [...earlier(ticket), run] } : ticket
  )
  return { ...record, tickets, updatedAt: now }
}

/**
 * Fills in what a recorded session learned since (its conversation id, that it is `started`). Only
 * the session this node is: a ticket already respawned onto another node is left alone.
 */
export function updateTicketSession(
  record: OrchestrationRecord,
  ticketId: string,
  session: TicketSession,
  now: string,
  state: TicketRunState
): OrchestrationRecord {
  const tickets = record.tickets.map((ticket) => {
    if (ticket.id !== ticketId || !ticket.session || ticket.session.nodeId !== session.nodeId) return ticket
    const runs = ticket.runs ?? []
    const last = runs[runs.length - 1]
    const { state: _state, ...started } = last ?? {}
    return {
      ...ticket,
      session: { ...ticket.session, ...session },
      runs: last
        ? [
            ...runs.slice(0, -1),
            {
              ...(state === 'starting' ? last : started),
              ...(session.conversationId ? { conversationId: session.conversationId } : {}),
              ...(session.nodeId ? { nodeId: session.nodeId } : {}),
              ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
              ...(session.branch ? { branch: session.branch } : {})
            }
          ]
        : runs
    }
  })
  return { ...record, tickets, updatedAt: now }
}

/**
 * Takes back the session a spawn recorded early once its start has failed, restoring the session and
 * runs the ticket had before: a retry must find the ticket as it was, never linked to a session
 * Toucan stopped. A ticket already respawned onto another node is left alone.
 */
export function abandonTicketSession(
  record: OrchestrationRecord,
  ticketId: string,
  nodeId: string,
  before: Pick<OrchestrationTicket, 'session' | 'runs'>,
  now: string
): OrchestrationRecord {
  const tickets = record.tickets.map((ticket) => {
    if (ticket.id !== ticketId || ticket.session?.nodeId !== nodeId) return ticket
    const { session: _session, runs: _runs, ...rest } = ticket
    return {
      ...rest,
      ...(before.session ? { session: before.session } : {}),
      ...(before.runs ? { runs: before.runs } : {})
    }
  })
  return { ...record, tickets, updatedAt: now }
}

/** Where one attempt of a ticket ran, as `discard --attempt <n>` needs it. */
export interface AttemptLocation {
  attempt: number
  nodeId?: string
  conversationId?: string
  worktreePath?: string
  branch?: string
  state?: TicketRunState
  discarded: boolean
}

/**
 * Attempt `attempt` (one-based, over `runs`) of a ticket. A run recorded before it kept its
 * location falls back to the ticket's `session` when it is the latest attempt, the only one that
 * session can be; a ticket with a session but no runs has exactly that one attempt.
 */
export function attemptLocation(ticket: OrchestrationTicket, attempt: number): AttemptLocation | undefined {
  const runs = ticket.runs ?? []
  const count = Math.max(runs.length, ticket.session ? 1 : 0)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > count) return undefined
  const run = runs[attempt - 1]
  const latest = attempt === count
  const session = latest ? ticket.session : undefined
  const pick = <K extends 'nodeId' | 'conversationId' | 'worktreePath' | 'branch'>(key: K): string | undefined =>
    (run as Partial<Record<K, string>> | undefined)?.[key] ?? session?.[key]
  return {
    attempt,
    ...(pick('nodeId') ? { nodeId: pick('nodeId') } : {}),
    ...(pick('conversationId') ? { conversationId: pick('conversationId') } : {}),
    ...(pick('worktreePath') ? { worktreePath: pick('worktreePath') } : {}),
    ...(pick('branch') ? { branch: pick('branch') } : {}),
    ...(run?.state ? { state: run.state } : {}),
    discarded: run?.discarded === true
  }
}

/**
 * Records attempt `attempt` as discarded. When it is the ticket's latest, the session link is
 * dropped as well, so the ticket reads as not spawned and a plain `spawn` is no duplicate.
 */
export function discardTicketRun(
  record: OrchestrationRecord,
  ticketId: string,
  attempt: number,
  now: string
): OrchestrationRecord {
  const tickets = record.tickets.map((ticket) => {
    if (ticket.id !== ticketId) return ticket
    const location = attemptLocation(ticket, attempt)
    if (!location) return ticket
    const runs = ticket.runs ?? []
    // A session recorded before runs were kept is that ticket's one attempt.
    const base: TicketRun[] = runs.length > 0 ? runs : ticket.session ? [{}] : []
    const nextRuns = base.map((run, index) => {
      if (index !== attempt - 1) return run
      const { state: _state, ...rest } = run
      return {
        ...rest,
        ...(location.nodeId ? { nodeId: location.nodeId } : {}),
        ...(location.worktreePath ? { worktreePath: location.worktreePath } : {}),
        ...(location.branch ? { branch: location.branch } : {}),
        discarded: true as const
      }
    })
    const { session, ...rest } = ticket
    const latest = attempt === base.length
    return {
      ...rest,
      ...(session && !latest ? { session } : {}),
      ...(nextRuns.length > 0 ? { runs: nextRuns } : {})
    }
  })
  return { ...record, tickets, updatedAt: now }
}

/** The part of `ticket/<scope>/<slug>` a ticket id becomes. */
export function ticketBranchSlug(ticketId: string): string {
  return (
    ticketId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'ticket'
  )
}

/**
 * The short id that keeps one orchestration's ticket branches - and so its worktree folders,
 * `ticket-<scope>-<slug>` - apart from another's in the same project: every orchestration has a
 * ticket 1. Six base-36 characters of an FNV-1a hash of the record's key, so it is stable for the
 * orchestration's whole life and needs no stored state; a hash rather than a prefix of the
 * conversation id, because a time-ordered id (UUIDv7) shares its leading characters with every
 * orchestration started in the same minute.
 */
export function orchestrationBranchScope(key: Pick<OrchestrationRecord, 'provider' | 'conversationId'>): string {
  let hash = 0x811c9dc5
  for (const char of `${key.provider}:${key.conversationId}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return ((hash >>> 0) % 36 ** 6).toString(36).padStart(6, '0')
}

/** `ticket/<slug>`: the name every ticket branch had before branches were scoped per orchestration. */
function isLegacyTicketBranch(branch: string): boolean {
  return /^ticket\/[^/]+$/.test(branch)
}

/** Whether the record names a ticket branch from before scoping, so its own attempts can be legacy ones. */
function predatesBranchScopes(record: Pick<OrchestrationRecord, 'tickets'>): boolean {
  return record.tickets.some((ticket) =>
    [ticket.session?.branch, ...(ticket.runs ?? []).map((run) => run.branch)].some(
      (branch) => branch !== undefined && isLegacyTicketBranch(branch)
    )
  )
}

/**
 * Whether a `ticket/*` branch is this orchestration's to report, adopt or discard: one under its
 * own `ticket/<scope>/`, never another orchestration's. An unscoped legacy `ticket/<slug>` cannot
 * say whose it is, so it belongs only to a record that itself ran attempts under legacy names -
 * which sees them as before - and never to an orchestration started since.
 */
export function ticketBranchBelongsTo(
  record: Pick<OrchestrationRecord, 'provider' | 'conversationId' | 'tickets'>,
  branch: string
): boolean {
  if (branch.startsWith(`ticket/${orchestrationBranchScope(record)}/`)) return true
  return isLegacyTicketBranch(branch) && predatesBranchScopes(record)
}

/** The ticket part of a ticket branch, past `ticket/` and any orchestration scope: `3` or a retry's `3-2`. */
export function ticketBranchTail(branch: string): string {
  return branch.slice(branch.lastIndexOf('/') + 1)
}

/**
 * The record ticket a `ticket/*` branch name belongs to - `ticket/<scope>/3`, a retry's
 * `ticket/<scope>/3-2` and a legacy `ticket/3` all read as ticket 3 - or undefined when no
 * ticket's slug matches.
 */
export function ticketIdOfBranch(record: Pick<OrchestrationRecord, 'tickets'>, branch: string): string | undefined {
  const slug = ticketBranchTail(branch)
  const bare = slug.replace(/-\d+$/, '')
  const bySlug = (candidate: string) => record.tickets.find((ticket) => ticketBranchSlug(ticket.id) === candidate)
  return (bySlug(slug) ?? bySlug(bare))?.id
}

/**
 * Local branch names for a ticket's worktree, in the order they are tried: a retry gets a fresh
 * branch rather than reusing the one a failed attempt left behind. Every name is under the
 * orchestration's `scope` (`orchestrationBranchScope`), so another orchestration's ticket of the
 * same id neither takes a name from this one nor reads as its retry. Endless, because the spawn
 * budget is a checkpoint the human can continue past (and a failed attempt's branch can outlive
 * any count); the caller stops at the first name git accepts or a failure that is not a conflict.
 */
export function* ticketBranchCandidates(scope: string, ticketId: string): Generator<string, never> {
  const slug = ticketBranchSlug(ticketId)
  yield `ticket/${scope}/${slug}`
  for (let attempt = 2; ; attempt += 1) yield `ticket/${scope}/${slug}-${attempt}`
}

/** The canvas title of a ticket session: a manual title, so no generated one replaces it. */
export function ticketSessionTitle(ticket: Pick<OrchestrationTicket, 'id' | 'title'>): string {
  return `#${ticket.id} ${ticket.title}`
}

/**
 * Where the contract starts in a ticket session's prompt.
 * @internal exported for tests
 */
export const TICKET_CONTRACT_HEADING = '## Ticket contract'

/**
 * How a session writes down a file in chat (#3). A bare path in backticks is text the human has to
 * copy into Explorer; a Markdown link is one click, and both the desktop transcript and the phone
 * companion open the `file:` URL form (`classifyMarkdownLink`). The path stays absolute because the
 * phone fetches a linked image from the desktop by it and cannot resolve a relative one.
 * @internal exported for tests
 */
export const FILE_REFERENCE_RULE =
  'Write every file you reference in chat, above all screenshots and other images, as a Markdown link to its absolute path as a file URL, for example [before.png](file:///C:/Users/me/shots/before.png), with spaces written as %20; never as a bare path or a path in backticks. The link must be absolute: the phone companion fetches the file from the desktop by that path and cannot resolve a relative one.'

/**
 * `FILE_REFERENCE_RULE` plus, when the project has one, where those files go: the scratch folder in
 * the main checkout (`shared/scratch-directory.ts`). Toucan opens only files inside a project or
 * worktree, a file in the system temp folder is refused, and a ticket worktree is deleted after
 * the merge, so "link it" is only half the instruction - it also has to say where to save it. The
 * example is built from the real folder, so a session copies a link that opens rather than one it
 * has to adapt. `scratchPath` is the folder's absolute path in the platform's own form.
 * @internal exported for tests
 */
export function fileReferenceRule(scratchPath?: string): string {
  if (!scratchPath) return FILE_REFERENCE_RULE
  const example = `[before.png](${fileUrlOf(scratchPath)}/before.png)`
  return [
    FILE_REFERENCE_RULE,
    `Save every screenshot, image, report or other file meant for the human in the scratch folder ${scratchPath} (${SCRATCH_DIRECTORY_NAME} in the main project checkout, ignored by git), not in your worktree and not in the system temp folder: Toucan opens only files inside a project or worktree, and a worktree is deleted after the merge, so a link into it stops working. Create subfolders there as you like, and link what you saved there, for example ${example}.`
  ].join(' ')
}

/**
 * The rules every ticket session is bound by, appended after the implementation skill and the
 * ticket (CONTEXT.md, "Ticket contract"). The no-push rule is also enforced - the worktree's
 * `pre-push` hook refuses every push - but it is stated, so the session does not spend a turn
 * finding that out. `scratchPath` is the main checkout's scratch folder, which the session cannot
 * derive: it runs in a worktree.
 * @internal exported for tests
 */
export function ticketContract(worktree: { path: string; branch: string }, scratchPath?: string): string {
  return [
    TICKET_CONTRACT_HEADING,
    '',
    'You are a ticket session started by a Toucan orchestrator. These rules win over the skill above wherever the two disagree.',
    '',
    `- Stay in your worktree, ${worktree.path}, and work nowhere else.`,
    `- Commit your work to its branch, ${worktree.branch}.`,
    "- When the ticket only asks a question, answer it from the code: change and commit nothing, skip the skill's implementation steps, and make the answer, with the files and lines it rests on, your final report.",
    '- Never push, never merge, and never open a pull request: the orchestrator merges this branch. Pushing is refused by a hook anyway.',
    "- Do not run the project's full test suite before your final report; run the tests that cover your change. When the project's agent instructions (AGENTS.md or CLAUDE.md) name a pre-merge quick check, run it too before you report done, fix what it reports, and report its result with the commit it passed on; that quick check is not the full suite. The orchestrator rebases this branch onto the target right before the merge and decides from the risk of the change whether to ask you for the full suite, an affected subset, or nothing more (CI runs the full suite anyway), so a full run happens at most once, on what is merged.",
    '- When the orchestrator asks, run the full test suite or the tests it names here and report the commit you tested with its result. When it hands you a rebase conflict, rebase this branch onto the target, resolve it, then run what it asks for (the full suite unless it names less) and report the same way. The orchestrator only fast-forwards what it verified.',
    '- End with a final report: commit, verification commands and results, unresolved blocking review findings, skipped or deleted tests with reasons, and open questions.',
    `- ${fileReferenceRule(scratchPath)}`
  ].join('\n')
}

/**
 * The ticket contract as the settings panel shows it beside the implementation-skill field (#39):
 * what a configured skill has to do and must never do for a ticket session to be mergeable. The
 * binding text is `ticketContract`, which wins over the skill; this is its reading for a human
 * choosing the skill.
 */
export const TICKET_CONTRACT_SUMMARY: { must: readonly string[]; mustNot: readonly string[] } = {
  must: [
    'Implement, test, review and commit the ticket in the given worktree, on its branch.',
    'Answer a question-only ticket in the final report, without changing or committing anything.',
    "Run only the tests covering the change before the final report, plus the project's own pre-merge quick check when its agent instructions name one, and report its result; run the full test suite, or the subset named, on request, right before the merge.",
    'On request, resolve a rebase conflict with the target, then run the tests asked for (the full test suite unless less is named).',
    'End with a final report: commit, verification commands and results, unresolved review findings and open questions.'
  ],
  mustNot: ['Push.', 'Merge.', 'Open a pull request.', 'Leave the worktree.']
}

/**
 * A ticket session's first prompt: the implementation skill with the ticket, then the contract.
 * A free-text ticket carries its body; a tracked one carries its reference, which the session reads
 * with its own tools the way the orchestrator did.
 */
export function ticketSessionPrompt(
  ticket: Pick<OrchestrationTicket, 'id' | 'title' | 'body' | 'source'>,
  worktree: { path: string; branch: string },
  skill: string = DEFAULT_IMPLEMENTATION_SKILL,
  scratchPath?: string
): string {
  const detail = ticket.body?.trim() || (ticket.source ? `Source: ${ticket.source}` : '')
  const request = `${skill} ${ticketSessionTitle(ticket)}${detail ? `\n\n${detail}` : ''}`
  return `${request}\n\n${ticketContract(worktree, scratchPath)}`
}

/**
 * What an orchestrator session carries on its system prompt, appended like the session outcome
 * pointer. The skill owns the procedure; this mandatory pointer puts it in scope before the task.
 */
export function orchestratorInstruction(paths: { cliPath: string; skillPath: string; scratchPath?: string }): string {
  const cli = `node "${paths.cliPath}"`
  return [
    'You are a Toucan orchestrator. The first user message is your task.',
    'Delegate immediately: never research or search the project code yourself, not even to answer a question; every piece of task work, a single question included, goes into a ticket session.',
    `Before acting, read and follow the orchestration workflow at "${paths.skillPath}" and its command reference.`,
    'It governs start checks, dependency-aware breakdown, routing, serial tested merges, escalation, tracker write-back, cleanup and the final review list.',
    `Use \`${cli} plan show\` to recover the durable record, and \`${cli} status\` for live ticket state.`,
    'Never implement, edit project files or run a test suite yourself: any change to the project, however small, becomes a ticket, and verification runs in its ticket session.',
    'Before a merge, decide from the risk of the change how much to verify: skip the full suite for a change that cannot plausibly break a test (prose, comments, copy, assets), since CI runs it anyway, and ask for the full suite or an affected subset only when the risk is real; a failed run still blocks the merge.',
    'Keep your turns short - read state, decide, dispatch - because wakes and the human queue behind a busy turn.',
    'Spawn ticket sessions through Toucan; end your turn when waiting for them. Toucan wakes you on their events.',
    `Use \`${cli} followup --ticket <id> --text <text>\` for questions, a pre-merge test run when the risk calls for one, and conflict recovery; it never answers a tool-permission prompt.`,
    'Those prompts wait for the human and belong on the review list.',
    `Merge a tested ticket with \`${cli} merge --ticket <id> --tested <commit>\`, which fast-forwards, pushes, records and cleans up;`,
    'never merge into or push the target with your own Git.',
    fileReferenceRule(paths.scratchPath)
  ].join(' ')
}

/**
 * What happened in a ticket session that the orchestrator is woken for (#35): its turn ended one of
 * three ways, or it raised something only an answer unblocks - a question the orchestrator may
 * answer with `followup`, or a tool-permission prompt that stays with the human. A spawn that
 * answered `pending` (#1) adds the two ways its start then settles: `started`, or `start-failed`
 * (Toucan stopped the session, so the ticket is free to spawn again).
 */
export type TicketWakeKind =
  'completed' | 'failed' | 'cancelled' | 'question' | 'permission' | 'started' | 'start-failed'

export interface TicketWakeEvent {
  ticketId: string
  kind: TicketWakeKind
  /** A failed or cancelled turn's own short reason, never transcript text. */
  reason?: string
  /** A completed turn's background work still running: its result comes with a later wake. */
  backgroundTasks?: number
  /** Filled in when the prompt is built, from the ticket session's outcome record. */
  outcome?: { path: string; files: number }
}

/** Which session events wake the orchestrator; every other event is none of its business. */
export function ticketWakeKind(event: { type: string; errorKind?: string }): TicketWakeKind | null {
  switch (event.type) {
    case 'turn_complete':
      return 'completed'
    case 'turn_failed':
      return event.errorKind === 'rate_limit' || event.errorKind === 'usage_limit' ? null : 'failed'
    case 'turn_cancelled':
      return 'cancelled'
    case 'decision_request':
      return 'question'
    case 'approval':
      return 'permission'
    default:
      return null
  }
}

/** How much of a failure reason a wake carries: enough to recognise it, never a pasted log. */
const WAKE_REASON_LIMIT = 160

function wakeLine(event: TicketWakeEvent): string {
  const ticket = `#${event.ticketId}`
  const outcome = event.outcome
    ? ` - ${event.outcome.files} file${event.outcome.files === 1 ? '' : 's'} - outcome record ${event.outcome.path}`
    : ` - run outcome --ticket ${event.ticketId} for its outcome record`
  switch (event.kind) {
    case 'completed': {
      const pending = event.backgroundTasks
      return pending
        ? `${ticket} completed (background work pending: ${pending} task${pending === 1 ? '' : 's'})${outcome}`
        : `${ticket} completed${outcome}`
    }
    case 'failed':
    case 'cancelled': {
      const reason = event.reason?.replace(/\s+/g, ' ').trim()
      const shown =
        reason && reason.length > WAKE_REASON_LIMIT ? `${reason.slice(0, WAKE_REASON_LIMIT - 3)}...` : reason
      return `${ticket} ${event.kind}${shown ? `: ${shown}` : ''}${outcome}`
    }
    case 'started':
      return `${ticket} finished starting - its session is up and works the ticket; wait for its next wake`
    case 'start-failed': {
      const reason = event.reason?.replace(/\s+/g, ' ').trim().slice(0, WAKE_REASON_LIMIT)
      return `${ticket} could not be started${reason ? `: ${reason}` : ''} - Toucan stopped the session and unlinked it; spawn the ticket again`
    }
    case 'question':
      return `${ticket} asks a question - read it with status, answer it with followup --ticket ${event.ticketId} --text <answer>`
    case 'permission':
      return `${ticket} waits on a tool-permission prompt - only the human answers those; list it for them`
  }
}

/**
 * The follow-up prompt Toucan wakes the orchestrator with: one line per event, folded when several
 * arrived close together, naming the event and where to read more - never the ticket session's
 * transcript. The same event reported twice for a ticket (two questions in a row) is one line.
 */
export function orchestratorWakePrompt(events: readonly TicketWakeEvent[]): string {
  const lines: string[] = []
  for (const event of events) {
    const line = `- ${wakeLine(event)}`
    if (!lines.includes(line)) lines.push(line)
  }
  return toucanPrompt(
    'your ticket sessions reported in',
    [
      ...lines,
      'Read more with `status` and `outcome --ticket <id>`; this message never carries a ticket session transcript.'
    ].join('\n')
  )
}

/**
 * Validates `outcome`'s `--ticket <id> [--full]`. `--full` adds the ticket session's untruncated
 * final report, so a question can be copied with its links instead of from the record's excerpt.
 */
export function parseOutcomeInput(value: unknown): Outcome<'outcome', { ticketId: string; full: boolean }> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('outcome needs --ticket <id>')
  if (args.full !== undefined && args.full !== true) return refuse('outcome --full takes no value')
  return { outcome: { ticketId: args.ticket.trim(), full: args.full === true } }
}

/** Validates `cleanup`'s optional `--ticket <id>` selector. No selector means the final full sweep. */
export function parseCleanupInput(value: unknown): Outcome<'cleanup', { ticketId?: string }> {
  if (value === undefined) return { cleanup: {} }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'ticket')) {
    return refuse('cleanup takes only an optional --ticket <id>')
  }
  if (!nonEmptyString(value.ticket)) return refuse('cleanup --ticket needs a ticket id')
  return { cleanup: { ticketId: value.ticket.trim() } }
}

export type DiscardInput = { ticketId: string; attempt: number } | { branch: string }

/**
 * Validates `discard`: `--ticket <id> --attempt <n>` for a recorded attempt, or `--branch <name>` for
 * an unrecorded one `status` lists (#4).
 */
export function parseDiscardInput(value: unknown): Outcome<'discard', DiscardInput> {
  const args = isRecord(value) ? value : {}
  if (Object.keys(args).some((key) => key !== 'ticket' && key !== 'attempt' && key !== 'branch')) {
    return refuse('discard takes --ticket <id> --attempt <n>, or --branch <name> for an unrecorded attempt')
  }
  if (args.branch !== undefined) {
    if (args.ticket !== undefined || args.attempt !== undefined) {
      return refuse('discard --branch takes neither --ticket nor --attempt')
    }
    if (!nonEmptyString(args.branch) || !args.branch.trim().startsWith('ticket/')) {
      return refuse('discard --branch needs a ticket/* branch name, as status lists under unrecorded')
    }
    return { discard: { branch: args.branch.trim() } }
  }
  if (!nonEmptyString(args.ticket)) return refuse('discard needs --ticket <id> --attempt <n>')
  const attempt = typeof args.attempt === 'string' ? Number(args.attempt) : args.attempt
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    return refuse(
      'discard needs --attempt <n>, a positive whole number (the attempt as status or the duplicate refusal numbers it)'
    )
  }
  return { discard: { ticketId: args.ticket.trim(), attempt } }
}

/** Validates `merge`'s `--ticket <id> --tested <commit>`: the commit the orchestrator verified (targeted tests or the full suite). */
export function parseMergeInput(value: unknown): Outcome<'merge', { ticketId: string; tested: string }> {
  const args = isRecord(value) ? value : {}
  if (Object.keys(args).some((key) => key !== 'ticket' && key !== 'tested'))
    return refuse('merge takes only --ticket <id> --tested <commit>')
  if (!nonEmptyString(args.ticket)) return refuse('merge needs --ticket <id>')
  if (!nonEmptyString(args.tested) || !/^[0-9a-f]{7,64}$/i.test(args.tested.trim()))
    return refuse('merge needs --tested <commit>, the hash of the ticket branch HEAD you verified')
  return { merge: { ticketId: args.ticket.trim(), tested: args.tested.trim() } }
}

/** Validates `followup`'s `--ticket <id> --text <text>`; the text is sent as given. */
export function parseFollowupInput(value: unknown): Outcome<'followup', { ticketId: string; text: string }> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('followup needs --ticket <id>')
  if (!nonEmptyString(args.text)) return refuse('followup needs --text <text>')
  return { followup: { ticketId: args.ticket.trim(), text: args.text } }
}

/**
 * The part of a provider-native question (`AgentDecisionQuestion` in `agent.ts`, which imports this
 * module) that decides where free text can go.
 */
export interface DecisionQuestionSlots {
  id: string
  question: string
  options: ReadonlyArray<{ label: string }>
  input: string
  required?: boolean
  customAnswerId?: string
}

/**
 * A ticket session's pending question answered with the orchestrator's text: the text goes into
 * every question's free-text slot - its "Other" field, or the question itself when it takes text.
 * A required question with no free-text slot cannot be answered this way; the orchestrator is told
 * which, rather than Toucan guessing an option for it.
 */
export function decisionAnswerFromText(
  request: { questions: readonly DecisionQuestionSlots[] },
  text: string
): Outcome<'content', Record<string, string>> {
  const content: Record<string, string> = {}
  for (const question of request.questions) {
    if (question.customAnswerId) content[question.customAnswerId] = text
    else if (question.input === 'text') content[question.id] = text
    else if (question.required) {
      return refuse(
        `question "${question.question}" takes only ${question.options.map((option) => option.label).join(', ') || 'a fixed answer'} and has no free-text answer; it waits for the human`
      )
    }
  }
  if (Object.keys(content).length === 0) return refuse('the question has no free-text answer; it waits for the human')
  return { content }
}
