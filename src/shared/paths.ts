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
 * The locale is pinned rather than left to the host: `toLowerCase()` is locale-sensitive, and
 * under a Turkish default `I` lowercases to `ı`, which would stop two spellings of one drive
 * letter matching. A leading UNC pair survives the separator collapse, because `//host/share`
 * flattened to `/host/share` is a different path that a POSIX absolute one could collide with.
 */
export function pathIdentity(path: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path)
  return (
    (unc ? '//' : '') +
    path
      .slice(unc ? 2 : 0)
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLocaleLowerCase('en-US')
  )
}
