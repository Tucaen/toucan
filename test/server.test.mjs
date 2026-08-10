import assert from "node:assert/strict";
import test from "node:test";
import { start } from "../src/server.mjs";

class MemoryEventStore {
  async initialize() {}
  async loadState() { return null; }
  async append() {}
  async flush() {}
}

function createProvider({ askFirst = false } = {}) {
  return {
    async coordinate() {
      return {
        mode: "delegate",
        message: "Starting one task; I will check its acceptance criteria.",
        model: "test-model",
        tasks: [{ title: "Repository review", objective: "Review the repository", acceptanceCriteria: ["Report the result"] }]
      };
    },
    async runTask({ message }) {
      if (askFirst && !message) {
        return {
          status: "needs_clarification",
          summary: "Two options are viable and need one owner decision.",
          activities: ["Compared option A with option B."],
          question: "Should I prioritize option A or option B?",
          detail: null,
          threadId: "thread-task",
          model: "test-model"
        };
      }
      return {
        status: "completed",
        summary: message ? "Continued after the follow-up." : "Reviewed the repository.",
        activities: ["Read the bounded Project context."],
        question: null,
        detail: "The repository holds one thin ADE slice.",
        threadId: "thread-task",
        model: "test-model"
      };
    }
  };
}

async function withServer(run, providerOptions) {
  const started = await start({
    projectPath: process.cwd(),
    projectName: "ADE fixture",
    port: 0,
    provider: createProvider(providerOptions),
    eventStore: new MemoryEventStore()
  });
  try {
    await run(started);
  } finally {
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("the local server exposes the configured Project state and the task canvas shell", async () => {
  await withServer(async ({ url }) => {
    const stateResponse = await fetch(`${url}/api/state`);
    const state = await stateResponse.json();
    assert.equal(stateResponse.status, 200);
    assert.equal(state.project.name, "ADE fixture");
    assert.deepEqual(state.tasks, []);

    const appResponse = await fetch(url);
    const html = await appResponse.text();
    assert.equal(appResponse.status, 200);
    assert.match(html, /<title>ADE · Task canvas<\/title>/);
    assert.match(html, /src="\/app\.js"/);
  });
});

test("the server accepts a request, exposes each task for inspection, and relays follow-up messages", async () => {
  await withServer(async ({ url, runtime }) => {
    const accepted = await postJson(`${url}/api/requests`, { request: "Review this repository." });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.mode, "delegate");
    assert.equal(accepted.body.taskIds.length, 1);
    await runtime.waitForIdle();

    const taskId = accepted.body.taskIds[0];
    const inspection = await fetch(`${url}/api/tasks/${encodeURIComponent(taskId)}`);
    const inspected = await inspection.json();
    assert.equal(inspection.status, 200);
    assert.equal(inspected.task.threadId, "thread-task");
    assert.ok(inspected.events.every((event) => event.taskId === taskId));

    const followUp = await postJson(`${url}/api/tasks/${encodeURIComponent(taskId)}/messages`, {
      message: "Also list the riskiest file.",
      source: "task card"
    });
    assert.equal(followUp.status, 202);
    await runtime.waitForIdle();

    const state = await (await fetch(`${url}/api/state`)).json();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    assert.equal(state.tasks.length, 1);
    assert.ok(task.transcript.some((entry) => entry.role === "owner" && entry.text === "Also list the riskiest file."));

    const missing = await fetch(`${url}/api/tasks/task-missing`);
    assert.equal(missing.status, 404);
  });
});

test("the server answers one clarification once, from either surface", async () => {
  await withServer(async ({ url, runtime }) => {
    const accepted = await postJson(`${url}/api/requests`, { request: "Compare the two options." });
    await runtime.waitForIdle();
    const waiting = await (await fetch(`${url}/api/state`)).json();
    const question = waiting.questions.find((candidate) => candidate.status === "open");
    assert.equal(question.taskId, accepted.body.taskIds[0]);

    const answered = await postJson(`${url}/api/questions/${encodeURIComponent(question.id)}/answer`, {
      answer: "Prioritize option B.",
      source: "coordinator"
    });
    assert.equal(answered.status, 202);
    await runtime.waitForIdle();

    const resolved = await (await fetch(`${url}/api/state`)).json();
    const task = resolved.tasks.find((candidate) => candidate.id === question.taskId);
    assert.equal(resolved.questions.find((candidate) => candidate.id === question.id).answeredFrom, "Coordinator");
    assert.equal(resolved.questions.filter((candidate) => candidate.status === "open").length, 0);
    assert.equal(task.status, "completed");
    assert.equal(task.threadId, "thread-task");

    const repeated = await postJson(`${url}/api/questions/${encodeURIComponent(question.id)}/answer`, {
      answer: "A conflicting second answer.",
      source: "task card"
    });
    assert.equal(repeated.status, 409);

    const rejected = await postJson(`${url}/api/tasks/${encodeURIComponent(question.taskId)}/messages`, {
      message: "Who is asking?",
      source: "anonymous"
    });
    assert.equal(rejected.status, 400);
  }, { askFirst: true });
});
