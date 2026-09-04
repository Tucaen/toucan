import type { IpcMain, WebContents } from 'electron'
import {
  isRemoteAccessSettings,
  type RemoteAccessState,
  type RemoteWorkspaceProjection
} from '../../shared/remote-access'
import type { RemoteChatSpawnResult } from '../../shared/remote-spawn'
import { SPAWN_CHAT_RESULT_CHANNEL, type RemoteChatSpawner } from './chat-spawn'
import type { RemoteAccessServer } from './remote-server'

/**
 * The privilege seam for remote access. Two directions cross it: the settings dialog drives the
 * listener and reads the pairing token, and the canvas publishes its workspace projection so the
 * phone has something to list.
 *
 * Published projections are validated shallowly rather than deeply. They come from Toucan's own
 * renderer and are only ever handed straight back out as JSON, so the check that matters is that
 * a malformed message cannot replace a good projection with something unserializable.
 */
export function registerRemoteIpc(ipc: IpcMain, server: RemoteAccessServer, spawner: RemoteChatSpawner): void {
  ipc.handle('remote:state', () => server.state())
  ipc.handle('remote:apply-settings', (_event, settings: unknown) =>
    isRemoteAccessSettings(settings) ? server.applySettings(settings) : server.state()
  )
  ipc.handle('remote:regenerate-token', () => server.regenerateToken())
  ipc.on('remote:publish-workspace', (_event, projection: unknown) => {
    if (isPublishableProjection(projection)) server.publishWorkspace(projection)
  })
  // The renderer's verdict on a spawn main asked it to perform. An unrecognizable answer is
  // dropped rather than settled as a failure: the spawner's own timeout is the honest fallback,
  // and inventing a refusal here could retire a request whose node is on its way up.
  ipc.on(SPAWN_CHAT_RESULT_CHANNEL, (_event, requestId: unknown, result: unknown) => {
    if (typeof requestId === 'string' && isSpawnResult(result)) spawner.complete(requestId, result)
  })
}

/**
 * Pushes listener state to the window that owns the settings dialog. The server can change state
 * without being asked - a port that stops being bindable, a listener that dies - so the dialog
 * subscribes instead of polling.
 */
export function forwardRemoteStateChanges(server: RemoteAccessServer, contents: WebContents): () => void {
  return server.onChange((state: RemoteAccessState) => {
    if (!contents.isDestroyed()) contents.send('remote:state-changed', state)
  })
}

function isSpawnResult(value: unknown): value is RemoteChatSpawnResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { ok?: unknown; chatId?: unknown; message?: unknown }
  if (result.ok === true) return typeof result.chatId === 'string' && result.chatId.length > 0
  return result.ok === false && typeof result.message === 'string'
}

function isPublishableProjection(value: unknown): value is RemoteWorkspaceProjection {
  if (!value || typeof value !== 'object') return false
  const projection = value as Partial<RemoteWorkspaceProjection>
  return Array.isArray(projection.projects) && Array.isArray(projection.chats)
}
