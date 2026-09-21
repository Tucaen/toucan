import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { createVoiceTranscriber, type VoiceEngine, type VoiceTranscribeRequest } from '../src/main/voice-transcription'

/**
 * The policy around the speech engine, for the composer's dictation and phone dictation alike: one
 * lazily loaded model shared by every request, transcriptions run one at a time because the engine
 * decodes one utterance at a time, a load that fails is retried on the next request rather than
 * poisoning the host, and a model nobody has used for a while is released. The engine itself is
 * injected; what whisper.cpp does with audio is its own test suite, not ours.
 */

function fakeEngine(
  text = 'hello world'
): VoiceEngine & { calls: number; closed: boolean; busy: number; overlap: number; dead: boolean } {
  const engine = {
    calls: 0,
    closed: false,
    busy: 0,
    overlap: 0,
    dead: false,
    alive(): boolean {
      return !engine.dead
    },
    async transcribe(audio: Float32Array): Promise<string> {
      if (engine.dead) throw new Error('The speech engine stopped responding.')
      engine.calls += 1
      engine.busy += 1
      engine.overlap = Math.max(engine.overlap, engine.busy)
      engine.busy -= 1
      return audio.length === 0 ? '' : text
    },
    close(): void {
      engine.closed = true
    }
  }
  return engine
}

/** Fires scheduled work on demand, so the idle unload is a decision rather than a wait. */
function manualClock(): {
  schedule: (run: () => void, delayMs: number) => { cancel(): void }
  fire(): void
  pending(): boolean
  delays: number[]
} {
  let pending: (() => void) | null = null
  const delays: number[] = []
  return {
    delays,
    schedule: (run, delayMs) => {
      pending = run
      delays.push(delayMs)
      return {
        cancel: () => {
          pending = null
        }
      }
    },
    fire: () => {
      const run = pending
      pending = null
      run?.()
    },
    pending: () => pending !== null
  }
}

const audio = new Float32Array(16_000).fill(0.1)

