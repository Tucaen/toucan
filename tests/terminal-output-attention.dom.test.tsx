import { act, render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ReactFlowProvider } from '@xyflow/react'
import TerminalNode from '../src/renderer/src/TerminalNode'
import type { NodeAttentionAction } from '../src/renderer/src/canvas-workspace'
import { applyAttentionAction, countUnreadAttention, type AttentionState } from '../src/shared/attention'
import type { TerminalExit, TerminalOutput } from '../src/shared/terminal'

vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())

const OUTPUT_DEBOUNCE_MS = 1200

let emitOutput: (output: TerminalOutput) => void
let emitExit: (exit: TerminalExit) => void

/** The workspace's real reducer, so what the terminal reports is judged the way the app judges it. */
function createAttentionWorkspace(): { state(): AttentionState; onAttention(action: NodeAttentionAction): void } {
  let clock = 1_700_000_000_000
  let state: AttentionState = []
  return {
    state: () => state,
    onAttention: (action) => {
      clock += 1
      state = applyAttentionAction(state, action, clock)
    }
  }
}

function terminalElement(onAttention: (action: NodeAttentionAction) => void, unread = 0) {
  return (
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
          launchMode: 'new',
          unread,
          onAttention,
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
}

function renderTerminal(onAttention: (action: NodeAttentionAction) => void, unread = 0) {
  return render(terminalElement(onAttention, unread))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    value: {
      create: vi.fn().mockResolvedValue({ ok: true, incarnationId: 'inc-1', liveness: 'live' }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      copyText: vi.fn(),
      scrollback: vi.fn().mockResolvedValue(null),
      onData: (_sessionId: string, _attachmentId: string, listener: (output: TerminalOutput) => void) => {
        emitOutput = listener
        return () => undefined
      },
      onExit: (_sessionId: string, _attachmentId: string, listener: (exit: TerminalExit) => void) => {
        emitExit = listener
        return () => undefined
      }
    }
  })
})

function write(data: string): void {
  emitOutput({ sessionId: 'session', incarnationId: 'inc-1', attachmentId: 'attachment', data })
}

test('terminal output alone never raises attention', async () => {
  const workspace = createAttentionWorkspace()
  renderTerminal(workspace.onAttention)

  await act(async () => {
    await Promise.resolve()
  })

  // Output is progress, not a request for user input, regardless of volume or pauses.
  act(() => {
    for (let index = 0; index < 10_000; index += 1) write(`line ${index}\r\n`)
  })
  expect(workspace.state()).toHaveLength(0)

  act(() => {
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS + 10)
  })
  expect(countUnreadAttention(workspace.state())).toBe(0)

  // Later bursts remain ordinary output too.
  act(() => {
    write('more output\r\n')
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS + 10)
  })
  act(() => {
    write('even more\r\n')
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS + 10)
  })

  expect(workspace.state()).toHaveLength(0)
  expect(countUnreadAttention(workspace.state())).toBe(0)
})

test('a terminal that exits on an error leaves a record a clean exit would not', async () => {
  const workspace = createAttentionWorkspace()
  renderTerminal(workspace.onAttention)
  await act(async () => {
    await Promise.resolve()
  })

  act(() => {
    emitExit({ sessionId: 'session', incarnationId: 'inc-1', attachmentId: 'attachment', exitCode: 0 })
  })
  expect(workspace.state()).toHaveLength(0)

  act(() => {
    emitExit({ sessionId: 'session', incarnationId: 'inc-1', attachmentId: 'attachment', exitCode: 137 })
  })

  expect(countUnreadAttention(workspace.state())).toBe(1)
  expect(workspace.state()[0].kind).toBe('failure')
})

test('separate terminal output bursts never synthesize attention', async () => {
  const workspace = createAttentionWorkspace()
  renderTerminal(workspace.onAttention)
  await act(async () => {
    await Promise.resolve()
  })

  act(() => {
    write('first burst\r\n')
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS + 10)
  })
  expect(countUnreadAttention(workspace.state())).toBe(0)

  act(() => {
    write('later burst\r\n')
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS + 10)
  })

  expect(countUnreadAttention(workspace.state())).toBe(0)
})
