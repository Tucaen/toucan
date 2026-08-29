#!/usr/bin/env node
// Push the branch and open a pull request, degrading through hosted -> linked -> local.
// Prints a single JSON object on stdout; command output goes to stderr.
//
// Usage: node publish.mjs --base <branch> --body <path-to-pr-body.md> [--title <title>]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()

const tryRun = (cmd, argv, opts) => {
  try { return { ok: true, out: run(cmd, argv, opts) } } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.stdout ?? error.message).trim() }
  }
}

const done = (payload) => {
  console.log(JSON.stringify(payload))
  process.exit(0)
}

const base = flag('base')
const bodyFile = flag('body')
if (!base || !bodyFile) {
  console.log(JSON.stringify({ ok: false, error: 'usage: publish.mjs --base <branch> --body <file> [--title <t>]' }))
  process.exit(1)
}

let body
try {
  body = readFileSync(bodyFile, 'utf8')
} catch {
  console.log(JSON.stringify({ ok: false, error: `cannot read body file: ${bodyFile}` }))
  process.exit(1)
}

const title = flag('title')
  ?? body.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim()
  ?? 'Pull request'

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])

const localTier = (reason) => {
  const commits = tryRun('git', ['log', '--oneline', `${base}..${branch}`])
  done({
    ok: true,
    tier: 'local',
    reason,
    branch,
    base,
    bodyFile,
    commits: commits.ok ? commits.out.split('\n').filter(Boolean) : [],
    next: `git switch ${base} && git merge --no-ff ${branch}`
  })
}

// --- Remote ------------------------------------------------------------------
const remote = tryRun('git', ['remote', 'get-url', 'origin'])
if (!remote.ok || !remote.out) localTier('no origin remote')

// Normalise https, ssh and scp-style remotes to { host, segments }.
const parseRemote = (url) => {
  const cleaned = url.replace(/\.git$/, '')
  const scp = cleaned.match(/^[^@]+@([^:]+):(.+)$/)
  const source = scp ? `https://${scp[1]}/${scp[2]}` : cleaned
  try {
    const parsed = new URL(source)
    return { host: parsed.hostname, segments: parsed.pathname.split('/').filter(Boolean) }
  } catch {
    return null
  }
}

const parsed = parseRemote(remote.out)
if (!parsed) localTier(`unparseable remote: ${remote.out}`)

const { host, segments } = parsed
const isGitHub = /github/i.test(host)
const isBitbucketCloud = /(^|\.)bitbucket\.org$/.test(host)
// Data Center puts the repo under /scm/<project>/<repo>.
const dcIndex = segments.indexOf('scm')
const isBitbucketDC = dcIndex >= 0 && segments.length >= dcIndex + 3

// --- Push --------------------------------------------------------------------
if (args.includes('--plan')) {
  done({ ok: true, plan: true, host, branch, base, title, isGitHub, isBitbucketCloud, isBitbucketDC })
}

let push = tryRun('git', ['push', '-u', 'origin', branch], { stdio: ['ignore', 'pipe', 'inherit'] })
if (!push.ok && /timed out|could not resolve|connection|502|503|504/i.test(push.out)) {
  push = tryRun('git', ['push', '-u', 'origin', branch], { stdio: ['ignore', 'pipe', 'inherit'] })
}
if (!push.ok) localTier(`push failed: ${push.out.split('\n').slice(-3).join(' ')}`)

// --- Compare URL (the linked tier, and the fallback for every hosted failure) --
const compareUrl = () => {
  if (isGitHub) {
    const [owner, repo] = segments
    return `https://${host}/${owner}/${repo}/compare/${base}...${branch}?expand=1`
  }
  if (isBitbucketCloud) {
    const [workspace, repo] = segments
    return `https://bitbucket.org/${workspace}/${repo}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(base)}`
  }
  if (isBitbucketDC) {
    const project = segments[dcIndex + 1]
    const repo = segments[dcIndex + 2]
    return `https://${host}/projects/${project}/repos/${repo}/pull-requests?create`
      + `&sourceBranch=refs/heads/${encodeURIComponent(branch)}&targetBranch=refs/heads/${encodeURIComponent(base)}`
  }
  return null
}

const linkedTier = (reason) => done({
  ok: true,
  tier: 'linked',
  reason,
  branch,
  base,
  bodyFile,
  url: compareUrl(),
  next: 'open the url, paste the body file, submit'
})

// --- Hosted: GitHub ----------------------------------------------------------
if (isGitHub) {
  const auth = tryRun('gh', ['auth', 'status'])
  if (!auth.ok) linkedTier('gh missing or unauthenticated')
  const pr = tryRun('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile])
  if (!pr.ok) linkedTier(`gh pr create failed: ${pr.out.split('\n').slice(-2).join(' ')}`)
  done({ ok: true, tier: 'hosted', branch, base, bodyFile, url: pr.out.split('\n').filter(Boolean).pop() })
}

// --- Hosted: Bitbucket -------------------------------------------------------
if (isBitbucketCloud || isBitbucketDC) {
  const token = process.env.BITBUCKET_TOKEN ?? process.env.BITBUCKET_APP_PASSWORD
  if (!token) linkedTier('no BITBUCKET_TOKEN in environment')

  const endpoint = isBitbucketCloud
    ? `https://api.bitbucket.org/2.0/repositories/${segments[0]}/${segments[1]}/pullrequests`
    : `https://${host}/rest/api/latest/projects/${segments[dcIndex + 1]}/repos/${segments[dcIndex + 2]}/pull-requests`

  const payload = isBitbucketCloud
    ? { title, description: body, source: { branch: { name: branch } }, destination: { branch: { name: base } } }
    : {
        title,
        description: body,
        fromRef: { id: `refs/heads/${branch}` },
        toRef: { id: `refs/heads/${base}` }
      }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) linkedTier(`bitbucket api ${response.status}`)
    const created = await response.json()
    const url = created?.links?.html?.href ?? created?.links?.self?.[0]?.href ?? compareUrl()
    done({ ok: true, tier: 'hosted', branch, base, bodyFile, url })
  } catch (error) {
    linkedTier(`bitbucket api unreachable: ${error.message}`)
  }
}

linkedTier(`unrecognised host: ${host}`)
