import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMainLog } from '../src/main/main-log'

const scratchDirectory = (): string => mkdtempSync(join(tmpdir(), 'toucan-main-log-'))

test('a scoped line reaches both the console and the log file, stamped with the time', async () => {
  const file = join(scratchDirectory(), 'logs', 'main.log')
  const console: string[] = []
  const log = createMainLog({
    file,
    now: () => new Date('2026-09-07T10:00:00.000Z'),
    console: (line) => console.push(line)
  })

  log('claude usage')('usage read failed: spawn ENOENT')
  log('update')('Update check failed: offline')
  await log.flush()

  assert.deepEqual(console, ['[claude usage] usage read failed: spawn ENOENT', '[update] Update check failed: offline'])
  assert.equal(
    readFileSync(file, 'utf8'),
    '2026-09-07T10:00:00.000Z [claude usage] usage read failed: spawn ENOENT\n2026-09-07T10:00:00.000Z [update] Update check failed: offline\n'
  )
})

test('an unwritable log file costs the console line nothing', async () => {
  const console: string[] = []
  const log = createMainLog({
    file: join(scratchDirectory(), 'not-a-directory.txt', 'main.log'),
    console: (line) => console.push(line),
    append: () => Promise.reject(new Error('EACCES'))
  })

  log('voice model')('download failed')
  await log.flush()

  assert.deepEqual(console, ['[voice model] download failed'])
})

test('a file past its size cap is rolled aside once so a repeating failure cannot grow it forever', async () => {
  const file = join(scratchDirectory(), 'main.log')
  const log = createMainLog({ file, maxBytes: 120, console: () => undefined })

  for (let index = 0; index < 5; index += 1) log('claude usage')(`usage read failed: attempt ${index}`)
  await log.flush()

  const kept = readFileSync(file, 'utf8')
  const rolled = readFileSync(`${file}.1`, 'utf8')
  assert.ok(kept.length <= 120 + 80, `the live file is bounded, was ${kept.length}`)
  assert.match(kept, /attempt 4/)
  assert.match(rolled, /attempt 3/)
  assert.doesNotMatch(rolled, /attempt 0/, 'older generations are dropped, not accumulated')
  assert.ok(!existsSync(`${file}.2`), 'only one previous generation is kept')
})
