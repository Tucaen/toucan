import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { composerKeyAction, type ComposerKeyContext, type ComposerKeyEvent } from '../src/renderer/src/composer-keys'

function key(name: string, modifiers: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent {
  return { key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

function context(overrides: Partial<ComposerKeyContext> = {}): ComposerKeyContext {
  return { sendKey: 'enter', draft: 'hello', historyActive: false, ...overrides }
}

test('with the enter preference, a bare Enter sends and Shift+Enter inserts a newline', () => {
  assert.equal(composerKeyAction(key('Enter'), context()), 'send')
  assert.equal(composerKeyAction(key('Enter', { shiftKey: true }), context()), 'newline')
})

test('with the mod-enter preference the two are exactly reversed', () => {
  const modEnter = context({ sendKey: 'mod-enter' })
  assert.equal(composerKeyAction(key('Enter'), modEnter), 'newline')
  assert.equal(composerKeyAction(key('Enter', { shiftKey: true }), modEnter), 'newline')
  assert.equal(composerKeyAction(key('Enter', { ctrlKey: true }), modEnter), 'send')
  assert.equal(composerKeyAction(key('Enter', { metaKey: true }), modEnter), 'send')
})

test('Ctrl/Cmd+Enter also sends under the enter preference, so that muscle memory never inserts a stray newline', () => {
  assert.equal(composerKeyAction(key('Enter', { ctrlKey: true }), context()), 'send')
  assert.equal(composerKeyAction(key('Enter', { metaKey: true }), context()), 'send')
})

test('Alt+Enter is always a newline, under either preference', () => {
  assert.equal(composerKeyAction(key('Enter', { altKey: true }), context()), 'newline')
  assert.equal(composerKeyAction(key('Enter', { altKey: true }), context({ sendKey: 'mod-enter' })), 'newline')
})

test('an IME composition Enter is never a send', () => {
  assert.equal(composerKeyAction(key('Enter', { isComposing: true }), context()), 'none')
})

test('ArrowUp walks prompt history only from an empty composer', () => {
  assert.equal(composerKeyAction(key('ArrowUp'), context({ draft: '' })), 'history-previous')
  assert.equal(composerKeyAction(key('ArrowUp'), context({ draft: 'half-typed' })), 'none')
})

test('once history is being walked, both arrows keep navigating even though the draft is no longer empty', () => {
  const walking = context({ draft: 'a recalled prompt', historyActive: true })
  assert.equal(composerKeyAction(key('ArrowUp'), walking), 'history-previous')
  assert.equal(composerKeyAction(key('ArrowDown'), walking), 'history-next')
})

test('ArrowDown does nothing unless history is being walked, so it stays a plain caret move', () => {
  assert.equal(composerKeyAction(key('ArrowDown'), context({ draft: '' })), 'none')
})

test('a modified arrow is left to the browser as an ordinary text-editing gesture', () => {
  assert.equal(composerKeyAction(key('ArrowUp', { shiftKey: true }), context({ draft: '' })), 'none')
  assert.equal(composerKeyAction(key('ArrowUp', { altKey: true }), context({ draft: '', historyActive: true })), 'none')
})

test('Escape leaves history and restores whatever was being typed before it started', () => {
  assert.equal(composerKeyAction(key('Escape'), context({ historyActive: true })), 'history-cancel')
  assert.equal(composerKeyAction(key('Escape'), context()), 'none')
})
