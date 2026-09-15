import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createPrettierFileFormatter } from '../src/main/file-formatter'

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-file-formatter-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('formats supported files with the nearest static project configuration', async () => {
  await withRoot(async (root) => {
    const source = join(root, 'src', 'index.ts')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, '.prettierrc.json'), '{"semi":false,"singleQuote":true}', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root] })

    const result = await formatter(source, 'const message = "hello";')

    assert.equal(result.content, "const message = 'hello'\n")
    assert.equal(result.warning, undefined)
  })
})

test('leaves ignored and unsupported files unchanged', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, '.prettierignore'), 'generated/\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root] })
    const ignored = 'a{color:red}'
    const plain = 'keep   these   spaces'

    assert.equal((await formatter(join(root, 'generated', 'styles.css'), ignored)).content, ignored)
    assert.equal((await formatter(join(root, 'notes.txt'), plain)).content, plain)
  })
})

test('does not load plugins named by project configuration', async () => {
  await withRoot(async (root) => {
    const source = join(root, 'styles.css')
    await writeFile(join(root, '.prettierrc.json'), '{"plugins":["definitely-not-installed"]}', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root] })

    const result = await formatter(source, 'a{color:red}')

    assert.equal(result.content, 'a {\n  color: red;\n}\n')
    assert.equal(result.warning, undefined)
  })
})

test('returns the original content and a warning when supported content cannot be formatted', async () => {
  await withRoot(async (root) => {
    const formatter = createPrettierFileFormatter({ roots: async () => [root] })
    const invalid = 'a {'

    const result = await formatter(join(root, 'styles.css'), invalid)

    assert.equal(result.content, invalid)
    assert.match(result.warning ?? '', /Unclosed block|CssSyntaxError/i)
  })
})
