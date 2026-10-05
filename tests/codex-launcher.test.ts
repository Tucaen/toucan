import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { commandGuardFiles } from '../src/main/command-guard'
// @ts-expect-error - plain Node script shipped beside the guard; no declarations
import { codexArguments, codexEnvironment, createRelay } from '../.agents/command-guard/codex-launcher.mjs'
// @ts-expect-error - plain Node script shipped beside the skills; no declarations
import { reportBlock } from '../.agents/command-guard/guard.mjs'

const launcher = join(process.cwd(), '.agents', 'command-guard', 'codex-launcher.mjs')

interface Notification {
  method: string
  params: {
    threadId: string
    turnId: string
    item: { type: string; id: string; status: string; command: string; aggregatedOutput: string | null }
  }
}

const blockedHook = (threadId: string): string =>
  JSON.stringify({
    method: 'hook/completed',
    params: { threadId, turnId: 'turn-1', run: { eventName: 'preToolUse', status: 'blocked' } }
  })

test('the overrides go before the subcommand, one -c each', () => {
  assert.deepEqual(codexArguments(['a=1', 'b=2'], ['app-server']), ['-c', 'a=1', '-c', 'b=2', 'app-server'])
})

test('Codex gets the reports directory but none of the launch variables', () => {
  const environment = codexEnvironment(
    {
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      TOUCAN_CODEX_RUNTIME: '/toucan',
      TOUCAN_CODEX_EXECUTABLE: '/codex',
      TOUCAN_CODEX_CONFIG_OVERRIDES: '[]',
      // Inherited by every tool otherwise, so a Toucan started from one would launch through here.
      CODEX_PATH: '/toucan/codex-launcher.sh'
    },
    '/tmp/reports'
  )
  assert.deepEqual(environment, { PATH: '/bin', TOUCAN_COMMAND_GUARD_REPORTS: '/tmp/reports' })
})

test('a long line arriving in many chunks is forwarded once, whole', () => {
  const written: string[] = []
  const relay = createRelay((text: string) => written.push(text), mkdtempSync(join(tmpdir(), 'toucan-guard-reports-')))
  const line = `${JSON.stringify({ method: 'item/completed', params: { output: 'x'.repeat(5000) } })}\n`
  for (let index = 0; index < line.length; index += 7) relay(line.slice(index, index + 7))
  relay('tail')
  relay.flush()
  assert.deepEqual(written, [line, 'tail'])
})

test('a blocked guard hook is followed by a declined command carrying the reason', () => {
  const reports = mkdtempSync(join(tmpdir(), 'toucan-guard-reports-'))
  reportBlock(
    reports,
    {
      session_id: 'thread-1',
      turn_id: 'turn-1',
      tool_use_id: 'exec-1',
      cwd: '/work',
      tool_input: { command: 'rm -rf /' }
    },
    'Blocked by the guard.'
  )
  const written: string[] = []
  const relay = createRelay((text: string) => written.push(text), reports)
  // Split mid-line: the relay must forward whole lines only, and in order.
  const ordinary = JSON.stringify({ method: 'item/started', params: {} })
  const stream = `${ordinary}\n${blockedHook('thread-1')}\n`
  relay(stream.slice(0, 10))
  relay(stream.slice(10))
  assert.equal(written[0], `${ordinary}\n`)
  assert.equal(written[1], `${blockedHook('thread-1')}\n`)
  const [started, completed] = written.slice(2).map((line) => JSON.parse(line) as Notification)
  assert.equal(written.length, 4)
  assert.equal(started?.method, 'item/started')
  assert.equal(started?.params.item.status, 'inProgress')
  assert.equal(completed?.method, 'item/completed')
  assert.equal(completed?.params.threadId, 'thread-1')
  assert.equal(completed?.params.turnId, 'turn-1')
  assert.equal(completed?.params.item.type, 'commandExecution')
  assert.equal(completed?.params.item.id, started?.params.item.id)
  assert.equal(completed?.params.item.status, 'declined')
  assert.equal(completed?.params.item.command, 'rm -rf /')
  assert.equal(completed?.params.item.aggregatedOutput, 'Blocked by the guard.')
  // Taken, so the next block does not show this call a second time.
  assert.deepEqual(readdirSync(reports), [])
})

