import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deriveRemoteWorkspaceProjection,
  type RemoteAccessSettings,
  type RemoteAccessState,
  type RemoteWorkspaceSource
} from '../../shared/remote-access'
import {
  spawnSettlement,
  SPAWN_FAILED_MESSAGE,
  type RemoteChatSpawnRequest,
  type RemoteChatSpawnResult
} from '../../shared/remote-spawn'
import type { TerminalNodeStatus } from '../../shared/terminal'

/**
 * The renderer's one owner of remote access. It holds no policy - the host decides whether a
 * listener comes up and what the pairing token is - and does exactly three jobs: it keeps the
 * settings dialog looking at the host's real state, it publishes the canvas projection a paired
 * phone lists, and it performs the spawns the host asks for.
 *
 * Publishing is deduplicated on purpose. The workspace snapshot is rebuilt on every drag frame
 * and every keystroke in a composer draft, none of which changes what a phone shows, so the
 * projection is serialized and compared before it is sent. Without that, dragging a node would
 * push hundreds of identical projections across the privilege seam.
 *
 * Spawning is the same shape read the other way. The canvas mints the node - the host has no
 * business owning ids or geometry - so a spawn request runs the caller's own add-node path and
 * then *waits*, because a node exists the instant it is added but a session does not. The already
 * observed `statuses` map is what the wait reads: the same signal the sidebar and the projection
 * use, so a chat reported as started is one the phone can immediately open and drive.
 */
export interface RemoteAccessController {
  /** Null until the host has answered; the dialog shows a loading state rather than defaults. */
  state: RemoteAccessState | null
  busy: boolean
  applySettings(settings: RemoteAccessSettings): Promise<void>
  regenerateToken(): Promise<void>
}

/**
 * Adds the node a spawn asked for and reports the id it minted, or refuses. Synchronous by design:
 * whether the request is *addressable* - a project that exists, a kind that can be launched - is
 * known immediately, and only whether the session comes up takes time.
 */
export type RemoteChatSpawnStarter = (request: RemoteChatSpawnRequest) => RemoteChatSpawnResult

export function useRemoteAccess(
  source: RemoteWorkspaceSource,
  statuses: Readonly<Record<string, TerminalNodeStatus>>,
  startSpawn?: RemoteChatSpawnStarter
): RemoteAccessController {
  const [state, setState] = useState<RemoteAccessState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.remoteApi.state().then((next) => {
      if (!cancelled) setState(next)
    })
    // The listener can also change without being asked - a bind that fails later, a port that
    // stops being available - so the dialog subscribes instead of polling.
    const stop = window.remoteApi.onStateChange(setState)
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const projection = useMemo(() => deriveRemoteWorkspaceProjection(source, statuses), [source, statuses])
  const published = useRef<string | null>(null)
  /** Chat ids the host has actually been handed. A spawn is only vouched for once its id is here. */
  const listed = useRef<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const serialized = JSON.stringify(projection)
    if (published.current === serialized) return
    published.current = serialized
    window.remoteApi.publishWorkspace(projection)
    listed.current = new Set(projection.chats.map((chat) => chat.id))
  }, [projection])

  // Requests whose node is on the canvas but whose session has not reported yet, keyed by the
  // host's request id so a verdict can never be attributed to the wrong waiting phone.
  const awaitingStart = useRef(new Map<string, string>())
  const starter = useRef(startSpawn)
  starter.current = startSpawn

  useEffect(() => {
    return window.remoteApi.onSpawnChat((requestId, request) => {
      const started = starter.current?.(request) ?? {
        ok: false as const,
        message: 'This desktop cannot start chats right now.'
      }
      // A refusal is already final; only a node that was actually added has a session to wait on.
      if (!started.ok) window.remoteApi.completeSpawn(requestId, started)
      else awaitingStart.current.set(requestId, started.chatId)
    })
  }, [])

  useEffect(() => {
    for (const [requestId, chatId] of [...awaitingStart.current]) {
      const onCanvas = source.nodes.some((node) => node.id === chatId)
      // Closed before it ever came up. Nothing will report on it again, so the phone is refused now
      // rather than left waiting out the host's timeout on a node that no longer exists.
      const settlement = !onCanvas ? 'failed' : spawnSettlement(statuses[chatId] ?? 'starting')
      // A started session is only *reportable* once the host has been handed a projection listing
      // it: joining the chat socket is gated on that list, so answering earlier would hand the
      // phone an id its very next request would be refused for.
      if (settlement === 'pending' || (settlement === 'started' && !listed.current.has(chatId))) continue
      awaitingStart.current.delete(requestId)
      const result: RemoteChatSpawnResult =
        settlement === 'started' ? { ok: true, chatId } : { ok: false, message: SPAWN_FAILED_MESSAGE }
      window.remoteApi.completeSpawn(requestId, result)
    }
    // `projection` is a dependency for its ordering, not its value: it is what the publish effect
    // above reacts to, and effects run in declaration order, so by the time this one sees a new
    // projection the host has already been handed it.
  }, [projection, source.nodes, statuses])

  const run = useCallback(async (operation: () => Promise<RemoteAccessState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await operation())
    } finally {
      setBusy(false)
    }
  }, [])

  const applySettings = useCallback(
    (settings: RemoteAccessSettings) => run(() => window.remoteApi.applySettings(settings)),
    [run]
  )
  const regenerateToken = useCallback(() => run(() => window.remoteApi.regenerateToken()), [run])

  return { state, busy, applySettings, regenerateToken }
}
