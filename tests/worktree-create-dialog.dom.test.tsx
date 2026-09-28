import { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '../src/shared/agent-provider'
import type { WorkspaceProject } from '../src/shared/workspace'
import type { WorktreeCreateResult } from '../src/shared/worktree'
import { WorktreeCreateDialog, type WorktreeDraft } from '../src/renderer/src/WorkspaceDialogs'
import { createWorktreeCreator } from '../src/renderer/src/worktree-creation'

const PROJECT: WorkspaceProject = { id: 'project-1', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }
const WORKTREE_PATH = 'D:\\Development\\toucan-worktrees\\feature-login'

function draft(overrides: Partial<WorktreeDraft> = {}): WorktreeDraft {
  return {
    projectId: PROJECT.id,
    branch: '',
    baseRef: '',
    provider: 'claude',
    position: { x: 0, y: 0 },
    busy: false,
    error: null,
    ...overrides
  }
}

describe('first chat choice', () => {
  it('offers Claude and Codex beside the branch controls, with the draft provider chosen', () => {
    render(
      <WorktreeCreateDialog
        draft={draft({ provider: 'codex' })}
        project={PROJECT}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const group = screen.getByRole('radiogroup', { name: 'First chat' })
    expect(group).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Codex' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Claude' })).not.toBeChecked()
    expect(screen.getByLabelText('Branch name')).toBeVisible()
    expect(screen.getByLabelText('Branch from')).toBeVisible()
  })

  it('reports a picked provider as a draft change', () => {
    const onChange = vi.fn()
    render(
      <WorktreeCreateDialog
        draft={draft()}
        project={PROJECT}
        onChange={onChange}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))

    expect(onChange).toHaveBeenCalledWith({ provider: 'codex' })
  })

  it('cannot change provider while creation is pending', () => {
    render(
      <WorktreeCreateDialog
        draft={draft({ branch: 'feature/login', busy: true })}
        project={PROJECT}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('radio', { name: 'Claude' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Codex' })).toBeDisabled()
  })
})

/**
 * The dialog wired to the creator the way the canvas wires it: the draft is the dialog's state, a
 * submit goes through the single-flight creator, and the outcome closes or annotates the draft.
 */
function Harness({
  create,
  startChat,
  onOutcome
}: {
  create(): Promise<WorktreeCreateResult>
  startChat(worktree: { worktreeId: string; path: string }, provider: AgentProvider): string | null
  onOutcome(status: string): void
}): JSX.Element | null {
  const [current, setCurrent] = useState<WorktreeDraft | null>(draft())
  const registered = useRef(0)
  const creator = useRef(
    createWorktreeCreator<{ worktreeId: string; path: string }>({
      create,
      register: (created) => {
        registered.current += 1
        return { worktreeId: `worktree-${registered.current}`, path: created.path }
      },
      startChat
    })
  )
  if (!current) return null
  return (
    <WorktreeCreateDialog
      draft={current}
      project={PROJECT}
      onChange={(patch) => setCurrent((value) => (value ? { ...value, ...patch } : value))}
      onCancel={() => setCurrent(null)}
      onConfirm={() => {
        const submitted = current
        const pending = creator.current.submit({
          projectPath: PROJECT.path,
          branch: submitted.branch,
          baseRef: submitted.baseRef.trim() || undefined,
          provider: submitted.provider
        })
        if (!pending) return
        setCurrent({ ...submitted, busy: true, error: null })
        void pending.then((outcome) => {
          onOutcome(outcome.status)
          setCurrent(outcome.status === 'failed' ? { ...submitted, busy: false, error: outcome.message } : null)
        })
      }}
    />
  )
}

const created = (): Promise<WorktreeCreateResult> =>
  Promise.resolve({ ok: true, worktree: { path: WORKTREE_PATH, branch: 'feature/login', baseRef: 'main' } })

describe('creating a worktree with its first chat', () => {
  for (const [label, provider] of [
    ['Claude', 'claude'],
    ['Codex', 'codex']
  ] as const) {
    it(`opens one ${label} chat in the new worktree's directory`, async () => {
      const startChat = vi.fn().mockReturnValue('chat-1')
      const onOutcome = vi.fn()
      render(<Harness create={created} startChat={startChat} onOutcome={onOutcome} />)

      fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'feature/login' } })
      fireEvent.click(screen.getByRole('radio', { name: label }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))
      })

      expect(startChat).toHaveBeenCalledTimes(1)
      expect(startChat).toHaveBeenCalledWith({ worktreeId: 'worktree-1', path: WORKTREE_PATH }, provider, undefined)
      expect(onOutcome).toHaveBeenCalledWith('created')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  }

  it('ignores a second submit while the first is pending', async () => {
    let resolveCreate: (result: WorktreeCreateResult) => void = () => {}
    const create = vi.fn(
      () =>
        new Promise<WorktreeCreateResult>((resolve) => {
          resolveCreate = resolve
        })
    )
    const startChat = vi.fn().mockReturnValue('chat-1')
    render(<Harness create={create} startChat={startChat} onOutcome={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'feature/login' } })
    const form = screen.getByRole('button', { name: 'Create worktree' }).closest('form')!
    // Two submits in one tick: the second lands before `busy` has rendered.
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    await act(async () => {
      resolveCreate({ ok: true, worktree: { path: WORKTREE_PATH, branch: 'feature/login', baseRef: 'main' } })
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledTimes(1)
  })

  it('keeps every form value and starts no chat when git refuses', async () => {
    const startChat = vi.fn()
    render(
      <Harness
        create={() => Promise.resolve({ ok: false, message: "a branch named 'feature/login' already exists" })}
        startChat={startChat}
        onOutcome={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'feature/login' } })
    fireEvent.change(screen.getByLabelText('Branch from'), { target: { value: 'develop' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))
    })

    expect(screen.getByText("a branch named 'feature/login' already exists")).toBeVisible()
    expect(screen.getByLabelText('Branch name')).toHaveValue('feature/login')
    expect(screen.getByLabelText('Branch from')).toHaveValue('develop')
    expect(screen.getByRole('radio', { name: 'Codex' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Create worktree' })).toBeEnabled()
    expect(startChat).not.toHaveBeenCalled()
  })

  it('closes on a chat that could not start, leaving the one worktree it created', async () => {
    const create = vi.fn(created)
    const onOutcome = vi.fn()
    render(<Harness create={create} startChat={() => null} onOutcome={onOutcome} />)

    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'feature/login' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))
    })

    expect(onOutcome).toHaveBeenCalledWith('chat-failed')
    expect(create).toHaveBeenCalledTimes(1)
    // No dialog left to resubmit: retrying the chat is the worktree node's, never a second checkout.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
