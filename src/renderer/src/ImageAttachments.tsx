import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import {
  imageAttachmentSource,
  isSaveableImage,
  unavailableImageNote,
  type AgentImageAttachment
} from './image-attachment'

/**
 * The images a conversation entry carries - pasted into a prompt, or produced by the agent as tool
 * output or an assistant content block - as clickable thumbnails. A chat node is `overflow: hidden`
 * and only a few hundred pixels wide, so a thumbnail is never the readable copy: it is the handle
 * onto `ImageAttachmentViewer`, which is why each one is a button rather than an image with a
 * pointer cursor. The open image is tracked by index so the viewer can walk the whole set without
 * every thumbnail owning viewer state of its own.
 *
 * An image with no bytes, or in a type the browser cannot decode, is *named* rather than painted.
 * Rendering it anyway would produce a broken frame with no explanation, which is the same silence
 * as the missing generated image of issue #174 - so `unavailableImageNote` answers for it, and it
 * is left out of the viewer's walk, which has nothing to show for it.
 *
 * `label` is what the reader is told these images are; it names both the thumbnail and the viewer.
 */
export function ImageAttachments(props: { images: AgentImageAttachment[]; label?: string }): JSX.Element | null {
  const label = props.label ?? 'Attached image'
  // Every image keeps the number of the slot the agent produced it in, whether it paints or not:
  // numbering only the ones that paint would call the second picture "1" as soon as the first was
  // a type the browser refuses, which is the ordering AC3 of #174 asks to hold.
  const entries = props.images.map((image, position) => ({ image, position, note: unavailableImageNote(image) }))
  const shown = entries.filter((entry) => entry.note === null)
  const [viewing, setViewing] = useState<number | null>(null)
  // The thumbnail that opened the viewer, so closing it returns focus there rather than dropping
  // the reader on `<body>` and costing the chat node its keyboard context.
  const opener = useRef<HTMLButtonElement | null>(null)
  const close = (): void => {
    setViewing(null)
    opener.current?.focus()
  }
  if (entries.length === 0) return null
  return (
    <div className="message-attachments">
      {entries.map((entry) =>
        entry.note === null ? (
          <button
            type="button"
            className="message-attachment"
            key={entry.image.id}
            aria-label={`View ${label.toLowerCase()} ${entry.position + 1}`}
            onClick={(event) => {
              opener.current = event.currentTarget
              setViewing(shown.findIndex((candidate) => candidate.image.id === entry.image.id))
            }}
          >
            <img src={imageAttachmentSource(entry.image)} alt={`${label} ${entry.position + 1}`} />
          </button>
        ) : (
          <p className="message-attachment-unavailable" key={entry.image.id}>
            {entry.note}
            {/* The note tells an undecodable image's reader to save it and open it elsewhere, so
                the save has to be here: there is no thumbnail to enlarge, and a sentence naming
                an action nothing offers is its own kind of silence. */}
            {isSaveableImage(entry.image) && (
              <SaveImageButton image={entry.image} label={label} position={entry.position} />
            )}
          </p>
        )
      )}
      {viewing !== null && shown[viewing] && (
        <ImageAttachmentViewer
          images={shown.map((entry) => entry.image)}
          positions={shown.map((entry) => entry.position)}
          index={viewing}
          label={label}
          onIndex={setViewing}
          onClose={close}
        />
      )}
    </div>
  )
}

/**
 * Save, and the verdict of the last attempt beside it. Both the viewer and an unavailable image's
 * note offer it, so the wording of a refusal - and the fact that a click always produces one - is
 * decided once. A refusal that only reached a log would leave the click looking like a no-op.
 */
function SaveImageButton(props: { image: AgentImageAttachment; label: string; position: number }): JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    const result = await window.terminalApi.saveImage({
      data: props.image.data,
      mimeType: props.image.mimeType,
      suggestedName: `${props.label.toLowerCase().replace(/\s+/g, '-')}-${props.position + 1}`
    })
    setNote(result.status === 'saved' ? `Saved to ${result.path}` : result.status === 'refused' ? result.message : null)
  }
  return (
    <>
      <button type="button" className="image-save" onClick={() => void save()}>
        Save image
      </button>
      {note && <span className="image-save-note">{note}</span>}
    </>
  )
}

/**
 * Full-size view of one image. It portals to `<body>` for the same reason the node's pickers do -
 * `.terminal-node` clips its overflow, and a lightbox confined to a chat bubble would defeat the
 * point - and it is deliberately transient, unpersisted UI: Escape, the backdrop, and the close
 * button all dismiss it.
 *
 * Save is here rather than on the thumbnail because this is where the image is actually being
 * looked at, and it is the only way an agent-generated picture becomes the reader's to keep: where
 * a provider put its own copy is provider-private, so a prose path is not something to depend on
 * (issue #174). The bytes go to main, which writes them wherever the user's save dialog points.
 *
 * Keys are handled on the container, not on `window`, and focus is moved into it on open, the
 * same way the brain-dump dialogs do it: a portal's events still bubble through the React tree,
 * so a chat node's own Escape (dismiss a completion menu, cancel a turn) would otherwise fire
 * alongside this one, and only `stopPropagation` on the way up can stop it.
 */
export function ImageAttachmentViewer(props: {
  images: AgentImageAttachment[]
  /** Each image's slot in the whole set, so a walk names it the way the strip did. */
  positions?: number[]
  index: number
  label?: string
  onIndex(index: number): void
  onClose(): void
}): JSX.Element | null {
  const { images, index, onIndex, onClose } = props
  const label = props.label ?? 'Attached image'
  const position = props.positions?.[index] ?? index
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
      aria-label={`${label} ${position + 1}`}
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
          {isSaveableImage(image) && (
            <span className="image-viewer-save" key={image.id}>
              <SaveImageButton image={image} label={label} position={position} />
            </span>
          )}
          <button type="button" aria-label="Close image viewer" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <img src={imageAttachmentSource(image)} alt={`${label} ${position + 1}, full size`} />
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
