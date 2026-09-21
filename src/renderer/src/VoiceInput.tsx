import { useEffect, useRef, useState, type RefObject } from 'react'
import { LoaderCircle, Mic, Square, X } from 'lucide-react'
import {
  downmixToMono,
  encodePcm16,
  REMOTE_VOICE_MAX_SECONDS,
  REMOTE_VOICE_SAMPLE_RATE,
  resampleLinear
} from '../../shared/remote-voice'
import { voiceModelProgress } from '../../shared/voice-model'
import { withStallGuard } from '../../shared/stall-guard'
import { errorMessage } from '../../shared/text'
import { insertAtSelection, meterLevel, voiceControlLabel, voiceLivePreview, type VoiceState } from './voice-transcript'

export type { VoiceState } from './voice-transcript'

/**
 * The composer's dictation control: local, batch, multilingual.
 *
 * The renderer only records. Raw PCM is captured off the microphone (the same WebAudio path the
 * phone uses for its host fallback), and on Stop the whole utterance crosses to the main process,
 * where whisper.cpp decodes it in one pass - full right-context, so a thinking pause is not a
 * sentence boundary and punctuation comes from content rather than pause timing (#214). While
 * recording there is deliberately no live text: the control shows a level meter and the elapsed
 * time, and the transcript appears when the recording stops.
 *
 * The engine and model are not in the installer: the host downloads them once on first use (see
 * shared/voice-model.ts) and the button reports that download with real byte counts. The finished
 * transcript is inserted at the cursor position the microphone was pressed at, and it is never
 * sent on its own - a transcript is a draft.
 *
 * Accuracy on the words a general model gets wrong - identifiers, file names, product words -
 * comes from `context`: the caller hands over the text the speaker is most likely talking about,
 * and the decoder is biased towards it as its initial prompt.
 */
interface VoiceInputProps {
  draft: string
  disabled: boolean
  textareaRef: RefObject<HTMLTextAreaElement>
  setDraft(value: string): void
  /** Starts dictation as soon as the control mounts, for callers opened *by* a microphone action. */
  autoStart?: boolean
  /** Text whose vocabulary the decoder should lean towards; see `dictationContext`. */
  context?: string
  /** Lets a surrounding surface show the same loading/listening/failure states this button owns. */
  onStateChange?(state: VoiceState, error: string): void
}

/** Opening the microphone has no natural deadline of its own, only a wedge to distinguish from. */
const MICROPHONE_STALL_TIMEOUT_MS = 60_000

/** Generous: a maximum-length recording decoded on a slow CPU is minutes, not seconds. */
const DECODE_STALL_TIMEOUT_MS = 6 * 60_000

/** One recording in progress: the microphone, the graph, and what has been heard so far. */
interface RecordingSession {
  /** Stops the graph and returns the whole utterance as 16 kHz mono samples. */
  finish(): Promise<Float32Array>
  /** Stops the graph and keeps nothing. */
  discard(): void
}

