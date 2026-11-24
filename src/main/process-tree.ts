/**
 * Ending what an agent session started. A session's adapter runs a provider CLI, which runs
 * tool shells, which start dev servers, watchers and build nodes. Killing the adapter alone ends
 * none of them on Windows, where a child never dies with its parent, so two mechanisms share this
 * module:
 *
 * - `killProcessTree` ends a live process and every descendant it still has a parent link to:
 *   what a session's stop does while its adapter is alive and the chain below it intact.
 * - `releaseFolder` ends every process working in, or running a binary from, a folder about to be
 *   deleted, with its descendants: the orphans whose ancestors already died, which no parent link
 *   reaches any more. On Windows such a process is also what makes the deletion fail, since its
 *   working directory holds the folder open, so this is the same cause a removal stumbles over.
 *
 * Neither touches a process outside its root's tree or the folder, and `releaseFolder` never ends
 * Toucan itself or anything Toucan runs under.
 */
import { execFile, execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathWithinRoot } from '../shared/paths'
import { errorMessage } from '../shared/text'
import { hiddenProcessOptions } from './background-process'

export interface ProcessRecord {
  pid: number
  ppid: number
  /** Start time in a platform-specific unit, comparable only within one snapshot; absent when unreadable. */
  started?: number
  /** Working directory; absent when the OS would not tell. */
  cwd?: string
  /** Image path; absent when the OS would not tell. */
  executable?: string
}

const SNAPSHOT_TIMEOUT_MS = 60_000
const SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024
/** `taskkill` takes one `/PID` pair per process; this keeps one command line well inside 32 767 characters. */
const TASKKILL_BATCH = 200
/** How long a teardown may block on its one process listing or `taskkill`. */
const TEARDOWN_TIMEOUT_MS = 10_000
/** Every process with its parent, as `ps` lists it outside Windows and Linux's `/proc`. */
const PS_PARENT_LINKS = ['-A', '-o', 'pid=,ppid=']

/**
 * Ends whatever still runs in a folder about to be deleted - `releaseFolder` below, injected
 * where a folder is deleted so a test can watch the order.
 */
export type FolderRelease = (folder: string) => Promise<unknown>

/**
 * Whether `child` can have been started by `parent`. A PID names a parent only while that parent
 * lives: Windows keeps the dead parent's PID on an orphan, and that PID may since have been given to
 * an unrelated process - which then started *after* the orphan did.
 */
function plausibleParent(parent: ProcessRecord | undefined, child: ProcessRecord): boolean {
  return parent?.started === undefined || child.started === undefined || child.started >= parent.started
}

/**
 * Every process below `roots` by parent links, roots excluded.
 * @internal exported for tests
 */
export function descendantsOf(table: readonly ProcessRecord[], roots: Iterable<number>): number[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]))
  const children = new Map<number, ProcessRecord[]>()
  for (const entry of table) {
    if (entry.ppid === entry.pid) continue
    const siblings = children.get(entry.ppid) ?? []
    siblings.push(entry)
    children.set(entry.ppid, siblings)
  }
  const seen = new Set<number>(roots)
  const pending = [...seen]
  const found: number[] = []
  while (pending.length > 0) {
    const pid = pending.pop()!
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid) || !plausibleParent(byPid.get(pid), child)) continue
      seen.add(child.pid)
      found.push(child.pid)
      pending.push(child.pid)
    }
  }
  return found
}

/** `self` and every process it runs under. */
function ancestryOf(table: readonly ProcessRecord[], self: number): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]))
  const chain = new Set<number>([self])
  let current = byPid.get(self)
  while (current && !chain.has(current.ppid)) {
    const parent = byPid.get(current.ppid)
    if (!parent || !plausibleParent(parent, current)) break
    chain.add(parent.pid)
    current = parent
  }
  return chain
}

/** The comparable form of an OS-reported path: no `\\?\` prefix, which `pathWithinRoot` would read as UNC. */
function osPath(path: string): string {
  return path.replace(/^\\\\\?\\(UNC\\)?/i, (_prefix, unc: string | undefined) => (unc ? '\\\\' : ''))
}

