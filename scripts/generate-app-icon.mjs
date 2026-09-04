// Rasterises the canonical Toucan logo into the PNG electron-builder stamps onto the
// Windows executable and its installers. Kept as a script rather than a committed-only
// asset so the icon can be regenerated whenever the vector changes.
//
// The rasteriser itself is shared with the phone client's icons; see scripts/rasterise-logo.mjs.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOGO, resolveChromium, rasteriseLogo, ROOT } from './rasterise-logo.mjs'

const TARGET = join(ROOT, 'build/icon.png')
/** electron-builder derives every smaller Windows icon size from this one. */
const SIZE = 512

async function main() {
  const chromium = resolveChromium()
  // Transparent ground: the logo must sit on light and dark taskbars alike.
  await rasteriseLogo(chromium, await readFile(LOGO, 'utf8'), { target: TARGET, size: SIZE })
  console.log(`Wrote build/icon.png (${SIZE}x${SIZE}) from ${chromium}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
