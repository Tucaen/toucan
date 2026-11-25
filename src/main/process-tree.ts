/**
 * Ending what an agent session started. A session's adapter runs a provider CLI, which runs
 * tool shells, which start dev servers, watchers and build nodes. Killing the adapter alone ends
 * none of them on Windows, where a child never dies with its parent, so three mechanisms share
 * this module:
 *
 * - `killProcessTree` ends a live process and every descendant it still has a parent link to:
 *   what a session's stop does while its adapter is alive and the chain below it intact.
 * - `endOwnedProcesses` ends every process whose environment carries a launch's owner mark
 *   (`PROCESS_OWNER_ENV`): the orphans whose ancestors already died, wherever they work, proven to
 *   be the session's because only its adapter's descendants inherit that mark. What a ticket
 *   session's stop runs after the tree kill, in the background, whether or not a worktree goes.
 * - `releaseFolder` ends every process working in, or running a binary from, a folder about to be
 *   deleted, with its descendants. On Windows such a process is what makes the deletion fail,
 *   since its working directory holds the folder open, so this is the same cause a removal
 *   stumbles over. It matches by folder, not by owner, on purpose: a removal must free the folder
 *   whoever holds it, the user's own shell there included, or it fails half-way; the owner sweep
 *   at the session's stop has already ended what the session left, so this catches the rest.
 *
 * None touches a process outside its root's tree, the owner's marks or the folder, and neither
 * sweep ever ends Toucan itself; `releaseFolder` spares anything Toucan runs under too.
 */
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathWithinRoot } from '../shared/paths'
import { errorMessage } from '../shared/text'
import { hiddenProcessOptions } from './background-process'
import { createSerialQueue } from './serial-queue'

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

const PROCESS_QUERY_TIMEOUT_MS = 60_000
const PROCESS_QUERY_MAX_BUFFER = 16 * 1024 * 1024
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
 * are those of a 64-bit process, so a 32-bit one reports no working directory. The same memory
 * holds its environment, which `EndMarked` reads to end the processes carrying an owner mark; a
 * 32-bit process shows none, so it is never proven owned.
 */
const WINDOWS_PROCESS_HELPER_SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ToucanProcesses {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref BasicInformation information, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  const int QueryLimitedInformation = 0x1000, VmRead = 0x0010, Terminate = 0x0001, MaxEnvironment = 16 * 1024 * 1024;
  static byte[] Read(IntPtr process, long address, int size) {
    var buffer = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(process, new IntPtr(address), buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
    return buffer;
  }
  static bool Basic(IntPtr process, out BasicInformation information) {
    information = new BasicInformation(); int returned;
    return NtQueryInformationProcess(process, 0, ref information, Marshal.SizeOf(information), out returned) == 0;
  }
  /** The address of the process's RTL_USER_PROCESS_PARAMETERS, or 0 when it cannot be read. */
  static long Parameters(IntPtr process, long peb) {
    bool wow64;
    if (IntPtr.Size != 8 || !IsWow64Process(process, out wow64) || wow64) return 0;
    var parameters = Read(process, peb + 0x20, 8);
    return parameters == null ? 0 : BitConverter.ToInt64(parameters, 0);
  }
  static string WorkingDirectory(IntPtr process, long peb) {
    long parameters = Parameters(process, peb); if (parameters == 0) return "";
    var directory = Read(process, parameters + 0x38, 16); if (directory == null) return "";
    int length = BitConverter.ToUInt16(directory, 0); if (length == 0) return "";
    var text = Read(process, BitConverter.ToInt64(directory, 8), length);
    return text == null ? "" : Encoding.Unicode.GetString(text);
  }
  /** Whether one variable of the process's environment block is exactly one of the marks. */
  static bool Marked(IntPtr process, long peb, string[] marks) {
    long parameters = Parameters(process, peb); if (parameters == 0) return false;
    var address = Read(process, parameters + 0x80, 8); var size = Read(process, parameters + 0x3F0, 8);
    if (address == null || size == null) return false;
    long length = BitConverter.ToInt64(size, 0); if (length <= 0 || length > MaxEnvironment) return false;
    var block = Read(process, BitConverter.ToInt64(address, 0), (int)length); if (block == null) return false;
    foreach (var variable in Encoding.Unicode.GetString(block).Split((char)0))
      foreach (var mark in marks) if (string.Equals(variable, mark, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }
  /**
   * Ends every process whose environment carries one of the marks, but never the spared one nor this
   * PowerShell, and answers their PIDs. The check and the kill use one handle, which keeps the PID
   * from being given to another process in between. Up to the given passes, repeated while one
   * ends something.
   */
  public static string EndMarked(string[] marks, int spared, int passes) {
    var output = new StringBuilder();
    int self = Process.GetCurrentProcess().Id;
    for (int pass = 0; pass < passes; pass++) {
      bool ended = false;
      foreach (var listed in Process.GetProcesses()) {
        int pid = listed.Id; listed.Dispose();
        if (pid == 0 || pid == self || pid == spared) continue;
        IntPtr process = OpenProcess(QueryLimitedInformation | VmRead | Terminate, false, pid);
        if (process == IntPtr.Zero) continue;
        try {
          BasicInformation information;
          if (Basic(process, out information) && Marked(process, information.PebBaseAddress.ToInt64(), marks) && TerminateProcess(process, 1)) {
            output.Append(pid).Append((char)10); ended = true;
          }
        } finally { CloseHandle(process); }
      }
      if (!ended) break;
    }
    return output.ToString();
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
        BasicInformation information;
        if (!Basic(process, out information)) continue;
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

/** Compiles the helper above and prints what `call`, an expression on it, returns. */
const windowsHelperScript = (call: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    WINDOWS_PROCESS_HELPER_SOURCE.trim(),
    "'@",
    `[Console]::Out.Write([ToucanProcesses]::${call})`
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
      hiddenProcessOptions({ timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: PROCESS_QUERY_MAX_BUFFER }),
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(new Error(String(stderr).trim() || error.message), { stdout: String(stdout) }))
          : resolve(String(stdout))
    )
  })
}

/** Runs `call` on the compiled helper and answers what it printed. */
function runWindowsHelper(call: string): Promise<string> {
  // By full path: the helper runs code, so a `powershell.exe` earlier on PATH must not be it.
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const encoded = Buffer.from(windowsHelperScript(call), 'utf16le').toString('base64')
  return run(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ])
}

