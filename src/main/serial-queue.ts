/**
 * Serializes async tasks: each starts only after the previous one settled, callers get their own
 * task's result, and a failed task rejects its caller without blocking or poisoning later tasks.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
