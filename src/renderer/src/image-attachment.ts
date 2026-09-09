import type { AgentImageAttachment } from './image-attachment-contract'

export type { AgentImageAttachment } from './image-attachment-contract'

/** Reads a pasted image `Blob` into the base64 payload an ACP `image` content block needs. */
export function readImageAsBase64(blob: Blob): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Could not read the pasted image.'))
        return
      }
      resolve({ data: result.slice(result.indexOf(',') + 1), mimeType: blob.type })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the pasted image.'))
    reader.readAsDataURL(blob)
  })
}

/** Pulls the image files out of a clipboard paste event's `items`, ignoring any non-image content. */
export function imageFilesFromClipboard(items: DataTransferItemList | undefined | null): File[] {
  if (!items) return []
  const files: File[] = []
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

/** The `data:` URL an attachment renders as - the only shape an `<img src>` can take here. */
export function imageAttachmentSource(image: AgentImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`
}

/**
 * The media types a chat surface will actually paint. An `<img>` is deliberately the only way an
 * image reaches the DOM here, which is what makes SVG safe to include: a browser renders an SVG
 * loaded as an image with scripting and external references disabled, unlike handing the file to
 * the OS, which is why `opensInSystemViewer` refuses one and this does not.
 *
 * Anything outside the list is named rather than painted. A `<img>` pointed at a type the browser
 * cannot decode renders as a broken frame with no explanation - which is the same silence issue
 * #174 was about, one step further along.
 */
const RENDERABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml'
])

/**
 * Why this image is not on screen, or `null` when it is going to be. Both halves of the answer
 * live here so every surface that shows images - a sent message, a tool card - explains the same
 * absence in the same words instead of rendering an empty frame.
 */
export function unavailableImageNote(image: AgentImageAttachment): string | null {
  if (!image.data)
    return image.uri
      ? `The image was not included in the reply. It lives at ${image.uri}.`
      : 'The image was not included in the reply.'
  return RENDERABLE_IMAGE_TYPES.has(image.mimeType.trim().toLowerCase())
    ? null
    : `Toucan cannot display ${image.mimeType.trim() || 'this image type'}. Save it to open it elsewhere.`
}

/** Whether this image has bytes worth offering a save for; a bare reference has nothing to write. */
export function isSaveableImage(image: AgentImageAttachment): boolean {
  return image.data.length > 0
}
