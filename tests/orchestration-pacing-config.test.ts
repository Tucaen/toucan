import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  DEFAULT_ORCHESTRATION_PACING_CONFIG,
  loadOrchestrationPacingConfig,
  parseOrchestrationPacingConfig
} from '../src/main/orchestration-pacing-config'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'toucan-orchestration-pacing-config-'))

test('a missing pacing config uses and writes the documented defaults', async () => {
  const loaded = await loadOrchestrationPacingConfig({ userDataPath: fresh() })
  assert.equal(loaded.config?.enabled, false)
  assert.deepEqual(loaded.config, DEFAULT_ORCHESTRATION_PACING_CONFIG)
  assert.equal(loaded.error, undefined)
  assert.deepEqual(JSON.parse(readFileSync(loaded.path, 'utf8')), DEFAULT_ORCHESTRATION_PACING_CONFIG)
})

test('pacing can be disabled and each threshold can be adjusted', () => {
  assert.deepEqual(
    parseOrchestrationPacingConfig({
      enabled: false,
      fiveHour: { drainAtPercent: 60, pauseAtPercent: 90 },
      unavailableUsage: { maxActiveTicketSessions: 2 }
    }),
    {
      config: {
        enabled: false,
        fiveHour: { drainAtPercent: 60, pauseAtPercent: 90 },
        unavailableUsage: { maxActiveTicketSessions: 2 }
      }
    }
  )
})

test('partial pacing config inherits defaults and invalid config is refused', () => {
  assert.deepEqual(parseOrchestrationPacingConfig({ enabled: false }), {
    config: { ...DEFAULT_ORCHESTRATION_PACING_CONFIG, enabled: false }
  })
  assert.match(parseOrchestrationPacingConfig({ enabled: 'yes' }).error!, /enabled must be a boolean/)
  assert.match(
    parseOrchestrationPacingConfig({ fiveHour: { drainAtPercent: 90, pauseAtPercent: 80 } }).error!,
    /drainAtPercent must not exceed .*pauseAtPercent/
  )
  assert.match(parseOrchestrationPacingConfig({ surprise: true }).error!, /unknown field "surprise"/)
  assert.match(
    parseOrchestrationPacingConfig({ unavailableUsage: { maxActiveTicketSessions: -1 } }).error!,
    /non-negative integer/
  )
})

test('a damaged config is not replaced and enforcement has no usable config', async () => {
  const userDataPath = fresh()
  const first = await loadOrchestrationPacingConfig({ userDataPath })
  writeFileSync(first.path, '{ nope')
  const broken = await loadOrchestrationPacingConfig({ userDataPath })
  assert.equal(broken.config, undefined)
  assert.match(broken.error!, /not valid JSON/)
  assert.equal(readFileSync(first.path, 'utf8'), '{ nope')
})
