import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyMessagingEvent,
  dismissNotice,
  EMPTY_MESSAGING_VIEW,
  mergeOpenMessages,
  type SessionMessagingView
} from './session-messaging-view'
import type { SessionMessagingApi } from '../../shared/session-messaging'

/** What the canvas knows of sibling-session messaging; every chat reads its own slice of it. */
export interface SessionMessagingState {
  view: SessionMessagingView
  dismissNotice(key: string): void
}

export const SessionMessagingContext = createContext<SessionMessagingState>({
  view: EMPTY_MESSAGING_VIEW,
  dismissNotice: () => undefined
})

/**
 * Subscribes before asking for the open messages, so an event published in between is not lost;
 * the late `open()` result is merged under the live ones.
 */
export function useSessionMessaging(api: SessionMessagingApi | undefined): SessionMessagingState {
  const [view, setView] = useState<SessionMessagingView>(EMPTY_MESSAGING_VIEW)
  useEffect(() => {
    if (!api) return
    let active = true
    const unsubscribe = api.onEvent((event) => setView((current) => applyMessagingEvent(current, event)))
    void api
      .open()
      .then((open) => {
        if (active) setView((current) => mergeOpenMessages(current, open))
      })
      .catch(() => undefined)
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])
  const dismiss = useCallback((key: string) => setView((current) => dismissNotice(current, key)), [])
  return useMemo(() => ({ view, dismissNotice: dismiss }), [view, dismiss])
}
