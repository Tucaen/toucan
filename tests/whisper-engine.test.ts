import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createVoiceTranscriber } from '../src/main/voice-transcription'
import { loadWhisperEngine } from '../src/main/whisper-engine'

/**
 * The lifecycle of the whisper-server child, which is the part that cannot be left to whisper.cpp:
 * a load that is given up on must kill what it started, a child that dies must be reported rather
 * than polled, and an engine whose process is gone must say so. The helper is a real child process
 * here - a Node script standing in for the binary - because what is under test is the process, not
 * the decode.
 */

interface Fixture {
  serverPath: string
  spawnServer: (command: string, args: readonly string[]) => ChildProcess
  /** Every child started, each with its exit already awaited - subscribing after a kill races it. */
  launched: { child: ChildProcess; exit: Promise<unknown[]> }[]
}

/** Writes a stand-in for `whisper-server` and launches it the way the production path would. */
async function fixture(t: { after(fn: () => unknown): void }, source: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-whisper-'))
  const launched: Fixture['launched'] = []
  t.after(async () => {
    for (const { child } of launched) child.kill()
    await rm(root, { recursive: true, force: true })
  })
  const serverPath = join(root, 'whisper-server.cjs')
  await writeFile(serverPath, source)
  return {
    serverPath,
    launched,
    spawnServer: (command, args) => {
      const child = spawn(process.execPath, [command, ...args], { windowsHide: true, stdio: 'ignore' })
      launched.push({ child, exit: once(child, 'exit') })
      return child
    }
  }
}

/** A stand-in that answers /health once loaded and returns a fixed transcript for /inference. */
const READY_SERVER = `
const { createServer } = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  request.resume()
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: ' transcribed ' }))
  })
}).listen(port, '127.0.0.1')
`

/** Answers /health, then drops the connection on a decode - a crash the exit event lags behind. */
const DEAF_SERVER = `
const { createServer } = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  request.socket.destroy()
}).listen(port, '127.0.0.1')
`

const options = { modelPath: 'model.bin', log: () => {}, pollIntervalMs: 10 }

test('a load that is abandoned kills the child instead of orphaning it', async (t) => {
  // Never listens: the load would poll forever if the signal were not what ends it.
  const { serverPath, spawnServer, launched } = await fixture(t, 'setInterval(() => {}, 1000)')
  const controller = new AbortController()
  const load = loadWhisperEngine({ ...options, serverPath, signal: controller.signal, spawnServer })
  while (launched.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort(new Error('gave up'))
  await assert.rejects(load, /gave up/)
  const [code] = await launched[0].exit
  assert.notEqual(code, 0, 'the child must have been killed, not have run to completion')
})

test('a load abandoned before the child is spawned never spawns one', async (t) => {
  const { serverPath, spawnServer } = await fixture(t, 'setInterval(() => {}, 1000)')
  let spawned = 0
  const controller = new AbortController()
  controller.abort(new Error('gave up'))
  await assert.rejects(
    loadWhisperEngine({
      ...options,
      serverPath,
      signal: controller.signal,
      spawnServer: (command, args) => {
        spawned += 1
        return spawnServer(command, args)
      }
    }),
    /gave up/
  )
  assert.equal(spawned, 0)
})

test('a child that dies during the load rejects rather than polling a corpse', async (t) => {
  const { serverPath, spawnServer } = await fixture(t, 'process.exit(3)')
  await assert.rejects(loadWhisperEngine({ ...options, serverPath, spawnServer }), /exited while loading/)
})

test('a helper that cannot be started says why, rather than "exited"', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toucan-whisper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logged: string[] = []
  // No injected launcher: the spawn failure this reports only exists on the real one.
  await assert.rejects(
    loadWhisperEngine({
      ...options,
      serverPath: join(root, 'not-installed.exe'),
      log: (message) => logged.push(message)
    }),
    /could not start.*ENOENT/s
  )
  assert.ok(
    logged.some((message) => /could not start/.test(message)),
    'the spawn failure must reach the log as well as the caller'
  )
})

test('a loaded engine transcribes, and reports itself dead once its process is gone', async (t) => {
  const { serverPath, spawnServer, launched } = await fixture(t, READY_SERVER)
  const engine = await loadWhisperEngine({ ...options, serverPath, spawnServer })
  assert.equal(engine.alive(), true)
  assert.equal(await engine.transcribe(new Float32Array(16_000).fill(0.1), 16_000), ' transcribed ')

  launched[0].child.kill()
  await launched[0].exit
  assert.equal(engine.alive(), false)
  await assert.rejects(engine.transcribe(new Float32Array(16_000), 16_000), /not running/)
})

test('closing the engine ends its child', async (t) => {
  const { serverPath, spawnServer, launched } = await fixture(t, READY_SERVER)
  const engine = await loadWhisperEngine({ ...options, serverPath, spawnServer })
  engine.close()
  await launched[0].exit
  assert.equal(engine.alive(), false)
})

test('a helper that stops answering is dead on that failure, not on the one after it', async (t) => {
  const { serverPath, spawnServer, launched } = await fixture(t, DEAF_SERVER)
  const engine = await loadWhisperEngine({ ...options, serverPath, spawnServer })
  await assert.rejects(engine.transcribe(new Float32Array(16_000), 16_000), /stopped responding/)
  // The process is still up, so `exited` has told us nothing: a decode that cannot reach the port
  // it owns is the only evidence available, and the policy needs it now to release the engine.
  assert.equal(launched[0].child.killed, false)
  assert.equal(engine.alive(), false)
})

test('quitting during a load kills the child the transcriber never got a handle to', async (t) => {
  const { serverPath, spawnServer, launched } = await fixture(t, 'setInterval(() => {}, 1000)')
  const transcriber = createVoiceTranscriber({
    loadEngine: (signal) => loadWhisperEngine({ ...options, serverPath, signal, spawnServer }),
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    }
  })
  const pending = transcriber.transcribe(new Float32Array(16_000))
  while (launched.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  transcriber.shutdown()

  assert.equal((await pending).ok, false)
  const [code] = await launched[0].exit
  assert.notEqual(code, 0, 'the load Toucan walked away from must not outlive it')
})
