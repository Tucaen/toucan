import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import {
  createVoiceModelStore,
  WHISPER_ENGINE_MARKER_FILE,
  type VoiceAssetFile,
  type VoiceModelPort
} from '../src/main/voice-model-store'
import {
  WHISPER_ENGINE_BUILD,
  WHISPER_ENGINE_DIRECTORY,
  WHISPER_ENGINE_ENTRIES,
  WHISPER_ENGINE_ZIP,
  WHISPER_MODEL
} from '../src/shared/whisper-assets'
import type { VoiceModelStatus } from '../src/shared/voice-model'

/**
 * The speech-asset store: complete means the engine marker names the pinned build *and* the
 * checkpoint sits at its pinned size, a download in flight is shared, failures are statuses rather
 * than rejections, and the next attempt skips the asset that already landed.
 */

const ROOT = join('C:', 'data', 'models', 'whisper')
const BIN = join(ROOT, WHISPER_ENGINE_DIRECTORY)
const MARKER = join(BIN, WHISPER_ENGINE_MARKER_FILE)
const MODEL = join(ROOT, WHISPER_MODEL.name)

interface FakePort extends VoiceModelPort {
  files: Map<string, number>
  texts: Map<string, string>
  downloads: string[]
  extractions: { zipPath: string; entries: readonly string[]; directory: string }[]
  removed: string[]
  failWith: ((file: VoiceAssetFile) => Error | null) | null
}

function fakePort(): FakePort {
  const port: FakePort = {
    files: new Map(),
    texts: new Map(),
    downloads: [],
    extractions: [],
    removed: [],
    failWith: null,
    fileSize: (path) => port.files.get(path) ?? null,
    readText: (path) => port.texts.get(path) ?? null,
    writeText: async (path, text) => {
      port.texts.set(path, text)
    },
    download: async (file, destination, onProgress) => {
      const failure = port.failWith?.(file)
      if (failure) {
        onProgress(Math.floor(file.size / 2))
        throw failure
      }
      port.downloads.push(file.name)
      onProgress(file.size)
      port.files.set(destination, file.size)
    },
    extractZip: async (zipPath, entries, directory) => {
      port.extractions.push({ zipPath, entries, directory })
      for (const entry of entries) port.files.set(join(directory, entry), 1)
    },
    remove: async (path) => {
      port.removed.push(path)
      port.files.delete(path)
    }
  }
  return port
}

function makeStore(port: VoiceModelPort): ReturnType<typeof createVoiceModelStore> {
  return createVoiceModelStore({ rootDirectory: ROOT, port, log: () => {} })
}

function complete(port: FakePort): void {
  port.texts.set(MARKER, WHISPER_ENGINE_BUILD)
  port.files.set(MODEL, WHISPER_MODEL.size)
}

describe('voice model store', () => {
  test('is ready only when the engine marker names the pinned build and the model has its pinned size', () => {
    const port = fakePort()
    assert.deepEqual(makeStore(port).snapshot(), { phase: 'missing' })
    assert.equal(makeStore(port).paths(), null)

    complete(port)
    const store = makeStore(port)
    assert.deepEqual(store.snapshot(), { phase: 'ready' })
    assert.deepEqual(store.paths(), {
      serverPath: join(BIN, 'whisper-server.exe'),
      cliPath: join(BIN, 'whisper-cli.exe'),
      modelPath: MODEL,
      binDirectory: BIN
    })
  })

  test('a marker from another engine build reads as missing, so a bumped pin re-downloads', () => {
    const port = fakePort()
    complete(port)
    port.texts.set(MARKER, 'b0001')
    assert.deepEqual(makeStore(port).snapshot(), { phase: 'missing' })
    assert.equal(makeStore(port).paths(), null)
  })

  test('a model at the wrong size reads as missing however plausible its name', () => {
    const port = fakePort()
    complete(port)
    port.files.set(MODEL, WHISPER_MODEL.size - 1)
    assert.deepEqual(makeStore(port).snapshot(), { phase: 'missing' })
  })

  test('ensure downloads the engine, extracts the pinned entries, drops the zip and fetches the model', async () => {
    const port = fakePort()
    const store = makeStore(port)
    assert.deepEqual(await store.ensure(), { phase: 'ready' })
    assert.deepEqual(port.downloads, [WHISPER_ENGINE_ZIP.name, WHISPER_MODEL.name])
    assert.deepEqual(port.extractions, [
      { zipPath: join(ROOT, WHISPER_ENGINE_ZIP.name), entries: WHISPER_ENGINE_ENTRIES, directory: BIN }
    ])
    assert.deepEqual(port.removed, [join(ROOT, WHISPER_ENGINE_ZIP.name)])
    assert.equal(port.texts.get(MARKER), WHISPER_ENGINE_BUILD)
    assert.notEqual(store.paths(), null)
    // Provenance and licenses land beside the assets, per docs/research/voice-input.md.
    assert.match(port.texts.get(join(ROOT, 'NOTICE.txt')) ?? '', /MIT/)
  })

  test('publishes download progress against the combined size, in whole-percent steps', async () => {
    const port = fakePort()
    const store = makeStore(port)
    const seen: VoiceModelStatus[] = []
    store.onChange((status) => seen.push(status))
    await store.ensure()
    const total = WHISPER_ENGINE_ZIP.size + WHISPER_MODEL.size
    const downloading = seen.filter((status) => status.phase === 'downloading')
    assert.ok(downloading.length > 0)
    for (const status of downloading) assert.equal(status.totalBytes, total)
    assert.deepEqual(seen.at(-1), { phase: 'ready' })
  })

  test('concurrent ensures share one download', async () => {
    const port = fakePort()
    const store = makeStore(port)
    const [first, second] = await Promise.all([store.ensure(), store.ensure()])
    assert.deepEqual(first, { phase: 'ready' })
    assert.deepEqual(second, { phase: 'ready' })
    assert.deepEqual(port.downloads, [WHISPER_ENGINE_ZIP.name, WHISPER_MODEL.name])
  })

  test('a failed download is a status, and the next ensure skips the asset that already landed', async () => {
    const port = fakePort()
    port.failWith = (file) => (file.name === WHISPER_MODEL.name ? new Error('the network dropped') : null)
    const store = makeStore(port)
    const failed = await store.ensure()
    assert.equal(failed.phase, 'error')
    assert.match((failed as { message: string }).message, /the network dropped/)
    assert.equal(port.texts.get(MARKER), WHISPER_ENGINE_BUILD)

    port.failWith = null
    assert.deepEqual(await store.ensure(), { phase: 'ready' })
    // The engine was not re-downloaded: its marker already named the pinned build.
    assert.deepEqual(port.downloads, [WHISPER_ENGINE_ZIP.name, WHISPER_MODEL.name])
  })

  test('an ensure on a complete store touches nothing', async () => {
    const port = fakePort()
    complete(port)
    const store = makeStore(port)
    assert.deepEqual(await store.ensure(), { phase: 'ready' })
    assert.deepEqual(port.downloads, [])
    assert.deepEqual(port.extractions, [])
  })
})
