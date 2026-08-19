import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFirstMateRuntime } from '../src/main/firstmate-runtime'

function readyWslInspection(): string {
  return [
    'home=/home/tucaen',
    'distro=1',
    'runner.codex=1',
    'runner.claude=1',
    ...['node', 'git', 'gh', 'tmux', 'jq', 'claude', 'codex', 'treehouse', 'no-mistakes', 'gh-axi',
      'chrome-devtools-axi', 'lavish-axi', 'tasks-axi', 'quota-axi'].map((tool) => `tool.${tool}=1`),
    'wrapper.claude=1',
    'wrapper.codex=1',
    'gate=1',
    'daemon.no-mistakes=1',
    'githubAuth=required',
    'codexTrust=required'
  ].join('\n')
}

function quotaAxiReport(provider: string, windows: Array<{ id: string; percentRemaining: number; resetsAt: string }>): string {
  return JSON.stringify({
    generatedAt: '2026-08-18T09:00:00.000Z',
    schemaVersion: 3,
    providers: [{ provider, label: provider, source: 'oauth', plan: 'team', windows, state: { status: 'fresh' } }]
  })
}

test('reports session (five_hour) and week (seven_day) percent-remaining and reset time for a provider', async () => {
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        return {
          stdout: quotaAxiReport('claude', [
            { id: 'five_hour', percentRemaining: 33, resetsAt: '2026-08-18T11:10:00.486984+00:00' },
            { id: 'seven_day', percentRemaining: 93, resetsAt: '2026-08-25T03:00:00.487014+00:00' }
          ]),
          stderr: ''
        }
      }
    }
  })

  const quota = await runtime.quotaStatus('claude')

  assert.equal(quota.state, 'ok')
  assert.equal(quota.provider, 'claude')
  assert.deepEqual(quota.session, { percentRemaining: 33, resetsAt: '2026-08-18T11:10:00.486984+00:00' })
  assert.deepEqual(quota.week, { percentRemaining: 93, resetsAt: '2026-08-25T03:00:00.487014+00:00' })

  const quotaCall = calls.find((args) => args.includes('quota-axi'))
  assert.ok(quotaCall, 'quota-axi must actually be invoked through the shared WSL run() helper')
  assert.ok(quotaCall.includes('--provider'))
  assert.ok(quotaCall.includes('claude'))
  assert.ok(quotaCall.includes('--json'))
  assert.ok(
    quotaCall.includes('CLAUDE_CONFIG_DIR=/home/tucaen/.local/share/ade/firstmate/home/claude'),
    'quota-axi must be checked against the SAME managed claude identity real claude conversations use, not its own default credential discovery'
  )
})

test('checks codex quota against the managed CODEX_HOME, the same identity real codex conversations use', async () => {
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        return {
          stdout: quotaAxiReport('codex', [
            { id: 'five_hour', percentRemaining: 70, resetsAt: '2026-08-18T11:10:00.000Z' }
          ]),
          stderr: ''
        }
      }
    }
  })

  const quota = await runtime.quotaStatus('codex')

  assert.equal(quota.state, 'ok')
  const quotaCall = calls.find((args) => args.includes('quota-axi'))
  assert.ok(quotaCall, 'quota-axi must actually be invoked through the shared WSL run() helper')
  assert.ok(
    quotaCall.includes('CODEX_HOME=/home/tucaen/.local/share/ade/firstmate/home/codex'),
    'quota-axi must be checked against the SAME managed codex identity real codex conversations use, not its own default credential discovery'
  )
  assert.ok(!quotaCall.some((arg) => arg.startsWith('CLAUDE_CONFIG_DIR=')), 'codex checks must not set CLAUDE_CONFIG_DIR')
})

test('reports a neutral unavailable state, not a throw, when quota-axi reports no usable windows (e.g. unauthenticated)', async () => {
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        return {
          stdout: JSON.stringify({
            providers: [{ provider: 'codex', windows: [], state: { status: 'auth_required', error: 'Codex sign-in required' } }]
          }),
          stderr: ''
        }
      }
    }
  })

  const quota = await runtime.quotaStatus('codex')

  assert.equal(quota.state, 'unavailable')
  assert.equal(quota.provider, 'codex')
  assert.equal(quota.message, 'Codex sign-in required')
  assert.equal(quota.session, undefined)
  assert.equal(quota.week, undefined)
})

