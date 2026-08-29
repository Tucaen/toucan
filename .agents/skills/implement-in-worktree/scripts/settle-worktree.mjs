#!/usr/bin/env node
// Decide whether this checkout is already a linked worktree, and create one if not.
// Prints a single JSON object on stdout; diagnostics go to stderr.
//
// Usage: node settle-worktree.mjs [--branch <name>] [--plan]
//
// The directory layout mirrors deriveWorktreeDirectory/worktreeDirectorySlug in
// src/shared/worktree.ts. That file is the source of truth; keep these in step.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const plan = args.includes('--plan')

const git = (argv, cwd = process.cwd()) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const gitOrNull = (argv, cwd) => {
  try { return git(argv, cwd) } catch { return null }
}

const fail = (message) => {
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}

const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// --- Detect -----------------------------------------------------------------
// A linked worktree has its own git dir inside the common dir; the main checkout
// reports the same path twice.
let gitDir, commonDir, root
try {
  gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'])
  commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  root = git(['rev-parse', '--show-toplevel'])
} catch {
  fail('not a git repository')
}

const linked = norm(gitDir) !== norm(commonDir)
const currentBranch = gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD'])

const defaultBranch = () => {
  const head = gitOrNull(['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  return head ? head.replace(/^origin\//, '') : null
}

if (linked) {
  let base = defaultBranch()
  if (base && base === currentBranch) base = null
  console.log(JSON.stringify({
    ok: true,
    mode: 'adopt',
    worktree: root,
    branch: currentBranch,
    base,
    note: base ? undefined : 'base branch unresolved - ask the user'
  }))
  process.exit(0)
}

// --- Create -----------------------------------------------------------------
const branch = flag('branch')
if (!branch) fail('main checkout: pass --branch <name> to create a worktree')

const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
if (!slug) fail(`branch name yields no usable directory: ${branch}`)

const target = join(dirname(root), `${root.split(/[\\/]/).pop()}-worktrees`, slug)
const base = currentBranch

// Setup command: ADE's per-project workspace store.
const storePath = join(
  process.env.APPDATA ?? join(process.env.HOME ?? '', '.config'),
  'ade-canvas-terminal-prototype',
  'prototype-workspace.json'
)
let setupCommand = null
try {
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const project = (store.projects ?? []).find((p) => norm(p.path) === norm(root))
  setupCommand = project?.setupCommand?.trim() || null
} catch { /* no store, unreadable, or unregistered project */ }

// Gitignored local config the worktree needs to run.
const localConfig = ['.env', '.ade'].filter((name) => existsSync(join(root, name)))

if (plan) {
  console.log(JSON.stringify({ ok: true, mode: 'create', plan: true, worktree: target, branch, base, setupCommand, localConfig }))
  process.exit(0)
}

if (existsSync(target)) fail(`${target} already exists`)

try {
  git(['worktree', 'add', '-b', branch, target, base])
} catch (error) {
  fail(`git worktree add failed: ${String(error.stderr ?? error.message).trim()}`)
}

for (const name of localConfig) {
  cpSync(join(root, name), join(target, name), { recursive: true })
}

let setup = setupCommand ? 'ran' : 'none'
if (setupCommand) {
  try {
    execFileSync(setupCommand, { cwd: target, shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    setup = 'failed'
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: 'create',
  worktree: target,
  branch,
  base,
  setupCommand,
  setup,
  localConfig
}))
