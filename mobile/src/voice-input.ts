/**
 * Decisions behind the phone composer's microphone. `MobileVoiceInput.tsx` owns the recognizer,
 * the microphone and the request; everything here is a function of what the browser offers and
 * what was heard.
 *
 * A phone has two ways to turn speech into text, and this module decides which:
 *
 * - **The browser's own recognizer** (`SpeechRecognition`), where the browser has one. It is free,
 *   runs in the phone's language, and on Android it is the same recognizer the keyboard uses. This
 *   is also the only path on which a non-English speaker gets a non-English transcript: Toucan's
 *   own model is English-only.
 * - **The host**, otherwise: record raw PCM and let the desktop's model transcribe it (see
 *   `src/shared/remote-voice.ts`). English only, but works in every browser with a microphone.
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
