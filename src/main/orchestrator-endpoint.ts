import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentDecisionRequest, AgentDecisionResponseContent, AgentPromptResult } from '../shared/agent'
import type { AgentProvider } from '../shared/agent-provider'
import type { AgentChatStatus } from '../shared/agent-transcript'
import {
  applyPlan,
  applyTicketUpdate,
  decisionAnswerFromText,
  MAX_SPAWNS_PER_ORCHESTRATION,
  ORCHESTRATOR_COMMANDS,
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  parseEscalateInput,
  parseFollowupInput,
  parseOutcomeInput,
  parsePlanInput,
  parseRouteInput,
  parseSpawnInput,
  parseTicketUpdate,
  recordTicketRoute,
  recordTicketSession,
  TICKET_SESSION_PROVIDER,
  reserveSpawn,
  type DifficultyTier,
  type OrchestrationRecord,
  type OrchestrationTicket,
  type OrchestratorCommand,
  type SpawnInput,
  type TicketRoute
} from '../shared/orchestration'
import {
  escalateRoute,
  resolveTier,
  ROUTE_REVIEW_CONFIDENCE,
  type OfferedModels,
  type OrchestrationConfig
} from '../shared/orchestration-routing'
import type { SessionOutcomeIdentity, SessionOutcomeRecord } from '../shared/session-outcome'
import { pathIdentity } from '../shared/paths'
import { isRecord } from '../shared/record'
import { errorMessage } from '../shared/text'
import type { JevRouter } from './jev-router'
import type { OrchestrationConfigLoad } from './orchestration-config-store'
import type { OrchestrationKey, OrchestrationStore } from './orchestration-store'
import type { TicketBinding } from './orchestration-wake'
import { createPairingToken, pairingTokenMatches, presentedPairingToken } from './remote/pairing'
import type { TicketSpawner } from './ticket-spawner'

/**
 * The local endpoint an orchestrator's CLI talks to (#33; plan in
 * `docs/plans/orchestrator-mode.md`). Plain JSON over a 127.0.0.1 listener in main, built on the
 * terminal-context listener's two rules (`terminal-context-mcp.ts`): it binds lazily - the first
 * orchestrator launch opens the port, and here the last revoke closes it again, so no orchestrator
 * means no open port - and holding a token is never the capability by itself: every call is checked
 * at call time against a *live* grant and scoped to that orchestrator's project.
 *
 * A grant is minted per orchestrator node at launch and travels in its adapter environment beside
 * `TOUCAN_NODE_ID`; stopping the session (closing the node, a restart, the adapter exiting) revokes
 * it through the handle, and a relaunch mints a fresh one. The handle revokes only its own token,
 * so a kill-then-recreate whose old child exits late cannot revoke the new session's grant.
 */

/** @internal exported for tests */
export const ORCHESTRATOR_ENDPOINT_PATH = '/orchestrate'

export interface OrchestratorScope {
  provider: AgentProvider
  /** The orchestrator's project checkout: the only project its calls may touch. */
  projectPath: string
}

export interface OrchestratorGrant {
  /** The two variables the adapter process is launched with. */
  environment: Record<typeof ORCHESTRATOR_URL_ENV | typeof ORCHESTRATOR_TOKEN_ENV, string>
  /**
   * The orchestrator's conversation, once its session has opened. The record is keyed by it, so a
   * call arriving before it is known is refused rather than written under a guess.
   */
  setConversation(conversationId: string): void
  revoke(): void
}

export interface OrchestratorEndpoint {
  /** Never throws: a listener that cannot bind costs the session its token, never its launch. */
  grant(nodeId: string, scope: OrchestratorScope): Promise<OrchestratorGrant | undefined>
  /** Whether the listener is bound - the "no orchestrator, no open port" check. */
  listening(): boolean
  close(): Promise<void>
}

