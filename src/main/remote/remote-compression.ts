import type { IncomingMessage } from 'node:http'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/**
 * Wire compression for the remote surface. A phone reaches the host over a Tailscale relay that can
 * be slow enough for an uncompressed chat list to take minutes, and everything this server sends is
 * text (JSON, HTML, JS, CSS), which shrinks several-fold.
 */

export type RemoteContentEncoding = 'br' | 'gzip'

/** Below this a frame costs more to compress than it saves, and one packet carries it anyway. */
export const REMOTE_COMPRESSION_MIN_BYTES = 1024

/** Same floor on the chat socket, so pings, verdicts and other small frames stay uncompressed. */
export const REMOTE_SOCKET_COMPRESSION_THRESHOLD = REMOTE_COMPRESSION_MIN_BYTES

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|manifest\+json)|image\/svg\+xml)/i

/**
 * The encoding to answer with, or `null` for identity. Brotli wins when allowed; a `q=0` entry is a
 * refusal, and `*` is honored because a client that names it accepts anything.
 */
export function negotiateEncoding(acceptEncoding: string | string[] | undefined): RemoteContentEncoding | null {
  if (!acceptEncoding) return null
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding
  const weights = new Map<string, number>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const quality = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)).find((match) => match)
    weights.set(name, quality ? Number(quality[1]) : 1)
  }
  const allowed = (name: string): boolean => (weights.get(name) ?? weights.get('*') ?? 0) > 0
  if (allowed('br')) return 'br'
  if (allowed('gzip')) return 'gzip'
  return null
}

export function isCompressibleContentType(contentType: string | number | undefined): boolean {
  return typeof contentType === 'string' && COMPRESSIBLE.test(contentType)
}

export function compressBody(body: Buffer | string, encoding: RemoteContentEncoding, quality?: number): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: quality ?? 4,
        [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(body)
      }
    })
  }
  return gzipSync(body, { level: quality ?? 6 })
}

export function requestEncoding(request: IncomingMessage): RemoteContentEncoding | null {
  return negotiateEncoding(request.headers['accept-encoding'])
}

/**
 * Compressed copies of static files, keyed by file identity (path, size, mtime) so a rebuilt bundle
 * is never served from a stale entry. Static files use the slow, small setting once; API replies
 * change every time and use the fast one.
 */
const STATIC_QUALITY: Record<RemoteContentEncoding, number> = { br: 11, gzip: 9 }
const staticCache = new Map<string, Buffer>()
const STATIC_CACHE_LIMIT = 64

export function compressStatic(key: string, body: Buffer, encoding: RemoteContentEncoding): Buffer {
  const cacheKey = `${encoding}:${key}`
  const cached = staticCache.get(cacheKey)
  if (cached) return cached
  const compressed = compressBody(body, encoding, STATIC_QUALITY[encoding])
  if (staticCache.size >= STATIC_CACHE_LIMIT) staticCache.clear()
  staticCache.set(cacheKey, compressed)
  return compressed
}
