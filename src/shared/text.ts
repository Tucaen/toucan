/** The one conversion of an unknown thrown value to a human-readable message, shared everywhere. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
