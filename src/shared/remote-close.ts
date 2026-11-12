/**
 * The contract for closing a chat from a paired device: `POST /api/chats/:id/close`.
 *
 * Closing is a canvas gesture, like spawning: the node, its session and everything that goes with
 * removing it (attention records, recently-closed history, worktree attachment) are the canvas's,
 * so the host asks the desktop renderer to run its own remove path rather than killing a session
 * behind the canvas's back. The answer is a verdict - the phone leaves the chat on `ok`, so it must
 * never be told a chat is gone that is still there.
 */
export type RemoteChatCloseResult = { ok: true } | { ok: false; message: string }

export function isRemoteChatCloseResult(value: unknown): value is RemoteChatCloseResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { ok?: unknown; message?: unknown }
  return result.ok === true || (result.ok === false && typeof result.message === 'string')
}
