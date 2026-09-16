import type { VoiceModelFileInfo } from '../../shared/voice-model'

/**
 * Reads the speech model off the host's origin into memory, keyed by the canonical file names the
 * WASM loader expects.
 *
 * Moonshine's own `AssetDownloader` would do this, and Toucan used to let it, but it puts every
 * file through the Cache API - which throws `TypeError: Request scheme '<x>' is unsupported` for
 * anything that is not HTTP, and the packaged renderer's origin is a custom scheme (see
 * `main/app-protocol.ts`). Fetching the bytes here works on every origin the renderer can run on,
 * and keeps the 291 MB on disk from being copied into a second, browser-managed cache.
 *
 * Progress is reported against the sizes the host measured, so the bar is honest before the first
 * response header arrives.
 */
export async function fetchVoiceModelFiles(
  files: readonly VoiceModelFileInfo[],
  baseUrl: string,
  onProgress: (fraction: number) => void,
  fetchFile: (url: string) => Promise<Response> = (url) => fetch(url)
): Promise<Map<string, Uint8Array>> {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let completedBytes = 0
  const bytes = new Map<string, Uint8Array>()
  for (const file of files) {
    const response = await fetchFile(new URL(file.name, baseUrl).toString())
    if (!response.ok) throw new Error(`Could not read the speech model file ${file.name} (${response.status}).`)
    bytes.set(file.name, new Uint8Array(await response.arrayBuffer()))
    completedBytes += file.size
    onProgress(totalBytes > 0 ? Math.min(1, completedBytes / totalBytes) : 0)
  }
  return bytes
}