/** What a live ticket session shows the orchestrator (#35): its state and what it waits on. */
export interface TicketSessionState {
  status: AgentChatStatus
  /** A pending tool-permission prompt; only the human answers it. */
  permission?: { title: string }
  /** Pending provider-native questions, the head first; `followup` may answer the head one. */
  questions: AgentDecisionRequest[]
}

/** Main's reach into ticket sessions for `status`, `outcome` and `followup` (#35). */
export interface TicketSessionControl {
  /** A running session's state by node id; undefined when Toucan is not running it. */
  state(nodeId: string): TicketSessionState | undefined
  /** Starts a turn and reports delivery only, never the turn's end. */
  startPrompt(nodeId: string, text: string): AgentPromptResult
  /** Steers a working session, or queues the text for its next boundary. */
  promptWhenIdle(nodeId: string, text: string): Promise<AgentPromptResult>
  answerQuestion(nodeId: string, requestId: string, content: AgentDecisionResponseContent): AgentPromptResult
  /** The conversation's session outcome record and where it is on disk. */
  outcome(identity: SessionOutcomeIdentity): Promise<{ path: string; record: SessionOutcomeRecord } | undefined>
}

/** What routing by difficulty tier needs (#36): the configuration, the picker's models, and Jev. */
export interface OrchestratorRouting {
  /** The effective tier mapping and implementation skill for a project, read afresh at every call. */
  config(projectPath: string): Promise<OrchestrationConfigLoad>
  /** What the chat node's Claude model picker offers, as main last saw it. */
  offered(): OfferedModels
  jev: Pick<JevRouter, 'judge'>
}

export interface OrchestratorEndpointOptions {
  records: OrchestrationStore
  /** Absent, `route`, `escalate` and `spawn --tier` are refused and spawns use the default skill. */
  routing?: OrchestratorRouting
  /** Starts ticket sessions for `spawn`; absent, `spawn` is refused as unavailable. */
  spawner?: TicketSpawner
  /** Absent, `status` reports no live state and `outcome` and `followup` are refused as unavailable. */
  ticketSessions?: TicketSessionControl
  /** A ticket session was spawned: the orchestrator wake starts reporting its events. */
  onTicketSpawned?(nodeId: string, binding: TicketBinding): void
  /**
   * How long `followup` waits for a working session to take the text before it answers "queued":
   * a session that cannot be steered only takes it when its turn ends, which can be an hour.
   */
  followupAckMs?: number
  now?(): string
  log?(message: string): void
}

interface LiveGrant extends OrchestratorScope {
  nodeId: string
  token: string
  conversationId?: string
}

/** One call's answer: an HTTP status and the JSON line the CLI prints. */
interface Reply {
  status: number
  body: { ok: true; [key: string]: unknown } | { ok: false; error: string; [key: string]: unknown }
}

const refused = (status: number, error: string): Reply => ({ status, body: { ok: false, error } })

/** What a spawn runs on, and anything about its routing the caller should hear. */
interface SpawnRoute {
  route: TicketRoute & { model: string; effort: string }
  warnings: string[]
}

const MAX_REQUEST_BYTES = 1024 * 1024

/** The one refusal `followup` gives while a ticket session waits on a tool-permission prompt. */
const permissionStaysWithHuman = (ticketId: string, title: string): Reply =>
  refused(
    409,
    `ticket ${ticketId} is waiting on a tool-permission prompt ("${title}"), which only the human answers; ` +
      'a followup cannot answer it or reach the session until they do. List it for them.'
  )

const UNAUTHORIZED = refused(
  401,
  'the orchestrator token is missing, wrong or revoked; only an orchestrator session holds one, so a ticket session cannot spawn or orchestrate'
)

