import { existsSync } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VoiceModelFile, VoiceModelPort } from './voice-model-store'

/**
 * The real IO behind `voice-model-store.ts`: Moonshine's CDN manifest and a streaming download to
 * disk. Kept apart from the policy so the store is tested without a network, and out of the test
 * compile because the Moonshine package is ESM-only and reached by a dynamic import the bundler
 * leaves in place (the same arrangement as `remote/voice-engine.ts`).
 */
export function createVoiceModelPort(): VoiceModelPort {
  return {
    async manifest(): Promise<VoiceModelFile[]> {
      const { ModelArch, loadMoonshineModule } = await import('@moonshine-ai/moonshine-wasm')
      const module = await loadMoonshineModule()
      const manifest = JSON.parse(module.sttDependencies('en', String(ModelArch.MediumStreaming), false)) as {
        groups: { files: VoiceModelFile[] }[]
      }
      return manifest.groups.flatMap((group) => group.files)
    },
    exists: (path) => existsSync(path),
    async fileSize(path): Promise<number | null> {
      try {
        return (await stat(path)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async download(file, destination, onProgress): Promise<void> {
      await mkdir(dirname(destination), { recursive: true })
      const response = await fetch(file.url)
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${file.name}: ${response.status} ${response.statusText}`)
      }
      // Written beside the destination and renamed into place, so a killed download never leaves
      // a truncated file that has the right name and the store's size check would then reject.
      const temporary = `${destination}.download`
      await rm(temporary, { force: true })
      const handle = await open(temporary, 'w')
      let received = 0
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await handle.write(chunk)
          received += chunk.byteLength
          onProgress(received)
        }
      } finally {
        await handle.close()
      }
      if (received !== file.size) {
        await rm(temporary, { force: true })
        throw new Error(`Size mismatch for ${file.name}: expected ${file.size} bytes, received ${received}.`)
      }
      await rename(temporary, destination)
    }
  }
}
