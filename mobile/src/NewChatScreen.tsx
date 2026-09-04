import { useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import { EMPTY_REMOTE_WORKSPACE_SNAPSHOT } from '../../src/shared/remote-access'
import type { SavedHost } from './hosts'
import { initialNewChatForm, newChatProblem, newChatRequest, NEW_CHAT_KINDS, type NewChatForm } from './new-chat'
import { createChat, fetchWorkspace } from './remote-client'

/**
 * Starting a chat from the phone: pick a project, pick an agent, optionally say the first thing.
 *
 * Every decision this screen makes lives in `new-chat.ts`; what is left here is the wait, and the
 * wait is the honest part. `POST /api/chats` is held open by the host until the desktop has added
 * the node *and* its session has come up, so this form stays visibly busy for as long as that
 * takes and only navigates on an id the host actually vouched for. A failure - no desktop window,
 * a session that died, a project that was closed in the meantime - is shown right here with the
 * host's own wording and the form still filled in, because every one of those is a thing the
 * reader might fix and retry rather than retype.
 */
export default function NewChatScreen({
  host,
  onBack,
  onUnauthorized,
  onSpawned
}: {
  /** The host the chat is started on: the project list and the spawn are both its own. */
  host: SavedHost
  onBack(): void
  onUnauthorized(): void
  onSpawned(chatId: string): void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<RemoteWorkspaceSnapshot | null>(null)
  const [form, setForm] = useState<NewChatForm>(() => initialNewChatForm(EMPTY_REMOTE_WORKSPACE_SNAPSHOT))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  // Read once rather than polled: this form is open for seconds, and a project list that changed
  // underneath it is caught by the host's own check on the way through.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void fetchWorkspace(host, controller.signal).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setSnapshot(result.value)
        // Only the default *selection* is filled in from the workspace. Replacing the whole form
        // would throw away anything typed while the read was in flight, which on a phone is most
        // of the time the form is open.
        setForm((current) => ({ ...current, projectId: initialNewChatForm(result.value).projectId }))
        return
      }
      if (result.kind === 'unauthorized') unauthorized.current()
      else setProblem(result.message)
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [host])

  const blocked = useMemo(
    () => (snapshot ? newChatProblem(form, snapshot) : 'Reading the workspace…'),
    [form, snapshot]
  )

  const start = async (): Promise<void> => {
    if (!snapshot || blocked) return
    setBusy(true)
    setProblem(null)
    const result = await createChat(host, newChatRequest(form))
    if (result.ok) {
      onSpawned(result.value)
      return
    }
    setBusy(false)
    if (result.kind === 'unauthorized') {
      unauthorized.current()
      return
    }
    setProblem(result.message)
  }

  return (
    <main className="screen">
      <header className="chat-head">
        <button type="button" className="back" onClick={onBack} aria-label="Back to chats">
          ‹
        </button>
        <div className="chat-head-copy">
          <h1>New chat</h1>
        </div>
      </header>

      <form
        className="new-chat-form"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <fieldset disabled={busy}>
          <legend>Project</legend>
          {snapshot === null && <p className="empty">Reading the workspace…</p>}
          {snapshot !== null && snapshot.projects.length === 0 && (
            <p className="empty">No projects are registered on the desktop.</p>
          )}
          <div className="new-chat-projects" role="radiogroup" aria-label="Project">
            {(snapshot?.projects ?? []).map((project) => (
              <button
                key={project.id}
                type="button"
                role="radio"
                aria-checked={form.projectId === project.id}
                className="new-chat-project"
                data-selected={form.projectId === project.id || undefined}
                onClick={() => setForm((current) => ({ ...current, projectId: project.id }))}
              >
                <span className="project-dot" style={{ background: project.color }} />
                {project.name}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={busy}>
          <legend>Agent</legend>
          <div className="new-chat-kinds" role="radiogroup" aria-label="Agent">
            {NEW_CHAT_KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                role="radio"
                aria-checked={form.kind === option.kind}
                className="new-chat-kind"
                data-kind={option.kind}
                data-selected={form.kind === option.kind || undefined}
                onClick={() => setForm((current) => ({ ...current, kind: option.kind }))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="new-chat-input">
          <span>First message (optional)</span>
          <textarea
            rows={4}
            value={form.input}
            disabled={busy}
            placeholder="What should it start on?"
            onChange={(event) => setForm((current) => ({ ...current, input: event.target.value }))}
          />
        </label>

        {problem && (
          <p className="problem" role="alert">
            {problem}
          </p>
        )}

        <button type="submit" disabled={busy || blocked !== null}>
          {busy ? 'Starting…' : 'Start chat'}
        </button>
        {/* The wait is real and worth naming: an agent CLI is being launched on the desktop. */}
        {busy && <p className="hint">Waiting for the desktop to start the session…</p>}
        {!busy && blocked && snapshot !== null && <p className="hint">{blocked}</p>}
      </form>
    </main>
  )
}
