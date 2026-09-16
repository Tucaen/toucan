import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVoiceModelFiles } from '../src/main/voice-model-files'
import { fetchVoiceModelFiles } from '../src/renderer/src/voice-model-files'

/**
 * The two halves of loading the speech model without Moonshine's own downloader: the host names
 * and sizes the files, the renderer reads them off its origin. See `voice-model-files.ts` on
 * either side for why the Cache API cannot be in the path.
 */

describe('readVoiceModelFiles', () => {
  test('names and sizes what is there, and leaves a download in flight out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voice-model-'))
    await writeFile(join(directory, 'encoder.ort'), 'abcde')
    await writeFile(join(directory, 'tokenizer.bin'), 'xy')
    await writeFile(join(directory, 'decoder_kv.ort.download'), 'partial')
    await mkdir(join(directory, 'nested'))

    const files = await readVoiceModelFiles(directory)

    assert.deepEqual(
      files.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'encoder.ort', size: 5 },
        { name: 'tokenizer.bin', size: 2 }
      ]
    )
  })

  test('has nothing to offer without a complete model directory', async () => {
    assert.deepEqual(await readVoiceModelFiles(null), [])
    assert.deepEqual(await readVoiceModelFiles(join(tmpdir(), 'voice-model-that-is-not-there')), [])
  })
})

describe('fetchVoiceModelFiles', () => {
  const base = 'toucan://app/models/moonshine-medium-streaming-en/'
  const ok = (body: string) => new Response(new TextEncoder().encode(body))

  test('reads every file off the base URL and reports progress against the host sizes', async () => {
    const asked: string[] = []
    const progress: number[] = []
    const bytes = await fetchVoiceModelFiles(
      [
        { name: 'encoder.ort', size: 30 },
        { name: 'tokenizer.bin', size: 10 }
      ],
      base,
      (fraction) => progress.push(fraction),
      async (url) => {
        asked.push(url)
        return ok('x')
      }
    )

    assert.deepEqual(asked, [`${base}encoder.ort`, `${base}tokenizer.bin`])
    assert.deepEqual([...bytes.keys()], ['encoder.ort', 'tokenizer.bin'])
    assert.deepEqual(progress, [0.75, 1])
  })

  test('names the file a failed read was for, because one missing file is the whole model', async () => {
    await assert.rejects(
      fetchVoiceModelFiles(
        [{ name: 'encoder.ort', size: 30 }],
        base,
        () => undefined,
        async () => new Response('', { status: 404 })
      ),
      /encoder\.ort \(404\)/
    )
  })
})
