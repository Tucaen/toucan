/**
 * Apply Toucan's invariant for processes that do not own an interactive window.
 * The policy is applied last so callers cannot accidentally opt back into a
 * transient Windows command window.
 */
export function hiddenProcessOptions<const T extends object | undefined>(
  options: T
): Exclude<T, undefined> & {
  windowsHide: true
} {
  return { ...(options ?? {}), windowsHide: true } as Exclude<T, undefined> & { windowsHide: true }
}
