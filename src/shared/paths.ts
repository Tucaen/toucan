/**
 * Path questions every process asks the same way. Pure string work, because the renderer has no
 * `node:path` and the answers must not differ between it and main.
 */

/** Absolute in either flavour: a leading separator, or a Windows drive or UNC prefix. */
export function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:|[\\/])/.test(value)
}
