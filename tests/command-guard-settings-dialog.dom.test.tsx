import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandGuardSettingsDialog } from '../src/renderer/src/CommandGuardSettingsDialog'
import type {
  CommandGuardPreferences,
  CommandGuardSaveRequest,
  CommandGuardSaveResult,
  CommandGuardSettingsApi
} from '../src/shared/command-guard-settings'

// The command guard settings dialog (ticket 03): the switch, the pattern list, line-level errors on
// save, Reset to defaults, and wording that says "from now on" and "requested".

const DEFAULTS = '# default\nrm[[:space:]]+-rf\ngit[[:space:]]+push'

function mockApi(initial: CommandGuardPreferences = { enabled: true, patterns: null }) {
  let preferences = initial
  const save = vi.fn(async (request: CommandGuardSaveRequest): Promise<CommandGuardSaveResult> => {
    const bad = request.patterns
      .split('\n')
      .flatMap((line, index) => (line.includes('(') ? [{ line: index + 1, message: 'Unterminated group' }] : []))
    if (bad.length > 0) return { ok: false, errors: bad }
    preferences = { enabled: request.enabled, patterns: request.patterns === DEFAULTS ? null : request.patterns }
    return { ok: true, state: { preferences, defaults: DEFAULTS } }
  })
  const api: CommandGuardSettingsApi = { state: async () => ({ preferences, defaults: DEFAULTS }), save }
  window.commandGuardSettingsApi = api
  return { save }
}

afterEach(() => Reflect.deleteProperty(window, 'commandGuardSettingsApi'))

const patternsBox = async (): Promise<HTMLTextAreaElement> =>
  (await screen.findByLabelText('Patterns')) as HTMLTextAreaElement

describe('CommandGuardSettingsDialog', () => {
  it('shows the built-in list while the user has not edited it, and states when changes apply', async () => {
    mockApi()
    render(<CommandGuardSettingsDialog onClose={vi.fn()} />)
    expect((await patternsBox()).value).toBe(DEFAULTS)
    expect(screen.getByText(/sessions started from now on/i)).toBeInTheDocument()
    expect(screen.getByText(/requested for each new Claude session, not confirmed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves the switch and an edited list', async () => {
    const { save } = mockApi()
    render(<CommandGuardSettingsDialog onClose={vi.fn()} />)
    const box = await patternsBox()
    fireEvent.change(box, { target: { value: `${DEFAULTS}\nterraform[[:space:]]+destroy` } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ enabled: false, patterns: `${DEFAULTS}\nterraform[[:space:]]+destroy` })
    )
    expect(await screen.findByText(/Saved\. It applies to sessions started from now on/)).toBeInTheDocument()
    expect(screen.getByText(/no guard hook at all/)).toBeInTheDocument()
  })

  it('tells the app what was stored, so the composer menus follow the global switch', async () => {
    mockApi()
    const onSaved = vi.fn()
    render(<CommandGuardSettingsDialog onClose={vi.fn()} onSaved={onSaved} />)
    await patternsBox()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ enabled: false, patterns: null }))
  })

  it('reports an invalid regex with its line and does not claim it saved', async () => {
    mockApi()
    render(<CommandGuardSettingsDialog onClose={vi.fn()} />)
    fireEvent.change(await patternsBox(), { target: { value: 'fine\n(broken' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Not saved')
    expect(alert).toHaveTextContent('Line 2: Unterminated group')
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('Reset to defaults puts the built-in list back, to be saved', async () => {
    const { save } = mockApi({ enabled: true, patterns: 'only this' })
    render(<CommandGuardSettingsDialog onClose={vi.fn()} />)
    const box = await patternsBox()
    await waitFor(() => expect(box.value).toBe('only this'))
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    expect(box.value).toBe(DEFAULTS)
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true, patterns: DEFAULTS }))
  })

  it('shows a saved custom list and the switch state on open', async () => {
    mockApi({ enabled: false, patterns: 'only this' })
    render(<CommandGuardSettingsDialog onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
    expect((await patternsBox()).value).toBe('only this')
  })
})
