import type { AgentMessagePresentation } from './agent'

export interface AssistantPresentationMessage {
  role: string
  presentation?: AgentMessagePresentation
  /** True while Toucan is waiting for the turn boundary to decide whether unphased text was final. */
  presentationProvisional?: boolean
  complete?: boolean
}

export function initialAssistantPresentation(presentation: AgentMessagePresentation | undefined): {
  presentation: AgentMessagePresentation
  presentationProvisional: boolean
} {
  return presentation
    ? { presentation, presentationProvisional: false }
    : { presentation: 'progress', presentationProvisional: true }
}

function settleAssistantGroup<T extends AssistantPresentationMessage>(messages: T[], indices: readonly number[]): void {
  // Every index here was produced by scanning `messages` itself, so none can miss; reading the
  // group out once says that in one place instead of at each of the four accesses below.
  const group = indices.flatMap((index) => {
    const message = messages[index]
    return message ? [{ index, message }] : []
  })
  const provisional = group.filter(({ message }) => message.presentationProvisional === true)
  const hasProviderFinal = group.some(
    ({ message }) => message.presentation === 'final' && message.presentationProvisional !== true
  )
  const inferredFinal = hasProviderFinal ? undefined : provisional.at(-1)?.index

  for (const { index, message } of group) {
    messages[index] = {
      ...message,
      complete: true,
      ...(message.presentationProvisional === true
        ? {
            presentation: index === inferredFinal ? 'final' : 'progress',
            presentationProvisional: false
          }
        : {})
    }
  }
}

/** Settles the incomplete assistant messages belonging to the live turn that just ended. */
export function settleCurrentAssistantTurn<T extends AssistantPresentationMessage>(messages: readonly T[]): T[] {
  const settled = [...messages]
  const indices = settled.flatMap((message, index) =>
    message.role === 'assistant' && message.complete === false ? [index] : []
  )
  settleAssistantGroup(settled, indices)
  return settled
}

/** Reconstructs completed turn boundaries from the user messages in a finite session/load replay. */
export function settleReplayedAssistantTurns<T extends AssistantPresentationMessage>(messages: readonly T[]): T[] {
  const settled = [...messages]
  let assistantIndices: number[] = []
  const settle = (): void => {
    settleAssistantGroup(settled, assistantIndices)
    assistantIndices = []
  }

  for (const [index, message] of settled.entries()) {
    if (message.role === 'user') settle()
    else if (message.role === 'assistant') assistantIndices.push(index)
  }
  settle()
  return settled
}
