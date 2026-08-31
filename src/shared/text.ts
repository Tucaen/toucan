/** The one conversion of an unknown thrown value to a human-readable message, shared everywhere. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const windows1252Bytes = new Map<string, number>([
  ['\u20ac', 0x80],
  ['\u201a', 0x82],
  ['\u0192', 0x83],
  ['\u201e', 0x84],
  ['\u2026', 0x85],
  ['\u2020', 0x86],
  ['\u2021', 0x87],
  ['\u02c6', 0x88],
  ['\u2030', 0x89],
  ['\u0160', 0x8a],
  ['\u2039', 0x8b],
  ['\u0152', 0x8c],
  ['\u017d', 0x8e],
  ['\u2018', 0x91],
  ['\u2019', 0x92],
  ['\u201c', 0x93],
  ['\u201d', 0x94],
  ['\u2022', 0x95],
  ['\u2013', 0x96],
  ['\u2014', 0x97],
  ['\u02dc', 0x98],
  ['\u2122', 0x99],
  ['\u0161', 0x9a],
  ['\u203a', 0x9b],
  ['\u0153', 0x9c],
  ['\u017e', 0x9e],
  ['\u0178', 0x9f]
])

export function repairUtf8Mojibake(value: string): string {
  if (!/[\u00c2\u00c3\u00e2]/.test(value)) return value
  const bytes: number[] = []
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0xff) {
      bytes.push(codePoint)
    } else {
      const byte = windows1252Bytes.get(character)
      if (byte === undefined) return value
      bytes.push(byte)
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    return value
  }
}
