import type { BrainDumpCaptureState } from '../shared/brain-dump'
import { createDurableJsonStore } from './durable-json-store'

function isState(value: unknown): value is BrainDumpCaptureState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<BrainDumpCaptureState>
  return typeof state.jobId === 'string' && ['working', 'completed', 'failed'].includes(state.status ?? '')
}

export function createBrainDumpCaptureStore(path: string) {
  const store = createDurableJsonStore<BrainDumpCaptureState | null>({
    path,
    parse: (value) => (isState(value) ? value : null),
    fallback: () => null
  })
  return {
    load: (): Promise<BrainDumpCaptureState | null> => store.load(),
    save: (state: BrainDumpCaptureState): Promise<void> => store.save(state)
  }
}
