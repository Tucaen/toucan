import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * Pairing is the whole authorization story for remote access, so this module keeps its three
 * decisions in one place: how a token is minted, how one is read off a request, and how two are
 * compared. Nothing here knows about HTTP routing - the server asks it a yes/no question.
 */

/**
 * 256 bits, base64url. Long enough that an exposed listener cannot be guessed, short enough to
 * be typed on a phone once; the QR path in a later ticket removes the typing entirely.
 */
export const PAIRING_TOKEN_BYTES = 32

export function createPairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString('base64url')
}

/**
 * Only the `Authorization: Bearer` header is honoured. A token in a query string would be
 * written to every proxy log, browser history entry and referrer header it passes, so a request
 * that presents one that way is treated as presenting nothing at all.
 */
export function presentedPairingToken(headers: IncomingHttpHeaders): string | null {
  const header = headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer[ \t]+(\S+)$/.exec(header.trim())
  return match ? match[1] : null
}

/**
 * Constant-time in the length that matters: comparison happens over equal-length buffers, and a
 * length mismatch is reported without ever short-circuiting inside the byte comparison.
 */
export function pairingTokenMatches(expected: string, presented: string | null): boolean {
  if (!expected || presented === null) return false
  const expectedBytes = Buffer.from(expected, 'utf8')
  const presentedBytes = Buffer.from(presented, 'utf8')
  if (expectedBytes.length !== presentedBytes.length) {
    // Still compare something of equal length so a wrong length costs the same as a wrong byte.
    timingSafeEqual(expectedBytes, expectedBytes)
    return false
  }
  return timingSafeEqual(expectedBytes, presentedBytes)
}
