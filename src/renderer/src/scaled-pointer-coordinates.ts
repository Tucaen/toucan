interface PointerCoordinates {
  clientX: number
  clientY: number
}

interface VisualRect {
  left: number
  top: number
  width: number
  height: number
}

interface LayoutSize {
  width: number
  height: number
}

/**
 * xterm measures cells in layout pixels, but MouseEvent coordinates and
 * getBoundingClientRect are in post-transform pixels. React Flow's viewport scale therefore has
 * to be removed before xterm maps a pointer to a cell.
 * @internal exported for tests
 */
export function unscalePointerCoordinates(
  pointer: PointerCoordinates,
  visualRect: VisualRect,
  layoutSize: LayoutSize
): PointerCoordinates {
  const scaleX = layoutSize.width > 0 ? visualRect.width / layoutSize.width : 1
  const scaleY = layoutSize.height > 0 ? visualRect.height / layoutSize.height : 1
  return {
    clientX: scaleX > 0 ? visualRect.left + (pointer.clientX - visualRect.left) / scaleX : pointer.clientX,
    clientY: scaleY > 0 ? visualRect.top + (pointer.clientY - visualRect.top) / scaleY : pointer.clientY
  }
}

/**
 * What a correction listens to. `press` starts a gesture whose moves and release are then corrected
 * wherever on the document they land, since a drag leaves the element it started in; `within` are
 * corrected only while over the element.
 */
interface PointerCorrectionEvents {
  press: readonly string[]
  moves: readonly string[]
  releases: readonly string[]
  within: readonly string[]
}

const MOUSE_EVENTS: PointerCorrectionEvents = {
  press: ['mousedown'],
  moves: ['mousemove'],
  releases: ['mouseup'],
  within: []
}

/**
 * Everything React Flow and d3 read a position from: its drags and resizes run on mouse events, its
 * pane selection on pointer events, and Ctrl+wheel zooms around the wheel's position.
 */
const CANVAS_EVENTS: PointerCorrectionEvents = {
  press: ['mousedown', 'pointerdown'],
  moves: ['mousemove', 'pointermove'],
  releases: ['mouseup', 'pointerup'],
  within: ['wheel', 'dblclick', 'click']
}

/**
 * Rewrites the coordinates of pointer events aimed at `element` so that listeners see them as if
 * `screenElement` were not scaled, before any of those listeners run. Returns the teardown.
 */
function correctScaledPointerCoordinates(
  element: HTMLElement | null | undefined,
  screenElement: HTMLElement | null | undefined,
  events: PointerCorrectionEvents
): () => void {
  // Lightweight test doubles and a surface being torn down during open may not expose the DOM.
  if (!element || !screenElement) return () => undefined
  const correctedEvents = new WeakSet<MouseEvent>()
  // A gesture's moves are followed on the window, in the capture phase: d3's drag listens there too,
  // and stops the event from going any further. Added at press time, these run before its own.
  const document = element.ownerDocument.defaultView ?? element.ownerDocument
  let dragging = false

  const correct = (event: Event): void => {
    const pointer = event as MouseEvent
    if (correctedEvents.has(pointer)) return
    correctedEvents.add(pointer)
    const corrected = unscalePointerCoordinates(pointer, screenElement.getBoundingClientRect(), {
      width: screenElement.offsetWidth,
      height: screenElement.offsetHeight
    })
    if (corrected.clientX === pointer.clientX && corrected.clientY === pointer.clientY) return
    Object.defineProperties(pointer, {
      clientX: { configurable: true, value: corrected.clientX },
      clientY: { configurable: true, value: corrected.clientY }
    })
  }

  const onDocumentMove = (event: Event): void => {
    if (dragging) correct(event)
  }
  const onDocumentRelease = (event: Event): void => {
    if (dragging) correct(event)
    dragging = false
    for (const type of events.moves) document.removeEventListener(type, onDocumentMove, true)
    for (const type of events.releases) document.removeEventListener(type, onDocumentRelease, true)
  }
  const onPress = (event: Event): void => {
    correct(event)
    if (dragging) return
    dragging = true
    for (const type of events.moves) document.addEventListener(type, onDocumentMove, true)
    for (const type of events.releases) document.addEventListener(type, onDocumentRelease, true)
  }

  const own = [...events.moves, ...events.releases, ...events.within]
  for (const type of events.press) element.addEventListener(type, onPress, true)
  for (const type of own) element.addEventListener(type, correct, true)
  return () => {
    dragging = false
    for (const type of events.press) element.removeEventListener(type, onPress, true)
    for (const type of own) element.removeEventListener(type, correct, true)
    for (const type of events.moves) document.removeEventListener(type, onDocumentMove, true)
    for (const type of events.releases) document.removeEventListener(type, onDocumentRelease, true)
  }
}

/** Correct mouse coordinates before xterm's listeners observe them. */
export function correctScaledTerminalPointerCoordinates(
  terminalElement: HTMLElement | null | undefined,
  screenElement: HTMLElement | null | undefined
): () => void {
  return correctScaledPointerCoordinates(terminalElement, screenElement, MOUSE_EVENTS)
}

/**
 * A worktree's canvas is a React Flow inside a node of the main one, so the main canvas's zoom
 * scales it on screen - and React Flow, like xterm, maps a pointer to its own coordinates without
 * knowing about any scale but its own. Uncorrected, a chat dragged at 50% main zoom moves twice as
 * far as the pointer. Only the main zoom is removed here; the inner canvas's own zoom is React
 * Flow's to apply.
 */
export function correctScaledCanvasPointerCoordinates(canvasElement: HTMLElement | null | undefined): () => void {
  return correctScaledPointerCoordinates(canvasElement, canvasElement, CANVAS_EVENTS)
}
