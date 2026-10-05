import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { commandGuardFiles } from '../src/main/command-guard'
import { registerCommandGuardSettingsIpc } from '../src/main/command-guard-settings-ipc'
import { createCommandGuardSettingsStore } from '../src/main/command-guard-settings-store'
import {
  normalizePatternText,
  translateEre,
  validateCommandGuardPatterns,
  type CommandGuardSaveResult,
  type CommandGuardSettingsState
} from '../src/shared/command-guard-settings'
// @ts-expect-error - plain Node script shipped beside the skills; no declarations
import { findMatch, parsePatterns } from '../.agents/command-guard/guard.mjs'

// The command guard settings (ticket 03): a switch and an editable pattern list in a file of their
// own, read by every session as it opens.

const bundled = commandGuardFiles(process.cwd())
const defaults = readFileSync(bundled.patterns, 'utf8')
const setup = () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'toucan-command-guard-settings-'))
  const open = () => createCommandGuardSettingsStore({ userDataPath, bundled })
  return { userDataPath, open, store: open() }
}
const saved = (result: CommandGuardSaveResult): CommandGuardSettingsState => {
  assert.ok(result.ok, 'expected the save to land')
  return result.state
}

test('invalid regexes are reported by line with the engine message; comments and blanks are not patterns', () => {
  const errors = validateCommandGuardPatterns(
    ['# a comment', '', 'fine[[:space:]]ok', '([unclosed', 'x', '*bad'].join('\r\n')
  )
  assert.deepEqual(
    errors.map((error) => error.line),
    [4, 6]
  )
  assert.ok(errors.every((error) => error.message.length > 0))
  assert.deepEqual(validateCommandGuardPatterns(defaults), [])
})

test('the settings validator translates POSIX classes exactly as the guard script does', () => {
  const shipped = defaults.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'))
  const compiled = (parsePatterns(defaults) as Array<{ regex: RegExp }>).map((pattern) => pattern.regex.source)
  assert.deepEqual(
    shipped.map((line) => new RegExp(translateEre(line.trim()), 'i').source),
    compiled
  )
})

test('a fresh install has the guard on and follows the built-in list', async () => {
  const { store } = setup()
  const state = await store.state()
  assert.deepEqual(state.preferences, { enabled: true, patterns: null })
  assert.equal(state.defaults, defaults)
  assert.deepEqual(await store.launch(), bundled)
})

test('turning the guard off leaves new sessions with no hook, and turning it on restores it', async () => {
  const { store } = setup()
  saved(await store.save({ enabled: false, patterns: defaults }))
  assert.equal(await store.launch(), null)
  saved(await store.save({ enabled: true, patterns: defaults }))
  assert.deepEqual(await store.launch(), bundled)
})

test('an edited list is what new sessions run, and it blocks what the defaults allowed', async () => {
  const { store, userDataPath } = setup()
  const command = 'terraform destroy -auto-approve'
  assert.equal(findMatch(parsePatterns(defaults), command), undefined)
  saved(await store.save({ enabled: true, patterns: `${defaults}\n# mine\nterraform[[:space:]]+destroy\n` }))
  const files = await store.launch()
  assert.ok(files)
  assert.equal(files.script, bundled.script)
  assert.ok(files.patterns.startsWith(userDataPath))
  const run = spawnSync(process.execPath, [files.script, files.patterns], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /terraform/)
})

test('a hand-edited or deleted materialized list is restored to what was saved at the next launch', async () => {
  const { store } = setup()
  saved(await store.save({ enabled: true, patterns: 'only[[:space:]]this' }))
  const files = (await store.launch())!
  writeFileSync(files.patterns, 'tampered')
  await store.launch()
  assert.equal(readFileSync(files.patterns, 'utf8'), 'only[[:space:]]this')
})

test('editing the list leaves the file a running session already holds untouched', async () => {
  const { store } = setup()
  saved(await store.save({ enabled: true, patterns: 'first[[:space:]]list' }))
  const running = (await store.launch())!
  saved(await store.save({ enabled: true, patterns: 'second[[:space:]]list' }))
  const next = (await store.launch())!
  assert.notEqual(next.patterns, running.patterns)
  assert.equal(readFileSync(running.patterns, 'utf8'), 'first[[:space:]]list')
  assert.equal(readFileSync(next.patterns, 'utf8'), 'second[[:space:]]list')
})

test('Reset to defaults restores the built-in list', async () => {
  const { store } = setup()
  saved(await store.save({ enabled: true, patterns: 'only[[:space:]]this' }))
  const reset = saved(await store.save({ enabled: true, patterns: `${defaults}\r\n\r\n` }))
  assert.equal(reset.preferences.patterns, null)
  assert.deepEqual(await store.launch(), bundled)
  assert.equal(normalizePatternText(`${defaults}\r\n\r\n`), normalizePatternText(defaults))
})

test('an invalid regex is refused with its line and nothing is stored', async () => {
  const { store, open } = setup()
  const result = await store.save({ enabled: false, patterns: 'good\n([bad' })
  assert.ok(!result.ok)
  assert.deepEqual(
    result.errors.map((error) => error.line),
    [2]
  )
  const reopened = await open().state()
  assert.deepEqual(reopened.preferences, { enabled: true, patterns: null })
})

test('the settings survive a restart', async () => {
  const { store, open } = setup()
  saved(await store.save({ enabled: false, patterns: 'only[[:space:]]this' }))
  const reopened = await open().state()
  assert.deepEqual(reopened.preferences, { enabled: false, patterns: 'only[[:space:]]this' })
})

test('a damaged preferences file never opens the guard: sessions run on the defaults', async () => {
  const { userDataPath } = setup()
  writeFileSync(join(userDataPath, 'command-guard-settings.json'), '{ not json')
  const store = createCommandGuardSettingsStore({ userDataPath, bundled })
  assert.deepEqual(await store.launch(), bundled)
})

test('the IPC answers state, saves, reports invalid lines, and refuses malformed requests', async () => {
  const { store } = setup()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerCommandGuardSettingsIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    store
  )
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<unknown>
  assert.deepEqual(((await call('command-guard-settings:state')) as CommandGuardSettingsState).preferences, {
    enabled: true,
    patterns: null
  })
  const bad = (await call('command-guard-settings:save', { enabled: true, patterns: '(' })) as CommandGuardSaveResult
  assert.ok(!bad.ok && bad.errors[0]?.line === 1)
  const good = (await call('command-guard-settings:save', { enabled: false, patterns: 'x' })) as CommandGuardSaveResult
  assert.ok(good.ok && good.state.preferences.enabled === false)
  await assert.rejects(async () => call('command-guard-settings:save', 'x'), /object/)
  await assert.rejects(
    async () => call('command-guard-settings:save', { enabled: 'yes', patterns: '' }),
    /true or false/
  )
  await assert.rejects(async () => call('command-guard-settings:save', { enabled: true, patterns: 3 }), /text/)
})
