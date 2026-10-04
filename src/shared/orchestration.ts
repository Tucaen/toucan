import { isAgentProvider, type AgentProvider } from './agent-provider'
import { isRecord } from './record'

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
  'cleanup',
  'report'
] as const
export type OrchestratorCommand = (typeof ORCHESTRATOR_COMMANDS)[number]

export const DIFFICULTY_TIERS = ['low', 'medium', 'high', 'frontier'] as const
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number]

export function isDifficultyTier(value: unknown): value is DifficultyTier {
  return DIFFICULTY_TIERS.includes(value as DifficultyTier)
}

export const TICKET_MERGE_STATUSES = ['pending', 'merged', 'unmerged'] as const
export type TicketMergeStatus = (typeof TICKET_MERGE_STATUSES)[number]

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

/**
 * One ticket session a ticket was run in and the route it launched on (#40). `session` is only the
 * latest; the routing report needs every attempt, because an escalated ticket's failure belongs to
 * the tier it failed on, and `route` by then says the tier it was escalated to.
 */
export interface TicketRun {
  conversationId?: string
  route?: TicketRoute
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
  /** Absent is the normal running state, preserving records written before pause/stop existed. */
  lifecycle?: OrchestrationLifecycle
  createdAt: string
  updatedAt: string
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
      ...(existing?.lifecycle ? { lifecycle: existing.lifecycle } : {}),
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
  return { record: { ...record, tickets, updatedAt: now } }
}

function isTicketSession(value: unknown): value is TicketSession {
  return isRecord(value) && [value.nodeId, value.conversationId, value.worktreePath, value.branch].every(optionalString)
}

