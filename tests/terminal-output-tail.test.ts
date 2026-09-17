import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createTerminalOutputTails } from '../src/main/terminal-output-tail'

test('a first read returns the whole retained tail and is labelled as such', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'building\nready\n')

  const read = tails.read('agent-1', 'term-1')

  assert.deepEqual(read, { incarnationId: 'inc-1', text: 'building\nready\n', delta: false, skippedBytes: 0 })
})

test('an unknown terminal reads as nothing at all rather than as empty output', () => {
  const tails = createTerminalOutputTails()

  assert.equal(tails.read('agent-1', 'term-1'), undefined)
})

test('a repeat read returns only what arrived since the last one, per agent session', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'first\n')
  assert.equal(tails.read('agent-1', 'term-1')?.text, 'first\n')

  tails.append('term-1', 'inc-1', 'second\n')
  assert.deepEqual(tails.read('agent-1', 'term-1'), {
    incarnationId: 'inc-1',
    text: 'second\n',
    delta: true,
    skippedBytes: 0
  })
  // A second agent has its own cursor, so it still sees the run from the top.
  assert.deepEqual(tails.read('agent-2', 'term-1'), {
    incarnationId: 'inc-1',
    text: 'first\nsecond\n',
    delta: false,
    skippedBytes: 0
  })
})

test('a read with nothing new since the cursor is an empty delta, not a repeat of the tail', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'only\n')
  tails.read('agent-1', 'term-1')

  assert.deepEqual(tails.read('agent-1', 'term-1'), {
    incarnationId: 'inc-1',
    text: '',
    delta: true,
    skippedBytes: 0
  })
})

test('a new incarnation resets the cursor, because its byte 0 is not the old process’s', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'old run\n')
  tails.read('agent-1', 'term-1')

  tails.begin('term-1', 'inc-2')
  tails.append('term-1', 'inc-2', 'new run\n')

  assert.deepEqual(tails.read('agent-1', 'term-1'), {
    incarnationId: 'inc-2',
    text: 'new run\n',
    delta: false,
    skippedBytes: 0
  })
})

test('retention drops the oldest output and the next read says how much it never saw', () => {
  const tails = createTerminalOutputTails({ maxRetainedBytes: 10 })
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'aaaaaaaaaa\n')
  tails.read('agent-1', 'term-1')
  tails.append('term-1', 'inc-1', 'bbbbbbbbbb\ncccc\n')

  const read = tails.read('agent-1', 'term-1')

  assert.equal(read?.delta, true)
  assert.equal(read?.text, 'bbbb\ncccc\n')
  // Only the last 10 of the run's 27 bytes are retained; the cursor stood at 11, so 6 fell out.
  assert.equal(read?.skippedBytes, 6)
})

test('the per-read byte cap returns the newest output and reports the bytes it skipped', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'aaaa\nbbbb\ncccc\n')

  const read = tails.read('agent-1', 'term-1', { maxBytes: 5 })

  assert.equal(read?.text, 'cccc\n')
  assert.equal(read?.skippedBytes, 10)
})

test('the per-read line cap keeps the last lines and the byte cap still binds', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'one\ntwo\nthree\nfour')

  assert.equal(tails.read('agent-1', 'term-1', { maxLines: 2 })?.text, 'three\nfour')
})

test('a size override cannot exceed what is retained', () => {
  const tails = createTerminalOutputTails({ maxRetainedBytes: 8 })
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'aaaaaaaaaaaaaaaa')

  const read = tails.read('agent-1', 'term-1', { maxBytes: 1024 })

  assert.equal(read?.text.length, 8)
})

test('output is stored raw and stripped of control sequences only when it is served', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', '\u001B[32mPASS\u001B[0m a.test.ts\n10%\r55%\r100%\n')

  assert.equal(tails.read('agent-1', 'term-1')?.text, 'PASS a.test.ts\n100%\n')
})

test('retention never splits a multi-byte character', () => {
  const tails = createTerminalOutputTails({ maxRetainedBytes: 5 })
  tails.begin('term-1', 'inc-1')
  // 17 bytes in total, so the tail is trimmed back to its last 5 - which lands inside 'ä'.
  tails.append('term-1', 'inc-1', 'abcdefghij')
  tails.append('term-1', 'inc-1', 'xäöü')

  assert.equal(tails.read('agent-1', 'term-1')?.text, 'öü')
})

test('a trailing newline terminates the last line rather than counting as another one', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'one\ntwo\nthree\n')

  assert.equal(tails.read('agent-1', 'term-1', { maxLines: 1 })?.text, 'three\n')
  tails.append('term-1', 'inc-1', 'four\nfive\n')
  assert.equal(tails.read('agent-1', 'term-1', { maxLines: 2 })?.text, 'four\nfive\n')
})

test('output for a foreign incarnation is ignored, so a dying process cannot write into its successor', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.begin('term-1', 'inc-2')
  tails.append('term-1', 'inc-1', 'from the old process\n')
  tails.append('term-1', 'inc-2', 'from the new one\n')

  assert.equal(tails.read('agent-1', 'term-1')?.text, 'from the new one\n')
})

test('forgetting a session drops its tail and its cursors', () => {
  const tails = createTerminalOutputTails()
  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'gone\n')
  tails.read('agent-1', 'term-1')
  tails.forget('term-1')

  assert.equal(tails.read('agent-1', 'term-1'), undefined)

  tails.begin('term-1', 'inc-1')
  tails.append('term-1', 'inc-1', 'again\n')
  assert.deepEqual(tails.read('agent-1', 'term-1'), {
    incarnationId: 'inc-1',
    text: 'again\n',
    delta: false,
    skippedBytes: 0
  })
})
