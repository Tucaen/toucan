/**
 * Which clone URLs ADE accepts as a project's Git origin, mirroring the contract owned by the managed
 * distro's bin/fm-project-origin-lib.sh: structure and safety only, never the forge or the domain, and
 * each end re-validates whatever origin reached it.
 *
 * Supported: https, http, ssh, and git URLs with a plain or bracketed IPv6 host and optional numeric
 * port; file:/// and absolute local paths; scp-like [user@]host:path.
 * Unsupported: printable values whose scheme or format ADE does not handle (svn://, relative paths,
 * etc.) — stored as inert classified metadata, never used as a clone command.
 * Unsafe: remote-helper transports such as ext::<command>, option-shaped values, whitespace and
 * control characters, and /../ traversal in a local or file: path.
 */

export type FirstMateOriginSafety = 'supported' | 'unsupported' | 'unsafe'

function localPathSafe(path: string): boolean {
  return path.startsWith('/') && !`/${path}/`.includes('/../')
}

function ipv6LiteralSafe(literal: string): boolean {
  return literal.includes(':') && !/[^0-9A-Fa-f:.%]/.test(literal)
}

function authoritySafe(authority: string): boolean {
  if (!authority) return false
  let hostPort = authority
  const separator = authority.lastIndexOf('@')
  if (separator >= 0) {
    const user = authority.slice(0, separator)
    if (!user || user.startsWith('-') || /[[\]]/.test(user)) return false
    hostPort = authority.slice(separator + 1)
  }
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']')
    if (close < 0 || !ipv6LiteralSafe(hostPort.slice(1, close))) return false
    const port = hostPort.slice(close + 1)
    return port === '' || /^:\d+$/.test(port)
  }
  if (/[[\]]/.test(hostPort)) return false
  const parts = hostPort.split(':')
  if (parts.length > 2) return false
  const [host, port] = parts
  if (!host || host.startsWith('-') || /[^A-Za-z0-9._-]/.test(host)) return false
  return port === undefined || /^\d+$/.test(port)
}

/** scp-like [user@]host:path. The user is stripped only when its "@" really precedes the host. */
function scpLikeSafe(url: string): boolean {
  const at = url.indexOf('@')
  const firstColon = url.indexOf(':')
  const rest = at > 0 && (firstColon < 0 || at < firstColon) ? url.slice(at + 1) : url
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0 || rest[close + 1] !== ':') return false
    return ipv6LiteralSafe(rest.slice(1, close)) && rest.length > close + 2
  }
  const colon = rest.indexOf(':')
  if (colon < 1) return false
  const host = rest.slice(0, colon)
  const path = rest.slice(colon + 1)
  if (host.startsWith('-') || /[^A-Za-z0-9._-]/.test(host)) return false
  return path !== '' && !path.startsWith(':')
}

/** Whitespace and control characters are refused outright, including an embedded newline. */
function printableOrigin(url: string): boolean {
  for (const character of url) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return false
  }
  return true
}

export function firstMateOriginClassify(url: string): FirstMateOriginSafety {
  if (!url || url.startsWith('-') || !printableOrigin(url)) return 'unsafe'
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url)
  if (scheme) {
    const protocol = scheme[1].toLocaleLowerCase()
    if (protocol === 'file') {
      return url.startsWith('file:///') && localPathSafe(url.slice('file://'.length)) ? 'supported' : 'unsafe'
    }
    if (['https', 'http', 'ssh', 'git'].includes(protocol)) {
      return authoritySafe(url.slice(scheme[0].length).split('/')[0]) ? 'supported' : 'unsafe'
    }
    return 'unsupported'
  }
  if (url.includes('::')) return 'unsafe'
  if (url.includes('://')) return 'unsupported'
  if (url.startsWith('/')) return localPathSafe(url) ? 'supported' : 'unsafe'
  if (scpLikeSafe(url)) return 'supported'
  return 'unsupported'
}

export function firstMateOriginSafe(url: string): boolean {
  return firstMateOriginClassify(url) === 'supported'
}
