import type { AgentActivity } from "../../shared/agent";
import {
  asRecord,
  asText,
  memoizePerActivity,
  normalizeToolName,
} from "./tool-input";

/**
 * The three shapes a shell tool call comes in: the call that runs a command, and the two
 * follow-ups a *background* command gets - reading more of its output, and killing it. They share
 * one card because they share one identity (a command line), and a follow-up that names only a
 * shell id is unreadable on its own; see `indexShellLaunches`.
 */
export type ShellExecutionKind = "run" | "output" | "kill";

export interface ShellExecution {
  kind: ShellExecutionKind;
  /** The command as the agent asked for it. Absent on a follow-up, which names only a shell. */
  command?: string;
  /** Where it ran, when the adapter reported one (`terminal_info.cwd`, or Codex's `rawInput.cwd`). */
  cwd?: string;
  /** The command was launched detached and keeps running past the tool call. */
  background: boolean;
  /** The background shell this call started, or the one a follow-up targets. */
  shellId?: string;
  /** The agent's own one-line gloss on the command, when it wrote one. */
  description?: string;
  exitCode?: number;
  exitSignal?: string;
}

/** One labelled run of output lines. `output` is a stream the adapter did not separate. */
export interface ShellOutputBlock {
  stream: "stdout" | "stderr" | "output";
  lines: string[];
}

/**
 * The command line, however the adapter spelled it. Codex reports `command` as the argv it will
 * spawn in some versions and as a single string in others; both mean one command line.
 */
