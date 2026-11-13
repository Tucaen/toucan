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
  /**
   * One chat. `view: 'questions'` is an orchestrator's open questions, shown in place of the
   * transcript by the same chat screen - so its socket and draft carry on underneath, and closing
   * the view lands back on that orchestrator.
   */
  | { screen: 'chat'; chatId: string; view?: 'questions' }
  | { screen: 'new' }
  | { screen: 'history' }
  /** Managing and switching the saved hosts. */
  | { screen: 'hosts' }

export const NEW_CHAT_PATHNAME = '/new'
export const HOSTS_PATHNAME = '/hosts'
export const HISTORY_PATHNAME = '/history'

export function routeFromPathname(pathname: string): MobileRoute {
  if (pathname === HISTORY_PATHNAME) return { screen: 'history' }
  if (pathname === NEW_CHAT_PATHNAME) return { screen: 'new' }
  if (pathname === HOSTS_PATHNAME) return { screen: 'hosts' }
  const match = /^\/chats\/([^/]+)(\/questions)?$/.exec(pathname)
  if (!match) return { screen: 'list' }
  try {
    const chatId = decodeURIComponent(match[1])
    return match[2] ? { screen: 'chat', chatId, view: 'questions' } : { screen: 'chat', chatId }
  } catch {
    return { screen: 'list' }
  }
}

export function chatPathname(chatId: string): string {
  return `/chats/${encodeURIComponent(chatId)}`
}

export function chatQuestionsPathname(chatId: string): string {
  return `${chatPathname(chatId)}/questions`
}
