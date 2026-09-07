import type { FormEvent } from 'react'

/** The only part of a composer submit event `useAgentConversation.submit` touches. */
export function fakeSubmitEvent(): FormEvent {
  return { preventDefault: () => {} } as unknown as FormEvent
}
