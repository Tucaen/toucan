import type { BrainDumpLibraryApi, BrainDumpOutcome } from '../shared/brain-dump'
import type { BrainDumpCaptureManager, BrainDumpCaptureOwner } from './brain-dump-capture'
import type { BrainDumpChangeOwner, BrainDumpChangeWatcher } from './brain-dump-watcher'
import type { IpcRegistrar } from './ipc-registrar'
import { BRAIN_DUMP_CHANNELS } from '../shared/ipc-channels'
import { isAgentProvider, type AgentProvider } from '../shared/agent-provider'

function captureRequest(value: unknown): value is { content: string; provider: AgentProvider; projectPath?: string } {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return (
    typeof request.content === 'string' &&
    isAgentProvider(request.provider) &&
    (request.projectPath === undefined || typeof request.projectPath === 'string')
  )
}

export function registerBrainDumpIpc(
  // This surface pushes two different payloads at the same renderer: capture state and the
  // collection a watcher saw change. Both, so neither call site needs a cast.
  ipc: IpcRegistrar<BrainDumpCaptureOwner & BrainDumpChangeOwner>,
  library: BrainDumpLibraryApi,
  capture: BrainDumpCaptureManager,
  changes: BrainDumpChangeWatcher
): void {
  ipc.handle(BRAIN_DUMP_CHANNELS.list, (event, collection: unknown) => {
    changes.subscribe(event.sender)
    return collection === 'active' || collection === 'archived'
      ? library.list(collection)
      : { topics: [], diagnostics: [{ path: '', code: 'invalid-collection', message: 'Collection is invalid.' }] }
  })
  ipc.handle(BRAIN_DUMP_CHANNELS.resolve, (_event, slug: unknown) =>
    typeof slug === 'string' ? library.resolve(slug) : { status: 'invalid', slug: '' }
  )
  ipc.handle(BRAIN_DUMP_CHANNELS.archive, (_event, slug: unknown, outcome: unknown) =>
    typeof slug === 'string' && typeof outcome === 'string'
      ? library.archive(slug, outcome as BrainDumpOutcome)
      : { ok: false, code: 'invalid-request', message: 'Slug and outcome are required.' }
  )
  ipc.handle(BRAIN_DUMP_CHANNELS.assignProject, (_event, slug: unknown, projectPath: unknown) =>
    typeof slug === 'string' && (projectPath === undefined || projectPath === null || typeof projectPath === 'string')
      ? library.assignProject(slug, typeof projectPath === 'string' ? projectPath : undefined)
      : { ok: false, code: 'invalid-request', message: 'Slug is required and the project must be a path.' }
  )
  ipc.handle(BRAIN_DUMP_CHANNELS.captureStart, (event, request: unknown) =>
    captureRequest(request)
      ? capture.start(request, event.sender)
      : { ok: false, code: 'invalid-content', message: 'Capture request is invalid.' }
  )
  ipc.handle(BRAIN_DUMP_CHANNELS.captureCurrent, () => capture.current())
  ipc.handle(BRAIN_DUMP_CHANNELS.captureApproval, (_event, jobId: unknown, approvalId: unknown, optionId: unknown) => {
    if (
      typeof jobId === 'string' &&
      typeof approvalId === 'string' &&
      (optionId === undefined || optionId === null || typeof optionId === 'string')
    )
      capture.resolveApproval(jobId, approvalId, typeof optionId === 'string' ? optionId : undefined)
  })
  ipc.handle(BRAIN_DUMP_CHANNELS.captureCancel, (_event, jobId: unknown) => {
    if (typeof jobId === 'string') capture.cancel(jobId)
  })
}
