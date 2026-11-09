// What a packaged build must hold for the release to publish a working update. CI packages on
// every push and pull request (`npm run package:ci`), and scripts/verify-package.mjs reads dist/
// and feeds these rules, so a change that drops an installer, breaks the update feed or leaves an
// asarUnpack pattern matching nothing goes red on the change rather than in a shipped release.
// Pure, so the rules are testable without packaging.

const ARCH = 'x64'

function artifactName(template, version) {
  return template.replaceAll('${version}', version).replaceAll('${arch}', ARCH).replaceAll('${ext}', 'exe')
}

/** The files `npm run publish:win` uploads, in the names `build` gives them. */
export function releaseArtifacts(version, build) {
  const installer = artifactName(build.nsis.artifactName, version)
  return [installer, `${installer}.blockmap`, artifactName(build.portable.artifactName, version), 'latest.yml']
}

/** `key: value` lines at the top level of a small electron-builder YAML file. */
function topLevel(yaml) {
  return Object.fromEntries(
    [...yaml.matchAll(/^([A-Za-z]\w*): *(.*?) *$/gm)].map(([, key, value]) => [key, value.replace(/^'(.*)'$/, '$1')])
  )
}

/**
 * Everything wrong with a packaged build, or an empty list. `distFiles` is the names in dist/,
 * `latestYml` and `appUpdateYml` the update feed and the updater's own config (null when
 * missing), and `unpacked` how many files each `build.asarUnpack` pattern matched on disk.
 */
export function packageProblems({ version, build, distFiles, latestYml, appUpdateYml, hasAsar, unpacked }) {
  const problems = []
  const present = new Set(distFiles)
  for (const file of releaseArtifacts(version, build)) {
    if (!present.has(file)) problems.push(`dist/${file} was not produced; the release uploads it.`)
  }

  if (latestYml !== null) {
    const feed = topLevel(latestYml)
    const [installer] = releaseArtifacts(version, build)
    if (feed.version !== version) {
      problems.push(`latest.yml announces version ${feed.version}, not ${version}; updaters would misread it.`)
    }
    if (feed.path !== installer) {
      problems.push(`latest.yml points updaters at ${feed.path}, not ${installer}.`)
    }
  }

  if (appUpdateYml === null) {
    problems.push('resources/app-update.yml is missing; the packaged app could not find its update feed.')
  } else {
    const config = topLevel(appUpdateYml)
    for (const key of ['provider', 'owner', 'repo']) {
      if (config[key] !== build.publish[key]) {
        problems.push(
          `resources/app-update.yml has ${key} ${config[key]}, but build.publish says ${build.publish[key]}.`
        )
      }
    }
  }

  if (!hasAsar) problems.push('resources/app.asar is missing.')
  for (const pattern of build.asarUnpack) {
    if (!unpacked[pattern]) {
      problems.push(`asarUnpack pattern ${pattern} unpacked nothing; the app runs those files from disk.`)
    }
  }
  return problems
}