function commandFrom(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  if (typeof command === "string") return command || undefined;
  if (Array.isArray(command)) {
    const parts = command.filter(
      (part): part is string => typeof part === "string",
    );
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

const RUN_TOOLS = new Set(["bash", "shell", "run", "runcommand", "terminal"]);
const OUTPUT_TOOLS = new Set(["bashoutput", "shelloutput", "readbashoutput"]);
const KILL_TOOLS = new Set(["killshell", "killbash"]);

/**
 * The id of a background shell, as either follow-up tool names it. Claude Code spells it
 * `bash_id`, and its Kill tool `shell_id`; read both plus their camelCase spellings.
 */
function shellIdFrom(input: Record<string, unknown>): string | undefined {
  return (
    asText(input.bash_id) ??
    asText(input.bashId) ??
    asText(input.shell_id) ??
    asText(input.shellId) ??
    asText(input.id)
  );
}

const BACKGROUND_SHELL_ID = /\b(?:ID|id)[:=]?\s*([A-Za-z0-9_.:-]+)/;

/**
 * The shell id a backgrounded command reported for itself. There is no structured field for it:
 * the CLI announces the id in the tool result's prose ("Command running in background with ID:
 * bash_1"), and that string is the only thing tying the later output/kill calls back to this
 * command. A format change makes this return nothing, which costs the follow-up cards their
 * command reference and nothing else.
 */
export function backgroundShellIdFromOutput(
  text: string | undefined,
): string | undefined {
  if (!text) return undefined;
  const head = text.slice(0, 400);
  if (!/background/i.test(head)) return undefined;
  return BACKGROUND_SHELL_ID.exec(head)?.[1];
}

/**
 * Recognizes a shell call from what the adapter reported, preferring the tool's own name and
 * falling back to ACP's `execute` kind plus a command in `rawInput` (which is all codex-acp
 * sends). Returns `null` for anything whose card would be guessing - including an `execute` call
 * with no command to lead with - so those keep the generic card.
 */
export function parseShellExecution(
  activity: AgentActivity,
): ShellExecution | null {
  const input = asRecord(activity.rawInput) ?? {};
  const name = normalizeToolName(activity.toolName);
  const command = commandFrom(input);
  const exit = {
    ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
    ...(activity.exitSignal ? { exitSignal: activity.exitSignal } : {}),
  };

  if (name && (OUTPUT_TOOLS.has(name) || KILL_TOOLS.has(name))) {
    const shellId = shellIdFrom(input);
    return {
      kind: OUTPUT_TOOLS.has(name) ? "output" : "kill",
      background: true,
      ...(shellId ? { shellId } : {}),
      ...exit,
    };
  }

  const isRun = name ? RUN_TOOLS.has(name) : activity.kind === "execute";
  if (!isRun || !command) return null;

  const cwd =
    activity.terminalCwd ??
    asText(input.cwd) ??
    asText(input.workdir) ??
    asText(input.working_dir);
  const background =
    input.run_in_background === true || input.runInBackground === true;
  const shellId = backgroundShellIdFromOutput(shellOutputText(activity));
  return {
    kind: "run",
    command,
    background: background || shellId !== undefined,
    ...(cwd ? { cwd } : {}),
    ...(shellId ? { shellId } : {}),
    ...(asText(input.description)
      ? { description: asText(input.description) }
      : {}),
    ...exit,
  };
}

/** `parseShellExecution` for the render path, cached per activity object (`memoizePerActivity`). */
export const shellExecutionFor = memoizePerActivity(parseShellExecution);

const SHELL_ICONS: Record<ShellExecutionKind, string> = {
  run: ">_",
  output: "<<",
  kill: "x",
};

export function shellExecutionIcon(execution: ShellExecution): string {
  return SHELL_ICONS[execution.kind];
}

/** The longest command the summary puts into the DOM; a heredoc is not a header. */
const COMMAND_SUMMARY_LIMIT = 220;

/**
 * A command on one line. A multi-line command (a heredoc, a `&&` chain the agent wrapped) would
 * otherwise make the header as tall as the script, so newlines and runs of whitespace collapse to
 * single spaces and the rest is ellipsised here rather than only in CSS.
 */
export function shellCommandLine(command: string): string {
  const flattened = command.replace(/\s+/g, " ").trim();
  return flattened.length > COMMAND_SUMMARY_LIMIT
    ? `${flattened.slice(0, COMMAND_SUMMARY_LIMIT - 1)}…`
    : flattened;
}

/**
 * The exit chip: what the reader must see without expanding. A signal outranks a code, because a
 * killed command's code is synthesized. Absent while the command is still running, and absent
 * afterwards only when the adapter reported no status at all - the shell's own FAILED still shows.
 */
export function shellExitLabel(execution: ShellExecution): string | undefined {
  if (execution.exitSignal) return `signal ${execution.exitSignal}`;
  if (execution.exitCode !== undefined) return `exit ${execution.exitCode}`;
  return undefined;
}

/** Whether the exit chip reads as a success or a failure, so a non-zero exit is never quiet. */
export function shellExitTone(
  execution: ShellExecution,
  status: AgentActivity["status"],
): "ok" | "error" | undefined {
  if (execution.exitSignal) return "error";
  if (execution.exitCode !== undefined)
    return execution.exitCode === 0 ? "ok" : "error";
  return status === "failed" ? "error" : undefined;
}

/**
 * Renders a directory relative to the deepest root that contains it, and reports nothing at all
 * when it *is* the node's own working directory - the summary only shows a cwd that tells the
 * reader something they could not assume. Comparison is separator- and case-insensitive because
 * the same checkout reaches an agent under either drive-letter case and either slash.
 */
export function shellWorkingDirectoryLabel(
  cwd: string | undefined,
  roots: readonly (string | undefined)[],
): string | undefined {
  if (!cwd) return undefined;
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const haystack = normalized.toLowerCase();
  const nodeRoot = roots[0]
    ?.replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (nodeRoot && haystack === nodeRoot) return undefined;
  for (const root of roots) {
    const prefix = root?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!prefix || !haystack.startsWith(`${prefix}/`)) continue;
    return normalized.slice(prefix.length + 1);
  }
  return normalized;
}

// Matches CSI/OSC sequences and the stray escapes a truncated stream leaves behind. Output reaches
// the DOM as text, so an unstripped sequence would be shown to the reader verbatim.
const ANSI_SEQUENCE = new RegExp(
  [
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    "\\u001B[[\\]()#;?][0-9;?]*[\\u0020-\\u002F]*[\\u0040-\\u007E]",
    "\\u001B[\\u0040-\\u005A\\u005C-\\u005F]",
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  ].join("|"),
  "g",
);

/**
 * Strips the control bytes a terminal would have consumed rather than shown: ANSI colour and
 * cursor sequences, and the carriage returns a progress bar uses to rewrite its line - only the
 * final state of such a line is meaningful, and keeping every rewrite would show one download as
 * a hundred lines.
 */
export function normalizeTerminalOutput(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, "")
    .split("\n")
    .map((line) => {
      const withoutTrailing = line.replace(/\r+$/, "");
      if (!withoutTrailing.includes("\r")) return withoutTrailing;
      const segments = withoutTrailing.split("\r");
      return segments.at(-1) || segments.filter(Boolean).at(-1) || "";
    })
    .join("\n");
}

