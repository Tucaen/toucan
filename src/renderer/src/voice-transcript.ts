/**
 * Pure decisions behind the composer's dictation control. `VoiceInput.tsx` owns the microphone and
 * the model; everything here is a function of strings and a state name, which is what makes the
 * transcript assembly, the insertion rule and the labels testable without an audio device.
 */

export type VoiceState = 'idle' | 'downloading' | 'loading' | 'listening' | 'stopping' | 'error'

/**
 * One transcript from the lines the model finished and the tail it was still revising. The tail
 * is dropped when it merely repeats the last finished line, which is what a stream that completed
 * a line and had not yet cleared its partial looks like.
 */
export function joinTranscript(lines: readonly string[], partial: string): string {
  const parts = [...lines]
  const tail = partial.trim()
  if (tail && parts.at(-1)?.trim() !== tail) parts.push(tail)
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}

/** Replaces the selection with `text`, adding a space wherever it would otherwise touch a word. */
export function insertAtSelection(value: string, text: string, start: number, end: number): string {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  return `${before}${prefix}${text}${suffix}${after}`
}

const LOADING_LABEL = 'Preparing local speech model'
// The model is fetched on first use rather than shipped in the installer, and a first-time speaker
// deserves to know the wait is a 291 MB download and not a hung button.
const DOWNLOADING_LABEL = 'Downloading speech model (one-time, 291 MB)'

function progressLabel(label: string, progress: number): string {
  return progress > 0 ? `${label} ${Math.round(progress * 100)}%` : label
}

function loadingLabel(progress: number): string {
  return progressLabel(LOADING_LABEL, progress)
}

/**
 * What the button does when pressed, which is also its accessible name. The idle label names the
 * language because the local model is English-only and the composer must say so before the user
 * has spoken a sentence it cannot transcribe, not after.
 */
export function voiceControlLabel(state: VoiceState, progress: number): string {
  switch (state) {
    case 'downloading':
      return progressLabel(DOWNLOADING_LABEL, progress)
    case 'loading':
      return loadingLabel(progress)
    case 'listening':
      return 'Stop dictation'
    case 'stopping':
      return 'Finishing...'
    case 'idle':
    case 'error':
      return 'Dictate (English)'
  }
}

/**
 * The floating preview beside the button, or null when there is nothing to show. A failure belongs
 * here too: it is the only surface the composer's microphone has, and a button that silently
 * returns to idle is how a broken model reads as a click that did nothing.
 */
export function voiceLivePreview(
  state: VoiceState,
  progress: number,
  partial: string,
  error: string = ''
): string | null {
  switch (state) {
    case 'downloading':
      return `${progressLabel(DOWNLOADING_LABEL, progress)}…`
    case 'loading':
      return `${loadingLabel(progress)}…`
    case 'listening':
    case 'stopping':
      return partial || 'Listening (English only)…'
    case 'error':
      return error || 'Dictation could not start.'
    case 'idle':
      return null
  }
}

/** How much text the model is asked to mine for vocabulary; more costs decode time, not accuracy. */
const CONTEXT_LIMIT = 4_000

/**
 * The text the speaker is most likely talking about, for the model to lean towards. Identifiers,
 * file names and product words are exactly what a general English model gets wrong, and they are
 * sitting in the composer draft and the newest exchange. Older turns are left out on purpose: a
 * conversation drifts, and biasing towards its whole history would pull words from topics that
 * are over. Thoughts are not conversation: they are the model's own scratch, not words the speaker
 * has read.
 */
export function dictationContext(draft: string, messages: readonly { role: string; text: string }[]): string {
  const recent = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-2)
    .map((message) => message.text)
  return [draft, ...recent.reverse()]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, CONTEXT_LIMIT)
}
