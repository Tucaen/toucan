import { STREAMING_ARCHS, ensureModelFiles, manifestFiles, missingFiles, modelDirectory } from './voice-model-files.mjs'

// Toucan dictates with Moonshine's English Medium Streaming model: the most accurate streaming
// model it publishes (2.17% LibriSpeech WER against Small Streaming's 2.61%), at roughly 305 MB.
// The directory name must match VOICE_MODEL_ASSET_DIRECTORY in src/shared/remote-voice.ts, which
// the renderer and the main process both resolve the prepared files from.
const MODEL = 'medium'
const directory = modelDirectory(MODEL)

// The packaged app fetches the model itself on first use and excludes out/renderer/models from the
// installer, so a release build has no reason to spend a runner's minutes downloading it.
if (process.env.TOUCAN_SKIP_VOICE_MODEL === '1') {
  console.log('Skipping the voice model download (TOUCAN_SKIP_VOICE_MODEL=1).')
  process.exit(0)
}

if (process.argv.includes('--check')) {
  const missing = await missingFiles(await manifestFiles(STREAMING_ARCHS[MODEL].arch), directory)
  if (missing.length) {
    throw new Error(`Local voice model is incomplete. Missing: ${missing.join(', ')}`)
  }
  console.log('Local Moonshine voice model is complete.')
  process.exit(0)
}

let downloaded = false
await ensureModelFiles(STREAMING_ARCHS[MODEL].arch, directory, (message) => {
  downloaded = true
  console.log(`[voice model] ${message}`)
})
console.log(downloaded ? 'Local Moonshine voice model is ready.' : 'Local Moonshine voice model is already prepared.')
