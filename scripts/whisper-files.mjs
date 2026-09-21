import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * The whisper.cpp engine and checkpoint for the WER harness: the same pins the app carries in
 * `src/shared/whisper-assets.ts`, restated here because a plain-node script cannot import
 * TypeScript. `tests/whisper-assets.test.ts` holds the two files to the same values, so a bumped
 * pin cannot leave the harness measuring a different engine than the one Toucan dictates with.
 */

export const WHISPER_ENGINE_BUILD = 'b5130'

export const WHISPER_ENGINE_ZIP = {
  name: 'whisper-bin-x64.zip',
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_ENGINE_BUILD}/whisper-bin-x64.zip`,
  size: 8573270,
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
}

export const WHISPER_MODEL = {
  name: 'ggml-large-v3-turbo.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  size: 1624555275,
  sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
}

export const WHISPER_ENGINE_ENTRIES = [
  'whisper-server.exe',
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu-alderlake.dll',
  'ggml-cpu-cannonlake.dll',
  'ggml-cpu-cascadelake.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll',
  'ggml-cpu-sandybridge.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-x64.dll'
]

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

/** Just enough of the ZIP format for the pinned archive; mirrors `src/main/zip-extract.ts`. */
function readZipEntries(archive, names) {
  const wanted = new Set(names)
  const found = new Map()
  let end = -1
  for (let position = archive.length - 22; position >= Math.max(0, archive.length - 65_557); position -= 1) {
    if (archive.readUInt32LE(position) === 0x06054b50) {
      end = position
      break
    }
  }
  if (end === -1) throw new Error('Not a zip archive.')
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Damaged zip central directory.')
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const headerOffset = archive.readUInt32LE(offset + 42)
    const fullName = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    const baseName = fullName.slice(fullName.lastIndexOf('/') + 1)
    if (!wanted.has(baseName) || fullName.endsWith('/')) continue
    const localNameLength = archive.readUInt16LE(headerOffset + 26)
    const localExtraLength = archive.readUInt16LE(headerOffset + 28)
    const dataStart = headerOffset + 30 + localNameLength + localExtraLength
    const compressed = archive.subarray(dataStart, dataStart + compressedSize)
    found.set(baseName, method === 0 ? compressed : inflateRawSync(compressed))
  }
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`The archive is missing: ${missing.join(', ')}.`)
  return found
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
    const entries = readZipEntries(await readFile(zipPath), WHISPER_ENGINE_ENTRIES)
    for (const [name, bytes] of entries) await writeFile(join(directory, name), bytes)
    await writeFile(marker, WHISPER_ENGINE_BUILD)
    await rm(zipPath, { force: true })
  }
  await download(WHISPER_MODEL, modelPath, log)
  return { cliPath, modelPath }
}
