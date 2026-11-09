import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageProblems } from './packaged-build.mjs'

// Checks the build `npm run package:ci` just left in dist/ against what the release publishes
// (scripts/packaged-build.mjs has the rules). CI runs it after packaging; it needs nothing but dist/.
//
//   node scripts/check-package.mjs

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const dist = manifest.build.directories.output
const resources = join(dist, 'win-unpacked', 'resources')
const unpackedRoot = join(resources, 'app.asar.unpacked')

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

const problems = packageProblems({
  version: manifest.version,
  build: manifest.build,
  distFiles: existsSync(dist) ? readdirSync(dist) : [],
  latestYml: readIfPresent(join(dist, 'latest.yml')),
  appUpdateYml: readIfPresent(join(resources, 'app-update.yml')),
  hasAsar: existsSync(join(resources, 'app.asar')),
  unpacked: Object.fromEntries(
    manifest.build.asarUnpack.map((pattern) => [
      pattern,
      existsSync(unpackedRoot) ? globSync(pattern, { cwd: unpackedRoot }).length : 0
    ])
  )
})

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-package: ${problem}`)
  process.exit(1)
}
console.log(`check-package: ${dist}/ holds everything release ${manifest.version} publishes.`)
