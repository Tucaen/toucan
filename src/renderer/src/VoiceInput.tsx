import { useEffect, useRef, useState, type RefObject } from 'react'
import { MicTranscriber, ModelArch, Transcriber } from '@moonshine-ai/moonshine-wasm'
import { LoaderCircle, Mic, Square, X } from 'lucide-react'
import { VOICE_MODEL_ASSET_DIRECTORY, VOICE_MODEL_LANGUAGE } from '../../shared/remote-voice'
import { voiceModelProgress, type VoiceModelStatus } from '../../shared/voice-model'
import { withStallGuard } from '../../shared/stall-guard'
import { errorMessage } from '../../shared/text'
import { fetchVoiceModelFiles } from './voice-model-files'
import {
  insertAtSelection,
  joinTranscript,
  voiceControlLabel,
  voiceLivePreview,
  type VoiceState
} from './voice-transcript'

export type { VoiceState } from './voice-transcript'

/**
 * The composer's dictation control: local, streaming, English.
 *
 * Speech runs entirely on this machine with Moonshine's Medium Streaming English model, the most
 * accurate streaming model it publishes. The model is not in the installer: the host downloads it
 * once on first use (see shared/voice-model.ts) and serves it from disk at LOCAL_MODEL_URL. Live
 * partial text is shown while speaking; the finished transcript is inserted at the cursor position
 * the microphone was pressed at, and it is never sent on its own - a transcript is a draft.
 *
 * Accuracy on the words a general model gets wrong - identifiers, file names, product words - comes
 * from `context`: the caller hands over the text the speaker is most likely talking about, and the
 * model is biased towards the terms in it for the duration of the dictation.
 *
 * The model understands English only. The control says so in its label and its preview rather
 * than letting another language come out as plausible-looking nonsense; a phone's own recognizer
 * (see `mobile/src/MobileVoiceInput.tsx`) is the multilingual path.
 */
interface VoiceInputProps {
  draft: string
  disabled: boolean
  textareaRef: RefObject<HTMLTextAreaElement>
  setDraft(value: string): void
  /** Starts dictation as soon as the control mounts, for callers opened *by* a microphone action. */
  autoStart?: boolean
  /** Text whose vocabulary the model should lean towards; see `dictationContext`. */
  context?: string
  /** Lets a surrounding surface show the same loading/listening/failure states this button owns. */
  onStateChange?(state: VoiceState, error: string): void
}

const LOCAL_MODEL_URL = new URL(`./${VOICE_MODEL_ASSET_DIRECTORY}/`, window.location.href).toString()

// By the time this runs the model is on disk (the host's download is awaited first), so this only
// needs to absorb slow hardware - not a slow internet connection. It exists so a dependency that never
// settles (see shared/stall-guard.ts) can't leave the "Preparing local speech model..." banner
// stuck forever: a WASM worker that dies on startup never rejects its load promise.
const VOICE_STALL_TIMEOUT_MS = 60_000

/**
 * The renderer has to be cross-origin isolated or Moonshine's threaded WASM cannot have a
 * `SharedArrayBuffer`, and its pthread worker then fails its first `postMessage` inside a promise
 * that never settles - a stuck "Preparing local speech model...", not an error. The host serves
 * both origins with the isolation headers (`main/app-protocol.ts`, `electron.vite.config.ts`), so
 * this failing means something has been reconfigured, and saying so beats a timeout.
 */
const ISOLATION_MESSAGE =
  'This window is not cross-origin isolated, so the local speech model cannot run. Restart Toucan.'

