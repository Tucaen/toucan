export interface TerminalEventOwner {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export function sendTerminalEvent(
  owner: TerminalEventOwner,
  channel: string,
  payload: unknown
): void {
  if (owner.isDestroyed()) return
  owner.send(channel, payload)
}
