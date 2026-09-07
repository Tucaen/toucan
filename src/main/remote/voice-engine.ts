import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VoiceEngine } from './voice-transcription'

/**
 * The Moonshine engine behind `voice-transcription.ts`, in the main process.
 *
 * The model files are the ones `voice-model-store.ts` resolved - prepared for a dev run or
 * downloaded into userData - read off disk rather than over HTTP. The package is ESM-only, so it is reached by a dynamic import
 * that the bundler leaves in place; this file is kept apart from the policy module so tests of the
 * policy never touch the WASM.
 */

export const VOICE_MODEL_MISSING_MESSAGE = 'The desktop has not downloaded its speech model yet.'

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
