import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createPrettierFileFormatter } from '../src/main/file-formatter'
import type { ProjectPrettier } from '../src/main/project-prettier'

/**
 * What a checkout with no Prettier of its own reports. Most cases here are about what Toucan reads
 * from disk, and this is the state in which that reading is all there is.
 */
const uninstalled: ProjectPrettier = async () => ({
  ok: false,
  reason: 'this checkout has no Prettier installed to run it with'
})

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
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    const result = await formatter(source, 'const message = "hello";')

    assert.equal(result.content, "const message = 'hello'\n")
    assert.equal(result.warning, undefined)
  })
})

test('leaves ignored and unsupported files unchanged', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, '.prettierignore'), 'generated/\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })
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
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    const result = await formatter(source, 'a{color:red}')

    assert.equal(result.content, 'a {\n  color: red;\n}\n')
    assert.equal(result.warning, undefined)
  })
})

test('returns the original content and a warning when supported content cannot be formatted', async () => {
  await withRoot(async (root) => {
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })
    const invalid = 'a {'

    const result = await formatter(join(root, 'styles.css'), invalid)

    assert.equal(result.content, invalid)
    assert.match(result.warning ?? '', /Unclosed block|CssSyntaxError/i)
  })
})

test('honours every static configuration file name Prettier itself resolves', async () => {
  const cases: Array<[name: string, text: string]> = [
    ['.prettierrc', '{"semi":false,"singleQuote":true}'],
    ['.prettierrc', 'semi: false\nsingleQuote: true\n'],
    ['.prettierrc.yaml', 'semi: false\nsingleQuote: true\n'],
    ['.prettierrc.yml', '# style\nsemi: false\nsingleQuote: true\n'],
    ['.prettierrc.json5', '{\n  // style\n  semi: false,\n  singleQuote: true,\n}'],
    ['package.json', '{"name":"x","prettier":{"semi":false,"singleQuote":true}}']
  ]
  for (const [name, text] of cases) {
    await withRoot(async (root) => {
      await writeFile(join(root, name), text, 'utf8')
      const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

      const result = await formatter(join(root, 'index.ts'), 'const message = "hello";')

      assert.equal(result.warning, undefined, `${name} produced a warning`)
      assert.equal(result.content, "const message = 'hello'\n", `${name} was not honoured`)
    })
  }
})

test('a package.json with no prettier field does not stop the search at that directory', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'app', 'package.json'), '{"name":"app"}', 'utf8')
    await writeFile(join(root, '.prettierrc.yaml'), 'semi: false\nsingleQuote: true\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    const result = await formatter(join(root, 'app', 'index.ts'), 'const message = "hello";')

    assert.equal(result.content, "const message = 'hello'\n")
  })
})

test('a configuration file that cannot be parsed saves unformatted with a warning', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, '.prettierrc.yaml'), 'overrides:\n  - files: "*.ts"\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })
    const typed = 'const message = "hello";'

    const result = await formatter(join(root, 'index.ts'), typed)

    assert.equal(result.content, typed)
    assert.match(result.warning ?? '', /\.prettierrc\.yaml could not be read/)
  })
})

test('configuration Toucan will not run saves unformatted with a warning, never with defaults', async () => {
  for (const name of ['.prettierrc.js', 'prettier.config.mjs', '.prettierrc.toml']) {
    await withRoot(async (root) => {
      await writeFile(join(root, name), 'module.exports = { semi: false }\n', 'utf8')
      const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })
      const typed = 'const message = "hello"'

      const result = await formatter(join(root, 'index.ts'), typed)

      assert.equal(result.content, typed, `${name} was formatted with Prettier defaults`)
      assert.match(
        result.warning ?? '',
        new RegExp(`${name.replace(/\./g, '\.')} is configuration Toucan does not read`)
      )
    })
  }
})

test('configuration Toucan will not run is handed to the project’s own Prettier instead', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'prettier.config.js'), 'module.exports = { semi: false }\n', 'utf8')
    const asked: string[] = []
    const formatter = createPrettierFileFormatter({
      roots: async () => [root],
      projectPrettier: async ({ path, content, lineEnding }) => {
        asked.push(`${path} ${lineEnding}`)
        return { ok: true, content: `${content}\n// ran` }
      }
    })

    const result = await formatter(join(root, 'index.ts'), 'const message = "hello"', 'crlf')

    assert.equal(result.content, 'const message = "hello"\n// ran')
    assert.equal(result.warning, undefined)
    assert.deepEqual(asked, [`${join(root, 'index.ts')} crlf`])
  })
})

