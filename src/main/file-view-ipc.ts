import type { FileReadResult, FileWriteRequest, FileWriteResult } from '../shared/file-view'
import type { FileView, FileViewOwner } from './file-view'

interface FileViewIpcRegistrar {
  handle(channel: string, listener: (event: { sender: FileViewOwner }, ...args: unknown[]) => unknown): void
}

const NO_PATH: FileReadResult = { ok: false, reason: 'unreadable', message: 'A file path is required.' }
const BAD_WRITE: FileWriteResult = {
  ok: false,
  reason: 'unwritable',
  message: 'A write needs a file path, the whole content and the modification time it was based on.'
}

function isWriteRequest(value: unknown): value is FileWriteRequest {
  if (typeof value !== 'object' || value === null) return false
  const { path, content, baseMtime } = value as Record<string, unknown>
  return typeof path === 'string' && path.length > 0 && typeof content === 'string' && typeof baseMtime === 'string'
}

/**
 * The renderer's only route to a file's contents. Every argument is checked for shape here so the
 * view behind it only ever sees a path string; whether that path may be read is the view's own
 * decision. Electron-free, like `ticket-ipc.ts`, so the wiring is testable without a window.
 */
export function registerFileViewIpc(ipc: FileViewIpcRegistrar, view: FileView): void {
  ipc.handle('file-view:read', (_event, path: unknown) =>
    typeof path === 'string' && path ? view.read(path) : NO_PATH
  )
  ipc.handle('file-view:write', (_event, request: unknown) =>
    isWriteRequest(request) ? view.write(request) : BAD_WRITE
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