async function windowsSnapshot(): Promise<ProcessRecord[]> {
  return parseWindowsSnapshot(await runWindowsHelper('Snapshot()'))
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
 * The variable that marks what one adapter launch started. Set on the adapter alone, it is
 * inherited by every process below it - an orphan whose parents died included - and by nothing
 * the user starts. Its value is fresh per launch, so a relaunch never carries an earlier one's.
 */
export const PROCESS_OWNER_ENV = 'TOUCAN_PROCESS_OWNER'

const PROCESS_OWNER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** How often a sweep looks again after ending something, for what that had started meanwhile. */
const OWNED_SWEEP_PASSES = 3

/** A fresh owner for one adapter launch, the value of its `PROCESS_OWNER_ENV`. */
export function newProcessOwner(): string {
  return randomUUID()
}

/**
 * Ends whatever still carries one of the owners' marks - `endOwnedProcesses` below, injected
 * where a session stops so a test can watch it.
 */
export type OwnedProcessesEnd = (owners: readonly string[]) => Promise<unknown>

const marksOf = (owners: readonly string[]): Set<string> =>
  new Set(owners.map((owner) => `${PROCESS_OWNER_ENV}=${owner}`))

/**
 * Whether one of a process's environment `variables` is exactly the mark of one of `owners`.
 * @internal exported for tests
 */
export function environmentOwnedBy(variables: Iterable<string>, owners: readonly string[]): boolean {
  const marks = marksOf(owners)
  for (const variable of variables) if (marks.has(variable)) return true
  return false
}

/**
 * The PIDs in a `ps -A -wwwE -o pid=,command=` listing whose line holds one of the owners' marks
 * as a whole word - never `self`. `ps` prints the environment after the command line, so a mark
 * typed as an argument cannot be told apart; only the session's own processes know its value.
 * @internal exported for tests
 */
export function ownedInPsListing(listing: string, owners: readonly string[], options: { self: number }): number[] {
  const marks = marksOf(owners)
  const pids: number[] = []
  for (const line of listing.split('\n')) {
    const [pid, ...words] = line.trim().split(/\s+/)
    if (/^\d+$/.test(pid) && Number(pid) !== options.self && words.some((word) => marks.has(word)))
      pids.push(Number(pid))
  }
  return pids
}

/** Linux: each process's environment from `/proc`, read right before its kill. */
async function linuxOwnedPass(owners: readonly string[]): Promise<number[]> {
  const ended: number[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      if (!environmentOwnedBy((await readFile(`/proc/${name}/environ`, 'utf8')).split('\0'), owners)) continue
      process.kill(Number(name), 'SIGKILL')
      ended.push(Number(name))
    } catch {
      // Exited meanwhile, or another user's: unreadable is unproven.
    }
  }
  return ended
}

