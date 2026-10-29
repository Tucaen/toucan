/**
 * A Backspace or Delete that is the tail of typing must never reach the canvas's delete key.
 *
 * React Flow's `deleteKeyCode` ignores keys typed into an input, a textarea or a contenteditable,
 * so a focused composer is safe. The gap is the instant the focused element stops being one: a
 * structured decision replaces the composer, the session ends and disables it. Focus falls to the
 * body, and the Backspace presses still arriving - a held key repeats - close the selected chat.
 * Only the keystrokes cannot tell the two apart, so this remembers that one was just typing:
 * a delete key on a non-editable target within `TYPING_TAIL_MS` of the last editable keydown (or
 * of the last keydown this swallowed, so a held key stays one gesture) is dropped before React
 * Flow, which listens on `document`, sees it. A press that starts after a pause, or after a
 * pointer press elsewhere, is an intentional delete and passes through untouched.
 */

/**
 * Longer than a key-repeat gap or a quick re-press, shorter than a deliberate reach for Delete.
 * @internal exported for tests
 */
export const TYPING_TAIL_MS = 1200

const DELETE_KEYS = new Set(['Backspace', 'Delete'])

export interface TypingDeleteKey {
  key: string
  /** Whether the keydown's target is a text field (input, textarea, contenteditable). */
  editable: boolean
}

export interface TypingDeleteGuard {
  /** Feed every keydown, in order; true means this one is the tail of typing and must be dropped. */
  swallows(key: TypingDeleteKey): boolean
  /** A pointer press moves the caret or the selection: whatever was being typed is over. */
  pointerPressed(): void
}

/** @internal exported for tests */
export function createTypingDeleteGuard(now: () => number = Date.now): TypingDeleteGuard {
  let lastTypingAt: number | null = null
  return {
    swallows({ key, editable }) {
      const at = now()
      if (editable) {
        lastTypingAt = at
        return false
      }
      if (!DELETE_KEYS.has(key)) {
        lastTypingAt = null
        return false
      }
      if (lastTypingAt === null || at - lastTypingAt > TYPING_TAIL_MS) {
        lastTypingAt = null
        return false
      }
      lastTypingAt = at
      return true
    },
    pointerPressed() {
      lastTypingAt = null
    }
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/**
 * Listens on `window` in the capture phase, which runs before React Flow's `document` listener,
 * and stops the swallowed keydown there. Returns the uninstall.
 */
export function installTypingDeleteGuard(target: Window = window, guard = createTypingDeleteGuard()): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (guard.swallows({ key: event.key, editable: isEditableTarget(event.target) })) {
      event.stopImmediatePropagation()
      event.preventDefault()
    }
  }
  const onPointerDown = (): void => guard.pointerPressed()
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('pointerdown', onPointerDown, true)
  target.addEventListener('mousedown', onPointerDown, true)
  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('pointerdown', onPointerDown, true)
    target.removeEventListener('mousedown', onPointerDown, true)
  }
}
