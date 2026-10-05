#!/usr/bin/env node
// Toucan's CODEX_PATH for a guarded Codex session (ticket 02). codex-acp runs `CODEX_PATH app-server`;
// this starts the bundled Codex with the command guard registered and trusted as `-c` overrides,
// because Codex ignores hooks in codex-acp's CODEX_CONFIG. `src/main/command-guard.ts` builds the
// variables below.
//
//   TOUCAN_CODEX_EXECUTABLE        the native Codex binary to start
//   TOUCAN_CODEX_CONFIG_OVERRIDES  JSON array of `key=value` overrides, one `-c` each
//   TOUCAN_CODEX_RUNTIME           Toucan's own binary, which runs this script (read by the wrappers)
//
// None of them, nor ELECTRON_RUN_AS_NODE, reach Codex, so no tool the agent runs inherits them.
//
// codex-acp drops Codex's hook notifications, and Codex never reports a command its hook blocked as
// an item. So the guard records each block in a directory made here, and the relay below follows
// every blocked hook with a declined command carrying the guard's reason: the chat then shows the
// call as a failed tool card, the way Claude's adapter does on its own.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LAUNCH_VARIABLES = [
  'ELECTRON_RUN_AS_NODE',
  'TOUCAN_CODEX_RUNTIME',
  'TOUCAN_CODEX_EXECUTABLE',
  'TOUCAN_CODEX_CONFIG_OVERRIDES'
]
const REPORTS_VARIABLE = 'TOUCAN_COMMAND_GUARD_REPORTS'

/** Codex's arguments: the overrides are root options, so they go before the subcommand. */
export function codexArguments(overrides, args) {
  return [...overrides.flatMap((override) => ['-c', override]), ...args]
}

export function codexEnvironment(environment, reports) {
  const codex = { ...environment }
  for (const name of LAUNCH_VARIABLES) delete codex[name]
  codex[REPORTS_VARIABLE] = reports
  return codex
}

/** Removes and returns the blocks the guard recorded for one thread. */
function takeReports(directory, threadId) {
  const reports = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    let report
    try {
      report = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (report?.session_id !== threadId) continue
    rmSync(path, { force: true })
    reports.push(report)
  }
  return reports
}

/** The pair of app-server notifications that show one blocked call as a declined command. */
function declinedCommand(report, threadId, turnId) {
  const now = Date.now()
  const item = {
    type: 'commandExecution',
    id: `toucan-guard-${report.tool_use_id}`,
    pluginId: null,
    scriptPath: null,
    command: report.command,
    cwd: report.cwd ?? '',
    processId: null,
    source: 'unifiedExecStartup',
    status: 'inProgress',
    commandActions: [{ type: 'unknown', command: report.command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null
  }
  return [
    { method: 'item/started', params: { item, threadId, turnId, startedAtMs: now } },
    {
      method: 'item/completed',
      params: {
        item: { ...item, status: 'declined', aggregatedOutput: report.reason, durationMs: 0 },
        threadId,
        turnId,
        completedAtMs: now
      }
    }
  ]
}

/** The notifications to add after one line of Codex's output: none, unless it is a blocked hook. */
function additionsAfter(line, reports) {
  // Cheap test first: almost every line is something else, and only this one needs parsing.
  if (!line.includes('"hook/completed"')) return []
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return []
  }
  const params = message?.params
  if (message?.method !== 'hook/completed' || params?.run?.status !== 'blocked') return []
  if (params.run.eventName !== 'preToolUse' || typeof params.threadId !== 'string') return []
  return takeReports(reports, params.threadId).flatMap((report) =>
    declinedCommand(report, params.threadId, params.turnId ?? report.turn_id)
  )
}

/**
 * Forwards Codex's stdout whole line by whole line, so an addition never lands inside a message.
 * Returns the function to feed chunks to; `flush` writes what is left of a last unterminated line.
 */
export function createRelay(write, reports) {
  let buffer = ''
  const relay = (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end + 1)
      buffer = buffer.slice(end + 1)
      write(line)
      for (const addition of additionsAfter(line, reports)) write(`${JSON.stringify(addition)}\n`)
    }
  }
  relay.flush = () => {
    if (buffer) write(buffer)
    buffer = ''
  }
  return relay
}

function main() {
  const reports = mkdtempSync(join(tmpdir(), 'toucan-codex-guard-reports-'))
  const removeReports = () => rmSync(reports, { recursive: true, force: true })
  let overrides
  try {
    overrides = JSON.parse(process.env.TOUCAN_CODEX_CONFIG_OVERRIDES ?? '[]')
  } catch (error) {
    // Starting Codex without the overrides would be an unguarded session that looks guarded.
    process.stderr.write(`Toucan's Codex launcher could not read its overrides: ${error.message}\n`)
    removeReports()
    process.exit(1)
  }
  const codex = spawn(process.env.TOUCAN_CODEX_EXECUTABLE ?? '', codexArguments(overrides, process.argv.slice(2)), {
    env: codexEnvironment(process.env, reports),
    stdio: ['inherit', 'pipe', 'inherit'],
    windowsHide: true
  })
  const relay = createRelay((text) => process.stdout.write(text), reports)
  codex.stdout.setEncoding('utf8')
  codex.stdout.on('data', relay)
  // The adapter went away: nobody reads Codex any more.
  process.stdout.on('error', () => codex.kill())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => codex.kill(signal))
  codex.on('error', (error) => {
    process.stderr.write(`Toucan's Codex launcher could not start Codex: ${error.message}\n`)
    removeReports()
    process.exitCode = 1
  })
  codex.on('close', (code) => {
    relay.flush()
    removeReports()
    // Set, not `process.exit`: that could cut off what is still queued for a piped stdout.
    process.exitCode = code ?? 1
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
