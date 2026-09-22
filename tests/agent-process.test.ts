import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'vitest'
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
    "import childProcess from 'node:child_process'\nconst methods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']\nprocess.stdout.write(String(methods.every((method) => childProcess[method].__adeForceHiddenWindows === true && String(childProcess[method]).includes('launchOptionsFor'))))\n",
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

// Prints what a child can observe about the launch policy: the two variables and whether the preload patched it.
const environmentProbe =
  "process.stdout.write(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, patched: require('node:child_process').spawn.__adeForceHiddenWindows === true }))\n"

/** Runs `adapterLines` as an ACP adapter under the preload and parses the JSON it prints. */
function runAdapter(prefix: string, adapterLines: string[], environment: NodeJS.ProcessEnv): unknown {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  const probePath = join(directory, 'probe.cjs')
  const foreignRuntime = join(directory, 'foreign-node.exe')
  const adapterPath = join(directory, 'adapter.mjs')
  writeFileSync(probePath, environmentProbe, 'utf8')
  copyFileSync(process.execPath, foreignRuntime)
  writeFileSync(
    adapterPath,
    [
      `const probePath = ${JSON.stringify(probePath)}`,
      `const foreignRuntime = ${JSON.stringify(foreignRuntime)}`,
      ...adapterLines
    ].join('\n'),
    'utf8'
  )
  const launch = buildAgentProcessLaunch(process.execPath, adapterPath, directory, environment)
  const result = spawnSync(launch.executable, launch.args, { ...launch.options, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const withoutNodeOptions = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  return environment
}

test('the preload strips its launch variables so processes off the adapter runtime inherit a clean environment', () => {
  const output = runAdapter(
    'toucan-agent-clean-env-',
    [
      "import { spawnSync, execFileSync } from 'node:child_process'",
      'const own = { nodeOptions: process.env.NODE_OPTIONS ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }',
      "const spawned = spawnSync(foreignRuntime, [probePath], { encoding: 'utf8' })",
      'if (spawned.error) throw spawned.error',
      "const explicitEnv = execFileSync(foreignRuntime, [probePath], { encoding: 'utf8', env: { ...process.env, EXTRA: '1' } })",
      'process.stdout.write(JSON.stringify({ own, spawned: JSON.parse(spawned.stdout), explicitEnv: JSON.parse(explicitEnv) }))'
    ],
    { ...process.env, NODE_OPTIONS: '--no-warnings' }
  )

  assert.deepEqual(output, {
    own: { nodeOptions: '--no-warnings', runAsNode: null },
    spawned: { nodeOptions: '--no-warnings', runAsNode: null, patched: false },
    explicitEnv: { nodeOptions: '--no-warnings', runAsNode: null, patched: false }
  })
})

test('the preload drops NODE_OPTIONS entirely when it was the only option', () => {
  const output = runAdapter(
    'toucan-agent-empty-options-',
    ["process.stdout.write(JSON.stringify('NODE_OPTIONS' in process.env))"],
    withoutNodeOptions()
  )
  assert.equal(output, false)
})

test('a provider CLI launched through a shell keeps its hidden window while its environment stays clean', () => {
  // The codex-acp shape on Windows: spawn('"codex.exe" app-server', { shell: true, env }).
  // ChildProcess.prototype.spawn receives the normalised options, so it can witness windowsHide.
  const output = runAdapter(
    'toucan-agent-shell-child-',
    [
      "import { spawn, ChildProcess } from 'node:child_process'",
      'const forwarded = []',
      'const originalSpawn = ChildProcess.prototype.spawn',
      'ChildProcess.prototype.spawn = function (options) { forwarded.push(options.windowsHide); return originalSpawn.call(this, options) }',
      "const child = spawn('\"' + foreignRuntime + '\" \"' + probePath + '\"', { shell: true, env: process.env })",
      "let stdout = ''",
      "child.stdout.on('data', (chunk) => { stdout += chunk })",
      "child.on('close', () => process.stdout.write(JSON.stringify({ forwarded, child: JSON.parse(stdout) })))"
    ],
    withoutNodeOptions()
  )

  assert.deepEqual(output, { forwarded: [true], child: { nodeOptions: null, runAsNode: null, patched: false } })
})

test('children on the adapter runtime keep the hidden-window policy and strip it again for their own children', () => {
  const output = runAdapter(
    'toucan-agent-runtime-children-',
    [
      "import { spawnSync, execSync, execFileSync, fork } from 'node:child_process'",
      "const spawned = spawnSync(process.execPath, [probePath], { encoding: 'utf8' })",
      'if (spawned.error) throw spawned.error',
      "const executed = execFileSync(process.execPath, [probePath], { encoding: 'utf8' })",
      // The codex-acp fallback: an explicit env that carries neither variable.
      "const explicitEnv = execFileSync(process.execPath, [probePath], { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } })",
      "const shell = execSync('\"' + process.execPath + '\" \"' + probePath + '\"', { encoding: 'utf8' })",
      "const forked = fork(probePath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })",
      "let forkedOutput = ''",
      "forked.stdout.on('data', (chunk) => { forkedOutput += chunk })",
      "forked.on('close', () => process.stdout.write(JSON.stringify({ spawned: JSON.parse(spawned.stdout), executed: JSON.parse(executed), explicitEnv: JSON.parse(explicitEnv), shell: JSON.parse(shell), forked: JSON.parse(forkedOutput) })))"
    ],
    withoutNodeOptions()
  )

  const expected = { nodeOptions: null, runAsNode: null, patched: true }
  assert.deepEqual(output, {
    spawned: expected,
    executed: expected,
    explicitEnv: expected,
    shell: expected,
    forked: expected
  })
})
