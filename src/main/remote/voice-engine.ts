import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VoiceEngine } from './voice-transcription'

/**
 * The Moonshine engine behind `voice-transcription.ts`, in the main process.
 *
 * The model files are the ones `scripts/prepare-voice-model.mjs` fetched for the renderer, read
 * off disk rather than over HTTP. The package is ESM-only, so it is reached by a dynamic import
 * that the bundler leaves in place; this file is kept apart from the policy module so tests of the
 * policy never touch the WASM.
 */

/** A prepared model directory is one that has the streaming manifest the loader keys off. */
const MARKER_FILE = 'streaming_config.json'

/**
 * The first candidate directory that holds a prepared model, or null. Two candidates exist because
 * `electron-vite dev` serves the renderer's `public/` in place while a packaged build has copied it
 * beside the renderer bundle.
 */
export function resolveVoiceModelDirectory(candidates: readonly string[]): string | null {
  return candidates.find((candidate) => existsSync(join(candidate, MARKER_FILE))) ?? null
}

export const VOICE_MODEL_MISSING_MESSAGE =
  'The desktop has no prepared speech model. Run "npm run prepare:voice-model" on the host.'

export async function loadMoonshineEngine(directory: string | null): Promise<VoiceEngine> {
  if (!directory) throw new Error(VOICE_MODEL_MISSING_MESSAGE)
  const names = await readdir(directory)
  const files: Record<string, Uint8Array> = {}
  for (const name of names) {
    if (name.endsWith('.download')) continue
    files[name] = new Uint8Array(await readFile(join(directory, name)))
  }
  const { ModelArch, Transcriber } = await import('@moonshine-ai/moonshine-wasm')
  const transcriber = await Transcriber.load({ files, modelArch: ModelArch.MediumStreaming })
  return {
    transcribe(audio, sampleRate): string {
      return transcriber
        .transcribe(audio, { sampleRate })
        .lines.map((line) => line.text.trim())
        .filter(Boolean)
        .join(' ')
    },
    close: () => transcriber.close()
  }
}
