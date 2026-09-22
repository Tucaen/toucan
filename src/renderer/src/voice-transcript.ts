/**
 * Pure decisions behind the composer's dictation control. `VoiceInput.tsx` owns the microphone and
 * the recording; everything here is a function of numbers and a state name, which is what makes
 * the labels, the recording readout and the insertion rule testable without an audio device.
 *
 * There is deliberately no live text: the model decodes the whole utterance at once when the
 * recording stops (see #214 - a streaming decoder turned every thinking pause into a sentence
 * boundary), so while speaking the control shows that it is *hearing* - a level meter and the
 * elapsed time - and the transcript appears on Stop.
 */

import { WHISPER_DOWNLOAD_GIGABYTES } from '../../shared/whisper-assets'

export type VoiceState = 'idle' | 'downloading' | 'loading' | 'listening' | 'stopping' | 'polishing' | 'error'

/**
 * Replaces the selection with `text`, adding a space wherever it would otherwise touch a word.
 *
 * The offsets were recorded when the microphone was pressed and the draft stays editable for the
 * seconds the decode takes, so they are clamped to the value they actually land in (#221) - an
 * out-of-range `slice` would otherwise silently drop or duplicate what was typed meanwhile.
 */
export function insertAtSelection(value: string, text: string, start: number, end: number): string {
  const from = Math.min(Math.max(start, 0), value.length)
  const to = Math.min(Math.max(end, from), value.length)
  const before = value.slice(0, from)
  const after = value.slice(to)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  return `${before}${prefix}${text}${suffix}${after}`
}

// The engine is fetched on first use rather than shipped in the installer, and a first-time
// speaker deserves to know the wait is a download and not a hung button.
const DOWNLOADING_LABEL = `Downloading speech model (one-time, ${WHISPER_DOWNLOAD_GIGABYTES})`

function progressLabel(label: string, progress: number): string {
  return progress > 0 ? `${label} ${Math.round(progress * 100)}%` : label
}

/** What the button does when pressed, which is also its accessible name. */
export function voiceControlLabel(state: VoiceState, progress: number): string {
  switch (state) {
    case 'downloading':
      return progressLabel(DOWNLOADING_LABEL, progress)
    case 'loading':
      return 'Starting microphone'
    case 'listening':
      return 'Stop dictation'
    case 'stopping':
      return 'Finishing...'
    case 'polishing':
      return 'Polishing dictation'
    case 'idle':
    case 'error':
      return 'Dictate'
  }
}

/**
 * Seconds as `m:ss`, the way every recorder counts.
 * @internal exported for tests
 */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * The floating readout beside the button, or null when there is nothing to show. While recording
 * it is the elapsed time (the meter beside it is the other half of "I can hear you"); a failure
 * belongs here too - it is the only surface the composer's microphone has, and a button that
 * silently returns to idle is how a broken model reads as a click that did nothing.
 */
export function voiceLivePreview(
  state: VoiceState,
  progress: number,
  elapsedSeconds: number,
  error: string = ''
): string | null {
  switch (state) {
    case 'downloading':
      return `${progressLabel(DOWNLOADING_LABEL, progress)}…`
    case 'loading':
      return 'Starting microphone…'
    case 'listening':
      return `Recording ${formatElapsed(elapsedSeconds)}`
    case 'stopping':
      return 'Finishing…'
    case 'polishing':
      return 'Polishing…'
    case 'error':
      return error || 'Dictation could not start.'
    case 'idle':
      return null
  }
}

/**
 * A peak sample folded into the meter's displayed level: attack is instant, release is a decay, so
 * speech reads as movement rather than flicker. Both values are fractions in [0, 1].
 */
export function meterLevel(previous: number, peak: number): number {
  const clamped = Math.max(0, Math.min(1, peak))
  return Math.max(clamped, previous * 0.8)
}

/**
 * Whisper keeps only the last ~224 tokens of its initial prompt, roughly this many characters of
 * English; anything above the bound would be silently cut, so the bound is held here where the
 * ordering is decided.
 */
const CONTEXT_LIMIT = 1_000

/**
 * The text the speaker is most likely talking about, handed to the decoder as its initial prompt.
 * Identifiers, file names and product words are exactly what a general model gets wrong, and they
 * are sitting in the composer draft and the newest exchange. Older turns are left out on purpose:
 * a conversation drifts, and biasing towards its whole history would pull words from topics that
 * are over. Thoughts are not conversation: they are the model's own scratch, not words the speaker
 * has read. Order and clipping both point the same way: the decoder keeps the *tail* of the
 * prompt, so the draft - the highest-value vocabulary - goes last and the clip drops the front.
 */
export function dictationContext(draft: string, messages: readonly { role: string; text: string }[]): string {
  const recent = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-2)
    .map((message) => message.text)
  return [...recent, draft]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
    .slice(-CONTEXT_LIMIT)
}
