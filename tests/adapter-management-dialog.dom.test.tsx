import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AdapterSnapshot } from '../src/shared/adapter-management'
import { AdapterManagementDialog } from '../src/renderer/src/AdapterManagementDialog'
import type { AgentProvider } from '../src/shared/agent-provider'

describe('adapter management', () => {
  it('checks published versions, explicitly selects one, and offers the bundled fallback', async () => {
    const state: AdapterSnapshot = {
      claude: { bundledVersion: '0.73.0', selectedVersion: null, installedVersions: [], phase: 'idle' },
      codex: { bundledVersion: '1.8.0', selectedVersion: null, installedVersions: [], phase: 'idle' }
    }
    const select = vi.fn(async (provider: AgentProvider, version: string | null) => {
      state[provider].selectedVersion = version
      return structuredClone(state)
    })
    window.adapterManagementApi = {
      state: async () => structuredClone(state),
      check: async (provider) => {
        state[provider].catalog = { versions: ['1.9.0-beta.1', '1.9.0'], latest: '1.9.0' }
        return structuredClone(state)
      },
      select,
      onChange: () => () => {}
    }
    render(<AdapterManagementDialog onClose={() => {}} />)
    const codex = within(await screen.findByRole('group', { name: 'Codex' }))
    expect(codex.getByText('Bundled with Toucan: 1.8.0')).toBeVisible()
    fireEvent.click(codex.getByRole('button', { name: 'Check for updates' }))
    await codex.findByRole('option', { name: '1.9.0-beta.1 (prerelease)' })
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(codex.getByRole('button', { name: 'Install and use' }))
    await waitFor(() => expect(select).toHaveBeenCalledWith('codex', '1.9.0'))
    fireEvent.click(codex.getByRole('button', { name: 'Use bundled' }))
    await waitFor(() => expect(select).toHaveBeenCalledWith('codex', null))
    expect(screen.getByText(/Running conversations keep their current adapter/)).toBeVisible()
  })
})
