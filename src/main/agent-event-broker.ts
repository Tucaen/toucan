import type { AgentCreateResult, AgentEvent } from '../shared/agent'
import {
  applyAgentCreateResult,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentTranscriptState
} from '../shared/agent-transcript'

/**
 * Fans each agent session's `AgentEvent` stream out to any number of subscribers (the desktop
 * renderer, remote clients) and keeps a live transcript snapshot per session by running the shared
 * pure reducer over every event. Everything here is synchronous on the main-process event loop,
 * which is what makes the join contract atomic: `subscribe` hands back the snapshot and registers
 * the subscriber in one call, so a concurrently published event is either already folded into that
 * snapshot or delivered to the new subscriber - never both, never neither.
 */

export type AgentEventSubscriber = (event: AgentEvent) => void

/**
 * Lifecycle notifications a subscriber may opt into. The renderer needs neither - its session and
 * its subscription are torn down together - but a remote client outlives both, so it must hear
 * that its channel was retired (`closed`) and that the snapshot learned something the live tail
 * did not carry (`resync`, after a session/load replay was folded without fanning out).
 */
export interface AgentEventSubscriptionHooks {
  closed?(): void
  resync?(snapshot: AgentTranscriptState): void
}

export interface AgentEventSubscription {
  /** The transcript as of the moment this subscription began; the tail starts right after it. */
  snapshot: AgentTranscriptState
  unsubscribe(): void
}

export interface AgentEventBroker {
  /** Folds the event into the session's snapshot and delivers it to every subscriber. */
  publish(id: string, event: AgentEvent): void
  /**
   * Folds a replayed event into the snapshot without fanning it out. Replay reaches the renderer
   * atomically inside `AgentCreateResult.replay`, never over the live channel (see AGENTS.md), so
   * the broker mirrors that: the snapshot learns what replay restored, live subscribers do not
   * hear it twice.
   */
  fold(id: string, event: AgentEvent): void
  /** Applies what a create result reports beyond its events, keeping snapshot parity with the renderer. */
  applyCreateResult(id: string, result: AgentCreateResult): void
  subscribe(id: string, subscriber: AgentEventSubscriber, hooks?: AgentEventSubscriptionHooks): AgentEventSubscription
  snapshot(id: string): AgentTranscriptState | null
  /** Retires a session: drops its snapshot and its subscribers. The id may be reused fresh later. */
  close(id: string): void
}

interface ChannelMember {
  subscriber: AgentEventSubscriber
  hooks?: AgentEventSubscriptionHooks
}

interface SessionChannel {
  snapshot: AgentTranscriptState
  members: Set<ChannelMember>
}

export function createAgentEventBroker(options?: { now?: () => number }): AgentEventBroker {
  const now = options?.now ?? Date.now
  const channels = new Map<string, SessionChannel>()

  const channel = (id: string): SessionChannel => {
    const existing = channels.get(id)
    if (existing) return existing
    const created: SessionChannel = { snapshot: initialAgentTranscriptState(), members: new Set() }
    channels.set(id, created)
    return created
  }

  return {
    publish(id, event): void {
      const session = channel(id)
      session.snapshot = foldAgentEvent(session.snapshot, event, now())
      // Snapshot of the set: a subscriber added by a callback joins from the *next* event, which
      // is exactly what its own subscription snapshot (folded above) promises it.
      for (const member of [...session.members]) {
        try {
          member.subscriber(event)
        } catch {
          // One broken subscriber (a renderer torn down mid-send) must not starve the rest.
        }
      }
    },

    fold(id, event): void {
      const session = channel(id)
      session.snapshot = foldAgentEvent(session.snapshot, event, now())
    },

    applyCreateResult(id, result): void {
      const session = channel(id)
      session.snapshot = applyAgentCreateResult(session.snapshot, result)
      // Replay reached this snapshot through `fold`, which deliberately does not fan out (the
      // renderer receives replay inside the create result). A subscriber attached before the
      // replay is therefore behind; the create result is the settled moment to make it whole.
      for (const member of [...session.members]) {
        try {
          member.hooks?.resync?.(session.snapshot)
        } catch {
          // Same rule as publish: one broken subscriber must not starve the rest.
        }
      }
    },

    subscribe(id, subscriber, hooks): AgentEventSubscription {
      const session = channel(id)
      const member: ChannelMember = { subscriber, ...(hooks ? { hooks } : {}) }
      session.members.add(member)
      return {
        snapshot: session.snapshot,
        unsubscribe: () => session.members.delete(member)
      }
    },

    snapshot(id): AgentTranscriptState | null {
      return channels.get(id)?.snapshot ?? null
    },

    close(id): void {
      const session = channels.get(id)
      channels.delete(id)
      if (!session) return
      for (const member of session.members) {
        try {
          member.hooks?.closed?.()
        } catch {
          // Closing must retire every subscriber even when one throws on the way out.
        }
      }
    }
  }
}
