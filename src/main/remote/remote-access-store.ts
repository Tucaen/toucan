import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  REMOTE_ACCESS_DEFAULT_SETTINGS,
  isRemoteAccessSettings,
  remoteAccessPortProblem,
  type RemoteAccessSettings
} from '../../shared/remote-access'
import { createPairingToken } from './pairing'

/**
 * The durable home for remote access: whether the listener is wanted, on which port, and the one
 * pairing token that authorizes it. It lives outside the workspace snapshot on purpose. The
 * workspace file is canvas state the renderer rewrites constantly and recovers from a backup; a
 * credential must not ride along with that, and the host has to know whether to listen before any
 * window exists.
 *
 * A file that cannot be read is treated as a fresh install with a *new* token, never as an open
 * door: losing the token costs one re-pair, whereas defaulting to a known value would not.
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
}

export function createRemoteAccessStore(options: RemoteAccessStoreOptions): RemoteAccessStore {
  const now = options.now ?? Date.now
  const mintToken = options.createToken ?? createPairingToken
  let record = load(options.path, now, mintToken)

  const persist = (next: RemoteAccessRecord): RemoteAccessRecord => {
    record = next
    const stored: StoredRecord = { version: 1, ...next }
    const temporary = `${options.path}.tmp`
    try {
      mkdirSync(dirname(options.path), { recursive: true })
      // Synchronous and fsynced: the record is read before any window exists, so it cannot await,
      // and a pairing token that reached only the page cache would be lost by the crash that took
      // the app down - leaving a paired phone holding a token the host no longer knows.
      const handle = openSync(temporary, 'w')
      try {
        writeSync(handle, JSON.stringify(stored), null, 'utf8')
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, options.path)
    } catch {
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary)
        } catch {
          /* Best-effort cleanup; the in-memory record below is still the one in force. */
        }
      }
    }
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

function load(path: string, now: () => number, mintToken: () => string): RemoteAccessRecord {
  const fresh = (): RemoteAccessRecord => ({
    settings: { ...REMOTE_ACCESS_DEFAULT_SETTINGS },
    token: mintToken(),
    tokenUpdatedAt: now()
  })
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || (parsed as StoredRecord).version !== 1) return fresh()
    const stored = parsed as StoredRecord
    if (!isRemoteAccessSettings(stored.settings) || remoteAccessPortProblem(stored.settings.port)) return fresh()
    if (typeof stored.token !== 'string' || stored.token.length < 16) return fresh()
    return {
      settings: { enabled: stored.settings.enabled, port: stored.settings.port },
      token: stored.token,
      tokenUpdatedAt: typeof stored.tokenUpdatedAt === 'number' ? stored.tokenUpdatedAt : now()
    }
  } catch {
    return fresh()
  }
}
