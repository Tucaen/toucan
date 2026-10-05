#!/usr/bin/env node
// Dangerous-command guard: a provider-neutral PreToolUse hook for shell-like tools.
//
// Contract (shared by every provider that can register a hook):
//   argv[2]  path of the pattern list (ERE-style regexes, one per line, `#` comments, blank lines ignored)
//   stdin    the hook payload as JSON; the command is at `.tool_input.command`
//   exit 2   the command matched a pattern: the reason on stderr is shown to the agent
//   exit 0   allowed. Any other failure (unreadable payload or list) exits 1, which does not block.
//
// When TOUCAN_COMMAND_GUARD_REPORTS names a directory (set by `codex-launcher.mjs`), a blocked call
// is also recorded there, because Codex tells its ACP adapter about a blocking hook without naming
// the command, and the launcher needs it to show the call as a failed tool card.
//
// Runs on plain Node with no dependencies, so it needs neither bash nor jq.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPORTS_VARIABLE = 'TOUCAN_COMMAND_GUARD_REPORTS'

const POSIX_CLASSES = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  blank: ' \\t',
  digit: '0-9',
  lower: 'a-z',
  space: '\\s',
  upper: 'A-Z',
  word: '\\w'
}

/** Rewrites the POSIX bracket classes ERE allows (`[[:space:]]`) into their JavaScript spelling. */
function translateEre(source) {
  return source.replace(/\[:(\w+):\]/g, (whole, name) => POSIX_CLASSES[name] ?? whole)
}

/**
 * Parses a pattern list. Comments, blank lines and patterns that do not compile are skipped,
 * so one bad line never disables the rest of the guard.
 */
export function parsePatterns(text) {
  const patterns = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    try {
      patterns.push({ source: line, regex: new RegExp(translateEre(line), 'i') })
    } catch {
      // An invalid regex is skipped rather than allowed to crash the guard.
    }
  }
  return patterns
}

/** The first pattern the command matches, or undefined. */
export function findMatch(patterns, command) {
  return patterns.find((pattern) => pattern.regex.test(command))
}

/** The text the agent sees when a command is blocked. */
export function blockReason(source) {
  return (
    `Blocked by Toucan's command guard: the command matches the dangerous pattern ${source}. ` +
    'Do not retry this command or work around the guard with an equivalent; ' +
    'ask the user to run it themselves if it is really needed.'
  )
}

/** Records one blocked call for the Codex launcher, one file per call, so writers never interleave. */
export function reportBlock(directory, payload, reason) {
  const record = {
    session_id: payload.session_id,
    turn_id: payload.turn_id,
    tool_use_id: payload.tool_use_id,
    command: payload.tool_input.command,
    cwd: payload.cwd,
    reason
  }
  writeFileSync(join(directory, `${randomUUID()}.json`), JSON.stringify(record))
}

function main() {
  let payload
  let patterns
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
    patterns = parsePatterns(readFileSync(process.argv[2], 'utf8'))
  } catch (error) {
    process.stderr.write(`Command guard could not run: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  const command = payload?.tool_input?.command
  if (typeof command !== 'string') return
  const match = findMatch(patterns, command)
  if (!match) return
  const reason = blockReason(match.source)
  const reports = process.env[REPORTS_VARIABLE]
  if (reports) {
    try {
      reportBlock(reports, payload, reason)
    } catch {
      // Only the tool card is lost; the call is still blocked below.
    }
  }
  process.stderr.write(`${reason}\n`)
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
