import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import { ADAPTER_PACKAGES, isAdapterVersion } from '../shared/adapter-management'
import { withStallGuard } from '../shared/stall-guard'
import type { AdapterInstaller } from './adapter-manager'
import { buildAgentProcessLaunch, resolveUnpackedExecutable, spawnAgentProcess } from './agent-process'
import { hiddenProcessOptions } from './background-process'

interface AdapterInstallerOptions {
  directory: string
  /** The probe has a deadline; an actual conversation never does. */
  validationTimeoutMs?: number
}

/** A pinned npm CLI ships with Toucan. Neither the user's npm nor the project's .npmrc participates. */
export function createAdapterInstaller(options: AdapterInstallerOptions): AdapterInstaller {
  const npmEntry = (): string =>
    resolveUnpackedExecutable(join(dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js'), existsSync)
  const runNpm = async (args: string[], cwd: string): Promise<string> => {
    await mkdir(options.directory, { recursive: true })
    const userConfig = join(options.directory, 'user.npmrc')
    const globalConfig = join(options.directory, 'global.npmrc')
    await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')])
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)))
    const launch = buildAgentProcessLaunch(process.execPath, npmEntry(), cwd, environment, [
      ...args,
      '--registry=https://registry.npmjs.org/',
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
      `--cache=${join(options.directory, 'cache')}`,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--fetch-retries=1',
      '--fetch-timeout=30000'
    ])
    return new Promise((resolve, reject) => {
      execFile(
        launch.executable,
        launch.args,
        hiddenProcessOptions({
          ...launch.options,
          encoding: 'utf8',
          timeout: 5 * 60_000,
          maxBuffer: 8 * 1024 * 1024
        }),
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(`Adapter package operation failed: ${stderr.trim().slice(-2000) || error.message}`))
          else resolve(stdout)
        }
      )
    })
  }
  return {
    async catalog(provider) {
      await mkdir(options.directory, { recursive: true })
      const result = JSON.parse(
        await runNpm(['view', ADAPTER_PACKAGES[provider], 'versions', 'dist-tags', '--json'], options.directory)
      ) as { versions?: unknown; 'dist-tags'?: { latest?: unknown } } | null
      const published: unknown[] = Array.isArray(result?.versions) ? result.versions : [result?.versions]
      const versions = published.filter(isAdapterVersion).reverse()
      if (versions.length === 0) throw new Error('The registry returned no adapter versions.')
      const latest = result?.['dist-tags']?.latest
      return { versions, ...(isAdapterVersion(latest) ? { latest } : {}) }
    },
    async install(provider, version, directory) {
      if (!isAdapterVersion(version)) throw new Error('Choose an exact published adapter version.')
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'toucan-managed-adapter',
          private: true,
          version: '1.0.0',
          dependencies: { [ADAPTER_PACKAGES[provider]]: version }
        })
      )
      await runNpm(['install', '--include=optional', '--omit=dev', '--engine-strict', '--package-lock=true'], directory)
    },
    async validate(entry) {
      const child = spawnAgentProcess(buildAgentProcessLaunch(process.execPath, entry, dirname(entry), process.env))
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      // Drain stderr without retaining provider/account data. The probe sends initialize only.
      child.stderr.resume()
      const app = client({ name: 'Toucan adapter check' })
      const connection = app.connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        )
      )
      const failed = new Promise<never>((_resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`Adapter exited during validation (${code ?? 'unknown'}).`)))
        child.stdin.on('error', reject)
      })
      try {
        const initialized = await withStallGuard(
          Promise.race([
            connection.agent.request(methods.agent.initialize, {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: 'toucan-adapter-check', version: '1' }
            }),
            failed
          ]),
          options.validationTimeoutMs ?? 30_000,
          'Adapter did not complete the ACP handshake. The selected version was not changed.'
        )
        if (initialized.protocolVersion !== 1) throw new Error('This adapter uses an unsupported ACP protocol version.')
      } finally {
        child.stdin.end()
        child.kill('SIGKILL')
        connection.close()
        // Windows cannot promote/remove the installation while its probe still has files open.
        await withStallGuard(closed, 5000, 'The adapter validation process did not exit.')
      }
    }
  }
}
