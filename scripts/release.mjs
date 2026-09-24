import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { nextVersion, releaseNotes } from './release-notes.mjs'

// Cuts a release: bumps the version, records what changed since the previous release in the
// tag's annotation, and pushes the tag that runs .github/workflows/release.yml. The workflow
// turns the annotation into the GitHub release notes, so this script is the one place the
// public change list is written. It never builds anything locally - the workflow verifies and
// packages - and it changes nothing before the change list has been shown and confirmed.
//
//   npm run release -- patch|minor|major|<x.y.z> [--yes] [--dry-run]

// `build.publish` is the one source of truth for where releases land (electron-builder,
// electron-updater and the workflow all read it); `repository` names this source repo.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const publish = manifest.build.publish
const RELEASES_URL = `https://github.com/${publish.owner}/${publish.repo}/releases/tag/`
const ACTIONS_URL = `${manifest.repository.url.replace(/\.git$/, '')}/actions/workflows/release.yml`

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trimEnd()
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const bump = args.find((arg) => !arg.startsWith('--'))
if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  fail('usage: npm run release -- patch|minor|major|<x.y.z> [--yes] [--dry-run]')
}

// Preconditions: a release is a commit on main that origin already has everything before.
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes.')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') fail(`releases are cut from main, not ${branch}.`)
git('fetch', '--quiet', '--tags', 'origin')
const behind = Number(git('rev-list', '--count', 'HEAD..origin/main'))
if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main; pull first.`)

let previousTag = null
try {
  previousTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
} catch {
  // First release: everything counts.
}
const subjects = git('log', '--no-merges', '--format=%s', previousTag ? `${previousTag}..HEAD` : 'HEAD')
  .split('\n')
  .filter((line) => line.length > 0)
if (subjects.length === 0) fail(`nothing has changed since ${previousTag}.`)

const current = manifest.version
const version = nextVersion(current, bump)
const tag = `v${version}`
if (git('tag', '-l', tag)) fail(`${tag} already exists.`)
const notes = releaseNotes(previousTag, subjects)

console.log(`\nRelease ${tag} (currently ${current}${previousTag ? `, last tag ${previousTag}` : ''})\n`)
console.log(notes)
console.log('These notes are published on the public release page. Nothing internal belongs in them.\n')

if (flags.has('--dry-run')) process.exit(0)

if (!flags.has('--yes')) {
  const readline = createInterface({ input: stdin, output: stdout })
  const answer = (await readline.question(`Tag and push ${tag}? [y/N] `)).trim().toLowerCase()
  readline.close()
  if (answer !== 'y' && answer !== 'yes') fail('aborted; nothing was changed.')
}

// `npm version` with an explicit version writes package.json and package-lock.json in the same
// way the documented manual procedure did; the commit and tag are ours so the tag carries notes.
execFileSync('npm', ['version', version, '--no-git-tag-version'], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
git('add', 'package.json', 'package-lock.json')
git('commit', '--quiet', '-m', version)
// The annotation body is the release notes: the workflow reads it into `gh release create`.
// --cleanup=verbatim, because git's default strips every line that starts with `#` as a comment -
// which silently ate the `## Changes since` and `### Fixes` headings out of the published notes.
git('tag', '-a', '--cleanup=verbatim', tag, '-m', `Toucan ${tag}`, '-m', notes)
git('push', '--follow-tags', 'origin', 'main')

console.log(`\nPushed ${tag}. The release workflow is running: ${ACTIONS_URL}`)
console.log(`When it finishes the release is at ${RELEASES_URL}${tag}`)
