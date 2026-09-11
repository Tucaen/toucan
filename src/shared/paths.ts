/**
 * Path questions every process asks the same way. Pure string work, because the renderer has no
 * `node:path` and the answers must not differ between it and main.
 */

/** Absolute in either flavour: a leading separator, or a Windows drive or UNC prefix. */
export function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:|[\\/])/.test(value)
}

/**
 * The comparable form of a path. Separators and, on Windows, case are free to differ between the
 * two ends of any comparison - a watcher event and a node's path, a tool call's location and a
 * folder listing - and the same file must still be recognised as one.
 */
export function pathIdentity(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
