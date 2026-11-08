import { useCallback, useEffect, useState } from 'react'
import type {
  OrchestrationControlRequest,
  OrchestrationControlState,
  OrchestrationOpenQuestion
} from '../../shared/ticket-session-spawn'

export interface OrchestrationQuestions {
  questions: OrchestrationOpenQuestion[]
  /** The question whose resolve is in flight, so its Erledigt can stay disabled. */
  pending: string | undefined
  /** Bumped when a resolve fails, so a decision panel that locked itself on submit starts afresh. */
  formKey: number
  resolve(questionId: string, note?: string): Promise<void>
}

/**
 * An orchestrator's pinned open questions: the pushed control state for one orchestration plus the
 * resolve call. Shared by the node's badge and the reader it opens, so both always show the same set.
 */
export function useOrchestrationQuestions(request: OrchestrationControlRequest): OrchestrationQuestions {
  const [state, setState] = useState<OrchestrationControlState | null>(null)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [formKey, setFormKey] = useState(0)
  const { provider, conversationId, nodeId } = request
  const identity = `${provider}:${conversationId}`

  useEffect(() => {
    let current = true
    void window.orchestratorApi
      .orchestrationState({ provider, conversationId, nodeId })
      .then((next) => {
        if (current) setState(next)
      })
      .catch(() => undefined)
    const unsubscribe = window.orchestratorApi.onOrchestrationState((next) => {
      if (current && `${next.provider}:${next.conversationId}` === identity) setState(next)
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [conversationId, identity, nodeId, provider])

  const resolve = useCallback(
    async (questionId: string, note?: string): Promise<void> => {
      setPending(questionId)
      try {
        const next = await window.orchestratorApi.resolveQuestion({
          provider,
          conversationId,
          nodeId,
          questionId,
          ...(note !== undefined ? { note } : {})
        })
        if (next) setState(next)
        else setFormKey((count) => count + 1)
      } catch {
        // The durable record stays authoritative; the pushed state or a remount shows the truth.
        setFormKey((count) => count + 1)
      } finally {
        setPending(undefined)
      }
    },
    [conversationId, nodeId, provider]
  )

  return { questions: state?.openQuestions ?? [], pending, formKey, resolve }
}
