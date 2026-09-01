import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as ts from 'typescript'
import { hiddenProcessOptions } from '../src/main/background-process'

test('background process options cannot re-enable Windows command windows', () => {
  assert.deepEqual(hiddenProcessOptions({ cwd: 'D:\\Development\\Toucan', windowsHide: false }), {
    cwd: 'D:\\Development\\Toucan',
    windowsHide: true
  })
})

test('production child-process launchers use the shared hidden-window policy', () => {
  const mainDirectory = join(process.cwd(), 'src', 'main')
  const launchers = readdirSync(mainDirectory).filter((file) => {
    if (!file.endsWith('.ts')) return false
    return /from 'node:child_process'/.test(readFileSync(join(mainDirectory, file), 'utf8'))
  })

  for (const launcher of launchers) {
    const source = readFileSync(join(mainDirectory, launcher), 'utf8')
    const tree = ts.createSourceFile(launcher, source, ts.ScriptTarget.Latest, true)
    const childProcessImports = new Set<string>()
    const childProcessNamespaces = new Set<string>()
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.getText(tree) !== "'node:child_process'")
        continue
      if (statement.importClause?.isTypeOnly) continue
      if (statement.importClause?.name) childProcessNamespaces.add(statement.importClause.name.text)
      if (statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
        childProcessNamespaces.add(statement.importClause.namedBindings.name.text)
      }
      for (const element of statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
        : []) {
        if (!element.isTypeOnly) childProcessImports.add(element.name.text)
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        childProcessImports.has(node.expression.text)
      ) {
        assert.match(node.getText(tree), /hiddenProcessOptions\(/, `${launcher} bypasses the hidden-window policy`)
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        childProcessNamespaces.has(node.expression.expression.text)
      ) {
        assert.match(node.getText(tree), /hiddenProcessOptions\(/, `${launcher} bypasses the hidden-window policy`)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
})
