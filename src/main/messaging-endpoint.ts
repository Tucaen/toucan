import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isRecord } from '../shared/record'
import {
  MESSAGING_COMMANDS,
  MESSAGING_TOKEN_ENV,
  MESSAGING_URL_ENV,
  type MessagingCommand
} from '../shared/session-messaging'
import { errorMessage } from '../shared/text'
import { createPairingToken, pairingTokenMatches, presentedPairingToken } from './remote/pairing'
import type { MessagingReply, SessionMessenger } from './session-messenger'

/**
 * The local endpoint the session-messaging CLI talks to (#2), on the orchestrator endpoint's rules
 * (`orchestrator-endpoint.ts`): plain JSON over a 127.0.0.1 listener that binds lazily with the
 * first grant and closes with the last revoke, and a per-node bearer token that is only ever
 * honoured while its grant is live. Unlike an orchestrator's, every chat session holds one; what a
 * caller may do is decided by the messenger from the node the token names, never by the caller.
 */

/** @internal exported for tests */
export const MESSAGING_ENDPOINT_PATH = '/message'

export interface MessagingGrant {
  /** The two variables the adapter process is launched with. */
  environment: Record<typeof MESSAGING_URL_ENV | typeof MESSAGING_TOKEN_ENV, string>
  revoke(): void
}

export interface MessagingEndpoint {
  /** Never throws: a listener that cannot bind costs the session messaging, never its launch. */
  grant(nodeId: string): Promise<MessagingGrant | undefined>
  /** Whether the listener is bound. */
  listening(): boolean
  close(): Promise<void>
}

export interface MessagingEndpointOptions {
  messenger: Pick<SessionMessenger, 'execute'>
  log?(message: string): void
}

interface LiveGrant {
  nodeId: string
  token: string
}

const MAX_REQUEST_BYTES = 64 * 1024

const refused = (status: number, error: string): MessagingReply => ({ status, body: { ok: false, error } })

const UNAUTHORIZED = refused(
  401,
  'the messaging token is missing, wrong or revoked; only a session Toucan launched holds one'
)

export function createMessagingEndpoint(options: MessagingEndpointOptions): MessagingEndpoint {
  const grants = new Set<LiveGrant>()
  let startedServer: Promise<HttpServer> | undefined

  /** Constant-time per candidate, like the orchestrator endpoint's gate. */
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

  const respond = (response: ServerResponse, reply: MessagingReply): void => {
    const text = JSON.stringify(reply.body)
    response.writeHead(reply.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    response.end(text)
  }

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== MESSAGING_ENDPOINT_PATH) {
      respond(response, refused(404, 'not found'))
      return
    }
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
      // Resolved again now that the body has arrived: a grant revoked mid-request refuses too.
      const grant = grantForToken(token)
      if (!grant) {
        respond(response, UNAUTHORIZED)
        return
      }
      const command = isRecord(message) ? message.command : undefined
      if (!MESSAGING_COMMANDS.includes(command as MessagingCommand)) {
        respond(response, refused(400, `unknown command ${JSON.stringify(command)}`))
        return
      }
      options.messenger
        .execute(grant.nodeId, command as MessagingCommand, isRecord(message) ? message.args : undefined)
        .then(
          (reply) => respond(response, reply),
          (error: unknown) => {
            options.log?.(`messaging call failed: ${errorMessage(error)}`)
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
    async grant(nodeId) {
      const grant: LiveGrant = { nodeId, token: createPairingToken() }
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
            [MESSAGING_URL_ENV]: `http://127.0.0.1:${port}${MESSAGING_ENDPOINT_PATH}`,
            [MESSAGING_TOKEN_ENV]: grant.token
          },
          revoke: () => revoke(grant)
        }
      } catch (error) {
        options.log?.(`messaging endpoint failed to listen: ${errorMessage(error)}`)
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
