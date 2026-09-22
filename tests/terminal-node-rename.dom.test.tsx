import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ReactFlowProvider } from '@xyflow/react'
import TerminalNode from '../src/renderer/src/TerminalNode'
import { resetXtermMock } from './dom/xterm-mock'

/**
 * A terminal node's label is a name, not an identity. The PTY effect used to list `data.label` in
 * its dependencies, so renaming a node would have disposed its terminal, killed its shell and
 * spawned a fresh one - losing the session behind a cosmetic edit (#230). The label is now read
 * through a ref at call time, which is what every other render-fresh field in that effect does.
 */
vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())

beforeEach(() => {
  resetXtermMock()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
})

// One object identity across renders but for the label: the effect's other dependencies are
// callbacks, and a fresh one of those would re-run the effect for a reason this test is not about.
const callbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onResume: vi.fn()
}

function nodeData(label: string): Record<string, unknown> {
  return {
    kind: 'terminal',
    sessionId: 'session',
    terminalLiveness: 'live',
    label,
    projectId: 'project',
    projectName: 'Project',
    projectPath: '/project',
    projectColor: '#fff',
    workingDirectory: '/project',
    focusMode: false,
    dormant: false,
    launchMode: 'resume',
    ...callbacks
  }
}

test('renaming a node keeps the shell it already spawned', async () => {
  const create = vi.fn(async () => ({ ok: true, sessionId: 'session', incarnationId: 'incarnation' }))
  const kill = vi.fn()
  Object.defineProperty(window, 'shellApi', {
    configurable: true,
    writable: true,
    value: { copyText: vi.fn(), readClipboardText: vi.fn(() => '') }
  })
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    value: {
      create,
      kill,
      write: vi.fn(),
      resize: vi.fn(),
      onData: () => () => undefined,
      onExit: () => () => undefined
    }
  })

  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)

  const node = (label: string): JSX.Element => (
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
        // The node's data shape is the canvas workspace's, not this test's business.
        data={nodeData(label) as never}
      />
    </ReactFlowProvider>
  )

  const { rerender, getByText } = render(node('Terminal 1'))
  frames[0]?.(0)
  await Promise.resolve()
  expect(create).toHaveBeenCalledTimes(1)

  rerender(node('Build watcher'))

  expect(getByText('Build watcher')).toBeTruthy()
  expect(create).toHaveBeenCalledTimes(1)
  expect(kill).not.toHaveBeenCalled()
})
