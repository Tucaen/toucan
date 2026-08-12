import { useEffect, useRef, useState, type RefObject } from 'react'
import { MicTranscriber, ModelArch } from '@moonshine-ai/moonshine-wasm'

type VoiceState = 'idle' | 'loading' | 'listening' | 'stopping' | 'error'

interface VoiceInputPrototypeProps {
  draft: string
  disabled: boolean
  textareaRef: RefObject<HTMLTextAreaElement>
  setDraft(value: string): void
}

const LOCAL_MODEL_URL = new URL(
  './models/moonshine-small-streaming-en/',
  window.location.href
).toString()

function joinTranscript(lines: string[], partial: string): string {
  const parts = [...lines]
  const tail = partial.trim()
  if (tail && parts.at(-1)?.trim() !== tail) parts.push(tail)
  return parts.map((part) => part.trim()).filter(Boolean).join(' ')
}

function insertAtSelection(value: string, text: string, start: number, end: number): string {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  return `${before}${prefix}${text}${suffix}${after}`
}

// PROTOTYPE: validates whether local streaming dictation feels useful in ADE's composer.
export default function VoiceInputPrototype(props: VoiceInputPrototypeProps): JSX.Element {
  const [state, setState] = useState<VoiceState>('idle')
  const [progress, setProgress] = useState(0)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState('')
  const transcriberRef = useRef<MicTranscriber>()
  const completedLinesRef = useRef<string[]>([])
  const partialRef = useRef('')
  const insertionRef = useRef({ start: 0, end: 0 })

  const fail = (cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : String(cause))
    setState('error')
  }

  useEffect(() => () => {
    const transcriber = transcriberRef.current
    if (transcriber?.isRunning) void transcriber.stop()
    transcriber?.close()
  }, [])

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
    setState('loading')

    try {
      let transcriber = transcriberRef.current
      if (!transcriber) {
        transcriber = new MicTranscriber()
          .language('en')
          .modelArch(ModelArch.SmallStreaming)
          .modelsFrom(LOCAL_MODEL_URL)
          .onProgress((fraction) => setProgress(fraction))
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
        await transcriber.load()
      }
      await transcriber.start()
      setState('listening')
    } catch (cause) {
      fail(cause)
    }
  }

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

  const loadingLabel = progress > 0
    ? `Preparing local speech model ${Math.round(progress * 100)}%`
    : 'Preparing local speech model'
  const label = state === 'loading'
    ? loadingLabel
    : state === 'listening'
      ? 'Stop dictation'
      : state === 'stopping'
        ? 'Finishing...'
        : 'Dictate locally'

  return (
    <div className="voice-input-prototype">
      <button
        type="button"
        className="voice-input-button"
        data-state={state}
        aria-label={label}
        title={error || label}
        disabled={props.disabled || state === 'loading' || state === 'stopping'}
        onClick={() => state === 'listening' ? void finish(true) : void begin()}
      >
        <span aria-hidden="true">{state === 'listening' ? '■' : '●'}</span>
        {state === 'loading' ? 'Wait' : state === 'listening' ? 'Done' : 'Mic'}
      </button>
      {state === 'listening' && (
        <button
          type="button"
          className="voice-cancel-button"
          title="Discard this dictation"
          aria-label="Discard this dictation"
          onClick={() => void finish(false)}
        >
          ×
        </button>
      )}
      {(state === 'loading' || state === 'listening' || state === 'stopping') && (
        <span
          className="voice-live-preview"
          title={state === 'loading' ? loadingLabel : partial || 'Listening…'}
        >
          {state === 'loading' ? `${loadingLabel}…` : partial || 'Listening…'}
        </span>
      )}
    </div>
  )
}
