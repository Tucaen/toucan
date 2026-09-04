/**
 * The phone's screens, addressed by pathname so the browser's own back button and a reloaded
 * deep link both land somewhere sensible (the host serves the shell at any path for exactly this).
 *
 * A chat path names the chat and not the host: which host is being driven is the *device's*
 * persisted selection, so a reload restores the same host and resolves the same chat. A path that
 * carried the host too would only matter for links shared between devices, and there are none -
 * every path here is one phone's own history.
 */
export type MobileRoute =
  | { screen: 'list' }
  | { screen: 'chat'; chatId: string }
  | { screen: 'new' }
  /** Managing and switching the saved hosts. */
  | { screen: 'hosts' }

export const NEW_CHAT_PATHNAME = '/new'
export const HOSTS_PATHNAME = '/hosts'

export function routeFromPathname(pathname: string): MobileRoute {
  if (pathname === NEW_CHAT_PATHNAME) return { screen: 'new' }
  if (pathname === HOSTS_PATHNAME) return { screen: 'hosts' }
  const match = /^\/chats\/([^/]+)$/.exec(pathname)
  if (!match) return { screen: 'list' }
  try {
    return { screen: 'chat', chatId: decodeURIComponent(match[1]) }
  } catch {
    return { screen: 'list' }
  }
}

export function chatPathname(chatId: string): string {
  return `/chats/${encodeURIComponent(chatId)}`
}
