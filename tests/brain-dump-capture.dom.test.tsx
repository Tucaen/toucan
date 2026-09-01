import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import BrainDumpLibraryPanel from '../src/renderer/src/BrainDumpLibraryPanel'
import { BRAIN_DUMP_PANEL_DEFAULT_WIDTH } from '../src/renderer/src/brain-dump-panel-layout'
import type { BrainDumpPanelState, WorkspaceProject } from '../src/shared/terminal'
import { createMockBrainDumpApi, topicFixture, type MockBrainDumpApi } from './dom/brain-dump-api-mock'

/**
 * Capture: the pen and microphone paths into one review tray, the draft that outlives the tray, and
 * the background job's working/success/failure presentation. The transcript is a draft here, never
 * a submission, and a completed job is believed only after the library is re-read from disk.
 */

const speech = { failLoad: false, transcript: 'dictated words' }

vi.mock('@moonshine-ai/moonshine-wasm', () => {
  class MicTranscriber {
    isRunning = false
    private line: ((value: { text: string }) => void) | undefined
    language(): this {
      return this
    }
    modelArch(): this {
      return this
    }
    modelsFrom(): this {
      return this
    }
    onProgress(): this {
      return this
    }
    onText(): this {
      return this
    }
    onLine(callback: (value: { text: string }) => void): this {
      this.line = callback
      return this
    }
    onError(): this {
      return this
    }
    async load(): Promise<void> {
      if (speech.failLoad) throw new Error('The microphone could not be opened.')
    }
    async start(): Promise<void> {
      this.isRunning = true
      this.line?.({ text: speech.transcript })
    }
    async stop(): Promise<void> {
      this.isRunning = false
    }
    close(): void {}
  }
  return { MicTranscriber, ModelArch: { SmallStreaming: 'small-streaming' } }
})

const projects: WorkspaceProject[] = [
  { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }
]

function renderPanel(
  api: MockBrainDumpApi,
  panel: Partial<BrainDumpPanelState> = {}
): {
  onPanelChange: ReturnType<typeof vi.fn>
  onOpenSessionOnCanvas: ReturnType<typeof vi.fn>
} {
  const onPanelChange = vi.fn()
  const onOpenSessionOnCanvas = vi.fn()
  const state: BrainDumpPanelState = { open: true, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH, ...panel }
  render(
    <BrainDumpLibraryPanel
      workspaceWidth={1920}
      projects={projects}
      activeProjectPath={projects[0].path}
      panel={state}
      api={api}
      today="2026-08-31"
      onPanelChange={onPanelChange}
      onOpenSessionOnCanvas={onOpenSessionOnCanvas}
    />
  )
  return { onPanelChange, onOpenSessionOnCanvas }
}

