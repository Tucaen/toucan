// Render each Windows icon size from its SVG master, so small taskbar icons never
// inherit the large logo's hairline details through automatic PNG downscaling.
//
// The rasteriser itself is shared with the phone client's icons; see scripts/rasterise-logo.mjs.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOGO, resolveChromium, rasteriseLogo, ROOT } from './rasterise-logo.mjs'

const SMALL_LOGO = join(ROOT, 'src/renderer/src/assets/toucan-logo-small.svg')
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

async function main() {
  const chromium = resolveChromium()
  const large = await readFile(LOGO, 'utf8')
  const small = await readFile(SMALL_LOGO, 'utf8')
  // Keep the standalone large PNG available for other consumers of the original artwork.
  await rasteriseLogo(chromium, large, { target: join(ROOT, 'build/icon.png'), size: 512 })
  const scratch = await mkdtemp(join(tmpdir(), 'toucan-icons-'))
  try {
    const images = []
    for (const size of SIZES) {
      const target = join(scratch, `${size}.png`)
      // Windows may downsample a larger frame: keep the same artwork and footprint in all sizes.
      await rasteriseLogo(chromium, small, { target, size })
      const png = await readFile(target)
      if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
        throw new Error(`Expected a ${size}x${size} PNG for the Windows icon`)
      }
      images.push(png)
    }
    // ICO directory entries point to PNG frames at their native sizes.
    const directory = Buffer.alloc(6 + 16 * images.length)
    directory.writeUInt16LE(1, 2)
    directory.writeUInt16LE(images.length, 4)
    let offset = directory.length
    images.forEach((png, index) => {
      const entry = 6 + index * 16
      directory[entry] = SIZES[index] % 256
      directory[entry + 1] = SIZES[index] % 256
      directory.writeUInt16LE(1, entry + 4)
      directory.writeUInt16LE(32, entry + 6)
      directory.writeUInt32LE(png.length, entry + 8)
      directory.writeUInt32LE(offset, entry + 12)
      offset += png.length
    })
    await writeFile(join(ROOT, 'build/icon.ico'), Buffer.concat([directory, ...images]))
    console.log(`Wrote build/icon.ico (${SIZES.join(', ')}px)`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
