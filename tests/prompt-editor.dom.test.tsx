import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FormEvent } from 'react'
import { describe, expect, test, vi } from 'vitest'
import PromptTextarea from '../src/renderer/src/PromptTextarea'
import {
  activePicker,
  completionMemoryForToken,
  usePromptEditor,
  type PromptEditor as PromptEditorHandle,
  type PromptEditorOptions
} from '../src/renderer/src/use-prompt-editor'
import type { AgentCommand } from '../src/shared/agent'
import type { WorkspaceFileIndex } from '../src/shared/workspace-files'

// The prompt editor as one module: the hook owns the state and the rules that connect its pure
// seams (slash completion, @-mentions, history, keys, caret), and the view is the textarea it
// drives. The composer suites cover the wired-up chat view; this file pins the cross-module rules
// that used to live as comments in the composer's wiring.

const commands: AgentCommand[] = [
  { name: 'review', description: 'Review the pending changes' },
  { name: 'commit', description: 'Commit staged work', input: { hint: '[message]' } },
  { name: 'compact', description: 'Compact the conversation' }
]

const ROOT = 'D:\\Development\\ADE'

const index: WorkspaceFileIndex = {
  root: ROOT,
  entries: [
    { path: 'README.md', directory: false },
    { path: 'src', directory: true },
    { path: 'src/main/index.ts', directory: false }
  ],
  truncated: false,
  gitignored: true
}

/** A submit that behaves like the real one: it reports the prompt and runs the clear callback. */
function acceptingSubmit(): ReturnType<typeof vi.fn> & PromptEditorOptions['submit'] {
  return vi.fn((event: FormEvent, _prompt: string, onPrepared: () => void) => {
    event.preventDefault()
    onPrepared()
  })
}

function Harness(
  props: Partial<PromptEditorOptions> & { handle?: { current: PromptEditorHandle | null } }
): JSX.Element {
  const { handle, ...overrides } = props
  const editor = usePromptEditor({
    draft: '',
    commands,
    sentPrompts: [],
    sendKey: 'enter',
    disabled: false,
    submit: acceptingSubmit(),
    ...overrides
  })
  if (handle) handle.current = editor
  return (
    <form onSubmit={editor.submit}>
      <PromptTextarea editor={editor} placeholder="Prompt" />
    </form>
  )
}

function renderEditor(overrides: Partial<PromptEditorOptions> = {}): {
  textarea: HTMLTextAreaElement
  handle: { current: PromptEditorHandle | null }
} {
  const handle = { current: null as PromptEditorHandle | null }
  render(<Harness {...overrides} handle={handle} />)
  return { textarea: screen.getByPlaceholderText('Prompt') as HTMLTextAreaElement, handle }
}

/** Types `value` with the caret parked at its end, as real typing leaves it. */
function type(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, { target: { value } })
  textarea.setSelectionRange(value.length, value.length)
  fireEvent.select(textarea)
}

const slashMenu = (): HTMLElement | null => screen.queryByRole('listbox', { name: 'Slash commands' })
const mentionMenu = (): HTMLElement | null => screen.queryByRole('listbox', { name: 'Workspace files' })

describe('picker arbitration', () => {
  const closed = { open: false, token: null }
  const openAt = (start: number) => ({ open: true, token: { query: '', start } })

  test('neither picker is active while both are closed', () => {
    expect(activePicker(closed, closed)).toBeNull()
  })

  test('the only open picker takes the menu', () => {
    expect(activePicker(openAt(0), closed)).toBe('slash')
    expect(activePicker(closed, openAt(0))).toBe('mention')
  })

  test('when both offer, the token starting closer to the caret is the one being typed', () => {
    expect(activePicker(openAt(0), openAt(3))).toBe('mention')
    expect(activePicker(openAt(3), openAt(0))).toBe('slash')
  })

  test('the rendered editor opens one menu per sigil and never both', async () => {
    const read = vi.fn(async () => index)
    const { textarea } = renderEditor({ fileMentions: { root: ROOT, recent: [], read } })
    type(textarea, '/rev')
    expect(slashMenu()).not.toBeNull()
    expect(mentionMenu()).toBeNull()
    type(textarea, '@READ')
    await waitFor(() => expect(mentionMenu()).not.toBeNull())
    expect(slashMenu()).toBeNull()
  })
})

