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
export const ORCHESTRATOR_COMMANDS = ['plan set', 'plan show', 'ticket update', 'spawn'] as const
export type OrchestratorCommand = (typeof ORCHESTRATOR_COMMANDS)[number]

export const DIFFICULTY_TIERS = ['low', 'medium', 'high', 'frontier'] as const
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number]

export const TICKET_MERGE_STATUSES = ['pending', 'merged', 'unmerged'] as const
export type TicketMergeStatus = (typeof TICKET_MERGE_STATUSES)[number]

/** How a ticket was routed; filled in by the routing slice (#36), every field optional until then. */
export interface TicketRoute {
  tier?: DifficultyTier
  model?: string
  effort?: string
  confidence?: number
  routedBy?: 'jev' | 'orchestrator'
  escalated?: boolean
}

/** The ticket session Toucan spawned for a ticket (#34). Toucan-owned: `ticket update` cannot set it. */
export interface TicketSession {
  nodeId?: string
  conversationId?: string
  worktreePath?: string
  branch?: string
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
  attempts: number
  mergeStatus: TicketMergeStatus
}

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
          attempts: before?.attempts ?? 0,
          mergeStatus: before?.mergeStatus ?? 'pending'
        }
      }),
      ...(existing?.spawnCount ? { spawnCount: existing.spawnCount } : {}),
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
    if (!['tier', 'model', 'effort', 'confidence', 'routedBy', 'escalated'].includes(key)) {
      return `route has unknown field "${key}"`
    }
  }
  if (value.tier !== undefined && !DIFFICULTY_TIERS.includes(value.tier as DifficultyTier)) {
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
  if (value.escalated !== undefined && typeof value.escalated !== 'boolean') return 'route.escalated must be a boolean'
  return value
}

/** Fields `ticket update` never touches, each with the reason it gives. */
const PROTECTED_TICKET_FIELDS: Record<string, string> = {
  id: '"id" cannot be updated; re-plan with plan set instead',
  session: '"session" is set by Toucan when it spawns the ticket session'
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
    isFiniteNumber(value.attempts) &&
    TICKET_MERGE_STATUSES.includes(value.mergeStatus as TicketMergeStatus)
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

/** What `spawn` asks for. The provider is not a field: ticket sessions are Claude sessions. */
export interface SpawnInput {
  ticketId: string
  model: string
  effort: string
  /** The project the caller names, if it names one; refused unless it is the orchestrator's own. */
  projectPath?: string
}

/** Validates what `spawn` sent - the CLI's `--ticket`, `--model`, `--effort` and optional flags. */
export function parseSpawnInput(value: unknown): Outcome<'spawn', SpawnInput> {
  const args = isRecord(value) ? value : {}
  if (!nonEmptyString(args.ticket)) return refuse('spawn needs --ticket <id>')
  if (!nonEmptyString(args.model)) return refuse('spawn needs --model <id>')
  if (!nonEmptyString(args.effort)) return refuse('spawn needs --effort <level>')
  if (args.provider !== undefined && args.provider !== 'claude') {
    return refuse(`ticket sessions are Claude sessions; provider ${JSON.stringify(args.provider)} is not supported`)
  }
  if (!optionalString(args.project)) return refuse('--project must be a path')
  return {
    spawn: {
      ticketId: args.ticket.trim(),
      model: args.model.trim(),
      effort: args.effort.trim(),
      ...(nonEmptyString(args.project) ? { projectPath: args.project.trim() } : {})
    }
  }
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
  if (!record.tickets.some((ticket) => ticket.id === ticketId)) return refuse(`the plan has no ticket "${ticketId}"`)
  const used = record.spawnCount ?? 0
  if (used >= MAX_SPAWNS_PER_ORCHESTRATION) {
    return refuse(
      `this orchestration has used all ${MAX_SPAWNS_PER_ORCHESTRATION} spawns (retries and escalations count); ` +
        'list what is left for human review instead'
    )
  }
  return { record: { ...record, spawnCount: used + 1, updatedAt: now } }
}

/** Records the ticket session Toucan spawned; the one write to `session`, which `ticket update` refuses. */
export function recordTicketSession(
  record: OrchestrationRecord,
  ticketId: string,
  session: TicketSession,
  now: string
): OrchestrationRecord {
  const tickets = record.tickets.map((ticket) => (ticket.id === ticketId ? { ...ticket, session } : ticket))
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
    '- End with a final report: the verification commands you ran and their results, unresolved review findings, and open questions.'
  ].join('\n')
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
 * pointer. A placeholder until the orchestration procedure is written (#37): it establishes the
 * role and the CLI, nothing of the breakdown, merging or review-list rules yet.
 */
export function orchestratorInstruction(paths: { cliPath: string; skillPath: string }): string {
  const cli = `node "${paths.cliPath}"`
  return [
    'You are a Toucan orchestrator. The first user message is your task: break it into tickets and keep',
    "Toucan's orchestration record up to date as the single source of truth for the plan and its progress.",
    `Drive Toucan through its CLI, which prints one JSON line per call: \`${cli} plan show\`,`,
    `\`${cli} plan set --file <plan.json>\`, \`${cli} ticket update <id> --json '<fields>'\` and`,
    `\`${cli} spawn --ticket <id> --model <id> --effort <level>\`, which starts one ticket session in a worktree of its own.`,
    `The command reference is ${paths.skillPath}.`
  ].join(' ')
}
