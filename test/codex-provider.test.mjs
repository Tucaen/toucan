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

test("the Codex provider starts subscription-backed threads in a read-only sandbox", async () => {
  const calls = [];
  const thread = {
    id: "thread-coordinator",
    async run(prompt, options) {
      calls.push({ prompt, options });
      return {
        finalResponse: JSON.stringify({
          message: "I will start two bounded sessions.",
          delegations: [
            { title: "One", objective: "Inspect one", acceptanceCriteria: ["One complete"] },
            { title: "Two", objective: "Inspect two", acceptanceCriteria: ["Two complete"] }
          ]
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
    context: context()
  });

  assert.equal(result.providerThreadId, "thread-coordinator");
  assert.equal(result.model, "Codex subscription");
  assert.equal(result.delegations.length, 2);
  assert.deepEqual(calls[0].threadOptions, {
    workingDirectory: "D:/fixture",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled"
  });
  assert.equal(calls[1].options.outputSchema.type, "object");
});

test("a Codex Agent Session streams owner-visible activity and resumes its saved thread", async () => {
  const activities = [];
  const starts = [];
  const resumes = [];
  const createThread = (id, outcome) => ({
    id,
    async runStreamed() {
      return {
        events: asyncEvents([
          { type: "thread.started", thread_id: id },
          { type: "item.started", item: { id: "command-1", type: "command_execution", command: "rg --files", aggregated_output: "", status: "in_progress" } },
          { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "rg --files", aggregated_output: "README.md", status: "completed", exit_code: 0 } },
          { type: "item.completed", item: { id: "answer-1", type: "agent_message", text: JSON.stringify({
            status: "completed",
            summary: "Inspected the fixture.",
            activities: ["Mapped the fixture."],
            question: null,
            outcome
          }) } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
        ])
      };
    }
  });
  const firstThread = createThread("thread-session", "First outcome");
  const resumedThread = createThread("thread-session", "Resumed outcome");
  const codex = {
    startThread(options) {
      starts.push(options);
      return firstThread;
    },
    resumeThread(id, options) {
      resumes.push({ id, options });
      return resumedThread;
    }
  };
  const provider = new CodexProvider({ codex });
  const session = {
    id: "session-1",
    objective: "Inspect",
    acceptanceCriteria: ["Return an outcome"],
    providerThreadId: null
  };
  const project = { name: "fixture", path: "D:/fixture" };

  const first = await provider.runSession({ session, project, context: context(), onActivity: async (activity) => activities.push(activity) });
  assert.equal(first.providerThreadId, "thread-session");
  assert.equal(first.outcome, "First outcome");
  assert.deepEqual(activities, [
    "Inspecting the Project through the read-only Codex sandbox.",
    "Completed a read-only Project inspection step."
  ]);

  session.providerThreadId = first.providerThreadId;
  provider.threads.clear();
  const resumed = await provider.runSession({
    session,
    project,
    context: context(),
    answer: "Choose B",
    previousQuestion: "A or B?"
  });
  assert.equal(resumed.outcome, "Resumed outcome");
  assert.equal(starts.length, 1);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].id, "thread-session");
  assert.equal(resumes[0].options.sandboxMode, "read-only");
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
    provider.coordinate({ request: "Inspect", project: { name: "fixture", path: "D:/fixture" }, context: context() }),
    /npm run login/
  );
});
