import { Codex } from "@openai/codex-sdk";

const COORDINATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["answer", "delegate"] },
    message: { type: "string" },
    tasks: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } }
        },
        required: ["title", "objective", "acceptanceCriteria"]
      }
    }
  },
  required: ["mode", "message", "tasks"]
};

const TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "needs_clarification"] },
    summary: { type: "string" },
    activities: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    question: { type: ["string", "null"] },
    detail: { type: ["string", "null"] }
  },
  required: ["status", "summary", "activities", "question", "detail"]
};

/** Commands through which a task drives another agent turn inside its own thread. */
const SUBAGENT_COMMAND = /(^|[\\/\s"'])(codex|claude|gemini|opencode)(\.exe)?\s+(exec|resume|run|-p\b)/i;

/** The collapsed card and the Coordinator line share this budget; the runtime enforces it. */
const SUMMARY_CHARACTERS = 160;

function projectContextText(context) {
  const snippets = context.snippets
    .map((snippet) => `--- ${snippet.path} ---\n${snippet.contents}`)
    .join("\n\n");
  return `Project root: ${context.root}\nFiles (${context.files.length}${context.truncated ? "+" : ""}):\n${context.files.join("\n")}\n\nSelected file excerpts:\n${snippets}`;
}

function taskOverviewText(tasks) {
  if (!tasks?.length) return "No task cards exist yet.";
  return tasks
    .map((task) => `- ${task.id} “${task.title}” [${task.status}]: ${task.summary}`)
    .join("\n");
}

function parseStructuredResponse(response) {
  try {
    return JSON.parse(response);
  } catch {
    throw new Error("Codex returned a response that did not match the requested JSON structure.");
  }
}

function friendlyCodexError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not logged in|login required|unauthorized|401/i.test(message)) {
    return new Error("Codex subscription sign-in is required. Run `npm run login`, sign in with the same ChatGPT account, then retry.");
  }
  return error instanceof Error ? error : new Error(message);
}

