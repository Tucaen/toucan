import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createPluginRegistry } from '../src/main/plugin-registry'

// Issue #55: the per-user registry at `<userData>/plugins.json` maps a plugin id to the folder it
// lives in on this machine, and a project to the ids enabled for it.

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `toucan-plugins-${prefix}-`))
}

/** A plugin folder in Claude's layout, with whatever manifest the test gives it. */
function pluginFolder(manifest: unknown, files: Record<string, string> = {}): string {
  const root = scratch('plugin')
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(join(root, relative, '..'), { recursive: true })
    writeFileSync(join(root, relative), contents)
  }
  return root
}

test('adding a folder registers the id its manifest names; the same id from another folder is refused', async () => {
  const userDataPath = scratch('user-data')
  const registry = createPluginRegistry({ userDataPath })
  const first = pluginFolder({ name: 'godot-runtime', version: '1.0.0' })
  const elsewhere = pluginFolder({ name: 'godot-runtime', version: '2.0.0' })

  const added = await registry.add(first)
  assert.deepEqual(added, {
    ok: true,
    plugin: { id: 'godot-runtime', path: first, manifest: { name: 'godot-runtime', version: '1.0.0' } }
  })
  // Adding the very folder again is not a conflict: it is already what the registry says.
  assert.equal((await registry.add(first)).ok, true)

  const refused = await registry.add(elsewhere)
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok && refused.error.includes('already registered') && refused.error.includes(first))

  assert.deepEqual(JSON.parse(readFileSync(join(userDataPath, 'plugins.json'), 'utf8')), {
    plugins: { 'godot-runtime': { path: first } },
    projects: {}
  })
})

test('a folder without a valid manifest is refused and nothing is registered', async () => {
  const userDataPath = scratch('user-data')
  const registry = createPluginRegistry({ userDataPath })
  const noManifest = scratch('not-a-plugin')
  const brokenJson = pluginFolder({})
  writeFileSync(join(brokenJson, '.claude-plugin', 'plugin.json'), '{ not json')
  const noVersion = pluginFolder({ name: 'browser' })

  for (const path of [noManifest, brokenJson, noVersion, 'relative\\folder']) {
    const result = await registry.add(path)
    assert.equal(result.ok, false, path)
  }
  const missing = await registry.add(noManifest)
  assert.ok(!missing.ok && missing.error.includes(join(noManifest, '.claude-plugin', 'plugin.json')))
  const unversioned = await registry.add(noVersion)
  assert.ok(!unversioned.ok && unversioned.error.includes('"version"'))
  assert.deepEqual(await registry.list(), [])
})

