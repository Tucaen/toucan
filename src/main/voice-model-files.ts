import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VoiceModelFileInfo } from '../shared/voice-model'

/**
 * The model files on disk, named and sized.
 *
 * The renderer loads the model by fetching these itself rather than letting Moonshine's own
 * downloader do it: that downloader stores every file in the Cache API, which refuses any scheme
 * that is not HTTP - and the packaged renderer runs on `toucan://` (see `app-protocol.ts`). It
 * also means the 291 MB on disk is not duplicated into a browser cache.
 *
 * A partial download is named `<file>.download` until it is renamed into place at full size, so
 * those are not files anybody may load.
 */
export async function readVoiceModelFiles(directory: string | null): Promise<VoiceModelFileInfo[]> {
  if (!directory) return []
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const files: VoiceModelFileInfo[] = []
  for (const name of names) {
    if (name.endsWith('.download')) continue
    try {
      const stats = await stat(join(directory, name))
      if (stats.isFile()) files.push({ name, size: stats.size })
    } catch {
      // A file that vanished between the listing and the stat is simply not one of them.
    }
  }
  return files
}
