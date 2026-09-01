import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { unscalePointerCoordinates } from '../src/renderer/src/scaled-pointer-coordinates'

test('maps viewport pointer coordinates back into a uniformly scaled terminal', () => {
  assert.deepEqual(
    unscalePointerCoordinates(
      { clientX: 250, clientY: 140 },
      { left: 100, top: 50, width: 300, height: 180 },
      { width: 600, height: 360 }
    ),
    { clientX: 400, clientY: 230 }
  )
})

test('leaves pointer coordinates unchanged at native scale', () => {
  assert.deepEqual(
    unscalePointerCoordinates(
      { clientX: 250, clientY: 140 },
      { left: 100, top: 50, width: 600, height: 360 },
      { width: 600, height: 360 }
    ),
    { clientX: 250, clientY: 140 }
  )
})
