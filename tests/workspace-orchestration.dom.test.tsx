import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceLayoutSlot, WorkspaceState } from '../src/shared/terminal'
import { useTicketsFolderRevision, type TicketsFolder } from '../src/renderer/src/use-tickets-folder-revision'
import { useWorkspacePersistence, type WorkspaceSaveStatus } from '../src/renderer/src/workspace-persistence'
import { useWorkspaceSnapshot, type WorkspaceSnapshotInput } from '../src/renderer/src/use-workspace-snapshot'

const savedWorkspace: WorkspaceState = {
  version: 3,
  projects: [{ id: 'project-1', name: 'Toucan', path: '/toucan', color: '#fff' }],
  activeProjectId: 'project-1',
  sidebarCollapsed: false,
  nodes: [],
  worktrees: []
}

/** Everything but the layout slots, hoisted so nothing else can be what the memo reacted to. */
const stableSnapshotInput = {
  projects: savedWorkspace.projects,
  projectGroups: [],
  activeProjectId: 'project-1',
  sidebarCollapsed: false,
  agentPermissionModes: {},
  composerSendKey: 'enter',
  routineDelegation: { enabled: false },
  decisionDelegation: { enabled: false },
  dictationCleanup: { enabled: false },
  nodes: [],
  snaps: () => ({}),
  recentlyClosedNodes: [],
  attention: [],
  brainDumpPanel: { open: false, width: 360 },
  ticketBoardPanel: { open: false, width: 360 }
} satisfies Omit<WorkspaceSnapshotInput, 'layoutSlots'>

describe('tickets folder revision', () => {
  type RevisionProps = { folder: TicketsFolder; status: WorkspaceSaveStatus }
  const renderRevision = (folder: TicketsFolder) =>
    renderHook(({ folder: current, status }: RevisionProps) => useTicketsFolderRevision(current, status), {
      initialProps: { folder, status: 'saved' as WorkspaceSaveStatus }
    })

  it('advances only once the changed folder has reached disk', () => {
    // The board asks main for the folder, and main reads the persisted snapshot - so re-listing on
    // the render that changed the setting would read the folder that is still on disk.
    const { result, rerender } = renderRevision({ projectId: 'project-1', directory: 'docs/tickets' })
    expect(result.current).toBe(0)

    const moved = { projectId: 'project-1', directory: 'docs/board' }
    rerender({ folder: moved, status: 'saving' })
    expect(result.current).toBe(0)

    rerender({ folder: moved, status: 'saved' })
    expect(result.current).toBe(1)

    // A save that changed something else must not re-list the board again.
    rerender({ folder: moved, status: 'saving' })
    rerender({ folder: moved, status: 'saved' })
    expect(result.current).toBe(1)
  })

  it('does not advance for another project, which re-lists on the switch itself', () => {
    const { result, rerender } = renderRevision({ projectId: 'project-1', directory: 'docs/tickets' })

    const other = { projectId: 'project-2', directory: 'docs/other' }
    rerender({ folder: other, status: 'saving' })
    rerender({ folder: other, status: 'saved' })
    expect(result.current).toBe(0)
  })

  it('reads a Windows directory whole, colon and all', () => {
    // A packed `<id>:<folder>` key would split this on the drive letter's colon.
    const { result, rerender } = renderRevision({ projectId: 'project-1', directory: 'D:\\work\tickets' })

    const moved = { projectId: 'project-1', directory: 'D:\\work\\board' }
    rerender({ folder: moved, status: 'saving' })
    rerender({ folder: moved, status: 'saved' })
    expect(result.current).toBe(1)
  })
})

