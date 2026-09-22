/**
 * The one narrowing every parser here starts from: is this unknown value a plain object?
 *
 * Arrays are excluded. They are objects to `typeof`, and a parser that lets one through reads
 * `value.someField` as `undefined` and reports "malformed field" for what is really "wrong shape
 * entirely" - so the exclusion is part of the answer, not a nicety. Four copies of this had
 * accumulated, one of them without the array check (#230).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
