import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  FIRSTMATE_CANVAS_MIN_WIDTH,
  FIRSTMATE_PANEL_MIN_WIDTH,
  firstMatePanelWidthBounds,
  resizeFirstMatePanel,
  resizeFirstMatePanelWithKey
} from '../src/renderer/src/firstmate-panel-resize'

test('dragging the FirstMate divider left grows the panel and dragging right shrinks it', () => {
  const bounds = firstMatePanelWidthBounds(1200)
  const session = { startX: 830, startWidth: 370, bounds }

  assert.equal(resizeFirstMatePanel(session, 750), 450)
  assert.equal(resizeFirstMatePanel(session, 890), 310)
})

test('panel resizing clamps both sides to usable bounds', () => {
  const bounds = firstMatePanelWidthBounds(900)
  const session = { startX: 530, startWidth: 370, bounds }

  assert.equal(bounds.min, FIRSTMATE_PANEL_MIN_WIDTH)
  assert.equal(bounds.max, 900 - FIRSTMATE_CANVAS_MIN_WIDTH)
  assert.equal(resizeFirstMatePanel(session, -1000), bounds.max)
  assert.equal(resizeFirstMatePanel(session, 1000), bounds.min)
})

test('a wide workspace lets the panel grow past the old fixed ceiling, bounded only by the canvas minimum', () => {
  const bounds = firstMatePanelWidthBounds(3000)

  assert.equal(bounds.max, 3000 - FIRSTMATE_CANVAS_MIN_WIDTH)
  assert.ok(bounds.max > 720, 'panel should be able to exceed the old fixed 720px ceiling')

  const session = { startX: 830, startWidth: 370, bounds }
  assert.equal(resizeFirstMatePanel(session, -10_000), bounds.max)
})

test('the canvas minimum width is always preserved, however wide the workspace is', () => {
  for (const workspaceWidth of [900, 1600, 3000, 8000]) {
    const bounds = firstMatePanelWidthBounds(workspaceWidth)
    assert.equal(bounds.max, workspaceWidth - FIRSTMATE_CANVAS_MIN_WIDTH)
  }
})

test('the divider supports bounded keyboard resizing', () => {
  const bounds = firstMatePanelWidthBounds(1200)

  assert.equal(resizeFirstMatePanelWithKey(370, 'ArrowLeft', bounds), 386)
  assert.equal(resizeFirstMatePanelWithKey(370, 'ArrowRight', bounds), 354)
  assert.equal(resizeFirstMatePanelWithKey(370, 'Home', bounds), bounds.min)
  assert.equal(resizeFirstMatePanelWithKey(370, 'End', bounds), bounds.max)
  assert.equal(resizeFirstMatePanelWithKey(370, 'Enter', bounds), undefined)
})
