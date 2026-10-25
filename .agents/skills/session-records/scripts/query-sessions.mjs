#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

// Queries Toucan's session outcome records (one Markdown file per earlier agent conversation) and
// prints one JSON line: the frontmatter of each hit plus only the body sections that matched.
// Dependency-free like the orchestrator's CLI, because it runs from any project's checkout.

const USAGE = [
  'Usage: query-sessions.mjs [--dir <outcomes dir>]',
  '[--file <text>] [--failure <text>] [--title <text>]',
  '[--started-since <date>] [--started-until <date>] [--updated-since <date>] [--updated-until <date>]',
  '[--project <folder name or path> | --all-projects]',
  '[--include <task,asks,main-result,last-result,files,failures,tool-failures>]',
  '[--limit <n>]'
].join(' ')

const DEFAULT_LIMIT = 10
/** Matches `SESSION_OUTCOME_PROJECT_SLUG_LIMIT` in src/shared/session-outcome.ts. */
const PROJECT_SLUG_LIMIT = 32

/** Body heading to the key it is reported under. */
const SECTIONS = {
  Task: 'task',
  Asks: 'asks',
  'Main result': 'main-result',
  'Last result': 'last-result',
  Files: 'files',
  Failures: 'failures',
  'Tool failures': 'tool-failures'
}
const SECTION_KEYS = Object.values(SECTIONS)

const finish = (payload, code) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(code)
}

const usage = (problem) => finish({ ok: false, error: `${problem}. ${USAGE}` }, 2)

const VALUE_FLAGS = [
  'dir',
  'file',
  'failure',
  'title',
  'started-since',
  'started-until',
  'updated-since',
  'updated-until',
  'project',
  'include',
  'limit'
]
const SWITCH_FLAGS = ['all-projects']

function parseFlags(words) {
  const flags = {}
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (!word.startsWith('--')) usage(`Unexpected argument ${word}`)
    const name = word.slice(2)
    if (!VALUE_FLAGS.includes(name) && !SWITCH_FLAGS.includes(name)) usage(`Unknown flag ${word}`)
    if (Object.hasOwn(flags, name)) usage(`${word} is given twice`)
    if (SWITCH_FLAGS.includes(name)) {
      flags[name] = true
      continue
    }
    const value = words[index + 1]
    if (value === undefined || value.startsWith('--')) usage(`${word} needs a value`)
    flags[name] = value
    index += 1
  }
  return flags
}

/** The filename's project part: the same slug rule the records are written with. */
function slug(text) {
  return text
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+/, '')
    .slice(0, PROJECT_SLUG_LIMIT)
    .replace(/-+$/, '')
}

/** The main checkout's folder name where the cwd is a worktree of it, else the cwd's own. */
function currentProjectSlug() {
  const cwd = process.cwd()
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    }).trim()
    if (common) return slug(basename(basename(common) === '.git' ? dirname(common) : common))
  } catch {
    // Not a git checkout, or git cannot run: the folder itself is the project.
  }
  return slug(basename(cwd))
}

/** A date or timestamp as milliseconds; a bare date is its start, or its end when `endOfDay`. */
function instant(name, value, endOfDay) {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const ms = Date.parse(bare ? `${value}T00:00:00.000Z` : value)
  if (Number.isNaN(ms)) usage(`--${name} is not a date: ${value}`)
  return bare && endOfDay ? ms + 24 * 60 * 60 * 1000 - 1 : ms
}

function decodeValue(value) {
  if (!value.startsWith('"')) return value
  try {
    const decoded = JSON.parse(value)
    return typeof decoded === 'string' ? decoded : value
  } catch {
    return value
  }
}

/** Frontmatter fields and the body's known `## ` sections, or undefined for a file that is not a record. */
function parseRecord(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines[0] !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line === '---')
  if (closing < 0) return undefined
  const fields = {}
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line)
    if (match && !Object.hasOwn(fields, match[1])) fields[match[1]] = decodeValue(match[2])
  }
  const collected = {}
  let current
  for (const line of lines.slice(closing + 1)) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading) {
      current = SECTIONS[heading[1]]
      if (current) collected[current] = []
      continue
    }
    if (current) collected[current].push(line)
  }
  const sections = Object.fromEntries(
    Object.entries(collected).map(([key, content]) => [key, content.join('\n').trim()])
  )
  return { fields, sections }
}

