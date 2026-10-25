import { readFile } from 'node:fs/promises'
import {
  DEFAULT_SESSION_MESSAGING_SETTINGS,
  parseSessionMessageFile,
  parseSessionMessagingSettings,
  type SessionMessageFile,
  type SessionMessagingSettings
} from '../shared/session-messaging'
import { errorMessage } from '../shared/text'
import { createDurableJsonStore, type DurableJsonStore } from './durable-json-store'

/**
 * Where sibling-session messaging (#2) keeps what must outlive a restart - the open messages - and
 * where its limits are configured. Both live under userData beside the other single-file stores.
 */

/** `<userData>/session-messages.json`: queued messages and asks still waiting for an answer. */
export function createSessionMessageStore(options: {
  path: string
  log?(message: string): void
}): DurableJsonStore<SessionMessageFile> {
  return createDurableJsonStore<SessionMessageFile>({
    path: options.path,
    parse: parseSessionMessageFile,
    fallback: () => ({ version: 1, messages: [] }),
    ...(options.log ? { log: options.log } : {})
  })
}

/**
 * `<userData>/session-messaging.json` (`{ "hopLimit": 3, "asksPerTurn": 5 }`), read afresh at every
 * ask so an edit applies to the next one. A missing file is the defaults; an unreadable or invalid
 * one is the defaults too, logged - unlike the pacing file, which disables what it configures, a
 * broken file here must never switch the safety limits off.
 */
export function createSessionMessagingSettingsReader(options: {
  path: string
  log?(message: string): void
}): () => Promise<SessionMessagingSettings> {
  return async () => {
    let text: string
    try {
      text = await readFile(options.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        options.log?.(`could not read ${options.path}, so the default limits apply: ${errorMessage(error)}`)
      }
      return DEFAULT_SESSION_MESSAGING_SETTINGS
    }
    let parsed: SessionMessagingSettings | null
    try {
      parsed = parseSessionMessagingSettings(JSON.parse(text) as unknown)
    } catch {
      parsed = null
    }
    if (!parsed) {
      options.log?.(`${options.path} is not { "hopLimit": 1-50, "asksPerTurn": 1-50 }, so the default limits apply`)
    }
    return parsed ?? DEFAULT_SESSION_MESSAGING_SETTINGS
  }
}
