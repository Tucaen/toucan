# Sibling-session messaging (#2)

v1 carries **asks only**: one session asks a sibling session of its project a question and the answer comes back as a message of its own. A handoff is a later follow-up on the same channel. Canvas rendering is #3.

## Settled design

- **Interface**: a dependency-free CLI beside session-records, usable by Claude and Codex sessions: `list`, `ask --to <shortId> --text`, `reply --id <msgId> --text`. A short id is the first 8 characters of the node id; there is no `ticket:<id>` addressing.
- **Reach**: same project only, any provider. Chats and ticket sessions are targets; orchestrators are not, but may send.
- **Delivery**: an idle target starts a new turn with the message. A busy target gets it when its turn ends - it is never steered. A target with a pending permission prompt or question queues it, and the asker is told `queued: target waiting on human`; messaging never answers a permission prompt. A target that is closed, exited or not running is refused, with a pointer to session-records.
- **The asker is never blocked**: `ask` returns at once and the answer wakes the asker as a new message.
- **Reply**: the target calls `reply --id`. When the turn the question started ends without one, its final text goes back marked implicit.
- **Safety**: hop depth limit 3 (a reply cannot start a deeper chain) and at most 5 asks per session per turn, both settings in `<userData>\session-messaging.json`. Turns that messages start are ordinary turns, so they count wherever provider pacing counts working sessions. An ask over a limit is refused by the CLI and published as a canvas notice for the human.
- **Persistence**: queued messages and open asks persist in `<userData>\session-messages.json` and are delivered once the target runs again after a restart. A question whose turn a restart cut short is answered "interrupted"; an asker whose target left the canvas is woken with `target closed; use session-records`.
- **Tool guidance**: the session instruction says to prefer session-records and git for past facts, and messaging for intent, plans and live state. No automatic routing.
- **Human visibility**: every message and reply reaches the canvas (`sessionMessagingApi`, #3 renders inline entries and a temporary edge while an ask is open). There is no approval step.

## Where it lives

- `src/shared/session-messaging.ts` - vocabulary, settings parsing, delivery verdict, prompt and instruction texts, canvas event types.
- `src/main/session-messenger.ts` - delivery, queueing, reply routing, implicit replies, limits, restart persistence.
- `src/main/messaging-endpoint.ts` - the per-node token and localhost listener the CLI talks to.
- `src/main/session-messaging-directory.ts` and `src/main/session-messaging-store.ts` - the canvas's sessions as messaging sees them, the message file and the settings file.
- `.agents/skills/session-messaging/` - the agent-facing skill and CLI (below).

## Pending: the skill and CLI files

Auto mode could not evaluate writes under `.agents/` for this ticket's session, so these two files are recorded here verbatim and still have to be created at `.agents/skills/session-messaging/SKILL.md` and `.agents/skills/session-messaging/scripts/message.mjs`. The session launcher already grants that directory and the instruction already names the CLI path. Once they exist, delete this section.

`SKILL.md`:

```markdown
---
name: session-messaging
description: Ask a sibling Toucan agent session in this project a question about its intent, plans or live state, and answer questions sent to you.
disable-model-invocation: true
user-invocable: false
---

# Session messaging

Run `node <this skill>/scripts/message.mjs <command>`. It prints one JSON line with an `ok` field; a refusal carries `error`.

- `list`: sibling sessions of this project you can ask - `shortId`, `title`, `provider`, `role` (`chat` or `ticket`), `ticketId`, `branch`, `state` (`idle`, `working`, `waiting_on_human`, `starting`, `not_running`) and `updatedAt`. Orchestrators are not listed: they may ask, but are never asked.
- `ask --to <shortId> --text <question>`: returns at once with the message `id` and `delivery` (`delivered`, or `queued` with a `note` saying why). Do not wait or poll: the answer arrives later as a new message that starts a turn of yours, so end your turn.
- `reply --id <messageId> --text <answer>`: answers a message delivered to you. If the turn a question started ends without a reply, your final message goes back as an implicit reply.

When to use it: for past facts - what a session did, which files it touched, what failed - use session-records and git, which cost the other session nothing. Message a session for what no record holds yet: its intent, its plan, its live state.

Delivery: an idle session starts a turn with the message; a busy one gets it when its turn ends; one waiting on its human (a permission prompt or a question) gets it once the human has answered and its turn ended - messaging never answers a permission prompt. A session that is not running cannot be asked; use session-records for it instead.

Limits: a chain of questions is at most 3 hops deep (an answer never deepens it) and a session may ask at most 5 times per turn, unless the user configured otherwise. A refused ask is shown to the human on the canvas.
```

The CLI, `message.mjs` in the skill's `scripts` folder:

```js
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
```
