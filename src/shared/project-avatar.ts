/**
 * Custom project avatar images: the contract between the settings dialog, preload, and the
 * main-process store.
 *
 * An avatar is uploaded, never referenced: the picked file is decoded, center-cropped square,
 * resized to `PROJECT_AVATAR_PIXEL_SIZE` and re-encoded as PNG into the app's own storage, so a
 * source file that later moves or changes cannot break the sidebar, and re-encoding strips
 * anything a foreign image file may carry beyond pixels. The sidebar chip is a fixed 28px square
 * rendered with `object-fit: cover`, so no source resolution can alter layout - the resize is for
 * crispness on HiDPI displays and file size, not for the layout's sake.
 */

/** Stored edge length in pixels: 28px chip at up to ~4x device pixel ratio. */
export const PROJECT_AVATAR_PIXEL_SIZE = 128

export interface ProjectAvatarCropRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The largest centered square inside a `width` x `height` image. Odd remainders lean toward the
 * top-left, matching what an integer pixel crop can address.
 */
export function centerSquareCrop(width: number, height: number): ProjectAvatarCropRect {
  const edge = Math.max(1, Math.min(width, height))
  return {
    x: Math.max(0, Math.floor((width - edge) / 2)),
    y: Math.max(0, Math.floor((height - edge) / 2)),
    width: edge,
    height: edge
  }
}

/**
 * The stored file's name for a project id. Project ids are app-generated UUIDs, but the id
 * crosses the IPC seam to name a file, so anything outside a conservative alphabet is dropped
 * rather than trusted - an id that sanitizes to nothing names no file at all.
 */
export function projectAvatarFileName(projectId: string): string | null {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '')
  return safe ? `${safe}.png` : null
}

export type ProjectAvatarSetResult =
  { status: 'set'; version: number } | { status: 'cancelled' } | { status: 'refused'; message: string }

/** Renderer-facing contract, implemented in preload against the `project:avatar-*` channels. */
export interface ProjectAvatarApi {
  /** Opens the OS image picker, then normalizes and stores the choice for `projectId`. */
  choose(projectId: string): Promise<ProjectAvatarSetResult>
  /** The stored avatar as a `data:image/png` URL, or null when the project has none. */
  read(projectId: string): Promise<string | null>
  remove(projectId: string): Promise<void>
}
