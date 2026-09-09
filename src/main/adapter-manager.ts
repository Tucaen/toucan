import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { AgentProvider } from '../shared/agent'
import {
  ADAPTER_PACKAGES,
  isAdapterVersion,
  type AdapterCatalog,
  type AdapterSnapshot
} from '../shared/adapter-management'
import { writeNewFileDurably } from './durable-file'
import { createDurableJsonStore } from './durable-json-store'

export interface AdapterInstaller {
  catalog(provider: AgentProvider): Promise<AdapterCatalog>
  install(provider: AgentProvider, version: string, directory: string): Promise<void>
  validate(entry: string): Promise<void>
}

export interface AdapterManagerOptions {
  appPath: string
  directory: string
  installer: AdapterInstaller
}

function readAdapter(root: string, provider: AgentProvider): { version: string; entry: string } {
  const directory = join(root, 'node_modules', ADAPTER_PACKAGES[provider])
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    version?: unknown
    bin?: string | Record<string, unknown>
  } | null
  const bin =
    typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.[ADAPTER_PACKAGES[provider].split('/')[1]]
  if (typeof manifest?.version !== 'string' || typeof bin !== 'string') throw new Error('Invalid adapter package.')
  const entry = resolve(directory, bin)
  const path = relative(directory, entry)
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('Adapter entry must be inside its package.')
  return { version: manifest.version, entry }
}

export interface AdapterManager {
  snapshot(): AdapterSnapshot
  resolve(provider: AgentProvider): string
  check(provider: AgentProvider): Promise<AdapterSnapshot>
  select(provider: AgentProvider, version: string | null): Promise<AdapterSnapshot>
  onChange(listener: (snapshot: AdapterSnapshot) => void): () => void
}

export async function createAdapterManager(options: AdapterManagerOptions): Promise<AdapterManager> {
  const bundled = {
    claude: readAdapter(options.appPath, 'claude'),
    codex: readAdapter(options.appPath, 'codex')
  }
  const state: AdapterSnapshot = {
    claude: { bundledVersion: bundled.claude.version, selectedVersion: null, installedVersions: [], phase: 'idle' },
    codex: { bundledVersion: bundled.codex.version, selectedVersion: null, installedVersions: [], phase: 'idle' }
  }
  const providers = Object.keys(ADAPTER_PACKAGES) as AgentProvider[]
  const listeners = new Set<(snapshot: AdapterSnapshot) => void>()
  const snapshot = (): AdapterSnapshot => structuredClone(state)
  const emit = (): void => {
    for (const listener of listeners) listener(snapshot())
  }
  const installation = (provider: AgentProvider, version: string): string => join(options.directory, provider, version)
  const installedEntry = (provider: AgentProvider, version: string): string => {
    const root = installation(provider, version)
    const receipt = JSON.parse(readFileSync(join(root, 'toucan-adapter.json'), 'utf8')) as { version?: unknown } | null
    const adapter = readAdapter(root, provider)
    if (
      receipt?.version !== version ||
      adapter.version !== version ||
      !existsSync(adapter.entry) ||
      !existsSync(join(root, 'package-lock.json'))
    )
      throw new Error(`Adapter ${version} is incomplete. Install it again or use the bundled version.`)
    return adapter.entry
  }
  const selectionPath = join(options.directory, 'selection.json')
  // Null is the fallback so a damaged file stays distinguishable from a missing one below.
  const selectionStore = createDurableJsonStore<Record<string, unknown> | null>({
    path: selectionPath,
    parse: (value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null,
    fallback: () => null
  })
  await mkdir(options.directory, { recursive: true })
  for (const provider of providers) {
    await mkdir(join(options.directory, provider), { recursive: true })
    for (const name of await readdir(join(options.directory, provider))) {
      if (!isAdapterVersion(name)) continue
      try {
        installedEntry(provider, name)
        state[provider].installedVersions.push(name)
      } catch {
        /* Partial installs are not selectable. */
      }
    }
  }
  if (existsSync(selectionPath)) {
    const saved = await selectionStore.load()
    if (saved === null) {
      for (const provider of providers)
        state[provider].error = 'Could not read adapter settings. Using bundled adapters.'
    } else {
      for (const provider of providers) {
        const version: unknown = saved[provider]
        if (version === null || version === undefined) continue
        try {
          if (!isAdapterVersion(version)) throw new Error('Invalid stored adapter version.')
          installedEntry(provider, version)
          state[provider].selectedVersion = version
        } catch {
          state[provider].error =
            'The saved adapter is unavailable. Using the bundled version; select a version to repair it.'
        }
      }
    }
  }

  // Installs may overlap between providers; the store's queue keeps selection writes from losing
  // each other's changes, and the mutate callback reads the other provider's selection only once
  // every earlier write has landed in `state`.
  const persist = (provider: AgentProvider, version: string | null): Promise<void> =>
    selectionStore
      .update(() => ({
        value: { claude: state.claude.selectedVersion, codex: state.codex.selectedVersion, [provider]: version },
        result: undefined
      }))
      .then(() => {
        state[provider].selectedVersion = version
      })
  const operate = async (
    provider: AgentProvider,
    phase: 'checking' | 'installing',
    action: () => Promise<void>
  ): Promise<AdapterSnapshot> => {
    if (state[provider].phase !== 'idle') return snapshot()
    state[provider].phase = phase
    delete state[provider].error
    emit()
    try {
      await action()
    } catch (error) {
      state[provider].error = error instanceof Error ? error.message : String(error)
    } finally {
      state[provider].phase = 'idle'
      emit()
    }
    return snapshot()
  }
  return {
    snapshot,
    resolve(provider): string {
      const version = state[provider].selectedVersion
      return version === null ? bundled[provider].entry : installedEntry(provider, version)
    },
    check: (provider) =>
      operate(provider, 'checking', async () => {
        state[provider].catalog = await options.installer.catalog(provider)
      }),
    select: (provider, version) =>
      operate(provider, 'installing', async () => {
        if (version === null) {
          await persist(provider, null)
          return
        }
        if (!isAdapterVersion(version)) throw new Error('Choose an exact published adapter version.')
        if (state[provider].installedVersions.includes(version)) {
          state[provider].phase = 'validating'
          emit()
          await options.installer.validate(installedEntry(provider, version))
        } else {
          const catalog = await options.installer.catalog(provider)
          state[provider].catalog = catalog
          if (!catalog.versions.includes(version)) throw new Error('This adapter version is not published on npm.')
          const stage = join(options.directory, provider, `.install-${randomUUID()}`)
          await mkdir(stage)
          try {
            await options.installer.install(provider, version, stage)
            const adapter = readAdapter(stage, provider)
            if (adapter.version !== version || !existsSync(join(stage, 'package-lock.json')))
              throw new Error('The downloaded adapter does not match the requested version.')
            state[provider].phase = 'validating'
            emit()
            await options.installer.validate(adapter.entry)
            await writeNewFileDurably(join(stage, 'toucan-adapter.json'), JSON.stringify({ version }))
            const destination = installation(provider, version)
            // Only a failed/incomplete install can occupy a version absent from installedVersions.
            await rm(destination, { recursive: true, force: true })
            await rename(stage, destination)
            state[provider].installedVersions.push(version)
          } finally {
            await rm(stage, { recursive: true, force: true })
          }
        }
        await persist(provider, version)
      }),
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
