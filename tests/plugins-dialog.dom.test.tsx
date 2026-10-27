import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginsDialog } from '../src/renderer/src/PluginsDialog'
import type { PluginContributions, PluginsApi, PluginSummary } from '../src/shared/plugins'

// The plugins dialog (#56): add a folder (valid and invalid), enable and disable per project behind
// the contributions review, and the contributions view with its Claude-only marks.

const PROJECT = { name: 'game', path: 'D:\\game' }

const GODOT: PluginContributions = {
  id: 'godot-runtime',
  root: 'D:\\plugins\\godot-runtime',
  manifest: { name: 'godot-runtime', version: '1.2.0', description: 'Runs a scene headless' },
  skills: [
    { name: 'godot-runtime:run-scene', description: 'Run a scene and read its errors', path: 'skills/run/SKILL.md' }
  ],
  scripts: ['scripts/run-scene.mjs'],
  mcpServers: [
    {
      name: 'screens',
      transport: 'stdio',
      command: 'node',
      args: ['D:\\plugins\\godot-runtime\\mcp.mjs'],
      env: {},
      providers: ['claude', 'codex']
    },
    { name: 'live', transport: 'sse', url: 'https://example.test/sse', headers: {}, providers: ['claude'] }
  ],
  hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command', command: 'node guard.mjs', providers: ['claude'] }],
  problems: []
}

interface Harness {
  list: ReturnType<typeof vi.fn>
  enable: ReturnType<typeof vi.fn>
  disable: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
  contributions: ReturnType<typeof vi.fn>
}

function mockApi(options: { plugins?: PluginSummary[]; picked?: string | null; addError?: string } = {}): Harness {
  let plugins = options.plugins ?? []
  const enabled = new Set<string>(plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id))
  const list = vi.fn(async () => plugins.map((plugin) => ({ ...plugin, enabled: enabled.has(plugin.id) })))
  const add = vi.fn(async (path: string) => {
    if (options.addError) return { ok: false as const, error: options.addError }
    const plugin: PluginSummary = {
      id: 'godot-runtime',
      root: path,
      manifest: { name: 'godot-runtime', version: '1.2.0' }
    }
    plugins = [...plugins, plugin]
    return { ok: true as const, plugin }
  })
  const enable = vi.fn(async (_project: string, id: string) => {
    enabled.add(id)
    return { ok: true as const }
  })
  const disable = vi.fn(async (_project: string, id: string) => {
    enabled.delete(id)
    return { ok: true as const }
  })
  const contributions = vi.fn(async () => ({ ok: true as const, contributions: GODOT }))
  const api: PluginsApi = {
    list,
    pickFolder: async () => (options.picked === undefined ? 'D:\\plugins\\godot-runtime' : options.picked),
    add,
    remove: async () => ({ ok: true }),
    enable,
    disable,
    contributions
  }
  window.pluginsApi = api
  return { list, enable, disable, add, contributions }
}

const registered: PluginSummary = {
  id: 'godot-runtime',
  root: 'D:\\plugins\\godot-runtime',
  manifest: { name: 'godot-runtime', version: '1.2.0', description: 'Runs a scene headless' }
}

afterEach(() => Reflect.deleteProperty(window, 'pluginsApi'))

