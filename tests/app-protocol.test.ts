import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { APP_INDEX_URL, APP_ISOLATION_HEADERS, appContentType, appRequestTarget } from '../src/main/app-protocol'

/**
 * The origin a packaged renderer runs on. Two things are load-bearing and easy to lose: nothing
 * served may climb out of the renderer directory, and the content types matter - Chromium refuses
 * a module script or a streaming WebAssembly compile on a guessed type, and a custom scheme has no
 * server to label its responses.
 */

const url = (path: string): string => `toucan://app${path}`

describe('appRequestTarget', () => {
  test('answers bundle paths and serves the index for the origin root', () => {
    assert.equal(appRequestTarget(url('/index.html')), 'index.html')
    assert.equal(appRequestTarget(url('/assets/index-abc.js')), 'assets/index-abc.js')
    assert.equal(appRequestTarget(url('/')), 'index.html')
    assert.equal(appRequestTarget(APP_INDEX_URL), 'index.html')
  })

  test('refuses another scheme, another host and anything that is not a URL', () => {
    assert.equal(appRequestTarget('file:///C:/out/renderer/index.html'), null)
    assert.equal(appRequestTarget('https://app/index.html'), null)
    assert.equal(appRequestTarget('toucan://elsewhere/index.html'), null)
    assert.equal(appRequestTarget('not a url'), null)
  })

  test('never lets a request out of the directory it is served from', () => {
    // A standard scheme resolves dot-segments - percent-encoded ones included - before the handler
    // sees the path, so every climb lands inside the bundle rather than above it.
    assert.equal(appRequestTarget(url('/../secrets.txt')), 'secrets.txt')
    assert.equal(appRequestTarget(url('/assets/../../secrets.txt')), 'secrets.txt')
    assert.equal(appRequestTarget(url('/assets/%2e%2e/%2e%2e/secrets.txt')), 'secrets.txt')
    // A backslash is a separator on Windows, so a segment carrying one is nesting in disguise.
    assert.equal(appRequestTarget(url('/assets%5c..%5csecrets.txt')), null)
  })
})

describe('appContentType', () => {
  test('labels the types Chromium refuses to guess for', () => {
    assert.equal(appContentType('C:\\out\\renderer\\assets\\index.js'), 'text/javascript; charset=utf-8')
    assert.equal(appContentType('module.wasm'), 'application/wasm')
    assert.equal(appContentType('index.html'), 'text/html; charset=utf-8')
    assert.equal(appContentType('manifest.json'), 'application/json; charset=utf-8')
  })

  test('leaves unknown extensions to the default, which is all they need', () => {
    assert.equal(appContentType('font.ttf'), null)
    assert.equal(appContentType('README'), null)
  })
})

describe('APP_ISOLATION_HEADERS', () => {
  test('the dev server is isolated the same way the packaged origin is', () => {
    // Two config blocks, two processes, one property: a renderer that only becomes
    // cross-origin-isolated in one of them fails in whichever the author was not running.
    // electron.vite.config.ts says these must keep matching, so something has to check it.
    const config = readFileSync(join(process.cwd(), 'electron.vite.config.ts'), 'utf8')
    for (const header of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'] as const) {
      assert.match(
        config,
        new RegExp(`'${header}': '${APP_ISOLATION_HEADERS[header]}'`),
        `the dev server must serve ${header}: ${APP_ISOLATION_HEADERS[header]}`
      )
    }
    // `require-corp` is what makes the other two load-bearing rather than decorative.
    assert.equal(APP_ISOLATION_HEADERS['Cross-Origin-Embedder-Policy'], 'require-corp')
  })
})
