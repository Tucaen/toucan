import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The whisper.cpp engine and checkpoint for the WER harness - the app's own pins and the app's own
 * ZIP reader, loaded rather than restated.
 *
 * This used to carry a copy of both, on the grounds that a plain-node script cannot import
 * TypeScript. It can: `npm run build:test-out` emits the CommonJS build in `.test-out` that
 * `scripts/verify-session-fork.mjs` and `scripts/verify-outcome-retrieval.mjs` already load, and
 * `voice:wer` runs it first. The copy had meanwhile drifted - it accepted an archive with no local
 * header and silently mis-decoded an entry compressed with a method it did not speak - which is
 * exactly the drift the identity test guarding it could not see (#230).
 */

const out = (path) => pathToFileURL(join(process.cwd(), '.test-out', path)).href
const { WHISPER_ENGINE_BUILD, WHISPER_ENGINE_ENTRIES, WHISPER_ENGINE_ZIP, WHISPER_MODEL } = await import(
  out('src/shared/whisper-assets.js')
)
const { readZipEntries } = await import(out('src/main/zip-extract.js'))

async function fileHasSize(path, expectedSize) {
  try {
    return (await stat(path)).size === expectedSize
  } catch {
    return false
  }
}

async function download(file, destination, log) {
  if (await fileHasSize(destination, file.size)) return
  log(`downloading ${file.name} (${Math.ceil(file.size / 1024 / 1024)} MB)`)
  const response = await fetch(file.url)
  if (!response.ok) throw new Error(`Failed to download ${file.url}: ${response.status} ${response.statusText}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength !== file.size) {
    throw new Error(`Size mismatch for ${file.name}: expected ${file.size}, received ${bytes.byteLength}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== file.sha256) throw new Error(`Checksum mismatch for ${file.name}: ${digest}`)
  const temporary = `${destination}.download`
  await rm(temporary, { force: true })
  await writeFile(temporary, bytes)
  await rename(temporary, destination)
}

/**
 * Downloads and unpacks whatever the directory lacks; resolves with the paths the harness runs.
 * Idempotent, like the app's own store.
 */
export async function ensureWhisperAssets(directory, log = () => {}) {
  await mkdir(directory, { recursive: true })
  const cliPath = join(directory, 'whisper-cli.exe')
  const modelPath = join(directory, WHISPER_MODEL.name)
  const marker = join(directory, 'engine-build.txt')
  const build = await readFile(marker, 'utf8').catch(() => '')
  if (build.trim() !== WHISPER_ENGINE_BUILD) {
    const zipPath = join(directory, WHISPER_ENGINE_ZIP.name)
    await download(WHISPER_ENGINE_ZIP, zipPath, log)
    for (const entry of readZipEntries(await readFile(zipPath), WHISPER_ENGINE_ENTRIES)) {
      await writeFile(join(directory, entry.name), entry.bytes)
    }
    await writeFile(marker, WHISPER_ENGINE_BUILD)
    await rm(zipPath, { force: true })
  }
  await download(WHISPER_MODEL, modelPath, log)
  return { cliPath, modelPath }
}
