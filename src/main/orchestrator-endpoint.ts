import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentProvider } from '../shared/agent-provider'
import {
  applyPlan,
  applyTicketUpdate,
  ORCHESTRATOR_COMMANDS,
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  parsePlanInput,
  parseTicketUpdate,
  type OrchestrationRecord,
  type OrchestratorCommand
} from '../shared/orchestration'
import { pathIdentity } from '../shared/paths'
import { isRecord } from '../shared/record'
import { errorMessage } from '../shared/text'
import type { OrchestrationStore } from './orchestration-store'
import { createPairingToken, pairingTokenMatches, presentedPairingToken } from './remote/pairing'

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

export interface OrchestratorEndpointOptions {
  records: OrchestrationStore
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
  body: { ok: true; [key: string]: unknown } | { ok: false; error: string }
}

const refused = (status: number, error: string): Reply => ({ status, body: { ok: false, error } })

const MAX_REQUEST_BYTES = 1024 * 1024

const UNAUTHORIZED = refused(401, 'the orchestrator token is missing, wrong or revoked')

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
