import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  centerSquareCrop,
  PROJECT_AVATAR_PIXEL_SIZE,
  projectAvatarFileName,
  type ProjectAvatarCropRect,
  type ProjectAvatarSetResult
} from '../shared/project-avatar'
import { writeSnapshotAtomically } from './durable-file'

/**
 * Owns the on-disk copy of every custom project avatar (contract and reasoning in
 * `shared/project-avatar.ts`): one normalized PNG per project id under its own directory in
 * `userData`. The OS file picker and the image codec are injected, so every decision here - what
 * is refused and how, what a stored file is named, what a read returns - runs under tests without
 * Electron.
 *
 * Writes deliberately carry no serial queue: each set is a single atomic temp-write-then-rename,
 * and sets are user gestures behind a modal picker, so two can never race the same file mid-write.
 */

/** A successfully decoded source image; `nativeImage` in production. */
export interface DecodedAvatarSource {
  width: number
  height: number
  /** Crops to `rect`, resizes to an `edge`-pixel square, and encodes PNG bytes. */
  toPng(rect: ProjectAvatarCropRect, edge: number): Buffer
}

export interface ProjectAvatarStoreDependencies {
  /** Where the normalized files live; created on the first write. */
  directory: string
  /** The OS image picker owned by the asking window; null when the user cancels. */
  pickImageFile(sender: unknown): Promise<string | null>
  /** Decodes one image file; null when the bytes are not a decodable image. */
  decodeImage(path: string): Promise<DecodedAvatarSource | null>
}

export interface ProjectAvatarStore {
  choose(sender: unknown, projectId: string): Promise<ProjectAvatarSetResult>
  read(projectId: string): Promise<string | null>
  remove(projectId: string): Promise<void>
}

export function createProjectAvatarStore(deps: ProjectAvatarStoreDependencies): ProjectAvatarStore {
  const filePath = (projectId: string): string | null => {
    const name = projectAvatarFileName(projectId)
    return name ? join(deps.directory, name) : null
  }
  // The version's one job is to differ on every successful set so renderer caches re-read after a
  // replacement. Wall-clock time is almost that, except two sets in one millisecond; the floor
  // keeps it strictly increasing regardless.
  let lastVersion = 0

  return {
    async choose(sender, projectId) {
      const target = filePath(projectId)
      if (!target) return { status: 'refused', message: 'That project cannot store an avatar.' }
      const picked = await deps.pickImageFile(sender)
      if (!picked) return { status: 'cancelled' }
      const source = await deps.decodeImage(picked)
      if (!source || source.width < 1 || source.height < 1)
        return { status: 'refused', message: 'That file could not be read as an image.' }
      let bytes: Buffer
      try {
        bytes = source.toPng(centerSquareCrop(source.width, source.height), PROJECT_AVATAR_PIXEL_SIZE)
      } catch (error) {
        return { status: 'refused', message: error instanceof Error ? error.message : String(error) }
      }
      if (bytes.length === 0) return { status: 'refused', message: 'That image could not be converted.' }
      try {
        await mkdir(deps.directory, { recursive: true })
        await writeSnapshotAtomically(target, bytes)
      } catch (error) {
        return { status: 'refused', message: error instanceof Error ? error.message : String(error) }
      }
      lastVersion = Math.max(Date.now(), lastVersion + 1)
      return { status: 'set', version: lastVersion }
    },

    async read(projectId) {
      const target = filePath(projectId)
      if (!target) return null
      try {
        const bytes = await readFile(target)
        return bytes.length > 0 ? `data:image/png;base64,${bytes.toString('base64')}` : null
      } catch {
        return null
      }
    },

    async remove(projectId) {
      const target = filePath(projectId)
      if (!target) return
      await rm(target, { force: true }).catch(() => {})
    }
  }
}
