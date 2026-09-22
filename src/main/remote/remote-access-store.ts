import {
  REMOTE_ACCESS_DEFAULT_SETTINGS,
  isRemoteAccessSettings,
  remoteAccessPortProblem,
  type RemoteAccessSettings
} from '../../shared/remote-access'
import { createDurableJsonStoreSync } from '../durable-json-store'
import { createPairingToken } from './pairing'

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
 */
export interface RemoteAccessRecord {
  settings: RemoteAccessSettings
  token: string
  tokenUpdatedAt: number
}

interface StoredRecord extends RemoteAccessRecord {
  version: 1
}

export interface RemoteAccessStore {
  read(): RemoteAccessRecord
  saveSettings(settings: RemoteAccessSettings): RemoteAccessRecord
  /** Mints a new token; every client holding the old one is unauthorized from the next request on. */
  regenerateToken(): RemoteAccessRecord
}

export interface RemoteAccessStoreOptions {
  path: string
  now?: () => number
  createToken?: () => string
  /** Injectable so a record that could not be read leaves a trace rather than a silent re-pair. */
  log?: (message: string) => void
}

function parseStoredRecord(value: unknown, now: () => number): StoredRecord | null {
  if (!value || typeof value !== 'object' || (value as StoredRecord).version !== 1) return null
  const stored = value as StoredRecord
  if (!isRemoteAccessSettings(stored.settings) || remoteAccessPortProblem(stored.settings.port)) return null
  if (typeof stored.token !== 'string' || stored.token.length < 16) return null
  return {
    version: 1,
    settings: { enabled: stored.settings.enabled, port: stored.settings.port },
    token: stored.token,
    tokenUpdatedAt: typeof stored.tokenUpdatedAt === 'number' ? stored.tokenUpdatedAt : now()
  }
}

export function createRemoteAccessStore(options: RemoteAccessStoreOptions): RemoteAccessStore {
  const now = options.now ?? Date.now
  const mintToken = options.createToken ?? createPairingToken
  // Synchronous and fsynced by the store: the record is read before any window exists, so it
  // cannot await, and a pairing token that reached only the page cache would be lost by the crash
  // that took the app down - leaving a paired phone holding a token the host no longer knows.
  const store = createDurableJsonStoreSync<StoredRecord>({
    path: options.path,
    parse: (value) => parseStoredRecord(value, now),
    fallback: () => ({
      version: 1,
      settings: { ...REMOTE_ACCESS_DEFAULT_SETTINGS },
      token: mintToken(),
      tokenUpdatedAt: now()
    }),
    log: options.log
  })
  const { version: _version, ...initial } = store.read()
  let record: RemoteAccessRecord = initial

  const persist = (next: RemoteAccessRecord): RemoteAccessRecord => {
    record = next
    store.save({ version: 1, ...next })
    return record
  }

  return {
    read: () => record,
    saveSettings(settings): RemoteAccessRecord {
      const port = remoteAccessPortProblem(settings.port) ? record.settings.port : settings.port
      return persist({ ...record, settings: { enabled: settings.enabled, port } })
    },
    regenerateToken(): RemoteAccessRecord {
      return persist({ ...record, token: mintToken(), tokenUpdatedAt: now() })
    }
  }
}
