import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createTerminalShell } from '../src/main/terminal-shell'

test('prefers PowerShell 7 for a plain terminal', () => {
  const shell = createTerminalShell({
    environment: {},
    resolveCommand: (command) => (command === 'pwsh.exe' ? 'C:\\Tools\\pwsh.exe' : null)
  })

  assert.deepEqual(shell.resolveLaunch(), { executable: 'C:\\Tools\\pwsh.exe', args: ['-NoLogo'] })
})

test('falls back to Windows PowerShell when PowerShell 7 is not installed', () => {
  const shell = createTerminalShell({
    environment: { ComSpec: 'C:\\Windows\\cmd.exe' },
    resolveCommand: (command) => (command === 'powershell.exe' ? 'C:\\Windows\\powershell.exe' : null)
  })

  assert.deepEqual(shell.resolveLaunch(), { executable: 'C:\\Windows\\powershell.exe', args: ['-NoLogo'] })
})

test('falls back to the environment ComSpec, and to cmd.exe when even that is unset', () => {
  const withComSpec = createTerminalShell({
    environment: { ComSpec: 'C:\\Windows\\cmd.exe' },
    resolveCommand: () => null
  })
  assert.deepEqual(withComSpec.resolveLaunch(), { executable: 'C:\\Windows\\cmd.exe', args: [] })

  const bare = createTerminalShell({ environment: {}, resolveCommand: () => null })
  assert.deepEqual(bare.resolveLaunch(), { executable: 'cmd.exe', args: [] })
})
