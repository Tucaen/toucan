/**
 * How the pairing token is held on disk.
 *
 * The token is a long-lived bearer secret: whoever reads it drives every chat on this PC until the
 * user regenerates it. The threat model it can actually be defended against is narrow - anything
 * running as this user can ask the OS keyring to open it, exactly as Toucan does - so what this
 * buys is that the secret is not sitting in a plain-text file for a backup, a sync client, a crash
 * dump or a support-log request to carry off the machine. That is worth the ten lines.
 *
 * Two rules make it safe to fail. Sealing is *optional*: on a Linux desktop without a keyring
 * `safeStorage` reports itself unavailable, and the store then writes the token in the clear rather
 * than refusing to have a token at all. And opening is *fallible without being fatal*: a record
 * carried to another machine or another user account cannot be opened, which reads as a damaged
 * record - one re-pair, never an open door (see `remote-access-store.ts`).
 *
 * `safeStorage` is injected rather than imported so this module, and the store above it, stay
 * runnable in the node test suite; `src/main/index.ts` is the one place Electron's own is named.
 */

/** The part of Electron's `safeStorage` this needs; nothing here depends on the rest of it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface TokenVault {
  /** The token as it should be stored, or null when this machine cannot seal it. */
  seal(token: string): string | null
  /** The token behind a sealed value, or null when it cannot be opened on this machine. */
  open(sealed: string): string | null
}

/** A vault that seals nothing, for a host with no keyring and for tests that want the plain path. */
export const PLAINTEXT_TOKEN_VAULT: TokenVault = {
  seal: () => null,
  open: () => null
}

export function createSafeStorageVault(safeStorage: SafeStorageLike, log?: (message: string) => void): TokenVault {
  return {
    seal(token): string | null {
      // Asked per call rather than once: on Linux the keyring can become available after start-up,
      // and a vault that cached "no" at boot would keep writing plain text for the whole session.
      if (!safeStorage.isEncryptionAvailable()) return null
      try {
        return safeStorage.encryptString(token).toString('base64')
      } catch (cause) {
        log?.(`could not encrypt the pairing token, storing it as plain text: ${describe(cause)}`)
        return null
      }
    },
    open(sealed): string | null {
      try {
        const token = safeStorage.decryptString(Buffer.from(sealed, 'base64'))
        return token.length > 0 ? token : null
      } catch (cause) {
        log?.(`could not decrypt the stored pairing token, so this PC has to be paired again: ${describe(cause)}`)
        return null
      }
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
