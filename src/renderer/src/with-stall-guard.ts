/** Raised when a guarded promise doesn't settle before its deadline. */
export class StallTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StallTimeoutError'
  }
}

/**
 * Races `promise` against a timeout so a dependency that never resolves or
 * rejects (e.g. a WASM worker that dies silently on startup) can't leave a
 * caller waiting forever. The original promise is left to settle on its own;
 * only the wrapper's outcome is bounded.
 */
export function withStallGuard<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StallTimeoutError(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
