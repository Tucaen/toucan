import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AdapterPackage = 'claude-agent-acp' | 'codex-acp'

/** The `dist` directory the session manager resolves an installed ACP adapter from. */
function adapterDistDirectory(appPath: string, adapter: AdapterPackage): string {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', adapter, 'dist')
  mkdirSync(directory, { recursive: true })
  return directory
}

/** Installs an adapter whose entry point is empty: enough for `create` to launch, nothing more. */
export function installAdapterStub(appPath: string, adapter: AdapterPackage): void {
  writeFileSync(join(adapterDistDirectory(appPath, adapter), 'index.js'), '')
}

export interface ScriptedAdapter {
  /** JavaScript run once at start-up, after `send` is defined and before any request arrives. */
  prelude?: string
  /** JavaScript body of `(request) => { ... }`, invoked for every request other than `initialize`. */
  handleRequest: string
  /** Extra `agentCapabilities` merged into the `initialize` answer; `loadSession: true` stays. */
  agentCapabilities?: Record<string, unknown>
}

/**
 * Installs a scripted stand-in for an ACP adapter: a real child process speaking newline-delimited
 * JSON-RPC over stdio, answering `initialize` with `loadSession` support and handing every other
 * request to the test's own script, which replies through `send(message)`.
 */
export function installScriptedAdapter(appPath: string, adapter: AdapterPackage, script: ScriptedAdapter): void {
  writeFileSync(
    join(adapterDistDirectory(appPath, adapter), 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
${script.prelude ?? ''}
const handleRequest = (request) => {
${script.handleRequest}
}
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: Object.assign({ loadSession: true }, ${JSON.stringify(script.agentCapabilities ?? {})}),
      authMethods: []
    } })
  } else {
    handleRequest(request)
  }
})
`,
    'utf8'
  )
}
