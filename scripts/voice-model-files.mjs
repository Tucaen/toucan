import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ModelArch, loadMoonshineModule } from '@moonshine-ai/moonshine-wasm'

/**
 * Where Moonshine's English streaming models live on disk and how they get there. Nothing ships
 * them any more - Toucan dictates with whisper.cpp (#214) - so the only caller left is the accuracy
 * harness (`voice-wer.mjs`), which keeps them as the baseline any new engine has to beat.
 */

const scriptDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * A build-output cache, deliberately outside the source tree. These are gigabytes of harness input,
 * and anywhere under `src/` Vite would copy them into `out/renderer` on every build.
 */
export const MODELS_ROOT = join(scriptDirectory, '..', '.cache', 'voice-models')

/** Streaming architectures by the short name the harness takes on its command line. */
export const STREAMING_ARCHS = {
  tiny: { arch: ModelArch.TinyStreaming, directory: 'moonshine-tiny-streaming-en' },
  small: { arch: ModelArch.SmallStreaming, directory: 'moonshine-small-streaming-en' },
  medium: { arch: ModelArch.MediumStreaming, directory: 'moonshine-medium-streaming-en' }
}

export function modelDirectory(name) {
  return join(MODELS_ROOT, STREAMING_ARCHS[name].directory)
}

async function fileHasSize(path, expectedSize) {
  try {
    return (await stat(path)).size === expectedSize
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** The files the CDN manifest lists for an architecture: `{ name, url, size }` each. */
export async function manifestFiles(arch) {
  const module = await loadMoonshineModule()
  const manifest = JSON.parse(module.sttDependencies('en', String(arch), false))
  return manifest.groups.flatMap((group) => group.files)
}

/** Names of the manifest files not yet present at their declared size. */
export async function missingFiles(files, directory) {
  const missing = []
  for (const file of files) {
    if (!(await fileHasSize(join(directory, file.name), file.size))) missing.push(file.name)
  }
  return missing
}

export async function downloadFile(file, directory, log = () => {}) {
  const destination = join(directory, file.name)
  if (await fileHasSize(destination, file.size)) {
    log(`${file.name} already present`)
    return
  }
  log(`downloading ${file.name} (${Math.ceil(file.size / 1024 / 1024)} MB)`)
  const response = await fetch(file.url)
  if (!response.ok) {
    throw new Error(`Failed to download ${file.url}: ${response.status} ${response.statusText}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== file.size) {
    throw new Error(`Size mismatch for ${file.name}: expected ${file.size}, received ${bytes.byteLength}`)
  }
  // Written beside the destination and renamed into place, so a killed download never leaves a
  // truncated file that has the right name.
  const temporary = `${destination}.download`
  await rm(temporary, { force: true })
  await writeFile(temporary, bytes)
  await rename(temporary, destination)
}

/** Downloads whatever the directory lacks for this architecture. Idempotent. */
export async function ensureModelFiles(arch, directory, log = () => {}) {
  const files = await manifestFiles(arch)
  const missing = await missingFiles(files, directory)
  if (missing.length === 0) return files
  await mkdir(directory, { recursive: true })
  for (const [index, file] of files.entries()) {
    await downloadFile(file, directory, (message) => log(`[${index + 1}/${files.length}] ${message}`))
  }
  return files
}
