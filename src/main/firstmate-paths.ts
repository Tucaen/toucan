/**
 * The single main-process definition of canonical Windows paths and their Windows-to-WSL conversion.
 * ADE owns this mapping here; the renderer never derives a WSL path, it consumes the registered one.
 */

/** Normalizes a selected path to `X:\segment\segment`, or null when it is not a drive-rooted path. */
export function firstMateCanonicalWindowsPath(path: string): string | null {
  const trimmed = path.trim()
  if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) return null
  const drive = trimmed[0].toUpperCase()
  const rest = trimmed.slice(3).replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`
}

/** Converts an already-canonical Windows path to the `/mnt/<drive>/...` form the WSL host mounts. */
export function firstMateWslPath(canonicalWindowsPath: string): string {
  const drive = canonicalWindowsPath[0].toLocaleLowerCase()
  const rest = canonicalWindowsPath.slice(3).replace(/\\/g, '/')
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
}

/** Canonicalizes then converts an arbitrary Windows path, or undefined when it is not drive-rooted. */
export function firstMateWslPathFromWindows(path: string): string | undefined {
  const canonical = firstMateCanonicalWindowsPath(path)
  return canonical ? firstMateWslPath(canonical) : undefined
}
