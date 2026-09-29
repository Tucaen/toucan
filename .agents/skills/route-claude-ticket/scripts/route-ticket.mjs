#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const finish = (payload, code = 0) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(code)
}

if (args.includes('--help')) {
  finish({
    ok: true,
    usage: 'node route-ticket.mjs --input <json-file> [--catalogue <agent-models.json>] [--dry-run]'
  })
}

const inputPath = flag('input')
if (!inputPath) finish({ ok: false, error: 'Missing --input <json-file>.' }, 2)

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

let input
try {
  input = await readJson(inputPath)
} catch (error) {
  finish({ ok: false, error: `Could not read input JSON: ${error.message}` }, 2)
}

if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'task')) {
  finish({ ok: false, error: 'Input JSON must be an object containing task.' }, 2)
}

const cataloguePaths = () => {
  const paths = []
  if (flag('catalogue')) paths.push(flag('catalogue'))
  if (process.env.TOUCAN_MODEL_CATALOGUE_PATH) paths.push(process.env.TOUCAN_MODEL_CATALOGUE_PATH)
  if (process.env.APPDATA) {
    paths.push(join(process.env.APPDATA, 'toucan', 'agent-models.json'))
    paths.push(join(process.env.APPDATA, 'Toucan', 'agent-models.json'))
  }
  if (process.platform === 'darwin') {
    paths.push(join(homedir(), 'Library', 'Application Support', 'toucan', 'agent-models.json'))
    paths.push(join(homedir(), 'Library', 'Application Support', 'Toucan', 'agent-models.json'))
  }
  paths.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'toucan', 'agent-models.json'))
  return [...new Set(paths.filter(Boolean))]
}

const validModel = (model) =>
  model &&
  typeof model === 'object' &&
  typeof model.id === 'string' &&
  model.id.length > 0 &&
  typeof model.name === 'string' &&
  model.name.length > 0 &&
  (model.description === undefined || typeof model.description === 'string')

const concreteModels = (models) => {
  if (!Array.isArray(models)) return []
  const seen = new Set()
  return models.filter(validModel).filter((model) => {
    if (model.id === 'default' || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

let cataloguePath
let catalogueModifiedAt
let models = concreteModels(input.models)
if (models.length === 0) {
  for (const path of cataloguePaths()) {
    try {
      const catalogue = await readJson(path)
      const discovered = concreteModels(catalogue?.claude)
      if (discovered.length === 0) continue
      models = discovered
      cataloguePath = path
      catalogueModifiedAt = (await stat(path)).mtime.toISOString()
      break
    } catch {
      // Try the next known Toucan user-data location.
    }
  }
}

if (models.length < 2) {
  finish(
    {
      ok: false,
      error:
        "Fewer than two concrete Claude models were supplied or discovered. Run a Claude ACP session to refresh Toucan's model catalogue, or provide input.models."
    },
    2
  )
}

const criteria = Object.fromEntries(
  models.map((model) => [
    model.id,
    {
      name: model.name,
      advertisedRole: model.description ?? 'No role description was advertised.'
    }
  ])
)

const request = {
  model: 'jev-latest',
  state: {
    task: input.task,
    candidates: models
  },
  questions: {
    model: {
      type: 'choice',
      instructions:
        "Choose the least-powerful candidate that is likely to complete `task` reliably in one fresh coding-agent conversation. Use each candidate's advertised role. Prefer efficiency for clear implementation and reserve the strongest candidates for difficult diagnosis, security-sensitive work, broad cross-cutting changes, or consequential architecture.",
      criteria
    },
    reasoning_depth: {
      type: 'score',
      instructions: 'How much deliberate reasoning will successful implementation of `task` require?',
      criteria: [
        'Mechanical execution with an explicit recipe and negligible ambiguity',
        'Localized implementation with clear acceptance criteria',
        'Moderate design choices or interaction among several modules',
        'Difficult debugging, substantial ambiguity, or broad architectural effects',
        'Exceptional complexity, high stakes, or novel architecture'
      ]
    }
  }
}

const source = {
  kind: input.models ? 'input' : 'toucan-catalogue',
  ...(cataloguePath ? { path: cataloguePath, modifiedAt: catalogueModifiedAt } : {})
}

if (args.includes('--dry-run')) finish({ ok: true, dryRun: true, source, candidates: models, request })

const apiKey = process.env.TYPESAFE_API_KEY
if (!apiKey) finish({ ok: false, error: 'TYPESAFE_API_KEY is unavailable to this process.' }, 2)

const endpoint = (() => {
  const configured = process.env.TYPESAFE_BASE_URL
  if (!configured) return 'https://api.typesafe.ai/v1/systemone'
  return configured.replace(/\/$/, '').endsWith('/v1/systemone')
    ? configured.replace(/\/$/, '')
    : `${configured.replace(/\/$/, '')}/v1/systemone`
})()

const call = async () => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { message: text.slice(0, 500) }
  }
  return { response, body }
}

let result
try {
  result = await call()
  if (result.response.status === 429 || result.response.status === 529) result = await call()
} catch (error) {
  finish({ ok: false, error: `TypeSafe request failed: ${error.message}` }, 1)
}

if (!result.response.ok) {
  finish(
    {
      ok: false,
      error: `TypeSafe returned HTTP ${result.response.status}.`,
      detail: result.body?.error?.message ?? result.body?.message
    },
    1
  )
}

const modelAnswer = result.body?.answers?.model
const depthAnswer = result.body?.answers?.reasoning_depth
const selected = models.find((model) => model.id === modelAnswer?.choice)
if (!selected || typeof modelAnswer?.confidence !== 'number' || typeof depthAnswer?.score !== 'number') {
  finish({ ok: false, error: 'TypeSafe returned an incomplete or unknown routing answer.' }, 1)
}

const effortFor = (score) => {
  if (score < 0.75) return 'low'
  if (score < 1.75) return 'medium'
  if (score < 2.75) return 'high'
  if (score < 3.5) return 'xhigh'
  return 'max'
}

finish({
  ok: true,
  source,
  candidates: models,
  recommendation: {
    model: selected,
    effort: effortFor(depthAnswer.score),
    modelConfidence: modelAnswer.confidence,
    reasoningDepth: depthAnswer.score,
    reviewRequired: modelAnswer.confidence < 0.6
  },
  probabilities: modelAnswer.probabilities,
  resolvedJevModel: result.body.model,
  usage: result.body.usage
})