describe('PluginsDialog', () => {
  it('says changes apply to sessions created afterwards', async () => {
    mockApi()
    render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
    expect(await screen.findByText('No plugins added yet.')).toBeInTheDocument()
    expect(screen.getByText(/apply to sessions created afterwards/i)).toBeInTheDocument()
  })

  describe('adding a folder', () => {
    it('registers a valid folder and lists the plugin', async () => {
      const { add } = mockApi()
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      await screen.findByText('No plugins added yet.')
      fireEvent.click(screen.getByRole('button', { name: 'Add plugin folder…' }))
      expect(await screen.findByText('1.2.0')).toBeInTheDocument()
      expect(add).toHaveBeenCalledWith('D:\\plugins\\godot-runtime')
      expect(screen.getByRole('status')).toHaveTextContent('Added “godot-runtime”')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows the manifest error for an invalid folder and lists nothing', async () => {
      mockApi({ addError: 'plugin.json needs a "version" that is a semantic version, like "1.0.0".' })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      await screen.findByText('No plugins added yet.')
      fireEvent.click(screen.getByRole('button', { name: 'Add plugin folder…' }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Not added:')
      expect(alert).toHaveTextContent('needs a "version"')
      expect(screen.getByText('No plugins added yet.')).toBeInTheDocument()
    })

    it('does nothing when the folder picker is cancelled', async () => {
      const { add } = mockApi({ picked: null })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      await screen.findByText('No plugins added yet.')
      fireEvent.click(screen.getByRole('button', { name: 'Add plugin folder…' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add plugin folder…' })).toBeEnabled())
      expect(add).not.toHaveBeenCalled()
    })
  })

  describe('enabling per project', () => {
    it('shows the contributions first and enables for the project only on confirmation', async () => {
      const { enable } = mockApi({ plugins: [registered] })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Enable godot-runtime' }))
      expect(await screen.findByRole('region', { name: 'Contributions of godot-runtime' })).toBeInTheDocument()
      expect(screen.getByText(/run code with your rights in game/)).toBeInTheDocument()
      expect(enable).not.toHaveBeenCalled()
      fireEvent.click(await screen.findByRole('button', { name: 'Enable for game' }))
      await waitFor(() => expect(enable).toHaveBeenCalledWith('D:\\game', 'godot-runtime'))
      expect(await screen.findByText('Enabled for game')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Disable godot-runtime' })).toBeInTheDocument()
    })

    it('leaves the plugin disabled when the review is cancelled', async () => {
      const { enable } = mockApi({ plugins: [registered] })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Enable godot-runtime' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('region')).not.toBeInTheDocument()
      expect(enable).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Enable godot-runtime' })).toBeInTheDocument()
    })

    it('disables an enabled plugin for the project directly', async () => {
      const { disable } = mockApi({ plugins: [{ ...registered, enabled: true }] })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      expect(await screen.findByText('Enabled for game')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Disable godot-runtime' }))
      await waitFor(() => expect(disable).toHaveBeenCalledWith('D:\\game', 'godot-runtime'))
      expect(await screen.findByRole('button', { name: 'Enable godot-runtime' })).toBeInTheDocument()
      expect(screen.queryByText('Enabled for game')).not.toBeInTheDocument()
    })

    it('asks the registry about the active project and offers no enabling without one', async () => {
      const { list } = mockApi({ plugins: [registered] })
      const { rerender } = render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      await screen.findByRole('button', { name: 'Enable godot-runtime' })
      expect(list.mock.calls[0]).toEqual(['D:\\game'])
      rerender(<PluginsDialog onClose={vi.fn()} />)
      expect(await screen.findByText(/Open a project to enable plugins/)).toBeInTheDocument()
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Enable godot-runtime' })).not.toBeInTheDocument()
      )
      expect(screen.getByRole('button', { name: 'Inspect godot-runtime' })).toBeInTheDocument()
    })

    it('refuses to enable a plugin whose folder no longer validates, but still lets it be disabled', async () => {
      mockApi({
        plugins: [
          { id: 'broken', root: 'D:\\plugins\\broken', problem: 'Its folder is gone.' },
          { id: 'stale', root: 'D:\\plugins\\stale', problem: 'Its manifest is invalid.', enabled: true }
        ]
      })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      expect(await screen.findByText('Its folder is gone.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Enable broken' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Disable stale' })).toBeEnabled()
    })
  })

  describe('contributions view', () => {
    it('lists skills, scripts, MCP servers and hooks, marking what only Claude gets', async () => {
      mockApi({ plugins: [registered] })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Inspect godot-runtime' }))
      const view = await screen.findByRole('region', { name: 'Contributions of godot-runtime' })
      expect(within(view).getByText('godot-runtime:run-scene')).toBeInTheDocument()
      expect(within(view).getByText('scripts/run-scene.mjs')).toBeInTheDocument()
      expect(within(view).getByText('node D:\\plugins\\godot-runtime\\mcp.mjs')).toBeInTheDocument()
      expect(within(view).getByText('node guard.mjs')).toBeInTheDocument()
      // The hook and the SSE server reach Claude only; the stdio server reaches both.
      expect(within(view).getAllByText('Claude only')).toHaveLength(2)
      const hook = within(view).getByText('PreToolUse').closest('li')!
      expect(within(hook).getByText('Claude only')).toBeInTheDocument()
      const stdio = within(view).getByText('screens').closest('li')!
      expect(within(stdio).queryByText('Claude only')).not.toBeInTheDocument()
      // Inspecting is read-only: nothing is enabled and there is no confirm button.
      expect(screen.queryByRole('button', { name: /^Enable for/ })).not.toBeInTheDocument()
    })

    it('reports parts that could not be read instead of showing them as absent', async () => {
      const { contributions } = mockApi({ plugins: [registered] })
      contributions.mockResolvedValue({
        ok: true,
        contributions: { ...GODOT, hooks: [], problems: ['A "Stop" hook names no type.'] }
      })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Inspect godot-runtime' }))
      expect(await screen.findByText('A "Stop" hook names no type.')).toBeInTheDocument()
      expect(screen.getByText('None.')).toBeInTheDocument()
    })

    it('shows why the contributions could not be read, and will not enable from there', async () => {
      const { contributions } = mockApi({ plugins: [registered] })
      contributions.mockResolvedValue({ ok: false, error: 'The plugin folder is gone.' })
      render(<PluginsDialog project={PROJECT} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Enable godot-runtime' }))
      expect(await screen.findByText('The plugin folder is gone.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Enable for game' })).toBeDisabled()
    })
  })
})
