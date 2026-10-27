import { PLUGIN_CHANNELS } from '../shared/ipc-channels'
import type { IpcRegistrar } from './ipc-registrar'
import { isString } from './ipc-validation'
import type { PluginRegistry } from './plugin-registry'

function text(value: unknown, what: string): string {
  if (!isString(value)) throw new Error(`${what} must be text.`)
  return value
}

/**
 * The plugins dialog's side of main (#55): list, add, remove, enable and disable per project, and a
 * plugin's contributions. What a plugin is and who may use it is the registry's; this only narrows
 * what crosses the boundary.
 */
export function registerPluginIpc(ipc: IpcRegistrar, registry: Omit<PluginRegistry, 'forSession'>): void {
  ipc.handle(PLUGIN_CHANNELS.list, (_event, projectPath) =>
    registry.list(projectPath === undefined ? undefined : text(projectPath, 'A project path'))
  )
  ipc.handle(PLUGIN_CHANNELS.add, (_event, path) => registry.add(text(path, 'A plugin folder')))
  ipc.handle(PLUGIN_CHANNELS.remove, (_event, id) => registry.remove(text(id, 'A plugin id')))
  ipc.handle(PLUGIN_CHANNELS.enable, (_event, projectPath, id) =>
    registry.enable(text(projectPath, 'A project path'), text(id, 'A plugin id'))
  )
  ipc.handle(PLUGIN_CHANNELS.disable, (_event, projectPath, id) =>
    registry.disable(text(projectPath, 'A project path'), text(id, 'A plugin id'))
  )
  ipc.handle(PLUGIN_CHANNELS.contributions, (_event, id) => registry.contributions(text(id, 'A plugin id')))
}
