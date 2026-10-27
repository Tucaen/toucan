import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { registerAppUpdateIpc } from '../src/main/app-update-ipc'
import type { AppUpdater } from '../src/main/app-update'
import { APP_UPDATE_CHANNELS } from '../src/shared/ipc-channels'
import { APP_UPDATE_IDLE } from '../src/shared/app-update'
import {
  backgroundTaskTotal,
  collectQuitActivity,
  createQuitGuard,
  describeQuitRisk,
  type QuitActivity,
  type QuitWarning
} from '../src/main/quit-guard'

const NOTHING: QuitActivity = { background: [], working: [] }

describe('describeQuitRisk', () => {
  it('says nothing when no session has anything at stake', () => {
    assert.equal(describeQuitRisk(NOTHING, 'quit'), null)
    assert.equal(describeQuitRisk(NOTHING, 'update'), null)
  })

  it('names the task count and the sessions running them', () => {
    const warning = describeQuitRisk(
      {
        background: [
          { name: 'API server', tasks: 2 },
          { name: 'Docs', tasks: 1 }
        ],
        working: []
      },
      'quit'
    )
    assert.ok(warning)
    assert.equal(warning.title, 'Quit Toucan?')
    assert.equal(warning.message, '3 background tasks still running in 2 sessions.')
    assert.match(warning.detail, /• API server/)
    assert.match(warning.detail, /• Docs/)
    assert.equal(warning.proceedLabel, 'Quit anyway')
  })

  it('uses the singular for one task in one session', () => {
    const warning = describeQuitRisk({ background: [{ name: 'A', tasks: 1 }], working: [] }, 'quit')
    assert.equal(warning?.message, '1 background task still running in 1 session.')
  })

  it('words the update restart as an update', () => {
    const warning = describeQuitRisk({ background: [{ name: 'A', tasks: 1 }], working: [] }, 'update')
    assert.equal(warning?.title, 'Restart to update?')
    assert.equal(warning?.proceedLabel, 'Restart anyway')
    assert.match(warning?.detail ?? '', /Restarting to install the update/)
  })

  it('warns about a mid-turn session that has no background tasks', () => {
    const warning = describeQuitRisk({ background: [], working: [{ name: 'Refactor', tasks: 0 }] }, 'quit')
    assert.equal(warning?.message, '1 session in the middle of a turn.')
    assert.match(warning?.detail ?? '', /Working:\n• Refactor/)
  })

  it('lists a session that is both only under background tasks', () => {
    const both = { name: 'Busy', tasks: 2 }
    const warning = describeQuitRisk({ background: [both], working: [both] }, 'quit')
    assert.equal(
      warning?.message,
      '2 background tasks still running in 1 session and 1 session in the middle of a turn.'
    )
    assert.doesNotMatch(warning?.detail ?? '', /Working:/)
  })

  it('caps the named sessions', () => {
    const background = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, tasks: 1 }))
    const warning = describeQuitRisk({ background, working: [] }, 'quit')
    assert.match(warning?.detail ?? '', /• s4/)
    assert.doesNotMatch(warning?.detail ?? '', /• s5/)
    assert.match(warning?.detail ?? '', /and 3 more/)
  })
})

describe('collectQuitActivity', () => {
  it('names sessions by canvas label and falls back to the short id', () => {
    const activity = collectQuitActivity(
      [
        { id: 'aaaaaaaa-1111', tasks: 2, byType: { local_bash: 2 } },
        { id: 'bbbbbbbb-2222', tasks: 1, byType: { local_agent: 1 } }
      ],
      ['aaaaaaaa-1111', 'cccccccc-3333'],
      (id) => (id === 'aaaaaaaa-1111' ? ' Server ' : undefined)
    )
    assert.deepEqual(activity.background, [
      { name: 'Server', tasks: 2 },
      { name: 'bbbbbbbb', tasks: 1 }
    ])
    assert.deepEqual(activity.working, [
      { name: 'Server', tasks: 2 },
      { name: 'cccccccc', tasks: 0 }
    ])
    assert.equal(backgroundTaskTotal(activity.background), 3)
  })
})

