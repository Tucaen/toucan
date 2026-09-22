import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MODELS_ROOT, STREAMING_ARCHS, ensureModelFiles, modelDirectory } from './voice-model-files.mjs'
import { ensureWhisperAssets } from './whisper-files.mjs'

// The app's own WAV header, encoder-context rule and resampler, from the CommonJS build
// `npm run voice:wer` emits first - so the harness measures the shipped configuration rather than
// a copy of it that has to be kept honest by hand.
const out = (path) => pathToFileURL(join(process.cwd(), '.test-out', path)).href
const { wavBytes, whisperAudioContext } = await import(out('src/main/whisper-engine.js'))
const { resampleLinear } = await import(out('src/shared/remote-voice.js'))

/**
 * Word error rate of Toucan's candidate speech models on *your* recordings.
 *
 *   npm run voice:wer -- <directory> [--models medium,whisper]
 *
 * The directory holds pairs: `name.wav` (16-bit PCM WAV, any rate, mono or stereo) and `name.txt`
 * with what was actually said. Record the prompts you really dictate - identifiers, file names,
 * your microphone, your accent - because published benchmarks are read speech in a quiet room and
 * say little about that.
 *
 * Candidates: the Moonshine streaming models Toucan used to dictate with (`tiny`, `small`,
 * `medium`) and `whisper` - whisper.cpp with large-v3-turbo, the engine Toucan ships now, decoding
 * each recording in one batch pass exactly as the app does on Stop. Each candidate is downloaded on
 * first use. Whisper's per-file time includes its model load, because the CLI pays it per run; the
 * app loads once and keeps the server resident.
 *
 * WER is Levenshtein distance over normalized words (lower-cased, punctuation stripped) divided by
 * the reference word count, as the benchmarks report it. One number per file, one per model.
 */

const usage = 'Usage: node scripts/voice-wer.mjs <directory-with-wav-and-txt-pairs> [--models medium,whisper]'
const args = process.argv.slice(2)
const directory = args.find((argument) => !argument.startsWith('--'))
const modelsFlag = args.indexOf('--models')
// `--models` as the last argument is a typo, not a request for the default list: reading past the
// end of the arguments used to throw a TypeError at the user instead of saying so.
if (modelsFlag !== -1 && args[modelsFlag + 1] === undefined) {
  console.error(`--models needs a comma-separated list after it.\n${usage}`)
  process.exit(2)
}
const modelNames = modelsFlag === -1 ? ['medium', 'whisper'] : args[modelsFlag + 1].split(',')

if (!directory) {
  console.error(usage)
  process.exit(2)
}
for (const name of modelNames) {
  if (name !== 'whisper' && !STREAMING_ARCHS[name]) {
    console.error(`Unknown model "${name}". Choose from: ${[...Object.keys(STREAMING_ARCHS), 'whisper'].join(', ')}`)
    process.exit(2)
  }
}

const samples = await loadSamples(directory)
if (samples.length === 0) {
  console.error(`No .wav/.txt pairs found in ${directory}`)
  process.exit(2)
}

const rows = []
for (const name of modelNames) {
  const transcribe = name === 'whisper' ? await loadWhisper() : await loadMoonshine(name)
  let errors = 0
  let words = 0
  for (const sample of samples) {
    const started = performance.now()
    const transcript = await transcribe.run(sample.audio)
    const elapsed = performance.now() - started
    const reference = normalize(sample.reference)
    const hypothesis = normalize(transcript)
    const distance = levenshtein(reference, hypothesis)
    errors += distance
    words += reference.length
    rows.push({
      model: name,
      file: sample.name,
      wer: reference.length ? distance / reference.length : 0,
      seconds: sample.audio.length / 16000,
      elapsedMs: elapsed,
      transcript
    })
  }
  await transcribe.close()
  rows.push({ model: name, file: 'ALL', wer: words ? errors / words : 0, seconds: 0, elapsedMs: 0, transcript: '' })
}

for (const row of rows) {
  if (row.file === 'ALL') {
    console.log(`\n${row.model.padEnd(8)} overall WER ${(row.wer * 100).toFixed(1)}%\n`)
    continue
  }
  const speed = row.seconds ? `${(row.elapsedMs / 1000 / row.seconds).toFixed(2)}x realtime` : ''
  console.log(`${row.model.padEnd(8)} ${row.file.padEnd(28)} WER ${(row.wer * 100).toFixed(1).padStart(5)}%  ${speed}`)
  console.log(`         heard: ${row.transcript}`)
}

