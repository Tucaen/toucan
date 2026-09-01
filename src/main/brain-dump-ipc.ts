import type { BrainDumpCollection, BrainDumpLibraryApi, BrainDumpOutcome } from '../shared/brain-dump'
import type { BrainDumpCaptureManager, BrainDumpCaptureOwner } from './brain-dump-capture'
import type { BrainDumpChangeWatcher } from './brain-dump-watcher'

interface BrainDumpIpcRegistrar {
  handle(channel: string, listener: (event: { sender: BrainDumpCaptureOwner }, ...args: unknown[]) => unknown): void
}

function captureRequest(
  value: unknown
): value is { content: string; provider: 'claude' | 'codex'; projectPath?: string } {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return (
    typeof request.content === 'string' &&
    (request.provider === 'claude' || request.provider === 'codex') &&
    (request.projectPath === undefined || typeof request.projectPath === 'string')
  )
}

export function registerBrainDumpIpc(
  ipc: BrainDumpIpcRegistrar,
  library: BrainDumpLibraryApi,
  capture: BrainDumpCaptureManager,
  changes: BrainDumpChangeWatcher
): void {
  ipc.handle('brain-dump:list', (event, collection: unknown) => {
    changes.subscribe(event.sender)
    return collection === 'active' || collection === 'archived'
      ? library.list(collection as BrainDumpCollection)
      : { topics: [], diagnostics: [{ path: '', code: 'invalid-collection', message: 'Collection is invalid.' }] }
  })
  ipc.handle('brain-dump:resolve', (_event, slug: unknown) =>
    typeof slug === 'string' ? library.resolve(slug) : { status: 'invalid', slug: '' }
  )
  ipc.handle('brain-dump:archive', (_event, slug: unknown, outcome: unknown) =>
    typeof slug === 'string' && typeof outcome === 'string'
      ? library.archive(slug, outcome as BrainDumpOutcome)
      : { ok: false, code: 'invalid-request', message: 'Slug and outcome are required.' }
  )
  ipc.handle('brain-dump:reopen', (_event, slug: unknown) =>
    typeof slug === 'string'
      ? library.reopen(slug)
      : { ok: false, code: 'invalid-request', message: 'Slug is required.' }
  )
  ipc.handle('brain-dump:capture-start', (event, request: unknown) =>
    captureRequest(request)
      ? capture.start(request, event.sender)
      : { ok: false, code: 'invalid-content', message: 'Capture request is invalid.' }
  )
  ipc.handle('brain-dump:capture-current', () => capture.current())
  ipc.handle('brain-dump:capture-cancel', (_event, jobId: unknown) => {
    if (typeof jobId === 'string') capture.cancel(jobId)
  })
}