describe('remote voice transcriber', () => {
  test('loads the engine on the first request and reuses it afterwards', async () => {
    const engine = fakeEngine()
    let loads = 0
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => {
        loads += 1
        return engine
      },
      schedule: manualClock().schedule
    })
    assert.equal(transcriber.loaded(), false)

    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'hello world' })
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'hello world' })
    assert.equal(loads, 1)
    assert.equal(engine.calls, 2)
    assert.equal(transcriber.loaded(), true)
  })

  test('concurrent requests share one load and are transcribed one at a time', async () => {
    const engine = fakeEngine()
    let loads = 0
    let release: (() => void) | undefined
    const transcriber = createVoiceTranscriber({
      loadEngine: () =>
        new Promise<VoiceEngine>((resolve) => {
          loads += 1
          release = () => resolve(engine)
        }),
      schedule: manualClock().schedule
    })
    const first = transcriber.transcribe(audio)
    const second = transcriber.transcribe(audio)
    // The load starts once the queue turns, a tick after the call; wait for it before releasing.
    await new Promise((resolve) => setImmediate(resolve))
    release?.()
    assert.deepEqual(await Promise.all([first, second]), [
      { ok: true, text: 'hello world' },
      { ok: true, text: 'hello world' }
    ])
    assert.equal(loads, 1)
    assert.equal(engine.overlap, 1)
  })

  test('a failed load is reported and retried on the next request', async () => {
    let attempt = 0
    const engine = fakeEngine()
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('model files are missing')
        return engine
      },
      schedule: manualClock().schedule
    })
    const failed = await transcriber.transcribe(audio)
    assert.equal(failed.ok, false)
    assert.match((failed as { message: string }).message, /model files are missing/)
    assert.equal(transcriber.loaded(), false)

    // Requests are serialized, so the one queued behind the failure is the retry - and it succeeds
    // without the phone having to do anything but try again.
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'hello world' })
    assert.equal(attempt, 2)
  })

  test('a load that never settles is refused after the deadline, not waited on forever', async () => {
    const transcriber = createVoiceTranscriber({
      loadEngine: () => new Promise<VoiceEngine>(() => {}),
      loadTimeoutMs: 5,
      schedule: manualClock().schedule
    })
    const result = await transcriber.transcribe(audio)
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message, /timed out/i)
  })

  test('an engine that throws refuses that request and stays loaded for the next', async () => {
    const engine = fakeEngine()
    let boom = true
    engine.transcribe = async (): Promise<string> => {
      if (boom) throw new Error('decoder fault')
      return 'recovered'
    }
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => engine,
      schedule: manualClock().schedule
    })
    const failed = await transcriber.transcribe(audio)
    assert.equal(failed.ok, false)
    assert.match((failed as { message: string }).message, /decoder fault/)
    boom = false
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'recovered' })
  })

  test('the dictation context and language reach the engine as the per-request options', async () => {
    const seen: (VoiceTranscribeRequest | undefined)[] = []
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => ({
        transcribe: async (_audio, _rate, request) => {
          seen.push(request)
          return 'ok'
        },
        alive: () => true,
        close: () => {}
      }),
      schedule: manualClock().schedule
    })
    await transcriber.transcribe(audio, { prompt: 'the draft being edited' })
    await transcriber.transcribe(audio)
    assert.deepEqual(seen, [{ prompt: 'the draft being edited' }, undefined])
  })

  test('silence is an empty transcript, which is a success, not an error', async () => {
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => fakeEngine(),
      schedule: manualClock().schedule
    })
    assert.deepEqual(await transcriber.transcribe(new Float32Array(0)), { ok: true, text: '' })
  })

  test('the model is released after the idle period and reloaded on demand', async () => {
    const clock = manualClock()
    const engines: ReturnType<typeof fakeEngine>[] = []
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => {
        const engine = fakeEngine()
        engines.push(engine)
        return engine
      },
      idleUnloadMs: 1234,
      schedule: clock.schedule
    })
    await transcriber.transcribe(audio)
    assert.deepEqual(clock.delays, [1234])
    assert.equal(clock.pending(), true)

    // Another request before the deadline keeps the model; the timer is re-armed, not stacked.
    await transcriber.transcribe(audio)
    assert.equal(engines.length, 1)
    assert.equal(engines[0].closed, false)

    clock.fire()
    assert.equal(engines[0].closed, true)
    assert.equal(transcriber.loaded(), false)

    await transcriber.transcribe(audio)
    assert.equal(engines.length, 2)
  })

  test('giving up on a load at the deadline aborts it, so the child behind it is not orphaned', async () => {
    let seen: AbortSignal | undefined
    const transcriber = createVoiceTranscriber({
      loadEngine: (signal) => {
        seen = signal
        return new Promise<VoiceEngine>(() => {})
      },
      loadTimeoutMs: 5,
      schedule: manualClock().schedule
    })
    const result = await transcriber.transcribe(audio)
    assert.equal(result.ok, false)
    // The stall guard only abandons the promise; the signal is the only thing that still reaches
    // the 1.6 GB helper the abandoned load left running.
    assert.equal(seen?.aborted, true)
  })

  test('shutdown aborts a load still in flight', async () => {
    let seen: AbortSignal | undefined
    const transcriber = createVoiceTranscriber({
      // The real loader gives up when its signal is aborted, which is what settles the request.
      loadEngine: (signal) => {
        seen = signal
        return new Promise<VoiceEngine>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
        })
      },
      schedule: manualClock().schedule
    })
    const pending = transcriber.transcribe(audio)
    await new Promise((resolve) => setImmediate(resolve))
    transcriber.shutdown()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(seen?.aborted, true)
  })

  test('an engine whose process died is released, and the next request loads a fresh one', async () => {
    const engines: ReturnType<typeof fakeEngine>[] = []
    const transcriber = createVoiceTranscriber({
      loadEngine: async () => {
        const engine = fakeEngine()
        engines.push(engine)
        return engine
      },
      schedule: manualClock().schedule
    })
    await transcriber.transcribe(audio)
    // The real engine learns its child is gone *as* the decode fails, not before it starts - so
    // the release has to follow from this failure rather than from a flag set ahead of it.
    engines[0].transcribe = async (): Promise<string> => {
      engines[0].dead = true
      throw new Error('The speech engine stopped responding.')
    }
    const failed = await transcriber.transcribe(audio)
    assert.equal(failed.ok, false)
    // A crashed helper must not stay pinned: otherwise every later dictation fails the same way
    // and each failure re-arms the idle release on a process that is already gone.
    assert.equal(transcriber.loaded(), false)
    assert.equal(engines[0].closed, true)

    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'hello world' })
    assert.equal(engines.length, 2)
  })

  test('shutdown closes the engine and refuses further requests', async () => {
    const clock = manualClock()
    const engine = fakeEngine()
    const transcriber = createVoiceTranscriber({ loadEngine: async () => engine, schedule: clock.schedule })
    await transcriber.transcribe(audio)
    transcriber.shutdown()
    assert.equal(engine.closed, true)
    assert.equal(clock.pending(), false)
    const result = await transcriber.transcribe(audio)
    assert.equal(result.ok, false)
  })
})
