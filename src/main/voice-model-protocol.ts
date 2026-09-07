import { fileURLToPath } from 'node:url'
import { relative, sep } from 'node:path'
import { VOICE_MODEL_ASSET_DIRECTORY } from '../shared/remote-voice'

/**
 * A packaged renderer asks for the speech model at the same relative URL it always has -
 * `models/moonshine-medium-streaming-en/<file>` beside its own `index.html` - but those files are
 * no longer beside it. Main intercepts the `file:` protocol and answers the requests that fall
 * under that directory from wherever the model actually is, so the renderer, the WASM loader and
 * the cross-origin-isolation headers all keep working on one origin. This is the pure half: which
 * file, if any, a request URL is asking for.
 */
export function voiceModelRequestFile(requestUrl: string, rendererRoot: string): string | null {
  let requested: string
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== 'file:') return null
    requested = fileURLToPath(url)
  } catch {
    return null
  }
  const modelRoot = [rendererRoot, ...VOICE_MODEL_ASSET_DIRECTORY.split('/')].join(sep)
  const inside = relative(modelRoot, requested)
  // One plain file name, directly inside the directory: no traversal, no nesting, no directory.
  if (!inside || inside.startsWith('..') || inside.includes(sep) || inside.includes('/')) return null
  return inside
}
