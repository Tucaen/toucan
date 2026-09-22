import type { ComposerSendKey } from '../../shared/workspace'

export type { ComposerSendKey }

export const COMPOSER_SEND_KEY_DEFAULT: ComposerSendKey = 'enter'

export const composerSendKeyLabels: Record<ComposerSendKey, { name: string; description: string }> = {
  enter: { name: 'Enter sends', description: 'Enter sends the message, Shift+Enter starts a new line.' },
  'mod-enter': { name: 'Ctrl+Enter sends', description: 'Enter starts a new line, Ctrl/Cmd+Enter sends the message.' }
}

/** The parts of a keyboard event this decision actually reads, so it can be tested without a DOM. */
export interface ComposerKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** True while an IME is still composing; such an Enter commits the composition, it never sends. */
  isComposing?: boolean
}

export interface ComposerKeyContext {
  sendKey: ComposerSendKey
  draft: string
  /** True while the composer is walking prompt history, so the arrows keep navigating. */
  historyActive: boolean
}

export type ComposerKeyAction =
  | 'send'
  | 'newline'
  | 'history-previous'
  | 'history-next'
  | 'history-cancel'
  /** Nothing special: let the browser handle the key as ordinary text editing. */
  | 'none'

/**
 * The single place that decides what a key press means in the composer. Everything the caller
 * needs to know - whether to send, to let a newline through, or to walk prompt history - comes
 * out of here, so the send-key preference and the history gesture can never disagree about the
 * same key press.
 */
export function composerKeyAction(event: ComposerKeyEvent, context: ComposerKeyContext): ComposerKeyAction {
  if (event.isComposing) return 'none'

  if (event.key === 'Enter') {
    // Alt+Enter is a newline everywhere, under either preference: no send binding uses it, and
    // some keyboard layouts reach characters through it.
    if (event.altKey) return 'newline'
    const modified = event.ctrlKey || event.metaKey
    if (context.sendKey === 'mod-enter') return modified && !event.shiftKey ? 'send' : 'newline'
    // Ctrl/Cmd+Enter sends here too: it is the other binding's muscle memory, and honouring it
    // is strictly better than silently inserting a newline the user did not ask for.
    if (event.shiftKey) return modified ? 'send' : 'newline'
    return 'send'
  }

  if (event.key === 'Escape') return context.historyActive ? 'history-cancel' : 'none'

  const plainArrow = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  if (!plainArrow) return 'none'
  // Once history is being walked the arrows own themselves until the user types again; before
  // that, only an empty composer offers the gesture, so ArrowUp stays a caret move in a draft.
  if (event.key === 'ArrowUp' && (context.historyActive || context.draft === '')) return 'history-previous'
  if (event.key === 'ArrowDown' && context.historyActive) return 'history-next'
  return 'none'
}