/**
 * macOS: every process's environment through `ps -E`, which shows the user's own processes'. Each
 * candidate is listed once more right before its kill, so the gap a reused PID could slip into is
 * one process's, not the whole listing's.
 */
async function macOwnedPass(owners: readonly string[]): Promise<number[]> {
  const listing = await run('ps', ['-A', '-wwwE', '-o', 'pid=,command='])
  const ended: number[] = []
  for (const pid of ownedInPsListing(listing, owners, { self: process.pid })) {
    const again = await run('ps', ['-wwwE', '-p', String(pid), '-o', 'pid=,command=']).catch(() => '')
    if (ownedInPsListing(again, owners, { self: process.pid }).includes(pid)) {
      ignoringExited(() => process.kill(pid, 'SIGKILL'))
      ended.push(pid)
    }
  }
  return ended
}

async function posixOwned(owners: readonly string[]): Promise<number[]> {
  const ended: number[] = []
  for (let pass = 0; pass < OWNED_SWEEP_PASSES; pass++) {
    const found = await (process.platform === 'linux' ? linuxOwnedPass(owners) : macOwnedPass(owners))
    ended.push(...found)
    if (found.length === 0) break
  }
  return ended
}

/** Windows: the helper checks each environment and terminates through the one handle it read it with. */
async function windowsOwned(owners: readonly string[]): Promise<number[]> {
  const marks = [...marksOf(owners)].map((mark) => `'${mark}'`).join(',')
  const output = await runWindowsHelper(`EndMarked(@(${marks}), ${process.pid}, ${OWNED_SWEEP_PASSES})`)
  return output
    .split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
}

/** One sweep for every owner gathered while it waited. */
async function sweepOwned(owners: readonly string[], log?: (message: string) => void): Promise<number[]> {
  try {
    const pids = await (process.platform === 'win32' ? windowsOwned(owners) : posixOwned(owners))
    if (pids.length > 0) log?.(`ended ${pids.length} process(es) a stopped session left running: ${pids.join(', ')}`)
    return pids
  } catch (error) {
    log?.(`could not look for processes a stopped session left running: ${errorMessage(error)}`)
    return []
  }
}

/** One sweep at a time, Windows compiling its helper for each. */
const enqueueSweep = createSerialQueue()
/** The sweep still waiting for its turn, which owners asked for meanwhile join. */
let waitingSweep: { owners: Set<string>; done: Promise<number[]> } | undefined

/**
 * Ends every process whose environment carries the mark of one of `owners` - what one session's
 * adapter launches started, wherever it works and whatever became of its parents - and answers
 * the PIDs the sweep that covered them ended. A process without that proof is never ended, nor is
 * Toucan itself. The proof is read from each live process, never from a PID remembered earlier;
 * on Windows the check and the kill share one process handle, so the PID cannot be reused in
 * between. Elsewhere the gap is the one between re-reading a process's environment and signalling
 * it. Sweeps run one at a time, and the owners of stops that come meanwhile share the next one,
 * so a window closing on many sessions starts one or two, not one each. Never rejects.
 */
export function endOwnedProcesses(owners: readonly string[], log?: (message: string) => void): Promise<number[]> {
  // Spliced into the helper's source on Windows: only what `newProcessOwner` makes gets there.
  const valid = owners.filter((owner) => PROCESS_OWNER_PATTERN.test(owner))
  if (valid.length === 0) return Promise.resolve([])
  if (!waitingSweep) {
    const gathered = new Set<string>()
    const done = enqueueSweep(() => {
      if (waitingSweep?.owners === gathered) waitingSweep = undefined
      return sweepOwned([...gathered], log)
    })
    waitingSweep = { owners: gathered, done }
  }
  for (const owner of valid) waitingSweep.owners.add(owner)
  return waitingSweep.done
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