describe('token memory', () => {
  const memory = { dismissedStart: 0, acceptedQuery: 'review', highlight: 2 }
  const empty = { dismissedStart: null, acceptedQuery: null, highlight: 0 }
  const resetHighlight = (state: typeof memory): typeof memory => ({ ...state, highlight: 0 })

  test('is forgotten entirely once the draft stops offering the token', () => {
    expect(completionMemoryForToken(null, memory, empty, resetHighlight)).toBe(empty)
  })

  test('keeps what was dismissed or accepted while a token is offered, with the highlight back on top', () => {
    expect(completionMemoryForToken({ query: 'rev', start: 0 }, memory, empty, resetHighlight)).toEqual({
      ...memory,
      highlight: 0
    })
  })

  test('a dismissed token typed again in the same place is offered again', () => {
    const { textarea } = renderEditor()
    type(textarea, '/rev')
    expect(slashMenu()).not.toBeNull()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(slashMenu()).toBeNull()
    // The token goes away, and its dismissal with it.
    type(textarea, 'x')
    type(textarea, '/rev')
    expect(slashMenu()).not.toBeNull()
  })

  test('the highlight returns to the top whenever the token itself changes', () => {
    const { textarea } = renderEditor()
    type(textarea, '/co')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.getAttribute('aria-activedescendant')).toMatch(/-1$/)
    type(textarea, '/com')
    expect(textarea.getAttribute('aria-activedescendant')).toMatch(/-0$/)
  })
})

describe('caret restore', () => {
  test('accepting a completion parks the caret where the acceptance said, in a focused textarea', () => {
    const { textarea } = renderEditor()
    type(textarea, 'run /com')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('run /commit ')
    expect(textarea.selectionStart).toBe('run /commit '.length)
    expect(document.activeElement).toBe(textarea)
    // The completion's own view sees the restored caret: a token no longer under it means no menu.
    expect(slashMenu()).toBeNull()
  })

  test('the caret is restored once per acceptance, not on every later edit', () => {
    const { textarea } = renderEditor()
    type(textarea, '/rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.selectionStart).toBe('/review'.length)
    fireEvent.change(textarea, { target: { value: 'x/review' } })
    textarea.setSelectionRange(1, 1)
    fireEvent.select(textarea)
    expect(textarea.selectionStart).toBe(1)
  })
})

describe('hoist memory', () => {
  test('a command taken from the menu is hoisted on send even after the caret has left its token', () => {
    const submit = acceptingSubmit()
    const { textarea } = renderEditor({ submit })
    type(textarea, 'please /rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('please /review')
    type(textarea, 'please /review now')
    expect(slashMenu()).toBeNull()
    fireEvent.submit(textarea.closest('form')!)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][1]).toBe('/review now\nplease')
    expect(textarea.value).toBe('')
  })

  test('the acceptance is spent with the draft it belonged to', () => {
    const submit = acceptingSubmit()
    const { textarea } = renderEditor({ submit })
    type(textarea, '/rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.submit(textarea.closest('form')!)
    expect(submit.mock.calls[0][1]).toBe('/review')
    // A merely mentioned command in the next prompt is prose and stays put.
    type(textarea, 'what does /review do?')
    fireEvent.submit(textarea.closest('form')!)
    expect(submit.mock.calls[1][1]).toBe('what does /review do?')
  })

  test('a command typed out by hand is never hoisted', () => {
    const submit = acceptingSubmit()
    const { textarea } = renderEditor({ submit })
    type(textarea, 'see /review')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.submit(textarea.closest('form')!)
    expect(submit.mock.calls[0][1]).toBe('see /review')
  })
})

describe('editor handle', () => {
  test('reports whether there is anything to send and lets a dictation control replace the draft', () => {
    const { textarea, handle } = renderEditor()
    expect(handle.current?.blank).toBe(true)
    type(textarea, '  ')
    expect(handle.current?.blank).toBe(true)
    type(textarea, 'hello')
    expect(handle.current?.blank).toBe(false)
    expect(handle.current?.textareaRef.current).toBe(textarea)
  })
})
