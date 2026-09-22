import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { errorMessage } from '../shared/text'
import { createPairingToken, pairingTokenMatches, presentedPairingToken } from './remote/pairing'
import type { TerminalContextRegistry } from './terminal-context-registry'
import type { TerminalOutputRead, TerminalReadOptions } from './terminal-output-tail'

/**
 * The Toucan-hosted MCP server behind the terminal-context edge (slice 3 of
 * `docs/plans/terminal-context-edge.md`): one `read_terminal_output` tool, served over a
 * localhost-only HTTP listener in main, handed to an ACP session as an `mcpServers` entry only
 * when its chat node has a terminal edge at creation - a session without one carries zero extra
 * tokens. Both pinned adapters were verified to accept `type: 'http'` entries (claude-agent-acp
 * 0.75.1 forwards `{url, headers}` to the SDK; codex-acp 1.10.0 maps them to Codex's
 * `{url, http_headers}` and rejects only SSE/ACP transports), which is what settled the plan's
 * open transport question in favour of this listener over a stdio bridge script.
 *
 * The protocol implementation is deliberately hand-rolled rather than
 * `@modelcontextprotocol/sdk`: the surface a tools-only stateless server needs is five methods
 * over plain JSON-RPC POSTs, and the tests' CommonJS resolution cannot see the SDK's
 * exports-map-only subpaths. Responses are always `application/json` (never SSE), which the
 * streamable-HTTP spec allows and both adapters' clients accept.
 *
 * Two rules keep it honest. The listener binds 127.0.0.1 lazily - the first session that
 * actually has an edge is what opens the port, so the >90% of app runs with no edge open no
 * network surface at all. And a tool definition never implies the capability: every call is
 * checked against the edge registry at call time, so a revoked edge refuses immediately while
 * the definition merely lingers until the session's next natural resume. Authorization is a
 * per-agent bearer token minted with the grant; it identifies the calling agent (the read
 * cursor is per reader) and shuts out any stray local process that finds the port.
 */

/** The `mcpServers` entry both adapters accept for an HTTP MCP server. */
export interface AcpMcpHttpServer {
  name: string
  type: 'http'
  url: string
  headers: Array<{ name: string; value: string }>
}

/** @internal exported for tests */
export const TERMINAL_CONTEXT_MCP_SERVER_NAME = 'toucan-terminal'
export const TERMINAL_CONTEXT_MCP_PATH = '/mcp'

export interface TerminalContextMcpOptions {
  registry: TerminalContextRegistry
  /** The terminal manager's `readOutput`: bounded tail plus liveness, cursor advanced per reader. */
  readOutput(agentId: string, terminalSessionId: string, options?: TerminalReadOptions): TerminalOutputRead | undefined
  log?(message: string): void
}

export interface TerminalContextMcp {
  /**
   * The `mcpServers` entry for this agent's session, or undefined when no terminal edge stands -
   * the session-creation gate. Never throws: a listener that cannot bind costs the session its
   * tool, never its creation.
   */
  serverFor(agentId: string): Promise<AcpMcpHttpServer | undefined>
  /** Whether the lazy listener has been started - the "no edge, no network surface" check. */
  listening(): boolean
  close(): Promise<void>
}

/** The protocol revisions this server behaves identically under; anything else answers the newest. */
const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const LATEST_PROTOCOL_VERSION = '2025-06-18'

