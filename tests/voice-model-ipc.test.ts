import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { VOICE_MODEL_CHANNELS } from '../src/shared/ipc-channels'
import { REMOTE_VOICE_BODY_LIMIT, encodePcm16 } from '../src/shared/remote-voice'
import type { IpcRegistrar } from '../src/main/ipc-registrar'
import { registerVoiceModelIpc } from '../src/main/voice-model-ipc'
import type { VoiceModelStore } from '../src/main/voice-model-store'
import type { RemoteTranscriptionResult } from '../src/shared/remote-voice'

/**
 * The renderer's half of the speech seam. A phone's recordings are bounded at the HTTP route and
 * that is covered in `remote-server.test.ts`; the composer's reach main through IPC instead, and
 * the same bounds have to hold there - a renderer is not more trusted than a phone, and a malformed
 * buffer must be refused before it is handed to a 1.6 GB helper process.
 */

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown

function harness(transcribe?: (audio: Float32Array, request?: { prompt?: string }) => RemoteTranscriptionResult): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  heard: { audio: Float32Array; prompt: string | undefined }[]
  ensured: number
} {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, listener) => handlers.set(channel, listener) }
  const heard: { audio: Float32Array; prompt: string | undefined }[] = []
  let ensured = 0
  const store = {
    snapshot: () => ({ phase: 'ready' }) as const,
    paths: () => null,
    ensure: async () => {
      ensured += 1
      return { phase: 'ready' } as const
    },
    onChange: () => () => {}
  } satisfies VoiceModelStore
  registerVoiceModelIpc(ipc, store, {
    async transcribe(audio, request) {
      heard.push({ audio, prompt: request?.prompt })
      return transcribe?.(audio, request) ?? { ok: true, text: 'hello' }
    }
  })
  return {
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      assert.ok(handler, `no handler for ${channel}`)
      return handler({ sender: null }, ...args)
    },
    heard,
    get ensured() {
      return ensured
    }
  }
}

test('the renderer reads the model state and asks for the download through the store', async () => {
  const ipc = harness()
  assert.deepEqual(await ipc.invoke(VOICE_MODEL_CHANNELS.state), { phase: 'ready' })
  assert.deepEqual(await ipc.invoke(VOICE_MODEL_CHANNELS.ensure), { phase: 'ready' })
  assert.equal(ipc.ensured, 1)
})

test('a recording reaches the transcriber as samples, with the dictation context', async () => {
  const ipc = harness()
  const samples = new Float32Array([0, 0.5, -0.5])
  const result = await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, encodePcm16(samples), 'the draft being edited')
  assert.deepEqual(result, { ok: true, text: 'hello' })
  assert.equal(ipc.heard.length, 1)
  assert.equal(ipc.heard[0].prompt, 'the draft being edited')
  assert.equal(ipc.heard[0].audio.length, 3)
  assert.ok(Math.abs(ipc.heard[0].audio[1] - 0.5) < 0.001)
})

test('a context that is not text is no context, not a crash', async () => {
  const ipc = harness()
  await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, encodePcm16(new Float32Array([0.1])), { note: 'not a string' })
  assert.equal(ipc.heard[0].prompt, undefined)
})

test('an empty, half-sample or oversized recording is refused before the engine is asked', async () => {
  const ipc = harness()
  const refusals = [
    await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, new Uint8Array(0)),
    await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, new Uint8Array(3)),
    await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, new Uint8Array(REMOTE_VOICE_BODY_LIMIT + 2))
  ] as { ok: boolean; message: string }[]
  assert.deepEqual(
    refusals.map((refusal) => refusal.ok),
    [false, false, false]
  )
  assert.match(refusals[0].message, /no audio/)
  assert.match(refusals[1].message, /16-bit PCM/)
  assert.match(refusals[2].message, /too long/)
  assert.equal(ipc.heard.length, 0)
})

test('anything that is not a buffer is an empty recording, not an argument to trust', async () => {
  const ipc = harness()
  const result = (await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, 'not audio')) as { ok: boolean; message: string }
  assert.equal(result.ok, false)
  assert.match(result.message, /no audio/)
  assert.equal(ipc.heard.length, 0)
})

test("a refusal from the transcriber is passed through in the transcriber's own words", async () => {
  const ipc = harness(() => ({ ok: false, message: 'The desktop is shutting down.' }))
  assert.deepEqual(await ipc.invoke(VOICE_MODEL_CHANNELS.transcribe, encodePcm16(new Float32Array([0.1]))), {
    ok: false,
    message: 'The desktop is shutting down.'
  })
})
