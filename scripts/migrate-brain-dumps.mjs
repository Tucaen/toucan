import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { app } from 'electron'

const require = createRequire(import.meta.url)
const { migrateBrainDumps } = require('../.test-out/src/main/brain-dump-migration.js')

await app.whenReady()
const destinationFlag = process.argv.indexOf('--destination')
const sourceFlag = process.argv.indexOf('--source')
const rootDirectory =
  destinationFlag >= 0 && process.argv[destinationFlag + 1]
    ? resolve(process.argv[destinationFlag + 1])
    : join(app.getPath('userData'), 'brain-dumps')
const sourceDirectory =
  sourceFlag >= 0 && process.argv[sourceFlag + 1] ? resolve(process.argv[sourceFlag + 1]) : resolve('docs/brain-dumps')

const result = await migrateBrainDumps({
  sourceDirectory,
  rootDirectory,
  onPlan: (plan) => {
    console.log('Migration plan:')
    for (const line of plan) console.log(`  ${line}`)
  }
})
for (const slug of result.imported) console.log(`Imported: ${slug}`)
for (const slug of result.skipped) console.error(`Skipped (already exists): ${slug}`)
for (const failure of result.failed) console.error(`Failed: ${failure.path}: ${failure.message}`)
app.quit()
process.exitCode = result.ok ? 0 : 1
