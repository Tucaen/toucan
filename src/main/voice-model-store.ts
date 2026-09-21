import { join } from 'node:path'
import type { VoiceModelStatus } from '../shared/voice-model'
import {
  WHISPER_ENGINE_BUILD,
  WHISPER_ENGINE_DIRECTORY,
  WHISPER_ENGINE_ENTRIES,
  WHISPER_ENGINE_ZIP,
  WHISPER_MODEL,
  WHISPER_NOTICE
} from '../shared/whisper-assets'
import { errorMessage } from '../shared/text'

/**
 * The host's owner of the speech assets on disk: where they are, whether they are complete, and
 * the one download that makes them so.
 *
 * Two things live under the store's root, both pinned in `shared/whisper-assets.ts`: the extracted
 * whisper.cpp engine under `bin/`, and the GGML checkpoint beside it. Completeness is decided per
 * asset - the engine by a marker file naming the build it was extracted from (written only after
 * extraction succeeds, so its presence proves the binaries arrived; a bumped pin reads as missing
 * and re-downloads), the checkpoint by its exact pinned size (its download is renamed into place
 * only at full, hash-verified size, so the size check proves the bytes).
 *
 * A download in flight is shared: the microphone button and a phone's transcription request that
 * arrive together wait on the same bytes. Nothing rejects; a dead network is a status the UI shows,
 * and the next `ensure` tries again, skipping the asset that already landed.
 */

/** Names the engine build a `bin/` directory was extracted from. */
export const WHISPER_ENGINE_MARKER_FILE = 'engine-build.txt'

export interface VoiceAssetFile {
  name: string
  url: string
  size: number
  sha256: string
}

/** Where the complete assets are, for whoever runs the engine. */
export interface WhisperAssetPaths {
  serverPath: string
  cliPath: string
  modelPath: string
  /** The extracted engine directory, which is also where its DLLs are found. */
  binDirectory: string
}

/** The IO this module drives, injected so the download policy is decided in tests without a CDN. */
export interface VoiceModelPort {
  /** Size of the file at `path`, or null when it does not exist. Sync: completeness is asked per snapshot. */
  fileSize(path: string): number | null
  /** Contents of a small text file, or null when it does not exist. */
  readText(path: string): string | null
  writeText(path: string, text: string): Promise<void>
  /**
   * Fetches `file` to `destination` atomically: written beside it, verified against the declared
   * size and SHA-256, and renamed into place only then. Reports bytes received as they arrive.
   */
  download(file: VoiceAssetFile, destination: string, onProgress: (receivedBytes: number) => void): Promise<void>
  /** Unpacks exactly `entries` from the zip into `directory`, flattening any leading folder. */
  extractZip(zipPath: string, entries: readonly string[], directory: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface VoiceModelStore {
  snapshot(): VoiceModelStatus
  /** The complete assets, or null while anything is missing. */
  paths(): WhisperAssetPaths | null
  /** Downloads whatever is missing. Resolves with the status it settled on; never rejects. */
  ensure(): Promise<VoiceModelStatus>
  onChange(listener: (status: VoiceModelStatus) => void): () => void
}

export function createVoiceModelStore(options: {
  /** The store's own directory under userData; everything it writes lives inside. */
  rootDirectory: string
  port: VoiceModelPort
  log: (message: string) => void
}): VoiceModelStore {
  const { rootDirectory, port, log } = options
  const listeners = new Set<(status: VoiceModelStatus) => void>()
  let status: VoiceModelStatus | null = null
  let inFlight: Promise<VoiceModelStatus> | null = null

  const binDirectory = join(rootDirectory, WHISPER_ENGINE_DIRECTORY)
  const markerPath = join(binDirectory, WHISPER_ENGINE_MARKER_FILE)
  const modelPath = join(rootDirectory, WHISPER_MODEL.name)

  const engineComplete = (): boolean => port.readText(markerPath)?.trim() === WHISPER_ENGINE_BUILD
  const modelComplete = (): boolean => port.fileSize(modelPath) === WHISPER_MODEL.size
  const complete = (): boolean => engineComplete() && modelComplete()

  const snapshot = (): VoiceModelStatus => {
    if (status) return status
    return complete() ? { phase: 'ready' } : { phase: 'missing' }
  }

  const publish = (next: VoiceModelStatus): void => {
    status = next
    for (const listener of listeners) listener(next)
  }

  const download = async (): Promise<VoiceModelStatus> => {
    try {
      const totalBytes = WHISPER_ENGINE_ZIP.size + WHISPER_MODEL.size
      let completedBytes = 0
      // The checkpoint arrives in tens of thousands of chunks; every one crossing IPC and
      // re-rendering a button is noise, so progress is published in whole-percent steps.
      let publishedBytes = Number.NEGATIVE_INFINITY
      const progress = (receivedBytes: number): void => {
        if (receivedBytes === publishedBytes) return
        if (receivedBytes - publishedBytes < totalBytes / 100 && receivedBytes !== totalBytes) return
        publishedBytes = receivedBytes
        publish({ phase: 'downloading', receivedBytes, totalBytes })
      }
      progress(0)
      // The engine first: it is small and it is the executable, so a bad pin fails in seconds
      // rather than after a gigabyte. The marker is written only once extraction succeeded, which
      // is what makes its presence mean "the binaries are all there".
      if (!engineComplete()) {
        log(`Downloading whisper.cpp ${WHISPER_ENGINE_BUILD} (${Math.ceil(WHISPER_ENGINE_ZIP.size / 1024 / 1024)} MB).`)
        const zipPath = join(rootDirectory, WHISPER_ENGINE_ZIP.name)
        await port.download(WHISPER_ENGINE_ZIP, zipPath, (receivedBytes) => progress(receivedBytes))
        await port.extractZip(zipPath, WHISPER_ENGINE_ENTRIES, binDirectory)
        await port.writeText(markerPath, WHISPER_ENGINE_BUILD)
        await port.remove(zipPath)
      }
      completedBytes += WHISPER_ENGINE_ZIP.size
      progress(completedBytes)
      if (!modelComplete()) {
        log(`Downloading ${WHISPER_MODEL.name} (${Math.ceil(WHISPER_MODEL.size / 1024 / 1024)} MB).`)
        await port.download(WHISPER_MODEL, modelPath, (receivedBytes) => progress(completedBytes + receivedBytes))
      }
      // Provenance and licenses beside the assets, per the checklist in docs/research/voice-input.md.
      await port.writeText(join(rootDirectory, 'NOTICE.txt'), WHISPER_NOTICE)
      progress(totalBytes)
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
    paths: () =>
      complete()
        ? {
            serverPath: join(binDirectory, 'whisper-server.exe'),
            cliPath: join(binDirectory, 'whisper-cli.exe'),
            modelPath,
            binDirectory
          }
        : null,
    ensure: () => {
      if (complete()) return Promise.resolve(snapshot())
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