test('reports unavailable rather than throwing when the WSL call itself fails', async () => {
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        throw new Error('quota-axi: command not found')
      }
    }
  })

  const quota = await runtime.quotaStatus('claude')

  assert.equal(quota.state, 'unavailable')
  assert.match(quota.message ?? '', /quota-axi: command not found/)
})

test('reports unavailable rather than throwing when quota-axi output is not valid JSON', async () => {
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        return { stdout: 'not json', stderr: '' }
      }
    }
  })

  const quota = await runtime.quotaStatus('claude')

  assert.equal(quota.state, 'unavailable')
})

test('caches a provider\'s quota report briefly so concurrent panel/node polls do not each invoke quota-axi', async () => {
  let quotaInvocations = 0
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        quotaInvocations += 1
        return {
          stdout: quotaAxiReport('claude', [
            { id: 'five_hour', percentRemaining: 50, resetsAt: '2026-08-18T11:10:00.000Z' }
          ]),
          stderr: ''
        }
      }
    }
  })

  const [first, second, third] = await Promise.all([
    runtime.quotaStatus('claude'),
    runtime.quotaStatus('claude'),
    runtime.quotaStatus('claude')
  ])

  assert.equal(quotaInvocations, 1, 'three simultaneous requests for the same provider must coalesce into a single quota-axi call')
  assert.deepEqual(first, second)
  assert.deepEqual(second, third)
})

test('a platform ADE does not host FirstMate on reports quota as unavailable rather than throwing', async () => {
  const runtime = createFirstMateRuntime({ platform: 'darwin', resolveGit: () => null })

  const quota = await runtime.quotaStatus('claude')

  assert.equal(quota.state, 'unavailable')
  assert.equal(quota.provider, 'claude')
  assert.match(quota.message ?? '', /WSL/)
})

// The usage_update-to-hook-state wiring and the quota poll's cadence are exercised for real (via
// renderHook) in firstmate-quota.dom.test.tsx, alongside real render tests of the UsageStat/
// QuotaStat displays themselves. Whether FirstMatePanel/ChatNode actually mount those components
// with the right props remains a source-text assertion below: both pull in @xyflow/react's
// NodeResizer and the @moonshine-ai/moonshine-wasm voice prototype, which need a
// ReactFlowProvider/real audio stack well beyond a jsdom harness. The IPC wiring test below is
// likewise cross-process and can't be exercised from jsdom.

test('the FirstMate panel permanently shows context usage and hourly/weekly limits alongside the existing selectors', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')

  assert.match(panel, /firstmate-settings-bar/, 'the display must live in the existing settings bar, per the captain\'s placement request')
  assert.match(panel, /<UsageStat usage=\{conversation\.usage\} \/>/)
  assert.match(panel, /<QuotaStat quota=\{quota\} \/>/)
  assert.match(panel, /useFirstMateQuota\(provider, ready\)/, 'the quota poll should track whichever provider the panel is currently using')
})

test('canvas chat nodes permanently show context usage and hourly/weekly limits near the provider badge', () => {
  const chatNode = readFileSync(join(process.cwd(), 'src/renderer/src/ChatNode.tsx'), 'utf8')

  assert.match(chatNode, /<UsageStat usage=\{usage\} compact \/>/)
  assert.match(chatNode, /<QuotaStat quota=\{quota\} compact \/>/)
  assert.match(chatNode, /useFirstMateQuota\(provider, !data\.dormant\)/)
})

test('quotaStatus is wired end to end through IPC and preload, the same way other firstmate:* calls are', () => {
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const preloadTypes = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')

  assert.match(main, /ipcMain\.handle\('firstmate:quota-status',/)
  assert.match(preload, /quotaStatus: \(provider: AgentProvider\).*=>\s*\(?\s*ipcRenderer\.invoke\('firstmate:quota-status', provider\)/s)
  assert.match(preloadTypes, /quotaStatus\(provider: AgentProvider\): Promise<FirstMateQuotaStatus>/)
})
