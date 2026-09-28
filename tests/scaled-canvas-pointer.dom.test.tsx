import { afterEach, expect, test } from 'vitest'
import { correctScaledCanvasPointerCoordinates } from '../src/renderer/src/scaled-pointer-coordinates'

/**
 * A worktree canvas sits inside the main canvas's zoom, so React Flow inside it must see pointer
 * positions with that zoom removed - and for a drag, that includes the moves d3 follows on the
 * window in the capture phase, where it stops them going any further.
 */

let teardown = (): void => undefined
afterEach(() => {
  teardown()
  document.body.innerHTML = ''
})

/** A 1000x600 canvas shown at half size, its top-left corner at (100, 50) on screen. */
function scaledCanvas(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  Object.defineProperty(element, 'offsetWidth', { value: 1000 })
  Object.defineProperty(element, 'offsetHeight', { value: 600 })
  element.getBoundingClientRect = () => ({ left: 100, top: 50, width: 500, height: 300 }) as DOMRect
  teardown = correctScaledCanvasPointerCoordinates(element)
  return element
}

test('a press, the window-level moves of its drag and a Ctrl+wheel all arrive with the outer zoom removed', () => {
  const canvas = scaledCanvas()
  const seen: [string, number, number][] = []
  const record = (event: Event): void => {
    const pointer = event as MouseEvent
    seen.push([event.type, pointer.clientX, pointer.clientY])
  }

  // d3 registers its drag listeners on the window, capture phase, when the press reaches it.
  canvas.addEventListener('mousedown', (event) => {
    record(event)
    window.addEventListener('mousemove', record, true)
    window.addEventListener('mouseup', record, true)
  })
  canvas.addEventListener('wheel', record)

  canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 100 }))
  document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 150 }))
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 150 }))
  canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, clientX: 350, clientY: 200, ctrlKey: true }))
  window.removeEventListener('mousemove', record, true)
  window.removeEventListener('mouseup', record, true)

  expect(seen).toEqual([
    ['mousedown', 300, 150],
    ['mousemove', 500, 250],
    ['mouseup', 500, 250],
    ['wheel', 600, 350]
  ])
})

test('once the drag is over, moves elsewhere on the page are left alone', () => {
  const canvas = scaledCanvas()
  canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 100 }))
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 100 }))

  const later = new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 150 })
  document.body.dispatchEvent(later)
  expect([later.clientX, later.clientY]).toEqual([300, 150])
})
