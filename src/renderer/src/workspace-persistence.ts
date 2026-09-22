import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceState } from '../../shared/workspace'

export type WorkspaceSaveStatus = 'saving' | 'saved' | 'error'

interface WorkspacePersistenceOptions {
  snapshot: WorkspaceState
  restore(saved: WorkspaceState): void
  saveDelayMs?: number
}

interface WorkspacePersistence {
  ready: boolean
  recovered: boolean
  unrecoverable: boolean
  saveStatus: WorkspaceSaveStatus
  acknowledgeUnrecoverable(): void
}

/**
 * Coordinates the load-before-save lifecycle and keeps damaged snapshots protected until the user
 * explicitly chooses to replace them.
 */
export function useWorkspacePersistence({
  snapshot,
  restore,
  saveDelayMs = 180
}: WorkspacePersistenceOptions): WorkspacePersistence {
  const [ready, setReady] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [unrecoverable, setUnrecoverable] = useState(false)
  const [saveStatus, setSaveStatus] = useState<WorkspaceSaveStatus>('saving')
  const restoreRef = useRef(restore)
  restoreRef.current = restore

  useEffect(() => {
    let active = true
    void (async () => {
      const loaded = await window.workspaceApi.loadWorkspace()
      if (!active) return
      setRecovered(loaded.recovered)
      if (loaded.state && loaded.state.projects.length > 0) {
        restoreRef.current(loaded.state)
      } else if (loaded.unrecoverable) {
        setUnrecoverable(true)
        return
      }
      // Nothing saved yet is a first launch, and a first launch opens on an empty sidebar: the
      // app has no business guessing which folder the user wants, and the directory it happened
      // to be started from - its own install folder, for a shortcut - is never that folder.
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
      void window.workspaceApi
        .saveWorkspace(snapshot)
        .then((result) => {
          setSaveStatus(result.ok ? 'saved' : 'error')
        })
        // A rejected save is the same news as a refused one: without this the status sat on
        // 'saving' for the rest of the session and the header never reported unsaved work.
        .catch(() => setSaveStatus('error'))
    }, saveDelayMs)
    return () => clearTimeout(timeout)
  }, [ready, saveDelayMs, snapshot])

  const acknowledgeUnrecoverable = useCallback((): void => {
    setUnrecoverable(false)
    setReady(true)
  }, [])

  return { ready, recovered, unrecoverable, saveStatus, acknowledgeUnrecoverable }
}