test('a save says both what could not be read and why running it did not work either', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'prettier.config.js'), 'module.exports = { semi: false }\n', 'utf8')
    const formatter = createPrettierFileFormatter({
      roots: async () => [root],
      projectPrettier: uninstalled
    })
    const typed = 'const message = "hello"'

    const result = await formatter(join(root, 'index.ts'), typed)

    assert.equal(result.content, typed)
    assert.equal(
      result.warning,
      'prettier.config.js is configuration Toucan does not read, and this checkout has no Prettier' +
        ' installed to run it with, so this file was saved exactly as you typed it.'
    )
  })
})

test('an ignored file is never handed to the project’s own Prettier', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'generated'), { recursive: true })
    await writeFile(join(root, 'prettier.config.js'), 'module.exports = {}\n', 'utf8')
    await writeFile(join(root, '.prettierignore'), 'generated/\n', 'utf8')
    let ran = false
    const formatter = createPrettierFileFormatter({
      roots: async () => [root],
      projectPrettier: async () => {
        ran = true
        return { ok: false, reason: 'unreachable' }
      }
    })

    const result = await formatter(join(root, 'generated', 'styles.css'), 'a{color:red}')

    assert.equal(result.content, 'a{color:red}')
    assert.equal(ran, false)
  })
})

test('an ignored file is still passed through quietly when the project configuration is unreadable', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'generated'), { recursive: true })
    await writeFile(join(root, '.prettierrc.js'), 'module.exports = {}\n', 'utf8')
    await writeFile(join(root, '.prettierignore'), 'generated/\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    const result = await formatter(join(root, 'generated', 'styles.css'), 'a{color:red}')

    assert.equal(result.content, 'a{color:red}')
    assert.equal(result.warning, undefined)
  })
})

test('honours .editorconfig, and lets the project Prettier file override it key by key', async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, '.editorconfig'),
      'root = true\n\n[*]\nindent_style = space\nindent_size = 8\nmax_line_length = 40\n\n[*.ts]\nquote_type = single\n',
      'utf8'
    )
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    const only = await formatter(join(root, 'index.ts'), 'const values = { first: "a", second: "b", third: "c" }')
    assert.equal(only.warning, undefined)
    assert.equal(only.content, "const values = {\n        first: 'a',\n        second: 'b',\n        third: 'c',\n};\n")

    // The project's own Prettier file wins where the two disagree, and only there.
    await writeFile(join(root, '.prettierrc.json'), '{"tabWidth":2}', 'utf8')
    const both = await formatter(join(root, 'index.ts'), 'const values = { first: "a", second: "b", third: "c" }')
    assert.equal(both.content, "const values = {\n  first: 'a',\n  second: 'b',\n  third: 'c',\n};\n")
  })
})

test('a .editorconfig section that does not match the file is not applied to it', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, '.editorconfig'), 'root = true\n\n[*.md]\nmax_line_length = 20\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    const result = await formatter(join(root, 'index.ts'), 'const values = { first: 1, second: 2 }')

    assert.equal(result.content, 'const values = { first: 1, second: 2 };\n')
  })
})

test('an .editorconfig that exists but cannot be read stops the save being formatted', async () => {
  await withRoot(async (root) => {
    // Present where the file should be, and not readable as one.
    await mkdir(join(root, '.editorconfig'), { recursive: true })
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })
    const typed = 'const message = "hello"'

    const result = await formatter(join(root, 'index.ts'), typed)

    assert.equal(result.content, typed)
    assert.match(result.warning ?? '', /\.editorconfig could not be read/)
  })
})

test('a package.yaml is read far enough to know whether it configures Prettier at all', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'package.yaml'), 'name: app\nversion: 1.0.0\n', 'utf8')
    await writeFile(join(root, '.prettierrc.yml'), 'semi: false\nsingleQuote: true\n', 'utf8')
    const formatter = createPrettierFileFormatter({ roots: async () => [root], projectPrettier: uninstalled })

    // No `prettier` block: not this project's configuration, so the search goes on past it.
    assert.equal((await formatter(join(root, 'index.ts'), 'const m = "x";')).content, "const m = 'x'\n")

    // With one, it is configuration Toucan cannot read - refused rather than silently skipped.
    await writeFile(join(root, 'package.yaml'), 'name: app\nprettier:\n  semi: false\n', 'utf8')
    const refused = await formatter(join(root, 'index.ts'), 'const m = "x";')
    assert.equal(refused.content, 'const m = "x";')
    assert.match(refused.warning ?? '', /package\.yaml could not be read/)
  })
})
