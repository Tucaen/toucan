/**
 * The phone's screens, addressed by pathname so the browser's own back button and a reloaded
 * deep link both land somewhere sensible (the host serves the shell at any path for exactly this).
 */
export type MobileRoute = { screen: 'list' } | { screen: 'chat'; chatId: string } | { screen: 'new' }

export const NEW_CHAT_PATHNAME = '/new'

export function routeFromPathname(pathname: string): MobileRoute {
  if (pathname === NEW_CHAT_PATHNAME) return { screen: 'new' }
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
