import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  VOICE_MODEL_MARKER_FILE,
  createVoiceModelStore,
  type VoiceModelFile,
  type VoiceModelPort
} from '../src/main/voice-model-store'
import type { VoiceModelStatus } from '../src/shared/voice-model'

/**
 * The download policy, driven against an in-memory disk and CDN. What is pinned down: the marker
 * file decides readiness and is fetched last, one download is shared by everyone who asks during
 * it, a failure is a status rather than a rejection, and a retry skips what already landed.
 */

const FILES: VoiceModelFile[] = [
  { name: VOICE_MODEL_MARKER_FILE, url: 'cdn/config', size: 10 },
  { name: 'encoder.ort', url: 'cdn/encoder', size: 100 },
  { name: 'decoder.ort', url: 'cdn/decoder', size: 200 }
]

interface FakeDisk {
  port: VoiceModelPort
  files: Map<string, number>
  downloads: string[]
  failOn: string | null
  /** Resolves the download that is currently waiting, so ordering is the test's to control. */
  release(): void
}

function fakeDisk(): FakeDisk {
  const files = new Map<string, number>()
  let pending: (() => void) | null = null
  const disk: FakeDisk = {
    files,
    downloads: [],
    failOn: null,
    release: () => {
      const run = pending
      pending = null
      run?.()
    },
    port: {
      manifest: async () => FILES,
      exists: (path) => files.has(path),
      fileSize: async (path) => files.get(path) ?? null,
      download: (file, destination, onProgress) =>
        new Promise<void>((resolve, reject) => {
          disk.downloads.push(file.name)
          pending = () => {
            if (disk.failOn === file.name) {
              reject(new Error(`the network dropped ${file.name}`))
              return
            }
            onProgress(Math.floor(file.size / 2))
            onProgress(file.size)
            files.set(destination, file.size)
            resolve()
          }
        })
    }
  }
  return disk
}

const PREPARED = join('repo', 'public', 'models')
const DOWNLOADED = join('userData', 'models')

function store(disk: FakeDisk): { store: ReturnType<typeof createVoiceModelStore>; changes: VoiceModelStatus[] } {
  const changes: VoiceModelStatus[] = []
  const created = createVoiceModelStore({
    preparedDirectories: [PREPARED],
    downloadDirectory: DOWNLOADED,
    port: disk.port,
    log: () => undefined
  })
  created.onChange((status) => changes.push(status))
  return { store: created, changes }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

async function releaseAll(disk: FakeDisk, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await settle()
    disk.release()
  }
}

test('a prepared directory is ready without any download, and wins over the download directory', async () => {
  const disk = fakeDisk()
  disk.files.set(join(PREPARED, VOICE_MODEL_MARKER_FILE), 10)
  const { store: s } = store(disk)
  assert.deepEqual(s.snapshot(), { phase: 'ready' })
  assert.equal(s.directory(), PREPARED)
  assert.deepEqual(await s.ensure(), { phase: 'ready' })
  assert.deepEqual(disk.downloads, [])
})

test('downloads every file with the marker last, reporting host-side byte counts as it goes', async () => {
  const disk = fakeDisk()
  const { store: s, changes } = store(disk)
  assert.deepEqual(s.snapshot(), { phase: 'missing' })
  assert.equal(s.filePath('encoder.ort'), null, 'nothing is served before the model is complete')

  const done = s.ensure()
  await releaseAll(disk, FILES.length)
  assert.deepEqual(await done, { phase: 'ready' })
  assert.deepEqual(disk.downloads, ['encoder.ort', 'decoder.ort', VOICE_MODEL_MARKER_FILE])
  assert.equal(s.directory(), DOWNLOADED)
  assert.equal(s.filePath('encoder.ort'), join(DOWNLOADED, 'encoder.ort'))

  const received = changes
    .filter((status): status is Extract<VoiceModelStatus, { phase: 'downloading' }> => status.phase === 'downloading')
    .map((status) => status.receivedBytes)
  // Whole-percent steps only: the two completed-file repeats of 100, 300 and 310 are not republished.
  assert.deepEqual(received, [0, 50, 100, 200, 300, 305, 310])
  assert.ok(changes.every((status) => status.phase !== 'downloading' || status.totalBytes === 310))
  assert.deepEqual(changes.at(-1), { phase: 'ready' })
})

test('everyone who asks during a download waits on the same one', async () => {
  const disk = fakeDisk()
  const { store: s } = store(disk)
  const first = s.ensure()
  const second = s.ensure()
  await releaseAll(disk, FILES.length)
  assert.deepEqual(await Promise.all([first, second]), [{ phase: 'ready' }, { phase: 'ready' }])
  assert.equal(disk.downloads.length, FILES.length, 'the second caller must not start a second download')
})

test('a failed download is a status, and the retry skips the files that already landed', async () => {
  const disk = fakeDisk()
  disk.failOn = 'decoder.ort'
  const { store: s } = store(disk)

  const failed = s.ensure()
  await releaseAll(disk, 2)
  assert.deepEqual(await failed, { phase: 'error', message: 'the network dropped decoder.ort' })
  assert.equal(s.directory(), null, 'a partial download is not a model')
  assert.equal(s.filePath(VOICE_MODEL_MARKER_FILE), null)

  disk.failOn = null
  const retried = s.ensure()
  await releaseAll(disk, 2)
  assert.deepEqual(await retried, { phase: 'ready' })
  assert.deepEqual(disk.downloads, ['encoder.ort', 'decoder.ort', 'decoder.ort', VOICE_MODEL_MARKER_FILE])
})

test('serves plain file names only, never a path', () => {
  const disk = fakeDisk()
  disk.files.set(join(DOWNLOADED, VOICE_MODEL_MARKER_FILE), 10)
  const { store: s } = store(disk)
  assert.equal(s.filePath('..'), null)
  assert.equal(s.filePath('../secrets'), null)
  assert.equal(s.filePath('sub\\file'), null)
  assert.equal(s.filePath(''), null)
  assert.equal(s.filePath('tokenizer.bin'), join(DOWNLOADED, 'tokenizer.bin'))
})
