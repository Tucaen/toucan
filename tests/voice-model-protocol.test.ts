import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { voiceModelRequestFile } from '../src/main/voice-model-protocol'

/**
 * Which file: requests the host answers from the downloaded model. Everything else - other
 * renderer assets, other schemes, anything that tries to climb out of the directory - is not ours.
 */

const rendererRoot = join(process.cwd(), 'out', 'renderer')
const fileUrl = (...segments: string[]): string => pathToFileURL(join(rendererRoot, ...segments)).toString()
const modelUrl = (...segments: string[]): string => fileUrl('models', 'moonshine-medium-streaming-en', ...segments)

test('names the model file a renderer asks for beside its own index.html', () => {
  assert.equal(voiceModelRequestFile(modelUrl('encoder.ort'), rendererRoot), 'encoder.ort')
  assert.equal(voiceModelRequestFile(modelUrl('streaming_config.json'), rendererRoot), 'streaming_config.json')
})

test('leaves every other request alone', () => {
  assert.equal(voiceModelRequestFile(fileUrl('index.html'), rendererRoot), null)
  assert.equal(voiceModelRequestFile(fileUrl('models', 'other', 'x.ort'), rendererRoot), null)
  assert.equal(
    voiceModelRequestFile('https://example.com/models/moonshine-medium-streaming-en/encoder.ort', rendererRoot),
    null
  )
  assert.equal(voiceModelRequestFile('not a url', rendererRoot), null)
})

test('refuses nested paths, the directory itself and anything climbing out of it', () => {
  assert.equal(voiceModelRequestFile(modelUrl(), rendererRoot), null)
  assert.equal(voiceModelRequestFile(modelUrl('sub', 'file.ort'), rendererRoot), null)
  assert.equal(voiceModelRequestFile(modelUrl('..', 'index.html'), rendererRoot), null)
})
