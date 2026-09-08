import type { AgentProvider } from '../shared/agent'
import { isAdapterVersion } from '../shared/adapter-management'
import type { AdapterManager } from './adapter-manager'
import type { IpcRegistrar } from './ipc-registrar'
import { ADAPTER_CHANNELS } from '../shared/ipc-channels'

function providerOf(value: unknown): AgentProvider {
  if (value !== 'claude' && value !== 'codex') throw new Error('Unknown adapter provider.')
  return value
}

export function registerAdapterManagementIpc(ipc: IpcRegistrar, manager: AdapterManager): void {
  ipc.handle(ADAPTER_CHANNELS.state, () => manager.snapshot())
  ipc.handle(ADAPTER_CHANNELS.check, (_event, provider) => manager.check(providerOf(provider)))
  ipc.handle(ADAPTER_CHANNELS.select, (_event, provider, version) => {
    if (version !== null && !isAdapterVersion(version)) throw new Error('Choose an exact published adapter version.')
    return manager.select(providerOf(provider), version)
  })
}
