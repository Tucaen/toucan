/** Runtime narrowing for values crossing an untrusted IPC boundary. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

export function optionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

export function isTerminalSize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === 'number' &&
    Number.isSafeInteger(cols) &&
    cols >= 2 &&
    typeof rows === 'number' &&
    Number.isSafeInteger(rows) &&
    rows >= 1
  )
}
