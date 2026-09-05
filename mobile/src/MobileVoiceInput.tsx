import { useEffect, useMemo, useRef, useState } from 'react'
import {
  downmixToMono,
  encodePcm16,
  REMOTE_VOICE_MAX_SECONDS,
  REMOTE_VOICE_SAMPLE_RATE,
  resampleLinear
} from '../../src/shared/remote-voice'
import type { HostEndpoint } from './hosts'
import { transcribeRecording } from './remote-client'
import {
  joinRecognitionResults,
  mobileVoiceLabel,
  recognitionErrorMessage,
  recognitionLanguage,
  voiceInputMode,
  voiceUnavailableReason,
  type MobileVoiceState,
  type VoiceCapabilities
} from './voice-input'

/**
 * The phone composer's microphone. Same states as the desktop's control - idle, loading,
 * listening, stopping, error - over one of two engines, chosen by `voiceInputMode`:
 *
 * - the browser's own `SpeechRecognition`, streaming interim text as the reader speaks and
 *   finishing on the phone in the phone's language; or
 * - a plain WebAudio recording, resampled to 16 kHz PCM and sent to the host to transcribe with
 *   the desktop's model, for browsers without a recognizer.
 *
 * Either way the transcript is *handed to the caller*, never sent: dictation on a phone is at
 * least as error-prone as on a desktop, and the reader gets to read it in the box first.
 */
export interface MobileVoiceInputProps {
  host: HostEndpoint
  disabled?: boolean
  /** The finished transcript. Called once per dictation, and not at all for a discarded one. */
  onTranscript(text: string): void
  /** What the microphone is doing, for the composer to show beneath the row it sits in. */
  onStatus?(status: MobileVoiceStatus): void
}

export interface MobileVoiceStatus {
  state: MobileVoiceState
  /** The button's own label in this state, which is also what a busy state is waiting for. */
  label: string
  /** Live text while listening: what the recognizer has heard so far. */
  interim: string
  error: string
}