/** @internal exported for tests */
export const READ_TERMINAL_OUTPUT_TOOL = {
  name: 'read_terminal_output',
  description:
    "Read recent output from the user's terminal(s) connected to this chat (e.g. a running dev " +
    'server or build watcher). The first call returns the most recent output; every later call ' +
    'returns only output that appeared since your last read, so call it again after making a ' +
    'change to see the fresh result. With a single connected terminal, call it with no arguments.',
  inputSchema: {
    type: 'object',
    properties: {
      terminal: {
        type: 'string',
        description: 'Terminal session id, needed only when several terminals are connected. Omit otherwise.'
      },
      maxLines: { type: 'number', description: 'Return at most this many trailing lines (default 200).' },
      maxBytes: {
        type: 'number',
        description: 'Return at most this many bytes (default 16384, capped at what the app retains).'
      }
    }
  }
} as const

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: number | string | null } & (
  { result: unknown } | { error: { code: number; message: string } }
)

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A tool-level refusal: an answer the model can act on, never a protocol error. */
function toolText(
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

function livenessLabel(liveness: TerminalOutputRead['liveness']): string {
  return liveness === 'live' ? 'process running' : liveness === 'exited' ? 'process exited' : 'process state unknown'
}

/**
 * The plain-text shape one read returns to the model; exported so tests pin the wording once.
 * @internal exported for tests
 */
export function renderTerminalRead(read: TerminalOutputRead): string {
  const span = read.delta ? 'output since your last read' : 'most recent output'
  const skipped = read.skippedBytes > 0 ? `; ${read.skippedBytes} bytes skipped (read sooner or raise maxBytes)` : ''
  const header = `[terminal ${read.terminalSessionId} | ${livenessLabel(read.liveness)} | ${span}${skipped}]`
  const body = read.text !== '' ? read.text : read.delta ? '(no new output since your last read)' : '(no output)'
  return `${header}\n${body}`
}

export function createTerminalContextMcp(options: TerminalContextMcpOptions): TerminalContextMcp {
  const tokensByAgent = new Map<string, string>()
  /** The lazily started listener; pending from the first grant, undefined until then and after close. */
  let startedServer: Promise<HttpServer> | undefined

  /** Constant-time per candidate, like the remote server's pairing gate; the map stays tiny. */
  const agentForToken = (presented: string | null): string | undefined => {
    for (const [agentId, token] of tokensByAgent) {
      if (pairingTokenMatches(token, presented)) return agentId
    }
    return undefined
  }

  const boundedNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

  const readTerminalOutput = (agentId: string, args: Record<string, unknown>): ReturnType<typeof toolText> => {
    // The call-time capability check: the registry, never the tool definition, is what grants.
    const connected = options.registry.terminalSessionIdsFor(agentId)
    if (connected.length === 0) {
      return toolText(
        'No terminal is connected to this chat. The user grants access by drawing an edge from a terminal node to this chat node.',
        true
      )
    }
    const selector = typeof args.terminal === 'string' ? args.terminal : undefined
    const target = selector ?? (connected.length === 1 ? connected[0] : undefined)
    if (!target) {
      return toolText(
        `Several terminals are connected: ${connected.join(', ')}. Call again with "terminal" set to one of them.`,
        true
      )
    }
    if (!options.registry.hasEdge(agentId, target)) {
      return toolText(`No terminal ${target} is connected to this chat. Connected: ${connected.join(', ')}.`, true)
    }
    const read = options.readOutput(agentId, target, {
      maxBytes: boundedNumber(args.maxBytes),
      maxLines: boundedNumber(args.maxLines)
    })
    if (!read) return toolText('That terminal has no readable output: it has not run in this app session.', true)
    return toolText(renderTerminalRead(read))
  }

  /** One JSON-RPC message in, one response out; undefined for notifications, which get none. */
  const handleMessage = (agentId: string, message: JsonRpcMessage): JsonRpcResponse | undefined => {
    if (message.id === undefined || message.id === null || typeof message.method !== 'string') return undefined
    const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: message.id!, result })
    switch (message.method) {
      case 'initialize': {
        const requested = record(message.params)?.protocolVersion
        return respond({
          protocolVersion:
            typeof requested === 'string' && KNOWN_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: TERMINAL_CONTEXT_MCP_SERVER_NAME, version: '1.0.0' }
        })
      }
      case 'ping':
        return respond({})
      case 'tools/list':
        return respond({ tools: [READ_TERMINAL_OUTPUT_TOOL] })
      case 'tools/call': {
        const params = record(message.params) ?? {}
        if (params.name !== READ_TERMINAL_OUTPUT_TOOL.name) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: `Unknown tool: ${String(params.name)}` }
          }
        }
        return respond(readTerminalOutput(agentId, record(params.arguments) ?? {}))
      }
      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` }
        }
    }
  }

  const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    response.end(text)
  }

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== TERMINAL_CONTEXT_MCP_PATH) {
      response.writeHead(404).end()
      return
    }
    const agentId = agentForToken(presentedPairingToken(request.headers))
    if (!agentId) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      // A request is a tool call, not a payload channel; anything oversized is refused outright.
      if (size > 1024 * 1024) {
        respondJson(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request too large' }
        })
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (response.writableEnded) return
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        respondJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      // Batches predate the 2025-03-26 revision but cost one flatMap to keep honouring.
      const messages = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => record(entry) ?? {})
      const responses = messages.flatMap((message) => {
        const answered = handleMessage(agentId, message as JsonRpcMessage)
        return answered ? [answered] : []
      })
      if (responses.length === 0) {
        // Notifications alone: accepted, nothing to say.
        response.writeHead(202).end()
        return
      }
      respondJson(response, 200, Array.isArray(parsed) ? responses : responses[0])
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
    async serverFor(agentId) {
      if (options.registry.terminalSessionIdsFor(agentId).length === 0) return undefined
      try {
        const server = await ensureListening()
        const port = (server.address() as AddressInfo).port
        let token = tokensByAgent.get(agentId)
        if (!token) {
          token = createPairingToken()
          tokensByAgent.set(agentId, token)
        }
        return {
          name: TERMINAL_CONTEXT_MCP_SERVER_NAME,
          type: 'http',
          url: `http://127.0.0.1:${port}${TERMINAL_CONTEXT_MCP_PATH}`,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
        }
      } catch (error) {
        // A failed bind costs the session its tool, never its creation; the next grant retries.
        options.log?.(`terminal-context MCP listener failed: ${errorMessage(error)}`)
        startedServer = undefined
        return undefined
      }
    },
    listening() {
      return startedServer !== undefined
    },
    async close() {
      tokensByAgent.clear()
      const pending = startedServer
      startedServer = undefined
      if (!pending) return
      const server = await pending.catch(() => undefined)
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
