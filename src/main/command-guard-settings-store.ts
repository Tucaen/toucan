import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_COMMAND_GUARD_PREFERENCES,
  parseCommandGuardPreferences,
  preferencesFromSave,
  validateCommandGuardPatterns,
  type CommandGuardPreferences,
  type CommandGuardSaveRequest,
  type CommandGuardSaveResult,
  type CommandGuardSettingsState
} from '../shared/command-guard-settings'
import { errorMessage } from '../shared/text'
import type { CommandGuardFiles } from './command-guard'
import { writeSnapshotAtomically } from './durable-file'
import { createDurableJsonStore } from './durable-json-store'
import { createSerialQueue } from './serial-queue'

/**
 * The user's command guard preferences (ticket 03), in `<userData>\command-guard-settings.json`:
 * a file of their own because the patterns belong to the user, not to one canvas.
 *
 * `launch` is the provider-neutral point every adapter asks when it opens a session: the files the
 * hook should run, or null when the guard is off and no hook is registered at all. The pattern
 * list a hook reads is a file the guard script can open, so an edited list is materialized under
 * `<userData>\command-guard\` at launch; the built-in list is read in place and keeps following app
 * updates.
 */
export interface CommandGuardSettingsStore {
  state(): Promise<CommandGuardSettingsState>
  save(request: CommandGuardSaveRequest): Promise<CommandGuardSaveResult>
  launch(): Promise<CommandGuardFiles | null>
}

export interface CommandGuardSettingsStoreOptions {
  userDataPath: string
  /** The shipped script and default list. */
  bundled: CommandGuardFiles
  log?: (message: string) => void
}

export function createCommandGuardSettingsStore(options: CommandGuardSettingsStoreOptions): CommandGuardSettingsStore {
  const store = createDurableJsonStore<CommandGuardPreferences>({
    path: join(options.userDataPath, 'command-guard-settings.json'),
    parse: parseCommandGuardPreferences,
    fallback: () => DEFAULT_COMMAND_GUARD_PREFERENCES,
    ...(options.log ? { log: options.log } : {})
  })
  const customPatternsPath = join(options.userDataPath, 'command-guard', 'patterns.txt')
  const enqueue = createSerialQueue()
  const defaults = (): Promise<string> => readFile(options.bundled.patterns, 'utf8')

  return {
    async state() {
      const [preferences, builtIn] = await Promise.all([store.load(), defaults()])
      return { preferences, defaults: builtIn }
    },
    async save(request) {
      const errors = validateCommandGuardPatterns(request.patterns)
      if (errors.length > 0) return { ok: false, errors }
      const builtIn = await defaults()
      const preferences = preferencesFromSave(request, builtIn)
      await store.save(preferences)
      return { ok: true, state: { preferences, defaults: builtIn } }
    },
    async launch() {
      // A file that cannot be read says nothing about what the user wants, and a guard that fails
      // open is worse than one running on the defaults.
      const preferences = await store.load().catch((error: unknown) => {
        options.log?.(`command guard settings unreadable, using the defaults: ${errorMessage(error)}`)
        return DEFAULT_COMMAND_GUARD_PREFERENCES
      })
      if (!preferences.enabled) return null
      if (preferences.patterns === null) return options.bundled
      const text = preferences.patterns
      try {
        // Serialized and rewritten every launch: two sessions opening together must not tear the
        // file, and a list that was deleted or edited by hand is restored to what was saved.
        await enqueue(async () => {
          if ((await readFile(customPatternsPath, 'utf8').catch(() => null)) === text) return
          await mkdir(dirname(customPatternsPath), { recursive: true })
          await writeSnapshotAtomically(customPatternsPath, text)
        })
        return { script: options.bundled.script, patterns: customPatternsPath }
      } catch (error) {
        options.log?.(`could not write the edited command guard patterns, using the defaults: ${errorMessage(error)}`)
        return options.bundled
      }
    }
  }
}