export default function MobileVoiceInput({
  host,
  disabled,
  onTranscript,
  onStatus
}: MobileVoiceInputProps): JSX.Element {
  const capabilities = useMemo(readCapabilities, [])
  const mode = voiceInputMode(capabilities)
  const [state, setState] = useState<MobileVoiceState>('idle')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const session = useRef<DictationSession | null>(null)
  const transcriptRef = useRef(onTranscript)
  transcriptRef.current = onTranscript

  useEffect(() => () => session.current?.discard(), [])

  const reason = voiceUnavailableReason(capabilities)
  const label = mobileVoiceLabel(state, mode)
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus
  useEffect(() => {
    statusRef.current?.({ state, label, interim, error })
  }, [state, label, interim, error])

  const fail = (message: string): void => {
    session.current = null
    setInterim('')
    setError(message)
    setState('error')
  }

  const begin = async (): Promise<void> => {
    if (state !== 'idle' && state !== 'error') return
    setError('')
    setInterim('')
    setState('loading')
    try {
      const events: SessionEvents = {
        onInterim: setInterim,
        onText: (text) => {
          session.current = null
          setInterim('')
          setState('idle')
          if (text) transcriptRef.current(text)
        },
        onError: fail,
        onLimit: () => void finish()
      }
      session.current = mode === 'platform' ? startRecognition(events) : await startRecording(host, events)
      setState('listening')
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const finish = async (): Promise<void> => {
    const active = session.current
    if (!active || state !== 'listening') return
    setState('stopping')
    await active.finish()
  }

  const discard = (): void => {
    session.current?.discard()
    session.current = null
    setInterim('')
    setState('idle')
  }

  return (
    <div className="voice-input" data-mode={mode}>
      <button
        type="button"
        className="voice-button"
        data-state={state}
        aria-label={reason ?? label}
        title={error || reason || label}
        disabled={disabled || mode === 'unavailable' || state === 'loading' || state === 'stopping'}
        onClick={() => (state === 'listening' ? void finish() : void begin())}
      >
        {state === 'listening' ? (
          <StopGlyph />
        ) : state === 'loading' || state === 'stopping' ? (
          <BusyGlyph />
        ) : (
          <MicGlyph />
        )}
      </button>
      {state === 'listening' && (
        <button type="button" className="voice-discard" aria-label="Discard this dictation" onClick={discard}>
          ×
        </button>
      )}
    </div>
  )
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

/** One dictation in progress, whichever engine is behind it. */
interface DictationSession {
  /** Stops listening and delivers the transcript through `onText`. */
  finish(): Promise<void>
  /** Stops listening and delivers nothing. */
  discard(): void
}

interface SessionEvents {
  onInterim(text: string): void
  onText(text: string): void
  onError(message: string): void
  /** The recording reached the longest the host accepts; the caller finishes it. */
  onLimit(): void
}

function readCapabilities(): VoiceCapabilities {
  return {
    speechRecognition: recognitionConstructor() !== null,
    mediaDevices: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
    secureContext: typeof window !== 'undefined' && window.isSecureContext
  }
}

/*
 * The Web Speech API, typed to the slice used here. The DOM lib types are incomplete across
 * TypeScript versions and the constructor is prefixed on WebKit, so the shape is spelled out.
 */
interface RecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: { readonly transcript: string }
}

interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<RecognitionResultLike> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type RecognitionConstructor = new () => RecognitionLike

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const global = window as unknown as Record<string, unknown>
  const candidate = global.SpeechRecognition ?? global.webkitSpeechRecognition
  return typeof candidate === 'function' ? (candidate as RecognitionConstructor) : null
}

/**
 * The phone's recognizer. Continuous with interim results so the preview moves while the reader
 * speaks. The recognizer ends on its own after a silence (Android does this within seconds); an end
 * that was not asked for still delivers what was heard, because losing a sentence to a pause is the
 * failure a dictation control must not have.
 */
function startRecognition(events: SessionEvents): DictationSession {
  const Recognition = recognitionConstructor()
  if (!Recognition) throw new Error('This browser has no speech recognizer.')
  const recognition = new Recognition()
  recognition.lang = recognitionLanguage(navigator.language)
  recognition.continuous = true
  recognition.interimResults = true

  let final = ''
  let interim = ''
  let discarded = false
  let settled = false
  const settle = (): void => {
    if (settled || discarded) return
    settled = true
    events.onText([final, interim].filter(Boolean).join(' ').trim())
  }

  recognition.onresult = (event) => {
    const results: { transcript: string; isFinal: boolean }[] = []
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index]
      results.push({ transcript: result[0]?.transcript ?? '', isFinal: result.isFinal })
    }
    const joined = joinRecognitionResults(results)
    final = joined.final
    interim = joined.interim
    events.onInterim([final, interim].filter(Boolean).join(' '))
  }
  recognition.onerror = (event) => {
    const message = recognitionErrorMessage(event.error)
    if (!message) return
    settled = true
    events.onError(message)
  }
  recognition.onend = settle
  recognition.start()

  return {
    finish: () => {
      recognition.stop()
      return Promise.resolve()
    },
    discard: () => {
      discarded = true
      recognition.abort()
    }
  }
}

/**
 * Plain WebAudio capture for browsers without a recognizer. A `ScriptProcessorNode` rather than an
 * `AudioWorklet`: it is deprecated but it runs everywhere without a second bundle entry, and a
 * dictation is short enough that its main-thread cost does not show. Samples are kept at the
 * device rate and resampled once at the end.
 */
async function startRecording(host: HostEndpoint, events: SessionEvents): Promise<DictationSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let captured = 0
  const limit = context.sampleRate * REMOTE_VOICE_MAX_SECONDS
  let stopped = false

  processor.onaudioprocess = (event) => {
    if (stopped) return
    const channels: Float32Array[] = []
    for (let channel = 0; channel < event.inputBuffer.numberOfChannels; channel += 1) {
      channels.push(new Float32Array(event.inputBuffer.getChannelData(channel)))
    }
    const mono = downmixToMono(channels)
    chunks.push(mono)
    captured += mono.length
    if (captured >= limit) {
      stopped = true
      events.onLimit()
    }
  }
  source.connect(processor)
  // A ScriptProcessorNode only runs while it is connected to the graph's output.
  processor.connect(context.destination)

  const release = async (): Promise<void> => {
    stopped = true
    processor.disconnect()
    source.disconnect()
    for (const track of stream.getTracks()) track.stop()
    await context.close()
  }

  return {
    finish: async () => {
      await release()
      const samples = concat(chunks)
      const pcm = encodePcm16(resampleLinear(samples, context.sampleRate, REMOTE_VOICE_SAMPLE_RATE))
      const result = await transcribeRecording(host, pcm)
      if (result.ok) events.onText(result.value)
      else events.onError(result.kind === 'unauthorized' ? 'This host no longer accepts the pairing.' : result.message)
    },
    discard: () => void release()
  }
}

function concat(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

function MicGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

function StopGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function BusyGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}
