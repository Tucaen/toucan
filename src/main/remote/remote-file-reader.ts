import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isRemoteFetchablePath, REMOTE_FILE_BYTE_LIMIT, remoteImageContentType } from '../../shared/remote-file'

export type RemoteFileRead =
  { ok: true; data: Buffer; contentType: string } | { ok: false; status: 400 | 403 | 404 | 413; message: string }

export interface RemoteFileReaderOptions {
  /** The workspace containment rule every privileged path operation passes. */
  contains(path: string): Promise<boolean>
  byteLimit?: number
}

/**
 * `GET /api/file`: the bytes of one local image, for a phone that tapped a link to it.
 *
 * This is the first thing a paired device can read off the desktop's disk, so the gates run in an
 * order that keeps every refusal cheap and uninformative. Shape and kind are settled on the string
 * alone, before the filesystem is touched - which is what keeps a UNC path from making the host
 * dial out (see `remote-file.ts`). Containment comes next, and only a path already inside the
 * workspace is ever `stat`ed, so whether a file exists *outside* it is not something a caller can
 * learn. No refusal echoes the path back.
 */
export function createRemoteFileReader(options: RemoteFileReaderOptions): (path: string) => Promise<RemoteFileRead> {
  const byteLimit = options.byteLimit ?? REMOTE_FILE_BYTE_LIMIT
  return async (path: string): Promise<RemoteFileRead> => {
    if (!isRemoteFetchablePath(path)) {
      return { ok: false, status: 400, message: 'Only absolute paths to files on this desktop can be opened.' }
    }
    const contentType = remoteImageContentType(path)
    if (!contentType) {
      return { ok: false, status: 400, message: 'Only images can be opened on the phone.' }
    }
    const resolved = resolve(path)
    if (!(await options.contains(resolved))) {
      return { ok: false, status: 403, message: 'This file is outside every project and worktree on the desktop.' }
    }
    try {
      const info = await stat(resolved)
      if (!info.isFile()) return { ok: false, status: 404, message: 'This image is not on the desktop any more.' }
      if (info.size > byteLimit) return { ok: false, status: 413, message: 'This image is too large to send.' }
      const data = await readFile(resolved)
      // Checked again on what was read: the file may have grown between the two calls.
      if (data.byteLength > byteLimit) return { ok: false, status: 413, message: 'This image is too large to send.' }
      return { ok: true, data, contentType }
    } catch {
      return { ok: false, status: 404, message: 'This image is not on the desktop any more.' }
    }
  }
}
