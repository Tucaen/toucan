import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  appendDictation,
  joinRecognitionResults,
  mobileVoiceLabel,
  recognitionErrorMessage,
  recognitionLanguage,
  voiceInputMode,
  voiceStatusLine,
  voiceUnavailableReason
} from '../mobile/src/voice-input'

/**
 * The phone's dictation decisions: which of its two ways to transcribe it may use, why it may use
 * neither, and how what it heard lands in the draft. Two ways because a phone browser will not run
 * the desktop's model: the browser's own recognizer where there is one (multilingual, free, on the
 * phone), and otherwise a recording the host transcribes.
 */
describe('voiceInputMode', () => {
  test('prefers the phone recognizer, falls back to the host, and needs a microphone and HTTPS for either', () => {
    assert.equal(voiceInputMode({ speechRecognition: true, mediaDevices: true, secureContext: true }), 'platform')
    assert.equal(voiceInputMode({ speechRecognition: false, mediaDevices: true, secureContext: true }), 'host')
    assert.equal(voiceInputMode({ speechRecognition: true, mediaDevices: true, secureContext: false }), 'unavailable')
    assert.equal(voiceInputMode({ speechRecognition: false, mediaDevices: false, secureContext: true }), 'unavailable')
  })
})

describe('voiceUnavailableReason', () => {
  test('names the fix, which is always on the host side', () => {
    assert.match(
      voiceUnavailableReason({ speechRecognition: true, mediaDevices: true, secureContext: false }) ?? '',
      /HTTPS/
    )
    assert.match(
      voiceUnavailableReason({ speechRecognition: false, mediaDevices: false, secureContext: true }) ?? '',
      /microphone/i
    )
    assert.equal(voiceUnavailableReason({ speechRecognition: false, mediaDevices: true, secureContext: true }), null)
  })
})

describe('appendDictation', () => {
  test('adds a space only where words would touch, and leaves an empty transcript alone', () => {
    assert.equal(appendDictation('', 'fix the parser'), 'fix the parser')
    assert.equal(appendDictation('Please', 'fix the parser'), 'Please fix the parser')
    assert.equal(appendDictation('Please ', 'fix the parser'), 'Please fix the parser')
    assert.equal(appendDictation('Please\n', 'fix it'), 'Please\nfix it')
    assert.equal(appendDictation('Please', '   '), 'Please')
  })
})

describe('joinRecognitionResults', () => {
  test('keeps final and interim text apart, in order', () => {
    assert.deepEqual(
      joinRecognitionResults([
        { transcript: 'fix the parser', isFinal: true },
        { transcript: ' and add', isFinal: true },
        { transcript: 'tests', isFinal: false }
      ]),
      { final: 'fix the parser and add', interim: 'tests' }
    )
    assert.deepEqual(joinRecognitionResults([]), { final: '', interim: '' })
  })
})

describe('recognitionErrorMessage', () => {
  test('translates the recognizer codes a user can act on and is quiet about a deliberate abort', () => {
    assert.match(recognitionErrorMessage('not-allowed'), /denied/)
    assert.match(recognitionErrorMessage('audio-capture'), /microphone/i)
    assert.match(recognitionErrorMessage('no-speech'), /No speech/)
    assert.match(recognitionErrorMessage('network'), /speech service/)
    assert.match(recognitionErrorMessage('language-not-supported'), /language/)
    assert.equal(recognitionErrorMessage('aborted'), '')
    assert.match(recognitionErrorMessage('something-new'), /something-new/)
  })
})

describe('recognitionLanguage', () => {
  test('dictates in the phone language and falls back to English', () => {
    assert.equal(recognitionLanguage('de-DE'), 'de-DE')
    assert.equal(recognitionLanguage(''), 'en-US')
    assert.equal(recognitionLanguage(undefined), 'en-US')
  })
})

describe('voiceStatusLine', () => {
  test('shows the wait, the interim text, or the error, and nothing when idle', () => {
    const status = { state: 'idle' as const, label: 'Dictate', interim: '', error: '' }
    assert.equal(voiceStatusLine(status), null)
    assert.deepEqual(voiceStatusLine({ ...status, state: 'loading', label: 'Starting microphone' }), {
      text: 'Starting microphone…',
      tone: 'live'
    })
    assert.deepEqual(voiceStatusLine({ ...status, state: 'listening' }), { text: 'Listening…', tone: 'live' })
    assert.deepEqual(voiceStatusLine({ ...status, state: 'listening', interim: 'fix the' }), {
      text: 'fix the',
      tone: 'live'
    })
    assert.deepEqual(voiceStatusLine({ ...status, state: 'error', error: 'denied' }), { text: 'denied', tone: 'error' })
    assert.equal(voiceStatusLine({ ...status, state: 'error' }), null)
  })
})

describe('mobileVoiceLabel', () => {
  test('says what the button does, and that a host transcription is what the wait is for', () => {
    assert.equal(mobileVoiceLabel('idle', 'platform'), 'Dictate')
    assert.equal(mobileVoiceLabel('idle', 'host'), 'Dictate (transcribed on the desktop)')
    assert.equal(mobileVoiceLabel('loading', 'host'), 'Starting microphone')
    assert.equal(mobileVoiceLabel('listening', 'platform'), 'Stop dictation')
    assert.equal(mobileVoiceLabel('stopping', 'platform'), 'Finishing')
    assert.equal(mobileVoiceLabel('stopping', 'host'), 'Transcribing on the desktop')
    assert.equal(mobileVoiceLabel('error', 'host'), 'Dictate (transcribed on the desktop)')
  })
})
