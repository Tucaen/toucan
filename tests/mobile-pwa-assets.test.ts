import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SERVICE_WORKER_PATH } from '../mobile/src/install-support'

/**
 * The installability contract, checked against the committed files rather than described in prose.
 *
 * Chrome decides whether to offer "Install app" from the manifest and its icons, and it decides it
 * silently: a manifest that parses but declares no large-enough icon, or an icon whose file is not
 * there, produces no error the phone shows anyone - the install prompt simply never appears. So
 * these assertions exist to keep that verdict from regressing invisibly, and they read the real
 * bytes: an icon's declared `sizes` is compared with the PNG header's own dimensions, because a
 * copied-and-edited entry is exactly how those two drift apart.
 */

const ROOT = process.cwd()
const PUBLIC_DIR = join(ROOT, 'mobile/public')

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: string
}

const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8')) as {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  background_color: string
  icons: ManifestIcon[]
}
const indexHtml = readFileSync(join(ROOT, 'mobile/index.html'), 'utf8')

/** Width and height straight out of the PNG's IHDR chunk, which is always the first one. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${path} is not a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the web app manifest', () => {
  test('launches standalone from the origin root, which is where the chat list lives', () => {
    assert.equal(manifest.display, 'standalone')
    assert.equal(manifest.start_url, '/')
    // The whole client is one origin-root scope, so an installed window keeps every deep link.
    assert.equal(manifest.scope, '/')
  })

  test('names the app the way the desktop does', () => {
    assert.equal(manifest.short_name, 'Toucan')
    assert.match(manifest.name, /Toucan/)
  })

  test("its colours are the page's, so the splash screen does not flash a different app", () => {
    const themeColor = /<meta name="theme-color" content="([^"]+)"/.exec(indexHtml)?.[1]
    assert.equal(manifest.theme_color, themeColor)
    assert.equal(manifest.background_color, themeColor)
  })

  test('declares the icon sizes Chrome requires before it offers to install', () => {
    const any = manifest.icons.filter((icon) => (icon.purpose ?? 'any').split(' ').includes('any'))
    const largest = Math.max(...any.map((icon) => Number(icon.sizes.split('x')[0])))
    assert.ok(largest >= 512, `largest installable icon is ${largest}px`)
    assert.ok(
      any.some((icon) => Number(icon.sizes.split('x')[0]) >= 192),
      'no icon of at least 192px'
    )
  })

  test('ships a maskable icon, or Android crops the logo into its adaptive shape', () => {
    const maskable = manifest.icons.filter((icon) => (icon.purpose ?? '').split(' ').includes('maskable'))
    assert.ok(maskable.length > 0, 'no maskable icon')
    for (const icon of maskable) assert.ok(Number(icon.sizes.split('x')[0]) >= 512)
  })

  test('every declared icon is a file that exists, at the size it claims', () => {
    for (const icon of manifest.icons) {
      assert.equal(icon.type, 'image/png')
      assert.ok(icon.src.startsWith('/'), `${icon.src} is not an absolute path`)
      const [width, height] = icon.sizes.split('x').map(Number)
      assert.deepEqual(pngSize(join(PUBLIC_DIR, icon.src.slice(1))), { width, height }, `${icon.src} size mismatch`)
    }
  })
})

describe('the page that pulls it in', () => {
  test('links the manifest at an absolute path, because the client is served at the origin root', () => {
    assert.match(indexHtml, /<link rel="manifest" href="\/manifest\.webmanifest"/)
  })

  test('offers an apple-touch-icon too, since iOS ignores the manifest icons', () => {
    const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(indexHtml)?.[1]
    assert.ok(href, 'no apple-touch-icon')
    assert.ok(pngSize(join(PUBLIC_DIR, href.slice(1))).width >= 180)
  })

  test('the worker is registered from the bundle, never inline: a page load must not depend on it', () => {
    assert.equal(indexHtml.includes('serviceWorker'), false)
    assert.equal(SERVICE_WORKER_PATH, '/sw.js')
  })
})
