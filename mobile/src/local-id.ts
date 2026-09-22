/**
 * Identifiers the phone mints for its own use: a saved host's handle, and the correlation id that
 * ties one send to its verdict. Neither ever leaves this client as anything but an opaque string,
 * and only uniqueness matters - no crypto API is required, and `crypto.randomUUID` is unavailable
 * on a page served over plain HTTP anyway, which is exactly how a host on the tailnet is reached.
 */
export function newLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
