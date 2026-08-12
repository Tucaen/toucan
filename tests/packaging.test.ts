import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

interface PackageManifest {
  build?: {
    asarUnpack?: string[]
  }
}

test('keeps native agent runtimes outside app.asar so chat providers can spawn them', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  ) as PackageManifest
  const unpackedPaths = manifest.build?.asarUnpack ?? []

  assert.ok(
    unpackedPaths.includes('node_modules/@openai/codex-win32-x64/**/*'),
    'The bundled Codex executable must be unpacked before child_process can spawn it.'
  )
  assert.ok(
    unpackedPaths.includes('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**/*'),
    'The bundled Claude executable must be unpacked before the Claude SDK can spawn it.'
  )
})
