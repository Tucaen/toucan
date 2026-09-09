import {
  imageArtifactFileName,
  MAX_IMAGE_ARTIFACT_BASE64_LENGTH,
  type ImageArtifactSaveRequest,
  type ImageArtifactSaveResult
} from '../shared/image-artifact'

/**
 * Writing one transcript image out to a file the user picks (contract and reasoning in
 * `shared/image-artifact.ts`). Electron's dialog and the write are injected, so every decision
 * here - what may be saved and how a refusal is worded - runs under test without a window.
 */

export type ImageArtifactBytes = { ok: true; bytes: Buffer } | { ok: false; message: string }

/**
 * The bytes a save request actually carries, or a refusal saying why there are none. Node's
 * base64 decoder silently skips anything outside the alphabet rather than throwing, so an empty
 * result is the only signal that the payload was not base64 at all.
 */
export function imageArtifactBytes(request: ImageArtifactSaveRequest): ImageArtifactBytes {
  if (!request.data)
    return { ok: false, message: 'That image was not included in the reply, so there is nothing to save.' }
  if (request.data.length > MAX_IMAGE_ARTIFACT_BASE64_LENGTH)
    return { ok: false, message: 'That image is too large to save.' }
  const bytes = Buffer.from(request.data, 'base64')
  return bytes.length > 0 ? { ok: true, bytes } : { ok: false, message: 'That image could not be decoded.' }
}

export interface ImageArtifactSaverDependencies {
  /** The OS save dialog, owned by the asking window; null when the user cancelled. */
  showSaveDialog(sender: unknown, defaultName: string): Promise<string | null>
  writeFile(path: string, bytes: Buffer): Promise<void>
}

export function createImageArtifactSaver(
  deps: ImageArtifactSaverDependencies
): (sender: unknown, request: ImageArtifactSaveRequest) => Promise<ImageArtifactSaveResult> {
  return async (sender, request) => {
    const decoded = imageArtifactBytes(request)
    if (!decoded.ok) return { status: 'refused', message: decoded.message }
    const path = await deps.showSaveDialog(sender, imageArtifactFileName(request.suggestedName, request.mimeType))
    if (!path) return { status: 'cancelled' }
    try {
      await deps.writeFile(path, decoded.bytes)
    } catch (error) {
      return { status: 'refused', message: error instanceof Error ? error.message : String(error) }
    }
    return { status: 'saved', path }
  }
}