describe('createQuitGuard', () => {
  const warningActivity: QuitActivity = { background: [{ name: 'A', tasks: 1 }], working: [] }

  it('lets the exit through without asking when nothing is at stake', async () => {
    let asked = 0
    const guard = createQuitGuard({
      activity: async () => NOTHING,
      ask: async () => {
        asked += 1
        return false
      }
    })
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(asked, 0)
  })

  it('returns the answer, and a cancel is asked again next time', async () => {
    const answers = [false, true]
    const shown: QuitWarning[] = []
    const guard = createQuitGuard({
      activity: async () => warningActivity,
      ask: async (warning) => {
        shown.push(warning)
        return answers.shift() ?? false
      }
    })
    assert.equal(await guard.confirm('quit'), false)
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(shown.length, 2)
  })

  it('does not ask again once the user has proceeded, until reset', async () => {
    let asked = 0
    const guard = createQuitGuard({
      activity: async () => warningActivity,
      ask: async () => {
        asked += 1
        return true
      }
    })
    assert.equal(await guard.confirm('update'), true)
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(asked, 1)
    guard.reset()
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(asked, 2)
  })

  it('shares one prompt between simultaneous callers', async () => {
    let asked = 0
    let release: (proceed: boolean) => void = () => undefined
    const guard = createQuitGuard({
      activity: async () => warningActivity,
      ask: () => {
        asked += 1
        return new Promise<boolean>((resolve) => (release = resolve))
      }
    })
    const first = guard.confirm('quit')
    const second = guard.confirm('quit')
    await new Promise((resolve) => setTimeout(resolve, 0))
    release(false)
    assert.deepEqual(await Promise.all([first, second]), [false, false])
    assert.equal(asked, 1)
  })

  it('never traps the user when the lookup or the dialog fails', async () => {
    const lookupFails = createQuitGuard({
      activity: async () => Promise.reject(new Error('boom')),
      ask: async () => false
    })
    assert.equal(await lookupFails.confirm('quit'), true)
    const dialogFails = createQuitGuard({
      activity: async () => warningActivity,
      ask: async () => Promise.reject(new Error('boom'))
    })
    assert.equal(await dialogFails.confirm('quit'), true)
  })
})

describe('createQuitGuard clearance', () => {
  const warningActivity: QuitActivity = { background: [{ name: 'A', tasks: 1 }], working: [] }

  function guardAt(clock: { time: number }, answer = true) {
    let asked = 0
    const guard = createQuitGuard({
      activity: async () => warningActivity,
      ask: async () => {
        asked += 1
        return answer
      },
      now: () => clock.time,
      clearedForMs: 1000
    })
    return { guard, asked: () => asked }
  }

  it('is not cleared until an exit was confirmed, and a cancel clears nothing', async () => {
    const clock = { time: 0 }
    const { guard } = guardAt(clock, false)
    assert.equal(guard.cleared(), false)
    assert.equal(await guard.confirm('quit'), false)
    assert.equal(guard.cleared(), false)
  })

  it('clears the exit on a proceed, so before-quit and the window close pass without another dialog', async () => {
    const clock = { time: 0 }
    const { guard, asked } = guardAt(clock)
    assert.equal(await guard.confirm('update'), true)
    assert.equal(guard.cleared(), true)
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(asked(), 1)
  })

  it('clears an exit with nothing at stake too, so the re-issued quit is not stopped forever', async () => {
    const guard = createQuitGuard({ activity: async () => NOTHING, ask: async () => false })
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(guard.cleared(), true)
  })

  it('lapses, so a restart that never happened leaves later closes guarded', async () => {
    const clock = { time: 0 }
    const { guard, asked } = guardAt(clock)
    await guard.confirm('update')
    clock.time = 999
    assert.equal(guard.cleared(), true)
    clock.time = 1000
    assert.equal(guard.cleared(), false)
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(asked(), 2, 'asked again once the clearance lapsed')
  })

  it('clears a failed lookup too, so the re-issued quit is not stopped forever', async () => {
    const guard = createQuitGuard({ activity: async () => Promise.reject(new Error('boom')), ask: async () => false })
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(guard.cleared(), true)
  })

  it('allowExit clears without asking and reset forgets it', async () => {
    const clock = { time: 0 }
    const { guard, asked } = guardAt(clock)
    guard.allowExit()
    assert.equal(guard.cleared(), true)
    assert.equal(await guard.confirm('quit'), true)
    assert.equal(asked(), 0)
    guard.reset()
    assert.equal(guard.cleared(), false)
  })
})

describe('registerAppUpdateIpc restart', () => {
  function setup(phase: 'downloaded' | 'idle', confirm: () => Promise<boolean>) {
    const handlers = new Map<string, () => unknown>()
    let installs = 0
    const updater: AppUpdater = {
      snapshot: () => ({
        currentVersion: '1.0.0',
        status: phase === 'downloaded' ? { phase: 'downloaded', version: '1.1.0' } : APP_UPDATE_IDLE
      }),
      check: async () => updater.snapshot(),
      quitAndInstall: () => {
        installs += 1
        return true
      },
      onChange: () => () => undefined
    }
    registerAppUpdateIpc(
      { handle: (channel, handler) => void handlers.set(channel, handler as () => unknown) },
      updater,
      confirm
    )
    return { restart: () => handlers.get(APP_UPDATE_CHANNELS.restart)!() as Promise<boolean>, installs: () => installs }
  }

  it('installs only after the user confirms', async () => {
    const proceed = setup('downloaded', async () => true)
    assert.equal(await proceed.restart(), true)
    assert.equal(proceed.installs(), 1)
  })

  it('leaves the app running when the user cancels', async () => {
    const cancel = setup('downloaded', async () => false)
    assert.equal(await cancel.restart(), false)
    assert.equal(cancel.installs(), 0)
  })

  it('does not ask when there is no package to restart into', async () => {
    let asked = 0
    const none = setup('idle', async () => {
      asked += 1
      return true
    })
    assert.equal(await none.restart(), false)
    assert.equal(asked, 0)
    assert.equal(none.installs(), 0)
  })
})
