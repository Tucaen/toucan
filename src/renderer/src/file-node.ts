import type { FileReadFailure } from '../../shared/file-view'

/**
 * The decisions behind the file node that are worth pinning down without a DOM: how a picked
 * relative path becomes the absolute one the node records, how a failure reads, and where raw
 * highlighting gives up so a huge file still opens.
 */

/**
 * Past this many lines the raw view shows plain text: tokenising a whole log through lowlight
 * would freeze the renderer for longer than the reader would wait, and colour on line 30,000 is
 * not what anyone opened it for.
 */
export const RAW_HIGHLIGHT_LINE_LIMIT = 2000

/**
 * The picker lists paths relative to a root with forward slashes, whatever the platform; the node
 * stores the absolute path in the root's own separator so Copy path yields something the reader
 * can paste into a Windows shell unchanged.
 */
export function joinWorkspacePath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const segments = relativePath.split('/').filter(Boolean)
  return [trimmedRoot, ...segments].join(separator)
}

/**
 * Which project a file opened from a transcript card belongs to: the one whose checkout or
 * worktree contains it, and when roots nest, the deepest - a project inside another project's
 * folder owns its own files. Comparison is separator- and case-insensitive, like
 * `shortenFilePath`, because paths from adapters and from the snapshot differ in both.
 */
export function projectOwningPath(
  path: string,
  roots: readonly { projectId: string; root: string }[]
): string | undefined {
  const haystack = path.replace(/\\/g, '/').toLowerCase()
  let best: { projectId: string; length: number } | undefined
  for (const { projectId, root } of roots) {
    const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!prefix || !haystack.startsWith(`${prefix}/`)) continue
    if (!best || prefix.length > best.length) best = { projectId, length: prefix.length }
  }
  return best?.projectId
}

/** The file name alone, for the node's header. */
export function fileNodeName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.at(-1) ?? path
}

export function describeFileReadFailure(reason: FileReadFailure, message: string): string {
  switch (reason) {
    case 'not-found':
      return 'This file is not on disk any more. The node stays so your layout does; close it when you are done.'
    case 'outside-workspace':
      return 'This file is outside every project and worktree in the workspace, so Toucan does not read it.'
    case 'directory':
      return 'This path is a folder, not a file.'
    case 'unreadable':
      return message || 'This file could not be read.'
  }
}

/** Lines for the raw view. A trailing newline does not make an extra empty line. */
export function rawFileLines(content: string): string[] {
  const lines = content.split(/\r?\n/)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}
