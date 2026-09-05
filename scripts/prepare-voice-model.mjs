import { STREAMING_ARCHS, ensureModelFiles, manifestFiles, missingFiles, modelDirectory } from './voice-model-files.mjs'

// Toucan dictates with Moonshine's English Medium Streaming model: the most accurate streaming
// model it publishes (2.17% LibriSpeech WER against Small Streaming's 2.61%), at roughly 305 MB.
// The directory name must match VOICE_MODEL_ASSET_DIRECTORY in src/shared/remote-voice.ts, which
// the renderer and the main process both resolve the prepared files from.
const MODEL = 'medium'
const directory = modelDirectory(MODEL)

if (process.argv.includes('--check')) {
  const missing = await missingFiles(await manifestFiles(STREAMING_ARCHS[MODEL].arch), directory)
  if (missing.length) {
    throw new Error(`Local voice model is incomplete. Missing: ${missing.join(', ')}`)
  }
  console.log('Local Moonshine voice model is complete.')
  process.exit(0)
}

const files = await manifestFiles(STREAMING_ARCHS[MODEL].arch)
if ((await missingFiles(files, directory)).length === 0) {
  console.log('Local Moonshine voice model is already prepared.')
  process.exit(0)
}

await ensureModelFiles(STREAMING_ARCHS[MODEL].arch, directory, (message) => console.log(`[voice model] ${message}`))
console.log('Local Moonshine voice model is ready.')
