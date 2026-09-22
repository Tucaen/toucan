/**
 * The one home of "a renderer main pushes to". Every module that only ever asks whether its window
 * is still there and then sends it a channel takes this instead of the whole `Electron.WebContents`
 * - which satisfies it structurally, so the composition root hands the real thing over with no cast,
 * and a test owner is two lines rather than a stubbed Electron object.
 *
 * `Payload` is what that module's channels carry. It is a parameter rather than `unknown` because
 * the payload is the one thing these owners genuinely disagree about, and a module whose watcher
 * sends a project path should not typecheck against a caller sending a transcript event.
 */
export interface WebContentsOwner<Payload = unknown> {
  isDestroyed(): boolean
  send(channel: string, payload: Payload): void
}

/**
 * Pushes `payload` unless the renderer is already gone. Always this rather than a bare `send`: a
 * destroyed `WebContents` *throws* rather than ignoring the call, and every push from main races a
 * window the user may have closed, so an unguarded one is an exception on a background callback.
 */
export function sendToOwner<Payload>(owner: WebContentsOwner<Payload>, channel: string, payload: Payload): void {
  if (owner.isDestroyed()) return
  owner.send(channel, payload)
}
