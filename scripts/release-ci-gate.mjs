import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { ciDecision, ciRefusal, isVersionBump, tagRefusal } from './release-gate.mjs'

// The release workflow's first job: refuses to build or publish a tag unless CI passed on the code
// it would ship. `npm run release` already checks CI before it tags, but a tag pushed by hand skips
// that script, and v0.26.0, v0.26.3, v0.26.4 and v0.26.8 all failed after being tagged on a red or
// unfinished main. Runs in the workflow on the checked-out tag (fetch-depth 2, so the parent is there).
//
//   node scripts/release-ci-gate.mjs <tag>

const RUNNING_LIMIT_MS = 45 * 60_000
const MISSING_LIMIT_MS = 3 * 60_000
const POLL_MS = 30_000

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trimEnd()
}

function fail(message) {
  console.error(`release gate: ${message}`)
  process.exit(1)
}

function jsonAt(revision, path) {
  try {
    return JSON.parse(git('show', `${revision}:${path}`))
  } catch {
    return null
  }
}

const tag = process.argv[2]
if (!tag) fail('usage: node scripts/release-ci-gate.mjs <tag>')

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const tagProblem = tagRefusal(tag, manifest.version)
if (tagProblem) fail(tagProblem)

const repository = manifest.repository.url.replace(/\.git$/, '')

function ciRuns(sha) {
  return JSON.parse(
    execFileSync(
      'gh',
      ['run', 'list', '--repo', repository, '--workflow', 'ci.yml', '--commit', sha, '--json', 'status,conclusion,url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
    )
  )
}

// The bump commit `npm run release` pushes changes nothing CI looks at, and its parent is the
// commit the script already found green - so a green parent clears it without waiting for the
// bump's own run. Releases cut before that check existed pushed parent and bump together, which
// cancelled the parent's run; for those, and for any other commit, the tagged commit's own CI
// decides.
const head = git('rev-parse', 'HEAD')
const short = head.slice(0, 7)
const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)
if (parents.length === 1) {
  const [parent] = parents
  const changed = git('diff', '--name-only', parent, head).split('\n').filter(Boolean)
  const files = Object.fromEntries(changed.map((path) => [path, [jsonAt(parent, path), jsonAt(head, path)]]))
  if (isVersionBump(git('log', '-1', '--format=%s', head), files)) {
    const runs = ciRuns(parent)
    const refusal = ciRefusal(parent.slice(0, 7), runs)
    if (!refusal) {
      console.log(`${short} only bumps the version, and CI passed on its parent (${runs[0].url}).`)
      process.exit(0)
    }
    console.log(`${short} only bumps the version, but its parent is not cleared: ${refusal}`)
  }
}

console.log(`Checking CI on the tagged commit ${short}.`)
const started = Date.now()
for (;;) {
  const runs = ciRuns(head)
  const decision = ciDecision(short, runs, Date.now() - started, {
    runningMs: RUNNING_LIMIT_MS,
    missingMs: MISSING_LIMIT_MS
  })
  if (!decision.wait) {
    if (decision.refusal) fail(decision.refusal)
    console.log(`CI passed on ${short} (${runs[0].url}).`)
    break
  }
  console.log(runs[0] ? `CI on ${short} is ${runs[0].status}; waiting.` : `No CI run for ${short} yet; waiting.`)
  await sleep(POLL_MS)
}
