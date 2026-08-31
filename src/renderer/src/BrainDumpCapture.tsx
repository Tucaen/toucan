import { useEffect, useRef, useState } from 'react'
import type { WorkspaceProject } from '../../shared/terminal'
import VoiceInputPrototype, { type VoiceState } from './VoiceInputPrototype'

/**
 * The shared review tray. Both capture buttons land here and differ only in how the first words
 * arrive: typed, or dictated through ADE's existing local speech pipeline. Nothing is ever sent
 * without the user submitting it - a transcript is a draft, not a decision - and the draft outlives
 * the tray, the panel, and a renderer reload, because the only things allowed to clear it are a
 * filed capture and an explicit Discard. A running job is *not* shown here: it outlives the tray,
 * so `BrainDumpCaptureStatus` reports it at panel level instead.
 */

const microphoneStateLabels: Record<VoiceState, string> = {
  idle: 'Microphone ready',
  loading: 'Preparing the local speech model',
  listening: 'Listening — speak now',
  stopping: 'Finishing the transcript',
  error: 'The microphone could not be used'
}

export interface BrainDumpCaptureProps {
  draft: string
  projectPath?: string
  provider: 'claude' | 'codex'
  projects: readonly WorkspaceProject[]
  /** True when the tray was opened by the microphone button, which starts dictation immediately. */
  microphone: boolean
  /** True while a capture is running, which is what makes submitting again meaningless. */
  jobActive: boolean
  startError?: string
  /** Set by the panel when a failure recovery asked for the draft to be edited. */
  focusSignal: number
  onDraftChange(text: string): void
  onProjectChange(projectPath: string | undefined): void
  onProviderChange(provider: 'claude' | 'codex'): void
  onSubmit(): void
  onDiscard(): void
  onClose(): void
}

export default function BrainDumpCapture(props: BrainDumpCaptureProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [voice, setVoice] = useState<{ state: VoiceState; error: string }>({ state: 'idle', error: '' })
  const { focusSignal, microphone } = props

  useEffect(() => {
    if (!microphone) textareaRef.current?.focus()
  }, [focusSignal, microphone])

  return (
    <section className="brain-dump-capture" aria-label="Review and organize a brain dump">
      <div className="brain-dump-capture-head">
        <strong>{props.microphone ? 'Review the transcript' : 'Write a brain dump'}</strong>
        <p>
          {props.microphone
            ? 'Correct any transcription mistakes before organizing.'
            : 'Write freely. The skill will organize it into topics.'}
        </p>
        <button type="button" className="brain-dump-capture-close" onClick={props.onClose}>
          Close tray
        </button>
      </div>

      {props.microphone && (
        <div className="brain-dump-capture-voice">
          <VoiceInputPrototype
            autoStart
            draft={props.draft}
            disabled={props.jobActive}
            textareaRef={textareaRef}
            setDraft={props.onDraftChange}
            onStateChange={(state, error) => setVoice({ state, error })}
          />
          <span className="brain-dump-voice-state" role="status" data-state={voice.state}>
            {voice.state === 'error' ? voice.error || microphoneStateLabels.error : microphoneStateLabels[voice.state]}
          </span>
          {voice.state === 'error' && (
            <button type="button" onClick={() => textareaRef.current?.focus()}>
              Type instead
            </button>
          )}
        </div>
      )}

      <label className="brain-dump-capture-editor">
        <span>Brain dump</span>
        <textarea
          ref={textareaRef}
          value={props.draft}
          rows={6}
          placeholder="What is on your mind?"
          onChange={(event) => props.onDraftChange(event.target.value)}
        />
      </label>

      <div className="brain-dump-capture-footer">
        <label className="brain-dump-capture-select">
          <span>Project</span>
          <select
            value={props.projectPath ?? ''}
            onChange={(event) => props.onProjectChange(event.target.value || undefined)}
          >
            <option value="">Unassigned</option>
            {props.projects.map((project) => (
              <option key={project.id} value={project.path}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="brain-dump-capture-select">
          <span>Provider</span>
          <select
            value={props.provider}
            onChange={(event) => props.onProviderChange(event.target.value === 'claude' ? 'claude' : 'codex')}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>

        <div className="brain-dump-capture-actions">
          <button type="button" onClick={props.onDiscard} disabled={!props.draft}>
            Discard
          </button>
          <button
            type="button"
            className="primary"
            disabled={!props.draft.trim() || props.jobActive}
            title={props.jobActive ? 'A brain dump is already being organized' : undefined}
            onClick={props.onSubmit}
          >
            Organize with brain-dump skill
          </button>
        </div>
      </div>

      {props.startError && (
        <p className="brain-dump-capture-error" role="alert">
          {props.startError}
        </p>
      )}
    </section>
  )
}
