import type { FileReadResult } from '../shared/file-view'
import type { FileView, FileViewOwner } from './file-view'

interface FileViewIpcRegistrar {
  handle(channel: string, listener: (event: { sender: FileViewOwner }, ...args: unknown[]) => unknown): void
}

const NO_PATH: FileReadResult = { ok: false, reason: 'unreadable', message: 'A file path is required.' }

/**
 * The renderer's only route to a file's contents. Every argument is checked for shape here so the
 * view behind it only ever sees a path string; whether that path may be read is the view's own
 * decision. Electron-free, like `ticket-ipc.ts`, so the wiring is testable without a window.
 */
export function registerFileViewIpc(ipc: FileViewIpcRegistrar, view: FileView): void {
  ipc.handle('file-view:read', (_event, path: unknown) =>
    typeof path === 'string' && path ? view.read(path) : NO_PATH
  )
  ipc.handle('file-view:watch', (event, path: unknown) => {
    if (typeof path === 'string' && path) return view.watch(path, event.sender)
    return undefined
  })
  ipc.handle('file-view:unwatch', (event, path: unknown) => {
    if (typeof path === 'string' && path) return view.unwatch(path, event.sender)
    return undefined
  })
}