const inside = (path: string | undefined, folder: string): boolean =>
  path !== undefined && pathWithinRoot(osPath(path), osPath(folder)) !== undefined

/**
 * The processes working in `folder` or running a binary from it, plus all their descendants -
 * never `self` nor an ancestor of it.
 * @internal exported for tests
 */
export function processesInside(table: readonly ProcessRecord[], folder: string, options: { self: number }): number[] {
  const spared = ancestryOf(table, options.self)
  const matched = table
    .filter((entry) => inside(entry.cwd, folder) || inside(entry.executable, folder))
    .map((entry) => entry.pid)
  return [...new Set([...matched, ...descendantsOf(table, matched)])].filter((pid) => !spared.has(pid))
}

/**
 * Lists every process with its parent, start time, working directory and image through the Win32
 * API, compiled once per call by PowerShell. A working directory lives only in the process's own
 * memory (its PEB), which neither WMI nor any shipped tool reports; reading it needs the same
 * rights the user has over their own processes and yields nothing for anyone else's. The offsets
 * are those of a 64-bit process, so a 32-bit one reports no working directory.
 */
const WINDOWS_SNAPSHOT_SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ToucanProcessSnapshot {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref BasicInformation information, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  const int QueryLimitedInformation = 0x1000, VmRead = 0x0010;
  static byte[] Read(IntPtr process, long address, int size) {
    var buffer = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(process, new IntPtr(address), buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
    return buffer;
  }
  static string WorkingDirectory(IntPtr process, long peb) {
    bool wow64;
    if (IntPtr.Size != 8 || !IsWow64Process(process, out wow64) || wow64) return "";
    var parameters = Read(process, peb + 0x20, 8); if (parameters == null) return "";
    var directory = Read(process, BitConverter.ToInt64(parameters, 0) + 0x38, 16); if (directory == null) return "";
    int length = BitConverter.ToUInt16(directory, 0); if (length == 0) return "";
    var text = Read(process, BitConverter.ToInt64(directory, 8), length);
    return text == null ? "" : Encoding.Unicode.GetString(text);
  }
  public static string Snapshot() {
    var output = new StringBuilder();
    char tab = (char)9, newline = (char)10;
    foreach (var listed in Process.GetProcesses()) {
      int pid = listed.Id; listed.Dispose();
      if (pid == 0) continue;
      IntPtr process = OpenProcess(QueryLimitedInformation | VmRead, false, pid);
      bool readable = process != IntPtr.Zero;
      if (!readable) process = OpenProcess(QueryLimitedInformation, false, pid);
      if (process == IntPtr.Zero) continue;
      try {
        var information = new BasicInformation(); int returned;
        if (NtQueryInformationProcess(process, 0, ref information, Marshal.SizeOf(information), out returned) != 0) continue;
        long created, exited, kernel, user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) created = 0;
        var image = new StringBuilder(32768); int size = image.Capacity;
        string executable = QueryFullProcessImageName(process, 0, image, ref size) ? image.ToString(0, size) : "";
        string directory = readable ? WorkingDirectory(process, information.PebBaseAddress.ToInt64()) : "";
        output.Append(pid).Append(tab).Append(information.InheritedFromUniqueProcessId.ToInt64()).Append(tab)
          .Append(created).Append(tab).Append(executable).Append(tab).Append(directory).Append(newline);
      } finally { CloseHandle(process); }
    }
    return output.ToString();
  }
}
`

const WINDOWS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  WINDOWS_SNAPSHOT_SOURCE.trim(),
  "'@",
  '[Console]::Out.Write([ToucanProcessSnapshot]::Snapshot())'
].join('\n')

/**
 * Rows of `pid ppid created executable cwd`, tab-separated: Windows forbids tabs and line breaks
 * in paths, so no field can split a row. A start time of 0 or an empty path means unreadable.
 * @internal exported for tests
 */
export function parseWindowsSnapshot(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = []
  for (const line of output.split(/\r?\n/)) {
    const [pid, ppid, started, executable, cwd] = line.split('\t')
    if (cwd === undefined || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue
    records.push({
      pid: Number(pid),
      ppid: Number(ppid),
      ...(/^\d+$/.test(started) && started !== '0' ? { started: Number(started) } : {}),
      ...(executable ? { executable } : {}),
      ...(cwd ? { cwd } : {})
    })
  }
  return records
}

/** Rejects on a non-zero exit with what the command printed still on the error, as `stdout`. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      hiddenProcessOptions({ timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_BUFFER }),
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(new Error(String(stderr).trim() || error.message), { stdout: String(stdout) }))
          : resolve(String(stdout))
    )
  })
}

async function windowsSnapshot(): Promise<ProcessRecord[]> {
  // By full path: the snapshot runs code, so a `powershell.exe` earlier on PATH must not be it.
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const encoded = Buffer.from(WINDOWS_SNAPSHOT_SCRIPT, 'utf16le').toString('base64')
  return parseWindowsSnapshot(
    await run(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ])
  )
}

async function linuxSnapshot(): Promise<ProcessRecord[]> {
  const records: ProcessRecord[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8')
      // The command name is parenthesised and may hold spaces or parentheses itself.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const [cwd, executable] = await Promise.all(
        ['cwd', 'exe'].map((link) => readlink(`/proc/${name}/${link}`).catch(() => undefined))
      )
      records.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        started: Number(fields[19]),
        ...(cwd ? { cwd } : {}),
        ...(executable ? { executable } : {})
      })
    } catch {
      // Exited while being read.
    }
  }
  return records
}

async function macSnapshot(): Promise<ProcessRecord[]> {
  const records = parentLinks(await run('ps', PS_PARENT_LINKS))
  // `-F pn` prints a `p<pid>` line, then an `n<path>` line for the cwd that `-d cwd` selects.
  // lsof exits 1 when some process could not be read, yet still prints the rest.
  const listing = await run('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-w']).catch(
    (error: Error & { stdout?: string }) => error.stdout ?? ''
  )
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined) cwds.set(pid, line.slice(1))
  }
  return records.map((entry) => (cwds.has(entry.pid) ? { ...entry, cwd: cwds.get(entry.pid)! } : entry))
}

function parentLinks(output: string): ProcessRecord[] {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
    .map(([pid, ppid]) => ({ pid, ppid }))
}

/** Every process the user may see, best-effort per process. */
function snapshotProcesses(): Promise<ProcessRecord[]> {
  if (process.platform === 'win32') return windowsSnapshot()
  if (process.platform === 'linux') return linuxSnapshot()
  return macSnapshot()
}

/** Runs one kill; a process that has already exited is what was wanted anyway. */
function ignoringExited(kill: () => unknown): void {
  try {
    kill()
  } catch {
    // Already exited.
  }
}

/** `/PID` pairs for `taskkill`, which takes one per process. */
const taskkillTargets = (pids: readonly number[]): string[] => pids.flatMap((pid) => ['/PID', String(pid)])

/** Runs `taskkill` and answers whether it reported success; never rejects. */
function taskkill(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('taskkill', args, hiddenProcessOptions({}), (error) => resolve(!error))
    } catch {
      resolve(false)
    }
  })
}

/** Ends `pids` outright. */
async function terminate(pids: readonly number[]): Promise<void> {
  if (process.platform === 'win32') {
    for (let start = 0; start < pids.length; start += TASKKILL_BATCH) {
      await taskkill(['/F', ...taskkillTargets(pids.slice(start, start + TASKKILL_BATCH))])
    }
    return
  }
  for (const pid of pids) ignoringExited(() => process.kill(pid, 'SIGKILL'))
}

/**
 * The long form of a Windows path reported in 8.3 form (`TOBIAS~1`), so both spellings of one
 * folder compare equal; any other path, or one that no longer exists, is returned as it is.
 */
function longForm(path: string | undefined): string | undefined {
  if (process.platform !== 'win32' || !path?.includes('~')) return path
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Ends every process working in `folder` or running a binary from it, and their descendants, and
 * answers their PIDs. Never throws: a folder nothing could be learned about is left to the
 * deletion, which then reports what holds it.
 */
export async function releaseFolder(folder: string, log?: (message: string) => void): Promise<number[]> {
  try {
    const table = (await snapshotProcesses()).map((entry) => ({
      ...entry,
      cwd: longForm(entry.cwd),
      executable: longForm(entry.executable)
    }))
    const pids = processesInside(table, longForm(folder)!, { self: process.pid })
    if (pids.length > 0) {
      log?.(`ending ${pids.length} process(es) left running in ${folder}: ${pids.join(', ')}`)
      await terminate(pids)
    }
    return pids
  } catch (error) {
    log?.(`could not look for processes running in ${folder}: ${errorMessage(error)}`)
    return []
  }
}

/**
 * `taskkill /T /F` on one live Windows process: it and every descendant it still has a parent
 * link to. Answers whether taskkill reported success; never rejects.
 */
export function taskkillTree(pid: number): Promise<boolean> {
  return taskkill([...taskkillTargets([pid]), '/T', '/F'])
}

/** What `killProcessTree` needs of a child: its PID, and its own kill as the fallback. */
export interface KillableProcess {
  readonly pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * Ends `child` and everything below it without blocking, settling once done; never rejects. The
 * tree is read from the live root, so the root is never killed first. Not for a path Toucan exits
 * right after: Node ties every direct child to a job that ends with Toucan, the root among them,
 * and a walk that starts after that finds nothing below it - `killProcessTreesNow` is for teardown.
 */
export async function killProcessTree(child: KillableProcess, name: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.pid !== undefined && process.platform === 'win32') {
    // `taskkill /T` walks the tree itself. A failure is usually a root that has already exited;
    // its own kill below is then a no-op.
    if (await taskkillTree(child.pid)) return
  } else if (child.pid !== undefined) {
    // Read before anything is signalled: a killed parent's children are re-parented at once.
    const table = await run('ps', PS_PARENT_LINKS).then(parentLinks, () => [])
    for (const pid of descendantsOf(table, [child.pid])) ignoringExited(() => process.kill(pid, name))
  }
  ignoringExited(() => child.kill(name))
}

/**
 * Ends every one of `children` and everything below them before returning: what a window closing
 * or Toucan quitting does, since nothing runs after it. Blocks for one process listing (one
 * `taskkill` on Windows) however many trees there are. Elsewhere the tree is read before anything
 * is signalled, because a killed parent's children are re-parented at once.
 */
export function killProcessTreesNow(children: readonly KillableProcess[], name: NodeJS.Signals = 'SIGTERM'): void {
  const pids = children.flatMap((child) => (child.pid === undefined ? [] : [child.pid]))
  if (pids.length > 0 && process.platform === 'win32') {
    try {
      execFileSync(
        'taskkill',
        ['/T', '/F', ...taskkillTargets(pids)],
        hiddenProcessOptions({ stdio: 'ignore', timeout: TEARDOWN_TIMEOUT_MS })
      )
    } catch {
      // A root that has already exited fails the whole run; the kills below cover the roots.
    }
  } else if (pids.length > 0) {
    let descendants: number[] = []
    try {
      const listing = execFileSync(
        'ps',
        PS_PARENT_LINKS,
        hiddenProcessOptions({ encoding: 'utf8', timeout: TEARDOWN_TIMEOUT_MS })
      )
      descendants = descendantsOf(parentLinks(listing), pids)
    } catch {
      // No process listing: the roots alone are what can still be ended.
    }
    for (const descendant of descendants) ignoringExited(() => process.kill(descendant, name))
  }
  for (const child of children) ignoringExited(() => child.kill(name))
}
