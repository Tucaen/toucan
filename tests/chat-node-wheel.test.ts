import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

// The canvas only zooms on Ctrl/Cmd + wheel (see App.tsx's ReactFlow props), so a plain wheel over a
// chat node is already the node's own to scroll with - nothing inside one has to fight the canvas
// for it any more. Holding the gesture back now costs the zoom instead: React Flow filters every
// wheel raised inside a `nowheel` subtree, Ctrl-held ones included. The auth panel, the
// pending-decision strip and the structured decision card are all scrollable and all awkward to
// render in isolation, so the rule is held over the files rather than one surface at a time. The
// find bar joins them because it has nothing to scroll, and so nothing to claim the gesture for.
const CHAT_SURFACES = ['ChatNode.tsx', 'StructuredDecisionPanel.tsx', 'FindBar.tsx']

for (const file of CHAT_SURFACES) {
  test(`no surface in ${file} opts itself out of the canvas wheel`, () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/src', file), 'utf8')

    assert.doesNotMatch(source, /\bnowheel\b/)
  })
}
