import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { isRecord } from '../src/shared/record'

// The guard four parsers now share. Its whole content is what it refuses.

test('a plain object is a record', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord({ hosts: [] }), true)
  assert.equal(isRecord(Object.create(null)), true)
})

test('an array is not a record, so a wrong-shape payload cannot read as a missing field', () => {
  assert.equal(isRecord([]), false)
  assert.equal(isRecord([{ id: 'a' }]), false)
})

test('nothing else is a record either', () => {
  for (const value of [null, undefined, 0, '', 'hosts', true, Symbol('x'), () => {}])
    assert.equal(isRecord(value), false, String(value?.toString()))
})
