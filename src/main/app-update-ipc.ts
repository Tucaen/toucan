import type { WebContents } from 'electron'
import type { AppUpdateSnapshot } from '../shared/app-update'
import type { AppUpdater } from './app-update'
import type { IpcRegistrar } from './ipc-registrar'

/**
 * The update seam, seen from the renderer: ask for the snapshot, ask for a check, ask to restart.
 * The host stays the authority on all three - the renderer cannot make a package exist, and it
 * cannot restart into one that does not.
 */
export function registerAppUpdateIpc(ipc: IpcRegistrar, updater: AppUpdater): void {
  ipc.handle('app-update:state', () => updater.snapshot())
  ipc.handle('app-update:check', () => updater.check())
  ipc.handle('app-update:restart', () => updater.quitAndInstall())
}

/**
 * A download finishes long after the window last asked, so the window subscribes for as long as it
 * exists rather than polling a feed on a timer.
 */
export function forwardAppUpdateChanges(updater: AppUpdater, contents: WebContents): () => void {
  return updater.onChange((snapshot: AppUpdateSnapshot) => {
    if (!contents.isDestroyed()) contents.send('app-update:changed', snapshot)
  })
}
