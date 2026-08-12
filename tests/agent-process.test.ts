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
  assert.equal(launch.args[0], '-e')
  assert.match(launch.args[1], /childProcess\.spawn/)
  assert.match(launch.args[1], /windowsHide: true/)
  assert.equal(launch.args[2], 'C:\\Program Files\\ADE\\resources\\claude-agent-acp\\index.js')
  assert.deepEqual(forceHiddenWindows({ windowsHide: false, cwd: 'D:\\Development\\ADE' }), {
    windowsHide: true,
    cwd: 'D:\\Development\\ADE'
  })
})

test('the hidden-window bootstrap still imports and runs the ACP adapter entrypoint', () => {
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
