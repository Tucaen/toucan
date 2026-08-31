import { classifyAssistantMessage, extractDecisionOptions, type DecisionOption } from './decision-message'
import { isFinalAssistantMessage, type AgentMessagePresentation } from '../../shared/agent'

interface DecisionTranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
  queued?: boolean
  failed?: boolean
  decisionReplyTo?: string
  deliveryPending?: boolean
  complete?: boolean
  presentation?: AgentMessagePresentation
}

export interface PendingDecision {
  id: string
  messageId: string
  taskId?: string
  text: string
  options: DecisionOption[]
  state: 'actionable' | 'submitting'
}

export interface PendingDecisionState {
  decisions: PendingDecision[]
  closedIds: Set<string>
}

export interface DurableTaskClosureState {
  closedTaskIds: Set<string>
}

export function durableTaskClosureState(
  explicitlyClosedTaskIds: ReadonlySet<string> = new Set(),
  activeTaskIds: ReadonlySet<string> = new Set(),
  persistedClosedTaskIds: ReadonlySet<string> = new Set()
): DurableTaskClosureState {
  const closedTaskIds = new Set(persistedClosedTaskIds)
  for (const id of activeTaskIds) if (!explicitlyClosedTaskIds.has(id)) closedTaskIds.delete(id)
  for (const id of explicitlyClosedTaskIds) closedTaskIds.add(id)
  return { closedTaskIds }
}

function tag(text: string, name: string): string | undefined {
  return new RegExp(`\\[${name}=([^\\]\\s]+)\\]`, 'i').exec(text)?.[1]
}

function taskId(text: string): string | undefined {
  return (
    tag(text, 'task') ??
    /(?:^|\n)\s*(?:[-*]\s*)?([\w.-]+)\s+\[key=[^\]]+\]\s+(?:needs-decision|blocked)\s*:/i.exec(text)?.[1]
  )
}

function stableHash(text: string): string {
  let value = 2166136261
  for (const character of text) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(36)
}

/** Stable across replay and repeated open-decision wakes, but scoped by task whenever possible. */
export function decisionIdentity(message: Pick<DecisionTranscriptMessage, 'id' | 'text'>): string {
  const key = tag(message.text, 'key')
  const task = taskId(message.text)
  if (key) return `${task ?? 'conversation'}:${key}`
  return `text:${stableHash(message.text.replace(/\s+/g, ' ').trim().toLowerCase())}`
}

/**
 * Folds normalized transcript messages into the currently open decision set. Exact decision
 * controls carry stable identity so simultaneous decisions cannot clear one another. Failed sends
 * restore actionability, while transport acceptance closes the matching decision.
 */
export function pendingDecisionStateFromMessages(
  messages: readonly DecisionTranscriptMessage[],
  completedTaskIds: ReadonlySet<string> = new Set(),
  persistedClosedIds: ReadonlySet<string> = new Set()
): PendingDecisionState {
  const decisions = new Map<string, PendingDecision>()
  const closed = new Set(persistedClosedIds)
  for (const message of messages) {
    if (
      isFinalAssistantMessage(message) &&
      message.complete !== false &&
      classifyAssistantMessage(message.text) === 'decision'
    ) {
      const id = decisionIdentity(message)
      const task = taskId(message.text)
      const supersededKey = tag(message.text, 'supersedes')
      if (supersededKey) {
        const supersededId = `${task ?? 'conversation'}:${supersededKey}`
        decisions.delete(supersededId)
        closed.add(supersededId)
      }
      if ((!task || !completedTaskIds.has(task)) && !closed.has(id)) {
        decisions.set(id, {
          id,
          messageId: message.id,
          taskId: task,
          text: message.text,
          options: extractDecisionOptions(message.text),
          state: 'actionable'
        })
      }
      continue
    }
    if (message.role !== 'user') continue
    if (message.decisionReplyTo) {
      if (message.failed) {
        closed.delete(message.decisionReplyTo)
        const existing = decisions.get(message.decisionReplyTo)
        if (existing) decisions.set(existing.id, { ...existing, state: 'actionable' })
      } else if (message.deliveryPending || message.queued) {
        const existing = decisions.get(message.decisionReplyTo)
        if (existing) decisions.set(existing.id, { ...existing, state: 'submitting' })
      } else {
        decisions.delete(message.decisionReplyTo)
        closed.add(message.decisionReplyTo)
      }
      continue
    }
  }
  return {
    decisions: [...decisions.values()].filter((decision) => !decision.taskId || !completedTaskIds.has(decision.taskId)),
    closedIds: closed
  }
}

export function pendingDecisionsFromMessages(
  messages: readonly DecisionTranscriptMessage[],
  completedTaskIds: ReadonlySet<string> = new Set(),
  persistedClosedIds: ReadonlySet<string> = new Set()
): PendingDecision[] {
  return pendingDecisionStateFromMessages(messages, completedTaskIds, persistedClosedIds).decisions
}
