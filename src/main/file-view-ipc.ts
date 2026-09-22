import type { FileReadResult, FileWriteRequest, FileWriteResult } from '../shared/file-view'
import { isLineEnding } from '../shared/line-endings'
import { FILE_VIEW_CHANNELS } from '../shared/ipc-channels'
import type { IpcRegistrar } from './ipc-registrar'
import type { FileView, FileViewOwner } from './file-view'

const NO_PATH: FileReadResult = { ok: false, reason: 'unreadable', message: 'A file path is required.' }
const BAD_WRITE: FileWriteResult = {
  ok: false,
  reason: 'unwritable',
  message: 'A write needs a file path, the whole content and the modification time it was based on.'
}

function isWriteRequest(value: unknown): value is FileWriteRequest {
  if (typeof value !== 'object' || value === null) return false
  const { path, content, baseMtime, lineEnding } = value as Record<string, unknown>
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    typeof content === 'string' &&
    typeof baseMtime === 'string' &&
    (lineEnding === undefined || isLineEnding(lineEnding))
  )
}

/**
 * The renderer's only route to a file's contents. Every argument is checked for shape here so the
 * view behind it only ever sees a path string; whether that path may be read is the view's own
 * decision. Electron-free, like `ticket-ipc.ts`, so the wiring is testable without a window.
 */
export function registerFileViewIpc(ipc: IpcRegistrar<FileViewOwner>, view: FileView): void {
  ipc.handle(FILE_VIEW_CHANNELS.read, (_event, path: unknown) =>
    typeof path === 'string' && path ? view.read(path) : NO_PATH
  )
  ipc.handle(FILE_VIEW_CHANNELS.write, (_event, request: unknown) =>
    isWriteRequest(request) ? view.write(request) : BAD_WRITE
  )
  ipc.handle(FILE_VIEW_CHANNELS.watch, (event, path: unknown) => {
    if (typeof path === 'string' && path) return view.watch(path, event.sender)
    return undefined
  })
  ipc.handle(FILE_VIEW_CHANNELS.unwatch, (event, path: unknown) => {
    if (typeof path === 'string' && path) return view.unwatch(path, event.sender)
    return undefined
  })
}