export function createOrchestratorEndpoint(options: OrchestratorEndpointOptions): OrchestratorEndpoint {
  const now = options.now ?? (() => new Date().toISOString())
  const grants = new Set<LiveGrant>()
  let startedServer: Promise<HttpServer> | undefined

  /** Constant-time per candidate, like the remote server's pairing gate; the set stays tiny. */
  const grantForToken = (presented: string | null): LiveGrant | undefined => {
    let found: LiveGrant | undefined
    for (const grant of grants) if (pairingTokenMatches(grant.token, presented)) found = grant
    return found
  }

  const stopListening = (): void => {
    const pending = startedServer
    startedServer = undefined
    void pending?.then((server) => new Promise<void>((resolve) => server.close(() => resolve()))).catch(() => undefined)
  }

  const revoke = (grant: LiveGrant): void => {
    if (!grants.delete(grant)) return
    if (grants.size === 0) stopListening()
  }

  /** Why a record this grant reaches is not its own to touch, or undefined when it is. */
  const outOfScope = (grant: LiveGrant, record: OrchestrationRecord | undefined): string | undefined =>
    record && pathIdentity(record.projectPath) !== pathIdentity(grant.projectPath)
      ? `this orchestration belongs to another project (${record.projectPath})`
      : undefined

  /**
   * The effective configuration (#36), or the refusal to give when the user's file cannot be used:
   * routing on a mapping the user did not write is worse than not routing. Without routing wired
   * in, there is no configuration and spawns use the default skill.
   */
  const loadConfig = async (
    grant: LiveGrant
  ): Promise<{ config?: OrchestrationConfig; load?: OrchestrationConfigLoad } | { refusal: Reply }> => {
    if (!options.routing) return {}
    const load = await options.routing.config(grant.projectPath)
    if (!load.config) return { refusal: refused(409, load.error ?? 'the orchestration configuration cannot be used') }
    return { config: load.config, load }
  }

  /**
   * The model and effort a spawn runs on, and the route recorded for it (#36): an explicit model is
   * the orchestrator's own choice; a tier goes through the mapping; neither takes the ticket's
   * recorded route. A tier other than the recorded one is the orchestrator's judgement, not Jev's.
   */
  const spawnRoute = (
    request: SpawnInput,
    ticket: OrchestrationTicket,
    config: OrchestrationConfig | undefined
  ): SpawnRoute | { refusal: Reply } => {
    const recorded = ticket.route
    if (request.model !== undefined) {
      return {
        route: { ...recorded, model: request.model, effort: request.effort!, routedBy: 'orchestrator' },
        warnings: []
      }
    }
    const routing = options.routing
    if (!routing || !config) {
      return { refusal: refused(501, 'this Toucan cannot route by tier; pass --model and --effort') }
    }
    const tier = request.tier ?? recorded?.tier
    if (!tier) {
      return {
        refusal: refused(
          409,
          `ticket ${ticket.id} has no route yet; run route first, or spawn it with --tier <tier> or --model <id> --effort <level>`
        )
      }
    }
    const same = request.tier === undefined || request.tier === recorded?.tier
    if (same && recorded?.model && recorded.effort) {
      return { route: { ...recorded, model: recorded.model, effort: request.effort ?? recorded.effort }, warnings: [] }
    }
    const resolved = resolveTier(tier, same ? recorded?.depth : undefined, config, routing.offered())
    if (resolved.error !== undefined) return { refusal: refused(409, resolved.error) }
    const route = same
      ? { ...recorded, ...resolved.route }
      : { ...resolved.route, routedBy: 'orchestrator' as const, escalated: false }
    return { route: { ...route, effort: request.effort ?? route.effort }, warnings: resolved.warnings }
  }

  /**
   * One ticket session (#34). Everything that can be refused without creating anything is refused
   * first; then the spawn is counted against the record, and only then does the spawner create the
   * worktree and the session - so the cap also bounds spawns that fail halfway.
   */
  const spawn = async (
    grant: LiveGrant,
    key: { provider: AgentProvider; conversationId: string },
    args: unknown
  ): Promise<Reply> => {
    const parsed = parseSpawnInput(args)
    if (parsed.error !== undefined) return refused(400, parsed.error)
    const request = parsed.spawn
    if (request.projectPath !== undefined && pathIdentity(request.projectPath) !== pathIdentity(grant.projectPath)) {
      return refused(403, `spawn cannot reach another project; this orchestrator works in ${grant.projectPath}`)
    }
    if (grant.provider !== 'claude') return refused(403, 'only a Claude orchestrator can spawn ticket sessions')
    const spawner = options.spawner
    if (!spawner) return refused(501, 'this Toucan cannot spawn ticket sessions')
    const configured = await loadConfig(grant)
    if ('refusal' in configured) return configured.refusal
    let routed: SpawnRoute | undefined
    const reservation = await options.records.update<{ refusal: Reply } | { record: OrchestrationRecord }>(
      key,
      (current) => {
        const refuse = (reply: Reply) => ({ value: current, result: { refusal: reply } })
        if (!current) return refuse(refused(404, 'there is no plan yet; run plan set first'))
        const scope = outOfScope(grant, current)
        if (scope) return refuse(refused(403, scope))
        const planned = current.tickets.find((candidate) => candidate.id === request.ticketId)
        if (!planned) return refuse(refused(400, `the plan has no ticket "${request.ticketId}"`))
        // Resolved before the spawn is counted, so a ticket that cannot be routed costs no spawn.
        const resolved = spawnRoute(request, planned, configured.config)
        if ('refusal' in resolved) return refuse(resolved.refusal)
        routed = resolved
        const counted = reserveSpawn(current, request.ticketId, now())
        if (counted.error !== undefined) return refuse(refused(429, counted.error))
        const record = recordTicketRoute(counted.record, request.ticketId, resolved.route, now())
        return { value: record, result: { record } }
      }
    )
    if ('refusal' in reservation) return reservation.refusal
    const reserved = reservation.record
    const ticket = reserved.tickets.find((candidate) => candidate.id === request.ticketId)!
    const { route: spawnedRoute, warnings: routeWarnings } = routed!
    const spawned = await spawner.spawn({
      orchestrator: { nodeId: grant.nodeId, conversationId: key.conversationId },
      projectPath: grant.projectPath,
      targetBranch: reserved.targetBranch,
      ticket,
      model: spawnedRoute.model,
      effort: spawnedRoute.effort,
      ...(configured.config ? { implementationSkill: configured.config.implementationSkill } : {})
    })
    const spawnsLeft = MAX_SPAWNS_PER_ORCHESTRATION - (reserved.spawnCount ?? 0)
    if (!spawned.ok) return { status: 502, body: { ok: false, error: spawned.error } }
    await options.records.update(key, (current) => ({
      value: current && recordTicketSession(current, ticket.id, spawned.session, now()),
      result: undefined
    }))
    options.onTicketSpawned?.(spawned.session.nodeId, {
      orchestratorNodeId: grant.nodeId,
      ticketId: ticket.id,
      conversationId: spawned.session.conversationId
    })
    return {
      status: 200,
      body: {
        ok: true,
        ticket: ticket.id,
        session: spawned.session,
        model: spawned.model ?? null,
        effort: spawned.effort ?? null,
        warnings: [...routeWarnings, ...spawned.warnings],
        route: spawnedRoute,
        spawnsLeft
      }
    }
  }

  /**
   * `route` (#36). With no arguments, every unrouted ticket goes to Jev in one request and each tier
   * is resolved through the mapping; with `--ticket --tier`, the orchestrator supplies the tier
   * itself and the route is tagged so. A Jev that cannot be asked is reported, never guessed around.
   */
  const route = async (grant: LiveGrant, key: OrchestrationKey, args: unknown): Promise<Reply> => {
    const parsed = parseRouteInput(args)
    if (parsed.error !== undefined) return refused(400, parsed.error)
    const routing = options.routing
    if (!routing) return refused(501, 'this Toucan cannot route tickets')
    const configured = await loadConfig(grant)
    if ('refusal' in configured) return configured.refusal
    const config = configured.config!
    const own = await ownRecord(grant, key)
    if ('status' in own) return own

    const judgements: { ticketId: string; tier: DifficultyTier; confidence?: number; depth?: number }[] = []
    const { ticketId, tier } = parsed.route
    if (ticketId !== undefined && tier !== undefined) {
      const ticket = ticketIn(own.record, ticketId)
      if ('status' in ticket) return ticket
      judgements.push({ ticketId, tier })
    } else {
      const unrouted = own.record.tickets.filter(
        (ticket) => !ticket.route?.tier && !ticket.session && ticket.mergeStatus === 'pending'
      )
      if (unrouted.length > 0) {
        const judged = await routing.jev.judge(
          unrouted.map((ticket) => ({
            id: ticket.id,
            title: ticket.title,
            ...(ticket.body ? { body: ticket.body } : {}),
            ...(ticket.source ? { source: ticket.source } : {})
          }))
        )
        if (!judged.ok) {
          return {
            status: 503,
            body: {
              ok: false,
              jevUnavailable: true,
              error:
                `Jev is unavailable: ${judged.reason}. Judge each ticket's tier yourself with the same criteria and ` +
                'record it with route --ticket <id> --tier <tier>; those routes are tagged routedBy: orchestrator.'
            }
          }
        }
        judgements.push(...judged.judgements)
      }
    }

    const offered = routing.offered()
    const warnings: string[] = []
    const routes = new Map<string, TicketRoute>()
    for (const judgement of judgements) {
      const byJev = judgement.confidence !== undefined
      const resolved = resolveTier(judgement.tier, judgement.depth, config, offered)
      warnings.push(...resolved.warnings.map((warning) => `#${judgement.ticketId}: ${warning}`))
      if (resolved.error !== undefined) warnings.push(`#${judgement.ticketId}: ${resolved.error}`)
      routes.set(judgement.ticketId, {
        tier: judgement.tier,
        ...(resolved.route ? { model: resolved.route.model, effort: resolved.route.effort } : {}),
        ...(byJev ? { confidence: judgement.confidence, depth: judgement.depth } : {}),
        routedBy: byJev ? 'jev' : 'orchestrator',
        escalated: false,
        ...(byJev && judgement.confidence! < ROUTE_REVIEW_CONFIDENCE ? { reviewRequired: true } : {})
      })
    }
    if (routes.size > 0) {
      await options.records.update(key, (current) => {
        if (!current) return { value: current, result: undefined }
        let next = current
        for (const [id, ticketRoute] of routes) {
          const ticket = next.tickets.find((candidate) => candidate.id === id)
          // A Jev route never replaces one written while Jev was answering; the orchestrator's own does.
          if (!ticket || (ticketRoute.routedBy === 'jev' && ticket.route?.tier)) continue
          next = recordTicketRoute(next, id, ticketRoute, now())
        }
        return { value: next, result: undefined }
      })
    }
    return {
      status: 200,
      body: {
        ok: true,
        routes: [...routes].map(([id, ticketRoute]) => ({
          ticket: id,
          ...ticketRoute,
          reviewRequired: ticketRoute.reviewRequired ?? false
        })),
        warnings,
        config: { user: configured.load!.userPath, project: configured.load!.projectPath ?? null }
      }
    }
  }

  /** `escalate` (#36): one tier up, re-resolved; past `frontier` the ticket belongs on the review list. */
  const escalate = async (grant: LiveGrant, key: OrchestrationKey, args: unknown): Promise<Reply> => {
    const parsed = parseEscalateInput(args)
    if (parsed.error !== undefined) return refused(400, parsed.error)
    const routing = options.routing
    if (!routing) return refused(501, 'this Toucan cannot route tickets')
    const configured = await loadConfig(grant)
    if ('refusal' in configured) return configured.refusal
    const offered = routing.offered()
    return options.records.update(key, (current) => {
      const refuse = (reply: Reply) => ({ value: current, result: reply })
      if (!current) return refuse(refused(404, 'there is no plan yet; run plan set first'))
      const scope = outOfScope(grant, current)
      if (scope) return refuse(refused(403, scope))
      const ticket = current.tickets.find((candidate) => candidate.id === parsed.ticketId)
      if (!ticket) return refuse(refused(400, `the plan has no ticket "${parsed.ticketId}"`))
      const escalated = escalateRoute(ticket.route, configured.config!, offered)
      if (escalated.error !== undefined) return refuse(refused(409, `ticket ${ticket.id}: ${escalated.error}`))
      const record = recordTicketRoute(current, ticket.id, escalated.route, now())
      return {
        value: record,
        result: {
          status: 200,
          body: { ok: true, ticket: ticket.id, route: escalated.route, warnings: escalated.warnings }
        }
      }
    })
  }

  /** The grant's own record, or the refusal to give instead. */
  const ownRecord = async (
    grant: LiveGrant,
    key: OrchestrationKey
  ): Promise<{ record: OrchestrationRecord } | Reply> => {
    const record = await options.records.read(key)
    if (!record) return refused(404, 'there is no plan yet; run plan set first')
    const scope = outOfScope(grant, record)
    return scope ? refused(403, scope) : { record }
  }

  const ticketIn = (record: OrchestrationRecord, ticketId: string): OrchestrationTicket | Reply =>
    record.tickets.find((ticket) => ticket.id === ticketId) ?? refused(400, `the plan has no ticket "${ticketId}"`)

  const status = (record: OrchestrationRecord): Reply => {
    const tickets = record.tickets.map((ticket) => {
      const live = ticket.session?.nodeId ? options.ticketSessions?.state(ticket.session.nodeId) : undefined
      return {
        id: ticket.id,
        title: ticket.title,
        blockedBy: ticket.blockedBy,
        attempts: ticket.attempts,
        mergeStatus: ticket.mergeStatus,
        session: ticket.session ?? null,
        route: ticket.route ?? null,
        state: !ticket.session ? 'not spawned' : (live?.status ?? 'not running'),
        permissionPrompt: live?.permission ? { title: live.permission.title, answeredBy: 'human' } : null,
        questions: live?.questions ?? []
      }
    })
    return {
      status: 200,
      body: {
        ok: true,
        tickets,
        pendingPermissionPrompts: tickets.filter((ticket) => ticket.permissionPrompt).map((ticket) => ticket.id)
      }
    }
  }

  const outcome = async (record: OrchestrationRecord, args: unknown): Promise<Reply> => {
    const parsed = parseOutcomeInput(args)
    if (parsed.error !== undefined) return refused(400, parsed.error)
    const ticket = ticketIn(record, parsed.ticketId)
    if ('status' in ticket) return ticket
    const conversationId = ticket.session?.conversationId
    if (!conversationId) return refused(409, `ticket ${ticket.id} has no ticket session yet`)
    const sessions = options.ticketSessions
    if (!sessions) return refused(501, 'this Toucan cannot read session outcome records')
    const found = await sessions.outcome({ provider: TICKET_SESSION_PROVIDER, conversationId })
    if (!found) {
      return refused(
        404,
        `ticket ${ticket.id}'s session has no outcome record yet; one is written at its first turn end`
      )
    }
    const { key: _key, provider: _provider, conversationId: _conversationId, ...fields } = found.record
    return { status: 200, body: { ok: true, ticket: ticket.id, path: found.path, fields } }
  }

  /**
   * Answers a ticket session's question or prompts it - never its tool-permission prompt, which is
   * checked first: one agent granting another rights the human did not grant is escalation.
   */
  const followup = async (record: OrchestrationRecord, args: unknown): Promise<Reply> => {
    const parsed = parseFollowupInput(args)
    if (parsed.error !== undefined) return refused(400, parsed.error)
    const ticket = ticketIn(record, parsed.followup.ticketId)
    if ('status' in ticket) return ticket
    const sessions = options.ticketSessions
    if (!sessions) return refused(501, 'this Toucan cannot reach ticket sessions')
    const nodeId = ticket.session?.nodeId
    if (!nodeId) return refused(409, `ticket ${ticket.id} has no ticket session yet`)
    const live = sessions.state(nodeId)
    if (!live || live.status === 'exited') return refused(409, `ticket ${ticket.id}'s session is not running`)
    if (live.permission) return permissionStaysWithHuman(ticket.id, live.permission.title)
    const text = parsed.followup.text
    const delivered = (how: string, result: AgentPromptResult): Reply =>
      result.ok
        ? { status: 200, body: { ok: true, ticket: ticket.id, delivered: how } }
        : refused(409, result.message ?? `ticket ${ticket.id}'s session did not take the followup`)
    const [question] = live.questions
    if (question) {
      const answer = decisionAnswerFromText(question, text)
      if (answer.error !== undefined) return refused(409, answer.error)
      return delivered('answered', sessions.answerQuestion(nodeId, question.id, answer.content))
    }
    if (live.status !== 'working') return delivered('prompt', sessions.startPrompt(nodeId, text))
    // A steered text is taken at once; one queued behind a session that cannot be steered is only
    // taken when the turn ends, and the CLI must not sit in a tool call for that long.
    let timer: ReturnType<typeof setTimeout> | undefined
    const delivery = sessions
      .promptWhenIdle(nodeId, text)
      .catch((error: unknown): AgentPromptResult => ({ ok: false, message: errorMessage(error) }))
    const acknowledged = await Promise.race([
      delivery,
      new Promise<'queued'>((resolve) => {
        timer = setTimeout(() => resolve('queued'), options.followupAckMs ?? 5_000)
      })
    ]).finally(() => clearTimeout(timer))
    if (acknowledged === 'queued') return { status: 200, body: { ok: true, ticket: ticket.id, delivered: 'queued' } }
    return delivered('steered', acknowledged)
  }

  const execute = async (grant: LiveGrant, command: OrchestratorCommand, args: unknown): Promise<Reply> => {
    const conversationId = grant.conversationId
    if (!conversationId) return refused(409, 'the orchestrator session has not opened its conversation yet')
    const key = { provider: grant.provider, conversationId }
    const identity = { ...key, projectPath: grant.projectPath }
    if (command === 'plan show') {
      const record = await options.records.read(key)
      const scope = outOfScope(grant, record)
      return scope ? refused(403, scope) : { status: 200, body: { ok: true, record: record ?? null } }
    }
    if (command === 'plan set') {
      const parsed = parsePlanInput(args)
      if (parsed.error !== undefined) return refused(400, parsed.error)
      return options.records.update(key, (current) => {
        const scope = outOfScope(grant, current)
        if (scope) return { value: current, result: refused(403, scope) }
        const applied = applyPlan(current, parsed.plan, identity, now())
        if (applied.error !== undefined) return { value: current, result: refused(400, applied.error) }
        return { value: applied.record, result: { status: 200, body: { ok: true, record: applied.record } } }
      })
    }
    if (command === 'spawn') return spawn(grant, key, args)
    if (command === 'route') return route(grant, key, args)
    if (command === 'escalate') return escalate(grant, key, args)
    if (command === 'status' || command === 'outcome' || command === 'followup') {
      const own = await ownRecord(grant, key)
      if ('status' in own) return own
      if (command === 'status') return status(own.record)
      return command === 'outcome' ? outcome(own.record, args) : followup(own.record, args)
    }
    const update = isRecord(args) ? args : {}
    if (typeof update.id !== 'string' || update.id.trim() === '') return refused(400, 'ticket update needs a ticket id')
    const ticketId = update.id.trim()
    const parsed = parseTicketUpdate(update.fields)
    if (parsed.error !== undefined) return refused(400, parsed.error)
    return options.records.update(key, (current) => {
      if (!current) return { value: current, result: refused(404, 'there is no plan yet; run plan set first') }
      const scope = outOfScope(grant, current)
      if (scope) return { value: current, result: refused(403, scope) }
      const applied = applyTicketUpdate(current, ticketId, parsed.patch, now())
      if (applied.error !== undefined) return { value: current, result: refused(400, applied.error) }
      const ticket = applied.record.tickets.find((candidate) => candidate.id === ticketId)
      return { value: applied.record, result: { status: 200, body: { ok: true, ticket } } }
    })
  }

  const respond = (response: ServerResponse, reply: Reply): void => {
    const text = JSON.stringify(reply.body)
    response.writeHead(reply.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    response.end(text)
  }

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== ORCHESTRATOR_ENDPOINT_PATH) {
      respond(response, refused(404, 'not found'))
      return
    }
    // Resolved again when the body has arrived: a grant revoked mid-request refuses too.
    const token = presentedPairingToken(request.headers)
    if (!grantForToken(token)) {
      respond(response, UNAUTHORIZED)
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      respond(response, refused(405, 'use POST'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        respond(response, refused(413, 'request too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (response.writableEnded) return
      let message: unknown
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        respond(response, refused(400, 'the request body is not JSON'))
        return
      }
      const grant = grantForToken(token)
      if (!grant) {
        respond(response, UNAUTHORIZED)
        return
      }
      const command = isRecord(message) ? message.command : undefined
      if (!ORCHESTRATOR_COMMANDS.includes(command as OrchestratorCommand)) {
        respond(response, refused(400, `unknown command ${JSON.stringify(command)}`))
        return
      }
      execute(grant, command as OrchestratorCommand, isRecord(message) ? message.args : undefined).then(
        (reply) => respond(response, reply),
        (error: unknown) => {
          options.log?.(`orchestrator call failed: ${errorMessage(error)}`)
          respond(response, refused(500, `Toucan could not complete the call: ${errorMessage(error)}`))
        }
      )
    })
  }

  const ensureListening = (): Promise<HttpServer> => {
    startedServer ??= new Promise((resolve, reject) => {
      const server = createServer(handleRequest)
      // The listener must never be what keeps the process alive - sessions are.
      server.unref()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server))
    })
    return startedServer
  }

  return {
    async grant(nodeId, scope) {
      const grant: LiveGrant = { ...scope, nodeId, token: createPairingToken() }
      // Registered before the await, so a revoke of another grant meanwhile cannot see an empty set
      // and close the listener this grant is about to hand out.
      grants.add(grant)
      // One live token per node: a relaunch replaces the grant it had, without bouncing the port.
      for (const existing of grants) if (existing !== grant && existing.nodeId === nodeId) revoke(existing)
      try {
        const server = await ensureListening()
        if (!grants.has(grant)) return undefined
        const port = (server.address() as AddressInfo).port
        return {
          environment: {
            [ORCHESTRATOR_URL_ENV]: `http://127.0.0.1:${port}${ORCHESTRATOR_ENDPOINT_PATH}`,
            [ORCHESTRATOR_TOKEN_ENV]: grant.token
          },
          setConversation: (conversationId) => {
            grant.conversationId = conversationId
          },
          revoke: () => revoke(grant)
        }
      } catch (error) {
        options.log?.(`orchestrator endpoint failed to listen: ${errorMessage(error)}`)
        startedServer = undefined
        revoke(grant)
        return undefined
      }
    },
    listening() {
      return startedServer !== undefined
    },
    async close() {
      grants.clear()
      const pending = startedServer
      startedServer = undefined
      if (!pending) return
      const server = await pending.catch(() => undefined)
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
