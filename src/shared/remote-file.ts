import { classifyMarkdownLink } from './local-file-link'

/**
 * A local image an agent linked to, fetched by the phone from the desktop it lives on.
 *
 * The phone holds none of the files an agent writes, so a link to `D:\proj\shot.png` is only worth
 * rendering as something tappable if tapping asks the host for those bytes. This module is the one
 * description of that request both sides read: which links qualify, how the path travels, and the
 * bounds the host enforces. The host re-runs every check here on what it is handed, because the
 * phone is not what a privilege boundary may trust.
 *
 * Deliberately narrow on three axes:
 *
 * - **Images only**, and only inert raster kinds. An SVG carries script, and anything else would make
 *   this a general file reader for whoever holds a pairing token.
 * - **Absolute paths only.** A relative link has no base the host could resolve it against, so it
 *   is refused rather than guessed at.
 * - **Drive or POSIX paths only, never UNC.** Resolving `\\server\share\x.png` makes the *desktop*
 *   open an SMB connection to whatever server the path names, which hands that server the user's
 *   Windows credentials to attempt. A request from the network must not be able to make the host
 *   reach out anywhere, so a UNC path is refused before the filesystem is touched.
 */

export const REMOTE_FILE_ROUTE = '/api/file'

/** Large enough for any screenshot, small enough that one tap cannot stall a phone on mobile data. */
export const REMOTE_FILE_BYTE_LIMIT = 10 * 1024 * 1024

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp'
}

/** The content type the host serves `path` as, or null when it is not an image the phone may fetch. */
export function remoteImageContentType(path: string): string | null {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension === undefined ? null : (IMAGE_CONTENT_TYPES[extension] ?? null)
}

/** An absolute drive path (`D:\x`) or POSIX path (`/x`); never UNC, device or relative. */
export function isRemoteFetchablePath(path: string): boolean {
  if (path.includes('\0')) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  return path.startsWith('/') && !path.startsWith('//')
}

/** The local image a Markdown link or image source names, or null when the phone cannot fetch it. */
export function remoteImagePath(href: string | undefined): string | null {
  const target = classifyMarkdownLink(href)
  if (target.kind !== 'file') return null
  return isRemoteFetchablePath(target.path) && remoteImageContentType(target.path) !== null ? target.path : null
}

/** The request path for one file; the token travels as a header, never in this URL. */
export function remoteFileRequestPath(path: string): string {
  return `${REMOTE_FILE_ROUTE}?path=${encodeURIComponent(path)}`
}
