import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ReactFlowProvider } from '@xyflow/react'
import TerminalNode from '../src/renderer/src/TerminalNode'
import { resetXtermMock } from './dom/xterm-mock'

/**
 * A live node spawns its shell from an animation frame, so the node can be measured before the
 * shell is sized. A node torn down in between - a re-render that re-runs the effect, a canvas that
 * unmounts the node - used to let that frame fire anyway: the spawn reached main and was killed
 * again on arrival, which is one shell too many for every caller counting sessions.
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

test('a node unmounted before its start frame fires never spawns a shell', () => {
  const create = vi.fn(async () => ({ ok: true, sessionId: 'session', incarnationId: 'incarnation' }))
  Object.defineProperty(window, 'shellApi', {
    configurable: true,
    writable: true,
    value: { copyText: vi.fn(), readClipboardText: vi.fn(() => '') }
  })
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    value: {
      create,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => () => undefined,
      onExit: () => () => undefined
    }
  })

  // The frame is held rather than run, so the teardown lands in the window the bug lived in.
  const frames: FrameRequestCallback[] = []
  const cancelled: number[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.push(handle))

  const { unmount } = render(
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
          terminalLiveness: 'live',
          label: 'Terminal 1',
          projectId: 'project',
          projectName: 'Project',
          projectPath: '/project',
          projectColor: '#fff',
          workingDirectory: '/project',
          focusMode: false,
          dormant: false,
          launchMode: 'resume',
          onStatusChange: vi.fn(),
          onConversationId: vi.fn(),
          onFocusModeChange: vi.fn(),
          onDraftChange: vi.fn(),
          onPermissionModeChange: vi.fn(),
          onModelChange: vi.fn(),
          onResume: vi.fn()
        }}
      />
    </ReactFlowProvider>
  )

  expect(frames).toHaveLength(1)
  expect(create).not.toHaveBeenCalled()

  unmount()
  expect(cancelled).toHaveLength(1)

  // Even a frame the host ran anyway must not reach main.
  frames[0](0)
  expect(create).not.toHaveBeenCalled()
})
