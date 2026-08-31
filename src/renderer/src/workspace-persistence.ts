import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceState } from '../../shared/terminal'

export type WorkspaceSaveStatus = 'saving' | 'saved' | 'error'

interface WorkspacePersistenceOptions {
  snapshot: WorkspaceState
  restore(saved: WorkspaceState): void
  seedFresh(): Promise<void>
  saveDelayMs?: number
}

interface WorkspacePersistence {
  ready: boolean
  recovered: boolean
  unrecoverable: boolean
  saveStatus: WorkspaceSaveStatus
  acknowledgeUnrecoverable(): Promise<void>
}

/**
 * Coordinates the load-before-save lifecycle and keeps damaged snapshots protected until the user
 * explicitly chooses to replace them.
 */
export function useWorkspacePersistence({
  snapshot,
  restore,
  seedFresh,
  saveDelayMs = 180
}: WorkspacePersistenceOptions): WorkspacePersistence {
  const [ready, setReady] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [unrecoverable, setUnrecoverable] = useState(false)
  const [saveStatus, setSaveStatus] = useState<WorkspaceSaveStatus>('saving')
  const restoreRef = useRef(restore)
  const seedFreshRef = useRef(seedFresh)
  restoreRef.current = restore
  seedFreshRef.current = seedFresh

  useEffect(() => {
    let active = true
    void (async () => {
      const loaded = await window.terminalApi.loadWorkspace()
      if (!active) return
      setRecovered(loaded.recovered)
      if (loaded.state && loaded.state.projects.length > 0) {
        restoreRef.current(loaded.state)
      } else if (loaded.unrecoverable) {
        setUnrecoverable(true)
        return
      } else {
        await seedFreshRef.current()
        if (!active) return
      }
      setReady(true)
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    setSaveStatus('saving')
    const timeout = setTimeout(() => {
      void window.terminalApi.saveWorkspace(snapshot).then((result) => {
        setSaveStatus(result.ok ? 'saved' : 'error')
      })
    }, saveDelayMs)
    return () => clearTimeout(timeout)
  }, [ready, saveDelayMs, snapshot])

  const acknowledgeUnrecoverable = useCallback(async (): Promise<void> => {
    await seedFresh()
    setUnrecoverable(false)
    setReady(true)
  }, [seedFresh])

  return { ready, recovered, unrecoverable, saveStatus, acknowledgeUnrecoverable }
}
