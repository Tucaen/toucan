import type { AgentProvider } from '../shared/agent'
import { isAdapterVersion } from '../shared/adapter-management'
import type { AdapterManager } from './adapter-manager'
import type { IpcRegistrar } from './ipc-registrar'

function providerOf(value: unknown): AgentProvider {
  if (value !== 'claude' && value !== 'codex') throw new Error('Unknown adapter provider.')
  return value
}

export function registerAdapterManagementIpc(ipc: IpcRegistrar, manager: AdapterManager): void {
  ipc.handle('adapters:state', () => manager.snapshot())
  ipc.handle('adapters:check', (_event, provider) => manager.check(providerOf(provider)))
  ipc.handle('adapters:select', (_event, provider, version) => {
    if (version !== null && !isAdapterVersion(version)) throw new Error('Choose an exact published adapter version.')
    return manager.select(providerOf(provider), version)
  })
}
