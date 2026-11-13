import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { pathIdentity } from '../../shared/paths'
import type { HistoryRestoreRequest, RemoteHistoryOpenRequest, RemoteHistoryPage } from '../../shared/remote-history'
import type { RemoteChatSpawnResult } from '../../shared/remote-spawn'
import type { WorkspaceState } from '../../shared/workspace'
import type { ConversationHistory } from '../conversation-history'

export interface RemoteHistory {
  list(projectId: string, offset: number): Promise<RemoteHistoryPage>
  open(request: RemoteHistoryOpenRequest, permitted?: () => boolean): Promise<RemoteChatSpawnResult>
}

export function createRemoteHistory(options: {
  history: ConversationHistory
  workspace(): Promise<WorkspaceState | null>
  restore(request: HistoryRestoreRequest): Promise<RemoteChatSpawnResult>
}): RemoteHistory {
  const handles = new Map<string, HistoryRestoreRequest>()
  const opening = new Map<string, Promise<RemoteChatSpawnResult>>()

  const directories = async (projectId: string) => {
    const state = await options.workspace()
    const project = state?.projects.find((candidate) => candidate.id === projectId)
    if (!project || !state) throw new Error('That project is no longer available. Refresh History.')
    return [
      { path: project.path, label: project.name, unavailable: false },
      ...state.worktrees
        .filter((worktree) => worktree.projectId === projectId)
        .map((worktree) => ({ path: worktree.path, label: worktree.branch, unavailable: !!worktree.unavailable }))
    ]
  }

  return {
    async list(projectId, offset) {
      const scope = await directories(projectId)
      const page = await options.history.list({ directories: scope.map(({ path }) => path), offset, limit: 25 })
      const entries = page.entries.map((entry) => {
        const known = [...handles].find(
          ([, held]) =>
            held.projectId === projectId && held.entry.provider === entry.provider && held.entry.path === entry.path
        )
        const key = known?.[0] ?? randomUUID()
        handles.set(key, { projectId, entry })
        return {
          key,
          provider: entry.provider,
          title: entry.title,
          updatedAt: entry.updatedAt,
          messageCount: entry.messageCount,
          directoryLabel:
            scope.find(({ path }) => pathIdentity(path) === pathIdentity(entry.cwd))?.label ?? 'Unavailable checkout'
        }
      })
      while (handles.size > 2000) handles.delete(handles.keys().next().value!)
      // Advance by the candidate window, even if a transcript disappeared while it was read.
      return { entries, total: page.total, hasMore: page.hasMore, nextOffset: offset + 25 }
    },
    async open(request, permitted = () => true) {
      const held = handles.get(request.key)
      if (!held || held.projectId !== request.projectId)
        return { ok: false, message: 'This history entry has expired. Refresh History and select it again.' }
      const identity = `${held.entry.provider}:${held.entry.id}`
      const pending = opening.get(identity)
      if (pending) return pending
      const operation = (async (): Promise<RemoteChatSpawnResult> => {
        try {
          const scope = await directories(request.projectId)
          const directory = scope.find(({ path }) => pathIdentity(path) === pathIdentity(held.entry.cwd))
          if (!directory || directory.unavailable || !(await stat(directory.path)).isDirectory())
            return {
              ok: false,
              message: 'The original project or worktree is unavailable. It cannot be resumed elsewhere.'
            }
          if (!(await options.history.exists(held.entry.path)))
            return { ok: false, message: 'This transcript is no longer on disk, so it cannot be resumed.' }
          if (!permitted()) return { ok: false, message: 'Pairing or project access changed while opening History.' }
          return await options.restore(held)
        } catch {
          return {
            ok: false,
            message: 'The original project or worktree could not be opened. Refresh History and retry.'
          }
        }
      })()
      opening.set(identity, operation)
      try {
        return await operation
      } finally {
        opening.delete(identity)
      }
    }
  }
}
