import { COMMAND_GUARD_SETTINGS_CHANNELS } from '../shared/ipc-channels'
import type { IpcRegistrar } from './ipc-registrar'
import { isRecord } from './ipc-validation'
import type { CommandGuardSettingsStore } from './command-guard-settings-store'

/**
 * The command guard dialog's side of main (ticket 03): the preferences with the built-in list, and a
 * save that reports an invalid regex by line instead of storing it. Validation is the store's.
 */
export function registerCommandGuardSettingsIpc(
  ipc: IpcRegistrar,
  store: Pick<CommandGuardSettingsStore, 'state' | 'save'>
): void {
  ipc.handle(COMMAND_GUARD_SETTINGS_CHANNELS.state, () => store.state())
  ipc.handle(COMMAND_GUARD_SETTINGS_CHANNELS.save, (_event, request) => {
    if (!isRecord(request)) throw new Error('The save request must be an object.')
    const { enabled, patterns } = request
    if (typeof enabled !== 'boolean') throw new Error('The command guard switch must be true or false.')
    if (typeof patterns !== 'string') throw new Error('The command guard patterns must be text.')
    return store.save({ enabled, patterns })
  })
}
