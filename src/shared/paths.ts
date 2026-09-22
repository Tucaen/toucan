/**
 * Path questions every process asks the same way. Pure string work, because the renderer has no
 * `node:path` and the answers must not differ between it and main.
 */

/** Absolute in either flavour: a leading separator, or a Windows drive or UNC prefix. */
export function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:|[\\/])/.test(value)
}

/**
 * The comparable form of a path: the one answer to "are these two strings the same file?".
 * Separators, separator runs and, on Windows, case are all free to differ between the two ends of
 * any comparison - a watcher event and a node's path, a tool call's location and a folder listing,
 * a topic's `project` frontmatter and a registered checkout - and the same file must still be
 * recognised as one.
 *
 * **Not a containment check.** This answers equality between two strings and nothing more; it
 * resolves no links and no `..` segments, so it can never decide whether a path is *inside* a
 * workspace root. That question is `createWorkspaceContainment` in `main/workspace-containment.ts`,
 * which canonicalizes through `realpath` because it guards a privilege boundary - and the two read
 * alike at a call site, which is exactly why this says so here.
 *
 * The locale is pinned rather than left to the host: `toLocaleLowerCase()` without one uses the
 * host locale, and under a Turkish default `I` lowercases to `ı`, which would stop two spellings
 * of one drive letter matching. A leading UNC pair survives the separator collapse, because `//host/share`
 * flattened to `/host/share` is a different path that a POSIX absolute one could collide with.
 */
function normalizedPathShape(path: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path)
  const normalized = (unc ? '//' : '') + path.slice(unc ? 2 : 0).replace(/[\\/]+/g, '/')
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

export function pathIdentity(path: string): string {
  const normalized = normalizedPathShape(path)
  return /^(?:[a-z]:|\/\/[^/])/i.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized
}

/**
 * The part of `path` below `root`, in forward-slash form; `''` when both name the root itself,
 * and `undefined` when the path is outside it. This is display/string containment only: like
 * `pathIdentity`, it deliberately resolves neither links nor `..` segments.
 */
export function pathWithinRoot(path: string, root: string): string | undefined {
  const normalizedPath = normalizedPathShape(path)
  const normalizedRoot = normalizedPathShape(root)
  const pathKey = pathIdentity(normalizedPath)
  const rootKey = pathIdentity(normalizedRoot)
  if (pathKey === rootKey) return ''
  const prefix = rootKey === '/' ? rootKey : `${rootKey}/`
  if (!pathKey.startsWith(prefix)) return undefined
  return normalizedPath.slice(normalizedRoot === '/' ? 1 : normalizedRoot.length + 1)
}
