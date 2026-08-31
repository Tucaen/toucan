import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ReactFlowProvider } from '@xyflow/react'
import TerminalNode from '../src/renderer/src/TerminalNode'

const terminalWrites: string[] = []
const terminalInputs: Array<(data: string) => void> = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon(): void {}
    open(): void {}
    write(data: string): void {
      terminalWrites.push(data)
    }
    onData(listener: (data: string) => void): { dispose(): void } {
      terminalInputs.push(listener)
      return { dispose: () => undefined }
    }
    onSelectionChange(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}))

beforeEach(() => {
  terminalWrites.length = 0
  terminalInputs.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
})

test('a dormant terminal restores display-only history without spawning or accepting input', async () => {
  const create = vi.fn()
  const write = vi.fn()
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    value: {
      create,
      write,
      scrollback: vi.fn().mockResolvedValue({
        sessionId: 'session',
        incarnationId: 'retired-incarnation',
        data: '\x1b[32mkept output\x1b[0m',
        capturedAt: 100,
        truncated: true,
        incomplete: true
      }),
      copyText: vi.fn()
    }
  })

  render(
    <ReactFlowProvider>
      <TerminalNode
        id="node"
        type="terminalNode"
        selected={false}
        dragging={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          kind: 'terminal',
          sessionId: 'session',
          terminalLiveness: 'unverifiable',
          label: 'Terminal 1',
          projectId: 'project',
          projectName: 'Project',
          projectPath: '/project',
          projectColor: '#fff',
          workingDirectory: '/project',
          focusMode: false,
          dormant: true,
          launchMode: 'resume',
          onStatusChange: vi.fn(),
          onConversationId: vi.fn(),
          onPreview: vi.fn(),
          onFocusModeChange: vi.fn(),
          onDraftChange: vi.fn(),
          onPermissionModeChange: vi.fn(),
          onModelChange: vi.fn(),
          onResume: vi.fn()
        }}
      />
    </ReactFlowProvider>
  )

  await waitFor(() => expect(terminalWrites.join('')).toContain('kept output'))
  expect(terminalWrites.join('')).toContain('Earlier output was truncated or incomplete')
  expect(create).not.toHaveBeenCalled()
  expect(terminalInputs).toHaveLength(0)
  expect(write).not.toHaveBeenCalled()
})

test('missing or corrupt retained history is visible without changing terminal state', async () => {
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    value: { scrollback: vi.fn().mockResolvedValue(null), copyText: vi.fn(), create: vi.fn(), write: vi.fn() }
  })
  render(
    <ReactFlowProvider>
      <TerminalNode
        id="node"
        type="terminalNode"
        selected={false}
        dragging={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          kind: 'terminal',
          sessionId: 'session',
          terminalLiveness: 'unverifiable',
          label: 'Terminal 1',
          projectId: 'project',
          projectName: 'Project',
          projectPath: '/project',
          projectColor: '#fff',
          workingDirectory: '/project',
          focusMode: false,
          dormant: true,
          launchMode: 'resume',
          onStatusChange: vi.fn(),
          onConversationId: vi.fn(),
          onPreview: vi.fn(),
          onFocusModeChange: vi.fn(),
          onDraftChange: vi.fn(),
          onPermissionModeChange: vi.fn(),
          onModelChange: vi.fn(),
          onResume: vi.fn()
        }}
      />
    </ReactFlowProvider>
  )

  expect(await screen.findByText(/Retained output is missing, expired, corrupt/)).toBeInTheDocument()
  expect(window.terminalApi.create).not.toHaveBeenCalled()
  expect(window.terminalApi.write).not.toHaveBeenCalled()
})
