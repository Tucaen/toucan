import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { opensInSystemViewer, type LocalFileOpenResult } from '../shared/local-file-link'

export interface LocalFileOpenOptions {
  /** The workspace containment rule; a path it refuses is never opened. */
  contains(path: string): Promise<boolean>
  /** Electron's `shell.openPath`: resolves to `''` on success, or to a message saying why not. */
  openPath(path: string): Promise<string>
}

/**
 * Opening a local artifact - the image an agent just generated, the PDF it exported - with the
 * application the OS associates with it. This is the one path action that can *run* something, so
 * it is doubly narrow: the file must resolve inside a registered project or worktree (the same
 * `workspace-containment` gate a file-node read passes), and it must be one of the inert media
 * kinds `opensInSystemViewer` names, so a `.bat` or a `.js` a link points at opens as a file node
 * upstream instead of being executed here. The renderer already makes both decisions; this side
 * makes them again, because a renderer is not what a privilege boundary may trust.
 *
 * Every refusal names itself. A link that quietly does nothing is what issue #175 was.
 */
export function createLocalFileOpener(options: LocalFileOpenOptions): (path: string) => Promise<LocalFileOpenResult> {
  return async (path: string): Promise<LocalFileOpenResult> => {
    if (!path.trim()) {
      return { ok: false, reason: 'not-found', message: 'That link does not name a file.' }
    }
    const resolved = resolve(path)
    if (!(await options.contains(resolved))) {
      return {
        ok: false,
        reason: 'outside-workspace',
        message: 'This file is outside every project and worktree in the workspace, so it was not opened.'
      }
    }
    if (!opensInSystemViewer(resolved)) {
      return {
        ok: false,
        reason: 'unsupported-type',
        message: 'Toucan only hands images, documents and media to the system viewer.'
      }
    }
    try {
      if ((await stat(resolved)).isDirectory()) {
        return { ok: false, reason: 'directory', message: 'This path is a folder, not a file.' }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ok: false, reason: 'not-found', message: 'This file is not on disk any more.' }
      }
      return { ok: false, reason: 'unopenable', message: (error as Error).message }
    }
    const problem = await options.openPath(resolved)
    return problem ? { ok: false, reason: 'unopenable', message: problem } : { ok: true }
  }
}
