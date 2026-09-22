import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * The one answer to "may the renderer touch this path at all": it is inside a registered project
 * checkout or worktree, or it is refused. Every privileged path operation the renderer can ask
 * for - reading a file node's bytes, saving an edit, handing an artifact to the OS viewer - fails
 * closed through here, so a hand-edited snapshot, a stray link or a Markdown link an agent wrote
 * cannot turn any of them into a reader of arbitrary files.
 *
 * Roots are read per call rather than cached, so a project added a moment ago is already usable.
 */
export interface WorkspaceContainmentOptions {
  /** Every registered project checkout and every worktree. */
  roots(): readonly string[] | Promise<readonly string[]>
  /** Windows compares paths case-insensitively; the default follows the platform. */
  caseInsensitivePaths?: boolean
}

export interface WorkspaceContainment {
  /** The path in the one form both sides of a containment check are compared in. */
  comparable(path: string): string
  /**
   * The path as the filesystem knows it, so a link inside a checkout cannot point elsewhere.
   *
   * `realpath` only answers for a path that already exists, and the paths that matter most here
   * often do not: a file that was deleted under a node, or a name a save is about to create. So
   * the deepest ancestor that *does* exist is canonicalized and the rest re-attached, which keeps
   * both sides of the containment check in the same form. Comparing a canonical root against a
   * literal target reads as climbing out of the workspace whenever a project is reached through a
   * junction, a symlink or an 8.3 short path - and, the other way round, it used to let a write to
   * a not-yet-existing name through a link that leaves the workspace entirely.
   */
  realPathOf(path: string): Promise<string>
  contains(path: string): Promise<boolean>
}

export function createWorkspaceContainment(options: WorkspaceContainmentOptions): WorkspaceContainment {
  const caseInsensitive = options.caseInsensitivePaths ?? process.platform === 'win32'
  const comparable = (path: string): string => (caseInsensitive ? path.toLowerCase() : path)

  const realPathOf = async (path: string): Promise<string> => {
    let head = resolve(path)
    const tail: string[] = []
    for (;;) {
      try {
        return join(await realpath(head), ...tail)
      } catch {
        const parent = dirname(head)
        // A filesystem root that does not resolve leaves nothing above it to ask about.
        if (parent === head) return resolve(path)
        tail.unshift(basename(head))
        head = parent
      }
    }
  }

  const contains = async (path: string): Promise<boolean> => {
    if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !isAbsolute(path)) return false
    const target = comparable(await realPathOf(resolve(path)))
    for (const root of await options.roots()) {
      // An empty relative path means the target *is* the root, which is inside the workspace: the
      // caller then refuses it for what it is (a folder), not as an escape attempt.
      const between = relative(comparable(await realPathOf(resolve(root))), target)
      if (!between.startsWith('..') && !isAbsolute(between)) return true
    }
    return false
  }

  return { comparable, realPathOf, contains }
}
