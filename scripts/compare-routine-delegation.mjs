// Run after `npx tsc -p tsconfig.test.json`. Uses the signed-in Claude CLI/account.
// Two bounded, read-only calls; raw logs stay in a newly-created temporary fixture.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hiddenProcessOptions } from '../.test-out/src/main/background-process.js'
import { claudeDelegationSessionMeta } from '../.test-out/src/shared/routine-delegation.js'

const executable = process.argv[2] ?? join(homedir(), '.local', 'bin', 'claude.exe')
const fixture = await mkdtemp(join(tmpdir(), 'toucan-delegation-181-'))
for (let index = 0; index < 12; index++) {
  await writeFile(
    join(fixture, `part-${index}.ts`),
    `export function isReady${index}() { return true }\nexport function isValid${index}() { return true }\nexport function other${index}() { return false }\n`
  )
}
const meta = claudeDelegationSessionMeta({ workerModelId: 'haiku' })
const prompt =
  'Inspect all twelve part-*.ts files in the current directory. Count exported functions whose names start with is. Return only the total as an integer. Do not modify files.'
const results = []
for (const enabled of [false, true]) {
  const args = [
    '-p',
    enabled
      ? `${prompt} Hand inspection to exactly one routine-worker using Agent, omit the model argument, then check its answer.`
      : prompt,
    '--model',
    'opus',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    '2',
    '--tools',
    'Read,Glob,Grep,Agent',
    '--allowedTools',
    'Read,Glob,Grep,Agent',
    '--append-system-prompt',
    enabled ? meta.systemPrompt.append : 'Perform the work yourself. Do not delegate.'
  ]
  if (enabled) args.push('--agents', JSON.stringify(meta.claudeCode.options.agents))
  const started = Date.now()
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, hiddenProcessOptions({ cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] }))
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`CLI exit ${code}: ${stderr}`))))
  })
  await writeFile(join(fixture, `${enabled ? 'enabled' : 'disabled'}.jsonl`), output)
  const events = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = events.findLast((event) => event.type === 'result')
  const workerCalls = events
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name))
  const summary = {
    enabled,
    wallMs: Date.now() - started,
    outcome: result?.subtype,
    answer: result?.result,
    correct: result?.result?.trim() === '24',
    costUsd: result?.total_cost_usd,
    mainLoopUsage: result?.usage,
    inclusiveModelUsage: result?.modelUsage,
    workers: workerCalls.map((call) => ({ type: call.input.subagent_type, requestedModel: call.input.model ?? null }))
  }
  results.push(summary)
  console.log(JSON.stringify(summary, null, 2))
}
await writeFile(join(fixture, 'comparison.json'), JSON.stringify(results, null, 2))
console.log(`Evidence: ${fixture}`)
