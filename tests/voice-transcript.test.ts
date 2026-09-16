import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  dictationContext,
  insertAtSelection,
  joinTranscript,
  voiceControlLabel,
  voiceLivePreview
} from '../src/renderer/src/voice-transcript'

/**
 * The decisions behind the composer's microphone that need no React: how finished lines and the
 * in-progress tail become one transcript, where it lands in the draft, what the button says in
 * each state, and which text is handed to the model as vocabulary to lean towards.
 */
describe('joinTranscript', () => {
  test('appends the unfinished tail unless it repeats the last finished line', () => {
    assert.equal(joinTranscript(['Fix the parser.'], 'and add tests'), 'Fix the parser. and add tests')
    assert.equal(joinTranscript(['Fix the parser.'], 'Fix the parser.'), 'Fix the parser.')
    assert.equal(joinTranscript([], '  hello '), 'hello')
    assert.equal(joinTranscript(['', '  '], ''), '')
  })
})

describe('insertAtSelection', () => {
  test('replaces the selection and pads with single spaces where words would touch', () => {
    assert.equal(insertAtSelection('hello world', 'brave', 6, 11), 'hello brave')
    assert.equal(insertAtSelection('helloworld', 'X', 5, 5), 'hello X world')
    assert.equal(insertAtSelection('hello  world', 'X', 6, 6), 'hello X world')
    assert.equal(insertAtSelection('', 'X', 0, 0), 'X')
  })
})

describe('voiceControlLabel', () => {
  test('names the action the button performs in each state', () => {
    assert.equal(voiceControlLabel('idle', 0), 'Dictate (English)')
    assert.equal(voiceControlLabel('error', 0), 'Dictate (English)')
    assert.equal(voiceControlLabel('loading', 0), 'Preparing local speech model')
    assert.equal(voiceControlLabel('loading', 0.42), 'Preparing local speech model 42%')
    assert.equal(voiceControlLabel('downloading', 0), 'Downloading speech model (one-time, 291 MB)')
    assert.equal(voiceControlLabel('downloading', 0.3), 'Downloading speech model (one-time, 291 MB) 30%')
    assert.equal(voiceControlLabel('listening', 1), 'Stop dictation')
    assert.equal(voiceControlLabel('stopping', 1), 'Finishing...')
  })
})

describe('voiceLivePreview', () => {
  test('shows the partial text while listening and says the model is English-only until it does', () => {
    assert.equal(voiceLivePreview('listening', 0, 'fix the'), 'fix the')
    assert.equal(voiceLivePreview('listening', 0, ''), 'Listening (English only)…')
    assert.equal(voiceLivePreview('loading', 0.5, ''), 'Preparing local speech model 50%…')
    assert.equal(voiceLivePreview('downloading', 0.5, ''), 'Downloading speech model (one-time, 291 MB) 50%…')
    assert.equal(voiceLivePreview('stopping', 1, 'tail'), 'tail')
    assert.equal(voiceLivePreview('idle', 0, 'x'), null)
  })

  test('reads a failure out rather than leaving the click unexplained', () => {
    assert.equal(
      voiceLivePreview('error', 0, 'x', 'The microphone could not be opened.'),
      'The microphone could not be opened.'
    )
    assert.equal(voiceLivePreview('error', 0, 'x'), 'Dictation could not start.')
  })
})

describe('dictationContext', () => {
  test('hands the model the draft and the newest turn, newest first, within a bound', () => {
    const context = dictationContext('rename useFoo', [
      { role: 'user', text: 'old prompt about widgets' },
      { role: 'assistant', text: 'I changed `AcpSessionManager` and `remote-server.ts`.' },
      { role: 'thought', text: 'private reasoning about gizmos' },
      { role: 'user', text: 'now the composer' }
    ])
    assert.ok(context.startsWith('rename useFoo'))
    assert.ok(context.includes('AcpSessionManager'))
    assert.ok(context.includes('now the composer'))
    assert.ok(!context.includes('widgets'), 'older turns are not the vocabulary being spoken about')
    assert.ok(!context.includes('gizmos'), 'thoughts are not something the speaker read')
  })

  test('is bounded and empty when there is nothing to lean on', () => {
    assert.equal(dictationContext('', []), '')
    const long = dictationContext('x'.repeat(5_000), [{ role: 'assistant', text: 'y'.repeat(5_000) }])
    assert.ok(long.length <= 4_000)
  })
})
