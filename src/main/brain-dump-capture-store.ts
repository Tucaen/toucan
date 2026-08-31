import { readFile } from 'node:fs/promises'
import type { BrainDumpCaptureState } from '../shared/brain-dump'
import { writeSnapshotAtomically } from './workspace-store'

function isState(value: unknown): value is BrainDumpCaptureState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<BrainDumpCaptureState>
  return typeof state.jobId === 'string' && ['working', 'completed', 'failed'].includes(state.status ?? '')
}

export function createBrainDumpCaptureStore(path: string) {
  let saves = Promise.resolve()
  return {
    async load(): Promise<BrainDumpCaptureState | null> {
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'))
        return isState(value) ? value : null
      } catch {
        return null
      }
    },
    save(state: BrainDumpCaptureState): Promise<void> {
      const result = saves.then(() => writeSnapshotAtomically(path, `${JSON.stringify(state)}\n`))
      saves = result.catch(() => {})
      return result
    }
  }
}
