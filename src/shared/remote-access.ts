/**
 * The contract between Toucan's host process, its desktop UI, and the mobile companion client.
 *
 * Remote access is two separable decisions, and this module owns both of their shapes. The first
 * is *whether* the host is reachable at all: a listener that is off by default, a port, and one
 * long random pairing token. Reachability itself is deliberately not Toucan's problem - Tailscale
 * puts the phone and the PC on the same network - so the token is the entire authorization story
 * and it is checked on every API call rather than trusted per network.
 *
 * The second is *what* a paired phone sees. `RemoteWorkspaceSnapshot` is a projection of the
 * canvas, not a second model of it: the canvas stays the authority on node identity, titles and
 * status, and `deriveRemoteWorkspaceProjection` is the one function that reduces that state to
 * what a small screen needs. It lives here, runtime-neutral, so the host, the desktop renderer and the
 * mobile client all read the same wire shape from one definition rather than three DTO layers.
 */

import { dominantUnreadKind, unreadAttentionByNode, type AttentionKind, type AttentionState } from './attention'
import type { TerminalNodeStatus } from './terminal'
import type { WorkspaceState } from './workspace'
import type { AgentProvider } from './agent-provider'

/**
 * Well above the ephemeral range and unassigned by IANA, so it rarely collides on a dev machine.
 * @internal exported for tests
 */
export const REMOTE_ACCESS_DEFAULT_PORT = 7391

export interface RemoteAccessSettings {
  /** Off in every fresh install: a listener nobody asked for is a listener nobody audited. */
  enabled: boolean
  port: number
}

export const REMOTE_ACCESS_DEFAULT_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  port: REMOTE_ACCESS_DEFAULT_PORT
}

/**
 * Privileged ports are excluded rather than supported: Toucan runs as the user, so binding one
 * would fail late with an opaque EACCES instead of being refused while the user is still typing.
 */
export function remoteAccessPortProblem(port: number): string | null {
  if (!Number.isInteger(port)) return 'Port must be a whole number.'
  if (port < 1024) return 'Port must be 1024 or higher.'
  if (port > 65535) return 'Port must be 65535 or lower.'
  return null
}

export function isRemoteAccessSettings(value: unknown): value is RemoteAccessSettings {
  if (!value || typeof value !== 'object') return false
  const settings = value as Partial<RemoteAccessSettings>
  return typeof settings.enabled === 'boolean' && typeof settings.port === 'number'
}

/** Everything the desktop needs to explain remote access to the user, including the token itself. */
export interface RemoteAccessState {
  settings: RemoteAccessSettings
  listening: boolean
  /** The port actually bound, which can differ from the requested one until a restart succeeds. */
  boundPort?: number
  /** Why the listener is not up, phrased for the settings dialog. */
  error?: string
  /**
   * The pairing token in full. It never leaves the host except to the desktop UI that displays it
   * and the phone the user types it into, and it is never accepted in a URL.
   */
  token: string
  tokenUpdatedAt: number
  /** Best-effort addresses this host can be reached at, for the pairing instructions. */
  addresses: RemoteAccessAddress[]
}

export interface RemoteAccessAddress {
  /** `tailscale` when the address is in the tailnet CGNAT range, which is the one that matters. */
  kind: 'tailscale' | 'local'
  host: string
}

/** A phone only ever sees agent chats, so a chat's kind is exactly its provider. */
export type RemoteChatKind = AgentProvider

/**
 * One agent chat as a phone shows it. Terminal nodes are excluded by design: a PTY stream is not
 * a conversation, and its output can never be safely interpreted as needing attention.
 */
export interface RemoteChatSummary {
  id: string
  kind: RemoteChatKind
  title: string
  projectId: string
  status: TerminalNodeStatus
  /** Unread attention records for this node, counted from the same durable set the canvas counts. */
  unread: number
  /** The most blocking unread condition, so a phone with one badge shows the right one. */
  attention?: AttentionKind
}

export interface RemoteProjectSummary {
  id: string
  name: string
  color: string
}

/**
 * What the desktop projects. Deliberately without a timestamp: the desktop republishes this
 * whenever the canvas changes, and stamping a clock here would make every projection compare
 * unequal to the last one, so nothing could tell a real change from a re-render.
 */
export interface RemoteWorkspaceProjection {
  projects: RemoteProjectSummary[]
  chats: RemoteChatSummary[]
}

export interface RemoteWorkspaceSnapshot extends RemoteWorkspaceProjection {
  /** Host clock when the projection was received; the client shows staleness rather than guessing. */
  updatedAt: number
}

export const EMPTY_REMOTE_WORKSPACE_SNAPSHOT: RemoteWorkspaceSnapshot = {
  updatedAt: 0,
  projects: [],
  chats: []
}

/** The canvas state this projection needs. Narrow on purpose, so tests can build one by hand. */
export type RemoteWorkspaceSource = Pick<WorkspaceState, 'projects' | 'nodes'> & {
  attention?: AttentionState
}

/**
 * Reduces the canvas to the phone home screen. Status is passed in rather than inferred: the
 * live verdict on a session belongs to whoever is running it, and a snapshot that guessed would
 * disagree with the desktop.
 */
export function deriveRemoteWorkspaceProjection(
  source: RemoteWorkspaceSource,
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): RemoteWorkspaceProjection {
  const attention: AttentionState = source.attention ?? []
  const unreadByNode = unreadAttentionByNode(attention)
  const knownProjects = new Set(source.projects.map((project) => project.id))

  return {
    projects: source.projects.map(({ id, name, color }) => ({ id, name, color })),
    chats: source.nodes
      .filter((node) => node.kind !== 'terminal' && knownProjects.has(node.projectId))
      .map((node) => {
        const kind = node.kind as RemoteChatKind
        const dominant = dominantUnreadKind(attention, node.id)
        return {
          id: node.id,
          kind,
          title: node.label,
          projectId: node.projectId,
          // A node the desktop has not reported on yet is dormant, never "starting": claiming a
          // session is coming up when nothing has launched it is the one lie that costs trust.
          status: statuses[node.id] ?? 'dormant',
          unread: unreadByNode[node.id] ?? 0,
          ...(dominant ? { attention: dominant } : {})
        }
      })
  }
}
