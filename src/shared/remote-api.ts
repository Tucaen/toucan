import type { RemoteAccessSettings, RemoteAccessState, RemoteWorkspaceProjection } from './remote-access'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from './remote-spawn'

/**
 * Remote access, seen from the desktop renderer. Its own module rather than a member of
 * `remote-access.ts` because it needs the spawn shapes, and `remote-spawn.ts` already imports
 * `remote-access.ts` - this direction would be a cycle there.
 */
export interface RemoteApi {
  state(): Promise<RemoteAccessState>
  /** Starts, stops or rebinds the listener and returns the state that actually took effect. */
  applySettings(settings: RemoteAccessSettings): Promise<RemoteAccessState>
  /** Mints a new pairing token; clients holding the old one are unauthorized from then on. */
  regenerateToken(): Promise<RemoteAccessState>
  /** The canvas projection a paired phone lists. The canvas stays its only authority. */
  publishWorkspace(projection: RemoteWorkspaceProjection): void
  onStateChange(callback: (state: RemoteAccessState) => void): () => void
  /**
   * A spawn the host wants performed. Node identity and geometry are the canvas's, so main asks
   * rather than mints; the renderer answers on `completeSpawn` once the session is up or has
   * failed, and the phone's HTTP request is waiting on exactly that answer.
   */
  onSpawnChat(callback: (requestId: string, request: RemoteChatSpawnRequest) => void): () => void
  completeSpawn(requestId: string, result: RemoteChatSpawnResult): void
}
