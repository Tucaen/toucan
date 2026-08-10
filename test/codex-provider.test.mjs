import assert from "node:assert/strict";
import test from "node:test";
import { CodexProvider } from "../src/codex-provider.mjs";

function context() {
  return { root: "D:/fixture", files: ["README.md"], truncated: false, snippets: [] };
}

function asyncEvents(events) {
  return (async function* generate() {
    for (const event of events) yield event;
  })();
}

function taskResult(overrides = {}) {
  return JSON.stringify({
    status: "completed",
    summary: "Inspected the fixture.",
    activities: ["Mapped the fixture."],
    question: null,
    detail: "The fixture contains one README file.",
    ...overrides
  });
}

test("the Coordinator turn classifies the request in a read-only subscription-backed thread", async () => {
  const calls = [];
  const thread = {
    id: "thread-coordinator",
    async run(prompt, options) {
      calls.push({ prompt, options });
      return {
        finalResponse: JSON.stringify({
          mode: "delegate",
          message: "Starting one task; I will check its acceptance criteria.",
          tasks: [{ title: "One", objective: "Inspect one", acceptanceCriteria: ["One complete"] }]
        })
      };
    }
  };
  const codex = {
    startThread(options) {
      calls.push({ threadOptions: options });
      return thread;
    }
  };
  const provider = new CodexProvider({ codex });

  const result = await provider.coordinate({
    request: "Inspect the fixture.",
    project: { name: "fixture", path: "D:/fixture" },
    context: context(),
    tasks: [{ id: "task-1", title: "Existing task", status: "working", summary: "Still working." }]
  });

  assert.equal(result.mode, "delegate");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.model, "Codex subscription");
  assert.equal(result.coordinatorThreadId, "thread-coordinator");
  assert.deepEqual(calls[0].threadOptions, {
    workingDirectory: "D:/fixture",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled"
  });
  assert.equal(calls[1].options.outputSchema.properties.mode.enum.join(","), "answer,delegate");
  assert.match(calls[1].prompt, /Existing task/);
});

test("a task owns one Codex thread that is resumed for follow-up turns", async () => {
  const starts = [];
  const resumes = [];
  const prompts = [];
  const createThread = (id, detail) => ({
    id,
    async runStreamed(prompt) {
      prompts.push(prompt);
      return {
        events: asyncEvents([
          { type: "thread.started", thread_id: id },
          { type: "item.completed", item: { id: "answer-1", type: "agent_message", text: taskResult({ detail }) } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
        ])
      };
    }
  });
  const codex = {
    startThread(options) {
      starts.push(options);
      return createThread("thread-task", "First detail");
    },
    resumeThread(id, options) {
      resumes.push({ id, options });
      return createThread("thread-task", "Follow-up detail");
    }
  };
  const provider = new CodexProvider({ codex });
  const task = { id: "task-1", title: "Inspect", objective: "Inspect", acceptanceCriteria: ["Return a detail"], threadId: null };
  const project = { name: "fixture", path: "D:/fixture" };

  const first = await provider.runTask({ task, project, context: context() });
  assert.equal(first.threadId, "thread-task");
  assert.equal(first.detail, "First detail");

  task.threadId = first.threadId;
  const cached = await provider.runTask({ task, project, context: context(), message: "Keep going." });
  assert.equal(cached.detail, "First detail");
  assert.equal(starts.length, 1, "the cached thread is reused instead of starting a second thread");
  assert.equal(resumes.length, 0);
  assert.match(prompts.at(-1), /Keep going\./);

  const afterRestart = new CodexProvider({ codex });
  const resumed = await afterRestart.runTask({ task, project, context: context(), message: "Continue after a restart." });
  assert.equal(resumed.detail, "Follow-up detail");
  assert.equal(starts.length, 1);
  assert.deepEqual(resumes.map((resume) => resume.id), ["thread-task"]);
  assert.equal(resumes[0].options.sandboxMode, "read-only");
});

test("internal steps become labelled owner-visible activity and hidden reasoning is dropped", async () => {
  const activities = [];
  const threadIds = [];
  const codex = {
    startThread() {
      return {
        id: "thread-task",
        async runStreamed() {
          return {
            events: asyncEvents([
              { type: "thread.started", thread_id: "thread-task" },
              { type: "item.completed", item: { id: "reasoning-1", type: "reasoning", text: "Hidden chain of thought." } },
              { type: "item.started", item: { id: "command-1", type: "command_execution", command: "rg --files", aggregated_output: "", status: "in_progress" } },
              { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "rg --files", aggregated_output: "README.md", status: "completed", exit_code: 0 } },
              { type: "item.started", item: { id: "command-2", type: "command_execution", command: "codex exec \"summarize the README\"", aggregated_output: "", status: "in_progress" } },
              { type: "item.completed", item: { id: "command-2", type: "command_execution", command: "codex exec \"summarize the README\"", aggregated_output: "done", status: "completed", exit_code: 0 } },
              { type: "item.completed", item: { id: "todo-1", type: "todo_list", items: [{ text: "Read", completed: true }, { text: "Report", completed: false }] } },
              { type: "item.completed", item: { id: "answer-1", type: "agent_message", text: taskResult() } },
              { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
            ])
          };
        }
      };
    }
  };
  const provider = new CodexProvider({ codex });

  await provider.runTask({
    task: { id: "task-1", title: "Inspect", objective: "Inspect", acceptanceCriteria: ["Return a detail"], threadId: null },
    project: { name: "fixture", path: "D:/fixture" },
    context: context(),
    onActivity: async (activity) => activities.push(activity),
    onThread: async (threadId) => threadIds.push(threadId)
  });

  assert.deepEqual(threadIds, ["thread-task"], "the owning thread id is reported while the turn is still running");
  assert.ok(!activities.some((activity) => /chain of thought/i.test(activity.text)));
  assert.deepEqual(activities.map((activity) => activity.kind), ["internal", "internal", "subagent", "subagent", "internal"]);
  assert.match(activities[2].text, /internal agent step/i);
  assert.match(activities.at(-1).text, /1\/2/);
});

test("a turn that fails or never answers is reported as a task failure", async () => {
  const provider = new CodexProvider({
    codex: {
      startThread() {
        return {
          id: "thread-task",
          async runStreamed() {
            return { events: asyncEvents([{ type: "turn.failed", error: { message: "sandbox denied the command" } }]) };
          }
        };
      }
    }
  });

  await assert.rejects(
    provider.runTask({
      task: { id: "task-1", title: "Inspect", objective: "Inspect", acceptanceCriteria: ["Return a detail"], threadId: null },
      project: { name: "fixture", path: "D:/fixture" },
      context: context()
    }),
    /sandbox denied the command/
  );
});

test("authentication failures explain the ChatGPT subscription login step", async () => {
  const provider = new CodexProvider({
    codex: {
      startThread() {
        return { id: null, async run() { throw new Error("Not logged in"); } };
      }
    }
  });
  await assert.rejects(
    provider.coordinate({ request: "Inspect", project: { name: "fixture", path: "D:/fixture" }, context: context(), tasks: [] }),
    /npm run login/
  );
});
