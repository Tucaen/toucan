import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createVoiceModelPort } from '../src/main/voice-model-download'
import type { VoiceAssetFile } from '../src/main/voice-model-store'

/**
 * The real IO behind the speech assets, against a local server rather than a CDN. What is under
 * test is what a 1.6 GB download over a domestic connection actually runs into: a dropped
 * connection that must resume rather than start over, a server that ignores the range and sends
 * the file again, and bytes that do not match the pin - which matters more here than usual,
 * because one of these files is an executable and the pin is the whole review.
 */

const BODY = Buffer.from('whisper-model-bytes-'.repeat(32))
const DIGEST = createHash('sha256').update(BODY).digest('hex')

type Reply = (request: IncomingMessage, response: ServerResponse, body: Buffer) => void

/** Answers the whole file, which is what a server does when nothing has gone wrong. */
const whole: Reply = (_request, response, body) => {
  response.writeHead(200, { 'content-length': body.length })
  response.end(body)
}

/** Honours `Range`, the reason a dropped download costs seconds rather than the whole file. */
const honoursRange: Reply = (request, response, body) => {
  const start = Number(/bytes=(\d+)-/.exec(request.headers.range ?? '')?.[1] ?? 0)
  if (start === 0) return whole(request, response, body)
  const rest = body.subarray(start)
  response.writeHead(206, {
    'content-length': rest.length,
    'content-range': `bytes ${start}-${body.length - 1}/${body.length}`
  })
  response.end(rest)
}

/** Serves `body` with `delta` bytes added or removed, without telling the truth about the size. */
function offBy(delta: number): Reply {
  return (_request, response, body) => {
    const served = delta < 0 ? body.subarray(0, body.length + delta) : Buffer.concat([body, Buffer.alloc(delta)])
    response.writeHead(200, { 'content-length': served.length })
    response.end(served)
  }
}

interface Harness {
  root: string
  destination: string
  /** The pinned asset, with whatever the test needs to be wrong about it. */
  asset(overrides?: Partial<VoiceAssetFile>): VoiceAssetFile
  requests: { range: string | undefined }[]
  download(file: VoiceAssetFile, onProgress?: (received: number) => void): Promise<void>
  size(path: string): number | null
  /** Puts bytes where an earlier attempt would have left them. */
  seed(path: string, bytes: Buffer): Promise<void>
}

async function harness(t: { after(fn: () => unknown): void }, reply: Reply): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-voice-model-'))
  const requests: { range: string | undefined }[] = []
  const server = createServer((request, response) => {
    requests.push({ range: request.headers.range })
    reply(request, response, BODY)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = createVoiceModelPort()
  const destination = join(root, 'assets', 'model.bin')
  return {
    root,
    destination,
    requests,
    asset: (overrides) => ({
      name: 'model.bin',
      url: `http://127.0.0.1:${address.port}/model.bin`,
      size: BODY.length,
      sha256: DIGEST,
      ...overrides
    }),
    download: (file, onProgress) => port.download(file, destination, onProgress ?? (() => {})),
    size: (path) => port.fileSize(path),
    seed: async (path, bytes) => {
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(path, bytes)
    }
  }
}

test('a verified download is renamed into place, leaving no partial behind', async (t) => {
  const asset = await harness(t, whole)
  const progress: number[] = []
  await asset.download(asset.asset(), (received) => progress.push(received))

  assert.deepEqual(await readFile(asset.destination), BODY)
  assert.equal(asset.size(`${asset.destination}.download`), null)
  assert.equal(progress.at(-1), BODY.length, 'progress must end at the full size')
  assert.ok(
    progress.every((received, index) => index === 0 || received > progress[index - 1]),
    'progress only ever moves forward'
  )
})

test('a file already at its pinned size was verified when it landed, so it is not fetched again', async (t) => {
  const asset = await harness(t, whole)
  await asset.seed(asset.destination, BODY)
  await asset.download(asset.asset())
  assert.equal(asset.requests.length, 0)
})

test('a dropped download resumes from what it already has', async (t) => {
  const asset = await harness(t, honoursRange)
  await asset.seed(`${asset.destination}.download`, BODY.subarray(0, 100))
  await asset.download(asset.asset())

  assert.equal(asset.requests[0].range, 'bytes=100-', 'the request must ask only for what is missing')
  // Whole and correct proves the kept bytes were folded into the running hash, not just appended to.
  assert.deepEqual(await readFile(asset.destination), BODY)
})

test('a server that ignores the range restarts the file rather than doubling it', async (t) => {
  const asset = await harness(t, whole)
  await asset.seed(`${asset.destination}.download`, BODY.subarray(0, 100))
  await asset.download(asset.asset())
  assert.deepEqual(await readFile(asset.destination), BODY)
})

test('bytes that do not match the pin are deleted, never renamed into place', async (t) => {
  const asset = await harness(t, whole)
  await assert.rejects(asset.download(asset.asset({ sha256: 'f'.repeat(64) })), /Checksum mismatch/)
  assert.equal(asset.size(`${asset.destination}.download`), null)
  assert.equal(asset.size(asset.destination), null, 'an unverified executable must never exist at its final name')
})

test('a truncated body keeps its partial, because the next attempt resumes from it', async (t) => {
  const asset = await harness(t, offBy(-50))
  await assert.rejects(asset.download(asset.asset()), /Size mismatch/)
  assert.equal(asset.size(`${asset.destination}.download`), BODY.length - 50)
})

test('a body longer than the pin is not a partial, so it is thrown away', async (t) => {
  const asset = await harness(t, offBy(50))
  await assert.rejects(asset.download(asset.asset()), /Size mismatch/)
  assert.equal(asset.size(`${asset.destination}.download`), null)
})

test('a refused request says which asset and which status', async (t) => {
  const asset = await harness(t, (_request, response) => {
    response.writeHead(404)
    response.end()
  })
  await assert.rejects(asset.download(asset.asset()), /model\.bin.*404/s)
})
