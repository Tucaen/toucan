import { join } from 'node:path'
import type { VoiceModelStatus } from '../shared/voice-model'
import { errorMessage } from '../shared/text'

/**
 * The host's owner of the speech model on disk: where it is, whether it is complete, and the one
 * download that makes it so.
 *
 * Two directories can hold it. A *prepared* directory is what `scripts/prepare-voice-model.mjs`
 * fills for a dev run, where Vite serves the renderer's `public/` in place; it is read-only here.
 * The *download* directory is the host's own, under userData, and is the only one this module
 * writes. The first that is complete wins, so a developer never downloads twice and an installed
 * build never looks for a `public/` it does not have.
 *
 * Completeness is one file: `streaming_config.json`, the manifest the Moonshine loader keys off.
 * That is only safe because the download writes it *last* and renames every file into place at
 * its full declared size - so its presence proves the rest arrived, without loading the WASM
 * module (which is where the size manifest lives) just to answer "is it there".
 *
 * A download in flight is shared: the microphone button and a phone's transcription request that
 * arrive together wait on the same bytes. Nothing rejects; a dead network is a status the UI shows,
 * and the next `ensure` tries again, skipping the files that already landed.
 */

/** The file whose presence marks a directory complete. Downloaded last for exactly that reason. */
export const VOICE_MODEL_MARKER_FILE = 'streaming_config.json'

export interface VoiceModelFile {
  name: string
  url: string
  size: number
}

/** The IO this module drives, injected so the download policy is decided in tests without a CDN. */
export interface VoiceModelPort {
  /** The CDN's file list for the model, in download order. Loads the WASM module to read it. */
  manifest(): Promise<VoiceModelFile[]>
  exists(path: string): boolean
  /** Size of the file at `path`, or null when it does not exist. */
  fileSize(path: string): Promise<number | null>
  /**
   * Fetches `file` to `destination` atomically: written beside it and renamed into place only at
   * the full declared size. Reports bytes received so far as they arrive.
   */
  download(file: VoiceModelFile, destination: string, onProgress: (receivedBytes: number) => void): Promise<void>
}

export interface VoiceModelStore {
  snapshot(): VoiceModelStatus
  /** The complete model directory, or null when there is none yet. */
  directory(): string | null
  /** Absolute path of one model file, or null when the model is not complete or the name is not a plain file name. */
  filePath(name: string): string | null
  /** Downloads whatever is missing. Resolves with the status it settled on; never rejects. */
  ensure(): Promise<VoiceModelStatus>
  onChange(listener: (status: VoiceModelStatus) => void): () => void
}

export function createVoiceModelStore(options: {
  preparedDirectories: readonly string[]
  downloadDirectory: string
  port: VoiceModelPort
  log: (message: string) => void
}): VoiceModelStore {
  const { preparedDirectories, downloadDirectory, port, log } = options
  const listeners = new Set<(status: VoiceModelStatus) => void>()
  let status: VoiceModelStatus | null = null
  let inFlight: Promise<VoiceModelStatus> | null = null

  const directory = (): string | null =>
    [...preparedDirectories, downloadDirectory].find((candidate) =>
      port.exists(join(candidate, VOICE_MODEL_MARKER_FILE))
    ) ?? null

  const snapshot = (): VoiceModelStatus => {
    if (status) return status
    return directory() ? { phase: 'ready' } : { phase: 'missing' }
  }

  const publish = (next: VoiceModelStatus): void => {
    status = next
    for (const listener of listeners) listener(next)
  }

  const download = async (): Promise<VoiceModelStatus> => {
    try {
      const files = await port.manifest()
      // The marker goes last so that its presence means "everything else is here".
      const ordered = [
        ...files.filter((file) => file.name !== VOICE_MODEL_MARKER_FILE),
        ...files.filter((file) => file.name === VOICE_MODEL_MARKER_FILE)
      ]
      const totalBytes = ordered.reduce((sum, file) => sum + file.size, 0)
      let completedBytes = 0
      // A 300 MB download arrives in tens of thousands of chunks; every one crossing IPC and
      // re-rendering a button is noise, so progress is published in whole-percent steps.
      let publishedBytes = Number.NEGATIVE_INFINITY
      const progress = (receivedBytes: number): void => {
        if (receivedBytes === publishedBytes) return
        if (receivedBytes - publishedBytes < totalBytes / 100 && receivedBytes !== totalBytes) return
        publishedBytes = receivedBytes
        publish({ phase: 'downloading', receivedBytes, totalBytes })
      }
      progress(0)
      for (const file of ordered) {
        const destination = join(downloadDirectory, file.name)
        if ((await port.fileSize(destination)) !== file.size) {
          log(`Downloading ${file.name} (${Math.ceil(file.size / 1024 / 1024)} MB).`)
          await port.download(file, destination, (receivedBytes) => progress(completedBytes + receivedBytes))
        }
        completedBytes += file.size
        progress(completedBytes)
      }
      publish({ phase: 'ready' })
    } catch (error) {
      const message = errorMessage(error)
      log(`Speech model download failed: ${message}`)
      publish({ phase: 'error', message })
    }
    return snapshot()
  }

  return {
    snapshot,
    directory,
    filePath: (name) => {
      const root = directory()
      if (!root || name.length === 0 || /[\\/]/.test(name) || name === '..' || name === '.') return null
      return join(root, name)
    },
    ensure: () => {
      if (directory()) return Promise.resolve(snapshot())
      if (!inFlight) {
        inFlight = download().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
