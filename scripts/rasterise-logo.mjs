// Turns the canonical Toucan logo SVG into a PNG of a given size, shared by every icon the
// project generates: the one electron-builder stamps onto the Windows executable and the set the
// phone client's web app manifest points at.
//
// Rasterises through a headless Chromium (Edge/Chrome, present on every Windows 11 box) rather
// than booting Electron: no GUI window, no dependency on a working electron/dist, and no native
// image library. Override with CHROMIUM=/path/to/chrome if neither default is installed.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const LOGO = join(ROOT, 'src/renderer/src/assets/toucan-logo.svg')

const CANDIDATES = [
  process.env.CHROMIUM,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter((path) => typeof path === 'string' && existsSync(path))

export function resolveChromium() {
  const chromium = CANDIDATES[0]
  if (!chromium) throw new Error('No headless Chromium found. Set CHROMIUM to a Chrome or Edge binary.')
  return chromium
}

/**
 * Screenshots the logo into `target` at `size` square.
 *
 * `background` defaults to transparent, because the desktop icon has to sit on light and dark
 * taskbars alike; an opaque one is what a maskable icon needs, since the launcher crops it.
 * `inset` shrinks the logo inside the canvas by that fraction on every side - Android's maskable
 * safe zone is the middle 80%, so a full-bleed logo would lose its beak to an adaptive shape.
 */
export async function rasteriseLogo(chromium, svg, { target, size, background = 'transparent', inset = 0 }) {
  const margin = Math.round(size * inset)
  const logo = size - margin * 2
  const page = `${target}.source.html`

  await mkdir(dirname(target), { recursive: true })
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;width:${size}px;height:${size}px;background:${background}}
      body{display:flex;align-items:center;justify-content:center}
      svg{display:block;width:${logo}px;height:${logo}px}
    </style>${svg}`
  )

  const result = spawnSync(
    chromium,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      // Transparent ground unless the page above painted one of its own.
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${target}`,
      page
    ],
    { stdio: 'inherit' }
  )
  await rm(page, { force: true })

  if (result.status !== 0) throw new Error(`${chromium} exited with ${result.status}`)
  if (!existsSync(target)) throw new Error(`${chromium} produced no screenshot for ${target}`)
}