/** The Moonshine streaming decoder Toucan used to ship, kept for before/after comparison. */
async function loadMoonshine(name) {
  const { Transcriber } = await import('@moonshine-ai/moonshine-wasm')
  const { arch } = STREAMING_ARCHS[name]
  const modelPath = modelDirectory(name)
  await ensureModelFiles(arch, modelPath, (message) => console.log(`[${name}] ${message}`))
  const transcriber = await Transcriber.load({ files: await readModelFiles(modelPath), modelArch: arch })
  return {
    run: (audio) =>
      transcriber
        .transcribe(audio, { sampleRate: 16000 })
        .lines.map((line) => line.text)
        .join(' '),
    close: () => transcriber.close()
  }
}

/** whisper.cpp large-v3-turbo, decoding each recording in one batch pass like the app does. */
async function loadWhisper() {
  const { cliPath, modelPath } = await ensureWhisperAssets(join(MODELS_ROOT, 'whisper'), (message) =>
    console.log(`[whisper] ${message}`)
  )
  const workDirectory = await mkdtemp(join(tmpdir(), 'toucan-wer-'))
  return {
    run: async (audio) => {
      const wavPath = join(workDirectory, 'sample.wav')
      await writeFile(wavPath, wavBytes(audio))
      const args = [
        ...['-m', modelPath, '-f', wavPath, '-nt', '-l', 'auto', '--suppress-nst'],
        // The app's own trimmed encoder context, so the harness measures what ships.
        ...['-ac', String(whisperAudioContext(audio.length))]
      ]
      const result = spawnSync(cliPath, args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      })
      if (result.status !== 0) throw new Error(`whisper-cli failed: ${result.stderr?.slice(-500)}`)
      return result.stdout.trim()
    },
    close: () => rm(workDirectory, { recursive: true, force: true })
  }
}

async function loadSamples(root) {
  const names = await readdir(root)
  const samples = []
  for (const file of names) {
    if (extname(file).toLowerCase() !== '.wav') continue
    const stem = basename(file, extname(file))
    let reference
    try {
      reference = await readFile(join(root, `${stem}.txt`), 'utf8')
    } catch {
      console.warn(`Skipping ${file}: no ${stem}.txt beside it`)
      continue
    }
    samples.push({ name: stem, reference, audio: decodeWav(await readFile(join(root, file))) })
  }
  return samples
}

async function readModelFiles(modelPath) {
  const files = {}
  for (const name of await readdir(modelPath)) {
    if (name.endsWith('.download')) continue
    files[name] = new Uint8Array(await readFile(join(modelPath, name)))
  }
  return files
}

/** 16-bit PCM WAV to 16 kHz mono float samples. Enough of RIFF for what recorders produce. */
function decodeWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (String.fromCharCode(...buffer.subarray(0, 4)) !== 'RIFF') throw new Error('Not a WAV file')
  let offset = 12
  let channels = 1
  let sampleRate = 16000
  let bitsPerSample = 16
  let data = null
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(...buffer.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      const format = view.getUint16(offset + 8, true)
      if (format !== 1) throw new Error(`Unsupported WAV format ${format}; export 16-bit PCM`)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    } else if (id === 'data') {
      data = buffer.subarray(offset + 8, offset + 8 + size)
    }
    offset += 8 + size + (size % 2)
  }
  if (!data) throw new Error('WAV file has no data chunk')
  if (bitsPerSample !== 16) throw new Error(`Unsupported ${bitsPerSample}-bit WAV; export 16-bit PCM`)
  const frames = Math.floor(data.byteLength / 2 / channels)
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += dataView.getInt16((frame * channels + channel) * 2, true) / 32767
    }
    mono[frame] = sum / channels
  }
  return resampleLinear(mono, sampleRate, 16000)
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function levenshtein(reference, hypothesis) {
  const previous = new Array(hypothesis.length + 1)
  for (let j = 0; j <= hypothesis.length; j += 1) previous[j] = j
  for (let i = 1; i <= reference.length; i += 1) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const above = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1)
      )
      diagonal = above
    }
  }
  return previous[hypothesis.length]
}
