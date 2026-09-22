/**
 * The contract for saving one transcript image to a file the user picks - the shape both sides of
 * the privilege seam agree on, mirroring how `local-file-link.ts` holds the open contract for
 * `main/local-file-open.ts`.
 *
 * An agent-generated image reaches Toucan as base64 bytes on a tool call or an assistant message,
 * and where the provider put its own copy is provider-private: a path the agent may mention in
 * prose, or may not. Depending on that prose is exactly what left a reader with a picture they
 * could see and no way to keep (issue #174), so the artifact the user takes away is written from
 * the bytes the transcript already holds. The write itself is `main/image-save.ts`.
 */

/** What the renderer hands over: the image's own bytes and a name stem to suggest. */
export interface ImageArtifactSaveRequest {
  /** Base64-encoded bytes, without the `data:` URL prefix. */
  data: string
  mimeType: string
  /** The stem the save dialog opens on; the extension comes from `mimeType`. */
  suggestedName: string
}

export type ImageArtifactSaveResult =
  { status: 'saved'; path: string } | { status: 'cancelled' } | { status: 'refused'; message: string }

/**
 * A ceiling on what one save may carry across the seam. Generated images run to a few megabytes;
 * anything past this is a renderer sending something that is not an image, and decoding it first
 * to find that out is the expensive way to learn it.
 * @internal exported for tests
 */
export const MAX_IMAGE_ARTIFACT_BYTES = 64 * 1024 * 1024

/**
 * The same ceiling expressed in base64 characters, which is what actually crosses the seam. Base64
 * inflates by 4/3, so comparing the encoded length straight against a byte cap would quietly
 * refuse a quarter of the images the cap is supposed to allow - and the cheap check has to happen
 * before the decode, which is the cost it exists to avoid.
 */
export const MAX_IMAGE_ARTIFACT_BASE64_LENGTH = Math.ceil(MAX_IMAGE_ARTIFACT_BYTES / 3) * 4

const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff'],
  ['image/heic', 'heic'],
  ['image/x-icon', 'ico'],
  ['image/svg+xml', 'svg']
])

/**
 * The file name the dialog opens on. An unrecognized media type still saves - the bytes are the
 * point and the user may know what they are - but it gets `.bin` rather than a guessed extension,
 * because naming a file `.png` that is not one is worse than naming it nothing in particular.
 */
export function imageArtifactFileName(suggestedName: string, mimeType: string): string {
  const stem = suggestedName.replace(/[\\/:*?"<>|]/g, '').trim() || 'image'
  return `${stem}.${IMAGE_EXTENSIONS.get(mimeType.trim().toLowerCase()) ?? 'bin'}`
}
