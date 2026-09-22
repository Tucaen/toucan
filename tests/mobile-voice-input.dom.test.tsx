import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatSummary } from '../src/shared/remote-access'
import type { RemoteChatServerMessage } from '../src/shared/remote-chat'
import { REMOTE_VOICE_CONTENT_TYPE } from '../src/shared/remote-voice'

/**
 * The phone composer's microphone, rendered. What a DOM test can state that the pure module cannot:
 * that the button is there with the same states as the desktop's, that the phone's own recognizer is
 * used when the browser has one and its words land in the draft without being sent, that a browser
 * without one records and asks the host instead, and that a page a browser will not grant a
 * microphone to says why rather than failing on tap.
 */

class StubSocket {
  static instances: StubSocket[] = []
  static readonly OPEN = 1
  readyState = StubSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {
    StubSocket.instances.push(this)
  }
  send(raw: string): void {
    this.sent.push(raw)
  }
  close(): void {
    this.readyState = 3
  }
}

/** The Web Speech API as the component drives it, with the results delivered by the test. */
class StubRecognition {
  static instances: StubRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  started = false
  aborted = false
  onresult: ((event: { results: { isFinal: boolean; length: number; 0: { transcript: string } }[] }) => void) | null =
    null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  constructor() {
    StubRecognition.instances.push(this)
  }
  start(): void {
    this.started = true
  }
  stop(): void {
    this.onend?.()
  }
  abort(): void {
    this.aborted = true
    this.onend?.()
  }
  hear(...parts: { text: string; final: boolean }[]): void {
    this.onresult?.({
      results: parts.map((part) => ({ isFinal: part.final, length: 1, 0: { transcript: part.text } }))
    })
  }
}

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'https://work-pc.ts.net', token: 'token' }

const SUMMARY: RemoteChatSummary = {
  id: 'chat-1',
  kind: 'claude',
  title: 'Fix the parser',
  projectId: 'toucan',
  status: 'idle',
  unread: 0
}

function snapshot(): RemoteChatServerMessage {
  return { type: 'snapshot', state: foldAgentEvent(initialAgentTranscriptState(), { type: 'ready' }, 1) }
}

function open(): void {
  render(
    <ChatScreen
      host={HOST}
      chatId="chat-1"
      summary={SUMMARY}
      rateLimits={{}}
      onBack={() => {}}
      onUnauthorized={() => {}}
    />
  )
  const socket = StubSocket.instances[0]
  act(() => {
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify(snapshot()) })
  })
}

const globalWindow = window as unknown as Record<string, unknown>

beforeEach(() => {
  StubSocket.instances = []
  StubRecognition.instances = []
  // jsdom has no layout, so the transcript's tail-following call has nothing to do here.
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  // Only the host-transcription tests replace this; the socket never drops here.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no host in this test')))
  window.localStorage.clear()
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn() },
    configurable: true
  })
  Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true })
})

afterEach(() => {
  delete globalWindow.SpeechRecognition
  delete globalWindow.webkitSpeechRecognition
  vi.unstubAllGlobals()
})

describe('mobile dictation with the phone recognizer', () => {
  beforeEach(() => {
    globalWindow.webkitSpeechRecognition = StubRecognition
  })

  test('dictating appends what was heard to the draft in the phone language and does not send', async () => {
    open()
    const button = screen.getByRole('button', { name: 'Dictate' })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeInTheDocument())
    const recognition = StubRecognition.instances[0]
    expect(recognition.started).toBe(true)
    expect(recognition.lang).toBe('de-DE')
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)

    act(() => recognition.hear({ text: 'Bitte den Parser', final: true }, { text: 'reparieren', final: false }))
    // The connection banner is a status region too (#231), so the voice line is picked by class.
    const voiceStatus = screen.getAllByRole('status').find((element) => element.classList.contains('voice-status'))
    expect(voiceStatus).toHaveTextContent('Bitte den Parser reparieren')

    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument())
    expect(screen.getByLabelText('Message')).toHaveValue('Bitte den Parser reparieren')
    // Nothing went on the wire: a transcript is a draft.
    expect(StubSocket.instances[0].sent).toEqual([])
  })

  test('a recognizer that ends on its own still delivers what it heard, after existing text', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Please' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    await waitFor(() => expect(StubRecognition.instances).toHaveLength(1))
    const recognition = StubRecognition.instances[0]
    act(() => recognition.hear({ text: 'fix the parser', final: true }))
    act(() => recognition.onend?.())
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('Please fix the parser'))
  })

  test('discarding aborts the recognizer and leaves the draft alone', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    await waitFor(() => expect(StubRecognition.instances).toHaveLength(1))
    const recognition = StubRecognition.instances[0]
    act(() => recognition.hear({ text: 'never mind', final: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard this dictation' }))
    expect(recognition.aborted).toBe(true)
    expect(screen.getByLabelText('Message')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument()
  })

  test('a denied microphone is reported in words, in the error state', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    await waitFor(() => expect(StubRecognition.instances).toHaveLength(1))
    act(() => StubRecognition.instances[0].onerror?.({ error: 'not-allowed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone access was denied')
    const button = screen.getByRole('button', { name: 'Dictate' })
    expect(button).toHaveAttribute('data-state', 'error')
  })
})

describe('mobile dictation without a recognizer', () => {
  /** Enough of WebAudio for the recorder: the processor's callback is what the test feeds. */
  function stubWebAudio(): { emit(samples: number[]): void } {
    let processor: { onaudioprocess: ((event: unknown) => void) | null } | null = null
    const tracks = [{ stop: vi.fn() }]
    ;(navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue({
      getTracks: () => tracks
    })
    class StubAudioContext {
      sampleRate = 32_000
      createMediaStreamSource(): { connect(): void; disconnect(): void } {
        return { connect: vi.fn(), disconnect: vi.fn() }
      }
      createScriptProcessor(): { connect(): void; disconnect(): void; onaudioprocess: null } {
        const node = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }
        processor = node
        return node
      }
      destination = {}
      close = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('AudioContext', StubAudioContext)
    return {
      emit: (samples) =>
        processor?.onaudioprocess?.({
          inputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(samples) }
        })
    }
  }

  test('records, sends 16 kHz PCM to the host, and puts the host transcript in the draft', async () => {
    const audio = stubWebAudio()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: 'fix the parser' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    open()

    const button = screen.getByRole('button', { name: 'Dictate (transcribed on the desktop)' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeInTheDocument())
    act(() => audio.emit(Array.from({ length: 3200 }, () => 0.5)))

    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('fix the parser'))

    const transcribeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/transcribe'))
    expect(transcribeCall).toBeDefined()
    const [url, init] = transcribeCall as [string, RequestInit]
    expect(url).toBe('https://work-pc.ts.net/api/transcribe')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe(REMOTE_VOICE_CONTENT_TYPE)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token')
    // 3200 samples at 32 kHz become 1600 at 16 kHz: 3200 bytes of 16-bit PCM.
    expect((init.body as Uint8Array).byteLength).toBe(3200)
  })

  test("the host's refusal is shown in its own words", async () => {
    stubWebAudio()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'The desktop has no prepared speech model.' }), { status: 503 })
        )
    )
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Dictate (transcribed on the desktop)' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The desktop has no prepared speech model.')
    )
  })
})

describe('mobile dictation on a page without a microphone', () => {
  test('over plain HTTP the button is off and says what to change', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    globalWindow.webkitSpeechRecognition = StubRecognition
    open()
    const button = screen.getByRole('button', { name: /HTTPS/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleName(/tailscale serve/)
  })
})
