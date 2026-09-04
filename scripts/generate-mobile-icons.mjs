// Rasterises the canonical Toucan logo into the PNGs the phone client's web app manifest points
// at. Chrome decides whether to offer "Install app" from these files, so they have to be real
// bitmaps at the exact declared sizes - an SVG or a mismatched size is refused silently.
//
// Two shapes are needed, not one. An `any` icon is drawn as-is on a transparent ground, while a
// `maskable` icon is composited on an opaque background with the logo inset into Android's safe
// zone: an adaptive launcher shape crops the outer ring, so a full-bleed logo loses its beak.
//
// The manifest is the authority on the background colour, so this script reads it rather than
// keeping a second copy that a recolour could leave behind.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOGO, resolveChromium, rasteriseLogo, ROOT } from './rasterise-logo.mjs'

const TARGET_DIR = join(ROOT, 'mobile/public')
const MANIFEST = join(TARGET_DIR, 'manifest.webmanifest')
/** Android's maskable safe zone is the middle 80%, so the logo is inset by a tenth per side. */
const MASKABLE_INSET = 0.1

async function main() {
  const chromium = resolveChromium()
  const svg = await readFile(LOGO, 'utf8')
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))

  for (const icon of manifest.icons) {
    const size = Number(icon.sizes.split('x')[0])
    const maskable = (icon.purpose ?? '').split(' ').includes('maskable')
    await rasteriseLogo(chromium, svg, {
      target: join(TARGET_DIR, icon.src.replace(/^\//, '')),
      size,
      ...(maskable ? { background: manifest.background_color, inset: MASKABLE_INSET } : {})
    })
    console.log(`Wrote mobile/public${icon.src} (${size}x${size}${maskable ? ', maskable' : ''})`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
