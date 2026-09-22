import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import BrainDumpLifecycleDialog from '../src/renderer/src/BrainDumpLifecycleDialog'
import BrainDumpPermissionDialog from '../src/renderer/src/BrainDumpPermissionDialog'
import ConversationHistoryDialog from '../src/renderer/src/ConversationHistoryDialog'
import FilePickerDialog from '../src/renderer/src/FilePickerDialog'
import { RemoteAccessDialog } from '../src/renderer/src/RemoteAccessDialog'
import TicketDeleteDialog from '../src/renderer/src/TicketDeleteDialog'
import { ProjectSettingsDialog, WorktreeCreateDialog, WorktreeRemoveDialog } from '../src/renderer/src/WorkspaceDialogs'
import { cardFixture } from './dom/tickets-api-mock'
import type { WorkspaceProject } from '../src/shared/workspace'

/**
 * Every overlay dialog goes through the one `ModalDialog` policy (#231). The shell's own contract
 * (trap, restore, autoFocus respect) is asserted in `modal-dialog.dom.test.tsx`; this file pins
 * each family to it: the dialog announces itself, focus is inside it on open, and Escape closes
 * it through the same gate its Cancel button has.
 */

const project = { id: 'p1', name: 'Toucan', path: 'D:/Development/Toucan', color: '#71a9ff' } as WorkspaceProject

afterEach(() => {
  Reflect.deleteProperty(window, 'conversationApi')
  Reflect.deleteProperty(window, 'workspaceFilesApi')
})

interface DialogCase {
  name: string
  role?: 'dialog' | 'alertdialog'
  render(onClose: () => void): JSX.Element
}

const families: DialogCase[] = [
  {
    name: 'WorktreeCreateDialog',
    render: (onClose) => (
      <WorktreeCreateDialog
        draft={{ projectId: 'p1', branch: '', baseRef: '', position: { x: 0, y: 0 }, busy: false, error: null }}
        project={project}
        onChange={vi.fn()}
        onCancel={onClose}
        onConfirm={vi.fn()}
      />
    )
  },
  {
    name: 'WorktreeRemoveDialog',
    role: 'alertdialog',
    render: (onClose) => (
      <WorktreeRemoveDialog
        prompt={{
          worktreeId: 'w1',
          branch: 'feature/x',
          path: 'D:/x',
          plan: { decision: 'ready', hard: [], forcible: [], attachedNodes: 0 },
          busy: false,
          error: null
        }}
        onCancel={onClose}
        onConfirm={vi.fn()}
      />
    )
  },
  {
    name: 'ProjectSettingsDialog',
    render: (onClose) => (
      <ProjectSettingsDialog
        project={project}
        avatarUrl={null}
        avatarError={null}
        onChooseAvatar={vi.fn()}
        onRemoveAvatar={vi.fn()}
        onCancel={onClose}
        onSave={vi.fn()}
      />
    )
  },
  {
    name: 'ConversationHistoryDialog',
    render: (onClose) => (
      <ConversationHistoryDialog
        projectName="Toucan"
        directories={[project.path]}
        directoryLabels={{}}
        onCancel={onClose}
        onOpen={vi.fn()}
      />
    )
  },
  {
    name: 'RemoteAccessDialog',
    render: (onClose) => (
      <RemoteAccessDialog
        state={null}
        busy={false}
        onApply={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyToken={vi.fn()}
        onClose={onClose}
      />
    )
  },
  {
    name: 'FilePickerDialog',
    render: (onClose) => (
      <FilePickerDialog projectName="Toucan" root={project.path} onCancel={onClose} onOpen={vi.fn()} />
    )
  },
  {
    name: 'TicketDeleteDialog',
    role: 'alertdialog',
    render: (onClose) => (
      <TicketDeleteDialog
        cards={[cardFixture({ id: 't1' })]}
        notes={[]}
        pending={false}
        onConfirm={vi.fn()}
        onCancel={onClose}
      />
    )
  },
  {
    name: 'BrainDumpLifecycleDialog',
    render: (onClose) => (
      <BrainDumpLifecycleDialog title="Voice input" pending={false} onArchive={vi.fn()} onCancel={onClose} />
    )
  },
  {
    name: 'BrainDumpPermissionDialog',
    render: (onClose) => (
      <BrainDumpPermissionDialog
        approval={{ id: 'a1', title: 'Write topic.md', options: [{ id: 'allow', kind: 'allow_once', label: 'Allow' }] }}
        onResolve={onClose}
      />
    )
  }
]

describe.each(families)('$name', ({ role, render: renderDialog }) => {
  test('announces itself as a modal, holds focus inside, and closes on Escape', async () => {
    window.conversationApi = {
      list: vi.fn(async () => ({ entries: [], total: 0, hasMore: false })),
      exists: vi.fn(async () => true)
    } as never
    window.workspaceFilesApi = { index: vi.fn(async () => ({ root: project.path, entries: [] })) } as never

    const onClose = vi.fn()
    render(renderDialog(onClose))

    const dialog = screen.getByRole(role ?? 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName()
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