test("a session gets its project's plugins; a missing or broken one is skipped with a notice", async () => {
  const registry = createPluginRegistry({ userDataPath: scratch('user-data') })
  const project = scratch('project')
  const kept = pluginFolder({ name: 'godot-runtime', version: '1.0.0' })
  const moved = pluginFolder({ name: 'browser', version: '1.0.0' })
  const broken = pluginFolder({ name: 'lint-rules', version: '1.0.0' })
  const renamed = pluginFolder({ name: 'old-name', version: '1.0.0' })
  const elsewhere = pluginFolder({ name: 'other-project', version: '1.0.0' })
  for (const folder of [kept, moved, broken, renamed, elsewhere]) assert.equal((await registry.add(folder)).ok, true)
  for (const id of ['godot-runtime', 'browser', 'lint-rules', 'old-name'])
    assert.deepEqual(await registry.enable(project, id), { ok: true })
  assert.deepEqual(await registry.enable(scratch('other-checkout'), 'other-project'), { ok: true })
  assert.equal((await registry.enable(project, 'never-added')).ok, false)

  renameSync(moved, `${moved}-gone`)
  writeFileSync(join(broken, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lint-rules', version: 'next' }))
  writeFileSync(join(renamed, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'new-name', version: '1.0.0' }))

  // The project is matched as a path, not as a string: separators may be spelled either way.
  const session = await registry.forSession({ provider: 'claude', projectPath: project.replace(/\\/g, '/') })
  assert.deepEqual(
    session.plugins.map((plugin) => ({ id: plugin.id, root: plugin.root })),
    [{ id: 'godot-runtime', root: kept }]
  )
  assert.equal(session.notices.length, 3)
  assert.ok(session.notices[0]?.includes('"browser"') && session.notices[0].includes('missing'))
  assert.ok(session.notices[1]?.includes('"lint-rules"') && session.notices[1].includes('"version"'))
  assert.ok(session.notices[2]?.includes('"old-name"') && session.notices[2].includes('"new-name"'))

  assert.deepEqual(
    (await registry.list(project)).map((plugin) => [plugin.id, plugin.enabled, Boolean(plugin.problem)]),
    [
      ['godot-runtime', true, false],
      ['browser', true, true],
      ['lint-rules', true, true],
      ['old-name', true, true],
      ['other-project', false, false]
    ]
  )
})

test('a disabled or removed plugin leaves the project, and a project without plugins gets none', async () => {
  const registry = createPluginRegistry({ userDataPath: scratch('user-data') })
  const project = scratch('project')
  const godot = pluginFolder({ name: 'godot-runtime', version: '1.0.0' })
  const browser = pluginFolder({ name: 'browser', version: '1.0.0' })
  await registry.add(godot)
  await registry.add(browser)
  await registry.enable(project, 'godot-runtime')
  await registry.enable(project, 'browser')

  assert.deepEqual(await registry.disable(project, 'godot-runtime'), { ok: true })
  assert.deepEqual(
    (await registry.forSession({ provider: 'claude', projectPath: project })).plugins.map((p) => p.id),
    ['browser']
  )
  assert.deepEqual(await registry.remove('browser'), { ok: true })
  assert.deepEqual(await registry.forSession({ provider: 'claude', projectPath: project }), {
    plugins: [],
    notices: []
  })
  assert.deepEqual(
    (await registry.list()).map((plugin) => plugin.id),
    ['godot-runtime']
  )
  // A removed id leaves no enablement behind to resurrect it under a new folder.
  await registry.add(pluginFolder({ name: 'browser', version: '2.0.0' }))
  assert.deepEqual((await registry.forSession({ provider: 'claude', projectPath: project })).plugins, [])
})

const SKILL = '---\nname: run-scene\ndescription: Runs a scene headless.\n---\n\nRun `<root>/scripts/run.mjs`.\n'

test('a Codex session gets plugin skills through a Toucan-owned root and the MCP servers translated', async () => {
  const userDataPath = scratch('user-data')
  const registry = createPluginRegistry({ userDataPath })
  const project = scratch('project')
  const godot = pluginFolder(
    { name: 'godot-runtime', version: '1.0.0' },
    {
      'skills/run-scene/SKILL.md': SKILL,
      '.mcp.json': JSON.stringify({ mcpServers: { godot: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server' } } })
    }
  )
  const bare = pluginFolder({ name: 'browser', version: '1.0.0' })
  for (const folder of [godot, bare]) await registry.add(folder)
  for (const id of ['godot-runtime', 'browser']) await registry.enable(project, id)

  const session = await registry.forSession({ provider: 'codex', projectPath: project })
  assert.deepEqual(session.notices, [])
  const [withSkills, withoutSkills] = session.plugins
  const skillsRoot = join(userDataPath, 'codex-plugin-skills', 'godot-runtime')
  assert.deepEqual(withSkills?.codex, {
    skillsRoot,
    mcpServers: [{ name: 'godot', transport: 'stdio', command: `${godot}/bin/server`, args: [], env: {} }]
  })
  // codex-acp looks for skills in `<additional directory>/.agents/skills`, never in a plugin's own
  // `skills/`, so the Toucan-owned root must lead there.
  assert.equal(realpathSync(join(skillsRoot, '.agents', 'skills')), realpathSync(join(godot, 'skills')))
  assert.deepEqual(withoutSkills?.codex, { mcpServers: [] })

  // The same id from another folder later re-points the link instead of keeping the old one.
  const moved = pluginFolder({ name: 'godot-runtime', version: '1.1.0' }, { 'skills/run-scene/SKILL.md': SKILL })
  await registry.remove('godot-runtime')
  await registry.add(moved)
  await registry.enable(project, 'godot-runtime')
  await registry.forSession({ provider: 'codex', projectPath: project })
  assert.equal(realpathSync(join(skillsRoot, '.agents', 'skills')), realpathSync(join(moved, 'skills')))

  // Claude reads the folder itself, so a Claude session needs no translation and no link.
  const claude = await registry.forSession({ provider: 'claude', projectPath: project })
  assert.ok(claude.plugins.every((plugin) => plugin.codex === undefined))
})

test('a Codex translation problem costs that part of the plugin, never the plugin or the session', async () => {
  const userDataPath = scratch('user-data')
  const registry = createPluginRegistry({ userDataPath })
  const project = scratch('project')
  const godot = pluginFolder(
    { name: 'godot-runtime', version: '1.0.0' },
    {
      'skills/run-scene/SKILL.md': SKILL,
      '.mcp.json': JSON.stringify({
        mcpServers: { shared: { command: 'godot-mcp' }, events: { type: 'sse', url: 'http://127.0.0.1:1/sse' } }
      })
    }
  )
  const other = pluginFolder(
    { name: 'browser', version: '1.0.0' },
    { '.mcp.json': '{ broken', 'skills/browse/SKILL.md': SKILL }
  )
  const third = pluginFolder(
    { name: 'third', version: '1.0.0' },
    { '.mcp.json': JSON.stringify({ mcpServers: { shared: { command: 'third-mcp' } } }) }
  )
  for (const folder of [godot, other, third]) await registry.add(folder)
  for (const id of ['godot-runtime', 'browser', 'third']) await registry.enable(project, id)
  // Something that is not Toucan's link stands where the browser link would go: it is never replaced.
  mkdirSync(join(userDataPath, 'codex-plugin-skills', 'browser', '.agents', 'skills'), { recursive: true })

  const session = await registry.forSession({ provider: 'codex', projectPath: project })
  assert.deepEqual(
    session.plugins.map((plugin) => [
      plugin.id,
      plugin.codex?.mcpServers.map((server) => server.name),
      Boolean(plugin.codex?.skillsRoot)
    ]),
    [
      ['godot-runtime', ['shared'], true],
      ['browser', [], false],
      ['third', [], false]
    ]
  )
  assert.equal(session.notices.length, 4)
  assert.ok(session.notices[0]?.includes('"godot-runtime"') && session.notices[0].includes('"events"'))
  assert.ok(session.notices[1]?.includes('"browser"') && session.notices[1].includes('.mcp.json'))
  assert.ok(session.notices[2]?.includes('"browser"') && session.notices[2].includes('skills'))
  assert.ok(session.notices[3]?.includes('"third"') && session.notices[3].includes('"shared"'))
})

test("a plugin's contributions show what it would run, and mark what reaches Claude only", async () => {
  const registry = createPluginRegistry({ userDataPath: scratch('user-data') })
  const manifest = {
    name: 'godot-runtime',
    version: '1.0.0',
    description: 'Runs Godot scenes headless.',
    hooks: {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/stop.mjs' }] }] }
    }
  }
  const root = pluginFolder(manifest, {
    'skills/run-scene/SKILL.md': '---\nname: run-scene\ndescription: "Runs a scene headless."\n---\n\nBody.\n',
    'skills/run-scene/scripts/capture.mjs': '',
    'skills/notes.md': 'Not a skill: no folder, no SKILL.md.',
    'scripts/run.mjs': '',
    'scripts/lib/util.mjs': '',
    '.mcp.json': JSON.stringify({
      mcpServers: {
        godot: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: ['--headless'] },
        events: { type: 'sse', url: 'http://127.0.0.1:1/sse' }
      }
    }),
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Write|Edit', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh' }] }
        ]
      }
    })
  })
  await registry.add(root)

  assert.deepEqual(await registry.contributions('godot-runtime'), {
    ok: true,
    contributions: {
      id: 'godot-runtime',
      root,
      manifest: { name: 'godot-runtime', version: '1.0.0', description: 'Runs Godot scenes headless.' },
      skills: [
        {
          name: 'run-scene',
          description: 'Runs a scene headless.',
          path: join(root, 'skills', 'run-scene', 'SKILL.md')
        }
      ],
      scripts: ['scripts/lib/util.mjs', 'scripts/run.mjs', 'skills/run-scene/scripts/capture.mjs'],
      mcpServers: [
        {
          name: 'godot',
          transport: 'stdio',
          command: `${root}/bin/server`,
          args: ['--headless'],
          env: {},
          providers: ['claude', 'codex']
        },
        { name: 'events', transport: 'sse', url: 'http://127.0.0.1:1/sse', headers: {}, providers: ['claude'] }
      ],
      hooks: [
        {
          event: 'PostToolUse',
          matcher: 'Write|Edit',
          type: 'command',
          command: `${root}/scripts/format.sh`,
          providers: ['claude']
        },
        { event: 'Stop', type: 'command', command: `node ${root}/scripts/stop.mjs`, providers: ['claude'] }
      ],
      problems: []
    }
  })
  assert.deepEqual(await registry.contributions('never-added'), {
    ok: false,
    error: 'No plugin named "never-added" is registered.'
  })
})

test('contributions of a plugin with unreadable parts name the problem instead of looking smaller', async () => {
  const registry = createPluginRegistry({ userDataPath: scratch('user-data') })
  const root = pluginFolder({ name: 'browser', version: '1.0.0' }, { '.mcp.json': '{ broken' })
  await registry.add(root)
  const result = await registry.contributions('browser')
  assert.ok(result.ok)
  assert.deepEqual(result.contributions.mcpServers, [])
  assert.equal(result.contributions.problems.length, 1)
  assert.ok(result.contributions.problems[0]?.includes('.mcp.json'))
})
