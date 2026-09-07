import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

interface WindowsTarget {
  target: string
  arch: string[]
}

interface PackageManifest {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: {
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
