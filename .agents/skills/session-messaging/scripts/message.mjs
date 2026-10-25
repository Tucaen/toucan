#!/usr/bin/env node

import { request as httpRequest } from 'node:http'

// The session-messaging CLI (#2): sends one command to the Toucan endpoint named in the environment
// and prints its reply as one JSON line. Every chat, ticket and orchestrator session Toucan launches
// carries the endpoint and a token naming its own node; anything else gets a clear refusal before
// anything is sent.

const USAGE = 'Usage: message.mjs list | ask --to <shortId> --text <question> | reply --id <messageId> --text <answer>'

const finish = (payload, code) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(code)
}

const usage = (problem) => finish({ ok: false, error: `${problem}. ${USAGE}` }, 2)

for (const name of ['TOUCAN_MESSAGING_URL', 'TOUCAN_MESSAGING_TOKEN']) {
  if (!process.env[name]) {
    finish(
      {
        ok: false,
        error: `${name} is not set: this CLI only works inside a session Toucan launched, which carries it`
      },
      2
    )
  }
}
const url = process.env.TOUCAN_MESSAGING_URL
const token = process.env.TOUCAN_MESSAGING_TOKEN

/** `--name value` pairs only; a positional, an unknown flag, a missing value or a repeat is a usage error. */
function parseFlags(words, allowed) {
  const flags = {}
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (!word.startsWith('--')) usage(`Unexpected argument ${JSON.stringify(word)}`)
    const name = word.slice(2)
    if (!allowed.includes(name)) usage(`Unknown flag ${word}`)
    if (Object.hasOwn(flags, name)) usage(`${word} is given twice`)
    const value = words[index + 1]
    if (value === undefined) usage(`${word} needs a value`)
    flags[name] = value
    index += 1
  }
  for (const name of allowed) if (flags[name] === undefined) usage(`--${name} is required`)
  return flags
}

function message(words) {
  const [command, ...rest] = words
  if (command === 'list') {
    if (rest.length > 0) usage('list takes no arguments')
    return { command }
  }
  if (command === 'ask') return { command, args: parseFlags(rest, ['to', 'text']) }
  if (command === 'reply') return { command, args: parseFlags(rest, ['id', 'text']) }
  return usage(command === undefined ? 'No command given' : `Unknown command "${words.join(' ')}"`)
}

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

const body = message(process.argv.slice(2))

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
