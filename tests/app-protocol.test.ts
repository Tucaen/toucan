import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { APP_INDEX_URL, appContentType, appRequestTarget } from '../src/main/app-protocol'

/**
 * The origin a packaged renderer runs on. Two things are load-bearing and easy to lose: the model
 * files come from the host's store rather than from beside the bundle, and nothing served may
 * climb out of either directory. The content types matter just as much - Chromium refuses a module
 * script or a streaming WebAssembly compile on a guessed type, and a custom scheme has no server
 * to label its responses.
 */

const url = (path: string): string => `toucan://app${path}`

describe('appRequestTarget', () => {
  test('answers the model directory from the host store and everything else from the bundle', () => {
    assert.deepEqual(appRequestTarget(url('/models/moonshine-medium-streaming-en/encoder.ort')), {
      kind: 'model',
      name: 'encoder.ort'
    })
    assert.deepEqual(appRequestTarget(url('/index.html')), { kind: 'renderer', path: 'index.html' })
    assert.deepEqual(appRequestTarget(url('/assets/index-abc.js')), { kind: 'renderer', path: 'assets/index-abc.js' })
  })

  test('serves the index for the origin root, which is what a reload of the app URL asks for', () => {
    assert.deepEqual(appRequestTarget(url('/')), { kind: 'renderer', path: 'index.html' })
    assert.deepEqual(appRequestTarget(APP_INDEX_URL), { kind: 'renderer', path: 'index.html' })
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
    assert.deepEqual(appRequestTarget(url('/../secrets.txt')), { kind: 'renderer', path: 'secrets.txt' })
    assert.deepEqual(appRequestTarget(url('/assets/../../secrets.txt')), { kind: 'renderer', path: 'secrets.txt' })
    assert.deepEqual(appRequestTarget(url('/assets/%2e%2e/%2e%2e/secrets.txt')), {
      kind: 'renderer',
      path: 'secrets.txt'
    })
    // A backslash is a separator on Windows, so a segment carrying one is nesting in disguise.
    assert.equal(appRequestTarget(url('/assets%5c..%5csecrets.txt')), null)
  })

  test('refuses a nested path or the directory itself inside the model directory', () => {
    assert.equal(appRequestTarget(url('/models/moonshine-medium-streaming-en/')), null)
    assert.equal(appRequestTarget(url('/models/moonshine-medium-streaming-en/sub/encoder.ort')), null)
  })
})

describe('appContentType', () => {
  test('labels the types Chromium refuses to guess for', () => {
    assert.equal(appContentType('C:\\out\\renderer\\assets\\index.js'), 'text/javascript; charset=utf-8')
    assert.equal(appContentType('moonshine.wasm'), 'application/wasm')
    assert.equal(appContentType('index.html'), 'text/html; charset=utf-8')
    assert.equal(appContentType('streaming_config.json'), 'application/json; charset=utf-8')
  })

  test('leaves the model weights to the default, which is all they need', () => {
    assert.equal(appContentType('encoder.ort'), null)
    assert.equal(appContentType('tokenizer.bin'), null)
  })
})