export default function VoiceInput(props: VoiceInputProps): JSX.Element {
  const [state, setState] = useState<VoiceState>('idle')
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const sessionRef = useRef<RecordingSession | null>(null)
  const levelRef = useRef(0)
  const insertionRef = useRef({ start: 0, end: 0 })
  const contextRef = useRef(props.context)
  contextRef.current = props.context

  const fail = (cause: unknown): void => {
    sessionRef.current = null
    setError(errorMessage(cause))
    setState('error')
  }

  useEffect(
    () => () => {
      sessionRef.current?.discard()
      sessionRef.current = null
    },
    []
  )

  // Read by the recording's own callbacks (the cap), which must see the state as it is then.
  const finishRef = useRef<(keepTranscript: boolean) => Promise<void>>()

  const begin = async (): Promise<void> => {
    if (state !== 'idle' && state !== 'error') return
    const textarea = props.textareaRef.current
    insertionRef.current = {
      start: textarea?.selectionStart ?? props.draft.length,
      end: textarea?.selectionEnd ?? props.draft.length
    }
    setError('')
    setProgress(0)
    setElapsed(0)
    levelRef.current = 0
    setLevel(0)

    try {
      // The engine and model are not in the installer: until they are on disk the button reports
      // the download, with the host's own byte counts, rather than a "preparing" that never moves.
      setState('downloading')
      const unsubscribe = window.voiceModelApi.onChange((status) => setProgress(voiceModelProgress(status)))
      let model
      try {
        model = await window.voiceModelApi.ensure()
      } finally {
        unsubscribe()
      }
      if (model.phase !== 'ready') {
        throw new Error(model.phase === 'error' ? model.message : 'The speech model is not available.')
      }
      setProgress(0)
      setState('loading')
      // Bounded because a microphone permission prompt that never settles, or an audio stack that
      // wedges opening the device, would otherwise leave the button spinning without an error.
      sessionRef.current = await withStallGuard(
        startRecording({
          onProgress: (seconds, peak) => {
            levelRef.current = meterLevel(levelRef.current, peak)
            setLevel(levelRef.current)
            setElapsed(seconds)
          },
          // The recording reached the longest the transcriber accepts; keep what was said.
          onLimit: () => void finishRef.current?.(true)
        }),
        MICROPHONE_STALL_TIMEOUT_MS,
        'The microphone timed out while starting.'
      )
      setState('listening')
    } catch (cause) {
      fail(cause)
    }
  }

  // A surface opened *by* a microphone action should already be listening when it appears, and it
  // needs the same states this button shows to explain what the microphone is doing.
  const beginRef = useRef(begin)
  beginRef.current = begin
  const autoStart = props.autoStart
  useEffect(() => {
    if (autoStart) void beginRef.current()
  }, [autoStart])

  const reportStateRef = useRef(props.onStateChange)
  reportStateRef.current = props.onStateChange
  useEffect(() => {
    reportStateRef.current?.(state, error)
  }, [error, state])

  const finish = async (keepTranscript: boolean): Promise<void> => {
    const session = sessionRef.current
    if (!session || state !== 'listening') return
    sessionRef.current = null
    if (!keepTranscript) {
      session.discard()
      setState('idle')
      return
    }
    setState('stopping')
    try {
      const samples = await session.finish()
      // The decode is bounded in main too, but a "Finishing…" that never ends must fail visibly
      // even if the seam itself swallows a reply.
      const result = await withStallGuard(
        window.voiceModelApi.transcribe(encodePcm16(samples), contextRef.current ?? ''),
        DECODE_STALL_TIMEOUT_MS,
        'The transcription timed out.'
      )
      if (!result.ok) throw new Error(result.message)
      const transcript = result.text.trim()
      if (transcript) {
        const { start, end } = insertionRef.current
        props.setDraft(insertAtSelection(props.draft, transcript, start, end))
        requestAnimationFrame(() => props.textareaRef.current?.focus())
      }
      setState('idle')
    } catch (cause) {
      fail(cause)
    }
  }
  finishRef.current = finish

  const label = voiceControlLabel(state, progress)
  const preview = voiceLivePreview(state, progress, elapsed, error)

  return (
    <div className="voice-input">
      <button
        type="button"
        className="voice-input-button"
        data-state={state}
        aria-label={label}
        title={error || label}
        disabled={props.disabled || state === 'downloading' || state === 'loading' || state === 'stopping'}
        onClick={() => (state === 'listening' ? void finish(true) : void begin())}
      >
        {state === 'downloading' || state === 'loading' || state === 'stopping' ? (
          <LoaderCircle aria-hidden="true" />
        ) : state === 'listening' ? (
          <Square aria-hidden="true" />
        ) : (
          <Mic aria-hidden="true" />
        )}
      </button>
      {state === 'listening' && (
        <button
          type="button"
          className="voice-cancel-button"
          title="Discard this dictation"
          aria-label="Discard this dictation"
          onClick={() => void finish(false)}
        >
          <X aria-hidden="true" />
        </button>
      )}
      {state === 'listening' && (
        <span className="voice-level-meter" aria-hidden="true">
          <span className="voice-level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
      )}
      {preview !== null && (
        <span
          className="voice-live-preview"
          data-state={state}
          title={preview}
          role={state === 'error' ? 'alert' : undefined}
        >
          {preview}
        </span>
      )}
    </div>
  )
}

/**
 * Plain WebAudio capture, the same shape as the phone's host-fallback recorder. A
 * `ScriptProcessorNode` rather than an `AudioWorklet`: it is deprecated but it runs without a
 * second bundle entry, and a dictation is short enough that its main-thread cost does not show.
 * Samples are kept at the device rate and resampled once at the end.
 */
async function startRecording(events: {
  onProgress(elapsedSeconds: number, peak: number): void
  onLimit(): void
}): Promise<RecordingSession> {
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
    let peak = 0
    for (const sample of mono) peak = Math.max(peak, Math.abs(sample))
    events.onProgress(captured / context.sampleRate, peak)
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
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const samples = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      return resampleLinear(samples, context.sampleRate, REMOTE_VOICE_SAMPLE_RATE)
    },
    discard: () => void release()
  }
}
