import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { minimatch } from 'minimatch'
import { PROJECT_SKILLS_MANIFEST_SEGMENTS, projectSkillFileSegments } from '../src/shared/project-skills'

interface WindowsTarget {
  target: string
  arch: string[]
}

interface PackageManifest {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: {
    files?: string[]
    asarUnpack?: string[]
    win?: {
      target?: WindowsTarget[]
      artifactName?: string
    }
    portable?: { artifactName?: string }
    nsis?: {
      oneClick?: boolean
      perMachine?: boolean
      allowToChangeInstallationDirectory?: boolean
      artifactName?: string
    }
  }
}

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest

test('the controlled adapter installer ships pinned and unpacked with Toucan', () => {
  assert.match(manifest.dependencies?.npm ?? '', /^\d+\.\d+\.\d+$/)
  assert.ok(manifest.build?.asarUnpack?.includes('node_modules/npm/**/*'))
})

test('keeps native agent runtimes outside app.asar so chat providers can spawn them', () => {
  const unpackedPaths = manifest.build?.asarUnpack ?? []

  assert.ok(
    unpackedPaths.includes('node_modules/@openai/codex-win32-x64/**/*'),
    'The bundled Codex executable must be unpacked before child_process can spawn it.'
  )
  // npm may leave the platform package nested under the SDK rather than hoisted, and the SDK looks
  // there first; a root-only pattern leaves that copy packed and unspawnable (#157).
  assert.ok(
    unpackedPaths.includes('**/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**/*'),
    'Every copy of the bundled Claude executable must be unpacked before the Claude SDK can spawn it.'
  )
})

test('the bundled skills ship with the manifest that makes Claude load them at all', () => {
  // The manifest sits beside `skills/`, not inside it, so a glob aimed at the skills alone leaves
  // it behind and every packaged session loads a plugin with nothing in it - silently, because the
  // skills folder Toucan probes for is there all the same (#212). Both halves are asserted, since
  // either one alone is a glob that can be narrowed onto the other and still pass. electron-builder
  // matches with minimatch and `dot: true` (`app-builder-lib/out/fileMatcher.js`), which is what
  // this uses - over the include patterns only, since minimatch reports a miss against a `!`
  // exclude as a hit. It is stricter in one way: a magic-free pattern, which electron-builder
  // expands to `<pattern>/**/*` itself, would have to be written out here as the glob it becomes.
  const required = [PROJECT_SKILLS_MANIFEST_SEGMENTS, projectSkillFileSegments('brain-dump')].map((segments) =>
    segments.join('/')
  )
  for (const [option, patterns] of [
    ['files', manifest.build?.files ?? []],
    ['asarUnpack', manifest.build?.asarUnpack ?? []]
  ] as const) {
    const includes = patterns.filter((pattern) => !pattern.startsWith('!'))
    for (const path of required) {
      assert.ok(
        includes.some((pattern) => minimatch(path, pattern, { dot: true })),
        `build.${option} must cover ${path}, or a packaged build's skills plugin loads nothing`
      )
    }
  }
})

test('builds both a portable exe and an NSIS installer for Windows x64', () => {
  const targets = manifest.build?.win?.target ?? []
  const targetNames = targets.map((entry) => entry.target).sort()

  assert.deepEqual(targetNames, ['nsis', 'portable'])
  for (const entry of targets) {
    assert.deepEqual(entry.arch, ['x64'], `${entry.target} must stay x64-only`)
  }
})

test('installs per user without admin rights and lets the user pick the directory', () => {
  const nsis = manifest.build?.nsis
  assert.ok(nsis, 'build.nsis options must be declared explicitly')
  assert.equal(nsis.oneClick, false, 'an assisted installer is what lets the user choose the directory')
  assert.equal(nsis.perMachine, false, 'per-user install is what works on managed machines without admin')
  assert.equal(nsis.allowToChangeInstallationDirectory, true)
})

test('names the two artifacts so the installer and the portable exe cannot be confused', () => {
  assert.equal(manifest.build?.nsis?.artifactName, 'Toucan-Setup-${version}-${arch}.${ext}')
  assert.equal(manifest.build?.portable?.artifactName, 'Toucan-${version}-portable-${arch}.${ext}')
  assert.equal(
    manifest.build?.win?.artifactName,
    undefined,
    'a win-level artifactName would give both targets the same file name'
  )
})

test('package:win builds every configured Windows target rather than only the portable one', () => {
  const script = manifest.scripts?.['package:win'] ?? ''
  assert.match(script, /electron-builder --win --x64/)
  assert.doesNotMatch(script, /--win portable/, 'naming one target on the CLI overrides the configured list')
})

test('the updater ships with the app, because a devDependency is stripped from the package', () => {
  assert.ok(
    manifest.dependencies?.['electron-updater'],
    'electron-updater runs inside the packaged main process, so it is a runtime dependency'
  )
  assert.equal(manifest.devDependencies?.['electron-updater'], undefined)
})

/**
 * electron-builder ships `dependencies` into the asar and strips `devDependencies`, while
 * `externalizeDepsPlugin()` (electron.vite.config.ts) uses the same list to decide what Rollup
 * leaves as a runtime `require` in `out/main` and `out/preload`. The two rules are the same rule:
 * a package the main process reaches for at runtime must be a dependency, and a package Vite has
 * already inlined into `out/renderer` must not be - otherwise a second, unused copy of it is
 * packaged. Renderer libraries drifting into `dependencies` cost ~115 MB of asar (#238).
 *
 * "Reaches for" is broader than `import`: some packages are resolved by name at runtime
 * (`require.resolve('npm/package.json')`, the ACP adapter specifiers in
 * `src/shared/adapter-management.ts`, the SDK specifier in `src/main/claude-usage.ts`), so a
 * dependency counts as used when a privileged source file names it in any string.
 */
const PRIVILEGED_SOURCE_DIRECTORIES = ['src/main', 'src/preload', 'src/shared']

function privilegedSourceText(): string {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) files.push(full)
    }
  }
  for (const directory of PRIVILEGED_SOURCE_DIRECTORIES) walk(join(process.cwd(), directory))
  return files.map((file) => readFileSync(file, 'utf8')).join('\n')
}

test('every runtime dependency is named by the main, preload or shared sources', () => {
  const sources = privilegedSourceText()
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const named = new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\/]/g, '\$&')}(/[^'"\`]*)?['"\`]`).test(sources)
    assert.ok(
      named,
      `${name} is a runtime dependency but no file under ${PRIVILEGED_SOURCE_DIRECTORIES.join(', ')} names it. ` +
        'A renderer-only package belongs in devDependencies: Vite already inlines it into out/renderer, ' +
        'so leaving it here ships a second copy inside the asar.'
    )
  }
})

test('packages the main process imports are runtime dependencies rather than devDependencies', () => {
  const sources = privilegedSourceText()
  const imported = new Set(
    [...sources.matchAll(/from '((?:@[^'/]+\/)?[^'.@][^']*)'/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith('node:'))
      .map((specifier) =>
        specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      )
  )
  // Electron is provided by the runtime itself, so it is the one import that stays a devDependency.
  imported.delete('electron')
  for (const name of imported) {
    assert.ok(
      manifest.dependencies?.[name],
      `${name} is imported by privileged source but is not in dependencies, so electron-builder strips it ` +
        'from the package and Rollup silently inlines it into out/main instead.'
    )
  }
})
