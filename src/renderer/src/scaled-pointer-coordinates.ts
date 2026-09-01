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

/** Correct mouse coordinates before xterm's listeners observe them. */
export function correctScaledTerminalPointerCoordinates(
  terminalElement: HTMLElement | null | undefined,
  screenElement: HTMLElement | null | undefined
): () => void {
  // Lightweight test doubles and a terminal being torn down during open may not expose the DOM.
  if (!terminalElement || !screenElement) return () => undefined
  const correctedEvents = new WeakSet<MouseEvent>()
  const document = terminalElement.ownerDocument
  let dragging = false

  const correct = (event: MouseEvent): void => {
    if (correctedEvents.has(event)) return
    correctedEvents.add(event)
    const corrected = unscalePointerCoordinates(event, screenElement.getBoundingClientRect(), {
      width: screenElement.offsetWidth,
      height: screenElement.offsetHeight
    })
    if (corrected.clientX === event.clientX && corrected.clientY === event.clientY) return
    Object.defineProperties(event, {
      clientX: { configurable: true, value: corrected.clientX },
      clientY: { configurable: true, value: corrected.clientY }
    })
  }

  const onMouseDown = (event: MouseEvent): void => {
    correct(event)
    dragging = true
    document.addEventListener('mousemove', onDocumentMouseMove, true)
    document.addEventListener('mouseup', onDocumentMouseUp, true)
  }
  const onMouseMove = (event: MouseEvent): void => correct(event)
  const onMouseUp = (event: MouseEvent): void => correct(event)
  const onDocumentMouseMove = (event: MouseEvent): void => {
    if (dragging) correct(event)
  }
  const onDocumentMouseUp = (event: MouseEvent): void => {
    if (dragging) correct(event)
    dragging = false
    document.removeEventListener('mousemove', onDocumentMouseMove, true)
    document.removeEventListener('mouseup', onDocumentMouseUp, true)
  }

  terminalElement.addEventListener('mousedown', onMouseDown, true)
  terminalElement.addEventListener('mousemove', onMouseMove, true)
  terminalElement.addEventListener('mouseup', onMouseUp, true)
  return () => {
    dragging = false
    terminalElement.removeEventListener('mousedown', onMouseDown, true)
    terminalElement.removeEventListener('mousemove', onMouseMove, true)
    terminalElement.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('mousemove', onDocumentMouseMove, true)
    document.removeEventListener('mouseup', onDocumentMouseUp, true)
  }
}
