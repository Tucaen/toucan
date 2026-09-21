import { useRef, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import VoiceInput from '../src/renderer/src/VoiceInput'
import { DictationCleanupContext } from '../src/renderer/src/dictation-cleanup-context'
import type { DictationCleanupResult } from '../src/shared/dictation-cleanup'

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) }
  })
  class FakeAudioContext {
    sampleRate = 16_000
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createScriptProcessor() {
      return { connect() {}, disconnect() {}, onaudioprocess: null }
    }
    async close() {}
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  window.voiceModelApi = {
    state: async () => ({ phase: 'ready' }),
    ensure: async () => ({ phase: 'ready' }),
    onChange: () => () => {},
    transcribe: async () => ({ ok: true, text: 'um our our options' })
  }
  window.dictationCleanupApi = {
    clean: vi.fn(async () => ({
      status: 'cleaned',
      text: 'Our options.',
      requestedModelId: 'haiku',
      servedModel: 'claude-haiku-4-5'
    })),
    cancel: vi.fn(async () => {})
  }
})

function Composer({ enabled = true }: { enabled?: boolean }) {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <DictationCleanupContext.Provider value={{ preference: { enabled }, setPreference: () => {} }}>
      <textarea aria-label="Draft" ref={ref} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <VoiceInput draft={draft} setDraft={setDraft} textareaRef={ref} disabled={false} context="Toucan settings" />
    </DictationCleanupContext.Provider>
  )
}

async function dictate() {
  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop dictation' }))
}

test('default-off dictation inserts raw text without asking for cleanup', async () => {
  render(<Composer enabled={false} />)
  await dictate()
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('um our our options'))
  expect(window.dictationCleanupApi.clean).not.toHaveBeenCalled()
})

test('polishing can be cancelled to raw text and ignores a late cleaned result', async () => {
  let finish!: (result: DictationCleanupResult) => void
  vi.mocked(window.dictationCleanupApi.clean).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<Composer />)
  await dictate()
  expect(await screen.findByText('Polishing…')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Use original dictation' }))
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('um our our options'))
  expect(window.dictationCleanupApi.cancel).toHaveBeenCalled()
  finish({ status: 'cleaned', text: 'Late replacement', requestedModelId: 'haiku' })
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('um our our options'))
  expect(screen.getByRole('status')).toHaveTextContent(/cancelled/i)
})

test('successful cleanup inserts only the corrected transcript and names the model that served it', async () => {
  render(<Composer />)
  await dictate()
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Our options.'))
  expect(window.dictationCleanupApi.clean).toHaveBeenCalledWith(
    expect.objectContaining({
      text: 'um our our options',
      context: 'Toucan settings',
      preference: { enabled: true }
    })
  )
  expect(screen.getByRole('status')).toHaveTextContent('Polished with Claude Haiku 4.5.')
})

test('a response that never named its model says the model was requested, not that it ran', async () => {
  vi.mocked(window.dictationCleanupApi.clean).mockResolvedValue({
    status: 'cleaned',
    text: 'Our options.',
    requestedModelId: 'haiku'
  })
  render(<Composer />)
  await dictate()
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Our options.'))
  expect(screen.getByRole('status')).toHaveTextContent('Polished with Claude (Haiku requested).')
})

test('a failed cleanup or lost IPC reply inserts raw dictation and makes the reason visible', async () => {
  vi.mocked(window.dictationCleanupApi.clean).mockRejectedValue(new Error('Connection lost'))
  render(<Composer />)
  await dictate()
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('um our our options'))
  // A failure names no model: the old wording appended one and read as though it were the cause.
  expect(screen.getByRole('status')).toHaveTextContent('Original dictation inserted. Connection lost')
  expect(screen.getByRole('status').textContent).not.toMatch(/requested|unverified/i)
})

test('closing the composer during cleanup cancels its process', async () => {
  vi.mocked(window.dictationCleanupApi.clean).mockImplementation(() => new Promise(() => {}))
  const view = render(<Composer />)
  await dictate()
  await screen.findByText('Polishing…')
  view.unmount()
  await waitFor(() => expect(window.dictationCleanupApi.cancel).toHaveBeenCalled())
})

test('a cleanup IPC call that never replies cannot hang the composer', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(window.dictationCleanupApi.clean).mockImplementation(() => new Promise(() => {}))
    render(<Composer />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    })
    expect(screen.getByText('Polishing…')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(screen.getByRole('textbox')).toHaveValue('um our our options')
    expect(screen.getByRole('status')).toHaveTextContent('Cleanup timed out.')
    expect(window.dictationCleanupApi.cancel).toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
