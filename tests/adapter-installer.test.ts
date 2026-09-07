import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAdapterInstaller } from '../src/main/adapter-installer'

test('validation accepts an ACP handshake without opening a conversation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toucan-adapter-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'adapter.cjs')
  await writeFile(
    entry,
    `
    require('node:fs').writeFileSync(${JSON.stringify(join(root, 'probe.pid'))}, String(process.pid))
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line)
      if (request.method !== 'initialize') process.exit(9)
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: 1, agentCapabilities: {}, authMethods: []
      } }) + '\\n')
    })
  `
  )
  await createAdapterInstaller({ directory: root }).validate(entry)
  const pid = Number(await readFile(join(root, 'probe.pid'), 'utf8'))
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    'validation must release its process before the installation can be moved'
  )
})

test('an adapter that never answers cannot hang an update', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toucan-adapter-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'silent.cjs')
  await writeFile(entry, 'setInterval(() => {}, 1000)')
  await assert.rejects(
    createAdapterInstaller({ directory: root, validationTimeoutMs: 200 }).validate(entry),
    /did not complete/
  )
})

test('an incompatible ACP protocol is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toucan-adapter-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'incompatible.cjs')
  await writeFile(
    entry,
    `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(line).id, result: {
        protocolVersion: 99, agentCapabilities: {}
      } }) + '\\n')
    })
  `
  )
  await assert.rejects(createAdapterInstaller({ directory: root }).validate(entry), /unsupported ACP/)
})