test('a hook another thread blocked, or one that did not block, adds nothing', () => {
  const reports = mkdtempSync(join(tmpdir(), 'toucan-guard-reports-'))
  reportBlock(
    reports,
    { session_id: 'thread-2', turn_id: 't', tool_use_id: 'x', cwd: '/', tool_input: { command: 'rm -rf /' } },
    'r'
  )
  const written: string[] = []
  const relay = createRelay((text: string) => written.push(text), reports)
  const completedHook = JSON.stringify({
    method: 'hook/completed',
    params: { threadId: 'thread-2', turnId: 't', run: { eventName: 'preToolUse', status: 'completed' } }
  })
  relay(`${blockedHook('thread-1')}\n${completedHook}\nnot json\n`)
  assert.equal(written.length, 3)
  assert.equal(readdirSync(reports).length, 1)
})

// The process seam: the launcher starts the executable it is given with the overrides, relays its
// stdout, passes its exit code on and removes the reports directory it made.
test('the launcher runs Codex, relays a block as a declined command and passes the exit code on', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-codex-launcher-'))
  const fakeCodex = join(directory, 'fake-codex.mjs')
  const seen = join(directory, 'seen.json')
  writeFileSync(
    fakeCodex,
    `
import { writeFileSync } from 'node:fs'
import { reportBlock } from ${JSON.stringify(new URL('../.agents/command-guard/guard.mjs', import.meta.url).href)}
const reports = process.env.TOUCAN_COMMAND_GUARD_REPORTS
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }))
reportBlock(reports, { session_id: 'thread-1', turn_id: 'turn-1', tool_use_id: 'exec-1', cwd: '/w', tool_input: { command: 'rm -rf /' } }, 'Blocked.')
process.stdout.write(${JSON.stringify(blockedHook('thread-1'))} + '\\n')
process.exit(3)
`
  )
  const run = spawnSync(process.execPath, [launcher, fakeCodex, 'app-server'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TOUCAN_CODEX_RUNTIME: process.execPath,
      TOUCAN_CODEX_EXECUTABLE: process.execPath,
      TOUCAN_CODEX_CONFIG_OVERRIDES: '[]'
    }
  })
  assert.equal(run.status, 3, run.stderr)
  const lines = run.stdout.split('\n').filter(Boolean)
  assert.equal(lines[0], blockedHook('thread-1'))
  assert.equal((JSON.parse(lines[2] ?? '{}') as Notification).params.item.status, 'declined')
  const { argv, env } = JSON.parse(readFileSync(seen, 'utf8')) as { argv: string[]; env: Record<string, string> }
  assert.deepEqual(argv, ['app-server'])
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.TOUCAN_CODEX_CONFIG_OVERRIDES, undefined)
  assert.equal(existsSync(env.TOUCAN_COMMAND_GUARD_REPORTS ?? ''), false)
})

test('the launchers for both platforms sit beside the guard script', () => {
  const directory = join(commandGuardFiles(process.cwd()).script, '..')
  const windows = readFileSync(join(directory, 'codex-launcher.cmd'), 'utf8')
  assert.match(windows, /set ELECTRON_RUN_AS_NODE=1/)
  assert.match(windows, /"%TOUCAN_CODEX_RUNTIME%" "%~dp0codex-launcher\.mjs" %\*/)
  const posix = readFileSync(join(directory, 'codex-launcher.sh'), 'utf8')
  assert.ok(posix.startsWith('#!/bin/sh\n'))
  assert.match(
    posix,
    /ELECTRON_RUN_AS_NODE=1 exec "\$TOUCAN_CODEX_RUNTIME" "\$\(dirname "\$0"\)\/codex-launcher\.mjs" "\$@"/
  )
})
