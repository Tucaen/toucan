import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'vitest'
import { createProjectPrettier } from '../src/main/project-prettier'

/**
 * A checkout with its own Prettier install, reached the way a real one is: `node_modules/prettier`
 * linked to this repo's copy, so the child resolves and runs a genuine Prettier rather than a stub.
 */
async function withProject(run: (root: string) => Promise<void>, options: { install?: boolean } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-project-prettier-'))
  try {
    if (options.install !== false) {
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await symlink(
        resolve(process.cwd(), 'node_modules', 'prettier'),
        join(root, 'node_modules', 'prettier'),
        'junction'
      )
    }
    await run(root)
  } finally {
    // An abandoned child is killed, not waited for, so on Windows it can still hold the directory
    // as its working directory for a moment after the save has already finished.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('runs an executable project configuration and formats with what it returns', async () => {
  await withProject(async (root) => {
    await writeFile(join(root, 'prettier.config.js'), 'module.exports = { semi: false, singleQuote: true }\n', 'utf8')
    const prettier = createProjectPrettier()

    const result = await prettier({
      path: join(root, 'index.ts'),
      content: 'const message = "hello";',
      root,
      lineEnding: 'lf'
    })

    assert.deepEqual(result, { ok: true, content: "const message = 'hello'\n" })
  })
})

test('reads the static formats Toucan has no reader for, because the real Prettier does', async () => {
  // `.prettierrc.toml` is the case where running the project's own Prettier is the *only* way to
  // get the answer: nothing in Toucan parses TOML.
  for (const [name, text] of [
    ['.prettierrc.toml', 'semi = false\nsingleQuote = true\n'],
    ['package.yaml', 'name: app\nprettier:\n  semi: false\n  singleQuote: true\n']
  ]) {
    await withProject(async (root) => {
      await writeFile(join(root, name), text, 'utf8')
      const prettier = createProjectPrettier()

      const result = await prettier({
        path: join(root, 'index.ts'),
        content: 'const message = "hello";',
        root,
        lineEnding: 'lf'
      })

      assert.deepEqual(result, { ok: true, content: "const message = 'hello'\n" }, `${name} was not honoured`)
    })
  }
})

test('the file keeps its own line ending, whatever the project configuration says', async () => {
  await withProject(async (root) => {
    await writeFile(join(root, 'prettier.config.js'), "module.exports = { endOfLine: 'lf' }\n", 'utf8')
    const prettier = createProjectPrettier()

    const result = await prettier({
      path: join(root, 'index.ts'),
      content: 'const values = { first: 1 }',
      root,
      lineEnding: 'crlf'
    })

    assert.equal(result.ok && result.content, 'const values = { first: 1 };\r\n')
  })
})

test('a checkout with no Prettier installed is reported rather than formatted with Toucan’s', async () => {
  await withProject(
    async (root) => {
      await writeFile(join(root, 'prettier.config.js'), 'module.exports = { semi: false }\n', 'utf8')
      const prettier = createProjectPrettier()

      const result = await prettier({
        path: join(root, 'index.ts'),
        content: 'const message = "hello";',
        root,
        lineEnding: 'lf'
      })

      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.reason, /no Prettier installed/)
    },
    { install: false }
  )
})

test('a configuration that throws is a reason, not a thrown save', async () => {
  await withProject(async (root) => {
    await writeFile(join(root, 'prettier.config.js'), "throw new Error('config is broken')\n", 'utf8')
    const prettier = createProjectPrettier()

    const result = await prettier({
      path: join(root, 'index.ts'),
      content: 'const message = "hello";',
      root,
      lineEnding: 'lf'
    })

    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /config is broken/)
  })
})

test('a configuration that never finishes is abandoned, so the save still completes', async () => {
  await withProject(async (root) => {
    await writeFile(join(root, 'prettier.config.js'), 'for (;;) {}\n', 'utf8')
    const prettier = createProjectPrettier({ timeoutMs: 750 })

    const result = await prettier({
      path: join(root, 'index.ts'),
      content: 'const message = "hello";',
      root,
      lineEnding: 'lf'
    })

    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /running it did not finish within 750ms/)
  })
})

test('the search for an install stops at the checkout it was given', async () => {
  await withProject(async (root) => {
    const nested = join(root, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'prettier.config.js'), 'module.exports = { semi: false }\n', 'utf8')
    const prettier = createProjectPrettier()

    // The install is at `root`, the file is two directories down: found by walking up, and the
    // walk would have left the checkout entirely had it not been bounded.
    const found = await prettier({ path: join(nested, 'index.ts'), content: 'const m = 1;', root, lineEnding: 'lf' })
    assert.deepEqual(found, { ok: true, content: 'const m = 1\n' })

    const bounded = await prettier({
      path: join(nested, 'index.ts'),
      content: 'const m = 1;',
      root: nested,
      lineEnding: 'lf'
    })
    assert.equal(bounded.ok, false)
  })
})