const CONSOLE_FENCE = /^```(?:console|bash|sh)?\n([\s\S]*?)\n?```$/;

/** ACP's placeholder for content it moved to the terminal channel; never worth rendering. */
const TERMINAL_PLACEHOLDER = "Terminal output is available.";

/**
 * Where a shell card's output actually lives, in order of fidelity: the terminal channel both
 * adapters stream through, then Codex's aggregated `formatted_output`, then ACP content - which
 * for an older or replay-fed adapter is the whole output wrapped in a code fence, and for the
 * background follow-up tools is the only source there is.
 */
export function shellOutputText(activity: AgentActivity): string | undefined {
  if (activity.terminalOutput) return activity.terminalOutput;
  const rawOutput = asRecord(activity.rawOutput);
  const formatted = asText(rawOutput?.formatted_output);
  if (formatted) return formatted;
  const content = activity.content;
  if (!content || content === TERMINAL_PLACEHOLDER) return undefined;
  return CONSOLE_FENCE.exec(content.trim())?.[1] ?? content;
}

function outputLines(text: string): string[] {
  const normalized = normalizeTerminalOutput(text).replace(/\n+$/, "");
  return normalized ? normalized.split("\n") : [];
}

/**
 * The body of a shell card, as data. stdout and stderr are separated only when the adapter
 * actually reported them apart (a `bash_code_execution_result`); claude-agent-acp merges the two
 * before ACP sees them, so the honest rendering of everything else is one unlabelled stream
 * rather than a guess about which line came from where.
 */
export function shellOutputBlocks(activity: AgentActivity): ShellOutputBlock[] {
  const rawOutput = asRecord(activity.rawOutput);
  const stdout =
    typeof rawOutput?.stdout === "string" ? rawOutput.stdout : undefined;
  const stderr =
    typeof rawOutput?.stderr === "string" ? rawOutput.stderr : undefined;
  if (stdout !== undefined || stderr !== undefined) {
    return [
      { stream: "stdout" as const, lines: outputLines(stdout ?? "") },
      { stream: "stderr" as const, lines: outputLines(stderr ?? "") },
    ].filter((block) => block.lines.length > 0);
  }
  const text = shellOutputText(activity);
  if (!text) return [];
  const lines = outputLines(text);
  return lines.length > 0 ? [{ stream: "output", lines }] : [];
}

/**
 * Bounds what reaches the DOM the way the shell expects (see `truncateToolOutput`): output is
 * handed out oldest-first until the budget runs out, a block left with nothing is dropped rather
 * than rendered as an empty heading, and the remainder is counted for "show more".
 */
export function clampShellOutputBlocks(
  blocks: ShellOutputBlock[],
  budget: number | null,
): { blocks: ShellOutputBlock[]; hiddenLines: number } {
  if (budget === null) return { blocks, hiddenLines: 0 };
  const kept: ShellOutputBlock[] = [];
  let remaining = Math.max(0, budget);
  let hiddenLines = 0;
  for (const block of blocks) {
    if (remaining <= 0) {
      hiddenLines += block.lines.length;
      continue;
    }
    const lines = block.lines.slice(0, remaining);
    hiddenLines += block.lines.length - lines.length;
    remaining -= lines.length;
    kept.push(
      lines.length === block.lines.length ? block : { ...block, lines },
    );
  }
  return { blocks: kept, hiddenLines };
}

/** The command a background shell was started by, for the follow-up calls that only have its id. */
export interface ShellLaunch {
  activityId: string;
  command: string;
}

/**
 * Which command started which background shell, across a whole worklog. A `BashOutput` or
 * `KillShell` call carries nothing but a shell id, so on its own its card can only say
 * "bash_1" - useless a screen away from the command it belongs to. This is the index that lets
 * those cards name the command instead, and it is keyed on the id the launching call reported for
 * itself, never on ordering, so an unmatched follow-up simply stays unlabelled.
 */
export function indexShellLaunches(
  activities: readonly AgentActivity[],
): Map<string, ShellLaunch> {
  const launches = new Map<string, ShellLaunch>();
  for (const activity of activities) {
    const execution = shellExecutionFor(activity);
    if (execution?.kind !== "run" || !execution.shellId || !execution.command)
      continue;
    launches.set(execution.shellId, {
      activityId: activity.id,
      command: execution.command,
    });
  }
  return launches;
}