export default function VoiceInput(props: VoiceInputProps): JSX.Element {
  const [state, setState] = useState<VoiceState>('idle')
  const [progress, setProgress] = useState(0)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState('')
  const transcriberRef = useRef<MicTranscriber>()
  // Held apart from the microphone because the microphone does not own it: the model is built once
  // from bytes and handed over, so closing it is this component's job, not `MicTranscriber.close`'s.
  const modelRef = useRef<Transcriber>()
  const completedLinesRef = useRef<string[]>([])
  const partialRef = useRef('')
  const insertionRef = useRef({ start: 0, end: 0 })

  const fail = (cause: unknown): void => {
    setError(errorMessage(cause))
    setState('error')
  }

  useEffect(
    () => () => {
      const transcriber = transcriberRef.current
      if (transcriber?.isRunning) void transcriber.stop()
      transcriber?.close()
      modelRef.current?.close()
    },
    []
  )

  const begin = async (): Promise<void> => {
    if (state !== 'idle' && state !== 'error') return
    const textarea = props.textareaRef.current
    insertionRef.current = {
      start: textarea?.selectionStart ?? props.draft.length,
      end: textarea?.selectionEnd ?? props.draft.length
    }
    completedLinesRef.current = []
    partialRef.current = ''
    setPartial('')
    setError('')
    setProgress(0)

    try {
      let transcriber = transcriberRef.current
      if (!transcriber) {
        // The model is not in the installer: the host fetches it once, into its own data directory,
        // and serves it at LOCAL_MODEL_URL from there. Until it is on disk the button reports the
        // download, with the host's own byte counts, rather than a "preparing" that never moves.
        setState('downloading')
        const unsubscribe = window.voiceModelApi.onChange((status) => setProgress(voiceModelProgress(status)))
        let model: VoiceModelStatus
        try {
          model = await window.voiceModelApi.ensure()
        } finally {
          unsubscribe()
        }
        if (model.phase !== 'ready') {
          throw new Error(model.phase === 'error' ? model.message : 'The speech model is not available.')
        }
        setProgress(0)
      }
      setState('loading')
      if (!transcriber) {
        if (!window.crossOriginIsolated) throw new Error(ISOLATION_MESSAGE)
        // The host names the files; the renderer reads them off its own origin and hands the bytes
        // to the loader. See `voice-model-files.ts` for why Moonshine's downloader is not used.
        const listed = await window.voiceModelApi.files()
        if (listed.length === 0) throw new Error('The speech model is not available.')
        const bytes = await fetchVoiceModelFiles(listed, LOCAL_MODEL_URL, (fraction) => setProgress(fraction))
        const model = await withStallGuard(
          Transcriber.load({ files: bytes, modelArch: ModelArch.MediumStreaming }),
          VOICE_STALL_TIMEOUT_MS,
          'Local speech model timed out while loading.'
        )
        modelRef.current = model
        transcriber = new MicTranscriber()
          .useTranscriber(model)
          .language(VOICE_MODEL_LANGUAGE)
          .onText((text) => {
            partialRef.current = text
            setPartial(text)
          })
          .onLine((line) => {
            completedLinesRef.current.push(line.text)
            partialRef.current = ''
            setPartial('')
          })
          .onError((cause) => {
            setError(cause.message)
            setState('error')
          })
        transcriberRef.current = transcriber
      }
      // Re-applied on every start rather than once: what the speaker is talking about changes
      // between dictations, and an empty context clears the previous one instead of keeping it.
      transcriber.setContext(props.context ?? '')
      await withStallGuard(transcriber.start(), VOICE_STALL_TIMEOUT_MS, 'Local speech model timed out while starting.')
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
    const transcriber = transcriberRef.current
    if (!transcriber || state !== 'listening') return
    setState('stopping')
    try {
      await transcriber.stop()
      if (keepTranscript) {
        const transcript = joinTranscript(completedLinesRef.current, partialRef.current)
        if (transcript) {
          const { start, end } = insertionRef.current
          props.setDraft(insertAtSelection(props.draft, transcript, start, end))
          requestAnimationFrame(() => props.textareaRef.current?.focus())
        }
      }
      setPartial('')
      setState('idle')
    } catch (cause) {
      fail(cause)
    }
  }

  const label = voiceControlLabel(state, progress)
  const preview = voiceLivePreview(state, progress, partial, error)

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
