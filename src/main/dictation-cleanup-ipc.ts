import type { EventEmitter } from 'node:events'
import { isDictationCleanupPreference, type DictationCleanupRequest } from '../shared/dictation-cleanup'
import { DICTATION_CLEANUP_CHANNELS } from '../shared/ipc-channels'
import type { IpcRegistrar } from './ipc-registrar'
import type { createDictationCleaner } from './dictation-cleanup'

/** Cancellation belongs to the invoking window; destroyed windows and app exit release children. */
export function registerDictationCleanupIpc(
  ipc: IpcRegistrar<EventEmitter>,
  cleaner: ReturnType<typeof createDictationCleaner>
): () => void {
  const running = new Map<EventEmitter, Map<string, AbortController>>()
  ipc.handle(DICTATION_CLEANUP_CHANNELS.clean, async ({ sender }, value: unknown) => {
    const request = value as Partial<DictationCleanupRequest> | null
    if (
      !request ||
      typeof request.id !== 'string' ||
      !request.id ||
      request.id.length > 100 ||
      typeof request.text !== 'string' ||
      request.text.length > 50_000 ||
      typeof request.context !== 'string' ||
      request.context.length > 1_000 ||
      !isDictationCleanupPreference(request.preference)
    ) {
      return {
        status: 'fallback',
        text: typeof request?.text === 'string' ? request.text : '',
        message: 'Invalid cleanup request.'
      }
    }
    const jobs = running.get(sender) ?? new Map<string, AbortController>()
    if (jobs.has(request.id)) return { status: 'fallback', text: request.text, message: 'Cleanup is already running.' }
    running.set(sender, jobs)
    const controller = new AbortController()
    jobs.set(request.id, controller)
    const cancel = (): void => controller.abort()
    sender.once('destroyed', cancel)
    try {
      return await cleaner.clean(request.text, request.context, request.preference, controller.signal)
    } finally {
      sender.removeListener('destroyed', cancel)
      jobs.delete(request.id)
      if (jobs.size === 0) running.delete(sender)
    }
  })
  ipc.handle(DICTATION_CLEANUP_CHANNELS.cancel, ({ sender }, id: unknown) => {
    if (typeof id === 'string') running.get(sender)?.get(id)?.abort()
  })
  return () => {
    for (const jobs of running.values()) for (const controller of jobs.values()) controller.abort()
    running.clear()
  }
}
