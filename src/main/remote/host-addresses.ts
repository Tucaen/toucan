import { networkInterfaces } from 'node:os'
import type { RemoteAccessAddress } from '../../shared/remote-access'

/**
 * Which addresses the pairing instructions should offer. Tailscale hands every device a
 * `100.64.0.0/10` CGNAT address, and that is the one a phone can actually reach from anywhere, so
 * it is labelled and sorted first; LAN addresses follow as the same-network fallback. Loopback is
 * omitted deliberately - it is the one address that is never useful from another device.
 */
export function describeHostAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): RemoteAccessAddress[] {
  const addresses: RemoteAccessAddress[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      addresses.push({ kind: isTailscaleAddress(entry.address) ? 'tailscale' : 'local', host: entry.address })
    }
  }
  return addresses.sort(
    (left, right) =>
      Number(right.kind === 'tailscale') - Number(left.kind === 'tailscale') || left.host.localeCompare(right.host)
  )
}

export function isTailscaleAddress(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}
