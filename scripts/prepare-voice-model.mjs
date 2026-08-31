import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ModelArch, loadMoonshineModule } from '@moonshine-ai/moonshine-wasm'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const modelDirectory = join(
  scriptDirectory,
  '..',
  'src',
  'renderer',
  'public',
  'models',
  'moonshine-small-streaming-en'
)

async function fileHasSize(path, expectedSize) {
  try {
    return (await stat(path)).size === expectedSize
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function getModelFiles() {
  const module = await loadMoonshineModule()
  const manifest = JSON.parse(module.sttDependencies('en', String(ModelArch.SmallStreaming), false))
  return manifest.groups.flatMap((group) => group.files)
}

async function downloadFile(file, index, totalFiles) {
  const destination = join(modelDirectory, file.name)
  if (await fileHasSize(destination, file.size)) {
    console.log(`[voice model ${index}/${totalFiles}] ${file.name} already present`)
    return
  }

  console.log(
    `[voice model ${index}/${totalFiles}] downloading ${file.name} (${Math.ceil(file.size / 1024 / 1024)} MB)`
  )
  const response = await fetch(file.url)
  if (!response.ok) {
    throw new Error(`Failed to download ${file.url}: ${response.status} ${response.statusText}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== file.size) {
    throw new Error(`Size mismatch for ${file.name}: expected ${file.size}, received ${bytes.byteLength}`)
  }

  const temporary = `${destination}.download`
  await rm(temporary, { force: true })
  await writeFile(temporary, bytes)
  await rename(temporary, destination)
}

const files = await getModelFiles()
const missing = []
for (const file of files) {
  if (!(await fileHasSize(join(modelDirectory, file.name), file.size))) missing.push(file.name)
}

if (process.argv.includes('--check')) {
  if (missing.length) {
    throw new Error(`Local voice model is incomplete. Missing: ${missing.join(', ')}`)
  }
  console.log('Local Moonshine voice model is complete.')
  process.exit(0)
}

if (missing.length === 0) {
  console.log('Local Moonshine voice model is already prepared.')
  process.exit(0)
}

await mkdir(modelDirectory, { recursive: true })
for (const [index, file] of files.entries()) {
  await downloadFile(file, index + 1, files.length)
}

console.log('Local Moonshine voice model is ready.')
