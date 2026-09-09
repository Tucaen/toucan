/**
 * What a Markdown link points at, for the surfaces that render agent prose. An agent that has
 * just written a file says so with an ordinary Markdown link to it, and it writes that link the
 * way the platform gave it the path: a drive letter, either separator, spaces left literal inside
 * `<...>`, sometimes percent-encoded, sometimes as a `file:` URL, sometimes with the leading slash
 * a `file:` pathname carries. All of those name one file, so all of them are recognized here -
 * one classifier, so the renderer never has to guess and the privileged side can re-run the same
 * decision on what it is handed.
 *
 * This is also the security gate. `react-markdown`'s URL sanitizer drops everything but a handful
 * of web schemes, which would erase local links entirely, so the surfaces that want them pass
 * `keepHref` and rely on this: only a web URL and an absolute local path are recognized at all,
 * and everything else - a relative link, an anchor, `javascript:`, a private scheme - is
 * `unsupported` and must be rendered as inert text with no `href`.
 */

export type MarkdownLinkTarget =
  | { kind: 'external'; url: string }
  /** An absolute local path, in the platform's own form. Whether it may be opened is decided later. */
  | { kind: 'file'; path: string }
  | { kind: 'unsupported' }

export type LocalFileOpenFailure =
  /** The path resolves outside every registered project and worktree; the open was refused. */
  | 'outside-workspace'
  /** Not a file kind Toucan hands to the OS - it opens as a file node instead. */
  | 'unsupported-type'
  | 'not-found'
  | 'directory'
  | 'unopenable'

export type LocalFileOpenResult = { ok: true } | { ok: false; reason: LocalFileOpenFailure; message: string }

/** A path that starts with a drive letter, e.g. `D:/x` or `D:\x`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/
/** The same path as a `file:` pathname hands it over, e.g. `/D:/x`. */
const SLASHED_DRIVE_PATH = /^[\\/]([A-Za-z]:[\\/][\s\S]*)$/

/**
 * Percent-decodes a destination when it plainly is percent-encoded. CommonMark allows a link
 * destination to be encoded and agents encode spaces about as often as they bracket them, but a
 * decode must never corrupt a name that merely contains a `%`, so only a well-formed sequence is
 * decoded and a failure keeps the literal text.
 */
function decoded(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Windows understands either separator; normalizing makes one path one string for display. */
function nativeDrivePath(path: string): string {
  return path.replace(/\//g, '\\')
}

function fileTarget(path: string): MarkdownLinkTarget {
  const trimmed = path.trim()
  // `file://` alone yields a bare separator, which names nothing.
  if (!trimmed || /^[\\/]+$/.test(trimmed)) return { kind: 'unsupported' }
  return { kind: 'file', path: trimmed }
}

export function classifyMarkdownLink(href: string | undefined): MarkdownLinkTarget {
  const raw = href?.trim()
  if (!raw) return { kind: 'unsupported' }
  // A destination wrapped in angle brackets is how a path with spaces is written; remark usually
  // unwraps it, but a link built by hand or rewritten upstream can still arrive wrapped.
  const unwrapped = (raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw).trim()
  // Decoding comes first because a destination reaches the renderer already encoded: `mdast` runs
  // every link URL through `normalizeUri`, which turns a Windows separator into `%5C` and a space
  // into `%20`, and an encoded separator is not recognizable as a path.
  const bare = decoded(unwrapped).trim()
  if (!bare) return { kind: 'unsupported' }

  // Drive-letter forms are checked before any URL parse, because `new URL('D:/x')` succeeds with
  // the drive letter as its scheme and would classify the commonest local link as unsupported.
  const slashed = SLASHED_DRIVE_PATH.exec(bare)
  if (slashed) return fileTarget(nativeDrivePath(slashed[1]))
  if (DRIVE_PATH.test(bare)) return fileTarget(nativeDrivePath(bare))
  // A UNC path is only ever written with backslashes. `//host/x` is a protocol-relative URL and
  // deliberately not read as one: guessing wrong there would open a share for a web link.
  if (bare.startsWith('\\\\')) return fileTarget(bare)

  // The URL branch reads the destination as written: a web URL's own percent-encoding is part of
  // the address and must reach the browser intact.
  let url: URL | undefined
  try {
    url = new URL(unwrapped)
  } catch {
    url = undefined
  }
  if (url) {
    if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'external', url: unwrapped }
    if (url.protocol !== 'file:') return { kind: 'unsupported' }
    const path = decoded(url.pathname)
    // file:///D:/x yields "/D:/x"; file://host/share/x is a UNC path in two parts.
    if (url.host) return fileTarget(nativeDrivePath(`\\\\${url.host}${path}`))
    const drive = SLASHED_DRIVE_PATH.exec(path)
    return drive ? fileTarget(nativeDrivePath(drive[1])) : fileTarget(path)
  }
  // A bare absolute POSIX path is the last local form; a relative link has no resolvable base,
  // and a `//host/x` that got this far is the protocol-relative URL, not a share.
  return bare.startsWith('/') && !bare.startsWith('//') ? fileTarget(decoded(bare)) : { kind: 'unsupported' }
}

/**
 * Inert media Toucan has no view for. Only these are handed to the OS, because opening a file
 * with its associated application is how a `.bat` or a `.js` beside it would be *run*: everything
 * else opens as a file node, which reads bytes and executes nothing.
 *
 * `svg` is deliberately absent even though it is an image: the OS hands one to the default
 * browser, which executes the script an SVG is allowed to carry. It is markup, so the file node
 * shows it as what it is.
 */
const SYSTEM_VIEWER_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'pdf',
  'mp4',
  'webm',
  'mov',
  'mkv',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a'
])

export function opensInSystemViewer(path: string): boolean {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]
  return extension !== undefined && SYSTEM_VIEWER_EXTENSIONS.has(extension.toLowerCase())
}
