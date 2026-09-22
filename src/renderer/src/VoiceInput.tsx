import { useEffect, useRef, useState, type RefObject } from 'react'
import { LoaderCircle, Mic, Square, X } from 'lucide-react'
import { startPcmRecording, type PcmRecording } from '../../shared/pcm-recorder'
import { encodePcm16 } from '../../shared/remote-voice'
import { voiceModelProgress } from '../../shared/voice-model'
import { withStallGuard } from '../../shared/stall-guard'
import { errorMessage } from '../../shared/text'
import { useDictationCleanup } from './use-dictation-cleanup'
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

export default function VoiceInput(props: VoiceInputProps): JSX.Element {
  const cleanup = useDictationCleanup()
  const propsRef = useRef(props)
  propsRef.current = props
  const [state, setState] = useState<VoiceState>('idle')
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const sessionRef = useRef<PcmRecording | null>(null)
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
    cleanup.clearReport()
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
        startPcmRecording({
          onPeak: (seconds, peak) => {
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
      let transcript = result.text.trim()
      if (transcript) {
        if (cleanup.enabled) {
          setState('polishing')
          const polished = await cleanup.clean(transcript, contextRef.current ?? '')
          if (!polished) return
          transcript = polished.text
        }
        // The draft as it is now, never the render Stop was clicked in, whose closure would
        // overwrite whatever was typed while the decode ran (#221).
        const { start, end } = insertionRef.current
        const current = propsRef.current
        current.setDraft(insertAtSelection(current.draft, transcript, start, end))
        requestAnimationFrame(() => propsRef.current.textareaRef.current?.focus())
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
        disabled={
          props.disabled ||
          state === 'downloading' ||
          state === 'loading' ||
          state === 'stopping' ||
          state === 'polishing'
        }
        onClick={() => (state === 'listening' ? void finish(true) : void begin())}
      >
        {state === 'downloading' || state === 'loading' || state === 'stopping' || state === 'polishing' ? (
          <LoaderCircle aria-hidden="true" />
        ) : state === 'listening' ? (
          <Square aria-hidden="true" />
        ) : (
          <Mic aria-hidden="true" />
        )}
      </button>
      {state === 'polishing' && (
        <button
          type="button"
          className="voice-cancel-button"
          title="Use original dictation"
          aria-label="Use original dictation"
          onClick={cleanup.cancel}
        >
          <X aria-hidden="true" />
        </button>
      )}
      {state === 'idle' && cleanup.report && (
        <span className="voice-live-preview voice-cleanup-report" role="status" title={cleanup.report}>
          <span>{cleanup.report}</span>
          <button type="button" aria-label="Dismiss cleanup status" onClick={cleanup.clearReport}>
            <X aria-hidden="true" />
          </button>
        </span>
      )}
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
          role={state === 'error' ? 'alert' : state === 'polishing' ? 'status' : undefined}
        >
          {preview}
        </span>
      )}
    </div>
  )
}
