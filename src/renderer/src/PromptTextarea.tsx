import { useLayoutEffect, useRef, type ClipboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePortalMenuPosition } from './use-portal-menu-position'
import type { PromptEditor, PromptEditorPicker } from './use-prompt-editor'

/**
 * The prompt editor's view: the textarea `usePromptEditor` drives, and whichever completion
 * picker it has open. Everything the element does comes from the editor; the only things a
 * caller adds are what the surrounding composer owns - the placeholder, and image pastes, which
 * belong to the attachment strip rather than the text.
 */
export default function PromptTextarea(props: {
  editor: PromptEditor
  placeholder: string
  onPaste?(event: ClipboardEvent<HTMLTextAreaElement>): void
  /** Fires on every edit the captain makes by hand, for notices that should clear once they type on. */
  onEdit?(): void
}): JSX.Element {
  const { editor } = props
  return (
    <>
      <textarea
        ref={editor.textareaRef}
        rows={1}
        {...editor.textarea}
        onChange={(event) => {
          editor.textarea.onChange(event)
          props.onEdit?.()
        }}
        placeholder={props.placeholder}
        onPaste={props.onPaste}
      />
      {editor.picker && <CompletionMenu anchorRef={editor.textareaRef} picker={editor.picker} />}
    </>
  )
}

/**
 * The editor's completion list, shared by the slash-command and `@`-mention pickers. Like the
 * node's selector pickers it portals to `<body>` and positions itself in JS against its anchor's
 * viewport rect - `.terminal-node` clips overflow, so a CSS-anchored menu would be cut off the
 * moment the node sits near a canvas edge. It opens above the textarea by preference, since the
 * composer already sits at the bottom of its node.
 */
function CompletionMenu(props: { anchorRef: RefObject<HTMLElement>; picker: PromptEditorPicker }): JSX.Element {
  const { picker } = props
  const menuRef = useRef<HTMLDivElement>(null)
  const position = usePortalMenuPosition(
    props.anchorRef,
    menuRef,
    true,
    { width: 320, height: 0 },
    { align: 'start', prefer: 'above' },
    picker.options
  )

  // The active row has to stay visible while the arrows walk past the menu's scroll bounds.
  useLayoutEffect(() => {
    const active = menuRef.current?.querySelector('[data-active="true"]')
    // Guarded: jsdom (and any non-layout host) has no scrollIntoView, and this is pure polish.
    if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [picker.activeIndex, picker.options])

  return createPortal(
    <div
      ref={menuRef}
      id={picker.id}
      className={`node-picker-menu ${picker.className}`}
      role="listbox"
      aria-label={picker.label}
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {picker.options.map((option, index) => (
        <button
          type="button"
          role="option"
          id={picker.optionId(index)}
          key={option.key}
          aria-selected={index === picker.activeIndex}
          data-active={index === picker.activeIndex}
          onMouseEnter={() => picker.highlight(index)}
          onClick={() => picker.accept(index)}
        >
          <strong>
            <span>{option.label}</span>
            {option.hint && <em className="slash-command-hint">{option.hint}</em>}
          </strong>
          {option.description && <span>{option.description}</span>}
        </button>
      ))}
      {picker.note && <small className="completion-menu-note">{picker.note}</small>}
    </div>,
    document.body
  )
}
