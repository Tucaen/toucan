import { useEffect, type RefObject } from 'react'

export interface ChatSessionControlsProps {
  rootRef: RefObject<HTMLElement>
  focusMode: boolean
  setFocusMode(enabled: boolean): void
  /** Only the selected canvas node responds when several chats are open. */
  focusShortcutEnabled?: boolean
}

/** Owns every way Focus mode is changed, including the selected-node keyboard guard. */
export default function ChatSessionControls(props: ChatSessionControlsProps): JSX.Element {
  const { focusMode, focusShortcutEnabled, rootRef, setFocusMode } = props
  useEffect(() => {
    if (focusShortcutEnabled === false) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || !event.shiftKey || (!event.ctrlKey && !event.metaKey)) return
      if (!rootRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      setFocusMode(!focusMode)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusMode, focusShortcutEnabled, rootRef, setFocusMode])

  return (
    <button
      type="button"
      className="focus-toggle nodrag nopan"
      aria-label="Focus"
      aria-pressed={props.focusMode}
      title="Toggle Focus (Ctrl+Shift+F)"
      onClick={() => props.setFocusMode(!props.focusMode)}
    >
      Focus
    </button>
  )
}
