import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { MAIN_WINDOW_CHROME } from '../src/main/window-chrome'

/**
 * The native title bar is hidden and Windows draws only its caption buttons, over the app header.
 * The overlay's height and colour are main-process constants while the header they sit on is CSS,
 * so this pins the two together: a header that changes height or colour alone would leave the
 * buttons floating off its edge or on a visibly different band.
 */

// The stylesheet is saved with a BOM, which would otherwise hide its first rule from `rule` (`trimStart` counts it as whitespace).
const styles = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8').trimStart()

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(styles)
  assert.ok(match, `styles.css has no \`${selector}\` rule`)
  return match[1]
}

function declaration(block: string, property: string): string | undefined {
  return new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(block)?.[1].trim()
}

describe('main window chrome', () => {
  test('hides the native title bar but keeps the Windows caption buttons', () => {
    assert.equal(MAIN_WINDOW_CHROME.titleBarStyle, 'hidden')
    assert.equal(typeof MAIN_WINDOW_CHROME.titleBarOverlay, 'object')
    assert.ok(!('frame' in MAIN_WINDOW_CHROME))
  })

  test('the caption-button overlay matches the header it sits on', () => {
    const overlay = MAIN_WINDOW_CHROME.titleBarOverlay
    assert.ok(typeof overlay === 'object')
    const header = rule('.app-header')
    // One pixel short of the header, so the band stops above its bottom border instead of
    // painting over it where the buttons sit.
    assert.equal(declaration(header, 'border-bottom'), '1px solid var(--neutral-800)')
    assert.equal(declaration(header, 'height'), `${overlay.height + 1}px`)
    assert.equal(declaration(header, 'background'), overlay.color)
    assert.equal(declaration(rule(':root'), '--neutral-100'), overlay.symbolColor)
  })

  test('the header drags the window and its controls stay clickable', () => {
    assert.equal(declaration(rule('.app-header'), '-webkit-app-region'), 'drag')
    assert.equal(declaration(rule('.header-target > *'), '-webkit-app-region'), 'no-drag')
  })

  test('the header clears the caption buttons Windows draws over its right edge', () => {
    assert.match(declaration(rule('.app-header'), 'padding-right') ?? '', /env\(titlebar-area-width/)
  })
})
