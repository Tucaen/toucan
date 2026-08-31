import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import {
  BRAIN_DUMP_PANEL_DEFAULT_WIDTH,
  BRAIN_DUMP_PANEL_MAX_WIDTH,
  BRAIN_DUMP_PANEL_MIN_WIDTH,
  brainDumpPanelBounds,
  brainDumpPanelKeyAction,
  brainDumpPanelMode,
  brainDumpPanelWidthFromPointer,
  clampBrainDumpPanelWidth
} from '../src/renderer/src/brain-dump-panel-layout'

// The docked panel consumes workspace width instead of overlaying the canvas, so these bounds are
// what keep a restored width from squeezing the canvas out of a smaller window.

const key = (
  overrides: Partial<Parameters<typeof brainDumpPanelKeyAction>[0]>
): Parameters<typeof brainDumpPanelKeyAction>[0] => ({
  key: 'b',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides
})

test('a comfortable window allows the full documented width range', () => {
  deepEqual(brainDumpPanelBounds(1920), { min: BRAIN_DUMP_PANEL_MIN_WIDTH, max: BRAIN_DUMP_PANEL_MAX_WIDTH })
})

test('the panel never takes more than 70% of a narrower workspace', () => {
  equal(brainDumpPanelBounds(1000).max, 700)
})

test('a workspace too small for the share still offers the minimum width', () => {
  equal(brainDumpPanelBounds(500).max, BRAIN_DUMP_PANEL_MIN_WIDTH)
})

test('an unknown workspace width falls back to the absolute bounds', () => {
  deepEqual(brainDumpPanelBounds(0), { min: BRAIN_DUMP_PANEL_MIN_WIDTH, max: BRAIN_DUMP_PANEL_MAX_WIDTH })
  deepEqual(brainDumpPanelBounds(Number.NaN), { min: BRAIN_DUMP_PANEL_MIN_WIDTH, max: BRAIN_DUMP_PANEL_MAX_WIDTH })
})

test('a width persisted from a wider window is clamped into the current one', () => {
  equal(clampBrainDumpPanelWidth(900, 1000), 700)
})

test('clamping keeps a usable width and rounds fractional drags', () => {
  equal(clampBrainDumpPanelWidth(120, 1920), BRAIN_DUMP_PANEL_MIN_WIDTH)
  equal(clampBrainDumpPanelWidth(1400, 1920), BRAIN_DUMP_PANEL_MAX_WIDTH)
  equal(clampBrainDumpPanelWidth(700.4, 1920), 700)
})

test('an unusable persisted width falls back to the comfortable default', () => {
  equal(clampBrainDumpPanelWidth(Number.NaN, 1920), BRAIN_DUMP_PANEL_DEFAULT_WIDTH)
  equal(clampBrainDumpPanelWidth(-10, 1920), BRAIN_DUMP_PANEL_DEFAULT_WIDTH)
})

test('the panel shows both columns only once they both stay readable', () => {
  equal(brainDumpPanelMode(BRAIN_DUMP_PANEL_DEFAULT_WIDTH), 'wide')
  equal(brainDumpPanelMode(640), 'wide')
  equal(brainDumpPanelMode(639), 'narrow')
  equal(brainDumpPanelMode(BRAIN_DUMP_PANEL_MIN_WIDTH), 'narrow')
})

test('a left-edge drag measures the width back from the workspace right edge', () => {
  equal(brainDumpPanelWidthFromPointer(1200, 1920, 1920), 720)
  equal(brainDumpPanelWidthFromPointer(1900, 1920, 1920), BRAIN_DUMP_PANEL_MIN_WIDTH)
  equal(brainDumpPanelWidthFromPointer(100, 1920, 1920), BRAIN_DUMP_PANEL_MAX_WIDTH)
})

test('Ctrl+Shift+B toggles the panel from anywhere', () => {
  equal(
    brainDumpPanelKeyAction(key({ ctrlKey: true, shiftKey: true }), { panelOpen: false, editingText: false }),
    'toggle-panel'
  )
  equal(
    brainDumpPanelKeyAction(key({ key: 'B', ctrlKey: true, shiftKey: true }), { panelOpen: true, editingText: true }),
    'toggle-panel'
  )
})

test('the toggle ignores other modifier combinations', () => {
  equal(brainDumpPanelKeyAction(key({ ctrlKey: true }), { panelOpen: false, editingText: false }), 'none')
  equal(
    brainDumpPanelKeyAction(key({ ctrlKey: true, shiftKey: true, altKey: true }), {
      panelOpen: false,
      editingText: false
    }),
    'none'
  )
})

test('Ctrl+K reaches search only while the panel is open and no text field has the caret', () => {
  equal(
    brainDumpPanelKeyAction(key({ key: 'k', ctrlKey: true }), { panelOpen: true, editingText: false }),
    'focus-search'
  )
  equal(brainDumpPanelKeyAction(key({ key: 'k', ctrlKey: true }), { panelOpen: false, editingText: false }), 'none')
  equal(brainDumpPanelKeyAction(key({ key: 'k', ctrlKey: true }), { panelOpen: true, editingText: true }), 'none')
})
