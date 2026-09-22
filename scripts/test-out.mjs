import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Where a plain-node script reaches Toucan's own TypeScript.
 *
 * `npm run build:test-out` emits a CommonJS build of the entry points named in
 * `tsconfig.test.json` into `.test-out`; this turns a source-relative path into the URL
 * `await import()` wants. A file URL rather than a bare path because an absolute Windows path
 * ("C:\\...") is not a valid ES module specifier.
 *
 * Four scripts had their own copy of this one line (#230). Adding a script that reads `.test-out`
 * means adding its entry point to `tsconfig.test.json`, or the import resolves against a file that
 * was never built.
 */
export function testOut(path) {
  return pathToFileURL(join(process.cwd(), '.test-out', path)).href
}
