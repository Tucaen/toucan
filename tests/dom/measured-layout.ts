import { vi } from 'vitest'
import { WORKTREE_CHROME_HEIGHT } from '../../src/renderer/src/canvas-workspace'

/**
 * jsdom lays nothing out, and everything about a canvas layout - Fit chats, snapping, tiling,
 * panning to a node - reads a size. This gives the document one, derived from what the app puts in
 * inline styles: the canvas region and every React Flow layer over it are the pane, a node is the
 * size React Flow wrote on it, and a worktree's own canvas is its node less the header and the
 * bottom row. It comes with a ResizeObserver that reports that size once, and the DOMMatrix React
 * Flow reads the zoom back from while measuring.
 */
export interface MeasuredPane {
  width: number
  height: number
}

function hostNodeSize(element: HTMLElement, pane: MeasuredPane): MeasuredPane {
  const host = element.closest<HTMLElement>('.react-flow__node')
  return host ? { width: sizeOf(host, pane).width, height: sizeOf(host, pane).height } : pane
}

function sizeOf(element: HTMLElement, pane: MeasuredPane): MeasuredPane {
  if (element.classList.contains('canvas-region')) return pane
  if (element.classList.contains('worktree-canvas')) {
    const host = hostNodeSize(element, pane)
    return { width: host.width, height: host.height - WORKTREE_CHROME_HEIGHT }
  }
  if (element.classList.contains('react-flow')) {
    const inner = element.closest<HTMLElement>('.worktree-canvas')
    return inner ? sizeOf(inner, pane) : pane
  }
  const width = Number.parseFloat(element.style.width)
  const height = Number.parseFloat(element.style.height)
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height }
  // Percent-sized and unsized boxes fill their parent, as the app's flex layout has them do.
  const parent = element.parentElement
  return parent ? sizeOf(parent, pane) : pane
}

/** Installs the layout; returns its teardown. The pane is the main canvas's usable size. */
export function installMeasuredLayout(pane: MeasuredPane = { width: 1600, height: 900 }): () => void {
  const originals = {
    width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
    rect: HTMLElement.prototype.getBoundingClientRect
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this, pane).width
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this, pane).height
    }
  })
  // Every box sits at the origin: a pointer correction then changes nothing, and a region is its size.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const { width, height } = sizeOf(this, pane)
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }
  }
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
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      readonly m22: number
      constructor(transform?: string) {
        this.m22 = Number(/scale\(([^)]+)\)/.exec(transform ?? '')?.[1] ?? 1)
      }
    }
  )
  return () => {
    vi.unstubAllGlobals()
    if (originals.width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originals.width)
    if (originals.height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originals.height)
    HTMLElement.prototype.getBoundingClientRect = originals.rect
  }
}
