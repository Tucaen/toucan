import * as assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'

interface BuildConfig {
  asarUnpack: string[]
  nsis: { artifactName: string }
  portable: { artifactName: string }
  publish: { provider: string; owner: string; repo: string }
}

interface PackageFacts {
  version: string
  build: BuildConfig
  distFiles: string[]
  latestYml: string | null
  appUpdateYml: string | null
  hasAsar: boolean
  unpacked: Record<string, number>
}

interface PackageCheckModule {
  releaseArtifacts(version: string, build: BuildConfig): string[]
  packageProblems(facts: PackageFacts): string[]
}

// A file URL, as in release-gate.test.ts: the script is plain `.mjs` outside the test tree.
const checkModule = import(
  /* @vite-ignore */ pathToFileURL(join(process.cwd(), 'scripts/package-check.mjs')).href
) as Promise<PackageCheckModule>

const build: BuildConfig = {
  asarUnpack: ['node_modules/npm/**/*', '.agents/**/*'],
  nsis: { artifactName: 'Toucan-Setup-${version}-${arch}.${ext}' },
  portable: { artifactName: 'Toucan-${version}-portable-${arch}.${ext}' },
  publish: { provider: 'github', owner: 'Tucaen', repo: 'toucan' }
}

const latest = (version: string, installer: string): string =>
  `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: x\n    size: 1\npath: ${installer}\nsha512: x\n`

const healthy = (): PackageFacts => ({
  version: '0.26.9',
  build,
  distFiles: [
    'Toucan-Setup-0.26.9-x64.exe',
    'Toucan-Setup-0.26.9-x64.exe.blockmap',
    'Toucan-0.26.9-portable-x64.exe',
    'latest.yml',
    'win-unpacked'
  ],
  latestYml: latest('0.26.9', 'Toucan-Setup-0.26.9-x64.exe'),
  appUpdateYml: 'owner: Tucaen\nrepo: toucan\nprovider: github\nreleaseType: release\n',
  hasAsar: true,
  unpacked: { 'node_modules/npm/**/*': 453, '.agents/**/*': 34 }
})

test('names the files a release uploads from the configured artifact names', async () => {
  const { releaseArtifacts } = await checkModule
  assert.deepEqual(releaseArtifacts('0.26.9', build), [
    'Toucan-Setup-0.26.9-x64.exe',
    'Toucan-Setup-0.26.9-x64.exe.blockmap',
    'Toucan-0.26.9-portable-x64.exe',
    'latest.yml'
  ])
})

test('a package the release could publish has no problems', async () => {
  const { packageProblems } = await checkModule
  assert.deepEqual(packageProblems(healthy()), [])
})

test('a missing installer or update feed is a problem', async () => {
  const { packageProblems } = await checkModule
  const facts = healthy()
  facts.distFiles = facts.distFiles.filter((file) => !file.includes('portable') && file !== 'latest.yml')
  facts.latestYml = null
  const problems = packageProblems(facts).join('\n')
  assert.match(problems, /Toucan-0\.26\.9-portable-x64\.exe/)
  assert.match(problems, /latest\.yml/)
})

test('an update feed that names another version or installer is a problem', async () => {
  const { packageProblems } = await checkModule
  const facts = healthy()
  facts.latestYml = latest('0.26.8', 'Toucan-Setup-0.26.8-x64.exe')
  const problems = packageProblems(facts).join('\n')
  assert.match(problems, /version 0\.26\.8/)
  assert.match(problems, /Toucan-Setup-0\.26\.8-x64\.exe/)
})

test('an asarUnpack pattern that unpacked nothing is a problem, because the app runs those files from disk', async () => {
  const { packageProblems } = await checkModule
  const facts = healthy()
  facts.unpacked = { 'node_modules/npm/**/*': 453, '.agents/**/*': 0 }
  assert.match(packageProblems(facts).join('\n'), /\.agents\/\*\*\/\*/)
})

test('an updater config pointing anywhere but build.publish is a problem', async () => {
  const { packageProblems } = await checkModule
  const facts = healthy()
  facts.appUpdateYml = 'owner: Tucaen\nrepo: toucan-releases\nprovider: github\n'
  assert.match(packageProblems(facts).join('\n'), /app-update\.yml.*repo/)
  facts.appUpdateYml = null
  facts.hasAsar = false
  const problems = packageProblems(facts).join('\n')
  assert.match(problems, /app-update\.yml/)
  assert.match(problems, /app\.asar/)
})