function firstLine(text, limit = 80) {
  const line = String(text ?? "").split("\n")[0].trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Maps one Codex stream event to owner-visible activity for the task that owns the thread.
 * Every internal step, including a nested agent invocation, belongs to that one task; the
 * `subagent` kind only labels the activity so the card can keep it out of its headline.
 */
function activityForEvent(event) {
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = event.item;
  const started = event.type === "item.started";

  if (item.type === "command_execution") {
    if (SUBAGENT_COMMAND.test(item.command)) {
      return started
        ? { kind: "subagent", text: `Started an internal agent step: ${firstLine(item.command)}` }
        : { kind: "subagent", text: `An internal agent step ${item.status === "completed" ? "finished" : "failed"}.` };
    }
    if (started) return { kind: "internal", text: "Inspecting the Project through the read-only Codex sandbox." };
    return {
      kind: "internal",
      text: item.status === "completed"
        ? "Completed a read-only Project inspection step."
        : "A read-only Project inspection step failed."
    };
  }
  if (started) return null;
  if (item.type === "mcp_tool_call") {
    return { kind: "internal", text: `Called the ${item.server}/${item.tool} tool.` };
  }
  if (item.type === "file_change") {
    // The sandbox forbids writes, so an actual file change must be visible rather than dropped.
    return { kind: "internal", text: `Reported ${item.changes.length} file change(s) despite the read-only sandbox.` };
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((entry) => entry.completed).length;
    return { kind: "internal", text: `Updated the work plan: ${completed}/${item.items.length} steps complete.` };
  }
  if (item.type === "error") return { kind: "internal", text: `Codex reported: ${item.message}` };
  return null;
}

export class CodexProvider {
  constructor(options = {}) {
    this.codex = options.codex ?? new Codex();
    this.model = options.model ?? process.env.ADE_CODEX_MODEL ?? null;
    this.reasoningEffort = options.reasoningEffort ?? process.env.ADE_CODEX_REASONING ?? null;
    this.displayModel = this.model ?? "Codex subscription";
    this.threads = new Map();
  }

  threadOptions(project) {
    return {
      workingDirectory: project.path,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { modelReasoningEffort: this.reasoningEffort } : {})
    };
  }

  /** Returns the one Codex thread that belongs to this task, resuming it after a restart. */
  threadFor(task, project) {
    const cached = this.threads.get(task.id);
    if (cached) return cached;
    const options = this.threadOptions(project);
    const thread = task.threadId
      ? this.codex.resumeThread(task.threadId, options)
      : this.codex.startThread(options);
    this.threads.set(task.id, thread);
    return thread;
  }

  /** One short-lived Coordinator Turn: classify the request and, when delegating, brief its tasks. */
  async coordinate({ request, project, context, tasks = [] }) {
    const thread = this.codex.startThread(this.threadOptions(project));
    try {
      const turn = await thread.run([
        "You are the ADE Coordinator: a short-lived control point for one configured development Project.",
        "Classify the owner request and answer in the owner's language.",
        "Use mode `answer` with an empty tasks array when a bounded, read-only reply is enough: explanations, comparisons, small lookups, and questions about work that is already running.",
        "Use mode `delegate` when the request needs multi-step investigation, durable background progress, verification, or a repository change.",
        "When delegating, create exactly one task unless the owner explicitly asked for several parallel tasks; never exceed three.",
        "Each task needs a short card title, one bounded objective, and observable acceptance criteria. Do not claim work has completed.",
        "For mode `answer`, `message` is the answer itself. For mode `delegate`, `message` is one concise line stating what starts and how the result will be checked.",
        "Do not modify the Project. Use only read-only inspection when more repository context is necessary.",
        `\nProject: ${project.name}\nExisting task cards:\n${taskOverviewText(tasks)}`,
        `\nOwner request:\n${request}`,
        `\nBounded Project context:\n${projectContextText(context)}`
      ].join(" "), { outputSchema: COORDINATOR_SCHEMA });
      return {
        ...parseStructuredResponse(turn.finalResponse),
        coordinatorThreadId: thread.id,
        model: this.displayModel
      };
    } catch (error) {
      throw friendlyCodexError(error);
    }
  }

  /** Runs one turn of a task on the persistent Codex thread that the task owns. */
  async runTask({ task, project, context, message = null, previousQuestion = null, onActivity = async () => {}, onThread = async () => {} }) {
    const thread = this.threadFor(task, project);
    const continuation = message
      ? [
          "\n\nContinue this same task thread.",
          previousQuestion ? `You previously asked: ${previousQuestion}` : "",
          `The owner now says: ${message}`
        ].filter(Boolean).join("\n")
      : "";
    const prompt = [
      "You are one bounded ADE task working against this Project in a read-only Codex sandbox.",
      "Satisfy only this task's objective. You may use internal helper steps or subagents; they are implementation detail and must not be presented as separate tasks.",
      "Report concise owner-visible activities, never hidden reasoning.",
      `\`summary\` must be one short status sentence of at most ${SUMMARY_CHARACTERS} characters for the collapsed card and the Coordinator conversation.`,
      "`detail` carries the full result for the task transcript. If a material implementation choice is missing, return needs_clarification with one precise question and no detail.",
      "Otherwise return completed with a concrete detail and no question. Do not modify files.",
      `\nProject: ${project.name}\nTask: ${task.title}\nObjective: ${task.objective}\nAcceptance criteria:\n- ${task.acceptanceCriteria.join("\n- ")}${continuation}`,
      `\nBounded Project context:\n${projectContextText(context)}`
    ].join(" ");

    let reportedThreadId = null;
    const reportThread = async (threadId) => {
      if (!threadId || threadId === reportedThreadId) return;
      reportedThreadId = threadId;
      await onThread(threadId);
    };

    try {
      await reportThread(thread.id);
      const { events } = await thread.runStreamed(prompt, { outputSchema: TASK_SCHEMA });
      let finalResponse = null;
      for await (const event of events) {
        if (event.type === "thread.started") await reportThread(event.thread_id);
        const activity = activityForEvent(event);
        if (activity) await onActivity(activity);
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
      }
      if (!finalResponse) throw new Error("The Codex task thread ended without a final response.");
      return {
        ...parseStructuredResponse(finalResponse),
        threadId: thread.id ?? task.threadId,
        model: this.displayModel
      };
    } catch (error) {
      throw friendlyCodexError(error);
    }
  }
}

export const schemas = { COORDINATOR_SCHEMA, TASK_SCHEMA };
