import {
  REMOTE_ACCESS_DEFAULT_SETTINGS,
  isRemoteAccessSettings,
  remoteAccessPortProblem,
  type RemoteAccessSettings
} from '../../shared/remote-access'
import { createDurableJsonStoreSync } from '../durable-json-store'
import { createPairingToken } from './pairing'
import { PLAINTEXT_TOKEN_VAULT, type TokenVault } from './token-vault'

/**
 * The durable home for remote access: whether the listener is wanted, on which port, and the one
 * pairing token that authorizes it. It lives outside the workspace snapshot on purpose. The
 * workspace file is canvas state the renderer rewrites constantly and recovers from a backup; a
 * credential must not ride along with that, and the host has to know whether to listen before any
 * window exists.
 *
 * A file that cannot be read is treated as a fresh install with a *new* token, never as an open
 * door: losing the token costs one re-pair, whereas defaulting to a known value would not. That
 * re-pair is this run only, though - the store writes nothing over a file it could not read, so a
 * record held shut by an antivirus at startup is still there for the next one (#223), and only a
 * genuinely damaged record makes the new token permanent.
 *
 * The token is sealed with the OS keyring where there is one (`token-vault.ts`) and written in the
 * clear where there is not, so the *file* has two shapes and the record has one. A record written
 * in the clear by an older build is read as such and sealed by the next write, so the migration
 * needs no version bump.
 *
 * A sealed token that will not open is deliberately *not* the damaged record above. The record was
 * copied to another machine or the keyring was reset - ordinary events, unlike the disk corruption
 * that rule was written for - and the only thing actually lost is the token, so the settings are
 * kept and a new token is minted beside them. That matters: discarding the record would turn
 * remote access off at the next launch and lose the port and the bind address with it, which reads
 * as Toucan forgetting rather than as one re-pair. Minting is safe because nobody holds the new
 * token yet; the listener comes up gated by a secret no device has.
 */
export interface RemoteAccessRecord {
  settings: RemoteAccessSettings
  token: string
  tokenUpdatedAt: number
}

/**
 * The file. `token` and `tokenSealed` are the same secret in the two shapes above, and exactly one
 * of them is ever written: keeping a plain copy beside a sealed one would make the sealing
 * decorative.
 */
interface StoredRecord {
  version: 1
  settings: RemoteAccessSettings
  /** Present only on a host with no keyring, and on records written before sealing existed. */
  token?: string
  /** Base64 of the keyring's ciphertext. */
  tokenSealed?: string
  tokenUpdatedAt: number
}

export interface RemoteAccessStore {
  read(): RemoteAccessRecord
  saveSettings(settings: RemoteAccessSettings): RemoteAccessRecord
  /** Mints a new token; every client holding the old one is unauthorized from the next request on. */
  regenerateToken(): RemoteAccessRecord
}

/** What `parseStoredRecord` needs from the store around it, so the two cannot drift apart. */
interface ParseOptions {
  now: () => number
  vault: TokenVault
  mintToken: () => string
  log?: (message: string) => void
}

export interface RemoteAccessStoreOptions {
  path: string
  now?: () => number
  createToken?: () => string
  /** How the token is held on disk. Absent, it is written in the clear, as it was before #225. */
  vault?: TokenVault
  /** Injectable so a record that could not be read leaves a trace rather than a silent re-pair. */
  log?: (message: string) => void
}

/**
 * Reads one file, unsealing the token if that is the shape it is in. It answers in the *plain*
 * shape - `tokenSealed` never survives a parse - so everything above this line works with one
 * token field and only `toStored` knows there are two.
 */
function parseStoredRecord(value: unknown, options: ParseOptions): StoredRecord | null {
  const { now, vault, mintToken, log } = options
  if (!value || typeof value !== 'object' || (value as StoredRecord).version !== 1) return null
  const stored = value as StoredRecord
  if (!isRemoteAccessSettings(stored.settings) || remoteAccessPortProblem(stored.settings.port)) return null
  // A sealed token wins outright where there is one: a record carrying both would be a bug, and
  // preferring the plain copy is how that bug would become a silently unsealed install.
  const sealed = typeof stored.tokenSealed === 'string'
  const opened = sealed ? vault.open(stored.tokenSealed!) : stored.token
  // A sealed token that will not open loses the token and nothing else (see the module comment);
  // anything else wrong with the token field is a damaged record, and the caller re-pairs whole.
  const token = opened ?? (sealed ? mintToken() : null)
  if (token === null) return null
  if (typeof token !== 'string' || token.length < 16) return null
  if (opened === null) log?.('the stored pairing token could not be opened on this PC; pair your phones again')
  return {
    version: 1,
    settings: {
      enabled: stored.settings.enabled,
      port: stored.settings.port,
      ...(stored.settings.bindHost === undefined ? {} : { bindHost: stored.settings.bindHost })
    },
    token,
    tokenUpdatedAt: typeof stored.tokenUpdatedAt === 'number' ? stored.tokenUpdatedAt : now()
  }
}

export function createRemoteAccessStore(options: RemoteAccessStoreOptions): RemoteAccessStore {
  const now = options.now ?? Date.now
  const mintToken = options.createToken ?? createPairingToken
  const vault = options.vault ?? PLAINTEXT_TOKEN_VAULT

  /** One record, in whichever of the file's two token shapes this machine can actually hold. */
  const toStored = (value: RemoteAccessRecord): StoredRecord => {
    const sealed = vault.seal(value.token)
    return {
      version: 1,
      settings: value.settings,
      ...(sealed === null ? { token: value.token } : { tokenSealed: sealed }),
      tokenUpdatedAt: value.tokenUpdatedAt
    }
  }
  // Synchronous and fsynced by the store: the record is read before any window exists, so it
  // cannot await, and a pairing token that reached only the page cache would be lost by the crash
  // that took the app down - leaving a paired phone holding a token the host no longer knows.
  const store = createDurableJsonStoreSync<StoredRecord>({
    path: options.path,
    parse: (value) => parseStoredRecord(value, { now, vault, mintToken, ...(options.log ? { log: options.log } : {}) }),
    fallback: () => ({
      version: 1,
      settings: { ...REMOTE_ACCESS_DEFAULT_SETTINGS },
      token: mintToken(),
      tokenUpdatedAt: now()
    }),
    log: options.log
  })
  const initial = store.read()
  // Both `parse` and `fallback` answer in the plain shape, so `token` is set; minting rather than
  // asserting keeps a future third file shape from producing a host with no token at all.
  let record: RemoteAccessRecord = {
    settings: initial.settings,
    token: initial.token ?? mintToken(),
    tokenUpdatedAt: initial.tokenUpdatedAt
  }

  const persist = (next: RemoteAccessRecord): RemoteAccessRecord => {
    record = next
    store.save(toStored(next))
    return record
  }

  return {
    read: () => record,
    saveSettings(settings): RemoteAccessRecord {
      const port = remoteAccessPortProblem(settings.port) ? record.settings.port : settings.port
      return persist({
        ...record,
        settings: {
          enabled: settings.enabled,
          port,
          ...(settings.bindHost === undefined ? {} : { bindHost: settings.bindHost })
        }
      })
    },
    regenerateToken(): RemoteAccessRecord {
      return persist({ ...record, token: mintToken(), tokenUpdatedAt: now() })
    }
  }
}
