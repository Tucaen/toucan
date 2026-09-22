import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createCommandLookup, type CommandLookup } from '../src/main/command-lookup'

const APPDATA_NPM = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
const LOCAL_BIN = 'C:\\Users\\dev\\.local\\bin'

function lookup(options: { path?: Record<string, string>; onDisk?: string[] }): {
  find: CommandLookup
  probes: string[]
} {
  const probes: string[] = []
  const answer = (command: string): string => {
    probes.push(command)
    const output = options.path?.[command]
    if (output === undefined) throw new Error('INFO: Could not find files for the given pattern(s).')
    return output
  }
  return {
    find: createCommandLookup({
      fallbackDirectories: [APPDATA_NPM, LOCAL_BIN],
      where: { sync: answer, async: async (command) => answer(command) },
      pathExists: (path) => (options.onDisk ?? []).includes(path)
    }),
    probes
  }
}

test('resolves the first launchable path PATH offers', async () => {
  const { find } = lookup({ path: { gh: 'C:\\Program Files\\GitHub CLI\\gh.exe\r\n' } })
  assert.equal(await find.find('gh'), 'C:\\Program Files\\GitHub CLI\\gh.exe')
})

test('a globally installed shim outranks whatever PATH found first', async () => {
  const { find } = lookup({
    path: { gh: 'C:\\stale\\gh.exe\r\n' },
    onDisk: [`${APPDATA_NPM}\\gh.cmd`]
  })
  assert.equal(await find.find('gh'), `${APPDATA_NPM}\\gh.cmd`)
})

test('the Store stub is never the answer, however early PATH lists it', async () => {
  const { find } = lookup({
    path: { codex: 'C:\\WindowsApps\\OpenAI.Codex_1.0\\codex.exe\r\nC:\\tools\\codex.exe\r\n' }
  })
  assert.equal(await find.find('codex'), 'C:\\tools\\codex.exe')
})

test('a command nothing answers to is asked about again, so installing it mid-session is seen', async () => {
  const path: Record<string, string> = {}
  const { find, probes } = lookup({ path })
  assert.equal(await find.find('gh'), null)
  path.gh = 'C:\\tools\\gh.exe\r\n'
  assert.equal(await find.find('gh'), 'C:\\tools\\gh.exe')
  assert.deepEqual(probes, ['gh', 'gh'])
})

test('a command that was found is never probed twice', async () => {
  const { find, probes } = lookup({ path: { gh: 'C:\\tools\\gh.exe\r\n' } })
  assert.equal(await find.find('gh'), 'C:\\tools\\gh.exe')
  assert.equal(await find.find('gh'), 'C:\\tools\\gh.exe')
  assert.deepEqual(probes, ['gh'])
})

test('the npm shim outranks a binary of the same name in the same fallback folder', async () => {
  const { find } = lookup({ onDisk: [`${APPDATA_NPM}\\gh.cmd`, `${APPDATA_NPM}\\gh.exe`] })
  assert.equal(await find.find('gh'), `${APPDATA_NPM}\\gh.cmd`)
})

test('when PATH has nothing, a fallback that is really on disk still answers', async () => {
  const { find } = lookup({ onDisk: [`${LOCAL_BIN}\\codex.exe`] })
  assert.equal(await find.find('codex'), `${LOCAL_BIN}\\codex.exe`)
})

test('ten asks that start at once run one probe between them', async () => {
  const { find, probes } = lookup({ path: { gh: 'C:\\tools\\gh.exe\r\n' } })
  const answers = await Promise.all(Array.from({ length: 10 }, () => find.find('gh')))
  assert.deepEqual(new Set(answers), new Set(['C:\\tools\\gh.exe']))
  assert.deepEqual(probes, ['gh'])
})

test('the sync and async readers share one cache in both directions', async () => {
  const first = lookup({ path: { pwsh: 'C:\\tools\\pwsh.exe\r\n' } })
  assert.equal(first.find.findSync('pwsh'), 'C:\\tools\\pwsh.exe')
  assert.equal(await first.find.find('pwsh'), 'C:\\tools\\pwsh.exe')
  assert.deepEqual(first.probes, ['pwsh'])

  const second = lookup({ path: { gh: 'C:\\tools\\gh.exe\r\n' } })
  assert.equal(await second.find.find('gh'), 'C:\\tools\\gh.exe')
  assert.equal(second.find.findSync('gh'), 'C:\\tools\\gh.exe')
  assert.deepEqual(second.probes, ['gh'])
})
