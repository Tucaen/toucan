import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { imageAttachmentSource, type AgentImageAttachment } from './image-attachment'

/**
 * The images a message (or a still-queued prompt) carries, as clickable thumbnails. A chat node
 * is `overflow: hidden` and only a few hundred pixels wide, so a thumbnail is never the readable
 * copy - it is the handle onto `ImageAttachmentViewer`, which is why each one is a button rather
 * than an image with a pointer cursor. The open image is tracked by index so the viewer can walk
 * the whole set without every thumbnail owning viewer state of its own.
 */
export function ImageAttachments(props: { images: AgentImageAttachment[] }): JSX.Element | null {
  const [viewing, setViewing] = useState<number | null>(null)
  // The thumbnail that opened the viewer, so closing it returns focus there rather than dropping
  // the reader on `<body>` and costing the chat node its keyboard context.
  const opener = useRef<HTMLButtonElement | null>(null)
  const close = (): void => {
    setViewing(null)
    opener.current?.focus()
  }
  if (props.images.length === 0) return null
  return (
    <div className="message-attachments">
      {props.images.map((image, index) => (
        <button
          type="button"
          className="message-attachment"
          key={image.id}
          aria-label={`View attached image ${index + 1}`}
          onClick={(event) => {
            opener.current = event.currentTarget
            setViewing(index)
          }}
        >
          <img src={imageAttachmentSource(image)} alt={`Attached image ${index + 1}`} />
        </button>
      ))}
      {viewing !== null && (
        <ImageAttachmentViewer images={props.images} index={viewing} onIndex={setViewing} onClose={close} />
      )}
    </div>
  )
}

/**
 * Full-size view of one attached image. It portals to `<body>` for the same reason the node's
 * pickers do - `.terminal-node` clips its overflow, and a lightbox confined to a chat bubble
 * would defeat the point - and it is deliberately transient, unpersisted UI: Escape, the
 * backdrop, and the close button all dismiss it.
 *
 * Keys are handled on the container, not on `window`, and focus is moved into it on open, the
 * same way the brain-dump dialogs do it: a portal's events still bubble through the React tree,
 * so a chat node's own Escape (dismiss a completion menu, cancel a turn) would otherwise fire
 * alongside this one, and only `stopPropagation` on the way up can stop it.
 */
export function ImageAttachmentViewer(props: {
  images: AgentImageAttachment[]
  index: number
  onIndex(index: number): void
  onClose(): void
}): JSX.Element | null {
  const { images, index, onIndex, onClose } = props
  const multiple = images.length > 1
  const step = (delta: number): void => onIndex((index + delta + images.length) % images.length)
  const backdrop = useRef<HTMLDivElement>(null)
  // Focus moves in on open so the container's key handling is reachable at all; putting it back
  // is the opener's job (see `ImageAttachments`), not a cleanup that could only guess.
  useEffect(() => {
    backdrop.current?.focus()
  }, [])

  const image = images[index]
  if (!image) return null
  return createPortal(
    <div
      ref={backdrop}
      tabIndex={-1}
      className="image-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Attached image ${index + 1}`}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        } else if (multiple && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
          event.stopPropagation()
          step(event.key === 'ArrowRight' ? 1 : -1)
        }
      }}
    >
      <div className="image-viewer" onClick={(event) => event.stopPropagation()}>
        <header>
          {multiple && <span className="image-viewer-count">{`${index + 1} of ${images.length}`}</span>}
          <button type="button" aria-label="Close image viewer" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <img src={imageAttachmentSource(image)} alt={`Attached image ${index + 1}, full size`} />
        {multiple && (
          <footer>
            <button type="button" aria-label="Previous image" onClick={() => step(-1)}>
              Previous
            </button>
            <button type="button" aria-label="Next image" onClick={() => step(1)}>
              Next
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body
  )
}
