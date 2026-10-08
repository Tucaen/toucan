#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'

// The orchestrator's CLI (#33, #34, #35, #36, #40): sends one command to the Toucan endpoint named in the
// environment and prints its reply as one JSON line. Only an orchestrator session carries the
// endpoint and token; every other session gets a clear refusal before anything is sent.

const USAGE = [
  'Usage: orchestrate.mjs plan show',
  '| plan set (--file <plan.json> | --json <plan>)',
  '| ticket update <id> (--json <fields> | --file <fields.json>)',
  '| route [--ticket <id> --tier <tier>]',
  '| escalate --ticket <id>',
  '| spawn --ticket <id> [--model <id> --effort <level> | --tier <tier> [--effort <level>]] [--provider <provider>] [--project <path>]',
  '| status',
  '| cleanup [--ticket <id>]',
  '| report',
  '| outcome --ticket <id>',
  '| followup --ticket <id> --text <text>'
].join(' ')

const finish = (payload, code) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(code)
}

const usage = (problem) => finish({ ok: false, error: `${problem}. ${USAGE}` }, 2)

for (const name of ['TOUCAN_ORCHESTRATOR_URL', 'TOUCAN_ORCHESTRATOR_TOKEN']) {
  if (!process.env[name]) {
    finish(
      {
        ok: false,
        error: `${name} is not set: this CLI only works inside a Toucan orchestrator session, which Toucan launches with it`
      },
      2
    )
  }
}
const url = process.env.TOUCAN_ORCHESTRATOR_URL
const token = process.env.TOUCAN_ORCHESTRATOR_TOKEN

/** Splits `--name value` pairs from positionals; a flag without a value, or given twice, is a usage error. */
function parseFlags(words, allowed) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (!word.startsWith('--')) {
      positionals.push(word)
      continue
    }
    const name = word.slice(2)
    if (!allowed.includes(name)) usage(`Unknown flag ${word}`)
    if (Object.hasOwn(flags, name)) usage(`${word} is given twice`)
    const value = words[index + 1]
    if (value === undefined || value.startsWith('--')) usage(`${word} needs a value`)
    flags[name] = value
    index += 1
  }
  return { flags, positionals }
}

/** Reads the JSON a command carries from exactly one of --file and --json. */
async function jsonInput(flags, what) {
  if ((flags.file === undefined) === (flags.json === undefined)) usage(`${what} needs exactly one of --file and --json`)
  let text = flags.json
  if (flags.file !== undefined) {
    try {
      text = await readFile(flags.file, 'utf8')
    } catch (error) {
      usage(`Could not read ${flags.file}: ${error.message}`)
    }
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    return usage(`${what} is not valid JSON: ${error.message}`)
  }
}

async function message(words) {
  const [first, second, ...rest] = words
  if (first === 'plan' && second === 'show') {
    const { flags, positionals } = parseFlags(rest, [])
    if (positionals.length > 0 || Object.keys(flags).length > 0) usage('plan show takes no arguments')
    return { command: 'plan show' }
  }
  if (first === 'plan' && second === 'set') {
    const { flags, positionals } = parseFlags(rest, ['file', 'json'])
    if (positionals.length > 0) usage('plan set takes no positional arguments')
    return { command: 'plan set', args: await jsonInput(flags, 'The plan') }
  }
  if (first === 'ticket' && second === 'update') {
    const { flags, positionals } = parseFlags(rest, ['file', 'json'])
    if (positionals.length !== 1) usage('ticket update needs exactly one ticket id')
    return { command: 'ticket update', args: { id: positionals[0], fields: await jsonInput(flags, 'The update') } }
  }
  if (first === 'spawn') {
    const { flags, positionals } = parseFlags(words.slice(1), [
      'ticket',
      'model',
      'tier',
      'effort',
      'provider',
      'project'
    ])
    if (positionals.length > 0) usage('spawn takes no positional arguments')
    return { command: 'spawn', args: flags }
  }
  if (first === 'route') {
    const { flags, positionals } = parseFlags(words.slice(1), ['ticket', 'tier'])
    if (positionals.length > 0) usage('route takes no positional arguments')
    return { command: 'route', args: flags }
  }
  if (first === 'escalate') {
    const { flags, positionals } = parseFlags(words.slice(1), ['ticket'])
    if (positionals.length > 0 || flags.ticket === undefined) usage('escalate needs --ticket <id> and nothing else')
    return { command: 'escalate', args: flags }
  }
  if (first === 'cleanup') {
    const { flags, positionals } = parseFlags(words.slice(1), ['ticket'])
    if (positionals.length > 0) usage('cleanup takes no positional arguments')
    return { command: 'cleanup', ...(flags.ticket === undefined ? {} : { args: flags }) }
  }
  if (first === 'status' || first === 'report') {
    if (words.length > 1) usage(`${first} takes no arguments`)
    return { command: first }
  }
  if (first === 'outcome') {
    const { flags, positionals } = parseFlags(words.slice(1), ['ticket'])
    if (positionals.length > 0 || flags.ticket === undefined) usage('outcome needs --ticket <id> and nothing else')
    return { command: 'outcome', args: flags }
  }
  if (first === 'followup') {
    const { flags, positionals } = parseFlags(words.slice(1), ['ticket', 'text'])
    if (positionals.length > 0 || flags.ticket === undefined || flags.text === undefined) {
      usage('followup needs --ticket <id> --text <text> and nothing else')
    }
    return { command: 'followup', args: flags }
  }
  return usage(words.length === 0 ? 'No command given' : `Unknown command "${words.join(' ')}"`)
}

/**
 * `node:http` rather than `fetch`: a spawn waits for the project's setup command (up to 15
 * minutes) and the canvas (up to 90 seconds), far past fetch's default headers timeout.
 */
function post(body) {
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text)
        }
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        response.on('error', reject)
      }
    )
    outgoing.on('error', reject)
    outgoing.end(text)
  })
}

const body = await message(process.argv.slice(2))

let replyText
try {
  replyText = await post(body)
} catch (error) {
  finish({ ok: false, error: `Could not reach Toucan at ${url}: ${error.message}` }, 1)
}

let reply
try {
  reply = JSON.parse(replyText)
} catch {
  finish({ ok: false, error: `Toucan answered with something that is not JSON: ${replyText.slice(0, 200)}` }, 1)
}
if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
  finish({ ok: false, error: `Toucan answered without an ok field: ${replyText.slice(0, 200)}` }, 1)
}
finish(reply, reply.ok ? 0 : 1)