const contains = (haystack, needle) => haystack.toLocaleLowerCase('en-US').includes(needle.toLocaleLowerCase('en-US'))

/** The sections the filters matched, or undefined when the record fails one of them. */
function matchRecord({ fields, sections }, filters) {
  const shown = new Set()
  if (filters.title !== undefined && !contains(fields.title ?? '', filters.title)) return undefined
  if (filters.file !== undefined) {
    if (!contains(sections.files ?? '', filters.file)) return undefined
    shown.add('files')
  }
  if (filters.failure !== undefined) {
    const keys = ['failures', 'tool-failures'].filter((key) => contains(sections[key] ?? '', filters.failure))
    if (keys.length === 0) return undefined
    for (const key of keys) shown.add(key)
  }
  for (const [field, low, high] of [
    ['started', filters.startedSince, filters.startedUntil],
    ['updated', filters.updatedSince, filters.updatedUntil]
  ]) {
    if (low === undefined && high === undefined) continue
    const at = Date.parse(fields[field] ?? '')
    if (Number.isNaN(at) || (low !== undefined && at < low) || (high !== undefined && at > high)) return undefined
  }
  return shown
}

/** Only the lines that matched: the rest of a long list is what the reader is saving. */
function matchingLines(content, needle) {
  return content
    .split('\n')
    .filter((line) => contains(line, needle))
    .join('\n')
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const directory = flags.dir ?? process.env.TOUCAN_SESSION_OUTCOMES_DIR
  if (!directory) usage('--dir <outcomes dir> is required (or set TOUCAN_SESSION_OUTCOMES_DIR)')
  if (flags['all-projects'] && flags.project !== undefined) usage('--all-projects and --project exclude each other')

  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit)
  if (!Number.isInteger(limit) || limit < 1) usage('--limit must be a positive integer')

  const include = flags.include === undefined ? [] : flags.include.split(',').map((key) => key.trim())
  for (const key of include) if (!SECTION_KEYS.includes(key)) usage(`--include names unknown section "${key}"`)

  const date = (name, endOfDay) => (flags[name] === undefined ? undefined : instant(name, flags[name], endOfDay))
  const filters = {
    file: flags.file,
    failure: flags.failure,
    title: flags.title,
    startedSince: date('started-since', false),
    startedUntil: date('started-until', true),
    updatedSince: date('updated-since', false),
    updatedUntil: date('updated-until', true)
  }
  for (const name of ['file', 'failure', 'title']) {
    if (filters[name] !== undefined && filters[name].trim() === '') usage(`--${name} must not be empty`)
  }

  const scope = flags['all-projects']
    ? undefined
    : flags.project === undefined
      ? currentProjectSlug()
      : slug(basename(resolve(flags.project)))

  let names = []
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error.code !== 'ENOENT') finish({ ok: false, error: `Could not read ${directory}: ${error.message}` }, 1)
  }
  names = names.filter((name) => name.endsWith('.md') && (scope === undefined || name.startsWith(`${scope}--`)))

  const hits = []
  for (const name of names) {
    let text
    try {
      text = await readFile(join(directory, name), 'utf8')
    } catch {
      continue
    }
    const record = parseRecord(text)
    const shown = record && matchRecord(record, filters)
    if (shown) hits.push({ name, record, shown })
  }

  const updatedAt = (hit) => Date.parse(hit.record.fields.updated ?? '') || 0
  hits.sort((a, b) => updatedAt(b) - updatedAt(a) || a.name.localeCompare(b.name))

  const records = hits.slice(0, limit).map(({ name, record, shown }) => {
    const sections = {}
    for (const key of SECTION_KEYS) {
      const content = record.sections[key]
      if (content === undefined || (!shown.has(key) && !include.includes(key))) continue
      const needle = key === 'files' ? filters.file : key.endsWith('failures') ? filters.failure : undefined
      sections[key] = needle !== undefined && !include.includes(key) ? matchingLines(content, needle) : content
    }
    return { file: name, ...record.fields, ...(Object.keys(sections).length > 0 ? { sections } : {}) }
  })

  finish(
    {
      ok: true,
      project: scope ?? null,
      total: hits.length,
      returned: records.length,
      ...(hits.length > records.length ? { more: hits.length - records.length } : {}),
      records
    },
    0
  )
}

await main()
