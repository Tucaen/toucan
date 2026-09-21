/**
 * Decisions behind the phone composer's microphone. `MobileVoiceInput.tsx` owns the recognizer,
 * the microphone and the request; everything here is a function of what the browser offers and
 * what was heard.
 *
 * A phone has two ways to turn speech into text, and this module decides which:
 *
 * - **The browser's own recognizer** (`SpeechRecognition`), where the browser has one. It is free,
 *   runs in the phone's language, and on Android it is the same recognizer the keyboard uses.
 * - **The host**, otherwise: record raw PCM and let the desktop's model transcribe it (see
 *   `src/shared/remote-voice.ts`). The desktop decodes with Whisper, which detects the language
 *   itself, so this path is as multilingual as the recognizer one - it just answers slower,
 *   because the whole recording crosses to the desktop first.
 *
 * Both need a microphone, and a browser only grants one to a secure page - so over plain HTTP the
 * button says what to do about it rather than failing on the first tap.
 */

export type MobileVoiceState = 'idle' | 'loading' | 'listening' | 'stopping' | 'error'

export type VoiceInputMode = 'platform' | 'host' | 'unavailable'

export interface VoiceCapabilities {
  /** `SpeechRecognition` or its `webkit` prefix exists on the window. */
  speechRecognition: boolean
  /** `navigator.mediaDevices.getUserMedia` exists. */
  mediaDevices: boolean
  /** `window.isSecureContext`: HTTPS or localhost; a microphone is not granted anywhere else. */
  secureContext: boolean
}

export function voiceInputMode(capabilities: VoiceCapabilities): VoiceInputMode {
  if (!capabilities.secureContext || !capabilities.mediaDevices) return 'unavailable'
  return capabilities.speechRecognition ? 'platform' : 'host'
}

/** Why dictation is off, in terms of what to change; null when it is on. */
export function voiceUnavailableReason(capabilities: VoiceCapabilities): string | null {
  if (!capabilities.secureContext) {
    return 'Dictation needs an HTTPS page: phones only share the microphone with secure pages. Front the host with tailscale serve.'
  }
  if (!capabilities.mediaDevices) return 'This browser offers no microphone access.'
  return null
}

/** Puts a transcript after the draft, separated by one space unless the draft already ends in one. */
export function appendDictation(draft: string, text: string): string {
  const spoken = text.trim()
  if (!spoken) return draft
  if (!draft) return spoken
  return /\s$/.test(draft) ? `${draft}${spoken}` : `${draft} ${spoken}`
}

/**
 * What the recognizer has settled on and what it is still revising, from its result list. The
 * recognizer reports every result on every event, finals first, so this is a fold rather than an
 * append.
 */
export function joinRecognitionResults(results: readonly { transcript: string; isFinal: boolean }[]): {
  final: string
  interim: string
} {
  const final = results
    .filter((result) => result.isFinal)
    .map((result) => result.transcript.trim())
    .filter(Boolean)
    .join(' ')
  const interim = results
    .filter((result) => !result.isFinal)
    .map((result) => result.transcript.trim())
    .filter(Boolean)
    .join(' ')
  return { final, interim }
}

/** The recognizer's error codes, said for a person. An abort is the user's own Discard, so it is silent. */
export function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'aborted':
      return ''
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was denied. Allow it for this site to dictate.'
    case 'audio-capture':
      return 'No microphone was found on this phone.'
    case 'no-speech':
      return 'No speech was heard.'
    case 'network':
      return "The phone's speech service could not be reached."
    case 'language-not-supported':
      return "The phone's recognizer does not support this language."
    default:
      return `Speech recognition failed (${code}).`
  }
}

/** The recognizer dictates in the phone's own language; English is only the fallback for none. */
export function recognitionLanguage(navigatorLanguage: string | undefined): string {
  return navigatorLanguage && navigatorLanguage.length > 0 ? navigatorLanguage : 'en-US'
}

export function mobileVoiceLabel(state: MobileVoiceState, mode: VoiceInputMode): string {
  switch (state) {
    case 'loading':
      return 'Starting microphone'
    case 'listening':
      return 'Stop dictation'
    case 'stopping':
      return mode === 'host' ? 'Transcribing on the desktop' : 'Finishing'
    case 'idle':
    case 'error':
      return mode === 'host' ? 'Dictate (transcribed on the desktop)' : 'Dictate'
  }
}

/** What the microphone control reports to the composer around it. */
export interface MobileVoiceStatus {
  state: MobileVoiceState
  /** The button's own label in this state, which is also what a busy state is waiting for. */
  label: string
  /** Live text while listening: what the recognizer has heard so far. */
  interim: string
  error: string
}

/** The line under the composer row that says what the microphone is doing, or nothing when idle. */
export function voiceStatusLine(status: MobileVoiceStatus): { text: string; tone: 'live' | 'error' } | null {
  switch (status.state) {
    case 'loading':
    case 'stopping':
      return { text: `${status.label}…`, tone: 'live' }
    case 'listening':
      return { text: status.interim || 'Listening…', tone: 'live' }
    case 'error':
      return status.error ? { text: status.error, tone: 'error' } : null
    case 'idle':
      return null
  }
}
