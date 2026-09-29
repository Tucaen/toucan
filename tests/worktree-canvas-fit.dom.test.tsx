import { ReactFlowProvider } from '@xyflow/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { WorkspaceProject } from '../src/shared/workspace'
import type { WorktreeViewport } from '../src/shared/worktree'
import WorktreeNode from '../src/renderer/src/WorktreeNode'
import {
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode
} from '../src/renderer/src/canvas-workspace'
import { partitionWorktreeCanvases, splitWorktreeCanvasEdges } from '../src/renderer/src/worktree-canvas'
import { WorktreeCanvasContext } from '../src/renderer/src/worktree-canvas-context'
import { createMockAgentApi } from './dom/agent-api-mock'

/**
 * Fit chats has to frame every chat in the worktree's own viewport - including one added a moment
 * ago, which React Flow can only frame once it has been measured. jsdom measures nothing, so this
 * file gives it a layout: every element is as wide and tall as its inline style says (the canvas is
 * a 1000x600 pane), and a ResizeObserver that reports what it is given to observe.
 */

const PANE = { width: 1000, height: 600 }
const PROJECT: WorkspaceProject = { id: 'project-1', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }
const noop = (): undefined => undefined
const sessionCallbacks = {
  onStatusChange: noop,
  onConversationId: noop,
  onTitleChange: async () => true,
  onFocusModeChange: noop,
  onDraftChange: noop,
  onPermissionModeChange: noop,
  onModelChange: noop,
  onResume: noop
}

function styleSize(element: HTMLElement, axis: 'width' | 'height'): number {
  // The canvas and the layers React Flow stretches over it are the pane; a node is its own size.
  if (element.classList.contains('react-flow') || element.style[axis].endsWith('%')) return PANE[axis]
  const inline = Number.parseFloat(element.style[axis])
  return Number.isFinite(inline) ? inline : 0
}

const originals = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return styleSize(this, 'width')
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return styleSize(this, 'height')
    }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        const element = target as HTMLElement
        const contentRect = { width: element.offsetWidth, height: element.offsetHeight }
        queueMicrotask(() =>
          this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver)
        )
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  // React Flow reads the zoom back off the viewport's computed transform while measuring.
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      readonly m22: number
      constructor(transform?: string) {
        this.m22 = Number(/scale\(([^)]+)\)/.exec(transform ?? '')?.[1] ?? 1)
      }
    }
  )
  window.agentApi = createMockAgentApi().api
  Object.defineProperty(window, 'worktreeApi', { configurable: true, value: { status: vi.fn(async () => null) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originals.width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originals.width)
  if (originals.height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originals.height)
})

function chat(id: string, x: number): TerminalCanvasNode {
  return {
    ...createSessionCanvasNode(
      { id, kind: 'codex', label: id, position: { x, y: 0 }, launchMode: 'new' },
      PROJECT,
      { worktreeId: 'w1', branch: 'feature/login', path: 'D:\\Development\\toucan-worktrees\\feature-login' },
      sessionCallbacks
    ),
    selected: false
  }
}

function view(
  children: TerminalCanvasNode[],
  onViewportChange: (id: string, viewport: WorktreeViewport) => void
): ReactElement {
  const worktree = createWorktreeCanvasNode(
    {
      worktreeId: 'w1',
      branch: 'feature/login',
      path: 'D:\\Development\\toucan-worktrees\\feature-login',
      baseRef: 'main',
      createdAt: '2026-09-28T00:00:00.000Z',
      position: { x: 0, y: 0 }
    },
    PROJECT,
    {
      onRemoveWorktree: noop,
      onCreateNodeInWorktree: noop,
      onRunSetupCommand: noop,
      onOpenDiff: noop,
      onViewportChange,
      onToggleCollapsed: noop
    }
  )
  const nodes: CanvasNode[] = [worktree, ...children]
  const partition = partitionWorktreeCanvases(nodes)
  return (
    <WorktreeCanvasContext.Provider
      value={{
        partition,
        edges: splitWorktreeCanvasEdges([], partition),
        activity: new Map(),
        onNodesChange: noop,
        onPaneClick: noop,
        registerCanvas: () => noop,
        onCanvasResize: noop
      }}
    >
      <ReactFlowProvider>
        <WorktreeNode
          id={worktree.id}
          type="worktreeNode"
          data={worktree.data}
          selected={false}
          dragging={false}
          zIndex={0}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </ReactFlowProvider>
    </WorktreeCanvasContext.Provider>
  )
}

/** Whether the chats' bounding box, seen through `viewport`, lies inside the pane. */
function framed(children: TerminalCanvasNode[], viewport: WorktreeViewport): boolean {
  const right = Math.max(...children.map((node) => node.position.x + Number(node.style?.width)))
  const bottom = Math.max(...children.map((node) => node.position.y + Number(node.style?.height)))
  const left = Math.min(...children.map((node) => node.position.x))
  const top = Math.min(...children.map((node) => node.position.y))
  return (
    left * viewport.zoom + viewport.x >= -0.5 &&
    top * viewport.zoom + viewport.y >= -0.5 &&
    right * viewport.zoom + viewport.x <= PANE.width + 0.5 &&
    bottom * viewport.zoom + viewport.y <= PANE.height + 0.5
  )
}

test('Fit chats frames every chat, including one added after the canvas was framed, once it is measured', async () => {
  const onViewportChange = vi.fn<(id: string, viewport: WorktreeViewport) => void>()
  const first = [chat('a', 0)]
  const { rerender } = render(view(first, onViewportChange))

  // No saved viewport: the canvas frames its chat on its own as soon as it is measured.
  await waitFor(() => expect(onViewportChange).toHaveBeenCalled(), { timeout: 2000 })
  expect(onViewportChange.mock.calls.at(-1)![0]).toBe('w1')
  expect(framed(first, onViewportChange.mock.calls.at(-1)![1])).toBe(true)

  // A second chat beside the first lies outside that frame until it has been measured and framed.
  const both = [...first, chat('b', 798)]
  onViewportChange.mockClear()
  rerender(view(both, onViewportChange))
  await waitFor(() => expect(onViewportChange).toHaveBeenCalled(), { timeout: 2000 })
  expect(framed(both, onViewportChange.mock.calls.at(-1)![1])).toBe(true)

  // And Fit chats on demand frames them both, from the row under the canvas.
  onViewportChange.mockClear()
  await act(async () => {
    fireEvent.click(screen.getByTitle('Frame every chat in this worktree'))
  })
  await waitFor(() => expect(onViewportChange).toHaveBeenCalled(), { timeout: 2000 })
  expect(framed(both, onViewportChange.mock.calls.at(-1)![1])).toBe(true)
})
