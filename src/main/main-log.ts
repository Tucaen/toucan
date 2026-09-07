import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Toucan.exe is a Windows GUI-subsystem app: a user who launches it from Explorer has no console, so
 * a main-process `console.warn` is invisible in exactly the scenario it was written for - which is
 * how a Claude usage-read failure shipped silently (#157). Every diagnostic `log` sink the main
 * process hands out therefore also appends to one file under the app's log directory.
 */

export interface MainLogOptions {
  file: string
  now?: () => Date
  /** The console mirror; kept so a developer under `npm run dev` still sees the line at once. */
  console?: (line: string) => void
  /** Size at which the file is rolled aside to `<file>.1`; one previous generation is kept. */
  maxBytes?: number
  /** Injected in tests; the default appends to `file`, creating its directory on first use. */
  append?: (file: string, line: string) => Promise<void>
}

export interface MainLog {
  /** One sink per subsystem; the scope is what lets a reader of the file tell them apart. */
  (scope: string): (message: string) => void
  /** Resolves once every line logged so far has been written or failed; only tests wait on it. */
  flush(): Promise<void>
}

/** Usage is polled for the life of the app, so one persistent failure must not grow the file without bound. */
const DEFAULT_MAX_BYTES = 1024 * 1024

/** Appends to `file`, first rolling it aside as `<file>.1` once it has outgrown `maxBytes`. */
async function appendToFile(file: string, line: string, maxBytes: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const size = await stat(file).then(
    (info) => info.size,
    () => 0
  )
  if (size >= maxBytes) await rename(file, `${file}.1`)
  await appendFile(file, line, 'utf8')
}

export function createMainLog(options: MainLogOptions): MainLog {
  const now = options.now ?? (() => new Date())
  const mirror = options.console ?? ((line) => console.warn(line))
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const append = options.append ?? ((file: string, line: string) => appendToFile(file, line, maxBytes))
  // Serialized so two subsystems failing at once cannot interleave half-lines in the file, and so a
  // write that fails never surfaces as an unhandled rejection - logging must not be a second fault.
  let pending: Promise<void> = Promise.resolve()
  const log = ((scope: string) => (message: string) => {
    const line = `[${scope}] ${message}`
    mirror(line)
    const stamped = `${now().toISOString()} ${line}\n`
    pending = pending.then(() => append(options.file, stamped)).catch(() => undefined)
  }) as MainLog
  log.flush = () => pending
  return log
}
