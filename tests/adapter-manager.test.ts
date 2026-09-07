import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAdapterManager, type AdapterInstaller } from '../src/main/adapter-manager'

test('a fresh installation resolves bundled adapters without contacting the registry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toucan-adapters-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, version] of [
    ['codex-acp', '1.8.0'],
    ['claude-agent-acp', '0.73.0']
  ]) {
    const directory = join(root, 'app', 'node_modules', '@agentclientprotocol', name)
    await mkdir(join(directory, 'dist'), { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version, bin: { [name]: 'dist/index.js' } }))
    await writeFile(join(directory, 'dist/index.js'), '')
  }
  const manager = await createAdapterManager({
    appPath: join(root, 'app'),
    directory: join(root, 'managed'),
    installer: {
      catalog: async () => {
        throw new Error('unexpected registry access')
      },
      install: async () => {
        throw new Error('unexpected installation')
      },
      validate: async () => {
        throw new Error('unexpected validation')
      }
    }
  })
  assert.equal(manager.snapshot().codex.bundledVersion, '1.8.0')
  assert.equal(manager.snapshot().claude.selectedVersion, null)
  assert.equal(manager.resolve('codex'), join(root, 'app/node_modules/@agentclientprotocol/codex-acp/dist/index.js'))
})

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'toucan-adapters-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install: AdapterInstaller['install'] = async (provider, version, directory) => {
    const name = provider === 'codex' ? 'codex-acp' : 'claude-agent-acp'
    const pkg = join(directory, 'node_modules', '@agentclientprotocol', name)
    await mkdir(join(pkg, 'dist'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ version, bin: { [name]: 'dist/index.js' } }))
    await writeFile(join(pkg, 'dist/index.js'), '')
    await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3}')
  }
  const options = {
    appPath: join(root, 'app'),
    directory: join(root, 'managed'),
    installer: {
      install,
      catalog: async () => ({ versions: ['1.9.0', '1.8.0'], latest: '1.9.0' }),
      validate: async () => {}
    }
  }
  await install('codex', '1.8.0', options.appPath)
  await install('claude', '0.73.0', options.appPath)
  return options
}

test('a selected installation survives app upgrades and can roll back offline to the bundle', async (t) => {
  const options = await fixture(t)
  const manager = await createAdapterManager(options)
  await manager.select('codex', '1.9.0')
  assert.equal(manager.snapshot().codex.selectedVersion, '1.9.0')
  assert.notEqual(
    manager.resolve('codex'),
    join(options.appPath, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')
  )
  await options.installer.install('codex', '2.0.0', options.appPath)
  options.installer.catalog = async () => {
    throw new Error('offline')
  }
  options.installer.install = async () => {
    throw new Error('must reuse the preserved installation')
  }
  const restarted = await createAdapterManager(options)
  assert.equal(restarted.snapshot().codex.bundledVersion, '2.0.0')
  assert.equal(restarted.snapshot().codex.selectedVersion, '1.9.0')
  await restarted.select('codex', null)
  assert.equal(restarted.snapshot().codex.selectedVersion, null)
  await restarted.select('codex', '1.9.0')
  assert.equal(restarted.snapshot().codex.selectedVersion, '1.9.0')
})

test('failed installation or handshake preserves the selected adapter and supports retry', async (t) => {
  const options = await fixture(t)
  const manager = await createAdapterManager(options)
  await manager.select('codex', '1.8.0')
  const previous = manager.resolve('codex')
  options.installer.validate = async () => {
    throw new Error('unsupported handshake')
  }
  const failed = await manager.select('codex', '1.9.0')
  assert.equal(failed.codex.selectedVersion, '1.8.0')
  assert.match(failed.codex.error ?? '', /unsupported handshake/)
  assert.equal(manager.resolve('codex'), previous)
  assert.deepEqual(failed.codex.installedVersions, ['1.8.0'])
  options.installer.validate = async () => {}
  await manager.select('codex', '1.9.0')
  assert.equal(manager.snapshot().codex.selectedVersion, '1.9.0')
})

test('concurrent provider selections persist together and an in-progress install keeps the previous launch', async (t) => {
  const options = await fixture(t)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  options.installer.validate = () => pending
  const manager = await createAdapterManager(options)
  const original = manager.resolve('codex')
  const codex = manager.select('codex', '1.9.0')
  const claude = manager.select('claude', '1.9.0')
  assert.equal(manager.resolve('codex'), original)
  assert.equal(manager.snapshot().codex.phase, 'installing')
  release()
  await Promise.all([codex, claude])
  const restarted = await createAdapterManager(options)
  assert.equal(restarted.snapshot().codex.selectedVersion, '1.9.0')
  assert.equal(restarted.snapshot().claude.selectedVersion, '1.9.0')
})

test('versions cannot be package specs, paths or commands', async (t) => {
  const manager = await createAdapterManager(await fixture(t))
  for (const version of [
    'latest',
    '^1.8.0',
    '../../outside',
    '1.8.0;echo surprise',
    'https://example.com/adapter.tgz'
  ]) {
    const result = await manager.select('codex', version)
    assert.match(result.codex.error ?? '', /exact published/)
    assert.equal(result.codex.selectedVersion, null)
  }
})

test('a missing selected installation restores the bundle with a visible explanation', async (t) => {
  const options = await fixture(t)
  const manager = await createAdapterManager(options)
  await manager.select('codex', '1.9.0')
  await rm(join(options.directory, 'codex', '1.9.0'), { recursive: true })
  const restarted = await createAdapterManager(options)
  assert.equal(restarted.snapshot().codex.selectedVersion, null)
  assert.match(restarted.snapshot().codex.error ?? '', /saved adapter is unavailable/)
})
