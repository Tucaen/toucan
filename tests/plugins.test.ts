import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { pluginInstruction, pluginMcpServers, validatePluginManifest } from '../src/shared/plugins'

// Issue #55: a plugin is a folder in Claude's plugin layout, identified by its manifest's `name`
// and semver `version` (docs/plans/plugins.md, decision 4).

test('a manifest with a kebab-case name and a semver version is a plugin', () => {
  assert.deepEqual(validatePluginManifest({ name: 'godot-runtime', version: '1.2.0-beta.1+build.5' }), {
    ok: true,
    manifest: { name: 'godot-runtime', version: '1.2.0-beta.1+build.5' }
  })
  assert.deepEqual(
    validatePluginManifest({ name: 'browser', version: '0.1.0', description: 'Drives a browser.', author: {} }),
    { ok: true, manifest: { name: 'browser', version: '0.1.0', description: 'Drives a browser.' } }
  )
})

test('a manifest without a usable name or semver version is refused with the reason', () => {
  const refused = (value: unknown): string => {
    const verdict = validatePluginManifest(value)
    assert.equal(verdict.ok, false)
    return verdict.ok ? '' : verdict.error
  }
  assert.match(refused(null), /object/)
  assert.match(refused([]), /object/)
  assert.match(refused({ version: '1.0.0' }), /"name"/)
  assert.match(refused({ name: 'Godot Runtime', version: '1.0.0' }), /"name"/)
  assert.match(refused({ name: '../escape', version: '1.0.0' }), /"name"/)
  assert.match(refused({ name: 'godot-', version: '1.0.0' }), /"name"/)
  assert.match(refused({ name: 'godot' }), /"version"/)
  assert.match(refused({ name: 'godot', version: '1.0' }), /"version"/)
  assert.match(refused({ name: 'godot', version: '01.0.0' }), /"version"/)
  assert.match(refused({ name: 'godot', version: 1 }), /"version"/)
})

test("a plugin's MCP configuration is read as Claude reads it, with the plugin root filled in", () => {
  const root = 'D:\\plugins\\godot-runtime'
  assert.deepEqual(
    pluginMcpServers(
      {
        mcpServers: {
          runtime: {
            command: '${CLAUDE_PLUGIN_ROOT}/bin/server.exe',
            args: ['--project', '${CLAUDE_PLUGIN_ROOT}/fixtures'],
            env: { GODOT_DATA: '${CLAUDE_PLUGIN_ROOT}/data' }
          },
          docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer token' } },
          events: { type: 'sse', url: 'https://events.example/sse' },
          broken: { args: ['--help'] },
          socket: { type: 'ws', url: 'ws://localhost:9000' }
        }
      },
      root
    ),
    {
      servers: [
        {
          name: 'runtime',
          transport: 'stdio',
          command: 'D:\\plugins\\godot-runtime/bin/server.exe',
          args: ['--project', 'D:\\plugins\\godot-runtime/fixtures'],
          env: { GODOT_DATA: 'D:\\plugins\\godot-runtime/data' }
        },
        {
          name: 'docs',
          transport: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer token' }
        },
        { name: 'events', transport: 'sse', url: 'https://events.example/sse', headers: {} }
      ],
      problems: [
        'MCP server "broken" names neither a command nor a URL.',
        'MCP server "socket" uses the "ws" transport, which Toucan cannot read.'
      ]
    }
  )
  // The bare map, as `plugin.json` may carry it inline.
  assert.deepEqual(pluginMcpServers({ tools: { command: 'node' } }, root).servers, [
    { name: 'tools', transport: 'stdio', command: 'node', args: [], env: {} }
  ])
  assert.deepEqual(pluginMcpServers('nope', root), {
    servers: [],
    problems: ['The MCP configuration must hold a JSON object.']
  })
})

test('a session with plugins is told each plugin id and absolute root, one line per plugin', () => {
  const instruction = pluginInstruction([
    { id: 'godot-runtime', root: 'D:\\plugins\\godot-runtime' },
    { id: 'browser', root: 'C:\\Users\\Ada\\browser-plugin' }
  ])
  const lines = instruction?.split('\n') ?? []
  assert.equal(lines.length, 2)
  assert.ok(lines[0]?.includes('"godot-runtime"') && lines[0].includes('D:\\plugins\\godot-runtime'))
  assert.ok(lines[1]?.includes('"browser"') && lines[1].includes('C:\\Users\\Ada\\browser-plugin'))
  assert.equal(pluginInstruction([]), undefined)
})