describe('workspace persistence orchestration', () => {
  const loadWorkspace = vi.fn()
  const saveWorkspace = vi.fn()

  beforeEach(() => {
    vi.useRealTimers()
    loadWorkspace.mockReset()
    saveWorkspace.mockReset().mockResolvedValue({ ok: true })
    window.terminalApi = { loadWorkspace, saveWorkspace } as unknown as Window['terminalApi']
  })

  it('restores a saved workspace and reports recovery before enabling persistence', async () => {
    loadWorkspace.mockResolvedValue({ state: savedWorkspace, recovered: true, unrecoverable: false })
    const restore = vi.fn()

    const { result } = renderHook(() => useWorkspacePersistence({ snapshot: savedWorkspace, restore, saveDelayMs: 0 }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(restore).toHaveBeenCalledWith(savedWorkspace)
    expect(result.current.recovered).toBe(true)
    await waitFor(() => expect(saveWorkspace).toHaveBeenCalledWith(savedWorkspace))
  })

  it('does not save over an unrecoverable workspace until the user acknowledges it', async () => {
    loadWorkspace.mockResolvedValue({ state: null, recovered: false, unrecoverable: true })

    const { result } = renderHook(() =>
      useWorkspacePersistence({ snapshot: savedWorkspace, restore: vi.fn(), saveDelayMs: 0 })
    )

    await waitFor(() => expect(result.current.unrecoverable).toBe(true))
    expect(result.current.ready).toBe(false)
    expect(saveWorkspace).not.toHaveBeenCalled()

    act(() => result.current.acknowledgeUnrecoverable())

    expect(result.current.ready).toBe(true)
    expect(result.current.unrecoverable).toBe(false)
    await waitFor(() => expect(saveWorkspace).toHaveBeenCalledWith(savedWorkspace))
  })

  /**
   * The snapshot and the autosave wired together, which is the only arrangement in which a missing
   * memo dependency is visible: the snapshot has to acquire a new identity for the save effect to
   * re-run at all.
   */
  function useSnapshotPersistence(): { saveSlot(slot: WorkspaceLayoutSlot): void } {
    const [layoutSlots, setLayoutSlots] = useState<Record<string, WorkspaceLayoutSlot>>({})
    // Every other field is a stable reference, as it is in the canvas, so the layout slots are the
    // only thing that can give the snapshot a new identity.
    const snapshot = useWorkspaceSnapshot({ ...stableSnapshotInput, layoutSlots })
    useWorkspacePersistence({ snapshot, restore: () => undefined, saveDelayMs: 0 })
    return { saveSlot: (slot) => setLayoutSlots((current) => ({ ...current, '1': slot })) }
  }

  it('saves a layout slot to disk, because the snapshot notices one was stored', async () => {
    // The bug this guards: Alt+Shift+1 only calls `setLayoutSlots`, so if the snapshot does not
    // depend on them nothing is ever written and the slot is gone at the next launch.
    loadWorkspace.mockResolvedValue({ state: null, recovered: false, unrecoverable: false })
    const { result } = renderHook(() => useSnapshotPersistence())
    await waitFor(() => expect(saveWorkspace).toHaveBeenCalled())
    expect(saveWorkspace.mock.calls[0][0].layoutSlots).toBeUndefined()
    saveWorkspace.mockClear()

    const slot: WorkspaceLayoutSlot = { 'node-1': { x: 10, y: 20, width: 300, height: 200 } }
    act(() => result.current.saveSlot(slot))

    await waitFor(() => expect(saveWorkspace).toHaveBeenCalled())
    expect(saveWorkspace.mock.calls.at(-1)?.[0].layoutSlots).toEqual({ '1': slot })
  })

  it('reports a rejected save as an error rather than saving forever', async () => {
    loadWorkspace.mockResolvedValue({ state: null, recovered: false, unrecoverable: false })
    saveWorkspace.mockRejectedValue(new Error('the IPC channel is gone'))
    const { result } = renderHook(() =>
      useWorkspacePersistence({ snapshot: savedWorkspace, restore: () => undefined, saveDelayMs: 0 })
    )

    await waitFor(() => expect(result.current.saveStatus).toBe('error'))
  })

  it('opens on an empty workspace when no persisted files exist, rather than guessing a project', async () => {
    loadWorkspace.mockResolvedValue({ state: null, recovered: false, unrecoverable: false })
    const restore = vi.fn()

    const { result } = renderHook(() => useWorkspacePersistence({ snapshot: savedWorkspace, restore, saveDelayMs: 0 }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(restore).not.toHaveBeenCalled()
  })
})
