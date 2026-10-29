/**
 * Backspace never removes a chat node; only Delete (Entf) does.
 *
 * React Flow's `deleteKeyCode` is one list for every kind of node and cannot say which key asked,
 * so both canvases keep it at `['Backspace', 'Delete']` and let `onBeforeDelete` - which React
 * Flow awaits with the nodes it is about to remove - hold the chats back when the key that started
 * the removal was Backspace. Deciding there, rather than in the key list or by watching the
 * selection, leaves no window: it does not depend on focus, on a re-render having caught up with a
 * click, or on timing, and other node kinds keep both keys. The tracker only has to know whether
 * Backspace is the key currently held; it listens on `window` in the capture phase, so it sees the
 * keydown before React Flow's `document` listener and even when the typing guard swallows it.
 */
import type { CanvasNode } from './canvas-workspace'
import { isChatCanvasNode } from './canvas-workspace'

interface EdgeEnds {
  id: string
  source: string
  target: string
  selected?: boolean
}

export interface BackspaceChatShield {
  /** Feed every keydown and keyup, in order; true on a keydown means Backspace is the key now held. */
  track(event: { type: string; key: string; code?: string }): void
  /** Forget a held key: a window that lost focus never sees the keyup. */
  reset(): void
  /** React Flow's `onBeforeDelete`: what may be removed given the key that asked. */
  beforeDelete<N extends CanvasNode, E extends EdgeEnds>(params: {
    nodes: N[]
    edges: E[]
  }): Promise<{ nodes: N[]; edges: E[] }>
  /** Starts listening on `target`; returns the uninstall. */
  install(target?: Window): () => void
}

function isBackspace(event: { key: string; code?: string }): boolean {
  return event.key === 'Backspace' || event.code === 'Backspace'
}

/** @internal exported for tests */
export function createBackspaceChatShield(): BackspaceChatShield {
  let backspaceHeld = false
  const shield: BackspaceChatShield = {
    track(event) {
      if (event.type === 'keydown') backspaceHeld = isBackspace(event)
      else if (isBackspace(event)) backspaceHeld = false
    },
    reset() {
      backspaceHeld = false
    },
    beforeDelete({ nodes, edges }) {
      if (!backspaceHeld) return Promise.resolve({ nodes, edges })
      const kept = nodes.filter((node) => !isChatCanvasNode(node))
      if (kept.length === nodes.length) return Promise.resolve({ nodes, edges })
      const held = new Set(nodes.filter(isChatCanvasNode).map((node) => node.id))
      // An edge goes with its node, so one left behind with a chat that stays is not removed; an
      // edge the user selected themselves is still theirs to delete.
      return Promise.resolve({
        nodes: kept,
        edges: edges.filter((edge) => edge.selected || !(held.has(edge.source) || held.has(edge.target)))
      })
    },
    install(target = window) {
      const onKey = (event: KeyboardEvent): void => shield.track(event)
      const onBlur = (): void => shield.reset()
      target.addEventListener('keydown', onKey, true)
      target.addEventListener('keyup', onKey, true)
      target.addEventListener('blur', onBlur)
      return () => {
        target.removeEventListener('keydown', onKey, true)
        target.removeEventListener('keyup', onKey, true)
        target.removeEventListener('blur', onBlur)
      }
    }
  }
  return shield
}

/** The one shield both canvases share: there is one keyboard. */
export const backspaceChatShield = createBackspaceChatShield()
