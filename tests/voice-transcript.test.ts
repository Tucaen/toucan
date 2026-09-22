import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  dictationContext,
  formatElapsed,
  insertAtSelection,
  meterLevel,
  voiceControlLabel,
  voiceLivePreview
} from '../src/renderer/src/voice-transcript'

/**
 * The decisions behind the composer's microphone that need no React: where a transcript lands in
 * the draft, what the button says in each state, what the recording readout shows (elapsed time -
 * deliberately no live text, the decode is batch), and which text is handed to the decoder as
 * vocabulary to lean towards.
 */

describe('insertAtSelection', () => {
  test('replaces the selection and pads with single spaces where words would touch', () => {
    assert.equal(insertAtSelection('hello world', 'brave', 6, 11), 'hello brave')
    assert.equal(insertAtSelection('helloworld', 'X', 5, 5), 'hello X world')
    assert.equal(insertAtSelection('hello  world', 'X', 6, 6), 'hello X world')
    assert.equal(insertAtSelection('', 'X', 0, 0), 'X')
  })

  test('a selection recorded against an older draft is clamped to the text it lands in', () => {
    // #221: the draft can be edited while the decode runs, so the offsets the microphone recorded
    // may point past the end of the value the transcript is inserted into.
    assert.equal(insertAtSelection('hi', 'X', 40, 40), 'hi X')
    assert.equal(insertAtSelection('hello', 'X', 3, 40), 'hel X')
    assert.equal(insertAtSelection('hello', 'X', -5, -5), 'X hello')
    // An inverted selection collapses to a caret at `start` rather than deleting backwards.
    assert.equal(insertAtSelection('hello', 'X', 4, 2), 'hell X o')
  })
})

describe('voiceControlLabel', () => {
  test('names the action the button performs in each state, without claiming a language', () => {
    assert.equal(voiceControlLabel('idle', 0), 'Dictate')
    assert.equal(voiceControlLabel('error', 0), 'Dictate')
    assert.equal(voiceControlLabel('loading', 0), 'Starting microphone')
    assert.equal(voiceControlLabel('downloading', 0), 'Downloading speech model (one-time, 1.6 GB)')
    assert.equal(voiceControlLabel('downloading', 0.3), 'Downloading speech model (one-time, 1.6 GB) 30%')
    assert.equal(voiceControlLabel('listening', 1), 'Stop dictation')
    assert.equal(voiceControlLabel('stopping', 1), 'Finishing...')
  })
})

describe('formatElapsed', () => {
  test('counts like a recorder', () => {
    assert.equal(formatElapsed(0), '0:00')
    assert.equal(formatElapsed(7.9), '0:07')
    assert.equal(formatElapsed(65), '1:05')
    assert.equal(formatElapsed(-3), '0:00')
  })
})

describe('voiceLivePreview', () => {
  test('shows elapsed time while recording and a Finishing state while the decode runs', () => {
    assert.equal(voiceLivePreview('listening', 0, 7), 'Recording 0:07')
    assert.equal(voiceLivePreview('listening', 0, 0), 'Recording 0:00')
    assert.equal(voiceLivePreview('stopping', 1, 12), 'Finishing…')
    assert.equal(voiceLivePreview('loading', 0, 0), 'Starting microphone…')
    assert.equal(voiceLivePreview('downloading', 0.5, 0), 'Downloading speech model (one-time, 1.6 GB) 50%…')
    assert.equal(voiceLivePreview('idle', 0, 3), null)
  })

  test('reads a failure out rather than leaving the click unexplained', () => {
    assert.equal(
      voiceLivePreview('error', 0, 0, 'The microphone could not be opened.'),
      'The microphone could not be opened.'
    )
    assert.equal(voiceLivePreview('error', 0, 0), 'Dictation could not start.')
  })
})

describe('meterLevel', () => {
  test('attacks instantly, releases as a decay, and clamps what a driver reports', () => {
    assert.equal(meterLevel(0, 0.6), 0.6)
    assert.equal(meterLevel(0.6, 0), 0.48)
    assert.equal(meterLevel(0.1, 1.7), 1)
    assert.equal(meterLevel(0.1, -0.5), 0.1 * 0.8)
  })
})

describe('dictationContext', () => {
  test('hands the decoder the newest turn and the draft, draft last, within a bound', () => {
    const context = dictationContext('rename useFoo', [
      { role: 'user', text: 'old prompt about widgets' },
      { role: 'assistant', text: 'I changed `AcpSessionManager` and `remote-server.ts`.' },
      { role: 'thought', text: 'private reasoning about gizmos' },
      { role: 'user', text: 'now the composer' }
    ])
    // Whisper keeps the tail of its initial prompt, so the draft's vocabulary must sit at the end.
    assert.ok(context.endsWith('rename useFoo'))
    assert.ok(context.includes('AcpSessionManager'))
    assert.ok(context.includes('now the composer'))
    assert.ok(!context.includes('widgets'), 'older turns are not the vocabulary being spoken about')
    assert.ok(!context.includes('gizmos'), 'thoughts are not something the speaker read')
  })

  test('is bounded from the front and empty when there is nothing to lean on', () => {
    assert.equal(dictationContext('', []), '')
    const long = dictationContext('draft tail vocabulary', [{ role: 'assistant', text: 'y'.repeat(5_000) }])
    assert.ok(long.length <= 1_000)
    assert.ok(long.endsWith('draft tail vocabulary'), 'the clip must drop the front, never the draft')
  })
})
