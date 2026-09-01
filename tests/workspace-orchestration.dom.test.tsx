import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/terminal'
import { useWorkspacePersistence } from '../src/renderer/src/workspace-persistence'

const savedWorkspace: WorkspaceState = {
  version: 3,
  projects: [{ id: 'project-1', name: 'Toucan', path: '/toucan', color: '#fff' }],
  activeProjectId: 'project-1',
  sidebarCollapsed: false,
  nodes: [],
  worktrees: []
}

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
    const seedFresh = vi.fn()

    const { result } = renderHook(() =>
      useWorkspacePersistence({ snapshot: savedWorkspace, restore, seedFresh, saveDelayMs: 0 })
    )

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(restore).toHaveBeenCalledWith(savedWorkspace)
    expect(seedFresh).not.toHaveBeenCalled()
    expect(result.current.recovered).toBe(true)
    await waitFor(() => expect(saveWorkspace).toHaveBeenCalledWith(savedWorkspace))
  })

  it('does not seed or save over an unrecoverable workspace until the user acknowledges it', async () => {
    loadWorkspace.mockResolvedValue({ state: null, recovered: false, unrecoverable: true })
    const seedFresh = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useWorkspacePersistence({ snapshot: savedWorkspace, restore: vi.fn(), seedFresh, saveDelayMs: 0 })
    )

    await waitFor(() => expect(result.current.unrecoverable).toBe(true))
    expect(result.current.ready).toBe(false)
    expect(seedFresh).not.toHaveBeenCalled()
    expect(saveWorkspace).not.toHaveBeenCalled()

    await act(() => result.current.acknowledgeUnrecoverable())

    expect(seedFresh).toHaveBeenCalledOnce()
    expect(result.current.ready).toBe(true)
    expect(result.current.unrecoverable).toBe(false)
    await waitFor(() => expect(saveWorkspace).toHaveBeenCalledWith(savedWorkspace))
  })

  it('seeds a fresh workspace when no persisted files exist', async () => {
    loadWorkspace.mockResolvedValue({ state: null, recovered: false, unrecoverable: false })
    const seedFresh = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useWorkspacePersistence({ snapshot: savedWorkspace, restore: vi.fn(), seedFresh, saveDelayMs: 0 })
    )

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(seedFresh).toHaveBeenCalledOnce()
  })
})
