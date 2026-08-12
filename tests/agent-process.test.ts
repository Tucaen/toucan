import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { buildAgentProcessLaunch, forceHiddenWindows } from '../src/main/agent-process'

test('agent adapters force their nested Windows processes to stay hidden', () => {
  const launch = buildAgentProcessLaunch(
    'C:\\Program Files\\ADE\\ADE.exe',
    'C:\\Program Files\\ADE\\resources\\claude-agent-acp\\index.js',
    'D:\\Development\\ADE',
    { PATH: 'C:\\Windows\\System32' }
  )

  assert.equal(launch.options.windowsHide, true)
  assert.deepEqual(launch.args, ['C:\\Program Files\\ADE\\resources\\claude-agent-acp\\index.js'])
  assert.match(launch.options.env?.NODE_OPTIONS ?? '', /--import=data:text\/javascript/)
  assert.match(launch.options.env?.NODE_OPTIONS ?? '', /windowsHide%3A%20true/)
  assert.deepEqual(forceHiddenWindows({ windowsHide: false, cwd: 'D:\\Development\\ADE' }), {
    windowsHide: true,
    cwd: 'D:\\Development\\ADE'
  })
})

test('the hidden-window preload still imports and runs the ACP adapter entrypoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-agent-bootstrap-'))
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

test('the hidden-window preload propagates through an intermediate Node process', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-agent-propagation-'))
  const childPath = join(directory, 'child.mjs')
  const adapterPath = join(directory, 'adapter.mjs')
  writeFileSync(
    childPath,
    "import { spawn } from 'node:child_process'\nprocess.stdout.write(String(spawn.__adeForceHiddenWindows === true))\n",
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
