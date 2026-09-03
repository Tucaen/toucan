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
