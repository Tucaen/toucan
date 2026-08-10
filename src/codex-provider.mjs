import { Codex } from "@openai/codex-sdk";

const COORDINATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    delegations: {
      type: "array",
      minItems: 2,
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
  required: ["message", "delegations"]
};

const SESSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "needs_clarification"] },
    summary: { type: "string" },
    activities: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    question: { type: ["string", "null"] },
    outcome: { type: ["string", "null"] }
  },
  required: ["status", "summary", "activities", "question", "outcome"]
};

function projectContextText(context) {
  const snippets = context.snippets
    .map((snippet) => `--- ${snippet.path} ---\n${snippet.contents}`)
    .join("\n\n");
  return `Project root: ${context.root}\nFiles (${context.files.length}${context.truncated ? "+" : ""}):\n${context.files.join("\n")}\n\nSelected file excerpts:\n${snippets}`;
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

function activityForEvent(event) {
  if (event.type === "item.started" && event.item.type === "command_execution") {
    return "Inspecting the Project through the read-only Codex sandbox.";
  }
  if (event.type !== "item.completed") return null;
  if (event.item.type === "command_execution") {
    return event.item.status === "completed"
      ? "Completed a read-only Project inspection step."
      : "A read-only Project inspection step failed.";
  }
  if (event.item.type === "todo_list") {
    const completed = event.item.items.filter((item) => item.completed).length;
    return `Updated the work plan: ${completed}/${event.item.items.length} steps complete.`;
  }
  if (event.item.type === "error") return `Codex reported: ${event.item.message}`;
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

  async coordinate({ request, project, context }) {
    const thread = this.codex.startThread(this.threadOptions(project));
    try {
      const turn = await thread.run([
        "You are the ADE Coordinator: a short-lived control point for one configured development Project.",
        "Respond visibly to the owner, then decompose the request into two or three independent, bounded Agent Sessions that can run concurrently.",
        "Each delegation must have a distinct objective and observable acceptance criteria. Do not claim work has completed.",
        "If the owner requests a clarification exercise, encode that need in exactly one worker objective so that worker asks the owner before concluding.",
        "Do not modify the Project. Use only read-only inspection when additional repository context is necessary.",
        `\nProject: ${project.name}\nOwner request:\n${request}\n\nBounded Project context:\n${projectContextText(context)}`
      ].join(" "), { outputSchema: COORDINATOR_SCHEMA });
      return {
        ...parseStructuredResponse(turn.finalResponse),
        providerThreadId: thread.id,
        model: this.displayModel
      };
    } catch (error) {
      throw friendlyCodexError(error);
    }
  }

  async runSession({ session, project, context, answer = null, previousQuestion = null, onActivity = async () => {} }) {
    const options = this.threadOptions(project);
    let thread;
    if (answer && session.providerThreadId) {
      thread = this.threads.get(session.id) ?? this.codex.resumeThread(session.providerThreadId, options);
    } else {
      thread = this.codex.startThread(options);
    }
    this.threads.set(session.id, thread);
    const continuation = answer
      ? `\n\nContinue the same Agent Session. You previously asked: ${previousQuestion}\nThe owner answered: ${answer}`
      : "";
    const prompt = [
      "You are one bounded ADE Agent Session working against this Project in a read-only Codex sandbox.",
      "Inspect the repository as needed and satisfy only your Delegation Brief. Report concise owner-visible activities, never hidden reasoning.",
      "If a material implementation choice is missing, return needs_clarification with one precise question and no outcome.",
      "Otherwise return completed with a concrete outcome and no question. Do not modify files.",
      `\nProject: ${project.name}\nObjective: ${session.objective}\nAcceptance criteria:\n- ${session.acceptanceCriteria.join("\n- ")}${continuation}`,
      `\nBounded Project context:\n${projectContextText(context)}`
    ].join(" ");

    try {
      const { events } = await thread.runStreamed(prompt, { outputSchema: SESSION_SCHEMA });
      let finalResponse = null;
      for await (const event of events) {
        const activity = activityForEvent(event);
        if (activity) await onActivity(activity);
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
      }
      if (!finalResponse) throw new Error("Codex Agent Session ended without a final response.");
      return {
        ...parseStructuredResponse(finalResponse),
        providerThreadId: thread.id,
        model: this.displayModel
      };
    } catch (error) {
      throw friendlyCodexError(error);
    }
  }
}

export const schemas = { COORDINATOR_SCHEMA, SESSION_SCHEMA };
