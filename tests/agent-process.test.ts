import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { buildAgentProcessLaunch } from '../src/main/agent-process'
import { hiddenProcessOptions } from '../src/main/background-process'

test('agent adapters force their nested Windows processes to stay hidden', () => {
  const launch = buildAgentProcessLaunch(
    'C:\\Program Files\\Toucan\\Toucan.exe',
    'C:\\Program Files\\Toucan\\resources\\claude-agent-acp\\index.js',
    'D:\\Development\\Toucan',
    { PATH: 'C:\\Windows\\System32' }
  )

  assert.equal(launch.options.windowsHide, true)
  assert.deepEqual(launch.args, ['C:\\Program Files\\Toucan\\resources\\claude-agent-acp\\index.js'])
  assert.match(launch.options.env?.NODE_OPTIONS ?? '', /--import=data:text\/javascript/)
  assert.match(launch.options.env?.NODE_OPTIONS ?? '', /windowsHide%3A%20true/)
  assert.deepEqual(hiddenProcessOptions({ windowsHide: false, cwd: 'D:\\Development\\Toucan' }), {
    windowsHide: true,
    cwd: 'D:\\Development\\Toucan'
  })
})

test('agent adapters preserve their environment including the brain-dump library root', () => {
  const environment = { PATH: 'C:\\Windows', TOUCAN_BRAIN_DUMPS_DIR: 'C:\\Users\\Ada\\Toucan\\brain-dumps' }
  const launch = buildAgentProcessLaunch('electron.exe', 'adapter.js', 'D:\\Toucan', environment)
  assert.equal(launch.options.env?.PATH, environment.PATH)
  assert.equal(launch.options.env?.TOUCAN_BRAIN_DUMPS_DIR, environment.TOUCAN_BRAIN_DUMPS_DIR)
})

test('the hidden-window preload still imports and runs the ACP adapter entrypoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-agent-bootstrap-'))
  const adapterPath = join(directory, 'adapter.mjs')
  writeFileSync(adapterPath, "process.stdout.write('adapter loaded')\n", 'utf8')
  const launch = buildAgentProcessLaunch(process.execPath, adapterPath, directory, process.env)

  const result = spawnSync(launch.executable, launch.args, {
    ...launch.options,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'adapter loaded')
})

test('the hidden-window preload covers every Node child-process API', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-agent-propagation-'))
  const childPath = join(directory, 'child.mjs')
  const adapterPath = join(directory, 'adapter.mjs')
  writeFileSync(
    childPath,
    "import childProcess from 'node:child_process'\nconst methods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']\nprocess.stdout.write(String(methods.every((method) => childProcess[method].__adeForceHiddenWindows === true && String(childProcess[method]).includes('forceHiddenWindows'))))\n",
    'utf8'
  )
  writeFileSync(
    adapterPath,
    `import { spawnSync } from 'node:child_process'\nconst result = spawnSync(process.execPath, [${JSON.stringify(childPath)}], { encoding: 'utf8' })\nprocess.stdout.write(result.stdout)\n`,
    'utf8'
  )
  const launch = buildAgentProcessLaunch(process.execPath, adapterPath, directory, process.env)

  const result = spawnSync(launch.executable, launch.args, {
    ...launch.options,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'true')
})

test('nested agent executables are redirected from app.asar to app.asar.unpacked', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-agent-asar-'))
  const packedDirectory = join(directory, 'resources', 'app.asar', 'vendor')
  const unpackedDirectory = join(directory, 'resources', 'app.asar.unpacked', 'vendor')
  const packedExecutable = join(packedDirectory, 'provider.exe')
  const unpackedExecutable = join(unpackedDirectory, 'provider.exe')
  const adapterPath = join(directory, 'adapter.mjs')
  mkdirSync(unpackedDirectory, { recursive: true })
  copyFileSync(process.execPath, unpackedExecutable)
  writeFileSync(
    adapterPath,
    `import { spawnSync } from 'node:child_process'\nconst result = spawnSync(${JSON.stringify(packedExecutable)}, ['-e', "process.stdout.write('provider loaded')"], { encoding: 'utf8' })\nif (result.error) throw result.error\nprocess.stdout.write(result.stdout)\n`,
    'utf8'
  )
  const launch = buildAgentProcessLaunch(process.execPath, adapterPath, directory, process.env)

  const result = spawnSync(launch.executable, launch.args, {
    ...launch.options,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'provider loaded')
})
