// Rasterises the canonical Toucan logo into the PNG electron-builder stamps onto the
// Windows executable and its installers. Kept as a script rather than a committed-only
// asset so the icon can be regenerated whenever the vector changes.
//
// Rasterises through a headless Chromium (Edge/Chrome, present on every Windows 11 box)
// rather than booting Electron: no GUI window, no dependency on a working electron/dist,
// and no native image library. Override with CHROMIUM=/path/to/chrome if neither default
// is installed.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/renderer/src/assets/toucan-logo.svg')
const TARGET = join(ROOT, 'build/icon.png')
/** electron-builder derives every smaller Windows icon size from this one. */
const SIZE = 512

const CANDIDATES = [
  process.env.CHROMIUM,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter((path) => typeof path === 'string' && existsSync(path))

function resolveChromium() {
  const chromium = CANDIDATES[0]
  if (!chromium) throw new Error('No headless Chromium found. Set CHROMIUM to a Chrome or Edge binary.')
  return chromium
}

async function main() {
  const chromium = resolveChromium()
  const svg = await readFile(SOURCE, 'utf8')
  const page = join(ROOT, 'build/.icon-source.html')

  await mkdir(dirname(TARGET), { recursive: true })
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent}
      svg{display:block;width:${SIZE}px;height:${SIZE}px}
    </style>${svg}`
  )

  const result = spawnSync(
    chromium,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      // Transparent ground: the logo must sit on light and dark taskbars alike.
      '--default-background-color=00000000',
      `--window-size=${SIZE},${SIZE}`,
      `--screenshot=${TARGET}`,
      page
    ],
    { stdio: 'inherit' }
  )
  await rm(page, { force: true })

  if (result.status !== 0) throw new Error(`${chromium} exited with ${result.status}`)
  if (!existsSync(TARGET)) throw new Error(`${chromium} produced no screenshot`)
  console.log(`Wrote build/icon.png (${SIZE}x${SIZE}) from ${chromium}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