function isTicketRun(value: unknown): value is TicketRun {
  return (
    isRecord(value) &&
    optionalString(value.conversationId) &&
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
    (value.lifecycle === undefined || isOrchestrationLifecycle(value.lifecycle)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

/**
 * At most this many ticket sessions per orchestration, retries and escalations included (#34). A
 * bound on a runaway loop, not a concurrency cap: how many run at once is the human's call.
 */
export const MAX_SPAWNS_PER_ORCHESTRATION = 20

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
}

const tierError = (flag: string): string => `${flag} must be one of ${DIFFICULTY_TIERS.join(', ')}`

/** Validates what `spawn` sent - the CLI's `--ticket`, `--model`/`--tier`, `--effort` and optional flags. */
export function parseSpawnInput(value: unknown): Outcome<'spawn', SpawnInput> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('spawn needs --ticket <id>')
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
  return {
    spawn: {
      ticketId: args.ticket.trim(),
      ...(isAgentProvider(args.provider) ? { provider: args.provider } : {}),
      ...(nonEmptyString(args.model) ? { model: args.model.trim() } : {}),
      ...(isDifficultyTier(args.tier) ? { tier: args.tier } : {}),
      ...(nonEmptyString(args.effort) ? { effort: args.effort.trim() } : {}),
      ...(nonEmptyString(args.project) ? { projectPath: args.project.trim() } : {})
    }
  }
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

/**
 * Counts one spawn against the record before anything is created, so a spawn that fails later -
 * a worktree git refuses, a setup command that exits non-zero - still counts: the cap bounds
 * attempts, and an attempt that failed is exactly what a runaway loop is made of.
 */
export function reserveSpawn(
  record: OrchestrationRecord,
  ticketId: string,
  now: string
): Outcome<'record', OrchestrationRecord> {
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
  if (ticket.mergeStatus === 'merged') return refuse(`ticket ${ticketId} is already merged`)
  const blockers = ticket.blockedBy.filter(
    (id) => record.tickets.find((candidate) => candidate.id === id)?.mergeStatus !== 'merged'
  )
  if (blockers.length > 0) return refuse(`ticket ${ticketId} has unmerged blockers: ${blockers.join(', ')}`)
  const used = record.spawnCount ?? 0
  if (used >= MAX_SPAWNS_PER_ORCHESTRATION) {
    return refuse(
      `this orchestration has used all ${MAX_SPAWNS_PER_ORCHESTRATION} spawns (retries and escalations count); ` +
        'list what is left for human review instead'
    )
  }
  return { record: { ...record, spawnCount: used + 1, updatedAt: now } }
}

/** Records a provider usage pause without turning it into a ticket attempt or escalation. */
export function pauseOrchestration(
  record: OrchestrationRecord,
  affectedNodeId: string | undefined,
  resetsAt: number | undefined,
  now: string
): OrchestrationRecord {
  if (record.lifecycle?.status === 'stopped') return record
  const previous = record.lifecycle?.status === 'paused' ? record.lifecycle : undefined
  const knownResets = [previous?.resetsAt, resetsAt].filter((value): value is number => value !== undefined)
  return {
    ...record,
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
  return { ...record, lifecycle: { status: 'stopped' }, updatedAt: now }
}

/**
 * Records the ticket session Toucan spawned and the route it launched on; the one write to `session`
 * and `runs`, which `ticket update` refuses.
 */
export function recordTicketSession(
  record: OrchestrationRecord,
  ticketId: string,
  session: TicketSession,
  now: string,
  route?: TicketRoute
): OrchestrationRecord {
  const run: TicketRun = {
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    ...(route ? { route } : {})
  }
  // A session spawned before runs were kept (#40) joins the history without a launch route: by now
  // `route` is the new spawn's, so the report takes that session's route from its outcome record.
  const earlier = (ticket: OrchestrationTicket): TicketRun[] =>
    ticket.runs ?? (ticket.session?.conversationId ? [{ conversationId: ticket.session.conversationId }] : [])
  const tickets = record.tickets.map((ticket) =>
    ticket.id === ticketId ? { ...ticket, session, runs: [...earlier(ticket), run] } : ticket
  )
  return { ...record, tickets, updatedAt: now }
}

/**
 * Local branch names for a ticket's worktree, in the order they are tried: a retry gets a fresh
 * branch rather than reusing the one a failed attempt left behind. One more than the spawn cap, so
 * every spawn an orchestration may make has a name.
 */
export function ticketBranchCandidates(ticketId: string): string[] {
  const slug =
    ticketId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'ticket'
  return Array.from({ length: MAX_SPAWNS_PER_ORCHESTRATION + 1 }, (_, index) =>
    index === 0 ? `ticket/${slug}` : `ticket/${slug}-${index + 1}`
  )
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
 * The rules every ticket session is bound by, appended after the implementation skill and the
 * ticket (CONTEXT.md, "Ticket contract"). The no-push rule is also enforced - the worktree's
 * `pre-push` hook refuses every push - but it is stated, so the session does not spend a turn
 * finding that out.
 * @internal exported for tests
 */
export function ticketContract(worktree: { path: string; branch: string }): string {
  return [
    TICKET_CONTRACT_HEADING,
    '',
    'You are a ticket session started by a Toucan orchestrator. These rules win over the skill above wherever the two disagree.',
    '',
    `- Stay in your worktree, ${worktree.path}, and work nowhere else.`,
    `- Commit your work to its branch, ${worktree.branch}.`,
    '- Never push, never merge, and never open a pull request: the orchestrator merges this branch. Pushing is refused by a hook anyway.',
    '- Resolve and continue a rebase in this worktree when the orchestrator sends conflicts back to you.',
    '- End with a final report: commit, verification commands and results, unresolved blocking review findings, skipped or deleted tests with reasons, and open questions.'
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
  skill: string = DEFAULT_IMPLEMENTATION_SKILL
): string {
  const detail = ticket.body?.trim() || (ticket.source ? `Source: ${ticket.source}` : '')
  const request = `${skill} ${ticketSessionTitle(ticket)}${detail ? `\n\n${detail}` : ''}`
  return `${request}\n\n${ticketContract(worktree)}`
}

/**
 * What an orchestrator session carries on its system prompt, appended like the session outcome
 * pointer. The skill owns the procedure; this mandatory pointer puts it in scope before the task.
 */
export function orchestratorInstruction(paths: { cliPath: string; skillPath: string }): string {
  const cli = `node "${paths.cliPath}"`
  return [
    'You are a Toucan orchestrator. The first user message is your task.',
    `Before acting, read and follow the orchestration workflow at "${paths.skillPath}" and its command reference.`,
    'It governs start checks, dependency-aware breakdown, routing, serial tested merges, escalation, tracker write-back, cleanup and the final review list.',
    `Use \`${cli} plan show\` to recover the durable record, and \`${cli} status\` for live ticket state.`,
    'Spawn ticket sessions through Toucan; end your turn when waiting for them. Toucan wakes you on their events.',
    `Use \`${cli} followup --ticket <id> --text <text>\` for questions or conflict recovery; it never answers a tool-permission prompt.`,
    'Those prompts wait for the human and belong on the review list.'
  ].join(' ')
}

/**
 * What happened in a ticket session that the orchestrator is woken for (#35): its turn ended one of
 * three ways, or it raised something only an answer unblocks - a question the orchestrator may
 * answer with `followup`, or a tool-permission prompt that stays with the human.
 */
export type TicketWakeKind = 'completed' | 'failed' | 'cancelled' | 'question' | 'permission'

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
  return [
    'Toucan: your ticket sessions reported in.',
    ...lines,
    'Read more with `status` and `outcome --ticket <id>`; this message never carries a ticket session transcript.'
  ].join('\n')
}

/** Validates `outcome`'s `--ticket <id>`. */
export function parseOutcomeInput(value: unknown): Outcome<'ticketId', string> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('outcome needs --ticket <id>')
  return { ticketId: args.ticket.trim() }
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
