import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/event-store.mjs";
import { AdeRuntime } from "../src/runtime.mjs";

class MemoryEventStore {
  state = null;
  events = [];
  async initialize() {}
  async loadState() { return this.state; }
  async append(event, state) {
    this.events.push(structuredClone(event));
    this.state = structuredClone(state);
  }
  async flush() {}
}

class DemonstrationProvider {
  active = 0;
  maximumActive = 0;
  calls = [];

  async coordinate() {
    return {
      message: "I split the request into two bounded, independent investigations.",
      model: "test-model",
      delegations: [
        { title: "Repository map", objective: "Map the repository", acceptanceCriteria: ["Return a map"] },
        { title: "Needs choice", objective: "Compare two options and ask which to prioritize", acceptanceCriteria: ["Record the choice"] }
      ]
    };
  }

  async runSession({ session, answer }) {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.calls.push({ sessionId: session.id, answer });
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.active -= 1;
    if (session.title === "Needs choice" && !answer) {
      return {
        model: "test-model",
        providerResponseId: "response-question",
        status: "needs_clarification",
        summary: "Two options are viable.",
        activities: ["Compared option A with option B."],
        question: "Should I prioritize option A or option B?",
        outcome: null
      };
    }
    return {
      model: "test-model",
      providerResponseId: `response-${session.id}`,
      status: "completed",
      summary: "The bounded investigation is complete.",
      activities: ["Read the supplied Project context.", "Produced the requested result."],
      question: null,
      outcome: answer ? `Continued with the owner answer: ${answer}` : "Repository map ready."
    };
  }
}

function createRuntime() {
  const provider = new DemonstrationProvider();
  const eventStore = new MemoryEventStore();
  const runtime = new AdeRuntime({
    projectPath: process.cwd(),
    projectName: "fixture",
    provider,
    eventStore,
    contextBuilder: async () => ({ root: process.cwd(), files: ["README.md"], truncated: false, snippets: [] })
  });
  return { runtime, provider, eventStore };
}

test("one request starts two real provider sessions concurrently and persists their states", async () => {
  const { runtime, provider, eventStore } = createRuntime();
  await runtime.initialize();

  const accepted = await runtime.startRequest("Map the project and compare options.");
  assert.equal(accepted.sessionIds.length, 2);
  await runtime.waitForIdle();

  const state = runtime.getState();
  assert.equal(provider.maximumActive, 2);
  assert.deepEqual(state.sessions.map((session) => session.status).sort(), ["completed", "waiting"]);
  assert.equal(state.questions.filter((question) => question.status === "open").length, 1);
  assert.ok(state.messages.some((message) => message.role === "assistant" && message.text.includes("two bounded")));
  assert.ok(eventStore.events.some((event) => event.type === "request.received"));
  assert.equal(eventStore.events.filter((event) => event.type === "session.started").length, 2);
  assert.ok(eventStore.events.some((event) => event.type === "question.asked"));
});

test("one clarification answer clears the shared prompt and resumes its originating session once", async () => {
  const { runtime, provider, eventStore } = createRuntime();
  await runtime.initialize();
  await runtime.startRequest("Exercise clarification routing.");
  await runtime.waitForIdle();
  const question = runtime.getState().questions.find((candidate) => candidate.status === "open");

  const accepted = await runtime.answerQuestion(question.id, "Prioritize option B.", "session");
  assert.equal(accepted.sessionId, question.sessionId);
  await runtime.waitForIdle();

  const state = runtime.getState();
  const answeredQuestion = state.questions.find((candidate) => candidate.id === question.id);
  const resumedSession = state.sessions.find((candidate) => candidate.id === question.sessionId);
  assert.equal(answeredQuestion.status, "answered");
  assert.equal(answeredQuestion.answeredFrom, "session card");
  assert.equal(resumedSession.status, "completed");
  assert.match(resumedSession.outcome, /Prioritize option B/);
  assert.equal(provider.calls.filter((call) => call.sessionId === question.sessionId).length, 2);
  assert.ok(eventStore.events.some((event) => event.type === "question.answered" && event.source === "session card"));
  assert.ok(eventStore.events.some((event) => event.type === "session.resumed" && event.sessionId === question.sessionId));

  await assert.rejects(
    runtime.answerQuestion(question.id, "A conflicting second answer", "coordinator"),
    (error) => error.statusCode === 409 && /already answered/.test(error.message)
  );
});

test("a provider failure becomes visible session state and a durable event", async () => {
  const { runtime, provider, eventStore } = createRuntime();
  provider.runSession = async ({ session }) => {
    if (session.title === "Repository map") throw new Error("fixture provider unavailable");
    return {
      model: "test-model",
      status: "completed",
      summary: "Done",
      activities: ["Finished the alternate task."],
      question: null,
      outcome: "Done"
    };
  };
  await runtime.initialize();
  await runtime.startRequest("Show failure state.");
  await runtime.waitForIdle();

  const failed = runtime.getState().sessions.find((session) => session.status === "failed");
  assert.equal(failed.activity, "fixture provider unavailable");
  assert.ok(eventStore.events.some((event) => event.type === "session.failed" && event.sessionId === failed.id));
});

test("the filesystem store appends JSONL events and replaces the restorable snapshot", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ade-event-store-"));
  try {
    const store = new EventStore(temporaryRoot);
    await store.initialize();
    const first = { id: "event-1", runId: "run-1" };
    const second = { id: "event-2", runId: "run-1" };
    await store.append(first, { version: 1, value: "first" });
    await store.append(second, { version: 1, value: "second" });
    await store.flush();

    const restored = await store.loadState();
    const lines = (await readFile(path.join(temporaryRoot, "runs", "run-1.jsonl"), "utf8")).trim().split("\n");
    assert.equal(restored.value, "second");
    assert.deepEqual(lines.map((line) => JSON.parse(line).id), ["event-1", "event-2"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