describe('the review tray', () => {
  let api: MockBrainDumpApi

  beforeEach(() => {
    speech.failLoad = false
    speech.transcript = 'dictated words'
    api = createMockBrainDumpApi()
  })

  test('the pen opens an empty focused editor and submits nothing until asked', async () => {
    const panel = renderPanel(api)
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))

    const editor = screen.getByLabelText('Brain dump')
    expect(editor).toHaveFocus()
    expect(screen.getByText('Write freely. The skill will organize it into topics.')).toBeInTheDocument()
    expect(api.startCapture).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Organize with brain-dump skill' })).toBeDisabled()

    fireEvent.change(editor, { target: { value: 'Ship the docked panel' } })
    expect(panel.onPanelChange).toHaveBeenCalledWith({ draft: 'Ship the docked panel' })
  })

  test('the microphone puts a transcript into the same editor and never submits it', async () => {
    const panel = renderPanel(api)
    fireEvent.click(screen.getByRole('button', { name: 'Record a brain dump with the microphone' }))

    await screen.findByText('Listening — speak now')
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))

    await waitFor(() => expect(panel.onPanelChange).toHaveBeenCalledWith({ draft: 'dictated words' }))
    expect(api.startCapture).not.toHaveBeenCalled()
    expect(screen.getByText('Correct any transcription mistakes before organizing.')).toBeInTheDocument()
  })

  test('a microphone failure keeps the draft and offers typing instead', async () => {
    speech.failLoad = true
    renderPanel(api, { draft: 'partly typed already' })
    fireEvent.click(screen.getByRole('button', { name: 'Record a brain dump with the microphone' }))

    await screen.findByText('The microphone could not be opened.')
    expect(screen.getByLabelText('Brain dump')).toHaveValue('partly typed already')
    fireEvent.click(screen.getByRole('button', { name: 'Type instead' }))
    expect(screen.getByLabelText('Brain dump')).toHaveFocus()
  })

  test('closing the tray keeps the draft, and only Discard clears it', () => {
    const panel = renderPanel(api, { draft: 'still worth keeping' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close tray' }))
    expect(panel.onPanelChange).not.toHaveBeenCalledWith(expect.objectContaining({ draft: '' }))

    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    expect(screen.getByLabelText('Brain dump')).toHaveValue('still worth keeping')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(panel.onPanelChange).toHaveBeenCalledWith({ draft: '', draftProjectPath: undefined })
  })

  test('Escape closes the tray before the panel and preserves the draft', () => {
    const panel = renderPanel(api, { draft: 'kept' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.keyDown(screen.getByLabelText('Brain dump'), { key: 'Escape' })
    expect(screen.queryByLabelText('Brain dump')).toBeNull()
    expect(panel.onPanelChange).not.toHaveBeenCalledWith({ open: false })

    // Only once the tray is gone does Escape reach the panel itself.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Write a brain dump' }), { key: 'Escape' })
    expect(panel.onPanelChange).toHaveBeenCalledWith({ open: false })
  })

  test('a draft defaults to the active project and remembers an explicit change', () => {
    const panel = renderPanel(api, { draft: 'text' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    expect(screen.getByLabelText('Project')).toHaveValue('D:\\Development\\Toucan')

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } })
    expect(panel.onPanelChange).toHaveBeenCalledWith({ draftProjectPath: undefined })
  })

  test('submitting sends the reviewed draft, project, and provider', async () => {
    renderPanel(api, { draft: 'organize me', provider: 'claude', draftProjectPath: 'D:\\Development\\Toucan' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))

    await waitFor(() =>
      expect(api.startCapture).toHaveBeenCalledWith({
        content: 'organize me',
        provider: 'claude',
        projectPath: 'D:\\Development\\Toucan'
      })
    )
  })

  test('Codex is the provider when no preference has been recorded', async () => {
    renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    expect(screen.getByLabelText('Provider')).toHaveValue('codex')
  })
})

describe('the background job', () => {
  let api: MockBrainDumpApi

  beforeEach(() => {
    api = createMockBrainDumpApi()
  })

  test('a working job disables submitting again and both capture buttons', async () => {
    renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))

    await screen.findByText('Organizing brain dump…')
    expect(screen.getByRole('button', { name: 'Organize with brain-dump skill' })).toBeDisabled()
    const microphone = screen.getByRole('button', { name: 'Record a brain dump with the microphone' })
    expect(screen.getByRole('button', { name: 'Write a brain dump' })).toBeDisabled()
    expect(microphone).toBeDisabled()
    expect(microphone).toHaveAttribute('title', expect.stringContaining('being organized'))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  test('closing the tray leaves the job running, visible, and cancellable', async () => {
    renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))
    await screen.findByText('Organizing brain dump…')

    fireEvent.click(screen.getByRole('button', { name: 'Close tray' }))
    expect(api.cancelCapture).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Brain dump')).toBeNull()
    // The job outlives the tray, so its progress and Cancel stay reachable at panel level.
    expect(screen.getByText('Organizing brain dump…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.cancelCapture).toHaveBeenCalledWith('job-1')
  })

  test('a failure survives the tray being closed and can reopen it for editing', async () => {
    renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))
    await screen.findByText('Organizing brain dump…')
    fireEvent.click(screen.getByRole('button', { name: 'Close tray' }))

    api.publishCapture({ status: 'failed', jobId: 'job-1', code: 'skill', message: 'The skill failed.' })
    await screen.findByText('The skill failed.')

    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
    expect(screen.getByLabelText('Brain dump')).toHaveValue('organize me')
  })

  test('success refreshes the library from disk, selects the filed topic, and clears the draft', async () => {
    const panel = renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))
    await screen.findByText('Organizing brain dump…')

    api.collections.active.topics = [
      topicFixture({ slug: 'docked-panel', title: 'Docked panel', updated: '2026-08-31' })
    ]
    // The filesystem notification arrives before the capture completion event in the real app.
    // It must not consume the before/after diff that selects the topic filed by this job.
    api.publishLibraryChange('active')
    expect(api.listCalls.filter((call) => call === 'active')).toHaveLength(1)
    api.publishCapture({
      status: 'completed',
      jobId: 'job-1',
      summary: 'Created docked-panel.',
      conversation: { provider: 'codex', conversationId: 'c1', cwd: 'D:\\Development\\Toucan' }
    })

    await screen.findByRole('heading', { name: 'Docked panel' })
    expect(api.listCalls.filter((call) => call === 'active')).toHaveLength(2)
    expect(panel.onPanelChange).toHaveBeenCalledWith({ draft: '', draftProjectPath: undefined })
    // The provider becomes the remembered preference only once a capture has actually landed.
    expect(panel.onPanelChange).toHaveBeenCalledWith({ provider: 'codex' })
    await waitFor(() => expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Created docked-panel.'))
  })

  test('a failure keeps the draft and offers retry, edit, and opening the session on canvas', async () => {
    const panel = renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))
    await screen.findByText('Organizing brain dump…')

    api.publishCapture({
      status: 'failed',
      jobId: 'job-1',
      code: 'skill',
      message: 'The brain-dump skill reported an error.',
      conversation: { provider: 'codex', conversationId: 'c1', cwd: 'D:\\Development\\Toucan' }
    })

    await screen.findByText('The brain-dump skill reported an error.')
    expect(screen.getByLabelText('Brain dump')).toHaveValue('organize me')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open session on canvas' }))
    expect(panel.onOpenSessionOnCanvas).toHaveBeenCalledWith({
      provider: 'codex',
      conversationId: 'c1',
      cwd: 'D:\\Development\\Toucan'
    })
  })

  test('an authentication failure points at the provider sign-in on the canvas', async () => {
    renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))
    await screen.findByText('Organizing brain dump…')

    api.publishCapture({
      status: 'failed',
      jobId: 'job-1',
      code: 'auth',
      message: 'Authentication is required.',
      conversation: { provider: 'codex', conversationId: 'c1', cwd: 'D:\\Development\\Toucan' }
    })

    await screen.findByText('Open the session on the canvas to sign in with your provider.')
  })

  test('a rejected start is reported without losing the draft', async () => {
    const start = api.startCapture as ReturnType<typeof vi.fn>
    start.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'A brain-dump capture is already running.' })
    renderPanel(api, { draft: 'organize me' })
    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organize with brain-dump skill' }))

    await screen.findByText('A brain-dump capture is already running.')
    expect(screen.getByLabelText('Brain dump')).toHaveValue('organize me')
  })
})
